const Module = require('module'); const assert = require('assert');
let provider;
const vs = { Uri: { joinPath: () => ({}) }, workspace: { getConfiguration: () => ({ get: (k, d) => d }), onDidChangeConfiguration: () => ({}), registerTextDocumentContentProvider: () => ({}) },
  window: { registerWebviewViewProvider: (id, p) => { provider = p; return {}; }, onDidChangeActiveTextEditor: () => ({}), onDidChangeTextEditorSelection: () => ({}) }, CodeActionKind: { QuickFix: 'quickfix' }, CodeAction: class {}, languages: { registerCodeActionsProvider: () => ({}), getDiagnostics: () => [] }, commands: { registerCommand: () => ({}) } };
const orig = Module._load; Module._load = function (r, ...a) { return r === 'vscode' ? vs : orig.call(this, r, ...a); };
require('../extension.js').activate({ subscriptions: [], extensionUri: {}, secrets: {}, globalState: { get() {}, update: async () => {} } });
const posts = []; provider.post = (m) => posts.push(m); provider.refreshMeter = () => {};
provider.modelName = 'opencode-go/kimi-k3';
provider.onRecord({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'error', errorStatus: 400,
  errorMessage: '400 This OpenCode Go model is hosted outside Europe and the United States. Select Global at https://opencode.ai/console/org_01M786S3XC4Y2Z1JCNH1GTGJZ9/settings/privacy#regions to use it. (type=invalid_request_error) raw-http-request=C:\Users\Admin\.omp\logs\http-400-requests\1794530740793-2mhhq0v1ay0zr.json' } });
const e = posts.find((p) => p.type === 'error');
assert(!/raw-http-request/.test(e.text));
assert.deepStrictEqual(e.actions, [{ label: 'Open privacy settings', cmd: 'openUrl', arg: 'https://opencode.ai/console/org_01M786S3XC4Y2Z1JCNH1GTGJZ9/settings/privacy#regions' }]);

