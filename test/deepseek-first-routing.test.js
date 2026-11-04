// deepseek 模型 + 候选里有 deepseek 渠道 → 自动把该渠道提到注入的 only/order 头部。
// 这是模型名驱动的通用规则，不要求逐模型写 perModel；候选里没有 deepseek 时不得凭空添加。
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
      res.on('end', () => { const text = Buffer.concat(chunks).toString(); let json = null; try { json = text ? JSON.parse(text) : null; } catch {} resolve({ status: res.statusCode, text, json }); });
    });
    req.on('error', reject); req.end(data);
  });
}
const routing = (provider) => ({ choices: [{ message: { content: 'ok' }, provider_metadata: { gateway: { routing: { resolvedProvider: provider } } } }] });

// perModelRoute: null 表示该模型走 discovered 渠道（META.models[model].upstreams）。
async function boot(t, { models, perModel = {} }) {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      seen.push(JSON.parse(Buffer.concat(chunks).toString() || '{}'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(routing('x')));
    });
  });
  const upstreamPort = await listen(upstream), port = await unusedPort(), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cps-official-'));
  fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify({ routingSecret: 'official-channel-secret', models }));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    port, upstreamBase: `http://127.0.0.1:${upstreamPort}`, accountMode: 'single', activeAccount: 0, concurrencyWaitMs: 0,
    accounts: [{ id: 'a', name: 'A', key: 'key-a', enabled: true, perModel: {} }],
    knownModels: Object.keys(models), perModel, errorRules: [],
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
  const call = (model) => rawJson(port, '/v1/chat/completions', { model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 16 });
  const gatewayFor = (model) => { const body = seen.at(-1); return body.providerOptions?.gateway || null; };
  return { seen, call, gatewayFor };
}

test('a deepseek model hoists the deepseek channel to the head without any perModel entry', async (t) => {
  const model = 'cline-pass/deepseek-v4-pro';
  const { call, gatewayFor } = await boot(t, { models: { [model]: { pipeline: 'planner', upstreams: ['fireworks', 'deepseek', 'baseten', 'alibaba'] } } });
  assert.equal((await call(model)).status, 200);
  const gateway = gatewayFor(model);
  assert.deepEqual(gateway.order, ['deepseek', 'fireworks', 'baseten', 'alibaba'], 'the official channel is moved to the head, the rest keep their relative order');
  assert.deepEqual(gateway.only, gateway.order, 'only and order stay the same list');
});

test('models without a deepseek channel are left exactly as discovered', async (t) => {
  const model = 'cline-pass/glm-5.3-flash';
  const { call, gatewayFor } = await boot(t, { models: { [model]: { pipeline: 'planner', upstreams: ['fireworks', 'baseten', 'alibaba'] } } });
  assert.equal((await call(model)).status, 200);
  assert.deepEqual(gatewayFor(model).order, ['fireworks', 'baseten', 'alibaba'], 'no channel is invented or reordered');
});

test('a non-deepseek model that happens to list deepseek is not reordered', async (t) => {
  const model = 'cline-pass/glm-5.3';
  const { call, gatewayFor } = await boot(t, { models: { [model]: { pipeline: 'planner', upstreams: ['alibaba', 'deepseek'] } } });
  assert.equal((await call(model)).status, 200);
  assert.deepEqual(gatewayFor(model).order, ['alibaba', 'deepseek'], 'the rule is scoped to deepseek models, not to the channel name alone');
});

test('an explicit perModel order is also hoisted so operators need no per-model knowledge', async (t) => {
  const model = 'cline-pass/deepseek-v4.1-flash';
  const route = { upstream: null, upstreams: ['alibaba', 'togetherai', 'deepseek'], exclude: [], pinMode: 'strict', sort: null, maxRetries: 2, providerCooldownMs: 0 };
  const { call, gatewayFor } = await boot(t, { models: { [model]: { pipeline: 'planner', upstreams: ['alibaba', 'deepseek'] } }, perModel: { [model]: route } });
  assert.equal((await call(model)).status, 200);
  assert.deepEqual(gatewayFor(model).order, ['deepseek', 'alibaba', 'togetherai'], 'a configured order is hoisted too, with the explicit tail preserved');
});

test('an excluded deepseek channel is not resurrected by the hoist', async (t) => {
  const model = 'cline-pass/deepseek-v4-pro';
  const route = { upstream: null, upstreams: ['fireworks', 'deepseek', 'baseten'], exclude: ['deepseek'], pinMode: 'strict', sort: null, maxRetries: 2, providerCooldownMs: 0 };
  const { call, gatewayFor } = await boot(t, { models: { [model]: { pipeline: 'planner', upstreams: ['fireworks', 'deepseek'] } }, perModel: { [model]: route } });
  assert.equal((await call(model)).status, 200);
  assert.deepEqual(gatewayFor(model).only, ['fireworks', 'baseten'], 'exclusion is applied after the hoist, never bypassed');
});
