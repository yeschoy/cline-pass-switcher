// Cline Pass 上游观察/切换代理
// Node >= 18。
//
// 网关行为（实测结论，README 有证据）：
// - planner 管道只接受 providerOptions.gateway.only；direct 管道接受 provider.only。
// - switcher 的每个具名 HTTP attempt 只注入一个 provider，外层负责健康路由和顺序回退。
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { JsonlLogGroup } from './lib/jsonl-log-store.js';
import { DetailRoot, detailContext, detailRoute, observeStream, MAX_BODY_BYTES, captureBudget } from './lib/detailed-log-capture.js';
import { DetailedLogStore, parseDetailQuery, MAX_AGE_MS, MAX_TOTAL_BYTES } from './lib/detailed-log-store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || __dirname;
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const META_PATH = path.join(DATA_DIR, 'metadata.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const LOG_DIR = path.join(DATA_DIR, 'logs');

const DEFAULT_CONFIG = {
  port: 3123,
  apiKey: '',
  proxyKey: '',
  publicBaseUrl: '',
  detailedLogging: false,
  exposeCatalog: false,    // true 时 /v1/models 合并完整目录模型（默认仅订阅模型）
  upstreamBase: 'https://api.cline.bot/api/v1',
  accounts: [],            // { id, name, key, enabled, maxConcurrent, perModel } —— Cline Pass 账号池
  accountMode: 'single',   // single=手动指定 | roundrobin=轮询 | sticky=会话 HRW 粘性
  activeAccount: 0,        // single 模式下使用的账号下标
  concurrencyWaitMs: 2000,
  accountErrorRules: {},   // "429": { action: 'cooldown', cooldownMs: 1800000 } | { action: 'ban' } | { action: 'ignore' }
  accountContentErrorRules: [], // ordered failure-text contains rules with optional normalized status range
  accountPipeline: {
    quotaPool: false,
    excludeUnhealthy: false,
    healthSort: false,
    sticky: false,
    order: ['excludeUnhealthy', 'quotaPool', 'healthSort', 'sticky'],
    cachePoolSize: 0,
  },
  modelAliases: {},        // client alias -> cline-pass/* model
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
const ordinaryLogs = new JsonlLogGroup({
  dir: LOG_DIR,
  streams: { requests: { maxRecords: 50000 }, errors: { maxRecords: 10000 } },
  maxTotalBytes: 100 * 1024 * 1024,
});
const requestLogs = ordinaryLogs.stream('requests');
const errorLogs = ordinaryLogs.stream('errors');
const detailedLogs = new DetailedLogStore({ dir: path.join(DATA_DIR, 'detailed-logs') });
const recentHistory = Array.isArray(META.history) ? [...META.history] : [];

function randomId(prefix = 'acc') {
  return `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
}
function envAccountId(key) {
  return `env_${crypto.createHmac('sha256', META.routingSecret).update(String(key)).digest('hex').slice(0, 24)}`;
}
const ROUTE_SORTS = new Set(['cost', 'ttft', 'tps']);
const PROVIDER_HEALTH_STATUSES = new Set(['ok', 'limited', 'degraded', 'bad', 'unknown']);
const PROVIDER_FAILURE_CLASSES = new Set(['rate_limit', 'auth', 'server', 'network', 'timeout', 'unsupported', 'other']);
const PROVIDER_FAILURE_COUNT_MAX = 30;
function normalizeStringList(v, max = 20) {
  return [...new Set((Array.isArray(v) ? v : []).map((s) => String(s).trim()).filter((s) => /^[a-z0-9][a-z0-9._/-]{0,199}$/i.test(s)))].slice(0, max);
}
function safeProviderTimestamp(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}
function boundedProviderNote(value) {
  let note = String(value || '').replace(/[\r\n\t]+/g, ' ');
  const secrets = [config.apiKey, config.proxyKey, process.env.CLINE_PASS_KEY, process.env.PROXY_KEY, ...(config.accounts || []).flatMap((account) => {
    const values = [account.key, account.proxyUrl, ...Object.values(account.headers || {})];
    try { const url = new URL(account.proxyUrl); values.push(decodeURIComponent(url.username), decodeURIComponent(url.password)); } catch {}
    return values;
  })].filter(Boolean);
  for (const secret of secrets) note = note.split(String(secret)).join('[REDACTED]');
  return note.replace(/(?:https?|socks5h?):\/\/[^\s]+/gi, '[REDACTED_PROXY]').replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer [REDACTED]').slice(0, 160);
}
function normalizeProviderHealthState(value = {}) {
  const raw = isPlainObject(value) ? value : {};
  return {
    status: PROVIDER_HEALTH_STATUSES.has(raw.status) ? raw.status : 'unknown',
    checkedAt: safeProviderTimestamp(raw.checkedAt),
    lastSuccessAt: safeProviderTimestamp(raw.lastSuccessAt),
    lastFailureAt: safeProviderTimestamp(raw.lastFailureAt),
    consecutiveFailures: Math.min(PROVIDER_FAILURE_COUNT_MAX, Math.max(0, Math.floor(Number(raw.consecutiveFailures) || 0))),
    cooldownUntil: safeProviderTimestamp(raw.cooldownUntil),
    failureClass: PROVIDER_FAILURE_CLASSES.has(raw.failureClass) ? raw.failureClass : null,
    note: boundedProviderNote(raw.note),
  };
}
function normalizeProviderHealthMetadata() {
  let dirty = false;
  for (const meta of Object.values(META.models || {})) {
    if (!isPlainObject(meta) || meta.upstreamStatus === undefined) continue;
    if (!isPlainObject(meta.upstreamStatus)) { meta.upstreamStatus = {}; dirty = true; continue; }
    const normalized = {};
    for (const [provider, state] of Object.entries(meta.upstreamStatus)) {
      if (!/^[a-z0-9][a-z0-9._/-]{0,199}$/i.test(provider)) { dirty = true; continue; }
      normalized[provider] = normalizeProviderHealthState(state);
    }
    if (JSON.stringify(normalized) !== JSON.stringify(meta.upstreamStatus)) { meta.upstreamStatus = normalized; dirty = true; }
  }
  return dirty;
}
function normalizeRouteConfig(c = {}) {
  const raw = c && typeof c === 'object' ? c : {};
  const upstreams = normalizeStringList(raw.upstreams !== undefined ? raw.upstreams : (raw.upstream ? [raw.upstream] : []), 20);
  const exclude = normalizeStringList(raw.exclude, 50);
  const maxRetries = raw.maxRetries === null || raw.maxRetries === undefined || raw.maxRetries === ''
    ? null
    : Math.min(20, Math.max(0, Math.floor(Number(raw.maxRetries) || 0)));
  const providerCooldownMs = Number.isInteger(Number(raw.providerCooldownMs))
    ? Math.min(300000, Math.max(0, Number(raw.providerCooldownMs)))
    : 0;
  return {
    upstream: upstreams[0] || null,
    upstreams,
    exclude,
    pinMode: raw.pinMode === 'preferred' ? 'preferred' : 'strict',
    sort: ROUTE_SORTS.has(raw.sort) ? raw.sort : null,
    maxRetries,
    providerCooldownMs,
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
    if (c.providerCooldownMs !== undefined && (!Number.isInteger(Number(c.providerCooldownMs)) || Number(c.providerCooldownMs) < 0 || Number(c.providerCooldownMs) > 300000)) return `invalid providerCooldownMs for ${model}`;
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
const MAX_CONTENT_ERROR_RULES = 100;
const MAX_CONTENT_RULE_TEXT = 500;
const MAX_CONTENT_RULE_BYTES = 64 * 1024;
function normalizeAccountContentErrorRules(value = [], { strict = false } = {}) {
  const fail = (message) => { if (strict) throw new Error(message); console.warn('[配置] 已禁用非法账号内容错误规则'); return []; };
  if (!Array.isArray(value) || value.length > MAX_CONTENT_ERROR_RULES) return fail(`accountContentErrorRules must be an array with at most ${MAX_CONTENT_ERROR_RULES} entries`);
  let bytes; try { bytes = Buffer.byteLength(JSON.stringify(value)); } catch { return fail('accountContentErrorRules must be JSON serializable'); }
  if (bytes > MAX_CONTENT_RULE_BYTES) return fail('accountContentErrorRules exceed 64 KiB');
  const out = [];
  for (const [index, rule] of value.entries()) {
    if (!isPlainObject(rule)) return fail(`invalid accountContentErrorRules entry ${index}`);
    const contains = typeof rule.contains === 'string' ? rule.contains.trim() : '';
    const action = ['ignore','cooldown','ban'].includes(rule.action) ? rule.action : null;
    const hasMin = Object.hasOwn(rule,'statusMin'), hasMax = Object.hasOwn(rule,'statusMax');
    if (!contains || contains.length > MAX_CONTENT_RULE_TEXT || /[\x00-\x1f\x7f]/.test(contains) || !action || hasMin !== hasMax) return fail(`invalid accountContentErrorRules entry ${index}`);
    if (hasMin && (!Number.isSafeInteger(rule.statusMin) || !Number.isSafeInteger(rule.statusMax) || rule.statusMin < 100 || rule.statusMax > 599 || rule.statusMin > rule.statusMax)) return fail(`invalid accountContentErrorRules status range ${index}`);
    if (action === 'cooldown' && (!Number.isSafeInteger(rule.cooldownMs) || rule.cooldownMs < 1 || rule.cooldownMs > 30 * 24 * 3600e3)) return fail(`invalid accountContentErrorRules cooldownMs ${index}`);
    const allowed = ['contains','action',...(hasMin?['statusMin','statusMax']:[]),...(action==='cooldown'?['cooldownMs']:[])];
    if (Object.keys(rule).length !== allowed.length || Object.keys(rule).some((key) => !allowed.includes(key))) return fail(`unknown accountContentErrorRules field ${index}`);
    out.push({ contains, ...(hasMin ? { statusMin: rule.statusMin, statusMax: rule.statusMax } : {}), action, ...(action === 'cooldown' ? { cooldownMs: rule.cooldownMs } : {}) });
  }
  return out;
}
const ACCOUNT_MODES = new Set(['single', 'roundrobin', 'sticky', 'least-connections', 'weighted-roundrobin', 'priority-failover']);
const FORBIDDEN_CUSTOM_HEADER = /(?:authorization|proxy-authorization|cookie|set-cookie|host|content-length|connection|transfer-encoding|upgrade|keep-alive|te|trailer|session|thread|conversation|attestation|installation|api[-_]?key|access[-_]?token|secret|credential|device[-_]?id)/i;
function validateNote(note) {
  return typeof note === 'string' && note.length <= 500 && !/[\x00-\x09\x0b-\x1f\x7f\r]/.test(note);
}
function normalizeProxyUrl(value, { strict = false } = {}) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    if (raw.length > 2048) throw new Error('too long');
    const u = new URL(raw);
    if (!['http:', 'https:', 'socks5:', 'socks5h:'].includes(u.protocol) || !u.hostname || u.search || u.hash || (u.pathname && u.pathname !== '/')) throw new Error('invalid');
    if (u.port && (!Number.isInteger(Number(u.port)) || Number(u.port) < 1 || Number(u.port) > 65535)) throw new Error('port');
    return u.toString();
  } catch { if (strict) throw new Error('proxyUrl must be an http, https, socks5 or socks5h URL without path/query/hash'); console.warn('[配置] 已禁用一个非法账号代理 URL'); return ''; }
}
function validateAndNormalizeHeaders(value, { strict = false } = {}) {
  const fail = (message) => { if (strict) throw new Error(message); console.warn(`[配置] 已禁用非法账号请求头：${message}`); return {}; };
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 32) return fail('headers must be an object with at most 32 entries');
  const out = {}, seen = new Set();
  for (const [name, raw] of Object.entries(value)) {
    const low = name.toLowerCase();
    if (name.length > 128 || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || FORBIDDEN_CUSTOM_HEADER.test(low) || seen.has(low)) return fail(`forbidden or invalid custom header: ${name}`);
    if (typeof raw !== 'string' || raw.length > 2048 || /[\x00-\x1f\x7f]/.test(raw)) return fail(`invalid value for custom header: ${name}`);
    seen.add(low); out[name] = raw;
  }
  if (Buffer.byteLength(JSON.stringify(out)) > 16 * 1024) return fail('custom headers exceed 16 KiB');
  return out;
}
function validateModelAliases(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 500) return 'aliases must be an object with at most 500 entries';
  const original = new Set(config.knownModels || []);
  for (const [alias, target] of Object.entries(value)) {
    if (!alias || alias !== alias.trim() || alias.length > 300 || /[\x00-\x1f\x7f]/.test(alias) || original.has(alias)) return `invalid or conflicting alias: ${alias}`;
    if (typeof target !== 'string' || target !== target.trim() || target.length > 300 || !target.startsWith('cline-pass/') || !original.has(target)) return `invalid alias target for ${alias}`;
  }
  return null;
}
function normalizeModelAliases(value) {
  const error = validateModelAliases(value || {}); if (error) { console.warn(`[配置] 已禁用非法模型别名：${error}`); return {}; }
  return Object.fromEntries(Object.entries(value || {}).map(([a, t]) => [a.trim(), t.trim()]));
}
function resolveModelAlias(model) { return config.modelAliases?.[model] || model; }
function normalizeAccount(a, i, prevById = new Map(), prevByName = new Map()) {
  const suppliedId = String(a?.id || '').trim();
  const id = (/^[A-Za-z0-9_-]{1,100}$/.test(suppliedId) ? suppliedId : '') || prevByName.get(String(a?.name || '').slice(0, 50))?.id || randomId();
  const previous = prevById.get(id) || {};
  return {
    id,
    name: String(a?.name || previous.name || `账号${i + 1}`).slice(0, 50),
    note: validateNote(a?.note) ? a.note : '',
    key: String(a?.key || '').trim(),
    enabled: a?.enabled !== false,
    maxConcurrent: Math.max(0, Math.floor(Number(a?.maxConcurrent) || 0)),
    weight: Number.isInteger(Number(a?.weight)) && Number(a.weight) >= 1 && Number(a.weight) <= 100 ? Number(a.weight) : 1,
    priority: Number.isInteger(Number(a?.priority)) && Number(a.priority) >= 1 && Number(a.priority) <= 100 ? Number(a.priority) : 100,
    proxyUrl: normalizeProxyUrl(a?.proxyUrl),
    headers: validateAndNormalizeHeaders(a?.headers),
    perModel: normalizePerModelMap(a?.perModel || {}),
  };
}
function validateAccountErrorRulesInput(rules = {}) {
  if (!rules || typeof rules !== 'object' || Array.isArray(rules)) return 'accountErrorRules must be an object';
  for (const [code, rule] of Object.entries(rules)) {
    const n = Number(code);
    if (!Number.isInteger(n) || n < 100 || n > 599) return `invalid status code: ${code}`;
    if (!rule || typeof rule !== 'object' || Array.isArray(rule) || !['ignore', 'cooldown', 'ban'].includes(rule.action)) return `invalid action for ${code}`;
    const allowed = rule.action === 'cooldown' ? ['action', 'cooldownMs'] : ['action'];
    if (Object.keys(rule).some((key) => !allowed.includes(key))) return `unknown rule field for ${code}`;
    if (rule.action === 'cooldown' && (!Number.isSafeInteger(Number(rule.cooldownMs)) || Number(rule.cooldownMs) <= 0 || Number(rule.cooldownMs) > 30 * 24 * 3600e3)) return `invalid cooldownMs for ${code}`;
  }
  return null;
}
const PIPELINE_KEYS = ['quotaPool', 'excludeUnhealthy', 'healthSort', 'sticky'];
const PIPELINE_DEFAULT_ORDER = ['excludeUnhealthy', 'quotaPool', 'healthSort', 'sticky'];
function validPipelineOrder(value) {
  return Array.isArray(value) && value.length === PIPELINE_DEFAULT_ORDER.length &&
    new Set(value).size === PIPELINE_DEFAULT_ORDER.length &&
    value.every((step) => PIPELINE_DEFAULT_ORDER.includes(step));
}
function normalizeAccountPipeline(value, { strict = false, fallbackOrder = PIPELINE_DEFAULT_ORDER, fallbackCachePoolSize = 0 } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    if (strict) throw new Error('accountPipeline must be an object');
    value = {};
  }
  if (strict && Object.keys(value).some((key) => ![...PIPELINE_KEYS, 'order', 'cachePoolSize'].includes(key))) throw new Error('accountPipeline contains an unknown field');
  const out = {};
  for (const key of PIPELINE_KEYS) {
    if (strict && typeof value[key] !== 'boolean') throw new Error(`accountPipeline.${key} must be boolean`);
    out[key] = value[key] === true;
  }
  if (value.order === undefined) out.order = [...(validPipelineOrder(fallbackOrder) ? fallbackOrder : PIPELINE_DEFAULT_ORDER)];
  else if (validPipelineOrder(value.order)) out.order = [...value.order];
  else if (strict) throw new Error('accountPipeline.order must be an exact permutation of the four pipeline steps');
  else out.order = [...PIPELINE_DEFAULT_ORDER];
  if (value.cachePoolSize === undefined) out.cachePoolSize = Number.isInteger(fallbackCachePoolSize) && fallbackCachePoolSize >= 0 && fallbackCachePoolSize <= 100000 ? fallbackCachePoolSize : 0;
  else if (Number.isInteger(value.cachePoolSize) && value.cachePoolSize >= 0 && value.cachePoolSize <= 100000) out.cachePoolSize = value.cachePoolSize;
  else if (strict) throw new Error('accountPipeline.cachePoolSize must be an integer from 0 to 100000');
  else out.cachePoolSize = 0;
  return out;
}
const LEGACY_AGG_FIELDS = ['requests','errors','usageRequests','inputKnownRequests','inputTokens','outputKnownRequests','outputTokens','totalKnownRequests','totalTokens','cacheKnownRequests','cacheHitRequests','cachedTokens','cacheInputKnownRequests','cacheInputTokens','cacheInputCachedTokens'];
const ROUTING_AGG_FIELDS = ['explicitAffinityRequests','fallbackAffinityRequests','providerFallbackRequests','providerCircuitCooldownRequests','providerHalfOpenRequests'];
const AGG_FIELDS = [...LEGACY_AGG_FIELDS, ...ROUTING_AGG_FIELDS];
const HEALTH_FIELDS = ['results','penaltyUnits','errors','auth','rateLimit','networkProxy','server','other'];
function emptyAggregate() { return Object.fromEntries([...AGG_FIELDS.map((key) => [key, 0]), ['lastUsedAt', 0], ['lastErrorAt', 0], ['overflowFields', []]]); }
function emptyHealth() { return Object.fromEntries(HEALTH_FIELDS.map((key) => [key, 0])); }
function isPlainObject(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
function validateAggregate(value, label, fields = AGG_FIELDS) {
  if (!isPlainObject(value) || Object.keys(value).some((key) => ![...fields,'lastUsedAt','lastErrorAt','overflowFields'].includes(key))) throw new Error(`invalid statistics ${label}`);
  const overflow = value.overflowFields;
  if (!Array.isArray(overflow) || overflow.some((key) => !fields.includes(key)) || new Set(overflow).size !== overflow.length) throw new Error(`invalid statistics ${label}.overflowFields`);
  for (const key of fields) {
    const overflowed = overflow.includes(key);
    if ((overflowed && value[key] !== null) || (!overflowed && (!Number.isSafeInteger(value[key]) || value[key] < 0))) throw new Error(`invalid statistics ${label}.${key}`);
  }
  for (const key of ['lastUsedAt','lastErrorAt']) if (!Number.isSafeInteger(value[key]) || value[key] < 0) throw new Error(`invalid statistics ${label}.${key}`);
}
function validateHealth(value, label) {
  if (!isPlainObject(value) || Object.keys(value).some((key) => !HEALTH_FIELDS.includes(key))) throw new Error(`invalid statistics ${label}`);
  for (const key of HEALTH_FIELDS) if (!Number.isSafeInteger(value[key]) || value[key] < 0) throw new Error(`invalid statistics ${label}.${key}`);
}
const STATISTICS_VERSION = 3;
const MAX_ACCOUNT_MINUTE_CELLS = 50000;
const MAX_MODEL_MINUTE_CELLS = process.env.NODE_ENV === 'test' ? Math.max(1, Number(process.env.CLINE_PASS_TEST_MODEL_CELL_LIMIT) || 50000) : 50000;
const FORBIDDEN_STATISTIC_KEYS = new Set(['__proto__','prototype','constructor']);
function validStatisticModelId(id) { return typeof id === 'string' && id.length > 0 && id.length <= 300 && !/[\x00-\x1f\x7f]/.test(id) && !FORBIDDEN_STATISTIC_KEYS.has(id); }
function aggregateCell(map, key) {
  if (!Object.hasOwn(map, key)) Object.defineProperty(map, key, { value: emptyAggregate(), enumerable: true, configurable: true, writable: true });
  return map[key];
}
function createStatistics(now = Date.now()) {
  const minute = Math.floor(now / 60000);
  return { version: STATISTICS_VERSION, lifetime: { global: emptyAggregate(), accounts: {} }, minuteBuckets: [], recentCoverage: { droppedAccountMinuteCells: 0, accountIncompleteAt: {}, modelTrackingStartedMinute: minute, droppedModelMinuteCells: 0, modelIncompleteAt: {}, routingTrackingStartedMinute: minute }, migration: { legacyStatsMigratedAt: now, legacyRequests: 0, accountLegacyRequests: {}, ambiguousNames: 0, unmappedNames: 0 } };
}
function validateStatistics(stats) {
  if (!isPlainObject(stats) || ![1,2,STATISTICS_VERSION].includes(stats.version)) throw new Error(stats?.version > STATISTICS_VERSION ? 'unsupported statistics version' : 'invalid statistics version');
  const hasModels = stats.version >= 2, hasRouting = stats.version >= 3, aggregateFields = hasRouting ? AGG_FIELDS : LEGACY_AGG_FIELDS;
  const coverageKeys = hasRouting ? ['droppedAccountMinuteCells','accountIncompleteAt','modelTrackingStartedMinute','droppedModelMinuteCells','modelIncompleteAt','routingTrackingStartedMinute'] : hasModels ? ['droppedAccountMinuteCells','accountIncompleteAt','modelTrackingStartedMinute','droppedModelMinuteCells','modelIncompleteAt'] : ['droppedAccountMinuteCells','accountIncompleteAt'];
  if (Object.keys(stats).some((key) => !['version','lifetime','minuteBuckets','recentCoverage','migration'].includes(key)) || !isPlainObject(stats.lifetime) || Object.keys(stats.lifetime).some((key) => !['global','accounts'].includes(key)) || !isPlainObject(stats.lifetime.accounts) || !Array.isArray(stats.minuteBuckets) || stats.minuteBuckets.length > 1440 || !isPlainObject(stats.recentCoverage) || Object.keys(stats.recentCoverage).length !== coverageKeys.length || coverageKeys.some((key) => !Object.hasOwn(stats.recentCoverage,key)) || !Number.isSafeInteger(stats.recentCoverage.droppedAccountMinuteCells) || stats.recentCoverage.droppedAccountMinuteCells < 0 || !isPlainObject(stats.recentCoverage.accountIncompleteAt) || !isPlainObject(stats.migration)) throw new Error('invalid statistics structure');
  for (const [id, minute] of Object.entries(stats.recentCoverage.accountIncompleteAt)) if (!/^[A-Za-z0-9_-]{1,100}$/.test(id) || !Number.isSafeInteger(minute) || minute < 0) throw new Error('invalid statistics coverage');
  if (hasModels && (!Number.isSafeInteger(stats.recentCoverage.modelTrackingStartedMinute) || stats.recentCoverage.modelTrackingStartedMinute < 0 || !Number.isSafeInteger(stats.recentCoverage.droppedModelMinuteCells) || stats.recentCoverage.droppedModelMinuteCells < 0 || !isPlainObject(stats.recentCoverage.modelIncompleteAt))) throw new Error('invalid statistics model coverage');
  if (hasModels) for (const [id, minute] of Object.entries(stats.recentCoverage.modelIncompleteAt)) if (!validStatisticModelId(id) || !Number.isSafeInteger(minute) || minute < 0) throw new Error('invalid statistics model coverage');
  if (hasRouting && (!Number.isSafeInteger(stats.recentCoverage.routingTrackingStartedMinute) || stats.recentCoverage.routingTrackingStartedMinute < 0)) throw new Error('invalid statistics routing coverage');
  if (Object.keys(stats.migration).some((key) => !['legacyStatsMigratedAt','legacyRequests','accountLegacyRequests','ambiguousNames','unmappedNames'].includes(key)) || !Number.isSafeInteger(stats.migration.legacyStatsMigratedAt) || stats.migration.legacyStatsMigratedAt < 0 || !Number.isSafeInteger(stats.migration.legacyRequests) || stats.migration.legacyRequests < 0 || !isPlainObject(stats.migration.accountLegacyRequests) || !Number.isSafeInteger(stats.migration.ambiguousNames) || stats.migration.ambiguousNames < 0 || !Number.isSafeInteger(stats.migration.unmappedNames) || stats.migration.unmappedNames < 0) throw new Error('invalid statistics migration');
  for (const [id, requests] of Object.entries(stats.migration.accountLegacyRequests)) if (!/^[A-Za-z0-9_-]{1,100}$/.test(id) || !Number.isSafeInteger(requests) || requests < 0) throw new Error('invalid statistics legacy account');
  validateAggregate(stats.lifetime.global, 'lifetime.global', aggregateFields);
  for (const [id, aggregate] of Object.entries(stats.lifetime.accounts)) { if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new Error('invalid statistics account id'); validateAggregate(aggregate, `lifetime.accounts.${id}`, aggregateFields); }
  let previous = -1, accountCells = 0, modelCells = 0;
  for (const bucket of stats.minuteBuckets) {
    const bucketKeys = hasModels ? ['minute','global','accounts','health','models'] : ['minute','global','accounts','health'];
    if (!isPlainObject(bucket) || Object.keys(bucket).length !== bucketKeys.length || bucketKeys.some((key) => !Object.hasOwn(bucket,key)) || !Number.isSafeInteger(bucket.minute) || bucket.minute < 0 || bucket.minute <= previous || !isPlainObject(bucket.global) || !isPlainObject(bucket.accounts) || !isPlainObject(bucket.health) || (hasModels && !isPlainObject(bucket.models))) throw new Error('invalid statistics minute bucket');
    previous = bucket.minute; validateAggregate(bucket.global, `bucket.${bucket.minute}.global`, aggregateFields);
    const ids = new Set([...Object.keys(bucket.accounts), ...Object.keys(bucket.health)]); accountCells += ids.size;
    for (const [id, aggregate] of Object.entries(bucket.accounts)) { if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new Error('invalid statistics account id'); validateAggregate(aggregate, `bucket.${bucket.minute}.accounts.${id}`, aggregateFields); }
    for (const [id, health] of Object.entries(bucket.health)) { if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new Error('invalid statistics account id'); validateHealth(health, `bucket.${bucket.minute}.health.${id}`); }
    if (hasModels) for (const [id, aggregate] of Object.entries(bucket.models)) { if (!validStatisticModelId(id)) throw new Error('invalid statistics model id'); modelCells++; validateAggregate(aggregate, `bucket.${bucket.minute}.models.${id}`, aggregateFields); }
  }
  if (accountCells > MAX_ACCOUNT_MINUTE_CELLS) throw new Error('statistics account-minute cell limit exceeded');
  if (modelCells > MAX_MODEL_MINUTE_CELLS) throw new Error('statistics model-minute cell limit exceeded');
}
function normalizeStatistics() {
  if (META.statistics !== undefined) {
    validateStatistics(META.statistics);
    let dirty = false;
    if (META.statistics.version === 1) {
      const minute = Math.floor(Date.now() / 60000);
      META.statistics = { ...META.statistics, version: 2, minuteBuckets: META.statistics.minuteBuckets.map((bucket) => ({ ...bucket, models: {} })), recentCoverage: { ...META.statistics.recentCoverage, modelTrackingStartedMinute: minute, droppedModelMinuteCells: 0, modelIncompleteAt: {} } };
      dirty = true;
    }
    if (META.statistics.version === 2) {
      const upgrade = (aggregate) => { for (const field of ROUTING_AGG_FIELDS) aggregate[field] = 0; };
      upgrade(META.statistics.lifetime.global);
      for (const aggregate of Object.values(META.statistics.lifetime.accounts)) upgrade(aggregate);
      for (const bucket of META.statistics.minuteBuckets) {
        upgrade(bucket.global);
        for (const aggregate of Object.values(bucket.accounts)) upgrade(aggregate);
        for (const aggregate of Object.values(bucket.models)) upgrade(aggregate);
      }
      META.statistics.recentCoverage.routingTrackingStartedMinute = Math.floor(Date.now() / 60000);
      META.statistics.version = STATISTICS_VERSION;
      dirty = true;
    }
    validateStatistics(META.statistics);
    return dirty;
  }
  const stats = createStatistics();
  const names = new Map(); for (const account of config.accounts || []) { const ids = names.get(account.name) || []; ids.push(account.id); names.set(account.name, ids); }
  for (const [name, legacy] of Object.entries(isPlainObject(META.stats) ? META.stats : {})) {
    const requests = Number.isSafeInteger(legacy?.requests) && legacy.requests >= 0 ? legacy.requests : 0;
    if (stats.migration.legacyRequests > Number.MAX_SAFE_INTEGER - requests) throw new Error('invalid legacy statistics request total');
    stats.migration.legacyRequests += requests;
    const ids = names.get(name) || [];
    if (ids.length === 1) stats.migration.accountLegacyRequests[ids[0]] = requests;
    else if (ids.length > 1) stats.migration.ambiguousNames++;
    else stats.migration.unmappedNames++;
  }
  delete META.stats; META.statistics = stats; return true;
}
const QUOTA_TYPES = ['five_hour','weekly','monthly'];
const QUOTA_STALE_MS = process.env.NODE_ENV === 'test' ? Math.max(50, Number(process.env.CLINE_PASS_TEST_QUOTA_STALE_MS) || 15 * 60e3) : 15 * 60e3;
function canonicalIsoTimestamp(value) {
  const match = typeof value === 'string' && /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  const timestamp = Date.parse(value);
  if (!daysInMonth || day < 1 || day > daysInMonth || !Number.isFinite(timestamp)) return null;
  return new Date(timestamp).toISOString();
}
function validateQuotaSnapshot(snapshot) {
  if (!isPlainObject(snapshot) || Object.keys(snapshot).some((key) => !['limits','fetchedAt'].includes(key)) || !Number.isSafeInteger(snapshot.fetchedAt) || snapshot.fetchedAt <= 0 || !isPlainObject(snapshot.limits)) throw new Error('invalid quota snapshot');
  for (const [type, limit] of Object.entries(snapshot.limits)) {
    if (!QUOTA_TYPES.includes(type) || !isPlainObject(limit) || Object.keys(limit).some((key) => !['percentUsed','resetsAt'].includes(key)) || typeof limit.percentUsed !== 'number' || !Number.isFinite(limit.percentUsed) || limit.percentUsed < 0 || limit.percentUsed > 100) throw new Error('invalid quota limit');
    if (limit.resetsAt !== undefined && canonicalIsoTimestamp(limit.resetsAt) !== limit.resetsAt) throw new Error('invalid quota reset');
  }
}
function parseQuotaPayload(json, fetchedAt = Date.now()) {
  if (json?.success !== true || !isPlainObject(json.data) || !Array.isArray(json.data.limits)) throw new Error('schema');
  const limits = {};
  for (const row of json.data.limits) {
    if (!isPlainObject(row) || !QUOTA_TYPES.includes(row.type)) continue;
    if (limits[row.type] || typeof row.percentUsed !== 'number' || !Number.isFinite(row.percentUsed) || row.percentUsed < 0 || row.percentUsed > 100) throw new Error('schema');
    const limit = { percentUsed: row.percentUsed };
    if (row.resetsAt !== undefined && row.resetsAt !== null) { const resetsAt = canonicalIsoTimestamp(row.resetsAt); if (!resetsAt) throw new Error('schema'); limit.resetsAt = resetsAt; }
    limits[row.type] = limit;
  }
  if (!Object.keys(limits).length) throw new Error('schema');
  const snapshot = { limits, fetchedAt }; validateQuotaSnapshot(snapshot); return snapshot;
}
function normalizeAccountQuotas() {
  if (META.accountQuotas === undefined) { META.accountQuotas = {}; return true; }
  if (!isPlainObject(META.accountQuotas)) throw new Error('invalid accountQuotas');
  for (const [id, q] of Object.entries(META.accountQuotas)) {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(id) || !isPlainObject(q) || Object.keys(q).some((key) => !['snapshot','lastAttemptAt','lastSuccessAt','errorCategory'].includes(key)) || ![null,'auth','rate_limit','server','http','proxy','network','timeout','json','schema'].includes(q.errorCategory ?? null)) throw new Error('invalid account quota state');
    for (const key of ['lastAttemptAt','lastSuccessAt']) if (!Number.isSafeInteger(q[key] || 0) || (q[key] || 0) < 0) throw new Error('invalid account quota timestamp');
    if (q.snapshot !== undefined && q.snapshot !== null) validateQuotaSnapshot(q.snapshot);
  }
  return false;
}
function normalizeConfigAndMeta({ persist = false } = {}) {
  let dirty = false;
  if ((!Array.isArray(config.accounts) || config.accounts.length === 0) && config.apiKey) {
    config.accounts = [{ name: '默认账号', key: config.apiKey, enabled: true }];
    config.accountMode = 'single';
    config.activeAccount = 0;
    dirty = true;
  }
  if (!ACCOUNT_MODES.has(config.accountMode)) { config.accountMode = 'single'; dirty = true; }
  const wait = Math.floor(Number(config.concurrencyWaitMs));
  if (!Number.isFinite(wait) || wait < 0 || wait > 30000) { config.concurrencyWaitMs = 2000; dirty = true; }
  else if (config.concurrencyWaitMs !== wait) { config.concurrencyWaitMs = wait; dirty = true; }
  const aliases = normalizeModelAliases(config.modelAliases || {});
  if (JSON.stringify(aliases) !== JSON.stringify(config.modelAliases || {})) { config.modelAliases = aliases; dirty = true; }
  const pm = normalizePerModelMap(config.perModel || {});
  if (JSON.stringify(pm) !== JSON.stringify(config.perModel || {})) { config.perModel = pm; dirty = true; }
  const rules = normalizeAccountErrorRules(config.accountErrorRules || {});
  if (JSON.stringify(rules) !== JSON.stringify(config.accountErrorRules || {})) { config.accountErrorRules = rules; dirty = true; }
  const contentRules = normalizeAccountContentErrorRules(config.accountContentErrorRules === undefined ? [] : config.accountContentErrorRules);
  if (JSON.stringify(contentRules) !== JSON.stringify(config.accountContentErrorRules)) { config.accountContentErrorRules = contentRules; dirty = true; }
  const pipeline = normalizeAccountPipeline(config.accountPipeline);
  if (JSON.stringify(pipeline) !== JSON.stringify(config.accountPipeline)) { config.accountPipeline = pipeline; dirty = true; }
  const old = Array.isArray(config.accounts) ? config.accounts : [];
  const byId = new Map(old.filter((a) => a?.id).map((a) => [String(a.id), a]));
  const byName = new Map(old.filter((a) => a?.name).map((a) => [String(a.name).slice(0, 50), a]));
  const accs = old.map((a, i) => normalizeAccount(a, i, byId, byName)).filter((a) => a.key);
  if (JSON.stringify(accs) !== JSON.stringify(old)) { config.accounts = accs; dirty = true; }
  const activeAccount = Math.floor(Math.min(Math.max(0, Number(config.activeAccount) || 0), Math.max(0, config.accounts.length - 1)));
  if (config.activeAccount !== activeAccount) { config.activeAccount = activeAccount; dirty = true; }
  META.models ||= {}; META.history ||= []; META.accountStates ||= {};
  if (!META.routingSecret || typeof META.routingSecret !== 'string') { META.routingSecret = crypto.randomBytes(32).toString('hex'); dirty = true; }
  if (normalizeProviderHealthMetadata()) dirty = true;
  if (normalizeStatistics()) dirty = true;
  if (normalizeAccountQuotas()) dirty = true;
  const ids = new Set((config.accounts || []).map((a) => a.id));
  const envKey = String(process.env.CLINE_PASS_KEY || '').trim();
  if (envKey) ids.add(envAccountId(envKey));
  for (const id of Object.keys(META.accountStates)) if (!ids.has(id)) { delete META.accountStates[id]; dirty = true; }
  for (const id of Object.keys(META.accountQuotas)) if (!ids.has(id)) { delete META.accountQuotas[id]; dirty = true; }
  for (const id of Object.keys(META.statistics.lifetime.accounts)) if (!ids.has(id)) { delete META.statistics.lifetime.accounts[id]; dirty = true; }
  for (const bucket of META.statistics.minuteBuckets) for (const id of new Set([...Object.keys(bucket.accounts), ...Object.keys(bucket.health)])) if (!ids.has(id)) { delete bucket.accounts[id]; delete bucket.health[id]; dirty = true; }
  for (const id of Object.keys(META.statistics.recentCoverage.accountIncompleteAt)) if (!ids.has(id)) { delete META.statistics.recentCoverage.accountIncompleteAt[id]; dirty = true; }
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
const strategyCounters = new Map();
const activeCounts = new Map();
const providerCircuitStates = new Map();
const providerCircuitAccountGenerations = new Map();
const providerCircuitRouteGenerations = new Map();
const PROVIDER_CIRCUIT_LIMIT = 50000;
const waiters = new Set();
function notifyCapacityWaiters() { for (const resolve of [...waiters]) resolve(); }
function getAccountState(id) { return (META.accountStates ||= {})[id] || null; }
function safeReason(s, extraSecrets = []) {
  let reason = redactSecrets(String(s || '').replace(/[\r\n\t]+/g, ' '));
  for (const secret of extraSecrets) {
    if (!secret) continue;
    if (secret.length >= 8) reason = reason.split(secret).join('[REDACTED]');
    else {
      const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      reason = reason.replace(new RegExp(`(^|[^A-Za-z0-9])${escaped}(?=$|[^A-Za-z0-9])`, 'g'), '$1[REDACTED]');
    }
  }
  return reason;
}
function sensitiveMessageValues(body) {
  const values = [];
  for (const message of Array.isArray(body?.messages) ? body.messages : []) {
    if (typeof message?.content === 'string') values.push(message.content);
    else if (Array.isArray(message?.content)) for (const part of message.content) if (typeof part?.text === 'string') values.push(part.text);
  }
  return values.filter(Boolean);
}
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
function strategyRank(mode, list) {
  if (mode === 'least-connections') {
    const min = Math.min(...list.map((a) => activeCounts.get(a.id) || 0));
    return rrRank(list.filter((a) => (activeCounts.get(a.id) || 0) === min));
  }
  if (mode === 'weighted-roundrobin') {
    const slots = list.flatMap((a) => Array.from({ length: a.weight || 1 }, () => a));
    const cursor = strategyCounters.get(mode) || 0;
    strategyCounters.set(mode, cursor + 1);
    const start = cursor % slots.length;
    return [...new Map([...slots.slice(start), ...slots.slice(0, start)].map((a) => [a.id, a])).values()];
  }
  if (mode === 'priority-failover') {
    const priority = Math.min(...list.map((a) => a.priority || 100));
    return rrRank(list.filter((a) => (a.priority || 100) === priority));
  }
  return rrRank(list);
}
function selectionResult(lease, mode, preferred, reason, identity, overflow = false) {
  return {
    lease, strategy: mode, preferredAccountId: preferred?.id || null, preferredAccountName: preferred?.name || null,
    selectedAccountId: lease.account.id, selectedAccountName: lease.account.name, reason, overflow,
    sessionSource: identity?.source || (mode === 'single' ? 'single' : 'roundrobin'), source: identity?.source || (mode === 'single' ? 'single' : 'roundrobin'),
  };
}
async function acquireLegacyAccountLease(identity, { excludeIds = new Set(), allowOverflow = true } = {}) {
  const waitMs = Math.min(30000, Math.max(0, Number(config.concurrencyWaitMs) || 0));
  const list = enabledAccounts({ excludeIds });
  if (!list.length) return { error: 'no available upstream account', strategy: config.accountMode };
  const mode = config.accountMode;
  if (mode === 'sticky' && identity?.fingerprint) {
    const ranked = hrwRank(list, identity.fingerprint);
    const primary = ranked[0];
    let lease = tryLease(primary);
    if (lease) return selectionResult(lease, mode, primary, 'sticky-primary', identity);
    lease = await waitForLease([primary], waitMs);
    if (lease) return selectionResult(lease, mode, primary, 'sticky-primary', identity);
    if (allowOverflow) {
      lease = await waitForLease(ranked.slice(1), 0);
      if (lease) return selectionResult(lease, mode, primary, 'sticky-overflow', identity, true);
    }
    return { error: 'all upstream accounts are busy', retryAfter: retryAfterSeconds(waitMs), strategy: mode };
  }
  if (mode === 'single') {
    const preferred = singlePreferred(list);
    const lease = await waitForLease([preferred], waitMs);
    if (lease) return selectionResult(lease, mode, preferred, 'single-selected', identity);
    return { error: 'upstream account is busy', retryAfter: retryAfterSeconds(waitMs), strategy: mode };
  }
  const reasons = { roundrobin: 'roundrobin-next', sticky: 'sticky-no-identity-roundrobin', 'least-connections': 'least-active', 'weighted-roundrobin': 'weighted-slot', 'priority-failover': 'priority-tier' };
  const deadline = Date.now() + waitMs;
  while (true) {
    const current = enabledAccounts({ excludeIds });
    if (!current.length) return { error: 'no available upstream account', strategy: mode };
    const available = current.filter(accountHasCapacity);
    if (available.length) {
      const ranked = strategyRank(mode, available);
      const lease = tryLease(ranked[0]);
      if (lease) return selectionResult(lease, mode, ranked[0], reasons[mode], identity);
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { error: 'all upstream accounts are busy', retryAfter: retryAfterSeconds(waitMs), strategy: mode };
    await waitForCapacity(remaining);
  }
}
function configuredCachePoolSize() { return Number.isInteger(config.accountPipeline?.cachePoolSize) ? config.accountPipeline.cachePoolSize : 0; }
function cachePoolEnabled() { return configuredCachePoolSize() > 0 && (config.accountMode === 'sticky' || config.accountPipeline?.sticky === true); }
function pipelineEnabled() { return cachePoolEnabled() || PIPELINE_KEYS.some((key) => config.accountPipeline?.[key]); }
function quotaRoutingEnabled() { return config.accountPipeline?.quotaPool === true || cachePoolEnabled(); }
function quotaProjection(accountId, now = Date.now()) {
  const q = META.accountQuotas?.[accountId];
  const snapshot = q?.snapshot;
  const complete = snapshot && q.errorCategory == null && q.lastSuccessAt === snapshot.fetchedAt && q.lastAttemptAt <= q.lastSuccessAt && ['five_hour','weekly','monthly'].every((type) => snapshot.limits?.[type]) && snapshot.fetchedAt <= now && now - snapshot.fetchedAt <= QUOTA_STALE_MS;
  if (!complete) return { status: 'unknown', pool: 'unknown', fetchedAt: snapshot?.fetchedAt || null, limits: snapshot?.limits || {}, errorCategory: q?.errorCategory || null };
  const maximum = Math.max(...Object.values(snapshot.limits).map((limit) => limit.percentUsed));
  return { status: 'fresh', pool: maximum < 80 ? 'hot' : maximum < 95 ? 'warm' : 'reserve', fetchedAt: snapshot.fetchedAt, limits: snapshot.limits, errorCategory: null };
}
function statisticsQuotaProjection(account, now = Date.now()) {
  const quota = quotaProjection(account.id, now), state = META.accountQuotas?.[account.id];
  const reason = !account.key ? 'unconfigured' : account.enabled === false ? 'disabled' : null;
  const job = quotaJobs.get(account.id), activeJob = job && quotaJobAccount(job) && quotaJobHasOwner(job) ? job : null;
  let nextAttemptAt = null;
  if (!reason && state?.errorCategory && state.lastAttemptAt) nextAttemptAt = state.lastAttemptAt + quotaFailureDelay(account.id);
  else if (!reason) { const successAt = successfulQuotaTime(state, now); if (successAt) nextAttemptAt = successAt + QUOTA_SUCCESS_MS; }
  return { ...quota, lastAttemptAt: state?.lastAttemptAt || null, lastSuccessAt: state?.lastSuccessAt || null, refresh: { eligible: reason === null, reason, state: activeJob ? (activeJob.state === 'running' ? 'fetching' : 'queued') : 'idle', nextAttemptAt } };
}
function pipelineCandidates(list) {
  return list.map((account) => ({ account, health: healthProjection(account), quota: quotaProjection(account.id) }));
}
function buildPipelineGroups(list, identity, candidates = pipelineCandidates(list)) {
  const diagnostics = [];
  let groups = [{ candidates, quota: 'ordinary', health: 'ordinary' }];
  let stickyApplied = false;
  const applySticky = () => {
    if (!identity?.fingerprint) return;
    groups = groups.flatMap((group) => {
      const byId = new Map(group.candidates.map((candidate) => [candidate.account.id, candidate]));
      return hrwRank(group.candidates.map((candidate) => candidate.account), identity.fingerprint)
        .map((account) => ({ ...group, candidates: [byId.get(account.id)] }));
    });
    stickyApplied = true;
  };
  for (const step of config.accountPipeline.order) {
    if (!config.accountPipeline[step]) continue;
    if (step === 'excludeUnhealthy') {
      const total = groups.reduce((count, group) => count + group.candidates.length, 0);
      const kept = groups.map((group) => ({ ...group, candidates: group.candidates.filter((candidate) => candidate.health.status !== 'unhealthy') })).filter((group) => group.candidates.length);
      const keptCount = kept.reduce((count, group) => count + group.candidates.length, 0);
      if (keptCount) {
        if (keptCount < total) diagnostics.push('health-filtered');
        groups = kept;
      } else if (total) {
        const first = groups.find((group) => group.candidates.length);
        const best = Math.max(...first.candidates.map((candidate) => candidate.health.score ?? -1));
        groups = [{ ...first, candidates: first.candidates.filter((candidate) => (candidate.health.score ?? -1) === best).sort((a, b) => a.account.id.localeCompare(b.account.id)) }];
        diagnostics.push('health-filter-fallback');
      }
    } else if (step === 'quotaPool') {
      if (!groups.some((group) => group.candidates.some((candidate) => candidate.quota.pool !== 'unknown'))) diagnostics.push('quota-all-unknown');
      else groups = groups.flatMap((group) => ['hot','warm','unknown','reserve'].map((pool) => ({ ...group, candidates: group.candidates.filter((candidate) => candidate.quota.pool === pool), quota: pool })).filter((next) => next.candidates.length));
    } else if (step === 'healthSort') {
      const layers = [[['available','insufficient'],'available-or-insufficient'],[['degraded'],'degraded'],[['unhealthy'],'unhealthy']];
      groups = groups.flatMap((group) => layers.map(([statuses, health]) => ({ ...group, candidates: group.candidates.filter((candidate) => statuses.includes(candidate.health.status)), health })).filter((next) => next.candidates.length));
    } else if (step === 'sticky') applySticky();
  }
  if (config.accountMode === 'sticky' && !config.accountPipeline.sticky) applySticky();
  return { groups: groups.map((group) => ({ accounts: group.candidates.map((candidate) => candidate.account), quota: group.quota, health: group.health })), diagnostics, stickyApplied };
}
function cachePoolMembership(list, candidates = null) {
  if (!cachePoolEnabled()) return null;
  candidates ||= pipelineCandidates(list);
  const size = configuredCachePoolSize();
  const activeCandidates = candidates.filter((candidate) => candidate.health.status !== 'unhealthy' && candidate.quota.pool !== 'reserve')
    .sort((left, right) => (left.account.priority || 100) - (right.account.priority || 100) || (left.account.id < right.account.id ? -1 : left.account.id > right.account.id ? 1 : 0))
    .slice(0, size);
  const activeIds = new Set(activeCandidates.map((candidate) => candidate.account.id));
  return { size, activeIds, activeCandidates, candidates, byId: new Map(candidates.map((candidate) => [candidate.account.id, candidate])) };
}
function cachePoolRoles() {
  const list = enabledAccounts(), membership = cachePoolMembership(list), eligibleIds = new Set(list.map((account) => account.id));
  if (!membership) return new Map();
  return new Map(config.accounts.map((account) => [account.id, eligibleIds.has(account.id) ? (membership.activeIds.has(account.id) ? 'active' : 'standby') : null]));
}
function cachePoolRank(accounts, identity, mode) {
  if (identity?.fingerprint) return hrwRank(accounts, identity.fingerprint);
  if (mode === 'single') {
    const preferred = singlePreferred(accounts);
    return preferred ? [preferred, ...accounts.filter((account) => account.id !== preferred.id)] : [...accounts];
  }
  return strategyRank(mode, accounts);
}
function cacheHealthLayer(status) {
  if (status === 'available' || status === 'insufficient') return 'available-or-insufficient';
  return status === 'degraded' || status === 'unhealthy' ? status : 'ordinary';
}
function cachePipelineFacts(plan, membership, candidate, tier, capacityFallback) {
  return {
    diagnostics: plan.diagnostics,
    selectedQuota: candidate?.quota.pool || 'unknown',
    selectedHealth: cacheHealthLayer(candidate?.health.status),
    capacityFallback,
    cachePoolSize: membership.size,
    cachePoolTier: tier,
    cachePoolFallback: tier === 'standby',
  };
}
function tryCachePoolStandbyLease(plan, membership, identity, mode, preferred) {
  for (const group of plan.groups) {
    const available = group.accounts.filter((account) => !membership.activeIds.has(account.id) && accountHasCapacity(account));
    if (!available.length) continue;
    const ranked = plan.stickyApplied ? available : cachePoolRank(available, identity, mode);
    const account = ranked[0], lease = tryLease(account); if (!lease) continue;
    const result = selectionResult(lease, mode, preferred, 'cache-pool-standby-overflow', identity, true);
    result.pipeline = cachePipelineFacts(plan, membership, membership.byId.get(account.id), 'standby', true);
    return result;
  }
  return null;
}
async function acquireCachePoolAccountLease(identity, { excludeIds = new Set(), allowOverflow = true } = {}) {
  const mode = config.accountMode, waitMs = Math.min(30000, Math.max(0, Number(config.concurrencyWaitMs) || 0)), deadline = Date.now() + waitMs;
  while (true) {
    const list = enabledAccounts({ excludeIds });
    if (!list.length) return { error: 'no available upstream account', strategy: mode };
    const candidates = pipelineCandidates(list), membership = cachePoolMembership(list, candidates), plan = buildPipelineGroups(list, identity, candidates);
    const active = membership.activeCandidates.map((candidate) => candidate.account);
    const rankedActive = identity?.fingerprint ? cachePoolRank(active, identity, mode) : cachePoolRank(active.filter(accountHasCapacity), identity, mode);
    const preferred = rankedActive[0] || (identity?.fingerprint ? null : cachePoolRank(active, identity, mode)[0]) || null;
    for (const account of rankedActive) {
      const lease = tryLease(account); if (!lease) continue;
      const overflow = !!preferred && account.id !== preferred.id;
      const result = selectionResult(lease, mode, preferred || account, overflow ? 'cache-pool-active-overflow' : 'cache-pool-active', identity, overflow);
      result.pipeline = cachePipelineFacts(plan, membership, membership.byId.get(account.id), 'active', overflow);
      return result;
    }
    if (!active.length) {
      const fallback = allowOverflow ? tryCachePoolStandbyLease(plan, membership, identity, mode, preferred) : null;
      return fallback || { error: 'all upstream accounts are busy', retryAfter: retryAfterSeconds(waitMs), strategy: mode };
    }
    const remaining = deadline - Date.now();
    if (remaining > 0) { await waitForCapacity(remaining); continue; }
    if (!allowOverflow) return { error: 'all upstream accounts are busy', retryAfter: retryAfterSeconds(waitMs), strategy: mode };
    return tryCachePoolStandbyLease(plan, membership, identity, mode, preferred) || { error: 'all upstream accounts are busy', retryAfter: retryAfterSeconds(waitMs), strategy: mode };
  }
}
async function acquirePipelineAccountLease(identity, options = {}) {
  if (cachePoolEnabled()) return acquireCachePoolAccountLease(identity, options);
  const { excludeIds = new Set(), allowOverflow = true } = options;
  const mode = config.accountMode, waitMs = Math.min(30000, Math.max(0, Number(config.concurrencyWaitMs) || 0)), deadline = Date.now() + waitMs;
  while (true) {
    const list = enabledAccounts({ excludeIds });
    if (!list.length) return { error: 'no available upstream account', strategy: mode };
    const plan = buildPipelineGroups(list, identity);
    const primary = plan.stickyApplied ? plan.groups[0].accounts[0] : null;
    if (primary) {
      const lease = tryLease(primary);
      if (lease) { const result = selectionResult(lease, mode, primary, 'pipeline-sticky-primary', identity); result.pipeline = { ...plan, groups: undefined, selectedQuota: plan.groups[0].quota, selectedHealth: plan.groups[0].health }; return result; }
      if (mode === 'single' || mode === 'sticky') {
        const remaining = deadline - Date.now();
        if (remaining > 0) { await waitForCapacity(remaining); continue; }
        if (mode === 'single') return { error: 'upstream account is busy', retryAfter: retryAfterSeconds(waitMs), strategy: mode };
        if (!allowOverflow) return { error: 'all upstream accounts are busy', retryAfter: retryAfterSeconds(waitMs), strategy: mode };
      }
    }
    if (mode === 'single' && !primary) {
      const chosen = singlePreferred(plan.groups[0].accounts) || plan.groups[0].accounts[0];
      const lease = tryLease(chosen);
      if (lease) return { ...selectionResult(lease, mode, chosen, 'single-selected', identity), pipeline: { diagnostics: plan.diagnostics, selectedQuota: plan.groups[0].quota, selectedHealth: plan.groups[0].health } };
      const remaining = deadline - Date.now();
      if (remaining > 0) { await waitForCapacity(remaining); continue; }
      return { error: 'upstream account is busy', retryAfter: retryAfterSeconds(waitMs), strategy: mode };
    }
    for (let groupIndex = 0; groupIndex < plan.groups.length; groupIndex++) {
      const group = plan.groups[groupIndex], available = group.accounts.filter((account) => account.id !== primary?.id && accountHasCapacity(account));
      if (!available.length) continue;
      let ranked;
      if (mode === 'single') { const preferred = singlePreferred(group.accounts); ranked = available.includes(preferred) ? [preferred] : [available[0]]; }
      else if (mode === 'sticky' && identity?.fingerprint && !plan.stickyApplied) ranked = hrwRank(available, identity.fingerprint);
      else ranked = strategyRank(mode, available);
      const lease = tryLease(ranked[0]); if (!lease) continue;
      const fallback = groupIndex > 0 || !!primary;
      const result = selectionResult(lease, mode, primary || ranked[0], fallback ? 'pipeline-capacity-fallback' : ({roundrobin:'roundrobin-next',sticky:'sticky-no-identity-roundrobin','least-connections':'least-active','weighted-roundrobin':'weighted-slot','priority-failover':'priority-tier',single:'single-selected'}[mode]), identity, fallback);
      result.pipeline = { diagnostics: plan.diagnostics, selectedQuota: group.quota, selectedHealth: group.health, capacityFallback: fallback };
      return result;
    }
    const remaining = deadline - Date.now(); if (remaining <= 0) return { error: 'all upstream accounts are busy', retryAfter: retryAfterSeconds(waitMs), strategy: mode };
    await waitForCapacity(remaining);
  }
}
async function acquireAccountLease(identity, options = {}) { return pipelineEnabled() ? acquirePipelineAccountLease(identity, options) : acquireLegacyAccountLease(identity, options); }
function retryAfterSeconds(waitMs) { return Math.min(30, Math.max(1, Math.ceil((Number(waitMs) || 1000) / 1000))); }
function pickAccount() {
  const list = enabledAccounts();
  if (!list.length) return { name: '默认', key: config.apiKey || '', id: 'legacy', maxConcurrent: 0, perModel: {} };
  if (config.accountMode === 'roundrobin' && list.length > 1) return rrRank(list)[0];
  return singlePreferred(list);
}
async function acquireManagementAccount(accountId, source) {
  const requested = accountId === undefined || accountId === null || accountId === '' ? null : String(accountId);
  if (requested !== null) {
    const account = config.accounts.find((candidate) => candidate.id === requested);
    if (!account) return { status: 400, error: 'unknown accountId' };
    if (!enabledAccounts().some((candidate) => candidate.id === account.id)) return { status: 409, error: 'selected account is unavailable' };
    const lease = tryLease(account);
    return lease ? { lease } : { status: 429, error: 'selected account is busy', retryAfter: retryAfterSeconds(config.concurrencyWaitMs) };
  }
  const selected = await acquireAccountLease({ source, keyType: 'none', confidence: 'none', fingerprint: hmacHex(`management\0${source}`) });
  return selected.lease ? { lease: selected.lease } : { status: enabledAccounts().length ? 429 : 503, error: selected.error, retryAfter: selected.retryAfter };
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

async function accountFetchJSON(url, opts = {}, timeoutMs = 60000, account = null) {
  const headers = account ? responseHeadersFor(account, opts.headers || {}) : (opts.headers || {});
  const result = await clineRequestJSON(url, { headers, body: opts.body || '', timeoutMs, account });
  let json = null; try { json = JSON.parse(result.text); } catch { json = { raw: result.text }; }
  return { status: result.status, json };
}
async function fetchJSON(url, opts = {}, timeoutMs = 60000, account = null) {
  const root = detailContext.getStore();
  const attempt = root?.method === 'GET' && url === `${config.upstreamBase}/models` ? root.attempt({ url, method: 'GET', headers: opts.headers || {}, account }) : null;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    if (attempt) { attempt.status = res.status; attempt.responseHeaders = Object.fromEntries(res.headers); attempt.url = root.redactor.text(root.redactor.url(res.url)); attempt.redirected = res.redirected; }
    const text = await res.text();
    if (attempt) { attempt.output.add(text); attempt.output.end(); }
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
const PROVIDER_SLUG = /^[a-z0-9][a-z0-9-]{0,199}$/;
function strictProviderList(value) {
  if (!Array.isArray(value)) return null;
  const providers = [...new Set(value.filter((item) => typeof item === 'string').map((item) => item.trim()).filter((item) => PROVIDER_SLUG.test(item)))];
  return providers.length ? providers : null;
}
function providersFromError(value, depth = 0) {
  if (depth > 4 || value == null) return null;
  if (Array.isArray(value)) return strictProviderList(value);
  if (isPlainObject(value)) {
    for (const candidate of [value.available_providers, value.metadata?.available_providers]) { const providers = strictProviderList(candidate); if (providers) return providers; }
    for (const candidate of [value.error, value.message]) { const providers = providersFromError(candidate, depth + 1); if (providers) return providers; }
    return null;
  }
  if (typeof value !== 'string') return null;
  const match = /Available providers are:\s*([a-z0-9-]+(?:\s*,\s*[a-z0-9-]+)*)/i.exec(value);
  if (match) return strictProviderList(match[1].split(',').map((item) => item.trim().toLowerCase()));
  const start = value.indexOf('{');
  if (start >= 0) try { return providersFromError(JSON.parse(value.slice(start)), depth + 1); } catch {}
  return null;
}
async function harvestAvailableProviders(modelId, pipeline, acc) {
  const base = { model: modelId, messages: [{ role: 'user', content: 'hi' }], max_tokens: 16 };
  const body = pipeline === 'planner'
    ? { ...base, providerOptions: { gateway: { only: ['__probe__'] } } }
    : { ...base, provider: { only: ['__probe__'] } };
  const { json } = await accountFetchJSON(`${config.upstreamBase}/chat/completions`, { headers: chatHeaders(acc.key), body: JSON.stringify(body) }, 60000, acc);
  return providersFromError(upstreamErrorOf(json));
}
function parseTier0(plan) {
  const m = /([\w-]+) won tier 0 over ([^."]+)/.exec(plan || '');
  if (!m) return [];
  return [...new Set([m[1], ...m[2].split(/,\s*|\s+and\s+/).map((s) => s.trim()).filter(Boolean)])];
}

async function probeModel(modelId, acc) {
  const t0 = Date.now();
  const body = { model: modelId, messages: [{ role: 'user', content: 'Reply with the word OK' }], max_tokens: 256 };
  const { json } = await accountFetchJSON(`${config.upstreamBase}/chat/completions`, {
    headers: chatHeaders(acc.key), body: JSON.stringify(body),
  }, 180000, acc);
  const ms = Date.now() - t0;
  if (json?.error && !json?.data) {
    return { ok: false, error: safeReason(typeof json.error === 'string' ? json.error : JSON.stringify(json.error)) };
  }
  const r = parseRouting(json);
  let harvest = null;
  if (r.pipeline) harvest = await harvestAvailableProviders(modelId, r.pipeline, acc);
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
    ? [...new Set([r.finalProvider, ...(harvest || []), ...r.fallbacks].filter((provider) => PROVIDER_SLUG.test(provider || '')))]
    : [...new Set([r.finalProvider, ...r.fallbacks, ...(harvest || []), ...Object.keys(detail)].filter((provider) => PROVIDER_SLUG.test(provider || '')))];
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
    upstreamDiscovery: upstreams.length ? 'known' : 'unavailable',
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
function providerHealthState(modelId, upstream) {
  const meta = (META.models[modelId] ||= {});
  const statuses = (meta.upstreamStatus ||= {});
  const state = normalizeProviderHealthState(statuses[upstream]);
  statuses[upstream] = state;
  return state;
}
function projectModelMeta(meta) {
  if (!isPlainObject(meta)) return null;
  const upstreamStatus = {};
  for (const [provider, state] of Object.entries(isPlainObject(meta.upstreamStatus) ? meta.upstreamStatus : {})) {
    if (/^[a-z0-9][a-z0-9._/-]{0,199}$/i.test(provider)) upstreamStatus[provider] = normalizeProviderHealthState(state);
  }
  return { ...meta, upstreamStatus };
}
function updateProviderHealth(modelId, upstream, { success = false, classification = null, note = '', cooldownOverrideMs = null } = {}, now = Date.now()) {
  if (!upstream) return 'none';
  const previous = providerHealthState(modelId, upstream);
  if (success) {
    const action = previous.status !== 'ok' || previous.consecutiveFailures > 0 || previous.cooldownUntil > 0 ? 'recover' : 'success';
    (META.models[modelId].upstreamStatus ||= {})[upstream] = {
      ...previous, status: 'ok', checkedAt: now, lastSuccessAt: now,
      consecutiveFailures: 0, cooldownUntil: 0, failureClass: null, note: boundedProviderNote(note || 'success'),
    };
    return action;
  }
  const scope = classification?.scope;
  const failureClass = classification?.failureClass;
  const affectsProvider = scope === 'provider' || scope === 'unknown';
  if (!affectsProvider || !['rate_limit','server','network','timeout','unsupported'].includes(failureClass)) return 'none';
  const failures = Math.min(PROVIDER_FAILURE_COUNT_MAX, previous.consecutiveFailures + 1);
  let status = 'degraded', delayMs;
  if (failureClass === 'rate_limit') {
    status = 'limited';
    delayMs = classification.retryAfterMs ?? Math.min(30 * 60e3, 60e3 * (2 ** Math.min(20, failures - 1)));
  } else if (failureClass === 'unsupported') {
    status = 'bad'; delayMs = 60 * 60e3;
  } else {
    delayMs = Number.isInteger(cooldownOverrideMs) && cooldownOverrideMs > 0
      ? cooldownOverrideMs
      : Math.min(2 * 60e3, 15e3 * (2 ** Math.min(20, failures - 1)));
  }
  (META.models[modelId].upstreamStatus ||= {})[upstream] = {
    ...previous, status, checkedAt: now, lastFailureAt: now, consecutiveFailures: failures,
    cooldownUntil: now + delayMs, failureClass, note: boundedProviderNote(note || `${classification.evidence || 'failure'}:${failureClass}`),
  };
  return 'cooldown';
}

// 无已知渠道的 auto/unattributed 兼容请求若收到网关返回的可用清单，则只合并为后续请求的稳定探测顺序。
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
async function validateUpstreams(modelId, acc) {
  const meta = META.models[modelId] || {};
  const list = meta.upstreams || [];
  const pipeline = meta.pipeline;
  const results = {};
  const batch = 5;
  for (let i = 0; i < list.length; i += batch) {
    await Promise.all(list.slice(i, i + batch).map(async (slug) => {
      const t0 = Date.now();
      const base = { model: modelId, messages: [{ role: 'user', content: 'hi' }], max_tokens: 16 };
      const body = pipeline === 'planner'
        ? { ...base, providerOptions: { gateway: { only: [slug] } } }
        : { ...base, provider: { only: [slug] } };
      let response;
      try {
        response = await accountFetchJSON(`${config.upstreamBase}/chat/completions`, { headers: chatHeaders(acc.key), body: JSON.stringify(body) }, 60000, acc);
      } catch (error) {
        results[slug] = { status: 'unknown', accountFault: acc.proxyUrl ? 'proxy' : 'network', ms: Date.now() - t0, note: safeReason(error.message) };
        return;
      }
      const { status: httpStatus, json } = response;
      let status = 'unknown', accountFault = null, note = '';
      if (json?.error && !json?.data) {
        const msg = typeof json.error === 'string' ? json.error : JSON.stringify(json.error);
        status = classifyUpstreamError(msg);
        note = safeReason(msg);
        if (httpStatus === 401 || status === 'auth') { accountFault = 'auth'; status = 'unknown'; }
        else if (/quota\s*(?:exceeded|exhausted)|subscription\s*(?:limit|expired)/i.test(msg)) { accountFault = 'quota'; status = 'unknown'; }
        else if (status === 'limited') updateProviderHealth(modelId, slug, { classification: { scope: 'provider', evidence: 'probe_rate_limit', failureClass: 'rate_limit', retryAfterMs: null }, note });
        else if (status === 'bad') updateProviderHealth(modelId, slug, { classification: { scope: 'provider', evidence: 'probe_unsupported', failureClass: 'unsupported', retryAfterMs: null }, note });
      } else if (json?.data?.choices || json?.choices) {
        status = 'ok';
        updateProviderHealth(modelId, slug, { success: true, note: 'validation success' });
      }
      results[slug] = { status, ...(accountFault ? { accountFault } : {}), ms: Date.now() - t0, note };
    }));
  }
  (META.models[modelId] ||= {}).validatedAt = Date.now();
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

function normalizeUsage(raw) {
  if (!isPlainObject(raw)) return null;
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const read = (candidates) => {
    for (const [object, key] of candidates) if (isPlainObject(object) && own(object, key)) return Number.isSafeInteger(object[key]) && object[key] >= 0 ? object[key] : null;
    return null;
  };
  const inputTokens = read([[raw,'prompt_tokens'],[raw,'input_tokens'],[raw,'inputTokens']]);
  const outputTokens = read([[raw,'completion_tokens'],[raw,'output_tokens'],[raw,'outputTokens']]);
  const totalTokens = read([[raw,'total_tokens'],[raw,'totalTokens']]);
  const cacheCandidates = [[raw.prompt_tokens_details,'cached_tokens'],[raw.input_tokens_details,'cached_tokens'],[raw,'cache_read_input_tokens'],[raw,'cached_input_tokens'],[raw,'cachedInputTokens']];
  const cacheFieldPresent = cacheCandidates.some(([object,key]) => isPlainObject(object) && own(object,key));
  const cachedTokens = read(cacheCandidates);
  if ([inputTokens, outputTokens, totalTokens, cachedTokens].every((value) => value === null) && !cacheFieldPresent) return null;
  return { inputTokens, outputTokens, totalTokens, cachedTokens, cacheFieldPresent, cacheInputPairPresent: cacheFieldPresent && cachedTokens !== null && inputTokens !== null };
}
function addCounter(aggregate, key, amount = 1) {
  if (!amount || aggregate[key] === null) return;
  if (!Number.isSafeInteger(amount) || amount < 0 || aggregate[key] > Number.MAX_SAFE_INTEGER - amount) {
    aggregate[key] = null;
    if (!aggregate.overflowFields.includes(key)) aggregate.overflowFields.push(key);
  } else aggregate[key] += amount;
}
function addUsage(aggregate, usage) {
  if (!usage) return;
  addCounter(aggregate, 'usageRequests');
  for (const [known, token, value] of [['inputKnownRequests','inputTokens',usage.inputTokens],['outputKnownRequests','outputTokens',usage.outputTokens],['totalKnownRequests','totalTokens',usage.totalTokens]]) if (value !== null) { addCounter(aggregate, known); addCounter(aggregate, token, value); }
  if (usage.cacheFieldPresent && usage.cachedTokens !== null) { addCounter(aggregate, 'cacheKnownRequests'); addCounter(aggregate, 'cachedTokens', usage.cachedTokens); if (usage.cachedTokens > 0) addCounter(aggregate, 'cacheHitRequests'); }
  if (usage.cacheInputPairPresent) { addCounter(aggregate, 'cacheInputKnownRequests'); addCounter(aggregate, 'cacheInputTokens', usage.inputTokens); addCounter(aggregate, 'cacheInputCachedTokens', usage.cachedTokens); }
}
function addRoutingSignals(aggregate, affinityConfidence, trace = []) {
  if (affinityConfidence === 'explicit') addCounter(aggregate, 'explicitAffinityRequests');
  else if (affinityConfidence === 'fallback') addCounter(aggregate, 'fallbackAffinityRequests');
  if (trace.length > 1) addCounter(aggregate, 'providerFallbackRequests');
  if (trace.some((attempt) => attempt.providerCircuitAction === 'cooldown')) addCounter(aggregate, 'providerCircuitCooldownRequests');
  if (trace.some((attempt) => attempt.providerCircuitAction === 'half-open-success' || attempt.providerCircuitAction === 'half-open-failed')) addCounter(aggregate, 'providerHalfOpenRequests');
}
function mergeAggregate(target, delta) {
  for (const key of AGG_FIELDS) if (delta[key] !== null) addCounter(target, key, delta[key]); else { target[key] = null; if (!target.overflowFields.includes(key)) target.overflowFields.push(key); }
  target.lastUsedAt = Math.max(target.lastUsedAt, delta.lastUsedAt); target.lastErrorAt = Math.max(target.lastErrorAt, delta.lastErrorAt);
}
function mergeHealth(target, delta) { for (const key of HEALTH_FIELDS) target[key] += delta[key]; }
function classifyHealth(trace, { success = false, clientDisconnect = false } = {}) {
  if (clientDisconnect) return null;
  if (success) return { penaltyUnits: 0, class: null, error: false };
  const terminal = trace?.at(-1); if (!terminal) return null;
  const status = Number(terminal.normalizedStatus || terminal.status);
  if ([401,403].includes(status)) return { penaltyUnits: 10, class: 'auth', error: true };
  if (status === 429) return { penaltyUnits: 7, class: 'rateLimit', error: true };
  if (terminal.terminalOrigin === 'proxy' || terminal.terminalOrigin === 'network' || terminal.terminalOrigin === 'timeout' || terminal.upstreamStatus === 0) return { penaltyUnits: 6, class: 'networkProxy', error: true };
  if (status >= 500 && status <= 599) return { penaltyUnits: 4, class: 'server', error: true };
  if (status >= 400 && status <= 499) return null;
  return { penaltyUnits: 5, class: 'other', error: true };
}
function pruneStatistics(now = Date.now()) {
  const stats = META.statistics, minMinute = Math.floor(now / 60000) - 1439;
  stats.minuteBuckets = stats.minuteBuckets.filter((bucket) => bucket.minute >= minMinute);
  for (const [id, minute] of Object.entries(stats.recentCoverage.accountIncompleteAt)) if (minute < minMinute) delete stats.recentCoverage.accountIncompleteAt[id];
  for (const [id, minute] of Object.entries(stats.recentCoverage.modelIncompleteAt)) if (minute < minMinute) delete stats.recentCoverage.modelIncompleteAt[id];
  let accountCells = stats.minuteBuckets.reduce((sum,bucket) => sum + new Set([...Object.keys(bucket.accounts),...Object.keys(bucket.health)]).size, 0);
  for (const bucket of stats.minuteBuckets) {
    if (accountCells <= MAX_ACCOUNT_MINUTE_CELLS) break;
    for (const id of new Set([...Object.keys(bucket.accounts),...Object.keys(bucket.health)])) {
      if (accountCells-- <= MAX_ACCOUNT_MINUTE_CELLS) break;
      delete bucket.accounts[id]; delete bucket.health[id]; stats.recentCoverage.droppedAccountMinuteCells++;
      stats.recentCoverage.accountIncompleteAt[id] = Math.max(stats.recentCoverage.accountIncompleteAt[id] || 0, bucket.minute);
    }
  }
  let modelCells = stats.minuteBuckets.reduce((sum,bucket) => sum + Object.keys(bucket.models).length, 0);
  for (const bucket of stats.minuteBuckets) {
    if (modelCells <= MAX_MODEL_MINUTE_CELLS) break;
    for (const id of Object.keys(bucket.models)) {
      if (modelCells-- <= MAX_MODEL_MINUTE_CELLS) break;
      delete bucket.models[id]; stats.recentCoverage.droppedModelMinuteCells++;
      stats.recentCoverage.modelIncompleteAt[id] = Math.max(stats.recentCoverage.modelIncompleteAt[id] || 0, bucket.minute);
    }
  }
}
function commitStatistics({ ts = Date.now(), modelId = null, globalError = false, usage = null, segments = [], clientDisconnect = false, affinityConfidence = 'none' }) {
  const stats = META.statistics; pruneStatistics(ts);
  const minute = Math.floor(ts / 60000);
  let bucket = stats.minuteBuckets.at(-1);
  if (!bucket || bucket.minute !== minute) { bucket = { minute, global: emptyAggregate(), accounts: {}, health: {}, models: {} }; stats.minuteBuckets.push(bucket); }
  const globalDelta = emptyAggregate(); addCounter(globalDelta, 'requests'); globalDelta.lastUsedAt = ts;
  if (globalError) { addCounter(globalDelta, 'errors'); globalDelta.lastErrorAt = ts; }
  const globalTrace = segments.flatMap((segment) => segment.trace || []);
  addUsage(globalDelta, usage); addRoutingSignals(globalDelta, affinityConfidence, globalTrace); mergeAggregate(stats.lifetime.global, globalDelta); mergeAggregate(bucket.global, globalDelta);
  if (validStatisticModelId(modelId)) mergeAggregate(aggregateCell(bucket.models, modelId), globalDelta);
  const currentIds = new Set(config.accounts.map((account) => account.id));
  for (const segment of new Map(segments.filter((s) => currentIds.has(s.accountId)).map((s) => [s.accountId,s])).values()) {
    const delta = emptyAggregate(); addCounter(delta, 'requests'); delta.lastUsedAt = ts;
    if (segment.error) { addCounter(delta, 'errors'); delta.lastErrorAt = ts; }
    if (segment.usage) addUsage(delta, segment.usage);
    addRoutingSignals(delta, affinityConfidence, segment.trace || []);
    const lifetime = aggregateCell(stats.lifetime.accounts, segment.accountId); mergeAggregate(lifetime, delta);
    const recent = aggregateCell(bucket.accounts, segment.accountId); mergeAggregate(recent, delta);
    const result = classifyHealth(segment.trace, { success: segment.success, clientDisconnect });
    if (result) { const hd = emptyHealth(); hd.results = 1; hd.penaltyUnits = result.penaltyUnits; if (result.error) hd.errors = 1; if (result.class) hd[result.class] = 1; mergeHealth((bucket.health[segment.accountId] ||= emptyHealth()), hd); }
  }
  pruneStatistics(ts); saveMeta();
}
function aggregateRange(accountId = null, now = Date.now()) {
  const out = emptyAggregate(), health = emptyHealth(), min = Math.floor(now / 60000) - 1439;
  for (const bucket of META.statistics.minuteBuckets) if (bucket.minute >= min) {
    const aggregate = accountId ? bucket.accounts[accountId] : bucket.global; if (aggregate) mergeAggregate(out, aggregate);
    if (accountId && bucket.health[accountId]) mergeHealth(health, bucket.health[accountId]);
  }
  return { aggregate: out, health };
}
function aggregateModelRange(modelId, now = Date.now()) {
  const aggregate = emptyAggregate(), min = Math.floor(now / 60000) - 1439;
  for (const bucket of META.statistics.minuteBuckets) if (bucket.minute >= min && Object.hasOwn(bucket.models, modelId)) mergeAggregate(aggregate, bucket.models[modelId]);
  return aggregate;
}
function modelCoverage(modelId, now = Date.now()) {
  const min = Math.floor(now / 60000) - 1439, coverage = META.statistics.recentCoverage;
  const incompleteAt = Object.hasOwn(coverage.modelIncompleteAt, modelId) ? coverage.modelIncompleteAt[modelId] : null;
  const fromMinute = Math.max(min, coverage.modelTrackingStartedMinute, incompleteAt === null ? min : incompleteAt + 1);
  return { complete: coverage.modelTrackingStartedMinute <= min && incompleteAt === null, from: fromMinute * 60000 };
}
function routingCoverage(now = Date.now()) {
  const min = Math.floor(now / 60000) - 1439, start = META.statistics.recentCoverage.routingTrackingStartedMinute;
  return { complete: start <= min, from: Math.max(min, start) * 60000 };
}
function statisticsModelIds() {
  const ids = new Set([...(config.knownModels || []), ...Object.keys(config.perModel || {})]);
  for (const account of config.accounts || []) for (const id of Object.keys(account.perModel || {})) ids.add(id);
  for (const bucket of META.statistics.minuteBuckets) for (const id of Object.keys(bucket.models)) ids.add(id);
  return [...ids].filter(validStatisticModelId);
}
function ratio(numerator, denominator, valid = true) { return valid && Number.isSafeInteger(numerator) && Number.isSafeInteger(denominator) && denominator > 0 ? numerator / denominator : null; }
function projectAggregate(aggregate) {
  return { ...aggregate, cacheTokenRatio: ratio(aggregate.cacheInputCachedTokens, aggregate.cacheInputTokens, aggregate.cacheInputCachedTokens <= aggregate.cacheInputTokens), cacheHitRequestRate: ratio(aggregate.cacheHitRequests, aggregate.cacheKnownRequests) };
}
function healthProjection(account, now = Date.now()) {
  const { health } = aggregateRange(account.id, now), incomplete = Object.prototype.hasOwnProperty.call(META.statistics.recentCoverage.accountIncompleteAt, account.id);
  const state = getAccountState(account.id); let status, score = health.results ? 100 - (health.penaltyUnits / 10 / health.results * 100) : null;
  if (account.enabled === false) status = 'disabled'; else if (state?.banned) status = 'banned'; else if (state?.cooldownUntil > now) status = 'cooling'; else if (incomplete || health.results < 5) { status = 'insufficient'; score = null; } else if (score >= 80) status = 'available'; else if (score >= 50) status = 'degraded'; else status = 'unhealthy';
  return { status, score, results: health.results, penaltyUnits: health.penaltyUnits, coverageComplete: !incomplete };
}
const AFFINITY_KEY_TYPES = new Set(['parent_session','parent_thread','parent_conversation','parent_agent','prompt_cache_key','session_id','thread_id','conversation_id','agent_id','message_hmac','none']);
const AFFINITY_CONFIDENCE = new Set(['explicit','fallback','none']);
const UPSTREAM_PROMPT_KEY_SOURCES = new Set(['caller_prompt_cache_key','caller_session_id','caller_invalid','derived_codex','derived_claude','none']);
function record(modelId, info, detail = detailContext.getStore()) {
  const ts = Date.now();
  META.models[modelId] = { ...(META.models[modelId] || {}), provider: info.provider, canonical: info.canonical, lastMs: info.ms };
  const result = ['success', 'client_cancelled', 'failed'].includes(info.result) ? info.result : (info.error ? 'failed' : 'success');
  const { sensitiveValues: _sensitiveValues, ...safeInfo } = info;
  const legacy = {
    ts, model: modelId, ...safeInfo, result,
    error: safeInfo.error ? safeReason(safeInfo.error, info.sensitiveValues) : safeInfo.error,
    trace: Array.isArray(safeInfo.trace) ? safeInfo.trace.map((attempt) => ({ ...attempt, note: safeReason(attempt.note, info.sensitiveValues) })) : safeInfo.trace,
  };
  recentHistory.unshift(legacy); if (recentHistory.length > 100) recentHistory.length = 100;
  const request = {
    ts, requestId: info.requestId || crypto.randomUUID(), requestedModel: info.requestedModel || modelId,
    resolvedModel: info.resolvedModel || modelId, stream: !!info.stream, strategy: info.strategy || config.accountMode,
    sessionSource: info.sessionSource || null,
    affinityKeyType: AFFINITY_KEY_TYPES.has(info.affinityKeyType) ? info.affinityKeyType : 'none',
    affinityConfidence: AFFINITY_CONFIDENCE.has(info.affinityConfidence) ? info.affinityConfidence : 'none',
    upstreamPromptCacheKeySource: UPSTREAM_PROMPT_KEY_SOURCES.has(info.upstreamPromptCacheKeySource) ? info.upstreamPromptCacheKeySource : 'none',
    upstreamPromptCacheKeyApplied: info.upstreamPromptCacheKeyApplied === true,
    providerOrderOverridesSticky: info.providerOrderOverridesSticky === true,
    cacheHit: typeof info.cacheHit === 'boolean' ? info.cacheHit : null,
    preferredAccountId: info.preferredAccountId || null,
    preferredAccountName: info.preferredAccountName || null, accountId: info.accountId || null, accountName: info.account || null,
    selectionReason: info.selectionReason || null, overflow: !!info.overflow,
    pipelineSteps: Array.isArray(info.pipeline?.diagnostics) ? info.pipeline.diagnostics.slice(0, 8) : [], selectedQuotaPool: info.pipeline?.selectedQuota || null, selectedHealthLayer: info.pipeline?.selectedHealth || null, capacityFallback: !!info.pipeline?.capacityFallback,
    cachePoolSize: Number.isInteger(info.pipeline?.cachePoolSize) ? info.pipeline.cachePoolSize : configuredCachePoolSize(), cachePoolTier: ['active','standby'].includes(info.pipeline?.cachePoolTier) ? info.pipeline.cachePoolTier : null, cachePoolFallback: info.pipeline?.cachePoolFallback === true,
    targetProviders: Array.isArray(info.targets) ? info.targets : [], actualProvider: info.provider || null,
    attempts: Array.isArray(info.trace) ? info.trace.map((t) => ({
      provider: t.upstream || 'auto', status: t.status, upstreamStatus: t.upstreamStatus, ms: t.ms, account: t.account, action: t.action || null,
      providerCircuitAction: ['cooldown','half-open-success','half-open-failed'].includes(t.providerCircuitAction) ? t.providerCircuitAction : null,
      errorScope: t.errorScope || null, scopeEvidence: t.scopeEvidence || null, failureClass: t.failureClass || null,
      healthAction: t.healthAction || 'none', retryAfterMs: t.retryAfterMs ?? null,
      responseContentType: t.responseContentType || null, responseBytes: Number.isSafeInteger(t.responseBytes) ? t.responseBytes : null,
    })) : [],
    status: result === 'client_cancelled' ? 499 : result === 'success' ? 200 : (info.normalizedStatus || 502), result, upstreamStatus: info.upstreamStatus ?? null,
    durationMs: Number(info.ms) || 0, accountActions: info.accountActions || [], switched: (info.accountPath || []).length > 1, appliedHeaderNames: info.appliedHeaderNames || [],
    errorCategory: info.errorCategory || (result === 'failed' && info.error ? (info.proxyError ? 'proxy' : 'upstream') : null),
  };
  if (detail?.requestId === request.requestId) detail.result = result;
  const writes = [requestLogs.append(request)];
  for (const [attemptIndex, attempt] of (result === 'client_cancelled' ? [] : (info.trace || [])).entries()) {
    if (attempt.status === 200 && !attempt.action) continue;
    writes.push(errorLogs.append({ ts, requestId: request.requestId, requestedModel: request.requestedModel, resolvedModel: request.resolvedModel,
      accountId: attempt.accountId || info.accountId || null, accountName: attempt.account || info.account || null, attemptIndex,
      targetProvider: attempt.upstream || null, providerPath: (info.trace || []).slice(0, attemptIndex + 1).map((t) => t.upstream || 'auto'),
      status: attempt.normalizedStatus || attempt.status, upstreamStatus: attempt.upstreamStatus ?? null,
      category: attempt.upstreamStatus === 0 ? (info.proxyError ? 'proxy' : 'network') : 'upstream', reason: safeReason(attempt.note, info.sensitiveValues), accountAction: attempt.action || null,
      errorScope: attempt.errorScope || null, scopeEvidence: attempt.scopeEvidence || null, failureClass: attempt.failureClass || null,
      healthAction: attempt.healthAction || 'none', retryAfterMs: attempt.retryAfterMs ?? null,
      responseContentType: attempt.responseContentType || null, responseBytes: Number.isSafeInteger(attempt.responseBytes) ? attempt.responseBytes : null }));
  }
  void Promise.all(writes);
  try { saveMeta(); } catch (error) { console.error(`[诊断] metadata 持久化失败：${safeReason(error.message)}`); }
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
function firstBodyIdentity(body, paths) {
  for (const [path, keyType] of paths) {
    let cur = body;
    for (const part of path.split('.')) cur = cur && typeof cur === 'object' ? cur[part] : undefined;
    const value = validIdentityValue(cur);
    if (value) return { value, keyType };
  }
  return null;
}
function userIdSessionIdentity(v, parent = false) {
  const s = validIdentityValue(v);
  if (!s) return null;
  if (s.trim().startsWith('{')) {
    const j = safeJsonParse(s);
    if (j && typeof j === 'object') {
      const keys = parent
        ? [['parent_session_id','parent_session'],['parent_agent_id','parent_agent'],['parent_thread_id','parent_thread'],['parent_conversation_id','parent_conversation']]
        : [['session_id','session_id'],['claude_session_id','session_id'],['agent_id','agent_id'],['thread_id','thread_id'],['conversation_id','conversation_id']];
      for (const [key, keyType] of keys) { const value = validIdentityValue(j[key]); if (value) return { value, keyType }; }
    }
  }
  if (!parent && /^claude[-_:]/i.test(s)) return { value: s, keyType: 'session_id' };
  return null;
}
function hmacIdentity(source, value, keyType = 'session_id', confidence = 'explicit') {
  // Equal trusted parent/current identifiers must route together even when one
  // side is carried by a protocol-specific header and the other by a generic one.
  return { source, keyType, confidence, fingerprint: hmacHex(`session\0${value}`) };
}
function detectClientProtocol(req, body = {}) {
  if (body.prompt_cache_key || reqHeader(req, 'X-Codex-Turn-Metadata') || reqHeader(req, 'Originator') || reqHeader(req, 'X-Codex-Parent-Thread-Id')) return 'codex';
  if (body.metadata?.user_id || reqHeader(req, 'X-Claude-Code-Session-Id') || reqHeader(req, 'X-Claude-Code-Agent-Id') || reqHeader(req, 'X-Claude-Code-Parent-Agent-Id') || reqHeader(req, 'Anthropic-Version')) return 'claude';
  return 'generic';
}
function firstIdentity(candidates) {
  for (const [source, value, keyType] of candidates) {
    const valid = validIdentityValue(value);
    if (valid) return hmacIdentity(source, valid, keyType);
  }
  return null;
}
function extractSessionIdentity(req, body) {
  const protocol = detectClientProtocol(req, body);
  const turnMeta = protocol === 'codex' ? (safeJsonParse(reqHeader(req, 'X-Codex-Turn-Metadata')) || {}) : {};
  let identity = null;
  if (protocol === 'codex') {
    identity = firstIdentity([
      ['codex_parent', reqHeader(req, 'X-Codex-Parent-Thread-Id'), 'parent_thread'],
      ['codex_parent', turnMeta.parent_thread_id || turnMeta.parent_session_id || turnMeta.parent_conversation_id, 'parent_session'],
      ['codex_body', body?.prompt_cache_key, 'prompt_cache_key'],
      ['codex_header', reqHeader(req, 'Session-Id') || reqHeader(req, 'Session_id'), 'session_id'],
      ['codex_header', reqHeader(req, 'Thread-Id') || reqHeader(req, 'Thread_id'), 'thread_id'],
      ['codex_metadata', turnMeta.session_id || turnMeta.thread_id || turnMeta.conversation_id, 'session_id'],
    ]);
  } else if (protocol === 'claude') {
    const parentMetadata = userIdSessionIdentity(body?.metadata?.user_id, true);
    const currentMetadata = userIdSessionIdentity(body?.metadata?.user_id, false);
    identity = firstIdentity([
      ['claude_parent', reqHeader(req, 'X-Claude-Code-Parent-Agent-Id'), 'parent_agent'],
      ['claude_parent', parentMetadata?.value, parentMetadata?.keyType],
      ['claude_header', reqHeader(req, 'X-Claude-Code-Session-Id'), 'session_id'],
      ['claude_header', reqHeader(req, 'X-Claude-Code-Agent-Id'), 'agent_id'],
      ['claude_metadata', currentMetadata?.value, currentMetadata?.keyType],
    ]);
  }
  const genericBody = firstBodyIdentity(body, [['session_id','session_id'],['conversation_id','conversation_id'],['thread_id','thread_id'],['metadata.session_id','session_id'],['metadata.conversation_id','conversation_id'],['metadata.thread_id','thread_id']]);
  identity ||= firstIdentity([
    ['generic_parent', reqHeader(req, 'X-Parent-Session-ID') || reqHeader(req, 'X-Parent-Session-Affinity'), 'parent_session'],
    ['generic_body', genericBody?.value, genericBody?.keyType],
    ['generic_header', reqHeader(req, 'Session-Id') || reqHeader(req, 'Session_id') || reqHeader(req, 'X-Http-Session-Id') || reqHeader(req, 'X-Session-ID') || reqHeader(req, 'X-Session-Affinity') || reqHeader(req, 'X-Slot-Session-Id'), 'session_id'],
    ['generic_header', reqHeader(req, 'Thread-Id') || reqHeader(req, 'Thread_id') || reqHeader(req, 'X-Thread-Id'), 'thread_id'],
    ['generic_header', reqHeader(req, 'X-Conversation-Id'), 'conversation_id'],
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
      return hmacIdentity('message_hmac', stable, 'message_hmac', 'fallback');
    }
  }
  return { source: 'roundrobin', keyType: 'none', confidence: 'none', fingerprint: null };
}
function prepareChatAffinity(body, identity) {
  const own = (key) => Object.prototype.hasOwnProperty.call(body, key);
  if (own('prompt_cache_key')) {
    const valid = validIdentityValue(body.prompt_cache_key);
    return { body, source: valid ? 'caller_prompt_cache_key' : 'caller_invalid', usable: !!valid };
  }
  if (own('session_id')) {
    const valid = validIdentityValue(body.session_id);
    return { body, source: valid ? 'caller_session_id' : 'caller_invalid', usable: !!valid };
  }
  const protocol = String(identity?.source || '').split('_', 1)[0];
  if (identity?.confidence === 'explicit' && identity.fingerprint && (protocol === 'codex' || protocol === 'claude')) {
    const promptCacheKey = hmacHex(`upstream-prompt-cache\0${identity.fingerprint}`);
    return { body: { ...body, prompt_cache_key: promptCacheKey }, source: protocol === 'codex' ? 'derived_codex' : 'derived_claude', usable: true };
  }
  return { body, source: 'none', usable: false };
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
const proxyAgents = new Map();
function proxyAgentFor(proxyUrl) {
  if (!proxyUrl) return undefined;
  if (proxyAgents.has(proxyUrl)) return proxyAgents.get(proxyUrl);
  const protocol = new URL(proxyUrl).protocol;
  const agent = protocol === 'socks5:' || protocol === 'socks5h:' ? new SocksProxyAgent(proxyUrl) : new HttpsProxyAgent(proxyUrl);
  proxyAgents.set(proxyUrl, agent);
  return agent;
}
function clineRequestJSON(url, { headers = {}, body, signal, timeoutMs = 120000, account = null, proxyUrl = '', method = 'POST', maxResponseBytes = Infinity } = {}) {
  return clineRequest(url, { headers, body, signal, timeoutMs, account, proxyUrl, method }).then(async (res) => ({ status: res.status, headers: res.headers, text: await streamToString(res.body, maxResponseBytes) }));
}
function clineRequest(url, { headers = {}, body, signal, timeoutMs = 120000, account = null, proxyUrl = '', method = 'POST' } = {}) {
  const root = detailContext.getStore();
  const attempt = method === 'POST' && url === `${config.upstreamBase}/chat/completions` ? root?.attempt({ url, method, headers, body: body || '', account, proxyUrl }) : null;
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const data = Buffer.isBuffer(body) ? body : Buffer.from(String(body || ''));
    let settled = false;
    let response = null;
    const onAbort = () => { response?.destroy(new Error('aborted')); req.destroy(new Error('aborted')); };
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    const fail = (error) => { cleanup(); if (!settled) { settled = true; reject(error); } };
    const agent = proxyAgentFor(proxyUrl || account?.proxyUrl || '');
    const requestHeaders = { ...headers }; if (method !== 'GET') requestHeaders['Content-Length'] = data.length;
    if (attempt) attempt.headers = requestHeaders;
    const req = lib.request({ protocol: u.protocol, hostname: u.hostname, port: u.port, path: `${u.pathname}${u.search}`, method, headers: requestHeaders, ...(agent ? { agent } : {}) }, (res) => {
      response = res;
      res.once('end', cleanup);
      res.once('close', cleanup);
      if (attempt) { attempt.status = res.statusCode || 502; attempt.responseHeaders = res.headers; }
      const responseBody = attempt ? observeStream(res, attempt.output) : res;
      if (!settled) { settled = true; resolve({ status: res.statusCode || 502, headers: res.headers, body: responseBody }); }
    });
    if (attempt) attempt.headers = req.getHeaders();
    req.on('error', fail);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('upstream timeout')));
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    req.end(method === 'GET' ? undefined : data);
  }).catch((error) => { if (attempt) attempt.state = 'transport-failed'; throw error; });
}
function streamToString(stream, maxBytes = Infinity) {
  if (stream.readableEnded) return Promise.resolve('');
  if (stream.destroyed) return Promise.reject(new Error('upstream response closed early'));
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0, settled = false;
    const cleanup = () => { stream.off('data', onData); stream.off('end', onEnd); stream.off('error', onError); stream.off('close', onClose); };
    const finish = (fn, value) => { if (settled) return; settled = true; cleanup(); fn(value); };
    const onData = (c) => {
      const chunk = Buffer.from(c); size += chunk.length;
      if (size > maxBytes) { const error = new Error('upstream response exceeds limit'); error.code = 'RESPONSE_TOO_LARGE'; finish(reject, error); stream.destroy(); return; }
      chunks.push(chunk);
    };
    const onEnd = () => finish(resolve, Buffer.concat(chunks).toString('utf8'));
    const onError = (error) => finish(reject, error);
    const onClose = () => { if (!stream.readableEnded) finish(reject, new Error('upstream response closed early')); };
    stream.on('data', onData); stream.once('end', onEnd); stream.once('error', onError); stream.once('close', onClose); stream.resume();
  });
}
const quotaGenerations = new Map(), quotaFailureCounts = new Map(), quotaSuccessVersions = new Map(), quotaJobs = new Map(), quotaQueue = [];
let quotaTimer = null, quotaCursor = 0, quotaRunning = 0, quotaRoutingEpoch = 1, quotaScheduleVersion = 0, quotaPageBatches = 0;
const QUOTA_TIMEOUT_MS = process.env.NODE_ENV === 'test' ? Math.max(20, Number(process.env.CLINE_PASS_TEST_QUOTA_TIMEOUT_MS) || 15000) : 15000;
const QUOTA_SUCCESS_MS = process.env.NODE_ENV === 'test' ? Math.max(50, Number(process.env.CLINE_PASS_TEST_QUOTA_SUCCESS_MS) || 300000) : 300000;
const QUOTA_FAILURE_MS = process.env.NODE_ENV === 'test' ? Math.max(50, Number(process.env.CLINE_PASS_TEST_QUOTA_FAILURE_MS) || 60000) : 60000;
const QUOTA_GLOBAL_LIMIT = 2, QUOTA_PAGE_BATCH_LIMIT = 16;
function quotaFailureCategory(error, status, account) {
  if (status === 401 || status === 403) return 'auth'; if (status === 429) return 'rate_limit'; if (status >= 500) return 'server'; if (status) return 'http';
  if (error?.code === 'RESPONSE_TOO_LARGE') return 'schema';
  if (/timeout/i.test(error?.message || '')) return 'timeout'; return account.proxyUrl ? 'proxy' : 'network';
}
function quotaFailureDelay(id) { return Math.min(15 * QUOTA_FAILURE_MS, QUOTA_FAILURE_MS * (2 ** (quotaFailureCounts.get(id) || 0))); }
function successfulQuotaTime(q, now = Date.now()) {
  const value = q?.lastSuccessAt;
  return Number.isSafeInteger(value) && value > 0 && value <= now && value === q?.snapshot?.fetchedAt ? value : null;
}
function quotaPageOwnerHasNewSuccess(token, id, lastSuccessAt) {
  return !!lastSuccessAt && (quotaSuccessVersions.get(id) || 0) > (token.successVersions.get(id) || 0);
}
function quotaPageOwnerRequiresForce(token, id, lastSuccessAt) {
  return token.active && token.force && !quotaPageOwnerHasNewSuccess(token, id, lastSuccessAt);
}
function quotaDemandOutcome(account, { force = false, pageToken = null } = {}, now = Date.now()) {
  if (!account?.key) return 'skipped';
  if (account.enabled === false) return 'skipped';
  const q = META.accountQuotas?.[account.id];
  if (q?.errorCategory && q.lastAttemptAt && now < q.lastAttemptAt + quotaFailureDelay(account.id)) return 'deferred';
  const lastSuccessAt = successfulQuotaTime(q, now);
  const pageSuccess = pageToken?.force && quotaPageOwnerHasNewSuccess(pageToken, account.id, lastSuccessAt);
  const forceRequired = pageToken ? quotaPageOwnerRequiresForce(pageToken, account.id, lastSuccessAt) : force;
  if (pageSuccess || (!forceRequired && lastSuccessAt && now - lastSuccessAt < QUOTA_SUCCESS_MS)) return 'cached';
  return null;
}
function quotaJobAccount(job) {
  const account = config.accounts.find((item) => item.id === job.id);
  return account && account.enabled !== false && account.key && account.key === job.key && (account.proxyUrl || '') === job.proxyUrl && (quotaGenerations.get(job.id) || 0) === job.generation ? account : null;
}
function quotaJobHasOwner(job) {
  if (job.cancelled) return false;
  if (job.routingEpoch === quotaRoutingEpoch && quotaRoutingEnabled()) return true;
  for (const token of job.pageOwners) if (token.active) return true;
  return false;
}
function detachQuotaJob(job) {
  for (const token of job.pageOwners) token.jobs.delete(job);
  job.pageOwners.clear(); job.routingEpoch = null;
}
function finishQueuedQuotaJob(job, outcome = 'cancelled') {
  if (job.state !== 'queued') return;
  job.state = 'done';
  const queuedIndex = quotaQueue.indexOf(job); if (queuedIndex >= 0) quotaQueue.splice(queuedIndex, 1);
  if (quotaJobs.get(job.id) === job) quotaJobs.delete(job.id);
  detachQuotaJob(job); job.resolve(outcome);
}
function cancelQuotaJob(job) {
  if (!job || job.cancelled) return;
  job.cancelled = true;
  if (job.state === 'queued') finishQueuedQuotaJob(job);
  else if (job.state === 'running') job.controller?.abort();
}
function invalidateQuotaAccount(id, { clearSnapshot = false, deleted = false } = {}) {
  quotaGenerations.set(id, (quotaGenerations.get(id) || 0) + 1);
  quotaFailureCounts.delete(id);
  const job = quotaJobs.get(id);
  if (job) { detachQuotaJob(job); cancelQuotaJob(job); }
  if (clearSnapshot) delete META.accountQuotas[id];
  if (deleted) quotaSuccessVersions.delete(id);
}
function withdrawRoutingQuotaOwnership() {
  for (const job of quotaJobs.values()) if (job.routingEpoch !== null) {
    job.routingEpoch = null;
    if (!quotaJobHasOwner(job)) cancelQuotaJob(job);
  }
}
function advanceQuotaRoutingEpoch() { quotaRoutingEpoch++; withdrawRoutingQuotaOwnership(); }
function attachQuotaOwner(job, source) {
  if (source.pageToken) {
    if (!source.pageToken.active) return false;
    source.pageToken.force = !!source.force;
    job.pageOwners.add(source.pageToken); source.pageToken.jobs.add(job);
  } else if (source.routingEpoch === quotaRoutingEpoch && quotaRoutingEnabled()) job.routingEpoch = source.routingEpoch;
  else return false;
  return true;
}
function awaitQuotaJob(job, source) {
  return source.pageToken ? Promise.race([job.promise, source.pageToken.cancelPromise.then(() => 'cancelled')]) : job.promise;
}
async function requestQuota(id, source) {
  while (true) {
    if (source.pageToken && !source.pageToken.active) return 'cancelled';
    const account = config.accounts.find((item) => item.id === id);
    if (!account || !account.key || account.enabled === false) return 'skipped';
    const generation = quotaGenerations.get(id) || 0;
    const existing = quotaJobs.get(id);
    if (existing) {
      if (existing.cancelled || existing.generation !== generation || existing.key !== account.key || existing.proxyUrl !== (account.proxyUrl || '')) {
        const result = await awaitQuotaJob(existing, source);
        if (result === 'cancelled' && source.pageToken && !source.pageToken.active) return result;
        continue;
      }
      if (!attachQuotaOwner(existing, source)) return 'cancelled';
      return await awaitQuotaJob(existing, source);
    }
    const immediate = quotaDemandOutcome(account, source);
    if (immediate) return immediate;
    let resolve;
    const job = { id, generation, key: account.key, proxyUrl: account.proxyUrl || '', state: 'queued', cancelled: false, controller: null, pageOwners: new Set(), routingEpoch: null, promise: null, resolve: null };
    job.promise = new Promise((done) => { resolve = done; }); job.resolve = resolve;
    if (!attachQuotaOwner(job, source)) return 'cancelled';
    quotaJobs.set(id, job); quotaQueue.push(job); pumpQuotaQueue();
    return await awaitQuotaJob(job, source);
  }
}
async function runQuotaJob(job, account) {
  const attemptedAt = Date.now();
  let snapshot = null, errorCategory = null, timedOut = false;
  job.controller = new AbortController();
  const deadline = setTimeout(() => { timedOut = true; job.controller.abort(); }, QUOTA_TIMEOUT_MS); deadline.unref?.();
  try {
    const result = await clineRequestJSON(`${config.upstreamBase.replace(/\/$/,'')}/users/me/plan/usage-limits`, { method: 'GET', headers: { Accept: 'application/json', Authorization: `Bearer ${job.key}` }, signal: job.controller.signal, timeoutMs: QUOTA_TIMEOUT_MS, account, proxyUrl: job.proxyUrl, maxResponseBytes: 256 * 1024 });
    if (result.status < 200 || result.status >= 300) errorCategory = quotaFailureCategory(null, result.status, account);
    else {
      let json;
      try { json = JSON.parse(result.text); } catch { errorCategory = 'json'; }
      if (!errorCategory) try { snapshot = parseQuotaPayload(json, Date.now()); } catch { errorCategory = 'schema'; }
    }
  } catch (error) { errorCategory = timedOut ? 'timeout' : quotaFailureCategory(error, 0, account); }
  finally { clearTimeout(deadline); }
  if (!quotaJobAccount(job) || !quotaJobHasOwner(job)) return 'cancelled';
  const state = (META.accountQuotas[job.id] ||= { snapshot: null, lastAttemptAt: 0, lastSuccessAt: 0, errorCategory: null });
  state.lastAttemptAt = attemptedAt;
  if (snapshot) { state.snapshot = snapshot; state.lastSuccessAt = snapshot.fetchedAt; state.errorCategory = null; quotaFailureCounts.delete(job.id); quotaSuccessVersions.set(job.id, (quotaSuccessVersions.get(job.id) || 0) + 1); }
  else { state.errorCategory = errorCategory || 'schema'; quotaFailureCounts.set(job.id, Math.min(4, (quotaFailureCounts.get(job.id) || 0) + 1)); }
  try { saveMeta(); } catch (error) { console.error(`[额度] 持久化失败：${safeReason(error.message)}`); }
  return snapshot ? 'refreshed' : 'failed';
}
function pumpQuotaQueue() {
  while (quotaRunning < QUOTA_GLOBAL_LIMIT && quotaQueue.length) {
    const job = quotaQueue.shift();
    if (quotaJobs.get(job.id) !== job || job.state !== 'queued') continue;
    const account = quotaJobAccount(job);
    if (!account || !quotaJobHasOwner(job)) { cancelQuotaJob(job); continue; }
    const lastSuccessAt = successfulQuotaTime(META.accountQuotas?.[job.id]), pageOwners = [...job.pageOwners].filter((token) => token.active);
    const force = pageOwners.some((token) => quotaPageOwnerRequiresForce(token, job.id, lastSuccessAt));
    const pageSuccess = !META.accountQuotas?.[job.id]?.errorCategory && job.routingEpoch === null && pageOwners.length > 0 && pageOwners.every((token) => token.force && quotaPageOwnerHasNewSuccess(token, job.id, lastSuccessAt));
    const immediate = pageSuccess ? 'cached' : quotaDemandOutcome(account, { force });
    if (immediate) { finishQueuedQuotaJob(job, immediate); continue; }
    job.state = 'running'; quotaRunning++;
    void runQuotaJob(job, account).then((outcome) => {
      job.state = 'done'; quotaRunning--;
      if (quotaJobs.get(job.id) === job) quotaJobs.delete(job.id);
      detachQuotaJob(job); job.resolve(outcome); pumpQuotaQueue();
    }, () => {
      job.state = 'done'; quotaRunning--;
      if (quotaJobs.get(job.id) === job) quotaJobs.delete(job.id);
      detachQuotaJob(job); job.resolve('failed'); pumpQuotaQueue();
    });
  }
}
function cancelQuotaPageToken(token) {
  if (!token.active) return;
  token.active = false; token.resolveCancel(); clearTimeout(token.deadline);
  for (const job of [...token.jobs]) {
    job.pageOwners.delete(token); token.jobs.delete(job);
    if (!quotaJobHasOwner(job)) cancelQuotaJob(job);
  }
}
function createQuotaPageToken() {
  let resolveCancel;
  const token = { active: true, force: false, startedAt: Date.now(), successVersions: new Map(quotaSuccessVersions), jobs: new Set(), deadline: null, cancelPromise: new Promise((resolve) => { resolveCancel = resolve; }), resolveCancel };
  quotaPageBatches++; return token;
}
function releaseQuotaPageToken(token) { cancelQuotaPageToken(token); quotaPageBatches = Math.max(0, quotaPageBatches - 1); }
function scheduleQuotaRefresh() {
  const version = ++quotaScheduleVersion, epoch = quotaRoutingEpoch;
  clearTimeout(quotaTimer); quotaTimer = null;
  if (!quotaRoutingEnabled()) return;
  const arm = () => {
    if (version !== quotaScheduleVersion || epoch !== quotaRoutingEpoch || !quotaRoutingEnabled()) return;
    const run = async () => {
      if (version !== quotaScheduleVersion || epoch !== quotaRoutingEpoch || !quotaRoutingEnabled()) return;
      quotaTimer = null;
      const accounts = hrwRank(config.accounts.filter((account) => account.enabled !== false && account.key), 'quota-refresh');
      const dueAccounts = accounts.filter((account) => quotaDemandOutcome(account) === null);
      const start = quotaCursor % Math.max(1, dueAccounts.length), due = [...dueAccounts.slice(start), ...dueAccounts.slice(0, start)].slice(0, 2);
      quotaCursor++; await Promise.all(due.map((account) => requestQuota(account.id, { routingEpoch: epoch })));
      arm();
    };
    quotaTimer = setTimeout(run, process.env.NODE_ENV === 'test' ? 10 : 1000 + (quotaCursor % 30) * 1000); quotaTimer.unref();
  };
  arm();
}
function createSseObserver(maxBytes = 64 * 1024) {
  let pending = Buffer.alloc(0), discardTail = Buffer.alloc(0), discarding = false, usage = null, provider = null, canonical = null, error = null, errorPayload = null, normalizedStatus = null, responseBytes = 0, done = false;
  const observeEvent = (buffer) => {
    const payload = buffer.toString('utf8').split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.replace(/^data:\s?/, '')).join('\n');
    if (!payload) return;
    if (payload === '[DONE]') { done = true; return; }
    let event; try { event = JSON.parse(payload); } catch { return; }
    const raw = event?.data && (event.data.choices || event.data.error || event.data.usage) ? event.data : event;
    const normalized = normalizeUsage(raw?.usage); if (normalized) usage = normalized;
    const routing = parseRouting(raw || {}); if (routing.finalProvider) provider = routing.finalProvider; if (routing.canonicalSlug) canonical = routing.canonicalSlug;
    if (typeof raw?.provider === 'string') provider = slugify(raw.provider); if (typeof raw?.model === 'string') canonical = raw.model;
    const eventError = upstreamErrorOf(event); if (!error && eventError) { error = safeReason(errText(eventError)); errorPayload = eventError; normalizedStatus = normalizeStatus(200, event, 502); }
  };
  return {
    push(chunk) {
      let data = Buffer.from(chunk);
      responseBytes = Math.min(Number.MAX_SAFE_INTEGER, responseBytes + data.length);
      if (discarding) {
        data = Buffer.concat([discardTail, data]);
        const match = /\r?\n\r?\n/.exec(data.toString('latin1'));
        if (!match) { discardTail = data.subarray(Math.max(0, data.length - 3)); return; }
        discarding = false; discardTail = Buffer.alloc(0); data = data.subarray(match.index + match[0].length);
      }
      pending = Buffer.concat([pending, data]);
      while (true) {
        const match = /\r?\n\r?\n/.exec(pending.toString('latin1')); if (!match) break;
        const end = match.index; if (end <= maxBytes) observeEvent(pending.subarray(0,end)); pending = pending.subarray(end + match[0].length);
      }
      if (pending.length > maxBytes) { discardTail = pending.subarray(Math.max(0, pending.length - 3)); pending = Buffer.alloc(0); discarding = true; }
    },
    result() { return { usage, provider, canonical, error, errorPayload, normalizedStatus, responseBytes, done }; },
  };
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

const MAX_REQUEST_BODY_BYTES = 50 * 1024 * 1024;
function readBody(req) {
  const detail = detailContext.getStore();
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const cleanup = () => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onAborted);
      req.off('close', onClose);
    };
    const rejectTooLarge = () => {
      if (settled) return;
      settled = true;
      chunks.length = 0;
      cleanup();
      const drainCleanup = () => {
        req.off('end', drainCleanup);
        req.off('close', drainCleanup);
        req.off('error', drainCleanup);
      };
      req.once('end', drainCleanup);
      req.once('close', drainCleanup);
      req.once('error', drainCleanup);
      req.resume();
      const error = new Error('body too large');
      error.statusCode = 413;
      reject(error);
    };
    const onData = (chunk) => {
      detail?.input.add(chunk);
      size += chunk.length;
      if (size > MAX_REQUEST_BODY_BYTES) return rejectTooLarge();
      chunks.push(chunk);
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      detail?.input.end();
      resolve(Buffer.concat(chunks));
    };
    const onError = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAborted = () => onError(new Error('request body aborted'));
    const onClose = () => { if (!settled) onError(new Error('request body closed early')); };
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onAborted);
    req.on('close', onClose);
    const declaredLength = Number(req.headers['content-length']);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BODY_BYTES) rejectTooLarge();
  });
}
async function readJsonBody(req) {
  try { const body = JSON.parse((await readBody(req)).toString('utf8')); detailContext.getStore()?.redactor.learn(body); return body; }
  catch (e) {
    if (e?.statusCode) throw e;
    const invalid = new Error('invalid JSON body'); invalid.statusCode = 400; throw invalid;
  }
}

function upstreamErrorOf(json) {
  return json?.error || json?.data?.error || null;
}
function normalizeStatus(httpStatus, json, fallback = 502) {
  if (Number.isInteger(httpStatus) && httpStatus >= 400 && httpStatus <= 599) return httpStatus;
  const err = upstreamErrorOf(json);
  const code = Number(err?.status || err?.status_code || err?.code || json?.status || json?.status_code);
  if (Number.isInteger(code) && code >= 400 && code <= 599) return code;
  const msg = errText(err || json);
  if (/model not found/i.test(msg)) return 404;
  if (/429|rate-?limit|temporarily rate/i.test(msg)) return 429;
  if (/unauthorized|re-authenticate|invalid\s*api|401/i.test(msg)) return 401;
  return fallback;
}
function unwrap(json, httpStatus = 200) {
  const d = json?.data && (json.data.choices || json.data.error) ? json.data : json;
  if (d?.error && !d?.choices) {
    const msg = errText(d.error);
    const status = normalizeStatus(httpStatus, d, 502);
    return { status, upstreamStatus: httpStatus, normalizedStatus: status, body: { error: { message: msg, type: 'upstream_error' } }, routing: parseRouting(d || {}) };
  }
  if (httpStatus < 200 || httpStatus >= 300) {
    const msg = errText(d?.error || d || `upstream HTTP ${httpStatus}`);
    const status = normalizeStatus(httpStatus, d, 502);
    return { status, upstreamStatus: httpStatus, normalizedStatus: status, body: { error: { message: msg, type: 'upstream_error' } }, routing: parseRouting(d || {}) };
  }
  const r = parseRouting(d);
  return { status: 200, upstreamStatus: httpStatus, normalizedStatus: 200, body: d, routing: r };
}

// 每个具名 HTTP attempt 只钉住一个 provider。preferred 与 strict 都由 switcher 外层逐次回退；
// planner 使用 providerOptions.gateway.only，direct 使用 provider.only，未知管道同时注入同一个单元素 only。
const OR_SORT = { cost: 'price', ttft: 'latency', tps: 'throughput' };
function injectPrefs(body, modelId, { upstream, sort = null }) {
  const b = JSON.parse(JSON.stringify(body));
  const provider = isPlainObject(b.provider) ? { ...b.provider } : {};
  const gateway = isPlainObject(b.providerOptions?.gateway) ? { ...b.providerOptions.gateway } : {};
  delete provider.only; delete provider.order;
  delete gateway.only; delete gateway.order;
  if (isPlainObject(b.provider)) b.provider = provider;
  if (isPlainObject(b.providerOptions?.gateway)) b.providerOptions = { ...b.providerOptions, gateway };
  const pipeline = META.models[modelId]?.pipeline || null;
  const useVercel = pipeline === 'planner' || pipeline === null;
  const useOpenRouter = pipeline === 'direct' || pipeline === null;
  if (useVercel && (upstream || sort)) {
    if (upstream) gateway.only = [upstream];
    if (sort) gateway.sort = sort;
    b.providerOptions = { ...(b.providerOptions || {}), gateway };
  }
  if (useOpenRouter && (upstream || sort)) {
    if (upstream) provider.only = [upstream];
    if (sort) provider.sort = OR_SORT[sort] || sort;
    b.provider = provider;
  }
  return b;
}

function buildProviderAttempts(modelId, cfg = {}, now = Date.now()) {
  const configuredOrder = normalizeStringList(cfg.upstreams, 20);
  const discoveredOrder = normalizeStringList(META.models[modelId]?.upstreams, 100);
  const exclude = new Set(normalizeStringList(cfg.exclude, 50));
  const source = configuredOrder.length ? 'configured' : discoveredOrder.length ? 'discovered' : 'auto';
  const sourceOrder = source === 'configured' ? configuredOrder : source === 'discovered' ? discoveredOrder : [];
  if (source === 'auto') {
    return { attempts: [{ upstream: null, attribution: 'auto', sort: cfg.sort || null }], configuredOrder, plannedOrder: [], failOpen: false, source, allExcluded: false };
  }
  const allowed = sourceOrder.filter((provider) => !exclude.has(provider));
  if (!allowed.length) return { attempts: [], configuredOrder, plannedOrder: [], failOpen: false, source, allExcluded: true };
  const eligible = allowed.filter((provider) => providerHealthState(modelId, provider).cooldownUntil <= now);
  let failOpen = false;
  let planned = eligible;
  if (!planned.length) {
    failOpen = true;
    planned = [allowed.map((provider, index) => ({ provider, index, cooldownUntil: providerHealthState(modelId, provider).cooldownUntil }))
      .sort((a, b) => a.cooldownUntil - b.cooldownUntil || a.index - b.index)[0].provider];
  }
  if (cfg.maxRetries !== null && cfg.maxRetries !== undefined) planned = planned.slice(0, Math.max(1, Number(cfg.maxRetries) + 1));
  const attempts = planned.map((upstream) => ({ upstream, attribution: 'named', sort: cfg.sort || null }));
  return { attempts, configuredOrder, plannedOrder: [...planned], failOpen, source, allExcluded: false };
}
function providerCircuitKey(accountId, modelId, provider) { return `${accountId}\0${modelId}\0${provider}`; }
function providerCircuitRouteKey(accountId, modelId) { return `${accountId}\0${modelId}`; }
function clearProviderCircuitForAccount(accountId) {
  const prefix = `${accountId}\0`;
  providerCircuitAccountGenerations.set(accountId, (providerCircuitAccountGenerations.get(accountId) || 0) + 1);
  for (const key of providerCircuitStates.keys()) if (key.startsWith(prefix)) providerCircuitStates.delete(key);
  for (const key of providerCircuitRouteGenerations.keys()) if (key.startsWith(prefix)) providerCircuitRouteGenerations.delete(key);
}
function clearProviderCircuitForRoute(accountId, modelId) {
  const prefix = `${accountId}\0${modelId}\0`, routeKey = providerCircuitRouteKey(accountId, modelId);
  providerCircuitRouteGenerations.set(routeKey, (providerCircuitRouteGenerations.get(routeKey) || 0) + 1);
  for (const key of providerCircuitStates.keys()) if (key.startsWith(prefix)) providerCircuitStates.delete(key);
}
function ensureProviderCircuitCapacity(now = Date.now()) {
  if (providerCircuitStates.size < PROVIDER_CIRCUIT_LIMIT) return true;
  for (const [key, state] of providerCircuitStates) if (!state.halfOpen && state.cooldownUntil + 300000 < now) providerCircuitStates.delete(key);
  while (providerCircuitStates.size >= PROVIDER_CIRCUIT_LIMIT) {
    const removable = [...providerCircuitStates].find(([, state]) => !state.halfOpen);
    if (!removable) return false;
    providerCircuitStates.delete(removable[0]);
  }
  return true;
}
function planProviderAttempts(modelId, cfg, account) {
  const base = buildProviderAttempts(modelId, cfg), attempts = base.attempts;
  if (!attempts.length) return { ...base, retryAfter: null };
  const now = Date.now(), cooldownMs = Number(cfg?.providerCooldownMs) || 0;
  const accountGeneration = providerCircuitAccountGenerations.get(account.id) || 0;
  const routeKey = providerCircuitRouteKey(account.id, modelId), routeGeneration = providerCircuitRouteGenerations.get(routeKey) || 0;
  const annotate = (attempt) => ({ ...attempt, circuitAccountGeneration: accountGeneration, circuitRouteGeneration: routeGeneration });
  if (cooldownMs <= 0) return { ...base, attempts: attempts.map(annotate), retryAfter: null };
  const ready = [], blocked = [];
  for (const rawAttempt of attempts) {
    const attempt = annotate(rawAttempt);
    if (!attempt.upstream) { ready.push(attempt); continue; }
    const key = providerCircuitKey(account.id, modelId, attempt.upstream), circuitAttempt = { ...attempt, circuitKey: key }, state = providerCircuitStates.get(key);
    if (!state) { ready.push(circuitAttempt); continue; }
    if (state.cooldownUntil > now || state.halfOpen) { blocked.push(state); continue; }
    ready.push({ ...circuitAttempt, circuitHalfOpen: true });
  }
  if (ready.length) return { ...base, attempts: ready, plannedOrder: ready.map((attempt) => attempt.upstream).filter(Boolean), retryAfter: null };
  const earliest = Math.min(...blocked.map((state) => state.cooldownUntil > now ? state.cooldownUntil : now + 1000));
  return { ...base, attempts: [], plannedOrder: [], retryAfter: retryAfterSeconds(Math.max(1000, earliest - now)) };
}
function providerAttemptGenerationIsCurrent(modelId, account, attempt) {
  const routeKey = providerCircuitRouteKey(account.id, modelId);
  return attempt?.circuitAccountGeneration === (providerCircuitAccountGenerations.get(account.id) || 0)
    && attempt?.circuitRouteGeneration === (providerCircuitRouteGenerations.get(routeKey) || 0);
}
function providerCircuitFailure(outcome, account) {
  const status = Number(outcome?.normalizedStatus || outcome?.status || 0), message = String(outcome?.netError || outcome?.out?.error?.message || '');
  if (/abort|cancel/i.test(message) || status === 401 || /unauthorized|re-authenticate|invalid\s*api/i.test(message)) return null;
  if (outcome?.classification?.scope === 'account' || outcome?.classification?.scope === 'request') return null;
  if (outcome?.terminalOrigin === 'proxy' || (account?.proxyUrl && outcome?.upstreamStatus === 0)) return null;
  if (status === 429) return 'rate_limit';
  if (status >= 500 || outcome?.terminalOrigin === 'network' || outcome?.terminalOrigin === 'timeout') return outcome?.terminalOrigin || 'server';
  if (/no allowed providers|no available providers|not found|unsupported|unavailable/i.test(message)) return 'unavailable';
  return null;
}
function settleProviderCircuit(modelId, cfg, account, attempt, outcome) {
  if (!attempt?.upstream || !(Number(cfg?.providerCooldownMs) > 0)) return null;
  const routeKey = providerCircuitRouteKey(account.id, modelId);
  if (attempt.circuitAccountGeneration !== (providerCircuitAccountGenerations.get(account.id) || 0) || attempt.circuitRouteGeneration !== (providerCircuitRouteGenerations.get(routeKey) || 0)) return null;
  const key = attempt.circuitKey || providerCircuitKey(account.id, modelId, attempt.upstream), state = providerCircuitStates.get(key);
  if (Number(outcome?.status) === 200) {
    if (state) providerCircuitStates.delete(key);
    return attempt.circuitHalfOpen ? 'half-open-success' : null;
  }
  const failureClass = providerCircuitFailure(outcome, account);
  if (!failureClass) {
    if (attempt.circuitHalfOpen && state) providerCircuitStates.delete(key);
    return null;
  }
  if (!state && !ensureProviderCircuitCapacity()) return null;
  const next = state || { consecutiveFailures: 0 };
  next.cooldownUntil = Date.now() + Number(cfg.providerCooldownMs);
  next.failureClass = failureClass;
  next.consecutiveFailures = Math.min(1000, (next.consecutiveFailures || 0) + 1);
  next.halfOpen = false;
  next.updatedAt = Date.now();
  providerCircuitStates.set(key, next);
  return attempt.circuitHalfOpen ? 'half-open-failed' : 'cooldown';
}

function redactSecrets(value) {
  let s = String(value ?? '');
  const keys = [config.apiKey, config.proxyKey, PROXY_KEY, ...(config.accounts || []).flatMap((a) => {
    const values = [a.key, a.proxyUrl, ...Object.values(a.headers || {})];
    try { const u = new URL(a.proxyUrl); values.push(decodeURIComponent(u.username), decodeURIComponent(u.password)); } catch {}
    return values;
  })].filter(Boolean);
  for (const k of keys) s = s.split(k).join('[REDACTED]');
  s = s.replace(/(?:https?|socks5h?):\/\/[^\s]+/gi, '[REDACTED_PROXY]').replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer [REDACTED]');
  return s;
}
// 把结构化上游错误归一成单行脱敏字符串；非 JSON 响应只使用通用原因，原始正文不进入诊断。
const errText = (e) => redactSecrets(e == null ? '' : typeof e === 'string' ? e : JSON.stringify(e));
function responseHeader(headers, name) {
  const value = headers?.[String(name).toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}
function normalizeResponseContentType(headers) {
  const mediaType = String(responseHeader(headers, 'content-type') || '').split(';', 1)[0].trim().toLowerCase();
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mediaType) && mediaType.length <= 100 ? mediaType : null;
}
function safeResponseBytes(value) {
  const bytes = Buffer.isBuffer(value) ? value.length : Buffer.byteLength(String(value || ''), 'utf8');
  return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : null;
}
function parseRetryAfter(value, now = Date.now()) {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const text = String(raw).trim();
  let delay = null;
  if (/^\d+$/.test(text)) delay = Number(text) * 1000;
  else if (/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),\s\d{2}\s[A-Za-z]{3}\s\d{4}\s\d{2}:\d{2}:\d{2}\sGMT$/.test(text)) {
    const date = Date.parse(text); if (Number.isFinite(date)) delay = date - now;
  }
  if (!Number.isFinite(delay)) return null;
  return Math.min(30 * 60e3, Math.max(1000, Math.floor(delay)));
}
function structuredErrorText(error) {
  if (error == null) return '';
  try { return (typeof error === 'string' ? error : JSON.stringify(error)).slice(0, 8192); } catch { return ''; }
}
function structuredErrorStrings(error) {
  if (typeof error === 'string') return [error.slice(0, 8192)];
  if (!error || typeof error !== 'object') return [];
  const strings = [], stack = [[error, 0]];
  let total = 0;
  while (stack.length && strings.length < 64 && total < 8192) {
    const [value, depth] = stack.pop();
    if (!value || typeof value !== 'object' || depth > 4) continue;
    for (const [key, child] of Object.entries(value)) {
      if (strings.length >= 64 || total >= 8192) break;
      const keyText = key.slice(0, 8192 - total);
      strings.push(keyText); total += keyText.length;
      if (typeof child === 'string' && strings.length < 64 && total < 8192) {
        const text = child.slice(0, 8192 - total);
        strings.push(text); total += text.length;
      } else if (child && typeof child === 'object') stack.push([child, depth + 1]);
    }
  }
  return strings;
}
function hasExplicitAccountQuotaEvidence(error) {
  return structuredErrorStrings(error).some((text) => {
    const words = text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (!words) return false;
    const owner = '(?:account(?: subscription| plan| billing)?|subscription|plan|billing)';
    const quota = '(?:quota|limit|allowance|credits?|usage limit)';
    const exhausted = '(?:exhausted|depleted|reached|exceeded|used up)';
    return new RegExp(`${owner}(?: [a-z0-9]+){0,4} ${quota}(?: [a-z0-9]+){0,4} ${exhausted}`).test(words)
      || new RegExp(`${quota}(?: [a-z0-9]+){0,4} ${exhausted}(?: [a-z0-9]+){0,4} ${owner}`).test(words);
  });
}
function hasExplicitProviderEvidence(error, upstream) {
  if (!error || !upstream || typeof error !== 'object') return false;
  const stack = [[error, 0]];
  while (stack.length) {
    const [value, depth] = stack.pop();
    if (!value || typeof value !== 'object' || depth > 4) continue;
    for (const [key, child] of Object.entries(value)) {
      if (/^(?:provider|providerName|provider_name|upstream|finalProvider)$/i.test(key) && typeof child === 'string' && norm(child) === norm(upstream)) return true;
      if (child && typeof child === 'object') stack.push([child, depth + 1]);
    }
  }
  return false;
}
function quotaShowsExhausted(account, now = Date.now()) {
  if (!account?.id) return false;
  const quota = quotaProjection(account.id, now);
  return quota.status === 'fresh' && Object.values(quota.limits || {}).some((limit) => Number(limit?.percentUsed) >= 100);
}
function classifyAttemptFailure(result, attempt, account, now = Date.now()) {
  const status = Number(result?.normalizedStatus || result?.status || 0);
  const origin = result?.terminalOrigin || '';
  const error = result?.structuredError;
  const errorText = structuredErrorText(error || result?.out?.error?.message);
  if (status === 429) {
    const retryAfterMs = parseRetryAfter(result?.retryAfter, now);
    if (quotaShowsExhausted(account, now)) return { scope: 'account', evidence: 'fresh_account_quota', failureClass: 'rate_limit', retryAfterMs };
    if (hasExplicitAccountQuotaEvidence(error)) return { scope: 'account', evidence: 'structured_account_quota', failureClass: 'rate_limit', retryAfterMs };
    if (result?.routing?.finalProvider) return { scope: 'provider', evidence: 'routing_final_provider', failureClass: 'rate_limit', retryAfterMs };
    if (hasExplicitProviderEvidence(error, attempt?.upstream)) return { scope: 'provider', evidence: 'structured_provider', failureClass: 'rate_limit', retryAfterMs };
    return { scope: 'unknown', evidence: 'ambiguous_rate_limit', failureClass: 'rate_limit', retryAfterMs };
  }
  if (status === 401 || status === 403) return { scope: 'account', evidence: 'http_auth', failureClass: 'auth', retryAfterMs: null };
  if (origin === 'timeout') return { scope: 'provider', evidence: 'transport_timeout', failureClass: 'timeout', retryAfterMs: null };
  if (origin === 'proxy') return { scope: 'account', evidence: 'transport_proxy', failureClass: 'network', retryAfterMs: null };
  if (origin === 'network' || result?.upstreamStatus === 0) return { scope: 'provider', evidence: 'transport_network', failureClass: 'network', retryAfterMs: null };
  if (/unsupported|not supported|no allowed providers|no available providers|model\s*id[^\n]*not found|invalid[^\n]*provider|provider[^\n]*not found|cannot[^\n]*pin/i.test(errorText)) return { scope: 'provider', evidence: 'structured_unsupported', failureClass: 'unsupported', retryAfterMs: null };
  if (status >= 500 && status <= 599) return { scope: 'provider', evidence: 'http_server', failureClass: 'server', retryAfterMs: null };
  if (status >= 400 && status <= 499) return { scope: 'request', evidence: 'http_request', failureClass: 'other', retryAfterMs: null };
  return { scope: attempt?.upstream ? 'provider' : 'unknown', evidence: 'unclassified_failure', failureClass: 'other', retryAfterMs: null };
}

function resolveModelConfig(account, modelId) {
  if (account?.perModel && Object.prototype.hasOwnProperty.call(account.perModel, modelId)) return account.perModel[modelId] || {};
  return config.perModel[modelId] || {};
}
const MAX_RULE_FAILURE_TEXT = 16 * 1024;
let contentRuleCacheSource = null, contentRuleCache = [];
function compiledContentRules() {
  if (contentRuleCacheSource !== config.accountContentErrorRules) {
    contentRuleCacheSource = config.accountContentErrorRules;
    contentRuleCache = (config.accountContentErrorRules || []).map((rule) => ({ ...rule, needle: rule.contains.toLowerCase() }));
  }
  return contentRuleCache;
}
function normalizeFailureForRules(value, sensitiveValues = []) {
  return safeReason(errText(value), sensitiveValues).replace(/[\r\n\t]+/g, ' ').slice(0, MAX_RULE_FAILURE_TEXT);
}
function projectedAccountAction(statusCode, rule) {
  return { statusCode, action: rule.action, ...(rule.action === 'cooldown' ? { cooldownMs: rule.cooldownMs } : {}) };
}
function accountActionFor(result, classification, sensitiveValues = []) {
  const statusCode = Number(result?.normalizedStatus || result?.status);
  if (!Number.isInteger(statusCode) || statusCode < 400 || statusCode > 599) return null;
  const failureText = normalizeFailureForRules(result?.failureText ?? result?.out?.error?.message ?? result?.body?.error?.message ?? result?.error ?? result?.netError ?? '', sensitiveValues).toLowerCase();
  if (failureText) for (const rule of compiledContentRules()) {
    if (rule.statusMin !== undefined && (statusCode < rule.statusMin || statusCode > rule.statusMax)) continue;
    if (failureText.includes(rule.needle)) return projectedAccountAction(statusCode, rule);
  }
  if (statusCode === 429 && classification?.scope !== 'account') return null;
  const rule = config.accountErrorRules?.[String(statusCode)];
  return rule ? projectedAccountAction(statusCode, rule) : null;
}
function persistAccountAction(account, action, reason, sensitiveValues = []) {
  if (!account?.id || !action || action.action === 'ignore') return;
  const now = Date.now();
  const state = { banned: false, cooldownUntil: 0, statusCode: action.statusCode, reason: safeReason(reason, sensitiveValues), updatedAt: now };
  if (action.action === 'cooldown') state.cooldownUntil = now + Math.max(1, Number(action.cooldownMs) || 1);
  if (action.action === 'ban') state.banned = true;
  META.accountStates ||= {};
  META.accountStates[account.id] = state;
  clearProviderCircuitForAccount(account.id);
  try { saveMeta(); } catch (error) { console.error(`[账号] 状态持久化失败：${safeReason(error.message)}`); }
}
function responseHeadersFor(account, forwardedHeaders) {
  return { ...forwardedHeaders, ...(account?.headers || {}), 'Content-Type': 'application/json', Authorization: `Bearer ${account.key}` };
}
async function attemptOnce(modelId, body, attempt, account, forwardedHeaders, signal) {
  const send = injectPrefs(body, modelId, attempt);
  try {
    const res = await clineRequestJSON(`${config.upstreamBase}/chat/completions`, {
      headers: responseHeadersFor(account, forwardedHeaders), body: JSON.stringify(send), signal, account,
    });
    const responseContentType = normalizeResponseContentType(res.headers);
    const responseBytes = safeResponseBytes(res.text);
    const retryAfter = responseHeader(res.headers, 'retry-after');
    let json = null;
    try { json = JSON.parse(res.text); } catch {}
    if (!json) {
      const status = normalizeStatus(res.status, null, 502);
      return { status, upstreamStatus: res.status, normalizedStatus: status, out: { error: { message: 'upstream returned non-JSON', type: 'upstream_error' } }, routing: {}, structuredError: null, retryAfter, responseContentType, responseBytes, netError: 'non-JSON response', terminalOrigin: res.status >= 400 ? 'upstream_http' : 'upstream_envelope', acc: account };
    }
    const un = unwrap(json, res.status);
    return { status: un.status, upstreamStatus: un.upstreamStatus, normalizedStatus: un.normalizedStatus, out: un.body, routing: un.routing, structuredError: upstreamErrorOf(json), retryAfter, responseContentType, responseBytes, netError: null, terminalOrigin: un.status === 200 ? 'success' : (res.status >= 400 ? 'upstream_http' : 'upstream_envelope'), acc: account };
  } catch (e) {
    const origin = /timeout/i.test(e.message) ? 'timeout' : account?.proxyUrl ? 'proxy' : 'network';
    return { status: 502, upstreamStatus: 0, normalizedStatus: 502, out: { error: { message: `upstream fetch failed: ${errText(e.message)}`, type: 'upstream_error' } }, routing: {}, structuredError: null, retryAfter: null, responseContentType: null, responseBytes: 0, netError: errText(e.message), terminalOrigin: origin, acc: account };
  }
}
function settleAttempt(modelId, attempt, result, account, { clientDisconnected = false, updateSuccess = true, cfg = {}, sensitiveValues = [] } = {}) {
  const currentGeneration = providerAttemptGenerationIsCurrent(modelId, account, attempt);
  if (clientDisconnected) {
    const providerCircuitAction = currentGeneration
      ? settleProviderCircuit(modelId, cfg, account, attempt, { status: 499, normalizedStatus: 499, netError: 'client cancelled', classification: { scope: 'request' } })
      : null;
    return { classification: null, accountAction: null, healthAction: 'none', providerCircuitAction };
  }
  if (result.status === 200) {
    const healthAction = updateSuccess && currentGeneration ? updateProviderHealth(modelId, attempt.upstream, { success: true }) : 'none';
    const providerCircuitAction = updateSuccess && currentGeneration ? settleProviderCircuit(modelId, cfg, account, attempt, result) : null;
    return { classification: null, accountAction: null, healthAction, providerCircuitAction };
  }
  const classification = classifyAttemptFailure(result, attempt, account);
  result.classification = classification;
  const accountAction = accountActionFor(result, classification, sensitiveValues);
  const removesAccount = accountAction?.action === 'cooldown' || accountAction?.action === 'ban';
  const cooldownOverrideMs = Number(cfg?.providerCooldownMs) > 0 ? Number(cfg.providerCooldownMs) : null;
  const healthAction = currentGeneration && !removesAccount
    ? updateProviderHealth(modelId, attempt.upstream, { classification, note: `${classification.evidence}:${classification.failureClass}`, cooldownOverrideMs })
    : 'none';
  const providerCircuitAction = currentGeneration && !removesAccount ? settleProviderCircuit(modelId, cfg, account, attempt, result) : null;
  return { classification, accountAction, healthAction, providerCircuitAction };
}
function traceAttempt(attempt, result, account, ms, diagnostic) {
  return {
    upstream: attempt.upstream, status: result.status, upstreamStatus: result.upstreamStatus, normalizedStatus: result.normalizedStatus,
    terminalOrigin: result.terminalOrigin, ms, note: result.note, account: account.name, accountId: account.id,
    action: diagnostic.accountAction?.action || null, providerCircuitAction: diagnostic.providerCircuitAction || null,
    errorScope: diagnostic.classification?.scope || null,
    scopeEvidence: diagnostic.classification?.evidence || null, failureClass: diagnostic.classification?.failureClass || null,
    healthAction: diagnostic.healthAction || 'none', retryAfterMs: diagnostic.classification?.retryAfterMs ?? null,
    responseContentType: result.responseContentType || null, responseBytes: Number.isSafeInteger(result.responseBytes) ? result.responseBytes : null,
  };
}

// 两级重试：本函数固定一个账号，仅在该账号内按健康计划逐个尝试 provider。
// 只有 account-scoped 错误命中 cooldown/ban 时，外层 handleChat 才能终止本链并最多换号一次。
async function runChatChain(req, body, modelId, cfg, account, forwardedHeaders, { stream = false, attemptTimeoutMs = 120000, sensitiveValues = [] } = {}) {
  const t0 = Date.now();
  const plan = planProviderAttempts(modelId, cfg, account), attempts = plan.attempts;
  const trace = [];
  if (!attempts.length) {
    const allExcluded = plan.allExcluded === true;
    return { status: 503, upstreamStatus: allExcluded ? null : 0, normalizedStatus: 503,
      out: { error: { message: allExcluded ? 'no provider available after exclusions' : 'all configured providers are cooling down', type: 'upstream_error' } },
      routing: {}, acc: account, trace, t0, plan, retryAfter: plan.retryAfter || null, netError: null, accountAction: null, clientDisconnected: false };
  }
  let last = null;
  let activeReq = null;
  let keepCloseHook = false;
  const clientSocket = req.socket;
  let clientClosed = !!clientSocket?.destroyed;
  const onClientClose = () => { clientClosed = true; if (activeReq) activeReq.abort?.(); };
  clientSocket?.on('close', onClientClose);
  const cleanupClientClose = () => clientSocket?.off('close', onClientClose);
  try {
    for (const attempt of attempts) {
      if (clientClosed) break;
      if (attempt.circuitHalfOpen) {
        const state = providerCircuitStates.get(attempt.circuitKey);
        if (!state || state.halfOpen) continue;
        state.halfOpen = true; state.updatedAt = Date.now();
      }
      const t1 = Date.now();
      const ctrl = new AbortController();
      let timedOut = false;
      activeReq = ctrl;
      const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, attemptTimeoutMs);
      try {
        if (stream) {
          const send = injectPrefs(body, modelId, attempt);
          let up = null, netError = null, transportOrigin = null;
          try {
            up = await clineRequest(`${config.upstreamBase}/chat/completions`, { headers: responseHeadersFor(account, forwardedHeaders), body: JSON.stringify(send), signal: ctrl.signal, timeoutMs: attemptTimeoutMs, account });
          } catch (e) { netError = timedOut ? 'upstream timeout' : errText(e.message); }
          const responseContentType = normalizeResponseContentType(up?.headers);
          let isSSE = !!up && up.status === 200 && responseContentType === 'text/event-stream';
          let firstChunk = null;
          if (isSSE) {
            try {
              const first = await readFirstSseEvent(up.body);
              firstChunk = first.buffer;
              if (!firstChunk.length) { isSSE = false; netError = 'empty stream'; }
              else {
                const head = firstChunk.toString('utf8').trimStart();
                if (!first.complete || !head.startsWith('data:')) {
                  isSSE = false; netError = 'unexpected stream head';
                } else {
                  const eventText = head.split(/\r?\n\r?\n/, 1)[0];
                  const payload = eventText.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.replace(/^data:\s?/, '')).join('\n');
                  const event = payload === '[DONE]' ? null : safeJsonParse(payload, 64 * 1024);
                  const eventError = upstreamErrorOf(event);
                  if (eventError) { isSSE = false; netError = `stream error: ${errText(eventError)}`; }
                }
              }
            } catch (e) {
              isSSE = false;
              netError = timedOut ? 'upstream timeout' : errText(e.message);
              transportOrigin = timedOut || /timeout/i.test(netError) ? 'timeout' : account.proxyUrl ? 'proxy' : 'network';
            }
          }
          const ms = Date.now() - t1;
          if (up && !isSSE) {
            let rest = '';
            try { rest = await streamToString(up.body); }
            catch (e) {
              if (!netError) netError = timedOut ? 'upstream timeout' : errText(e.message);
              transportOrigin = timedOut || /timeout/i.test(netError) ? 'timeout' : account.proxyUrl ? 'proxy' : 'network';
            }
            const text = (firstChunk ? firstChunk.toString('utf8') : '') + rest;
            let json = null;
            try { json = JSON.parse(text); } catch {
              const dataLine = text.split('\n').find((line) => line.trimStart().startsWith('data:'));
              if (dataLine) try { json = JSON.parse(dataLine.trimStart().replace(/^data:\s*/, '')); } catch {}
            }
            const inferred = normalizeStatus(up.status, json, normalizeStatus(0, { error: text }, 502));
            const un = json ? unwrap(json, up.status) : { status: inferred, upstreamStatus: up.status, normalizedStatus: inferred, body: { error: { message: netError || 'upstream returned an invalid error response', type: 'upstream_error' } }, routing: {} };
            const result = {
              status: un.status, upstreamStatus: up.status, normalizedStatus: un.normalizedStatus, out: un.body, routing: un.routing,
              structuredError: json ? upstreamErrorOf(json) : null, retryAfter: responseHeader(up.headers, 'retry-after'), responseContentType,
              responseBytes: safeResponseBytes(text), netError: transportOrigin ? netError : null,
              terminalOrigin: up.status >= 400 ? 'upstream_http' : transportOrigin || 'upstream_envelope', acc: account,
            };
            result.note = errText(un.body?.error?.message || netError);
            const diagnostic = settleAttempt(modelId, attempt, result, account, { clientDisconnected: clientClosed, cfg, sensitiveValues });
            trace.push(traceAttempt(attempt, result, account, ms, diagnostic));
            if (!attempt.upstream) learnAvailableProviders(modelId, result.note);
            last = { ...result, accountAction: diagnostic.accountAction, classification: diagnostic.classification };
            if (last.accountAction?.action === 'cooldown' || last.accountAction?.action === 'ban') break;
            continue;
          }
          if (!up) {
            const origin = timedOut || /timeout/i.test(netError || '') ? 'timeout' : account.proxyUrl ? 'proxy' : 'network';
            const result = { status: 502, upstreamStatus: 0, normalizedStatus: 502, out: { error: { message: `upstream fetch failed: ${netError || 'no response'}`, type: 'upstream_error' } }, routing: {}, structuredError: null, retryAfter: null, responseContentType: null, responseBytes: 0, netError: netError || 'no response', terminalOrigin: origin, acc: account, note: netError || 'no response' };
            const diagnostic = settleAttempt(modelId, attempt, result, account, { clientDisconnected: clientClosed, cfg, sensitiveValues });
            trace.push(traceAttempt(attempt, result, account, ms, diagnostic));
            last = { ...result, accountAction: diagnostic.accountAction, classification: diagnostic.classification };
            if (last.accountAction?.action === 'cooldown' || last.accountAction?.action === 'ban') break;
            continue;
          }
          keepCloseHook = true;
          const result = { status: 200, upstreamStatus: 200, normalizedStatus: 200, terminalOrigin: 'success', responseContentType, responseBytes: safeResponseBytes(firstChunk), note: 'stream' };
          const diagnostic = settleAttempt(modelId, attempt, result, account, { updateSuccess: false, cfg, sensitiveValues });
          trace.push(traceAttempt(attempt, result, account, ms, diagnostic));
          return { status: 200, streamUp: up, streamHead: firstChunk, streamAttempt: attempt, acc: account, trace, t0, plan, started: true, cleanupClientClose };
        }
        const result = await attemptOnce(modelId, body, attempt, account, forwardedHeaders, ctrl.signal);
        if (timedOut && result.status !== 200) { result.terminalOrigin = 'timeout'; result.netError = 'upstream timeout'; result.out = { error: { message: 'upstream fetch failed: upstream timeout', type: 'upstream_error' } }; }
        const ms = Date.now() - t1;
        result.note = result.netError || (result.status !== 200 ? errText(result.out?.error?.message) : 'ok');
        const diagnostic = settleAttempt(modelId, attempt, result, account, { clientDisconnected: clientClosed, cfg, sensitiveValues });
        trace.push(traceAttempt(attempt, result, account, ms, diagnostic));
        if (result.status !== 200 && !attempt.upstream) learnAvailableProviders(modelId, result.note);
        last = { ...result, accountAction: diagnostic.accountAction, classification: diagnostic.classification };
        if (result.status === 200) break;
        if (last.accountAction?.action === 'cooldown' || last.accountAction?.action === 'ban') break;
      } finally { clearTimeout(timer); }
    }
  } finally {
    if (!keepCloseHook) cleanupClientClose();
  }
  if (!last && !clientClosed) return { status: 503, upstreamStatus: 0, normalizedStatus: 503, out: { error: { message: 'provider half-open probe is already in progress', type: 'upstream_error' } }, routing: {}, acc: account, trace, t0, plan, retryAfter: plan.retryAfter || 1, netError: null, clientDisconnected: false };
  if (!last) last = { status: 502, upstreamStatus: 0, normalizedStatus: 502, out: { error: { message: 'upstream request aborted', type: 'upstream_error' } }, routing: {}, acc: account, netError: 'upstream request aborted', accountAction: null };
  return { ...last, trace, t0, plan, netError: last.netError || null, clientDisconnected: clientClosed };
}

function statisticsSegments(trace, finalAccountId, usage, clientDisconnect = false) {
  const grouped = new Map();
  for (const attempt of trace || []) { const list = grouped.get(attempt.accountId) || []; list.push(attempt); grouped.set(attempt.accountId, list); }
  return [...grouped.entries()].map(([accountId, attempts]) => { const success = !clientDisconnect && attempts.at(-1)?.status === 200; return { accountId, trace: attempts, success, error: !clientDisconnect && !success, usage: success && accountId === finalAccountId ? usage : null }; });
}
function cacheHitOf(usage) {
  return usage?.cacheFieldPresent === true && usage.cachedTokens !== null ? usage.cachedTokens > 0 : null;
}
async function handleChat(req, res) {
  const detail = detailContext.getStore();
  const requestId = detail?.requestId || crypto.randomUUID();
  res.setHeader('X-Cline-Request-Id', requestId);
  const raw = await readBody(req);
  let body;
  try { body = JSON.parse(raw.toString('utf8')); } catch { return sendJSON(res, 400, { error: { message: 'invalid JSON body' } }); }
  detailContext.getStore()?.redactor.learn(body);
  if (!body || typeof body !== 'object' || Array.isArray(body)) return sendJSON(res, 400, { error: { message: 'JSON body must be an object' } });
  const requestedModel = typeof body.model === 'string' ? body.model.trim() : '';
  if (!requestedModel || requestedModel.length > 300) return sendJSON(res, 400, { error: { message: 'valid model is required' } });
  const sensitiveValues = sensitiveMessageValues(body);
  let statisticsFinalized = false;
  const finalizeStatistics = (facts) => { if (statisticsFinalized) return; statisticsFinalized = true; try { commitStatistics({ ...facts, modelId, affinityConfidence: identity?.confidence || 'none' }); } catch (error) { console.error(`[统计] 持久化失败：${safeReason(error.message)}`); } };
  const modelId = resolveModelAlias(requestedModel);
  const recordChat = (info) => record(modelId, info, detail);
  body = { ...body, model: modelId };
  const identity = extractSessionIdentity(req, body);
  const forwardedHeaders = forwardHeadersFor(req, body);
  const affinity = prepareChatAffinity(body, identity);
  body = affinity.body;
  const isStream = body.stream === true;
  const excluded = new Set();
  const accountPath = [];
  let upstreamAffinitySent = false;
  let providerOrderOverridesSticky = false;
  const affinityFacts = (usage = null) => ({
    sessionSource: identity.source,
    affinityKeyType: identity.keyType,
    affinityConfidence: identity.confidence,
    upstreamPromptCacheKeySource: affinity.source,
    upstreamPromptCacheKeyApplied: upstreamAffinitySent && affinity.usable,
    providerOrderOverridesSticky,
    cacheHit: cacheHitOf(usage),
  });
  let selected = await acquireAccountLease(identity, { excludeIds: excluded });
  if (!selected.lease) {
    const status = enabledAccounts().length ? 429 : 503;
    finalizeStatistics({ globalError: true, segments: [] });
    recordChat({ requestId, requestedModel, resolvedModel: modelId, stream: isStream, strategy: selected.strategy, ...affinityFacts(), selectionReason: 'capacity-unavailable', normalizedStatus: status, upstreamStatus: null, errorCategory: 'capacity', error: selected.error, ms: 0 });
    return sendBusy(res, selected.error, selected.retryAfter, status);
  }
  const initialSelection = { ...selected };

  let chain, cfg, targets = [], targetSource = 'auto', chainLease = selected.lease;
  const completedTrace = [];
  const accountActions = [];
  for (let accountAttempt = 0; accountAttempt < 2; accountAttempt++) {
    const lease = selected.lease;
    chainLease = lease;
    const account = lease.account;
    accountPath.push(account.name);
    cfg = resolveModelConfig(account, modelId);
    try {
      upstreamAffinitySent = true;
      chain = await runChatChain(req, body, modelId, cfg, account, forwardedHeaders, { stream: isStream, sensitiveValues });
      targets = chain.plan?.plannedOrder || [];
      targetSource = chain.plan?.source || 'auto';
      if (cfg?.pinMode === 'preferred' && chain.plan?.source === 'configured' && targets.length > 0) providerOrderOverridesSticky = true;
    } catch (e) {
      lease.release();
      throw e;
    }
    const action = chain.accountAction;
    if (action) {
      const reason = chain.out?.error?.message || chain.netError || `upstream status ${chain.normalizedStatus || chain.status}`;
      if (action.action !== 'ignore') persistAccountAction(account, action, reason, sensitiveValues);
      accountActions.push({ account: account.name, action: action.action, statusCode: action.statusCode });
    }
    if (action && (action.action === 'cooldown' || action.action === 'ban') && !chain.started && accountAttempt === 0) {
      excluded.add(account.id);
      lease.release();
      chainLease = null;
      selected = await acquireAccountLease(identity, { excludeIds: excluded });
      if (selected.lease) {
        selected.reason = 'replacement-after-account-action';
        completedTrace.push(...chain.trace);
        continue;
      }
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
      'X-Cline-Target-Upstream': targets.length ? targets.join('>') : targetSource === 'auto' ? 'auto' : 'none', 'X-Cline-Attempts': String(chain.trace.length), 'X-Cline-Account': headerSafe(acc.name),
    });
    const observer = createSseObserver();
    if (chain.streamHead) { observer.push(chain.streamHead); res.write(chain.streamHead); }
    let finalized = false;
    let onUpstreamError, onResponseClose;
    const finalize = (error = null, origin = null) => {
      if (finalized) return;
      finalized = true;
      chain.cleanupClientClose?.();
      up.body.off('error', onUpstreamError);
      res.off('close', onResponseClose);
      lease.release();
      const observed = observer.result();
      const streamError = observed.error || (error ? safeReason(error) : null);
      const providerAttempt = chain.trace.at(-1);
      const attempt = chain.streamAttempt || { upstream: providerAttempt?.upstream || null };
      const disconnected = origin === 'client_disconnect';
      if (observed.error && providerAttempt) {
        const result = { status: observed.normalizedStatus, upstreamStatus: 200, normalizedStatus: observed.normalizedStatus, routing: { finalProvider: observed.provider }, structuredError: observed.errorPayload, failureText: observed.error, retryAfter: null, responseContentType: 'text/event-stream', responseBytes: observed.responseBytes, terminalOrigin: 'upstream_envelope', note: safeReason(observed.error, sensitiveValues) };
        const diagnostic = settleAttempt(modelId, attempt, result, acc, { cfg, sensitiveValues });
        Object.assign(providerAttempt, traceAttempt(attempt, result, acc, providerAttempt.ms, diagnostic));
        const action = diagnostic.accountAction;
        if (action) { if (action.action !== 'ignore') persistAccountAction(acc, action, streamError, sensitiveValues); accountActions.push({ account: acc.name, action: action.action, statusCode: action.statusCode }); }
      } else if (error && !disconnected && providerAttempt) {
        const result = { status: 502, upstreamStatus: 0, normalizedStatus: 502, routing: {}, structuredError: null, failureText: error, retryAfter: null, responseContentType: 'text/event-stream', responseBytes: observed.responseBytes, terminalOrigin: /timeout/i.test(String(error)) ? 'timeout' : acc.proxyUrl ? 'proxy' : 'network', note: 'stream transport error' };
        const diagnostic = settleAttempt(modelId, attempt, result, acc, { cfg, sensitiveValues });
        Object.assign(providerAttempt, traceAttempt(attempt, result, acc, providerAttempt.ms, diagnostic));
        const action = diagnostic.accountAction;
        if (action) { if (action.action !== 'ignore') persistAccountAction(acc, action, error, sensitiveValues); accountActions.push({ account: acc.name, action: action.action, statusCode: action.statusCode }); }
      } else if (!disconnected && providerAttempt) {
        const result = { status: 200, upstreamStatus: 200, normalizedStatus: 200, routing: { finalProvider: observed.provider }, structuredError: null, retryAfter: null, responseContentType: 'text/event-stream', responseBytes: observed.responseBytes, terminalOrigin: 'success', note: 'stream' };
        const diagnostic = settleAttempt(modelId, attempt, result, acc, { cfg, sensitiveValues });
        Object.assign(providerAttempt, traceAttempt(attempt, result, acc, providerAttempt.ms, diagnostic));
      } else if (providerAttempt) {
        const diagnostic = settleAttempt(modelId, attempt, { status: 499, normalizedStatus: 499 }, acc, { clientDisconnected: true, cfg, sensitiveValues });
        providerAttempt.healthAction = 'none';
        providerAttempt.providerCircuitAction = diagnostic.providerCircuitAction || null;
        providerAttempt.responseBytes = observed.responseBytes;
      }
      const transportFailed = !!error && origin !== 'client_disconnect';
      const clientCancelled = origin === 'client_disconnect' && !observed.done && !observed.error;
      const requestResult = observed.error || transportFailed ? 'failed' : clientCancelled ? 'client_cancelled' : 'success';
      const normalizedStatus = requestResult === 'failed' ? (observed.error ? observed.normalizedStatus : 502) : requestResult === 'client_cancelled' ? 499 : 200;
      const safeStreamError = requestResult === 'failed' ? (streamError ? safeReason(streamError, sensitiveValues) : 'stream transport error') : null;
      const usage = requestResult === 'success' ? observed.usage : null;
      finalizeStatistics({ globalError: requestResult === 'failed', usage, clientDisconnect: clientCancelled, segments: statisticsSegments(chain.trace, acc.id, usage, clientCancelled) });
      recordChat({ requestId, requestedModel, resolvedModel: modelId, provider: observed.provider, canonical: observed.canonical, ms: Date.now() - chain.t0, stream: true, result: requestResult, error: safeStreamError, upstreamStatus: providerAttempt?.upstreamStatus ?? null, normalizedStatus, account: acc.name, accountId: acc.id, attempts: chain.trace.map((t) => t.upstream || 'auto'), trace: chain.trace, accountPath, accountActions, ...affinityFacts(usage), strategy: initialSelection.strategy, preferredAccountId: initialSelection.preferredAccountId, preferredAccountName: initialSelection.preferredAccountName, selectionReason: selected.reason, overflow: initialSelection.overflow, pipeline: selected.pipeline || initialSelection.pipeline, targets, appliedHeaderNames: Object.keys(acc.headers || {}), proxyError: !!acc.proxyUrl && chain.trace.some((t) => t.upstreamStatus === 0), sensitiveValues });
    };
    const tap = new Transform({ transform(c, enc, cb) { observer.push(c); cb(null, c); }, flush(cb) { finalize(); cb(); } });
    onUpstreamError = (e) => { finalize(e.message, 'upstream'); if (!res.destroyed) res.destroy(e); };
    onResponseClose = () => { if (res.writableEnded) return; finalize('client disconnected', 'client_disconnect'); if (!up.body.destroyed) up.body.destroy(); };
    up.body.on('error', onUpstreamError);
    res.on('close', onResponseClose);
    up.body.pipe(tap).pipe(res);
    return;
  }

  lease?.release();
  const { status, out, routing = {}, acc } = chain;
  const disconnected = chain.clientDisconnected === true;
  if (!out) {
    const result = disconnected ? 'client_cancelled' : 'failed';
    finalizeStatistics({ globalError: !disconnected, clientDisconnect: disconnected, segments: statisticsSegments(chain.trace, null, null, disconnected) });
    recordChat({ requestId, requestedModel, resolvedModel: modelId, stream: false, result, normalizedStatus: disconnected ? 499 : 502, error: disconnected ? null : 'no upstream response', trace: chain.trace, accountPath, accountActions, ...affinityFacts(), strategy: initialSelection.strategy, preferredAccountId: initialSelection.preferredAccountId, preferredAccountName: initialSelection.preferredAccountName, selectionReason: selected.reason, overflow: initialSelection.overflow, pipeline: selected.pipeline || initialSelection.pipeline, targets, sensitiveValues });
    if (res.destroyed) return;
    return sendJSON(res, disconnected ? 499 : 502, { error: { message: disconnected ? 'client cancelled request' : 'no upstream response', type: disconnected ? 'client_cancelled' : 'upstream_error' } });
  }
  if (status === 200 && /^cline-pass\//.test(modelId) && !config.knownModels.includes(modelId)) { config.knownModels.push(modelId); saveConfig(); }
  const safeOut = status === 200 ? out : { ...out, error: { ...(out.error || {}), message: safeReason(out?.error?.message || 'upstream error', sensitiveValues) } };
  const usage = status === 200 && !disconnected ? normalizeUsage(routing.usage) : null;
  finalizeStatistics({ globalError: status !== 200 && !disconnected, usage, clientDisconnect: disconnected, segments: statisticsSegments(chain.trace, acc?.id, usage, disconnected) });
  recordChat({
    requestId, requestedModel, resolvedModel: modelId, provider: routing.finalProvider || null, canonical: routing.canonicalSlug || null, ms: Date.now() - chain.t0, stream: false, result: disconnected ? 'client_cancelled' : status === 200 ? 'success' : 'failed',
    attempts: chain.trace.map((t) => t.upstream || 'auto'), trace: chain.trace, error: disconnected ? null : status !== 200 ? safeOut.error.message : null,
    account: acc?.name || null, accountId: acc?.id || null, accountPath, accountActions, accountAction: chain.accountAction?.action || accountActions.at(-1)?.action || null, upstreamStatus: chain.upstreamStatus, normalizedStatus: chain.normalizedStatus, ...affinityFacts(usage),
    strategy: initialSelection.strategy, preferredAccountId: initialSelection.preferredAccountId, preferredAccountName: initialSelection.preferredAccountName, selectionReason: selected.reason, overflow: initialSelection.overflow, pipeline: selected.pipeline || initialSelection.pipeline, targets, appliedHeaderNames: Object.keys(acc?.headers || {}), proxyError: !!acc?.proxyUrl && chain.trace.some((t) => t.upstreamStatus === 0), errorCategory: chain.plan?.allExcluded ? 'routing' : null, sensitiveValues,
  });
  if (res.destroyed) return;
  res.writeHead(disconnected ? 499 : status, {
    'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', ...(chain.retryAfter ? { 'Retry-After': String(chain.retryAfter) } : {}),
    'X-Cline-Target-Upstream': targets.length ? targets.join('>') : targetSource === 'auto' ? 'auto' : 'none', 'X-Cline-Actual-Upstream': routing.finalProvider || 'unknown',
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
  const account = pickAccount();
  const { json } = await fetchJSON(`${config.upstreamBase}/models`, { headers: chatHeaders(account.key) }, 60000, account);
  const ids = (json?.data || []).map((m) => m.id);
  if (ids.length) { META.catalog = ids; META.catalogFetchedAt = Date.now(); saveMeta(); }
  return META.catalog || [];
}

const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://local').pathname;
  if (config.detailedLogging === true && detailRoute(req.method, pathname)) {
    if (DetailRoot.active >= 128) { detailedLogs.health.dropped++; return dispatch(req, res); }
    const secrets = [config.proxyKey, PROXY_KEY, ...config.accounts.flatMap((account) => [account.key, account.proxyUrl])];
    const root = new DetailRoot(req, res, detailedLogs, secrets);
    return detailContext.run(root, () => dispatch(req, res));
  }
  return dispatch(req, res);
});
async function dispatch(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  if (p === '/api/logs/settings' || p === '/api/logs/details' || p.startsWith('/api/logs/details/')) res.setHeader('Cache-Control', 'no-store');
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
    if (req.method === 'POST' && p === '/v1/responses') {
      return sendJSON(res, 501, { error: { message: 'OpenAI Responses API is not supported; use /v1/chat/completions instead', type: 'unsupported_api', param: null, code: 'unsupported_api' } });
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
        return { id, config: own ? account.perModel[id] : (config.perModel[id] || {}), configSource: account ? (own ? 'account' : 'inherited') : 'global', meta: projectModelMeta(META.models[id]) };
      });
      return sendJSON(res, 200, { subscription: sub, catalogCount: cat.length, catalog: cat, proxyBase: publicProxyBase(), officialFetch: META.officialModelsFetch || null, accountId: account?.id || null });
    }
    if (req.method === 'POST' && p === '/api/probe') {
      const input = await readJsonBody(req);
      const model = String(input?.model || '').trim();
      if (!model) return sendJSON(res, 400, { error: 'model required' });
      const selected = await acquireManagementAccount(input?.accountId, `probe\0${model}`);
      if (!selected.lease) return selected.status === 429 || selected.status === 503
        ? sendBusy(res, selected.error, selected.retryAfter, selected.status)
        : sendJSON(res, selected.status, { error: { message: selected.error } });
      let r;
      try { r = await probeModel(model, selected.lease.account); }
      finally { selected.lease.release(); }
      return sendJSON(res, r.ok ? 200 : 502, { ...r, accountId: selected.lease.account.id });
    }
    if (req.method === 'POST' && p === '/api/test') {
      const input = await readJsonBody(req);
      const { model: requestedModel, upstream, upstreams, exclude, pinMode, sort, maxRetries, providerCooldownMs, accountId } = input;
      if (!requestedModel) return sendJSON(res, 400, { error: 'model required' });
      const model = resolveModelAlias(String(requestedModel));
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
      if (pinMode !== undefined) cfg.pinMode = pinMode;
      if (sort !== undefined) cfg.sort = sort;
      if (maxRetries !== undefined) cfg.maxRetries = maxRetries;
      if (providerCooldownMs !== undefined) cfg.providerCooldownMs = providerCooldownMs;
      const routeError = validatePerModelInput({ [model]: cfg });
      if (routeError) { selected.lease.release(); return sendJSON(res, 400, { error: { message: routeError } }); }
      const body = { model, messages: [{ role: 'user', content: 'Reply with the word OK' }], max_tokens: 256 };
      let chain;
      try { chain = await runChatChain(req, body, model, normalizeRouteConfig(cfg), selected.lease.account, {}, { stream: false, attemptTimeoutMs: 180000 }); }
      finally { selected.lease.release(); }
      const trace = chain.trace || [];
      if (chain.status !== 200) { try { saveMeta(); } catch (error) { console.error(`[测试] provider 健康持久化失败：${safeReason(error.message)}`); } return sendJSON(res, 200, { ok: false, error: safeReason(chain.out?.error?.message || 'upstream error'), targets: cfg.upstreams || [], exclude: cfg.exclude || [], trace }); }
      const r = parseRouting(chain.out);
      record(model, { provider: r.finalProvider, canonical: r.canonicalSlug, ms: Date.now() - t0, stream: false, attempts: trace.map((t) => t.upstream || 'auto'), error: null, account: chain.acc?.name || null });
      return sendJSON(res, 200, { ok: true, ms: Date.now() - t0, targets: cfg.upstreams || [], exclude: cfg.exclude || [], actual: r.finalProvider, actualName: r.finalProviderName, pipeline: r.pipeline, pinnable: r.pipeline !== null, canonicalSlug: r.canonicalSlug, fallbacks: r.fallbacks, content: (r.content || '').slice(0, 120), account: chain.acc?.name || null, trace });
    }
    if (req.method === 'GET' && p === '/api/model-aliases') {
      return sendJSON(res, 200, { aliases: config.modelAliases || {}, targets: (config.knownModels || []).filter((id) => id.startsWith('cline-pass/')) });
    }
    if (req.method === 'POST' && p === '/api/model-aliases') {
      const body = await readJsonBody(req);
      const aliases = body?.aliases;
      const error = validateModelAliases(aliases);
      if (error) return sendJSON(res, 400, { error: { message: error } });
      config.modelAliases = normalizeModelAliases(aliases); saveConfig();
      return sendJSON(res, 200, { ok: true, count: Object.keys(config.modelAliases).length });
    }
    if (p === '/api/logs/settings' || p === '/api/logs/details' || p.startsWith('/api/logs/details/')) {
      if (p === '/api/logs/settings') {
        if (req.method === 'GET') return sendJSON(res, 200, { detailedLogging: config.detailedLogging === true, authRequired: !!PROXY_KEY, maxBodyBytes: MAX_BODY_BYTES, maxAgeMs: MAX_AGE_MS, maxTotalBytes: MAX_TOTAL_BYTES, health: { ...detailedLogs.health, captureDropped: captureBudget.dropped, retainedPayloadBytes: captureBudget.used } });
        if (req.method === 'POST') {
          const body = await readJsonBody(req);
          if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 || typeof body.detailedLogging !== 'boolean') return sendJSON(res, 400, { error: { message: 'expected only boolean detailedLogging' } });
          try { atomicWriteJson(CONFIG_PATH, { ...config, detailedLogging: body.detailedLogging }); }
          catch { return sendJSON(res, 500, { error: { message: 'logging setting could not be saved' } }); }
          config.detailedLogging = body.detailedLogging;
          return sendJSON(res, 200, { ok: true, detailedLogging: config.detailedLogging });
        }
      }
      if (p === '/api/logs/details') {
        if (req.method === 'GET') return sendJSON(res, 200, await detailedLogs.query(parseDetailQuery(url.searchParams)));
        if (req.method === 'DELETE') return sendJSON(res, 200, await detailedLogs.clear());
      }
      if (req.method === 'GET' && p.startsWith('/api/logs/details/')) {
        const parts = p.slice('/api/logs/details/'.length).split('/');
        if (url.search) return sendJSON(res, 400, { error: { message: 'invalid detailed log query' } });
        if (parts.length === 1) return sendJSON(res, 200, await detailedLogs.detail(parts[0]));
        if (parts.length === 3 && parts[1] === 'bodies') {
          const text = await detailedLogs.body(parts[0], parts[2]);
          res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' }); return res.end(text);
        }
        return sendJSON(res, 400, { error: { message: 'invalid detailed log identity' } });
      }
    }
    if ((req.method === 'GET' || req.method === 'DELETE') && (p === '/api/logs/requests' || p === '/api/logs/errors')) {
      const store = p.endsWith('/errors') ? errorLogs : requestLogs;
      if (req.method === 'DELETE') { await store.clear(); return sendJSON(res, 200, { ok: true }); }
      const allowed = p.endsWith('/errors')
        ? ['from','to','requestId','model','requestedModel','resolvedModel','account','accountId','accountName','status','upstreamStatus','category','provider','targetProvider','accountAction','errorScope','scopeEvidence','failureClass','healthAction','responseContentType']
        : ['from','to','requestId','model','requestedModel','resolvedModel','account','accountId','accountName','strategy','status','result','upstreamStatus','stream','provider','actualProvider','targetProviders','overflow','switched','accountAction','errorCategory'];
      const rawLimit = url.searchParams.get('limit') || '50', cursor = url.searchParams.get('cursor') || '';
      const allowedParams = new Set([...allowed, 'limit', 'cursor']);
      for (const key of url.searchParams.keys()) if (!allowedParams.has(key)) return sendJSON(res, 400, { error: { message: `unknown log filter: ${key}` } });
      if (!/^\d+$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > 200 || cursor.length > 512) return sendJSON(res, 400, { error: { message: 'invalid log pagination' } });
      if (cursor) { try { const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); if (!Number.isFinite(Number(decoded.ts)) || typeof decoded.requestId !== 'string') throw new Error(); } catch { return sendJSON(res, 400, { error: { message: 'invalid log cursor' } }); } }
      const filters = {};
      for (const key of allowed) if (url.searchParams.has(key)) {
        const value = url.searchParams.get(key);
        if (value.length > 300) return sendJSON(res, 400, { error: { message: `invalid log filter: ${key}` } });
        if (['from', 'to'].includes(key) && !/^\d+$/.test(value)) return sendJSON(res, 400, { error: { message: `invalid log time filter: ${key}` } });
        if (['status', 'upstreamStatus'].includes(key) && !/^\d{1,3}$/.test(value)) return sendJSON(res, 400, { error: { message: `invalid numeric log filter: ${key}` } });
        if (['stream', 'overflow', 'switched'].includes(key) && !['true', 'false'].includes(value)) return sendJSON(res, 400, { error: { message: `invalid boolean log filter: ${key}` } });
        filters[key] = ['stream', 'overflow', 'switched'].includes(key) ? value === 'true' : value;
      }
      return sendJSON(res, 200, await store.query({ limit: Number(rawLimit), cursor, filters }));
    }
    if (req.method === 'POST' && p === '/api/accounts/proxy-test') {
      const body = await readJsonBody(req);
      const account = config.accounts.find((a) => a.id === String(body?.accountId || ''));
      if (!account) return sendJSON(res, 400, { error: { message: 'unknown accountId' } });
      let proxyUrl;
      try { proxyUrl = body.proxyUrl === undefined ? account.proxyUrl : normalizeProxyUrl(body.proxyUrl, { strict: true }); }
      catch (e) { return sendJSON(res, 400, { error: { message: e.message } }); }
      if (!proxyUrl) return sendJSON(res, 400, { error: { message: 'proxyUrl is required' } });
      const t0 = Date.now();
      try {
        const model = config.knownModels[0];
        const result = await clineRequestJSON(`${config.upstreamBase}/chat/completions`, { headers: responseHeadersFor(account, {}), body: JSON.stringify({ model, messages: [], max_tokens: 1 }), proxyUrl, account, timeoutMs: 15000 });
        return sendJSON(res, 200, { ok: result.status > 0, proxyType: new URL(proxyUrl).protocol.replace(':', ''), ms: Date.now() - t0, status: result.status });
      } catch (e) {
        let reason = String(e.message || 'proxy error');
        try { const u = new URL(proxyUrl); for (const secret of [proxyUrl, decodeURIComponent(u.username), decodeURIComponent(u.password)].filter(Boolean)) reason = reason.split(secret).join('[REDACTED]'); } catch {}
        return sendJSON(res, 200, { ok: false, proxyType: new URL(proxyUrl).protocol.replace(':', ''), ms: Date.now() - t0, errorCategory: 'proxy', reason: safeReason(reason) });
      }
    }
    if (req.method === 'POST' && p === '/api/statistics/quota-refresh') {
      if (url.search) return sendJSON(res, 400, { error: { message: 'quota refresh does not accept query parameters' } });
      if (quotaPageBatches >= QUOTA_PAGE_BATCH_LIMIT) { res.setHeader('Retry-After', '1'); return sendJSON(res, 429, { error: { message: 'too many active quota refreshes' } }); }
      const token = createQuotaPageToken();
      const onClose = () => { if (!res.writableFinished) cancelQuotaPageToken(token); };
      res.once('close', onClose);
      try {
        let body;
        try { body = await readJsonBody(req); }
        catch (error) { if (!token.active || res.destroyed) return; throw error; }
        if (!isPlainObject(body) || Object.keys(body).length !== 1 || typeof body.force !== 'boolean') return sendJSON(res, 400, { error: { message: 'expected only boolean force' } });
        token.force = body.force;
        if (!token.active || res.destroyed) return;
        const ids = config.accounts.map((account) => account.id);
        const slots = Math.ceil(ids.length / QUOTA_GLOBAL_LIMIT) + 1;
        token.deadline = setTimeout(() => cancelQuotaPageToken(token), Math.min(2147483647, Math.max(QUOTA_TIMEOUT_MS, slots * QUOTA_TIMEOUT_MS))); token.deadline.unref?.();
        const outcomes = await Promise.all(ids.map((id) => requestQuota(id, { pageToken: token, force: body.force })));
        if (!token.active && (res.destroyed || !res.writable)) return;
        const counts = { refreshed: 0, cached: 0, deferred: 0, skipped: 0, failed: 0, cancelled: 0 };
        for (const outcome of outcomes) counts[Object.hasOwn(counts, outcome) ? outcome : 'failed']++;
        return sendJSON(res, 200, { ok: true, ...counts });
      } finally {
        res.off('close', onClose); releaseQuotaPageToken(token);
      }
    }
    if (req.method === 'GET' && p === '/api/statistics') {
      pruneStatistics();
      const generatedAt = Date.now(), recentGlobal = aggregateRange().aggregate;
      const accounts = config.accounts.map((account) => { const recent = aggregateRange(account.id).aggregate; return { id: account.id, name: account.name, enabled: account.enabled !== false, lifetime: projectAggregate(META.statistics.lifetime.accounts[account.id] || emptyAggregate()), recent24h: projectAggregate(recent), health: healthProjection(account), quota: statisticsQuotaProjection(account, generatedAt) }; });
      const models = statisticsModelIds().map((id) => ({ id, recent24h: projectAggregate(aggregateModelRange(id, generatedAt)), coverage: modelCoverage(id, generatedAt) }));
      return sendJSON(res, 200, { generatedAt, window: { kind: 'last-1440-minutes', from: (Math.floor(generatedAt/60000)-1439)*60000, to: generatedAt }, lifetime: { global: projectAggregate(META.statistics.lifetime.global) }, recent24h: { global: projectAggregate(recentGlobal) }, routingCoverage: routingCoverage(generatedAt), accounts, models, migration: META.statistics.migration });
    }
    if (req.method === 'GET' && p === '/api/accounts') {
      clearExpiredCooldowns();
      const cacheRoles = cachePoolRoles();
      return sendJSON(res, 200, {
        accounts: config.accounts.map((a) => { const recent = projectAggregate(aggregateRange(a.id).aggregate),lifetime=META.statistics.lifetime.accounts[a.id]; return { ...a, state: getAccountState(a.id), activeCount: activeCounts.get(a.id) || 0, health: healthProjection(a), quota: quotaProjection(a.id), cachePoolRole: cacheRoles.get(a.id) ?? null, statistics: { recent24h: recent, lifetimeRequests: lifetime ? lifetime.requests : 0, lifetimeErrors: lifetime ? lifetime.errors : 0 } }; }),
        mode: config.accountMode, active: config.activeAccount, concurrencyWaitMs: config.concurrencyWaitMs,
        accountErrorRules: config.accountErrorRules, accountContentErrorRules: config.accountContentErrorRules, accountPipeline: config.accountPipeline,
        stats: Object.fromEntries(config.accounts.map((a) => [a.name, { requests: META.statistics.lifetime.accounts[a.id]?.requests ?? 0 }])),
      });
    }
    if (req.method === 'POST' && p === '/api/accounts') {
      const body = await readJsonBody(req);
      if (!body || typeof body !== 'object' || !Array.isArray(body.accounts)) return sendJSON(res, 400, { error: { message: 'accounts array is required' } });
      if (!ACCOUNT_MODES.has(body.mode)) return sendJSON(res, 400, { error: { message: 'invalid account mode' } });
      const wait = Number(body.concurrencyWaitMs ?? 2000);
      if (!Number.isInteger(wait) || wait < 0 || wait > 30000) return sendJSON(res, 400, { error: { message: 'concurrencyWaitMs must be an integer from 0 to 30000' } });
      const ruleError = validateAccountErrorRulesInput(body.accountErrorRules || {});
      if (ruleError) return sendJSON(res, 400, { error: { message: ruleError } });
      let requestedContentRules = config.accountContentErrorRules, requestedPipeline = config.accountPipeline;
      try {
        if (body.accountContentErrorRules !== undefined) requestedContentRules = normalizeAccountContentErrorRules(body.accountContentErrorRules, { strict: true });
        if (body.accountPipeline !== undefined) requestedPipeline = normalizeAccountPipeline(body.accountPipeline, { strict: true, fallbackOrder: config.accountPipeline.order, fallbackCachePoolSize: configuredCachePoolSize() });
      } catch (e) { return sendJSON(res, 400, { error: { message: e.message } }); }
      if (!Number.isInteger(Number(body.active ?? 0)) || Number(body.active ?? 0) < 0 || Number(body.active ?? 0) >= body.accounts.length) return sendJSON(res, 400, { error: { message: 'active account index is out of range' } });
      const existingIds = new Set(config.accounts.map((a) => a.id));
      for (const [i, a] of body.accounts.entries()) {
        if (!a || typeof a !== 'object' || Array.isArray(a)) return sendJSON(res, 400, { error: { message: `invalid account at index ${i}` } });
        if (a.id !== undefined && (!/^[A-Za-z0-9_-]{1,100}$/.test(String(a.id)) || !existingIds.has(String(a.id)))) return sendJSON(res, 400, { error: { message: `invalid or immutable account id at index ${i}` } });
        if (a.name !== undefined && (typeof a.name !== 'string' || a.name.length > 50 || /[\x00-\x1f\x7f]/.test(a.name))) return sendJSON(res, 400, { error: { message: `invalid account name at index ${i}` } });
        if (a.note !== undefined && !validateNote(a.note)) return sendJSON(res, 400, { error: { message: `invalid note at index ${i}` } });
        if (a.key !== undefined && (typeof a.key !== 'string' || a.key.length > 4096 || /[\r\n\x00]/.test(a.key))) return sendJSON(res, 400, { error: { message: `invalid account key at index ${i}` } });
        const max = Number(a.maxConcurrent ?? 0);
        if (!Number.isInteger(max) || max < 0 || max > 100000) return sendJSON(res, 400, { error: { message: `invalid maxConcurrent at index ${i}` } });
        for (const field of ['weight', 'priority']) if (a[field] !== undefined && (!Number.isInteger(Number(a[field])) || Number(a[field]) < 1 || Number(a[field]) > 100)) return sendJSON(res, 400, { error: { message: `invalid ${field} at index ${i}` } });
        try { normalizeProxyUrl(a.proxyUrl, { strict: true }); validateAndNormalizeHeaders(a.headers, { strict: true }); }
        catch (e) { return sendJSON(res, 400, { error: { message: `account ${i}: ${e.message}` } }); }
        const routeError = validatePerModelInput(a.perModel || {});
        if (routeError) return sendJSON(res, 400, { error: { message: `account ${i}: ${routeError}` } });
      }
      const previousById = new Map(config.accounts.map((a) => [a.id, a]));
      const previousByName = new Map(config.accounts.map((a) => [a.name, a]));
      const seen = new Set();
      const normalizedAccounts = body.accounts.map((a, i) => normalizeAccount(a, i, previousById, previousByName));
      const requestedActiveId = normalizedAccounts[Number(body.active)]?.id;
      const accs = normalizedAccounts.filter((a) => a.key);
      if (!accs.length) return sendJSON(res, 400, { error: { message: '至少需要一个有效账号（key 非空）' } });
      for (const a of accs) { if (seen.has(a.id)) return sendJSON(res, 400, { error: { message: 'duplicate account id' } }); seen.add(a.id); }
      const requestedActive = requestedActiveId ? accs.findIndex((a) => a.id === requestedActiveId) : -1;
      const quotaRoutingWasEnabled = quotaRoutingEnabled();
      config.accounts = accs; config.accountMode = body.mode; config.activeAccount = requestedActive >= 0 ? requestedActive : Math.min(Math.max(0, Number(body.active) || 0), accs.length - 1);
      config.concurrencyWaitMs = wait; config.accountErrorRules = normalizeAccountErrorRules(body.accountErrorRules || {}); config.accountContentErrorRules = requestedContentRules; config.accountPipeline = requestedPipeline;
      for (const [id, previous] of previousById) {
        const current = accs.find((a) => a.id === id);
        if (!current) { invalidateQuotaAccount(id, { clearSnapshot: true, deleted: true }); clearProviderCircuitForAccount(id); }
        else if (current.key !== previous.key || current.proxyUrl !== previous.proxyUrl) { invalidateQuotaAccount(id, { clearSnapshot: true }); clearProviderCircuitForAccount(id); }
        else if (previous.enabled !== false && current.enabled === false) { invalidateQuotaAccount(id); clearProviderCircuitForAccount(id); }
        else for (const model of new Set([...Object.keys(previous.perModel || {}), ...Object.keys(current.perModel || {})])) if (JSON.stringify(previous.perModel?.[model]) !== JSON.stringify(current.perModel?.[model])) clearProviderCircuitForRoute(id, model);
      }
      if (quotaRoutingWasEnabled !== quotaRoutingEnabled()) advanceQuotaRoutingEpoch();
      for (const id of Object.keys(META.accountStates || {})) if (!seen.has(id)) delete META.accountStates[id];
      for (const id of Object.keys(META.statistics.lifetime.accounts)) if (!seen.has(id)) delete META.statistics.lifetime.accounts[id];
      for (const bucket of META.statistics.minuteBuckets) for (const id of new Set([...Object.keys(bucket.accounts),...Object.keys(bucket.health)])) if (!seen.has(id)) { delete bucket.accounts[id]; delete bucket.health[id]; }
      for (const id of Object.keys(META.statistics.recentCoverage.accountIncompleteAt)) if (!seen.has(id)) delete META.statistics.recentCoverage.accountIncompleteAt[id];
      for (const id of activeCounts.keys()) if (!seen.has(id)) activeCounts.delete(id);
      saveConfig(); saveMeta(); RR_COUNTER = 0; strategyCounters.clear(); proxyAgents.clear(); scheduleQuotaRefresh();
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
      const input = await readJsonBody(req);
      const k = String(input?.key || '').trim();
      if (!k) return sendJSON(res, 400, { error: { message: 'key required' } });
      const saved = config.accounts.find((a) => a.id === String(input?.accountId || ''));
      let proxyUrl = saved?.proxyUrl || '';
      try { if (input?.proxyUrl !== undefined) proxyUrl = normalizeProxyUrl(input.proxyUrl, { strict: true }); }
      catch (e) { return sendJSON(res, 400, { error: { message: e.message } }); }
      const account = { ...(saved || {}), key: k, proxyUrl };
      const t0 = Date.now();
      const model = config.knownModels[0] || 'cline-pass/glm-5.3-flash';
      let json;
      try {
        ({ json } = await accountFetchJSON(`${config.upstreamBase}/chat/completions`, {
          headers: chatHeaders(k), body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Say OK' }], max_tokens: 512 }),
        }, 120000, account));
      } catch (e) { return sendJSON(res, 200, { ok: false, ms: Date.now() - t0, error: safeReason(e.message), errorCategory: proxyUrl ? 'proxy' : 'network' }); }
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
      const input = await readJsonBody(req);
      const model = String(input?.model || '').trim();
      if (!model) return sendJSON(res, 400, { error: { message: 'model required' } });
      const selected = await acquireManagementAccount(input?.accountId, `validate\0${model}`);
      if (!selected.lease) return selected.status === 429 || selected.status === 503
        ? sendBusy(res, selected.error, selected.retryAfter, selected.status)
        : sendJSON(res, selected.status, { error: { message: selected.error } });
      let results;
      try { results = await validateUpstreams(model, selected.lease.account); }
      finally { selected.lease.release(); }
      const summary = { ok: 0, limited: 0, bad: 0, auth: 0, unknown: 0, accountFaults: 0 };
      for (const fact of Object.values(results)) { summary[fact.status] = (summary[fact.status] || 0) + 1; if (fact.accountFault) summary.accountFaults++; }
      return sendJSON(res, 200, { ok: true, accountId: selected.lease.account.id, summary, results, upstreams: META.models[model]?.upstreams || [] });
    }
    if (req.method === 'POST' && p === '/api/fetch-official-models') {
      const r = await fetchOfficialModels();
      return sendJSON(res, 200, { ok: true, ...r });
    }
    if (req.method === 'GET' && p === '/api/history') return sendJSON(res, 200, { history: recentHistory });
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
        delete target.perModel[model];
        clearProviderCircuitForRoute(target.id, model);
        saveConfig();
        return sendJSON(res, 200, { ok: true, source: 'inherited' });
      }
      if (body.perModel === undefined) return sendJSON(res, 400, { error: { message: 'perModel is required' } });
      const routeError = validatePerModelInput(body.perModel);
      if (routeError) return sendJSON(res, 400, { error: { message: routeError } });
      for (const [m, c] of Object.entries(body.perModel)) {
        const model = String(m).trim();
        target.perModel[model] = normalizeRouteConfig(c);
        if (scope === 'account') clearProviderCircuitForRoute(target.id, model);
        else for (const account of config.accounts) if (!Object.prototype.hasOwnProperty.call(account.perModel || {}, model)) clearProviderCircuitForRoute(account.id, model);
      }
      saveConfig();
      return sendJSON(res, 200, { ok: true, scope });
    }
    if (req.method === 'GET' && (p === '/v1/models' || p === '/api/v1/models' || p === '/models')) {
      // 默认只暴露订阅模型，避免目录模型淹没客户端的模型选择器；exposeCatalog=true 时合并完整目录
      const ids = config.exposeCatalog
        ? [...new Set([...config.knownModels, ...(await catalog()), ...Object.keys(config.modelAliases || {})])]
        : [...new Set([...config.knownModels, ...Object.keys(config.perModel), ...Object.keys(config.modelAliases || {})])];
      return sendJSON(res, 200, { object: 'list', data: ids.map((id) => ({ id, object: 'model' })) });
    }
    if (CHAT_PATHS.has(p) && req.method === 'POST') return await handleChat(req, res);
    return sendJSON(res, 404, { error: { message: `no route: ${req.method} ${p}` } });
  } catch (e) {
    return sendJSON(res, Number.isInteger(e?.statusCode) ? e.statusCode : 500, { error: { message: safeReason(e.message || 'internal error') } });
  }
}

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
  scheduleQuotaRefresh();
});
