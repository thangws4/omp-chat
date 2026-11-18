// In-editor review: line diff, and Accept / Reject per hunk and per file against a fake document.
const assert = require('assert');
const { activate } = require('./helper');

let text = '', crlf = false;
const lines = () => text.split(/\r?\n/);
const eolLen = () => (crlf ? 2 : 1); // a document keeps its line endings whatever the text
const off = (p) => lines().slice(0, p.line).reduce((n, l) => n + l.length + eolLen(), 0) + p.character;
const doc = {
  uri: { scheme: 'file', fsPath: '/w/a.js', path: '/w/a.js' },
  get eol() { return eolLen(); },
  get lineCount() { return lines().length; },
  lineAt: (i) => ({ range: { end: { line: i, character: lines()[i].length } } }),
  getText: () => text, isDirty: false, save: async () => {},
};
class Position { constructor(line, character) { this.line = line; this.character = character; } }
class Range {
  constructor(a, b, c, d) {
    if (typeof a === 'object') { this.start = a; this.end = b; } else { this.start = new Position(a, b); this.end = new Position(c, d); }
  }
}
const { provider } = activate({ vs: {
  Position, Range, EndOfLine: { LF: 1, CRLF: 2 },
  WorkspaceEdit: class { replace(u, r, t) { this.r = r; this.t = t; } },
  workspace: { openTextDocument: async () => doc, applyEdit: async (we) => { text = text.slice(0, off(we.r.start)) + we.t + text.slice(off(we.r.end)); } },
} });
const review = require('../review');

// diff
assert.deepStrictEqual(review.diffLines(['a', 'b', 'c'], ['a', 'b', 'c']), []);
assert.deepStrictEqual(review.diffLines(['a', 'b', 'c'], ['a', 'X', 'c']), [{ a0: 1, a1: 2, b0: 1, b1: 2 }]);
assert.deepStrictEqual(review.diffLines(['a', 'b', 'c', 'd'], ['X', 'b', 'c']), [{ a0: 0, a1: 1, b0: 0, b1: 1 }, { a0: 3, a1: 4, b0: 3, b1: 3 }]);

// Rejecting every hunk restores the original exactly; accepting every hunk keeps the new text and ends the review.
const rnd = (n) => Array.from({ length: Math.floor(Math.random() * n) }, () => 'abcde'[Math.floor(Math.random() * 5)]);
(async () => {
  for (let k = 0; k < 400; k++) {
    const eol = k % 3 ? '\n' : '\r\n';
    const a = rnd(8).join(eol) + (k % 2 ? eol : ''), b = rnd(8).join(eol) + (k % 5 ? eol : '');
    if (a === b) continue; // nothing to review (the file may not have reloaded yet, so it stays tracked)
    for (const accept of [false, true]) {
      review.files.clear();
      text = b; crlf = eol === '\r\n';
      review.track('/w/a.js', a, false, provider);
      let guard = 20;
      while (review.files.size && guard--) await review.decide(doc.uri, 0, accept);
      assert.strictEqual(review.files.size, 0, `review ended: ${JSON.stringify({ a, b, accept })}`);
      assert.strictEqual(text, accept ? b : a, JSON.stringify({ a, b, accept }));
    }
  }

  // Reject all: back to the original; the chat is told.
  review.files.clear();
  provider.notes = [];
  text = 'one\nTWO\nthree\n'; crlf = false;
  review.track('/w/a.js', 'one\ntwo\nthree\n', false, provider);
  await review.decideAll(doc.uri, false);
  assert.strictEqual(text, 'one\ntwo\nthree\n');
  assert(/rejected your changes/.test(provider.notes[0]));

  // Replayed conversations do not start a review; live edits do.
  review.files.clear();
  provider.onRecord({ type: 'tool_execution_end', toolCallId: 't1', toolName: 'edit',
    result: { details: { path: '/w/b.js', oldText: 'x\n', newText: 'y\n' } } });
  assert.deepStrictEqual(review.files.get('/w/b.js')?.base, ['x', '']);
  review.files.clear();
  provider.replay([{ role: 'assistant', content: [{ type: 'toolCall', id: 't2', name: 'edit', arguments: { path: '/w/c.js' } }] },
    { role: 'toolResult', toolCallId: 't2', toolName: 'edit', content: [], details: { path: '/w/c.js', oldText: 'x\n', newText: 'y\n' } }]);
  assert(!review.files.has('/w/c.js'));
  console.log('review ok');
})().catch((e) => { console.error(e); process.exit(1); });
