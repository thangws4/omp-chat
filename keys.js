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
async function addKey(context, env, label, key, baseUrl, provider) {
  const list = await loadKeys(context, env);
  const k = { id: newId(), label, key, ...(baseUrl && { baseUrl, provider }) };
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

// Account balance / limits straight from the provider. Returns null when the provider has no such API.
async function fetchAccount(provider, key, sessionId) {
  if (!key) return null;
  const get = async (url, headers) => {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${key}`, ...headers }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return r.json();
  };
  try {
    if (provider === 'openrouter') return { provider, ...(await get('https://openrouter.ai/api/v1/key')).data };
    if (provider === 'deepseek') return { provider, ...(await get('https://api.deepseek.com/user/balance')) };
    if (provider === 'opencode-go') {
      // { usage: { rolling|weekly|monthly: { status: "ok"|"rate-limited", percent: 0-100, resetsAt: ISO } } }
      // OpenCode wants a real client name and a stable session id on this endpoint.
      const r = await get('https://opencode.ai/zen/go/v1/usage', { 'User-Agent': 'omp-chat-vscode', 'x-opencode-session': sessionId || 'omp-chat' });
      return { provider, windows: r.usage };
    }
  } catch (e) {
    return { provider, error: e.message };
  }
  return null;
}

module.exports = {
  PROVIDERS, ENVS, providerOf, groupLabel, mask,
  loadKeys, activeKey, setActive, addKey, updateKeys, nextKey, envFor, baseUrlsFor, normalizeBaseUrl, isQuotaError, fetchAccount,
};
