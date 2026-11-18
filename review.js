// Review omp's edits inside the editor: changed lines are highlighted, removed lines show on hover, and
// CodeLens buttons accept or reject each change (or the whole file). A file stays under review from omp's
// first edit until every change in it is accepted or rejected; the baseline is the file as it was then.
const fs = require('fs');
const vscode = require('vscode');

const files = new Map(); // fsPath -> { base: lines accepted so far, created, owner: chat to tell about rejections }
let t = (s) => s, emitter, addDeco, delDeco, baseDocs, statusItem;
const SCHEME = 'omp-review'; // the file as it was before omp's edits, for Compare

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

// The hunk the cursor is in; a pure deletion sits on the line after it.
const hunkAt = (hunks, line) => hunks.find((h) => line >= h.b0 && line < Math.max(h.b1, h.b0 + 1));

// What a deletion shows at the end of its line: how many lines went, and the first one that says something.
function removedLabel(old) {
  const first = old.find((l) => l.trim())?.trim() || '';
  const cut = first.length > 60 ? first.slice(0, 60) + '…' : first;
  return `−${old.length}` + (cut ? `  ${cut}${old.length > 1 ? '  …' : ''}` : '');
}

// Hunks of a file under review, open or not.
function hunksOfPath(k) {
  const doc = vscode.workspace.textDocuments?.find((d) => key(d.uri) === k);
  if (doc) return hunksOf(doc);
  let text = '';
  try { text = fs.readFileSync(k, 'utf8'); } catch {}
  return diffLines(files.get(k).base, split(text));
}

function refresh() {
  emitter?.fire();
  if (!addDeco) return;
  for (const ed of vscode.window.visibleTextEditors || []) paint(ed);
  for (const d of vscode.workspace.textDocuments || []) if (d.uri.scheme === SCHEME) baseDocs.fire(d.uri);
  const n = [...files.keys()].reduce((s, k) => s + hunksOfPath(k).length, 0);
  vscode.commands.executeCommand('setContext', 'ompChat.reviewing', n > 0);
  if (n) {
    statusItem.text = `$(diff) ${n} ${t(n > 1 ? 'changes to review' : 'change to review')}`;
    statusItem.show();
  } else statusItem.hide();
  updateInChange();
}

// Lets Alt+Y / Alt+N work only while the cursor is on a change.
function updateInChange() {
  const ed = vscode.window.activeTextEditor;
  const on = !!ed && files.has(key(ed.document.uri)) && !!hunkAt(hunksOf(ed.document), ed.selection.active.line);
  vscode.commands.executeCommand('setContext', 'ompChat.inChange', on);
}

function paint(ed) {
  const doc = ed.document, f = doc.uri.scheme === 'file' && files.get(key(doc.uri));
  const adds = [], dels = [];
  for (const h of f ? hunksOf(doc) : []) {
    if (h.b1 > h.b0) adds.push(new vscode.Range(h.b0, 0, h.b1 - 1, 0));
    if (h.a1 > h.a0) {
      const old = f.base.slice(h.a0, h.a1);
      dels.push({
        range: doc.lineAt(Math.min(h.b0, doc.lineCount - 1)).range,
        hoverMessage: new vscode.MarkdownString(`**${t('Removed')}** (${old.length})`).appendCodeblock(old.join('\n'), doc.languageId),
        renderOptions: { after: { contentText: removedLabel(old) } },
      });
    }
  }
  ed.setDecorations(addDeco, adds);
  ed.setDecorations(delDeco, dels);
}

function reveal(ed, line) {
  const p = new vscode.Position(Math.min(line, ed.document.lineCount - 1), 0);
  ed.selection = new vscode.Selection(p, p);
  ed.revealRange(new vscode.Range(p, p), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

// Next / previous change: within this file, then on to the next file under review (wrapping around).
async function nav(dir) {
  const ed = vscode.window.activeTextEditor, cur = ed && ed.document.uri.scheme === 'file' && key(ed.document.uri);
  if (cur && files.has(cur)) {
    const line = ed.selection.active.line, hs = hunksOf(ed.document);
    const h = dir > 0 ? hs.find((x) => x.b0 > line) : [...hs].reverse().find((x) => x.b0 < line);
    if (h) return reveal(ed, h.b0);
  }
  const order = [...files.keys()].filter((k) => hunksOfPath(k).length).sort();
  if (!order.length) return;
  const i = order.indexOf(cur);
  const next = order[i < 0 ? (dir > 0 ? 0 : order.length - 1) : (i + dir + order.length) % order.length];
  const ed2 = await vscode.window.showTextDocument(vscode.Uri.file(next), { preview: false });
  const hs = hunksOf(ed2.document);
  if (hs.length) reveal(ed2, (dir > 0 ? hs[0] : hs[hs.length - 1]).b0);
}

// Accept / reject the change under the cursor, then go on to the next one.
async function decideHere(accept) {
  const ed = vscode.window.activeTextEditor;
  if (!ed || !files.has(key(ed.document.uri))) return;
  const h = hunkAt(hunksOf(ed.document), ed.selection.active.line);
  if (!h) return;
  await decide(ed.document.uri, 0, accept, h.b0);
  if (files.size) await nav(1);
}

function compare(uri) {
  uri = uri || vscode.window.activeTextEditor?.document.uri;
  if (!uri || !files.has(key(uri))) return;
  const name = uri.path.split('/').pop();
  return vscode.commands.executeCommand('vscode.diff', uri.with({ scheme: SCHEME }), uri, `${name} (${t("before OMP's edits ↔ now")})`);
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
    after: { color: new vscode.ThemeColor('editorCodeLens.foreground'), margin: '0 0 0 2em', fontStyle: 'italic' },
    overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.deletedForeground'),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  });
  baseDocs = new vscode.EventEmitter();
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
  statusItem.command = 'ompChat.nextChange';
  statusItem.tooltip = t('Review OMP\'s edits: F7 next change, Shift+F7 previous, Alt+Y accept, Alt+N reject');
  const lens = (doc, line, title, command, args = [], tooltip) => new vscode.CodeLens(new vscode.Range(line, 0, line, 0),
    { title, command, tooltip, arguments: [doc.uri, ...args] });
  context.subscriptions.push(emitter, addDeco, delDeco, baseDocs, statusItem,
    vscode.languages.registerCodeLensProvider({ scheme: 'file' }, {
      onDidChangeCodeLenses: emitter.event,
      provideCodeLenses(doc) {
        const hs = hunksOf(doc), last = doc.lineCount - 1;
        if (!hs.length) return [];
        const out = [lens(doc, 0, `$(check-all) ${t('Accept all')} (${hs.length})`, 'ompChat.acceptAll'),
          lens(doc, 0, `$(discard) ${t('Reject all')}`, 'ompChat.rejectAll'),
          lens(doc, 0, `$(diff) ${t('Compare')}`, 'ompChat.compareReview', [], t("Side by side with the file before OMP's edits"))];
        hs.forEach((h, i) => {
          const at = Math.min(h.b0, last), of = hs.length > 1 ? ` ${i + 1}/${hs.length}` : '';
          out.push(lens(doc, at, `$(check) ${t('Accept')}${of}`, 'ompChat.acceptHunk', [i, h.b0], `${t('Accept')} (Alt+Y)`),
            lens(doc, at, `$(close) ${t('Reject')}`, 'ompChat.rejectHunk', [i, h.b0], `${t('Reject')} (Alt+N)`));
        });
        return out;
      },
    }),
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, {
      onDidChange: baseDocs.event,
      provideTextDocumentContent(u) {
        const f = files.get(key(u.fsPath));
        let eol = '\n';
        try { if (fs.readFileSync(u.fsPath, 'utf8').includes('\r\n')) eol = '\r\n'; } catch {}
        return f ? f.base.join(eol) : '';
      },
    }),
    vscode.commands.registerCommand('ompChat.acceptHunk', (uri, i, at) => decide(uri, i, true, at)),
    vscode.commands.registerCommand('ompChat.rejectHunk', (uri, i, at) => decide(uri, i, false, at)),
    vscode.commands.registerCommand('ompChat.acceptAll', (uri) => decideAll(uri || vscode.window.activeTextEditor?.document.uri, true)),
    vscode.commands.registerCommand('ompChat.rejectAll', (uri) => decideAll(uri || vscode.window.activeTextEditor?.document.uri, false)),
    vscode.commands.registerCommand('ompChat.nextChange', () => nav(1)),
    vscode.commands.registerCommand('ompChat.prevChange', () => nav(-1)),
    vscode.commands.registerCommand('ompChat.acceptChange', () => decideHere(true)),
    vscode.commands.registerCommand('ompChat.rejectChange', () => decideHere(false)),
    vscode.commands.registerCommand('ompChat.compareReview', (uri) => compare(uri)),
    vscode.workspace.onDidChangeTextDocument((e) => { if (e.document.uri.scheme === 'file' && files.has(key(e.document.uri))) refresh(); }),
    vscode.window.onDidChangeVisibleTextEditors(refresh),
    vscode.window.onDidChangeActiveTextEditor(updateInChange),
    vscode.window.onDidChangeTextEditorSelection(updateInChange));
}

module.exports = { register, track, diffLines, formatDiff, hunkAt, removedLabel, files, decide, decideAll };
