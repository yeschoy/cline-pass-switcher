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
        res.writeHead(429, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'rate limited', status: 429 } }));
      }
      if (body.model === 'wrapped-cooldown-model' && auth === 'Bearer key-a') {
        res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ data: { error: { message: 'wrapped rate limited', status: 429 } } }));
      }
      if (body.model === 'wrapped-sse-error-model' && body.stream && auth === 'Bearer key-a') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        return res.end('data: {"data":{"error":{"message":"wrapped stream limited","status":429}}}\n\n');
      }
      if (body.model === 'post-start-wrapped-sse-error-model' && body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: {"choices":[{"delta":{"content":"started"}}]}\n\n');
        return setTimeout(() => res.end('data: {"data":{"error":{"message":"late wrapped stream limited","status":429}}}\n\ndata: [DONE]\n\n'), 5);
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
  assert.match(postStartWrapped.text, /late wrapped stream limited/);
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
  const after = await (await fetch(`http://127.0.0.1:${switchPort}/api/accounts`)).json();
  assert.ok(after.accounts.every((a) => a.activeCount === 0));

  // A downstream disconnect must abort the in-flight native request, stop supplier failover, and release its account lease.
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

test('new scheduling modes, account fields, model aliases and independent logs', async (t) => {
  const seen = [];
  let coolFailures = 1;
  const mock = http.createServer((req, res) => {
    const chunks=[]; req.on('data',(c)=>chunks.push(c)); req.on('end',()=>{
      const body=JSON.parse(Buffer.concat(chunks).toString()||'{}'); seen.push({ auth:req.headers.authorization, headers:req.headers, body });
      if (body.model === 'cool' && req.headers.authorization === 'Bearer ka' && coolFailures-- > 0) { res.writeHead(429, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'limited' } })); }
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

test('account HTTP proxy is used and proxy failure never falls back to direct', async (t) => {
  let upstreamHits=0, connects=0;
  const upstream=http.createServer((req,res)=>{upstreamHits++;req.resume();req.on('end',()=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:'OK'}}]}));});});
  const upstreamPort=await listen(upstream);
  const proxy=http.createServer();
  proxy.on('connect',(req,client,head)=>{connects++;const [host,port]=req.url.split(':');const target=net.connect(Number(port),host,()=>{client.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)target.write(head);target.pipe(client);client.pipe(target);});target.on('error',()=>client.destroy());});
  const proxyPort=await listen(proxy);const socket=http.createServer();const switchPort=await listen(socket);await close(socket);
  const config={port:switchPort,upstreamBase:`http://127.0.0.1:${upstreamPort}`,accountMode:'single',concurrencyWaitMs:0,accounts:[{id:'a',name:'A',key:'ka',enabled:true,proxyUrl:`http://127.0.0.1:${proxyPort}`,perModel:{}}],knownModels:['cline-pass/test'],perModel:{},accountErrorRules:{}};
  const running=await startSwitcher(config);t.after(async()=>{await stop(running.child);await close(proxy);await close(upstream);fs.rmSync(running.dir,{recursive:true,force:true});});
  const ok=await rawJson(switchPort,'/v1/chat/completions',{model:'cline-pass/test',messages:[]});assert.equal(ok.status,200);assert.equal(connects,1);assert.equal(upstreamHits,1);
  const accounts=(await (await fetch(`http://127.0.0.1:${switchPort}/api/accounts`)).json()).accounts;
  const spare=http.createServer();const deadPort=await listen(spare);await close(spare);
  accounts[0].proxyUrl=`http://user:password@127.0.0.1:${deadPort}`;
  assert.equal((await rawJson(switchPort,'/api/accounts',{accounts,mode:'single',active:0,concurrencyWaitMs:0,accountErrorRules:{}})).status,200);
  const failed=await rawJson(switchPort,'/v1/chat/completions',{model:'cline-pass/test',messages:[]});assert.equal(failed.status,502);assert.equal(upstreamHits,1,'a failed configured proxy must not retry direct');
  await new Promise(r=>setTimeout(r,20));
  const logs=await (await fetch(`http://127.0.0.1:${switchPort}/api/logs/errors?category=proxy`)).json();assert.ok(logs.items.some(x=>x.category==='proxy'));assert.equal(JSON.stringify(logs).includes('password'),false);
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
