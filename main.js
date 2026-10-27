const { Plugin, ItemView, PluginSettingTab, Setting, Modal, Notice, TFolder, setIcon } = require('obsidian');
const path = require('node:path');
const VIEW = 'personal-knowledge-chat';
const DEFAULTS = { provider: 'local', localUrl: 'http://127.0.0.1:11434', codexPath: '', templateFolder: 'Шаблоны', models: { local: '', chatgpt: '' } };
const TEMPLATE_PROMPT = 'Создай шаблон заметки Obsidian по следующему описанию. Верни только готовый Markdown, без пояснений и ограждающих блоков кода. Начни с заголовка первого уровня. Используй уместные поля и заполнители в двойных фигурных скобках. Описание: ';

function templateContent(text) {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i);
  return (fenced ? fenced[1] : trimmed).trim();
}

function templateTitle(content) {
  const heading = content.match(/^#\s+(.+)$/m)?.[1] || 'Новый шаблон';
  return heading.replace(/[<>:"/\\|?*\x00-\x1f]/g, '').replace(/[. ]+$/g, '').slice(0, 80).trim() || 'Новый шаблон';
}

function templatePath(folder, name) {
  if (typeof folder !== 'string' || typeof name !== 'string') throw new Error('Укажите папку и название шаблона.');
  const parts = folder.trim().split(/[\\/]/);
  const base = name.trim().replace(/\.md$/i, '');
  const valid = part => part && part !== '.' && part !== '..' && !/[<>:"/\\|?*\x00-\x1f]/.test(part) && !/[. ]$/.test(part);
  if (!parts.every(valid) || parts[0].toLowerCase() === '.obsidian' || !valid(base)) throw new Error('Недопустимая папка или название шаблона.');
  return { folders: parts, filePath: [...parts, `${base}.md`].join('/') };
}

class ConsentModal extends Modal {
  constructor(app, resolve) { super(app); this.resolve = resolve; this.accepted = false; }
  onOpen() {
    this.titleEl.setText('Отправить диалог в ChatGPT?');
    this.contentEl.createEl('p', { text: 'Текст этого диалога будет передан OpenAI. Используются лимиты вашей подписки. Заметки хранилища не отправляются.' });
    new Setting(this.contentEl).addButton(b => b.setButtonText('Отмена').onClick(() => this.close()))
      .addButton(b => b.setButtonText('Продолжить').setCta().onClick(() => { this.accepted = true; this.close(); }));
  }
  onClose() { this.resolve(this.accepted); }
}

class TemplateModal extends Modal {
  constructor(app, plugin, content) { super(app); this.plugin = plugin; this.content = templateContent(content); }
  onOpen() {
    this.titleEl.setText('Сохранить шаблон');
    this.contentEl.createEl('p', { text: `Папка: ${this.plugin.state.settings.templateFolder}` });
    const name = this.contentEl.createEl('input', { cls: 'pk-template-name', attr: { type: 'text', 'aria-label': 'Название шаблона' } });
    name.value = templateTitle(this.content);
    const body = this.contentEl.createEl('textarea', { cls: 'pk-template-preview', attr: { 'aria-label': 'Текст шаблона' } });
    body.value = this.content;
    new Setting(this.contentEl).addButton(b => b.setButtonText('Отмена').onClick(() => this.close()))
      .addButton(b => b.setButtonText('Сохранить').setCta().onClick(async () => {
        b.setDisabled(true);
        try {
          const file = await this.plugin.saveTemplate(name.value, body.value);
          new Notice(`Шаблон сохранён: ${file.path}`);
          this.close();
        } catch (error) { new Notice(error.message); b.setDisabled(false); }
      }));
  }
}

class ChatView extends ItemView {
  constructor(leaf, plugin) { super(leaf); this.plugin = plugin; this.models = []; this.revision = 0; }
  getViewType() { return VIEW; }
  getDisplayText() { return 'Личный агент'; }
  getIcon() { return 'messages-square'; }
  async onOpen() { this.render(); await this.loadModels(); }
  async onClose() { this.revision++; this.plugin.controller?.abort(); }
  button(parent, icon, title, action) {
    const el = parent.createEl('button', { attr: { 'aria-label': title, title, type: 'button' } });
    setIcon(el, icon);
    el.addEventListener('click', () => Promise.resolve(action()).catch(e => this.error(e)));
    return el;
  }
  error(e) { this.status?.setText(e.message || String(e)); }
  render() {
    this.revision++;
    const p = this.plugin, s = p.state;
    this.contentEl.empty();
    this.contentEl.addClass('pk-chat');
    const header = this.contentEl.createDiv({ cls: 'pk-header' });
    header.createEl('strong', { text: 'Личный агент' });
    this.button(header, 'settings', 'Настройки подключения', () => new ConnectionModal(this.app, p).open());
    const row = this.contentEl.createDiv({ cls: 'pk-toolbar' });
    const history = row.createEl('select', { attr: { 'aria-label': 'Диалог' } });
    for (const c of s.chats) history.createEl('option', { value: c.id, text: c.title });
    history.value = s.active;
    history.disabled = p.busy;
    history.onchange = async () => { s.active = history.value; await p.persist(); this.render(); };
    const fresh = this.button(row, 'plus', 'Новый диалог', async () => { p.newChat(); await p.persist(); this.render(); });
    fresh.disabled = p.busy;
    const skill = row.createEl('select', { attr: { 'aria-label': 'Режим' } });
    skill.createEl('option', { value: 'chat', text: 'Обычный чат' });
    skill.createEl('option', { value: 'template', text: 'Создать шаблон' });
    skill.value = p.chat().mode || 'chat';
    skill.disabled = p.busy;
    skill.onchange = async () => { p.chat().mode = skill.value; await p.persist(); this.render(); };
    const providerRow = this.contentEl.createDiv({ cls: 'pk-toolbar' });
    const provider = providerRow.createEl('select', { attr: { 'aria-label': 'Подключение' } });
    provider.createEl('option', { value: 'local', text: 'Локально · Ollama' });
    provider.createEl('option', { value: 'chatgpt', text: 'ChatGPT · Codex' });
    provider.value = s.settings.provider;
    provider.disabled = p.busy;
    provider.onchange = async () => {
      s.settings.provider = provider.value;
      this.models = [];
      await p.persist(); this.render(); await this.loadModels();
    };
    this.modelSelect = providerRow.createEl('select', { attr: { 'aria-label': 'Модель' } });
    const saved = s.settings.models[s.settings.provider];
    if (!this.models.length) this.modelSelect.createEl('option', { value: saved, text: saved || 'Выберите модель' });
    else for (const m of this.models) this.modelSelect.createEl('option', { value: m.id, text: m.label });
    this.modelSelect.value = saved;
    this.modelSelect.disabled = p.busy;
    this.modelSelect.onchange = async () => { s.settings.models[s.settings.provider] = this.modelSelect.value; await p.persist(); };
    const refresh = this.button(providerRow, 'refresh-cw', 'Обновить список моделей', () => this.loadModels());
    refresh.disabled = p.busy;
    this.feed = this.contentEl.createDiv({ cls: 'pk-feed', attr: { role: 'log', 'aria-label': 'Переписка' } });
    for (const message of p.chat().messages) this.message(message);
    this.status = this.contentEl.createDiv({ cls: 'pk-status', attr: { role: 'status' } });
    this.status.setText(p.busy ? 'Агент отвечает…' : '');
    const composer = this.contentEl.createDiv({ cls: 'pk-composer' });
    this.input = composer.createEl('textarea', { attr: { 'aria-label': 'Сообщение', placeholder: skill.value === 'template' ? 'Опишите нужный шаблон…' : 'Сообщение…', rows: '3' } });
    this.input.value = p.chat().draft || '';
    this.input.disabled = p.busy;
    this.input.oninput = () => { p.chat().draft = this.input.value; };
    this.input.onblur = () => p.persist().catch(e => this.error(e));
    this.input.onkeydown = event => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); this.send().catch(e => this.error(e)); }
    };
    const actions = composer.createDiv({ cls: 'pk-actions' });
    this.button(actions, p.busy ? 'square' : 'send', p.busy ? 'Остановить' : 'Отправить', () => p.busy ? p.controller?.abort() : this.send());
    this.feed.scrollTop = this.feed.scrollHeight;
  }
  message(message) {
    const box = this.feed.createDiv({ cls: `pk-message pk-${message.role}` });
    box.createEl('small', { text: message.role === 'user' ? 'Вы' : (message.model || 'Агент') });
    const body = box.createDiv({ cls: 'pk-text', text: message.content });
    if (message.error) box.createEl('small', { cls: 'pk-error', text: message.error });
    if (message.skill === 'template' && !message.error) {
      const save = this.button(box, 'file-plus-2', 'Сохранить шаблон', () => new TemplateModal(this.app, this.plugin, message.content).open());
      save.disabled = Boolean(message.pending);
    }
    return body;
  }
  async loadModels() {
    const revision = this.revision;
    const provider = this.plugin.state.settings.provider;
    this.status.setText('Загрузка моделей…');
    try {
      const models = await this.plugin.backend(provider).models();
      if (revision !== this.revision) return;
      this.models = models;
      const settings = this.plugin.state.settings;
      if (!models.some(m => m.id === settings.models[provider])) settings.models[provider] = models[0]?.id || '';
      await this.plugin.persist();
      this.render();
      if (!models.length) this.status.setText('Модели не найдены. Проверьте подключение в настройках.');
    } catch (e) { if (revision === this.revision) this.error(e); }
  }
  async send() {
    const p = this.plugin;
    if (p.busy) return;
    const text = this.input.value.trim();
    if (!text) return;
    const { provider, models } = p.state.settings, model = models[provider];
    if (!model) { await this.loadModels(); this.status.setText('Выберите модель и отправьте сообщение.'); return; }
    const chat = p.chat();
    const mode = chat.mode || 'chat';
    p.busy = true;
    try {
      if (provider === 'chatgpt' && !chat.cloudConsent) {
        const accepted = await new Promise(resolve => new ConsentModal(this.app, resolve).open());
        if (!accepted) return;
        chat.cloudConsent = true;
      }
      chat.messages.push({ role: 'user', content: text });
      if (chat.title === 'Новый диалог') chat.title = text.slice(0, 60);
      chat.draft = '';
      await p.persist();
      p.controller = new AbortController();
      this.render();
      const answer = { role: 'assistant', content: '', model, provider, pending: true };
      if (mode === 'template') answer.skill = 'template';
      const context = chat.messages.filter(m => !m.error && !m.pending).map(({ role, content }) => ({ role, content }));
      if (mode === 'template') context[context.length - 1].content = TEMPLATE_PROMPT + text;
      chat.messages.push(answer);
      await p.persist();
      const output = this.message(answer);
      try {
        answer.content = await p.backend(provider).chat(context, model, p.controller.signal, content => {
          answer.content = content;
          output.setText(content);
          this.feed.scrollTop = this.feed.scrollHeight;
        });
      } catch (e) {
        answer.error = p.controller.signal.aborted ? 'Ответ остановлен.' : e.message;
        chat.draft = text;
      } finally { delete answer.pending; }
      await p.persist();
      if (mode === 'template' && !answer.error) new TemplateModal(this.app, p, answer.content).open();
    } catch (e) { new Notice(`Не удалось сохранить или отправить сообщение: ${e.message}`); }
    finally { p.busy = false; p.controller = null; this.render(); }
  }
}

function connectionSettings(container, plugin) {
  const s = plugin.state.settings;
  new Setting(container).setName('Адрес Ollama').addText(t => t.setValue(s.localUrl).onChange(async value => {
    s.localUrl = value; await plugin.persist();
  }));
  new Setting(container).setName('Путь к Codex').setDesc('Оставьте пустым для автоматического поиска.').addText(t => t.setValue(s.codexPath).onChange(async value => {
    if (plugin.busy) return;
    s.codexPath = value; plugin.codex?.close(); plugin.codex = null; await plugin.persist();
  }));
  new Setting(container).setName('Папка шаблонов').setDesc('Путь внутри текущего хранилища.').addText(t => t.setValue(s.templateFolder).onChange(async value => {
    s.templateFolder = value; await plugin.persist();
  }));
  new Setting(container).setName('Аккаунт ChatGPT').setDesc('Отдельный вход для этого плагина.').addButton(b => b.setButtonText('Войти').onClick(async () => {
    b.setDisabled(true);
    try {
      const login = await plugin.backend('chatgpt').login();
      if (login.authUrl) {
        const url = new URL(login.authUrl);
        if (url.protocol !== 'https:' || !['auth.openai.com', 'auth0.openai.com', 'chatgpt.com'].includes(url.hostname)) throw new Error('Неожиданный адрес входа.');
        await require('electron').shell.openExternal(login.authUrl);
        new Notice('Завершите вход в браузере, затем обновите список моделей.');
      } else new Notice('Вход выполнен. Обновите список моделей.');
    } catch (e) { new Notice(e.message); }
    finally { b.setDisabled(false); }
  }));
  new Setting(container).setName('Другое хранилище').setDesc('Установить плагин в выбранное хранилище. Чаты и настройки не копируются.').addButton(b => b.setButtonText('Выбрать папку').onClick(async () => {
    try {
      const electron = require('electron');
      const dialog = electron.remote?.dialog || electron.dialog;
      if (!dialog) throw new Error('Не удалось открыть выбор папки в Obsidian.');
      const selection = await dialog.showOpenDialog({ properties: ['openDirectory'] });
      if (selection.canceled || !selection.filePaths?.length) return;
      const source = path.join(plugin.app.vault.adapter.getBasePath(), plugin.manifest.dir);
      plugin.installer.installToVault(source, selection.filePaths[0]);
      new Notice('Плагин установлен. Перезапустите Obsidian с выбранным хранилищем.');
    } catch (e) { new Notice(`Не удалось установить плагин: ${e.message}`); }
  }));
}

class ConnectionModal extends Modal {
  constructor(app, plugin) { super(app); this.plugin = plugin; }
  onOpen() { this.titleEl.setText('Настройки агента'); connectionSettings(this.contentEl, this.plugin); }
}
class SettingsTab extends PluginSettingTab {
  display() { this.containerEl.empty(); connectionSettings(this.containerEl, this.plugin); }
}

module.exports = class KnowledgeChat extends Plugin {
  async onload() {
    this.providers = require(path.join(this.app.vault.adapter.getBasePath(), this.manifest.dir, 'providers.js'));
    this.installer = require(path.join(this.app.vault.adapter.getBasePath(), this.manifest.dir, 'installer.js'));
    const loaded = await this.loadData();
    this.state = loaded || { chats: [], active: '', settings: DEFAULTS };
    this.state.settings = { ...DEFAULTS, ...this.state.settings, models: { ...DEFAULTS.models, ...this.state.settings?.models } };
    for (const chat of this.state.chats) for (const m of chat.messages) {
      if (m.pending) { delete m.pending; m.error = 'Ответ прерван при закрытии приложения.'; }
    }
    if (!this.state.chats.length) this.newChat();
    if (!this.state.chats.some(c => c.id === this.state.active)) this.state.active = this.state.chats[0].id;
    this.saveQueue = Promise.resolve();
    this.registerView(VIEW, leaf => new ChatView(leaf, this));
    this.addRibbonIcon('messages-square', 'Личный агент', () => this.openChat());
    this.addCommand({ id: 'open-chat', name: 'Открыть чат', callback: () => this.openChat() });
    this.addSettingTab(new SettingsTab(this.app, this));
    this.app.workspace.onLayoutReady(() => {
      if (this.state.openOnFirstLoad === false) return;
      this.openChat().then(() => {
        this.state.openOnFirstLoad = false;
        return this.persist();
      }).catch(error => new Notice(error.message));
    });
    this.registerInterval(setInterval(() => { if (this.busy) this.persist().catch(() => {}); }, 3000));
  }
  newChat() {
    const id = require('node:crypto').randomUUID();
    this.state.chats.unshift({ id, title: 'Новый диалог', messages: [], draft: '', cloudConsent: false });
    this.state.active = id;
  }
  chat() { return this.state.chats.find(c => c.id === this.state.active); }
  persist() {
    const snapshot = JSON.parse(JSON.stringify(this.state));
    this.saveQueue = (this.saveQueue || Promise.resolve()).catch(() => {}).then(() => this.saveData(snapshot));
    return this.saveQueue;
  }
  backend(provider) {
    if (provider === 'local') return new this.providers.Ollama(this.state.settings.localUrl);
    if (!this.codex) this.codex = new this.providers.Codex(this.state.settings.codexPath);
    return this.codex;
  }
  async saveTemplate(name, content) {
    if (!content?.trim()) throw new Error('Шаблон пуст.');
    const { folders, filePath } = templatePath(this.state.settings.templateFolder, name);
    const vault = this.app.vault;
    if (vault.getAbstractFileByPath(filePath)) throw new Error('Шаблон с таким названием уже существует.');
    let current = '';
    for (const folder of folders) {
      current = current ? `${current}/${folder}` : folder;
      const existing = vault.getAbstractFileByPath(current);
      if (existing && !(existing instanceof TFolder)) throw new Error('Путь шаблонов занят файлом.');
      if (!existing) await vault.createFolder(current);
    }
    return vault.create(filePath, content.trim() + '\n');
  }
  async openChat() {
    let leaf = this.app.workspace.getLeavesOfType(VIEW)[0];
    if (!leaf) { leaf = this.app.workspace.getRightLeaf(false); await leaf.setViewState({ type: VIEW, active: true }); }
    await this.app.workspace.revealLeaf(leaf);
  }
  onunload() { this.controller?.abort(); this.codex?.close(); }
};
