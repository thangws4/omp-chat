// A disposed client must not respawn omp on a late send/prompt (that omp would be tracked and killed by nobody).
const test = require('node:test');
const assert = require('node:assert');
const { OmpClient } = require('../omp-client');

test('send after dispose does not respawn', () => {
  const c = new OmpClient({ command: process.execPath, args: ['-e', 'process.stdin.resume()'], cwd: process.cwd(), env: process.env });
  c.start();
  const p = c.proc;
  c.dispose();
  p.kill();
  assert.strictEqual(c.prompt('hi'), null);
  assert.strictEqual(c.proc, null);
});
