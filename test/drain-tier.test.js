import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { prepareAdminFixture, connectAdminFixture, installFixtureFetch } from './admin-fixture.js';
import { defaultAccountWorkflow } from '../lib/account-workflow.js';
installFixtureFetch();

// Pre-drain release used to prove an old image accepts the new accountPipeline fields.
const PRE_DRAIN_COMMIT = '9678fb0';
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = (server) => new Promise((resolve) => server.close(resolve));
const freePort = async () => { const server = http.createServer(); const value = await listen(server); await close(server); return value; };
async function waitFor(check, label, ms = 5000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await new Promise((resolve) => setTimeout(resolve, 10)); }
  throw new Error(`timed out: ${label}`);
}
async function start(dir, extra = {}) {
  prepareAdminFixture(dir);
  const child = spawn(process.execPath, ['server.js'], { cwd: path.resolve('.'), env: { PATH: process.env.PATH, DATA_DIR: dir, BIND_HOST: '127.0.0.1', NODE_ENV: 'test', ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (data) => { output += data; }); child.stderr.on('data', (data) => { output += data; });
  await waitFor(() => { if (child.exitCode !== null) throw new Error(`startup failed: ${output}`); return output.includes('OpenAI 兼容代理地址'); }, 'server startup');
  const config = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  await connectAdminFixture(Number(config.port));
  return child;
}
async function stop(child) { if (!child || child.exitCode !== null) return; child.kill('SIGTERM'); await Promise.race([new Promise((resolve) => child.once('exit', resolve)), new Promise((resolve) => setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 1000))]); }
const account = (id, extra = {}) => ({ id, name: id, key: `local-${id}`, enabled: true, maxConcurrent: 0, priority: 10, ...extra });
const pipeline = (size, extra = {}) => ({ quotaPool: false, healthSort: false, sticky: false, order: ['quotaPool', 'healthSort', 'sticky'], cachePoolSize: size, cachePoolMaxSize: size, cachePoolLowQuotaSize: 0, ...extra });
const quota = (used, now) => ({ snapshot: { limits: Object.fromEntries(['five_hour', 'weekly', 'monthly'].map((type) => [type, { percentUsed: used }])), fetchedAt: now }, lastAttemptAt: now, lastSuccessAt: now, errorCategory: null });

// Upstream: quota reads fail (seeded snapshots stay authoritative), chats answer
// immediately unless the account is listed in `hold`, in which case the response waits.
async function setup(t, { accounts, pipe, workflow = { ...defaultAccountWorkflow(), enabled: true }, quotas = {}, responder = null }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cps-drain-'));
  const state = { dir, seen: [], held: [], hold: new Set() };
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (req.method === 'GET') { res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end('{}'); }
      const id = req.headers.authorization.replace('Bearer local-', '');
      state.seen.push(id);
      if (responder) return responder(id, res);
      const answer = () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: 'OK' } }] })); };
      if (state.hold.has(id)) state.held.push(answer); else answer();
    });
  });
  const upstreamPort = await listen(upstream);
  state.port = await freePort();
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ port: state.port, upstreamBase: `http://127.0.0.1:${upstreamPort}`, accounts, accountMode: 'roundrobin', activeAccount: 0, concurrencyWaitMs: 0, poolFullWaitMs: 0, knownModels: ['m'], perModel: {}, errorRules: [], accountPipeline: pipe, accountWorkflow: workflow }));
  const now = Date.now();
  fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify({ accountQuotas: Object.fromEntries(Object.entries(quotas).map(([id, used]) => [id, quota(used, now)])) }));
  state.child = await start(dir);
  state.get = async (route = '/api/accounts') => (await fetch(`http://127.0.0.1:${state.port}${route}`)).json();
  state.post = async (route, body) => { const res = await fetch(`http://127.0.0.1:${state.port}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: res.status, data: await res.json() }; };
  state.chat = (session = null) => {
    const pending = state.post('/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: `drain ${session || Math.random()}` }], ...(session ? { session_id: session } : {}) });
    return pending;
  };
  state.save = async (patch = {}) => {
    const view = await state.get();
    return state.post('/api/accounts', { accounts: view.accounts, mode: view.mode, active: view.active, concurrencyWaitMs: view.concurrencyWaitMs, poolFullWaitMs: view.poolFullWaitMs, errorRules: view.errorRules, accountPipeline: view.accountPipeline, accountWorkflow: view.accountWorkflow, ...patch });
  };
  state.release = () => { for (const answer of state.held.splice(0)) answer(); };
  t.after(async () => { state.release(); await stop(state.child); upstream.closeAllConnections?.(); await close(upstream); fs.rmSync(dir, { recursive: true, force: true }); });
  return state;
}
const byId = (view) => Object.fromEntries(view.accounts.map((a) => [a.id, a]));

test('drain disabled keeps the 95% reserve boundary and the default 80% warm boundary', async (t) => {
  const s = await setup(t, { accounts: [account('hot'), account('warm'), account('high'), account('full')], pipe: pipeline(3), quotas: { hot: 79, warm: 87, high: 96, full: 100 } });
  const view = await s.get();
  assert.equal(view.accountPipeline.drainEnabled, false);
  assert.equal(view.accountPipeline.drainThreshold, 95);
  assert.equal(view.accountPipeline.drainMaxConcurrent, 2);
  assert.equal(view.accountPipeline.warmThreshold, 80);
  const accounts = byId(view);
  assert.deepEqual([accounts.hot.quota.pool, accounts.warm.quota.pool, accounts.high.quota.pool, accounts.full.quota.pool], ['hot', 'warm', 'reserve', 'reserve']);
  assert.equal(accounts.high.cachePoolRole, 'standby');
  assert.deepEqual(view.cachePool.actual, { high: 1, low: 1, unknown: 0 }, 'no drain field while drain is inactive');
  assert.equal(accounts.high.effectiveMaxConcurrent, 0);
  for (let i = 0; i < 4; i++) assert.equal((await s.chat()).status, 200);
  assert.equal(s.seen.includes('high'), false);
});

test('drain enabled admits 95-99.x into the active pool, keeps 100 out and reports effective concurrency', async (t) => {
  const s = await setup(t, { accounts: [account('normal', { maxConcurrent: 5 }), account('d96'), account('d99', { maxConcurrent: 1 }), account('full')], pipe: pipeline(1, { drainEnabled: true }), quotas: { normal: 10, d96: 96, d99: 99.5, full: 100 } });
  const view = await s.get(), accounts = byId(view);
  assert.equal(accounts.d96.quota.pool, 'drain');
  assert.equal(accounts.d99.quota.pool, 'drain');
  assert.equal(accounts.full.quota.pool, 'reserve');
  assert.equal(accounts.d96.cachePoolRole, 'active');
  assert.equal(accounts.d99.cachePoolRole, 'active');
  assert.equal(accounts.normal.cachePoolRole, 'active', 'drain accounts join on top of the target, never displacing a member');
  assert.equal(accounts.full.cachePoolRole, 'standby');
  assert.deepEqual(view.cachePool.actual, { high: 1, low: 0, unknown: 0, drain: 2 });
  assert.equal(accounts.d96.effectiveMaxConcurrent, 2, 'unlimited account takes drainMaxConcurrent');
  assert.equal(accounts.d99.effectiveMaxConcurrent, 1, 'a smaller own limit wins');
  assert.equal(accounts.d99.maxConcurrent, 1);
  assert.equal(accounts.normal.effectiveMaxConcurrent, 5);
  const statistics = await s.get('/api/statistics');
  assert.equal(statistics.accounts.find((a) => a.id === 'd96').quota.pool, 'drain');
});

test('new selections prefer idle drain accounts, honor the drain cap and then fall back to ordinary accounts', async (t) => {
  const s = await setup(t, { accounts: [account('normal'), account('zdrain', { maxConcurrent: 5 }), account('other')], pipe: pipeline(2, { drainEnabled: true, drainMaxConcurrent: 2 }), quotas: { normal: 10, zdrain: 97, other: 20 } });
  s.hold.add('zdrain');
  const first = s.chat(), second = s.chat();
  await waitFor(() => s.held.length === 2, 'two in-flight drain requests');
  assert.deepEqual(s.seen, ['zdrain', 'zdrain']);
  assert.equal(byId(await s.get()).zdrain.activeCount, 2);
  assert.equal((await s.chat()).status, 200);
  assert.notEqual(s.seen.at(-1), 'zdrain', 'a drain account at its cap is not admitted again');
  s.hold.clear(); s.release();
  assert.equal((await first).status, 200); assert.equal((await second).status, 200);
  assert.equal((await s.chat()).status, 200);
  assert.equal(s.seen.at(-1), 'zdrain', 'the idle drain account is preferred again');
  const rows = (await s.get('/api/logs/requests?limit=20')).items;
  const capacity = rows.find((row) => row.workflow)?.workflow.decisions[0].nodes.find((node) => node.node === 'capacity');
  assert.equal(typeof capacity.drainAfter, 'number', 'request log capacity node reports the drain tier size');
});

test('a smaller own maxConcurrent caps a drain account below drainMaxConcurrent', async (t) => {
  const s = await setup(t, { accounts: [account('normal'), account('zdrain', { maxConcurrent: 1 })], pipe: pipeline(1, { drainEnabled: true, drainMaxConcurrent: 3 }), quotas: { normal: 10, zdrain: 96 } });
  s.hold.add('zdrain');
  const first = s.chat();
  await waitFor(() => s.held.length === 1, 'one in-flight drain request');
  assert.equal((await s.chat()).status, 200);
  assert.deepEqual(s.seen, ['zdrain', 'normal']);
  s.release(); assert.equal((await first).status, 200);
});

test('an existing binding on an ordinary account is reused while a drain account is idle', async (t) => {
  const s = await setup(t, { accounts: [account('normal'), account('zdrain')], pipe: pipeline(1, { drainEnabled: true, drainMaxConcurrent: 1 }), quotas: { normal: 10, zdrain: 96 } });
  s.hold.add('zdrain');
  const filler = s.chat();
  await waitFor(() => s.held.length === 1, 'drain account saturated');
  assert.equal((await s.chat('bound-session')).status, 200);
  assert.equal(s.seen.at(-1), 'normal');
  s.hold.clear(); s.release(); assert.equal((await filler).status, 200);
  for (let i = 0; i < 3; i++) {
    assert.equal((await s.chat('bound-session')).status, 200);
    assert.equal(s.seen.at(-1), 'normal', 'binding hit is not migrated to the idle drain account');
  }
  assert.equal((await s.chat('fresh-session')).status, 200);
  assert.equal(s.seen.at(-1), 'zdrain');
});

test('quota filters never drop drain accounts and drain degradation enters waiting-refresh without a low slot', async (t) => {
  const s = await setup(t, { accounts: [account('normal'), account('zdrain')], pipe: pipeline(1, { drainEnabled: true }), quotas: { normal: 10, zdrain: 96 },
    workflow: { ...defaultAccountWorkflow(), enabled: true, quotaPools: ['hot'] },
    responder: (id, res) => { res.writeHead(id === 'zdrain' ? 401 : 200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(id === 'zdrain' ? { error: { message: 'account auth failure' } } : { choices: [{ message: { content: 'OK' } }] })); } });
  assert.equal((await s.chat()).status, 200, 'drain is tried first and replaced before output');
  assert.deepEqual(s.seen.slice(0, 2), ['zdrain', 'normal']);
  await waitFor(async () => byId(await s.get()).zdrain.state?.quotaDisposition === 'waiting-refresh', 'drain hold');
  const count = s.seen.length;
  assert.equal((await s.chat()).status, 200);
  assert.deepEqual(s.seen.slice(count), ['normal'], 'held drain account is excluded');
  // The forced refresh fails (upstream quota 500), so the snapshot turns unknown; the hold must survive it.
  await waitFor(async () => byId(await s.get()).zdrain.quota?.pool === 'unknown', 'failed refresh makes the snapshot unknown');
  assert.equal(byId(await s.get()).zdrain.cachePoolRole, null, 'a held former drain account stays excluded while its quota is unknown');
});

test('configurable warm boundary and strict validation of drain fields', async (t) => {
  const s = await setup(t, { accounts: [account('a87'), account('a92'), account('a96')], pipe: pipeline(3), quotas: { a87: 87, a92: 92, a96: 96 } });
  let accounts = byId(await s.get());
  assert.equal(accounts.a87.quota.pool, 'warm', 'default warm boundary is 80');
  const view = await s.get();
  assert.equal((await s.save({ accountPipeline: { ...view.accountPipeline, warmThreshold: 90 } })).status, 200);
  accounts = byId(await s.get());
  assert.equal(accounts.a87.quota.pool, 'hot');
  assert.equal(accounts.a92.quota.pool, 'warm');
  assert.equal(accounts.a96.quota.pool, 'reserve');
  const current = (await s.get()).accountPipeline;
  const before = fs.readFileSync(path.join(s.dir, 'config.json'));
  const invalid = [
    { drainThreshold: 90 }, { drainThreshold: 85 }, { drainThreshold: 100 }, { drainThreshold: 101 }, { drainThreshold: '96' }, { drainThreshold: null },
    { drainMaxConcurrent: 0 }, { drainMaxConcurrent: -1 }, { drainMaxConcurrent: 1.5 }, { drainMaxConcurrent: '2' },
    { drainEnabled: 'true' }, { warmThreshold: 95 }, { warmThreshold: 0 }, { warmThreshold: -5 }, { warmThreshold: 'x' },
    { drainEnabled: true, drainThreshold: 97, warmThreshold: 97 }, { drainUnknown: 1 },
  ];
  for (const patch of invalid) {
    const result = await s.save({ accountPipeline: { ...current, ...patch } });
    assert.equal(result.status, 400, JSON.stringify(patch));
    assert.deepEqual(fs.readFileSync(path.join(s.dir, 'config.json')), before);
  }
  assert.equal((await s.save({ accountPipeline: { ...current, drainEnabled: true, drainThreshold: 97, warmThreshold: 96, drainMaxConcurrent: 3 } })).status, 200, 'warm may exceed 95 when drain raises the upper bound');
  const saved = (await s.get()).accountPipeline;
  assert.deepEqual([saved.drainEnabled, saved.drainThreshold, saved.warmThreshold, saved.drainMaxConcurrent], [true, 97, 96, 3]);
  const { drainEnabled: _a, drainThreshold: _b, drainMaxConcurrent: _c, warmThreshold: _d, ...old } = saved;
  assert.equal((await s.save({ accountPipeline: old })).status, 200);
  const preserved = (await s.get()).accountPipeline;
  assert.deepEqual([preserved.drainEnabled, preserved.drainThreshold, preserved.warmThreshold, preserved.drainMaxConcurrent], [true, 97, 96, 3], 'an older client omitting the fields preserves them');
  await stop(s.child); s.child = await start(s.dir);
  assert.equal((await s.get()).accountPipeline.drainThreshold, 97, 'restart keeps persisted drain settings');
});

test('preview predicts drain-first selection from the draft without changing state', async (t) => {
  const s = await setup(t, { accounts: [account('normal'), account('zdrain')], pipe: pipeline(1), quotas: { normal: 10, zdrain: 96 } });
  const view = await s.get();
  const off = await s.post('/api/account-workflow/preview', { accountWorkflow: view.accountWorkflow, accountPipeline: view.accountPipeline, clientKeyId: 'legacy' });
  assert.equal(off.data.decision.accountId, 'normal', 'drain off: 96% is reserve');
  const on = await s.post('/api/account-workflow/preview', { accountWorkflow: view.accountWorkflow, accountPipeline: { ...view.accountPipeline, drainEnabled: true }, clientKeyId: 'legacy' });
  assert.equal(on.status, 200);
  assert.equal(on.data.decision.accountId, 'zdrain');
  assert.equal(on.data.decision.nodes.find((node) => node.node === 'capacity').drainAfter, 1);
  assert.equal(byId(await s.get()).zdrain.quota.pool, 'reserve', 'preview does not change live projection');
});

test('roundrobin selector rotates by least-recent selection in the live workflow', async (t) => {
  const s = await setup(t, { accounts: [account('a'), account('b', { maxConcurrent: 1 }), account('c')], pipe: pipeline(3), quotas: { a: 1, b: 1, c: 1 }, workflow: { ...defaultAccountWorkflow(), enabled: true, selector: 'roundrobin' } });
  for (let i = 0; i < 6; i++) assert.equal((await s.chat()).status, 200);
  assert.deepEqual(s.seen, ['a', 'b', 'c', 'a', 'b', 'c'], 'N idle accounts are each chosen once per N selections');
  s.hold.add('b');
  assert.equal((await s.chat()).status, 200);
  const busy = s.chat();
  await waitFor(() => s.held.length === 1, 'b in flight');
  for (let i = 0; i < 3; i++) assert.equal((await s.chat()).status, 200);
  assert.deepEqual(s.seen.slice(6), ['a', 'b', 'c', 'a', 'c'], 'least-recent b is skipped while at its concurrency cap');
  s.hold.clear(); s.release(); assert.equal((await busy).status, 200);
  assert.equal((await s.chat()).status, 200);
  assert.equal(s.seen.at(-1), 'b', 'the skipped account gets the next turn once idle');
});

test('the pre-drain release accepts a config carrying the new accountPipeline fields', (t) => {
  let source;
  try { source = execFileSync('git', ['show', `${PRE_DRAIN_COMMIT}:server.js`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch { t.skip('pre-drain commit is not available in this checkout'); return; }
  const startIndex = source.indexOf("const PIPELINE_KEYS = ['quotaPool', 'healthSort', 'sticky'];");
  const fnIndex = source.indexOf('function normalizeAccountPipeline(');
  const endIndex = source.indexOf('\n}\n', fnIndex);
  assert.ok(startIndex >= 0 && fnIndex > startIndex && endIndex > fnIndex);
  assert.equal(source.includes('drainEnabled'), false);
  const normalizeOld = new Function(`${source.slice(startIndex, endIndex + 2)}\nreturn normalizeAccountPipeline;`)();
  const written = { ...pipeline(2), drainEnabled: true, drainThreshold: 95, drainMaxConcurrent: 2, warmThreshold: 90 };
  const out = normalizeOld(written);
  for (const key of ['drainEnabled', 'drainThreshold', 'drainMaxConcurrent', 'warmThreshold']) assert.equal(Object.hasOwn(out, key), false);
  assert.equal(out.cachePoolSize, 2);
  assert.throws(() => normalizeOld(written, { strict: true }), /unknown field/, 'only the old strict save path rejects them');
});
