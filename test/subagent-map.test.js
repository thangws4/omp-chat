// Subagent map: the tree data (who spawned whom, models, latest steps, timing) the map tab draws.
const assert = require('assert');
const { activate } = require('./helper');

(async () => {
  const { provider, posts } = activate();
  provider.listSkills = async () => []; // no `omp skill list` in tests
  const requests = [];
  provider.client = { prompt() {}, dispose() {}, request: async (r) => { requests.push(r); return { messages: [] }; } };

  // ---- the lead: your latest message and its time ----
  await provider.send('Add login\nmore detail', false);
  assert.strictEqual(provider.lead.task, 'Add login');
  assert.strictEqual(typeof provider.lead.startedAt, 'number');
  assert.strictEqual(provider.lead.endedAt, null);

  const life = (id, status, parentToolCallId) => provider.onRecord({ type: 'subagent_lifecycle', payload: { id, agent: 'task', status, parentToolCallId, index: 0 } });
  const prog = (id, progress) => provider.onRecord({ type: 'subagent_progress', payload: { id, agent: 'task', task: 't', index: 0, progress: { id, status: 'running', ...progress } } });
  const ev = (id, event) => provider.onRecord({ type: 'subagent_event', payload: { id, event } });

  life('A', 'started', 'c1');
  life('B', 'started', 'c2');
  ev('A', { type: 'tool_execution_start', toolName: 'task', toolCallId: 'a-t1', args: {} }); // A spawns A1
  life('A1', 'started', 'a-t1');
  prog('A', { recentTools: [{ tool: 'read', args: 'b.ts' }, { tool: 'grep', args: 'x'.repeat(300) }], resolvedModel: 'deepseek/v4', toolCount: 9 });
  life('C', 'started', 'unknown-call'); // its parent's task call was never seen: under the lead, not lost

  const byId = () => Object.fromEntries(provider.mapState().agents.map((a) => [a.id, a]));
  let a = byId();
  assert.deepStrictEqual(Object.keys(a).sort(), ['A', 'A1', 'B', 'C']);
  assert.strictEqual(a.A.parentAgent, null);
  assert.strictEqual(a.B.parentAgent, null);
  assert.strictEqual(a.A1.parentAgent, 'A');
  assert.strictEqual(a.C.parentAgent, null);
  assert.deepStrictEqual(a.A.steps, [{ tool: 'grep', args: 'x'.repeat(120) }, { tool: 'read', args: 'b.ts' }], 'oldest first, args capped');
  assert.strictEqual(a.A.model, 'deepseek/v4');
  assert.strictEqual(a.A.tools, 9);
  assert.strictEqual(typeof a.A.startedAt, 'number');
  assert.strictEqual(a.A.endedAt, null);
  assert.strictEqual(provider.mapState().lead.task, 'Add login');

  life('B', 'completed');
  a = byId();
  assert.strictEqual(a.B.status, 'completed');
  assert.strictEqual(typeof a.B.endedAt, 'number');

  // other subagent events (text deltas…) are dropped: nothing posted, nothing stored
  const before = posts.length;
  ev('A', { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'hi' } });
  ev('A', { type: 'tool_execution_start', toolName: 'read', toolCallId: 'a-r1', args: {} });
  assert.strictEqual(posts.length, before);
  assert.ok(!provider.taskCalls.has('a-r1'));

  // the turn ends: the lead's clock stops
  provider.onStatusEvent('idle');
  assert.strictEqual(typeof provider.lead.endedAt, 'number');

  // a new conversation clears the map
  await provider.newSession?.();
  assert.strictEqual(provider.mapState().agents.length, 0);
  assert.strictEqual(provider.lead, null);
  console.log('subagent-map ok');
})().catch((e) => { console.error(e); process.exit(1); });
