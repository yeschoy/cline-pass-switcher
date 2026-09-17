import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
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
      res.on('end', () => finish(resolve, { status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString() }));
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
  return { dir, child, output: () => output };
}

const stop = (child) => new Promise((resolve) => { child.once('exit', resolve); child.kill('SIGTERM'); setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 1000).unref(); });

function disconnectRequest(port, body, afterData = false, marker = '') {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
      if (!afterData) return;
      let received = '';
      res.on('data', (chunk) => {
        received += chunk.toString();
        if (!marker || received.includes(marker)) { req.destroy(); resolve(); }
      });
    });
    req.on('error', (error) => { if (error.code !== 'ECONNRESET') reject(error); });
    req.end(JSON.stringify(body));
    if (!afterData) setTimeout(() => { req.destroy(); resolve(); }, 20);
  });
}

async function waitForRequestLogs(port, count) {
  let page;
  for (let i = 0; i < 100; i++) {
    page = await (await fetch(`http://127.0.0.1:${port}/api/logs/requests?limit=200`)).json();
    if ((page.items || []).length >= count) return page.items;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return page?.items || [];
}

test('API compatibility, message boundary and request outcomes are explicit', async (t) => {
  const seen = [];
  const mock = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      seen.push(body);
      if (body.model === 'done-close') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n');
        return;
      }
      if (body.model === 'stream-cancel') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: {"choices":[{"delta":{"content":"started"}}],"usage":{"prompt_tokens":99,"completion_tokens":1,"total_tokens":100}}\n\n');
        return;
      }
      if (body.model === 'nonstream-cancel') return;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }));
    });
  });
  const upstreamPort = await listen(mock);
  const switchPort = await new Promise(async (resolve) => { const server = http.createServer(); const port = await listen(server); await close(server); resolve(port); });
  const config = { port: switchPort, upstreamBase: `http://127.0.0.1:${upstreamPort}`, accountMode: 'single', accounts: [{ id: 'a', name: 'A', key: 'key-a', enabled: true, maxConcurrent: 1, perModel: {} }], knownModels: ['valid-image', 'valid-tool', 'valid-function-call', 'done-close', 'stream-cancel', 'nonstream-cancel'], perModel: {}, accountErrorRules: { '502': { action: 'ban' } } };
  const running = await startSwitcher(config);
  t.after(async () => { await stop(running.child); await close(mock); fs.rmSync(running.dir, { recursive: true, force: true }); });

  const beforeUnsupported = seen.length;
  const unsupported = await rawJson(switchPort, '/v1/responses', { model: 'ignored' });
  assert.equal(unsupported.status, 501);
  assert.deepEqual(unsupported.json, { error: { message: 'OpenAI Responses API is not supported; use /v1/chat/completions instead', type: 'unsupported_api', param: null, code: 'unsupported_api' } });
  assert.equal(seen.length, beforeUnsupported, 'unsupported API must not reach account routing or upstream');

  const invalidContents = ['', '   ', null, [], [{ type: 'text', text: '  ' }], [{}], [{ type: 'image_url', image_url: false }], undefined];
  for (const [index, content] of invalidContents.entries()) {
    const message = { role: 'user' };
    if (content !== undefined) message.content = content;
    const response = await rawJson(switchPort, '/v1/chat/completions', { model: 'invalid-boundary', messages: [message] });
    assert.equal(response.status, 400, `invalid content case ${index}`);
    assert.deepEqual(response.json, { error: { message: 'messages.0.content must not be empty', type: 'invalid_request_error', param: 'messages.0.content', code: 'invalid_request_error' } });
    assert.equal(response.text.includes('invalid-boundary'), false, 'validation response must contain only the safe field path');
  }
  assert.equal(seen.length, beforeUnsupported, 'invalid messages must be rejected before upstream');

  assert.equal((await rawJson(switchPort, '/v1/chat/completions', { model: 'valid-image', messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.test/image.png' } }] }] })).status, 200);
  assert.equal((await rawJson(switchPort, '/v1/chat/completions', { model: 'valid-tool', messages: [{ role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'lookup', arguments: '{}' } }] }] })).status, 200);
  assert.equal((await rawJson(switchPort, '/v1/chat/completions', { model: 'valid-function-call', messages: [{ role: 'assistant', content: '', function_call: { name: 'lookup', arguments: '{}' } }] })).status, 200);

  await disconnectRequest(switchPort, { model: 'done-close', stream: true, messages: [{ role: 'user', content: 'complete' }] }, true, '[DONE]');
  await disconnectRequest(switchPort, { model: 'stream-cancel', stream: true, messages: [{ role: 'user', content: 'cancel' }] }, true);
  await disconnectRequest(switchPort, { model: 'nonstream-cancel', messages: [{ role: 'user', content: 'cancel' }] });

  const logs = await waitForRequestLogs(switchPort, 6);
  assert.equal(logs.length, 6, 'each accepted request must finalize exactly once');
  for (const model of ['valid-image', 'valid-tool', 'valid-function-call', 'done-close', 'stream-cancel', 'nonstream-cancel']) {
    assert.equal(logs.filter((item) => item.requestedModel === model).length, 1, `${model} must have one final request record`);
  }
  const byModel = new Map(logs.map((item) => [item.requestedModel, item]));
  assert.equal(byModel.get('done-close')?.status, 200); assert.equal(byModel.get('done-close')?.result, 'success');
  assert.equal(byModel.get('stream-cancel')?.status, 499); assert.equal(byModel.get('stream-cancel')?.result, 'client_cancelled'); assert.equal(byModel.get('stream-cancel')?.errorCategory, null);
  assert.equal(byModel.get('nonstream-cancel')?.status, 499); assert.equal(byModel.get('nonstream-cancel')?.result, 'client_cancelled'); assert.equal(byModel.get('nonstream-cancel')?.errorCategory, null);
  assert.equal((await (await fetch(`http://127.0.0.1:${switchPort}/api/logs/requests?result=client_cancelled`)).json()).items.length, 2);
  assert.equal((await (await fetch(`http://127.0.0.1:${switchPort}/api/logs/errors`)).json()).items.length, 0, 'client cancellation must not create attempt errors');
  const statistics = await (await fetch(`http://127.0.0.1:${switchPort}/api/statistics`)).json();
  assert.equal(statistics.lifetime.global.requests, 6); assert.equal(statistics.lifetime.global.errors, 0);
  assert.equal(statistics.lifetime.global.usageRequests, 0); assert.equal(statistics.lifetime.global.inputTokens, 0, 'usage observed before cancellation must be discarded');
  assert.equal(statistics.accounts[0].health.results, 4, 'successful requests count for health; cancellations do not');
  const accounts = (await (await fetch(`http://127.0.0.1:${switchPort}/api/accounts`)).json()).accounts;
  assert.equal(accounts[0].activeCount, 0);
  assert.notEqual(accounts[0].state?.banned, true, 'abort-generated transport errors must not apply account rules');
});

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
  const diagnosticRequests = await (await fetch(`http://127.0.0.1:${switchPort}/api/logs/requests?requestedModel=long-sse-error-model`)).json();
  assert.equal(diagnosticRequests.items[0].result, 'failed');
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
  // Ordinary full-list save must round-trip a combined bulk/drawer/scheduling draft.
  const draftAccounts=accounts.map((a,i)=>({...a,maxConcurrent:i===0?100000:0,
    ...(i===0?{note:'pending drawer note',proxyUrl:'http://127.0.0.1:1/',perModel:{'cline-pass/target':{upstream:'Mock',upstreams:['Mock'],exclude:[],pinMode:'preferred',sort:null,maxRetries:null}}}:{})}));
  const pipeline={quotaPool:false,excludeUnhealthy:true,healthSort:true,sticky:false,order:['healthSort','excludeUnhealthy','quotaPool','sticky'],cachePoolSize:0};
  const rules={429:{action:'ignore'}};
  assert.equal((await rawJson(switchPort,'/api/accounts',{accounts:draftAccounts,mode:'sticky',active:1,concurrencyWaitMs:987,accountErrorRules:rules,accountPipeline:pipeline})).status,200);
  const roundTrip=await(await fetch(`http://127.0.0.1:${switchPort}/api/accounts`)).json();
  for(let i=0;i<draftAccounts.length;i++)for(const field of ['id','name','note','key','enabled','maxConcurrent','weight','priority','proxyUrl','headers'])assert.deepEqual(roundTrip.accounts[i][field],draftAccounts[i][field],`round-trip ${i}.${field}`);
  assert.deepEqual(roundTrip.accounts[0].perModel,draftAccounts[0].perModel);
  assert.deepEqual(roundTrip.accounts[1].perModel,draftAccounts[1].perModel);
  assert.equal(roundTrip.mode,'sticky');assert.equal(roundTrip.active,1);assert.equal(roundTrip.concurrencyWaitMs,987);
  assert.deepEqual(roundTrip.accountErrorRules,rules);assert.deepEqual(roundTrip.accountPipeline,pipeline);
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
  await new Promise(r=>setTimeout(r,20));let logs=await(await fetch(`http://127.0.0.1:${switchPort}/api/logs/requests?requestedModel=serve`)).json();assert.ok(logs.items[0].pipelineSteps.includes('health-filtered'));assert.equal(JSON.stringify(logs).includes('"bad"'),false,'pipeline logs contain no exact short key value');assert.equal(JSON.stringify(logs).includes('disabled-secret'),false,'pipeline logs contain no disabled account key');assert.equal(seen.includes('Bearer disabled-secret'),false,'disabled accounts never enter pipeline fallback');
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
    if(body.model==='switch'&&auth==='Bearer key-a'){res.writeHead(429,{'Content-Type':'application/json'});return res.end(JSON.stringify({error:{message:'limited',status:429}}));}
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

const PIPELINE_STEP_ORDER = ['excludeUnhealthy','quotaPool','healthSort','sticky'];
const pipelinePermutations = (items) => items.length < 2 ? [items] : items.flatMap((item,index) => pipelinePermutations(items.filter((_,i)=>i!==index)).map(rest=>[item,...rest]));

test('pipeline order migrates, validates atomically, preserves old-client order and round-trips every permutation', async (t) => {
  const port=await unusedPort(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'cps-pipeline-order-'));
  const config={port,accounts:[{id:'a',name:'A',key:'ka',enabled:true,perModel:{}}],accountMode:'single',activeAccount:0,concurrencyWaitMs:0,accountErrorRules:{},accountPipeline:{quotaPool:false,excludeUnhealthy:false,healthSort:false,sticky:false},knownModels:['m'],perModel:{}};
  let running=await startSwitcher(config,dir);t.after(async()=>{if(running?.child)await stop(running.child);fs.rmSync(dir,{recursive:true,force:true});});
  let view=await(await fetch(`http://127.0.0.1:${port}/api/accounts`)).json();assert.deepEqual(view.accountPipeline.order,PIPELINE_STEP_ORDER,'legacy configuration receives the compatibility order');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir,'config.json'))).accountPipeline.order,PIPELINE_STEP_ORDER,'migration is persisted');
  const reverse=[...PIPELINE_STEP_ORDER].reverse(),base={quotaPool:false,excludeUnhealthy:false,healthSort:false,sticky:false};
  assert.equal((await rawJson(port,'/api/accounts',{accounts:view.accounts,mode:view.mode,active:view.active,concurrencyWaitMs:view.concurrencyWaitMs,accountErrorRules:view.accountErrorRules,accountPipeline:{...base,order:reverse}})).status,200);
  view=await(await fetch(`http://127.0.0.1:${port}/api/accounts`)).json();
  assert.equal((await rawJson(port,'/api/accounts',{accounts:view.accounts,mode:view.mode,active:view.active,concurrencyWaitMs:view.concurrencyWaitMs,accountErrorRules:view.accountErrorRules,accountPipeline:base})).status,200,'old client may omit only order');
  view=await(await fetch(`http://127.0.0.1:${port}/api/accounts`)).json();assert.deepEqual(view.accountPipeline.order,reverse,'old client preserves the server order');
  for(const order of pipelinePermutations(PIPELINE_STEP_ORDER)){
    const response=await rawJson(port,'/api/accounts',{accounts:view.accounts,mode:'single',active:0,concurrencyWaitMs:0,accountErrorRules:{},accountPipeline:{...base,order}});assert.equal(response.status,200,order.join(','));
    view=await(await fetch(`http://127.0.0.1:${port}/api/accounts`)).json();assert.deepEqual(view.accountPipeline.order,order);
  }
  const configPath=path.join(dir,'config.json'),before=fs.readFileSync(configPath);
  const invalidOrders=[null,{},'sticky',[],['sticky'],['sticky','sticky','quotaPool','healthSort'],['sticky','quotaPool','healthSort','unknown'],[...PIPELINE_STEP_ORDER,'sticky']];
  for(const order of invalidOrders){const response=await rawJson(port,'/api/accounts',{accounts:view.accounts,mode:'single',active:0,concurrencyWaitMs:0,accountErrorRules:{},accountPipeline:{...base,order}});assert.equal(response.status,400);assert.deepEqual(fs.readFileSync(configPath),before);}
  const incomplete=await rawJson(port,'/api/accounts',{accounts:view.accounts,mode:'single',active:0,concurrencyWaitMs:0,accountErrorRules:{},accountPipeline:{quotaPool:false,excludeUnhealthy:false,healthSort:false,order:PIPELINE_STEP_ORDER}});assert.equal(incomplete.status,400);assert.deepEqual(fs.readFileSync(configPath),before);
  const finalOrder=view.accountPipeline.order;await stop(running.child);running.child=null;running=await startSwitcher(null,dir);view=await(await fetch(`http://127.0.0.1:${port}/api/accounts`)).json();assert.deepEqual(view.accountPipeline.order,finalOrder,'saved order survives restart');
  await stop(running.child);running.child=null;const persisted=JSON.parse(fs.readFileSync(configPath));persisted.accountPipeline.order=['sticky'];fs.writeFileSync(configPath,JSON.stringify(persisted));running=await startSwitcher(null,dir);view=await(await fetch(`http://127.0.0.1:${port}/api/accounts`)).json();assert.deepEqual(view.accountPipeline.order,PIPELINE_STEP_ORDER,'invalid startup order safely normalizes to the compatibility default');
});

test('cache pool configuration migrates, validates atomically, preserves old clients and survives restart', async (t) => {
  const port=await unusedPort(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'cps-cache-pool-config-')),configPath=path.join(dir,'config.json');
  const pipeline={quotaPool:false,excludeUnhealthy:false,healthSort:false,sticky:false,order:PIPELINE_STEP_ORDER};
  let running=await startSwitcher({port,accounts:[{id:'a',name:'A',key:'ka',enabled:true,perModel:{}}],accountMode:'sticky',activeAccount:0,concurrencyWaitMs:0,accountErrorRules:{},accountPipeline:pipeline,knownModels:['m'],perModel:{}},dir);
  t.after(async()=>{if(running?.child)await stop(running.child);fs.rmSync(dir,{recursive:true,force:true});});
  let view=await(await fetch(`http://127.0.0.1:${port}/api/accounts`)).json();
  assert.equal(view.accountPipeline.cachePoolSize,0,'legacy configuration defaults cache pool off');
  assert.equal(JSON.parse(fs.readFileSync(configPath)).accountPipeline.cachePoolSize,0,'migration persists the disabled default');
  assert.equal((await rawJson(port,'/api/accounts',{accounts:view.accounts,mode:'sticky',active:0,concurrencyWaitMs:5000,accountErrorRules:{},accountPipeline:{...pipeline,cachePoolSize:2}})).status,200);
  view=await(await fetch(`http://127.0.0.1:${port}/api/accounts`)).json();assert.equal(view.accountPipeline.cachePoolSize,2);
  assert.equal((await rawJson(port,'/api/accounts',{accounts:view.accounts,mode:'sticky',active:0,concurrencyWaitMs:5000,accountErrorRules:{},accountPipeline:pipeline})).status,200,'old client may omit cachePoolSize');
  view=await(await fetch(`http://127.0.0.1:${port}/api/accounts`)).json();assert.equal(view.accountPipeline.cachePoolSize,2,'old-client save preserves current cache pool size');
  assert.equal((await rawJson(port,'/api/accounts',{accounts:view.accounts,mode:'roundrobin',active:0,concurrencyWaitMs:5000,accountErrorRules:{},accountPipeline:{...pipeline,cachePoolSize:2}})).status,200);
  view=await(await fetch(`http://127.0.0.1:${port}/api/accounts`)).json();assert.equal(view.accounts[0].cachePoolRole,null,'cache pool is inactive without sticky mode or step');
  assert.equal((await rawJson(port,'/api/accounts',{accounts:view.accounts,mode:'roundrobin',active:0,concurrencyWaitMs:5000,accountErrorRules:{},accountPipeline:{...pipeline,sticky:true,cachePoolSize:2}})).status,200);
  view=await(await fetch(`http://127.0.0.1:${port}/api/accounts`)).json();assert.equal(view.accounts[0].cachePoolRole,'active','explicit sticky step activates the cache pool outside sticky account mode');
  assert.equal((await rawJson(port,'/api/accounts',{accounts:view.accounts,mode:'sticky',active:0,concurrencyWaitMs:5000,accountErrorRules:{},accountPipeline:{...pipeline,cachePoolSize:2}})).status,200);
  view=await(await fetch(`http://127.0.0.1:${port}/api/accounts`)).json();
  assert.equal(fs.readFileSync(configPath,'utf8').includes('cachePoolRole'),false,'runtime cache roles are never persisted');
  const before=fs.readFileSync(configPath);
  for(const cachePoolSize of [-1,100001,1.5,'2',null,true]){
    const response=await rawJson(port,'/api/accounts',{accounts:view.accounts,mode:'sticky',active:0,concurrencyWaitMs:5000,accountErrorRules:{},accountPipeline:{...pipeline,cachePoolSize}});
    assert.equal(response.status,400,String(cachePoolSize));assert.deepEqual(fs.readFileSync(configPath),before);
  }
  const unknown=await rawJson(port,'/api/accounts',{accounts:view.accounts,mode:'sticky',active:0,concurrencyWaitMs:5000,accountErrorRules:{},accountPipeline:{...pipeline,cachePoolSize:2,cacheSecret:'forbidden'}});
  assert.equal(unknown.status,400);assert.deepEqual(fs.readFileSync(configPath),before);
  await stop(running.child);running.child=null;running=await startSwitcher(null,dir);view=await(await fetch(`http://127.0.0.1:${port}/api/accounts`)).json();assert.equal(view.accountPipeline.cachePoolSize,2,'saved cache pool survives restart');
  await stop(running.child);running.child=null;const persisted=JSON.parse(fs.readFileSync(configPath));persisted.accountPipeline.cachePoolSize=-1;fs.writeFileSync(configPath,JSON.stringify(persisted));running=await startSwitcher(null,dir);view=await(await fetch(`http://127.0.0.1:${port}/api/accounts`)).json();assert.equal(view.accountPipeline.cachePoolSize,0,'invalid startup value safely disables the feature');
});

test('cache pool routing stays dormant without sticky and mode changes withdraw quota ownership', async (t) => {
  let quotaHits=0,quotaClosed=0;const held=[];
  const upstream=http.createServer((req,res)=>{if(req.method==='GET'&&req.url.endsWith('/users/me/plan/usage-limits')){quotaHits++;let closed=false;const done=()=>{if(closed)return;closed=true;quotaClosed++;};res.once('finish',done);res.once('close',done);res.once('error',done);held.push(res);req.resume();return;}req.resume();req.on('end',()=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:'OK'}}]}));});});
  const upstreamPort=await listen(upstream),port=await unusedPort(),pipeline={quotaPool:false,excludeUnhealthy:false,healthSort:false,sticky:false,order:PIPELINE_STEP_ORDER,cachePoolSize:1};
  const running=await startSwitcher({port,upstreamBase:`http://127.0.0.1:${upstreamPort}`,accounts:[{id:'a',name:'A',key:'ka',enabled:true,perModel:{}}],accountMode:'roundrobin',activeAccount:0,concurrencyWaitMs:0,knownModels:['m'],perModel:{},accountErrorRules:{},accountPipeline:pipeline},null,{NODE_ENV:'test',CLINE_PASS_TEST_QUOTA_TIMEOUT_MS:'1000',CLINE_PASS_TEST_QUOTA_SUCCESS_MS:'500'});
  t.after(async()=>{await stop(running.child);for(const res of held)res.destroy();await close(upstream);fs.rmSync(running.dir,{recursive:true,force:true});});
  await new Promise(resolve=>setTimeout(resolve,80));assert.equal(quotaHits,0,'a configured cache pool is dormant outside sticky mode/step');
  assert.equal((await rawJson(port,'/v1/chat/completions',{model:'m',messages:[]})).status,200);
  const legacyLog=await waitUntil(async()=>{const page=await(await fetch(`http://127.0.0.1:${port}/api/logs/requests?requestedModel=m&limit=1`)).json();return page.items[0];});
  assert.equal(legacyLog.selectionReason,'roundrobin-next');assert.deepEqual(legacyLog.pipelineSteps,[]);assert.equal(legacyLog.cachePoolTier,null);
  let view=await(await fetch(`http://127.0.0.1:${port}/api/accounts`)).json();assert.equal(view.accounts[0].cachePoolRole,null);
  assert.equal((await rawJson(port,'/api/accounts',{accounts:view.accounts,mode:'sticky',active:0,concurrencyWaitMs:0,accountErrorRules:{},accountPipeline:pipeline})).status,200);
  await waitUntil(()=>quotaHits===1);view=await(await fetch(`http://127.0.0.1:${port}/api/accounts`)).json();assert.equal(view.accounts[0].cachePoolRole,'active');
  assert.equal((await rawJson(port,'/api/accounts',{accounts:view.accounts,mode:'roundrobin',active:0,concurrencyWaitMs:0,accountErrorRules:{},accountPipeline:pipeline})).status,200);
  await waitUntil(()=>quotaClosed===1);const hitsAfterDisable=quotaHits;await new Promise(resolve=>setTimeout(resolve,100));assert.equal(quotaHits,hitsAfterDisable,'obsolete cache-pool quota callbacks cannot rearm after mode disables the pool');
});

test('cache pool selects a stable priority/id active set, ignores soft layers and replaces hard-state members', async (t) => {
  const seen=[];const upstream=http.createServer((req,res)=>{if(req.method==='GET'){res.writeHead(500,{'Content-Type':'application/json'});return res.end('{}');}req.resume();req.on('end',()=>{seen.push(req.headers.authorization);res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:'OK'}}]}));});});
  const upstreamPort=await listen(upstream),port=await unusedPort(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'cps-cache-pool-selection-')),now=Date.now(),minute=Math.floor(now/60000),secret='cache-pool-stable-secret';
  const accounts=[
    {id:'c',name:'C',key:'key-c',enabled:true,priority:2,maxConcurrent:0,perModel:{}},
    {id:'b',name:'B',key:'key-b',enabled:true,priority:1,maxConcurrent:0,perModel:{}},
    {id:'a',name:'A',key:'key-a',enabled:true,priority:1,maxConcurrent:0,perModel:{}},
    {id:'d',name:'D',key:'key-d',enabled:true,priority:3,maxConcurrent:0,perModel:{}},
  ];
  const quota=(percentUsed)=>({snapshot:{limits:{five_hour:{percentUsed},weekly:{percentUsed},monthly:{percentUsed}},fetchedAt:now},lastAttemptAt:now,lastSuccessAt:now,errorCategory:null});
  const writeMetadata=({reserveB=false,unhealthyB=false}={})=>fs.writeFileSync(path.join(dir,'metadata.json'),JSON.stringify({models:{},history:[],accountStates:{},routingSecret:secret,statistics:{version:1,lifetime:{global:emptyAggregateFixture(),accounts:{}},minuteBuckets:[{minute,global:emptyAggregateFixture(),accounts:{},health:{a:{...emptyHealthFixture(),results:5},b:{...emptyHealthFixture(),results:5,penaltyUnits:unhealthyB?30:25},c:emptyHealthFixture(),d:emptyHealthFixture()}}],recentCoverage:{droppedAccountMinuteCells:0,accountIncompleteAt:{}},migration:{legacyStatsMigratedAt:now,legacyRequests:0,accountLegacyRequests:{},ambiguousNames:0,unmappedNames:0}},accountQuotas:{a:quota(10),b:quota(reserveB?95:85),d:quota(95)}}));
  writeMetadata();
  let running=await startSwitcher({port,upstreamBase:`http://127.0.0.1:${upstreamPort}`,accounts,accountMode:'sticky',activeAccount:0,concurrencyWaitMs:0,knownModels:['m'],perModel:{},accountErrorRules:{},accountPipeline:{quotaPool:false,excludeUnhealthy:false,healthSort:false,sticky:false,order:PIPELINE_STEP_ORDER,cachePoolSize:2}},dir,{NODE_ENV:'test'});
  t.after(async()=>{if(running?.child)await stop(running.child);await close(upstream);fs.rmSync(dir,{recursive:true,force:true});});
  const roles=async()=>Object.fromEntries((await(await fetch(`http://127.0.0.1:${port}/api/accounts`)).json()).accounts.map(account=>[account.id,account.cachePoolRole]));
  assert.deepEqual(await roles(),{c:'standby',b:'active',a:'active',d:'standby'},'priority then stable id chooses the active set despite input order, warm quota and degraded health');
  assert.ok(['A','B'].includes((await rawJson(port,'/v1/chat/completions',{model:'m',messages:[]})).headers['x-cline-account']),'requests without identity remain inside the active pool');
  const stableBody={model:'m',messages:[{role:'user',content:'stable cache-pool opening'}]};
  const first=await rawJson(port,'/v1/chat/completions',stableBody);const firstAccount=first.headers['x-cline-account'];assert.ok(['A','B'].includes(firstAccount));
  for(let i=0;i<12;i++){const response=await rawJson(port,'/v1/chat/completions',{model:'m',messages:[{role:'user',content:`session-${i}`}]});assert.ok(['A','B'].includes(response.headers['x-cline-account']),'standby must not receive ordinary traffic');}
  assert.equal((await rawJson(port,'/v1/chat/completions',stableBody)).headers['x-cline-account'],firstAccount,'message HMAC remains stable inside an unchanged active set');
  await stop(running.child);running.child=null;const configPath=path.join(dir,'config.json'),saved=JSON.parse(fs.readFileSync(configPath));saved.accounts.reverse();fs.writeFileSync(configPath,JSON.stringify(saved));writeMetadata();running=await startSwitcher(null,dir,{NODE_ENV:'test'});
  assert.deepEqual(await roles(),{d:'standby',a:'active',b:'active',c:'standby'});assert.equal((await rawJson(port,'/v1/chat/completions',stableBody)).headers['x-cline-account'],firstAccount,'account input order does not remap the active set or HRW winner');
  await stop(running.child);running.child=null;writeMetadata({reserveB:true});running=await startSwitcher(null,dir,{NODE_ENV:'test'});assert.deepEqual(await roles(),{d:'standby',a:'active',b:'standby',c:'active'},'reserve account is replaced by the next priority account');
  await stop(running.child);running.child=null;writeMetadata({unhealthyB:true});running=await startSwitcher(null,dir,{NODE_ENV:'test'});assert.deepEqual(await roles(),{d:'standby',a:'active',b:'standby',c:'active'},'explicitly unhealthy account is replaced while degraded remains eligible');
  assert.equal(seen.includes('Bearer key-d'),false,'reserve standby never receives normal traffic');
});

test('cache pool immediately uses safe standby when hard state leaves no active candidate', async (t) => {
  const upstream=http.createServer((req,res)=>{req.resume();req.on('end',()=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:'OK'}}]}));});});
  const upstreamPort=await listen(upstream),port=await unusedPort(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'cps-cache-pool-hard-fallback-')),now=Date.now();
  const accounts=['a','b'].map((id,index)=>({id,name:id.toUpperCase(),key:`key-${id}`,enabled:true,priority:index+1,maxConcurrent:1,perModel:{}}));
  const reserve={snapshot:{limits:{five_hour:{percentUsed:95},weekly:{percentUsed:95},monthly:{percentUsed:95}},fetchedAt:now},lastAttemptAt:now,lastSuccessAt:now,errorCategory:null};
  fs.writeFileSync(path.join(dir,'metadata.json'),JSON.stringify({models:{},history:[],accountStates:{},routingSecret:'hard-fallback-secret',stats:{},accountQuotas:{a:reserve,b:reserve}}));
  const running=await startSwitcher({port,upstreamBase:`http://127.0.0.1:${upstreamPort}`,accounts,accountMode:'sticky',activeAccount:0,concurrencyWaitMs:300,knownModels:['m'],perModel:{},accountErrorRules:{},accountPipeline:{quotaPool:false,excludeUnhealthy:false,healthSort:false,sticky:false,order:PIPELINE_STEP_ORDER,cachePoolSize:2}},dir,{NODE_ENV:'test',CLINE_PASS_TEST_QUOTA_SUCCESS_MS:'1000'});
  t.after(async()=>{await stop(running.child);await close(upstream);fs.rmSync(dir,{recursive:true,force:true});});
  const roles=await(await fetch(`http://127.0.0.1:${port}/api/accounts`)).json();assert.deepEqual(roles.accounts.map(account=>account.cachePoolRole),['standby','standby']);
  const started=Date.now(),response=await rawJson(port,'/v1/chat/completions',{model:'m',messages:[]},{'Session-Id':'all-reserve'}),elapsed=Date.now()-started;
  assert.equal(response.status,200);assert.ok(elapsed<200,`hard-state fallback waited ${elapsed}ms instead of bypassing the ${300}ms capacity wait`);
  const log=await waitUntil(async()=>{const page=await(await fetch(`http://127.0.0.1:${port}/api/logs/requests?requestedModel=m&limit=1`)).json();return page.items[0];});
  assert.equal(log.selectionReason,'cache-pool-standby-overflow');assert.equal(log.preferredAccountId,null);assert.equal(log.cachePoolTier,'standby');assert.equal(log.cachePoolFallback,true);
});

test('cache pool waits for all active accounts, overflows to standby safely and returns 429 without standby', async (t) => {
  const seen=[];const upstream=http.createServer((req,res)=>{if(req.method==='GET'){res.writeHead(500,{'Content-Type':'application/json'});return res.end('{}');}req.resume();req.on('end',()=>{seen.push({authorization:req.headers.authorization,at:Date.now()});setTimeout(()=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:'OK'}}]}));},140);});});
  const upstreamPort=await listen(upstream),port=await unusedPort(),accounts=[{id:'a',name:'A',key:'key-a',enabled:true,priority:1,maxConcurrent:1,perModel:{}},{id:'b',name:'B',key:'key-b',enabled:true,priority:2,maxConcurrent:1,perModel:{}},{id:'c',name:'C',key:'key-c',enabled:true,priority:3,maxConcurrent:1,perModel:{}}];
  const running=await startSwitcher({port,upstreamBase:`http://127.0.0.1:${upstreamPort}`,accounts,accountMode:'sticky',activeAccount:0,concurrencyWaitMs:40,knownModels:['slow'],perModel:{},accountErrorRules:{},accountPipeline:{quotaPool:false,excludeUnhealthy:false,healthSort:false,sticky:false,order:PIPELINE_STEP_ORDER,cachePoolSize:2}},null,{NODE_ENV:'test'});
  t.after(async()=>{await stop(running.child);await close(upstream);fs.rmSync(running.dir,{recursive:true,force:true});});
  const headers={'Session-Id':'cache-capacity-session'},body={model:'slow',messages:[]};
  const first=rawJson(port,'/v1/chat/completions',body,headers);await waitUntil(()=>seen.length===1);
  const second=rawJson(port,'/v1/chat/completions',body,headers);await waitUntil(()=>seen.length===2);
  const overflowStarted=Date.now(),third=rawJson(port,'/v1/chat/completions',body,headers);await waitUntil(()=>seen.length===3);assert.ok(seen[2].at-overflowStarted>=25,'standby must not be used before the active wait expires');
  const responses=await Promise.all([first,second,third]);assert.ok(responses.every(response=>response.status===200));assert.deepEqual(new Set(responses.slice(0,2).map(response=>response.headers['x-cline-account'])),new Set(['A','B']));assert.equal(responses[2].headers['x-cline-account'],'C');
  const logs=await waitUntil(async()=>{const page=await(await fetch(`http://127.0.0.1:${port}/api/logs/requests?requestedModel=slow&limit=20`)).json();return page.items.length>=3&&page.items;});
  const byReason=Object.fromEntries(logs.map(item=>[item.selectionReason,item]));assert.equal(byReason['cache-pool-active']?.cachePoolTier,'active');assert.equal(byReason['cache-pool-active-overflow']?.cachePoolTier,'active');assert.equal(byReason['cache-pool-standby-overflow']?.cachePoolTier,'standby');assert.equal(byReason['cache-pool-standby-overflow']?.cachePoolFallback,true);assert.equal(byReason['cache-pool-standby-overflow']?.cachePoolSize,2);
  const serialized=JSON.stringify(logs);assert.equal(serialized.includes('cache-capacity-session'),false);for(const secret of ['key-a','key-b','key-c'])assert.equal(serialized.includes(secret),false);
  let view=await(await fetch(`http://127.0.0.1:${port}/api/accounts`)).json();view.accounts.find(account=>account.id==='c').enabled=false;
  assert.equal((await rawJson(port,'/api/accounts',{accounts:view.accounts,mode:'sticky',active:0,concurrencyWaitMs:40,accountErrorRules:{},accountPipeline:view.accountPipeline})).status,200);
  seen.length=0;const heldA=rawJson(port,'/v1/chat/completions',body,headers);await waitUntil(()=>seen.length===1);const heldB=rawJson(port,'/v1/chat/completions',body,headers);await waitUntil(()=>seen.length===2);const blocked=await rawJson(port,'/v1/chat/completions',body,headers);assert.equal(blocked.status,429);assert.equal(blocked.headers['retry-after'],'1');await Promise.all([heldA,heldB]);
  view=await(await fetch(`http://127.0.0.1:${port}/api/accounts`)).json();assert.deepEqual(view.accounts.map(account=>account.activeCount),[0,0,0]);
});

test('missing and explicit all-false pipelines preserve all six mode sequences, reasons, capacity and lease release', async (t) => {
  let slowStarted=0;
  const upstream=http.createServer((req,res)=>{const chunks=[];req.on('data',c=>chunks.push(c));req.on('end',()=>{const body=JSON.parse(Buffer.concat(chunks).toString()||'{}');const reply=()=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:'OK'}}]}));};if(body.model==='slow'){slowStarted++;setTimeout(reply,80);}else reply();});}),upstreamPort=await listen(upstream);t.after(()=>close(upstream));
  const run=async(mode,explicit)=>{const port=await unusedPort(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'cps-legacy-equivalence-')),accounts=[{id:'a',name:'A',key:'ka',enabled:true,maxConcurrent:1,weight:1,priority:1,perModel:{}},{id:'b',name:'B',key:'kb',enabled:true,maxConcurrent:1,weight:3,priority:10,perModel:{}}],cfg={port,upstreamBase:`http://127.0.0.1:${upstreamPort}`,accountMode:mode,activeAccount:0,concurrencyWaitMs:0,accounts,knownModels:['fast','slow'],perModel:{},accountErrorRules:{}};if(explicit)cfg.accountPipeline={quotaPool:false,excludeUnhealthy:false,healthSort:false,sticky:false};fs.writeFileSync(path.join(dir,'metadata.json'),JSON.stringify({models:{},history:[],accountStates:{},routingSecret:'fixed-equivalence-secret',stats:{}}));const running=await startSwitcher(cfg,dir);try{const sequence=[];for(let i=0;i<8;i++){const r=await rawJson(port,'/v1/chat/completions',{model:'fast',messages:[]});sequence.push(r.headers['x-cline-account']);}let expectedSlowStarts=slowStarted+1;const p1=rawJson(port,'/v1/chat/completions',{model:'slow',messages:[]});await waitUntil(()=>slowStarted>=expectedSlowStarts);expectedSlowStarts++;const p2=rawJson(port,'/v1/chat/completions',{model:'slow',messages:[]});if(mode!=='single')await waitUntil(()=>slowStarted>=expectedSlowStarts);const p3=rawJson(port,'/v1/chat/completions',{model:'slow',messages:[]});const capacity=(await Promise.all([p1,p2,p3])).map(r=>({status:r.status,retry:r.headers['retry-after']||null}));const view=await(await fetch(`http://127.0.0.1:${port}/api/accounts`)).json(),logs=await waitUntil(async()=>{const page=await(await fetch(`http://127.0.0.1:${port}/api/logs/requests?requestedModel=fast&limit=20`)).json();return page.items.length>=8&&page;});return{sequence,capacity,reasons:logs.items.map(x=>x.selectionReason).sort(),active:view.accounts.map(x=>x.activeCount),pipeline:view.accountPipeline};}finally{await stop(running.child);fs.rmSync(dir,{recursive:true,force:true});}};
  for(const mode of ['single','roundrobin','sticky','least-connections','weighted-roundrobin','priority-failover']){const legacy=await run(mode,false),allFalse=await run(mode,true);assert.deepEqual(allFalse.sequence,legacy.sequence,`${mode} selection sequence changed`);assert.deepEqual(allFalse.capacity,legacy.capacity,`${mode} wait/429 behavior changed`);assert.deepEqual(allFalse.reasons,legacy.reasons,`${mode} diagnostic reason changed`);assert.deepEqual(allFalse.active,[0,0]);assert.deepEqual(legacy.active,[0,0]);assert.deepEqual(legacy.pipeline,{quotaPool:false,excludeUnhealthy:false,healthSort:false,sticky:false,order:['excludeUnhealthy','quotaPool','healthSort','sticky'],cachePoolSize:0});}
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

test('earlier pipeline stages dominate later quota, health and sticky refinements with implicit sticky compatibility', async (t) => {
  const seen=[];const upstream=http.createServer((req,res)=>{if(req.method==='GET'){res.writeHead(500,{'Content-Type':'application/json'});return res.end('{}');}const chunks=[];req.on('data',c=>chunks.push(c));req.on('end',()=>{seen.push(req.headers.authorization);res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:'OK'}}]}));});});
  const upstreamPort=await listen(upstream),port=await unusedPort(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'cps-pipeline-priority-')),secret='sortable-pipeline-secret',now=Date.now(),minute=Math.floor(now/60000);
  const accounts=[{id:'a',name:'A',key:'key-a',enabled:true,maxConcurrent:1,perModel:{}},{id:'b',name:'B',key:'key-b',enabled:true,maxConcurrent:1,perModel:{}}];
  const health={a:{...emptyHealthFixture(),results:1000,penaltyUnits:5000},b:{...emptyHealthFixture(),results:1000,penaltyUnits:0}},accountQuotas={a:{snapshot:{limits:{five_hour:{percentUsed:10},weekly:{percentUsed:10},monthly:{percentUsed:10}},fetchedAt:now},lastAttemptAt:now,lastSuccessAt:now,errorCategory:null},b:{snapshot:{limits:{five_hour:{percentUsed:99},weekly:{percentUsed:99},monthly:{percentUsed:99}},fetchedAt:now},lastAttemptAt:now,lastSuccessAt:now,errorCategory:null}};
  const statistics={version:1,lifetime:{global:emptyAggregateFixture(),accounts:{}},minuteBuckets:[{minute,global:emptyAggregateFixture(),accounts:{},health}],recentCoverage:{droppedAccountMinuteCells:0,accountIncompleteAt:{}},migration:{legacyStatsMigratedAt:now,legacyRequests:0,accountLegacyRequests:{},ambiguousNames:0,unmappedNames:0}};
  fs.writeFileSync(path.join(dir,'metadata.json'),JSON.stringify({models:{},history:[],accountStates:{},routingSecret:secret,statistics,accountQuotas}));
  const config={port,upstreamBase:`http://127.0.0.1:${upstreamPort}`,accounts,accountMode:'roundrobin',activeAccount:0,concurrencyWaitMs:0,knownModels:['m'],perModel:{},accountErrorRules:{},accountPipeline:{quotaPool:true,excludeUnhealthy:false,healthSort:true,sticky:false,order:PIPELINE_STEP_ORDER}};
  const running=await startSwitcher(config,dir,{NODE_ENV:'test'});t.after(async()=>{await stop(running.child);await close(upstream);fs.rmSync(dir,{recursive:true,force:true});});
  const savePipeline=async(mode,pipeline)=>{const view=await(await fetch(`http://127.0.0.1:${port}/api/accounts`)).json();const response=await rawJson(port,'/api/accounts',{accounts:view.accounts,mode,active:0,concurrencyWaitMs:0,accountErrorRules:{},accountPipeline:pipeline});assert.equal(response.status,200,response.text);};
  const request=(session)=>rawJson(port,'/v1/chat/completions',{model:'m',messages:[]},session?{'Session-Id':session}:{});
  const base={quotaPool:true,excludeUnhealthy:false,healthSort:true,sticky:false};
  await savePipeline('roundrobin',{...base,order:['quotaPool','healthSort','excludeUnhealthy','sticky']});assert.equal((await request()).headers['x-cline-account'],'A','quota-first chooses hot degraded A');
  await savePipeline('roundrobin',{...base,order:['healthSort','quotaPool','excludeUnhealthy','sticky']});assert.equal((await request()).headers['x-cline-account'],'B','health-first chooses available reserve B');
  const hmac=value=>crypto.createHmac('sha256',secret).update(String(value)).digest('hex');
  const stickyWinner=session=>{const fingerprint=hmac(`session\0${session}`);return [...accounts].sort((left,right)=>Buffer.compare(Buffer.from(hmac(`${fingerprint}\0${right.id}`),'hex'),Buffer.from(hmac(`${fingerprint}\0${left.id}`),'hex')))[0].id;};
  let sessionA,sessionB;for(let i=0;i<100&&(!sessionA||!sessionB);i++){const session=`pipeline-order-${i}`;(stickyWinner(session)==='a'?sessionA||=session:sessionB||=session);}assert.ok(sessionA&&sessionB);
  const explicit={...base,sticky:true};
  await savePipeline('roundrobin',{...explicit,order:['sticky','healthSort','quotaPool','excludeUnhealthy']});assert.equal((await request(sessionA)).headers['x-cline-account'],'A','sticky-first HRW dominates later health/quota groups');
  await savePipeline('roundrobin',{...explicit,order:['quotaPool','sticky','healthSort','excludeUnhealthy']});assert.equal((await request(sessionB)).headers['x-cline-account'],'A','sticky in the middle cannot cross the earlier quota group');
  await savePipeline('roundrobin',{...explicit,order:['healthSort','quotaPool','sticky','excludeUnhealthy']});assert.equal((await request(sessionA)).headers['x-cline-account'],'B','sticky-last cannot cross the earlier health group');
  await savePipeline('roundrobin',{...explicit,order:['sticky','healthSort','quotaPool','excludeUnhealthy']});assert.equal((await request()).headers['x-cline-account'],'B','sticky without identity is a no-op and later health grouping remains authoritative');
  await savePipeline('sticky',{...base,healthSort:false,order:['sticky','quotaPool','healthSort','excludeUnhealthy']});assert.equal((await request(sessionB)).headers['x-cline-account'],'A','sticky account mode injects affinity once after enabled configured stages');
  await new Promise(resolve=>setTimeout(resolve,20));const view=await(await fetch(`http://127.0.0.1:${port}/api/accounts`)).json();assert.deepEqual(view.accounts.map(account=>account.activeCount),[0,0]);
  const logs=await(await fetch(`http://127.0.0.1:${port}/api/logs/requests?limit=20`)).json(),serialized=JSON.stringify(logs);assert.equal(serialized.includes(sessionA),false);assert.equal(serialized.includes(sessionB),false);assert.equal(serialized.includes('key-a'),false);assert.equal(serialized.includes('key-b'),false);assert.ok(logs.items.every(item=>['ordinary','hot','warm','unknown','reserve'].includes(item.selectedQuotaPool)));
  assert.equal(seen.length,7,'each selection produces one provider-bound request without routing-time quota traffic in chat attempts');
});

test('all 24 pipeline orders execute as stable refinements and unhealthy fallback stays in the earliest prior group', async (t) => {
  const seen=[];
  const upstream=http.createServer((req,res)=>{if(req.method==='GET'){res.writeHead(500,{'Content-Type':'application/json'});return res.end('{}');}const chunks=[];req.on('data',chunk=>chunks.push(chunk));req.on('end',()=>{seen.push(req.headers.authorization);res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:'OK'}}]}));});});
  const upstreamPort=await listen(upstream),port=await unusedPort(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'cps-pipeline-permutations-')),secret='pipeline-permutation-secret',now=Date.now(),minute=Math.floor(now/60000);
  const accounts=[
    {id:'a',name:'A',key:'key-a',enabled:true,maxConcurrent:1,perModel:{}},
    {id:'b',name:'B',key:'key-b',enabled:true,maxConcurrent:1,perModel:{}},
    {id:'c',name:'C',key:'key-c',enabled:true,maxConcurrent:1,perModel:{}},
    {id:'d',name:'D',key:'key-d',enabled:true,maxConcurrent:1,perModel:{}},
  ];
  const healthFixture=(penalties)=>Object.fromEntries(Object.entries(penalties).map(([id,penaltyUnits])=>[id,{...emptyHealthFixture(),results:10000,penaltyUnits}]));
  const statisticsFixture=(health)=>({version:1,lifetime:{global:emptyAggregateFixture(),accounts:{}},minuteBuckets:[{minute,global:emptyAggregateFixture(),accounts:{},health}],recentCoverage:{droppedAccountMinuteCells:0,accountIncompleteAt:{}},migration:{legacyStatsMigratedAt:now,legacyRequests:0,accountLegacyRequests:{},ambiguousNames:0,unmappedNames:0}});
  const percentages={a:10,b:85,c:10,d:99},accountQuotas={};
  for(const [id,percentUsed] of Object.entries(percentages))accountQuotas[id]={snapshot:{limits:{five_hour:{percentUsed},weekly:{percentUsed},monthly:{percentUsed}},fetchedAt:now},lastAttemptAt:now,lastSuccessAt:now,errorCategory:null};
  fs.writeFileSync(path.join(dir,'metadata.json'),JSON.stringify({models:{},history:[],accountStates:{},routingSecret:secret,statistics:statisticsFixture(healthFixture({a:70000,b:10000,c:30000,d:0})),accountQuotas}));
  const flags={quotaPool:true,excludeUnhealthy:true,healthSort:true,sticky:true};
  let running=await startSwitcher({port,upstreamBase:`http://127.0.0.1:${upstreamPort}`,accounts,accountMode:'roundrobin',activeAccount:0,concurrencyWaitMs:0,knownModels:['m'],perModel:{},accountErrorRules:{},accountPipeline:{...flags,order:PIPELINE_STEP_ORDER}},dir,{NODE_ENV:'test'});
  t.after(async()=>{if(running?.child)await stop(running.child);await close(upstream);fs.rmSync(dir,{recursive:true,force:true});});
  const hmac=value=>crypto.createHmac('sha256',secret).update(String(value)).digest('hex');
  const hrw=(items,fingerprint)=>[...items].sort((left,right)=>Buffer.compare(Buffer.from(hmac(`${fingerprint}\0${right.id}`),'hex'),Buffer.from(hmac(`${fingerprint}\0${left.id}`),'hex')));
  let session;
  for(let i=0;i<1000&&!session;i++){const candidate=`all-orders-${i}`,fingerprint=hmac(`session\0${candidate}`);if(hrw(accounts,fingerprint)[0].id==='d')session=candidate;}
  assert.ok(session,'fixture must include a sticky-first winner distinct from quota-first');
  const fingerprint=hmac(`session\0${session}`),rows=[
    {id:'a',name:'A',pool:'hot',health:'unhealthy'},
    {id:'b',name:'B',pool:'warm',health:'available'},
    {id:'c',name:'C',pool:'hot',health:'degraded'},
    {id:'d',name:'D',pool:'reserve',health:'available'},
  ];
  const expectedFor=(order)=>{let groups=[rows];for(const step of order){
    if(step==='excludeUnhealthy')groups=groups.map(group=>group.filter(row=>row.health!=='unhealthy')).filter(group=>group.length);
    else if(step==='quotaPool')groups=groups.flatMap(group=>['hot','warm','unknown','reserve'].map(pool=>group.filter(row=>row.pool===pool)).filter(next=>next.length));
    else if(step==='healthSort')groups=groups.flatMap(group=>[['available','insufficient'],['degraded'],['unhealthy']].map(statuses=>group.filter(row=>statuses.includes(row.health))).filter(next=>next.length));
    else if(step==='sticky')groups=groups.flatMap(group=>hrw(group,fingerprint).map(row=>[row]));
  }return groups[0][0].name;};
  let view=await(await fetch(`http://127.0.0.1:${port}/api/accounts`)).json();
  for(const order of pipelinePermutations(PIPELINE_STEP_ORDER)){
    const saved=await rawJson(port,'/api/accounts',{accounts:view.accounts,mode:'roundrobin',active:0,concurrencyWaitMs:0,accountErrorRules:{},accountPipeline:{...flags,order}});assert.equal(saved.status,200,order.join(','));
    const response=await rawJson(port,'/v1/chat/completions',{model:'m',messages:[]},{'Session-Id':session});assert.equal(response.status,200);assert.equal(response.headers['x-cline-account'],expectedFor(order),order.join(' → '));
  }
  assert.equal(seen.length,24,'each order performs one provider-bound attempt');

  await stop(running.child);running.child=null;
  const metadataPath=path.join(dir,'metadata.json'),metadata=JSON.parse(fs.readFileSync(metadataPath));
  metadata.statistics=statisticsFixture(healthFixture({a:90000,b:80000,c:70000,d:60000}));
  fs.writeFileSync(metadataPath,JSON.stringify(metadata));
  running=await startSwitcher(null,dir,{NODE_ENV:'test'});
  view=await(await fetch(`http://127.0.0.1:${port}/api/accounts`)).json();
  const fallbackFlags={quotaPool:true,excludeUnhealthy:true,healthSort:false,sticky:false};
  let saved=await rawJson(port,'/api/accounts',{accounts:view.accounts,mode:'roundrobin',active:0,concurrencyWaitMs:0,accountErrorRules:{},accountPipeline:{...fallbackFlags,order:['quotaPool','excludeUnhealthy','healthSort','sticky']}});assert.equal(saved.status,200);
  let response=await rawJson(port,'/v1/chat/completions',{model:'m',messages:[]});assert.equal(response.headers['x-cline-account'],'C','quota-first fallback stays in the earliest hot group');
  saved=await rawJson(port,'/api/accounts',{accounts:view.accounts,mode:'roundrobin',active:0,concurrencyWaitMs:0,accountErrorRules:{},accountPipeline:{...fallbackFlags,order:['excludeUnhealthy','quotaPool','healthSort','sticky']}});assert.equal(saved.status,200);
  response=await rawJson(port,'/v1/chat/completions',{model:'m',messages:[]});assert.equal(response.headers['x-cline-account'],'D','filter-first fallback uses the global best score before quota refinement');
  await new Promise(resolve=>setTimeout(resolve,20));
  const logs=await(await fetch(`http://127.0.0.1:${port}/api/logs/requests?limit=10`)).json();assert.ok(logs.items.slice(0,2).every(item=>item.pipelineSteps.includes('health-filter-fallback')));assert.equal(JSON.stringify(logs).includes(session),false);
});

test('enabled pipelines preserve all six mode capacity rules, sticky overflow, wait rebuilds and lease release', async (t) => {
  const seen=[];
  const upstream=http.createServer((req,res)=>{if(req.method==='GET'){res.writeHead(500,{'Content-Type':'application/json'});return res.end('{}');}const chunks=[];req.on('data',chunk=>chunks.push(chunk));req.on('end',()=>{const body=JSON.parse(Buffer.concat(chunks).toString()||'{}');seen.push({auth:req.headers.authorization,model:body.model});const delay=body.model==='slow'?150:0;setTimeout(()=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:'OK'}}]}));},delay);});});
  const upstreamPort=await listen(upstream),port=await unusedPort(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'cps-pipeline-modes-')),now=Date.now();
  const accounts=[{id:'a',name:'A',key:'key-a',enabled:true,maxConcurrent:1,weight:1,priority:100,perModel:{}},{id:'b',name:'B',key:'key-b',enabled:true,maxConcurrent:1,weight:100,priority:1,perModel:{}}];
  const accountQuotas={a:{snapshot:{limits:{five_hour:{percentUsed:10},weekly:{percentUsed:10},monthly:{percentUsed:10}},fetchedAt:now},lastAttemptAt:now,lastSuccessAt:now,errorCategory:null},b:{snapshot:{limits:{five_hour:{percentUsed:99},weekly:{percentUsed:99},monthly:{percentUsed:99}},fetchedAt:now},lastAttemptAt:now,lastSuccessAt:now,errorCategory:null}};
  fs.writeFileSync(path.join(dir,'metadata.json'),JSON.stringify({models:{},history:[],accountStates:{},routingSecret:'pipeline-mode-secret',stats:{},accountQuotas}));
  const pipeline={quotaPool:true,excludeUnhealthy:false,healthSort:false,sticky:false,order:PIPELINE_STEP_ORDER};
  const running=await startSwitcher({port,upstreamBase:`http://127.0.0.1:${upstreamPort}`,accounts,accountMode:'roundrobin',activeAccount:1,concurrencyWaitMs:0,knownModels:['fast','slow'],perModel:{},accountErrorRules:{},accountPipeline:pipeline},dir,{NODE_ENV:'test'});
  t.after(async()=>{await stop(running.child);await close(upstream);fs.rmSync(dir,{recursive:true,force:true});});
  const modes=['single','roundrobin','sticky','least-connections','weighted-roundrobin','priority-failover'],session='pipeline-capacity-session';
  for(const mode of modes){
    const view=await(await fetch(`http://127.0.0.1:${port}/api/accounts`)).json();
    const saved=await rawJson(port,'/api/accounts',{accounts:view.accounts.map(account=>({...account,enabled:true})),mode,active:1,concurrencyWaitMs:0,accountErrorRules:{},accountPipeline:pipeline});assert.equal(saved.status,200);
    const ordinary=await rawJson(port,'/v1/chat/completions',{model:'fast',messages:[]},{'Session-Id':session});assert.equal(ordinary.headers['x-cline-account'],'A',`${mode} must not cross the earlier hot quota group`);
    const before=seen.length,holder=rawJson(port,'/v1/chat/completions',{model:'slow',messages:[]},{'Session-Id':session});await waitUntil(()=>seen.length>before);
    const overflow=await rawJson(port,'/v1/chat/completions',{model:'fast',messages:[]},{'Session-Id':session});
    if(mode==='single')assert.equal(overflow.status,429,'single waits only for its selected pipeline account');
    else {assert.equal(overflow.status,200);assert.equal(overflow.headers['x-cline-account'],'B',`${mode} uses immediate cross-group capacity fallback`);}
    assert.equal((await holder).headers['x-cline-account'],'A');
    await new Promise(resolve=>setTimeout(resolve,10));
    const after=await(await fetch(`http://127.0.0.1:${port}/api/accounts`)).json();assert.deepEqual(after.accounts.map(account=>account.activeCount),[0,0],`${mode} releases every lease`);
  }

  let view=await(await fetch(`http://127.0.0.1:${port}/api/accounts`)).json();
  let saved=await rawJson(port,'/api/accounts',{accounts:view.accounts.map(account=>({...account,enabled:true})),mode:'sticky',active:0,concurrencyWaitMs:500,accountErrorRules:{},accountPipeline:pipeline});assert.equal(saved.status,200);
  const before=seen.length,holder=rawJson(port,'/v1/chat/completions',{model:'slow',messages:[]},{'Session-Id':session});await waitUntil(()=>seen.length>before);
  const waiting=rawJson(port,'/v1/chat/completions',{model:'fast',messages:[]},{'Session-Id':session});await new Promise(resolve=>setTimeout(resolve,20));assert.equal(seen.length,before+1,'sticky request waits for its HRW primary before overflow');
  view=await(await fetch(`http://127.0.0.1:${port}/api/accounts`)).json();
  saved=await rawJson(port,'/api/accounts',{accounts:view.accounts.map(account=>({...account,enabled:account.id!=='a'})),mode:'sticky',active:1,concurrencyWaitMs:500,accountErrorRules:{},accountPipeline:pipeline});assert.equal(saved.status,200);
  assert.equal((await holder).headers['x-cline-account'],'A');
  const afterWait=await waiting;assert.equal(afterWait.status,200);assert.equal(afterWait.headers['x-cline-account'],'B','capacity wake rebuilds eligibility instead of leasing the now-disabled account');
  await new Promise(resolve=>setTimeout(resolve,10));view=await(await fetch(`http://127.0.0.1:${port}/api/accounts`)).json();assert.deepEqual(view.accounts.map(account=>account.activeCount),[0,0]);
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

test('quota reset timestamps accept one through nine fractional digits and reject unsafe variants', async (t) => {
  const types=['five_hour','weekly','monthly'];
  const validResetTimes={
    one:['2026-09-16T01:41:26.5Z','2026-09-19T15:02:26.5Z','2026-10-12T15:02:26.5Z'],
    three:['2026-09-16T09:41:26.123+08:00','2026-09-19T23:02:26.456+08:00','2026-10-12T23:02:26.789+08:00'],
    six:['2026-09-16T01:41:26.552188Z','2026-09-19T15:02:26.554459Z','2026-10-12T15:02:26.556754Z'],
    nine:['2026-09-16T01:41:26.552188975Z','2026-09-19T15:02:26.554459647Z','2026-10-12T15:02:26.556754049Z'],
  };
  const invalidResetTimes={
    'invalid-date':'2026-02-30T01:41:26.123Z',
    'missing-zone':'2026-09-16T01:41:26.123',
    'over-precision':'2026-09-16T01:41:26.1234567890Z',
  };
  const payloads={};
  for(const [id,resets] of Object.entries(validResetTimes))payloads[id]={success:true,data:{limits:types.map((type,index)=>({type,percentUsed:(index+1)*10,resetsAt:resets[index]}))}};
  for(const [id,resetsAt] of Object.entries(invalidResetTimes))payloads[id]={success:true,data:{limits:types.map((type,index)=>({type,percentUsed:91+index,resetsAt:index===0?resetsAt:'2026-09-16T01:41:26.123Z'}))}};
  const upstream=http.createServer((req,res)=>{req.resume();const id=req.headers.authorization?.replace(/^Bearer key-/,'');res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(payloads[id]));});
  const upstreamPort=await listen(upstream),port=await unusedPort(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'cps-quota-reset-precision-'));
  const ids=[...Object.keys(validResetTimes),...Object.keys(invalidResetTimes)],accounts=ids.map(id=>({id,name:id,key:`key-${id}`,enabled:true,perModel:{}})),fetchedAt=Date.now()-1000;
  const retainedQuota=(percentUsed)=>({snapshot:{limits:Object.fromEntries(types.map(type=>[type,{percentUsed} ])),fetchedAt},lastAttemptAt:fetchedAt,lastSuccessAt:fetchedAt,errorCategory:null});
  const accountQuotas=Object.fromEntries(Object.keys(invalidResetTimes).map((id,index)=>[id,retainedQuota(40+index)]));
  fs.writeFileSync(path.join(dir,'metadata.json'),JSON.stringify({models:{},history:[],accountStates:{},routingSecret:'quota-reset-precision-secret',stats:{},accountQuotas}));
  const running=await startSwitcher({port,upstreamBase:`http://127.0.0.1:${upstreamPort}`,accounts,accountMode:'single',activeAccount:0,knownModels:['m'],perModel:{},accountErrorRules:{},accountPipeline:{quotaPool:false,excludeUnhealthy:false,healthSort:false,sticky:false}},dir,{NODE_ENV:'test'});
  t.after(async()=>{await stop(running.child);await close(upstream);fs.rmSync(dir,{recursive:true,force:true});});

  const result=await rawJson(port,'/api/statistics/quota-refresh',{force:true});
  assert.equal(result.status,200);assert.deepEqual(result.json,{ok:true,refreshed:4,cached:0,deferred:0,skipped:0,failed:3,cancelled:0});
  const stats=await(await fetch(`http://127.0.0.1:${port}/api/statistics`)).json(),byId=Object.fromEntries(stats.accounts.map(account=>[account.id,account.quota]));
  const expectedResetTimes={
    one:['2026-09-16T01:41:26.500Z','2026-09-19T15:02:26.500Z','2026-10-12T15:02:26.500Z'],
    three:['2026-09-16T01:41:26.123Z','2026-09-19T15:02:26.456Z','2026-10-12T15:02:26.789Z'],
    six:['2026-09-16T01:41:26.552Z','2026-09-19T15:02:26.554Z','2026-10-12T15:02:26.556Z'],
    nine:['2026-09-16T01:41:26.552Z','2026-09-19T15:02:26.554Z','2026-10-12T15:02:26.556Z'],
  };
  for(const [id,resets] of Object.entries(expectedResetTimes)){assert.equal(byId[id].status,'fresh');assert.equal(byId[id].errorCategory,null);assert.deepEqual(types.map(type=>byId[id].limits[type].percentUsed),[10,20,30]);assert.deepEqual(types.map(type=>byId[id].limits[type].resetsAt),resets);}
  for(const [index,id] of Object.keys(invalidResetTimes).entries()){assert.equal(byId[id].status,'unknown');assert.equal(byId[id].errorCategory,'schema');assert.equal(byId[id].lastSuccessAt,fetchedAt);assert.deepEqual(types.map(type=>byId[id].limits[type].percentUsed),[40+index,40+index,40+index]);}
  const persisted=JSON.parse(fs.readFileSync(path.join(dir,'metadata.json'))).accountQuotas;
  for(const [id,resets] of Object.entries(expectedResetTimes))assert.deepEqual(types.map(type=>persisted[id].snapshot.limits[type].resetsAt),resets,'accepted reset times persist in canonical millisecond UTC form');
  for(const [index,id] of Object.keys(invalidResetTimes).entries())assert.deepEqual(types.map(type=>persisted[id].snapshot.limits[type].percentUsed),[40+index,40+index,40+index],'schema failure retains the complete last-good snapshot');
});

test('quota scheduler is bounded, strict, fail-open and discards stale credential generations', async (t) => {
  let phase='hold',active=0,maxActive=0;const quotaRequests=[];
  const goodPayload={success:true,data:{limits:[{type:'five_hour',percentUsed:79.9,resetsAt:'2026-09-15T08:00:00+08:00'},{type:'weekly',percentUsed:80},{type:'monthly',percentUsed:95},{type:'future',percentUsed:1}]}};
  const upstream=http.createServer((req,res)=>{
    if(req.method==='GET'){
      active++;maxActive=Math.max(maxActive,active);
      const row={url:req.url,auth:req.headers.authorization,custom:req.headers['x-chat-only'],at:Date.now(),phase,res,held:false};quotaRequests.push(row);
      let settled=false,timer;
      const cleanup=()=>{if(settled)return;settled=true;clearTimeout(timer);active--;};
      res.once('finish',cleanup);res.once('error',cleanup);res.once('close',cleanup);
      const finish=()=>{if(settled)return;if(phase==='hold'){row.held=true;return;}if(phase==='rate'){res.writeHead(429);return res.end('{}');}if(phase==='duplicate'){res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify({success:true,data:{limits:[{type:'weekly',percentUsed:1},{type:'weekly',percentUsed:2}]}}));}if(phase==='oversize'){res.writeHead(200,{'Content-Type':'application/json'});return res.end(' '.repeat(257*1024));}res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(goodPayload));};timer=setTimeout(finish,30);return;
    }
    req.resume();req.on('end',()=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:'OK'}}]}));});
  });
  const upstreamPort=await listen(upstream),port=await unusedPort(),accounts=['a','b','c'].map(id=>({id,name:id.toUpperCase(),key:`key-${id}`,enabled:true,headers:{'X-Chat-Only':'secret'},perModel:{}}));
  const cfg={port,upstreamBase:`http://127.0.0.1:${upstreamPort}/api/v1`,accountMode:'roundrobin',concurrencyWaitMs:0,accounts,knownModels:['m'],perModel:{},accountErrorRules:{},accountPipeline:{quotaPool:true,excludeUnhealthy:false,healthSort:false,sticky:false}};
  // Prove causal independence with the normal quota timeout, separately from the
  // deliberately accelerated timeout/backoff/freshness checks below.
  let running=await startSwitcher(cfg);const witnessDir=running.dir;
  t.after(async()=>{if(running?.child)await stop(running.child);await close(upstream);for(const dir of new Set([witnessDir,running.dir]))fs.rmSync(dir,{recursive:true,force:true});});
  const held=await waitUntil(()=>{const rows=quotaRequests.filter(row=>row.held);return rows.length===2&&rows;},3000);
  await new Promise(r=>setTimeout(r,120)); // A held response must outlive the old 30ms counter window.
  assert.equal(active,2);assert.equal(maxActive,2);
  assert.ok(held.every(({res})=>!res.writableEnded&&!res.destroyed));
  const chat=await rawJson(port,'/v1/chat/completions',{model:'m',messages:[]});
  assert.equal(chat.status,200);assert.equal(chat.json.choices[0].message.content,'OK');
  assert.equal(active,2);assert.ok(held.every(({res})=>!res.writableEnded&&!res.destroyed),'chat must finish before either held quota response is released or closed');
  t.diagnostic('quota barrier: chat 200 with the same two native responses still open after 120ms; release follows chat completion');
  for(const {res} of held){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(goodPayload));}
  await waitUntil(()=>active===0); // Native finish + close must not decrement twice.
  await stop(running.child);running.child=null;
  phase='success';quotaRequests.length=0;maxActive=0;
  running=await startSwitcher(cfg,null,{NODE_ENV:'test',CLINE_PASS_TEST_QUOTA_SUCCESS_MS:'50',CLINE_PASS_TEST_QUOTA_FAILURE_MS:'50',CLINE_PASS_TEST_QUOTA_TIMEOUT_MS:'80',CLINE_PASS_TEST_QUOTA_STALE_MS:'120'});
  let stats=await waitUntil(async()=>{const x=await(await fetch(`http://127.0.0.1:${port}/api/statistics`)).json();return x.accounts.every(a=>a.quota.status==='fresh')&&x;},3000);
  assert.ok(maxActive<=2,`quota concurrency exceeded 2: ${maxActive}`);assert.ok(quotaRequests.every(x=>x.url==='/api/v1/users/me/plan/usage-limits'));assert.deepEqual(new Set(quotaRequests.map(x=>x.auth)),new Set(['Bearer key-a','Bearer key-b','Bearer key-c']));assert.ok(quotaRequests.every(x=>x.custom===undefined),'chat custom headers must not reach quota endpoint');
  assert.ok(stats.accounts.every(a=>a.quota.pool==='reserve'),'maximum of the three windows owns the quota pool');assert.ok(stats.accounts.every(a=>a.quota.limits.five_hour.resetsAt==='2026-09-15T00:00:00.000Z'),'quota reset timestamps are stored as canonical ISO projections');
  const successRetry=await waitUntil(async()=>{for(const auth of ['Bearer key-a','Bearer key-b','Bearer key-c']){const rows=quotaRequests.filter(x=>x.phase==='success'&&x.auth===auth);if(rows.length>=2)return rows;}return null;},3000);assert.ok(successRetry[1].at-successRetry[0].at>=45,'successful refreshes respect the configured success interval');
  phase='rate';stats=await waitUntil(async()=>{const x=await(await fetch(`http://127.0.0.1:${port}/api/statistics`)).json();return x.accounts.every(a=>a.quota.errorCategory==='rate_limit')&&x;},3000);assert.ok(stats.accounts.every(a=>a.quota.status==='unknown'&&a.quota.limits.monthly.percentUsed===95),'failure is immediately unknown while last-good remains diagnostic');
  const rateRetry=await waitUntil(async()=>{for(const auth of ['Bearer key-a','Bearer key-b','Bearer key-c']){const rows=quotaRequests.filter(x=>x.phase==='rate'&&x.auth===auth);if(rows.length>=2)return rows;}return null;},3000);assert.ok(rateRetry[1].at-rateRetry[0].at>=90,'failed refreshes use exponential backoff instead of the success interval');
  phase='duplicate';await waitUntil(async()=>{const x=await(await fetch(`http://127.0.0.1:${port}/api/statistics`)).json();return x.accounts.some(a=>a.quota.errorCategory==='schema');},3000);
  phase='oversize';await waitUntil(async()=>quotaRequests.some(x=>x.phase==='oversize'),3000);await new Promise(r=>setTimeout(r,120));stats=await(await fetch(`http://127.0.0.1:${port}/api/statistics`)).json();assert.ok(stats.accounts.some(a=>a.quota.errorCategory==='schema'));
  phase='hold';const aRotationHoldStart=quotaRequests.length;await waitUntil(()=>quotaRequests.slice(aRotationHoldStart).some(x=>x.phase==='hold'&&x.auth==='Bearer key-a'),3000);const view=await(await fetch(`http://127.0.0.1:${port}/api/accounts`)).json();view.accounts[0].key='key-a-rotated';assert.equal((await rawJson(port,'/api/accounts',{accounts:view.accounts,mode:view.mode,active:view.active,concurrencyWaitMs:view.concurrencyWaitMs,accountErrorRules:view.accountErrorRules,accountPipeline:view.accountPipeline})).status,200);
  assert.equal((await rawJson(port,'/v1/chat/completions',{model:'m',messages:[]})).status,200); // Rotation still fails open; the explicit barrier above proves non-waiting.
  phase='success';stats=await waitUntil(async()=>{const x=await(await fetch(`http://127.0.0.1:${port}/api/statistics`)).json();return x.accounts.find(a=>a.id==='a')?.quota.status==='fresh'&&x;},3000);assert.ok(quotaRequests.some(x=>x.auth==='Bearer key-a-rotated'));let serialized=fs.readFileSync(path.join(running.dir,'metadata.json'),'utf8');assert.equal(serialized.includes('key-a'),false);assert.equal(serialized.includes('X-Chat-Only'),false);
  phase='hold';const bHoldStart=quotaRequests.length;await waitUntil(async()=>quotaRequests.slice(bHoldStart).some(x=>x.auth==='Bearer key-b'&&x.phase==='hold'),3000);let current=await(await fetch(`http://127.0.0.1:${port}/api/accounts`)).json();assert.equal((await rawJson(port,'/api/accounts',{accounts:current.accounts.filter(a=>a.id!=='b'),mode:current.mode,active:0,concurrencyWaitMs:current.concurrencyWaitMs,accountErrorRules:current.accountErrorRules,accountPipeline:current.accountPipeline})).status,200);await new Promise(r=>setTimeout(r,120));assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(path.join(running.dir,'metadata.json'))).accountQuotas,'b'),false,'deleted account generation cannot be resurrected by an in-flight refresh');
  const cHoldStart=quotaRequests.length;await waitUntil(async()=>quotaRequests.slice(cHoldStart).some(x=>x.auth==='Bearer key-c'&&x.phase==='hold'),3000);current=await(await fetch(`http://127.0.0.1:${port}/api/accounts`)).json();const dead=await unusedPort();current.accounts.find(a=>a.id==='c').proxyUrl=`http://127.0.0.1:${dead}`;assert.equal((await rawJson(port,'/api/accounts',{accounts:current.accounts,mode:current.mode,active:0,concurrencyWaitMs:current.concurrencyWaitMs,accountErrorRules:current.accountErrorRules,accountPipeline:current.accountPipeline})).status,200);stats=await waitUntil(async()=>{const x=await(await fetch(`http://127.0.0.1:${port}/api/statistics`)).json();return x.accounts.find(a=>a.id==='c')?.quota.errorCategory==='proxy'&&x;},3000);assert.equal(stats.accounts.find(a=>a.id==='c').quota.status,'unknown','proxy rotation invalidates the old generation and never falls back direct');
  phase='hold';const aHoldStart=quotaRequests.length;await waitUntil(async()=>quotaRequests.slice(aHoldStart).some(x=>x.auth==='Bearer key-a-rotated'&&x.phase==='hold'),3000);current=await(await fetch(`http://127.0.0.1:${port}/api/accounts`)).json();const beforeDisable=JSON.parse(fs.readFileSync(path.join(running.dir,'metadata.json')).toString()).accountQuotas.a;assert.equal((await rawJson(port,'/api/accounts',{accounts:current.accounts,mode:current.mode,active:0,concurrencyWaitMs:current.concurrencyWaitMs,accountErrorRules:current.accountErrorRules,accountPipeline:{quotaPool:false,excludeUnhealthy:false,healthSort:false,sticky:false}})).status,200);await new Promise(r=>setTimeout(r,120));assert.deepEqual(JSON.parse(fs.readFileSync(path.join(running.dir,'metadata.json')).toString()).accountQuotas.a,beforeDisable,'closing quota routing discards in-flight completion');
  await stop(running.child);running.child=null;const metadataPath=path.join(running.dir,'metadata.json'),metadata=JSON.parse(fs.readFileSync(metadataPath));for(const q of Object.values(metadata.accountQuotas)){if(q.snapshot)q.snapshot.fetchedAt-=1000;q.lastSuccessAt=q.snapshot?.fetchedAt||q.lastSuccessAt;q.lastAttemptAt=q.lastSuccessAt;q.errorCategory=null;}const config=JSON.parse(fs.readFileSync(path.join(running.dir,'config.json')));config.accountPipeline.quotaPool=false;fs.writeFileSync(metadataPath,JSON.stringify(metadata));fs.writeFileSync(path.join(running.dir,'config.json'),JSON.stringify(config));running=await startSwitcher(null,running.dir,{NODE_ENV:'test',CLINE_PASS_TEST_QUOTA_STALE_MS:'120'});stats=await(await fetch(`http://127.0.0.1:${port}/api/statistics`)).json();assert.ok(stats.accounts.every(a=>a.quota.status==='unknown'),'stale last-good snapshots cannot route');
  assert.equal(active,0);assert.ok(maxActive<=2,`quota concurrency exceeded 2 across refresh/configuration phases: ${maxActive}`);
});

test('statistics quota refresh is authenticated, strict, routing-independent, cache-aware and truthful', async (t) => {
  let phase='full';const hits=[];
  const upstream=http.createServer((req,res)=>{req.resume();req.on('end',()=>{if(req.method!=='GET'){res.writeHead(200,{'Content-Type':'application/json'});return res.end('{"choices":[{"message":{"content":"OK"}}]}');}hits.push({auth:req.headers.authorization,path:req.url,phase});if(phase==='rate'){res.writeHead(429);return res.end('{}');}const limits=phase==='partial'?[{type:'weekly',percentUsed:25}]:[{type:'five_hour',percentUsed:0,resetsAt:'2026-09-15T00:00:00.000Z'},{type:'weekly',percentUsed:37.5},{type:'monthly',percentUsed:100,resetsAt:'2026-10-01T00:00:00.000Z'}];res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({success:true,data:{limits}}));});});
  const upstreamPort=await listen(upstream),port=await unusedPort(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'cps-stat-quota-')),fetchedAt=Date.now()-1000;
  const accounts=[{id:'a',name:'<Enabled>',key:'enabled-key',enabled:true,perModel:{}},{id:'disabled',name:'Disabled',key:'disabled-key',enabled:false,perModel:{}}];
  const disabledQuota={snapshot:{limits:{five_hour:{percentUsed:20},weekly:{percentUsed:40},monthly:{percentUsed:60}},fetchedAt},lastAttemptAt:fetchedAt,lastSuccessAt:fetchedAt,errorCategory:null};
  fs.writeFileSync(path.join(dir,'metadata.json'),JSON.stringify({models:{},history:[],accountStates:{},routingSecret:'statistics-quota-secret',stats:{},accountQuotas:{disabled:disabledQuota}}));
  const fault=path.join(dir,'quota-meta-fault'),loader=path.join(dir,'quota-meta-loader.mjs');fs.writeFileSync(loader,`import fs from 'node:fs';const rename=fs.renameSync;fs.renameSync=(a,b)=>{if(String(b).endsWith('/metadata.json')&&fs.existsSync(${JSON.stringify(fault)}))throw Error('fixture quota metadata write failure');return rename(a,b);};`);
  const running=await startSwitcher({port,upstreamBase:`http://127.0.0.1:${upstreamPort}/api/v1`,proxyKey:'quota-admin',detailedLogging:true,accounts,accountMode:'single',activeAccount:0,knownModels:['m'],perModel:{},accountErrorRules:{},accountPipeline:{quotaPool:false,excludeUnhealthy:false,healthSort:false,sticky:false}},dir,{NODE_ENV:'test',NODE_OPTIONS:`--import=${loader}`,CLINE_PASS_TEST_QUOTA_SUCCESS_MS:'500',CLINE_PASS_TEST_QUOTA_FAILURE_MS:'100'});
  t.after(async()=>{await stop(running.child);await close(upstream);fs.rmSync(dir,{recursive:true,force:true});});
  const auth={'X-Admin-Key':'quota-admin'},refresh=(body,pathName='/api/statistics/quota-refresh')=>rawJson(port,pathName,body,auth);
  const configBefore=fs.readFileSync(path.join(dir,'config.json'));
  let stats=await(await fetch(`http://127.0.0.1:${port}/api/statistics`,{headers:auth})).json();assert.equal(hits.length,0,'GET statistics remains a projection');
  assert.equal(stats.accounts.find(a=>a.id==='disabled').quota.refresh.reason,'disabled');assert.equal(stats.accounts.find(a=>a.id==='disabled').quota.limits.monthly.percentUsed,60);
  assert.equal((await rawJson(port,'/api/statistics/quota-refresh',{force:false})).status,401);
  for(const body of [null,[],{}, {force:'false'},{force:false,extra:true}])assert.equal((await refresh(body)).status,400);
  assert.equal((await refresh({force:false},'/api/statistics/quota-refresh?accountId=a')).status,400);assert.equal(hits.length,0);
  let result=await refresh({force:false});assert.equal(result.status,200);assert.deepEqual(result.json,{ok:true,refreshed:1,cached:0,deferred:0,skipped:1,failed:0,cancelled:0});assert.equal(hits.length,1);assert.deepEqual(hits[0],{auth:'Bearer enabled-key',path:'/api/v1/users/me/plan/usage-limits',phase:'full'});
  stats=await(await fetch(`http://127.0.0.1:${port}/api/statistics`,{headers:auth})).json();const enabled=stats.accounts.find(a=>a.id==='a'),disabled=stats.accounts.find(a=>a.id==='disabled');
  assert.equal(enabled.quota.status,'fresh');assert.deepEqual(Object.fromEntries(Object.entries(enabled.quota.limits).map(([key,value])=>[key,value.percentUsed])),{five_hour:0,weekly:37.5,monthly:100});assert.equal(enabled.quota.lastSuccessAt,enabled.quota.fetchedAt);assert.deepEqual(enabled.quota.refresh,{eligible:true,reason:null,state:'idle',nextAttemptAt:enabled.quota.lastSuccessAt+500});
  assert.equal(disabled.quota.lastSuccessAt,fetchedAt);assert.equal(disabled.quota.refresh.eligible,false);assert.equal(disabled.quota.refresh.nextAttemptAt,null);
  result=await refresh({force:false});assert.equal(result.json.cached,1);assert.equal(result.json.skipped,1);assert.equal(hits.length,1,'automatic refresh reuses the successful five-minute cache');
  phase='partial';fs.writeFileSync(fault,'');result=await refresh({force:true});assert.equal(result.json.refreshed,1);assert.match(running.output(),/\[额度\] 持久化失败/);fs.unlinkSync(fault);assert.equal(hits.length,2);stats=await(await fetch(`http://127.0.0.1:${port}/api/statistics`,{headers:auth})).json();assert.deepEqual(Object.keys(stats.accounts.find(a=>a.id==='a').quota.limits),['weekly'],'a partial success replaces rather than fills old windows');assert.equal(stats.accounts.find(a=>a.id==='a').quota.status,'unknown');
  phase='rate';result=await refresh({force:true});assert.equal(result.json.failed,1);const afterFailureHits=hits.length;result=await refresh({force:true});assert.equal(result.json.deferred,1);assert.equal(hits.length,afterFailureHits,'manual refresh never bypasses failure backoff');
  stats=await(await fetch(`http://127.0.0.1:${port}/api/statistics`,{headers:auth})).json();const failed=stats.accounts.find(a=>a.id==='a').quota;assert.equal(failed.errorCategory,'rate_limit');assert.equal(failed.limits.weekly.percentUsed,25);assert.ok(failed.refresh.nextAttemptAt>failed.lastAttemptAt);
  assert.deepEqual(fs.readFileSync(path.join(dir,'config.json')),configBefore,'quota display/refresh never changes scheduling configuration');
  assert.equal((await(await fetch(`http://127.0.0.1:${port}/api/logs/requests`,{headers:auth})).json()).items.length,0);assert.equal((await(await fetch(`http://127.0.0.1:${port}/api/logs/details`,{headers:auth})).json()).items.length,0,'statistics/quota traffic remains outside detailed chat capture');
});

test('shared quota admission coalesces page owners, enforces two live transports and uses an absolute deadline', {timeout:10000}, async (t) => {
  let phase='hold',active=0,maxActive=0,total=0;const rows=[];
  const payload=(percent=10)=>JSON.stringify({success:true,data:{limits:[{type:'five_hour',percentUsed:percent},{type:'weekly',percentUsed:percent+1},{type:'monthly',percentUsed:percent+2}]}});
  const upstream=http.createServer((req,res)=>{if(req.method!=='GET'){req.resume();return req.on('end',()=>res.end('{"choices":[{"message":{"content":"OK"}}]}'));}total++;active++;maxActive=Math.max(maxActive,active);const row={auth:req.headers.authorization,res,phase,closed:false,interval:null};rows.push(row);const done=()=>{if(row.closed)return;row.closed=true;active--;clearInterval(row.interval);};res.once('finish',done);res.once('close',done);res.once('error',done);if(phase==='slow'){res.writeHead(200,{'Content-Type':'application/json'});res.write('{');row.interval=setInterval(()=>res.write(' '),10);}else if(phase==='respond'){res.writeHead(200,{'Content-Type':'application/json'});res.end(payload(88));}req.resume();});
  const upstreamPort=await listen(upstream),port=await unusedPort(),accounts=['a','b','c','d'].map(id=>({id,name:id,key:`key-${id}`,enabled:true,perModel:{}}));
  const running=await startSwitcher({port,upstreamBase:`http://127.0.0.1:${upstreamPort}`,accounts,accountMode:'single',activeAccount:0,knownModels:['m'],perModel:{},accountErrorRules:{},accountPipeline:{quotaPool:false,excludeUnhealthy:false,healthSort:false,sticky:false}},null,{NODE_ENV:'test',CLINE_PASS_TEST_QUOTA_TIMEOUT_MS:'80',CLINE_PASS_TEST_QUOTA_SUCCESS_MS:'500',CLINE_PASS_TEST_QUOTA_FAILURE_MS:'50'});
  t.after(async()=>{await stop(running.child);for(const row of rows)row.res.destroy();await close(upstream);fs.rmSync(running.dir,{recursive:true,force:true});});
  const request=(controller)=>fetch(`http://127.0.0.1:${port}/api/statistics/quota-refresh`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{"force":true}',signal:controller.signal}).then(async response=>({status:response.status,json:await response.json()}));
  const controllers=[new AbortController(),new AbortController(),new AbortController()],pending=controllers.map(controller=>request(controller).catch(error=>({aborted:error.name==='AbortError'})));
  await waitUntil(()=>active===2);assert.equal(total,2);const liveStats=await(await fetch(`http://127.0.0.1:${port}/api/statistics`)).json(),refreshStates=liveStats.accounts.map(account=>account.quota.refresh.state);assert.equal(refreshStates.filter(state=>state==='fetching').length,2);assert.equal(refreshStates.filter(state=>state==='queued').length,2);controllers[0].abort();await new Promise(r=>setTimeout(r,20));assert.equal(active,2,'one page leaving must not cancel work owned by other pages');controllers[1].abort();await new Promise(r=>setTimeout(r,20));assert.equal(active,2);
  for(let index=0;index<4;index+=2){const batch=rows.slice(index,index+2);for(const row of batch){row.res.writeHead(200,{'Content-Type':'application/json'});row.res.end(payload(10+index));}if(index===0)await waitUntil(()=>rows.length===4);}
  const survivor=await pending[2];await Promise.all(pending.slice(0,2));assert.equal(survivor.status,200);assert.equal(survivor.json.refreshed,4);assert.equal(total,4,'same-account page demand is coalesced');assert.equal(maxActive,2);
  const limitControllers=Array.from({length:17},()=>new AbortController()),statuses=[];const limited=limitControllers.map(controller=>request(controller).then(value=>{statuses.push(value.status);return value;},error=>({aborted:error.name==='AbortError'})));await waitUntil(()=>statuses.includes(429));assert.equal(statuses.filter(status=>status===429).length,1);for(const controller of limitControllers)controller.abort();await Promise.all(limited);await waitUntil(()=>active===0);assert.ok(maxActive<=2,'batch overload never widens upstream admission');
  phase='slow';const started=Date.now(),slow=await request(new AbortController());const elapsed=Date.now()-started;assert.equal(slow.status,200);assert.equal(slow.json.failed,4);assert.ok(elapsed<500,`absolute quota deadline took ${elapsed}ms`);assert.ok(maxActive<=2);
  const stats=await(await fetch(`http://127.0.0.1:${port}/api/statistics`)).json();assert.ok(stats.accounts.every(account=>account.quota.errorCategory==='timeout'));
  await new Promise(r=>setTimeout(r,110));phase='hold';const before=stats.accounts.find(account=>account.id==='a').quota,disableController=new AbortController(),disabling=request(disableController);await waitUntil(()=>rows.some(row=>row.phase==='hold'&&row.auth==='Bearer key-a'&&!row.closed));
  const view=await(await fetch(`http://127.0.0.1:${port}/api/accounts`)).json();view.accounts.find(account=>account.id==='a').enabled=false;assert.equal((await rawJson(port,'/api/accounts',{accounts:view.accounts,mode:view.mode,active:view.active,concurrencyWaitMs:view.concurrencyWaitMs,accountErrorRules:view.accountErrorRules,accountPipeline:view.accountPipeline})).status,200);
  phase='respond';for(const row of rows.filter(row=>row.phase==='hold'&&!row.closed)){if(!row.res.destroyed){row.res.writeHead(200,{'Content-Type':'application/json'});row.res.end(payload(88));}}
  await disabling;const after=await(await fetch(`http://127.0.0.1:${port}/api/statistics`)).json(),disabled=after.accounts.find(account=>account.id==='a').quota;assert.equal(disabled.refresh.reason,'disabled');assert.equal(disabled.lastSuccessAt,before.lastSuccessAt);assert.equal(disabled.limits.five_hour.percentUsed,before.limits.five_hour.percentUsed,'disable retains last-good data but cannot publish held work');assert.ok(maxActive<=2);
  await new Promise(r=>setTimeout(r,510));phase='hold';let routeView=await(await fetch(`http://127.0.0.1:${port}/api/accounts`)).json();assert.equal((await rawJson(port,'/api/accounts',{accounts:routeView.accounts,mode:routeView.mode,active:routeView.active,concurrencyWaitMs:routeView.concurrencyWaitMs,accountErrorRules:routeView.accountErrorRules,accountPipeline:{quotaPool:true,excludeUnhealthy:false,healthSort:false,sticky:false}})).status,200);await waitUntil(()=>rows.some(row=>row.phase==='hold'&&row.auth==='Bearer key-b'&&!row.closed));
  const shared=request(new AbortController());await new Promise(r=>setTimeout(r,20));routeView=await(await fetch(`http://127.0.0.1:${port}/api/accounts`)).json();assert.equal((await rawJson(port,'/api/accounts',{accounts:routeView.accounts,mode:routeView.mode,active:routeView.active,concurrencyWaitMs:routeView.concurrencyWaitMs,accountErrorRules:routeView.accountErrorRules,accountPipeline:{quotaPool:false,excludeUnhealthy:false,healthSort:false,sticky:false}})).status,200);phase='respond';for(const row of rows.filter(row=>row.phase==='hold'&&!row.closed)){if(!row.res.destroyed){row.res.writeHead(200,{'Content-Type':'application/json'});row.res.end(payload(77));}}
  const sharedResult=await shared;assert.equal(sharedResult.status,200);assert.equal(sharedResult.json.refreshed,3);const sharedStats=await(await fetch(`http://127.0.0.1:${port}/api/statistics`)).json();assert.equal(sharedStats.accounts.find(account=>account.id==='b').quota.limits.five_hour.percentUsed,77,'routing off withdraws only routing ownership while the page-owned completion publishes');assert.equal((await(await fetch(`http://127.0.0.1:${port}/api/accounts`)).json()).accountPipeline.quotaPool,false);const totalAfterRoutingOff=total;await new Promise(r=>setTimeout(r,100));assert.equal(total,totalAfterRoutingOff,'an obsolete routing callback cannot rearm after routing is disabled');assert.ok(maxActive<=2);
});

test('quota force-cache bypass belongs only to live manual page owners', async (t) => {
  let active=0;const rows=[];
  const payload=JSON.stringify({success:true,data:{limits:[{type:'five_hour',percentUsed:10},{type:'weekly',percentUsed:20},{type:'monthly',percentUsed:30}]}});
  const upstream=http.createServer((req,res)=>{if(req.method!=='GET'){req.resume();return req.on('end',()=>res.end('{"choices":[{"message":{"content":"OK"}}]}'));}active++;const row={auth:req.headers.authorization,res,closed:false};rows.push(row);const done=()=>{if(row.closed)return;row.closed=true;active--;};res.once('finish',done);res.once('close',done);res.once('error',done);req.resume();});
  const upstreamPort=await listen(upstream),port=await unusedPort(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'cps-quota-force-owner-')),fetchedAt=Date.now();
  const accounts=['a','b','c'].map(id=>({id,name:id,key:`key-${id}`,enabled:true,perModel:{}}));
  const cached={snapshot:{limits:{five_hour:{percentUsed:1},weekly:{percentUsed:2},monthly:{percentUsed:3}},fetchedAt},lastAttemptAt:fetchedAt,lastSuccessAt:fetchedAt,errorCategory:null};
  fs.writeFileSync(path.join(dir,'metadata.json'),JSON.stringify({models:{},history:[],accountStates:{},routingSecret:'quota-force-owner-secret',stats:{},accountQuotas:{c:cached}}));
  const running=await startSwitcher({port,upstreamBase:`http://127.0.0.1:${upstreamPort}`,accounts,accountMode:'single',activeAccount:0,knownModels:['m'],perModel:{},accountErrorRules:{},accountPipeline:{quotaPool:true,excludeUnhealthy:false,healthSort:false,sticky:false}},dir,{NODE_ENV:'test',CLINE_PASS_TEST_QUOTA_TIMEOUT_MS:'1000',CLINE_PASS_TEST_QUOTA_SUCCESS_MS:'1000'});
  t.after(async()=>{await stop(running.child);for(const row of rows)row.res.destroy();await close(upstream);fs.rmSync(dir,{recursive:true,force:true});});
  const request=(force,controller)=>fetch(`http://127.0.0.1:${port}/api/statistics/quota-refresh`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({force}),signal:controller?.signal}).then(async response=>({status:response.status,json:await response.json()}));
  await waitUntil(()=>active===2);assert.deepEqual(new Set(rows.map(row=>row.auth)),new Set(['Bearer key-a','Bearer key-b']));
  const manualController=new AbortController(),manual=request(true,manualController).catch(error=>({aborted:error.name==='AbortError'}));
  await waitUntil(async()=>{const stats=await(await fetch(`http://127.0.0.1:${port}/api/statistics`)).json();return stats.accounts.find(account=>account.id==='c').quota.refresh.state==='queued';});
  const automatic=request(false);await new Promise(resolve=>setTimeout(resolve,30));manualController.abort();await new Promise(resolve=>setTimeout(resolve,30));
  for(const row of rows)if(!row.closed){row.res.writeHead(200,{'Content-Type':'application/json'});row.res.end(payload);}
  const result=await automatic;await manual;
  assert.equal(result.status,200);assert.equal(result.json.refreshed,2);assert.equal(result.json.cached,1);assert.equal(rows.length,2,'a departed manual owner must not force a cache-valid queued account for an automatic owner');
});

test('forced quota batch reuses a success published after its request was accepted but before body admission', async (t) => {
  let quotaRequests=0,heldResponse=null;
  const payload=JSON.stringify({success:true,data:{limits:[{type:'five_hour',percentUsed:10},{type:'weekly',percentUsed:20},{type:'monthly',percentUsed:30}]}});
  const upstream=http.createServer((req,res)=>{req.resume();if(req.method!=='GET')return req.on('end',()=>res.end('{"choices":[{"message":{"content":"OK"}}]}'));quotaRequests++;if(quotaRequests===1)heldResponse=res;else{res.writeHead(200,{'Content-Type':'application/json'});res.end(payload);}});
  const upstreamPort=await listen(upstream),port=await unusedPort();
  const running=await startSwitcher({port,upstreamBase:`http://127.0.0.1:${upstreamPort}`,accounts:[{id:'a',name:'A',key:'key-a',enabled:true,perModel:{}}],accountMode:'single',activeAccount:0,knownModels:['m'],perModel:{},accountErrorRules:{},accountPipeline:{quotaPool:false,excludeUnhealthy:false,healthSort:false,sticky:false}},null,{NODE_ENV:'test',CLINE_PASS_TEST_QUOTA_TIMEOUT_MS:'1000',CLINE_PASS_TEST_QUOTA_SUCCESS_MS:'1000'});
  t.after(async()=>{await stop(running.child);heldResponse?.destroy();await close(upstream);fs.rmSync(running.dir,{recursive:true,force:true});});
  const first=rawJson(port,'/api/statistics/quota-refresh',{force:true});await waitUntil(()=>heldResponse);
  const body='{"force":true}';let delayedRequest;
  const delayed=new Promise((resolve,reject)=>{delayedRequest=http.request({hostname:'127.0.0.1',port,path:'/api/statistics/quota-refresh',method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},res=>{const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode,json:JSON.parse(Buffer.concat(chunks).toString())}));});delayedRequest.on('error',reject);delayedRequest.write('{"force":');});
  await new Promise(resolve=>setTimeout(resolve,50));heldResponse.writeHead(200,{'Content-Type':'application/json'});heldResponse.end(payload);
  const firstResult=await first;assert.equal(firstResult.status,200);assert.equal(firstResult.json.refreshed,1);
  delayedRequest.end('true}');const delayedResult=await delayed;assert.equal(delayedResult.status,200);assert.equal(delayedResult.json.cached,1);assert.equal(delayedResult.json.refreshed,0);assert.equal(quotaRequests,1,'a forced batch must reuse a success published since that batch started');
});

test('forced quota baseline remains monotonic across identity rotation and reuses the new identity success', async (t) => {
  let active=0,maxActive=0;const rows=[];
  const upstream=http.createServer((req,res)=>{req.resume();if(req.method!=='GET')return req.on('end',()=>res.end('{"choices":[{"message":{"content":"OK"}}]}'));const row={auth:req.headers.authorization,res,closed:false};rows.push(row);active++;maxActive=Math.max(maxActive,active);const done=()=>{if(row.closed)return;row.closed=true;active--;};res.once('finish',done);res.once('close',done);res.once('error',done);const percent=row.auth==='Bearer key-b'?70:10;res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({success:true,data:{limits:[{type:'five_hour',percentUsed:percent},{type:'weekly',percentUsed:percent+1},{type:'monthly',percentUsed:percent+2}]}}));});
  const upstreamPort=await listen(upstream),port=await unusedPort();
  const running=await startSwitcher({port,upstreamBase:`http://127.0.0.1:${upstreamPort}`,accounts:[{id:'a',name:'A',key:'key-a',enabled:true,perModel:{}}],accountMode:'single',activeAccount:0,knownModels:['m'],perModel:{},accountErrorRules:{},accountPipeline:{quotaPool:false,excludeUnhealthy:false,healthSort:false,sticky:false}},null,{NODE_ENV:'test',CLINE_PASS_TEST_QUOTA_TIMEOUT_MS:'1000',CLINE_PASS_TEST_QUOTA_SUCCESS_MS:'1000'});
  t.after(async()=>{await stop(running.child);for(const row of rows)row.res.destroy();await close(upstream);fs.rmSync(running.dir,{recursive:true,force:true});});
  const refresh=()=>rawJson(port,'/api/statistics/quota-refresh',{force:true});
  for(let i=0;i<3;i++){const result=await refresh();assert.equal(result.status,200);assert.equal(result.json.refreshed,1);}await waitUntil(()=>active===0);assert.equal(rows.filter(row=>row.auth==='Bearer key-a').length,3);
  const body='{"force":true}';let delayedRequest;
  const delayed=new Promise((resolve,reject)=>{delayedRequest=http.request({hostname:'127.0.0.1',port,path:'/api/statistics/quota-refresh',method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},res=>{const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode,json:JSON.parse(Buffer.concat(chunks).toString())}));});delayedRequest.on('error',reject);delayedRequest.write('{"force":');});
  await new Promise(resolve=>setTimeout(resolve,50));const view=await(await fetch(`http://127.0.0.1:${port}/api/accounts`)).json();view.accounts[0].key='key-b';assert.equal((await rawJson(port,'/api/accounts',{accounts:view.accounts,mode:view.mode,active:view.active,concurrencyWaitMs:view.concurrencyWaitMs,accountErrorRules:view.accountErrorRules,accountPipeline:view.accountPipeline})).status,200);
  const newIdentity=await refresh();assert.equal(newIdentity.status,200);assert.equal(newIdentity.json.refreshed,1);await waitUntil(()=>active===0);assert.equal(rows.filter(row=>row.auth==='Bearer key-b').length,1);
  delayedRequest.end('true}');const result=await delayed;assert.equal(result.status,200);assert.equal(result.json.cached,1);assert.equal(result.json.refreshed,0);assert.equal(rows.filter(row=>row.auth==='Bearer key-b').length,1,'the delayed batch must reuse the new-identity success');assert.equal(maxActive,1);
  const quota=(await(await fetch(`http://127.0.0.1:${port}/api/statistics`)).json()).accounts[0].quota;assert.equal(quota.limits.five_hour.percentUsed,70);assert.equal(quota.errorCategory,null);assert.equal(quota.status,'fresh');
});

test('quota body cancellation and key A-to-B-to-A rotation settle without stale publication or backoff', async (t) => {
  let phase='hold-body';const rows=[];
  const payload=JSON.stringify({success:true,data:{limits:[{type:'five_hour',percentUsed:55},{type:'weekly',percentUsed:56},{type:'monthly',percentUsed:57}]}});
  const upstream=http.createServer((req,res)=>{req.resume();if(req.method!=='GET')return req.on('end',()=>res.end('{"choices":[{"message":{"content":"OK"}}]}'));const row={auth:req.headers.authorization,res,closed:false};rows.push(row);res.once('close',()=>{row.closed=true;});if(phase==='hold-body'){res.writeHead(200,{'Content-Type':'application/json'});res.write('{"success":true,"data":{"limits":[');}else{res.writeHead(200,{'Content-Type':'application/json'});res.end(payload);}});
  const upstreamPort=await listen(upstream),port=await unusedPort(),account={id:'a',name:'A',key:'key-a',enabled:true,perModel:{}};
  const running=await startSwitcher({port,upstreamBase:`http://127.0.0.1:${upstreamPort}`,accounts:[account],accountMode:'single',activeAccount:0,knownModels:['m'],perModel:{},accountErrorRules:{},accountPipeline:{quotaPool:false,excludeUnhealthy:false,healthSort:false,sticky:false}},null,{NODE_ENV:'test',CLINE_PASS_TEST_QUOTA_TIMEOUT_MS:'1000',CLINE_PASS_TEST_QUOTA_FAILURE_MS:'1000'});
  t.after(async()=>{await stop(running.child);for(const row of rows)row.res.destroy();await close(upstream);fs.rmSync(running.dir,{recursive:true,force:true});});
  const refresh=()=>rawJson(port,'/api/statistics/quota-refresh',{force:true});
  const held=refresh();await waitUntil(()=>rows.length===1);assert.equal(rows[0].auth,'Bearer key-a');assert.equal(rows[0].res.writableEnded,false);
  const view=await(await fetch(`http://127.0.0.1:${port}/api/accounts`)).json(),save=()=>rawJson(port,'/api/accounts',{accounts:view.accounts,mode:view.mode,active:view.active,concurrencyWaitMs:view.concurrencyWaitMs,accountErrorRules:view.accountErrorRules,accountPipeline:view.accountPipeline});
  view.accounts[0].key='key-b';assert.equal((await save()).status,200);view.accounts[0].key='key-a';assert.equal((await save()).status,200);
  phase='respond';const replacement=refresh(),cancelled=await held;assert.equal(cancelled.status,200);assert.equal(cancelled.json.cancelled,1);await waitUntil(()=>rows[0].closed);
  const result=await replacement;assert.equal(result.status,200);assert.equal(result.json.refreshed,1);assert.equal(rows.length,2);assert.equal(rows[1].auth,'Bearer key-a');
  const quota=(await(await fetch(`http://127.0.0.1:${port}/api/statistics`)).json()).accounts[0].quota;assert.equal(quota.limits.five_hour.percentUsed,55);assert.equal(quota.errorCategory,null);assert.equal(quota.status,'fresh');
});

test('detailed logging settings, route matrix, actual-call groups and credential boundaries', async (t) => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    const chunks = []; req.on('data', (c) => chunks.push(c)); req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}'); seen.push({ method: req.method, path: req.url, body, headers: req.headers });
      res.setHeader('Content-Type', 'application/json'); res.setHeader('X-Ordinary-Response', 'ordinary response'); res.setHeader('Set-Cookie', 'session=upstream-cookie-secret');
      res.setHeader('X-Earlier-Echo', 'response-header-password'); res.setHeader('Location', 'https://example.org/?api_key=response-header-password');
      if (req.method === 'GET') return res.end(JSON.stringify({ data: [{ id: 'cline-pass/model' }] }));
      const only = body.provider?.only?.[0] || body.providerOptions?.gateway?.only?.[0];
      if (only === '__probe__') { res.statusCode = 400; return res.end(JSON.stringify({ error: 'Available providers are: one, two, three, four, five, six.' })); }
      if (only === 'first') { res.statusCode = 500; return res.end(JSON.stringify({ error: { message: 'retry mock failure', status: 500 } })); }
      const content = body.model === 'probe' ? 'OK' : 'retained output <script>alert(1)</script> incoming-cookie-secret upstream-cookie-secret response-header-password ' + (body.echo || '') + req.headers.authorization.replace(/^Bearer /, '');
      const out = { choices: [{ message: { content, ...(body.model === 'probe' ? { provider_metadata: { gateway: { routing: { finalProvider: 'one', fallbacksAvailable: ['one', 'two', 'three', 'four', 'five', 'six'] } } } } : {}) } }] };
      res.end(JSON.stringify({ data: out, rawOnly: 'upstream wrapper only' }));
    });
  });
  const upstreamPort = await listen(upstream), port = await unusedPort();
  let running = await startSwitcher({ port, upstreamBase: `http://127.0.0.1:${upstreamPort}`, proxyKey: 'detail-admin-secret', exposeCatalog: true, accounts: [{ id: 'a', name: 'Detail account', key: 'saved-detail-secret', enabled: true, perModel: {} }], knownModels: ['cline-pass/model', 'retry', 'probe'], modelAliases: { alias: 'cline-pass/model' }, perModel: { retry: { upstreams: ['first', 'second'], pinMode: 'strict' } }, accountErrorRules: {} });
  t.after(async () => { await stop(running.child); await close(upstream); fs.rmSync(running.dir, { recursive: true, force: true }); });
  const auth = { 'X-Admin-Key': 'detail-admin-secret', Cookie: 'session=incoming-cookie-secret' };
  const get = async (route, method = 'GET') => { const response = await fetch(`http://127.0.0.1:${port}${route}`, { method, headers: auth }); return { response, json: await response.json() }; };
  const list = async () => (await get('/api/logs/details?limit=200')).json.items;
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/logs/settings`)).status, 401);
  assert.equal((await get('/api/logs/settings')).json.detailedLogging, false);
  await rawJson(port, '/v1/chat/completions', { model: 'alias', messages: [] }, auth);
  assert.equal((await list()).length, 0);
  const settingsBefore = fs.readFileSync(path.join(running.dir, 'config.json'));
  for (const value of [null, [], {}, { detailedLogging: 1 }, { detailedLogging: true, extra: 1 }]) assert.equal((await rawJson(port, '/api/logs/settings', value, auth)).status, 400);
  assert.deepEqual(fs.readFileSync(path.join(running.dir, 'config.json')), settingsBefore);
  assert.equal((await rawJson(port, '/api/logs/settings', { detailedLogging: true }, auth)).status, 200);
  let expected = 0;
  const groupAfter = async (request) => {
    const response = await request; expected++;
    const rows = await waitUntil(async () => { const rows = await list(); return rows.length === expected && rows.every((row) => row.state !== 'open') && rows; });
    const id = response.headers?.['x-cline-request-id'] || rows[0].requestId;
    const { json: group } = await get('/api/logs/details/' + id);
    assert.equal(group.request.requestId, id); return { response, group };
  };
  for (const route of ['/chat/completions', '/v1/chat/completions', '/api/v1/chat/completions']) {
    const { response, group } = await groupAfter(rawJson(port, route, { model: 'alias', echo: 'ingress-header-password', messages: [{ role: 'user', content: 'retained prompt' }] }, { ...auth, Cookie: 'session=incoming-cookie-secret', 'X-Ordinary': 'ordinary ingress', 'X-Earlier-Echo': 'ingress-header-password', Referer: 'https://user:ingress-header-password@example.org/' }));
    assert.equal(response.status, 200); assert.equal(group.attempts.length, 1);
    assert.equal(group.attempts[0].headers.host, `127.0.0.1:${upstreamPort}`);
    assert.equal(group.request.headers['x-ordinary'], 'ordinary ingress');
    assert.equal(group.request.headers.cookie, '[REDACTED]');
    const body = async (id) => { const r = await fetch(`http://127.0.0.1:${port}/api/logs/details/${group.request.requestId}/bodies/${id}`, { headers: auth }); assert.equal(r.headers.get('cache-control'), 'no-store'); assert.equal(r.headers.get('x-content-type-options'), 'nosniff'); return r.text(); };
    assert.match(await body(group.request.requestBody), /"model": "alias"/);
    assert.match(await body(group.attempts[0].requestBody), /"model": "cline-pass\/model"/);
    assert.match(await body(group.attempts[0].responseBody), /upstream wrapper only/);
    assert.doesNotMatch(await body(group.request.responseBody), /upstream wrapper only/);
    assert.match(await body(group.request.responseBody), /retained output/);
    assert.doesNotMatch(JSON.stringify(group), /ingress-header-password|response-header-password/);
    for (const descriptor of group.bodies) assert.doesNotMatch(await body(descriptor.bodyId), /ingress-header-password|response-header-password/);
  }
  const retry = await groupAfter(rawJson(port, '/v1/chat/completions', { model: 'retry', messages: [] }, auth));
  assert.deepEqual(retry.group.attempts.map((a) => a.status), [500, 200]); assert.equal(new Set(retry.group.attempts.map((a) => a.callId)).size, 2);
  const invalid = await groupAfter(rawJson(port, '/v1/chat/completions', { model: 'alias', messages: [{ role: 'user', content: '' }] }, auth));
  assert.equal(invalid.response.status, 400); assert.equal(invalid.group.attempts.length, 0);
  const unauthorized = await groupAfter(rawJson(port, '/v1/chat/completions', { key: 'unread-secret' }));
  assert.equal(unauthorized.response.status, 401); assert.equal(unauthorized.group.bodies[0].state, 'unread');
  const unsupported = await groupAfter(rawJson(port, '/v1/responses', { key: 'unread-secret' }, auth));
  assert.equal(unsupported.response.status, 501); assert.equal(unsupported.group.bodies[0].state, 'unread');
  const consoleTest = await groupAfter(rawJson(port, '/api/test', { model: 'alias' }, auth)); assert.equal(consoleTest.group.attempts.length, 1);
  const probe = await groupAfter(rawJson(port, '/api/probe', { model: 'probe' }, auth)); assert.equal(probe.group.attempts.length, 2);
  const validation = await groupAfter(rawJson(port, '/api/validate-upstreams', { model: 'probe' }, auth)); assert.equal(validation.group.attempts.length, 6); assert.equal(new Set(validation.group.attempts.map((a) => a.callId)).size, 6);
  const accountTest = await groupAfter(rawJson(port, '/api/accounts/test', { key: 'ephemeral-detail-secret' }, auth)); assert.equal(accountTest.group.attempts.length, 1);
  const badProxyPort = await unusedPort();
  const proxyTest = await groupAfter(rawJson(port, '/api/accounts/proxy-test', { accountId: 'a', proxyUrl: `http://user:ephemeral-proxy-password@127.0.0.1:${badProxyPort}` }, auth));
  assert.equal(proxyTest.group.attempts.length, 1); assert.equal(proxyTest.group.attempts[0].accountId, 'a'); assert.equal(proxyTest.group.attempts[0].state, 'transport-failed'); assert.equal(proxyTest.group.bodies.at(-1).state, 'unread');
  for (const [index, route] of ['/v1/models', '/api/v1/models', '/models'].entries()) {
    const value = await groupAfter(get(route)); assert.equal(value.group.attempts.length, index === 0 ? 1 : 0); if (index === 0) assert.equal(value.group.attempts[0].accountId, 'a');
  }
  for (const route of ['/api/accounts', '/api/models', '/api/meta', '/api/security', '/api/statistics', '/api/logs/requests', '/api/logs/errors', '/']) await fetch(`http://127.0.0.1:${port}${route}`, { headers: auth });
  assert.equal((await list()).length, expected);
  for (const query of ['unknown=x', 'limit=0', 'status=x', 'requestId=../x', 'cursor=bad', 'cursor=']) assert.equal((await get('/api/logs/details?' + query)).response.status, 400);
  const allText = (dir) => fs.readdirSync(dir, { withFileTypes: true }).map((entry) => entry.isDirectory() ? allText(path.join(dir, entry.name)) : fs.readFileSync(path.join(dir, entry.name), 'utf8')).join('\n');
  const persisted = allText(path.join(running.dir, 'detailed-logs'));
  for (const secret of ['saved-detail-secret', 'detail-admin-secret', 'incoming-cookie-secret', 'upstream-cookie-secret', 'ephemeral-detail-secret', 'ephemeral-proxy-password', 'unread-secret', 'ingress-header-password', 'response-header-password']) assert.equal(persisted.includes(secret), false, secret);
  const ordinary = allText(path.join(running.dir, 'logs')) + fs.readFileSync(path.join(running.dir, 'metadata.json'), 'utf8');
  assert.doesNotMatch(ordinary, /retained prompt|retained output|incoming-cookie-secret|saved-detail-secret/);
  assert.doesNotMatch(running.output(), /saved-detail-secret|detail-admin-secret|incoming-cookie-secret|ephemeral-detail-secret|ephemeral-proxy-password/);
  const countBeforeRestart = (await list()).length;
  await stop(running.child); running = await startSwitcher(null, running.dir);
  assert.equal((await get('/api/logs/settings')).json.detailedLogging, true); assert.equal((await list()).length, countBeforeRestart);
  const ordinaryBefore = allText(path.join(running.dir, 'logs'));
  await get('/api/logs/details', 'DELETE'); assert.equal((await list()).length, 0); assert.equal(allText(path.join(running.dir, 'logs')), ordinaryBefore);
  await rawJson(port, '/api/logs/settings', { detailedLogging: false }, auth);
  await stop(running.child); running = await startSwitcher(null, running.dir); assert.equal((await get('/api/logs/settings')).json.detailedLogging, false);
  await stop(running.child);
  const invalidConfig = JSON.parse(fs.readFileSync(path.join(running.dir, 'config.json'), 'utf8')); invalidConfig.detailedLogging = 'true';
  fs.writeFileSync(path.join(running.dir, 'config.json'), JSON.stringify(invalidConfig));
  running = await startSwitcher(null, running.dir); assert.equal((await get('/api/logs/settings')).json.detailedLogging, false);
});

test('detailed logging removes structured credential component echoes from JSON/SSE groups, APIs and files', async (t) => {
  const encoded = Buffer.from('fixture-basic-user:fixture-basic-password').toString('base64');
  const secrets = ['fixture-bearer-secret', 'fixture-basic-user', 'fixture-basic-password', encoded, 'fixture-cookie-secret', 'fixture-second-cookie', 'fixture-set-cookie', 'fixture-query-first', 'fixture-query-second', 'fixture-query-password', 'fixture-quoted-cookie', 'fixture-quoted-set-cookie', 'fixture-header-cookie', 'fixture-header-set-cookie'];
  const echo = secrets.join(' ');
  const credentials = { AUTHORIZATION: 'Bearer fixture-bearer-secret', proxyAuthorization: 'Basic ' + encoded, COOKIE: 'a=fixture-cookie-secret; b=fixture-second-cookie; quoted="fixture-quoted-cookie"', setCookie: { nested: ['session=fixture-set-cookie; Path=/ordinary-path; Max-Age=12; SameSite=Lax', 'session="fixture-quoted-set-cookie"; Path=/ordinary-path; Max-Age=12; SameSite=Lax'] }, link: 'https://example.org/?api_key=fixture-query-first&api_key=fixture-query-second&password=fixture-query-password' };
  const ordinary = { message: 'ordinary prompt /ordinary-path Lax', max_tokens: 12, usage: { prompt_tokens: 12, completion_tokens: 0, total_tokens: 12 } };
  const upstream = http.createServer((req, res) => {
    const chunks = []; req.on('data', (chunk) => chunks.push(chunk)); req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      assert.equal(body.echo, echo, 'diagnostic sanitization must not change outbound traffic');
      assert.equal(req.headers.cookie, undefined, 'client Cookie remains outside the forwarding allowlist');
      res.setHeader('X-Earlier-Echo', echo);
      res.setHeader('Set-Cookie', 'session="fixture-header-set-cookie"; Path=/ordinary-path; Max-Age=12; SameSite=Lax');
      if (body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: echo } }], ...ordinary }) + '\n\n');
        const tail = 'data: ' + JSON.stringify(credentials) + '\n\ndata: [DONE]\n\n';
        const cut = tail.indexOf('fixture-quoted-cookie') + 8;
        res.write(tail.slice(0, cut)); return setImmediate(() => res.end(tail.slice(cut)));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: echo } }], ...credentials, ...ordinary }));
    });
  });
  const upstreamPort = await listen(upstream), port = await unusedPort();
  const running = await startSwitcher({ port, upstreamBase: `http://127.0.0.1:${upstreamPort}`, detailedLogging: true, proxyKey: 'component-admin-key', accounts: [{ id: 'a', name: 'A', key: 'component-account-key', enabled: true, perModel: {} }], knownModels: ['components'], perModel: {}, accountErrorRules: {} });
  t.after(async () => { await stop(running.child); await close(upstream); fs.rmSync(running.dir, { recursive: true, force: true }); });
  const auth = { 'X-Admin-Key': 'component-admin-key', Cookie: 'session="fixture-header-cookie"' };
  const get = (route) => fetch(`http://127.0.0.1:${port}${route}`, { headers: auth });
  for (const stream of [false, true]) {
    const response = await rawJson(port, '/v1/chat/completions', { model: 'components', messages: [], echo, ...ordinary, stream }, auth);
    assert.equal(response.status, 200);
    for (const secret of secrets) assert.equal(response.text.includes(secret), true, 'client traffic is unchanged: ' + secret);
    const route = '/api/logs/details/' + response.headers['x-cline-request-id'];
    const group = await waitUntil(async () => { const group = await (await get(route)).json(); return group.request?.state === 'complete' && group; });
    assert.equal(group.attempts.length, 1); assert.equal(group.bodies.length, 4);
    for (const secret of secrets) assert.equal(JSON.stringify(group).includes(secret), false, secret);
    for (const descriptor of group.bodies) {
      const text = await (await get(route + '/bodies/' + descriptor.bodyId)).text();
      assert.equal(descriptor.state, 'complete');
      for (const secret of secrets) assert.equal(text.includes(secret), false, secret);
      assert.match(text, /ordinary prompt \/ordinary-path Lax/);
      if (stream && [group.request.responseBody, group.attempts[0].responseBody].includes(descriptor.bodyId)) {
        assert.equal((text.match(/\[DONE\]/g) || []).length, 1);
        const first = JSON.parse(text.split('\n\n')[0].slice(6));
        assert.deepEqual(first.usage, ordinary.usage); assert.equal(first.max_tokens, 12);
      } else { const json = JSON.parse(text); assert.deepEqual(json.usage, ordinary.usage); assert.equal(json.max_tokens, 12); }
    }
  }
  const allText = (dir) => fs.readdirSync(dir, { withFileTypes: true }).map((entry) => entry.isDirectory() ? allText(path.join(dir, entry.name)) : fs.readFileSync(path.join(dir, entry.name), 'utf8')).join('\n');
  const persisted = allText(path.join(running.dir, 'detailed-logs')) + allText(path.join(running.dir, 'logs')) + fs.readFileSync(path.join(running.dir, 'metadata.json'), 'utf8');
  const listing = await (await get('/api/logs/details')).text();
  for (const secret of secrets) for (const output of [persisted, listing, running.output()]) assert.equal(output.includes(secret), false, secret);
});

test('detailed logging discovers original credential syntax and bounds assignment work through authenticated APIs', async (t) => {
  const secret = 'prefix-fixture-long-secret';
  for (const [known, header, value, requestCredential = false] of [
    ['https', 'X-Debug', `https://example.test/?api_key=${secret}`],
    ['Bearer', 'X-Debug', `Bearer ${secret}`],
    ['api_key', 'X-Debug', `https://example.test/?api_key=${secret}`],
    ['prefix-', 'X-Credential', `https://example.test/?api_key=${secret}`],
    ['nested-debug-fixture', 'X-Debug', `Bearer https://example.test/?api_key=${secret}`],
    ['nested-header-fixture', 'X-Credential', `Bearer https://example.test/?api_key=${secret}`],
    ['assignment-header-fixture', 'X-Credential', `Bearer api_key=${secret}`, true]
  ]) await t.test(`${known}/${header}`, async (t) => {
    const seen = [];
    const upstream = http.createServer((req, res) => {
      const chunks = []; req.on('data', (chunk) => chunks.push(chunk)); req.on('end', () => {
        const input = Buffer.concat(chunks).toString(); seen.push(input); const body = JSON.parse(input);
        const payload = JSON.stringify({ choices: [{ message: { content: secret } }], message: 'ordinary output' });
        res.writeHead(200, { [header]: value, 'X-Earlier-Echo': secret, 'Content-Type': body.stream ? 'text/event-stream' : 'application/json' });
        res.end(body.stream ? 'data: ' + payload + '\n\ndata: [DONE]\n\n' : payload);
      });
    });
    const upstreamPort = await listen(upstream), port = await unusedPort();
    const running = await startSwitcher({ port, upstreamBase: `http://127.0.0.1:${upstreamPort}`, proxyKey: 'p1-admin-fixture', accounts: [{ id: 'a', name: 'A', key: known, enabled: true, perModel: {} }], knownModels: ['p1'], perModel: {}, accountErrorRules: {} });
    t.after(async () => { await stop(running.child); await close(upstream); fs.rmSync(running.dir, { recursive: true, force: true }); });
    const auth = { 'X-Admin-Key': 'p1-admin-fixture' }, get = (route) => fetch(`http://127.0.0.1:${port}${route}`, { headers: auth });
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/logs/details`)).status, 401);
    for (const stream of [false, true]) for (const count of known === 'https' ? [0, 16384, 16385] : [0]) {
      const input = { model: 'p1', messages: [], stream, echo: secret, message: 'ordinary prompt', ...(count ? { assignments: 'key=x;'.repeat(count) } : {}) };
      const requestHeaders = { ...auth, 'X-Earlier-Echo': secret, ...(requestCredential ? { [header]: value } : {}) };
      assert.equal((await rawJson(port, '/api/logs/settings', { detailedLogging: false }, auth)).status, 200);
      const off = await rawJson(port, '/v1/chat/completions', input, requestHeaders);
      assert.equal((await rawJson(port, '/api/logs/settings', { detailedLogging: true }, auth)).status, 200);
      const on = await rawJson(port, '/v1/chat/completions', input, requestHeaders);
      assert.equal(on.status, 200); assert.equal(on.status, off.status); assert.equal(on.text, off.text); assert.equal(seen.at(-1), seen.at(-2));
      assert.ok(on.text.includes(secret), 'only diagnostics are sanitized');
      const route = '/api/logs/details/' + on.headers['x-cline-request-id'];
      const group = await waitUntil(async () => { const group = await (await get(route)).json(); return group.request && group.request.state !== 'open' && group; });
      assert.equal(group.request.state, count > 16384 ? 'resource-limited' : 'complete');
      assert.equal(group.request.result, 'success'); assert.equal(group.request.complete, true);
      assert.equal(group.attempts.length, 1); assert.equal(group.bodies.length, 4);
      assert.equal(JSON.stringify(group).includes('fixture-long-secret'), false);
      assert.equal((await fetch(`http://127.0.0.1:${port}${route}/bodies/${group.request.requestBody}`)).status, 401);
      for (const descriptor of group.bodies) {
        const response = await get(route + '/bodies/' + descriptor.bodyId); assert.equal(response.status, 200);
        const text = await response.text(); assert.equal(text.includes('fixture-long-secret'), false); assert.equal(descriptor.complete, true);
        if (count > 16384) { assert.equal(text, ''); assert.equal(descriptor.state, 'resource-limited'); }
        else {
          assert.equal(descriptor.state, 'complete'); assert.match(text, /ordinary (?:prompt|output)/);
          if (count && descriptor.bodyId === group.request.requestBody) assert.equal(JSON.parse(text).assignments, 'key=[REDACTED];'.repeat(count));
        }
      }
    }
    const allText = (dir) => fs.readdirSync(dir, { withFileTypes: true }).map((entry) => entry.isDirectory() ? allText(path.join(dir, entry.name)) : fs.readFileSync(path.join(dir, entry.name), 'utf8')).join('\n');
    const persisted = allText(path.join(running.dir, 'detailed-logs')) + allText(path.join(running.dir, 'logs')) + fs.readFileSync(path.join(running.dir, 'metadata.json'), 'utf8');
    for (const output of [persisted, await (await get('/api/logs/details')).text(), running.output()]) assert.equal(output.includes('fixture-long-secret'), false);
    assert.ok((await (await get('/api/accounts')).json()).accounts.every((account) => account.activeCount === 0));
    await waitUntil(async () => (await (await get('/api/logs/settings')).json()).health.retainedPayloadBytes === 0);
  });
});

test('outer scheme shadowing never exposes inner credentials through authenticated detail APIs or files', async (t) => {
  const fixtures = [
    ['prefix-fixture;tail-fixture', 'Bearer https://example.test/?api_key=prefix-fixture;tail-fixture'],
    ['prefix-fixture,tail-fixture', 'Bearer https://example.test/?api_key=prefix-fixture,tail-fixture'],
    ['fixture-nested-secret', 'Bearer api_key=fixture-nested-secret']
  ], seen = [];
  const upstream = http.createServer((req, res) => {
    const chunks = []; req.on('data', (chunk) => chunks.push(chunk)); req.on('end', () => {
      const input = Buffer.concat(chunks).toString(); seen.push(input); const body = JSON.parse(input), [secret, syntax] = fixtures[body.caseIndex];
      const payload = JSON.stringify({ choices: [{ message: { content: secret } }], message: 'ordinary output' });
      res.writeHead(200, { 'X-Earlier-Echo': secret, 'X-Debug': syntax, 'Content-Type': body.stream ? 'text/event-stream' : 'application/json' });
      res.end(body.stream ? 'data: ' + payload + '\n\ndata: [DONE]\n\n' : payload);
    });
  });
  const upstreamPort = await listen(upstream), port = await unusedPort();
  const running = await startSwitcher({ port, upstreamBase: `http://127.0.0.1:${upstreamPort}`, proxyKey: 'shadow-admin-fixture', accounts: [{ id: 'a', name: 'A', key: 'shadow-account-fixture', enabled: true, perModel: {} }], knownModels: ['shadow'], perModel: {}, accountErrorRules: {} });
  t.after(async () => { await stop(running.child); await close(upstream); fs.rmSync(running.dir, { recursive: true, force: true }); });
  const auth = { 'X-Admin-Key': 'shadow-admin-fixture' }, get = (route) => fetch(`http://127.0.0.1:${port}${route}`, { headers: auth });
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/logs/details`)).status, 401);
  for (const [caseIndex, [secret]] of fixtures.entries()) await t.test(`shape ${caseIndex}`, async () => {
    for (const stream of [false, true]) {
      const input = { model: 'shadow', messages: [], caseIndex, stream, echo: secret, message: 'ordinary prompt' };
      assert.equal((await rawJson(port, '/api/logs/settings', { detailedLogging: false }, auth)).status, 200);
      const off = await rawJson(port, '/v1/chat/completions', input, { ...auth, 'X-Earlier-Echo': secret });
      assert.equal((await rawJson(port, '/api/logs/settings', { detailedLogging: true }, auth)).status, 200);
      const on = await rawJson(port, '/v1/chat/completions', input, { ...auth, 'X-Earlier-Echo': secret });
      assert.equal(on.status, 200); assert.equal(on.status, off.status); assert.equal(on.text, off.text); assert.equal(seen.at(-1), seen.at(-2));
      assert.ok(on.text.includes(secret), 'forwarding is not diagnostic sanitization');
      const route = '/api/logs/details/' + on.headers['x-cline-request-id'];
      const group = await waitUntil(async () => { const group = await (await get(route)).json(); return group.request && group.request.state !== 'open' && group; });
      assert.equal(group.request.state, 'complete'); assert.equal(group.request.result, 'success');
      assert.equal(group.attempts.length, 1); assert.equal(group.bodies.length, 4);
      for (const forbidden of [secret, 'tail-fixture', 'fixture-nested-secret']) assert.equal(JSON.stringify(group).includes(forbidden), false);
      assert.equal((await fetch(`http://127.0.0.1:${port}${route}/bodies/${group.request.requestBody}`)).status, 401);
      for (const descriptor of group.bodies) {
        const response = await get(route + '/bodies/' + descriptor.bodyId); assert.equal(response.status, 200); const text = await response.text();
        assert.equal(descriptor.state, 'complete'); assert.equal(descriptor.complete, true); assert.match(text, /ordinary (?:prompt|output)/);
        for (const forbidden of [secret, 'tail-fixture', 'fixture-nested-secret']) assert.equal(text.includes(forbidden), false);
      }
    }
  });
  const allText = (dir) => fs.readdirSync(dir, { withFileTypes: true }).map((entry) => entry.isDirectory() ? allText(path.join(dir, entry.name)) : fs.readFileSync(path.join(dir, entry.name), 'utf8')).join('\n');
  const persisted = allText(path.join(running.dir, 'detailed-logs')) + allText(path.join(running.dir, 'logs')) + fs.readFileSync(path.join(running.dir, 'metadata.json'), 'utf8');
  for (const output of [persisted, await (await get('/api/logs/details')).text(), running.output()]) assert.doesNotMatch(output, /tail-fixture|fixture-nested-secret/);
  assert.ok((await (await get('/api/accounts')).json()).accounts.every((account) => account.activeCount === 0));
  await waitUntil(async () => (await (await get('/api/logs/settings')).json()).health.retainedPayloadBytes === 0);
});

test('detailed logging fences ambiguous escaped credential discovery across APIs/files without changing JSON/SSE traffic', async (t) => {
  const secret = 'fixture-escaped-secret', escaped = 'password=\\u0066ixture-escaped-secret', seen = [];
  const upstream = http.createServer((req, res) => {
    const chunks = []; req.on('data', (chunk) => chunks.push(chunk)); req.on('end', () => {
      const input = Buffer.concat(chunks).toString(); seen.push(input); const body = JSON.parse(input);
      const payload = { choices: [{ message: { content: secret } }], ...(body.model !== 'header' ? { nested: { message: escaped } } : {}) };
      res.setHeader('X-Earlier-Echo', secret);
      if (body.model === 'header') res.setHeader('X-Diagnostic', escaped);
      res.setHeader('Content-Type', body.stream ? 'text/event-stream' : 'application/json');
      res.end(body.stream ? 'data: ' + JSON.stringify(payload) + '\n\ndata: [DONE]\n\n' : JSON.stringify(payload));
    });
  });
  const upstreamPort = await listen(upstream), port = await unusedPort();
  const running = await startSwitcher({ port, upstreamBase: `http://127.0.0.1:${upstreamPort}`, accounts: [{ id: 'a', name: 'A', key: 'escaped-account-key', enabled: true, perModel: {} }], knownModels: ['header', 'json', 'sse'], perModel: {}, accountErrorRules: {} });
  t.after(async () => { await stop(running.child); await close(upstream); fs.rmSync(running.dir, { recursive: true, force: true }); });
  const get = (route) => fetch(`http://127.0.0.1:${port}${route}`);
  for (const model of ['header', 'json', 'sse']) {
    const input = { model, stream: model === 'sse', messages: [], echo: secret };
    await rawJson(port, '/api/logs/settings', { detailedLogging: false });
    const off = await rawJson(port, '/v1/chat/completions', input, { 'X-Earlier-Echo': secret });
    await rawJson(port, '/api/logs/settings', { detailedLogging: true });
    const on = await rawJson(port, '/v1/chat/completions', input, { 'X-Earlier-Echo': secret });
    assert.equal(on.status, off.status); assert.equal(on.text, off.text); assert.equal(seen.at(-1), seen.at(-2));
    assert.match(on.text, /fixture-escaped-secret/, 'traffic retains the original content');
    const route = '/api/logs/details/' + on.headers['x-cline-request-id'];
    const group = await waitUntil(async () => { const group = await (await get(route)).json(); return group.request?.state === 'incomplete' && group; });
    assert.equal(group.attempts.length, 1); assert.equal(group.bodies.length, 4);
    assert.equal(group.request.complete, true); assert.equal(group.request.result, 'success');
    assert.equal(JSON.stringify(group).includes(secret), false);
    for (const body of group.bodies) {
      assert.equal(body.state, 'omitted-for-safety'); assert.equal(body.complete, true); assert.equal(body.capturedBytes, 0);
      const response = await get(route + '/bodies/' + body.bodyId); assert.equal(response.status, 200); assert.equal(await response.text(), '');
    }
  }
  const allText = (dir) => fs.readdirSync(dir, { withFileTypes: true }).map((entry) => entry.isDirectory() ? allText(path.join(dir, entry.name)) : fs.readFileSync(path.join(dir, entry.name), 'utf8')).join('\n');
  const persisted = allText(path.join(running.dir, 'detailed-logs')) + allText(path.join(running.dir, 'logs')) + fs.readFileSync(path.join(running.dir, 'metadata.json'), 'utf8');
  for (const output of [persisted, await (await get('/api/logs/details')).text(), running.output()]) assert.equal(output.includes(secret), false);
  assert.ok((await (await get('/api/accounts')).json()).accounts.every((account) => account.activeCount === 0));
});

test('detailed logging fails closed across APIs and files on capped or interrupted credential discovery without changing traffic', { timeout: 30000 }, async (t) => {
  const secret = 'sk-demo-secret-capture', forbidden = [secret, 'demo-secret-capture', 'secret-capture'];
  const cap = 5 * 1024 * 1024, seen = [], fixtures = new Map();
  for (const kind of ['cap', 'interrupted']) for (const stream of [false, true]) for (const field of ['api_key', 'Cookie']) {
    const model = `${kind}-${stream ? 'sse' : 'json'}-${field}`;
    const value = field === 'Cookie' ? `session="${secret}"` : secret;
    const head = stream ? 'data: ' + JSON.stringify({ choices: [{ delta: { content: secret } }] }) + '\n\ndata: ' : '';
    const json = (padding) => JSON.stringify({ choices: [{ message: { content: secret } }], padding, [field]: value });
    const bare = head + json('');
    const padding = kind === 'cap' ? 'x'.repeat(cap - bare.lastIndexOf(secret) - 3) : '';
    const full = head + json(padding) + (stream ? '\n\ndata: [DONE]\n\n' : '');
    const wire = kind === 'interrupted' ? full.slice(0, full.lastIndexOf(secret) + 3) : full;
    fixtures.set(model, { kind, stream, wire });
  }
  // A partial data field is not necessarily JSON. Never learn an unfinished
  // plain-text Bearer value as though its observed prefix were the whole token.
  for (const kind of ['cap', 'interrupted']) {
    const sse = (padding) => 'data: ' + JSON.stringify({ choices: [{ delta: { content: secret } }] }) + '\n\n: ' + padding + '\n\ndata: Bearer ' + secret + '\n\n';
    const bare = sse(''), full = sse(kind === 'cap' ? 'x'.repeat(cap - bare.lastIndexOf(secret) - 3) : '');
    const wire = kind === 'interrupted' ? full.slice(0, full.lastIndexOf(secret) + 3) : full;
    fixtures.set(`${kind}-sse-prose`, { kind, stream: true, wire });
  }
  const upstream = http.createServer((req, res) => {
    const chunks = []; req.on('data', (chunk) => chunks.push(chunk)); req.on('end', () => {
      const input = Buffer.concat(chunks).toString(); seen.push(input);
      const body = JSON.parse(input), fixture = fixtures.get(body.model);
      assert.equal(body.echo, secret);
      res.writeHead(200, { 'Content-Type': fixture.stream ? 'text/event-stream' : 'application/json', 'X-Earlier-Echo': secret });
      if (fixture.kind === 'interrupted') { res.write(fixture.wire); return setTimeout(() => res.destroy(), 30); }
      res.end(fixture.wire);
    });
  });
  const upstreamPort = await listen(upstream), port = await unusedPort();
  const running = await startSwitcher({ port, upstreamBase: `http://127.0.0.1:${upstreamPort}`, accounts: [{ id: 'a', name: 'A', key: 'cap-account-key', enabled: true, perModel: {} }], knownModels: [...fixtures.keys()], perModel: {}, accountErrorRules: {} });
  t.after(async () => { await stop(running.child); await close(upstream); fs.rmSync(running.dir, { recursive: true, force: true }); });
  const get = (route) => fetch(`http://127.0.0.1:${port}${route}`);
  const responseFor = (model, stream) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Earlier-Echo': secret } }, (res) => {
      const chunks = []; res.on('data', (chunk) => chunks.push(chunk));
      const finish = () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString(), complete: res.complete });
      res.on('end', finish); res.on('aborted', finish); res.on('error', (error) => { if (error.code !== 'ECONNRESET') reject(error); });
    });
    req.on('error', reject); req.end(JSON.stringify({ model, messages: [], stream, echo: secret }));
  });
  for (const [model, fixture] of fixtures) {
    await rawJson(port, '/api/logs/settings', { detailedLogging: false });
    const off = await responseFor(model, fixture.stream);
    await rawJson(port, '/api/logs/settings', { detailedLogging: true });
    const on = await responseFor(model, fixture.stream);
    assert.equal(on.status, off.status); assert.equal(on.text, off.text); assert.equal(on.complete, off.complete);
    assert.equal(seen.at(-1), seen.at(-2), 'actual upstream request bytes unchanged');
    if (fixture.kind === 'cap' || fixture.stream) assert.equal(on.text, fixture.wire);
    const route = '/api/logs/details/' + on.headers['x-cline-request-id'];
    const group = await waitUntil(async () => { const group = await (await get(route)).json(); return group.request?.state === 'incomplete' && group; }, 5000);
    assert.equal(group.attempts.length, 1); assert.equal(group.bodies.length, 4);
    const upstreamBody = group.bodies.find((body) => body.bodyId === group.attempts[0].responseBody);
    assert.equal(upstreamBody.observedBytes, Buffer.byteLength(fixture.wire));
    assert.equal(upstreamBody.complete, fixture.kind === 'cap'); assert.equal(upstreamBody.truncated, fixture.kind === 'cap');
    for (const descriptor of group.bodies) {
      assert.equal(descriptor.state, 'omitted-for-safety'); assert.equal(descriptor.capturedBytes, 0);
      const response = await get(route + '/bodies/' + descriptor.bodyId); assert.equal(response.status, 200); assert.equal(await response.text(), '');
    }
    for (const headers of [group.request.headers, group.request.responseHeaders, group.attempts[0].headers, group.attempts[0].responseHeaders]) assert.match(JSON.stringify(headers), /OMITTED/);
    for (const value of forbidden) assert.equal(JSON.stringify(group).includes(value), false);
  }
  const allText = (dir) => fs.readdirSync(dir, { withFileTypes: true }).map((entry) => entry.isDirectory() ? allText(path.join(dir, entry.name)) : fs.readFileSync(path.join(dir, entry.name), 'utf8')).join('\n');
  const persisted = allText(path.join(running.dir, 'detailed-logs')) + allText(path.join(running.dir, 'logs')) + fs.readFileSync(path.join(running.dir, 'metadata.json'), 'utf8');
  for (const value of forbidden) for (const output of [persisted, await (await get('/api/logs/details')).text(), running.output()]) assert.equal(output.includes(value), false, value);
  assert.ok((await (await get('/api/accounts')).json()).accounts.every((account) => account.activeCount === 0));
});

test('detailed logging preserves JSON/SSE bytes, cancellation, retries, snapshots and active clear', { timeout: 20000 }, async (t) => {
  const held = new Map(), seen = [];
  const sse = 'data: {"choices":[{"delta":{"content":"你好 stream-detail-secret"}}]}\n\ndata: [DONE]\n\n';
  const upstream = http.createServer((req, res) => {
    const chunks = []; req.on('data', (c) => chunks.push(c)); req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}'); seen.push(body);
      if (body.model === 'network') return res.destroy();
      if (body.model === 'nonstream-cancel') { held.set(body.model, res); return; }
      if (body.model === 'replace' && req.headers.authorization === 'Bearer stream-detail-secret') { res.writeHead(429, { 'Content-Type': 'application/json' }); return res.end('{"error":{"message":"retry replacement","status":429}}'); }
      if (body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        if (body.model === 'hold' || body.model === 'cancel') { res.write('data: {"choices":[{"delta":{"content":"safe partial output"}}]}\n\n'); held.set(body.mark || body.model, res); return; }
        if (body.model === 'done-close') return res.write(sse);
        if (body.model === 'late') return res.end('data: {"choices":[{"delta":{"content":"started"}}]}\n\ndata: {"error":{"message":"late failure","status":502}}\n\ndata: [DONE]\n\n');
        const bytes = Buffer.from(sse); res.write(bytes.subarray(0, 49)); return setImmediate(() => res.end(bytes.subarray(49)));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: body.model === 'large' ? 'x'.repeat(5 * 1024 * 1024 + 100) : 'unchanged output' } }] }));
    });
  });
  const upstreamPort = await listen(upstream), port = await unusedPort();
  const running = await startSwitcher({ port, upstreamBase: `http://127.0.0.1:${upstreamPort}`, accounts: [{ id: 'a', name: 'A', key: 'stream-detail-secret', enabled: true, perModel: {} }, { id: 'b', name: 'B', key: 'other-detail-secret', enabled: true, perModel: {} }], knownModels: ['sse', 'hold', 'cancel', 'large', 'late', 'replace', 'network'], perModel: {}, accountErrorRules: { 429: { action: 'cooldown', cooldownMs: 60000 } } });
  t.after(async () => { await stop(running.child); for (const res of held.values()) res.destroy(); await close(upstream); fs.rmSync(running.dir, { recursive: true, force: true }); });
  const api = async (route, method = 'GET') => (await fetch(`http://127.0.0.1:${port}${route}`, { method })).json();
  const settings = (mode) => rawJson(port, '/api/logs/settings', { detailedLogging: mode });
  const groupFor = async (id) => waitUntil(async () => { const group = await api('/api/logs/details/' + id); return group.request && group.request.state !== 'open' && group; }, 5000);
  const bodyFor = async (group, id) => (await fetch(`http://127.0.0.1:${port}/api/logs/details/${group.request.requestId}/bodies/${id}`)).text();
  const off = await rawJson(port, '/v1/chat/completions', { model: 'sse', messages: [], stream: true });
  await settings(true);
  const on = await rawJson(port, '/v1/chat/completions', { model: 'sse', messages: [], stream: true });
  assert.equal(on.text, off.text); assert.equal(on.text, sse); assert.deepEqual(seen[0], seen[1]);
  const streamed = await groupFor(on.headers['x-cline-request-id']);
  assert.equal(streamed.attempts.length, 1);
  for (const id of [streamed.request.responseBody, streamed.attempts[0].responseBody]) {
    const descriptor = streamed.bodies.find((b) => b.bodyId === id);
    assert.equal(descriptor.observedBytes, Buffer.byteLength(sse)); assert.equal(descriptor.complete, true);
    const text = await bodyFor(streamed, id); assert.match(text, /你好/); assert.doesNotMatch(text, /stream-detail-secret/); assert.equal((text.match(/\[DONE\]/g) || []).length, 1);
  }
  const pending = rawJson(port, '/v1/chat/completions', { model: 'hold', mark: 'snapshot', messages: [], stream: true });
  await waitUntil(() => held.has('snapshot')); await settings(false); held.get('snapshot').end('data: [DONE]\n\n');
  const snapshot = await pending; assert.equal((await groupFor(snapshot.headers['x-cline-request-id'])).attempts.length, 1);
  const disabled = await rawJson(port, '/v1/chat/completions', { model: 'sse', messages: [], stream: true });
  assert.equal((await api('/api/logs/details/' + disabled.headers['x-cline-request-id'])).error.message, 'detailed record unavailable');
  await settings(true);
  const clearing = rawJson(port, '/v1/chat/completions', { model: 'hold', mark: 'clear', messages: [], stream: true });
  await waitUntil(() => held.has('clear')); await api('/api/logs/details', 'DELETE'); held.get('clear').end('data: [DONE]\n\n'); const cleared = await clearing;
  await new Promise((r) => setTimeout(r, 30)); assert.equal((await api('/api/logs/details')).items.length, 0);
  assert.equal((await api('/api/logs/details/' + cleared.headers['x-cline-request-id'])).error.message, 'detailed record unavailable');
  for (const model of ['cancel', 'done-close', 'nonstream-cancel']) {
    const streaming = model !== 'nonstream-cancel';
    await disconnectRequest(port, { model, stream: streaming, messages: [] }, streaming, model === 'done-close' ? '[DONE]' : 'safe partial output');
    const row = await waitUntil(async () => (await api('/api/logs/details')).items.find((row) => row.model === model && row.state !== 'open'));
    const group = await groupFor(row.requestId); assert.equal(group.request.complete, false);
    assert.equal(group.request.result, model === 'done-close' ? 'success' : 'client_cancelled');
    if (streaming) assert.match(await bodyFor(group, group.request.responseBody), model === 'done-close' ? /\[DONE\]/ : /safe partial output/);
    else { assert.equal(group.request.status, null); assert.equal(group.bodies.find((body) => body.bodyId === group.request.responseBody).state, 'unread'); }
    const ordinary = await waitUntil(async () => (await api('/api/logs/requests?model=' + model)).items[0]);
    assert.equal(ordinary.result, model === 'done-close' ? 'success' : 'client_cancelled');
  }
  for (const model of ['late', 'network', 'replace', 'large']) {
    const response = await rawJson(port, '/v1/chat/completions', { model, messages: [], ...(model === 'late' ? { stream: true } : {}) });
    const group = await groupFor(response.headers['x-cline-request-id']);
    if (model === 'replace') assert.deepEqual(group.attempts.map((a) => a.accountId), ['a', 'b']);
    if (model === 'network') { assert.equal(group.attempts[0].state, 'transport-failed'); assert.equal(group.bodies.at(-1).state, 'unread'); }
    if (model === 'large') {
      assert.equal(response.json.choices[0].message.content.length, 5 * 1024 * 1024 + 100);
      await settings(false); const withoutDetails = await rawJson(port, '/v1/chat/completions', { model, messages: [] }); await settings(true);
      assert.equal(response.text, withoutDetails.text, 'large JSON forwarding must be byte-equivalent with capture off');
      for (const id of [group.request.responseBody, group.attempts[0].responseBody]) { const body = group.bodies.find((b) => b.bodyId === id); assert.equal(body.truncated, true); assert.equal(body.capturedBytes, 5 * 1024 * 1024); assert.match(await bodyFor(group, id), /xxxxx/); }
    }
  }
  const malformed = await new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST' }, (res) => { res.resume(); res.on('end', () => resolve({ status: res.statusCode, id: res.headers['x-cline-request-id'] })); }); req.on('error', reject); req.end('{"key":"unsafe partial');
  });
  assert.equal(malformed.status, 400); assert.equal((await groupFor(malformed.id)).bodies[0].state, 'omitted-for-safety');
  const declared = await new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST', headers: { 'Content-Length': 51 * 1024 * 1024, Connection: 'close' } }, (res) => { res.resume(); res.on('end', () => { req.destroy(); resolve({ status: res.statusCode, id: res.headers['x-cline-request-id'] }); }); }); req.on('error', reject); req.end('{}');
  });
  assert.equal(declared.status, 413); assert.equal((await groupFor(declared.id)).bodies[0].state, 'unread');
  const oversized = await pausedOversizedJson(port, '/v1/chat/completions'); assert.equal(oversized.status, 413);
  const oversizedGroup = await groupFor(oversized.headers['x-cline-request-id']); assert.equal(oversizedGroup.bodies[0].truncated, true); assert.equal(oversizedGroup.bodies[0].complete, false);
  assert.ok((await api('/api/accounts')).accounts.every((a) => a.activeCount === 0));
});

test('detailed clear reports abandoned-temp deletion failures and recovers without changing authenticated traffic', async (t) => {
  const upstream = http.createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"choices":[{"message":{"content":"sanitized fixture output"}}]}'); }); });
  const upstreamPort = await listen(upstream), port = await unusedPort(), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cps-detail-p1-fault-'));
  const loader = path.join(dir, 'fault-loader.mjs'), fault = path.join(dir, 'fault');
  fs.writeFileSync(loader, `import fs from 'node:fs'; import fsp from 'node:fs/promises'; import path from 'node:path';
const rename=fsp.rename, rm=fsp.rm;
fsp.rename=async(a,b)=>{if(b.includes('/detailed-logs/')&&b.endsWith('/manifest.json')&&fs.existsSync(${JSON.stringify(fault)}))throw Error('PRIVATE final publication failure');return rename(a,b);};
fsp.rm=async(a,...args)=>{if(String(a).includes('/detailed-logs/')&&path.basename(a).startsWith('.tmp-')&&fs.existsSync(${JSON.stringify(fault)}))throw Error('PRIVATE temporary cleanup failure');return rm(a,...args);};`);
  const running = await startSwitcher({ port, upstreamBase: `http://127.0.0.1:${upstreamPort}`, proxyKey: 'clear-admin-fixture', accounts: [{ id: 'a', name: 'A', key: 'clear-account-fixture', enabled: true, perModel: {} }], knownModels: ['p1'], perModel: {}, accountErrorRules: {} }, dir, { NODE_OPTIONS: `--import=${loader}` });
  t.after(async () => { await stop(running.child); await close(upstream); fs.rmSync(dir, { recursive: true, force: true }); });
  const auth = { 'X-Admin-Key': 'clear-admin-fixture' }, api = (route, method = 'GET') => fetch(`http://127.0.0.1:${port}${route}`, { headers: auth, method });
  const input = { model: 'p1', messages: [], message: 'sanitized fixture prompt' };
  const off = await rawJson(port, '/v1/chat/completions', input, auth);
  await rawJson(port, '/api/logs/settings', { detailedLogging: true }, auth);
  const successful = await rawJson(port, '/v1/chat/completions', input, auth), successfulRoute = '/api/logs/details/' + successful.headers['x-cline-request-id'];
  await waitUntil(async () => (await (await api(successfulRoute)).json()).request?.state === 'complete');
  const detailsDir = path.join(dir, 'detailed-logs'), temps = () => fs.readdirSync(detailsDir).filter((name) => name.startsWith('.tmp-'));
  for (const boundary of ['maintenance', 'clear']) {
    fs.writeFileSync(fault, '');
    const failures = (await (await api('/api/logs/settings')).json()).health.failures;
    const response = await rawJson(port, '/v1/chat/completions', input, auth);
    assert.equal(response.status, off.status); assert.equal(response.text, off.text);
    await waitUntil(async () => { const health = (await (await api('/api/logs/settings')).json()).health; return health.failures >= failures + 2 && health.retainedPayloadBytes === 0; });
    assert.equal(temps().length, 1);
    if (boundary === 'clear') {
      assert.equal((await fetch(`http://127.0.0.1:${port}/api/logs/details`, { method: 'DELETE' })).status, 401);
      const failed = await api('/api/logs/details', 'DELETE'); assert.equal(failed.status, 503);
      assert.deepEqual(await failed.json(), { error: { message: 'detailed storage unavailable' } });
      assert.equal(temps().length, 1);
    }
    fs.unlinkSync(fault);
    if (boundary === 'maintenance') {
      assert.equal((await api('/api/logs/details')).status, 200);
      assert.equal((await (await api(successfulRoute)).json()).request.state, 'complete');
    } else {
      assert.equal((await api('/api/logs/details', 'DELETE')).status, 200); assert.deepEqual(fs.readdirSync(detailsDir), []);
    }
    assert.equal(temps().length, 0);
  }
  const fresh = await rawJson(port, '/v1/chat/completions', input, auth); assert.equal(fresh.text, off.text);
  await waitUntil(async () => (await (await api('/api/logs/details/' + fresh.headers['x-cline-request-id'])).json()).request?.state === 'complete');
  assert.ok((await (await api('/api/logs/requests')).json()).items.length >= 4, 'detail clear never clears ordinary logs');
  assert.ok((await (await api('/api/accounts')).json()).accounts.every((account) => account.activeCount === 0));
  assert.doesNotMatch(running.output(), /PRIVATE|clear-account-fixture|clear-admin-fixture/);
});

test('detailed logging persists open roots across process interruption and keeps config/traffic safe on IO failure', { timeout: 20000 }, async (t) => {
  const held = [];
  const upstream = http.createServer((req, res) => { req.resume(); req.on('end', () => { if (req.headers['x-hold']) { held.push(res); return; } res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"choices":[{"message":{"content":"still works"}}]}'); }); });
  const upstreamPort = await listen(upstream), port = await unusedPort(), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cps-detail-fault-'));
  const loader = path.join(dir, 'fault-loader.mjs'), configFault = path.join(dir, 'config-fault'), detailFault = path.join(dir, 'detail-fault'), slow = path.join(dir, 'slow-write');
  fs.writeFileSync(loader, `import fs from 'node:fs'; import fsp from 'node:fs/promises';
const syncRename=fs.renameSync, rename=fsp.rename, write=fsp.writeFile;
fs.renameSync=(a,b)=>{if(b.endsWith('/config.json')&&fs.existsSync(${JSON.stringify(configFault)}))throw Error('MOCK PRIVATE ENOSPC');return syncRename(a,b);};
fsp.rename=async(a,b)=>{if(b.includes('/detailed-logs/')&&fs.existsSync(${JSON.stringify(detailFault)}))throw Error('MOCK PRIVATE ENOSPC');return rename(a,b);};
fsp.writeFile=async(a,...args)=>{while(String(a).endsWith('.txt')&&fs.existsSync(${JSON.stringify(slow)}))await new Promise(r=>setTimeout(r,5));return write(a,...args);};`);
  const extra = { NODE_OPTIONS: `--import=${loader}` };
  let running = await startSwitcher({ port, upstreamBase: `http://127.0.0.1:${upstreamPort}`, detailedLogging: true, accounts: [{ id: 'a', name: 'A', key: 'fault-secret', enabled: true, headers: { 'X-Hold': 'yes' }, perModel: {} }], knownModels: ['hold'], perModel: {}, accountErrorRules: {} }, dir, extra);
  t.after(async () => { await stop(running.child); for (const res of held) res.destroy(); await close(upstream); fs.rmSync(dir, { recursive: true, force: true }); });
  const pending = rawJson(port, '/v1/chat/completions', { model: 'hold', messages: [] }).catch(() => null);
  await waitUntil(() => held.length > 0);
  const rows = await waitUntil(async () => { const rows = (await (await fetch(`http://127.0.0.1:${port}/api/logs/details`)).json()).items; return rows.length && rows; });
  assert.equal(rows[0].state, 'open');
  await stop(running.child); await pending;
  const config = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')); config.accounts[0].headers = {};
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config));
  running = await startSwitcher(null, dir, extra);
  const recovered = await (await fetch(`http://127.0.0.1:${port}/api/logs/details/${rows[0].requestId}`)).json();
  assert.equal(recovered.request.state, 'interrupted'); assert.equal(recovered.request.complete, false); assert.equal(recovered.bodies.length, 0);
  const before = fs.readFileSync(path.join(dir, 'config.json'));
  fs.writeFileSync(configFault, '');
  assert.equal((await rawJson(port, '/api/logs/settings', { detailedLogging: false })).status, 500);
  assert.deepEqual(fs.readFileSync(path.join(dir, 'config.json')), before);
  assert.equal((await (await fetch(`http://127.0.0.1:${port}/api/logs/settings`)).json()).detailedLogging, true);
  fs.unlinkSync(configFault);
  fs.writeFileSync(detailFault, '');
  const failed = await rawJson(port, '/v1/chat/completions', { model: 'hold', messages: [] }); assert.equal(failed.status, 200); assert.match(failed.text, /still works/);
  await waitUntil(async () => (await (await fetch(`http://127.0.0.1:${port}/api/logs/settings`)).json()).health.failures > 0);
  fs.unlinkSync(detailFault);
  fs.writeFileSync(slow, '');
  const t0 = Date.now(), normal = await rawJson(port, '/v1/chat/completions', { model: 'hold', messages: [] });
  assert.equal(normal.status, 200); assert.ok(Date.now() - t0 < 1000, 'model completion must not await blocked diagnostic writes');
  const memory = (await (await fetch(`http://127.0.0.1:${port}/api/logs/settings`)).json()).health.retainedPayloadBytes;
  assert.ok(memory > 0 && memory <= 64 * 1024 * 1024);
  fs.unlinkSync(slow);
  assert.doesNotMatch(running.output(), /MOCK PRIVATE|fault-secret/);
  await waitUntil(async () => { const group = await (await fetch(`http://127.0.0.1:${port}/api/logs/details/${normal.headers['x-cline-request-id']}`)).json(); return group.request?.state === 'complete'; });
  for (const size of [16, 16385]) {
    const pathological = await rawJson(port, '/v1/chat/completions', { model: 'hold', messages: [], password: ['A', 'D', 'E', 'R', 'T', 'C', '[', ']'], echo: 'A'.repeat(size) });
    assert.equal(pathological.status, normal.status); assert.equal(pathological.text, normal.text, 'sanitizer work must not change traffic');
    const state = size === 16 ? 'complete' : 'resource-limited';
    const group = await waitUntil(async () => { const group = await (await fetch(`http://127.0.0.1:${port}/api/logs/details/${pathological.headers['x-cline-request-id']}`)).json(); return group.request?.state === state && group; });
    if (size === 16) {
      const input = await (await fetch(`http://127.0.0.1:${port}/api/logs/details/${group.request.requestId}/bodies/${group.request.requestBody}`)).json();
      assert.equal(input.echo, '[REDACTED]'.repeat(16), 'small inputs must retain single, nonrecursive markers');
    } else assert.ok(group.bodies.every((body) => body.state === 'resource-limited' && body.capturedBytes === 0));
    assert.ok((await (await fetch(`http://127.0.0.1:${port}/api/accounts`)).json()).accounts.every((account) => account.activeCount === 0));
  }
});
