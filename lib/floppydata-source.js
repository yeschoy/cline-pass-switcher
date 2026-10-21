// FloppyData 自动导入：每批调用 count 次 connections 接口生成粘性会话，半数成功即整批替换。
// 网络与定时器由调用方注入。apiKey、用户名、密码、响应体绝不进入状态或错误信息。
// stop() 只取消定时器和在途调用，不清空池；让旧条目退役（replaceEntries([])）由调用方负责。
import crypto from 'node:crypto';
import { normalizeProxyUrl } from './proxy-pool.js';

// unreachable：新一批代理抽样连通性不足（validateBatch 拒绝），保留当前批并按退避重试。
export const FLOPPYDATA_ERRORS = Object.freeze(['unauthorized', 'insufficient_balance', 'rate_limited', 'upstream_error', 'network', 'invalid_response', 'unreachable']);
const FATAL_ERRORS = new Set(['unauthorized', 'insufficient_balance']);
const IDENTITY_FIELDS = ['apiKey', 'apiBase', 'type', 'country', 'state', 'city', 'protocol', 'rotation', 'count'];
const PROTOCOL_SCHEMES = { socks5: ['socks5:', 'socks5h:'], http: ['http:'], https: ['https:'] };

function httpErrorCode(status) {
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 402) return 'insufficient_balance';
  if (status === 429) return 'rate_limited';
  return 'upstream_error';
}
function codeError(code) {
  const error = new Error(`floppydata request failed: ${code}`);
  error.code = code;
  return error;
}
function discardBody(res) { try { res?.body?.cancel?.().catch?.(() => {}); } catch {} }

export function createFloppyDataSource({
  getConfig, fetchImpl = globalThis.fetch, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
  onBatch = () => {}, onStatus = () => {}, validateBatch = null, normalizeUrl = (value) => normalizeProxyUrl(value, { strict: true }),
  random = crypto.randomInt, concurrency = 8, timeoutMs = 15000, backoffBaseMs = 30000,
} = {}) {
  let started = false, timer = null, current = null, failures = 0;
  const st = { state: 'idle', lastAttemptAt: null, lastSuccessAt: null, nextRefreshAt: null, lastBatch: null, lastError: null };

  const status = () => ({ ...st, lastBatch: st.lastBatch ? { ...st.lastBatch } : null });
  const emit = () => { try { onStatus(status()); } catch {} };
  const config = () => getConfig?.() || {};
  const apiBase = (cfg) => String(cfg.apiBase || '').replace(/\/+$/, '');
  const interval = () => {
    const value = config().refreshIntervalMs;
    return Number.isSafeInteger(value) && value > 0 ? value : 180000;
  };
  const backoff = () => Math.min(backoffBaseMs * 2 ** Math.max(0, failures - 1), interval());

  function clearSchedule() {
    if (timer !== null) { clearTimer(timer); timer = null; }
    st.nextRefreshAt = null;
  }
  function schedule(delay) {
    clearSchedule();
    if (!started) return;
    st.nextRefreshAt = now() + delay;
    timer = setTimer(() => { timer = null; st.nextRefreshAt = null; refresh(); }, delay);
    timer?.unref?.();
  }

  // 单次网络调用：自身超时 + 跟随外部 signal 取消；返回 { response } 或抛出 code 错误。
  async function call(url, init, signal) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
    const handle = setTimer(abort, timeoutMs);
    try {
      let res;
      try { res = await fetchImpl(url, { ...init, signal: controller.signal }); }
      catch { throw codeError('network'); }
      if (!res || res.status < 200 || res.status > 299) { discardBody(res); throw codeError(httpErrorCode(res?.status)); }
      try { return await res.json(); }
      catch { throw codeError(controller.signal.aborted ? 'network' : 'invalid_response'); }
    } finally {
      clearTimer(handle);
      signal?.removeEventListener('abort', abort);
    }
  }
  const headers = (cfg) => ({ 'X-Api-Key': cfg.apiKey, Accept: 'application/json' });

  async function createConnection(cfg, session, signal) {
    const payload = { type: cfg.type, country: cfg.country, protocol: cfg.protocol, rotation: cfg.rotation, session };
    if (cfg.state) payload.state = cfg.state;
    if (cfg.city) payload.city = cfg.city;
    const json = await call(`${apiBase(cfg)}/v2/proxy/rotating/connections`, {
      method: 'POST', headers: { ...headers(cfg), 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    }, signal);
    const raw = json?.connection?.connectionString;
    if (typeof raw !== 'string' || !raw) throw codeError('invalid_response');
    let url = '';
    try { url = normalizeUrl(raw); } catch {}
    if (!url) throw codeError('invalid_response');
    let parsed;
    try { parsed = new URL(url); } catch { throw codeError('invalid_response'); }
    if (!parsed.hostname || !(PROTOCOL_SCHEMES[cfg.protocol] || []).includes(parsed.protocol)) throw codeError('invalid_response');
    return url;
  }

  async function runBatch(run) {
    const cfg = config();
    const count = Number.isSafeInteger(cfg.count) && cfg.count > 0 ? cfg.count : 0;
    if (!cfg.apiKey || !count) return { requested: count, urls: [], error: 'unauthorized' };
    // 会话号只含字母数字（FloppyData 把它拼进以 '-' 分段的用户名）；同批内序号不同即互不相同。
    const tag = `${now().toString(36)}${Number(random(1296)).toString(36).padStart(2, '0')}`;
    const batch = new AbortController();
    const abortBatch = () => batch.abort();
    run.controller.signal.addEventListener('abort', abortBatch, { once: true });
    const results = new Array(count).fill(null);
    const errors = new Map();
    let fatal = null, next = 0;
    const worker = async () => {
      while (!batch.signal.aborted && next < count) {
        const index = next++;
        try { results[index] = await createConnection(cfg, `cps${tag}${index}`, batch.signal); }
        catch (error) {
          if (batch.signal.aborted) return;
          const code = FLOPPYDATA_ERRORS.includes(error?.code) ? error.code : 'invalid_response';
          errors.set(code, (errors.get(code) || 0) + 1);
          if (FATAL_ERRORS.has(code)) { fatal = fatal || code; batch.abort(); }
        }
      }
    };
    try { await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), count) }, worker)); }
    finally { run.controller.signal.removeEventListener('abort', abortBatch); }
    const urls = [...new Set(results.filter(Boolean))];
    let error = fatal;
    if (!error) for (const [code, n] of errors) if (!error || n > errors.get(error)) error = code;
    return { requested: count, urls, error };
  }

  function refresh() {
    if (current) return current.promise;
    const run = { controller: new AbortController(), stopped: false };
    current = run;
    clearSchedule();
    st.state = 'refreshing';
    st.lastAttemptAt = now();
    emit();
    run.promise = runBatch(run).catch(() => ({ requested: 0, urls: [], error: 'network' })).then(async (outcome) => {
      if (run.stopped) { if (current === run) current = null; return status(); }
      const threshold = Math.ceil(outcome.requested / 2);
      st.lastBatch = { requested: outcome.requested, succeeded: outcome.urls.length };
      let accepted = outcome.requested > 0 && outcome.urls.length >= threshold;
      let urls = outcome.urls;
      // 接口成功不等于代理可用：换批前由调用方抽样测连通性。返回可用的 URL 列表（可去掉抽样中已确认不通的），
      // 返回空/抛错表示整批不可用，保留当前批。验证期间 current 保持在位，refresh() 仍是 single-flight。
      if (accepted && validateBatch) {
        try { const checked = await validateBatch(urls, run.controller.signal); urls = Array.isArray(checked) ? checked.filter(Boolean) : []; }
        catch { urls = []; }
        if (run.stopped) { if (current === run) current = null; return status(); }
        if (!urls.length) { accepted = false; outcome.error = 'unreachable'; }
      }
      if (current === run) current = null;
      if (accepted) {
        try { onBatch(urls); }
        catch { accepted = false; outcome.error = 'invalid_response'; }
      }
      if (accepted) {
        failures = 0;
        st.state = 'ok'; st.lastSuccessAt = now(); st.lastError = outcome.error || null;
        schedule(interval());
      } else {
        failures++;
        st.state = 'error'; st.lastError = outcome.error || 'invalid_response';
        schedule(backoff());
      }
      emit();
      return status();
    });
    return run.promise;
  }

  function start() {
    if (started) return current?.promise || Promise.resolve(status());
    started = true;
    failures = 0;
    return refresh();
  }
  function stop() {
    started = false;
    failures = 0;
    clearSchedule();
    if (current) { current.stopped = true; current.controller.abort(); current = null; }
    st.state = 'idle';
    emit();
  }

  return {
    start,
    stop,
    // 身份字段变化：运行中则重启（立即导入新批）；只改刷新间隔：重排定时器。
    reconfigure(prev = {}, next = {}) {
      if (IDENTITY_FIELDS.some((key) => prev?.[key] !== next?.[key])) {
        if (started) { stop(); start(); }
        return 'restart';
      }
      if (prev?.refreshIntervalMs !== next?.refreshIntervalMs) {
        if (started && !current && timer !== null) schedule(st.state === 'ok' ? interval() : backoff());
        return 'reschedule';
      }
      return 'none';
    },
    refresh,
    async balance() {
      const cfg = config();
      if (!cfg.apiKey) throw codeError('unauthorized');
      const json = await call(`${apiBase(cfg)}/v2/account/balances`, { method: 'GET', headers: headers(cfg) });
      const rotating = json?.proxy?.rotating;
      const bytes = rotating?.total?.traffic?.availableBytes;
      if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) throw codeError('invalid_response');
      const expiring = Array.isArray(rotating?.expiring) ? rotating.expiring : [rotating?.expiring];
      let expiringAt = null;
      for (const item of expiring) {
        const at = typeof item?.expiresAt === 'string' ? Date.parse(item.expiresAt) : NaN;
        if (Number.isFinite(at) && (expiringAt === null || at < expiringAt)) expiringAt = at;
      }
      return { availableBytes: bytes, availableGb: Math.round(bytes / 1e9 * 100) / 100, expiringAt: expiringAt === null ? null : new Date(expiringAt).toISOString() };
    },
    status,
    get running() { return started; },
  };
}
