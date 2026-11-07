import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawn } from 'node:child_process';
import { prepareAdminFixture, connectAdminFixture, fixtureHeaders, installFixtureFetch } from './admin-fixture.js';

installFixtureFetch();

const refusal = 'Error 403: client-supplied "providerOptions" model routing is not supported';
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = (server) => new Promise((resolve) => server.close(resolve));
async function unusedPort() { const holder = http.createServer(); const port = await listen(holder); await close(holder); return port; }
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitUntil(check) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await pause(20); }
  throw new Error('fixture condition timed out');
}
function testEnv(dir) {
  const env = { ...process.env, DATA_DIR: dir, BIND_HOST: '127.0.0.1', NODE_ENV: 'test' };
  for (const key of ['CLINE_PASS_KEY', 'PROXY_KEY', 'PUBLIC_BASE_URL', 'PORT']) delete env[key];
  return env;
}
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    child.once('exit', resolve); child.kill('SIGTERM');
    setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 2000).unref();
  });
}
function request(port, pathname, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request({ hostname: '127.0.0.1', port, path: pathname, method: 'POST', headers: fixtureHeaders(port, pathname, 'POST', { 'Content-Type': 'application/json', 'Content-Length': data.length }) }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString(); let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject); req.end(data);
  });
}
const route = (extra = {}) => ({ upstreams: ['minimax'], exclude: [], pinMode: 'strict', sort: 'cost', maxRetries: 5, providerCooldownMs: 6000, ...extra });
const completion = () => ({ choices: [{ message: { content: 'OK', provider_metadata: { gateway: { routing: { finalProvider: 'automatic-provider' } } } }, finish_reason: 'stop' }] });

async function boot(t, { enabled = false, schedule = false } = {}) {
  const seen = [], dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cps-routing-compat-'));
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}'); seen.push(body);
      res.setHeader('Content-Type', 'application/json');
      if (body.model === 'auth-model') { res.statusCode = 403; return res.end(JSON.stringify({ error: { message: 'permission denied: invalid account credential' } })); }
      if (Object.hasOwn(body, 'providerOptions')) {
        res.statusCode = 403;
        return res.end(JSON.stringify({ error: { message: JSON.stringify({ code: 'API_REQUEST_ERROR_CODE', message: refusal }), type: 'upstream_error' } }));
      }
      if (body.stream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'OK' } }] })}\n\n`);
        return res.end('data: [DONE]\n\n');
      }
      res.end(JSON.stringify(completion()));
    });
  });
  const upstreamPort = await listen(upstream), port = await unusedPort();
  const models = {
    'planner-model': { pipeline: 'planner', upstreams: ['minimax', 'fireworks'] },
    'unknown-model': { upstreams: ['minimax'] },
    'direct-model': { pipeline: 'direct', upstreams: ['minimax'] },
    'excluded-model': { pipeline: 'planner', upstreams: ['minimax'] },
    'quarantined-model': { pipeline: 'planner', upstreams: ['minimax'], upstreamStatus: { minimax: { hardQuarantined: true } } },
    'cooling-model': { pipeline: 'planner', upstreams: ['minimax'], upstreamStatus: { minimax: { cooldownUntil: Date.now() + 60000 } } },
    'auth-model': { pipeline: 'planner' },
  };
  const configFile = path.join(dir, 'config.json');
  fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify({ routingSecret: 'gateway-routing-compat-secret', models }));
  fs.writeFileSync(configFile, JSON.stringify({
    port, upstreamBase: `http://127.0.0.1:${upstreamPort}`, gatewayRoutingEnabled: enabled,
    accountMode: 'single', activeAccount: 0, concurrencyWaitMs: 0,
    accounts: [{ id: 'a', name: 'A', key: 'fixture-key-a', enabled: true, perModel: {} }],
    knownModels: schedule ? ['planner-model', 'unknown-model'] : Object.keys(models),
    perModel: { 'planner-model': route(), 'unknown-model': route(), 'direct-model': route(), 'excluded-model': route({ exclude: ['minimax'] }), 'auth-model': route() },
    gatewayHas: { 'planner-model': ['vision', 'implicit-caching'] }, errorRules: [],
    providerProbeSchedule: { enabled: schedule, intervalMs: 300000, maxPerRound: 2, maxPer24h: 100, failureThreshold: 3 },
  }));
  prepareAdminFixture(dir);
  const child = spawn(process.execPath, ['server.js'], { cwd: path.resolve('.'), env: { ...testEnv(dir), CLINE_PASS_TEST_PROBE_INTERVAL_MS: '50' }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => { await stop(child); await close(upstream); fs.rmSync(dir, { recursive: true, force: true }); });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; }); child.stderr.on('data', (chunk) => { output += chunk; });
  await waitUntil(() => {
    if (child.exitCode !== null) throw new Error(`fixture exited: ${output}`);
    return output.includes('OpenAI 兼容代理地址');
  });
  await connectAdminFixture(port);
  const call = (model = 'planner-model', extra = {}) => request(port, '/v1/chat/completions', { model, messages: [{ role: 'user', content: 'Reply OK' }], max_tokens: 1024, ...extra });
  const get = async (pathname) => (await fetch(`http://127.0.0.1:${port}${pathname}`)).json();
  const log = (response) => waitUntil(async () => (await get(`/api/logs/requests?requestId=${response.headers['x-cline-request-id']}`)).items?.[0]);
  const reload = () => request(port, '/api/config/reload', {});
  return { dir, configFile, port, seen, call, get, log, reload };
}

test('Cline defaults to no gateway routing; custom gateways retain old behavior and an explicit boolean wins', () => {
  const source = fs.readFileSync('server.js', 'utf8');
  const functions = source.slice(source.indexOf('function normalizeGatewayRoutingEnabled('), source.indexOf('function gatewayOwnedPipeline('));
  const enabled = (config) => vm.runInNewContext(`${functions}\ngatewayRoutingEnabled()`, { URL, config });
  assert.equal(enabled({ upstreamBase: 'https://api.cline.bot/api/v1' }), false);
  assert.equal(enabled({ upstreamBase: 'https://api.cline.bot/api/v1/' }), false);
  assert.equal(enabled({ upstreamBase: 'https://API.CLINE.BOT/api/v1' }), false);
  assert.equal(enabled({ upstreamBase: 'https://api.cline.bot.example/api/v1' }), true);
  assert.equal(enabled({ upstreamBase: 'http://127.0.0.1:1234' }), true);
  assert.equal(enabled({ upstreamBase: 'http://127.0.0.1:99999' }), true, 'invalid targets remain owned by the transport error/RPM lifecycle');
  assert.equal(enabled({ upstreamBase: 'https://api.cline.bot/api/v1', gatewayRoutingEnabled: true }), true);
  assert.equal(enabled({ upstreamBase: 'http://127.0.0.1:1234', gatewayRoutingEnabled: false }), false);
  for (const value of ['false', 0, null, {}]) assert.throws(() => enabled({ upstreamBase: 'http://127.0.0.1', gatewayRoutingEnabled: value }), /gatewayRoutingEnabled must be boolean/);
});

test('disabled gateway routing strips all providerOptions and conflicting provider; JSON/SSE use one truthful auto attempt', async (t) => {
  const { dir, seen, call, log } = await boot(t);
  const messages = [{ role: 'user', content: 'unchanged input' }];
  const extra = { messages, providerOptions: { gateway: { only: ['client-pin'], order: ['client-pin'] }, openaiCompatible: { strictJsonSchema: false } }, provider: { only: ['client-pin'] } };
  const response = await call('planner-model', extra);
  assert.equal(response.status, 200);
  assert.equal(response.headers['x-cline-target-upstream'], 'auto');
  assert.equal(response.headers['x-cline-attempts'], '1');
  assert.equal(seen.length, 1);
  assert.equal(Object.hasOwn(seen[0], 'providerOptions'), false);
  assert.equal(Object.hasOwn(seen[0], 'provider'), false);
  assert.deepEqual(seen[0].messages, messages);
  assert.equal(seen[0].max_tokens, 1024);
  const row = await log(response);
  assert.equal(row.providerPlanSource, 'auto');
  assert.deepEqual(row.targetProviders, []);
  assert.equal(row.actualProvider, 'automatic-provider');
  assert.equal(row.attempts[0].providerSelection, 'compat-auto');
  assert.equal(row.attempts[0].provider, 'auto');
  const stream = await call('planner-model', { ...extra, stream: true });
  assert.equal(stream.status, 200);
  assert.match(stream.text, /OK/); assert.match(stream.text, /\[DONE\]/);
  assert.equal(stream.headers['x-cline-target-upstream'], 'auto');
  assert.equal(stream.headers['x-cline-attempts'], '1');
  assert.equal(Object.hasOwn(seen.at(-1), 'providerOptions'), false);
  assert.equal((await log(stream)).actualProvider, null, 'missing actual evidence is never filled from the old configured pin');
  assert.equal((await call('unknown-model', extra)).status, 200);
  assert.equal(Object.hasOwn(seen.at(-1), 'providerOptions'), false);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'metadata.json')));
  assert.equal(meta.models['planner-model'].upstreamStatus?.minimax, undefined, 'auto successes do not fabricate named provider health');
});

test('direct provider pins survive while forbidden providerOptions is removed', async (t) => {
  const { seen, call } = await boot(t);
  const response = await call('direct-model', { providerOptions: { gateway: { order: ['client-pin'] }, openaiCompatible: {} }, provider: { only: ['client-pin'] } });
  assert.equal(response.status, 200);
  assert.equal(Object.hasOwn(seen.at(-1), 'providerOptions'), false);
  assert.deepEqual(seen.at(-1).provider.only, ['minimax']);
});

test('default gateway routing fails closed on exclusions, durable quarantine and cooldown', async (t) => {
  const { seen, call } = await boot(t);
  for (const model of ['excluded-model', 'quarantined-model', 'cooling-model']) {
    const response = await call(model);
    assert.equal(response.status, 503);
    assert.match(response.json.error.message, /cannot enforce provider exclusions or quarantine/);
    assert.equal(response.headers['x-cline-attempts'], '0');
  }
  assert.equal(seen.length, 0);
});

test('explicit routing refusal is request-scoped, does not degrade accounts/providers, and hot reload restores successful default routing', async (t) => {
  const { dir, configFile, seen, call, get, log, reload } = await boot(t, { enabled: true });
  const denied = await call();
  assert.equal(denied.status, 403);
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].providerOptions.gateway.only, ['minimax']);
  const row = await log(denied);
  assert.equal(row.attempts[0].errorScope, 'request');
  assert.equal(row.attempts[0].scopeEvidence, 'client_provider_routing');
  assert.equal(row.attempts[0].healthAction, 'ignore');
  assert.equal(row.attempts[0].providerCircuitAction, null);
  const errors = await waitUntil(async () => {
    const items = (await get(`/api/logs/errors?requestId=${denied.headers['x-cline-request-id']}`)).items;
    return items?.length && items;
  });
  assert.equal(errors.length, 1);
  assert.equal(errors[0].accountAction, null);
  assert.equal(errors[0].errorScope, 'request');
  const stored = JSON.parse(fs.readFileSync(configFile));
  fs.writeFileSync(configFile, JSON.stringify({ ...stored, gatewayRoutingEnabled: false }));
  assert.equal((await reload()).status, 200);
  assert.equal((await get('/api/config')).gatewayRoutingEnabled, false);
  assert.equal((await call()).status, 200, 'no stale provider circuit was opened by the policy 403');
  assert.equal(Object.hasOwn(seen.at(-1), 'providerOptions'), false);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'metadata.json')));
  assert.notEqual(meta.models['planner-model'].upstreamStatus?.minimax?.status, 'bad');
  for (const invalid of ['false', null, 0]) {
    const bytes = JSON.stringify({ ...stored, gatewayRoutingEnabled: invalid });
    fs.writeFileSync(configFile, bytes);
    assert.equal((await reload()).status, 400);
    assert.equal(fs.readFileSync(configFile, 'utf8'), bytes);
    assert.equal((await get('/api/config')).gatewayRoutingEnabled, false);
  }
  const noFlag = { ...stored }; delete noFlag.gatewayRoutingEnabled;
  fs.writeFileSync(configFile, JSON.stringify(noFlag));
  assert.equal((await reload()).status, 200);
  assert.equal((await get('/api/config')).gatewayRoutingEnabled, false, 'omission preserves the live setting');
  fs.writeFileSync(configFile, JSON.stringify({ ...stored, gatewayRoutingEnabled: true }));
  assert.equal((await reload()).status, 200);
  const auth = await call('auth-model');
  assert.equal(auth.status, 403);
  assert.equal((await log(auth)).attempts[0].errorScope, 'account', 'an unrelated permission/auth 403 keeps its old classification');
});

test('manual probe has no fake pin call, validation has no paid calls, and disabled gateway probes spend no budget', async (t) => {
  const { dir, port, seen, get } = await boot(t, { schedule: true });
  await pause(250);
  assert.equal(seen.length, 0, 'scheduled probes skip planner/unknown models rather than testing an unpinned provider');
  const probe = await request(port, '/api/probe', { model: 'planner-model' });
  assert.equal(probe.status, 200);
  assert.equal(seen.length, 1, 'only the normal unpinned discovery call is sent');
  assert.equal(probe.json.pinCapability, 'unknown');
  const validate = await request(port, '/api/validate-upstreams', { model: 'planner-model' });
  assert.equal(validate.status, 200);
  assert.equal(seen.length, 1, 'validation does not mislabel unpinned success as a working pin');
  assert.ok(Object.keys(validate.json.results).length > 0);
  for (const result of Object.values(validate.json.results)) assert.equal(result.status, 'unknown');
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'metadata.json')));
  assert.deepEqual(meta.providerProbe.budget, []);
  assert.equal((await get('/api/config')).gatewayRoutingEnabled, false);
});

test('invalid persisted gatewayRoutingEnabled fails startup without rewriting operator config', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cps-routing-invalid-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'config.json'), bytes = JSON.stringify({ gatewayRoutingEnabled: 'false' });
  fs.writeFileSync(file, bytes);
  const child = spawn(process.execPath, ['server.js'], { env: testEnv(dir), stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => stop(child));
  let output = ''; child.stdout.on('data', (chunk) => { output += chunk; }); child.stderr.on('data', (chunk) => { output += chunk; });
  const code = await new Promise((resolve) => child.once('exit', resolve));
  assert.notEqual(code, 0); assert.match(output, /gatewayRoutingEnabled must be boolean/);
  assert.equal(fs.readFileSync(file, 'utf8'), bytes);
});
