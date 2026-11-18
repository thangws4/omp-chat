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
})().catch((e) => { console.error(e); process.exit(1); });
