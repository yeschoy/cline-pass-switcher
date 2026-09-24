import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const clientKey = 'client-fixture-key-123';
const code = 'one-time-independent-code-123';
const newPassword = 'independent-admin-password-456';
const port = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
async function run(dir, p, env = {}) {
  const child = spawn(process.execPath, ['server.js'], { cwd: path.resolve('.'), env: {
    ...process.env, DATA_DIR: dir, PORT: String(p), BIND_HOST: '127.0.0.1', NODE_ENV: 'test',
    PROXY_KEY: clientKey, CLINE_PASS_ADMIN_BOOTSTRAP: '1', CLINE_PASS_ADMIN_INIT_CODE: code, ...env,
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; });
  await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(Error('startup timeout')), 5000);
    const timer = setInterval(() => { if (output.includes('OpenAI 兼容代理地址')) { clearInterval(timer); clearTimeout(deadline); resolve(); } }, 25);
    child.once('exit', c => { clearInterval(timer); clearTimeout(deadline); reject(Error(`exit ${c}: ${output}`)); });
  });
  child.capture = () => output;
  return child;
}
async function stop(child) { await new Promise(resolve => { child.once('exit', resolve); child.kill('SIGTERM'); setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 1500).unref(); }); }
async function call(p, url, { method = 'GET', body, cookie, csrf, headers = {} } = {}) {
  const res = await fetch(`http://127.0.0.1:${p}${url}`, { method, headers: {
    ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...headers,
  }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text(); let json; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text, cookie: res.headers.get('set-cookie')?.split(';')[0], headers: res.headers };
}
const adminRoutes = [
  ['GET','/api/models'], ['GET','/api/accounts'], ['POST','/api/accounts'], ['GET','/api/security'], ['POST','/api/security'],
  ['GET','/api/config'], ['POST','/api/config'], ['GET','/api/history'], ['GET','/api/statistics'], ['POST','/api/statistics/quota-refresh'],
  ['POST','/api/probe'], ['POST','/api/test'], ['POST','/api/validate-upstreams'], ['POST','/api/fetch-official-models'],
  ['GET','/api/model-aliases'], ['POST','/api/model-aliases'], ['POST','/api/accounts/recover'], ['POST','/api/providers/recover'],
  ['POST','/api/accounts/test'], ['POST','/api/accounts/proxy-test'], ['GET','/api/logs/settings'], ['POST','/api/logs/settings'],
  ['GET','/api/logs/details'], ['DELETE','/api/logs/details'], ['GET','/api/logs/details/id'], ['GET','/api/logs/details/id/bodies/id'],
  ['GET','/api/logs/requests'], ['DELETE','/api/logs/requests'], ['GET','/api/logs/errors'], ['DELETE','/api/logs/errors'],
];

test('independent admin bootstrap, route matrix, CSRF, revocation, restart and client rotation', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cps-admin-')); const p = await port();
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ port: p, proxyKey: 'stale-config-key', detailedLogging: true, accounts: [] }));
  let child;
  try {
    child = await run(dir, p);
    const adminPath = path.join(dir, 'admin-auth.json');
    assert.equal(fs.statSync(adminPath).mode & 0o777, 0o600);
    const original = fs.readFileSync(adminPath, 'utf8');
    assert.equal(original.includes(clientKey) || original.includes(code), false);
    for (const [method, route] of adminRoutes) {
      const denied = await call(p, route, { method, body: method === 'POST' ? {} : undefined, headers: { Authorization: `Bearer ${clientKey}`, 'X-Admin-Key': clientKey } });
      assert.equal(denied.status, 401, route);
      assert.equal(denied.headers.get('access-control-allow-origin'), null);
      assert.equal(denied.headers.get('cache-control'), 'no-store');
    }
    assert.equal((await call(p, '/api/meta')).status, 200);
    assert.equal((await call(p, '/v1/responses', { method: 'POST' })).status, 401);
    assert.equal((await call(p, '/v1/responses', { method: 'POST', headers: { Authorization: `Bearer ${clientKey}` } })).status, 501);
    assert.equal((await call(p, '/models', { headers: { Authorization: `Bearer ${clientKey}` } })).status, 200);
    assert.equal((await call(p, '/api/auth/login', { method: 'POST', body: { password: clientKey } })).status, 401);
    const tooLarge = await new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port: p, path: '/api/auth/bootstrap', method: 'POST', headers: { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' } }, res => {
        res.resume(); res.once('end', () => { req.destroy(); resolve(res.statusCode); });
      });
      req.on('error', error => error.code === 'ECONNRESET' ? resolve('reset') : reject(error)); req.end(' '.repeat(5000));
    });
    assert.equal(tooLarge, 413, 'oversized authentication body returns a bounded rejection');
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(child.exitCode, null, child.capture());
    assert.equal((await call(p, '/api/auth/bootstrap', { method: 'POST', body: { password: clientKey, code }, headers: { Host: 'other.example', Origin: 'http://other.example' } })).status, 401);
    assert.equal((await call(p, '/api/auth/bootstrap', { method: 'POST', body: { password: clientKey, code: 'wrong' } })).status, 401);
    const [first, second] = await Promise.all([call(p, '/api/auth/bootstrap', { method: 'POST', body: { password: clientKey, code } }), call(p, '/api/auth/bootstrap', { method: 'POST', body: { password: clientKey, code } })]);
    assert.equal(first.status, 200); assert.equal(second.status, 200);
    assert.equal(first.json.pending, true);
    assert.equal((await call(p, '/api/accounts', { cookie: first.cookie, csrf: first.json.csrf })).status, 401);
    assert.equal((await call(p, '/api/auth/password', { method: 'POST', cookie: first.cookie, body: { newPassword: newPassword } })).status, 401);
    assert.equal((await call(p, '/api/auth/password', { method: 'POST', cookie: first.cookie, csrf: first.json.csrf, body: { newPassword: clientKey } })).status, 400);
    assert.equal((await call(p, '/api/auth/password', { method: 'POST', cookie: first.cookie, csrf: first.json.csrf, body: { newPassword } })).status, 200);
    assert.equal((await call(p, '/api/auth/password', { method: 'POST', cookie: second.cookie, csrf: second.json.csrf, body: { newPassword: 'another-password-123' } })).status, 401);
    assert.equal((await call(p, '/api/auth/bootstrap', { method: 'POST', body: { password: clientKey, code } })).status, 401);
    assert.equal((await call(p, '/api/auth/login', { method: 'POST', body: { password: clientKey } })).status, 401);
    const login = await call(p, '/api/auth/login', { method: 'POST', body: { password: newPassword } });
    assert.equal(login.status, 200);
    assert.match(login.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
    assert.equal((await call(p, '/api/accounts', { cookie: login.cookie })).status, 200);
    assert.deepEqual((await call(p, '/api/logs/details', { cookie: login.cookie })).json.items, [], 'no detailed content before first password change');
    assert.equal((await call(p, '/api/security', { method: 'POST', cookie: login.cookie, body: { proxyKey: 'rotated-client-key' } })).status, 401);
    assert.equal((await call(p, '/api/security', { method: 'POST', cookie: login.cookie, csrf: login.json.csrf, body: { proxyKey: 'rotated-client-key' }, headers: { Origin: 'https://evil.example' } })).status, 401);
    assert.equal((await call(p, '/api/security', { method: 'POST', cookie: login.cookie, csrf: login.json.csrf, body: { proxyKey: newPassword } })).status, 400);
    assert.equal((await call(p, '/api/security', { method: 'POST', cookie: login.cookie, csrf: login.json.csrf, body: { proxyKey: 'rotated-client-key' } })).status, 200);
    assert.equal((await call(p, '/api/accounts', { cookie: login.cookie, headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 401);
    assert.equal((await call(p, '/api/accounts', { cookie: login.cookie, headers: { Host: 'evil.example', Origin: 'http://evil.example' } })).status, 401);
    assert.equal((await call(p, '/v1/responses', { method: 'POST', headers: { Authorization: 'Bearer rotated-client-key' } })).status, 501);
    assert.equal((await call(p, '/v1/responses', { method: 'POST', cookie: login.cookie })).status, 401);
    assert.equal((await call(p, '/api/auth/logout', { method: 'POST', cookie: login.cookie, csrf: login.json.csrf, body: {} })).status, 200);
    assert.equal((await call(p, '/api/accounts', { cookie: login.cookie })).status, 401);
    const again = await call(p, '/api/auth/login', { method: 'POST', body: { password: newPassword } });
    const other = await call(p, '/api/auth/login', { method: 'POST', body: { password: newPassword } });
    assert.equal((await call(p, '/api/auth/password', { method: 'POST', cookie: again.cookie, csrf: again.json.csrf, body: { currentPassword: 'wrong', newPassword: 'another-admin-password-789' } })).status, 400);
    assert.equal((await call(p, '/api/auth/password', { method: 'POST', cookie: again.cookie, csrf: again.json.csrf, body: { currentPassword: newPassword, newPassword: 'another-admin-password-789' } })).status, 200);
    assert.equal((await call(p, '/api/accounts', { cookie: other.cookie })).status, 401);
    await stop(child); child = await run(dir, p, { PROXY_KEY: 'rotated-client-key', CLINE_PASS_ADMIN_INIT_CODE: 'other-independent-code' });
    assert.equal((await call(p, '/api/auth/bootstrap', { method: 'POST', body: { password: 'rotated-client-key', code: 'other-independent-code' } })).status, 401);
    assert.equal((await call(p, '/api/auth/login', { method: 'POST', body: { password: newPassword } })).status, 401);
    assert.equal((await call(p, '/api/auth/login', { method: 'POST', body: { password: 'another-admin-password-789' } })).status, 200);
    await stop(child);
    // A deployment environment override must not silently make a saved admin password a client credential.
    const before = fs.readFileSync(adminPath, 'utf8');
    const failed = spawn(process.execPath, ['server.js'], { cwd: path.resolve('.'), env: {
      ...process.env, DATA_DIR: dir, PORT: String(p), BIND_HOST: '127.0.0.1', PROXY_KEY: 'another-admin-password-789',
    }, stdio: 'ignore' });
    await new Promise(resolve => failed.once('exit', resolve));
    assert.notEqual(failed.exitCode, 0);
    assert.equal(fs.readFileSync(adminPath, 'utf8'), before);
    child = await run(dir, p, { PROXY_KEY: 'rotated-client-key' });
    assert.equal((await call(p, '/api/auth/login', { method: 'POST', body: { password: 'another-admin-password-789' } })).status, 200);
  } finally { if (child && child.exitCode === null) await stop(child); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('empty client key requires trusted nonempty bootstrap and malformed admin state preserves bytes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cps-admin-')); const p = await port(); let child;
  try {
    child = await run(dir, p, { PROXY_KEY: '', CLINE_PASS_ADMIN_INITIAL_PASSWORD: 'separate-bootstrap-123' });
    assert.equal((await call(p, '/api/accounts')).status, 401);
    assert.equal((await call(p, '/api/auth/bootstrap', { method: 'POST', body: { password: '', code } })).status, 401);
    assert.equal((await call(p, '/api/auth/bootstrap', { method: 'POST', body: { password: 'separate-bootstrap-123', code } })).status, 200);
    await stop(child);
    const file = path.join(dir, 'admin-auth.json');
    for (const bytes of ['null', '{"version":1,"hash":"broken"}', '{']) {
      fs.writeFileSync(file, bytes);
      const failed = spawn(process.execPath, ['server.js'], { cwd: path.resolve('.'), env: { ...process.env, DATA_DIR: dir, PORT: String(p), BIND_HOST: '127.0.0.1', PROXY_KEY: '', CLINE_PASS_ADMIN_BOOTSTRAP: '1', CLINE_PASS_ADMIN_INIT_CODE: code, CLINE_PASS_ADMIN_INITIAL_PASSWORD: 'separate-bootstrap-123' }, stdio: 'ignore' });
      await new Promise(resolve => failed.once('exit', resolve));
      assert.notEqual(failed.exitCode, 0); assert.equal(fs.readFileSync(file, 'utf8'), bytes);
    }
    fs.rmSync(file);
    fs.symlinkSync(path.join(dir, 'config.json'), file);
    const rejected = spawn(process.execPath, ['server.js'], { cwd: path.resolve('.'), env: { ...process.env, DATA_DIR: dir, PORT: String(p), BIND_HOST: '127.0.0.1', CLINE_PASS_ADMIN_BOOTSTRAP: '1', CLINE_PASS_ADMIN_INIT_CODE: code, CLINE_PASS_ADMIN_INITIAL_PASSWORD: 'separate-bootstrap-123' }, stdio: 'ignore' });
    await new Promise(resolve => rejected.once('exit', resolve));
    assert.notEqual(rejected.exitCode, 0);
    assert.equal(fs.lstatSync(file).isSymbolicLink(), true);
  } finally { if (child && child.exitCode === null) await stop(child); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a missing administrator file cannot bootstrap without explicit opt-in and a distinct initialization code', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cps-admin-')); const p = await port(); let child;
  try {
    child = await run(dir, p, { CLINE_PASS_ADMIN_BOOTSTRAP: '', CLINE_PASS_ADMIN_INIT_CODE: code });
    assert.equal((await call(p, '/api/accounts', { headers: { Authorization: `Bearer ${clientKey}` } })).status, 401);
    assert.equal((await call(p, '/api/auth/state')).json.available, false);
    assert.equal(fs.existsSync(path.join(dir, 'admin-auth.json')), false);
    await stop(child);
    const failed = spawn(process.execPath, ['server.js'], { cwd: path.resolve('.'), env: {
      ...process.env, DATA_DIR: dir, PORT: String(p), BIND_HOST: '127.0.0.1', PROXY_KEY: clientKey,
      CLINE_PASS_ADMIN_BOOTSTRAP: '1', CLINE_PASS_ADMIN_INIT_CODE: clientKey,
    }, stdio: 'ignore' });
    await new Promise(resolve => failed.once('exit', resolve));
    assert.notEqual(failed.exitCode, 0);
    assert.equal(fs.existsSync(path.join(dir, 'admin-auth.json')), false);
  } finally { if (child && child.exitCode === null) await stop(child); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('HTTPS public origin requires a trusted proxy TLS marker; direct HTTP cannot impersonate it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cps-admin-')); const p = await port(); let child;
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ port: p, publicBaseUrl: 'https://console.example.test' }));
  try {
    child = await run(dir, p, { CLINE_PASS_ADMIN_PROXY_TOKEN: 'a'.repeat(64) });
    const headers = { Host: 'console.example.test', Origin: 'https://console.example.test' };
    const body = JSON.stringify({ password: clientKey, code });
    const proxyCall = (extra = {}) => new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port: p, path: '/api/auth/bootstrap', method: 'POST',
        headers: { ...headers, ...extra, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => {
        res.resume(); res.once('end', () => resolve({ status: res.statusCode, cookie: res.headers['set-cookie']?.[0] }));
      });
      req.on('error', reject); req.end(body);
    });
    assert.equal((await proxyCall()).status, 401);
    assert.equal((await proxyCall({ 'X-Forwarded-Proto': 'https' })).status, 401, 'private peer cannot assert TLS');
    assert.equal((await proxyCall({ 'X-Forwarded-Proto': 'https', 'X-Cline-Pass-Proxy-Token': 'f'.repeat(64) })).status, 401);
    assert.equal((await proxyCall({ 'X-Forwarded-Proto': 'https', 'X-Cline-Pass-Proxy-Token': 'a'.repeat(64), Origin: 'https://evil.example' })).status, 401);
    const viaProxy = await proxyCall({ 'X-Forwarded-Proto': 'https', 'X-Cline-Pass-Proxy-Token': 'a'.repeat(64) });
    assert.equal(viaProxy.status, 200);
    assert.match(viaProxy.cookie, /Secure/);
  } finally { if (child && child.exitCode === null) await stop(child); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('expired pending bootstrap cannot change password and can begin initialization again', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cps-admin-')); const p = await port(); let child;
  try {
    child = await run(dir, p, { CLINE_PASS_TEST_ADMIN_TTL_MS: '80' });
    const pending = await call(p, '/api/auth/bootstrap', { method: 'POST', body: { password: clientKey, code } });
    assert.equal(pending.status, 200);
    await new Promise(resolve => setTimeout(resolve, 120));
    assert.equal((await call(p, '/api/auth/password', { method: 'POST', cookie: pending.cookie, csrf: pending.json.csrf, body: { newPassword } })).status, 401);
    assert.equal((await call(p, '/api/auth/state')).json.initialized, false);
    const retry = await call(p, '/api/auth/bootstrap', { method: 'POST', body: { password: clientKey, code } });
    assert.equal(retry.status, 200);
    assert.equal((await call(p, '/api/auth/password', { method: 'POST', cookie: retry.cookie, csrf: retry.json.csrf, body: { newPassword } })).status, 200);
  } finally { if (child && child.exitCode === null) await stop(child); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('admin session expires independently of client key and restarting clears all sessions', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cps-admin-')); const p = await port(); let child;
  const salt = crypto.randomBytes(32).toString('hex');
  const hash = crypto.scryptSync(newPassword, Buffer.from(salt, 'hex'), 64).toString('hex');
  fs.writeFileSync(path.join(dir, 'admin-auth.json'), JSON.stringify({ version: 1, initialized: true, salt, hash }), { mode: 0o600 });
  try {
    child = await run(dir, p, { CLINE_PASS_TEST_ADMIN_TTL_MS: '80' });
    const login = await call(p, '/api/auth/login', { method: 'POST', body: { password: newPassword } });
    assert.equal(login.status, 200);
    assert.equal((await call(p, '/api/accounts', { cookie: login.cookie })).status, 200);
    await new Promise(resolve => setTimeout(resolve, 110));
    assert.equal((await call(p, '/api/accounts', { cookie: login.cookie })).status, 401);
    const again = await call(p, '/api/auth/login', { method: 'POST', body: { password: newPassword } });
    assert.equal(again.status, 200);
    await stop(child); child = await run(dir, p);
    assert.equal((await call(p, '/api/accounts', { cookie: again.cookie })).status, 401);
    assert.equal((await call(p, '/api/auth/login', { method: 'POST', body: { password: newPassword } })).status, 200);
    for (let i = 0; i < 5; i++) assert.equal((await call(p, '/api/auth/login', { method: 'POST', body: { password: 'incorrect' } })).status, 401);
    assert.equal((await call(p, '/api/auth/login', { method: 'POST', body: { password: newPassword } })).status, 429);
  } finally { if (child && child.exitCode === null) await stop(child); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('concurrent failed logins cannot bypass the bound on expensive password checks', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cps-admin-')); const p = await port(); let child;
  const salt = crypto.randomBytes(32).toString('hex');
  const hash = crypto.scryptSync(newPassword, Buffer.from(salt, 'hex'), 64).toString('hex');
  fs.writeFileSync(path.join(dir, 'admin-auth.json'), JSON.stringify({ version: 1, initialized: true, salt, hash }), { mode: 0o600 });
  try {
    child = await run(dir, p);
    const results = await Promise.all(Array.from({ length: 12 }, () => call(p, '/api/auth/login', { method: 'POST', body: { password: 'incorrect' } })));
    assert.ok(results.filter((result) => result.status === 401).length <= 5);
    assert.ok(results.filter((result) => result.status === 429).length >= 7);
    assert.equal((await call(p, '/api/auth/login', { method: 'POST', body: { password: newPassword } })).status, 429);
  } finally { if (child && child.exitCode === null) await stop(child); fs.rmSync(dir, { recursive: true, force: true }); }
});
