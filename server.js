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
import { JsonlLogStore, enforceCombinedLimit } from './lib/jsonl-log-store.js';

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
  exposeCatalog: false,    // true 时 /v1/models 合并完整目录模型（默认仅订阅模型）
  upstreamBase: 'https://api.cline.bot/api/v1',
  accounts: [],            // { id, name, key, enabled, maxConcurrent, perModel } —— Cline Pass 账号池
  accountMode: 'single',   // single=手动指定 | roundrobin=轮询 | sticky=会话 HRW 粘性
  activeAccount: 0,        // single 模式下使用的账号下标
  concurrencyWaitMs: 2000,
  accountErrorRules: {},   // "429": { action: 'cooldown', cooldownMs: 1800000 } | { action: 'ban' } | { action: 'ignore' }
  accountPipeline: { quotaPool: false, excludeUnhealthy: false, healthSort: false, sticky: false },
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
const requestLogs = new JsonlLogStore({ dir: LOG_DIR, prefix: 'requests', maxRecords: 50000 });
const errorLogs = new JsonlLogStore({ dir: LOG_DIR, prefix: 'errors', maxRecords: 10000 });
enforceCombinedLimit(LOG_DIR, 100 * 1024 * 1024);
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
function normalizeAccountPipeline(value, { strict = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    if (strict) throw new Error('accountPipeline must be an object');
    value = {};
  }
  if (strict && Object.keys(value).some((key) => !PIPELINE_KEYS.includes(key))) throw new Error('accountPipeline contains an unknown field');
  const out = {};
  for (const key of PIPELINE_KEYS) {
    if (strict && typeof value[key] !== 'boolean') throw new Error(`accountPipeline.${key} must be boolean`);
    out[key] = value[key] === true;
  }
  return out;
}
const AGG_FIELDS = ['requests','errors','usageRequests','inputKnownRequests','inputTokens','outputKnownRequests','outputTokens','totalKnownRequests','totalTokens','cacheKnownRequests','cacheHitRequests','cachedTokens','cacheInputKnownRequests','cacheInputTokens','cacheInputCachedTokens'];
const HEALTH_FIELDS = ['results','penaltyUnits','errors','auth','rateLimit','networkProxy','server','other'];
function emptyAggregate() { return Object.fromEntries([...AGG_FIELDS.map((key) => [key, 0]), ['lastUsedAt', 0], ['lastErrorAt', 0], ['overflowFields', []]]); }
function emptyHealth() { return Object.fromEntries(HEALTH_FIELDS.map((key) => [key, 0])); }
function isPlainObject(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
function validateAggregate(value, label) {
  if (!isPlainObject(value) || Object.keys(value).some((key) => ![...AGG_FIELDS,'lastUsedAt','lastErrorAt','overflowFields'].includes(key))) throw new Error(`invalid statistics ${label}`);
  const overflow = value.overflowFields;
  if (!Array.isArray(overflow) || overflow.some((key) => !AGG_FIELDS.includes(key)) || new Set(overflow).size !== overflow.length) throw new Error(`invalid statistics ${label}.overflowFields`);
  for (const key of AGG_FIELDS) {
    const overflowed = overflow.includes(key);
    if ((overflowed && value[key] !== null) || (!overflowed && (!Number.isSafeInteger(value[key]) || value[key] < 0))) throw new Error(`invalid statistics ${label}.${key}`);
  }
  for (const key of ['lastUsedAt','lastErrorAt']) if (!Number.isSafeInteger(value[key]) || value[key] < 0) throw new Error(`invalid statistics ${label}.${key}`);
}
function validateHealth(value, label) {
  if (!isPlainObject(value) || Object.keys(value).some((key) => !HEALTH_FIELDS.includes(key))) throw new Error(`invalid statistics ${label}`);
  for (const key of HEALTH_FIELDS) if (!Number.isSafeInteger(value[key]) || value[key] < 0) throw new Error(`invalid statistics ${label}.${key}`);
}
function createStatistics() {
  return { version: 1, lifetime: { global: emptyAggregate(), accounts: {} }, minuteBuckets: [], recentCoverage: { droppedAccountMinuteCells: 0, accountIncompleteAt: {} }, migration: { legacyStatsMigratedAt: Date.now(), legacyRequests: 0, accountLegacyRequests: {}, ambiguousNames: 0, unmappedNames: 0 } };
}
function validateStatistics(stats) {
  if (!isPlainObject(stats) || stats.version !== 1) throw new Error(stats?.version > 1 ? 'unsupported statistics version' : 'invalid statistics version');
  if (Object.keys(stats).some((key) => !['version','lifetime','minuteBuckets','recentCoverage','migration'].includes(key)) || !isPlainObject(stats.lifetime) || Object.keys(stats.lifetime).some((key) => !['global','accounts'].includes(key)) || !isPlainObject(stats.lifetime.accounts) || !Array.isArray(stats.minuteBuckets) || stats.minuteBuckets.length > 1440 || !isPlainObject(stats.recentCoverage) || Object.keys(stats.recentCoverage).some((key) => !['droppedAccountMinuteCells','accountIncompleteAt'].includes(key)) || !Number.isSafeInteger(stats.recentCoverage.droppedAccountMinuteCells) || stats.recentCoverage.droppedAccountMinuteCells < 0 || !isPlainObject(stats.recentCoverage.accountIncompleteAt) || !isPlainObject(stats.migration)) throw new Error('invalid statistics structure');
  for (const [id, minute] of Object.entries(stats.recentCoverage.accountIncompleteAt)) if (!/^[A-Za-z0-9_-]{1,100}$/.test(id) || !Number.isSafeInteger(minute) || minute < 0) throw new Error('invalid statistics coverage');
  if (Object.keys(stats.migration).some((key) => !['legacyStatsMigratedAt','legacyRequests','accountLegacyRequests','ambiguousNames','unmappedNames'].includes(key)) || !Number.isSafeInteger(stats.migration.legacyStatsMigratedAt) || stats.migration.legacyStatsMigratedAt < 0 || !Number.isSafeInteger(stats.migration.legacyRequests) || stats.migration.legacyRequests < 0 || !isPlainObject(stats.migration.accountLegacyRequests) || !Number.isSafeInteger(stats.migration.ambiguousNames) || stats.migration.ambiguousNames < 0 || !Number.isSafeInteger(stats.migration.unmappedNames) || stats.migration.unmappedNames < 0) throw new Error('invalid statistics migration');
  for (const [id, requests] of Object.entries(stats.migration.accountLegacyRequests)) if (!/^[A-Za-z0-9_-]{1,100}$/.test(id) || !Number.isSafeInteger(requests) || requests < 0) throw new Error('invalid statistics legacy account');
  validateAggregate(stats.lifetime.global, 'lifetime.global');
  for (const [id, aggregate] of Object.entries(stats.lifetime.accounts)) { if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new Error('invalid statistics account id'); validateAggregate(aggregate, `lifetime.accounts.${id}`); }
  let previous = -1, cells = 0;
  for (const bucket of stats.minuteBuckets) {
    if (!isPlainObject(bucket) || Object.keys(bucket).some((key) => !['minute','global','accounts','health'].includes(key)) || !Number.isSafeInteger(bucket.minute) || bucket.minute < 0 || bucket.minute <= previous || !isPlainObject(bucket.global) || !isPlainObject(bucket.accounts) || !isPlainObject(bucket.health)) throw new Error('invalid statistics minute bucket');
    previous = bucket.minute; validateAggregate(bucket.global, `bucket.${bucket.minute}.global`);
    const ids = new Set([...Object.keys(bucket.accounts), ...Object.keys(bucket.health)]); cells += ids.size;
    for (const [id, aggregate] of Object.entries(bucket.accounts)) { if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new Error('invalid statistics account id'); validateAggregate(aggregate, `bucket.${bucket.minute}.accounts.${id}`); }
    for (const [id, health] of Object.entries(bucket.health)) { if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new Error('invalid statistics account id'); validateHealth(health, `bucket.${bucket.minute}.health.${id}`); }
  }
  if (cells > 50000) throw new Error('statistics account-minute cell limit exceeded');
}
function normalizeStatistics() {
  if (META.statistics !== undefined) { validateStatistics(META.statistics); return false; }
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
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
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
function pipelineEnabled() { return PIPELINE_KEYS.some((key) => config.accountPipeline?.[key]); }
function quotaProjection(accountId, now = Date.now()) {
  const q = META.accountQuotas?.[accountId];
  const snapshot = q?.snapshot;
  const complete = snapshot && q.errorCategory == null && q.lastSuccessAt === snapshot.fetchedAt && q.lastAttemptAt <= q.lastSuccessAt && ['five_hour','weekly','monthly'].every((type) => snapshot.limits?.[type]) && snapshot.fetchedAt <= now && now - snapshot.fetchedAt <= QUOTA_STALE_MS;
  if (!complete) return { status: 'unknown', pool: 'unknown', fetchedAt: snapshot?.fetchedAt || null, limits: snapshot?.limits || {}, errorCategory: q?.errorCategory || null };
  const maximum = Math.max(...Object.values(snapshot.limits).map((limit) => limit.percentUsed));
  return { status: 'fresh', pool: maximum < 80 ? 'hot' : maximum < 95 ? 'warm' : 'reserve', fetchedAt: snapshot.fetchedAt, limits: snapshot.limits, errorCategory: null };
}
function buildPipelineGroups(list) {
  const diagnostics = [];
  let candidates = list.map((account) => ({ account, health: healthProjection(account), quota: quotaProjection(account.id) }));
  if (config.accountPipeline.excludeUnhealthy) {
    const kept = candidates.filter((item) => item.health.status !== 'unhealthy');
    if (kept.length) { if (kept.length < candidates.length) diagnostics.push('health-filtered'); candidates = kept; }
    else if (candidates.length) {
      const best = Math.max(...candidates.map((item) => item.health.score ?? -1));
      candidates = candidates.filter((item) => (item.health.score ?? -1) === best).sort((a,b) => a.account.id.localeCompare(b.account.id)); diagnostics.push('health-filter-fallback');
    }
  }
  const quotaOrder = config.accountPipeline.quotaPool && candidates.some((item) => item.quota.pool !== 'unknown') ? ['hot','warm','unknown','reserve'] : [null];
  if (quotaOrder[0] === null && config.accountPipeline.quotaPool) diagnostics.push('quota-all-unknown');
  const healthOrder = config.accountPipeline.healthSort ? [['available','insufficient'],['degraded'],['unhealthy']] : [null];
  const groups = [];
  for (const quota of quotaOrder) for (const health of healthOrder) {
    const accounts = candidates.filter((item) => (!quota || item.quota.pool === quota) && (!health || health.includes(item.health.status))).map((item) => item.account);
    if (accounts.length) groups.push({ accounts, quota: quota || 'ordinary', health: health ? (health.includes('available') ? 'available-or-insufficient' : health[0]) : 'ordinary' });
  }
  return { groups, diagnostics };
}
async function acquirePipelineAccountLease(identity, { excludeIds = new Set(), allowOverflow = true } = {}) {
  const mode = config.accountMode, waitMs = Math.min(30000, Math.max(0, Number(config.concurrencyWaitMs) || 0)), deadline = Date.now() + waitMs;
  while (true) {
    const list = enabledAccounts({ excludeIds });
    if (!list.length) return { error: 'no available upstream account', strategy: mode };
    const plan = buildPipelineGroups(list); const sticky = !!identity?.fingerprint && (config.accountPipeline.sticky || mode === 'sticky');
    const primary = sticky ? hrwRank(plan.groups[0].accounts, identity.fingerprint)[0] : null;
    if (primary) {
      const lease = tryLease(primary);
      if (lease) { const result = selectionResult(lease, mode, primary, 'pipeline-sticky-primary', identity); result.pipeline = { ...plan, groups: undefined, selectedQuota: plan.groups[0].quota, selectedHealth: plan.groups[0].health }; return result; }
      if (mode === 'single') {
        const leaseAfterWait = await waitForLease([primary], Math.max(0, deadline - Date.now()));
        if (leaseAfterWait) return { ...selectionResult(leaseAfterWait, mode, primary, 'pipeline-sticky-primary', identity), pipeline: { diagnostics: plan.diagnostics, selectedQuota: plan.groups[0].quota, selectedHealth: plan.groups[0].health } };
        return { error: 'upstream account is busy', retryAfter: retryAfterSeconds(waitMs), strategy: mode };
      }
      if (mode === 'sticky') {
        const leaseAfterWait = await waitForLease([primary], Math.max(0, deadline - Date.now()));
        if (leaseAfterWait) return { ...selectionResult(leaseAfterWait, mode, primary, 'pipeline-sticky-primary', identity), pipeline: { diagnostics: plan.diagnostics, selectedQuota: plan.groups[0].quota, selectedHealth: plan.groups[0].health } };
      }
    }
    if (mode === 'single' && !primary) {
      const chosen = singlePreferred(plan.groups[0].accounts) || plan.groups[0].accounts[0];
      const lease = await waitForLease([chosen], Math.max(0, deadline - Date.now()));
      if (lease) return { ...selectionResult(lease, mode, chosen, 'single-selected', identity), pipeline: { diagnostics: plan.diagnostics, selectedQuota: plan.groups[0].quota, selectedHealth: plan.groups[0].health } };
      return { error: 'upstream account is busy', retryAfter: retryAfterSeconds(waitMs), strategy: mode };
    }
    for (let groupIndex = 0; groupIndex < plan.groups.length; groupIndex++) {
      const group = plan.groups[groupIndex], available = group.accounts.filter((account) => account.id !== primary?.id && accountHasCapacity(account));
      if (!available.length) continue;
      let ranked;
      if (mode === 'single') { const preferred = singlePreferred(group.accounts); ranked = available.includes(preferred) ? [preferred] : [available[0]]; }
      else if (mode === 'sticky' && identity?.fingerprint) ranked = hrwRank(available, identity.fingerprint);
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
  const { json } = await accountFetchJSON(`${config.upstreamBase}/chat/completions`, { headers: chatHeaders(acc.key), body: JSON.stringify(body) }, 60000, acc);
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
  const { json } = await accountFetchJSON(`${config.upstreamBase}/chat/completions`, {
    headers: chatHeaders(acc.key), body: JSON.stringify(body),
  }, 180000, acc);
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
function updateProviderHealth(modelId, upstream, { success = false, classification = null, note = '' } = {}, now = Date.now()) {
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
    delayMs = Math.min(2 * 60e3, 15e3 * (2 ** Math.min(20, failures - 1)));
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
      const { json } = await accountFetchJSON(`${config.upstreamBase}/chat/completions`, {
        headers: chatHeaders(acc.key), body: JSON.stringify(body),
      }, 60000, acc).catch(() => ({ json: { error: 'network error' } }));
      let status = 'unknown';
      let note = '';
      if (json?.error && !json?.data) {
        const msg = typeof json.error === 'string' ? json.error : JSON.stringify(json.error);
        status = classifyUpstreamError(msg);
        note = safeReason(msg);
        if (status === 'limited') updateProviderHealth(modelId, slug, { classification: { scope: 'provider', evidence: 'probe_rate_limit', failureClass: 'rate_limit', retryAfterMs: null }, note });
        else if (status === 'bad') updateProviderHealth(modelId, slug, { classification: { scope: 'provider', evidence: 'probe_unsupported', failureClass: 'unsupported', retryAfterMs: null }, note });
      } else if (json?.data?.choices || json?.choices) {
        status = 'ok';
        updateProviderHealth(modelId, slug, { success: true, note: 'validation success' });
      }
      results[slug] = { status, ms: Date.now() - t0, note };
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
  let cells = stats.minuteBuckets.reduce((sum,bucket) => sum + new Set([...Object.keys(bucket.accounts),...Object.keys(bucket.health)]).size, 0);
  for (const bucket of stats.minuteBuckets) {
    if (cells <= 50000) break;
    for (const id of new Set([...Object.keys(bucket.accounts),...Object.keys(bucket.health)])) {
      if (cells-- <= 50000) break;
      delete bucket.accounts[id]; delete bucket.health[id]; stats.recentCoverage.droppedAccountMinuteCells++;
      stats.recentCoverage.accountIncompleteAt[id] = Math.max(stats.recentCoverage.accountIncompleteAt[id] || 0, bucket.minute);
    }
  }
}
function commitStatistics({ ts = Date.now(), globalError = false, usage = null, segments = [], clientDisconnect = false }) {
  const stats = META.statistics; pruneStatistics(ts);
  const minute = Math.floor(ts / 60000);
  let bucket = stats.minuteBuckets.at(-1);
  if (!bucket || bucket.minute !== minute) { bucket = { minute, global: emptyAggregate(), accounts: {}, health: {} }; stats.minuteBuckets.push(bucket); }
  const globalDelta = emptyAggregate(); addCounter(globalDelta, 'requests'); globalDelta.lastUsedAt = ts;
  if (globalError) { addCounter(globalDelta, 'errors'); globalDelta.lastErrorAt = ts; }
  addUsage(globalDelta, usage); mergeAggregate(stats.lifetime.global, globalDelta); mergeAggregate(bucket.global, globalDelta);
  const currentIds = new Set(config.accounts.map((account) => account.id));
  for (const segment of new Map(segments.filter((s) => currentIds.has(s.accountId)).map((s) => [s.accountId,s])).values()) {
    const delta = emptyAggregate(); addCounter(delta, 'requests'); delta.lastUsedAt = ts;
    if (segment.error) { addCounter(delta, 'errors'); delta.lastErrorAt = ts; }
    if (segment.usage) addUsage(delta, segment.usage);
    const lifetime = (stats.lifetime.accounts[segment.accountId] ||= emptyAggregate()); mergeAggregate(lifetime, delta);
    const recent = (bucket.accounts[segment.accountId] ||= emptyAggregate()); mergeAggregate(recent, delta);
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
function record(modelId, info) {
  const ts = Date.now();
  META.models[modelId] = { ...(META.models[modelId] || {}), provider: info.provider, canonical: info.canonical, lastMs: info.ms };
  const { sensitiveValues: _sensitiveValues, ...safeInfo } = info;
  const legacy = {
    ts, model: modelId, ...safeInfo,
    error: safeInfo.error ? safeReason(safeInfo.error, info.sensitiveValues) : safeInfo.error,
    trace: Array.isArray(safeInfo.trace) ? safeInfo.trace.map((attempt) => ({ ...attempt, note: safeReason(attempt.note, info.sensitiveValues) })) : safeInfo.trace,
  };
  recentHistory.unshift(legacy); if (recentHistory.length > 100) recentHistory.length = 100;
  const request = {
    ts, requestId: info.requestId || crypto.randomUUID(), requestedModel: info.requestedModel || modelId,
    resolvedModel: info.resolvedModel || modelId, stream: !!info.stream, strategy: info.strategy || config.accountMode,
    sessionSource: info.sessionSource || null, preferredAccountId: info.preferredAccountId || null,
    preferredAccountName: info.preferredAccountName || null, accountId: info.accountId || null, accountName: info.account || null,
    selectionReason: info.selectionReason || null, overflow: !!info.overflow,
    pipelineSteps: Array.isArray(info.pipeline?.diagnostics) ? info.pipeline.diagnostics.slice(0, 8) : [], selectedQuotaPool: info.pipeline?.selectedQuota || null, selectedHealthLayer: info.pipeline?.selectedHealth || null, capacityFallback: !!info.pipeline?.capacityFallback,
    targetProviders: Array.isArray(info.targets) ? info.targets : [], actualProvider: info.provider || null,
    attempts: Array.isArray(info.trace) ? info.trace.map((t) => ({
      provider: t.upstream || 'auto', status: t.status, upstreamStatus: t.upstreamStatus, ms: t.ms, account: t.account, action: t.action || null,
      errorScope: t.errorScope || null, scopeEvidence: t.scopeEvidence || null, failureClass: t.failureClass || null,
      healthAction: t.healthAction || 'none', retryAfterMs: t.retryAfterMs ?? null,
      responseContentType: t.responseContentType || null, responseBytes: Number.isSafeInteger(t.responseBytes) ? t.responseBytes : null,
    })) : [],
    status: info.normalizedStatus || (info.error ? 502 : 200), upstreamStatus: info.upstreamStatus ?? null,
    durationMs: Number(info.ms) || 0, accountActions: info.accountActions || [], switched: (info.accountPath || []).length > 1, appliedHeaderNames: info.appliedHeaderNames || [],
    errorCategory: info.errorCategory || (info.error ? (info.proxyError ? 'proxy' : 'upstream') : null),
  };
  const writes = [requestLogs.append(request)];
  for (const [attemptIndex, attempt] of (info.trace || []).entries()) {
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
  Promise.all(writes).then(() => enforceCombinedLimit(LOG_DIR, 100 * 1024 * 1024)).catch(() => {});
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
    const req = lib.request({ protocol: u.protocol, hostname: u.hostname, port: u.port, path: `${u.pathname}${u.search}`, method, headers: requestHeaders, ...(agent ? { agent } : {}) }, (res) => {
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
    req.end(method === 'GET' ? undefined : data);
  });
}
function streamToString(stream, maxBytes = Infinity) {
  if (stream.readableEnded || stream.destroyed) return Promise.resolve('');
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0, settled = false;
    stream.on('data', (c) => {
      if (settled) return;
      const chunk = Buffer.from(c); size += chunk.length;
      if (size > maxBytes) { settled = true; const error = new Error('upstream response exceeds limit'); error.code = 'RESPONSE_TOO_LARGE'; stream.destroy(); reject(error); return; }
      chunks.push(chunk);
    });
    stream.on('end', () => { if (!settled) { settled = true; resolve(Buffer.concat(chunks).toString('utf8')); } });
    stream.on('error', (error) => { if (!settled) { settled = true; reject(error); } });
    stream.resume();
  });
}
const quotaGenerations = new Map(), quotaInflight = new Set(), quotaFailureCounts = new Map();
let quotaTimer = null, quotaCursor = 0;
const QUOTA_TIMEOUT_MS = process.env.NODE_ENV === 'test' ? Math.max(20, Number(process.env.CLINE_PASS_TEST_QUOTA_TIMEOUT_MS) || 15000) : 15000;
const QUOTA_SUCCESS_MS = process.env.NODE_ENV === 'test' ? Math.max(50, Number(process.env.CLINE_PASS_TEST_QUOTA_SUCCESS_MS) || 300000) : 300000;
const QUOTA_FAILURE_MS = process.env.NODE_ENV === 'test' ? Math.max(50, Number(process.env.CLINE_PASS_TEST_QUOTA_FAILURE_MS) || 60000) : 60000;
function quotaFailureCategory(error, status, account) {
  if (status === 401 || status === 403) return 'auth'; if (status === 429) return 'rate_limit'; if (status >= 500) return 'server'; if (status) return 'http';
  if (error?.code === 'RESPONSE_TOO_LARGE') return 'schema';
  if (/timeout/i.test(error?.message || '')) return 'timeout'; return account.proxyUrl ? 'proxy' : 'network';
}
async function refreshQuota(account) {
  if (!config.accountPipeline.quotaPool || quotaInflight.has(account.id)) return;
  quotaInflight.add(account.id);
  const generation = quotaGenerations.get(account.id) || 0, key = account.key, proxyUrl = account.proxyUrl || '', attemptedAt = Date.now();
  let snapshot = null, errorCategory = null;
  try {
    const result = await clineRequestJSON(`${config.upstreamBase.replace(/\/$/,'')}/users/me/plan/usage-limits`, { method: 'GET', headers: { Accept: 'application/json', Authorization: `Bearer ${key}` }, timeoutMs: QUOTA_TIMEOUT_MS, account, proxyUrl, maxResponseBytes: 256 * 1024 });
    if (result.status < 200 || result.status >= 300) errorCategory = quotaFailureCategory(null, result.status, account);
    else {
      let json;
      try { json = JSON.parse(result.text); } catch { errorCategory = 'json'; }
      if (!errorCategory) try { snapshot = parseQuotaPayload(json, Date.now()); } catch { errorCategory = 'schema'; }
    }
  } catch (error) { errorCategory = quotaFailureCategory(error, 0, account); }
  finally {
    quotaInflight.delete(account.id);
    const current = config.accounts.find((item) => item.id === account.id);
    const currentGeneration = quotaGenerations.get(account.id) || 0;
    if (!config.accountPipeline.quotaPool || !current || current.key !== key || (current.proxyUrl || '') !== proxyUrl || currentGeneration !== generation) return;
    const state = (META.accountQuotas[account.id] ||= { snapshot: null, lastAttemptAt: 0, lastSuccessAt: 0, errorCategory: null });
    state.lastAttemptAt = attemptedAt;
    if (snapshot) { state.snapshot = snapshot; state.lastSuccessAt = snapshot.fetchedAt; state.errorCategory = null; quotaFailureCounts.delete(account.id); }
    else { state.errorCategory = errorCategory || 'schema'; quotaFailureCounts.set(account.id, Math.min(4, (quotaFailureCounts.get(account.id) || 0) + 1)); }
    try { saveMeta(); } catch (error) { console.error(`[额度] 持久化失败：${safeReason(error.message)}`); }
  }
}
function scheduleQuotaRefresh() {
  clearTimeout(quotaTimer); quotaTimer = null;
  if (!config.accountPipeline.quotaPool) return;
  const run = async () => {
    const accounts = hrwRank(config.accounts.filter((account) => account.enabled !== false && account.key), 'quota-refresh');
    const dueAccounts = accounts.filter((account) => { const q = META.accountQuotas[account.id]; const interval = q?.errorCategory ? Math.min(15 * QUOTA_FAILURE_MS, QUOTA_FAILURE_MS * (2 ** (quotaFailureCounts.get(account.id) || 0))) : QUOTA_SUCCESS_MS; return !q?.lastAttemptAt || Date.now() - q.lastAttemptAt >= interval; });
    const start = quotaCursor % Math.max(1, dueAccounts.length), due = [...dueAccounts.slice(start), ...dueAccounts.slice(0, start)].slice(0, 2);
    quotaCursor++; await Promise.all(due.map(refreshQuota)); scheduleQuotaRefresh();
  };
  quotaTimer = setTimeout(run, process.env.NODE_ENV === 'test' ? 10 : 1000 + (quotaCursor % 30) * 1000); quotaTimer.unref();
}
function createSseObserver(maxBytes = 64 * 1024) {
  let pending = Buffer.alloc(0), discardTail = Buffer.alloc(0), discarding = false, usage = null, provider = null, canonical = null, error = null, errorPayload = null, normalizedStatus = null, responseBytes = 0;
  const observeEvent = (buffer) => {
    const payload = buffer.toString('utf8').split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.replace(/^data:\s?/, '')).join('\n');
    if (!payload || payload === '[DONE]') return;
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
    result() { return { usage, provider, canonical, error, errorPayload, normalizedStatus, responseBytes }; },
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
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const cleanup = () => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
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
      size += chunk.length;
      if (size > MAX_REQUEST_BODY_BYTES) return rejectTooLarge();
      chunks.push(chunk);
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks));
    };
    const onError = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    const declaredLength = Number(req.headers['content-length']);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BODY_BYTES) rejectTooLarge();
  });
}
async function readJsonBody(req) {
  try { return JSON.parse((await readBody(req)).toString('utf8')); }
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
  if (origin === 'proxy') return { scope: 'provider', evidence: 'transport_proxy', failureClass: 'network', retryAfterMs: null };
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
function accountActionFor(result, classification) {
  const status = String(result?.normalizedStatus || result?.status || '');
  if (status === '429' && classification?.scope !== 'account') return null;
  const rule = config.accountErrorRules?.[status];
  return rule ? { statusCode: Number(status), ...rule } : null;
}
function persistAccountAction(account, action, reason, extraSecrets = []) {
  if (!account?.id || !action || action.action === 'ignore') return;
  const now = Date.now();
  const state = { banned: false, cooldownUntil: 0, statusCode: action.statusCode, reason: safeReason(reason, extraSecrets), updatedAt: now };
  if (action.action === 'cooldown') state.cooldownUntil = now + Math.max(1, Number(action.cooldownMs) || 1);
  if (action.action === 'ban') state.banned = true;
  META.accountStates ||= {};
  META.accountStates[account.id] = state;
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
function settleAttempt(modelId, attempt, result, account, { clientDisconnected = false, updateSuccess = true } = {}) {
  if (clientDisconnected) return { classification: null, accountAction: null, healthAction: 'none' };
  if (result.status === 200) return { classification: null, accountAction: null, healthAction: updateSuccess ? updateProviderHealth(modelId, attempt.upstream, { success: true }) : 'none' };
  const classification = classifyAttemptFailure(result, attempt, account);
  const accountAction = accountActionFor(result, classification);
  const healthAction = updateProviderHealth(modelId, attempt.upstream, { classification, note: `${classification.evidence}:${classification.failureClass}` });
  return { classification, accountAction, healthAction };
}
function traceAttempt(attempt, result, account, ms, diagnostic) {
  return {
    upstream: attempt.upstream, status: result.status, upstreamStatus: result.upstreamStatus, normalizedStatus: result.normalizedStatus,
    terminalOrigin: result.terminalOrigin, ms, note: result.note, account: account.name, accountId: account.id,
    action: diagnostic.accountAction?.action || null, errorScope: diagnostic.classification?.scope || null,
    scopeEvidence: diagnostic.classification?.evidence || null, failureClass: diagnostic.classification?.failureClass || null,
    healthAction: diagnostic.healthAction || 'none', retryAfterMs: diagnostic.classification?.retryAfterMs ?? null,
    responseContentType: result.responseContentType || null, responseBytes: Number.isSafeInteger(result.responseBytes) ? result.responseBytes : null,
  };
}

// 两级重试：本函数固定一个账号，仅在该账号内按健康计划逐个尝试 provider。
// 只有 account-scoped 错误命中 cooldown/ban 时，外层 handleChat 才能终止本链并最多换号一次。
async function runChatChain(req, body, modelId, cfg, account, forwardedHeaders, { stream = false, attemptTimeoutMs = 120000 } = {}) {
  const plan = buildProviderAttempts(modelId, cfg);
  const attempts = plan.attempts;
  const trace = [];
  const t0 = Date.now();
  if (!attempts.length) {
    return { status: 503, upstreamStatus: null, normalizedStatus: 503, out: { error: { message: 'no provider available after exclusions', type: 'upstream_error' } }, routing: {}, acc: account, trace, t0, plan, netError: null, accountAction: null, clientDisconnected: false };
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
            const diagnostic = settleAttempt(modelId, attempt, result, account, { clientDisconnected: clientClosed });
            trace.push(traceAttempt(attempt, result, account, ms, diagnostic));
            if (!attempt.upstream) learnAvailableProviders(modelId, result.note);
            last = { ...result, accountAction: diagnostic.accountAction, classification: diagnostic.classification };
            if (last.accountAction?.action === 'cooldown' || last.accountAction?.action === 'ban') break;
            continue;
          }
          if (!up) {
            const origin = timedOut || /timeout/i.test(netError || '') ? 'timeout' : account.proxyUrl ? 'proxy' : 'network';
            const result = { status: 502, upstreamStatus: 0, normalizedStatus: 502, out: { error: { message: `upstream fetch failed: ${netError || 'no response'}`, type: 'upstream_error' } }, routing: {}, structuredError: null, retryAfter: null, responseContentType: null, responseBytes: 0, netError: netError || 'no response', terminalOrigin: origin, acc: account, note: netError || 'no response' };
            const diagnostic = settleAttempt(modelId, attempt, result, account, { clientDisconnected: clientClosed });
            trace.push(traceAttempt(attempt, result, account, ms, diagnostic));
            last = { ...result, accountAction: diagnostic.accountAction, classification: diagnostic.classification };
            if (last.accountAction?.action === 'cooldown' || last.accountAction?.action === 'ban') break;
            continue;
          }
          keepCloseHook = true;
          const result = { status: 200, upstreamStatus: 200, normalizedStatus: 200, terminalOrigin: 'success', responseContentType, responseBytes: safeResponseBytes(firstChunk), note: 'stream' };
          const diagnostic = settleAttempt(modelId, attempt, result, account, { updateSuccess: false });
          trace.push(traceAttempt(attempt, result, account, ms, diagnostic));
          return { status: 200, streamUp: up, streamHead: firstChunk, acc: account, trace, t0, plan, started: true, cleanupClientClose };
        }
        const result = await attemptOnce(modelId, body, attempt, account, forwardedHeaders, ctrl.signal);
        if (timedOut && result.status !== 200) { result.terminalOrigin = 'timeout'; result.netError = 'upstream timeout'; result.out = { error: { message: 'upstream fetch failed: upstream timeout', type: 'upstream_error' } }; }
        const ms = Date.now() - t1;
        result.note = result.netError || (result.status !== 200 ? errText(result.out?.error?.message) : 'ok');
        const diagnostic = settleAttempt(modelId, attempt, result, account, { clientDisconnected: clientClosed });
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
  if (!last) last = { status: 502, upstreamStatus: 0, normalizedStatus: 502, out: { error: { message: 'upstream request aborted', type: 'upstream_error' } }, routing: {}, acc: account, netError: 'upstream request aborted', accountAction: null };
  return { ...last, trace, t0, plan, netError: last.netError || null, clientDisconnected: clientClosed };
}

function statisticsSegments(trace, finalAccountId, usage, clientDisconnect = false) {
  const grouped = new Map();
  for (const attempt of trace || []) { const list = grouped.get(attempt.accountId) || []; list.push(attempt); grouped.set(attempt.accountId, list); }
  return [...grouped.entries()].map(([accountId, attempts]) => { const success = !clientDisconnect && attempts.at(-1)?.status === 200; return { accountId, trace: attempts, success, error: !clientDisconnect && !success, usage: success && accountId === finalAccountId ? usage : null }; });
}
async function handleChat(req, res) {
  const requestId = crypto.randomUUID();
  res.setHeader('X-Cline-Request-Id', requestId);
  const raw = await readBody(req);
  let body;
  try { body = JSON.parse(raw.toString('utf8')); } catch { return sendJSON(res, 400, { error: { message: 'invalid JSON body' } }); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return sendJSON(res, 400, { error: { message: 'JSON body must be an object' } });
  const requestedModel = typeof body.model === 'string' ? body.model.trim() : '';
  if (!requestedModel || requestedModel.length > 300) return sendJSON(res, 400, { error: { message: 'valid model is required' } });
  const sensitiveValues = sensitiveMessageValues(body);
  let statisticsFinalized = false;
  const finalizeStatistics = (facts) => { if (statisticsFinalized) return; statisticsFinalized = true; try { commitStatistics(facts); } catch (error) { console.error(`[统计] 持久化失败：${safeReason(error.message)}`); } };
  const modelId = resolveModelAlias(requestedModel);
  body = { ...body, model: modelId };
  const identity = extractSessionIdentity(req, body);
  const forwardedHeaders = forwardHeadersFor(req, body);
  const isStream = body.stream === true;
  const excluded = new Set();
  const accountPath = [];
  let selected = await acquireAccountLease(identity, { excludeIds: excluded });
  if (!selected.lease) {
    const status = enabledAccounts().length ? 429 : 503;
    finalizeStatistics({ globalError: true, segments: [] });
    record(modelId, { requestId, requestedModel, resolvedModel: modelId, stream: isStream, strategy: selected.strategy, sessionSource: identity.source, selectionReason: 'capacity-unavailable', normalizedStatus: status, upstreamStatus: null, errorCategory: 'capacity', error: selected.error, ms: 0 });
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
      chain = await runChatChain(req, body, modelId, cfg, account, forwardedHeaders, { stream: isStream });
      targets = chain.plan?.plannedOrder || [];
      targetSource = chain.plan?.source || 'auto';
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
    const finalize = (error = null, origin = null) => {
      if (finalized) return;
      finalized = true;
      chain.cleanupClientClose?.();
      lease.release();
      const observed = observer.result();
      const streamError = observed.error || (error ? safeReason(error) : null);
      const providerAttempt = chain.trace.at(-1);
      const attempt = { upstream: providerAttempt?.upstream || null };
      const disconnected = origin === 'client_disconnect';
      if (observed.error && providerAttempt) {
        const result = { status: observed.normalizedStatus, upstreamStatus: 200, normalizedStatus: observed.normalizedStatus, routing: { finalProvider: observed.provider }, structuredError: observed.errorPayload, retryAfter: null, responseContentType: 'text/event-stream', responseBytes: observed.responseBytes, terminalOrigin: 'upstream_envelope', note: safeReason(observed.error, sensitiveValues) };
        const diagnostic = settleAttempt(modelId, attempt, result, acc);
        Object.assign(providerAttempt, traceAttempt(attempt, result, acc, providerAttempt.ms, diagnostic));
        const action = diagnostic.accountAction;
        if (action) { if (action.action !== 'ignore') persistAccountAction(acc, action, streamError, sensitiveValues); accountActions.push({ account: acc.name, action: action.action, statusCode: action.statusCode }); }
      } else if (error && !disconnected && providerAttempt) {
        const result = { status: 502, upstreamStatus: 0, normalizedStatus: 502, routing: {}, structuredError: null, retryAfter: null, responseContentType: 'text/event-stream', responseBytes: observed.responseBytes, terminalOrigin: /timeout/i.test(String(error)) ? 'timeout' : acc.proxyUrl ? 'proxy' : 'network', note: 'stream transport error' };
        const diagnostic = settleAttempt(modelId, attempt, result, acc);
        Object.assign(providerAttempt, traceAttempt(attempt, result, acc, providerAttempt.ms, diagnostic));
        const action = diagnostic.accountAction;
        if (action) { if (action.action !== 'ignore') persistAccountAction(acc, action, error, sensitiveValues); accountActions.push({ account: acc.name, action: action.action, statusCode: action.statusCode }); }
      } else if (!disconnected && providerAttempt) {
        providerAttempt.healthAction = updateProviderHealth(modelId, providerAttempt.upstream, { success: true });
        providerAttempt.responseBytes = observed.responseBytes;
      } else if (providerAttempt) {
        providerAttempt.healthAction = 'none';
        providerAttempt.responseBytes = observed.responseBytes;
      }
      finalizeStatistics({ globalError: !!streamError && !disconnected, usage: streamError || disconnected ? null : observed.usage, clientDisconnect: disconnected, segments: statisticsSegments(chain.trace, acc.id, streamError || disconnected ? null : observed.usage, disconnected) });
      record(modelId, { requestId, requestedModel, resolvedModel: modelId, provider: observed.provider, canonical: observed.canonical, ms: Date.now() - chain.t0, stream: true, error: streamError, upstreamStatus: providerAttempt?.upstreamStatus ?? null, normalizedStatus: providerAttempt?.normalizedStatus ?? (streamError ? 502 : 200), account: acc.name, accountId: acc.id, attempts: chain.trace.map((t) => t.upstream || 'auto'), trace: chain.trace, accountPath, accountActions, sessionSource: identity.source, strategy: initialSelection.strategy, preferredAccountId: initialSelection.preferredAccountId, preferredAccountName: initialSelection.preferredAccountName, selectionReason: selected.reason, overflow: initialSelection.overflow, pipeline: selected.pipeline || initialSelection.pipeline, targets, appliedHeaderNames: Object.keys(acc.headers || {}), proxyError: !!acc.proxyUrl && chain.trace.some((t) => t.upstreamStatus === 0), sensitiveValues });
    };
    const tap = new Transform({ transform(c, enc, cb) { observer.push(c); cb(null, c); }, flush(cb) { finalize(); cb(); } });
    up.body.on('error', (e) => { finalize(e.message, 'upstream'); if (!res.destroyed) res.destroy(e); });
    res.on('close', () => { if (!res.writableEnded) up.body.destroy(); finalize('client disconnected', 'client_disconnect'); });
    up.body.pipe(tap).pipe(res);
    return;
  }

  lease?.release();
  const { status, out, routing = {}, acc } = chain;
  if (!out) { finalizeStatistics({ globalError: true, segments: statisticsSegments(chain.trace, null, null) }); return sendJSON(res, 502, { error: { message: 'no upstream response', type: 'upstream_error' } }); }
  if (status === 200 && /^cline-pass\//.test(modelId) && !config.knownModels.includes(modelId)) { config.knownModels.push(modelId); saveConfig(); }
  const safeOut = status === 200 ? out : { ...out, error: { ...(out.error || {}), message: safeReason(out?.error?.message || 'upstream error', sensitiveValues) } };
  const disconnected = chain.clientDisconnected === true;
  const usage = status === 200 && !disconnected ? normalizeUsage(routing.usage) : null;
  finalizeStatistics({ globalError: status !== 200 && !disconnected, usage, clientDisconnect: disconnected, segments: statisticsSegments(chain.trace, acc?.id, usage, disconnected) });
  record(modelId, {
    requestId, requestedModel, resolvedModel: modelId, provider: routing.finalProvider || null, canonical: routing.canonicalSlug || null, ms: Date.now() - chain.t0, stream: false,
    attempts: chain.trace.map((t) => t.upstream || 'auto'), trace: chain.trace, error: status !== 200 ? safeOut.error.message : null,
    account: acc?.name || null, accountId: acc?.id || null, accountPath, accountActions, accountAction: chain.accountAction?.action || accountActions.at(-1)?.action || null, upstreamStatus: chain.upstreamStatus, normalizedStatus: chain.normalizedStatus, sessionSource: identity.source,
    strategy: initialSelection.strategy, preferredAccountId: initialSelection.preferredAccountId, preferredAccountName: initialSelection.preferredAccountName, selectionReason: selected.reason, overflow: initialSelection.overflow, pipeline: selected.pipeline || initialSelection.pipeline, targets, appliedHeaderNames: Object.keys(acc?.headers || {}), proxyError: !!acc?.proxyUrl && chain.trace.some((t) => t.upstreamStatus === 0), errorCategory: chain.plan?.allExcluded ? 'routing' : null, sensitiveValues,
  });
  res.writeHead(status, {
    'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*',
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
        return { id, config: own ? account.perModel[id] : (config.perModel[id] || {}), configSource: account ? (own ? 'account' : 'inherited') : 'global', meta: projectModelMeta(META.models[id]) };
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
      const { model: requestedModel, upstream, upstreams, exclude, accountId } = input;
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
    if ((req.method === 'GET' || req.method === 'DELETE') && (p === '/api/logs/requests' || p === '/api/logs/errors')) {
      const store = p.endsWith('/errors') ? errorLogs : requestLogs;
      if (req.method === 'DELETE') { await store.clear(); return sendJSON(res, 200, { ok: true }); }
      const allowed = p.endsWith('/errors')
        ? ['from','to','requestId','model','requestedModel','resolvedModel','account','accountId','accountName','status','upstreamStatus','category','provider','targetProvider','accountAction','errorScope','scopeEvidence','failureClass','healthAction','responseContentType']
        : ['from','to','requestId','model','requestedModel','resolvedModel','account','accountId','accountName','strategy','status','upstreamStatus','stream','provider','actualProvider','targetProviders','overflow','switched','accountAction','errorCategory'];
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
      return sendJSON(res, 200, store.query({ limit: Number(rawLimit), cursor, filters }));
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
        const result = await clineRequestJSON(`${config.upstreamBase}/chat/completions`, { headers: responseHeadersFor(account, {}), body: JSON.stringify({ model, messages: [], max_tokens: 1 }), proxyUrl, timeoutMs: 15000 });
        return sendJSON(res, 200, { ok: result.status > 0, proxyType: new URL(proxyUrl).protocol.replace(':', ''), ms: Date.now() - t0, status: result.status });
      } catch (e) {
        let reason = String(e.message || 'proxy error');
        try { const u = new URL(proxyUrl); for (const secret of [proxyUrl, decodeURIComponent(u.username), decodeURIComponent(u.password)].filter(Boolean)) reason = reason.split(secret).join('[REDACTED]'); } catch {}
        return sendJSON(res, 200, { ok: false, proxyType: new URL(proxyUrl).protocol.replace(':', ''), ms: Date.now() - t0, errorCategory: 'proxy', reason: safeReason(reason) });
      }
    }
    if (req.method === 'GET' && p === '/api/statistics') {
      pruneStatistics();
      const recentGlobal = aggregateRange().aggregate;
      const accounts = config.accounts.map((account) => { const recent = aggregateRange(account.id).aggregate; return { id: account.id, name: account.name, enabled: account.enabled !== false, lifetime: projectAggregate(META.statistics.lifetime.accounts[account.id] || emptyAggregate()), recent24h: projectAggregate(recent), health: healthProjection(account), quota: quotaProjection(account.id) }; });
      return sendJSON(res, 200, { generatedAt: Date.now(), window: { kind: 'last-1440-minutes', from: (Math.floor(Date.now()/60000)-1439)*60000, to: Date.now() }, lifetime: { global: projectAggregate(META.statistics.lifetime.global) }, recent24h: { global: projectAggregate(recentGlobal) }, accounts, migration: META.statistics.migration });
    }
    if (req.method === 'GET' && p === '/api/accounts') {
      clearExpiredCooldowns();
      return sendJSON(res, 200, {
        accounts: config.accounts.map((a) => ({ ...a, state: getAccountState(a.id), activeCount: activeCounts.get(a.id) || 0, health: healthProjection(a), quota: quotaProjection(a.id) })),
        mode: config.accountMode, active: config.activeAccount, concurrencyWaitMs: config.concurrencyWaitMs,
        accountErrorRules: config.accountErrorRules, accountPipeline: config.accountPipeline,
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
      let requestedPipeline = config.accountPipeline;
      try { if (body.accountPipeline !== undefined) requestedPipeline = normalizeAccountPipeline(body.accountPipeline, { strict: true }); }
      catch (e) { return sendJSON(res, 400, { error: { message: e.message } }); }
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
      config.accounts = accs; config.accountMode = body.mode; config.activeAccount = requestedActive >= 0 ? requestedActive : Math.min(Math.max(0, Number(body.active) || 0), accs.length - 1);
      const pipelineWasEnabled = config.accountPipeline.quotaPool;
      config.concurrencyWaitMs = wait; config.accountErrorRules = normalizeAccountErrorRules(body.accountErrorRules || {}); config.accountPipeline = requestedPipeline;
      for (const [id, previous] of previousById) { const current = accs.find((a) => a.id === id); if (!current || current.key !== previous.key || current.proxyUrl !== previous.proxyUrl) { quotaGenerations.set(id, (quotaGenerations.get(id) || 0) + 1); delete META.accountQuotas[id]; } }
      if (pipelineWasEnabled && !config.accountPipeline.quotaPool) for (const id of seen) quotaGenerations.set(id, (quotaGenerations.get(id) || 0) + 1);
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
        ? [...new Set([...config.knownModels, ...(await catalog()), ...Object.keys(config.modelAliases || {})])]
        : [...new Set([...config.knownModels, ...Object.keys(config.perModel), ...Object.keys(config.modelAliases || {})])];
      return sendJSON(res, 200, { object: 'list', data: ids.map((id) => ({ id, object: 'model' })) });
    }
    if (CHAT_PATHS.has(p) && req.method === 'POST') return await handleChat(req, res);
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
  scheduleQuotaRefresh();
});
