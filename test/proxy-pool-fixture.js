// 代理池测试共用夹具：本地假上游、假 SOCKS5（无认证 / RFC1929）、子进程启动的 switcher。
// 凭据全部是占位值；不访问 api.cline.bot 或 api.floppydata.net。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { prepareAdminFixture, connectAdminFixture, installFixtureFetch } from './admin-fixture.js';
installFixtureFetch();

export const USER = 'user-test-session-1', PASS = 'pass-test', API_KEY = 'test-api-key';
export const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
export const close = (server) => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); });
export const freePort = async () => { const server = http.createServer(); const value = await listen(server); await close(server); return value; };
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export async function waitFor(check, label, ms = 5000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await sleep(10); }
  throw new Error(`timed out: ${label}`);
}

// 最小 SOCKS5：无认证或 RFC1929；记录出站到上游连接的本地端口，用于上游反查流量经过哪个代理。
export async function fakeSocks(name, registry, { auth = null } = {}) {
  const sockets = new Set();
  const server = net.createServer((client) => {
    sockets.add(client); client.on('close', () => sockets.delete(client)); client.on('error', () => {});
    const onRequest = () => client.once('data', (req) => {
      let host, offset;
      if (req[3] === 1) { host = [...req.subarray(4, 8)].join('.'); offset = 8; }
      else if (req[3] === 3) { host = req.subarray(5, 5 + req[4]).toString(); offset = 5 + req[4]; }
      else return client.destroy();
      const upstream = net.connect(req.readUInt16BE(offset), host, () => {
        registry.set(upstream.localPort, name);
        client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
        upstream.pipe(client); client.pipe(upstream);
      });
      sockets.add(upstream);
      upstream.on('error', () => client.destroy()); upstream.on('close', () => { sockets.delete(upstream); client.destroy(); });
      client.on('close', () => upstream.destroy());
    });
    client.once('data', (greeting) => {
      const methods = [...greeting.subarray(2, 2 + greeting[1])];
      if (!auth) { client.write(Buffer.from([5, 0])); return onRequest(); }
      if (!methods.includes(2)) return client.end(Buffer.from([5, 0xff]));
      client.write(Buffer.from([5, 2]));
      client.once('data', (a) => {
        const user = a.subarray(2, 2 + a[1]).toString(), pass = a.subarray(3 + a[1], 3 + a[1] + a[2 + a[1]]).toString();
        if (!auth(user, pass)) return client.end(Buffer.from([1, 1]));
        client.write(Buffer.from([1, 0])); onRequest();
      });
    });
  });
  const port = await listen(server);
  return { port, connections: () => sockets.size, close: async () => { for (const socket of sockets) socket.destroy(); await close(server); } };
}

// 最小 HTTP CONNECT 代理：可要求 Basic 认证（缺失或错误时 407）；同样记录出站本地端口。
export async function fakeConnect(name, registry, { auth = null } = {}) {
  const sockets = new Set(), rejected = [];
  const server = http.createServer((req, res) => { res.writeHead(405); res.end(); });
  server.on('connect', (req, client, head) => {
    sockets.add(client); client.on('close', () => sockets.delete(client)); client.on('error', () => {});
    if (auth) {
      const match = /^Basic\s+(.+)$/i.exec(String(req.headers['proxy-authorization'] || ''));
      const decoded = match ? Buffer.from(match[1], 'base64').toString() : '';
      const index = decoded.indexOf(':');
      if (index < 0 || !auth(decoded.slice(0, index), decoded.slice(index + 1))) {
        rejected.push(req.url);
        return client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="test"\r\nContent-Length: 0\r\n\r\n');
      }
    }
    const [host, port] = String(req.url).split(':');
    const upstream = net.connect(Number(port), host, () => {
      registry.set(upstream.localPort, name);
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) upstream.write(head);
      upstream.pipe(client); client.pipe(upstream);
    });
    sockets.add(upstream);
    upstream.on('error', () => client.destroy()); upstream.on('close', () => { sockets.delete(upstream); client.destroy(); });
    client.on('close', () => upstream.destroy());
  });
  const port = await listen(server);
  return { port, rejected, connections: () => sockets.size, close: async () => { for (const socket of sockets) socket.destroy(); await close(server); } };
}

const pipeline = { quotaPool: false, healthSort: false, sticky: false, order: ['quotaPool', 'healthSort', 'sticky'], cachePoolSize: 0, cachePoolMaxSize: 0, cachePoolLowQuotaSize: 0 };
const probeOff = { enabled: false, intervalMs: 300000, maxPerRound: 2, maxPer24h: 100, failureThreshold: 3 };
export function baseConfig(port, upstreamPort, extra = {}) {
  return { port, upstreamBase: `http://127.0.0.1:${upstreamPort}`, accounts: [{ id: 'a0', name: 'a0', key: 'local-a0', enabled: true, maxConcurrent: 0, priority: 10 }],
    accountMode: 'single', activeAccount: 0, concurrencyWaitMs: 0, poolFullWaitMs: 0, knownModels: ['m'], perModel: {}, errorRules: [],
    accountPipeline: pipeline, providerProbeSchedule: probeOff, ...extra };
}

export async function startServer(dir, env = {}, { cwd = path.resolve('.') } = {}) {
  prepareAdminFixture(dir);
  const child = spawn(process.execPath, ['server.js'], { cwd, env: { PATH: process.env.PATH, DATA_DIR: dir, BIND_HOST: '127.0.0.1', NODE_ENV: 'test', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (data) => { output += data; }); child.stderr.on('data', (data) => { output += data; });
  child.output = () => output;
  await waitFor(() => { if (child.exitCode !== null) throw new Error(`startup failed: ${output}`); return output.includes('OpenAI 兼容代理地址'); }, 'server startup');
  await connectAdminFixture(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).port);
  return child;
}
export async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([new Promise((resolve) => child.once('exit', resolve)), sleep(2000).then(() => child.kill('SIGKILL'))]);
}

const SSE_OK = 'data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n';
// 默认上游：GET /models 返回目录，其余 GET 500（额度刷新失败不影响路由）；聊天由 responder 决定，默认 200（按 stream 返回 SSE 或 JSON）。
// s.seen 记录每个聊天请求经过的出口，s.chats 记录 { via, auth }，s.seenGet 记录 GET 请求的 { path, via, auth }（auth 为上游 Authorization，占位值）。
export async function setup(t, { metadata = null, responder = null, env = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cps-proxy-pool-'));
  const registry = new Map();
  const s = { dir, registry, seen: [], chats: [], seenGet: [], file: path.join(dir, 'config.json'), proxies: [] };
  const upstream = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const via = registry.get(req.socket.remotePort) || 'direct';
      if (req.method === 'GET') {
        s.seenGet.push({ path: req.url, via, auth: req.headers.authorization || null });
        if (req.url === '/models') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ data: [{ id: 'cline-pass/catalog-model' }] })); }
        res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end('{}');
      }
      s.seen.push(via); s.chats.push({ via, auth: req.headers.authorization || null });
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch {}
      if (responder) return responder(via, res, { body, headers: req.headers });
      if (body.stream) { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); return res.end(SSE_OK); }
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }));
    });
  });
  s.upstreamPort = await listen(upstream);
  s.port = await freePort();
  s.socks = async (name, options) => { const proxy = await fakeSocks(name, registry, options); s.proxies.push(proxy); return proxy; };
  s.connectProxy = async (name, options) => { const proxy = await fakeConnect(name, registry, options); s.proxies.push(proxy); return proxy; };
  s.writeConfig = (extra = {}) => fs.writeFileSync(s.file, JSON.stringify(baseConfig(s.port, s.upstreamPort, extra), null, 2));
  s.bytes = () => fs.readFileSync(s.file, 'utf8');
  s.read = () => JSON.parse(s.bytes());
  s.start = async (extra) => { if (extra !== undefined) s.writeConfig(extra); if (metadata) fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify(metadata)); s.child = await startServer(dir, env); };
  s.stop = async () => { await stopServer(s.child); s.child = null; };
  s.get = async (route = '/api/accounts') => (await fetch(`http://127.0.0.1:${s.port}${route}`)).json();
  s.post = async (route, body) => { const res = await fetch(`http://127.0.0.1:${s.port}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: res.status, headers: res.headers, data: await res.json().catch(() => null) }; };
  s.save = async (patch = {}) => {
    const view = await s.get();
    return s.post('/api/accounts', { accounts: view.accounts, mode: view.mode, active: view.active, concurrencyWaitMs: view.concurrencyWaitMs, poolFullWaitMs: view.poolFullWaitMs,
      errorRules: view.errorRules, retryRules: view.retryRules, quotaProtection: view.quotaProtection, accountPipeline: view.accountPipeline, accountWorkflow: view.accountWorkflow,
      sessionProviderAffinityEnabled: view.sessionProviderAffinityEnabled, expectedConfigurationRevision: view.configurationRevision, ...patch });
  };
  s.chat = async () => (await s.post('/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: `pool ${Math.random()}` }] })).status;
  // 完整读取响应（含 SSE）后返回 { status, headers, text }。
  s.chatFull = async ({ stream = false } = {}) => {
    const res = await fetch(`http://127.0.0.1:${s.port}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'm', stream, messages: [{ role: 'user', content: `pool ${Math.random()}` }] }) });
    return { status: res.status, headers: res.headers, text: await res.text() };
  };
  s.logs = async (kind = 'requests') => (await s.get(`/api/logs/${kind}?limit=200`)).items || [];
  t.after(async () => { await s.stop(); for (const proxy of s.proxies) await proxy.close(); await close(upstream); fs.rmSync(dir, { recursive: true, force: true }); });
  return s;
}
export const manualPool = (entries, extra = {}) => ({ enabled: true, source: 'manual', entries, ...extra });
export const socksUrl = (port, user = USER) => `socks5://${user}:${PASS}@127.0.0.1:${port}`;
