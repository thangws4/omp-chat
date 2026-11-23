// Zero-dependency syntax highlighter & lightweight Mermaid flowchart/sequence SVG renderer for webviews.
// Colours map directly to VS Code theme tokens in main.css / map.css so light, dark and high-contrast all look native.
(function (root) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const KW_COMMON = new Set((
    'if else elif then fi for while do done switch case default break continue return yield throw try catch finally '
    + 'function fn func def class struct enum interface trait impl type extends implements new this self super '
    + 'const let var val mut pub public private protected static readonly async await import export from as in of with '
    + 'package module using namespace match where select defer go chan macro inline virtual override abstract final '
    + 'null nil None true false True False undefined NaN Infinity void typeof instanceof sizeof delete raise pass lambda global nonlocal '
    + 'SELECT FROM WHERE JOIN LEFT RIGHT INNER OUTER ON GROUP ORDER BY LIMIT INSERT INTO VALUES UPDATE SET DELETE CREATE TABLE ALTER DROP AS AND OR NOT IN IS NULL'
  ).split(' '));

  const TYPE_COMMON = new Set((
    'string number boolean any unknown never object symbol bigint void int int8 int16 int32 int64 uint uint8 uint16 uint32 uint64 '
    + 'float float32 float64 double char byte bool str usize isize Vec Option Result Map Set Array Promise Record Error RegExp Date JSON Math Buffer'
  ).split(' '));

  const HASH_COMMENT = /^(py|python|sh|bash|zsh|shell|yml|yaml|toml|rb|ruby|perl|r|ps1|pwsh|powershell|dockerfile|makefile|ini|conf|coffee|elixir|ex)$/i;
  const SQL_COMMENT = /^(sql|lua|haskell|hs|elm)$/i;
  const MARKUP = /^(html|xml|svg|vue|svelte|jsx|tsx)$/i;
  const JSON_LANG = /^(json|jsonc|json5)$/i;
  const DIFF_LANG = /^(diff|patch)$/i;

  function highlight(code, lang) {
    lang = String(lang || '').trim().toLowerCase();
    if (!code) return '';
    if (code.length > 40000) return esc(code);

    if (DIFF_LANG.test(lang)) {
      return code.split('\n').map((l) => {
        const e = esc(l);
        if (l.startsWith('+++') || l.startsWith('---') || l.startsWith('@@')) return `<span class="hl-meta">${e}</span>`;
        if (l.startsWith('+')) return `<span class="hl-add">${e}</span>`;
        if (l.startsWith('-')) return `<span class="hl-del">${e}</span>`;
        return e;
      }).join('\n');
    }

    const hashCmt = HASH_COMMENT.test(lang);
    const sqlCmt = SQL_COMMENT.test(lang);
    const isJson = JSON_LANG.test(lang);
    const isMarkup = MARKUP.test(lang);

    // Master tokenizer regex: comments, strings, decorators/tags, numbers, identifiers.
    const parts = [];
    if (hashCmt) parts.push('(?<cmt>#[^\\n]*)');
    else if (sqlCmt) parts.push('(?<cmt>--[^\\n]*|/\\*[\\s\\S]*?\\*/)');
    else parts.push('(?<cmt>//[^\\n]*|/\\*[\\s\\S]*?\\*/|<!--[\\s\\S]*?-->)');

    parts.push('(?<str>`(?:\\\\[\\s\\S]|[^`\\\\])*`|"(?:\\\\.|[^"\\\\\\n])*"|\'(?:\\\\.|[^\'\\\\\\n])*\')');
    if (isMarkup) parts.push('(?<tag></?[A-Za-z][\\w:-]*|\\s/?>)');
    parts.push('(?<dec>@[A-Za-z_][\\w.]*)');
    parts.push('(?<num>\\b(?:0x[0-9a-fA-F_]+|0b[01_]+|\\d[\\d_]*(?:\\.\\d[\\d_]*)?(?:[eE][+-]?\\d+)?)\\b)');
    parts.push('(?<id>\\b[A-Za-z_$][\\w$]*\\b)');

    const re = new RegExp(parts.join('|'), 'g');
    let out = '', last = 0, m;
    while ((m = re.exec(code)) !== null) {
      if (m.index > last) out += esc(code.slice(last, m.index));
      const g = m.groups, raw = m[0], safe = esc(raw);
      if (g.cmt) out += `<span class="hl-cmt">${safe}</span>`;
      else if (g.str) {
        if (isJson && /^\s*:/.test(code.slice(re.lastIndex, re.lastIndex + 16))) out += `<span class="hl-key">${safe}</span>`;
        else out += `<span class="hl-str">${safe}</span>`;
      } else if (g.tag) out += `<span class="hl-tag">${safe}</span>`;
      else if (g.dec) out += `<span class="hl-dec">${safe}</span>`;
      else if (g.num) out += `<span class="hl-num">${safe}</span>`;
      else if (g.id) {
        if (KW_COMMON.has(raw) || (lang === 'sql' && KW_COMMON.has(raw.toUpperCase()))) out += `<span class="hl-kw">${safe}</span>`;
        else if (TYPE_COMMON.has(raw) || /^[A-Z][A-Za-z0-9_]*$/.test(raw)) out += `<span class="hl-type">${safe}</span>`;
        else if (/^\s*\(/.test(code.slice(re.lastIndex, re.lastIndex + 8))) out += `<span class="hl-fn">${safe}</span>`;
        else out += safe;
      } else out += safe;
      last = re.lastIndex;
    }
    if (last < code.length) out += esc(code.slice(last));
    return out;
  }

  // Lightweight pure-SVG renderer for Mermaid flowcharts/graphs and sequence diagrams (zero network / zero bundle bloat).
  function renderMermaid(src) {
    const lines = String(src || '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('%%'));
    if (!lines.length) return null;
    if (/^(?:graph|flowchart)\s+(TD|TB|LR|RL|BT)\b/i.test(lines[0])) return renderFlow(lines);
    if (/^sequenceDiagram\b/i.test(lines[0])) return renderSequence(lines.slice(1));
    return null;
  }

  function parseNodeToken(tok) {
    tok = tok.trim();
    const m = /^([A-Za-z0-9_.-]+)\s*(?:\[\["([^"]+)"\]\]|\["([^"]+)"\]|\[([^\]]+)\]|\(\(([^)]+)\)\)|\("([^"]+)"\)|\(([^)]+)\)|\{"([^"]+)"\}|\{([^}]+)\})?$/.exec(tok);
    if (!m) return null;
    const id = m[1], label = m[2] || m[3] || m[4] || m[5] || m[6] || m[7] || m[8] || m[9] || id;
    const shape = /\{/.test(tok) ? 'diamond' : /\(/.test(tok) ? 'round' : 'rect';
    return { id, label: label.replace(/^["']|["']$/g, ''), shape };
  }

  function renderFlow(lines) {
    const dir = (/\s(TD|TB|LR|RL|BT)\b/i.exec(lines[0])?.[1] || 'TD').toUpperCase();
    const horiz = dir === 'LR' || dir === 'RL';
    const nodes = new Map();
    const edges = [];
    const ensure = (tok) => {
      const n = parseNodeToken(tok);
      if (!n) return null;
      if (!nodes.has(n.id)) nodes.set(n.id, n);
      else if (n.label !== n.id) Object.assign(nodes.get(n.id), n);
      return nodes.get(n.id);
    };
    for (const line of lines.slice(1)) {
      if (/^(?:subgraph|end|classDef|class|style|linkStyle|click)\b/i.test(line)) continue;
      // Split chained edges: A --> B -->|label| C
      const segs = line.split(/\s*(-->|-.->|==>|---)\s*(?:\|([^|]*)\|\s*)?/);
      if (segs.length >= 4) {
        let prev = ensure(segs[0]);
        for (let i = 1; i + 2 < segs.length; i += 3) {
          const kind = segs[i], label = (segs[i + 1] || '').trim(), next = ensure(segs[i + 2]);
          if (prev && next) edges.push({ from: prev.id, to: next.id, label, dashed: kind === '-.->' });
          prev = next;
        }
      } else ensure(line);
    }
    if (!nodes.size || nodes.size > 40) return null;

    // Topological layering (BFS from roots).
    const incoming = new Map([...nodes.keys()].map((id) => [id, 0]));
    const adj = new Map([...nodes.keys()].map((id) => [id, []]));
    for (const e of edges) {
      adj.get(e.from)?.push(e.to);
      incoming.set(e.to, (incoming.get(e.to) || 0) + 1);
    }
    const layer = new Map();
    const q = [...nodes.keys()].filter((id) => incoming.get(id) === 0);
    if (!q.length) q.push([...nodes.keys()][0]);
    for (const id of q) layer.set(id, 0);
    for (let i = 0; i < q.length; i++) {
      const u = q[i], lu = layer.get(u);
      for (const v of adj.get(u) || []) {
        if (!layer.has(v)) { layer.set(v, lu + 1); q.push(v); }
      }
    }
    for (const id of nodes.keys()) if (!layer.has(id)) layer.set(id, 0);

    const groups = new Map();
    for (const [id, lv] of layer) {
      if (!groups.has(lv)) groups.set(lv, []);
      groups.get(lv).push(nodes.get(id));
    }

    const NW = 148, NH = 42, GX = 36, GY = 50, PAD = 18;
    const pos = new Map();
    const levels = [...groups.keys()].sort((a, b) => a - b);
    const maxPerLevel = Math.max(...levels.map((lv) => groups.get(lv).length));
    let maxX = 0, maxY = 0;
    levels.forEach((lv, li) => {
      const row = groups.get(lv);
      row.forEach((n, ri) => {
        const spanOffset = ((maxPerLevel - row.length) / 2);
        const x = horiz ? PAD + li * (NW + GX) : PAD + (ri + spanOffset) * (NW + GX);
        const y = horiz ? PAD + (ri + spanOffset) * (NH + GY) : PAD + li * (NH + GY);
        pos.set(n.id, { x, y, w: NW, h: NH, cx: x + NW / 2, cy: y + NH / 2 });
        maxX = Math.max(maxX, x + NW + PAD);
        maxY = Math.max(maxY, y + NH + PAD);
      });
    });

    const svgEdges = edges.map((e) => {
      const a = pos.get(e.from), b = pos.get(e.to);
      if (!a || !b) return '';
      const x1 = horiz ? a.x + a.w : a.cx, y1 = horiz ? a.cy : a.y + a.h;
      const x2 = horiz ? b.x : b.cx, y2 = horiz ? b.cy : b.y;
      const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
      const d = horiz ? `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}` : `M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}`;
      const dash = e.dashed ? ' stroke-dasharray="4 3"' : '';
      const lbl = e.label ? `<text x="${mx}" y="${my - 4}" text-anchor="middle" class="mm-elbl">${esc(e.label.slice(0, 24))}</text>` : '';
      return `<path d="${d}" fill="none" class="mm-edge"${dash} marker-end="url(#mm-arr)"/>${lbl}`;
    }).join('');

    const svgNodes = [...nodes.values()].map((n) => {
      const p = pos.get(n.id);
      const txt = n.label.length > 22 ? n.label.slice(0, 21) + '…' : n.label;
      const shape = n.shape === 'diamond'
        ? `<polygon points="${p.cx},${p.y - 3} ${p.x + p.w + 4},${p.cy} ${p.cx},${p.y + p.h + 3} ${p.x - 4},${p.cy}" class="mm-box"/>`
        : `<rect x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}" rx="${n.shape === 'round' ? 20 : 8}" class="mm-box"/>`;
      return `${shape}<text x="${p.cx}" y="${p.cy + 4}" text-anchor="middle" class="mm-lbl">${esc(txt)}</text>`;
    }).join('');

    return `<svg class="mm-svg" viewBox="0 0 ${Math.ceil(maxX)} ${Math.ceil(maxY)}" width="${Math.ceil(maxX)}" height="${Math.ceil(maxY)}" xmlns="http://www.w3.org/2000/svg">`
      + '<defs><marker id="mm-arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0,1 L10,5 L0,9 z" class="mm-arr"/></marker></defs>'
      + svgEdges + svgNodes + '</svg>';
  }

  function renderSequence(lines) {
    const actors = [];
    const addActor = (id, label) => {
      id = id.trim();
      let a = actors.find((x) => x.id === id);
      if (!a) { a = { id, label: (label || id).trim() }; actors.push(a); }
      else if (label) a.label = label.trim();
    };
    const msgs = [];
    for (const l of lines) {
      let m = /^(?:participant|actor)\s+(\S+)(?:\s+as\s+(.+))?$/i.exec(l);
      if (m) { addActor(m[1], m[2]); continue; }
      m = /^([A-Za-z0-9_.-]+)\s*(->>|-->>|->|-->|-x|--x)\s*([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(l);
      if (m) {
        addActor(m[1]); addActor(m[3]);
        msgs.push({ from: m[1], to: m[3], dashed: m[2].startsWith('--'), text: m[4].trim() });
      }
    }
    if (!actors.length || !msgs.length || actors.length > 12) return null;
    const COL = 150, PAD = 20, TOP = 46, ROW = 36;
    const w = PAD * 2 + Math.max(actors.length - 1, 1) * COL + 120;
    const h = TOP + msgs.length * ROW + 36;
    const ax = (id) => PAD + 60 + actors.findIndex((a) => a.id === id) * COL;
    const heads = actors.map((a) => {
      const x = ax(a.id);
      const lbl = a.label.length > 16 ? a.label.slice(0, 15) + '…' : a.label;
      return `<line x1="${x}" y1="${TOP - 4}" x2="${x}" y2="${h - 16}" class="mm-life"/>`
        + `<rect x="${x - 56}" y="10" width="112" height="30" rx="7" class="mm-box"/>`
        + `<text x="${x}" y="29" text-anchor="middle" class="mm-lbl">${esc(lbl)}</text>`;
    }).join('');
    const arrows = msgs.map((m, i) => {
      const y = TOP + 22 + i * ROW, x1 = ax(m.from), x2 = ax(m.to);
      const dash = m.dashed ? ' stroke-dasharray="4 3"' : '';
      const txt = m.text.length > 34 ? m.text.slice(0, 33) + '…' : m.text;
      if (x1 === x2) {
        return `<path d="M${x1},${y} L${x1 + 36},${y} L${x1 + 36},${y + 16} L${x1 + 2},${y + 16}" fill="none" class="mm-edge"${dash} marker-end="url(#mm-arr)"/>`
          + `<text x="${x1 + 42}" y="${y + 11}" class="mm-elbl">${esc(txt)}</text>`;
      }
      const mx = (x1 + x2) / 2;
      return `<line x1="${x1}" y1="${y}" x2="${x2}" y2="${y}" class="mm-edge"${dash} marker-end="url(#mm-arr)"/>`
        + `<text x="${mx}" y="${y - 5}" text-anchor="middle" class="mm-elbl">${esc(txt)}</text>`;
    }).join('');
    return `<svg class="mm-svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">`
      + '<defs><marker id="mm-arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0,1 L10,5 L0,9 z" class="mm-arr"/></marker></defs>'
      + heads + arrows + '</svg>';
  }

  const api = { highlight, renderMermaid };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ompHighlight = api;
})(this);
