import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const legacy = 'legacy-client-key-123', admin = 'separate-admin-password-123';
const model = 'cline-pass/glm-5.3-flash';
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = (server) => new Promise((resolve) => server.close(resolve));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check, label) {
  for (let i = 0; i < 200; i++) { const value = await check(); if (value) return value; await pause(10); }
  throw new Error(`timed out: ${label}`);
}
const chatAttempts = (upstream) => upstream.seen.filter((entry) => entry.url.endsWith('/chat/completions')).map((entry) => entry.auth);
async function start(dir, port, env = {}) {
  const child = spawn(process.execPath, ['server.js'], { cwd: path.resolve('.'), env: {
    ...process.env, DATA_DIR: dir, PORT: String(port), BIND_HOST: '127.0.0.1', NODE_ENV: 'test',
    PROXY_KEY: '', CLINE_PASS_KEY: '', PUBLIC_BASE_URL: '', CLINE_PASS_ADMIN_BOOTSTRAP: '', ...env,
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  try {
    await Promise.race([
      (async () => { while (!output.includes('OpenAI 兼容代理地址')) { if (child.exitCode !== null) throw Error('service exited'); await pause(15); } })(),
      pause(5000).then(() => { throw Error('service startup timeout'); }),
    ]);
  } catch (error) { child.kill('SIGKILL'); throw Error(`${error.message}: ${output}`); }
  return child;
}
async function stop(child) {
  if (!child || child.exitCode !== null) return;
  await new Promise((resolve) => { child.once('exit', resolve); child.kill('SIGTERM'); setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 1500).unref(); });
}
async function api(port, route, { method = 'GET', body, key, header = 'Authorization', cookie, csrf, headers = {} } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, { method, headers: {
    ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    ...(key ? { [header]: header === 'Authorization' ? `Bearer ${key}` : key } : {}),
    ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...headers,
  }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await response.text();
  let json; try { json = JSON.parse(text); } catch {}
  return { status: response.status, json, text, cookie: response.headers.get('set-cookie')?.split(';')[0] };
}
function fixture(dir, config) {
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config));
  const salt = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(path.join(dir, 'admin-auth.json'), JSON.stringify({ version: 1, initialized: true, salt, hash: crypto.scryptSync(admin, Buffer.from(salt, 'hex'), 64).toString('hex') }), { mode: 0o600 });
}
async function scenario(t, config, run, env = {}, quota = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cps-client-pools-'));
  const upstream = http.createServer((req, res) => {
    const auth = req.headers.authorization;
    const seen = { url: req.url, auth };
    upstream.seen.push(seen);
    if (req.url.endsWith('/models')) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: [{ id: `catalog-${auth?.slice(7)}` }] })); return; }
    if (req.url.endsWith('/users/me/plan/usage-limits') && upstream.quota?.has(auth)) {
      res.setHeader('Content-Type', 'application/json');
      const percentUsed = upstream.quota.get(auth);
      res.end(JSON.stringify({ success: true, data: { limits: ['five_hour', 'weekly', 'monthly'].map((type) => ({ type, percentUsed })) } }));
      return;
    }
    let body = ''; req.on('data', (chunk) => { body += chunk; }); req.on('end', () => {
      if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) { res.statusCode = 404; res.end('{}'); return; }
      const input = JSON.parse(body);
      seen.provider = input.providerOptions?.gateway?.only?.[0] || input.provider?.only?.[0] || null;
      const reply = () => {
        if (input.stream && input.messages?.[0]?.content === 'stream-hold') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.write('data: {"choices":[{"delta":{"content":"started"}}]}\n\n');
          upstream.streamPending.push(res);
          return;
        }
        if (input.stream) {
          res.setHeader('Content-Type', 'text/event-stream');
          if (input.providerOptions?.gateway?.only?.[0] === 'first') return res.end('data: {"error":{"message":"provider failed","status":502}}\n\n');
          return res.end('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n');
        }
        res.setHeader('Content-Type', 'application/json');
        if (['echo', 'hold-echo'].includes(input.messages?.[0]?.content)) { res.statusCode = 502; return res.end(JSON.stringify({ error: { message: `echo ${upstream.echoSecret || 'team-client-key-123456'}` } })); }
        if (input.messages?.[0]?.content === 'trigger' && auth === 'Bearer upstream-one') { res.statusCode = 502; return res.end(JSON.stringify({ error: { message: 'cooldown-owner', status: 502 } })); }
        if (input.messages?.[0]?.content === 'cooldown-team' && auth === 'Bearer upstream-two') { res.statusCode = 502; return res.end(JSON.stringify({ error: { message: 'cooldown-owner', status: 502 } })); }
        if (input.messages?.[0]?.content === 'retry-first' && seen.provider === 'first') { res.statusCode = 502; return res.end(JSON.stringify({ error: { message: 'first provider failed', status: 502 } })); }
        res.end(JSON.stringify({ choices: [{ message: { content: auth, ...(input.messages?.[0]?.content === 'Reply with the word OK' ? { provider_metadata: { gateway: { routing: { finalProvider: 'synthetic-provider' } } } } : {}) } }], ...(input.messages?.[0]?.content === 'retry-first' ? { usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } } : {}) }));
      };
      if (['hold', 'hold-echo'].includes(input.messages?.[0]?.content)) upstream.pending.push(reply);
      else reply();
    });
  });
  upstream.seen = [];
  upstream.pending = [];
  upstream.quota = new Map(Object.entries(quota));
  upstream.streamPending = [];
  upstream.release = () => { for (const reply of upstream.pending.splice(0)) reply(); };
  upstream.finishStreams = (tail = 'data: [DONE]\n\n') => { for (const res of upstream.streamPending.splice(0)) if (!res.destroyed) res.end(tail); };
  let child;
  t.after(async () => { upstream.release(); upstream.finishStreams(); await stop(child); await close(upstream); fs.rmSync(dir, { recursive: true, force: true }); });
  const upstreamPort = await listen(upstream);
  const portServer = http.createServer(); const port = await listen(portServer); await close(portServer);
  fixture(dir, { proxyKey: legacy, accounts: [{ id: 'one', name: 'one', key: 'upstream-one' }], upstreamBase: `http://127.0.0.1:${upstreamPort}/api/v1`, ...config });
  child = await start(dir, port, env);
  const login = await api(port, '/api/auth/login', { method: 'POST', body: { password: admin } });
  assert.equal(login.status, 200);
  const manage = (route, method = 'GET', body) => api(port, route, { method, body, cookie: login.cookie, csrf: login.json.csrf });
  const restart = async (overrides = {}) => { await stop(child); child = await start(dir, port, { ...env, ...overrides }); const renewed = await api(port, '/api/auth/login', { method: 'POST', body: { password: admin } }); assert.equal(renewed.status, 200); manageCurrent = (route, method = 'GET', body) => api(port, route, { method, body, cookie: renewed.cookie, csrf: renewed.json.csrf }); };
  let manageCurrent = manage;
  await run({ dir, port, upstream, manage: (...args) => manageCurrent(...args), restart });
}

const chat = (port, key, route = '/v1/chat/completions', header = 'Authorization', extra = {}) => api(port, route, { method: 'POST', key, header, body: { model, messages: [{ role: 'user', content: 'hello' }], ...extra } });
const chatWithHeaders = (port, headers) => api(port, '/v1/chat/completions', { method: 'POST', body: { model, messages: [] }, headers });

test('single empty Legacy retains anonymous and old invalid-header compatibility', async (t) => {
  await scenario(t, { proxyKey: '' }, async ({ port, upstream }) => {
    assert.equal((await chat(port)).status, 200);
    for (const header of ['Authorization', 'X-Admin-Key']) {
      const response = await chat(port, 'not-a-valid-client-key', '/v1/chat/completions', header);
      assert.equal(response.status, 200, response.text);
      assert.equal(response.json.choices[0].message.content, 'Bearer upstream-one');
    }
    const conflict = await chatWithHeaders(port, { Authorization: 'Bearer invalid-a', 'X-Admin-Key': 'invalid-b' });
    assert.equal(conflict.status, 200, 'the original single-key empty mode remains open even with conflicting headers');
    assert.deepEqual(chatAttempts(upstream), Array(4).fill('Bearer upstream-one'));
  });
});

test('empty Legacy with an additional key admits only absent credentials as anonymous Legacy', async (t) => {
  const teamKey = 'team-client-key-123456';
  await scenario(t, { proxyKey: '', exposeCatalog: true,
    clientKeys: [{ id: 'team', name: 'Team B', key: teamKey }],
    accounts: [{ id: 'team-account', name: 'team', key: 'upstream-team', clientKeyId: 'team' }],
  }, async ({ port, upstream, manage }) => {
    assert.equal((await chat(port)).status, 503, 'anonymous Legacy has no owned account');
    for (const route of ['/models', '/v1/models', '/api/v1/models']) {
      assert.equal((await api(port, route)).status, 200, 'static model IDs remain visible to anonymous Legacy');
    }
    assert.equal(upstream.seen.length, 0, 'anonymous Legacy cannot fetch another owner catalog or chat');

    const denyCredential = async (key) => {
      for (const header of ['Authorization', 'X-Admin-Key']) {
        for (const route of ['/models', '/v1/models', '/api/v1/models']) {
          assert.equal((await api(port, route, { key, header })).status, 401, `${header} ${route}`);
        }
        assert.equal((await chat(port, key, '/v1/chat/completions', header)).status, 401, header);
      }
      assert.equal(upstream.seen.length, 0, 'invalid credentials cannot attempt the foreign upstream');
    };
    await denyCredential('not-a-valid-client-key');
    const spare = await manage('/api/security/client-keys', 'POST', { name: 'Spare' });
    assert.equal(spare.status, 200, spare.text);
    assert.equal((await chat(port, spare.json.key)).status, 503, 'valid empty owner pool has no fallback');
    const rotated = await manage(`/api/security/client-keys/${spare.json.id}/rotate`, 'POST', {});
    assert.equal(rotated.status, 200, rotated.text);
    await denyCredential(spare.json.key);
    assert.equal((await manage(`/api/security/client-keys/${spare.json.id}`, 'DELETE')).status, 200);
    await denyCredential(rotated.json.key);

    for (const [bearer, oldHeader] of [[teamKey, 'not-a-valid-client-key'], ['not-a-valid-client-key', teamKey], [teamKey, '']]) {
      const headers = { Authorization: `Bearer ${bearer}`, 'X-Admin-Key': oldHeader };
      assert.equal((await api(port, '/v1/models', { headers })).status, 401, 'conflicting model credentials');
      assert.equal((await chatWithHeaders(port, headers)).status, 401, 'conflicting chat credentials');
    }
    assert.equal(upstream.seen.length, 0, 'conflicting credentials cannot attempt the foreign upstream');
    const valid = { Authorization: `Bearer ${teamKey}`, 'X-Admin-Key': teamKey };
    assert.equal((await api(port, '/v1/models', { headers: valid })).status, 200);
    const response = await chatWithHeaders(port, valid);
    assert.equal(response.status, 200, response.text);
    assert.equal(response.json.choices[0].message.content, 'Bearer upstream-team');
    assert.deepEqual(chatAttempts(upstream), ['Bearer upstream-team']);
  });
});

test('nonempty PROXY_KEY startup override keeps ordinary 401 authentication', async (t) => {
  await scenario(t, { proxyKey: '' }, async ({ port, upstream }) => {
    assert.equal((await chat(port)).status, 401);
    for (const header of ['Authorization', 'X-Admin-Key']) {
      assert.equal((await chat(port, 'not-a-valid-client-key', '/v1/chat/completions', header)).status, 401);
      assert.equal((await api(port, '/v1/models', { key: 'not-a-valid-client-key', header })).status, 401);
    }
    assert.equal(upstream.seen.length, 0);
    assert.equal((await chat(port, legacy)).status, 200);
    assert.deepEqual(chatAttempts(upstream), ['Bearer upstream-one']);
  }, { PROXY_KEY: legacy });
});

test('key inventory, migration, old full save, rotation, reassignment and byte-preserving rejection', async (t) => {
  await scenario(t, {}, async ({ dir, port, upstream, manage, restart }) => {
    const before = await manage('/api/accounts');
    assert.equal(before.json.accounts[0].clientKeyId, 'legacy');
    const created = await manage('/api/security/client-keys', 'POST', { name: 'Team B' });
    assert.equal(created.status, 200, created.text);
    const { id, key } = created.json;
    assert.match(key, /^cps_[a-f0-9]{64}$/);
    assert.equal((await manage('/api/security/client-keys')).text.includes(key), false);
    assert.equal((await manage(`/api/security/client-keys/${id}`, 'PATCH', { name: 'Team B renamed' })).status, 200);
    assert.equal((await manage('/api/security/client-keys')).json.keys[1].name, 'Team B renamed');
    assert.equal((await api(port, `/api/security/client-keys/${id}`, { method: 'PATCH', key, body: { name: 'spoof' } })).status, 401);
    assert.equal((await api(port, '/api/accounts', { key })).status, 401);
    assert.equal((await api(port, '/api/accounts', { key, header: 'X-Admin-Key' })).status, 401);
    assert.equal((await api(port, '/api/security/client-keys', { method: 'POST', key, body: { name: 'no' } })).status, 401);
    assert.equal((await chat(port, key)).status, 503);
    assert.equal((await api(port, '/models', { key, header: 'X-Admin-Key' })).status, 200);
    const conflicting = await fetch(`http://127.0.0.1:${port}/models`, { headers: { Authorization: `Bearer ${legacy}`, 'X-Admin-Key': key } });
    assert.equal(conflicting.status, 401);
    for (const [owner, account] of [['legacy', 'one'], [id, 'two']]) {
      const snapshot = await manage('/api/accounts');
      const accounts = [...snapshot.json.accounts.map((a) => ({ ...a, clientKeyId: owner === 'legacy' && a.id === 'one' ? owner : a.clientKeyId }))];
      if (account === 'two') accounts.push({ id: undefined, name: 'two', key: 'upstream-two', clientKeyId: id });
      const saved = await manage('/api/accounts', 'POST', { accounts, mode: 'single', active: account === 'two' ? 0 : 0, concurrencyWaitMs: 0 });
      assert.equal(saved.status, 200, saved.text);
    }
    const snapshot = await manage('/api/accounts');
    const two = snapshot.json.accounts.find((a) => a.name === 'two');
    assert.equal(two.clientKeyId, id);
    const oldSave = await manage('/api/accounts', 'POST', { accounts: snapshot.json.accounts.map(({ clientKeyId, ...a }) => a), mode: 'single', active: 0, concurrencyWaitMs: 0 });
    assert.equal(oldSave.status, 200, oldSave.text);
    assert.equal((await manage('/api/accounts')).json.accounts.find((a) => a.id === two.id).clientKeyId, id);
    const file = path.join(dir, 'config.json');
    const bytes = fs.readFileSync(file, 'utf8');
    const wrongOwner = await manage('/api/accounts', 'POST', { accounts: [{ ...snapshot.json.accounts[0], clientKeyId: 'absent' }, two], mode: 'single', active: 0, concurrencyWaitMs: 0 });
    assert.equal(wrongOwner.status, 400);
    assert.equal(fs.readFileSync(file, 'utf8'), bytes);
    assert.equal((await manage(`/api/security/client-keys/${id}`, 'DELETE')).status, 409);
    assert.equal(fs.readFileSync(file, 'utf8'), bytes);
    assert.equal((await manage('/api/security/client-keys', 'POST', { name: 'team b renamed' })).status, 400);
    assert.equal((await manage('/api/security/client-keys', 'POST', { name: 'Legacy' })).status, 400);
    assert.equal(fs.readFileSync(file, 'utf8'), bytes);
    for (const [secret, expected] of [[legacy, 'upstream-one'], [key, 'upstream-two']]) {
      const response = await chat(port, secret);
      assert.equal(response.status, 200, response.text);
      assert.equal(response.json.choices[0].message.content, `Bearer ${expected}`);
    }
    assert.deepEqual(upstream.seen.filter((entry) => entry.url.endsWith('/chat/completions')).map((entry) => entry.auth), ['Bearer upstream-one', 'Bearer upstream-two']);
    const rotated = await manage(`/api/security/client-keys/${id}/rotate`, 'POST', {});
    assert.equal(rotated.status, 200); assert.notEqual(rotated.json.key, key);
    assert.equal((await chat(port, key)).status, 401);
    assert.equal((await chat(port, rotated.json.key, '/chat/completions', 'X-Admin-Key')).status, 200);
    assert.equal((await manage('/api/security/client-keys')).text.includes(rotated.json.key), false);
    await restart({ CLINE_PASS_KEY: 'synthetic-env-upstream-key' });
    assert.equal((await chat(port, rotated.json.key)).status, 200);
    const saved = await manage('/api/accounts');
    assert.equal(saved.json.accounts.find((a) => a.id === two.id).clientKeyId, id);
    assert.equal(saved.json.accounts.find((a) => a.key === 'synthetic-env-upstream-key').clientKeyId, 'legacy');
    assert.equal((await manage('/api/accounts', 'POST', { accounts: saved.json.accounts.map((a) => a.id === two.id ? { ...a, clientKeyId: 'legacy' } : a), mode: 'single', active: 0, concurrencyWaitMs: 0 })).status, 200);
    assert.equal((await manage(`/api/security/client-keys/${id}`, 'DELETE')).status, 200);
    assert.equal((await chat(port, rotated.json.key)).status, 401);
    assert.equal((await chat(port, legacy)).status, 200);
  });
});

test('old full save without stable ID never inherits a same-name account owner', async (t) => {
  await scenario(t, { clientKeys: [{ id: 'team', name: 'Team B', key: 'team-client-key-123456' }], accounts: [
    { id: 'one', name: 'one', key: 'upstream-one', clientKeyId: 'legacy' },
    { id: 'two', name: 'two', key: 'upstream-two', clientKeyId: 'team' },
  ] }, async ({ port, upstream, manage }) => {
    const original = (await manage('/api/accounts')).json.accounts;
    const saved = await manage('/api/accounts', 'POST', {
      accounts: [original[0], { name: 'two', key: 'upstream-replacement' }],
      mode: 'single', active: 1, concurrencyWaitMs: 0,
    });
    assert.equal(saved.status, 200, saved.text);
    const replacement = (await manage('/api/accounts')).json.accounts[1];
    assert.equal(replacement.id, 'two', 'legacy name fallback may retain its old stable ID');
    assert.equal(replacement.clientKeyId, 'legacy', 'name alone must not transfer exclusive owner');
    assert.equal((await chat(port, 'team-client-key-123456')).status, 503);
    assert.equal((await chat(port, legacy)).json.choices[0].message.content, 'Bearer upstream-replacement');
    assert.deepEqual(chatAttempts(upstream), ['Bearer upstream-replacement']);
  });
});

test('scoped model aliases and every legacy mode never attempt a foreign upstream; admin probes remain global', async (t) => {
  await scenario(t, { exposeCatalog: true, accounts: [{ id: 'one', name: 'one', key: 'upstream-one', clientKeyId: 'legacy' }] }, async ({ port, upstream, manage }) => {
    const created = await manage('/api/security/client-keys', 'POST', { name: 'Team B' });
    const { id, key } = created.json;
    for (const route of ['/models', '/v1/models', '/api/v1/models']) {
      const empty = await api(port, route, { key });
      assert.equal(empty.status, 200);
      assert.equal(upstream.seen.length, 0, 'empty pool must never fetch a catalog');
    }
    const snapshot = await manage('/api/accounts');
    assert.equal((await manage('/api/accounts', 'POST', { accounts: [...snapshot.json.accounts, { name: 'two', key: 'upstream-two', clientKeyId: id }], mode: 'single', active: 0, concurrencyWaitMs: 0 })).status, 200);
    for (const route of ['/models', '/v1/models', '/api/v1/models']) {
      const response = await api(port, route, { key, header: 'X-Admin-Key' });
      assert.equal(response.status, 200);
      assert.ok(response.json.data.some((row) => row.id === 'catalog-upstream-two'));
      assert.ok(!response.json.data.some((row) => row.id === 'catalog-upstream-one'));
    }
    const modes = ['single', 'roundrobin', 'sticky', 'least-connections', 'weighted-roundrobin', 'priority-failover'];
    for (const mode of modes) {
      const accounts = (await manage('/api/accounts')).json.accounts;
      const saved = await manage('/api/accounts', 'POST', { accounts, mode, active: 0, concurrencyWaitMs: 0 });
      assert.equal(saved.status, 200, saved.text);
      for (const route of ['/chat/completions', '/v1/chat/completions', '/api/v1/chat/completions']) {
        const response = await chat(port, key, route, 'X-Admin-Key', { session_id: 'same-session' });
        assert.equal(response.status, 200, `${mode}: ${response.text}`);
        assert.equal(response.json.choices[0].message.content, 'Bearer upstream-two');
      }
    }
    const last = (await manage('/api/accounts')).json;
    assert.equal((await manage('/api/accounts', 'POST', { accounts: last.accounts.map((a) => a.clientKeyId === id ? { ...a, enabled: false } : a), mode: 'single', active: 0, concurrencyWaitMs: 0 })).status, 200);
    assert.equal((await chat(port, key)).status, 503, 'disabled owner pool cannot use a foreign healthy account');
    assert.equal((await chat(port, legacy)).status, 200);
    const disabled = (await manage('/api/accounts')).json;
    assert.equal((await manage('/api/accounts', 'POST', { accounts: disabled.accounts.map((a) => a.clientKeyId === id ? { ...a, enabled: true } : a), mode: 'single', active: 0, concurrencyWaitMs: 0 })).status, 200);
    const adminTest = await manage('/api/test', 'POST', { model, accountId: 'one' });
    assert.equal(adminTest.status, 200);
    assert.equal(upstream.seen.filter((entry) => entry.url.endsWith('/chat/completions') && entry.auth === 'Bearer upstream-one').length, 2, 'explicit-ID admin test remains global');
    assert.equal(upstream.seen.filter((entry) => entry.url.endsWith('/chat/completions') && entry.auth === 'Bearer upstream-two').length, modes.length * 3);
  });
});

test('legacy sticky HRW retains its pre-upgrade fingerprint while additional owners are isolated', async (t) => {
  await scenario(t, { clientKeys: [{ id: 'team', name: 'Team B', key: 'team-client-key-123456' }],
    accountMode: 'sticky', accounts: [
      { id: 'one', name: 'one', key: 'upstream-one', clientKeyId: 'legacy' },
      { id: 'two', name: 'two', key: 'upstream-two', clientKeyId: 'legacy' },
      { id: 'foreign', name: 'foreign', key: 'upstream-foreign', clientKeyId: 'team' },
    ] }, async ({ dir, port, upstream, restart }) => {
    const secret = JSON.parse(fs.readFileSync(path.join(dir, 'metadata.json'), 'utf8')).routingSecret;
    const hmac = (text) => crypto.createHmac('sha256', secret).update(text).digest('hex');
    const fingerprint = hmac('session\0stable-session');
    const expected = ['one', 'two'].sort((left, right) => Buffer.compare(Buffer.from(hmac(`${fingerprint}\0${right}`), 'hex'), Buffer.from(hmac(`${fingerprint}\0${left}`), 'hex')))[0];
    for (let i = 0; i < 2; i++) {
      const legacyResponse = await chat(port, legacy, '/v1/chat/completions', 'Authorization', { session_id: 'stable-session' });
      assert.equal(legacyResponse.json.choices[0].message.content, `Bearer upstream-${expected}`);
      const teamResponse = await chat(port, 'team-client-key-123456', '/v1/chat/completions', 'Authorization', { session_id: 'stable-session' });
      assert.equal(teamResponse.json.choices[0].message.content, 'Bearer upstream-foreign');
      if (!i) await restart();
    }
    assert.deepEqual(upstream.seen.filter((entry) => entry.url.endsWith('/chat/completions')).map((entry) => entry.auth),
      [`Bearer upstream-${expected}`, 'Bearer upstream-foreign', `Bearer upstream-${expected}`, 'Bearer upstream-foreign']);
  });
});

test('pipeline cache/binding pools are per owner, blocked and reassigned work never borrows a foreign account', async (t) => {
  await scenario(t, { clientKeys: [{ id: 'team', name: 'Team B', key: 'team-client-key-123456' }], accounts: [
    { id: 'one', name: 'one', key: 'upstream-one', clientKeyId: 'legacy', maxConcurrent: 1 },
    { id: 'two', name: 'two', key: 'upstream-two', clientKeyId: 'team', maxConcurrent: 1, priority: 1 },
    { id: 'three', name: 'three', key: 'upstream-three', clientKeyId: 'team', maxConcurrent: 1 },
  ] }, async ({ port, upstream, manage }) => {
    const snapshot = await manage('/api/accounts');
    const pipeline = { ...snapshot.json.accountPipeline, sticky: true, healthSort: true, cachePoolSize: 1, cachePoolMaxSize: 2 };
    assert.equal((await manage('/api/accounts', 'POST', { accounts: snapshot.json.accounts, mode: 'sticky', active: 1, concurrencyWaitMs: 0, accountPipeline: pipeline })).status, 200);
    const projected = (await manage('/api/accounts')).json;
    assert.equal(projected.cachePool.scope, 'per-client-key');
    assert.equal(projected.cachePool.actual.unknown, 2, 'one active account in each derived owner pool');
    assert.deepEqual(projected.accounts.map((a) => a.cachePoolRole), ['active', 'active', 'standby']);
    const key = 'team-client-key-123456';
    const firstA = chat(port, legacy, '/v1/chat/completions', 'Authorization', { session_id: 'identical', messages: [{ role: 'user', content: 'hold' }] });
    for (let i = 0; i < 100 && upstream.pending.length < 1; i++) await pause(5);
    assert.equal(upstream.pending.length, 1);
    const firstB = await chat(port, key, '/v1/chat/completions', 'Authorization', { session_id: 'identical' });
    assert.equal(firstB.status, 200, firstB.text);
    assert.equal(firstB.json.choices[0].message.content, 'Bearer upstream-two');
    assert.equal((await chat(port, key, '/v1/chat/completions', 'Authorization', { session_id: 'identical' })).status, 200);
    assert.equal((await chat(port, legacy, '/v1/chat/completions', 'Authorization', { session_id: 'identical' })).status, 429);
    const view = await manage('/api/accounts');
    assert.equal(view.json.cachePool.targetSize, 1, 'foreign standby must not trigger growth for the legacy owner');
    const reassign = await manage('/api/accounts', 'POST', { accounts: view.json.accounts.map((a) => a.id === 'one' ? { ...a, clientKeyId: 'team' } : a), mode: 'sticky', active: 1, concurrencyWaitMs: 0, accountPipeline: pipeline });
    assert.equal(reassign.status, 200, reassign.text);
    assert.equal((await chat(port, legacy, '/v1/chat/completions', 'Authorization', { session_id: 'identical' })).status, 503);
    upstream.release();
    assert.equal((await firstA).status, 200, 'an already leased request finishes on its original account');
    let logs;
    for (let i = 0; i < 100; i++) {
      logs = await manage('/api/logs/requests?limit=100');
      if (logs.json?.items?.filter((row) => row.accountId === 'two').length >= 2 && logs.json?.items?.some((row) => row.accountId === 'one')) break;
      await pause(5);
    }
    assert.equal(logs.status, 200);
    assert.deepEqual(logs.json.items.filter((row) => row.accountId === 'two').map((row) => row.bindingResult).sort(), ['hit', 'miss']);
    assert.equal(logs.json.items.find((row) => row.accountId === 'one').bindingResult, 'miss', 'same session in two client keys has independent bindings');
    assert.ok(!logs.text.includes(key));
  });
});

test('pre-stream account removal replaces only inside the authenticated owner pool', async (t) => {
  await scenario(t, { accounts: [
    { id: 'one', name: 'one', key: 'upstream-one', clientKeyId: 'legacy' },
    { id: 'foreign', name: 'foreign', key: 'upstream-foreign', clientKeyId: 'team' },
    { id: 'backup', name: 'backup', key: 'upstream-backup', clientKeyId: 'legacy' },
  ], clientKeys: [{ id: 'team', name: 'Team B', key: 'team-client-key-123456' }] }, async ({ port, upstream, manage }) => {
    const accounts = (await manage('/api/accounts')).json.accounts;
    const rules = [{ id: 'owner-cooldown', scope: 'account', action: 'cooldown', when: { statuses: [502], body_contains: 'cooldown-owner' }, reset: { fallback: '2s', max: '2s' } }];
    const saved = await manage('/api/accounts', 'POST', { accounts, mode: 'single', active: 0, concurrencyWaitMs: 0, errorRules: rules });
    assert.equal(saved.status, 200, saved.text);
    const result = await chat(port, legacy, '/v1/chat/completions', 'Authorization', { messages: [{ role: 'user', content: 'trigger' }] });
    assert.equal(result.status, 200, result.text);
    assert.equal(result.json.choices[0].message.content, 'Bearer upstream-backup');
    assert.deepEqual(upstream.seen.filter((entry) => entry.url.endsWith('/chat/completions')).map((entry) => entry.auth), ['Bearer upstream-one', 'Bearer upstream-backup']);
    assert.equal((await chat(port, 'team-client-key-123456')).json.choices[0].message.content, 'Bearer upstream-foreign');
  });
});

test('rotation rejects a pending pre-lease admission while already leased work completes', async (t) => {
  await scenario(t, { clientKeys: [{ id: 'team', name: 'Team B', key: 'team-client-key-123456' }], accounts: [
    { id: 'one', name: 'one', key: 'upstream-one', clientKeyId: 'legacy' },
    { id: 'two', name: 'two', key: 'upstream-two', clientKeyId: 'team', maxConcurrent: 1 },
  ] }, async ({ port, upstream, manage }) => {
    const key = 'team-client-key-123456';
    const accounts = (await manage('/api/accounts')).json.accounts;
    assert.equal((await manage('/api/accounts', 'POST', { accounts, mode: 'single', active: 0, concurrencyWaitMs: 200 })).status, 200);
    const first = chat(port, key, '/v1/chat/completions', 'Authorization', { messages: [{ role: 'user', content: 'hold' }] });
    for (let i = 0; i < 100 && !upstream.pending.length; i++) await pause(5);
    assert.equal(upstream.pending.length, 1);
    const pending = chat(port, key);
    await pause(20);
    const rotated = await manage('/api/security/client-keys/team/rotate', 'POST', {});
    assert.equal(rotated.status, 200);
    assert.equal((await chat(port, key)).status, 401);
    upstream.release();
    assert.equal((await first).status, 200);
    assert.equal((await pending).status, 401, 'waiting pre-lease work must not start on the rotated key');
    assert.equal((await chat(port, rotated.json.key)).status, 200);
    assert.equal(upstream.seen.filter((entry) => entry.url.endsWith('/chat/completions') && entry.auth === 'Bearer upstream-two').length, 2);
  });
});

test('a deleted key remains a redaction seed until its original in-flight work finalizes', async (t) => {
  await scenario(t, { clientKeys: [{ id: 'team', name: 'Team B', key: 'team-client-key-123456' }], accounts: [
    { id: 'one', name: 'one', key: 'upstream-one', clientKeyId: 'legacy' },
    { id: 'two', name: 'two', key: 'upstream-two', clientKeyId: 'team' },
  ] }, async ({ dir, port, upstream, manage }) => {
    const key = 'team-client-key-123456'; upstream.echoSecret = key;
    const first = chat(port, key, '/v1/chat/completions', 'Authorization', { messages: [{ role: 'user', content: 'hold-echo' }] });
    for (let i = 0; i < 100 && !upstream.pending.length; i++) await pause(5);
    assert.equal(upstream.pending.length, 1);
    const view = (await manage('/api/accounts')).json;
    assert.equal((await manage('/api/accounts', 'POST', { accounts: view.accounts.map((a) => ({ ...a, clientKeyId: 'legacy' })), mode: 'single', active: 0, concurrencyWaitMs: 0 })).status, 200);
    assert.equal((await manage('/api/security/client-keys/team', 'DELETE')).status, 200);
    upstream.release();
    const failure = await first;
    assert.equal(failure.status, 502);
    assert.ok(!failure.text.includes(key));
    const logs = await manage('/api/logs/errors?limit=100');
    assert.ok(!logs.text.includes(key));
    assert.ok(!fs.readFileSync(path.join(dir, 'metadata.json'), 'utf8').includes(key));
  });
});

test('owner-scoped SSE first-event retry, secret redaction and empty legacy startup/rotation compatibility', async (t) => {
  await scenario(t, { proxyKey: '', accounts: [{ id: 'one', name: 'one', key: 'upstream-one' }] }, async ({ dir, port, upstream, manage, restart }) => {
    assert.equal((await chat(port)).status, 200, 'empty legacy key stays open');
    const rejected = await manage('/api/security/client-keys', 'POST', { name: 'Team B' });
    assert.equal(rejected.status, 400, 'must configure legacy before creating an additional key with a legacy account');
    assert.equal((await manage('/api/security', 'POST', { proxyKey: legacy })).status, 200);
    assert.equal((await chat(port)).status, 401);
    const created = await manage('/api/security/client-keys', 'POST', { name: 'Team B' });
    assert.equal(created.status, 200);
    const saved = (await manage('/api/accounts')).json;
    const team = { name: 'two', key: 'upstream-two', clientKeyId: created.json.id,
      perModel: { [model]: { upstreams: ['first', 'second'], pinMode: 'strict' } } };
    assert.equal((await manage('/api/accounts', 'POST', { accounts: [...saved.accounts, team], mode: 'single', active: 0, concurrencyWaitMs: 0 })).status, 200);
    const key = created.json.key;
    upstream.echoSecret = key;
    const stream = await chat(port, key, '/v1/chat/completions', 'Authorization', { stream: true, session_id: 'identical' });
    assert.equal(stream.status, 200, stream.text);
    assert.match(stream.text, /\[DONE\]/);
    const sent = upstream.seen.filter((entry) => entry.url.endsWith('/chat/completions')).slice(-2);
    assert.deepEqual(sent.map((entry) => entry.auth), ['Bearer upstream-two', 'Bearer upstream-two']);
    assert.equal((await manage('/api/logs/settings', 'POST', { detailedLogging: true })).status, 200);
    const error = await chat(port, key, '/v1/chat/completions', 'Authorization', { messages: [{ role: 'user', content: 'echo' }] });
    assert.equal(error.status, 502);
    assert.ok(!error.text.includes(key), 'error message must redact configured client secrets');
    for (let i = 0; i < 50; i++) {
      const logs = await manage('/api/logs/errors?limit=100');
      if (logs.json?.items?.length) { assert.ok(!logs.text.includes(key)); break; }
      await pause(10);
    }
    assert.ok(!fs.readFileSync(path.join(dir, 'metadata.json'), 'utf8').includes(key));
    const details = path.join(dir, 'detailed-logs');
    for (let i = 0; i < 100; i++) {
      const serialized = (folder) => fs.readdirSync(folder, { withFileTypes: true }).map((entry) => entry.isDirectory() ? serialized(path.join(folder, entry.name)) : fs.readFileSync(path.join(folder, entry.name), 'utf8')).join('');
      if ((await manage('/api/logs/details')).json?.items?.length) {
        assert.ok(!serialized(details).includes(key), 'sanitized detailed capture never retains an additional client key');
        break;
      }
      await pause(10);
    }
    // A security POST changes the running legacy key. A nonempty PROXY_KEY is reapplied only on restart.
    assert.equal((await manage('/api/security', 'POST', { proxyKey: 'running-legacy-456' })).status, 200);
    assert.equal((await chat(port, legacy)).status, 401);
    assert.equal((await chat(port, 'running-legacy-456')).status, 200);
    await restart({ PROXY_KEY: legacy });
    assert.equal((await chat(port, legacy)).status, 200);
    assert.equal((await chat(port, 'running-legacy-456')).status, 401);
  });
});

test('failed full account save retains persisted bytes, runtime owner routing and live credentials', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cps-owner-rollback-'));
  const loader = path.join(dir, 'fault-loader.mjs'), fault = path.join(dir, 'config-fault');
  fs.writeFileSync(loader, `import fs from 'node:fs'; const rename = fs.renameSync;
fs.renameSync = (from, to) => { if (String(to).endsWith('/config.json') && fs.existsSync(${JSON.stringify(fault)})) throw Error('synthetic config rename failure'); return rename(from, to); };`);
  try { await scenario(t, { clientKeys: [{ id: 'team', name: 'Team B', key: 'team-client-key-123456' }], accounts: [
    { id: 'one', name: 'one', key: 'upstream-one', clientKeyId: 'legacy' },
    { id: 'two', name: 'two', key: 'upstream-two', clientKeyId: 'team' },
  ] }, async ({ dir: dataDir, port, upstream, manage }) => {
    const configPath = path.join(dataDir, 'config.json');
    const before = fs.readFileSync(configPath);
    const accounts = (await manage('/api/accounts')).json.accounts;
    fs.writeFileSync(fault, '');
    const failed = await manage('/api/accounts', 'POST', { accounts: accounts.map((account) => account.id === 'two' ? { ...account, clientKeyId: 'legacy' } : account), mode: 'single', active: 1, concurrencyWaitMs: 0 });
    assert.equal(failed.status, 500);
    assert.deepEqual(fs.readFileSync(configPath), before);
    assert.equal((await manage('/api/accounts')).json.accounts.find((a) => a.id === 'two').clientKeyId, 'team');
    assert.equal((await manage('/api/security/client-keys/team', 'DELETE')).status, 409);
    assert.equal((await chat(port, legacy)).json.choices[0].message.content, 'Bearer upstream-one');
    assert.equal((await chat(port, 'team-client-key-123456')).json.choices[0].message.content, 'Bearer upstream-two');
    assert.deepEqual(upstream.seen.filter((entry) => entry.url.endsWith('/chat/completions')).map((entry) => entry.auth), ['Bearer upstream-one', 'Bearer upstream-two']);
    assert.deepEqual(fs.readFileSync(configPath), before);
    assert.equal((await manage('/api/security', 'POST', { proxyKey: 'new-legacy-client-456' })).status, 500);
    assert.equal((await manage('/api/security')).json.proxyKey, legacy);
    assert.equal((await manage('/api/security/client-keys/team/rotate', 'POST', {})).status, 500);
    assert.equal((await chat(port, 'team-client-key-123456')).status, 200);
    assert.equal((await chat(port, 'new-legacy-client-456')).status, 401);
    assert.deepEqual(fs.readFileSync(configPath), before);
    fs.unlinkSync(fault);
    assert.equal((await manage('/api/accounts', 'POST', { accounts: accounts.map((a) => a.id === 'two' ? { ...a, clientKeyId: 'legacy' } : a), mode: 'single', active: 1, concurrencyWaitMs: 0 })).status, 200);
  }, { NODE_OPTIONS: `--import=${loader}` }); }
  finally { t.after(() => fs.rmSync(dir, { recursive: true, force: true })); }
});

test('shared target derives low/high/unknown roles independently and promotes only the saturated owner', async (t) => {
  const key = 'team-client-key-123456';
  const accounts = [
    { id: 'a-low', name: 'a-low', key: 'upstream-a-low', clientKeyId: 'legacy', maxConcurrent: 1 },
    { id: 'a-hot', name: 'a-hot', key: 'upstream-a-hot', clientKeyId: 'legacy', maxConcurrent: 1 },
    { id: 'a-next', name: 'a-next', key: 'upstream-a-next', clientKeyId: 'legacy', maxConcurrent: 1 },
    { id: 'b-low', name: 'b-low', key: 'upstream-b-low', clientKeyId: 'team', maxConcurrent: 1, maxRpm: 1 },
    { id: 'b-hot', name: 'b-hot', key: 'upstream-b-hot', clientKeyId: 'team', maxConcurrent: 1, maxRpm: 1 },
    { id: 'b-unknown', name: 'b-unknown', key: 'upstream-b-unknown', clientKeyId: 'team', maxConcurrent: 1 },
  ];
  await scenario(t, { clientKeys: [{ id: 'team', name: 'Team B', key }], accounts, accountMode: 'sticky', concurrencyWaitMs: 0,
    accountPipeline: { quotaPool: true, healthSort: true, sticky: true, order: ['quotaPool', 'healthSort', 'sticky'], cachePoolSize: 2, cachePoolMaxSize: 3, cachePoolLowQuotaSize: 1 },
  }, async ({ dir, port, upstream, manage, restart }) => {
    let view = await waitFor(async () => {
      const snapshot = (await manage('/api/accounts')).json;
      return snapshot.accounts.filter((a) => a.quota.status === 'fresh').length === 5 ? snapshot : null;
    }, 'five owner quota roles become fresh');
    assert.equal(view.cachePool.scope, 'per-client-key');
    assert.equal(view.cachePool.targetSize, 2);
    assert.deepEqual(view.cachePool.actual, { high: 2, low: 2, unknown: 0 });
    assert.deepEqual(Object.fromEntries(view.accounts.map((a) => [a.id, a.cachePoolRole])), {
      'a-low': 'active', 'a-hot': 'active', 'a-next': 'standby', 'b-low': 'active', 'b-hot': 'active', 'b-unknown': 'standby',
    });
    const firstB = await chat(port, key, '/v1/chat/completions', 'X-Admin-Key', { session_id: 'same', messages: [] });
    const secondB = await chat(port, key, '/v1/chat/completions', 'Authorization', { session_id: 'same', messages: [] });
    assert.equal(firstB.json.choices[0].message.content, 'Bearer upstream-b-low');
    assert.equal(secondB.json.choices[0].message.content, 'Bearer upstream-b-hot', 'low RPM block uses owned hot, not foreign or standby');
    assert.deepEqual(chatAttempts(upstream), ['Bearer upstream-b-low', 'Bearer upstream-b-hot']);
    assert.equal((await manage('/api/accounts')).json.cachePool.targetSize, 2, 'RPM-only/mixed block cannot grow either owner pool');
    const firstA = chat(port, legacy, '/v1/chat/completions', 'Authorization', { session_id: 'same', messages: [{ role: 'user', content: 'hold' }] });
    await waitFor(() => upstream.pending.length === 1, 'first warm A lease');
    const secondA = chat(port, legacy, '/v1/chat/completions', 'Authorization', { session_id: 'same', messages: [{ role: 'user', content: 'hold' }] });
    await waitFor(() => upstream.pending.length === 2, 'same-session temporary hot overflow');
    const thirdA = chat(port, legacy, '/v1/chat/completions', 'Authorization', { session_id: 'new-session', messages: [{ role: 'user', content: 'hold' }] });
    await waitFor(() => upstream.pending.length === 3, 'A standby promoted after both active accounts fill');
    view = (await manage('/api/accounts')).json;
    assert.equal(view.cachePool.targetSize, 3);
    assert.deepEqual(view.cachePool.actual, { high: 3, low: 2, unknown: 1 }, 'admin actual sums separately derived owner memberships');
    assert.ok(view.accounts.every((a) => a.cachePoolRole === 'active'));
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'metadata.json'), 'utf8')).cachePoolTargetSize, 3);
    assert.equal((await chat(port, key, '/v1/chat/completions', 'Authorization', { session_id: 'same' })).json.choices[0].message.content, 'Bearer upstream-b-unknown', 'growth of shared number activates B unknown without borrowing A');
    assert.deepEqual(chatAttempts(upstream), ['Bearer upstream-b-low', 'Bearer upstream-b-hot', 'Bearer upstream-a-low', 'Bearer upstream-a-hot', 'Bearer upstream-a-next', 'Bearer upstream-b-unknown']);
    upstream.release();
    assert.deepEqual((await Promise.all([firstA, secondA, thirdA])).map((r) => r.status), [200, 200, 200]);
    const rows = (await manage('/api/logs/requests?limit=20')).json.items;
    assert.deepEqual(rows.filter((row) => row.accountId?.startsWith('a-')).map((row) => row.selectedQuotaRole).sort(), ['high', 'high', 'low']);
    assert.deepEqual(rows.filter((row) => row.accountId?.startsWith('b-')).map((row) => row.selectedQuotaRole).sort(), ['high', 'low', 'unknown']);
    assert.ok(!JSON.stringify(rows).includes(key), 'ordinary rows never include client credentials');
    await restart();
    view = (await manage('/api/accounts')).json;
    assert.equal(view.cachePool.targetSize, 3);
    assert.deepEqual(view.cachePool.actual, { high: 3, low: 2, unknown: 1 });
  }, {}, Object.fromEntries([['a-low', 85], ['a-hot', 0], ['a-next', 10], ['b-low', 90], ['b-hot', 0]].map(([id, used]) => [`Bearer upstream-${id}`, used])));
});

test('a waiting pipeline admission rechecks owner after account reassignment, not a foreign fallback', async (t) => {
  const key = 'team-client-key-123456';
  await scenario(t, { clientKeys: [{ id: 'team', name: 'Team B', key }], accounts: [
    { id: 'one', name: 'one', key: 'upstream-one', clientKeyId: 'legacy' },
    { id: 'two', name: 'two', key: 'upstream-two', clientKeyId: 'team', maxConcurrent: 1 },
  ], accountMode: 'sticky', concurrencyWaitMs: 250,
    accountPipeline: { quotaPool: false, healthSort: true, sticky: true, order: ['quotaPool', 'healthSort', 'sticky'], cachePoolSize: 1, cachePoolMaxSize: 1, cachePoolLowQuotaSize: 0 },
  }, async ({ port, upstream, manage }) => {
    const first = chat(port, key, '/v1/chat/completions', 'X-Admin-Key', { session_id: 'same', messages: [{ role: 'user', content: 'hold' }] });
    await waitFor(() => upstream.pending.length === 1, 'team lease');
    const waiting = chat(port, key, '/v1/chat/completions', 'Authorization', { session_id: 'same' });
    await pause(30);
    const snapshot = (await manage('/api/accounts')).json;
    assert.equal((await manage('/api/accounts', 'POST', { accounts: snapshot.accounts.map((a) => a.id === 'two' ? { ...a, clientKeyId: 'legacy' } : a), mode: 'sticky', active: 0, concurrencyWaitMs: 250, accountPipeline: snapshot.accountPipeline })).status, 200);
    upstream.release();
    assert.equal((await first).status, 200, 'already leased native work may complete');
    assert.equal((await waiting).status, 503, 'woken pre-lease work has no owned candidate');
    assert.equal((await chat(port, key)).status, 503);
    assert.deepEqual(chatAttempts(upstream), ['Bearer upstream-two']);
  });
});

test('accepted SSE keeps its original owner through rotation; revoke and cancellation never replay or penalize health', async (t) => {
  const key = 'team-client-key-123456';
  await scenario(t, { clientKeys: [{ id: 'team', name: 'Team B', key }], accounts: [
    { id: 'one', name: 'one', key: 'upstream-one', clientKeyId: 'legacy' },
    { id: 'two', name: 'two', key: 'upstream-two', clientKeyId: 'team' },
  ] }, async ({ port, upstream, manage }) => {
    async function startedStream(secret, header) {
      const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', headers: {
        'Content-Type': 'application/json', [header]: header === 'Authorization' ? `Bearer ${secret}` : secret,
      }, body: JSON.stringify({ model, stream: true, session_id: 'same', messages: [{ role: 'user', content: 'stream-hold' }] }) });
      assert.equal(response.status, 200);
      const reader = response.body.getReader();
      const first = await reader.read();
      assert.match(new TextDecoder().decode(first.value), /started/);
      return reader;
    }
    const first = await startedStream(key, 'X-Admin-Key');
    const rotated = await manage('/api/security/client-keys/team/rotate', 'POST', {});
    assert.equal(rotated.status, 200);
    assert.equal((await chat(port, key)).status, 401);
    assert.equal((await chat(port, rotated.json.key)).json.choices[0].message.content, 'Bearer upstream-two');
    upstream.finishStreams();
    let tail = ''; for (let part; !(part = await first.read()).done;) tail += new TextDecoder().decode(part.value);
    assert.match(tail, /\[DONE\]/, 'already leased stream completes on original owner after rotation');
    const beforeCancel = (await manage('/api/accounts')).json.accounts.find((a) => a.id === 'two').health.degrades;
    const second = await startedStream(rotated.json.key, 'Authorization');
    const snapshot = (await manage('/api/accounts')).json;
    assert.equal((await manage('/api/accounts', 'POST', { accounts: snapshot.accounts.map((a) => a.id === 'two' ? { ...a, clientKeyId: 'legacy' } : a), mode: 'single', active: 0, concurrencyWaitMs: 0 })).status, 200);
    assert.equal((await manage('/api/security/client-keys/team', 'DELETE')).status, 200);
    assert.equal((await chat(port, rotated.json.key)).status, 401, 'revoked secret is denied before a new native attempt');
    await second.cancel();
    await waitFor(() => upstream.streamPending.every((res) => res.destroyed), 'cancelled upstream stream socket');
    await waitFor(async () => (await manage('/api/accounts')).json.accounts.find((a) => a.id === 'two').activeCount === 0, 'cancelled lease release');
    assert.equal((await manage('/api/accounts')).json.accounts.find((a) => a.id === 'two').health.degrades, beforeCancel);
    const cancelled = await waitFor(async () => (await manage('/api/logs/requests?result=client_cancelled')).json.items?.find((row) => row.accountId === 'two'), 'cancelled request row');
    assert.equal(cancelled.status, 499);
    assert.deepEqual(chatAttempts(upstream), ['Bearer upstream-two', 'Bearer upstream-two', 'Bearer upstream-two']);
  });
});

test('a post-first-data SSE account failure may cool its owner but cannot replay across keys', async (t) => {
  const key = 'team-client-key-123456';
  await scenario(t, { clientKeys: [{ id: 'team', name: 'Team B', key }], accounts: [
    { id: 'one', name: 'one', key: 'upstream-one', clientKeyId: 'legacy' },
    { id: 'two', name: 'two', key: 'upstream-two', clientKeyId: 'team' },
  ] }, async ({ port, upstream, manage }) => {
    const snapshot = (await manage('/api/accounts')).json;
    const rule = { id: 'team-cooldown', scope: 'account', action: 'cooldown', when: { statuses: [502] }, reset: { fallback: '2s', max: '2s' } };
    assert.equal((await manage('/api/accounts', 'POST', { accounts: snapshot.accounts, mode: 'single', active: 1, concurrencyWaitMs: 0, errorRules: [rule] })).status, 200);
    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, stream: true, messages: [{ role: 'user', content: 'stream-hold' }] }) });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    assert.match(new TextDecoder().decode((await reader.read()).value), /started/);
    upstream.finishStreams('data: {"error":{"message":"team stream failure","status":502}}\n\n');
    let tail = ''; for (let part; !(part = await reader.read()).done;) tail += new TextDecoder().decode(part.value);
    assert.match(tail, /team stream failure/);
    assert.deepEqual(chatAttempts(upstream), ['Bearer upstream-two'], 'no replay after client-visible output');
    await waitFor(async () => (await manage('/api/accounts')).json.accounts.find((a) => a.id === 'two').state?.cooldownUntil > Date.now(), 'owner-only cooldown');
    assert.equal((await chat(port, key)).status, 503, 'blocked owner cannot borrow legacy even with an active foreign account');
    assert.equal((await chat(port, legacy)).json.choices[0].message.content, 'Bearer upstream-one');
    assert.deepEqual(chatAttempts(upstream), ['Bearer upstream-two', 'Bearer upstream-one']);
  });
});

test('all six legacy modes scope concurrency, RPM, disabled fallback and cooldown before foreign candidates', async (t) => {
  const key = 'team-client-key-123456';
  await scenario(t, { clientKeys: [{ id: 'team', name: 'Team B', key }], accounts: [
    { id: 'one', name: 'foreign', key: 'upstream-one', clientKeyId: 'legacy' },
    { id: 'two', name: 'primary', key: 'upstream-two', clientKeyId: 'team', maxConcurrent: 1, maxRpm: 1 },
    { id: 'three', name: 'backup', key: 'upstream-three', clientKeyId: 'team', enabled: false },
  ] }, async ({ port, upstream, manage }) => {
    const modes = ['single', 'roundrobin', 'sticky', 'least-connections', 'weighted-roundrobin', 'priority-failover'];
    const save = async (mode, two, three, errorRules = []) => {
      const view = (await manage('/api/accounts')).json;
      const accounts = view.accounts.map((a) => a.id === 'two' ? { ...a, ...two } : a.id === 'three' ? { ...a, ...three } : a);
      const response = await manage('/api/accounts', 'POST', { accounts, mode, active: 0, concurrencyWaitMs: 0, errorRules,
        accountPipeline: { ...view.accountPipeline, quotaPool: false, healthSort: false, sticky: false, cachePoolSize: 0, cachePoolMaxSize: 0, cachePoolLowQuotaSize: 0 } });
      assert.equal(response.status, 200, `${mode}: ${response.text}`);
    };
    for (const mode of modes) {
      // An explicit zero clears committed RPM state without changing account identity.
      await save(mode, { maxRpm: 0, enabled: true }, { enabled: false });
      await save(mode, { maxRpm: 1 }, {});
      upstream.seen.length = 0;
      const held = chat(port, key, '/v1/chat/completions', 'Authorization', { session_id: 'shared', messages: [{ role: 'user', content: 'hold' }] });
      await waitFor(() => upstream.pending.length === 1, `${mode} first owned attempt`);
      assert.equal((await chat(port, key)).status, 429, `${mode}: own concurrency full despite foreign idle`);
      assert.deepEqual(chatAttempts(upstream), ['Bearer upstream-two'], `${mode}: no foreign attempt on concurrency block`);
      upstream.release();
      assert.equal((await held).status, 200);
      assert.equal((await chat(port, key)).status, 429, `${mode}: committed own RPM exhausted`);
      assert.deepEqual(chatAttempts(upstream), ['Bearer upstream-two'], `${mode}: no foreign attempt on RPM block`);
      await save(mode, { enabled: false }, { enabled: true });
      const fallback = await chat(port, key, '/v1/chat/completions', 'X-Admin-Key', { session_id: 'shared' });
      assert.equal(fallback.status, 200, `${mode}: ${fallback.text}`);
      assert.equal(fallback.json.choices[0].message.content, 'Bearer upstream-three');
      assert.deepEqual(chatAttempts(upstream), ['Bearer upstream-two', 'Bearer upstream-three'], `${mode}: fallback remains owned`);
    }
    const rule = { id: 'cooldown-team', scope: 'account', action: 'cooldown', when: { statuses: [502], body_contains: 'cooldown-owner' }, reset: { fallback: '5s', max: '5s' } };
    await save('single', { enabled: true, maxRpm: 0 }, { enabled: false }, [rule]);
    upstream.seen.length = 0;
    await chat(port, key, '/v1/chat/completions', 'Authorization', { messages: [{ role: 'user', content: 'cooldown-team' }] });
    const cooled = await chat(port, key);
    assert.equal(cooled.status, 503, 'cooldown removes only the owned candidate; foreign stays idle');
    assert.deepEqual(chatAttempts(upstream), ['Bearer upstream-two']);
  });
});

test('simultaneous identical sessions under both owners cannot share bindings across reassignment/rotation', async (t) => {
  const key = 'team-client-key-123456';
  await scenario(t, { clientKeys: [{ id: 'team', name: 'Team B', key }], accounts: [
    { id: 'one', name: 'one', key: 'upstream-one', clientKeyId: 'legacy' },
    { id: 'two', name: 'two', key: 'upstream-two', clientKeyId: 'team', priority: 1 },
    { id: 'three', name: 'three', key: 'upstream-three', clientKeyId: 'team' },
  ], accountMode: 'sticky', concurrencyWaitMs: 0,
  accountPipeline: { quotaPool: false, healthSort: true, sticky: true, order: ['quotaPool', 'healthSort', 'sticky'], cachePoolSize: 1, cachePoolMaxSize: 1 },
  }, async ({ port, upstream, manage }) => {
    const held = [legacy, key].map((secret) => chat(port, secret, '/v1/chat/completions', 'Authorization', { session_id: 'same-session', messages: [{ role: 'user', content: 'hold' }] }));
    await waitFor(() => upstream.pending.length === 2, 'both original owners have leased the same session');
    assert.deepEqual(chatAttempts(upstream).sort(), ['Bearer upstream-one', 'Bearer upstream-two']);
    const view = (await manage('/api/accounts')).json;
    assert.equal((await manage('/api/accounts', 'POST', { accounts: view.accounts.map((a) => a.id === 'two' ? { ...a, clientKeyId: 'legacy' } : a), mode: 'sticky', active: 0, concurrencyWaitMs: 0, accountPipeline: view.accountPipeline })).status, 200);
    const rotated = await manage('/api/security/client-keys/team/rotate', 'POST', {});
    assert.equal(rotated.status, 200);
    assert.equal((await chat(port, key, '/v1/chat/completions', 'Authorization', { session_id: 'same-session' })).status, 401);
    const newOwner = await chat(port, rotated.json.key, '/v1/chat/completions', 'Authorization', { session_id: 'same-session' });
    assert.equal(newOwner.status, 200, newOwner.text);
    assert.equal(newOwner.json.choices[0].message.content, 'Bearer upstream-three', 'old binding cannot select the reassigned foreign account');
    upstream.release();
    assert.deepEqual((await Promise.all(held)).map((r) => r.status), [200, 200], 'both original leases complete after ownership changes');
    const rows = await waitFor(async () => {
      const response = await manage('/api/logs/requests?limit=20');
      return response.json?.items?.filter((item) => ['one', 'two'].includes(item.accountId)).length === 2 ? response.json.items : null;
    }, 'two independent completed binding rows');
    assert.deepEqual(rows.filter((row) => row.status === 200 && ['one', 'two'].includes(row.accountId)).map((row) => row.bindingResult).sort(), ['miss', 'miss'], 'both original native calls had independent bindings');
    assert.deepEqual(chatAttempts(upstream).sort(), ['Bearer upstream-one', 'Bearer upstream-three', 'Bearer upstream-two'].sort(), 'new admission uses only still-owned standby while old leases complete');
  });
});

test('non-stream provider retry stays on its leased owner and commits final usage once', async (t) => {
  const key = 'team-client-key-123456';
  await scenario(t, { clientKeys: [{ id: 'team', name: 'Team B', key }], accounts: [
    { id: 'one', name: 'one', key: 'upstream-one', clientKeyId: 'legacy' },
    { id: 'two', name: 'two', key: 'upstream-two', clientKeyId: 'team', perModel: { [model]: { upstreams: ['first', 'second'], pinMode: 'strict' } } },
  ] }, async ({ port, upstream, manage }) => {
    const result = await chat(port, key, '/api/v1/chat/completions', 'X-Admin-Key', { messages: [{ role: 'user', content: 'retry-first' }] });
    assert.equal(result.status, 200, result.text);
    assert.equal(result.json.choices[0].message.content, 'Bearer upstream-two');
    assert.deepEqual(upstream.seen.filter((entry) => entry.url.endsWith('/chat/completions')).map(({ auth, provider }) => ({ auth, provider })), [
      { auth: 'Bearer upstream-two', provider: 'first' }, { auth: 'Bearer upstream-two', provider: 'second' },
    ]);
    const stats = (await manage('/api/statistics')).json;
    assert.equal(stats.lifetime.global.requests, 1);
    assert.equal(stats.lifetime.global.usageRequests, 1);
    assert.equal(stats.lifetime.global.inputTokens, 7);
    assert.equal(stats.lifetime.global.outputTokens, 3);
    const rows = (await manage('/api/logs/requests?limit=10')).json.items;
    assert.equal(rows.length, 1); assert.equal(rows[0].attempts.length, 2);
    assert.deepEqual((await manage('/api/logs/errors?limit=10')).json.items.map((row) => row.accountId), ['two']);
  });
});

test('each admin probe/test route accepts explicit cross-owner ID only with Cookie/CSRF; ID-less selection stays global', async (t) => {
  const key = 'team-client-key-123456';
  await scenario(t, { clientKeys: [{ id: 'team', name: 'Team B', key }], accounts: [
    { id: 'one', name: 'one', key: 'upstream-one', clientKeyId: 'legacy' },
    { id: 'two', name: 'two', key: 'upstream-two', clientKeyId: 'team' },
  ], accountMode: 'single', activeAccount: 0 }, async ({ port, upstream, manage }) => {
    const proxy = http.createServer();
    const sockets = new Set();
    proxy.on('connect', (_req, client, head) => {
      sockets.add(client);
      const target = net.connect(upstream.address().port, '127.0.0.1', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) target.write(head);
        target.pipe(client); client.pipe(target);
      });
      sockets.add(target);
      target.on('error', () => client.destroy());
    });
    const proxyPort = await listen(proxy);
    t.after(async () => { for (const socket of sockets) socket.destroy(); await close(proxy); });
    const paths = [
      ['/api/test', { model, accountId: 'two' }],
      ['/api/probe', { model, accountId: 'two' }],
      ['/api/validate-upstreams', { model, accountId: 'two' }],
      ['/api/accounts/test', { accountId: 'two', key: 'upstream-two' }],
      ['/api/accounts/proxy-test', { accountId: 'two', proxyUrl: `http://127.0.0.1:${proxyPort}` }],
    ];
    for (const [route, body] of paths) {
      for (const header of ['Authorization', 'X-Admin-Key']) {
        assert.equal((await api(port, route, { method: 'POST', body, key, header })).status, 401, `${route} ${header} cannot manage`);
      }
    }
    assert.equal(chatAttempts(upstream).length, 0, 'client-only probes must not reach native transport');
    // Same Cookie without the exact CSRF token cannot send a management attempt.
    const login = await api(port, '/api/auth/login', { method: 'POST', body: { password: admin } });
    assert.equal(login.status, 200);
    for (const [route, body] of paths) {
      assert.equal((await api(port, route, { method: 'POST', body, cookie: login.cookie, key })).status, 401, `${route} requires CSRF`);
      const before = chatAttempts(upstream).length;
      const response = await manage(route, 'POST', body);
      assert.equal(response.status, 200, `${route}: ${response.text}`);
      assert.ok(chatAttempts(upstream).length > before, `${route} made a native upstream attempt`);
      assert.ok(chatAttempts(upstream).slice(before).every((auth) => auth === 'Bearer upstream-two'), `${route} explicit team ID uses only its upstream Authorization`);
    }
    for (const route of ['/api/test', '/api/probe', '/api/validate-upstreams']) {
      const before = chatAttempts(upstream).length;
      const response = await manage(route, 'POST', { model });
      assert.equal(response.status, 200, `${route} ID-less compatibility: ${response.text}`);
      assert.ok(chatAttempts(upstream).length > before);
      assert.ok(chatAttempts(upstream).slice(before).every((auth) => auth === 'Bearer upstream-one'), `${route} ID-less fallback still uses global active account`);
    }
  });
});

test('malformed canonical inventory fails startup without rewriting operator config', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cps-malformed-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fixture(dir, {}); // initialized independent verifier must reject a client-key collision before migration writes
  const malformed = [
    { proxyKey: legacy, clientKeys: [{ id: 'legacy', name: 'collision', key: 'another-valid-key-123' }] },
    { proxyKey: legacy, clientKeys: [{ id: 'second', name: 'A', key: legacy }] },
    { proxyKey: legacy, clientKeys: [{ id: 'second', name: 'A', key: 'another-valid-key-123' }], accounts: [{ id: 'one', key: 'upstream-one', clientKeyId: 'unknown' }] },
    { proxyKey: legacy, clientKeys: [{ id: 'second', name: 'A', key: admin }] },
  ];
  for (const config of malformed) {
    const bytes = JSON.stringify(config); fs.writeFileSync(path.join(dir, 'config.json'), bytes);
    const child = spawn(process.execPath, ['server.js'], { cwd: path.resolve('.'), env: { ...process.env, DATA_DIR: dir, PROXY_KEY: '', CLINE_PASS_KEY: '', CLINE_PASS_ADMIN_BOOTSTRAP: '' }, stdio: 'ignore' });
    await new Promise((resolve) => child.once('exit', resolve));
    assert.notEqual(child.exitCode, 0); assert.equal(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'), bytes);
  }
  const duplicateWithOverride = JSON.stringify({ proxyKey: legacy, clientKeys: [{ id: 'second', name: 'A', key: legacy }] });
  fs.writeFileSync(path.join(dir, 'config.json'), duplicateWithOverride);
  const overridden = spawn(process.execPath, ['server.js'], { cwd: path.resolve('.'), env: {
    ...process.env, DATA_DIR: dir, PROXY_KEY: 'otherwise-valid-env-key-123', CLINE_PASS_KEY: '', CLINE_PASS_ADMIN_BOOTSTRAP: '',
  }, stdio: 'ignore' });
  await new Promise((resolve) => overridden.once('exit', resolve));
  assert.notEqual(overridden.exitCode, 0);
  assert.equal(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'), duplicateWithOverride);
});

test('empty Legacy cannot gain an anonymous environment account alongside additional keys on startup', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cps-env-owner-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const initial = { proxyKey: '', clientKeys: [{ id: 'team', name: 'Team B', key: 'team-client-key-123456' }],
    accounts: [{ id: 'team-account', name: 'team', key: 'upstream-team', clientKeyId: 'team' }] };
  fixture(dir, initial);
  const file = path.join(dir, 'config.json'), bytes = fs.readFileSync(file);
  const rejected = spawn(process.execPath, ['server.js'], { cwd: path.resolve('.'), env: {
    ...process.env, DATA_DIR: dir, PROXY_KEY: '', CLINE_PASS_KEY: 'synthetic-injected-upstream', CLINE_PASS_ADMIN_BOOTSTRAP: '',
    PORT: '0', BIND_HOST: '127.0.0.1',
  }, stdio: 'ignore' });
  await new Promise((resolve) => rejected.once('exit', resolve));
  assert.notEqual(rejected.exitCode, 0);
  assert.deepEqual(fs.readFileSync(file), bytes, 'rejected startup must not rewrite operator config');
  const accepted = spawn(process.execPath, ['server.js'], { cwd: path.resolve('.'), env: {
    ...process.env, DATA_DIR: dir, PROXY_KEY: legacy, CLINE_PASS_KEY: 'synthetic-injected-upstream',
    CLINE_PASS_ADMIN_BOOTSTRAP: '', PORT: '0', BIND_HOST: '127.0.0.1',
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => stop(accepted));
  let output = '';
  accepted.stdout.on('data', (chunk) => { output += chunk; });
  await waitFor(() => output.includes('OpenAI 兼容代理地址') || accepted.exitCode !== null, 'env-backed Legacy startup');
  assert.equal(accepted.exitCode, null, 'a nonempty startup override makes the injected Legacy account authenticated');
  await stop(accepted);
});
