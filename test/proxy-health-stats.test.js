import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { prepareAdminFixture, connectAdminFixture, fixtureHeaders, installFixtureFetch } from './admin-fixture.js';
installFixtureFetch();

const stop = (child) => new Promise((resolve) => { child.once('exit', resolve); child.kill('SIGTERM'); setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 1000).unref(); });
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = (server) => new Promise((resolve) => server.close(resolve));
const freePort = () => new Promise((resolve, reject) => {
  const server = http.createServer();
  server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
  server.on('error', reject);
});

async function startSwitcher(config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cps-proxy-health-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config));
  prepareAdminFixture(dir);
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve('.'),
    env: { ...process.env, DATA_DIR: dir, BIND_HOST: '127.0.0.1', CLINE_PASS_KEY: '', PROXY_KEY: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (c) => { output += c; });
  child.stderr.on('data', (c) => { output += c; });
  await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(`switcher startup timeout: ${output}`)), 5000);
    const poll = setInterval(() => {
      if (output.includes('OpenAI 兼容代理地址')) { clearInterval(poll); clearTimeout(deadline); resolve(); }
    }, 20);
    child.once('exit', (code) => { clearInterval(poll); clearTimeout(deadline); reject(new Error(`switcher exited ${code}: ${output}`)); });
  });
  await connectAdminFixture(config.port);
  return { dir, child };
}

function chat(port, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request({
      hostname: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

function getStatistics(port) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, path: '/api/statistics', method: 'GET',
      headers: fixtureHeaders(port, '/api/statistics', 'GET'),
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString())));
    });
    req.on('error', reject);
    req.end();
  });
}

test('proxied 5xx increments proxyHealth even when error rules ignore the status', async (t) => {
  const closedPort = await freePort();
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (req.method === 'GET') { res.writeHead(500); return res.end('{}'); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }));
    });
  });
  const upstreamPort = await listen(upstream);
  t.after(async () => { upstream.closeAllConnections?.(); await close(upstream); });

  const port = await freePort();
  const proxyId = `http://127.0.0.1:${closedPort}`;
  const running = await startSwitcher({
    port,
    upstreamBase: `http://127.0.0.1:${upstreamPort}`,
    accounts: [{ id: 'proxied', name: 'Proxied', key: 'key-proxy', enabled: true, maxConcurrent: 2, proxyUrl: proxyId, perModel: {} }],
    accountMode: 'single',
    activeAccount: 0,
    knownModels: ['m'],
    perModel: {},
    errorRules: [{ id: 'ignore-502', scope: 'account', action: 'ignore', when: { statuses: [502] } }],
  });
  t.after(async () => { await stop(running.child); fs.rmSync(running.dir, { recursive: true, force: true }); });

  const failed = await chat(port, { model: 'm', messages: [{ role: 'user', content: 'proxy-fail' }] });
  assert.equal(failed.status, 502);

  const stats = await getStatistics(port);
  assert.ok(stats.proxyHealth?.proxies?.length >= 1);
  const row = stats.proxyHealth.proxies.find((p) => p.id === proxyId);
  assert.ok(row, 'proxy endpoint row missing');
  assert.equal(row.requests, 1);
  assert.equal(row.errors5xx, 1);
  assert.equal(row.errorRate, 1);
  assert.deepEqual(row.accounts.map((a) => a.id), ['proxied']);
});

test('direct accounts never appear in proxyHealth for 5xx failures', async (t) => {
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (req.method === 'GET') { res.writeHead(500); return res.end('{}'); }
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'boom', type: 'upstream_error' } }));
    });
  });
  const upstreamPort = await listen(upstream);
  t.after(async () => { upstream.closeAllConnections?.(); await close(upstream); });

  const port = await freePort();
  const running = await startSwitcher({
    port,
    upstreamBase: `http://127.0.0.1:${upstreamPort}`,
    accounts: [{ id: 'direct', name: 'Direct', key: 'key-direct', enabled: true, maxConcurrent: 2, proxyUrl: '', perModel: {} }],
    accountMode: 'single',
    activeAccount: 0,
    knownModels: ['m'],
    perModel: {},
    errorRules: [],
  });
  t.after(async () => { await stop(running.child); fs.rmSync(running.dir, { recursive: true, force: true }); });

  assert.equal((await chat(port, { model: 'm', messages: [{ role: 'user', content: 'direct-fail' }] })).status, 502);
  const stats = await getStatistics(port);
  assert.deepEqual(stats.proxyHealth?.proxies || [], []);
});
