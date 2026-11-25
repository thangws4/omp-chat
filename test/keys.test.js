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
  // a gateway's usage URL: {key} filled in, any JSON shown as name/value rows
  const gw = await keys.addKey(ctx, 'ANTHROPIC_API_KEY', 'gw', 'sk-z/1', 'https://gw.local/v1', 'anthropic', 'https://gw.local/api/check-usage/{key}');
  assert.strictEqual(gw.usageUrl, 'https://gw.local/api/check-usage/{key}');
  let seen;
  global.fetch = async (url, o) => { seen = { url, h: o.headers }; return { ok: true, json: async () => ({ ok: true, quota: { used: 3, limit: 10 }, tags: ['a'] }) }; };
  const acc = await keys.fetchAccount('anthropic', 'sk-z/1', 's', gw.usageUrl);
  assert.strictEqual(seen.url, 'https://gw.local/api/check-usage/sk-z%2F1');
  assert.strictEqual(seen.h['x-api-key'], 'sk-z/1');
  assert.deepStrictEqual(acc.custom, [['ok', 'true'], ['quota.used', '3'], ['quota.limit', '10'], ['tags.0', 'a']]);
  assert.strictEqual(acc.gauge, undefined, 'nested used/limit: no bar');
  // Zyloris' shape: keys echoed back and nulls are dropped, tokensUsed / tokenLimit become the bar
  const zk = 'sk-0000aaaa1111bbbb2222cccc3333dddd';
  global.fetch = async () => ({ ok: true, json: async () => ({ found: true, apiKey: zk, errorCode: null, tokensUsed: 1200, tokenLimit: 700000,
    note: `for ${zk}`, gatewayKeys: [{ gatewayKey: 'sk-other0000111122223333', resetIntervalHours: 5 }] }) });
  const z = await keys.fetchAccount('anthropic', zk, 's', 'https://zyloris.com/api/gateway/subscription/check?apiKey={key}');
  assert(!/sk-/.test(JSON.stringify(z)), 'no key reaches the panel, not even masked');
  assert.deepStrictEqual(z.custom.map(([n]) => n), ['found', 'tokensUsed', 'tokenLimit', 'gatewayKeys.0.resetIntervalHours']);
  assert.deepStrictEqual(z.gauge, { used: 1200, limit: 700000 });
  global.fetch = async () => ({ ok: false, status: 404, statusText: 'Not Found', text: async () => '{"error":"Not found"}' });
  assert.deepStrictEqual(await keys.fetchAccount('anthropic', 'k', 's', gw.usageUrl), { provider: 'anthropic', error: '404 Not Found — {"error":"Not found"}' });
  assert.strictEqual(await keys.fetchAccount('anthropic', 'k', 's'), null, 'no usage URL: no API');
  // Command Code: whoami gives the org, its credits become plan windows + a balance line
  const urls = [];
  global.fetch = async (url) => { urls.push(url); return { ok: true, json: async () => (url.includes('whoami')
    ? { user: { id: 'u1' }, org: { id: 'o 1' } }
    : { data: { credits: { monthlyCredits: 4.5, purchasedCredits: 1, freeCredits: 0.004, planId: 'pro' },
      windowLimits: { fiveHour: { used: 3, cap: 4, resetAt: 1800000000, exceeded: false }, weekly: { used: 10, cap: 10, resetAt: 1800000000000, exceeded: true } } } }) }; };
  const cc = await keys.fetchAccount('commandcode', 'user_k', 's');
  assert.strictEqual(urls[1], 'https://api.commandcode.ai/alpha/billing/credits?orgId=o%201');
  assert.deepStrictEqual(cc.windows, { rolling: { status: 'ok', percent: 75, resetsAt: '2027-01-15T08:00:00.000Z' },
    weekly: { status: 'rate-limited', percent: 100, resetsAt: '2027-01-15T08:00:00.000Z' } });
  assert.deepStrictEqual(cc.balance_infos, [{ total_balance: 5.5, currency: 'credits (pro)' }]);
  global.fetch = async (url) => ({ ok: true, json: async () => (url.includes('whoami') ? { user: { id: 'u1' } } : { credits: { purchasedCredits: 2 } }) });
  const payg = await keys.fetchAccount('commandcode', 'user_k', 's');
  assert(!payg.windows, 'pay-as-you-go: no windows'); assert.strictEqual(payg.balance_infos[0].total_balance, 2);
})().catch((e) => { console.error(e); process.exit(1); });
