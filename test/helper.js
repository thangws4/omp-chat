// Loads extension.js against a fake `vscode` module so the chat provider can be driven without VS Code or omp.
const Module = require('module');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// Copies own properties including getters (Object.assign would freeze a getter into a value).
const mix = (target, extra) => Object.defineProperties(target, Object.getOwnPropertyDescriptors(extra || {}));

function activate({ vs = {}, context = {} } = {}) {
  let provider;
  const stub = {
    Uri: { joinPath: () => ({}), parse: (u) => u, file: (p) => ({ scheme: 'file', fsPath: p, path: p }) },
    ThemeColor: class { constructor(id) { this.id = id; } },
    StatusBarAlignment: { Left: 1, Right: 2 },
    env: { openExternal() {}, clipboard: { writeText: async () => {} } },
    workspace: mix({
      getConfiguration: () => ({ get: (k, d) => d }),
      onDidChangeConfiguration: () => ({}),
      registerTextDocumentContentProvider: () => ({}),
      asRelativePath: (u) => (typeof u === 'string' ? u : u.path || u.fsPath),
      workspaceFolders: undefined,
    }, vs.workspace),
    window: mix({
      registerWebviewViewProvider: (id, p) => { if (id === 'ompChat.view') provider = p; return {}; },
      onDidChangeActiveTextEditor: () => ({}),
      onDidChangeTextEditorSelection: () => ({}),
      createStatusBarItem: () => ({ show() {}, hide() {} }),
      showInformationMessage: async () => {}, showWarningMessage: async () => {}, showErrorMessage: async () => {},
      terminals: [],
    }, vs.window),
    languages: mix({ registerCodeActionsProvider: () => ({}), getDiagnostics: () => [] }, vs.languages),
    commands: mix({ registerCommand: () => ({}), executeCommand: async () => {} }, vs.commands),
    CodeAction: class { constructor(title, kind) { this.title = title; this.kind = kind; } },
    CodeActionKind: { QuickFix: 'quickfix', RefactorRewrite: 'refactor.rewrite' },
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  };
  for (const k of Object.keys(vs)) stub[k] = stub[k] && typeof stub[k] === "object" ? mix(stub[k], vs[k]) : vs[k];
  const orig = Module._load;
  Module._load = function (r, ...a) { return r === 'vscode' ? stub : orig.call(this, r, ...a); };

  const gs = new Map(), ws = new Map(), sec = new Map();
  const store = (m) => ({ get: (k, d) => (m.has(k) ? m.get(k) : d), update: async (k, v) => { m.set(k, v); }, keys: () => [...m.keys()] });
  const ctx = {
    subscriptions: [], extensionUri: {},
    secrets: { get: async (k) => sec.get(k), store: async (k, v) => { sec.set(k, v); }, delete: async (k) => { sec.delete(k); } },
    globalState: store(gs), workspaceState: store(ws),
    ...context,
  };
  require(path.join(ROOT, 'extension.js')).activate(ctx);
  const posts = [];
  provider.post = (m) => posts.push(m);
  provider.refreshMeter = () => {};
  provider.reveal = async () => {};
  return { provider, posts, vs: stub, gs, sec, ctx, last: (t) => posts.filter((p) => p.type === t).pop() };
}

// An omp error reply followed by the end of the turn.
const fail = (provider, status, msg) => {
  provider.onRecord({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'error', errorStatus: status, errorMessage: msg } });
  provider.onRecord({ type: 'agent_end' });
};

module.exports = { ROOT, activate, fail };
