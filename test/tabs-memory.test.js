// Chats in tabs (herdr-style status across chats), git worktree chats, "# memory", continue an interrupted turn,
// the context-full warning and notifications.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { activate, ROOT } = require('./helper');

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'omp-tabs-')));
const repo = path.join(tmp, 'repo');
fs.mkdirSync(repo);
const g = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: repo, encoding: 'utf8' }).trim();
g('init', '-q');
fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
g('add', '.');
g('commit', '-qm', 'init');

let focused = true, branchName = 'omp/test-1';
const toasts = [], panels = [];
const fakePanel = () => {
  const p = { title: '', visible: true, active: false, revealed: 0, webview: { postMessage() {}, onDidReceiveMessage() {}, asWebviewUri: (u) => u, cspSource: '' },
    reveal() { p.revealed++; }, onDidDispose(cb) { (p.disposers ??= []).push(cb); }, onDidChangeViewState() {}, dispose() { p.disposers.forEach((cb) => cb()); } };
  panels.push(p);
  return p;
};
const item = { show() { item.shown = true; }, hide() { item.shown = false; } };
const { provider, posts } = activate({
  vs: {
    ViewColumn: { Beside: -2 },
    window: { get state() { return { focused }; }, createWebviewPanel: () => fakePanel(), createStatusBarItem: () => item,
      showInputBox: async () => branchName,
      showWarningMessage: async (t) => { toasts.push(['warn', t]); }, showInformationMessage: async (t) => { toasts.push(['info', t]); } },
    workspace: { workspaceFolders: [{ uri: { fsPath: repo } }] },
  },
  context: { extensionUri: { fsPath: ROOT } },
});
const proto = Object.getPrototypeOf(provider);
proto.boot = async function () {}; // no omp in tests
const { chats, openTab, closeWorktree, newWorktreeChat } = require('../extension')._test;

(async () => {
  // ---- a tab is its own chat; the status bar sums up every chat ----
  const ctx = provider.context;
  const tab = openTab(ctx);
  tab.post = () => {};
  assert.strictEqual(chats.size, 2);
  assert.ok(tab.tab && /^OMP Chat \d+$/.test(tab.title));
  tab.working = true;
  tab.refreshStatus();
  assert.ok(item.shown && /working/.test(item.text));
  assert.match(panels[0].title, /· 🟡 working$/, 'the tab title shows its state');
  provider.working = true;
  provider.refreshStatus();
  assert.match(item.text, /2 chats/);
  // a tab waiting for you outranks one that is working; the status bar opens it
  provider.dialogs.set('d1', {});
  focused = false;
  tab.dialogs.set('d2', {});
  tab.refreshStatus();
  assert.match(item.text, /needs you/);
  assert.deepStrictEqual(toasts.pop(), ['warn', `${tab.title}: waiting for your answer`], 'unfocused window: notified');
  tab.dialogs.clear(); provider.dialogs.clear();
  // finished while VS Code was in the background
  tab.onStatusEvent('idle');
  assert.deepStrictEqual(toasts.pop(), ['info', `${tab.title}: finished`]);
  focused = true;
  provider.working = false; provider.refreshStatus();
  // closing the tab removes it and stops its omp
  let killed = false;
  tab.client = { dispose() { killed = true; } };
  panels[0].dispose();
  assert.ok(killed && chats.size === 1 && tab.client === null);

  // ---- "# note" goes to the project's memory and to this conversation ----
  provider.cwd = repo;
  provider.client = { prompt() { throw new Error('memory must not reach the model as a message'); }, request: async () => ({}) };
  provider.ensureClient = async () => provider.client;
  await provider.send('# always use pnpm');
  await provider.send('# and run tests');
  assert.strictEqual(fs.readFileSync(path.join(repo, 'AGENTS.md'), 'utf8'), '- always use pnpm\n- and run tests\n');
  assert.ok(provider.notes.some((n) => /always use pnpm/.test(n)));
  assert.match(posts.filter((p) => p.type === 'notice').pop().text, /^Saved to AGENTS\.md: and run tests$/);
  // a heading or several lines is an ordinary message
  let sent = null;
  provider.client.prompt = (m) => { sent = m; };
  provider.autoPick = async () => [];
  await provider.send('## heading\nmore');
  assert.ok(sent && /## heading/.test(sent));

  // ---- continue a turn the window closed on; not after Stop ----
  const before = posts.length;
  provider.offerContinue([{ role: 'user' }, { role: 'assistant', stopReason: 'aborted' }]);
  assert.strictEqual(posts.length, before);
  provider.offerContinue([{ role: 'user' }, { role: 'assistant' }, { role: 'toolResult' }]);
  assert.strictEqual(posts.at(-1).actions[0].cmd, 'continueTurn');

  // ---- context warning: once while full, again after it was freed ----
  let pct = 85;
  provider.view = { visible: true, webview: { postMessage() {} } };
  provider.account = async () => null;
  provider.client.request = async () => ({ contextUsage: { percent: pct } });
  const warnings = () => posts.filter((p) => p.actions?.[0]?.cmd === 'compact').length;
  delete provider.refreshMeter;
  await provider.refreshMeter(); await provider.refreshMeter();
  assert.strictEqual(warnings(), 1);
  pct = 20; await provider.refreshMeter();
  pct = 90; await provider.refreshMeter();
  assert.strictEqual(warnings(), 2);

  // ---- plan → split across subagents, each task on a model that suits it ----
  const vsStub = require('vscode');
  const getCfg = vsStub.workspace.getConfiguration;
  const cfgSet = { model: 'deepseek/deepseek-v4-flash' };
  vsStub.ConfigurationTarget = { Global: 1 };
  vsStub.workspace.getConfiguration = () => ({ get: (k, d) => cfgSet[k] ?? d, update: async (k, v) => { cfgSet[k] = v; } });
  // no models of yours yet: no overlay, and the prompt does not mention models
  ctx.storageUri = { fsPath: path.join(tmp, 'storage') };
  assert.deepStrictEqual(provider.overlayArgs(), []);
  await provider.onWebviewMessage({ type: 'executePlan', mode: 'write', delegate: true });
  assert.strictEqual(cfgSet.approvalMode, 'write', 'leaves plan mode; edits auto-approved');
  provider.busy = false;
  await provider.afterRestart();
  assert.match(sent, /delegating it\. Give each numbered task to its own subagent/);
  assert.doesNotMatch(sent, /`model` field/);
  // with your models (★): omp may run tasks on them, and the lead is told which they are
  await ctx.globalState.update('ompChat.favoriteModels', ['deepseek/deepseek-v4-pro', 'openrouter/x/y:free', 'deepseek/deepseek-v4-flash']);
  provider.modelsCache = [{ id: 'openrouter/x/y:free', name: 'Y', free: true }];
  const args = provider.overlayArgs();
  assert.strictEqual(args[0], '--config');
  const overlay = JSON.parse(fs.readFileSync(args[1], 'utf8'));
  assert.deepStrictEqual(overlay, { task: { perCallModel: 'on' },
    modelRoles: { ompchat1: 'deepseek/deepseek-v4-flash', ompchat2: 'deepseek/deepseek-v4-pro', ompchat3: 'openrouter/x/y:free' } });
  await provider.onWebviewMessage({ type: 'executePlan', mode: 'write', delegate: true });
  provider.busy = false;
  await provider.afterRestart();
  assert.match(sent, /`model` field/);
  assert.match(sent, /- deepseek\/deepseek-v4-flash — the current model\n- deepseek\/deepseek-v4-pro\n- openrouter\/x\/y:free \(Y\) — free\n/);
  // skills switched off ride in the same overlay
  await ctx.workspaceState.update('ompChat.disabledSkills', ['tdd']);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(provider.overlayArgs()[1], 'utf8')).disabledExtensions, ['skill:tdd']);
  // plain execute keeps the plain prompt
  await provider.onWebviewMessage({ type: 'executePlan', mode: 'always-ask' });
  provider.busy = false;
  await provider.afterRestart();
  assert.match(sent, /Go ahead and implement the plan above\.$/);
  vsStub.workspace.getConfiguration = getCfg;
  await ctx.workspaceState.update('ompChat.disabledSkills', []);

  // ---- worktree chat: its own branch next to the repo; removed on close only when nothing happened in it ----
  await newWorktreeChat(ctx);
  const wtChat = [...chats].find((c) => c.worktree);
  const wt = wtChat.worktree;
  assert.strictEqual(wt.branch, 'omp/test-1');
  assert.strictEqual(path.resolve(wt.path), path.join(tmp, 'repo.worktrees', 'omp-test-1'));
  assert.ok(fs.existsSync(path.join(wt.cwd, 'a.txt')));
  assert.match(wtChat.title, /omp\/test-1/);
  await closeWorktree(wt);
  assert.ok(!fs.existsSync(wt.path), 'clean worktree removed');
  assert.ok(!g('branch', '--list', 'omp/test-1'), 'and its branch');

  branchName = 'omp/test-2';
  await newWorktreeChat(ctx);
  const wt2 = [...chats].filter((c) => c.worktree).pop().worktree;
  fs.writeFileSync(path.join(wt2.path, 'new.txt'), 'work\n');
  await closeWorktree(wt2);
  assert.ok(fs.existsSync(wt2.path), 'worktree with changes kept');
  assert.match(toasts.pop()[1], /omp\/test-2 has changes, so it was kept/);

  g('worktree', 'remove', '--force', wt2.path);
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('tabs-memory ok');
})().catch((e) => { console.error(e); process.exit(1); });
