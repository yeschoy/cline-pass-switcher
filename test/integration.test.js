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
import { DETAIL_DROP_REASONS } from '../lib/detailed-log-store.js';
import { prepareAdminFixture, connectAdminFixture, fixtureHeaders, installFixtureFetch, bareFetch } from './admin-fixture.js';
installFixtureFetch();

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = (server) => new Promise((resolve) => server.close(resolve));
function testCanonicalRules(statusRules = {}, contentRules = []) {
  const duration = (ms) => { let seconds=Math.max(1,Math.ceil(ms/1000)),out='';for(const [unit,size] of [['d',86400],['h',3600],['m',60],['s',1]]){const amount=Math.floor(seconds/size);if(amount||out||unit==='s')out+=`${amount}${unit}`;seconds%=size;}return out; };
  const rules=[];
  for(const [index,rule] of (Array.isArray(contentRules)?contentRules:[]).entries()) rules.push({id:`test-content-${index+1}`,scope:'account',action:rule.action==='ban'?'hard-quarantine':rule.action,when:{...(rule.statusMin===undefined?{}:{statuses:Array.from({length:rule.statusMax-rule.statusMin+1},(_,offset)=>rule.statusMin+offset)}),body_contains:rule.contains},...(rule.action==='cooldown'?{reset:{fallback:duration(rule.cooldownMs),max:duration(rule.cooldownMs)}}:{})});
  for(const [status,rule] of Object.entries(statusRules||{})) rules.push({id:`test-status-${status}`,scope:'account',action:rule.action==='ban'?'hard-quarantine':rule.action,when:{statuses:[Number(status)]},...(rule.action==='cooldown'?{reset:{fallback:duration(rule.cooldownMs),max:duration(rule.cooldownMs)}}:{})});
  return rules;
}
function rawJson(port, pathname, body, headers = {}, { exactPayload = false, skipAdmin = false } = {}) {
  return new Promise((resolve, reject) => {
    // Older fixtures use the legacy rule shape as shorthand; compatibility tests opt into the exact wire payload.
    const payload=pathname==='/api/accounts'&&body?.errorRules===undefined&&body?.accountErrorRules!==undefined&&!exactPayload?{...body,errorRules:testCanonicalRules(body.accountErrorRules,body.accountContentErrorRules||[])}:body;
    const data = Buffer.from(JSON.stringify(payload));
    const req = http.request({ hostname: '127.0.0.1', port, path: pathname, method: 'POST', headers: skipAdmin ? { 'Content-Type': 'application/json', 'Content-Length': data.length, ...headers } : fixtureHeaders(port, pathname, 'POST', { 'Content-Type': 'application/json', 'Content-Length': data.length, ...headers }) }, (res) => {
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
  prepareAdminFixture(dir);
  const child = spawn(process.execPath, ['server.js'], { cwd: path.resolve('.'), env: { ...process.env, ...extraEnv, DATA_DIR: dir, BIND_HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (c) => { output += c; }); child.stderr.on('data', (c) => { output += c; });
  await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(`switcher startup timeout: ${output}`)), 5000);
    const poll = setInterval(() => { if (output.includes('OpenAI 兼容代理地址')) { clearInterval(poll); clearTimeout(deadline); resolve(); } }, 20);
    child.once('exit', (code) => { clearInterval(poll); clearTimeout(deadline); reject(new Error(`switcher exited ${code}: ${output}`)); });
  });
  await connectAdminFixture(Number(extraEnv.PORT || config?.port || JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).port || 3123));
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
async function waitUntil(check, timeoutMs = 5000, label = 'condition') {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`condition timeout: ${label} (${timeoutMs}ms)`);
}

// Semantic quota deadline used by the shared-admission test. It is injected through
// CLINE_PASS_TEST_QUOTA_TIMEOUT_MS and must stay far above the real round-trip overhead
// (mock upstream + switcher HTTP + a loaded machine) so it cannot expire while the test
// is still arranging mock responses. The previous 80ms value was the same order of
// magnitude as one local round trip and produced `refreshed 3 !== 4` under bounded load.
const QUOTA_DEADLINE_MS = 1000;
// Bounded window for the negative "a leaving page owner must not cancel shared work"
// assertion. There is no positive server projection for "socket close processed but the
// shared job kept", so the window gives the server a real chance to (incorrectly) cancel;
// the positive proof of the invariant is the later `refreshed === 4` assertion.
const OWNER_DETACH_WINDOW_MS = 50;
const ownerDetachWindow = () => new Promise((resolve) => setTimeout(resolve, OWNER_DETACH_WINDOW_MS));

test('API compatibility, message pass-through and request outcomes are explicit', async (t) => {
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
  const config = { port: switchPort, upstreamBase: `http://127.0.0.1:${upstreamPort}`, accountMode: 'sticky', accounts: [{ id: 'a', name: 'A', key: 'key-a', enabled: true, maxConcurrent: 1, perModel: {} }], knownModels: ['valid-image', 'valid-tool', 'valid-function-call', 'done-close', 'stream-cancel', 'nonstream-cancel'], perModel: {}, accountErrorRules: { '502': { action: 'ban' } }, accountContentErrorRules: [{ contains: 'upstream fetch failed', action: 'ban' }], accountPipeline: { quotaPool: false, healthSort: true, sticky: false, order: ['quotaPool','healthSort','sticky'], cachePoolSize: 1, cachePoolMaxSize: 1 } };
  const running = await startSwitcher(config);
  t.after(async () => { await stop(running.child); await close(mock); fs.rmSync(running.dir, { recursive: true, force: true }); });

  const beforeUnsupported = seen.length;
  const unsupported = await rawJson(switchPort, '/v1/responses', { model: 'ignored' });
  assert.equal(unsupported.status, 501);
  assert.deepEqual(unsupported.json, { error: { message: 'OpenAI Responses API is not supported; use /v1/chat/completions instead', type: 'unsupported_api', param: null, code: 'unsupported_api' } });
  assert.equal(seen.length, beforeUnsupported, 'unsupported API must not reach account routing or upstream');

  const passthroughContents = ['', '   ', null, [], [{ type: 'text', text: '  ' }], [{}], [{ type: 'image_url', image_url: false }], undefined];
  for (const [index, content] of passthroughContents.entries()) {
    const message = { role: 'user' };
    if (content !== undefined) message.content = content;
    const before = seen.length;
    const response = await rawJson(switchPort, '/v1/chat/completions', { model: 'passthrough-content', messages: [message] });
    assert.equal(response.status, 200, `empty content pass-through case ${index}`);
    assert.equal(seen.length, before + 1, `empty content case ${index} must reach upstream`);
    assert.deepEqual(seen.at(-1).messages, [message]);
  }

  const emptyToolMessages = [
    { role: 'user', content: 'read a file' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'bash', arguments: '{}' } }] },
    { role: 'tool', content: '\n', tool_call_id: 'call_1' },
    { role: 'user', content: '?' },
  ];
  assert.equal((await rawJson(switchPort, '/v1/chat/completions', { model: 'empty-tool-content', messages: emptyToolMessages, max_tokens: 5 })).status, 200);
  assert.deepEqual(seen.at(-1).messages, emptyToolMessages, 'empty tool output must pass through unchanged');

  assert.equal((await rawJson(switchPort, '/v1/chat/completions', { model: 'valid-image', messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.test/image.png' } }] }] })).status, 200);
  assert.equal((await rawJson(switchPort, '/v1/chat/completions', { model: 'valid-tool', messages: [{ role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'lookup', arguments: '{}' } }] }] })).status, 200);
  assert.equal((await rawJson(switchPort, '/v1/chat/completions', { model: 'valid-function-call', messages: [{ role: 'assistant', content: '', function_call: { name: 'lookup', arguments: '{}' } }] })).status, 200);

  await disconnectRequest(switchPort, { model: 'done-close', stream: true, messages: [{ role: 'user', content: 'complete' }] }, true, '[DONE]');
  await disconnectRequest(switchPort, { model: 'stream-cancel', stream: true, messages: [{ role: 'user', content: 'cancel' }] }, true);
  await disconnectRequest(switchPort, { model: 'nonstream-cancel', messages: [{ role: 'user', content: 'cancel' }] });

  const logs = await waitForRequestLogs(switchPort, 15);
  assert.equal(logs.length, 15, 'each accepted request must finalize exactly once');
  for (const model of ['valid-image', 'valid-tool', 'valid-function-call', 'done-close', 'stream-cancel', 'nonstream-cancel']) {
    assert.equal(logs.filter((item) => item.requestedModel === model).length, 1, `${model} must have one final request record`);
  }
  const byModel = new Map(logs.map((item) => [item.requestedModel, item]));
  assert.equal(byModel.get('done-close')?.status, 200); assert.equal(byModel.get('done-close')?.result, 'success');
  assert.equal(byModel.get('stream-cancel')?.status, 499); assert.equal(byModel.get('stream-cancel')?.result, 'client_cancelled'); assert.equal(byModel.get('stream-cancel')?.errorCategory, null);
  assert.equal(byModel.get('nonstream-cancel')?.status, 499); assert.equal(byModel.get('nonstream-cancel')?.result, 'client_cancelled'); assert.equal(byModel.get('nonstream-cancel')?.errorCategory, null);
  assert.deepEqual([byModel.get('done-close')?.bindingSource,byModel.get('stream-cancel')?.bindingSource,byModel.get('nonstream-cancel')?.bindingSource],['fallback','fallback','fallback']);
  assert.deepEqual([byModel.get('done-close')?.bindingResult,byModel.get('stream-cancel')?.bindingResult,byModel.get('nonstream-cancel')?.bindingResult],['miss','miss','hit'],'a committed binding survives stream cancellation without duplicating finalizers');
  assert.equal((await (await fetch(`http://127.0.0.1:${switchPort}/api/logs/requests?result=client_cancelled`)).json()).items.length, 2);
  assert.equal((await (await fetch(`http://127.0.0.1:${switchPort}/api/logs/errors`)).json()).items.length, 0, 'client cancellation must not create attempt errors');
  const statistics = await (await fetch(`http://127.0.0.1:${switchPort}/api/statistics`)).json();
  assert.equal(statistics.lifetime.global.requests, 15); assert.equal(statistics.lifetime.global.errors, 0);
  assert.equal(statistics.lifetime.global.usageRequests, 0); assert.equal(statistics.lifetime.global.inputTokens, 0, 'usage observed before cancellation must be discarded');
  assert.equal(statistics.accounts[0].health.successes, 13, 'successful requests count for account success rate; cancellations do not'); assert.equal(statistics.accounts[0].health.degrades,0);
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
      if (req.method === 'GET' && req.url.endsWith('/users/me/plan/usage-limits')) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ success: true, data: { limits: [{ type:'five_hour', percentUsed:10 }, { type:'weekly', percentUsed:10 }, { type:'monthly', percentUsed:10 }] } })); }
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : {};
      // Protection may run a separate quota GET; attempt assertions count chat POSTs only.
      if (req.method === 'POST') seen.push({ headers: req.headers, body });
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
        if (only === 'beta' && auth === 'Bearer key-b') {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: { message: 'unauthorized account', status: 401 } }));
        }
        if (only === '__probe__') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: { message: 'Available providers are: alpha, beta.', type: 'invalid_request_error' } }));
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
  assert.equal((await rawJson(switchPort, '/api/config', { scope: 'global', perModel: { 'test-model': { providerCooldownMs: 300001 } } })).status, 400);
  const malformed = await new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: switchPort, path: '/api/config', method: 'POST', headers: fixtureHeaders(switchPort, '/api/config', 'POST', { 'Content-Type': 'application/json' }) }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
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
  const plannerProbe = await rawJson(switchPort, '/api/probe', { model: 'planner-model' });
  assert.equal(plannerProbe.status, 200);
  assert.deepEqual(plannerProbe.json.upstreams, ['alpha', 'beta'], 'observed final provider and structured harvest providers form one known set');
  assert.equal(plannerProbe.json.upstreamDiscovery, 'known');
  seen.length = 0;
  const validationAccount = accounts.find((account) => account.id === 'b');
  const scopedProbe = await rawJson(switchPort, '/api/probe', { model: 'planner-model', accountId: validationAccount.id });
  assert.equal(scopedProbe.status, 200); assert.equal(scopedProbe.json.accountId, validationAccount.id);
  assert.deepEqual(new Set(seen.map((entry) => entry.headers.authorization)), new Set(['Bearer key-b']), 'probe and harvest must keep one selected account');
  const scopedValidation = await rawJson(switchPort, '/api/validate-upstreams', { model: 'planner-model', accountId: validationAccount.id });
  assert.equal(scopedValidation.status, 200); assert.equal(scopedValidation.json.results.beta.accountFault, 'auth'); assert.equal(scopedValidation.json.results.beta.status, 'unknown');
  const scopedView = await (await fetch(`http://127.0.0.1:${switchPort}/api/models?accountId=${validationAccount.id}`)).json();
  assert.notEqual(scopedView.subscription.find((entry) => entry.id === 'planner-model').meta.upstreamStatus?.beta?.status, 'auth', 'account auth must not contaminate global provider health');
  assert.equal((await rawJson(switchPort, '/api/probe', { model: 'planner-model', accountId: 'missing' })).status, 400);
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
  assert.deepEqual(postStartHistory.history[0].accountActions, [{ account: 'A', action: 'cooldown', statusCode: 429, ruleId: 'test-status-429', scope: 'account' }]);
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
  await waitUntil(async () => (await (await fetch(`http://127.0.0.1:${switchPort}/api/accounts`)).json()).accounts.every((a) => !a.quota.protectionPendingUntil));

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
  await waitUntil(async () => !(await (await fetch(`http://127.0.0.1:${switchPort}/api/accounts`)).json()).accounts.find((a) => a.id === 'a').quota.protectionPendingUntil);

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
  const healthBeforeDisconnect = (await (await fetch(`http://127.0.0.1:${switchPort}/api/statistics`)).json()).accounts.reduce((sum, account) => sum + (account.health.samples || 0), 0);
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
  const healthAfterDisconnect = (await (await fetch(`http://127.0.0.1:${switchPort}/api/statistics`)).json()).accounts.reduce((sum, account) => sum + (account.health.samples || 0), 0);
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

test('content error rules are strict, ordered, redacted and preserve nonstream/stream retry boundaries', async (t) => {
  const seen=[];
  const upstream=http.createServer((req,res)=>{const chunks=[];req.on('data',chunk=>chunks.push(chunk));req.on('end',()=>{
    const body=JSON.parse(Buffer.concat(chunks).toString()||'{}'),auth=req.headers.authorization,only=body.provider?.only?.[0]||body.providerOptions?.gateway?.only?.[0],message=body.messages?.[0]?.content||'';seen.push({model:body.model,auth,only});
    const ok=()=>{if(body.stream){res.writeHead(200,{'Content-Type':'text/event-stream'});return res.end('data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n');}res.writeHead(200,{'Content-Type':'application/json'});return res.end('{"choices":[{"message":{"content":"OK"}}]}');};
    if(auth==='Bearer key-b')return ok();
    if(body.model==='content-ignore'){res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify({data:{error:{message:`content-first ${message}`,code:'E_CONTENT',status:429,echo:req.headers['x-safe-account']}}}));}
    if(body.model==='content-switch'){res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify({error:{message:`quota exhausted ${message}`,code:'E_QUOTA',status:429,echo:req.headers['x-safe-account']}}));}
    if(body.model==='pre-stream'&&body.stream){res.writeHead(200,{'Content-Type':'text/event-stream'});return res.end('data: {"error":{"message":"pre stream quota","code":"E_PRE","status":429}}\n\n');}
    if(body.model==='post-stream'&&body.stream){res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('data: {"choices":[{"delta":{"content":"started"}}]}\n\n');return setTimeout(()=>res.end('data: {"error":{"message":"late stream quota","code":"E_LATE","status":429}}\n\ndata: [DONE]\n\n'),5);}
    if(body.model==='retry-content'&&only==='first'){res.writeHead(500,{'Content-Type':'application/json'});return res.end(JSON.stringify({error:{message:'supplier retry content',code:'E_RETRY',status:500}}));}
    return ok();
  });});
  const upstreamPort=await listen(upstream),port=await unusedPort(),accounts=[{id:'a',name:'A',key:'key-a',enabled:true,headers:{'X-Safe-Account':'header-secret-value'},perModel:{}},{id:'b',name:'B',key:'key-b',enabled:true,perModel:{}}];
  const running=await startSwitcher({port,upstreamBase:`http://127.0.0.1:${upstreamPort}`,accountMode:'single',activeAccount:0,accounts,knownModels:['content-ignore','content-switch','pre-stream','post-stream','retry-content'],perModel:{'retry-content':{upstreams:['first','second'],pinMode:'strict'}},accountErrorRules:{429:{action:'ban'},500:{action:'ban'}},accountContentErrorRules:[{contains:'content-first',action:'ignore'},{contains:'content-first',action:'ban'}]},null,{NODE_ENV:'test'});
  t.after(async()=>{await stop(running.child);await close(upstream);fs.rmSync(running.dir,{recursive:true,force:true});});
  const view=()=>fetch(`http://127.0.0.1:${port}/api/accounts`).then(response=>response.json());
  const save=async({statusRules,contentRules,includeContent=true})=>{const current=await view(),body={accounts:current.accounts,mode:'single',active:0,concurrencyWaitMs:0,accountErrorRules:statusRules};if(includeContent)body.accountContentErrorRules=contentRules;return rawJson(port,'/api/accounts',body,{}, {exactPayload:!includeContent});};

  seen.length=0;let response=await rawJson(port,'/v1/chat/completions',{model:'content-ignore',messages:[{role:'user',content:'message-secret-value'}]});assert.equal(response.status,429);assert.deepEqual(seen.map(row=>row.auth),['Bearer key-a'],'first matching content ignore blocks status ban and account replacement');assert.equal((await view()).accounts[0].state,null);

  let rules=[{contains:'quota exhausted',statusMin:500,statusMax:599,action:'ban'},{contains:'quota exhausted',statusMin:429,statusMax:429,action:'cooldown',cooldownMs:60000}];assert.equal((await save({statusRules:{429:{action:'ban'}},contentRules:rules})).status,200);
  seen.length=0;response=await rawJson(port,'/v1/chat/completions',{model:'content-switch',messages:[{role:'user',content:'message-secret-value'}]});assert.equal(response.status,200);assert.deepEqual(seen.map(row=>row.auth),['Bearer key-a','Bearer key-b']);let state=(await view()).accounts[0].state;assert.equal(state.banned,false);assert.ok(state.cooldownUntil>Date.now());
  let persisted=fs.readFileSync(path.join(running.dir,'metadata.json'),'utf8');for(const secret of ['message-secret-value','header-secret-value','key-a'])assert.equal(persisted.includes(secret),false);
  await new Promise(resolve=>setTimeout(resolve,20));const contentLogs=JSON.stringify(await(await fetch(`http://127.0.0.1:${port}/api/logs/errors?requestedModel=content-switch`)).json());for(const secret of ['message-secret-value','header-secret-value','key-a'])assert.equal(contentLogs.includes(secret),false);
  await rawJson(port,'/api/accounts/recover',{id:'a'});

  rules=[{contains:'pre stream quota',action:'ban'}];assert.equal((await save({statusRules:{},contentRules:rules})).status,200);seen.length=0;response=await rawJson(port,'/v1/chat/completions',{model:'pre-stream',stream:true,messages:[]});assert.equal(response.status,200);assert.deepEqual(seen.map(row=>row.auth),['Bearer key-a','Bearer key-b'],'pre-stream content action may replace once');await rawJson(port,'/api/accounts/recover',{id:'a'});

  rules=[{contains:'late stream quota',action:'ban'}];assert.equal((await save({statusRules:{},contentRules:rules})).status,200);seen.length=0;response=await rawJson(port,'/v1/chat/completions',{model:'post-stream',stream:true,messages:[]});assert.equal(response.status,200);assert.equal(seen.length,1,'post-start content action never replays');state=(await view()).accounts[0].state;assert.equal(state.banned,true);await rawJson(port,'/api/accounts/recover',{id:'a'});

  rules=[{contains:'supplier retry content',action:'ignore'}];assert.equal((await save({statusRules:{500:{action:'ban'}},contentRules:rules})).status,200);seen.length=0;response=await rawJson(port,'/v1/chat/completions',{model:'retry-content',messages:[]});assert.equal(response.status,200);assert.deepEqual(seen.map(row=>row.only),['first','second']);assert.equal(new Set(seen.map(row=>row.auth)).size,1);assert.equal((await view()).accounts[0].state,null);

  const legacyView=await view(),preserved=structuredClone(legacyView.accountContentErrorRules);assert.equal((await save({statusRules:legacyView.accountErrorRules,includeContent:false})).status,200);assert.deepEqual((await view()).accountContentErrorRules,preserved,'old clients omitting canonical rules preserve the server value when legacy mirrors are unchanged');
  assert.equal((await save({statusRules:{},includeContent:false})).status,409,'legacy fields cannot modify canonical rules');
  const configPath=path.join(running.dir,'config.json'),bytes=fs.readFileSync(configPath),base=await view();
  const invalid=[null,{},[{contains:'',action:'ignore'}],[{contains:'x'.repeat(501),action:'ignore'}],Array.from({length:101},()=>({contains:'x',action:'ignore'})),Array.from({length:50},(_,index)=>({contains:`${index}-${'界'.repeat(500)}`,action:'ignore'})),[{contains:'x',statusMin:400,action:'ignore'}],[{contains:'x',statusMin:500,statusMax:400,action:'ignore'}],[{contains:'x',action:'ignore',extra:true}],[{contains:'x',action:'cooldown'}]];
  for(const accountContentErrorRules of invalid){const result=await rawJson(port,'/api/accounts',{accounts:base.accounts,mode:'single',active:0,concurrencyWaitMs:0,accountErrorRules:base.accountErrorRules,accountContentErrorRules},{},{exactPayload:true});assert.equal(result.status,400,JSON.stringify(accountContentErrorRules));assert.deepEqual(fs.readFileSync(configPath),bytes);}
});

test('invalid persisted content rules normalize to the disabled default without affecting accounts', async (t) => {
  const port=await unusedPort(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'cps-content-rule-migration-'));
  const config={port,accounts:[{id:'a',name:'A',key:'key-a',enabled:true,perModel:{}}],accountMode:'single',activeAccount:0,knownModels:['m'],perModel:{},accountErrorRules:{429:{action:'ignore'}},accountContentErrorRules:{invalid:true}};fs.writeFileSync(path.join(dir,'config.json'),JSON.stringify(config));
  const running=await startSwitcher(null,dir);t.after(async()=>{await stop(running.child);fs.rmSync(dir,{recursive:true,force:true});});
  const view=await(await fetch(`http://127.0.0.1:${port}/api/accounts`)).json(),persisted=JSON.parse(fs.readFileSync(path.join(dir,'config.json')));
  assert.deepEqual(view.accountContentErrorRules,[]);assert.deepEqual(persisted.accountContentErrorRules,[]);assert.equal(view.accounts[0].id,'a');assert.deepEqual(view.accountErrorRules,{429:{action:'ignore'}});
});

test('Chat affinity preserves caller keys, derives Claude keys and logs only safe cache facts', async (t) => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      seen.push(body);
      const usage = body.model === 'cache-hit'
        ? { prompt_tokens: 10, prompt_tokens_details: { cached_tokens: 4 } }
        : body.model === 'cache-miss'
          ? { prompt_tokens: 10, prompt_tokens_details: { cached_tokens: 0 } }
          : undefined;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'OK' } }], ...(usage ? { usage } : {}) }));
    });
  });
  const upstreamPort = await listen(upstream), port = await unusedPort();
  const models = ['codex-key','claude-key','claude-child','message-key','session-key','cache-hit','cache-miss','cache-unknown'];
  const running = await startSwitcher({
    port, upstreamBase: `http://127.0.0.1:${upstreamPort}`, accountMode: 'sticky', concurrencyWaitMs: 0,
    accounts: [{ id: 'a', name: 'A', key: 'key-a', enabled: true, perModel: {} }, { id: 'b', name: 'B', key: 'key-b', enabled: true, perModel: {} }],
    knownModels: models, perModel: {}, accountErrorRules: {},
  });
  t.after(async () => { await stop(running.child); await close(upstream); fs.rmSync(running.dir, { recursive: true, force: true }); });

  const rawCodexKey = 'codex-raw-prompt-key';
  assert.equal((await rawJson(port, '/v1/chat/completions', { model: 'codex-key', prompt_cache_key: rawCodexKey, messages: [] }, { Originator: 'codex_cli_rs' })).status, 200);
  assert.equal(seen.at(-1).prompt_cache_key, rawCodexKey, 'caller prompt_cache_key must remain byte-for-byte unchanged');

  const rawClaudeSession = 'claude-root-session';
  assert.equal((await rawJson(port, '/v1/chat/completions', { model: 'claude-key', messages: [] }, { 'X-Claude-Code-Session-Id': rawClaudeSession })).status, 200);
  const derivedClaudeKey = seen.at(-1).prompt_cache_key;
  assert.match(derivedClaudeKey, /^[a-f0-9]{64}$/);
  assert.notEqual(derivedClaudeKey, rawClaudeSession);
  assert.equal((await rawJson(port, '/v1/chat/completions', { model: 'claude-key', messages: [{ role: 'user', content: 'next' }] }, { 'X-Claude-Code-Session-Id': rawClaudeSession })).status, 200);
  assert.equal(seen.at(-1).prompt_cache_key, derivedClaudeKey, 'the same explicit Claude session must derive one stable upstream key');
  assert.equal((await rawJson(port, '/v1/chat/completions', { model: 'claude-child', messages: [] }, { 'X-Claude-Code-Parent-Agent-Id': rawClaudeSession, 'X-Claude-Code-Session-Id': 'child-session' })).status, 200);
  assert.equal(seen.at(-1).prompt_cache_key, derivedClaudeKey, 'Claude child requests must share the parent upstream key');

  assert.equal((await rawJson(port, '/v1/chat/completions', { model: 'message-key', messages: [{ role: 'user', content: 'stable opening' }] })).status, 200);
  assert.equal(seen.at(-1).prompt_cache_key, undefined, 'message_hmac fallback must not be promoted into an explicit upstream key');
  const callerSession = 'caller-session-id';
  assert.equal((await rawJson(port, '/v1/chat/completions', { model: 'session-key', session_id: callerSession, messages: [] })).status, 200);
  assert.equal(seen.at(-1).session_id, callerSession);
  assert.equal(seen.at(-1).prompt_cache_key, undefined, 'caller session_id must not be replaced or duplicated');

  for (const model of ['cache-hit','cache-miss','cache-unknown']) {
    assert.equal((await rawJson(port, '/v1/chat/completions', { model, messages: [] }, { 'X-Claude-Code-Session-Id': `${rawClaudeSession}-${model}` })).status, 200);
  }

  let page;
  for (let i = 0; i < 50; i++) {
    page = await (await fetch(`http://127.0.0.1:${port}/api/logs/requests?limit=50`)).json();
    if ((page.items || []).some((item) => item.requestedModel === 'cache-unknown')) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const byModel = Object.fromEntries(page.items.map((item) => [item.requestedModel, item]));
  assert.deepEqual({ source: byModel['codex-key'].sessionSource, type: byModel['codex-key'].affinityKeyType, confidence: byModel['codex-key'].affinityConfidence, prompt: byModel['codex-key'].upstreamPromptCacheKeySource, applied: byModel['codex-key'].upstreamPromptCacheKeyApplied },
    { source: 'codex_body', type: 'prompt_cache_key', confidence: 'explicit', prompt: 'caller_prompt_cache_key', applied: true });
  assert.deepEqual({ source: byModel['claude-key'].sessionSource, type: byModel['claude-key'].affinityKeyType, confidence: byModel['claude-key'].affinityConfidence, prompt: byModel['claude-key'].upstreamPromptCacheKeySource, applied: byModel['claude-key'].upstreamPromptCacheKeyApplied },
    { source: 'claude_header', type: 'session_id', confidence: 'explicit', prompt: 'derived_claude', applied: true });
  assert.deepEqual({ source: byModel['message-key'].sessionSource, type: byModel['message-key'].affinityKeyType, confidence: byModel['message-key'].affinityConfidence, prompt: byModel['message-key'].upstreamPromptCacheKeySource, applied: byModel['message-key'].upstreamPromptCacheKeyApplied },
    { source: 'message_hmac', type: 'message_hmac', confidence: 'fallback', prompt: 'none', applied: false });
  assert.equal(byModel['session-key'].upstreamPromptCacheKeySource, 'caller_session_id');
  assert.equal(byModel['cache-hit'].cacheHit, true);
  assert.equal(byModel['cache-miss'].cacheHit, false);
  assert.equal(byModel['cache-unknown'].cacheHit, null);
  const serialized = JSON.stringify(page);
  for (const forbidden of [rawCodexKey, rawClaudeSession, callerSession, derivedClaudeKey, 'child-session']) assert.equal(serialized.includes(forbidden), false, `ordinary logs leaked ${forbidden}`);
  assert.equal(fs.readFileSync(path.join(running.dir, 'metadata.json'), 'utf8').includes(rawClaudeSession), false);
  const stats = await (await fetch(`http://127.0.0.1:${port}/api/statistics`)).json();
  assert.ok(stats.recent24h.global.explicitAffinityRequests >= 6); assert.ok(stats.recent24h.global.fallbackAffinityRequests >= 1); assert.equal(stats.routingCoverage.complete, false);
});

test('provider cooldown skips repeated failures and admits only one half-open probe', async (t) => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}'), provider = body.provider?.only?.[0];
      seen.push({ model: body.model, provider, at: Date.now() });
      const reply = () => {
        if (provider === 'first') {
          const status = body.model === 'parameter' ? 418 : 500;
          res.writeHead(status, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: { message: body.model === 'parameter' ? 'invalid parameter' : 'provider failed', status } }));
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }));
      };
      if (provider === 'first' && (body.model === 'cool' || body.model === 'stale')) return setTimeout(reply, 60);
      reply();
    });
  });
  const upstreamPort = await listen(upstream), port = await unusedPort();
  const route = (providerCooldownMs) => ({ upstreams: ['first','second'], exclude: [], pinMode: 'strict', sort: null, maxRetries: null, providerCooldownMs });
  const running = await startSwitcher({
    port, upstreamBase: `http://127.0.0.1:${upstreamPort}`, accountMode: 'single', activeAccount: 0, concurrencyWaitMs: 0,
    accounts: [{ id: 'a', name: 'A', key: 'key-a', enabled: true, perModel: {} }], knownModels: ['cool','parameter','disabled','stale'],
    perModel: { cool: route(80), parameter: route(80), disabled: route(0), stale: route(80) },
    errorRules: [{ id: 'stale-hard', scope: 'provider-model', action: 'hard-quarantine', models: ['stale'], when: { statuses: [500] } }],
  });
  t.after(async () => { await stop(running.child); await close(upstream); fs.rmSync(running.dir, { recursive: true, force: true }); });

  const request = (model) => rawJson(port, '/v1/chat/completions', { model, messages: [] });
  assert.equal((await request('cool')).status, 200);
  assert.deepEqual(seen.filter((entry) => entry.model === 'cool').map((entry) => entry.provider), ['first','second']);
  seen.length = 0;
  assert.equal((await request('cool')).status, 200);
  assert.deepEqual(seen.map((entry) => entry.provider), ['second'], 'a cooling provider must be skipped on the next request');

  await new Promise((resolve) => setTimeout(resolve, 90));
  seen.length = 0;
  const [one, two] = await Promise.all([request('cool'), request('cool')]);
  assert.equal(one.status, 200); assert.equal(two.status, 200);
  assert.equal(seen.filter((entry) => entry.provider === 'first').length, 1, 'only one request may own the half-open provider probe');
  assert.ok(seen.filter((entry) => entry.provider === 'second').length >= 2);

  seen.length = 0;
  assert.equal((await request('parameter')).status, 200); assert.equal((await request('parameter')).status, 200);
  assert.deepEqual(seen.filter((entry) => entry.model === 'parameter').map((entry) => entry.provider), ['first','second','first','second'], 'ordinary parameter errors must not open the circuit');
  seen.length = 0;
  assert.equal((await request('disabled')).status, 200); assert.equal((await request('disabled')).status, 200);
  assert.deepEqual(seen.filter((entry) => entry.model === 'disabled').map((entry) => entry.provider), ['first','second','first','second'], 'unmatched failures degrade success rate without creating an implicit durable cooldown');
  const disabledModel=(await(await fetch(`http://127.0.0.1:${port}/api/models`)).json()).subscription.find(row=>row.id==='disabled');assert.equal(disabledModel.meta.upstreamStatus.first.success.degrades,2);assert.equal(disabledModel.meta.upstreamStatus.first.success.successRate,0);assert.equal(disabledModel.meta.upstreamStatus.second.success.successes,2);assert.equal(disabledModel.meta.upstreamStatus.second.success.successRate,1);

  seen.length = 0;
  const staleRequest = request('stale');
  await waitUntil(() => seen.some((entry) => entry.model === 'stale' && entry.provider === 'first'));
  assert.equal((await rawJson(port, '/api/config', { scope: 'global', perModel: { stale: route(80) } })).status, 200);
  assert.equal((await staleRequest).status, 200);
  const staleView = await (await fetch(`http://127.0.0.1:${port}/api/models`)).json();
  const staleModel = staleView.subscription.find((row) => row.id === 'stale');
  assert.equal(staleModel.meta.upstreamStatus.first.success.samples, 0, 'a stale-generation failure records no provider failure sample');
  assert.equal(staleModel.meta.upstreamStatus.second.success.samples, 0, 'a stale-generation success records no provider success sample');
  seen.length = 0;
  assert.equal((await request('stale')).status, 200);
  assert.equal(seen[0].provider, 'first', 'a completion from the replaced route generation must not recreate cooldown state');

  let logs;
  for (let i = 0; i < 50; i++) {
    logs = await (await fetch(`http://127.0.0.1:${port}/api/logs/requests?requestedModel=cool&limit=20`)).json();
    if ((logs.items || []).length >= 4) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const actions = logs.items.flatMap((item) => item.attempts || []).map((attempt) => attempt.providerCircuitAction).filter(Boolean);
  assert.ok(actions.includes('cooldown')); assert.ok(actions.includes('half-open-failed'));
  const stats = await (await fetch(`http://127.0.0.1:${port}/api/statistics`)).json();
  assert.ok(stats.recent24h.global.providerFallbackRequests >= 1); assert.ok(stats.recent24h.global.providerCircuitCooldownRequests >= 1); assert.ok(stats.recent24h.global.providerHalfOpenRequests >= 1);
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
  assert.equal(beforeRestart.statistics.version, 5);
  assert.ok(Number.isSafeInteger(beforeRestart.statistics.recentCoverage.modelTrackingStartedMinute));
  assert.equal(beforeRestart.statistics.minuteBuckets.at(-1).models['cooldown-model'].requests, 1);
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
  assert.equal(afterMeta.statistics.version, 5);
  assert.deepEqual(afterMeta.statistics.migration, beforeRestart.statistics.migration, 'legacy stats migration must be idempotent across restart');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(running.dir, 'config.json'))).accounts.map((a) => a.id), migrated.accounts.map((a) => a.id));
});

test('new scheduling modes, account fields, model aliases and independent logs', async (t) => {
  const seen = [];
  let coolFailures = 1;
  const mock = http.createServer((req, res) => {
    const chunks=[]; req.on('data',(c)=>chunks.push(c)); req.on('end',()=>{
      if (req.method === 'GET' && req.url.endsWith('/users/me/plan/usage-limits')) { res.writeHead(200, { 'Content-Type':'application/json' }); return res.end(JSON.stringify({ success:true, data:{ limits:[{type:'five_hour',percentUsed:10},{type:'weekly',percentUsed:10},{type:'monthly',percentUsed:10}] } })); }
      const body=JSON.parse(Buffer.concat(chunks).toString()||'{}'); if (req.method === 'POST') seen.push({ auth:req.headers.authorization, headers:req.headers, body });
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
  const aliasStats=await(await fetch(`http://127.0.0.1:${switchPort}/api/statistics`)).json();
  assert.equal(aliasStats.models.some(x=>x.id==='friendly'),false,'aliases do not split resolved-model statistics');
  assert.ok(aliasStats.models.find(x=>x.id==='cline-pass/target').recent24h.requests>=1);
  await new Promise(r=>setTimeout(r,30)); const logs=await (await fetch(`http://127.0.0.1:${switchPort}/api/logs/requests?requestedModel=friendly`)).json();
  assert.equal(logs.items[0].resolvedModel,'cline-pass/target');assert.equal(logs.items[0].requestId,aliased.headers['x-cline-request-id']);assert.equal(JSON.stringify(logs).includes('primary account'),false);assert.equal(JSON.stringify(logs).includes('ka'),false);
  assert.equal((await rawJson(switchPort,'/api/accounts',{accounts,mode:'single',active:0,concurrencyWaitMs:20,accountErrorRules:{}})).status,200);
  const leaked=await rawJson(switchPort,'/v1/chat/completions',{model:'leak',messages:[{role:'user',content:'message-secret-value'}]});assert.equal(leaked.status,500);assert.equal(leaked.text.includes('message-secret-value'),false);assert.equal(leaked.text.includes('header-secret-value'),false);
  await new Promise(r=>setTimeout(r,20));const redactedErrors=await(await fetch(`http://127.0.0.1:${switchPort}/api/logs/errors?requestedModel=leak`)).json();assert.equal(JSON.stringify(redactedErrors).includes('message-secret-value'),false);assert.equal(JSON.stringify(redactedErrors).includes('header-secret-value'),false);
  // Ordinary full-list save must round-trip a combined bulk/drawer/scheduling draft.
  const draftAccounts=accounts.map((a,i)=>({...a,maxConcurrent:i===0?100000:0,
    ...(i===0?{note:'pending drawer note',proxyUrl:'http://127.0.0.1:1/',perModel:{'cline-pass/target':{upstream:'Mock',upstreams:['Mock'],exclude:[],pinMode:'preferred',sort:null,maxRetries:null,providerCooldownMs:1234}}}:{})}));
  const pipeline={quotaPool:false,excludeUnhealthy:true,healthSort:true,sticky:false,order:['healthSort','excludeUnhealthy','quotaPool','sticky'],cachePoolSize:0};
  const rules={429:{action:'ignore'}};
  assert.equal((await rawJson(switchPort,'/api/accounts',{accounts:draftAccounts,mode:'sticky',active:1,concurrencyWaitMs:987,accountErrorRules:rules,accountPipeline:pipeline})).status,200);
  const roundTrip=await(await fetch(`http://127.0.0.1:${switchPort}/api/accounts`)).json();
  for(let i=0;i<draftAccounts.length;i++)for(const field of ['id','name','note','key','enabled','maxConcurrent','weight','priority','proxyUrl','headers'])assert.deepEqual(roundTrip.accounts[i][field],draftAccounts[i][field],`round-trip ${i}.${field}`);
  assert.deepEqual(roundTrip.accounts[0].perModel,draftAccounts[0].perModel);
  assert.deepEqual(roundTrip.accounts[1].perModel,draftAccounts[1].perModel);
  assert.equal(roundTrip.mode,'sticky');assert.equal(roundTrip.active,1);assert.equal(roundTrip.concurrencyWaitMs,987);
  assert.deepEqual(roundTrip.accountErrorRules,rules);assert.deepEqual(roundTrip.accountPipeline,{quotaPool:false,healthSort:true,sticky:false,order:['healthSort','quotaPool','sticky'],cachePoolSize:0,cachePoolMaxSize:0,cachePoolLowQuotaSize:0,sessionBindingExplicitTtlMs:7200000,sessionBindingFallbackTtlMs:900000,sessionBindingMaxEntries:50000});
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
  await waitUntil(async()=>quotaHits>0);const ok=await rawJson(switchPort,'/v1/chat/completions',{model:'cline-pass/test',messages:[]});assert.equal(ok.status,200);assert.equal(connects,1,'quota and chat reuse the persisted HTTP CONNECT tunnel');assert.equal(chatHits,1);assert.equal(quotaHits,1);
  const accounts=(await (await fetch(`http://127.0.0.1:${switchPort}/api/accounts`)).json()).accounts;
  const spare=http.createServer();const deadPort=await listen(spare);await close(spare);
  accounts[0].proxyUrl=`http://user:password@127.0.0.1:${deadPort}`;
  assert.equal((await rawJson(switchPort,'/api/accounts',{accounts,mode:'single',active:0,concurrencyWaitMs:0,accountErrorRules:{}})).status,200);
  const failed=await rawJson(switchPort,'/v1/chat/completions',{model:'cline-pass/test',messages:[]});assert.equal(failed.status,502);assert.equal(chatHits,1,'a failed configured proxy must not retry direct');
  await new Promise(r=>setTimeout(r,20));
  const logs=await (await fetch(`http://127.0.0.1:${switchPort}/api/logs/errors?category=proxy`)).json();assert.ok(logs.items.some(x=>x.category==='proxy'));assert.equal(JSON.stringify(logs).includes('password'),false);
  const health=(await(await fetch(`http://127.0.0.1:${switchPort}/api/statistics`)).json()).accounts[0].health;assert.equal(health.samples,2);assert.equal(health.successes,1);assert.equal(health.degrades,1,'proxy failure records one account degrade sample');
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
  assert.equal(result.status, 200, result.text);
  assert.equal((await rawJson(switchPort, '/v1/chat/completions', { model: 'cline-pass/test', messages: [] })).status, 200);
  assert.equal(upstreamHits, 2);
  assert.equal(connects, 1, 'HTTPS CONNECT tunnel is reused when the proxy and upstream allow it');
});

test('SOCKS5 and SOCKS5H account proxies tunnel requests', async (t) => {
  let hits=0, socksConnections=0;
  const upstream=http.createServer((req,res)=>{hits++;req.resume();req.on('end',()=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:'OK'}}]}));});});
  const upstreamPort=await listen(upstream);
  const socks=net.createServer((client)=>{socksConnections++;let buffer=Buffer.alloc(0),stage=0;client.on('data',function onData(chunk){buffer=Buffer.concat([buffer,chunk]);if(stage===0){if(buffer.length<2)return;const n=buffer[1];if(buffer.length<2+n)return;buffer=buffer.subarray(2+n);client.write(Buffer.from([5,0]));stage=1;}if(stage===1){if(buffer.length<5)return;const atyp=buffer[3];let off=4,host;if(atyp===1){if(buffer.length<10)return;host=[...buffer.subarray(off,off+4)].join('.');off+=4;}else if(atyp===3){const n=buffer[off++];if(buffer.length<off+n+2)return;host=buffer.subarray(off,off+n).toString();off+=n;}else return client.destroy();const port=buffer.readUInt16BE(off);off+=2;const rest=buffer.subarray(off);buffer=Buffer.alloc(0);stage=2;const target=net.connect(port,host,()=>{client.write(Buffer.from([5,0,0,1,0,0,0,0,0,0]));if(rest.length)target.write(rest);client.removeListener('data',onData);client.pipe(target);target.pipe(client);});target.on('error',()=>client.destroy());}});});
  const socksPort=await listen(socks);const socket=http.createServer();const switchPort=await listen(socket);await close(socket);
  const base={id:'a',name:'A',key:'ka',enabled:true,perModel:{}};
  const running=await startSwitcher({port:switchPort,upstreamBase:`http://127.0.0.1:${upstreamPort}`,accountMode:'single',concurrencyWaitMs:0,accounts:[{...base,proxyUrl:`socks5://127.0.0.1:${socksPort}`}],knownModels:['cline-pass/test'],perModel:{},accountErrorRules:{}});t.after(async()=>{await stop(running.child);await close(socks);await close(upstream);fs.rmSync(running.dir,{recursive:true,force:true});});
  for(const protocol of ['socks5','socks5h']){const accounts=(await (await fetch(`http://127.0.0.1:${switchPort}/api/accounts`)).json()).accounts;accounts[0].proxyUrl=`${protocol}://127.0.0.1:${socksPort}`;assert.equal((await rawJson(switchPort,'/api/accounts',{accounts,mode:'single',active:0,concurrencyWaitMs:0,accountErrorRules:{}})).status,200);for(let i=0;i<2;i++)assert.equal((await rawJson(switchPort,'/v1/chat/completions',{model:'cline-pass/test',messages:[]})).status,200);assert.equal(socksConnections,['socks5','socks5h'].indexOf(protocol)+1,`${protocol} tunnel reused`);}
  assert.equal(hits,4);assert.equal(socksConnections,2);
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
  assert.equal(stats.accounts[0].health.successRate, 1);
  assert.equal(stats.accounts[0].health.samples, 7);
  assert.equal(stats.accounts[0].quota.pool, 'hot'); assert.ok(quotaHits >= 1);
  const statsModel=stats.models.find(model=>model.id==='stats-model'),missingModel=stats.models.find(model=>model.id==='no-usage');
  assert.equal(statsModel.recent24h.requests,6);assert.equal(statsModel.recent24h.cacheInputKnownRequests,6);assert.equal(statsModel.recent24h.cacheInputTokens,58);assert.equal(statsModel.recent24h.cacheInputCachedTokens,14);assert.equal(statsModel.recent24h.cacheTokenRatio,14/58);assert.equal(statsModel.coverage.complete,false);
  assert.equal(missingModel.recent24h.requests,1);assert.equal(missingModel.recent24h.cacheInputKnownRequests,0);assert.equal(missingModel.recent24h.cacheTokenRatio,null);
  const accountView = await (await fetch(`http://127.0.0.1:${switchPort}/api/accounts`)).json();
  assert.equal(accountView.accounts[0].statistics.recent24h.cacheTokenRatio,14/58);assert.equal(accountView.accounts[0].statistics.lifetimeErrors,0);
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

test('future statistics versions fail startup without overwriting metadata', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cps-future-statistics-')),holder=http.createServer(),port=await listen(holder);await close(holder);
  fs.writeFileSync(path.join(dir,'config.json'),JSON.stringify({port,accounts:[{id:'a',name:'A',key:'key',enabled:true,perModel:{}}],accountMode:'single',activeAccount:0,accountErrorRules:{},perModel:{},knownModels:['test']}));
  const metadataPath=path.join(dir,'metadata.json'),bytes=Buffer.from(JSON.stringify({models:{},history:[],routingSecret:'secret',accountStates:{},statistics:{version:6}}));fs.writeFileSync(metadataPath,bytes);
  const child=spawn(process.execPath,['server.js'],{cwd:path.resolve('.'),env:{...process.env,DATA_DIR:dir,BIND_HOST:'127.0.0.1'},stdio:['ignore','pipe','pipe']});let output='';child.stderr.on('data',chunk=>{output+=chunk;});child.stdout.on('data',chunk=>{output+=chunk;});
  const code=await new Promise(resolve=>child.once('exit',resolve));assert.notEqual(code,0);assert.match(output,/unsupported statistics version/);assert.deepEqual(fs.readFileSync(metadataPath),bytes);fs.rmSync(dir,{recursive:true,force:true});
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

test('account success-rate sorting is direct, stable and never filters unknown accounts', async (t) => {
  const seen=[];
  const upstream=http.createServer((req,res)=>{const chunks=[];req.on('data',c=>chunks.push(c));req.on('end',()=>{const body=JSON.parse(Buffer.concat(chunks));seen.push(req.headers.authorization);if(body.model==='train'&&req.headers.authorization==='Bearer key-a'){res.writeHead(401,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:'unauthorized'}}));return;}res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:'ok'}}]}));});});
  const upstreamPort=await listen(upstream),port=await unusedPort();
  const accounts=[{id:'a',name:'A',key:'key-a',enabled:true,perModel:{}},{id:'b',name:'B',key:'key-b',enabled:true,perModel:{}},{id:'c',name:'C',key:'key-c',enabled:true,perModel:{}}];
  const running=await startSwitcher({port,upstreamBase:`http://127.0.0.1:${upstreamPort}`,accountMode:'single',activeAccount:0,concurrencyWaitMs:0,accounts,knownModels:['train','serve'],perModel:{},errorRules:[],accountPipeline:{quotaPool:false,healthSort:false,sticky:false,order:['quotaPool','healthSort','sticky'],cachePoolSize:0}});t.after(async()=>{await stop(running.child);await close(upstream);fs.rmSync(running.dir,{recursive:true,force:true});});
  await rawJson(port,'/v1/chat/completions',{model:'train',messages:[]});
  let view=await(await fetch(`http://127.0.0.1:${port}/api/accounts`)).json();
  assert.equal(view.accounts.find(a=>a.id==='a').health.successRate,0);assert.equal(view.accounts.find(a=>a.id==='b').health.successRate,null);
  assert.equal((await rawJson(port,'/api/accounts',{accounts:view.accounts,mode:'single',active:1,concurrencyWaitMs:0,errorRules:view.errorRules,accountPipeline:view.accountPipeline})).status,200);
  await rawJson(port,'/v1/chat/completions',{model:'serve',messages:[]});view=await(await fetch(`http://127.0.0.1:${port}/api/accounts`)).json();assert.equal(view.accounts.find(a=>a.id==='b').health.successRate,1);assert.equal(view.accounts.find(a=>a.id==='c').health.successRate,null);
  assert.equal((await rawJson(port,'/api/accounts',{accounts:view.accounts,mode:'roundrobin',active:0,concurrencyWaitMs:0,errorRules:view.errorRules,accountPipeline:{quotaPool:false,healthSort:true,sticky:false,order:['healthSort','quotaPool','sticky'],cachePoolSize:0}})).status,200);
  seen.length=0;assert.equal((await rawJson(port,'/v1/chat/completions',{model:'serve',messages:[]})).status,200);assert.equal(seen[0],'Bearer key-b','higher known direct success rate must precede lower known and unknown accounts');
  await rawJson(port,'/v1/chat/completions',{model:'serve',messages:[]});
  const stats=await(await fetch(`http://127.0.0.1:${port}/api/statistics`)).json();assert.equal(stats.accounts.find(a=>a.id==='a').health.samples,1);assert.equal(stats.accounts.find(a=>a.id==='a').health.successRate,0);assert.equal(stats.accounts.find(a=>a.id==='b').health.samples,3);assert.equal(stats.accounts.find(a=>a.id==='b').health.successRate,1);assert.equal(stats.accounts.find(a=>a.id==='c').health.successRate,null);
});

const emptyHealthFixture = () => ({ results:0,penaltyUnits:0,errors:0,auth:0,rateLimit:0,networkProxy:0,server:0,other:0 });
const emptyAggregateFixture = () => ({requests:0,errors:0,usageRequests:0,inputKnownRequests:0,inputTokens:0,outputKnownRequests:0,outputTokens:0,totalKnownRequests:0,totalTokens:0,cacheKnownRequests:0,cacheHitRequests:0,cachedTokens:0,cacheInputKnownRequests:0,cacheInputTokens:0,cacheInputCachedTokens:0,lastUsedAt:0,lastErrorAt:0,overflowFields:[]});

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
  const byModel=Object.fromEntries(stats.models.map(model=>[model.id,model]));
  assert.equal(byModel.u1.recent24h.cacheTokenRatio,3/10);assert.equal(byModel.u1.recent24h.cacheInputKnownRequests,1);
  assert.equal(byModel.retry.recent24h.requests,1);assert.equal(byModel.retry.recent24h.cacheTokenRatio,6/13);
  assert.equal(byModel.switch.recent24h.requests,1);assert.equal(byModel.switch.recent24h.cacheTokenRatio,8/17);
  assert.equal(byModel.stream.recent24h.requests,1);assert.equal(byModel.stream.recent24h.cacheTokenRatio,4/8);
  assert.equal(byModel.zero.recent24h.cacheInputKnownRequests,1);assert.equal(byModel.zero.recent24h.cacheInputTokens,0);assert.equal(byModel.zero.recent24h.cacheTokenRatio,null);
  assert.equal(byModel.missing.recent24h.requests,1);assert.equal(byModel.missing.recent24h.cacheInputKnownRequests,0);
  assert.equal(seen.filter(x=>x.model==='retry').length,2,'provider retry must not duplicate usage');
  const a=stats.accounts.find(x=>x.id==='a'),b=stats.accounts.find(x=>x.id==='b');assert.equal(a.lifetime.inputTokens,171);assert.equal(b.lifetime.inputTokens,17);assert.equal(a.lifetime.requests,11);assert.equal(b.lifetime.requests,1);assert.equal(a.health.samples,11);assert.equal(a.health.degrades,1,'account cooldown records exactly one failure sample');assert.equal(b.health.samples,1);assert.equal(b.health.successes,1,'A→B replacement records independent account success samples');
  const globalBeforeRestart=stats.lifetime.global,modelsBeforeRestart=stats.models;await stop(running.child);running.child=null;running=await startSwitcher(null,running.dir);stats=await(await fetch(`http://127.0.0.1:${switchPort}/api/statistics`)).json();assert.deepEqual(stats.lifetime.global,globalBeforeRestart,'statistics must survive restart exactly');assert.deepEqual(stats.models,modelsBeforeRestart,'model statistics must survive restart exactly');
  const accountView=await(await fetch(`http://127.0.0.1:${switchPort}/api/accounts`)).json();assert.equal((await rawJson(switchPort,'/api/accounts',{accounts:accountView.accounts.filter(x=>x.id==='a'),mode:'single',active:0,concurrencyWaitMs:0,accountErrorRules:{}})).status,200);
  stats=await(await fetch(`http://127.0.0.1:${switchPort}/api/statistics`)).json();assert.equal(stats.accounts.some(x=>x.id==='b'),false);assert.deepEqual(stats.lifetime.global,globalBeforeRestart,'deleting an account retains global history');
});

test('terminal metadata uses compact atomic JSON without losing statistics on restart', async (t) => {
  const upstream = http.createServer((req, res) => {
    req.resume(); req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 0, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 0 } } }));
    });
  });
  const upstreamPort = await listen(upstream), port = await unusedPort(), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cps-compact-meta-'));
  let running = await startSwitcher({ port, upstreamBase: `http://127.0.0.1:${upstreamPort}`, accounts: [{ id: 'a', name: 'A', key: 'fixture-upstream-credential-unique', enabled: true, perModel: {} }], knownModels: ['cline-pass/kimi-k3'] }, dir);
  t.after(async () => { if (running?.child) await stop(running.child); await close(upstream); fs.rmSync(dir, { recursive: true, force: true }); });
  assert.equal((await rawJson(port, '/v1/chat/completions', { model: 'cline-pass/kimi-k3', messages: [] }, { 'Session-Id': 'fixture-session-unique' })).status, 200);
  const configBytes = fs.readFileSync(path.join(dir, 'config.json'), 'utf8');
  assert.equal(configBytes, JSON.stringify(JSON.parse(configBytes), null, 2), 'operator configuration keeps its formatted encoding');
  const metaPath = path.join(dir, 'metadata.json'), bytes = fs.readFileSync(metaPath, 'utf8'), persisted = JSON.parse(bytes);
  assert.equal(bytes, JSON.stringify(persisted), 'metadata uses compact encoding, not a changed JSON schema');
  for (const secret of ['fixture-upstream-credential-unique', 'fixture-session-unique']) assert.equal(bytes.includes(secret), false, 'encoding does not change metadata exclusions');
  assert.equal(persisted.statistics.minuteBuckets.at(-1).models['cline-pass/kimi-k3'].requests, 1);
  assert.equal(persisted.statistics.minuteBuckets.at(-1).providerUsage['cline-pass/kimi-k3'][''].inputTokens, 0, 'known zero remains known');
  assert.equal(fs.readdirSync(dir).filter(name => name.startsWith('metadata.json.')).length, 0, 'atomic temporary file is removed');
  const before = (await (await fetch(`http://127.0.0.1:${port}/api/statistics`)).json()).models;
  await stop(running.child); running.child = null;
  fs.writeFileSync(metaPath, JSON.stringify(persisted, null, 2), { mode: 0o600 });
  running = await startSwitcher(null, dir);
  const after = (await (await fetch(`http://127.0.0.1:${port}/api/statistics`)).json()).models;
  assert.deepEqual(after, before, 'previously formatted metadata restores exact coverage and reference valuation');
  assert.equal((await rawJson(port, '/v1/chat/completions', { model: 'cline-pass/kimi-k3', messages: [] })).status, 200);
  const rewritten = fs.readFileSync(metaPath, 'utf8');
  assert.equal(rewritten, JSON.stringify(JSON.parse(rewritten)), 'ordinary terminal write compacts legacy formatting');
  await stop(running.child); running.child = null;
  const invalid = Buffer.from('{"statistics":');
  fs.writeFileSync(metaPath, invalid);
  const failed = spawn(process.execPath, ['server.js'], { cwd: path.resolve('.'), env: { ...process.env, DATA_DIR: dir, BIND_HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; failed.stdout.on('data', chunk => { output += chunk; }); failed.stderr.on('data', chunk => { output += chunk; });
  const code = await new Promise(resolve => failed.once('exit', resolve));
  assert.notEqual(code, 0);
  assert.match(output, /cannot read metadata\.json/);
  assert.deepEqual(fs.readFileSync(metaPath), invalid, 'malformed operator JSON must never be compacted or overwritten');
});

test('model/provider reference statistics attribute only final usage and freeze priced ranges', async (t) => {
  const upstream=http.createServer((req,res)=>{const chunks=[];req.on('data',c=>chunks.push(c));req.on('end',()=>{
    const body=JSON.parse(Buffer.concat(chunks).toString()),provider=body.provider?.only?.[0]||body.providerOptions?.gateway?.only?.[0];
    if(provider==='first'){res.writeHead(500,{'Content-Type':'application/json'});return res.end(JSON.stringify({error:{message:'failed',status:500}}));}
    if(body.stream){res.writeHead(200,{'Content-Type':'text/event-stream'});return res.end(body.model==='cline-pass/glm-5.3'?'data: {"usage":{"prompt_tokens":0,"completion_tokens":0,"prompt_tokens_details":{"cached_tokens":0}}}\n\ndata: [DONE]\n\n':'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n');}
    const usage=body.model==='cline-pass/glm-5.3'?{prompt_tokens:0,completion_tokens:0,prompt_tokens_details:{cached_tokens:0}}
      :body.model==='cline-pass/deepseek-v4-flash'?{prompt_tokens:10,completion_tokens:2,prompt_tokens_details:{cached_tokens:3}}
      :body.model==='cline-pass/deepseek-v4-pro'?{prompt_tokens:2,completion_tokens:0,prompt_tokens_details:{cached_tokens:3}}
      :body.model==='unsupported'?{prompt_tokens:10,completion_tokens:2,prompt_tokens_details:{cached_tokens:3}}
      :{prompt_tokens:10,completion_tokens:2,total_tokens:12,prompt_tokens_details:{cached_tokens:3}};
    res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:'ok',provider_metadata:{gateway:{routing:{finalProvider:body.model==='unsupported'?'mismatch':provider||'unknown'}}}}}],usage}));
  });});
  const upstreamPort=await listen(upstream),port=await unusedPort(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'cps-provider-values-'));
  const models=['cline-pass/kimi-k3','cline-pass/glm-5.3','cline-pass/deepseek-v4-flash','cline-pass/deepseek-v4-pro','unsupported','toString','provider-path','provider-prototype'];
  let running=await startSwitcher({port,upstreamBase:`http://127.0.0.1:${upstreamPort}`,accounts:[{id:'a',name:'A',key:'local',enabled:true,perModel:{}}],accountMode:'single',activeAccount:0,knownModels:models,perModel:Object.fromEntries(models.map(model=>[model,model==='cline-pass/glm-5.3'?{}:{upstreams:model==='provider-path'?['vendor/path']:model==='provider-prototype'?['toString']:['first','second']}]))},dir);
  t.after(async()=>{if(running?.child)await stop(running.child);await close(upstream);fs.rmSync(dir,{recursive:true,force:true});});
  for(const model of models)assert.equal((await rawJson(port,'/v1/chat/completions',{model,messages:[]})).status,200);
  assert.equal((await rawJson(port,'/v1/chat/completions',{model:'cline-pass/kimi-k3',stream:true,messages:[]})).status,200);
  let stats=await(await fetch(`http://127.0.0.1:${port}/api/statistics`)).json();
  const find=id=>stats.models.find(row=>row.id===id).providerStatistics;
  const kimi=find('cline-pass/kimi-k3');assert.equal(kimi.finalRequests.samples,2);assert.equal(kimi.finalRequests.successes,2);assert.equal(kimi.usage.inputTokens,10,'stream without usage cannot fabricate Token');
  assert.equal(kimi.providers.find(p=>p.id==='second').usage.inputTokens,10);assert.ok(kimi.providers.find(p=>p.id==='first').health.degrades>=1);assert.equal(kimi.providers.find(p=>p.id==='first').usage.requests,0,'failed retries own health but no final usage');
  assert.equal(kimi.valuation.versions['clinepass-2026-09-24-v1'].lowPicoUsd,51900000);assert.equal(kimi.valuation.versions['clinepass-2026-09-24-v1'].pricedRequests,1);
  const glm=find('cline-pass/glm-5.3');assert.equal(glm.providers.find(p=>p.id===null).usage.inputTokens,0);assert.equal(glm.valuation.versions['clinepass-2026-09-24-v1'].lowPicoUsd,0,'explicit zero is priced zero');
  const flash=find('cline-pass/deepseek-v4-flash').valuation.versions['clinepass-2026-09-24-v1'];assert.equal(flash.lowPicoUsd,2881000);assert.equal(flash.highPicoUsd,5762000);
  assert.deepEqual(find('cline-pass/deepseek-v4-pro').valuation.versions,{},'inconsistent cached read is not priced');assert.deepEqual(find('unsupported').valuation.versions,{},'unsupported model is unpriced');
  assert.equal(find('unsupported').providers.find(p=>p.id===null).usage.inputTokens,10,'a named attempt with mismatched reported Provider goes to unknown, not the attempted Provider');
  assert.equal(find('unsupported').providers.find(p=>p.id==='second').usage.requests,0);
  assert.equal(find('toString').finalRequests.successes,1,'valid model ids matching Object.prototype methods retain their final cell');
  assert.equal(find('toString').providers.find(p=>p.id==='second').usage.inputTokens,10,'prototype-named models retain named usage and health');
  assert.deepEqual(find('toString').valuation.versions,{},'an Object.prototype name is not a priced model');
  const prototypeRow=stats.models.find(row=>row.id==='toString');
  for(const coverage of [prototypeRow.coverage,prototypeRow.providerStatistics.finalCoverage,prototypeRow.providerStatistics.coverage,prototypeRow.providerStatistics.valuation]) assert.ok(Number.isSafeInteger(coverage.from),'prototype-named model retains a valid coverage start');
  assert.ok(Number.isSafeInteger(find('toString').providers.find(p=>p.id==='second').health.coverageFrom));
  assert.equal(find('provider-path').providers.find(p=>p.id==='vendor/path').usage.inputTokens,10,'valid Provider slugs with a slash persist in v5');
  assert.equal(find('provider-prototype').providers.find(p=>p.id==='toString').usage.inputTokens,10,'prototype-named Provider has its own usage cell');
  assert.ok(Number.isSafeInteger(find('provider-prototype').providers.find(p=>p.id==='toString').health.coverageFrom));
  assert.doesNotMatch(running.output(),/\[统计\] 更新失败/,'unpriced/prototype-named models do not interrupt statistics finalization');
  assert.equal(stats.referencePrices.current.effectiveAt,null);assert.equal(stats.referencePrices.versions['clinepass-2026-09-24-v1'].collectedAt,'2026-09-24');
  const before=structuredClone(stats.models),metaPath=path.join(dir,'metadata.json');await stop(running.child);running.child=null;
  const metadata=JSON.parse(fs.readFileSync(metaPath));assert.equal(metadata.statistics.version,5);assert.equal(metadata.statistics.minuteBuckets.at(-1).valuation['cline-pass/kimi-k3'].second['clinepass-2026-09-24-v1'].lowPicoUsd,51900000);
  running=await startSwitcher(null,dir);stats=await(await fetch(`http://127.0.0.1:${port}/api/statistics`)).json();assert.deepEqual(stats.models,before);
  await stop(running.child);running.child=null;
  const older=JSON.parse(fs.readFileSync(metaPath)),version='clinepass-older-v1',current='clinepass-2026-09-24-v1';
  older.statistics.priceVersions[version]={...older.statistics.priceVersions[current],version,collectedAt:'2026-01-01',models:structuredClone(older.statistics.priceVersions[current].models)};
  older.statistics.priceVersions[version].models['cline-pass/kimi-k3'].rates[0][0]=1000;
  delete older.statistics.priceVersions[current];
  for(const bucket of older.statistics.minuteBuckets)for(const providers of Object.values(bucket.valuation))for(const cells of Object.values(providers))if(cells[current]){cells[version]=cells[current];delete cells[current];}
  fs.writeFileSync(metaPath,JSON.stringify(older));running=await startSwitcher(null,dir);
  assert.equal((await rawJson(port,'/v1/chat/completions',{model:'cline-pass/kimi-k3',messages:[]})).status,200);
  stats=await(await fetch(`http://127.0.0.1:${port}/api/statistics`)).json();const frozen=stats.models.find(row=>row.id==='cline-pass/kimi-k3').providerStatistics.valuation.versions;
  assert.equal(frozen[version].lowPicoUsd,51900000,'old frozen valuation must not be repriced');
  assert.equal(frozen[current].lowPicoUsd,51900000,'new requests use the current snapshot');
  assert.equal(stats.referencePrices.versions[version].models['cline-pass/kimi-k3'].rates[0][0],1000);
  assert.equal((await rawJson(port,'/api/model-aliases',{aliases:{'alias-kimi':'cline-pass/kimi-k3'}})).status,200);
  assert.equal((await rawJson(port,'/v1/chat/completions',{model:'alias-kimi',messages:[]})).status,200);
  assert.equal((await rawJson(port,'/v1/chat/completions',{model:'cline-pass/glm-5.3',stream:true,messages:[]})).status,200);
  stats=await(await fetch(`http://127.0.0.1:${port}/api/statistics`)).json();
  assert.equal(stats.models.some(row=>row.id==='alias-kimi'),false,'alias usage belongs only to resolved model');
  assert.equal(stats.models.find(row=>row.id==='cline-pass/kimi-k3').providerStatistics.valuation.versions[current].pricedRequests,2);
  assert.equal(stats.models.find(row=>row.id==='cline-pass/glm-5.3').providerStatistics.usage.inputKnownRequests,2,'streamed explicit zero remains known');
});

test('prototype-named model/provider cell eviction records valid coverage and survives restart',async(t)=>{
  const upstream=http.createServer((req,res)=>{const chunks=[];req.on('data',chunk=>chunks.push(chunk));req.on('end',()=>{
    const body=JSON.parse(Buffer.concat(chunks).toString()),provider=body.providerOptions?.gateway?.only?.[0]||body.provider?.only?.[0];
    res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:'ok',provider_metadata:{gateway:{routing:{finalProvider:provider}}}}}],usage:{prompt_tokens:1,completion_tokens:1,prompt_tokens_details:{cached_tokens:0}}}));
  });});
  const upstreamPort=await listen(upstream),port=await unusedPort(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'cps-stat-prototype-cap-'));
  let running=await startSwitcher({port,upstreamBase:`http://127.0.0.1:${upstreamPort}`,accounts:[{id:'a',name:'A',key:'local',enabled:true,perModel:{}}],accountMode:'single',activeAccount:0,knownModels:['toString','normal'],perModel:{toString:{upstreams:['toString']},normal:{upstreams:['vendor/path']}}},dir,{NODE_ENV:'test',CLINE_PASS_TEST_MODEL_CELL_LIMIT:'1',CLINE_PASS_TEST_PROVIDER_HEALTH_CELL_LIMIT:'1'});
  t.after(async()=>{if(running?.child)await stop(running.child);await close(upstream);fs.rmSync(dir,{recursive:true,force:true});});
  for(const model of ['toString','normal'])assert.equal((await rawJson(port,'/v1/chat/completions',{model,messages:[]})).status,200);
  const metaPath=path.join(dir,'metadata.json'),persisted=JSON.parse(fs.readFileSync(metaPath));
  assert.ok(Number.isSafeInteger(persisted.statistics.recentCoverage.modelIncompleteAt.toString));
  assert.ok(Number.isSafeInteger(persisted.statistics.recentCoverage.providerHealthIncompleteAt.toString.toString));
  await stop(running.child);running.child=null;running=await startSwitcher(null,dir);
  const stats=await(await fetch(`http://127.0.0.1:${port}/api/statistics`)).json(),row=stats.models.find(model=>model.id==='toString');
  assert.equal(row.coverage.complete,false);assert.equal(row.providerStatistics.finalCoverage.complete,false);
  const provider=row.providerStatistics.providers.find(provider=>provider.id==='toString');
  assert.equal(provider.health.samples,0,'evicted health cell has no fabricated sample');assert.equal(provider.health.coverageComplete,false);
  assert.equal(provider.usage.inputTokens,1,'provider usage remains independently attributed');
});

test('v4 statistics migrate without backfill, provider usage loss and money overflow retain coverage',async(t)=>{
  const upstream=http.createServer((req,res)=>{const chunks=[];req.on('data',c=>chunks.push(c));req.on('end',()=>{
    const body=JSON.parse(Buffer.concat(chunks).toString()),provider=body.providerOptions?.gateway?.only?.[0]||body.provider?.only?.[0];
    res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:'ok',provider_metadata:{gateway:{routing:{finalProvider:provider}}}}}],usage:{prompt_tokens:body.model==='cline-pass/glm-5.3'?Number.MAX_SAFE_INTEGER:2,completion_tokens:0,prompt_tokens_details:{cached_tokens:0}}}));
  });});const upstreamPort=await listen(upstream),port=await unusedPort(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'cps-stat-v5-'));
  const models=['cline-pass/kimi-k3','cline-pass/glm-5.3'];
  let running=await startSwitcher({port,upstreamBase:`http://127.0.0.1:${upstreamPort}`,accounts:[{id:'a',name:'A',key:'local',enabled:true,perModel:{}}],accountMode:'single',activeAccount:0,knownModels:models,perModel:Object.fromEntries(models.map(id=>[id,{upstreams:['second']}]))},dir,{NODE_ENV:'test',CLINE_PASS_TEST_USAGE_CELL_LIMIT:'1',CLINE_PASS_TEST_VALUATION_CELL_LIMIT:'1'});
  t.after(async()=>{if(running?.child)await stop(running.child);await close(upstream);fs.rmSync(dir,{recursive:true,force:true});});
  await stop(running.child);running.child=null;const metaPath=path.join(dir,'metadata.json'),metadata=JSON.parse(fs.readFileSync(metaPath));
  metadata.statistics.version=4;delete metadata.statistics.priceVersions;
  for(const field of ['usageTrackingStartedMinute','droppedUsageMinuteCells','usageIncompleteAt','usageGlobalIncompleteAt','droppedValuationMinuteCells','valuationIncompleteAt','valuationGlobalIncompleteAt'])delete metadata.statistics.recentCoverage[field];
  for(const bucket of metadata.statistics.minuteBuckets){delete bucket.modelFinal;delete bucket.providerUsage;delete bucket.valuation;}
  fs.writeFileSync(metaPath,JSON.stringify(metadata));running=await startSwitcher(null,dir,{NODE_ENV:'test',CLINE_PASS_TEST_USAGE_CELL_LIMIT:'1',CLINE_PASS_TEST_VALUATION_CELL_LIMIT:'1'});
  assert.equal((await rawJson(port,'/v1/chat/completions',{model:models[0],messages:[]})).status,200);
  assert.equal((await rawJson(port,'/v1/chat/completions',{model:models[1],messages:[]})).status,200);
  const stats=await(await fetch(`http://127.0.0.1:${port}/api/statistics`)).json(),persisted=JSON.parse(fs.readFileSync(metaPath));
  assert.equal(persisted.statistics.version,5);assert.equal(persisted.statistics.recentCoverage.droppedUsageMinuteCells,1);
  assert.equal(persisted.statistics.recentCoverage.droppedValuationMinuteCells,1);
  assert.equal(stats.models.find(row=>row.id===models[0]).providerStatistics.coverage.complete,false);
  assert.equal(stats.models.find(row=>row.id===models[0]).providerStatistics.valuation.complete,false);
  const overflow=stats.models.find(row=>row.id===models[1]).providerStatistics.valuation.versions['clinepass-2026-09-24-v1'];
  assert.equal(overflow.lowPicoUsd,null);assert.deepEqual(overflow.overflowFields,['lowPicoUsd','highPicoUsd']);assert.equal(overflow.pricedRequests,1);
  await stop(running.child);running.child=null;
  const capped=JSON.parse(fs.readFileSync(metaPath)),current='clinepass-2026-09-24-v1',cell=capped.statistics.minuteBuckets.at(-1).valuation['cline-pass/glm-5.3'].second;
  for(let i=1;i<=8;i++){const version=`clinepass-historical-${i}`;capped.statistics.priceVersions[version]={...structuredClone(capped.statistics.priceVersions[current]),version,collectedAt:'2026-01-01'};cell[version]=structuredClone(cell[current]);}
  delete capped.statistics.priceVersions[current];delete cell[current];fs.writeFileSync(metaPath,JSON.stringify(capped));
  running=await startSwitcher(null,dir);assert.equal((await rawJson(port,'/v1/chat/completions',{model:models[1],messages:[]})).status,200);
  const cappedStats=await(await fetch(`http://127.0.0.1:${port}/api/statistics`)).json(),after=JSON.parse(fs.readFileSync(metaPath));
  assert.equal(Object.keys(after.statistics.priceVersions).length,8);assert.equal(Object.hasOwn(after.statistics.priceVersions,'clinepass-historical-1'),false);
  assert.ok(after.statistics.recentCoverage.droppedValuationMinuteCells>persisted.statistics.recentCoverage.droppedValuationMinuteCells);
  assert.equal(cappedStats.models.find(row=>row.id===models[1]).providerStatistics.valuation.complete,false);
  await stop(running.child);running.child=null;
  after.statistics.minuteBuckets.at(-1).valuation[models[1]].second[current].pricedRequests=null;
  const bytes=Buffer.from(JSON.stringify(after));fs.writeFileSync(metaPath,bytes);
  const child=spawn(process.execPath,['server.js'],{cwd:path.resolve('.'),env:{...process.env,DATA_DIR:dir,BIND_HOST:'127.0.0.1'},stdio:['ignore','pipe','pipe']});
  let stderr='';child.stderr.on('data',chunk=>{stderr+=chunk;});
  assert.notEqual(await new Promise(resolve=>child.once('exit',resolve)),0);
  assert.match(stderr,/invalid statistics valuation counter/);assert.deepEqual(fs.readFileSync(metaPath),bytes,'malformed v5 metadata must remain unchanged');
});

test('direct success health has no thresholds and expires after the rolling window', async (t) => {
  const upstream=http.createServer((req,res)=>{res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:'server failed'}}));});
  const upstreamPort=await listen(upstream),port=await unusedPort(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'cps-success-health-'));
  let running=await startSwitcher({port,upstreamBase:`http://127.0.0.1:${upstreamPort}`,accounts:[{id:'a',name:'A',key:'key',enabled:true,perModel:{}}],accountMode:'single',activeAccount:0,knownModels:['score'],perModel:{score:{upstreams:['p'],pinMode:'strict'}},errorRules:[{id:'account-server',scope:'account',action:'degrade',when:{statuses:[500]}}]},dir);t.after(async()=>{if(running?.child)await stop(running.child);await close(upstream);fs.rmSync(dir,{recursive:true,force:true});});
  await rawJson(port,'/v1/chat/completions',{model:'score',messages:[]});let health=(await(await fetch(`http://127.0.0.1:${port}/api/statistics`)).json()).accounts[0].health;
  assert.equal(health.successRate,0);assert.equal(health.degrades,1);assert.equal(health.samples,1);assert.equal(Object.hasOwn(health,'status'),false);assert.equal(Object.hasOwn(health,'score'),false);
  await stop(running.child);running.child=null;const metadataPath=path.join(dir,'metadata.json'),metadata=JSON.parse(fs.readFileSync(metadataPath));for(const bucket of metadata.statistics.minuteBuckets)bucket.minute-=1440;fs.writeFileSync(metadataPath,JSON.stringify(metadata));running=await startSwitcher(null,dir);health=(await(await fetch(`http://127.0.0.1:${port}/api/statistics`)).json()).accounts[0].health;assert.equal(health.successRate,null);assert.equal(health.samples,0);
});

test('statistics v3 migrates to v4 without converting legacy weighted health into direct samples', async (t) => {
  const port=await unusedPort(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'cps-statistics-v4-migration-'));
  let running=await startSwitcher({port,accounts:[{id:'a',name:'A',key:'key',enabled:true,perModel:{}}],accountMode:'single',activeAccount:0,knownModels:['m'],perModel:{},errorRules:[]},dir);t.after(async()=>{if(running?.child)await stop(running.child);fs.rmSync(dir,{recursive:true,force:true});});
  await stop(running.child);running.child=null;const metadataPath=path.join(dir,'metadata.json'),metadata=JSON.parse(fs.readFileSync(metadataPath)),minute=Math.floor(Date.now()/60000),aggregate=structuredClone(metadata.statistics.lifetime.global);aggregate.requests=7;aggregate.lastUsedAt=minute*60000;metadata.statistics={version:3,lifetime:{global:structuredClone(aggregate),accounts:{a:structuredClone(aggregate)}},minuteBuckets:[{minute,global:structuredClone(aggregate),accounts:{a:structuredClone(aggregate)},health:{a:{...emptyHealthFixture(),results:5,penaltyUnits:25}},models:{m:structuredClone(aggregate)}}],recentCoverage:{droppedAccountMinuteCells:0,accountIncompleteAt:{},modelTrackingStartedMinute:minute,droppedModelMinuteCells:0,modelIncompleteAt:{},routingTrackingStartedMinute:minute},migration:metadata.statistics.migration};fs.writeFileSync(metadataPath,JSON.stringify(metadata));
  running=await startSwitcher(null,dir);const stats=await(await fetch(`http://127.0.0.1:${port}/api/statistics`)).json(),persisted=JSON.parse(fs.readFileSync(metadataPath));assert.equal(persisted.statistics.version,5);assert.deepEqual(persisted.statistics.minuteBuckets[0].providerUsage,{});assert.deepEqual(persisted.statistics.minuteBuckets[0].valuation,{});assert.deepEqual(persisted.statistics.minuteBuckets[0].modelFinal,{});assert.equal(stats.models.find(row=>row.id==='m').providerStatistics.coverage.complete,false);assert.equal(stats.lifetime.global.requests,7);assert.equal(stats.recent24h.global.requests,7);assert.equal(stats.accounts[0].recent24h.requests,7);assert.equal(stats.accounts[0].health.successRate,null);assert.equal(stats.accounts[0].health.samples,0);assert.equal(persisted.statistics.minuteBuckets[0].health.a.results,5);assert.deepEqual(persisted.statistics.minuteBuckets[0].accountHealth,{});assert.deepEqual(persisted.statistics.minuteBuckets[0].providerHealth,{});assert.equal(persisted.statistics.recentCoverage.accountHealthTrackingStartedMinute,minute);assert.equal(persisted.statistics.recentCoverage.providerHealthTrackingStartedMinute,minute);
});

test('runtime counter overflow becomes null with an exact marker', async (t) => {
  const upstream=http.createServer((req,res)=>{req.resume();req.on('end',()=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:'OK'}}]}));});}),upstreamPort=await listen(upstream),port=await unusedPort();
  let running=await startSwitcher({port,upstreamBase:`http://127.0.0.1:${upstreamPort}`,accountMode:'single',accounts:[{id:'a',name:'A',key:'ka',enabled:true,perModel:{}}],knownModels:['m'],perModel:{m:{upstreams:['p']}},errorRules:[]});t.after(async()=>{if(running?.child)await stop(running.child);await close(upstream);fs.rmSync(running.dir,{recursive:true,force:true});});
  assert.equal((await rawJson(port,'/v1/chat/completions',{model:'m',messages:[]})).status,200);await stop(running.child);running.child=null;const metadataPath=path.join(running.dir,'metadata.json'),metadata=JSON.parse(fs.readFileSync(metadataPath)),bucket=metadata.statistics.minuteBuckets.at(-1);metadata.statistics.lifetime.global.requests=Number.MAX_SAFE_INTEGER;bucket.accountHealth.a.successes=Number.MAX_SAFE_INTEGER;bucket.providerHealth.m.p.successes=Number.MAX_SAFE_INTEGER;fs.writeFileSync(metadataPath,JSON.stringify(metadata));running=await startSwitcher(null,running.dir);assert.equal((await rawJson(port,'/v1/chat/completions',{model:'m',messages:[]})).status,200);
  const stats=await(await fetch(`http://127.0.0.1:${port}/api/statistics`)).json(),models=await(await fetch(`http://127.0.0.1:${port}/api/models`)).json(),persisted=JSON.parse(fs.readFileSync(metadataPath)),persistedBucket=persisted.statistics.minuteBuckets.at(-1);assert.equal(stats.lifetime.global.requests,null);assert.deepEqual(persisted.statistics.lifetime.global.overflowFields,['requests']);assert.equal(stats.accounts[0].health.successes,null);assert.equal(stats.accounts[0].health.samples,null);assert.deepEqual(persistedBucket.accountHealth.a.overflowFields,['successes']);const provider=models.subscription.find(row=>row.id==='m').meta.upstreamStatus.p.success;assert.equal(provider.successes,null);assert.equal(provider.samples,null);assert.deepEqual(persistedBucket.providerHealth.m.p.overflowFields,['successes']);
});

const PIPELINE_STEP_ORDER = ['quotaPool','healthSort','sticky'];
const PIPELINE_RUNTIME_DEFAULTS = {cachePoolMaxSize:0,cachePoolLowQuotaSize:0,sessionBindingExplicitTtlMs:7200000,sessionBindingFallbackTtlMs:900000,sessionBindingMaxEntries:50000};
const pipelinePermutations = (items) => items.length < 2 ? [items] : items.flatMap((item,index) => pipelinePermutations(items.filter((_,i)=>i!==index)).map(rest=>[item,...rest]));

test('pipeline migrates legacy four-step input into canonical three-step order and validates atomically', async (t) => {
  const port=await unusedPort(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'cps-pipeline-vnext-'));
  const config={port,accounts:[{id:'a',name:'A',key:'key',enabled:true,perModel:{}}],accountMode:'single',activeAccount:0,accountErrorRules:{},perModel:{},knownModels:['m'],accountPipeline:{quotaPool:false,excludeUnhealthy:true,healthSort:false,sticky:false,order:['sticky','excludeUnhealthy','quotaPool','healthSort'],cachePoolSize:0}};
  const running=await startSwitcher(config,dir);t.after(async()=>{await stop(running.child);fs.rmSync(dir,{recursive:true,force:true});});let view=await(await fetch(`http://127.0.0.1:${port}/api/accounts`)).json();assert.deepEqual(view.accountPipeline,{quotaPool:false,healthSort:true,sticky:false,order:['sticky','healthSort','quotaPool'],cachePoolSize:0,...PIPELINE_RUNTIME_DEFAULTS});
  const bytes=fs.readFileSync(path.join(dir,'config.json'));assert.equal((await rawJson(port,'/api/accounts',{accounts:view.accounts,mode:'single',active:0,concurrencyWaitMs:0,errorRules:view.errorRules,accountPipeline:{quotaPool:false,healthSort:true,sticky:false,order:['sticky','sticky','quotaPool'],cachePoolSize:0}})).status,400);assert.deepEqual(fs.readFileSync(path.join(dir,'config.json')),bytes);
  for(const order of [['quotaPool','healthSort','sticky'],['sticky','quotaPool','healthSort'],['healthSort','sticky','quotaPool']]){assert.equal((await rawJson(port,'/api/accounts',{accounts:view.accounts,mode:'single',active:0,concurrencyWaitMs:0,errorRules:view.errorRules,accountPipeline:{quotaPool:false,healthSort:true,sticky:false,order,cachePoolSize:0}})).status,200);view=await(await fetch(`http://127.0.0.1:${port}/api/accounts`)).json();assert.deepEqual(view.accountPipeline.order,order);}
});

test('cache pool configuration migrates, validates atomically, preserves old clients and survives restart', async (t) => {
  const port=await unusedPort(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'cps-cache-pool-config-')),configPath=path.join(dir,'config.json');
  const pipeline={quotaPool:false,excludeUnhealthy:false,healthSort:false,sticky:false,order:PIPELINE_STEP_ORDER};
  let running=await startSwitcher({port,accounts:[{id:'a',name:'A',key:'ka',enabled:true,perModel:{}}],accountMode:'sticky',activeAccount:0,concurrencyWaitMs:0,accountErrorRules:{},accountPipeline:pipeline,knownModels:['m'],perModel:{}},dir);
  t.after(async()=>{if(running?.child)await stop(running.child);fs.rmSync(dir,{recursive:true,force:true});});
  let view=await(await fetch(`http://127.0.0.1:${port}/api/accounts`)).json();
  assert.equal(view.accountPipeline.cachePoolSize,0,'legacy configuration defaults cache pool off');assert.equal(view.accountPipeline.cachePoolMaxSize,0,'legacy max defaults to min');assert.equal(view.cachePool.targetSize,0);
  const migratedConfig=JSON.parse(fs.readFileSync(configPath));assert.equal(migratedConfig.accountPipeline.cachePoolSize,0,'migration persists the disabled default');assert.equal(migratedConfig.accountPipeline.cachePoolMaxSize,0);assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'metadata.json'))).cachePoolTargetSize,0);
  assert.equal((await rawJson(port,'/api/accounts',{accounts:view.accounts,mode:'sticky',active:0,concurrencyWaitMs:5000,accountErrorRules:{},accountPipeline:{...pipeline,cachePoolSize:2}})).status,200);
  view=await(await fetch(`http://127.0.0.1:${port}/api/accounts`)).json();assert.equal(view.accountPipeline.cachePoolSize,2);assert.equal(view.accountPipeline.cachePoolMaxSize,2,'legacy save that changes min keeps auto-growth inert');assert.equal(view.cachePool.targetSize,2);
  assert.equal((await rawJson(port,'/api/accounts',{accounts:view.accounts,mode:'sticky',active:0,concurrencyWaitMs:5000,accountErrorRules:{},accountPipeline:pipeline})).status,200,'old client may omit cachePoolSize');
  view=await(await fetch(`http://127.0.0.1:${port}/api/accounts`)).json();assert.equal(view.accountPipeline.cachePoolSize,2,'old-client save preserves current cache pool size');
  const completePipeline={...view.accountPipeline,cachePoolMaxSize:4,sessionBindingExplicitTtlMs:600000,sessionBindingFallbackTtlMs:120000,sessionBindingMaxEntries:1234};
  assert.equal((await rawJson(port,'/api/accounts',{accounts:view.accounts,mode:'sticky',active:0,concurrencyWaitMs:5000,errorRules:view.errorRules,accountPipeline:completePipeline})).status,200);
  view=await(await fetch(`http://127.0.0.1:${port}/api/accounts`)).json();assert.deepEqual({max:view.accountPipeline.cachePoolMaxSize,explicit:view.accountPipeline.sessionBindingExplicitTtlMs,fallback:view.accountPipeline.sessionBindingFallbackTtlMs,entries:view.accountPipeline.sessionBindingMaxEntries},{max:4,explicit:600000,fallback:120000,entries:1234});
  assert.equal((await rawJson(port,'/api/accounts',{accounts:view.accounts,mode:'sticky',active:0,concurrencyWaitMs:5000,errorRules:view.errorRules,accountPipeline:pipeline})).status,200,'old client may omit every new field');
  view=await(await fetch(`http://127.0.0.1:${port}/api/accounts`)).json();assert.deepEqual({min:view.accountPipeline.cachePoolSize,max:view.accountPipeline.cachePoolMaxSize,explicit:view.accountPipeline.sessionBindingExplicitTtlMs,fallback:view.accountPipeline.sessionBindingFallbackTtlMs,entries:view.accountPipeline.sessionBindingMaxEntries},{min:2,max:4,explicit:600000,fallback:120000,entries:1234});
  assert.equal((await rawJson(port,'/api/accounts',{accounts:view.accounts,mode:'roundrobin',active:0,concurrencyWaitMs:5000,accountErrorRules:{},accountPipeline:{...view.accountPipeline,cachePoolSize:2}})).status,200);
  view=await(await fetch(`http://127.0.0.1:${port}/api/accounts`)).json();assert.equal(view.accounts[0].cachePoolRole,null,'cache pool is inactive without sticky mode or step');
  assert.equal((await rawJson(port,'/api/accounts',{accounts:view.accounts,mode:'roundrobin',active:0,concurrencyWaitMs:5000,accountErrorRules:{},accountPipeline:{...view.accountPipeline,sticky:true,cachePoolSize:2}})).status,200);
  view=await(await fetch(`http://127.0.0.1:${port}/api/accounts`)).json();assert.equal(view.accounts[0].cachePoolRole,'active','explicit sticky step activates the cache pool outside sticky account mode');
  assert.equal((await rawJson(port,'/api/accounts',{accounts:view.accounts,mode:'sticky',active:0,concurrencyWaitMs:5000,accountErrorRules:{},accountPipeline:{...view.accountPipeline,sticky:false,cachePoolSize:2}})).status,200);
  view=await(await fetch(`http://127.0.0.1:${port}/api/accounts`)).json();
  assert.equal(fs.readFileSync(configPath,'utf8').includes('cachePoolRole'),false,'runtime cache roles are never persisted');
  const before=fs.readFileSync(configPath),validPipeline=view.accountPipeline;
  const invalidPipelines=[
    null,[],
    ...['quotaPool','healthSort','sticky'].flatMap(field=>{const missing={...validPipeline};delete missing[field];return[missing,{...validPipeline,[field]:1}];}),
    ...[-1,100001,1.5,'2',null,true].map(cachePoolSize=>({...validPipeline,cachePoolSize})),
    ...[-1,100001,1.5,'4',null,true].map(cachePoolMaxSize=>({...validPipeline,cachePoolMaxSize})),
    ...[59999,604800001,1.5,'60000',null,true].flatMap(value=>[{...validPipeline,sessionBindingExplicitTtlMs:value},{...validPipeline,sessionBindingFallbackTtlMs:value}]),
    ...[0,100001,1.5,'1',null,true].map(sessionBindingMaxEntries=>({...validPipeline,sessionBindingMaxEntries})),
    {...validPipeline,cachePoolSize:5,cachePoolMaxSize:4},
    {...validPipeline,sessionBindingExplicitTtlMs:60000,sessionBindingFallbackTtlMs:60001},
  ];
  for(const accountPipeline of invalidPipelines){const response=await rawJson(port,'/api/accounts',{accounts:view.accounts,mode:'sticky',active:0,concurrencyWaitMs:5000,accountErrorRules:{},accountPipeline});assert.equal(response.status,400,JSON.stringify(accountPipeline));assert.deepEqual(fs.readFileSync(configPath),before);}
  const unknown=await rawJson(port,'/api/accounts',{accounts:view.accounts,mode:'sticky',active:0,concurrencyWaitMs:5000,accountErrorRules:{},accountPipeline:{...validPipeline,cacheSecret:'forbidden'}});
  assert.equal(unknown.status,400);assert.deepEqual(fs.readFileSync(configPath),before);
  await stop(running.child);running.child=null;running=await startSwitcher(null,dir);view=await(await fetch(`http://127.0.0.1:${port}/api/accounts`)).json();assert.deepEqual({min:view.accountPipeline.cachePoolSize,max:view.accountPipeline.cachePoolMaxSize,explicit:view.accountPipeline.sessionBindingExplicitTtlMs,fallback:view.accountPipeline.sessionBindingFallbackTtlMs,entries:view.accountPipeline.sessionBindingMaxEntries,target:view.cachePool.targetSize},{min:2,max:4,explicit:600000,fallback:120000,entries:1234,target:2},'saved pool and binding boundaries survive restart');
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
  await stop(running.child);running.child=null;writeMetadata({unhealthyB:true});running=await startSwitcher(null,dir,{NODE_ENV:'test'});assert.deepEqual(await roles(),{d:'standby',a:'active',b:'active',c:'standby'},'legacy weighted health does not create a hidden success-rate exclusion threshold');
  assert.equal(seen.includes('Bearer key-d'),false,'reserve standby never receives normal traffic');
});

test('cache pool refuses reserve standby when hard state leaves no active candidate', async (t) => {
  const upstream=http.createServer((req,res)=>{req.resume();req.on('end',()=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:'OK'}}]}));});});
  const upstreamPort=await listen(upstream),port=await unusedPort(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'cps-cache-pool-hard-fallback-')),now=Date.now();
  const accounts=['a','b'].map((id,index)=>({id,name:id.toUpperCase(),key:`key-${id}`,enabled:true,priority:index+1,maxConcurrent:1,perModel:{}}));
  const reserve={snapshot:{limits:{five_hour:{percentUsed:95},weekly:{percentUsed:95},monthly:{percentUsed:95}},fetchedAt:now},lastAttemptAt:now,lastSuccessAt:now,errorCategory:null};
  fs.writeFileSync(path.join(dir,'metadata.json'),JSON.stringify({models:{},history:[],accountStates:{},routingSecret:'hard-fallback-secret',stats:{},accountQuotas:{a:reserve,b:reserve}}));
  const running=await startSwitcher({port,upstreamBase:`http://127.0.0.1:${upstreamPort}`,accounts,accountMode:'sticky',activeAccount:0,concurrencyWaitMs:300,knownModels:['m'],perModel:{},accountErrorRules:{},accountPipeline:{quotaPool:false,excludeUnhealthy:false,healthSort:false,sticky:false,order:PIPELINE_STEP_ORDER,cachePoolSize:2,cachePoolMaxSize:2}},dir,{NODE_ENV:'test',CLINE_PASS_TEST_QUOTA_SUCCESS_MS:'1000'});
  t.after(async()=>{await stop(running.child);await close(upstream);fs.rmSync(dir,{recursive:true,force:true});});
  const roles=await(await fetch(`http://127.0.0.1:${port}/api/accounts`)).json();assert.deepEqual(roles.accounts.map(account=>account.cachePoolRole),['standby','standby']);
  const started=Date.now(),response=await rawJson(port,'/v1/chat/completions',{model:'m',messages:[]},{'Session-Id':'all-reserve'}),elapsed=Date.now()-started;
  assert.equal(response.status,429);assert.ok(elapsed<200,`ineligible reserve candidates waited ${elapsed}ms instead of failing safely`);
  const log=await waitUntil(async()=>{const page=await(await fetch(`http://127.0.0.1:${port}/api/logs/requests?requestedModel=m&limit=1`)).json();return page.items[0];});
  assert.equal(log.selectionReason,'capacity-unavailable');assert.equal(log.cachePoolTier,null);assert.equal(log.cachePoolFallback,false);
});

test('cache pool waits, grows one active member, persists target and returns 429 at max', async (t) => {
  const seen=[];const upstream=http.createServer((req,res)=>{if(req.method==='GET'){res.writeHead(500,{'Content-Type':'application/json'});return res.end('{}');}req.resume();req.on('end',()=>{seen.push({authorization:req.headers.authorization,at:Date.now()});setTimeout(()=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:'OK'}}]}));},140);});});
  const upstreamPort=await listen(upstream),port=await unusedPort(),accounts=[{id:'a',name:'A',key:'key-a',enabled:true,priority:1,maxConcurrent:1,perModel:{}},{id:'b',name:'B',key:'key-b',enabled:true,priority:2,maxConcurrent:1,perModel:{}},{id:'c',name:'C',key:'key-c',enabled:true,priority:3,maxConcurrent:1,perModel:{}}];
  let running=await startSwitcher({port,upstreamBase:`http://127.0.0.1:${upstreamPort}`,accounts,accountMode:'sticky',activeAccount:0,concurrencyWaitMs:40,knownModels:['slow'],perModel:{},accountErrorRules:{},accountPipeline:{quotaPool:false,excludeUnhealthy:false,healthSort:false,sticky:false,order:PIPELINE_STEP_ORDER,cachePoolSize:2,cachePoolMaxSize:3}},null,{NODE_ENV:'test'});
  t.after(async()=>{if(running?.child)await stop(running.child);await close(upstream);fs.rmSync(running.dir,{recursive:true,force:true});});
  const headers={'Session-Id':'cache-capacity-session'},body={model:'slow',messages:[]};
  const first=rawJson(port,'/v1/chat/completions',body,headers);await waitUntil(()=>seen.length===1);
  const second=rawJson(port,'/v1/chat/completions',body,headers);await waitUntil(()=>seen.length===2);
  const overflowStarted=Date.now(),third=rawJson(port,'/v1/chat/completions',body,headers);await waitUntil(()=>seen.length===3);assert.ok(seen[2].at-overflowStarted>=25,'standby must not be used before the active wait expires');
  const responses=await Promise.all([first,second,third]);assert.ok(responses.every(response=>response.status===200));assert.deepEqual(new Set(responses.slice(0,2).map(response=>response.headers['x-cline-account'])),new Set(['A','B']));assert.equal(responses[2].headers['x-cline-account'],'C');
  const logs=await waitUntil(async()=>{const page=await(await fetch(`http://127.0.0.1:${port}/api/logs/requests?requestedModel=slow&limit=20`)).json();return page.items.length>=3&&page.items;});
  const byReason=Object.fromEntries(logs.map(item=>[item.selectionReason,item])),grownLog=logs.find(item=>item.accountName==='C');assert.equal(byReason['cache-pool-active']?.cachePoolTier,'active');assert.ok(['cache-pool-active','cache-pool-active-overflow'].includes(grownLog?.selectionReason));assert.equal(grownLog?.cachePoolTier,'active');assert.equal(grownLog?.cachePoolFallback,false);assert.equal(grownLog?.cachePoolSize,2);assert.equal(grownLog?.cachePoolMaxSize,3);assert.equal(grownLog?.cachePoolTargetSize,3);
  const serialized=JSON.stringify(logs);assert.equal(serialized.includes('cache-capacity-session'),false);for(const secret of ['key-a','key-b','key-c'])assert.equal(serialized.includes(secret),false);
  let view=await(await fetch(`http://127.0.0.1:${port}/api/accounts`)).json();assert.equal(view.cachePool.targetSize,3);assert.equal(JSON.parse(fs.readFileSync(path.join(running.dir,'metadata.json'))).cachePoolTargetSize,3);
  const runtimeDir=running.dir;await stop(running.child);running.child=null;running=await startSwitcher(null,runtimeDir,{NODE_ENV:'test'});view=await(await fetch(`http://127.0.0.1:${port}/api/accounts`)).json();assert.equal(view.cachePool.targetSize,3,'grown target survives restart');assert.deepEqual(view.accounts.map(account=>account.cachePoolRole),['active','active','active']);
  view.accounts.find(account=>account.id==='c').enabled=false;
  assert.equal((await rawJson(port,'/api/accounts',{accounts:view.accounts,mode:'sticky',active:0,concurrencyWaitMs:40,accountErrorRules:{},accountPipeline:view.accountPipeline})).status,200);
  seen.length=0;const heldA=rawJson(port,'/v1/chat/completions',body,headers);await waitUntil(()=>seen.length===1);const heldB=rawJson(port,'/v1/chat/completions',body,headers);await waitUntil(()=>seen.length===2);const blocked=await rawJson(port,'/v1/chat/completions',body,headers);assert.equal(blocked.status,429);assert.equal(blocked.headers['retry-after'],'1');await Promise.all([heldA,heldB]);
  view=await(await fetch(`http://127.0.0.1:${port}/api/accounts`)).json();assert.deepEqual(view.accounts.map(account=>account.activeCount),[0,0,0]);
  assert.equal((await rawJson(port,'/api/accounts',{accounts:view.accounts,mode:'sticky',active:0,concurrencyWaitMs:40,errorRules:view.errorRules,accountPipeline:{...view.accountPipeline,cachePoolMaxSize:2}})).status,200);view=await(await fetch(`http://127.0.0.1:${port}/api/accounts`)).json();assert.equal(view.cachePool.targetSize,2,'operator max clamp is explicit and durable');assert.equal(JSON.parse(fs.readFileSync(path.join(running.dir,'metadata.json'))).cachePoolTargetSize,2);
});

test('concurrent saturation grows only to max while unlimited active capacity never grows', async (t) => {
  const seen=[];const upstream=http.createServer((req,res)=>{if(req.method==='GET'){res.writeHead(500);return res.end('{}');}req.resume();req.on('end',()=>{seen.push(req.headers.authorization);setTimeout(()=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:'OK'}}]}));},140);});});
  const upstreamPort=await listen(upstream),port=await unusedPort(),accounts=['a','b','c','d'].map((id,index)=>({id,name:id.toUpperCase(),key:`key-${id}`,enabled:true,priority:index+1,maxConcurrent:1,perModel:{}}));
  const running=await startSwitcher({port,upstreamBase:`http://127.0.0.1:${upstreamPort}`,accounts,accountMode:'sticky',concurrencyWaitMs:25,knownModels:['slow'],perModel:{},errorRules:[],accountPipeline:{quotaPool:false,healthSort:false,sticky:false,order:PIPELINE_STEP_ORDER,cachePoolSize:1,cachePoolMaxSize:3}},null,{NODE_ENV:'test'});t.after(async()=>{await stop(running.child);await close(upstream);fs.rmSync(running.dir,{recursive:true,force:true});});
  const body={model:'slow',messages:[]},first=rawJson(port,'/v1/chat/completions',body,{'Session-Id':'grow-1'});await waitUntil(()=>seen.length===1);
  const concurrent=['grow-2','grow-3','grow-4'].map(session=>rawJson(port,'/v1/chat/completions',body,{'Session-Id':session}));
  await waitUntil(()=>seen.length===3);const responses=await Promise.all([first,...concurrent]);assert.equal(responses.filter(response=>response.status===200).length,3);assert.equal(responses.filter(response=>response.status===429).length,1);assert.equal(new Set(seen).size,3);assert.equal(seen.includes('Bearer key-d'),false);
  let view=await(await fetch(`http://127.0.0.1:${port}/api/accounts`)).json();assert.equal(view.cachePool.targetSize,3);assert.deepEqual(view.accounts.map(account=>account.activeCount),[0,0,0,0]);
  view.accounts[0].maxConcurrent=0;
  assert.equal((await rawJson(port,'/api/accounts',{accounts:view.accounts,mode:'sticky',active:0,concurrencyWaitMs:25,errorRules:view.errorRules,accountPipeline:{...view.accountPipeline,cachePoolSize:1,cachePoolMaxSize:1}})).status,200);
  view=await(await fetch(`http://127.0.0.1:${port}/api/accounts`)).json();assert.equal((await rawJson(port,'/api/accounts',{accounts:view.accounts,mode:'sticky',active:0,concurrencyWaitMs:25,errorRules:view.errorRules,accountPipeline:{...view.accountPipeline,cachePoolMaxSize:3}})).status,200);
  seen.length=0;const unlimited=await Promise.all(['unlimited-1','unlimited-2','unlimited-3'].map(session=>rawJson(port,'/v1/chat/completions',body,{'Session-Id':session})));assert.ok(unlimited.every(response=>response.status===200));assert.deepEqual(new Set(seen),new Set(['Bearer key-a']));view=await(await fetch(`http://127.0.0.1:${port}/api/accounts`)).json();assert.equal(view.cachePool.targetSize,1,'unlimited active account never emits saturation growth');
});

test('one saturation deadline grows at most one member when the promoted standby is already full', async (t) => {
  const seen=[];
  const upstream=http.createServer((req,res)=>{if(req.method==='GET'){res.writeHead(500);return res.end('{}');}req.resume();req.on('end',()=>{seen.push(req.headers.authorization);setTimeout(()=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:'OK'}}]}));},160);});});
  const upstreamPort=await listen(upstream),port=await unusedPort(),accounts=['a','b','c'].map((id,index)=>({id,name:id.toUpperCase(),key:`key-${id}`,enabled:true,priority:index+1,maxConcurrent:1,perModel:{}}));
  const running=await startSwitcher({port,upstreamBase:`http://127.0.0.1:${upstreamPort}`,accounts,accountMode:'sticky',concurrencyWaitMs:25,knownModels:['slow'],perModel:{},errorRules:[],accountPipeline:{quotaPool:false,healthSort:false,sticky:false,order:PIPELINE_STEP_ORDER,cachePoolSize:1,cachePoolMaxSize:3}},null,{NODE_ENV:'test'});
  t.after(async()=>{await stop(running.child);await close(upstream);fs.rmSync(running.dir,{recursive:true,force:true});});
  const forcedStandby=rawJson(port,'/api/test',{model:'slow',accountId:'b'});await waitUntil(()=>seen.includes('Bearer key-b'));
  const heldActive=rawJson(port,'/v1/chat/completions',{model:'slow',messages:[]},{'Session-Id':'held-active'});await waitUntil(()=>seen.includes('Bearer key-a'));
  const blocked=await rawJson(port,'/v1/chat/completions',{model:'slow',messages:[]},{'Session-Id':'single-growth-deadline'});
  assert.equal(blocked.status,429,'one elapsed deadline must not chain through multiple target increments');
  const view=await(await fetch(`http://127.0.0.1:${port}/api/accounts`)).json();assert.equal(view.cachePool.targetSize,2,'the one synchronous growth decision is still durable');assert.equal(seen.includes('Bearer key-c'),false,'only the newly promoted, still-full account may be attempted after this deadline');
  await Promise.all([forcedStandby,heldActive]);
});

test('cache pool growth rolls back the runtime target when atomic metadata persistence fails', async (t) => {
  const seen=[];const upstream=http.createServer((req,res)=>{if(req.method==='GET'){res.writeHead(500);return res.end('{}');}req.resume();req.on('end',()=>{seen.push(req.headers.authorization);setTimeout(()=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:'OK'}}]}));},120);});});
  const upstreamPort=await listen(upstream),port=await unusedPort(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'cps-cache-growth-atomic-')),fault=path.join(dir,'metadata-fault'),loader=path.join(dir,'metadata-loader.mjs');
  fs.writeFileSync(loader,`import fs from 'node:fs';const rename=fs.renameSync;fs.renameSync=(a,b)=>{if(String(b).endsWith('/metadata.json')&&fs.existsSync(${JSON.stringify(fault)}))throw Error('fixture metadata growth failure');return rename(a,b);};`);
  const accounts=['a','b'].map((id,index)=>({id,name:id.toUpperCase(),key:`key-${id}`,enabled:true,priority:index+1,maxConcurrent:1,perModel:{}}));
  const running=await startSwitcher({port,upstreamBase:`http://127.0.0.1:${upstreamPort}`,accounts,accountMode:'sticky',concurrencyWaitMs:20,knownModels:['slow'],perModel:{},errorRules:[],accountPipeline:{quotaPool:false,healthSort:false,sticky:false,order:PIPELINE_STEP_ORDER,cachePoolSize:1,cachePoolMaxSize:2}},dir,{NODE_ENV:'test',NODE_OPTIONS:`--import=${loader}`});
  t.after(async()=>{await stop(running.child);await close(upstream);fs.rmSync(dir,{recursive:true,force:true});});
  const held=rawJson(port,'/v1/chat/completions',{model:'slow',messages:[]},{'Session-Id':'atomic-growth-holder'});await waitUntil(()=>seen.length===1);fs.writeFileSync(fault,'');
  const blocked=await rawJson(port,'/v1/chat/completions',{model:'slow',messages:[]},{'Session-Id':'atomic-growth-blocked'});assert.equal(blocked.status,429);fs.unlinkSync(fault);
  const view=await(await fetch(`http://127.0.0.1:${port}/api/accounts`)).json();assert.equal(view.cachePool.targetSize,1);assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'metadata.json'))).cachePoolTargetSize,1);assert.equal(fs.readdirSync(dir).some(name=>/^metadata\.json\..*\.tmp$/.test(name)),false,'failed atomic writes remove their temporary file');
  assert.match(running.output(),/扩容目标持久化失败/);assert.equal((await held).status,200);
});

test('sticky plus healthSort binds misses by health, preserves hits, overflows temporarily and replaces removed accounts', async (t) => {
  const seen=[];
  const upstream=http.createServer((req,res)=>{if(req.method==='GET'){res.writeHead(500,{'Content-Type':'application/json'});return res.end('{}');}const chunks=[];req.on('data',chunk=>chunks.push(chunk));req.on('end',()=>{const body=JSON.parse(Buffer.concat(chunks).toString()||'{}'),authorization=req.headers.authorization;seen.push({model:body.model,authorization,at:Date.now()});const reply=()=>{if(body.model==='fail'){res.writeHead(500,{'Content-Type':'application/json'});return res.end(JSON.stringify({error:{message:'trained account failure'}}));}if(body.model==='remove'&&authorization==='Bearer key-b'){res.writeHead(429,{'Content-Type':'application/json'});return res.end(JSON.stringify({error:{message:'account quota exhausted'}}));}res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:'OK'}}]}));};body.model==='slow'?setTimeout(reply,120):reply();});});
  const upstreamPort=await listen(upstream),port=await unusedPort(),accounts=[{id:'a',name:'A',key:'key-a',enabled:true,priority:1,maxConcurrent:1,perModel:{}},{id:'b',name:'B',key:'key-b',enabled:true,priority:2,maxConcurrent:1,perModel:{}}];
  const rules=[{id:'train-degrade',scope:'account',action:'degrade',when:{statuses:[500]}},{id:'remove-account',scope:'account',action:'cooldown',when:{statuses:[429]},reset:{fallback:'1h0m0s',max:'1h0m0s'}}];
  let running=await startSwitcher({port,upstreamBase:`http://127.0.0.1:${upstreamPort}`,accounts,accountMode:'single',activeAccount:0,concurrencyWaitMs:20,knownModels:['ok','fail','slow','remove','blocked'],perModel:{blocked:{upstreams:['only'],exclude:['only'],pinMode:'strict'}},errorRules:rules,accountPipeline:{quotaPool:false,healthSort:false,sticky:false,order:PIPELINE_STEP_ORDER,cachePoolSize:0}},null,{NODE_ENV:'test'});
  t.after(async()=>{if(running?.child)await stop(running.child);await close(upstream);fs.rmSync(running.dir,{recursive:true,force:true});});
  for(let i=0;i<4;i++)assert.equal((await rawJson(port,'/v1/chat/completions',{model:'ok',messages:[]})).status,200);
  assert.equal((await rawJson(port,'/v1/chat/completions',{model:'fail',messages:[]})).status,500);
  let view=await(await fetch(`http://127.0.0.1:${port}/api/accounts`)).json();
  assert.equal((await rawJson(port,'/api/accounts',{accounts:view.accounts,mode:'single',active:1,concurrencyWaitMs:20,errorRules:view.errorRules,accountPipeline:view.accountPipeline})).status,200);
  assert.equal((await rawJson(port,'/v1/chat/completions',{model:'ok',messages:[]})).headers['x-cline-account'],'B');
  view=await(await fetch(`http://127.0.0.1:${port}/api/accounts`)).json();
  const bindingPipeline={...view.accountPipeline,healthSort:true,cachePoolSize:2,cachePoolMaxSize:2,sessionBindingExplicitTtlMs:7200000,sessionBindingFallbackTtlMs:900000,sessionBindingMaxEntries:50000};
  assert.equal((await rawJson(port,'/api/accounts',{accounts:view.accounts,mode:'sticky',active:0,concurrencyWaitMs:20,errorRules:view.errorRules,accountPipeline:bindingPipeline})).status,200);
  const noAttemptHeaders={'Session-Id':'no-attempt-binding'};assert.equal((await rawJson(port,'/v1/chat/completions',{model:'blocked',messages:[]},noAttemptHeaders)).status,503);const afterNoAttempt=await rawJson(port,'/v1/chat/completions',{model:'ok',messages:[]},noAttemptHeaders);const afterNoAttemptLog=await waitUntil(async()=>{const page=await(await fetch(`http://127.0.0.1:${port}/api/logs/requests?requestId=${afterNoAttempt.headers['x-cline-request-id']}`)).json();return page.items[0];});assert.equal(afterNoAttemptLog.bindingResult,'miss','a provisional binding with no native attempt is owner-safely removed');
  const boundHeaders={'Session-Id':'stateful-binding-secret'};
  const first=await rawJson(port,'/v1/chat/completions',{model:'ok',messages:[]},boundHeaders);assert.equal(first.headers['x-cline-account'],'B','health miss chooses the higher direct success rate');
  const firstLog=await waitUntil(async()=>{const page=await(await fetch(`http://127.0.0.1:${port}/api/logs/requests?requestId=${first.headers['x-cline-request-id']}`)).json();return page.items[0];});assert.equal(firstLog.bindingSource,'explicit');assert.equal(firstLog.bindingResult,'miss');
  view=await(await fetch(`http://127.0.0.1:${port}/api/accounts`)).json();assert.equal((await rawJson(port,'/api/accounts',{accounts:view.accounts,mode:'sticky',active:0,concurrencyWaitMs:200,errorRules:view.errorRules,accountPipeline:view.accountPipeline})).status,200);
  const beforeHolders=seen.length,heldBound=rawJson(port,'/v1/chat/completions',{model:'slow',messages:[]},boundHeaders);await waitUntil(()=>seen.length===beforeHolders+1);
  const heldOther=rawJson(port,'/v1/chat/completions',{model:'slow',messages:[]},{'Session-Id':'fill-other-active'});await waitUntil(()=>seen.length===beforeHolders+2);assert.deepEqual(new Set(seen.slice(-2).map(item=>item.authorization)),new Set(['Bearer key-a','Bearer key-b']));
  const provisionalOne=rawJson(port,'/v1/chat/completions',{model:'ok',messages:[]},{'Session-Id':'provisional-convergence'}),provisionalTwo=rawJson(port,'/v1/chat/completions',{model:'ok',messages:[]},{'Session-Id':'provisional-convergence'});
  await Promise.all([heldBound,heldOther]);const provisionalResponses=await Promise.all([provisionalOne,provisionalTwo]);assert.equal(provisionalResponses[0].headers['x-cline-account'],provisionalResponses[1].headers['x-cline-account'],'concurrent first requests converge through the provisional binding');
  const provisionalLogs=await waitUntil(async()=>{const ids=new Set(provisionalResponses.map(response=>response.headers['x-cline-request-id'])),page=await(await fetch(`http://127.0.0.1:${port}/api/logs/requests?limit=100`)).json(),items=page.items.filter(item=>ids.has(item.requestId));return items.length===2&&items;});assert.deepEqual(new Set(provisionalLogs.map(item=>item.bindingResult)),new Set(['miss','provisional']));
  view=await(await fetch(`http://127.0.0.1:${port}/api/accounts`)).json();assert.equal((await rawJson(port,'/api/accounts',{accounts:view.accounts,mode:'sticky',active:0,concurrencyWaitMs:20,errorRules:view.errorRules,accountPipeline:view.accountPipeline})).status,200);
  assert.equal((await rawJson(port,'/v1/chat/completions',{model:'fail',messages:[]},boundHeaders)).headers['x-cline-account'],'B');
  assert.equal((await rawJson(port,'/v1/chat/completions',{model:'fail',messages:[]},boundHeaders)).headers['x-cline-account'],'B');
  const retained=await rawJson(port,'/v1/chat/completions',{model:'ok',messages:[]},boundHeaders);assert.equal(retained.headers['x-cline-account'],'B','success-rate changes do not migrate an existing binding');
  const fresh=await rawJson(port,'/v1/chat/completions',{model:'ok',messages:[]},{'Session-Id':'health-miss-new'});assert.equal(fresh.headers['x-cline-account'],'A','a new miss observes the updated health order');
  const heldSeen=seen.length,held=rawJson(port,'/v1/chat/completions',{model:'slow',messages:[]},boundHeaders);await waitUntil(()=>seen.length>heldSeen&&seen.at(-1).model==='slow');
  const overflow=await rawJson(port,'/v1/chat/completions',{model:'ok',messages:[]},boundHeaders);assert.equal(overflow.headers['x-cline-account'],'A');assert.equal((await held).headers['x-cline-account'],'B');
  const overflowLog=await waitUntil(async()=>{const page=await(await fetch(`http://127.0.0.1:${port}/api/logs/requests?requestId=${overflow.headers['x-cline-request-id']}`)).json();return page.items[0];});assert.equal(overflowLog.bindingResult,'temporary-overflow');assert.equal(overflowLog.overflow,true);
  assert.equal((await rawJson(port,'/v1/chat/completions',{model:'ok',messages:[]},boundHeaders)).headers['x-cline-account'],'B','temporary overflow never rewrites the binding');
  const removed=await rawJson(port,'/v1/chat/completions',{model:'remove',messages:[]},boundHeaders);assert.equal(removed.status,200);assert.equal(removed.headers['x-cline-account'],'A');
  assert.equal((await rawJson(port,'/v1/chat/completions',{model:'ok',messages:[]},boundHeaders)).headers['x-cline-account'],'A','account removal replacement owns the next confirmed binding');
  view=await(await fetch(`http://127.0.0.1:${port}/api/accounts`)).json();assert.equal(view.cachePool.binding.enabled,true);assert.ok(view.cachePool.binding.size>=2);assert.equal(Object.hasOwn(view.cachePool.binding,'entries'),false);
  const serialized=JSON.stringify(await(await fetch(`http://127.0.0.1:${port}/api/logs/requests?limit=100`)).json())+fs.readFileSync(path.join(running.dir,'metadata.json'),'utf8');assert.equal(serialized.includes('stateful-binding-secret'),false);assert.equal(serialized.includes('health-miss-new'),false);assert.equal(serialized.includes('no-attempt-binding'),false);
});

test('binding TTL, LRU and process restart remain bounded and non-persistent', async (t) => {
  const upstream=http.createServer((req,res)=>{if(req.method==='GET'){res.writeHead(500);return res.end('{}');}req.resume();req.on('end',()=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:'OK'}}]}));});}),upstreamPort=await listen(upstream),port=await unusedPort(),accounts=[{id:'a',name:'A',key:'key-a',enabled:true,perModel:{}},{id:'b',name:'B',key:'key-b',enabled:true,perModel:{}}];
  let running=await startSwitcher({port,upstreamBase:`http://127.0.0.1:${upstreamPort}`,accounts,accountMode:'sticky',concurrencyWaitMs:0,knownModels:['ok'],perModel:{},errorRules:[],accountPipeline:{quotaPool:false,healthSort:true,sticky:false,order:PIPELINE_STEP_ORDER,cachePoolSize:2,cachePoolMaxSize:2,sessionBindingExplicitTtlMs:300000,sessionBindingFallbackTtlMs:60000,sessionBindingMaxEntries:1}},null,{NODE_ENV:'test',CLINE_PASS_TEST_BINDING_TTL_SCALE:'0.001'});
  t.after(async()=>{if(running?.child)await stop(running.child);await close(upstream);fs.rmSync(running.dir,{recursive:true,force:true});});
  const send=async(session,messages=[])=>rawJson(port,'/v1/chat/completions',{model:'ok',messages},{...(session?{'Session-Id':session}:{})});
  const one=await send('ttl-one');await new Promise(resolve=>setTimeout(resolve,180));const oneHit=await send('ttl-one');
  const oneHitLog=await waitUntil(async()=>{const page=await(await fetch(`http://127.0.0.1:${port}/api/logs/requests?requestId=${oneHit.headers['x-cline-request-id']}`)).json();return page.items[0];});assert.equal(oneHitLog.bindingResult,'hit');
  await new Promise(resolve=>setTimeout(resolve,180));const slidingHit=await send('ttl-one');const slidingHitLog=await waitUntil(async()=>{const page=await(await fetch(`http://127.0.0.1:${port}/api/logs/requests?requestId=${slidingHit.headers['x-cline-request-id']}`)).json();return page.items[0];});assert.equal(slidingHitLog.bindingResult,'hit','explicit binding TTL slides from the latest hit');
  await new Promise(resolve=>setTimeout(resolve,330));const expired=await send('ttl-one');const expiredLog=await waitUntil(async()=>{const page=await(await fetch(`http://127.0.0.1:${port}/api/logs/requests?requestId=${expired.headers['x-cline-request-id']}`)).json();return page.items[0];});assert.equal(expiredLog.bindingResult,'invalidated');
  await send('lru-two');const evicted=await send('ttl-one');const evictedLog=await waitUntil(async()=>{const page=await(await fetch(`http://127.0.0.1:${port}/api/logs/requests?requestId=${evicted.headers['x-cline-request-id']}`)).json();return page.items[0];});assert.equal(evictedLog.bindingResult,'miss');
  const fallback=await send(null,[{role:'user',content:'stable fallback opening'}]);const fallbackLog=await waitUntil(async()=>{const page=await(await fetch(`http://127.0.0.1:${port}/api/logs/requests?requestId=${fallback.headers['x-cline-request-id']}`)).json();return page.items[0];});assert.equal(fallbackLog.bindingSource,'fallback');
  await new Promise(resolve=>setTimeout(resolve,80));const fallbackExpired=await send(null,[{role:'user',content:'stable fallback opening'}]);const fallbackExpiredLog=await waitUntil(async()=>{const page=await(await fetch(`http://127.0.0.1:${port}/api/logs/requests?requestId=${fallbackExpired.headers['x-cline-request-id']}`)).json();return page.items[0];});assert.equal(fallbackExpiredLog.bindingResult,'invalidated','fallback binding uses its shorter configured TTL');
  let view=await(await fetch(`http://127.0.0.1:${port}/api/accounts`)).json();assert.equal(view.cachePool.binding.size,1);assert.equal(view.cachePool.binding.maxEntries,1);assert.equal(JSON.stringify(JSON.parse(fs.readFileSync(path.join(running.dir,'metadata.json')))).includes('stable fallback opening'),false);
  const restart=await send('restart-session');const restartHit=await send('restart-session');assert.equal((await waitUntil(async()=>{const page=await(await fetch(`http://127.0.0.1:${port}/api/logs/requests?requestId=${restartHit.headers['x-cline-request-id']}`)).json();return page.items[0];})).bindingResult,'hit');
  const dir=running.dir;await stop(running.child);running.child=null;running=await startSwitcher(null,dir,{NODE_ENV:'test',CLINE_PASS_TEST_BINDING_TTL_SCALE:'0.001'});const afterRestart=await send('restart-session');const restartLog=await waitUntil(async()=>{const page=await(await fetch(`http://127.0.0.1:${port}/api/logs/requests?requestId=${afterRestart.headers['x-cline-request-id']}`)).json();return page.items[0];});assert.equal(restartLog.bindingResult,'miss');
  view=await(await fetch(`http://127.0.0.1:${port}/api/accounts`)).json();assert.equal(view.cachePool.binding.size,1);assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(path.join(dir,'metadata.json'))),'sessionBindings'),false);assert.equal(one.status,200);assert.equal(restart.status,200);
});

test('combined binding works without a cache pool and clears on credential rotation, disable and quota reserve', async (t) => {
  const seen=[];let reserveKey=null;
  const upstream=http.createServer((req,res)=>{
    if(req.method==='GET'){
      if(req.url.endsWith('/users/me/plan/usage-limits')){
        const percentUsed=reserveKey!==null&&req.headers.authorization===reserveKey?95:10;
        res.writeHead(200,{'Content-Type':'application/json'});
        return res.end(JSON.stringify({success:true,data:{limits:[{type:'five_hour',percentUsed},{type:'weekly',percentUsed},{type:'monthly',percentUsed}]}}));
      }
      res.writeHead(500,{'Content-Type':'application/json'});return res.end('{}');
    }
    req.resume();req.on('end',()=>{seen.push(req.headers.authorization);res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:'OK'}}]}));});
  });
  const upstreamPort=await listen(upstream),port=await unusedPort(),accounts=[{id:'a',name:'A',key:'key-a',enabled:true,priority:1,maxConcurrent:1,perModel:{}},{id:'b',name:'B',key:'key-b',enabled:true,priority:2,maxConcurrent:1,perModel:{}}];
  const running=await startSwitcher({port,upstreamBase:`http://127.0.0.1:${upstreamPort}`,accounts,accountMode:'single',activeAccount:0,concurrencyWaitMs:0,knownModels:['ok'],perModel:{},errorRules:[],accountPipeline:{quotaPool:false,healthSort:true,sticky:true,order:PIPELINE_STEP_ORDER,cachePoolSize:0,cachePoolMaxSize:0}},null,{NODE_ENV:'test'});
  t.after(async()=>{await stop(running.child);await close(upstream);fs.rmSync(running.dir,{recursive:true,force:true});});
  const view=async()=>(await fetch(`http://127.0.0.1:${port}/api/accounts`)).json();
  const logFor=async(response)=>{const id=response.headers['x-cline-request-id'];return waitUntil(async()=>{const page=await(await fetch(`http://127.0.0.1:${port}/api/logs/requests?requestId=${id}`)).json();return page.items[0];});};
  const send=(session)=>rawJson(port,'/v1/chat/completions',{model:'ok',messages:[]},{'Session-Id':session});
  const save=async(patch,mapAccounts=null)=>{const state=await view();const response=await rawJson(port,'/api/accounts',{accounts:mapAccounts?mapAccounts(state.accounts):state.accounts,mode:state.mode,active:state.active,concurrencyWaitMs:0,errorRules:state.errorRules,accountPipeline:{...state.accountPipeline,...patch}});assert.equal(response.status,200);return view();};
  assert.equal((await view()).cachePool.targetSize,0,'combined binding is independent of a cache pool');
  const first=await send('no-pool-binding');assert.equal((await logFor(first)).bindingResult,'miss');
  const boundName=first.headers['x-cline-account'];let state=await view();assert.equal(state.cachePool.binding.enabled,true);assert.equal(state.cachePool.binding.size,1,'a miss builds a binding without any cache pool');
  const hit=await send('no-pool-binding');assert.equal(hit.headers['x-cline-account'],boundName);assert.equal((await logFor(hit)).bindingResult,'hit');
  state=await save({sticky:false});
  assert.equal(state.cachePool.binding.enabled,false);assert.equal(state.cachePool.binding.size,0,'healthSort-only never keeps a binding table');
  assert.equal((await logFor(await send('health-only-session'))).bindingResult,'not-applicable');assert.equal((await view()).cachePool.binding.size,0);
  state=await save({sticky:true,healthSort:false});
  assert.equal(state.cachePool.binding.enabled,false);
  assert.equal((await logFor(await send('sticky-only-session'))).bindingResult,'not-applicable');assert.equal((await view()).cachePool.binding.size,0,'sticky-only HRW stays stateless');
  state=await save({healthSort:true});
  const rotated=await send('rotate-binding');assert.equal((await logFor(rotated)).bindingResult,'miss');
  const rotatedName=rotated.headers['x-cline-account'],rotatedId=state.accounts.find(account=>account.name===rotatedName).id;assert.equal((await view()).cachePool.binding.size,1);
  state=await save({},(list)=>list.map(account=>account.id===rotatedId?{...account,key:`${account.key}-rotated`}:account));
  assert.equal(state.cachePool.binding.size,0,'credential rotation invalidates the bound session');
  assert.equal((await logFor(await send('rotate-binding'))).bindingResult,'miss');
  const disabled=await send('disable-binding');const disabledName=disabled.headers['x-cline-account'],remainingName=disabledName==='A'?'B':'A',disabledId=(await view()).accounts.find(account=>account.name===disabledName).id;
  state=await save({},(list)=>list.map(account=>account.id===disabledId?{...account,enabled:false}:account));
  const rehomed=await send('disable-binding');assert.equal(rehomed.headers['x-cline-account'],remainingName,'the remaining account replaces the disabled binding');assert.ok(['miss','invalidated'].includes((await logFor(rehomed)).bindingResult));
  const reserved=await send('reserve-binding');const reservedName=reserved.headers['x-cline-account'],reservedKey=state.accounts.find(account=>account.name===reservedName).key;assert.equal(reservedName,remainingName);assert.equal((await logFor(reserved)).bindingResult,'miss');
  assert.ok((await view()).cachePool.binding.size>=1,'the only eligible account owns the session binding');
  reserveKey=`Bearer ${reservedKey}`;
  assert.equal((await rawJson(port,'/api/statistics/quota-refresh',{force:true})).status,200);
  await waitUntil(async()=>{const snapshot=await view();return snapshot.cachePool.binding.size===0&&snapshot.accounts.find(account=>account.name===reservedName).quota.pool==='reserve';});
  state=await save({},(list)=>list.map(account=>account.id===disabledId?{...account,enabled:true}:account));
  const rebind=await send('reserve-binding');assert.notEqual(rebind.headers['x-cline-account'],reservedName,'a reserve account is replaced by the next eligible account');assert.ok(['miss','invalidated'].includes((await logFor(rebind)).bindingResult),'a reserve account never keeps its binding');
  assert.equal(seen.includes(`Bearer ${reservedKey}`),true,'the pre-reserve binding still served real traffic');
});

test('a saturated combined-mode miss grows one standby, promotes it and only then binds the session', async (t) => {
  const seen=[];
  const upstream=http.createServer((req,res)=>{if(req.method==='GET'){res.writeHead(500);return res.end('{}');}req.resume();req.on('end',()=>{seen.push(req.headers.authorization);setTimeout(()=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:'OK'}}]}));},140);});});
  const upstreamPort=await listen(upstream),port=await unusedPort(),accounts=[{id:'a',name:'A',key:'key-a',enabled:true,priority:1,maxConcurrent:1,perModel:{}},{id:'b',name:'B',key:'key-b',enabled:true,priority:2,maxConcurrent:1,perModel:{}}];
  const running=await startSwitcher({port,upstreamBase:`http://127.0.0.1:${upstreamPort}`,accounts,accountMode:'sticky',concurrencyWaitMs:30,knownModels:['slow'],perModel:{},errorRules:[],accountPipeline:{quotaPool:false,healthSort:true,sticky:true,order:PIPELINE_STEP_ORDER,cachePoolSize:1,cachePoolMaxSize:2}},null,{NODE_ENV:'test'});
  t.after(async()=>{await stop(running.child);await close(upstream);fs.rmSync(running.dir,{recursive:true,force:true});});
  const view=async()=>(await fetch(`http://127.0.0.1:${port}/api/accounts`)).json();
  const logFor=async(response)=>{const id=response.headers['x-cline-request-id'];return waitUntil(async()=>{const page=await(await fetch(`http://127.0.0.1:${port}/api/logs/requests?requestId=${id}`)).json();return page.items[0];});};
  const send=(session)=>rawJson(port,'/v1/chat/completions',{model:'slow',messages:[]},{'Session-Id':session});
  let state=await view();assert.equal(state.cachePool.targetSize,1);assert.deepEqual(state.accounts.map(account=>account.cachePoolRole),['active','standby']);
  const holder=send('binding-holder');await waitUntil(()=>seen.length===1);
  const promoted=send('binding-promoted');await waitUntil(()=>seen.length===2);
  const responses=await Promise.all([holder,promoted]);assert.ok(responses.every(response=>response.status===200));
  assert.equal(responses[0].headers['x-cline-account'],'A');assert.equal(responses[1].headers['x-cline-account'],'B','the saturated miss uses the promoted account, not a permanent standby');
  const promotedLog=await logFor(responses[1]);assert.equal(promotedLog.bindingResult,'miss');assert.equal(promotedLog.bindingSource,'explicit');assert.equal(promotedLog.cachePoolTargetSize,2);
  state=await view();assert.equal(state.cachePool.targetSize,2,'promotion is durable');assert.equal(JSON.parse(fs.readFileSync(path.join(running.dir,'metadata.json'))).cachePoolTargetSize,2);assert.deepEqual(state.accounts.map(account=>account.cachePoolRole),['active','active']);assert.equal(state.cachePool.binding.size,2);
  const promotedHit=await send('binding-promoted');assert.equal(promotedHit.headers['x-cline-account'],'B');assert.equal((await logFor(promotedHit)).bindingResult,'hit','the promoted account owns the session binding');
  const holderHit=await send('binding-holder');assert.equal(holderHit.headers['x-cline-account'],'A');assert.equal((await logFor(holderHit)).bindingResult,'hit');
});

test('missing and explicit all-false pipelines preserve all six mode sequences, reasons, capacity and lease release', async (t) => {
  let slowStarted=0;
  const upstream=http.createServer((req,res)=>{const chunks=[];req.on('data',c=>chunks.push(c));req.on('end',()=>{const body=JSON.parse(Buffer.concat(chunks).toString()||'{}');const reply=()=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:'OK'}}]}));};if(body.model==='slow'){slowStarted++;setTimeout(reply,80);}else reply();});}),upstreamPort=await listen(upstream);t.after(()=>close(upstream));
  const run=async(mode,explicit)=>{const port=await unusedPort(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'cps-legacy-equivalence-')),accounts=[{id:'a',name:'A',key:'ka',enabled:true,maxConcurrent:1,weight:1,priority:1,perModel:{}},{id:'b',name:'B',key:'kb',enabled:true,maxConcurrent:1,weight:3,priority:10,perModel:{}}],cfg={port,upstreamBase:`http://127.0.0.1:${upstreamPort}`,accountMode:mode,activeAccount:0,concurrencyWaitMs:0,accounts,knownModels:['fast','slow'],perModel:{},accountErrorRules:{}};if(explicit)cfg.accountPipeline={quotaPool:false,excludeUnhealthy:false,healthSort:false,sticky:false};fs.writeFileSync(path.join(dir,'metadata.json'),JSON.stringify({models:{},history:[],accountStates:{},routingSecret:'fixed-equivalence-secret',stats:{}}));const running=await startSwitcher(cfg,dir);try{const sequence=[];for(let i=0;i<8;i++){const r=await rawJson(port,'/v1/chat/completions',{model:'fast',messages:[]});sequence.push(r.headers['x-cline-account']);}let expectedSlowStarts=slowStarted+1;const p1=rawJson(port,'/v1/chat/completions',{model:'slow',messages:[]});await waitUntil(()=>slowStarted>=expectedSlowStarts);expectedSlowStarts++;const p2=rawJson(port,'/v1/chat/completions',{model:'slow',messages:[]});if(mode!=='single')await waitUntil(()=>slowStarted>=expectedSlowStarts);const p3=rawJson(port,'/v1/chat/completions',{model:'slow',messages:[]});const capacity=(await Promise.all([p1,p2,p3])).map(r=>({status:r.status,retry:r.headers['retry-after']||null}));const view=await(await fetch(`http://127.0.0.1:${port}/api/accounts`)).json(),logs=await waitUntil(async()=>{const page=await(await fetch(`http://127.0.0.1:${port}/api/logs/requests?requestedModel=fast&limit=20`)).json();return page.items.length>=8&&page;});return{sequence,capacity,reasons:logs.items.map(x=>x.selectionReason).sort(),active:view.accounts.map(x=>x.activeCount),pipeline:view.accountPipeline};}finally{await stop(running.child);fs.rmSync(dir,{recursive:true,force:true});}};
  for(const mode of ['single','roundrobin','sticky','least-connections','weighted-roundrobin','priority-failover']){const legacy=await run(mode,false),allFalse=await run(mode,true);assert.deepEqual(allFalse.sequence,legacy.sequence,`${mode} selection sequence changed`);assert.deepEqual(allFalse.capacity,legacy.capacity,`${mode} wait/429 behavior changed`);assert.deepEqual(allFalse.reasons,legacy.reasons,`${mode} diagnostic reason changed`);assert.deepEqual(allFalse.active,[0,0]);assert.deepEqual(legacy.active,[0,0]);assert.deepEqual(legacy.pipeline,{quotaPool:false,healthSort:false,sticky:false,order:['quotaPool','healthSort','sticky'],cachePoolSize:0,...PIPELINE_RUNTIME_DEFAULTS});}
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

test('quota and success-rate stages retain stable refinement order', async (t) => {
  const port=await unusedPort(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'cps-pipeline-refinement-'));
  const accounts=[{id:'a',name:'A',key:'a',enabled:true,perModel:{}},{id:'b',name:'B',key:'b',enabled:true,perModel:{}}];
  const running=await startSwitcher({port,accounts,accountMode:'roundrobin',activeAccount:0,knownModels:['m'],perModel:{},errorRules:[],accountPipeline:{quotaPool:false,healthSort:true,sticky:false,order:['healthSort','quotaPool','sticky'],cachePoolSize:0}},dir);t.after(async()=>{await stop(running.child);fs.rmSync(dir,{recursive:true,force:true});});
  const view=await(await fetch(`http://127.0.0.1:${port}/api/accounts`)).json();assert.deepEqual(view.accountPipeline.order,['healthSort','quotaPool','sticky']);assert.equal(view.accountPipeline.healthSort,true);
});

test('all canonical pipeline order permutations round-trip', async (t) => {
  const port=await unusedPort(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'cps-pipeline-permutations-')),accounts=[{id:'a',name:'A',key:'a',enabled:true,perModel:{}}];
  const running=await startSwitcher({port,accounts,accountMode:'single',activeAccount:0,knownModels:['m'],perModel:{},errorRules:[]},dir);t.after(async()=>{await stop(running.child);fs.rmSync(dir,{recursive:true,force:true});});
  const permutations=(values)=>values.length<2?[values]:values.flatMap((value,index)=>permutations([...values.slice(0,index),...values.slice(index+1)]).map(rest=>[value,...rest]));let view=await(await fetch(`http://127.0.0.1:${port}/api/accounts`)).json();
  for(const order of permutations(['quotaPool','healthSort','sticky'])){assert.equal((await rawJson(port,'/api/accounts',{accounts:view.accounts,mode:'single',active:0,concurrencyWaitMs:0,errorRules:view.errorRules,accountPipeline:{quotaPool:false,healthSort:false,sticky:false,order,cachePoolSize:0}})).status,200);view=await(await fetch(`http://127.0.0.1:${port}/api/accounts`)).json();assert.deepEqual(view.accountPipeline.order,order);}
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
  // Production cap is 50,000 union (minute, accountId) cells. Building and re-serializing a
  // 50k-cell fixture made this test a CPU hotspot under parallel test-file execution, so the
  // existing CLINE_PASS_TEST_* hook pattern injects a minimal cap that still exercises atomic
  // union eviction (accounts + health + accountHealth) and both coverage markers.
  const cap=3;
  const upstream=http.createServer((req,res)=>{req.resume();req.on('end',()=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:'OK'}}]}));});}),upstreamPort=await listen(upstream),port=await unusedPort(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'cps-cell-cap-'));
  const accounts=Array.from({length:cap+1},(_,i)=>({id:`a${i}`,name:`A${i}`,key:`k${i}`,enabled:true,perModel:{}}));
  const minute=Math.floor(Date.now()/60000),health={},accountCells={};for(let i=0;i<cap;i++){health[`a${i}`]=emptyHealthFixture();accountCells[`a${i}`]=emptyAggregateFixture();}
  const statistics={version:1,lifetime:{global:emptyAggregateFixture(),accounts:{}},minuteBuckets:[{minute,global:emptyAggregateFixture(),accounts:accountCells,health}],recentCoverage:{droppedAccountMinuteCells:0,accountIncompleteAt:{}},migration:{legacyStatsMigratedAt:Date.now(),legacyRequests:0,accountLegacyRequests:{},ambiguousNames:0,unmappedNames:0}};
  fs.writeFileSync(path.join(dir,'metadata.json'),JSON.stringify({models:{},history:[],accountStates:{},accountQuotas:{},routingSecret:'cell-cap-secret',statistics}));
  let running=await startSwitcher({port,upstreamBase:`http://127.0.0.1:${upstreamPort}`,accountMode:'single',activeAccount:cap,concurrencyWaitMs:0,accounts,knownModels:['m'],perModel:{},accountErrorRules:{}},dir,{NODE_ENV:'test',CLINE_PASS_TEST_ACCOUNT_MINUTE_CELL_LIMIT:String(cap)});t.after(async()=>{if(running?.child)await stop(running.child);await close(upstream);fs.rmSync(dir,{recursive:true,force:true});});
  assert.equal((await rawJson(port,'/v1/chat/completions',{model:'m',messages:[]})).status,200);const persisted=JSON.parse(fs.readFileSync(path.join(dir,'metadata.json'))),bucket=persisted.statistics.minuteBuckets[0];
  assert.equal(persisted.statistics.version,5,'valid v1 statistics migrate before the new request is committed');
  const fresh=`a${cap}`;
  const cells=new Set([...Object.keys(bucket.accounts),...Object.keys(bucket.health),...Object.keys(bucket.accountHealth)]);assert.equal(cells.size,cap);assert.equal(bucket.accounts.a0,undefined);assert.equal(bucket.health.a0,undefined);assert.equal(bucket.accountHealth.a0,undefined);assert.ok(bucket.accounts[fresh]);assert.ok(bucket.accountHealth[fresh]);assert.equal(persisted.statistics.recentCoverage.droppedAccountMinuteCells,1);assert.equal(persisted.statistics.recentCoverage.accountIncompleteAt.a0,minute);assert.equal(persisted.statistics.recentCoverage.accountHealthIncompleteAt.a0,minute);
});

test('provider success-health cells are independently capped with truthful coverage', async (t) => {
  const upstream=http.createServer((req,res)=>{req.resume();req.on('end',()=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:'ok'}}]}));});}),upstreamPort=await listen(upstream),port=await unusedPort();
  const running=await startSwitcher({port,upstreamBase:`http://127.0.0.1:${upstreamPort}`,accounts:[{id:'a',name:'A',key:'key',enabled:true,perModel:{}}],accountMode:'single',activeAccount:0,knownModels:['m1','m2'],perModel:{m1:{upstreams:['p1']},m2:{upstreams:['p2']}},errorRules:[]},null,{NODE_ENV:'test',CLINE_PASS_TEST_PROVIDER_HEALTH_CELL_LIMIT:'1'});t.after(async()=>{await stop(running.child);await close(upstream);fs.rmSync(running.dir,{recursive:true,force:true});});
  await rawJson(port,'/v1/chat/completions',{model:'m1',messages:[]});await rawJson(port,'/v1/chat/completions',{model:'m2',messages:[]});const metadata=JSON.parse(fs.readFileSync(path.join(running.dir,'metadata.json'))),coverage=metadata.statistics.recentCoverage;assert.equal(Object.values(metadata.statistics.minuteBuckets.at(-1).providerHealth).reduce((sum,providers)=>sum+Object.keys(providers).length,0),1);assert.equal(coverage.droppedProviderHealthMinuteCells,1);assert.ok(coverage.providerHealthIncompleteAt.m1?.p1!==undefined);
  const models=await(await fetch(`http://127.0.0.1:${port}/api/models`)).json();assert.equal(models.subscription.find(row=>row.id==='m1').meta.upstreamStatus.p1.success.successRate,null);assert.equal(models.subscription.find(row=>row.id==='m1').meta.upstreamStatus.p1.success.coverageComplete,false);assert.equal(models.subscription.find(row=>row.id==='m2').meta.upstreamStatus.p2.success.successRate,1);
});

test('account and provider success counters overflow to explicit unknown markers', async (t) => {
  const upstream=http.createServer((req,res)=>{req.resume();req.on('end',()=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:'ok'}}]}));});}),upstreamPort=await listen(upstream),port=await unusedPort(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'cps-success-overflow-'));
  let running=await startSwitcher({port,upstreamBase:`http://127.0.0.1:${upstreamPort}`,accounts:[{id:'a',name:'A',key:'key',enabled:true,perModel:{}}],accountMode:'single',activeAccount:0,knownModels:['m'],perModel:{m:{upstreams:['p']}},errorRules:[]},dir);t.after(async()=>{if(running?.child)await stop(running.child);await close(upstream);fs.rmSync(dir,{recursive:true,force:true});});await rawJson(port,'/v1/chat/completions',{model:'m',messages:[]});await stop(running.child);running.child=null;const metadataPath=path.join(dir,'metadata.json'),metadata=JSON.parse(fs.readFileSync(metadataPath)),bucket=metadata.statistics.minuteBuckets.at(-1);bucket.accountHealth.a.successes=Number.MAX_SAFE_INTEGER;bucket.providerHealth.m.p.successes=Number.MAX_SAFE_INTEGER;fs.writeFileSync(metadataPath,JSON.stringify(metadata));running=await startSwitcher(null,dir);await rawJson(port,'/v1/chat/completions',{model:'m',messages:[]});const persisted=JSON.parse(fs.readFileSync(metadataPath)),latest=persisted.statistics.minuteBuckets.at(-1);assert.equal(latest.accountHealth.a.successes,null);assert.deepEqual(latest.accountHealth.a.overflowFields,['successes']);assert.equal(latest.providerHealth.m.p.successes,null);assert.deepEqual(latest.providerHealth.m.p.overflowFields,['successes']);const stats=await(await fetch(`http://127.0.0.1:${port}/api/statistics`)).json();assert.equal(stats.accounts[0].health.successRate,null);assert.equal(stats.accounts[0].health.samples,null);
});

test('the model-minute cap evicts independently and marks only model coverage incomplete', async (t) => {
  const upstream=http.createServer((req,res)=>{req.resume();req.on('end',()=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:'OK'}}]}));});}),upstreamPort=await listen(upstream),port=await unusedPort(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'cps-model-cell-cap-'));
  const minute=Math.floor(Date.now()/60000),modelCells={m0:emptyAggregateFixture(),m1:emptyAggregateFixture()};
  const statistics={version:2,lifetime:{global:emptyAggregateFixture(),accounts:{}},minuteBuckets:[{minute,global:emptyAggregateFixture(),accounts:{},health:{},models:modelCells}],recentCoverage:{droppedAccountMinuteCells:0,accountIncompleteAt:{},modelTrackingStartedMinute:minute-2000,droppedModelMinuteCells:0,modelIncompleteAt:{}},migration:{legacyStatsMigratedAt:Date.now(),legacyRequests:0,accountLegacyRequests:{},ambiguousNames:0,unmappedNames:0}};
  fs.writeFileSync(path.join(dir,'metadata.json'),JSON.stringify({models:{},history:[],accountStates:{},accountQuotas:{},routingSecret:'model-cell-cap-secret',statistics}));
  const running=await startSwitcher({port,upstreamBase:`http://127.0.0.1:${upstreamPort}`,accountMode:'single',activeAccount:0,accounts:[{id:'a',name:'A',key:'ka',enabled:true,perModel:{}}],knownModels:['m2'],perModel:{},accountErrorRules:{}},dir,{NODE_ENV:'test',CLINE_PASS_TEST_MODEL_CELL_LIMIT:'2'});t.after(async()=>{await stop(running.child);await close(upstream);fs.rmSync(dir,{recursive:true,force:true});});
  assert.equal((await rawJson(port,'/v1/chat/completions',{model:'m2',messages:[]})).status,200);
  const persisted=JSON.parse(fs.readFileSync(path.join(dir,'metadata.json'))),bucket=persisted.statistics.minuteBuckets[0];
  assert.deepEqual(Object.keys(bucket.models),['m1','m2']);assert.equal(persisted.statistics.recentCoverage.droppedModelMinuteCells,1);assert.equal(persisted.statistics.recentCoverage.modelIncompleteAt.m0,minute);assert.equal(persisted.statistics.recentCoverage.droppedAccountMinuteCells,0);
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
      const finish=()=>{if(settled)return;if(phase==='hold'){row.held=true;return;}if(phase==='rate'){res.writeHead(429);return res.end('{}');}if(phase==='duplicate'){res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify({success:true,data:{limits:[{type:'weekly',percentUsed:1},{type:'weekly',percentUsed:2}]}}));}if(phase==='oversize'){res.writeHead(200,{'Content-Type':'application/json'});return res.end(' '.repeat(257*1024));}res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(goodPayload));};timer=setTimeout(finish,5);return;
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
  // Budget hygiene: this test never asserts that the deadline fires, and every mock reply takes a
  // fixed latency, so the injected deadline must stay an order of magnitude above that latency.
  // The mock replies after 5ms and the deadline is 80ms (16x). It previously replied after 30ms,
  // leaving 50ms of headroom - the same order as one local round trip under CPU load. The deadline
  // stays finite and small because the `hold` phases rely on it to recycle the two global slots.
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
  const upstream=http.createServer((req,res)=>{req.resume();req.on('end',()=>{if(req.method!=='GET'){res.writeHead(200,{'Content-Type':'application/json'});return res.end('{"choices":[{"message":{"content":"OK"}}]}');}hits.push({auth:req.headers.authorization,path:req.url,phase});if(phase==='rate'){res.writeHead(429);return res.end('{}');}const limits=phase==='monthly'?[{type:'monthly',percentUsed:0}]:phase==='partial'?[{type:'weekly',percentUsed:25}]:[{type:'five_hour',percentUsed:0,resetsAt:'2026-09-15T00:00:00.000Z'},{type:'weekly',percentUsed:37.5},{type:'monthly',percentUsed:100,resetsAt:'2026-10-01T00:00:00.000Z'}];res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({success:true,data:{limits}}));});});
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
  assert.equal((await rawJson(port,'/api/statistics/quota-refresh',{force:false},{},{skipAdmin:true})).status,401);
  for(const body of [null,[],{}, {force:'false'},{force:false,extra:true}])assert.equal((await refresh(body)).status,400);
  assert.equal((await refresh({force:false},'/api/statistics/quota-refresh?accountId=a')).status,400);assert.equal(hits.length,0);
  let result=await refresh({force:false});assert.equal(result.status,200);assert.deepEqual(result.json,{ok:true,refreshed:1,cached:0,deferred:0,skipped:1,failed:0,cancelled:0});assert.equal(hits.length,1);assert.deepEqual(hits[0],{auth:'Bearer enabled-key',path:'/api/v1/users/me/plan/usage-limits',phase:'full'});
  stats=await(await fetch(`http://127.0.0.1:${port}/api/statistics`,{headers:auth})).json();const enabled=stats.accounts.find(a=>a.id==='a'),disabled=stats.accounts.find(a=>a.id==='disabled');
  assert.equal(enabled.quota.status,'fresh');assert.deepEqual(Object.fromEntries(Object.entries(enabled.quota.limits).map(([key,value])=>[key,value.percentUsed])),{five_hour:0,weekly:37.5,monthly:100});assert.equal(enabled.quota.lastSuccessAt,enabled.quota.fetchedAt);assert.deepEqual(enabled.quota.refresh,{eligible:true,reason:null,state:'idle',nextAttemptAt:enabled.quota.lastSuccessAt+500});
  assert.equal(disabled.quota.lastSuccessAt,fetchedAt);assert.equal(disabled.quota.refresh.eligible,false);assert.equal(disabled.quota.refresh.nextAttemptAt,null);
  result=await refresh({force:false});assert.equal(result.json.cached,1);assert.equal(result.json.skipped,1);assert.equal(hits.length,1,'automatic refresh reuses the successful five-minute cache');
  phase='monthly';result=await refresh({force:true});assert.equal(result.json.refreshed,1);stats=await(await fetch(`http://127.0.0.1:${port}/api/statistics`,{headers:auth})).json();const monthlyOnly=stats.accounts.find(a=>a.id==='a').quota;assert.equal(monthlyOnly.status,'unknown','partial quota remains unknown to routing');assert.deepEqual(monthlyOnly.limits,{monthly:{percentUsed:0}});assert.equal(monthlyOnly.fetchedAt,monthlyOnly.lastSuccessAt);assert.ok(monthlyOnly.lastAttemptAt>0&&monthlyOnly.lastAttemptAt<=monthlyOnly.lastSuccessAt);assert.equal(monthlyOnly.errorCategory,null);
  phase='partial';fs.writeFileSync(fault,'');result=await refresh({force:true});assert.equal(result.json.refreshed,1);assert.match(running.output(),/\[额度\] 持久化失败/);fs.unlinkSync(fault);assert.equal(hits.length,3);stats=await(await fetch(`http://127.0.0.1:${port}/api/statistics`,{headers:auth})).json();assert.deepEqual(Object.keys(stats.accounts.find(a=>a.id==='a').quota.limits),['weekly'],'a partial success replaces rather than fills old windows');assert.equal(stats.accounts.find(a=>a.id==='a').quota.status,'unknown');
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
  const running=await startSwitcher({port,upstreamBase:`http://127.0.0.1:${upstreamPort}`,accounts,accountMode:'single',activeAccount:0,knownModels:['m'],perModel:{},accountErrorRules:{},accountPipeline:{quotaPool:false,excludeUnhealthy:false,healthSort:false,sticky:false}},null,{NODE_ENV:'test',CLINE_PASS_TEST_QUOTA_TIMEOUT_MS:String(QUOTA_DEADLINE_MS),CLINE_PASS_TEST_QUOTA_SUCCESS_MS:'500',CLINE_PASS_TEST_QUOTA_FAILURE_MS:'50'});
  t.after(async()=>{await stop(running.child);for(const row of rows)row.res.destroy();await close(upstream);fs.rmSync(running.dir,{recursive:true,force:true});});
  const request=(controller)=>fetch(`http://127.0.0.1:${port}/api/statistics/quota-refresh`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{"force":true}',signal:controller.signal}).then(async response=>({status:response.status,json:await response.json()}));
  const controllers=[new AbortController(),new AbortController(),new AbortController()],pending=controllers.map(controller=>request(controller).catch(error=>({aborted:error.name==='AbortError'})));
  await waitUntil(()=>active===2);assert.equal(total,2);const liveStats=await(await fetch(`http://127.0.0.1:${port}/api/statistics`)).json(),refreshStates=liveStats.accounts.map(account=>account.quota.refresh.state);assert.equal(refreshStates.filter(state=>state==='fetching').length,2);assert.equal(refreshStates.filter(state=>state==='queued').length,2);controllers[0].abort();const firstLeaving=await pending[0];assert.equal(firstLeaving.aborted,true,'aborted page owners settle as aborted');await ownerDetachWindow();assert.equal(active,2,'one page leaving must not cancel work owned by other pages');controllers[1].abort();const secondLeaving=await pending[1];assert.equal(secondLeaving.aborted,true,'aborted page owners settle as aborted');await ownerDetachWindow();assert.equal(active,2);
  for(let index=0;index<4;index+=2){const batch=rows.slice(index,index+2);for(const row of batch){row.res.writeHead(200,{'Content-Type':'application/json'});row.res.end(payload(10+index));}if(index===0)await waitUntil(()=>rows.length===4);}
  const survivor=await pending[2];await Promise.all(pending.slice(0,2));assert.equal(survivor.status,200);assert.equal(survivor.json.refreshed,4);assert.equal(total,4,'same-account page demand is coalesced');assert.equal(maxActive,2);
  const limitControllers=Array.from({length:17},()=>new AbortController()),statuses=[];const limited=limitControllers.map(controller=>request(controller).then(value=>{statuses.push(value.status);return value;},error=>({aborted:error.name==='AbortError'})));await waitUntil(()=>statuses.includes(429));assert.equal(statuses.filter(status=>status===429).length,1);for(const controller of limitControllers)controller.abort();await Promise.all(limited);await waitUntil(()=>active===0);assert.ok(maxActive<=2,'batch overload never widens upstream admission');
  phase='slow';const started=Date.now(),slow=await request(new AbortController());const elapsed=Date.now()-started;assert.equal(slow.status,200);assert.equal(slow.json.failed,4);assert.ok(elapsed<2*QUOTA_DEADLINE_MS+1000,`absolute quota deadline took ${elapsed}ms (budget ${2*QUOTA_DEADLINE_MS+1000}ms = two ${QUOTA_DEADLINE_MS}ms job batches plus 1000ms load margin)`);assert.ok(maxActive<=2);
  const stats=await(await fetch(`http://127.0.0.1:${port}/api/statistics`)).json();assert.ok(stats.accounts.every(account=>account.quota.errorCategory==='timeout'));
  await waitUntil(async()=>{const x=await(await fetch(`http://127.0.0.1:${port}/api/statistics`)).json();return x.accounts.every(account=>!account.quota.refresh.nextAttemptAt||account.quota.refresh.nextAttemptAt<=Date.now());},10000,'quota failure backoff elapsed');phase='hold';const before=stats.accounts.find(account=>account.id==='a').quota,disableController=new AbortController(),disabling=request(disableController);await waitUntil(()=>rows.some(row=>row.phase==='hold'&&row.auth==='Bearer key-a'&&!row.closed));
  const view=await(await fetch(`http://127.0.0.1:${port}/api/accounts`)).json();view.accounts.find(account=>account.id==='a').enabled=false;assert.equal((await rawJson(port,'/api/accounts',{accounts:view.accounts,mode:view.mode,active:view.active,concurrencyWaitMs:view.concurrencyWaitMs,accountErrorRules:view.accountErrorRules,accountPipeline:view.accountPipeline})).status,200);
  phase='respond';for(const row of rows.filter(row=>row.phase==='hold'&&!row.closed)){if(!row.res.destroyed){row.res.writeHead(200,{'Content-Type':'application/json'});row.res.end(payload(88));}}
  await disabling;const after=await(await fetch(`http://127.0.0.1:${port}/api/statistics`)).json(),disabled=after.accounts.find(account=>account.id==='a').quota;assert.equal(disabled.refresh.reason,'disabled');assert.equal(disabled.lastSuccessAt,before.lastSuccessAt);assert.equal(disabled.limits.five_hour.percentUsed,before.limits.five_hour.percentUsed,'disable retains last-good data but cannot publish held work');assert.ok(maxActive<=2);
  phase='hold';let routeView=await(await fetch(`http://127.0.0.1:${port}/api/accounts`)).json();assert.equal((await rawJson(port,'/api/accounts',{accounts:routeView.accounts,mode:routeView.mode,active:routeView.active,concurrencyWaitMs:routeView.concurrencyWaitMs,accountErrorRules:routeView.accountErrorRules,accountPipeline:{quotaPool:true,excludeUnhealthy:false,healthSort:false,sticky:false}})).status,200);await waitUntil(()=>rows.some(row=>row.phase==='hold'&&row.auth==='Bearer key-b'&&!row.closed),5000,'routing-owned key-b quota job reached the mock upstream after the success cache expired');
  const shared=request(new AbortController());await new Promise(r=>setTimeout(r,20));/* bounded nudge: give the page token a moment to join the routing-owned job before routing ownership is withdrawn; the page-owned completion publishes either way */routeView=await(await fetch(`http://127.0.0.1:${port}/api/accounts`)).json();assert.equal((await rawJson(port,'/api/accounts',{accounts:routeView.accounts,mode:routeView.mode,active:routeView.active,concurrencyWaitMs:routeView.concurrencyWaitMs,accountErrorRules:routeView.accountErrorRules,accountPipeline:{quotaPool:false,excludeUnhealthy:false,healthSort:false,sticky:false}})).status,200);phase='respond';for(const row of rows.filter(row=>row.phase==='hold'&&!row.closed)){if(!row.res.destroyed){row.res.writeHead(200,{'Content-Type':'application/json'});row.res.end(payload(77));}}
  const sharedResult=await shared;assert.equal(sharedResult.status,200);assert.equal(sharedResult.json.refreshed,3);const sharedStats=await(await fetch(`http://127.0.0.1:${port}/api/statistics`)).json();assert.equal(sharedStats.accounts.find(account=>account.id==='b').quota.limits.five_hour.percentUsed,77,'routing off withdraws only routing ownership while the page-owned completion publishes');assert.equal((await(await fetch(`http://127.0.0.1:${port}/api/accounts`)).json()).accountPipeline.quotaPool,false);const totalAfterRoutingOff=total;await new Promise(r=>setTimeout(r,100));/* bounded negative window: an obsolete routing callback must not rearm a job after routing was disabled */assert.equal(total,totalAfterRoutingOff,'an obsolete routing callback cannot rearm after routing is disabled');assert.ok(maxActive<=2);
});

test('quota force-cache bypass belongs only to live manual page owners', async (t) => {
  let active=0;const rows=[];
  const payload=JSON.stringify({success:true,data:{limits:[{type:'five_hour',percentUsed:10},{type:'weekly',percentUsed:20},{type:'monthly',percentUsed:30}]}});
  const upstream=http.createServer((req,res)=>{if(req.method!=='GET'){req.resume();return req.on('end',()=>res.end('{"choices":[{"message":{"content":"OK"}}]}'));}active++;const row={auth:req.headers.authorization,res,closed:false};rows.push(row);const done=()=>{if(row.closed)return;row.closed=true;active--;};res.once('finish',done);res.once('close',done);res.once('error',done);req.resume();});
  const upstreamPort=await listen(upstream),port=await unusedPort(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'cps-quota-force-owner-')),fetchedAt=Date.now();
  const accounts=['a','b','c'].map(id=>({id,name:id,key:`key-${id}`,enabled:true,perModel:{}}));
  const cached={snapshot:{limits:{five_hour:{percentUsed:1},weekly:{percentUsed:2},monthly:{percentUsed:3}},fetchedAt},lastAttemptAt:fetchedAt,lastSuccessAt:fetchedAt,errorCategory:null};
  fs.writeFileSync(path.join(dir,'metadata.json'),JSON.stringify({models:{},history:[],accountStates:{},routingSecret:'quota-force-owner-secret',stats:{},accountQuotas:{c:cached}}));
  const running=await startSwitcher({port,upstreamBase:`http://127.0.0.1:${upstreamPort}`,accounts,accountMode:'single',activeAccount:0,knownModels:['m'],perModel:{},accountErrorRules:{},accountPipeline:{quotaPool:true,excludeUnhealthy:false,healthSort:false,sticky:false}},dir,{NODE_ENV:'test',CLINE_PASS_TEST_QUOTA_TIMEOUT_MS:'1000',CLINE_PASS_TEST_QUOTA_SUCCESS_MS:'5000'});
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
  const delayed=new Promise((resolve,reject)=>{delayedRequest=http.request({hostname:'127.0.0.1',port,path:'/api/statistics/quota-refresh',method:'POST',headers:fixtureHeaders(port,'/api/statistics/quota-refresh','POST',{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)})},res=>{const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode,json:JSON.parse(Buffer.concat(chunks).toString())}));});delayedRequest.on('error',reject);delayedRequest.write('{"force":');});
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
  const delayed=new Promise((resolve,reject)=>{delayedRequest=http.request({hostname:'127.0.0.1',port,path:'/api/statistics/quota-refresh',method:'POST',headers:fixtureHeaders(port,'/api/statistics/quota-refresh','POST',{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)})},res=>{const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode,json:JSON.parse(Buffer.concat(chunks).toString())}));});delayedRequest.on('error',reject);delayedRequest.write('{"force":');});
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

test('concurrent detailed-root admission rejects only diagnostic capture at its activity fence', async (t) => {
  const port = await unusedPort();
  const running = await startSwitcher({ port, proxyKey: 'local-test-admin', detailedLogging: true, accounts: [] });
  const held = [];
  t.after(async () => { for (const req of held) req.destroy(); await stop(running.child); fs.rmSync(running.dir, { recursive: true, force: true }); });
  const auth = { 'X-Admin-Key': 'local-test-admin' };
  for (let i = 0; i < 128; i++) {
    const req = http.request({ hostname: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST', headers: { ...auth, 'Content-Type': 'application/json', 'Content-Length': '100' } });
    req.on('error', () => {});
    req.write('{'); // Keep the input reader pending; do not send a model request.
    held.push(req);
  }
  await waitUntil(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/logs/details?limit=200`, { headers: auth });
    return (await response.json()).items.length === 128;
  }, 10000, '128 open detailed roots');
  const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, { method: 'POST', headers: auth });
  assert.equal(response.status, 501, 'the existing response is not changed by the diagnostic fence');
  const settings = await (await fetch(`http://127.0.0.1:${port}/api/logs/settings`, { headers: auth })).json();
  assert.equal(settings.health.dropped, 1);
  assert.equal(settings.health.dropReasons.activeLimit, 1);
  assert.equal(Object.values(settings.health.dropReasons).reduce((a, b) => a + b, 0), 1);
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
  assert.equal((await bareFetch(`http://127.0.0.1:${port}/api/logs/settings`)).status, 401);
  const initialSettings = (await get('/api/logs/settings')).json;
  assert.equal(initialSettings.detailedLogging, false); assert.equal(initialSettings.errorDetailLogging, false); assert.equal(initialSettings.rawBodyLogging, false);
  const initialList = (await get('/api/logs/details')).json;
  const zeroReasons = Object.fromEntries(DETAIL_DROP_REASONS.map((reason) => [reason, 0]));
  assert.deepEqual(initialSettings.health.dropReasons, zeroReasons);
  assert.deepEqual(initialList.health.dropReasons, zeroReasons);
  assert.equal(initialSettings.health.dropped, 0); assert.equal(initialList.health.dropped, 0);
  await rawJson(port, '/v1/chat/completions', { model: 'alias', messages: [] }, auth);
  assert.equal((await list()).length, 0);
  assert.deepEqual((await get('/api/logs/settings')).json.health.dropReasons, zeroReasons);
  const settingsBefore = fs.readFileSync(path.join(running.dir, 'config.json'));
  for (const value of [null, [], {}, { detailedLogging: 1 }, { errorDetailLogging: 1 }, { rawBodyLogging: 'true' }, { detailedLogging: true, extra: 1 }]) assert.equal((await rawJson(port, '/api/logs/settings', value, auth)).status, 400);
  assert.deepEqual(fs.readFileSync(path.join(running.dir, 'config.json')), settingsBefore);
  const errorOnly = await rawJson(port, '/api/logs/settings', { errorDetailLogging: true }, auth);
  assert.equal(errorOnly.status, 200); assert.equal(errorOnly.json.detailedLogging, false); assert.equal(errorOnly.json.errorDetailLogging, true);
  const legacyFull = await rawJson(port, '/api/logs/settings', { detailedLogging: true }, auth);
  assert.equal(legacyFull.status, 200); assert.equal(legacyFull.json.detailedLogging, true); assert.equal(legacyFull.json.errorDetailLogging, true, 'legacy one-field writes preserve the independent error-only mode');
  const both = await rawJson(port, '/api/logs/settings', { detailedLogging: true, errorDetailLogging: false }, auth);
  assert.equal(both.status, 200); assert.equal(both.json.detailedLogging, true); assert.equal(both.json.errorDetailLogging, false);
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
  const emptyContent = await groupAfter(rawJson(port, '/v1/chat/completions', { model: 'alias', messages: [{ role: 'user', content: '' }] }, auth));
  assert.equal(emptyContent.response.status, 200); assert.equal(emptyContent.group.attempts.length, 1);
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
  const settingsHealth = (await get('/api/logs/settings')).json.health;
  const listingHealth = (await get('/api/logs/details')).json.health;
  assert.deepEqual(settingsHealth.dropReasons, listingHealth.dropReasons);
  assert.equal(Object.values(settingsHealth.dropReasons).reduce((a, b) => a + b, 0), settingsHealth.dropped);
  assert.ok(DETAIL_DROP_REASONS.every((reason) => Object.hasOwn(settingsHealth.dropReasons, reason)));
  assert.doesNotMatch(JSON.stringify(settingsHealth.dropReasons), /detail-admin-secret|saved-detail-secret|incoming-cookie-secret|requestId|session/);
  await stop(running.child); running = await startSwitcher(null, running.dir);
  const restartedSettings = (await get('/api/logs/settings')).json; assert.equal(restartedSettings.detailedLogging, true); assert.equal(restartedSettings.errorDetailLogging, false); assert.equal((await list()).length, countBeforeRestart);
  assert.deepEqual(restartedSettings.health.dropReasons, zeroReasons);
  const ordinaryBefore = allText(path.join(running.dir, 'logs'));
  await get('/api/logs/details', 'DELETE'); assert.equal((await list()).length, 0); assert.equal(allText(path.join(running.dir, 'logs')), ordinaryBefore);
  await rawJson(port, '/api/logs/settings', { detailedLogging: false }, auth);
  await stop(running.child); running = await startSwitcher(null, running.dir); assert.equal((await get('/api/logs/settings')).json.detailedLogging, false);
  await stop(running.child);
  const invalidConfig = JSON.parse(fs.readFileSync(path.join(running.dir, 'config.json'), 'utf8')); invalidConfig.detailedLogging = 'true'; invalidConfig.errorDetailLogging = 'true';
  fs.writeFileSync(path.join(running.dir, 'config.json'), JSON.stringify(invalidConfig));
  running = await startSwitcher(null, running.dir); const invalidSettings = (await get('/api/logs/settings')).json; assert.equal(invalidSettings.detailedLogging, false); assert.equal(invalidSettings.errorDetailLogging, false);
});

test('error-only detail correlates every real failed chat attempt without copying successful traffic', async (t) => {
  const responseSecret = 'error-detail-response-secret';
  const upstream = http.createServer((req, res) => {
    const chunks = []; req.on('data', (chunk) => chunks.push(chunk)); req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      const provider = body.provider?.only?.[0] || body.providerOptions?.gateway?.only?.[0];
      if (body.model === 'network') return res.destroy();
      res.setHeader('X-Credential', `Bearer api_key=${responseSecret}`);
      if (body.model === 'retry' && provider === 'first') { res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: { message: `first failed ${responseSecret}`, status: 500 } })); }
      if (body.model === 'envelope') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: { message: `wrapped failed ${responseSecret}`, status: 502 } })); }
      if (body.model === 'long') { res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'L'.repeat(20 * 1024), finalCause: 'tail-cause' } })); }
      if (body.model === 'sse-error') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); return res.end(`data: ${JSON.stringify({ error: { message: `stream failed ${responseSecret}`, status: 502 } })}\n\n`); }
      if (body.model === 'stream-break') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write('data: {"choices":[{"delta":{"content":"started"}}]}\n\n'); return setTimeout(() => res.destroy(), 20); }
      if (body.model === 'replace' && req.headers.authorization === 'Bearer key-a') { res.writeHead(429, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'account subscription quota exhausted', status: 429 } })); }
      if (body.model === 'replace' && req.headers.authorization === 'Bearer key-b' && provider === 'first') { res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end('{"error":{"message":"replacement provider failed","status":500}}'); }
      res.writeHead(200, { 'Content-Type': body.stream ? 'text/event-stream' : 'application/json' });
      res.end(body.stream ? 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n' : '{"choices":[{"message":{"content":"ok"}}]}');
    });
  });
  const upstreamPort = await listen(upstream), port = await unusedPort();
  const config = {
    port, upstreamBase: `http://127.0.0.1:${upstreamPort}`,
    errorDetailLogging: false,
    accounts: [{ id: 'a', name: 'A', key: 'key-a', enabled: true, perModel: {} }, { id: 'b', name: 'B', key: 'key-b', enabled: true, perModel: {} }],
    accountMode: 'single', activeAccount: 0,
    knownModels: ['success', 'retry', 'envelope', 'long', 'sse-error', 'stream-break', 'network', 'replace'],
    perModel: { retry: { upstreams: ['first', 'second'], pinMode: 'strict' }, replace: { upstreams: ['first', 'second'], pinMode: 'strict' } },
    errorRules: [{ id: 'replace-account', scope: 'account', action: 'cooldown', when: { statuses: [429], body_contains: 'account subscription quota exhausted' }, reset: { fallback: '1m0s', max: '1m0s' } }],
  };
  const running = await startSwitcher(config);
  t.after(async () => { await stop(running.child); await close(upstream); fs.rmSync(running.dir, { recursive: true, force: true }); });
  const api = async (route) => (await fetch(`http://127.0.0.1:${port}${route}`)).json();
  const groupFor = (id) => waitUntil(async () => { const group = await api('/api/logs/details/' + id); return group.request?.state !== undefined && group; });
  const success = await rawJson(port, '/v1/chat/completions', { model: 'success', messages: [{ role: 'user', content: 'do not retain successful input' }] });
  assert.equal(success.status, 200);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal((await api('/api/logs/details/' + success.headers['x-cline-request-id'])).error.message, 'detailed record unavailable');
  const disabledFailure = await rawJson(port, '/v1/chat/completions', { model: 'envelope', messages: [] });
  const disabledRow = await waitUntil(async () => (await api('/api/logs/errors?requestId=' + disabledFailure.headers['x-cline-request-id'])).items[0]);
  assert.equal(Object.hasOwn(disabledRow, 'detailProfile'), false); assert.equal(Object.hasOwn(disabledRow, 'detailCallId'), false);
  assert.equal((await api('/api/logs/details/' + disabledFailure.headers['x-cline-request-id'])).error.message, 'detailed record unavailable');
  await fetch(`http://127.0.0.1:${port}/api/logs/errors`, { method: 'DELETE' });
  assert.equal((await rawJson(port, '/api/logs/settings', { errorDetailLogging: true })).status, 200);

  const responses = new Map();
  for (const model of ['retry', 'envelope', 'long', 'sse-error', 'network']) responses.set(model, await rawJson(port, '/v1/chat/completions', { model, stream: model === 'sse-error', messages: [{ role: 'user', content: 'request credential-free text' }] }));
  const streamBreak = await new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
      const chunks = []; res.on('data', (chunk) => chunks.push(chunk));
      const finish = () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString(), complete: res.complete });
      res.on('end', finish); res.on('aborted', finish); res.on('error', (error) => { if (error.code !== 'ECONNRESET') reject(error); });
    });
    request.on('error', reject); request.end(JSON.stringify({ model: 'stream-break', stream: true, messages: [] }));
  });
  responses.set('stream-break', streamBreak);
  const replacement = await rawJson(port, '/v1/chat/completions', { model: 'replace', messages: [] }); responses.set('replace', replacement); assert.equal(replacement.status, 200);

  const errors = await waitUntil(async () => { const rows = (await api('/api/logs/errors?limit=200')).items; return rows.length >= 8 && rows; });
  const byRequest = new Map(errors.map((row) => [row.requestId, row]));
  for (const [model, response] of responses) {
    const id = response.headers['x-cline-request-id'], row = byRequest.get(id); assert.ok(row, model);
    assert.equal(row.detailProfile, 'error'); assert.match(row.detailCallId, /^[0-9a-f-]{36}$/);
    const group = await groupFor(id); assert.equal(group.request.profile, 'error'); assert.equal(group.request.requestBody, undefined); assert.equal(group.request.responseBody, undefined); assert.equal(group.request.headers, undefined);
    const matched = group.attempts.filter((attempt) => attempt.attemptIndex === row.attemptIndex && attempt.callId === row.detailCallId); assert.equal(matched.length, 1, model);
    if (model === 'network') { assert.equal(matched[0].captureState, 'no-response'); assert.equal(matched[0].responseBody, undefined); }
    else if (model === 'stream-break') { assert.equal(group.request.status, 200); assert.equal(group.request.result, 'failed'); assert.equal(matched[0].captureState, 'stream-transport-failed'); assert.equal(matched[0].httpStatus, 200); assert.equal(matched[0].outcomeStatus, 502); assert.equal(matched[0].responseBody, undefined); }
    else { assert.ok(matched[0].responseBody); const text = await (await fetch(`http://127.0.0.1:${port}/api/logs/details/${id}/bodies/${matched[0].responseBody}`)).text(); assert.equal(text.includes(responseSecret), false); }
    assert.equal(JSON.stringify(group).includes(responseSecret), false);
  }
  const retryId = responses.get('retry').headers['x-cline-request-id'], retryGroup = await groupFor(retryId);
  assert.deepEqual(retryGroup.attempts.map((attempt) => attempt.attemptIndex), [0]);
  const replaceId = responses.get('replace').headers['x-cline-request-id'], replaceGroup = await groupFor(replaceId), replaceRows = errors.filter((row) => row.requestId === replaceId);
  assert.deepEqual(replaceGroup.attempts.map((attempt) => attempt.accountId), ['a', 'b']); assert.deepEqual(replaceGroup.attempts.map((attempt) => attempt.attemptIndex), [0, 1]);
  assert.equal(replaceRows.length, 2); for (const row of replaceRows) assert.equal(replaceGroup.attempts.filter((attempt) => attempt.attemptIndex === row.attemptIndex && attempt.callId === row.detailCallId).length, 1);
  const longRow = byRequest.get(responses.get('long').headers['x-cline-request-id']); assert.equal(longRow.reasonTruncated, true); assert.ok(Buffer.byteLength(longRow.reason) <= 16 * 1024);
  const successfulDetails = (await api('/api/logs/details?result=success')).items.map((row) => row.requestId); assert.ok(successfulDetails.includes(retryId)); assert.ok(successfulDetails.includes(replaceId));
  const failedDetails = (await api('/api/logs/details?result=failed')).items.map((row) => row.requestId); assert.ok(failedDetails.includes(responses.get('envelope').headers['x-cline-request-id']));
  const ordinary = fs.readdirSync(path.join(running.dir, 'logs')).map((name) => fs.readFileSync(path.join(running.dir, 'logs', name), 'utf8')).join('\n') + fs.readFileSync(path.join(running.dir, 'metadata.json'), 'utf8');
  assert.equal(ordinary.includes(responseSecret), false); assert.equal(ordinary.includes('do not retain successful input'), false);

  const fullMode = await rawJson(port, '/api/logs/settings', { detailedLogging: true, errorDetailLogging: true }); assert.equal(fullMode.status, 200);
  const fullFailure = await rawJson(port, '/v1/chat/completions', { model: 'envelope', messages: [] });
  const fullRow = await waitUntil(async () => (await api('/api/logs/errors?requestId=' + fullFailure.headers['x-cline-request-id'])).items[0]);
  assert.equal(fullRow.detailProfile, 'full'); const fullGroup = await groupFor(fullFailure.headers['x-cline-request-id']); assert.equal(fullGroup.request.profile, 'full'); assert.equal(fullGroup.attempts.length, 1);
});

test('graceful shutdown drains completed ordinary and error-detail records and bounds a blocked writer', { timeout: 10000 }, async (t) => {
  const upstream = http.createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end('{"error":{"message":"shutdown fixture failure"}}'); }); });
  const upstreamPort = await listen(upstream), port = await unusedPort(), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cps-shutdown-'));
  const config = { port, upstreamBase: `http://127.0.0.1:${upstreamPort}`, errorDetailLogging: true, accounts: [{ id: 'a', name: 'A', key: 'shutdown-key', enabled: true, perModel: {} }], knownModels: ['shutdown'], perModel: {}, accountErrorRules: {} };
  let running = await startSwitcher(config, dir);
  t.after(async () => { if (running?.child && running.child.exitCode === null) await stop(running.child); await close(upstream); fs.rmSync(dir, { recursive: true, force: true }); });
  const response = await rawJson(port, '/v1/chat/completions', { model: 'shutdown', messages: [] });
  const requestId = response.headers['x-cline-request-id'];
  await stop(running.child); running = await startSwitcher(null, dir);
  const requests = await (await fetch(`http://127.0.0.1:${port}/api/logs/requests?requestId=${requestId}`)).json();
  const errors = await (await fetch(`http://127.0.0.1:${port}/api/logs/errors?requestId=${requestId}`)).json();
  const detail = await (await fetch(`http://127.0.0.1:${port}/api/logs/details/${requestId}`)).json();
  assert.equal(requests.items.length, 1); assert.equal(errors.items.length, 1); assert.equal(detail.request.profile, 'error');
  await stop(running.child); running = null;

  const blockedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cps-shutdown-blocked-'));
  t.after(() => fs.rmSync(blockedDir, { recursive: true, force: true }));
  const loader = path.join(blockedDir, 'block-loader.mjs');
  fs.writeFileSync(loader, `import fsp from 'node:fs/promises';\nconst writeFile=fsp.writeFile;\nfsp.writeFile=async(file,...args)=>String(file).includes('/detailed-logs/')&&String(file).endsWith('.txt')?new Promise(()=>{}):writeFile(file,...args);`);
  const blockedPort = await unusedPort();
  const blocked = await startSwitcher({ ...config, port: blockedPort }, blockedDir, { NODE_ENV: 'test', NODE_OPTIONS: `--import=${loader}`, CLINE_PASS_SHUTDOWN_MS: '120' });
  const blockedResponse = await rawJson(blockedPort, '/v1/chat/completions', { model: 'shutdown', messages: [] }); assert.equal(blockedResponse.status, 500);
  const started = Date.now(); await stop(blocked.child); assert.ok(Date.now() - started < 1000, 'shutdown deadline must bound a blocked detailed writer');
});

test('SIGTERM waits for an active SSE finalizer before draining logs and destroying agents', async (t) => {
  const upstream = http.createServer((req, res) => {
    req.resume(); req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"first"}}]}\n\n');
      setTimeout(() => res.end('data: [DONE]\n\n'), 350);
    });
  });
  const upstreamPort = await listen(upstream), port = await unusedPort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cps-sse-shutdown-'));
  let running = await startSwitcher({ port, upstreamBase: `http://127.0.0.1:${upstreamPort}`, accounts: [{ id: 'a', name: 'A', key: 'test', enabled: true }], knownModels: ['m'] }, dir, { NODE_ENV: 'test', CLINE_PASS_SHUTDOWN_MS: '2000', CLINE_PASS_TEST_SSE_HEARTBEAT_MS: '70' });
  t.after(async () => { if (running?.child?.exitCode === null) await stop(running.child); upstream.closeAllConnections?.(); await close(upstream); fs.rmSync(dir, { recursive: true, force: true }); });
  const response = new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST' }, (res) => {
      let text = '', signaled = false;
      res.on('data', (chunk) => {
        text += chunk.toString();
        if (!signaled && text.includes('first')) { signaled = true; running.child.kill('SIGTERM'); }
      });
      res.on('end', () => resolve({ text, requestId: res.headers['x-cline-request-id'] })); res.on('error', reject);
    });
    req.on('error', reject); req.end(JSON.stringify({ model: 'm', messages: [], stream: true }));
  });
  const { text, requestId } = await response;
  assert.match(text, /data: \[DONE\]/);
  await waitUntil(() => running.child.exitCode !== null, 3000, 'graceful SSE shutdown exits');
  running = await startSwitcher(null, dir);
  const rows = (await (await fetch(`http://127.0.0.1:${port}/api/logs/requests?requestId=${requestId}`)).json()).items;
  assert.equal(rows.length, 1); assert.equal(rows[0].result, 'success'); assert.equal(rows[0].status, 200);
});

test('one successful chat finalization persists combined statistics and record metadata once', async (t) => {
  const upstream = http.createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"choices":[{"message":{"content":"ok"}}]}'); }); });
  const upstreamPort = await listen(upstream), port = await unusedPort(), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cps-meta-save-'));
  const counter = path.join(dir, 'metadata-writes.txt'), loader = path.join(dir, 'count-loader.mjs');
  fs.writeFileSync(loader, `import fs from 'node:fs';\nconst writeFileSync=fs.writeFileSync;\nfs.writeFileSync=function(file,...args){if(String(file).includes('metadata.json.')&&String(file).endsWith('.tmp'))writeFileSync(${JSON.stringify(counter)},'1\\n',{flag:'a'});return writeFileSync(file,...args);};`);
  const running = await startSwitcher({ port, upstreamBase: `http://127.0.0.1:${upstreamPort}`, accounts: [{ id: 'a', name: 'A', key: 'meta-key', enabled: true, perModel: {} }], knownModels: ['meta'], perModel: {}, accountErrorRules: {} }, dir, { NODE_OPTIONS: `--import=${loader}` });
  t.after(async () => { await stop(running.child); await close(upstream); fs.rmSync(dir, { recursive: true, force: true }); });
  const count = () => fs.existsSync(counter) ? fs.readFileSync(counter, 'utf8').trim().split('\n').filter(Boolean).length : 0;
  const before = count(); assert.equal((await rawJson(port, '/v1/chat/completions', { model: 'meta', messages: [] })).status, 200);
  await waitForRequestLogs(port, 1); assert.equal(count() - before, 1);
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
    assert.equal((await bareFetch(`http://127.0.0.1:${port}/api/logs/details`)).status, 401);
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
      assert.equal((await bareFetch(`http://127.0.0.1:${port}${route}/bodies/${group.request.requestBody}`)).status, 401);
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
  assert.equal((await bareFetch(`http://127.0.0.1:${port}/api/logs/details`)).status, 401);
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
      assert.equal((await bareFetch(`http://127.0.0.1:${port}${route}/bodies/${group.request.requestBody}`)).status, 401);
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

test('detailed logging keeps ordinary escapes while redacting decoded credentials across APIs/files without changing JSON/SSE traffic', async (t) => {
  const secret = 'fixture-escaped-secret', escaped = 'password=\\u0066ixture-escaped-secret', ordinary = 'ordinary code \\u0061 and \\x61', seen = [];
  const upstream = http.createServer((req, res) => {
    const chunks = []; req.on('data', (chunk) => chunks.push(chunk)); req.on('end', () => {
      const input = Buffer.concat(chunks).toString(); seen.push(input); const body = JSON.parse(input);
      const payload = { choices: [{ message: { content: secret } }], ordinary, ...(body.model !== 'header' ? { nested: { message: escaped } } : {}) };
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
    const input = { model, stream: model === 'sse', messages: [{ role: 'user', content: ordinary }], echo: secret };
    await rawJson(port, '/api/logs/settings', { detailedLogging: false });
    const off = await rawJson(port, '/v1/chat/completions', input, { 'X-Earlier-Echo': secret });
    await rawJson(port, '/api/logs/settings', { detailedLogging: true });
    const on = await rawJson(port, '/v1/chat/completions', input, { 'X-Earlier-Echo': secret });
    assert.equal(on.status, off.status); assert.equal(on.text, off.text); assert.equal(seen.at(-1), seen.at(-2));
    assert.match(on.text, /fixture-escaped-secret/, 'traffic retains the original content');
    const route = '/api/logs/details/' + on.headers['x-cline-request-id'];
    const group = await waitUntil(async () => { const group = await (await get(route)).json(); return group.request?.state === 'complete' && group; });
    assert.equal(group.attempts.length, 1); assert.equal(group.bodies.length, 4);
    assert.equal(group.request.complete, true); assert.equal(group.request.result, 'success');
    assert.equal(JSON.stringify(group).includes(secret), false);
    assert.doesNotMatch(JSON.stringify(group), /OMITTED: incomplete credential discovery/);
    for (const body of group.bodies) {
      assert.equal(body.state, 'complete'); assert.equal(body.complete, true); assert.ok(body.capturedBytes > 0);
      const response = await get(route + '/bodies/' + body.bodyId); assert.equal(response.status, 200);
      const text = await response.text(); assert.notEqual(text, ''); assert.equal(text.includes(secret), false); assert.match(text, /ordinary code/);
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
      if (body.model === 'replace' && req.headers.authorization === 'Bearer stream-detail-secret') { res.writeHead(429, { 'Content-Type': 'application/json' }); return res.end('{"error":{"message":"account subscription quota exhausted","code":"account_quota_exhausted","status":429}}'); }
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
      assert.equal((await bareFetch(`http://127.0.0.1:${port}/api/logs/details`, { method: 'DELETE' })).status, 401);
      const failed = await api('/api/logs/details', 'DELETE'); assert.equal(failed.status, 503);
      assert.deepEqual(await failed.json(), { error: { message: 'detailed storage unavailable' } });
      assert.equal(temps().length, 1);
    }
    fs.unlinkSync(fault);
    if (boundary === 'maintenance') {
      assert.equal((await api('/api/logs/details')).status, 200);
      assert.equal((await (await api(successfulRoute)).json()).request.state, 'complete');
    } else {
      assert.equal((await api('/api/logs/details', 'DELETE')).status, 200); assert.deepEqual(fs.readdirSync(detailsDir), ['raw']);
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
  assert.equal((await rawJson(port, '/api/logs/settings', { detailedLogging: false, errorDetailLogging: true })).status, 500);
  assert.deepEqual(fs.readFileSync(path.join(dir, 'config.json')), before);
  const retainedSettings = await (await fetch(`http://127.0.0.1:${port}/api/logs/settings`)).json(); assert.equal(retainedSettings.detailedLogging, true); assert.equal(retainedSettings.errorDetailLogging, false);
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

test('canonical scoped error rules match status/body/header, isolate state, persist hard quarantine and project direct rates', async (t) => {
  const seen=[];
  const upstream=http.createServer((req,res)=>{const chunks=[];req.on('data',c=>chunks.push(c));req.on('end',()=>{const body=JSON.parse(Buffer.concat(chunks).toString()||'{}'),provider=body.provider?.only?.[0]||body.providerOptions?.gateway?.only?.[0]||null,auth=req.headers.authorization;seen.push({model:body.model,provider,auth});const ok=()=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:'ok'}}],provider}));};
    if(body.model==='provider-rule'&&provider==='first'){res.writeHead(429,{'Content-Type':'application/json','X-Reset':'10s','X-Private-Match':'needle-header-secret'});return res.end(JSON.stringify({error:{message:'RATE NEEDLE provider limited',provider:'first',status:429}}));}
    if(body.model==='fallback-rule'&&provider==='first'){res.writeHead(429,{'Content-Type':'application/json'});return res.end(JSON.stringify({error:{message:'fallback limited',provider:'first',status:429}}));}
    if(body.model==='only-cooling'){res.writeHead(429,{'Content-Type':'application/json'});return res.end(JSON.stringify({error:{message:'single provider limited',provider:'first',status:429}}));}
    if(body.model==='account-rule'&&auth==='Bearer key-a'){res.writeHead(401,{'Content-Type':'application/json'});return res.end(JSON.stringify({error:{message:'account auth denied'}}));}
    if(body.model==='first-match'&&provider==='first'){res.writeHead(500,{'Content-Type':'application/json'});return res.end(JSON.stringify({error:{message:'first match body'}}));}
    if(body.model==='stream-late'){res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('data: {"choices":[{"delta":{"content":"started"}}]}\n\n');return setTimeout(()=>res.end('data: {"error":{"message":"late hard provider","status":500}}\n\ndata: [DONE]\n\n'),5);}
    ok();});});
  const upstreamPort=await listen(upstream),port=await unusedPort(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'cps-canonical-rules-'));
  const route=(providers)=>({upstreams:providers,exclude:[],pinMode:'strict',sort:null,maxRetries:null,providerCooldownMs:0});
  const models=['provider-rule','fallback-rule','only-cooling','account-rule','first-match','stream-late'];
  const accounts=[{id:'a',name:'A',key:'key-a',enabled:true,perModel:{}},{id:'b',name:'B',key:'key-b',enabled:true,perModel:{}}];
  const errorRules=[
    {id:'provider-combined',scope:'provider-model',action:'cooldown',providers:['first'],models:['provider-rule'],when:{statuses:[429],body_contains:['other','rate needle'],header:{name:'X-Reset',contains:'10s'}},reset:{header:'X-Reset',format:'duration',fallback:'5s',max:'8s'}},
    {id:'provider-fallback',scope:'provider-model',action:'cooldown',providers:['first'],models:['fallback-rule'],when:{statuses:[429],body_contains:'fallback limited'},reset:{header:'Retry-After',format:'retry-after',fallback:'5s',max:'8s'}},
    {id:'provider-only-cooling',scope:'provider-model',action:'cooldown',providers:['first'],models:['only-cooling'],when:{statuses:[429]},reset:{fallback:'5s',max:'5s'}},
    {id:'account-hard',scope:'credential',action:'hard-quarantine',models:['account-rule'],when:{statuses:[401]}},
    {id:'first-ignore',scope:'provider-model',action:'ignore',models:['first-match'],when:{statuses:[500],body_contains:'first match'}},
    {id:'second-degrade',scope:'provider-model',action:'degrade',models:['first-match'],when:{statuses:[500]}},
    {id:'late-hard',scope:'provider-model',action:'hard-quarantine',models:['stream-late'],when:{statuses:[500],body_contains:'late hard provider'}},
  ];
  let running=await startSwitcher({port,upstreamBase:`http://127.0.0.1:${upstreamPort}`,accountMode:'single',activeAccount:0,concurrencyWaitMs:0,accounts,knownModels:models,perModel:Object.fromEntries(models.map(model=>[model,route(['account-rule','stream-late','only-cooling'].includes(model)?['first']:['first','second'])])),errorRules},dir);t.after(async()=>{if(running?.child)await stop(running.child);await close(upstream);fs.rmSync(dir,{recursive:true,force:true});});
  const call=(model,extra={})=>rawJson(port,'/v1/chat/completions',{model,messages:[{role:'user',content:'request-message-secret'}],...extra});
  let response=await call('provider-rule');assert.equal(response.status,200);assert.deepEqual(seen.slice(-2).map(row=>row.provider),['first','second']);let metadata=JSON.parse(fs.readFileSync(path.join(dir,'metadata.json'))),state=metadata.models['provider-rule'].upstreamStatus.first;assert.ok(state.cooldownUntil-state.updatedAt>=7900&&state.cooldownUntil-state.updatedAt<=8000);assert.equal(state.hardQuarantined,false);assert.equal(metadata.accountStates.a,undefined);
  response=await call('fallback-rule');assert.equal(response.status,200);metadata=JSON.parse(fs.readFileSync(path.join(dir,'metadata.json')));state=metadata.models['fallback-rule'].upstreamStatus.first;assert.ok(state.cooldownUntil-state.updatedAt>=4900&&state.cooldownUntil-state.updatedAt<=5000);
  response=await call('only-cooling');assert.equal(response.status,429);response=await call('only-cooling');assert.equal(response.status,503);assert.ok(Number(response.headers['retry-after'])>=1);
  // The 429 and 503 can share a millisecond; requestId breaks timestamp ties, so limit=1
  // may return the earlier 429 indefinitely. Query both rows and select the actual 503.
  const coolingLog=await waitUntil(async()=>{const page=await(await fetch(`http://127.0.0.1:${port}/api/logs/requests?requestedModel=only-cooling&limit=2`)).json();return page.items?.find(item=>item.status===503);},5000,'only-cooling 503 request log row published');assert.equal(coolingLog.errorCategory,'routing');assert.equal(coolingLog.upstreamStatus,null);assert.deepEqual(coolingLog.attempts,[]);
  response=await call('account-rule');assert.equal(response.status,200);assert.deepEqual(seen.slice(-2).map(row=>row.auth),['Bearer key-a','Bearer key-b']);let view=await(await fetch(`http://127.0.0.1:${port}/api/accounts`)).json();assert.equal(view.accounts.find(account=>account.id==='a').state.hardQuarantined,true);assert.equal(view.accounts.find(account=>account.id==='b').health.successes,1);
  response=await call('first-match');assert.equal(response.status,200);let modelsView=await(await fetch(`http://127.0.0.1:${port}/api/models`)).json();let firstModel=modelsView.subscription.find(row=>row.id==='first-match');assert.equal(firstModel.meta.upstreamStatus.first.success.degrades,0,'first matching ignore prevents later degrade');assert.equal(firstModel.meta.upstreamStatus.second.success.successes,1);
  const beforeLate=seen.length;response=await call('stream-late',{stream:true});assert.equal(response.status,200);assert.match(response.text,/started/);assert.equal(seen.length,beforeLate+1,'post-start rule action never replays');metadata=JSON.parse(fs.readFileSync(path.join(dir,'metadata.json')));assert.equal(metadata.models['stream-late'].upstreamStatus.first.hardQuarantined,true);
  await stop(running.child);running.child=null;running=await startSwitcher(null,dir);metadata=JSON.parse(fs.readFileSync(path.join(dir,'metadata.json')));assert.equal(metadata.models['stream-late'].upstreamStatus.first.hardQuarantined,true,'provider hard quarantine survives restart');assert.equal((await rawJson(port,'/api/providers/recover',{model:'stream-late',provider:'first'})).status,200);metadata=JSON.parse(fs.readFileSync(path.join(dir,'metadata.json')));assert.equal(metadata.models['stream-late'].upstreamStatus.first.hardQuarantined,false);
  assert.equal((await rawJson(port,'/api/config',{scope:'global',perModel:{'stream-late':route(['second'])}})).status,200);metadata=JSON.parse(fs.readFileSync(path.join(dir,'metadata.json')));assert.equal(metadata.models['stream-late'].upstreamStatus.first,undefined,'route identity removal prunes obsolete provider state');
  view=await(await fetch(`http://127.0.0.1:${port}/api/accounts`)).json();const changed=view.accounts.map(account=>account.id==='a'?{...account,key:'key-a-rotated'}:account);assert.equal((await rawJson(port,'/api/accounts',{accounts:changed,mode:view.mode,active:view.active,concurrencyWaitMs:view.concurrencyWaitMs,errorRules:view.errorRules,accountPipeline:view.accountPipeline})).status,200);view=await(await fetch(`http://127.0.0.1:${port}/api/accounts`)).json();assert.equal(view.accounts.find(account=>account.id==='a').state,null,'credential identity replacement clears old hard state');
  const logs=await waitUntil(async()=>{const page=await(await fetch(`http://127.0.0.1:${port}/api/logs/errors?ruleId=provider-combined`)).json();return page.items?.[0]?.ruleId==='provider-combined'&&page;},5000,'provider-combined error log row published');assert.equal(logs.items[0].ruleScope,'provider-model');assert.equal(logs.items[0].ruleAction,'cooldown');assert.deepEqual(logs.items[0].matchedBy,['status','body','header','provider','model']);const serialized=JSON.stringify(logs)+fs.readFileSync(path.join(dir,'metadata.json'),'utf8');for(const secret of ['RATE NEEDLE','needle-header-secret','request-message-secret','key-a'])assert.equal(serialized.includes(secret),false);
  let current=await(await fetch(`http://127.0.0.1:${port}/api/accounts`)).json();assert.equal(current.errorRules.find(rule=>rule.id==='account-hard').scope,'account','credential input alias is projected canonically');
  const validFormats=[
    {id:'retry-default',scope:'credential',action:'cooldown',when:{statuses:[429],header:{name:'Retry-After'}},reset:{header:'Retry-After',fallback:'5m0s',max:'1h0m0s'}},
    {id:'unix-seconds',scope:'provider-model',action:'cooldown',when:{statuses:[429]},reset:{header:'X-Reset-S',format:'unix-seconds',fallback:'5s',max:'1h'}},
    {id:'unix-ms',scope:'provider-model',action:'cooldown',when:{statuses:[429]},reset:{header:'X-Reset-Ms',format:'unix-milliseconds',fallback:'5s',max:'1h'}},
    {id:'duration',scope:'provider-model',action:'cooldown',when:{body_contains:'busy'},reset:{header:'X-Reset',format:'duration',fallback:'5s',max:'1h0m0s'}},
  ];
  assert.equal((await rawJson(port,'/api/accounts',{accounts:current.accounts,mode:current.mode,active:current.active,concurrencyWaitMs:current.concurrencyWaitMs,errorRules:validFormats,accountPipeline:current.accountPipeline})).status,200);current=await(await fetch(`http://127.0.0.1:${port}/api/accounts`)).json();assert.equal(current.errorRules[0].scope,'account');const configBytes=fs.readFileSync(path.join(dir,'config.json'));
  const invalid=[null,{},[{id:'x',scope:'account',action:'degrade',when:{}}],[{id:'-x',scope:'account',action:'degrade',when:{statuses:[500]}}],[{id:'x',scope:'credentialx',action:'degrade',when:{statuses:[500]}}],[{id:'x',scope:'account',action:'degrade',providers:['bad provider'],when:{statuses:[500]}}],[{id:'x',scope:'account',action:'degrade',when:{statuses:[500],body_contains:null}}],[{id:'x',scope:'account',action:'degrade',when:{statuses:[500],header:null}}],[{id:'x',scope:'account',action:'cooldown',when:{statuses:[500]},reset:{fallback:'300',max:'1h'}}],[{id:'x',scope:'account',action:'cooldown',when:{statuses:[500]},reset:{header:'X-Reset',fallback:'5s',max:'1h'}}],[{id:'x',scope:'account',action:'degrade',when:{statuses:[500],header:{name:'Bad Header'}}}]];
  for(const rules of invalid){const rejected=await rawJson(port,'/api/accounts',{accounts:current.accounts,mode:current.mode,active:current.active,concurrencyWaitMs:current.concurrencyWaitMs,errorRules:rules,accountPipeline:current.accountPipeline});assert.equal(rejected.status,400,JSON.stringify(rules));assert.deepEqual(fs.readFileSync(path.join(dir,'config.json')),configBytes);}
});

test('strict first follows source order, retries and preferred follow provider-model success rate, singleton-only and safe failures', async (t) => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      const provider = body.provider?.only?.[0] || body.providerOptions?.gateway?.only?.[0] || null;
      seen.push({ model: body.model, provider, only: body.provider?.only || null, gatewayOnly: body.providerOptions?.gateway?.only || null, order: body.provider?.order || body.providerOptions?.gateway?.order || null });
      if ((provider === 'a' || provider === 'b') && body.model !== 'iso-ok' && body.model !== 'cool-model') {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: `${provider} failed`, status: 500 } }));
      }
      if (body.model === 'null-last' && provider === 'y') {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'y failed', status: 502 } }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }], provider }));
    });
  });
  const upstreamPort = await listen(upstream), port = await unusedPort(), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cps-provider-selection-'));
  fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify({
    routingSecret: 'fixed-selection-secret',
    models: {
      'discovered-model': { upstreams: ['d1', 'd2'], pipeline: 'planner' },
      'hard-model': { upstreams: ['a'], upstreamStatus: { a: { hardQuarantined: true } } },
      'cool-model': { upstreams: ['a', 'b'], upstreamStatus: { a: { cooldownUntil: Date.now() + 600000 } } },
      'null-last': { upstreams: ['x', 'y'], pipeline: 'planner', upstreamStatus: { x: { hardQuarantined: true } } },
      'configured-wins': { upstreams: ['d1', 'd2'] },
    },
  }));
  const route = (upstreams, extra = {}) => ({ upstreams, exclude: [], pinMode: 'strict', sort: null, maxRetries: null, providerCooldownMs: 0, ...extra });
  const config = {
    port, upstreamBase: `http://127.0.0.1:${upstreamPort}`, accountMode: 'single', activeAccount: 0, concurrencyWaitMs: 0,
    accounts: [{ id: 'a', name: 'A', key: 'key-a', enabled: true, perModel: {} }],
    knownModels: ['strict-rate', 'preferred-rate', 'capped-rate', 'iso-fail', 'iso-ok', 'auto-model', 'excluded-model', 'hard-model', 'cool-model', 'discovered-model', 'null-last', 'configured-wins', 'health-fail'],
    perModel: {
      'strict-rate': route(['a', 'b', 'c']),
      'preferred-rate': route(['a', 'b', 'c'], { pinMode: 'preferred' }),
      'health-fail': route(['a', 'b', 'c'], { pinMode: 'preferred' }),
      'capped-rate': route(['a', 'b', 'c'], { maxRetries: 1 }),
      'iso-fail': route(['a']),
      'iso-ok': route(['a']),
      'excluded-model': route(['a'], { exclude: ['a'] }),
      'hard-model': route(['a']),
      'cool-model': route(['a', 'b']),
      'null-last': route(['x', 'y'], { pinMode: 'preferred' }),
      'configured-wins': route(['a']),
    },
    errorRules: [],
  };
  let running = await startSwitcher(config, dir);
  t.after(async () => { if (running?.child) await stop(running.child); await close(upstream); fs.rmSync(dir, { recursive: true, force: true }); });
  const call = (model) => rawJson(port, '/v1/chat/completions', { model, messages: [] });

  assert.equal((await call('strict-rate')).status, 200);
  assert.deepEqual(seen.filter((row) => row.model === 'strict-rate').map((row) => row.provider), ['a', 'b', 'c'], 'cold strict uses source order');
  seen.length = 0;
  assert.equal((await call('strict-rate')).status, 200);
  assert.deepEqual(seen.map((row) => row.provider), ['a', 'c'], 'strict retry excludes the attempted provider and orders the rest by success rate');

  seen.length = 0;
  assert.equal((await call('preferred-rate')).status, 200);
  assert.deepEqual(seen.map((row) => row.provider), ['a', 'b', 'c'], 'cold preferred falls back to source order while rates are unknown');
  seen.length = 0;
  assert.equal((await call('preferred-rate')).status, 200);
  assert.deepEqual(seen.map((row) => row.provider), ['c'], 'preferred selects by provider-model success rate from the first attempt');

  seen.length = 0;
  assert.equal((await call('capped-rate')).status, 500);
  assert.deepEqual(seen.map((row) => row.provider), ['a', 'b'], 'maxRetries caps real outer attempts after the first');
  assert.equal((await call('iso-fail')).status, 500);
  assert.equal((await call('iso-ok')).status, 200);
  const modelsView = await (await fetch(`http://127.0.0.1:${port}/api/models`)).json();
  assert.equal(modelsView.subscription.find((row) => row.id === 'iso-fail').meta.upstreamStatus.a.success.successRate, 0);
  assert.equal(modelsView.subscription.find((row) => row.id === 'iso-ok').meta.upstreamStatus.a.success.successRate, 1, 'provider success rate is isolated per resolved model');

  seen.length = 0;
  assert.equal((await call('auto-model')).status, 200);
  assert.deepEqual(seen.map((row) => row.provider), [null], 'a truly empty candidate source allows exactly one unattributed auto attempt');
  assert.equal(seen[0].only, null); assert.equal(seen[0].gatewayOnly, null);

  seen.length = 0;
  assert.equal((await call('excluded-model')).status, 503);
  assert.deepEqual(seen, [], 'a fully excluded known list never falls back to auto');
  assert.equal((await call('hard-model')).status, 503);
  assert.deepEqual(seen, [], 'a fully hard-quarantined list fails safely');
  seen.length = 0;
  assert.equal((await call('cool-model')).status, 200);
  assert.deepEqual(seen.map((row) => row.provider), ['b'], 'a durable cooldown removes only that provider from the plan');
  seen.length = 0;
  assert.equal((await call('discovered-model')).status, 200);
  assert.deepEqual(seen.map((row) => row.provider), ['d1'], 'stable discovered order is authoritative when nothing is configured');

  const named = seen.filter((row) => row.model === 'discovered-model');
  for (const row of [...named]) assert.ok((row.only?.length ?? 0) <= 1 && (row.gatewayOnly?.length ?? 0) <= 1 && row.order === null);
  const everyNamed = seen.concat(await (async () => { seen.length = 0; assert.equal((await call('strict-rate')).status, 200); return seen.slice(); })());
  for (const row of everyNamed) {
    assert.ok((row.only?.length ?? 0) <= 1, 'provider.only is at most a singleton');
    assert.ok((row.gatewayOnly?.length ?? 0) <= 1, 'gateway.only is at most a singleton');
    assert.equal(row.order, null, 'named attempts never inject provider order');
  }
  // The unknown pipeline injects the same singleton only into both provider shapes.
  const unknownPipeline = await (async () => { seen.length = 0; assert.equal((await call('strict-rate')).status, 200); return seen.slice(); })();
  assert.ok(unknownPipeline.length > 0);
  for (const row of unknownPipeline) {
    assert.deepEqual(row.only, [row.provider], 'unknown pipeline injects a singleton provider.only');
    assert.deepEqual(row.gatewayOnly, [row.provider], 'the same singleton is injected into providerOptions.gateway.only');
  }

  // Configured upstreams stay authoritative even when discovery already knows other providers.
  seen.length = 0;
  assert.equal((await call('configured-wins')).status, 500);
  assert.deepEqual(seen.map((row) => row.provider), ['a'], 'a non-empty configured list overrides the discovered order');

  // An unrated provider must sort after a rated one even when it has the earlier source index.
  seen.length = 0;
  assert.equal((await call('null-last')).status, 502);
  assert.deepEqual(seen.map((row) => row.provider), ['y'], 'a hard-quarantined provider stays out of the candidate snapshot');
  assert.equal((await rawJson(port, '/api/providers/recover', { model: 'null-last', provider: 'x' })).status, 200);
  seen.length = 0;
  assert.equal((await call('null-last')).status, 200);
  assert.deepEqual(seen.map((row) => row.provider), ['y', 'x'], 'a rated provider precedes an unrated provider (null last) despite its later source index');

  // Bounded strategy evidence: plan source/mode on the request row plus one selection enum per real attempt.
  const logRow = (response) => waitUntil(async () => {
    const page = await (await fetch(`http://127.0.0.1:${port}/api/logs/requests?requestId=${response.headers['x-cline-request-id']}`)).json();
    return page.items[0] || null;
  });
  const attemptErrors = (response) => waitUntil(async () => {
    const page = await (await fetch(`http://127.0.0.1:${port}/api/logs/errors?requestId=${response.headers['x-cline-request-id']}&limit=20`)).json();
    return page.items.length ? page.items : null;
  });

  // strict: the first real attempt stays source-order even though provider c already holds the best rate.
  seen.length = 0;
  const strictEvidence = await call('strict-rate');
  assert.equal(strictEvidence.status, 200);
  assert.deepEqual(seen.map((row) => row.provider), ['a', 'c'], 'strict still starts with the source-order provider');
  const strictLog = await logRow(strictEvidence);
  assert.equal(strictLog.providerPlanSource, 'configured');
  assert.equal(strictLog.providerMode, 'strict');
  assert.deepEqual(strictLog.attempts.map((attempt) => attempt.providerSelection), ['strict-first', 'health'], 'strict first attempt is strict-first and its retry is health-selected');
  assert.deepEqual(strictLog.attempts.map((attempt) => attempt.provider), ['a', 'c']);
  assert.deepEqual([...strictLog.targetProviders].sort(), ['a', 'b', 'c'], 'the request row still exposes the planned candidate order');
  const strictErrorRows = await attemptErrors(strictEvidence);
  assert.deepEqual(strictErrorRows.map((row) => row.providerSelection), ['strict-first'], 'error rows carry the same bounded selection enum');

  // preferred: every attempt, including the first, is health-selected.
  seen.length = 0;
  const preferredEvidence = await call('preferred-rate');
  assert.equal(preferredEvidence.status, 200);
  assert.deepEqual(seen.map((row) => row.provider), ['c'], 'preferred picks by health from the first attempt');
  const preferredLog = await logRow(preferredEvidence);
  assert.equal(preferredLog.providerPlanSource, 'configured');
  assert.equal(preferredLog.providerMode, 'preferred');
  assert.deepEqual(preferredLog.attempts.map((attempt) => attempt.providerSelection), ['health']);

  // A preferred retry chain marks every attempt and every error row as health-selected.
  seen.length = 0;
  const preferredRetry = await call('health-fail');
  assert.equal(preferredRetry.status, 200);
  assert.deepEqual(seen.map((row) => row.provider), ['a', 'b', 'c'], 'cold preferred retries in source order while every rate is unknown');
  const preferredRetryLog = await logRow(preferredRetry);
  assert.equal(preferredRetryLog.providerPlanSource, 'configured');
  assert.equal(preferredRetryLog.providerMode, 'preferred');
  assert.deepEqual(preferredRetryLog.attempts.map((attempt) => attempt.providerSelection), ['health', 'health', 'health']);
  assert.deepEqual((await attemptErrors(preferredRetry)).map((row) => row.providerSelection), ['health', 'health'], 'preferred failure rows never claim strict-first');

  // discovered source and unattributed auto stay distinguishable bounded facts.
  const discoveredLog = await logRow(await call('discovered-model'));
  assert.equal(discoveredLog.providerPlanSource, 'discovered');
  assert.equal(discoveredLog.providerMode, 'strict');
  assert.deepEqual(discoveredLog.attempts.map((attempt) => attempt.providerSelection), ['strict-first']);
  const autoLog = await logRow(await call('auto-model'));
  assert.equal(autoLog.providerPlanSource, 'auto');
  assert.equal(autoLog.providerMode, 'strict');
  assert.deepEqual(autoLog.attempts.map((attempt) => attempt.providerSelection), ['compat-auto'], 'a truly empty candidate source is projected as compat-auto');
  const routingFailLog = await logRow(await call('excluded-model'));
  assert.equal(routingFailLog.providerPlanSource, 'configured', 'a safe routing failure still reports its plan source');
  assert.equal(routingFailLog.providerMode, 'strict');
  assert.deepEqual(routingFailLog.attempts, [], 'a plan rejected before any real attempt records no attempt selection');

  // The projection stays bounded: enums only, no rate numbers, candidate maps or credentials.
  const observedSelections = new Set([strictLog, preferredLog, preferredRetryLog, discoveredLog, autoLog].flatMap((row) => row.attempts.map((attempt) => attempt.providerSelection)));
  assert.deepEqual([...observedSelections].sort(), ['compat-auto', 'health', 'strict-first']);
  for (const row of [strictLog, preferredLog, preferredRetryLog, discoveredLog, autoLog]) {
    for (const attempt of row.attempts) assert.equal(Object.hasOwn(attempt, 'rates'), false, 'attempt rows never carry the candidate rate map');
  }
  const serializedLogs = JSON.stringify(await (await fetch(`http://127.0.0.1:${port}/api/logs/requests?limit=200`)).json());
  assert.equal(serializedLogs.includes('successRate'), false, 'ordinary request logs never persist provider success-rate values');
  assert.equal(serializedLogs.includes('"rates"'), false);
  assert.equal(serializedLogs.includes('key-a'), false, 'ordinary request logs never persist account keys');
});

test('retry rules stop deterministic request errors before remaining providers or account replacement and stay independent from health', async (t) => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      const provider = body.provider?.only?.[0] || body.providerOptions?.gateway?.only?.[0] || null, auth = req.headers.authorization;
      seen.push({ model: body.model, provider, auth });
      if (body.model === 'retry-stop' && provider === 'first') { res.writeHead(502, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'System Message Must Have Content', status: 502 } })); }
      if (body.model === 'retry-any' && provider === 'first') { res.writeHead(502, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'prefix SYSTEM MESSAGE MUST HAVE CONTENT suffix', status: 502 } })); }
      if (body.model === 'retry-envelope' && provider === 'first') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'system message must have content', status: 502 } })); }
      if (body.model === 'retry-status-miss' && provider === 'first') { res.writeHead(503, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'different body', status: 503 } })); }
      if (body.model === 'retry-body-miss' && provider === 'first') { res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'system message must have content', status: 500 } })); }
      if (body.model === 'retry-first-match' && provider === 'first') { res.writeHead(502, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'only beta here', status: 502 } })); }
      if (body.model === 'retry-compat' && provider === 'first') { res.writeHead(502, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'plain failure', status: 502 } })); }
      if (body.model === 'retry-account' && auth === 'Bearer key-a') { res.writeHead(502, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'system message must have content', status: 502 } })); }
      if (body.model === 'retry-sse' && provider === 'first') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); return res.end('data: ' + JSON.stringify({ error: { message: 'system message must have content', status: 502 } }) + '\n\n'); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }], provider }));
    });
  });
  const upstreamPort = await listen(upstream), port = await unusedPort(), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cps-retry-rules-'));
  const route = (providers) => ({ upstreams: providers, exclude: [], pinMode: 'strict', sort: null, maxRetries: null, providerCooldownMs: 0 });
  const models = ['retry-stop', 'retry-any', 'retry-envelope', 'retry-status-miss', 'retry-body-miss', 'retry-first-match', 'retry-compat', 'retry-account', 'retry-sse'];
  const config = {
    port, upstreamBase: `http://127.0.0.1:${upstreamPort}`, accountMode: 'single', activeAccount: 0, concurrencyWaitMs: 0,
    accounts: [{ id: 'a', name: 'A', key: 'key-a', enabled: true, perModel: {} }, { id: 'b', name: 'B', key: 'key-b', enabled: true, perModel: {} }],
    knownModels: models, perModel: Object.fromEntries(models.map((model) => [model, route(['first', 'second'])])),
    retryRules: [
      { id: 'stop-first-match', decision: 'stop', when: { statuses: [502], body_contains: ['alpha needle'] } },
      { id: 'stop-beta', decision: 'stop', when: { statuses: [502], body_contains: ['beta'] } },
      { id: 'stop-system-message', decision: 'stop', when: { statuses: [502], body_contains: 'system message must have content' } },
      { id: 'stop-status-only', decision: 'stop', when: { statuses: [503], body_contains: ['never appears'] } },
    ],
    errorRules: [
      { id: 'ignore-system-message', scope: 'provider-model', action: 'ignore', models: ['retry-stop', 'retry-any', 'retry-envelope', 'retry-account', 'retry-sse'], when: { statuses: [502], body_contains: 'system message must have content' } },
      { id: 'account-cooldown', scope: 'account', action: 'cooldown', models: ['retry-account'], when: { statuses: [502] }, reset: { fallback: '5m0s', max: '5m0s' } },
    ],
  };
  let running = await startSwitcher(config, dir);
  t.after(async () => { if (running?.child) await stop(running.child); await close(upstream); fs.rmSync(dir, { recursive: true, force: true }); });
  const call = (model, extra = {}) => rawJson(port, '/v1/chat/completions', { model, messages: [], ...extra });

  let response = await call('retry-stop');
  assert.equal(response.status, 502);
  assert.deepEqual(seen.filter((row) => row.model === 'retry-stop').map((row) => row.provider), ['first'], 'a matched retry stop leaves exactly one real attempt');
  let modelsView = await (await fetch(`http://127.0.0.1:${port}/api/models`)).json();
  assert.equal(modelsView.subscription.find((row) => row.id === 'retry-stop').meta.upstreamStatus.first.success.degrades, 0, 'the paired provider-model ignore rule keeps the retry stop out of the success rate');

  seen.length = 0; assert.equal((await call('retry-any')).status, 502);
  assert.deepEqual(seen.map((row) => row.provider), ['first'], 'body needles match case-insensitively as plain substrings');
  seen.length = 0; assert.equal((await call('retry-envelope')).status, 502);
  assert.deepEqual(seen.map((row) => row.provider), ['first'], 'an HTTP 200 error envelope is normalized before retry matching');
  seen.length = 0; assert.equal((await call('retry-sse', { stream: true })).status, 502);
  assert.deepEqual(seen.map((row) => row.provider), ['first'], 'a pre-stream SSE error event matches the retry rule and never replays');
  const sseRow = (await (await fetch(`http://127.0.0.1:${port}/api/models`)).json()).subscription.find((row) => row.id === 'retry-sse');
  assert.equal(sseRow.meta.upstreamStatus.first.success.degrades, 0, 'the paired ignore rule also covers the pre-stream SSE form');
  seen.length = 0; assert.equal((await call('retry-status-miss')).status, 200);
  assert.deepEqual(seen.map((row) => row.provider), ['first', 'second'], 'a status-only match without the body needle keeps the compatible retry default');
  seen.length = 0; assert.equal((await call('retry-body-miss')).status, 200);
  assert.deepEqual(seen.map((row) => row.provider), ['first', 'second'], 'a body-only match without the status keeps the compatible retry default');
  seen.length = 0; assert.equal((await call('retry-first-match')).status, 502);
  assert.deepEqual(seen.map((row) => row.provider), ['first'], 'later retry rules are reachable when an earlier status match misses the body');
  modelsView = await (await fetch(`http://127.0.0.1:${port}/api/models`)).json();
  assert.equal(modelsView.subscription.find((row) => row.id === 'retry-first-match').meta.upstreamStatus.first.success.degrades, 1, 'a retry stop without a paired ignore rule keeps the independent default provider degrade');

  seen.length = 0; assert.equal((await call('retry-compat')).status, 200);
  assert.deepEqual(seen.map((row) => row.provider), ['first', 'second'], 'no retry rule match preserves the current continue behavior');

  seen.length = 0; assert.equal((await call('retry-account')).status, 502);
  assert.deepEqual(seen.map((row) => row.auth), ['Bearer key-a'], 'a retry stop blocks account replacement even when an account action would normally allow it');

  await waitUntil(async () => { const page = await (await fetch(`http://127.0.0.1:${port}/api/logs/errors?requestedModel=retry-first-match&limit=5`)).json(); return page.items[0]?.retryRuleId === 'stop-beta' && page; });
  const errorRow = (await (await fetch(`http://127.0.0.1:${port}/api/logs/errors?requestedModel=retry-first-match&limit=5`)).json()).items[0];
  assert.equal(errorRow.retryRuleId, 'stop-beta'); assert.equal(errorRow.retryDecision, 'stop'); assert.deepEqual(errorRow.retryMatchedBy, ['status', 'body']);
  const stopRow = (await (await fetch(`http://127.0.0.1:${port}/api/logs/errors?requestedModel=retry-account&limit=5`)).json()).items[0];
  assert.equal(stopRow.retryRuleId, 'stop-system-message');
  const serialized = JSON.stringify(await (await fetch(`http://127.0.0.1:${port}/api/logs/requests?limit=200`)).json()) + JSON.stringify(await (await fetch(`http://127.0.0.1:${port}/api/logs/errors?limit=200`)).json());
  assert.equal(serialized.includes('body_contains'), false, 'ordinary logs never project raw rule conditions');
  assert.equal(serialized.includes('needle'), false, 'ordinary logs never project rule needles');
  assert.equal(fs.readFileSync(path.join(dir, 'metadata.json'), 'utf8').includes('system message must have content'), false, 'durable metadata never stores a retry needle');

  await stop(running.child); running.child = null; running = await startSwitcher(null, dir);
  const view = await (await fetch(`http://127.0.0.1:${port}/api/accounts`)).json();
  assert.equal(view.retryRules.length, 4, 'retryRules round-trip through restart');
});

test('string retry rule preserves pre-stream timeout status and ordinary failure logs', async (t) => {
  const upstream = http.createServer((req) => { req.resume(); }); // No response headers or first SSE data.
  const upstreamPort = await listen(upstream), port = await unusedPort();
  const running = await startSwitcher({
    port, upstreamBase: `http://127.0.0.1:${upstreamPort}`, accountMode: 'single', activeAccount: 0,
    accounts: [{ id: 'a', name: 'A', key: 'local-test-key', enabled: true }], knownModels: ['timeout-model'],
    perModel: { 'timeout-model': { upstreams: ['first'], maxRetries: 0 } },
    retryRules: [{ id: 'stop-specific', decision: 'stop', when: { statuses: [502], body_contains: 'system message must have content' } }],
  }, null, { NODE_ENV: 'test', CLINE_PASS_TEST_SSE_FIRST_EVENT_MS: '200' });
  t.after(async () => { await stop(running.child); await close(upstream); fs.rmSync(running.dir, { recursive: true, force: true }); });

  const response = await rawJson(port, '/v1/chat/completions', { model: 'timeout-model', messages: [], stream: true });
  assert.equal(response.status, 502, 'a nonmatching string needle must not mask the upstream timeout with a 500');
  const requestId = response.headers['x-cline-request-id'];
  const requestRow = await waitUntil(async () => (await (await fetch(`http://127.0.0.1:${port}/api/logs/requests?requestId=${requestId}`)).json()).items[0]);
  const errorRow = await waitUntil(async () => (await (await fetch(`http://127.0.0.1:${port}/api/logs/errors?requestId=${requestId}`)).json()).items[0]);
  assert.equal(requestRow.status, 502);
  assert.equal(requestRow.result, 'failed');
  assert.equal(requestRow.attempts.length, 1);
  assert.equal(errorRow.status, 502);
  assert.equal(errorRow.upstreamStatus, 0);
  assert.equal(errorRow.retryDecision, 'continue');
  assert.equal(errorRow.retryRuleId, null);
});

test('retryRules management API validates strictly, preserves old-client omission and keeps config bytes on rejection', async (t) => {
  const config = {
    port: await unusedPort(), accountMode: 'single', activeAccount: 0, concurrencyWaitMs: 0,
    accounts: [{ id: 'a', name: 'A', key: 'key-a', enabled: true, perModel: {} }],
    knownModels: ['m'], perModel: {}, errorRules: [],
    retryRules: [{ id: 'stop-default', decision: 'stop', when: { statuses: [502], body_contains: ['system message must have content'] } }],
  };
  let running = await startSwitcher(config);
  t.after(async () => { if (running?.child) await stop(running.child); fs.rmSync(running.dir, { recursive: true, force: true }); });
  const view = await (await fetch(`http://127.0.0.1:${running.port || config.port}/api/accounts`)).json();
  assert.deepEqual(view.retryRules, config.retryRules);
  const replacement = [{ id: 'stop-x', decision: 'stop', when: { statuses: [500, 599], body_contains: ['a', 'b'] } }];
  assert.equal((await rawJson(config.port, '/api/accounts', { accounts: view.accounts, mode: view.mode, active: view.active, concurrencyWaitMs: view.concurrencyWaitMs, errorRules: view.errorRules, accountPipeline: view.accountPipeline, retryRules: replacement })).status, 200);
  let current = await (await fetch(`http://127.0.0.1:${config.port}/api/accounts`)).json();
  assert.deepEqual(current.retryRules, replacement, 'new UI round trip');
  assert.equal((await rawJson(config.port, '/api/accounts', { accounts: current.accounts, mode: current.mode, active: current.active, concurrencyWaitMs: current.concurrencyWaitMs, errorRules: current.errorRules, accountPipeline: current.accountPipeline })).status, 200);
  current = await (await fetch(`http://127.0.0.1:${config.port}/api/accounts`)).json();
  assert.deepEqual(current.retryRules, replacement, 'an older client that omits retryRules preserves the current value');
  const configBytes = fs.readFileSync(path.join(running.dir, 'config.json'));
  const invalid = [
    null, {}, 'x',
    [{ id: 'x', decision: 'stop', when: { statuses: [502] } }],
    [{ id: 'x', decision: 'stop', when: { body_contains: 'needle' } }],
    [{ id: 'x', decision: 'continue', when: { statuses: [502], body_contains: 'needle' } }],
    [{ id: 'x', decision: 'stop', when: { statuses: [502], body_contains: 'needle' }, extra: true }],
    [{ id: '-x', decision: 'stop', when: { statuses: [502], body_contains: 'needle' } }],
    [{ id: 'x', decision: 'stop', when: { statuses: [99], body_contains: 'needle' } }],
    [{ id: 'x', decision: 'stop', when: { statuses: [502], body_contains: '' } }],
    [{ id: 'x', decision: 'stop', when: { statuses: [502], body_contains: 'a'.repeat(501) } }],
    [{ id: 'x', decision: 'stop', when: { statuses: [502], body_contains: ['a', 'A'] } }],
    [replacement[0], { ...replacement[0] }],
    Array.from({ length: 101 }, (_, index) => ({ id: `stop-${index}`, decision: 'stop', when: { statuses: [502], body_contains: 'needle' } })),
    Array.from({ length: 20 }, (_, index) => ({ id: `stop-big-${index}`, decision: 'stop', when: { statuses: [502], body_contains: Array.from({ length: 20 }, (_, needle) => `needle-${index}-${needle}`.padEnd(400, 'x')) } })),
  ];
  for (const retryRules of invalid) {
    const rejected = await rawJson(config.port, '/api/accounts', { accounts: current.accounts, mode: current.mode, active: current.active, concurrencyWaitMs: current.concurrencyWaitMs, errorRules: current.errorRules, accountPipeline: current.accountPipeline, retryRules });
    assert.equal(rejected.status, 400, JSON.stringify(retryRules).slice(0, 200));
    assert.deepEqual(fs.readFileSync(path.join(running.dir, 'config.json')), configBytes, 'a rejected payload never rewrites config bytes');
  }
});

test('rule actions record exactly the declared direct health sample and disposition per scope', async (t) => {
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'provider failed', status: 502 } }));
    });
  });
  const upstreamPort = await listen(upstream), port = await unusedPort(), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cps-sample-matrix-'));
  const route = (providers) => ({ upstreams: providers, exclude: [], pinMode: 'strict', sort: null, maxRetries: null, providerCooldownMs: 0 });
  const models = ['cooldown-pm', 'hard-pm', 'ignore-pm', 'hard-account'];
  let running = await startSwitcher({
    port, upstreamBase: `http://127.0.0.1:${upstreamPort}`, accountMode: 'single', activeAccount: 0, concurrencyWaitMs: 0,
    accounts: [{ id: 'a', name: 'A', key: 'key-a', enabled: true, perModel: {} }],
    knownModels: models, perModel: Object.fromEntries(models.map((model) => [model, route(['first'])])),
    errorRules: [
      { id: 'pm-cool', scope: 'provider-model', action: 'cooldown', models: ['cooldown-pm'], when: { statuses: [502] }, reset: { fallback: '5m0s', max: '5m0s' } },
      { id: 'pm-hard', scope: 'provider-model', action: 'hard-quarantine', models: ['hard-pm'], when: { statuses: [502] } },
      { id: 'pm-ignore', scope: 'provider-model', action: 'ignore', models: ['ignore-pm'], when: { statuses: [502] } },
      { id: 'acct-hard', scope: 'account', action: 'hard-quarantine', models: ['hard-account'], when: { statuses: [502] } },
    ],
  }, dir);
  t.after(async () => { if (running?.child) await stop(running.child); await close(upstream); fs.rmSync(dir, { recursive: true, force: true }); });
  const call = (model) => rawJson(port, '/v1/chat/completions', { model, messages: [] });
  const modelRow = async (model) => (await (await fetch(`http://127.0.0.1:${port}/api/models`)).json()).subscription.find((row) => row.id === model);

  assert.equal((await call('cooldown-pm')).status, 502);
  let row = await modelRow('cooldown-pm');
  assert.equal(row.meta.upstreamStatus.first.success.degrades, 1, 'provider-model cooldown records exactly one failure sample');
  assert.ok(row.meta.upstreamStatus.first.cooldownUntil > Date.now(), 'provider-model cooldown also keeps its temporary disposition');

  assert.equal((await call('hard-pm')).status, 502);
  row = await modelRow('hard-pm');
  assert.equal(row.meta.upstreamStatus.first.success.degrades, 1, 'provider-model hard-quarantine records exactly one failure sample');
  assert.equal(row.meta.upstreamStatus.first.hardQuarantined, true, 'provider-model hard-quarantine also keeps its durable disposition');

  assert.equal((await call('ignore-pm')).status, 502);
  row = await modelRow('ignore-pm');
  assert.equal(row.meta.upstreamStatus.first.success.samples, 0, 'provider-model ignore records no failure sample');
  assert.equal(row.meta.upstreamStatus.first.cooldownUntil, 0);
  assert.equal(row.meta.upstreamStatus.first.hardQuarantined, false);

  assert.equal((await call('hard-account')).status, 502);
  row = await modelRow('hard-account');
  assert.equal(row.meta.upstreamStatus.first.success.samples, 0, 'an account-scope action never records a provider-model sample');
  const stats = await (await fetch(`http://127.0.0.1:${port}/api/statistics`)).json();
  const account = stats.accounts.find((entry) => entry.id === 'a');
  assert.equal(account.health.degrades, 1, 'account hard-quarantine records exactly one account failure sample');
  assert.equal(account.health.samples, 1, 'provider-model actions and ignore add no account sample');
});

// --- Parent-task integration: cross-owned combination contracts -------------------------------------
// These cases exist because the three sub-tasks were verified independently. Each one crosses at least
// two owners (dynamic pool target, session binding, rule state, retry-stop control flow) and asserts the
// seam rather than a single-owner behavior already covered above.

test('a promoted cache-pool member owns the retry stop and the pool target grows exactly once', async (t) => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    if (req.method === 'GET') { res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end('{}'); }
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      const provider = body.provider?.only?.[0] || body.providerOptions?.gateway?.only?.[0] || null;
      const auth = req.headers.authorization;
      seen.push({ auth, provider });
      const reply = () => {
        if (auth === 'Bearer key-b' && provider === 'first') {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: { message: 'promoted needle', status: 502 } }));
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }));
      };
      if (auth === 'Bearer key-a') setTimeout(reply, 160); else reply();
    });
  });
  const upstreamPort = await listen(upstream), port = await unusedPort(), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cps-combined-grow-stop-'));
  const accounts = [{ id: 'a', name: 'A', key: 'key-a', enabled: true, priority: 1, maxConcurrent: 1, perModel: {} }, { id: 'b', name: 'B', key: 'key-b', enabled: true, priority: 2, maxConcurrent: 1, perModel: {} }];
  const running = await startSwitcher({
    port, upstreamBase: `http://127.0.0.1:${upstreamPort}`, accounts, accountMode: 'sticky', activeAccount: 0, concurrencyWaitMs: 25,
    knownModels: ['slow'], perModel: { slow: { upstreams: ['first', 'second'], exclude: [], pinMode: 'strict', sort: null, maxRetries: null, providerCooldownMs: 0 } },
    retryRules: [{ id: 'stop-promoted', decision: 'stop', when: { statuses: [502], body_contains: ['promoted needle'] } }],
    errorRules: [], accountPipeline: { quotaPool: false, healthSort: false, sticky: false, order: PIPELINE_STEP_ORDER, cachePoolSize: 1, cachePoolMaxSize: 2 },
  }, dir, { NODE_ENV: 'test' });
  t.after(async () => { await stop(running.child); await close(upstream); fs.rmSync(dir, { recursive: true, force: true }); });
  const send = (session) => rawJson(port, '/v1/chat/completions', { model: 'slow', messages: [] }, { 'Session-Id': session });
  const logFor = (response) => waitUntil(async () => {
    const page = await (await fetch(`http://127.0.0.1:${port}/api/logs/requests?requestId=${response.headers['x-cline-request-id']}`)).json();
    return page.items[0];
  });

  const holder = send('grow-stop-holder');
  await waitUntil(() => seen.length === 1);
  const stopped = await send('grow-stop-promoted');
  assert.equal(stopped.status, 502);
  assert.deepEqual(seen.map((row) => row.provider), ['first', 'first'], 'the promoted account runs exactly one real attempt');
  assert.equal(seen[1].auth, 'Bearer key-b', 'the saturated miss is served by the newly promoted member');
  const stoppedLog = await logFor(stopped);
  assert.ok(['cache-pool-active', 'cache-pool-active-overflow'].includes(stoppedLog.selectionReason));
  assert.equal(stoppedLog.cachePoolTier, 'active');
  assert.equal(stoppedLog.cachePoolTargetSize, 2, 'the promoted request already observes the grow-one target');
  assert.equal(stoppedLog.attempts.length, 1, 'the retry stop leaves exactly one attempt on the promoted account');
  assert.equal(stoppedLog.attempts[0].retryRuleId, 'stop-promoted');
  assert.equal(stoppedLog.attempts[0].retryDecision, 'stop');
  const view = await (await fetch(`http://127.0.0.1:${port}/api/accounts`)).json();
  assert.equal(view.cachePool.targetSize, 2);
  assert.deepEqual(view.accounts.map((account) => account.cachePoolRole), ['active', 'active']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'metadata.json'))).cachePoolTargetSize, 2, 'the single grow-one decision is durable');
  assert.equal((await holder).status, 200);
  assert.equal(seen.filter((row) => row.auth === 'Bearer key-b').length, 1, 'the retry stop never re-rolls a second provider on the promoted account');
});

test('an account-scope cooldown persists while the paired retry stop suppresses account replacement', async (t) => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const auth = req.headers.authorization;
      seen.push(auth);
      if (auth === 'Bearer key-a') {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'priority needle', status: 502 } }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }));
    });
  });
  const upstreamPort = await listen(upstream), port = await unusedPort(), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cps-combined-priority-'));
  const running = await startSwitcher({
    port, upstreamBase: `http://127.0.0.1:${upstreamPort}`, accountMode: 'single', activeAccount: 0, concurrencyWaitMs: 0,
    accounts: [{ id: 'a', name: 'A', key: 'key-a', enabled: true, perModel: {} }, { id: 'b', name: 'B', key: 'key-b', enabled: true, perModel: {} }],
    knownModels: ['prio'], perModel: { prio: { upstreams: ['first', 'second'], exclude: [], pinMode: 'strict', sort: null, maxRetries: null, providerCooldownMs: 0 } },
    errorRules: [{ id: 'cooldown-prio', scope: 'account', action: 'cooldown', when: { statuses: [502] }, reset: { fallback: '30m0s', max: '1h0m0s' } }],
    retryRules: [{ id: 'stop-prio', decision: 'stop', when: { statuses: [502], body_contains: ['priority needle'] } }],
  }, dir, { NODE_ENV: 'test' });
  t.after(async () => { await stop(running.child); await close(upstream); fs.rmSync(dir, { recursive: true, force: true }); });
  const call = () => rawJson(port, '/v1/chat/completions', { model: 'prio', messages: [] });

  const response = await call();
  assert.equal(response.status, 502);
  assert.deepEqual(seen, ['Bearer key-a'], 'the retry stop blocks account replacement even though the account action allows it');
  const view = await (await fetch(`http://127.0.0.1:${port}/api/accounts`)).json();
  const account = view.accounts.find((entry) => entry.id === 'a');
  assert.ok(account.state && account.state.cooldownUntil > Date.now(), 'the account-scope cooldown state is persisted independently of the retry decision');
  assert.equal(account.health.degrades, 1, 'account-scope cooldown records exactly one account failure sample');
  assert.equal(account.health.samples, 1);
  const models = await (await fetch(`http://127.0.0.1:${port}/api/models`)).json();
  assert.equal(models.subscription.find((row) => row.id === 'prio').meta.upstreamStatus.first.success.samples, 0, 'an account-scope action never writes a provider-model sample');
  const errors = await waitUntil(async () => { const page = await (await fetch(`http://127.0.0.1:${port}/api/logs/errors?requestedModel=prio&limit=5`)).json(); return page.items[0]; });
  assert.equal(errors.retryRuleId, 'stop-prio');
  assert.equal(errors.retryDecision, 'stop');
  assert.equal(errors.ruleScope, 'account');
  assert.equal(errors.ruleAction, 'cooldown');
  assert.equal(errors.healthAction, 'cooldown', 'the account sample and the retry-stop decision stay independent');
  seen.length = 0;
  assert.equal((await call()).status, 200);
  assert.deepEqual(seen, ['Bearer key-b'], 'the persisted cooldown removes account A from the next request');
});

test('account hard-quarantine invalidates a confirmed session binding and rebinds the session', async (t) => {
  let quarantineKey = null;
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      if (body.model === 'quarantine' && quarantineKey && req.headers.authorization === quarantineKey) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'quarantine now', status: 500 } }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }));
    });
  });
  const upstreamPort = await listen(upstream), port = await unusedPort(), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cps-combined-binding-quarantine-'));
  const running = await startSwitcher({
    port, upstreamBase: `http://127.0.0.1:${upstreamPort}`, accountMode: 'sticky', activeAccount: 0, concurrencyWaitMs: 0,
    accounts: [{ id: 'a', name: 'A', key: 'key-a', enabled: true, perModel: {} }, { id: 'b', name: 'B', key: 'key-b', enabled: true, perModel: {} }],
    knownModels: ['ok', 'quarantine'], perModel: {},
    errorRules: [{ id: 'quarantine-account', scope: 'account', action: 'hard-quarantine', models: ['quarantine'], when: { statuses: [500] } }],
    retryRules: [], accountPipeline: { quotaPool: false, healthSort: true, sticky: true, order: PIPELINE_STEP_ORDER, cachePoolSize: 0, cachePoolMaxSize: 0 },
  }, dir, { NODE_ENV: 'test' });
  t.after(async () => { await stop(running.child); await close(upstream); fs.rmSync(dir, { recursive: true, force: true }); });
  const view = async () => (await fetch(`http://127.0.0.1:${port}/api/accounts`)).json();
  const send = (model) => rawJson(port, '/v1/chat/completions', { model, messages: [] }, { 'Session-Id': 'quarantine-binding-session' });
  const logFor = (response) => waitUntil(async () => {
    const page = await (await fetch(`http://127.0.0.1:${port}/api/logs/requests?requestId=${response.headers['x-cline-request-id']}`)).json();
    return page.items[0];
  });

  const first = await send('ok');
  assert.equal((await logFor(first)).bindingResult, 'miss');
  const boundName = first.headers['x-cline-account'];
  const bound = (await view()).accounts.find((account) => account.name === boundName);
  quarantineKey = `Bearer ${bound.key}`;
  const hit = await send('ok');
  assert.equal(hit.headers['x-cline-account'], boundName);
  assert.equal((await logFor(hit)).bindingResult, 'hit', 'the binding gate short-circuits health sorting');

  const quarantined = await send('quarantine');
  assert.equal(quarantined.status, 200);
  assert.notEqual(quarantined.headers['x-cline-account'], boundName, 'the hard-quarantined account is replaced as the binding owner');
  assert.equal((await logFor(quarantined)).bindingResult, 'miss', 'the replacement selection is a fresh miss, not a stale hit');
  const afterQuarantine = await view();
  assert.equal(afterQuarantine.accounts.find((account) => account.id === bound.id).state.hardQuarantined, true);
  assert.equal(afterQuarantine.cachePool.binding.enabled, true);
  assert.equal(afterQuarantine.cachePool.binding.size, 1, 'the quarantined entry is replaced by exactly one new binding');

  const rebound = await send('ok');
  assert.equal(rebound.headers['x-cline-account'], quarantined.headers['x-cline-account']);
  assert.equal((await logFor(rebound)).bindingResult, 'hit', 'the surviving account owns the rebind');
  const serialized = JSON.stringify(await (await fetch(`http://127.0.0.1:${port}/api/logs/requests?limit=100`)).json()) + fs.readFileSync(path.join(dir, 'metadata.json'), 'utf8');
  assert.equal(serialized.includes('quarantine-binding-session'), false, 'no binding identity reaches logs or metadata');
});

test('a stale-generation completion evaluates both rule sets without writing health or account state', async (t) => {
  let release = null;
  const seen = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      const provider = body.provider?.only?.[0] || body.providerOptions?.gateway?.only?.[0] || null;
      seen.push({ provider, auth: req.headers.authorization });
      if (body.model === 'stale-rules' && provider === 'first') {
        release = () => {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'stale needle', status: 502 } }));
        };
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }));
    });
  });
  const upstreamPort = await listen(upstream), port = await unusedPort(), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cps-combined-stale-rules-'));
  const running = await startSwitcher({
    port, upstreamBase: `http://127.0.0.1:${upstreamPort}`, accountMode: 'single', activeAccount: 0, concurrencyWaitMs: 0,
    accounts: [{ id: 'a', name: 'A', key: 'key-a', enabled: true, perModel: {} }],
    knownModels: ['stale-rules'], perModel: { 'stale-rules': { upstreams: ['first', 'second'], exclude: [], pinMode: 'strict', sort: null, maxRetries: null, providerCooldownMs: 0 } },
    errorRules: [{ id: 'cooldown-stale', scope: 'account', action: 'cooldown', models: ['stale-rules'], when: { statuses: [502] }, reset: { fallback: '30m0s', max: '30m0s' } }],
    retryRules: [{ id: 'stop-stale', decision: 'stop', when: { statuses: [502], body_contains: ['stale needle'] } }],
  }, dir, { NODE_ENV: 'test' });
  t.after(async () => { await stop(running.child); await close(upstream); fs.rmSync(dir, { recursive: true, force: true }); });

  const pending = rawJson(port, '/v1/chat/completions', { model: 'stale-rules', messages: [] });
  await waitUntil(() => release && seen.length === 1);
  const view = await (await fetch(`http://127.0.0.1:${port}/api/accounts`)).json();
  const rotated = { accounts: view.accounts.map((account) => ({ ...account, key: `${account.key}-rotated` })), mode: view.mode, active: view.active, concurrencyWaitMs: view.concurrencyWaitMs, errorRules: view.errorRules, retryRules: view.retryRules, accountPipeline: view.accountPipeline };
  assert.equal((await rawJson(port, '/api/accounts', rotated)).status, 200, 'the identity rotation replaces the running generation');
  release();
  const response = await pending;
  assert.equal(response.status, 502);
  assert.deepEqual(seen.map((row) => row.provider), ['first'], 'the retry stop still ends the request-local provider chain');

  const after = await (await fetch(`http://127.0.0.1:${port}/api/accounts`)).json();
  const account = after.accounts.find((entry) => entry.id === 'a');
  assert.equal(account.state, null, 'a stale completion never re-persists account cooldown state');
  const stats = await (await fetch(`http://127.0.0.1:${port}/api/statistics`)).json();
  const health = stats.accounts.find((entry) => entry.id === 'a').health;
  assert.equal(health.degrades, 0, 'a stale account-scope cooldown writes no failure sample');
  assert.equal(health.samples, 0);
  const models = await (await fetch(`http://127.0.0.1:${port}/api/models`)).json();
  assert.equal(models.subscription.find((row) => row.id === 'stale-rules').meta.upstreamStatus.first.success.samples, 0, 'a stale provider-model failure writes no sample');
  const errorRow = await waitUntil(async () => { const page = await (await fetch(`http://127.0.0.1:${port}/api/logs/errors?requestedModel=stale-rules&limit=5`)).json(); return page.items[0]; });
  assert.equal(errorRow.retryRuleId, 'stop-stale', 'the bounded retry decision is still evaluated for control flow');
  assert.equal(errorRow.retryDecision, 'stop');
  assert.deepEqual(errorRow.retryMatchedBy, ['status', 'body']);
  assert.equal(errorRow.ruleAction, 'cooldown', 'the matched rule is projected as bounded evidence only');
  assert.equal(errorRow.healthAction, 'none', 'a stale attempt never claims a health action');
});

// ---------------------------- 账号级 RPM 限流 ----------------------------

// 可控上游：记录每个 native POST 的 provider 钉住信息，由测试决定何时响应。
function controllableUpstream() {
  const seen = [], pending = [];
  const server = http.createServer((req, res) => {
    if (req.method === 'GET') { res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end('{}'); }
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      let body = null;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
      const provider = body?.provider?.only?.[0] || body?.providerOptions?.gateway?.only?.[0] || null;
      seen.push({ provider, at: Date.now(), authorization: req.headers.authorization, body });
      pending.push({ res, provider, body });
    });
  });
  const drain = (responder) => {
    while (pending.length) {
      const entry = pending.shift();
      const outcome = responder ? responder(entry) : null;
      entry.res.writeHead(outcome?.status || 200, { 'Content-Type': 'application/json' });
      entry.res.end(JSON.stringify(outcome?.body ?? { choices: [{ message: { content: 'OK' } }] }));
    }
  };
  return { server, seen, pending, drain };
}
const rpmView = async (port) => (await (await fetch(`http://127.0.0.1:${port}/api/accounts`)).json());
const accountSave = (view, mutate) => ({ accounts: view.accounts.map(mutate), mode: view.mode, active: view.active, concurrencyWaitMs: view.concurrencyWaitMs, errorRules: view.errorRules, retryRules: view.retryRules, accountPipeline: view.accountPipeline });

test('account maxRpm round-trips through config and API, preserves old-client omission and rejects invalid values without writing bytes', async (t) => {
  const upstream = controllableUpstream();
  const upstreamPort = await listen(upstream.server), port = await unusedPort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cps-rpm-config-'));
  const accounts = [
    { id: 'a', name: 'A', key: 'key-a', enabled: true, maxConcurrent: 0, maxRpm: 7, weight: 1, priority: 1, perModel: {} },
    { id: 'b', name: 'B', key: 'key-b', enabled: true, maxConcurrent: 0, weight: 1, priority: 2, perModel: {} },
  ];
  const running = await startSwitcher({ port, upstreamBase: `http://127.0.0.1:${upstreamPort}`, accounts, accountMode: 'roundrobin', activeAccount: 0, concurrencyWaitMs: 0, knownModels: ['m'], perModel: {}, errorRules: [] }, dir, { NODE_ENV: 'test' });
  t.after(async () => { await stop(running.child); await close(upstream.server); fs.rmSync(dir, { recursive: true, force: true }); });

  let view = await rpmView(port);
  assert.equal(view.accounts.find((a) => a.id === 'a').maxRpm, 7, 'a persisted maxRpm is projected');
  assert.equal(view.accounts.find((a) => a.id === 'b').maxRpm, 0, 'a legacy account without maxRpm means unlimited');
  assert.deepEqual(view.accounts.find((a) => a.id === 'a').rpm, { limit: 7, used: 0, reserved: 0, retryAt: null }, 'the rpm projection exposes only safe numbers');

  // 旧客户端完整保存但省略 maxRpm：必须按 stable id 保留旧值，不能静默清零。
  assert.equal((await rawJson(port, '/api/accounts', accountSave(view, ({ maxRpm, ...rest }) => rest))).status, 200);
  view = await rpmView(port);
  assert.equal(view.accounts.find((a) => a.id === 'a').maxRpm, 7, 'an old client omitting maxRpm must not silently clear it');
  assert.equal(view.accounts.find((a) => a.id === 'b').maxRpm, 0);

  const configPath = path.join(dir, 'config.json');
  const bytes = fs.readFileSync(configPath, 'utf8');
  for (const bad of [-1, 1.5, 100001, '7', null, true, {}]) {
    const rejected = await rawJson(port, '/api/accounts', accountSave(view, (account) => ({ ...account, maxRpm: bad })));
    assert.equal(rejected.status, 400, `maxRpm ${JSON.stringify(bad)} must be rejected`);
    assert.equal(fs.readFileSync(configPath, 'utf8'), bytes, 'a rejected maxRpm must not rewrite config bytes');
  }
  for (const value of [0, 100000]) {
    assert.equal((await rawJson(port, '/api/accounts', accountSave(view, (account) => ({ ...account, maxRpm: value })))).status, 200);
    view = await rpmView(port);
    assert.equal(view.accounts.find((a) => a.id === 'a').maxRpm, value);
    assert.equal(view.accounts.find((a) => a.id === 'a').rpm.limit, value);
    assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).accounts.find((a) => a.id === 'a').maxRpm, value, 'the canonical value is durable');
  }
});

test('concurrency saturation never consumes RPM while the rolling window and its Retry-After stay exact', async (t) => {
  const upstream = controllableUpstream();
  const upstreamPort = await listen(upstream.server), port = await unusedPort();
  const running = await startSwitcher({
    port, upstreamBase: `http://127.0.0.1:${upstreamPort}`,
    accounts: [{ id: 'a', name: 'A', key: 'key-a', enabled: true, maxConcurrent: 1, maxRpm: 2, weight: 1, priority: 1, perModel: {} }],
    accountMode: 'single', activeAccount: 0, concurrencyWaitMs: 30, knownModels: ['m'], perModel: {}, errorRules: [],
  }, null, { NODE_ENV: 'test', CLINE_PASS_TEST_RPM_WINDOW_MS: '4000' });
  t.after(async () => { await stop(running.child); await close(upstream.server); fs.rmSync(running.dir, { recursive: true, force: true }); });
  const body = { model: 'm', messages: [] };

  const held = rawJson(port, '/v1/chat/completions', body);
  await waitUntil(() => upstream.seen.length === 1, 3000, 'the first attempt reaches upstream');
  const blocked = await Promise.all([rawJson(port, '/v1/chat/completions', body), rawJson(port, '/v1/chat/completions', body), rawJson(port, '/v1/chat/completions', body)]);
  assert.ok(blocked.every((response) => response.status === 429), 'concurrency saturation still returns a bounded 429');
  assert.ok(blocked.every((response) => Number(response.headers['retry-after']) >= 1 && Number(response.headers['retry-after']) <= 30), 'the capacity path keeps the bounded 1-30s Retry-After');
  let account = (await rpmView(port)).accounts[0];
  assert.equal(account.activeCount, 1, 'a concurrency-blocked request never leases the account');
  assert.equal(account.rpm.used, 1, 'only the one real committed attempt counts against RPM');
  assert.equal(account.rpm.reserved, 0, 'a concurrency block must not hold an RPM reservation');
  assert.equal(upstream.seen.length, 1, 'a concurrency block creates no upstream attempt');

  upstream.drain();
  assert.equal((await held).status, 200);
  // 释放并发后，此前被并发挡住的请求没有消费 RPM，因此仍可使用完整名额。
  const second = rawJson(port, '/v1/chat/completions', body);
  await waitUntil(() => upstream.seen.length === 2, 3000, 'the retained RPM budget is still usable');
  upstream.drain();
  assert.equal((await second).status, 200);
  account = (await rpmView(port)).accounts[0];
  assert.equal(account.rpm.used, 2);

  // 现在 RPM 才真正耗尽：Retry-After 必须来自最早滚动窗口恢复（4s 窗口），而不是容量等待值（30ms → 1s）。
  const third = await rawJson(port, '/v1/chat/completions', body);
  assert.equal(third.status, 429);
  const retryAfter = Number(third.headers['retry-after']);
  assert.ok(retryAfter >= 3 && retryAfter <= 4, `Retry-After must come from the rolling window, got ${retryAfter}`);
  assert.equal(upstream.seen.length, 2, 'an RPM block never creates an upstream attempt');
  assert.equal((await rpmView(port)).accounts[0].activeCount, 0, 'an RPM-only block must not lease or increment activeCount');
  const rpmRow = await waitUntil(async () => { const page = await (await fetch(`http://127.0.0.1:${port}/api/logs/requests?limit=20`)).json(); return (page.items || []).find((row) => row.errorCategory === 'rpm'); }, 3000, 'local rpm request row');
  assert.equal(rpmRow.blockedBy, 'rpm');
  assert.equal(rpmRow.status, 429);
  assert.equal(rpmRow.result, 'failed');
  assert.equal(rpmRow.upstreamStatus, null, 'selection-time RPM block never fakes an upstream status');
  assert.ok(rpmRow.retryAfter >= 3 && rpmRow.retryAfter <= 4, 'the bounded projection keeps the exact wait');

  await new Promise((resolve) => setTimeout(resolve, 4200));
  const recovered = rawJson(port, '/v1/chat/completions', body);
  await waitUntil(() => upstream.seen.length === 3, 3000, 'the rolling window recovers');
  upstream.drain();
  assert.equal((await recovered).status, 200, 'a 60s-style rolling window recovers without a refill timer');
});

test('provider retries commit one permit per real req.end and stop locally with a truthful local 429', async (t) => {
  const upstream = controllableUpstream();
  const upstreamPort = await listen(upstream.server), port = await unusedPort();
  const route = { upstream: null, upstreams: ['first', 'second', 'third'], exclude: [], pinMode: 'strict', sort: null, maxRetries: null, providerCooldownMs: 0 };
  const running = await startSwitcher({
    port, upstreamBase: `http://127.0.0.1:${upstreamPort}`,
    accounts: [
      { id: 'a', name: 'A', key: 'key-a', enabled: true, maxConcurrent: 0, maxRpm: 1, weight: 1, priority: 1, perModel: {} },
      { id: 'b', name: 'B', key: 'key-b', enabled: true, maxConcurrent: 0, maxRpm: 1, weight: 1, priority: 2, perModel: {} },
    ],
    accountMode: 'roundrobin', activeAccount: 0, concurrencyWaitMs: 0, knownModels: ['m'], perModel: { m: route }, errorRules: [],
  }, null, { NODE_ENV: 'test', CLINE_PASS_TEST_RPM_WINDOW_MS: '4000' });
  t.after(async () => { await stop(running.child); await close(upstream.server); fs.rmSync(running.dir, { recursive: true, force: true }); });

  const pending = rawJson(port, '/v1/chat/completions', { model: 'm', messages: [] });
  await waitUntil(() => upstream.pending.length === 1, 3000, 'the first provider attempt is a real request');
  assert.equal(upstream.pending[0].provider, 'first');
  upstream.drain(() => ({ status: 502, body: { error: { message: 'boom first' } } }));
  const response = await pending;
  assert.equal(response.status, 429, 'the second attempt has no permit and must stop locally');
  const retryAfter = Number(response.headers['retry-after']);
  assert.ok(retryAfter >= 3 && retryAfter <= 4, `the local Retry-After must come from the rolling window, got ${retryAfter}`);
  assert.equal(upstream.seen.length, 1, 'no upstream attempt is fabricated for the local RPM block');
  assert.equal(upstream.seen[0].provider, 'first');

  const log = await waitUntil(async () => { const page = await (await fetch(`http://127.0.0.1:${port}/api/logs/requests?limit=20`)).json(); return (page.items || []).find((row) => row.resolvedModel === 'm' && row.status === 429); }, 3000, 'local rpm request row');
  assert.equal(log.errorCategory, 'rpm', 'the terminal state is local RPM rather than a fake upstream 429');
  assert.equal(log.blockedBy, 'rpm');
  assert.equal(log.upstreamStatus, 502, 'the earlier real upstream failure is preserved as history');
  assert.equal(log.switched, false, 'a local RPM block never switches accounts');
  assert.equal(log.attempts.length, 1);
  assert.equal(log.attempts[0].provider, 'first');
  assert.equal(log.attempts[0].status, 502);

  const errors = await waitUntil(async () => { const page = await (await fetch(`http://127.0.0.1:${port}/api/logs/errors?limit=20`)).json(); return (page.items || []).length ? page : null; }, 3000, 'the real failed attempt keeps its error row');
  assert.equal(errors.items.length, 1, 'only the real upstream attempt produces an error row');
  assert.equal(errors.items[0].targetProvider, 'first');
  assert.equal(errors.items[0].status, 502);

  const view = await rpmView(port);
  assert.deepEqual(view.accounts.map((account) => account.rpm.used).sort(), [0, 1], 'exactly one committed attempt on the leased account');
});

test('a pre-send failure releases the RPM reservation while a post-send failure never refunds', async (t) => {
  const account = { id: 'a', name: 'A', key: 'key-a', enabled: true, maxConcurrent: 0, maxRpm: 1, weight: 1, priority: 1, perModel: {} };
  const config = (upstreamBase) => ({ upstreamBase, accounts: [account], accountMode: 'single', activeAccount: 0, concurrencyWaitMs: 3000, knownModels: ['m'], perModel: {}, errorRules: [] });
  const env = { NODE_ENV: 'test', CLINE_PASS_TEST_RPM_WINDOW_MS: '60000' };

  // 1) 同步失败（URL 非法）：请求从未交给 Node transport，必须立即退还预留并唤醒等待者。
  const port = await unusedPort(), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cps-rpm-presend-'));
  let running = await startSwitcher({ port, ...config('http://127.0.0.1:99999') }, dir, env);
  t.after(async () => { if (running?.child) await stop(running.child); fs.rmSync(dir, { recursive: true, force: true }); });

  const first = await rawJson(port, '/v1/chat/completions', { model: 'm', messages: [] });
  assert.equal(first.status, 502, 'an unroutable transport target is an upstream failure');
  let view = await rpmView(port);
  assert.equal(view.accounts[0].rpm.used, 0, 'a request that never reached req.end must not be committed');
  assert.equal(view.accounts[0].rpm.reserved, 0, 'its reservation is returned');
  const started = Date.now();
  const second = await rawJson(port, '/v1/chat/completions', { model: 'm', messages: [] });
  assert.equal(second.status, 502, 'the released RPM slot is immediately reusable');
  assert.ok(Date.now() - started < 1500, 'the release notifies waiters instead of burning the full capacity deadline');
  await stop(running.child); running.child = null;

  // 2) 发送后的传输失败（connect refused）：请求已交给 transport，绝不退款。
  const deadPort = await unusedPort();
  running = await startSwitcher({ port, ...config(`http://127.0.0.1:${deadPort}`) }, dir, env);
  const sent = await rawJson(port, '/v1/chat/completions', { model: 'm', messages: [] });
  assert.equal(sent.status, 502, 'a connect failure after req.end is a real attempt failure');
  view = await rpmView(port);
  assert.equal(view.accounts[0].rpm.used, 1, 'a post-send failure is never refunded');
  const refused = await rawJson(port, '/v1/chat/completions', { model: 'm', messages: [] });
  assert.equal(refused.status, 429, 'the committed window really blocks the next request');
  assert.equal((await rpmView(port)).accounts[0].rpm.used, 1);
});

test('every account-bound chat caller commits one permit per real native call while catalog, quota and temporary credential tests do not', async (t) => {
  const upstream = controllableUpstream();
  const upstreamPort = await listen(upstream.server), port = await unusedPort(), deadProxyPort = await unusedPort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cps-rpm-callers-'));
  fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify({ models: { 'validate-target': { upstreams: ['v1', 'v2', 'v3'] } }, history: [], accountStates: {}, routingSecret: 'rpm-caller-matrix-secret' }));
  const account = { id: 'a', name: 'A', key: 'key-a', enabled: true, maxConcurrent: 0, maxRpm: 100, weight: 1, priority: 1, perModel: {} };
  const running = await startSwitcher({
    port, upstreamBase: `http://127.0.0.1:${upstreamPort}`, accounts: [account], accountMode: 'single', activeAccount: 0, concurrencyWaitMs: 0,
    knownModels: ['m', 'validate-target'], perModel: { m: { upstream: 'p1', upstreams: ['p1'], exclude: [], pinMode: 'strict', sort: null, maxRetries: 0, providerCooldownMs: 0 } }, errorRules: [],
  }, dir, { NODE_ENV: 'test', CLINE_PASS_TEST_RPM_WINDOW_MS: '60000' });
  t.after(async () => { await stop(running.child); await close(upstream.server); fs.rmSync(dir, { recursive: true, force: true }); });

  const used = async () => (await rpmView(port)).accounts[0].rpm.used;
  const settle = async (count) => { await waitUntil(() => upstream.pending.length >= count, 3000, `upstream attempts >= ${count}`); upstream.drain(); };
  assert.equal(await used(), 0);

  // 非 chat 请求不计：目录（GET /models）与 quota refresh（GET usage-limits）都不持有 chat permit。
  assert.equal((await (await fetch(`http://127.0.0.1:${port}/api/models`)).json()).subscription.length > 0, true);
  assert.equal((await rawJson(port, '/api/statistics/quota-refresh', { force: true })).status, 200);
  assert.equal(await used(), 0, 'catalog and quota traffic never counts against maxRpm');

  // 无持久 accountId 的临时 credential 测试会真实发出请求，但没有配置 owner，因此明确不计。
  const temporary = rawJson(port, '/api/accounts/test', { key: 'temporary-key' });
  await settle(1);
  assert.equal((await temporary).status, 200);
  assert.equal(await used(), 0, 'a temporary credential test reaches upstream yet owns no maxRpm');

  // 绑定已保存 accountId 的 /api/accounts/test 计数。
  const saved = rawJson(port, '/api/accounts/test', { accountId: 'a', key: 'key-a' });
  await settle(1);
  assert.equal((await saved).status, 200);
  assert.equal(await used(), 1, 'a saved-account credential test is a real chat attempt');

  // /api/accounts/proxy-test 计数（即使代理连接失败，请求已交给 transport）。
  assert.equal((await rawJson(port, '/api/accounts/proxy-test', { accountId: 'a', proxyUrl: `http://127.0.0.1:${deadProxyPort}` })).status, 200);
  assert.equal(await used(), 2, 'a saved-account proxy test is a real chat attempt');

  // /api/test 计数。
  const tested = rawJson(port, '/api/test', { model: 'm', accountId: 'a' });
  await settle(1);
  assert.equal((await tested).status, 200);
  assert.equal(await used(), 3);

  // 三个 chat alias 各计数一次。
  for (const path of ['/chat/completions', '/v1/chat/completions', '/api/v1/chat/completions']) {
    const response = rawJson(port, path, { model: 'm', messages: [] });
    await settle(1);
    assert.equal((await response).status, 200, `${path} is a counted chat caller`);
  }
  assert.equal(await used(), 6, 'all three chat aliases commit one permit each');

  // /api/probe 计数（真实 chat attempt）。
  const probed = rawJson(port, '/api/probe', { model: 'm', accountId: 'a' });
  await settle(1);
  assert.equal((await probed).status, 200);
  assert.equal(await used(), 7);

  // /api/validate-upstreams 的并发 batch 共享一个 lease，但每个 native call 各计一次。
  const validated = rawJson(port, '/api/validate-upstreams', { model: 'validate-target', accountId: 'a' });
  await waitUntil(() => upstream.pending.length >= 3, 3000, 'all three validation calls are real requests');
  assert.equal(upstream.pending.length, 3);
  upstream.drain();
  assert.equal((await validated).status, 200);
  assert.equal(await used(), 10, 'each validation batch call commits its own permit');
});

test('RPM-only and mixed blocking never grow the cache pool', async (t) => {
  const upstream = controllableUpstream();
  const upstreamPort = await listen(upstream.server), port = await unusedPort();
  const accounts = ['a', 'b', 'c'].map((id, index) => ({ id, name: id.toUpperCase(), key: `key-${id}`, enabled: true, maxConcurrent: 1, maxRpm: 1, weight: 1, priority: index + 1, perModel: {} }));
  const running = await startSwitcher({
    port, upstreamBase: `http://127.0.0.1:${upstreamPort}`, accounts, accountMode: 'sticky', activeAccount: 0, concurrencyWaitMs: 25,
    knownModels: ['m'], perModel: {}, errorRules: [], accountPipeline: { quotaPool: false, healthSort: false, sticky: false, order: PIPELINE_STEP_ORDER, cachePoolSize: 1, cachePoolMaxSize: 3, sessionBindingExplicitTtlMs: 7200000, sessionBindingFallbackTtlMs: 900000, sessionBindingMaxEntries: 50000 },
  }, null, { NODE_ENV: 'test', CLINE_PASS_TEST_RPM_WINDOW_MS: '60000' });
  t.after(async () => { await stop(running.child); await close(upstream.server); fs.rmSync(running.dir, { recursive: true, force: true }); });

  const held = rawJson(port, '/v1/chat/completions', { model: 'm', messages: [] }, { 'Session-Id': 'rpm-pool-1' });
  await waitUntil(() => upstream.seen.length === 1, 3000, 'the active member is serving one request');
  const blocked = await rawJson(port, '/v1/chat/completions', { model: 'm', messages: [] }, { 'Session-Id': 'rpm-pool-2' });
  assert.equal(blocked.status, 429, 'everything is blocked');
  assert.equal(upstream.seen.length, 1, 'no standby member is promoted for an RPM block');

  const view = await rpmView(port);
  assert.equal(view.cachePool.targetSize, 1, 'RPM blocking must not grow the pool target');
  assert.equal(JSON.parse(fs.readFileSync(path.join(running.dir, 'metadata.json'), 'utf8')).cachePoolTargetSize, 1);
  const row = await waitUntil(async () => { const page = await (await fetch(`http://127.0.0.1:${port}/api/logs/requests?limit=20`)).json(); return (page.items || []).find((item) => item.status === 429); }, 3000, 'blocked request row');
  assert.equal(row.blockedBy, 'mixed', 'an account that is concurrency-full and RPM-exhausted is diagnosable as mixed');

  upstream.drain();
  assert.equal((await held).status, 200);
});

test('an RPM-exhausted standby is never promoted by cache-pool growth', async (t) => {
  const upstream = controllableUpstream();
  const upstreamPort = await listen(upstream.server), port = await unusedPort();
  const accounts = [
    { id: 'a', name: 'A', key: 'key-a', enabled: true, maxConcurrent: 1, maxRpm: 0, weight: 1, priority: 1, perModel: {} },
    { id: 'b', name: 'B', key: 'key-b', enabled: true, maxConcurrent: 1, maxRpm: 1, weight: 1, priority: 2, perModel: {} },
  ];
  const running = await startSwitcher({
    port, upstreamBase: `http://127.0.0.1:${upstreamPort}`, accounts, accountMode: 'sticky', activeAccount: 0, concurrencyWaitMs: 25,
    knownModels: ['m'], perModel: { m: { upstream: 'p', upstreams: ['p'], exclude: [], pinMode: 'strict', sort: null, maxRetries: 0, providerCooldownMs: 0 } }, errorRules: [],
    accountPipeline: { quotaPool: false, healthSort: false, sticky: false, order: PIPELINE_STEP_ORDER, cachePoolSize: 1, cachePoolMaxSize: 3, sessionBindingExplicitTtlMs: 7200000, sessionBindingFallbackTtlMs: 900000, sessionBindingMaxEntries: 50000 },
  }, null, { NODE_ENV: 'test', CLINE_PASS_TEST_RPM_WINDOW_MS: '60000' });
  t.after(async () => { await stop(running.child); await close(upstream.server); fs.rmSync(running.dir, { recursive: true, force: true }); });

  // 备用账号 b 通过绑定已保存 accountId 的 /api/test 用掉自己唯一的 RPM 名额，但仍未进入 active。
  const probed = rawJson(port, '/api/test', { model: 'm', accountId: 'b' });
  await waitUntil(() => upstream.pending.length >= 1, 3000, 'the standby attempt reaches upstream');
  upstream.drain();
  assert.equal((await probed).status, 200);
  let view = await rpmView(port);
  assert.equal(view.cachePool.targetSize, 1, 'the standby stays outside the active pool');
  assert.equal(view.accounts.find((account) => account.id === 'b').rpm.used, 1, 'the standby RPM window is exhausted');

  // active 账号并发满但 RPM 仍有容量：不得为一个 RPM 耗尽的备用账号扩容。
  const held = rawJson(port, '/v1/chat/completions', { model: 'm', messages: [] }, { 'Session-Id': 'rpm-standby-1' });
  await waitUntil(() => upstream.seen.length === 2, 3000, 'the active member is serving');
  const blocked = await rawJson(port, '/v1/chat/completions', { model: 'm', messages: [] }, { 'Session-Id': 'rpm-standby-2' });
  assert.equal(blocked.status, 429);
  view = await rpmView(port);
  assert.equal(view.cachePool.targetSize, 1, 'an RPM-exhausted standby must not be promoted by growth');
  assert.equal(JSON.parse(fs.readFileSync(path.join(running.dir, 'metadata.json'), 'utf8')).cachePoolTargetSize, 1);
  assert.equal(upstream.seen.length, 2, 'the standby is never attempted');
  upstream.drain();
  assert.equal((await held).status, 200);
});

test('RPM windows clear on restart and credential rotation but survive disable/re-enable; zero means unlimited', async (t) => {
  const upstream = controllableUpstream();
  const upstreamPort = await listen(upstream.server), port = await unusedPort(), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cps-rpm-lifecycle-'));
  const account = { id: 'a', name: 'A', key: 'key-a', enabled: true, maxConcurrent: 0, maxRpm: 1, weight: 1, priority: 1, perModel: {} };
  const config = { port, upstreamBase: `http://127.0.0.1:${upstreamPort}`, accounts: [account], accountMode: 'single', activeAccount: 0, concurrencyWaitMs: 0, knownModels: ['m'], perModel: {}, errorRules: [] };
  const env = { NODE_ENV: 'test', CLINE_PASS_TEST_RPM_WINDOW_MS: '60000' };
  let running = await startSwitcher(config, dir, env);
  t.after(async () => { if (running?.child) await stop(running.child); await close(upstream.server); fs.rmSync(dir, { recursive: true, force: true }); });
  const chat = async () => { const promise = rawJson(port, '/v1/chat/completions', { model: 'm', messages: [] }); await waitUntil(() => upstream.pending.length >= 1, 3000, 'upstream attempt'); upstream.drain(); return promise; };
  const save = async (mutate) => { const view = await rpmView(port); return rawJson(port, '/api/accounts', accountSave(view, mutate)); };

  assert.equal((await chat()).status, 200);
  assert.equal((await rpmView(port)).accounts[0].rpm.used, 1);
  assert.equal((await rawJson(port, '/v1/chat/completions', { model: 'm', messages: [] })).status, 429, 'the committed window blocks the next request');

  // 普通 disable/re-enable 不得绕过窗口内已提交事实。
  assert.equal((await save((entry) => ({ ...entry, enabled: false }))).status, 200);
  assert.equal((await rpmView(port)).accounts[0].rpm.used, 1, 'disabling keeps the committed window');
  assert.equal((await save((entry) => ({ ...entry, enabled: true }))).status, 200);
  assert.equal((await rpmView(port)).accounts[0].rpm.used, 1, 're-enabling does not reset the window');
  assert.equal((await rawJson(port, '/v1/chat/completions', { model: 'm', messages: [] })).status, 429);

  // 重启清空：进程内 soft state，不持久化。
  await stop(running.child); running.child = null;
  running = await startSwitcher(null, dir, env);
  assert.equal((await rpmView(port)).accounts[0].rpm.used, 0, 'a restart clears the in-process window');
  assert.equal((await chat()).status, 200, 'the single RPM slot is available again after restart');
  assert.equal((await rpmView(port)).accounts[0].rpm.used, 1);

  // 凭据轮换清理该账号窗口。
  assert.equal((await save((entry) => ({ ...entry, key: 'key-a-rotated' }))).status, 200);
  assert.equal((await rpmView(port)).accounts[0].rpm.used, 0, 'a key rotation clears the old credential window');
  assert.equal((await chat()).status, 200);

  // maxRpm=0 即时关闭限制并清理无用状态。
  assert.equal((await save((entry) => ({ ...entry, maxRpm: 0 }))).status, 200);
  let view = await rpmView(port);
  assert.equal(view.accounts[0].rpm.limit, 0);
  assert.equal(view.accounts[0].rpm.used, 0, 'turning the limit off drops the window');
  for (let i = 0; i < 3; i++) assert.equal((await chat()).status, 200);
  view = await rpmView(port);
  assert.equal(view.accounts[0].rpm.used, 0, 'zero maxRpm keeps no committed state');
  assert.equal(view.accounts[0].rpm.limit, 0);

  // 窗口是进程内状态：既不持久化，也不进入管理投影，因此多副本各自独立。
  const metadata = fs.readFileSync(path.join(dir, 'metadata.json'), 'utf8');
  assert.equal(metadata.includes('rpmWindows'), false, 'the rolling window is never persisted');
  assert.equal(metadata.includes('reservations'), false);
  assert.equal(JSON.stringify(view).includes('timestamps'), false, 'the projection never exposes timestamp arrays');
});

test('initial selection skips an RPM-exhausted candidate in favour of another account', async (t) => {
  const upstream = controllableUpstream();
  const upstreamPort = await listen(upstream.server), port = await unusedPort();
  const running = await startSwitcher({
    port, upstreamBase: `http://127.0.0.1:${upstreamPort}`,
    accounts: [
      { id: 'a', name: 'A', key: 'key-a', enabled: true, maxConcurrent: 0, maxRpm: 1, weight: 1, priority: 1, perModel: {} },
      { id: 'b', name: 'B', key: 'key-b', enabled: true, maxConcurrent: 0, maxRpm: 0, weight: 1, priority: 2, perModel: {} },
    ],
    accountMode: 'roundrobin', activeAccount: 0, concurrencyWaitMs: 0, knownModels: ['m'], perModel: {}, errorRules: [],
  }, null, { NODE_ENV: 'test', CLINE_PASS_TEST_RPM_WINDOW_MS: '60000' });
  t.after(async () => { await stop(running.child); await close(upstream.server); fs.rmSync(running.dir, { recursive: true, force: true }); });
  const call = async () => {
    const promise = rawJson(port, '/v1/chat/completions', { model: 'm', messages: [] });
    await waitUntil(() => upstream.pending.length >= 1, 3000, 'upstream attempt');
    upstream.drain();
    return promise;
  };

  const first = await call();
  assert.equal(first.status, 200);
  assert.equal(first.headers['x-cline-account'], 'A', 'the first round-robin slot is account A');
  assert.equal((await rpmView(port)).accounts.find((account) => account.id === 'a').rpm.used, 1);
  assert.equal((await call()).status, 200);
  // 轮询重新排到 A，但 A 的窗口已耗尽：必须跳过到仍有额度的 B，而不是返回 429。
  const third = await call();
  assert.equal(third.status, 200);
  assert.equal(third.headers['x-cline-account'], 'B');
  const view = await rpmView(port);
  assert.equal(view.accounts.find((account) => account.id === 'a').rpm.used, 1, 'the skipped candidate is not charged');
  assert.equal(view.accounts.find((account) => account.id === 'b').rpm.limit, 0);
});

test('a client cancellation after the attempt started never refunds RPM', async (t) => {
  const opened = [];
  const upstream = http.createServer((req, res) => {
    if (req.method === 'GET') { res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end('{}'); }
    req.resume(); req.on('end', () => opened.push(res));
  });
  const upstreamPort = await listen(upstream), port = await unusedPort();
  const running = await startSwitcher({
    port, upstreamBase: `http://127.0.0.1:${upstreamPort}`,
    accounts: [{ id: 'a', name: 'A', key: 'key-a', enabled: true, maxConcurrent: 0, maxRpm: 1, weight: 1, priority: 1, perModel: {} }],
    accountMode: 'single', activeAccount: 0, concurrencyWaitMs: 0, knownModels: ['m'], perModel: {}, errorRules: [],
  }, null, { NODE_ENV: 'test', CLINE_PASS_TEST_RPM_WINDOW_MS: '60000' });
  t.after(async () => { await stop(running.child); await close(upstream); fs.rmSync(running.dir, { recursive: true, force: true }); });

  const streaming = new Promise((resolve) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
      res.on('data', (chunk) => { if (chunk.toString().includes('data:')) { req.destroy(); resolve(); } });
    });
    req.on('error', () => resolve());
    req.end(JSON.stringify({ model: 'm', messages: [], stream: true }));
  });
  await waitUntil(() => opened.length === 1, 3000, 'the stream attempt reached upstream');
  opened[0].writeHead(200, { 'Content-Type': 'text/event-stream' });
  opened[0].write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'hi' } }] })}\n\n`);
  await streaming;

  const settled = await waitUntil(async () => { const account = (await rpmView(port)).accounts[0]; return account.activeCount === 0 && account.rpm.used === 1 ? account : null; }, 3000, 'the cancelled stream releases concurrency without refunding RPM');
  assert.equal(settled.rpm.used, 1, 'cancellation after req.end never refunds the commit');
  assert.equal(settled.rpm.reserved, 0);
  opened[0].destroy();
  assert.equal((await rawJson(port, '/v1/chat/completions', { model: 'm', messages: [] })).status, 429, 'the committed window still blocks the next request');
});

test('HTTP/1.1 inbound idle reuse crosses five seconds and direct outbound connections are pooled', async (t) => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    seen.push(req.socket.remotePort);
    req.resume(); req.on('end', () => res.end('{"choices":[{"message":{"content":"ok"}}]}'));
  });
  upstream.keepAliveTimeout = 9_000;
  const upstreamPort = await listen(upstream);
  const port = await unusedPort();
  const running = await startSwitcher({ port, upstreamBase: `http://127.0.0.1:${upstreamPort}`, accounts: [{ id: 'a', name: 'A', key: 'test', enabled: true }], knownModels: ['m'] }, null, { NODE_ENV: 'test', CLINE_PASS_TEST_INBOUND_KEEP_ALIVE_MS: '8500' });
  const client = new http.Agent({ keepAlive: true, maxSockets: 1 });
  t.after(async () => { client.destroy(); await stop(running.child); await close(upstream); fs.rmSync(running.dir, { recursive: true, force: true }); });
  const send = () => new Promise((resolve, reject) => {
    const data = JSON.stringify({ model: 'm', messages: [] });
    const req = http.request({ host: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST', agent: client, headers: { 'Content-Length': Buffer.byteLength(data) } }, (res) => {
      const localPort = req.socket.localPort;
      res.resume(); res.on('end', () => resolve({ status: res.statusCode, localPort }));
    });
    req.on('error', reject); req.end(data);
  });
  const first = await send();
  await new Promise((resolve) => setTimeout(resolve, 5200));
  const second = await send();
  assert.equal(first.status, 200); assert.equal(second.status, 200);
  assert.equal(first.localPort, second.localPort, 'New API-style idle client reuses the inbound socket');
  assert.equal(seen.length, 2); assert.equal(seen[0], seen[1], 'direct upstream HTTP socket reused');
});

test('persisted HTTP CONNECT tunnels reuse while proxy-test draft tunnels are destroyed', async (t) => {
  let connects = 0, hits = 0, closed = 0;
  const tunnels = new Set();
  const upstream = http.createServer((req, res) => { hits++; req.resume(); req.on('end', () => res.end('{"choices":[]}')); });
  const upstreamPort = await listen(upstream);
  const proxy = http.createServer();
  proxy.on('connect', (req, client, head) => {
    connects++; tunnels.add(client); client.on('close', () => closed++);
    const target = net.connect(upstreamPort, '127.0.0.1', () => {
      tunnels.add(target); client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) target.write(head); target.pipe(client); client.pipe(target);
    });
    target.on('error', () => client.destroy());
  });
  const proxyPort = await listen(proxy), port = await unusedPort();
  const proxyUrl = `http://127.0.0.1:${proxyPort}`;
  const running = await startSwitcher({ port, upstreamBase: `http://127.0.0.1:${upstreamPort}`, accounts: [{ id: 'a', name: 'A', key: 'test', enabled: true, proxyUrl }], knownModels: ['m'] });
  t.after(async () => { await stop(running.child); for (const socket of tunnels) socket.destroy(); await close(proxy); await close(upstream); fs.rmSync(running.dir, { recursive: true, force: true }); });
  const chat = () => rawJson(port, '/v1/chat/completions', { model: 'm', messages: [] });
  assert.equal((await chat()).status, 200); assert.equal((await chat()).status, 200);
  assert.equal(connects, 1, 'persisted HTTP proxy tunnel is pooled');
  for (let i = 0; i < 3; i++) {
    const testUrl = `http://user${i}:draft${i}@127.0.0.1:${proxyPort}`;
    const result = await rawJson(port, '/api/accounts/proxy-test', { accountId: 'a', proxyUrl: testUrl });
    assert.equal(result.json.ok, true);
    await waitUntil(() => closed >= i + 1, 3000, 'draft tunnel destroyed after response settles');
  }
  assert.equal(connects, 4);
  assert.equal((await chat()).status, 200); assert.equal(connects, 4, 'draft overrides did not evict or enter the persisted pool');
  assert.equal(hits, 6);
  const accounts = (await (await fetch(`http://127.0.0.1:${port}/api/accounts`)).json()).accounts;
  accounts[0].proxyUrl = '';
  assert.equal((await rawJson(port, '/api/accounts', { accounts, mode: 'single', active: 0, concurrencyWaitMs: 0, errorRules: [] })).status, 200);
  await waitUntil(() => closed >= 4, 3000, 'saved proxy rotation destroys the stale idle tunnel');
});

test('direct HTTPS upstream reuses a TLS socket', async (t) => {
  const certPath = path.resolve('test/fixtures/proxy-cert.pem');
  const tlsOptions = { key: fs.readFileSync(path.resolve('test/fixtures/proxy-key.pem')), cert: fs.readFileSync(certPath) };
  const ports = [];
  const upstream = https.createServer(tlsOptions, (req, res) => { ports.push(req.socket.remotePort); req.resume(); req.on('end', () => res.end('{"choices":[]}')); });
  const upstreamPort = await listen(upstream), port = await unusedPort();
  const running = await startSwitcher({ port, upstreamBase: `https://127.0.0.1:${upstreamPort}`, accounts: [{ id: 'a', name: 'A', key: 'test', enabled: true }], knownModels: ['m'] }, null, { NODE_EXTRA_CA_CERTS: certPath });
  t.after(async () => { await stop(running.child); upstream.closeAllConnections?.(); await close(upstream); fs.rmSync(running.dir, { recursive: true, force: true }); });
  for (let i = 0; i < 2; i++) assert.equal((await rawJson(port, '/v1/chat/completions', { model: 'm', messages: [] })).status, 200);
  assert.equal(ports.length, 2); assert.equal(ports[0], ports[1]);
});

test('production heartbeat env uses bounded milliseconds and ignores test-only overrides', async (t) => {
  const upstream = http.createServer((req, res) => {
    req.resume(); req.on('end', () => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write('data: {}\n\n'); setTimeout(() => res.end('data: [DONE]\n\n'), 300); });
  });
  const upstreamPort = await listen(upstream), port = await unusedPort();
  const running = await startSwitcher({ port, upstreamBase: `http://127.0.0.1:${upstreamPort}`, accounts: [{ id: 'a', name: 'A', key: 'test', enabled: true }], knownModels: ['m'] }, null, { NODE_ENV: 'production', CLINE_PASS_SSE_HEARTBEAT_MS: '80', CLINE_PASS_TEST_SSE_HEARTBEAT_MS: '0' });
  t.after(async () => { await stop(running.child); await close(upstream); fs.rmSync(running.dir, { recursive: true, force: true }); });
  const text = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST' }, (res) => {
      let body = ''; res.on('data', (chunk) => { body += chunk.toString(); }); res.on('end', () => resolve(body)); res.on('error', reject);
    });
    req.on('error', reject); req.end(JSON.stringify({ model: 'm', messages: [], stream: true }));
  });
  assert.match(text, /: PING\n\n/); assert.match(text, /data: \[DONE\]/);
});

test('SSE downstream write(false) waits for drain and never fabricates a cancelled request', async (t) => {
  const upstream = http.createServer((req, res) => {
    req.resume(); req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"choices":[]}\n\n');
      setTimeout(() => { for (let i = 0; i < 24; i++) res.write(`data: ${'x'.repeat(32_000)}\n\n`); res.end('data: [DONE]\n\n'); }, 180);
    });
  });
  const upstreamPort = await listen(upstream), port = await unusedPort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cps-backpressure-'));
  const loader = path.join(dir, 'observe-write.mjs');
  fs.writeFileSync(loader, "import http from 'node:http'; const write=http.ServerResponse.prototype.write; http.ServerResponse.prototype.write=function(...args){const ok=write.apply(this,args); if(!ok && String(this.getHeader('content-type')).includes('text/event-stream')) console.error('TEST_BACKPRESSURE_FALSE'); return ok;};");
  const running = await startSwitcher({ port, upstreamBase: `http://127.0.0.1:${upstreamPort}`, accounts: [{ id: 'a', name: 'A', key: 'test', enabled: true, maxConcurrent: 1 }], knownModels: ['m'] }, dir, { NODE_ENV: 'test', NODE_OPTIONS: `--import=${loader}`, CLINE_PASS_TEST_SSE_HEARTBEAT_MS: '70', CLINE_PASS_TEST_SSE_STREAM_IDLE_MS: '1500' });
  t.after(async () => { await stop(running.child); upstream.closeAllConnections?.(); await close(upstream); fs.rmSync(dir, { recursive: true, force: true }); });
  const body = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST' }, (res) => {
      let text = ''; res.on('data', (c) => { text += c.toString(); });
      res.pause(); setTimeout(() => res.resume(), 400);
      res.on('end', () => resolve({ status: res.statusCode, text })); res.on('error', reject);
    });
    req.on('error', reject); req.end(JSON.stringify({ model: 'm', messages: [], stream: true }));
  });
  assert.equal(body.status, 200); assert.match(body.text, /data: \[DONE\]/);
  await waitUntil(() => running.output().includes('TEST_BACKPRESSURE_FALSE'), 3000, 'res.write returned false');
  const rows = await waitForRequestLogs(port, 1);
  assert.equal(rows.length, 1); assert.equal(rows[0].result, 'success'); assert.equal(rows[0].status, 200);
  const account = (await (await fetch(`http://127.0.0.1:${port}/api/accounts`)).json()).accounts[0];
  assert.equal(account.activeCount, 0);
});

test('comment-only SSE head over 64 KiB closes an unfinished upstream before the first-event deadline', async (t) => {
  let upstreamClosed = false;
  const upstream = http.createServer((req, res) => {
    req.resume(); req.on('end', () => {
      res.on('close', () => { upstreamClosed = true; });
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`: ${'x'.repeat(65_536)}\n\n`); // Intentionally never end the response.
    });
  });
  const upstreamPort = await listen(upstream), port = await unusedPort();
  const running = await startSwitcher({ port, upstreamBase: `http://127.0.0.1:${upstreamPort}`, accounts: [{ id: 'a', name: 'A', key: 'test', enabled: true, maxConcurrent: 1 }], knownModels: ['m'] }, null, { NODE_ENV: 'test', CLINE_PASS_TEST_SSE_FIRST_EVENT_MS: '2500' });
  t.after(async () => { await stop(running.child); upstream.closeAllConnections?.(); await close(upstream); fs.rmSync(running.dir, { recursive: true, force: true }); });
  const started = Date.now();
  const result = await rawJson(port, '/v1/chat/completions', { model: 'm', messages: [], stream: true });
  assert.equal(result.status, 502); assert.doesNotMatch(result.text, /: x/);
  assert.ok(Date.now() - started < 1500, 'rejected head must not wait for the 2500ms first-event deadline');
  await waitUntil(() => upstreamClosed, 800, 'rejected SSE head closes the native response');
  const accounts = (await (await fetch(`http://127.0.0.1:${port}/api/accounts`)).json()).accounts;
  assert.equal(accounts[0].activeCount, 0);
});

test('SSE prelude, first-data deadline, heartbeat, upstream idle and finalizers are independent', async (t) => {
  const hits = [];
  const upstream = http.createServer((req, res) => {
    const chunks = []; req.on('data', (chunk) => chunks.push(chunk)); req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const model = body.model, provider = body.provider?.only?.[0] || body.providerOptions?.gateway?.only?.[0];
      hits.push({ model, provider });
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (model === 'cap') return res.end(`: ${'x'.repeat(65536)}\n\n`);
      if (model === 'deadline') { res.write(': PING\n\n'); return; }
      if (model === 'fallback' && provider === 'first') return res.end(': PING\n\nevent: error\ndata: {"error":{"message":"bad","status":429}}\n\n');
      if (model === 'coalesced') return res.end(': PRELUDE\n\ndata: {"choices":[]}\n\ndata: [DONE]\n\n');
      res.write(': PRELUDE\n\nevent: message\nid: 7\n\n');
      res.write('data: {"choices":[{"delta":{"content":"first"}}]}\n\n');
      if (model === 'idle') return;
      if (model === 'fragmented') {
        res.write('data: {"choices":[{"delta":{"content":"');
        return setTimeout(() => res.end('later"}}]}\n\ndata: [DONE]\n\n'), 300);
      }
      setTimeout(() => res.end('data: {"usage":{"prompt_tokens":2,"completion_tokens":0}}\n\ndata: [DONE]\n\n'), 360);
    });
  });
  const upstreamPort = await listen(upstream), port = await unusedPort();
  const running = await startSwitcher({ port, upstreamBase: `http://127.0.0.1:${upstreamPort}`, accounts: [{ id: 'a', name: 'A', key: 'test', enabled: true, maxConcurrent: 1, maxRpm: 20 }], knownModels: ['ok', 'idle', 'deadline', 'cap', 'fallback', 'fragmented', 'coalesced'], perModel: { fallback: { upstreams: ['first', 'second'] } } }, null, { NODE_ENV: 'test', CLINE_PASS_TEST_SSE_FIRST_EVENT_MS: '500', CLINE_PASS_TEST_SSE_STREAM_IDLE_MS: '900', CLINE_PASS_TEST_SSE_HEARTBEAT_MS: '75' });
  t.after(async () => { await stop(running.child); upstream.closeAllConnections?.(); await close(upstream); fs.rmSync(running.dir, { recursive: true, force: true }); });
  const stream = (model) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST' }, (res) => {
      let text = '', pendingLine = '', idleResets = 0, pingAfterData = 0, scannerExpired = false, scannerTimer;
      const dataEvents = [];
      const snapshot = (aborted = false) => ({ status: res.statusCode, text, idleResets, pingAfterData, scannerExpired, dataEvents, aborted });
      res.on('data', (c) => {
        text += c.toString(); pendingLine += c.toString();
        let end;
        while ((end = pendingLine.indexOf('\n')) !== -1) {
          const line = pendingLine.slice(0, end).replace(/\r$/, ''); pendingLine = pendingLine.slice(end + 1);
          // New API resets its scanner idle window on each line, before filtering comments.
          idleResets++;
          if (model === 'ok') {
            clearTimeout(scannerTimer);
            scannerTimer = setTimeout(() => { scannerExpired = true; }, 250);
          }
          if (line === ': PING' && dataEvents.length) pingAfterData++;
          if (line.startsWith('data:')) dataEvents.push(line.slice(5).trim());
        }
      });
      res.on('end', () => { clearTimeout(scannerTimer); resolve(snapshot()); });
      res.on('error', () => { clearTimeout(scannerTimer); resolve(snapshot(true)); });
    });
    req.on('error', reject); req.end(JSON.stringify({ model, messages: [], stream: true }));
  });
  const ok = await stream('ok');
  assert.equal(ok.status, 200); assert.match(ok.text, /^: PRELUDE\n\nevent: message\nid: 7\n\ndata: /);
  assert.match(ok.text, /data: \{"choices":.*\}\n\n(?:\: PING\n\n)+data: \{"usage"/); assert.match(ok.text, /data: \[DONE\]/);
  assert.equal(ok.dataEvents.length, 3, 'New API-equivalent scanner ignores comments as model chunks');
  assert.ok(ok.pingAfterData > 0); assert.equal(ok.scannerExpired, false, 'comment lines reset the 250ms scanner idle window during the 360ms pause');
  const cap = await stream('cap'); assert.equal(cap.status, 502); assert.doesNotMatch(cap.text, /: x/);
  const deadline = await stream('deadline'); assert.equal(deadline.status, 502); assert.doesNotMatch(deadline.text, /: PING/);
  const idle = await stream('idle'); assert.equal(idle.status, 200); assert.equal(idle.aborted, true);
  assert.match(idle.text, /: PING/); assert.doesNotMatch(idle.text, /\[DONE\]/);
  const coalesced = await stream('coalesced');
  assert.equal(coalesced.status, 200); assert.equal(coalesced.text, ': PRELUDE\n\ndata: {"choices":[]}\n\ndata: [DONE]\n\n', 'unshift preserves multiple events in one source chunk');
  const fragmented = await stream('fragmented');
  assert.equal(fragmented.status, 200); assert.match(fragmented.text, /data: \{"choices":\[\{"delta":\{"content":"later"\}\}\]\}\n\n/);
  assert.equal(fragmented.text.split(': PING').length - 1, 0, 'no heartbeat can split an unfinished upstream SSE data line');
  const fallback = await stream('fallback'); assert.equal(fallback.status, 200);
  assert.match(fallback.text, /data: \[DONE\]/); assert.doesNotMatch(fallback.text, /"message":"bad"/);
  assert.deepEqual(hits.filter((hit) => hit.model === 'fallback').map((hit) => hit.provider), ['first', 'second']);
  const rows = await waitForRequestLogs(port, 7);
  for (const model of ['ok', 'idle', 'deadline', 'cap', 'fallback', 'fragmented', 'coalesced']) assert.equal(rows.filter((row) => row.requestedModel === model).length, 1);
  assert.equal(rows.find((row) => row.requestedModel === 'idle').result, 'failed');
  assert.equal(rows.find((row) => row.requestedModel === 'ok').status, 200);
  assert.equal(rows.find((row) => row.requestedModel === 'ok').attempts.length, 1);
  assert.equal(rows.find((row) => row.requestedModel === 'fallback').attempts.length, 2);
  const statistics = await (await fetch(`http://127.0.0.1:${port}/api/statistics`)).json();
  assert.equal(statistics.lifetime.global.requests, 7);
  assert.equal(statistics.lifetime.global.usageRequests, 2, 'only explicit upstream usage, never heartbeat, is counted');
  const accounts = await (await fetch(`http://127.0.0.1:${port}/api/accounts`)).json();
  assert.equal(accounts.accounts[0].activeCount, 0); assert.equal(accounts.accounts[0].rpm.used, 8);
  assert.equal(hits.length, 8);
});

test('raw body setting is refused without runtime memory readiness and preserves config bytes', async (t) => {
  const port = await unusedPort();
  const running = await startSwitcher({ port, detailedLogging: true, accounts: [], knownModels: [] }, null, { NODE_ENV: 'test', CLINE_PASS_RAW_BODY_READY: '1', CLINE_PASS_TEST_RAW_MEMORY_BYTES: String(512 * 1024 * 1024) });
  t.after(async () => { await stop(running.child); fs.rmSync(running.dir, { recursive: true, force: true }); });
  const settings = await (await fetch(`http://127.0.0.1:${port}/api/logs/settings`)).json();
  assert.equal(settings.rawBodyAvailable, false);
  assert.equal(settings.maxSanitizedPayloadBytes, 64 * 1024 * 1024);
  assert.equal(settings.maxPayloadBytes, 512 * 1024 * 1024);
  const before = fs.readFileSync(path.join(running.dir, 'config.json'));
  assert.equal((await rawJson(port, '/api/logs/settings', { rawBodyLogging: true })).status, 409);
  assert.deepEqual(fs.readFileSync(path.join(running.dir, 'config.json')), before);
  assert.equal((await rawJson(port, '/api/logs/settings', { errorDetailLogging: true })).status, 200);
  assert.equal((await (await fetch(`http://127.0.0.1:${port}/api/logs/settings`)).json()).rawBodyLogging, false);
});

test('raw body mode is explicit, admin-only and never projects Header or body into ordinary diagnostics', async (t) => {
  const upstream = http.createServer((req, res) => {
    let body = ''; req.on('data', (chunk) => { body += chunk; }); req.on('end', () => {
      res.setHeader('Content-Type', 'application/json'); res.setHeader('X-Fixture-Header', 'fixture-header-secret');
      res.end(JSON.stringify({ data: { choices: [{ message: { content: 'fixture-response-secret' } }] }, echo: body.includes('fixture-body-secret') ? 'accepted' : 'missing' }));
    });
  });
  const upstreamPort = await listen(upstream), port = await unusedPort();
  const running = await startSwitcher({ port, upstreamBase: `http://127.0.0.1:${upstreamPort}`, proxyKey: 'fixture-client-key', detailedLogging: true, accounts: [{ id: 'a', name: 'Fixture', key: 'fixture-upstream-key', enabled: true, perModel: {} }], knownModels: ['raw-fixture'], perModel: {} }, null, { NODE_ENV: 'test', CLINE_PASS_RAW_BODY_READY: '1', CLINE_PASS_TEST_RAW_MEMORY_BYTES: String(2 * 1024 * 1024 * 1024) });
  t.after(async () => { await stop(running.child); await close(upstream); fs.rmSync(running.dir, { recursive: true, force: true }); });
  const api = (route, options = {}) => fetch(`http://127.0.0.1:${port}${route}`, options);
  const clientOnly = { Authorization: 'Bearer fixture-client-key', 'X-Admin-Key': 'fixture-client-key' };
  const chat = () => rawJson(port, '/v1/chat/completions', { model: 'raw-fixture', messages: [{ role: 'user', content: 'fixture-body-secret' }] }, clientOnly);
  const first = await chat(); assert.equal(first.status, 200);
  const firstId = first.headers['x-cline-request-id'];
  await waitUntil(async () => (await (await api('/api/logs/details')).json()).items.some((row) => row.requestId === firstId && row.state !== 'open'));
  const old = await (await api(`/api/logs/details/${firstId}`)).json(); assert.equal(old.request.profile, 'full');
  assert.equal(old.bodies.every((body) => body.redacted === true), true);
  for (const route of ['/api/logs/settings', '/api/logs/details', `/api/logs/details/${firstId}`, `/api/logs/details/${firstId}/bodies/${old.bodies[0].bodyId}`]) {
    assert.equal((await bareFetch(`http://127.0.0.1:${port}${route}`, { headers: clientOnly })).status, 401);
    assert.equal((await bareFetch(`http://127.0.0.1:${port}${route}`, { headers: { ...clientOnly, Origin: 'https://attacker.invalid' } })).status, 401);
  }
  const settingsBefore = fs.readFileSync(path.join(running.dir, 'config.json'));
  assert.equal((await rawJson(port, '/api/logs/settings', { rawBodyLogging: 'true' })).status, 400);
  assert.deepEqual(fs.readFileSync(path.join(running.dir, 'config.json')), settingsBefore);
  const settings = await rawJson(port, '/api/logs/settings', { rawBodyLogging: true }); assert.equal(settings.status, 200);
  assert.equal(settings.json.rawBodyLogging, true); assert.equal(settings.json.maxPayloadBytes, undefined);
  const projection = await (await api('/api/logs/settings')).json(); assert.equal(projection.rawBodyAvailable, true); assert.equal(projection.rawMaxBodyBytes, 35 * 1024 * 1024); assert.equal(projection.maxPayloadBytes, 512 * 1024 * 1024); assert.equal(projection.maxSanitizedPayloadBytes, 64 * 1024 * 1024);
  const second = await chat(); assert.equal(second.status, first.status); assert.equal(second.text, first.text);
  const secondId = second.headers['x-cline-request-id'];
  await waitUntil(async () => (await (await api('/api/logs/details')).json()).items.some((row) => row.requestId === secondId && row.state !== 'open'));
  const listing = await (await api('/api/logs/details')).json();
  const row = listing.items.find((item) => item.requestId === secondId); assert.equal(row.profile, 'raw-full');
  const group = await (await api(`/api/logs/details/${secondId}`)).json();
  assert.equal(group.request.profile, 'raw-full'); assert.equal(group.bodies.every((body) => body.redacted === false), true);
  const content = await api(`/api/logs/details/${secondId}/bodies/${group.request.requestBody}`);
  assert.equal(content.headers.get('cache-control'), 'no-store'); assert.equal(content.headers.get('x-content-type-options'), 'nosniff');
  assert.match(await content.text(), /fixture-body-secret/);
  const metadata = JSON.stringify({ listing, request: group.request, attempts: group.attempts });
  assert.doesNotMatch(metadata, /fixture-body-secret|fixture-response-secret|fixture-header-secret|fixture-upstream-key/);
  const ordinary = fs.readFileSync(path.join(running.dir, 'metadata.json'), 'utf8') + fs.readdirSync(path.join(running.dir, 'logs')).map((file) => fs.readFileSync(path.join(running.dir, 'logs', file), 'utf8')).join('');
  assert.doesNotMatch(ordinary, /fixture-body-secret|fixture-response-secret|fixture-header-secret/);
  assert.doesNotMatch(running.output(), /fixture-body-secret|fixture-response-secret|fixture-header-secret/);
  assert.equal((await (await api(`/api/logs/details/${firstId}`)).json()).request.profile, 'full');
  assert.equal((await fs.promises.readdir(path.join(running.dir, 'detailed-logs', 'raw'))).length, 1);
});
