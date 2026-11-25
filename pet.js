// Victor, the mascot, walks along a small Explorer view (with Timeline, bottom left). Under him: the chat's context
// fill, its plan window or gateway quota, the AI's unreviewed diff, and each changed file with Accept / Reject.
'use strict';
const vscode = require('vscode');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const review = require('./review');

class PetView {
  // pick(lastChat): the chat a click opens Usage & limits in (the last one that reported, while it is still open).
  constructor(context, pick) {
    this.context = context;
    this.pick = pick;
    this.state = { meter: null, files: [] };
    context.subscriptions.push(review.onChange(() => this.diff()));
  }

  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')] };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((m) => {
      if (m.type === 'ready') this.diff();
      if (m.type === 'usage') this.pick(this.chat)?.showUsage();
      if (m.type === 'open') vscode.window.showTextDocument(vscode.Uri.file(m.path), { preview: true });
      // the same calls as the chat's Review Bar: one file, or every chat's files
      if (m.type === 'decide') m.path ? review.decideAll(vscode.Uri.file(m.path), m.accept) : review.decideOwner(null, m.accept);
    });
    view.onDidDispose(() => { this.view = null; });
  }

  // ponytail: the chat that reported last wins; follow the focused chat if several running at once ever confuses.
  meter(chat, msg) {
    this.chat = chat;
    this.state.meter = msg;
    this.send();
  }

  diff() {
    this.state.files = review.pendingSummary(); // every chat's unreviewed edits
    this.send();
  }

  send() { this.view?.webview.postMessage({ type: 'pet', ...this.state }); }

  html(webview) {
    const nonce = crypto.randomBytes(16).toString('hex');
    const media = (f) => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', f));
    const mascot = fs.readFileSync(path.join(this.context.extensionUri.fsPath, 'media', 'mascot.svg'), 'utf8');
    // main.css gives the mascot its theme colours and the shared --omp-* tokens; everything here is prefixed v- so
    // none of its panel classes apply.
    return `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'nonce-${nonce}'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${media('vendor/codicons/codicon.css')}">
<link rel="stylesheet" href="${media('main.css')}">
<style nonce="${nonce}">
  body { padding: 8px 10px 10px; overflow: auto; font-size: 12px; color: var(--vscode-foreground); }
  button { padding: 0; }

  /* stage: a soft strip with a ground line Victor walks on */
  .v-stage {
    position: relative; height: 54px; /* the caption stays above Victor's ears */ border-radius: var(--omp-r-md); cursor: pointer; overflow: hidden;
    background: linear-gradient(to bottom, transparent 55%, color-mix(in srgb, var(--vscode-foreground) 5%, transparent));
    border: 1px solid var(--omp-border);
  }
  .v-stage:hover { border-color: var(--omp-border-strong); }
  .v-stage::after { content: ''; position: absolute; left: 8px; right: 8px; bottom: 7px; border-top: 1px dashed var(--omp-border-strong); }
  .v-say { position: absolute; top: 5px; left: 9px; font-size: 10.5px; color: var(--vscode-descriptionForeground); }
  #victor { position: absolute; bottom: 4px; /* the SVG's viewBox leaves ~3px under the paws */ width: 28px; height: 28px;
    animation: v-walk 16s linear infinite; z-index: 1; }
  #victor .mascot { animation: v-step .5s steps(2) infinite; }
  /* the SVG's tail is on its right, so it faces left: flipped while walking right */
  @keyframes v-walk {
    0% { left: 6px; transform: scaleX(-1); }
    47% { left: calc(100% - 34px); transform: scaleX(-1); }
    50% { left: calc(100% - 34px); transform: scaleX(1); }
    97% { left: 6px; transform: scaleX(1); }
    100% { left: 6px; transform: scaleX(-1); }
  }
  @keyframes v-step { 50% { transform: translateY(-1px); } }
  @media (prefers-reduced-motion: reduce) { #victor, #victor .mascot { animation: none; } #victor { left: 6px; } }

  /* three small tiles: context, quota, AI diff */
  .v-tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(78px, 1fr)); gap: 6px; margin-top: 8px; cursor: pointer; }
  .v-tile { padding: 6px 8px; border-radius: var(--omp-r-md); background: var(--omp-surface-subtle); border: 1px solid transparent; min-width: 0; }
  .v-tiles:hover .v-tile { border-color: var(--omp-border); }
  .v-label { font-size: 10px; text-transform: uppercase; letter-spacing: .05em; color: var(--vscode-descriptionForeground); }
  .v-value { display: flex; align-items: center; gap: 6px; margin-top: 3px; font-size: 13px; font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .v-value.warn { color: var(--omp-warn); }
  .v-value.full { color: var(--omp-err); }
  .v-value.none { color: var(--vscode-descriptionForeground); font-weight: 400; }
  .v-ring { --p: 0; width: 14px; height: 14px; border-radius: 50%; flex: none;
    background: conic-gradient(currentColor calc(var(--p) * 1%), var(--omp-border-strong) 0);
    -webkit-mask: radial-gradient(circle, transparent 4px, #000 4.5px); mask: radial-gradient(circle, transparent 4px, #000 4.5px); }
  .v-bar { height: 4px; margin-top: 5px; border-radius: 999px; background: var(--omp-border-strong); overflow: hidden; }
  .v-bar > div { height: 100%; border-radius: inherit; background: var(--omp-ok); }
  .v-bar.warn > div { background: var(--omp-warn); }
  .v-bar.full > div { background: var(--omp-err); }
  .v-add { color: var(--vscode-gitDecoration-addedResourceForeground, var(--omp-ok)); }
  .v-del { color: var(--vscode-gitDecoration-deletedResourceForeground, var(--omp-err)); }

  /* changed files, like Source Control */
  .v-head { display: flex; align-items: center; gap: 6px; margin: 12px 0 4px; height: 22px; }
  .v-title { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; }
  .v-badge { min-width: 18px; padding: 0 5px; border-radius: 999px; text-align: center; font-size: 10.5px; line-height: 16px;
    background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .v-grow { flex: 1; }
  .v-act { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; border-radius: 5px;
    color: var(--vscode-icon-foreground); }
  .v-act:hover { background: var(--vscode-toolbar-hoverBackground); }
  .v-act:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .v-row { display: flex; align-items: center; gap: 6px; height: 24px; padding: 0 2px 0 6px; border-radius: 5px; cursor: pointer; }
  .v-row:hover, .v-row:focus-within { background: var(--vscode-list-hoverBackground); }
  .v-row .codicon { flex: none; color: var(--vscode-descriptionForeground); }
  .v-row .v-new { color: var(--vscode-gitDecoration-untrackedResourceForeground, var(--omp-ok)); }
  .v-name { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .v-dir { flex: 1 1 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; color: var(--vscode-descriptionForeground); }
  .v-num { flex: none; font-size: 11px; font-family: var(--vscode-editor-font-family); font-variant-numeric: tabular-nums; }
  .v-row .v-acts { display: none; flex: none; }
  .v-row:hover .v-acts, .v-row:focus-within .v-acts { display: inline-flex; }
  .v-empty { margin-top: 12px; text-align: center; font-size: 11px; color: var(--vscode-descriptionForeground); }
</style>
</head><body>
<div class="v-stage" id="stage" title="Victor · Usage &amp; limits"><span class="v-say" id="say"></span><div id="victor">${mascot}</div></div>
<div class="v-tiles" id="tiles" title="Usage &amp; limits"></div>
<div id="files"></div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const level = (f) => (f >= 0.9 ? 'full' : f >= 0.75 ? 'warn' : 'ok');
  const node = (tag, cls, text) => Object.assign(document.createElement(tag), { className: cls || '', textContent: text || '' });
  const act = (icon, title, msg) => {
    const b = node('button', 'v-act');
    b.title = title; b.setAttribute('aria-label', title);
    b.appendChild(node('span', 'codicon codicon-' + icon));
    b.onclick = (e) => { e.stopPropagation(); vscode.postMessage(msg); };
    return b;
  };
  const tile = (label, value, cls, extra) => {
    const t = node('div', 'v-tile'), v = node('div', 'v-value ' + (cls || ''));
    if (extra?.ring != null) { const r = node('span', 'v-ring'); r.style.setProperty('--p', extra.ring); v.appendChild(r); }
    v.append(value);
    t.append(node('div', 'v-label', label), v);
    if (extra?.bar != null) { const b = node('div', 'v-bar ' + (cls || '')), f = node('div'); f.style.width = extra.bar + '%'; b.appendChild(f); t.appendChild(b); }
    return t;
  };
  addEventListener('message', ({ data: m }) => {
    if (m.type !== 'pet') return;
    const c = m.meter?.context, r = m.meter?.windows?.rolling, g = m.meter?.gauge, files = m.files || [];
    const plus = files.reduce((s, f) => s + f.plus, 0), minus = files.reduce((s, f) => s + f.minus, 0);

    const tiles = $('tiles');
    tiles.textContent = '';
    const ctx = c ? Math.round(c.percent) : null;
    tiles.appendChild(ctx == null ? tile('Context', '—', 'none') : tile('Context', ctx + '%', level(ctx / 100), { ring: ctx }));
    const q = r ? ['5h quota', r.status === 'rate-limited' ? 100 : r.percent] : g ? ['Quota', Math.min(100, Math.round((g.used / g.limit) * 100))] : null;
    tiles.appendChild(q ? tile(q[0], q[1] + '%', level(q[1] / 100), { bar: q[1] }) : tile('Quota', '—', 'none'));
    const d = node('span');
    if (files.length) d.append(node('span', 'v-add', '+' + plus), node('span', 'v-del', '−' + minus)); else d.textContent = '0';
    d.style.display = 'inline-flex'; d.style.gap = '6px';
    tiles.appendChild(tile('AI diff', d, files.length ? '' : 'none'));

    $('say').textContent = q && q[1] >= 90 ? 'Quota almost out' : ctx >= 80 ? 'Context filling up'
      : files.length ? files.length + (files.length > 1 ? ' files' : ' file') + ' to review' : 'All clear';

    const list = $('files');
    list.textContent = '';
    if (!files.length) { list.appendChild(node('div', 'v-empty', 'No AI changes waiting for review.')); return; }
    const head = node('div', 'v-head');
    head.append(node('span', 'v-title', 'Changes'), node('span', 'v-badge', String(files.length)), node('span', 'v-grow'),
      act('check-all', 'Accept all', { type: 'decide', accept: true }), act('discard', 'Reject all', { type: 'decide', accept: false }));
    list.appendChild(head);
    // Each file the AI changed that is still under review: click to open, ✓ keeps the change, ↺ puts the file back.
    for (const f of files) {
      const row = node('div', 'v-row'), i = f.rel.lastIndexOf('/'), acts = node('span', 'v-acts');
      row.tabIndex = 0;
      row.title = f.rel + (f.created ? ' (new file)' : '');
      acts.append(act('check', 'Accept', { type: 'decide', path: f.path, accept: true }), act('discard', 'Reject', { type: 'decide', path: f.path, accept: false }));
      row.append(node('span', 'codicon codicon-' + (f.created ? 'new-file v-new' : 'file')), node('span', 'v-name', f.rel.slice(i + 1)),
        node('span', 'v-dir', i > 0 ? f.rel.slice(0, i) : ''), node('span', 'v-num v-add', '+' + f.plus), node('span', 'v-num v-del', '−' + f.minus), acts);
      row.onclick = () => vscode.postMessage({ type: 'open', path: f.path });
      row.onkeydown = (e) => { if (e.key === 'Enter') row.click(); };
      list.appendChild(row);
    }
  });
  $('stage').onclick = $('tiles').onclick = () => vscode.postMessage({ type: 'usage' });
  vscode.postMessage({ type: 'ready' });
</script>
</body></html>`;
  }
}

module.exports = { PetView };
