import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeProxyUrl, normalizeProxyPool, entryIdFor, createProxyPoolRuntime, parseRetryAfter, proxyEndpointKey,
  PROXY_POOL_DEFAULTS, FLOPPYDATA_DEFAULTS, MAX_POOL_ENTRIES, normalizeProxyPoolClientKeys, PROXY_POOL_CLIENT_KEYS_DEFAULT,
} from '../lib/proxy-pool.js';

const SECRET = 'test-routing-secret';
const A = 'socks5://user-test-session-1:pass-test@127.0.0.1:10001';
const B = 'socks5h://user-test-session-2:pass-test@127.0.0.1:10002';
const C = 'http://user-test-session-3:pass-test@127.0.0.1:10003/';

function harness({ strategy = 'round-robin', maxRpmPerProxy = 0, randomSeq, retireGraceMs = 420000, ...cfg } = {}) {
  const clock = { t: 1_000_000 };
  const created = [], destroyed = [];
  let r = 0;
  const runtime = createProxyPoolRuntime({
    secret: SECRET, now: () => clock.t, retireGraceMs,
    random: randomSeq ? (n) => randomSeq[r++ % randomSeq.length] % n : undefined,
    createAgent: (url) => { const agent = { url }; created.push(agent); return agent; },
    destroyAgent: (agent) => destroyed.push(agent),
  });
  runtime.configure({ strategy, maxRpmPerProxy, ...cfg });
  return { runtime, clock, created, destroyed };
}
const pickUrl = (runtime, options) => { const { entry } = runtime.pickEntry(options); if (!entry) return null; const url = entry.url; entry.commit(); entry.release(); return url; };

test('normalizeProxyUrl keeps the server contract', () => {
  assert.equal(normalizeProxyUrl(''), '');
  assert.equal(normalizeProxyUrl('  socks5h://u:p@h.example:1080  '), 'socks5h://u:p@h.example:1080');
  assert.equal(normalizeProxyUrl('http://h.example:8080'), 'http://h.example:8080/');
  assert.throws(() => normalizeProxyUrl('ftp://h.example', { strict: true }), /^Error: proxyUrl must be an http, https, socks5 or socks5h URL without path\/query\/hash$/);
  assert.throws(() => normalizeProxyUrl('http://h.example/path', { strict: true }));
  const warn = console.warn; const warned = []; console.warn = (m) => warned.push(m);
  try { assert.equal(normalizeProxyUrl('http://h.example/?q=1'), ''); } finally { console.warn = warn; }
  assert.deepEqual(warned, ['[配置] 已禁用一个非法账号代理 URL']);
  assert.equal(proxyEndpointKey(A), 'socks5://127.0.0.1:10001');
  assert.equal(proxyEndpointKey('http://u:p@h.example/'), 'http://h.example');
});

test('normalizeProxyPool fills defaults and normalizes fields', () => {
  const pool = normalizeProxyPool(undefined);
  assert.deepEqual(pool, { ...PROXY_POOL_DEFAULTS, entries: [], floppydata: { ...FLOPPYDATA_DEFAULTS } });
  assert.equal(Object.isFrozen(pool), false);
  const out = normalizeProxyPool({
    enabled: true, strategy: 'random', entries: [A, ` ${C.slice(0, -1)} `],
    floppydata: { apiKey: 'test-api-key', apiBase: 'http://127.0.0.1:9/', country: 'us', state: ' ca ', rotation: -1, count: 1, refreshIntervalMs: 60000 },
  });
  assert.deepEqual(out.entries, [A, C]);
  assert.equal(out.floppydata.apiBase, 'http://127.0.0.1:9');
  assert.equal(out.floppydata.country, 'US');
  assert.equal(out.floppydata.state, 'ca');
  assert.equal(out.floppydata.protocol, 'socks5');
  assert.deepEqual(Object.keys(out), Object.keys(PROXY_POOL_DEFAULTS));
  // floppydata 来源开启只要求 apiKey；manual 条目可以同时保留。
  assert.equal(normalizeProxyPool({ enabled: true, source: 'floppydata', floppydata: { apiKey: 'test-api-key' } }).source, 'floppydata');
  assert.equal(normalizeProxyPool({ enabled: false, source: 'manual' }).enabled, false);
});

test('normalizeProxyPool strict errors carry paths and never echo secrets', () => {
  const secretUrl = 'socks5://user-test-session-9:pass-test@127.0.0.1:1';
  const cases = [
    [[], /^Error: proxyPool must be an object$/],
    [{ extra: 1 }, /proxyPool\.extra is not a known field/],
    [{ [secretUrl]: 1 }, /^Error: proxyPool contains an unknown field$/],
    [{ enabled: 'true' }, /proxyPool\.enabled must be boolean/],
    [{ strategy: 'weighted' }, /proxyPool\.strategy must be one of/],
    [{ source: 'other' }, /proxyPool\.source must be one of/],
    [{ egressRetries: 6 }, /proxyPool\.egressRetries must be an integer from 0 to 5/],
    [{ throttleCooldownMs: 999 }, /proxyPool\.throttleCooldownMs/],
    [{ failureCooldownMs: '30000' }, /proxyPool\.failureCooldownMs/],
    [{ connectTimeoutMs: 60001 }, /proxyPool\.connectTimeoutMs/],
    [{ maxRpmPerProxy: 1.5 }, /proxyPool\.maxRpmPerProxy/],
    [{ entries: 'x' }, /proxyPool\.entries must be an array/],
    [{ entries: [A, 'ftp://user-test-session-9:pass-test@h.example'] }, /^Error: proxyPool\.entries\[1\] must be an http/],
    [{ entries: [A, secretUrl + '/path'] }, /proxyPool\.entries\[1\]/],
    [{ entries: [A, 7] }, /proxyPool\.entries\[1\]/],
    [{ entries: [A, ''] }, /proxyPool\.entries\[1\]/],
    [{ entries: [secretUrl, ` ${secretUrl}`] }, /^Error: proxyPool\.entries\[1\] duplicates proxyPool\.entries\[0\]$/],
    [{ entries: Array.from({ length: MAX_POOL_ENTRIES + 1 }, (_, i) => `socks5://h${i}.example:1`) }, /at most 2000/],
    [{ enabled: true, source: 'manual' }, /proxyPool\.entries must contain at least one URL/],
    [{ enabled: true, source: 'floppydata' }, /^Error: proxyPool\.floppydata\.apiKey is required/],
    [{ floppydata: [] }, /proxyPool\.floppydata must be an object/],
    [{ floppydata: { apiKey: 'test api key' } }, /^Error: proxyPool\.floppydata\.apiKey must be 1-256 visible ASCII characters$/],
    [{ floppydata: { apiKey: 'x'.repeat(257) } }, /proxyPool\.floppydata\.apiKey/],
    [{ floppydata: { apiBase: 'ftp://h.example' } }, /proxyPool\.floppydata\.apiBase/],
    [{ floppydata: { apiBase: 'https://h.example/v2' } }, /proxyPool\.floppydata\.apiBase/],
    [{ floppydata: { apiBase: 'https://test-api-key@h.example' } }, /^Error: proxyPool\.floppydata\.apiBase must be an http\(s\) URL/],
    [{ floppydata: { type: 'isp' } }, /proxyPool\.floppydata\.type/],
    [{ floppydata: { country: 'USA' } }, /proxyPool\.floppydata\.country/],
    [{ floppydata: { state: 'x'.repeat(65) } }, /proxyPool\.floppydata\.state/],
    [{ floppydata: { city: 'a\nb' } }, /proxyPool\.floppydata\.city/],
    [{ floppydata: { protocol: 'socks5h' } }, /proxyPool\.floppydata\.protocol/],
    [{ floppydata: { rotation: 3 } }, /proxyPool\.floppydata\.rotation must be one of -1, 0, 5, 10, 15, 20, 60/],
    [{ floppydata: { count: 0 } }, /proxyPool\.floppydata\.count/],
    [{ floppydata: { count: 501 } }, /proxyPool\.floppydata\.count/],
    [{ floppydata: { refreshIntervalMs: 59999 } }, /proxyPool\.floppydata\.refreshIntervalMs/],
    [{ floppydata: { refreshIntervalMs: 3600001 } }, /proxyPool\.floppydata\.refreshIntervalMs/],
    [{ floppydata: { bogus: 1 } }, /proxyPool\.floppydata\.bogus is not a known field/],
  ];
  for (const [value, pattern] of cases) {
    assert.throws(() => normalizeProxyPool(value), (error) => {
      assert.match(String(error), pattern);
      assert.doesNotMatch(error.message, /pass-test|user-test|test-api-key|test api key|127\.0\.0\.1|h\.example/);
      return true;
    });
  }
  const before = { entries: [A], floppydata: { country: 'us' } };
  const copy = structuredClone(before);
  normalizeProxyPool(before);
  assert.deepEqual(before, copy);
});

test('normalizeProxyPool non-strict falls back to disabled defaults; secret enables collision checks', () => {
  const warn = console.warn; console.warn = () => {};
  try { assert.deepEqual(normalizeProxyPool({ enabled: true, strategy: 'x', entries: [A] }, { strict: false }), normalizeProxyPool(undefined)); }
  finally { console.warn = warn; }
  assert.deepEqual(normalizeProxyPool({ entries: [A, B] }, { secret: SECRET }).entries, [A, B]);
});

test('normalizeProxyPoolClientKeys accepts default/overrides for known ids and rejects everything else without echoing values', () => {
  const knownIds = ['legacy', 'ck_a', 'ck_b'];
  assert.deepEqual(PROXY_POOL_CLIENT_KEYS_DEFAULT, { default: 'on', overrides: {} });
  assert.ok(Object.isFrozen(PROXY_POOL_CLIENT_KEYS_DEFAULT) && Object.isFrozen(PROXY_POOL_CLIENT_KEYS_DEFAULT.overrides));
  assert.deepEqual(normalizeProxyPoolClientKeys(undefined, { knownIds }), { default: 'on', overrides: {} });
  assert.deepEqual(normalizeProxyPoolClientKeys({}, { knownIds }), { default: 'on', overrides: {} }, 'missing subfields take defaults');
  assert.deepEqual(normalizeProxyPoolClientKeys({ default: 'off', overrides: { ck_a: 'on', legacy: 'off' } }, { knownIds }), { default: 'off', overrides: { ck_a: 'on', legacy: 'off' } });
  assert.deepEqual(normalizeProxyPoolClientKeys({ overrides: { legacy: 'off' } }), { default: 'on', overrides: { legacy: 'off' } }, 'legacy is known by default');
  const secretLike = `cps_${'a'.repeat(96)}`;
  const invalid = [
    [null, /^Error: proxyPoolClientKeys must be an object$/], [[], /must be an object/], ['on', /must be an object/],
    [{ default: 'yes' }, /proxyPoolClientKeys\.default must be one of on, off/], [{ default: true }, /proxyPoolClientKeys\.default/],
    [{ overrides: [] }, /proxyPoolClientKeys\.overrides must be an object/], [{ overrides: null }, /proxyPoolClientKeys\.overrides must be an object/],
    [{ overrides: { ck_a: 'default' } }, /proxyPoolClientKeys\.overrides\.ck_a must be one of on, off/], [{ overrides: { ck_a: true } }, /overrides\.ck_a/],
    [{ overrides: { ck_unknown: 'on' } }, /^Error: proxyPoolClientKeys\.overrides contains an unknown client key id$/],
    [{ overrides: { [secretLike]: 'on' } }, /unknown client key id/], [{ overrides: JSON.parse('{"__proto__":"on"}') }, /unknown client key id/],
    [{ default: 'on', extra: 1 }, /^Error: proxyPoolClientKeys\.extra is not a known field$/], [{ [secretLike]: 1 }, /^Error: proxyPoolClientKeys contains an unknown field$/],
  ];
  for (const [value, pattern] of invalid) {
    assert.throws(() => normalizeProxyPoolClientKeys(value, { knownIds }), pattern, JSON.stringify(value));
    try { normalizeProxyPoolClientKeys(value, { knownIds }); } catch (error) { assert.equal(error.message.includes(secretLike), false); }
  }
  const warn = console.warn; console.warn = () => {};
  try { assert.deepEqual(normalizeProxyPoolClientKeys({ default: 'nope' }, { knownIds, strict: false }), { default: 'on', overrides: {} }); }
  finally { console.warn = warn; }
});

test('entryIdFor is an 8-hex HMAC of the normalized URL', () => {
  const id = entryIdFor(SECRET, A);
  assert.match(id, /^[0-9a-f]{8}$/);
  assert.equal(entryIdFor(SECRET, A), id);
  assert.notEqual(entryIdFor('other-secret', A), id);
  assert.notEqual(entryIdFor(SECRET, B), id);
});

test('parseRetryAfter accepts seconds and HTTP dates with clamping', () => {
  const now = Date.parse('2026-10-20T00:00:00Z');
  assert.equal(parseRetryAfter('30', now), 30000);
  assert.equal(parseRetryAfter(['5'], now), 5000);
  assert.equal(parseRetryAfter('0', now), 1000);
  assert.equal(parseRetryAfter('100000', now), 600000);
  assert.equal(parseRetryAfter('Tue, 20 Oct 2026 00:00:42 GMT', now), 42000);
  assert.equal(parseRetryAfter('Mon, 19 Oct 2026 00:00:00 GMT', now), 1000);
  for (const value of [undefined, null, '', 'soon', '-5', '1.5']) assert.equal(parseRetryAfter(value, now), null);
});

test('round-robin cycles in order and skips cooling entries until expiry', () => {
  const { runtime, clock } = harness({ throttleCooldownMs: 5000, failureCooldownMs: 3000 });
  runtime.replaceEntries([A, B, C]);
  assert.deepEqual(Array.from({ length: 6 }, () => pickUrl(runtime)), [A, B, C, A, B, C]);
  const { entry } = runtime.pickEntry();
  assert.equal(entry.url, A);
  entry.noteThrottle(null); entry.release();
  assert.deepEqual(Array.from({ length: 4 }, () => pickUrl(runtime)), [B, C, B, C]);
  const b = runtime.pickEntry().entry;
  b.noteConnectFailure(); b.release();
  assert.equal(pickUrl(runtime), C);
  assert.equal(pickUrl(runtime), C);
  clock.t += 3000;
  assert.equal(pickUrl(runtime), B, 'connect cooldown expired');
  const c = runtime.pickEntry().entry;
  c.noteThrottle(8000); c.release();
  assert.equal(pickUrl(runtime), B);
  clock.t += 2000;
  assert.deepEqual([pickUrl(runtime), pickUrl(runtime)], [A, B], 'throttle cooldown expired; C still cooling with Retry-After');
  const status = runtime.status();
  assert.deepEqual(status.entries.map((e) => e.state), ['ok', 'ok', 'cooldown']);
  assert.equal(status.entries[2].reason, 'throttle');
  assert.equal(status.entries[2].cooldownUntil, clock.t + 6000);
  assert.equal(status.available, 2);
});

test('exclude, hasAvailable and fallback retryAt', () => {
  const { runtime, clock } = harness({ throttleCooldownMs: 10000 });
  runtime.replaceEntries([A, B]);
  const exclude = new Set([A]);
  assert.equal(pickUrl(runtime, { exclude }), B);
  assert.equal(pickUrl(runtime, { exclude }), B);
  const idB = entryIdFor(SECRET, B);
  assert.equal(runtime.hasAvailable(new Set([A, idB])), false);
  assert.equal(runtime.hasAvailable(new Set([A])), true);
  for (const url of [A, B]) {
    const { entry } = runtime.pickEntry({ exclude: new Set([A, B].filter((u) => u !== url)) });
    entry.noteThrottle(url === A ? 2000 : null); entry.release();
  }
  const result = runtime.pickEntry();
  assert.deepEqual(result, { entry: null, retryAt: clock.t + 2000 });
  assert.equal(runtime.earliestRetryAt({ exclude: new Set([A]) }), clock.t + 10000);
  assert.deepEqual(createProxyPoolRuntime({ secret: SECRET }).pickEntry(), { entry: null, retryAt: null });
  runtime.noteFallback(); runtime.noteFallback();
  assert.deepEqual(runtime.status().fallbacks, { total: 2, recent: 2 });
  clock.t += 16 * 60000;
  assert.deepEqual(runtime.status().fallbacks, { total: 2, recent: 0 });
});

test('random strategy uses the injected random over available entries', () => {
  const { runtime } = harness({ strategy: 'random', randomSeq: [2, 0, 1, 1, 0, 2] });
  runtime.replaceEntries([A, B, C]);
  assert.deepEqual(Array.from({ length: 6 }, () => pickUrl(runtime)), [C, A, B, B, A, C]);
  const real = createProxyPoolRuntime({ secret: SECRET });
  real.configure({ strategy: 'random' });
  real.replaceEntries([A, B, C]);
  const seen = new Set(Array.from({ length: 60 }, () => pickUrl(real)));
  assert.equal(seen.size, 3);
  // 冷却条目不参与随机。
  const { entry } = runtime.pickEntry(); entry.noteConnectFailure(); entry.release();
  const cooled = entry.url;
  for (let i = 0; i < 10; i++) assert.notEqual(pickUrl(runtime), cooled);
});

test('stickyKey pins a session to one entry, fails over by weight, returns when healthy, and ignores the cursor', () => {
  for (const strategy of ['round-robin', 'random']) {
    const { runtime, clock } = harness({ strategy, throttleCooldownMs: 5000 });
    const urls = [A, B, C];
    runtime.replaceEntries(urls);
    // 同一会话反复选择始终得到同一个条目，不受 strategy 与游标影响；不同会话分散到多个条目。
    const first = pickUrl(runtime, { stickyKey: 'session-1' });
    for (let i = 0; i < 20; i++) assert.equal(pickUrl(runtime, { stickyKey: 'session-1' }), first);
    const spread = new Set(Array.from({ length: 60 }, (_, i) => pickUrl(runtime, { stickyKey: `session-${i}` })));
    assert.equal(spread.size, 3);
    // 没有 stickyKey 的调用仍按策略选择（轮询在三个条目间循环）。
    if (strategy === 'round-robin') assert.equal(new Set([0, 1, 2].map(() => pickUrl(runtime))).size, 3);
    // 条目被排除（本请求已失败过）：落到权重次高的条目，对同一会话稳定。
    const second = pickUrl(runtime, { stickyKey: 'session-1', exclude: new Set([first]) });
    assert.notEqual(second, first);
    for (let i = 0; i < 5; i++) assert.equal(pickUrl(runtime, { stickyKey: 'session-1', exclude: new Set([first]) }), second);
    // 条目 HTML 429 冷却：同样落到次高条目；冷却结束后回到原条目。
    const { entry } = runtime.pickEntry({ stickyKey: 'session-1' });
    assert.equal(entry.url, first);
    entry.noteThrottle(); entry.release();
    for (let i = 0; i < 5; i++) assert.equal(pickUrl(runtime, { stickyKey: 'session-1' }), second);
    clock.t += 6000;
    assert.equal(pickUrl(runtime, { stickyKey: 'session-1' }), first);
    // 全部不可用时与普通选择一致：没有条目。
    assert.equal(pickUrl(runtime, { stickyKey: 'session-1', exclude: new Set(urls) }), null);
  }
});

const D = 'socks5://user-test-session-4:pass-test@127.0.0.1:10004';
const E = 'socks5://user-test-session-5:pass-test@127.0.0.1:10005';
const F = 'socks5://user-test-session-6:pass-test@127.0.0.1:10006';
const stateOf = (runtime) => Object.fromEntries(runtime.status().entries.map((entry) => [entry.entryId, entry.state]));

test('stickyRetentionMs keeps a bound entry across batch swaps until its lifetime ends; unbound old entries retire at once', () => {
  const { runtime, clock } = harness({ throttleCooldownMs: 5000, stickyRetentionMs: 600000 });
  runtime.replaceEntries([A, B, C]);
  const bound = pickUrl(runtime, { stickyKey: 'session-1' });
  clock.t += 200000;
  runtime.replaceEntries([D, E, F]);
  const retained = runtime.status().entries.filter((entry) => entry.state === 'retained');
  assert.equal(retained.length, 1, 'only the bound entry is retained; unbound old entries retire at once');
  const boundId = retained[0].entryId;
  assert.equal(entryIdFor(SECRET, bound), boundId);
  assert.equal(runtime.status().total, 3); assert.equal(runtime.status().available, 3, 'retained entries are not counted as available');
  // 同一会话继续用旧条目；轮询与其他会话只在新批里选。
  for (let i = 0; i < 5; i++) assert.equal(pickUrl(runtime, { stickyKey: 'session-1' }), bound);
  for (let i = 0; i < 30; i++) assert.ok([D, E, F].includes(pickUrl(runtime, { stickyKey: `other-${i}` })), 'other sessions only use the new batch');
  for (let i = 0; i < 6; i++) assert.ok([D, E, F].includes(pickUrl(runtime)), 'sessionless calls only use the new batch');
  // 绑定的旧条目冷却：本次临时用新批条目，不改绑定；冷却结束后回到旧条目。
  const { entry } = runtime.pickEntry({ stickyKey: 'session-1' });
  entry.noteConnectFailure(); entry.release();
  const temp = pickUrl(runtime, { stickyKey: 'session-1' });
  assert.ok([D, E, F].includes(temp));
  assert.equal(pickUrl(runtime, { stickyKey: 'session-1' }), temp, 'temporary choice is stable');
  clock.t += 31000;
  assert.equal(pickUrl(runtime, { stickyKey: 'session-1' }), bound, 'returns to the bound entry once healthy');
  // 再换一批（仍在 bornAt + 600 s 内）：继续保留。
  clock.t += 100000;
  runtime.replaceEntries([E, F, [A, B, C].find((url) => url !== bound)]);
  assert.equal(pickUrl(runtime, { stickyKey: 'session-1' }), bound);
  // 寿命结束：绑定失效，改选当前批并重新绑定；旧条目释放。
  clock.t += 400000;
  const after = pickUrl(runtime, { stickyKey: 'session-1' });
  assert.notEqual(after, bound);
  assert.notEqual(stateOf(runtime)[boundId], 'retained', 'expired entry is released');
  assert.equal(pickUrl(runtime, { stickyKey: 'session-1' }), after, 'rebound and stable');
});

test('retain:false and a zero retention drop every binding and retained entry', () => {
  const { runtime } = harness({ stickyRetentionMs: 600000 });
  runtime.replaceEntries([A, B, C]);
  pickUrl(runtime, { stickyKey: 'session-1' });
  runtime.replaceEntries([D, E, F]);
  assert.equal(Object.values(stateOf(runtime)).filter((state) => state === 'retained').length, 1);
  runtime.replaceEntries([D, E, F], { retain: false });
  assert.equal(Object.values(stateOf(runtime)).includes('retained'), false);
  assert.ok([D, E, F].includes(pickUrl(runtime, { stickyKey: 'session-1' })));
  // 关闭保留：之后换批不再保留旧条目。
  runtime.configure({ stickyRetentionMs: 0 });
  pickUrl(runtime, { stickyKey: 'session-1' });
  runtime.replaceEntries([A, B, C]);
  assert.equal(Object.values(stateOf(runtime)).includes('retained'), false);
});

test('retained entries keep their in-flight stream and show in status without exposing URLs', () => {
  const { runtime, clock, destroyed } = harness({ stickyRetentionMs: 600000 });
  runtime.replaceEntries([A, B, C]);
  const { entry } = runtime.pickEntry({ stickyKey: 'session-1' });
  entry.agent; entry.commit();
  runtime.replaceEntries([D, E, F]);
  const projected = JSON.stringify(runtime.status());
  assert.equal(projected.includes('user-test-session'), false);
  assert.ok(runtime.status().entries.some((item) => item.state === 'retained' && item.inFlight === 1));
  clock.t += 700000; runtime.sweep();
  assert.equal(Object.values(stateOf(runtime)).includes('retained'), false);
  assert.equal(destroyed.length, 0, 'in-flight entry is only destroyed once released');
  entry.release();
  assert.equal(destroyed.length >= 1, true);
});

test('maxRpmPerProxy reserves, commits, refunds and blocks within the window', () => {
  const { runtime, clock } = harness({ maxRpmPerProxy: 2 });
  runtime.replaceEntries([A, B]);
  const picks = [];
  for (let i = 0; i < 4; i++) { const { entry } = runtime.pickEntry(); entry.commit(); picks.push(entry); }
  assert.deepEqual(picks.map((e) => e.url), [A, B, A, B]);
  const blocked = runtime.pickEntry();
  assert.equal(blocked.entry, null);
  assert.equal(blocked.retryAt, clock.t + 60000);
  assert.deepEqual(runtime.status().entries.map((e) => [e.state, e.rpmUsed, e.inFlight]), [['rate-limited', 2, 2], ['rate-limited', 2, 2]]);
  for (const entry of picks) entry.release();
  assert.equal(runtime.pickEntry().entry, null, 'release after commit does not refund');
  clock.t += 60001;
  const reserved = runtime.pickEntry().entry;
  assert.equal(reserved.url, A);
  const second = runtime.pickEntry().entry;
  assert.equal(second.url, B);
  const third = runtime.pickEntry().entry;
  assert.equal(third.url, A);
  assert.equal(runtime.pickEntry().entry.url, B);
  assert.equal(runtime.pickEntry().entry, null, 'reservations count against the limit');
  third.release();
  assert.equal(runtime.pickEntry().entry.url, A, 'uncommitted release refunds the reservation');
  reserved.commit(); reserved.commit(); reserved.release(); reserved.release();
  assert.equal(runtime.status().entries[0].rpmUsed, 1);
  assert.equal(runtime.status().entries[0].recent.requests, 3);
});

test('replaceEntries preserves same-URL state, retires in-flight entries and sweeps', () => {
  const { runtime, clock, created, destroyed } = harness({ retireGraceMs: 10000, throttleCooldownMs: 50000 });
  const first = runtime.replaceEntries([A, B, A]);
  assert.deepEqual([first.changed, first.active, first.dropped], [true, 2, []]);
  const a = runtime.pickEntry().entry; a.agent; a.noteThrottle(null); a.commit(); a.release();
  const b = runtime.pickEntry().entry; const bAgent = b.agent; b.commit();
  assert.equal(b.agent, bAgent, 'agent cached per entry');
  assert.equal(created.length, 2);
  // 同 URL 保留冷却与 agent；B 在途 -> retiring；A 空闲保留。
  const g = runtime.status().generation;
  const second = runtime.replaceEntries([A, C]);
  assert.deepEqual([second.changed, second.generation, second.active, second.retiring], [true, g + 1, 2, 1]);
  assert.equal(destroyed.length, 0);
  const status = runtime.status();
  assert.deepEqual(status.entries.map((e) => e.state), ['cooldown', 'ok', 'retiring']);
  assert.equal(status.total, 2);
  assert.equal(pickUrl(runtime), C, 'cursor reset; A still cooling; B retiring not selectable');
  assert.deepEqual(runtime.replaceEntries([A, C]).changed, false);
  b.release();
  assert.deepEqual(destroyed, [bAgent], 'retired agent destroyed when in-flight reaches zero');
  assert.equal(runtime.status().retiring, 0);
  // 强制兜底：退役超过宽限期。
  const c = runtime.pickEntry({ exclude: new Set([A]) }).entry; const cAgent = c.agent;
  runtime.replaceEntries([A]);
  assert.equal(runtime.status().retiring, 1);
  assert.ok(runtime.secretSeeds().includes('user-test-session-3'), 'retiring entries remain redaction seeds');
  clock.t += 10000;
  assert.equal(runtime.sweep(), 1);
  assert.ok(destroyed.includes(cAgent));
  c.release();
  assert.equal(runtime.status().retiring, 0);
  // 移除且空闲的条目立即销毁 agent；重新加入的退役条目复活。
  clock.t += 50000;
  const a2 = runtime.pickEntry().entry;
  const aAgent = runtime.pickEntry().entry.agent;
  runtime.replaceEntries([]);
  assert.equal(runtime.status().retiring, 1);
  runtime.replaceEntries([A]);
  assert.equal(runtime.status().retiring, 0);
  assert.equal(runtime.status().entries[0].inFlight, 2);
  a2.release();
  runtime.destroyAll();
  assert.ok(destroyed.includes(aAgent));
  assert.equal(runtime.status().total, 0);
});

test('replaceEntries drops entry-id collisions and invalid URLs', () => {
  const runtime = createProxyPoolRuntime({ secret: SECRET });
  // 构造碰撞：在大量候选里找两个 8 hex 前缀相同的 URL。
  const seen = new Map();
  let pair = null;
  for (let i = 0; !pair; i++) {
    const url = `socks5://h${i}.example:1`;
    const id = entryIdFor(SECRET, url);
    if (seen.has(id)) pair = [seen.get(id), url]; else seen.set(id, url);
  }
  const result = runtime.replaceEntries([pair[0], 'not a url', pair[1], A]);
  assert.deepEqual(result.dropped, [{ index: 1, reason: 'invalid' }, { index: 2, reason: 'collision' }]);
  assert.equal(result.active, 2);
  assert.throws(() => normalizeProxyPool({ entries: pair }, { secret: SECRET }), /^Error: proxyPool\.entries\[1\] entry id collides with proxyPool\.entries\[0\]$/);
});

test('status and handles never expose URLs or credentials; seeds contain decoded credentials', () => {
  const encoded = 'socks5://user%2Dtest%40x:pass%3Atest@127.0.0.1:10009';
  const { runtime } = harness();
  runtime.replaceEntries([A, encoded, C]);
  const { entry } = runtime.pickEntry();
  assert.equal(JSON.stringify(entry).includes('pass-test'), false);
  assert.deepEqual(Object.keys(entry).filter((k) => typeof entry[k] !== 'function'), ['entryId', 'endpointKey', 'scheme', 'leasedAt']);
  entry.release();
  const text = JSON.stringify(runtime.status());
  assert.doesNotMatch(text, /pass|user|%/);
  assert.deepEqual(runtime.status().entries.map((e) => [e.scheme, e.endpointKey]), [
    ['socks5', 'socks5://127.0.0.1:10001'], ['socks5', 'socks5://127.0.0.1:10009'], ['http', 'http://127.0.0.1:10003'],
  ]);
  const seeds = runtime.secretSeeds();
  for (const seed of ['user-test-session-1', 'pass-test', 'user-test@x', 'pass:test', 'user%2Dtest%40x']) assert.ok(seeds.includes(seed), seed);
  assert.equal(new Set(seeds).size, seeds.length);
});

test('configure ignores invalid values and runtime requires a secret', () => {
  const { runtime } = harness();
  assert.equal(runtime.configure({ strategy: 'nope', maxRpmPerProxy: -1 }).strategy, 'round-robin');
  assert.equal(runtime.settings().maxRpmPerProxy, 0);
  assert.throws(() => createProxyPoolRuntime({}), /secret/);
});

test('secretSeeds is cached per batch and sampleEntries exposes no URL in projections', () => {
  const runtime = createProxyPoolRuntime({ secret: 'test-secret', createAgent: () => ({ destroy() {} }) });
  runtime.replaceEntries(['socks5://user-test-session-1:pass-test@127.0.0.1:1080/', 'socks5://user-test-session-2:pass-test@127.0.0.1:1081/', 'http://127.0.0.1:3128/']);
  const seeds = runtime.secretSeeds();
  assert.deepEqual([...seeds].sort(), ['pass-test', 'user-test-session-1', 'user-test-session-2']);
  assert.equal(runtime.secretSeeds(), seeds, 'same array until the batch changes');
  const sample = runtime.sampleEntries(2);
  assert.equal(sample.length, 2);
  for (const item of sample) {
    assert.match(item.entryId, /^[0-9a-f]{8}$/);
    assert.match(item.url, /^(socks5|http):\/\//);
    assert.doesNotMatch(JSON.stringify(item), /user-test-session|pass-test/);
  }
  assert.equal(runtime.sampleEntries(50).length, 3);
  runtime.replaceEntries(['socks5://user-test-session-3:pass-test@127.0.0.1:1082/']);
  assert.notEqual(runtime.secretSeeds(), seeds, 'a new batch recomputes seeds');
  assert.ok(runtime.secretSeeds().includes('user-test-session-3'));
});
