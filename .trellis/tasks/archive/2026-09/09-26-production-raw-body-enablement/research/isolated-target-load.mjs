// Synthetic-only Docker-internal target load. Run in --mock or --client mode.
// No production credentials, paid upstreams, host ports or raw text output.
import http from 'node:http';

const MiB = 1024 * 1024;
const base = 'http://switcher:3123';
if (process.argv[2] === '--mock') {
  const chunk = 'R'.repeat(MiB);
  http.createServer((req, res) => {
    let head = '', bytes = 0;
    req.on('data', data => { bytes += data.length; if (head.length < 1024) head += data.subarray(0, 1024 - head.length).toString('utf8'); });
    req.on('end', () => {
      res.setHeader('Set-Cookie', 'fixture=synthetic-only');
      if (/"stream"\s*:\s*true/.test(head)) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: {"choices":[{"delta":{"content":"fixture-start"}}]}\n\n');
        const timer = setTimeout(() => { if (!res.destroyed) res.end('data: [DONE]\n\n'); }, 2500);
        res.once('close', () => clearTimeout(timer));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('{"echoBytes":' + bytes + ',"choices":[{"message":{"role":"assistant","content":"');
      for (let i = 0; i < 34; i++) res.write(chunk);
      res.end('"}}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}');
    });
  }).listen(8080, '0.0.0.0', () => console.log('synthetic-mock-ready'));
} else if (process.argv[2] === '--client' || process.argv[2] === '--overlap') {
  const overlap = process.argv[2] === '--overlap';
  const token = process.env.CLINE_PASS_ADMIN_PROXY_TOKEN;
  if (!/^[a-f0-9]{64}$/.test(token || '')) throw Error('missing synthetic attestation');
  // Script clients omit Origin, as permitted by the admin contract; Cookie+CSRF and
  // the synthetic private-proxy attestation remain mandatory on this network.
  const adminHeaders = { Host: 'switcher.fixture', 'X-Forwarded-Proto': 'https', 'X-Cline-Pass-Proxy-Token': token };
  const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { ...adminHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'fixture-only-next-admin-password-123456' }) });
  if (login.status !== 200) throw Error(`fixture login ${login.status}`);
  const cookie = login.headers.get('set-cookie')?.split(';')[0], session = await login.json();
  const admin = (route, extra = {}) => fetch(base + route, { ...extra, headers: { ...adminHeaders, Cookie: cookie, ...(extra.headers || {}) } });
  const before = await admin('/api/logs/settings').then(r => r.json());
  if (!before.rawBodyAvailable || before.rawBodyLogging) throw Error('isolated raw baseline not available/off');
  const set = await admin('/api/logs/settings', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrf }, body: JSON.stringify({ rawBodyLogging: true }) });
  if (set.status !== 200) throw Error(`isolated raw setting ${set.status}`);
  const accepted = await admin('/api/logs/settings').then(r => r.json());
  if (!accepted.rawBodyLogging || !accepted.detailedLogging) throw Error('isolated raw setting not accepted');
  const payload = JSON.stringify({ model: 'raw-fixture', stream: false, messages: [{ role: 'user', content: 'Q'.repeat(34 * MiB) }] });
  const started = Date.now();
  const send = async () => {
    const response = await fetch(base + '/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload, signal: AbortSignal.timeout(120000) });
    const text = await response.text();
    return { status: response.status, bytes: Buffer.byteLength(text), requestId: response.headers.get('x-cline-request-id'), valid: text.includes('"choices"') && text.endsWith('}}') };
  };
  const chats = await Promise.all([send(), send()]);
  if (chats.some(x => x.status !== 200 || !x.valid || x.bytes < 33 * MiB)) throw Error('chat parity failed');
  let rows;
  for (let i = 0; i < 50; i++) {
    const page = await admin('/api/logs/details?limit=20').then(r => r.json());
    rows = page.items || [];
    if (chats.every(chat => rows.some(row => row.requestId === chat.requestId && row.state !== 'open'))) break;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  const chosen = chats.map(chat => rows.find(row => row.requestId === chat.requestId));
  if (chosen.some(row => !row || row.profile !== 'raw-full')) throw Error('raw group missing');
  const group = await admin('/api/logs/details/' + chats[0].requestId).then(r => r.json());
  const safe = JSON.stringify({ request: group.request, attempts: group.attempts, list: rows });
  if (safe.includes('synthetic-only') || safe.includes('authorization') && !safe.includes('[REDACTED]')) throw Error('unsafe diagnostic projection');
  const bodyId = group.bodies.find(body => body.capturedBytes > 0)?.bodyId;
  let slowRead = false;
  const readSlowly = async () => {
    if (!bodyId) return;
    const response = await admin('/api/logs/details/' + chats[0].requestId + '/bodies/' + bodyId);
    if (response.ok && response.body) {
      const reader = response.body.getReader(); await reader.read();
      await new Promise(resolve => setTimeout(resolve, overlap ? 3500 : 1500));
      await reader.cancel(); slowRead = true;
    }
  };
  const streamOnce = async () => {
    const controller = new AbortController();
    const stream = await fetch(base + '/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'raw-fixture', stream: true, messages: [{ role: 'user', content: 'synthetic' }] }), signal: controller.signal });
    if (stream.status !== 200) throw Error(`SSE status ${stream.status}`);
    const first = await stream.body.getReader().read();
    if (!new TextDecoder().decode(first.value).includes('data:')) throw Error('SSE first data missing');
    controller.abort();
    await new Promise(resolve => setTimeout(resolve, 300));
  };
  let extra = null;
  if (overlap) {
    const [, third] = await Promise.all([readSlowly(), send(), streamOnce()]);
    if (third.status !== 200 || !third.valid || third.bytes < 33 * MiB) throw Error('overlap chat parity failed');
    extra = { status: third.status, bytes: third.bytes };
  } else { await readSlowly(); await streamOnce(); }
  const after = await admin('/api/logs/settings').then(r => r.json());
  const results = { kind: 'isolated-raw-load', overlap, concurrency: overlap ? 3 : 2, requestMiB: 34, responseMiB: 34, chats: chats.map(({status,bytes}) => ({status,bytes})), extra, elapsedMs: Date.now() - started, rawGroups: chosen.length, slowRead, sseFirstDataAndCancel: true, dropped: after.health?.dropped ?? null, dropReasons: after.health?.dropReasons ?? null };
  console.log(JSON.stringify(results));
} else throw Error('expected --mock or --client');
