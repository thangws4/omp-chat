// The Subagents tab: the run as a tree (lead on top, each subagent under the agent that spawned it) and, for the agent
// you click, its conversation live with a box to steer it. Data comes from the chat (subagent-map.js).
(function () {
  const vscode = acquireVsCodeApi();
  const hl = window.ompHighlight;
  const md = window.markdownit({
    html: false, linkify: true,
    highlight: (code, lang) => (hl ? `<pre class="hljs"><code>${hl.highlight(code, lang)}</code></pre>` : ''),
  });
  const $ = (id) => document.getElementById(id);
  try { window.ompL10n?.watch(window.ompL10n.compile(JSON.parse($('l10n')?.textContent || 'null')), document.body); }
  catch (e) { console.error('l10n', e); }

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  const icon = (name, extra) => el('span', `codicon codicon-${name}${extra ? ' ' + extra : ''}`);
  const STATUS = { running: ['loading', 'codicon-modifier-spin'], completed: ['pass-filled'], failed: ['error'], aborted: ['circle-slash'] };
  const END = { completed: 'Done', failed: 'Failed', aborted: 'Stopped' };
  const SHOWN_STEPS = 3;
  const dur = (ms) => {
    const s = Math.max(0, Math.round(ms / 1000));
    return s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
  };
  const kTok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n >= 10000 ? 0 : 1)}k` : String(n || 0));
  const money = (n) => (n > 0 ? `$${n < 0.01 ? n.toFixed(4) : n.toFixed(2)}` : '');
  // Same provider, same colour (the VS Code chart palette, so it follows the theme).
  const COLORS = ['blue', 'green', 'orange', 'purple', 'yellow', 'red'];
  const colorOf = (model) => {
    const p = String(model || '').split('/')[0];
    let h = 0;
    for (const c of p) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return COLORS[h % COLORS.length];
  };
  const modelPill = (model) => {
    const m = el('span', `pill c-${colorOf(model)}`, String(model).split('/').pop());
    m.title = model;
    return m;
  };

  let state = { lead: null, agents: [], now: Date.now() };
  let skew = 0;            // extension clock - webview clock
  let selected = null;     // agent id whose conversation is open
  let transcript = null;   // its last transcript
  let zoom = 1;            // tree zoom factor
  const pending = new Map(); // agent id -> instructions you sent that its conversation does not show yet

  function setZoom(z) {
    zoom = Math.max(0.5, Math.min(1.4, Math.round(z * 10) / 10));
    const org = document.querySelector('#tree .org');
    if (org) org.style.zoom = String(zoom);
    const lbl = document.querySelector('#top .zlbl');
    if (lbl) lbl.textContent = `${Math.round(zoom * 100)}%`;
  }
  function fitTree() {
    const tree = $('tree'), org = tree.querySelector('.org');
    if (!org) return;
    org.style.zoom = '1';
    const ratio = (tree.clientWidth - 36) / Math.max(org.scrollWidth, 1);
    setZoom(Math.min(1, Math.max(0.5, ratio)));
  }

  // A timer: counts from `start` until `end` (or now), ticked by the interval below.
  const timer = (start, end) => {
    const t = el('span', 'time');
    if (start) { t.dataset.start = start; if (end) t.dataset.end = end; }
    tick(t);
    return t;
  };
  function tick(t) {
    if (!t.dataset.start) return;
    t.textContent = dur((+t.dataset.end || Date.now() + skew) - +t.dataset.start);
  }
  setInterval(() => document.querySelectorAll('.time[data-start]:not([data-end])').forEach(tick), 1000);

  // ---- the tree ----
  function render() {
    const agents = state.agents;
    const running = agents.filter((a) => a.status === 'running').length;
    const totalTokens = agents.reduce((s, a) => s + (a.tokens || 0), 0);
    const totalCost = agents.reduce((s, a) => s + (a.cost || 0), 0);
    const top = $('top');
    top.textContent = '';
    top.append(icon('type-hierarchy-sub'), el('b', '', 'Subagents'),
      el('span', 'muted', agents.length ? (running ? `${running} running` : 'all finished') : ''));
    if (totalTokens || totalCost) {
      const m = [totalTokens ? `${kTok(totalTokens)} tok` : '', money(totalCost)].filter(Boolean).join(' · ');
      top.append(el('span', 'statpill', m));
    }
    top.append(el('span', 'spacer'));
    if (running > 0) {
      const stopAll = el('button', 'topbtn danger');
      stopAll.title = 'Stop all running subagents';
      stopAll.append(icon('debug-stop'), el('span', '', 'Stop all'));
      stopAll.onclick = () => vscode.postMessage({ type: 'stopAll' });
      top.append(stopAll);
    }
    if (agents.length) {
      const zbar = el('span', 'zbar');
      const zbtn = (ic, title, fn) => { const b = el('button', 'icon'); b.title = title; b.appendChild(icon(ic)); b.onclick = fn; return b; };
      zbar.append(
        zbtn('zoom-out', 'Zoom out', () => setZoom(zoom - 0.1)),
        el('span', 'zlbl', `${Math.round(zoom * 100)}%`),
        zbtn('zoom-in', 'Zoom in', () => setZoom(zoom + 0.1)),
        zbtn('screen-normal', 'Fit to view', fitTree),
      );
      top.append(zbar);
    }
    if (state.lead?.startedAt) top.append(timer(state.lead.startedAt, state.lead.endedAt));

    const ids = new Set(agents.map((a) => a.id));
    const kids = new Map(); // parent id (null = lead) -> agents
    for (const a of agents) {
      const p = a.parentAgent && ids.has(a.parentAgent) ? a.parentAgent : null;
      if (!kids.has(p)) kids.set(p, []);
      kids.get(p).push(a);
    }
    const branch = (a) => {
      const li = el('li');
      li.appendChild(agentNode(a));
      const sub = kids.get(a.id);
      if (sub?.length) li.appendChild(list(sub));
      return li;
    };
    const list = (items) => { const ul = el('ul'); items.forEach((a) => ul.appendChild(branch(a))); return ul; };

    const tree = $('tree');
    const scroll = [tree.scrollLeft, tree.scrollTop];
    tree.textContent = '';
    const org = el('div', 'org');
    org.style.zoom = String(zoom);
    const root = el('ul');
    const li = el('li');
    li.appendChild(leadNode());
    if (kids.get(null)?.length) li.appendChild(list(kids.get(null)));
    root.appendChild(li);
    org.appendChild(root);
    tree.appendChild(org);
    if (!agents.length) tree.appendChild(el('p', 'empty', 'The lead hands tasks to subagents, on the models you starred (★), when the work suits it. They show up here.'));
    [tree.scrollLeft, tree.scrollTop] = scroll;
    renderPaneHead();
  }

  function leadNode() {
    const n = el('button', 'node lead');
    n.title = 'Open the main chat';
    n.onclick = () => vscode.postMessage({ type: 'focusChat' });
    const h = el('div', 'h');
    h.append(icon('hubot'), el('b', '', 'Lead'), el('span', 'spacer'));
    if (state.lead?.startedAt) h.append(timer(state.lead.startedAt, state.lead.endedAt));
    n.appendChild(h);
    if (state.lead?.model) n.appendChild(el('div', 'models')).appendChild(modelPill(state.lead.model));
    n.appendChild(el('div', 'task', state.lead?.task || 'Waiting for your message'));
    return n;
  }

  function agentNode(a) {
    const n = el('button', `node ${a.status}${a.id === selected ? ' sel' : ''}`);
    n.title = 'Open its conversation';
    n.onclick = () => select(a.id);
    const h = el('div', 'h');
    const [ic, mod] = STATUS[a.status] || STATUS.running;
    h.append(icon(ic, mod), el('b', '', a.agent || 'agent'), el('span', 'id', a.id), el('span', 'spacer'), timer(a.startedAt, a.endedAt));
    n.appendChild(h);
    if (a.model || a.tokens || a.cost) {
      const mr = n.appendChild(el('div', 'models'));
      if (a.model) mr.appendChild(modelPill(a.model));
      const meta = [a.tokens ? `${kTok(a.tokens)} tok` : '', money(a.cost)].filter(Boolean).join(' · ');
      if (meta) mr.appendChild(el('span', 'mcost', meta));
    }
    if (a.task) n.appendChild(el('div', 'task', a.task));
    const steps = el('div', 'steps');
    if (a.status === 'running') {
      const shown = (a.steps || []).slice(-SHOWN_STEPS);
      for (const s of shown) {
        const r = el('div', 'step');
        r.append(el('span', 'tool', s.tool), el('span', 'args', s.args));
        steps.appendChild(r);
      }
      const now = a.intent || (a.tool ? `${a.tool} ${a.toolArgs || ''}` : shown.length ? '' : 'Starting…');
      if (now) steps.appendChild(el('div', 'step now', now));
      const more = (a.tools || 0) - shown.length;
      if (more > 0) steps.appendChild(el('div', 'more', `+${more} more steps`));
    } else {
      const r = el('div', 'step end');
      r.append(el('span', '', END[a.status] || a.status), el('span', '', `${a.tools || 0} steps`));
      steps.appendChild(r);
    }
    n.appendChild(steps);
    return n;
  }

  // ---- one agent's conversation ----
  function select(id) {
    selected = id;
    transcript = null;
    $('app').classList.toggle('open', !!id);
    $('pane').hidden = !id;
    $('grip').hidden = !id;
    document.querySelectorAll('.node.sel').forEach((n) => n.classList.remove('sel'));
    render();
    vscode.postMessage({ type: 'select', id }); // also when closed, so the agent it was opened for stops coming back
    if (id) buildPane();
  }

  function buildPane() {
    const pane = $('pane');
    pane.textContent = '';
    pane.append(el('div', 'ph'), el('div', 'pbody'), el('div', 'perr'), el('div', 'pin'));
    const box = el('textarea');
    box.rows = 1;
    box.placeholder = 'Tell this agent something to change course (Enter to send)';
    const send = el('button', 'icon');
    send.title = 'Send';
    send.appendChild(icon('send'));
    const go = () => {
      const text = box.value.trim();
      if (!text) return;
      vscode.postMessage({ type: 'steer', id: selected, text });
      if (!pending.has(selected)) pending.set(selected, []);
      pending.get(selected).push(text);
      box.value = '';
      renderBody(true);
    };
    box.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); go(); } };
    send.onclick = go;
    pane.querySelector('.pin').append(box, send);
    renderPaneHead();
    renderBody(true);
  }

  function renderPaneHead() {
    if (!selected) return;
    const a = state.agents.find((x) => x.id === selected);
    const ph = document.querySelector('#pane .ph');
    if (!ph) return;
    ph.textContent = '';
    if (!a) { ph.append(el('span', 'muted', 'This agent is no longer in the run.'), el('span', 'spacer'), closeBtn()); return; }
    const [ic, mod] = STATUS[a.status] || STATUS.running;
    ph.append(icon(ic, mod), el('b', '', a.agent || 'agent'), el('span', 'id', a.id));
    if (a.model) ph.append(modelPill(a.model));
    ph.append(timer(a.startedAt, a.endedAt), el('span', 'spacer'));
    if (a.status === 'running') {
      const stop = el('button', 'icon');
      stop.title = 'Stop this subagent';
      stop.appendChild(icon('debug-stop'));
      stop.onclick = () => vscode.postMessage({ type: 'stop', id: a.id });
      ph.append(stop);
    }
    ph.append(closeBtn());
    // Only a running agent takes instructions.
    const pin = document.querySelector('#pane .pin');
    if (pin) pin.hidden = a.status !== 'running';
  }

  function closeBtn() {
    const b = el('button', 'icon');
    b.title = 'Close';
    b.appendChild(icon('close'));
    b.onclick = () => select(null);
    return b;
  }

  function renderBody(toEnd) {
    const body = document.querySelector('#pane .pbody');
    if (!body) return;
    const atEnd = toEnd || body.scrollHeight - body.scrollTop - body.clientHeight < 40;
    const open = new Set([...body.querySelectorAll('details[open]')].map((d) => d.dataset.k));
    body.textContent = '';
    const msgs = transcript?.id === selected ? transcript.messages : [];
    // instructions you sent show until its conversation has them
    const yours = msgs.filter((m) => m.role === 'you').map((m) => m.text);
    const left = (pending.get(selected) || []).filter((t) => !yours.some((y) => y.includes(t)));
    pending.set(selected, left);
    if (!transcript) body.appendChild(el('div', 'muted', 'Loading…'));
    msgs.forEach((m, i) => {
      if (m.role === 'task') {
        const d = el('div', 'brief');
        d.append(el('div', 'label', 'Task'), el('div', 'text', m.text));
        body.appendChild(d);
      } else if (m.role === 'you') {
        body.appendChild(el('div', 'you', m.text));
      } else if (m.role === 'assistant') {
        if (m.text?.trim()) {
          const t = el('div', 'md');
          t.innerHTML = md.render(m.text);
          enhanceMd(t);
          body.appendChild(t);
        }
        for (const t of m.tools || []) {
          const r = el('div', 'call');
          r.append(el('span', 'tool', t.name), el('span', 'args', t.detail || ''));
          body.appendChild(r);
        }
      } else {
        const d = el('details', 'out' + (m.isError ? ' err' : ''));
        d.dataset.k = String(i);
        d.open = open.has(d.dataset.k);
        const s = el('summary');
        s.append(icon(m.isError ? 'error' : 'output'), el('span', '', `${m.name} output`));
        d.append(s, el('pre', '', m.text));
        body.appendChild(d);
      }
    });
    for (const t of left) body.appendChild(el('div', 'you pending', t));
    if (atEnd) body.scrollTop = body.scrollHeight;
  }

  const PATHISH = /^(?:[A-Za-z]:)?[\w.@~\/\\-]*\.[\w]{1,12}(?::\d+(?::\d+)?|#L\d+(?:-L?\d+)?)?$/;
  function enhanceMd(e) {
    for (const pre of e.querySelectorAll('pre')) {
      const wrap = el('div', 'codewrap');
      pre.before(wrap);
      wrap.appendChild(pre);
      const b = el('button', 'icon codecopy');
      b.title = 'Copy';
      b.appendChild(icon('copy'));
      b.onclick = () => {
        navigator.clipboard.writeText(pre.querySelector('code')?.textContent ?? pre.textContent);
        b.firstChild.className = 'codicon codicon-check';
        setTimeout(() => { b.firstChild.className = 'codicon codicon-copy'; }, 1200);
      };
      wrap.appendChild(b);
    }
    for (const c of e.querySelectorAll('code')) {
      const s = c.textContent.trim();
      if (c.closest('pre') || s.length > 260 || !PATHISH.test(s)) continue;
      c.classList.add('flink');
      c.title = 'Open file';
      c.onclick = () => vscode.postMessage({ type: 'openFile', ref: s });
    }
  }

  // ---- resize the pane: height when narrow (<900px), width when wide (>=900px) ----
  $('grip').onpointerdown = (e) => {
    const grip = e.currentTarget;
    grip.setPointerCapture(e.pointerId);
    grip.onpointermove = (m) => {
      if (window.innerWidth >= 900) {
        const w = Math.min(window.innerWidth - 280, Math.max(280, window.innerWidth - m.clientX));
        $('app').style.setProperty('--pane-w', `${w}px`);
      } else {
        const h = Math.min(window.innerHeight - 140, Math.max(120, window.innerHeight - m.clientY));
        $('app').style.setProperty('--pane-h', `${h}px`);
      }
    };
    grip.onpointerup = () => { grip.onpointermove = null; };
  };

  window.addEventListener('message', ({ data: m }) => {
    if (m.type === 'state') {
      state = m;
      skew = (m.now || Date.now()) - Date.now();
      if (m.focus && m.focus !== selected && state.agents.some((a) => a.id === m.focus)) return select(m.focus);
      render();
    } else if (m.type === 'transcript') {
      if (m.id !== selected) return;
      transcript = m;
      document.querySelector('#pane .perr').textContent = '';
      renderBody(false);
    } else if (m.type === 'error') {
      if (m.id !== selected) return;
      document.querySelector('#pane .perr').textContent = m.text;
    }
  });
  vscode.postMessage({ type: 'ready' });
})();
