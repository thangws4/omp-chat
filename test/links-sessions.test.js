// File links in replies, code blocks to the editor, renaming / deleting conversations, thinking level.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { activate } = require('./helper');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-chat-'));
const sessions = path.join(tmp, 'sessions');
fs.mkdirSync(path.join(tmp, 'src'));
fs.mkdirSync(sessions);
fs.writeFileSync(path.join(tmp, 'src', 'a.ts'), 'x\n');

let opened = null, inputBox = 'Renamed chat', warn = 'Delete', deleted = null, docOpts = null;
const cfg = {};
const { provider, posts, last } = activate({ vs: {
  Position: class { constructor(l, c) { this.line = l; this.character = c; } },
  Range: class { constructor(a, b) { this.start = a; this.end = b; } },
  ConfigurationTarget: { Global: 1 },
  window: { showTextDocument: async (u, o) => { opened = { u, o }; }, showInputBox: async () => inputBox, showWarningMessage: async () => warn },
  workspace: { fs: { delete: async (u) => { deleted = u.fsPath; fs.unlinkSync(u.fsPath); } },
    openTextDocument: async (o) => { if (o.language === 'nope') throw new Error('unknown language'); docOpts = o; return o; },
    getConfiguration: () => ({ get: (k, d) => (k in cfg ? cfg[k] : d), update: async (k, v) => { cfg[k] = v; } }) },
} });
const { parseFileRef, titleHeader } = require('../extension')._test;

(async () => {
  // file references as models write them
  assert.deepStrictEqual(parseFileRef('src/a.ts:12:3'), { file: 'src/a.ts', line: 12, col: 3 });
  assert.deepStrictEqual(parseFileRef('src/a.ts#L7-L9'), { file: 'src/a.ts', line: 7, col: 0 });
  assert.deepStrictEqual(parseFileRef('C:\\x\\a.ts:4'), { file: 'C:\\x\\a.ts', line: 4, col: 0 });
  assert.deepStrictEqual(parseFileRef('a.ts'), { file: 'a.ts', line: 0, col: 0 });

  // only spans that are real files become links; opening goes to the line
  provider.cwd = tmp;
  await provider.onWebviewMessage({ type: 'checkPaths', refs: ['src/a.ts:3', 'console.log', 'src/missing.ts'] });
  assert.deepStrictEqual(last('paths').ok, ['src/a.ts:3']);
  await provider.onWebviewMessage({ type: 'openFile', ref: 'src/a.ts:3:2' });
  assert.strictEqual(opened.u.fsPath, path.join(tmp, 'src', 'a.ts'));
  assert.deepStrictEqual([opened.o.selection.start.line, opened.o.selection.start.character], [2, 1]);
  await provider.onWebviewMessage({ type: 'openFile', ref: 'nope.ts' });
  assert.match(last('notice').text, /Could not find nope\.ts/);

  // code block -> new file, with the fence's language mapped to a VS Code id (unknown ids fall back to plain)
  await provider.onWebviewMessage({ type: 'newFileFromCode', code: 'print(1)', lang: 'py' });
  assert.deepStrictEqual(docOpts, { content: 'print(1)', language: 'python' });
  await provider.onWebviewMessage({ type: 'newFileFromCode', code: 'x', lang: 'nope' });
  assert.deepStrictEqual(docOpts, { content: 'x' });

  // the title line is rewritten at the same length, so what omp appends is never touched
  const head = JSON.stringify({ type: 'title', v: 1, title: '', updatedAt: '2026-01-01T00:00:00.000Z', pad: ' '.repeat(120) });
  const line = titleHeader(head, 'Hello');
  assert.strictEqual(Buffer.byteLength(line), Buffer.byteLength(head));
  assert.strictEqual(JSON.parse(line).title, 'Hello');
  assert.strictEqual(titleHeader(head, 'x'.repeat(500)), null, 'too long for the padding');
  assert.strictEqual(titleHeader('{"type":"session"}', 'x'), null);

  const file = path.join(sessions, 's1.jsonl');
  const body = '\n{"type":"message","message":{"role":"user","content":"first question"}}\n';
  fs.writeFileSync(file, head + body);
  provider.pickSession = async () => posts.push({ type: 'listed' });
  provider.sessionDir = sessions;
  await provider.onWebviewMessage({ type: 'renameSession', file });
  const text = fs.readFileSync(file, 'utf8');
  assert.strictEqual(JSON.parse(text.split('\n')[0]).title, 'Renamed chat');
  assert.ok(text.endsWith(body), 'rest of the file unchanged');
  assert.strictEqual(last('listed').type, 'listed', 'list shown again');

  // files outside the folder's sessions are refused
  const outside = path.join(tmp, 'other.jsonl');
  fs.writeFileSync(outside, head + body);
  await provider.onWebviewMessage({ type: 'deleteSession', file: outside });
  assert.strictEqual(deleted, null);

  // delete: asks first; cancelling keeps it, deleting the current conversation starts a new one
  warn = undefined;
  await provider.onWebviewMessage({ type: 'deleteSession', file });
  assert.strictEqual(deleted, null);
  warn = 'Delete';
  let fresh = false;
  provider.newSession = async () => { fresh = true; };
  provider.sessionFile = file;
  await provider.onWebviewMessage({ type: 'deleteSession', file });
  assert.strictEqual(deleted, file);
  assert.ok(fresh);

  // thinking level: changed inside the running omp, without a restart
  const reqs = [];
  provider.client = { request: async (r) => { reqs.push(r); return {}; } };
  provider.restart = async () => { throw new Error('should not restart'); };
  await provider.onWebviewMessage({ type: 'setThinking', level: 'high' });
  assert.strictEqual(cfg.thinkingLevel, 'high');
  await provider.onConfigChange({ affectsConfiguration: (k) => k === 'ompChat' || k === 'ompChat.thinkingLevel' });
  assert.deepStrictEqual(reqs.at(-1), { type: 'set_thinking_level', level: 'high' });
  assert.strictEqual(last('thinking_level').level, 'high');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('links-sessions ok');
})().catch((e) => { console.error(e); process.exit(1); });
