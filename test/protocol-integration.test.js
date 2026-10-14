import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { prepareAdminFixture, connectAdminFixture, fixtureHeaders, installFixtureFetch } from './admin-fixture.js';
installFixtureFetch();

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = (server) => new Promise((resolve) => server.close(resolve));
async function unusedPort() { const holder = http.createServer(); const port = await listen(holder); await close(holder); return port; }

function rawJson(port, pathname, body, headers = {}, { skipAdmin = false } = {}) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request({
      hostname: '127.0.0.1', port, path: pathname, method: 'POST',
      headers: skipAdmin ? { 'Content-Type': 'application/json', 'Content-Length': data.length, ...headers } : fixtureHeaders(port, pathname, 'POST', { 'Content-Type': 'application/json', 'Content-Length': data.length, ...headers }),
    }, (res) => {
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

function rawStream(port, pathname, body, headers = {}, { abortAfter = null } = {}) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request({
      hostname: '127.0.0.1', port, path: pathname, method: 'POST',
      headers: fixtureHeaders(port, pathname, 'POST', { 'Content-Type': 'application/json', 'Content-Length': data.length, ...headers }),
    }, (res) => {
      let text = '';
      res.on('data', (c) => {
        text += c.toString();
        if (abortAfter && text.includes(abortAfter)) { req.destroy(); resolve({ status: res.statusCode, headers: res.headers, text, aborted: true }); }
      });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text, aborted: false }));
    });
    req.on('error', (error) => { if (error.code === 'ECONNRESET') resolve({ status: 0, headers: {}, text: '', aborted: true }); else reject(error); });
    req.end(data);
  });
}

async function startSwitcher(config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cps-protocol-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config));
  prepareAdminFixture(dir);
  const child = spawn(process.execPath, ['server.js'], { cwd: path.resolve('.'), env: { ...process.env, DATA_DIR: dir, BIND_HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (c) => { output += c; }); child.stderr.on('data', (c) => { output += c; });
  await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(`switcher startup timeout: ${output}`)), 5000);
    const poll = setInterval(() => { if (output.includes('OpenAI 兼容代理地址')) { clearInterval(poll); clearTimeout(deadline); resolve(); } }, 20);
    child.once('exit', (code) => { clearInterval(poll); clearTimeout(deadline); reject(new Error(`switcher exited ${code}: ${output}`)); });
  });
  await connectAdminFixture(config.port);
  return { dir, child };
}
const stop = (child) => new Promise((resolve) => { child.once('exit', resolve); child.kill('SIGTERM'); setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 1000).unref(); });
async function waitUntil(check, timeoutMs = 5000, label = 'condition') {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`condition timeout: ${label}`);
}

function parseSse(text) {
  const events = [];
  for (const chunk of text.split('\n\n')) {
    if (!chunk.trim() || chunk.startsWith(':')) continue;
    const type = (chunk.match(/^event: (.+)$/m) || [])[1];
    const dataLine = chunk.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
    if (!dataLine) continue;
    let data; try { data = JSON.parse(dataLine); } catch { continue; }
    events.push({ type: type || data.type, data });
  }
  return events;
}

test('three inbound protocols share one Chat upstream with protocol-shaped IO', async (t) => {
  const seen = [];
  let streamPending = [];
  const mock = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) { res.statusCode = 404; return res.end('{}'); }
      const body = JSON.parse(Buffer.concat(chunks).toString());
      seen.push({ auth: req.headers.authorization, apiKey: req.headers['x-api-key'], body });
      if (body.model === 'pre-fail' && seen.filter((item) => item.body.model === 'pre-fail').length === 1) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'account failed', status: 500 } }));
      }
      if (body.model === 'busy' && seen.filter((item) => item.body.model === 'busy').length === 1) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'supplier limited', status: 429 } }));
      }
      if (body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        if (body.model === 'post-error') {
          res.write('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n');
          return setTimeout(() => res.end('data: {"error":{"message":"late fail","status":500}}\n\n'), 5);
        }
        if (body.model === 'drop') {
          res.write('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n');
          return setTimeout(() => res.destroy(), 5);
        }
        if (body.model === 'truncated') {
          res.write('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n');
          return setTimeout(() => res.end(), 5);
        }
        if (body.model === 'hold') {
          res.write('data: {"choices":[{"delta":{"content":"started"}}]}\n\n');
          streamPending.push(res);
          return;
        }
        res.write('data: {"choices":[{"delta":{"reasoning_content":"why "}}]}\n\n');
        res.write('data: {"choices":[{"delta":{"content":"OK"}}]}\n\n');
        return res.end('data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":8,"completion_tokens":2,"total_tokens":10}}\n\ndata: [DONE]\n\n');
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ finish_reason: 'stop', message: { content: 'OK', reasoning_content: 'why' } }],
        usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 },
      }));
    });
  });
  const upstreamPort = await listen(mock);
  const port = await unusedPort();
  const running = await startSwitcher({
    port, upstreamBase: `http://127.0.0.1:${upstreamPort}`, accountMode: 'roundrobin', concurrencyWaitMs: 0,
    proxyKey: 'protocol-client-key',
    accounts: [
      { id: 'a', name: 'A', key: 'key-a', enabled: true, maxConcurrent: 0, perModel: {} },
      { id: 'b', name: 'B', key: 'key-b', enabled: true, maxConcurrent: 0, perModel: {} },
    ],
    knownModels: ['ok', 'pre-fail', 'busy', 'post-error', 'drop', 'truncated', 'hold', 'cline-pass/glm-5.2'],
    perModel: { 'pre-fail': { upstreams: ['one'], pinMode: 'strict' }, busy: { upstreams: ['one', 'two'], pinMode: 'strict' } },
    errorRules: [{ id: 'ban-500', scope: 'account', action: 'hard-quarantine', when: { statuses: [500], body_contains: ['account failed'] } }],
  });
  t.after(async () => { for (const res of streamPending) try { res.end(); } catch {} await stop(running.child); await close(mock); fs.rmSync(running.dir, { recursive: true, force: true }); });
  const auth = { Authorization: 'Bearer protocol-client-key' };

  const chat = await rawJson(port, '/v1/chat/completions', { model: 'ok', messages: [{ role: 'user', content: 'hi' }] }, auth);
  assert.equal(chat.status, 200);
  assert.equal(chat.json.choices[0].message.content, 'OK');

  const responses = await rawJson(port, '/v1/responses', { model: 'ok', input: 'hi', include: ['reasoning.encrypted_content'] }, auth);
  assert.equal(responses.status, 200);
  assert.equal(responses.json.object, 'response');
  assert.equal(responses.json.output[0].type, 'reasoning');
  assert.equal(responses.json.output[1].content[0].text, 'OK');
  assert.equal(responses.json.usage.input_tokens, 8);
  assert.equal(seen.at(-1).body.messages[0].content, 'hi');
  assert.match(seen.at(-1).auth, /^Bearer key-[ab]$/);

  const anthropic = await rawJson(port, '/v1/messages', { model: 'ok', messages: [{ role: 'user', content: 'hi' }], max_tokens: 32 }, auth);
  assert.equal(anthropic.status, 200);
  assert.equal(anthropic.json.type, 'message');
  assert.equal(anthropic.json.content[1].text, 'OK');
  assert.equal(anthropic.json.stop_reason, 'end_turn');

  const chatStream = await rawStream(port, '/v1/chat/completions', { model: 'ok', stream: true, messages: [{ role: 'user', content: 'hi' }] }, auth);
  assert.match(chatStream.text, /data: \[DONE\]/);

  const responsesStream = await rawStream(port, '/v1/responses', { model: 'ok', stream: true, input: 'hi' }, auth);
  const responseEvents = parseSse(responsesStream.text);
  assert.equal(responseEvents[0].type, 'response.created');
  assert.equal(responseEvents.at(-1).type, 'response.completed');
  assert.ok(responseEvents.at(-1).data.response.output.length);

  const anthropicStream = await rawStream(port, '/v1/messages', { model: 'ok', stream: true, messages: [{ role: 'user', content: 'hi' }], max_tokens: 16 }, auth);
  const anthropicEvents = parseSse(anthropicStream.text);
  assert.equal(anthropicEvents[0].type, 'message_start');
  assert.equal(anthropicEvents.at(-1).type, 'message_stop');

  const beforeFail = seen.length;
  const switched = await rawJson(port, '/v1/responses', { model: 'pre-fail', input: 'switch' }, auth);
  assert.equal(switched.status, 200);
  assert.ok(seen.length >= beforeFail + 2);
  assert.equal(seen.at(-1).auth, 'Bearer key-b');

  const retried = await rawJson(port, '/v1/messages', { model: 'busy', messages: [{ role: 'user', content: 'retry' }] }, auth);
  assert.equal(retried.status, 200);

  const post = await rawStream(port, '/v1/responses', { model: 'post-error', stream: true, input: 'late' }, auth);
  assert.ok(parseSse(post.text).some((event) => event.type === 'response.failed'), post.text);
  const postAnthropic = await rawStream(port, '/v1/messages', { model: 'post-error', stream: true, messages: [{ role: 'user', content: 'late' }], max_tokens: 16 }, auth);
  assert.ok(parseSse(postAnthropic.text).some((event) => event.type === 'error'), postAnthropic.text);
  const dropped = await rawStream(port, '/v1/responses', { model: 'drop', stream: true, input: 'late' }, auth);
  assert.ok(parseSse(dropped.text).some((event) => event.type === 'response.failed'), dropped.text);
  const truncated = await rawStream(port, '/v1/responses', { model: 'truncated', stream: true, input: 'cut' }, auth);
  assert.ok(parseSse(truncated.text).some((event) => event.type === 'response.failed'), truncated.text);
  const truncatedLog = await waitUntil(async () => {
    const page = await (await fetch(`http://127.0.0.1:${port}/api/logs/requests?requestedModel=truncated&limit=5`)).json();
    return page.items?.[0];
  }, 5000, 'truncated protocol stream logged');
  assert.equal(truncatedLog.result, 'failed');

  const holdBefore = seen.length;
  const cancelled = rawStream(port, '/v1/messages', { model: 'hold', stream: true, messages: [{ role: 'user', content: 'hold' }] }, auth, { abortAfter: 'started' });
  await waitUntil(() => streamPending.length > 0, 3000, 'held stream');
  const cancelResult = await cancelled;
  assert.equal(cancelResult.aborted, true);
  await waitUntil(async () => {
    const page = await (await fetch(`http://127.0.0.1:${port}/api/logs/requests?requestedModel=hold&limit=5`)).json();
    return page.items?.[0]?.result === 'client_cancelled' && page.items;
  }, 5000, 'cancelled protocol request logged');
  assert.equal(seen.length, holdBefore + 1);

  const beforeReject = seen.length;
  for (const [route, body] of [
    ['/v1/responses', { model: 'ok', previous_response_id: 'resp_x' }],
    ['/v1/responses', { model: 'ok', store: true, input: 'x' }],
    ['/v1/responses', { model: 'ok', tools: [{ type: 'web_search' }], input: 'x' }],
    ['/v1/responses', { model: 'ok', input: [{ type: 'message', role: 'user', content: [{ type: 'input_file', file_id: 'file_1' }] }] }],
    ['/v1/messages', { model: 'ok', messages: [{ role: 'user', content: [{ type: 'document', source: { type: 'text', data: 'x' } }] }] }],
    ['/v1/messages', { model: 'ok', messages: [], tools: [{ type: 'web_search_20250305', name: 'web_search' }] }],
  ]) {
    const rejected = await rawJson(port, route, body, auth);
    assert.equal(rejected.status, 400, route);
    if (route === '/v1/messages') assert.equal(rejected.json.type, 'error');
    else assert.equal(rejected.json.error.type, 'invalid_request_error');
  }
  assert.equal(seen.length, beforeReject, 'rejected protocol requests must not call upstream');

  const unauth = await rawJson(port, '/v1/messages', { model: 'ok', messages: [{ role: 'user', content: 'x' }] }, {}, { skipAdmin: true });
  assert.equal(unauth.status, 401);
  assert.equal(unauth.json.type, 'error');
  assert.equal(unauth.json.error.type, 'authentication_error');

  const xApi = await rawJson(port, '/v1/messages', { model: 'ok', messages: [{ role: 'user', content: 'key' }] }, { 'x-api-key': 'protocol-client-key' });
  assert.equal(xApi.status, 200);
  const ignoredOnChat = await rawJson(port, '/v1/chat/completions', { model: 'ok', messages: [{ role: 'user', content: 'nope' }] }, { 'x-api-key': 'protocol-client-key' }, { skipAdmin: true });
  assert.equal(ignoredOnChat.status, 401);
  const ignoredOnResponses = await rawJson(port, '/v1/responses', { model: 'ok', input: 'nope' }, { 'x-api-key': 'protocol-client-key' }, { skipAdmin: true });
  assert.equal(ignoredOnResponses.status, 401);
  const conflict = await rawJson(port, '/v1/messages', { model: 'ok', messages: [{ role: 'user', content: 'x' }] }, { Authorization: 'Bearer protocol-client-key', 'x-api-key': 'other-key' });
  assert.equal(conflict.status, 401);

  const beforeCount = seen.length;
  const counted = await rawJson(port, '/v1/messages/count_tokens', { model: 'ok', messages: [{ role: 'user', content: 'hello world' }] }, auth);
  assert.equal(counted.status, 200);
  assert.equal(typeof counted.json.input_tokens, 'number');
  assert.ok(counted.json.input_tokens >= 1);
  assert.equal(seen.length, beforeCount);

  const logs = await waitUntil(async () => {
    const page = await (await fetch(`http://127.0.0.1:${port}/api/logs/requests?limit=200`)).json();
    const items = page.items || [];
    return items.some((item) => item.inboundProtocol === 'responses') && items.some((item) => item.inboundProtocol === 'anthropic') && items.some((item) => item.inboundProtocol === 'chat') && items;
  }, 5000, 'inboundProtocol on request logs');
  assert.ok(logs.every((item) => ['chat', 'responses', 'anthropic'].includes(item.inboundProtocol)));
  assert.equal(JSON.stringify(logs).includes('hello world'), false);
  const filtered = await (await fetch(`http://127.0.0.1:${port}/api/logs/requests?inboundProtocol=anthropic&limit=200`)).json();
  assert.ok(filtered.items.length > 0);
  assert.ok(filtered.items.every((item) => item.inboundProtocol === 'anthropic'));
  const stats = await (await fetch(`http://127.0.0.1:${port}/api/statistics`)).json();
  assert.ok(stats.lifetime.global.requests >= 3);
  const accounts = (await (await fetch(`http://127.0.0.1:${port}/api/accounts`)).json()).accounts;
  assert.ok(accounts.every((account) => account.activeCount === 0));
});
