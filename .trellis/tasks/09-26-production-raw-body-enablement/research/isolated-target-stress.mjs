// Synthetic-only stress client for the committed image on a Docker-internal network.
// Requires isolated-target-load.mjs --mock and four actual paused raw body reads.
import net from 'node:net';
import { createHash } from 'node:crypto';
const MiB = 1024 * 1024, base = 'http://switcher:3123';
const token = process.env.CLINE_PASS_ADMIN_PROXY_TOKEN;
if (!/^[a-f0-9]{64}$/.test(token || '')) throw Error('missing synthetic attestation');
const adminHeaders = { Host: 'switcher.fixture', 'X-Forwarded-Proto': 'https', 'X-Cline-Pass-Proxy-Token': token };
const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { ...adminHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'fixture-only-next-admin-password-123456' }) });
if (login.status !== 200) throw Error('fixture login status ' + login.status);
const cookie = login.headers.get('set-cookie')?.split(';')[0], session = await login.json();
const admin = (route, extra = {}) => fetch(base + route, { ...extra, headers: { ...adminHeaders, Cookie: cookie, ...(extra.headers || {}) } });
const payload = JSON.stringify({ model: 'raw-fixture', stream: false, messages: [{ role: 'user', content: 'Q'.repeat(34 * MiB) }] });
const payloadBytes = Buffer.byteLength(payload);
const hash = text => createHash('sha256').update(text).digest('hex');
const send = async () => {
  const response = await fetch(base + '/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload, signal: AbortSignal.timeout(120000) });
  const text = await response.text();
  return { status: response.status, bytes: Buffer.byteLength(text), hash: hash(text), id: response.headers.get('x-cline-request-id'), echo: text.includes('"echoBytes":' + payloadBytes) };
};
const before = await admin('/api/logs/settings').then(r => r.json());
if (!before.rawBodyAvailable || before.rawBodyLogging) throw Error('isolated raw baseline not off/available');
const baseline = await send();
if (baseline.status !== 200 || baseline.bytes < 33 * MiB || !baseline.echo) throw Error('raw-off chat baseline failed');
const setting = await admin('/api/logs/settings', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrf }, body: JSON.stringify({ rawBodyLogging: true }) });
if (setting.status !== 200 || !(await admin('/api/logs/settings').then(r => r.json())).rawBodyLogging) throw Error('isolated opt-in failed');
const seed = await send();
if (seed.status !== baseline.status || seed.bytes !== baseline.bytes || seed.hash !== baseline.hash || !seed.echo) throw Error('raw-on seed parity failed');
let group;
for (let i = 0; i < 50; i++) {
  group = await admin('/api/logs/details/' + seed.id).then(r => r.json());
  if (group.request?.profile === 'raw-full' && group.request.state !== 'open') break;
  await new Promise(resolve => setTimeout(resolve, 200));
}
const body = group?.bodies?.find(x => x.capturedBytes >= 33 * MiB);
if (!body) throw Error('seed raw body missing or resource-limited');
const bodyRoute = '/api/logs/details/' + seed.id + '/bodies/' + body.bodyId;
function pauseBody() {
  return new Promise((resolve, reject) => {
    const socket = net.connect(3123, 'switcher'); let head = '';
    socket.setTimeout(10000, () => { socket.destroy(); reject(Error('paused body timeout')); });
    socket.once('connect', () => socket.write(`GET ${bodyRoute} HTTP/1.1\r\nHost: switcher.fixture\r\nCookie: ${cookie}\r\nX-Forwarded-Proto: https\r\nX-Cline-Pass-Proxy-Token: ${token}\r\nConnection: close\r\n\r\n`));
    socket.on('data', chunk => {
      head += chunk.subarray(0, Math.max(0, 4096 - head.length)).toString();
      if (head.includes('\r\n\r\n')) {
        if (!/^HTTP\/1\.1 200/.test(head)) { socket.destroy(); reject(Error('paused body not admitted')); return; }
        socket.pause(); socket.setTimeout(0); resolve(socket);
      }
    });
    socket.once('error', reject);
    socket.once('close', () => { if (!head.includes('\r\n\r\n')) reject(Error('body closed before header')); });
  });
}
const held = [];
try {
  for (let i = 0; i < 4; i++) held.push(await pauseBody());
  const denied = await admin(bodyRoute);
  if (denied.status !== 503) throw Error('four paused raw reads were not held; fifth status ' + denied.status);
  await denied.body?.cancel();
  const streamOnce = async () => {
    const controller = new AbortController();
    const stream = await fetch(base + '/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'raw-fixture', stream: true, messages: [{ role: 'user', content: 'synthetic' }] }), signal: controller.signal });
    if (stream.status !== 200) throw Error('stream status ' + stream.status);
    const first = await stream.body.getReader().read();
    if (!new TextDecoder().decode(first.value).includes('data:')) throw Error('first SSE data missing');
    controller.abort();
  };
  const chats = await Promise.all([send(), send(), send(), streamOnce()]).then(xs => xs.slice(0, 3));
  if (chats.some(x => x.status !== baseline.status || x.bytes !== baseline.bytes || x.hash !== baseline.hash || !x.echo)) throw Error('three-way raw chat parity failed');
  const after = await admin('/api/logs/settings').then(r => r.json());
  console.log(JSON.stringify({ kind: 'isolated-raw-stress', concurrentLargeChats: 3, heldRawDownloads: 4, fifthReadDenied: denied.status, requestBytes: payloadBytes, responseBytes: baseline.bytes, responseHashParity: true, sseFirstDataAndCancel: true, dropped: after.health?.dropped ?? null, dropReasons: after.health?.dropReasons ?? null }));
} finally {
  for (const socket of held) socket.destroy();
}
