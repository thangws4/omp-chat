// Pinned files, @problems / @terminal, Explain / Fix, per-turn cost, Markdown export.
const assert = require('assert');
const { activate } = require('./helper');

const R = (l) => ({ start: { line: l, character: 0 }, end: { line: l, character: 5 } });
const fileUri = (p) => ({ scheme: 'file', path: p, fsPath: p });
const diags = [
  [fileUri('src/calc.py'), [{ severity: 0, message: 'undefined name x', source: 'pyflakes', range: R(11) }, { severity: 3, message: 'hint', range: R(2) }]],
  [fileUri('src/b.js'), [{ severity: 1, message: 'unused var\nmore', range: R(0) }]],
];
let clip = 'user clipboard', term = null, doc = null, editor = null;
const ran = [];
const { provider, posts, last } = activate({ vs: {
  languages: { getDiagnostics: (uri) => (uri ? diags.find(([u]) => u.path === uri.path)?.[1] || [] : diags) },
  env: { openExternal() {}, clipboard: { readText: async () => clip, writeText: async (t) => { clip = t; } } },
  commands: { executeCommand: async (c) => { ran.push(c); if (c.endsWith('copySelection') && term) clip = term; } },
  window: { get activeTerminal() { return term && { name: 'bash' }; }, get activeTextEditor() { return editor; },
    showTextDocument: async () => {} },
  workspace: { openTextDocument: async (o) => { doc = o; return o; } },
} });
const sent = [];
provider.client = { prompt: (m) => sent.push(m), request: async () => ({ messages: [] }) };
provider.ensureClient = async () => provider.client;
provider.autoPick = async () => [];
const send = async (...a) => { provider.busy = false; await provider.send(...a); return sent.at(-1); };

(async () => {
  // pinned files ride along with every message, shown as chips on your bubble
  provider.pinFile('src/a.py');
  provider.pinFile(fileUri('src/b.js'));
  provider.pinFile('src/a.py'); // no duplicates
  assert.deepStrictEqual(last('context').pinned.map((p) => p.rel), ['src/a.py', 'src/b.js']);
  assert.strictEqual(await send('look', false), '[Attached files: src/a.py, src/b.js]\n\nlook');
  assert.deepStrictEqual(last('user').context, ['src/a.py', 'src/b.js']);
  assert.strictEqual(await send('/session', false), '/session', 'slash commands stay verbatim');
  provider.unpinFile('src/a.py');
  provider.unpinFile('src/b.js');

  // @problems: errors and warnings only, first line of each message
  let m = await send('fix @problems please', false);
  assert(m.startsWith('[Problems in the workspace]\n```\nsrc/calc.py:12: [error] undefined name x (pyflakes)\nsrc/b.js:1: [warning] unused var\n```\n\nfix @problems please'), m);
  assert.strictEqual(last('user').text, 'fix @problems please');

  // @terminal: copied through the clipboard, which is put back
  term = 'line1\nnpm ERR! boom\n\n';
  m = await send('why @terminal', false);
  assert(m.startsWith('[Terminal output: bash]\n```\nline1\nnpm ERR! boom\n```'), m);
  assert.strictEqual(clip, 'user clipboard');
  term = null;
  assert(/No terminal is open/.test(await send('@terminal', false)));

  // replay / rewind strip all of it back to what you typed
  const { splitUserText, toMarkdown } = require('../extension.js')._test;
  assert.deepStrictEqual(splitUserText('[Current file: x.py]\n\n[Attached files: a.py, b.js]\n\n[Problems in the workspace]\n```\nq\n```\n\nhi'),
    { text: 'hi', context: 'x.py', files: ['a.py', 'b.js'] });

  // Fix with OMP Chat (light bulb): the problems on that line, short text in your bubble
  m = await (async () => { provider.busy = false; await provider.editorAction('fix', fileUri('src/calc.py'), R(11)); return sent.at(-1); })();
  assert.strictEqual(last('user').text, 'Fix the problem in src/calc.py:12');
  assert(m.startsWith('[Problems in src/calc.py]\n```\nsrc/calc.py:12: [error] undefined name x (pyflakes)\n```\n\nFix the problem'), m);
  // Explain: the selection goes along as context
  editor = { document: { uri: fileUri('src/calc.py'), languageId: 'python', getText: () => 'x = 1' },
    selection: { isEmpty: false, start: { line: 0 }, end: { line: 0, character: 5 } } };
  provider.busy = false; await provider.editorAction('explain');
  assert.strictEqual(sent.at(-1), '[Selection from src/calc.py:1-1]\n```python\nx = 1\n```\n\nExplain this code.');

  // per-turn tokens and cost, summed over the turn's model calls
  posts.length = 0;
  const usage = (i, o, c) => ({ input: i, output: o, cacheRead: 0, cacheWrite: 0, cost: { total: c } });
  provider.onRecord({ type: 'agent_start' });
  provider.onRecord({ type: 'message_end', message: { role: 'assistant', content: [], usage: usage(1000, 50, 0.001) } });
  provider.onRecord({ type: 'message_end', message: { role: 'assistant', content: [], usage: usage(1200, 80, 0.002) } });
  provider.onRecord({ type: 'agent_end' });
  const st = last('turnStats');
  assert(st && st.input === 2200 && st.output === 130 && Math.abs(st.cost - 0.003) < 1e-9);
  assert(posts.indexOf(st) < posts.findIndex((p) => p.type === 'idle'), 'stats arrive before idle');

  // export: the conversation as Markdown, injected context stripped
  const md = toMarkdown([
    { role: 'user', content: '[Current file: a.py]\n\nexplain' },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'hm' }, { type: 'text', text: 'It adds.' }, { type: 'toolCall', name: 'read', arguments: { path: 'a.py' } }] },
    { role: 'bashExecution', command: 'ls', output: 'a.py\n' },
  ], 'openrouter/x');
  assert(md.includes('## You  \n_a.py_\n\nexplain') && md.includes('## OMP\n\nIt adds.\n\n> 🔧 **read** `a.py`') && md.includes('$ ls\na.py'), md);
  assert(!md.includes('hm'), 'thinking is left out');
  provider.client.request = async () => ({ messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: [{ type: 'text', text: 'yo' }] }] });
  await provider.exportChat();
  assert(doc && doc.language === 'markdown' && /## OMP\n\nyo/.test(doc.content));
  doc = null; provider.client.request = async () => ({ messages: [] });
  await provider.exportChat();
  assert(!doc && last('notice').text === 'Nothing to export yet.');
})().catch((e) => { console.error(e); process.exit(1); });
