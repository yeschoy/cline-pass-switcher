import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { prepareAdminFixture, connectAdminFixture, installFixtureFetch } from './admin-fixture.js';
installFixtureFetch();

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = (server) => new Promise((resolve) => server.close(resolve));
async function waitFor(check, label, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out: ${label}`);
}
async function boot(dir, port) {
  prepareAdminFixture(dir);
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve('.'),
    env: { ...process.env, DATA_DIR: dir, PORT: String(port), BIND_HOST: '127.0.0.1', NODE_ENV: 'test',
      CLINE_PASS_TEST_SSE_HEARTBEAT_MS: '60', CLINE_PASS_TEST_SSE_STREAM_IDLE_MS: '1000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  await waitFor(() => {
    if (child.exitCode !== null) throw new Error(`switcher exited: ${output}`);
    return output.includes('OpenAI 兼容代理地址');
  }, 'switcher startup');
  await connectAdminFixture(port);
  return child;
}
async function stop(child) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  let timer;
  try { await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('shutdown did not drain')), 3000); })]); }
  finally { clearTimeout(timer); }
}

// One request crosses the low/high pool, real Provider RPM permits, error-only
// diagnostics and an admitted quiet SSE stream. Quota recovery is held at the
// local mock until every pre-refresh fact is observable; no production API is used.
test('low failures retain two detail/RPM attempts, high SSE fallback survives pings, then refresh restores low', { timeout: 15000 }, async (t) => {
  let releaseRefresh, refreshEntered;
  const refreshing = new Promise((resolve) => { refreshEntered = resolve; });
  const hits = [], upstreamPorts = [];
  let recovered = false;
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', async () => {
      const account = req.headers.authorization === 'Bearer local-low' ? 'low' : 'high';
      if (req.method === 'GET') {
        if (account === 'low') {
          refreshEntered();
          await new Promise((resolve) => { releaseRefresh = resolve; });
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, data: { limits: ['five_hour','weekly','monthly'].map((type) => ({ type, percentUsed: account === 'low' ? 82 : 0 })) } }));
        return;
      }
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const provider = body.provider?.only?.[0] || body.providerOptions?.gateway?.only?.[0];
      hits.push({ account, provider }); upstreamPorts.push(req.socket.remotePort);
      if (account === 'low' && !recovered) {
        const status = hits.filter((hit) => hit.account === 'low').length === 1 ? 500 : 401;
        res.writeHead(status, { 'Content-Type': 'application/json', 'X-Credential': 'Bearer api_key=local-response-secret' });
        res.end(JSON.stringify({ error: { message: status === 401 ? 'account auth failure' : 'provider failure', status } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(': PRELUDE\n\ndata: {"choices":[{"delta":{"content":"first"}}]}\n\n');
      setTimeout(() => res.end('data: {"usage":{"prompt_tokens":2,"completion_tokens":0}}\n\ndata: [DONE]\n\n'), 250);
    });
  });
  const upstreamPort = await listen(upstream);
  const probe = http.createServer(), port = await listen(probe); await close(probe);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cps-parent-cross-'));
  const config = { port, upstreamBase: `http://127.0.0.1:${upstreamPort}`, errorDetailLogging: true,
    accounts: ['low','high'].map((id) => ({ id, name: id, key: `local-${id}`, enabled: true, maxRpm: 4, maxConcurrent: 1 })),
    accountMode: 'sticky', activeAccount: 0, concurrencyWaitMs: 0, knownModels: ['m'],
    perModel: { m: { upstreams: ['first','second'], pinMode: 'strict' } },
    accountPipeline: { quotaPool: true, healthSort: true, sticky: true, order: ['sticky','healthSort','quotaPool'], cachePoolSize: 2, cachePoolMaxSize: 3, cachePoolLowQuotaSize: 1 },
  };
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config));
  let child = await boot(dir, port);
  t.after(async () => { releaseRefresh?.(); await stop(child); upstream.closeAllConnections?.(); await close(upstream); fs.rmSync(dir, { recursive: true, force: true }); });
  await stop(child);
  const metaFile = path.join(dir, 'metadata.json'), meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  const now = Date.now();
  meta.accountQuotas = Object.fromEntries([['low',82],['high',0]].map(([id, percentUsed]) => [id, {
    snapshot: { limits: Object.fromEntries(['five_hour','weekly','monthly'].map((name) => [name, { percentUsed }])), fetchedAt: now },
    lastAttemptAt: now, lastSuccessAt: now, errorCategory: null,
  }]));
  fs.writeFileSync(metaFile, JSON.stringify(meta));
  child = await boot(dir, port);
  const api = async (route) => (await fetch(`http://127.0.0.1:${port}${route}`)).json();
  const chat = async () => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'm', messages: [], stream: true }) });
    return { status: res.status, id: res.headers.get('x-cline-request-id'), attempts: Number(res.headers.get('x-cline-attempts')), text: await res.text() };
  };
  const first = await chat();
  assert.equal(first.status, 200);
  assert.deepEqual(hits.slice(0, 3), [
    { account: 'low', provider: 'first' }, { account: 'low', provider: 'second' }, { account: 'high', provider: 'first' },
  ]);
  assert.equal(first.attempts, 3);
  assert.match(first.text, /: PRELUDE\n\ndata:/);
  assert.match(first.text, /: PING\n\n/);
  assert.match(first.text, /data: \[DONE\]/);
  await refreshing;
  const held = await api('/api/accounts');
  assert.equal(held.accounts.find((a) => a.id === 'low').state.quotaDisposition, 'waiting-refresh');
  assert.deepEqual(held.accounts.map((a) => [a.id, a.rpm.used]), [['low', 2], ['high', 1]]);
  assert.deepEqual(held.cachePool.actual, { high: 1, low: 0, unknown: 0 });
  const rows = await waitFor(async () => { const items = (await api(`/api/logs/errors?requestId=${first.id}`)).items; return items?.length === 2 && items; }, 'two ordinary failures');
  assert.deepEqual(rows.map((row) => row.attemptIndex).sort(), [0, 1]);
  assert.deepEqual(rows.map((row) => row.upstreamStatus).sort(), [401, 500]);
  assert.ok(rows.some((row) => row.quotaRemovalAction === 'waiting-refresh'));
  const group = await waitFor(async () => { const value = await api(`/api/logs/details/${first.id}`); return value.request?.profile === 'error' && value; }, 'error detail publication');
  assert.equal(group.attempts.length, 2, 'successful high response and SSE heartbeat are not copied');
  assert.equal(group.request.requestBody, undefined);
  for (const row of rows) {
    const [attempt] = group.attempts.filter((item) => item.attemptIndex === row.attemptIndex && item.callId === row.detailCallId);
    assert.ok(attempt, 'ordinary row matches exactly one native attempt');
    const body = await (await fetch(`http://127.0.0.1:${port}/api/logs/details/${first.id}/bodies/${attempt.responseBody}`)).text();
    assert.match(body, /failure/);
    assert.equal(JSON.stringify(attempt).includes('local-response-secret'), false);
  }
  const ordinary = (await api(`/api/logs/requests?requestId=${first.id}`)).items;
  assert.equal(ordinary.length, 1); assert.equal(ordinary[0].result, 'success');
  assert.equal(ordinary[0].attempts.length, 3);
  assert.equal(ordinary[0].selectedQuotaRole, 'high');
  const statistics = await api('/api/statistics');
  assert.equal(statistics.lifetime.global.requests, 1);
  assert.equal(statistics.lifetime.global.usageRequests, 1, 'pings and failed attempts cannot add usage samples');
  assert.equal(JSON.stringify([...ordinary, ...rows]).includes('local-response-secret'), false);
  releaseRefresh();
  await waitFor(async () => (await api('/api/accounts')).accounts.find((a) => a.id === 'low').state.quotaDisposition === null, 'real quota refresh clears hold');
  recovered = true;
  const next = await chat(); assert.equal(next.status, 200);
  assert.equal(hits.at(-1).account, 'low');
  await stop(child); child = await boot(dir, port);
  const persisted = (await api(`/api/logs/requests?requestId=${first.id}`)).items;
  assert.equal(persisted.length, 1);
  assert.equal((await api(`/api/logs/details/${first.id}`)).attempts.length, 2);
  assert.equal(upstreamPorts.length, hits.length, 'one socket observation per real chat attempt');
});
