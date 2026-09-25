import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const legacyKey = 'synthetic-legacy-client-123', adminPassword = 'synthetic-independent-admin-123';
const upstreamKeys = { legacy: 'synthetic-upstream-legacy', team: 'synthetic-upstream-team' };
const mimo = 'cline-pass/mimo-v2.5', deepseek = 'cline-pass/deepseek-v4.1-flash';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = (server) => new Promise((resolve) => server.close(resolve));
async function waitFor(check, label) {
  for (let i = 0; i < 150; i++) { const result = await check(); if (result) return result; await sleep(20); }
  throw new Error(`timed out: ${label}`);
}
async function request(port, route, { method = 'GET', body, key, cookie, csrf } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(cookie ? { Cookie: cookie } : {}),
      ...(csrf ? { 'X-CSRF-Token': csrf } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let json; try { json = JSON.parse(text); } catch {}
  return { status: response.status, text, json, cookie: response.headers.get('set-cookie')?.split(';')[0], requestId: response.headers.get('x-cline-request-id') };
}
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
  try { await exited; } finally { clearTimeout(timer); }
}

// The fixture is an old configuration: both stable IDs predate clientKeyId.
// No production state, live endpoint or operator secret is read by this test.
test('legacy migration, exclusive same-session routing, v2 final usage and sanitized diagnostics coexist', { timeout: 15000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cps-pricing-key-'));
  const attempts = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) { res.writeHead(404); res.end(); return; }
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const provider = body.providerOptions?.gateway?.only?.[0] || body.provider?.only?.[0];
      attempts.push({ authorization: req.headers.authorization, model: body.model, provider, session: body.session_id });
      res.setHeader('Content-Type', 'application/json');
      if (provider === 'first') {
        res.writeHead(500);
        res.end(JSON.stringify({ error: { message: 'first provider failed', status: 500, provider: 'first' } }));
        return;
      }
      res.end(JSON.stringify({ choices: [{ message: { content: 'ok', provider_metadata: { gateway: { routing: { finalProvider: provider } } } } }],
        usage: { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 3 } } }));
    });
  });
  let child;
  t.after(async () => { await stop(child); upstream.closeAllConnections?.(); await close(upstream); fs.rmSync(dir, { recursive: true, force: true }); });
  const upstreamPort = await listen(upstream);
  const probe = http.createServer(), port = await listen(probe); await close(probe);
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    proxyKey: legacyKey, upstreamBase: `http://127.0.0.1:${upstreamPort}`, detailedLogging: true,
    accounts: [
      { id: 'old-a', name: 'Old A', key: upstreamKeys.legacy, perModel: {} },
      { id: 'old-b', name: 'Old B', key: upstreamKeys.team, perModel: {} },
    ], accountMode: 'sticky', activeAccount: 0, concurrencyWaitMs: 0,
    knownModels: [mimo, deepseek], perModel: { [mimo]: { upstreams: ['first', 'second'], pinMode: 'strict' }, [deepseek]: { upstreams: ['second'], pinMode: 'strict' } },
  }));
  const salt = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(path.join(dir, 'admin-auth.json'), JSON.stringify({ version: 1, initialized: true, salt,
    hash: crypto.scryptSync(adminPassword, Buffer.from(salt, 'hex'), 64).toString('hex') }), { mode: 0o600 });
  const start = async () => {
    child = spawn(process.execPath, ['server.js'], { cwd: path.resolve('.'), env: {
      ...process.env, DATA_DIR: dir, PORT: String(port), BIND_HOST: '127.0.0.1', NODE_ENV: 'test',
      PROXY_KEY: '', CLINE_PASS_KEY: '', PUBLIC_BASE_URL: '', CLINE_PASS_ADMIN_BOOTSTRAP: '',
    }, stdio: 'ignore' });
    await waitFor(async () => {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error('synthetic server exited before ready');
      try { return (await request(port, '/api/meta')).status === 200; } catch { return false; }
    }, 'synthetic server readiness');
  };
  await start();

  const migrated = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  assert.deepEqual(migrated.accounts.map(({ id, clientKeyId }) => [id, clientKeyId]), [['old-a', 'legacy'], ['old-b', 'legacy']]);
  const login = await request(port, '/api/auth/login', { method: 'POST', body: { password: adminPassword } });
  assert.equal(login.status, 200);
  assert.ok(login.cookie && login.json.csrf, 'independent admin Cookie and CSRF are issued');
  const manage = (route, method = 'GET', body) => request(port, route, { method, body, cookie: login.cookie, csrf: login.json.csrf });
  const created = await manage('/api/security/client-keys', 'POST', { name: 'Synthetic Team' });
  assert.equal(created.status, 200, 'client-key creation must succeed');
  const { id: teamId, key: teamKey } = created.json;
  assert.ok(/^ck_/.test(teamId), 'generated owner ID has the expected prefix');
  assert.ok(/^cps_[a-f0-9]{64}$/.test(teamKey), 'generated secret has the expected shape');
  const list = await manage('/api/security/client-keys');
  assert.equal(list.status, 200); assert.equal(list.text.includes(teamKey), false);
  const before = await manage('/api/accounts');
  assert.deepEqual(before.json.accounts.map((a) => a.clientKeyId), ['legacy', 'legacy']);
  const saved = await manage('/api/accounts', 'POST', {
    accounts: before.json.accounts.map((account) => account.id === 'old-b' ? { ...account, clientKeyId: teamId } : account),
    mode: 'sticky', active: 0, concurrencyWaitMs: 0,
  });
  assert.equal(saved.status, 200, 'complete account reassignment must succeed');
  const owners = await manage('/api/accounts');
  assert.deepEqual(owners.json.accounts.map(({ id, clientKeyId }) => [id, clientKeyId]), [['old-a', 'legacy'], ['old-b', teamId]]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).accounts.map(({ id, clientKeyId }) => [id, clientKeyId]), [['old-a', 'legacy'], ['old-b', teamId]]);
  assert.equal((await request(port, '/api/statistics', { key: teamKey })).status, 401, 'client key cannot administer');
  assert.equal((await request(port, '/v1/chat/completions', { method: 'POST', body: { model: mimo, messages: [] }, cookie: login.cookie })).status, 401, 'admin Cookie cannot select model accounts');
  assert.equal(attempts.length, 0, 'rejected requests cannot touch the upstream');

  const chat = (key, model, content) => request(port, '/v1/chat/completions', { method: 'POST', key,
    body: { model, session_id: 'same-synthetic-session', messages: [{ role: 'user', content }] } });
  const first = await chat(legacyKey, mimo, 'ordinary request');
  const second = await chat(teamKey, mimo, `synthetic body includes ${teamKey}`);
  const third = await chat(teamKey, deepseek, 'second priced model');
  for (const reply of [first, second, third]) assert.equal(reply.status, 200, 'each priced chat must succeed');
  const safeAttempts = attempts.map(({ authorization, ...attempt }) => ({
    ...attempt, credential: authorization === `Bearer ${upstreamKeys.legacy}` ? 'legacy'
      : authorization === `Bearer ${upstreamKeys.team}` ? 'team' : 'unexpected',
  }));
  assert.deepEqual(safeAttempts, [
    { model: mimo, provider: 'first', session: 'same-synthetic-session', credential: 'legacy' },
    { model: mimo, provider: 'second', session: 'same-synthetic-session', credential: 'legacy' },
    { model: mimo, provider: 'first', session: 'same-synthetic-session', credential: 'team' },
    { model: mimo, provider: 'second', session: 'same-synthetic-session', credential: 'team' },
    { model: deepseek, provider: 'second', session: 'same-synthetic-session', credential: 'team' },
  ], 'every real attempt has the correct owner’s upstream credential, not a downstream Bearer');
  const stats = await manage('/api/statistics');
  assert.equal(stats.status, 200);
  const v2 = 'clinepass-2026-09-25-v2';
  assert.equal(stats.json.referencePrices.current.version, v2);
  const byModel = (id) => stats.json.models.find((row) => row.id === id).providerStatistics;
  const mimoStats = byModel(mimo), deepseekStats = byModel(deepseek);
  assert.deepEqual([mimoStats.finalRequests.successes, mimoStats.finalRequests.failures, mimoStats.finalRequests.samples, mimoStats.finalRequests.successRate], [2, 0, 2, 1]);
  assert.deepEqual([mimoStats.usage.requests, mimoStats.usage.inputTokens, mimoStats.usage.outputTokens,
    mimoStats.usage.cacheInputCachedTokens, mimoStats.usage.inputKnownRequests, mimoStats.usage.cacheKnownRequests], [2, 20, 4, 6, 2, 2]);
  const firstProvider = mimoStats.providers.find((row) => row.id === 'first');
  const secondProvider = mimoStats.providers.find((row) => row.id === 'second');
  assert.equal(firstProvider.usage.requests, 0, 'failed retries have no final usage');
  assert.deepEqual([firstProvider.health.samples, firstProvider.health.degrades, firstProvider.health.successRate], [2, 2, 0]);
  assert.deepEqual([secondProvider.health.samples, secondProvider.health.successes, secondProvider.health.successRate, secondProvider.usage.requests], [2, 2, 1, 2]);
  assert.deepEqual([mimoStats.valuation.versions[v2].pricedRequests, mimoStats.valuation.versions[v2].lowPicoUsd, mimoStats.valuation.versions[v2].highPicoUsd], [2, 3096800, 3096800]);
  assert.deepEqual([deepseekStats.valuation.versions[v2].pricedRequests, deepseekStats.valuation.versions[v2].lowPicoUsd, deepseekStats.valuation.versions[v2].highPicoUsd], [1, 2259000, 4518000]);
  assert.equal(stats.json.recent24h.global.usageRequests, 3);

  const rows = await waitFor(async () => {
    const result = await manage('/api/logs/requests?limit=10');
    return result.status === 200 && result.json.items.length === 3 && result.json.items;
  }, 'three ordinary request rows');
  assert.deepEqual(rows.map((row) => row.accountId).sort(), ['old-a', 'old-b', 'old-b']);
  const errors = await waitFor(async () => {
    const result = await manage('/api/logs/errors?limit=10');
    return result.status === 200 && result.json.items.length === 2 && result.json.items;
  }, 'two real failed-attempt rows');
  assert.deepEqual(errors.map((row) => row.accountId).sort(), ['old-a', 'old-b']);
  const detail = await waitFor(async () => {
    const result = await manage(`/api/logs/details/${second.requestId}`);
    return result.status === 200 && result.json.request?.profile === 'full' && result.json;
  }, 'sanitized detailed capture');
  assert.ok(detail.request.requestBody, 'the diagnostic actually retained a sanitized request body');
  const detailBody = await manage(`/api/logs/details/${second.requestId}/bodies/${detail.request.requestBody}`);
  assert.equal(detailBody.status, 200);
  assert.ok(detailBody.text.includes('[REDACTED]'), 'caller-embedded key is visibly redacted');
  for (const descriptor of detail.bodies) {
    const body = await manage(`/api/logs/details/${second.requestId}/bodies/${descriptor.bodyId}`);
    assert.equal(body.status, 200);
    assert.equal(body.text.includes(teamKey), false, 'every retained sanitized diagnostic body excludes the generated key');
  }
  const persistedLogs = (directory) => fs.readdirSync(directory, { withFileTypes: true }).map((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? persistedLogs(file) : fs.readFileSync(file, 'utf8');
  }).join('');
  for (const name of ['logs', 'detailed-logs']) {
    const text = persistedLogs(path.join(dir, name));
    for (const [kind, secret] of Object.entries({ legacy: legacyKey, team: teamKey, upstreamLegacy: upstreamKeys.legacy, upstreamTeam: upstreamKeys.team })) {
      assert.equal(text.includes(secret), false, `${name} on disk excludes ${kind} credential`);
    }
  }
  for (const [label, text] of [
    ['public meta', (await request(port, '/api/meta')).text], ['statistics', stats.text],
    ['ordinary requests', JSON.stringify(rows)], ['ordinary errors', JSON.stringify(errors)],
    ['detail manifest', JSON.stringify(detail)], ['detail body', detailBody.text],
    ['runtime metadata', fs.readFileSync(path.join(dir, 'metadata.json'), 'utf8')],
  ]) {
    for (const [kind, secret] of Object.entries({ legacy: legacyKey, team: teamKey, upstreamLegacy: upstreamKeys.legacy, upstreamTeam: upstreamKeys.team })) {
      assert.equal(text.includes(secret), false, `${label} must not expose ${kind} credential`);
    }
  }
  assert.equal((await manage('/api/accounts')).status, 200, 'admin session remains valid after key creation and model traffic');

  await stop(child); child = null;
  await start();
  const restartedOwners = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).accounts;
  assert.deepEqual(restartedOwners.map(({ id, clientKeyId }) => [id, clientKeyId]), [['old-a', 'legacy'], ['old-b', teamId]]);
  assert.equal((await request(port, '/api/statistics', { cookie: login.cookie })).status, 401, 'old admin session cannot survive restart');
  const relogin = await request(port, '/api/auth/login', { method: 'POST', body: { password: adminPassword } });
  assert.equal(relogin.status, 200, 'the independent admin password survives restart');
  assert.equal((await request(port, '/v1/models', { key: legacyKey })).status, 200);
  assert.equal((await request(port, '/v1/models', { key: teamKey })).status, 200);
  const beforeRestartedChat = attempts.length;
  const resumed = await chat(teamKey, deepseek, 'post-restart priced usage');
  assert.equal(resumed.status, 200, 'extra key still routes after restart');
  assert.equal(attempts.length, beforeRestartedChat + 1);
  assert.equal(attempts.at(-1).authorization === `Bearer ${upstreamKeys.team}`, true, 'restart does not borrow the Legacy account');
  const resumedStats = await request(port, '/api/statistics', { cookie: relogin.cookie });
  assert.equal(resumedStats.status, 200);
  const resumedModel = resumedStats.json.models.find((row) => row.id === deepseek).providerStatistics;
  assert.deepEqual([resumedModel.finalRequests.successes, resumedModel.usage.requests,
    resumedModel.valuation.versions[v2].pricedRequests, resumedModel.valuation.versions[v2].lowPicoUsd,
    resumedModel.valuation.versions[v2].highPicoUsd], [2, 2, 2, 4518000, 9036000]);
});
