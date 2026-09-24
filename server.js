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
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { JsonlLogGroup } from './lib/jsonl-log-store.js';
import { DetailRoot, DetailRedactor, detailContext, detailRoute, observeStream, MAX_BODY_BYTES, MAX_RAW_BODY_BYTES, MAX_PAYLOAD_BYTES, captureBudget } from './lib/detailed-log-capture.js';
import { DetailedLogStore, parseDetailQuery, MAX_AGE_MS, RAW_MAX_AGE_MS, MAX_TOTAL_BYTES } from './lib/detailed-log-store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || __dirname;
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const META_PATH = path.join(DATA_DIR, 'metadata.json');
const ADMIN_PATH = path.join(DATA_DIR, 'admin-auth.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const LOG_DIR = path.join(DATA_DIR, 'logs');

const DEFAULT_CONFIG = {
  port: 3123,
  apiKey: '',
  proxyKey: '',
  publicBaseUrl: '',
  detailedLogging: false,
  errorDetailLogging: false,
  rawBodyLogging: false,
  exposeCatalog: false,    // true 时 /v1/models 合并完整目录模型（默认仅订阅模型）
  upstreamBase: 'https://api.cline.bot/api/v1',
  accounts: [],            // { id, name, key, enabled, maxConcurrent, maxRpm, perModel } —— Cline Pass 账号池（maxRpm：0=不限）
  accountMode: 'single',   // single=手动指定 | roundrobin=轮询 | sticky=会话 HRW 粘性
  activeAccount: 0,        // single 模式下使用的账号下标
  concurrencyWaitMs: 2000,
  errorRules: [],          // canonical ordered account/provider-model failure rules
  retryRules: [],          // canonical ordered request-level retry-stop rules
  quotaProtection: { monthlyThresholdUsd: 0.20 }, // community-reference $50 monthly cap
  accountErrorRules: {},   // legacy compatibility projection only
  accountContentErrorRules: [], // legacy compatibility projection only
  accountPipeline: {
    quotaPool: false,
    healthSort: false,
    sticky: false,
    order: ['quotaPool', 'healthSort', 'sticky'],
    cachePoolSize: 0,
    cachePoolMaxSize: 0,
    cachePoolLowQuotaSize: 0,
    sessionBindingExplicitTtlMs: 7_200_000,
    sessionBindingFallbackTtlMs: 900_000,
    sessionBindingMaxEntries: 50_000,
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
const MISSING_ADMIN = Symbol('missing admin state');
function validAdminState(state) {
  return state !== null && typeof state === 'object' && !Array.isArray(state) && Object.getPrototypeOf(state) === Object.prototype &&
    Object.keys(state).sort().join(',') === 'hash,initialized,salt,version' &&
    state.version === 1 && typeof state.initialized === 'boolean' &&
    typeof state.salt === 'string' && /^[a-f0-9]{64}$/.test(state.salt) &&
    typeof state.hash === 'string' && /^[a-f0-9]{128}$/.test(state.hash);
}
let loadedAdminState = MISSING_ADMIN;
try {
  const stat = fs.lstatSync(ADMIN_PATH);
  if (!stat.isFile() || (stat.mode & 0o077)) throw new Error('admin-auth.json must be a private regular file (0600)');
  try { loadedAdminState = JSON.parse(fs.readFileSync(ADMIN_PATH, 'utf8')); }
  catch { throw new Error('invalid or unreadable admin-auth.json'); }
  if (!validAdminState(loadedAdminState)) throw new Error('invalid admin-auth.json');
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}
const loadedConfig = loadJson(CONFIG_PATH, {});
const configHadCanonicalErrorRules = Object.hasOwn(loadedConfig, 'errorRules');
const configHadCanonicalRetryRules = Object.hasOwn(loadedConfig, 'retryRules');
const config = { ...DEFAULT_CONFIG, ...loadedConfig };
const META = loadJson(META_PATH, { models: {}, history: [], catalog: null, orModelsFetchedAt: 0, orModelList: null });
const saveConfig = () => atomicWriteJson(CONFIG_PATH, config);
const saveMeta = () => {
  atomicWriteJson(META_PATH, META);
  // A successful write of the current META also commits any confirmed monthly bans.
  for (const [id, pending] of quotaProvisional) if (pending.persistRetryAt !== undefined) quotaProvisional.delete(id);
};
const ordinaryLogs = new JsonlLogGroup({
  dir: LOG_DIR,
  streams: { requests: { maxRecords: 50000 }, errors: { maxRecords: 10000 } },
  maxTotalBytes: 100 * 1024 * 1024,
});
const requestLogs = ordinaryLogs.stream('requests');
const errorLogs = ordinaryLogs.stream('errors');
const detailedLogs = new DetailedLogStore({ dir: path.join(DATA_DIR, 'detailed-logs') });
const recentHistory = Array.isArray(META.history) ? [...META.history] : [];
const quotaProvisional = new Map(); // bounded, process-local verification holds; the quota job remains the only fetch owner
let shuttingDown = false;

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
    hardQuarantined: raw.hardQuarantined === true,
    ruleId: typeof raw.ruleId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(raw.ruleId) ? raw.ruleId : null,
    statusCode: Number.isInteger(raw.statusCode) && raw.statusCode >= 100 && raw.statusCode <= 599 ? raw.statusCode : null,
    updatedAt: safeProviderTimestamp(raw.updatedAt),
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
function normalizeQuotaProtection(value, { strict = false } = {}) {
  if (value === undefined && !strict) return { monthlyThresholdUsd: 0.20 };
  const amount = value?.monthlyThresholdUsd;
  const cents = amount * 100;
  if (!isPlainObject(value) || Object.keys(value).length !== 1 || !Number.isFinite(amount) ||
      Math.abs(cents - Math.round(cents)) > 2 * Number.EPSILON * Math.max(1, Math.abs(cents)) || amount < 0.01 || amount > 50) {
    throw new Error('quotaProtection.monthlyThresholdUsd must be a two-decimal number from 0.01 to 50.00');
  }
  return { monthlyThresholdUsd: Math.round(cents) / 100 };
}
function normalizeAccountStates() {
  let dirty = false;
  if (!isPlainObject(META.accountStates)) { META.accountStates = {}; return true; }
  const normalized = {};
  for (const [id, value] of Object.entries(META.accountStates)) {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(id) || !isPlainObject(value)) { dirty = true; continue; }
    if (Object.keys(value).some((key) => key.startsWith('quota') && !['quotaDisposition','quotaDispositionAt','quotaRetryAt','quotaReason'].includes(key)) ||
        Object.keys(value).some((key) => key.startsWith('protection') && !['protectionMonthlyAt','protectionShortAt','protectionShortWindows','protectionRetryAt'].includes(key)) ||
        (value.protectionMonthlyAt !== undefined && (!Number.isSafeInteger(value.protectionMonthlyAt) || value.protectionMonthlyAt < 0)) ||
        (value.protectionShortAt !== undefined && (!Number.isSafeInteger(value.protectionShortAt) || value.protectionShortAt < 0)) ||
        (value.protectionRetryAt !== undefined && (!Number.isSafeInteger(value.protectionRetryAt) || value.protectionRetryAt < 0)) ||
        (value.protectionShortWindows != null && (!Array.isArray(value.protectionShortWindows) || !value.protectionShortWindows.length || value.protectionShortWindows.length > 2 || new Set(value.protectionShortWindows).size !== value.protectionShortWindows.length || value.protectionShortWindows.some((type) => !['five_hour','weekly'].includes(type)))) ||
        (!!value.protectionShortAt !== !!value.protectionShortWindows) ||
        (!value.protectionShortAt && (value.protectionRetryAt ?? 0) !== 0) ||
        (value.quotaDisposition !== undefined && ![null,'waiting-refresh','quota-exhausted'].includes(value.quotaDisposition)) ||
        (value.quotaReason !== undefined && ![null,'account-degrade','known-exhausted'].includes(value.quotaReason)) ||
        ['quotaDispositionAt','quotaRetryAt'].some((key) => value[key] !== undefined && (!Number.isSafeInteger(value[key]) || value[key] < 0)) ||
        (value.quotaDisposition
          ? !Number.isSafeInteger(value.quotaDispositionAt) || value.quotaDispositionAt <= 0 || !Number.isSafeInteger(value.quotaRetryAt) ||
            (value.quotaDisposition === 'waiting-refresh' && value.quotaRetryAt !== 0) ||
            value.quotaReason !== (value.quotaDisposition === 'waiting-refresh' ? 'account-degrade' : 'known-exhausted')
          : (value.quotaDispositionAt ?? 0) !== 0 || (value.quotaRetryAt ?? 0) !== 0 || (value.quotaReason ?? null) !== null)) throw new Error('invalid account quota disposition');
    const state = {
      banned: value.banned === true || value.hardQuarantined === true,
      hardQuarantined: value.banned === true || value.hardQuarantined === true,
      cooldownUntil: safeProviderTimestamp(value.cooldownUntil),
      statusCode: Number.isInteger(value.statusCode) && value.statusCode >= 100 && value.statusCode <= 599 ? value.statusCode : null,
      reason: boundedProviderNote(value.reason),
      ruleId: typeof value.ruleId === 'string' && ERROR_RULE_ID.test(value.ruleId) ? value.ruleId : null,
      updatedAt: safeProviderTimestamp(value.updatedAt),
      quotaDisposition: ['waiting-refresh','quota-exhausted'].includes(value.quotaDisposition) ? value.quotaDisposition : null,
      quotaDispositionAt: safeProviderTimestamp(value.quotaDispositionAt),
      quotaRetryAt: safeProviderTimestamp(value.quotaRetryAt),
      quotaReason: ['account-degrade','known-exhausted'].includes(value.quotaReason) ? value.quotaReason : null,
      protectionMonthlyAt: value.protectionMonthlyAt || 0,
      protectionShortAt: value.protectionShortAt || 0,
      protectionShortWindows: value.protectionShortWindows || null,
      protectionRetryAt: value.protectionRetryAt || 0,
    };
    normalized[id] = state;
    if (JSON.stringify(state) !== JSON.stringify(value)) dirty = true;
  }
  if (JSON.stringify(normalized) !== JSON.stringify(META.accountStates)) { META.accountStates = normalized; dirty = true; }
  return dirty;
}
function configuredProvidersForModel(modelId) {
  const providers = new Set(normalizeStringList(META.models?.[modelId]?.upstreams, 100).map((value) => value.toLowerCase()));
  for (const route of [config.perModel?.[modelId], ...(config.accounts || []).map((account) => account.perModel?.[modelId])]) for (const provider of normalizeStringList(route?.upstreams, 20)) providers.add(provider.toLowerCase());
  return providers;
}
function pruneOrphanProviderStates() {
  let dirty = false;
  for (const [modelId, meta] of Object.entries(META.models || {})) {
    if (!isPlainObject(meta?.upstreamStatus)) continue;
    const configured = configuredProvidersForModel(modelId);
    for (const provider of Object.keys(meta.upstreamStatus)) if (!configured.has(provider.toLowerCase())) { delete meta.upstreamStatus[provider]; dirty = true; }
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
const ERROR_RULE_SCOPES = new Set(['account', 'provider-model']);
const ERROR_RULE_ACTIONS = new Set(['ignore', 'degrade', 'cooldown', 'hard-quarantine']);
const ERROR_RULE_RESET_FORMATS = new Set(['retry-after', 'unix-seconds', 'unix-milliseconds', 'duration']);
const MAX_ERROR_RULES = 100;
const MAX_ERROR_RULE_BYTES = 64 * 1024;
const MAX_ERROR_RULE_ITEMS = 500;
const MAX_RETRY_RULES = 100;
const MAX_RETRY_RULE_BYTES = 64 * 1024;
const MAX_RETRY_RULE_ITEMS = 20;
const RETRY_RULE_DECISIONS = new Set(['stop']);
const RETRY_MATCH_KINDS = new Set(['status', 'body']);
// 有界策略证据投影：只描述计划来源/模式与本次选择依据，不包含候选清单或成功率数值。
const PROVIDER_PLAN_SOURCES = new Set(['configured', 'discovered', 'auto']);
const PROVIDER_MODES = new Set(['strict', 'preferred']);
const PROVIDER_SELECTIONS = new Set(['strict-first', 'health', 'compat-auto']);
const MAX_ERROR_RULE_DURATION_MS = 30 * 24 * 60 * 60 * 1000;
const ERROR_RULE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
function parseStrictDuration(value) {
  if (typeof value !== 'string' || !value || value.length > 64 || !/^(?:\d+d)?(?:\d+h)?(?:\d+m)?(?:\d+s)?$/.test(value)) return null;
  const matches = [...value.matchAll(/(\d+)([dhms])/g)];
  if (!matches.length || matches.map((match) => match[0]).join('') !== value) return null;
  const units = { d: 86400000, h: 3600000, m: 60000, s: 1000 };
  let total = 0;
  for (const [, amount, unit] of matches) {
    const number = Number(amount);
    if (!Number.isSafeInteger(number) || number < 0 || number > Math.floor(MAX_ERROR_RULE_DURATION_MS / units[unit])) return null;
    total += number * units[unit];
    if (!Number.isSafeInteger(total) || total > MAX_ERROR_RULE_DURATION_MS) return null;
  }
  return total > 0 ? total : null;
}
function durationText(milliseconds) {
  let seconds = Math.max(1, Math.ceil(Number(milliseconds) / 1000));
  const parts = [];
  for (const [unit, size] of [['d',86400],['h',3600],['m',60],['s',1]]) {
    const amount = Math.floor(seconds / size);
    if (amount || parts.length || unit === 's') parts.push(`${amount}${unit}`);
    seconds %= size;
  }
  return parts.join('');
}
function normalizeRuleStringList(value, label, { strict, max = 20, pattern = /^[a-z0-9][a-z0-9._/-]{0,199}$/i } = {}) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.length || value.length > max) throw new Error(`${label} must be a non-empty array with at most ${max} entries`);
  const out = [], seen = new Set();
  for (const raw of value) {
    const item = typeof raw === 'string' ? raw.trim() : '';
    const key = item.toLowerCase();
    if (!item || !pattern.test(item) || seen.has(key)) throw new Error(`invalid or duplicate ${label} entry`);
    seen.add(key); out.push(item);
  }
  return out;
}
function normalizeErrorRules(value, { strict = false } = {}) {
  const fail = (error) => { if (strict) throw error; console.warn(`[配置] 已禁用非法统一错误规则：${error.message}`); return []; };
  try {
    if (!Array.isArray(value) || value.length > MAX_ERROR_RULES) throw new Error(`errorRules must be an array with at most ${MAX_ERROR_RULES} entries`);
    let bytes; try { bytes = Buffer.byteLength(JSON.stringify(value)); } catch { throw new Error('errorRules must be JSON serializable'); }
    if (bytes > MAX_ERROR_RULE_BYTES) throw new Error('errorRules exceed 64 KiB');
    const ids = new Set(), out = [];
    for (const [index, raw] of value.entries()) {
      if (!isPlainObject(raw)) throw new Error(`invalid errorRules entry ${index}`);
      const allowed = ['id','scope','action','providers','models','when','reset'];
      if (Object.keys(raw).some((key) => !allowed.includes(key))) throw new Error(`unknown errorRules field ${index}`);
      const id = typeof raw.id === 'string' ? raw.id.trim() : '';
      if (!ERROR_RULE_ID.test(id) || ids.has(id)) throw new Error(`invalid or duplicate errorRules id ${index}`);
      ids.add(id);
      const scope = raw.scope === 'credential' ? 'account' : raw.scope;
      if (!ERROR_RULE_SCOPES.has(scope)) throw new Error(`invalid errorRules scope ${index}`);
      if (!ERROR_RULE_ACTIONS.has(raw.action)) throw new Error(`invalid errorRules action ${index}`);
      const providers = normalizeRuleStringList(raw.providers, `errorRules[${index}].providers`, { strict });
      const models = normalizeRuleStringList(raw.models, `errorRules[${index}].models`, { strict, pattern: /^[^\x00-\x1f\x7f]{1,300}$/ });
      if (!isPlainObject(raw.when) || Object.keys(raw.when).some((key) => !['statuses','body_contains','header'].includes(key))) throw new Error(`invalid errorRules when ${index}`);
      const when = {};
      if (raw.when.statuses !== undefined) {
        if (!Array.isArray(raw.when.statuses) || !raw.when.statuses.length || raw.when.statuses.length > MAX_ERROR_RULE_ITEMS || raw.when.statuses.some((status) => !Number.isSafeInteger(status) || status < 100 || status > 599) || new Set(raw.when.statuses).size !== raw.when.statuses.length) throw new Error(`invalid errorRules statuses ${index}`);
        when.statuses = [...raw.when.statuses];
      }
      if (raw.when.body_contains !== undefined) {
        if (raw.when.body_contains === null) throw new Error(`invalid errorRules body_contains ${index}`);
        const list = Array.isArray(raw.when.body_contains) ? raw.when.body_contains : [raw.when.body_contains];
        if (!list.length || list.length > 20) throw new Error(`invalid errorRules body_contains ${index}`);
        const normalized = [], seen = new Set();
        for (const needle of list) {
          const text = typeof needle === 'string' ? needle.trim() : '';
          const key = text.toLowerCase();
          if (!text || text.length > 500 || /[\x00-\x1f\x7f]/.test(text) || seen.has(key)) throw new Error(`invalid errorRules body_contains ${index}`);
          seen.add(key); normalized.push(text);
        }
        when.body_contains = Array.isArray(raw.when.body_contains) ? normalized : normalized[0];
      }
      if (raw.when.header !== undefined) {
        if (!isPlainObject(raw.when.header) || Object.keys(raw.when.header).some((key) => !['name','contains'].includes(key))) throw new Error(`invalid errorRules header ${index}`);
        const name = typeof raw.when.header.name === 'string' ? raw.when.header.name.trim() : '';
        if (!name || name.length > 128 || !HEADER_NAME.test(name)) throw new Error(`invalid errorRules header name ${index}`);
        const header = { name };
        if (raw.when.header.contains !== undefined) {
          const contains = typeof raw.when.header.contains === 'string' ? raw.when.header.contains.trim() : '';
          if (!contains || contains.length > 500 || /[\x00-\x1f\x7f]/.test(contains)) throw new Error(`invalid errorRules header contains ${index}`);
          header.contains = contains;
        }
        when.header = header;
      }
      const activeConditions = (when.statuses?.length ? 1 : 0) + (when.body_contains && (typeof when.body_contains === 'string' || when.body_contains.length) ? 1 : 0) + (when.header ? 1 : 0);
      if (!activeConditions) throw new Error(`errorRules entry ${index} must enable at least one when condition`);
      let reset;
      if (raw.action === 'cooldown') {
        if (!isPlainObject(raw.reset) || Object.keys(raw.reset).some((key) => !['header','format','fallback','max'].includes(key))) throw new Error(`invalid errorRules reset ${index}`);
        const fallbackMs = parseStrictDuration(raw.reset.fallback), maxMs = parseStrictDuration(raw.reset.max);
        if (fallbackMs === null || maxMs === null || fallbackMs > maxMs) throw new Error(`invalid errorRules reset duration ${index}`);
        reset = { fallback: raw.reset.fallback, max: raw.reset.max };
        if (raw.reset.header !== undefined) {
          const header = typeof raw.reset.header === 'string' ? raw.reset.header.trim() : '';
          if (!header || header.length > 128 || !HEADER_NAME.test(header)) throw new Error(`invalid errorRules reset header ${index}`);
          reset.header = header;
          const format = raw.reset.format === undefined ? (header.toLowerCase() === 'retry-after' ? 'retry-after' : null) : raw.reset.format;
          if (!ERROR_RULE_RESET_FORMATS.has(format)) throw new Error(`invalid errorRules reset format ${index}`);
          reset.format = format;
        } else if (raw.reset.format !== undefined) throw new Error(`errorRules reset format requires header ${index}`);
      } else if (raw.reset !== undefined) throw new Error(`errorRules reset is only valid for cooldown ${index}`);
      out.push({ id, scope, action: raw.action, ...(providers ? { providers } : {}), ...(models ? { models } : {}), when, ...(reset ? { reset } : {}) });
    }
    return out;
  } catch (error) { return fail(error); }
}
function normalizeRetryRules(value, { strict = false } = {}) {
  const fail = (error) => { if (strict) throw error; console.warn(`[配置] 已禁用非法重试规则：${error.message}`); return []; };
  try {
    if (!Array.isArray(value) || value.length > MAX_RETRY_RULES) throw new Error(`retryRules must be an array with at most ${MAX_RETRY_RULES} entries`);
    let bytes; try { bytes = Buffer.byteLength(JSON.stringify(value)); } catch { throw new Error('retryRules must be JSON serializable'); }
    if (bytes > MAX_RETRY_RULE_BYTES) throw new Error('retryRules exceed 64 KiB');
    const ids = new Set(), out = [];
    for (const [index, raw] of value.entries()) {
      if (!isPlainObject(raw)) throw new Error(`invalid retryRules entry ${index}`);
      if (Object.keys(raw).some((key) => !['id','decision','when'].includes(key))) throw new Error(`unknown retryRules field ${index}`);
      const id = typeof raw.id === 'string' ? raw.id.trim() : '';
      if (!ERROR_RULE_ID.test(id) || ids.has(id)) throw new Error(`invalid or duplicate retryRules id ${index}`);
      ids.add(id);
      if (!RETRY_RULE_DECISIONS.has(raw.decision)) throw new Error(`invalid retryRules decision ${index}`);
      if (!isPlainObject(raw.when) || Object.keys(raw.when).some((key) => !['statuses','body_contains'].includes(key))) throw new Error(`invalid retryRules when ${index}`);
      if (!Array.isArray(raw.when.statuses) || !raw.when.statuses.length || raw.when.statuses.length > MAX_ERROR_RULE_ITEMS || raw.when.statuses.some((status) => !Number.isSafeInteger(status) || status < 100 || status > 599) || new Set(raw.when.statuses).size !== raw.when.statuses.length) throw new Error(`invalid retryRules statuses ${index}`);
      if (raw.when.body_contains === undefined || raw.when.body_contains === null) throw new Error(`invalid retryRules body_contains ${index}`);
      const list = Array.isArray(raw.when.body_contains) ? raw.when.body_contains : [raw.when.body_contains];
      if (!list.length || list.length > MAX_RETRY_RULE_ITEMS) throw new Error(`invalid retryRules body_contains ${index}`);
      const normalized = [], seen = new Set();
      for (const needle of list) {
        const text = typeof needle === 'string' ? needle.trim() : '';
        const key = text.toLowerCase();
        if (!text || text.length > 500 || /[\x00-\x1f\x7f]/.test(text) || seen.has(key)) throw new Error(`invalid retryRules body_contains ${index}`);
        seen.add(key); normalized.push(text);
      }
      out.push({ id, decision: 'stop', when: { statuses: [...raw.when.statuses], body_contains: Array.isArray(raw.when.body_contains) ? normalized : normalized[0] } });
    }
    return out;
  } catch (error) { return fail(error); }
}
function legacyActionFromRule(rule) {
  if (rule.action === 'ignore') return { action: 'ignore' };
  if (rule.action === 'hard-quarantine') return { action: 'ban' };
  if (rule.action !== 'cooldown' || rule.reset?.header || parseStrictDuration(rule.reset?.fallback) !== parseStrictDuration(rule.reset?.max)) return null;
  return { action: 'cooldown', cooldownMs: parseStrictDuration(rule.reset.fallback) };
}
function legacyRuleProjection(rules = config.errorRules || []) {
  const accountErrorRules = {}, accountContentErrorRules = [];
  for (const rule of rules) {
    if (rule.scope !== 'account' || rule.providers || rule.models || rule.when.header) continue;
    const action = legacyActionFromRule(rule); if (!action) continue;
    const body = rule.when.body_contains;
    const statuses = rule.when.statuses;
    if (!body && Array.isArray(statuses) && statuses.length === 1 && !Object.hasOwn(accountErrorRules, String(statuses[0]))) accountErrorRules[String(statuses[0])] = action;
    else {
      const needles = typeof body === 'string' ? [body] : Array.isArray(body) && body.length === 1 ? body : [];
      if (needles.length !== 1) continue;
      const sorted = statuses ? [...statuses].sort((a,b) => a-b) : null;
      if (sorted && sorted.some((status,index) => index && status !== sorted[index-1] + 1)) continue;
      accountContentErrorRules.push({ contains: needles[0], ...(sorted ? { statusMin: sorted[0], statusMax: sorted.at(-1) } : {}), ...action });
    }
  }
  return { accountErrorRules, accountContentErrorRules };
}
function migrateLegacyErrorRules(statusRules, contentRules) {
  const out = [];
  for (const [index, rule] of normalizeAccountContentErrorRules(contentRules).entries()) {
    const statuses = rule.statusMin === undefined ? undefined : Array.from({ length: rule.statusMax - rule.statusMin + 1 }, (_, offset) => rule.statusMin + offset);
    out.push({ id: `legacy-content-${index + 1}`, scope: 'account', action: rule.action === 'ban' ? 'hard-quarantine' : rule.action, when: { ...(statuses ? { statuses } : {}), body_contains: rule.contains }, ...(rule.action === 'cooldown' ? { reset: { fallback: durationText(rule.cooldownMs), max: durationText(rule.cooldownMs) } } : {}) });
  }
  for (const [status, rule] of Object.entries(normalizeAccountErrorRules(statusRules))) out.push({ id: `legacy-status-${status}`, scope: 'account', action: rule.action === 'ban' ? 'hard-quarantine' : rule.action, when: { statuses: [Number(status)] }, ...(rule.action === 'cooldown' ? { reset: { fallback: durationText(rule.cooldownMs), max: durationText(rule.cooldownMs) } } : {}) });
  return normalizeErrorRules(out, { strict: true });
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
function resolveModelAlias(model) { return Object.hasOwn(config.modelAliases || {}, model) ? config.modelAliases[model] : model; }
// 账号级 RPM：每账号一个进程内精确滚动窗口（默认 60 秒）加未提交预留。
// 重启清空、多副本各自独立；这是软保护，不是跨进程硬上限。
const RPM_WINDOW_MS = process.env.NODE_ENV === 'test'
  ? Math.max(20, Math.min(60_000, Number(process.env.CLINE_PASS_TEST_RPM_WINDOW_MS) || 60_000))
  : 60_000;
const MAX_RPM_LIMIT = 100000;
const rpmWindows = new Map();
const BLOCKED_BY_REASONS = new Set(['concurrency', 'rpm', 'mixed']);
function rpmLimit(account) {
  const value = account?.maxRpm;
  return Number.isInteger(value) && value > 0 && value <= MAX_RPM_LIMIT ? value : 0;
}
// 旧配置/旧客户端兼容：非整数或负数归 0，超上限截断到上限（绝不静默变成不限）。
function normalizeMaxRpm(value) {
  if (value === undefined || value === null) return 0;
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < 0) return 0;
  return Math.min(MAX_RPM_LIMIT, numeric);
}
function rpmWindowState(accountId, { create = false } = {}) {
  let state = rpmWindows.get(accountId);
  if (!state && create) { state = { timestamps: [], head: 0, reservations: 0 }; rpmWindows.set(accountId, state); }
  return state || null;
}
function rpmLiveCount(state) { return state.timestamps.length - state.head + state.reservations; }
function pruneRpmWindow(accountId, state, now = Date.now()) {
  if (!state) return null;
  const cutoff = now - RPM_WINDOW_MS;
  while (state.head < state.timestamps.length && state.timestamps[state.head] <= cutoff) state.head++;
  if (state.head && (state.head === state.timestamps.length || state.head * 2 >= state.timestamps.length)) {
    state.timestamps = state.head === state.timestamps.length ? [] : state.timestamps.slice(state.head);
    state.head = 0;
  }
  if (!state.timestamps.length && !state.reservations && rpmWindows.get(accountId) === state) rpmWindows.delete(accountId);
  return state;
}
function rpmBlockedRetryAt(account, now = Date.now()) {
  const limit = rpmLimit(account);
  if (!limit) return { blocked: false, retryAt: null };
  const state = rpmWindowState(account.id);
  if (!state) return { blocked: false, retryAt: null };
  pruneRpmWindow(account.id, state, now);
  if (rpmLiveCount(state) < limit) return { blocked: false, retryAt: null };
  const oldest = state.timestamps[state.head];
  return { blocked: true, retryAt: Number.isSafeInteger(oldest) ? oldest + RPM_WINDOW_MS : null };
}
function rpmAvailable(account, now = Date.now()) { return !account ? true : !rpmBlockedRetryAt(account, now).blocked; }
function rpmRetryAt(account, now = Date.now()) { return account ? rpmBlockedRetryAt(account, now).retryAt : null; }
function clearRpmState(accountId) { rpmWindows.delete(accountId); }
// 预留：reservation 在 req.end() 处变成窗口内已提交时间戳；未提交即失败必须 release 并唤醒等待者。
function reserveRpmPermit(account, now = Date.now()) {
  const limit = rpmLimit(account);
  if (!limit) return { ok: true, permit: null };
  const state = rpmWindowState(account.id, { create: true });
  state.reservations++;
  pruneRpmWindow(account.id, state, now);
  if (rpmLiveCount(state) > limit) {
    state.reservations--;
    return { ok: false, retryAt: rpmRetryAt(account, now) };
  }
  let settled = false;
  const settle = () => { if (settled) return false; settled = true; state.reservations = Math.max(0, state.reservations - 1); return true; };
  return {
    ok: true,
    permit: {
      commit() { if (settle()) state.timestamps.push(Date.now()); },
      release() { if (settle()) notifyCapacityWaiters(); },
    },
  };
}
function selectionBlockFacts(accounts, now = Date.now()) {
  const reasons = new Set();
  let retryAt = null;
  for (const account of accounts) {
    // 分别记录两个维度：一个账号可以同时是并发满和 RPM 耗尽，"mixed" 必须可诊断。
    if (!accountHasCapacity(account)) reasons.add('concurrency');
    const blocked = rpmBlockedRetryAt(account, now);
    if (!blocked.blocked) continue;
    reasons.add('rpm');
    if (Number.isSafeInteger(blocked.retryAt) && (retryAt === null || blocked.retryAt < retryAt)) retryAt = blocked.retryAt;
  }
  const blockedBy = reasons.size > 1 ? 'mixed' : reasons.has('concurrency') ? 'concurrency' : reasons.has('rpm') ? 'rpm' : 'unavailable';
  return { blockedBy, retryAt };
}
function blockedByRetryAfter(blockedBy, retryAt, waitMs) {
  if ((blockedBy === 'rpm' || blockedBy === 'mixed') && Number.isSafeInteger(retryAt)) return Math.max(1, Math.ceil((retryAt - Date.now()) / 1000));
  return retryAfterSeconds(waitMs);
}
function blockedByMessage(blockedBy, fallback) {
  if (blockedBy === 'rpm') return 'upstream account rpm limit reached';
  if (blockedBy === 'mixed') return 'upstream accounts are busy or rpm limited';
  return fallback;
}
function busyFailure(blockedBy, retryAt, mode, waitMs, fallback, extra = {}) {
  return { error: blockedByMessage(blockedBy, fallback), strategy: mode, blockedBy, retryAfter: blockedByRetryAfter(blockedBy, retryAt, waitMs), ...extra };
}
function waitDurationForBlock(deadline, facts) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return 0;
  if (!Number.isSafeInteger(facts?.retryAt)) return remaining;
  return Math.max(1, Math.min(remaining, facts.retryAt - Date.now()));
}
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
    // maxRpm: 0 = 不限。旧客户端完整保存但省略该字段时按 stable id 保留旧值，新账号缺失为 0。
    maxRpm: normalizeMaxRpm(a?.maxRpm === undefined ? previous.maxRpm : a.maxRpm),
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
const PIPELINE_KEYS = ['quotaPool', 'healthSort', 'sticky'];
const PIPELINE_DEFAULT_ORDER = ['quotaPool', 'healthSort', 'sticky'];
const LEGACY_PIPELINE_ORDER = ['excludeUnhealthy', 'quotaPool', 'healthSort', 'sticky'];
const SESSION_BINDING_EXPLICIT_TTL_MS = 7_200_000;
const SESSION_BINDING_FALLBACK_TTL_MS = 900_000;
const SESSION_BINDING_MAX_ENTRIES = 50_000;
const SESSION_BINDING_TTL_MIN_MS = 60_000;
const SESSION_BINDING_TTL_MAX_MS = 604_800_000;
function validPipelineOrder(value) {
  return Array.isArray(value) && value.length === PIPELINE_DEFAULT_ORDER.length && new Set(value).size === PIPELINE_DEFAULT_ORDER.length && value.every((step) => PIPELINE_DEFAULT_ORDER.includes(step));
}
function validLegacyPipelineOrder(value) {
  return Array.isArray(value) && value.length === LEGACY_PIPELINE_ORDER.length && new Set(value).size === LEGACY_PIPELINE_ORDER.length && value.every((step) => LEGACY_PIPELINE_ORDER.includes(step));
}
function canonicalPipelineOrder(value, fallback = PIPELINE_DEFAULT_ORDER) {
  const source = validPipelineOrder(value) ? value : validLegacyPipelineOrder(value) ? value : validPipelineOrder(fallback) ? fallback : validLegacyPipelineOrder(fallback) ? fallback : PIPELINE_DEFAULT_ORDER;
  const out = [];
  for (const raw of source) {
    const step = raw === 'excludeUnhealthy' ? 'healthSort' : raw;
    if (!out.includes(step)) out.push(step);
  }
  for (const step of PIPELINE_DEFAULT_ORDER) if (!out.includes(step)) out.push(step);
  return out;
}
function normalizeAccountPipeline(value, {
  strict = false,
  fallbackOrder = PIPELINE_DEFAULT_ORDER,
  fallbackCachePoolSize = 0,
  fallbackCachePoolMaxSize,
  fallbackCachePoolLowQuotaSize = 0,
  fallbackSessionBindingExplicitTtlMs = SESSION_BINDING_EXPLICIT_TTL_MS,
  fallbackSessionBindingFallbackTtlMs = SESSION_BINDING_FALLBACK_TTL_MS,
  fallbackSessionBindingMaxEntries = SESSION_BINDING_MAX_ENTRIES,
} = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    if (strict) throw new Error('accountPipeline must be an object');
    value = {};
  }
  const legacy = Object.hasOwn(value, 'excludeUnhealthy');
  const allowed = [...PIPELINE_KEYS, ...(legacy ? ['excludeUnhealthy'] : []), 'order', 'cachePoolSize', 'cachePoolMaxSize', 'cachePoolLowQuotaSize', 'sessionBindingExplicitTtlMs', 'sessionBindingFallbackTtlMs', 'sessionBindingMaxEntries'];
  if (strict && Object.keys(value).some((key) => !allowed.includes(key))) throw new Error('accountPipeline contains an unknown field');
  if (strict) {
    for (const key of PIPELINE_KEYS) if (typeof value[key] !== 'boolean') throw new Error(`accountPipeline.${key} must be boolean`);
    if (legacy && typeof value.excludeUnhealthy !== 'boolean') throw new Error('accountPipeline.excludeUnhealthy must be boolean');
  }
  const out = {
    quotaPool: value.quotaPool === true,
    healthSort: value.healthSort === true || value.excludeUnhealthy === true,
    sticky: value.sticky === true,
  };
  if (value.order === undefined) out.order = canonicalPipelineOrder(fallbackOrder);
  else if (validPipelineOrder(value.order) || validLegacyPipelineOrder(value.order)) out.order = canonicalPipelineOrder(value.order);
  else if (strict) throw new Error('accountPipeline.order must be an exact permutation of the three canonical or four legacy pipeline steps');
  else out.order = [...PIPELINE_DEFAULT_ORDER];
  if (value.cachePoolSize === undefined) out.cachePoolSize = Number.isInteger(fallbackCachePoolSize) && fallbackCachePoolSize >= 0 && fallbackCachePoolSize <= 100000 ? fallbackCachePoolSize : 0;
  else if (Number.isInteger(value.cachePoolSize) && value.cachePoolSize >= 0 && value.cachePoolSize <= 100000) out.cachePoolSize = value.cachePoolSize;
  else if (strict) throw new Error('accountPipeline.cachePoolSize must be an integer from 0 to 100000');
  else out.cachePoolSize = 0;
  const fallbackMax = Number.isInteger(fallbackCachePoolMaxSize) ? fallbackCachePoolMaxSize : out.cachePoolSize;
  if (value.cachePoolMaxSize === undefined) out.cachePoolMaxSize = fallbackMax >= 0 && fallbackMax <= 100000 ? Math.max(out.cachePoolSize, fallbackMax) : out.cachePoolSize;
  else if (Number.isInteger(value.cachePoolMaxSize) && value.cachePoolMaxSize >= 0 && value.cachePoolMaxSize <= 100000) out.cachePoolMaxSize = value.cachePoolMaxSize;
  else if (strict) throw new Error('accountPipeline.cachePoolMaxSize must be an integer from 0 to 100000');
  else out.cachePoolMaxSize = out.cachePoolSize;
  const fallbackLow = Number.isInteger(fallbackCachePoolLowQuotaSize) && fallbackCachePoolLowQuotaSize >= 0 && fallbackCachePoolLowQuotaSize <= 100000 ? fallbackCachePoolLowQuotaSize : 0;
  if (value.cachePoolLowQuotaSize === undefined) out.cachePoolLowQuotaSize = fallbackLow;
  else if (Number.isInteger(value.cachePoolLowQuotaSize) && value.cachePoolLowQuotaSize >= 0 && value.cachePoolLowQuotaSize <= 100000) out.cachePoolLowQuotaSize = value.cachePoolLowQuotaSize;
  else if (strict) throw new Error('accountPipeline.cachePoolLowQuotaSize must be an integer from 0 to 100000');
  else out.cachePoolLowQuotaSize = 0;
  const bindingDefaults = { sessionBindingExplicitTtlMs: SESSION_BINDING_EXPLICIT_TTL_MS, sessionBindingFallbackTtlMs: SESSION_BINDING_FALLBACK_TTL_MS, sessionBindingMaxEntries: SESSION_BINDING_MAX_ENTRIES };
  const boundedInteger = (field, fallback, min, max) => {
    if (value[field] === undefined) return Number.isInteger(fallback) && fallback >= min && fallback <= max ? fallback : bindingDefaults[field];
    if (Number.isInteger(value[field]) && value[field] >= min && value[field] <= max) return value[field];
    if (strict) throw new Error(`accountPipeline.${field} must be an integer from ${min} to ${max}`);
    return bindingDefaults[field];
  };
  out.sessionBindingExplicitTtlMs = boundedInteger('sessionBindingExplicitTtlMs', fallbackSessionBindingExplicitTtlMs, SESSION_BINDING_TTL_MIN_MS, SESSION_BINDING_TTL_MAX_MS);
  out.sessionBindingFallbackTtlMs = boundedInteger('sessionBindingFallbackTtlMs', fallbackSessionBindingFallbackTtlMs, SESSION_BINDING_TTL_MIN_MS, SESSION_BINDING_TTL_MAX_MS);
  out.sessionBindingMaxEntries = boundedInteger('sessionBindingMaxEntries', fallbackSessionBindingMaxEntries, 1, 100000);
  if (out.cachePoolMaxSize < out.cachePoolSize) {
    if (strict) throw new Error('accountPipeline.cachePoolMaxSize must be greater than or equal to cachePoolSize');
    out.cachePoolMaxSize = out.cachePoolSize;
  }
  if (out.cachePoolLowQuotaSize > out.cachePoolSize) {
    if (strict) throw new Error('accountPipeline.cachePoolLowQuotaSize must not exceed cachePoolSize');
    out.cachePoolLowQuotaSize = out.cachePoolSize;
  }
  if (out.sessionBindingFallbackTtlMs > out.sessionBindingExplicitTtlMs) {
    if (strict) throw new Error('accountPipeline.sessionBindingFallbackTtlMs must not exceed sessionBindingExplicitTtlMs');
    out.sessionBindingFallbackTtlMs = Math.min(SESSION_BINDING_FALLBACK_TTL_MS, out.sessionBindingExplicitTtlMs);
  }
  return out;
}
const LEGACY_AGG_FIELDS = ['requests','errors','usageRequests','inputKnownRequests','inputTokens','outputKnownRequests','outputTokens','totalKnownRequests','totalTokens','cacheKnownRequests','cacheHitRequests','cachedTokens','cacheInputKnownRequests','cacheInputTokens','cacheInputCachedTokens'];
const ROUTING_AGG_FIELDS = ['explicitAffinityRequests','fallbackAffinityRequests','providerFallbackRequests','providerCircuitCooldownRequests','providerHalfOpenRequests'];
const AGG_FIELDS = [...LEGACY_AGG_FIELDS, ...ROUTING_AGG_FIELDS];
const HEALTH_FIELDS = ['results','penaltyUnits','errors','auth','rateLimit','networkProxy','server','other'];
const SUCCESS_FIELDS = ['successes','degrades'];
// 直接成功率样本只由 generation 校验后的 healthAction 决定：处置动作与样本同源，
// 但只有真正应用过的处置（或具名成功）才产生样本，规则命中/取消/stale generation 本身不写样本。
const SAMPLE_FAILURE_ACTIONS = new Set(['degrade','cooldown','hard-quarantine']);
function emptyAggregate() { return Object.fromEntries([...AGG_FIELDS.map((key) => [key, 0]), ['lastUsedAt', 0], ['lastErrorAt', 0], ['overflowFields', []]]); }
function emptyHealth() { return Object.fromEntries(HEALTH_FIELDS.map((key) => [key, 0])); }
function emptySuccessHealth() { return { successes: 0, degrades: 0, overflowFields: [] }; }
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
function validateSuccessHealth(value, label) {
  if (!isPlainObject(value) || Object.keys(value).length !== 3 || !Array.isArray(value.overflowFields) || value.overflowFields.some((key) => !SUCCESS_FIELDS.includes(key)) || new Set(value.overflowFields).size !== value.overflowFields.length) throw new Error(`invalid statistics ${label}`);
  for (const key of SUCCESS_FIELDS) {
    const overflowed = value.overflowFields.includes(key);
    if ((overflowed && value[key] !== null) || (!overflowed && (!Number.isSafeInteger(value[key]) || value[key] < 0))) throw new Error(`invalid statistics ${label}.${key}`);
  }
}
// Frozen ClinePass reference rates, USD per 1M tokens in integer thousandths.
// Collection date is ours; the official table does not publish an effective date.
const REFERENCE_PRICE = Object.freeze({ version: 'clinepass-2026-09-24-v1', collectedAt: '2026-09-24', effectiveAt: null,
  source: 'https://docs.cline.bot/getting-started/clinepass', currency: 'USD',
  models: {
    'cline-pass/kimi-k3': { tier: 'single', rates: [[3000,15000,300]] },
    'cline-pass/glm-5.3': { tier: 'single', rates: [[1400,4400,260]] },
    'cline-pass/deepseek-v4-flash': { tier: 'peak/off-peak range', rates: [[220,660,7],[440,1320,14]] },
    'cline-pass/deepseek-v4-pro': { tier: 'peak/off-peak range', rates: [[660,1980,22],[1320,3960,44]] },
  },
});
const STATISTICS_VERSION = 5;
const MAX_USAGE_MINUTE_CELLS = process.env.NODE_ENV === 'test' ? Math.max(1, Number(process.env.CLINE_PASS_TEST_USAGE_CELL_LIMIT) || 50000) : 50000;
const MAX_VALUATION_MINUTE_CELLS = process.env.NODE_ENV === 'test' ? Math.max(1, Number(process.env.CLINE_PASS_TEST_VALUATION_CELL_LIMIT) || 50000) : 50000;
const MAX_PRICE_VERSIONS = 8;
const VALUATION_FIELDS = ['pricedRequests','lowPicoUsd','highPicoUsd'];
function emptyValuation() { return { pricedRequests: 0, lowPicoUsd: 0, highPicoUsd: 0, overflowFields: [] }; }
const STAT_PROVIDER_ID = /^[a-z0-9][a-z0-9._/-]{0,199}$/i;
const FINAL_FIELDS = ['successes','failures','cancelled'];
function emptyFinal() { return { successes: 0, failures: 0, cancelled: 0, overflowFields: [] }; }
function validateFinal(value) {
  if (!isPlainObject(value) || Object.keys(value).length !== 4 || !Array.isArray(value.overflowFields) || new Set(value.overflowFields).size !== value.overflowFields.length || value.overflowFields.some((key) => !FINAL_FIELDS.includes(key))) throw new Error('invalid statistics model final');
  for (const key of FINAL_FIELDS) if (value.overflowFields.includes(key) ? value[key] !== null : !Number.isSafeInteger(value[key]) || value[key] < 0) throw new Error('invalid statistics model final counter');
}
function validPriceVersion(id) { return typeof id === 'string' && /^[a-z0-9][a-z0-9-]{0,79}$/.test(id) && !['constructor','prototype','__proto__'].includes(id); }
function validateValuation(value) {
  if (!isPlainObject(value) || Object.keys(value).length !== 4 || !Array.isArray(value.overflowFields) || new Set(value.overflowFields).size !== value.overflowFields.length || value.overflowFields.some((key) => !VALUATION_FIELDS.includes(key))) throw new Error('invalid statistics valuation');
  for (const key of VALUATION_FIELDS) if (value.overflowFields.includes(key) ? value[key] !== null : !Number.isSafeInteger(value[key]) || value[key] < 0) throw new Error('invalid statistics valuation counter');
}
function validatePriceSnapshot(snapshot) {
  if (!isPlainObject(snapshot) || Object.keys(snapshot).sort().join(',') !== 'collectedAt,currency,effectiveAt,models,source,version' || !validPriceVersion(snapshot.version) || !/^\d{4}-\d{2}-\d{2}$/.test(snapshot.collectedAt) || snapshot.effectiveAt !== null || snapshot.source !== REFERENCE_PRICE.source || snapshot.currency !== 'USD' || !isPlainObject(snapshot.models) || Object.keys(snapshot.models).length > 16) throw new Error('invalid statistics price snapshot');
  for (const [id, price] of Object.entries(snapshot.models)) if (!/^cline-pass\/[a-z0-9._-]{1,200}$/.test(id) || !isPlainObject(price) || Object.keys(price).sort().join(',') !== 'rates,tier' || !['single','peak/off-peak range'].includes(price.tier) || !Array.isArray(price.rates) || price.rates.length !== (price.tier === 'single' ? 1 : 2) || price.rates.some((row) => !Array.isArray(row) || row.length !== 3 || row.some((rate) => !Number.isSafeInteger(rate) || rate < 0 || rate > 10000000))) throw new Error('invalid statistics price rates');
}
function referenceValue(modelId, usage) {
  const price = Object.hasOwn(REFERENCE_PRICE.models, modelId) ? REFERENCE_PRICE.models[modelId] : null;
  if (!price || !usage || ![usage.inputTokens,usage.outputTokens,usage.cachedTokens].every((n) => Number.isSafeInteger(n) && n >= 0) || usage.cachedTokens > usage.inputTokens) return null;
  const amounts = price.rates.map(([input,output,cached]) => (BigInt(usage.inputTokens - usage.cachedTokens) * BigInt(input) + BigInt(usage.outputTokens) * BigInt(output) + BigInt(usage.cachedTokens) * BigInt(cached)) * 1000n);
  return { lowPicoUsd: amounts[0] <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(amounts[0]) : null, highPicoUsd: amounts.at(-1) <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(amounts.at(-1)) : null };
}
const MAX_ACCOUNT_MINUTE_CELLS = process.env.NODE_ENV === 'test' ? Math.max(1, Number(process.env.CLINE_PASS_TEST_ACCOUNT_MINUTE_CELL_LIMIT) || 50000) : 50000;
const MAX_MODEL_MINUTE_CELLS = process.env.NODE_ENV === 'test' ? Math.max(1, Number(process.env.CLINE_PASS_TEST_MODEL_CELL_LIMIT) || 50000) : 50000;
const MAX_PROVIDER_HEALTH_MINUTE_CELLS = process.env.NODE_ENV === 'test' ? Math.max(1, Number(process.env.CLINE_PASS_TEST_PROVIDER_HEALTH_CELL_LIMIT) || 50000) : 50000;
const FORBIDDEN_STATISTIC_KEYS = new Set(['__proto__','prototype','constructor']);
function validStatisticModelId(id) { return typeof id === 'string' && id.length > 0 && id.length <= 300 && !/[\x00-\x1f\x7f]/.test(id) && !FORBIDDEN_STATISTIC_KEYS.has(id); }
function statisticCell(map, key, make) {
  if (!Object.hasOwn(map, key)) Object.defineProperty(map, key, { value: make(), enumerable: true, configurable: true, writable: true });
  return map[key];
}
function aggregateCell(map, key) { return statisticCell(map, key, emptyAggregate); }
function createStatistics(now = Date.now()) {
  const minute = Math.floor(now / 60000);
  return { version: STATISTICS_VERSION, lifetime: { global: emptyAggregate(), accounts: {} }, minuteBuckets: [], recentCoverage: { droppedAccountMinuteCells: 0, accountIncompleteAt: {}, modelTrackingStartedMinute: minute, droppedModelMinuteCells: 0, modelIncompleteAt: {}, routingTrackingStartedMinute: minute, accountHealthTrackingStartedMinute: minute, accountHealthIncompleteAt: {}, droppedProviderHealthMinuteCells: 0, providerHealthTrackingStartedMinute: minute, providerHealthIncompleteAt: {}, usageTrackingStartedMinute: minute, droppedUsageMinuteCells: 0, usageIncompleteAt: {}, usageGlobalIncompleteAt: 0, droppedValuationMinuteCells: 0, valuationIncompleteAt: {}, valuationGlobalIncompleteAt: 0 }, priceVersions: {}, migration: { legacyStatsMigratedAt: now, legacyRequests: 0, accountLegacyRequests: {}, ambiguousNames: 0, unmappedNames: 0 } };
}
function validateStatistics(stats) {
  if (!isPlainObject(stats) || ![1,2,3,4,STATISTICS_VERSION].includes(stats.version)) throw new Error(stats?.version > STATISTICS_VERSION ? 'unsupported statistics version' : 'invalid statistics version');
  const hasModels = stats.version >= 2, hasRouting = stats.version >= 3, hasSuccessHealth = stats.version >= 4, hasUsage = stats.version >= 5, aggregateFields = hasRouting ? AGG_FIELDS : LEGACY_AGG_FIELDS;
  const coverageKeys = hasUsage ? ['droppedAccountMinuteCells','accountIncompleteAt','modelTrackingStartedMinute','droppedModelMinuteCells','modelIncompleteAt','routingTrackingStartedMinute','accountHealthTrackingStartedMinute','accountHealthIncompleteAt','droppedProviderHealthMinuteCells','providerHealthTrackingStartedMinute','providerHealthIncompleteAt','usageTrackingStartedMinute','droppedUsageMinuteCells','usageIncompleteAt','usageGlobalIncompleteAt','droppedValuationMinuteCells','valuationIncompleteAt','valuationGlobalIncompleteAt'] : hasSuccessHealth
    ? ['droppedAccountMinuteCells','accountIncompleteAt','modelTrackingStartedMinute','droppedModelMinuteCells','modelIncompleteAt','routingTrackingStartedMinute','accountHealthTrackingStartedMinute','accountHealthIncompleteAt','droppedProviderHealthMinuteCells','providerHealthTrackingStartedMinute','providerHealthIncompleteAt']
    : hasRouting ? ['droppedAccountMinuteCells','accountIncompleteAt','modelTrackingStartedMinute','droppedModelMinuteCells','modelIncompleteAt','routingTrackingStartedMinute']
      : hasModels ? ['droppedAccountMinuteCells','accountIncompleteAt','modelTrackingStartedMinute','droppedModelMinuteCells','modelIncompleteAt'] : ['droppedAccountMinuteCells','accountIncompleteAt'];
  if (Object.keys(stats).length !== (hasUsage ? 6 : 5) || Object.keys(stats).some((key) => !['version','lifetime','minuteBuckets','recentCoverage','migration',...(hasUsage ? ['priceVersions'] : [])].includes(key)) || !isPlainObject(stats.lifetime) || Object.keys(stats.lifetime).some((key) => !['global','accounts'].includes(key)) || !isPlainObject(stats.lifetime.accounts) || !Array.isArray(stats.minuteBuckets) || stats.minuteBuckets.length > 1440 || !isPlainObject(stats.recentCoverage) || Object.keys(stats.recentCoverage).length !== coverageKeys.length || coverageKeys.some((key) => !Object.hasOwn(stats.recentCoverage,key)) || !Number.isSafeInteger(stats.recentCoverage.droppedAccountMinuteCells) || stats.recentCoverage.droppedAccountMinuteCells < 0 || !isPlainObject(stats.recentCoverage.accountIncompleteAt) || !isPlainObject(stats.migration)) throw new Error('invalid statistics structure');
  for (const [id, minute] of Object.entries(stats.recentCoverage.accountIncompleteAt)) if (!/^[A-Za-z0-9_-]{1,100}$/.test(id) || !Number.isSafeInteger(minute) || minute < 0) throw new Error('invalid statistics coverage');
  if (hasModels && (!Number.isSafeInteger(stats.recentCoverage.modelTrackingStartedMinute) || stats.recentCoverage.modelTrackingStartedMinute < 0 || !Number.isSafeInteger(stats.recentCoverage.droppedModelMinuteCells) || stats.recentCoverage.droppedModelMinuteCells < 0 || !isPlainObject(stats.recentCoverage.modelIncompleteAt))) throw new Error('invalid statistics model coverage');
  if (hasModels) for (const [id, minute] of Object.entries(stats.recentCoverage.modelIncompleteAt)) if (!validStatisticModelId(id) || !Number.isSafeInteger(minute) || minute < 0) throw new Error('invalid statistics model coverage');
  if (hasRouting && (!Number.isSafeInteger(stats.recentCoverage.routingTrackingStartedMinute) || stats.recentCoverage.routingTrackingStartedMinute < 0)) throw new Error('invalid statistics routing coverage');
  if (hasSuccessHealth) {
    const coverage = stats.recentCoverage;
    if (!Number.isSafeInteger(coverage.accountHealthTrackingStartedMinute) || coverage.accountHealthTrackingStartedMinute < 0 || !isPlainObject(coverage.accountHealthIncompleteAt) || !Number.isSafeInteger(coverage.droppedProviderHealthMinuteCells) || coverage.droppedProviderHealthMinuteCells < 0 || !Number.isSafeInteger(coverage.providerHealthTrackingStartedMinute) || coverage.providerHealthTrackingStartedMinute < 0 || !isPlainObject(coverage.providerHealthIncompleteAt)) throw new Error('invalid statistics success health coverage');
    for (const [id, minute] of Object.entries(coverage.accountHealthIncompleteAt)) if (!/^[A-Za-z0-9_-]{1,100}$/.test(id) || !Number.isSafeInteger(minute) || minute < 0) throw new Error('invalid statistics account health coverage');
    for (const [modelId, providers] of Object.entries(coverage.providerHealthIncompleteAt)) {
      if (!validStatisticModelId(modelId) || !isPlainObject(providers)) throw new Error('invalid statistics provider health coverage');
      for (const [provider, minute] of Object.entries(providers)) if (!/^[a-z0-9][a-z0-9._/-]{0,199}$/i.test(provider) || !Number.isSafeInteger(minute) || minute < 0) throw new Error('invalid statistics provider health coverage');
    }
  }
  if (hasUsage) {
    const c = stats.recentCoverage;
    if (!isPlainObject(stats.priceVersions) || Object.keys(stats.priceVersions).length > MAX_PRICE_VERSIONS || !Number.isSafeInteger(c.usageTrackingStartedMinute) || c.usageTrackingStartedMinute < 0) throw new Error('invalid statistics usage coverage');
    for (const key of ['droppedUsageMinuteCells','droppedValuationMinuteCells','usageGlobalIncompleteAt','valuationGlobalIncompleteAt']) if (!Number.isSafeInteger(c[key]) || c[key] < 0) throw new Error('invalid statistics cell loss');
    for (const field of ['usageIncompleteAt','valuationIncompleteAt']) {
      if (!isPlainObject(c[field]) || Object.keys(c[field]).length > MAX_USAGE_MINUTE_CELLS) throw new Error('invalid statistics coverage');
      for (const [id, minute] of Object.entries(c[field])) if (!validStatisticModelId(id) || !Number.isSafeInteger(minute) || minute < 0) throw new Error('invalid statistics coverage');
    }
    for (const [version, snapshot] of Object.entries(stats.priceVersions)) { if (!validPriceVersion(version) || version !== snapshot?.version) throw new Error('invalid statistics price version'); validatePriceSnapshot(snapshot); if (version === REFERENCE_PRICE.version && !isDeepStrictEqual(snapshot, REFERENCE_PRICE)) throw new Error('invalid current reference price snapshot'); }
  }
  if (Object.keys(stats.migration).some((key) => !['legacyStatsMigratedAt','legacyRequests','accountLegacyRequests','ambiguousNames','unmappedNames'].includes(key)) || !Number.isSafeInteger(stats.migration.legacyStatsMigratedAt) || stats.migration.legacyStatsMigratedAt < 0 || !Number.isSafeInteger(stats.migration.legacyRequests) || stats.migration.legacyRequests < 0 || !isPlainObject(stats.migration.accountLegacyRequests) || !Number.isSafeInteger(stats.migration.ambiguousNames) || stats.migration.ambiguousNames < 0 || !Number.isSafeInteger(stats.migration.unmappedNames) || stats.migration.unmappedNames < 0) throw new Error('invalid statistics migration');
  for (const [id, requests] of Object.entries(stats.migration.accountLegacyRequests)) if (!/^[A-Za-z0-9_-]{1,100}$/.test(id) || !Number.isSafeInteger(requests) || requests < 0) throw new Error('invalid statistics legacy account');
  validateAggregate(stats.lifetime.global, 'lifetime.global', aggregateFields);
  for (const [id, aggregate] of Object.entries(stats.lifetime.accounts)) { if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new Error('invalid statistics account id'); validateAggregate(aggregate, `lifetime.accounts.${id}`, aggregateFields); }
  let previous = -1, accountCells = 0, modelCells = 0, providerHealthCells = 0, usageCells = 0, valuationCells = 0;
  for (const bucket of stats.minuteBuckets) {
    const bucketKeys = hasUsage ? ['minute','global','accounts','health','models','accountHealth','providerHealth','modelFinal','providerUsage','valuation'] : hasSuccessHealth ? ['minute','global','accounts','health','models','accountHealth','providerHealth'] : hasModels ? ['minute','global','accounts','health','models'] : ['minute','global','accounts','health'];
    if (!isPlainObject(bucket) || Object.keys(bucket).length !== bucketKeys.length || bucketKeys.some((key) => !Object.hasOwn(bucket,key)) || !Number.isSafeInteger(bucket.minute) || bucket.minute < 0 || bucket.minute <= previous || !isPlainObject(bucket.global) || !isPlainObject(bucket.accounts) || !isPlainObject(bucket.health) || (hasModels && !isPlainObject(bucket.models)) || (hasSuccessHealth && (!isPlainObject(bucket.accountHealth) || !isPlainObject(bucket.providerHealth))) || (hasUsage && (!isPlainObject(bucket.modelFinal) || !isPlainObject(bucket.providerUsage) || !isPlainObject(bucket.valuation)))) throw new Error('invalid statistics minute bucket');
    previous = bucket.minute; validateAggregate(bucket.global, `bucket.${bucket.minute}.global`, aggregateFields);
    const ids = new Set([...Object.keys(bucket.accounts), ...Object.keys(bucket.health), ...(hasSuccessHealth ? Object.keys(bucket.accountHealth) : [])]); accountCells += ids.size;
    for (const [id, aggregate] of Object.entries(bucket.accounts)) { if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new Error('invalid statistics account id'); validateAggregate(aggregate, `bucket.${bucket.minute}.accounts.${id}`, aggregateFields); }
    for (const [id, health] of Object.entries(bucket.health)) { if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new Error('invalid statistics account id'); validateHealth(health, `bucket.${bucket.minute}.health.${id}`); }
    if (hasModels) for (const [id, aggregate] of Object.entries(bucket.models)) { if (!validStatisticModelId(id)) throw new Error('invalid statistics model id'); modelCells++; validateAggregate(aggregate, `bucket.${bucket.minute}.models.${id}`, aggregateFields); }
    if (hasSuccessHealth) {
      for (const [id, health] of Object.entries(bucket.accountHealth)) { if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new Error('invalid statistics account health id'); validateSuccessHealth(health, `bucket.${bucket.minute}.accountHealth.${id}`); }
      for (const [modelId, providers] of Object.entries(bucket.providerHealth)) {
        if (!validStatisticModelId(modelId) || !isPlainObject(providers)) throw new Error('invalid statistics provider health model');
        for (const [provider, health] of Object.entries(providers)) { if (!/^[a-z0-9][a-z0-9._/-]{0,199}$/i.test(provider)) throw new Error('invalid statistics provider health provider'); providerHealthCells++; validateSuccessHealth(health, `bucket.${bucket.minute}.providerHealth.${modelId}.${provider}`); }
      }
    }
    if (hasUsage) {
      for (const [id, final] of Object.entries(bucket.modelFinal)) { if (!validStatisticModelId(id) || !Object.hasOwn(bucket.models,id)) throw new Error('invalid statistics model final id'); validateFinal(final); }
      for (const [model, providers] of Object.entries(bucket.providerUsage)) {
        if (!validStatisticModelId(model) || !isPlainObject(providers)) throw new Error('invalid statistics usage model');
        for (const [provider, delta] of Object.entries(providers)) { if (provider && !STAT_PROVIDER_ID.test(provider)) throw new Error('invalid statistics usage provider'); usageCells++; validateAggregate(delta, 'provider usage'); }
      }
      for (const [model, providers] of Object.entries(bucket.valuation)) {
        if (!validStatisticModelId(model) || !isPlainObject(providers)) throw new Error('invalid statistics valuation model');
        for (const [provider, versions] of Object.entries(providers)) {
          if (provider && !STAT_PROVIDER_ID.test(provider) || !isPlainObject(versions)) throw new Error('invalid statistics valuation provider');
          for (const [version, value] of Object.entries(versions)) { if (!Object.hasOwn(stats.priceVersions, version) || !Object.hasOwn(stats.priceVersions[version].models, model)) throw new Error('invalid statistics valuation version'); valuationCells++; validateValuation(value); }
        }
      }
    }
  }
  if (usageCells > MAX_USAGE_MINUTE_CELLS || valuationCells > MAX_VALUATION_MINUTE_CELLS) throw new Error('statistics usage/valuation cell limit exceeded');
  if (accountCells > MAX_ACCOUNT_MINUTE_CELLS) throw new Error('statistics account-minute cell limit exceeded');
  if (modelCells > MAX_MODEL_MINUTE_CELLS) throw new Error('statistics model-minute cell limit exceeded');
  if (providerHealthCells > MAX_PROVIDER_HEALTH_MINUTE_CELLS) throw new Error('statistics provider-health-minute cell limit exceeded');
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
      META.statistics.version = 3;
      dirty = true;
    }
    if (META.statistics.version === 3) {
      const minute = Math.floor(Date.now() / 60000);
      META.statistics.minuteBuckets = META.statistics.minuteBuckets.map((bucket) => ({ ...bucket, accountHealth: {}, providerHealth: {} }));
      Object.assign(META.statistics.recentCoverage, {
        accountHealthTrackingStartedMinute: minute,
        accountHealthIncompleteAt: {},
        droppedProviderHealthMinuteCells: 0,
        providerHealthTrackingStartedMinute: minute,
        providerHealthIncompleteAt: {},
      });
      META.statistics.version = 4;
      dirty = true;
    }
    if (META.statistics.version === 4) {
      const minute = Math.floor(Date.now() / 60000);
      META.statistics.minuteBuckets = META.statistics.minuteBuckets.map((bucket) => ({ ...bucket, modelFinal: {}, providerUsage: {}, valuation: {} }));
      Object.assign(META.statistics.recentCoverage, { usageTrackingStartedMinute: minute, droppedUsageMinuteCells: 0, usageIncompleteAt: {}, usageGlobalIncompleteAt: 0, droppedValuationMinuteCells: 0, valuationIncompleteAt: {}, valuationGlobalIncompleteAt: 0 });
      META.statistics.priceVersions = {};
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
function cachePoolTargetFor(pipeline = config.accountPipeline, value = META.cachePoolTargetSize) {
  const min = Number.isInteger(pipeline?.cachePoolSize) ? pipeline.cachePoolSize : 0;
  const max = Number.isInteger(pipeline?.cachePoolMaxSize) ? pipeline.cachePoolMaxSize : min;
  if (min === 0) return 0;
  const target = Number.isInteger(value) ? value : min;
  return Math.min(max, Math.max(min, target));
}
function normalizeCachePoolTarget(pipeline = config.accountPipeline) {
  const target = cachePoolTargetFor(pipeline);
  if (META.cachePoolTargetSize === target) return false;
  META.cachePoolTargetSize = target;
  return true;
}
function normalizeConfigAndMeta({ persist = false } = {}) {
  let dirty = false;
  const protection = normalizeQuotaProtection(config.quotaProtection);
  if (JSON.stringify(config.quotaProtection) !== JSON.stringify(protection)) { config.quotaProtection = protection; dirty = true; }
  for (const field of ['detailedLogging', 'errorDetailLogging', 'rawBodyLogging']) if (config[field] !== true && config[field] !== false) { config[field] = false; dirty = true; }
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
  const errorRules = configHadCanonicalErrorRules
    ? normalizeErrorRules(config.errorRules, { strict: true })
    : migrateLegacyErrorRules(config.accountErrorRules || {}, config.accountContentErrorRules === undefined ? [] : config.accountContentErrorRules);
  if (!configHadCanonicalErrorRules || JSON.stringify(errorRules) !== JSON.stringify(config.errorRules)) { config.errorRules = errorRules; dirty = true; }
  const legacyRules = legacyRuleProjection(errorRules);
  if (JSON.stringify(legacyRules.accountErrorRules) !== JSON.stringify(config.accountErrorRules || {})) { config.accountErrorRules = legacyRules.accountErrorRules; dirty = true; }
  if (JSON.stringify(legacyRules.accountContentErrorRules) !== JSON.stringify(config.accountContentErrorRules || [])) { config.accountContentErrorRules = legacyRules.accountContentErrorRules; dirty = true; }
  const retryRules = configHadCanonicalRetryRules ? normalizeRetryRules(config.retryRules, { strict: true }) : [];
  if (!configHadCanonicalRetryRules || JSON.stringify(retryRules) !== JSON.stringify(config.retryRules)) { config.retryRules = retryRules; dirty = true; }
  const pipeline = normalizeAccountPipeline(config.accountPipeline);
  if (JSON.stringify(pipeline) !== JSON.stringify(config.accountPipeline)) { config.accountPipeline = pipeline; dirty = true; }
  if (normalizeCachePoolTarget(pipeline)) dirty = true;
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
  if (normalizeAccountStates()) dirty = true;
  if (normalizeStatistics()) dirty = true;
  if (normalizeAccountQuotas()) dirty = true;
  if (pipeline.cachePoolLowQuotaSize > 0 && pipeline.cachePoolSize > 0 && (config.accountMode === 'sticky' || pipeline.sticky)) for (const account of config.accounts) {
    const quota = META.accountQuotas[account.id];
    if (!quota?.snapshot || quota.lastSuccessAt !== quota.snapshot.fetchedAt) continue;
    const exhausted = Object.values(quota.snapshot.limits || {}).filter((window) => window.percentUsed >= 100);
    if (!exhausted.length) continue;
    const previous = META.accountStates[account.id];
    if (previous?.quotaDisposition === 'quota-exhausted') continue;
    const now = Date.now(), resets = exhausted.map((window) => Date.parse(window.resetsAt)).filter((at) => Number.isSafeInteger(at) && at > now);
    META.accountStates[account.id] = { ...(previous || {}), quotaDisposition: 'quota-exhausted', quotaDispositionAt: now, quotaRetryAt: resets.length ? Math.min(...resets) : 0, quotaReason: 'known-exhausted' };
    dirty = true;
  }
  const ids = new Set((config.accounts || []).map((a) => a.id));
  const envKey = String(process.env.CLINE_PASS_KEY || '').trim();
  if (envKey) ids.add(envAccountId(envKey));
  for (const id of Object.keys(META.accountStates)) if (!ids.has(id)) { delete META.accountStates[id]; dirty = true; }
  for (const id of Object.keys(META.accountQuotas)) if (!ids.has(id)) { delete META.accountQuotas[id]; dirty = true; }
  for (const id of Object.keys(META.statistics.lifetime.accounts)) if (!ids.has(id)) { delete META.statistics.lifetime.accounts[id]; dirty = true; }
  for (const bucket of META.statistics.minuteBuckets) for (const id of new Set([...Object.keys(bucket.accounts), ...Object.keys(bucket.health), ...Object.keys(bucket.accountHealth || {})])) if (!ids.has(id)) { delete bucket.accounts[id]; delete bucket.health[id]; if (bucket.accountHealth) delete bucket.accountHealth[id]; dirty = true; }
  for (const id of Object.keys(META.statistics.recentCoverage.accountIncompleteAt)) if (!ids.has(id)) { delete META.statistics.recentCoverage.accountIncompleteAt[id]; dirty = true; }
  for (const id of Object.keys(META.statistics.recentCoverage.accountHealthIncompleteAt || {})) if (!ids.has(id)) { delete META.statistics.recentCoverage.accountHealthIncompleteAt[id]; dirty = true; }
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
const sessionBindings = new Map();
const sessionBindingCounters = { hits: 0, misses: 0, invalidated: 0, temporaryOverflows: 0, provisionalHits: 0 };
let sessionBindingGeneration = 0n;
const SESSION_BINDING_TTL_SCALE = process.env.NODE_ENV === 'test' ? Math.max(0.0001, Math.min(1, Number(process.env.CLINE_PASS_TEST_BINDING_TTL_SCALE) || 1)) : 1;
function notifyCapacityWaiters() { for (const resolve of [...waiters]) resolve(); }
function incrementBindingCounter(key) { sessionBindingCounters[key] = Math.min(Number.MAX_SAFE_INTEGER, (sessionBindingCounters[key] || 0) + 1); }
function sessionBindingSource(identity) { return identity?.confidence === 'explicit' ? 'explicit' : identity?.confidence === 'fallback' ? 'fallback' : 'none'; }
function sessionBindingTtlMs(source) {
  const configured = source === 'fallback' ? config.accountPipeline?.sessionBindingFallbackTtlMs : config.accountPipeline?.sessionBindingExplicitTtlMs;
  const fallback = source === 'fallback' ? SESSION_BINDING_FALLBACK_TTL_MS : SESSION_BINDING_EXPLICIT_TTL_MS;
  return Math.max(1, Math.floor((Number.isInteger(configured) ? configured : fallback) * SESSION_BINDING_TTL_SCALE));
}
function nextSessionBindingGeneration() {
  sessionBindingGeneration += 1n;
  return sessionBindingGeneration;
}
function deleteSessionBinding(fingerprint, entry, { count = true } = {}) {
  if (sessionBindings.get(fingerprint) !== entry) return false;
  sessionBindings.delete(fingerprint);
  if (count) incrementBindingCounter('invalidated');
  return true;
}
function pruneSessionBindings(now = Date.now(), { full = false } = {}) {
  let scanned = 0;
  for (const [fingerprint, entry] of sessionBindings) {
    if (entry.expiresAt <= now) deleteSessionBinding(fingerprint, entry);
    if (!full && ++scanned >= 256) break;
  }
  const limit = config.accountPipeline?.sessionBindingMaxEntries || SESSION_BINDING_MAX_ENTRIES;
  while (sessionBindings.size > limit) {
    const oldest = sessionBindings.entries().next().value;
    if (!oldest) break;
    deleteSessionBinding(oldest[0], oldest[1]);
  }
}
function touchSessionBinding(fingerprint, entry, now = Date.now()) {
  entry.lastUsedAt = now;
  entry.expiresAt = now + sessionBindingTtlMs(entry.source);
  sessionBindings.delete(fingerprint);
  sessionBindings.set(fingerprint, entry);
}
function findSessionBinding(identity, validIds, now = Date.now()) {
  const fingerprint = identity?.fingerprint;
  if (!fingerprint) return { entry: null, result: 'miss' };
  const entry = sessionBindings.get(fingerprint);
  if (!entry) return { entry: null, result: 'miss' };
  if (entry.expiresAt <= now || !validIds.has(entry.accountId)) {
    deleteSessionBinding(fingerprint, entry);
    return { entry: null, result: 'invalidated' };
  }
  touchSessionBinding(fingerprint, entry, now);
  if (entry.state === 'provisional') incrementBindingCounter('provisionalHits');
  else incrementBindingCounter('hits');
  return { entry, result: entry.state === 'provisional' ? 'provisional' : 'hit' };
}
function createProvisionalSessionBinding(identity, accountId, ownerRequestId) {
  const source = sessionBindingSource(identity);
  if (!identity?.fingerprint || source === 'none' || !ownerRequestId) return null;
  pruneSessionBindings();
  const now = Date.now(), generation = nextSessionBindingGeneration();
  const entry = { accountId, source, expiresAt: now + sessionBindingTtlMs(source), lastUsedAt: now, state: 'provisional', generation, ownerRequestId };
  sessionBindings.delete(identity.fingerprint);
  sessionBindings.set(identity.fingerprint, entry);
  incrementBindingCounter('misses');
  pruneSessionBindings(now);
  return { fingerprint: identity.fingerprint, accountId, generation, ownerRequestId, owned: true, committed: false };
}
function sessionBindingHitToken(identity, entry) {
  return { fingerprint: identity.fingerprint, accountId: entry.accountId, generation: entry.generation, ownerRequestId: entry.ownerRequestId, owned: false, committed: entry.state === 'confirmed' };
}
function commitSessionBindingSelection(selected) {
  const token = selected?.bindingToken;
  if (!token) return;
  const entry = sessionBindings.get(token.fingerprint);
  if (!entry || entry.generation !== token.generation || entry.accountId !== token.accountId) return;
  entry.state = 'confirmed';
  token.committed = true;
  touchSessionBinding(token.fingerprint, entry);
}
function cleanupSessionBindingSelection(selected) {
  const token = selected?.bindingToken;
  if (!token?.owned || token.committed) return;
  const entry = sessionBindings.get(token.fingerprint);
  if (entry?.state === 'provisional' && entry.generation === token.generation && entry.ownerRequestId === token.ownerRequestId) deleteSessionBinding(token.fingerprint, entry);
}
function invalidateSessionBindingsForAccount(accountId) {
  let changed = false;
  for (const [fingerprint, entry] of sessionBindings) if (entry.accountId === accountId) changed = deleteSessionBinding(fingerprint, entry) || changed;
  if (changed) notifyCapacityWaiters();
}
function invalidateSessionBindingsOutside(validIds) {
  let changed = false;
  for (const [fingerprint, entry] of sessionBindings) if (!validIds.has(entry.accountId)) changed = deleteSessionBinding(fingerprint, entry) || changed;
  if (changed) notifyCapacityWaiters();
}
function reconcileSessionBindings() {
  pruneSessionBindings(Date.now(), { full: true });
  if (!sessionBindingConfigured()) return invalidateSessionBindingsOutside(new Set());
  invalidateSessionBindingsOutside(bindingSelectionContext(new Set()).activeIds);
}
function sessionBindingSummary() {
  reconcileSessionBindings();
  return { enabled: sessionBindingConfigured(), size: sessionBindings.size, maxEntries: config.accountPipeline?.sessionBindingMaxEntries || SESSION_BINDING_MAX_ENTRIES, counters: { ...sessionBindingCounters } };
}
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
function clearRuleAccountState(id) {
  const state = getAccountState(id);
  if (!state) return;
  if (state.quotaDisposition || state.protectionMonthlyAt || state.protectionShortAt) META.accountStates[id] = { quotaDisposition: state.quotaDisposition, quotaDispositionAt: state.quotaDispositionAt, quotaRetryAt: state.quotaRetryAt, quotaReason: state.quotaReason, protectionMonthlyAt: state.protectionMonthlyAt || 0, protectionShortAt: state.protectionShortAt || 0, protectionShortWindows: state.protectionShortWindows || null, protectionRetryAt: state.protectionRetryAt || 0 };
  else delete META.accountStates[id];
}
function clearExpiredCooldowns() {
  let dirty = false;
  const now = Date.now();
  for (const [id, st] of Object.entries(META.accountStates || {})) {
    if (st && !st.hardQuarantined && !st.banned && st.cooldownUntil && st.cooldownUntil <= now) {
      clearRuleAccountState(id); dirty = true;
    }
  }
  if (dirty) try { saveMeta(); }
  catch (error) { console.error(`[账号] 过期冷却状态持久化失败：${safeReason(error.message)}`); }
}
function enabledAccounts({ excludeIds = new Set() } = {}) {
  clearExpiredCooldowns();
  return (config.accounts || []).filter((a) => {
    if (!a || !a.key || a.enabled === false || excludeIds.has(a.id)) return false;
    const st = getAccountState(a.id);
    if (st?.hardQuarantined || st?.banned || st?.protectionMonthlyAt || st?.protectionShortAt || (quotaProvisional.get(a.id)?.until || 0) > Date.now()) return false;
    if (st?.cooldownUntil && st.cooldownUntil > Date.now()) return false;
    if (st?.quotaDisposition && configuredCachePoolLowQuotaSize() > 0 && cachePoolEnabled()) return false;
    return true;
  });
}
function accountHasCapacity(a) {
  return !a?.maxConcurrent || (activeCounts.get(a.id) || 0) < a.maxConcurrent;
}
// lease 持有首个 RPM permit；后续每个真实 attempt 通过 takeRpmPermit() 独立预留。
function createLease(account, firstPermit) {
  let released = false, pending = firstPermit || null;
  return {
    account,
    takeRpmPermit() {
      if (released) return { ok: false, retryAt: null };
      if (pending) { const permit = pending; pending = null; return { ok: true, permit }; }
      return reserveRpmPermit(account);
    },
    release() {
      if (released) return;
      released = true;
      const permit = pending; pending = null;
      permit?.release();
      activeCounts.set(account.id, Math.max(0, (activeCounts.get(account.id) || 1) - 1));
      notifyCapacityWaiters();
    },
  };
}
// 固定准入顺序：hard eligibility（上层）→ maxConcurrent → RPM。并发失败绝不消费或预留 RPM。
function tryLeaseResult(a, now = Date.now()) {
  if (!a || getAccountState(a.id)?.protectionMonthlyAt || getAccountState(a.id)?.protectionShortAt || (quotaProvisional.get(a.id)?.until || 0) > now) return { lease: null, blockedBy: 'unavailable', retryAt: null };
  if (!accountHasCapacity(a)) return { lease: null, blockedBy: 'concurrency', retryAt: null };
  const reserved = reserveRpmPermit(a, now);
  if (!reserved.ok) return { lease: null, blockedBy: 'rpm', retryAt: reserved.retryAt ?? null };
  activeCounts.set(a.id, (activeCounts.get(a.id) || 0) + 1);
  return { lease: createLease(a, reserved.permit), blockedBy: null, retryAt: null };
}
function tryLease(a, now = Date.now()) { return tryLeaseResult(a, now).lease; }
async function waitForCapacity(ms) {
  if (ms <= 0) return;
  let wake;
  let timer;
  const capacity = new Promise((resolve) => { wake = resolve; waiters.add(resolve); });
  const timeout = new Promise((resolve) => { timer = setTimeout(resolve, ms); });
  try { await Promise.race([timeout, capacity]); }
  finally { clearTimeout(timer); waiters.delete(wake); }
}
// 复用现有全局 waiter 和 deadline；等待目标取"最早 RPM 窗口恢复"与剩余预算的较小值，不新增 refill 定时器。
async function waitForLease(accounts, waitMs) {
  const deadline = Date.now() + waitMs;
  let facts = selectionBlockFacts(accounts);
  while (true) {
    for (const account of accounts) {
      const result = tryLeaseResult(account);
      if (result.lease) return { lease: result.lease, blockedBy: null, retryAt: null };
    }
    facts = selectionBlockFacts(accounts);
    const wait = waitDurationForBlock(deadline, facts);
    if (wait <= 0) return { lease: null, ...facts };
    await waitForCapacity(wait);
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
  // Snapshot at admission, not at attempt settlement: concurrent quota refresh cannot
  // retroactively make a high/unknown lease eligible for the low-account hold.
  lease.quotaRole = cachePoolEnabled() && configuredCachePoolLowQuotaSize() > 0
    ? ({ warm: 'low', hot: 'high', unknown: 'unknown' }[quotaProjection(lease.account.id).pool] || null) : null;
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
    let waited = tryLeaseResult(primary);
    if (waited.lease) return selectionResult(waited.lease, mode, primary, 'sticky-primary', identity);
    waited = await waitForLease([primary], waitMs);
    if (waited.lease) return selectionResult(waited.lease, mode, primary, 'sticky-primary', identity);
    if (allowOverflow) {
      const overflow = await waitForLease(ranked.slice(1), 0);
      if (overflow.lease) return selectionResult(overflow.lease, mode, primary, 'sticky-overflow', identity, true);
    }
    return busyFailure(waited.blockedBy, waited.retryAt, mode, waitMs, 'all upstream accounts are busy');
  }
  if (mode === 'single') {
    const preferred = singlePreferred(list);
    const waited = await waitForLease([preferred], waitMs);
    if (waited.lease) return selectionResult(waited.lease, mode, preferred, 'single-selected', identity);
    return busyFailure(waited.blockedBy, waited.retryAt, mode, waitMs, 'upstream account is busy');
  }
  const reasons = { roundrobin: 'roundrobin-next', sticky: 'sticky-no-identity-roundrobin', 'least-connections': 'least-active', 'weighted-roundrobin': 'weighted-slot', 'priority-failover': 'priority-tier' };
  const deadline = Date.now() + waitMs;
  let facts = selectionBlockFacts(list);
  while (true) {
    const current = enabledAccounts({ excludeIds });
    if (!current.length) return { error: 'no available upstream account', strategy: mode };
    // 先跳过并发或 RPM 耗尽的候选；只有全部当前候选不可准入时才等待。
    const available = current.filter((account) => accountHasCapacity(account) && rpmAvailable(account));
    if (available.length) {
      const ranked = strategyRank(mode, available);
      const result = tryLeaseResult(ranked[0]);
      if (result.lease) return selectionResult(result.lease, mode, ranked[0], reasons[mode], identity);
    }
    facts = selectionBlockFacts(current);
    const wait = waitDurationForBlock(deadline, facts);
    if (wait <= 0) return busyFailure(facts.blockedBy, facts.retryAt, mode, waitMs, 'all upstream accounts are busy');
    await waitForCapacity(wait);
  }
}
function configuredCachePoolSize() { return Number.isInteger(config.accountPipeline?.cachePoolSize) ? config.accountPipeline.cachePoolSize : 0; }
function configuredCachePoolMaxSize() { return Number.isInteger(config.accountPipeline?.cachePoolMaxSize) ? config.accountPipeline.cachePoolMaxSize : configuredCachePoolSize(); }
function configuredCachePoolLowQuotaSize() { return Number.isInteger(config.accountPipeline?.cachePoolLowQuotaSize) ? config.accountPipeline.cachePoolLowQuotaSize : 0; }
function configuredCachePoolTargetSize() { return cachePoolTargetFor(config.accountPipeline); }
function stickyEffective() { return config.accountMode === 'sticky' || config.accountPipeline?.sticky === true; }
function cachePoolEnabled() { return configuredCachePoolSize() > 0 && stickyEffective(); }
function sessionBindingConfigured() { return stickyEffective() && config.accountPipeline?.healthSort === true; }
function sessionBindingEnabled(identity, ownerRequestId) { return sessionBindingConfigured() && !!identity?.fingerprint && !!ownerRequestId; }
function pipelineEnabled() { return cachePoolEnabled() || PIPELINE_KEYS.some((key) => config.accountPipeline?.[key]); }
function quotaRoutingEnabled() { return config.accountPipeline?.quotaPool === true || cachePoolEnabled(); }
function quotaProjection(accountId, now = Date.now()) {
  const disposition = getAccountState(accountId);
  const safeDisposition = { quotaDisposition: ['waiting-refresh','quota-exhausted'].includes(disposition?.quotaDisposition) ? disposition.quotaDisposition : null, quotaRetryAt: Number.isSafeInteger(disposition?.quotaRetryAt) && disposition.quotaRetryAt > now ? disposition.quotaRetryAt : null, protectionMonthlyAt: disposition?.protectionMonthlyAt || null, protectionShortWindows: disposition?.protectionShortWindows || null, protectionRetryAt: disposition?.protectionRetryAt > now ? disposition.protectionRetryAt : null, protectionPendingUntil: (quotaProvisional.get(accountId)?.until || 0) > now ? quotaProvisional.get(accountId).until : null, protectionPersistence: disposition?.protectionMonthlyAt ? (quotaProvisional.get(accountId)?.persistRetryAt !== undefined ? 'pending' : 'persisted') : null };
  const q = META.accountQuotas?.[accountId];
  const snapshot = q?.snapshot;
  const complete = snapshot && q.errorCategory == null && q.lastSuccessAt === snapshot.fetchedAt && q.lastAttemptAt <= q.lastSuccessAt && ['five_hour','weekly','monthly'].every((type) => snapshot.limits?.[type]) && snapshot.fetchedAt <= now && now - snapshot.fetchedAt <= QUOTA_STALE_MS;
  if (!complete) return { ...safeDisposition, status: 'unknown', pool: 'unknown', fetchedAt: snapshot?.fetchedAt || null, limits: snapshot?.limits || {}, errorCategory: q?.errorCategory || null };
  const maximum = Math.max(...Object.values(snapshot.limits).map((limit) => limit.percentUsed));
  return { ...safeDisposition, status: 'fresh', pool: maximum < 80 ? 'hot' : maximum < 95 ? 'warm' : 'reserve', fetchedAt: snapshot.fetchedAt, limits: snapshot.limits, errorCategory: null };
}
function statisticsQuotaProjection(account, now = Date.now()) {
  const quota = quotaProjection(account.id, now), state = META.accountQuotas?.[account.id];
  const reason = !account.key ? 'unconfigured' : account.enabled === false ? 'disabled' : null;
  const job = quotaJobs.get(account.id), activeJob = job && quotaJobAccount(job) && quotaJobHasOwner(job) ? job : null;
  let nextAttemptAt = null;
  if (!reason && state?.errorCategory && state.lastAttemptAt) nextAttemptAt = state.lastAttemptAt + quotaFailureDelay(account.id);
  else if (!reason) { const successAt = successfulQuotaTime(state, now); if (successAt) nextAttemptAt = quotaNextAttemptAt(account, successAt, now); else if (cachePoolEnabled() && configuredCachePoolLowQuotaSize() > 0 && getAccountState(account.id)?.quotaDisposition === 'waiting-refresh') nextAttemptAt = now; }
  return { ...quota, lastAttemptAt: state?.lastAttemptAt || null, lastSuccessAt: state?.lastSuccessAt || null, refresh: { eligible: reason === null, reason, state: activeJob ? (activeJob.state === 'running' ? 'fetching' : 'queued') : 'idle', nextAttemptAt } };
}
function quotaNextAttemptAt(account, successAt, now = Date.now()) {
  const disposition = getAccountState(account.id);
  if (disposition?.protectionShortAt) return disposition.protectionRetryAt > successAt ? disposition.protectionRetryAt : successAt + QUOTA_SUCCESS_MS;
  if (cachePoolEnabled() && configuredCachePoolLowQuotaSize() > 0) {
    if (disposition?.quotaDisposition === 'waiting-refresh') return successAt >= disposition.quotaDispositionAt ? successAt + QUOTA_SUCCESS_MS : now;
    if (disposition?.quotaDisposition === 'quota-exhausted' && disposition.quotaRetryAt > successAt) return disposition.quotaRetryAt;
  }
  return successAt + QUOTA_SUCCESS_MS;
}
function pipelineCandidates(list) {
  return list.map((account) => ({ account, health: successHealthProjection('account', account.id), quota: quotaProjection(account.id) }));
}
function buildPipelineGroups(list, identity, candidates = pipelineCandidates(list), { skipSticky = false } = {}) {
  const diagnostics = [];
  // Role-aware cache pools fix role priority before any optional quota/health/sticky step.
  // With low=0 this is the original single group and preserves legacy ranking.
  const roleAware = cachePoolEnabled() && configuredCachePoolLowQuotaSize() > 0;
  let groups = roleAware ? ['warm','hot','unknown'].map((role) => ({ candidates: candidates.filter((candidate) => candidate.quota.pool === role), quota: role, health: 'ordinary' })).filter((group) => group.candidates.length)
    : [{ candidates, quota: 'ordinary', health: 'ordinary' }];
  let stickyApplied = false;
  const applySticky = () => {
    if (!identity?.fingerprint) return;
    groups = groups.flatMap((group) => {
      const byId = new Map(group.candidates.map((candidate) => [candidate.account.id, candidate]));
      return hrwRank(group.candidates.map((candidate) => candidate.account), identity.fingerprint).map((account) => ({ ...group, candidates: [byId.get(account.id)] }));
    });
    stickyApplied = true;
  };
  for (const step of config.accountPipeline.order) {
    if (!config.accountPipeline[step]) continue;
    if (step === 'quotaPool') {
      if (!groups.some((group) => group.candidates.some((candidate) => candidate.quota.pool !== 'unknown'))) diagnostics.push('quota-all-unknown');
      else groups = groups.flatMap((group) => ['hot','warm','unknown','reserve'].map((pool) => ({ ...group, candidates: group.candidates.filter((candidate) => candidate.quota.pool === pool), quota: pool })).filter((next) => next.candidates.length));
    } else if (step === 'healthSort') {
      groups = groups.flatMap((group) => {
        const rates = [...new Set(group.candidates.map((candidate) => candidate.health.successRate).filter((rate) => rate !== null))].sort((a,b) => b-a);
        const rated = rates.map((rate) => ({ ...group, candidates: group.candidates.filter((candidate) => candidate.health.successRate === rate), health: 'rated' }));
        const unknown = group.candidates.filter((candidate) => candidate.health.successRate === null);
        return [...rated, ...(unknown.length ? [{ ...group, candidates: unknown, health: 'unknown' }] : [])];
      });
    } else if (step === 'sticky' && !skipSticky) applySticky();
  }
  if (!skipSticky && config.accountMode === 'sticky' && !config.accountPipeline.sticky) applySticky();
  return { groups: groups.map((group) => ({ accounts: group.candidates.map((candidate) => candidate.account), quota: group.quota, health: group.health })), diagnostics, stickyApplied };
}
function cachePoolMembership(list, candidates = null) {
  if (!cachePoolEnabled()) return null;
  candidates ||= pipelineCandidates(list);
  const size = configuredCachePoolSize(), maxSize = configuredCachePoolMaxSize(), targetSize = configuredCachePoolTargetSize();
  const stable = (left, right) => (left.account.priority || 100) - (right.account.priority || 100) || (left.account.id < right.account.id ? -1 : left.account.id > right.account.id ? 1 : 0);
  let eligibleCandidates = candidates.filter((candidate) => candidate.quota.pool !== 'reserve').sort(stable);
  let activeCandidates;
  if (configuredCachePoolLowQuotaSize() > 0) {
    const remaining = (candidate) => 100 - Math.max(...Object.values(candidate.quota.limits).map((limit) => limit.percentUsed));
    const low = eligibleCandidates.filter((candidate) => candidate.quota.pool === 'warm').sort((a,b) => remaining(a) - remaining(b) || stable(a,b));
    const high = eligibleCandidates.filter((candidate) => candidate.quota.pool === 'hot').sort((a,b) => remaining(b) - remaining(a) || stable(a,b));
    const unknown = eligibleCandidates.filter((candidate) => candidate.quota.pool === 'unknown');
    const lowTarget = configuredCachePoolLowQuotaSize();
    const selected = [...low.slice(0, lowTarget), ...high.slice(0, targetSize - lowTarget)];
    const chosen = new Set(selected.map((candidate) => candidate.account.id));
    // Known filler is real high/low, never relabelled to satisfy a target. Unknown is last.
    eligibleCandidates = [...selected, ...[...high, ...low, ...unknown].filter((candidate) => !chosen.has(candidate.account.id))];
    activeCandidates = eligibleCandidates.slice(0, targetSize);
  } else activeCandidates = eligibleCandidates.slice(0, targetSize);
  const activeIds = new Set(activeCandidates.map((candidate) => candidate.account.id));
  const actual = { high: activeCandidates.filter((c) => c.quota.pool === 'hot').length, low: activeCandidates.filter((c) => c.quota.pool === 'warm').length, unknown: activeCandidates.filter((c) => c.quota.pool === 'unknown').length };
  return { size, maxSize, lowSize: configuredCachePoolLowQuotaSize(), targetSize, actual, activeIds, activeCandidates, eligibleCandidates, candidates, byId: new Map(candidates.map((candidate) => [candidate.account.id, candidate])) };
}
function rpmProjection(account, now = Date.now()) {
  const limit = rpmLimit(account), state = rpmWindowState(account.id);
  // 先 prune 再读取，保证 used/reserved 与 retryAt 来自同一个已裁剪窗口。
  if (state) pruneRpmWindow(account.id, state, now);
  const used = state ? state.timestamps.length - state.head : 0;
  const reserved = state ? state.reservations : 0;
  const retryAt = limit ? rpmBlockedRetryAt(account, now).retryAt : null;
  return { limit, used: limit ? used : 0, reserved: limit ? reserved : 0, retryAt: limit && Number.isSafeInteger(retryAt) ? retryAt : null };
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
function cacheHealthLayer(health) {
  return health?.successRate === null ? 'unknown' : 'rated';
}
function cachePipelineFacts(plan, membership, candidate, tier, capacityFallback) {
  return {
    diagnostics: plan.diagnostics,
    selectedQuota: candidate?.quota.pool || 'unknown',
    selectedHealth: cacheHealthLayer(candidate?.health),
    capacityFallback,
    cachePoolSize: membership.size,
    cachePoolMaxSize: membership.maxSize,
    cachePoolLowQuotaSize: membership.lowSize,
    cachePoolTargetSize: membership.targetSize,
    cachePoolActual: membership.actual,
    selectedQuotaRole: membership.lowSize ? ({ warm: 'low', hot: 'high', unknown: 'unknown' }[candidate?.quota.pool] || null) : null,
    cachePoolTier: tier,
    cachePoolFallback: false,
  };
}
function rankPipelineGroup(group, plan, identity, mode) {
  if (plan.stickyApplied) return [...group.accounts];
  return cachePoolRank(group.accounts, identity, mode);
}
function tryPipelinePlanLease(plan, identity, mode, { excludeId = null } = {}) {
  // Only a sticky fingerprint gives the ranked head a stable meaning. Without one the
  // mode rank is per-request (round-robin/least-connections), so the capacity-eligible
  // account chosen here is the bounded "preferred" fact instead of a full account.
  const rankedPreferred = !!identity?.fingerprint;
  let preferred = null, capacityPreferred = null;
  for (let groupIndex = 0; groupIndex < plan.groups.length; groupIndex++) {
    const group = plan.groups[groupIndex], ranked = rankPipelineGroup(group, plan, identity, mode);
    preferred ||= ranked[0] || null;
    for (const account of ranked) {
      if (account.id === excludeId || !accountHasCapacity(account) || !rpmAvailable(account)) continue;
      capacityPreferred ||= account;
      const result = tryLeaseResult(account);
      if (result.lease) return { lease: result.lease, account, group, groupIndex, preferred: (rankedPreferred ? preferred : capacityPreferred) || account };
    }
  }
  return { lease: null, preferred };
}
function growCachePoolOne(membership) {
  // 只有"所有当前活跃 hard-eligible 候选都有有限 maxConcurrent、并发满载且 RPM 仍有容量"才是纯并发阻塞。
  // 任何 unlimited-concurrency、RPM 耗尽或混合阻塞都不允许扩容。
  const active = membership.activeCandidates.map((candidate) => candidate.account);
  if (!active.length) return null;
  for (const account of active) {
    if (!account.maxConcurrent) return null;
    if (accountHasCapacity(account)) return null;
    if (!rpmAvailable(account)) return null;
  }
  const current = configuredCachePoolTargetSize();
  if (current >= membership.maxSize || membership.eligibleCandidates.length <= membership.activeCandidates.length) return null;
  // 即将被晋升的第一个备用候选也必须仍有 RPM 名额：否则扩容只会持久化一个无法服务、且掩盖 RPM 阻塞原因的 target。
  const promoted = membership.eligibleCandidates.find((candidate) => !membership.activeIds.has(candidate.account.id));
  if (!promoted || !rpmAvailable(promoted.account)) return null;
  const growth = { previousActiveIds: new Set(membership.activeIds), targetSize: current + 1 };
  META.cachePoolTargetSize = growth.targetSize;
  try { saveMeta(); }
  catch (error) {
    META.cachePoolTargetSize = current;
    console.error(`[缓存池] 扩容目标持久化失败：${safeReason(error.message)}`);
    return null;
  }
  return growth;
}
function bindingSelectionContext(excludeIds) {
  const list = enabledAccounts({ excludeIds });
  const candidates = pipelineCandidates(list), membership = cachePoolMembership(list, candidates);
  const activeCandidates = membership ? membership.activeCandidates : candidates.filter((candidate) => candidate.quota.pool !== 'reserve');
  return { list, candidates, membership, activeCandidates, activeIds: new Set(activeCandidates.map((candidate) => candidate.account.id)) };
}
function growAndLeaseCachePoolOne(membership, identity, mode, excludeIds, { skipSticky = false } = {}) {
  const growth = growCachePoolOne(membership);
  if (!growth) return null;
  const context = bindingSelectionContext(excludeIds);
  const plan = buildPipelineGroups(context.activeCandidates.map((candidate) => candidate.account), identity, context.activeCandidates, { skipSticky });
  const candidate = context.activeCandidates.find((item) => !growth.previousActiveIds.has(item.account.id)) || null;
  let preferred = null, groupIndex = -1;
  for (let index = 0; index < plan.groups.length; index++) {
    const ranked = rankPipelineGroup(plan.groups[index], plan, identity, mode);
    preferred ||= ranked[0] || null;
    if (candidate && plan.groups[index].accounts.some((account) => account.id === candidate.account.id)) groupIndex = index;
  }
  const lease = candidate ? tryLease(candidate.account) : null;
  return { growth, context, plan, candidate, lease, preferred: preferred || candidate?.account || null, groupIndex };
}
function bindingPipelineFacts(plan, context, candidate, capacityFallback = false) {
  if (context.membership) return cachePipelineFacts(plan, context.membership, candidate, 'active', capacityFallback);
  const group = plan.groups.find((item) => item.accounts.some((account) => account.id === candidate?.account.id));
  return { diagnostics: plan.diagnostics, selectedQuota: candidate?.quota.pool || group?.quota || 'unknown', selectedHealth: cacheHealthLayer(candidate?.health), capacityFallback };
}
function attachBindingHit(result, identity, entry, bindingResult) {
  result.bindingSource = entry.source;
  result.bindingResult = bindingResult;
  result.bindingToken = sessionBindingHitToken(identity, entry);
  return result;
}
function attachBindingMiss(result, identity, ownerRequestId, missResult) {
  result.bindingSource = sessionBindingSource(identity);
  result.bindingResult = missResult;
  result.bindingToken = createProvisionalSessionBinding(identity, result.lease.account.id, ownerRequestId);
  return result;
}
async function acquireStatefulBindingAccountLease(identity, { excludeIds = new Set(), allowOverflow = true, ownerRequestId, bindingDeadline = null } = {}) {
  const mode = config.accountMode, waitMs = Math.min(30000, Math.max(0, Number(config.concurrencyWaitMs) || 0));
  const deadline = bindingDeadline ?? Date.now() + waitMs;
  let context = bindingSelectionContext(excludeIds);
  if (!context.list.length) return { error: 'no available upstream account', strategy: mode, bindingSource: sessionBindingSource(identity), bindingResult: 'miss' };
  let lookup = findSessionBinding(identity, context.activeIds);
  if (lookup.entry) {
    const entry = lookup.entry;
    while (true) {
      context = bindingSelectionContext(excludeIds);
      const current = sessionBindings.get(identity.fingerprint);
      if (!current || current.generation !== entry.generation || !context.activeIds.has(entry.accountId)) {
        if (current === entry) deleteSessionBinding(identity.fingerprint, entry);
        lookup = { entry: null, result: 'invalidated' };
        break;
      }
      const bound = context.activeCandidates.find((candidate) => candidate.account.id === entry.accountId);
      // Recheck after every capacity wake: a high binding cannot hide a newly
      // admissible low, and a blocked low cannot delay an admissible high.
      if (context.membership?.lowSize) {
        const lowAvailable = context.activeCandidates.some((candidate) => candidate.quota.pool === 'warm' && accountHasCapacity(candidate.account) && rpmAvailable(candidate.account));
        const otherAvailable = context.activeCandidates.some((candidate) => candidate.account.id !== entry.accountId && accountHasCapacity(candidate.account) && rpmAvailable(candidate.account));
        if (lowAvailable && bound?.quota.pool !== 'warm') {
          deleteSessionBinding(identity.fingerprint, entry);
          lookup = { entry: null, result: 'invalidated' };
          break;
        }
        if ((!accountHasCapacity(bound?.account) || !rpmAvailable(bound?.account)) && otherAvailable && allowOverflow) {
          const plan = buildPipelineGroups(context.activeCandidates.map((candidate) => candidate.account), identity, context.activeCandidates, { skipSticky: true });
          const fallback = tryPipelinePlanLease(plan, identity, mode, { excludeId: entry.accountId });
          if (fallback.lease) {
            incrementBindingCounter('temporaryOverflows');
            const reason = context.membership ? 'cache-pool-active-overflow' : 'pipeline-capacity-fallback';
            const result = selectionResult(fallback.lease, mode, bound.account, reason, identity, true);
            result.pipeline = bindingPipelineFacts(plan, context, context.activeCandidates.find((candidate) => candidate.account.id === fallback.account.id), true);
            return attachBindingHit(result, identity, entry, 'temporary-overflow');
          }
        }
      }
      const boundLease = tryLease(bound?.account);
      if (boundLease) {
        const reason = context.membership ? 'cache-pool-active' : 'pipeline-sticky-primary';
        const result = selectionResult(boundLease, mode, bound.account, reason, identity);
        const plan = buildPipelineGroups(context.activeCandidates.map((candidate) => candidate.account), identity, context.activeCandidates, { skipSticky: true });
        result.pipeline = bindingPipelineFacts(plan, context, bound);
        return attachBindingHit(result, identity, entry, lookup.result);
      }
      const boundFacts = selectionBlockFacts(bound ? [bound.account] : []);
      const wait = waitDurationForBlock(deadline, boundFacts);
      if (wait > 0) { await waitForCapacity(wait); continue; }
      const plan = buildPipelineGroups(context.activeCandidates.map((candidate) => candidate.account), identity, context.activeCandidates, { skipSticky: true });
      const fallback = allowOverflow ? tryPipelinePlanLease(plan, identity, mode, { excludeId: entry.accountId }) : { lease: null, preferred: bound.account };
      if (fallback.lease) {
        incrementBindingCounter('temporaryOverflows');
        const reason = context.membership ? 'cache-pool-active-overflow' : 'pipeline-capacity-fallback';
        const result = selectionResult(fallback.lease, mode, bound.account, reason, identity, true);
        result.pipeline = bindingPipelineFacts(plan, context, context.activeCandidates.find((candidate) => candidate.account.id === fallback.account.id), true);
        return attachBindingHit(result, identity, entry, 'temporary-overflow');
      }
      if (allowOverflow && context.membership) {
        const grown = growAndLeaseCachePoolOne(context.membership, identity, mode, excludeIds, { skipSticky: true });
        if (grown?.lease) {
          incrementBindingCounter('temporaryOverflows');
          const result = selectionResult(grown.lease, mode, bound.account, 'cache-pool-active-overflow', identity, true);
          result.pipeline = bindingPipelineFacts(grown.plan, grown.context, grown.candidate, true);
          return attachBindingHit(result, identity, entry, 'temporary-overflow');
        }
        if (grown) return busyFailure('concurrency', null, mode, waitMs, 'all upstream accounts are busy', { bindingSource: entry.source, bindingResult: lookup.result });
      }
      return busyFailure(boundFacts.blockedBy, boundFacts.retryAt, mode, waitMs, 'all upstream accounts are busy', { bindingSource: entry.source, bindingResult: lookup.result });
    }
  }
  while (true) {
    context = bindingSelectionContext(excludeIds);
    if (!context.list.length) return { error: 'no available upstream account', strategy: mode, bindingSource: sessionBindingSource(identity), bindingResult: lookup.result };
    const concurrentEntry = sessionBindings.get(identity.fingerprint);
    if (concurrentEntry && concurrentEntry.expiresAt > Date.now() && context.activeIds.has(concurrentEntry.accountId)) return acquireStatefulBindingAccountLease(identity, { excludeIds, allowOverflow, ownerRequestId, bindingDeadline: deadline });
    if (concurrentEntry) { deleteSessionBinding(identity.fingerprint, concurrentEntry); lookup = { entry: null, result: 'invalidated' }; }
    const plan = buildPipelineGroups(context.activeCandidates.map((candidate) => candidate.account), identity, context.activeCandidates, { skipSticky: true });
    const chosen = tryPipelinePlanLease(plan, identity, mode);
    if (chosen.lease) {
      const fallback = chosen.groupIndex > 0 || chosen.preferred?.id !== chosen.account.id;
      const reason = context.membership ? (fallback ? 'cache-pool-active-overflow' : 'cache-pool-active') : (fallback ? 'pipeline-capacity-fallback' : 'pipeline-sticky-primary');
      const result = selectionResult(chosen.lease, mode, chosen.preferred || chosen.account, reason, identity, fallback);
      result.pipeline = bindingPipelineFacts(plan, context, context.activeCandidates.find((candidate) => candidate.account.id === chosen.account.id), fallback);
      return attachBindingMiss(result, identity, ownerRequestId, lookup.result);
    }
    if (!context.activeCandidates.length) return busyFailure('concurrency', null, mode, waitMs, 'all upstream accounts are busy', { bindingSource: sessionBindingSource(identity), bindingResult: lookup.result });
    const missFacts = selectionBlockFacts(context.activeCandidates.map((candidate) => candidate.account));
    const wait = waitDurationForBlock(deadline, missFacts);
    if (wait > 0) { await waitForCapacity(wait); continue; }
    if (allowOverflow && context.membership) {
      const grown = growAndLeaseCachePoolOne(context.membership, identity, mode, excludeIds, { skipSticky: true });
      if (grown?.lease) {
        const fallback = grown.groupIndex > 0 || grown.preferred?.id !== grown.lease.account.id;
        const reason = fallback ? 'cache-pool-active-overflow' : 'cache-pool-active';
        const result = selectionResult(grown.lease, mode, grown.preferred, reason, identity, fallback);
        result.pipeline = bindingPipelineFacts(grown.plan, grown.context, grown.candidate, fallback);
        return attachBindingMiss(result, identity, ownerRequestId, lookup.result);
      }
      if (grown) return busyFailure('concurrency', null, mode, waitMs, 'all upstream accounts are busy', { bindingSource: sessionBindingSource(identity), bindingResult: lookup.result });
    }
    return busyFailure(missFacts.blockedBy, missFacts.retryAt, mode, waitMs, 'all upstream accounts are busy', { bindingSource: sessionBindingSource(identity), bindingResult: lookup.result });
  }
}
async function acquireCachePoolAccountLease(identity, { excludeIds = new Set(), allowOverflow = true } = {}) {
  const mode = config.accountMode, waitMs = Math.min(30000, Math.max(0, Number(config.concurrencyWaitMs) || 0)), deadline = Date.now() + waitMs;
  while (true) {
    const list = enabledAccounts({ excludeIds });
    if (!list.length) return { error: 'no available upstream account', strategy: mode };
    const candidates = pipelineCandidates(list), membership = cachePoolMembership(list, candidates);
    const activeCandidates = membership.activeCandidates, active = activeCandidates.map((candidate) => candidate.account);
    const plan = buildPipelineGroups(active, identity, activeCandidates);
    const chosen = tryPipelinePlanLease(plan, identity, mode);
    if (chosen.lease) {
      const overflow = !!chosen.preferred && chosen.account.id !== chosen.preferred.id;
      const result = selectionResult(chosen.lease, mode, chosen.preferred || chosen.account, overflow ? 'cache-pool-active-overflow' : 'cache-pool-active', identity, overflow);
      result.pipeline = cachePipelineFacts(plan, membership, membership.byId.get(chosen.account.id), 'active', overflow);
      return result;
    }
    if (!active.length) return busyFailure('concurrency', null, mode, waitMs, 'all upstream accounts are busy');
    const activeFacts = selectionBlockFacts(active);
    const wait = waitDurationForBlock(deadline, activeFacts);
    if (wait > 0) { await waitForCapacity(wait); continue; }
    if (allowOverflow) {
      const grown = growAndLeaseCachePoolOne(membership, identity, mode, excludeIds);
      if (grown?.lease) {
        const overflow = !!grown.preferred && grown.preferred.id !== grown.lease.account.id;
        const result = selectionResult(grown.lease, mode, grown.preferred, overflow ? 'cache-pool-active-overflow' : 'cache-pool-active', identity, overflow);
        result.pipeline = cachePipelineFacts(grown.plan, grown.context.membership, grown.candidate, 'active', overflow);
        return result;
      }
      if (grown) return busyFailure('concurrency', null, mode, waitMs, 'all upstream accounts are busy');
    }
    return busyFailure(activeFacts.blockedBy, activeFacts.retryAt, mode, waitMs, 'all upstream accounts are busy');
  }
}
async function acquirePipelineAccountLease(identity, options = {}) {
  if (sessionBindingEnabled(identity, options.ownerRequestId)) return acquireStatefulBindingAccountLease(identity, options);
  if (cachePoolEnabled()) return acquireCachePoolAccountLease(identity, options);
  const { excludeIds = new Set(), allowOverflow = true } = options;
  const mode = config.accountMode, waitMs = Math.min(30000, Math.max(0, Number(config.concurrencyWaitMs) || 0)), deadline = Date.now() + waitMs;
  while (true) {
    const list = enabledAccounts({ excludeIds });
    if (!list.length) return { error: 'no available upstream account', strategy: mode };
    const plan = buildPipelineGroups(list, identity);
    const primary = plan.stickyApplied ? plan.groups[0].accounts[0] : null;
    if (primary) {
      const result = tryLeaseResult(primary);
      if (result.lease) { const selected = selectionResult(result.lease, mode, primary, 'pipeline-sticky-primary', identity); selected.pipeline = { ...plan, groups: undefined, selectedQuota: plan.groups[0].quota, selectedHealth: plan.groups[0].health }; return selected; }
      if (mode === 'single' || mode === 'sticky') {
        const primaryFacts = selectionBlockFacts([primary]);
        const wait = waitDurationForBlock(deadline, primaryFacts);
        if (wait > 0) { await waitForCapacity(wait); continue; }
        if (mode === 'single') return busyFailure(primaryFacts.blockedBy, primaryFacts.retryAt, mode, waitMs, 'upstream account is busy');
        if (!allowOverflow) return busyFailure(primaryFacts.blockedBy, primaryFacts.retryAt, mode, waitMs, 'all upstream accounts are busy');
      }
    }
    if (mode === 'single' && !primary) {
      const chosen = singlePreferred(plan.groups[0].accounts) || plan.groups[0].accounts[0];
      const chosenLease = tryLease(chosen);
      if (chosenLease) return { ...selectionResult(chosenLease, mode, chosen, 'single-selected', identity), pipeline: { diagnostics: plan.diagnostics, selectedQuota: plan.groups[0].quota, selectedHealth: plan.groups[0].health } };
      const chosenFacts = selectionBlockFacts(chosen ? [chosen] : []);
      const wait = waitDurationForBlock(deadline, chosenFacts);
      if (wait > 0) { await waitForCapacity(wait); continue; }
      return busyFailure(chosenFacts.blockedBy, chosenFacts.retryAt, mode, waitMs, 'upstream account is busy');
    }
    for (let groupIndex = 0; groupIndex < plan.groups.length; groupIndex++) {
      const group = plan.groups[groupIndex], available = group.accounts.filter((account) => account.id !== primary?.id && accountHasCapacity(account) && rpmAvailable(account));
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
    const planFacts = selectionBlockFacts(plan.groups.flatMap((group) => group.accounts));
    const wait = waitDurationForBlock(deadline, planFacts);
    if (wait <= 0) return busyFailure(planFacts.blockedBy, planFacts.retryAt, mode, waitMs, 'all upstream accounts are busy');
    await waitForCapacity(wait);
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
    const result = tryLeaseResult(account);
    return result.lease ? { lease: result.lease } : { status: 429, error: blockedByMessage(result.blockedBy, 'selected account is busy'), retryAfter: blockedByRetryAfter(result.blockedBy, result.retryAt, config.concurrencyWaitMs), blockedBy: result.blockedBy };
  }
  const selected = await acquireAccountLease({ source, keyType: 'none', confidence: 'none', fingerprint: hmacHex(`management\0${source}`) });
  return selected.lease ? { lease: selected.lease } : { status: enabledAccounts().length ? 429 : 503, error: selected.error, retryAfter: selected.retryAfter, blockedBy: selected.blockedBy || null };
}
const chatHeaders = (key) => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${key}`,
});

// Downstream client credentials never grant management access. Admin state is independent of config.json.
let PROXY_KEY = config.proxyKey || '';
function authOK(req) {
  if (!PROXY_KEY) return true;
  const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  const key = String(req.headers['x-admin-key'] || '').trim(); // legacy client header, model routes only
  return bearer === PROXY_KEY || key === PROXY_KEY;
}
function unauthorized(res) {
  return sendJSON(res, 401, { error: { message: 'unauthorized', type: 'auth_error' } });
}
const ADMIN_COOKIE = 'cps_admin';
const testAdminTTL = process.env.NODE_ENV === 'test' ? Number(process.env.CLINE_PASS_TEST_ADMIN_TTL_MS) : NaN;
const ADMIN_TTL_MS = Number.isSafeInteger(testAdminTTL) && testAdminTTL >= 50 && testAdminTTL <= 60_000 ? testAdminTTL : 8 * 60 * 60 * 1000;
const adminSessions = new Map();
const adminFailures = new Map();
function adminVerifier(password) {
  const salt = crypto.randomBytes(32).toString('hex');
  return { salt, hash: crypto.scryptSync(password, Buffer.from(salt, 'hex'), 64).toString('hex') };
}
let adminState = loadedAdminState === MISSING_ADMIN ? null : loadedAdminState;
// Explicit operator opt-in prevents silent re-derivation if the state file is lost.
if (!adminState && process.env.CLINE_PASS_ADMIN_BOOTSTRAP === '1') {
  const initial = PROXY_KEY || process.env.CLINE_PASS_ADMIN_INITIAL_PASSWORD;
  if (!initial || initial.length > 1024 || !process.env.CLINE_PASS_ADMIN_INIT_CODE || process.env.CLINE_PASS_ADMIN_INIT_CODE.length < 16 ||
      process.env.CLINE_PASS_ADMIN_INIT_CODE.length > 1024 || process.env.CLINE_PASS_ADMIN_INIT_CODE === initial)
    throw new Error('admin bootstrap requires a non-empty initial password and independent initialization code');
  adminState = { version: 1, initialized: false, ...adminVerifier(initial) };
  atomicWriteJson(ADMIN_PATH, adminState);
}
function adminPasswordOK(password) {
  if (!adminState || typeof password !== 'string' || password.length > 1024) return false;
  const hash = crypto.scryptSync(password, Buffer.from(adminState.salt, 'hex'), 64);
  return crypto.timingSafeEqual(hash, Buffer.from(adminState.hash, 'hex'));
}
if (adminState?.initialized && PROXY_KEY && adminPasswordOK(PROXY_KEY))
  throw new Error('client key must differ from the administrator password');
function adminCodeOK(code) {
  const expected = process.env.CLINE_PASS_ADMIN_INIT_CODE;
  if (!expected || typeof code !== 'string' || code.length > 1024) return false;
  const a = crypto.createHash('sha256').update(code).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}
function adminSession(req) {
  const cookies = String(req.headers.cookie || '').split(';').map((s) => s.trim());
  const values = cookies.filter((s) => s.startsWith(`${ADMIN_COOKIE}=`));
  if (values.length !== 1) return null;
  const token = values[0].slice(ADMIN_COOKIE.length + 1);
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  const session = adminSessions.get(token);
  if (session && session.expires <= Date.now()) { adminSessions.delete(token); return null; }
  return session ? { token, ...session } : null;
}
function adminOriginOK(req) {
  if (req.headers['sec-fetch-site'] === 'cross-site' || req.headers['sec-fetch-site'] === 'same-site') return false;
  if (!req.headers.origin) return true; // scripts still need cookie and CSRF token
  try {
    const origin = new URL(String(req.headers.origin));
    const host = String(req.headers.host || '');
    const expected = config.publicBaseUrl ? new URL(config.publicBaseUrl).origin : `${req.socket.encrypted ? 'https' : 'http'}://${host}`;
    return origin.origin === expected && origin.host === host;
  } catch { return false; }
}
function adminTransportOK(req) {
  if (req.socket.encrypted) return true;
  const address = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  const loopback = ['127.0.0.1', '::1'].includes(address);
  if (loopback && /^((127\.0\.0\.1)|(localhost)|(\[::1\]))(:\d+)?$/.test(String(req.headers.host || ''))) return true;
  // Private network peers can spoof X-Forwarded-Proto. Only an explicitly provisioned
  // reverse proxy may attest HTTPS; it must replace (never forward) the client header.
  const privateProxy = loopback || /^10\./.test(address) || /^192\.168\./.test(address) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(address) || /^f[cd][0-9a-f:]+$/i.test(address);
  const expected = process.env.CLINE_PASS_ADMIN_PROXY_TOKEN;
  const supplied = req.headers['x-cline-pass-proxy-token'];
  return privateProxy && req.headers['x-forwarded-proto'] === 'https' && /^https:\/\//i.test(config.publicBaseUrl || '') &&
    typeof expected === 'string' && /^[a-f0-9]{64}$/.test(expected) && typeof supplied === 'string' && /^[a-f0-9]{64}$/.test(supplied) &&
    crypto.timingSafeEqual(Buffer.from(supplied, 'hex'), Buffer.from(expected, 'hex'));
}
function adminCookie(res, req, token = '', clear = false) {
  res.setHeader('Set-Cookie', `${ADMIN_COOKIE}=${token}; Path=/api; HttpOnly; SameSite=Strict; ${req.socket.encrypted || /^https:\/\//i.test(config.publicBaseUrl || '') ? 'Secure; ' : ''}Max-Age=${clear ? 0 : Math.ceil(ADMIN_TTL_MS / 1000)}`);
}
function issueAdminSession(req, res, pending = false) {
  for (const [key, value] of adminSessions) if (value.expires <= Date.now()) adminSessions.delete(key);
  if (adminSessions.size >= 128) adminSessions.delete(adminSessions.keys().next().value);
  const token = crypto.randomBytes(32).toString('hex');
  const csrf = crypto.randomBytes(32).toString('hex');
  adminSessions.set(token, { csrf, pending, expires: Date.now() + ADMIN_TTL_MS });
  adminCookie(res, req, token);
  return sendJSON(res, 200, { ok: true, pending, csrf });
}
function adminThrottle(req, success) {
  const ip = req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const entry = adminFailures.get(ip) || { count: 0, until: 0 };
  if (success) adminFailures.delete(ip);
  else { entry.count = entry.until > now ? entry.count + 1 : 1; entry.until = now + 60_000; adminFailures.set(ip, entry); }
  if (adminFailures.size > 1024) adminFailures.delete(adminFailures.keys().next().value);
  return !success && entry.count >= 5;
}
async function adminAuthRoute(req, res, p) {
  if (!adminTransportOK(req) || !adminOriginOK(req)) return unauthorized(res);
  const session = adminSession(req);
  if (p === '/api/auth/state' && req.method === 'GET') return sendJSON(res, 200, { initialized: adminState?.initialized === true, available: !!adminState });
  if (p === '/api/auth/session' && req.method === 'GET')
    return session ? sendJSON(res, 200, { ok: true, pending: session.pending, csrf: session.csrf }) : unauthorized(res);
  if (req.method !== 'POST' || !['/api/auth/bootstrap', '/api/auth/login', '/api/auth/password', '/api/auth/logout'].includes(p))
    return sendJSON(res, 404, { error: { message: 'no route' } });
  if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type'] || ''))) return sendJSON(res, 415, { error: { message: 'JSON required' } });
  if (p === '/api/auth/bootstrap' || p === '/api/auth/login') {
    const ip = req.socket.remoteAddress || 'unknown';
    const failure = adminFailures.get(ip);
    if (failure && failure.count >= 5 && failure.until > Date.now()) return sendJSON(res, 429, { error: { message: 'try again later' } });
    const body = await readJsonBody(req, 4096);
    // Concurrent requests can pass the first check before their bodies arrive.
    // Check again before the expensive password verifier is invoked.
    const currentFailure = adminFailures.get(ip);
    if (currentFailure && currentFailure.count >= 5 && currentFailure.until > Date.now()) return sendJSON(res, 429, { error: { message: 'try again later' } });
    const valid = isPlainObject(body) && Object.keys(body).sort().join(',') === (p.endsWith('bootstrap') ? 'code,password' : 'password') &&
      adminState && adminState.initialized === !p.endsWith('bootstrap') && adminPasswordOK(body.password) &&
      (p.endsWith('bootstrap') ? adminCodeOK(body.code) : true);
    adminThrottle(req, valid);
    if (!valid) return unauthorized(res);
    return issueAdminSession(req, res, !adminState.initialized);
  }
  if (!session || session.csrf !== req.headers['x-csrf-token']) return unauthorized(res);
  const body = await readJsonBody(req, 4096);
  if (p === '/api/auth/logout') {
    if (!isPlainObject(body) || Object.keys(body).length) return sendJSON(res, 400, { error: { message: 'invalid body' } });
    adminSessions.delete(session.token); adminCookie(res, req, '', true);
    return sendJSON(res, 200, { ok: true });
  }
  if (session.pending !== !adminState?.initialized || !isPlainObject(body) || Object.keys(body).sort().join(',') !== (session.pending ? 'newPassword' : 'currentPassword,newPassword') ||
      typeof body.newPassword !== 'string' || body.newPassword.length < 12 || body.newPassword.length > 1024 ||
      body.newPassword === PROXY_KEY || adminPasswordOK(body.newPassword) ||
      (!session.pending && !adminPasswordOK(body.currentPassword))) return sendJSON(res, 400, { error: { message: 'invalid password change' } });
  const candidate = { version: 1, initialized: true, ...adminVerifier(body.newPassword) };
  atomicWriteJson(ADMIN_PATH, candidate); adminState = candidate; adminSessions.clear();
  adminCookie(res, req, '', true);
  return sendJSON(res, 200, { ok: true });
}
function publicProxyBase() {
  return config.publicBaseUrl
    ? `${config.publicBaseUrl.replace(/\/+$/, '')}/v1`
    : `http://127.0.0.1:${config.port}/v1`;
}

const OR_API = 'https://openrouter.ai/api/v1';

async function accountFetchJSON(url, opts = {}, timeoutMs = 60000, account = null) {
  const headers = account ? responseHeadersFor(account, opts.headers || {}) : (opts.headers || {});
  // 管理面 chat attempt 一旦预留 permit 就绝不能泄漏：已发出的请求由 clineRequest 在提交后保持不变，
  // 这里只兜底“尚未进入 transport 的异常”，release 幂等。
  try {
    const result = await clineRequestJSON(url, { headers, body: opts.body || '', timeoutMs, account, attemptMeta: opts.attemptMeta || null, permit: opts.permit || null });
    let json = null; try { json = JSON.parse(result.text); } catch { json = { raw: result.text }; }
    return { status: result.status, json };
  } catch (error) {
    try { opts.permit?.release(); } catch {}
    throw error;
  }
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
// 管理面 chat 调用：每个真实 native 请求独立 claim 一个 permit；无 permit 时明确跳过而不是静默发出。
function claimManagementPermit(lease) { return lease ? lease.takeRpmPermit() : { ok: true, permit: null }; }
async function harvestAvailableProviders(modelId, pipeline, acc, lease = null) {
  const claim = claimManagementPermit(lease);
  if (!claim.ok) return null;
  const base = { model: modelId, messages: [{ role: 'user', content: 'hi' }], max_tokens: 16 };
  const body = pipeline === 'planner'
    ? { ...base, providerOptions: { gateway: { only: ['__probe__'] } } }
    : { ...base, provider: { only: ['__probe__'] } };
  const { json } = await accountFetchJSON(`${config.upstreamBase}/chat/completions`, { headers: chatHeaders(acc.key), body: JSON.stringify(body), attemptMeta: { model: modelId, provider: ['__probe__'] }, permit: claim.permit }, 60000, acc);
  return providersFromError(upstreamErrorOf(json));
}
function parseTier0(plan) {
  const m = /([\w-]+) won tier 0 over ([^."]+)/.exec(plan || '');
  if (!m) return [];
  return [...new Set([m[1], ...m[2].split(/,\s*|\s+and\s+/).map((s) => s.trim()).filter(Boolean)])];
}

async function probeModel(modelId, acc, lease = null) {
  const t0 = Date.now();
  const claim = claimManagementPermit(lease);
  if (!claim.ok) return { ok: false, localRpm: true, error: 'account rpm limit reached' };
  const body = { model: modelId, messages: [{ role: 'user', content: 'Reply with the word OK' }], max_tokens: 256 };
  const { json } = await accountFetchJSON(`${config.upstreamBase}/chat/completions`, {
    headers: chatHeaders(acc.key), body: JSON.stringify(body), attemptMeta: { model: modelId, provider: [] }, permit: claim.permit,
  }, 180000, acc);
  const ms = Date.now() - t0;
  if (json?.error && !json?.data) {
    return { ok: false, error: safeReason(typeof json.error === 'string' ? json.error : JSON.stringify(json.error)) };
  }
  const r = parseRouting(json);
  let harvest = null;
  if (r.pipeline) harvest = await harvestAvailableProviders(modelId, r.pipeline, acc, lease);
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
function projectModelMeta(meta, modelId) {
  if (!isPlainObject(meta)) return null;
  const upstreamStatus = {};
  for (const [provider, state] of Object.entries(isPlainObject(meta.upstreamStatus) ? meta.upstreamStatus : {})) {
    if (/^[a-z0-9][a-z0-9._/-]{0,199}$/i.test(provider)) upstreamStatus[provider] = { ...normalizeProviderHealthState(state), success: successHealthProjection('provider-model', modelId, provider) };
  }
  return { ...meta, upstreamStatus };
}
function updateProviderHealth(modelId, upstream, { success = false, classification = null, note = '' } = {}, now = Date.now()) {
  if (!upstream) return 'none';
  const previous = providerHealthState(modelId, upstream);
  if (success) {
    (META.models[modelId].upstreamStatus ||= {})[upstream] = {
      ...previous, status: 'ok', checkedAt: now, lastSuccessAt: now,
      consecutiveFailures: 0, failureClass: null, note: boundedProviderNote(note || 'success'),
    };
    return 'success';
  }
  const scope = classification?.scope, failureClass = classification?.failureClass;
  if (scope !== 'provider' || !['rate_limit','server','network','timeout','unsupported'].includes(failureClass)) return 'none';
  const status = failureClass === 'rate_limit' ? 'limited' : failureClass === 'unsupported' ? 'bad' : 'degraded';
  (META.models[modelId].upstreamStatus ||= {})[upstream] = {
    ...previous, status, checkedAt: now, lastFailureAt: now,
    consecutiveFailures: Math.min(PROVIDER_FAILURE_COUNT_MAX, previous.consecutiveFailures + 1),
    failureClass, note: boundedProviderNote(note || `${classification.evidence || 'failure'}:${failureClass}`),
  };
  return 'degrade';
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
async function validateUpstreams(modelId, acc, lease = null) {
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
      // 并发 batch 共享一个 lease，但每个 native call 原子 claim 自己的 permit。
      const claim = claimManagementPermit(lease);
      if (!claim.ok) { results[slug] = { status: 'unknown', localRpm: true, ms: 0, note: 'local account rpm limit' }; return; }
      let response;
      try {
        response = await accountFetchJSON(`${config.upstreamBase}/chat/completions`, { headers: chatHeaders(acc.key), body: JSON.stringify(body), attemptMeta: { model: modelId, provider: [slug] }, permit: claim.permit }, 60000, acc);
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
      } else if (json?.data?.choices || json?.choices) {
        status = 'ok';
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
function addSuccessCounter(health, key, amount = 1) {
  if (!amount || health[key] === null) return;
  if (!Number.isSafeInteger(amount) || amount < 0 || health[key] > Number.MAX_SAFE_INTEGER - amount) {
    health[key] = null;
    if (!health.overflowFields.includes(key)) health.overflowFields.push(key);
  } else health[key] += amount;
}
function mergeSuccessHealth(target, delta) {
  for (const key of SUCCESS_FIELDS) if (delta[key] === null) { target[key] = null; if (!target.overflowFields.includes(key)) target.overflowFields.push(key); } else addSuccessCounter(target, key, delta[key]);
}
function successHealthCell(map, key) {
  if (!Object.hasOwn(map, key)) Object.defineProperty(map, key, { value: emptySuccessHealth(), enumerable: true, configurable: true, writable: true });
  return map[key];
}
function providerSuccessHealthCell(bucket, modelId, provider) {
  const byModel = statisticCell(bucket.providerHealth, modelId, () => ({}));
  return successHealthCell(byModel, provider);
}
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
function markStatisticsIncomplete(coverage,kind,model,minute) {
  const map = coverage[`${kind}IncompleteAt`];
  if (Object.hasOwn(map,model) || Object.keys(map).length < MAX_USAGE_MINUTE_CELLS) map[model] = Math.max(map[model] || 0,minute);
  else coverage[`${kind}GlobalIncompleteAt`] = Math.max(coverage[`${kind}GlobalIncompleteAt`],minute);
}
function pruneStatistics(now = Date.now()) {
  const stats = META.statistics, coverage = stats.recentCoverage, minMinute = Math.floor(now / 60000) - 1439;
  stats.minuteBuckets = stats.minuteBuckets.filter((bucket) => bucket.minute >= minMinute);
  for (const field of ['accountIncompleteAt','accountHealthIncompleteAt','modelIncompleteAt','usageIncompleteAt','valuationIncompleteAt']) for (const [id, minute] of Object.entries(coverage[field] || {})) if (minute < minMinute) delete coverage[field][id];
  for (const field of ['usageGlobalIncompleteAt','valuationGlobalIncompleteAt']) if (coverage[field] < minMinute) coverage[field] = 0;
  for (const [modelId, providers] of Object.entries(coverage.providerHealthIncompleteAt || {})) {
    for (const [provider, minute] of Object.entries(providers)) if (minute < minMinute) delete providers[provider];
    if (!Object.keys(providers).length) delete coverage.providerHealthIncompleteAt[modelId];
  }
  let accountCells = stats.minuteBuckets.reduce((sum,bucket) => sum + new Set([...Object.keys(bucket.accounts),...Object.keys(bucket.health),...Object.keys(bucket.accountHealth)]).size, 0);
  for (const bucket of stats.minuteBuckets) {
    if (accountCells <= MAX_ACCOUNT_MINUTE_CELLS) break;
    for (const id of new Set([...Object.keys(bucket.accounts),...Object.keys(bucket.health),...Object.keys(bucket.accountHealth)])) {
      if (accountCells-- <= MAX_ACCOUNT_MINUTE_CELLS) break;
      delete bucket.accounts[id]; delete bucket.health[id]; delete bucket.accountHealth[id]; coverage.droppedAccountMinuteCells++;
      coverage.accountIncompleteAt[id] = Math.max(coverage.accountIncompleteAt[id] || 0, bucket.minute);
      coverage.accountHealthIncompleteAt[id] = Math.max(coverage.accountHealthIncompleteAt[id] || 0, bucket.minute);
    }
  }
  let modelCells = stats.minuteBuckets.reduce((sum,bucket) => sum + Object.keys(bucket.models).length, 0);
  for (const bucket of stats.minuteBuckets) {
    if (modelCells <= MAX_MODEL_MINUTE_CELLS) break;
    for (const id of Object.keys(bucket.models)) {
      if (modelCells-- <= MAX_MODEL_MINUTE_CELLS) break;
      delete bucket.models[id]; delete bucket.modelFinal[id]; coverage.droppedModelMinuteCells++;
      coverage.modelIncompleteAt[id] = Math.max(Object.hasOwn(coverage.modelIncompleteAt,id) ? coverage.modelIncompleteAt[id] : 0, bucket.minute);
    }
  }
  let providerCells = stats.minuteBuckets.reduce((sum,bucket) => sum + Object.values(bucket.providerHealth).reduce((count, providers) => count + Object.keys(providers).length, 0), 0);
  providerPrune: for (const bucket of stats.minuteBuckets) for (const [modelId, providers] of Object.entries(bucket.providerHealth)) for (const provider of Object.keys(providers)) {
    if (providerCells <= MAX_PROVIDER_HEALTH_MINUTE_CELLS) break providerPrune;
    providerCells--;
    delete providers[provider]; coverage.droppedProviderHealthMinuteCells++;
    const incomplete = statisticCell(coverage.providerHealthIncompleteAt,modelId,()=>({}));
    incomplete[provider] = Math.max(Object.hasOwn(incomplete,provider) ? incomplete[provider] : 0, bucket.minute);
    if (!Object.keys(providers).length) delete bucket.providerHealth[modelId];
  }
  const usageCount = () => stats.minuteBuckets.reduce((n,b) => n + Object.values(b.providerUsage).reduce((sum,p) => sum + Object.keys(p).length,0),0);
  let usageCells = usageCount();
  usagePrune: for (const bucket of stats.minuteBuckets) for (const [model, providers] of Object.entries(bucket.providerUsage)) for (const provider of Object.keys(providers)) {
    if (usageCells <= MAX_USAGE_MINUTE_CELLS) break usagePrune;
    usageCells--; delete providers[provider]; coverage.droppedUsageMinuteCells++;
    markStatisticsIncomplete(coverage,'usage',model,bucket.minute);
    if (!Object.keys(providers).length) delete bucket.providerUsage[model];
  }
  let valuationCells = stats.minuteBuckets.reduce((n,b) => n + Object.values(b.valuation).reduce((sum,p) => sum + Object.values(p).reduce((v,versions) => v + Object.keys(versions).length,0),0),0);
  valuationPrune: for (const bucket of stats.minuteBuckets) for (const [model, providers] of Object.entries(bucket.valuation)) for (const [provider, versions] of Object.entries(providers)) for (const version of Object.keys(versions)) {
    if (valuationCells <= MAX_VALUATION_MINUTE_CELLS) break valuationPrune;
    valuationCells--; delete versions[version]; coverage.droppedValuationMinuteCells++;
    markStatisticsIncomplete(coverage,'valuation',model,bucket.minute);
    if (!Object.keys(versions).length) delete providers[provider];
    if (!Object.keys(providers).length) delete bucket.valuation[model];
  }
  // Historical price versions are metadata only; retain versions referenced by a cell.
  for (const version of Object.keys(stats.priceVersions)) if (version !== REFERENCE_PRICE.version && !stats.minuteBuckets.some((bucket) => Object.values(bucket.valuation).some((providers) => Object.values(providers).some((versions) => Object.hasOwn(versions,version))))) delete stats.priceVersions[version];
}
function addReferenceValuation(bucket, modelId, provider, usage) {
  const value = referenceValue(modelId, usage);
  if (!value) return;
  const stats = META.statistics;
  if (!Object.hasOwn(stats.priceVersions, REFERENCE_PRICE.version)) {
    if (Object.keys(stats.priceVersions).length >= MAX_PRICE_VERSIONS) {
      const oldest = Object.keys(stats.priceVersions)[0];
      for (const cell of stats.minuteBuckets) for (const [model, providers] of Object.entries(cell.valuation)) for (const [name, versions] of Object.entries(providers)) if (Object.hasOwn(versions,oldest)) {
        delete versions[oldest]; stats.recentCoverage.droppedValuationMinuteCells++;
        markStatisticsIncomplete(stats.recentCoverage,'valuation',model,cell.minute);
        if (!Object.keys(versions).length) delete providers[name];
        if (!Object.keys(providers).length) delete cell.valuation[model];
      }
      delete stats.priceVersions[oldest];
    }
    stats.priceVersions[REFERENCE_PRICE.version] = structuredClone(REFERENCE_PRICE);
  }
  const versions = statisticCell(statisticCell(bucket.valuation,modelId,()=>({})),provider,()=>({}));
  const cell = statisticCell(versions,REFERENCE_PRICE.version,emptyValuation);
  addCounter(cell,'pricedRequests');
  for (const field of ['lowPicoUsd','highPicoUsd']) addCounter(cell,field,value[field] === null ? Number.MAX_SAFE_INTEGER + 1 : value[field]);
}
function commitStatistics({ ts = Date.now(), modelId = null, finalProvider = null, globalError = false, usage = null, segments = [], clientDisconnect = false, affinityConfidence = 'none' }) {
  const stats = META.statistics; pruneStatistics(ts);
  const minute = Math.floor(ts / 60000);
  let bucket = stats.minuteBuckets.at(-1);
  if (!bucket || bucket.minute !== minute) { bucket = { minute, global: emptyAggregate(), accounts: {}, health: {}, models: {}, accountHealth: {}, providerHealth: {}, modelFinal: {}, providerUsage: {}, valuation: {} }; stats.minuteBuckets.push(bucket); }
  const globalDelta = emptyAggregate(); addCounter(globalDelta, 'requests'); globalDelta.lastUsedAt = ts;
  if (globalError) { addCounter(globalDelta, 'errors'); globalDelta.lastErrorAt = ts; }
  const globalTrace = segments.flatMap((segment) => segment.trace || []);
  addUsage(globalDelta, usage); addRoutingSignals(globalDelta, affinityConfidence, globalTrace); mergeAggregate(stats.lifetime.global, globalDelta); mergeAggregate(bucket.global, globalDelta);
  if (validStatisticModelId(modelId)) {
    mergeAggregate(aggregateCell(bucket.models, modelId), globalDelta);
    const succeeded = !globalError && !clientDisconnect && segments.some((s) => s.success);
    if (!Object.hasOwn(bucket.modelFinal,modelId)) Object.defineProperty(bucket.modelFinal,modelId,{ value: emptyFinal(), enumerable: true, configurable: true, writable: true });
    addCounter(bucket.modelFinal[modelId],clientDisconnect ? 'cancelled' : succeeded ? 'successes' : 'failures');
    // Only the final successful attempt owns usage. Named attribution needs both
    // an observed final Provider and a matching real named successful attempt.
    if (succeeded) {
      const last = globalTrace.at(-1);
      const provider = last?.healthAction === 'success' && last.upstream && last.upstream === finalProvider ? last.upstream : '';
      const byModel = statisticCell(bucket.providerUsage,modelId,()=>({}));
      const delta = emptyAggregate(); addCounter(delta,'requests'); addUsage(delta,usage);
      mergeAggregate(aggregateCell(byModel,provider),delta);
      addReferenceValuation(bucket,modelId,provider,usage);
    }
  }
  const currentIds = new Set(config.accounts.map((account) => account.id));
  for (const segment of new Map(segments.filter((s) => currentIds.has(s.accountId)).map((s) => [s.accountId,s])).values()) {
    const delta = emptyAggregate(); addCounter(delta, 'requests'); delta.lastUsedAt = ts;
    if (segment.error) { addCounter(delta, 'errors'); delta.lastErrorAt = ts; }
    if (segment.usage) addUsage(delta, segment.usage);
    addRoutingSignals(delta, affinityConfidence, segment.trace || []);
    mergeAggregate(aggregateCell(stats.lifetime.accounts, segment.accountId), delta);
    mergeAggregate(aggregateCell(bucket.accounts, segment.accountId), delta);
    if (!clientDisconnect) {
      const trace = segment.trace || [];
      const degraded = trace.some((attempt) => attempt.ruleScope === 'account' && SAMPLE_FAILURE_ACTIONS.has(attempt.healthAction));
      // 具名成功样本必须来自通过 generation 校验的 attempt；未归属 auto 成功沿用既有账号样本语义（有专项用例）。
      const succeeded = segment.success && trace.some((attempt) => attempt.healthAction === 'success' || (!attempt.upstream && attempt.status === 200));
      const sample = degraded ? 'degrades' : succeeded ? 'successes' : null;
      if (sample) addSuccessCounter(successHealthCell(bucket.accountHealth, segment.accountId), sample);
    }
  }
  if (!clientDisconnect && validStatisticModelId(modelId)) for (const attempt of globalTrace) {
    if (!attempt.upstream) continue;
    const sample = attempt.healthAction === 'success' ? 'successes' : attempt.ruleScope === 'provider-model' && SAMPLE_FAILURE_ACTIONS.has(attempt.healthAction) ? 'degrades' : null;
    if (sample) addSuccessCounter(providerSuccessHealthCell(bucket, modelId, attempt.upstream), sample);
  }
  pruneStatistics(ts);
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
function providerUsageProjection(modelId, provider = null, now = Date.now()) {
  const min = Math.floor(now / 60000) - 1439, c = META.statistics.recentCoverage;
  const out = emptyAggregate(), versions = {};
  for (const bucket of META.statistics.minuteBuckets) {
    if (bucket.minute < min) continue;
    const providers = Object.hasOwn(bucket.providerUsage,modelId) ? bucket.providerUsage[modelId] : {};
    for (const [name, delta] of Object.entries(providers)) if (provider === null || name === provider) mergeAggregate(out,delta);
    for (const [name, cells] of Object.entries(Object.hasOwn(bucket.valuation,modelId) ? bucket.valuation[modelId] : {})) if (provider === null || name === provider) for (const [version, delta] of Object.entries(cells)) {
      const value = statisticCell(versions,version,emptyValuation);
      for (const key of VALUATION_FIELDS) if (delta[key] === null) { value[key] = null; if (!value.overflowFields.includes(key)) value.overflowFields.push(key); } else addCounter(value,key,delta[key]);
    }
  }
  const incomplete = Math.max(Object.hasOwn(c.usageIncompleteAt,modelId) ? c.usageIncompleteAt[modelId] : 0,c.usageGlobalIncompleteAt);
  const valuationIncomplete = Math.max(Object.hasOwn(c.valuationIncompleteAt,modelId) ? c.valuationIncompleteAt[modelId] : 0,c.valuationGlobalIncompleteAt);
  return { usage: projectAggregate(out), coverage: { complete: c.usageTrackingStartedMinute <= min && incomplete < min, from: Math.max(min,c.usageTrackingStartedMinute,incomplete < min ? min : incomplete + 1)*60000 },
    valuation: { versions, complete: c.usageTrackingStartedMinute <= min && incomplete < min && valuationIncomplete < min,
      from: Math.max(min,c.usageTrackingStartedMinute,incomplete < min ? min : incomplete + 1,valuationIncomplete < min ? min : valuationIncomplete + 1)*60000 } };
}
function modelProviderProjection(modelId, now = Date.now()) {
  const providers = new Set();
  for (const bucket of META.statistics.minuteBuckets) if (bucket.minute >= Math.floor(now/60000)-1439) {
    for (const name of Object.keys(Object.hasOwn(bucket.providerUsage,modelId) ? bucket.providerUsage[modelId] : {})) providers.add(name);
    for (const name of Object.keys(Object.hasOwn(bucket.providerHealth,modelId) ? bucket.providerHealth[modelId] : {})) providers.add(name);
  }
  const final = emptyFinal(), c = META.statistics.recentCoverage, min = Math.floor(now/60000)-1439;
  const incomplete = Object.hasOwn(c.modelIncompleteAt,modelId) ? c.modelIncompleteAt[modelId] : undefined;
  const finalCoverage = { complete: c.usageTrackingStartedMinute <= min && incomplete === undefined,
    from: Math.max(min,c.usageTrackingStartedMinute,incomplete === undefined ? min : incomplete+1)*60000 };
  for (const bucket of META.statistics.minuteBuckets) if (bucket.minute >= Math.floor(now/60000)-1439 && Object.hasOwn(bucket.modelFinal,modelId)) for (const key of FINAL_FIELDS) {
    const n = bucket.modelFinal[modelId][key];
    if (n === null) { final[key] = null; if (!final.overflowFields.includes(key)) final.overflowFields.push(key); }
    else addCounter(final,key,n);
  }
  const samples = Number.isSafeInteger(final.successes) && Number.isSafeInteger(final.failures) && Number.isSafeInteger(final.successes+final.failures) ? final.successes+final.failures : null;
  return { finalRequests: { ...final, samples, successRate: samples ? final.successes/samples : null }, finalCoverage,
    ...providerUsageProjection(modelId,null,now),
    providers: [...providers].sort().map((id) => ({ id: id || null, ...providerUsageProjection(modelId,id,now), health: id ? successHealthProjection('provider',modelId,id,now) : null })),
  };
}
function routingCoverage(now = Date.now()) {
  const min = Math.floor(now / 60000) - 1439, start = META.statistics.recentCoverage.routingTrackingStartedMinute;
  return { complete: start <= min, from: Math.max(min, start) * 60000 };
}
function statisticsModelIds() {
  const ids = new Set([...(config.knownModels || []), ...Object.keys(config.perModel || {})]);
  for (const account of config.accounts || []) for (const id of Object.keys(account.perModel || {})) ids.add(id);
  for (const bucket of META.statistics.minuteBuckets) for (const map of [bucket.models,bucket.modelFinal,bucket.providerUsage,bucket.valuation,bucket.providerHealth]) for (const id of Object.keys(map)) ids.add(id);
  return [...ids].filter(validStatisticModelId);
}
function ratio(numerator, denominator, valid = true) { return valid && Number.isSafeInteger(numerator) && Number.isSafeInteger(denominator) && denominator > 0 ? numerator / denominator : null; }
function projectAggregate(aggregate) {
  return { ...aggregate, cacheTokenRatio: ratio(aggregate.cacheInputCachedTokens, aggregate.cacheInputTokens, aggregate.cacheInputCachedTokens <= aggregate.cacheInputTokens), cacheHitRequestRate: ratio(aggregate.cacheHitRequests, aggregate.cacheKnownRequests) };
}
function aggregateSuccessHealth(scope, id, provider = null, now = Date.now()) {
  const out = emptySuccessHealth(), min = Math.floor(now / 60000) - 1439;
  for (const bucket of META.statistics.minuteBuckets) {
    if (bucket.minute < min) continue;
    const delta = scope === 'account' ? bucket.accountHealth?.[id] : Object.hasOwn(bucket.providerHealth,id) && Object.hasOwn(bucket.providerHealth[id],provider) ? bucket.providerHealth[id][provider] : null;
    if (delta) mergeSuccessHealth(out, delta);
  }
  return out;
}
function successHealthProjection(scope, id, provider = null, now = Date.now()) {
  const health = aggregateSuccessHealth(scope, id, provider, now), coverage = META.statistics.recentCoverage, min = Math.floor(now / 60000) - 1439;
  const start = scope === 'account' ? coverage.accountHealthTrackingStartedMinute : coverage.providerHealthTrackingStartedMinute;
  const incompleteAt = scope === 'account' ? coverage.accountHealthIncompleteAt?.[id] : Object.hasOwn(coverage.providerHealthIncompleteAt,id) && Object.hasOwn(coverage.providerHealthIncompleteAt[id],provider) ? coverage.providerHealthIncompleteAt[id][provider] : undefined;
  const coverageFromMinute = Math.max(min, start, incompleteAt === undefined ? min : incompleteAt + 1);
  const samples = health.successes === null || health.degrades === null || health.successes > Number.MAX_SAFE_INTEGER - health.degrades ? null : health.successes + health.degrades;
  return {
    successRate: samples && Number.isSafeInteger(samples) ? health.successes / samples : null,
    successes: health.successes,
    degrades: health.degrades,
    samples,
    coverageComplete: start <= min && incompleteAt === undefined,
    coverageFrom: coverageFromMinute * 60000,
  };
}
function healthProjection(account, now = Date.now()) {
  const state = getAccountState(account.id);
  return {
    ...successHealthProjection('account', account.id, null, now),
    disabled: account.enabled === false,
    hardQuarantined: state?.hardQuarantined === true || state?.banned === true,
    cooling: Number(state?.cooldownUntil) > now,
    cooldownUntil: Number(state?.cooldownUntil) > now ? state.cooldownUntil : null,
  };
}
const AFFINITY_KEY_TYPES = new Set(['parent_session','parent_thread','parent_conversation','parent_agent','prompt_cache_key','session_id','thread_id','conversation_id','agent_id','message_hmac','none']);
const AFFINITY_CONFIDENCE = new Set(['explicit','fallback','none']);
const UPSTREAM_PROMPT_KEY_SOURCES = new Set(['caller_prompt_cache_key','caller_session_id','caller_invalid','derived_codex','derived_claude','none']);
const PIPELINE_DIAGNOSTICS = new Set(['quota-all-unknown']);
const PIPELINE_QUOTA_POOLS = new Set(['ordinary','hot','warm','unknown','reserve']);
const PIPELINE_HEALTH_LAYERS = new Set(['rated','unknown']);
const BINDING_SOURCES = new Set(['explicit','fallback','none']);
const BINDING_RESULTS = new Set(['hit','miss','invalidated','temporary-overflow','provisional','not-applicable']);
const ORDINARY_REASON_BYTES = 16 * 1024;
const DETAIL_CALL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function boundedReason(value, sensitiveValues = []) {
  const original = safeReason(value, sensitiveValues), encoded = Buffer.from(original);
  if (encoded.length <= ORDINARY_REASON_BYTES) return { reason: original, reasonTruncated: false };
  let bytes = encoded.subarray(0, ORDINARY_REASON_BYTES);
  while (bytes.length) { try { return { reason: new TextDecoder('utf-8', { fatal: true }).decode(bytes), reasonTruncated: true }; } catch { bytes = bytes.subarray(0, bytes.length - 1); } }
  return { reason: '', reasonTruncated: true };
}
function record(modelId, info, detail = detailContext.getStore()) {
  const ts = Date.now();
  META.models[modelId] = { ...(META.models[modelId] || {}), provider: info.provider, canonical: info.canonical, lastMs: info.ms };
  const result = ['success', 'client_cancelled', 'failed'].includes(info.result) ? info.result : (info.error ? 'failed' : 'success');
  const { sensitiveValues: _sensitiveValues, ...safeInfo } = info;
  const legacy = {
    ts, model: modelId, ...safeInfo, result,
    error: safeInfo.error ? boundedReason(safeInfo.error, info.sensitiveValues).reason : safeInfo.error,
    trace: Array.isArray(safeInfo.trace) ? safeInfo.trace.map((attempt) => {
      const { attemptIndex: _attemptIndex, callId: _callId, detailProfile: _detailProfile, reasonTruncated: _reasonTruncated, ...legacyAttempt } = attempt;
      return { ...legacyAttempt, note: boundedReason(attempt.note, info.sensitiveValues).reason };
    }) : safeInfo.trace,
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
    bindingSource: BINDING_SOURCES.has(info.bindingSource) ? info.bindingSource : 'none',
    bindingResult: BINDING_RESULTS.has(info.bindingResult) ? info.bindingResult : 'not-applicable',
    preferredAccountId: info.preferredAccountId || null,
    preferredAccountName: info.preferredAccountName || null, accountId: info.accountId || null, accountName: info.account || null,
    selectionReason: info.selectionReason || null, overflow: !!info.overflow,
    pipelineSteps: Array.isArray(info.pipeline?.diagnostics) ? info.pipeline.diagnostics.filter((value) => PIPELINE_DIAGNOSTICS.has(value)).slice(0, 8) : [],
    selectedQuotaPool: PIPELINE_QUOTA_POOLS.has(info.pipeline?.selectedQuota) ? info.pipeline.selectedQuota : null,
    selectedHealthLayer: PIPELINE_HEALTH_LAYERS.has(info.pipeline?.selectedHealth) ? info.pipeline.selectedHealth : null,
    capacityFallback: !!info.pipeline?.capacityFallback,
    cachePoolSize: Number.isInteger(info.pipeline?.cachePoolSize) ? info.pipeline.cachePoolSize : configuredCachePoolSize(),
    cachePoolMaxSize: Number.isInteger(info.pipeline?.cachePoolMaxSize) ? info.pipeline.cachePoolMaxSize : configuredCachePoolMaxSize(),
    cachePoolLowQuotaSize: Number.isInteger(info.pipeline?.cachePoolLowQuotaSize) ? info.pipeline.cachePoolLowQuotaSize : configuredCachePoolLowQuotaSize(),
    cachePoolActual: info.pipeline?.cachePoolActual ? Object.fromEntries(['high','low','unknown'].map((role) => [role, Number.isInteger(info.pipeline.cachePoolActual[role]) && info.pipeline.cachePoolActual[role] >= 0 && info.pipeline.cachePoolActual[role] <= 100000 ? info.pipeline.cachePoolActual[role] : null])) : null,
    selectedQuotaRole: ['low','high','unknown'].includes(info.pipeline?.selectedQuotaRole) ? info.pipeline.selectedQuotaRole : null,
    cachePoolTargetSize: Number.isInteger(info.pipeline?.cachePoolTargetSize) ? info.pipeline.cachePoolTargetSize : configuredCachePoolTargetSize(),
    cachePoolTier: ['active','standby'].includes(info.pipeline?.cachePoolTier) ? info.pipeline.cachePoolTier : null, cachePoolFallback: info.pipeline?.cachePoolFallback === true,
    targetProviders: Array.isArray(info.targets) ? info.targets : [], actualProvider: info.provider || null,
    providerPlanSource: PROVIDER_PLAN_SOURCES.has(info.providerPlanSource) ? info.providerPlanSource : null,
    providerMode: PROVIDER_MODES.has(info.providerMode) ? info.providerMode : null,
    attempts: Array.isArray(info.trace) ? info.trace.map((t) => ({
      provider: t.upstream || 'auto', status: t.status, upstreamStatus: t.upstreamStatus, ms: t.ms, account: t.account, action: ERROR_RULE_ACTIONS.has(t.action) ? t.action : null,
      providerSelection: PROVIDER_SELECTIONS.has(t.providerSelection) ? t.providerSelection : null,
      ruleId: typeof t.ruleId === 'string' && ERROR_RULE_ID.test(t.ruleId) ? t.ruleId : null,
      ruleScope: ERROR_RULE_SCOPES.has(t.ruleScope) ? t.ruleScope : null,
      ruleAction: ERROR_RULE_ACTIONS.has(t.ruleAction) ? t.ruleAction : null,
      matchedBy: Array.isArray(t.matchedBy) ? t.matchedBy.filter((value) => ['status','body','header','provider','model','default'].includes(value)).slice(0, 5) : [],
      providerCircuitAction: ['cooldown','half-open-success','half-open-failed'].includes(t.providerCircuitAction) ? t.providerCircuitAction : null,
      errorScope: t.errorScope || null, scopeEvidence: t.scopeEvidence || null, failureClass: t.failureClass || null,
      healthAction: t.healthAction || 'none', quotaRemovalAction: ['waiting-refresh','protection-pending'].includes(t.quotaRemovalAction) ? t.quotaRemovalAction : null, retryAfterMs: t.retryAfterMs ?? null,
      retryRuleId: typeof t.retryRuleId === 'string' && ERROR_RULE_ID.test(t.retryRuleId) ? t.retryRuleId : null,
      retryDecision: t.retryDecision === 'stop' ? 'stop' : 'continue',
      retryMatchedBy: Array.isArray(t.retryMatchedBy) ? t.retryMatchedBy.filter((value) => RETRY_MATCH_KINDS.has(value)).slice(0, 2) : [],
      responseContentType: t.responseContentType || null, responseBytes: Number.isSafeInteger(t.responseBytes) ? t.responseBytes : null,
    })) : [],
    status: result === 'client_cancelled' ? 499 : result === 'success' ? 200 : (info.normalizedStatus || 502), result, upstreamStatus: info.upstreamStatus ?? null,
    durationMs: Number(info.ms) || 0, accountActions: info.accountActions || [], switched: (info.accountPath || []).length > 1, appliedHeaderNames: info.appliedHeaderNames || [],
    // 准确锁定阻塞维度：只投影 bounded 枚举和 bounded Retry-After 秒数，不写候选表或窗口时间戳。
    blockedBy: BLOCKED_BY_REASONS.has(info.blockedBy) ? info.blockedBy : null,
    retryAfter: Number.isSafeInteger(info.retryAfter) && info.retryAfter >= 0 ? Math.min(3600, info.retryAfter) : null,
    errorCategory: info.errorCategory || (result === 'failed' && info.error ? (info.proxyError ? 'proxy' : 'upstream') : null),
  };
  if (detail?.requestId === request.requestId) { detail.result = result; if (detail.errorOnly && detail.status === null) detail.status = request.status; }
  const writes = [requestLogs.append(request)];
  for (const [traceIndex, attempt] of (result === 'client_cancelled' ? [] : (info.trace || [])).entries()) {
    if (attempt.status === 200 && !attempt.action) continue;
    const attemptIndex = Number.isSafeInteger(attempt.attemptIndex) && attempt.attemptIndex >= 0 ? attempt.attemptIndex : traceIndex;
    const detailProfile = ['error', 'full', 'raw-error', 'raw-full'].includes(attempt.detailProfile) && DETAIL_CALL_ID.test(attempt.callId || '') ? attempt.detailProfile : null;
    const bounded = boundedReason(attempt.note, info.sensitiveValues);
    bounded.reasonTruncated ||= attempt.reasonTruncated === true;
    writes.push(errorLogs.append({ ts, requestId: request.requestId, requestedModel: request.requestedModel, resolvedModel: request.resolvedModel,
      accountId: attempt.accountId || info.accountId || null, accountName: attempt.account || info.account || null, attemptIndex,
      providerSelection: PROVIDER_SELECTIONS.has(attempt.providerSelection) ? attempt.providerSelection : null,
      targetProvider: attempt.upstream || null, providerPath: (info.trace || []).slice(0, traceIndex + 1).map((t) => t.upstream || 'auto'),
      status: attempt.normalizedStatus || attempt.status, upstreamStatus: attempt.upstreamStatus ?? null,
      category: attempt.upstreamStatus === 0 ? (info.proxyError ? 'proxy' : 'network') : 'upstream', ...bounded, accountAction: attempt.ruleScope === 'account' ? attempt.ruleAction || null : null,
      ruleId: typeof attempt.ruleId === 'string' && ERROR_RULE_ID.test(attempt.ruleId) ? attempt.ruleId : null,
      ruleScope: ERROR_RULE_SCOPES.has(attempt.ruleScope) ? attempt.ruleScope : null,
      ruleAction: ERROR_RULE_ACTIONS.has(attempt.ruleAction) ? attempt.ruleAction : null,
      matchedBy: Array.isArray(attempt.matchedBy) ? attempt.matchedBy.filter((value) => ['status','body','header','provider','model','default'].includes(value)).slice(0, 5) : [],
      errorScope: attempt.errorScope || null, scopeEvidence: attempt.scopeEvidence || null, failureClass: attempt.failureClass || null,
      healthAction: attempt.healthAction || 'none', quotaRemovalAction: ['waiting-refresh','protection-pending'].includes(attempt.quotaRemovalAction) ? attempt.quotaRemovalAction : null, retryAfterMs: attempt.retryAfterMs ?? null,
      retryRuleId: typeof attempt.retryRuleId === 'string' && ERROR_RULE_ID.test(attempt.retryRuleId) ? attempt.retryRuleId : null,
      retryDecision: attempt.retryDecision === 'stop' ? 'stop' : 'continue',
      retryMatchedBy: Array.isArray(attempt.retryMatchedBy) ? attempt.retryMatchedBy.filter((value) => RETRY_MATCH_KINDS.has(value)).slice(0, 2) : [],
      responseContentType: attempt.responseContentType || null, responseBytes: Number.isSafeInteger(attempt.responseBytes) ? attempt.responseBytes : null,
      ...(detailProfile ? { detailProfile, detailCallId: attempt.callId } : {}) }));
  }
  void Promise.all(writes);
  try { saveMeta(); } catch (error) { console.error(`[诊断] metadata 持久化失败：${safeReason(error.message)}`); }
  if (detail?.requestId === request.requestId && detail.errorOnly) detail.finalize();
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
// All runtime knobs use explicit milliseconds/counts. Invalid values fall back to a safe default.
function boundedEnv(name, fallback, min, max) {
  const raw = process.env[name];
  if (raw === undefined || !/^(0|[1-9]\d*)$/.test(raw)) return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : fallback;
}
function runtimeDuration(name, fallback, min, max) {
  const value = boundedEnv(`CLINE_PASS_${name}`, fallback, min, max);
  return process.env.NODE_ENV === 'test' ? boundedEnv(`CLINE_PASS_TEST_${name}`, value, min, max) : value;
}
const INBOUND_KEEP_ALIVE_MS = runtimeDuration('INBOUND_KEEP_ALIVE_MS', 95_000, 100, 120_000);
const SSE_FIRST_EVENT_MS = runtimeDuration('SSE_FIRST_EVENT_MS', 120_000, 100, 120_000);
const SSE_STREAM_IDLE_MS = runtimeDuration('SSE_STREAM_IDLE_MS', 360_000, 200, 600_000);
const SSE_HEARTBEAT_MS = runtimeDuration('SSE_HEARTBEAT_MS', 25_000, 0, 60_000);
const directSockets = boundedEnv('CLINE_PASS_DIRECT_MAX_SOCKETS', 256, 1, 1024);
const proxySockets = boundedEnv('CLINE_PASS_PROXY_MAX_SOCKETS', 32, 1, 128);
const directAgentOptions = { keepAlive: true, maxSockets: directSockets, maxFreeSockets: Math.min(directSockets, boundedEnv('CLINE_PASS_DIRECT_MAX_FREE_SOCKETS', 32, 1, 64)), scheduling: 'lifo', timeout: 60_000 };
const proxyAgentOptions = { keepAlive: true, maxSockets: proxySockets, maxFreeSockets: Math.min(proxySockets, boundedEnv('CLINE_PASS_PROXY_MAX_FREE_SOCKETS', 2, 1, 16)), scheduling: 'lifo', timeout: 60_000 };
const directHttpAgent = new http.Agent(directAgentOptions);
const directHttpsAgent = new https.Agent(directAgentOptions);
const proxyAgents = new Map();
const MAX_CACHED_PROXY_AGENTS = 128;
function proxyAgentFor(proxyUrl, { ephemeral = false } = {}) {
  if (!proxyUrl) return undefined;
  if (!ephemeral && proxyAgents.has(proxyUrl)) return proxyAgents.get(proxyUrl);
  const protocol = new URL(proxyUrl).protocol;
  const agent = protocol === 'socks5:' || protocol === 'socks5h:'
    ? new SocksProxyAgent(proxyUrl, proxyAgentOptions) : new HttpsProxyAgent(proxyUrl, proxyAgentOptions);
  if (!ephemeral) proxyAgents.set(proxyUrl, agent);
  return agent;
}
function pruneProxyAgents() {
  const retained = new Set(config.accounts.map((account) => account.proxyUrl).filter(Boolean));
  for (const [url, agent] of proxyAgents) if (!retained.has(url)) { agent.destroy(); proxyAgents.delete(url); }
}
function clineRequestJSON(url, { headers = {}, body, signal, timeoutMs = 120000, account = null, proxyUrl = '', method = 'POST', maxResponseBytes = Infinity, attemptOwner = null, attemptMeta = null, permit = null, ephemeralProxy = false } = {}) {
  return clineRequest(url, { headers, body, signal, timeoutMs, account, proxyUrl, method, attemptOwner, attemptMeta, permit, ephemeralProxy }).then(async (res) => ({ ...res, text: await streamToString(res.body, maxResponseBytes) }));
}
function clineRequest(url, { headers = {}, body, signal, timeoutMs = 120000, account = null, proxyUrl = '', method = 'POST', attemptOwner = null, attemptMeta = null, permit = null, ephemeralProxy = false } = {}) {
  const root = detailContext.getStore();
  const nativeChat = method === 'POST' && url === `${config.upstreamBase}/chat/completions`;
  let detailAttempt = null, attemptToken = null, req = null;
  return new Promise((resolve, reject) => {
    let settled = false;
    let response = null;
    let cleanup = () => {};
    let agent = null, disposableAgent = ephemeralProxy;
    const dispose = () => { if (disposableAgent) agent?.destroy(); };
    const onAbort = () => { response?.destroy(new Error('aborted')); req?.destroy(new Error('aborted')); };
    const fail = (error) => {
      cleanup();
      dispose();
      // 未调用 req.end() 就结束的 attempt 不是真实上游请求：立即退还预留并唤醒等待者。
      try { permit?.release(); } catch {}
      if (!settled) {
        settled = true;
        if (attemptToken) error.attemptToken = attemptToken;
        if (detailAttempt) { detailAttempt.state = 'transport-failed'; error.detailAttempt = detailAttempt; }
        reject(error);
      }
    };
    // 创建 request / 解析 URL / 构造 agent 的同步失败都属于"未发出"，必须退还预留。
    let u, lib, data, requestHeaders;
    try {
      u = new URL(url);
      lib = u.protocol === 'https:' ? https : http;
      data = Buffer.isBuffer(body) ? body : Buffer.from(String(body || ''));
      cleanup = () => signal?.removeEventListener('abort', onAbort);
      const effectiveProxy = proxyUrl || account?.proxyUrl || '';
      disposableAgent = !!effectiveProxy && (ephemeralProxy || !config.accounts.some((a) => a.proxyUrl === effectiveProxy) ||
        (!proxyAgents.has(effectiveProxy) && proxyAgents.size >= MAX_CACHED_PROXY_AGENTS));
      agent = effectiveProxy ? proxyAgentFor(effectiveProxy, { ephemeral: disposableAgent }) : u.protocol === 'https:' ? directHttpsAgent : directHttpAgent;
      requestHeaders = { ...headers }; if (method !== 'GET') requestHeaders['Content-Length'] = data.length;
      req = lib.request({ protocol: u.protocol, hostname: u.hostname, port: u.port, path: `${u.pathname}${u.search}`, method, headers: requestHeaders, agent }, (res) => {
        response = res;
        res.once('end', () => { cleanup(); dispose(); });
        res.once('close', () => { cleanup(); dispose(); });
        if (detailAttempt) { detailAttempt.status = res.statusCode || 502; detailAttempt.responseHeaders = res.headers; }
        const responseBody = detailAttempt?.output ? observeStream(res, detailAttempt.output) : res;
        if (!settled) { settled = true; resolve({ status: res.statusCode || 502, headers: res.headers, body: responseBody, attemptToken, detailAttempt,
          setIdleTimeout(ms) {
            // Node detaches IncomingMessage.socket once a complete response ends;
            // buffered first events still need forwarding, but no idle socket remains.
            if (res.socket && !res.destroyed) { req.setTimeout(ms); res.setTimeout(ms); }
          } }); }
      });
    } catch (error) { fail(error); return; }
    req.on('error', fail);
    req.setTimeout(timeoutMs, () => { const error = new Error('upstream timeout'); response?.destroy(error); req.destroy(error); });
    if (signal) {
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      req.end(method === 'GET' ? undefined : data);
      // 已把请求交给 Node transport：此后 DNS/connect/proxy/TLS/成功/错误/超时/取消都不退还 RPM。
      permit?.commit();
      if (nativeChat) {
        if (attemptOwner) attemptToken = { attemptIndex: attemptOwner.nextAttemptIndex++, callId: crypto.randomUUID() };
        try { attemptOwner?.onAttemptCommit?.(); } catch {}
        try {
          detailAttempt = root?.attempt({ token: attemptToken, url, method, headers: req.getHeaders(), body: body || '', account, proxyUrl, model: attemptMeta?.model || '', provider: attemptMeta?.provider ?? null }) || null;
          if (!attemptToken && detailAttempt) attemptToken = { attemptIndex: detailAttempt.attemptIndex, callId: detailAttempt.callId };
        } catch { detailedLogs.recordDrop('attemptCaptureFailure'); detailAttempt = null; }
      }
    } catch (error) { fail(error); }
  });
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
function quotaProtectionDue(account, now = Date.now()) {
  if (!account?.key || account.enabled === false) return false;
  const pending = quotaProvisional.get(account.id);
  if (pending && pending.persistRetryAt === undefined && pending.until <= now && !quotaJobs.has(account.id)) quotaProvisional.delete(account.id);
  const state = getAccountState(account.id), q = META.accountQuotas?.[account.id];
  if ((quotaProvisional.get(account.id)?.until || 0) > now) return true;
  if (state?.protectionShortAt) return !state.protectionRetryAt || now >= state.protectionRetryAt;
  if (state?.protectionMonthlyAt) {
    const reset = Date.parse(q?.snapshot?.limits?.monthly?.resetsAt);
    return Number.isSafeInteger(reset) && reset > 0 && reset <= now && (q?.lastAttemptAt || 0) < reset;
  }
  return false;
}
function quotaProtectionScheduled(account) {
  if (quotaProvisional.get(account?.id)?.persistRetryAt !== undefined) return true;
  if (!account?.key || account.enabled === false) return false;
  const state = getAccountState(account.id), reset = Date.parse(META.accountQuotas?.[account.id]?.snapshot?.limits?.monthly?.resetsAt);
  return !!((quotaProvisional.get(account.id)?.until || 0) > Date.now() || state?.protectionShortAt || (state?.protectionMonthlyAt && Number.isSafeInteger(reset) && (META.accountQuotas?.[account.id]?.lastAttemptAt || 0) < reset));
}
function quotaProtectionWakeAt(account, now = Date.now()) {
  const pending = quotaProvisional.get(account.id), q = META.accountQuotas?.[account.id], state = getAccountState(account.id);
  const backoff = q?.errorCategory && q.lastAttemptAt ? q.lastAttemptAt + quotaFailureDelay(account.id) : 0;
  if (pending?.persistRetryAt !== undefined) return Math.max(now + 10, pending.persistRetryAt);
  if (pending) return Math.max(now + 10, Math.min(pending.until, backoff || now + 10));
  if (state?.protectionShortAt) {
    const successAt = successfulQuotaTime(q, now) || 0;
    const next = state.protectionRetryAt > successAt ? state.protectionRetryAt : successAt + QUOTA_SUCCESS_MS;
    return Math.max(now + 10, next, backoff);
  }
  return Math.max(now + 10, Date.parse(q?.snapshot?.limits?.monthly?.resetsAt) || now + 10, backoff);
}
function quotaDemandOutcome(account, { force = false, pageToken = null, protection = false } = {}, now = Date.now()) {
  if (!account?.key) return 'skipped';
  if (account.enabled === false) return 'skipped';
  const q = META.accountQuotas?.[account.id];
  if (q?.errorCategory && q.lastAttemptAt && now < q.lastAttemptAt + quotaFailureDelay(account.id)) return 'deferred';
  const lastSuccessAt = successfulQuotaTime(q, now);
  const pageSuccess = pageToken?.force && quotaPageOwnerHasNewSuccess(pageToken, account.id, lastSuccessAt);
  const protectionState = getAccountState(account.id);
  const forceRequired = pageToken ? quotaPageOwnerRequiresForce(pageToken, account.id, lastSuccessAt) : force || (protection && ((quotaProvisional.get(account.id)?.until || 0) > now || (protectionState?.protectionRetryAt > lastSuccessAt && now >= protectionState.protectionRetryAt) || (protectionState?.protectionMonthlyAt && quotaProtectionDue(account, now))));
  if (protection && !forceRequired) {
    const state = getAccountState(account.id);
    const next = state?.protectionRetryAt > lastSuccessAt ? state.protectionRetryAt : (lastSuccessAt || 0) + QUOTA_SUCCESS_MS;
    if (state?.protectionShortAt && now < next) return 'cached';
  }
  const disposition = cachePoolEnabled() && configuredCachePoolLowQuotaSize() > 0 ? getAccountState(account.id) : null;
  if (!forceRequired && disposition?.quotaDisposition === 'waiting-refresh' && lastSuccessAt && lastSuccessAt >= disposition.quotaDispositionAt && now - lastSuccessAt < QUOTA_SUCCESS_MS) return 'cached';
  if (!forceRequired && disposition?.quotaDisposition === 'quota-exhausted' && lastSuccessAt) {
    const next = disposition.quotaRetryAt > lastSuccessAt ? disposition.quotaRetryAt : lastSuccessAt + QUOTA_SUCCESS_MS;
    if (now < next) return 'cached';
  }
  if (pageSuccess || (!forceRequired && disposition?.quotaDisposition !== 'waiting-refresh' && disposition?.quotaDisposition !== 'quota-exhausted' && lastSuccessAt && now - lastSuccessAt < QUOTA_SUCCESS_MS)) return 'cached';
  return null;
}
function quotaJobAccount(job) {
  const account = config.accounts.find((item) => item.id === job.id);
  return account && account.enabled !== false && account.key && account.key === job.key && (account.proxyUrl || '') === job.proxyUrl && (quotaGenerations.get(job.id) || 0) === job.generation ? account : null;
}
function quotaJobHasOwner(job) {
  if (job.cancelled) return false;
  if (job.routingEpoch === quotaRoutingEpoch && quotaRoutingEnabled()) return true;
  if (job.protection && (quotaProvisional.has(job.id) || getAccountState(job.id)?.protectionShortAt || getAccountState(job.id)?.protectionMonthlyAt)) return true;
  for (const token of job.pageOwners) if (token.active) return true;
  return false;
}
function detachQuotaJob(job) {
  for (const token of job.pageOwners) token.jobs.delete(job);
  job.pageOwners.clear(); job.routingEpoch = null; job.protection = false;
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
  if (deleted || quotaProvisional.get(id)?.persistRetryAt === undefined) quotaProvisional.delete(id);
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
  } else if (source.protection && quotaProtectionDue(config.accounts.find((a) => a.id === job.id))) job.protection = true;
  else if (source.routingEpoch === quotaRoutingEpoch && quotaRoutingEnabled()) job.routingEpoch = source.routingEpoch;
  else return false;
  return true;
}
function awaitQuotaJob(job, source) {
  return source.pageToken ? Promise.race([job.promise, source.pageToken.cancelPromise.then(() => 'cancelled')]) : job.promise;
}
async function requestQuota(id, source) {
  if (shuttingDown) return 'cancelled';
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
    const job = { id, generation, key: account.key, proxyUrl: account.proxyUrl || '', state: 'queued', cancelled: false, controller: null, pageOwners: new Set(), routingEpoch: null, protection: false, promise: null, resolve: null };
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
  if (snapshot) {
    state.snapshot = snapshot; state.lastSuccessAt = snapshot.fetchedAt; state.errorCategory = null; quotaFailureCounts.delete(job.id); quotaSuccessVersions.set(job.id, (quotaSuccessVersions.get(job.id) || 0) + 1);
    reconcileQuotaDisposition(job.id, snapshot);
    reconcileQuotaProtection(job.id, snapshot);
    if (quotaProjection(job.id).pool === 'reserve') invalidateSessionBindingsForAccount(job.id);
    else reconcileSessionBindings();
  } else {
    state.errorCategory = errorCategory || 'schema'; quotaFailureCounts.set(job.id, Math.min(4, (quotaFailureCounts.get(job.id) || 0) + 1));
    if (quotaProvisional.get(job.id)?.persistRetryAt === undefined) quotaProvisional.delete(job.id);
    reconcileSessionBindings();
  }
  try { saveMeta(); } catch (error) { console.error(`[额度] 持久化失败：${safeReason(error.message)}`); }
  if (quotaProvisional.get(job.id)?.persistRetryAt !== undefined) scheduleQuotaRefresh();
  return snapshot ? 'refreshed' : 'failed';
}
// Only the existing quota job confirms and clears protection. Reset times schedule
// evidence collection, never admission. A manual monthly ban is never auto-cleared.
function reconcileQuotaProtection(id, snapshot) {
  const now = Date.now(), pending = quotaProvisional.get(id), previous = getAccountState(id) || {};
  const state = { ...previous };
  if (pending && snapshot.fetchedAt >= pending.at && (quotaSuccessVersions.get(id) || 0) > pending.version) {
    const used = snapshot.limits?.monthly?.percentUsed;
    if (typeof used === 'number' && now - snapshot.fetchedAt <= QUOTA_STALE_MS &&
        50 * (100 - used) < Math.round(config.quotaProtection.monthlyThresholdUsd * 100) - 1e-7) {
      if (!state.protectionMonthlyAt) {
        state.protectionMonthlyAt = now;
        // Keep the verified ban in META for fail-closed admission. Only an atomic
        // metadata write can clear this process-local persistence warning.
        pending.until = 0; // verification is complete; persistence must not start another quota fetch
        pending.persistRetryAt = now + QUOTA_FAILURE_MS;
        pending.persistFailures = 0;
      }
    }
  }
  if (pending?.persistRetryAt === undefined) quotaProvisional.delete(id);
  const exhausted = ['five_hour','weekly'].filter((type) => snapshot.limits?.[type]?.percentUsed >= 100);
  if (exhausted.length) {
    state.protectionShortAt ||= now;
    state.protectionShortWindows = [...new Set([...(state.protectionShortWindows || []), ...exhausted])];
    const resets = state.protectionShortWindows.map((type) => Date.parse(snapshot.limits?.[type]?.resetsAt)).filter((at) => Number.isSafeInteger(at) && at > now);
    state.protectionRetryAt = resets.length ? Math.min(...resets) : 0;
  } else if (state.protectionShortAt && snapshot.fetchedAt >= state.protectionShortAt &&
             QUOTA_TYPES.every((type) => snapshot.limits?.[type]?.percentUsed < 100)) {
    state.protectionShortAt = 0; state.protectionShortWindows = null; state.protectionRetryAt = 0;
  } else if (state.protectionShortAt) {
    const resets = (state.protectionShortWindows || []).map((type) => Date.parse(snapshot.limits?.[type]?.resetsAt)).filter((at) => Number.isSafeInteger(at) && at > now);
    state.protectionRetryAt = resets.length ? Math.min(...resets) : 0;
  }
  if (state.protectionMonthlyAt !== previous.protectionMonthlyAt || state.protectionShortAt !== previous.protectionShortAt ||
      state.protectionRetryAt !== previous.protectionRetryAt || JSON.stringify(state.protectionShortWindows) !== JSON.stringify(previous.protectionShortWindows)) {
    META.accountStates[id] = state; invalidateSessionBindingsForAccount(id); notifyCapacityWaiters();
  }
}
function signalQuotaProtection(account) {
  if (getAccountState(account.id)?.protectionMonthlyAt || (quotaProvisional.get(account.id)?.until || 0) > Date.now()) return;
  const now = Date.now();
  quotaProvisional.set(account.id, { at: Math.max(now, (successfulQuotaTime(META.accountQuotas?.[account.id]) || 0)), until: now + Math.min(30_000, 2 * QUOTA_TIMEOUT_MS), version: quotaSuccessVersions.get(account.id) || 0 });
  invalidateSessionBindingsForAccount(account.id); notifyCapacityWaiters();
  void requestQuota(account.id, { protection: true }).catch((error) => console.error(`[额度] 刷新失败：${safeReason(error.message)}`));
  scheduleQuotaRefresh();
}
// The existing quota job is the only writer that may clear a quota disposition.
// A partial known-100 snapshot confirms exhaustion; an incomplete/failed snapshot
// never proves that a previously confirmed exhaustion (or waiting hold) recovered.
function reconcileQuotaDisposition(id, snapshot) {
  if (!cachePoolEnabled() || configuredCachePoolLowQuotaSize() === 0) return;
  const now = Date.now(), state = getAccountState(id);
  const windows = Object.values(snapshot.limits || {});
  const exhausted = windows.filter((window) => window.percentUsed >= 100);
  if (exhausted.length) {
    const resets = exhausted.map((window) => Date.parse(window.resetsAt)).filter((at) => Number.isSafeInteger(at) && at > now);
    const retryAt = resets.length ? Math.min(...resets) : 0;
    META.accountStates[id] = { ...(state || {}), quotaDisposition: 'quota-exhausted', quotaDispositionAt: state?.quotaDisposition === 'quota-exhausted' ? state.quotaDispositionAt : now, quotaRetryAt: retryAt, quotaReason: 'known-exhausted' };
    invalidateSessionBindingsForAccount(id);
    notifyCapacityWaiters();
  } else if (windows.length === 3 && state?.quotaDisposition && snapshot.fetchedAt >= state.quotaDispositionAt) {
    // An operator save may reconcile an older cached snapshot. Only a success
    // obtained after this disposition is evidence that it may be cleared.
    META.accountStates[id] = { ...state, quotaDisposition: null, quotaDispositionAt: 0, quotaRetryAt: 0, quotaReason: null };
    notifyCapacityWaiters();
  }
}
function persistLowQuotaHold(account) {
  if (!account?.id) return;
  // Distinguish a pre-hold cached success even when both events share one millisecond.
  const now = Math.max(Date.now(), (successfulQuotaTime(META.accountQuotas?.[account.id]) || 0) + 1);
  META.accountStates[account.id] = { ...(getAccountState(account.id) || {}), quotaDisposition: 'waiting-refresh', quotaDispositionAt: now, quotaRetryAt: 0, quotaReason: 'account-degrade' };
  invalidateSessionBindingsForAccount(account.id);
  notifyCapacityWaiters();
  try { saveMeta(); } catch (error) { console.error(`[账号] 状态持久化失败：${safeReason(error.message)}`); }
  scheduleQuotaRefresh();
}
function pumpQuotaQueue() {
  if (shuttingDown) { for (const job of [...quotaQueue]) finishQueuedQuotaJob(job); return; }
  while (quotaRunning < QUOTA_GLOBAL_LIMIT && quotaQueue.length) {
    const job = quotaQueue.shift();
    if (quotaJobs.get(job.id) !== job || job.state !== 'queued') continue;
    const account = quotaJobAccount(job);
    if (!account || !quotaJobHasOwner(job)) { cancelQuotaJob(job); continue; }
    const lastSuccessAt = successfulQuotaTime(META.accountQuotas?.[job.id]), pageOwners = [...job.pageOwners].filter((token) => token.active);
    const force = pageOwners.some((token) => quotaPageOwnerRequiresForce(token, job.id, lastSuccessAt));
    const pageSuccess = !META.accountQuotas?.[job.id]?.errorCategory && job.routingEpoch === null && pageOwners.length > 0 && pageOwners.every((token) => token.force && quotaPageOwnerHasNewSuccess(token, job.id, lastSuccessAt));
    const immediate = pageSuccess ? 'cached' : quotaDemandOutcome(account, { force, protection: job.protection });
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
  if (shuttingDown || (!quotaRoutingEnabled() && !config.accounts.some((a) => quotaProtectionScheduled(a)))) return;
  const arm = () => {
    if (version !== quotaScheduleVersion || epoch !== quotaRoutingEpoch) return;
    const run = async () => {
      if (version !== quotaScheduleVersion || epoch !== quotaRoutingEpoch) return;
      quotaTimer = null;
      // Persistence retries are local writes in the same timer, never new quota jobs.
      const pendingWrites = [...quotaProvisional.values()].filter((entry) => entry.persistRetryAt !== undefined);
      if (pendingWrites.some((entry) => entry.persistRetryAt <= Date.now())) {
        try { saveMeta(); }
        catch (error) {
          console.error(`[额度] 封禁持久化重试失败：${safeReason(error.message)}`);
          for (const entry of pendingWrites) {
            entry.persistFailures = Math.min(4, entry.persistFailures + 1);
            entry.persistRetryAt = Date.now() + Math.min(15 * QUOTA_FAILURE_MS, QUOTA_FAILURE_MS * 2 ** entry.persistFailures);
          }
        }
      }
      const accounts = hrwRank(config.accounts.filter((account) => account.enabled !== false && account.key), 'quota-refresh');
      const dueAccounts = accounts.filter((account) => quotaProtectionDue(account) || (quotaRoutingEnabled() && quotaDemandOutcome(account) === null));
      const start = quotaCursor % Math.max(1, dueAccounts.length), due = [...dueAccounts.slice(start), ...dueAccounts.slice(0, start)].slice(0, 2);
      quotaCursor++; await Promise.all(due.map((account) => requestQuota(account.id, quotaProtectionDue(account) ? { protection: true } : { routingEpoch: epoch })));
      if (quotaRoutingEnabled() || config.accounts.some((account) => quotaProtectionScheduled(account))) arm();
    };
    const now = Date.now();
    const wake = quotaRoutingEnabled() ? (process.env.NODE_ENV === 'test' ? 10 : 1000 + (quotaCursor % 30) * 1000)
      : Math.max(10, Math.min(2147483647, ...config.accounts.filter((account) => quotaProtectionScheduled(account)).map((account) => quotaProtectionWakeAt(account, now) - now)));
    quotaTimer = setTimeout(run, wake); quotaTimer.unref();
  };
  arm();
}
function createSseObserver(maxBytes = 64 * 1024) {
  let pending = Buffer.alloc(0), discardTail = Buffer.alloc(0), discarding = false, usage = null, provider = null, canonical = null, error = null, errorPayload = null, errorEvent = null, normalizedStatus = null, responseBytes = 0, done = false;
  const observeEvent = (buffer) => {
    const payload = buffer.toString('utf8').split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.replace(/^data:\s?/, '')).join('\n');
    if (!payload) return;
    if (payload === '[DONE]') { done = true; return; }
    let event; try { event = JSON.parse(payload); } catch { return; }
    const raw = event?.data && (event.data.choices || event.data.error || event.data.usage) ? event.data : event;
    const normalized = normalizeUsage(raw?.usage); if (normalized) usage = normalized;
    const routing = parseRouting(raw || {}); if (routing.finalProvider) provider = routing.finalProvider; if (routing.canonicalSlug) canonical = routing.canonicalSlug;
    if (typeof raw?.provider === 'string') provider = slugify(raw.provider); if (typeof raw?.model === 'string') canonical = raw.model;
    const eventError = upstreamErrorOf(event); if (!error && eventError) { error = safeReason(errText(eventError)); errorPayload = eventError; errorEvent = Buffer.from(buffer); normalizedStatus = normalizeStatus(200, event, 502); }
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
        const end = match.index; if (end <= maxBytes) observeEvent(pending.subarray(0, end + match[0].length)); pending = pending.subarray(end + match[0].length);
      }
      if (pending.length > maxBytes) { discardTail = pending.subarray(Math.max(0, pending.length - 3)); pending = Buffer.alloc(0); discarding = true; }
    },
    result() { return { usage, provider, canonical, error, errorPayload, errorEvent, normalizedStatus, responseBytes, done }; },
  };
}
function readFirstSseEvent(stream, maxBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0), scanned = 0;
    const cleanup = () => { stream.off('data', onData); stream.off('end', onEnd); stream.off('error', onError); };
    const finish = (complete, dataEvent = null, end = buffer.length, remainder = null) => {
      stream.pause(); cleanup();
      if (remainder?.length) stream.unshift(remainder);
      if (end < buffer.length) stream.unshift(buffer.subarray(end));
      buffer = buffer.subarray(0, end);
      resolve({ buffer, complete, dataEvent });
    };
    const onData = (chunk) => {
      const available = maxBytes - buffer.length;
      const remainder = chunk.length > available ? chunk.subarray(available) : null;
      buffer = Buffer.concat([buffer, remainder ? chunk.subarray(0, available) : chunk]);
      // Scan only complete bounded events; the final chunk may contain bytes after the first data event.
      while (true) {
        const boundary = /\r?\n\r?\n/.exec(buffer.toString('latin1', scanned));
        if (!boundary) break;
        const end = scanned + boundary.index + boundary[0].length;
        if (end > maxBytes) return finish(false, null, buffer.length, remainder);
        const event = buffer.subarray(scanned, end);
        scanned = end;
        if (event.toString('utf8').split(/\r?\n/).some((line) => line.startsWith('data:'))) return finish(true, event, end, remainder);
      }
      if (buffer.length >= maxBytes) finish(false, null, buffer.length, remainder);
    };
    const onEnd = () => { cleanup(); resolve({ buffer, complete: false, dataEvent: null }); };
    const onError = (error) => { cleanup(); reject(error); };
    stream.on('data', onData); stream.once('end', onEnd); stream.once('error', onError); stream.resume();
  });
}

// ---------- 聊天代理 ----------
const CHAT_PATHS = new Set(['/chat/completions', '/v1/chat/completions', '/api/v1/chat/completions']);

const MAX_REQUEST_BODY_BYTES = 50 * 1024 * 1024;
function readBody(req, maxBytes = MAX_REQUEST_BODY_BYTES) {
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
      try { detail?.input?.add(chunk); } catch { if (detail?.input) { detail.input.limited = true; detail.input.limitReason ||= 'other'; detail.input.discard(); } }
      size += chunk.length;
      if (size > maxBytes) return rejectTooLarge();
      chunks.push(chunk);
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      detail?.input?.end();
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
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) rejectTooLarge();
  });
}
async function readJsonBody(req, maxBytes = MAX_REQUEST_BODY_BYTES) {
  try { const body = JSON.parse((await readBody(req, maxBytes)).toString('utf8')); const detail = detailContext.getStore(); if (detail?.profile === 'full') detail.redactor.learn(body); return body; }
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

// 稳定候选快照：configured 非空时权威，否则 stable discovered；exclude/硬隔离/冷却在快照阶段过滤。
// 实际逐次选择由 selectProviderAttempt() 完成——strict 首试按来源顺序，后续与 preferred 都按 Provider-model 24h 成功率。
function buildProviderPlan(modelId, cfg = {}, account = null, now = Date.now()) {
  const configuredOrder = normalizeStringList(cfg.upstreams, 20);
  const discoveredOrder = normalizeStringList(META.models[modelId]?.upstreams, 100);
  const exclude = new Set(normalizeStringList(cfg.exclude, 50));
  const source = configuredOrder.length ? 'configured' : discoveredOrder.length ? 'discovered' : 'auto';
  const mode = cfg.pinMode === 'preferred' ? 'preferred' : 'strict';
  const plan = {
    source, mode, sort: cfg.sort || null, providerCooldownMs: Number(cfg.providerCooldownMs) || 0,
    maxAttempts: cfg.maxRetries === null || cfg.maxRetries === undefined ? Infinity : Math.max(1, Number(cfg.maxRetries) + 1),
    accountGeneration: account ? (providerCircuitAccountGenerations.get(account.id) || 0) : 0,
    routeGeneration: account ? (providerCircuitRouteGenerations.get(providerCircuitRouteKey(account.id, modelId)) || 0) : 0,
    sourceOrder: [], sourceIndex: new Map(), available: [], rates: new Map(), plannedOrder: [], allExcluded: false, retryAfter: null,
  };
  if (source === 'auto') { plan.maxAttempts = 1; return plan; }
  plan.sourceOrder = source === 'configured' ? configuredOrder : discoveredOrder;
  plan.sourceIndex = new Map(plan.sourceOrder.map((provider, index) => [provider, index]));
  const allowed = plan.sourceOrder.filter((provider) => !exclude.has(provider));
  plan.allExcluded = allowed.length === 0;
  plan.available = allowed.filter((provider) => { const state = providerHealthState(modelId, provider); return !state.hardQuarantined && state.cooldownUntil <= now; });
  if (!plan.allExcluded && !plan.available.length) {
    const future = allowed.map((provider) => providerHealthState(modelId, provider)).filter((state) => !state.hardQuarantined && state.cooldownUntil > now).map((state) => state.cooldownUntil);
    plan.retryAfter = future.length ? retryAfterSeconds(Math.min(...future) - now) : null;
  }
  for (const provider of plan.available) plan.rates.set(provider, successHealthProjection('provider-model', modelId, provider, now).successRate);
  plan.plannedOrder = plan.mode === 'preferred'
    ? healthOrderedProviders(plan, plan.available)
    : plan.available.length ? [plan.available[0], ...healthOrderedProviders(plan, plan.available.slice(1))] : [];
  return plan;
}
// Provider-model 24h 直接成功率降序；null 最后，同率/都未知按来源顺序。
function healthOrderedProviders(plan, providers) {
  return [...providers].sort((left, right) => {
    const rateLeft = plan.rates.get(left), rateRight = plan.rates.get(right);
    const unknownLeft = rateLeft === null || rateLeft === undefined, unknownRight = rateRight === null || rateRight === undefined;
    if (unknownLeft && unknownRight) return (plan.sourceIndex.get(left) ?? 0) - (plan.sourceIndex.get(right) ?? 0);
    if (unknownLeft) return 1;
    if (unknownRight) return -1;
    if (rateRight !== rateLeft) return rateRight - rateLeft;
    return (plan.sourceIndex.get(left) ?? 0) - (plan.sourceIndex.get(right) ?? 0);
  });
}
function namedProviderAttempt(plan, provider, extra = {}) {
  return { upstream: provider, attribution: 'named', sort: plan.sort, circuitAccountGeneration: plan.accountGeneration, circuitRouteGeneration: plan.routeGeneration, ...extra };
}
function autoProviderAttempt(plan) {
  return { upstream: null, attribution: 'auto', selection: 'compat-auto', sort: plan.sort, circuitAccountGeneration: plan.accountGeneration, circuitRouteGeneration: plan.routeGeneration };
}
// 每次 named attempt 前从 remaining 重新选择，排除本请求已尝试项。
function selectProviderAttempt(modelId, plan, account, attempted, now = Date.now()) {
  const remaining = plan.available.filter((provider) => !attempted.has(provider));
  if (!remaining.length) return { attempt: null, retryAfter: null };
  // strict 模式的首个 attempt 是 strict-first（本请求首个真实尝试，按来源顺序取首个可用 provider）；
  // strict 的后续重试与 preferred 的全部尝试都按 Provider-model 24h 成功率（health）。这是纯证据标注，不改变选择。
  const strictFirst = plan.mode === 'strict' && attempted.size === 0;
  const ordered = strictFirst ? remaining : healthOrderedProviders(plan, remaining);
  const selection = strictFirst ? 'strict-first' : 'health';
  if (!(plan.providerCooldownMs > 0)) return { attempt: namedProviderAttempt(plan, ordered[0], { selection }), retryAfter: null };
  let blockedUntil = null;
  for (const provider of ordered) {
    const key = providerCircuitKey(account.id, modelId, provider), state = providerCircuitStates.get(key);
    if (!state) return { attempt: namedProviderAttempt(plan, provider, { circuitKey: key, selection }), retryAfter: null };
    if (state.cooldownUntil > now || state.halfOpen) { blockedUntil = Math.min(blockedUntil ?? Infinity, state.cooldownUntil > now ? state.cooldownUntil : now + 1000); continue; }
    return { attempt: namedProviderAttempt(plan, provider, { circuitKey: key, circuitHalfOpen: true, selection }), retryAfter: null };
  }
  return { attempt: null, retryAfter: retryAfterSeconds(Math.max(1000, (blockedUntil ?? now + 1000) - now)) };
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
function ordinaryFailureReason(result, sensitiveValues = []) {
  const seeds = [config.apiKey, config.proxyKey, PROXY_KEY, ...config.accounts.flatMap((account) => [account.key, account.proxyUrl, ...Object.values(account.headers || {})])].filter(Boolean);
  const redactor = new DetailRedactor(seeds);
  redactor.learnHeaders(result?.responseHeaders || {});
  redactor.learn(result?.structuredError);
  return redactor.text(safeReason(result?.note || result?.out?.error?.message || result?.netError || '', sensitiveValues));
}
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
  return Object.hasOwn(config.perModel, modelId) ? config.perModel[modelId] : {};
}
const MAX_RULE_FAILURE_TEXT = 16 * 1024;
function normalizeFailureForRules(value, sensitiveValues = []) {
  return safeReason(errText(value), sensitiveValues).replace(/[\r\n\t]+/g, ' ').slice(0, MAX_RULE_FAILURE_TEXT);
}
function responseHeaderForRule(headers, name) {
  if (!headers) return null;
  for (const [key, raw] of Object.entries(headers)) if (key.toLowerCase() === name.toLowerCase()) {
    const value = Array.isArray(raw) ? raw.join(', ') : String(raw);
    return value.length <= 4096 && !/[\x00-\x08\x0b-\x1f\x7f]/.test(value) ? value : null;
  }
  return null;
}
function resetDelayForRule(reset, headers, now = Date.now()) {
  const fallback = parseStrictDuration(reset.fallback), maximum = parseStrictDuration(reset.max);
  let delay = null;
  if (reset.header) {
    const raw = responseHeaderForRule(headers, reset.header), text = raw?.trim();
    if (text) {
      if (reset.format === 'retry-after') {
        if (/^\d+$/.test(text)) delay = Number(text) * 1000;
        else if (/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),\s\d{2}\s[A-Za-z]{3}\s\d{4}\s\d{2}:\d{2}:\d{2}\sGMT$/.test(text)) { const timestamp = Date.parse(text); if (Number.isFinite(timestamp)) delay = timestamp - now; }
      } else if (reset.format === 'unix-seconds' && /^\d+$/.test(text)) delay = Number(text) * 1000 - now;
      else if (reset.format === 'unix-milliseconds' && /^\d+$/.test(text)) delay = Number(text) - now;
      else if (reset.format === 'duration') delay = parseStrictDuration(text);
    }
  }
  if (!Number.isSafeInteger(delay) || delay <= 0) delay = fallback;
  return Math.max(1, Math.min(maximum, delay));
}
function failureRuleText(result, sensitiveValues = []) {
  return normalizeFailureForRules(result?.failureText ?? result?.structuredError ?? result?.out?.error?.message ?? result?.body?.error?.message ?? result?.error ?? result?.netError ?? '', sensitiveValues);
}
// 顶层有序 retryRules：status 与 body 条件 AND，body 数组 ANY，首条命中即 stop。
// 只返回有界 rule ID/decision/命中类型；needle 与匹配片段只在请求内存在。
function matchRetryRule(result, sensitiveValues = []) {
  const statusCode = Number(result?.normalizedStatus || result?.status);
  const body = failureRuleText(result, sensitiveValues).toLowerCase();
  for (const rule of config.retryRules || []) {
    if (!rule.when.statuses.includes(statusCode)) continue;
    const needles = Array.isArray(rule.when.body_contains) ? rule.when.body_contains : [rule.when.body_contains];
    const matchedBy = ['status'];
    if (!body || !needles.some((needle) => body.includes(needle.toLowerCase()))) continue;
    matchedBy.push('body');
    return { ruleId: rule.id, decision: 'stop', matchedBy, statusCode };
  }
  return { ruleId: null, decision: 'continue', matchedBy: [], statusCode };
}
function matchErrorRule({ result, classification, modelId, provider, sensitiveValues = [] }) {
  const statusCode = Number(result?.normalizedStatus || result?.status);
  const body = failureRuleText(result, sensitiveValues).toLowerCase();
  for (const rule of config.errorRules || []) {
    if (rule.scope === 'provider-model' && !provider) continue;
    if (rule.providers && (!provider || !rule.providers.some((value) => value.toLowerCase() === provider.toLowerCase()))) continue;
    if (rule.models && !rule.models.some((value) => value.toLowerCase() === modelId.toLowerCase())) continue;
    const matchedBy = [];
    if (rule.when.statuses) { if (!rule.when.statuses.includes(statusCode)) continue; matchedBy.push('status'); }
    if (rule.when.body_contains) {
      const needles = Array.isArray(rule.when.body_contains) ? rule.when.body_contains : [rule.when.body_contains];
      if (!body || !needles.some((needle) => body.includes(needle.toLowerCase()))) continue;
      matchedBy.push('body');
    }
    if (rule.when.header) {
      const value = responseHeaderForRule(result?.responseHeaders, rule.when.header.name);
      if (value === null || (rule.when.header.contains && !value.toLowerCase().includes(rule.when.header.contains.toLowerCase()))) continue;
      matchedBy.push('header');
    }
    if (rule.providers) matchedBy.push('provider');
    if (rule.models) matchedBy.push('model');
    return { ruleId: rule.id, scope: rule.scope, action: rule.action, statusCode, matchedBy, ...(rule.action === 'cooldown' ? { cooldownMs: resetDelayForRule(rule.reset, result?.responseHeaders) } : {}) };
  }
  if (classification?.scope === 'account' && ['auth','rate_limit','network'].includes(classification.failureClass)) return { ruleId: null, scope: 'account', action: 'degrade', statusCode, matchedBy: ['default'] };
  if (provider && classification?.scope === 'provider' && ['rate_limit','server','network','timeout','unsupported'].includes(classification.failureClass)) return { ruleId: null, scope: 'provider-model', action: 'degrade', statusCode, matchedBy: ['default'] };
  return { ruleId: null, scope: null, action: 'ignore', statusCode, matchedBy: ['default'] };
}
function persistAccountAction(account, action) {
  if (!account?.id || !action || action.scope !== 'account' || !['cooldown','hard-quarantine'].includes(action.action)) return;
  const now = Date.now();
  const state = { banned: action.action === 'hard-quarantine', hardQuarantined: action.action === 'hard-quarantine', cooldownUntil: action.action === 'cooldown' ? now + action.cooldownMs : 0, statusCode: action.statusCode, reason: action.ruleId ? `rule:${action.ruleId}` : 'rule', ruleId: action.ruleId, updatedAt: now };
  META.accountStates ||= {}; META.accountStates[account.id] = { ...(getAccountState(account.id) || {}), ...state };
  clearProviderCircuitForAccount(account.id);
  invalidateSessionBindingsForAccount(account.id);
  try { saveMeta(); } catch (error) { console.error(`[账号] 状态持久化失败：${safeReason(error.message)}`); }
}
function persistProviderAction(modelId, provider, action) {
  if (!provider || action?.scope !== 'provider-model' || !['cooldown','hard-quarantine'].includes(action.action)) return;
  const previous = providerHealthState(modelId, provider), now = Date.now();
  (META.models[modelId].upstreamStatus ||= {})[provider] = { ...previous, cooldownUntil: action.action === 'cooldown' ? now + action.cooldownMs : 0, hardQuarantined: action.action === 'hard-quarantine', ruleId: action.ruleId, statusCode: action.statusCode, updatedAt: now, note: action.ruleId ? `rule:${action.ruleId}` : 'rule' };
  try { saveMeta(); } catch (error) { console.error(`[Provider] 状态持久化失败：${safeReason(error.message)}`); }
}
function responseHeadersFor(account, forwardedHeaders) {
  return { ...forwardedHeaders, ...(account?.headers || {}), 'Content-Type': 'application/json', Authorization: `Bearer ${account.key}` };
}
async function attemptOnce(modelId, body, attempt, account, forwardedHeaders, signal, attemptOwner, permit = null) {
  const send = injectPrefs(body, modelId, attempt), requestBody = JSON.stringify(send);
  try {
    const res = await clineRequestJSON(`${config.upstreamBase}/chat/completions`, {
      headers: responseHeadersFor(account, forwardedHeaders), body: requestBody, signal, account, attemptOwner, permit,
      attemptMeta: { model: modelId, provider: attempt.upstream ? [attempt.upstream] : [] },
    });
    const responseContentType = normalizeResponseContentType(res.headers);
    const responseBytes = safeResponseBytes(res.text);
    const retryAfter = responseHeader(res.headers, 'retry-after');
    let json = null;
    try { json = JSON.parse(res.text); } catch {}
    if (!json) {
      const status = normalizeStatus(res.status, null, 502);
      return { status, upstreamStatus: res.status, normalizedStatus: status, out: { error: { message: 'upstream returned non-JSON', type: 'upstream_error' } }, routing: {}, structuredError: null, retryAfter, responseHeaders: res.headers, responseContentType, responseBytes, netError: 'non-JSON response', terminalOrigin: res.status >= 400 ? 'upstream_http' : 'upstream_envelope', acc: account, attemptToken: res.attemptToken, detailAttempt: res.detailAttempt, detailResponseBody: res.text, detailCaptureState: 'response-error' };
    }
    const un = unwrap(json, res.status);
    return { status: un.status, upstreamStatus: un.upstreamStatus, normalizedStatus: un.normalizedStatus, out: un.body, routing: un.routing, structuredError: upstreamErrorOf(json), retryAfter, responseHeaders: res.headers, responseContentType, responseBytes, netError: null, terminalOrigin: un.status === 200 ? 'success' : (res.status >= 400 ? 'upstream_http' : 'upstream_envelope'), acc: account, attemptToken: res.attemptToken, detailAttempt: res.detailAttempt, detailResponseBody: un.status === 200 ? null : res.text, detailCaptureState: un.status === 200 ? 'success' : 'response-error' };
  } catch (e) {
    const origin = /timeout/i.test(e.message) ? 'timeout' : account?.proxyUrl ? 'proxy' : 'network';
    return { status: 502, upstreamStatus: 0, normalizedStatus: 502, out: { error: { message: `upstream fetch failed: ${errText(e.message)}`, type: 'upstream_error' } }, routing: {}, structuredError: null, retryAfter: null, responseHeaders: {}, responseContentType: null, responseBytes: 0, netError: errText(e.message), terminalOrigin: origin, acc: account, attemptToken: e.attemptToken || null, detailAttempt: e.detailAttempt || null, detailResponseBody: null, detailCaptureState: 'no-response' };
  }
}
function settleAttempt(modelId, attempt, result, account, { clientDisconnected = false, updateSuccess = true, cfg = {}, sensitiveValues = [], quotaRole = null } = {}) {
  const currentGeneration = providerAttemptGenerationIsCurrent(modelId, account, attempt);
  const detailAttempt = result.detailAttempt || null, detailRoot = detailAttempt?.root || detailContext.getStore();
  const settleDetail = (failed, captureState = result.detailCaptureState) => detailRoot?.settleAttempt(detailAttempt, {
    failed,
    httpStatus: Number.isInteger(result.upstreamStatus) && result.upstreamStatus >= 100 ? result.upstreamStatus : null,
    outcomeStatus: Number.isInteger(result.normalizedStatus) ? result.normalizedStatus : Number.isInteger(result.status) ? result.status : null,
    responseHeaders: result.responseHeaders || {},
    responseBody: failed ? result.detailResponseBody : null,
    responseContentType: result.responseContentType,
    responseComplete: captureState !== 'stream-transport-failed',
    captureState: captureState || (failed ? 'response-error' : 'success'),
  });
  if (clientDisconnected) {
    settleDetail(false, 'client-cancelled');
    const providerCircuitAction = currentGeneration ? settleProviderCircuit(modelId, cfg, account, attempt, { status: 499, normalizedStatus: 499, netError: 'client cancelled', classification: { scope: 'request' } }) : null;
    return { classification: null, policy: null, accountAction: null, healthAction: 'none', providerCircuitAction, retryDecision: null };
  }
  if (result.status === 200) {
    settleDetail(false, result.detailCaptureState || 'success');
    const healthAction = updateSuccess && currentGeneration ? updateProviderHealth(modelId, attempt.upstream, { success: true }) : 'none';
    const providerCircuitAction = updateSuccess && currentGeneration ? settleProviderCircuit(modelId, cfg, account, attempt, result) : null;
    return { classification: null, policy: null, accountAction: null, healthAction, providerCircuitAction, retryDecision: null };
  }
  settleDetail(true);
  const classification = classifyAttemptFailure(result, attempt, account);
  result.classification = classification;
  result.ordinaryReason = ordinaryFailureReason(result, sensitiveValues);
  const policy = matchErrorRule({ result, classification, modelId, provider: attempt.upstream, sensitiveValues });
  const accountAction = policy.scope === 'account' && ['cooldown','hard-quarantine'].includes(policy.action) ? policy : null;
  const quotaSignal = currentGeneration && result.upstreamStatus === 429 && result.terminalOrigin === 'upstream_http' &&
    hasExplicitAccountQuotaEvidence(result.structuredError) &&
    !result.routing?.finalProvider && !hasExplicitProviderEvidence(result.structuredError, attempt.upstream) &&
    hasExplicitAccountQuotaEvidence(failureRuleText(result, sensitiveValues)) &&
    config.accounts.some((saved) => saved.id === account.id && saved.key === account.key && saved.proxyUrl === account.proxyUrl);
  if (quotaSignal) signalQuotaProtection(account);
  const quotaRemovalAction = quotaSignal ? 'protection-pending' : currentGeneration && quotaRole === 'low' && policy.scope === 'account' && policy.action === 'degrade' ? 'waiting-refresh' : null;
  const removesAccount = !!accountAction || !!quotaRemovalAction;
  if (currentGeneration && policy.scope === 'account') persistAccountAction(account, policy);
  if (quotaRemovalAction === 'waiting-refresh') persistLowQuotaHold(account);
  else if (currentGeneration && policy.scope === 'provider-model') persistProviderAction(modelId, attempt.upstream, policy);
  const healthAction = currentGeneration ? (policy.action === 'degrade' ? 'degrade' : policy.action) : 'none';
  if (currentGeneration && policy.scope === 'provider-model' && policy.action === 'degrade') updateProviderHealth(modelId, attempt.upstream, { classification, note: `${classification.evidence}:${classification.failureClass}` });
  const providerCircuitAction = currentGeneration && !removesAccount ? settleProviderCircuit(modelId, cfg, account, attempt, result) : null;
  const retryDecision = matchRetryRule(result, sensitiveValues);
  return { classification, policy, accountAction, quotaRemovalAction, healthAction, providerCircuitAction, retryDecision };
}
function traceAttempt(attempt, result, account, ms, diagnostic) {
  const candidate = result.attemptToken || (result.detailAttempt ? { attemptIndex: result.detailAttempt.attemptIndex, callId: result.detailAttempt.callId } : null);
  const token = candidate && Number.isSafeInteger(candidate.attemptIndex) && candidate.attemptIndex >= 0 && DETAIL_CALL_ID.test(candidate.callId || '') ? candidate : null;
  const detailProfile = token && ['error', 'full', 'raw-error', 'raw-full'].includes(result.detailAttempt?.root?.profile) ? result.detailAttempt.root.profile : null;
  const note = boundedReason(diagnostic.policy?.ruleId ? `rule:${diagnostic.policy.ruleId}` : result.ordinaryReason || result.note);
  return {
    upstream: attempt.upstream, status: result.status, upstreamStatus: result.upstreamStatus, normalizedStatus: result.normalizedStatus,
    providerSelection: PROVIDER_SELECTIONS.has(attempt.selection) ? attempt.selection : null,
    ...(token ? { attemptIndex: token.attemptIndex, callId: token.callId } : {}), ...(detailProfile ? { detailProfile } : {}),
    terminalOrigin: result.terminalOrigin, ms, note: note.reason, reasonTruncated: note.reasonTruncated, account: account.name, accountId: account.id,
    action: diagnostic.policy?.action || null, ruleId: diagnostic.policy?.ruleId || null, ruleScope: diagnostic.policy?.scope || null,
    ruleAction: diagnostic.policy?.action || null, matchedBy: diagnostic.policy?.matchedBy || [],
    providerCircuitAction: diagnostic.providerCircuitAction || null,
    errorScope: diagnostic.classification?.scope || null,
    scopeEvidence: diagnostic.classification?.evidence || null, failureClass: diagnostic.classification?.failureClass || null,
    healthAction: diagnostic.healthAction || 'none', quotaRemovalAction: ['waiting-refresh','protection-pending'].includes(diagnostic.quotaRemovalAction) ? diagnostic.quotaRemovalAction : null, retryAfterMs: diagnostic.policy?.cooldownMs ?? diagnostic.classification?.retryAfterMs ?? null,
    retryRuleId: diagnostic.retryDecision?.ruleId || null,
    retryDecision: diagnostic.retryDecision?.decision || 'continue',
    retryMatchedBy: Array.isArray(diagnostic.retryDecision?.matchedBy) ? diagnostic.retryDecision.matchedBy.filter((value) => RETRY_MATCH_KINDS.has(value)) : [],
    responseContentType: result.responseContentType || null, responseBytes: Number.isSafeInteger(result.responseBytes) ? result.responseBytes : null,
  };
}

// 两级重试：本函数固定一个账号，仅在该账号内按健康计划逐个尝试 provider。
// 只有 account-scoped 错误命中 cooldown/hard-quarantine 时，外层 handleChat 才能终止本链并最多换号一次。
async function runChatChain(req, body, modelId, cfg, account, forwardedHeaders, { stream = false, attemptTimeoutMs = 120000, sensitiveValues = [], attemptOwner = null } = {}) {
  const t0 = Date.now();
  const plan = buildProviderPlan(modelId, cfg, account), trace = [], attempted = new Set();
  let retryStop = false, localRpm = false, localRpmRetryAt = null;
  const lease = attemptOwner?.lease || null;
  const quotaRole = lease?.quotaRole || null;
  // 上一个真实上游尝试的终态；本地 RPM 阻塞时保留它作为历史事实，不被伪造成 upstream 429。
  let rpmBlockedAfter = null;
  const auto = plan.source === 'auto';
  const maxAttempts = auto ? 1 : plan.maxAttempts;
  const nextAttempt = () => auto
    ? (attempted.size ? { attempt: null, retryAfter: null } : { attempt: autoProviderAttempt(plan), retryAfter: null })
    : selectProviderAttempt(modelId, plan, account, attempted);
  const routingFail = (message, retryAfter) => ({ status: 503, upstreamStatus: null, normalizedStatus: 503,
    out: { error: { message, type: 'upstream_error' } }, routing: {}, acc: account, trace, t0, plan,
    retryAfter: retryAfter || null, netError: null, accountAction: null, clientDisconnected: false, retryStop: false, routingFailure: true });
  if (!auto && !plan.available.length) return routingFail(plan.allExcluded ? 'no provider available after exclusions' : 'no provider is currently eligible', plan.retryAfter);
  let last = null;
  let activeReq = null;
  let keepCloseHook = false;
  const clientSocket = req.socket;
  let clientClosed = !!clientSocket?.destroyed;
  const onClientClose = () => { clientClosed = true; if (activeReq) activeReq.abort?.(); };
  clientSocket?.on('close', onClientClose);
  const cleanupClientClose = () => clientSocket?.off('close', onClientClose);
  try {
    for (let index = 0; index < maxAttempts; index++) {
      if (clientClosed) break;
      const selection = nextAttempt();
      const attempt = selection.attempt;
      if (!attempt) {
        if (!trace.length && !clientClosed) return routingFail(plan.available.length ? 'provider half-open probe is already in progress' : 'no provider is currently eligible', selection.retryAfter || plan.retryAfter || (plan.available.length ? 1 : null));
        break;
      }
      attempted.add(attempt.upstream || 'auto');
      if (attempt.circuitHalfOpen) {
        const state = providerCircuitStates.get(attempt.circuitKey);
        if (!state || state.halfOpen) continue;
        state.halfOpen = true; state.updatedAt = Date.now();
      }
      // 每个真实 attempt 独立预留 RPM permit；无 permit 时不等待、不发请求、不换号。
      let permit = null;
      if (lease) {
        const claim = lease.takeRpmPermit();
        if (!claim.ok) { localRpm = true; localRpmRetryAt = claim.retryAt ?? null; rpmBlockedAfter = last; break; }
        permit = claim.permit;
      }
      const t1 = Date.now();
      const ctrl = new AbortController();
      let timedOut = false;
      activeReq = ctrl;
      const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, stream ? SSE_FIRST_EVENT_MS : attemptTimeoutMs);
      try {
        if (stream) {
          const send = injectPrefs(body, modelId, attempt), requestBody = JSON.stringify(send);
          let up = null, netError = null, transportOrigin = null, failedAttemptToken = null, failedDetailAttempt = null;
          try {
            up = await clineRequest(`${config.upstreamBase}/chat/completions`, { headers: responseHeadersFor(account, forwardedHeaders), body: requestBody, signal: ctrl.signal, timeoutMs: SSE_FIRST_EVENT_MS, account, attemptOwner, permit, attemptMeta: { model: modelId, provider: attempt.upstream ? [attempt.upstream] : [] } });
          } catch (e) { netError = timedOut ? 'upstream timeout' : errText(e.message); failedAttemptToken = e.attemptToken || null; failedDetailAttempt = e.detailAttempt || null; }
          const responseContentType = normalizeResponseContentType(up?.headers);
          let isSSE = !!up && up.status === 200 && responseContentType === 'text/event-stream';
          let firstChunk = null, streamErrorBody = null;
          if (isSSE) {
            try {
              const first = await readFirstSseEvent(up.body);
              firstChunk = first.buffer;
              if (!firstChunk.length) { isSSE = false; netError = 'empty stream'; }
              else {
                if (!first.complete) {
                  isSSE = false; netError = 'unexpected stream head';
                } else {
                  const payload = first.dataEvent.toString('utf8').split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.replace(/^data:\s?/, '')).join('\n');
                  const event = payload === '[DONE]' ? null : safeJsonParse(payload, 64 * 1024);
                  const eventError = upstreamErrorOf(event);
                  if (eventError) {
                    isSSE = false; netError = `stream error: ${errText(eventError)}`;
                    streamErrorBody = first.dataEvent;
                  }
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
            if (up.status === 200 && responseContentType === 'text/event-stream') {
              // A rejected SSE head (including comment-only overflow) is already
              // bounded; never read an unbounded tail or wait for this stream to end.
              up.body.destroy();
            } else {
              try { rest = await streamToString(up.body); }
              catch (e) {
                if (!netError) netError = timedOut ? 'upstream timeout' : errText(e.message);
                transportOrigin = timedOut || /timeout/i.test(netError) ? 'timeout' : account.proxyUrl ? 'proxy' : 'network';
              }
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
              structuredError: json ? upstreamErrorOf(json) : null, retryAfter: responseHeader(up.headers, 'retry-after'), responseHeaders: up.headers, responseContentType,
              responseBytes: safeResponseBytes(text), netError: transportOrigin ? netError : null,
              terminalOrigin: up.status >= 400 ? 'upstream_http' : transportOrigin || 'upstream_envelope', acc: account,
              attemptToken: up.attemptToken, detailAttempt: up.detailAttempt,
              detailResponseBody: streamErrorBody || (transportOrigin ? null : text), detailCaptureState: transportOrigin ? 'stream-transport-failed' : 'response-error',
            };
            result.note = errText(un.body?.error?.message || netError);
            const diagnostic = settleAttempt(modelId, attempt, result, account, { clientDisconnected: clientClosed, cfg, sensitiveValues, quotaRole });
            trace.push(traceAttempt(attempt, result, account, ms, diagnostic));
            if (!attempt.upstream) learnAvailableProviders(modelId, result.note);
            last = { ...result, accountAction: diagnostic.accountAction, quotaRemovalAction: diagnostic.quotaRemovalAction, classification: diagnostic.classification };
            if (diagnostic.retryDecision?.decision === 'stop') { retryStop = true; break; }
            if (last.accountAction?.action === 'cooldown' || last.accountAction?.action === 'hard-quarantine' || last.quotaRemovalAction) break;
            continue;
          }
          if (!up) {
            const origin = timedOut || /timeout/i.test(netError || '') ? 'timeout' : account.proxyUrl ? 'proxy' : 'network';
            const result = { status: 502, upstreamStatus: 0, normalizedStatus: 502, out: { error: { message: `upstream fetch failed: ${netError || 'no response'}`, type: 'upstream_error' } }, routing: {}, structuredError: null, retryAfter: null, responseHeaders: {}, responseContentType: null, responseBytes: 0, netError: netError || 'no response', terminalOrigin: origin, acc: account, note: netError || 'no response', attemptToken: failedAttemptToken, detailAttempt: failedDetailAttempt, detailResponseBody: null, detailCaptureState: 'no-response' };
            const diagnostic = settleAttempt(modelId, attempt, result, account, { clientDisconnected: clientClosed, cfg, sensitiveValues, quotaRole });
            trace.push(traceAttempt(attempt, result, account, ms, diagnostic));
            last = { ...result, accountAction: diagnostic.accountAction, quotaRemovalAction: diagnostic.quotaRemovalAction, classification: diagnostic.classification };
            if (diagnostic.retryDecision?.decision === 'stop') { retryStop = true; break; }
            if (last.accountAction?.action === 'cooldown' || last.accountAction?.action === 'hard-quarantine' || last.quotaRemovalAction) break;
            continue;
          }
          up.setIdleTimeout(SSE_STREAM_IDLE_MS);
          clearTimeout(timer);
          keepCloseHook = true;
          const result = { status: 200, upstreamStatus: 200, normalizedStatus: 200, terminalOrigin: 'success', responseHeaders: up.headers, responseContentType, responseBytes: safeResponseBytes(firstChunk), note: 'stream', attemptToken: up.attemptToken, detailAttempt: up.detailAttempt, detailResponseBody: null, detailCaptureState: 'stream-started' };
          const diagnostic = settleAttempt(modelId, attempt, result, account, { updateSuccess: false, cfg, sensitiveValues });
          trace.push(traceAttempt(attempt, result, account, ms, diagnostic));
          return { status: 200, streamUp: up, streamHead: firstChunk, streamAttempt: attempt, streamAttemptToken: up.attemptToken, streamDetailAttempt: up.detailAttempt, acc: account, trace, t0, plan, started: true, cleanupClientClose, retryStop: false, routingFailure: false };
        }
        const result = await attemptOnce(modelId, body, attempt, account, forwardedHeaders, ctrl.signal, attemptOwner, permit);
        if (timedOut && result.status !== 200) { result.terminalOrigin = 'timeout'; result.netError = 'upstream timeout'; result.out = { error: { message: 'upstream fetch failed: upstream timeout', type: 'upstream_error' } }; }
        const ms = Date.now() - t1;
        result.note = result.netError || (result.status !== 200 ? errText(result.out?.error?.message) : 'ok');
        const diagnostic = settleAttempt(modelId, attempt, result, account, { clientDisconnected: clientClosed, cfg, sensitiveValues, quotaRole });
        trace.push(traceAttempt(attempt, result, account, ms, diagnostic));
        if (result.status !== 200 && !attempt.upstream) learnAvailableProviders(modelId, result.note);
        last = { ...result, accountAction: diagnostic.accountAction, quotaRemovalAction: diagnostic.quotaRemovalAction, classification: diagnostic.classification };
        if (result.status === 200) break;
        if (diagnostic.retryDecision?.decision === 'stop') { retryStop = true; break; }
        if (last.accountAction?.action === 'cooldown' || last.accountAction?.action === 'hard-quarantine' || last.quotaRemovalAction) break;
      } catch (error) { permit?.release(); throw error; } finally { clearTimeout(timer); }
    }
  } finally {
    if (!keepCloseHook) cleanupClientClose();
  }
  if (localRpm) {
    // 本地 RPM 终态：不创建 upstream attempt、不评估 error rule、不换号；保留此前真实失败的原始 status/error row。
    const retryAfter = Number.isSafeInteger(localRpmRetryAt) ? Math.max(1, Math.ceil((localRpmRetryAt - Date.now()) / 1000)) : null;
    return { status: 429, upstreamStatus: rpmBlockedAfter?.upstreamStatus ?? null, normalizedStatus: 429, out: { error: { message: 'account rpm limit reached; retry after the rolling window recovers', type: 'rate_limit_error' } },
      routing: {}, acc: account, trace, t0, plan, retryAfter, netError: null, accountAction: null, clientDisconnected: false,
      retryStop: false, routingFailure: false, localRpm: true, lastUpstreamFailure: !!rpmBlockedAfter };
  }
  if (!last && !clientClosed) return routingFail('provider half-open probe is already in progress', plan.retryAfter || 1);
  if (!last) last = { status: 502, upstreamStatus: 0, normalizedStatus: 502, out: { error: { message: 'upstream request aborted', type: 'upstream_error' } }, routing: {}, acc: account, netError: 'upstream request aborted', accountAction: null };
  return { ...last, trace, t0, plan, netError: last.netError || null, clientDisconnected: clientClosed, retryStop, routingFailure: false };
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
  if (detail?.profile === 'full') detail.redactor.learn(body);
  if (!body || typeof body !== 'object' || Array.isArray(body)) return sendJSON(res, 400, { error: { message: 'JSON body must be an object' } });
  const requestedModel = typeof body.model === 'string' ? body.model.trim() : '';
  if (!requestedModel || requestedModel.length > 300) return sendJSON(res, 400, { error: { message: 'valid model is required' } });
  const sensitiveValues = sensitiveMessageValues(body);
  let statisticsFinalized = false;
  const finalizeStatistics = (facts) => { if (statisticsFinalized) return; statisticsFinalized = true; try { commitStatistics({ ...facts, modelId, affinityConfidence: identity?.confidence || 'none' }); } catch (error) { console.error(`[统计] 更新失败：${safeReason(error.message)}`); } };
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
  const attemptOwner = { nextAttemptIndex: 0, bindingSelection: null, lease: null, onAttemptCommit() { commitSessionBindingSelection(this.bindingSelection); } };
  let upstreamAffinitySent = false;
  let providerOrderOverridesSticky = false;
  let selected;
  const affinityFacts = (usage = null) => ({
    sessionSource: identity.source,
    affinityKeyType: identity.keyType,
    affinityConfidence: identity.confidence,
    upstreamPromptCacheKeySource: affinity.source,
    upstreamPromptCacheKeyApplied: upstreamAffinitySent && affinity.usable,
    providerOrderOverridesSticky,
    cacheHit: cacheHitOf(usage),
    bindingSource: selected?.bindingSource || sessionBindingSource(identity),
    bindingResult: selected?.bindingResult || 'not-applicable',
  });
  selected = await acquireAccountLease(identity, { excludeIds: excluded, ownerRequestId: requestId });
  attemptOwner.bindingSelection = selected;
  if (!selected.lease) {
    const protectedAccounts = config.accounts.filter((a) => a.enabled !== false && a.key && (getAccountState(a.id)?.protectionMonthlyAt || getAccountState(a.id)?.protectionShortAt || (quotaProvisional.get(a.id)?.until || 0) > Date.now()));
    const status = enabledAccounts().length ? 429 : 503;
    const protectionBlocked = protectedAccounts.length > 0 && !enabledAccounts().length;
    if (protectionBlocked) {
      const next = protectedAccounts.map((a) => getAccountState(a.id)?.protectionRetryAt || quotaProvisional.get(a.id)?.until || 0).filter((at) => at > Date.now());
      selected.retryAfter = next.length ? Math.min(3600, Math.max(1, Math.ceil((Math.min(...next) - Date.now()) / 1000))) : 60;
      selected.error = 'upstream accounts paused for quota verification or exhausted; monthly bans require administrator release';
    }
    const rpmBlocked = selected.blockedBy === 'rpm' || selected.blockedBy === 'mixed';
    finalizeStatistics({ globalError: true, segments: [] });
    recordChat({ requestId, requestedModel, resolvedModel: modelId, stream: isStream, strategy: selected.strategy, ...affinityFacts(), selectionReason: protectionBlocked ? 'quota-protection' : rpmBlocked ? 'rpm-unavailable' : 'capacity-unavailable', normalizedStatus: status, upstreamStatus: null, blockedBy: selected.blockedBy || null, retryAfter: Number.isSafeInteger(selected.retryAfter) ? selected.retryAfter : null, errorCategory: protectionBlocked ? 'quota_protection' : rpmBlocked ? 'rpm' : 'capacity', error: selected.error, ms: 0 });
    return sendBusy(res, selected.error, selected.retryAfter, status);
  }
  attemptOwner.lease = selected.lease;
  const initialSelection = { ...selected };

  let chain, cfg, targets = [], targetSource = 'auto', targetMode = null, chainLease = selected.lease;
  const completedTrace = [];
  const accountActions = [];
  for (let accountAttempt = 0; accountAttempt < 2; accountAttempt++) {
    const lease = selected.lease;
    chainLease = lease;
    attemptOwner.lease = lease;
    const account = lease.account;
    accountPath.push(account.name);
    cfg = resolveModelConfig(account, modelId);
    try {
      upstreamAffinitySent = true;
      chain = await runChatChain(req, body, modelId, cfg, account, forwardedHeaders, { stream: isStream, sensitiveValues, attemptOwner });
      cleanupSessionBindingSelection(selected);
      targets = chain.plan?.plannedOrder || [];
      targetSource = chain.plan?.source || 'auto';
      targetMode = PROVIDER_MODES.has(chain.plan?.mode) ? chain.plan.mode : null;
      if (cfg?.pinMode === 'preferred' && chain.plan?.source === 'configured' && targets.length > 0) providerOrderOverridesSticky = true;
    } catch (e) {
      cleanupSessionBindingSelection(selected);
      lease.release();
      throw e;
    }
    const action = chain.accountAction;
    if (action) accountActions.push({ account: account.name, action: action.action, statusCode: action.statusCode, ruleId: action.ruleId || null, scope: action.scope });
    if ((action?.action === 'cooldown' || action?.action === 'hard-quarantine' || chain.quotaRemovalAction === 'waiting-refresh' || chain.quotaRemovalAction === 'protection-pending') && !chain.started && accountAttempt === 0 && !chain.retryStop) {
      excluded.add(account.id);
      lease.release();
      chainLease = null;
      selected = await acquireAccountLease(identity, { excludeIds: excluded, ownerRequestId: requestId });
      attemptOwner.bindingSelection = selected;
      attemptOwner.lease = selected.lease || null;
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
    if (detail?.errorOnly) detail.status = up.status;
    const observer = createSseObserver();
    let finalized = false;
    let heartbeat = null, blocked = false, atEventBoundary = true;
    const pendingDrains = new Set();
    const onDrain = (callback) => {
      const drain = () => { pendingDrains.delete(drain); callback(); };
      pendingDrains.add(drain);
      res.once('drain', drain);
    };
    let upstreamTail = Buffer.alloc(0);
    const observeBoundary = (chunk) => {
      // Do not inject a comment into an unfinished data line/event: that would
      // change the model event. Silence during a partial event cannot be pinged safely.
      const bytes = Buffer.from(chunk);
      const suffix = bytes.subarray(Math.max(0, bytes.length - 4));
      upstreamTail = Buffer.concat([upstreamTail, suffix]).subarray(Math.max(0, upstreamTail.length + suffix.length - 4));
      atEventBoundary = /\r?\n\r?\n$/.test(upstreamTail.toString('latin1'));
    };
    const clearHeartbeat = () => { clearTimeout(heartbeat); heartbeat = null; };
    const armHeartbeat = () => {
      clearHeartbeat();
      if (!SSE_HEARTBEAT_MS || finalized || blocked || !atEventBoundary || observer.result().done || res.destroyed || res.writableEnded) return;
      heartbeat = setTimeout(() => {
        heartbeat = null;
        try { writeDownstream(': PING\n\n'); }
        catch (error) { onDownstreamError(error); }
      }, SSE_HEARTBEAT_MS);
      heartbeat.unref?.();
    };
    const writeDownstream = (chunk, cb = null) => {
      clearHeartbeat();
      if (res.write(chunk)) { cb?.(); armHeartbeat(); }
      else {
        blocked = true;
        onDrain(() => { blocked = false; cb?.(); armHeartbeat(); });
      }
    };
    let onDownstreamError;
    let forward;
    let onUpstreamError, onResponseClose;
    const finalize = (error = null, origin = null) => {
      if (finalized) return;
      finalized = true;
      clearHeartbeat();
      for (const drain of pendingDrains) res.off('drain', drain);
      pendingDrains.clear();
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
        const result = { status: observed.normalizedStatus, upstreamStatus: 200, normalizedStatus: observed.normalizedStatus, routing: { finalProvider: observed.provider }, structuredError: observed.errorPayload, failureText: observed.error, retryAfter: null, responseHeaders: up.headers, responseContentType: 'text/event-stream', responseBytes: observed.responseBytes, terminalOrigin: 'upstream_envelope', note: safeReason(observed.error, sensitiveValues), attemptToken: chain.streamAttemptToken, detailAttempt: chain.streamDetailAttempt, detailResponseBody: observed.errorEvent, detailCaptureState: 'response-error' };
        const diagnostic = settleAttempt(modelId, attempt, result, acc, { cfg, sensitiveValues, quotaRole: lease.quotaRole });
        Object.assign(providerAttempt, traceAttempt(attempt, result, acc, providerAttempt.ms, diagnostic));
        const action = diagnostic.accountAction;
        if (action) accountActions.push({ account: acc.name, action: action.action, statusCode: action.statusCode, ruleId: action.ruleId || null, scope: action.scope });
      } else if (error && !disconnected && providerAttempt) {
        const result = { status: 502, upstreamStatus: 200, normalizedStatus: 502, routing: {}, structuredError: null, failureText: error, retryAfter: null, responseHeaders: up.headers, responseContentType: 'text/event-stream', responseBytes: observed.responseBytes, terminalOrigin: /timeout/i.test(String(error)) ? 'timeout' : acc.proxyUrl ? 'proxy' : 'network', note: 'stream transport error', attemptToken: chain.streamAttemptToken, detailAttempt: chain.streamDetailAttempt, detailResponseBody: null, detailCaptureState: 'stream-transport-failed' };
        const diagnostic = settleAttempt(modelId, attempt, result, acc, { cfg, sensitiveValues, quotaRole: lease.quotaRole });
        Object.assign(providerAttempt, traceAttempt(attempt, result, acc, providerAttempt.ms, diagnostic));
        const action = diagnostic.accountAction;
        if (action) accountActions.push({ account: acc.name, action: action.action, statusCode: action.statusCode, ruleId: action.ruleId || null, scope: action.scope });
      } else if (!disconnected && providerAttempt) {
        const result = { status: 200, upstreamStatus: 200, normalizedStatus: 200, routing: { finalProvider: observed.provider }, structuredError: null, retryAfter: null, responseHeaders: up.headers, responseContentType: 'text/event-stream', responseBytes: observed.responseBytes, terminalOrigin: 'success', note: 'stream', attemptToken: chain.streamAttemptToken, detailAttempt: chain.streamDetailAttempt, detailResponseBody: null, detailCaptureState: 'success' };
        const diagnostic = settleAttempt(modelId, attempt, result, acc, { cfg, sensitiveValues });
        Object.assign(providerAttempt, traceAttempt(attempt, result, acc, providerAttempt.ms, diagnostic));
      } else if (providerAttempt) {
        const diagnostic = settleAttempt(modelId, attempt, { status: 499, upstreamStatus: 200, normalizedStatus: 499, responseHeaders: up.headers, attemptToken: chain.streamAttemptToken, detailAttempt: chain.streamDetailAttempt, detailCaptureState: 'client-cancelled' }, acc, { clientDisconnected: true, cfg, sensitiveValues });
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
      finalizeStatistics({ globalError: requestResult === 'failed', finalProvider: observed.provider, usage, clientDisconnect: clientCancelled, segments: statisticsSegments(chain.trace, acc.id, usage, clientCancelled) });
      recordChat({ requestId, requestedModel, resolvedModel: modelId, provider: observed.provider, canonical: observed.canonical, ms: Date.now() - chain.t0, stream: true, result: requestResult, error: safeStreamError, upstreamStatus: providerAttempt?.upstreamStatus ?? null, normalizedStatus, account: acc.name, accountId: acc.id, attempts: chain.trace.map((t) => t.upstream || 'auto'), trace: chain.trace, accountPath, accountActions, ...affinityFacts(usage), strategy: initialSelection.strategy, preferredAccountId: initialSelection.preferredAccountId, preferredAccountName: initialSelection.preferredAccountName, selectionReason: selected.reason, overflow: initialSelection.overflow, pipeline: selected.pipeline || initialSelection.pipeline, targets, providerPlanSource: targetSource, providerMode: targetMode, appliedHeaderNames: Object.keys(acc.headers || {}), proxyError: !!acc.proxyUrl && chain.trace.some((t) => t.upstreamStatus === 0), sensitiveValues });
    };
    forward = new Writable({
      write(c, enc, cb) {
        observer.push(c);
        observeBoundary(c);
        const submit = () => { try { writeDownstream(c, cb); } catch (error) { cb(error); } };
        if (blocked) onDrain(submit);
        else submit();
      },
      final(cb) { clearHeartbeat(); finalize(); res.end(); cb(); },
    });
    onUpstreamError = (e) => { finalize(e.message, 'upstream'); if (!res.destroyed) res.destroy(e); forward.destroy(); };
    onDownstreamError = (e) => { finalize(e.message, 'client_disconnect'); if (!up.body.destroyed) up.body.destroy(); if (!res.destroyed) res.destroy(e); forward.destroy(); };
    onResponseClose = () => { if (res.writableEnded) return; finalize('client disconnected', 'client_disconnect'); if (!up.body.destroyed) up.body.destroy(); forward.destroy(); };
    up.body.on('error', onUpstreamError);
    forward.on('error', onDownstreamError);
    res.on('error', onDownstreamError);
    res.on('close', onResponseClose);
    if (chain.streamHead) {
      observer.push(chain.streamHead);
      try { writeDownstream(chain.streamHead); }
      catch (error) { onDownstreamError(error); return; }
    }
    up.body.pipe(forward);
    return;
  }

  lease?.release();
  const { status, out, routing = {}, acc } = chain;
  const disconnected = chain.clientDisconnected === true;
  if (!out) {
    const result = disconnected ? 'client_cancelled' : 'failed';
    finalizeStatistics({ globalError: !disconnected, clientDisconnect: disconnected, segments: statisticsSegments(chain.trace, null, null, disconnected) });
    recordChat({ requestId, requestedModel, resolvedModel: modelId, stream: false, result, normalizedStatus: disconnected ? 499 : 502, error: disconnected ? null : 'no upstream response', trace: chain.trace, accountPath, accountActions, ...affinityFacts(), strategy: initialSelection.strategy, preferredAccountId: initialSelection.preferredAccountId, preferredAccountName: initialSelection.preferredAccountName, selectionReason: selected.reason, overflow: initialSelection.overflow, pipeline: selected.pipeline || initialSelection.pipeline, targets, providerPlanSource: targetSource, providerMode: targetMode, sensitiveValues });
    if (res.destroyed) return;
    return sendJSON(res, disconnected ? 499 : 502, { error: { message: disconnected ? 'client cancelled request' : 'no upstream response', type: disconnected ? 'client_cancelled' : 'upstream_error' } });
  }
  if (status === 200 && /^cline-pass\//.test(modelId) && !config.knownModels.includes(modelId)) { config.knownModels.push(modelId); saveConfig(); }
  const safeOut = status === 200 ? out : { ...out, error: { ...(out.error || {}), message: safeReason(out?.error?.message || 'upstream error', sensitiveValues) } };
  const usage = status === 200 && !disconnected ? normalizeUsage(routing.usage) : null;
  finalizeStatistics({ globalError: status !== 200 && !disconnected, finalProvider: routing.finalProvider, usage, clientDisconnect: disconnected, segments: statisticsSegments(chain.trace, acc?.id, usage, disconnected) });
  recordChat({
    requestId, requestedModel, resolvedModel: modelId, provider: routing.finalProvider || null, canonical: routing.canonicalSlug || null, ms: Date.now() - chain.t0, stream: false, result: disconnected ? 'client_cancelled' : status === 200 ? 'success' : 'failed',
    attempts: chain.trace.map((t) => t.upstream || 'auto'), trace: chain.trace, error: disconnected ? null : status !== 200 ? safeOut.error.message : null,
    account: acc?.name || null, accountId: acc?.id || null, accountPath, accountActions, accountAction: chain.accountAction?.action || accountActions.at(-1)?.action || null, upstreamStatus: chain.upstreamStatus, normalizedStatus: chain.normalizedStatus, ...affinityFacts(usage),
    strategy: initialSelection.strategy, preferredAccountId: initialSelection.preferredAccountId, preferredAccountName: initialSelection.preferredAccountName, selectionReason: selected.reason, overflow: initialSelection.overflow, pipeline: selected.pipeline || initialSelection.pipeline, targets, providerPlanSource: targetSource, providerMode: targetMode, appliedHeaderNames: Object.keys(acc?.headers || {}), proxyError: !!acc?.proxyUrl && chain.trace.some((t) => t.upstreamStatus === 0), errorCategory: chain.routingFailure ? 'routing' : chain.localRpm ? 'rpm' : null, blockedBy: chain.localRpm ? 'rpm' : null, retryAfter: chain.localRpm && Number.isSafeInteger(chain.retryAfter) ? chain.retryAfter : null, sensitiveValues,
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
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...(res.adminResponse ? {} : { 'Access-Control-Allow-Origin': '*' }) });
  res.end(JSON.stringify(obj));
}
function sendBusy(res, message, retryAfter = 1, status = 429) {
  // retryAfter 为秒；RPM 阻塞时来自最早滚动窗口恢复时间，容量阻塞仍为 bounded 1-30s。
  const seconds = Math.min(3600, Math.max(1, Math.ceil(Number(retryAfter) || 1)));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...(res.adminResponse ? {} : { 'Access-Control-Allow-Origin': '*' }), 'Retry-After': String(seconds) });
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

let activeResponses = 0;
const activeResponseWaiters = new Set();
function trackActiveResponse(res) {
  activeResponses++;
  let scheduled = false;
  const done = () => {
    if (scheduled) return; scheduled = true;
    setImmediate(() => {
      activeResponses = Math.max(0, activeResponses - 1);
      if (!activeResponses) { for (const resolve of [...activeResponseWaiters]) resolve(); activeResponseWaiters.clear(); }
    });
  };
  res.once('finish', done); res.once('close', done);
}
const server = http.createServer((req, res) => {
  trackActiveResponse(res);
  if (shuttingDown) return sendJSON(res, 503, { error: { message: 'server shutting down' } });
  const pathname = new URL(req.url, 'http://local').pathname;
  // Never retain detailed content while migration/recovery is awaiting the first independent password change.
  const profile = adminState?.initialized === true && config.detailedLogging === true && detailRoute(req.method, pathname)
    ? (config.rawBodyLogging === true ? 'raw-full' : 'full')
    : adminState?.initialized === true && config.errorDetailLogging === true && req.method === 'POST' && CHAT_PATHS.has(pathname) ? (config.rawBodyLogging === true ? 'raw-error' : 'error') : null;
  if (profile) {
    if (DetailRoot.active >= 128) { detailedLogs.recordDrop('activeLimit'); return dispatch(req, res); }
    const secrets = profile.startsWith('raw-') ? [] : [config.proxyKey, PROXY_KEY, ...config.accounts.flatMap((account) => [account.key, account.proxyUrl, ...Object.values(account.headers || {})])];
    const root = new DetailRoot(req, res, detailedLogs, secrets, { profile });
    return detailContext.run(root, () => dispatch(req, res));
  }
  return dispatch(req, res);
});
server.keepAliveTimeout = INBOUND_KEEP_ALIVE_MS;
server.headersTimeout = INBOUND_KEEP_ALIVE_MS + 5_000;
async function dispatch(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const modelRoute = CHAT_PATHS.has(p) || p === '/v1/responses' || p === '/v1/models' || p === '/api/v1/models' || p === '/models';
  const managementRoute = p.startsWith('/api/') && p !== '/api/meta' && !modelRoute;
  if (managementRoute) { res.adminResponse = true; res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); }
  if (req.method === 'OPTIONS') {
    if (managementRoute) return sendJSON(res, 403, { error: { message: 'forbidden' } });
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': '*' });
    return res.end();
  }
  try {
    if (req.method === 'GET' && p === '/api/meta') {
      return sendJSON(res, 200, { authRequired: !!PROXY_KEY, proxyBase: publicProxyBase(), configured: isConfigured() });
    }
    if (p.startsWith('/api/auth/')) return await adminAuthRoute(req, res, p);
    if (managementRoute) {
      if (!adminTransportOK(req) || !adminOriginOK(req)) return unauthorized(res);
      const session = adminSession(req);
      if (!session || session.pending || !adminState?.initialized) return unauthorized(res);
      if (!['GET', 'HEAD'].includes(req.method) && session.csrf !== req.headers['x-csrf-token']) return unauthorized(res);
    } else if (modelRoute || p.startsWith('/v1/')) {
      if (!authOK(req)) return unauthorized(res);
    }
    if (req.method === 'POST' && p === '/v1/responses') {
      return sendJSON(res, 501, { error: { message: 'OpenAI Responses API is not supported; use /v1/chat/completions instead', type: 'unsupported_api', param: null, code: 'unsupported_api' } });
    }
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'" });
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
        return { id, config: own ? account.perModel[id] : (config.perModel[id] || {}), configSource: account ? (own ? 'account' : 'inherited') : 'global', meta: projectModelMeta(META.models[id], id) };
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
      try { r = await probeModel(model, selected.lease.account, selected.lease); }
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
      const forcedLease = forced ? tryLeaseResult(forced) : null;
      const selected = forced ? { lease: forcedLease.lease } : await acquireAccountLease({ source: 'test', fingerprint: hmacHex(`test\0${model}`) });
      if (!selected.lease) return sendBusy(res, forcedLease ? blockedByMessage(forcedLease.blockedBy, 'selected account is busy') : 'selected account is busy', forcedLease ? blockedByRetryAfter(forcedLease.blockedBy, forcedLease.retryAt, config.concurrencyWaitMs) : (selected.retryAfter || retryAfterSeconds(config.concurrencyWaitMs)));
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
      const testOwner = { nextAttemptIndex: 0, lease: selected.lease, onAttemptCommit() {} };
      try { chain = await runChatChain(req, body, model, normalizeRouteConfig(cfg), selected.lease.account, {}, { stream: false, attemptTimeoutMs: 180000, attemptOwner: testOwner }); }
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
        if (req.method === 'GET') return sendJSON(res, 200, { detailedLogging: config.detailedLogging === true, errorDetailLogging: config.errorDetailLogging === true, rawBodyLogging: config.rawBodyLogging === true, authRequired: true, maxBodyBytes: MAX_BODY_BYTES, rawMaxBodyBytes: MAX_RAW_BODY_BYTES, maxPayloadBytes: MAX_PAYLOAD_BYTES, maxAgeMs: MAX_AGE_MS, rawMaxAgeMs: RAW_MAX_AGE_MS, maxTotalBytes: MAX_TOTAL_BYTES, health: { ...detailedLogs.health, captureDropped: captureBudget.dropped, retainedPayloadBytes: captureBudget.used } });
        if (req.method === 'POST') {
          const body = await readJsonBody(req), keys = body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body) : [];
          if (!keys.length || keys.length > 3 || keys.some((key) => !['detailedLogging', 'errorDetailLogging', 'rawBodyLogging'].includes(key) || typeof body[key] !== 'boolean')) return sendJSON(res, 400, { error: { message: 'expected one or both boolean logging settings' } });
          const next = { detailedLogging: config.detailedLogging === true, errorDetailLogging: config.errorDetailLogging === true, rawBodyLogging: config.rawBodyLogging === true, ...body };
          try { atomicWriteJson(CONFIG_PATH, { ...config, ...next }); }
          catch { return sendJSON(res, 500, { error: { message: 'logging setting could not be saved' } }); }
          config.detailedLogging = next.detailedLogging; config.errorDetailLogging = next.errorDetailLogging; config.rawBodyLogging = next.rawBodyLogging;
          return sendJSON(res, 200, { ok: true, detailedLogging: config.detailedLogging, errorDetailLogging: config.errorDetailLogging, rawBodyLogging: config.rawBodyLogging });
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
          const { text, release } = await detailedLogs.body(parts[0], parts[2], { holdRaw: true });
          res.once('finish', release); res.once('close', release);
          try { res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' }); return res.end(text); }
          catch (error) { release(); throw error; }
        }
        return sendJSON(res, 400, { error: { message: 'invalid detailed log identity' } });
      }
    }
    if ((req.method === 'GET' || req.method === 'DELETE') && (p === '/api/logs/requests' || p === '/api/logs/errors')) {
      const store = p.endsWith('/errors') ? errorLogs : requestLogs;
      if (req.method === 'DELETE') { await store.clear(); return sendJSON(res, 200, { ok: true }); }
      const allowed = p.endsWith('/errors')
        ? ['from','to','requestId','model','requestedModel','resolvedModel','account','accountId','accountName','status','upstreamStatus','category','provider','targetProvider','accountAction','ruleId','ruleScope','ruleAction','errorScope','scopeEvidence','failureClass','healthAction','responseContentType']
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
      // 已保存 accountId 的 proxy 测试是绑定该账号的真实 chat attempt，受同一 permit broker 约束。
      const leased = tryLeaseResult(account);
      if (!leased.lease) return sendBusy(res, blockedByMessage(leased.blockedBy, 'selected account is busy'), blockedByRetryAfter(leased.blockedBy, leased.retryAt, config.concurrencyWaitMs));
      const t0 = Date.now();
      try {
        const model = config.knownModels[0];
        const claim = leased.lease.takeRpmPermit();
        if (!claim.ok) return sendBusy(res, 'account rpm limit reached', blockedByRetryAfter('rpm', claim.retryAt, config.concurrencyWaitMs));
        const result = await clineRequestJSON(`${config.upstreamBase}/chat/completions`, { headers: responseHeadersFor(account, {}), body: JSON.stringify({ model, messages: [], max_tokens: 1 }), proxyUrl, ephemeralProxy: true, account, timeoutMs: 15000, attemptMeta: { model, provider: [] }, permit: claim.permit });
        return sendJSON(res, 200, { ok: result.status > 0, proxyType: new URL(proxyUrl).protocol.replace(':', ''), ms: Date.now() - t0, status: result.status });
      } catch (e) {
        let reason = String(e.message || 'proxy error');
        try { const u = new URL(proxyUrl); for (const secret of [proxyUrl, decodeURIComponent(u.username), decodeURIComponent(u.password)].filter(Boolean)) reason = reason.split(secret).join('[REDACTED]'); } catch {}
        return sendJSON(res, 200, { ok: false, proxyType: new URL(proxyUrl).protocol.replace(':', ''), ms: Date.now() - t0, errorCategory: 'proxy', reason: safeReason(reason) });
      } finally { leased.lease.release(); }
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
      const models = statisticsModelIds().map((id) => { const recent24h = projectAggregate(aggregateModelRange(id, generatedAt)); return { id, recent24h, coverage: modelCoverage(id, generatedAt), providerStatistics: modelProviderProjection(id,generatedAt) }; });
      return sendJSON(res, 200, { generatedAt, window: { kind: 'last-1440-minutes', from: (Math.floor(generatedAt/60000)-1439)*60000, to: generatedAt }, lifetime: { global: projectAggregate(META.statistics.lifetime.global) }, recent24h: { global: projectAggregate(recentGlobal) }, routingCoverage: routingCoverage(generatedAt), accounts, models, referencePrices: { current: REFERENCE_PRICE, versions: META.statistics.priceVersions }, migration: META.statistics.migration });
    }
    if (req.method === 'GET' && p === '/api/accounts') {
      clearExpiredCooldowns();
      const cacheRoles = cachePoolRoles();
      return sendJSON(res, 200, {
        accounts: config.accounts.map((a) => { const recent = projectAggregate(aggregateRange(a.id).aggregate),lifetime=META.statistics.lifetime.accounts[a.id]; return { ...a, state: getAccountState(a.id), activeCount: activeCounts.get(a.id) || 0, rpm: rpmProjection(a), health: healthProjection(a), quota: quotaProjection(a.id), cachePoolRole: cacheRoles.get(a.id) ?? null, cachePoolQuotaRole: configuredCachePoolLowQuotaSize() > 0 && cacheRoles.get(a.id) === 'active' ? ({ hot: 'high', warm: 'low', unknown: 'unknown' }[quotaProjection(a.id).pool] || null) : null, statistics: { recent24h: recent, lifetimeRequests: lifetime ? lifetime.requests : 0, lifetimeErrors: lifetime ? lifetime.errors : 0 } }; }),
        mode: config.accountMode, active: config.activeAccount, concurrencyWaitMs: config.concurrencyWaitMs,
        quotaProtection: config.quotaProtection, errorRules: config.errorRules, retryRules: config.retryRules, accountErrorRules: config.accountErrorRules, accountContentErrorRules: config.accountContentErrorRules, accountPipeline: config.accountPipeline,
        cachePool: { minSize: configuredCachePoolSize(), maxSize: configuredCachePoolMaxSize(), lowSize: configuredCachePoolLowQuotaSize(), targetSize: configuredCachePoolTargetSize(), actual: cachePoolMembership(enabledAccounts())?.actual || { high: 0, low: 0, unknown: 0 }, binding: sessionBindingSummary() },
        stats: Object.fromEntries(config.accounts.map((a) => [a.name, { requests: META.statistics.lifetime.accounts[a.id]?.requests ?? 0 }])),
      });
    }
    if (req.method === 'POST' && p === '/api/accounts') {
      const body = await readJsonBody(req);
      if (!body || typeof body !== 'object' || !Array.isArray(body.accounts)) return sendJSON(res, 400, { error: { message: 'accounts array is required' } });
      if (!ACCOUNT_MODES.has(body.mode)) return sendJSON(res, 400, { error: { message: 'invalid account mode' } });
      const wait = Number(body.concurrencyWaitMs ?? 2000);
      if (!Number.isInteger(wait) || wait < 0 || wait > 30000) return sendJSON(res, 400, { error: { message: 'concurrencyWaitMs must be an integer from 0 to 30000' } });
      let requestedErrorRules = config.errorRules, requestedPipeline = config.accountPipeline, requestedRetryRules = config.retryRules, requestedProtection = config.quotaProtection;
      try {
        if (body.errorRules !== undefined) requestedErrorRules = normalizeErrorRules(body.errorRules, { strict: true });
        else {
          const legacy = legacyRuleProjection(config.errorRules);
          if (body.accountErrorRules !== undefined) {
            const ruleError = validateAccountErrorRulesInput(body.accountErrorRules); if (ruleError) throw new Error(ruleError);
            if (JSON.stringify(normalizeAccountErrorRules(body.accountErrorRules)) !== JSON.stringify(legacy.accountErrorRules)) return sendJSON(res, 409, { error: { message: 'legacy error-rule fields cannot modify canonical errorRules' } });
          }
          if (body.accountContentErrorRules !== undefined && JSON.stringify(normalizeAccountContentErrorRules(body.accountContentErrorRules, { strict: true })) !== JSON.stringify(legacy.accountContentErrorRules)) return sendJSON(res, 409, { error: { message: 'legacy error-rule fields cannot modify canonical errorRules' } });
        }
        if (body.retryRules !== undefined) requestedRetryRules = normalizeRetryRules(body.retryRules, { strict: true });
        if (body.quotaProtection !== undefined) requestedProtection = normalizeQuotaProtection(body.quotaProtection, { strict: true });
        if (body.accountPipeline !== undefined) requestedPipeline = normalizeAccountPipeline(body.accountPipeline, {
          strict: true,
          fallbackOrder: config.accountPipeline.order,
          fallbackCachePoolSize: configuredCachePoolSize(),
          fallbackCachePoolMaxSize: configuredCachePoolMaxSize(),
          fallbackCachePoolLowQuotaSize: config.accountPipeline.cachePoolLowQuotaSize,
          fallbackSessionBindingExplicitTtlMs: config.accountPipeline.sessionBindingExplicitTtlMs,
          fallbackSessionBindingFallbackTtlMs: config.accountPipeline.sessionBindingFallbackTtlMs,
          fallbackSessionBindingMaxEntries: config.accountPipeline.sessionBindingMaxEntries,
        });
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
        // maxRpm 是 canonical 严格整数 0..100000；省略该字段（旧客户端）在 normalizeAccount 中按 stable id 保留。
        if (a.maxRpm !== undefined && (!Number.isInteger(a.maxRpm) || a.maxRpm < 0 || a.maxRpm > 100000)) return sendJSON(res, 400, { error: { message: `invalid maxRpm at index ${i}` } });
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
      config.concurrencyWaitMs = wait; config.errorRules = requestedErrorRules; config.retryRules = requestedRetryRules; config.quotaProtection = requestedProtection; Object.assign(config, legacyRuleProjection(requestedErrorRules)); config.accountPipeline = requestedPipeline;
      normalizeCachePoolTarget(requestedPipeline);
      for (const [id, previous] of previousById) {
        const current = accs.find((a) => a.id === id);
        if (!current) { invalidateQuotaAccount(id, { clearSnapshot: true, deleted: true }); clearProviderCircuitForAccount(id); invalidateSessionBindingsForAccount(id); clearRpmState(id); }
        else if (current.key !== previous.key || current.proxyUrl !== previous.proxyUrl) { invalidateQuotaAccount(id, { clearSnapshot: true }); clearProviderCircuitForAccount(id); invalidateSessionBindingsForAccount(id); const month = getAccountState(id)?.protectionMonthlyAt || 0; if (month) META.accountStates[id] = { protectionMonthlyAt: month }; else delete META.accountStates[id]; clearRpmState(id); }
        else if (previous.enabled !== false && current.enabled === false) { invalidateQuotaAccount(id); clearProviderCircuitForAccount(id); invalidateSessionBindingsForAccount(id); }
        else for (const model of new Set([...Object.keys(previous.perModel || {}), ...Object.keys(current.perModel || {})])) if (JSON.stringify(previous.perModel?.[model]) !== JSON.stringify(current.perModel?.[model])) clearProviderCircuitForRoute(id, model);
      }
      if (quotaRoutingWasEnabled !== quotaRoutingEnabled()) advanceQuotaRoutingEpoch();
      // Enabling role-aware routing must evaluate the latest already-persisted
      // successful snapshot immediately, not wait behind its five-minute cache.
      if (cachePoolEnabled() && configuredCachePoolLowQuotaSize() > 0) for (const account of accs) {
        const quota = META.accountQuotas?.[account.id];
        if (quota?.snapshot && quota.lastSuccessAt === quota.snapshot.fetchedAt) reconcileQuotaDisposition(account.id, quota.snapshot);
      }
      for (const id of Object.keys(META.accountStates || {})) if (!seen.has(id)) delete META.accountStates[id];
      for (const id of Object.keys(META.statistics.lifetime.accounts)) if (!seen.has(id)) delete META.statistics.lifetime.accounts[id];
      for (const bucket of META.statistics.minuteBuckets) for (const id of new Set([...Object.keys(bucket.accounts),...Object.keys(bucket.health),...Object.keys(bucket.accountHealth)])) if (!seen.has(id)) { delete bucket.accounts[id]; delete bucket.health[id]; delete bucket.accountHealth[id]; }
      for (const id of Object.keys(META.statistics.recentCoverage.accountIncompleteAt)) if (!seen.has(id)) delete META.statistics.recentCoverage.accountIncompleteAt[id];
      for (const id of Object.keys(META.statistics.recentCoverage.accountHealthIncompleteAt)) if (!seen.has(id)) delete META.statistics.recentCoverage.accountHealthIncompleteAt[id];
      for (const id of activeCounts.keys()) if (!seen.has(id)) activeCounts.delete(id);
      // maxRpm=0 即时关闭限制并清理无用状态；disable/re-enable 保留窗口内已提交事实。
      for (const id of [...rpmWindows.keys()]) if (!seen.has(id) || !rpmLimit(accs.find((a) => a.id === id))) clearRpmState(id);
      pruneOrphanProviderStates();
      reconcileSessionBindings();
      saveConfig(); saveMeta(); RR_COUNTER = 0; strategyCounters.clear(); pruneProxyAgents(); scheduleQuotaRefresh();
      return sendJSON(res, 200, { ok: true, accounts: accs.length, mode: config.accountMode, active: config.activeAccount });
    }
    if (req.method === 'POST' && p === '/api/accounts/quota-recover') {
      const body = await readJsonBody(req);
      if (!isPlainObject(body) || Object.keys(body).length !== 1 || typeof body.id !== 'string' || !config.accounts.some((a) => a.id === body.id)) return sendJSON(res, 400, { error: { message: 'expected exact existing account id' } });
      const state = getAccountState(body.id);
      if (!state?.protectionMonthlyAt) return sendJSON(res, 409, { error: { message: 'account has no monthly quota ban' } });
      const accountStates = { ...META.accountStates, [body.id]: { ...state, protectionMonthlyAt: 0 } };
      atomicWriteJson(META_PATH, { ...META, accountStates });
      META.accountStates = accountStates;
      for (const [id, pending] of quotaProvisional) if (id === body.id || pending.persistRetryAt !== undefined) quotaProvisional.delete(id);
      reconcileSessionBindings(); notifyCapacityWaiters();
      return sendJSON(res, 200, { ok: true });
    }
    if (req.method === 'POST' && p === '/api/accounts/recover') {
      const body = await readJsonBody(req);
      const id = String(body?.id || '');
      if (!config.accounts.some((a) => a.id === id)) return sendJSON(res, 400, { error: { message: 'unknown account id' } });
      clearRuleAccountState(id); reconcileSessionBindings(); saveMeta();
      return sendJSON(res, 200, { ok: true });
    }
    if (req.method === 'POST' && p === '/api/providers/recover') {
      const body = await readJsonBody(req);
      if (!isPlainObject(body) || Object.keys(body).length !== 2 || typeof body.model !== 'string' || typeof body.provider !== 'string') return sendJSON(res, 400, { error: { message: 'expected exact model and provider' } });
      const model = body.model.trim(), provider = body.provider.trim();
      if (!validStatisticModelId(model) || !/^[a-z0-9][a-z0-9._/-]{0,199}$/i.test(provider)) return sendJSON(res, 400, { error: { message: 'invalid model or provider' } });
      const state = META.models?.[model]?.upstreamStatus?.[provider];
      if (!state) return sendJSON(res, 400, { error: { message: 'unknown model/provider state' } });
      META.models[model].upstreamStatus[provider] = { ...normalizeProviderHealthState(state), cooldownUntil: 0, hardQuarantined: false, ruleId: null, statusCode: null, updatedAt: Date.now() };
      saveMeta();
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
      // 只有绑定已保存账号的测试才受账号 maxRpm 约束；临时 credential 测试没有配置 owner，明确不计。
      const leased = saved ? tryLeaseResult(saved) : null;
      if (leased && !leased.lease) return sendBusy(res, blockedByMessage(leased.blockedBy, 'selected account is busy'), blockedByRetryAfter(leased.blockedBy, leased.retryAt, config.concurrencyWaitMs));
      const t0 = Date.now();
      const model = config.knownModels[0] || 'cline-pass/glm-5.3-flash';
      let json;
      try {
        const claim = claimManagementPermit(leased?.lease || null);
        if (!claim.ok) return sendBusy(res, 'account rpm limit reached', blockedByRetryAfter('rpm', claim.retryAt, config.concurrencyWaitMs));
        ({ json } = await accountFetchJSON(`${config.upstreamBase}/chat/completions`, {
          headers: chatHeaders(k), body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Say OK' }], max_tokens: 512 }), attemptMeta: { model, provider: [] }, permit: claim.permit,
        }, 120000, account));
      } catch (e) { return sendJSON(res, 200, { ok: false, ms: Date.now() - t0, error: safeReason(e.message), errorCategory: proxyUrl ? 'proxy' : 'network' }); }
      finally { leased?.lease.release(); }
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
      if (body.proxyKey !== undefined) {
        const candidate = String(body.proxyKey).trim();
        if (candidate && adminState?.initialized && adminPasswordOK(candidate)) return sendJSON(res, 400, { error: { message: 'client key must differ from admin password' } });
        config.proxyKey = candidate;
      }
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
      try { results = await validateUpstreams(model, selected.lease.account, selected.lease); }
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
        pruneOrphanProviderStates();
        saveConfig(); saveMeta();
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
      pruneOrphanProviderStates();
      saveConfig(); saveMeta();
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

const inboundSockets = new Set();
server.on('connection', (socket) => { inboundSockets.add(socket); socket.once('close', () => inboundSockets.delete(socket)); });
const SHUTDOWN_TIMEOUT_MS = process.env.NODE_ENV === 'test'
  ? Math.min(30_000, Math.max(100, Number(process.env.CLINE_PASS_SHUTDOWN_MS) || 10_000))
  : 10_000;
let shutdownPromise = null;
function beforeDeadline(promise, deadline) {
  const remaining = Math.max(0, deadline - Date.now());
  return Promise.race([
    Promise.resolve(promise).then(() => true, () => false),
    new Promise((resolve) => { setTimeout(() => resolve(false), remaining); }),
  ]);
}
function stopQuotaWork() {
  clearTimeout(quotaTimer); quotaTimer = null; quotaScheduleVersion++;
  for (const job of [...quotaJobs.values()]) { detachQuotaJob(job); cancelQuotaJob(job); }
  pumpQuotaQueue();
}
function destroyRuntimeConnections() {
  server.closeAllConnections?.();
  for (const socket of inboundSockets) socket.destroy();
  for (const agent of proxyAgents.values()) agent.destroy();
  proxyAgents.clear();
  directHttpAgent.destroy(); directHttpsAgent.destroy();
}
function shutdown(signal) {
  if (shutdownPromise) return shutdownPromise;
  shuttingDown = true;
  shutdownPromise = (async () => {
    const deadline = Date.now() + SHUTDOWN_TIMEOUT_MS;
    stopQuotaWork();
    try { server.close(); } catch {}
    server.closeIdleConnections?.();
    const finalizersDone = activeResponses === 0 || await beforeDeadline(new Promise((resolve) => activeResponseWaiters.add(resolve)), deadline);
    if (!finalizersDone) {
      console.error(`[退出] ${signal} 等待活动请求超时，正在强制关闭连接`);
      destroyRuntimeConnections();
      void ordinaryLogs.close(); void detailedLogs.close();
      process.exit(0);
      return;
    }
    const drained = await beforeDeadline(Promise.allSettled([ordinaryLogs.close(), detailedLogs.close()]), deadline);
    if (!drained) console.error(`[退出] ${signal} 日志 drain 超时，正在强制收敛`);
    destroyRuntimeConnections();
    process.exit(0);
  })();
  return shutdownPromise;
}
process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
process.once('SIGINT', () => { void shutdown('SIGINT'); });

server.on('error', (e) => {
  if (shuttingDown) return;
  console.error(`[错误] 端口 ${config.port} 监听失败（可能被占用）：${e.message}`);
  process.exit(1);
});

const BIND_HOST = process.env.BIND_HOST || '127.0.0.1';
server.listen(config.port, BIND_HOST, () => {
  console.log(`Cline Pass 上游控制台:  http://127.0.0.1:${config.port}/`);
  console.log(`OpenAI 兼容代理地址:   http://127.0.0.1:${config.port}/v1`);
  scheduleQuotaRefresh();
});
