// Allowed commands (ompChat.allowedCommands) skip the approval card; "@git" and "@https://…" are sent along.
const Module = require('module'); const assert = require('assert');
const conf = { allowedCommands: ['npm test*', 'git status'], approvalMode: 'always-ask' };
let provider;
const vs = { Uri: { joinPath: () => ({}) }, ConfigurationTarget: { Global: 1 },
  workspace: { getConfiguration: () => ({ get: (k, d) => conf[k] ?? d, update: async (k, v) => { conf[k] = v; } }), onDidChangeConfiguration: () => ({}), registerTextDocumentContentProvider: () => ({}) },
  window: { registerWebviewViewProvider: (id, p) => { if (id === 'ompChat.view') provider = p; return {}; }, onDidChangeActiveTextEditor: () => ({}), onDidChangeTextEditorSelection: () => ({}) },
  CodeActionKind: { QuickFix: 'quickfix' }, CodeAction: class {}, languages: { registerCodeActionsProvider: () => ({}), getDiagnostics: () => [] }, commands: { registerCommand: () => ({}) } };
const orig = Module._load; Module._load = function (r, ...a) { return r === 'vscode' ? vs : orig.call(this, r, ...a); };
require('../extension.js').activate({ subscriptions: [], extensionUri: {}, secrets: {} });
const sent = [], posts = [];
provider.client = { send: (m) => sent.push(m) };
provider.view = { show() {} };
provider.post = (m) => { posts.push(m); if (m.type === 'dialog') setTimeout(() => provider.dialogs.get(m.id).answer(answer(m))); };
let answer = () => 'Deny';
const ask = (id, title, options = ['Approve', 'Deny']) => provider.onUiRequest({ type: 'extension_ui_request', id, method: 'select', title, options });
const last = () => sent.at(-1);
(async () => {
  // on the list: answered without a card
  await ask('a', 'Allow tool: bash\nCommand: npm test -- --grep x');
  assert.deepStrictEqual(last(), { type: 'extension_ui_response', id: 'a', value: 'Approve' });
  await ask('b', 'Allow tool: bash\nCommand: git  status', ['Approve Once', 'Always Approve', 'Deny']);
  assert.strictEqual(last().value, 'Approve Once');
  assert.ok(!posts.some((p) => p.type === 'dialog'));
  // shell control, a Reason line, or a command off the list: the card, with "Always allow" for a plain command
  for (const [id, title] of [['c', 'Allow tool: bash\nCommand: npm test && rm -rf x'], ['d', 'Allow tool: bash\nReason: Critical pattern detected\nCommand: npm test'],
    ['e', 'Allow tool: bash\nCommand: npm test $(whoami)'], ['f', 'Allow tool: edit\nFile: a.py']]) {
    await ask(id, title);
    assert.strictEqual(last().value, 'Deny', id);
    assert.deepStrictEqual(posts.filter((p) => p.type === 'dialog').at(-1).options, ['Approve', 'Deny'], id);
  }
  answer = (m) => m.options[1];
  await ask('g', 'Allow tool: bash\nCommand: cargo build --release');
  assert.deepStrictEqual(posts.filter((p) => p.type === 'dialog').at(-1).options, ['Approve', 'Always allow cargo build*', 'Deny']);
  assert.strictEqual(last().value, 'Approve');
  assert.deepStrictEqual(conf.allowedCommands, ['npm test*', 'git status', 'cargo build*']);
  await ask('h', 'Allow tool: bash\nCommand: cargo build');
  assert.strictEqual(last().value, 'Approve', 'now on the list');
  // plan mode still refuses everything
  conf.approvalMode = 'plan';
  await ask('i', 'Allow tool: bash\nCommand: npm test');
  assert.strictEqual(last().value, 'Deny');
  conf.approvalMode = 'always-ask';

  // @git: status + diff of the repo; @url: the page as text
  provider.cwd = require('path').join(__dirname, '..');
  global.fetch = async (url) => ({ ok: true, headers: { get: () => 'text/html; charset=utf-8' },
    text: async () => `<html><head><title>x</title></head><body><script>bad()</script><h1>Hello</h1><p>a &amp; b</p></body></html>` });
  const blocks = await provider.mentions('look at @git and @https://example.com/doc). please');
  assert.match(blocks[0], /^\[Uncommitted changes \(git/);
  assert.strictEqual(blocks[1], '[Web page https://example.com/doc]\n```\nHello\na & b\n```');
  global.fetch = async () => ({ ok: false, status: 404 });
  assert.match((await provider.mentions('@https://example.com/x'))[0], /HTTP 404/);
  assert.deepStrictEqual(await provider.mentions('mail me@https://x.com'), [], 'only at a word start');
  console.log('# allowed-mentions ok');
})().catch((e) => { console.error(e); process.exit(1); });
