const Module = require('module'); const assert = require('assert');
let provider; const item = { shown: false, show() { this.shown = true; }, hide() { this.shown = false; } };
const vs = { ThemeColor: class { constructor(id) { this.id = id; } }, StatusBarAlignment: { Left: 1 }, Uri: { joinPath: () => ({}) },
  workspace: { getConfiguration: () => ({ get: (k, d) => d }), onDidChangeConfiguration: () => ({}), registerTextDocumentContentProvider: () => ({}) },
  window: { registerWebviewViewProvider: (id, p) => { provider = p; return {}; }, onDidChangeActiveTextEditor: () => ({}), onDidChangeTextEditorSelection: () => ({}), createStatusBarItem: () => item },
  CodeActionKind: { QuickFix: 'quickfix' }, CodeAction: class {}, languages: { registerCodeActionsProvider: () => ({}), getDiagnostics: () => [] }, commands: { registerCommand: () => ({}) } };
const orig = Module._load; Module._load = function (r, ...a) { return r === 'vscode' ? vs : orig.call(this, r, ...a); };
require('../extension.js').activate({ subscriptions: [], extensionUri: {}, secrets: {}, globalState: { get() {}, update: async () => {} } });
let onVis;
const view = { visible: true, description: '', badge: undefined, show() {}, onDidChangeVisibility: (f) => { onVis = f; }, webview: { postMessage() {} } };
provider.view = view;
view.onDidChangeVisibility(() => { if (view.visible) { provider.unseenDone = false; provider.refreshStatus(); } }); // same wiring as resolveWebviewView
const state = (label) => { const s = `${label.padEnd(26)} title="${view.description}" badge=${view.badge ? view.badge.value : '-'} bar=${item.shown ? `"${item.text}"${item.backgroundColor ? ' (warning)' : ''}` : 'hidden'}`; console.log(s); };
(async () => {
  provider.onRecord({ type: 'agent_start' })
  assert(view.description === '🟡 working' && !view.badge && item.shown && /working/.test(item.text));
  // an approval card: red, badge, warning-coloured status bar
  const pending = provider.onUiRequest({ type: 'extension_ui_request', id: 'd1', method: 'select', title: 'Allow tool: edit\nFile: a.py', options: ['Approve', 'Deny'] });
  await new Promise((r) => setTimeout(r, 10))
  assert(view.description === '🔴 waiting for you' && view.badge?.value === 1 && item.backgroundColor?.id === 'statusBarItem.warningBackground');
  provider.client = { send() {}, request: async () => ({}) };
  await provider.onWebviewMessage({ type: 'dialogAnswer', id: 'd1', value: 'Approve' }); await pending
  assert(view.description === '🟡 working' && !view.badge);
  // finishes while the panel is hidden: blue "done" with a badge until you look
  view.visible = false; provider.onRecord({ type: 'agent_end' })
  assert(view.description === '🔵 done' && view.badge?.value === 1 && /done/.test(item.text));
  view.visible = true; onVis()
  assert(view.description === '' && !view.badge && !item.shown);
  // finishes with the panel in view: straight to idle
  provider.onRecord({ type: 'agent_start' }); provider.onRecord({ type: 'agent_end' })
  assert(view.description === '' && !item.shown);
  
})().catch((e) => { console.error(e); process.exit(1); });
