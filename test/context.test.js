const Module = require('module'); const assert = require('assert');
let provider; let editor;
const vs = { Uri: { joinPath: () => ({}) },
  workspace: { getConfiguration: () => ({ get: (k, d) => d }), asRelativePath: (u) => u.path, onDidChangeConfiguration: () => ({}), registerTextDocumentContentProvider: () => ({}) },
  window: { registerWebviewViewProvider: (id, p) => { provider = p; return {}; }, onDidChangeActiveTextEditor: () => ({}), onDidChangeTextEditorSelection: () => ({}),
    get activeTextEditor() { return editor; } },
  CodeActionKind: { QuickFix: 'quickfix' }, CodeAction: class {}, languages: { registerCodeActionsProvider: () => ({}), getDiagnostics: () => [] }, commands: { registerCommand: () => ({}) } };
const orig = Module._load; Module._load = function (r, ...a) { return r === 'vscode' ? vs : orig.call(this, r, ...a); };
require('../extension.js').activate({ subscriptions: [], extensionUri: {}, secrets: {} });
const sent = [], posts = [];
provider.client = { prompt: (m) => sent.push(m) }; provider.post = (m) => posts.push(m);
const doc = (sel) => ({ document: { uri: { scheme: 'file', path: 'src/a.py' }, languageId: 'python', getText: () => 'x = 1\ny = 2' }, selection: sel });
(async () => {
  editor = doc({ isEmpty: true });
  provider.busy = false; await provider.send('explain', true);
  assert.strictEqual(sent.at(-1), '[Current file: src/a.py]\n\nexplain');
  editor = doc({ isEmpty: false, start: { line: 2 }, end: { line: 4, character: 0 } });
  provider.busy = false; await provider.send('fix this', true);
  assert.strictEqual(sent.at(-1), '[Selection from src/a.py:3-4]\n```python\nx = 1\ny = 2\n```\n\nfix this');
  assert.deepStrictEqual(posts.filter((p) => p.type === 'user').at(-1).context, ['src/a.py:3-4']);
  provider.busy = false; await provider.send('no ctx', false); assert.strictEqual(sent.at(-1), 'no ctx');
  provider.busy = false; await provider.send('/session', true); assert.strictEqual(sent.at(-1), '/session', 'slash commands stay verbatim');
  provider.notes.push('[Note: reverted]'); provider.busy = false; await provider.send('next', false);
  assert.strictEqual(sent.at(-1), '[Note: reverted]\n\nnext'); assert.strictEqual(provider.notes.length, 0);
  editor = { document: { uri: { scheme: 'untitled' } } }; provider.postContext(); assert.strictEqual(posts.at(-1).label, null);
  
})().catch((e) => { console.error(e); process.exit(1); });
