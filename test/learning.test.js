// Self-learning suite (Hermes-inspired): global USER.md memory, skill distillation (/learn),
// memory extraction (/memorize), and past-session recall (@history).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'omp-learn-')));
const agentDir = path.join(tmp, 'agent');
const repo = path.join(tmp, 'repo');
const sessionsDir = path.join(tmp, 'sessions');
fs.mkdirSync(repo, { recursive: true });
fs.mkdirSync(sessionsDir, { recursive: true });
process.env.OMP_AGENT_DIR = agentDir;

const learning = require('../learning');
const { activate, ROOT } = require('./helper');

(async () => {
  // ---- 1. Unit tests: memory (USER.md + dedupe + system prompt) ----
  const userFile = learning.userMemoryPath(agentDir);
  assert.strictEqual(learning.userMemoryPrompt(agentDir), '');
  assert.strictEqual(learning.appendMemory(userFile, 'Prefer concise Vietnamese answers').added, true);
  assert.strictEqual(learning.appendMemory(userFile, 'prefer concise vietnamese answers').duplicate, true);
  assert.strictEqual(learning.readMemoryItems(userFile).length, 1);
  assert.match(learning.userMemoryPrompt(agentDir), /# User memory \(applies across all projects\)/);
  assert.match(learning.userMemoryPrompt(agentDir), /Prefer concise Vietnamese answers/);
  assert.strictEqual(learning.deleteMemoryLine(userFile, 0), true);
  assert.strictEqual(learning.readMemoryItems(userFile).length, 0);

  // ---- 2. Unit tests: skill draft parsing & SKILL.md writing ----
  assert.strictEqual(learning.sanitizeSkillName('Fix Vite Proxy! (v2)'), 'fix-vite-proxy-v2');
  const draft = learning.parseSkillDraft([
    'Here is your skill:',
    '```omp-skill',
    'name: Fix Vite Proxy',
    'scope: project',
    'description: Configure Vite dev server proxy for local API',
    '---',
    '# Fix Vite Proxy',
    '1. Add server.proxy in vite.config.ts.',
    '```',
  ].join('\n'));
  assert.deepStrictEqual(draft, {
    name: 'fix-vite-proxy',
    scope: 'project',
    description: 'Configure Vite dev server proxy for local API',
    body: '# Fix Vite Proxy\n1. Add server.proxy in vite.config.ts.',
  });
  const savedSkill = learning.saveSkillFile({ ...draft, cwd: repo, agentDir });
  assert.strictEqual(savedSkill.file, path.join(repo, '.omp', 'skills', 'fix-vite-proxy', 'SKILL.md'));
  const skillRaw = fs.readFileSync(savedSkill.file, 'utf8');
  assert.match(skillRaw, /^---\nname: fix-vite-proxy\ndescription: "Configure Vite dev server proxy for local API"\n---/);
  // An existing skill is never silently replaced.
  assert.throws(() => learning.saveSkillFile({ ...draft, body: 'other', cwd: repo, agentDir }), { code: 'EEXIST' });
  assert.match(fs.readFileSync(savedSkill.file, 'utf8'), /server\.proxy/);
  learning.saveSkillFile({ ...draft, body: 'replaced', cwd: repo, agentDir, overwrite: true });
  assert.match(fs.readFileSync(savedSkill.file, 'utf8'), /replaced/);

  // Nested ``` code blocks stay in the body, with 3- or 4-backtick outer fences.
  const nestedBody = '# T\n1. Run:\n```bash\nnpm test\n```\n2. Verify';
  for (const f of ['```', '````']) {
    const d = learning.parseSkillDraft(`${f}omp-skill\nname: x\ndescription: d\n---\n${nestedBody}\n${f}\nafter`);
    assert.strictEqual(d.body, nestedBody);
  }
  assert.strictEqual(learning.parseSkillDraft('```omp-skill\nname: x\nscope: users-only\n---\nb\n```').scope, 'project');
  assert.strictEqual(learning.parseSkillDraft('```omp-skill\nname: x\nscope: global\n---\nb\n```').scope, 'user');

  // ---- 3. Unit tests: memory extraction parsing + deduplication ----
  const extracted = learning.parseMemoryDraft([
    '```omp-memory',
    'project: Run npm test before committing',
    'project: run npm test before committing',
    'project: Already known rule',
    'user: Always explain root cause first',
    '```',
  ].join('\n'), '- Already known rule\n', '');
  assert.deepStrictEqual(extracted, [
    { scope: 'project', text: 'Run npm test before committing' },
    { scope: 'user', text: 'Always explain root cause first' },
  ]);
  assert.strictEqual(learning.parseMemoryDraft('No memory block here'), null);
  assert.deepStrictEqual(learning.parseMemoryDraft('```omp-memory\n```'), []);

  // ---- 4. Unit tests: session recall (@history) ----
  const writeSession = (name, title, entries) => {
    const file = path.join(sessionsDir, name);
    const lines = [
      JSON.stringify({ type: 'session', title }),
      ...entries.map((e) => JSON.stringify({ type: 'message', message: e })),
    ];
    fs.writeFileSync(file, lines.join('\n') + '\n');
    return file;
  };
  const sAuth = writeSession('s1.jsonl', 'Fix OAuth refresh token bug', [
    { role: 'user', content: 'Our OAuth refresh token fails on 401 retry.' },
    { role: 'assistant', content: [{ type: 'text', text: 'Fixed by serializing refresh calls with a mutex in auth.js.' }] },
  ]);
  const sCss = writeSession('s2.jsonl', 'Sidebar dark theme spacing', [
    { role: 'user', content: 'Adjust sidebar padding in main.css.' },
    { role: 'assistant', content: [{ type: 'text', text: 'Updated padding to 10px in main.css.' }] },
  ]);
  const sCurrent = writeSession('s3.jsonl', 'Current session', [
    { role: 'user', content: 'OAuth refresh token current session should be skipped.' },
  ]);

  const recalledQuery = learning.recallSessions({ sessionDir: sessionsDir, currentFile: sCurrent, query: 'oauth' });
  assert.strictEqual(recalledQuery.matches.length, 1);
  assert.strictEqual(recalledQuery.matches[0].file, sAuth);
  assert.match(recalledQuery.text, /mutex in auth\.js/);
  assert(!recalledQuery.text.includes('should be skipped'));

  const recalledAuto = learning.recallSessions({ sessionDir: sessionsDir, currentFile: sCurrent, promptText: 'check @history for sidebar padding' });
  assert.strictEqual(recalledAuto.matches[0].file, sCss);
  // Only the newest maxFiles sessions are scanned.
  const now = Date.now() / 1000;
  fs.utimesSync(sAuth, now - 100, now - 100);
  fs.utimesSync(sCss, now, now);
  assert.strictEqual(learning.recallSessions({ sessionDir: sessionsDir, currentFile: sCurrent, query: 'oauth', maxFiles: 1 }).matches.length, 0);

  // ---- 5. Integration tests through extension provider ----
  const { provider, posts, last } = activate({
    vs: { workspace: { workspaceFolders: [{ uri: { fsPath: repo } }] } },
    context: { extensionUri: { fsPath: ROOT } },
  });
  provider.cwd = repo;
  provider.sessionDir = sessionsDir;
  provider.sessionFile = sCurrent;
  let lastPrompt = null;
  provider.client = {
    prompt(m) { lastPrompt = m; },
    request: async () => ({}),
  };
  provider.ensureClient = async () => provider.client;
  provider.autoPick = async () => [];
  provider.reloadCommands = async () => {};

  // Built-in /learn and /memorize in slash commands
  const cmdNames = provider.allCommands().map((c) => c.name);
  assert(cmdNames.includes('learn') && cmdNames.includes('memorize'));

  // #user: saves to global USER.md and appears in systemPromptArgs
  await provider.send('#user: Use short bullet points');
  assert.match(fs.readFileSync(userFile, 'utf8'), /Use short bullet points/);
  assert.match(last('notice').text, /^Saved to USER\.md: Use short bullet points$/);
  const sysArgs = provider.systemPromptArgs({ get: (k, d) => (k === 'announceSteps' ? false : d) });
  assert.strictEqual(sysArgs.length, 1);
  assert.match(sysArgs[0], /# User memory \(applies across all projects\)/);
  assert.match(sysArgs[0], /Use short bullet points/);

  // showMemory returns both project and user sections
  await provider.showMemory();
  const sheet = last('memorySheet');
  assert(sheet.project && sheet.user);
  assert.strictEqual(sheet.user.file, 'USER.md');
  assert.strictEqual(sheet.user.items.length, 1);

  // /learn sends skill distillation prompt & agent_end offers 1-click Save
  await provider.send('/learn cache invalidation');
  assert.match(lastPrompt, /````omp-skill/);
  assert.match(lastPrompt, /cache invalidation/);
  provider.turnText = '```omp-skill\nname: cache-invalidation\nscope: user\ndescription: Clear stale cache keys\n---\n# Steps\n1. Bump version.\n```';
  provider.onRecord({ type: 'agent_end' });
  const skillNotice = last('notice');
  assert.match(skillNotice.text, /Skill draft ready: cache-invalidation/);
  const saveUserAction = skillNotice.actions.find((a) => a.label === 'Save globally');
  await provider.onWebviewMessage({ type: 'action', cmd: saveUserAction.cmd, arg: saveUserAction.arg });
  const globalSkillFile = path.join(agentDir, 'skills', 'cache-invalidation', 'SKILL.md');
  assert(fs.existsSync(globalSkillFile));

  // /memorize sends extraction prompt & agent_end offers Save all
  await provider.send('/memorize');
  assert.match(lastPrompt, /```omp-memory/);
  provider.turnText = '```omp-memory\nproject: Use node --test for tests\nuser: Use short bullet points\nuser: Prefer TypeScript strict mode\n```';
  provider.onRecord({ type: 'agent_end' });
  const memNotice = last('notice');
  assert.match(memNotice.text, /Extracted 2 memory notes:/); // "Use short bullet points" was deduplicated!
  const saveAllAction = memNotice.actions.find((a) => a.label === 'Save all');
  await provider.onWebviewMessage({ type: 'action', cmd: saveAllAction.cmd, arg: saveAllAction.arg });
  assert.match(fs.readFileSync(path.join(repo, 'AGENTS.md'), 'utf8'), /Use node --test for tests/);
  assert.match(fs.readFileSync(userFile, 'utf8'), /Prefer TypeScript strict mode/);

  // @history:oauth injects recalled context and splitUserText strips it cleanly
  await provider.send('How did we fix @history:oauth before?');
  assert.match(lastPrompt, /\[Past sessions matching "oauth"\]/);
  assert.match(lastPrompt, /mutex in auth\.js/);
  const { splitUserText } = require('../extension')._test;
  const cleaned = splitUserText(lastPrompt);
  assert.strictEqual(cleaned.text, 'How did we fix @history:oauth before?');
  // Trailing punctuation neither hides @history nor leaks into the query.
  await provider.send('Recall @history:oauth, please');
  assert.match(lastPrompt, /\[Past sessions matching "oauth"\]/);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('# learning ok');
})().catch((e) => {
  fs.rmSync(tmp, { recursive: true, force: true });
  console.error(e);
  process.exit(1);
});
