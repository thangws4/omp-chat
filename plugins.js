// Skills omp loads (from Claude Code plugins, your own skill folders and the project), grouped by plugin,
// switched off per workspace through a `--config` overlay, and auto-picked per message.
'use strict';
const path = require('path');

// ".../plugins/cache/<marketplace>/<plugin>/<version>/skills/<name>/SKILL.md" -> plugin "<plugin>@<marketplace>"
function pluginOf(filePath) {
  const parts = String(filePath || '').split(/[\\/]/);
  const i = parts.lastIndexOf('cache');
  if (i > 0 && parts[i - 1] === 'plugins' && parts.length > i + 3) return { id: `${parts[i + 2]}@${parts[i + 1]}`, name: parts[i + 2], source: parts[i + 1] };
  return null;
}

// `omp skill list --json` entries -> [{ id, name, source, skills: [{ name, description }] }]
function groupSkills(skills, cwd) {
  const groups = new Map();
  const inProject = (p) => !!cwd && !!p && path.resolve(p).toLowerCase().startsWith(path.resolve(cwd).toLowerCase() + path.sep);
  for (const s of skills || []) {
    if (!s?.name) continue;
    const g = pluginOf(s.filePath) || (inProject(s.filePath) ? { id: 'project', name: 'Project skills' } : { id: 'user', name: 'Your skills' });
    if (!groups.has(g.id)) groups.set(g.id, { ...g, skills: [] });
    groups.get(g.id).skills.push({ name: s.name, description: s.description || '' });
  }
  const rank = (g) => (g.id === 'project' ? 0 : g.id === 'user' ? 1 : 2);
  return [...groups.values()].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

// ---- auto-pick ----
// ponytail: keyword overlap, not semantics. Skill descriptions are English, so common Vietnamese intents
// are mapped to English words first. Upgrade path: ask the model to choose (costs one request per message).
const VI = [
  [/sửa lỗi|gỡ lỗi|lỗi|bug|crash/i, 'debug debugging bug fix error failure'],
  [/kiểm thử|unit test|viết test|\btest/i, 'test testing tdd tests'],
  [/đặc tả|\bspec\b|yêu cầu/i, 'spec specification requirements'],
  [/kế hoạch|lập kế hoạch|\bplan\b|chia nhỏ/i, 'plan planning tasks breakdown'],
  [/đánh giá|review|xem lại/i, 'review code quality'],
  [/tài liệu|readme|\bdocs?\b|adr/i, 'documentation docs'],
  [/giao diện|\bui\b|frontend|css/i, 'frontend interface components'],
  [/hiệu năng|tối ưu|chậm|performance/i, 'performance optimization'],
  [/bảo mật|security|lỗ hổng/i, 'security hardening'],
  [/đơn giản|gọn|refactor|dọn/i, 'simplify simplification refactor'],
  [/ý tưởng|brainstorm|thiết kế/i, 'brainstorming idea design'],
  [/triển khai|deploy|phát hành|release|ship/i, 'ship shipping launch release deploy'],
  [/\bgit\b|commit|nhánh|branch|pull request|\bpr\b/i, 'git branch commit workflow'],
  [/api|endpoint|giao tiếp/i, 'api interface design'],
];
const STOP = new Set(('the and for with that this from into when use using your you are not but can any all its was what how have has will '
  + 'about them they then than over just more most also only some such like before after each make made does need want work works').split(' '));
const words = (t) => (String(t).toLowerCase().match(/[a-z][a-z0-9]{2,}/g) || []).filter((w) => !STOP.has(w));

// Up to `max` skills whose name (strong) or description (weak) shares words with the request.
function pickRelevant(message, skills, max = 3) {
  let q = String(message || '');
  for (const [re, en] of VI) if (re.test(q)) q += ' ' + en;
  const qw = new Set(words(q));
  if (!qw.size) return [];
  return skills
    .map((s) => {
      const nameWords = new Set(words(s.name.replace(/[-_/:.]/g, ' ')));
      const descWords = new Set(words(s.description));
      let score = 0;
      for (const w of qw) score += nameWords.has(w) ? 3 : descWords.has(w) ? 1 : 0;
      return { s, score };
    })
    .filter((x) => x.score >= 3)
    .sort((a, b) => b.score - a.score || a.s.name.localeCompare(b.s.name))
    .slice(0, max)
    .map((x) => x.s);
}

// The hint put in front of a message (and taken off again for display).
const HINT_PREFIX = '[Skills that may help with this request';
const skillHint = (picked) => `${HINT_PREFIX}: ${picked.map((s) => `skill://${s.name}`).join(', ')}. Read the ones that fit before starting.]`;

module.exports = { pluginOf, groupSkills, pickRelevant, skillHint, HINT_PREFIX };
