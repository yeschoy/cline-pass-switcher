// Synthetic only. Run: node .trellis/tasks/09-25-multi-client-key-routing/research/rollback-check.mjs
// No production files, upstreams, deployment, or raw credential output.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BASE = 'cc17ac7';
const legacy = 'synthetic-legacy-client-123', teamUpstream = 'synthetic-upstream-team';
const admin = 'synthetic-independent-admin-123';
const model = 'cline-pass/glm-5.3-flash';
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
let root = scriptDir;
while (!fs.existsSync(path.join(root, '.git')) && path.dirname(root) !== root) root = path.dirname(root);
assert(fs.existsSync(path.join(root, '.git')), 'repo root not found');
assert(fs.existsSync(path.join(root, 'node_modules')), 'installed dependencies required');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const listen = (s) => new Promise((resolve) => s.listen(0, '127.0.0.1', () => resolve(s.address().port)));
const close = (s) => new Promise((resolve) => s.close(resolve));
const check = (condition, label) => assert.equal(Boolean(condition), true, label);
const same = (actual, expected, label) => assert.equal(actual, expected, label);
const config = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
const meta = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'metadata.json'), 'utf8'));
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
function snapshot(dir) {
  const files = {};
  function walk(current, relative = '') {
    for (const e of fs.readdirSync(current, { withFileTypes: true })) {
      const name = path.join(relative, e.name), filename = path.join(current, e.name);
      if (e.isDirectory()) walk(filename, name);
      else { check(e.isFile(), 'private backup has regular files only'); files[name] = sha(fs.readFileSync(filename)); }
    }
  }
  walk(dir);
  return files;
}
function copy(src, target) { fs.cpSync(src, target, { recursive: true, errorOnExist: true, force: false }); }
function materialize(dir, old) {
  fs.mkdirSync(dir, { mode: 0o700 });
  for (const name of ['server.js', 'lib/jsonl-log-store.js', 'lib/detailed-log-capture.js', 'lib/detailed-log-store.js', 'public/index.html']) {
    const dest = path.join(dir, name);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const bytes = old ? execFileSync('git', ['show', `${BASE}:${name}`], { cwd: root, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }) : fs.readFileSync(path.join(root, name));
    fs.writeFileSync(dest, bytes);
  }
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}\n');
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
}
async function freePort() { const s = http.createServer(); const port = await listen(s); await close(s); return port; }
const children = new Set();
async function stop(child) {
  if (!child) return;
  if (child.exitCode === null && child.signalCode === null) {
    await new Promise((resolve) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 1500);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      child.kill('SIGTERM');
    });
  }
  children.delete(child);
}
async function start(tree, data, env = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: tree, stdio: 'ignore', env: {
      ...process.env, DATA_DIR: data, PORT: String(port), BIND_HOST: '127.0.0.1', NODE_ENV: 'test',
      PROXY_KEY: '', CLINE_PASS_KEY: '', PUBLIC_BASE_URL: '', CLINE_PASS_ADMIN_BOOTSTRAP: '',
      CLINE_PASS_ADMIN_INIT_CODE: '', CLINE_PASS_ADMIN_INITIAL_PASSWORD: '', ...env,
    },
  });
  children.add(child);
  for (let i = 0; i < 250; i++) {
    if (child.exitCode !== null || child.signalCode !== null) return { child, port, live: false };
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/meta`, { signal: AbortSignal.timeout(500) });
      if (response.status === 200) return { child, port, live: true };
    } catch { /* startup in progress */ }
    await pause(20);
  }
  throw Error('isolated startup deadline');
}
async function call(port, route, { method = 'GET', body, cookie, csrf, key } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  if (csrf) headers['X-CSRF-Token'] = csrf;
  if (key) headers.Authorization = `Bearer ${key}`;
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(4000),
  });
  const text = await response.text();
  let json;
  try { json = JSON.parse(text); } catch { /* non-JSON error */ }
  return { status: response.status, json, cookie: response.headers.get('set-cookie')?.split(';')[0] };
}
async function login(port) {
  const response = await call(port, '/api/auth/login', { method: 'POST', body: { password: admin } });
  same(response.status, 200, 'independent admin login');
  check(response.cookie && response.json?.csrf, 'private admin session');
  return (route, method = 'GET', body) => call(port, route, { method, body, cookie: response.cookie, csrf: response.json.csrf });
}
const chat = (port, key) => call(port, '/v1/chat/completions', {
  method: 'POST', key, body: { model, messages: [{ role: 'user', content: 'synthetic hello' }] },
});

async function main() {
  process.umask(0o077);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cps-rollback-synthetic-'));
  fs.chmodSync(tmp, 0o700);
  const upstream = http.createServer((req, res) => {
    const body = [];
    req.on('data', (chunk) => body.push(chunk));
    req.on('end', () => {
      upstream.seen.push(req.headers.authorization === `Bearer ${teamUpstream}` ? 'team' : req.headers.authorization === 'Bearer synthetic-upstream-legacy' ? 'legacy' : 'other');
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: 'synthetic reply' } }] }));
    });
  });
  upstream.seen = [];
  try {
    const oldTree = path.join(tmp, 'image-old'), newTree = path.join(tmp, 'image-new');
    materialize(oldTree, true); materialize(newTree, false);
    const upstreamPort = await listen(upstream);
    const v1 = path.join(tmp, 'v1'); fs.mkdirSync(v1, { mode: 0o700 });
    const baseConfig = { proxyKey: legacy, upstreamBase: `http://127.0.0.1:${upstreamPort}/api/v1`, accounts: [{ id: 'stable-old', name: 'legacy', key: 'synthetic-upstream-legacy' }] };
    fs.writeFileSync(path.join(v1, 'config.json'), JSON.stringify(baseConfig), { mode: 0o600 });
    const salt = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(path.join(v1, 'admin-auth.json'), JSON.stringify({ version: 1, initialized: true, salt, hash: crypto.scryptSync(admin, Buffer.from(salt, 'hex'), 64).toString('hex') }), { mode: 0o600 });

    let service = await start(oldTree, v1); check(service.live, 'old image starts on v1');
    let manage = await login(service.port);
    same((await manage('/api/accounts')).json.accounts.length, 1, 'old account present');
    same((await chat(service.port, legacy)).status, 200, 'old authenticated chat');
    await stop(service.child);
    check(fs.existsSync(path.join(v1, 'config.json')) && fs.existsSync(path.join(v1, 'metadata.json')), 'v1 config and metadata generated');
    const v1Backup = path.join(tmp, 'v1-full-backup'); copy(v1, v1Backup);
    const v1Hash = snapshot(v1Backup);
    const v1Count = meta(v1Backup).statistics?.lifetime?.global?.requests || 0;
    check(v1Count >= 1, 'old history counter created');

    const v2 = path.join(tmp, 'v2'); copy(v1Backup, v2);
    service = await start(newTree, v2); check(service.live, 'new image starts on copied v1');
    manage = await login(service.port);
    const initial = (await manage('/api/accounts')).json;
    same(initial.accounts[0].id, 'stable-old', 'stable account id migration');
    same(initial.accounts[0].clientKeyId, 'legacy', 'legacy ownership migration');
    const created = await manage('/api/security/client-keys', 'POST', { name: 'Synthetic Team' });
    same(created.status, 200, 'create extra client key');
    const teamId = created.json.id, teamKey = created.json.key;
    check(typeof teamId === 'string' && typeof teamKey === 'string', 'created private team credential');
    const saved = await manage('/api/accounts', 'POST', { accounts: [...initial.accounts, { name: 'team', key: teamUpstream, clientKeyId: teamId }], mode: 'single', active: 1, concurrencyWaitMs: 0 });
    same(saved.status, 200, 'new image saves owner assignments');
    same((await chat(service.port, teamKey)).status, 200, 'team chat on new image');
    same((await chat(service.port, legacy)).status, 200, 'legacy chat on new image');
    await stop(service.child);
    const v2Accounts = config(v2).accounts;
    check(v2Accounts.length === 2 && v2Accounts[0].clientKeyId === 'legacy' && v2Accounts[1].clientKeyId === teamId, 'v2 owners on disk');
    check(config(v2).clientKeys?.length === 1, 'v2 key inventory on disk');
    const v2Count = meta(v2).statistics?.lifetime?.global?.requests || 0;
    check(v2Count > v1Count, 'new history counter created');
    const v2Backup = path.join(tmp, 'v2-full-backup'); copy(v2, v2Backup);
    const v2Hash = snapshot(v2Backup);

    // Deliberately run an old image on ONLY a disposable v2 clone. Do not assert its behavior beforehand.
    const oldOnV2 = path.join(tmp, 'old-on-v2'); copy(v2Backup, oldOnV2);
    service = await start(oldTree, oldOnV2);
    const outcome = { oldV2Starts: service.live, v1BackupFiles: Object.keys(v1Hash).length, v2BackupFiles: Object.keys(v2Hash).length };
    if (service.live) {
      manage = await login(service.port);
      const beforeSave = config(oldOnV2);
      outcome.startupInventoryRetained = beforeSave.clientKeys?.length === 1;
      outcome.startupOwnersRetained = beforeSave.accounts?.every((a, i) => a.clientKeyId === v2Accounts[i].clientKeyId);
      outcome.oldViewHasOwners = (await manage('/api/accounts')).json.accounts.every((a) => typeof a.clientKeyId === 'string');
      const oldView = (await manage('/api/accounts')).json;
      const beforeAttempt = upstream.seen.length;
      outcome.oldLegacyChatStatus = (await chat(service.port, legacy)).status;
      outcome.oldLegacyReachedTeam = upstream.seen.slice(beforeAttempt).includes('team');
      const oldSave = await manage('/api/accounts', 'POST', { accounts: oldView.accounts, mode: oldView.mode, active: oldView.active, concurrencyWaitMs: oldView.concurrencyWaitMs });
      outcome.oldSaveStatus = oldSave.status;
      await stop(service.child);
      const afterSave = config(oldOnV2);
      outcome.saveInventoryRetained = afterSave.clientKeys?.length === 1;
      outcome.saveOwnersRetained = afterSave.accounts?.every((a, i) => a.clientKeyId === v2Accounts[i].clientKeyId);
      outcome.saveStableIdsRetained = afterSave.accounts?.every((a, i) => a.id === v2Accounts[i].id);
      outcome.historyCountAfterOld = meta(oldOnV2).statistics?.lifetime?.global?.requests || 0;
      outcome.historyNotReduced = outcome.historyCountAfterOld >= v2Count;
      outcome.configBytesChanged = snapshot(oldOnV2)['config.json'] !== v2Hash['config.json'];
      outcome.metadataBytesChanged = snapshot(oldOnV2)['metadata.json'] !== v2Hash['metadata.json'];
    } else {
      await stop(service.child);
      outcome.startupConfigBytesChanged = snapshot(oldOnV2)['config.json'] !== v2Hash['config.json'];
      outcome.startupMetadataBytesChanged = snapshot(oldOnV2)['metadata.json'] !== v2Hash['metadata.json'];
    }
    check(JSON.stringify(snapshot(v2Backup)) === JSON.stringify(v2Hash), 'immutable v2 private backup');

    // Full old-state restoration is a separate clone: never overwrite v2 to "roll back".
    const restored = path.join(tmp, 'restored-v1'); copy(v1Backup, restored);
    check(JSON.stringify(snapshot(restored)) === JSON.stringify(v1Hash), 'full v1 backup restored byte for byte');
    service = await start(oldTree, restored); check(service.live, 'old image restarts from restored v1');
    manage = await login(service.port);
    same((await manage('/api/accounts')).json.accounts[0].id, 'stable-old', 'old restored account id');
    same((await chat(service.port, legacy)).status, 200, 'old restored chat');
    await stop(service.child);
    outcome.v1RestoredOldChat = true;
    outcome.v2BackupPreserved = JSON.stringify(snapshot(v2Backup)) === JSON.stringify(v2Hash);

    // Additional startup checks use private copies of the synthetic v1 snapshot.
    const anonymous = path.join(tmp, 'anonymous'); copy(v1Backup, anonymous);
    const anonConfig = config(anonymous); anonConfig.proxyKey = '';
    fs.writeFileSync(path.join(anonymous, 'config.json'), JSON.stringify(anonConfig));
    service = await start(newTree, anonymous); check(service.live, 'new image starts empty-key legacy');
    same((await chat(service.port)).status, 200, 'empty-key legacy anonymous chat');
    await stop(service.child);
    outcome.emptyKeyAnonymous = true;

    const envData = path.join(tmp, 'env-override'); copy(v1Backup, envData);
    const envKey = 'synthetic-env-override-123', runningKey = 'synthetic-running-rotation-123';
    service = await start(newTree, envData, { PROXY_KEY: envKey }); check(service.live, 'new image starts with env override');
    same((await chat(service.port, legacy)).status, 401, 'stored legacy key overridden on startup');
    same((await chat(service.port, envKey)).status, 200, 'env override accepted on startup');
    manage = await login(service.port);
    same((await manage('/api/security', 'POST', { proxyKey: runningKey })).status, 200, 'admin rotates running legacy key');
    same((await chat(service.port, envKey)).status, 401, 'env key not pinned in running process');
    same((await chat(service.port, runningKey)).status, 200, 'running rotation accepted');
    await stop(service.child);
    service = await start(newTree, envData, { PROXY_KEY: envKey }); check(service.live, 'new image restarts with env override');
    same((await chat(service.port, envKey)).status, 200, 'env reapplied on restart');
    same((await chat(service.port, runningKey)).status, 401, 'running key superseded on restart');
    await stop(service.child);
    outcome.envOverrideStartupOnly = true;
    console.log(JSON.stringify({ baseline: BASE, result: 'pass', ...outcome }));
  } finally {
    for (const child of [...children]) await stop(child);
    if (upstream.listening) await close(upstream);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
try { await main(); } catch (error) {
  // No exception strings or server output: they may contain private fixture payloads.
  console.error(JSON.stringify({ baseline: BASE, result: 'fail', check: error?.operator || 'isolated rehearsal', code: error?.code || null }));
  process.exitCode = 1;
}
