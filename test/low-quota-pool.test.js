import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { prepareAdminFixture, connectAdminFixture, installFixtureFetch } from './admin-fixture.js';
installFixtureFetch();

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = (server) => new Promise((resolve) => server.close(resolve));
const port = async () => { const server = http.createServer(); const value = await listen(server); await close(server); return value; };
async function waitFor(check, label, ms = 5000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await new Promise((resolve) => setTimeout(resolve, 10)); }
  throw new Error(`timed out: ${label}`);
}
async function start(dir, extra = {}) {
  prepareAdminFixture(dir);
  const child = spawn(process.execPath, ['server.js'], { cwd: path.resolve('.'), env: { ...process.env, DATA_DIR: dir, BIND_HOST: '127.0.0.1', NODE_ENV: 'test', ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (data) => { output += data; }); child.stderr.on('data', (data) => { output += data; });
  await waitFor(() => { if (child.exitCode !== null) throw new Error(`startup failed: ${output}`); return output.includes('OpenAI 兼容代理地址'); }, 'server startup');
  const config = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  await connectAdminFixture(Number(extra.PORT || config.port));
  return child;
}
async function stop(child) { if (!child || child.exitCode !== null) return; child.kill('SIGTERM'); await Promise.race([new Promise((resolve) => child.once('exit', resolve)), new Promise((resolve) => setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 1000))]); }
const get = async (p, route = '/api/accounts') => (await fetch(`http://127.0.0.1:${p}${route}`)).json();
const post = async (p, route, body) => { const res = await fetch(`http://127.0.0.1:${p}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: res.status, data: await res.json() }; };
const chat = (p, stream = false) => post(p, '/v1/chat/completions', { model: 'm', messages: [], stream });
const account = (id, extra = {}) => ({ id, name: id, key: `local-${id}`, enabled: true, maxConcurrent: 1, priority: 10, ...extra });
const pipeline = (size, max, low) => ({ quotaPool: false, healthSort: false, sticky: false, order: ['quotaPool','healthSort','sticky'], cachePoolSize: size, cachePoolMaxSize: max, cachePoolLowQuotaSize: low });
const quota = (used, now = Date.now()) => ({ snapshot: { limits: Object.fromEntries(['five_hour','weekly','monthly'].map((type) => [type, { percentUsed: used }])), fetchedAt: now }, lastAttemptAt: now, lastSuccessAt: now, errorCategory: null });
async function setup(t, accounts, pipe, responder, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cps-low-quota-'));
  const upstream = http.createServer((req, res) => { req.resume(); req.on('end', () => responder(req, res)); });
  const upstreamPort = await listen(upstream), serverPort = await port();
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ port: serverPort, upstreamBase: `http://127.0.0.1:${upstreamPort}`, accounts, accountMode: 'sticky', activeAccount: 0, concurrencyWaitMs: 0, knownModels: ['m'], perModel: {}, errorRules: [], accountPipeline: pipe }));
  const state = { child: await start(dir, extra), dir, serverPort };
  t.after(async () => { await stop(state.child); await close(upstream); fs.rmSync(dir, { recursive: true, force: true }); });
  return state;
}
async function seedQuotas(state, values, env = {}) {
  await stop(state.child); state.child = null;
  const filename = path.join(state.dir, 'metadata.json'), meta = JSON.parse(fs.readFileSync(filename, 'utf8'));
  const now = Date.now(); meta.accountQuotas = Object.fromEntries(Object.entries(values).map(([id, used]) => [id, quota(used, now)]));
  fs.writeFileSync(filename, JSON.stringify(meta)); state.child = await start(state.dir, env);
}
function answer(res, status = 200, body = { choices: [{ message: { content: 'OK' } }] }) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); }
function limits(rows) { return { success: true, data: { limits: Object.entries(rows).map(([type, value]) => ({ type, percentUsed: typeof value === 'number' ? value : value.used, ...(value?.reset ? { resetsAt: value.reset } : {}) })) } }; }

test('low slot configuration, legacy omission and invalid bounds preserve bytes', async (t) => {
  const state = await setup(t, [account('a')], pipeline(0, 0, 0), (_req, res) => answer(res));
  let view = await get(state.serverPort);
  assert.equal(view.accountPipeline.cachePoolLowQuotaSize, 0);
  assert.equal(view.cachePool.targetSize, 0);
  const save = (pipe) => post(state.serverPort, '/api/accounts', { accounts: view.accounts, mode: 'sticky', active: 0, concurrencyWaitMs: 0, errorRules: view.errorRules, accountPipeline: pipe });
  assert.equal((await save({ ...view.accountPipeline, cachePoolSize: 2, cachePoolMaxSize: 3, cachePoolLowQuotaSize: 1 })).status, 200);
  view = await get(state.serverPort);
  assert.equal(view.cachePool.lowSize, 1);
  const { cachePoolLowQuotaSize: _omitted, ...old } = view.accountPipeline;
  assert.equal((await save(old)).status, 200);
  view = await get(state.serverPort); assert.equal(view.accountPipeline.cachePoolLowQuotaSize, 1);
  const before = fs.readFileSync(path.join(state.dir, 'config.json'));
  for (const low of [-1, 1.5, '1', null, 3]) {
    assert.equal((await save({ ...view.accountPipeline, cachePoolLowQuotaSize: low })).status, 400);
    assert.deepEqual(fs.readFileSync(path.join(state.dir, 'config.json')), before);
  }
  assert.equal((await save({ ...view.accountPipeline, cachePoolLowQuotaSize: 0, cachePoolSize: 0, cachePoolMaxSize: 0 })).status, 200);
  view = await get(state.serverPort); assert.equal(view.cachePool.targetSize, 0);
  await stop(state.child); state.child = await start(state.dir);
  assert.equal((await get(state.serverPort)).accountPipeline.cachePoolLowQuotaSize, 0);
  await stop(state.child); state.child = null;
  const file = path.join(state.dir, 'metadata.json'), meta = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const invalid of [
    { quotaDisposition: 'unrecognized-state' },
    { quotaDisposition: null, quotaDispositionAt: 5, quotaRetryAt: 0, quotaReason: null },
    { quotaDisposition: 'waiting-refresh', quotaDispositionAt: Date.now(), quotaRetryAt: 5, quotaReason: 'account-degrade' },
    { quotaDisposition: 'quota-exhausted', quotaDispositionAt: Date.now(), quotaRetryAt: 0, quotaReason: 'account-degrade' },
    { quotaDisposition: 'quota-exhausted', quotaDispositionAt: Date.now(), quotaRetryAt: 0, quotaReason: 'known-exhausted', quotaFutureOwner: 'bad' },
  ]) {
    meta.accountStates.a = invalid;
    const invalidBytes = JSON.stringify(meta); fs.writeFileSync(file, invalidBytes);
    await assert.rejects(start(state.dir), /startup failed/, 'invalid canonical quota state fails startup');
    assert.equal(fs.readFileSync(file, 'utf8'), invalidBytes, 'startup never overwrites corrupt operator metadata');
  }
});

test('fresh quota thresholds choose lowest remaining low, highest remaining high, then high on low RPM block', async (t) => {
  const seen = [];
  const accounts = [account('low80'), account('low95edge', { maxRpm: 1 }), account('high0'), account('high79'), account('unknown'), account('reserve')];
  const state = await setup(t, accounts, pipeline(3, 4, 1), (req, res) => {
    if (req.method === 'GET') return answer(res, 500, {});
    seen.push(req.headers.authorization); answer(res);
  }, { CLINE_PASS_TEST_RPM_WINDOW_MS: '60000' });
  await seedQuotas(state, { low80: 80, low95edge: 94.999, high0: 0, high79: 79.999, reserve: 95 }, { CLINE_PASS_TEST_RPM_WINDOW_MS: '60000' });
  const view = await get(state.serverPort);
  assert.deepEqual(view.cachePool.actual, { high: 2, low: 1, unknown: 0 });
  assert.deepEqual(Object.fromEntries(view.accounts.map((a) => [a.id, a.cachePoolQuotaRole])), { low80: null, low95edge: 'low', high0: 'high', high79: 'high', unknown: null, reserve: null });
  assert.equal(view.accounts.find((a) => a.id === 'high0').quota.pool, 'hot', 'known zero is high, not unknown');
  assert.equal(view.accounts.find((a) => a.id === 'reserve').quota.pool, 'reserve');
  assert.equal((await chat(state.serverPort)).status, 200); assert.equal(seen.at(-1), 'Bearer local-low95edge');
  assert.equal((await chat(state.serverPort)).status, 200);
  assert.ok(['Bearer local-high0','Bearer local-high79'].includes(seen.at(-1)), 'RPM-blocked low falls back immediately to active high');
  assert.equal((await get(state.serverPort)).cachePool.targetSize, 3, 'RPM does not grow');
});

test('low account degradation holds and replaces before output; failed refresh retains hold, successful refresh restores', async (t) => {
  let quotaCalls = 0, quotaMode = 'failure';
  const state = await setup(t, [account('low'), account('high')], pipeline(2, 2, 1), (req, res) => {
    if (req.method === 'GET') { quotaCalls++; return quotaMode === 'failure' ? answer(res, 500, {}) : quotaMode === 'partial' ? answer(res, 200, limits({ weekly: 80 })) : answer(res, 200, limits({ five_hour: 80, weekly: 0, monthly: 0 })); }
    answer(res, req.headers.authorization === 'Bearer local-low' ? 401 : 200, req.headers.authorization === 'Bearer local-low' ? { error: { message: 'account auth failure' } } : undefined);
  }, { CLINE_PASS_TEST_QUOTA_FAILURE_MS: '250', CLINE_PASS_TEST_QUOTA_SUCCESS_MS: '1000' });
  await seedQuotas(state, { low: 82, high: 0 }, { CLINE_PASS_TEST_QUOTA_FAILURE_MS: '250', CLINE_PASS_TEST_QUOTA_SUCCESS_MS: '1000' });
  const result = await chat(state.serverPort);
  assert.equal(result.status, 200, 'account is replaced by high before the response starts');
  await waitFor(async () => (await get(state.serverPort)).accounts.find((a) => a.id === 'low').state?.quotaDisposition === 'waiting-refresh', 'waiting-refresh publication');
  await waitFor(() => quotaCalls > 0, 'real quota fetch despite recent successful cache');
  let heldView = await get(state.serverPort);
  assert.equal(heldView.accounts.find((a) => a.id === 'low').state.quotaDisposition, 'waiting-refresh');
  assert.equal((await post(state.serverPort, '/api/accounts', { accounts: heldView.accounts, mode: 'sticky', active: 0, concurrencyWaitMs: 0, errorRules: heldView.errorRules, accountPipeline: heldView.accountPipeline })).status, 200);
  heldView = await get(state.serverPort);
  assert.equal(heldView.accounts.find((a) => a.id === 'low').state.quotaDisposition, 'waiting-refresh', 'saving cached pre-hold quota cannot clear a hold');
  assert.equal((await post(state.serverPort, '/api/accounts/recover', { id: 'low' })).status, 200);
  assert.equal((await get(state.serverPort)).accounts.find((a) => a.id === 'low').state.quotaDisposition, 'waiting-refresh', 'manual recovery cannot clear quota hold');
  quotaMode = 'partial';
  await waitFor(async () => { const low = (await get(state.serverPort)).accounts.find((a) => a.id === 'low'); return low.quota.limits?.five_hour === undefined && low.quota.limits?.weekly?.percentUsed === 80 ? low : null; }, 'partial quota refresh', 5000);
  assert.equal((await get(state.serverPort)).accounts.find((a) => a.id === 'low').state.quotaDisposition, 'waiting-refresh', 'a partial success is still unknown');
  quotaMode = 'full';
  assert.equal((await post(state.serverPort, '/api/statistics/quota-refresh', { force: true })).status, 200);
  await waitFor(async () => (await get(state.serverPort)).accounts.find((a) => a.id === 'low').state?.quotaDisposition === null, 'quota recovery', 5000);
  const rows = (await get(state.serverPort, '/api/logs/requests?limit=10')).items;
  assert.ok(rows.some((row) => row.switched && row.selectedQuotaRole === 'high'));
  assert.equal(JSON.stringify(rows).includes('percentUsed'), false);
});

test('partial known 100 persists across restart and manual recover; earliest then later reset drive recovery', async (t) => {
  let phase = 0, calls = 0;
  const first = new Date(Date.now() + 4000).toISOString(), second = new Date(Date.now() + 7000).toISOString();
  const state = await setup(t, [account('low'), account('high')], pipeline(2, 2, 1), (req, res) => {
    if (req.method !== 'GET') return answer(res);
    if (req.headers.authorization !== 'Bearer local-low') return answer(res, 200, limits({ five_hour: 0, weekly: 0, monthly: 0 }));
    calls++;
    if (phase === 0) return answer(res, 200, limits({ five_hour: { used: 100, reset: first }, weekly: { used: 100, reset: second } }));
    if (phase === 1) return answer(res, 200, limits({ five_hour: 0, weekly: { used: 100, reset: second }, monthly: 0 }));
    return answer(res, 200, limits({ five_hour: 0, weekly: 0, monthly: 0 }));
  }, { CLINE_PASS_TEST_QUOTA_SUCCESS_MS: '10000' });
  await seedQuotas(state, { low: 80, high: 0 }, { CLINE_PASS_TEST_QUOTA_SUCCESS_MS: '10000' });
  assert.equal((await post(state.serverPort, '/api/statistics/quota-refresh', { force: true })).status, 200);
  let view = await get(state.serverPort), hold = view.accounts.find((a) => a.id === 'low').state;
  assert.equal(hold.quotaDisposition, 'quota-exhausted');
  assert.equal(view.accounts.find((a) => a.id === 'low').quota.pool, 'unknown', 'partial snapshot is never routing-fresh');
  const next = hold.quotaRetryAt; assert.ok(next > Date.now());
  assert.equal((await post(state.serverPort, '/api/accounts/recover', { id: 'low' })).status, 200);
  assert.equal((await get(state.serverPort)).accounts.find((a) => a.id === 'low').state.quotaDisposition, 'quota-exhausted');
  await stop(state.child); state.child = await start(state.dir, { CLINE_PASS_TEST_QUOTA_SUCCESS_MS: '10000' });
  assert.equal((await get(state.serverPort)).accounts.find((a) => a.id === 'low').state.quotaDisposition, 'quota-exhausted');
  const firstCount = calls;
  phase = 1;
  await waitFor(async () => { const low = (await get(state.serverPort)).accounts.find((a) => a.id === 'low'); return calls > firstCount && low.quota.limits.five_hour.percentUsed === 0 ? low : null; }, 'first reset triggers real fetch', 10000);
  view = await get(state.serverPort); assert.equal(view.accounts.find((a) => a.id === 'low').state.quotaDisposition, 'quota-exhausted');
  assert.ok(view.accounts.find((a) => a.id === 'low').state.quotaRetryAt > next, 'second exhausted window schedules a later reset');
  phase = 2;
  await waitFor(async () => (await get(state.serverPort)).accounts.find((a) => a.id === 'low').state?.quotaDisposition === null, 'second reset releases exhaustion', 10000);
  assert.equal((await get(state.serverPort)).accounts.find((a) => a.id === 'low').cachePoolQuotaRole, 'high');
});

test('known low filler beats unknown; concurrent low lease falls back to high without growth', async (t) => {
  let releaseLow;
  const entered = [];
  const state = await setup(t, [account('low1', { maxRpm: 1 }), account('low2'), account('high'), account('unknown')], pipeline(3, 4, 1), (req, res) => {
    if (req.method === 'GET') return answer(res, 500, {});
    entered.push(req.headers.authorization);
    if (req.headers.authorization === 'Bearer local-low2' && !releaseLow) releaseLow = () => answer(res);
    else answer(res);
  });
  await seedQuotas(state, { low1: 80, low2: 94, high: 0 });
  let view = await get(state.serverPort);
  assert.deepEqual(view.cachePool.actual, { high: 1, low: 2, unknown: 0 }, 'extra known low fills missing high capacity before unknown');
  assert.equal(view.accounts.find((a) => a.id === 'unknown').cachePoolRole, 'standby');
  // The lowest remaining low is selected first. While its lease is held, another low
  // remains admissible; when both low leases are held, a third request uses high.
  const first = chat(state.serverPort);
  await waitFor(() => !!releaseLow, 'first low lease');
  assert.equal(entered[0], 'Bearer local-low2');
  const second = await chat(state.serverPort);
  assert.equal(second.status, 200); assert.equal(entered.at(-1), 'Bearer local-low1');
  // RPM exhausts low1 only; low2 is still concurrency-full.
  const third = await chat(state.serverPort);
  assert.equal(third.status, 200); assert.equal(entered.at(-1), 'Bearer local-high');
  view = await get(state.serverPort); assert.equal(view.cachePool.targetSize, 3, 'role capacity fallback does not grow a healthy active set');
  releaseLow(); assert.equal((await first).status, 200);
});

test('provider-scope and explicit ignore never create low quota hold; no reset retries on success cadence', async (t) => {
  let upstreamStatus = 500, quotaCalls = 0, quotaResult = false;
  const state = await setup(t, [account('low'), account('high')], pipeline(2, 2, 1), (req, res) => {
    if (req.method === 'GET') { quotaCalls++; return quotaResult ? answer(res, 200, limits({ weekly: 100 })) : answer(res, 500, {}); }
    answer(res, req.headers.authorization === 'Bearer local-low' ? upstreamStatus : 200, { error: { message: 'provider failure' } });
  }, { CLINE_PASS_TEST_QUOTA_SUCCESS_MS: '700' });
  await seedQuotas(state, { low: 80, high: 0 }, { CLINE_PASS_TEST_QUOTA_SUCCESS_MS: '700' });
  assert.equal((await chat(state.serverPort)).status, 500);
  let view = await get(state.serverPort);
  assert.equal(view.accounts.find((a) => a.id === 'low').state?.quotaDisposition ?? null, null, 'provider default degrade is not an account hold');
  const rule = { id: 'ignore-auth', scope: 'account', action: 'ignore', when: { statuses: [401] } };
  assert.equal((await post(state.serverPort, '/api/accounts', { accounts: view.accounts, mode: 'sticky', active: 0, concurrencyWaitMs: 0, errorRules: [rule], accountPipeline: view.accountPipeline })).status, 200);
  upstreamStatus = 401;
  assert.equal((await chat(state.serverPort)).status, 401);
  view = await get(state.serverPort);
  assert.equal(view.accounts.find((a) => a.id === 'low').state?.quotaDisposition ?? null, null, 'explicit ignore cannot be upgraded to hold');
  // A role-aware partial 100 snapshot independently confirms exhaustion without a
  // chat failure. Without a valid reset the existing success interval owns retry timing.
  quotaResult = true;
  assert.equal((await post(state.serverPort, '/api/statistics/quota-refresh', { force: true })).status, 200);
  view = await get(state.serverPort);
  const low = view.accounts.find((a) => a.id === 'low');
  assert.equal(low.state.quotaDisposition, 'quota-exhausted');
  assert.equal(low.state.quotaRetryAt, 0);
  const stats = await get(state.serverPort, '/api/statistics');
  const refresh = stats.accounts.find((a) => a.id === 'low').quota.refresh;
  assert.ok(refresh.nextAttemptAt > Date.now(), 'no reset uses the bounded success interval, not an immediate loop');
  const callsBefore = quotaCalls;
  await waitFor(() => quotaCalls > callsBefore, 'scheduler retries without a valid reset', 3000);
  assert.equal((await get(state.serverPort)).accounts.find((a) => a.id === 'low').state.quotaDisposition, 'quota-exhausted');
});

test('role priority supersedes an older high binding when low RPM recovers', async (t) => {
  const seen = [];
  const pipe = { ...pipeline(2, 2, 1), healthSort: true, sticky: true };
  const state = await setup(t, [account('low', { maxRpm: 1 }), account('high')], pipe, (req, res) => {
    if (req.method === 'GET') return answer(res, 500, {});
    seen.push(req.headers.authorization); answer(res);
  }, { CLINE_PASS_TEST_RPM_WINDOW_MS: '300' });
  await seedQuotas(state, { low: 85, high: 0 }, { CLINE_PASS_TEST_RPM_WINDOW_MS: '300' });
  const boundChat = (session) => fetch(`http://127.0.0.1:${state.serverPort}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Session-Id': session }, body: JSON.stringify({ model: 'm', messages: [] }) });
  assert.equal((await boundChat('first-session')).status, 200);
  assert.equal((await boundChat('second-session')).status, 200);
  assert.deepEqual(seen, ['Bearer local-low', 'Bearer local-high']);
  await waitFor(async () => (await get(state.serverPort)).accounts.find((a) => a.id === 'low').rpm.retryAt === null, 'RPM window recovered', 3000);
  assert.equal((await boundChat('second-session')).status, 200);
  assert.equal(seen.at(-1), 'Bearer local-low', 'high binding cannot override an admissible low role');
});

test('post-start low account failure holds only future traffic without replay', async (t) => {
  const seen=[];
  const state = await setup(t, [account('low'), account('high')], pipeline(2, 2, 1), (req, res) => {
    if (req.method === 'GET') return answer(res, 500, {});
    seen.push(req.headers.authorization);
    if (req.headers.authorization === 'Bearer local-low') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"start"}}]}\n\n');
      return res.end('data: {"error":{"message":"account auth failure","status":401}}\n\n');
    }
    answer(res);
  });
  await seedQuotas(state, { low: 82, high: 0 });
  const response = await fetch(`http://127.0.0.1:${state.serverPort}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'm', messages: [], stream: true }) });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /start/);
  await waitFor(async () => (await get(state.serverPort)).accounts.find((a) => a.id === 'low').state?.quotaDisposition === 'waiting-refresh', 'post-start hold');
  assert.deepEqual(seen, ['Bearer local-low'], 'no account replacement after first SSE event');
  const next = await chat(state.serverPort);
  assert.equal(next.status, 200); assert.equal(seen.at(-1), 'Bearer local-high');
});

test('cancelled low stream does not create a quota hold or an account failure sample', async (t) => {
  let opened = false;
  const state = await setup(t, [account('low'), account('high')], pipeline(2, 2, 1), (req, res) => {
    if (req.method === 'GET') return answer(res, 500, {});
    opened = true;
    // No first SSE event: the client cancels before any response is exposed.
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  });
  await seedQuotas(state, { low: 82, high: 0 });
  const request = http.request({ hostname: '127.0.0.1', port: state.serverPort, path: '/v1/chat/completions', method: 'POST', headers: { 'Content-Type': 'application/json' } });
  request.on('error', () => {});
  request.end(JSON.stringify({ model: 'm', messages: [], stream: true }));
  await waitFor(() => opened, 'native low stream attempt');
  request.destroy();
  await waitFor(async () => (await get(state.serverPort)).accounts.find((a) => a.id === 'low').activeCount === 0, 'cancelled lease release');
  const view = await get(state.serverPort), low = view.accounts.find((a) => a.id === 'low');
  assert.equal(low.state?.quotaDisposition ?? null, null);
  assert.equal(low.health.degrades, 0);
});

test('pure concurrency growth expands the high target once and retains low slots across restart', async (t) => {
  const pending=[];
  const state = await setup(t, [account('low'), account('high1'), account('high2')], pipeline(2, 3, 1), (req, res) => {
    if (req.method === 'GET') return answer(res, 500, {});
    pending.push(res);
  });
  await seedQuotas(state, { low: 85, high1: 0, high2: 10 });
  const first = chat(state.serverPort); await waitFor(() => pending.length === 1, 'low admission');
  const second = chat(state.serverPort); await waitFor(() => pending.length === 2, 'high admission');
  const third = chat(state.serverPort); await waitFor(() => pending.length === 3, 'grown high admission');
  let view = await get(state.serverPort);
  assert.equal(view.cachePool.targetSize, 3);
  assert.deepEqual(view.cachePool.actual, { high: 2, low: 1, unknown: 0 });
  assert.equal(JSON.parse(fs.readFileSync(path.join(state.dir, 'metadata.json'), 'utf8')).cachePoolTargetSize, 3);
  for (const res of pending) answer(res);
  assert.deepEqual((await Promise.all([first,second,third])).map((result) => result.status), [200,200,200]);
  await stop(state.child); state.child = await start(state.dir);
  view = await get(state.serverPort);
  assert.equal(view.cachePool.targetSize, 3);
  assert.deepEqual(view.cachePool.actual, { high: 2, low: 1, unknown: 0 });
  assert.ok(view.accounts.every((a) => a.activeCount === 0));
});

test('expired rule cooldown and manual recovery clear only rule fields, not quota disposition', async (t) => {
  const state = await setup(t, [account('low'), account('high')], pipeline(2, 2, 1), (req, res) => req.method === 'GET' ? answer(res, 500, {}) : answer(res));
  await seedQuotas(state, { low: 85, high: 0 });
  await stop(state.child); state.child = null;
  const file = path.join(state.dir, 'metadata.json'), meta = JSON.parse(fs.readFileSync(file, 'utf8')), now = Date.now();
  meta.accountStates.low = { banned: false, hardQuarantined: false, cooldownUntil: now - 1, ruleId: 'rule-401', statusCode: 401, updatedAt: now - 100,
    quotaDisposition: 'waiting-refresh', quotaDispositionAt: now, quotaRetryAt: 0, quotaReason: 'account-degrade' };
  fs.writeFileSync(file, JSON.stringify(meta)); state.child = await start(state.dir);
  let hold = (await get(state.serverPort)).accounts.find((a) => a.id === 'low').state;
  assert.equal(hold.quotaDisposition, 'waiting-refresh', 'expiry must not delete the quota dimension');
  assert.equal(hold.cooldownUntil, undefined, 'the expired rule dimension is removed');
  assert.equal((await post(state.serverPort, '/api/accounts/recover', { id: 'low' })).status, 200);
  hold = (await get(state.serverPort)).accounts.find((a) => a.id === 'low').state;
  assert.equal(hold.quotaDisposition, 'waiting-refresh');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).accountStates.low.quotaDisposition, 'waiting-refresh');
});

test('turning on low roles immediately reconciles a cached partial known-100 snapshot', async (t) => {
  const state = await setup(t, [account('low'), account('high')], pipeline(2, 2, 0), (req, res) => req.method === 'GET' ? answer(res, 500, {}) : answer(res));
  await seedQuotas(state, { low: 100, high: 0 });
  await stop(state.child); state.child = null;
  const file = path.join(state.dir, 'metadata.json'), meta = JSON.parse(fs.readFileSync(file, 'utf8'));
  meta.accountQuotas.low.snapshot.limits = { weekly: { percentUsed: 100 } };
  fs.writeFileSync(file, JSON.stringify(meta)); state.child = await start(state.dir);
  let view = await get(state.serverPort);
  assert.equal(view.accounts.find((a) => a.id === 'low').state?.quotaDisposition ?? null, null, 'low=0 does not add role disposition');
  const result = await post(state.serverPort, '/api/accounts', { accounts: view.accounts, mode: 'sticky', active: 0, concurrencyWaitMs: 0, errorRules: view.errorRules, accountPipeline: { ...view.accountPipeline, cachePoolLowQuotaSize: 1 } });
  assert.equal(result.status, 200);
  view = await get(state.serverPort);
  assert.equal(view.accounts.find((a) => a.id === 'low').state.quotaDisposition, 'quota-exhausted');
  assert.equal(view.accounts.find((a) => a.id === 'low').cachePoolRole, null);
});

test('explicit low account cooldown performs only the rule disposition', async (t) => {
  const state = await setup(t, [account('low'), account('high')], pipeline(2, 2, 1), (req, res) => {
    if (req.method === 'GET') return answer(res, 500, {});
    return req.headers.authorization === 'Bearer local-low' ? answer(res, 401, { error: { message: 'account rejected' } }) : answer(res);
  });
  await seedQuotas(state, { low: 85, high: 0 });
  const view = await get(state.serverPort);
  const rule = { id: 'cooldown-auth', scope: 'account', action: 'cooldown', when: { statuses: [401] }, reset: { fallback: '1m0s', max: '1m0s' } };
  assert.equal((await post(state.serverPort, '/api/accounts', { accounts: view.accounts, mode: 'sticky', active: 0, concurrencyWaitMs: 0, errorRules: [rule], accountPipeline: view.accountPipeline })).status, 200);
  assert.equal((await chat(state.serverPort)).status, 200);
  const low = (await get(state.serverPort)).accounts.find((a) => a.id === 'low');
  assert.ok(low.state.cooldownUntil > Date.now());
  assert.equal(low.state.quotaDisposition ?? null, null, 'explicit cooldown is never layered with waiting-refresh');
});

test('blocked low binding overflows to high immediately without rewriting the binding', async (t) => {
  let releaseLow; const seen=[];
  const state = await setup(t, [account('low'), account('high')], { ...pipeline(2, 2, 1), sticky: true, healthSort: true }, (req, res) => {
    if (req.method === 'GET') return answer(res, 500, {});
    seen.push(req.headers.authorization);
    if (req.headers.authorization === 'Bearer local-low' && !releaseLow) releaseLow = () => answer(res);
    else answer(res);
  });
  await seedQuotas(state, { low: 85, high: 0 });
  const send = async () => {
    const response = await fetch(`http://127.0.0.1:${state.serverPort}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Session-Id': 'same-binding' }, body: JSON.stringify({ model: 'm', messages: [] }) });
    await response.text(); return response;
  };
  const first = send(); await waitFor(() => !!releaseLow, 'bound low request');
  const second = await send(); assert.equal(second.status, 200);
  assert.deepEqual(seen, ['Bearer local-low','Bearer local-high']);
  releaseLow(); assert.equal((await first).status, 200);
  assert.equal((await send()).status, 200);
  assert.equal(seen.at(-1), 'Bearer local-low', 'temporary high overflow must not rebind the session');
  const rows = (await get(state.serverPort, '/api/logs/requests?limit=10')).items;
  assert.ok(rows.some((row) => row.bindingResult === 'temporary-overflow' && row.selectedQuotaRole === 'high'));
});

test('disable/re-enable retains both quota holds; key/proxy rotation and deletion prune only the affected identities', async (t) => {
  const state = await setup(t, [account('waiting'), account('exhausted'), account('high')], pipeline(3, 3, 1), (req, res) => req.method === 'GET' ? answer(res, 500, {}) : answer(res));
  await seedQuotas(state, { waiting: 85, exhausted: 100, high: 0 });
  await stop(state.child); state.child = null;
  const file = path.join(state.dir, 'metadata.json'), meta = JSON.parse(fs.readFileSync(file, 'utf8'));
  meta.accountStates.waiting = { quotaDisposition: 'waiting-refresh', quotaDispositionAt: Date.now(), quotaRetryAt: 0, quotaReason: 'account-degrade' };
  fs.writeFileSync(file, JSON.stringify(meta)); state.child = await start(state.dir);
  const save = (view, accounts) => post(state.serverPort, '/api/accounts', { accounts, mode: 'sticky', active: 0, concurrencyWaitMs: 0, errorRules: view.errorRules, accountPipeline: view.accountPipeline });
  let view = await get(state.serverPort);
  assert.equal(view.accounts.find((a) => a.id === 'exhausted').state.quotaDisposition, 'quota-exhausted');
  assert.equal((await save(view, view.accounts.map((a) => a.id === 'waiting' || a.id === 'exhausted' ? { ...a, enabled: false } : a))).status, 200);
  view = await get(state.serverPort);
  assert.equal(view.accounts.find((a) => a.id === 'waiting').state.quotaDisposition, 'waiting-refresh');
  assert.equal(view.accounts.find((a) => a.id === 'exhausted').state.quotaDisposition, 'quota-exhausted');
  assert.equal((await save(view, view.accounts.map((a) => ({ ...a, enabled: true })))).status, 200);
  view = await get(state.serverPort);
  assert.equal(view.accounts.find((a) => a.id === 'waiting').state.quotaDisposition, 'waiting-refresh');
  assert.equal(view.accounts.find((a) => a.id === 'exhausted').state.quotaDisposition, 'quota-exhausted');
  assert.equal((await save(view, view.accounts.map((a) => a.id === 'waiting' ? { ...a, key: 'rotated-local-key' } : a))).status, 200);
  view = await get(state.serverPort);
  assert.equal(view.accounts.find((a) => a.id === 'waiting').state, null);
  assert.equal(view.accounts.find((a) => a.id === 'waiting').quota.status, 'unknown');
  assert.equal(view.accounts.find((a) => a.id === 'exhausted').state.quotaDisposition, 'quota-exhausted');
  assert.equal((await save(view, view.accounts.map((a) => a.id === 'exhausted' ? { ...a, proxyUrl: 'http://127.0.0.1:31239' } : a))).status, 200);
  view = await get(state.serverPort);
  assert.equal(view.accounts.find((a) => a.id === 'exhausted').state, null);
  assert.equal(view.accounts.find((a) => a.id === 'exhausted').quota.status, 'unknown');
  assert.equal((await save(view, view.accounts.filter((a) => a.id !== 'waiting'))).status, 200);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(Object.hasOwn(saved.accountStates, 'waiting'), false);
  assert.equal(Object.hasOwn(saved.accountQuotas, 'waiting'), false);
});

test('fresh quota recovery clears only quota fields and preserves an independent rule quarantine', async (t) => {
  const state = await setup(t, [account('low'), account('high')], pipeline(2, 2, 1), (req, res) => req.method === 'GET' ? answer(res, 200, limits({ five_hour: 0, weekly: 0, monthly: 0 })) : answer(res));
  await seedQuotas(state, { low: 100, high: 0 });
  await stop(state.child); state.child = null;
  const file = path.join(state.dir, 'metadata.json'), meta = JSON.parse(fs.readFileSync(file, 'utf8'));
  meta.accountStates.low = { banned: true, hardQuarantined: true, cooldownUntil: 0, statusCode: 401, reason: 'rule:manual', ruleId: 'manual', updatedAt: Date.now(), quotaDisposition: 'quota-exhausted', quotaDispositionAt: Date.now(), quotaRetryAt: 0, quotaReason: 'known-exhausted' };
  fs.writeFileSync(file, JSON.stringify(meta)); state.child = await start(state.dir);
  assert.equal((await post(state.serverPort, '/api/statistics/quota-refresh', { force: true })).status, 200);
  const low = (await get(state.serverPort)).accounts.find((a) => a.id === 'low');
  assert.equal(low.state.quotaDisposition, null);
  assert.equal(low.state.hardQuarantined, true);
  assert.equal(low.cachePoolRole, null, 'quota recovery never overrides rule quarantine');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).accountStates.low.hardQuarantined, true);
});

test('quota role stays ahead of quotaPool order, healthSort, sticky and legacy account modes', async (t) => {
  for (const [mode, order, flags] of [
    ['sticky', ['healthSort','quotaPool','sticky'], { quotaPool: true, healthSort: true, sticky: true }],
    ['roundrobin', ['sticky','quotaPool','healthSort'], { quotaPool: true, healthSort: true, sticky: true }],
    ['single', ['quotaPool','sticky','healthSort'], { quotaPool: true, healthSort: true, sticky: true }],
    ['priority-failover', ['healthSort','sticky','quotaPool'], { quotaPool: false, healthSort: true, sticky: true }],
  ]) await t.test(mode, async (sub) => {
    let last = null;
    const state = await setup(sub, [account('high', { priority: 1 }), account('low', { priority: 100 })], { ...pipeline(2, 2, 1), ...flags, order }, (req, res) => {
      if (req.method === 'GET') return answer(res, 500, {});
      last = req.headers.authorization; answer(res);
    });
    await seedQuotas(state, { high: 0, low: 85 });
    if (mode !== 'sticky') {
      const view = await get(state.serverPort);
      assert.equal((await post(state.serverPort, '/api/accounts', { accounts: view.accounts, mode, active: 0, concurrencyWaitMs: 0, errorRules: view.errorRules, accountPipeline: view.accountPipeline })).status, 200);
    }
    const res = await fetch(`http://127.0.0.1:${state.serverPort}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Session-Id': 'high-would-win-without-role-partition' }, body: JSON.stringify({ model: 'm', messages: [] }) });
    assert.equal(res.status, 200); await res.arrayBuffer();
    assert.equal(last, 'Bearer local-low', `${mode} must select the admissible low role despite high priority and optional stages`);
  });
});

test('pre-admission capacity rows do not fabricate zero pool composition', async (t) => {
  const state = await setup(t, [account('low', { maxRpm: 1 })], pipeline(1, 1, 1), (req, res) => req.method === 'GET' ? answer(res, 500, {}) : answer(res));
  await seedQuotas(state, { low: 85 });
  assert.equal((await chat(state.serverPort)).status, 200);
  assert.equal((await chat(state.serverPort)).status, 429);
  const rows = await waitFor(async () => { const logs = await get(state.serverPort, '/api/logs/requests?limit=10'); return logs.items?.some((row) => row.status === 429) && logs.items; }, 'capacity row published');
  assert.equal(rows.find((row) => row.status === 429).cachePoolActual, null);
  assert.deepEqual(rows.find((row) => row.status === 200).cachePoolActual, { high: 0, low: 1, unknown: 0 });
});
