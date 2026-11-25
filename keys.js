// API keys: several per provider, kept in VS Code SecretStorage and handed to omp as env vars.
// Providers that read the same env var (OpenCode Zen and Go both use OPENCODE_API_KEY) share one list.
'use strict';
const crypto = require('crypto');

// prefix is omp's provider id plus "/".
const PROVIDERS = [
  { label: 'OpenCode Go', description: '$10/mo plan: DeepSeek, Kimi, GLM, Qwen… (5h / weekly / monthly limits)', env: 'OPENCODE_API_KEY',
    url: 'https://opencode.ai/go', prefix: 'opencode-go/', defaultModel: 'opencode-go/deepseek-v4.1-flash' },
  { label: 'OpenCode Zen', description: 'free deepseek-v4.1-flash-free (limited time)', env: 'OPENCODE_API_KEY', legacySecret: 'ompChat.opencodeApiKey',
    url: 'https://opencode.ai/zen', prefix: 'opencode-zen/', defaultModel: 'opencode-zen/deepseek-v4.1-flash-free' },
  { label: 'OpenRouter', description: 'free :free models available', env: 'OPENROUTER_API_KEY', legacySecret: 'ompChat.openrouterApiKey',
    url: 'https://openrouter.ai/keys', prefix: 'openrouter/', defaultModel: 'openrouter/baidu/ernie-5.5-flash-preview:free' },
  { label: 'DeepSeek', description: 'paid, cheap', env: 'DEEPSEEK_API_KEY', legacySecret: 'ompChat.deepseekApiKey',
    url: 'https://platform.deepseek.com/api_keys', prefix: 'deepseek/', defaultModel: 'deepseek/deepseek-flash' },
  { label: 'Anthropic', description: 'Claude models, pay per token', env: 'ANTHROPIC_API_KEY',
    url: 'https://platform.anthropic.com/settings/keys', prefix: 'anthropic/', defaultModel: 'anthropic/claude-sonnet-5-5' },
  { label: 'OpenAI', description: 'GPT models, pay per token', env: 'OPENAI_API_KEY',
    url: 'https://platform.openai.com/api-keys', prefix: 'openai/', defaultModel: 'openai/gpt-5.5' },
  { label: 'Google Gemini', description: 'Gemini models, free tier available', env: 'GEMINI_API_KEY',
    url: 'https://aistudio.google.com/apikey', prefix: 'google/', defaultModel: 'google/gemini-3.5-flash' },
  { label: 'xAI', description: 'Grok models, pay per token', env: 'XAI_API_KEY',
    url: 'https://console.x.ai', prefix: 'xai/', defaultModel: 'xai/grok-4.5' },
  { label: 'Mistral', description: 'Devstral / Codestral, free tier available', env: 'MISTRAL_API_KEY',
    url: 'https://console.mistral.ai/api-keys', prefix: 'mistral/', defaultModel: 'mistral/devstral-latest' },
  { label: 'Groq', description: 'fast open models, free tier available', env: 'GROQ_API_KEY',
    url: 'https://console.groq.com/keys', prefix: 'groq/', defaultModel: 'groq/openai/gpt-oss-120b' },
  { label: 'Moonshot', description: 'Kimi models, pay per token', env: 'MOONSHOT_API_KEY',
    url: 'https://platform.moonshot.ai/console/api-keys', prefix: 'moonshot/', defaultModel: 'moonshot/kimi-k3' },
  { label: 'Z.ai', description: 'GLM models, cheap subscription or pay per token', env: 'ZAI_API_KEY',
    url: 'https://z.ai/manage-apikey/apikey-list', prefix: 'zai/', defaultModel: 'zai/glm-5.1' },
  { label: 'Command Code', description: 'open + closed models at provider price, a few :free', env: 'COMMAND_CODE_API_KEY',
    url: 'https://commandcode.ai/studio', prefix: 'commandcode/', defaultModel: 'commandcode/deepseek/deepseek-v4.1-flash' },
  { label: 'Ollama (Local)', description: 'local models via Ollama (no API key needed)', env: 'OLLAMA_API_KEY',
    url: 'https://ollama.com', prefix: 'ollama/', defaultModel: 'ollama/qwen2.5-coder:latest',
    optionalKey: true, defaultBaseUrl: 'http://localhost:11434/v1' },
  { label: 'LM Studio (Local)', description: 'local models via LM Studio (no API key needed)', env: 'LMSTUDIO_API_KEY',
    url: 'https://lmstudio.ai', prefix: 'lmstudio/', defaultModel: 'lmstudio/local-model',
    optionalKey: true, defaultBaseUrl: 'http://localhost:1234/v1' },
  { label: 'Custom (OpenAI-compatible)', description: 'any OpenAI-compatible proxy or local server', env: 'CUSTOM_OPENAI_API_KEY',
    url: '', prefix: 'custom/', defaultModel: 'custom/default',
    optionalKey: true },
];

const ENVS = [...new Set(PROVIDERS.map((p) => p.env))];
const providerOf = (model) => PROVIDERS.find((p) => String(model || '').startsWith(p.prefix)) || null;
const groupLabel = (env) => PROVIDERS.filter((p) => p.env === env).map((p) => p.label).join(' / ');
const listSecret = (env) => `ompChat.keys.${env}`;
const activeState = (env) => `ompChat.activeKey.${env}`;
const newId = () => crypto.randomBytes(6).toString('hex');
const mask = (key) => (key.length > 10 ? `${key.slice(0, 5)}…${key.slice(-4)}` : '••••');

async function saveKeys(context, env, list) {
  await context.secrets.store(listSecret(env), JSON.stringify(list));
}

async function loadKeys(context, env) {
  let list = [];
  try { list = JSON.parse((await context.secrets.get(listSecret(env))) || '[]'); } catch {}
  if (!Array.isArray(list)) list = [];
  // Earlier versions kept one key per provider under its own secret: fold it into the list once.
  for (const p of PROVIDERS.filter((x) => x.env === env && x.legacySecret)) {
    const legacy = await context.secrets.get(p.legacySecret);
    if (!legacy) continue;
    if (!list.some((k) => k.key === legacy)) list.unshift({ id: newId(), label: `${p.label} key`, key: legacy });
    await saveKeys(context, env, list);
    await context.secrets.delete(p.legacySecret);
  }
  return list;
}

function activeKey(context, env, list) {
  const id = context.globalState?.get(activeState(env));
  return list.find((k) => k.id === id) || list[0] || null;
}

async function setActive(context, env, id) {
  await context.globalState?.update(activeState(env), id);
}

// baseUrl (optional) sends this key's requests to a proxy / compatible endpoint of `provider` (omp's provider id).
// usageUrl (optional) is that gateway's own usage endpoint, `{key}` standing for the key.
async function addKey(context, env, label, key, baseUrl, provider, usageUrl) {
  const list = await loadKeys(context, env);
  const k = { id: newId(), label, key, ...(baseUrl && { baseUrl, provider }), ...(usageUrl && { usageUrl }) };
  list.push(k);
  await saveKeys(context, env, list);
  await setActive(context, env, k.id);
  return k;
}

async function updateKeys(context, env, fn) {
  const list = fn(await loadKeys(context, env));
  await saveKeys(context, env, list);
  return list;
}

// The key after `currentId` that has not been tried yet in this rotation, or null when all are spent.
function nextKey(list, currentId, tried) {
  const i = list.findIndex((k) => k.id === currentId);
  for (let n = 1; n <= list.length; n++) {
    const k = list[(i + n + list.length) % list.length];
    if (k.id !== currentId && !tried.has(k.id)) return k;
  }
  return null;
}

// Active key per env var, for omp's environment.
async function envFor(context) {
  const env = {};
  for (const name of ENVS) {
    const k = activeKey(context, name, await loadKeys(context, name));
    if (k) env[name] = k.key;
  }
  return env;
}

// omp provider id -> base URL, from the active key of each env var that has one.
async function baseUrlsFor(context) {
  const urls = {};
  for (const name of ENVS) {
    const k = activeKey(context, name, await loadKeys(context, name));
    if (k?.baseUrl && k.provider) urls[k.provider] = k.baseUrl;
  }
  return urls;
}

// '' when empty, null when not an http(s) URL.
function normalizeBaseUrl(v) {
  const s = String(v || '').trim().replace(/\/+$/, '');
  if (!s) return '';
  try { return /^https?:$/.test(new URL(s).protocol) ? s : null; } catch { return null; }
}

// Out of quota / rate limited / out of credit, as opposed to a bad key or a network error.
const isQuotaError = (status, message) =>
  status === 429 || status === 402 || /rate.?limit|quota|usage limit|exceed|insufficient|credits?\b|too many requests/i.test(message || '');

// Any JSON as [name, value] rows (["quota.used", "12"]), for a usage endpoint whose shape is not known.
function flatten(o, pre = '', out = []) {
  if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) flatten(v, pre ? `${pre}.${k}` : k, out);
  else out.push([pre || 'value', String(o)]);
  return out;
}

// Command Code's { credits: {monthly|purchased|freeCredits, planId}, windowLimits: {fiveHour|weekly: {used, cap, resetAt, exceeded}} }
// in the shapes the panel already draws: OpenCode Go's plan windows and DeepSeek's balance line.
function commandCodeAccount(c) {
  const at = (t) => { const n = Number(t); return n > 0 ? new Date(n < 1e12 ? n * 1000 : n).toISOString() : t; }; // seconds or ms
  const win = (w) => (w && w.cap > 0 && Number.isFinite(w.used)
    ? { status: w.exceeded ? 'rate-limited' : 'ok', percent: Math.min(100, Math.round((w.used / w.cap) * 100)), resetsAt: at(w.resetAt) }
    : undefined);
  const wl = c?.windowLimits || {}, cr = c?.credits || {};
  const windows = { rolling: win(wl.fiveHour), weekly: win(wl.weekly) };
  const left = (+cr.monthlyCredits || 0) + (+cr.purchasedCredits || 0) + (+cr.freeCredits || 0);
  return {
    ...((windows.rolling || windows.weekly) && { windows }),
    balance_infos: [{ total_balance: +left.toFixed(2), currency: `credits${cr.planId ? ` (${cr.planId})` : ''}` }],
  };
}

// Account balance / limits straight from the provider, or from the key's own usage URL (a gateway's).
// Returns null when there is no such API.
async function fetchAccount(provider, key, sessionId, usageUrl, baseUrl) {
  if (!key) return null;
  const get = async (url, headers) => {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${key}`, ...headers }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) { // the server's own reason ("key not found", "no such route") tells a wrong URL from a wrong key
      const why = String(await r.text?.().catch(() => '') || '').replace(/\s+/g, ' ').trim().slice(0, 160);
      throw new Error(`${r.status} ${r.statusText}${why ? ' — ' + why : ''}`);
    }
    return r.json();
  };
  try {
    // ponytail: shown as raw name/value rows; parse a gateway's fields when one deserves a gauge.
    if (usageUrl) {
      const rows = flatten(await get(usageUrl.replaceAll('{key}', encodeURIComponent(key)), { 'x-api-key': key }))
        // nothing to show, or a key the gateway echoes back (apiKey, gatewayKey): never reaches the panel
        .filter(([n, v]) => v !== 'null' && v !== '' && !/key$/i.test(n) && !v.includes(key) && !/^sk-\S{12,}$/.test(v));
      // The first top-level "…Used" and "…Limit" numbers (tokensUsed / tokenLimit) make the bar.
      const top = (re) => rows.find(([n, v]) => !n.includes('.') && re.test(n) && Number.isFinite(+v))?.[1];
      const used = top(/used$/i), limit = top(/limit$/i);
      return { provider, custom: rows.slice(0, 40), ...(used != null && +limit > 0 && { gauge: { used: +used, limit: +limit } }) };
    }
    // A proxy/gateway base URL without a usage URL cannot be queried against the official provider's account API.
    if (baseUrl) return null;
    if (provider === 'openrouter') return { provider, ...(await get('https://openrouter.ai/api/v1/key')).data };
    if (provider === 'deepseek') return { provider, ...(await get('https://api.deepseek.com/user/balance')) };
    if (provider === 'opencode-go') {
      // { usage: { rolling|weekly|monthly: { status: "ok"|"rate-limited", percent: 0-100, resetsAt: ISO } } }
      // OpenCode wants a real client name and a stable session id on this endpoint.
      const r = await get('https://opencode.ai/zen/go/v1/usage', { 'User-Agent': 'omp-chat-vscode', 'x-opencode-session': sessionId || 'omp-chat' });
      return { provider, windows: r.usage };
    }
    if (provider === 'commandcode') {
      // Undocumented account routes the Command Code CLI (and omp) call with the same key; credits are per org.
      const data = (j) => (j?.data && typeof j.data === 'object' ? j.data : j);
      const orgId = data(await get('https://api.commandcode.ai/alpha/whoami'))?.org?.id;
      const c = data(await get(`https://api.commandcode.ai/alpha/billing/credits${orgId ? `?orgId=${encodeURIComponent(orgId)}` : ''}`));
      return { provider, ...commandCodeAccount(c) };
    }
  } catch (e) {
    return { provider, error: e.message };
  }
  return null;
}

// Quick connectivity / auth check for a saved or newly entered key (+ optional baseUrl / usageUrl).
const PROBE_URLS = {
  openrouter: 'https://openrouter.ai/api/v1/key',
  deepseek: 'https://api.deepseek.com/user/balance',
  anthropic: 'https://api.anthropic.com/v1/models',
  openai: 'https://api.openai.com/v1/models',
  google: 'https://generativelanguage.googleapis.com/v1beta/models',
  xai: 'https://api.x.ai/v1/models',
  mistral: 'https://api.mistral.ai/v1/models',
  groq: 'https://api.groq.com/openai/v1/models',
  moonshot: 'https://api.moonshot.ai/v1/models',
  commandcode: 'https://api.commandcode.ai/alpha/whoami', // its /models answers 200 to any key
  'opencode-go': 'https://opencode.ai/zen/go/v1/usage',
  'opencode-zen': 'https://opencode.ai/zen/v1/models',
  ollama: 'http://localhost:11434/v1/models',
  lmstudio: 'http://localhost:1234/v1/models',
};

async function testKey(provider, key, baseUrl, usageUrl, sessionId) {
  if (usageUrl) {
    const r = await fetchAccount(provider, key, sessionId, usageUrl, baseUrl);
    if (r?.error) return { ok: false, message: `Usage URL failed: ${r.error}` };
    const extra = r?.gauge ? ` (${Math.round((r.gauge.used / r.gauge.limit) * 100)}% used)` : '';
    return { ok: true, message: `Usage URL OK${extra}` };
  }
  const url = baseUrl ? `${baseUrl.replace(/\/+$/, '')}/models` : PROBE_URLS[provider];
  if (!url) return { ok: true, message: 'No test endpoint for this provider; key saved format looks valid.' };
  const headers = { Authorization: `Bearer ${key}`, 'x-api-key': key };
  if (provider === 'anthropic') headers['anthropic-version'] = '2023-06-01';
  if (provider === 'opencode-go') Object.assign(headers, { 'User-Agent': 'omp-chat-vscode', 'x-opencode-session': sessionId || 'omp-chat' });
  const target = provider === 'google' && !baseUrl ? `${url}?key=${encodeURIComponent(key)}` : url;
  try {
    const r = await fetch(target, { headers, signal: AbortSignal.timeout(8000) });
    if (!r.ok) {
      const why = String(await r.text?.().catch(() => '') || '').replace(/\s+/g, ' ').trim().slice(0, 140);
      return { ok: false, message: `${r.status} ${r.statusText}${why ? ' — ' + why : ''}` };
    }
    return { ok: true, message: `Connected (${r.status} OK)` };
  } catch (e) {
    return { ok: false, message: e.name === 'TimeoutError' ? 'Timed out after 8s' : e.message };
  }
}

module.exports = {
  PROVIDERS, ENVS, providerOf, groupLabel, mask,
  loadKeys, activeKey, setActive, addKey, updateKeys, nextKey, envFor, baseUrlsFor, normalizeBaseUrl, isQuotaError, fetchAccount, testKey, flatten,
};
