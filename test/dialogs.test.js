const Module = require('module'); const assert = require('assert');
class CTS { constructor(){ this.token = { isCancellationRequested: false, cb: null }; } cancel(){ this.token.isCancellationRequested = true; this.token.cb?.(); } dispose(){} }
let next = {}; // scripted user answers per method
const vs = { CancellationTokenSource: CTS, Uri: { joinPath: () => ({}), parse: (u) => u }, env: { openExternal(){} },
  workspace: { getConfiguration: () => ({ get: (k, d) => d }), onDidChangeConfiguration: () => ({}) },
  CodeActionKind: { QuickFix: 'quickfix' }, CodeAction: class {}, languages: { registerCodeActionsProvider: () => ({}), getDiagnostics: () => [] }, commands: { registerCommand: () => ({}), executeCommand: async () => {} },
  window: { registerWebviewViewProvider: (id, p) => { if (id === 'ompChat.view') provider = p; return {}; },
    showInformationMessage: async (...a) => { shown.push(a[0]); }, showWarningMessage: async () => {}, showErrorMessage: async () => {},
    showQuickPick: (items, o, tok) => new Promise(res => { tok.cb = () => res(undefined); if (next.pick !== 'hang') setTimeout(() => res(typeof next.pick === 'function' ? next.pick(items) : next.pick)); }),
    showInputBox: (o, tok) => { seenInput = o; return Promise.resolve(next.input); } } };
let provider, seenInput, shown = [];
(function(v){v.workspace=v.workspace||{};v.window=v.window||{};v.workspace.registerTextDocumentContentProvider=()=>({});v.window.onDidChangeActiveTextEditor=()=>({});v.window.onDidChangeTextEditorSelection=()=>({});v.workspace.onDidChangeConfiguration=v.workspace.onDidChangeConfiguration||(()=>({}));v.commands=v.commands||{};v.commands.registerCommand=v.commands.registerCommand||(()=>({}));})(typeof vs!=='undefined'?vs:vscodeStub);
const orig = Module._load; Module._load = function (r, ...a) { return r === 'vscode' ? vs : orig.call(this, r, ...a); };
require('../extension.js').activate({ subscriptions: [], extensionUri: {}, secrets: {} });
const sent = []; provider.client = { send: (m) => sent.push(m) }; const posted = []; provider.post = (m) => posted.push(m);
const req = (o) => provider.onUiRequest({ type: 'extension_ui_request', ...o });
(async () => {
  next.pick = 'Yes'; await req({ id: 'c1', method: 'confirm', title: 'Run rm?', message: 'sure?' });
  next.pick = (items) => items[1]; await req({ id: 's1', method: 'select', title: 'Pick', options: ['a', 'b'] });
  next.input = 'hello'; await req({ id: 'i1', method: 'input', title: 'Name', secret: true });
  next.input = undefined; await req({ id: 'e1', method: 'editor', title: 'Edit', prefill: 'x' });
  assert.deepStrictEqual(sent, [
    { type: 'extension_ui_response', id: 'c1', confirmed: true },
    { type: 'extension_ui_response', id: 's1', value: 'b' },
    { type: 'extension_ui_response', id: 'i1', value: 'hello' },
    { type: 'extension_ui_response', id: 'e1', cancelled: true }]);
  assert.strictEqual(seenInput.value, 'x');
  // omp cancels an open dialog -> it closes and no response is sent
  sent.length = 0; next.pick = 'hang'; const p = req({ id: 'c2', method: 'confirm', title: 't', message: 'm' });
  await new Promise(r => setTimeout(r)); await req({ id: 'x', method: 'cancel', targetId: 'c2' }); await p;
  // session replaced while dialog open -> no response to new client
  const p2 = req({ id: 'c3', method: 'confirm', title: 't', message: 'm' }); await new Promise(r => setTimeout(r));
  provider.client = { send: (m) => sent.push(m), dispose(){} }; provider.newSession(); await p2;
  assert.deepStrictEqual(sent, []); assert.strictEqual(provider.dialogs.size, 0);
  // setWidget ignored; notify and open_url become lines in the chat (no VS Code pop-ups)
  await req({ id: 'w', method: 'setWidget', widgetKey: 'k' }); await req({ id: 'n', method: 'notify', message: 'hi' });
  await req({ id: 'u', method: 'open_url', url: 'https://example.com/x' });
  assert.deepStrictEqual(shown, []);
  assert.deepStrictEqual(posted.filter((p) => p.type === 'notice').map((p) => [p.text, p.actions?.[0]?.arg]), [['hi', undefined], ['omp wants to open https://example.com/x', 'https://example.com/x']]);
  
})().catch(e => { console.error(e); process.exit(1); });
