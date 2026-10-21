// 代理池聊天链路与其他调用路径：换代理重试、回退、按条目限速、额度刷新/目录、日志与脱敏、管理接口。
// 只使用本地假上游与假 SOCKS5；凭据全部是占位值。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import os from 'node:os';
import { execFileSync, execSync } from 'node:child_process';
import { USER, PASS, API_KEY, listen, close, freePort, sleep, waitFor, setup, manualPool, socksUrl, startServer, stopServer } from './proxy-pool-fixture.js';

const HTML_429 = '<html><body>429 Too Many Requests</body></html>';
const throttleResponder = (throttled) => (via, res, { body }) => {
  if (throttled.has(via)) { res.writeHead(429, { 'Content-Type': 'text/html' }); return res.end(HTML_429); }
  if (body.stream) { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); return res.end('data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n'); }
  res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }));
};
const auth = (user, pass) => user.startsWith('user-test-session-') && pass === PASS;
const POOL_ID = /^pool:[0-9a-f]{8}$/;
const ownAccount = (port) => [{ id: 'a0', name: 'a0', key: 'local-a0', enabled: true, maxConcurrent: 0, priority: 10, proxyUrl: `socks5://127.0.0.1:${port}` }];
async function rowsFor(s, kind, count) {
  return waitFor(async () => { const items = await s.logs(kind); return items.length >= count ? items : null; }, `${kind} log rows`);
}
function assertNoSecrets(text, label) {
  for (const secret of [USER, 'user-test-session-', PASS, API_KEY]) assert.equal(String(text).includes(secret), false, `${label} must not contain ${secret}`);
}

test('HTML 429 on a pool entry moves the same request to another entry at once, without account backoff', async (t) => {
  const throttled = new Set(['A']);
  const s = await setup(t, { responder: throttleResponder(throttled) });
  const [a, b, c, own] = [await s.socks('A', { auth }), await s.socks('B', { auth }), await s.socks('C', { auth }), await s.socks('own')];
  await s.start({ accounts: ownAccount(own.port), proxyPool: manualPool([socksUrl(a.port, 'user-test-session-a'), socksUrl(b.port, 'user-test-session-b'), socksUrl(c.port, 'user-test-session-c')]) });

  let started = Date.now();
  const first = await s.chatFull();
  assert.equal(first.status, 200, first.text);
  assert.ok(Date.now() - started < 500, 'egress retry does not wait for an account backoff');
  assert.deepEqual(s.seen, ['A', 'B']);

  const [row] = await rowsFor(s, 'requests', 1);
  assert.equal(row.attempts.length, 2);
  assert.ok(row.attempts.every((attempt) => POOL_ID.test(attempt.egress) && attempt.poolFallback === false));
  assert.notEqual(row.attempts[0].egress, row.attempts[1].egress, 'two distinct pool entries');
  assert.equal(row.egress, row.attempts[1].egress); assert.equal(row.poolFallback, false);
  assert.equal(row.attempts[0].scopeEvidence, 'gateway_html_throttle'); assert.equal(row.attempts[0].healthAction, 'none');
  const [errorRow] = await rowsFor(s, 'errors', 1);
  assert.equal(errorRow.egress, row.attempts[0].egress); assert.equal(errorRow.accountAction, null);

  // Streaming takes the same path: the cursor is at C, which now throttles; A is still cooling, so B serves the stream.
  s.seen.length = 0; throttled.clear(); throttled.add('C');
  started = Date.now();
  const streamed = await s.chatFull({ stream: true });
  assert.equal(streamed.status, 200, streamed.text);
  assert.match(streamed.text, /\[DONE\]/);
  assert.ok(Date.now() - started < 500);
  assert.deepEqual(s.seen, ['C', 'B']);

  const view = await s.get();
  assert.equal(view.accounts[0].state?.cooldownUntil || 0, 0, 'account is not cooled');
  assert.equal(view.accounts[0].state?.hardQuarantined || false, false);

  // No account-level gateway backoff was recorded: once the pool is disabled, the account egress is used without waiting.
  const disabled = s.read(); disabled.proxyPool.enabled = false;
  fs.writeFileSync(s.file, JSON.stringify(disabled, null, 2));
  assert.equal((await s.post('/api/config/reload', {})).status, 200);
  s.seen.length = 0; throttled.clear();
  started = Date.now();
  assert.equal(await s.chat(), 200);
  assert.ok(Date.now() - started < 500, 'account egress is not in a gateway backoff');
  assert.deepEqual(s.seen, ['own']);
});

test('a pool entry that refuses connections is skipped within the request; the account stays healthy', async (t) => {
  const s = await setup(t);
  const deadPort = await freePort();
  const a = await s.socks('A', { auth });
  await s.start({ proxyPool: manualPool([`socks5://${USER}:${PASS}@127.0.0.1:${deadPort}`, socksUrl(a.port, 'user-test-session-a')], { failureCooldownMs: 1000 }) });
  const first = await s.chatFull();
  assert.equal(first.status, 200, first.text);
  assert.deepEqual(s.seen, ['A']);
  await sleep(1100);
  // Streaming transport failure ('!up' branch) after the cooldown expired: dead entry is first again in round-robin.
  const second = await s.chatFull({ stream: true });
  assert.equal(second.status, 200, second.text);
  assert.match(second.text, /\[DONE\]/);
  assert.deepEqual(s.seen, ['A', 'A']);

  const errors = await rowsFor(s, 'errors', 2);
  for (const row of errors) {
    assert.equal(row.errorScope, 'proxy'); assert.equal(row.scopeEvidence, 'proxy_pool_connect');
    assert.equal(row.healthAction, 'none'); assert.equal(row.accountAction, null); assert.equal(row.category, 'proxy');
    assert.match(row.egress, POOL_ID);
  }
  const view = await s.get();
  assert.equal(view.accounts[0].state, null, 'no account state was written');
  const status = await s.get('/api/proxy-pool/status');
  assert.equal(status.entries.length, 2);
  assert.ok(status.entries.some((entry) => entry.recent.connectFailures === 2));
  for (const text of [JSON.stringify(errors), JSON.stringify(status), s.child.output()]) assertNoSecrets(text, 'diagnostics');
});

test('egress retries exhausted on HTML 429 return 429 with a bounded Retry-After and never use the account egress', async (t) => {
  const throttled = new Set(['A', 'B', 'C']);
  const s = await setup(t, { responder: throttleResponder(throttled) });
  const [a, b, c, own] = [await s.socks('A'), await s.socks('B'), await s.socks('C'), await s.socks('own')];
  await s.start({ accounts: ownAccount(own.port), proxyPool: manualPool([a, b, c].map((proxy) => `socks5://127.0.0.1:${proxy.port}`)) });
  const result = await s.chatFull();
  assert.equal(result.status, 429);
  const retryAfter = Number(result.headers.get('retry-after'));
  assert.ok(Number.isInteger(retryAfter) && retryAfter >= 1 && retryAfter <= 60, `Retry-After ${retryAfter}`);
  assert.equal(JSON.parse(result.text).error.type, 'rate_limit_error');
  assert.deepEqual(s.seen, ['A', 'B', 'C'], 'default egressRetries=2 → three entries, no account egress');
  const [row] = await rowsFor(s, 'requests', 1);
  assert.ok(row.attempts.every((attempt) => POOL_ID.test(attempt.egress)));
});

test('maxRpmPerProxy exhausts entries and falls back to the account egress with poolFallback', async (t) => {
  const s = await setup(t);
  const [a, b, own] = [await s.socks('A'), await s.socks('B'), await s.socks('own')];
  await s.start({ accounts: ownAccount(own.port), proxyPool: manualPool([a, b].map((proxy) => `socks5://127.0.0.1:${proxy.port}`), { maxRpmPerProxy: 1 }) });
  for (let i = 0; i < 3; i++) assert.equal(await s.chat(), 200);
  assert.deepEqual(s.seen, ['A', 'B', 'own']);
  const rows = (await rowsFor(s, 'requests', 3)).sort((x, y) => x.ts - y.ts);
  assert.deepEqual(rows.map((row) => row.poolFallback), [false, false, true]);
  assert.match(rows[0].egress, POOL_ID);
  assert.equal(rows[2].egress, 'account-proxy');
  const status = await s.get('/api/proxy-pool/status');
  assert.equal(status.fallbacks.total, 1);
  assert.ok(status.entries.every((entry) => entry.state === 'rate-limited'));
});

test('quota refresh and the model catalog go through pool entries; status/test/refresh/balance APIs stay credential-free', async (t) => {
  const s = await setup(t, { env: { CLINE_PASS_TEST_QUOTA_SUCCESS_MS: '100', CLINE_PASS_TEST_QUOTA_FAILURE_MS: '200' } });
  const deadPort = await freePort();
  const [a, own] = [await s.socks('A', { auth }), await s.socks('own')];
  await s.start({ accounts: ownAccount(own.port), proxyPool: manualPool([socksUrl(a.port, 'user-test-session-a'), `socks5://${USER}:${PASS}@127.0.0.1:${deadPort}`], { floppydata: { apiKey: API_KEY } }) });

  const refreshed = await s.post('/api/statistics/quota-refresh', { force: true });
  assert.equal(refreshed.status, 200, JSON.stringify(refreshed.data));
  await waitFor(() => s.seenGet.some((call) => call.path === '/users/me/plan/usage-limits'), 'quota request');
  // Non-chat paths make a single call without egress retry: when round-robin lands on the dead entry the call
  // fails (and cools that entry, never falling back to direct), the next call uses A.
  for (let i = 0; i < 2 && !s.seenGet.some((call) => call.path === '/models'); i++) await fetch(`http://127.0.0.1:${s.port}/api/models`);
  const catalogCall = await waitFor(() => s.seenGet.find((call) => call.path === '/models'), 'catalog request');
  for (const call of s.seenGet) assert.equal(call.via, 'A', `${call.path} goes through the pool entry`);
  assert.equal(catalogCall.via, 'A');

  const status = await s.get('/api/proxy-pool/status');
  assert.deepEqual(Object.keys(status).sort(), ['available', 'clientKeys', 'enabled', 'entries', 'fallbacks', 'floppydata', 'retiring', 'source', 'strategy', 'total']);
  assert.deepEqual(status.clientKeys, [{ id: 'legacy', name: 'Legacy', mode: 'default', effective: true }], 'absent proxyPoolClientKeys: every key uses the enabled pool');
  assert.equal(status.enabled, true); assert.equal(status.source, 'manual'); assert.equal(status.floppydata, null);
  for (const entry of status.entries) assert.match(entry.endpointKey, /^socks5:\/\/127\.0\.0\.1:\d+$/);

  const before = JSON.stringify((await s.get('/api/proxy-pool/status')).entries.map((entry) => [entry.entryId, entry.state, entry.cooldownUntil, entry.rpmUsed]));
  const tested = await s.post('/api/proxy-pool/test', { sample: 50 });
  assert.equal(tested.status, 200);
  assert.equal(tested.data.results.length, 2);
  const byOk = Object.fromEntries(tested.data.results.map((item) => [item.ok, item]));
  assert.equal(byOk.true.status, 200); assert.equal(byOk.false.errorCategory, 'proxy');
  const after = JSON.stringify((await s.get('/api/proxy-pool/status')).entries.map((entry) => [entry.entryId, entry.state, entry.cooldownUntil, entry.rpmUsed]));
  assert.equal(after, before, 'the connectivity test does not touch cooldown or RPM state');
  assert.equal((await s.post('/api/proxy-pool/test', { sample: 51 })).status, 400);
  assert.equal((await s.post('/api/proxy-pool/test', { other: 1 })).status, 400);
  assert.equal((await s.post('/api/proxy-pool/refresh', {})).status, 409);

  for (const text of [JSON.stringify(status), JSON.stringify(tested.data), s.child.output()]) assertNoSecrets(text, 'pool API');
});

test('logs, metadata and error bodies never contain pool credentials; proxyHealth is attributed to the actual entry', async (t) => {
  const throttled = new Set(['A']);
  const s = await setup(t, { responder: throttleResponder(throttled) });
  const [a, b] = [await s.socks('A', { auth }), await s.socks('B', { auth })];
  const urls = [socksUrl(a.port, 'user-test-session-a'), socksUrl(b.port, 'user-test-session-b')];
  await s.start({ proxyPool: manualPool(urls, { egressRetries: 0, floppydata: { apiKey: API_KEY } }) });
  const failed = await s.chatFull();
  assert.equal(failed.status, 429, 'egressRetries=0 stops after the first throttled entry');
  assertNoSecrets(failed.text, 'error body');
  for (const [name, value] of failed.headers) assertNoSecrets(`${name}: ${value}`, 'response header');
  assert.equal(await s.chat(), 200);
  await rowsFor(s, 'requests', 2); await rowsFor(s, 'errors', 1);

  const stats = await s.get('/api/statistics');
  const ids = (stats.proxyHealth?.proxies || []).map((proxy) => proxy.id);
  assert.ok(ids.includes(`socks5://127.0.0.1:${a.port}`) && ids.includes(`socks5://127.0.0.1:${b.port}`), JSON.stringify(ids));
  await s.stop();
  const files = [path.join(s.dir, 'metadata.json'), ...fs.readdirSync(path.join(s.dir, 'logs')).map((name) => path.join(s.dir, 'logs', name))];
  for (const file of files) if (fs.statSync(file).isFile()) assertNoSecrets(fs.readFileSync(file, 'utf8'), path.basename(file));
});

test('floppydata refresh/balance endpoints project only enums and never echo the apiKey', async (t) => {
  const s = await setup(t);
  let connectionStatus = 402, balanceStatus = 200;
  const api = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (req.url === '/v2/account/balances') {
        res.writeHead(balanceStatus, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(balanceStatus === 200 ? { proxy: { rotating: { total: { traffic: { availableBytes: 12_500_000_000 } }, expiring: [{ expiresAt: '2030-01-02T03:04:05Z' }] } } } : { error: `bad key ${API_KEY}` }));
      }
      res.writeHead(connectionStatus, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `rejected ${API_KEY}` }));
    });
  });
  const apiPort = await listen(api);
  t.after(() => close(api));
  await s.start({ proxyPool: { enabled: true, source: 'floppydata', floppydata: { apiKey: API_KEY, apiBase: `http://127.0.0.1:${apiPort}`, count: 2 } } });
  const status = await waitFor(async () => { const value = await s.get('/api/proxy-pool/status'); return value.floppydata?.lastError ? value : null; }, 'first batch result');
  assert.equal(status.floppydata.lastError, 'insufficient_balance');
  assert.equal(status.total, 0);
  const refreshed = await s.post('/api/proxy-pool/refresh', { wait: true });
  assert.equal(refreshed.status, 200);
  assert.equal(refreshed.data.floppydata.lastError, 'insufficient_balance');
  // Default refresh returns immediately (202) while the batch runs; wait must be boolean.
  const started = await s.post('/api/proxy-pool/refresh', {});
  assert.equal(started.status, 202);
  assert.equal(started.data.floppydata.state, 'refreshing');
  assert.equal((await s.post('/api/proxy-pool/refresh', { wait: 'yes' })).status, 400);
  await waitFor(async () => (await s.get('/api/proxy-pool/status')).floppydata?.state !== 'refreshing', 'background refresh settles');
  // Pool empty → the chat falls back to the account egress (direct here) with poolFallback.
  assert.equal(await s.chat(), 200);
  assert.deepEqual(s.seen, ['direct']);
  const balance = await s.get('/api/proxy-pool/balance');
  assert.deepEqual(balance, { ok: true, availableBytes: 12_500_000_000, availableGb: 12.5, expiringAt: '2030-01-02T03:04:05.000Z' });
  balanceStatus = 401;
  const denied = await fetch(`http://127.0.0.1:${s.port}/api/proxy-pool/balance`);
  assert.equal(denied.status, 502);
  const deniedBody = await denied.json();
  assert.equal(deniedBody.error.code, 'unauthorized');
  for (const text of [JSON.stringify(status), JSON.stringify(refreshed.data), JSON.stringify(deniedBody), s.child.output()]) assert.equal(text.includes(API_KEY), false);
  const [row] = await rowsFor(s, 'requests', 1);
  assert.equal(row.poolFallback, true); assert.equal(row.egress, 'direct');
});

const okResponder = (via, res, { body }) => {
  if (body.stream) { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); return res.end('data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n'); }
  res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }));
};
async function assertDiagnosticsClean(s, extra = []) {
  const texts = [JSON.stringify(await s.logs('requests')), JSON.stringify(await s.logs('errors')), JSON.stringify(await s.get('/api/proxy-pool/status')), s.child.output(), ...extra];
  for (const text of texts) assertNoSecrets(text, 'diagnostics');
}
function assertFilesClean(dir) {
  const files = [path.join(dir, 'metadata.json'), ...fs.readdirSync(path.join(dir, 'logs')).map((name) => path.join(dir, 'logs', name))];
  for (const file of files) if (fs.existsSync(file) && fs.statSync(file).isFile()) assertNoSecrets(fs.readFileSync(file, 'utf8'), path.basename(file));
}

test('random strategy covers every entry over 60 requests', async (t) => {
  const s = await setup(t);
  const proxies = [await s.socks('A', { auth }), await s.socks('B', { auth }), await s.socks('C', { auth })];
  await s.start({ proxyPool: manualPool(proxies.map((proxy, i) => socksUrl(proxy.port, `user-test-session-${i}`)), { strategy: 'random' }) });
  for (let i = 0; i < 60; i += 10) assert.deepEqual(await Promise.all(Array.from({ length: 10 }, () => s.chat())), Array(10).fill(200));
  assert.equal(s.seen.length, 60);
  const counts = Object.fromEntries(['A', 'B', 'C'].map((name) => [name, s.seen.filter((via) => via === name).length]));
  for (const [name, count] of Object.entries(counts)) assert.ok(count > 0, `${name} was selected (${JSON.stringify(counts)})`);
  const status = await s.get('/api/proxy-pool/status');
  assert.equal(status.strategy, 'random');
  assert.equal(status.entries.reduce((sum, entry) => sum + entry.recent.requests, 0), 60);
  assert.equal(status.fallbacks.total, 0);
});

test('a session sticks to one pool entry, fails over together when that entry throttles, and sessionless calls still rotate', async (t) => {
  const throttled = new Set();
  const s = await setup(t, { responder: throttleResponder(throttled) });
  const proxies = [await s.socks('A', { auth }), await s.socks('B', { auth }), await s.socks('C', { auth })];
  await s.start({ proxyPool: manualPool(proxies.map((proxy, i) => socksUrl(proxy.port, `user-test-session-${i}`))) });
  const chatIn = async (session) => {
    const res = await fetch(`http://127.0.0.1:${s.port}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(session ? { 'Session-Id': session } : {}) },
      body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: `sticky ${Math.random()}` }] }) });
    await res.text();
    return res.status;
  };
  // 同一会话的连续请求固定在同一个条目；不同会话分散；无会话的调用仍按轮询覆盖所有条目。
  for (let i = 0; i < 12; i++) assert.equal(await chatIn('sticky-session-1'), 200);
  assert.equal(new Set(s.seen).size, 1, `one session stays on one entry (${JSON.stringify(s.seen)})`);
  const pinned = s.seen[0];
  s.seen.length = 0;
  for (let i = 0; i < 24; i++) assert.equal(await chatIn(`sticky-other-${i}`), 200);
  assert.ok(new Set(s.seen).size >= 2, `sessions spread over entries (${JSON.stringify(s.seen)})`);
  s.seen.length = 0;
  for (let i = 0; i < 6; i++) assert.equal(await chatIn(null), 200);
  assert.equal(new Set(s.seen).size, 3, 'sessionless calls rotate through every entry');

  // 绑定的条目 HTML 429：本请求立即换到次高条目；之后这个会话稳定留在新条目上（原条目冷却 60 秒）。
  s.seen.length = 0; throttled.add(pinned);
  assert.equal(await chatIn('sticky-session-1'), 200);
  assert.equal(s.seen.length, 2); assert.equal(s.seen[0], pinned); assert.notEqual(s.seen[1], pinned);
  const successor = s.seen[1];
  s.seen.length = 0;
  for (let i = 0; i < 5; i++) assert.equal(await chatIn('sticky-session-1'), 200);
  assert.deepEqual(s.seen, Array(5).fill(successor));
  const view = await s.get();
  assert.equal(view.accounts[0].state?.cooldownUntil || 0, 0, 'account is not cooled');
  assert.equal((await s.get('/api/proxy-pool/status')).fallbacks.total, 0);
});

test('FloppyData: a session keeps its bound entry across a batch swap while other traffic moves to the new batch', async (t) => {
  const s = await setup(t);
  const batches = { 1: [await s.socks('B1a', { auth }), await s.socks('B1b', { auth })], 2: [await s.socks('B2a', { auth }), await s.socks('B2b', { auth })] };
  let mode = 1;
  const api = http.createServer((req, res) => {
    let raw = ''; req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}'), list = batches[mode];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ connection: { connectionString: `socks5://user-test-session-${body.session}:${PASS}@127.0.0.1:${list[Number(body.session.slice(-1)) % 2].port}` } }));
    });
  });
  const apiPort = await listen(api);
  t.after(() => close(api));
  await s.start({ proxyPool: { enabled: true, source: 'floppydata', floppydata: { apiKey: API_KEY, apiBase: `http://127.0.0.1:${apiPort}`, count: 4, rotation: 60 } } });
  await waitFor(async () => { const value = await s.get('/api/proxy-pool/status'); return value.total === 4 && value.floppydata?.state === 'ok' ? value : null; }, 'first batch');
  const chatIn = async (session) => {
    const res = await fetch(`http://127.0.0.1:${s.port}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(session ? { 'Session-Id': session } : {}) },
      body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: `keep ${Math.random()}` }] }) });
    await res.text();
    return res.status;
  };
  for (let i = 0; i < 3; i++) assert.equal(await chatIn('keep-session'), 200);
  assert.equal(new Set(s.seen).size, 1);
  const boundVia = s.seen[0];
  assert.match(boundVia, /^B1/);

  mode = 2;
  const swapped = await s.post('/api/proxy-pool/refresh', { wait: true });
  assert.equal(swapped.status, 200);
  assert.equal(swapped.data.total, 4);
  assert.equal(swapped.data.entries.filter((entry) => entry.state === 'retained').length, 1, 'only the entry bound to a session is kept');
  assert.equal(swapped.data.retiring, 0);
  assert.equal(swapped.data.available, 4);

  // 已绑定的会话仍走旧条目；新会话与无会话的请求只用新批。
  s.seen.length = 0;
  for (let i = 0; i < 5; i++) assert.equal(await chatIn('keep-session'), 200);
  assert.deepEqual(s.seen, Array(5).fill(boundVia), 'the bound session keeps using its old entry after the swap');
  s.seen.length = 0;
  for (let i = 0; i < 8; i++) assert.equal(await chatIn(`fresh-${i}`), 200);
  for (let i = 0; i < 4; i++) assert.equal(await chatIn(null), 200);
  assert.ok(s.seen.every((via) => /^B2/.test(via)), `other traffic uses the new batch: ${s.seen}`);

  // 关闭代理池：绑定与被保留的旧条目一并释放。
  const off = await s.post('/api/accounts', { ...(await s.get('/api/accounts')), proxyPool: { ...(await s.get('/api/accounts')).proxyPool, enabled: false } });
  assert.equal(off.status, 200, JSON.stringify(off.data));
  await waitFor(async () => (await s.get('/api/proxy-pool/status')).entries.length === 0, 'retained entry released with the pool');
  await assertDiagnosticsClean(s, [JSON.stringify(swapped.data)]);
});

test('an authenticated HTTP CONNECT entry works; a 407 from the proxy is a connect-phase failure that moves to another entry', async (t) => {
  const s = await setup(t);
  const c = await s.connectProxy('C', { auth });
  const authed = `http://user-test-session-c:${PASS}@127.0.0.1:${c.port}`;
  await s.start({ proxyPool: manualPool([`http://127.0.0.1:${c.port}`, authed], { failureCooldownMs: 60000 }) });
  const first = await s.chatFull();
  assert.equal(first.status, 200, first.text);
  assert.deepEqual(s.seen, ['C'], 'the 407 never reached the upstream; the authenticated entry did');
  assert.equal(c.rejected.length, 1, 'the unauthenticated entry was rejected with 407 by the proxy');
  const streamed = await s.chatFull({ stream: true });
  assert.equal(streamed.status, 200, streamed.text);
  assert.match(streamed.text, /\[DONE\]/);
  assert.deepEqual(s.seen, ['C', 'C']);
  assert.equal(c.rejected.length, 1, 'the cooled 407 entry is not selected again');

  const [errorRow] = await rowsFor(s, 'errors', 1);
  assert.equal(errorRow.errorScope, 'proxy'); assert.equal(errorRow.scopeEvidence, 'proxy_pool_connect');
  assert.equal(errorRow.accountAction, null); assert.match(errorRow.egress, POOL_ID);
  const rows = (await rowsFor(s, 'requests', 2)).sort((x, y) => x.ts - y.ts);
  assert.equal(rows[0].attempts.length, 2);
  assert.notEqual(rows[0].attempts[0].egress, rows[0].attempts[1].egress);
  const status = await s.get('/api/proxy-pool/status');
  const cooled = status.entries.filter((entry) => entry.state === 'cooldown');
  assert.equal(cooled.length, 1); assert.equal(cooled[0].reason, 'connect'); assert.equal(cooled[0].scheme, 'http');
  assert.equal((await s.get()).accounts[0].state, null, 'the account is untouched');

  // The connectivity test builds the same agent as real pool traffic: a 407 CONNECT is a proxy failure, not "ok, status 407".
  const tested = await s.post('/api/proxy-pool/test', { sample: 2 });
  assert.equal(tested.status, 200);
  const byEntry = Object.fromEntries(tested.data.results.map((item) => [item.entryId, item]));
  const rejectedResult = byEntry[cooled[0].entryId];
  assert.equal(rejectedResult.ok, false); assert.equal(rejectedResult.errorCategory, 'proxy'); assert.equal(rejectedResult.status, undefined);
  const okResult = tested.data.results.find((item) => item.entryId !== cooled[0].entryId);
  assert.equal(okResult.ok, true); assert.equal(okResult.status, 200);
  assert.equal(c.rejected.length, 2, 'the test reached the proxy with the unauthenticated entry once');
  assert.equal((await s.get('/api/proxy-pool/status')).entries.filter((entry) => entry.state === 'cooldown').length, 1, 'the test does not touch cooldown');
  await assertDiagnosticsClean(s, [first.text, streamed.text, JSON.stringify(tested.data)]);
  await s.stop();
  assertFilesClean(s.dir);
});

test('FloppyData batch swap keeps an in-flight SSE stream intact, retires then destroys the old batch, and a partial batch keeps the current one', async (t) => {
  let holdNext = false, held = null;
  const s = await setup(t, { responder: (via, res, ctx) => {
    if (ctx.body.stream && holdNext) {
      holdNext = false;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"first"}}]}\n\n');
      held = res;
      return;
    }
    okResponder(via, res, ctx);
  } });
  const batches = { 1: [await s.socks('B1a', { auth }), await s.socks('B1b', { auth })], 2: [await s.socks('B2a', { auth }), await s.socks('B2b', { auth })] };
  batches.partial = batches[2];
  let mode = 1;
  const sessions = { 1: [], 2: [], partial: [] }, keys = [];
  const api = http.createServer((req, res) => {
    let raw = ''; req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}'), list = sessions[mode], index = list.push(body.session) - 1;
      keys.push(req.headers['x-api-key']);
      if (mode === 'partial' && index > 0) { res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: `boom ${API_KEY}` })); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ connection: { connectionString: `socks5://user-test-session-${body.session}:${PASS}@127.0.0.1:${batches[mode][index % 2].port}` } }));
    });
  });
  const apiPort = await listen(api);
  t.after(() => close(api));
  await s.start({ proxyPool: { enabled: true, source: 'floppydata', floppydata: { apiKey: API_KEY, apiBase: `http://127.0.0.1:${apiPort}`, count: 4 } } });
  const batch1 = await waitFor(async () => { const value = await s.get('/api/proxy-pool/status'); return value.total === 4 && value.floppydata?.state === 'ok' ? value : null; }, 'first batch');
  const batch1Ids = new Set(batch1.entries.map((entry) => entry.entryId));
  assert.deepEqual(batch1.floppydata.lastBatch, { requested: 4, succeeded: 4 });

  // A long SSE stream through a batch-1 entry.
  holdNext = true;
  const response = await fetch(`http://127.0.0.1:${s.port}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'm', stream: true, messages: [{ role: 'user', content: 'long stream' }] }) });
  assert.equal(response.status, 200);
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let streamText = '';
  while (!streamText.includes('first')) { const { value, done } = await reader.read(); if (done) break; streamText += decoder.decode(value, { stream: true }); }
  assert.ok(held, 'upstream holds the stream open');
  const streamVia = s.seen.at(-1);
  assert.match(streamVia, /^B1/);

  // Swap to batch 2 while the stream is still open.
  mode = 2;
  const refreshed = await s.post('/api/proxy-pool/refresh', { wait: true });
  assert.equal(refreshed.status, 200);
  assert.equal(refreshed.data.total, 4);
  assert.equal(refreshed.data.retiring, 1, 'only the entry carrying the stream is kept while retiring');
  assert.deepEqual(refreshed.data.entries.filter((entry) => entry.state === 'retiring').map((entry) => batch1Ids.has(entry.entryId)), [true]);
  const batch2Ids = new Set(refreshed.data.entries.filter((entry) => entry.state !== 'retiring').map((entry) => entry.entryId));
  assert.equal(batch2Ids.size, 4);
  for (const id of batch2Ids) assert.equal(batch1Ids.has(id), false, 'a new batch has new entries');
  assert.equal(batches[1].find((proxy, i) => `B1${'ab'[i]}` !== streamVia).connections(), 0, 'the idle batch-1 entry was destroyed at once');

  s.seen.length = 0;
  for (let i = 0; i < 4; i++) assert.equal(await s.chat(), 200);
  assert.ok(s.seen.every((via) => /^B2/.test(via)), `new requests use batch 2: ${s.seen}`);

  // Finish the old stream: it is delivered intact, then the retired entry is destroyed.
  held.write('data: {"choices":[{"delta":{"content":"last"}}]}\n\ndata: [DONE]\n\n');
  held.end();
  for (;;) { const { value, done } = await reader.read(); if (done) break; streamText += decoder.decode(value, { stream: true }); }
  assert.match(streamText, /first[\s\S]*last[\s\S]*\[DONE\]/);
  await waitFor(async () => (await s.get('/api/proxy-pool/status')).retiring === 0, 'retired entry released');
  await waitFor(() => batches[1].every((proxy) => proxy.connections() === 0), 'batch-1 connections destroyed');
  const streamRow = (await rowsFor(s, 'requests', 5)).find((row) => row.stream === true);
  assert.equal(streamRow.status, 200);
  assert.ok(batch1Ids.has(streamRow.egress.slice(5)), 'the stream is attributed to its batch-1 entry');

  // A batch with fewer than half successes keeps the current batch and reports the enum.
  mode = 'partial';
  const partial = await s.post('/api/proxy-pool/refresh', { wait: true });
  assert.equal(partial.status, 200);
  assert.equal(partial.data.floppydata.state, 'error');
  assert.equal(partial.data.floppydata.lastError, 'upstream_error');
  assert.deepEqual(partial.data.floppydata.lastBatch, { requested: 4, succeeded: 1 });
  assert.deepEqual(new Set(partial.data.entries.map((entry) => entry.entryId)), batch2Ids, 'the current batch is kept');
  s.seen.length = 0;
  assert.equal(await s.chat(), 200);
  assert.match(s.seen[0], /^B2/);

  for (const list of [sessions[1], sessions[2], sessions.partial]) assert.equal(new Set(list).size, list.length, 'sessions are unique within a batch');
  assert.equal(new Set([...sessions[1], ...sessions[2], ...sessions.partial]).size, 12, 'sessions differ across batches');
  assert.ok(keys.every((key) => key === API_KEY));
  assert.equal(s.bytes().includes('user-test-session-'), false, 'imported entries are never persisted');
  await assertDiagnosticsClean(s, [JSON.stringify(refreshed.data), JSON.stringify(partial.data), streamText]);
  await s.stop();
  assertFilesClean(s.dir);
});

test('the pre-pool image starts on a config with proxyPool and metadata written after pool traffic, and keeps proxyPool across its own save', async (t) => {
  const repo = path.resolve('.');
  // The "old image" is the parent of the commit that introduced lib/proxy-pool.js (HEAD itself once uncommitted).
  let oldRev;
  try {
    const added = execFileSync('git', ['log', '--diff-filter=A', '--format=%H', '-1', '--', 'lib/proxy-pool.js'], { cwd: repo, encoding: 'utf8' }).trim();
    oldRev = added ? `${added}^` : 'HEAD';
    execFileSync('git', ['rev-parse', '--verify', `${oldRev}^{commit}`], { cwd: repo, stdio: 'ignore' });
  } catch { t.skip('not inside a git checkout with the pre-pool commit'); return; }
  const s = await setup(t);
  const a = await s.socks('A', { auth });
  const pool = manualPool([socksUrl(a.port, 'user-test-session-a')], { floppydata: { apiKey: API_KEY } });
  await s.start({ proxyPool: pool });
  assert.equal(await s.chat(), 200);
  assert.equal(await s.chat(), 200);
  assert.deepEqual(s.seen, ['A', 'A']);
  await rowsFor(s, 'requests', 2);
  await s.stop();
  const metadataText = fs.readFileSync(path.join(s.dir, 'metadata.json'), 'utf8');
  assert.ok(metadataText.includes(`"socks5://127.0.0.1:${a.port}"`), 'proxyHealth uses the credential-free endpoint key of the pool entry');
  assertNoSecrets(metadataText, 'metadata.json');
  const savedPool = s.read().proxyPool;

  const oldDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cps-head-image-'));
  t.after(() => fs.rmSync(oldDir, { recursive: true, force: true }));
  execSync(`git archive ${oldRev} server.js package.json lib public | tar -x -C "${oldDir}"`, { cwd: repo, stdio: ['ignore', 'ignore', 'pipe'] });
  fs.symlinkSync(path.join(repo, 'node_modules'), path.join(oldDir, 'node_modules'), 'dir');
  s.child = await startServer(s.dir, {}, { cwd: oldDir });
  const view = await s.get();
  assert.equal(view.accounts.length, 1);
  assert.equal(Object.hasOwn(view, 'proxyPool'), false, 'the old image ignores proxyPool');
  assert.equal(await s.chat(), 200);
  assert.equal(s.seen.at(-1), 'direct', 'the old image uses the account egress');
  const saved = await s.post('/api/accounts', { accounts: view.accounts, mode: view.mode, active: view.active, poolFullWaitMs: view.poolFullWaitMs,
    errorRules: view.errorRules, retryRules: view.retryRules, quotaProtection: view.quotaProtection, accountPipeline: view.accountPipeline, accountWorkflow: view.accountWorkflow,
    sessionProviderAffinityEnabled: view.sessionProviderAffinityEnabled, expectedConfigurationRevision: view.configurationRevision, concurrencyWaitMs: 1234 });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  const after = s.read();
  assert.equal(after.concurrencyWaitMs, 1234, 'the old image really wrote config.json');
  assert.deepEqual(after.proxyPool, savedPool, 'the old image preserves the unknown proxyPool field');
  await s.stop();

  // Rolling forward again: the new image reads what the old one wrote and the pool is active.
  await s.start();
  const status = await s.get('/api/proxy-pool/status');
  assert.equal(status.enabled, true); assert.equal(status.total, 1);
  s.seen.length = 0;
  assert.equal(await s.chat(), 200);
  assert.deepEqual(s.seen, ['A']);
});

// ---------- 按客户端密钥开关（proxyPoolClientKeys） ----------
const LEGACY_KEY = 'legacy-test-client-key', KEY_A = 'client-key-a-0000000000', KEY_B = 'client-key-b-0000000000';
const CLIENT_KEYS = [{ id: 'ck_a', name: 'A', key: KEY_A }, { id: 'ck_b', name: 'B', key: KEY_B }];
const ownedAccounts = (ownPort = null) => [
  { id: 'a0', clientKeyId: 'ck_a', name: 'a0', key: 'local-a0', enabled: true, maxConcurrent: 0, priority: 10 },
  { id: 'b0', clientKeyId: 'ck_b', name: 'b0', key: 'local-b0', enabled: true, maxConcurrent: 0, priority: 10, ...(ownPort ? { proxyUrl: `socks5://127.0.0.1:${ownPort}` } : {}) },
];
async function chatAs(s, key, { stream = false } = {}) {
  const res = await fetch(`http://127.0.0.1:${s.port}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: 'm', stream, messages: [{ role: 'user', content: `scoped ${Math.random()}` }] }) });
  return { status: res.status, text: await res.text() };
}
const noClientKeyValues = (text, label) => { for (const secret of [LEGACY_KEY, KEY_A, KEY_B]) assert.equal(String(text).includes(secret), false, `${label} must not contain a client key value`); };

test('per-client-key scope: only keys set to on use the pool; others keep their account egress, account HTML-429 backoff and no fallback', async (t) => {
  const throttled = new Set();
  const s = await setup(t, { responder: throttleResponder(throttled), env: { CLINE_PASS_TEST_QUOTA_SUCCESS_MS: '100', CLINE_PASS_TEST_QUOTA_FAILURE_MS: '200' } });
  const [pa, pb, own] = [await s.socks('PA', { auth }), await s.socks('PB', { auth }), await s.socks('own')];
  await s.start({ proxyKey: LEGACY_KEY, clientKeys: CLIENT_KEYS, accounts: ownedAccounts(own.port),
    proxyPool: manualPool([socksUrl(pa.port, 'user-test-session-a'), socksUrl(pb.port, 'user-test-session-b')]),
    proxyPoolClientKeys: { default: 'off', overrides: { ck_a: 'on' } } });

  // AC2: A goes through pool entries, B through its own account proxy, never counted by the pool.
  assert.equal((await chatAs(s, KEY_A)).status, 200);
  assert.equal((await chatAs(s, KEY_B)).status, 200);
  const streamed = await chatAs(s, KEY_A, { stream: true });
  assert.equal(streamed.status, 200); assert.match(streamed.text, /\[DONE\]/);
  assert.deepEqual(s.chats, [{ via: 'PA', auth: 'Bearer local-a0' }, { via: 'own', auth: 'Bearer local-b0' }, { via: 'PB', auth: 'Bearer local-a0' }]);
  const rows = await rowsFor(s, 'requests', 3);
  const bRow = rows.find((row) => row.accountId === 'b0');
  assert.equal(bRow.egress, 'account-proxy'); assert.equal(bRow.poolFallback, false);
  assert.ok(rows.filter((row) => row.accountId === 'a0').every((row) => POOL_ID.test(row.egress) && row.poolFallback === false));
  let status = await s.get('/api/proxy-pool/status');
  assert.equal(status.entries.reduce((sum, entry) => sum + entry.recent.requests, 0), 2, 'only A requests are counted by the pool');
  assert.equal(status.fallbacks.total, 0, 'B never records a pool fallback');
  // AC7
  assert.deepEqual(status.clientKeys, [
    { id: 'legacy', name: 'Legacy', mode: 'default', effective: false },
    { id: 'ck_a', name: 'A', mode: 'on', effective: true },
    { id: 'ck_b', name: 'B', mode: 'default', effective: false },
  ]);
  noClientKeyValues(JSON.stringify(status), 'status');

  // AC4: B's HTML 429 keeps the account backoff and one same-egress retry; A's moves to another entry at once.
  throttled.add('own'); s.chats.length = 0;
  let started = Date.now();
  assert.equal((await chatAs(s, KEY_B)).status, 429);
  assert.ok(Date.now() - started >= 900, 'B waits for the account gateway backoff');
  assert.deepEqual(s.chats.map((call) => call.via), ['own', 'own'], 'B retries once on the same account egress');
  throttled.clear(); throttled.add('PA'); s.chats.length = 0;
  started = Date.now();
  assert.equal((await chatAs(s, KEY_A)).status, 200);
  assert.ok(Date.now() - started < 500, 'A does not wait for an account backoff');
  assert.deepEqual(s.chats.map((call) => call.via), ['PA', 'PB']);
  throttled.clear();
  status = await s.get('/api/proxy-pool/status');
  assert.equal(status.fallbacks.total, 0);
  const bErrors = (await rowsFor(s, 'errors', 1)).filter((row) => row.accountId === 'b0');
  assert.ok(bErrors.length && bErrors.every((row) => row.egress === 'account-proxy' && row.poolFallback !== true));

  // AC5: quota refresh and probes follow the owner's setting too.
  s.seenGet.length = 0;
  assert.equal((await s.post('/api/statistics/quota-refresh', { force: true })).status, 200);
  const quota = await waitFor(() => { const calls = s.seenGet.filter((call) => call.path === '/users/me/plan/usage-limits'); return calls.length >= 2 ? calls : null; }, 'quota refreshes');
  for (const call of quota) assert.match(call.via, call.auth === 'Bearer local-a0' ? /^P[AB]$/ : /^own$/, `${call.auth} quota egress`);
  assert.ok(quota.some((call) => call.auth === 'Bearer local-a0') && quota.some((call) => call.auth === 'Bearer local-b0'));
  for (const [accountId, expected] of [['a0', /^P[AB]$/], ['b0', /^own$/]]) {
    s.chats.length = 0;
    await s.post('/api/probe', { model: 'm', accountId });
    assert.ok(s.chats.length > 0, `${accountId} probe reached upstream`);
    for (const call of s.chats) { assert.equal(call.auth, `Bearer local-${accountId}`); assert.match(call.via, expected, `${accountId} probe egress`); }
  }
  await assertDiagnosticsClean(s);
  noClientKeyValues(s.child.output(), 'server output');
});

test('per-client-key scope: FloppyData imports only while some key uses the pool, retires entries when none does and re-imports at once', async (t) => {
  const s = await setup(t);
  const a = await s.socks('F', { auth });
  const calls = [];
  const api = http.createServer((req, res) => {
    let raw = ''; req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      calls.push(body.session);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ connection: { connectionString: `socks5://user-test-session-${body.session}:${PASS}@127.0.0.1:${a.port}` } }));
    });
  });
  const apiPort = await listen(api);
  t.after(() => close(api));
  await s.start({ proxyKey: LEGACY_KEY, clientKeys: CLIENT_KEYS, accounts: ownedAccounts(),
    proxyPool: { enabled: true, source: 'floppydata', floppydata: { apiKey: API_KEY, apiBase: `http://127.0.0.1:${apiPort}`, count: 2 } },
    proxyPoolClientKeys: { default: 'on', overrides: { ck_b: 'off' } } });
  await waitFor(async () => (await s.get('/api/proxy-pool/status')).total === 2, 'first batch');
  assert.equal(calls.length, 2);
  assert.equal((await chatAs(s, KEY_A)).status, 200);
  assert.equal((await chatAs(s, KEY_B)).status, 200);
  assert.deepEqual(s.chats.map((call) => call.via), ['F', 'direct'], 'A uses the imported entry, B stays direct');

  // Every key off: import stops and the batch retires.
  const off = await s.save({ proxyPoolClientKeys: { default: 'off', overrides: {} } });
  assert.equal(off.status, 200, JSON.stringify(off.data));
  let status = await s.get('/api/proxy-pool/status');
  assert.equal(status.total, 0, 'entries retire');
  assert.equal(status.floppydata.state, 'idle');
  assert.ok(status.clientKeys.every((key) => key.effective === false));
  assert.equal((await s.post('/api/proxy-pool/refresh', { wait: true })).status, 409, 'manual refresh is refused while no key uses the pool');
  s.chats.length = 0;
  assert.equal((await chatAs(s, KEY_A)).status, 200);
  assert.deepEqual(s.chats.map((call) => call.via), ['direct']);
  const [row] = (await rowsFor(s, 'requests', 3)).sort((x, y) => y.ts - x.ts);
  assert.equal(row.egress, 'direct'); assert.equal(row.poolFallback, false, 'a key that does not use the pool never records a fallback');
  await sleep(200);
  assert.equal(calls.length, 2, 'no further API calls');

  // A back on: re-import immediately.
  const on = await s.save({ proxyPoolClientKeys: { default: 'off', overrides: { ck_a: 'on' } } });
  assert.equal(on.status, 200);
  await waitFor(async () => (await s.get('/api/proxy-pool/status')).total === 2, 're-import');
  assert.equal(calls.length, 4);
  s.chats.length = 0;
  assert.equal((await chatAs(s, KEY_A)).status, 200);
  assert.equal((await chatAs(s, KEY_B)).status, 200);
  assert.deepEqual(s.chats.map((call) => call.via), ['F', 'direct']);
  assert.doesNotMatch(s.child.output(), new RegExp(`${API_KEY}|${PASS}|user-test-session-`));
});

test('the currently deployed image (68c6158) starts with proxyPoolClientKeys, ignores it and preserves it across its own save', async (t) => {
  const repo = path.resolve('.'), oldRev = '68c6158';
  try { execFileSync('git', ['rev-parse', '--verify', `${oldRev}^{commit}`], { cwd: repo, stdio: 'ignore' }); }
  catch { t.skip('not inside a git checkout containing 68c6158'); return; }
  const s = await setup(t);
  const [pa, own] = [await s.socks('PA', { auth }), await s.socks('own')];
  const scope = { default: 'off', overrides: { ck_a: 'on' } };
  await s.start({ proxyKey: LEGACY_KEY, clientKeys: CLIENT_KEYS, accounts: ownedAccounts(own.port), proxyPool: manualPool([socksUrl(pa.port, 'user-test-session-a')]), proxyPoolClientKeys: scope });
  assert.equal((await chatAs(s, KEY_B)).status, 200);
  assert.deepEqual(s.chats.map((call) => call.via), ['own']);
  await s.stop();

  const oldDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cps-68c6158-image-'));
  t.after(() => fs.rmSync(oldDir, { recursive: true, force: true }));
  execSync(`git archive ${oldRev} server.js package.json lib public | tar -x -C "${oldDir}"`, { cwd: repo, stdio: ['ignore', 'ignore', 'pipe'] });
  fs.symlinkSync(path.join(repo, 'node_modules'), path.join(oldDir, 'node_modules'), 'dir');
  s.child = await startServer(s.dir, {}, { cwd: oldDir });
  const view = await s.get();
  assert.equal(Object.hasOwn(view, 'proxyPoolClientKeys'), false, 'the old image does not know the field');
  s.chats.length = 0;
  assert.equal((await chatAs(s, KEY_B)).status, 200);
  assert.deepEqual(s.chats.map((call) => call.via), ['PA'], 'the old image falls back to the global switch');
  const saved = await s.post('/api/accounts', { accounts: view.accounts, mode: view.mode, active: view.active, poolFullWaitMs: view.poolFullWaitMs,
    errorRules: view.errorRules, retryRules: view.retryRules, quotaProtection: view.quotaProtection, accountPipeline: view.accountPipeline, accountWorkflow: view.accountWorkflow,
    proxyPool: view.proxyPool, sessionProviderAffinityEnabled: view.sessionProviderAffinityEnabled, expectedConfigurationRevision: view.configurationRevision, concurrencyWaitMs: 1234 });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal(s.read().concurrencyWaitMs, 1234, 'the old image really wrote config.json');
  assert.deepEqual(s.read().proxyPoolClientKeys, scope, 'the old image preserves the unknown top-level field');
  await s.stop();

  await s.start();
  assert.deepEqual((await s.get()).proxyPoolClientKeys, scope, 'rolling forward restores the per-key semantics');
  s.chats.length = 0;
  assert.equal((await chatAs(s, KEY_B)).status, 200);
  assert.deepEqual(s.chats.map((call) => call.via), ['own']);
});
