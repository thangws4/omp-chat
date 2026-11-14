const assert = require('assert');
const { activate } = require('./helper');
const { provider, gs, last } = activate();
const M = (p, id, name) => ({ provider: p, id, name });
provider.client = { request: async () => ({ models: [M('openrouter', 'a/alpha', 'Alpha'), M('openrouter', 'b/beta:free', 'Beta free'),
  M('opencode-go', 'deepseek-v4.1-flash', 'DeepSeek V4.1 Flash'), M('opencode-go', 'kimi-k3', 'Kimi K3'), M('openrouter', 'z/zeta', 'Zeta')] }) };
(async () => {
  // recent: every switch is remembered, newest first, no duplicates
  for (const [p, id] of [['openrouter', 'a/alpha'], ['opencode-go', 'kimi-k3'], ['openrouter', 'a/alpha']]) provider.setModel({ provider: p, id });
  assert.deepStrictEqual(gs.get('ompChat.recentModels'), ['openrouter/a/alpha', 'opencode-go/kimi-k3']);
  await provider.onWebviewMessage({ type: 'toggleFavorite', id: 'opencode-go/deepseek-v4.1-flash' });
  await provider.onWebviewMessage({ type: 'toggleFavorite', id: 'openrouter/z/zeta' });
  await provider.pickModel();
  const order = last('models').list.map((x) => `${x.id}${x.favorite ? '★' : x.recent ? '(recent)' : ''}`);
  assert.deepStrictEqual(order.slice(0, 4), ['opencode-go/deepseek-v4.1-flash★', 'openrouter/z/zeta★', 'openrouter/a/alpha(recent)', 'opencode-go/kimi-k3(recent)']);
  // the manager: your models in your order, plus every model
  await provider.onWebviewMessage({ type: 'manageModels' });
  let sh = last('modelsSheet');
  assert.deepStrictEqual(sh.favorites, [{ id: 'opencode-go/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' }, { id: 'openrouter/z/zeta', name: 'Zeta' }]);
  assert.strictEqual(sh.all.length, 5);
  await provider.onWebviewMessage({ type: 'moveFavorite', id: 'openrouter/z/zeta', dir: -1 });
  assert.deepStrictEqual(last('modelsSheet').favorites.map((x) => x.id), ['openrouter/z/zeta', 'opencode-go/deepseek-v4.1-flash']);
  await provider.onWebviewMessage({ type: 'moveFavorite', id: 'openrouter/z/zeta', dir: -1 }); // already first: no-op
  await provider.onWebviewMessage({ type: 'toggleFavorite', id: 'openrouter/z/zeta', from: 'sheet' });
  sh = last('modelsSheet');
  assert.deepStrictEqual(sh.favorites.map((x) => x.id), ['opencode-go/deepseek-v4.1-flash']);
  assert(!sh.all.find((x) => x.id === 'openrouter/z/zeta').favorite);
})().catch((e) => { console.error(e); process.exit(1); });
