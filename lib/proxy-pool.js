// 全局出口代理池：配置规范化、条目 id、进程内选择/冷却/RPM/退役运行时。
// 纯逻辑；agent 创建与销毁、时钟、随机数都由调用方注入。状态只在内存中，不落盘。
import crypto from 'node:crypto';

const PROXY_PROTOCOLS = ['http:', 'https:', 'socks5:', 'socks5h:'];

export function normalizeProxyUrl(value, { strict = false } = {}) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    if (raw.length > 2048) throw new Error('too long');
    const u = new URL(raw);
    if (!PROXY_PROTOCOLS.includes(u.protocol) || !u.hostname || u.search || u.hash || (u.pathname && u.pathname !== '/')) throw new Error('invalid');
    if (u.port && (!Number.isInteger(Number(u.port)) || Number(u.port) < 1 || Number(u.port) > 65535)) throw new Error('port');
    return u.toString();
  } catch { if (strict) throw new Error('proxyUrl must be an http, https, socks5 or socks5h URL without path/query/hash'); console.warn('[配置] 已禁用一个非法账号代理 URL'); return ''; }
}

// 与 server.js proxyEndpointKey() 逐字等价：metadata.proxyHealth 的键必须保持旧镜像可读。
export function proxyEndpointKey(proxyUrl) {
  if (!proxyUrl || typeof proxyUrl !== 'string') return null;
  try {
    const u = new URL(proxyUrl);
    if (!PROXY_PROTOCOLS.includes(u.protocol)) return null;
    if ((u.pathname && u.pathname !== '/') || u.search || u.hash || !u.hostname || u.hostname.length > 253) return null;
    return `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ''}`;
  } catch { return null; }
}

export const MAX_POOL_ENTRIES = 2000;
// 隐式的"本机直连"条目：不是代理 URL，不会出现在配置的 entries 里，只由 includeDirect 在运行时加入池。
export const DIRECT_POOL_URL = 'direct://local';
export const POOL_STRATEGIES = Object.freeze(['round-robin', 'random']);
export const POOL_SOURCES = Object.freeze(['manual', 'floppydata']);
export const FLOPPYDATA_TYPES = Object.freeze(['residential', 'mobile', 'datacenter']);
export const FLOPPYDATA_PROTOCOLS = Object.freeze(['socks5', 'http', 'https']);
export const FLOPPYDATA_ROTATIONS = Object.freeze([-1, 0, 5, 10, 15, 20, 60]);

export const FLOPPYDATA_DEFAULTS = Object.freeze({
  apiKey: '', apiBase: 'https://api.floppydata.net', type: 'residential', country: 'US', state: '', city: '',
  protocol: 'socks5', rotation: 0, count: 100, refreshIntervalMs: 180000,
});
export const PROXY_POOL_DEFAULTS = Object.freeze({
  enabled: false, strategy: 'round-robin', source: 'manual', egressRetries: 2,
  throttleCooldownMs: 60000, failureCooldownMs: 30000, connectTimeoutMs: 10000, maxRpmPerProxy: 0,
  entries: Object.freeze([]), floppydata: FLOPPYDATA_DEFAULTS,
});
const POOL_INTEGERS = { egressRetries: [0, 5], throttleCooldownMs: [1000, 600000], failureCooldownMs: [1000, 600000], connectTimeoutMs: [1000, 60000], maxRpmPerProxy: [0, 10000] };
const FLOPPY_INTEGERS = { count: [1, 500], refreshIntervalMs: [60000, 3600000] };

const plain = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
// 错误信息只带字段路径，绝不带 URL、凭据或 apiKey 的值。
const invalid = (path, message) => { throw new Error(`${path} ${message}`); };
function rejectUnknown(value, allowed, path) {
  for (const key of Object.keys(value)) {
    if (Object.hasOwn(allowed, key)) continue;
    // 只回显形如标识符的键名；任意文本（可能是误粘贴的凭据）不进入错误信息。
    if (/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)) invalid(`${path}.${key}`, 'is not a known field');
    invalid(path, 'contains an unknown field');
  }
}
function boundedInteger(value, [min, max], path) {
  if (!Number.isSafeInteger(value) || value < min || value > max) invalid(path, `must be an integer from ${min} to ${max}`);
  return value;
}
function oneOf(value, list, path) {
  if (!list.includes(value)) invalid(path, `must be one of ${list.join(', ')}`);
  return value;
}
function normalizeApiBase(value, path) {
  if (typeof value !== 'string' || !value || value.length > 2048) invalid(path, 'must be an http(s) URL without path/query/hash');
  let u;
  try { u = new URL(value.trim()); } catch { invalid(path, 'must be an http(s) URL without path/query/hash'); }
  if (!['http:', 'https:'].includes(u.protocol) || !u.hostname || u.username || u.password || u.search || u.hash || (u.pathname && u.pathname !== '/')) invalid(path, 'must be an http(s) URL without credentials/path/query/hash');
  return u.origin;
}
function normalizeRegion(value, path) {
  if (typeof value !== 'string' || value.length > 64 || /[\x00-\x1f\x7f]/.test(value)) invalid(path, 'must be a string of at most 64 characters');
  return value.trim();
}
function normalizeFloppyData(value, path) {
  if (value === undefined) return { ...FLOPPYDATA_DEFAULTS };
  if (!plain(value)) invalid(path, 'must be an object');
  rejectUnknown(value, FLOPPYDATA_DEFAULTS, path);
  const out = { ...FLOPPYDATA_DEFAULTS, ...value };
  if (typeof out.apiKey !== 'string' || (out.apiKey !== '' && !/^[\x21-\x7e]{1,256}$/.test(out.apiKey))) invalid(`${path}.apiKey`, 'must be 1-256 visible ASCII characters');
  out.apiBase = normalizeApiBase(out.apiBase, `${path}.apiBase`);
  oneOf(out.type, FLOPPYDATA_TYPES, `${path}.type`);
  if (typeof out.country !== 'string' || !/^[A-Za-z]{2}$/.test(out.country)) invalid(`${path}.country`, 'must be a two-letter country code');
  out.country = out.country.toUpperCase();
  out.state = normalizeRegion(out.state, `${path}.state`);
  out.city = normalizeRegion(out.city, `${path}.city`);
  oneOf(out.protocol, FLOPPYDATA_PROTOCOLS, `${path}.protocol`);
  oneOf(out.rotation, FLOPPYDATA_ROTATIONS, `${path}.rotation`);
  for (const [key, range] of Object.entries(FLOPPY_INTEGERS)) boundedInteger(out[key], range, `${path}.${key}`);
  return out;
}
function strictProxyPool(value, secret) {
  const path = 'proxyPool';
  if (!plain(value)) invalid(path, 'must be an object');
  rejectUnknown(value, PROXY_POOL_DEFAULTS, path);
  const out = { ...PROXY_POOL_DEFAULTS, ...value };
  if (typeof out.enabled !== 'boolean') invalid(`${path}.enabled`, 'must be boolean');
  oneOf(out.strategy, POOL_STRATEGIES, `${path}.strategy`);
  oneOf(out.source, POOL_SOURCES, `${path}.source`);
  for (const [key, range] of Object.entries(POOL_INTEGERS)) boundedInteger(out[key], range, `${path}.${key}`);
  if (!Array.isArray(out.entries) || out.entries.length > MAX_POOL_ENTRIES) invalid(`${path}.entries`, `must be an array of at most ${MAX_POOL_ENTRIES} URLs`);
  const entries = [], seen = new Map(), ids = new Map();
  for (const [index, raw] of out.entries.entries()) {
    const at = `${path}.entries[${index}]`;
    let url = '';
    if (typeof raw === 'string') { try { url = normalizeProxyUrl(raw, { strict: true }); } catch {} }
    if (!url) invalid(at, 'must be an http, https, socks5 or socks5h URL without path/query/hash');
    if (seen.has(url)) invalid(at, `duplicates ${path}.entries[${seen.get(url)}]`);
    seen.set(url, index);
    if (secret !== undefined) {
      const id = entryIdFor(secret, url);
      if (ids.has(id)) invalid(at, `entry id collides with ${path}.entries[${ids.get(id)}]`);
      ids.set(id, index);
    }
    entries.push(url);
  }
  out.entries = entries;
  out.floppydata = normalizeFloppyData(value.floppydata, `${path}.floppydata`);
  if (out.enabled && out.source === 'manual' && !entries.length) invalid(`${path}.entries`, 'must contain at least one URL when the manual source is enabled');
  if (out.enabled && out.source === 'floppydata' && !out.floppydata.apiKey) invalid(`${path}.floppydata.apiKey`, 'is required when the floppydata source is enabled');
  return {
    enabled: out.enabled, strategy: out.strategy, source: out.source, egressRetries: out.egressRetries,
    throttleCooldownMs: out.throttleCooldownMs, failureCooldownMs: out.failureCooldownMs, connectTimeoutMs: out.connectTimeoutMs,
    maxRpmPerProxy: out.maxRpmPerProxy, entries, floppydata: out.floppydata,
  };
}
// undefined -> 默认（关闭）对象；是否写回 config 由调用方按字段是否存在决定。
// strict 抛出带路径的错误；非 strict 遇到任何非法项整体退回关闭的默认值。
// 传入 secret 时额外检查条目 id 碰撞（手动来源保存时 400）。
export function normalizeProxyPool(value, { strict = true, secret } = {}) {
  if (value === undefined) return strictProxyPool({}, secret);
  try { return strictProxyPool(value, secret); }
  catch (error) {
    if (strict) throw error;
    console.warn('[配置] 已禁用非法代理池配置');
    return strictProxyPool({}, secret);
  }
}

// 按客户端密钥决定是否使用代理池（config 顶层 proxyPoolClientKeys）。缺省即"全部使用"，与只有全局开关时一致。
// 旧镜像保留但忽略这个顶层字段；proxyPool 与 clientKeys 行结构保持不变。
export const POOL_CLIENT_KEY_MODES = Object.freeze(['on', 'off']);
export const PROXY_POOL_CLIENT_KEYS_DEFAULT = Object.freeze({ default: 'on', overrides: Object.freeze({}) });
const POOL_CLIENT_KEYS_FIELDS = { default: true, overrides: true };
function strictPoolClientKeys(value, knownIds) {
  const path = 'proxyPoolClientKeys';
  if (!plain(value)) invalid(path, 'must be an object');
  rejectUnknown(value, POOL_CLIENT_KEYS_FIELDS, path);
  const mode = value.default === undefined ? 'on' : oneOf(value.default, POOL_CLIENT_KEY_MODES, `${path}.default`);
  const overrides = value.overrides === undefined ? {} : value.overrides;
  if (!plain(overrides)) invalid(`${path}.overrides`, 'must be an object');
  const entries = [];
  for (const [id, setting] of Object.entries(overrides)) {
    // 未知键不回显：误把密钥值当作 id 粘贴时，错误信息里也不能出现它。
    if (!knownIds.has(id)) invalid(`${path}.overrides`, 'contains an unknown client key id');
    oneOf(setting, POOL_CLIENT_KEY_MODES, `${path}.overrides.${id}`);
    entries.push([id, setting]);
  }
  return { default: mode, overrides: Object.fromEntries(entries) };
}
// knownIds：'legacy' 加现有 clientKeys 的 id。strict 抛出带路径的错误；非 strict 遇到非法值整体退回默认值。
export function normalizeProxyPoolClientKeys(value, { knownIds = ['legacy'], strict = true } = {}) {
  const ids = new Set(knownIds);
  if (value === undefined) return { default: 'on', overrides: {} };
  try { return strictPoolClientKeys(value, ids); }
  catch (error) {
    if (strict) throw error;
    console.warn('[配置] 已忽略非法的按客户端密钥代理池设置');
    return { default: 'on', overrides: {} };
  }
}

export function entryIdFor(secret, normalizedUrl) {
  return crypto.createHmac('sha256', secret).update(String(normalizedUrl)).digest('hex').slice(0, 8);
}

// Retry-After：秒数或 HTTP-date，限制在 1s..600s；无法解析返回 null。
export function parseRetryAfter(value, now = Date.now()) {
  if (Array.isArray(value)) value = value[0];
  if (value === undefined || value === null) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  let ms;
  if (/^\d+$/.test(raw)) ms = Number(raw) * 1000;
  else {
    // HTTP-date 一定含星期/月份名；排除 Date.parse 会接受的 "-5"、"1.5" 之类数字串。
    if (!/[A-Za-z]/.test(raw)) return null;
    const at = Date.parse(raw);
    if (!Number.isFinite(at)) return null;
    ms = at - now;
  }
  if (!Number.isFinite(ms)) return null;
  return Math.min(600000, Math.max(1000, Math.round(ms)));
}

const RECENT_MINUTES = 15;
const MINUTE_MS = 60000;
function bump(buckets, field, t) {
  const minute = Math.floor(t / MINUTE_MS);
  let bucket = buckets.at(-1);
  if (!bucket || bucket.minute < minute) { bucket = { minute, requests: 0, throttled: 0, connectFailures: 0, fallbacks: 0 }; buckets.push(bucket); }
  bucket[field]++;
  while (buckets.length && buckets[0].minute <= minute - RECENT_MINUTES) buckets.shift();
}
function recentTotals(buckets, t, fields) {
  const floor = Math.floor(t / MINUTE_MS) - RECENT_MINUTES;
  const out = Object.fromEntries(fields.map((field) => [field, 0]));
  for (const bucket of buckets) if (bucket.minute > floor) for (const field of fields) out[field] += bucket[field];
  return out;
}

export function createProxyPoolRuntime({ secret, now = Date.now, random = crypto.randomInt, createAgent, destroyAgent = (agent) => agent?.destroy?.(), retireGraceMs = 420000, rpmWindowMs = 60000 } = {}) {
  if (secret === undefined || secret === null || secret === '') throw new Error('proxy pool runtime requires a secret');
  const settings = { strategy: 'round-robin', egressRetries: 2, throttleCooldownMs: 60000, failureCooldownMs: 30000, connectTimeoutMs: 10000, maxRpmPerProxy: 0, stickyRetentionMs: 0, includeDirect: false };
  let active = [];
  const retiring = new Map();
  // 会话粘性：stickyRetentionMs > 0 时，会话 → 条目的绑定跨换批保留；被换批但仍有绑定、且未超过寿命的条目
  // 放进 retained（只能被已绑定的会话选中，不进入轮询/随机/HRW 候选），到期或没有绑定后才真正退役。
  const bindings = new Map();
  const retained = new Map();
  let cursor = 0, generation = 0, fallbackTotal = 0, seedCache = null;
  const fallbackRecent = [];

  function newState(url, entryId) {
    const direct = url === DIRECT_POOL_URL;
    const endpointKey = direct ? DIRECT_POOL_URL : proxyEndpointKey(url);
    if (!endpointKey) return null;
    return {
      url, entryId, endpointKey, scheme: endpointKey.slice(0, endpointKey.indexOf(':')), direct,
      cooldownUntil: 0, cooldownReason: null, inFlight: 0, retiredAt: 0, destroyed: false, agent: null,
      rpm: { committed: [], head: 0, reserved: 0 }, recent: [],
      bornAt: now(), bound: 0, where: 'active',
    };
  }
  function destroyState(state) {
    state.destroyed = true;
    const agent = state.agent;
    state.agent = null;
    if (agent) { try { destroyAgent(agent); } catch {} }
  }
  function ensureAgent(state) {
    if (state.direct) return undefined;
    if (!state.agent && createAgent) state.agent = createAgent(state.url);
    return state.agent || undefined;
  }
  function pruneRpm(state, t) {
    const rpm = state.rpm, cutoff = t - rpmWindowMs;
    while (rpm.head < rpm.committed.length && rpm.committed[rpm.head] <= cutoff) rpm.head++;
    if (rpm.head && rpm.head * 2 >= rpm.committed.length) { rpm.committed = rpm.committed.slice(rpm.head); rpm.head = 0; }
  }
  function rpmUsed(state, t) { pruneRpm(state, t); return state.rpm.committed.length - state.rpm.head; }
  function rpmFull(state, t) {
    const limit = settings.maxRpmPerProxy;
    return limit > 0 && rpmUsed(state, t) + state.rpm.reserved >= limit;
  }
  function rpmRetryAt(state) {
    const oldest = state.rpm.committed[state.rpm.head];
    return Number.isFinite(oldest) ? oldest + rpmWindowMs : null;
  }
  const isExcluded = (state, exclude) => !!exclude && (exclude.has(state.url) || exclude.has(state.entryId));
  const isAvailable = (state, t, exclude) => !isExcluded(state, exclude) && state.cooldownUntil <= t && !rpmFull(state, t);

  function sweep(t = now()) {
    let removed = 0;
    for (const [url, state] of retiring) {
      if (t - state.retiredAt < retireGraceMs) continue;
      retiring.delete(url); destroyState(state); removed++;
    }
    for (const [url, state] of retained) {
      if (t - state.bornAt < settings.stickyRetentionMs && state.bound > 0) continue;
      retained.delete(url); state.where = 'gone'; retire(state, t);
    }
    return removed;
  }
  function retire(state, t) {
    if (state.inFlight > 0) { state.retiredAt = t; retiring.set(state.url, state); }
    else destroyState(state);
  }
  // includeDirect 变化时立即增删隐式直连条目（不等下一次换批）；换批时由 replaceEntries 保持它。
  function syncDirect(t = now()) {
    const present = active.find((state) => state.direct);
    if (settings.includeDirect && !present) {
      const state = newState(DIRECT_POOL_URL, entryIdFor(secret, DIRECT_POOL_URL));
      active = [...active, state]; generation++; seedCache = null;
    } else if (!settings.includeDirect && present) {
      active = active.filter((state) => state !== present); present.where = 'gone'; retire(present, t); generation++; cursor = 0;
    }
  }
  const STICKY_BINDINGS_MAX = 20000;
  function unbind(key) {
    const state = bindings.get(key);
    if (!state) return;
    bindings.delete(key); state.bound = Math.max(0, state.bound - 1);
  }
  function bind(key, state) {
    unbind(key); bindings.set(key, state); state.bound++;
    while (bindings.size > STICKY_BINDINGS_MAX) unbind(bindings.keys().next().value);
  }
  // 绑定的条目仍在用，或已换批但还在寿命内。
  const stickyAlive = (state, t) => state.where === 'active' || (state.where === 'retained' && t - state.bornAt < settings.stickyRetentionMs);
  function releaseRetained(t = now()) {
    for (const state of retained.values()) { state.where = 'gone'; retire(state, t); }
    retained.clear();
  }

  function lease(state, t) {
    const reservedRpm = settings.maxRpmPerProxy > 0;
    if (reservedRpm) state.rpm.reserved++;
    state.inFlight++;
    let rpmSettled = !reservedRpm, committed = false, released = false;
    const handle = {
      entryId: state.entryId, endpointKey: state.endpointKey, scheme: state.scheme, leasedAt: t,
      commit() {
        if (committed || released) return;
        committed = true;
        const at = now();
        if (!rpmSettled) { rpmSettled = true; state.rpm.reserved = Math.max(0, state.rpm.reserved - 1); state.rpm.committed.push(at); }
        bump(state.recent, 'requests', at);
      },
      release() {
        if (released) return;
        released = true;
        if (!rpmSettled) { rpmSettled = true; state.rpm.reserved = Math.max(0, state.rpm.reserved - 1); }
        state.inFlight = Math.max(0, state.inFlight - 1);
        if (state.inFlight) return;
        if (state.retiredAt && retiring.get(state.url) === state) { retiring.delete(state.url); destroyState(state); }
        else if (state.destroyed && state.agent) destroyState(state);
      },
      noteThrottle(retryAfterMs = null) {
        const at = now();
        const ms = Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? retryAfterMs : settings.throttleCooldownMs;
        if (at + ms > state.cooldownUntil) { state.cooldownUntil = at + ms; state.cooldownReason = 'throttle'; }
        bump(state.recent, 'throttled', at);
      },
      noteConnectFailure() {
        const at = now();
        const ms = settings.failureCooldownMs;
        if (at + ms > state.cooldownUntil) { state.cooldownUntil = at + ms; state.cooldownReason = 'connect'; }
        bump(state.recent, 'connectFailures', at);
      },
    };
    // URL 与 agent 不可枚举：句柄被展开或序列化时不会带出凭据。
    Object.defineProperty(handle, 'url', { value: state.url, enumerable: false });
    Object.defineProperty(handle, 'direct', { value: state.direct === true, enumerable: false });
    Object.defineProperty(handle, 'agent', { get: () => ensureAgent(state), enumerable: false });
    return handle;
  }

  function earliestRetryAt({ exclude } = {}, t = now()) {
    let best = null;
    for (const state of active) {
      if (isExcluded(state, exclude)) continue;
      let at = t;
      if (state.cooldownUntil > t) at = state.cooldownUntil;
      if (rpmFull(state, t)) {
        const rpmAt = rpmRetryAt(state);
        if (rpmAt === null) continue;
        at = Math.max(at, rpmAt);
      }
      if (best === null || at < best) best = at;
    }
    return best;
  }

  return {
    configure(cfg = {}) {
      if (POOL_STRATEGIES.includes(cfg.strategy)) settings.strategy = cfg.strategy;
      for (const [key, [min, max]] of Object.entries(POOL_INTEGERS)) {
        if (Number.isSafeInteger(cfg[key]) && cfg[key] >= min && cfg[key] <= max) settings[key] = cfg[key];
      }
      if (typeof cfg.includeDirect === 'boolean' && cfg.includeDirect !== settings.includeDirect) { settings.includeDirect = cfg.includeDirect; syncDirect(); }
      // 由服务端按来源推导（FloppyData 取"轮换"时长），不是用户配置字段。
      if (Number.isSafeInteger(cfg.stickyRetentionMs) && cfg.stickyRetentionMs >= 0 && cfg.stickyRetentionMs <= 86_400_000) {
        settings.stickyRetentionMs = cfg.stickyRetentionMs;
        if (!settings.stickyRetentionMs) { releaseRetained(); bindings.clear(); for (const state of active) state.bound = 0; }
      }
      return { ...settings };
    },
    settings() { return { ...settings }; },
    // retain=false（关闭、来源切换、身份字段变化等）：同时放弃所有会话绑定与被保留的旧条目。
    replaceEntries(urls = [], { retain = true } = {}) {
      const t = now();
      sweep(t);
      seedCache = null;
      if (!retain) { releaseRetained(t); bindings.clear(); for (const state of active) state.bound = 0; }
      const byUrl = new Map(active.map((state) => [state.url, state]));
      const next = [], seen = new Set(), ids = new Set(), dropped = [];
      for (const [index, url] of (Array.isArray(urls) ? urls : []).entries()) {
        if (typeof url !== 'string' || !url || seen.has(url)) continue;
        seen.add(url);
        let state = byUrl.get(url) || retained.get(url) || retiring.get(url) || null;
        const entryId = state?.entryId || entryIdFor(secret, url);
        if (ids.has(entryId)) { dropped.push({ index, reason: 'collision' }); continue; }
        if (!state) state = newState(url, entryId);
        if (!state) { dropped.push({ index, reason: 'invalid' }); continue; }
        ids.add(entryId);
        if (state.retiredAt) { retiring.delete(url); state.retiredAt = 0; }
        if (state.where === 'retained') retained.delete(url);
        state.where = 'active';
        next.push(state);
      }
      if (settings.includeDirect) {
        const direct = byUrl.get(DIRECT_POOL_URL) || newState(DIRECT_POOL_URL, entryIdFor(secret, DIRECT_POOL_URL));
        next.push(direct);
      }
      const kept = new Set(next);
      for (const state of active) {
        if (kept.has(state)) continue;
        if (retain && settings.stickyRetentionMs > 0 && state.bound > 0 && t - state.bornAt < settings.stickyRetentionMs) { state.where = 'retained'; retained.set(state.url, state); }
        else { state.where = 'gone'; retire(state, t); }
      }
      const changed = next.length !== active.length || next.some((state, index) => state !== active[index]);
      active = next;
      if (changed) { generation++; cursor = 0; }
      return { changed, generation, active: active.length, retiring: retiring.size, dropped };
    },
    // stickyKey（会话指纹）：
    //  - stickyRetentionMs > 0（FloppyData 且"轮换"> -1）：会话绑定到第一次选中的条目，换批后仍用该条目直到它的寿命
    //    （bornAt + stickyRetentionMs）结束；绑定的条目冷却、限速、被排除时，本次临时落到当前批里 HRW（最高随机权重）
    //    最高的条目，不改绑定，恢复后回到原条目；条目失效（寿命到或已销毁）后重新绑定。
    //  - 否则无状态：直接在可用条目中按 HRW 选择，同一会话稳定落在同一条目。
    // 两种都不移动轮询游标；没有 stickyKey 的调用仍按 strategy 选择。
    pickEntry({ exclude, stickyKey } = {}) {
      const t = now();
      sweep(t);
      const n = active.length;
      if (!n) return { entry: null, retryAt: null };
      let chosen = null;
      if (typeof stickyKey === 'string' && stickyKey) {
        const keep = settings.stickyRetentionMs > 0;
        let bound = keep ? bindings.get(stickyKey) : undefined;
        if (bound && !stickyAlive(bound, t)) { unbind(stickyKey); bound = undefined; }
        if (bound && isAvailable(bound, t, exclude)) {
          chosen = bound; bindings.delete(stickyKey); bindings.set(stickyKey, bound);
        } else {
          let best = '';
          for (const state of active) {
            if (!isAvailable(state, t, exclude)) continue;
            const score = crypto.createHmac('sha256', secret).update(`sticky\0${stickyKey}\0${state.entryId}`).digest('hex');
            if (!chosen || score > best) { chosen = state; best = score; }
          }
          if (keep && chosen && !bound) bind(stickyKey, chosen);
        }
      } else if (settings.strategy === 'random') {
        const available = active.filter((state) => isAvailable(state, t, exclude));
        if (available.length) {
          const index = Number(random(available.length));
          chosen = available[Number.isInteger(index) && index >= 0 && index < available.length ? index : 0];
        }
      } else {
        for (let k = 0; k < n; k++) {
          const index = (cursor + k) % n;
          if (!isAvailable(active[index], t, exclude)) continue;
          chosen = active[index]; cursor = (index + 1) % n;
          break;
        }
      }
      if (!chosen) return { entry: null, retryAt: earliestRetryAt({ exclude }, t) };
      return { entry: lease(chosen, t), retryAt: null };
    },
    hasAvailable(exclude) {
      const t = now();
      return active.some((state) => isAvailable(state, t, exclude));
    },
    earliestRetryAt(options = {}) { return earliestRetryAt(options, now()); },
    noteFallback() { fallbackTotal++; bump(fallbackRecent, 'fallbacks', now()); },
    sweep,
    status() {
      const t = now();
      const project = (state) => {
        const retired = !!state.retiredAt;
        const cooling = state.cooldownUntil > t;
        return {
          entryId: state.entryId, scheme: state.scheme, endpointKey: state.endpointKey,
          state: retired ? 'retiring' : cooling ? 'cooldown' : rpmFull(state, t) ? 'rate-limited' : state.where === 'retained' ? 'retained' : 'ok',
          cooldownUntil: cooling ? state.cooldownUntil : null,
          reason: cooling ? state.cooldownReason : null,
          rpmUsed: rpmUsed(state, t), inFlight: state.inFlight,
          recent: recentTotals(state.recent, t, ['requests', 'throttled', 'connectFailures']),
        };
      };
      const entries = [...active.map(project), ...[...retained.values()].map(project), ...[...retiring.values()].map(project)];
      return {
        generation, total: active.length, available: entries.filter((entry) => entry.state === 'ok').length, retiring: retiring.size,
        fallbacks: { total: fallbackTotal, recent: recentTotals(fallbackRecent, t, ['fallbacks']).fallbacks },
        entries,
      };
    },
    // 同一批条目返回同一个数组引用，调用方可据此缓存脱敏正则；换批后才重新计算。
    // 退役条目被销毁后其种子仍保留到下一次换批（多脱敏无害）。
    secretSeeds() {
      if (seedCache) return seedCache;
      const seeds = new Set();
      for (const state of [...active, ...retained.values(), ...retiring.values()]) {
        let u;
        try { u = new URL(state.url); } catch { continue; }
        for (const raw of [u.username, u.password]) {
          if (!raw) continue;
          seeds.add(raw);
          try { seeds.add(decodeURIComponent(raw)); } catch {}
        }
      }
      seedCache = Object.freeze([...seeds].filter(Boolean));
      return seedCache;
    },
    // 连通性测试用：从在用条目中随机抽取至多 limit 个。url 不可枚举，不进入任何投影。
    sampleEntries(limit = 10) {
      const pool = active.filter((state) => !state.direct);
      const n = Math.max(0, Math.min(pool.length, Number.isSafeInteger(limit) ? limit : 0));
      for (let i = 0; i < n; i++) {
        const j = i + Number(random(pool.length - i));
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }
      return pool.slice(0, n).map((state) => {
        const item = { entryId: state.entryId, scheme: state.scheme, endpointKey: state.endpointKey };
        Object.defineProperty(item, 'url', { value: state.url, enumerable: false });
        return item;
      });
    },
    destroyAll() {
      for (const state of [...active, ...retained.values(), ...retiring.values()]) destroyState(state);
      const changed = active.length > 0;
      active = []; retiring.clear(); retained.clear(); bindings.clear(); cursor = 0; seedCache = null;
      if (changed) generation++;
    },
  };
}
