const assert = require('assert');
const keys = require('../keys.js');
const sec = new Map(), gs = new Map();
const ctx = { secrets: { get: async (k) => sec.get(k), store: async (k, v) => sec.set(k, v), delete: async (k) => sec.delete(k) },
  globalState: { get: (k) => gs.get(k), update: async (k, v) => gs.set(k, v) } };
(async () => {
  // legacy single key (earlier versions) is folded into the list once
  sec.set('ompChat.openrouterApiKey', 'sk-or-old-1234');
  let l = await keys.loadKeys(ctx, 'OPENROUTER_API_KEY');
  assert.strictEqual(l.length, 1); assert.strictEqual(l[0].key, 'sk-or-old-1234'); assert(!sec.has('ompChat.openrouterApiKey'));
  await keys.loadKeys(ctx, 'OPENROUTER_API_KEY'); assert.strictEqual((await keys.loadKeys(ctx, 'OPENROUTER_API_KEY')).length, 1);
  // add -> becomes active; rotation visits each key once
  const a = (await keys.loadKeys(ctx, 'OPENROUTER_API_KEY'))[0];
  const b = await keys.addKey(ctx, 'OPENROUTER_API_KEY', 'work', 'sk-or-work-5678');
  const c = await keys.addKey(ctx, 'OPENROUTER_API_KEY', 'spare', 'sk-or-spare-9999');
  l = await keys.loadKeys(ctx, 'OPENROUTER_API_KEY');
  assert.strictEqual(keys.activeKey(ctx, 'OPENROUTER_API_KEY', l).id, c.id);
  const tried = new Set([c.id]);
  const n1 = keys.nextKey(l, c.id, tried); assert.strictEqual(n1.id, a.id); tried.add(n1.id);
  const n2 = keys.nextKey(l, n1.id, tried); assert.strictEqual(n2.id, b.id); tried.add(n2.id);
  assert.strictEqual(keys.nextKey(l, n2.id, tried), null, 'all keys spent');
  // Zen and Go share OPENCODE_API_KEY; envFor exposes the active key per env var
  await keys.addKey(ctx, 'OPENCODE_API_KEY', 'oc', 'sk-oc-1');
  const env = await keys.envFor(ctx);
  assert.deepStrictEqual(env, { OPENCODE_API_KEY: 'sk-oc-1', OPENROUTER_API_KEY: 'sk-or-spare-9999' });
  assert.strictEqual(keys.providerOf('opencode-go/deepseek-v4.1-flash').env, keys.providerOf('opencode-zen/x').env);
  assert.strictEqual(keys.groupLabel('OPENCODE_API_KEY'), 'OpenCode Go / OpenCode Zen');
  // quota vs other errors
  assert(keys.isQuotaError(429, '') && keys.isQuotaError(402, '') && keys.isQuotaError(undefined, 'Rate limit exceeded: free-models-per-day'));
  assert(!keys.isQuotaError(401, '401 Authentication Fails') && !keys.isQuotaError(500, 'socket hang up'));
  assert.strictEqual(keys.mask('sk-or-work-5678'), 'sk-or…5678');
  // provider ids match omp's; a key's base URL applies to its provider while that key is active
  assert.strictEqual(keys.providerOf('xai/grok-4.5').label, 'xAI');
  assert.strictEqual(keys.providerOf('openrouter/anthropic/claude-sonnet-5-5').label, 'OpenRouter');
  assert.strictEqual(keys.normalizeBaseUrl(' https://proxy.local/v1/ '), 'https://proxy.local/v1');
  assert.strictEqual(keys.normalizeBaseUrl(''), '');
  assert.strictEqual(keys.normalizeBaseUrl('ftp://x'), null);
  assert.strictEqual(keys.normalizeBaseUrl('not a url'), null);
  const px = await keys.addKey(ctx, 'ANTHROPIC_API_KEY', 'proxy', 'sk-ant-1', 'https://proxy.local', 'anthropic');
  assert.deepStrictEqual(await keys.baseUrlsFor(ctx), { anthropic: 'https://proxy.local' });
  await keys.addKey(ctx, 'ANTHROPIC_API_KEY', 'direct', 'sk-ant-2');
  assert.deepStrictEqual(await keys.baseUrlsFor(ctx), {});
  await keys.setActive(ctx, 'ANTHROPIC_API_KEY', px.id);
  assert.deepStrictEqual(await keys.baseUrlsFor(ctx), { anthropic: 'https://proxy.local' });
  
})().catch((e) => { console.error(e); process.exit(1); });
