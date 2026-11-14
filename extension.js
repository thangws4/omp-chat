'use strict';
const vscode = require('vscode');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { OmpClient } = require('./omp-client');
const keys = require('./keys');
const plugins = require('./plugins');
const { PROVIDERS } = keys;

const OMP_PACKAGE = '@oh-my-pi/pi-coding-agent'; // needs Bun >= 1.4.4
const isWin = process.platform === 'win32';
const exe = (name) => name + (isWin ? '.exe' : '');
const bunHome = () => process.env.BUN_INSTALL || path.join(os.homedir(), '.bun');

// The real bun binary. `bun` on PATH may be an npm .cmd shim, and omp's launcher needs bun(.exe) itself.
function findBun() {
  const r = spawnSync('bun', ['-e', 'console.log(process.execPath)'], { encoding: 'utf8', shell: isWin });
  if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  const p = path.join(bunHome(), 'bin', exe('bun'));
  return fs.existsSync(p) ? p : null;
}

// omp installed with `bun install -g` but not on VS Code's PATH yet (PATH is read when VS Code starts).
// Returns the omp binary plus the folders its launcher needs on PATH.
function findOmp() {
  const bun = findBun();
  const dirs = [];
  if (bun) {
    const r = spawnSync(bun, ['pm', 'bin', '-g'], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim()) dirs.push(r.stdout.trim());
  }
  dirs.push(path.join(bunHome(), 'bin'));
  const omp = dirs.map((d) => path.join(d, exe('omp'))).find((p) => fs.existsSync(p));
  return omp ? { omp, pathDirs: [path.dirname(omp), bun && path.dirname(bun)].filter(Boolean) } : null;
}

// Left side of the diff view: the file as it was before an omp edit (omp-orig:/<name>?<editId>).
const ORIG_SCHEME = 'omp-orig';
// Settings that only take effect when omp is respawned (the model switches live via set_model).
const RESTART_KEYS = ['approvalMode', 'ompPath', 'extraArgs'];

const LAST_SESSION = 'ompChat.lastSession'; // workspaceState key: session file to resume on reload
// Webview messages that can change the agent status shown outside the chat.
const STATUS_EVENTS = new Set(['busy', 'idle', 'dialog', 'dialog_close', 'clear']);
const STATUS_UI = {
  blocked: { title: '🔴 waiting for you', badge: 'OMP Chat is waiting for your answer', bar: '$(bell-dot) OMP: needs you' },
  working: { title: '🟡 working', badge: null, bar: '$(sync~spin) OMP: working' },
  done: { title: '🔵 done', badge: 'OMP Chat finished while you were away', bar: '$(check) OMP: done' },
  idle: { title: '', badge: null, bar: '' },
};
// Prepended to each message in plan mode; edits and commands are also denied at approval time.
const PLAN_NOTE = '[Plan mode: investigate with read-only tools and reply with a concrete, numbered plan for the change. '
  + 'Do not edit files or run commands; such requests will be denied. The user will approve the plan before you carry it out.]';
const USAGE_DAY = 'ompChat.usageDay';       // globalState: model requests sent from this extension today (UTC)
const utcDay = () => new Date().toISOString().slice(0, 10); // OpenRouter's free-model quota resets at 00:00 UTC

// Undo what send() prepends ("[Note: …]" lines, selection / current-file context) for display.
function splitUserText(text) {
  let context = null;
  text = text.replace(/^(\[Note: [^\n]*\]\n)+\n/, '');
  text = text.replace(/^\[Plan mode: [^\n]*\]\n\n/, '');
  text = text.replace(/^\[Skills that may help with this request[^\n]*\]\n\n/, '');
  let m = /^\[Selection from ([^\]\n]+)\]\n```[^\n]*\n[\s\S]*?\n```\n\n/.exec(text);
  if (!m) m = /^\[Current file: ([^\]\n]+)\]\n\n/.exec(text);
  if (m) { context = m[1]; text = text.slice(m[0].length); }
  return { text, context };
}

// "retry-after-ms=17518000" in a provider error -> "4h 52m".
function retryAfter(msg) {
  const ms = +(/retry-after-ms=(\d+)/.exec(msg || '')?.[1] || 0);
  if (!ms) return null;
  const min = Math.ceil(ms / 60000);
  return min >= 60 ? `${Math.floor(min / 60)}h ${min % 60}m` : `${min}m`;
}

// Files outside the workspace come back as long absolute paths: show the file name (and line range).
function shortLabel(label) {
  if (!label) return label;
  const m = /^(.*?)(:\d+-\d+)?$/.exec(label);
  return path.isAbsolute(m[1]) ? path.basename(m[1]) + (m[2] || '') : label;
}

// One line describing a task brief, for card titles: the first line under a "# Goal / Change / Task" heading
// when there is one, else the first line that is not a heading.
function summaryLine(text) {
  const lines = String(text || '').split('\n').map((l) => l.trim());
  const h = lines.findIndex((l) => /^#{1,6}\s*(goal|change|task|objective|ask)\b/i.test(l));
  const pick = (from) => {
    const i = lines.findIndex((l, j) => j >= from && l && !/^#{1,6}\s/.test(l));
    if (i < 0) return '';
    const next = lines.slice(i + 1).find((l) => l && !/^#{1,6}\s/.test(l));
    return lines[i].endsWith(':') && next ? `${lines[i]} ${next.replace(/^[-*\d.)\s]+/, '')}` : lines[i]; // "Investigate only: list every…"
  };
  return ((h >= 0 && pick(h + 1)) || pick(0)).replace(/^[-*\d.)\s]+/, '').slice(0, 160);
}

const textOf = (content) => (typeof content === 'string' ? content
  : (content || []).filter((p) => p.type === 'text').map((p) => p.text).join('\n'));

// Title + first user line of a session file, read from its head only (sessions can be large).
function sessionSummary(file) {
  let head = '';
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(64 * 1024);
    head = buf.toString('utf8', 0, fs.readSync(fd, buf, 0, buf.length, 0));
    fs.closeSync(fd);
  } catch { return null; }
  let title = '', first = '';
  for (const line of head.split('\n')) {
    let e;
    try { e = JSON.parse(line); } catch { continue; } // last line may be cut off
    if (e.type === 'title' && e.title) title = e.title;
    if (e.type === 'message' && e.message?.role === 'user') { first = splitUserText(textOf(e.message.content)).text; break; }
  }
  if (!first) return null; // never used: nothing to resume
  return { title: (title || first).replace(/\s+/g, ' ').trim().slice(0, 90) };
}

class ChatProvider {
  constructor(context) {
    this.context = context;
    this.view = null;
    this.client = null;
    this.busy = false;
    this.dialogs = new Map();    // omp dialog id -> { cancel(), answer?(value) }
    this.edits = new Map();      // edit id -> { path, oldText, newText, created }
    this.toolStarts = new Map(); // toolCallId -> { args, abs, before } (write-tool snapshots)
    this.editSeq = 0;
    this.commands = [];
    this.notes = [];             // told to the model with the next message (e.g. "user reverted X")
    this.modelName = null;
    this.resume = null;          // { file, replay } session to reopen when omp (re)spawns
    this.replaying = false;
    this.forms = new Map();      // in-panel form id -> resolve(values | null)
    this.formSeq = 0;
    this.turnSeq = 0;            // your messages in this conversation, counted like omp's user entries (for Rewind)
    this.shellSeq = 0;           // "!command" blocks
    this.queued = new Map();     // qid -> { message, text, context, images } waiting in omp's queue
    this.subagents = new Map();  // subagent id -> latest merged lifecycle/progress record
    this.subSeq = 0;
    this.qSeq = 0;
    this.newReadyPromise();
  }

  newReadyPromise() {
    this.readyPromise = new Promise((r) => { this.markReady = r; });
  }

  resolveWebviewView(view) {
    this.view = view;
    this.newReadyPromise();
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
    };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((m) => this.onWebviewMessage(m));
    view.onDidDispose(() => { this.view = null; });
    view.onDidChangeVisibility?.(() => { // looking at the panel clears "done, not seen yet"
      if (view.visible) { this.unseenDone = false; this.refreshStatus(); }
    });
    this.boot();
  }

  // First use: ask once for a provider + key, then start omp right away instead of on the first message.
  // Dismissing is fine: omp may have its own login, and a 401 later points to "Set API Key".
  async boot() {
    const saved = await keys.envFor(this.context);
    const hasKey = Object.keys(saved).length > 0 || PROVIDERS.some((p) => process.env[p.env]);
    if (!hasKey && !this.context.globalState?.get('ompChat.keyPrompted')) {
      await this.context.globalState?.update('ompChat.keyPrompted', true);
      this.addKeyForm(true); // in the panel, alongside omp starting up
    }
    // Pick up where the last window left off (New starts a fresh one).
    const last = this.context.workspaceState.get(LAST_SESSION);
    if (!this.client && last && sessionSummary(last)) this.resume = { file: last, replay: true };
    await this.ensureClient();
    this.listSkills().catch(() => {}); // warm the skill list so auto-pick does not delay the first message
  }

  post(msg) {
    if (this.view) this.view.webview.postMessage(msg);
    if (STATUS_EVENTS.has(msg.type)) this.onStatusEvent(msg.type);
  }

  // ---- agent status at a glance (like herdr's dots): panel title, Activity Bar badge, status bar ----
  // 🔴 waiting for you (an approval or question is open) · 🟡 working · 🔵 done while you weren't looking · 🟢 idle
  onStatusEvent(type) {
    if (type === 'busy') { this.working = true; this.unseenDone = false; }
    if (type === 'idle') { if (this.working && !this.view?.visible) this.unseenDone = true; this.working = false; }
    if (type === 'clear') this.unseenDone = false;
    this.refreshStatus();
  }

  agentStatus() {
    if (this.dialogs.size) return 'blocked';
    if (this.working || this.runningSubagents()) return 'working'; // background subagents keep working after the turn
    return this.unseenDone ? 'done' : 'idle';
  }

  runningSubagents() {
    return [...this.subagents.values()].filter((s) => s.status === 'running').length;
  }

  // ---- subagents (omp's task tool): live cards, transcript, stop / steer ----
  // Lifecycle frames say started/completed/failed/aborted; progress frames carry the running agent's intent,
  // current tool and counters. Both are merged into one record per subagent and sent to the chat.
  onSubagent(p, prog) {
    if (!p) return;
    const id = p.id || prog?.id;
    if (!id) return;
    const LIFE = { started: 'running', completed: 'completed', failed: 'failed', aborted: 'aborted' };
    const prev = this.subagents.get(id);
    const fresh = !prev || (prev.status !== 'running' && (prog?.status === 'running' || p.status === 'started') && p.parentToolCallId !== prev.parent);
    const s = fresh ? { id, key: `${id}#${++this.subSeq}` } : prev;
    // assignment = what the parent asked for; task = that wrapped in omp's generic preamble
    const task = p.description || prog?.description || p.assignment || prog?.assignment || p.task || prog?.task || '';
    Object.assign(s, {
      agent: p.agent || prog?.agent || s.agent, parent: p.parentToolCallId || s.parent, detached: p.detached ?? s.detached,
      sessionFile: p.sessionFile || s.sessionFile, task: summaryLine(task) || s.task || '', status: prog?.status || LIFE[p.status] || s.status || 'running',
    });
    if (prog) {
      Object.assign(s, { intent: prog.lastIntent || s.intent, tool: prog.currentTool, toolArgs: prog.currentToolArgs,
        tools: prog.toolCount, tokens: prog.tokens, ms: prog.durationMs, cost: prog.cost });
    }
    this.subagents.set(id, s);
    this.post({ type: 'subagent', ...s });
    this.refreshStatus();
  }

  // The subagent's own conversation (works after it finished too), simplified for the transcript sheet.
  async subagentTranscript(id) {
    const s = this.subagents.get(id);
    if (!s || !this.client) return;
    try {
      // From omp while it still tracks the subagent; after a respawn omp refuses, so read its session file
      // (JSONL, one entry per line, same format as the main conversation) directly.
      const r = await this.client.request({ type: 'get_subagent_messages', subagentId: id }).catch((e) => {
        if (!s.sessionFile || !fs.existsSync(s.sessionFile)) throw e;
        const messages = fs.readFileSync(s.sessionFile, 'utf8').split('\n')
          .map((l) => { try { return JSON.parse(l); } catch { return null; } })
          .filter((x) => x?.type === 'message' && x.message).map((x) => x.message);
        return { messages };
      });
      const messages = [];
      for (const m of r.messages || []) {
        if (m.role === 'user') messages.push({ role: 'task', text: textOf(m.content).slice(0, 6000) });
        else if (m.role === 'assistant') {
          const tools = (m.content || []).filter((c) => c.type === 'toolCall')
            .map((c) => ({ name: c.name, detail: String(c.arguments?.i || c.arguments?.path || c.arguments?.command || c.arguments?.pattern || '').slice(0, 120) }));
          messages.push({ role: 'assistant', text: textOf(m.content), tools });
        } else if (m.role === 'toolResult') {
          messages.push({ role: 'tool', name: m.toolName, text: textOf(m.content).slice(0, 3000), isError: !!m.isError });
        }
      }
      this.post({ type: 'subagentTranscript', id, agent: s.agent, task: s.task, status: s.status, messages });
    } catch (e) {
      this.post({ type: 'error', text: `Could not read ${id}'s conversation: ${e.message}` });
    }
  }

  async subagentControl(kind, id, text) {
    if (!this.client) return;
    try {
      if (kind === 'stop') await this.client.request({ type: 'cancel_subagent', subagentId: id });
      else if (text?.trim()) {
        await this.client.request({ type: 'steer_subagent', subagentId: id, message: text.trim() });
        this.post({ type: 'notice', text: `Sent to ${id}: ${text.trim()}` });
      }
    } catch (e) {
      this.post({ type: 'error', text: `${kind === 'stop' ? 'Could not stop' : 'Could not message'} ${id}: ${e.message}` });
    }
  }

  refreshStatus() {
    const s = this.agentStatus();
    const info = STATUS_UI[s];
    if (this.view) {
      this.view.description = info.title;
      this.view.badge = info.badge ? { value: 1, tooltip: info.badge } : undefined;
    }
    const item = this.statusItem;
    if (!item) return;
    if (s === 'idle') return item.hide();
    const subs = this.runningSubagents();
    item.text = info.bar + (subs && s === 'working' ? ` · ${subs} subagent${subs > 1 ? 's' : ''}` : '');
    item.tooltip = `${info.badge || 'OMP Chat is working'}${this.modelName ? ` · ${this.modelName}` : ''} (click to open)`;
    item.backgroundColor = s === 'blocked' ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    item.show();
  }

  // ---- in-panel UI: everything is asked and shown inside the chat view, not in VS Code pop-ups ----
  // Bring the panel up (commands can run while it is closed) and wait until its webview listens.
  async reveal() {
    if (this.view) this.view.show?.(true);
    else await vscode.commands.executeCommand('ompChat.view.focus');
    await Promise.race([this.readyPromise, new Promise((r) => setTimeout(r, 5000))]);
  }

  // A form card in the panel. Resolves to { fieldName: value } or null when dismissed.
  ask(form) {
    if (!this.view) return Promise.resolve(null);
    const id = 'f' + ++this.formSeq;
    return new Promise((resolve) => {
      this.forms.set(id, resolve);
      this.post({ type: 'form', id, ...form });
    });
  }

  answerForm(id, values) {
    const resolve = this.forms.get(id);
    this.forms.delete(id);
    resolve?.(values || null);
  }

  // Add a key from a form in the panel; `intro` is the first-run welcome. Returns true if a key was saved.
  async addKeyForm(intro, providerLabel) {
    await this.reveal();
    const v = await this.ask({
      title: intro ? 'Connect a model provider' : 'Add an API key',
      text: (intro ? 'OMP Chat runs the omp agent with your own API key. Skip this if omp already has a login of its own.\n' : '')
        + 'Get a key: ' + PROVIDERS.map((p) => `${p.label} ${p.url}`).join(' · '),
      fields: [
        { name: 'provider', label: 'Provider', type: 'select', value: providerLabel || PROVIDERS[0].label,
          options: PROVIDERS.map((p) => ({ value: p.label, label: `${p.label} — ${p.description}` })) },
        { name: 'key', label: 'API key', type: 'password', placeholder: 'Paste the key', required: true },
        { name: 'label', label: 'Name (optional)', placeholder: 'e.g. work, personal' },
      ],
      submit: 'Save key', cancel: intro ? 'Skip' : 'Cancel',
    });
    if (!v?.key?.trim()) return false;
    const p = PROVIDERS.find((x) => x.label === v.provider) || PROVIDERS[0];
    const count = (await keys.loadKeys(this.context, p.env)).length;
    const label = v.label?.trim() || (count ? `${p.label} ${count + 1}` : p.label);
    await keys.addKey(this.context, p.env, label, v.key.trim());
    // Move to this provider when the current model has no key to run with.
    const cfg = vscode.workspace.getConfiguration('ompChat');
    const cur = keys.providerOf(cfg.get('model'));
    const curUsable = cur && ((await keys.loadKeys(this.context, cur.env)).length > 0 || !!process.env[cur.env]);
    if (!String(cfg.get('model')).startsWith(p.prefix) && (!cur || cur.env === p.env || !curUsable)) {
      this.quietModel = p.defaultModel; // restart() below applies it; skip the live set_model
      await cfg.update('model', p.defaultModel, vscode.ConfigurationTarget.Global);
    }
    this.post({ type: 'notice', text: `Saved "${label}" for ${keys.groupLabel(p.env)}; it is now the active key.` });
    await this.restart(); // keys reach omp through its environment; the conversation is resumed
    return true;
  }

  async keyGroups() {
    return Promise.all(keys.ENVS.map(async (env) => {
      const list = await keys.loadKeys(this.context, env);
      const active = keys.activeKey(this.context, env, list);
      return { env, label: keys.groupLabel(env), providers: PROVIDERS.filter((p) => p.env === env).map((p) => p.label),
        keys: list.map((k) => ({ id: k.id, label: k.label, mask: keys.mask(k.key), active: k.id === active?.id })) };
    }));
  }

  async showKeys() {
    await this.reveal();
    this.post({ type: 'keys', groups: await this.keyGroups() });
  }

  async renameKey(env, id, label) {
    if (!label?.trim()) return;
    await keys.updateKeys(this.context, env, (l) => l.map((k) => (k.id === id ? { ...k, label: label.trim() } : k)));
    this.showKeys();
  }

  async removeKey(env, id) {
    const wasActive = keys.activeKey(this.context, env, await keys.loadKeys(this.context, env))?.id === id;
    await keys.updateKeys(this.context, env, (l) => l.filter((k) => k.id !== id));
    if (wasActive) await this.restart(); // omp was using it
    this.showKeys();
  }

  // Everything the webview shows outside the chat log; sent when it (re)loads.
  sync() {
    this.post({ type: 'mode', mode: vscode.workspace.getConfiguration('ompChat').get('approvalMode') });
    this.post({ type: 'model', name: this.modelName || vscode.workspace.getConfiguration('ompChat').get('model') });
    this.post({ type: 'commands', list: this.commands });
    this.postContext();
  }

  async onWebviewMessage(m) {
    switch (m.type) {
      case 'ready': this.markReady(); return this.sync();
      case 'send': return this.send(m.text, m.withContext, m.images);
      case 'stop': return this.stop();
      case 'new': return this.newSession();
      case 'dialogAnswer': return this.dialogs.get(m.id)?.answer?.(m.value);
      case 'formAnswer': return this.answerForm(m.id, m.values);
      case 'listFiles': return this.listFiles();
      case 'pickModel': return this.pickModel();
      case 'setModel': return vscode.workspace.getConfiguration('ompChat').update('model', m.id, vscode.ConfigurationTarget.Global);
      case 'history': return this.pickSession();
      case 'openSession': return this.openSession(m.file);
      case 'usage': return this.showUsage();
      case 'setApiKey': return this.manageKeys();
      case 'addKey': return this.addKeyForm(false, m.provider);
      case 'useKey': await this.useKey(m.env, m.id); return m.from === 'keys' ? this.showKeys() : this.showUsage();
      case 'renameKey': return this.renameKey(m.env, m.id, m.label);
      case 'removeKey': return this.removeKey(m.env, m.id);
      case 'rewind': return this.rewind(m.turn, !!m.restoreCode);
      case 'promoteQueued': return this.promoteQueued(m.qid);
      case 'removeQueued': return this.removeQueued(m.qid);
      case 'executePlan': return this.executePlan(m.mode);
      case 'plugins': return this.showPlugins(m.refresh);
      case 'runInTerminal': return this.runInTerminal(m.command);
      case 'subagentView': return this.subagentTranscript(m.id);
      case 'subagentStop': return this.subagentControl('stop', m.id);
      case 'subagentSteer': return this.subagentControl('steer', m.id, m.text);
      case 'toggleFavorite': await this.toggleFavorite(m.id); return m.from === 'sheet' ? this.showModelsSheet() : undefined;
      case 'moveFavorite': return this.moveFavorite(m.id, m.dir);
      case 'manageModels': return this.showModelsSheet();
      case 'applyPlugins': return this.applyPlugins(Array.isArray(m.disabled) ? m.disabled : [], m.auto);
      case 'action': // buttons on error / notice lines
        switch (m.cmd) {
          case 'pickModel': return this.pickModel();
          case 'manageKeys': return this.manageKeys();
          case 'usage': return this.showUsage();
          case 'history': return this.pickSession();
          case 'installOmp': return this.installOmp();
          case 'setOmpPath': return this.setOmpPath();
          case 'retry': return this.retry();
          case 'openUrl': return vscode.env.openExternal(vscode.Uri.parse(m.arg));
          case 'setModel': return vscode.workspace.getConfiguration('ompChat').update('model', m.arg, vscode.ConfigurationTarget.Global);
          case 'revertForce': return this.revert(m.arg, true);
        }
        return;
      case 'setMode':
        return vscode.workspace.getConfiguration('ompChat').update('approvalMode', m.mode, vscode.ConfigurationTarget.Global);
      case 'openDiff': return this.openDiff(m.id);
      case 'revert': return this.revert(m.id);
    }
  }

  // Shared promise so concurrent callers (boot, send, New, settings change) spawn only one omp.
  ensureClient() {
    if (this.client) return Promise.resolve(this.client);
    return (this.starting ??= this.spawn().finally(() => { this.starting = null; }));
  }

  async spawn() {
    // The active saved key of each provider; switching keys means respawning (see restart()).
    const env = { ...process.env, ...(await keys.envFor(this.context)) };
    // Read config after the awaits so a setting changed meanwhile is picked up.
    const cfg = vscode.workspace.getConfiguration('ompChat');
    this.cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();

    // Plan mode is OMP Chat's own (omp's /plan is terminal-only): omp asks for every edit/command and we deny them.
    const mode = cfg.get('approvalMode') === 'plan' ? 'always-ask' : cfg.get('approvalMode');
    const args = ['--mode', 'rpc', '--model', cfg.get('model'), ...(mode ? ['--approval-mode', mode] : []), ...this.overlayArgs(), ...cfg.get('extraArgs', [])];
    const ompPath = cfg.get('ompPath') || 'omp';
    const fallback = ompPath === 'omp' ? this.ompFallback : null;
    const command = fallback ? fallback.omp : ompPath;
    if (fallback) {
      const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH'; // "Path" on Windows
      env[key] = [...fallback.pathDirs, env[key]].filter(Boolean).join(path.delimiter);
    }
    const client = new OmpClient({ command, args, cwd: this.cwd, env });
    client.on('record', (r) => this.onRecord(r));
    client.on('stderr', (t) => this.post({ type: 'log', text: t }));
    client.on('exit', (info) => {
      if (this.client !== client) return; // disposed on purpose; not a crash
      this.client = null;
      this.closeDialogs();
      this.busy = false;
      this.post({ type: 'idle' });
      if (info.error?.code === 'ENOENT') {
        const found = ompPath === 'omp' && !this.ompFallback && findOmp();
        if (found) { this.ompFallback = found; this.ensureClient(); return; }
        this.post({ type: 'error', text: `omp (oh-my-pi) was not found ("${command}"). OMP Chat needs it to run the agent.` });
        this.offerInstall();
        return;
      }
      const why = info.error ? info.error.message : `exit code ${info.code ?? info.signal}`;
      this.post({ type: 'error', text: `omp stopped (${why}).` });
    });
    client.start();
    this.client = client;
    if (this.resume) {
      const { file, replay } = this.resume;
      this.resume = null;
      try {
        await client.request({ type: 'switch_session', sessionPath: file });
        if (replay) this.replay((await client.request({ type: 'get_messages' })).messages);
      } catch (e) {
        if (this.client !== client) this.resume = { file, replay }; // omp failed to start: keep it for the retry
        else this.post({ type: 'error', text: `Could not resume the conversation: ${e.message}` });
      }
    }
    this.track(client);
    // Live subagent lifecycle + progress frames (off by default in omp's RPC mode).
    client.request({ type: 'set_subagent_subscription', level: 'progress' }).catch(() => {});
    return client;
  }

  offerInstall() {
    this.post({ type: 'error', text: 'OMP Chat needs omp (oh-my-pi), the coding agent it runs. It is not installed or not on PATH.',
      actions: [{ label: 'Install omp', cmd: 'installOmp' }, { label: 'Set path…', cmd: 'setOmpPath' }, { label: 'Retry', cmd: 'retry' }] });
  }

  async setOmpPath() {
    const v = await this.ask({
      title: 'Where is omp?', text: 'Full path to the omp executable, e.g. C:\\Users\\you\\.bun\\bin\\omp.exe',
      fields: [{ name: 'path', label: 'omp executable', value: vscode.workspace.getConfiguration('ompChat').get('ompPath'), required: true }],
      submit: 'Use this path',
    });
    // A changed ompPath respawns omp via onConfigChange.
    if (v?.path?.trim()) await vscode.workspace.getConfiguration('ompChat').update('ompPath', v.path.trim(), vscode.ConfigurationTarget.Global);
  }

  // Runs in a visible terminal so the user sees (and can stop) every command.
  installOmp() {
    const bun = findBun();
    const t = vscode.window.createTerminal({ name: 'Install omp', shellPath: isWin ? 'powershell.exe' : undefined });
    t.show();
    if (!bun) t.sendText(isWin ? 'irm bun.sh/install.ps1 | iex' : 'curl -fsSL https://bun.sh/install | bash'); // Bun's official installers
    const bunPath = bun || path.join(bunHome(), 'bin', exe('bun')); // a fresh install is not on this shell's PATH yet
    t.sendText(`${isWin ? '& ' : ''}"${bunPath}" install -g ${OMP_PACKAGE}`);
    this.post({ type: 'notice', text: 'Installing omp in the terminal below. Click Retry when it has finished.', actions: [{ label: 'Retry', cmd: 'retry' }] });
  }

  retry() {
    this.ompFallback = null;
    this.ensureClient();
  }

  // Show the current model and remember the session file for the next reload.
  async track(client) {
    try {
      const s = await client.request({ type: 'get_state' });
      this.setModel(s.model);
      this.post({ type: 'todos', phases: s.todoPhases || [] });
      if (s.sessionFile) await this.context.workspaceState.update(LAST_SESSION, s.sessionFile);
      this.refreshMeter();
      return s;
    } catch { return null; }
  }

  // Rebuild the chat log from omp's stored messages by replaying them as live events,
  // so tool rows, diffs and Revert work the same as in a live session.
  replay(messages) {
    this.replaying = true;
    this.turnSeq = 0;
    this.edits.clear();
    try {
      this.post({ type: 'clear' });
      let unanswered = false; // omp does not keep failed replies, so two user turns in a row mean one failed
      for (const m of messages || []) {
        if (m.role === 'user') {
          const u = splitUserText(textOf(m.content));
          const images = Array.isArray(m.content)
            ? m.content.filter((p) => p.type === 'image' && p.data).map((p) => `data:${p.mimeType};base64,${p.data}`) : [];
          if (!u.text && !images.length) continue;
          if (unanswered) this.post({ type: 'notice', text: 'No reply: this request failed.' });
          // turn = position among omp's user entries; Rewind uses it to find the entry again.
          this.post({ type: 'user', text: u.text, context: shortLabel(u.context), images, turn: ++this.turnSeq });
          unanswered = true;
        } else if (m.role === 'assistant') {
          unanswered = false;
          for (const p of m.content || []) {
            if (p.type === 'thinking' && (p.thinking || p.text)) this.post({ type: 'thinking', delta: p.thinking || p.text });
            else if (p.type === 'text' && p.text) this.post({ type: 'text', delta: p.text });
            else if (p.type === 'toolCall') this.onRecord({ type: 'tool_execution_start', toolCallId: p.id, toolName: p.name, args: p.arguments });
          }
          if (m.stopReason === 'error' && m.errorMessage) this.post({ type: 'error', text: m.errorMessage });
          this.post({ type: 'assistant_done' });
        } else if (m.role === 'bashExecution') { // a "!command" you ran yourself
          const id = 'sh' + ++this.shellSeq;
          this.post({ type: 'shell_start', id, command: m.command });
          this.post({ type: 'shell_end', id, output: (m.output || '').slice(-8000), exitCode: m.exitCode, cancelled: m.cancelled, truncated: m.truncated });
        } else if (m.role === 'toolResult') {
          this.onRecord({ type: 'tool_execution_end', toolCallId: m.toolCallId, toolName: m.toolName, isError: m.isError,
            result: { content: m.content, details: m.details } });
        }
      }
    } finally {
      this.replaying = false;
    }
  }

  // Earlier conversations of this folder, shown as a picker in the panel.
  async pickSession() {
    await this.reveal();
    const client = await this.ensureClient();
    const state = await this.track(client);
    if (!state?.sessionFile) return;
    const dir = path.dirname(state.sessionFile);
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(dir, f)); } catch {}
    const list = files
      .map((file) => ({ file, mtime: fs.statSync(file).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 100)
      .map(({ file, mtime }) => {
        const s = sessionSummary(file);
        return s && { file, title: s.title, when: mtime, current: path.resolve(file) === path.resolve(state.sessionFile) };
      })
      .filter(Boolean);
    if (!list.length) return this.post({ type: 'notice', text: 'No earlier conversations in this folder yet.' });
    this.post({ type: 'sessions', list });
  }

  async openSession(file) {
    const client = await this.ensureClient();
    this.closeDialogs();
    this.busy = false;
    this.notes = [];
    try {
      client.abort();
      const r = await client.request({ type: 'switch_session', sessionPath: file });
      if (!r?.cancelled) this.replay((await client.request({ type: 'get_messages' })).messages);
      await this.track(client);
    } catch (e) {
      this.post({ type: 'error', text: `Could not open the conversation: ${e.message}` });
    }
    this.post({ type: 'idle' });
  }

  setModel(m) {
    if (!m) return;
    this.modelName = `${m.provider}/${m.id}`;
    this.post({ type: 'model', name: this.modelName });
    // Recently used models, newest first, for the top of the model picker.
    const recent = this.recentModels();
    if (recent[0] !== this.modelName) this.context.globalState?.update('ompChat.recentModels', [this.modelName, ...recent.filter((x) => x !== this.modelName)].slice(0, 5));
  }

  // ---- model favourites ("your models"): pinned in the picker and managed in the Models sheet ----
  favoriteModels() { return this.context.globalState?.get('ompChat.favoriteModels') || []; }
  recentModels() { return this.context.globalState?.get('ompChat.recentModels') || []; }

  async setFavorites(list) {
    await this.context.globalState?.update('ompChat.favoriteModels', [...new Set(list)]);
  }

  async toggleFavorite(id) {
    const fav = this.favoriteModels();
    await this.setFavorites(fav.includes(id) ? fav.filter((x) => x !== id) : [...fav, id]);
  }

  async moveFavorite(id, dir) {
    const fav = this.favoriteModels();
    const i = fav.indexOf(id), j = i + dir;
    if (i < 0 || j < 0 || j >= fav.length) return;
    [fav[i], fav[j]] = [fav[j], fav[i]];
    await this.setFavorites(fav);
    return this.showModelsSheet();
  }

  // The Models sheet: your favourite models in your order, each one click away.
  // The model manager: your models (ordered) on top, then every model omp can run, each with ☆ and Use.
  async showModelsSheet() {
    await this.reveal();
    let all = [];
    try { all = await this.modelList(); }
    catch (e) { this.post({ type: 'error', text: `Could not list models: ${e.message}` }); }
    const names = new Map(all.map((x) => [x.id, x.name]));
    this.post({ type: 'modelsSheet', current: this.modelName || vscode.workspace.getConfiguration('ompChat').get('model'),
      favorites: this.favoriteModels().map((id) => ({ id, name: names.get(id) || '' })), all });
  }

  onRecord(r) {
    switch (r.type) {
      case 'response':
        if (r.success === false) {
          this.post({ type: 'error', text: r.error || `${r.command} failed` });
          this.post({ type: 'idle' });
          this.busy = false;
        }
        break;
      case 'agent_start':
        this.wroteText = false;
        this.turnText = '';
        this.changedFiles = false;
        this.post({ type: 'busy' });
        break;
      case 'message_update': {
        const e = r.assistantMessageEvent;
        if (e?.type === 'text_delta') { this.wroteText = true; this.turnText = (this.turnText || '') + e.delta; this.post({ type: 'text', delta: e.delta }); }
        else if (e?.type === 'thinking_delta') this.post({ type: 'thinking', delta: e.delta });
        break;
      }
      case 'message_end':
        if (r.message?.role === 'assistant' && !this.replaying && r.message.stopReason !== 'error') this.countRequest();
        if (r.message?.role === 'assistant') {
          // API failures (401, rate limit, network) arrive only here, as stopReason "error".
          if (r.message.stopReason === 'error') {
            const hint = r.message.errorStatus === 401 ? ' (Run "OMP Chat: Manage API Keys".)' : '';
            // Drop omp's debug-log path; turn a link in the message (settings, billing…) into a button.
            const shown = (r.message.errorMessage || 'Model request failed').replace(/\s*raw-http-request=\S+/g, '');
            const link = /https?:\/\/[^\s)]+/.exec(shown)?.[0]?.replace(/[.,;]+$/, '');
            const linkLabel = !link ? null : /privacy|region/i.test(link) ? 'Open privacy settings' : /billing|credit/i.test(link) ? 'Top up' : 'Open link';
            this.post({ type: 'error', text: shown + hint, actions: link ? [{ label: linkLabel, cmd: 'openUrl', arg: link }] : undefined });
            // Decide what to offer once omp has given up on its own retries (agent_end).
            const msg = r.message.errorMessage || '';
            const slug = /use this slug instead:\s*([\w.\-/:]+[\w])/i.exec(msg)?.[1];
            if (this.replaying) { /* old errors in a reopened conversation */ }
            else if (slug) { // e.g. OpenRouter retired a ":free" variant and names the paid one
              this.blocked = { kind: 'slug', model: `${(this.modelName || '').split('/')[0]}/${slug}` };
            }
            else if (/FreeUsageLimitError|free usage limit/i.test(msg)) { // per account: other keys won't help
              this.blocked = { kind: 'free', wait: retryAfter(msg) };
              // Remember it so the model picker can move this provider's free models out of the way.
              const ms = +(/retry-after-ms=(\d+)/.exec(msg)?.[1] || 0) || 5 * 3600e3;
              const prov = (this.modelName || '').split('/')[0];
              if (prov) this.context.globalState?.update(`ompChat.freeBlock.${prov}`, Date.now() + ms);
            }
            else if (r.message.errorStatus === 403 && /subscription/i.test(msg)) this.blocked = { kind: 'plan' };
            else if (keys.isQuotaError(r.message.errorStatus, msg)) { // try the next key
              this.quotaHit = true;
              // Out of money (402 / "insufficient balance") reads differently from a rate limit at the end.
              this.quotaReason = r.message.errorStatus === 402 || /insufficient (balance|credit)|top up|billing/i.test(msg)
                ? { kind: 'credit', url: /https?:\/\/\S+billing\S*/i.exec(msg)?.[0]?.replace(/[.)]+$/, '') } : { kind: 'limit' };
            }
          } else if (!this.replaying) {
            this.tried = null; // a request went through: the next quota hit starts a fresh rotation
          }
          this.post({ type: 'assistant_done' });
        }
        break;
      case 'tool_execution_start':
        if (/^(write|edit|bash|eval)$/.test(r.toolName)) this.changedFiles = true; // tools that can create or change files
        this.snapshotWrite(r);
        this.post({ type: 'tool_start', id: r.toolCallId, name: r.toolName, args: r.args });
        break;
      case 'tool_execution_end': {
        const text = (r.result?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
        this.post({ type: 'tool_end', id: r.toolCallId, isError: !!r.isError, output: text.slice(0, 4000), files: this.collectEdits(r) });
        // The agent's todo list: the todo tool returns the whole list after each change.
        if (!r.isError && r.toolName === 'todo' && Array.isArray(r.result?.details?.phases)) this.post({ type: 'todos', phases: r.result.details.phases });
        break;
      }
      case 'tool_execution_update': { // live output of a running tool (cumulative text so far)
        const live = (r.partialResult?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
        if (live) this.post({ type: 'tool_update', id: r.toolCallId, output: live.slice(-4000) });
        break;
      }
      case 'subagent_lifecycle':
        this.onSubagent(r.payload, null);
        break;
      case 'subagent_progress':
        this.onSubagent(r.payload, r.payload?.progress);
        break;
      case 'queue_update':
        if (!this.replaying) this.onQueue(r);
        break;
      case 'extension_ui_request':
        this.onUiRequest(r);
        break;
      case 'available_commands_update':
        this.commands = (r.commands || []).map((c) => ({ name: c.name, description: c.description || '', hint: c.input?.hint || '' }));
        this.post({ type: 'commands', list: this.commands });
        break;
      case 'command_output':
        this.post({ type: 'command_output', text: r.text });
        break;
      case 'config_update':
        this.setModel(r.model);
        break;
      // pi emits agent_settled after retries/compaction; omp may only emit
      // agent_end. Treat either as "idle"; a later agent_start flips back.
      case 'agent_settled':
      case 'agent_end':
        this.post({ type: 'idle' });
        this.busy = false;
        if (this.blocked) { this.explainBlocked(this.blocked); this.blocked = null; }
        else if (this.quotaHit) { this.quotaHit = false; this.rotateKey(); }
        else {
          this.refreshMeter();
          if (!this.replaying) this.checkClaimedFiles();
          // Plan mode: once the agent has written its plan, offer to carry it out (like Claude Code).
          if (this.wroteText && !this.replaying && this.planMode()) this.post({ type: 'planReady' });
        }
        this.wroteText = false;
        this.turnText = '';
        break;
    }
  }

  // Weaker models sometimes say "I created docs/x.md" without calling any tool. If the reply claims a file
  // was written, no file-changing tool ran this turn, and the file is not there, say so.
  // ponytail: heuristic on the reply text (English + Vietnamese verbs); a missed claim just shows nothing.
  checkClaimedFiles() {
    const text = this.turnText || '';
    if (this.changedFiles || !/\b(created|wrote|written|saved|updated)\b|đã (tạo|viết|ghi|lưu|cập nhật)/i.test(text)) return;
    const paths = [...new Set([...text.matchAll(/(?:[A-Za-z]:)?[\w.\-/\\]*[\w-]\.[A-Za-z][A-Za-z0-9]{0,5}\b/g)].map((m) => m[0]))]
      .filter((p) => /[/\\]/.test(p) || /\.(md|txt|json|ya?ml|js|ts|tsx|jsx|py|html|css|java|go|rs|cs|sh|toml)$/i.test(p))
      .slice(0, 8);
    const missing = paths.filter((p) => {
      const abs = path.isAbsolute(p) ? p : path.resolve(this.cwd || process.cwd(), p);
      try { return !fs.existsSync(abs); } catch { return false; }
    });
    // One entry per file: prefer the shortest spelling that still has a folder ("docs/x.md" over "x.md" or "d:/…/docs/x.md").
    const byName = new Map();
    for (const p of missing) {
      const key = path.basename(p).toLowerCase(), cur = byName.get(key);
      const score = (s) => (/[/\\]/.test(s) ? 0 : 1000) + (path.isAbsolute(s) ? 500 : 0) + s.length;
      if (!cur || score(p) < score(cur)) byName.set(key, p);
    }
    const shown = [...byName.values()];
    if (!shown.length) return;
    this.post({ type: 'notice', text: `The reply says files were written, but no file tool ran in this turn and ${shown.slice(0, 3).join(', ')} `
      + `${shown.length > 1 ? 'do' : 'does'} not exist. The model may only have described the change. Ask again (e.g. "use the write tool to create it"), or pick a stronger model.`,
      actions: [{ label: 'Choose another model', cmd: 'pickModel' }] });
  }

  planMode() {
    return vscode.workspace.getConfiguration('ompChat').get('approvalMode') === 'plan';
  }

  // Leave plan mode for `mode` (omp respawns on the same conversation), then ask the agent to carry out the plan.
  async executePlan(mode) {
    this.afterRestart = () => this.send('Go ahead and implement the plan above.', false);
    await vscode.workspace.getConfiguration('ompChat').update('approvalMode', mode, vscode.ConfigurationTarget.Global);
  }

  // ---- plugins & skills ----
  // Skills switched off in this workspace reach omp as a per-run config overlay (`--config`), so neither
  // Claude Code's nor omp's own settings are touched. Changing them respawns omp on the same conversation.
  disabledSkills() { return this.context.workspaceState?.get('ompChat.disabledSkills') || []; }
  autoSkills() { return this.context.workspaceState?.get('ompChat.autoSkills') ?? true; }

  overlayArgs() {
    const off = this.disabledSkills();
    const dir = (this.context.storageUri || this.context.globalStorageUri)?.fsPath;
    if (!off.length || !dir) return [];
    try {
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'omp-overlay.yml');
      fs.writeFileSync(file, plugins.overlayYaml(off));
      return ['--config', file];
    } catch (e) {
      this.post({ type: 'error', text: `Could not apply the plugin choices: ${e.message}` });
      return [];
    }
  }

  // Every skill omp can load here (`omp skill list --json`, run in the workspace), cached per session.
  async listSkills(force) {
    if (this.skillsCache && !force) return this.skillsCache;
    const ompPath = vscode.workspace.getConfiguration('ompChat').get('ompPath') || 'omp';
    const command = (ompPath === 'omp' && this.ompFallback?.omp) || ompPath;
    const out = await new Promise((resolve, reject) => {
      require('child_process').execFile(command, ['skill', 'list', '--json'], { cwd: this.cwd || process.cwd(), maxBuffer: 32e6, timeout: 60000 },
        (err, stdout) => (err ? reject(err) : resolve(stdout)));
    });
    this.skillsCache = plugins.groupSkills(JSON.parse(out).skills, this.cwd);
    return this.skillsCache;
  }

  async showPlugins(force) {
    await this.reveal();
    let groups;
    try { groups = await this.listSkills(force); }
    catch (e) { return this.post({ type: 'error', text: `Could not list plugins: ${e.message}` }); }
    const off = new Set(this.disabledSkills());
    this.post({ type: 'plugins', auto: this.autoSkills(),
      groups: groups.map((g) => ({ ...g, skills: g.skills.map((s) => ({ ...s, enabled: !off.has(s.name) })) })) });
  }

  async applyPlugins(disabled, auto) {
    const ws = this.context.workspaceState;
    const before = this.disabledSkills();
    await ws?.update('ompChat.autoSkills', !!auto);
    const changed = before.length !== disabled.length || before.some((n) => !disabled.includes(n));
    if (!changed) return this.post({ type: 'notice', text: `Auto-pick is ${auto ? 'on' : 'off'}.` });
    await ws?.update('ompChat.disabledSkills', disabled);
    await this.restart(); // omp reads the overlay at start; the conversation is resumed
    this.post({ type: 'notice', text: disabled.length ? `Plugins updated: ${disabled.length} skill${disabled.length > 1 ? 's' : ''} switched off in this workspace.`
      : 'Plugins updated: all skills are on.' });
  }

  // Auto-pick: up to 3 enabled skills matching the request, named to the model ahead of the message.
  async autoPick(text) {
    if (!this.autoSkills()) return [];
    let groups;
    try { groups = await this.listSkills(); } catch { return []; }
    const off = new Set(this.disabledSkills());
    return plugins.pickRelevant(text, groups.flatMap((g) => g.skills).filter((s) => !off.has(s.name)));
  }

  // ---- queued messages: sent while the agent works, delivered by omp when the current turn allows ----
  // omp reports its queues (queue_update); a message leaving them has been delivered, so it moves into the chat.
  onQueue(r) {
    const waiting = new Set([...(r.steering || []), ...(r.followUp || [])]);
    for (const [qid, q] of this.queued) {
      if (waiting.has(q.message)) continue;
      this.queued.delete(qid);
      this.post({ type: 'dequeued', qid });
      this.post({ type: 'user', text: q.text, context: q.context, images: q.images, turn: ++this.turnSeq });
    }
  }

  // "Send now": hand the message to the running turn instead of waiting for it to end.
  async promoteQueued(qid) {
    const q = this.queued.get(qid);
    if (!q || !this.client) return;
    try { await this.client.request({ type: 'promote_queued_message', message: q.message }); }
    catch (e) { this.post({ type: 'error', text: `Could not send it now: ${e.message}` }); }
  }

  // "Remove": take it back out of omp's queue; the text goes back into the message box.
  async removeQueued(qid) {
    const q = this.queued.get(qid);
    if (!q || !this.client) return;
    for (const queue of ['followUp', 'steering']) {
      try { await this.client.request({ type: 'remove_queued_message', message: q.message, queue }); break; } catch {}
    }
    this.queued.delete(qid);
    this.post({ type: 'unqueued', qid, text: q.text });
  }

  // ---- rewind (Claude Code's checkpoints): back to just before one of your messages ----
  // The conversation moves to a new omp session that ends before that message (omp "branch"); with
  // restoreCode, file changes the agent made from that message on are undone, newest first.
  async rewind(turn, restoreCode) {
    const client = await this.ensureClient();
    if (this.busy) client.abort();
    this.closeDialogs();
    try {
      const { entries, leafId } = await client.request({ type: 'get_entries' });
      const byId = new Map(entries.map((e) => [e.id, e]));
      const onPath = [];
      for (let id = leafId; id && byId.has(id); id = byId.get(id).parentId) onPath.unshift(byId.get(id));
      const users = onPath.filter((e) => e.type === 'message' && e.message?.role === 'user'
        && (splitUserText(textOf(e.message.content)).text || (Array.isArray(e.message.content) && e.message.content.some((p) => p.type === 'image'))));
      const target = users[turn - 1];
      if (!target) return this.post({ type: 'error', text: 'Could not find that message in the conversation any more.' });
      const restored = restoreCode ? this.undoSince(turn) : [];
      const r = await client.request({ type: 'branch', entryId: target.id });
      if (r?.cancelled) return;
      this.notes = restored.length ? [`[Note: the user rewound the conversation and restored these files to their earlier content: ${restored.join(', ')}.]`] : [];
      this.replay((await client.request({ type: 'get_messages' })).messages);
      await this.track(client);
      this.post({ type: 'prefill', text: splitUserText(r?.text || '').text });
      this.post({ type: 'notice', text: `Rewound to before that message${restored.length ? `; restored ${restored.join(', ')}` : ''}. Edit it below and send, or ask something else.` });
    } catch (e) {
      this.post({ type: 'error', text: `Rewind failed: ${e.message}` });
    }
    this.busy = false;
    this.post({ type: 'idle' });
  }

  // Undo the agent's file changes from turn `turn` on, newest first. Returns the files touched.
  undoSince(turn) {
    const done = new Set();
    const list = [...this.edits.entries()].filter(([, e]) => e.turn >= turn && !e.reverted).sort((a, b) => b[0] - a[0]);
    for (const [, e] of list) {
      try {
        if (e.created) fs.rmSync(e.path, { force: true });
        else { fs.mkdirSync(path.dirname(e.path), { recursive: true }); fs.writeFileSync(e.path, e.oldText); }
        e.reverted = true;
        done.add(vscode.workspace.asRelativePath(e.path));
      } catch (err) {
        this.post({ type: 'error', text: `Could not restore ${e.path}: ${err.message}` });
      }
    }
    return [...done];
  }

  // Limits that switching keys cannot fix: a provider's free allowance (shared by the whole account)
  // or a model that needs a subscription. Offer another model; the conversation carries over.
  explainBlocked(b) {
    const model = this.modelName || 'This model';
    if (b.kind === 'slug') {
      this.post({ type: 'error', text: `${model} is no longer available for free. The provider suggests the paid version, ${b.model}, `
        + 'which uses your credit with that provider. Switching keeps this conversation.',
        actions: [{ label: `Use ${b.model}`, cmd: 'setModel', arg: b.model }, { label: 'Choose another model', cmd: 'pickModel' }] });
    } else if (b.kind === 'free') {
      this.post({ type: 'error', text: `The free allowance for ${model} is used up${b.wait ? ` (it resets in about ${b.wait})` : ''}. `
        + 'Other keys of the same account share it, so OMP Chat did not switch keys. Pick another model to keep going in this conversation.',
        actions: [{ label: 'Choose another model', cmd: 'pickModel' }, { label: 'Usage & limits', cmd: 'usage' }] });
    } else {
      this.post({ type: 'error', text: `${model} needs an OpenCode Go subscription. Pick another model, or subscribe and keep this model.`,
        actions: [{ label: 'Choose another model', cmd: 'pickModel' }, { label: 'Open opencode.ai/go', cmd: 'openUrl', arg: 'https://opencode.ai/go' }] });
    }
  }

  // Quota hit: move to the provider's next saved key, respawn on the same conversation and retry the turn.
  // When every key is spent, offer another model (set_model keeps the conversation) or more keys.
  async rotateKey() {
    const p = keys.providerOf(this.modelName);
    const list = p ? await keys.loadKeys(this.context, p.env) : [];
    const cur = p && keys.activeKey(this.context, p.env, list);
    this.tried ??= new Set();
    if (cur) this.tried.add(cur.id);
    const next = p && keys.nextKey(list, cur?.id, this.tried);
    const reason = this.quotaReason || { kind: 'limit' };
    if (!next) {
      this.tried = null;
      this.quotaReason = null;
      const who = p ? (list.length > 1 ? `all ${list.length} saved ${keys.groupLabel(p.env)} keys` : `your ${keys.groupLabel(p.env)} key`) : 'this provider';
      if (reason.kind === 'credit') {
        this.post({ type: 'error', text: `No balance left on ${who}. Top up, or switch to a model from a provider that still has credit `
          + '(for example your OpenRouter key). Switching keeps this conversation.',
          actions: [{ label: 'Choose another model', cmd: 'pickModel' }, ...(reason.url ? [{ label: 'Top up', cmd: 'openUrl', arg: reason.url }] : []),
            { label: 'Manage keys', cmd: 'manageKeys' }] });
      } else {
        this.post({ type: 'error', text: `The rate or usage limit is reached on ${who}. Wait for the reset, add a key, or switch to another model `
          + 'to keep going in this conversation.',
          actions: [{ label: 'Choose another model', cmd: 'pickModel' }, { label: 'Manage keys', cmd: 'manageKeys' }, { label: 'Usage & limits', cmd: 'usage' }] });
      }
      return;
    }
    await keys.setActive(this.context, p.env, next.id);
    this.post({ type: 'notice', text: `${reason.kind === 'credit' ? 'No balance' : 'Limit reached'} on "${cur.label}". Switched to "${next.label}" and retrying…` });
    await this.restart();
    if (!this.client) return;
    this.client.prompt('/retry'); // omp re-runs the failed turn
    this.busy = true;
    this.post({ type: 'busy' });
  }

  // Stable id OpenCode asks for on its usage endpoint (x-opencode-session).
  installId() {
    const gs = this.context.globalState;
    let id = gs?.get('ompChat.installId');
    if (!id) { id = crypto.randomUUID(); gs?.update('ompChat.installId', id); }
    return id;
  }

  // ---- usage & limits ----
  // ponytail: counts only what this extension sends; omp used elsewhere is invisible here. The OpenRouter
  // key endpoint (shown when a key is saved) has the exact number.
  countRequest() {
    const gs = this.context.globalState;
    if (!gs) return;
    let d = gs.get(USAGE_DAY);
    if (d?.day !== utcDay()) d = { day: utcDay(), requests: 0, free: 0 };
    d.requests++;
    if (/:free$/.test(this.modelName || '')) d.free++;
    gs.update(USAGE_DAY, d);
  }

  today() {
    const d = this.context.globalState?.get(USAGE_DAY);
    return d?.day === utcDay() ? d : { day: utcDay(), requests: 0, free: 0 };
  }

  // Limits of the active key for the current model's provider.
  async account(force) {
    const p = keys.providerOf(this.modelName || vscode.workspace.getConfiguration('ompChat').get('model'));
    if (!p) return null;
    const provider = p.prefix.slice(0, -1);
    const k = keys.activeKey(this.context, p.env, await keys.loadKeys(this.context, p.env));
    const key = k?.key || process.env[p.env];
    // Cache for a minute: the meter refreshes after every turn.
    const cacheKey = `${provider}:${k?.id}`;
    if (!force && this.accountCache?.key === cacheKey && Date.now() - this.accountCache.at < 60000) return this.accountCache.data;
    const data = (await keys.fetchAccount(provider, key, this.installId())) || (key ? { provider, noApi: true } : { provider, needKey: true });
    this.accountCache = { key: cacheKey, at: Date.now(), data };
    return data;
  }

  // Compact numbers for the composer gauge: context fill, plan window or free requests today.
  async refreshMeter() {
    if (!this.client || !this.view) return;
    const [state, account] = await Promise.all([this.client.request({ type: 'get_state' }).catch(() => null), this.account()]);
    this.post({ type: 'meter', context: state?.contextUsage || null, free: /:free$/.test(this.modelName || ''),
      today: this.today(), freeQuota: account?.free_model_daily_requests || null, windows: account?.windows || null });
  }

  async showUsage() {
    const client = await this.ensureClient();
    const [stats, account] = await Promise.all([
      client.request({ type: 'get_session_stats' }).catch(() => null),
      this.account(true),
    ]);
    // Every saved key of this provider with its own limits, so the user can see which one has room.
    const p = keys.providerOf(this.modelName);
    let keyRows = [];
    if (p) {
      const list = await keys.loadKeys(this.context, p.env);
      const active = keys.activeKey(this.context, p.env, list);
      keyRows = await Promise.all(list.slice(0, 8).map(async (k) => ({
        id: k.id, env: p.env, label: k.label, mask: keys.mask(k.key), active: k.id === active?.id,
        account: k.id === active?.id ? account : await keys.fetchAccount(p.prefix.slice(0, -1), k.key, this.installId()),
      })));
    }
    this.view?.show?.(true);
    this.post({ type: 'usage', model: this.modelName, stats, today: this.today(), account, keys: keyRows,
      keyGroup: p ? keys.groupLabel(p.env) : null });
    this.refreshMeter();
  }

  async useKey(env, id) {
    await keys.setActive(this.context, env, id);
    await this.restart(); // keys reach omp through its environment; the conversation is resumed
    this.showUsage();
  }

  // Keys sheet in the panel, or straight to the add form when nothing is saved yet.
  async manageKeys() {
    const anyKey = (await Promise.all(keys.ENVS.map((e) => keys.loadKeys(this.context, e)))).some((l) => l.length);
    return anyKey ? this.showKeys() : this.addKeyForm(false);
  }

  // The write tool reports no before/after text, so keep the file as it was when the tool started.
  // ponytail: in "write"/"yolo" mode the file may already be written by the time this runs (no approval
  // pause); the diff then shows no change. A pre-execution hook in omp would make this exact.
  snapshotWrite(r) {
    if (this.replaying || r.toolName !== 'write' || typeof r.args?.path !== 'string' || typeof r.args?.content !== 'string') return;
    const abs = path.resolve(this.cwd || process.cwd(), r.args.path);
    let before;
    try { before = fs.readFileSync(abs, 'utf8'); } catch {}
    this.toolStarts.set(r.toolCallId, { args: r.args, abs, before });
  }

  // File changes from an edit/write result, registered for Diff / Revert.
  collectEdits(r) {
    const start = this.toolStarts.get(r.toolCallId);
    this.toolStarts.delete(r.toolCallId);
    if (r.isError) return [];
    const d = r.result?.details || {};
    let list = d.perFileResults || (d.path ? [d] : []);
    if (start) {
      list = [{ path: d.resolvedPath || start.abs, oldText: start.before ?? '', newText: start.args.content,
        op: start.before === undefined ? 'create' : 'update' }];
    }
    return list.map((f) => {
      const canDiff = typeof f.oldText === 'string' && typeof f.newText === 'string';
      const id = canDiff ? String(++this.editSeq) : null;
      if (id) this.edits.set(id, { path: f.path, oldText: f.oldText, newText: f.newText, created: f.op === 'create', turn: this.turnSeq });
      return { id, rel: vscode.workspace.asRelativePath(f.path), diff: (f.diff || '').slice(0, 20000) };
    });
  }

  provideTextDocumentContent(uri) {
    return this.edits.get(uri.query)?.oldText ?? '';
  }

  openDiff(id) {
    const e = this.edits.get(id);
    if (!e) return;
    const name = path.basename(e.path);
    const left = vscode.Uri.from({ scheme: ORIG_SCHEME, path: '/' + name, query: id });
    vscode.commands.executeCommand('vscode.diff', left, vscode.Uri.file(e.path), `${name} (before ↔ after omp edit)`);
  }

  async revert(id, force) {
    const e = this.edits.get(id);
    if (!e) return;
    const rel = vscode.workspace.asRelativePath(e.path);
    let current;
    try { current = fs.readFileSync(e.path, 'utf8'); } catch {}
    if (!force && (current ?? '') !== e.newText) {
      return this.post({ type: 'notice', text: `${rel} has changed since this edit. Undoing it now also discards those later changes.`,
        actions: [{ label: 'Undo anyway', cmd: 'revertForce', arg: id }] });
    }
    try {
      if (e.created) fs.rmSync(e.path, { force: true });
      else { fs.mkdirSync(path.dirname(e.path), { recursive: true }); fs.writeFileSync(e.path, e.oldText); }
    } catch (err) {
      return this.post({ type: 'error', text: `Undo failed: ${err.message}` });
    }
    e.reverted = true; // Rewind must not undo it a second time
    this.notes.push(`[Note: the user reverted your change to ${rel}; it is back to its previous content.]`);
    this.post({ type: 'reverted', id });
  }

  // Active editor's file, or its selection, offered as context for the next message.
  contextInfo() {
    const ed = vscode.window.activeTextEditor;
    if (!ed || ed.document.uri.scheme !== 'file') return null;
    const rel = vscode.workspace.asRelativePath(ed.document.uri);
    const sel = ed.selection;
    if (sel.isEmpty) return { label: rel, rel };
    const a = sel.start.line + 1;
    const b = sel.end.character === 0 && sel.end.line > sel.start.line ? sel.end.line : sel.end.line + 1;
    return { label: `${rel}:${a}-${b}`, rel, text: ed.document.getText(sel), lang: ed.document.languageId };
  }

  postContext() {
    const c = this.contextInfo();
    this.post({ type: 'context', label: shortLabel(c?.label) || null, full: c?.label || null, selection: !!c?.text });
  }

  // Workspace files for the "@" picker in the panel.
  async listFiles() {
    const files = await vscode.workspace.findFiles('**/*', '**/{node_modules,.git,dist,out,build}/**', 5000);
    this.post({ type: 'files', list: files.map((f) => vscode.workspace.asRelativePath(f).replace(/\\/g, '/')).sort() });
  }

  // Every model omp knows, for the model picker in the panel. Choosing one posts setModel.
  // The chat's model picker shows your models only (the webview filters); "Manage models…" shows them all.
  async pickModel() {
    await this.reveal();
    let list;
    try { list = await this.modelList(); }
    catch (e) { return this.post({ type: 'error', text: `Could not list models: ${e.message}` }); }
    this.post({ type: 'models', list, current: this.modelName || vscode.workspace.getConfiguration('ompChat').get('model') });
  }

  // Every model omp can run (it lists only providers it has a credential for), with badges, your models first.
  async modelList() {
    const { models } = await (await this.ensureClient()).request({ type: 'get_available_models' });
    const cur = this.modelName || vscode.workspace.getConfiguration('ompChat').get('model');
    // Free = no charge with just a key (OpenRouter ":free", OpenCode Zen "-free"). OpenCode Go models,
    // "-free" ones included, need the Go subscription.
    const plan = (id) => id.startsWith('opencode-go/');
    const free = (id) => /:free$/.test(id) || (id.startsWith('opencode-zen/') && /-free$/.test(id));
    // omp lists only models it holds a credential for (a saved key or its own login), so every entry can run.
    // Free models of a provider whose free allowance just ran out go last, with the time left.
    const usedUp = (id) => {
      const until = free(id) && this.context.globalState?.get(`ompChat.freeBlock.${id.split('/')[0]}`);
      return until > Date.now() ? retryAfter(`retry-after-ms=${until - Date.now()}`) : null;
    };
    // Your favourites first (in your order), then recently used, then the rest.
    const fav = this.favoriteModels(), recent = this.recentModels();
    const tier = (id) => (fav.includes(id) ? 0 : recent.includes(id) ? 1 : 2);
    const order = (id) => (fav.includes(id) ? fav.indexOf(id) : recent.indexOf(id));
    const list = models.map((m) => {
      const id = `${m.provider}/${m.id}`;
      return { id, name: m.name || '', free: free(id), plan: plan(id), usedUp: usedUp(id), favorite: fav.includes(id), recent: !fav.includes(id) && recent.includes(id) };
    }).sort((a, b) => tier(a.id) - tier(b.id) || (tier(a.id) < 2 ? order(a.id) - order(b.id) : 0)
      || !!a.usedUp - !!b.usedUp || (b.id === cur) - (a.id === cur) || b.free - a.free || a.id.localeCompare(b.id));
    this.modelsCache = list;
    return list;
  }

  async onConfigChange(e) {
    if (!e.affectsConfiguration('ompChat')) return;
    const cfg = vscode.workspace.getConfiguration('ompChat');
    this.post({ type: 'mode', mode: cfg.get('approvalMode') });
    if (RESTART_KEYS.some((k) => e.affectsConfiguration('ompChat.' + k))) return this.restart();
    if (e.affectsConfiguration('ompChat.model') && this.quietModel === cfg.get('model')) { this.quietModel = null; return; } // addKeyForm restarts
    if (e.affectsConfiguration('ompChat.model') && this.client) {
      const id = String(cfg.get('model'));
      const slash = id.indexOf('/');
      // set_model swaps the model inside the running omp, so the conversation carries on unchanged.
      const p = keys.providerOf(id);
      const hasKey = !!p && ((await keys.loadKeys(this.context, p.env)).length > 0 || !!process.env[p.env]);
      try {
        this.setModel(await this.client.request({ type: 'set_model', provider: id.slice(0, slash), modelId: id.slice(slash + 1) }));
      } catch (err) {
        // omp only lists models of providers that had a key when it started.
        if (p && hasKey) return this.restart(); // key added since: respawn on the new model, same conversation
        if (p) {
          return this.post({ type: 'notice', text: `${id} needs a ${p.label} key. Add one and the conversation continues on this model.`,
            actions: [{ label: `Add ${p.label} key`, cmd: 'manageKeys' }, { label: 'Choose another model', cmd: 'pickModel' }] });
        }
        return this.post({ type: 'error', text: `Could not switch to ${id}: ${err.message}` });
      }
      this.accountCache = null;
      this.refreshMeter();
    }
  }

  // omp blocks on select/confirm/input/editor until it gets extension_ui_response.
  async onUiRequest(r) {
    const w = vscode.window;
    switch (r.method) {
      case 'notify':
        this.post({ type: r.notifyType === 'error' ? 'error' : 'notice', text: r.message });
        return;
      case 'open_url':
        this.post({ type: 'notice', text: `omp wants to open ${r.url}`, actions: [{ label: 'Open', cmd: 'openUrl', arg: r.url }] });
        return;
      case 'cancel':
        this.dialogs.get(r.targetId)?.cancel();
        return;
      case 'select': case 'confirm': case 'input': case 'editor':
        break;
      default:
        return; // setWidget/setStatus/setTitle/set_editor_text: TUI cosmetics. 'ask' only comes after set_ask_dialog opt-in.
    }
    // Plan mode is read-only: deny every edit / command approval without asking.
    if (this.planMode() && r.method === 'select' && /^Allow tool:/.test(r.title || '')) {
      const deny = r.options.find((o) => /^deny/i.test(o)) || r.options[r.options.length - 1];
      this.client?.send({ type: 'extension_ui_response', id: r.id, value: deny });
      this.post({ type: 'notice', text: `Plan mode: blocked ${r.title.split('\n')[0].replace(/^Allow tool:\s*/, '')}. Approve the plan to let the agent make changes.` });
      return;
    }
    const client = this.client;
    let cancelled = false;
    let res;
    if (this.view) {
      // A card in the chat, like Claude Code's prompts: tool approvals (select), yes/no, and text answers.
      this.view.show?.(true);
      const text = r.method === 'input' || r.method === 'editor';
      const options = r.method === 'confirm' ? ['Yes', 'No'] : text ? ['Submit', 'Cancel'] : r.options;
      const input = text ? { multiline: r.method === 'editor', secret: !!r.secret, placeholder: r.placeholder || '', value: r.prefill || '' } : null;
      const value = await new Promise((resolve) => {
        this.dialogs.set(r.id, {
          answer: resolve,
          cancel: () => { cancelled = true; this.post({ type: 'dialog_close', id: r.id }); resolve(undefined); },
        });
        this.post({ type: 'dialog', id: r.id, title: [r.title, r.message].filter(Boolean).join('\n'), options, input });
      });
      this.dialogs.delete(r.id);
      this.refreshStatus();
      // Text cards answer { choice, text }; Cancel (or omp withdrawing the question) counts as cancelled.
      if (value === undefined || (text && value?.choice !== 'Submit')) res = { cancelled: true };
      else res = r.method === 'confirm' ? { confirmed: value === 'Yes' } : text ? { value: value.text } : { value };
    } else {
      const cts = new vscode.CancellationTokenSource();
      this.dialogs.set(r.id, { cancel: () => { cancelled = true; cts.cancel(); } });
      this.refreshStatus(); // panel closed: the status bar still shows "needs you"
      const opts = { title: r.title, ignoreFocusOut: true };
      try {
        if (r.method === 'confirm') {
          const pick = await w.showQuickPick(['Yes', 'No'], { ...opts, placeHolder: r.message }, cts.token);
          res = pick ? { confirmed: pick === 'Yes' } : { cancelled: true };
        } else if (r.method === 'select') {
          const items = r.options.map((label, i) => ({ label, detail: r.optionDetails?.[i]?.description }));
          const pick = await w.showQuickPick(items, opts, cts.token);
          res = pick ? { value: pick.label } : { cancelled: true };
        } else {
          // Only reached with the panel closed; the in-chat card has a multi-line box for 'editor'.
          const v = await w.showInputBox({ ...opts, placeHolder: r.placeholder, value: r.prefill, password: !!r.secret }, cts.token);
          res = v === undefined ? { cancelled: true } : { value: v };
        }
      } finally {
        this.dialogs.delete(r.id);
        this.refreshStatus();
        cts.dispose();
      }
    }
    // Skip if omp already gave up on it, or the session was replaced while the dialog was open.
    if (!cancelled && client && this.client === client) client.send({ type: 'extension_ui_response', id: r.id, ...res });
  }

  async send(text, withContext, images) {
    text = (text || '').trim();
    // Pasted / attached images from the webview: [{ mimeType, data (base64) }], at most 5 per message.
    images = (Array.isArray(images) ? images : [])
      .filter((i) => /^image\/(png|jpeg|gif|webp)$/.test(i?.mimeType) && typeof i.data === 'string')
      .slice(0, 5)
      .map((i) => ({ type: 'image', mimeType: i.mimeType, data: i.data }));
    if (!text && !images.length) return;
    if (!text) text = 'See the attached image.';
    const client = await this.ensureClient();
    if (!client) { this.post({ type: 'idle' }); return; }
    if (/^!\s*\S/.test(text)) return this.runShell(text.replace(/^!\s*/, ''));
    const isCommand = text.startsWith('/'); // slash commands must reach omp verbatim
    const ctx = withContext && !isCommand ? this.contextInfo() : null;
    let message = text;
    if (ctx) {
      const head = ctx.text ? `[Selection from ${ctx.label}]\n\`\`\`${ctx.lang}\n${ctx.text.slice(0, 20000)}\n\`\`\`` : `[Current file: ${ctx.rel}]`;
      message = `${head}\n\n${message}`;
    }
    const picked = isCommand ? [] : await this.autoPick(text);
    if (picked.length) message = `${plugins.skillHint(picked)}\n\n${message}`;
    if (this.planMode() && !isCommand) {
      message = `${PLAN_NOTE}\n\n${message}`;
    }
    if (this.notes.length && !isCommand) {
      message = `${this.notes.join('\n')}\n\n${message}`;
      this.notes = [];
    }
    const shown = { text, context: shortLabel(ctx?.label), images: images.map((i) => `data:${i.mimeType};base64,${i.data}`) };
    if (this.busy && !isCommand) {
      // The agent is working: omp holds this until the turn allows it. Shown as "Queued" until delivered.
      const qid = 'q' + ++this.qSeq;
      this.queued.set(qid, { message, ...shown });
      this.post({ type: 'queued', qid, ...shown });
      client.prompt(message, 'followUp', images);
      return;
    }
    // Slash commands are not conversation messages in omp, so they get no turn number (no Rewind).
    this.post({ type: 'user', ...shown, turn: isCommand ? 0 : ++this.turnSeq });
    if (picked.length) this.post({ type: 'notice', text: `Auto-picked skills: ${picked.map((s) => s.name).join(', ')}` });
    client.prompt(message, this.busy ? 'followUp' : undefined, isCommand ? undefined : images);
    this.busy = true;
    this.post({ type: 'busy' });
  }

  stop() {
    if (!this.client) return;
    this.client.abort();
    if (this.shellRunning) this.client.send({ type: 'abort_bash' });
  }

  // "!command" (Claude Code's bash mode): run it in the workspace through omp. omp records the command and its
  // output in the conversation, so the agent sees it with your next message.
  async runShell(command) {
    const id = 'sh' + ++this.shellSeq;
    this.post({ type: 'shell_start', id, command });
    this.shellRunning = (this.shellRunning || 0) + 1;
    try {
      const r = await this.client.request({ type: 'bash', command });
      this.post({ type: 'shell_end', id, output: (r.output || '').slice(-8000), exitCode: r.exitCode, cancelled: r.cancelled, truncated: r.truncated, timedOut: r.timedOut });
    } catch (e) {
      this.post({ type: 'shell_end', id, output: e.message, exitCode: -1 });
    } finally {
      this.shellRunning--;
    }
  }

  // "Run in terminal": the command in VS Code's own terminal, to watch or interact with it.
  runInTerminal(command) {
    if (!command) return;
    const t = vscode.window.terminals.find((x) => x.name === 'OMP Chat' && x.exitStatus === undefined)
      || vscode.window.createTerminal({ name: 'OMP Chat', cwd: this.cwd || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath });
    t.show();
    t.sendText(command);
  }

  // Fresh conversation in the same omp process; respawn only if that fails.
  async newSession() {
    this.closeDialogs();
    this.busy = false;
    this.notes = [];
    this.turnSeq = 0;
    this.queued.clear();
    this.subagents.clear();
    this.post({ type: 'clear' });
    this.post({ type: 'todos', phases: [] });
    if (this.client) {
      try {
        this.client.abort();
        await this.client.request({ type: 'new_session' });
        this.track(this.client);
        return;
      } catch {
        this.client?.dispose();
        this.client = null;
      }
    }
    if (this.view) this.ensureClient(); // keep omp running while the panel is open
  }

  // Respawn omp (new key / approval mode) and reopen the same conversation.
  async restart() {
    this.accountCache = null; // a new key changes what the provider reports
    const old = this.client;
    if (old) {
      try {
        const file = (await old.request({ type: 'get_state' })).sessionFile;
        if (file) this.resume = { file, replay: false }; // the chat log is still on screen
      } catch {}
      if (this.client === old) { this.client = null; old.dispose(); }
    }
    this.closeDialogs();
    this.busy = false;
    this.post({ type: 'idle' });
    if (this.view) await this.ensureClient();
    const next = this.afterRestart; // e.g. "implement the plan" once plan mode is left
    this.afterRestart = null;
    if (next && this.client) next();
  }

  closeDialogs() {
    for (const d of [...this.dialogs.values()]) d.cancel();
  }

  dispose() {
    if (this.client) this.client.dispose();
  }

  html(webview) {
    const uri = (f) => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', f));
    const nonce = crypto.randomBytes(16).toString('hex');
    // Inlined (not <img>) so main.css can recolor the mascot for the current VS Code theme.
    const mascot = fs.readFileSync(path.join(this.context.extensionUri.fsPath, 'media', 'mascot.svg'), 'utf8');
    return `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; img-src ${webview.cspSource} data: blob:; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${uri('vendor/codicons/codicon.css')}">
<link rel="stylesheet" href="${uri('main.css')}">
</head><body>
<template id="mascot">${mascot}</template>
<div id="sheet" hidden></div>
<div id="log">
  <div id="welcome">
    <div class="hero">${mascot}</div>
    <h2>OMP Chat</h2>
    <p>Ask about your code, or let the agent change it.<br>It asks before editing files or running commands.</p>
    <div id="suggest">
      <button class="chip" data-prompt="Explain what the current file does."><span class="codicon codicon-book"></span>Explain this file</button>
      <button class="chip" data-prompt="Find bugs in the current file and fix them."><span class="codicon codicon-bug"></span>Find and fix bugs</button>
      <button class="chip" data-prompt="Write unit tests for the current file."><span class="codicon codicon-beaker"></span>Write tests</button>
    </div>
    <p class="hint">Type <kbd>/</kbd> for commands · <kbd>@</kbd> to mention a file · <kbd>!</kbd> to run a shell command · paste or drop images<br><kbd>Shift+Tab</kbd> switches approval mode · <kbd>Esc</kbd> stops the agent</p>
  </div>
</div>
<div id="composer">
  <div id="popup" hidden></div>
  <div id="agents" hidden></div>
  <div id="todos" hidden></div>
  <div id="queue" hidden></div>
  <div id="box">
    <div id="ctx" hidden>
      <div id="ctxChip" class="chip" title="Sent with your next message.">
        <span id="ctxIcon" class="codicon codicon-file"></span><span id="ctxLabel"></span><button id="ctxEye" class="ctxx" title="Remove: don't send this file"><span class="codicon codicon-close"></span></button>
      </div>
    </div>
    <div id="thumbs" hidden></div>
    <div id="shellHint" hidden><span class="codicon codicon-terminal"></span>Shell command: runs in the workspace, and the output joins the conversation</div>
    <textarea id="input" rows="1" placeholder="Ask OMP, / for commands, ! to run a shell command"></textarea>
    <div id="tools">
      <button id="attach" class="icon" title="Mention a file (@)"><span class="codicon codicon-mention"></span></button>
      <button id="addImage" class="icon" title="Attach images (or paste / drop them)"><span class="codicon codicon-file-media"></span></button>
      <input id="imageFile" type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden>
      <select id="mode" title="When OMP must ask before running tools">
        <option value="always-ask">Ask before edits</option>
        <option value="always-ask-cached">Ask &amp; remember</option>
        <option value="write">Auto-approve edits</option>
        <option value="yolo">Full auto</option>
        <option value="plan">Plan (read-only)</option>
      </select>
      <span class="spacer"></span>
      <button id="meter" class="pill" title="Usage &amp; limits" hidden><span class="codicon codicon-dashboard"></span><span id="meterText"></span></button>
      <button id="model" class="pill" title="Change model"><span id="modelName"></span><span class="codicon codicon-chevron-down"></span></button>
      <button id="stop" class="icon send" hidden title="Stop (the agent keeps what it did so far)"><span class="codicon codicon-debug-stop"></span></button>
      <button id="send" class="icon send" title="Send (Enter)"><span class="codicon codicon-send"></span></button>
    </div>
  </div>
</div>
<script nonce="${nonce}" src="${uri('vendor/markdown-it.min.js')}"></script>
<script nonce="${nonce}" src="${uri('main.js')}"></script>
</body></html>`;
  }
}

function activate(context) {
  const provider = new ChatProvider(context);
  // Agent status in the status bar, visible even with the panel closed; click opens the chat.
  provider.statusItem = vscode.window.createStatusBarItem?.(vscode.StatusBarAlignment?.Left, 100);
  if (provider.statusItem) {
    provider.statusItem.name = 'OMP Chat status';
    provider.statusItem.command = 'ompChat.focus';
    context.subscriptions.push(provider.statusItem);
  }
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('ompChat.view', provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.workspace.registerTextDocumentContentProvider(ORIG_SCHEME, provider),
    vscode.commands.registerCommand('ompChat.focus', () =>
      vscode.commands.executeCommand('ompChat.view.focus')),
    vscode.commands.registerCommand('ompChat.newSession', () => provider.newSession()),
    vscode.commands.registerCommand('ompChat.stop', () => provider.stop()),
    vscode.commands.registerCommand('ompChat.pickModel', () => provider.pickModel()),
    vscode.commands.registerCommand('ompChat.history', () => provider.pickSession()),
    vscode.commands.registerCommand('ompChat.usage', () => provider.showUsage()),
    vscode.commands.registerCommand('ompChat.plugins', () => provider.showPlugins()),
    vscode.commands.registerCommand('ompChat.manageModels', () => provider.showModelsSheet()),
    vscode.commands.registerCommand('ompChat.setApiKey', () => provider.manageKeys()),
    vscode.workspace.onDidChangeConfiguration((e) => provider.onConfigChange(e)),
    vscode.window.onDidChangeActiveTextEditor(() => provider.postContext()),
    vscode.window.onDidChangeTextEditorSelection(() => provider.postContext()),
    { dispose: () => provider.dispose() },
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
