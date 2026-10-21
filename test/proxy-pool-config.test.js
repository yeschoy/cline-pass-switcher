// proxyPool 配置接线（启动 / POST /api/accounts / 热加载 / revision）与 transport 出口选择。
// 只使用本地假上游、假 SOCKS5 和假 FloppyData API；凭据全部是占位值。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { prepareAdminFixture } from './admin-fixture.js';
import { USER, PASS, API_KEY, listen, close, waitFor, setup, manualPool, socksUrl } from './proxy-pool-fixture.js';

test('legacy config without proxyPool keeps exact bytes across restart and saves that omit or default it', async (t) => {
  const s = await setup(t);
  await s.start({});
  await s.stop();
  const normalized = s.bytes();
  assert.equal(Object.hasOwn(s.read(), 'proxyPool'), false);
  await s.start();
  assert.equal(s.bytes(), normalized, 'second startup does not write proxyPool');
  const view = await s.get();
  assert.equal(view.proxyPool.enabled, false, 'GET projects the disabled default');
  const saved = await s.save();
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal(saved.data.configurationRevision, view.configurationRevision, 'absent proxyPool does not change the revision');
  assert.equal(s.bytes(), normalized, 'save without proxyPool keeps bytes');
  const echoed = await s.save({ proxyPool: view.proxyPool });
  assert.equal(echoed.status, 200);
  assert.equal(s.bytes(), normalized, 'echoing the disabled default keeps the field absent');
  assert.equal((await s.post('/api/config/reload', {})).data.changed.length, 0);
  assert.equal(s.bytes(), normalized);
  assert.equal(await s.chat(), 200);
  assert.deepEqual(s.seen, ['direct']);
});

test('POST /api/accounts validates proxyPool strictly, persists valid input, keeps it when omitted and guards the revision', async (t) => {
  const s = await setup(t);
  await s.start({});
  const original = s.bytes();
  const url = socksUrl(1080);
  const invalid = [
    null, 'on', { enabled: 'yes' }, { unknown: 1 }, manualPool(['ftp://127.0.0.1:21']), manualPool([`${url}/path`]), manualPool([url, url]),
    manualPool(Array.from({ length: 2001 }, (_, i) => `socks5://127.0.0.1:${1000 + i}`)), manualPool([]),
    { enabled: true, source: 'floppydata' }, { egressRetries: 6 }, { connectTimeoutMs: 999 }, { maxRpmPerProxy: -1 }, { strategy: 'fastest' },
    { floppydata: { rotation: 7 } }, { floppydata: { count: 0 } }, { floppydata: { refreshIntervalMs: 59999 } }, { floppydata: { country: 'USA' } },
    { floppydata: { apiBase: 'https://example.invalid/v2' } }, { floppydata: { apiKey: 'has space' } },
  ];
  for (const proxyPool of invalid) {
    const result = await s.save({ proxyPool });
    assert.equal(result.status, 400, `rejects ${JSON.stringify(proxyPool)?.slice(0, 80)}`);
    assert.equal(s.bytes(), original, 'rejected save leaves config bytes unchanged');
    assert.doesNotMatch(JSON.stringify(result.data), new RegExp(`${USER}|${PASS}|${API_KEY}`), 'error does not echo credentials');
  }

  const before = await s.get();
  const pool = manualPool([url, 'http://127.0.0.1:3128'], { strategy: 'random', egressRetries: 1, floppydata: { apiKey: API_KEY, count: 3 } });
  const saved = await s.save({ proxyPool: pool });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.notEqual(saved.data.configurationRevision, before.configurationRevision, 'proxyPool is part of the configuration revision');
  const persisted = s.read().proxyPool;
  assert.equal(persisted.enabled, true); assert.equal(persisted.strategy, 'random'); assert.equal(persisted.egressRetries, 1);
  assert.deepEqual(persisted.entries, [url, 'http://127.0.0.1:3128/']);
  assert.equal(persisted.floppydata.apiKey, API_KEY); assert.equal(persisted.floppydata.count, 3); assert.equal(persisted.floppydata.protocol, 'socks5');
  assert.deepEqual((await s.get()).proxyPool, persisted, 'GET returns the persisted value to the administrator');

  const kept = await s.save({ mode: 'roundrobin' });
  assert.equal(kept.status, 200);
  assert.deepEqual(s.read().proxyPool, persisted, 'omitting proxyPool keeps the server value');

  const afterKept = s.bytes();
  const conflict = await s.save({ proxyPool: { ...persisted, enabled: false }, expectedConfigurationRevision: before.configurationRevision });
  assert.equal(conflict.status, 409);
  assert.equal(s.bytes(), afterKept, 'stale revision does not overwrite');
  const disabled = await s.save({ proxyPool: { ...persisted, enabled: false } });
  assert.equal(disabled.status, 200);
  assert.equal(s.read().proxyPool.enabled, false);
  assert.deepEqual(s.read().proxyPool.entries, persisted.entries, 'disabled pool keeps its entries');
});

test('startup rejects an invalid proxyPool without rewriting config', async (t) => {
  const s = await setup(t);
  s.writeConfig({ proxyPool: manualPool([socksUrl(1080), socksUrl(1080)]) });
  const original = s.bytes();
  prepareAdminFixture(s.dir);
  const child = spawn(process.execPath, ['server.js'], { cwd: path.resolve('.'), env: { PATH: process.env.PATH, DATA_DIR: s.dir, BIND_HOST: '127.0.0.1', NODE_ENV: 'test' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (d) => { output += d; }); child.stderr.on('data', (d) => { output += d; });
  const code = await new Promise((resolve) => child.once('exit', resolve));
  assert.notEqual(code, 0);
  assert.match(output, /proxyPool\.entries\[1\]/);
  assert.doesNotMatch(output, new RegExp(`${USER}|${PASS}`));
  assert.equal(s.bytes(), original);
});

test('manual pool round-robins egress, overrides the account proxy, falls back when exhausted and toggles via reload/SIGHUP', async (t) => {
  let throttle = new Set();
  const s = await setup(t, { responder(via, res) {
    if (throttle.has(via)) { res.writeHead(429, { 'Content-Type': 'text/html' }); return res.end('<html>429 Too Many Requests</html>'); }
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }));
  } });
  const auth = (user, pass) => user === USER && pass === PASS;
  const [a, b, c, own] = [await s.socks('A', { auth }), await s.socks('B', { auth }), await s.socks('C'), await s.socks('own')];
  const accounts = [{ id: 'a0', name: 'a0', key: 'local-a0', enabled: true, maxConcurrent: 0, priority: 10, proxyUrl: `socks5://127.0.0.1:${own.port}` }];
  await s.start({ accounts });
  for (let i = 0; i < 2; i++) assert.equal(await s.chat(), 200);
  assert.deepEqual(s.seen, ['own', 'own'], 'disabled pool keeps the account proxy');

  const fileBefore = s.read();
  fs.writeFileSync(s.file, JSON.stringify({ ...fileBefore, proxyPool: manualPool([socksUrl(a.port), socksUrl(b.port), `socks5://127.0.0.1:${c.port}`]) }, null, 2));
  const reloaded = await s.post('/api/config/reload', {});
  assert.equal(reloaded.status, 200, JSON.stringify(reloaded.data));
  assert.deepEqual(reloaded.data.changed, ['proxyPool']);
  s.seen.length = 0;
  for (let i = 0; i < 6; i++) assert.equal(await s.chat(), 200);
  assert.deepEqual(s.seen, ['A', 'B', 'C', 'A', 'B', 'C'], 'round-robin across entries; the account proxy receives nothing');

  // HTML 429 on A cools only A: the chat-chain egress retry immediately moves to the next entry.
  throttle = new Set(['A']); s.seen.length = 0;
  assert.equal(await s.chat(), 200);
  assert.deepEqual(s.seen, ['A', 'B']);
  assert.equal(await s.chat(), 200);
  assert.equal(await s.chat(), 200);
  assert.deepEqual(s.seen.slice(2), ['C', 'B'], 'cooling entry A is skipped');

  // C then B throttle: no other entry is available (A is still cooling), so the request stops with 429
  // instead of adding an attempt on the account egress. The next request, with every entry cooling,
  // falls back to the account's own proxy.
  throttle = new Set(['B', 'C']); s.seen.length = 0;
  assert.equal(await s.chat(), 429);
  assert.deepEqual(s.seen, ['C', 'B']);
  assert.equal(await s.chat(), 200);
  assert.deepEqual(s.seen.slice(2), ['own'], 'fallback uses the account egress');

  // Invalid reload is refused and leaves the file and the live pool unchanged.
  const live = s.bytes();
  fs.writeFileSync(s.file, JSON.stringify({ ...s.read(), proxyPool: { ...s.read().proxyPool, egressRetries: 9 } }, null, 2));
  const invalidBytes = s.bytes();
  const refused = await s.post('/api/config/reload', {});
  assert.equal(refused.status, 400);
  assert.match(refused.data.error.message, /proxyPool\.egressRetries/);
  assert.equal(s.bytes(), invalidBytes, 'refused reload does not rewrite the file');
  fs.writeFileSync(s.file, live);

  // SIGHUP disables the pool: traffic returns to the account proxy immediately.
  const disabled = s.read(); disabled.proxyPool.enabled = false;
  fs.writeFileSync(s.file, JSON.stringify(disabled, null, 2));
  throttle = new Set(); s.child.kill('SIGHUP');
  await waitFor(async () => (await s.get()).proxyPool.enabled === false, 'SIGHUP disable');
  s.seen.length = 0;
  assert.equal(await s.chat(), 200);
  assert.deepEqual(s.seen, ['own']);
});

test('a pool entry that fails during the proxy handshake cools down without hiding other entries', async (t) => {
  const s = await setup(t);
  let deadHits = 0;
  const dead = net.createServer((socket) => { deadHits++; socket.destroy(); });
  const deadPort = await listen(dead);
  t.after(() => close(dead));
  const a = await s.socks('A');
  await s.start({ proxyPool: manualPool([`socks5://127.0.0.1:${deadPort}`, `socks5://127.0.0.1:${a.port}`]) });
  const statuses = [];
  for (let i = 0; i < 4; i++) statuses.push(await s.chat());
  assert.equal(deadHits, 1, 'connect-phase failure puts the entry into cooldown');
  assert.deepEqual(statuses.slice(1), [200, 200, 200]);
  assert.ok(s.seen.every((via) => via === 'A'));
});

test('floppydata source imports a batch on startup and stops when disabled', async (t) => {
  const s = await setup(t);
  const calls = [];
  const auth = (user, pass) => user.startsWith('user-test-session-') && pass === PASS;
  const a = await s.socks('A', { auth });
  const api = http.createServer((req, res) => {
    let raw = ''; req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      calls.push({ path: req.url, key: req.headers['x-api-key'], session: body.session });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ connection: { connectionString: `socks5://user-test-session-${body.session}:${PASS}@127.0.0.1:${a.port}` } }));
    });
  });
  const apiPort = await listen(api);
  t.after(() => close(api));
  await s.start({ proxyPool: { enabled: true, source: 'floppydata', floppydata: { apiKey: API_KEY, apiBase: `http://127.0.0.1:${apiPort}`, count: 2 } } });
  await waitFor(() => calls.length === 2, 'floppydata batch');
  assert.ok(calls.every((call) => call.path === '/v2/proxy/rotating/connections' && call.key === API_KEY));
  assert.equal(new Set(calls.map((call) => call.session)).size, 2, 'each call uses a distinct session');
  assert.equal(Object.hasOwn(s.read().proxyPool, 'entries') ? s.read().proxyPool.entries.length : 0, 0, 'imported entries are not persisted');
  await waitFor(async () => { s.seen.length = 0; return await s.chat() === 200 && s.seen[0] === 'A'; }, 'chat through imported entry');

  const disabled = s.read(); disabled.proxyPool.enabled = false;
  fs.writeFileSync(s.file, JSON.stringify(disabled, null, 2));
  assert.equal((await s.post('/api/config/reload', {})).status, 200);
  s.seen.length = 0;
  assert.equal(await s.chat(), 200);
  assert.deepEqual(s.seen, ['direct']);
  assert.equal(calls.length, 2, 'disabled source makes no further API calls');
  assert.doesNotMatch(s.child.output(), new RegExp(`${API_KEY}|${PASS}|user-test-session-`));
});

test('a pool entry that never completes the proxy handshake is cut off by connectTimeoutMs, cooled, and the request moves to another entry', async (t) => {
  const s = await setup(t);
  let hangHits = 0;
  const held = new Set();
  const hang = net.createServer((socket) => { hangHits++; held.add(socket); socket.on('error', () => {}); });
  const hangPort = await listen(hang);
  t.after(() => { for (const socket of held) socket.destroy(); return close(hang); });
  const a = await s.socks('A');
  await s.start({ proxyPool: manualPool([`socks5://127.0.0.1:${hangPort}`, `socks5://127.0.0.1:${a.port}`], { connectTimeoutMs: 1000 }) });
  const started = Date.now();
  const first = await s.chat();
  const elapsed = Date.now() - started;
  // 连接阶段超时后同一请求立即换到另一个池条目（egressRetries），客户端拿到成功。
  assert.equal(first, 200);
  assert.ok(elapsed >= 900 && elapsed < 10000, `connect timeout bounded the attempt (${elapsed}ms)`);
  for (let i = 0; i < 3; i++) assert.equal(await s.chat(), 200);
  assert.equal(hangHits, 1);
  assert.deepEqual(s.seen, ['A', 'A', 'A', 'A']);
});

// ---------- proxyPoolClientKeys：按客户端密钥开关 ----------
const LEGACY_KEY = 'legacy-test-client-key', KEY_A = 'client-key-a-0000000000', KEY_B = 'client-key-b-0000000000';
const twoKeys = (extra = {}) => ({ proxyKey: LEGACY_KEY, clientKeys: [{ id: 'ck_a', name: 'A', key: KEY_A }, { id: 'ck_b', name: 'B', key: KEY_B }],
  accounts: [{ id: 'a0', clientKeyId: 'ck_a', name: 'a0', key: 'local-a0', enabled: true, maxConcurrent: 0, priority: 10 }], ...extra });
const noKeyValues = (text, label) => { for (const secret of [LEGACY_KEY, KEY_A, KEY_B]) assert.equal(String(text).includes(secret), false, `${label} must not contain a client key value`); };

test('proxyPoolClientKeys: absent keeps bytes and revision; strict 400s keep bytes; valid saves persist, omit keeps, stale revision 409', async (t) => {
  const s = await setup(t);
  await s.start(twoKeys({ proxyPool: manualPool([socksUrl(1080)]) }));
  await s.stop();
  const normalized = s.bytes();
  assert.equal(Object.hasOwn(s.read(), 'proxyPoolClientKeys'), false);
  await s.start();
  assert.equal(s.bytes(), normalized, 'restart does not write the default');
  const view = await s.get();
  assert.deepEqual(view.proxyPoolClientKeys, { default: 'on', overrides: {} }, 'GET projects the default object');
  const echoed = await s.save({ proxyPoolClientKeys: view.proxyPoolClientKeys });
  assert.equal(echoed.status, 200, JSON.stringify(echoed.data));
  assert.equal(echoed.data.configurationRevision, view.configurationRevision, 'absent field does not change the revision');
  assert.equal(s.bytes(), normalized, 'echoing the default keeps the field absent');
  assert.equal((await s.save()).status, 200);
  assert.equal(s.bytes(), normalized, 'omitting keeps the field absent');

  const invalid = [null, 'on', [], { default: 'maybe' }, { default: 'on', extra: true }, { overrides: [] }, { overrides: { ck_a: 'default' } },
    { overrides: { ck_gone: 'on' } }, { overrides: { [KEY_A]: 'on' } }, { [KEY_B]: 'on' }];
  for (const proxyPoolClientKeys of invalid) {
    const result = await s.save({ proxyPoolClientKeys });
    assert.equal(result.status, 400, `rejects ${JSON.stringify(proxyPoolClientKeys)}`);
    assert.match(result.data.error.message, /^proxyPoolClientKeys/);
    assert.equal(s.bytes(), normalized, 'rejected save leaves bytes unchanged');
    noKeyValues(JSON.stringify(result.data), 'error');
  }

  const scope = { default: 'off', overrides: { ck_a: 'on', legacy: 'off' } };
  const saved = await s.save({ proxyPoolClientKeys: scope });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.notEqual(saved.data.configurationRevision, view.configurationRevision, 'a present field is part of the revision');
  assert.deepEqual(s.read().proxyPoolClientKeys, scope);
  assert.deepEqual((await s.get()).proxyPoolClientKeys, scope);
  const kept = await s.save({ mode: 'roundrobin' });
  assert.equal(kept.status, 200);
  assert.deepEqual(s.read().proxyPoolClientKeys, scope, 'omitting keeps the server value');
  const live = s.bytes();
  const stale = await s.save({ proxyPoolClientKeys: { default: 'on', overrides: {} }, expectedConfigurationRevision: view.configurationRevision });
  assert.equal(stale.status, 409);
  assert.equal(s.bytes(), live);
  const reset = await s.save({ proxyPoolClientKeys: { default: 'on', overrides: {} } });
  assert.equal(reset.status, 200);
  assert.deepEqual(s.read().proxyPoolClientKeys, { default: 'on', overrides: {} }, 'a present field stays present at its default');
});

test('proxyPoolClientKeys: startup and reload reject invalid values without rewriting; SIGHUP applies a valid change; deleting a key prunes its override', async (t) => {
  const s = await setup(t);
  s.writeConfig(twoKeys({ proxyPoolClientKeys: { default: 'on', overrides: { ck_x: 'off' } } }));
  const original = s.bytes();
  prepareAdminFixture(s.dir);
  const child = spawn(process.execPath, ['server.js'], { cwd: path.resolve('.'), env: { PATH: process.env.PATH, DATA_DIR: s.dir, BIND_HOST: '127.0.0.1', NODE_ENV: 'test' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (d) => { output += d; }); child.stderr.on('data', (d) => { output += d; });
  assert.notEqual(await new Promise((resolve) => child.once('exit', resolve)), 0);
  assert.match(output, /proxyPoolClientKeys\.overrides contains an unknown client key id/);
  noKeyValues(output, 'startup output');
  assert.equal(s.bytes(), original, 'failed startup keeps bytes');

  await s.start(twoKeys({ proxyPool: manualPool([socksUrl(1080)]), proxyPoolClientKeys: { overrides: { ck_b: 'off' } } }));
  assert.deepEqual(s.read().proxyPoolClientKeys, { default: 'on', overrides: { ck_b: 'off' } }, 'a present field is normalized and written back');
  for (const proxyPoolClientKeys of [{ default: 'nope' }, { overrides: { ck_gone: 'on' } }, { default: 'on', other: 1 }]) {
    fs.writeFileSync(s.file, JSON.stringify({ ...s.read(), proxyPoolClientKeys }, null, 2));
    const bytes = s.bytes();
    const refused = await s.post('/api/config/reload', {});
    assert.equal(refused.status, 400);
    assert.match(refused.data.error.message, /proxyPoolClientKeys/);
    assert.equal(s.bytes(), bytes, 'refused reload does not rewrite the file');
  }
  assert.deepEqual((await s.get()).proxyPoolClientKeys, { default: 'on', overrides: { ck_b: 'off' } }, 'live value unchanged');

  fs.writeFileSync(s.file, JSON.stringify({ ...s.read(), proxyPoolClientKeys: { default: 'off', overrides: { ck_a: 'on', ck_b: 'on' } } }, null, 2));
  s.child.kill('SIGHUP');
  await waitFor(async () => (await s.get()).proxyPoolClientKeys.default === 'off', 'SIGHUP applies proxyPoolClientKeys');
  const status = await s.get('/api/proxy-pool/status');
  assert.deepEqual(status.clientKeys, [
    { id: 'legacy', name: '默认密钥', mode: 'default', effective: false },
    { id: 'ck_a', name: 'A', mode: 'on', effective: true },
    { id: 'ck_b', name: 'B', mode: 'on', effective: true },
  ]);
  noKeyValues(JSON.stringify(status), 'status');

  const before = await s.get();
  const deleted = await fetch(`http://127.0.0.1:${s.port}/api/security/client-keys/ck_b`, { method: 'DELETE' });
  assert.equal(deleted.status, 200);
  assert.deepEqual(s.read().proxyPoolClientKeys, { default: 'off', overrides: { ck_a: 'on' } }, 'the override is removed in the same write');
  assert.deepEqual(s.read().clientKeys.map((row) => row.id), ['ck_a']);
  const after = await s.get();
  assert.deepEqual(after.proxyPoolClientKeys, { default: 'off', overrides: { ck_a: 'on' } });
  assert.notEqual(after.configurationRevision, before.configurationRevision);
  assert.deepEqual((await s.get('/api/proxy-pool/status')).clientKeys.map((key) => key.id), ['legacy', 'ck_a']);
  await s.stop();
  await s.start();
  assert.deepEqual((await s.get()).proxyPoolClientKeys, { default: 'off', overrides: { ck_a: 'on' } }, 'the pruned config boots');
});

// ---------- proxyPoolDirect：把本机直连作为池中的隐式出口 ----------
test('proxyPoolDirect: absent keeps bytes and revision; non-boolean is a 400 that keeps bytes; booleans persist, omit keeps, SIGHUP applies it', async (t) => {
  const s = await setup(t);
  await s.start({ proxyPool: manualPool([socksUrl(1080)]) });
  await s.stop();
  const normalized = s.bytes();
  assert.equal(Object.hasOwn(s.read(), 'proxyPoolDirect'), false);
  await s.start();
  assert.equal(s.bytes(), normalized, 'restart does not write the default');
  const view = await s.get();
  assert.equal(view.proxyPoolDirect, false, 'GET projects false when absent');
  const echoed = await s.save({ proxyPoolDirect: false });
  assert.equal(echoed.status, 200, JSON.stringify(echoed.data));
  assert.equal(echoed.data.configurationRevision, view.configurationRevision, 'absent field does not change the revision');
  assert.equal(s.bytes(), normalized, 'false keeps the field absent');
  assert.equal((await s.save()).status, 200); assert.equal(s.bytes(), normalized, 'omitting keeps it absent');

  for (const proxyPoolDirect of [null, 'true', 1, [], {}]) {
    const result = await s.save({ proxyPoolDirect });
    assert.equal(result.status, 400, `rejects ${JSON.stringify(proxyPoolDirect)}`);
    assert.match(result.data.error.message, /^proxyPoolDirect must be boolean/);
    assert.equal(s.bytes(), normalized, 'rejected save leaves bytes unchanged');
  }
  assert.equal((await s.get('/api/proxy-pool/status')).entries.length, 1);
  const saved = await s.save({ proxyPoolDirect: true });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.notEqual(saved.data.configurationRevision, view.configurationRevision, 'a present field is part of the revision');
  assert.equal(s.read().proxyPoolDirect, true);
  const status = await s.get('/api/proxy-pool/status');
  assert.equal(status.total, 2, 'the implicit direct entry joined the pool at once');
  assert.deepEqual(status.entries.filter((entry) => entry.scheme === 'direct').map((entry) => entry.endpointKey), ['direct://local']);
  assert.equal((await s.save({ mode: 'roundrobin' })).status, 200);
  assert.equal(s.read().proxyPoolDirect, true, 'omitting keeps the server value');

  // SIGHUP: 关闭 / 重新开启；非法值被拒绝且不改文件。
  fs.writeFileSync(s.file, JSON.stringify({ ...s.read(), proxyPoolDirect: false }, null, 2));
  s.child.kill('SIGHUP');
  await waitFor(async () => (await s.get('/api/proxy-pool/status')).total === 1, 'SIGHUP removes the direct entry');
  fs.writeFileSync(s.file, JSON.stringify({ ...s.read(), proxyPoolDirect: 'yes' }, null, 2));
  const bytes = s.bytes();
  const refused = await s.post('/api/config/reload', {});
  assert.equal(refused.status, 400); assert.match(refused.data.error.message, /proxyPoolDirect/);
  assert.equal(s.bytes(), bytes, 'refused reload does not rewrite the file');
  // 关闭代理池时不留直连条目。
  fs.writeFileSync(s.file, JSON.stringify({ ...s.read(), proxyPoolDirect: true, proxyPool: { ...s.read().proxyPool, enabled: false } }, null, 2));
  s.child.kill('SIGHUP');
  await waitFor(async () => (await s.get()).proxyPoolDirect === true, 'SIGHUP applies proxyPoolDirect');
  assert.equal((await s.get('/api/proxy-pool/status')).entries.length, 0, 'a disabled pool has no entries, not even the direct one');
});

test('proxyPoolDirect: an invalid value fails startup without rewriting the file', async (t) => {
  const s = await setup(t);
  s.writeConfig({ proxyPoolDirect: 'yes' });
  const original = s.bytes();
  prepareAdminFixture(s.dir);
  const child = spawn(process.execPath, ['server.js'], { cwd: path.resolve('.'), env: { PATH: process.env.PATH, DATA_DIR: s.dir, BIND_HOST: '127.0.0.1', NODE_ENV: 'test' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (d) => { output += d; }); child.stderr.on('data', (d) => { output += d; });
  assert.notEqual(await new Promise((resolve) => child.once('exit', resolve)), 0);
  assert.match(output, /invalid proxyPoolDirect/);
  assert.equal(s.bytes(), original, 'failed startup keeps bytes');
});
