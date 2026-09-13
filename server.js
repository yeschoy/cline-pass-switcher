// Cline Pass 上游观察/切换代理
// 零依赖，Node >= 18。
//
// 网关行为（实测结论，README 有证据）：
// - 订阅模型（cline-pass/*）与非 free 目录模型：请求体里的 provider.* 会被 Cline 网关丢弃，
//   由其规划器在系统凭证上游中自行挑选，响应元数据可回读实际上游。
// - 目录模型 :free 变体：provider.only 真正透传到 OpenRouter，可精确钉住。
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || __dirname;
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const META_PATH = path.join(DATA_DIR, 'metadata.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

const DEFAULT_CONFIG = {
  port: 3123,
  apiKey: '',
  proxyKey: '',
  publicBaseUrl: '',
  exposeCatalog: false,    // true 时 /v1/models 合并完整目录模型（默认仅订阅模型）
  upstreamBase: 'https://api.cline.bot/api/v1',
  accounts: [],            // { id, name, key, enabled, maxConcurrent, perModel } —— Cline Pass 账号池
  accountMode: 'single',   // single=手动指定 | roundrobin=轮询 | sticky=会话 HRW 粘性
  activeAccount: 0,        // single 模式下使用的账号下标
  concurrencyWaitMs: 2000,
  accountErrorRules: {},   // "429": { action: 'cooldown', cooldownMs: 1800000 } | { action: 'ban' } | { action: 'ignore' }
  knownModels: [
    'cline-pass/glm-5.3-flash',
    'cline-pass/kimi-k3',
    'cline-pass/deepseek-v4-flash',
    'cline-pass/deepseek-v4.1-flash',
    'cline-pass/qwen3.8-max',
    'cline-pass/minimax-m3',
    'cline-pass/glm-5.3',
    'cline-pass/glm-5.2',
    'cline-pass/deepseek-v4-pro',
    'cline-pass/mimo-v2.5-pro',
    'cline-pass/mimo-v2.5',
    'cline-pass/kimi-k2.6',
    'cline-pass/qwen3.7-plus',
    'cline-pass/kimi-k2.7-code',
    'cline-pass/qwen3.7-max',
  ],
  // modelId -> { upstream/upstreams/exclude/pinMode/sort/maxRetries }
  perModel: {},
};

function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e?.code === 'ENOENT') return fallback;
    throw new Error(`cannot read ${path.basename(file)}: ${e.message}`);
  }
}
function atomicWriteJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  let mode = 0o600;
  try { mode = fs.statSync(file).mode & 0o777; } catch (e) { if (e?.code !== 'ENOENT') throw e; }
  try {
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode });
    fs.renameSync(tmp, file);
  } finally {
    try { fs.unlinkSync(tmp); } catch (e) { if (e?.code !== 'ENOENT') throw e; }
  }
}
const config = { ...DEFAULT_CONFIG, ...loadJson(CONFIG_PATH, {}) };
const META = loadJson(META_PATH, { models: {}, history: [], catalog: null, orModelsFetchedAt: 0, orModelList: null });
const saveConfig = () => atomicWriteJson(CONFIG_PATH, config);
const saveMeta = () => atomicWriteJson(META_PATH, META);

function randomId(prefix = 'acc') {
  return `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
}
function envAccountId(key) {
  return `env_${crypto.createHmac('sha256', META.routingSecret).update(String(key)).digest('hex').slice(0, 24)}`;
}
const ROUTE_SORTS = new Set(['cost', 'ttft', 'tps']);
function normalizeStringList(v, max = 20) {
  return [...new Set((Array.isArray(v) ? v : []).map((s) => String(s).trim()).filter((s) => /^[a-z0-9][a-z0-9._/-]*$/i.test(s)))].slice(0, max);
}
function normalizeRouteConfig(c = {}) {
  const raw = c && typeof c === 'object' ? c : {};
  let upstreams = normalizeStringList(raw.upstreams !== undefined ? raw.upstreams : (raw.upstream ? [raw.upstream] : []), 20);
  const exclude = normalizeStringList(raw.exclude, 50);
  const excl = new Set(exclude);
  upstreams = upstreams.filter((u) => !excl.has(u));
  const maxRetries = raw.maxRetries === null || raw.maxRetries === undefined || raw.maxRetries === ''
    ? null
    : Math.min(20, Math.max(0, Math.floor(Number(raw.maxRetries) || 0)));
  return {
    upstream: upstreams[0] || null,
    upstreams,
    exclude,
    pinMode: raw.pinMode === 'preferred' ? 'preferred' : 'strict',
    sort: ROUTE_SORTS.has(raw.sort) ? raw.sort : null,
    maxRetries,
  };
}
function normalizePerModelMap(map = {}) {
  const out = {};
  if (!map || typeof map !== 'object') return out;
  for (const [model, c] of Object.entries(map)) {
    const m = String(model || '').trim();
    if (!m) continue;
    out[m] = normalizeRouteConfig(c);
  }
  return out;
}
function validatePerModelInput(map) {
  if (map === undefined) return null;
  if (!map || typeof map !== 'object' || Array.isArray(map)) return 'perModel must be an object';
  for (const [model, c] of Object.entries(map)) {
    const modelId = String(model).trim();
    if (!modelId || modelId.length > 300 || /[\x00-\x1f\x7f]/.test(modelId) || !c || typeof c !== 'object' || Array.isArray(c)) return `invalid route for model ${model}`;
    if (c.upstream !== undefined && c.upstream !== null && c.upstream !== '' && !/^[a-z0-9][a-z0-9._/-]{0,199}$/i.test(String(c.upstream).trim())) return `invalid upstream for ${model}`;
    for (const field of ['upstreams', 'exclude']) {
      if (c[field] !== undefined && !Array.isArray(c[field])) return `${field} must be an array for ${model}`;
      if ((c[field] || []).length > (field === 'upstreams' ? 20 : 50) || (c[field] || []).some((v) => !/^[a-z0-9][a-z0-9._/-]{0,199}$/i.test(String(v).trim()))) return `invalid ${field} entry for ${model}`;
    }
    if (c.pinMode !== undefined && !['strict', 'preferred'].includes(c.pinMode)) return `invalid pinMode for ${model}`;
    if (c.sort !== undefined && c.sort !== null && c.sort !== '' && !ROUTE_SORTS.has(c.sort)) return `invalid sort for ${model}`;
    if (c.maxRetries !== undefined && c.maxRetries !== null && (!Number.isInteger(Number(c.maxRetries)) || Number(c.maxRetries) < 0 || Number(c.maxRetries) > 20)) return `invalid maxRetries for ${model}`;
  }
  return null;
}
function normalizeAccountErrorRules(rules = {}) {
  const out = {};
  if (!rules || typeof rules !== 'object') return out;
  for (const [code, rule] of Object.entries(rules)) {
    const status = String(Math.floor(Number(code))).trim();
    const n = Number(status);
    if (!Number.isInteger(n) || n < 100 || n > 599 || !rule || typeof rule !== 'object') continue;
    const action = ['ignore', 'cooldown', 'ban'].includes(rule.action) ? rule.action : null;
    if (!action) continue;
    if (action === 'cooldown') {
      const cooldownMs = Math.min(30 * 24 * 3600e3, Math.max(1, Math.floor(Number(rule.cooldownMs) || 0)));
      if (!cooldownMs) continue;
      out[status] = { action, cooldownMs };
    } else out[status] = { action };
  }
  return out;
}
function normalizeAccount(a, i, prevById = new Map(), prevByName = new Map()) {
  const suppliedId = String(a?.id || '').trim();
  const id = (/^[A-Za-z0-9_-]{1,100}$/.test(suppliedId) ? suppliedId : '') || prevByName.get(String(a?.name || '').slice(0, 50))?.id || randomId();
  const previous = prevById.get(id) || {};
  return {
    id,
    name: String(a?.name || previous.name || `账号${i + 1}`).slice(0, 50),
    key: String(a?.key || '').trim(),
    enabled: a?.enabled !== false,
    maxConcurrent: Math.max(0, Math.floor(Number(a?.maxConcurrent) || 0)),
    perModel: normalizePerModelMap(a?.perModel || {}),
  };
}
function validateAccountErrorRulesInput(rules = {}) {
  if (!rules || typeof rules !== 'object' || Array.isArray(rules)) return 'accountErrorRules must be an object';
  for (const [code, rule] of Object.entries(rules)) {
    const n = Number(code);
    if (!Number.isInteger(n) || n < 100 || n > 599) return `invalid status code: ${code}`;
    if (!rule || typeof rule !== 'object' || !['ignore', 'cooldown', 'ban'].includes(rule.action)) return `invalid action for ${code}`;
    if (rule.action === 'cooldown' && (!Number.isFinite(Number(rule.cooldownMs)) || Number(rule.cooldownMs) <= 0)) return `invalid cooldownMs for ${code}`;
  }
  return null;
}
function normalizeConfigAndMeta({ persist = false } = {}) {
  let dirty = false;
  if ((!Array.isArray(config.accounts) || config.accounts.length === 0) && config.apiKey) {
    config.accounts = [{ name: '默认账号', key: config.apiKey, enabled: true }];
    config.accountMode = 'single';
    config.activeAccount = 0;
    dirty = true;
  }
  if (!['single', 'roundrobin', 'sticky'].includes(config.accountMode)) { config.accountMode = config.accountMode === 'roundrobin' ? 'roundrobin' : 'single'; dirty = true; }
  const wait = Math.floor(Number(config.concurrencyWaitMs));
  if (!Number.isFinite(wait) || wait < 0 || wait > 30000) { config.concurrencyWaitMs = 2000; dirty = true; }
  else if (config.concurrencyWaitMs !== wait) { config.concurrencyWaitMs = wait; dirty = true; }
  const pm = normalizePerModelMap(config.perModel || {});
  if (JSON.stringify(pm) !== JSON.stringify(config.perModel || {})) { config.perModel = pm; dirty = true; }
  const rules = normalizeAccountErrorRules(config.accountErrorRules || {});
  if (JSON.stringify(rules) !== JSON.stringify(config.accountErrorRules || {})) { config.accountErrorRules = rules; dirty = true; }
  const old = Array.isArray(config.accounts) ? config.accounts : [];
  const byId = new Map(old.filter((a) => a?.id).map((a) => [String(a.id), a]));
  const byName = new Map(old.filter((a) => a?.name).map((a) => [String(a.name).slice(0, 50), a]));
  const accs = old.map((a, i) => normalizeAccount(a, i, byId, byName)).filter((a) => a.key);
  if (JSON.stringify(accs) !== JSON.stringify(old)) { config.accounts = accs; dirty = true; }
  const activeAccount = Math.floor(Math.min(Math.max(0, Number(config.activeAccount) || 0), Math.max(0, config.accounts.length - 1)));
  if (config.activeAccount !== activeAccount) { config.activeAccount = activeAccount; dirty = true; }
  META.models ||= {}; META.history ||= []; META.stats ||= {}; META.accountStates ||= {};
  if (!META.routingSecret || typeof META.routingSecret !== 'string') { META.routingSecret = crypto.randomBytes(32).toString('hex'); dirty = true; }
  const ids = new Set((config.accounts || []).map((a) => a.id));
  const envKey = String(process.env.CLINE_PASS_KEY || '').trim();
  if (envKey) ids.add(envAccountId(envKey));
  for (const id of Object.keys(META.accountStates)) if (!ids.has(id)) { delete META.accountStates[id]; dirty = true; }
  if (dirty && persist) { saveConfig(); saveMeta(); }
}
normalizeConfigAndMeta({ persist: true });

// 环境变量覆盖（便于 Docker 部署）。注意：此后若通过控制台保存设置，当前生效值会写回 config.json
if (process.env.CLINE_PASS_KEY) {
  const k = process.env.CLINE_PASS_KEY.trim();
  if (k && !(config.accounts || []).some((a) => a.key === k)) {
    config.accounts = [normalizeAccount({ id: envAccountId(k), name: 'env-account', key: k, enabled: true }, 0), ...(config.accounts || [])];
  }
}
if (process.env.PROXY_KEY && process.env.PROXY_KEY.trim()) config.proxyKey = process.env.PROXY_KEY.trim();
if (process.env.PUBLIC_BASE_URL) config.publicBaseUrl = process.env.PUBLIC_BASE_URL.trim();
if (process.env.PORT) config.port = Number(process.env.PORT) || config.port;

function isConfigured() {
  return !!config.apiKey || enabledAccounts().length > 0;
}
if (!isConfigured()) {
  console.warn('[提示] 尚未配置上游 API Key：打开控制台「账号管理」添加账号并保存即可；服务已启动。');
}

let RR_COUNTER = 0;
const activeCounts = new Map();
const waiters = new Set();
function notifyCapacityWaiters() { for (const resolve of [...waiters]) resolve(); }
function getAccountState(id) { return (META.accountStates ||= {})[id] || null; }
function safeReason(s) { return redactSecrets(String(s || '').replace(/[\r\n\t]+/g, ' ').slice(0, 200)); }
function clearExpiredCooldowns() {
  let dirty = false;
  const now = Date.now();
  for (const [id, st] of Object.entries(META.accountStates || {})) {
    if (st && !st.banned && st.cooldownUntil && st.cooldownUntil <= now) {
      delete META.accountStates[id]; dirty = true;
    }
  }
  if (dirty) saveMeta();
}
function enabledAccounts({ excludeIds = new Set() } = {}) {
  clearExpiredCooldowns();
  return (config.accounts || []).filter((a) => {
    if (!a || !a.key || a.enabled === false || excludeIds.has(a.id)) return false;
    const st = getAccountState(a.id);
    if (st?.banned) return false;
    if (st?.cooldownUntil && st.cooldownUntil > Date.now()) return false;
    return true;
  });
}
function accountHasCapacity(a) {
  return !a?.maxConcurrent || (activeCounts.get(a.id) || 0) < a.maxConcurrent;
}
function tryLease(a) {
  if (!a || !accountHasCapacity(a)) return null;
  activeCounts.set(a.id, (activeCounts.get(a.id) || 0) + 1);
  let released = false;
  return {
    account: a,
    release() {
      if (released) return;
      released = true;
      activeCounts.set(a.id, Math.max(0, (activeCounts.get(a.id) || 1) - 1));
      notifyCapacityWaiters();
    },
  };
}
async function waitForCapacity(ms) {
  if (ms <= 0) return;
  let wake;
  let timer;
  const capacity = new Promise((resolve) => { wake = resolve; waiters.add(resolve); });
  const timeout = new Promise((resolve) => { timer = setTimeout(resolve, ms); });
  try { await Promise.race([timeout, capacity]); }
  finally { clearTimeout(timer); waiters.delete(wake); }
}
async function waitForLease(accounts, waitMs) {
  const deadline = Date.now() + waitMs;
  while (true) {
    for (const account of accounts) {
      const lease = tryLease(account);
      if (lease) return lease;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return null;
    await waitForCapacity(remaining);
  }
}
function hmacHex(value) { return crypto.createHmac('sha256', META.routingSecret).update(String(value)).digest('hex'); }
function hrwRank(accounts, fingerprint) {
  return [...accounts].sort((a, b) => Buffer.compare(Buffer.from(hmacHex(`${fingerprint}\0${b.id}`), 'hex'), Buffer.from(hmacHex(`${fingerprint}\0${a.id}`), 'hex')));
}
function singlePreferred(list) {
  const byIdx = config.accounts[config.activeAccount];
  if (byIdx && list.some((a) => a.id === byIdx.id)) return byIdx;
  return list[0] || null;
}
function rrRank(list) {
  if (!list.length) return [];
  const start = RR_COUNTER++ % list.length;
  return [...list.slice(start), ...list.slice(0, start)];
}
async function acquireAccountLease(identity, { excludeIds = new Set(), allowOverflow = true } = {}) {
  const waitMs = Math.min(30000, Math.max(0, Number(config.concurrencyWaitMs) || 0));
  const list = enabledAccounts({ excludeIds });
  if (!list.length) return { error: 'no available upstream account' };
  const mode = config.accountMode;
  if (mode === 'sticky' && identity?.fingerprint) {
    const ranked = hrwRank(list, identity.fingerprint);
    const primary = ranked[0];
    let lease = tryLease(primary);
    if (lease) return { lease, overflow: false, source: identity.source };
    lease = await waitForLease([primary], waitMs);
    if (lease) return { lease, overflow: false, source: identity.source };
    if (allowOverflow) {
      lease = await waitForLease(ranked.slice(1), 0);
      if (lease) return { lease, overflow: true, source: identity.source };
    }
    return { error: 'all upstream accounts are busy', retryAfter: retryAfterSeconds(waitMs) };
  }
  if (mode === 'roundrobin' || (mode === 'sticky' && !identity?.fingerprint)) {
    const ranked = rrRank(list);
    const lease = await waitForLease(ranked, waitMs);
    if (lease) return { lease, source: identity?.source || 'roundrobin' };
    return { error: 'all upstream accounts are busy', retryAfter: retryAfterSeconds(waitMs) };
  }
  const preferred = singlePreferred(list);
  const lease = await waitForLease([preferred], waitMs);
  if (lease) return { lease, source: 'single' };
  return { error: 'upstream account is busy', retryAfter: retryAfterSeconds(waitMs) };
}
function retryAfterSeconds(waitMs) { return Math.min(30, Math.max(1, Math.ceil((Number(waitMs) || 1000) / 1000))); }
function pickAccount() {
  const list = enabledAccounts();
  if (!list.length) return { name: '默认', key: config.apiKey || '', id: 'legacy', maxConcurrent: 0, perModel: {} };
  if (config.accountMode === 'roundrobin' && list.length > 1) return rrRank(list)[0];
  return singlePreferred(list);
}
const chatHeaders = (key) => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${key}`,
});

// 代理密钥：非空时，/v1/* 与 /api/* 均需鉴权（Authorization: Bearer <key> 或 X-Admin-Key: <key>）；
// 控制台页面本身保持开放（不含任何敏感数据，数据由带鉴权的 /api/* 提供）。
// 可通过 POST /api/security 在运行期修改（下游密钥 = 客户端访问代理的凭据）。
let PROXY_KEY = config.proxyKey || '';
function authOK(req) {
  if (!PROXY_KEY) return true;
  const bearer = String(req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim();
  const admin = String(req.headers['x-admin-key'] || '').trim();
  return bearer === PROXY_KEY || admin === PROXY_KEY;
}
function unauthorized(res) {
  return sendJSON(res, 401, { error: { message: 'unauthorized: 代理密钥缺失或错误', type: 'auth_error' } });
}
function publicProxyBase() {
  return config.publicBaseUrl
    ? `${config.publicBaseUrl.replace(/\/+$/, '')}/v1`
    : `http://127.0.0.1:${config.port}/v1`;
}

const OR_API = 'https://openrouter.ai/api/v1';

async function fetchJSON(url, opts = {}, timeoutMs = 60000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }
    return { status: res.status, json };
  } finally {
    clearTimeout(t);
  }
}

// ---------- OpenRouter 目录缓存与 slug 归一化 ----------
async function orModelList() {
  if (META.orModelList && Date.now() - META.orModelsFetchedAt < 6 * 3600e3) return META.orModelList;
  const { json } = await fetchJSON(`${OR_API}/models`);
  const ids = (json?.data || []).map((m) => m.id);
  if (ids.length) {
    META.orModelList = ids;
    META.orModelsFetchedAt = Date.now();
    saveMeta();
  }
  return ids;
}
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

async function orEndpoints(slug) {
  // canonicalSlug 与 OpenRouter 目录 id 可能存在连字符差异（zai/... vs z-ai/...），先精确后归一匹配
  const ids = await orModelList();
  let real = ids.find((id) => id === slug) || ids.find((id) => norm(id) === norm(slug));
  if (!real) return { slug, endpoints: [] };
  const { json } = await fetchJSON(`${OR_API}/models/${real}/endpoints`);
  const eps = json?.data?.endpoints || [];
  const detail = {};
  for (const e of eps) {
    const pSlug = String(e.tag || '').split('/')[0] || (e.provider_name || '').toLowerCase().replace(/\s+/g, '-');
    const d = (detail[pSlug] ||= { slug: pSlug, name: e.provider_name, endpoints: 0, context: 0, uptime: 0 });
    d.endpoints++;
    d.context = Math.max(d.context, e.context_length || 0);
    d.uptime = Math.max(d.uptime, Math.round(e.uptime_last_30m || 0));
  }
  return { slug: real, endpoints: Object.values(detail) };
}

// ---------- 探测单个模型 ----------
// 两条管道（实测）：
// - planner：响应带 provider_metadata.gateway.routing（canonicalSlug/finalProvider/fallbacksAvailable），
//   请求体 provider.* 被网关丢弃。
// - direct：响应顶层带 provider（显示名）与 model（真实 OpenRouter ID），provider.only 会透传到
//   OpenRouter，可精确钉住。
function slugify(s) { return String(s).toLowerCase().replace(/\s+/g, '-'); }

function parseRouting(json) {
  const d = json?.data && json.data.choices ? json.data : json;
  const msg = d?.choices?.[0]?.message;
  const rt = msg?.provider_metadata?.gateway?.routing || d?.provider_metadata?.gateway?.routing || {};
  const direct = typeof d?.provider === 'string' ? d.provider : null;
  return {
    content: msg?.content ?? null,
    usage: d?.usage || null,
    pipeline: rt.finalProvider ? 'planner' : direct ? 'direct' : null,
    canonicalSlug: rt.canonicalSlug || (typeof d?.model === 'string' && d.model.includes('/') ? d.model : null),
    finalProvider: rt.finalProvider || (direct ? slugify(direct) : null),
    finalProviderName: rt.finalProvider || direct,
    fallbacks: rt.fallbacksAvailable || [],
    plan: rt.planningReasoning || '',
  };
}

// 故意携带不存在的 only，让网关在路由层报错并列出可用上游（不产生 token 消耗）。
// - 直连管道（OpenRouter）：provider.only → 404 错误 JSON 里的 metadata.available_providers
// - 规划器管道（Vercel AI Gateway）：providerOptions.gateway.only → 400 错误文本里的 "Available providers are: ..."
async function harvestAvailableProviders(modelId, pipeline) {
  const acc = pickAccount();
  const base = { model: modelId, messages: [{ role: 'user', content: 'hi' }], max_tokens: 16 };
  const body = pipeline === 'planner'
    ? { ...base, providerOptions: { gateway: { only: ['__probe__'] } } }
    : { ...base, provider: { only: ['__probe__'] } };
  const { json } = await fetchJSON(`${config.upstreamBase}/chat/completions`, { method: 'POST', headers: chatHeaders(acc.key), body: JSON.stringify(body) }, 60000);
  const err = json?.error;
  if (typeof err !== 'string') return null;
  if (pipeline === 'planner') {
    const m = /Available providers are:\s*([^.]+)/.exec(err);
    if (!m) return null;
    // 错误文本里可能混有 JSON 片段（如 ","type":"invalid_request_error"），必须按 slug 格式过滤
    const toks = m[1].split(/,\s*/).map((s) => s.trim()).filter((t) => /^[a-z0-9][a-z0-9-]*$/.test(t));
    return toks.length ? toks : null;
  }
  const i = err.indexOf('{');
  if (i < 0) return null;
  try {
    return JSON.parse(err.slice(i))?.error?.metadata?.available_providers || null;
  } catch { return null; }
}
function parseTier0(plan) {
  const m = /([\w-]+) won tier 0 over ([^."]+)/.exec(plan || '');
  if (!m) return [];
  return [...new Set([m[1], ...m[2].split(/,\s*|\s+and\s+/).map((s) => s.trim()).filter(Boolean)])];
}

async function probeModel(modelId) {
  const acc = pickAccount();
  const t0 = Date.now();
  const body = { model: modelId, messages: [{ role: 'user', content: 'Reply with the word OK' }], max_tokens: 256 };
  const { json } = await fetchJSON(`${config.upstreamBase}/chat/completions`, {
    method: 'POST',
    headers: chatHeaders(acc.key),
    body: JSON.stringify(body),
  }, 180000);
  const ms = Date.now() - t0;
  if (json?.error && !json?.data) {
    return { ok: false, error: safeReason(typeof json.error === 'string' ? json.error : JSON.stringify(json.error)) };
  }
  const r = parseRouting(json);
  let harvest = null;
  if (r.pipeline) harvest = await harvestAvailableProviders(modelId, r.pipeline);
  let endpoints = [];
  let orSlug = null;
  if (r.pipeline !== 'planner' && r.canonicalSlug) {
    // 规划器管道的钉住发生在 Vercel 侧，OpenRouter 的 endpoint 明细仅对直连管道有参考意义
    try {
      const res = await orEndpoints(r.canonicalSlug);
      endpoints = res.endpoints;
      orSlug = res.slug;
    } catch { /* 公开接口失败不影响探测结果 */ }
  }
  const prev = META.models[modelId] || {};
  const detail = { ...prev.upstreamDetail };
  for (const e of endpoints) detail[e.slug] = e;
  const upstreams = r.pipeline === 'planner'
    ? [...new Set([...(harvest || []), ...r.fallbacks])]
    : [...new Set([...r.fallbacks, ...(harvest || []), ...Object.keys(detail)])];
  const tier0 = [...new Set([...(prev.tier0 || []), ...parseTier0(r.plan)])];
  META.models[modelId] = {
    ...prev,
    ok: true,
    pipeline: r.pipeline,
    pinnable: !!r.pipeline,
    availableProviders: harvest || prev.availableProviders || [],
    canonicalSlug: r.canonicalSlug,
    openrouterSlug: orSlug,
    upstreamDetail: detail,
    upstreams,
    tier0,
    lastProvider: r.finalProvider || prev.lastProvider,
    lastMs: ms,
    probedAt: Date.now(),
  };
  saveMeta();
  return { ok: true, ms, ...META.models[modelId] };
}

// 上游渠道可用性分类：渠道被单独钉住时的真实状态
function classifyUpstreamError(msg) {
  const m = String(msg || '');
  if (/empty response content/i.test(m)) return 'ok';                     // 请求已到达模型（推理耗尽 max_tokens 导致内容为空）
  if (/429|rate-?limited|temporarily rate/i.test(m)) return 'limited';   // 渠道有效，共享池限流中
  if (/invalid_request|modelid|no allowed providers|no available providers|not found|unsupported/i.test(m)) return 'bad'; // 不可钉住
  if (/unauthorized|re-authenticate|401/i.test(m)) return 'auth';        // 账号 key 问题，与渠道无关
  return 'unknown';
}
// 钉住请求失败时自动学习该渠道状态（仅确定性失败，瞬时限流标 limited 不拉黑）
function learnUpstreamStatus(modelId, upstream, errMsg) {
  if (!upstream || !errMsg) return;
  const st = classifyUpstreamError(errMsg);
  if (st === 'unknown') return;
  const meta = (META.models[modelId] ||= {});
  meta.upstreamStatus = { ...(meta.upstreamStatus || {}), [upstream]: { status: st, note: String(errMsg).slice(0, 160), checkedAt: Date.now() } };
}

// 自动+排除模式：only 白名单与网关侧渠道清单不一致时，网关报错会附最新清单，合并学习
// （触发场景：探测缓存过期，网关侧新增了渠道而本地 known 列表没有——白名单漏掉新渠道）
function learnAvailableProviders(modelId, errMsg) {
  const m = /Available providers are:\s*([^.]+)/.exec(String(errMsg || ''));
  if (!m) return;
  const toks = m[1].split(/,\s*/).map((s) => s.trim()).filter((t) => /^[a-z0-9][a-z0-9-]*$/.test(t));
  if (!toks.length) return;
  const meta = (META.models[modelId] ||= {});
  const before = (meta.upstreams || []).length;
  meta.upstreams = [...new Set([...(meta.upstreams || []), ...toks])];
  if (meta.upstreams.length !== before) saveMeta();
}

// 批量校验：把模型的每个上游渠道用最小请求各钉一次，标记真实可用性
async function validateUpstreams(modelId) {
  const meta = META.models[modelId] || {};
  const list = meta.upstreams || [];
  const pipeline = meta.pipeline;
  const acc = pickAccount();
  const results = {};
  const batch = 5;
  for (let i = 0; i < list.length; i += batch) {
    await Promise.all(list.slice(i, i + batch).map(async (slug) => {
      const t0 = Date.now();
      const base = { model: modelId, messages: [{ role: 'user', content: 'hi' }], max_tokens: 16 };
      const body = pipeline === 'planner'
        ? { ...base, providerOptions: { gateway: { only: [slug] } } }
        : { ...base, provider: { only: [slug] } };
      const { json } = await fetchJSON(`${config.upstreamBase}/chat/completions`, {
        method: 'POST', headers: chatHeaders(acc.key), body: JSON.stringify(body),
      }, 60000).catch(() => ({ json: { error: 'network error' } }));
      let status = 'unknown';
      let note = '';
      if (json?.error && !json?.data) {
        const msg = typeof json.error === 'string' ? json.error : JSON.stringify(json.error);
        status = classifyUpstreamError(msg);
        note = safeReason(msg);
      } else if (json?.data?.choices || json?.choices) {
        status = 'ok';
      }
      results[slug] = { status, ms: Date.now() - t0, note };
    }));
  }
  META.models[modelId] = { ...meta, upstreamStatus: { ...(meta.upstreamStatus || {}), ...results }, validatedAt: Date.now() };
  saveMeta();
  return results;
}

// 从官方接口、官方文档与社区注册表拉取最新 ClinePass 订阅模型清单（只增不删）
async function fetchOfficialModels() {
  const found = new Set();
  const sources = [];
  const addModel = (value) => {
    const id = typeof value === 'string' ? value : value?.id;
    if (typeof id !== 'string') return;
    const normalized = id.trim().toLowerCase();
    if (normalized.startsWith('cline-pass/')) found.add(normalized);
  };
  // 官方推荐模型接口：Cline 自己用来列出订阅模型，权威且更新最快（无需鉴权）
  try {
    const { json } = await fetchJSON('https://api.cline.bot/api/v1/ai/cline/recommended-models', {}, 30000);
    const list = json?.clinePass || json?.data?.clinePass;
    if (Array.isArray(list) && list.length) {
      list.forEach(addModel);
      sources.push('cline.api');
    }
  } catch { /* 来源不可用则跳过 */ }
  // 社区注册表 models.dev：历史响应包在 providers 下，新响应直接以 provider id 为顶层键
  try {
    const { json } = await fetchJSON('https://models.dev/api.json', {}, 30000);
    const cp = json?.providers?.['cline-pass'] || json?.['cline-pass'];
    if (cp?.models) {
      Object.keys(cp.models).forEach((id) => addModel(id.startsWith('cline-pass/') ? id : `cline-pass/${id}`));
      sources.push('models.dev');
    }
  } catch { /* 来源不可用则跳过 */ }
  // 官方文档表格兜底
  try {
    const res = await fetch('https://docs.cline.bot/getting-started/clinepass', { signal: AbortSignal.timeout(30000) });
    const text = await res.text();
    const ids = text.match(/cline-pass\/[a-z0-9._-]+/gi) || [];
    if (ids.length) { ids.forEach((id) => found.add(id.toLowerCase())); sources.push('docs.cline.bot'); }
  } catch { /* 来源不可用则跳过 */ }
  const valid = [...found].filter((id) => /^cline-pass\/[a-z0-9._-]+$/.test(id));
  const added = valid.filter((id) => !config.knownModels.includes(id));
  if (added.length) {
    config.knownModels.push(...added);
    saveConfig();
  }
  META.officialModelsFetch = { ts: Date.now(), sources, found: valid.length, added, total: config.knownModels.length };
  saveMeta();
  return { sources, found: valid.length, added, knownModels: config.knownModels, ...META.officialModelsFetch };
}

function record(modelId, info) {
  META.models[modelId] = { ...(META.models[modelId] || {}), ...info };
  META.history.unshift({ ts: Date.now(), model: modelId, ...info });
  if (META.history.length > 100) META.history.length = 100;
  if (info.account) {
    META.stats = META.stats || {};
    const st = (META.stats[info.account] ||= { requests: 0, lastUsed: 0, lastError: null });
    st.requests += 1;
    st.lastUsed = Date.now();
    st.lastError = info.error || null;
  }
  saveMeta();
}


const NEVER_FORWARD_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie', 'host', 'content-length', 'connection', 'transfer-encoding', 'upgrade', 'keep-alive', 'te', 'trailer', 'x-codex-installation-id', 'x-oai-attestation']);
const CODEX_HEADERS = ['Originator','Session_id','Thread_id','Session-Id','Thread-Id','X-Client-Request-Id','User-Agent','X-Codex-Beta-Features','X-Codex-Turn-State','X-Codex-Turn-Metadata','X-Codex-Window-Id','X-Codex-Parent-Thread-Id','X-OpenAI-Subagent','X-OpenAI-Memgen-Request','X-ResponsesAPI-Include-Timing-Metrics','X-OpenAI-Internal-Codex-Responses-Lite'];
const CLAUDE_HEADERS = ['X-Claude-Code-Session-Id','X-Claude-Code-Agent-Id','X-Claude-Code-Parent-Agent-Id','X-Stainless-Arch','X-Stainless-Lang','X-Stainless-Os','X-Stainless-Package-Version','X-Stainless-Retry-Count','X-Stainless-Runtime','X-Stainless-Runtime-Version','X-Stainless-Timeout','User-Agent','X-App','Anthropic-Beta','Anthropic-Dangerous-Direct-Browser-Access','Anthropic-Version'];
const GENERIC_HEADERS = ['Session-Id','Session_id','Thread-Id','Thread_id','X-Http-Session-Id','X-Session-ID','X-Session-Affinity','X-Slot-Session-Id','X-Conversation-Id','X-Thread-Id','X-Parent-Session-ID','X-Parent-Session-Affinity','User-Agent','X-Client-Request-Id','HTTP-Referer','X-Title'];
function reqHeader(req, name) {
  const v = req.headers[String(name).toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}
function safeHeaderValue(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s || s.length > 2048 || /[\x00-\x1f\x7f]/.test(s)) return null;
  return s;
}
function copyAllowedHeaders(req, names) {
  const out = {};
  for (const name of names) {
    const low = name.toLowerCase();
    if (NEVER_FORWARD_HEADERS.has(low)) continue;
    const v = safeHeaderValue(reqHeader(req, name));
    if (v != null) out[name] = v;
  }
  return out;
}
function safeJsonParse(s, limit = 4096) {
  const v = safeHeaderValue(s);
  if (!v || v.length > limit) return null;
  try { return JSON.parse(v); } catch { return null; }
}
function validIdentityValue(v) {
  const s = safeHeaderValue(v);
  return s && s.length <= 512 ? s : null;
}
function firstBodyValue(body, paths) {
  for (const path of paths) {
    let cur = body;
    for (const part of path.split('.')) cur = cur && typeof cur === 'object' ? cur[part] : undefined;
    const v = validIdentityValue(cur);
    if (v) return v;
  }
  return null;
}
function userIdSessionValue(v, parent = false) {
  const s = validIdentityValue(v);
  if (!s) return null;
  if (s.trim().startsWith('{')) {
    const j = safeJsonParse(s);
    if (j && typeof j === 'object') {
      const keys = parent ? ['parent_session_id','parent_agent_id','parent_thread_id','parent_conversation_id'] : ['session_id','agent_id','thread_id','conversation_id','claude_session_id'];
      for (const k of keys) { const vv = validIdentityValue(j[k]); if (vv) return vv; }
    }
  }
  if (!parent && /^claude[-_:]/i.test(s)) return s;
  return null;
}
function hmacIdentity(source, value) {
  // Equal trusted parent/current identifiers must route together even when one
  // side is carried by a protocol-specific header and the other by a generic one.
  return { source, fingerprint: hmacHex(`session\0${value}`) };
}
function detectClientProtocol(req, body = {}) {
  if (body.prompt_cache_key || reqHeader(req, 'X-Codex-Turn-Metadata') || reqHeader(req, 'Originator') || reqHeader(req, 'X-Codex-Parent-Thread-Id')) return 'codex';
  if (body.metadata?.user_id || reqHeader(req, 'X-Claude-Code-Session-Id') || reqHeader(req, 'X-Claude-Code-Agent-Id') || reqHeader(req, 'X-Claude-Code-Parent-Agent-Id') || reqHeader(req, 'Anthropic-Version')) return 'claude';
  return 'generic';
}
function firstIdentity(candidates) {
  for (const [source, value] of candidates) {
    const valid = validIdentityValue(value);
    if (valid) return hmacIdentity(source, valid);
  }
  return null;
}
function extractSessionIdentity(req, body) {
  const protocol = detectClientProtocol(req, body);
  const turnMeta = protocol === 'codex' ? (safeJsonParse(reqHeader(req, 'X-Codex-Turn-Metadata')) || {}) : {};
  let identity = null;
  if (protocol === 'codex') {
    identity = firstIdentity([
      ['codex_parent', reqHeader(req, 'X-Codex-Parent-Thread-Id')],
      ['codex_parent', turnMeta.parent_thread_id || turnMeta.parent_session_id || turnMeta.parent_conversation_id],
      ['codex_body', body?.prompt_cache_key],
      ['codex_header', reqHeader(req, 'Session-Id') || reqHeader(req, 'Session_id')],
      ['codex_header', reqHeader(req, 'Thread-Id') || reqHeader(req, 'Thread_id')],
      ['codex_metadata', turnMeta.thread_id || turnMeta.session_id || turnMeta.conversation_id],
    ]);
  } else if (protocol === 'claude') {
    identity = firstIdentity([
      ['claude_parent', reqHeader(req, 'X-Claude-Code-Parent-Agent-Id')],
      ['claude_parent', userIdSessionValue(body?.metadata?.user_id, true)],
      ['claude_header', reqHeader(req, 'X-Claude-Code-Session-Id')],
      ['claude_header', reqHeader(req, 'X-Claude-Code-Agent-Id')],
      ['claude_metadata', userIdSessionValue(body?.metadata?.user_id, false)],
    ]);
  }
  identity ||= firstIdentity([
    ['generic_parent', reqHeader(req, 'X-Parent-Session-ID') || reqHeader(req, 'X-Parent-Session-Affinity')],
    ['generic_body', firstBodyValue(body, ['session_id','conversation_id','thread_id','metadata.session_id','metadata.conversation_id','metadata.thread_id'])],
    ['generic_header', reqHeader(req, 'Session-Id') || reqHeader(req, 'Session_id') || reqHeader(req, 'Thread-Id') || reqHeader(req, 'Thread_id') || reqHeader(req, 'X-Http-Session-Id') || reqHeader(req, 'X-Session-ID') || reqHeader(req, 'X-Session-Affinity') || reqHeader(req, 'X-Slot-Session-Id') || reqHeader(req, 'X-Conversation-Id') || reqHeader(req, 'X-Thread-Id')],
  ]);
  if (identity) return identity;
  const msgs = Array.isArray(body?.messages) ? body.messages : [];
  const sys = msgs.find((m) => m && (m.role === 'system' || m.role === 'developer'));
  const user = msgs.find((m) => m && m.role === 'user');
  if (sys || user) {
    const sysContent = sys ? stableMsgContent(sys.content) : '';
    const userContent = user ? stableMsgContent(user.content) : '';
    if (sysContent || userContent) {
      const stable = JSON.stringify([sysContent ? ['s', sysContent] : null, userContent ? ['u', userContent] : null]);
      return hmacIdentity('message_hmac', stable);
    }
  }
  return { source: 'roundrobin', fingerprint: null };
}
function stableMsgContent(c) {
  if (typeof c === 'string') return c.slice(0, 4096);
  if (Array.isArray(c)) return c.map((x) => typeof x?.text === 'string' ? x.text : '').join('\n').slice(0, 4096);
  return '';
}
function forwardHeadersFor(req, body = {}) {
  const protocol = detectClientProtocol(req, body);
  // Protocol allowlists are exclusive: a Claude/Codex request must not gain
  // unrelated generic metadata merely because the client supplied it.
  return copyAllowedHeaders(req, protocol === 'codex' ? CODEX_HEADERS : protocol === 'claude' ? CLAUDE_HEADERS : GENERIC_HEADERS);
}
function clineRequestJSON(url, { headers = {}, body, signal, timeoutMs = 120000 } = {}) {
  return clineRequest(url, { headers, body, signal, timeoutMs }).then(async (res) => ({ status: res.status, headers: res.headers, text: await streamToString(res.body) }));
}
function clineRequest(url, { headers = {}, body, signal, timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const data = Buffer.isBuffer(body) ? body : Buffer.from(String(body || ''));
    let settled = false;
    let response = null;
    const onAbort = () => { response?.destroy(new Error('aborted')); req.destroy(new Error('aborted')); };
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    const fail = (error) => { cleanup(); if (!settled) { settled = true; reject(error); } };
    const req = lib.request({ protocol: u.protocol, hostname: u.hostname, port: u.port, path: `${u.pathname}${u.search}`, method: 'POST', headers: { ...headers, 'Content-Length': data.length } }, (res) => {
      response = res;
      res.once('end', cleanup);
      res.once('close', cleanup);
      if (!settled) { settled = true; resolve({ status: res.statusCode || 502, headers: res.headers, body: res }); }
    });
    req.on('error', fail);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('upstream timeout')));
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    req.end(data);
  });
}
function streamToString(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (c) => chunks.push(Buffer.from(c)));
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    stream.on('error', reject);
    stream.resume();
  });
}
function readFirstSseEvent(stream, maxBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const cleanup = () => { stream.off('data', onData); stream.off('end', onEnd); stream.off('error', onError); };
    const finish = (complete) => { stream.pause(); cleanup(); resolve({ buffer: Buffer.concat(chunks), complete }); };
    const onData = (chunk) => {
      const b = Buffer.from(chunk); chunks.push(b); size += b.length;
      const text = Buffer.concat(chunks).toString('utf8');
      if (/\r?\n\r?\n/.test(text)) finish(true);
      else if (size >= maxBytes) finish(false);
    };
    const onEnd = () => { cleanup(); resolve({ buffer: Buffer.concat(chunks), complete: false }); };
    const onError = (error) => { cleanup(); reject(error); };
    stream.on('data', onData); stream.once('end', onEnd); stream.once('error', onError); stream.resume();
  });
}

// ---------- 聊天代理 ----------
const CHAT_PATHS = new Set(['/chat/completions', '/v1/chat/completions', '/api/v1/chat/completions']);

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 50 * 1024 * 1024) { const e = new Error('body too large'); e.statusCode = 413; reject(e); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJsonBody(req) {
  try { return JSON.parse((await readBody(req)).toString('utf8')); }
  catch (e) {
    if (e?.statusCode) throw e;
    const invalid = new Error('invalid JSON body'); invalid.statusCode = 400; throw invalid;
  }
}

function normalizeStatus(httpStatus, json, fallback = 502) {
  if (Number.isInteger(httpStatus) && httpStatus >= 400 && httpStatus <= 599) return httpStatus;
  const err = json?.error || json?.data?.error;
  const code = Number(err?.status || err?.status_code || err?.code || json?.status || json?.status_code);
  if (Number.isInteger(code) && code >= 400 && code <= 599) return code;
  const msg = errText(err || json);
  if (/model not found/i.test(msg)) return 404;
  if (/429|rate-?limit|temporarily rate/i.test(msg)) return 429;
  if (/unauthorized|re-authenticate|invalid\s*api|401/i.test(msg)) return 401;
  return fallback;
}
function unwrap(json, httpStatus = 200) {
  const d = json?.data && json.data.choices ? json.data : json;
  if (d?.error && !d?.choices) {
    const msg = errText(d.error);
    const status = normalizeStatus(httpStatus, d, 502);
    return { status, upstreamStatus: httpStatus, normalizedStatus: status, body: { error: { message: msg, type: 'upstream_error' } }, routing: {} };
  }
  if (httpStatus < 200 || httpStatus >= 300) {
    const msg = errText(d?.error || d || `upstream HTTP ${httpStatus}`);
    const status = normalizeStatus(httpStatus, d, 502);
    return { status, upstreamStatus: httpStatus, normalizedStatus: status, body: { error: { message: msg, type: 'upstream_error' } }, routing: parseRouting(d || {}) };
  }
  const r = parseRouting(d);
  return { status: 200, upstreamStatus: httpStatus, normalizedStatus: 200, body: d, routing: r };
}

// 按管道注入上游偏好（实测结论）：
// - 规划器管道（Vercel AI Gateway）：顶层 provider 简写里的 only/order 会被 Cline 吞掉，
//   必须用 providerOptions.gateway.{only,order,sort}；流式同样生效。
// - 直连管道（OpenRouter）：顶层 provider.{only,order,sort} 生效；providerOptions 被忽略。
// - 管道未知时两种形式同时注入，各自取用、互不干扰。
const OR_SORT = { cost: 'price', ttft: 'latency', tps: 'throughput' };

// upstream: 本次尝试钉住的上游（null=自动）；orderRest: preferred 模式下排在当前上游之后的回退序列；
// excludeList: 排除列表。网关不支持 exclude/ignore 字段（实测被静默忽略），因此排除统一换算成 only 白名单：
// 自动模式 only=已知上游-排除；preferred 钉住模式 order=[当前,...] 且 only=已知上游-排除（防止网关回退到被排除渠道）；
// 严格钉住模式 only=[当前上游]，天然排除其他一切渠道。
function injectPrefs(body, modelId, { upstream, orderRest = [], excludeList = [], strict = true, sort = null }) {
  const b = JSON.parse(JSON.stringify(body));
  const exclude = (excludeList || []).filter((u) => u !== upstream);
  const meta = META.models[modelId] || {};
  const known = meta.upstreams || [];
  const allowList = exclude.length ? known.filter((u) => !exclude.includes(u)) : null;
  if (!upstream && !sort && !(allowList && allowList.length)) return b;
  const pipeline = meta.pipeline || null;
  const useVercel = pipeline === 'planner' || pipeline === null;
  const useOpenRouter = pipeline === 'direct' || pipeline === null;
  if (useVercel) {
    const gw = {};
    if (upstream) {
      if (strict) gw.only = [upstream];
      else {
        gw.order = [upstream, ...orderRest];
        if (allowList && allowList.length) gw.only = allowList;
      }
    } else if (allowList && allowList.length) {
      gw.only = allowList;
    }
    if (sort) gw.sort = sort;
    b.providerOptions = { ...(b.providerOptions || {}), gateway: { ...(b.providerOptions?.gateway || {}), ...gw } };
  }
  if (useOpenRouter) {
    const p = { ...(b.provider || {}) };
    if (upstream) {
      if (strict) p.only = [upstream];
      else {
        p.order = [upstream, ...orderRest];
        if (allowList && allowList.length) p.only = allowList;
      }
    } else if (allowList && allowList.length) {
      p.only = allowList;
    }
    if (sort) p.sort = OR_SORT[sort] || sort;
    b.provider = p;
  }
  return b;
}

// 由 perModel 配置展开出故障转移候选序列：[{ upstream, orderRest, excludeList, strict, sort }, ...]
// - 勾选了上游（排除后非空）：逐个尝试，排除的永不在候选中
// - 未勾选：单候选自动模式，排除换算成 only 白名单注入（见 injectPrefs）
function buildAttempts(modelId, cfg) {
  const listed = (cfg?.upstreams || []).filter((u) => typeof u === 'string' && u);
  const exclude = (cfg?.exclude || []).filter((u) => typeof u === 'string' && u);
  const excl = new Set(exclude);
  const wanted = listed.filter((u) => !excl.has(u));
  const strict = (cfg?.pinMode || 'strict') === 'strict';
  const sort = cfg?.sort || null;
  const base = { strict, sort, excludeList: exclude };
  if (wanted.length) {
    // preferred 模式：当前上游排在 order 首位，其余勾选项作为网关侧回退序列；排除列表随行（限制网关回退范围）
    return wanted.map((u, i) => ({ ...base, upstream: u, orderRest: strict ? [] : wanted.filter((_, j) => j !== i) }));
  }
  return [{ ...base, upstream: null, orderRest: [], excludeList: exclude }];
}

function redactSecrets(value) {
  let s = String(value ?? '');
  const keys = [config.apiKey, config.proxyKey, PROXY_KEY, ...(config.accounts || []).map((a) => a.key)].filter(Boolean);
  for (const k of keys) s = s.split(k).join('[REDACTED]');
  s = s.replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer [REDACTED]');
  return s;
}
// 把上游错误信息归一成短字符串（用于学习与尝试日志）
const errText = (e) => redactSecrets(e == null ? '' : typeof e === 'string' ? e : JSON.stringify(e));

function resolveModelConfig(account, modelId) {
  if (account?.perModel && Object.prototype.hasOwnProperty.call(account.perModel, modelId)) return account.perModel[modelId] || {};
  return config.perModel[modelId] || {};
}
function applyMaxRetries(attempts, cfg) {
  if (cfg?.maxRetries === null || cfg?.maxRetries === undefined) return attempts;
  return attempts.slice(0, Math.max(1, Math.min(attempts.length, Number(cfg.maxRetries) + 1)));
}
function accountActionFor(result) {
  const status = String(result?.normalizedStatus || result?.status || '');
  const rule = config.accountErrorRules?.[status];
  return rule ? { statusCode: Number(status), ...rule } : null;
}
function persistAccountAction(account, action, reason) {
  if (!account?.id || !action || action.action === 'ignore') return;
  const now = Date.now();
  const state = { banned: false, cooldownUntil: 0, statusCode: action.statusCode, reason: safeReason(reason), updatedAt: now };
  if (action.action === 'cooldown') state.cooldownUntil = now + Math.max(1, Number(action.cooldownMs) || 1);
  if (action.action === 'ban') state.banned = true;
  META.accountStates ||= {};
  META.accountStates[account.id] = state;
  saveMeta();
}
function responseHeadersFor(account, forwardedHeaders) {
  return { ...forwardedHeaders, 'Content-Type': 'application/json', Authorization: `Bearer ${account.key}` };
}
// 单次向上游网关发起非流式请求；返回 { status, out, routing, acc, upstreamStatus, normalizedStatus }
async function attemptOnce(modelId, body, attempt, account, forwardedHeaders, signal) {
  const send = injectPrefs(body, modelId, attempt);
  try {
    const res = await clineRequestJSON(`${config.upstreamBase}/chat/completions`, {
      headers: responseHeadersFor(account, forwardedHeaders), body: JSON.stringify(send), signal,
    });
    let json = null;
    try { json = JSON.parse(res.text); } catch {}
    if (!json) return { status: 502, upstreamStatus: res.status, normalizedStatus: normalizeStatus(res.status, null, 502), out: { error: { message: 'upstream returned non-JSON', type: 'upstream_error' } }, routing: {}, netError: 'non-JSON response', acc: account };
    const un = unwrap(json, res.status);
    return { status: un.status, upstreamStatus: un.upstreamStatus, normalizedStatus: un.normalizedStatus, out: un.body, routing: un.routing, netError: null, acc: account };
  } catch (e) {
    return { status: 502, upstreamStatus: 0, normalizedStatus: 502, out: { error: { message: `upstream fetch failed: ${errText(e.message)}`, type: 'upstream_error' } }, routing: {}, netError: errText(e.message), acc: account };
  }
}

// 顺序故障转移：依次执行候选，普通错误不换账号。cooldown/ban 由 handleChat 负责最多换号一次。
async function runChatChain(req, body, modelId, cfg, account, forwardedHeaders, { stream = false, attemptTimeoutMs = 120000 } = {}) {
  const attempts = applyMaxRetries(buildAttempts(modelId, cfg), cfg);
  const trace = [];
  const t0 = Date.now();
  let last = null;
  let activeReq = null;
  let keepCloseHook = false;
  const clientSocket = req.socket;
  const onClientClose = () => { if (activeReq) activeReq.abort?.(); };
  clientSocket?.on('close', onClientClose);
  const cleanupClientClose = () => clientSocket?.off('close', onClientClose);
  try {
    for (const attempt of attempts) {
      const t1 = Date.now();
      const ctrl = new AbortController();
      activeReq = ctrl;
      const timer = setTimeout(() => ctrl.abort(), attemptTimeoutMs);
      try {
        if (stream) {
          const send = injectPrefs(body, modelId, attempt);
          let up = null, netError = null;
          try {
            up = await clineRequest(`${config.upstreamBase}/chat/completions`, { headers: responseHeadersFor(account, forwardedHeaders), body: JSON.stringify(send), signal: ctrl.signal, timeoutMs: attemptTimeoutMs });
          } catch (e) { netError = errText(e.message); }
          const ctype = String(up?.headers?.['content-type'] || '');
          let isSSE = !!up && up.status === 200 && ctype.toLowerCase().includes('event-stream');
          let firstChunk = null;
          if (isSSE) {
            try {
              const first = await readFirstSseEvent(up.body);
              firstChunk = first.buffer;
              if (!firstChunk.length) { isSSE = false; netError = 'empty stream'; }
              else {
                const head = firstChunk.toString('utf8').trimStart();
                if (!first.complete || !head.startsWith('data:')) {
                  isSSE = false; netError = `unexpected stream head: ${head.slice(0, 60)}`;
                } else {
                  const eventText = head.split(/\r?\n\r?\n/, 1)[0];
                  const payload = eventText.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.replace(/^data:\s?/, '')).join('\n');
                  const event = payload === '[DONE]' ? null : safeJsonParse(payload, 64 * 1024);
                  if (event?.error) { isSSE = false; netError = `stream error: ${safeReason(errText(event.error))}`; }
                }
              }
            } catch (e) { isSSE = false; netError = errText(e.message); }
          }
          const ms = Date.now() - t1;
          if (up && !isSSE) {
            const rest = await streamToString(up.body).catch(() => '');
            const text = (firstChunk ? firstChunk.toString('utf8') : '') + rest;
            let json = null;
            try { json = JSON.parse(text); } catch {
              const dataLine = text.split('\n').find((line) => line.trimStart().startsWith('data:'));
              if (dataLine) try { json = JSON.parse(dataLine.trimStart().replace(/^data:\s*/, '')); } catch {}
            }
            const inferred = normalizeStatus(up.status, json, normalizeStatus(0, { error: text }, 502));
            const un = json ? unwrap(json, up.status) : { status: inferred, upstreamStatus: up.status, normalizedStatus: inferred, body: { error: { message: errText(text.slice(0, 400) || netError), type: 'upstream_error' } }, routing: {} };
            const msg = errText(un.body?.error?.message || text || netError);
            trace.push({ upstream: attempt.upstream, status: un.status, upstreamStatus: up.status, normalizedStatus: un.normalizedStatus, ms, note: msg.slice(0, 160), account: account.name });
            if (attempt.upstream) learnUpstreamStatus(modelId, attempt.upstream, msg);
            if (!attempt.upstream && (attempt.excludeList || []).length) learnAvailableProviders(modelId, msg);
            last = { status: un.status, upstreamStatus: up.status, normalizedStatus: un.normalizedStatus, out: un.body, routing: un.routing, acc: account, netError: null, accountAction: accountActionFor(un) };
            trace[trace.length - 1].action = last.accountAction?.action || null;
            if (last.accountAction?.action === 'cooldown' || last.accountAction?.action === 'ban') break;
            continue;
          }
          if (!up) {
            trace.push({ upstream: attempt.upstream, status: 502, upstreamStatus: 0, normalizedStatus: 502, ms, note: netError || 'no response', account: account.name });
            last = { status: 502, upstreamStatus: 0, normalizedStatus: 502, out: { error: { message: `upstream fetch failed: ${netError || 'no response'}`, type: 'upstream_error' } }, routing: {}, acc: account, netError: netError || 'no response', accountAction: accountActionFor({ normalizedStatus: 502 }) };
            trace[trace.length - 1].action = last.accountAction?.action || null;
            if (last.accountAction?.action === 'cooldown' || last.accountAction?.action === 'ban') break;
            continue;
          }
          keepCloseHook = true;
          trace.push({ upstream: attempt.upstream, status: 200, upstreamStatus: 200, normalizedStatus: 200, ms, note: 'stream', account: account.name });
          return { status: 200, streamUp: up, streamHead: firstChunk, acc: account, trace, t0, started: true, cleanupClientClose };
        }
        const r = await attemptOnce(modelId, body, attempt, account, forwardedHeaders, ctrl.signal);
        const ms = Date.now() - t1;
        const note = r.netError || (r.status !== 200 ? errText(r.out?.error?.message).slice(0, 160) : 'ok');
        trace.push({ upstream: attempt.upstream, status: r.status, upstreamStatus: r.upstreamStatus, normalizedStatus: r.normalizedStatus, ms, note, account: account.name });
        if (r.status !== 200 && attempt.upstream) learnUpstreamStatus(modelId, attempt.upstream, errText(r.out?.error?.message));
        if (r.status !== 200 && !attempt.upstream && (attempt.excludeList || []).length) learnAvailableProviders(modelId, r.netError || note);
        last = { ...r, accountAction: accountActionFor(r) };
        trace[trace.length - 1].action = last.accountAction?.action || null;
        if (r.status === 200) break;
        if (last.accountAction?.action === 'cooldown' || last.accountAction?.action === 'ban') break;
      } finally { clearTimeout(timer); }
    }
  } finally {
    if (!keepCloseHook) cleanupClientClose();
  }
  return { ...last, status: last?.status ?? 502, trace, t0, netError: last?.netError || null };
}

async function handleChat(req, res) {
  const raw = await readBody(req);
  let body;
  try { body = JSON.parse(raw.toString('utf8')); } catch { return sendJSON(res, 400, { error: { message: 'invalid JSON body' } }); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return sendJSON(res, 400, { error: { message: 'JSON body must be an object' } });
  const modelId = typeof body.model === 'string' ? body.model.trim() : '';
  if (!modelId || modelId.length > 300) return sendJSON(res, 400, { error: { message: 'valid model is required' } });

  const identity = extractSessionIdentity(req, body);
  const forwardedHeaders = forwardHeadersFor(req, body);
  const isStream = body.stream === true;
  const excluded = new Set();
  const accountPath = [];
  let selected = await acquireAccountLease(identity, { excludeIds: excluded });
  if (!selected.lease) return sendBusy(res, selected.error, selected.retryAfter, enabledAccounts().length ? 429 : 503);

  let chain, cfg, targets, chainLease = selected.lease;
  const completedTrace = [];
  const accountActions = [];
  for (let accountAttempt = 0; accountAttempt < 2; accountAttempt++) {
    const lease = selected.lease;
    chainLease = lease;
    const account = lease.account;
    accountPath.push(account.name);
    cfg = resolveModelConfig(account, modelId);
    targets = applyMaxRetries(buildAttempts(modelId, cfg), cfg).map((a) => a.upstream).filter(Boolean);
    try {
      chain = await runChatChain(req, body, modelId, cfg, account, forwardedHeaders, { stream: isStream });
    } catch (e) {
      lease.release();
      throw e;
    }
    const action = chain.accountAction;
    if (action) {
      const reason = chain.out?.error?.message || chain.netError || `upstream status ${chain.normalizedStatus || chain.status}`;
      if (action.action !== 'ignore') persistAccountAction(account, action, reason);
      accountActions.push({ account: account.name, action: action.action, statusCode: action.statusCode });
      chain.trace.push({ account: account.name, action: action.action, upstreamStatus: chain.upstreamStatus || 0, normalizedStatus: chain.normalizedStatus || chain.status, status: chain.status, ms: 0, note: action.action });
    }
    if (action && (action.action === 'cooldown' || action.action === 'ban') && !chain.started && accountAttempt === 0) {
      completedTrace.push(...chain.trace);
      excluded.add(account.id);
      lease.release();
      chainLease = null;
      selected = await acquireAccountLease(identity, { excludeIds: excluded });
      if (selected.lease) continue;
    }
    break;
  }
  if (completedTrace.length) chain.trace = [...completedTrace, ...chain.trace];

  const lease = chainLease;
  if (isStream && chain.streamUp) {
    const up = chain.streamUp;
    const acc = chain.acc;
    const ctype = String(up.headers['content-type'] || 'text/event-stream');
    res.writeHead(up.status, {
      'Content-Type': ctype, 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'Access-Control-Allow-Origin': '*',
      'X-Cline-Target-Upstream': targets.length ? targets.join('>') : 'auto', 'X-Cline-Attempts': String(chain.trace.length), 'X-Cline-Account': headerSafe(acc.name),
    });
    if (chain.streamHead) res.write(chain.streamHead);
    const buf = [];
    let finalized = false;
    const finalize = (error = null) => {
      if (finalized) return;
      finalized = true;
      chain.cleanupClientClose?.();
      lease.release();
      const text = Buffer.concat([chain.streamHead || Buffer.alloc(0), ...buf]).toString('utf8');
      let provider = null, canonical = null;
      for (const line of text.split('\n').slice(-10).reverse()) {
        if (!line.startsWith('data: ') || line.includes('[DONE]')) continue;
        try { const c = JSON.parse(line.slice(6)); if (typeof c.provider === 'string') { provider = slugify(c.provider); canonical = c.model || null; break; } } catch {}
      }
      if (!provider) {
        provider = /"finalProvider":"([^"]+)"/.exec(text)?.[1] || null;
        canonical = /"canonicalSlug":"([^"]+)"/.exec(text)?.[1] || null;
      }
      let streamError = error ? safeReason(error) : null;
      for (const line of text.split('\n')) {
        if (!line.trimStart().startsWith('data:')) continue;
        try {
          const event = JSON.parse(line.trimStart().replace(/^data:\s*/, ''));
          if (event?.error) {
            const normalizedStatus = normalizeStatus(200, event, 502);
            const action = accountActionFor({ normalizedStatus });
            streamError = safeReason(errText(event.error));
            if (action && action.action !== 'ignore') persistAccountAction(acc, action, streamError);
            chain.trace.push({ account: acc.name, action: action?.action || null, upstreamStatus: 200, normalizedStatus, status: normalizedStatus, ms: 0, note: 'stream error after response started' });
            break;
          }
        } catch {}
      }
      record(modelId, { provider, canonical, ms: Date.now() - chain.t0, stream: true, error: streamError, account: acc.name, attempts: chain.trace.map((t) => t.upstream || 'auto'), trace: chain.trace, accountPath, accountActions, sessionSource: identity.source });
    };
    const tap = new Transform({ transform(c, enc, cb) { buf.push(Buffer.from(c)); cb(null, c); }, flush(cb) { finalize(); cb(); } });
    up.body.on('error', (e) => { finalize(e.message); if (!res.destroyed) res.destroy(e); });
    res.on('close', () => { if (!res.writableEnded) up.body.destroy(); finalize('client disconnected'); });
    up.body.pipe(tap).pipe(res);
    return;
  }

  lease?.release();
  const { status, out, routing = {}, acc } = chain;
  if (!out) return sendJSON(res, 502, { error: { message: 'no upstream response', type: 'upstream_error' } });
  if (status === 200 && /^cline-pass\//.test(modelId) && !config.knownModels.includes(modelId)) { config.knownModels.push(modelId); saveConfig(); }
  const safeOut = status === 200 ? out : { ...out, error: { ...(out.error || {}), message: safeReason(out?.error?.message || 'upstream error') } };
  record(modelId, {
    provider: routing.finalProvider || null, canonical: routing.canonicalSlug || null, ms: Date.now() - chain.t0, stream: false,
    attempts: chain.trace.map((t) => t.upstream || 'auto'), trace: chain.trace, error: status !== 200 ? safeOut.error.message : null,
    account: acc?.name || null, accountPath, accountActions, accountAction: chain.accountAction?.action || accountActions.at(-1)?.action || null, upstreamStatus: chain.upstreamStatus, normalizedStatus: chain.normalizedStatus, sessionSource: identity.source,
  });
  res.writeHead(status, {
    'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*',
    'X-Cline-Target-Upstream': targets.length ? targets.join('>') : 'auto', 'X-Cline-Actual-Upstream': routing.finalProvider || 'unknown',
    'X-Cline-Canonical-Model': routing.canonicalSlug || '', 'X-Cline-Attempts': String(chain.trace.length), 'X-Cline-Account': headerSafe(acc?.name || ''),
  });
  res.end(JSON.stringify(safeOut));
}

// ---------- HTTP 服务 ----------
function sendJSON(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(obj));
}
function sendBusy(res, message, retryAfter = 1, status = 429) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Retry-After': String(retryAfterSeconds((retryAfter || 1) * 1000)) });
  res.end(JSON.stringify({ error: { message: safeReason(message || 'upstream accounts unavailable'), type: status === 429 ? 'rate_limit_error' : 'upstream_error' } }));
}

async function catalog() {
  if (META.catalog && Date.now() - (META.catalogFetchedAt || 0) < 3600e3) return META.catalog;
  const { json } = await fetchJSON(`${config.upstreamBase}/models`, { headers: chatHeaders(pickAccount().key) });
  const ids = (json?.data || []).map((m) => m.id);
  if (ids.length) { META.catalog = ids; META.catalogFetchedAt = Date.now(); saveMeta(); }
  return META.catalog || [];
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': '*',
    });
    return res.end();
  }
  try {
    if (req.method === 'GET' && p === '/api/meta') {
      return sendJSON(res, 200, { authRequired: !!PROXY_KEY, proxyBase: publicProxyBase(), configured: isConfigured() });
    }
    if (p.startsWith('/api/') || p.startsWith('/v1/') || CHAT_PATHS.has(p)) {
      if (!authOK(req)) return unauthorized(res);
    }
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(path.join(PUBLIC_DIR, 'index.html')));
    }
    if (req.method === 'GET' && p === '/api/models') {
      const cat = await catalog();
      const accountId = url.searchParams.get('accountId');
      const account = accountId ? config.accounts.find((a) => a.id === accountId) : null;
      if (accountId && !account) return sendJSON(res, 400, { error: { message: 'unknown accountId' } });
      const ids = [...new Set([...config.knownModels, ...Object.keys(config.perModel || {}), ...Object.keys(account?.perModel || {})])];
      const sub = ids.map((id) => {
        const own = !!account && Object.prototype.hasOwnProperty.call(account.perModel || {}, id);
        return { id, config: own ? account.perModel[id] : (config.perModel[id] || {}), configSource: account ? (own ? 'account' : 'inherited') : 'global', meta: META.models[id] || null };
      });
      return sendJSON(res, 200, { subscription: sub, catalogCount: cat.length, catalog: cat, proxyBase: publicProxyBase(), officialFetch: META.officialModelsFetch || null, accountId: account?.id || null });
    }
    if (req.method === 'POST' && p === '/api/probe') {
      const { model } = await readJsonBody(req);
      if (!model) return sendJSON(res, 400, { error: 'model required' });
      const r = await probeModel(model);
      return sendJSON(res, r.ok ? 200 : 502, r);
    }
    if (req.method === 'POST' && p === '/api/test') {
      const input = await readJsonBody(req);
      const { model, upstream, upstreams, exclude, accountId } = input;
      if (!model) return sendJSON(res, 400, { error: 'model required' });
      const forced = accountId ? config.accounts.find((a) => a.id === String(accountId)) : null;
      if (accountId && !forced) return sendJSON(res, 400, { error: { message: 'unknown accountId' } });
      if (forced && !enabledAccounts().some((a) => a.id === forced.id)) return sendJSON(res, 409, { error: { message: 'selected account is unavailable' } });
      const selected = forced ? { lease: tryLease(forced) } : await acquireAccountLease({ source: 'test', fingerprint: hmacHex(`test\0${model}`) });
      if (!selected.lease) return sendBusy(res, 'selected account is busy', retryAfterSeconds(config.concurrencyWaitMs));
      const t0 = Date.now();
      const cfg = { ...resolveModelConfig(selected.lease.account, model) };
      if (upstreams !== undefined) cfg.upstreams = upstreams;
      else if (upstream !== undefined) cfg.upstreams = upstream ? [upstream] : [];
      if (exclude !== undefined) cfg.exclude = exclude;
      const routeError = validatePerModelInput({ [model]: cfg });
      if (routeError) { selected.lease.release(); return sendJSON(res, 400, { error: { message: routeError } }); }
      const body = { model, messages: [{ role: 'user', content: 'Reply with the word OK' }], max_tokens: 256 };
      let chain;
      try { chain = await runChatChain(req, body, model, normalizeRouteConfig(cfg), selected.lease.account, {}, { stream: false, attemptTimeoutMs: 180000 }); }
      finally { selected.lease.release(); }
      const trace = chain.trace || [];
      if (chain.status !== 200) return sendJSON(res, 200, { ok: false, error: safeReason(chain.out?.error?.message || 'upstream error'), targets: cfg.upstreams || [], exclude: cfg.exclude || [], trace });
      const r = parseRouting(chain.out);
      record(model, { provider: r.finalProvider, canonical: r.canonicalSlug, ms: Date.now() - t0, stream: false, attempts: trace.map((t) => t.upstream || 'auto'), error: null, account: chain.acc?.name || null });
      return sendJSON(res, 200, { ok: true, ms: Date.now() - t0, targets: cfg.upstreams || [], exclude: cfg.exclude || [], actual: r.finalProvider, actualName: r.finalProviderName, pipeline: r.pipeline, pinnable: r.pipeline !== null, canonicalSlug: r.canonicalSlug, fallbacks: r.fallbacks, content: (r.content || '').slice(0, 120), account: chain.acc?.name || null, trace });
    }
    if (req.method === 'GET' && p === '/api/accounts') {
      clearExpiredCooldowns();
      return sendJSON(res, 200, {
        accounts: config.accounts.map((a) => ({ ...a, state: getAccountState(a.id), activeCount: activeCounts.get(a.id) || 0 })),
        mode: config.accountMode, active: config.activeAccount, concurrencyWaitMs: config.concurrencyWaitMs,
        accountErrorRules: config.accountErrorRules, stats: META.stats || {},
      });
    }
    if (req.method === 'POST' && p === '/api/accounts') {
      const body = await readJsonBody(req);
      if (!body || typeof body !== 'object' || !Array.isArray(body.accounts)) return sendJSON(res, 400, { error: { message: 'accounts array is required' } });
      if (!['single', 'roundrobin', 'sticky'].includes(body.mode)) return sendJSON(res, 400, { error: { message: 'invalid account mode' } });
      const wait = Number(body.concurrencyWaitMs ?? 2000);
      if (!Number.isInteger(wait) || wait < 0 || wait > 30000) return sendJSON(res, 400, { error: { message: 'concurrencyWaitMs must be an integer from 0 to 30000' } });
      const ruleError = validateAccountErrorRulesInput(body.accountErrorRules || {});
      if (ruleError) return sendJSON(res, 400, { error: { message: ruleError } });
      if (!Number.isInteger(Number(body.active ?? 0)) || Number(body.active ?? 0) < 0 || Number(body.active ?? 0) >= body.accounts.length) return sendJSON(res, 400, { error: { message: 'active account index is out of range' } });
      const existingIds = new Set(config.accounts.map((a) => a.id));
      for (const [i, a] of body.accounts.entries()) {
        if (!a || typeof a !== 'object' || Array.isArray(a)) return sendJSON(res, 400, { error: { message: `invalid account at index ${i}` } });
        if (a.id !== undefined && (!/^[A-Za-z0-9_-]{1,100}$/.test(String(a.id)) || !existingIds.has(String(a.id)))) return sendJSON(res, 400, { error: { message: `invalid or immutable account id at index ${i}` } });
        if (a.name !== undefined && (typeof a.name !== 'string' || a.name.length > 50 || /[\x00-\x1f\x7f]/.test(a.name))) return sendJSON(res, 400, { error: { message: `invalid account name at index ${i}` } });
        if (a.key !== undefined && (typeof a.key !== 'string' || a.key.length > 4096 || /[\r\n\x00]/.test(a.key))) return sendJSON(res, 400, { error: { message: `invalid account key at index ${i}` } });
        const max = Number(a.maxConcurrent ?? 0);
        if (!Number.isInteger(max) || max < 0 || max > 100000) return sendJSON(res, 400, { error: { message: `invalid maxConcurrent at index ${i}` } });
        const routeError = validatePerModelInput(a.perModel || {});
        if (routeError) return sendJSON(res, 400, { error: { message: `account ${i}: ${routeError}` } });
      }
      const previousById = new Map(config.accounts.map((a) => [a.id, a]));
      const previousByName = new Map(config.accounts.map((a) => [a.name, a]));
      const seen = new Set();
      const normalizedAccounts = body.accounts.map((a, i) => normalizeAccount({ ...a, id: a.id || config.accounts[i]?.id }, i, previousById, previousByName));
      const requestedActiveId = normalizedAccounts[Number(body.active)]?.id;
      const accs = normalizedAccounts.filter((a) => a.key);
      if (!accs.length) return sendJSON(res, 400, { error: { message: '至少需要一个有效账号（key 非空）' } });
      for (const a of accs) { if (seen.has(a.id)) return sendJSON(res, 400, { error: { message: 'duplicate account id' } }); seen.add(a.id); }
      const requestedActive = requestedActiveId ? accs.findIndex((a) => a.id === requestedActiveId) : -1;
      config.accounts = accs; config.accountMode = body.mode; config.activeAccount = requestedActive >= 0 ? requestedActive : Math.min(Math.max(0, Number(body.active) || 0), accs.length - 1);
      config.concurrencyWaitMs = wait; config.accountErrorRules = normalizeAccountErrorRules(body.accountErrorRules || {});
      for (const id of Object.keys(META.accountStates || {})) if (!seen.has(id)) delete META.accountStates[id];
      for (const id of activeCounts.keys()) if (!seen.has(id)) activeCounts.delete(id);
      saveConfig(); saveMeta(); RR_COUNTER = 0;
      return sendJSON(res, 200, { ok: true, accounts: accs.length, mode: config.accountMode, active: config.activeAccount });
    }
    if (req.method === 'POST' && p === '/api/accounts/recover') {
      const body = await readJsonBody(req);
      const id = String(body?.id || '');
      if (!config.accounts.some((a) => a.id === id)) return sendJSON(res, 400, { error: { message: 'unknown account id' } });
      delete META.accountStates[id]; saveMeta();
      return sendJSON(res, 200, { ok: true });
    }
    if (req.method === 'POST' && p === '/api/accounts/test') {
      const { key } = await readJsonBody(req);
      const k = String(key || '').trim();
      if (!k) return sendJSON(res, 400, { error: { message: 'key required' } });
      const t0 = Date.now();
      const model = config.knownModels[0] || 'cline-pass/glm-5.3-flash';
      const { json } = await fetchJSON(`${config.upstreamBase}/chat/completions`, {
        method: 'POST',
        headers: chatHeaders(k),
        body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Say OK' }], max_tokens: 512 }),
      }, 120000);
      if (json?.error && !json?.data) {
        const rawMsg = typeof json.error === 'string' ? json.error : JSON.stringify(json.error);
        const msg = errText(rawMsg).split(k).join('[REDACTED]');
        const authFail = /unauthorized|re-authenticate|invalid\s*api|401/i.test(msg);
        // 密钥无效会直接 Unauthorized；其他错误（如推理模型耗尽 max_tokens 的 empty response）
        // 说明鉴权已通过，不应误报为密钥问题
        return sendJSON(res, 200, authFail
          ? { ok: false, ms: Date.now() - t0, error: `密钥无效或未授权：${msg.slice(0, 160)}` }
          : { ok: true, ms: Date.now() - t0, model, note: `密钥鉴权通过；网关提示：${msg.slice(0, 120)}` });
      }
      return sendJSON(res, 200, { ok: true, ms: Date.now() - t0, model });
    }
    if (req.method === 'GET' && p === '/api/security') {
      return sendJSON(res, 200, { proxyKey: config.proxyKey || '', publicBaseUrl: config.publicBaseUrl || '', authRequired: !!PROXY_KEY, exposeCatalog: !!config.exposeCatalog });
    }
    if (req.method === 'POST' && p === '/api/security') {
      const body = await readJsonBody(req);
      if (body.proxyKey !== undefined) config.proxyKey = String(body.proxyKey).trim();
      if (body.publicBaseUrl !== undefined) config.publicBaseUrl = String(body.publicBaseUrl).trim().replace(/\/+$/, '');
      if (body.exposeCatalog !== undefined) config.exposeCatalog = !!body.exposeCatalog;
      saveConfig();
      PROXY_KEY = config.proxyKey || '';
      return sendJSON(res, 200, { ok: true, proxyKey: config.proxyKey, publicBaseUrl: config.publicBaseUrl, authRequired: !!PROXY_KEY, proxyBase: publicProxyBase(), exposeCatalog: !!config.exposeCatalog });
    }
    if (req.method === 'POST' && p === '/api/validate-upstreams') {
      const { model } = await readJsonBody(req);
      if (!model) return sendJSON(res, 400, { error: { message: 'model required' } });
      const results = await validateUpstreams(model);
      const summary = { ok: 0, limited: 0, bad: 0, auth: 0, unknown: 0 };
      for (const r of Object.values(results)) summary[r.status] = (summary[r.status] || 0) + 1;
      return sendJSON(res, 200, { ok: true, summary, results, upstreams: META.models[model]?.upstreams || [] });
    }
    if (req.method === 'POST' && p === '/api/fetch-official-models') {
      const r = await fetchOfficialModels();
      return sendJSON(res, 200, { ok: true, ...r });
    }
    if (req.method === 'GET' && p === '/api/history') return sendJSON(res, 200, { history: META.history });
    if (req.method === 'GET' && p === '/api/config') return sendJSON(res, 200, { port: config.port, perModel: config.perModel, knownModels: config.knownModels });
    if (req.method === 'POST' && p === '/api/config') {
      const body = await readJsonBody(req);
      if (!body || typeof body !== 'object' || Array.isArray(body) || (body.scope !== undefined && !['global', 'account'].includes(body.scope))) return sendJSON(res, 400, { error: { message: 'invalid config scope' } });
      const scope = body.scope || 'global';
      const target = scope === 'account' ? config.accounts.find((a) => a.id === String(body.accountId || '')) : config;
      if (!target) return sendJSON(res, 400, { error: { message: 'unknown accountId' } });
      if (body.action !== undefined && body.action !== 'inherit') return sendJSON(res, 400, { error: { message: 'invalid config action' } });
      if (body.action === 'inherit') {
        const model = String(body.model || '').trim();
        if (scope !== 'account' || !model || model.length > 300 || /[\x00-\x1f\x7f]/.test(model)) return sendJSON(res, 400, { error: { message: 'valid account scope and model are required for inherit' } });
        delete target.perModel[model]; saveConfig();
        return sendJSON(res, 200, { ok: true, source: 'inherited' });
      }
      if (body.perModel === undefined) return sendJSON(res, 400, { error: { message: 'perModel is required' } });
      const routeError = validatePerModelInput(body.perModel);
      if (routeError) return sendJSON(res, 400, { error: { message: routeError } });
      for (const [m, c] of Object.entries(body.perModel)) target.perModel[String(m).trim()] = normalizeRouteConfig(c);
      saveConfig();
      return sendJSON(res, 200, { ok: true, scope });
    }
    if (req.method === 'GET' && (p === '/v1/models' || p === '/api/v1/models' || p === '/models')) {
      // 默认只暴露订阅模型，避免目录模型淹没客户端的模型选择器；exposeCatalog=true 时合并完整目录
      const ids = config.exposeCatalog
        ? [...new Set([...config.knownModels, ...(await catalog())])]
        : [...new Set([...config.knownModels, ...Object.keys(config.perModel)])];
      return sendJSON(res, 200, { object: 'list', data: ids.map((id) => ({ id, object: 'model' })) });
    }
    if (CHAT_PATHS.has(p) && req.method === 'POST') return handleChat(req, res);
    return sendJSON(res, 404, { error: { message: `no route: ${req.method} ${p}` } });
  } catch (e) {
    return sendJSON(res, Number.isInteger(e?.statusCode) ? e.statusCode : 500, { error: { message: safeReason(e.message || 'internal error') } });
  }
});

// HTTP 响应头只允许 Latin-1，账号名里的中文等字符需要清洗（历史/统计仍用原名）
const headerSafe = (s) => String(s ?? '').replace(/[^\x20-\x7E]/g, '').trim().slice(0, 80) || '-';

server.on('error', (e) => {
  console.error(`[错误] 端口 ${config.port} 监听失败（可能被占用）：${e.message}`);
  process.exit(1);
});

const BIND_HOST = process.env.BIND_HOST || '127.0.0.1';
server.listen(config.port, BIND_HOST, () => {
  console.log(`Cline Pass 上游控制台:  http://127.0.0.1:${config.port}/`);
  console.log(`OpenAI 兼容代理地址:   http://127.0.0.1:${config.port}/v1`);
});
