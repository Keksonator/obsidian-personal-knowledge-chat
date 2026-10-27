const http = require('node:http');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const SYSTEM = 'Отвечай по-русски, кратко и понятно. Ты собеседник в личном блокноте. Используй только переданную переписку. Не утверждай, что читал или изменял заметки. Не используй инструменты, файлы, команды или интернет.';

function localUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password) {
    throw new Error('Для локальной модели нужен HTTP-адрес localhost или 127.0.0.1.');
  }
  return url.origin;
}

function requestJson(base, route, body, signal) {
  return new Promise((resolve, reject) => {
    const url = new URL(route, localUrl(base));
    const req = http.request(url, {
      method: body ? 'POST' : 'GET', signal,
      headers: body ? { 'Content-Type': 'application/json' } : {},
    }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        text += chunk;
        if (text.length > 8 * 1024 * 1024) req.destroy(new Error('Ответ слишком большой.'));
      });
      res.on('error', reject);
      res.on('end', () => {
        try {
          const data = JSON.parse(text);
          if (res.statusCode !== 200 || data.error) throw new Error(data.error || `HTTP ${res.statusCode}`);
          resolve(data);
        } catch (error) { reject(error); }
      });
    });
    req.setTimeout(300000, () => req.destroy(new Error('Модель не ответила за 5 минут.')));
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

class Ollama {
  constructor(base) { this.base = localUrl(base); }
  async models(signal) {
    const result = await requestJson(this.base, '/api/tags', null, signal);
    return (result.models || []).filter(m => !m.remote_host && !m.name.includes(':cloud')).sort((a, b) => a.size - b.size).map(m => ({
      id: m.name, label: `${m.name}${m.details?.parameter_size ? ` · ${m.details.parameter_size}` : ''}`,
    }));
  }
  async chat(messages, model, signal, onText) {
    const result = await requestJson(this.base, '/api/chat', {
      model, messages: [{ role: 'system', content: SYSTEM }, ...messages], stream: false,
    }, signal);
    const text = result.message?.content;
    if (!text) throw new Error('Модель вернула пустой ответ.');
    onText(text);
    return text;
  }
}

class Rpc {
  constructor(proc) {
    this.proc = proc;
    this.pending = new Map();
    this.listeners = new Set();
    this.nextId = 1;
    this.closed = false;
    this.lines = readline.createInterface({ input: proc.stdout });
    this.lines.on('line', line => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.id !== undefined && msg.method) {
        // No server-initiated tool or permission request may execute in this chat.
        this.send({ id: msg.id, error: { code: -32601, message: 'Tools are disabled in this client.' } });
      } else if (msg.id !== undefined) {
        const pending = this.pending.get(msg.id);
        if (!pending) return;
        this.pending.delete(msg.id);
        clearTimeout(pending.timer);
        msg.error ? pending.reject(new Error(msg.error.message)) : pending.resolve(msg.result);
      } else {
        for (const listener of this.listeners) listener(msg);
      }
    });
    proc.stderr.on('data', () => {});
    proc.stdin.on('error', error => this.fail(error));
    proc.on('error', error => this.fail(error));
    proc.on('exit', () => this.fail(new Error('Соединение с Codex закрыто.')));
  }
  send(message) {
    if (this.closed) throw new Error('Codex не подключён.');
    this.proc.stdin.write(JSON.stringify(message) + '\n');
  }
  call(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex: время ожидания ${method} истекло.`));
      }, 30000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  fail(error) {
    if (this.closed) return;
    this.closed = true;
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); }
    this.pending.clear();
    for (const listener of this.listeners) listener({ method: 'client/error', params: { error } });
  }
  close() { this.fail(new Error('Соединение закрыто.')); this.lines.close(); this.proc.kill(); }
}

function findCodex(configured) {
  if (configured.trim()) return configured.trim();
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    const root = path.join(process.env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin');
    if (fs.existsSync(root)) {
      const candidates = fs.readdirSync(root).map(name => path.join(root, name, 'codex.exe')).filter(p => fs.existsSync(p));
      candidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
      if (candidates.length) return candidates[0];
    }
  }
  return 'codex';
}

class Codex {
  constructor(executable = '') { this.executable = executable; this.rpc = null; this.connecting = null; }
  async connect() {
    if (this.rpc && !this.rpc.closed) return this.rpc;
    if (this.connecting) return this.connecting;
    this.connecting = this.start();
    try { return await this.connecting; } finally { this.connecting = null; }
  }
  async start() {
    // Separate credentials/config from the user's vault and normal Codex sessions.
    const home = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), 'PersonalKnowledgeChat', 'codex');
    const cwd = path.join(home, 'empty-workspace');
    fs.mkdirSync(cwd, { recursive: true });
    const env = { ...process.env, CODEX_HOME: home, HOME: os.homedir(), USERPROFILE: os.homedir() };
    for (const key of ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN']) delete env[key];
    const args = ['app-server', '--listen', 'stdio://',
      ...['shell_tool', 'apps', 'multi_agent', 'multi_agent_v2', 'plugins', 'hooks',
        'browser_use', 'browser_use_external', 'computer_use', 'image_generation',
        'code_mode_host', 'view_image', 'skill_search', 'workspace_dependencies'].flatMap(name => ['-c', `features.${name}=false`]),
      '-c', 'features.skip_host_skill_discovery=true',
      '-c', 'web_search="disabled"', '-c', 'project_doc_max_bytes=0',
      '-c', 'model_provider="openai"'];
    const rpc = new Rpc(spawn(findCodex(this.executable), args, { cwd, env, windowsHide: true, shell: false, stdio: 'pipe' }));
    this.rpc = rpc;
    this.cwd = cwd;
    try {
      await rpc.call('initialize', { clientInfo: { name: 'personal_knowledge_chat', version: '0.1.0' } });
      rpc.send({ method: 'initialized', params: {} });
      return rpc;
    } catch (error) { rpc.close(); throw error; }
  }
  async login() { return (await this.connect()).call('account/login/start', { type: 'chatgpt' }); }
  async models() {
    const rpc = await this.connect();
    const { account } = await rpc.call('account/read', { refreshToken: false });
    if (!account || account.type !== 'chatgpt') throw new Error('Войдите в ChatGPT в настройках плагина.');
    const models = [];
    let cursor;
    do {
      const page = await rpc.call('model/list', { limit: 100, ...(cursor ? { cursor } : {}) });
      models.push(...page.data.map(m => ({ id: m.model, label: m.displayName || m.model })));
      cursor = page.nextCursor;
    } while (cursor);
    return models;
  }
  async chat(messages, model, signal, onText) {
    const rpc = await this.connect();
    if (signal.aborted) throw new Error('Остановлено.');
    const { account } = await rpc.call('account/read', { refreshToken: false });
    if (account?.type !== 'chatgpt') throw new Error('Требуется вход через подписку ChatGPT.');
    // The complete local history is supplied on each request; backend switching preserves context.
    const started = await rpc.call('thread/start', {
      model, cwd: this.cwd, ephemeral: true, sandbox: 'read-only', approvalPolicy: 'never',
      baseInstructions: SYSTEM,
    });
    const threadId = started.thread.id;
    return new Promise((resolve, reject) => {
      let text = '', turnId = null, settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        rpc.listeners.delete(listener);
        signal.removeEventListener('abort', abort);
        error ? reject(error) : resolve(text);
      };
      const interrupt = () => {
        if (turnId && !rpc.closed) rpc.call('turn/interrupt', { threadId, turnId }).catch(() => {});
      };
      const abort = () => { interrupt(); finish(new Error('Остановлено.')); };
      const timer = setTimeout(() => { interrupt(); finish(new Error('Codex не ответил за 5 минут.')); }, 300000);
      const listener = msg => {
        if (msg.method === 'client/error') return finish(msg.params.error);
        const p = msg.params || {};
        if (p.threadId !== threadId) return;
        if (msg.method === 'turn/started') { turnId = p.turn.id; if (signal.aborted) interrupt(); }
        if (msg.method === 'item/agentMessage/delta') { text += p.delta; onText(text); }
        if (msg.method === 'item/completed' && p.item?.type === 'agentMessage' && !text) { text = p.item.text || ''; onText(text); }
        if (msg.method === 'turn/completed') {
          if (p.turn.status !== 'completed') finish(new Error(p.turn.error?.message || 'Ответ прерван.'));
          else finish(text ? null : new Error('Модель вернула пустой ответ.'));
        }
      };
      rpc.listeners.add(listener);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) { abort(); return; }
      rpc.call('turn/start', {
        threadId, model,
        input: [{ type: 'text', text: 'Переписка в формате JSON. Ответь на последнее сообщение пользователя:\n' + JSON.stringify(messages) }],
      }).then(result => { turnId = result.turn.id; if (settled) interrupt(); }).catch(finish);
    });
  }
  close() { this.rpc?.close(); this.rpc = null; }
}

module.exports = { Ollama, Codex, Rpc, localUrl, requestJson };
