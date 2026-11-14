// UI translation shared by the extension (Node) and the chat panel (browser).
// A dictionary is { strings: { English: translation }, patterns: [[regex, replacement]] }, loaded from
// l10n/<language>.json when VS Code runs in that language. Untranslated text stays English.
(function (root) {
  function compile(dict) {
    if (!dict) return null;
    return { strings: dict.strings || {}, patterns: (dict.patterns || []).map(([re, to]) => [new RegExp(re), to]) };
  }

  // Whole-text lookup, keeping surrounding spaces; null when there is no translation.
  function translate(d, text) {
    if (!d || !text) return null;
    const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
    const core = m[2];
    if (!core || !/[A-Za-z]/.test(core)) return null;
    let out = Object.prototype.hasOwnProperty.call(d.strings, core) ? d.strings[core] : null;
    if (out === null) {
      for (const [re, to] of d.patterns) {
        if (re.test(core)) { out = core.replace(re, (...g) => to.replace(/\$(\d)/g, (_, i) => translate(d, g[+i]) ?? g[+i] ?? '')); break; }
      }
    }
    return out === null ? null : m[1] + out + m[3];
  }

  // Browser: translate the panel as it is built. Chat content (replies, your messages, code, tool output) is left alone.
  const SKIP = '.md, .utext, .tbody, pre, code, .diff, .qtext, .stask, .pdesc2';
  const ATTRS = ['title', 'placeholder', 'aria-label'];
  function watch(d, rootEl) {
    if (!d) return;
    const doText = (n) => {
      if (n.parentElement?.closest(SKIP)) return;
      const t = translate(d, n.nodeValue);
      if (t !== null && t !== n.nodeValue) n.nodeValue = t;
    };
    const doEl = (e) => {
      if (e.closest(SKIP)) return;
      for (const a of ATTRS) {
        const v = e.getAttribute(a);
        const t = v && translate(d, v);
        if (t && t !== v) e.setAttribute(a, t);
      }
    };
    const walk = (node) => {
      if (node.nodeType === 3) return doText(node);
      if (node.nodeType !== 1 || node.closest(SKIP)) return;
      doEl(node);
      const it = document.createTreeWalker(node, 5 /* elements + text */, {
        acceptNode: (n) => (n.nodeType === 1 && n.matches(SKIP) ? 2 /* reject subtree */ : 1),
      });
      for (let n = it.nextNode(); n; n = it.nextNode()) (n.nodeType === 3 ? doText : doEl)(n);
    };
    walk(rootEl);
    new MutationObserver((list) => {
      for (const r of list) {
        if (r.type === 'childList') r.addedNodes.forEach(walk);
        else if (r.type === 'characterData') doText(r.target);
        else if (r.type === 'attributes') doEl(r.target);
      }
    }).observe(rootEl, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  }

  const api = { compile, translate, watch };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ompL10n = api;
})(this);
