import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { prepareAdminFixture, connectAdminFixture, fixtureHeaders, installFixtureFetch } from './admin-fixture.js';

installFixtureFetch();

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = (server) => new Promise((resolve) => server.close(resolve));
async function unusedPort() { const holder = http.createServer(); const port = await listen(holder); await close(holder); return port; }
const stop = (child) => new Promise((resolve) => { child.once('exit', resolve); child.kill('SIGTERM'); setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 1000).unref(); });
async function waitUntil(check, timeoutMs = 5000, label = 'condition') {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out: ${label}`);
}
function rawJson(port, pathname, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request({ hostname: '127.0.0.1', port, path: pathname, method: 'POST', headers: fixtureHeaders(port, pathname, 'POST', { 'Content-Type': 'application/json', 'Content-Length': data.length, ...headers }) }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject); req.end(data);
  });
}
function routing(provider, key = 'finalProvider', namespace = 'provider_metadata') {
  return { choices: [{ message: { content: 'ok', [namespace]: { gateway: { routing: { [key]: provider, fallbacksAvailable: ['not-actual'] } } } } }] };
}

test('planner and unknown pipelines send one gateway only+order list and actual stays response-evidenced', async (t) => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      seen.push(body);
      const model = body.model;
      if (model === 'direct-model') {
        const pin = body.provider?.only?.[0];
        if (pin === 'alpha') { res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'alpha failed', status: 500 } })); }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }], provider: 'Beta Display' }));
      }
      if (model === 'stream-late' && body.stream) {
        const pad = 'x'.repeat(70 * 1024);
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n');
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: pad, provider_metadata: { gateway: { routing: { finalProvider: 'late-provider', fallbacksAvailable: ['not-actual'] } } } } }] })}\n\n`);
        res.write('data: {"provider":"bare-later"}\n\n');
        return res.end('data: [DONE]\n\n');
      }
      if (model === 'stream-resolved' && body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: {"choices":[{"delta":{"providerMetadata":{"gateway":{"routing":{"resolvedProvider":"camel-resolved"}}}}}]}\n\n');
        res.write('data: {"provider":"bare-later"}\n\n');
        return res.end('data: [DONE]\n\n');
      }
      if (model === 'error-text') {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'gateway said "finalProvider":"zeta" after failure', status: 500 } }));
      }
      if (model === 'sticky-error') {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          error: { message: 'quoted "finalProvider":"from-error" must not win', status: 500 },
          choices: [{ message: { provider_metadata: { gateway: { routing: { finalProvider: 'from-meta' } } } } }],
        }));
      }
      if (model === 'error-empty') {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'plain failure', status: 500 } }));
      }
      if (model === 'fallbacks-only') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ choices: [{ message: { content: 'ok', provider_metadata: { gateway: { routing: { fallbacksAvailable: ['not-actual'] } } } } }] }));
      }
      if (model === 'both-facts') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ provider: 'bare-name', ...routing('from-final') }));
      }
      if (model === 'delta-resolved') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ choices: [{ delta: { providerMetadata: { gateway: { routing: { resolvedProvider: 'from-delta' } } } }, message: { content: 'ok', provider: 'bare-message' } }] }));
      }
      if (model === 'preferred-model') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(routing('beta')));
      }
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'planned head failed', status: 500 } }));
    });
  });
  const upstreamPort = await listen(upstream), port = await unusedPort(), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cps-gateway-multi-'));
  const route = (upstreams, extra = {}) => ({ upstreams, exclude: [], pinMode: 'strict', sort: null, maxRetries: null, providerCooldownMs: 0, ...extra });
  fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify({
    routingSecret: 'gateway-multi-secret',
    models: {
      'planner-model': { pipeline: 'planner' },
      'filtered-model': { pipeline: 'planner', upstreamStatus: { gone: { hardQuarantined: true } } },
      'direct-model': { pipeline: 'direct' },
      'stream-late': { pipeline: 'planner' },
      'stream-resolved': { pipeline: 'planner' },
      'error-text': { pipeline: 'planner' },
      'sticky-error': { pipeline: 'planner' },
      'error-empty': { pipeline: 'planner' },
      'fallbacks-only': { pipeline: 'planner' },
      'both-facts': { pipeline: 'planner' },
      'delta-resolved': { pipeline: 'planner' },
      'preferred-model': { pipeline: 'planner' },
      'client-fold': { pipeline: 'planner' },
      'auto-model': { pipeline: 'planner' },
    },
  }));
  const config = {
    port, upstreamBase: `http://127.0.0.1:${upstreamPort}`, accountMode: 'single', activeAccount: 0, concurrencyWaitMs: 0,
    accounts: [{ id: 'a', name: 'A', key: 'key-a', enabled: true, perModel: {} }],
    knownModels: ['planner-model', 'unknown-model', 'filtered-model', 'direct-model', 'stream-late', 'stream-resolved', 'error-text', 'sticky-error', 'error-empty', 'fallbacks-only', 'both-facts', 'delta-resolved', 'preferred-model', 'client-fold', 'auto-model'],
    perModel: {
      'planner-model': route(['alpha', 'beta', 'gamma']),
      'unknown-model': route(['alpha', 'beta']),
      'filtered-model': route(['keep', 'also', 'drop', 'gone'], { exclude: ['drop'] }),
      'direct-model': route(['alpha', 'beta']),
      'stream-late': route(['alpha', 'beta']),
      'stream-resolved': route(['alpha', 'beta']),
      'error-text': route(['alpha', 'beta']),
      'sticky-error': route(['alpha', 'beta']),
      'error-empty': route(['alpha', 'beta']),
      'fallbacks-only': route(['alpha', 'beta']),
      'both-facts': route(['alpha', 'beta']),
      'delta-resolved': route(['alpha', 'beta']),
      'preferred-model': route(['alpha', 'beta'], { pinMode: 'preferred' }),
      'client-fold': route(['alpha', 'beta']),
    },
    errorRules: [],
  };
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config));
  prepareAdminFixture(dir);
  const child = spawn(process.execPath, ['server.js'], { cwd: path.resolve('.'), env: { ...process.env, DATA_DIR: dir, BIND_HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; }); child.stderr.on('data', (chunk) => { output += chunk; });
  await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(`switcher startup timeout: ${output}`)), 5000);
    const poll = setInterval(() => { if (output.includes('OpenAI 兼容代理地址')) { clearInterval(poll); clearTimeout(deadline); resolve(); } }, 20);
    child.once('exit', (code) => { clearInterval(poll); clearTimeout(deadline); reject(new Error(`switcher exited ${code}: ${output}`)); });
  });
  await connectAdminFixture(port);
  t.after(async () => { await stop(child); await close(upstream); fs.rmSync(dir, { recursive: true, force: true }); });
  const call = (model, extra = {}) => rawJson(port, '/v1/chat/completions', { model, messages: [{ role: 'user', content: 'hi' }], ...extra });
  const requestLog = (response) => waitUntil(async () => (await (await fetch(`http://127.0.0.1:${port}/api/logs/requests?requestId=${response.headers['x-cline-request-id']}`)).json()).items[0]);
  const errorLog = (response) => waitUntil(async () => {
    const page = await (await fetch(`http://127.0.0.1:${port}/api/logs/errors?requestId=${response.headers['x-cline-request-id']}`)).json();
    return page.items?.length ? page.items : null;
  });

  seen.length = 0;
  const planner = await call('planner-model');
  assert.equal(planner.status, 500);
  assert.equal(seen.length, 1, 'a multi-provider planner list is one HTTP attempt');
  assert.equal(planner.headers['x-cline-attempts'], '1');
  assert.deepEqual(seen[0].providerOptions.gateway.only, ['alpha', 'beta', 'gamma']);
  assert.deepEqual(seen[0].providerOptions.gateway.order, ['alpha', 'beta', 'gamma']);
  assert.deepEqual(seen[0].providerOptions.gateway.has, ['vision', 'implicit-caching'], 'only is accompanied by the capability filter that makes it enforced');
  assert.equal(seen[0].provider, undefined);
  const plannerLog = await requestLog(planner);
  assert.deepEqual(plannerLog.targetProviders, ['alpha', 'beta', 'gamma']);
  assert.equal(plannerLog.actualProvider, null);
  assert.equal(plannerLog.attempts.length, 1);

  seen.length = 0;
  const unknown = await call('unknown-model');
  assert.equal(unknown.status, 500);
  assert.equal(seen.length, 1, 'an unknown pipeline is gateway-capable and does not walk providers locally');
  assert.deepEqual(seen[0].providerOptions.gateway.only, ['alpha', 'beta']);
  assert.deepEqual(seen[0].providerOptions.gateway.order, seen[0].providerOptions.gateway.only);
  assert.deepEqual(seen[0].providerOptions.gateway.has, ['vision', 'implicit-caching']);
  assert.equal(seen[0].provider, undefined);

  seen.length = 0;
  const filtered = await call('filtered-model');
  assert.equal(filtered.status, 500);
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].providerOptions.gateway.only, ['keep', 'also']);
  assert.deepEqual(seen[0].providerOptions.gateway.order, ['keep', 'also']);

  seen.length = 0;
  const folded = await call('client-fold', { provider: { only: ['client-pin'], order: ['client-pin'], extra: true }, providerOptions: { gateway: { only: ['client-gw'], order: ['client-gw'], has: ['client-cap'] }, anthropic: { keep: true } } });
  assert.equal(folded.status, 500);
  assert.equal(seen[0].provider, undefined, 'gateway injection removes a conflicting top-level provider');
  assert.deepEqual(seen[0].providerOptions.gateway.only, ['alpha', 'beta']);
  assert.deepEqual(seen[0].providerOptions.gateway.order, ['alpha', 'beta']);
  assert.deepEqual(seen[0].providerOptions.gateway.has, ['vision', 'implicit-caching'], 'a client-supplied has never survives the configured one');
  assert.deepEqual(seen[0].providerOptions.anthropic, { keep: true });

  seen.length = 0;
  assert.equal((await call('auto-model')).status, 500);
  assert.equal(seen[0].providerOptions, undefined, 'without an injected only list there is no capability filter either');

  seen.length = 0;
  const direct = await call('direct-model');
  assert.equal(direct.status, 200);
  assert.equal(seen.length, 2, 'direct pipeline still walks providers locally');
  assert.deepEqual(seen.map((body) => body.provider.only), [['alpha'], ['beta']]);
  assert.equal(seen[0].provider.order, undefined);
  assert.equal(seen[0].providerOptions, undefined);
  const directLog = await requestLog(direct);
  assert.equal(directLog.actualProvider, 'beta-display');
  assert.deepEqual(directLog.attempts.map((attempt) => attempt.provider), ['alpha', 'beta']);

  const sticky = await call('both-facts');
  assert.equal((await requestLog(sticky)).actualProvider, 'from-final', 'bare provider must not overwrite finalProvider');
  const delta = await call('delta-resolved');
  assert.equal((await requestLog(delta)).actualProvider, 'from-delta');
  const fallbacks = await call('fallbacks-only');
  assert.equal((await requestLog(fallbacks)).actualProvider, null, 'candidate lists are not an actual provider');

  const late = await call('stream-late', { stream: true });
  assert.equal(late.status, 200);
  assert.match(late.text, /late-provider/);
  const lateLog = await requestLog(late);
  assert.equal(lateLog.actualProvider, 'late-provider', 'routing after a large SSE event is still observed');
  assert.notEqual(lateLog.actualProvider, lateLog.targetProviders[0]);

  const resolved = await call('stream-resolved', { stream: true });
  assert.equal((await requestLog(resolved)).actualProvider, 'camel-resolved', 'a later bare provider must not replace resolvedProvider');

  const stickyError = await call('sticky-error');
  assert.equal((await requestLog(stickyError)).actualProvider, 'from-meta', 'error text must not replace a structured finalProvider');
  const errored = await call('error-text');
  const errorRows = await errorLog(errored);
  assert.equal(errorRows[0].actualProvider, 'zeta');
  assert.deepEqual((await requestLog(errored)).targetProviders, ['alpha', 'beta']);
  assert.notEqual(errorRows[0].actualProvider, errorRows[0].targetProvider);
  const empty = await call('error-empty');
  const emptyRows = await errorLog(empty);
  assert.equal(Object.hasOwn(emptyRows[0], 'actualProvider'), false);
  assert.equal((await requestLog(empty)).actualProvider, null);

  seen.length = 0;
  assert.equal((await call('preferred-model')).status, 200);
  assert.deepEqual(seen[0].providerOptions.gateway.order, ['alpha', 'beta']);
  const preferredStats = await waitUntil(async () => {
    const page = await (await fetch(`http://127.0.0.1:${port}/api/statistics`)).json();
    const row = page.models?.find((model) => model.id === 'preferred-model');
    return row?.providerStatistics?.providers?.length ? row : null;
  });
  const preferredProviders = preferredStats.providerStatistics.providers;
  assert.equal(preferredProviders.find((item) => item.id === 'beta')?.usage?.requests, 1, 'usage follows the response-evidenced provider');
  assert.equal(preferredProviders.find((item) => item.id === 'alpha')?.usage?.requests || 0, 0, 'the allow-list head is not a usage owner');
  seen.length = 0;
  assert.equal((await call('preferred-model')).status, 200);
  assert.equal(seen[0].providerOptions.gateway.order[0], 'beta', 'preferred reorders the single gateway list and does not open a second provider HTTP call');
  assert.equal(seen.length, 1);
});

test('gatewayHas: configured list is sent with only, [] disables it, SIGHUP applies it and an invalid value refuses to start', async (t) => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      seen.push(JSON.parse(Buffer.concat(chunks).toString() || '{}'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(routing('alpha')));
    });
  });
  const upstreamPort = await listen(upstream), port = await unusedPort(), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cps-gateway-has-'));
  const configFile = path.join(dir, 'config.json');
  fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify({ routingSecret: 'gateway-has-secret', models: { 'planner-model': { pipeline: 'planner' } } }));
  fs.writeFileSync(configFile, JSON.stringify({
    port, upstreamBase: `http://127.0.0.1:${upstreamPort}`, accountMode: 'single', activeAccount: 0, concurrencyWaitMs: 0,
    accounts: [{ id: 'a', name: 'A', key: 'key-a', enabled: true, perModel: {} }], knownModels: ['planner-model'],
    perModel: { 'planner-model': { upstreams: ['alpha', 'beta'], exclude: [], pinMode: 'strict', sort: null, maxRetries: null, providerCooldownMs: 0 } },
    errorRules: [], gatewayHas: ['vision'],
  }));
  prepareAdminFixture(dir);
  const start = () => {
    const child = spawn(process.execPath, ['server.js'], { cwd: path.resolve('.'), env: { ...process.env, DATA_DIR: dir, BIND_HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    const state = { child, output: '' };
    child.stdout.on('data', (chunk) => { state.output += chunk; }); child.stderr.on('data', (chunk) => { state.output += chunk; });
    return state;
  };
  const ready = (state) => new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(`switcher startup timeout: ${state.output}`)), 5000);
    const poll = setInterval(() => { if (state.output.includes('OpenAI 兼容代理地址')) { clearInterval(poll); clearTimeout(deadline); resolve(); } }, 20);
    state.child.once('exit', (code) => { clearInterval(poll); clearTimeout(deadline); reject(new Error(`switcher exited ${code}: ${state.output}`)); });
  });
  const first = start();
  t.after(async () => { await stop(first.child); await close(upstream); fs.rmSync(dir, { recursive: true, force: true }); });
  await ready(first);
  const call = () => rawJson(port, '/v1/chat/completions', { model: 'planner-model', messages: [{ role: 'user', content: 'hi' }] });
  const reload = async (gatewayHas) => {
    const next = { ...JSON.parse(fs.readFileSync(configFile, 'utf8')), gatewayHas };
    fs.writeFileSync(configFile, JSON.stringify(next));
    first.output = '';
    first.child.kill('SIGHUP');
    await waitUntil(() => /SIGHUP 热加载(完成|失败)/.test(first.output), 5000, 'SIGHUP reload');
    assert.match(first.output, /SIGHUP 热加载完成：.*gatewayHas/);
  };

  seen.length = 0;
  assert.equal((await call()).status, 200);
  assert.deepEqual(seen[0].providerOptions.gateway, { only: ['alpha', 'beta'], order: ['alpha', 'beta'], has: ['vision'] });

  await reload([]);
  seen.length = 0;
  assert.equal((await call()).status, 200);
  assert.deepEqual(seen[0].providerOptions.gateway, { only: ['alpha', 'beta'], order: ['alpha', 'beta'] }, 'an empty gatewayHas sends the legacy only+order shape');

  await reload(['audio', ' audio', 'implicit-caching']);
  seen.length = 0;
  assert.equal((await call()).status, 200);
  assert.deepEqual(seen[0].providerOptions.gateway.has, ['audio', 'implicit-caching'], 'entries are trimmed and de-duplicated');

  await stop(first.child);
  for (const invalid of ['vision', [''], ['has space'], [1], Array.from({ length: 11 }, (_, index) => `cap${index}`)]) {
    fs.writeFileSync(configFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(configFile, 'utf8')), gatewayHas: invalid }));
    const bad = start();
    const code = await new Promise((resolve) => bad.child.once('exit', resolve));
    assert.notEqual(code, 0, `gatewayHas ${JSON.stringify(invalid)} must refuse to start`);
    assert.match(bad.output, /invalid gatewayHas/);
  }
});
