const { Plugin, ItemView, PluginSettingTab, Setting, Modal, Notice, TFolder, setIcon } = require('obsidian');
const path = require('node:path');
const VIEW = 'personal-knowledge-chat';
const DEFAULTS = { provider: 'local', localUrl: 'http://127.0.0.1:11434', codexPath: '', templateFolder: 'Шаблоны', models: { local: '', chatgpt: '' } };
const TEMPLATE_PROMPT = 'Создай шаблон заметки Obsidian по следующему описанию. Верни только готовый Markdown, без пояснений и ограждающих блоков кода. Начни с заголовка первого уровня. Используй уместные поля и заполнители в двойных фигурных скобках. Описание: ';
const SKILL_DRAFT_PROMPT = 'Помоги создать скил для чат-агента в Obsidian. На основе описания пользователя придумай короткое название и чёткую инструкцию для модели. Не добавляй шаги с исполнением кода, чтением заметок или отправкой данных. Ответь только в формате:\nНазвание: <название>\nИнструкция: <инструкция>\nОписание пользователя: ';

function skillDraft(text, description, output) {
  const name = text.match(/^Название:\s*(.+)$/im)?.[1]?.trim() || description.trim().split('\n')[0].slice(0, 60);
  const instructions = text.match(/^Инструкция:\s*([\s\S]*)$/im)?.[1]?.trim() || text.trim();
  return { name, instructions, output };
}

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
  constructor(app, resolve, skill = false) { super(app); this.resolve = resolve; this.accepted = false; this.skill = skill; }
  onOpen() {
    this.titleEl.setText(this.skill ? 'Отправить описание скила в ChatGPT?' : 'Отправить диалог в ChatGPT?');
    this.contentEl.createEl('p', { text: this.skill ? 'Описание скила будет передано OpenAI. Заметки и история чата не отправляются.' : 'Текст этого диалога будет передан OpenAI. Используются лимиты вашей подписки. Заметки хранилища не отправляются.' });
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

class SkillEditorModal extends Modal {
  constructor(app, plugin, manager, draft = {}) { super(app); this.plugin = plugin; this.manager = manager; this.draft = draft; }
  onOpen() {
    this.titleEl.setText(this.draft.id ? 'Изменить скил' : 'Новый скил');
    this.contentEl.createEl('label', { text: 'Название' });
    const name = this.contentEl.createEl('input', { cls: 'pk-skill-input', attr: { type: 'text', 'aria-label': 'Название скила' } });
    name.value = this.draft.name || '';
    this.contentEl.createEl('label', { text: 'Инструкция для агента' });
    const instructions = this.contentEl.createEl('textarea', { cls: 'pk-skill-instructions', attr: { 'aria-label': 'Инструкция скила' } });
    instructions.value = this.draft.instructions || '';
    this.contentEl.createEl('label', { text: 'Результат' });
    const output = this.contentEl.createEl('select', { cls: 'pk-skill-input', attr: { 'aria-label': 'Результат скила' } });
    output.createEl('option', { value: 'reply', text: 'Ответ в чате' });
    output.createEl('option', { value: 'template', text: 'Шаблон Markdown' });
    output.value = this.draft.output || 'reply';
    new Setting(this.contentEl).addButton(b => b.setButtonText('Отмена').onClick(() => this.close()))
      .addButton(b => b.setButtonText('Сохранить').setCta().onClick(async () => {
        b.setDisabled(true);
        try {
          await this.plugin.saveSkill({ id: this.draft.id, name: name.value, instructions: instructions.value, output: output.value });
          this.close(); this.manager.render();
          new Notice('Скил сохранён.');
        } catch (error) { new Notice(error.message); b.setDisabled(false); }
      }));
  }
}

class DeleteSkillModal extends Modal {
  constructor(app, plugin, manager, skill) { super(app); this.plugin = plugin; this.manager = manager; this.skill = skill; }
  onOpen() {
    this.titleEl.setText('Удалить скил?');
    this.contentEl.createEl('p', { text: `Скил «${this.skill.name}» будет удалён из этого хранилища.` });
    new Setting(this.contentEl).addButton(b => b.setButtonText('Отмена').onClick(() => this.close()))
      .addButton(b => b.setButtonText('Удалить').setWarning().onClick(async () => {
        await this.plugin.removeSkill(this.skill.id);
        this.close(); this.manager.render();
      }));
  }
}

class SkillAIModal extends Modal {
  constructor(app, plugin, manager) { super(app); this.plugin = plugin; this.manager = manager; }
  onOpen() {
    this.titleEl.setText('Создать скил с ИИ');
    this.contentEl.createEl('label', { text: 'Что должен делать скил?' });
    const description = this.contentEl.createEl('textarea', { cls: 'pk-skill-instructions', attr: { 'aria-label': 'Описание нового скила' } });
    this.contentEl.createEl('label', { text: 'Результат' });
    const output = this.contentEl.createEl('select', { cls: 'pk-skill-input', attr: { 'aria-label': 'Результат нового скила' } });
    output.createEl('option', { value: 'reply', text: 'Ответ в чате' });
    output.createEl('option', { value: 'template', text: 'Шаблон Markdown' });
    output.value = 'reply';
    new Setting(this.contentEl).addButton(b => b.setButtonText('Отмена').onClick(() => this.close()))
      .addButton(b => b.setButtonText('Создать черновик').setCta().onClick(async () => {
        if (!description.value.trim()) { new Notice('Опишите скил.'); return; }
        if (this.plugin.busy) { new Notice('Дождитесь ответа в чате.'); return; }
        const { provider, models } = this.plugin.state.settings;
        if (!models[provider]) { new Notice('Сначала выберите модель в чате.'); return; }
        if (provider === 'chatgpt') {
          const accepted = await new Promise(resolve => new ConsentModal(this.app, resolve, true).open());
          if (!accepted) return;
        }
        b.setDisabled(true);
        this.controller = new AbortController();
        try {
          const draft = await this.plugin.draftSkill(description.value, output.value, this.controller.signal);
          this.close();
          new SkillEditorModal(this.app, this.plugin, this.manager, draft).open();
        } catch (error) { if (!this.controller.signal.aborted) new Notice(error.message); }
        finally { b.setDisabled(false); this.controller = null; }
      }));
  }
  onClose() { this.controller?.abort(); }
}

class SkillManagerModal extends Modal {
  constructor(app, plugin) { super(app); this.plugin = plugin; }
  onOpen() { this.render(); }
  render() {
    this.titleEl.setText('Скилы');
    this.contentEl.empty();
    new Setting(this.contentEl).addButton(b => b.setButtonText('Создать вручную').onClick(() => new SkillEditorModal(this.app, this.plugin, this).open()))
      .addButton(b => b.setButtonText('Создать с ИИ').onClick(() => new SkillAIModal(this.app, this.plugin, this).open()));
    for (const skill of this.plugin.state.skills) {
      new Setting(this.contentEl).setName(skill.name).setDesc(skill.output === 'template' ? 'Шаблон Markdown' : 'Ответ в чате')
        .addButton(b => b.setIcon('pencil').setTooltip('Изменить').onClick(() => new SkillEditorModal(this.app, this.plugin, this, skill).open()))
        .addButton(b => b.setIcon('trash-2').setTooltip('Удалить').onClick(() => new DeleteSkillModal(this.app, this.plugin, this, skill).open()));
    }
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
    const headerActions = header.createDiv({ cls: 'pk-header-actions' });
    this.button(headerActions, 'wand-sparkles', 'Управление скилами', () => new SkillManagerModal(this.app, p).open());
    this.button(headerActions, 'settings', 'Настройки агента', () => new ConnectionModal(this.app, p).open());
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
    for (const custom of s.skills) skill.createEl('option', { value: `skill:${custom.id}`, text: custom.name });
    const currentMode = p.chat().mode || 'chat';
    skill.value = currentMode.startsWith('skill:') && !s.skills.some(item => `skill:${item.id}` === currentMode) ? 'chat' : currentMode;
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
    const selectedSkill = s.skills.find(item => `skill:${item.id}` === skill.value);
    this.input = composer.createEl('textarea', { attr: { 'aria-label': 'Сообщение', placeholder: skill.value === 'template' || selectedSkill?.output === 'template' ? 'Опишите нужный шаблон…' : 'Сообщение…', rows: '3' } });
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
    const customSkill = p.state.skills.find(item => `skill:${item.id}` === mode);
    const makeTemplate = mode === 'template' || customSkill?.output === 'template';
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
      if (makeTemplate) answer.skill = 'template';
      const context = chat.messages.filter(m => !m.error && !m.pending).map(({ role, content }) => ({ role, content }));
      if (makeTemplate) context[context.length - 1].content = TEMPLATE_PROMPT + (customSkill ? `Инструкция скила «${customSkill.name}»: ${customSkill.instructions}\n` : '') + text;
      else if (customSkill) context[context.length - 1].content = `Выполни скил «${customSkill.name}». Инструкция: ${customSkill.instructions}\nЗапрос пользователя: ${text}`;
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
      if (makeTemplate && !answer.error) new TemplateModal(this.app, p, answer.content).open();
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
  new Setting(container).setName('Свои скилы').setDesc('Инструкции для чата и создания шаблонов.').addButton(b => b.setButtonText('Управлять').onClick(() => new SkillManagerModal(plugin.app, plugin).open()));
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
    this.state.skills = Array.isArray(this.state.skills) ? this.state.skills : [];
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
  async saveSkill({ id, name, instructions, output }) {
    name = typeof name === 'string' ? name.trim() : '';
    instructions = typeof instructions === 'string' ? instructions.trim() : '';
    if (!name || name.length > 60) throw new Error('Название скила должно содержать не более 60 символов.');
    if (!instructions || instructions.length > 4000) throw new Error('Инструкция скила должна содержать не более 4000 символов.');
    if (!['reply', 'template'].includes(output)) throw new Error('Выберите результат скила.');
    if (this.state.skills.some(item => item.id !== id && item.name.toLocaleLowerCase() === name.toLocaleLowerCase())) throw new Error('Скил с таким названием уже есть.');
    const existing = id ? this.state.skills.find(item => item.id === id) : null;
    if (id && !existing) throw new Error('Скил не найден.');
    const skill = existing || { id: require('node:crypto').randomUUID() };
    Object.assign(skill, { name, instructions, output });
    if (!existing) this.state.skills.push(skill);
    await this.persist();
    this.refreshChat();
    return skill;
  }
  async removeSkill(id) {
    this.state.skills = this.state.skills.filter(item => item.id !== id);
    for (const chat of this.state.chats) if (chat.mode === `skill:${id}`) chat.mode = 'chat';
    await this.persist();
    this.refreshChat();
  }
  refreshChat() {
    if (this.busy) return;
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW)) leaf.view?.render?.();
  }
  async draftSkill(description, output, signal) {
    if (!description?.trim() || description.length > 2000) throw new Error('Опишите скил не более чем в 2000 символах.');
    if (!['reply', 'template'].includes(output)) throw new Error('Выберите результат скила.');
    const { provider, models } = this.state.settings;
    const model = models[provider];
    if (!model) throw new Error('Сначала выберите модель в чате.');
    const text = await this.backend(provider).chat([{ role: 'user', content: SKILL_DRAFT_PROMPT + description.trim() }], model, signal, () => {});
    return skillDraft(text, description, output);
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
