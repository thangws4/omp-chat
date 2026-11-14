const Module = require('module'); const assert = require('assert');
let provider, editor;
const vs = { Uri: { joinPath: () => ({}) },
  workspace: { getConfiguration: () => ({ get: (k, d) => d }), asRelativePath: (u) => u.fsPath, onDidChangeConfiguration: () => ({}), registerTextDocumentContentProvider: () => ({}) },
  window: { registerWebviewViewProvider: (id, p) => { provider = p; return {}; }, onDidChangeActiveTextEditor: () => ({}), onDidChangeTextEditorSelection: () => ({}), get activeTextEditor() { return editor; } },
  CodeActionKind: { QuickFix: 'quickfix' }, CodeAction: class {}, languages: { registerCodeActionsProvider: () => ({}), getDiagnostics: () => [] }, commands: { registerCommand: () => ({}) } };
const orig = Module._load; Module._load = function (r, ...a) { return r === 'vscode' ? vs : orig.call(this, r, ...a); };
require('../extension.js').activate({ subscriptions: [], extensionUri: {}, secrets: { get: async () => undefined }, globalState: { get() {}, update: async () => {} } });
const posts = []; provider.post = (m) => posts.push(m);
let rotated = 0; provider.rotateKey = async () => { rotated++; };
const fail = (status, msg) => { provider.onRecord({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'error', errorStatus: status, errorMessage: msg } }); provider.onRecord({ type: 'agent_end' }); };
// the exact errors from the screenshot
provider.modelName = 'opencode-zen/deepseek-v4.1-flash-free';
fail(429, '429 Free usage limit reached. Free models work in OpenCode (https://opencode.ai); subscribe to OpenCode Go to keep going: https://opencode.ai/go (type=FreeUsageLimitError) retry-after-ms=17518000');
let card = posts.filter((p) => p.type === 'error').pop();
assert(rotated === 0 && /resets in about 4h 52m/.test(card.text) && card.actions[0].cmd === 'pickModel');
provider.modelName = 'opencode-go/beam-free';
fail(403, '403 An active OpenCode Go subscription is required to use OpenCode Go models. (type=permission_error)');
card = posts.filter((p) => p.type === 'error').pop();
assert(rotated === 0 && card.actions.some((a) => a.cmd === 'openUrl' && a.arg === 'https://opencode.ai/go'));
// an ordinary 429 still rotates keys
provider.modelName = 'deepseek/deepseek-flash'; fail(429, 'Rate limit exceeded');
assert.strictEqual(rotated, 1);
// a file outside the workspace: short chip, full path kept for the model
editor = { document: { uri: { scheme: 'file', fsPath: 'C:/Users/Admin/AppData/Local/Temp/x/patch_orig.js' }, languageId: 'javascript', getText: () => '' }, selection: { isEmpty: true } };
provider.postContext();
const c = posts.filter((p) => p.type === 'context').pop();
assert(c.label === 'patch_orig.js' && /AppData/.test(c.full));

;(async () => {
  // the picker after a free-limit hit: that provider's free models go last with the time left; no "no key" marks
  const gs = new Map([['ompChat.freeBlock.opencode-zen', Date.now() + 4 * 3600e3 + 46 * 60e3]]);
  provider.context.globalState = { get: (k) => gs.get(k), update: async (k, v) => gs.set(k, v) };
  provider.reveal = async () => {};
  provider.client = { request: async () => ({ models: [
    { provider: 'opencode-zen', id: 'deepseek-v4.1-flash-free', name: 'DS free' }, { provider: 'opencode-zen', id: 'glm-5.3-flash-free', name: 'GLM free' },
    { provider: 'openrouter', id: 'baidu/ernie-5.5-flash-preview:free', name: 'ERNIE' }, { provider: 'opencode-go', id: 'beam-free', name: 'Beam' },
    { provider: 'openrouter', id: 'a/paid', name: 'Paid' }] }) };
  provider.modelName = 'opencode-zen/deepseek-v4.1-flash-free';
  posts.length = 0; await provider.pickModel();
  const l = posts.find((p) => p.type === 'models').list;
  assert.strictEqual(l[0].id, 'openrouter/baidu/ernie-5.5-flash-preview:free', 'a usable free model comes first');
  assert(l.slice(-2).every((x) => x.usedUp && /^4h 4[56]m$/.test(x.usedUp)) && !l.some((x) => 'noKey' in x));
  // replay: two user turns in a row get a "No reply" note between them
  posts.length = 0;
  provider.replay([{ role: 'user', content: 'a' }, { role: 'user', content: 'b' }, { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }]);
  assert.deepStrictEqual(posts.filter((p) => ['user', 'notice'].includes(p.type)).map((p) => p.text), ['a', 'No reply: this request failed.', 'b']);
  
})().catch((e) => { console.error(e); process.exit(1); });
