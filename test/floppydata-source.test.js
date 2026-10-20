import test from 'node:test';
import assert from 'node:assert/strict';
import { createFloppyDataSource, FLOPPYDATA_ERRORS } from '../lib/floppydata-source.js';
import { FLOPPYDATA_DEFAULTS } from '../lib/proxy-pool.js';

const API_KEY = 'test-api-key';
const BASE = 'http://127.0.0.1:9';
const SECRETS = /test-api-key|user-test-session|pass-test/;

function fakeTimers() {
  const list = [];
  return {
    list,
    setTimer(fn, ms) { const timer = { fn, ms, cleared: false }; list.push(timer); return timer; },
    clearTimer(timer) { if (timer) timer.cleared = true; },
    // 调度定时器（排除单次调用的 15s 超时定时器）。
    scheduled() { return list.filter((t) => !t.cleared && t.ms !== 15000); },
    timeouts() { return list.filter((t) => !t.cleared && t.ms === 15000); },
    fire(timer) { timer.cleared = true; timer.fn(); },
  };
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const connection = (session, protocol = 'socks5', port = 10800) => json({
  connection: { protocol, host: '127.0.0.1', port, username: `user-test-session-${session}`, password: 'pass-test',
    connectionString: `${protocol}://user-test-session-${session}:pass-test@127.0.0.1:${port}` },
  parameters: {},
});

function setup({ cfg = {}, respond = (body) => connection(body.session), ...options } = {}) {
  const clock = { t: 1_700_000_000_000 };
  const timers = fakeTimers();
  const calls = [], batches = [], statuses = [];
  let config = { ...FLOPPYDATA_DEFAULTS, apiKey: API_KEY, apiBase: BASE, count: 4, ...cfg };
  let inFlight = 0, maxInFlight = 0;
  const source = createFloppyDataSource({
    getConfig: () => config,
    now: () => clock.t,
    random: () => 35,
    setTimer: timers.setTimer, clearTimer: timers.clearTimer,
    onBatch: (urls) => batches.push(urls),
    onStatus: (status) => statuses.push(status),
    fetchImpl: async (url, init) => {
      const body = init.body ? JSON.parse(init.body) : null;
      const call = { url, init, body, index: calls.length };
      calls.push(call);
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      try { return await respond(body, call); } finally { inFlight--; }
    },
    ...options,
  });
  return { source, clock, timers, calls, batches, statuses, setConfig: (patch) => { config = { ...config, ...patch }; }, maxInFlight: () => maxInFlight };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
function hang(signal) { return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })); }

test('a successful batch imports count unique sessions with bounded concurrency', async () => {
  const env = setup({ cfg: { count: 20, refreshIntervalMs: 180000, state: 'CA' }, respond: async (body) => { await tick(); return connection(body.session); } });
  const status = await env.source.start();
  assert.equal(env.calls.length, 20);
  assert.ok(env.maxInFlight() <= 8 && env.maxInFlight() > 1, `max in flight ${env.maxInFlight()}`);
  const sessions = env.calls.map((c) => c.body.session);
  assert.equal(new Set(sessions).size, 20);
  for (const session of sessions) assert.match(session, /^cps[0-9a-z]+$/), assert.ok(session.length <= 128);
  assert.deepEqual(sessions.slice(0, 3), ['cpsloyw3v280z0', 'cpsloyw3v280z1', 'cpsloyw3v280z2']);
  const first = env.calls[0];
  assert.equal(first.url, `${BASE}/v2/proxy/rotating/connections`);
  assert.equal(first.init.method, 'POST');
  assert.equal(first.init.headers['X-Api-Key'], API_KEY);
  assert.deepEqual(first.body, { type: 'residential', country: 'US', protocol: 'socks5', rotation: 0, session: sessions[0], state: 'CA' });
  assert.equal(env.batches.length, 1);
  assert.deepEqual(env.batches[0], sessions.map((s) => `socks5://user-test-session-${s}:pass-test@127.0.0.1:10800`), 'index order');
  assert.deepEqual(status, { state: 'ok', lastAttemptAt: env.clock.t, lastSuccessAt: env.clock.t, nextRefreshAt: env.clock.t + 180000, lastBatch: { requested: 20, succeeded: 20 }, lastError: null });
  assert.deepEqual(env.timers.scheduled().map((t) => t.ms), [180000]);
  assert.equal(env.timers.timeouts().length, 0, 'per-call timeouts cleared');
  assert.deepEqual(env.statuses.map((s) => s.state), ['refreshing', 'ok']);
  assert.equal(env.source.running, true);
  // 定时器到点：再导入一批，新会话号与上一批不同。
  env.clock.t += 180000;
  env.timers.fire(env.timers.scheduled()[0]);
  await env.source.refresh();
  assert.equal(env.batches.length, 2);
  assert.equal(new Set([...sessions, ...env.calls.slice(20).map((c) => c.body.session)]).size, 40);
});

test('partial success at or above half replaces; below half keeps old batch and backs off', async () => {
  const atHalf = setup({ cfg: { count: 4 }, respond: (body, call) => call.index % 2 ? json({ error: 'internal_error' }, 500) : connection(body.session) });
  let status = await atHalf.source.start();
  assert.equal(atHalf.batches[0].length, 2);
  assert.equal(status.state, 'ok');
  assert.deepEqual(status.lastBatch, { requested: 4, succeeded: 2 });
  assert.equal(status.lastError, 'upstream_error');

  const below = setup({ cfg: { count: 5 }, respond: (body, call) => call.index < 2 ? connection(body.session) : json({}, 429) });
  status = await below.source.start();
  assert.equal(below.batches.length, 0);
  assert.equal(status.state, 'error');
  assert.equal(status.lastError, 'rate_limited');
  assert.equal(status.lastSuccessAt, null);
  assert.deepEqual(status.lastBatch, { requested: 5, succeeded: 2 });
  assert.equal(status.nextRefreshAt, below.clock.t + 30000);
});

test('401 and 402 abort the remaining batch calls', async () => {
  for (const [code, error] of [[401, 'unauthorized'], [403, 'unauthorized'], [402, 'insufficient_balance']]) {
    const aborted = [];
    const env = setup({
      cfg: { count: 50 },
      respond: async (body, call) => {
        if (call.index === 0) { await tick(); return json({ error: 'x' }, code); }
        await hang(call.init.signal).catch((e) => { aborted.push(call.index); throw e; });
      },
    });
    const status = await env.source.start();
    assert.equal(env.calls.length, 8, `${code}: no calls after the fatal response`);
    assert.equal(aborted.length, 7, `${code}: in-flight calls aborted`);
    assert.equal(status.lastError, error);
    assert.equal(env.batches.length, 0);
  }
});

test('errors are classified into the fixed enum', async () => {
  const cases = [
    [() => json({}, 429), 'rate_limited'],
    [() => json({}, 500), 'upstream_error'],
    [() => json({}, 404), 'upstream_error'],
    [() => { throw new Error('connect ECONNREFUSED user-test-session-x'); }, 'network'],
    [() => new Response('not json', { status: 200 }), 'invalid_response'],
    [() => json({ connection: {} }), 'invalid_response'],
    [(body) => connection(body.session, 'http', 10080), 'invalid_response'],
    [() => json({ connection: { connectionString: 'socks5://user-test-session-1:pass-test@127.0.0.1:1/path' } }), 'invalid_response'],
    [() => json({ connection: { connectionString: 'ftp://user-test-session-1:pass-test@127.0.0.1:1' } }), 'invalid_response'],
  ];
  for (const [respond, error] of cases) {
    const env = setup({ cfg: { count: 2 }, respond });
    const status = await env.source.refresh();
    assert.equal(status.lastError, error);
    assert.equal(status.state, 'error');
    assert.ok(FLOPPYDATA_ERRORS.includes(status.lastError));
    assert.doesNotMatch(JSON.stringify(env.statuses), SECRETS);
  }
  // http 协议请求接受 http 连接串；socks5 接受 socks5h。
  const http = setup({ cfg: { count: 1, protocol: 'http' }, respond: (body) => connection(body.session, 'http', 10080) });
  assert.equal((await http.source.refresh()).state, 'ok');
  assert.equal(http.calls[0].body.protocol, 'http');
  const h = setup({ cfg: { count: 1 }, respond: (body) => connection(body.session, 'socks5h') });
  assert.equal((await h.source.refresh()).state, 'ok');
});

test('per-call timeout aborts and reports network', async () => {
  const env = setup({ cfg: { count: 2 }, respond: (body, call) => hang(call.init.signal) });
  const pending = env.source.refresh();
  await tick();
  assert.equal(env.timers.timeouts().length, 2);
  for (const timer of env.timers.timeouts()) env.timers.fire(timer);
  const status = await pending;
  assert.equal(status.lastError, 'network');
});

test('failure backoff doubles up to the refresh interval and resets after success', async () => {
  let fail = true;
  const env = setup({ cfg: { count: 2, refreshIntervalMs: 100000 }, respond: (body) => fail ? json({}, 500) : connection(body.session) });
  await env.source.start();
  const delays = [];
  for (let i = 0; i < 4; i++) {
    const [timer] = env.timers.scheduled();
    delays.push(timer.ms);
    env.timers.fire(timer);
    await env.source.refresh();
  }
  delays.push(env.timers.scheduled()[0].ms);
  assert.deepEqual(delays, [30000, 60000, 100000, 100000, 100000]);
  fail = false;
  env.timers.fire(env.timers.scheduled()[0]);
  await env.source.refresh();
  assert.deepEqual(env.timers.scheduled().map((t) => t.ms), [100000]);
  fail = true;
  env.timers.fire(env.timers.scheduled()[0]);
  await env.source.refresh();
  assert.deepEqual(env.timers.scheduled().map((t) => t.ms), [30000]);
  assert.equal(env.timers.scheduled().length, 1, 'never more than one pending schedule');
});

test('refresh is single-flight and manual refresh does not double-schedule', async () => {
  const env = setup({ cfg: { count: 3 }, respond: async (body) => { await tick(); return connection(body.session); } });
  const a = env.source.start();
  const b = env.source.refresh();
  assert.equal(a, b);
  assert.equal(env.source.start(), a, 'start while running returns the in-flight refresh');
  await a;
  assert.equal(env.calls.length, 3);
  await env.source.refresh();
  assert.equal(env.calls.length, 6);
  assert.equal(env.timers.scheduled().length, 1);
});

test('stop aborts in-flight calls, clears timers and never publishes the batch', async () => {
  const signals = [];
  const env = setup({ cfg: { count: 4 }, respond: (body, call) => { signals.push(call.init.signal); return hang(call.init.signal); } });
  const pending = env.source.start();
  await tick();
  env.source.stop();
  assert.ok(signals.length > 0 && signals.every((s) => s.aborted));
  const status = await pending;
  assert.equal(status.state, 'idle');
  assert.equal(env.batches.length, 0);
  assert.equal(env.timers.scheduled().length, 0);
  assert.equal(env.source.running, false);
  assert.equal(env.source.status().nextRefreshAt, null);
  // 停止后的手动刷新可以执行，但不安排定时。
  const ok = setup({ cfg: { count: 1 } });
  await ok.source.start();
  ok.source.stop();
  await ok.source.refresh();
  assert.equal(ok.batches.length, 2);
  assert.equal(ok.timers.scheduled().length, 0);
});

test('reconfigure restarts on identity fields and reschedules on interval only', async () => {
  const env = setup({ cfg: { count: 1, refreshIntervalMs: 180000 } });
  const prev = { ...FLOPPYDATA_DEFAULTS, apiKey: API_KEY, apiBase: BASE, count: 1, refreshIntervalMs: 180000 };
  assert.equal(env.source.reconfigure(prev, { ...prev }), 'none');
  assert.equal(env.source.reconfigure(prev, { ...prev, country: 'DE' }), 'restart');
  assert.equal(env.calls.length, 0, 'not started -> no calls');
  await env.source.start();
  env.setConfig({ refreshIntervalMs: 600000 });
  assert.equal(env.source.reconfigure(prev, { ...prev, refreshIntervalMs: 600000 }), 'reschedule');
  assert.deepEqual(env.timers.scheduled().map((t) => t.ms), [600000]);
  env.setConfig({ apiKey: 'test-api-key-2' });
  assert.equal(env.source.reconfigure(prev, { ...prev, apiKey: 'test-api-key-2' }), 'restart');
  await env.source.refresh();
  assert.equal(env.calls.length, 2);
  assert.equal(env.calls[1].init.headers['X-Api-Key'], 'test-api-key-2');
  assert.equal(env.timers.scheduled().length, 1);
});

test('missing apiKey fails without network', async () => {
  const env = setup({ cfg: { apiKey: '' } });
  const status = await env.source.refresh();
  assert.equal(status.lastError, 'unauthorized');
  assert.equal(env.calls.length, 0);
  await assert.rejects(env.source.balance(), (e) => e.code === 'unauthorized');
});

test('balance projects only bytes, GB and earliest expiry', async () => {
  const env = setup({
    respond: () => json({ proxy: { rotating: { total: { traffic: { availableBytes: 12_700_000_000, usedBytes: 1 } }, expiring: { expiresAt: '2026-11-04T00:00:00Z', traffic: {} } } }, account: { email: 'x' } }),
  });
  assert.deepEqual(await env.source.balance(), { availableBytes: 12_700_000_000, availableGb: 12.7, expiringAt: '2026-11-04T00:00:00.000Z' });
  assert.equal(env.calls[0].url, `${BASE}/v2/account/balances`);
  assert.equal(env.calls[0].init.method, 'GET');
  assert.equal(env.calls[0].init.headers['X-Api-Key'], API_KEY);
  const none = setup({ respond: () => json({ proxy: { rotating: { total: { traffic: { availableBytes: 0 } } } } }) });
  assert.deepEqual(await none.source.balance(), { availableBytes: 0, availableGb: 0, expiringAt: null });
  for (const [respond, code] of [[() => json({}, 401), 'unauthorized'], [() => json({}, 402), 'insufficient_balance'], [() => json({ proxy: {} }), 'invalid_response'], [() => { throw new Error('test-api-key'); }, 'network']]) {
    const bad = setup({ respond });
    await assert.rejects(bad.source.balance(), (e) => { assert.equal(e.code, code); assert.doesNotMatch(e.message, SECRETS); return true; });
  }
});

test('status and status events never contain secrets', async () => {
  const env = setup({ cfg: { count: 3 } });
  await env.source.start();
  const text = JSON.stringify([env.source.status(), env.statuses]);
  assert.doesNotMatch(text, SECRETS);
  assert.deepEqual(Object.keys(env.source.status()), ['state', 'lastAttemptAt', 'lastSuccessAt', 'nextRefreshAt', 'lastBatch', 'lastError']);
});
