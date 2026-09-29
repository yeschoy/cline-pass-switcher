import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { prepareAdminFixture, connectAdminFixture, fixtureHeaders } from './admin-fixture.js';
import { defaultAccountWorkflow } from '../lib/account-workflow.js';

const model = 'cline-pass/deepseek-v4.1-flash';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const listen = server => new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(server.address().port)); });
async function freePort() { const server = net.createServer(); const port = await listen(server); await new Promise(resolve => server.close(resolve)); return port; }
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([new Promise(resolve => child.once('exit', resolve)), sleep(1500)]);
  if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await new Promise(resolve => child.once('exit', resolve)); }
}
function success(res, content = 'OK') {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.end(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`);
}
async function fixture(t, { count = 3, cap = 7, configure = c => c, onChat, metadata } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cps-workflow-'));
  const seen = [], held = new Set(), children = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      if (req.method === 'GET') { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ success: true, data: { limits: ['five_hour', 'weekly', 'monthly'].map(type => ({ type, percentUsed: 1 })) } })); }
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const entry = { account: req.headers.authorization.replace('Bearer fixture-', ''), provider: body.providerOptions?.gateway?.only?.[0] || body.provider?.only?.[0], body };
      seen.push(entry);
      if (onChat) onChat(entry, res, { held, seen }); else success(res);
    });
  });
  const upstreamPort = await listen(upstream);
  let cfg = configure({
    port: await freePort(), proxyKey: 'fixture-client', upstreamBase: `http://127.0.0.1:${upstreamPort}/api/v1`,
    accounts: Array.from({ length: count }, (_, index) => ({ id: `a${index}`, name: `Account ${index}`, key: `fixture-a${index}`, clientKeyId: 'legacy', enabled: true, maxConcurrent: cap, maxRpm: 0, perModel: {} })),
    accountMode: 'sticky', concurrencyWaitMs: 0, poolFullWaitMs: 0,
    accountPipeline: { quotaPool: true, healthSort: true, sticky: true, order: ['healthSort', 'quotaPool', 'sticky'], cachePoolSize: count, cachePoolMaxSize: count, cachePoolLowQuotaSize: 0 },
    accountWorkflow: { ...defaultAccountWorkflow(), enabled: true },
    perModel: { [model]: { upstreams: ['first'], pinMode: 'strict', maxRetries: 1 } },
    errorRules: [], retryRules: [], detailedLogging: false, errorDetailLogging: false, errorDetailMigrationVersion: 1,
  });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg));
  if (metadata) fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify(metadata));
  prepareAdminFixture(dir);
  const state = { dir, cfg, seen, held, upstream, child: null, port: cfg.port };
  state.start = async () => {
    const child = spawn(process.execPath, ['server.js'], { cwd: path.resolve('.'), env: { PATH: process.env.PATH, NODE_ENV: 'test', BIND_HOST: '127.0.0.1', DATA_DIR: dir, PORT: String(state.port) }, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child); state.child = child;
    let output = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
    for (let i = 0; i < 250; i++) {
      if (child.exitCode !== null) throw new Error(`fixture startup exited: ${output}`);
      if (output.includes('OpenAI 兼容代理地址')) { await connectAdminFixture(state.port); return; }
      await sleep(20);
    }
    throw new Error(`fixture startup timeout: ${output}`);
  };
  state.restart = async () => { await stop(state.child); await state.start(); };
  state.admin = async (route, body) => {
    const method = body === undefined ? 'GET' : 'POST';
    const response = await fetch(`http://127.0.0.1:${state.port}${route}`, { method, headers: fixtureHeaders(state.port, route, method, body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  state.chat = async (session, key = 'fixture-client') => {
    const response = await fetch(`http://127.0.0.1:${state.port}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body: JSON.stringify({ model, session_id: session, stream: true, messages: [{ role: 'user', content: 'Synthetic workflow request' }], max_completion_tokens: 16 }) });
    const text = await response.text();
    return { status: response.status, text, requestId: response.headers.get('x-cline-request-id'), success: response.ok && text.includes('[DONE]') };
  };
  state.counts = () => JSON.parse(fs.readFileSync(path.join(dir, 'metadata.json'), 'utf8')).selectionCounters?.accounts || {};
  state.total = () => Object.values(state.counts()).reduce((sum, row) => sum + row.count, 0);
  t.after(async () => { for (const res of held) res.destroy(); for (const child of children) await stop(child); upstream.closeAllConnections?.(); await new Promise(resolve => upstream.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); });
  await state.start(); return state;
}

test('workflow distributes new selections and direct binding hits never increment', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 9; i++) assert.equal((await f.chat(`new-${i}`)).success, true);
  assert.equal(f.total(), 9);
  assert.deepEqual(Object.values(f.counts()).map(row => row.count).sort(), [3, 3, 3]);
  const firstAccount = f.seen[0].account, before = f.counts();
  for (let i = 0; i < 5; i++) assert.equal((await f.chat('new-0')).success, true);
  assert.deepEqual(f.counts(), before);
  assert.ok(f.seen.slice(-5).every(row => row.account === firstAccount));
  const view = await f.admin('/api/accounts');
  assert.ok(view.body.accounts.every(account => account.activeCount === 0));
});

test('workflow unknown health is eligible at100 without falsifying observed samples', async t => {
  const f = await fixture(t, { configure: c => ({ ...c, accountWorkflow: { ...c.accountWorkflow, healthFilter: true, minimumHealth: .95 } }) });
  assert.equal((await f.chat('unsampled')).success, true);
  assert.equal(f.total(), 1);
  const view = await f.admin('/api/accounts');
  const untouched = view.body.accounts.filter(a => a.id !== f.seen[0].account);
  assert.ok(untouched.every(a => a.health.successRate === null && a.health.samples === 0));
});

test('workflow concurrent admissions obey caps and count only actual overflow selections', async t => {
  const peaks = new Map(), active = new Map();
  const f = await fixture(t, { count: 3, cap: 2, onChat(entry, res, { held }) {
    active.set(entry.account, (active.get(entry.account) || 0) + 1);
    peaks.set(entry.account, Math.max(peaks.get(entry.account) || 0, active.get(entry.account)));
    res.once('close', () => active.set(entry.account, active.get(entry.account) - 1));
    res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write('data: {"choices":[{"delta":{"content":"held"}}]}\n\n'); held.add(res);
  } });
  const pending = Array.from({ length: 6 }, (_, i) => f.chat(`parallel-${i}`));
  for (let i = 0; i < 100 && f.seen.length < 6; i++) await sleep(10);
  assert.equal(f.seen.length, 6);
  assert.equal(f.total(), 6);
  assert.deepEqual([...peaks.values()].sort(), [2, 2, 2]);
  const blocked = await f.chat('overflow-blocked');
  assert.equal(blocked.status, 429); assert.equal(f.total(), 6); assert.equal(f.seen.length, 6);
  for (const res of f.held) res.end('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  assert.ok((await Promise.all(pending)).every(row => row.success));
});

test('workflow43 accounts reserve258 leases without account overcommit; default256 sockets queue two', async t => {
  let release = false;
  const f = await fixture(t, { count: 43, cap: 6, onChat(_entry, res, { held }) {
    if (release) return success(res);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"held"}}]}\n\n'); held.add(res);
  } });
  const started = performance.now();
  const pending = Array.from({ length: 258 }, (_, i) => f.chat(`capacity43-${i}`));
  for (let i = 0; i < 1000 && (f.total() < 258 || f.seen.length < 256); i++) await sleep(10);
  assert.equal(f.total(), 258);
  assert.equal(f.seen.length, 256, 'direct Agent default is256 sockets per origin');
  const view = (await f.admin('/api/accounts')).body;
  assert.equal(view.accounts.length, 43);
  assert.ok(view.accounts.every(a => a.activeCount === 6 && a.selectionCount === 6));
  assert.equal((await f.chat('full43')).status, 429);
  assert.equal(f.total(), 258);
  const reserveMs = performance.now() - started;
  release = true;
  for (const res of f.held) res.end('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  assert.ok((await Promise.all(pending)).every(row => row.success));
  assert.equal(f.seen.length, 258);
  t.diagnostic(`synthetic43x6:258 leases,256 direct sockets, reserve-check ${reserveMs.toFixed(1)}ms; metadata ${fs.statSync(path.join(f.dir, 'metadata.json')).size} bytes after completion. Not a production capacity measurement.`);
});

test('workflow busy bound account temporarily overflows and counts only the new choice', async t => {
  let hold = false;
  const f = await fixture(t, { count: 2, cap: 1, onChat(_entry, res, { held }) { if (!hold) return success(res); res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write('data: {"choices":[{"delta":{"content":"held"}}]}\n\n'); held.add(res); } });
  await f.chat('sticky'); const original = f.seen[0].account; assert.equal(f.total(), 1);
  hold = true; const first = f.chat('sticky');
  for (let i = 0; i < 100 && f.seen.length < 2; i++) await sleep(10);
  const second = f.chat('sticky');
  for (let i = 0; i < 100 && f.seen.length < 3; i++) await sleep(10);
  assert.equal(f.seen[1].account, original); assert.notEqual(f.seen[2].account, original);
  assert.equal(f.total(), 2);
  for (const res of f.held) res.end('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  await Promise.all([first, second]); hold = false;
  await f.chat('sticky'); assert.equal(f.seen.at(-1).account, original); assert.equal(f.total(), 2);
});

test('workflow replacement increments another account but Provider retry does not', async t => {
  const f = await fixture(t, { configure: c => ({ ...c, errorRules: [{ id: 'fixture429', scope: 'account', action: 'cooldown', when: { statuses: [429] }, reset: { fallback: '10s', max: '10s' } }] }), onChat(_entry, res, { seen }) { if (seen.length === 1) { res.writeHead(429, { 'Content-Type': 'text/html' }); res.end('shared fixture rejection'); } else success(res); } });
  assert.equal((await f.chat('replacement')).success, true);
  assert.equal(f.seen.length, 2); assert.notEqual(f.seen[0].account, f.seen[1].account); assert.equal(f.total(), 2);

  const g = await fixture(t, { configure: c => ({ ...c, perModel: { [model]: { upstreams: ['first', 'second'], pinMode: 'strict', maxRetries: 1 } } }), onChat(entry, res) { if (entry.provider === 'first') { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end('{"error":{"message":"temporary provider failure"}}'); } else success(res); } });
  assert.equal((await g.chat('provider-retry')).success, true);
  assert.equal(g.seen.length, 2); assert.equal(g.seen[0].account, g.seen[1].account); assert.equal(g.total(), 1);
});

test('workflow counters survive restart and stable-ID account edits', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 5; i++) await f.chat(`persist-${i}`);
  const before = f.counts(); assert.equal(f.total(), 5);
  await f.restart(); assert.deepEqual(f.counts(), before);
  const view = (await f.admin('/api/accounts')).body;
  const payload = { accounts: view.accounts.map((a, i) => ({ ...a, name: i === 0 ? 'renamed' : a.name, enabled: i !== 0 })), mode: view.mode, active: view.active, concurrencyWaitMs: view.concurrencyWaitMs, accountPipeline: view.accountPipeline };
  assert.equal((await f.admin('/api/accounts', payload)).status, 200);
  assert.deepEqual(f.counts(), before);
  payload.accounts[0].enabled = true;
  assert.equal((await f.admin('/api/accounts', payload)).status, 200);
  await f.restart(); assert.deepEqual(f.counts(), before);
});

test('workflow never selects foreign or disabled accounts', async t => {
  const f = await fixture(t, { count: 4, configure: c => ({ ...c, clientKeys: [{ id: 'tenant-b', name: 'Tenant B', key: 'fixture-client-b' }], accounts: c.accounts.map((a, i) => ({ ...a, clientKeyId: i >= 2 ? 'tenant-b' : 'legacy', enabled: i !== 1 })) }) });
  for (let i = 0; i < 4; i++) await f.chat(`owner-a-${i}`);
  assert.ok(f.seen.every(row => row.account === 'a0'));
  for (let i = 0; i < 4; i++) await f.chat(`owner-b-${i}`, 'fixture-client-b');
  assert.ok(f.seen.slice(4).every(row => ['a2', 'a3'].includes(row.account)));
  assert.equal(f.total(), 8); assert.equal(f.counts().a1, undefined);
});

test('workflow newly added account starts at zero and catches up without rebasing old counts', async t => {
  const f = await fixture(t, { count: 2 });
  for (let i = 0; i < 6; i++) await f.chat(`old-${i}`);
  const before = f.counts(); assert.equal(before.a0.count, 3); assert.equal(before.a1.count, 3);
  const view = (await f.admin('/api/accounts')).body;
  const accounts = [...view.accounts, { name: 'New account', key: 'fixture-new', enabled: true, maxConcurrent: 7, maxRpm: 0, perModel: {} }];
  assert.equal((await f.admin('/api/accounts', { accounts, mode: view.mode, active: view.active, concurrencyWaitMs: 0, accountPipeline: { ...view.accountPipeline, cachePoolSize: 3, cachePoolMaxSize: 3 } })).status, 200);
  const newAccount = (await f.admin('/api/accounts')).body.accounts.find(a => a.name === 'New account');
  assert.equal(f.counts()[newAccount.id], undefined);
  await f.chat('new-entrant'); assert.equal(f.seen.at(-1).account, 'new');
  assert.equal(f.counts()[newAccount.id].count, 1);
  assert.equal(f.counts().a0.count, 3); assert.equal(f.counts().a1.count, 3);
});

test('workflow metadata write failure keeps live counting and releases model leases', async t => {
  const f = await fixture(t);
  const filename = path.join(f.dir, 'metadata.json'), original = fs.readFileSync(filename);
  fs.renameSync(filename, filename + '.fixture-backup'); fs.mkdirSync(filename);
  try {
    assert.equal((await f.chat('write-failure')).success, true);
    assert.ok((await f.admin('/api/accounts')).body.accounts.every(a => a.activeCount === 0));
  } finally { fs.rmdirSync(filename); fs.writeFileSync(filename, original); }
  // A binding hit is not a new selection; subsequent ordinary persistence recovers the one live count.
  await f.chat('write-failure'); assert.equal(f.total(), 1);
  await f.restart(); assert.equal(f.total(), 1);
});

function accountSave(view, patch = {}) {
  return { accounts: view.accounts, mode: view.mode, active: view.active, concurrencyWaitMs: view.concurrencyWaitMs,
    poolFullWaitMs: view.poolFullWaitMs, accountPipeline: view.accountPipeline,
    accountWorkflow: view.accountWorkflow, expectedConfigurationRevision: view.configurationRevision, ...patch };
}

test('workflow API projects effective health and rejects invalid/stale saves without losing fields', async t => {
  const f = await fixture(t, { configure: c => ({ ...c, accounts: c.accounts.map(a => ({ ...a, note: 'retained note', headers: { 'X-Fixture': 'retained-header' }, perModel: { 'other-model': { upstreams: ['one'], pinMode: 'strict' } } })) }) });
  const view = (await f.admin('/api/accounts')).body;
  assert.equal(view.accountWorkflow.enabled, true); assert.match(view.configurationRevision, /^[a-f0-9]{64}$/);
  assert.ok(view.accounts.every(a => a.selectionCount === 0 && a.effectiveRoutingHealth === 1 && a.health.successRate === null));
  const before = fs.readFileSync(path.join(f.dir, 'config.json'), 'utf8');
  assert.equal((await f.admin('/api/accounts', accountSave(view, { accountWorkflow: { ...view.accountWorkflow, injected: 'bad' } }))).status, 400);
  assert.equal(fs.readFileSync(path.join(f.dir, 'config.json'), 'utf8'), before);
  const changed = accountSave(view, { accountWorkflow: { ...view.accountWorkflow, missSteps: ['health', 'quota'] } });
  assert.equal((await f.admin('/api/accounts', changed)).status, 200);
  const latest = (await f.admin('/api/accounts')).body;
  assert.notEqual(latest.configurationRevision, view.configurationRevision);
  assert.equal((await f.admin('/api/accounts', accountSave(view))).status, 409);
  assert.ok(latest.accounts.every(a => a.note === 'retained note' && a.headers['X-Fixture'] === 'retained-header' && a.perModel['other-model'].upstreams[0] === 'one'));
  const compatible = accountSave(latest); delete compatible.accountWorkflow;
  assert.equal((await f.admin('/api/accounts', compatible)).status, 200);
  assert.deepEqual((await f.admin('/api/accounts')).body.accountWorkflow, latest.accountWorkflow);
});

test('workflow preview traces decisions but never calls upstream or changes count/binding state', async t => {
  const f = await fixture(t);
  const view = (await f.admin('/api/accounts')).body;
  const before = f.counts(), requests = f.seen.length, binding = view.cachePool.binding;
  const preview = await f.admin('/api/account-workflow/preview', { accountWorkflow: { ...defaultAccountWorkflow(), enabled: true }, clientKeyId: 'legacy' });
  assert.equal(preview.status, 200); assert.equal(preview.body.simulation, true);
  assert.equal(preview.body.decision.counted, true); assert.equal(preview.body.decision.countBefore, 0); assert.equal(preview.body.decision.countAfter, 1);
  assert.ok(preview.body.decision.nodes.some(node => node.node === 'selector'));
  assert.equal(f.seen.length, requests); assert.deepEqual(f.counts(), before);
  assert.deepEqual((await f.admin('/api/accounts')).body.cachePool.binding, binding);
  const hit = await f.admin('/api/account-workflow/preview', { accountWorkflow: { ...defaultAccountWorkflow(), enabled: true }, clientKeyId: 'legacy', boundAccountId: 'a1' });
  assert.equal(hit.status, 200); assert.equal(hit.body.decision.kind, 'binding-hit'); assert.equal(hit.body.decision.counted, false);
  assert.equal(hit.body.decision.countAfter, 0); assert.equal(f.total(), 0);
  const actual = await f.chat('after-preview'); assert.equal(actual.success, true);
  assert.equal(f.seen.at(-1).account, preview.body.decision.accountId);
});

test('workflow preview is owner-scoped and forbidden to model-only credentials', async t => {
  const f = await fixture(t, { count: 2, configure: c => ({ ...c, clientKeys: [{ id: 'tenant-b', name: 'Tenant B', key: 'fixture-client-b' }], accounts: c.accounts.map((a, i) => ({ ...a, clientKeyId: i ? 'tenant-b' : 'legacy' })) }) });
  const body = { accountWorkflow: { ...defaultAccountWorkflow(), enabled: true }, clientKeyId: 'legacy', boundAccountId: 'a1' };
  assert.equal((await f.admin('/api/account-workflow/preview', body)).status, 400);
  const denied = await fetch(`http://127.0.0.1:${f.port}/api/account-workflow/preview`, { method: 'POST', headers: { Authorization: 'Bearer fixture-client', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(denied.status, 401); assert.equal(f.seen.length, 0); assert.equal(f.total(), 0);
});

test('workflow quota node role filter is applied in preview and runtime without changing pool membership', async t => {
  const f = await fixture(t, { configure: c => ({ ...c, accountWorkflow: { ...c.accountWorkflow, quotaPools: ['warm'] } }) });
  const preview = await f.admin('/api/account-workflow/preview', { accountWorkflow: { ...defaultAccountWorkflow(), enabled: true, quotaPools: ['warm'] }, clientKeyId: 'legacy' });
  assert.equal(preview.status, 200); assert.equal(preview.body.decision.kind, 'filtered');
  assert.equal(preview.body.decision.nodes.find(n => n.node === 'quota').after, 0);
  assert.equal((await f.chat('filtered-quota')).status, 503);
  assert.equal(f.total(), 0); assert.equal(f.seen.length, 0);
  const view = (await f.admin('/api/accounts')).body;
  assert.equal((await f.admin('/api/accounts', accountSave(view, { accountWorkflow: { ...view.accountWorkflow, quotaFilter: false } }))).status, 200);
  assert.equal((await f.chat('quota-node-disabled')).success, true); assert.equal(f.total(), 1);
});

test('workflow reset affects only the requested owner and leaves bindings/caps intact', async t => {
  const f = await fixture(t, { count: 4, configure: c => ({ ...c, clientKeys: [{ id: 'tenant-b', name: 'Tenant B', key: 'fixture-client-b' }], accounts: c.accounts.map((a, i) => ({ ...a, clientKeyId: i >= 2 ? 'tenant-b' : 'legacy' })) }) });
  await f.chat('owner-a'); await f.chat('owner-b', 'fixture-client-b');
  const view = (await f.admin('/api/accounts')).body, before = f.counts();
  const reset = await f.admin('/api/account-workflow/reset-counts', { clientKeyId: 'legacy', expectedConfigurationRevision: view.configurationRevision });
  assert.equal(reset.status, 200); assert.equal(reset.body.resetAccounts, 2);
  const after = f.counts(); assert.equal((after.a0?.count || 0) + (after.a1?.count || 0), 0);
  assert.equal((after.a2?.count || 0) + (after.a3?.count || 0), (before.a2?.count || 0) + (before.a3?.count || 0));
  const bindings = (await f.admin('/api/accounts')).body.cachePool.binding;
  assert.equal(bindings.size, view.cachePool.binding.size);
  await f.chat('owner-a'); assert.equal(f.total(), 1, 'reset must not clear the original binding, so its hit stays uncounted');
  await f.restart(); assert.equal(f.total(), 1);
});

test('workflow reset failure preserves live counts and stale reset is rejected', async t => {
  const f = await fixture(t); await f.chat('reset-fail');
  const view = (await f.admin('/api/accounts')).body;
  assert.equal((await f.admin('/api/account-workflow/reset-counts', { clientKeyId: 'legacy', expectedConfigurationRevision: '0'.repeat(64) })).status, 409);
  const filename = path.join(f.dir, 'metadata.json'), original = fs.readFileSync(filename);
  fs.renameSync(filename, filename + '.fixture-backup'); fs.mkdirSync(filename);
  try { assert.equal((await f.admin('/api/account-workflow/reset-counts', { clientKeyId: 'legacy', expectedConfigurationRevision: view.configurationRevision })).status, 500); }
  finally { fs.rmdirSync(filename); fs.writeFileSync(filename, original); }
  const latest = (await f.admin('/api/accounts')).body;
  assert.equal(latest.accounts.reduce((n, a) => n + a.selectionCount, 0), 1);
  assert.ok(latest.accounts.every(a => a.activeCount === 0));
});

test('workflow ordinary logs distinguish counted selections from hits without leaking identities', async t => {
  const f = await fixture(t);
  const first = await f.chat('private-session-value'), hit = await f.chat('private-session-value');
  const rows = (await f.admin('/api/logs/requests?limit=200')).body.items;
  const selected = rows.find(row => row.requestId === first.requestId), reused = rows.find(row => row.requestId === hit.requestId);
  assert.equal(selected.workflow.decisions[0].kind, 'new-selection'); assert.equal(selected.workflow.decisions[0].countAfter, 1);
  assert.equal(reused.workflow.decisions[0].kind, 'binding-hit'); assert.equal(reused.workflow.decisions[0].counted, false);
  assert.ok(!JSON.stringify(rows).includes('private-session-value'));
  assert.ok(!JSON.stringify(selected.workflow).includes('fixture-'));
});
