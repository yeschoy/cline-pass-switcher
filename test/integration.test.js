import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
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

function pausedOversizedJson(port, pathname) {
  return new Promise((resolve, reject) => {
    const chunk = Buffer.alloc(1024 * 1024, 0x20);
    let remaining = 50 * 1024 * 1024 + 1;
    let responseStarted = false;
    let stopped = false;
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      stopped = true;
      clearTimeout(timer);
      req.destroy();
      fn(value);
    };
    const req = http.request({
      hostname: '127.0.0.1', port, path: pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, (res) => {
      responseStarted = true;
      stopped = true;
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('error', (error) => finish(reject, error));
      res.on('end', () => finish(resolve, { status: res.statusCode, text: Buffer.concat(chunks).toString() }));
    });
    const timer = setTimeout(() => finish(reject, new Error('oversized request did not receive a prompt response before request end')), 3000);
    req.on('error', (error) => {
      if (!responseStarted) finish(reject, new Error(`oversized request reset before HTTP response: ${error.code || error.message}`));
    });
    const write = () => {
      while (!stopped && remaining > 0) {
        const size = Math.min(remaining, chunk.length);
        remaining -= size;
        if (!req.write(size === chunk.length ? chunk : chunk.subarray(0, size))) {
          req.once('drain', write);
          return;
        }
      }
      // Deliberately do not end the request: the server must reject as soon as the limit is crossed.
    };
    write();
  });
}

async function startSwitcher(config, existingDir = null, extraEnv = {}) {
  const dir = existingDir || fs.mkdtempSync(path.join(os.tmpdir(), 'cps-test-'));
  if (config) fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config));
  const child = spawn(process.execPath, ['server.js'], { cwd: path.resolve('.'), env: { ...process.env, ...extraEnv, DATA_DIR: dir, BIND_HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'] });
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
  const diagnosticTail = 'vercel-diagnostic-tail-after-more-than-two-hundred-characters';
  const longStreamError = JSON.stringify({
    code: 'stream_initialization_failed',
    message: `Failed to create stream: ${'provider routing context '.repeat(10)}failed to invoke model for request "ok": ${diagnosticTail}`,
  });
  let upstreamAborted = false;
  let streamUpstreamAborted = false;
  const mock = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : {};
      seen.push({ headers: req.headers, body });
      const auth = req.headers.authorization;
      const only = body.provider?.only?.[0] || body.providerOptions?.gateway?.only?.[0];
      if ((body.model === 'cooldown-model' && auth === 'Bearer key-a') || (body.model === 'double-cooldown-model' && (auth === 'Bearer key-a' || auth === 'Bearer key-b'))) {
        res.writeHead(429, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'account subscription quota exhausted', code: 'account_quota_exhausted', status: 429 } }));
      }
      if (body.model === 'wrapped-cooldown-model' && auth === 'Bearer key-a') {
        res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ data: { error: { message: 'account plan quota exhausted', code: 'plan_quota_exhausted', status: 429 } } }));
      }
      if (body.model === 'wrapped-sse-error-model' && body.stream && auth === 'Bearer key-a') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        return res.end('data: {"data":{"error":{"message":"account subscription quota exhausted","code":"account_quota_exhausted","status":429}}}\n\n');
      }
      if (body.model === 'post-start-wrapped-sse-error-model' && body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: {"choices":[{"delta":{"content":"started"}}]}\n\n');
        return setTimeout(() => res.end('data: {"data":{"error":{"message":"account subscription quota exhausted","code":"account_quota_exhausted","status":429}}}\n\ndata: [DONE]\n\n'), 5);
      }
      if (body.model === 'long-sse-error-model' && body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        return res.end(`data: ${JSON.stringify({ error: longStreamError })}\n\n`);
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
      if (body.model === 'stream-abort-model' && body.stream) {
        res.on('close', () => { if (!res.writableEnded) streamUpstreamAborted = true; });
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: {"choices":[{"delta":{"content":"started"}}]}\n\n');
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
    ], knownModels: ['test-model', 'planner-model', 'slow-model', 'abort-model', 'stream-abort-model', 'cooldown-model', 'wrapped-cooldown-model', 'wrapped-sse-error-model', 'post-start-wrapped-sse-error-model', 'long-sse-error-model', 'double-cooldown-model', 'ban-model', 'sse-error-model'], perModel: {}, accountErrorRules: {},
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

  const diagnostic = await rawJson(switchPort, '/v1/chat/completions', { model: 'long-sse-error-model', stream: true, messages: [{ role: 'user', content: 'ok' }] });
  assert.equal(diagnostic.status, 502);
  assert.ok(diagnostic.text.includes(diagnosticTail), 'client error must preserve the complete upstream diagnostic');
  assert.ok(diagnostic.text.includes('invoke model'), 'short prompt redaction must not corrupt words containing the same substring');
  assert.ok(diagnostic.text.includes('[REDACTED]'));
  assert.equal(diagnostic.text.includes('request \\"ok\\"'), false, 'an echoed short prompt must still be redacted');
  await new Promise((resolve) => setTimeout(resolve, 20));
  const diagnosticLogs = await (await fetch(`http://127.0.0.1:${switchPort}/api/logs/errors?requestedModel=long-sse-error-model`)).json();
  assert.ok(diagnosticLogs.items[0].reason.includes(diagnosticTail), 'error logs must preserve the complete upstream diagnostic');
  assert.ok(diagnosticLogs.items[0].reason.includes('invoke model'));
  assert.ok(diagnosticLogs.items[0].reason.includes('[REDACTED]'));
  assert.equal(diagnosticLogs.items[0].reason.includes('request \\"ok\\"'), false);

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
  assert.equal(cooled.headers['x-cline-attempts'], '2', 'account action diagnostics must not count as an upstream attempt');
  assert.equal(cooldownHistory.history[0].attempts.length, 2);
  assert.equal(cooldownHistory.history[0].trace.length, 2);
  assert.equal(cooldownHistory.history[0].trace[0].action, 'cooldown');
  assert.equal((await rawJson(switchPort, '/api/accounts/recover', { id: 'a' })).status, 200);

  // HTTP-200 wrapped errors must normalize before account rules and restart on the replacement account.
  seen.length = 0;
  const wrappedCooldown = await rawJson(switchPort, '/v1/chat/completions', { model: 'wrapped-cooldown-model', messages: [] });
  assert.equal(wrappedCooldown.status, 200);
  assert.deepEqual(seen.map((x) => x.headers.authorization), ['Bearer key-a', 'Bearer key-b']);
  assert.equal(wrappedCooldown.headers['x-cline-attempts'], '2');
  assert.ok(JSON.parse(fs.readFileSync(path.join(dir, 'metadata.json'))).accountStates.a.cooldownUntil > Date.now());
  assert.equal((await rawJson(switchPort, '/api/accounts/recover', { id: 'a' })).status, 200);

  // The same wrapped envelope in the first SSE event must fail over before exposing a stream.
  seen.length = 0;
  const wrappedStream = await rawJson(switchPort, '/v1/chat/completions', { model: 'wrapped-sse-error-model', stream: true, messages: [] });
  assert.equal(wrappedStream.status, 200);
  assert.match(wrappedStream.text, /data:.*OK/);
  assert.deepEqual(seen.map((x) => x.headers.authorization), ['Bearer key-a', 'Bearer key-b']);
  assert.equal(wrappedStream.headers['x-cline-attempts'], '2');
  assert.ok(JSON.parse(fs.readFileSync(path.join(dir, 'metadata.json'))).accountStates.a.cooldownUntil > Date.now());
  assert.equal((await rawJson(switchPort, '/api/accounts/recover', { id: 'a' })).status, 200);

  // A wrapped error after streaming starts updates the one real provider attempt and records its account action separately.
  seen.length = 0;
  const postStartWrapped = await rawJson(switchPort, '/v1/chat/completions', { model: 'post-start-wrapped-sse-error-model', stream: true, messages: [] });
  assert.equal(postStartWrapped.status, 200);
  assert.match(postStartWrapped.text, /started/);
  assert.match(postStartWrapped.text, /account subscription quota exhausted/);
  assert.equal(postStartWrapped.headers['x-cline-attempts'], '1');
  assert.equal(seen.length, 1, 'an error after SSE starts must not replay the upstream request');
  const postStartHistory = await (await fetch(`http://127.0.0.1:${switchPort}/api/history`)).json();
  assert.equal(postStartHistory.history[0].attempts.length, 1);
  assert.equal(postStartHistory.history[0].trace.length, 1);
  assert.equal(postStartHistory.history[0].trace[0].action, 'cooldown');
  assert.equal(postStartHistory.history[0].trace[0].normalizedStatus, 429);
  assert.deepEqual(postStartHistory.history[0].accountActions, [{ account: 'A', action: 'cooldown', statusCode: 429 }]);
  assert.ok(JSON.parse(fs.readFileSync(path.join(dir, 'metadata.json'))).accountStates.a.cooldownUntil > Date.now());
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

  // If no replacement account exists, the failed provider trace must remain present exactly once.
  assert.equal((await rawJson(switchPort, '/api/accounts', { accounts: [accounts[0], { ...accounts[1], enabled: false }], mode: 'single', active: 0, concurrencyWaitMs: 20, accountErrorRules: { '429': { action: 'cooldown', cooldownMs: 60000 } } })).status, 200);
  seen.length = 0;
  const noReplacement = await rawJson(switchPort, '/v1/chat/completions', { model: 'cooldown-model', messages: [] });
  assert.equal(noReplacement.status, 429);
  assert.equal(noReplacement.headers['x-cline-attempts'], '1');
  assert.equal(seen.length, 1);
  const noReplacementHistory = await (await fetch(`http://127.0.0.1:${switchPort}/api/history`)).json();
  assert.equal(noReplacementHistory.history[0].attempts.length, 1);
  assert.equal(noReplacementHistory.history[0].trace.length, 1);
  assert.equal(noReplacementHistory.history[0].trace[0].action, 'cooldown');
  await rawJson(switchPort, '/api/accounts/recover', { id: 'a' });

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
  const capacityLog = await waitUntil(async () => { const page = await (await fetch(`http://127.0.0.1:${switchPort}/api/logs/requests?requestId=${full.headers['x-cline-request-id']}`)).json(); return page.items[0] ? page : null; });
  assert.equal(capacityLog.items[0].errorCategory, 'capacity');assert.equal(capacityLog.items[0].upstreamStatus, null);assert.deepEqual(capacityLog.items[0].attempts, []);
  const after = await (await fetch(`http://127.0.0.1:${switchPort}/api/accounts`)).json();
  assert.ok(after.accounts.every((a) => a.activeCount === 0));

  // A downstream disconnect must abort the in-flight native request, stop supplier failover, release its lease, and never affect health.
  const healthBeforeDisconnect = (await (await fetch(`http://127.0.0.1:${switchPort}/api/statistics`)).json()).accounts.reduce((sum, account) => sum + account.health.results, 0);
  assert.equal((await rawJson(switchPort, '/api/config', { scope: 'global', perModel: { 'abort-model': { upstreams: ['first', 'second'], pinMode: 'strict' } } })).status, 200);
  const abortReq = http.request({ hostname: '127.0.0.1', port: switchPort, path: '/v1/chat/completions', method: 'POST', headers: { 'Content-Type': 'application/json' } });
  abortReq.on('error', () => {});
  abortReq.end(JSON.stringify({ model: 'abort-model', messages: [] }));
  for (let i = 0; i < 100 && !seen.some((x) => x.body.model === 'abort-model'); i++) await new Promise((r) => setTimeout(r, 5));
  abortReq.destroy();
  for (let i = 0; i < 100 && !upstreamAborted; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(upstreamAborted, true, 'client disconnect must abort the upstream request');
  assert.equal(seen.filter((x) => x.body.model === 'abort-model').length, 1, 'client disconnect must not start another supplier attempt');
  let afterAbort;
  for (let i = 0; i < 100; i++) {
    afterAbort = await (await fetch(`http://127.0.0.1:${switchPort}/api/accounts`)).json();
    if (afterAbort.accounts.every((a) => a.activeCount === 0)) break;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.ok(afterAbort.accounts.every((a) => a.activeCount === 0), 'client disconnect must release capacity');

  // Once SSE has started, disconnect aborts that stream and releases capacity without replay.
  await new Promise((resolve, reject) => {
    const streamReq = http.request({ hostname: '127.0.0.1', port: switchPort, path: '/v1/chat/completions', method: 'POST', headers: { 'Content-Type': 'application/json' } }, (streamRes) => {
      streamRes.once('data', () => { streamReq.destroy(); resolve(); });
    });
    streamReq.on('error', (e) => { if (e.code !== 'ECONNRESET') reject(e); });
    streamReq.end(JSON.stringify({ model: 'stream-abort-model', stream: true, messages: [] }));
  });
  for (let i = 0; i < 100 && !streamUpstreamAborted; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(streamUpstreamAborted, true, 'post-start stream disconnect must abort the upstream stream');
  for (let i = 0; i < 100; i++) {
    afterAbort = await (await fetch(`http://127.0.0.1:${switchPort}/api/accounts`)).json();
    if (afterAbort.accounts.every((a) => a.activeCount === 0)) break;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.ok(afterAbort.accounts.every((a) => a.activeCount === 0), 'post-start stream disconnect must release capacity');
  assert.equal(seen.filter((x) => x.body.model === 'stream-abort-model').length, 1, 'started SSE must not be replayed');
  const healthAfterDisconnect = (await (await fetch(`http://127.0.0.1:${switchPort}/api/statistics`)).json()).accounts.reduce((sum, account) => sum + account.health.results, 0);
  assert.equal(healthAfterDisconnect, healthBeforeDisconnect, 'pre/post-stream client disconnects must not improve or penalize health');

  const oversized = await pausedOversizedJson(switchPort, '/v1/chat/completions');
  assert.equal(oversized.status, 413, `paused oversized clients must receive HTTP 413 instead of ECONNRESET: ${oversized.text}`);
  assert.match(oversized.text, /body too large/);

  const withBlank = [accounts[0], { ...accounts[1], key: '' }, { name: 'C', key: 'key-c', enabled: true }, { name: 'D', key: 'key-d', enabled: true }];
  assert.equal((await rawJson(switchPort, '/api/accounts', { accounts: withBlank, mode: 'single', active: 2, concurrencyWaitMs: 20, accountErrorRules: {} })).status, 200);
  const activeAfterFilter = await (await fetch(`http://127.0.0.1:${switchPort}/api/accounts`)).json();
  assert.equal(activeAfterFilter.accounts[activeAfterFilter.active].name, 'C', 'filtering an empty key must not shift the selected account');

  // Replacing an account row with a new id-less account must allocate a fresh id instead of reusing the old row's id.
  const kept = activeAfterFilter.accounts[1];
  const replaceWithNew = await rawJson(switchPort, '/api/accounts', {
    accounts: [kept, { name: 'E', key: 'key-e', enabled: true, maxConcurrent: 0, perModel: {} }],
    mode: 'single', active: 1, concurrencyWaitMs: 20, accountErrorRules: {},
  });
  assert.equal(replaceWithNew.status, 200);
  const afterReplacement = await (await fetch(`http://127.0.0.1:${switchPort}/api/accounts`)).json();
  assert.equal(new Set(afterReplacement.accounts.map((a) => a.id)).size, 2);
  assert.equal(afterReplacement.accounts[afterReplacement.active].name, 'E');

  assert.equal((await rawJson(switchPort, '/api/accounts', { accounts: [], mode: 'sticky', active: 0, concurrencyWaitMs: 20, accountErrorRules: [] })).status, 400);
  assert.equal((await rawJson(switchPort, '/api/accounts', { accounts: [{ ...accounts[0], id: 'changed-id' }], mode: 'single', active: 0, concurrencyWaitMs: 20, accountErrorRules: {} })).status, 400);
});

test('HRW routing is order-independent and only remaps sessions owned by a removed account', async () => {
  const mock = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }));
    });
  });
  const upstreamPort = await listen(mock);
  const portSocket = http.createServer();
  const switchPort = await listen(portSocket);
  await close(portSocket);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cps-hrw-'));
  const routingSecret = 'fixed-routing-secret-for-order-test';
  fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify({ routingSecret, accountStates: {}, models: {}, history: [], stats: {} }));
  const account = (id) => ({ id, name: id.toUpperCase(), key: `key-${id}`, enabled: true, maxConcurrent: 0, perModel: {} });
  const makeConfig = (ids) => ({
    port: switchPort,
    upstreamBase: `http://127.0.0.1:${upstreamPort}`,
    accountMode: 'sticky',
    concurrencyWaitMs: 0,
    accounts: ids.map(account),
    knownModels: ['test-model'],
    perModel: {},
    accountErrorRules: {},
  });
  const sessions = Array.from({ length: 48 }, (_, i) => `hrw-session-${i}`);
  const collectAssignments = async () => {
    const result = new Map();
    for (const session of sessions) {
      const response = await rawJson(switchPort, '/v1/chat/completions', { model: 'test-model', messages: [] }, { 'Session-Id': session });
      assert.equal(response.status, 200);
      result.set(session, response.headers['x-cline-account']);
    }
    return result;
  };
  let running = null;
  try {
    running = await startSwitcher(makeConfig(['a', 'b', 'c']), dir);
    const original = await collectAssignments();
    await stop(running.child); running = null;

    running = await startSwitcher(makeConfig(['c', 'a', 'b']), dir);
    const reordered = await collectAssignments();
    assert.deepEqual([...reordered], [...original], 'HRW choices must not depend on account input order');
    await stop(running.child); running = null;

    const counts = new Map();
    for (const selected of original.values()) counts.set(selected, (counts.get(selected) || 0) + 1);
    const removedName = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const removedId = removedName.toLowerCase();
    running = await startSwitcher(makeConfig(['a', 'b', 'c'].filter((id) => id !== removedId)), dir);
    const afterRemoval = await collectAssignments();
    for (const session of sessions) {
      if (original.get(session) === removedName) assert.notEqual(afterRemoval.get(session), removedName);
      else assert.equal(afterRemoval.get(session), original.get(session), `unaffected session ${session} must keep its account`);
    }
  } finally {
    if (running?.child) await stop(running.child);
    await close(mock);
    fs.rmSync(dir, { recursive: true, force: true });
  }
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
        return res.end(JSON.stringify({ error: { message: 'account subscription quota exhausted', code: 'account_quota_exhausted', status: 429 } }));
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
  const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cps-legacy-stats-'));
  fs.writeFileSync(path.join(legacyDir, 'metadata.json'), JSON.stringify({ models: {}, history: [], accountStates: {}, routingSecret: 'legacy-routing-secret', stats: { 'Legacy A': { requests: 7, lastError: 'must-not-migrate' }, Ghost: { requests: 3 } } }), { mode: 0o600 });
  let running = await startSwitcher(legacy, legacyDir);
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
  assert.equal(beforeRestart.statistics.migration.legacyRequests, 10);
  assert.equal(beforeRestart.statistics.migration.accountLegacyRequests[migrated.accounts[0].id], 7);
  assert.equal(beforeRestart.statistics.migration.unmappedNames, 1);
  assert.equal(beforeRestart.statistics.lifetime.global.requests, 1, 'legacy baseline must not be mixed into exact chat totals');
  assert.equal(JSON.stringify(beforeRestart).includes('must-not-migrate'), false);
  assert.equal(Object.hasOwn(beforeRestart, 'stats'), false);

  await stop(running.child);
  running = await startSwitcher(null, running.dir);
  seen.length = 0;
  const afterRestart = await rawJson(switchPort, '/v1/chat/completions', { model: 'test-model', messages: [] });
  assert.equal(afterRestart.status, 200);
  assert.deepEqual(seen, ['Bearer legacy-b']);
  const afterMeta = JSON.parse(fs.readFileSync(path.join(running.dir, 'metadata.json')));
  assert.equal(afterMeta.routingSecret, beforeRestart.routingSecret);
  assert.deepEqual(afterMeta.statistics.migration, beforeRestart.statistics.migration, 'legacy stats migration must be idempotent across restart');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(running.dir, 'config.json'))).accounts.map((a) => a.id), migrated.accounts.map((a) => a.id));
});

test('new scheduling modes, account fields, model aliases and independent logs', async (t) => {
  const seen = [];
  let coolFailures = 1;
  const mock = http.createServer((req, res) => {
    const chunks=[]; req.on('data',(c)=>chunks.push(c)); req.on('end',()=>{
      const body=JSON.parse(Buffer.concat(chunks).toString()||'{}'); seen.push({ auth:req.headers.authorization, headers:req.headers, body });
      if (body.model === 'cool' && req.headers.authorization === 'Bearer ka' && coolFailures-- > 0) { res.writeHead(429, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'account subscription quota exhausted', code: 'account_quota_exhausted' } })); }
      if (body.model === 'leak') { res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: { message: `failed ${req.headers['x-safe-account']} ${body.messages?.[0]?.content}` } })); }
      const reply=()=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:'OK'}}],provider:'Mock'}));};
      if(body.model==='slow')setTimeout(reply,100);else reply();
    });
  });
  const upstreamPort=await listen(mock); const socket=http.createServer(); const switchPort=await listen(socket); await close(socket);
  const cfg={port:switchPort,upstreamBase:`http://127.0.0.1:${upstreamPort}`,accountMode:'weighted-roundrobin',concurrencyWaitMs:20,
    accounts:[{id:'a',name:'A',note:'primary\naccount',key:'ka',enabled:true,maxConcurrent:1,weight:1,priority:1,headers:{'X-Safe-Account':'header-secret-value'},perModel:{}},{id:'b',name:'B',key:'kb',enabled:true,maxConcurrent:1,weight:3,priority:10,perModel:{}}],knownModels:['cline-pass/target','slow','cool','leak'],modelAliases:{},perModel:{},accountErrorRules:{}};
  const running=await startSwitcher(cfg); t.after(async()=>{await stop(running.child);await close(mock);fs.rmSync(running.dir,{recursive:true,force:true});});
  for(let i=0;i<8;i++)assert.equal((await rawJson(switchPort,'/v1/chat/completions',{model:'cline-pass/target',messages:[]})).status,200);
  assert.deepEqual(seen.slice(0,8).reduce((m,x)=>(m[x.auth]=(m[x.auth]||0)+1,m),{}),{'Bearer ka':2,'Bearer kb':6});
  const accounts=(await (await fetch(`http://127.0.0.1:${switchPort}/api/accounts`)).json()).accounts;
  assert.equal(accounts[0].note,'primary\naccount'); assert.equal(seen[0].headers['x-safe-account'],'header-secret-value');
  assert.equal((await rawJson(switchPort,'/api/accounts',{accounts,mode:'priority-failover',active:0,concurrencyWaitMs:20,accountErrorRules:{429:{action:'cooldown',cooldownMs:60000}}})).status,200);
  seen.length=0;
  const highPriorityBusy=rawJson(switchPort,'/v1/chat/completions',{model:'slow',messages:[]});await new Promise(r=>setTimeout(r,10));
  const fallbackWhileBusy=rawJson(switchPort,'/v1/chat/completions',{model:'slow',messages:[]});await Promise.all([highPriorityBusy,fallbackWhileBusy]);
  assert.deepEqual(new Set(seen.map(x=>x.auth)),new Set(['Bearer ka','Bearer kb']),'priority mode must immediately fall back while the high-priority account is full');
  seen.length=0;await rawJson(switchPort,'/v1/chat/completions',{model:'cline-pass/target',messages:[]});assert.equal(seen[0].auth,'Bearer ka','released high-priority account must re-enter the pool');
  seen.length=0;assert.equal((await rawJson(switchPort,'/v1/chat/completions',{model:'cool',messages:[]})).status,200);assert.deepEqual(seen.map(x=>x.auth),['Bearer ka','Bearer kb'],'cooldown action must replace the account once');
  assert.equal((await rawJson(switchPort,'/api/accounts/recover',{id:'a'})).status,200);seen.length=0;await rawJson(switchPort,'/v1/chat/completions',{model:'cline-pass/target',messages:[]});assert.equal(seen[0].auth,'Bearer ka','recovered account must re-enter its priority tier');
  assert.equal((await rawJson(switchPort,'/api/accounts',{accounts,mode:'least-connections',active:0,concurrencyWaitMs:20,accountErrorRules:{}})).status,200);
  seen.length=0; const first=rawJson(switchPort,'/v1/chat/completions',{model:'slow',messages:[]}); await new Promise(r=>setTimeout(r,10)); const second=rawJson(switchPort,'/v1/chat/completions',{model:'slow',messages:[]}); await Promise.all([first,second]);
  assert.equal(new Set(seen.map(x=>x.auth)).size,2,'least-connections must use the idle account');
  assert.equal((await rawJson(switchPort,'/api/model-aliases',{aliases:{friendly:'cline-pass/target'}})).status,200);
  assert.equal((await rawJson(switchPort,'/api/model-aliases',{aliases:{bad:'cline-pass/missing'}})).status,400);
  seen.length=0; const aliased=await rawJson(switchPort,'/v1/chat/completions',{model:'friendly',messages:[]}); assert.equal(aliased.status,200);assert.equal(seen[0].body.model,'cline-pass/target');assert.ok(aliased.headers['x-cline-request-id']);
  const models=await (await fetch(`http://127.0.0.1:${switchPort}/v1/models`)).json();assert.ok(models.data.some(x=>x.id==='friendly')&&models.data.some(x=>x.id==='cline-pass/target'));
  await new Promise(r=>setTimeout(r,30)); const logs=await (await fetch(`http://127.0.0.1:${switchPort}/api/logs/requests?requestedModel=friendly`)).json();
  assert.equal(logs.items[0].resolvedModel,'cline-pass/target');assert.equal(logs.items[0].requestId,aliased.headers['x-cline-request-id']);assert.equal(JSON.stringify(logs).includes('primary account'),false);assert.equal(JSON.stringify(logs).includes('ka'),false);
  assert.equal((await rawJson(switchPort,'/api/accounts',{accounts,mode:'single',active:0,concurrencyWaitMs:20,accountErrorRules:{}})).status,200);
  const leaked=await rawJson(switchPort,'/v1/chat/completions',{model:'leak',messages:[{role:'user',content:'message-secret-value'}]});assert.equal(leaked.status,500);assert.equal(leaked.text.includes('message-secret-value'),false);assert.equal(leaked.text.includes('header-secret-value'),false);
  await new Promise(r=>setTimeout(r,20));const redactedErrors=await(await fetch(`http://127.0.0.1:${switchPort}/api/logs/errors?requestedModel=leak`)).json();assert.equal(JSON.stringify(redactedErrors).includes('message-secret-value'),false);assert.equal(JSON.stringify(redactedErrors).includes('header-secret-value'),false);
  const bytes=fs.readFileSync(path.join(running.dir,'config.json'));
  const invalidHeader=await rawJson(switchPort,'/api/accounts',{accounts:[{...accounts[0],headers:{Authorization:'bad'}},accounts[1]],mode:'single',active:0,concurrencyWaitMs:20,accountErrorRules:{}});assert.equal(invalidHeader.status,400);assert.deepEqual(fs.readFileSync(path.join(running.dir,'config.json')),bytes);
  const invalidProxy=await rawJson(switchPort,'/api/accounts',{accounts:[{...accounts[0],proxyUrl:'ftp://user:pass@example.test'},accounts[1]],mode:'single',active:0,concurrencyWaitMs:20,accountErrorRules:{}});assert.equal(invalidProxy.status,400);
  assert.equal((await fetch(`http://127.0.0.1:${switchPort}/api/logs/requests?limit=999`)).status,400);
  assert.equal((await fetch(`http://127.0.0.1:${switchPort}/api/logs/requests?unknown=value`)).status,400);
  assert.equal((await fetch(`http://127.0.0.1:${switchPort}/api/logs/requests`,{method:'DELETE'})).status,200);assert.equal((await (await fetch(`http://127.0.0.1:${switchPort}/api/logs/requests`)).json()).items.length,0);
});

test('account HTTP proxy is used for chat and quota, and proxy failure never falls back to direct', async (t) => {
  let chatHits=0,quotaHits=0,connects=0;
  const upstream=http.createServer((req,res)=>{req.resume();req.on('end',()=>{res.writeHead(200,{'Content-Type':'application/json'});if(req.method==='GET'){quotaHits++;assert.equal(req.headers.authorization,'Bearer ka');assert.equal(req.headers['x-chat-only'],undefined);return res.end(JSON.stringify({success:true,data:{limits:[{type:'five_hour',percentUsed:1},{type:'weekly',percentUsed:2},{type:'monthly',percentUsed:3}]}}));}chatHits++;res.end(JSON.stringify({choices:[{message:{content:'OK'}}]}));});});
  const upstreamPort=await listen(upstream);
  const proxy=http.createServer();
  proxy.on('connect',(req,client,head)=>{connects++;const [host,port]=req.url.split(':');const target=net.connect(Number(port),host,()=>{client.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)target.write(head);target.pipe(client);client.pipe(target);});target.on('error',()=>client.destroy());});
  const proxyPort=await listen(proxy);const socket=http.createServer();const switchPort=await listen(socket);await close(socket);
  const config={port:switchPort,upstreamBase:`http://127.0.0.1:${upstreamPort}`,accountMode:'single',concurrencyWaitMs:0,accountPipeline:{quotaPool:true,excludeUnhealthy:false,healthSort:false,sticky:false},accounts:[{id:'a',name:'A',key:'ka',enabled:true,proxyUrl:`http://127.0.0.1:${proxyPort}`,headers:{'X-Chat-Only':'chat-value'},perModel:{}}],knownModels:['cline-pass/test'],perModel:{},accountErrorRules:{}};
  const running=await startSwitcher(config,null,{NODE_ENV:'test',CLINE_PASS_TEST_QUOTA_SUCCESS_MS:'500'});t.after(async()=>{await stop(running.child);await close(proxy);await close(upstream);fs.rmSync(running.dir,{recursive:true,force:true});});
  await waitUntil(async()=>quotaHits>0);const ok=await rawJson(switchPort,'/v1/chat/completions',{model:'cline-pass/test',messages:[]});assert.equal(ok.status,200);assert.ok(connects>=2);assert.equal(chatHits,1);assert.equal(quotaHits,1);
  const accounts=(await (await fetch(`http://127.0.0.1:${switchPort}/api/accounts`)).json()).accounts;
  const spare=http.createServer();const deadPort=await listen(spare);await close(spare);
  accounts[0].proxyUrl=`http://user:password@127.0.0.1:${deadPort}`;
  assert.equal((await rawJson(switchPort,'/api/accounts',{accounts,mode:'single',active:0,concurrencyWaitMs:0,accountErrorRules:{}})).status,200);
  const failed=await rawJson(switchPort,'/v1/chat/completions',{model:'cline-pass/test',messages:[]});assert.equal(failed.status,502);assert.equal(chatHits,1,'a failed configured proxy must not retry direct');
  await new Promise(r=>setTimeout(r,20));
  const logs=await (await fetch(`http://127.0.0.1:${switchPort}/api/logs/errors?category=proxy`)).json();assert.ok(logs.items.some(x=>x.category==='proxy'));assert.equal(JSON.stringify(logs).includes('password'),false);
  const health=(await(await fetch(`http://127.0.0.1:${switchPort}/api/statistics`)).json()).accounts[0].health;assert.equal(health.results,2);assert.equal(health.penaltyUnits,6,'proxy/network terminal failure has weight 0.6 while prior success has zero');
});

test('account HTTPS proxy uses a TLS CONNECT tunnel', async (t) => {
  let upstreamHits = 0, connects = 0;
  const tunnels = new Set();
  const certPath = path.resolve('test/fixtures/proxy-cert.pem');
  const tlsOptions = { key: fs.readFileSync(path.resolve('test/fixtures/proxy-key.pem')), cert: fs.readFileSync(certPath) };
  const upstream = https.createServer(tlsOptions, (req, res) => { upstreamHits++; req.resume(); req.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: 'OK' } }] })); }); });
  const upstreamPort = await listen(upstream);
  const proxy = https.createServer(tlsOptions);
  proxy.on('connect', (req, client, head) => { connects++; const target = net.connect(upstreamPort, '127.0.0.1', () => { tunnels.add(client); tunnels.add(target); client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) target.write(head); target.pipe(client); client.pipe(target); }); target.on('error', () => client.destroy()); });
  const proxyPort = await listen(proxy); const socket = http.createServer(); const switchPort = await listen(socket); await close(socket);
  const config = { port: switchPort, upstreamBase: `https://127.0.0.1:${upstreamPort}`, accountMode: 'single', concurrencyWaitMs: 0, accounts: [{ id: 'a', name: 'A', key: 'ka', enabled: true, proxyUrl: `https://127.0.0.1:${proxyPort}`, perModel: {} }], knownModels: ['cline-pass/test'], perModel: {}, accountErrorRules: {} };
  const running = await startSwitcher(config, null, { NODE_EXTRA_CA_CERTS: certPath });
  t.after(async () => { await stop(running.child); for (const socket of tunnels) socket.destroy(); proxy.closeAllConnections?.(); upstream.closeAllConnections?.(); await close(proxy); await close(upstream); fs.rmSync(running.dir, { recursive: true, force: true }); });
  const result = await rawJson(switchPort, '/v1/chat/completions', { model: 'cline-pass/test', messages: [] });
  assert.equal(result.status, 200, result.text); assert.equal(connects, 1); assert.equal(upstreamHits, 1);
});

test('SOCKS5 and SOCKS5H account proxies tunnel requests', async (t) => {
  let hits=0, socksConnections=0;
  const upstream=http.createServer((req,res)=>{hits++;req.resume();req.on('end',()=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:'OK'}}]}));});});
  const upstreamPort=await listen(upstream);
  const socks=net.createServer((client)=>{socksConnections++;let buffer=Buffer.alloc(0),stage=0;client.on('data',function onData(chunk){buffer=Buffer.concat([buffer,chunk]);if(stage===0){if(buffer.length<2)return;const n=buffer[1];if(buffer.length<2+n)return;buffer=buffer.subarray(2+n);client.write(Buffer.from([5,0]));stage=1;}if(stage===1){if(buffer.length<5)return;const atyp=buffer[3];let off=4,host;if(atyp===1){if(buffer.length<10)return;host=[...buffer.subarray(off,off+4)].join('.');off+=4;}else if(atyp===3){const n=buffer[off++];if(buffer.length<off+n+2)return;host=buffer.subarray(off,off+n).toString();off+=n;}else return client.destroy();const port=buffer.readUInt16BE(off);off+=2;const rest=buffer.subarray(off);buffer=Buffer.alloc(0);stage=2;const target=net.connect(port,host,()=>{client.write(Buffer.from([5,0,0,1,0,0,0,0,0,0]));if(rest.length)target.write(rest);client.removeListener('data',onData);client.pipe(target);target.pipe(client);});target.on('error',()=>client.destroy());}});});
  const socksPort=await listen(socks);const socket=http.createServer();const switchPort=await listen(socket);await close(socket);
  const base={id:'a',name:'A',key:'ka',enabled:true,perModel:{}};
  const running=await startSwitcher({port:switchPort,upstreamBase:`http://127.0.0.1:${upstreamPort}`,accountMode:'single',concurrencyWaitMs:0,accounts:[{...base,proxyUrl:`socks5://127.0.0.1:${socksPort}`}],knownModels:['cline-pass/test'],perModel:{},accountErrorRules:{}});t.after(async()=>{await stop(running.child);await close(socks);await close(upstream);fs.rmSync(running.dir,{recursive:true,force:true});});
  for(const protocol of ['socks5','socks5h']){const accounts=(await (await fetch(`http://127.0.0.1:${switchPort}/api/accounts`)).json()).accounts;accounts[0].proxyUrl=`${protocol}://127.0.0.1:${socksPort}`;assert.equal((await rawJson(switchPort,'/api/accounts',{accounts,mode:'single',active:0,concurrencyWaitMs:0,accountErrorRules:{}})).status,200);assert.equal((await rawJson(switchPort,'/v1/chat/completions',{model:'cline-pass/test',messages:[]})).status,200);}
  assert.equal(hits,2);assert.equal(socksConnections,2);
});

test('usage statistics, health, pipeline validation and quota refresh are bounded and truthful', async (t) => {
  let quotaHits = 0;
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      if (req.method === 'GET' && req.url.endsWith('/users/me/plan/usage-limits')) {
        quotaHits++;
        assert.equal(req.headers.authorization, 'Bearer stats-key');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: true, data: { limits: [
          { type: 'five_hour', percentUsed: 20 }, { type: 'weekly', percentUsed: 30 }, { type: 'monthly', percentUsed: 40 }, { type: 'future', percentUsed: 99 },
        ] } }));
      }
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      if (body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: {"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4,"prompt_tokens_details":{"cached_tokens":0}}}\n\n');
        return setTimeout(() => {
          res.write(`data: {"ignored":"${'x'.repeat(70 * 1024)}`);
          setTimeout(() => { res.write('"}\r\n\r'); setTimeout(() => res.end('\ndata: {"usage":{"prompt_tokens":8,"completion_tokens":2,"total_tokens":10,"prompt_tokens_details":{"cached_tokens":4}}}\r\n\r\ndata: [DONE]\r\n\r\n'), 2); }, 2);
        }, 5);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (body.model === 'no-usage') return res.end(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }));
      res.end(JSON.stringify({ choices: [{ message: { content: 'OK' } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, prompt_tokens_details: { cached_tokens: 2 } } }));
    });
  });
  const upstreamPort = await listen(upstream); const holder = http.createServer(); const switchPort = await listen(holder); await close(holder);
  const running = await startSwitcher({ port: switchPort, upstreamBase: `http://127.0.0.1:${upstreamPort}/api/v1`, accountMode: 'single', concurrencyWaitMs: 0, accountPipeline: { quotaPool: true, excludeUnhealthy: false, healthSort: false, sticky: false }, accounts: [{ id: 'stats', name: 'Stats', key: 'stats-key', enabled: true, perModel: {} }], knownModels: ['stats-model', 'no-usage'], perModel: {}, accountErrorRules: {} }, null, { NODE_ENV: 'test', CLINE_PASS_TEST_QUOTA_SUCCESS_MS: '50', CLINE_PASS_TEST_QUOTA_STALE_MS: '500' });
  t.after(async () => { await stop(running.child); await close(upstream); fs.rmSync(running.dir, { recursive: true, force: true }); });
  for (let i = 0; i < 5; i++) assert.equal((await rawJson(switchPort, '/v1/chat/completions', { model: 'stats-model', messages: [] })).status, 200);
  const stream = await rawJson(switchPort, '/v1/chat/completions', { model: 'stats-model', stream: true, messages: [] }); assert.equal(stream.status, 200);
  assert.equal((await rawJson(switchPort, '/v1/chat/completions', { model: 'no-usage', messages: [] })).status, 200);
  await rawJson(switchPort, '/api/test', { model: 'stats-model' });
  await new Promise((resolve) => setTimeout(resolve, 80));
  const stats = await (await fetch(`http://127.0.0.1:${switchPort}/api/statistics`)).json();
  assert.equal(stats.lifetime.global.requests, 7, 'management test traffic is excluded while missing usage still counts as a chat');
  assert.equal(stats.lifetime.global.inputTokens, 58, 'streaming skips one oversized CRLF event and keeps only the final cumulative usage snapshot');
  assert.equal(stats.lifetime.global.inputKnownRequests, 6, 'missing usage is not reported as a known zero');
  assert.equal(stats.lifetime.global.usageRequests, 6);
  assert.equal(stats.lifetime.global.cachedTokens, 14);
  assert.equal(stats.lifetime.global.cacheInputTokens, 58);
  assert.equal(stats.lifetime.global.cacheInputCachedTokens, 14);
  assert.equal(stats.lifetime.global.cacheKnownRequests, 6);
  assert.equal(stats.accounts[0].health.status, 'available');
  assert.equal(stats.accounts[0].health.results, 7);
  assert.equal(stats.accounts[0].quota.pool, 'hot'); assert.ok(quotaHits >= 1);
  const accountView = await (await fetch(`http://127.0.0.1:${switchPort}/api/accounts`)).json();
  const before = fs.readFileSync(path.join(running.dir, 'config.json'));
  const invalid = await rawJson(switchPort, '/api/accounts', { accounts: accountView.accounts, mode: 'single', active: 0, concurrencyWaitMs: 0, accountErrorRules: {}, accountPipeline: { quotaPool: true, excludeUnhealthy: false, healthSort: false, sticky: 'yes' } });
  assert.equal(invalid.status, 400); assert.deepEqual(fs.readFileSync(path.join(running.dir, 'config.json')), before);
  const legacyClient = await rawJson(switchPort, '/api/accounts', { accounts: accountView.accounts, mode: 'single', active: 0, concurrencyWaitMs: 0, accountErrorRules: {} });
  assert.equal(legacyClient.status, 200);
  const preserved = await (await fetch(`http://127.0.0.1:${switchPort}/api/accounts`)).json(); assert.equal(preserved.accountPipeline.quotaPool, true);
  const persisted = JSON.stringify(JSON.parse(fs.readFileSync(path.join(running.dir, 'metadata.json'))));
  assert.equal(persisted.includes('stats-key'), false); assert.equal(persisted.includes('Authorization'), false);
});

test('corrupt versioned statistics fail startup without overwriting metadata', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cps-corrupt-statistics-'));
  const portHolder = http.createServer(); const port = await listen(portHolder); await close(portHolder);
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ port, accounts: [{ id: 'a', name: 'A', key: 'key', enabled: true, perModel: {} }], accountMode: 'single', activeAccount: 0, concurrencyWaitMs: 0, accountErrorRules: {}, perModel: {}, knownModels: ['test'] }));
  const metadataPath = path.join(dir, 'metadata.json');
  const bytes = Buffer.from(JSON.stringify({ models: {}, history: [], routingSecret: 'secret', accountStates: {}, statistics: { version: 1, leakedRawResponse: 'must-not-survive-normalization' } }));
  fs.writeFileSync(metadataPath, bytes);
  const child = spawn(process.execPath, ['server.js'], { cwd: path.resolve('.'), env: { ...process.env, DATA_DIR: dir, BIND_HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stderr.on('data', (chunk) => { output += chunk; }); child.stdout.on('data', (chunk) => { output += chunk; });
  const code = await new Promise((resolve) => child.once('exit', resolve));
  assert.notEqual(code, 0); assert.match(output, /invalid statistics structure/); assert.deepEqual(fs.readFileSync(metadataPath), bytes);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('overflow markers must exactly match null counters and corrupt metadata bytes remain unchanged', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cps-corrupt-overflow-'));
  const holder = http.createServer(); const port = await listen(holder); await close(holder);
  const config = { port, accounts: [{ id: 'a', name: 'A', key: 'key', enabled: true, perModel: {} }], accountMode: 'single', activeAccount: 0, concurrencyWaitMs: 0, accountErrorRules: {}, perModel: {}, knownModels: ['test'] };
  const running = await startSwitcher(config, dir); await stop(running.child);
  const metadataPath = path.join(dir, 'metadata.json'); const metadata = JSON.parse(fs.readFileSync(metadataPath));
  metadata.statistics.lifetime.global.requests = 1; metadata.statistics.lifetime.global.overflowFields = ['requests'];
  const bytes = Buffer.from(JSON.stringify(metadata)); fs.writeFileSync(metadataPath, bytes);
  const child = spawn(process.execPath, ['server.js'], { cwd: path.resolve('.'), env: { ...process.env, DATA_DIR: dir, BIND_HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stderr.on('data', (chunk) => { output += chunk; }); child.stdout.on('data', (chunk) => { output += chunk; });
  const code = await new Promise((resolve) => child.once('exit', resolve));
  assert.notEqual(code, 0); assert.match(output, /invalid statistics lifetime\.global\.requests/); assert.deepEqual(fs.readFileSync(metadataPath), bytes);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('health filtering removes only scored unhealthy accounts and emits safe pipeline diagnostics', async (t) => {
  const seen = [];let goodTraining=0;
  const upstream = http.createServer((req, res) => { const chunks=[];req.on('data',(c)=>chunks.push(c));req.on('end',()=>{const body=JSON.parse(Buffer.concat(chunks).toString()||'{}');seen.push(req.headers.authorization);if(body.model==='train'&&(req.headers.authorization==='Bearer bad'||(req.headers.authorization==='Bearer good'&&goodTraining++<4))){res.writeHead(401,{'Content-Type':'application/json'});return res.end(JSON.stringify({error:{message:'unauthorized',status:401}}));}res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:'OK'}}]}));}); });
  const upstreamPort=await listen(upstream);const holder=http.createServer();const switchPort=await listen(holder);await close(holder);
  const config={port:switchPort,upstreamBase:`http://127.0.0.1:${upstreamPort}`,accountMode:'single',activeAccount:0,concurrencyWaitMs:0,accounts:[{id:'bad',name:'Bad',key:'bad',enabled:true,perModel:{}},{id:'good',name:'Good',key:'good',enabled:true,perModel:{}},{id:'disabled',name:'Disabled',key:'disabled-secret',enabled:false,perModel:{}}],knownModels:['train','serve'],perModel:{},accountErrorRules:{},accountPipeline:{quotaPool:false,excludeUnhealthy:false,healthSort:false,sticky:false}};
  const running=await startSwitcher(config);t.after(async()=>{await stop(running.child);await close(upstream);fs.rmSync(running.dir,{recursive:true,force:true});});
  for(let i=0;i<5;i++)assert.equal((await rawJson(switchPort,'/v1/chat/completions',{model:'train',messages:[]})).status,401);
  let stats=await(await fetch(`http://127.0.0.1:${switchPort}/api/statistics`)).json();assert.equal(stats.accounts.find(a=>a.id==='bad').health.status,'unhealthy');
  const accounts=(await(await fetch(`http://127.0.0.1:${switchPort}/api/accounts`)).json()).accounts;
  assert.equal((await rawJson(switchPort,'/api/accounts',{accounts,mode:'roundrobin',active:0,concurrencyWaitMs:0,accountErrorRules:{},accountPipeline:{quotaPool:false,excludeUnhealthy:true,healthSort:true,sticky:false}})).status,200);
  seen.length=0;const served=await rawJson(switchPort,'/v1/chat/completions',{model:'serve',messages:[]});assert.equal(served.status,200);assert.deepEqual(seen,['Bearer good']);
  await new Promise(r=>setTimeout(r,20));let logs=await(await fetch(`http://127.0.0.1:${switchPort}/api/logs/requests?requestedModel=serve`)).json();assert.ok(logs.items[0].pipelineSteps.includes('health-filtered'));assert.equal(JSON.stringify(logs).includes('bad'),false,'pipeline logs contain no key values');assert.equal(seen.includes('Bearer disabled-secret'),false,'disabled accounts never enter pipeline fallback');
  assert.equal((await rawJson(switchPort,'/api/accounts',{accounts,mode:'single',active:1,concurrencyWaitMs:0,accountErrorRules:{},accountPipeline:{quotaPool:false,excludeUnhealthy:false,healthSort:false,sticky:false}})).status,200);for(let i=0;i<5;i++)await rawJson(switchPort,'/v1/chat/completions',{model:'train',messages:[]});stats=await(await fetch(`http://127.0.0.1:${switchPort}/api/statistics`)).json();assert.equal(stats.accounts.find(a=>a.id==='good').health.status,'unhealthy');
  assert.equal((await rawJson(switchPort,'/api/accounts',{accounts,mode:'roundrobin',active:0,concurrencyWaitMs:0,accountErrorRules:{},accountPipeline:{quotaPool:false,excludeUnhealthy:true,healthSort:true,sticky:false}})).status,200);seen.length=0;assert.equal((await rawJson(switchPort,'/v1/chat/completions',{model:'serve',messages:[]})).status,200);assert.deepEqual(seen,['Bearer good'],'all-unhealthy fallback keeps only the highest score');await new Promise(r=>setTimeout(r,20));logs=await(await fetch(`http://127.0.0.1:${switchPort}/api/logs/requests?requestedModel=serve&limit=1`)).json();assert.ok(logs.items[0].pipelineSteps.includes('health-filter-fallback'));
});

const waitUntil = async (predicate, timeoutMs = 2000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await new Promise((resolve) => setTimeout(resolve, 10)); }
  throw new Error('condition timed out');
};

const emptyAggregateFixture = () => ({
  requests:0,errors:0,usageRequests:0,inputKnownRequests:0,inputTokens:0,outputKnownRequests:0,outputTokens:0,totalKnownRequests:0,totalTokens:0,
  cacheKnownRequests:0,cacheHitRequests:0,cachedTokens:0,cacheInputKnownRequests:0,cacheInputTokens:0,cacheInputCachedTokens:0,lastUsedAt:0,lastErrorAt:0,overflowFields:[],
});
const emptyHealthFixture = () => ({ results:0,penaltyUnits:0,errors:0,auth:0,rateLimit:0,networkProxy:0,server:0,other:0 });

async function unusedPort() { const holder = http.createServer(); const port = await listen(holder); await close(holder); return port; }

test('all explicit usage aliases, precedence, cache ratios, stream snapshots, retries and account replacement are exactly-once', async (t) => {
  const usageByModel = {
    u1:{prompt_tokens:10,completion_tokens:2,total_tokens:12,prompt_tokens_details:{cached_tokens:3}},
    u2:{input_tokens:20,output_tokens:4,total_tokens:24,input_tokens_details:{cached_tokens:5}},
    u3:{inputTokens:30,outputTokens:6,totalTokens:36,cache_read_input_tokens:7},
    u4:{prompt_tokens:40,completion_tokens:8,total_tokens:48,cached_input_tokens:9},
    u5:{prompt_tokens:50,completion_tokens:10,total_tokens:60,cachedInputTokens:11},
    zero:{prompt_tokens:0,completion_tokens:0,total_tokens:0,prompt_tokens_details:{cached_tokens:0}},
    invalid:{prompt_tokens:'10',input_tokens:999,completion_tokens:-1,output_tokens:999,total_tokens:2,prompt_tokens_details:{cached_tokens:'3'},cache_read_input_tokens:999},
    retry:{prompt_tokens:13,completion_tokens:3,total_tokens:16,prompt_tokens_details:{cached_tokens:6}},
    switch:{prompt_tokens:17,completion_tokens:4,total_tokens:21,prompt_tokens_details:{cached_tokens:8}},
  };
  const seen = [];
  const upstream = http.createServer((req,res)=>{const chunks=[];req.on('data',c=>chunks.push(c));req.on('end',()=>{
    const body=JSON.parse(Buffer.concat(chunks).toString()||'{}'), auth=req.headers.authorization, only=body.provider?.only?.[0]||body.providerOptions?.gateway?.only?.[0]; seen.push({model:body.model,auth,only});
    if(body.model==='switch'&&auth==='Bearer key-a'){res.writeHead(429,{'Content-Type':'application/json'});return res.end(JSON.stringify({error:{message:'account subscription quota exhausted',code:'account_quota_exhausted',status:429}}));}
    if(body.model==='retry'&&only==='first'){res.writeHead(500,{'Content-Type':'application/json'});return res.end(JSON.stringify({error:{message:'retry',status:500}}));}
    if(body.model==='stream'){res.writeHead(200,{'Content-Type':'text/event-stream'});return res.end('data: {"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4,"prompt_tokens_details":{"cached_tokens":1}}}\n\ndata: {"usage":{"prompt_tokens":5,"completion_tokens":1,"total_tokens":6,"prompt_tokens_details":{"cached_tokens":2}}}\n\ndata: {"usage":{"prompt_tokens":8,"completion_tokens":2,"total_tokens":10,"prompt_tokens_details":{"cached_tokens":4}}}\n\ndata: [DONE]\n\n');}
    res.writeHead(200,{'Content-Type':'application/json'});const payload={choices:[{message:{content:'OK'}}]};if(body.model!=='missing')payload.usage=usageByModel[body.model];res.end(JSON.stringify(payload));
  });});
  const upstreamPort=await listen(upstream), switchPort=await unusedPort();
  const models=[...Object.keys(usageByModel),'missing','stream'];
  const config={port:switchPort,upstreamBase:`http://127.0.0.1:${upstreamPort}`,accountMode:'single',activeAccount:0,concurrencyWaitMs:0,accounts:[{id:'a',name:'A',key:'key-a',enabled:true,perModel:{}},{id:'b',name:'B',key:'key-b',enabled:true,perModel:{}}],knownModels:models,perModel:{retry:{upstreams:['first','second'],pinMode:'strict'}},accountErrorRules:{429:{action:'cooldown',cooldownMs:60000}}};
  let running=await startSwitcher(config);t.after(async()=>{if(running?.child)await stop(running.child);await close(upstream);fs.rmSync(running.dir,{recursive:true,force:true});});
  for(const model of ['u1','u2','u3','u4','u5','zero','invalid','missing','retry'])assert.equal((await rawJson(switchPort,'/v1/chat/completions',{model,messages:[]})).status,200);
  assert.equal((await rawJson(switchPort,'/v1/chat/completions',{model:'stream',stream:true,messages:[]})).status,200);
  assert.equal((await rawJson(switchPort,'/v1/chat/completions',{model:'switch',messages:[]})).status,200);
  await rawJson(switchPort,'/api/test',{model:'u1'});
  let stats=await(await fetch(`http://127.0.0.1:${switchPort}/api/statistics`)).json(), global=stats.lifetime.global;
  assert.deepEqual({requests:global.requests,usageRequests:global.usageRequests,inputKnownRequests:global.inputKnownRequests,inputTokens:global.inputTokens,outputKnownRequests:global.outputKnownRequests,outputTokens:global.outputTokens,totalKnownRequests:global.totalKnownRequests,totalTokens:global.totalTokens,cacheKnownRequests:global.cacheKnownRequests,cacheHitRequests:global.cacheHitRequests,cachedTokens:global.cachedTokens},
    {requests:11,usageRequests:10,inputKnownRequests:9,inputTokens:188,outputKnownRequests:9,outputTokens:39,totalKnownRequests:10,totalTokens:229,cacheKnownRequests:9,cacheHitRequests:8,cachedTokens:53});
  assert.equal(global.cacheInputKnownRequests,9);assert.equal(global.cacheInputTokens,188);assert.equal(global.cacheInputCachedTokens,53);assert.equal(global.cacheTokenRatio,53/188);assert.equal(global.cacheHitRequestRate,8/9);
  assert.equal(seen.filter(x=>x.model==='retry').length,2,'provider retry must not duplicate usage');
  const a=stats.accounts.find(x=>x.id==='a'),b=stats.accounts.find(x=>x.id==='b');assert.equal(a.lifetime.inputTokens,171);assert.equal(b.lifetime.inputTokens,17);assert.equal(a.lifetime.requests,11);assert.equal(b.lifetime.requests,1);assert.equal(a.health.results,11);assert.equal(a.health.penaltyUnits,7);assert.equal(b.health.results,1);assert.equal(b.health.penaltyUnits,0,'A→B replacement records one independent terminal health result per account');
  const globalBeforeRestart=stats.lifetime.global;await stop(running.child);running.child=null;running=await startSwitcher(null,running.dir);stats=await(await fetch(`http://127.0.0.1:${switchPort}/api/statistics`)).json();assert.deepEqual(stats.lifetime.global,globalBeforeRestart,'statistics must survive restart exactly');
  const accountView=await(await fetch(`http://127.0.0.1:${switchPort}/api/accounts`)).json();assert.equal((await rawJson(switchPort,'/api/accounts',{accounts:accountView.accounts.filter(x=>x.id==='a'),mode:'single',active:0,concurrencyWaitMs:0,accountErrorRules:{}})).status,200);
  stats=await(await fetch(`http://127.0.0.1:${switchPort}/api/statistics`)).json();assert.equal(stats.accounts.some(x=>x.id==='b'),false);assert.deepEqual(stats.lifetime.global,globalBeforeRestart,'deleting an account retains global history');
});

test('health terminal classes, retry success, exact score boundaries and 24-hour expiry are deterministic', async (t) => {
  const sequences={available:[403,200,200,200,200],degraded:[401,429,500,500,200]};
  for(const [expected,statuses] of Object.entries(sequences)){
    let index=0;
    const upstream=http.createServer((req,res)=>{const chunks=[];req.on('data',c=>chunks.push(c));req.on('end',()=>{const body=JSON.parse(Buffer.concat(chunks).toString()||'{}');let status=statuses[Math.min(index++,statuses.length-1)];const only=body.provider?.only?.[0]||body.providerOptions?.gateway?.only?.[0];if(body.model==='retry-success')status=only==='first'?500:200;if(body.model==='parameter')status=418;if(body.model==='late'){res.writeHead(200,{'Content-Type':'text/event-stream'});return res.end('data: {"choices":[{"delta":{"content":"x"}}]}\n\ndata: {"error":{"message":"late","status":429}}\n\ndata: [DONE]\n\n');}res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(status===200?{choices:[{message:{content:'OK'}}]}:{error:{message:'failure',status}}));});});
    const upstreamPort=await listen(upstream),port=await unusedPort(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'cps-health-'));
    const cfg={port,upstreamBase:`http://127.0.0.1:${upstreamPort}`,accountMode:'single',activeAccount:0,concurrencyWaitMs:0,accounts:[{id:'a',name:'A',key:'ka',enabled:true,perModel:{}}],knownModels:['score','parameter','retry-success','late'],perModel:{'retry-success':{upstreams:['first','second'],pinMode:'strict'}},accountErrorRules:{}};
    let running=await startSwitcher(cfg,dir);try{
      for(let i=0;i<5;i++)await rawJson(port,'/v1/chat/completions',{model:'score',messages:[]});
      let stats=await(await fetch(`http://127.0.0.1:${port}/api/statistics`)).json(),health=stats.accounts[0].health;assert.equal(health.status,expected);assert.equal(health.score,expected==='available'?80:50);assert.equal(health.results,5);
      const before=health.results;await rawJson(port,'/v1/chat/completions',{model:'parameter',messages:[]});stats=await(await fetch(`http://127.0.0.1:${port}/api/statistics`)).json();assert.equal(stats.accounts[0].health.results,before,'ordinary 4xx must not enter health denominator');
      await rawJson(port,'/v1/chat/completions',{model:'retry-success',messages:[]});stats=await(await fetch(`http://127.0.0.1:${port}/api/statistics`)).json();assert.equal(stats.accounts[0].health.results,before+1);assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'metadata.json'))).statistics.minuteBuckets.at(-1).health.a.server,expected==='available'?0:2,'failed provider attempt must not penalize a later same-account success');
      await rawJson(port,'/v1/chat/completions',{model:'late',stream:true,messages:[]});stats=await(await fetch(`http://127.0.0.1:${port}/api/statistics`)).json();assert.equal(stats.accounts[0].health.results,before+2,'late SSE error is recorded once');
      await stop(running.child);running.child=null;const metadataPath=path.join(dir,'metadata.json'),metadata=JSON.parse(fs.readFileSync(metadataPath));for(const bucket of metadata.statistics.minuteBuckets)bucket.minute-=1440;fs.writeFileSync(metadataPath,JSON.stringify(metadata));running=await startSwitcher(null,dir);stats=await(await fetch(`http://127.0.0.1:${port}/api/statistics`)).json();assert.equal(stats.accounts[0].health.status,'insufficient');assert.equal(stats.accounts[0].health.score,null);assert.equal(stats.accounts[0].health.results,0,'results expire naturally after 1440 minutes');
    }finally{if(running?.child)await stop(running.child);await close(upstream);fs.rmSync(dir,{recursive:true,force:true});}
  }
});

test('runtime counter overflow becomes null with an exact marker', async (t) => {
  const upstream=http.createServer((req,res)=>{req.resume();req.on('end',()=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:'OK'}}]}));});}),upstreamPort=await listen(upstream),port=await unusedPort();
  let running=await startSwitcher({port,upstreamBase:`http://127.0.0.1:${upstreamPort}`,accountMode:'single',accounts:[{id:'a',name:'A',key:'ka',enabled:true,perModel:{}}],knownModels:['m'],perModel:{},accountErrorRules:{}});t.after(async()=>{if(running?.child)await stop(running.child);await close(upstream);fs.rmSync(running.dir,{recursive:true,force:true});});
  await stop(running.child);running.child=null;const metadataPath=path.join(running.dir,'metadata.json'),metadata=JSON.parse(fs.readFileSync(metadataPath));metadata.statistics.lifetime.global.requests=Number.MAX_SAFE_INTEGER;fs.writeFileSync(metadataPath,JSON.stringify(metadata));running=await startSwitcher(null,running.dir);assert.equal((await rawJson(port,'/v1/chat/completions',{model:'m',messages:[]})).status,200);
  const stats=await(await fetch(`http://127.0.0.1:${port}/api/statistics`)).json(),persisted=JSON.parse(fs.readFileSync(metadataPath));assert.equal(stats.lifetime.global.requests,null);assert.deepEqual(persisted.statistics.lifetime.global.overflowFields,['requests']);
});

test('missing and explicit all-false pipelines preserve all six mode sequences, reasons, capacity and lease release', async (t) => {
  let slowStarted=0;
  const upstream=http.createServer((req,res)=>{const chunks=[];req.on('data',c=>chunks.push(c));req.on('end',()=>{const body=JSON.parse(Buffer.concat(chunks).toString()||'{}');const reply=()=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:'OK'}}]}));};if(body.model==='slow'){slowStarted++;setTimeout(reply,80);}else reply();});}),upstreamPort=await listen(upstream);t.after(()=>close(upstream));
  const run=async(mode,explicit)=>{const port=await unusedPort(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'cps-legacy-equivalence-')),accounts=[{id:'a',name:'A',key:'ka',enabled:true,maxConcurrent:1,weight:1,priority:1,perModel:{}},{id:'b',name:'B',key:'kb',enabled:true,maxConcurrent:1,weight:3,priority:10,perModel:{}}],cfg={port,upstreamBase:`http://127.0.0.1:${upstreamPort}`,accountMode:mode,activeAccount:0,concurrencyWaitMs:0,accounts,knownModels:['fast','slow'],perModel:{},accountErrorRules:{}};if(explicit)cfg.accountPipeline={quotaPool:false,excludeUnhealthy:false,healthSort:false,sticky:false};fs.writeFileSync(path.join(dir,'metadata.json'),JSON.stringify({models:{},history:[],accountStates:{},routingSecret:'fixed-equivalence-secret',stats:{}}));const running=await startSwitcher(cfg,dir);try{const sequence=[];for(let i=0;i<8;i++){const r=await rawJson(port,'/v1/chat/completions',{model:'fast',messages:[]});sequence.push(r.headers['x-cline-account']);}let expectedSlowStarts=slowStarted+1;const p1=rawJson(port,'/v1/chat/completions',{model:'slow',messages:[]});await waitUntil(()=>slowStarted>=expectedSlowStarts);expectedSlowStarts++;const p2=rawJson(port,'/v1/chat/completions',{model:'slow',messages:[]});if(mode!=='single')await waitUntil(()=>slowStarted>=expectedSlowStarts);const p3=rawJson(port,'/v1/chat/completions',{model:'slow',messages:[]});const capacity=(await Promise.all([p1,p2,p3])).map(r=>({status:r.status,retry:r.headers['retry-after']||null}));const view=await(await fetch(`http://127.0.0.1:${port}/api/accounts`)).json(),logs=await waitUntil(async()=>{const page=await(await fetch(`http://127.0.0.1:${port}/api/logs/requests?requestedModel=fast&limit=20`)).json();return page.items.length>=8&&page;});return{sequence,capacity,reasons:logs.items.map(x=>x.selectionReason).sort(),active:view.accounts.map(x=>x.activeCount),pipeline:view.accountPipeline};}finally{await stop(running.child);fs.rmSync(dir,{recursive:true,force:true});}};
  for(const mode of ['single','roundrobin','sticky','least-connections','weighted-roundrobin','priority-failover']){const legacy=await run(mode,false),allFalse=await run(mode,true);assert.deepEqual(allFalse.sequence,legacy.sequence,`${mode} selection sequence changed`);assert.deepEqual(allFalse.capacity,legacy.capacity,`${mode} wait/429 behavior changed`);assert.deepEqual(allFalse.reasons,legacy.reasons,`${mode} diagnostic reason changed`);assert.deepEqual(allFalse.active,[0,0]);assert.deepEqual(legacy.active,[0,0]);assert.deepEqual(legacy.pipeline,{quotaPool:false,excludeUnhealthy:false,healthSort:false,sticky:false});}
});

test('enabled quota layers honor 80/95 boundaries, unknown ordering and immediate capacity fallback', async (t) => {
  const seen=[];const upstream=http.createServer((req,res)=>{const chunks=[];req.on('data',c=>chunks.push(c));req.on('end',()=>{if(req.method==='GET'){res.writeHead(500);return res.end('{}');}const body=JSON.parse(Buffer.concat(chunks).toString()||'{}');seen.push(req.headers.authorization);const reply=()=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:'OK'}}]}));};body.model==='slow'?setTimeout(reply,100):reply();});}),upstreamPort=await listen(upstream),port=await unusedPort(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'cps-quota-layers-'));
  const pools=[['hot',79.999],['warm',80],['warm2',94.999],['unknown',null],['reserve',95]],accounts=pools.map(([id])=>({id,name:id,key:`key-${id}`,enabled:true,maxConcurrent:1,perModel:{}})),fetchedAt=Date.now(),accountQuotas={};for(const[id,percent]of pools)if(percent!==null)accountQuotas[id]={snapshot:{limits:{five_hour:{percentUsed:percent},weekly:{percentUsed:percent},monthly:{percentUsed:percent}},fetchedAt},lastAttemptAt:fetchedAt,lastSuccessAt:fetchedAt,errorCategory:null};
  fs.writeFileSync(path.join(dir,'metadata.json'),JSON.stringify({models:{},history:[],accountStates:{},routingSecret:'quota-layer-secret',stats:{},accountQuotas}));
  const cfg={port,upstreamBase:`http://127.0.0.1:${upstreamPort}`,accountMode:'roundrobin',activeAccount:0,concurrencyWaitMs:0,accounts,knownModels:['fast','slow'],perModel:{},accountErrorRules:{},accountPipeline:{quotaPool:true,excludeUnhealthy:false,healthSort:false,sticky:false}};
  const running=await startSwitcher(cfg,dir);t.after(async()=>{await stop(running.child);await close(upstream);fs.rmSync(dir,{recursive:true,force:true});});
  const stats=await(await fetch(`http://127.0.0.1:${port}/api/statistics`)).json();assert.deepEqual(Object.fromEntries(stats.accounts.map(a=>[a.id,a.quota.pool])),{hot:'hot',warm:'warm',warm2:'warm',unknown:'unknown',reserve:'reserve'});
  const pending=[];for(let i=0;i<5;i++){pending.push(rawJson(port,'/v1/chat/completions',{model:'slow',messages:[]}));await waitUntil(()=>seen.length>=i+1);}assert.ok((await Promise.all(pending)).every(r=>r.status===200));assert.equal(seen[0],'Bearer key-hot');assert.deepEqual(new Set(seen.slice(1,3)),new Set(['Bearer key-warm','Bearer key-warm2']));assert.deepEqual(seen.slice(3,5),['Bearer key-unknown','Bearer key-reserve']);
  await new Promise(r=>setTimeout(r,20));const capacityLogs=await(await fetch(`http://127.0.0.1:${port}/api/logs/requests?requestedModel=slow&limit=20`)).json();assert.ok(capacityLogs.items.some(x=>x.selectedQuotaPool==='reserve'&&x.capacityFallback===true));
  const view=await(await fetch(`http://127.0.0.1:${port}/api/accounts`)).json();for(const account of view.accounts)account.key+='-rotated';assert.equal((await rawJson(port,'/api/accounts',{accounts:view.accounts,mode:'roundrobin',active:0,concurrencyWaitMs:0,accountErrorRules:{},accountPipeline:view.accountPipeline})).status,200);seen.length=0;for(let i=0;i<5;i++)await rawJson(port,'/v1/chat/completions',{model:'fast',messages:[]});assert.deepEqual(seen,['Bearer key-hot-rotated','Bearer key-warm-rotated','Bearer key-warm2-rotated','Bearer key-unknown-rotated','Bearer key-reserve-rotated'],'all-unknown quota must be ordinary round-robin');await new Promise(r=>setTimeout(r,20));const unknownLogs=await(await fetch(`http://127.0.0.1:${port}/api/logs/requests?requestedModel=fast&limit=20`)).json();assert.ok(unknownLogs.items.every(x=>x.pipelineSteps.includes('quota-all-unknown')));
  const stickyView=await(await fetch(`http://127.0.0.1:${port}/api/accounts`)).json();assert.equal((await rawJson(port,'/api/accounts',{accounts:stickyView.accounts,mode:'single',active:0,concurrencyWaitMs:0,accountErrorRules:{},accountPipeline:{quotaPool:false,excludeUnhealthy:false,healthSort:false,sticky:true}})).status,200);
  let stickySession=null,stickyAccount=null;for(let i=0;i<30;i++){const session=`pipeline-sticky-${i}`,r=await rawJson(port,'/v1/chat/completions',{model:'fast',messages:[]},{'Session-Id':session});if(r.headers['x-cline-account']!=='hot'){stickySession=session;stickyAccount=r.headers['x-cline-account'];break;}}assert.ok(stickySession,'pipeline affinity must be able to override single active account');const repeat=await rawJson(port,'/v1/chat/completions',{model:'fast',messages:[]},{'Session-Id':stickySession});assert.equal(repeat.headers['x-cline-account'],stickyAccount);
  const heldSeen=seen.length;const held=rawJson(port,'/v1/chat/completions',{model:'slow',messages:[]},{'Session-Id':stickySession});await waitUntil(()=>seen.length>heldSeen);const blocked=await rawJson(port,'/v1/chat/completions',{model:'slow',messages:[]},{'Session-Id':stickySession});assert.equal(blocked.status,429,'single plus pipeline sticky waits only for its one HRW primary');assert.equal((await held).headers['x-cline-account'],stickyAccount);await new Promise(r=>setTimeout(r,20));const stickyLogs=await(await fetch(`http://127.0.0.1:${port}/api/logs/requests?requestedModel=slow&limit=20`)).json();assert.ok(stickyLogs.items.some(x=>x.selectionReason==='pipeline-sticky-primary'));
});

test('the 50,000 account-minute union cap evicts an aggregate/health cell atomically and marks coverage', async (t) => {
  const upstream=http.createServer((req,res)=>{req.resume();req.on('end',()=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:'OK'}}]}));});}),upstreamPort=await listen(upstream),port=await unusedPort(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'cps-cell-cap-'));
  const accounts=Array.from({length:50001},(_,i)=>({id:`a${i}`,name:`A${i}`,key:`k${i}`,enabled:true,perModel:{}}));
  const minute=Math.floor(Date.now()/60000),health={},accountCells={};for(let i=0;i<50000;i++){health[`a${i}`]=emptyHealthFixture();accountCells[`a${i}`]=emptyAggregateFixture();}
  const statistics={version:1,lifetime:{global:emptyAggregateFixture(),accounts:{}},minuteBuckets:[{minute,global:emptyAggregateFixture(),accounts:accountCells,health}],recentCoverage:{droppedAccountMinuteCells:0,accountIncompleteAt:{}},migration:{legacyStatsMigratedAt:Date.now(),legacyRequests:0,accountLegacyRequests:{},ambiguousNames:0,unmappedNames:0}};
  fs.writeFileSync(path.join(dir,'metadata.json'),JSON.stringify({models:{},history:[],accountStates:{},accountQuotas:{},routingSecret:'cell-cap-secret',statistics}));
  let running=await startSwitcher({port,upstreamBase:`http://127.0.0.1:${upstreamPort}`,accountMode:'single',activeAccount:50000,concurrencyWaitMs:0,accounts,knownModels:['m'],perModel:{},accountErrorRules:{}},dir);t.after(async()=>{if(running?.child)await stop(running.child);await close(upstream);fs.rmSync(dir,{recursive:true,force:true});});
  assert.equal((await rawJson(port,'/v1/chat/completions',{model:'m',messages:[]})).status,200);const persisted=JSON.parse(fs.readFileSync(path.join(dir,'metadata.json'))),bucket=persisted.statistics.minuteBuckets[0];
  const cells=new Set([...Object.keys(bucket.accounts),...Object.keys(bucket.health)]);assert.equal(cells.size,50000);assert.equal(bucket.accounts.a0,undefined);assert.equal(bucket.health.a0,undefined);assert.ok(bucket.accounts.a50000);assert.ok(bucket.health.a50000);assert.equal(persisted.statistics.recentCoverage.droppedAccountMinuteCells,1);assert.equal(persisted.statistics.recentCoverage.accountIncompleteAt.a0,minute);
});

test('quota scheduler is bounded, strict, fail-open and discards stale credential generations', async (t) => {
  let phase='success',active=0,maxActive=0;const quotaRequests=[];
  const goodPayload={success:true,data:{limits:[{type:'five_hour',percentUsed:79.9,resetsAt:'2026-09-15T08:00:00+08:00'},{type:'weekly',percentUsed:80},{type:'monthly',percentUsed:95},{type:'future',percentUsed:1}]}};
  const upstream=http.createServer((req,res)=>{
    if(req.method==='GET'){
      active++;maxActive=Math.max(maxActive,active);quotaRequests.push({url:req.url,auth:req.headers.authorization,custom:req.headers['x-chat-only'],at:Date.now(),phase});
      const finish=()=>{active--;if(phase==='hold')return;if(phase==='rate'){res.writeHead(429);return res.end('{}');}if(phase==='duplicate'){res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify({success:true,data:{limits:[{type:'weekly',percentUsed:1},{type:'weekly',percentUsed:2}]}}));}if(phase==='oversize'){res.writeHead(200,{'Content-Type':'application/json'});return res.end(' '.repeat(257*1024));}res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(goodPayload));};return setTimeout(finish,30);
    }
    req.resume();req.on('end',()=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:'OK'}}]}));});
  });
  const upstreamPort=await listen(upstream),port=await unusedPort(),accounts=['a','b','c'].map(id=>({id,name:id.toUpperCase(),key:`key-${id}`,enabled:true,headers:{'X-Chat-Only':'secret'},perModel:{}}));
  const cfg={port,upstreamBase:`http://127.0.0.1:${upstreamPort}/api/v1`,accountMode:'roundrobin',concurrencyWaitMs:0,accounts,knownModels:['m'],perModel:{},accountErrorRules:{},accountPipeline:{quotaPool:true,excludeUnhealthy:false,healthSort:false,sticky:false}};
  let running=await startSwitcher(cfg,null,{NODE_ENV:'test',CLINE_PASS_TEST_QUOTA_SUCCESS_MS:'50',CLINE_PASS_TEST_QUOTA_FAILURE_MS:'50',CLINE_PASS_TEST_QUOTA_TIMEOUT_MS:'80',CLINE_PASS_TEST_QUOTA_STALE_MS:'120'});t.after(async()=>{if(running?.child)await stop(running.child);await close(upstream);fs.rmSync(running.dir,{recursive:true,force:true});});
  let stats=await waitUntil(async()=>{const x=await(await fetch(`http://127.0.0.1:${port}/api/statistics`)).json();return x.accounts.every(a=>a.quota.status==='fresh')&&x;},3000);
  assert.ok(maxActive<=2,`quota concurrency exceeded 2: ${maxActive}`);assert.ok(quotaRequests.every(x=>x.url==='/api/v1/users/me/plan/usage-limits'));assert.deepEqual(new Set(quotaRequests.map(x=>x.auth)),new Set(['Bearer key-a','Bearer key-b','Bearer key-c']));assert.ok(quotaRequests.every(x=>x.custom===undefined),'chat custom headers must not reach quota endpoint');
  assert.ok(stats.accounts.every(a=>a.quota.pool==='reserve'),'maximum of the three windows owns the quota pool');assert.ok(stats.accounts.every(a=>a.quota.limits.five_hour.resetsAt==='2026-09-15T00:00:00.000Z'),'quota reset timestamps are stored as canonical ISO projections');
  const successRetry=await waitUntil(async()=>{for(const auth of ['Bearer key-a','Bearer key-b','Bearer key-c']){const rows=quotaRequests.filter(x=>x.phase==='success'&&x.auth===auth);if(rows.length>=2)return rows;}return null;},3000);assert.ok(successRetry[1].at-successRetry[0].at>=45,'successful refreshes respect the configured success interval');
  phase='rate';stats=await waitUntil(async()=>{const x=await(await fetch(`http://127.0.0.1:${port}/api/statistics`)).json();return x.accounts.every(a=>a.quota.errorCategory==='rate_limit')&&x;},3000);assert.ok(stats.accounts.every(a=>a.quota.status==='unknown'&&a.quota.limits.monthly.percentUsed===95),'failure is immediately unknown while last-good remains diagnostic');
  const rateRetry=await waitUntil(async()=>{for(const auth of ['Bearer key-a','Bearer key-b','Bearer key-c']){const rows=quotaRequests.filter(x=>x.phase==='rate'&&x.auth===auth);if(rows.length>=2)return rows;}return null;},3000);assert.ok(rateRetry[1].at-rateRetry[0].at>=90,'failed refreshes use exponential backoff instead of the success interval');
  phase='duplicate';await waitUntil(async()=>{const x=await(await fetch(`http://127.0.0.1:${port}/api/statistics`)).json();return x.accounts.some(a=>a.quota.errorCategory==='schema');},3000);
  phase='oversize';await waitUntil(async()=>quotaRequests.some(x=>x.phase==='oversize'),3000);await new Promise(r=>setTimeout(r,120));stats=await(await fetch(`http://127.0.0.1:${port}/api/statistics`)).json();assert.ok(stats.accounts.some(a=>a.quota.errorCategory==='schema'));
  phase='hold';const aRotationHoldStart=quotaRequests.length;await waitUntil(()=>quotaRequests.slice(aRotationHoldStart).some(x=>x.phase==='hold'&&x.auth==='Bearer key-a'),3000);const view=await(await fetch(`http://127.0.0.1:${port}/api/accounts`)).json();view.accounts[0].key='key-a-rotated';assert.equal((await rawJson(port,'/api/accounts',{accounts:view.accounts,mode:view.mode,active:view.active,concurrencyWaitMs:view.concurrencyWaitMs,accountErrorRules:view.accountErrorRules,accountPipeline:view.accountPipeline})).status,200);
  assert.equal((await rawJson(port,'/v1/chat/completions',{model:'m',messages:[]})).status,200);assert.ok(active>0,'chat must complete while a quota request is still in flight instead of awaiting it');
  phase='success';stats=await waitUntil(async()=>{const x=await(await fetch(`http://127.0.0.1:${port}/api/statistics`)).json();return x.accounts.find(a=>a.id==='a')?.quota.status==='fresh'&&x;},3000);assert.ok(quotaRequests.some(x=>x.auth==='Bearer key-a-rotated'));let serialized=fs.readFileSync(path.join(running.dir,'metadata.json'),'utf8');assert.equal(serialized.includes('key-a'),false);assert.equal(serialized.includes('X-Chat-Only'),false);
  phase='hold';const bHoldStart=quotaRequests.length;await waitUntil(async()=>quotaRequests.slice(bHoldStart).some(x=>x.auth==='Bearer key-b'&&x.phase==='hold'),3000);let current=await(await fetch(`http://127.0.0.1:${port}/api/accounts`)).json();assert.equal((await rawJson(port,'/api/accounts',{accounts:current.accounts.filter(a=>a.id!=='b'),mode:current.mode,active:0,concurrencyWaitMs:current.concurrencyWaitMs,accountErrorRules:current.accountErrorRules,accountPipeline:current.accountPipeline})).status,200);await new Promise(r=>setTimeout(r,120));assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(path.join(running.dir,'metadata.json'))).accountQuotas,'b'),false,'deleted account generation cannot be resurrected by an in-flight refresh');
  const cHoldStart=quotaRequests.length;await waitUntil(async()=>quotaRequests.slice(cHoldStart).some(x=>x.auth==='Bearer key-c'&&x.phase==='hold'),3000);current=await(await fetch(`http://127.0.0.1:${port}/api/accounts`)).json();const dead=await unusedPort();current.accounts.find(a=>a.id==='c').proxyUrl=`http://127.0.0.1:${dead}`;assert.equal((await rawJson(port,'/api/accounts',{accounts:current.accounts,mode:current.mode,active:0,concurrencyWaitMs:current.concurrencyWaitMs,accountErrorRules:current.accountErrorRules,accountPipeline:current.accountPipeline})).status,200);stats=await waitUntil(async()=>{const x=await(await fetch(`http://127.0.0.1:${port}/api/statistics`)).json();return x.accounts.find(a=>a.id==='c')?.quota.errorCategory==='proxy'&&x;},3000);assert.equal(stats.accounts.find(a=>a.id==='c').quota.status,'unknown','proxy rotation invalidates the old generation and never falls back direct');
  phase='hold';const aHoldStart=quotaRequests.length;await waitUntil(async()=>quotaRequests.slice(aHoldStart).some(x=>x.auth==='Bearer key-a-rotated'&&x.phase==='hold'),3000);current=await(await fetch(`http://127.0.0.1:${port}/api/accounts`)).json();const beforeDisable=JSON.parse(fs.readFileSync(path.join(running.dir,'metadata.json')).toString()).accountQuotas.a;assert.equal((await rawJson(port,'/api/accounts',{accounts:current.accounts,mode:current.mode,active:0,concurrencyWaitMs:current.concurrencyWaitMs,accountErrorRules:current.accountErrorRules,accountPipeline:{quotaPool:false,excludeUnhealthy:false,healthSort:false,sticky:false}})).status,200);await new Promise(r=>setTimeout(r,120));assert.deepEqual(JSON.parse(fs.readFileSync(path.join(running.dir,'metadata.json')).toString()).accountQuotas.a,beforeDisable,'closing quota routing discards in-flight completion');
  await stop(running.child);running.child=null;const metadataPath=path.join(running.dir,'metadata.json'),metadata=JSON.parse(fs.readFileSync(metadataPath));for(const q of Object.values(metadata.accountQuotas)){if(q.snapshot)q.snapshot.fetchedAt-=1000;q.lastSuccessAt=q.snapshot?.fetchedAt||q.lastSuccessAt;q.lastAttemptAt=q.lastSuccessAt;q.errorCategory=null;}const config=JSON.parse(fs.readFileSync(path.join(running.dir,'config.json')));config.accountPipeline.quotaPool=false;fs.writeFileSync(metadataPath,JSON.stringify(metadata));fs.writeFileSync(path.join(running.dir,'config.json'),JSON.stringify(config));running=await startSwitcher(null,running.dir,{NODE_ENV:'test',CLINE_PASS_TEST_QUOTA_STALE_MS:'120'});stats=await(await fetch(`http://127.0.0.1:${port}/api/statistics`)).json();assert.ok(stats.accounts.every(a=>a.quota.status==='unknown'),'stale last-good snapshots cannot route');
});

test('single-provider planning, conservative 429 scope and model provider health survive restart', async (t) => {
  const seen=[];const html429='<html>edge limit</html>';
  const upstream=http.createServer((req,res)=>{const chunks=[];req.on('data',c=>chunks.push(c));req.on('end',()=>{
    const body=JSON.parse(Buffer.concat(chunks).toString()||'{}'),auth=req.headers.authorization;
    const direct=body.provider?.only,planner=body.providerOptions?.gateway?.only,only=direct?.[0]||planner?.[0]||null;
    seen.push({model:body.model,auth,only,body});
    const ok=()=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:'OK'}}],provider:only||'Auto Provider',model:'mock/model'}));};
    if(body.model==='unknown-429'&&only==='deepseek'){res.writeHead(429,{'Content-Type':'text/html; charset=UTF-8','Content-Length':Buffer.byteLength(html429)});return res.end(html429);}
    if(body.model==='provider-429'&&only==='p-rate'){res.writeHead(429,{'Content-Type':'application/json','Retry-After':'2'});return res.end(JSON.stringify({error:{message:'provider pool limited',provider:'p-rate',status:429}}));}
    if(body.model==='provider-mixed'&&only==='p-mixed'){res.writeHead(429,{'Content-Type':'application/json'});return res.end(JSON.stringify({error:{message:'provider quota exceeded',provider:'p-mixed',account:'account-a',status:429}}));}
    if(body.model==='retry-date'&&only==='p-date'){res.writeHead(429,{'Content-Type':'application/json','Retry-After':new Date(Date.now()+5000).toUTCString()});return res.end(JSON.stringify({error:{message:'provider limited',provider:'p-date',status:429}}));}
    if(body.model==='retry-invalid'&&only==='p-invalid'){res.writeHead(429,{'Content-Type':'application/json','Retry-After':'later'});return res.end(JSON.stringify({error:{message:'provider limited',provider:'p-invalid',status:429}}));}
    if(body.model==='rate-backoff'){res.writeHead(429,{'Content-Type':'application/json'});return res.end(JSON.stringify({error:{message:'provider limited',provider:'rate-only',status:429}}));}
    if(body.model==='server-backoff'){res.writeHead(500,{'Content-Type':'application/json'});return res.end(JSON.stringify({error:{message:'server failed',status:500}}));}
    if(body.model==='manual-order'&&only==='first'){res.writeHead(500,{'Content-Type':'application/json'});return res.end(JSON.stringify({error:{message:'server failed',status:500}}));}
    if(body.model==='discovered'&&only==='disc-one'){res.writeHead(500,{'Content-Type':'application/json'});return res.end(JSON.stringify({error:{message:'server failed',status:500}}));}
    if(body.model==='unsupported'&&only==='bad-pin'){res.writeHead(400,{'Content-Type':'application/json'});return res.end(JSON.stringify({error:{message:'provider is unsupported',provider:'bad-pin',status:400}}));}
    if(body.model==='account-429'&&auth==='Bearer key-a'){res.writeHead(429,{'Content-Type':'application/json'});return res.end(JSON.stringify({error:{message:`account subscription quota exhausted for ${body.messages?.[0]?.content}`,code:'account_quota_exhausted',status:429}}));}
    if(body.model==='double-account'&&(auth==='Bearer key-a'||auth==='Bearer key-b')){res.writeHead(429,{'Content-Type':'application/json'});return res.end(JSON.stringify({error:{message:'account plan quota exhausted',code:'plan_quota_exhausted',status:429}}));}
    if(body.model==='stream-pre'&&only==='stream-one'){res.writeHead(200,{'Content-Type':'text/event-stream'});return res.end('data: {"error":{"message":"rate limited","status":429}}\n\n');}
    if(body.model==='stream-pre'&&only==='stream-two'){res.writeHead(200,{'Content-Type':'text/event-stream'});return res.end('data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n');}
    if(body.model==='stream-network'&&only==='stream-reset'){res.writeHead(200,{'Content-Type':'text/event-stream'});res.flushHeaders();return setImmediate(()=>res.destroy());}
    if(body.model==='stream-network'&&only==='stream-ok'){res.writeHead(200,{'Content-Type':'text/event-stream'});return res.end('data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n');}
    if(body.model==='stream-late'){res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('data: {"choices":[{"delta":{"content":"started"}}]}\n\n');return setTimeout(()=>res.end('data: {"error":{"message":"provider limited","provider":"late-one","status":429}}\n\ndata: [DONE]\n\n'),5);}
    ok();
  });});
  const upstreamPort=await listen(upstream),port=await unusedPort(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'cps-provider-health-')),now=Date.now();
  const state=(status,cooldownUntil=0)=>({status,checkedAt:now,lastSuccessAt:0,lastFailureAt:now,consecutiveFailures:status==='ok'?0:1,cooldownUntil,failureClass:status==='ok'?null:'rate_limit',note:'fixture'});
  fs.writeFileSync(path.join(dir,'metadata.json'),JSON.stringify({routingSecret:'provider-health-secret',accountStates:{},accountQuotas:{},history:[],models:{
    'manual-order':{upstreams:['first','second'],upstreamStatus:{first:state('degraded'),second:state('ok')}},
    cooling:{upstreams:['cool-first','cool-second'],upstreamStatus:{'cool-first':state('limited',now+60000),'cool-second':state('ok')}},
    'fail-open':{upstreams:['late-recovery','early-recovery'],upstreamStatus:{'late-recovery':state('limited',now+60000),'early-recovery':state('degraded',now+30000)}},
    'half-open':{upstreams:['half-first','half-second'],upstreamStatus:{'half-first':state('limited',now-1000),'half-second':state('ok')}},
    'max-after-health':{upstreams:['max-cooling','max-eligible','max-extra'],upstreamStatus:{'max-cooling':state('limited',now+60000)}},
    'legacy-health':{upstreams:['legacy','invalid'],upstreamStatus:{legacy:{status:'limited',checkedAt:now,note:'legacy'},invalid:{status:'auth',checkedAt:-1,consecutiveFailures:999,cooldownUntil:'bad',failureClass:'bogus',note:'legacy'}}},
    discovered:{pipeline:'direct',upstreams:['disc-one','disc-two'],upstreamStatus:{}},planner:{pipeline:'planner',upstreams:['plan-one']},direct:{pipeline:'direct',upstreams:['direct-one']}
  }}));
  const route=(upstreams,pinMode='preferred',extra={})=>({upstreams,exclude:[],pinMode,sort:null,maxRetries:null,...extra});
  const perModel={
    'unknown-429':route(['deepseek','fireworks']),'provider-429':route(['p-rate','p-ok']),'provider-mixed':route(['p-mixed','p-mixed-ok']),
    'retry-date':route(['p-date','p-date-ok']),'retry-invalid':route(['p-invalid','p-invalid-ok']),'rate-backoff':route(['rate-only']),'server-backoff':route(['server-only']),'manual-order':route(['first','second']),cooling:route(['cool-first','cool-second']),
    'fail-open':route(['late-recovery','early-recovery']),'half-open':route(['half-first','half-second']),'max-after-health':route(['max-cooling','max-eligible','max-extra'],'preferred',{maxRetries:0}),planner:route(['plan-one']),'direct':route(['direct-one'],'strict'),
    'all-excluded':route(['blocked'],'preferred',{exclude:['blocked']}),'account-429':route(['account-provider','backup']),'double-account':route(['account-provider','backup']),
    isolation:route(['first']),'unsupported':route(['bad-pin','good-pin']),'stream-pre':route(['stream-one','stream-two']),'stream-network':route(['stream-reset','stream-ok']),'stream-late':route(['late-one'])
  };
  const accounts=['a','b','c'].map(id=>({id,name:id.toUpperCase(),key:`key-${id}`,enabled:true,perModel:{}}));
  const cfg={port,upstreamBase:`http://127.0.0.1:${upstreamPort}`,accountMode:'single',activeAccount:0,concurrencyWaitMs:0,accounts,knownModels:[...Object.keys(perModel),'discovered','auto'],perModel,accountErrorRules:{429:{action:'cooldown',cooldownMs:60000}}};
  let running=await startSwitcher(cfg,dir);t.after(async()=>{if(running?.child)await stop(running.child);await close(upstream);fs.rmSync(dir,{recursive:true,force:true});});
  const call=(model,extra={})=>rawJson(port,'/v1/chat/completions',{model,messages:[{role:'user',content:'super-secret-prompt'}],...extra});
  let metadata=JSON.parse(fs.readFileSync(path.join(dir,'metadata.json')));
  assert.deepEqual(metadata.models['legacy-health'].upstreamStatus.legacy,{status:'limited',checkedAt:now,lastSuccessAt:0,lastFailureAt:0,consecutiveFailures:0,cooldownUntil:0,failureClass:null,note:'legacy'});
  assert.deepEqual(metadata.models['legacy-health'].upstreamStatus.invalid,{status:'unknown',checkedAt:0,lastSuccessAt:0,lastFailureAt:0,consecutiveFailures:30,cooldownUntil:0,failureClass:null,note:'legacy'});

  let start=seen.length,r=await call('manual-order',{provider:{order:['evil-a','evil-b']},providerOptions:{gateway:{order:['evil-a','evil-b']}}});assert.equal(r.status,200);
  let rows=seen.slice(start);assert.deepEqual(rows.map(x=>x.only),['first','second'],'health labels must not reorder eligible manual providers');assert.equal(new Set(rows.map(x=>x.auth)).size,1);
  for(const row of rows){assert.deepEqual(row.body.provider.only,[row.only]);assert.deepEqual(row.body.providerOptions.gateway.only,[row.only]);assert.equal(row.body.provider.order,undefined);assert.equal(row.body.providerOptions.gateway.order,undefined);}
  start=seen.length;assert.equal((await call('cooling')).status,200);assert.deepEqual(seen.slice(start).map(x=>x.only),['cool-second'],'active cooldown is bypassed');
  start=seen.length;assert.equal((await call('fail-open')).status,200);assert.deepEqual(seen.slice(start).map(x=>x.only),['early-recovery'],'all-cooling fail-open chooses earliest recovery only');
  start=seen.length;assert.equal((await call('half-open')).status,200);assert.deepEqual(seen.slice(start).map(x=>x.only),['half-first'],'expired cooldown returns to its original position');
  start=seen.length;assert.equal((await call('max-after-health')).status,200);assert.deepEqual(seen.slice(start).map(x=>x.only),['max-eligible'],'maxRetries is applied after cooling providers are removed');

  start=seen.length;r=await call('unknown-429');assert.equal(r.status,200);rows=seen.slice(start);assert.deepEqual(rows.map(x=>x.only),['deepseek','fireworks']);assert.equal(new Set(rows.map(x=>x.auth)).size,1,'unknown 429 stays on one Authorization');assert.equal(r.headers['x-cline-target-upstream'],'deepseek>fireworks');
  metadata=JSON.parse(fs.readFileSync(path.join(dir,'metadata.json')));assert.equal(metadata.accountStates.a,undefined);assert.equal(metadata.models['unknown-429'].upstreamStatus.deepseek.status,'limited');assert.ok(metadata.models['unknown-429'].upstreamStatus.deepseek.cooldownUntil-Date.now()>50000);
  start=seen.length;r=await call('provider-429');assert.equal(r.status,200);assert.deepEqual(seen.slice(start).map(x=>x.only),['p-rate','p-ok']);metadata=JSON.parse(fs.readFileSync(path.join(dir,'metadata.json')));const retryDelay=metadata.models['provider-429'].upstreamStatus['p-rate'].cooldownUntil-metadata.models['provider-429'].upstreamStatus['p-rate'].lastFailureAt;assert.equal(retryDelay,2000);
  start=seen.length;r=await call('provider-mixed');assert.equal(r.status,200);rows=seen.slice(start);assert.deepEqual(rows.map(x=>x.only),['p-mixed','p-mixed-ok']);assert.equal(new Set(rows.map(x=>x.auth)).size,1,'a provider quota plus an unrelated account field is not account evidence');
  start=seen.length;assert.equal((await call('retry-date')).status,200);metadata=JSON.parse(fs.readFileSync(path.join(dir,'metadata.json')));const dateDelay=metadata.models['retry-date'].upstreamStatus['p-date'].cooldownUntil-metadata.models['retry-date'].upstreamStatus['p-date'].lastFailureAt;assert.ok(dateDelay>=3000&&dateDelay<=5000,'HTTP-date Retry-After is honored within second precision');
  start=seen.length;assert.equal((await call('retry-invalid')).status,200);metadata=JSON.parse(fs.readFileSync(path.join(dir,'metadata.json')));const invalidDelay=metadata.models['retry-invalid'].upstreamStatus['p-invalid'].cooldownUntil-metadata.models['retry-invalid'].upstreamStatus['p-invalid'].lastFailureAt;assert.equal(invalidDelay,60000,'invalid Retry-After uses the first local backoff');
  for(let i=0;i<7;i++)assert.equal((await call('rate-backoff')).status,429);metadata=JSON.parse(fs.readFileSync(path.join(dir,'metadata.json')));const rateState=metadata.models['rate-backoff'].upstreamStatus['rate-only'];assert.equal(rateState.consecutiveFailures,7);assert.equal(rateState.cooldownUntil-rateState.lastFailureAt,1800000,'rate-limit exponential backoff is capped at 30 minutes');
  for(let i=0;i<5;i++)assert.equal((await call('server-backoff')).status,500);metadata=JSON.parse(fs.readFileSync(path.join(dir,'metadata.json')));const serverState=metadata.models['server-backoff'].upstreamStatus['server-only'];assert.equal(serverState.consecutiveFailures,5);assert.equal(serverState.cooldownUntil-serverState.lastFailureAt,120000,'server exponential backoff is capped at two minutes');
  start=seen.length;assert.equal((await call('unsupported')).status,200);assert.deepEqual(seen.slice(start).map(x=>x.only),['bad-pin','good-pin']);metadata=JSON.parse(fs.readFileSync(path.join(dir,'metadata.json')));assert.equal(metadata.models.unsupported.upstreamStatus['bad-pin'].status,'bad');assert.equal(metadata.models.unsupported.upstreamStatus['bad-pin'].cooldownUntil-metadata.models.unsupported.upstreamStatus['bad-pin'].lastFailureAt,3600000);
  assert.equal(metadata.models['manual-order'].upstreamStatus.first.status,'degraded');assert.ok(metadata.models['manual-order'].upstreamStatus.first.cooldownUntil-metadata.models['manual-order'].upstreamStatus.first.lastFailureAt>=15000);
  assert.equal(metadata.models['half-open'].upstreamStatus['half-first'].status,'ok');assert.equal(metadata.models['half-open'].upstreamStatus['half-first'].cooldownUntil,0);

  start=seen.length;assert.equal((await call('planner')).status,200);rows=seen.slice(start);assert.deepEqual(rows[0].body.providerOptions.gateway.only,['plan-one']);assert.equal(rows[0].body.provider,undefined);assert.equal(rows[0].body.providerOptions.gateway.order,undefined);
  start=seen.length;assert.equal((await call('direct')).status,200);rows=seen.slice(start);assert.deepEqual(rows[0].body.provider.only,['direct-one']);assert.equal(rows[0].body.providerOptions,undefined);assert.equal(rows[0].body.provider.order,undefined);
  start=seen.length;assert.equal((await call('discovered')).status,200);assert.deepEqual(seen.slice(start).map(x=>x.only),['disc-one','disc-two'],'discovered providers become named health-aware attempts');
  start=seen.length;assert.equal((await call('auto')).status,200);rows=seen.slice(start);assert.equal(rows.length,1);assert.equal(rows[0].only,null);assert.equal(rows[0].body.provider,undefined);assert.equal(rows[0].body.providerOptions,undefined);
  start=seen.length;r=await call('all-excluded');assert.equal(r.status,503);assert.equal(seen.length,start,'all excluded must not bypass with auto');assert.equal(r.headers['x-cline-attempts'],'0');
  const noProviderLog=await waitUntil(async()=>{const page=await(await fetch(`http://127.0.0.1:${port}/api/logs/requests?requestId=${r.headers['x-cline-request-id']}`)).json();return page.items[0]||null;});assert.equal(noProviderLog.errorCategory,'routing');assert.deepEqual(noProviderLog.attempts,[]);

  start=seen.length;r=await call('account-429');assert.equal(r.status,200);assert.deepEqual(seen.slice(start).map(x=>[x.auth,x.only]),[['Bearer key-a','account-provider'],['Bearer key-b','account-provider']]);metadata=JSON.parse(fs.readFileSync(path.join(dir,'metadata.json')));assert.ok(metadata.accountStates.a.cooldownUntil>Date.now());assert.equal(JSON.stringify(metadata).includes('super-secret-prompt'),false,'account action and provider metadata must redact request content');assert.equal(metadata.models['account-429'].upstreamStatus['account-provider'].status,'ok','replacement success may recover provider, but account failure must not penalize it');
  const historyAfterAccount=await(await fetch(`http://127.0.0.1:${port}/api/history`)).json();assert.equal(JSON.stringify(historyAfterAccount).includes('super-secret-prompt'),false,'compatibility history must redact echoed request content');
  await rawJson(port,'/api/accounts/recover',{id:'a'});start=seen.length;r=await call('double-account');assert.equal(r.status,429);assert.deepEqual(seen.slice(start).map(x=>x.auth),['Bearer key-a','Bearer key-b'],'a second account action must not select C');await rawJson(port,'/api/accounts/recover',{id:'a'});await rawJson(port,'/api/accounts/recover',{id:'b'});

  start=seen.length;r=await call('isolation');assert.equal(r.status,200);assert.deepEqual(seen.slice(start).map(x=>x.only),['first'],'provider health is isolated by model');
  start=seen.length;r=await call('stream-pre',{stream:true});assert.equal(r.status,200);assert.match(r.text,/OK/);assert.deepEqual(seen.slice(start).map(x=>x.only),['stream-one','stream-two']);
  start=seen.length;r=await call('stream-network',{stream:true});assert.equal(r.status,200);assert.match(r.text,/OK/);assert.deepEqual(seen.slice(start).map(x=>x.only),['stream-reset','stream-ok']);metadata=JSON.parse(fs.readFileSync(path.join(dir,'metadata.json')));assert.equal(metadata.models['stream-network'].upstreamStatus['stream-reset'].failureClass,'network','pre-response SSE transport failure must not be mislabeled as server');
  start=seen.length;r=await call('stream-late',{stream:true});assert.equal(r.status,200);assert.match(r.text,/started/);assert.equal(seen.slice(start).length,1,'post-start SSE error must not replay');
  metadata=JSON.parse(fs.readFileSync(path.join(dir,'metadata.json')));assert.equal(metadata.models['stream-pre'].upstreamStatus['stream-one'].status,'limited');assert.equal(metadata.models['stream-late'].upstreamStatus['late-one'].status,'limited');

  await new Promise(resolve=>setTimeout(resolve,30));const errorLogs=await(await fetch(`http://127.0.0.1:${port}/api/logs/errors?requestId=${r.headers['x-cline-request-id']}`)).json();assert.equal(errorLogs.items[0].errorScope,'provider');
  const unknownLogs=await(await fetch(`http://127.0.0.1:${port}/api/logs/errors?requestedModel=unknown-429`)).json();assert.equal(unknownLogs.items[0].errorScope,'unknown');assert.equal(unknownLogs.items[0].scopeEvidence,'ambiguous_rate_limit');assert.equal(unknownLogs.items[0].healthAction,'cooldown');assert.equal(unknownLogs.items[0].responseContentType,'text/html');assert.equal(unknownLogs.items[0].responseBytes,Buffer.byteLength(html429));assert.equal(JSON.stringify(unknownLogs).includes(html429),false);assert.equal(JSON.stringify(unknownLogs).includes('super-secret-prompt'),false);
  const accountLogs=await(await fetch(`http://127.0.0.1:${port}/api/logs/errors?requestedModel=account-429`)).json();assert.equal(accountLogs.items[0].errorScope,'account');assert.equal(accountLogs.items[0].healthAction,'none');assert.equal(accountLogs.items[0].accountAction,'cooldown');assert.equal(JSON.stringify(accountLogs).includes('super-secret-prompt'),false);

  await stop(running.child);running.child=null;running=await startSwitcher(null,dir);start=seen.length;assert.equal((await call('unknown-429')).status,200);assert.deepEqual(seen.slice(start).map(x=>x.only),['fireworks'],'provider cooldown must survive restart');
});
