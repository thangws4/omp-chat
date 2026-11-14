// Vietnamese UI: dictionary lookups, patterns, and the extension picking the dictionary from VS Code's language.
const assert = require('assert');
const path = require('path');
const l10n = require('../media/l10n');
const { activate, ROOT } = require('./helper');

const vi = require('../l10n/vi.json');
const d = l10n.compile(vi);
const tr = (s) => l10n.translate(d, s);

assert.strictEqual(tr('Send (Enter)'), 'Gửi (Enter)');
assert.strictEqual(tr('  Cancel '), '  Hủy ', 'surrounding spaces kept');
assert.strictEqual(tr('Something the dictionary does not know'), null);
assert.strictEqual(tr('3'), null, 'no letters: left alone');
assert.strictEqual(tr('Your models · 4'), 'Model của bạn · 4');
assert.strictEqual(tr('13k in · 312 out · $0.0021 · 14s'), '13k vào · 312 ra · $0.0021 · 14s');
assert.strictEqual(tr('2 files changed'), '2 file đã thay đổi');
assert.strictEqual(tr('Review a file · project'), 'Review a file · dự án này');
assert.strictEqual(tr('src/a.py\nSent with your next message.'), 'src/a.py\nGửi kèm tin nhắn tiếp theo.');
assert.strictEqual(tr('OpenCode Go — $10/mo plan: DeepSeek, Kimi, GLM, Qwen… (5h / weekly / monthly limits)'),
  'OpenCode Go — Gói $10/tháng: DeepSeek, Kimi, GLM, Qwen… (giới hạn 5 giờ / tuần / tháng)');
assert.strictEqual(tr('Limit reached on "work". Switched to "personal" and retrying…'), 'Key "work" đã chạm giới hạn. Đã chuyển sang "personal" và đang thử lại…');
assert.strictEqual(l10n.translate(null, 'Cancel'), null, 'English: no dictionary');

// every pattern compiles and every value is filled in; package.nls files have the same keys
assert(Object.values(vi.strings).every((v) => typeof v === 'string' && v));
const en = require('../package.nls.json'), nvi = require('../package.nls.vi.json');
assert.deepStrictEqual(Object.keys(nvi).sort(), Object.keys(en).sort());
const pkg = JSON.stringify(require('../package.json'));
for (const k of pkg.match(/%[\w.-]+%/g)) assert(k.slice(1, -1) in en, `${k} missing from package.nls.json`);

// the extension: Vietnamese VS Code -> Vietnamese status bar and panel title, dictionary handed to the panel
const item = { show() {}, hide() {} };
const { provider } = activate({
  vs: { env: { language: 'vi' }, window: { createStatusBarItem: () => item } },
  context: { extensionUri: { fsPath: ROOT } },
});
const view = { visible: true, description: '', show() {}, webview: { postMessage() {} } };
provider.view = view;
delete provider.post; // the real post() drives the status indicators
provider.onRecord({ type: 'agent_start' });
assert.strictEqual(view.description, '🟡 đang làm');
assert(/đang làm/.test(item.text));
const html = provider.html({ cspSource: '', asWebviewUri: (u) => u });
assert(html.includes('Hỏi về code của bạn') && html.includes('"Send (Enter)":"Gửi (Enter)"'));
assert.strictEqual(path.basename(ROOT).length > 0, true);
