// Editing the base URL of a saved key from the key list.
const assert = require('assert');
const keys = require('../keys.js');
const { activate } = require('./helper');

const { provider, ctx, posts } = activate();
let restarts = 0;
provider.restart = async () => { restarts++; };
let answer, form;
provider.ask = async (f) => { form = f; return answer; };

(async () => {
  const oc = await keys.addKey(ctx, 'OPENCODE_API_KEY', 'oc', 'sk-oc-1');
  await keys.addKey(ctx, 'OPENCODE_API_KEY', 'spare', 'sk-oc-2'); // now the active one

  // Go and Zen share the key: the form asks which endpoint the URL replaces. Inactive key: no restart.
  answer = { provider: 'OpenCode Zen', baseUrl: ' https://proxy.local/zen/ ' };
  await provider.onWebviewMessage({ type: 'editBaseUrl', env: 'OPENCODE_API_KEY', id: oc.id });
  assert(form.fields.some((f) => f.name === 'provider'));
  let k = (await keys.loadKeys(ctx, 'OPENCODE_API_KEY')).find((x) => x.id === oc.id);
  assert.deepStrictEqual([k.baseUrl, k.provider], ['https://proxy.local/zen', 'opencode-zen']);
  assert.strictEqual(restarts, 0);

  // The form starts from the saved URL; a bad URL changes nothing.
  answer = { provider: 'OpenCode Zen', baseUrl: 'nope' };
  await provider.onWebviewMessage({ type: 'editBaseUrl', env: 'OPENCODE_API_KEY', id: oc.id });
  assert.strictEqual(form.fields.find((f) => f.name === 'baseUrl').value, 'https://proxy.local/zen');
  assert.match(posts.filter((p) => p.type === 'error').pop().text, /not an http\(s\) URL/);
  assert.strictEqual((await keys.loadKeys(ctx, 'OPENCODE_API_KEY')).find((x) => x.id === oc.id).baseUrl, 'https://proxy.local/zen');

  // Single-provider key, active: set then clear; omp restarts each time.
  const ant = await keys.addKey(ctx, 'ANTHROPIC_API_KEY', 'a', 'sk-ant-1');
  answer = { baseUrl: 'https://gw.local/anthropic' };
  await provider.onWebviewMessage({ type: 'editBaseUrl', env: 'ANTHROPIC_API_KEY', id: ant.id });
  assert(!form.fields.some((f) => f.name === 'provider'));
  assert.deepStrictEqual(await keys.baseUrlsFor(ctx), { anthropic: 'https://gw.local/anthropic' });
  answer = { baseUrl: '' };
  await provider.onWebviewMessage({ type: 'editBaseUrl', env: 'ANTHROPIC_API_KEY', id: ant.id });
  k = (await keys.loadKeys(ctx, 'ANTHROPIC_API_KEY'))[0];
  assert(!('baseUrl' in k) && !('provider' in k));
  assert.strictEqual(restarts, 2);

  // The extension omp loads: a known provider only moves; "custom" (OmniRoute, LiteLLM…) is declared whole,
  // OpenAI-compatible, with its models read from {baseUrl}/models using the key.
  const dir = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'omp-base-'));
  provider.context.globalStorageUri = { fsPath: dir };
  const [, file] = provider.baseUrlArgs({ anthropic: 'https://gw.local', custom: 'http://127.0.0.1:20128/v1' });
  const calls = [];
  (await import(require('url').pathToFileURL(file).href)).default({ registerProvider: (id, c) => calls.push([id, c]) });
  assert.deepStrictEqual(calls[0], ['anthropic', { baseUrl: 'https://gw.local' }]);
  const [id, c] = calls[1];
  assert(id === 'custom' && c.api === 'openai-completions' && c.apiKey === 'CUSTOM_OPENAI_API_KEY');
  let seen;
  global.fetch = async (url, o) => { seen = [url, o.headers.Authorization]; return { ok: true, json: async () => ({ data: [{ id: 'auto' }, { id: 'kimi-k3', context_length: 262144 }, {}] }) }; };
  const ms = await c.fetchDynamicModels('sk-omni');
  assert.deepStrictEqual(seen, ['http://127.0.0.1:20128/v1/models', 'Bearer sk-omni']);
  assert.deepStrictEqual(ms.map((m) => [m.id, m.contextWindow]), [['auto', 128000], ['kimi-k3', 262144]]);
  global.fetch = async () => ({ ok: false, status: 401 });
  await assert.rejects(c.fetchDynamicModels('bad'), /models answered 401/);
})().catch((e) => { console.error(e); process.exit(1); });
