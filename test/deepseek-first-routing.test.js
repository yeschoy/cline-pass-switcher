// deepseek 官方渠道优先：perModel.upstreams 把 "deepseek" 放在首位时，
// 规划器（Vercel AI Gateway）管道必须一次注入完整 gateway.only + gateway.order，
// 且 deepseek 同时是两者的头部——官方渠道的优先权完全交给网关内部的 fallback，
// 本地不会逐个 provider 重试（见 README 的 perModel 说明）。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { prepareAdminFixture, fixtureHeaders, installFixtureFetch } from './admin-fixture.js';

installFixtureFetch();

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = (server) => new Promise((resolve) => server.close(resolve));
async function unusedPort() { const holder = http.createServer(); const port = await listen(holder); await close(holder); return port; }
const stop = (child) => new Promise((resolve) => { child.once('exit', resolve); child.kill('SIGTERM'); setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 1000).unref(); });
function rawJson(port, pathname, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request({ hostname: '127.0.0.1', port, path: pathname, method: 'POST', headers: fixtureHeaders(port, pathname, 'POST', { 'Content-Type': 'application/json', 'Content-Length': data.length }) }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => { const text = Buffer.concat(chunks).toString(); let json = null; try { json = text ? JSON.parse(text) : null; } catch {} resolve({ status: res.statusCode, headers: res.headers, text, json }); });
    });
    req.on('error', reject); req.end(data);
  });
}
const routing = (provider) => ({ choices: [{ message: { content: 'ok' }, provider_metadata: { gateway: { routing: { resolvedProvider: provider } } } }] });

async function boot(t, { perModel, errorRules = [], gatewayHas } = {}) {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      seen.push(body);
      const targets = body.providerOptions?.gateway?.order || [];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(routing(targets[0] || 'none')));
    });
  });
  const upstreamPort = await listen(upstream), port = await unusedPort(), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cps-deepseek-first-'));
  fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify({ routingSecret: 'deepseek-first-secret', models: { 'cline-pass/deepseek-v4-pro': { pipeline: 'planner' } } }));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    port, upstreamBase: `http://127.0.0.1:${upstreamPort}`, accountMode: 'single', activeAccount: 0, concurrencyWaitMs: 0,
    accounts: [{ id: 'a', name: 'A', key: 'key-a', enabled: true, perModel: {} }],
    knownModels: ['cline-pass/deepseek-v4-pro'],
    perModel, errorRules, ...(gatewayHas ? { gatewayHas } : {}),
  }));
  prepareAdminFixture(dir);
  const child = spawn(process.execPath, ['server.js'], { cwd: path.resolve('.'), env: { ...process.env, DATA_DIR: dir, BIND_HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; }); child.stderr.on('data', (chunk) => { output += chunk; });
  await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(`switcher startup timeout: ${output}`)), 5000);
    const poll = setInterval(() => { if (output.includes('OpenAI 兼容代理地址')) { clearInterval(poll); clearTimeout(deadline); resolve(); } }, 20);
    child.once('exit', (code) => { clearInterval(poll); clearTimeout(deadline); reject(new Error(`switcher exited ${code}: ${output}`)); });
  });
  t.after(async () => { await stop(child); await close(upstream); });
  const call = () => rawJson(port, '/v1/chat/completions', { model: 'cline-pass/deepseek-v4-pro', messages: [{ role: 'user', content: 'hi' }], max_tokens: 16 });
  return { seen, call };
}

test('official deepseek leads only+order and the whole list rides one gateway call', async (t) => {
  const route = { upstream: null, upstreams: ['deepseek', 'fireworks', 'baseten'], exclude: [], pinMode: 'strict', sort: null, maxRetries: 2, providerCooldownMs: 60000 };
  const { seen, call } = await boot(t, { perModel: { 'cline-pass/deepseek-v4-pro': route } });

  assert.equal((await call()).status, 200);
  assert.equal(seen.length, 1, 'the planner pipeline issues a single gateway call, not a local per-provider loop');
  assert.deepEqual(seen[0].providerOptions.gateway.only, ['deepseek', 'fireworks', 'baseten']);
  assert.deepEqual(seen[0].providerOptions.gateway.order, ['deepseek', 'fireworks', 'baseten'], 'the official channel is the head the gateway tries first');
});

test('strict keeps the official head on the first attempt and preferred is the explicit opt-out', async (t) => {
  const base = { upstream: null, upstreams: ['deepseek', 'fireworks', 'baseten'], exclude: [], sort: null, maxRetries: 2, providerCooldownMs: 0 };
  const strict = await boot(t, { perModel: { 'cline-pass/deepseek-v4-pro': { ...base, pinMode: 'strict' } } });
  assert.equal((await strict.call()).status, 200);
  assert.equal(strict.seen[0].providerOptions.gateway.order[0], 'deepseek', 'strict-first keeps the configured official channel at the head');

  // preferred ranks by Provider-model 24h success rate from the first attempt on;
  // unsampled channels count as unknown and fall back to source order, so with no
  // samples the official head survives either way.
  const preferred = await boot(t, { perModel: { 'cline-pass/deepseek-v4-pro': { ...base, pinMode: 'preferred' } } });
  assert.equal((await preferred.call()).status, 200);
  assert.deepEqual(preferred.seen[0].providerOptions.gateway.order, ['deepseek', 'fireworks', 'baseten'], 'unsampled channels fall back to source order, so the official head holds without health samples');
});

test('excluding the official channel removes it instead of silently falling back to auto', async (t) => {
  const route = { upstream: null, upstreams: ['deepseek', 'fireworks'], exclude: ['deepseek'], pinMode: 'strict', sort: null, maxRetries: 2, providerCooldownMs: 0 };
  const { seen, call } = await boot(t, { perModel: { 'cline-pass/deepseek-v4-pro': route } });

  assert.equal((await call()).status, 200);
  assert.deepEqual(seen[0].providerOptions.gateway.only, ['fireworks'], 'an excluded official channel never reaches the gateway list');
});

test('gatewayHas capabilities ride along with the official-first list', async (t) => {
  const route = { upstream: null, upstreams: ['deepseek', 'fireworks'], exclude: [], pinMode: 'strict', sort: null, maxRetries: 2, providerCooldownMs: 0 };
  const { seen, call } = await boot(t, { perModel: { 'cline-pass/deepseek-v4-pro': route }, gatewayHas: { 'cline-pass/deepseek-v4-pro': ['tool-use', 'reasoning'] } });

  assert.equal((await call()).status, 200);
  const gateway = seen[0].providerOptions.gateway;
  assert.equal(gateway.order[0], 'deepseek');
  assert.deepEqual(gateway.has, ['tool-use', 'reasoning']);
});
