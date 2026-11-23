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
const review = require('./review');
const { SubagentMap } = require('./subagent-map');
const l10n = require('./media/l10n');
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
const RESTART_KEYS = ['approvalMode', 'ompPath', 'extraArgs', 'announceSteps', 'deniedCommands'];

// Appended to omp's system prompt (ompChat.announceSteps): say what you are about to do, as Claude Code does.
const ANNOUNCE_STEPS = `# Keeping the user informed
- Before your first tool call, say in one short sentence what you are about to do and why, e.g. "I'll read the config loader to see where the port is set."
- While working, write one short line when you learn something that changes the plan, find the cause, or move to a new phase of the work. Do not narrate every tool call or repeat yourself.
- When you finish, give a brief summary: what you changed or found, and anything left for the user to do.
- Write these updates in the language the user writes in.`;

const LAST_SESSION = 'ompChat.lastSession'; // workspaceState key: session file to resume on reload
// Webview messages that can change the agent status shown outside the chat.
// The UI dictionary for VS Code's display language (l10n/<lang>.json), or null for English.
function loadDictionary(dir) {
  const lang = String(vscode.env?.language || 'en').toLowerCase();
  for (const l of new Set([lang, lang.split('-')[0]])) {
    try { return JSON.parse(fs.readFileSync(path.join(dir, 'l10n', `${l}.json`), 'utf8')); } catch { /* no dictionary for this language */ }
  }
  return null;
}

const STATUS_EVENTS = new Set(['busy', 'idle', 'dialog', 'dialog_close', 'clear']);
const STATUS_UI = {
  blocked: { title: '🔴 waiting for you', badge: 'OMP Chat is waiting for your answer', bar: '$(bell-dot) OMP: needs you' },
  working: { title: '🟡 working', badge: null, bar: '$(sync~spin) OMP: working' },
  done: { title: '🔵 done', badge: 'OMP Chat finished while you were away', bar: '$(check) OMP: done' },
  idle: { title: '', badge: null, bar: '' },
};
// Thinking effort, as Claude Code's "Effort": always on, high unless you pick another. Older settings ("" = omp's
// default, "off") count as high.
const EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const thinkingLevel = (cfg) => (EFFORTS.includes(cfg.get('thinkingLevel')) ? cfg.get('thinkingLevel') : 'high');
const STATUS_RANK ={ blocked: 3, working: 2, done: 1, idle: 0 };
const STATUS_ICON = { blocked: '$(bell-dot)', working: '$(sync~spin)', done: '$(check)', idle: '$(circle-outline)' };
const TAB_TYPE = 'ompChat.tab';

// Every open chat (the sidebar's and each tab's), like herdr's panes: one status bar item sums them up.
const chats = new Set();
let statusItem = null;
const byStatus = () => [...chats].map((c) => ({ c, s: c.agentStatus() })).sort((a, b) => STATUS_RANK[b.s] - STATUS_RANK[a.s]);
function refreshStatusBar() {
  if (!statusItem) return;
  const all = byStatus();
  const top = all[0];
  if (!top || top.s === 'idle') return statusItem.hide();
  const { c, s } = top;
  const info = STATUS_UI[s];
  const subs = c.runningSubagents();
  const active = all.filter((x) => x.s !== 'idle').length;
  statusItem.text = c.t(info.bar) + (subs && s === 'working' ? ` · ${c.t(`${subs} subagent${subs > 1 ? 's' : ''}`)}` : '')
    + (active > 1 ? ` · ${c.t(`${active} chats`)}` : '');
  statusItem.tooltip = `${c.t(info.badge || 'OMP Chat is working')}${c.modelName ? ` · ${c.modelName}` : ''} ${c.t('(click to open)')}`;
  statusItem.backgroundColor = s === 'blocked' ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
  statusItem.show();
}

const windowFocused = () => vscode.window.state?.focused !== false;
const git = (args, cwd) => new Promise((resolve, reject) => require('child_process').execFile('git', args, { cwd, timeout: 60000 },
  (e, out, err) => (e ? reject(new Error(String(err || e.message).trim())) : resolve(String(out).trim()))));
// Prepended to each message in plan mode; edits and commands are also denied at approval time.
// The plan comes as numbered tasks with their files and dependencies, so it can also be split across subagents.
const PLAN_NOTE = '[Plan mode: investigate with read-only tools and reply with a concrete plan for the change, as numbered tasks. '
  + 'For each task give what to do, the files it touches, how to check it, how hard it is, and which other tasks it depends on. '
  + 'Do not edit files or run commands; such requests will be denied. The user will approve the plan before you carry it out.]';
// "Split across subagents" on the plan card: the main agent becomes the lead and hands each task to a subagent.
const DELEGATE_PLAN = 'Carry out the plan above by delegating it. Give each numbered task to its own subagent with your task tool, '
  + 'with a self-contained brief: the goal, the files it may change, constraints, and how to verify it. '
  + 'Run tasks that do not depend on each other in parallel; a task that depends on another, or changes the same files, runs after it. '
  + 'When they are done, review their changes together, fix conflicts or gaps yourself, run the relevant checks or tests, '
  + 'and finish with a short summary per task.';
const USAGE_DAY = 'ompChat.usageDay';       // globalState: model requests sent from this extension today (UTC)
const USAGE_URL_HINT = "Gateway's usage endpoint, {key} = the key; e.g. https://zyloris.com/api/gateway/subscription/check?apiKey={key}";
const utcDay = () => new Date().toISOString().slice(0, 10); // OpenRouter's free-model quota resets at 00:00 UTC

// Undo what send() prepends ("[Note: …]" lines, selection / current-file context, mentions, attachments) for display.
function splitUserText(text) {
  let context = null;
  text = String(text || '');
  text = text.replace(/^(\[Note: [^\n]*\]\n)+\n/, '');
  text = text.replace(/^\[Plan mode: [^\n]*\]\n\n/, '');
  text = text.replace(/^\[Skills that may help with this request[^\n]*\]\n\n/, '');
  let m = /^\[Selection from ([^\]\n]+)\]\n```[^\n]*\n[\s\S]*?\n```\n\n/.exec(text);
  if (!m) m = /^\[Current file: ([^\]\n]+)\]\n\n/.exec(text);
  if (m) { context = m[1]; text = text.slice(m[0].length); }
  const files = [];
  m = /^\[Files the user attached;[^\n]*:\n([\s\S]*?)\]\n\n/.exec(text);
  if (m) {
    for (const line of m[1].split('\n')) {
      const p = line.replace(/^- /, '').trim();
      if (p) files.push(p); // the full path, so its chip opens it; shortLabel shows the name
    }
    text = text.slice(m[0].length);
  }
  m = /^\[Attached files: ([^\]\n]+)\]\n\n/.exec(text);
  if (m) { files.push(...m[1].split(', ')); text = text.slice(m[0].length); }
  while ((m = /^\[(?:Problems|Terminal output|Uncommitted changes|Git log|Open editors|Web page|Unsaved changes)[^\]\n]*\]\n```[^\n]*\n[\s\S]*?\n```\n\n/.exec(text))) {
    text = text.slice(m[0].length);
  }
  return { text, context, files };
}

// Errors and warnings from VS Code's Problems panel as "path:line: [error] message (source)" lines.
function problemLines(entries, max = 60) {
  const out = [];
  for (const [uri, diags] of entries) {
    if (uri.scheme !== 'file') continue;
    const rel = vscode.workspace.asRelativePath(uri).replace(/\\/g, '/');
    for (const d of diags) {
      if (d.severity > 1) continue; // errors (0) and warnings (1) only
      out.push(`${rel}:${d.range.start.line + 1}: [${d.severity === 0 ? 'error' : 'warning'}] ${d.message.split('\n')[0]}${d.source ? ` (${d.source})` : ''}`);
    }
  }
  return out.length > max ? [...out.slice(0, max), `… and ${out.length - max} more`] : out;
}

const fence = (title, body) => `[${title}]\n\`\`\`\n${body.replace(/```/g, '``​`')}\n\`\`\``;

// "@https://…": the page as text. HTML loses its scripts, styles and tags; anything else is sent as is.
async function fetchPage(url, max = 20000) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000), headers: { 'User-Agent': 'omp-chat', Accept: 'text/html,text/plain,*/*' } });
    if (!res.ok) return fence(`Web page ${url}`, `Could not fetch it: HTTP ${res.status}.`);
    const type = res.headers.get('content-type') || '';
    if (!/text|json|xml|javascript/.test(type)) return fence(`Web page ${url}`, `Not text (${type || 'unknown type'}); not included.`);
    let body = await res.text();
    if (/html/.test(type)) {
      body = body.replace(/<(script|style|noscript|svg|head)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<\/(p|div|li|tr|h\d|pre|section|article|br)>|<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
        .replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
    }
    return fence(`Web page ${url}`, body.length > max ? `${body.slice(0, max)}\n… (cut at ${max.toLocaleString('en')} characters)` : body);
  } catch (e) {
    return fence(`Web page ${url}`, `Could not fetch it: ${e.name === 'TimeoutError' ? 'timed out after 15 s' : e.message}.`);
  }
}

// ---- allowed commands (ompChat.allowedCommands): run without asking ----
// Only omp's plain command prompt matches: one with a "Reason:" line (critical command, restricted folder,
// a prompt rule of yours) or anything after the command keeps asking. Like omp's own bash.patterns allow
// rules, a pattern must cover the whole command and never a line with shell control (&&, |, ;, $(…), > …).
const BASH_ASK = /^Allow tool: bash\nCommand: ([^\n]+)$/;
const SHELL_CONTROL = /[;&|`$<>(){}\\\r\n]|…/;
const words = (s) => s.trim().replace(/\s+/g, ' ');
const globRe = (p) => new RegExp('^' + words(p).split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
function allowedPattern(command, patterns) {
  if (SHELL_CONTROL.test(command)) return undefined;
  return patterns.find((p) => typeof p === 'string' && words(p) && globRe(p).test(words(command)));
}
// Denied patterns match the whole command or any part of a compound one (`cd x && rm -rf /`). omp enforces
// them itself (bashDenyRules); this is the second check on an approval card.
function deniedPattern(command, patterns) {
  const parts = [command, ...command.split(/&&|\|\||[;|&\n]|\$\(|`/)].map(words).filter(Boolean);
  return (Array.isArray(patterns) ? patterns : []).find((p) => typeof p === 'string' && words(p) && parts.some((c) => globRe(p).test(c)));
}
// What "Always allow" offers for a command: its first two words and anything after ("npm test*"), or the word alone.
function suggestPattern(command) {
  const w = words(command).split(' ');
  return w.length > 1 ? `${w[0]} ${w[1]}*` : w[0];
}

// A conversation (omp's get_messages) as Markdown, for "Export Chat".
function toMarkdown(messages, model) {
  const out = [`# OMP Chat${model ? ` · ${model}` : ''}`, `_Exported ${new Date().toLocaleString()}_`];
  for (const m of messages || []) {
    if (m.role === 'user') {
      const u = splitUserText(textOf(m.content));
      if (!u.text) continue;
      const ctx = [u.context, ...u.files].filter(Boolean).map(shortLabel);
      out.push(`## You${ctx.length ? `  \n_${ctx.join(', ')}_` : ''}`, u.text);
    } else if (m.role === 'assistant') {
      const parts = [];
      for (const p of m.content || []) {
        if (p.type === 'text' && p.text?.trim()) parts.push(p.text.trim());
        else if (p.type === 'toolCall') parts.push(`> 🔧 **${p.name}** ${toolArg(p.arguments)}`.trimEnd());
      }
      if (m.stopReason === 'error' && m.errorMessage) parts.push(`> ⚠ ${m.errorMessage.split('\n')[0]}`);
      if (parts.length) out.push('## OMP', parts.join('\n\n'));
    } else if (m.role === 'bashExecution') {
      out.push('## You (shell)', `\`\`\`sh\n$ ${m.command}\n${(m.output || '').trimEnd().slice(-4000)}\n\`\`\``);
    }
  }
  return out.join('\n\n') + '\n';
}

// ---- your own slash commands: Markdown prompt files omp loads from these folders ----
function commandDirs(cwd) {
  const home = os.homedir();
  return [
    cwd && { dir: path.join(cwd, '.omp', 'commands'), scope: 'project' },
    cwd && { dir: path.join(cwd, '.claude', 'commands'), scope: 'project · .claude' },
    { dir: path.join(home, '.omp', 'agent', 'commands'), scope: 'all projects' },
    { dir: path.join(home, '.claude', 'commands'), scope: 'all projects · .claude' },
  ].filter(Boolean);
}

// Supports both top-level *.md and nested folders ("dir:name"), matching omp's own command loader.
function listCommandFiles(cwd) {
  const out = [];
  const walk = (baseDir, relDir, scope) => {
    let entries = [];
    try { entries = fs.readdirSync(path.join(baseDir, relDir), { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (ent.isDirectory() && !ent.name.startsWith('.')) {
        walk(baseDir, relDir ? `${relDir}/${ent.name}` : ent.name, scope);
      } else if (ent.isFile() && ent.name.endsWith('.md')) {
        const file = path.join(baseDir, relDir, ent.name);
        let text = '';
        try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
        const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
        const field = (k) => fm && new RegExp(`^${k}:\\s*(.*)$`, 'm').exec(fm[1])?.[1].trim().replace(/^["']|["']$/g, '');
        const body = fm ? text.slice(fm[0].length) : text;
        const description = field('description') || body.split('\n').find((l) => l.trim())?.trim().slice(0, 80) || '';
        const base = ent.name.slice(0, -3);
        const name = relDir ? `${relDir.replace(/\//g, ':')}:${base}` : base;
        out.push({ name, file, scope, description, hint: field('argument-hint') || field('argumentHint') || '' });
      }
    }
  };
  for (const { dir, scope } of commandDirs(cwd)) walk(dir, '', scope);
  return out;
}

// ---- custom subagents: Markdown agent definitions omp loads from .omp/agents and ~/.omp/agent/agents ----
function agentDirs(cwd) {
  const home = os.homedir();
  return [
    cwd && { dir: path.join(cwd, '.omp', 'agents'), scope: 'project' },
    cwd && { dir: path.join(cwd, '.claude', 'agents'), scope: 'project · .claude' },
    { dir: path.join(home, '.omp', 'agent', 'agents'), scope: 'all projects' },
    { dir: path.join(home, '.claude', 'agents'), scope: 'all projects · .claude' },
  ].filter(Boolean);
}

function listAgentFiles(cwd) {
  const out = [];
  for (const { dir, scope } of agentDirs(cwd)) {
    let names = [];
    try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.md')); } catch { continue; }
    for (const f of names) {
      const file = path.join(dir, f);
      let text = '';
      try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
      const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
      const field = (k) => fm && new RegExp(`^${k}:\\s*(.*)$`, 'm').exec(fm[1])?.[1].trim().replace(/^["']|["']$/g, '');
      const body = fm ? text.slice(fm[0].length) : text;
      const description = field('description') || body.split('\n').find((l) => l.trim())?.trim().slice(0, 80) || '';
      out.push({ name: field('name') || f.slice(0, -3), file, scope, description, model: field('model') || '' });
    }
  }
  return out;
}

function agentFileText({ name, description, model, prompt }) {
  const q = (s) => JSON.stringify(String(s).replace(/\r?\n/g, ' ').trim());
  const fm = [name && `name: ${q(name)}`, description && `description: ${q(description)}`, model && `model: ${q(model)}`].filter(Boolean);
  return `${fm.length ? `---\n${fm.join('\n')}\n---\n\n` : ''}${String(prompt).trim()}\n`;
}

// Recursively scan a directory (used for git worktree @ mentions where workspace.findFiles points at the main repo).
function walkWorktreeFiles(root, max = 5000) {
  const out = [];
  const SKIP = new Set(['node_modules', '.git', 'dist', 'out', 'build']);
  const walk = (dir, rel) => {
    if (out.length >= max) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= max) break;
      if (e.isDirectory()) {
        if (!SKIP.has(e.name)) walk(path.join(dir, e.name), rel ? `${rel}/${e.name}` : e.name);
      } else if (e.isFile()) {
        out.push(rel ? `${rel}/${e.name}` : e.name);
      }
    }
  };
  walk(root, '');
  return out.sort();
}

// Terminal Shell Integration buffer (VS Code 1.93+): captures recent command output per terminal without touching clipboard.
const terminalBuffers = new WeakMap();
function captureTerminalExecution(term, stream, commandLine) {
  const chunks = [];
  if (commandLine) chunks.push(`$ ${commandLine}\n`);
  (async () => {
    try {
      for await (const data of stream) {
        chunks.push(String(data));
        if (chunks.length > 400) chunks.splice(0, chunks.length - 400);
        const prev = terminalBuffers.get(term) || '';
        const merged = (prev + data).slice(-24000);
        terminalBuffers.set(term, merged);
      }
    } catch {}
  })();
}

function commandFileText({ description, hint, prompt }) {
  const q = (s) => JSON.stringify(String(s).replace(/\r?\n/g, ' ').trim());
  const fm = [description && `description: ${q(description)}`, hint && `argument-hint: ${q(hint)}`].filter(Boolean);
  return `${fm.length ? `---\n${fm.join('\n')}\n---\n\n` : ''}${String(prompt).trim()}\n`;
}

// "/mcp list" output: "name | stdio | enabled | npx … [user]" per server.
function parseMcpList(text) {
  return String(text || '').split('\n').map((l) => /^(\S+) \| (\S+) \| (enabled|disabled) \| (.*) \[(user|project)\]$/.exec(l.trim()))
    .filter(Boolean).map(([, name, type, state, location, scope]) => ({ name, type, enabled: state === 'enabled', location, scope }));
}

// The one argument worth showing for a tool call: a path, a command or a pattern.
function toolArg(a) {
  if (!a || typeof a !== 'object') return '';
  const v = a.path || a.file_path || a.command || a.pattern || a.query || a.url || '';
  return v ? `\`${String(v).split('\n')[0].slice(0, 200)}\`` : '';
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
// file:// URIs dragged into the panel from VS Code's Explorer or tabs -> paths the agent can read.
function droppedPaths(uris) {
  return (Array.isArray(uris) ? uris : []).slice(0, 10)
    .map((u) => { try { return vscode.Uri.parse(String(u)); } catch { return null; } })
    .filter((u) => u?.scheme === 'file' && fs.existsSync(u.fsPath))
    .map((u) => ({ path: u.fsPath, name: path.basename(u.fsPath), label: vscode.workspace.asRelativePath(u) }));
}

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

// "src/a.ts:12:3", "src/a.ts#L12-L20" or "src/a.ts" -> { file, line, col }.
function parseFileRef(ref) {
  const m = /^(.*?)(?::(\d+)(?:-\d+|:(\d+))?|#L(\d+)(?:-L?\d+)?)?$/.exec(String(ref).trim()); // file:10-20 opens at 10
  return { file: m[1], line: +(m[2] || m[4] || 0), col: +(m[3] || 0) };
}

// omp's session files start with a space-padded title line it rewrites in place; we do the same, at the same length,
// so the lines omp appends meanwhile are never touched. Returns null if the title does not fit.
function titleHeader(oldLine, title) {
  let h;
  try { h = JSON.parse(oldLine); } catch { return null; }
  if (h?.type !== 'title') return null;
  const base = { ...h, title, updatedAt: new Date().toISOString(), pad: '' };
  const fill = Buffer.byteLength(oldLine) - Buffer.byteLength(JSON.stringify(base));
  return fill < 0 ? null : JSON.stringify({ ...base, pad: ' '.repeat(fill) });
}

// Markdown fence names -> VS Code language ids, for "New file" from a code block.
const LANG_IDS = { js: 'javascript', jsx: 'javascriptreact', ts: 'typescript', tsx: 'typescriptreact', py: 'python', sh: 'shellscript',
  bash: 'shellscript', zsh: 'shellscript', shell: 'shellscript', ps1: 'powershell', pwsh: 'powershell', md: 'markdown', yml: 'yaml',
  rs: 'rust', cs: 'csharp', rb: 'ruby', kt: 'kotlin', 'c++': 'cpp', golang: 'go' };

let chatIdSeq = 0;

class ChatProvider {
  // opts.tab: a chat in an editor tab (its own omp; does not take over the sidebar's last conversation).
  // opts.worktree: { top, branch, base, path, cwd } when the tab works in its own git worktree.
  constructor(context, opts = {}) {
    this.id = 'c' + ++chatIdSeq;
    this.context = context;
    this.tab = !!opts.tab;
    this.title = opts.title || 'OMP Chat';
    this.worktree = opts.worktree || null;
    this.modelOverride = null;   // per-tab model override (does not affect other tabs)
    this.modeOverride = null;    // per-tab approval mode override
    this.dictionary = loadDictionary(context.extensionUri?.fsPath || '');
    this.dict = l10n.compile(this.dictionary);
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
    this.taskCalls = new Map();  // `task` tool call id made inside a subagent -> that subagent's id (nesting)
    this.lead = null;            // { task, model, startedAt, endedAt } of your latest message, for the subagent map
    this.map = null;             // the Subagents tab (subagent-map.js), opened on demand
    this.subSeq = 0;
    this.qSeq = 0;
    this.pinned = [];            // files you attached to every message until removed (workspace-relative)
    this.turnUsage = null;       // tokens and cost summed over one agent turn
    this.sessionCost = 0;        // cumulative session cost for budget alerts
    this.budgetWarned = false;
    this.favChanged = false;     // true when ★ models changed since omp started
    this.quietChain = Promise.resolve();
    this.meterTimer = null;
    this.reviewSub = review.onChange(() => this.postReview());
    this.newReadyPromise();
  }

  effectiveModel() {
    return this.modelOverride || this.modelName || vscode.workspace.getConfiguration('ompChat').get('model');
  }

  effectiveMode() {
    return this.modeOverride || vscode.workspace.getConfiguration('ompChat').get('approvalMode');
  }

  // UI text in VS Code's language when there is a dictionary for it (English otherwise).
  t(text) { return l10n.translate(this.dict, text) ?? text; }

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
    view.onDidDispose(() => {
      this.view = null;
      clearInterval(this.meterTimer);
      this.meterTimer = null;
    });
    view.onDidChangeVisibility?.(() => { // looking at the panel clears "done, not seen yet"
      // and brings the quota up to date (at most one provider call a minute: account() caches)
      if (view.visible) { this.unseenDone = false; this.refreshStatus(); this.refreshMeter(); }
    });
    // Refresh gateway / plan quota every 5 minutes while visible (so rolling windows update on their own).
    clearInterval(this.meterTimer);
    this.meterTimer = setInterval(() => { if (this.view?.visible) this.refreshMeter(); }, 5 * 60e3);
    if (this.meterTimer.unref) this.meterTimer.unref();
    this.boot();
  }

  // First use: ask once for a provider + key, then start omp right away instead of on the first message.
  // Dismissing is fine: omp may have its own login, and a 401 later points to "Set API Key".
  async boot() {
    this.pruneAttachments();
    const saved = await keys.envFor(this.context);
    const hasKey = Object.keys(saved).length > 0 || PROVIDERS.some((p) => process.env[p.env]);
    if (!hasKey && !this.context.globalState?.get('ompChat.keyPrompted')) {
      await this.context.globalState?.update('ompChat.keyPrompted', true);
      this.addKeyForm(true); // in the panel, alongside omp starting up
    }
    // Pick up where the last window left off (New starts a fresh one). Tabs bring their own (see openTab).
    const last = this.tab ? null : this.context.workspaceState.get(LAST_SESSION);
    if (!this.client && last && sessionSummary(last)) this.resume = { file: last, replay: true };
    await this.ensureClient();
    this.listSkills().catch(() => {}); // warm the skill list so auto-pick does not delay the first message
  }

  // Remove uploaded attachment folders older than 30 days or past 200 MB total.
  pruneAttachments(forceAll = false) {
    const root = this.context.globalStorageUri?.fsPath && path.join(this.context.globalStorageUri.fsPath, 'attachments');
    if (!root || !fs.existsSync(root)) return 0;
    let removed = 0;
    try {
      const cutoff = Date.now() - 30 * 864e5;
      const dirs = fs.readdirSync(root).map((name) => {
        const full = path.join(root, name);
        try {
          const st = fs.statSync(full);
          if (!st.isDirectory()) return null;
          let bytes = 0;
          for (const f of fs.readdirSync(full)) { try { bytes += fs.statSync(path.join(full, f)).size; } catch {} }
          return { full, mtime: st.mtimeMs, bytes };
        } catch { return null; }
      }).filter(Boolean).sort((a, b) => a.mtime - b.mtime); // oldest first
      let total = dirs.reduce((s, d) => s + d.bytes, 0);
      for (const d of dirs) {
        if (forceAll || d.mtime < cutoff || total > 200e6) {
          try { fs.rmSync(d.full, { recursive: true, force: true }); total -= d.bytes; removed++; } catch {}
        }
      }
    } catch {}
    return removed;
  }

  post(msg) {
    if (this.view) this.view.webview.postMessage(msg);
    if (STATUS_EVENTS.has(msg.type)) this.onStatusEvent(msg.type);
  }

  // ---- agent status at a glance (like herdr's dots): panel title, Activity Bar badge, status bar ----
  // 🔴 waiting for you (an approval or question is open) · 🟡 working · 🔵 done while you weren't looking · 🟢 idle
  onStatusEvent(type) {
    if (type === 'busy') { this.working = true; this.unseenDone = false; }
    if (type === 'idle') {
      if (this.lead && !this.lead.endedAt) { this.lead.endedAt = Date.now(); this.map?.update(); }
      if (this.working && !this.view?.visible) this.unseenDone = true;
      if (this.working && !windowFocused()) this.notify('done');
      this.working = false;
    }
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
    const s = fresh ? { id, key: `${id}#${++this.subSeq}`, startedAt: Date.now(), endedAt: null, steps: [] } : prev;
    // assignment = what the parent asked for; task = that wrapped in omp's generic preamble
    const task = p.description || prog?.description || p.assignment || prog?.assignment || p.task || prog?.task || '';
    Object.assign(s, {
      agent: p.agent || prog?.agent || s.agent, parent: p.parentToolCallId || s.parent, detached: p.detached ?? s.detached,
      sessionFile: p.sessionFile || s.sessionFile, task: summaryLine(task) || s.task || '', status: prog?.status || LIFE[p.status] || s.status || 'running',
    });
    // Spawned by a task call of another subagent (seen in its events), else by the lead.
    s.parentAgent = (s.parent && this.taskCalls.get(s.parent)) || null;
    if (prog) {
      Object.assign(s, { intent: prog.lastIntent || s.intent, model: prog.resolvedModel || s.model, tool: prog.currentTool, toolArgs: prog.currentToolArgs,
        tools: prog.toolCount, tokens: prog.tokens, ms: prog.durationMs, cost: prog.cost });
      if (Array.isArray(prog.recentTools)) { // omp: newest first, at most 5
        s.steps = prog.recentTools.slice(0, 5).reverse().map((t) => ({ tool: String(t.tool || ''), args: String(t.args || '').slice(0, 120) }));
      }
    }
    if (s.status !== 'running') s.endedAt ??= Date.now();
    this.subagents.set(id, s);
    this.post({ type: 'subagent', ...s });
    this.refreshStatus();
    this.map?.update();
    this.map?.agentActivity(id);
  }

  // A subagent's own session events (subscription level "events"). Only two things matter here: its `task` calls,
  // so the agents they spawn sit under it on the map, and that it moved, so an open chat pane refreshes.
  onSubagentEvent(p) {
    const e = p?.event;
    if (!p?.id || !e) return;
    if (e.type === 'tool_execution_start' && e.toolName === 'task' && e.toolCallId) this.taskCalls.set(e.toolCallId, p.id);
    this.map?.agentActivity(p.id);
  }

  // What the Subagents tab draws: the lead (your latest message) and the subagents of this run, i.e. started since
  // that message or still running from an earlier one.
  mapState() {
    const since = this.lead?.startedAt || 0;
    const pick = ({ id, agent, task, status, model, intent, tool, toolArgs, tools, steps, tokens, cost, ms, startedAt, endedAt, parentAgent }) =>
      ({ id, agent, task, status, model, intent, tool, toolArgs, tools, steps, tokens, cost, ms, startedAt, endedAt, parentAgent });
    const agents = [...this.subagents.values()].filter((s) => s.status === 'running' || s.startedAt >= since);
    return { lead: this.lead, agents: agents.map(pick), now: Date.now() };
  }

  async stopAllSubagents(onError) {
    const running = [...this.subagents.values()].filter((s) => s.status === 'running');
    await Promise.all(running.map((s) => this.subagentControl('stop', s.id, '', onError)));
  }

  // The subagent's own conversation (works after it finished too), simplified for the map's chat pane.
  // The first user message is its task; later ones are what you sent it.
  async transcriptData(id) {
    const s = this.subagents.get(id);
    if (!s || !this.client) throw new Error('it is no longer tracked');
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
      if (m.role === 'user') messages.push({ role: messages.some((x) => x.role === 'task') ? 'you' : 'task', text: textOf(m.content).slice(0, 6000) });
      else if (m.role === 'assistant') {
        const tools = (m.content || []).filter((c) => c.type === 'toolCall')
          .map((c) => ({ name: c.name, detail: String(c.arguments?.i || c.arguments?.path || c.arguments?.command || c.arguments?.pattern || '').slice(0, 120) }));
        messages.push({ role: 'assistant', text: textOf(m.content), tools });
      } else if (m.role === 'toolResult') {
        messages.push({ role: 'tool', name: m.toolName, text: textOf(m.content).slice(0, 3000), isError: !!m.isError });
      }
    }
    return { id, agent: s.agent, status: s.status, messages };
  }

  // onError: where a failure is shown (the map passes its own); the chat otherwise.
  async subagentControl(kind, id, text, onError) {
    if (!this.client) return;
    try {
      if (kind === 'stop') await this.client.request({ type: 'cancel_subagent', subagentId: id });
      else if (text?.trim()) {
        await this.client.request({ type: 'steer_subagent', subagentId: id, message: text.trim() });
        this.post({ type: 'notice', text: `Sent to ${id}: ${text.trim()}` });
      }
    } catch (e) {
      const msg = `${kind === 'stop' ? 'Could not stop' : 'Could not message'} ${id}: ${e.message}`;
      if (onError) onError(msg); else this.post({ type: 'error', text: msg });
    }
  }

  // The Subagents tab of this chat (one per chat), on the agent `id` when given. Never opens by itself.
  openMap(id) {
    this.map ??= new SubagentMap(this);
    this.map.open(id);
  }

  refreshStatus() {
    const s = this.agentStatus();
    const info = STATUS_UI[s];
    if (this.view) {
      this.view.description = this.t(info.title);
      this.view.badge = info.badge ? { value: 1, tooltip: this.t(info.badge) } : undefined;
    }
    if (s === 'blocked' && this.lastStatus !== 'blocked' && !(windowFocused() && this.view?.visible)) this.notify('blocked');
    this.lastStatus = s;
    refreshStatusBar();
  }

  // A VS Code notification when the agent needs you or finished while you were elsewhere (herdr's alerts).
  notify(kind) {
    if (!vscode.workspace.getConfiguration('ompChat').get('notifications', true)) return;
    const open = this.t('Open');
    const text = `${this.title}: ${this.t(kind === 'blocked' ? 'waiting for your answer' : 'finished')}`;
    const show = kind === 'blocked' ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
    Promise.resolve(show?.call(vscode.window, text, open)).then((pick) => pick === open && this.reveal(), () => {});
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
    const initial = PROVIDERS.find((x) => x.label === providerLabel) || PROVIDERS[0];
    const v = await this.ask({
      title: intro ? 'Connect a model provider' : 'Add an API key',
      text: intro ? 'OMP Chat runs the omp agent with your own API key. Skip this if omp already has a login of its own.' : '',
      fields: [
        // The form shows where to get a key for the provider picked, from each option's link.
        { name: 'provider', label: 'Provider', type: 'select', value: initial.label,
          options: PROVIDERS.map((p) => ({ value: p.label, label: `${p.label} — ${p.description}`, link: p.url, defaultBaseUrl: p.defaultBaseUrl || '', optionalKey: !!p.optionalKey })) },
        { name: 'key', label: 'API key', type: 'password', placeholder: initial.optionalKey ? 'Optional for local servers (leave blank)' : 'Paste the key', required: !initial.optionalKey },
        { name: 'label', label: 'Name (optional)', placeholder: 'e.g. work, personal' },
        { name: 'baseUrl', label: 'Base URL (optional)', value: initial.defaultBaseUrl || '', placeholder: "Proxy or compatible endpoint; empty = the provider's own" },
        { name: 'usageUrl', label: 'Usage URL (optional)', placeholder: USAGE_URL_HINT },
      ],
      submit: 'Save key', cancel: intro ? 'Skip' : 'Cancel',
    });
    if (!v) {
      if (intro) this.post({ type: 'notice', text: 'Have a ChatGPT or Claude plan instead of a key? Sign in with it.', actions: [{ label: 'Sign in…', cmd: 'login' }] });
      return false;
    }
    const p = PROVIDERS.find((x) => x.label === v.provider) || PROVIDERS[0];
    const rawKey = v.key?.trim() || (p.optionalKey ? 'local' : '');
    if (!rawKey) {
      if (intro) this.post({ type: 'notice', text: 'Have a ChatGPT or Claude plan instead of a key? Sign in with it.', actions: [{ label: 'Sign in…', cmd: 'login' }] });
      return false;
    }
    const baseUrl = keys.normalizeBaseUrl(v.baseUrl || p.defaultBaseUrl), usageUrl = keys.normalizeBaseUrl(v.usageUrl);
    if (baseUrl === null || usageUrl === null) {
      this.post({ type: 'error', text: `"${baseUrl === null ? v.baseUrl : v.usageUrl}" is not an http(s) URL; the key was not saved.` });
      return false;
    }
    const count = (await keys.loadKeys(this.context, p.env)).length;
    const label = v.label?.trim() || (count ? `${p.label} ${count + 1}` : p.label);
    await keys.addKey(this.context, p.env, label, rawKey, baseUrl, p.prefix.slice(0, -1), usageUrl);
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

  async testSavedKey(env, id) {
    const list = await keys.loadKeys(this.context, env);
    const k = list.find((x) => x.id === id);
    if (!k) return;
    const p = PROVIDERS.find((x) => x.prefix === `${k.provider}/`) || PROVIDERS.find((x) => x.env === env);
    const provider = k.provider || p?.prefix.slice(0, -1) || '';
    const res = await keys.testKey(provider, k.key, k.baseUrl, k.usageUrl, this.installId());
    this.post({ type: 'keyTest', id, ok: res.ok, message: res.message });
  }

  async keyGroups() {
    return Promise.all(keys.ENVS.map(async (env) => {
      const list = await keys.loadKeys(this.context, env);
      const active = keys.activeKey(this.context, env, list);
      const ps = PROVIDERS.filter((p) => p.env === env);
      return { env, label: keys.groupLabel(env), providers: ps.map((p) => p.label), about: ps.map((p) => `${p.label}: ${p.description}`).join('\n'),
        keys: list.map((k) => ({ id: k.id, label: k.label, mask: keys.mask(k.key), baseUrl: k.baseUrl || '', usageUrl: k.usageUrl || '', active: k.id === active?.id })) };
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

  async editBaseUrl(env, id) {
    const list = await keys.loadKeys(this.context, env);
    const k = list.find((x) => x.id === id);
    if (!k) return;
    const providers = PROVIDERS.filter((p) => p.env === env);
    const current = providers.find((p) => p.prefix === `${k.provider}/`) || providers[0];
    const v = await this.ask({
      title: `Base URL of "${k.label}"`,
      text: "Empty = the provider's own endpoint.",
      fields: [
        // OpenCode Go and Zen share a key but not an endpoint: say which one the URL replaces.
        ...(providers.length > 1 ? [{ name: 'provider', label: 'Provider', type: 'select', value: current.label,
          options: providers.map((p) => ({ value: p.label, label: p.label })) }] : []),
        { name: 'baseUrl', label: 'Base URL (optional)', value: k.baseUrl || '', placeholder: "Proxy or compatible endpoint; empty = the provider's own" },
        { name: 'usageUrl', label: 'Usage URL (optional)', value: k.usageUrl || '', placeholder: USAGE_URL_HINT },
      ],
      submit: 'Save', cancel: 'Cancel',
    });
    if (!v) return;
    const baseUrl = keys.normalizeBaseUrl(v.baseUrl), usageUrl = keys.normalizeBaseUrl(v.usageUrl);
    if (baseUrl === null || usageUrl === null) {
      return this.post({ type: 'error', text: `"${baseUrl === null ? v.baseUrl : v.usageUrl}" is not an http(s) URL; the base URL was not changed.` });
    }
    const p = providers.find((x) => x.label === v.provider) || current;
    await keys.updateKeys(this.context, env, (l) => l.map((x) => {
      if (x.id !== id) return x;
      const { baseUrl: _, provider: __, usageUrl: ___, ...rest } = x;
      return { ...rest, ...(baseUrl && { baseUrl, provider: p.prefix.slice(0, -1) }), ...(usageUrl && { usageUrl }) };
    }));
    // omp only sees the base URL: a usage URL change needs no restart
    if (keys.activeKey(this.context, env, list)?.id === id && (baseUrl || '') !== (k.baseUrl || '')) await this.restart();
    else { this.accountCache = null; this.refreshMeter(); } // a new usage URL shows in the toolbar right away
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
    this.post({ type: 'mode', mode: this.effectiveMode() });
    this.post({ type: 'model', name: this.effectiveModel() });
    this.post({ type: 'thinking_level', level: thinkingLevel(vscode.workspace.getConfiguration('ompChat')) });
    this.post({ type: 'commands', list: this.commands });
    this.postContext();
    this.postSession();
    this.postReview();
    if (this.worktree) this.post({ type: 'worktree', branch: this.worktree.branch, path: this.worktree.path });
    // Always sync quota/meter once the webview is listening (fixes startup race before ready).
    this.refreshMeter();
  }

  postReview() {
    this.post({ type: 'reviewState', files: review.pendingSummary(this) });
  }

  async onWebviewMessage(m) {
    switch (m.type) {
      case 'ready': this.markReady(); return this.sync();
      case 'send': return this.send(m.text, m.withContext, m.images, [], m.files);
      case 'dropUris': return this.post({ type: 'attachPaths', list: droppedPaths(m.uris) });
      case 'stop': return this.stop();
      case 'retryTurn': return this.send('/retry');
      case 'new': return this.newSession();
      case 'dialogAnswer': return this.dialogs.get(m.id)?.answer?.(m.value);
      case 'formAnswer': return this.answerForm(m.id, m.values);
      case 'listFiles': return this.listFiles();
      case 'pickModel': return this.pickModel();
      case 'setModel': return this.switchModel(m.id);
      case 'history': return this.pickSession();
      case 'openSession': return this.openSession(m.file);
      case 'renameSession': return this.renameSession(m.file);
      case 'deleteSession': return this.deleteSession(m.file);
      case 'pinSession': return this.togglePinSession(m.file);
      case 'searchSessions': return this.searchSessions(String(m.query || ''));
      case 'openFile': return this.openFile(m.ref);
      case 'checkPaths': { // which `path` spans in a reply are real files, so the panel can make them links
        const refs = (Array.isArray(m.refs) ? m.refs : []).slice(0, 200).map(String);
        return this.post({ type: 'paths', refs, ok: refs.filter((r) => this.resolveFile(parseFileRef(r).file)) });
      }
      case 'insertCode': return this.insertCode(String(m.code ?? ''));
      case 'newFileFromCode': return this.newFileFromCode(String(m.code ?? ''), String(m.lang || ''));
      case 'setThinking':
        if (!EFFORTS.includes(m.level)) return;
        return vscode.workspace.getConfiguration('ompChat').update('thinkingLevel', m.level, vscode.ConfigurationTarget.Global);
      case 'usage': return this.showUsage();
      case 'setApiKey': return this.manageKeys();
      case 'login': return this.login();
      case 'addKey': return this.addKeyForm(false, m.provider);
      case 'testKey': return this.testSavedKey(m.env, m.id);
      case 'useKey': await this.useKey(m.env, m.id); return m.from === 'keys' ? this.showKeys() : this.showUsage();
      case 'renameKey': return this.renameKey(m.env, m.id, m.label);
      case 'removeKey': return this.removeKey(m.env, m.id);
      case 'editBaseUrl': return this.editBaseUrl(m.env, m.id);
      case 'rewind': return this.rewind(m.turn, !!m.restoreCode);
      case 'promoteQueued': return this.promoteQueued(m.qid);
      case 'removeQueued': return this.removeQueued(m.qid);
      case 'executePlan': return this.executePlan(m.mode, !!m.delegate);
      case 'plugins': return this.showPlugins(m.refresh);
      case 'runInTerminal': return this.runInTerminal(m.command);
      case 'openMap': return this.openMap(m.id);
      case 'subagentStop': return this.subagentControl('stop', m.id);
      case 'subagentSteer': return this.subagentControl('steer', m.id, m.text);
      case 'stopAllSubagents': return this.stopAllSubagents();
      case 'toggleFavorite': await this.toggleFavorite(m.id); return m.from === 'sheet' ? this.showModelsSheet() : undefined;
      case 'moveFavorite': return this.moveFavorite(m.id, m.dir);
      case 'applyFavorites': this.favChanged = false; await this.restart(); return this.post({ type: 'notice', text: 'Agent restarted with your updated model pool.' });
      case 'manageModels': return this.showModelsSheet();
      case 'pinFile': return this.pinFile(String(m.rel || ''));
      case 'unpinFile': return this.unpinFile(m.rel);
      case 'exportChat': return this.exportChat();
      case 'commandsSheet': return this.showCommands();
      case 'newCommand': return this.newCommand();
      case 'editCommand': return this.editCommand(m.file);
      case 'deleteCommand': return this.deleteCommand(m.file);
      case 'agentsSheet': return this.showAgents();
      case 'newAgent': return this.newAgent();
      case 'editAgent': return this.editAgent(m.file);
      case 'deleteAgent': return this.deleteAgent(m.file);
      case 'memorySheet': return this.showMemory();
      case 'addMemory': return this.addMemoryNote(m.note);
      case 'deleteMemory': return this.deleteMemoryLine(m.index);
      case 'openMemoryFile': return this.openMemoryFile();
      case 'rulesSheet': return this.showCommandRules();
      case 'addRule': return this.addCommandRule(m.kind, m.pattern);
      case 'removeRule': return this.removeCommandRule(m.kind, m.pattern);
      case 'mcp': return this.showMcp();
      case 'mcpAction': return this.mcpAction(m.kind, m.name);
      case 'addMcp': return this.addMcp();
      case 'openMcpConfig': return this.openMcpConfig(m.scope);
      case 'applyMcp': return this.applyMcp();
      case 'applyPlugins': return this.applyPlugins(Array.isArray(m.disabled) ? m.disabled : [], m.auto, Array.isArray(m.pinned) ? m.pinned : undefined);
      case 'reviewOpen': return this.openFile(m.path);
      case 'reviewCompare': return vscode.commands.executeCommand('ompChat.compareReview', vscode.Uri.file(m.path));
      case 'reviewAcceptFile': return review.decideAll(vscode.Uri.file(m.path), true);
      case 'reviewRejectFile': return review.decideAll(vscode.Uri.file(m.path), false);
      case 'reviewAcceptAll': return review.decideOwner(this, true);
      case 'reviewRejectAll': return review.decideOwner(this, false);
      case 'worktreeAction': return this.worktreeAction(m.kind);
      case 'action': // buttons on error / notice lines
        switch (m.cmd) {
          case 'pickModel': return this.pickModel();
          case 'manageKeys': return this.manageKeys();
          case 'usage': return this.showUsage();
          case 'history': return this.pickSession();
          case 'installOmp': return this.installOmp();
          case 'login': return this.login();
          case 'setOmpPath': return this.setOmpPath();
          case 'retry': return this.retry();
          case 'openUrl': return vscode.env.openExternal(vscode.Uri.parse(m.arg));
          case 'setModel': return this.switchModel(m.arg);
          case 'revertForce': return this.revert(m.arg, true);
          case 'openFile': return this.openFile(m.arg);
          case 'continueTurn': return this.send('Continue where you left off.');
          case 'compact': return this.send('/compact');
          case 'applyFavorites': this.favChanged = false; return this.restart();
        }
        return;
      case 'setMode': return this.switchMode(m.mode);
      case 'openDiff': return this.openDiff(m.id);
      case 'openEdit': return this.edits.has(m.id) && vscode.window.showTextDocument(vscode.Uri.file(this.edits.get(m.id).path), { preview: false });
      case 'revert': return this.revert(m.id);
    }
  }

  // Per-tab model/mode override: tabs switch locally without restarting other open chats; sidebar updates global settings.
  async switchModel(id) {
    if (!id) return;
    if (this.tab) {
      this.modelOverride = id;
      return this.applyModelLive(id);
    }
    return vscode.workspace.getConfiguration('ompChat').update('model', id, vscode.ConfigurationTarget.Global);
  }

  async switchMode(mode) {
    if (!mode) return;
    if (this.tab) {
      this.modeOverride = mode;
      this.post({ type: 'mode', mode });
      return this.restart();
    }
    return vscode.workspace.getConfiguration('ompChat').update('approvalMode', mode, vscode.ConfigurationTarget.Global);
  }

  // Shared promise so concurrent callers (boot, send, New, settings change) spawn only one omp.
  ensureClient() {
    if (this.client) return Promise.resolve(this.client);
    return (this.starting ??= this.spawn().finally(() => { this.starting = null; }));
  }

  async spawn() {
    // The active saved key of each provider; switching keys means respawning (see restart()).
    const env = { ...process.env, ...(await keys.envFor(this.context)) };
    const baseUrls = await keys.baseUrlsFor(this.context);
    // Read config after the awaits so a setting changed meanwhile is picked up.
    const cfg = vscode.workspace.getConfiguration('ompChat');
    this.cwd = this.worktree?.cwd || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();

    // Plan mode is OMP Chat's own (omp's /plan is terminal-only): omp asks for every edit/command and we deny them.
    const rawMode = this.effectiveMode();
    const mode = rawMode === 'plan' ? 'always-ask' : rawMode;
    const modelArg = this.modelOverride || cfg.get('model');
    this.favChanged = false;
    const overlay = this.overlayArgs(await this.bashDenyRules(cfg)); // before systemPromptArgs: it snapshots the ★ pool the prompt lists
    const args = ['--mode', 'rpc', '--model', modelArg, ...(mode ? ['--approval-mode', mode] : []), `--thinking=${thinkingLevel(cfg)}`,
      ...this.systemPromptArgs(cfg), // a later one in extraArgs wins
      ...overlay, ...this.baseUrlArgs(baseUrls), ...cfg.get('extraArgs', [])];
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
        if (replay) {
          const { messages } = await client.request({ type: 'get_messages' });
          this.replay(messages);
          this.offerContinue(messages);
        }
      } catch (e) {
        if (this.client !== client) this.resume = { file, replay }; // omp failed to start: keep it for the retry
        else this.post({ type: 'error', text: `Could not resume the conversation: ${e.message}` });
      }
    }
    // omp resolves the startup (or resumed) model before extensions register providers: pick it again to get its base URL.
    if (Object.keys(baseUrls).length) {
      try {
        const { model } = await client.request({ type: 'get_state' });
        if (model && baseUrls[model.provider]) await client.request({ type: 'set_model', provider: model.provider, modelId: model.id });
      } catch {}
    }
    this.track(client);
    // Live subagent frames (off by default in omp's RPC mode). "events" adds each subagent's own events, which the map
    // needs for nesting and live chat; an omp without it still gets lifecycle + progress.
    client.request({ type: 'set_subagent_subscription', level: 'events' })
      .catch(() => client.request({ type: 'set_subagent_subscription', level: 'progress' })).catch(() => {});
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

  // Subscription sign-in (ChatGPT, Claude, Copilot…): omp's own OAuth opens the browser and waits for the callback.
  // The terminal is the omp process itself, so it closes when login ends; a success restarts omp to list the new models.
  login() {
    const ompPath = vscode.workspace.getConfiguration('ompChat').get('ompPath') || 'omp';
    const t = vscode.window.createTerminal({ name: 'omp login', shellPath: (ompPath === 'omp' && this.ompFallback?.omp) || ompPath, shellArgs: ['login'] });
    t.show();
    const sub = vscode.window.onDidCloseTerminal((closed) => {
      if (closed !== t) return;
      sub.dispose();
      if (closed.exitStatus?.code === 0) this.restart();
    });
    this.post({ type: 'notice', text: 'Pick a provider in the terminal below and finish signing in in your browser. The chat restarts with the new models when it is done.' });
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
      this.sessionFile = s.sessionFile;
      this.postSession();
      // The start screen offers the latest other conversations to pick up again.
      if (s.sessionFile) this.post({ type: 'recent', list: this.listSessions(s.sessionFile, 4).filter((x) => !x.current).slice(0, 3) });
      if (s.sessionFile && !this.tab) await this.context.workspaceState.update(LAST_SESSION, s.sessionFile);
      this.refreshMeter();
      return s;
    } catch { return null; }
  }

  // The tab keeps this in its webview state, so it can reopen the same conversation (and worktree) after a reload.
  postSession() {
    if (this.sessionFile) this.post({ type: 'session', file: this.sessionFile, title: this.title, worktree: this.worktree });
  }

  // omp's --restore (go on with an interrupted turn) is terminal-only; in RPC mode we offer it instead. A turn the
  // window closed on ends with your message or a tool result; Stop ends with an aborted reply, so it is not offered.
  offerContinue(messages) {
    const last = Array.isArray(messages) ? messages[messages.length - 1] : null;
    if (last?.role !== 'user' && last?.role !== 'toolResult') return;
    this.post({ type: 'notice', text: 'The last turn was cut off before it finished (the window closed or omp stopped).',
      actions: [{ label: 'Continue', cmd: 'continueTurn' }] });
  }

  // "# note" (Claude Code's memory shortcut): appended to the project's AGENTS.md (or CLAUDE.md if that is what it
  // has), which omp reads at the start of every conversation; this conversation is told right away.
  remember(note) {
    const dir = this.cwd || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!dir) return this.post({ type: 'error', text: 'Open a folder first: memory is saved in its AGENTS.md.' });
    const file = ['AGENTS.md', 'CLAUDE.md'].map((f) => path.join(dir, f)).find((f) => fs.existsSync(f)) || path.join(dir, 'AGENTS.md');
    try {
      const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
      fs.appendFileSync(file, `${old && !old.endsWith('\n') ? '\n' : ''}- ${note}\n`);
    } catch (e) {
      return this.post({ type: 'error', text: `Could not save to ${path.basename(file)}: ${e.message}` });
    }
    this.notes.push(`[The user added this to the project memory (${path.basename(file)}): ${note}]`);
    this.post({ type: 'notice', text: `Saved to ${path.basename(file)}: ${note}`, actions: [{ label: 'Open', cmd: 'openFile', arg: file }] });
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
          const refs = [u.context, ...u.files].filter(Boolean);
          this.post({ type: 'user', text: u.text, context: refs.map(shortLabel), refs, images, turn: ++this.turnSeq });
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
    const list = this.listSessions(state.sessionFile, 100);
    if (!list.length) return this.post({ type: 'notice', text: 'No earlier conversations in this folder yet.' });
    this.post({ type: 'sessions', list });
  }

  pinnedSessions() { return this.context.workspaceState?.get('ompChat.pinnedSessions') || []; }

  async togglePinSession(file) {
    if (!this.sessionFileOk(file)) return;
    const cur = this.pinnedSessions();
    const norm = path.resolve(file);
    const next = cur.includes(norm) ? cur.filter((x) => x !== norm) : [norm, ...cur].slice(0, 20);
    await this.context.workspaceState?.update('ompChat.pinnedSessions', next);
    return this.pickSession();
  }

  // Full-text search across workspace conversation JSONL files (for History picker search).
  searchSessions(query) {
    const q = String(query || '').trim().toLowerCase();
    if (!this.sessionDir || !q) return;
    const pinned = new Set(this.pinnedSessions());
    let files = [];
    try { files = fs.readdirSync(this.sessionDir).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(this.sessionDir, f)); } catch {}
    const hits = [];
    for (const file of files) {
      let stat;
      try { stat = fs.statSync(file); } catch { continue; }
      const s = sessionSummary(file);
      if (!s) continue;
      let snippet = '';
      if (s.title.toLowerCase().includes(q)) snippet = s.title;
      else {
        try {
          const raw = fs.readFileSync(file, 'utf8');
          const idx = raw.toLowerCase().indexOf(q);
          if (idx < 0) continue;
          const lineStart = raw.lastIndexOf('\n', idx) + 1;
          const lineEnd = raw.indexOf('\n', idx);
          const rec = JSON.parse(raw.slice(lineStart, lineEnd < 0 ? undefined : lineEnd));
          const txt = rec?.type === 'message' ? textOf(rec.message?.content) : '';
          const p = txt.toLowerCase().indexOf(q);
          snippet = p >= 0 ? txt.slice(Math.max(0, p - 30), p + q.length + 50).replace(/\s+/g, ' ').trim() : '';
        } catch { continue; }
      }
      hits.push({ file, title: s.title, when: stat.mtimeMs, current: this.isCurrentSession(file), pinned: pinned.has(path.resolve(file)), snippet });
      if (hits.length >= 60) break;
    }
    hits.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.when - a.when);
    this.post({ type: 'sessionSearchResults', query, list: hits });
  }

  // Conversations saved next to `current` (omp keeps one folder per workspace), pinned first then newest first.
  listSessions(current, max) {
    const dir = this.sessionDir = path.dirname(current);
    const pinned = new Set(this.pinnedSessions());
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(dir, f)); } catch {}
    return files
      .map((file) => { try { return { file, mtime: fs.statSync(file).mtimeMs, pinned: pinned.has(path.resolve(file)) }; } catch { return null; } }) // deleted meanwhile
      .filter(Boolean)
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.mtime - a.mtime)
      .slice(0, max)
      .map(({ file, mtime, pinned: isPinned }) => {
        const s = sessionSummary(file);
        return s && { file, title: s.title, when: mtime, pinned: isPinned, current: path.resolve(file) === path.resolve(current) };
      })
      .filter(Boolean);
  }

  async openSession(file) {
    if (!this.sessionFileOk(file)) return;
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

  // Only conversation files of this folder, as listed by pickSession(): the path comes from the webview.
  sessionFileOk(file) {
    return typeof file === 'string' && file.endsWith('.jsonl') && !!this.sessionDir
      && path.dirname(path.resolve(file)) === path.resolve(this.sessionDir) && fs.existsSync(file);
  }
  isCurrentSession(file) { return !!this.sessionFile && path.resolve(file) === path.resolve(this.sessionFile); }

  async renameSession(file) {
    if (!this.sessionFileOk(file)) return;
    const old = sessionSummary(file)?.title || '';
    const title = (await vscode.window.showInputBox({ title: this.t('Rename conversation'), value: old, prompt: this.t('New name for this conversation') }))
      ?.replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!title || title === old) return this.pickSession();
    try {
      if (this.isCurrentSession(file) && this.client) await this.client.request({ type: 'set_session_name', name: title });
      const fd = fs.openSync(file, 'r+');
      try {
        const buf = Buffer.alloc(4096);
        const head = buf.toString('utf8', 0, fs.readSync(fd, buf, 0, buf.length, 0));
        const nl = head.indexOf('\n');
        const line = titleHeader(nl < 0 ? head : head.slice(0, nl), title);
        if (!line) throw new Error('this conversation file has no title line, or the name is too long');
        fs.writeSync(fd, line, 0, 'utf8');
      } finally { fs.closeSync(fd); }
    } catch (e) {
      this.post({ type: 'error', text: `Could not rename the conversation: ${e.message}` });
    }
    return this.pickSession();
  }

  async deleteSession(file) {
    if (!this.sessionFileOk(file)) return;
    const title = sessionSummary(file)?.title || path.basename(file);
    const yes = this.t('Delete');
    const pick = await vscode.window.showWarningMessage(this.t('Delete this conversation?'), { modal: true, detail: `${title}\n\n${this.t('The file goes to the trash.')}` }, yes);
    if (pick !== yes) return this.pickSession();
    const current = this.isCurrentSession(file);
    try {
      await vscode.workspace.fs.delete(vscode.Uri.file(file), { useTrash: true });
    } catch (e) {
      return this.post({ type: 'error', text: `Could not delete the conversation: ${e.message}` });
    }
    if (current) return this.newSession(); // nothing left to continue
    return this.pickSession();
  }

  // ---- files named in replies, and code blocks sent to the editor ----
  resolveFile(file) {
    if (!file || (!path.isAbsolute(file) && !this.cwd)) return null;
    const abs = path.resolve(this.cwd || '', file);
    try { return fs.statSync(abs).isFile() ? abs : null; } catch { return null; }
  }

  async openFile(ref) {
    const { file, line, col } = parseFileRef(String(ref || ''));
    const abs = this.resolveFile(file);
    if (!abs) return this.post({ type: 'notice', text: `Could not find ${file} in the workspace.` });
    const pos = new vscode.Position(Math.max(0, line - 1), Math.max(0, col - 1));
    try { await vscode.window.showTextDocument(vscode.Uri.file(abs), { preview: true, selection: new vscode.Range(pos, pos) }); }
    catch { await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(abs)); } // binary (an attached PDF…): its own viewer
  }

  // The editor you were last in (the panel has focus, so activeTextEditor may be gone).
  lastEditor() { return vscode.window.activeTextEditor || vscode.window.visibleTextEditors?.[0]; }

  async insertCode(code) {
    const ed = this.lastEditor();
    if (!ed) return this.newFileFromCode(code, '');
    await vscode.window.showTextDocument(ed.document, { viewColumn: ed.viewColumn, preview: false });
    await ed.edit((b) => ed.selections.forEach((s) => b.replace(s, code)));
  }

  async newFileFromCode(code, lang) {
    lang = lang.toLowerCase();
    let doc;
    try { doc = await vscode.workspace.openTextDocument({ content: code, language: LANG_IDS[lang] || lang || 'plaintext' }); }
    catch { doc = await vscode.workspace.openTextDocument({ content: code }); } // unknown language id
    await vscode.window.showTextDocument(doc, { preview: false });
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
    this.favChanged = true;
  }

  async moveFavorite(id, dir) {
    const fav = this.favoriteModels();
    const i = fav.indexOf(id), j = i + dir;
    if (i < 0 || j < 0 || j >= fav.length) return;
    [fav[i], fav[j]] = [fav[j], fav[i]];
    await this.setFavorites(fav);
    this.favChanged = true;
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
    this.post({ type: 'modelsSheet', current: this.effectiveModel(),
      favorites: this.favoriteModels().map((id) => ({ id, name: names.get(id) || '' })), all, favChanged: !!this.favChanged });
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
        this.turnUsage = { input: 0, output: 0, cost: 0, started: Date.now() };
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
        if (r.message?.role === 'assistant' && this.turnUsage && r.message.usage) {
          const u = r.message.usage;
          this.turnUsage.input += (u.input || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0);
          this.turnUsage.output += u.output || 0;
          this.turnUsage.cost += u.cost?.total || 0;
        }
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
      case 'subagent_event':
        this.onSubagentEvent(r.payload);
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
        if (this.quietSink) this.quietSink.push(r.text); // a command the panel ran for itself (MCP list, reload)
        else this.post({ type: 'command_output', text: r.text });
        break;
      case 'config_update':
        this.setModel(r.model);
        this.accountCache = null;
        this.refreshMeter();
        break;
      case 'bash_output':
      case 'bash_update':
        if (this.activeShellId && (r.chunk || r.output || r.delta)) {
          this.post({ type: 'shell_update', id: this.activeShellId, chunk: String(r.chunk || r.delta || ''), output: r.output ? String(r.output).slice(-8000) : undefined });
        }
        break;
      // pi emits agent_settled after retries/compaction; omp may only emit
      // agent_end. Treat either as "idle"; a later agent_start flips back.
      case 'agent_settled':
      case 'agent_end':
        if (this.turnUsage && !this.replaying && this.turnUsage.input + this.turnUsage.output > 0) {
          this.post({ type: 'turnStats', ...this.turnUsage, seconds: Math.round((Date.now() - this.turnUsage.started) / 1000) });
          this.recordCost(this.turnUsage.cost || 0);
        }
        this.turnUsage = null;
        this.post({ type: 'idle' });
        this.busy = false;
        if (this.blocked) { this.explainBlocked(this.blocked); this.blocked = null; }
        else if (this.quotaHit) { this.quotaHit = false; this.rotateKey(); }
        else {
          // Force-refresh after a turn completes so gateway/plan quota updates live (never stuck on 60s cache).
          this.refreshMeter(true);
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
    return this.effectiveMode() === 'plan';
  }

  // Leave plan mode for `mode` (omp respawns on the same conversation), then ask the agent to carry out the plan.
  async executePlan(mode, delegate) {
    // After the restart, so the overlay (and the model pool in the prompt) are the fresh ones.
    this.afterRestart = () => this.send(delegate ? this.delegatePrompt() : 'Go ahead and implement the plan above.', false);
    await this.switchMode(mode);
  }

  // ---- plugins & skills ----
  // Skills switched off in this workspace reach omp as a per-run config overlay (`--config`), so neither
  // Claude Code's nor omp's own settings are touched. Changing them respawns omp on the same conversation.
  disabledSkills() { return this.context.workspaceState?.get('ompChat.disabledSkills') || []; }
  pinnedSkills() { return this.context.workspaceState?.get('ompChat.pinnedSkills') || []; }
  autoSkills() { return this.context.workspaceState?.get('ompChat.autoSkills') ?? true; }

  // The models subagents may run on: the one in use plus your models (★), as the lead can only pick models the
  // operator named (omp's task.perCallModel). Snapshotted at each start, so the prompt and omp agree.
  taskModelPool() {
    const cur = String(vscode.workspace.getConfiguration('ompChat').get('model') || '');
    return [...new Set([cur, ...this.favoriteModels()].filter(Boolean))].slice(0, 8);
  }

  // ompChat.deniedCommands as omp's own `bash.patterns` deny rules: omp checks them on every bash call, and on each
  // part of a compound one (`cd x && rm -rf /`), in every approval mode including yolo. The overlay replaces the
  // array, so your own rules (`omp config get`) follow ours. null when nothing is denied.
  async bashDenyRules(cfg) {
    const denied = [].concat(cfg.get('deniedCommands', [])).filter((p) => typeof p === 'string' && words(p));
    if (!denied.length) return null;
    const ompPath = cfg.get('ompPath') || 'omp';
    const command = (ompPath === 'omp' && this.ompFallback?.omp) || ompPath;
    const own = await new Promise((resolve) => {
      require('child_process').execFile(command, ['config', 'get', 'bash.patterns', '--json'], { cwd: this.cwd, timeout: 15000 }, (err, out) => {
        // ponytail: an omp without `config get` loses your own bash.patterns for this session; the denies still apply
        try { resolve(err ? [] : [].concat(JSON.parse(out).value || [])); } catch { resolve([]); }
      });
    });
    return [...denied.map((p) => ({ match: words(p), approval: 'deny' })), ...own];
  }

  overlayArgs(bashRules) {
    const off = this.disabledSkills();
    const pool = this.taskPool = this.taskModelPool();
    const dir = (this.context.storageUri || this.context.globalStorageUri)?.fsPath;
    if ((!off.length && pool.length < 2 && !bashRules) || !dir) return [];
    const overlay = {}; // JSON is valid YAML
    if (off.length) overlay.disabledExtensions = off.map((n) => 'skill:' + n);
    if (bashRules) overlay.bash = { patterns: bashRules };
    if (pool.length > 1) {
      // Roles configured outside project settings are what omp lets a task's `model` pick; ours do not touch
      // omp's own roles (smol, slow…).
      overlay.task = { perCallModel: 'on' };
      overlay.modelRoles = Object.fromEntries(pool.map((id, i) => [`ompchat${i + 1}`, id]));
    }
    try {
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'omp-overlay.yml');
      fs.writeFileSync(file, JSON.stringify(overlay, null, 2) + '\n');
      return ['--config', file];
    } catch (e) {
      this.post({ type: 'error', text: `Could not write omp's settings overlay: ${e.message}` });
      return [];
    }
  }

  // Base URLs reach omp through a tiny extension (omp has no flag or env var that works for every provider).
  baseUrlArgs(urls) {
    const dir = this.context.globalStorageUri?.fsPath;
    if (!Object.keys(urls).length || !dir) return [];
    try {
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'omp-base-urls.js');
      fs.writeFileSync(file, `export default function (pi) {\n  for (const [id, baseUrl] of Object.entries(${JSON.stringify(urls)})) pi.registerProvider(id, { baseUrl });\n}\n`);
      return ['-e', file];
    } catch (e) {
      this.post({ type: 'error', text: `Could not apply the base URL: ${e.message}` });
      return [];
    }
  }

  // "Split across subagents": the models it may use are already in the system prompt (delegationGuide).
  delegatePrompt() { return DELEGATE_PLAN; }

  // In every chat, the lead may hand tasks to your models (★) and decides by itself when that helps.
  // Reads this.taskPool, so overlayArgs() runs first.
  delegationGuide() {
    const pool = this.taskPool || [];
    if (pool.length < 2) return '';
    const info = new Map((this.modelsCache || []).map((m) => [m.id, m]));
    const line = (id, i) => {
      const m = info.get(id);
      const tags = [i === 0 && 'the current model', m?.free && 'free', m?.plan && 'subscription plan'].filter(Boolean);
      return `- ${id}${m?.name ? ` (${m.name})` : ''}${tags.length ? ` — ${tags.join(', ')}` : ''}`;
    };
    return '# Delegating\nSplit work into subagent tasks when it helps; you decide. '
      + `Pick the model for each task with the task item's \`model\` field (exact id, optionally with \`:low\`, \`:medium\` or \`:high\` `
      + `for its thinking effort), choosing from these models the user approved:\n${pool.map(line).join('\n')}\n`
      + 'Match the model to the task: the strongest for design, tricky debugging or changes across many files; a faster or cheaper one '
      + 'for search, renames, docs, tests to fill in or small edits. In the summary, say which model did each task.';
  }

  // omp keeps only one --append-system-prompt, so the step announcements and the delegation guide share it.
  systemPromptArgs(cfg) {
    const text = [cfg.get('announceSteps', true) && ANNOUNCE_STEPS, this.delegationGuide()].filter(Boolean).join('\n\n');
    return text ? [`--append-system-prompt=${text}`] : [];
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
    const pin = new Set(this.pinnedSkills());
    this.post({ type: 'plugins', auto: this.autoSkills(),
      groups: groups.map((g) => ({ ...g, skills: g.skills.map((s) => ({ ...s, enabled: !off.has(s.name), pinned: pin.has(s.name) })) })) });
  }

  async applyPlugins(disabled, auto, pinned) {
    const ws = this.context.workspaceState;
    const before = this.disabledSkills();
    await ws?.update('ompChat.autoSkills', !!auto);
    if (Array.isArray(pinned)) await ws?.update('ompChat.pinnedSkills', [...new Set(pinned)]);
    const changed = before.length !== disabled.length || before.some((n) => !disabled.includes(n));
    if (!changed) return this.post({ type: 'notice', text: `Auto-pick is ${auto ? 'on' : 'off'}.` });
    await ws?.update('ompChat.disabledSkills', disabled);
    await this.restart(); // omp reads the overlay at start; the conversation is resumed
    this.post({ type: 'notice', text: disabled.length ? `Plugins updated: ${disabled.length} skill${disabled.length > 1 ? 's' : ''} switched off in this workspace.`
      : 'Plugins updated: all skills are on.' });
  }

  // Run one of omp's own slash commands for the panel and return its output instead of printing it in the chat.
  // Serialized via quietChain so concurrent calls never overwrite quietSink.
  quietCommand(message) {
    const run = async () => {
      const client = await this.ensureClient();
      if (!client) throw new Error('omp is not running');
      const out = [];
      this.quietSink = out;
      try { await client.request({ type: 'prompt', message }); }
      finally { this.quietSink = null; }
      return out.join('\n').trim();
    };
    const next = this.quietChain.then(run, run);
    this.quietChain = next.catch(() => {});
    return next;
  }

  // ---- your own slash commands ----
  async showCommands(note) {
    await this.reveal();
    this.post({ type: 'commandsSheet', list: listCommandFiles(this.cwd), note: note || '' });
  }

  async newCommand() {
    const v = await this.ask({
      title: 'New command',
      text: 'Type /name in the chat to send this prompt. $ARGUMENTS in the prompt is replaced by what you type after the name.',
      fields: [
        { name: 'name', label: 'Name', placeholder: 'e.g. review', required: true },
        { name: 'description', label: 'Description', placeholder: 'Shown in the / list' },
        { name: 'hint', label: 'Arguments hint (optional)', placeholder: 'e.g. <file>' },
        { name: 'prompt', label: 'Prompt', type: 'textarea', required: true,
          placeholder: 'Review $ARGUMENTS for bugs, security issues and missing tests. Reply with a numbered list.' },
        { name: 'scope', label: 'Save for', type: 'select', value: 'project',
          options: [{ value: 'project', label: 'This project (.omp/commands)' }, { value: 'user', label: 'All projects (~/.omp/agent/commands)' }] },
      ],
      submit: 'Create', cancel: 'Cancel',
    });
    if (!v) return this.showCommands();
    const name = v.name.trim().replace(/^\//, '');
    if (!/^[A-Za-z0-9][\w-]*$/.test(name)) return this.showCommands(`"${name}" is not a valid name: use letters, digits, - and _.`);
    const dir = commandDirs(this.cwd).find((d) => d.scope === (v.scope === 'user' || !this.cwd ? 'all projects' : 'project')).dir;
    const file = path.join(dir, `${name}.md`);
    if (fs.existsSync(file)) return this.showCommands(`/${name} already exists.`);
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, commandFileText(v));
    } catch (e) { return this.showCommands(`Could not save: ${e.message}`); }
    await this.reloadCommands();
    return this.showCommands(`Created /${name}.`);
  }

  // Only files from the list above are opened or deleted (the webview names them by path).
  commandFileOf(file) { return listCommandFiles(this.cwd).find((c) => c.file === file); }

  async editCommand(file) {
    if (!this.commandFileOf(file)) return;
    await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: false });
  }

  async deleteCommand(file) {
    const c = this.commandFileOf(file);
    if (!c) return;
    try { await vscode.workspace.fs.delete(vscode.Uri.file(file), { useTrash: true }); }
    catch (e) { return this.showCommands(`Could not delete: ${e.message}`); }
    await this.reloadCommands();
    return this.showCommands(`Deleted /${c.name} (moved to the trash).`);
  }

  // omp reads command files when it loads plugins; this makes a new or deleted one show up in the / list.
  async reloadCommands() {
    try { await this.quietCommand('/reload-plugins'); } catch { /* omp not running: it reads them at start */ }
  }

  // ---- MCP servers (omp's /mcp commands; same user and project mcp.json files as `/mcp list`) ----
  async showMcp(note) {
    await this.reveal();
    let out = '';
    try { out = await this.quietCommand('/mcp list'); }
    catch (e) { return this.post({ type: 'error', text: `Could not list MCP servers: ${e.message}` }); }
    this.mcpServers = parseMcpList(out);
    this.post({ type: 'mcpSheet', servers: this.mcpServers, note: note || '', changed: !!this.mcpChanged });
  }

  async mcpAction(kind, name) {
    const s = (this.mcpServers || []).find((x) => x.name === name);
    if (!s || !['enable', 'disable', 'remove', 'test'].includes(kind)) return;
    let out;
    try { out = await this.quietCommand(`/mcp ${kind} ${name}${kind === 'remove' ? ` --scope ${s.scope}` : ''}`); }
    catch (e) { out = e.message; }
    if (kind !== 'test') this.mcpChanged = true;
    return this.showMcp(out);
  }

  async addMcp() {
    const v = await this.ask({
      title: 'Add MCP server',
      text: 'A local server is started with a command (for example npx -y @modelcontextprotocol/server-filesystem .). A remote one is reached by URL.',
      fields: [
        { name: 'name', label: 'Name', placeholder: 'e.g. github', required: true },
        { name: 'kind', label: 'Type', type: 'select', value: 'command',
          options: [{ value: 'command', label: 'Local: run a command' }, { value: 'url', label: 'Remote: URL (HTTP)' }] },
        { name: 'target', label: 'Command or URL', placeholder: 'npx -y @modelcontextprotocol/server-…  or  https://…', required: true },
        { name: 'env', label: 'Env vars or HTTP headers (optional, KEY=VALUE per line)', type: 'textarea',
          placeholder: 'GITHUB_TOKEN=ghp_…\nAuthorization=Bearer …' },
        { name: 'scope', label: 'Save for', type: 'select', value: 'project',
          options: [{ value: 'project', label: 'This project (.omp/mcp.json)' }, { value: 'user', label: 'All projects' }] },
      ],
      submit: 'Add', cancel: 'Cancel',
    });
    if (!v) return this.showMcp();
    const name = v.name.trim(), target = v.target.trim().replace(/\s*\n\s*/g, ' ');
    if (!/^[A-Za-z0-9][\w.-]*$/.test(name)) return this.showMcp(`"${name}" is not a valid name: use letters, digits, ., - and _.`);
    if (v.kind === 'url' && !/^https?:\/\/\S+$/.test(target)) return this.showMcp('The URL must start with http:// or https:// and contain no spaces.');
    const scope = v.scope === 'user' ? 'user' : 'project';
    let out;
    try { out = await this.quietCommand(`/mcp add ${name} --scope ${scope} ${v.kind === 'url' ? `--url ${target}` : `-- ${target}`}`); }
    catch (e) { out = e.message; }
    // Optional KEY=VALUE lines: merge into the scope's mcp.json under env (local) or headers (remote).
    const pairs = {};
    for (const line of String(v.env || '').split(/\r?\n/)) {
      const m = /^\s*([A-Za-z0-9_.-]+)\s*=\s*(.+?)\s*$/.exec(line);
      if (m) pairs[m[1]] = m[2];
    }
    if (Object.keys(pairs).length) {
      const cfgFile = this.mcpConfigPath(scope);
      try {
        const json = fs.existsSync(cfgFile) ? JSON.parse(fs.readFileSync(cfgFile, 'utf8')) : { mcpServers: {} };
        const bucket = json.mcpServers || json.servers || (json.mcpServers = {});
        if (bucket[name]) {
          const field = v.kind === 'url' ? 'headers' : 'env';
          bucket[name][field] = { ...(bucket[name][field] || {}), ...pairs };
          fs.writeFileSync(cfgFile, JSON.stringify(json, null, 2) + '\n');
        }
      } catch (e) { out = `${out}\n(Could not save env/headers: ${e.message})`.trim(); }
    }
    this.mcpChanged = true;
    return this.showMcp(out);
  }

  mcpConfigPath(scope) {
    return scope === 'user' || !this.cwd
      ? path.join(os.homedir(), '.omp', 'agent', 'mcp.json')
      : path.join(this.cwd, '.omp', 'mcp.json');
  }

  async openMcpConfig(scope) {
    const file = this.mcpConfigPath(scope === 'user' ? 'user' : 'project');
    if (!fs.existsSync(file)) {
      try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, '{\n  "mcpServers": {}\n}\n'); }
      catch (e) { return this.post({ type: 'error', text: `Could not open ${file}: ${e.message}` }); }
    }
    await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: false });
  }

  async applyMcp() {
    this.mcpChanged = false;
    await this.restart(); // omp connects MCP servers at start; the conversation is resumed
    this.post({ type: 'notice', text: 'Agent restarted with the new MCP servers.' });
  }

  // ---- custom subagents (.omp/agents/*.md and ~/.omp/agent/agents/*.md) ----
  async showAgents(note) {
    await this.reveal();
    this.post({ type: 'agentsSheet', list: listAgentFiles(this.cwd), note: note || '' });
  }

  async newAgent() {
    const pool = this.taskModelPool();
    const v = await this.ask({
      title: 'New subagent',
      text: 'Define a specialized subagent (e.g. reviewer, tester, architect). The lead can delegate tasks to it.',
      fields: [
        { name: 'name', label: 'Name', placeholder: 'e.g. security-reviewer', required: true },
        { name: 'description', label: 'Description', placeholder: 'When the lead should delegate to this agent' },
        { name: 'model', label: 'Default model (optional)', placeholder: pool[0] ? `e.g. ${pool[0]}` : 'provider/model (empty = lead decides)' },
        { name: 'prompt', label: 'Instructions', type: 'textarea', required: true,
          placeholder: 'You are a security reviewer. Audit changed files for injection, auth flaws, and leaked secrets…' },
        { name: 'scope', label: 'Save for', type: 'select', value: 'project',
          options: [{ value: 'project', label: 'This project (.omp/agents)' }, { value: 'user', label: 'All projects (~/.omp/agent/agents)' }] },
      ],
      submit: 'Create', cancel: 'Cancel',
    });
    if (!v) return this.showAgents();
    const name = v.name.trim();
    if (!/^[A-Za-z0-9][\w-]*$/.test(name)) return this.showAgents(`"${name}" is not a valid name: use letters, digits, - and _.`);
    const dir = agentDirs(this.cwd).find((d) => d.scope === (v.scope === 'user' || !this.cwd ? 'all projects' : 'project')).dir;
    const file = path.join(dir, `${name}.md`);
    if (fs.existsSync(file)) return this.showAgents(`Agent "${name}" already exists.`);
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, agentFileText({ name, description: v.description, model: v.model?.trim(), prompt: v.prompt }));
    } catch (e) { return this.showAgents(`Could not save: ${e.message}`); }
    await this.reloadCommands();
    return this.showAgents(`Created subagent "${name}".`);
  }

  agentFileOf(file) { return listAgentFiles(this.cwd).find((a) => a.file === file); }

  async editAgent(file) {
    if (!this.agentFileOf(file)) return;
    await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: false });
  }

  async deleteAgent(file) {
    const a = this.agentFileOf(file);
    if (!a) return;
    try { await vscode.workspace.fs.delete(vscode.Uri.file(file), { useTrash: true }); }
    catch (e) { return this.showAgents(`Could not delete: ${e.message}`); }
    await this.reloadCommands();
    return this.showAgents(`Deleted subagent "${a.name}" (moved to the trash).`);
  }

  // ---- project memory manager (AGENTS.md / CLAUDE.md) ----
  memoryFilePath() {
    const dir = this.cwd || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!dir) return null;
    return ['AGENTS.md', 'CLAUDE.md'].map((f) => path.join(dir, f)).find((f) => fs.existsSync(f)) || path.join(dir, 'AGENTS.md');
  }

  async showMemory(note) {
    await this.reveal();
    const file = this.memoryFilePath();
    if (!file) return this.post({ type: 'error', text: 'Open a folder first: memory is saved in its AGENTS.md.' });
    let items = [];
    if (fs.existsSync(file)) {
      try {
        const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
        items = lines.map((line, index) => ({ index, text: line })).filter((x) => x.text.trim());
      } catch {}
    }
    this.post({ type: 'memorySheet', file: path.basename(file), fullPath: file, items, note: note || '' });
  }

  async addMemoryNote(note) {
    const text = String(note || '').trim();
    if (!text) return this.showMemory();
    this.remember(text);
    return this.showMemory(`Saved: ${text}`);
  }

  async deleteMemoryLine(index) {
    const file = this.memoryFilePath();
    if (!file || !fs.existsSync(file)) return this.showMemory();
    try {
      const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
      if (index >= 0 && index < lines.length) {
        lines.splice(index, 1);
        fs.writeFileSync(file, lines.join('\n'));
      }
    } catch (e) { return this.showMemory(`Could not update ${path.basename(file)}: ${e.message}`); }
    return this.showMemory();
  }

  async openMemoryFile() {
    const file = this.memoryFilePath();
    if (!file) return;
    if (!fs.existsSync(file)) { try { fs.writeFileSync(file, ''); } catch {} }
    await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: false });
  }

  // ---- allowed & denied shell command rules ----
  async showCommandRules(note) {
    await this.reveal();
    const cfg = vscode.workspace.getConfiguration('ompChat');
    const allowed = Array.isArray(cfg.get('allowedCommands')) ? cfg.get('allowedCommands') : [];
    const denied = Array.isArray(cfg.get('deniedCommands')) ? cfg.get('deniedCommands') : [];
    this.post({ type: 'rulesSheet', allowed, denied, note: note || '' });
  }

  async addCommandRule(kind, pattern) {
    const p = words(String(pattern || ''));
    if (!p || !['allowed', 'denied'].includes(kind)) return this.showCommandRules();
    const key = kind === 'denied' ? 'deniedCommands' : 'allowedCommands';
    const cfg = vscode.workspace.getConfiguration('ompChat');
    const cur = Array.isArray(cfg.get(key)) ? cfg.get(key) : [];
    await cfg.update(key, [...new Set([...cur, p])], vscode.ConfigurationTarget.Global);
    return this.showCommandRules();
  }

  async removeCommandRule(kind, pattern) {
    if (!['allowed', 'denied'].includes(kind)) return this.showCommandRules();
    const key = kind === 'denied' ? 'deniedCommands' : 'allowedCommands';
    const cfg = vscode.workspace.getConfiguration('ompChat');
    const cur = Array.isArray(cfg.get(key)) ? cfg.get(key) : [];
    await cfg.update(key, cur.filter((x) => x !== pattern), vscode.ConfigurationTarget.Global);
    return this.showCommandRules();
  }

  // Auto-pick: pinned skills plus up to 3 enabled skills matching the request, named to the model ahead of the message.
  async autoPick(text) {
    const pinned = this.pinnedSkills();
    if (!this.autoSkills() && !pinned.length) return [];
    let groups;
    try { groups = await this.listSkills(); } catch { return []; }
    const off = new Set(this.disabledSkills());
    const enabled = groups.flatMap((g) => g.skills).filter((s) => !off.has(s.name));
    if (!this.autoSkills()) return enabled.filter((s) => pinned.includes(s.name));
    return plugins.pickRelevant(text, enabled, 3, pinned);
  }

  // ---- queued messages: sent while the agent works, delivered by omp when the current turn allows ----
  // omp reports its queues (queue_update); a message leaving them has been delivered, so it moves into the chat.
  onQueue(r) {
    const waiting = new Set([...(r.steering || []), ...(r.followUp || [])]);
    for (const [qid, q] of this.queued) {
      if (waiting.has(q.message)) continue;
      this.queued.delete(qid);
      this.post({ type: 'dequeued', qid });
      this.post({ type: 'user', text: q.text, context: q.context, refs: q.refs, images: q.images, turn: ++this.turnSeq });
      this.startRun(q.text);
    }
  }

  // Your message reached the agent: the subagent map's lead now works on it (a new run).
  startRun(text) {
    this.lead = { task: summaryLine(text), model: String(vscode.workspace.getConfiguration('ompChat').get('model') || ''), startedAt: Date.now(), endedAt: null };
    this.map?.update();
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
        review.clear(e.path);
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
      // Optional automatic fallback model when all keys of the current provider are spent.
      const fallback = String(vscode.workspace.getConfiguration('ompChat').get('fallbackModel') || '').trim();
      if (fallback && fallback !== this.modelName && this.client) {
        this.post({ type: 'notice', text: `All keys spent on ${this.modelName}. Falling back to ${fallback} and retrying…` });
        if (this.tab) {
          await this.switchModel(fallback);
        } else {
          this.quietModel = fallback;
          await vscode.workspace.getConfiguration('ompChat').update('model', fallback, vscode.ConfigurationTarget.Global);
          await this.applyModelLive(fallback);
        }
        // Retry only once the switch took: on the old, spent model /retry would 429 straight back here, forever.
        if (this.client && this.modelName === fallback) {
          this.client.prompt('/retry');
          this.busy = true;
          this.post({ type: 'busy' });
        }
        return;
      }
      const nextStar = this.favoriteModels().find((id) => id !== this.modelName);
      const who = p ? (list.length > 1 ? `all ${list.length} saved ${keys.groupLabel(p.env)} keys` : `your ${keys.groupLabel(p.env)} key`) : 'this provider';
      if (reason.kind === 'credit') {
        this.post({ type: 'error', text: `No balance left on ${who}. Top up, or switch to a model from a provider that still has credit `
          + '(for example your OpenRouter key). Switching keeps this conversation.',
          actions: [...(nextStar ? [{ label: `Use ${nextStar.split('/').pop()}`, cmd: 'setModel', arg: nextStar }] : []),
            { label: 'Choose another model', cmd: 'pickModel' }, ...(reason.url ? [{ label: 'Top up', cmd: 'openUrl', arg: reason.url }] : []),
            { label: 'Manage keys', cmd: 'manageKeys' }] });
      } else {
        this.post({ type: 'error', text: `The rate or usage limit is reached on ${who}. Wait for the reset, add a key, or switch to another model `
          + 'to keep going in this conversation.',
          actions: [...(nextStar ? [{ label: `Use ${nextStar.split('/').pop()}`, cmd: 'setModel', arg: nextStar }] : []),
            { label: 'Choose another model', cmd: 'pickModel' }, { label: 'Manage keys', cmd: 'manageKeys' }, { label: 'Usage & limits', cmd: 'usage' }] });
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

  recordCost(cost) {
    if (!(cost > 0)) return;
    this.sessionCost += cost;
    const gs = this.context.globalState;
    if (gs) {
      let d = gs.get(USAGE_DAY);
      if (d?.day !== utcDay()) d = { day: utcDay(), requests: 0, free: 0, cost: 0 };
      d.cost = (d.cost || 0) + cost;
      gs.update(USAGE_DAY, d);
    }
    const limit = Number(vscode.workspace.getConfiguration('ompChat').get('budgetAlert', 0));
    if (limit > 0 && !this.budgetWarned && this.sessionCost >= limit) {
      this.budgetWarned = true;
      this.post({ type: 'notice', text: `This chat has reached $${this.sessionCost.toFixed(2)} (your budget alert is $${limit.toFixed(2)}).`,
        actions: [{ label: 'Usage & limits', cmd: 'usage' }, { label: 'Choose another model', cmd: 'pickModel' }] });
    }
  }

  // Limits of the active key for the current model's provider.
  async account(force) {
    const p = keys.providerOf(this.effectiveModel());
    if (!p) return null;
    const provider = p.prefix.slice(0, -1);
    const k = keys.activeKey(this.context, p.env, await keys.loadKeys(this.context, p.env));
    const key = k?.key || process.env[p.env];
    // Cache for a minute (except errors, which always retry); bust immediately if key or URL changes.
    const cacheKey = `${provider}:${k?.id || ''}:${k?.usageUrl || ''}:${k?.baseUrl || ''}`;
    if (!force && this.accountCache?.key === cacheKey && !this.accountCache.data?.error && Date.now() - this.accountCache.at < 60000) {
      return this.accountCache.data;
    }
    const data = (await keys.fetchAccount(provider, key, this.installId(), k?.usageUrl, k?.baseUrl)) || (key ? { provider, noApi: true } : { provider, needKey: true });
    if (!data.error) this.accountCache = { key: cacheKey, at: Date.now(), data };
    return data;
  }

  // Compact numbers for the composer gauge: context fill, plan window or free requests today.
  // Works even before omp finishes spawning so gateway usage URLs appear immediately on open.
  async refreshMeter(force = false) {
    if (!this.view) return;
    const [state, account] = await Promise.all([
      this.client ? this.client.request({ type: 'get_state' }).catch(() => null) : Promise.resolve(null),
      this.account(force),
    ]);
    // Claude Code's "context left until auto-compact": warn once as the window fills, again after it has been freed.
    const pct = state?.contextUsage?.percent;
    if (pct >= 80 && !this.ctxWarned) {
      this.ctxWarned = true;
      this.post({ type: 'notice', text: `The context is ${Math.round(pct)}% full. Compact the conversation to keep going: omp keeps a summary and frees the space.`,
        actions: [{ label: 'Compact now', cmd: 'compact' }] });
    } else if (pct < 50) this.ctxWarned = false;
    const model = this.effectiveModel();
    this.post({ type: 'meter', context: state?.contextUsage || null, free: /:free$/.test(model || ''),
      today: this.today(), freeQuota: account?.free_model_daily_requests || null, windows: account?.windows || null, gauge: account?.gauge || null });
  }

  async showUsage() {
    const client = await this.ensureClient();
    const [stats, account] = await Promise.all([
      client.request({ type: 'get_session_stats' }).catch(() => null),
      this.account(true),
    ]);
    // Every saved key of this provider with its own limits, so the user can see which one has room.
    const model = this.effectiveModel();
    const p = keys.providerOf(model);
    let keyRows = [];
    if (p) {
      const list = await keys.loadKeys(this.context, p.env);
      const active = keys.activeKey(this.context, p.env, list);
      keyRows = await Promise.all(list.slice(0, 8).map(async (k) => ({
        id: k.id, env: p.env, label: k.label, mask: keys.mask(k.key), active: k.id === active?.id,
        account: k.id === active?.id ? account : await keys.fetchAccount(p.prefix.slice(0, -1), k.key, this.installId(), k.usageUrl, k.baseUrl),
      })));
    }
    this.view?.show?.(true);
    this.post({ type: 'usage', model, stats, today: this.today(), account, keys: keyRows,
      keyGroup: p ? keys.groupLabel(p.env) : null });
    this.refreshMeter();
  }

  async useKey(env, id) {
    await keys.setActive(this.context, env, id);
    await this.restart(); // keys reach omp through its environment; the conversation is resumed
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
      if (id && !this.replaying) review.track(f.path, f.oldText, f.op === 'create', this);
      const diff = f.diff || (canDiff ? review.formatDiff(f.oldText, f.newText) : '');
      return { id, rel: vscode.workspace.asRelativePath(f.path), diff: diff.slice(0, 20000) };
    });
  }

  provideTextDocumentContent(uri) {
    return this.edits.get(uri.query)?.oldText ?? '';
  }

  openDiff(id) {
    const e = this.edits.get(id);
    if (!e) return;
    const name = path.basename(e.path);
    const left = vscode.Uri.from({ scheme: ORIG_SCHEME, path: '/' + name, query: `${this.id}:${id}` });
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
    review.clear(e.path);
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
    this.post({ type: 'context', label: shortLabel(c?.label) || null, full: c?.label || null, rel: c?.rel || null, selection: !!c?.text,
      pinned: this.pinned.map((rel) => ({ rel, label: shortLabel(rel) })) });
  }

  // Attach a file to every message until you remove it (✕ on its chip). From the chip's pin, or the Explorer.
  pinFile(fileOrUri) {
    if (!fileOrUri) return;
    const rel = (typeof fileOrUri === 'string' ? fileOrUri : vscode.workspace.asRelativePath(fileOrUri)).replace(/\\/g, '/');
    if (!this.pinned.includes(rel)) this.pinned = [...this.pinned, rel].slice(-10);
    this.postContext();
  }

  unpinFile(rel) {
    this.pinned = this.pinned.filter((x) => x !== rel);
    this.postContext();
  }

  // "@problems", "@terminal", "@git", "@git:log", "@open" and "@https://…" in a message: what they point at, sent along
  // (not shown in your bubble). "@file" and "@folder/" are omp's: it reads the file or lists the folder itself.
  async mentions(text) {
    const blocks = [];
    if (/(^|\s)@problems\b/.test(text)) {
      const lines = problemLines(vscode.languages.getDiagnostics());
      blocks.push(fence('Problems in the workspace', lines.length ? lines.join('\n') : 'No errors or warnings.'));
    }
    if (/(^|\s)@terminal\b/.test(text)) {
      const out = await this.terminalText();
      blocks.push(fence(`Terminal output${out ? `: ${vscode.window.activeTerminal.name}` : ''}`, out || 'No terminal is open.'));
    }
    if (/(^|\s)@git:log\b/.test(text)) blocks.push(await this.gitLog());
    if (/(^|\s)@git(?:\b(?!:))/.test(text)) blocks.push(await this.gitChanges());
    if (/(^|\s)@open\b/.test(text)) blocks.push(this.openEditorsContext());
    const urls = [...new Set([...text.matchAll(/(?:^|\s)@(https?:\/\/[^\s<>"']+)/g)].map((m) => m[1].replace(/[),.;:!?\]]+$/, '')))];
    for (const url of urls.slice(0, 3)) blocks.push(await fetchPage(url));
    return blocks;
  }

  async gitLog() {
    const cwd = this.cwd || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    try {
      const log = await git(['log', '-n', '15', '--stat', '--oneline'], cwd);
      return fence('Git log (recent commits)', log ? log.slice(0, 20000) : 'No commits yet.');
    } catch (e) {
      return fence('Git log (recent commits)', `git failed: ${e.message}`);
    }
  }

  openEditorsContext() {
    const uris = [];
    for (const g of vscode.window.tabGroups?.all || []) {
      for (const tab of g.tabs || []) {
        const u = tab.input?.uri;
        if (u?.scheme === 'file') uris.push(vscode.workspace.asRelativePath(u).replace(/\\/g, '/'));
      }
    }
    if (!uris.length) {
      for (const ed of vscode.window.visibleTextEditors || []) {
        if (ed.document.uri.scheme === 'file') uris.push(vscode.workspace.asRelativePath(ed.document.uri).replace(/\\/g, '/'));
      }
    }
    const list = [...new Set(uris)];
    return fence('Open editors', list.length ? list.map((p) => `- ${p}`).join('\n') : 'No open files.');
  }

  // "@git": what you have not committed yet, as git status plus the diff against HEAD.
  async gitChanges() {
    const cwd = this.cwd || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    try {
      const status = await git(['status', '--short'], cwd);
      if (!status) return fence('Uncommitted changes (git)', 'No uncommitted changes.');
      // ponytail: execFile's 1 MB buffer; a bigger diff falls back to --stat.
      const diff = await git(['diff', 'HEAD'], cwd).catch(() => git(['diff', 'HEAD', '--stat'], cwd));
      const body = `${status}\n\n${diff}`;
      return fence('Uncommitted changes (git status + diff HEAD)', body.length > 40000 ? `${body.slice(0, 40000)}\n… (cut at 40,000 characters)` : body);
    } catch (e) {
      return fence('Uncommitted changes (git)', `git failed: ${e.message}`);
    }
  }

  // The active terminal's recent output: prefers VS Code Terminal Shell Integration buffer (no clipboard side effects),
  // falling back to selectAll + copySelection when shell integration is unavailable.
  async terminalText(maxLines = 200) {
    const t = vscode.window.activeTerminal;
    if (!t) return null;
    const buffered = terminalBuffers.get(t);
    if (buffered && buffered.trim()) {
      return buffered.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\s+$/, '').split(/\r?\n/).slice(-maxLines).join('\n').slice(-12000);
    }
    const saved = await vscode.env.clipboard.readText();
    const marker = `\u0000omp-${Date.now()}`;
    await vscode.env.clipboard.writeText(marker);
    try {
      await vscode.commands.executeCommand('workbench.action.terminal.selectAll');
      await vscode.commands.executeCommand('workbench.action.terminal.copySelection');
      await vscode.commands.executeCommand('workbench.action.terminal.clearSelection');
      const text = await vscode.env.clipboard.readText();
      if (text === marker) return null;
      return text.replace(/\s+$/, '').split(/\r?\n/).slice(-maxLines).join('\n').slice(-12000);
    } finally {
      await vscode.env.clipboard.writeText(saved);
    }
  }

  // Editor menu and light-bulb actions: Explain / Fix the selection, or fix the problems on a line.
  async editorAction(kind, uri, range) {
    await this.reveal();
    if (kind === 'ask') return this.post({ type: 'focusInput' });
    if (kind === 'explain') return this.send('Explain this code.', true);
    const ed = vscode.window.activeTextEditor;
    uri = uri || ed?.document.uri;
    range = range || ed?.selection;
    const diags = uri ? vscode.languages.getDiagnostics(uri).filter((d) => d.severity <= 1 && (!range || (d.range.end.line >= range.start.line && d.range.start.line <= range.end.line))) : [];
    if (!diags.length) return this.send('Find and fix the bugs in this code.', true);
    const rel = vscode.workspace.asRelativePath(uri).replace(/\\/g, '/');
    const lines = problemLines([[uri, diags]]);
    const first = diags[0].range.start.line + 1;
    return this.send(`Fix ${diags.length === 1 ? 'the problem' : `the ${diags.length} problems`} in ${rel}:${first}`, false, [], [fence(`Problems in ${rel}`, lines.join('\n'))]);
  }

  // The conversation as a Markdown document you can save or share.
  async exportChat() {
    const client = await this.ensureClient();
    if (!client) return;
    let md;
    try { md = toMarkdown((await client.request({ type: 'get_messages' })).messages, this.modelName); }
    catch (e) { return this.post({ type: 'error', text: `Could not export: ${e.message}` }); }
    if (!/^## /m.test(md)) return this.post({ type: 'notice', text: 'Nothing to export yet.' });
    const doc = await vscode.workspace.openTextDocument({ content: md, language: 'markdown' });
    await vscode.window.showTextDocument(doc, { preview: false });
  }

  // Inline Edit (Ctrl+I): quick input right in the editor to edit the current selection/file with inline diff review.
  async inlineEdit() {
    const ed = vscode.window.activeTextEditor;
    if (!ed || ed.document.uri.scheme !== 'file') return vscode.window.showInformationMessage(this.t('Open a file first to use Inline Edit.'));
    const rel = vscode.workspace.asRelativePath(ed.document.uri).replace(/\\/g, '/');
    const sel = ed.selection;
    const target = sel.isEmpty ? rel : `${rel}:${sel.start.line + 1}-${sel.end.line + 1}`;
    const instruction = await vscode.window.showInputBox({
      title: `${this.t('Inline Edit')} · ${target}`,
      prompt: this.t('Describe the edit to make (changes open for inline Accept/Reject)'),
      placeHolder: this.t('e.g. extract helper function, add error handling, convert to async/await…'),
    });
    if (!instruction?.trim()) return;
    await this.reveal();
    const prompt = sel.isEmpty
      ? `Edit ${rel} directly using the edit tool: ${instruction.trim()}`
      : `Edit only the selected region (${target}) in ${rel} directly using the edit tool: ${instruction.trim()}`;
    return this.send(prompt, true);
  }

  // Workspace files for the "@" picker in the panel (uses worktree cwd when inside a git worktree chat).
  async listFiles() {
    if (this.worktree?.cwd) {
      return this.post({ type: 'files', list: walkWorktreeFiles(this.worktree.cwd, 5000) });
    }
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
      return { id, name: m.name || '', free: free(id), plan: plan(id), usedUp: usedUp(id), favorite: fav.includes(id), recent: !fav.includes(id) && recent.includes(id),
        // what helps pick one: context window, whether it sees images, price per 1M tokens in / out
        contextWindow: m.contextWindow || 0, vision: Array.isArray(m.input) && m.input.includes('image'),
        cost: m.cost && (m.cost.input || m.cost.output) ? { input: m.cost.input, output: m.cost.output } : null };
    }).sort((a, b) => tier(a.id) - tier(b.id) || (tier(a.id) < 2 ? order(a.id) - order(b.id) : 0)
      || !!a.usedUp - !!b.usedUp || (b.id === cur) - (a.id === cur) || b.free - a.free || a.id.localeCompare(b.id));
    this.modelsCache = list;
    return list;
  }

  // Apply a model change inside the running omp process without losing the conversation.
  async applyModelLive(id) {
    if (!this.client) return;
    id = String(id || '');
    const slash = id.indexOf('/');
    const p = keys.providerOf(id);
    const hasKey = !!p && ((await keys.loadKeys(this.context, p.env)).length > 0 || !!process.env[p.env] || !!p.optionalKey);
    try {
      this.setModel(await this.client.request({ type: 'set_model', provider: id.slice(0, slash), modelId: id.slice(slash + 1) }));
    } catch (err) {
      if (p && hasKey) return this.restart(); // key added since: respawn on the new model, same conversation
      if (p) {
        return this.post({ type: 'notice', text: `${id} needs a ${p.label} key. Add one and the conversation continues on this model.`,
          actions: [{ label: `Add ${p.label} key`, cmd: 'manageKeys' }, { label: 'Choose another model', cmd: 'pickModel' }] });
      }
      return this.post({ type: 'error', text: `Could not switch to ${id}: ${err.message}` });
    }
    this.accountCache = null;
    this.refreshMeter(true);
  }

  async onConfigChange(e) {
    if (!e.affectsConfiguration('ompChat')) return;
    const cfg = vscode.workspace.getConfiguration('ompChat');
    if (!this.modeOverride) this.post({ type: 'mode', mode: cfg.get('approvalMode') });
    const restartNeeded = RESTART_KEYS.some((k) => {
      if (!e.affectsConfiguration('ompChat.' + k)) return false;
      if (k === 'approvalMode' && this.modeOverride) return false; // tab has its own mode override
      return true;
    });
    if (restartNeeded) return this.restart();
    if (e.affectsConfiguration('ompChat.thinkingLevel')) {
      const level = thinkingLevel(cfg);
      this.post({ type: 'thinking_level', level });
      if (!this.client) return; // the next start passes --thinking
      // Changed inside the running omp, so the conversation carries on.
      try { await this.client.request({ type: 'set_thinking_level', level }); }
      catch (err) { this.post({ type: 'error', text: `Could not set the thinking level to ${level}: ${err.message}` }); }
      return;
    }
    if (e.affectsConfiguration('ompChat.model') && this.quietModel === cfg.get('model')) { this.quietModel = null; return; } // addKeyForm restarts
    if (e.affectsConfiguration('ompChat.model') && !this.modelOverride && this.client) {
      return this.applyModelLive(cfg.get('model'));
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
    // Denied commands are blocked immediately across all modes (safety net).
    const bash = r.method === 'select' && BASH_ASK.exec(r.title || '');
    if (bash) {
      const denied = deniedPattern(bash[1], vscode.workspace.getConfiguration('ompChat').get('deniedCommands', []));
      if (denied) {
        const deny = r.options.find((o) => /^deny/i.test(o)) || r.options[r.options.length - 1];
        this.client?.send({ type: 'extension_ui_response', id: r.id, value: deny });
        this.post({ type: 'notice', text: `Blocked by deniedCommands rule (${denied}): ${bash[1]}` });
        return;
      }
    }
    // A command on your allowed list runs without a card; otherwise the card offers to add it to the list.
    const once = bash && r.options?.find((o) => /^approve( once)?$/i.test(o));
    let always;
    if (once && !SHELL_CONTROL.test(bash[1])) {
      const cfg = vscode.workspace.getConfiguration('ompChat');
      const list = cfg.get('allowedCommands', []);
      if (allowedPattern(bash[1], Array.isArray(list) ? list : [])) {
        this.client?.send({ type: 'extension_ui_response', id: r.id, value: once });
        return;
      }
      const pattern = suggestPattern(bash[1]);
      always = { label: `Always allow ${pattern}`, pattern };
      const at = r.options.indexOf(once) + 1;
      r = { ...r, options: [...r.options.slice(0, at), always.label, ...r.options.slice(at)] };
    }
    // For `Allow tool: write`, compute an exact diff against the existing file on disk (instead of showing every line as "+").
    let writeDiff = null;
    if (r.method === 'select' && /^Allow tool: write\b/.test(r.title || '')) {
      // The write this card asks about, by its `Path:` line; with several writes in flight, never another file's diff.
      const asked = /^Path: (.+)$/m.exec([r.title, r.message].filter(Boolean).join('\n'))?.[1];
      const matches = [...this.toolStarts.values()].filter((w) => w.args?.path === asked);
      const latestWrite = matches.length === 1 ? matches[0] : null;
      if (latestWrite && typeof latestWrite.before === 'string' && typeof latestWrite.args?.content === 'string') {
        writeDiff = review.formatDiff(latestWrite.before, latestWrite.args.content).slice(0, 20000);
      }
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
        this.post({ type: 'dialog', id: r.id, title: [r.title, r.message].filter(Boolean).join('\n'), options, input, ...(writeDiff ? { diff: writeDiff } : {}) });
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
    if (always && res.value === always.label) {
      res = { value: once };
      const cfg = vscode.workspace.getConfiguration('ompChat');
      const list = cfg.get('allowedCommands', []);
      await cfg.update('allowedCommands', [...new Set([...(Array.isArray(list) ? list : []), always.pattern])], vscode.ConfigurationTarget.Global);
      this.post({ type: 'notice', text: `Added ${always.pattern} to your allowed commands (setting ompChat.allowedCommands).` });
    }
    // Skip if omp already gave up on it, or the session was replaced while the dialog was open.
    if (!cancelled && client && this.client === client) client.send({ type: 'extension_ui_response', id: r.id, ...res });
  }

  // extra: blocks sent to the model ahead of your text but not shown in your bubble (problems, terminal output).
  // Files from the panel: [{ name, data (base64) }] uploads, or [{ path }] dragged from VS Code. Uploads are
  // written under the extension's storage, one folder per message. Returns [{ path, label }].
  // ponytail: uploads are kept (a resumed conversation may read them again); prune old folders if they pile up.
  saveAttachments(files) {
    const out = [];
    let dir = null;
    for (const f of (Array.isArray(files) ? files : []).slice(0, 10)) {
      if (typeof f?.path === 'string') {
        if (fs.existsSync(f.path)) out.push({ path: f.path, label: vscode.workspace.asRelativePath(f.path) });
        continue;
      }
      if (typeof f?.data !== 'string' || f.data.length > 28e6) continue; // about 20 MB once decoded
      const name = path.basename(String(f.name || 'file')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') || 'file';
      try {
        dir ??= path.join(this.context.globalStorageUri.fsPath, 'attachments', String(Date.now()));
        fs.mkdirSync(dir, { recursive: true });
        let file = path.join(dir, name);
        for (let n = 2; fs.existsSync(file); n++) file = path.join(dir, `${path.parse(name).name} (${n})${path.extname(name)}`);
        fs.writeFileSync(file, Buffer.from(f.data, 'base64'));
        out.push({ path: file, label: name });
      } catch (e) {
        this.post({ type: 'error', text: `Could not attach ${name}: ${e.message}` });
      }
    }
    return out;
  }

  async send(text, withContext, images, extra = [], files = []) {
    text = (text || '').trim();
    // Pasted / attached images from the webview: [{ mimeType, data (base64) }], at most 5 per message.
    images = (Array.isArray(images) ? images : [])
      .filter((i) => /^image\/(png|jpeg|gif|webp)$/.test(i?.mimeType) && typeof i.data === 'string')
      .slice(0, 5)
      .map((i) => ({ type: 'image', mimeType: i.mimeType, data: i.data }));
    // Other files: uploads are saved where omp can read them; files dragged from VS Code are used where they are.
    const attachments = this.saveAttachments(files);
    if (!text && !images.length && !attachments.length) return;
    if (!text) text = attachments.length ? `See the attached file${attachments.length > 1 ? 's' : ''}.` : 'See the attached image.';
    let client = await this.ensureClient();
    if (!client) { this.post({ type: 'idle' }); return; }
    if (/^!\s*\S/.test(text)) return this.runShell(text.replace(/^!\s*/, ''));
    if (/^#(?!#)\s*\S/.test(text) && !text.includes('\n')) return this.remember(text.replace(/^#\s*/, '')); // one line only
    const isCommand = text.startsWith('/'); // slash commands must reach omp verbatim
    const ctx = withContext && !isCommand ? this.contextInfo() : null;
    const pinned = isCommand ? [] : this.pinned.filter((rel) => rel !== ctx?.rel);
    const blocks = isCommand ? [] : [...extra, ...await this.mentions(text)];
    // The active file has unsaved edits in VS Code: a diff against disk so omp doesn't see stale content. With the
    // other fenced blocks, after the attachment headers: splitUserText reads those headers first.
    const ed = ctx && !ctx.text && vscode.window.activeTextEditor;
    if (ed?.document?.isDirty && ed.document.uri.scheme === 'file') {
      try {
        const d = review.formatDiff(fs.readFileSync(ed.document.uri.fsPath, 'utf8'), ed.document.getText());
        if (d) blocks.unshift(fence(`Unsaved changes in ${ctx.rel}`, d.slice(0, 15000)));
      } catch {}
    }
    let message = [...blocks, text].join('\n\n');
    if (pinned.length) message = `[Attached files: ${pinned.join(', ')}]\n\n${message}`;
    if (attachments.length && !isCommand) {
      message = `[Files the user attached; read them with the read tool, which also converts PDF, Word, Excel, PowerPoint and EPUB:\n${
        attachments.map((a) => `- ${a.path}`).join('\n')}]\n\n${message}`;
    }
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
    // Chips show a short label and open their ref: the selection's `file:10-20`, a pinned path, an attachment's full path.
    const chips = [ctx?.label, ...pinned, ...attachments].filter(Boolean);
    const shown = { text, context: chips.map((c) => shortLabel(c.label ?? c)), refs: chips.map((c) => c.path ?? c),
      images: images.map((i) => `data:${i.mimeType};base64,${i.data}`) };
    // The awaits above (skill list, terminal copy) can outlast a restart: send to the omp running now.
    client = this.client || await this.ensureClient();
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
    if (!isCommand) this.startRun(text);
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
    this.activeShellId = id;
    this.post({ type: 'shell_start', id, command });
    this.shellRunning = (this.shellRunning || 0) + 1;
    try {
      const r = await this.client.request({ type: 'bash', command }, 0);
      this.post({ type: 'shell_end', id, output: (r.output || '').slice(-8000), exitCode: r.exitCode, cancelled: r.cancelled, truncated: r.truncated, timedOut: r.timedOut });
    } catch (e) {
      this.post({ type: 'shell_end', id, output: e.message, exitCode: -1 });
    } finally {
      if (this.activeShellId === id) this.activeShellId = null;
      this.shellRunning--;
    }
  }

  // Worktree actions right from the tab bar: view diff against base, merge branch into main repo, or discard worktree.
  async worktreeAction(kind) {
    const wt = this.worktree;
    if (!wt) return;
    if (kind === 'diff') {
      try {
        const diff = await git(['diff', `${wt.base}...${wt.branch}`], wt.path).catch(() => '') || await git(['diff', 'HEAD'], wt.path);
        const doc = await vscode.workspace.openTextDocument({ content: diff || '# No changes in this worktree yet.\n', language: 'diff' });
        await vscode.window.showTextDocument(doc, { preview: false });
      } catch (e) {
        this.post({ type: 'error', text: `Could not read worktree diff: ${e.message}` });
      }
    } else if (kind === 'merge') {
      try {
        const dirty = await git(['status', '--porcelain'], wt.path);
        if (dirty) {
          return this.post({ type: 'notice', text: `Worktree ${wt.branch} has uncommitted changes. Commit them first (e.g. !git add -A && git commit -m "…") before merging.` });
        }
        await git(['merge', '--no-ff', wt.branch], wt.top);
        this.post({ type: 'notice', text: `Merged branch ${wt.branch} into the main repository.` });
      } catch (e) {
        this.post({ type: 'error', text: `Merge failed: ${e.message}` });
      }
    } else if (kind === 'discard') {
      const yes = this.t('Discard');
      const pick = await vscode.window.showWarningMessage(this.t('Discard this worktree and delete its branch?'), { modal: true, detail: `${wt.branch}\n${wt.path}` }, yes);
      if (pick !== yes) return;
      this.client?.dispose();
      this.client = null;
      try {
        await removeWorktree(wt, true);
        this.worktree = null; // only now: on failure the tab keeps working in the worktree, never the main checkout
        this.panel?.dispose();
      } catch (e) {
        this.post({ type: 'error', text: `Could not discard worktree: ${e.message}` });
      }
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
    this.taskCalls.clear();
    this.lead = null;
    this.map?.update();
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
    clearInterval(this.meterTimer);
    this.meterTimer = null;
    this.reviewSub?.dispose();
    this.map?.dispose();
    if (this.client) this.client.dispose();
  }

  html(webview) {
    const uri = (f) => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', f));
    const nonce = crypto.randomBytes(16).toString('hex');
    const t = (s) => this.t(s); // static text below; the panel translates what it builds itself
    // Inlined (not <img>) so main.css can recolor the mascot for the current VS Code theme.
    const mascot = fs.readFileSync(path.join(this.context.extensionUri.fsPath, 'media', 'mascot.svg'), 'utf8');
    return `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; img-src ${webview.cspSource} data: blob:; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${uri('vendor/codicons/codicon.css')}">
<link rel="stylesheet" href="${uri('main.css')}">
</head><body>
<template id="mascot">${mascot}</template>
<div id="wtBar" hidden></div>
<div id="searchBar" hidden>
  <span class="codicon codicon-search"></span>
  <input id="searchInput" type="text" placeholder="Search in conversation…">
  <span id="searchCount"></span>
  <button id="searchPrev" class="icon" title="Previous match"><span class="codicon codicon-arrow-up"></span></button>
  <button id="searchNext" class="icon" title="Next match"><span class="codicon codicon-arrow-down"></span></button>
  <button id="searchClose" class="icon" title="Close"><span class="codicon codicon-close"></span></button>
</div>
<div id="sheet" hidden></div>
<div id="lightbox" hidden><img id="lightboxImg" alt=""></div>
<div id="log" role="log" aria-live="polite">
  <div id="welcome">
    <div class="hero">${mascot}</div>
    <h2>OMP Chat</h2>
    <p class="lead">${t('Ask about your code, or let the agent change it.')}<br>${t('It asks before editing files or running commands.')}</p>
    <div id="suggest">
      <button class="card" data-prompt="Explain what the current file does."><span class="codicon codicon-book"></span><span class="ctext"><b>Explain this file</b><small>What it does and how the parts fit</small></span></button>
      <button class="card" data-prompt="Find bugs in the current file and fix them."><span class="codicon codicon-bug"></span><span class="ctext"><b>Find and fix bugs</b><small>Look for mistakes in the open file</small></span></button>
      <button class="card" data-prompt="Write unit tests for the current file."><span class="codicon codicon-beaker"></span><span class="ctext"><b>Write tests</b><small>Cover the open file with unit tests</small></span></button>
    </div>
    <div id="recent" hidden></div>
    <div class="keys">
      <span><kbd>/</kbd>Commands</span><span><kbd>@</kbd>Mention a file</span>
      <span><kbd>!</kbd>Shell command</span><span><kbd>#</kbd>Save to memory</span>
      <span><kbd>Shift+Tab</kbd>Approval mode</span><span><kbd>Esc</kbd>Stop the agent</span>
    </div>
  </div>
</div>
<div id="composer">
  <button id="jump" class="icon" hidden title="Jump to latest" aria-label="Jump to latest"><span class="codicon codicon-arrow-down"></span></button>
  <div id="popup" hidden></div>
  <div id="reviewBar" hidden></div>
  <div id="agents" hidden></div>
  <div id="todos" hidden></div>
  <div id="queue" hidden></div>
  <div id="box">
    <!-- What goes with the message, in one row: add more (@), the open file (eye: sent or not), pinned files. -->
    <div id="ctx">
      <button id="attach" class="chip addctx" title="Mention a file, folder, @git, @problems… (@)"><span class="codicon codicon-mention"></span><span class="plabel">Add context</span></button>
      <span id="ctxChip" class="chip" hidden><button id="ctxEye"><span id="ctxIcon" class="codicon codicon-eye"></span><span id="ctxLabel" class="plabel"></span></button><button id="ctxPin" class="ctxx" title="Keep this file attached to every message"><span class="codicon codicon-pin"></span></button></span>
      <span id="pinned"></span>
      <span id="attached"></span>
    </div>
    <div id="dropHint"><span class="codicon codicon-cloud-upload"></span>Drop to attach: images, PDF, Word, Excel, text or code files</div>
    <div id="thumbs" hidden></div>
    <div id="shellHint" hidden><span class="codicon codicon-terminal"></span>Shell command: runs in the workspace, and the output joins the conversation</div>
    <div id="memHint" hidden><span class="codicon codicon-bookmark"></span>Memory: saved to the project's AGENTS.md, so the agent remembers it in every chat</div>
    <textarea id="input" rows="1" placeholder="Ask OMP… / for commands, @ for files"></textarea>
    <!-- mode on the left; context, model · effort, commands, images and send on the right -->
    <div id="tools">
      <button id="mode" class="pill" title="When OMP must ask before running tools (Shift+Tab)" aria-haspopup="listbox"><span id="modeIcon" class="codicon codicon-shield"></span><span id="modeLabel" class="plabel"></span></button>
      <span class="spacer"></span>
      <button id="meter" class="pill" title="Usage &amp; limits" hidden><span id="ring" class="ring"></span><span id="meterText"></span></button>
      <button id="model" class="pill" title="Model and effort" aria-haspopup="listbox"><span id="modelName"></span><span id="effort"></span></button>
      <button id="slash" class="icon" title="Commands (/)"><span class="glyph">/</span></button>
      <button id="addImage" class="icon" title="Attach files or images (or paste / drop them)"><span class="codicon codicon-add"></span></button>
      <input id="imageFile" type="file" multiple hidden>
      <button id="stop" class="icon send" hidden title="Stop (the agent keeps what it did so far)"><span class="codicon codicon-primitive-square"></span></button>
      <button id="send" class="icon send" title="Send (Enter)"><span class="codicon codicon-arrow-up"></span></button>
    </div>
  </div>
</div>
<script nonce="${nonce}" type="application/json" id="l10n">${JSON.stringify(this.dictionary).replace(/</g, '\\u003c')}</script>
<script nonce="${nonce}" src="${uri('l10n.js')}"></script>
<script nonce="${nonce}" src="${uri('vendor/markdown-it.min.js')}"></script>
<script nonce="${nonce}" src="${uri('highlight.js')}"></script>
<script nonce="${nonce}" src="${uri('main.js')}"></script>
</body></html>`;
  }
}

// ---- chats in editor tabs, each with its own omp (herdr's panes), optionally in their own git worktree ----
let tabSeq = 1;

// A WebviewPanel dressed as the WebviewView the chat was written for.
function panelView(panel, title) {
  return {
    webview: panel.webview,
    get visible() { return panel.visible; },
    show: () => panel.reveal(),
    set description(v) { panel.title = v ? `${title} · ${v}` : title; },
    set badge(_) { /* tabs show their state in the title */ },
    onDidDispose: (cb) => panel.onDidDispose(cb),
    onDidChangeVisibility: (cb) => panel.onDidChangeViewState(cb),
  };
}

// panel: given when VS Code restores a tab after a reload; resume: that tab's conversation.
function openTab(context, { panel, resume, worktree } = {}) {
  if (worktree && !fs.existsSync(worktree.cwd)) worktree = null; // removed since: work in the main folder
  const title = worktree ? `OMP Chat · ${worktree.branch}` : `OMP Chat ${++tabSeq}`;
  panel ??= vscode.window.createWebviewPanel(TAB_TYPE, title, vscode.ViewColumn.Beside, { enableScripts: true, retainContextWhenHidden: true });
  panel.title = title;
  panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.svg');
  const chat = new ChatProvider(context, { tab: true, title, worktree });
  chat.panel = panel;
  if (resume && sessionSummary(resume)) chat.resume = { file: resume, replay: true };
  chats.add(chat);
  panel.onDidDispose(() => {
    chats.delete(chat);
    chat.map?.dispose();
    const c = chat.client;
    chat.client = null; // closed on purpose: no "omp stopped" error
    c?.dispose();
    refreshStatusBar();
    if (chat.worktree) closeWorktree(chat.worktree);
  });
  chat.resolveWebviewView(panelView(panel, title));
  return chat;
}

// A new branch checked out next to the repository (<repo>.worktrees/<branch>), so this chat's edits never touch yours.
async function newWorktreeChat(context, translate = (s) => s) {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  let top;
  try { top = root && await git(['rev-parse', '--show-toplevel'], root); } catch {}
  if (!top) return vscode.window.showErrorMessage(translate('OMP Chat: a worktree chat needs a folder that is a git repository.'));
  const stamp = new Date().toISOString().slice(0, 16).replace(/\D/g, '');
  const branch = await vscode.window.showInputBox({ title: translate('New chat in a git worktree'), prompt: translate('Branch for this chat (created from the current commit)'),
    value: `omp/chat-${stamp}`, validateInput: (v) => (/^[\w][\w./-]*$/.test(v) && !/\.\.|\/$|\.lock$/.test(v) ? null : translate('Letters, digits and / . _ - only')) });
  if (!branch) return;
  const dir = path.join(path.dirname(top), `${path.basename(top)}.worktrees`, branch.replace(/\//g, '-'));
  try {
    const base = await git(['rev-parse', 'HEAD'], top);
    await git(['worktree', 'add', '-b', branch, dir, base], top);
    // the same subfolder of the repository that is open in VS Code
    openTab(context, { worktree: { top, branch, base, path: dir, cwd: path.join(dir, path.relative(top, root)) } });
  } catch (e) {
    vscode.window.showErrorMessage(`${translate('OMP Chat: could not create the worktree')}: ${e.message}`);
  }
}

// The worktree and its branch. omp may still hold the folder for a moment after it is stopped (Windows): retry.
async function removeWorktree(wt, force) {
  for (let i = 0; ; i++) {
    try { await git(['worktree', 'remove', ...(force ? ['--force'] : []), wt.path], wt.top); break; }
    catch (e) { if (i >= 3) throw e; await new Promise((r) => setTimeout(r, 1000)); }
  }
  await git(['branch', '-D', wt.branch], wt.top);
}

// Closing the tab: a worktree with nothing in it (no changes, no new commits) is removed with its branch; one with
// work in it is kept for you to review and merge.
async function closeWorktree(wt, translate = (s) => s) {
  try {
    const dirty = await git(['status', '--porcelain'], wt.path);
    const ahead = await git(['rev-list', '--count', `${wt.base}..${wt.branch}`], wt.top);
    if (!dirty && ahead === '0') {
      await removeWorktree(wt);
      return;
    }
  } catch { /* fall through: keep it */ }
  const open = translate('Open Folder in New Window');
  const merge = translate('Merge branch');
  const pick = await vscode.window.showInformationMessage(`OMP Chat: the worktree for branch ${wt.branch} has changes, so it was kept at ${wt.path}. `
    + `Merge the branch when you are happy with it, then remove it with "git worktree remove".`, open, merge);
  if (pick === open) vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(wt.path), true);
  else if (pick === merge) {
    try { await git(['merge', '--no-ff', wt.branch], wt.top); vscode.window.showInformationMessage(`Merged ${wt.branch}.`); }
    catch (e) { vscode.window.showErrorMessage(`Merge failed: ${e.message}`); }
  }
}

// Generate a concise git commit message from staged (or unstaged) changes and fill VS Code's Git SCM input box.
async function generateCommitMessage(context, provider) {
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!cwd) return vscode.window.showErrorMessage(provider.t('Open a folder first.'));
  let diff = '';
  try {
    diff = await git(['diff', '--cached'], cwd);
    if (!diff) diff = await git(['diff'], cwd);
  } catch (e) {
    return vscode.window.showErrorMessage(`git failed: ${e.message}`);
  }
  if (!diff.trim()) return vscode.window.showInformationMessage(provider.t('No changes to generate a commit message for.'));
  const ompPath = vscode.workspace.getConfiguration('ompChat').get('ompPath') || 'omp';
  const fallback = ompPath === 'omp' ? (provider.ompFallback || findOmp()) : null;
  const command = fallback ? fallback.omp : ompPath;
  const env = { ...process.env, ...(await keys.envFor(context)) };
  if (fallback) {
    const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
    env[key] = [...fallback.pathDirs, env[key]].filter(Boolean).join(path.delimiter);
  }
  const baseUrls = await keys.baseUrlsFor(context);
  const model = provider.effectiveModel();
  const prompt = 'Write a concise conventional commit message (1 subject line <= 72 chars, optional short bullet body) for the git diff below. Output ONLY the commit message with no markdown fences or commentary.\n\n'
    + diff.slice(0, 16000);
  await vscode.window.withProgress({ location: vscode.ProgressLocation?.SourceControl || 1, title: provider.t('Generating commit message…') }, async () => {
    try {
      const args = ['--print', '--no-session', '--model', model, ...provider.baseUrlArgs(baseUrls), prompt];
      const msg = await new Promise((resolve, reject) => {
        require('child_process').execFile(command, args, { cwd, env, timeout: 60000, maxBuffer: 4e6 },
          (err, stdout, stderr) => (err ? reject(new Error(String(stderr || err.message).trim())) : resolve(String(stdout).trim())));
      });
      const clean = msg.replace(/^```[^\n]*\n?|\n?```$/g, '').trim();
      const gitExt = vscode.extensions?.getExtension?.('vscode.git')?.exports;
      const repo = gitExt?.getAPI?.(1)?.repositories?.[0];
      if (repo) repo.inputBox.value = clean;
      else {
        await vscode.env.clipboard.writeText(clean);
        vscode.window.showInformationMessage(provider.t('Commit message copied to clipboard: ') + clean.split('\n')[0]);
      }
    } catch (e) {
      vscode.window.showErrorMessage(`${provider.t('Could not generate commit message')}: ${e.message}`);
    }
  });
}

function activate(context) {
  const provider = new ChatProvider(context);
  chats.add(provider);
  // The chat a palette command means: the tab you are in, otherwise the sidebar's.
  const current = () => [...chats].find((c) => c.panel?.active) || provider;
  // Shared orig-file content provider across ALL chats (sidebar + tabs + worktrees).
  const origProvider = {
    provideTextDocumentContent(uri) {
      const q = String(uri.query || '');
      const sep = q.indexOf(':');
      if (sep > 0) {
        const cid = q.slice(0, sep), eid = q.slice(sep + 1);
        const owner = [...chats].find((c) => c.id === cid);
        if (owner?.edits.has(eid)) return owner.edits.get(eid).oldText ?? '';
      }
      for (const c of chats) if (c.edits.has(q)) return c.edits.get(q).oldText ?? '';
      return '';
    },
  };
  // Agent status in the status bar, visible even with the panel closed; click opens the chat that needs you.
  statusItem = vscode.window.createStatusBarItem?.(vscode.StatusBarAlignment?.Left, 100);
  if (statusItem) {
    statusItem.name = 'OMP Chat status';
    statusItem.command = 'ompChat.attention';
    context.subscriptions.push(statusItem);
  }
  review.register(context, (s) => provider.t(s));
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('ompChat.view', provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    // Tabs come back after a reload with their conversation (and worktree), kept in the tab's webview state.
    vscode.window.registerWebviewPanelSerializer?.(TAB_TYPE, {
      async deserializeWebviewPanel(panel, state) {
        openTab(context, { panel, resume: state?.session?.file, worktree: state?.session?.worktree });
      },
    }) || { dispose() {} },
    vscode.workspace.registerTextDocumentContentProvider(ORIG_SCHEME, origProvider),
    vscode.commands.registerCommand('ompChat.focus', () =>
      vscode.commands.executeCommand('ompChat.view.focus')),
    vscode.commands.registerCommand('ompChat.newTab', () => openTab(context)),
    vscode.commands.registerCommand('ompChat.newWorktreeChat', () => newWorktreeChat(context, (s) => provider.t(s))),
    vscode.commands.registerCommand('ompChat.attention', () => { // the one waiting for you first, then one that finished
      const top = byStatus()[0];
      return (top && top.s !== 'idle' ? top.c : current()).reveal();
    }),
    vscode.commands.registerCommand('ompChat.chats', async () => {
      const items = [...chats].map((c) => {
        const s = c.agentStatus();
        return { label: `${STATUS_ICON[s]} ${c === provider ? provider.t('OMP Chat (sidebar)') : c.title}`,
          description: [c.t(STATUS_UI[s].title.replace(/^\S+ /, '')), c.modelName].filter(Boolean).join(' · '), detail: c.worktree?.path, c };
      });
      const pick = await vscode.window.showQuickPick(items, { title: provider.t('OMP Chat: all chats') });
      pick?.c.reveal();
    }),
    vscode.commands.registerCommand('ompChat.newSession', () => current().newSession()),
    vscode.commands.registerCommand('ompChat.stop', () => current().stop()),
    vscode.commands.registerCommand('ompChat.pickModel', () => current().pickModel()),
    vscode.commands.registerCommand('ompChat.history', () => current().pickSession()),
    vscode.commands.registerCommand('ompChat.usage', () => current().showUsage()),
    vscode.commands.registerCommand('ompChat.plugins', () => current().showPlugins()),
    vscode.commands.registerCommand('ompChat.manageModels', () => current().showModelsSheet()),
    vscode.commands.registerCommand('ompChat.setApiKey', () => current().manageKeys()),
    vscode.commands.registerCommand('ompChat.login', () => current().login()),
    vscode.commands.registerCommand('ompChat.subagentMap', () => current().openMap()),
    vscode.commands.registerCommand('ompChat.exportChat', () => current().exportChat()),
    vscode.commands.registerCommand('ompChat.commands', () => current().showCommands()),
    vscode.commands.registerCommand('ompChat.agents', () => current().showAgents()),
    vscode.commands.registerCommand('ompChat.memory', () => current().showMemory()),
    vscode.commands.registerCommand('ompChat.commandRules', () => current().showCommandRules()),
    vscode.commands.registerCommand('ompChat.mcp', () => current().showMcp()),
    vscode.commands.registerCommand('ompChat.inlineEdit', () => current().inlineEdit()),
    vscode.commands.registerCommand('ompChat.generateCommit', () => generateCommitMessage(context, current())),
    vscode.commands.registerCommand('ompChat.clearAttachments', () => {
      const n = provider.pruneAttachments(true);
      vscode.window.showInformationMessage(n ? `${provider.t('Cleared cached attachments')} (${n}).` : provider.t('No cached attachments to clear.'));
    }),
    vscode.commands.registerCommand('ompChat.addFile', (uri, all) => {
      const target = current();
      (Array.isArray(all) && all.length ? all : [uri || vscode.window.activeTextEditor?.document.uri]).forEach((u) => target.pinFile(u));
      return target.reveal();
    }),
    vscode.commands.registerCommand('ompChat.ask', () => current().editorAction('ask')),
    vscode.commands.registerCommand('ompChat.explain', () => current().editorAction('explain')),
    vscode.commands.registerCommand('ompChat.fix', (uri, range) => current().editorAction('fix', uri, range)),
    vscode.languages.registerCodeActionsProvider({ scheme: 'file' }, {
      provideCodeActions(doc, range, ctx) {
        if (!ctx.diagnostics.some((d) => d.severity <= 1)) return [];
        const title = provider.t('Fix with OMP Chat');
        const a = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
        a.command = { command: 'ompChat.fix', title, arguments: [doc.uri, range] };
        return [a];
      },
    }, { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }),
    vscode.workspace.onDidChangeConfiguration((e) => chats.forEach((c) => c.onConfigChange(e))),
    vscode.window.onDidChangeActiveTextEditor(() => chats.forEach((c) => c.postContext())),
    vscode.window.onDidChangeTextEditorSelection(() => chats.forEach((c) => c.postContext())),
    vscode.window.onDidChangeWindowState?.((s) => { if (s.focused) chats.forEach((c) => { if (c.view?.visible) c.refreshMeter(); }); }) || { dispose() {} },
    vscode.window.onDidStartTerminalShellExecution?.((e) => {
      if (e.terminal && e.execution?.read) captureTerminalExecution(e.terminal, e.execution.read(), e.execution.commandLine?.value);
    }) || { dispose() {} },
    { dispose: () => chats.forEach((c) => c.dispose()) },
  );
}

function deactivate() {}

module.exports = { activate, deactivate, _test: { chats, openTab, closeWorktree, newWorktreeChat, parseFileRef, titleHeader, toMarkdown, splitUserText, problemLines, listCommandFiles, commandFileText, listAgentFiles, agentFileText, parseMcpList, deniedPattern, walkWorktreeFiles } };
