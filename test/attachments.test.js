// Files attached to a message: uploads are saved for omp to read, files dragged from VS Code are used in place.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { activate } = require('./helper');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-attach-'));
const work = path.join(tmp, 'notes.md');
fs.writeFileSync(work, '# notes');
const { provider, posts } = activate({
  vs: { Uri: { parse: (s) => { const u = new URL(s); return { scheme: u.protocol.slice(0, -1), fsPath: decodeURIComponent(u.pathname).replace(/^\/([a-z]:)/i, '$1'), path: u.pathname }; } } },
  context: { globalStorageUri: { fsPath: path.join(tmp, 'storage') } },
});
const sent = [];
provider.client = { prompt: (m) => sent.push(m) };

(async () => {
  // an upload is written under the extension's storage and named in the message
  provider.busy = false;
  await provider.send('Summarise this', false, [], [], [{ name: 'report.pdf', mimeType: 'application/pdf', data: Buffer.from('%PDF-1.4').toString('base64') }]);
  const saved = /- (.+report\.pdf)\]/.exec(sent.at(-1))?.[1];
  assert(saved && saved.startsWith(path.join(tmp, 'storage', 'attachments')), sent.at(-1));
  assert.strictEqual(fs.readFileSync(saved, 'utf8'), '%PDF-1.4');
  assert(/read tool/.test(sent.at(-1)) && sent.at(-1).endsWith('Summarise this'));
  assert.deepStrictEqual(posts.filter((p) => p.type === 'user').at(-1).context, ['report.pdf']);

  // a file alone gets a short request; same names do not overwrite each other; unsafe names are cleaned
  provider.busy = false;
  await provider.send('', false, [], [], [{ name: 'a.txt', data: 'eA==' }, { name: 'a.txt', data: 'eQ==' }, { name: '../x:y.txt', data: 'eg==' }]);
  const paths = [...sent.at(-1).matchAll(/^- (.+?)\]?$/gm)].map((x) => x[1]);
  assert.deepStrictEqual(paths.map((p) => path.basename(p)), ['a.txt', 'a (2).txt', 'x_y.txt']);
  assert.deepStrictEqual(paths.map((p) => fs.readFileSync(p, 'utf8')), ['x', 'y', 'z']);
  assert(sent.at(-1).endsWith('See the attached files.'));

  // dragged from VS Code: URIs become paths (missing files dropped), used without copying
  posts.length = 0;
  await provider.onWebviewMessage({ type: 'dropUris', uris: ['file:///' + work.replace(/\\/g, '/'), 'file:///nowhere/gone.txt', 'https://x.y/z'] });
  const drop = posts.find((p) => p.type === 'attachPaths');
  assert.strictEqual(drop.list.length, 1);
  assert.strictEqual(path.resolve(drop.list[0].path), path.resolve(work));
  provider.busy = false;
  await provider.send('check', false, [], [], drop.list);
  assert(sent.at(-1).includes(`- ${drop.list[0].path}`));

  // nothing usable and no text: nothing sent
  const n = sent.length;
  provider.busy = false;
  await provider.send('', false, [], [], [{ name: 'big.bin', data: 'x'.repeat(28e6 + 1) }, { path: path.join(tmp, 'missing') }]);
  assert.strictEqual(sent.length, n);
  console.log('attachments ok');
})().catch((e) => { console.error(e); process.exit(1); });
