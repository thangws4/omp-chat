// Review omp's edits inside the editor: changed lines are highlighted, removed lines show on hover, and
// CodeLens buttons accept or reject each change (or the whole file). A file stays under review from omp's
// first edit until every change in it is accepted or rejected; the baseline is the file as it was then.
const fs = require('fs');
const vscode = require('vscode');

const files = new Map(); // fsPath -> { base: lines accepted so far, created, owner: chat to tell about rejections }
let t = (s) => s, emitter, addDeco, delDeco;

const split = (s) => String(s).split(/\r?\n/);
const key = (p) => vscode.Uri.file(typeof p === 'string' ? p : p.fsPath).fsPath; // same drive-letter case as VS Code

// Line diff of a -> b as hunks { a0, a1, b0, b1 } (half-open line ranges).
function diffLines(a, b) {
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length, eb = b.length;
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) { ea--; eb--; }
  const n = ea - s, m = eb - s;
  if (!n && !m) return [];
  // ponytail: O(n·m) LCS on the changed middle only; past 4M cells it is one big hunk. Myers if that bites.
  if (n * m > 4e6) return [{ a0: s, a1: ea, b0: s, b1: eb }];
  const w = m + 1, L = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      L[i * w + j] = a[s + i] === b[s + j] ? L[(i + 1) * w + j + 1] + 1 : Math.max(L[(i + 1) * w + j], L[i * w + j + 1]);
    }
  }
  const out = [];
  let i = 0, j = 0, h = null;
  while (i < n || j < m) {
    if (i < n && j < m && a[s + i] === b[s + j]) { h = null; i++; j++; continue; }
    if (!h) out.push(h = { a0: s + i, a1: s + i, b0: s + j, b1: s + j });
    if (j < m && (i >= n || L[i * w + j + 1] >= L[(i + 1) * w + j])) { j++; h.b1++; } else { i++; h.a1++; }
  }
  return out;
}

// a -> b in omp's diff format ("+12|code", "-12|code", " 12|code" for context, "" between hunks), for the
// changes omp reports without a diff (the write tool).
function formatDiff(oldText, newText, ctx = 2) {
  const a = oldText ? split(oldText) : [], b = newText ? split(newText) : [];
  const hunks = diffLines(a, b), out = [];
  let shown = 0; // lines of b already printed
  hunks.forEach((h, k) => {
    const from = Math.max(shown, h.b0 - ctx);
    if (out.length && from > shown) out.push('');
    for (let j = from; j < h.b0; j++) out.push(` ${j + 1}|${b[j]}`);
    for (let i = h.a0; i < h.a1; i++) out.push(`-${i + 1}|${a[i]}`);
    for (let j = h.b0; j < h.b1; j++) out.push(`+${j + 1}|${b[j]}`);
    shown = Math.min(b.length, h.b1 + ctx, hunks[k + 1]?.b0 ?? Infinity);
    for (let j = h.b1; j < shown; j++) out.push(` ${j + 1}|${b[j]}`);
  });
  return out.join('\n');
}

const hunksOf = (doc) => {
  const f = files.get(key(doc.uri));
  return f ? diffLines(f.base, split(doc.getText())) : [];
};

// Called for each live omp edit; later edits to the same file keep the first baseline.
function track(file, oldText, created, owner) {
  const k = key(file);
  if (!files.has(k)) files.set(k, { base: split(oldText), created, owner });
  refresh();
}

function refresh() {
  emitter?.fire();
  if (!addDeco) return;
  for (const ed of vscode.window.visibleTextEditors || []) paint(ed);
}

function paint(ed) {
  const doc = ed.document, f = files.get(key(doc.uri));
  const adds = [], dels = [];
  for (const h of f ? hunksOf(doc) : []) {
    if (h.b1 > h.b0) adds.push(new vscode.Range(h.b0, 0, h.b1 - 1, 0));
    if (h.a1 > h.a0) {
      const old = f.base.slice(h.a0, h.a1);
      dels.push({
        range: doc.lineAt(Math.min(h.b0, doc.lineCount - 1)).range,
        hoverMessage: new vscode.MarkdownString().appendCodeblock(old.join('\n'), doc.languageId),
        renderOptions: { after: { contentText: `−${old.length} ${t('removed (hover to see)')}` } },
      });
    }
  }
  ed.setDecorations(addDeco, adds);
  ed.setDecorations(delDeco, dels);
}

// Replace lines [b0, b1) of the document with `lines`, keeping its line endings, and save it if it was saved before
// (omp reads the file from disk).
async function replaceLines(doc, b0, b1, lines) {
  const eol = doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n', n = doc.lineCount, end = doc.lineAt(n - 1).range.end;
  let range, text;
  if (b1 < n) { range = new vscode.Range(b0, 0, b1, 0); text = lines.map((l) => l + eol).join(''); }
  else if (b0 > 0) { range = new vscode.Range(doc.lineAt(b0 - 1).range.end, end); text = lines.map((l) => eol + l).join(''); }
  else { range = new vscode.Range(new vscode.Position(0, 0), end); text = lines.join(eol); }
  const dirty = doc.isDirty, we = new vscode.WorkspaceEdit();
  we.replace(doc.uri, range, text);
  await vscode.workspace.applyEdit(we);
  if (!dirty) await doc.save();
}

const tell = (f, uri, what) => f.owner?.notes?.push(
  `[Note: the user rejected ${what} to ${vscode.workspace.asRelativePath(uri)}; that part is back to its previous content.]`);

// `at` (the hunk's first line, from its CodeLens) finds the same hunk even if the file changed since the
// lens was drawn; the index alone could then point at another change.
async function decide(uri, i, accept, at) {
  const doc = await vscode.workspace.openTextDocument(uri), f = files.get(key(uri)), hs = hunksOf(doc);
  const h = at === undefined ? hs[i] : hs.find((x) => x.b0 === at);
  if (!f || !h) return;
  if (accept) f.base.splice(h.a0, h.a1 - h.a0, ...split(doc.getText()).slice(h.b0, h.b1));
  else { await replaceLines(doc, h.b0, h.b1, f.base.slice(h.a0, h.a1)); tell(f, uri, 'part of your change'); }
  if (!hunksOf(doc).length) files.delete(key(uri));
  refresh();
}

async function decideAll(uri, accept) {
  const f = uri && files.get(key(uri));
  if (!f) return;
  files.delete(key(uri));
  if (!accept) {
    if (f.created) {
      const we = new vscode.WorkspaceEdit();
      we.deleteFile(uri, { ignoreIfNotExists: true });
      await vscode.workspace.applyEdit(we);
      if (fs.existsSync(uri.fsPath)) fs.rmSync(uri.fsPath, { force: true });
    } else {
      const doc = await vscode.workspace.openTextDocument(uri);
      await replaceLines(doc, 0, doc.lineCount, f.base);
    }
    tell(f, uri, 'your changes');
  }
  refresh();
}

function register(context, translate) {
  if (!vscode.window.createTextEditorDecorationType) return; // the test stub has no editor
  t = translate;
  emitter = new vscode.EventEmitter();
  addDeco = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
    overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.addedForeground'),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  });
  delDeco = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    borderColor: new vscode.ThemeColor('editorGutter.deletedBackground'),
    borderStyle: 'solid',
    borderWidth: '1px 0 0 0',
    after: { color: new vscode.ThemeColor('editorCodeLens.foreground'), margin: '0 0 0 2em' },
    overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.deletedForeground'),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  });
  const lens = (doc, line, title, command, ...args) => new vscode.CodeLens(new vscode.Range(line, 0, line, 0),
    { title, command, arguments: [doc.uri, ...args] });
  context.subscriptions.push(emitter, addDeco, delDeco,
    vscode.languages.registerCodeLensProvider({ scheme: 'file' }, {
      onDidChangeCodeLenses: emitter.event,
      provideCodeLenses(doc) {
        const hs = hunksOf(doc), last = doc.lineCount - 1;
        if (!hs.length) return [];
        const out = [lens(doc, 0, `$(check-all) ${t('Accept all')} (${hs.length})`, 'ompChat.acceptAll'),
          lens(doc, 0, `$(discard) ${t('Reject all')}`, 'ompChat.rejectAll')];
        hs.forEach((h, i) => out.push(lens(doc, Math.min(h.b0, last), `$(check) ${t('Accept')}`, 'ompChat.acceptHunk', i, h.b0),
          lens(doc, Math.min(h.b0, last), `$(close) ${t('Reject')}`, 'ompChat.rejectHunk', i, h.b0)));
        return out;
      },
    }),
    vscode.commands.registerCommand('ompChat.acceptHunk', (uri, i, at) => decide(uri, i, true, at)),
    vscode.commands.registerCommand('ompChat.rejectHunk', (uri, i, at) => decide(uri, i, false, at)),
    vscode.commands.registerCommand('ompChat.acceptAll', (uri) => decideAll(uri || vscode.window.activeTextEditor?.document.uri, true)),
    vscode.commands.registerCommand('ompChat.rejectAll', (uri) => decideAll(uri || vscode.window.activeTextEditor?.document.uri, false)),
    vscode.workspace.onDidChangeTextDocument((e) => { if (files.has(key(e.document.uri))) refresh(); }),
    vscode.window.onDidChangeVisibleTextEditors(refresh));
}

module.exports = { register, track, diffLines, formatDiff, files, decide, decideAll };
