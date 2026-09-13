import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = (server) => new Promise((resolve) => server.close(resolve));
function rawJson(port, pathname, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request({ hostname: '127.0.0.1', port, path: pathname, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': data.length, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject); req.end(data);
  });
}

async function startSwitcher(config, existingDir = null) {
  const dir = existingDir || fs.mkdtempSync(path.join(os.tmpdir(), 'cps-test-'));
  if (config) fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config));
  const child = spawn(process.execPath, ['server.js'], { cwd: path.resolve('.'), env: { ...process.env, DATA_DIR: dir, BIND_HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (c) => { output += c; }); child.stderr.on('data', (c) => { output += c; });
  await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(`switcher startup timeout: ${output}`)), 5000);
    const poll = setInterval(() => { if (output.includes('OpenAI 兼容代理地址')) { clearInterval(poll); clearTimeout(deadline); resolve(); } }, 20);
    child.once('exit', (code) => { clearInterval(poll); clearTimeout(deadline); reject(new Error(`switcher exited ${code}: ${output}`)); });
  });
  return { dir, child };
}

const stop = (child) => new Promise((resolve) => { child.once('exit', resolve); child.kill('SIGTERM'); setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 1000).unref(); });

test('account routing, header boundary, failover, state and streaming', async (t) => {
  const seen = [];
  let upstreamAborted = false;
  const mock = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : {};
      seen.push({ headers: req.headers, body });
      const auth = req.headers.authorization;
      const only = body.provider?.only?.[0] || body.providerOptions?.gateway?.only?.[0];
      if ((body.model === 'cooldown-model' && auth === 'Bearer key-a') || (body.model === 'double-cooldown-model' && (auth === 'Bearer key-a' || auth === 'Bearer key-b'))) {
        res.writeHead(429, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'rate limited', status: 429 } }));
      }
      if (body.model === 'ban-model' && auth === 'Bearer key-a') {
        res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'account failed', status: 500 } }));
      }
      if (body.model === 'sse-error-model' && body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: {"err');
        return setTimeout(() => res.end('or":{"message":"limited","status":429}}\n\n'), 5);
      }
      if (body.model === 'abort-model') {
        res.on('close', () => { if (!res.writableEnded) upstreamAborted = true; });
        return;
      }
      if (body.model === 'planner-model') {
        if (only === '__probe__') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Available providers are: alpha, beta.' }));
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ choices: [{ message: { content: 'OK', provider_metadata: { gateway: { routing: { finalProvider: only || 'alpha', canonicalSlug: 'mock/planner' } } } } }] }));
      }
      if (only === 'first' || String(only || '').startsWith('fail-')) {
        res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'supplier failed', status: 500 } }));
      }
      if (body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: {"choices":[{"delta":{"content":"OK"}}]}\n\n');
        return res.end('data: [DONE]\n\n');
      }
      const reply = () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: 'OK' } }], provider: 'Mock Provider', model: 'mock/model' })); };
      if (body.model === 'slow-model') return setTimeout(reply, 150);
      reply();
    });
  });
  const upstreamPort = await listen(mock);
  const switchPort = await new Promise(async (resolve) => { const s = http.createServer(); const p = await listen(s); await close(s); resolve(p); });
  const baseConfig = {
    port: switchPort, upstreamBase: `http://127.0.0.1:${upstreamPort}`, accountMode: 'sticky', concurrencyWaitMs: 20,
    accounts: [
      { id: 'a', name: 'A', key: 'key-a', enabled: true, maxConcurrent: 0, perModel: {} },
      { id: 'b', name: 'B', key: 'key-b', enabled: true, maxConcurrent: 0, perModel: {} },
    ], knownModels: ['test-model', 'planner-model', 'slow-model', 'abort-model', 'cooldown-model', 'double-cooldown-model', 'ban-model', 'sse-error-model'], perModel: {}, accountErrorRules: {},
  };
  const { child, dir } = await startSwitcher(baseConfig);
  t.after(async () => { await stop(child); await close(mock); fs.rmSync(dir, { recursive: true, force: true }); });

  const headers = { 'Session-Id': 'stable-session', 'User-Agent': 'real-client/1', Cookie: 'secret-cookie', 'Proxy-Authorization': 'Basic bad', Authorization: 'Bearer downstream-secret' };
  const one = await rawJson(switchPort, '/v1/chat/completions', { model: 'test-model', messages: [{ role: 'user', content: 'hello' }] }, headers);
  const two = await rawJson(switchPort, '/v1/chat/completions', { model: 'test-model', messages: [{ role: 'user', content: 'different' }] }, headers);
  assert.equal(one.status, 200); assert.equal(two.headers['x-cline-account'], one.headers['x-cline-account']);
  const messageOne = await rawJson(switchPort, '/v1/chat/completions', { model: 'test-model', messages: [{ role: 'system', content: 'stable setup' }, { role: 'user', content: 'opening' }] });
  const messageTwo = await rawJson(switchPort, '/v1/chat/completions', { model: 'test-model', messages: [{ role: 'system', content: 'stable setup' }, { role: 'user', content: 'opening' }, { role: 'assistant', content: 'reply' }, { role: 'user', content: 'follow-up' }] });
  assert.equal(messageOne.headers['x-cline-account'], messageTwo.headers['x-cline-account'], 'message fallback must only use stable opening messages');
  const requestIdOnlyOne = await rawJson(switchPort, '/v1/chat/completions', { model: 'test-model', messages: [] }, { 'X-Client-Request-Id': 'request-one' });
  const requestIdOnlyTwo = await rawJson(switchPort, '/v1/chat/completions', { model: 'test-model', messages: [] }, { 'X-Client-Request-Id': 'request-two' });
  assert.notEqual(requestIdOnlyOne.headers['x-cline-account'], requestIdOnlyTwo.headers['x-cline-account'], 'request IDs alone must fall back to round-robin');
  assert.equal(seen[0].headers['user-agent'], 'real-client/1');
  assert.equal(seen[0].headers.cookie, undefined); assert.equal(seen[0].headers['proxy-authorization'], undefined);
  assert.match(seen[0].headers.authorization, /^Bearer key-[ab]$/); assert.notEqual(seen[0].headers.authorization, 'Bearer downstream-secret');
  const codexParent = await rawJson(switchPort, '/v1/chat/completions', { model: 'test-model', messages: [] }, { 'Session-Id': 'parent-thread' });
  const codexChild = await rawJson(switchPort, '/v1/chat/completions', { model: 'test-model', messages: [] }, { 'X-Codex-Parent-Thread-Id': 'parent-thread', 'Session-Id': 'child-thread' });
  assert.equal(codexParent.headers['x-cline-account'], codexChild.headers['x-cline-account']);
  const claudeParent = await rawJson(switchPort, '/v1/chat/completions', { model: 'test-model', messages: [] }, { 'X-Claude-Code-Session-Id': 'agent-root' });
  const claudeChild = await rawJson(switchPort, '/v1/chat/completions', { model: 'test-model', messages: [] }, { 'X-Claude-Code-Parent-Agent-Id': 'agent-root', 'X-Claude-Code-Session-Id': 'agent-child' });
  assert.equal(claudeParent.headers['x-cline-account'], claudeChild.headers['x-cline-account']);
  const genericRoot = await rawJson(switchPort, '/v1/chat/completions', { model: 'test-model', messages: [] }, { 'Session-Id': 'generic-root' });
  const genericChild = await rawJson(switchPort, '/v1/chat/completions', { model: 'test-model', messages: [] }, { 'X-Parent-Session-ID': 'generic-root', 'Session-Id': 'generic-child' });
  assert.equal(genericRoot.headers['x-cline-account'], genericChild.headers['x-cline-account'], 'generic parent identity must take priority');
  await rawJson(switchPort, '/v1/chat/completions', { model: 'test-model', metadata: { user_id: '{"session_id":"claude-one"}' }, messages: [] }, { 'Anthropic-Version': '2023-06-01', 'HTTP-Referer': 'https://must-not-forward.example' });
  assert.equal(seen.at(-1).headers['anthropic-version'], '2023-06-01');
  assert.equal(seen.at(-1).headers['http-referer'], undefined, 'Claude allowlist must not include generic-only headers');

  assert.equal((await rawJson(switchPort, '/api/config', { scope: 'typo', perModel: {} })).status, 400);
  const malformed = await new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: switchPort, path: '/api/config', method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.end('{');
  });
  assert.equal(malformed, 400);

  const accounts = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'))).accounts;
  const chosen = accounts.find((a) => a.name === one.headers['x-cline-account']);
  const other = accounts.find((a) => a.id !== chosen.id);
  const save = await rawJson(switchPort, '/api/config', { scope: 'account', accountId: chosen.id, perModel: { 'test-model': { upstreams: ['first', 'second'], exclude: [], pinMode: 'strict', sort: null } } });
  assert.equal(save.status, 200);
  const accountView = await (await fetch(`http://127.0.0.1:${switchPort}/api/models?accountId=${chosen.id}`)).json();
  assert.equal(accountView.subscription.find((m) => m.id === 'test-model').configSource, 'account');
  seen.length = 0;
  const retry = await rawJson(switchPort, '/v1/chat/completions', { model: 'test-model', messages: [{ role: 'user', content: 'x' }] }, { 'Session-Id': 'stable-session' });
  assert.equal(retry.status, 200); assert.equal(seen.length, 2);
  assert.equal(seen[0].headers.authorization, seen[1].headers.authorization, 'supplier retries must keep one account');
  assert.deepEqual(seen.map((x) => x.body.provider.only[0]), ['first', 'second']);
  seen.length = 0;
  await rawJson(switchPort, '/api/config', { scope: 'account', accountId: chosen.id, perModel: { 'test-model': { upstreams: ['fail-one', 'fail-two', 'third'], exclude: [], pinMode: 'strict', sort: null, maxRetries: 1 } } });
  const capped = await rawJson(switchPort, '/v1/chat/completions', { model: 'test-model', messages: [] }, { 'Session-Id': 'stable-session' });
  assert.equal(capped.status, 500); assert.equal(seen.length, 2, 'maxRetries limits attempts after the first request');
  assert.deepEqual(seen.map((x) => x.body.provider.only[0]), ['fail-one', 'fail-two']);
  assert.equal((await rawJson(switchPort, '/api/config', { scope: 'account', accountId: chosen.id, action: 'inherit', model: 'test-model' })).status, 200);
  const inheritedView = await (await fetch(`http://127.0.0.1:${switchPort}/api/models?accountId=${chosen.id}`)).json();
  assert.equal(inheritedView.subscription.find((m) => m.id === 'test-model').configSource, 'inherited');

  // Probe both known pipelines and verify each receives only its native routing shape.
  assert.equal((await rawJson(switchPort, '/api/probe', { model: 'test-model' })).status, 200);
  assert.equal((await rawJson(switchPort, '/api/probe', { model: 'planner-model' })).status, 200);
  await rawJson(switchPort, '/api/config', { scope: 'global', perModel: { 'planner-model': { upstreams: ['alpha'], pinMode: 'strict' } } });
  seen.length = 0;
  assert.equal((await rawJson(switchPort, '/v1/chat/completions', { model: 'planner-model', messages: [] }, { 'Session-Id': 'planner-session' })).status, 200);
  assert.deepEqual(seen.at(-1).body.providerOptions.gateway.only, ['alpha']);
  assert.equal(seen.at(-1).body.provider, undefined);

  await rawJson(switchPort, '/api/accounts', { accounts, mode: 'single', active: accounts.findIndex((a) => a.id === 'a'), concurrencyWaitMs: 20, accountErrorRules: { '429': { action: 'cooldown', cooldownMs: 60000 } } });
  seen.length = 0;
  const cooled = await rawJson(switchPort, '/v1/chat/completions', { model: 'cooldown-model', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(cooled.status, 200); assert.deepEqual(seen.map((x) => x.headers.authorization), ['Bearer key-a', 'Bearer key-b']);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'metadata.json')));
  assert.ok(meta.accountStates.a.cooldownUntil > Date.now()); assert.equal(JSON.stringify(meta).includes('stable-session'), false);
  const cooldownHistory = await (await fetch(`http://127.0.0.1:${switchPort}/api/history`)).json();
  assert.deepEqual(cooldownHistory.history[0].accountPath, ['A', 'B']);
  assert.equal(cooldownHistory.history[0].accountActions[0].action, 'cooldown');
  assert.equal((await rawJson(switchPort, '/api/accounts/recover', { id: 'a' })).status, 200);

  // Even with a third healthy account available, a second removal action must not trigger a third account attempt.
  const threeAccounts = [...accounts, { name: 'C', key: 'key-c', enabled: true, maxConcurrent: 0, perModel: {} }];
  assert.equal((await rawJson(switchPort, '/api/accounts', { accounts: threeAccounts, mode: 'single', active: 0, concurrencyWaitMs: 20, accountErrorRules: { '429': { action: 'cooldown', cooldownMs: 60000 } } })).status, 200);
  seen.length = 0;
  const twiceRemoved = await rawJson(switchPort, '/v1/chat/completions', { model: 'double-cooldown-model', messages: [] });
  assert.equal(twiceRemoved.status, 429);
  assert.deepEqual(seen.map((x) => x.headers.authorization), ['Bearer key-a', 'Bearer key-b']);
  await rawJson(switchPort, '/api/accounts/recover', { id: 'a' });
  await rawJson(switchPort, '/api/accounts/recover', { id: 'b' });

  await rawJson(switchPort, '/api/accounts', { accounts, mode: 'single', active: accounts.findIndex((a) => a.id === 'a'), concurrencyWaitMs: 20, accountErrorRules: { '500': { action: 'ban' } } });
  seen.length = 0;
  const banned = await rawJson(switchPort, '/v1/chat/completions', { model: 'ban-model', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(banned.status, 200); assert.deepEqual(seen.map((x) => x.headers.authorization), ['Bearer key-a', 'Bearer key-b']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'metadata.json'))).accountStates.a.banned, true);
  seen.length = 0;
  await rawJson(switchPort, '/v1/chat/completions', { model: 'test-model', messages: [] });
  assert.deepEqual(seen.map((x) => x.headers.authorization), ['Bearer key-b'], 'banned account must leave the candidate set');
  assert.equal((await rawJson(switchPort, '/api/accounts/recover', { id: 'a' })).status, 200);

  await rawJson(switchPort, '/api/accounts', { accounts, mode: 'single', active: 0, concurrencyWaitMs: 20, accountErrorRules: {} });
  const preStreamError = await rawJson(switchPort, '/v1/chat/completions', { model: 'sse-error-model', stream: true, messages: [] });
  assert.equal(preStreamError.status, 429, 'fragmented SSE first error event must be normalized before response starts');

  const streamed = await rawJson(switchPort, '/v1/chat/completions', { model: 'test-model', stream: true, messages: [{ role: 'user', content: 'stream' }] });
  assert.equal(streamed.status, 200); assert.match(streamed.text, /data:.*OK/); assert.match(streamed.text, /\[DONE\]/);

  // Missing User-Agent remains missing on the forwarded request (native transport adds no synthetic UA).
  seen.length = 0;
  await rawJson(switchPort, '/v1/chat/completions', { model: 'test-model', messages: [{ role: 'user', content: 'no ua' }] });
  assert.equal(seen[0].headers['user-agent'], undefined);
  assert.equal(JSON.stringify(await (await fetch(`http://127.0.0.1:${switchPort}/api/history`)).json()).includes('key-a'), false);

  // Legacy round-robin alternates; sticky capacity temporarily overflows and returns 429 when all accounts are full.
  await rawJson(switchPort, '/api/accounts', { accounts, mode: 'roundrobin', active: 0, concurrencyWaitMs: 20, accountErrorRules: {} });
  const rr1 = await rawJson(switchPort, '/v1/chat/completions', { model: 'test-model', messages: [] });
  const rr2 = await rawJson(switchPort, '/v1/chat/completions', { model: 'test-model', messages: [] });
  assert.notEqual(rr1.headers['x-cline-account'], rr2.headers['x-cline-account']);
  const limited = accounts.map((a) => ({ ...a, maxConcurrent: 1 }));
  await rawJson(switchPort, '/api/accounts', { accounts: limited, mode: 'sticky', active: 0, concurrencyWaitMs: 20, accountErrorRules: {} });
  const slowBody = { model: 'slow-model', messages: [{ role: 'user', content: 'same' }] };
  const p1 = rawJson(switchPort, '/v1/chat/completions', slowBody, { 'Session-Id': 'capacity-session' });
  await new Promise((r) => setTimeout(r, 10));
  const p2 = rawJson(switchPort, '/v1/chat/completions', slowBody, { 'Session-Id': 'capacity-session' });
  await new Promise((r) => setTimeout(r, 35));
  const full = await rawJson(switchPort, '/v1/chat/completions', slowBody, { 'Session-Id': 'capacity-session' });
  const [slow1, slow2] = await Promise.all([p1, p2]);
  assert.equal(slow1.status, 200); assert.equal(slow2.status, 200); assert.notEqual(slow1.headers['x-cline-account'], slow2.headers['x-cline-account']);
  assert.equal(full.status, 429); assert.ok(Number(full.headers['retry-after']) >= 1);
  const after = await (await fetch(`http://127.0.0.1:${switchPort}/api/accounts`)).json();
  assert.ok(after.accounts.every((a) => a.activeCount === 0));

  // A downstream disconnect must abort the in-flight native request and release its account lease.
  const abortReq = http.request({ hostname: '127.0.0.1', port: switchPort, path: '/v1/chat/completions', method: 'POST', headers: { 'Content-Type': 'application/json' } });
  abortReq.on('error', () => {});
  abortReq.end(JSON.stringify({ model: 'abort-model', messages: [] }));
  for (let i = 0; i < 100 && !seen.some((x) => x.body.model === 'abort-model'); i++) await new Promise((r) => setTimeout(r, 5));
  abortReq.destroy();
  for (let i = 0; i < 100 && !upstreamAborted; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(upstreamAborted, true, 'client disconnect must abort the upstream request');
  let afterAbort;
  for (let i = 0; i < 100; i++) {
    afterAbort = await (await fetch(`http://127.0.0.1:${switchPort}/api/accounts`)).json();
    if (afterAbort.accounts.every((a) => a.activeCount === 0)) break;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.ok(afterAbort.accounts.every((a) => a.activeCount === 0), 'client disconnect must release capacity');

  const withBlank = [accounts[0], { ...accounts[1], key: '' }, { name: 'C', key: 'key-c', enabled: true }, { name: 'D', key: 'key-d', enabled: true }];
  assert.equal((await rawJson(switchPort, '/api/accounts', { accounts: withBlank, mode: 'single', active: 2, concurrencyWaitMs: 20, accountErrorRules: {} })).status, 200);
  const activeAfterFilter = await (await fetch(`http://127.0.0.1:${switchPort}/api/accounts`)).json();
  assert.equal(activeAfterFilter.accounts[activeAfterFilter.active].name, 'C', 'filtering an empty key must not shift the selected account');

  assert.equal((await rawJson(switchPort, '/api/accounts', { accounts: [], mode: 'sticky', active: 0, concurrencyWaitMs: 20, accountErrorRules: [] })).status, 400);
  assert.equal((await rawJson(switchPort, '/api/accounts', { accounts: [{ ...accounts[0], id: 'changed-id' }], mode: 'single', active: 0, concurrencyWaitMs: 20, accountErrorRules: {} })).status, 400);
});


test('malformed persisted config is never overwritten during startup migration', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cps-corrupt-'));
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, '{not-json');
  const child = spawn(process.execPath, ['server.js'], { cwd: path.resolve('.'), env: { ...process.env, DATA_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (c) => { output += c; }); child.stderr.on('data', (c) => { output += c; });
  const code = await new Promise((resolve) => child.once('exit', resolve));
  assert.notEqual(code, 0);
  assert.match(output, /cannot read config\.json/);
  assert.equal(fs.readFileSync(configPath, 'utf8'), '{not-json');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('legacy migration and cooldown state survive restart', async (t) => {
  const seen = [];
  const mock = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : {};
      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ data: [] }));
      }
      seen.push(req.headers.authorization);
      if (body.model === 'cooldown-model' && req.headers.authorization === 'Bearer legacy-a') {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'retry later', status: 429 } }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }));
    });
  });
  const upstreamPort = await listen(mock);
  const socket = http.createServer();
  const switchPort = await listen(socket);
  await close(socket);
  const legacy = {
    port: switchPort,
    upstreamBase: `http://127.0.0.1:${upstreamPort}`,
    accountMode: 'single',
    activeAccount: 0,
    concurrencyWaitMs: 10,
    accounts: [
      { name: 'Legacy A', key: 'legacy-a', enabled: true },
      { name: 'Legacy B', key: 'legacy-b', enabled: true },
    ],
    knownModels: ['cooldown-model', 'test-model'],
    perModel: {},
    accountErrorRules: { '429': { action: 'cooldown', cooldownMs: 60000 } },
  };
  let running = await startSwitcher(legacy);
  t.after(async () => {
    if (running?.child) await stop(running.child);
    await close(mock);
    fs.rmSync(running.dir, { recursive: true, force: true });
  });
  const migrated = JSON.parse(fs.readFileSync(path.join(running.dir, 'config.json')));
  assert.ok(migrated.accounts.every((a) => a.id && a.maxConcurrent === 0 && a.perModel));
  const first = await rawJson(switchPort, '/v1/chat/completions', { model: 'cooldown-model', messages: [] });
  assert.equal(first.status, 200);
  assert.deepEqual(seen, ['Bearer legacy-a', 'Bearer legacy-b']);
  const metadataPath = path.join(running.dir, 'metadata.json');
  const beforeRestart = JSON.parse(fs.readFileSync(metadataPath));
  assert.equal(fs.statSync(metadataPath).mode & 0o777, 0o600, 'new metadata containing the routing secret must be owner-only');
  assert.ok(beforeRestart.routingSecret);
  assert.ok(beforeRestart.accountStates[migrated.accounts[0].id].cooldownUntil > Date.now());

  await stop(running.child);
  running = await startSwitcher(null, running.dir);
  seen.length = 0;
  const afterRestart = await rawJson(switchPort, '/v1/chat/completions', { model: 'test-model', messages: [] });
  assert.equal(afterRestart.status, 200);
  assert.deepEqual(seen, ['Bearer legacy-b']);
  const afterMeta = JSON.parse(fs.readFileSync(path.join(running.dir, 'metadata.json')));
  assert.equal(afterMeta.routingSecret, beforeRestart.routingSecret);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(running.dir, 'config.json'))).accounts.map((a) => a.id), migrated.accounts.map((a) => a.id));
});
