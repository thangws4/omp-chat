(function () {
  const vscode = acquireVsCodeApi();
  const md = window.markdownit({ html: false, linkify: true });
  const mdLines = window.markdownit({ html: false, linkify: true, breaks: true }); // command output is line-oriented
  const $ = (id) => document.getElementById(id);
  // The panel in VS Code's language when the extension sent a dictionary (media/l10n.js); chat content stays as written.
  try { window.ompL10n?.watch(window.ompL10n.compile(JSON.parse($('l10n')?.textContent || 'null')), document.body); }
  catch (e) { console.error('l10n', e); }
  const log = $('log'), welcome = $('welcome'), input = $('input'), popup = $('popup');
  const sendBtn = $('send'), stopBtn = $('stop'), modelBtn = $('model'), modeBtn = $('mode');
  const ctxLabel = $('ctxLabel'), ctxIcon = $('ctxIcon'), ctxEye = $('ctxEye');

  let turn = null;     // current assistant turn (everything until the next user message)
  let cur = null;      // assistant markdown being streamed
  let curThink = null; // thinking block being streamed
  let progress = null; // "Working…" row
  let busy = false;
  const tools = new Map();
  const shells = new Map(); // "!command" blocks by id
  const dialogs = new Map();
  let commands = [];
  let useContext = true;
  let contextLabel = null;
  let contextRel = null;
  let contextFull = null;
  let pinned = [];     // files attached to every message: [{ rel, label }]
  let pending = [];    // images waiting to be sent: { mimeType, data (base64), url }

  // Webview state survives reloads (per viewer convenience only: it can be missing).
  const st = () => { try { return vscode.getState() || {}; } catch { return {}; } };
  const saveState = (patch) => { try { vscode.setState({ ...st(), ...patch }); } catch { /* a convenience */ } };

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  const icon = (name, extra) => el('span', `codicon codicon-${name}${extra ? ' ' + extra : ''}`);
  const mascot = () => $('mascot').content.firstElementChild.cloneNode(true);
  // Follow new output only while you are at the bottom; scrolled up to read, you stay put and get a "↓" button.
  const jump = $('jump');
  let stick = true;
  log.addEventListener('scroll', () => {
    stick = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    if (stick) jump.hidden = true;
  });
  function scroll(force) {
    if (force) stick = true;
    if (stick) { log.scrollTop = log.scrollHeight; jump.hidden = true; }
    else jump.hidden = false;
  }
  jump.onclick = () => { scroll(true); input.focus(); };

  // ---- turns: your messages are right-aligned bubbles; OMP's replies sit on the left under its avatar ----
  function newTurn(kind) {
    welcome.hidden = true;
    const t = el('div', 'turn ' + kind);
    if (kind === 'bot') {
      const who = el('div', 'who');
      const av = el('span', 'avatar');
      av.appendChild(mascot());
      who.append(av, el('span', 'name', 'OMP'));
      t.appendChild(who);
    }
    t._body = el('div', kind === 'bot' ? 'body' : 'bubble');
    t.appendChild(t._body);
    log.appendChild(t);
    return t;
  }
  // Rewind (Claude Code's checkpoints): on hover, a ↶ button on your message offers to go back to just
  // before it, optionally restoring the files the agent changed since. The message returns to the input box.
  function addRewind(t, turnNo) {
    const btn = el('button', 'icon rewind');
    btn.title = 'Rewind to before this message';
    btn.appendChild(icon('discard'));
    btn.onclick = () => {
      if (t.querySelector('.rwmenu')) return;
      const menu = el('div', 'rwmenu');
      const opt = (label, restoreCode) => {
        const b = el('button', restoreCode === null ? 'secondary' : 'primary', label);
        b.onclick = () => {
          menu.remove();
          if (restoreCode !== null) vscode.postMessage({ type: 'rewind', turn: turnNo, restoreCode });
        };
        return b;
      };
      menu.append(el('div', 'rwtitle', 'Rewind to before this message?'),
        opt('Rewind conversation', false), opt('Rewind and restore code', true), opt('Cancel', null));
      t.after(menu);
      menu.querySelector('button').focus();
    };
    t.prepend(btn);
  }

  function body() {
    if (!turn) turn = newTurn('bot');
    return turn._body;
  }
  function clearProgress() { progress?.remove(); progress = null; }
  function showProgress() {
    if (!busy || progress) return;
    progress = el('div', 'progress');
    progress.append(spark(), el('span', '', 'Working…'));
    body().appendChild(progress);
    scroll();
  }
  function add(cls, text) {
    clearProgress();
    const e = el('div', cls, text || '');
    body().appendChild(e);
    scroll();
    return e;
  }

  // ---- markdown: re-render the streamed message at most once per frame ----
  function render(e) {
    e.innerHTML = (e._md || md).render(e._raw);
    scroll();
  }
  function renderSoon(e) {
    if (e._raf) return;
    e._raf = requestAnimationFrame(() => { e._raf = 0; render(e); });
  }
  function finish(e) {
    if (!e) return;
    cancelAnimationFrame(e._raf);
    e._raf = 0;
    render(e);
    for (const pre of e.querySelectorAll('pre')) {
      // A wrapper holds the copy button, so it stays put while the (height-capped) block scrolls.
      const wrap = el('div', 'codewrap');
      pre.before(wrap);
      wrap.appendChild(pre);
      const code = () => pre.querySelector('code')?.textContent ?? pre.textContent;
      const lang = /language-(\S+)/.exec(pre.querySelector('code')?.className || '')?.[1] || '';
      const bar = el('div', 'codeacts');
      const act = (name, title, fn) => {
        const b = el('button', 'icon');
        b.title = title;
        b.setAttribute('aria-label', title);
        b.appendChild(icon(name));
        b.onclick = () => fn(b);
        bar.appendChild(b);
      };
      act('insert', 'Insert at cursor', () => vscode.postMessage({ type: 'insertCode', code: code() }));
      act('new-file', 'Open in new file', () => vscode.postMessage({ type: 'newFileFromCode', code: code(), lang }));
      act('copy', 'Copy', (b) => {
        navigator.clipboard.writeText(code());
        b.firstChild.className = 'codicon codicon-check';
        setTimeout(() => { b.firstChild.className = 'codicon codicon-copy'; }, 1200);
      });
      wrap.appendChild(bar);
    }
    linkFiles(e);
  }

  // `src/app.ts:42` in a reply opens that file at that line. The extension says which spans are real files.
  const PATHISH = /^(?:[A-Za-z]:)?[\w.@~\/\\-]*\.[\w]{1,12}(?::\d+(?::\d+)?|#L\d+(?:-L?\d+)?)?$/;
  function linkFiles(e) {
    const refs = new Set();
    for (const c of e.querySelectorAll('code')) {
      const s = c.textContent.trim();
      if (c.closest('pre') || s.length > 260 || !PATHISH.test(s)) continue;
      c.classList.add('fcand');
      refs.add(s);
    }
    for (const a of e.querySelectorAll('a[href]')) { // [text](src/a.ts#L3): a relative link means a file
      const h = a.getAttribute('href');
      if (!/^[a-z][\w+.-]*:|^#|^\/\//i.test(h)) { a.dataset.file = decodeURI(h); a.classList.add('flink'); }
    }
    if (refs.size) vscode.postMessage({ type: 'checkPaths', refs: [...refs] });
  }
  function markPaths(m) {
    const refs = new Set(m.refs || []), ok = new Set(m.ok || []);
    for (const c of log.querySelectorAll('code.fcand')) {
      const s = c.textContent.trim();
      if (!refs.has(s)) continue; // asked by a later reply: its answer is still coming
      c.classList.remove('fcand');
      if (!ok.has(s)) continue;
      c.dataset.file = s;
      c.classList.add('flink');
      c.title = 'Open file';
      c.tabIndex = 0;
      c.setAttribute('role', 'link');
    }
  }
  log.addEventListener('click', (e) => {
    const f = e.target.closest?.('[data-file]');
    if (!f) return;
    e.preventDefault();
    vscode.postMessage({ type: 'openFile', ref: f.dataset.file });
  });
  log.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.matches?.('code[data-file]')) vscode.postMessage({ type: 'openFile', ref: e.target.dataset.file });
  });
  function endAssistant() { finish(cur); cur = null; endThink(); }
  // Three pixels in OMP's logo colours, hopping in turn, on whatever the agent is doing right now (thinking, working).
  const spark = () => {
    const s = el('span', 'spark');
    s.append(el('i'), el('i'), el('i'));
    return s;
  };
  // "Thinking… 4s" with the mark while it streams, then how long it took, as Claude Code shows it
  // (a replayed one just says "Thought").
  function startThink() {
    clearProgress();
    curThink = el('details', 'thinking live');
    curThink._t0 = Date.now();
    const label = el('span', 'tlabel', 'Thinking…');
    const s = el('summary');
    s.append(spark(), label);
    curThink.appendChild(s);
    curThink._body = curThink.appendChild(el('div', 'tbody'));
    curThink._timer = setInterval(() => { label.textContent = `Thinking… ${Math.round((Date.now() - curThink._t0) / 1000)}s`; }, 1000);
    body().appendChild(curThink);
    scroll();
  }
  function endThink() {
    if (!curThink) return;
    clearInterval(curThink._timer);
    const s = Math.round((Date.now() - curThink._t0) / 1000);
    curThink.classList.remove('live');
    curThink.querySelector('.spark').replaceWith(icon('lightbulb'));
    curThink.querySelector('.tlabel').textContent = s >= 1 ? `Thought for ${s}s` : 'Thought';
    curThink = null;
  }

  function setBusy(b) {
    busy = b;
    log.setAttribute('aria-busy', String(b)); // screen readers read the reply once, when it is complete
    syncSendStop();
    sendBtn.title = b ? 'Queue message (Enter)' : 'Send (Enter)';
    if (b) showProgress(); else clearProgress();
  }

  function send(text) {
    text = (text ?? input.value).trim();
    if (!text && !pending.length && !attached.length) return;
    const images = pending.map(({ mimeType, data }) => ({ mimeType, data }));
    const files = attached.map(({ name, mimeType, data, path }) => ({ name, mimeType, data, path }));
    attached = [];
    renderAttached();
    if (text) sent = [...sent.filter((x) => x !== text), text].slice(-50);
    histAt = -1;
    saveState({ sent, draft: '' });
    input.value = '';
    updateShellMode();
    pending = [];
    renderThumbs();
    autosize();
    hidePicker();
    vscode.postMessage({ type: 'send', text, withContext: useContext && !!contextLabel, images, files });
  }

  // ---- images: paste, drop or attach; large ones are scaled down before sending ----
  const MAX_SIDE = 1600;
  function readImage(file) {
    return new Promise((resolve) => {
      if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) return resolve(null);
      const reader = new FileReader();
      reader.onload = () => {
        const url = reader.result;
        const img = new Image();
        img.onload = () => {
          const scale = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
          if (scale === 1 && file.size < 1.5e6) return resolve({ mimeType: file.type, data: url.split(',')[1], url });
          const c = document.createElement('canvas');
          c.width = Math.round(img.width * scale);
          c.height = Math.round(img.height * scale);
          c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
          const out = c.toDataURL(file.type === 'image/png' ? 'image/png' : 'image/jpeg', 0.85);
          resolve({ mimeType: out.slice(5, out.indexOf(';')), data: out.split(',')[1], url: out });
        };
        img.onerror = () => resolve(null);
        img.src = url;
      };
      reader.readAsDataURL(file);
    });
  }
  async function addImages(fileList) {
    for (const f of [...fileList].slice(0, 5 - pending.length)) {
      const img = await readImage(f);
      if (img) pending.push(img);
    }
    renderThumbs();
  }

  // ---- other files (PDF, Word, Excel, text, code…): the agent reads them with its read tool ----
  // { name, size, mimeType, data } from disk or the clipboard, or { name, path, label } dragged from VS Code.
  let attached = [];
  const MAX_FILES = 10, MAX_FILE = 20e6;
  const IMAGE = /^image\/(png|jpeg|gif|webp)$/;
  const say = (text) => window.postMessage({ type: 'notice', text }, '*');
  const readBase64 = (f) => new Promise((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => resolve(null);
    r.readAsDataURL(f);
  });
  async function addFiles(list) {
    list = [...list];
    const imgs = list.filter((f) => IMAGE.test(f.type));
    if (imgs.length) await addImages(imgs);
    for (const f of list.filter((x) => !IMAGE.test(x.type))) {
      if (attached.length >= MAX_FILES) { say(`At most ${MAX_FILES} files per message.`); break; }
      if (/\.(doc|xls|ppt)$/i.test(f.name)) { say(`${f.name}: OMP cannot read old Office files. Save it as .docx, .xlsx, .pptx or PDF and attach that.`); continue; }
      if (f.size > MAX_FILE) { say(`${f.name} is larger than 20 MB, so it was not attached.`); continue; }
      const data = await readBase64(f);
      if (data !== null) attached.push({ name: f.name, size: f.size, mimeType: f.type, data });
    }
    renderAttached();
  }
  const fileIcon = (name) => (/\.pdf$/i.test(name) ? 'file-pdf' : /\.(zip|tar|gz|7z|rar)$/i.test(name) ? 'file-zip'
    : /\.(docx|xlsx|pptx|epub|md|txt|csv|rtf)$/i.test(name) ? 'file-text' : /\.\w+$/.test(name) ? 'file-code' : 'folder');
  const size = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);
  function renderAttached() {
    syncSendStop();
    const box = $('attached');
    box.textContent = '';
    attached.forEach((a, i) => {
      const c = el('span', 'chip attchip');
      c.title = a.path || `${a.name} (${size(a.size)})`;
      const x = el('button', 'ctxx');
      x.title = 'Remove';
      x.appendChild(icon('close'));
      x.onclick = () => { attached.splice(i, 1); renderAttached(); };
      c.append(icon(fileIcon(a.name)), el('span', 'plabel', a.label || a.name));
      if (a.size) c.appendChild(el('span', 'asize', size(a.size)));
      c.appendChild(x);
      box.appendChild(c);
    });
  }
  function renderThumbs() {
    syncSendStop();
    const box = $('thumbs');
    box.textContent = '';
    pending.forEach((p, i) => {
      const t = el('div', 'thumb');
      const im = el('img');
      im.src = p.url;
      const x = el('button', 'icon tx');
      x.title = 'Remove image';
      x.appendChild(icon('close'));
      x.onclick = () => { pending.splice(i, 1); renderThumbs(); };
      t.append(im, x);
      box.appendChild(t);
    });
    box.hidden = !pending.length;
  }

  // Re-run a command in VS Code's own terminal (to watch it, or answer its prompts).
  function terminalButton(command) {
    const b = el('button', 'icon tterm');
    b.title = 'Run in terminal';
    b.appendChild(icon('terminal'));
    b.onclick = (e) => { e.preventDefault(); e.stopPropagation(); vscode.postMessage({ type: 'runInTerminal', command }); };
    return b;
  }

  // ---- tools, file changes, approvals ----
  // ---- subagents: a live card per spawned agent, a pinned "Agents" bar, and a transcript sheet ----
  const subCards = new Map(); // record key -> card element
  const subData = new Map();  // record key -> latest record (for the Agents bar)
  const toolRows = new Map(); // tool call id -> its row, kept so cards can sit under their task row
  const SUB_ICON = { running: ['loading', 'codicon-modifier-spin'], completed: ['check'], failed: ['error'], aborted: ['circle-slash'] };
  const secs = (ms) => (ms >= 60000 ? `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s` : `${Math.round((ms || 0) / 1000)}s`);

  function renderSubagent(m) {
    subData.set(m.key, m);
    let c = subCards.get(m.key);
    if (!c) {
      c = el('div', 'subagent');
      c.dataset.parent = m.parent || '';
      c._head = c.appendChild(el('div', 'shd'));
      c._task = c.appendChild(el('div', 'stask'));
      c._now = c.appendChild(el('div', 'snow'));
      const row = toolRows.get(m.parent);
      if (row && row.isConnected) { // under its task row, after any sibling cards
        let after = row;
        while (after.nextElementSibling?.classList.contains('subagent') && after.nextElementSibling.dataset.parent === c.dataset.parent) after = after.nextElementSibling;
        after.after(c);
      } else {
        clearProgress();
        body().appendChild(c);
      }
      subCards.set(m.key, c);
    }
    c.className = 'subagent ' + m.status;
    const [ic, mod] = SUB_ICON[m.status] || SUB_ICON.running;
    c._head.textContent = '';
    // the model it runs on, when the lead picked one for this task ("deepseek-v4-pro:high")
    const smodel = m.model ? el('span', 'smodel', m.model.split('/').pop()) : null;
    if (smodel) smodel.title = m.model;
    c._head.append(icon(ic, mod), el('span', 'sagent', m.agent || 'agent'), el('span', 'sname', m.id), ...(smodel ? [smodel] : []), el('span', 'spacer'),
      el('span', 'smeta', [m.ms ? secs(m.ms) : '', m.tools ? `${m.tools} tool${m.tools > 1 ? 's' : ''}` : ''].filter(Boolean).join(' · ')));
    const btn = (iconName, title, onclick) => {
      const b = el('button', 'icon');
      b.title = title;
      b.appendChild(icon(iconName));
      b.onclick = onclick;
      c._head.appendChild(b);
    };
    btn('eye', 'View its conversation', () => vscode.postMessage({ type: 'subagentView', id: m.id }));
    if (m.status === 'running') {
      btn('comment-discussion', 'Send it an instruction', () => toggleSteer(c, m.id));
      btn('debug-stop', 'Stop this subagent', () => vscode.postMessage({ type: 'subagentStop', id: m.id }));
    } else c._steer?.remove();
    c._task.textContent = m.task || '';
    const now = m.status === 'running' ? (m.intent || (m.tool ? `${m.tool} ${m.toolArgs || ''}` : 'Starting…'))
      : m.status === 'completed' ? 'Done' : m.status === 'failed' ? 'Failed' : 'Stopped';
    c._now.textContent = now;
    renderAgentsBar();
    scroll();
  }

  function toggleSteer(c, id) {
    if (c._steer?.isConnected) { c._steer.remove(); return; }
    const row = el('div', 'ssteer');
    const box = el('input', 'finput');
    box.placeholder = `Tell ${id} something (Enter to send)`;
    const go = () => { if (box.value.trim()) vscode.postMessage({ type: 'subagentSteer', id, text: box.value }); row.remove(); };
    box.onkeydown = (e) => { if (e.key === 'Enter') go(); if (e.key === 'Escape') row.remove(); };
    const send = el('button', 'icon');
    send.title = 'Send';
    send.appendChild(icon('send'));
    send.onclick = go;
    row.append(box, send);
    c._steer = row;
    c.appendChild(row);
    box.focus();
  }

  // Pinned above the input while subagents run (and until your next message), like herdr's sidebar dots.
  let barDismissed = new Set();
  function renderAgentsBar() {
    const bar = $('agents');
    const items = [...subData.values()].filter((m) => !barDismissed.has(m.key));
    bar.textContent = '';
    if (!items.length) { bar.hidden = true; return; }
    const running = items.filter((m) => m.status === 'running').length;
    bar.appendChild(el('div', 'ahead', `Subagents · ${running ? `${running} running` : 'all finished'}`));
    for (const m of items) {
      const r = el('button', 'arow ' + m.status);
      const [ic, mod] = SUB_ICON[m.status] || SUB_ICON.running;
      r.append(icon(ic, mod), el('span', 'sagent', m.agent || 'agent'), el('span', 'sname', m.id),
        el('span', 'anow', m.status === 'running' ? (m.intent || m.tool || '') : m.status));
      r.title = 'Show its card';
      r.onclick = () => { const c = subCards.get(m.key); c?.scrollIntoView({ block: 'center' }); c?.classList.add('flash'); setTimeout(() => c?.classList.remove('flash'), 900); };
      bar.appendChild(r);
    }
    bar.hidden = false;
  }

  // A subagent's own conversation, read-only, in the sheet.
  function showSubagentTranscript(m) {
    const s = openSheet(`${m.id} · ${m.agent || 'subagent'}`, 'hubot', () => vscode.postMessage({ type: 'subagentView', id: m.id }));
    s.classList.add('transcript');
    s.appendChild(el('div', 'unote', `${m.status === 'running' ? 'Running' : m.status} · ${m.messages.length} messages. Refresh to follow it while it runs.`));
    const box = el('div', 'tscroll');
    for (const x of m.messages) {
      if (x.role === 'task') {
        const d = el('details', 'tmsg');
        d.appendChild(el('summary', '', 'Task brief'));
        d.appendChild(el('pre', 'out', x.text));
        box.appendChild(d);
      } else if (x.role === 'assistant') {
        if (x.text?.trim()) { const t = el('div', 'md'); t.innerHTML = md.render(x.text); box.appendChild(t); }
        for (const t of x.tools || []) {
          const r = el('div', 'ttool');
          r.append(icon('tools'), el('span', 'tverb', t.name), el('code', 'targ', t.detail));
          box.appendChild(r);
        }
      } else {
        const d = el('details', 'tmsg' + (x.isError ? ' err' : ''));
        d.appendChild(el('summary', '', `${x.isError ? '✕' : '↳'} ${x.name} output`));
        d.appendChild(el('pre', 'out', x.text));
        box.appendChild(d);
      }
    }
    if (!m.messages.length) box.appendChild(el('div', 'unote', 'Nothing yet.'));
    s.appendChild(box);
  }

  const VERBS = { // [while running, when done]
    read: ['Reading', 'Read'], edit: ['Editing', 'Edited'], write: ['Creating', 'Created'], bash: ['Running', 'Ran'],
    grep: ['Searching', 'Searched'], glob: ['Searching', 'Searched'], find: ['Searching', 'Searched'], ls: ['Listing', 'Listed'],
    task: ['Delegating to', 'Delegated to'], wait: ['Waiting for subagents', 'Waited for subagents'],
  };
  function toolDetail(a) {
    try {
      a = a || {};
      if (Array.isArray(a.tasks)) return a.tasks.map((t) => `${t.name || t.id || 'agent'}${t.agent ? ` (${t.agent})` : ''}`).join(', '); // task tool
      return a.command || a.path || a.file_path || a.pattern || a.query || a.i || '';
    } catch { return ''; }
  }

  // omp's diff text: "+12|code", "-12|code", " 12|code", and an empty line between hunks.
  // Lines without a number (a preview built from the tool's arguments) are "+code" / "-code".
  const DIFF_MAX = 300;
  function diffView(text) {
    const rows = String(text || '').replace(/\n$/, '').split('\n');
    const view = el('div', 'diff'), lines = el('div', 'dlines');
    const nums = rows.map((r) => /^[ +-]\s*(\d+)\|/.exec(r)?.[1] || '');
    view.style.setProperty('--lnw', Math.max(...nums.map((n) => n.length), 1) + 'ch');
    rows.slice(0, DIFF_MAX).forEach((r, i) => {
      if (!r) { lines.appendChild(el('div', 'dsep', '⋯')); return; }
      const sign = '+- '.includes(r[0]) ? r[0] : ' ';
      const code = nums[i] ? r.slice(r.indexOf('|') + 1) : sign === r[0] ? r.slice(1) : r;
      const row = el('div', 'dl' + (sign === '+' ? ' add' : sign === '-' ? ' del' : ''));
      row.append(el('span', 'ln', nums[i]), el('span', 'sg', sign === ' ' ? '' : sign === '-' ? '−' : '+'), el('span', 'code', code));
      lines.appendChild(row);
    });
    if (rows.length > DIFF_MAX) lines.appendChild(el('div', 'dsep more', `… ${rows.length - DIFF_MAX} more lines (open the diff)`));
    view.appendChild(lines);
    return view;
  }
  const diffCounts = (text) => {
    const rows = String(text || '').split('\n');
    return { plus: rows.filter((l) => l[0] === '+').length, minus: rows.filter((l) => l[0] === '-').length };
  };
  const counts = (box, c) => {
    if (c.plus) box.appendChild(el('span', 'plus', '+' + c.plus));
    if (c.minus) box.appendChild(el('span', 'minus', '−' + c.minus));
  };

  function changesBlock(files) {
    const box = el('div', 'changes');
    const head = el('div', 'chead');
    const all = files.map((f) => diffCounts(f.diff));
    head.append(icon('git-compare'), el('span', '', `${files.length} file${files.length > 1 ? 's' : ''} changed`));
    counts(head, { plus: all.reduce((s, c) => s + c.plus, 0), minus: all.reduce((s, c) => s + c.minus, 0) });
    box.appendChild(head);
    // Small changes are shown right away, as Claude Code does; big ones wait for a click.
    const small = all.reduce((s, c) => s + c.plus + c.minus, 0) <= 24;
    files.forEach((f, i) => {
      const file = el('div', 'cfile');
      const row = el('div', 'crow');
      const chev = el('span', 'chev');
      if (f.diff) chev.appendChild(icon('chevron-right'));
      const slash = f.rel.lastIndexOf('/');
      const name = el('span', 'cname');
      name.append(el('span', 'cbase', f.rel.slice(slash + 1)));
      if (slash > 0) name.appendChild(el('span', 'cdir', f.rel.slice(0, slash)));
      name.title = f.rel;
      row.append(chev, icon('file', 'cicon'), name);
      counts(row, all[i]);
      row.appendChild(el('span', 'spacer'));
      if (f.id) {
        const review = el('button', 'icon');
        review.title = 'Review in the editor: accept or reject each change';
        review.appendChild(icon('go-to-file'));
        review.onclick = () => vscode.postMessage({ type: 'openEdit', id: f.id });
        const diffBtn = el('button', 'icon');
        diffBtn.title = 'Open side-by-side diff';
        diffBtn.appendChild(icon('diff'));
        diffBtn.onclick = () => vscode.postMessage({ type: 'openDiff', id: f.id });
        const undo = el('button', 'icon');
        undo.title = 'Undo this change';
        undo.dataset.edit = f.id;
        undo.appendChild(icon('discard'));
        undo.onclick = () => vscode.postMessage({ type: 'revert', id: f.id });
        row.append(review, diffBtn, undo);
      }
      file.appendChild(row);
      if (f.diff) {
        const view = diffView(f.diff);
        const toggle = (open) => {
          file.classList.toggle('open', open);
          chev.firstChild.className = 'codicon codicon-chevron-' + (open ? 'down' : 'right');
        };
        row.classList.add('toggle');
        row.tabIndex = 0;
        row.setAttribute('role', 'button');
        row.onclick = (e) => { if (!e.target.closest('button')) toggle(!file.classList.contains('open')); };
        row.onkeydown = (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === row) { e.preventDefault(); row.click(); } };
        file.appendChild(view);
        toggle(small);
      } else if (f.id) {
        name.classList.add('link'); // nothing to unfold: the name opens the review
        name.onclick = () => vscode.postMessage({ type: 'openEdit', id: f.id });
      }
      box.appendChild(file);
    });
    return box;
  }

  // What an edit / write is about to change, from the tool's arguments: shown in its approval card.
  function previewDiff(name, a) {
    if (!a) return '';
    const lines = (s) => String(s).replace(/\n$/, '').split('\n');
    const pairs = Array.isArray(a.edits) ? a.edits : [a];
    if (name === 'write' && typeof a.content === 'string') return lines(a.content).map((l) => '+' + l).join('\n');
    if (name !== 'edit') return '';
    return pairs.filter((e) => typeof e?.old_string === 'string' && typeof e?.new_string === 'string').map((e) => {
      const o = lines(e.old_string), n = lines(e.new_string);
      let s = 0, eo = o.length, en = n.length; // trim the lines both sides share
      while (s < eo && s < en && o[s] === n[s]) s++;
      while (eo > s && en > s && o[eo - 1] === n[en - 1]) { eo--; en--; }
      return [...o.slice(s, eo).map((l) => '-' + l), ...n.slice(s, en).map((l) => '+' + l)].join('\n');
    }).filter(Boolean).join('\n\n');
  }

  // Finished tool rows (and the thinking between them) just above a new tool fold into one "Ran N tools"
  // row, so a long run doesn't bury the conversation. The running row, file changes, approvals and
  // subagent cards stay outside: they end the run.
  const FOLD = 'details.tool:not(.running), details.thinking';
  function foldTools(b) {
    const run = [];
    let g = null;
    for (let e = b.lastElementChild; e; e = e.previousElementSibling) {
      if (e.matches(FOLD)) { run.unshift(e); continue; }
      if (e.classList.contains('tgroup')) g = e;
      break;
    }
    const isTool = (e) => e.classList.contains('tool');
    const n = (g ? [...g.children].filter(isTool).length : 0) + run.filter(isTool).length;
    if (!run.length || n < 2) return;
    if (!g) { g = el('details', 'tgroup'); g.appendChild(el('summary')); run[0].before(g); }
    g.append(...run);
    const s = g.firstElementChild;
    s.textContent = '';
    s.append(icon(g.querySelector(':scope > .tool.err') ? 'warning' : 'checklist'), el('span', '', `Ran ${n} tools`));
  }

  function showDialog(m) {
    clearProgress();
    const [head, ...rest] = m.title.split('\n');
    const card = add('confirm');
    // Show the question above the tool row it is about: asked -> ran -> result.
    const running = [...body().querySelectorAll('.tool.running')].pop();
    if (running) running.before(card);
    const title = el('div', 'ctitle');
    title.append(icon('shield'), el('span', '', head));
    card.appendChild(title);
    if (rest.length) card.appendChild(el('pre', 'cbody', rest.join('\n')));
    const preview = /^Allow tool:/.test(head) && running?._tool && previewDiff(running._tool.name, running._tool.args);
    if (preview) card.appendChild(diffView(preview));
    // Text questions from omp ("input" one line, "editor" multi-line) get a box in the card.
    let box = null;
    if (m.input) {
      box = el(m.input.multiline ? 'textarea' : 'input', 'cinput');
      if (!m.input.multiline) box.type = m.input.secret ? 'password' : 'text';
      else box.rows = 6;
      box.placeholder = m.input.placeholder || '';
      box.value = m.input.value || '';
      box.onkeydown = (e) => { if (e.key === 'Enter' && (!m.input.multiline || e.ctrlKey)) { e.preventDefault(); btns.firstChild.click(); } };
      card.appendChild(box);
    }
    const btns = el('div', 'cbtns');
    m.options.forEach((opt, i) => {
      const b = el('button', i === 0 ? 'primary' : 'secondary', opt);
      b.onclick = () => {
        vscode.postMessage({ type: 'dialogAnswer', id: m.id, value: box ? { choice: opt, text: box.value } : opt });
        closeDialog(m.id, box && opt === m.options[0] && !m.input.secret ? `${opt}: ${box.value.slice(0, 60)}` : opt);
      };
      btns.appendChild(b);
    });
    card.appendChild(btns);
    dialogs.set(m.id, { card, head });
    (box || btns.firstChild)?.focus();
  }

  // ---- queued messages: sent while the agent works; they wait above the input until omp takes them ----
  function addQueued(m) {
    const q = $('queue');
    const row = el('div', 'qrow');
    row.dataset.qid = m.qid;
    const label = el('span', 'qlabel');
    label.append(icon('clock'), el('span', '', 'Queued'));
    const text = el('span', 'qtext', m.text + (m.images?.length ? `  🖼×${m.images.length}` : ''));
    const now = el('button', 'icon');
    now.title = 'Send now (hand it to the running turn)';
    now.appendChild(icon('arrow-up'));
    now.onclick = () => { now.disabled = true; vscode.postMessage({ type: 'promoteQueued', qid: m.qid }); };
    const rm = el('button', 'icon');
    rm.title = 'Remove from the queue (back to the message box)';
    rm.appendChild(icon('close'));
    rm.onclick = () => vscode.postMessage({ type: 'removeQueued', qid: m.qid });
    row.append(label, text, now, rm);
    q.appendChild(row);
    q.hidden = false;
  }
  function dropQueued(qid) {
    const q = $('queue');
    q.querySelector(`[data-qid="${qid}"]`)?.remove();
    q.hidden = !q.children.length;
  }

  // ---- the agent's todo list (omp's todo tool), pinned above the input while there is work left ----
  const TODO_ICON = { pending: 'circle-large-outline', in_progress: 'loading', completed: 'pass-filled', abandoned: 'circle-slash', blocked: 'warning' };
  let todosOpen = true;
  function showTodos(phases) {
    const box = $('todos');
    const tasks = phases.flatMap((p) => p.tasks || []);
    box.textContent = '';
    if (!tasks.length) { box.hidden = true; return; }
    const done = tasks.filter((t) => t.status === 'completed' || t.status === 'abandoned').length;
    const head = el('button', 'thead');
    head.append(icon(todosOpen ? 'chevron-down' : 'chevron-right'), icon('checklist'), el('span', '', `Todos ${done}/${tasks.length}`));
    const current = tasks.find((t) => t.status === 'in_progress');
    if (current && !todosOpen) head.appendChild(el('span', 'tcur', current.content));
    head.onclick = () => { todosOpen = !todosOpen; showTodos(phases); };
    box.appendChild(head);
    if (todosOpen) {
      const list = el('div', 'tlist');
      for (const p of phases) {
        if (phases.length > 1 && p.name) list.appendChild(el('div', 'tphase', p.name));
        for (const t of p.tasks || []) {
          const row = el('div', 'titem ' + t.status);
          row.append(icon(TODO_ICON[t.status] || 'circle-large-outline', t.status === 'in_progress' ? 'codicon-modifier-spin' : ''), el('span', '', t.content));
          if (t.blocker) row.appendChild(el('span', 'tblock', '— ' + t.blocker));
          list.appendChild(row);
        }
      }
      box.appendChild(list);
    }
    box.hidden = false;
  }

  // ---- plan mode: once the plan is written, approve it (leaves plan mode) or keep planning ----
  function showPlanReady() {
    const card = add('confirm planready');
    const title = el('div', 'ctitle');
    title.append(icon('checklist'), el('span', '', 'Ready to carry out this plan?'));
    card.appendChild(title);
    card.appendChild(el('div', 'unote', 'Plan mode is read-only. Approving switches modes and asks the agent to implement the plan, in this conversation.'));
    const btns = el('div', 'cbtns');
    const choose = (label, mode, cls, delegate, tip) => {
      const b = el('button', cls, label);
      if (tip) b.title = tip;
      b.onclick = () => {
        card.className = 'confirm done';
        card.textContent = '';
        card.append(icon(mode ? 'check' : 'edit'), el('span', '', mode ? `Plan approved — ${label}` : 'Kept planning'));
        if (mode) vscode.postMessage({ type: 'executePlan', mode, delegate });
        else input.focus();
      };
      return b;
    };
    // Subagents work in parallel, so their edits are auto-approved (commands still ask).
    btns.append(choose('Execute, ask before edits', 'always-ask', 'primary'), choose('Execute, auto-approve edits', 'write', 'secondary'),
      choose('Split across subagents', 'write', 'secondary', true,
        'Each task goes to its own subagent, on the model that suits it (from your models ★); independent tasks run in parallel, then the agent reviews, tests and sums up. Edits are auto-approved, commands still ask.'),
      choose('Keep planning', null, 'secondary'));
    card.appendChild(btns);
  }

  // ---- sheet: one in-panel card above the chat for usage, keys and forms ----
  const sheet = $('sheet');
  let openForm = null; // id of the form shown in the sheet (dismissing it answers null)
  function closeSheet() {
    if (openForm) { vscode.postMessage({ type: 'formAnswer', id: openForm, values: null }); openForm = null; }
    sheet.hidden = true;
    sheet.textContent = '';
    sheet.onkeydown = null;
    sheet.className = '';
  }
  // One overlay at a time: a sheet replaces any open list (history, models…), and those lists close the sheet.
  function openSheet(title, iconName, onRefresh) {
    closeSheet();
    hidePicker();
    const head = el('div', 'uhead');
    head.append(icon(iconName), el('span', 'utitle', title), el('span', 'spacer'));
    if (onRefresh) {
      const r = el('button', 'icon');
      r.title = 'Refresh';
      r.appendChild(icon('refresh'));
      r.onclick = onRefresh;
      head.appendChild(r);
    }
    const x = el('button', 'icon');
    x.title = 'Close';
    x.appendChild(icon('close'));
    x.onclick = closeSheet;
    head.appendChild(x);
    sheet.appendChild(head);
    sheet.hidden = false;
    return sheet;
  }

  // Form sent by the extension: { id, title, text?, fields: [{ name, label, type?, value?, placeholder?, options?, required? }], submit, cancel }
  function showForm(m) {
    const s = openSheet(m.title, 'edit');
    openForm = m.id;
    if (m.text) for (const line of m.text.split('\n')) s.appendChild(el('div', 'unote', line));
    const inputs = {};
    for (const f of m.fields || []) {
      const row = el('label', 'frow');
      row.appendChild(el('span', 'flabel', f.label));
      let inp;
      if (f.type === 'select') {
        inp = el('select', 'finput');
        for (const o of f.options) { const op = el('option', '', o.label); op.value = o.value; inp.appendChild(op); }
      } else if (f.type === 'textarea') {
        inp = el('textarea', 'finput farea');
        inp.rows = 6;
        inp.placeholder = f.placeholder || '';
        inp.onkeydown = (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); ok.click(); } };
      } else {
        inp = el('input', 'finput');
        inp.type = f.type === 'password' ? 'password' : 'text';
        inp.placeholder = f.placeholder || '';
        inp.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); ok.click(); } };
      }
      if (f.value) inp.value = f.value;
      inputs[f.name] = inp;
      row.appendChild(inp);
      s.appendChild(row);
    }
    const btns = el('div', 'cbtns');
    const ok = el('button', 'primary', m.submit || 'OK');
    ok.onclick = () => {
      const values = Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, v.value]));
      const missing = (m.fields || []).find((f) => f.required && !values[f.name]?.trim());
      if (missing) { inputs[missing.name].focus(); inputs[missing.name].classList.add('invalid'); return; }
      vscode.postMessage({ type: 'formAnswer', id: m.id, values });
      openForm = null;
      closeSheet();
    };
    const cancel = el('button', 'secondary', m.cancel || 'Cancel');
    cancel.onclick = closeSheet;
    btns.append(ok, cancel);
    s.appendChild(btns);
    (Object.values(inputs).find((i) => i.tagName !== 'SELECT' && !i.value) || ok).focus();
  }

  // ---- Plugins & skills: switch plugins (or single skills) on/off for this workspace, and auto-pick ----
  function toggle(checked, title) {
    const label = el('label', 'switch');
    label.title = title || '';
    const box = el('input');
    box.type = 'checkbox';
    box.checked = checked;
    label.append(box, el('span', 'slider'));
    return { label, box };
  }
  function showPlugins(m) {
    const s = openSheet('Plugins & skills', 'extensions', () => vscode.postMessage({ type: 'plugins', refresh: true }));
    s.classList.add('plugins');
    const state = new Map(); // skill name -> enabled
    for (const g of m.groups) for (const k of g.skills) state.set(k.name, k.enabled);

    const auto = toggle(m.auto, 'Name matching skills to the agent with each message');
    const autoRow = el('div', 'prow auto');
    autoRow.append(auto.label, el('span', 'pname', 'Auto-pick skills for each message'));
    s.appendChild(autoRow);
    s.appendChild(el('div', 'unote', 'Switched-on skills are always offered to the agent, which chooses among them. Auto-pick also names the best matches for each request. Choices apply to this workspace; Apply restarts the agent and keeps the conversation.'));

    const filter = el('input', 'finput pfilterbox');
    filter.placeholder = 'Filter plugins and skills';
    s.appendChild(filter);
    const list = el('div', 'plist2');
    s.appendChild(list);

    const open = new Set();
    function render() {
      const q = filter.value.toLowerCase();
      list.textContent = '';
      for (const g of m.groups) {
        const match = (k) => !q || k.name.toLowerCase().includes(q) || k.description.toLowerCase().includes(q);
        const skills = g.skills.filter(match);
        if (q && !skills.length && !g.name.toLowerCase().includes(q)) continue;
        const on = g.skills.filter((k) => state.get(k.name)).length;
        const head = el('div', 'prow');
        const t = toggle(on > 0, on === g.skills.length ? 'Switch the whole plugin off' : 'Switch the whole plugin on');
        t.box.indeterminate = on > 0 && on < g.skills.length;
        t.box.onchange = () => { for (const k of g.skills) state.set(k.name, t.box.checked); render(); };
        const expand = el('button', 'icon');
        expand.appendChild(icon(open.has(g.id) || q ? 'chevron-down' : 'chevron-right'));
        expand.onclick = () => { open.has(g.id) ? open.delete(g.id) : open.add(g.id); render(); };
        head.append(t.label, el('span', 'pname', g.name), el('span', 'pcount', `${on}/${g.skills.length}${g.source ? ' · ' + g.source : ''}`), el('span', 'spacer'), expand);
        list.appendChild(head);
        if (!open.has(g.id) && !q) continue;
        for (const k of skills) {
          const row = el('div', 'prow skill');
          const st = toggle(state.get(k.name));
          st.box.onchange = () => { state.set(k.name, st.box.checked); render(); };
          const text = el('div', 'ptext');
          text.append(el('div', 'pname', k.name), el('div', 'pdesc2', k.description.length > 160 ? k.description.slice(0, 160) + '…' : k.description));
          row.append(st.label, text);
          list.appendChild(row);
        }
      }
      if (!list.children.length) list.appendChild(el('div', 'unote', 'No match.'));
    }
    filter.oninput = render;
    render();

    const btns = el('div', 'cbtns');
    const apply = el('button', 'primary', 'Apply');
    apply.onclick = () => {
      const disabled = [...state].filter(([, en]) => !en).map(([n]) => n);
      vscode.postMessage({ type: 'applyPlugins', disabled, auto: auto.box.checked });
      closeSheet();
    };
    const cancel = el('button', 'secondary', 'Cancel');
    cancel.onclick = closeSheet;
    btns.append(apply, cancel);
    s.appendChild(btns);
  }

  // ---- Models sheet: every model omp can run; ★ the ones you use and only those show in the chat's picker ----
  let modelFilter = (vscode.getState() || {}).modelFilter || ''; // kept across re-renders and reloads
  let modelFocus = null; // { id, fav } of the focused row, refocused when the sheet is re-sent (reordering)
  const SHEET_LIMIT = 150;
  function showModelsSheet(m) {
    const resent = !sheet.hidden && sheet.classList.contains('models'); // re-sent after reordering: keep your place
    if (!resent) modelFocus = null;
    const s = openSheet('Models', 'sparkle');
    s.classList.add('models');
    const fav = m.favorites.map((x) => x.id);
    const byId = new Map((m.all || []).map((x) => [x.id, x]));
    for (const f of m.favorites) if (!byId.has(f.id)) byId.set(f.id, { id: f.id, name: f.name });
    s.appendChild(el('div', 'unote', 'Star (☆) the models you use: only those appear in the chat\'s model list. Switching models keeps the conversation.'));

    const row = (x, inFav, i, n) => {
      const r = el('div', 'mrow' + (x.id === m.current ? ' current' : ''));
      r.tabIndex = 0;
      r._id = x.id;
      r._fav = !!inFav;
      r.onfocus = () => { modelFocus = { id: x.id, fav: !!inFav }; };
      const btn = (iconName, title, onclick, disabled, cls) => {
        const b = el('button', 'icon' + (cls ? ' ' + cls : ''));
        b.title = title;
        b.disabled = !!disabled;
        b.appendChild(icon(iconName));
        b.onclick = onclick;
        return b;
      };
      const starred = fav.includes(x.id);
      if (!inFav) r.appendChild(btn(starred ? 'star-full' : 'star-empty', starred ? 'Remove from your models' : 'Add to your models', () => toggle(x.id), false, 'mstar' + (starred ? ' on' : '')));
      else r.appendChild(icon(x.id === m.current ? 'check' : 'star-full'));
      const text = el('div', 'mtext');
      text.append(el('div', 'mname', x.name || x.id.split('/').slice(1).join('/')), el('div', 'mid', [x.id, modelMeta(x)].filter(Boolean).join(' · ')));
      r.appendChild(text);
      const badge = modelBadge(x);
      if (badge) r.appendChild(el('span', 'pbadge', badge));
      if (x.id !== m.current) {
        const use = el('button', 'secondary', 'Use');
        use.onclick = () => { vscode.postMessage({ type: 'setModel', id: x.id }); closeSheet(); };
        r.appendChild(use);
      } else r.appendChild(el('span', 'minuse', 'in use'));
      if (inFav) {
        r.appendChild(btn('arrow-up', 'Move up', () => vscode.postMessage({ type: 'moveFavorite', id: x.id, dir: -1 }), i === 0));
        r.appendChild(btn('arrow-down', 'Move down', () => vscode.postMessage({ type: 'moveFavorite', id: x.id, dir: 1 }), i === n - 1));
        r.appendChild(btn('close', 'Remove from your models', () => toggle(x.id)));
      }
      return r;
    };

    const favBox = s.appendChild(el('div', 'usec'));
    const allBox = s.appendChild(el('div', 'usec'));
    const filter = el('input', 'finput pfilterbox');
    filter.placeholder = 'Filter all models, e.g. "free", "deepseek", "kimi"';
    filter.value = modelFilter;
    const list = el('div', 'mlist');

    function renderFav() {
      favBox.textContent = '';
      favBox.appendChild(el('div', 'ush', `Your models · ${fav.length}`));
      fav.forEach((id, i) => favBox.appendChild(row(byId.get(id) || { id }, true, i, fav.length)));
      if (!fav.length) note(favBox, 'None yet. Star models below; they will be the ones offered in the chat.');
    }
    function renderAll() {
      modelFilter = filter.value;
      try { vscode.setState({ ...(vscode.getState() || {}), modelFilter }); } catch { /* state is a convenience */ }
      const q = filter.value.toLowerCase().trim();
      const match = (x) => !q || x.id.toLowerCase().includes(q) || (x.name || '').toLowerCase().includes(q)
        || (q === 'free' && x.free) || ((q === 'go' || q === 'go plan') && x.plan);
      const items = (m.all || []).filter(match);
      list.textContent = '';
      items.slice(0, SHEET_LIMIT).forEach((x) => list.appendChild(row(x, false)));
      if (!items.length) note(list, 'No model matches.');
      else if (items.length > SHEET_LIMIT) note(list, `Showing ${SHEET_LIMIT} of ${items.length}. Type to narrow it down.`);
      allBox.firstChild.textContent = `All models · ${(m.all || []).length}`;
    }
    function toggle(id) { // instant here; the extension stores it
      const i = fav.indexOf(id);
      if (i >= 0) fav.splice(i, 1); else fav.push(id);
      vscode.postMessage({ type: 'toggleFavorite', id });
      const back = modelFocus;
      renderFav();
      renderAll();
      refocus(back);
    }
    function refocus(f) {
      if (!f) return false;
      const rows = [...s.querySelectorAll('.mrow')];
      const r = rows.find((x) => x._id === f.id && x._fav === f.fav) || rows.find((x) => x._id === f.id);
      r?.focus();
      return !!r;
    }
    allBox.append(el('div', 'ush', ''), filter, list);
    filter.oninput = renderAll;
    renderFav();
    renderAll();

    // Keyboard: ↓ from the filter into the list, ↑ ↓ between models, Enter = Use, Space = ☆,
    // Alt+↑ ↓ reorders your models, typing jumps back to the filter, Esc closes.
    s.onkeydown = (e) => {
      const rows = [...s.querySelectorAll('.mrow')];
      const r = e.target.closest?.('.mrow');
      if (e.key === 'Escape') { e.preventDefault(); return closeSheet(); }
      if (e.target === filter) {
        if (e.key === 'ArrowDown' || e.key === 'Enter') { e.preventDefault(); (list.querySelector('.mrow') || rows[0])?.focus(); }
        return;
      }
      if (!r || e.target !== r) return;
      const i = rows.indexOf(r);
      if (e.altKey && r._fav && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault();
        vscode.postMessage({ type: 'moveFavorite', id: r._id, dir: e.key === 'ArrowUp' ? -1 : 1 });
      } else if (e.key === 'ArrowDown') { e.preventDefault(); rows[i + 1]?.focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); (rows[i - 1] || filter).focus(); }
      else if (e.key === 'Home') { e.preventDefault(); rows[0]?.focus(); }
      else if (e.key === 'End') { e.preventDefault(); rows.at(-1)?.focus(); }
      else if (e.key === 'Enter') { e.preventDefault(); if (r._id !== m.current) { vscode.postMessage({ type: 'setModel', id: r._id }); closeSheet(); } }
      else if (e.key === ' ') { e.preventDefault(); toggle(r._id); }
      else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) { filter.focus(); } // the key lands in the filter
    };
    if (!refocus(modelFocus)) filter.focus();
  }

  // A button that asks once more before doing something you cannot take back from the panel.
  function confirmButton(label, iconName, title, onConfirm) {
    const b = el('button', 'icon');
    b.title = title;
    b.appendChild(icon(iconName));
    b.onclick = () => {
      if (b.classList.contains('armed')) return onConfirm();
      b.classList.add('armed');
      b.textContent = '';
      b.append(icon('warning'), el('span', '', label));
      setTimeout(() => { if (b.isConnected) { b.classList.remove('armed'); b.textContent = ''; b.appendChild(icon(iconName)); } }, 3000);
    };
    return b;
  }
  const iconBtn = (iconName, title, onclick) => {
    const b = el('button', 'icon');
    b.title = title;
    b.appendChild(icon(iconName));
    b.onclick = onclick;
    return b;
  };

  // ---- Your slash commands: prompt files omp loads; type /name in the chat to send one ----
  function showCommandsSheet(m) {
    const s = openSheet('Commands', 'symbol-event', () => vscode.postMessage({ type: 'commandsSheet' }));
    s.appendChild(el('div', 'unote', 'A command is a saved prompt: type /name in the chat to send it. omp also reads Claude Code commands (.claude/commands).'));
    if (m.note) s.appendChild(el('div', 'unote snote', m.note));
    const sec = section(s, `Your commands · ${m.list.length}`);
    for (const c of m.list) {
      const r = el('div', 'mrow');
      const text = el('div', 'mtext');
      text.append(el('div', 'mname', `/${c.name}${c.hint ? ' ' + c.hint : ''}`), el('div', 'mid', `${c.description || 'No description'} · ${c.scope}`));
      const use = el('button', 'secondary', 'Use');
      use.title = 'Put it in the message box';
      use.onclick = () => { closeSheet(); input.value = `/${c.name} `; input.focus(); autosize(); };
      r.append(icon('symbol-event'), text, use,
        iconBtn('edit', 'Edit the file', () => vscode.postMessage({ type: 'editCommand', file: c.file })),
        confirmButton('Delete?', 'trash', 'Delete (moves the file to the trash)', () => vscode.postMessage({ type: 'deleteCommand', file: c.file })));
      sec.appendChild(r);
    }
    if (!m.list.length) note(sec, 'None yet. Commands you create are saved as Markdown files you can share with your team.');
    const btns = el('div', 'cbtns');
    const add = el('button', 'primary', 'New command…');
    add.onclick = () => vscode.postMessage({ type: 'newCommand' });
    btns.appendChild(add);
    s.appendChild(btns);
  }

  // ---- MCP servers: switch on/off, test, remove, add (omp's /mcp commands) ----
  function showMcpSheet(m) {
    const s = openSheet('MCP servers', 'plug', () => vscode.postMessage({ type: 'mcp' }));
    s.appendChild(el('div', 'unote', 'MCP servers give the agent extra tools (GitHub, databases, browsers…). Servers start when the agent starts.'));
    if (m.note) {
      const n = el('pre', 'mcpout', m.note);
      s.appendChild(n);
    }
    const sec = section(s, `Servers · ${m.servers.length}`);
    for (const x of m.servers) {
      const r = el('div', 'mrow');
      const t = toggle(x.enabled, x.enabled ? 'Switch off' : 'Switch on');
      t.box.onchange = () => vscode.postMessage({ type: 'mcpAction', kind: t.box.checked ? 'enable' : 'disable', name: x.name });
      const text = el('div', 'mtext');
      text.append(el('div', 'mname', x.name), el('div', 'mid', `${x.type} · ${x.location} · ${x.scope === 'user' ? 'all projects' : 'this project'}`));
      r.append(t.label, text,
        iconBtn('debug-start', 'Test the connection', () => vscode.postMessage({ type: 'mcpAction', kind: 'test', name: x.name })),
        confirmButton('Remove?', 'trash', 'Remove this server', () => vscode.postMessage({ type: 'mcpAction', kind: 'remove', name: x.name })));
      sec.appendChild(r);
    }
    if (!m.servers.length) note(sec, 'No MCP servers in this project or your user settings yet.');
    const btns = el('div', 'cbtns');
    const add = el('button', m.changed ? 'secondary' : 'primary', 'Add server…');
    add.onclick = () => vscode.postMessage({ type: 'addMcp' });
    btns.appendChild(add);
    if (m.changed) {
      const apply = el('button', 'primary', 'Restart agent to apply');
      apply.title = 'The conversation is kept';
      apply.onclick = () => { closeSheet(); vscode.postMessage({ type: 'applyMcp' }); };
      btns.prepend(apply);
    }
    s.appendChild(btns);
  }

  // Saved keys per provider: switch, rename, remove, add. Providers with keys get a card each; the others are
  // a row of "+ Provider" chips below.
  function showKeys(m) {
    const s = openSheet('API keys', 'key');
    s.classList.add('keys');
    const mine = m.groups.filter((g) => g.keys.length), rest = m.groups.filter((g) => !g.keys.length);
    s.appendChild(el('div', 'unote', mine.length
      ? 'Click a key to use it. When the one in use hits its limit, OMP moves to the next key of that provider by itself.'
      : 'Add a key from one of these providers to start chatting. Keys stay in VS Code\'s encrypted storage.'));
    const scroll = el('div', 'kscroll');
    s.appendChild(scroll);
    for (const g of mine) {
      const card = el('div', 'kcard');
      const head = el('div', 'khead');
      const add = el('button', 'icon');
      add.title = `Add a ${g.providers.join(' / ')} key`;
      add.appendChild(icon('add'));
      add.onclick = () => vscode.postMessage({ type: 'addKey', provider: g.providers[0] });
      head.append(el('span', 'kprov', g.label), el('span', 'kcount', String(g.keys.length)), el('span', 'spacer'), add);
      head.title = g.about || '';
      card.appendChild(head);
      for (const k of g.keys) {
        const r = el('div', 'krow' + (k.active ? ' active' : ''));
        const name = el('span', 'klabel', k.label);
        const text = el('div', 'ktext');
        const line = el('div', 'kline');
        line.append(name, el('span', 'kmask', k.mask));
        if (k.active) line.appendChild(el('span', 'kuse', 'in use'));
        text.appendChild(line);
        if (k.baseUrl) {
          const u = el('div', 'kurl');
          u.append(icon('globe'), el('span', '', k.baseUrl));
          u.title = k.baseUrl;
          text.appendChild(u);
        }
        r.append(icon(k.active ? 'pass-filled' : 'circle-large-outline', 'kradio'), text);
        if (!k.active) { // the whole row switches to this key
          r.classList.add('pick');
          r.tabIndex = 0;
          r.title = 'Use this key';
          r.onclick = (e) => { if (e.target.closest('button, input')) return; r.classList.add('busy'); vscode.postMessage({ type: 'useKey', env: g.env, id: k.id, from: 'keys' }); };
          r.onkeydown = (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === r) { e.preventDefault(); r.click(); } };
        }
        const acts = el('span', 'kacts');
        const ren = el('button', 'icon');
        ren.title = 'Rename';
        ren.appendChild(icon('edit'));
        ren.onclick = () => {
          const box = el('input', 'finput');
          box.value = k.label;
          const done = (save) => { if (save && box.value.trim()) vscode.postMessage({ type: 'renameKey', env: g.env, id: k.id, label: box.value }); else box.replaceWith(name); };
          box.onkeydown = (e) => { if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); };
          box.onblur = () => done(true);
          name.replaceWith(box);
          box.focus();
          box.select();
        };
        const rm = el('button', 'icon');
        rm.title = 'Remove';
        rm.appendChild(icon('trash'));
        rm.onclick = () => { // second click confirms
          if (rm.dataset.armed) return vscode.postMessage({ type: 'removeKey', env: g.env, id: k.id });
          rm.dataset.armed = '1';
          rm.title = 'Click again to remove';
          rm.classList.add('armed');
          setTimeout(() => { delete rm.dataset.armed; rm.classList.remove('armed'); rm.title = 'Remove'; }, 3000);
        };
        const url = el('button', 'icon');
        url.title = 'Base URL';
        url.appendChild(icon('globe'));
        url.onclick = () => vscode.postMessage({ type: 'editBaseUrl', env: g.env, id: k.id });
        acts.append(ren, url, rm);
        r.appendChild(acts);
        card.appendChild(r);
      }
      scroll.appendChild(card);
    }
    if (rest.length) {
      scroll.appendChild(el('div', 'ush', mine.length ? 'Add a provider' : 'Providers'));
      const chips = el('div', 'kchips');
      for (const g of rest) {
        const c = el('button', 'chip kadd');
        c.title = g.about || '';
        c.append(icon('add'), el('span', '', g.label));
        c.onclick = () => vscode.postMessage({ type: 'addKey', provider: g.providers[0] });
        chips.appendChild(c);
      }
      scroll.appendChild(chips);
    }
  }
  function closeDialog(id, answer) {
    const d = dialogs.get(id);
    if (!d) return;
    dialogs.delete(id);
    // Answered prompts shrink to one line: "✓ Allow tool: edit — Approve".
    const denied = !answer || /^(deny|no)$/i.test(answer);
    d.card.className = 'confirm done';
    d.card.textContent = '';
    d.card.append(icon(denied ? 'circle-slash' : 'check'), el('span', '', `${d.head} — ${answer || 'cancelled'}`));
  }

  // ---- usage & limits ----
  const num = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n || 0));
  const money = (n) => '$' + (+n || 0).toFixed(+n && +n < 1 ? 4 : 2);
  function bar(frac) {
    const b = el('div', 'bar');
    const f = el('div', 'fill' + (frac >= 0.8 ? ' warn' : ''));
    f.style.width = Math.round(Math.min(1, Math.max(0, frac)) * 100) + '%';
    b.appendChild(f);
    return b;
  }
  function freeCount(m) {
    const q = m.freeQuota || m.account?.free_model_daily_requests;
    return q ? { used: q.used, limit: q.limit, exact: true } : { used: m.today?.free || 0, limit: 50, exact: false };
  }

  function resetsIn(iso) {
    const ms = Date.parse(iso) - Date.now();
    if (!(ms > 0)) return 'resetting';
    const h = Math.floor(ms / 3.6e6), d = Math.floor(h / 24), min = Math.floor(ms / 6e4) % 60;
    return 'resets in ' + (d ? `${d}d ${h % 24}h` : h ? `${h}h ${min}m` : `${min}m`);
  }
  // OpenCode Go style plan windows: { rolling|weekly|monthly: { status, percent, resetsAt } }
  const WINDOWS = [['rolling', '5 hours'], ['weekly', 'Week'], ['monthly', 'Month']];
  function windowLine(sec, label, w) {
    if (!w) return;
    const limited = w.status === 'rate-limited';
    line(sec, label, bar(limited ? 1 : w.percent / 100), `${limited ? 'limit reached' : w.percent + '%'} · ${resetsIn(w.resetsAt)}`);
  }
  // One-line summary of a key's limits, for the key list.
  function keySummary(a) {
    if (!a) return '';
    if (a.error) return 'error: ' + a.error;
    if (a.needKey || a.noApi) return '';
    if (a.windows?.rolling) return `5h ${a.windows.rolling.status === 'rate-limited' ? 'full' : a.windows.rolling.percent + '%'} · week ${a.windows.weekly?.percent ?? '?'}%`;
    if (a.free_model_daily_requests) return `free ${a.free_model_daily_requests.used}/${a.free_model_daily_requests.limit} today`;
    if (a.balance_infos) return a.balance_infos.map((b) => `${b.total_balance} ${b.currency}`).join(' · ');
    return '';
  }

  function showMeter(m) {
    const parts = [];
    let tip = [];
    const r = m.windows?.rolling;
    if (r) {
      parts.push(`5h ${r.status === 'rate-limited' ? 'full' : r.percent + '%'}`);
      tip.push(`Plan: ${r.percent}% of the 5-hour window used, ${resetsIn(r.resetsAt)}`);
    }
    // Context fill as a small ring, like Claude Code's context indicator; the numbers are in the tooltip.
    const ring = $('ring');
    ring.hidden = !m.context;
    if (m.context) {
      ring.style.setProperty('--p', Math.min(100, Math.round(m.context.percent)));
      if (m.context.percent >= 50) parts.unshift(`${Math.round(m.context.percent)}%`); // worth a number once it fills up
      tip.unshift(`Context: ${Math.round(m.context.percent)}% (${num(m.context.tokens)} of ${num(m.context.contextWindow)} tokens)`);
    }
    if (m.free) {
      const f = freeCount(m);
      parts.push(`${f.exact ? '' : '≈'}${f.used}/${f.limit}`);
      tip.push(`Free-model requests today: ${f.used} of ${f.limit}${f.exact ? '' : ' (counted by OMP Chat)'}`);
    }
    $('meterText').textContent = parts.join(' · ');
    $('meter').title = [...tip, 'Click for usage & limits'].join('\n');
    $('meter').hidden = !parts.length && !m.context;
    $('meter').classList.toggle('warn', (!!m.context && m.context.percent >= 80) || (!!r && (r.percent >= 80 || r.status === 'rate-limited')));
  }

  function section(panel, title) {
    const s = el('div', 'usec');
    s.appendChild(el('div', 'ush', title));
    panel.appendChild(s);
    return s;
  }
  function line(sec, label, ...values) {
    const r = el('div', 'urow');
    r.appendChild(el('span', 'ulabel', label));
    const v = el('span', 'uval');
    for (const x of values) v.append(typeof x === 'string' ? el('span', '', x) : x);
    r.appendChild(v);
    sec.appendChild(r);
  }
  function note(sec, text) { sec.appendChild(el('div', 'unote', text)); }

  function showUsage(m) {
    const panel = openSheet('Usage & limits', 'graph', () => vscode.postMessage({ type: 'usage' }));

    const s = m.stats;
    const chat = section(panel, 'This chat');
    if (s) {
      const n = (k, word) => `${k} ${word}${k === 1 ? '' : 's'}`;
      line(chat, 'Requests', `${n(s.assistantMessages, 'model call')} · ${n(s.toolCalls, 'tool call')}`);
      line(chat, 'Tokens', `${num(s.tokens.input)} in · ${num(s.tokens.output)} out · ${num(s.tokens.cacheRead)} cached`);
      line(chat, 'Cost', money(s.cost) + (/:free$/.test(m.model || '') ? ' (free model)' : ''));
      if (s.contextUsage) {
        const c = s.contextUsage;
        line(chat, 'Context', bar(c.percent / 100), `${Math.round(c.percent)}% of ${num(c.contextWindow)}`);
      }
    } else note(chat, 'No statistics yet.');

    const a = m.account;
    if (/:free$/.test(m.model || '')) { // OpenRouter's daily free-model quota
      const today = section(panel, 'Today (UTC)');
      const f = freeCount(m);
      line(today, 'Free requests', bar(f.used / f.limit), `${f.used} / ${f.limit}`);
      if (!f.exact) note(today, `Counted by OMP Chat (${m.today?.requests || 0} requests in total today). OpenRouter allows 50 free-model requests a day, 1,000 once you have bought $10 of credits.`);
    }

    if (a?.provider) {
      const names = { openrouter: 'OpenRouter account', deepseek: 'DeepSeek account', 'opencode-go': 'OpenCode Go plan', 'opencode-zen': 'OpenCode Zen' };
      const acc = section(panel, names[a.provider] || a.provider);
      if (a.windows) {
        for (const [k, label] of WINDOWS) windowLine(acc, label, a.windows[k]);
      } else if (a.noApi) {
        note(acc, 'This provider has no usage API; limits show up as errors when reached.');
      } else if (a.needKey) {
        note(acc, 'Save your API key in OMP Chat to see the exact quota and balance.');
        const b = el('button', 'secondary', 'Set API key');
        b.onclick = () => vscode.postMessage({ type: 'setApiKey' });
        acc.appendChild(b);
      } else if (a.error) {
        note(acc, 'Could not reach the provider: ' + a.error);
      } else if (a.provider === 'openrouter') {
        line(acc, 'Credits used', `today ${money(a.usage_daily)} · month ${money(a.usage_monthly)} · total ${money(a.usage)}`);
        if (a.limit == null) line(acc, 'Key limit', 'none');
        else line(acc, 'Key limit', bar(1 - a.limit_remaining / a.limit), `${money(a.limit_remaining)} left of ${money(a.limit)}`);
        line(acc, 'Plan', a.is_free_tier ? 'Free (no credits bought yet)' : 'Credits purchased');
      } else {
        for (const b of a.balance_infos || []) line(acc, 'Balance', `${b.total_balance} ${b.currency}`);
        if (a.is_available === false) note(acc, 'Balance too low for API calls. Top up at platform.deepseek.com.');
      }
    }

    // Saved keys of this provider: see which one has room left and switch with one click.
    if (m.keyGroup) {
      const ks = section(panel, `API keys · ${m.keyGroup}`);
      for (const k of m.keys || []) {
        const r = el('div', 'krow' + (k.active ? ' active' : ''));
        r.append(icon(k.active ? 'check' : 'key'), el('span', 'klabel', k.label), el('span', 'kmask', k.mask), el('span', 'ksum', keySummary(k.account)), el('span', 'spacer'));
        if (!k.active) {
          const use = el('button', 'secondary', 'Use');
          use.title = 'Switch to this key (the conversation continues)';
          use.onclick = () => { use.disabled = true; vscode.postMessage({ type: 'useKey', env: k.env, id: k.id }); };
          r.appendChild(use);
        }
        ks.appendChild(r);
      }
      if (!m.keys?.length) note(ks, 'No key saved for this provider.');
      const manage = el('button', 'secondary', m.keys?.length ? 'Add or manage keys…' : 'Add key…');
      manage.onclick = () => vscode.postMessage({ type: 'setApiKey' });
      ks.appendChild(manage);
    }
    panel.hidden = false;
  }

  // ---- inline pickers above the input: "/" commands, "@" files, models, past conversations ----
  // Item: { key, short?, label, desc?, icon?, badge? }. "/" and "@" filter on what is typed in the
  // message box; the model and history pickers have a filter box of their own.
  let pk = null; // { kind, all, items, active, choose, filter? }
  const ownFilter = (p) => !!p && (p.kind === 'model' || p.kind === 'history');
  let files = null; // workspace files, fetched when an "@" mention starts
  let atStart = -1; // index of the "@" being completed

  function rank(it, q) {
    if (!q) return 0;
    const k = it.key.toLowerCase(), s = (it.short || '').toLowerCase();
    if (k.startsWith(q) || s.startsWith(q)) return 0;
    if (k.includes(q)) return 1;
    return (it.desc || '').toLowerCase().includes(q) || (it.sub && it.label.toLowerCase().includes(q)) ? 2 : -1;
  }
  function openPicker(kind, all, choose, query) {
    // Lists you open from a button replace an open sheet; the @ and / lists while you type leave it alone.
    if (kind === 'history' || kind === 'model' || kind === 'mode') closeSheet();
    pk = { kind, all, choose, active: 0 };
    filterPicker(query || '');
  }
  function filterPicker(query) {
    const q = query.toLowerCase();
    pk.items = pk.all.map((it, i) => [rank(it, q), i, it]).filter(([r]) => r >= 0)
      .sort((a, b) => a[0] - b[0] || a[1] - b[1]).slice(0, pk.kind === 'history' ? 100 : 60).map(([, , it]) => it);
    pk.active = Math.min(pk.active, Math.max(0, pk.items.length - 1));
    renderPicker();
  }
  function hidePicker() { popup.hidden = true; popup.textContent = ''; pk = null; }
  function renderPicker() {
    if (!pk) return;
    if (!pk.items.length && !ownFilter(pk)) return hidePicker();
    popup.textContent = '';
    popup.className = 'picker-' + pk.kind;
    if (pk.kind === 'history') { // a title with the count, and a way to start over
      const top = el('div', 'ptop');
      const nw = el('button', 'pnew');
      nw.append(icon('add'), el('span', '', 'New chat'));
      nw.onmousedown = (e) => { e.preventDefault(); hidePicker(); vscode.postMessage({ type: 'new' }); };
      top.append(el('span', 'ptitle', 'Chats'), el('span', 'pcount', String(pk.all.length)), el('span', 'spacer'), nw);
      popup.appendChild(top);
    }
    if (ownFilter(pk)) {
      const head = el('div', 'phead');
      pk.filter ??= el('input', 'pfilter');
      pk.filter.placeholder = pk.kind === 'model' ? 'Filter your models' : 'Filter conversations';
      pk.filter.oninput = () => { pk.active = 0; filterPicker(pk.filter.value); };
      pk.filter.onkeydown = pickerKeys;
      pk.filter.onblur = () => setTimeout(() => { if (ownFilter(pk) && document.activeElement !== pk.filter) hidePicker(); }, 150);
      head.append(icon(pk.kind === 'model' ? 'sparkle' : 'history'), pk.filter);
      if (pk.kind === 'model') {
        const manage = el('button', 'icon');
        manage.title = 'Manage your models';
        manage.appendChild(icon('settings-gear'));
        manage.onmousedown = (e) => { e.preventDefault(); hidePicker(); vscode.postMessage({ type: 'manageModels' }); };
        head.appendChild(manage);
      }
      popup.appendChild(head);
      if (pk.kind === 'model') popup.appendChild(effortRow());
    }
    const list = el('div', 'plist'), foot = document.createDocumentFragment();
    list.setAttribute('role', 'listbox');
    const grouped = !pk.filter?.value; // filtered results are ranked, not in date order
    pk.items.forEach((it, i) => {
      if (grouped && it.group && it.group !== pk.items[i - 1]?.group) list.appendChild(el('div', 'pgroup', it.group));
      const row = el('div', 'item' + (i === pk.active ? ' active' : '') + (it.sub ? ' two' : '') + (it.cls ? ' ' + it.cls : ''));
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(i === pk.active));
      if (it.tip) row.title = it.tip;
      if (it.icon) row.appendChild(icon(it.icon));
      if (it.sub) { // name over a muted detail line
        const text = el('span', 'ptext');
        text.append(el('span', 'pname', it.label), el('span', 'psub', it.sub));
        row.appendChild(text);
      } else {
        row.appendChild(el('span', 'pname', it.label));
        if (it.desc) row.appendChild(el('span', 'pdesc', it.desc));
      }
      if (it.badge) row.appendChild(el('span', 'pbadge', it.badge));
      if (it.star !== undefined) { // ☆ pins a model to "your models" without choosing it
        const star = el('button', 'icon pstar' + (it.star ? ' on' : ''));
        star.title = it.star ? 'Remove from your models' : 'Add to your models';
        star.appendChild(icon(it.star ? 'star-full' : 'star-empty'));
        star.onmousedown = (e) => {
          e.preventDefault();
          e.stopPropagation();
          it.star = !it.star;
          vscode.postMessage({ type: 'toggleFavorite', id: it.key });
          renderPicker();
        };
        row.appendChild(star);
      }
      for (const a of it.actions || []) { // e.g. rename / delete a conversation
        const b = el('button', 'icon pact');
        b.title = a.title;
        b.setAttribute('aria-label', a.title);
        b.appendChild(icon(a.icon));
        b.onmousedown = (e) => { e.preventDefault(); e.stopPropagation(); hidePicker(); vscode.postMessage(a.msg); };
        row.appendChild(b);
      }
      row.onmousedown = (e) => { e.preventDefault(); choosePicked(i); };
      (it.cls === 'pfoot' ? foot : list).appendChild(row); // a footer row stays in view below the scrolling list
    });
    if (!pk.items.length) list.appendChild(el('div', 'pempty', 'No match'));
    popup.append(list, foot);
    popup.hidden = false;
    list.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
    if (ownFilter(pk) && document.activeElement !== pk.filter) pk.filter.focus();
  }
  function choosePicked(i) {
    const it = pk.items[i], choose = pk.choose;
    hidePicker();
    choose(it);
  }
  // Arrow keys / Enter / Tab / Escape while a picker is open. Returns true if the key was used.
  function pickerKeys(e) {
    if (!pk || (!pk.items.length && e.key !== 'Escape')) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      pk.active = (pk.active + (e.key === 'ArrowDown' ? 1 : pk.items.length - 1)) % pk.items.length;
      renderPicker();
    } else if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
      choosePicked(pk.active);
    } else if (e.key === 'Escape') {
      hidePicker();
      input.focus();
    } else if (pk.kind === 'history' && (e.key === 'F2' || (e.key === 'Delete' && !pk.filter?.value))) {
      const a = pk.items[pk.active].actions?.[e.key === 'F2' ? 0 : 1]; // Delete with filter text edits the filter
      hidePicker();
      if (a) vscode.postMessage(a.msg);
    } else return false;
    e.preventDefault();
    return true;
  }

  // Which picker the text left of the caret calls for.
  function updateInlinePicker() {
    const before = input.value.slice(0, input.selectionStart);
    let m = /^\/(\S*)$/.exec(input.value);
    if (m && commands.length) return openSlash(m[1]);
    m = /(^|\s)@([^\s@]*)$/.exec(before);
    if (m) {
      const start = before.length - m[2].length - 1;
      if (start !== atStart || !files) { atStart = start; vscode.postMessage({ type: 'listFiles' }); } // refresh per mention
      return openPicker('file', files || [], insertFile, m[2]);
    }
    if (pk && !ownFilter(pk)) hidePicker();
  }
  // The / list: typed at the start of the box, or from the / button (which keeps what you already typed after it).
  function openSlash(query, fromButton) {
    const all = commands.map((c) => ({ key: c.name, label: '/' + c.name, desc: c.hint ? `${c.hint} — ${c.description}` : c.description }));
    const manage = { key: '\u0000commands', label: 'Your commands…', icon: 'settings-gear', desc: 'create, edit or delete your own / commands' };
    openPicker('slash', [...all, manage], (it) => {
      const rest = input.value.replace(/^\/\S*\s*/, '');
      if (it === manage) { input.value = rest; autosize(); return vscode.postMessage({ type: 'commandsSheet' }); }
      input.value = '/' + it.key + ' ' + rest;
      input.focus();
      input.setSelectionRange(it.key.length + 2, it.key.length + 2);
      autosize();
    }, query);
    if (fromButton) input.focus(); // ↑ ↓ Enter from the box
  }
  function insertFile(it) {
    const caret = input.selectionStart;
    const text = '@' + it.key + ' ';
    input.value = input.value.slice(0, atStart) + text + input.value.slice(caret);
    const pos = atStart + text.length;
    atStart = -1;
    input.focus();
    input.setSelectionRange(pos, pos);
    autosize();
  }
  function ago(t) {
    const s = (Date.now() - t) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + ' min ago';
    if (s < 86400) return Math.floor(s / 3600) + ' h ago';
    return Math.floor(s / 86400) + ' d ago';
  }
  function dayGroup(t) {
    const today = new Date().setHours(0, 0, 0, 0), day = 86400000;
    return t >= today ? 'Today' : t >= today - day ? 'Yesterday' : t >= today - 7 * day ? 'Previous 7 days' : 'Older';
  }
  // When, as fits its day group: the time today and yesterday, the weekday this week, the date before that.
  function when(t) {
    const g = dayGroup(t), d = new Date(t);
    if (g === 'Today' || g === 'Yesterday') return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (g === 'Previous 7 days') return d.toLocaleDateString([], { weekday: 'short' });
    return d.toLocaleDateString([], { month: 'short', day: 'numeric', ...(d.getFullYear() !== new Date().getFullYear() && { year: 'numeric' }) });
  }
  function showSessions(m) { // the list comes newest first
    const all = m.list.map((x) => ({ key: x.title, label: x.title, desc: when(x.when), badge: x.current ? 'current' : '', file: x.file, group: dayGroup(x.when),
      tip: `${x.title}\n${new Date(x.when).toLocaleString()}`, cls: x.current ? 'cur' : '',
      actions: [{ icon: 'edit', title: 'Rename (F2)', msg: { type: 'renameSession', file: x.file } },
        { icon: 'trash', title: 'Delete (Del)', msg: { type: 'deleteSession', file: x.file } }] }));
    pk = null;
    openPicker('history', all, (it) => vscode.postMessage({ type: 'openSession', file: it.file }));
    pk.active = Math.max(0, all.findIndex((x) => !x.badge)); // Enter opens the latest other conversation
    renderPicker();
  }
  const modelBadge = (x) => (x.usedUp ? `used up · ${x.usedUp}` : x.plan ? 'Go plan' : x.free ? 'free' : '');
  // "1M ctx · images · $2 / $10": what tells models apart when picking one (price per 1M tokens in / out).
  const tokens = (n) => (n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1e3)}K`);
  const price = (n) => `$${n >= 10 ? Math.round(n) : +n.toFixed(2)}`;
  const modelMeta = (x) => [
    x.contextWindow ? `${tokens(x.contextWindow)} ctx` : '',
    x.vision ? 'images' : '',
    x.cost ? `${price(x.cost.input)} / ${price(x.cost.output)}` : '',
  ].filter(Boolean).join(' · ');
  // The chat's picker: only your models (plus the one in use), and a way to the full list.
  function showModels(m) {
    const mine = m.list.filter((x) => x.favorite || x.id === m.current).map((x) => ({
      key: x.id, short: x.id.split('/').slice(1).join('/'), label: x.name || x.id, icon: x.id === m.current ? 'check' : 'blank',
      sub: [x.id.split('/')[0], modelMeta(x)].filter(Boolean).join(' · '), desc: x.id, badge: modelBadge(x),
      tip: `${x.id}${x.cost ? '\nPrice per 1M tokens: input / output' : ''}`,
    }));
    const manage = { key: '\u0000manage', label: 'Manage models…', icon: 'settings-gear', cls: 'pfoot',
      desc: mine.length > 1 ? 'all models, add or reorder yours' : 'pick your models from the full list' };
    pk = null;
    openPicker('model', [...mine, manage], (it) => (it === manage
      ? vscode.postMessage({ type: 'manageModels' })
      : vscode.postMessage({ type: 'setModel', id: it.key })));
  }

  // ---- input wiring ----
  function autosize() {
    syncSendStop();
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 220) + 'px';
  }
  // One spot, like Claude Code: Stop while the agent works, Send (queue) once you type something.
  function syncSendStop() {
    const stop = busy && !input.value.trim() && !pending.length && !attached.length;
    stopBtn.hidden = !stop;
    sendBtn.hidden = stop;
  }
  function setContextOn(on) {
    useContext = on;
    // The open file, first among what goes with the message: the eye says whether it is sent
    // (click to toggle; a newly opened file is included again). Hidden when it is pinned anyway.
    $('ctxChip').hidden = !contextLabel || pinned.some((p) => p.rel === contextRel);
    $('ctxChip').classList.toggle('off', !on);
    ctxIcon.className = 'codicon codicon-' + (on ? 'eye' : 'eye-closed');
    ctxEye.title = `${contextFull || contextLabel || ''}\n${on ? 'Sent with your next message. Click to leave it out.' : 'Not sent. Click to include it.'}`;
    ctxEye.setAttribute('aria-pressed', String(on));
  }
  function renderPinned() {
    const box = $('pinned');
    box.textContent = '';
    for (const p of pinned) {
      const c = el('span', 'chip pinchip');
      c.title = `${p.rel}\nAttached to every message until you remove it.`;
      const x = el('button', 'ctxx');
      x.title = 'Remove';
      x.appendChild(icon('close'));
      x.onclick = () => vscode.postMessage({ type: 'unpinFile', rel: p.rel });
      c.append(icon('pinned'), el('span', 'plabel', p.label), x);
      box.appendChild(c);
    }
  }

  // Under each finished reply: copy the whole answer, and what the turn cost.
  function turnFooter(t) {
    if (!t || !t.querySelector('.md, .tool')) return t?._foot;
    const f = t._foot || (t._foot = t.appendChild(el('div', 'tfoot')));
    if (f._copy || !t.querySelector('.md')) return f; // tools only: nothing to copy
    const b = f._copy = el('button', 'icon');
    b.title = 'Copy answer (Markdown)';
    b.appendChild(icon('copy'));
    b.onclick = () => {
      navigator.clipboard.writeText([...t.querySelectorAll('.md')].map((e) => (e._raw || '').trim()).filter(Boolean).join('\n\n'));
      b.firstChild.className = 'codicon codicon-check';
      setTimeout(() => { b.firstChild.className = 'codicon codicon-copy'; }, 1200);
    };
    f.prepend(b);
    return f;
  }
  const kTok = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));
  function showTurnStats(m) {
    const f = turnFooter(turn);
    if (!f) return;
    const cost = m.cost > 0 ? ` · $${m.cost < 0.01 ? m.cost.toFixed(4) : m.cost.toFixed(2)}` : ' · free';
    const s = el('span', 'tstats', `${kTok(m.input)} in · ${kTok(m.output)} out${cost}${m.seconds ? ` · ${m.seconds}s` : ''}`);
    s.title = 'Tokens sent and received this turn, and what it cost (as priced by omp)';
    f.querySelector('.tstats')?.remove();
    f.appendChild(s);
  }

  sendBtn.onclick = () => send();
  stopBtn.onclick = () => vscode.postMessage({ type: 'stop' });
  modelBtn.onclick = () => (pk?.kind === 'model' ? hidePicker() : vscode.postMessage({ type: 'pickModel' }));
  $('meter').onclick = () => vscode.postMessage({ type: 'usage' });
  // Approval mode and thinking level: compact pills that open a list in the popup (native <select>s are as wide as
  // their longest option, which does not fit a narrow sidebar).
  const MODES = [
    { key: 'always-ask', short: 'Ask', label: 'Ask before edits', icon: 'shield', desc: 'asks before every file change and command' },
    { key: 'always-ask-cached', short: 'Ask, remember', label: 'Ask & remember', icon: 'shield', desc: 'like Ask, and you can approve a file or folder for the session' },
    { key: 'write', short: 'Edit auto', label: 'Edit automatically', icon: 'run-all', desc: 'edits files freely, asks before commands' },
    { key: 'yolo', short: 'Full auto', label: 'Full auto', icon: 'zap', desc: 'never asks' },
    { key: 'plan', short: 'Plan', label: 'Plan mode', icon: 'debug-pause', desc: 'reads and writes a plan, changes nothing' },
  ];
  // Effort (thinking), as in Claude Code's model picker: always on, high by default. minimal / xhigh are settings-only
  // and show up in the row only while in use.
  const EFFORTS = ['low', 'medium', 'high', 'max'];
  const EFFORT_TIPS = { minimal: 'Fastest, least thinking', low: 'Quick answers, light thinking', medium: 'Balanced',
    high: 'Thinks carefully (default)', xhigh: 'Thinks longer than high', max: 'Slowest, most thorough' };
  let mode = 'always-ask', think = 'high';
  function showMode(v) {
    const m = MODES.find((x) => x.key === v) || MODES[0];
    mode = m.key;
    $('modeIcon').className = `codicon codicon-${m.icon}`;
    $('modeLabel').textContent = m.short;
    modeBtn.title = `${m.label}: ${m.desc} (Shift+Tab)`;
    modeBtn.dataset.mode = m.key; // Full auto and Plan are coloured, so you notice them
  }
  function showThink(v) {
    think = EFFORT_TIPS[v] ? v : 'high';
    $('effort').textContent = ` · ${think}`; // "deepseek-v4-flash · high", like "Sonnet · high"
  }
  function setThink(v) { showThink(v); vscode.postMessage({ type: 'setThinking', level: think }); }
  // The Effort row at the top of the model picker.
  function effortRow() {
    const row = el('div', 'peffort');
    row.appendChild(el('span', 'elabel', 'Effort'));
    const seg = el('div', 'segs');
    seg.setAttribute('role', 'radiogroup');
    for (const k of EFFORTS.includes(think) ? EFFORTS : [...EFFORTS, think]) {
      const b = el('button', 'seg' + (k === think ? ' on' : ''), k);
      b.title = EFFORT_TIPS[k];
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(k === think));
      b.onmousedown = (e) => { e.preventDefault(); setThink(k); renderPicker(); }; // the filter keeps the focus
      seg.appendChild(b);
    }
    row.appendChild(seg);
    return row;
  }
  function setMode(v) { showMode(v); vscode.postMessage({ type: 'setMode', mode }); }
  // A short list in the popup; ↑ ↓ Enter work from the message box, which keeps the focus.
  function openChoices(kind, list, cur, choose) {
    if (pk?.kind === kind) return hidePicker();
    openPicker(kind, list.map((x) => ({ key: x.key, label: x.label, desc: x.desc, icon: x.key === cur ? 'check' : x.icon || 'blank' })), (it) => choose(it.key));
    pk.active = Math.max(0, list.findIndex((x) => x.key === cur));
    renderPicker();
    input.focus();
  }
  for (const b of [modeBtn, modelBtn, $('slash'), $('attach')]) b.onmousedown = (e) => e.preventDefault(); // keep the caret in the box
  modeBtn.onclick = () => openChoices('mode', MODES, mode, setMode);
  $('slash').onclick = () => (pk?.kind === 'slash' ? hidePicker() : openSlash('', true));
  showMode(mode);
  showThink(think);
  ctxEye.onclick = () => setContextOn(!useContext);
  $('ctxPin').onclick = () => contextRel && vscode.postMessage({ type: 'pinFile', rel: contextRel });
  $('attach').onclick = () => {
    const p = input.selectionStart;
    const lead = p > 0 && !/\s/.test(input.value[p - 1]) ? ' @' : '@'; // a mention must start a word
    input.value = input.value.slice(0, p) + lead + input.value.slice(p);
    input.focus();
    input.setSelectionRange(p + lead.length, p + lead.length);
    updateInlinePicker();
  };
  for (const card of document.querySelectorAll('#suggest .card')) card.onclick = () => send(card.dataset.prompt);
  // The start screen's latest conversations, one click to pick each up again.
  function showRecent(list) {
    const box = $('recent');
    box.textContent = '';
    box.hidden = !list?.length;
    if (box.hidden) return;
    const head = el('div', 'wsh');
    const all = el('button', 'wall', 'All chats');
    all.onclick = () => vscode.postMessage({ type: 'history' });
    head.append(el('span', '', 'Recent'), all);
    box.appendChild(head);
    for (const x of list) {
      const b = el('button', 'rrow');
      b.title = x.title;
      b.append(icon('comment-discussion'), el('span', 'rtitle', x.title), el('span', 'rwhen', ago(x.when)));
      b.onclick = () => vscode.postMessage({ type: 'openSession', file: x.file });
      box.appendChild(b);
    }
  }

  // Files and images: the + button, paste into the message box, or drop anywhere on the panel.
  $('addImage').onclick = () => $('imageFile').click();
  $('imageFile').onchange = (e) => { addFiles(e.target.files); e.target.value = ''; };
  input.addEventListener('paste', (e) => {
    const list = [...(e.clipboardData?.files || [])];
    if (list.length) { e.preventDefault(); addFiles(list); }
  });
  // Files from the OS arrive as File objects; files dragged from VS Code's Explorer or tabs only as URIs,
  // which the extension turns into paths.
  const box = $('box');
  const dropUris = (dt) => (dt.getData('application/vnd.code.uri-list') || dt.getData('text/uri-list') || '')
    .split(/\r?\n/).map((s) => s.trim()).filter((s) => /^file:/i.test(s));
  let drags = 0; // dragenter / dragleave also fire for every child crossed
  const dropOff = () => { drags = 0; box.classList.remove('drop'); };
  document.addEventListener('dragenter', (e) => { e.preventDefault(); drags++; box.classList.add('drop'); });
  document.addEventListener('dragover', (e) => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; });
  document.addEventListener('dragleave', () => { if (--drags <= 0) dropOff(); });
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    dropOff();
    const dt = e.dataTransfer;
    if (!dt) return;
    if (dt.files?.length) addFiles(dt.files);
    else if (dropUris(dt).length) vscode.postMessage({ type: 'dropUris', uris: dropUris(dt) });
    input.focus();
  });

  // Claude Code keys: Shift+Tab cycles the approval mode, Esc stops the agent.
  function cycleMode() {
    setMode(MODES[(MODES.findIndex((x) => x.key === mode) + 1) % MODES.length].key);
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && busy && !pk && !openForm) { e.preventDefault(); vscode.postMessage({ type: 'stop' }); }
  });

  // ↑ / ↓ in an empty box (or on a recalled message you have not edited) walk through what you sent, like a shell.
  let sent = Array.isArray(st().sent) ? st().sent : [];
  let histAt = -1; // index into sent while browsing, -1 otherwise
  function recall(e) {
    const up = e.key === 'ArrowUp';
    if ((!up && e.key !== 'ArrowDown') || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey || !sent.length) return false;
    const browsing = histAt >= 0 && input.value === sent[histAt];
    if (!browsing && input.value) return false;
    if (!browsing) histAt = -1;
    // Inside a recalled multi-line message the arrows still move the caret, until it reaches the first / last line.
    const v = input.value, p = input.selectionStart;
    if (up ? v.lastIndexOf('\n', p - 1) >= 0 : v.indexOf('\n', p) >= 0) return false;
    if (!up && histAt < 0) return false;
    histAt = up ? (histAt < 0 ? sent.length - 1 : Math.max(0, histAt - 1)) : histAt + 1;
    if (histAt >= sent.length) histAt = -1;
    input.value = histAt < 0 ? '' : sent[histAt];
    const end = up ? 0 : input.value.length; // land where the next press keeps going
    input.setSelectionRange(end, end);
    autosize();
    updateShellMode();
    e.preventDefault();
    return true;
  }

  input.addEventListener('keydown', (e) => {
    if (pk && !ownFilter(pk) && pickerKeys(e)) return;
    if (recall(e)) return;
    if (e.key === 'Tab' && e.shiftKey) { e.preventDefault(); return cycleMode(); }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  // A leading "!" switches the box to shell mode, like Claude Code's bash mode.
  // ... and a leading "#" (one line) saves a note to the project's memory, like Claude Code's # shortcut.
  function updateShellMode() {
    const on = /^!/.test(input.value);
    const mem = /^#(?!#)/.test(input.value) && !input.value.includes('\n');
    $('box').classList.toggle('shellmode', on);
    $('box').classList.toggle('memmode', mem);
    $('shellHint').hidden = !on;
    $('memHint').hidden = !mem;
  }
  input.addEventListener('input', () => { autosize(); updateShellMode(); if (pk) pk.active = 0; updateInlinePicker(); saveState({ draft: input.value }); });
  // What you were typing comes back after a reload.
  if (st().draft) { input.value = st().draft; autosize(); updateShellMode(); }
  input.addEventListener('click', updateInlinePicker); // caret moved into / out of a mention
  input.addEventListener('blur', () => setTimeout(() => { if (pk && !ownFilter(pk)) hidePicker(); }, 150));

  // ---- messages from the extension ----
  window.addEventListener('message', (ev) => {
    const m = ev.data;
    switch (m.type) {
      case 'user': {
        endAssistant();
        clearProgress();
        const t = newTurn('user');
        if (m.turn) addRewind(t, m.turn);
        if (m.images?.length) {
          const g = el('div', 'uimgs');
          for (const src of m.images) { const im = el('img'); im.src = src; g.appendChild(im); }
          t._body.appendChild(g);
        }
        if (m.text) t._body.appendChild(el('div', 'utext', m.text));
        for (const label of [].concat(m.context || [])) {
          const c = el('div', 'uctx');
          c.append(icon('file'), el('span', '', label));
          t._body.appendChild(c);
        }
        turnFooter(turn);
        turn = null; // the reply starts a new OMP turn
        for (const [k, s] of subData) if (s.status !== 'running') barDismissed.add(k); // finished ones leave the bar
        renderAgentsBar();
        showProgress();
        scroll(true); // you just sent it: follow the reply
        break;
      }
      case 'text':
        if (!cur) { clearProgress(); endThink(); foldTools(body()); cur = add('md'); cur._raw = ''; }
        cur._raw += m.delta;
        renderSoon(cur);
        break;
      case 'thinking':
        if (!curThink) startThink();
        curThink._body.textContent += m.delta;
        break;
      case 'assistant_done': endAssistant(); showProgress(); break;
      case 'tool_start': {
        endAssistant();
        clearProgress();
        foldTools(body());
        const d = el('details', 'tool running');
        d._tool = { name: m.name, args: m.args }; // an approval card for it shows what it will change
        const s = el('summary');
        let detail = String(toolDetail(m.args) || '');
        d._verbs = VERBS[m.name] || [m.name, m.name];
        if (/^skill:\/\//.test(m.args?.path || '')) { // the agent opening a skill: name it like Claude Code does
          d._verbs = ['Using skill', 'Used skill'];
          detail = m.args.path.slice('skill://'.length).split('/')[0];
        }
        s.append(icon('loading', 'codicon-modifier-spin ticon'), el('span', 'tverb', d._verbs[0]));
        if (detail) s.appendChild(el('code', 'targ', detail.length > 80 ? detail.slice(0, 80) + '…' : detail));
        if (m.name === 'bash' && m.args?.command) s.appendChild(terminalButton(m.args.command));
        d.appendChild(s);
        body().appendChild(d);
        tools.set(m.id, d);
        toolRows.set(m.id, d);
        scroll();
        break;
      }
      case 'tool_update': { // live output while the tool runs: shown open, then folded when it ends
        const d = tools.get(m.id);
        if (!d) break;
        d._live ??= d.appendChild(el('pre', 'out live'));
        d._live.textContent = m.output;
        d._live.scrollTop = d._live.scrollHeight;
        d.open = true;
        d._autoOpened = true;
        scroll();
        break;
      }
      case 'tool_end': {
        const d = tools.get(m.id);
        if (!d) break;
        tools.delete(m.id);
        d.classList.remove('running');
        d.classList.add(m.isError ? 'err' : 'ok');
        d.querySelector('.ticon').className = 'codicon ticon codicon-' + (m.isError ? 'error' : 'check');
        d.querySelector('.tverb').textContent = d._verbs[1];
        d._live?.remove();
        if (d._autoOpened) d.open = false;
        if (m.output) d.appendChild(el('pre', 'out', m.output));
        if (m.files?.length) d.after(changesBlock(m.files));
        showProgress();
        scroll();
        break;
      }
      case 'shell_start': { // a "!command" you ran: shown on your side, with its output below
        endAssistant();
        clearProgress();
        welcome.hidden = true;
        const b = el('div', 'shell running');
        const head = el('div', 'shead');
        head.append(icon('loading', 'codicon-modifier-spin sicon'), el('code', 'scmd', '$ ' + m.command), el('span', 'spacer'), terminalButton(m.command));
        const stop = el('button', 'icon sstop');
        stop.title = 'Stop this command';
        stop.appendChild(icon('debug-stop'));
        stop.onclick = () => vscode.postMessage({ type: 'stop' });
        head.appendChild(stop);
        b.appendChild(head);
        log.appendChild(b);
        shells.set(m.id, b);
        turn = null; // the next reply starts a new OMP turn
        scroll();
        break;
      }
      case 'shell_end': {
        const b = shells.get(m.id);
        if (!b) break;
        shells.delete(m.id);
        const ok = !m.cancelled && !m.timedOut && (m.exitCode === 0 || m.exitCode === undefined);
        b.classList.remove('running');
        b.classList.add(ok ? 'ok' : 'err');
        b.querySelector('.sicon').className = 'codicon sicon codicon-' + (ok ? 'check' : 'error');
        b.querySelector('.sstop')?.remove();
        const status = m.cancelled ? 'stopped' : m.timedOut ? 'timed out' : m.exitCode === undefined ? '' : `exit ${m.exitCode}`;
        if (status) b.querySelector('.shead').insertBefore(el('span', 'sexit', status), b.querySelector('.spacer'));
        if (m.output) b.appendChild(el('pre', 'out', m.output + (m.truncated ? '\n… (output truncated)' : '')));
        scroll();
        break;
      }
      case 'reverted': {
        const b = log.querySelector(`button[data-edit="${m.id}"]`);
        if (b) {
          b.disabled = true;
          b.title = 'Undone';
          b.closest('.cfile')?.classList.add('undone');
        }
        break;
      }
      case 'dialog': endAssistant(); showDialog(m); break;
      case 'dialog_close': closeDialog(m.id, null); break;
      case 'command_output': {
        const o = add('md cmdout');
        o._md = mdLines;
        o._raw = m.text;
        render(o);
        break;
      }
      case 'busy': setBusy(true); break;
      case 'idle': endAssistant(); setBusy(false); turnFooter(turn); break;
      case 'turnStats': showTurnStats(m); break;
      case 'focusInput': input.focus(); break;
      case 'error':
      case 'notice': {
        const e = add(m.type === 'error' ? 'errorline' : 'noticeline');
        e.append(icon(m.type === 'error' ? 'error' : 'info'), el('span', '', m.text));
        if (m.actions?.length) {
          const acts = el('div', 'lineacts');
          for (const a of m.actions) {
            const b = el('button', 'secondary', a.label);
            b.onclick = () => {
              vscode.postMessage({ type: 'action', cmd: a.cmd, arg: a.arg });
              if (['revertForce', 'openUrl', 'setModel'].includes(a.cmd)) for (const x of acts.children) x.disabled = true; // one-shot
            };
            acts.appendChild(b);
          }
          e.appendChild(acts);
        }
        break;
      }
      case 'log': console.log(m.text); break;
      case 'clear':
        for (const n of [...log.querySelectorAll('.turn')]) n.remove();
        welcome.hidden = false;
        scroll(true);
        endThink(); // stops its timer
        turn = null; cur = null; progress = null;
        tools.clear(); dialogs.clear(); toolRows.clear(); subCards.clear(); subData.clear(); barDismissed = new Set();
        renderAgentsBar();
        $('queue').textContent = ''; $('queue').hidden = true;
        setBusy(false);
        break;
      case 'model': {
        const name = m.name || '';
        $('modelName').textContent = name.split('/').pop();
        modelBtn.title = `Model: ${name} (click to change)`;
        break;
      }
      case 'mode': showMode(m.mode); break;
      case 'thinking_level': showThink(m.level || ''); break;
      case 'paths': markPaths(m); break;
      case 'session': saveState({ session: { file: m.file, worktree: m.worktree || null } }); break; // a tab reopens it after a reload
      case 'meter': showMeter(m); break;
      case 'usage': showUsage(m); break;
      case 'commands': commands = m.list || []; break;
      case 'context':
        if (m.label !== contextLabel) useContext = true;
        contextLabel = m.label;
        contextFull = m.full || m.label;
        contextRel = m.rel || null;
        pinned = m.pinned || [];
        renderPinned();
        ctxLabel.textContent = m.label || '';
        setContextOn(useContext);
        break;
      case 'files':
        files = [
          { key: 'problems', short: 'problems', label: 'problems', desc: 'errors and warnings from the Problems panel', icon: 'warning' },
          { key: 'terminal', short: 'terminal', label: 'terminal', desc: 'recent output of the active terminal', icon: 'terminal' },
          { key: 'git', short: 'git', label: 'git', desc: 'uncommitted changes (git status and diff)', icon: 'git-compare' },
          // Folders ("@src/"): omp sends the folder's file listing. Ahead of files, so "@src" offers the folder first.
          ...[...new Set(m.list.flatMap((p) => p.split('/').slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join('/') + '/')))].sort()
            .map((d) => ({ key: d, short: d.split('/').at(-2) + '/', label: d.split('/').at(-2) + '/', desc: d, icon: 'folder' })),
          ...m.list.map((p) => ({ key: p, short: p.split('/').pop(), label: p.split('/').pop(), desc: p.includes('/') ? p : '', icon: 'file' }))];
        if (pk?.kind === 'file') updateInlinePicker();
        break;
      case 'models': showModels(m); break;
      case 'queued': addQueued(m); break;
      case 'dequeued': dropQueued(m.qid); break;
      case 'unqueued': // taken back out of the queue: the text returns to the message box
        dropQueued(m.qid);
        input.value = m.text + (input.value ? '\n' + input.value : '');
        autosize();
        input.focus();
        break;
      case 'prefill': // after Rewind: the message you went back to, ready to edit and resend
        input.value = m.text || '';
        autosize();
        input.focus();
        break;
      case 'todos': showTodos(m.phases || []); break;
      case 'planReady': showPlanReady(); break;
      case 'sessions': showSessions(m); break;
      case 'recent': showRecent(m.list); break;
      case 'attachPaths': // files dragged from VS Code, as paths the agent can read
        for (const p of m.list || []) if (attached.length < MAX_FILES && !attached.some((a) => a.path === p.path)) attached.push(p);
        renderAttached();
        break;
      case 'form': showForm(m); break;
      case 'keys': showKeys(m); break;
      case 'plugins': showPlugins(m); break;
      case 'modelsSheet': showModelsSheet(m); break;
      case 'commandsSheet': showCommandsSheet(m); break;
      case 'mcpSheet': showMcpSheet(m); break;
      case 'subagent': renderSubagent(m); break;
      case 'subagentTranscript': showSubagentTranscript(m); break;
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
