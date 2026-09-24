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
async function freePort() { const server = http.createServer(); const port = await listen(server); await close(server); return port; }
async function waitFor(fn, label, ms = 5000) {
  const until = Date.now() + ms;
  while (Date.now() < until) { const value = await fn(); if (value) return value; await new Promise((resolve) => setTimeout(resolve, 20)); }
  throw new Error(`timed out: ${label}`);
}
const limits = (rows) => ({ success: true, data: { limits: Object.entries(rows).map(([type, value]) => ({ type, percentUsed: typeof value === 'number' ? value : value.used, ...(value?.reset ? { resetsAt: value.reset } : {}) })) } });
function reply(res, status, body) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); }
const account = (id) => ({ id, name: id, key: `local-${id}`, enabled: true, maxConcurrent: 0 });
async function setup(t, responder, accounts = [account('a')], { metadataFault = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cps-protection-'));
  const fault = path.join(dir, 'fail-metadata-rename'), failedWrites = path.join(dir, 'failed-writes');
  let loader;
  if (metadataFault) {
    loader = path.join(dir, 'fault-loader.mjs');
    fs.writeFileSync(loader, `import fs from 'node:fs'; const rename = fs.renameSync; fs.renameSync = (src, dst) => { if (String(dst).endsWith('/metadata.json') && fs.existsSync(${JSON.stringify(fault)})) { fs.appendFileSync(${JSON.stringify(failedWrites)}, 'x'); throw Error('fixture metadata failure'); } return rename(src, dst); };`);
  }
  const upstream = http.createServer((req, res) => { req.resume(); req.on('end', () => responder(req, res)); });
  const upstreamPort = await listen(upstream), port = await freePort();
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ port, upstreamBase: `http://127.0.0.1:${upstreamPort}`, accounts, accountMode: 'roundrobin', concurrencyWaitMs: 0, knownModels: ['m'], errorRules: [], perModel: {} }));
  prepareAdminFixture(dir);
  const state = { dir, port, upstream, child: null, fault, failedWrites };
  state.start = async () => {
    const child = spawn(process.execPath, ['server.js'], { cwd: path.resolve('.'), env: { ...process.env, DATA_DIR: dir, PORT: String(port), BIND_HOST: '127.0.0.1', NODE_ENV: 'test', CLINE_PASS_TEST_QUOTA_SUCCESS_MS: '100', CLINE_PASS_TEST_QUOTA_FAILURE_MS: '200', ...(loader ? { NODE_OPTIONS: `--import=${loader}` } : {}) }, stdio: ['ignore','pipe','pipe'] });
    let output = ''; child.stdout.on('data', (c) => output += c); child.stderr.on('data', (c) => output += c);
    await waitFor(() => { if (child.exitCode !== null) throw new Error(output); return output.includes('OpenAI 兼容代理地址'); }, 'startup');
    state.child = child; await connectAdminFixture(port);
  };
  state.stop = async () => { const child = state.child; state.child = null; if (!child || child.exitCode !== null) return; child.kill('SIGTERM'); await Promise.race([new Promise((resolve) => child.once('exit', resolve)), new Promise((resolve) => setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 1500))]); };
  t.after(async () => { await state.stop(); await close(upstream); fs.rmSync(dir, { recursive: true, force: true }); });
  await state.start(); return state;
}
async function request(state, route = '/api/accounts', body) { const res = await fetch(`http://127.0.0.1:${state.port}${route}`, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type':'application/json' }, body: JSON.stringify(body) }); return { status: res.status, headers: res.headers, data: await res.json() }; }
const chat = (s) => request(s, '/v1/chat/completions', { model:'m', messages:[] });
const refresh = (s) => request(s, '/api/statistics/quota-refresh', { force: true });
const row = async (s, id = 'a') => (await request(s)).data.accounts.find((a) => a.id === id);

test('real account quota 429 verifies a new monthly-only snapshot; strict threshold, restart and explicit release', async (t) => {
  let quota = limits({ monthly:99.6 }), chatCalls = 0, quotaCalls = 0;
  const s = await setup(t, (req,res) => {
    if (req.method === 'GET') { quotaCalls++; return reply(res, 200, quota); }
    chatCalls++; reply(res, 429, { error: { code:'account_quota_exhausted', message:'account quota exhausted' } });
  });
  const before = (await request(s)).data;
  assert.equal(before.quotaProtection.monthlyThresholdUsd, 0.20);
  const configFile = path.join(s.dir, 'config.json'), bytes = fs.readFileSync(configFile);
  for (const value of [0, '0.201', '1', 50.01, null, {}, { monthlyThresholdUsd:0.001 }, { monthlyThresholdUsd:0.20000000001 }, { monthlyThresholdUsd:0.2, extra:1 }]) {
    assert.equal((await request(s, '/api/accounts', { accounts:before.accounts, mode:before.mode, active:0, concurrencyWaitMs:0, quotaProtection:value })).status, 400);
    assert.deepEqual(fs.readFileSync(configFile), bytes);
  }
  assert.equal((await refresh(s)).data.refreshed, 1);
  assert.equal((await chat(s)).status, 429);
  await waitFor(async () => quotaCalls >= 2 && !(await row(s)).quota.protectionPendingUntil, 'post-trigger snapshot');
  assert.equal((await row(s)).state?.protectionMonthlyAt || 0, 0, 'exact $0.20 must not ban');
  quota = limits({ monthly:99.5 });
  assert.equal((await chat(s)).status, 429);
  await waitFor(async () => quotaCalls >= 3 && !(await row(s)).quota.protectionPendingUntil, 'above-threshold refresh');
  assert.equal((await row(s)).state?.protectionMonthlyAt || 0, 0);
  quota = limits({ monthly:99.7 });
  assert.equal((await chat(s)).status, 429);
  await waitFor(async () => (await row(s)).state?.protectionMonthlyAt, 'monthly ban');
  const calls = chatCalls;
  const blocked = await chat(s);
  assert.equal(blocked.status, 503);
  assert.match(blocked.data.error.message, /monthly bans require administrator release/);
  assert.ok(Number(blocked.headers.get('retry-after')) >= 1);
  assert.equal(chatCalls, calls);
  const logs = await waitFor(async () => {
    const result = (await request(s, '/api/logs/requests')).data.items;
    return result.find((item) => item.selectionReason === 'quota-protection');
  }, 'protection log');
  assert.equal(logs.errorCategory, 'quota_protection');
  assert.equal(logs.upstreamStatus, null);
  assert.deepEqual(logs.attempts, []);
  await refresh(s); assert.ok((await row(s)).state.protectionMonthlyAt);
  await s.stop(); await s.start();
  assert.equal((await chat(s)).status, 503); assert.equal(chatCalls, calls);
  const saved = (await request(s)).data;
  assert.equal((await request(s, '/api/accounts', { accounts:saved.accounts, mode:saved.mode, active:0, concurrencyWaitMs:0 })).status, 200, 'older saves retain threshold');
  assert.equal((await request(s)).data.quotaProtection.monthlyThresholdUsd, 0.20);
  const rotated = (await request(s)).data;
  assert.equal((await request(s, '/api/accounts', { accounts:rotated.accounts.map((a) => ({...a, key:'new-local-key', proxyUrl:''})), mode:rotated.mode, active:0, concurrencyWaitMs:0 })).status, 200);
  assert.ok((await row(s)).state.protectionMonthlyAt, 'credential rotation cannot erase manual-release ban');
  await s.stop(); await s.start();
  assert.equal((await chat(s)).status, 503);
  for (const invalid of [{}, {id:'nope'}, {id:'a', extra:1}]) assert.equal((await request(s, '/api/accounts/quota-recover', invalid)).status, 400);
  assert.equal((await request(s, '/api/accounts/recover', { id:'a' })).status, 200);
  assert.equal((await chat(s)).status, 503);
  assert.equal((await request(s, '/api/accounts/quota-recover', {id:'a'})).status, 200);
  assert.equal((await request(s, '/api/accounts/quota-recover', {id:'a'})).status, 409);
  quota = limits({ monthly:99.4 });
  assert.equal((await chat(s)).status, 429);
  await waitFor(async () => !(await row(s)).quota.protectionPendingUntil, 'released account verification');
  const custom = (await request(s)).data;
  assert.equal((await request(s, '/api/accounts', { accounts:custom.accounts, mode:custom.mode, active:0, concurrencyWaitMs:0, quotaProtection:{monthlyThresholdUsd:0.29} })).status, 200);
  quota = limits({ monthly:99.5 });
  assert.equal((await chat(s)).status, 429);
  await waitFor(async () => (await row(s)).state?.protectionMonthlyAt, 'custom threshold ban');
});

test('failed monthly ban write blocks locally, warns admin, retries atomically and survives restart', async (t) => {
  let chatCalls = 0, quotaCalls = 0;
  const s = await setup(t, (req, res) => {
    if (req.method === 'GET') { quotaCalls++; return reply(res, 200, limits({ monthly: 99.9 })); }
    chatCalls++; reply(res, 429, { error: { code: 'account_quota_exhausted', message: 'account quota exhausted' } });
  }, [account('a')], { metadataFault: true });
  const initial = (await request(s)).data;
  assert.equal((await request(s, '/api/accounts', { accounts:initial.accounts, mode:initial.mode, active:0, concurrencyWaitMs:0,
    errorRules:[{ id:'cool-429', scope:'account', action:'cooldown', when:{ statuses:[429] }, reset:{ fallback:'1s', max:'1s' } }] })).status, 200);
  const metaFile = path.join(s.dir, 'metadata.json'), before = fs.readFileSync(metaFile);
  fs.writeFileSync(s.fault, '');
  assert.equal((await chat(s)).status, 429, 'model traffic keeps the original upstream response');
  await waitFor(async () => (await row(s)).quota.protectionPersistence === 'pending', 'admin sees uncommitted ban');
  assert.deepEqual(fs.readFileSync(metaFile), before, 'failed atomic rename retains exact old bytes');
  assert.ok((await row(s)).state.protectionMonthlyAt, 'confirmed ban still lives in META');
  const blocked = await chat(s);
  assert.equal(blocked.status, 503);
  assert.equal(chatCalls, 1, 'no further outbound chat while persistence is pending');
  assert.equal(quotaCalls, 1, 'persistence retry must not fetch quota again');
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal((await chat(s)).status, 503, 'expired rule cooldown cannot turn an unwritable confirmed ban into a 500');
  assert.equal((await row(s)).quota.protectionPersistence, 'pending');
  assert.equal(chatCalls, 1);
  assert.equal((await request(s, '/api/accounts/quota-recover', { id: 'a' })).status, 500, 'failed manual release cannot clear a pending ban');
  assert.equal((await row(s)).quota.protectionPersistence, 'pending');
  await waitFor(() => fs.existsSync(s.failedWrites) && fs.readFileSync(s.failedWrites, 'utf8').length >= 2, 'bounded timer retried failed metadata write');
  assert.deepEqual(fs.readFileSync(metaFile), before);
  assert.doesNotMatch(fs.readFileSync(metaFile, 'utf8'), /local-a|account quota exhausted|protectionPersistence/);
  assert.equal(fs.readdirSync(s.dir).some((name) => /^metadata\.json\..*\.tmp$/.test(name)), false);
  fs.unlinkSync(s.fault);
  assert.equal((await request(s, '/api/accounts/recover', { id: 'a' })).status, 200, 'another full META write also commits the pending ban');
  await waitFor(async () => (await row(s)).quota.protectionPersistence === 'persisted' && JSON.parse(fs.readFileSync(metaFile, 'utf8')).accountStates.a?.protectionMonthlyAt, 'successful full metadata write committed confirmed ban');
  assert.equal(quotaCalls, 1);
  await s.stop(); await s.start();
  assert.equal((await row(s)).quota.protectionPersistence, 'persisted');
  assert.equal((await chat(s)).status, 503);
  assert.equal(chatCalls, 1, 'restart cannot release the committed ban');
  const logs = (await request(s, '/api/logs/requests')).data.items;
  assert.equal(logs.some((item) => Object.hasOwn(item, 'protectionPersistence')), false, 'pending status is admin-only');
});

test('restart before a failed monthly-ban write cannot reconstruct the process-local pending ban', async (t) => {
  const s = await setup(t, (req, res) => req.method === 'GET'
    ? reply(res, 200, limits({ monthly: 99.9 }))
    : reply(res, 429, { error: { code: 'account_quota_exhausted', message: 'account quota exhausted' } }),
  [account('a')], { metadataFault: true });
  const metaFile = path.join(s.dir, 'metadata.json'), before = fs.readFileSync(metaFile);
  fs.writeFileSync(s.fault, '');
  assert.equal((await chat(s)).status, 429);
  await waitFor(async () => (await row(s)).quota.protectionPersistence === 'pending', 'uncommitted monthly ban');
  assert.deepEqual(fs.readFileSync(metaFile), before);
  await s.stop(); await s.start();
  const after = await row(s);
  assert.equal(after.state?.protectionMonthlyAt || 0, 0);
  assert.equal(after.quota.protectionPersistence, null);
  assert.deepEqual(fs.readFileSync(metaFile), before, 'restart never invents a durable ban from unwritten process state');
});

test('a fresh complete 100% snapshot does not suppress explicit monthly 429 verification', async (t) => {
  let quotaCalls = 0, chatCalls = 0;
  const s = await setup(t, (req, res) => {
    if (req.method === 'GET') { quotaCalls++; return reply(res, 200, limits({ five_hour: 0, weekly: 0, monthly: 100 })); }
    chatCalls++; reply(res, 429, { error: { code: 'account_quota_exhausted', message: 'account quota exhausted' } });
  });
  assert.equal((await refresh(s)).data.refreshed, 1);
  assert.equal((await row(s)).quota.status, 'fresh');
  assert.equal((await chat(s)).status, 429);
  await waitFor(async () => (await row(s)).state?.protectionMonthlyAt, 'monthly ban after complete exhausted snapshot');
  assert.equal(quotaCalls, 2);
  assert.equal((await chat(s)).status, 503);
  assert.equal(chatCalls, 1);
});

test('one quota-failed account is skipped while a healthy account serves; one protection job per account', async (t) => {
  let failedChatCalls = 0, healthyChatCalls = 0, failedQuotaCalls = 0;
  const s = await setup(t, (req,res) => {
    if (req.method === 'GET') { failedQuotaCalls++; return setTimeout(() => reply(res,200,limits({monthly:100})),100); }
    if (req.headers.authorization === 'Bearer local-a') { failedChatCalls++; return reply(res,429,{error:{code:'account_quota_exhausted',message:'account quota exhausted'}}); }
    healthyChatCalls++; reply(res,200,{choices:[{message:{content:'ok'}}]});
  }, [account('a'),account('b')]);
  assert.equal((await chat(s)).status, 200, 'pre-output replacement uses the other account once');
  const results = await Promise.all(Array.from({length:8}, () => chat(s)));
  assert.ok(results.every((result) => result.status === 200));
  await waitFor(async () => (await row(s,'a')).state?.protectionMonthlyAt, 'a banned');
  assert.equal(failedChatCalls,1); assert.equal(failedQuotaCalls,1);
  assert.ok(healthyChatCalls >= 9);
  assert.equal((await chat(s)).status, 200); assert.equal(failedChatCalls,1);
});

test('malformed persisted protection state and threshold fail startup without overwriting operator bytes', async (t) => {
  const s = await setup(t, (_req,res) => reply(res, 200, {}));
  await s.stop();
  const metaFile = path.join(s.dir, 'metadata.json'), configFile = path.join(s.dir, 'config.json');
  const meta = fs.readFileSync(metaFile, 'utf8'), config = fs.readFileSync(configFile, 'utf8');
  for (const invalid of [ { protectionShortAt:Date.now(), protectionShortWindows:null }, { protectionMonthlyAt:-1 }, { protectionShortAt:Date.now(), protectionShortWindows:['five_hour','five_hour'] }, { protectionFutureOwner:true } ]) {
    const value = JSON.parse(meta); value.accountStates.a = invalid;
    const bytes = JSON.stringify(value); fs.writeFileSync(metaFile, bytes);
    await assert.rejects(s.start(), /invalid account quota disposition/);
    assert.equal(fs.readFileSync(metaFile, 'utf8'), bytes);
  }
  fs.writeFileSync(metaFile, meta);
  const candidate = JSON.parse(config); candidate.quotaProtection = {monthlyThresholdUsd:0.001};
  const invalidConfig = JSON.stringify(candidate); fs.writeFileSync(configFile, invalidConfig);
  await assert.rejects(s.start(), /quotaProtection.monthlyThresholdUsd/);
  assert.equal(fs.readFileSync(configFile, 'utf8'), invalidConfig);
  fs.writeFileSync(configFile, config); await s.start();
});

test('provider, HTTP 200 and missing-month failures cannot ban; failed verification expires without durable ban', async (t) => {
  let mode = 'provider', quotaMode = 'failure', calls = 0;
  const s = await setup(t, (req,res) => {
    if (req.method === 'GET') return reply(res, quotaMode === 'failure' ? 500 : 200, quotaMode === 'failure' ? {} : limits({ five_hour:0, weekly:0 }));
    calls++;
    if (mode === 'provider') return reply(res, 429, { error:{ message:'provider rate limited' } });
    if (mode === 'envelope') return reply(res, 200, { error:{ code:'account_quota_exhausted', message:'account quota exhausted' } });
    reply(res, 429, { error:{ code:'account_quota_exhausted', message:'account quota exhausted' } });
  });
  assert.equal((await chat(s)).status, 429); mode = 'envelope'; assert.equal((await chat(s)).status, 502);
  assert.equal((await row(s)).state?.protectionMonthlyAt || 0, 0);
  mode = 'account'; assert.equal((await chat(s)).status, 429);
  await waitFor(async () => (await request(s, '/api/statistics')).data.accounts[0].quota.errorCategory === 'server', 'failed quota verification');
  assert.equal((await row(s)).state?.protectionMonthlyAt || 0, 0);
  quotaMode = 'partial'; await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal((await chat(s)).status, 429);
  await waitFor(async () => (await request(s, '/api/statistics')).data.accounts[0].quota.limits?.weekly?.percentUsed === 0, 'partial new success');
  assert.equal((await row(s)).state?.protectionMonthlyAt || 0, 0);
  assert.ok(calls >= 4);
});

test('post-start SSE quota-looking events never trigger the real-HTTP-429 ban or replay', async (t) => {
  let mode = 'post', chatCalls = 0, quotaCalls = 0;
  const s = await setup(t, (req,res) => {
    if (req.method === 'GET') { quotaCalls++; return reply(res,200,limits({monthly:99.9})); }
    chatCalls++;
    if (mode === 'pre') return reply(res,429,{error:{code:'account_quota_exhausted',message:'account quota exhausted'}});
    res.writeHead(200,{'Content-Type':'text/event-stream'});
    res.end('data: {"choices":[{"delta":{"content":"started"}}]}\n\ndata: {"error":{"code":"account_quota_exhausted","message":"account quota exhausted","status":429}}\n\ndata: [DONE]\n\n');
  });
  const stream = await fetch(`http://127.0.0.1:${s.port}/v1/chat/completions`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({model:'m',messages:[],stream:true}) });
  assert.equal(stream.status,200); assert.match(await stream.text(),/started/);
  assert.equal(chatCalls,1); assert.equal(quotaCalls,0); assert.equal((await row(s)).state?.protectionMonthlyAt || 0,0);
  mode = 'pre';
  const failed = await fetch(`http://127.0.0.1:${s.port}/v1/chat/completions`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({model:'m',messages:[],stream:true}) });
  assert.equal(failed.status,429); await failed.text();
  await waitFor(async () => (await row(s)).state?.protectionMonthlyAt, 'pre-output real 429 ban');
  assert.equal(chatCalls,2); assert.equal(quotaCalls,1);
});

test('a disabled held account does not refresh until re-enabled, retaining its short-window evidence', async (t) => {
  let quotaCalls = 0, used = 100;
  const s = await setup(t, (req, res) => {
    if (req.method === 'GET') { quotaCalls++; return reply(res, 200, limits({ five_hour: used, weekly: 0, monthly: 0 })); }
    reply(res, 200, { choices: [{ message: { content: 'ok' } }] });
  });
  await refresh(s);
  assert.deepEqual((await row(s)).state.protectionShortWindows, ['five_hour']);
  const disable = (await request(s)).data;
  assert.equal((await request(s, '/api/accounts', { accounts: disable.accounts.map((a) => ({ ...a, enabled: false })), mode: disable.mode, active: 0, concurrencyWaitMs: 0 })).status, 200);
  const calls = quotaCalls;
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(quotaCalls, calls);
  assert.deepEqual((await row(s)).state.protectionShortWindows, ['five_hour']);
  used = 0;
  const enable = (await request(s)).data;
  assert.equal((await request(s, '/api/accounts', { accounts: enable.accounts.map((a) => ({ ...a, enabled: true })), mode: enable.mode, active: 0, concurrencyWaitMs: 0 })).status, 200);
  await waitFor(async () => quotaCalls > calls && !(await row(s)).state?.protectionShortAt, 're-enabled held account refresh');
  assert.equal((await chat(s)).status, 200);
});

test('5h and week holds require fresh complete all-window recovery and survive restart without releasing on first reset', async (t) => {
  const first = Date.now() + 1600, second = Date.now() + 3100;
  let quotaCalls = 0, chatCalls = 0, monthlyExhausted = true;
  const s = await setup(t, (req,res) => {
    if (req.method === 'GET') {
      quotaCalls++;
      return reply(res, 200, limits({ five_hour:{ used:Date.now() < first ? 100 : 0, reset:new Date(first).toISOString() }, weekly:{ used:Date.now() < second ? 100 : 0, reset:new Date(second).toISOString() }, monthly:Date.now() >= second && monthlyExhausted ? 100 : 0 }));
    }
    chatCalls++; reply(res, 200, { choices:[{ message:{content:'ok'} }] });
  });
  await refresh(s);
  await waitFor(async () => (await row(s)).state?.protectionShortWindows?.length === 2, 'two exhausted windows');
  assert.equal((await chat(s)).status, 503); assert.equal(chatCalls, 0);
  await s.stop(); await s.start();
  assert.equal((await chat(s)).status, 503);
  await waitFor(async () => quotaCalls >= 2 && Date.now() > first + 100, 'first reset refresh', 4000);
  assert.equal((await chat(s)).status, 503, 'week remains exhausted');
  await waitFor(async () => quotaCalls >= 3 && Date.now() > second + 100 && (await row(s)).quota.limits?.weekly?.percentUsed === 0, 'weekly recovery', 6000);
  assert.equal((await chat(s)).status, 503, 'monthly window still exhausted');
  assert.equal((await row(s)).state?.protectionMonthlyAt || 0, 0, 'no monthly manual ban without a real quota 429');
  monthlyExhausted = false;
  await refresh(s);
  await waitFor(async () => !(await row(s)).state?.protectionShortAt, 'complete recovery', 6000);
  assert.equal((await chat(s)).status, 200); assert.equal(chatCalls, 1);
});
