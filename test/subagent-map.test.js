// Subagent map: the tree data (who spawned whom, models, latest steps, timing) the map tab draws.
const assert = require('assert');
const { activate } = require('./helper');

(async () => {
  const panels = [];
  const createWebviewPanel = (type, title, column, opts) => {
    const p = { type, title, column, opts, posted: [], revealed: 0, disposed: false,
      webview: { html: '', cspSource: 'csp', asWebviewUri: () => 'uri', postMessage: async (m) => { p.posted.push(m); return true; },
        onDidReceiveMessage: (cb) => { p.recv = cb; return { dispose() {} }; } },
      reveal() { p.revealed++; },
      onDidDispose: (cb) => { p.onDispose = cb; return { dispose() {} }; },
      dispose() { if (p.disposed) return; p.disposed = true; p.onDispose?.(); } };
    panels.push(p);
    return p;
  };
  const { provider, posts } = activate({ vs: { window: { createWebviewPanel }, ViewColumn: { Active: -1 } }, context: { extensionUri: { fsPath: require('path').join(__dirname, '..') } } });
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

  // ---- the map tab ----
  provider.title = 'OMP Chat';
  provider.dictionary = null;
  let requestImpl = async (r) => (r.type === 'get_subagent_messages'
    ? { messages: [{ role: 'user', content: 'Find the session check' }, { role: 'assistant', content: [{ type: 'text', text: 'Reading' }, { type: 'toolCall', name: 'read', arguments: { path: 'a.ts' } }] }] }
    : {});
  provider.client.request = (r) => { requests.push(r); return requestImpl(r); };
  provider.map = null;
  await provider.openMap('A');
  assert.strictEqual(panels.length, 1);
  const panel = panels[0];
  assert.strictEqual(panel.title, 'Subagents · OMP Chat');
  assert.match(panel.webview.html, /id="tree"/);
  assert.match(panel.webview.html, /script-src 'nonce-/);
  await provider.openMap();
  assert.strictEqual(panels.length, 1, 'opened again: the same tab');
  assert.ok(panel.revealed >= 1);

  await panel.recv({ type: 'ready' });
  const state = panel.posted.filter((m) => m.type === 'state').pop();
  assert.strictEqual(state.agents.length, 4);
  assert.strictEqual(state.focus, 'A', 'the agent it was opened for');

  // picking an agent shows its conversation
  const fetches = () => requests.filter((r) => r.type === 'get_subagent_messages').length;
  const n0 = fetches();
  await panel.recv({ type: 'select', id: 'A' });
  assert.strictEqual(fetches(), n0 + 1);
  const tr = panel.posted.filter((m) => m.type === 'transcript').pop();
  assert.strictEqual(tr.id, 'A');
  assert.strictEqual(tr.messages[0].role, 'task');
  assert.deepStrictEqual(tr.messages[1].tools, [{ name: 'read', detail: 'a.ts' }]);

  // it follows the agent live, at most every ~700 ms
  provider.map.agentActivity('A');
  provider.map.agentActivity('A');
  provider.map.agentActivity('B'); // not the one open
  await new Promise((r) => setTimeout(r, 800));
  assert.strictEqual(fetches(), n0 + 2);

  // steer / stop; a failure shows in the map
  await panel.recv({ type: 'steer', id: 'A', text: 'skip legacy/' });
  assert.ok(requests.some((r) => r.type === 'steer_subagent' && r.subagentId === 'A' && r.message === 'skip legacy/'));
  requestImpl = async () => { throw new Error('not running'); };
  await panel.recv({ type: 'steer', id: 'B', text: 'hi' });
  assert.deepStrictEqual(panel.posted.filter((m) => m.type === 'error').pop(), { type: 'error', id: 'B', text: 'Could not message B: not running' });
  requestImpl = async () => ({});
  await panel.recv({ type: 'stop', id: 'A' });
  assert.ok(requests.some((r) => r.type === 'cancel_subagent' && r.subagentId === 'A'));

  // state changes reach the open tab
  const states = panel.posted.length;
  prog('A', { recentTools: [{ tool: 'edit', args: 'c.ts' }], toolCount: 10 });
  assert.ok(panel.posted.length > states);

  // a new conversation clears the map
  await provider.newSession?.();
  assert.strictEqual(provider.mapState().agents.length, 0);
  assert.strictEqual(provider.lead, null);
  assert.strictEqual(panel.posted.filter((m) => m.type === 'state').pop().agents.length, 0);

  // closing the chat closes its map
  provider.dispose();
  assert.ok(panel.disposed);
  assert.strictEqual(provider.map, null);
  console.log('subagent-map ok');
})().catch((e) => { console.error(e); process.exit(1); });
