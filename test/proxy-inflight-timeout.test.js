import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const certPath = path.resolve(root, 'test/fixtures/proxy-cert.pem');
const tlsOptions = {
  key: fs.readFileSync(path.resolve(root, 'test/fixtures/proxy-key.pem')),
  cert: fs.readFileSync(certPath),
};
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = (server) => new Promise((resolve) => server.close(resolve));

function applyNestedSocketTimeouts(socket, ms) {
  for (let current = socket; current; current = current._parent || current.socket) {
    if (typeof current.setTimeout === 'function') current.setTimeout(ms);
  }
}

function startSocksProxy() {
  const socks = net.createServer((client) => {
    let buffer = Buffer.alloc(0), stage = 0;
    client.on('data', function onData(chunk) {
      buffer = Buffer.concat([buffer, chunk]);
      if (stage === 0) {
        if (buffer.length < 2) return;
        const n = buffer[1];
        if (buffer.length < 2 + n) return;
        buffer = buffer.subarray(2 + n);
        client.write(Buffer.from([5, 0]));
        stage = 1;
      }
      if (stage === 1) {
        if (buffer.length < 5) return;
        const atyp = buffer[3];
        let off = 4, host;
        if (atyp === 1) {
          if (buffer.length < 10) return;
          host = [...buffer.subarray(off, off + 4)].join('.');
          off += 4;
        } else if (atyp === 3) {
          const n = buffer[off++];
          if (buffer.length < off + n + 2) return;
          host = buffer.subarray(off, off + n).toString();
          off += n;
        } else return client.destroy();
        const port = buffer.readUInt16BE(off);
        off += 2;
        const rest = buffer.subarray(off);
        buffer = Buffer.alloc(0);
        stage = 2;
        const target = net.connect(port, host, () => {
          client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
          if (rest.length) target.write(rest);
          client.removeListener('data', onData);
          client.pipe(target);
          target.pipe(client);
        });
        target.on('error', () => client.destroy());
      }
    });
  });
  return listen(socks).then((port) => ({ socks, port }));
}

function onceHttps(url, { agent, timeoutMs, syncNested = false }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const u = new URL(url);
    const req = https.request({
      protocol: u.protocol, hostname: u.hostname, port: u.port, path: u.pathname,
      method: 'POST', headers: { 'content-type': 'application/json', 'content-length': 2 },
      agent, rejectUnauthorized: false, ca: fs.readFileSync(certPath),
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ ok: true, ms: Date.now() - started, status: res.statusCode, text: Buffer.concat(chunks).toString() }));
    });
    req.on('error', (error) => resolve({ ok: false, ms: Date.now() - started, message: error.message, code: error.code }));
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('upstream timeout')); });
    if (syncNested) {
      req.on('socket', (socket) => { applyNestedSocketTimeouts(socket, timeoutMs); });
      if (req.socket) applyNestedSocketTimeouts(req.socket, timeoutMs);
    }
    req.end('{}');
  });
}

test('server proxyAgentOptions omit timeout while direct agents keep idle pool timeout', () => {
  const source = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const proxy = source.match(/const proxyAgentOptions = \{([^}]+)\}/s);
  assert.ok(proxy, 'proxyAgentOptions must exist');
  assert.doesNotMatch(proxy[1], /\btimeout\b/, 'proxy agents must not receive Agent timeout (SOCKS/HTTPS apply it to in-flight raw sockets)');
  assert.match(source, /const directAgentOptions = \{[^}]*\btimeout:\s*60_000/s);
  assert.match(source, /function applyNestedSocketTimeouts\(/);
});

test('SOCKS+TLS: agent timeout hang-up; omit timeout or nested sync keeps attempt deadline', async (t) => {
  const upstream = https.createServer(tlsOptions, (req, res) => {
    req.resume();
    setTimeout(() => {
      if (res.destroyed) return;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    }, 800);
  });
  const upstreamPort = await listen(upstream);
  const { socks, port: socksPort } = await startSocksProxy();
  t.after(async () => { await close(socks); await close(upstream); });

  const proxyUrl = `socks5://127.0.0.1:${socksPort}`;
  const url = `https://127.0.0.1:${upstreamPort}/`;
  const hung = await onceHttps(url, {
    agent: new SocksProxyAgent(proxyUrl, { keepAlive: true, timeout: 400 }),
    timeoutMs: 3000,
  });
  assert.equal(hung.ok, false, `expected hang up, got ${JSON.stringify(hung)}`);
  assert.match(hung.message, /socket hang up/i);
  assert.ok(hung.ms < 700, `agent timeout must win before request timeout: ${hung.ms}ms`);

  const synced = await onceHttps(url, {
    agent: new SocksProxyAgent(proxyUrl, { keepAlive: true, timeout: 400 }),
    timeoutMs: 3000,
    syncNested: true,
  });
  assert.equal(synced.ok, true, synced.message);
  assert.equal(synced.status, 200);

  const omitted = await onceHttps(url, {
    agent: new SocksProxyAgent(proxyUrl, { keepAlive: true }),
    timeoutMs: 3000,
  });
  assert.equal(omitted.ok, true, omitted.message);
  assert.equal(omitted.status, 200);
  assert.ok(omitted.ms >= 700);
});

test('HTTPS CONNECT+TLS: omitting agent timeout matches server proxy contract', async (t) => {
  // HttpsProxyAgent passes timeout into net.connect but does not destroy on 'timeout'
  // the way SocksProxyAgent does; server still omits it for both proxy kinds.
  const upstream = https.createServer(tlsOptions, (req, res) => {
    req.resume();
    setTimeout(() => {
      if (res.destroyed) return;
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
    }, 800);
  });
  const upstreamPort = await listen(upstream);
  const proxy = http.createServer();
  proxy.on('connect', (req, client, head) => {
    const target = net.connect(upstreamPort, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) target.write(head);
      target.pipe(client);
      client.pipe(target);
    });
    target.on('error', () => client.destroy());
  });
  const proxyPort = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });

  const omitted = await onceHttps(`https://127.0.0.1:${upstreamPort}/`, {
    agent: new HttpsProxyAgent(`http://127.0.0.1:${proxyPort}`, { keepAlive: true }),
    timeoutMs: 3000,
  });
  assert.equal(omitted.ok, true, omitted.message);
  assert.equal(omitted.status, 200);
  assert.ok(omitted.ms >= 700);
});

test('nested socket timeout sync walks TLS parent / socket chain', () => {
  const parent = { setTimeoutCalls: [], setTimeout(ms) { this.setTimeoutCalls.push(ms); } };
  const child = { setTimeoutCalls: [], setTimeout(ms) { this.setTimeoutCalls.push(ms); }, _parent: parent };
  applyNestedSocketTimeouts(child, 5000);
  assert.deepEqual(child.setTimeoutCalls, [5000]);
  assert.deepEqual(parent.setTimeoutCalls, [5000]);
});
