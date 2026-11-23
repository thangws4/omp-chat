// Tests for gateway usage auto-load, core bug fixes, Myers diff, highlight/Mermaid,
// custom subagents, denied commands, fallback model, budget alert, and pinned skills.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const keys = require('../keys.js');
const plugins = require('../plugins.js');
const hl = require('../media/highlight.js');
const { activate, fail } = require('./helper');

(async () => {
  // Single activate() per process (helper.js caches require('../extension.js')).
  let cfg = { model: 'anthropic/claude-sonnet-5-5', approvalMode: 'always-ask', deniedCommands: [], fallbackModel: '', budgetAlert: 0 };
  const { provider, ctx, posts } = activate({
    vs: {
      ConfigurationTarget: { Global: 1 },
      workspace: { getConfiguration: () => ({ get: (k, d) => (k in cfg ? cfg[k] : d), update: async (k, v) => { cfg[k] = v; } }) },
    },
  });

  // 1. Gateway usage auto-load: loads on webview ready even before omp client starts,
  //    reloads live on agent_end (ignoring 60s cache), and never caches transient errors.
  {
    // Restore real refreshMeter (helper.js stubs it to a no-op).
    delete provider.refreshMeter;
    provider.view = { visible: true, webview: { postMessage: (m) => posts.push(m) } };

    await keys.addKey(ctx, 'ANTHROPIC_API_KEY', 'Zyloris', 'sk-zyloris-1234', 'https://claude.zyloris.com/v1', 'anthropic',
      'https://zyloris.com/api/gateway/subscription/check?apiKey={key}');

    let hits = 0;
    let tokensUsed = 0;
    let shouldFail = true;
    global.fetch = async () => {
      hits++;
      if (shouldFail) return { ok: false, status: 503, statusText: 'Service Unavailable', text: async () => 'temp' };
      return { ok: true, json: async () => ({ found: true, status: 'Active', tokensUsed, tokenLimit: 700000 }) };
    };

    // First call fails transiently -> must NOT be cached.
    await provider.refreshMeter();
    assert.strictEqual(hits, 1);

    // Next call (via webview 'ready' -> sync() -> refreshMeter()) succeeds even though this.client is still null!
    shouldFail = false;
    tokensUsed = 70000;
    assert.strictEqual(provider.client, null);
    await provider.onWebviewMessage({ type: 'ready' });
    await new Promise((r) => setTimeout(r, 20));
    let meter = posts.filter((p) => p.type === 'meter').pop();
    assert.deepStrictEqual(meter.gauge, { used: 70000, limit: 700000 }, 'gateway usage loads on ready without waiting for omp client');

    // After a turn ends (agent_end), usage MUST force-refresh even within 60s!
    tokensUsed = 140000;
    provider.onRecord({ type: 'agent_end' });
    await new Promise((r) => setTimeout(r, 20));
    meter = posts.filter((p) => p.type === 'meter').pop();
    assert.deepStrictEqual(meter.gauge, { used: 140000, limit: 700000 }, 'gateway usage refreshes live after agent_end');

    // Key with baseUrl but NO usageUrl must not hit official provider endpoint.
    let calledOfficial = false;
    global.fetch = async () => { calledOfficial = true; return { ok: true, json: async () => ({}) }; };
    const noUsage = await keys.fetchAccount('openrouter', 'sk-proxy', 's', '', 'https://my-proxy.local/v1');
    assert.strictEqual(noUsage, null);
    assert.strictEqual(calledOfficial, false);

    // useKey from 'keys' sheet must NOT trigger a duplicate showUsage()!
    provider.restart = async () => {};
    posts.length = 0;
    const list = await keys.loadKeys(ctx, 'ANTHROPIC_API_KEY');
    await provider.onWebviewMessage({ type: 'useKey', env: 'ANTHROPIC_API_KEY', id: list[0].id, from: 'keys' });
    assert.strictEqual(posts.filter((p) => p.type === 'keys').length, 1);
    assert.strictEqual(posts.filter((p) => p.type === 'usage').length, 0);
  }

  // 2. splitUserText strips attachments, @git, @git:log, @open, @https://, and unsaved changes.
  {
    const { splitUserText, deniedPattern, listCommandFiles, listAgentFiles, agentFileText, walkWorktreeFiles } = require('../extension.js')._test;
    const raw = '[Current file: app.js]\n\n'
      + '[Files the user attached; read them with the read tool, which also converts PDF, Word, Excel, PowerPoint and EPUB:\n- /tmp/spec.pdf\n- /tmp/notes.md]\n\n'
      + '[Attached files: helper.js]\n\n'
      + '[Unsaved changes in app.js]\n```\n+1|hi\n```\n\n'
      + '[Uncommitted changes (git status + diff HEAD)]\n```\nM app.js\n```\n\n'
      + '[Git log (recent commits)]\n```\nabc123 init\n```\n\n'
      + '[Open editors]\n```\n- app.js\n```\n\n'
      + '[Web page https://example.com]\n```\nhello world\n```\n\n'
      + 'Please review this';
    const parsed = splitUserText(raw);
    assert.strictEqual(parsed.text, 'Please review this');
    assert.strictEqual(parsed.context, 'app.js');
    assert.deepStrictEqual(parsed.files, ['/tmp/spec.pdf', '/tmp/notes.md', 'helper.js']); // full paths: chips open them

    // Denied command rules match even with shell control chars, and any part of a compound command.
    assert.strictEqual(deniedPattern('rm -rf / && echo hi', ['rm -rf *']), 'rm -rf *');
    assert.strictEqual(deniedPattern('cd x && rm -rf /', ['rm -rf *']), 'rm -rf *');
    assert.strictEqual(deniedPattern('echo $(rm -rf /)', ['rm -rf *']), 'rm -rf *');
    assert.strictEqual(deniedPattern('npm test', ['rm -rf *']), undefined);

    // Nested commands (dir:name), custom subagents, and worktree file walking.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-upg-'));
    try {
      fs.mkdirSync(path.join(tmp, '.omp', 'commands', 'git'), { recursive: true });
      fs.writeFileSync(path.join(tmp, '.omp', 'commands', 'git', 'pr.md'), '---\ndescription: Open PR\n---\nCreate a PR.');
      const cmds = listCommandFiles(tmp).filter((c) => c.file.startsWith(tmp));
      assert.deepStrictEqual(cmds.map((c) => c.name), ['git:pr']);

      fs.mkdirSync(path.join(tmp, '.omp', 'agents'), { recursive: true });
      fs.writeFileSync(path.join(tmp, '.omp', 'agents', 'auditor.md'),
        agentFileText({ name: 'auditor', description: 'Audit code', model: 'anthropic/claude-sonnet-5-5', prompt: 'Check bugs.' }));
      const agents = listAgentFiles(tmp).filter((a) => a.file.startsWith(tmp));
      assert.strictEqual(agents.length, 1);
      assert.strictEqual(agents[0].name, 'auditor');
      assert.strictEqual(agents[0].model, 'anthropic/claude-sonnet-5-5');

      fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
      fs.mkdirSync(path.join(tmp, 'node_modules', 'pkg'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'src', 'index.js'), '1');
      fs.writeFileSync(path.join(tmp, 'node_modules', 'pkg', 'x.js'), '2');
      const walked = walkWorktreeFiles(tmp);
      assert(walked.includes('src/index.js'));
      assert(!walked.some((p) => p.includes('node_modules')));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  // 3. Myers diff handles large files (3,000 lines) with scattered edits as separate hunks + review.clear().
  {
    const review = require('../review.js');
    const bigA = Array.from({ length: 3000 }, (_, i) => `line ${i}`);
    const bigB = [...bigA];
    bigB[10] = 'CHANGED TEN';
    bigB[2990] = 'CHANGED END';
    const hunks = review.diffLines(bigA, bigB);
    assert.strictEqual(hunks.length, 2, 'large file keeps 2 exact hunks instead of collapsing to 1');
    assert.deepStrictEqual(hunks[0], { a0: 10, a1: 11, b0: 10, b1: 11 });
    assert.deepStrictEqual(hunks[1], { a0: 2990, a1: 2991, b0: 2990, b1: 2991 });

    review.files.clear();
    review.track('/tmp/rev.js', 'a\nb', false, {});
    assert(review.files.has('/tmp/rev.js'));
    review.clear('/tmp/rev.js');
    assert(!review.files.has('/tmp/rev.js'));
  }

  // 4. Highlighting & Mermaid SVG renderer.
  {
    const out = hl.highlight('const x = "hi"; // comment\nfunction foo(a) { return 42; }', 'js');
    assert(out.includes('hl-kw') && out.includes('hl-str') && out.includes('hl-cmt') && out.includes('hl-fn') && out.includes('hl-num'));
    const safe = hl.highlight('<script>alert(1)</script>', 'html');
    assert(!safe.includes('<script>'), 'XSS escaped');
    const flowSvg = hl.renderMermaid('flowchart LR\n  A[Start] --> B{Check}\n  B -->|yes| C(Done)');
    assert(flowSvg && flowSvg.startsWith('<svg') && flowSvg.includes('Start') && flowSvg.includes('Done'));
    const seqSvg = hl.renderMermaid('sequenceDiagram\n  User->>API: Request\n  API-->>User: 200 OK');
    assert(seqSvg && seqSvg.startsWith('<svg') && seqSvg.includes('Request'));
  }

  // 5. Stemming + pinned skills in plugins.pickRelevant.
  {
    const skills = [
      { name: 'tdd', description: 'write unit test first' },
      { name: 'always-on', description: 'core style guide' },
    ];
    const picked = plugins.pickRelevant('we are testing the auth module', skills, 3, ['always-on']);
    assert.deepStrictEqual(picked.map((s) => s.name), ['always-on', 'tdd']);
  }

  // 6. Local providers + keys.testKey + Subagent Map tokens/cost + Budget Alert + Fallback Model.
  {
    assert(keys.providerOf('ollama/qwen2.5-coder:latest')?.optionalKey === true);
    assert(keys.providerOf('lmstudio/local-model')?.defaultBaseUrl === 'http://localhost:1234/v1');
    global.fetch = async () => ({ ok: true, status: 200, statusText: 'OK', json: async () => ({ tokensUsed: 50, tokenLimit: 100 }) });
    const tRes = await keys.testKey('anthropic', 'sk-test', 'https://gw.local/v1', 'https://gw.local/usage?k={key}', 's');
    assert.strictEqual(tRes.ok, true);
    assert(tRes.message.includes('50% used'));

    cfg = { model: 'openai/gpt-5.5', approvalMode: 'always-ask', fallbackModel: 'openrouter/free:free', budgetAlert: 0.5 };
    posts.length = 0;
    provider.modelName = 'openai/gpt-5.5';
    provider.sessionCost = 0;
    provider.budgetWarned = false;
    const prompted = [];
    provider.client = {
      prompt: (m) => prompted.push(m),
      request: async () => ({ provider: 'openrouter', id: 'free:free' }),
      send: () => {},
      dispose: () => {},
    };
    provider.onSubagent({ id: 'a1', agent: 'scout', status: 'started' }, { status: 'running', tokens: 1234, cost: 0.012, durationMs: 5000 });
    const ms = provider.mapState();
    assert.strictEqual(ms.agents[0].tokens, 1234);
    assert.strictEqual(ms.agents[0].cost, 0.012);

    // Budget alert triggers once when session cost crosses $0.50.
    provider.recordCost(0.6);
    assert(posts.some((p) => p.type === 'notice' && /budget alert/i.test(p.text)));

    // Fallback model activates on quota exhaustion.
    fail(provider, 429, 'Rate limit exceeded');
    await new Promise((r) => setTimeout(r, 20));
    assert(posts.some((p) => p.type === 'notice' && /Falling back to openrouter\/free:free/.test(p.text)));
    assert.strictEqual(prompted.pop(), '/retry');

    // A fallback that cannot be switched to: no /retry on the spent model (it would 429 straight back, forever).
    provider.client.request = async () => { throw new Error('no key'); };
    provider.modelName = 'openai/gpt-5.5';
    cfg.model = 'openai/gpt-5.5';
    fail(provider, 429, 'Rate limit exceeded');
    await new Promise((r) => setTimeout(r, 20));
    assert(!prompted.includes('/retry'), 'no retry on the old model');
    provider.dispose();
  }

  console.log('# upgrades ok');
})().catch((e) => { console.error(e); process.exit(1); });
