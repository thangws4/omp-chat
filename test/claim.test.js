// A reply that says it wrote a file, with no write tool run and no such file, gets a warning.
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { activate } = require('./helper');
const { provider, posts } = activate();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-claim-'));
fs.mkdirSync(path.join(dir, 'docs/product'), { recursive: true });
fs.writeFileSync(path.join(dir, 'docs/product/prd.md'), '# prd');
provider.cwd = dir;
const turn = (text, tools = []) => {
  posts.length = 0;
  provider.onRecord({ type: 'agent_start' });
  for (const t of tools) provider.onRecord({ type: 'tool_execution_start', toolCallId: t, toolName: t, args: {} });
  provider.onRecord({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: text } });
  provider.onRecord({ type: 'agent_end' });
  return posts.find((p) => p.type === 'notice');
};
try {
  const n = turn('**Đã tạo file spec.md.** Tôi đã viết file `docs/product/spec.md` theo chuẩn Superpowers.');
  assert(n && /docs\/product\/spec\.md/.test(n.text) && n.actions[0].cmd === 'pickModel');
  assert(!turn('Đã tạo file `docs/product/spec.md`.', ['write']), 'a write tool ran: no warning');
  assert(!turn('I updated `docs/product/prd.md` with the scope.'), 'file exists: no warning');
  assert(!turn('The project has docs/product/prd.md and an architecture.md.'), 'no claim verb: no warning');
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
