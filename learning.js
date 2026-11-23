// Self-learning helpers inspired by Hermes Agent:
// 1. Global user memory (~/.omp/agent/USER.md) + project memory (AGENTS.md / CLAUDE.md) with deduping
// 2. Skill distillation (/learn -> ```omp-skill``` -> SKILL.md) & memory extraction (/memorize -> ```omp-memory```)
// 3. Past-session recall (@history / @history:<query>) from workspace session JSONL files
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const defaultAgentDir = () => process.env.OMP_AGENT_DIR || path.join(os.homedir(), '.omp', 'agent');
const userMemoryPath = (agentDir) => path.join(agentDir || defaultAgentDir(), 'USER.md');

function projectMemoryPath(cwd) {
  if (!cwd) return null;
  return ['AGENTS.md', 'CLAUDE.md'].map((f) => path.join(cwd, f)).find((f) => fs.existsSync(f)) || path.join(cwd, 'AGENTS.md');
}

function readMemoryItems(file) {
  if (!file || !fs.existsSync(file)) return [];
  try {
    return fs.readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .map((line, index) => ({ index, text: line }))
      .filter((x) => x.text.trim());
  } catch { return []; }
}

const normLine = (s) => String(s || '').replace(/^\s*[-*•]\s*/, '').replace(/\s+/g, ' ').trim().toLowerCase();

// Appends `- note` unless an equivalent bullet already exists (case-insensitive).
function appendMemory(file, note) {
  const clean = String(note || '').replace(/\r?\n/g, ' ').trim();
  if (!file || !clean) return { added: false, file, note: clean, reason: 'empty' };
  const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const target = normLine(clean);
  const existing = old.split(/\r?\n/).map(normLine).filter(Boolean);
  if (existing.includes(target)) return { added: false, file, note: clean, duplicate: true };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${old && !old.endsWith('\n') ? '\n' : ''}- ${clean}\n`);
  return { added: true, file, note: clean };
}

function deleteMemoryLine(file, index) {
  if (!file || !fs.existsSync(file)) return false;
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  if (index < 0 || index >= lines.length) return false;
  lines.splice(index, 1);
  fs.writeFileSync(file, lines.join('\n'));
  return true;
}

// Formatted block appended to omp's system prompt so global preferences follow the user across every workspace.
function userMemoryPrompt(agentDir, maxChars = 6000) {
  const file = userMemoryPath(agentDir);
  if (!fs.existsSync(file)) return '';
  let text = '';
  try { text = fs.readFileSync(file, 'utf8').trim(); } catch { return ''; }
  if (!text) return '';
  const body = text.length > maxChars ? `${text.slice(0, maxChars)}\n… (truncated)` : text;
  return `# User memory (applies across all projects)\nFollow these personal preferences and notes from ${file}:\n${body}`;
}

// ---- Skill creation & distillation ----

function skillDirs(cwd, agentDir) {
  const base = agentDir || defaultAgentDir();
  return [
    cwd && { dir: path.join(cwd, '.omp', 'skills'), scope: 'project' },
    { dir: path.join(base, 'skills'), scope: 'user' },
  ].filter(Boolean);
}

function sanitizeSkillName(raw) {
  return String(raw || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

function skillFileText({ name, description, body }) {
  const safe = sanitizeSkillName(name) || 'custom-skill';
  const desc = JSON.stringify(String(description || '').replace(/\r?\n/g, ' ').trim() || `Reusable workflow for ${safe}`);
  const content = String(body || '').trim();
  return `---\nname: ${safe}\ndescription: ${desc}\n---\n\n${content}\n`;
}

function saveSkillFile({ name, description, body, scope = 'project', cwd, agentDir, overwrite = false }) {
  const safe = sanitizeSkillName(name);
  if (!safe) throw new Error('Skill name must contain letters or digits.');
  const useUser = scope === 'user' || !cwd;
  const dir = path.join(useUser ? path.join(agentDir || defaultAgentDir(), 'skills') : path.join(cwd, '.omp', 'skills'), safe);
  const file = path.join(dir, 'SKILL.md');
  if (!overwrite && fs.existsSync(file)) {
    throw Object.assign(new Error(`Skill "${safe}" already exists.`), { code: 'EEXIST', file });
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, skillFileText({ name: safe, description, body }));
  return { name: safe, file, scope: useUser ? 'user' : 'project' };
}

function learnSkillPrompt(topic) {
  const focus = String(topic || '').trim();
  return [
    focus
      ? `Distill a reusable skill for "${focus}" based on this conversation and workspace.`
      : 'Distill the most valuable reusable workflow, fix, or pattern from this conversation into a skill.',
    'Do NOT write any files yourself — reply with a single ````omp-skill block (FOUR backticks, so ``` code blocks can go inside) in this exact format so the user can review and save it with one click:',
    '````omp-skill',
    'name: short-kebab-case-name',
    'scope: project',
    'description: One-line description with clear trigger keywords for when to use this skill',
    '---',
    '# Title',
    '## When to use',
    '...',
    '## Steps',
    '1. ...',
    '## Gotchas & verification',
    '- ...',
    '````',
    'Use `scope: user` only if the skill applies across all projects; otherwise use `scope: project`. Keep it concrete and concise.',
  ].join('\n');
}

// Body of the first ```<tag> block, or null. Nested ```lang … ``` blocks stay inside it; a 4+ backtick outer
// fence only closes on an equally long bare fence.
function fencedBlock(text, tag) {
  const lines = String(text || '').split(/\r?\n/);
  const start = lines.findIndex((l) => new RegExp(`^\\s*\`{3,}${tag}\\s*$`).test(l));
  if (start < 0) return null;
  const outer = /`+/.exec(lines[start])[0].length;
  let inner = false;
  for (let i = start + 1; i < lines.length; i++) {
    const m = /^\s*(`{3,})(.*)$/.exec(lines[i]);
    if (!m) continue;
    const bare = !m[2].trim();
    if (outer > 3) {
      if (bare && m[1].length >= outer) return lines.slice(start + 1, i).join('\n');
    } else if (inner) {
      if (bare) inner = false;
    } else if (bare) {
      return lines.slice(start + 1, i).join('\n');
    } else {
      inner = true; // ponytail: a bare ``` opening an inner block reads as the outer close; the prompt asks for 4 backticks
    }
  }
  return null;
}

function parseSkillDraft(text) {
  const block = fencedBlock(text, 'omp-skill');
  if (block === null) return null;
  const raw = block.trim();
  const sep = /\r?\n---\r?\n/.exec(raw);
  const head = sep ? raw.slice(0, sep.index) : '';
  const body = (sep ? raw.slice(sep.index + sep[0].length) : raw).trim();
  const field = (k) => new RegExp(`^${k}:\\s*(.*)$`, 'mi').exec(head)?.[1]?.trim().replace(/^["']|["']$/g, '') || '';
  const name = sanitizeSkillName(field('name'));
  const description = field('description');
  const scope = /^(user|global)$/i.test(field('scope')) ? 'user' : 'project';
  if (!name || !body) return null;
  return { name, scope, description: description || `Reusable workflow for ${name}`, body };
}

// ---- Memory extraction ----

const EXTRACT_MEMORY_PROMPT = [
  'Review this conversation and extract ONLY durable, non-obvious lessons worth remembering in future chats (project commands, architecture rules, gotchas, or user preferences).',
  'Skip one-off task details or things already obvious from the code. Do NOT edit files yourself — reply with a single fenced ```omp-memory block:',
  '```omp-memory',
  'project: <short rule or lesson for this repository>',
  'user: <short personal preference that applies across all projects>',
  '```',
  'Include at most 6 lines. If nothing durable was learned, output an empty ```omp-memory block.',
].join('\n');

function parseMemoryDraft(text, existingProjectText = '', existingUserText = '') {
  const block = fencedBlock(text, 'omp-memory');
  if (block === null) return null; // no extraction block in this reply
  const seenProject = new Set(String(existingProjectText || '').split(/\r?\n/).map(normLine).filter(Boolean));
  const seenUser = new Set(String(existingUserText || '').split(/\r?\n/).map(normLine).filter(Boolean));
  const items = [];
  for (const rawLine of block.split(/\r?\n/)) {
    const line = rawLine.replace(/^\s*[-*•]\s*/, '').trim();
    if (!line) continue;
    const kv = /^(project|user|global)\s*:\s*(.+)$/i.exec(line);
    if (!kv) continue;
    const scope = /^project$/i.test(kv[1]) ? 'project' : 'user';
    const note = kv[2].trim();
    const key = normLine(note);
    if (!key) continue;
    const seen = scope === 'project' ? seenProject : seenUser;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ scope, text: note });
  }
  return items;
}

// ---- Session recall (@history / @history:<query>) ----

const STOP = new Set(('the and for with that this from into when use using your you are not but can any all its was what how have has will '
  + 'about them they then than over just more most also only some such like before after each make made does need want work works '
  + 'cua cho voi trong cac nhung mot nay kia khi lam sao gi duoc khong toi ban hay').split(' '));

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .match(/[a-z0-9_.-]{3,}/g)
    ?.filter((w) => !STOP.has(w)) || [];
}

function textOfContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((p) => p?.type === 'text' && p.text).map((p) => p.text).join('\n');
}

// Prefixes send() puts in front of the user's text; shared with extension.js's splitUserText so they can't drift.
const NOTE_PREFIX_RE = /^(\[(?:Note:|The user added this to) [^\n]*\]\n)+\n/;
const CONTEXT_BLOCK_RE = /^\[(?:Problems|Terminal output|Uncommitted changes|Git log|Open editors|Web page|Unsaved changes|Past sessions)[^\]\n]*\]\n```[^\n]*\n[\s\S]*?\n```\n\n/;

function stripInjectedPrefix(text) {
  let s = String(text || '');
  s = s.replace(NOTE_PREFIX_RE, '');
  s = s.replace(/^\[Plan mode: [^\n]*\]\n\n/, '');
  s = s.replace(/^\[Skills that may help with this request[^\n]*\]\n\n/, '');
  s = s.replace(/^\[(?:Selection from|Current file:) [^\]\n]+\](?:\n```[^\n]*\n[\s\S]*?\n```)?\n\n/, '');
  let m;
  while ((m = CONTEXT_BLOCK_RE.exec(s))) s = s.slice(m[0].length);
  return s.trim();
}

function parseSessionTurns(file) {
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return null; }
  let title = '';
  const turns = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec.type === 'session' && rec.title) title = String(rec.title);
    if (rec.type === 'message' && (rec.message?.role === 'user' || rec.message?.role === 'assistant')) {
      const txt = rec.message.role === 'user'
        ? stripInjectedPrefix(textOfContent(rec.message.content))
        : textOfContent(rec.message.content).trim();
      if (!txt) continue;
      if (!title && rec.message.role === 'user') title = txt.replace(/\s+/g, ' ').slice(0, 90);
      turns.push({ role: rec.message.role, text: txt });
    }
  }
  if (!turns.length) return null;
  return { title: title || path.basename(file, '.jsonl'), turns };
}

// ponytail: sync read of the newest `maxFiles` sessions on the extension host; go async/indexed if that ever stutters.
function recallSessions({ sessionDir, currentFile, query = '', promptText = '', maxSessions = 3, maxChars = 12000, maxFiles = 50 }) {
  if (!sessionDir || !fs.existsSync(sessionDir)) return { matches: [], text: 'No past conversations found for this workspace.' };
  let files = [];
  try {
    files = fs.readdirSync(sessionDir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => path.join(sessionDir, f))
      .filter((f) => !currentFile || path.resolve(f) !== path.resolve(currentFile))
      .map((file) => { try { return { file, mtime: fs.statSync(file).mtimeMs }; } catch { return null; } })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, maxFiles);
  } catch { return { matches: [], text: 'No past conversations found for this workspace.' }; }
  if (!files.length) return { matches: [], text: 'No earlier conversations found for this workspace.' };

  const explicitQuery = String(query || '').trim();
  const cleanPrompt = String(promptText || '').replace(/(^|\s)@history(?::[^\s]+)?\b/g, ' ').trim();
  const terms = [...new Set(tokenize(explicitQuery || cleanPrompt))];

  const scored = [];
  for (const { file, mtime } of files) {
    const parsed = parseSessionTurns(file);
    if (!parsed) continue;
    const titleLower = parsed.title.toLowerCase();
    let score = 0;
    const rankedTurns = parsed.turns.map((t, i) => {
      const low = t.text.toLowerCase();
      let s = 0;
      if (explicitQuery && low.includes(explicitQuery.toLowerCase())) s += 6;
      for (const w of terms) {
        if (low.includes(w)) s += 2;
      }
      return { ...t, i, s };
    });
    if (explicitQuery && titleLower.includes(explicitQuery.toLowerCase())) score += 8;
    for (const w of terms) if (titleLower.includes(w)) score += 3;
    score += rankedTurns.reduce((sum, t) => sum + t.s, 0);
    if (explicitQuery && score === 0) continue;
    scored.push({ file, title: parsed.title, mtime, score, turns: rankedTurns });
  }

  scored.sort((a, b) => b.score - a.score || b.mtime - a.mtime);
  const picked = (terms.length && scored.some((x) => x.score > 0)
    ? scored.filter((x) => x.score > 0)
    : scored).slice(0, maxSessions);

  if (!picked.length) {
    return {
      matches: [],
      text: explicitQuery ? `No past conversations matched "${explicitQuery}".` : 'No earlier conversations found for this workspace.',
    };
  }

  const out = [];
  let used = 0;
  for (const s of picked) {
    const date = new Date(s.mtime).toISOString().slice(0, 10);
    const hot = s.turns.filter((t) => t.s > 0).sort((a, b) => b.s - a.s).slice(0, 3);
    const keepIdx = new Set();
    for (const t of hot) {
      keepIdx.add(t.i);
      // Pair each matching user question with the assistant's reply right after it (and vice versa).
      if (t.role === 'user' && s.turns[t.i + 1]?.role === 'assistant') keepIdx.add(t.i + 1);
      if (t.role === 'assistant' && s.turns[t.i - 1]?.role === 'user') keepIdx.add(t.i - 1);
    }
    const chosen = keepIdx.size
      ? [...keepIdx].sort((a, b) => a - b).slice(0, 6).map((i) => s.turns[i])
      : s.turns.slice(-4);
    const lines = [`### ${s.title} (${date})`];
    for (const t of chosen) {
      const snippet = t.text.replace(/\s+/g, ' ').trim().slice(0, 700);
      lines.push(`- ${t.role === 'user' ? 'User' : 'Assistant'}: ${snippet}${t.text.length > 700 ? '…' : ''}`);
    }
    const block = lines.join('\n');
    if (used + block.length > maxChars && out.length) break;
    out.push(block);
    used += block.length;
  }

  return { matches: picked.map((p) => ({ file: p.file, title: p.title, score: p.score })), text: out.join('\n\n') };
}

module.exports = {
  defaultAgentDir,
  userMemoryPath,
  projectMemoryPath,
  readMemoryItems,
  appendMemory,
  deleteMemoryLine,
  userMemoryPrompt,
  skillDirs,
  sanitizeSkillName,
  skillFileText,
  saveSkillFile,
  learnSkillPrompt,
  parseSkillDraft,
  EXTRACT_MEMORY_PROMPT,
  parseMemoryDraft,
  recallSessions,
  NOTE_PREFIX_RE,
  CONTEXT_BLOCK_RE,
};
