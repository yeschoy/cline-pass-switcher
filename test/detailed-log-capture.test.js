import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { BodyCapture, CaptureBudget, captureBudget, DetailRedactor, MAX_BODY_BYTES, MAX_PAYLOAD_BYTES, MAX_SANITIZED_PAYLOAD_BYTES, observeStream, detailRoute, DetailRoot } from '../lib/detailed-log-capture.js';
import { DetailedLogStore, DETAIL_DROP_REASONS } from '../lib/detailed-log-store.js';

const mockDropHealth = () => ({ dropped: 0, dropReasons: Object.fromEntries(DETAIL_DROP_REASONS.map((reason) => [reason, 0])) });

function capture(chunks, redactor = new DetailRedactor(), options = {}, complete = true) {
  const body = new BodyCapture(options);
  for (const chunk of chunks) body.add(chunk);
  if (complete) body.end();
  const result = body.materialize(redactor); body.release(); return result;
}

test('detail redaction preserves ordinary JSON/headers and removes known, escaped, ephemeral and cookie credentials', () => {
  const redactor = new DetailRedactor(['saved-secret']);
  const headers = redactor.headers({ AUTHORIZATION: 'Bearer admin-secret', Cookie: 'a=cookie-secret; b=second-secret', 'X-API-Key': 'ephemeral-secret', 'X-Ordinary': 'ordinary value' });
  assert.equal(headers['X-Ordinary'], 'ordinary value');
  const value = { messages: [{ content: 'keep my prompt https://example.org/normal' }], key: 'test-secret', proxyUrl: 'http://user:proxy-password@localhost:8080', echo: 'saved-secret admin-secret cookie-secret second-secret ephemeral-secret test-secret proxy-password' };
  const text = JSON.stringify(value).replace('test-secret', '\\u0074est-secret');
  const result = capture([text.slice(0, 21), text.slice(21)], redactor);
  assert.equal(result.descriptor.state, 'complete');
  for (const secret of ['saved-secret', 'admin-secret', 'cookie-secret', 'second-secret', 'ephemeral-secret', 'test-secret', 'proxy-password']) assert.equal(result.text.includes(secret), false, secret);
  assert.match(result.text, /keep my prompt https:\/\/example.org\/normal/);
});

test('fragmented SSE sanitizes whole event values before any output, including later discovered credentials', () => {
  const text = 'data: {"echo":"stream-secret","text":"你好"}\r\n\r\ndata: {"api_key":"stream-secret"}\r\n\r\ndata: [DONE]\r\n\r\n';
  const bytes = Buffer.from(text);
  const result = capture([...bytes].map((byte) => Buffer.from([byte])));
  assert.equal(result.descriptor.state, 'complete'); assert.match(result.text, /你好/); assert.match(result.text, /\[DONE\]/); assert.doesNotMatch(result.text, /stream-secret/);
});

const structuredCredentials = [
  { names: ['authorization', 'AUTHORIZATION', 'proxy_authorization', 'Proxy.Authorization'], value: 'Bearer json-bearer-secret', secrets: ['json-bearer-secret'] },
  { names: ['authorization', 'Proxy-Authorization', 'proxyAuthorization'], value: 'Basic ' + Buffer.from('json-basic-user:json-basic-password').toString('base64'), secrets: ['json-basic-user', 'json-basic-password', Buffer.from('json-basic-user:json-basic-password').toString('base64')] },
  { names: ['cookie', 'COOKIE', 'x_cookie'], value: 'a=json-cookie-secret; b=json-second-cookie', secrets: ['json-cookie-secret', 'json-second-cookie'] },
  { names: ['Set-Cookie', 'set_cookie', 'setCookie', 'SET.COOKIE', 'x set cookie'], value: 'session=json-set-cookie; Path=/ordinary-path; Domain=example.org; Max-Age=12; SameSite=Lax; Secure', secrets: ['json-set-cookie'] },
  { names: ['Cookie', 'COOKIE', 'x_cookie'], value: 'session="quoted-cookie-secret"; other="second-quoted-cookie"', secrets: ['quoted-cookie-secret', 'second-quoted-cookie'] },
  { names: ['Set-Cookie', 'set_cookie', 'setCookie', 'SET.COOKIE', 'x set cookie'], value: 'session="quoted-set-cookie-secret"; Path=/ordinary-path; Domain=example.org; Max-Age=12; SameSite=Lax; Secure', secrets: ['quoted-set-cookie-secret'] }
];
const ordinaryFields = { message: 'ordinary prompt /ordinary-path example.org Lax', max_tokens: 12, usage: { prompt_tokens: 12, completion_tokens: 0, total_tokens: 12 } };

test('quoted Cookie and Set-Cookie headers learn raw and valid dequoted components, not attributes', () => {
  for (const { names, value, secrets } of structuredCredentials.slice(-2)) for (const name of names) for (const field of [value, [value]]) {
    const redactor = new DetailRedactor();
    const headers = redactor.headers({ 'x-earlier': secrets.join(' '), [name]: field, 'x-ordinary': ordinaryFields.message });
    const output = redactor.body(JSON.stringify({ echo: secrets.join(' '), ...ordinaryFields }));
    for (const secret of secrets) {
      assert.equal(JSON.stringify(headers).includes(secret), false, name);
      assert.equal(output.includes(secret), false, name);
      assert.equal(redactor.secrets.has(secret), true);
      assert.equal(redactor.secrets.has('"' + secret + '"'), true, 'retain raw-value learning');
    }
    assert.equal(headers['x-ordinary'], ordinaryFields.message);
    for (const attribute of ['/ordinary-path', 'example.org', '12', 'Lax']) assert.equal(redactor.secrets.has(attribute), false);
  }
});

test('structured JSON credentials redact component echoes before and after normalized fields without learning cookie attributes', () => {
  for (const { names, value, secrets } of structuredCredentials) for (const name of names) for (const field of [value, { nested: [value] }]) {
    const redactor = new DetailRedactor();
    const output = JSON.parse(redactor.body(JSON.stringify({ earlier: secrets.join(' '), [name]: field, later: secrets.join(' '), ...ordinaryFields })));
    for (const secret of secrets) assert.equal(JSON.stringify(output).includes(secret), false, `${name}: ${secret}`);
    assert.equal(output[name], '[REDACTED]');
    for (const [key, v] of Object.entries(ordinaryFields)) assert.deepEqual(output[key], v);
    for (const attribute of ['/ordinary-path', 'example.org', '12', 'Lax']) assert.equal(redactor.secrets.has(attribute), false, attribute);
  }
});

test('fragmented SSE discovers structured credential components before earlier events and retains ordinary fields and DONE', () => {
  for (const { names, value, secrets } of structuredCredentials) for (const name of names) {
    const text = `data: ${JSON.stringify({ echo: secrets.join(' '), ...ordinaryFields })}\r\n\r\ndata: ${JSON.stringify({ [name]: value })}\r\n\r\ndata: ${JSON.stringify({ echo: secrets.join(' ') })}\r\n\r\ndata: [DONE]\r\n\r\n`;
    const result = capture([...Buffer.from(text)].map((byte) => Buffer.from([byte])));
    assert.equal(result.descriptor.state, 'complete');
    for (const secret of secrets) assert.equal(result.text.includes(secret), false, `${name}: ${secret}`);
    const events = result.text.trim().split('\n\n'); assert.equal(events.length, 4); assert.equal(events[3], 'data: [DONE]');
    const first = JSON.parse(events[0].slice(6));
    for (const [key, v] of Object.entries(ordinaryFields)) assert.deepEqual(first[key], v);
  }
});

test('group prepass discovers structured response credentials before earlier bodies and header echoes', () => {
  const secrets = structuredCredentials.flatMap((fixture) => fixture.secrets), echo = secrets.join(' ');
  const req = Object.assign(new EventEmitter(), { method: 'POST', url: '/v1/chat/completions', headers: { 'x-echo': echo } });
  const res = Object.assign(new EventEmitter(), { write() {}, end() {}, writeHead() {}, getHeaders() { return {}; } });
  let group;
  const store = { generation: 0, health: mockDropHealth(), recordDrop: DetailedLogStore.prototype.recordDrop, open: async () => true, failure() { assert.fail('unexpected store failure'); },
    publish({ produce, release }) { group = produce(); release(); return Promise.resolve(true); } };
  const root = new DetailRoot(req, res, store);
  root.input.add(JSON.stringify({ echo, ...ordinaryFields })); root.input.end();
  root.output.add('ordinary output ' + echo); root.output.end(); root.responseHeaders = { 'x-echo': echo };
  const attempt = root.attempt({ url: 'https://example.org/chat/completions', headers: { 'x-echo': echo }, body: JSON.stringify({ echo, ...ordinaryFields }) });
  attempt.responseHeaders = { 'x-echo': echo };
  attempt.output.add('data: ' + JSON.stringify({ echo }) + '\n\n' + structuredCredentials.flatMap(({ names, value }) => names.map((name) => 'data: ' + JSON.stringify({ [name]: value }) + '\n\n')).join('') + 'data: [DONE]\n\n');
  attempt.output.end(); root.finalize();
  for (const secret of secrets) assert.equal(JSON.stringify(group).includes(secret), false, secret);
  assert.ok(group.bodies.every((body) => body.descriptor.state === 'complete'));
  for (const index of [0, 2]) for (const [key, value] of Object.entries(ordinaryFields)) assert.deepEqual(JSON.parse(group.bodies[index].text)[key], value);
  assert.match(group.bodies[1].text, /ordinary output/); assert.match(group.bodies[3].text, /\[DONE\]/);
});

test('error profile retains only failed response diagnostics with caller-owned attempt identity', () => {
  const requestId = randomUUID(), callId = randomUUID();
  const req = Object.assign(new EventEmitter(), { method: 'POST', url: '/v1/chat/completions', headers: { authorization: 'Bearer ingress-secret' } });
  const res = Object.assign(new EventEmitter(), { write() {}, end() {}, writeHead() {}, getHeaders() { return {}; } });
  let group = null, opened = false;
  const store = {
    generation: 0,
    health: mockDropHealth(), recordDrop: DetailedLogStore.prototype.recordDrop,
    open() { opened = true; return Promise.resolve(true); },
    failure() { assert.fail('unexpected store failure'); },
    publish({ produce, release }) { group = produce(); release(); return Promise.resolve(true); },
  };
  const before = captureBudget.used, active = DetailRoot.active;
  const root = new DetailRoot(req, res, store, ['account-secret'], { profile: 'error', requestId });
  assert.equal(opened, false); assert.equal(root.input, undefined); assert.equal(root.output, undefined);
  const success = root.attempt({
    token: { attemptIndex: 0, callId: randomUUID() },
    url: 'https://example.test/chat/completions', account: { id: 'a', name: 'A', key: 'account-secret' },
    headers: { authorization: 'Bearer account-secret' }, body: JSON.stringify({ model: 'm', messages: [{ content: 'large success prompt' }] }), model: 'm', provider: ['first'],
  });
  root.settleAttempt(success, { failed: false, httpStatus: 200, outcomeStatus: 200, captureState: 'success' });
  const failed = root.attempt({
    token: { attemptIndex: 1, callId },
    url: 'https://example.test/chat/completions', account: { id: 'b', name: 'B', key: 'account-secret' },
    headers: { authorization: 'Bearer account-secret' }, body: JSON.stringify({ model: 'm', api_key: 'ephemeral-secret' }), model: 'm', provider: ['second'],
  });
  root.settleAttempt(failed, {
    failed: true,
    httpStatus: 200,
    outcomeStatus: 502,
    responseHeaders: { 'content-type': 'application/json', 'x-echo': 'ephemeral-secret' },
    responseBody: JSON.stringify({ error: { message: 'failed ephemeral-secret' } }),
    responseComplete: true,
    captureState: 'response-error',
  });
  assert.equal(failed.requestSource, undefined);
  root.result = 'failed'; root.status = 502; root.finalize();
  assert.equal(group.request.profile, 'error'); assert.equal(group.request.requestId, requestId);
  assert.equal(group.request.requestBody, undefined); assert.equal(group.request.responseBody, undefined); assert.equal(group.request.headers, undefined);
  assert.equal(group.attempts.length, 1); assert.equal(group.attempts[0].attemptIndex, 1); assert.equal(group.attempts[0].callId, callId);
  assert.equal(group.attempts[0].httpStatus, 200); assert.equal(group.attempts[0].outcomeStatus, 502); assert.equal(group.attempts[0].captureState, 'response-error');
  assert.equal(group.bodies.length, 1); assert.equal(group.attempts[0].responseBody, group.bodies[0].descriptor.bodyId);
  assert.doesNotMatch(JSON.stringify(group), /account-secret|ephemeral-secret|large success prompt/);
  assert.equal(captureBudget.used, before); assert.equal(DetailRoot.active, active);
});

test('error profile successful 50 MiB request holds no BodyCapture reservation or publication', () => {
  const req = Object.assign(new EventEmitter(), { method: 'POST', url: '/v1/chat/completions', headers: {} });
  const res = Object.assign(new EventEmitter(), { write() {}, end() {}, writeHead() {}, getHeaders() { return {}; } });
  let publications = 0;
  const store = { generation: 0, health: mockDropHealth(), recordDrop: DetailedLogStore.prototype.recordDrop, open() { assert.fail('error profile must not open'); }, failure() { assert.fail('unexpected failure'); }, publish() { publications++; return Promise.resolve(true); } };
  const before = captureBudget.used, payload = 'x'.repeat(50 * 1024 * 1024);
  const root = new DetailRoot(req, res, store, [], { profile: 'error' });
  const attempt = root.attempt({ token: { attemptIndex: 0, callId: randomUUID() }, url: 'https://example.test/chat/completions', body: payload, model: 'm', provider: [] });
  root.settleAttempt(attempt, { failed: false, httpStatus: 200, outcomeStatus: 200, captureState: 'success' }); root.finalize();
  assert.equal(captureBudget.used, before); assert.equal(publications, 0); assert.equal(attempt.input, undefined); assert.equal(attempt.output, undefined); assert.equal(attempt.requestSource, undefined);
});

test('clear generation drops an error collector source before any late settlement', () => {
  const req = Object.assign(new EventEmitter(), { method: 'POST', url: '/v1/chat/completions', headers: {} });
  const res = Object.assign(new EventEmitter(), { write() {}, end() {}, writeHead() {}, getHeaders() { return {}; } });
  let publications = 0;
  const store = { generation: 0, health: mockDropHealth(), recordDrop: DetailedLogStore.prototype.recordDrop, open() { assert.fail('error profile must not open'); }, failure() { assert.fail('unexpected failure'); }, publish() { publications++; return Promise.resolve(true); } };
  const root = new DetailRoot(req, res, store, [], { profile: 'error' });
  const attempt = root.attempt({ token: { attemptIndex: 0, callId: randomUUID() }, url: 'https://example.test/chat/completions', body: 'x'.repeat(1024 * 1024), model: 'm', provider: [] });
  store.generation++;
  assert.equal(root.settleAttempt(attempt, { failed: true, captureState: 'no-response' }), false);
  assert.equal(attempt.requestSource, undefined); root.finalize(); assert.equal(publications, 0);
});

test('resource-limited error request discovery fences response echoes group-wide', () => {
  const req = Object.assign(new EventEmitter(), { method: 'POST', url: '/v1/chat/completions', headers: {} });
  const res = Object.assign(new EventEmitter(), { write() {}, end() {}, writeHead() {}, getHeaders() { return {}; } });
  let group;
  const store = { generation: 0, health: mockDropHealth(), recordDrop: DetailedLogStore.prototype.recordDrop, open() { assert.fail('error profile must not open'); }, failure() { assert.fail('unexpected failure'); }, publish({ produce, release }) { group = produce(); release(); return Promise.resolve(true); } };
  const held = MAX_SANITIZED_PAYLOAD_BYTES - 128;
  assert.equal(captureBudget.reserve(held), true);
  try {
    const root = new DetailRoot(req, res, store, [], { profile: 'error' });
    const attempt = root.attempt({ token: { attemptIndex: 0, callId: randomUUID() }, url: 'https://example.test/chat/completions', body: JSON.stringify({ api_key: 'request-only-secret', padding: 'x'.repeat(200) }), model: 'm', provider: [] });
    root.settleAttempt(attempt, { failed: true, httpStatus: 500, outcomeStatus: 500, responseHeaders: { 'content-type': 'application/json' }, responseBody: JSON.stringify({ echo: 'request-only-secret' }), captureState: 'response-error' });
    root.finalize();
    assert.equal(group.request.state, 'resource-limited');
    assert.equal(group.bodies[0].descriptor.state, 'resource-limited'); assert.equal(group.bodies[0].text, '');
    assert.equal(JSON.stringify(group).includes('request-only-secret'), false);
  } finally { captureBudget.release(held); }
});

test('5 MiB minus/exact/plus retain safe prefixes while removing credential fragments', () => {
  for (const size of [MAX_BODY_BYTES - 1, MAX_BODY_BYTES, MAX_BODY_BYTES + 1]) {
    const result = capture([Buffer.alloc(size, 0x61)]);
    assert.equal(result.descriptor.observedBytes, size);
    assert.equal(result.descriptor.truncated, size > MAX_BODY_BYTES);
    assert.equal(result.descriptor.capturedBytes, Math.min(size, MAX_BODY_BYTES));
  }
  for (const text of ['{"api_key":"abcdefghi"}', 'password=abcdefghi']) {
    const result = capture([text], new DetailRedactor(), { limit: Buffer.byteLength(text) - 3 });
    assert.equal(result.text, ''); assert.equal(result.descriptor.state, 'omitted-for-safety'); assert.equal(result.descriptor.truncated, true);
  }
  const utf8 = capture(['aaaa你好'], new DetailRedactor(), { limit: Buffer.byteLength('aaaa你好') - 1 });
  assert.equal(utf8.text, 'aaaa你'); assert.equal(utf8.descriptor.omittedTailBytes, 2);
  const sse = capture(['data: {"text":"safe event"}\n\ndata: {"key":"secret'], new DetailRedactor(), {}, false);
  assert.equal(sse.text, ''); assert.equal(sse.descriptor.state, 'omitted-for-safety');
  const safeSse = capture(['data: {"text":"safe event"}\n\ndata: {"message":"ordinary partial'], new DetailRedactor(), {}, false);
  assert.match(safeSse.text, /safe event/); assert.ok(safeSse.descriptor.omittedTailBytes > 0);
});

test('partial credential discovery fails closed for JSON/SSE and text at every cap or interruption inside a value', () => {
  const secret = 'sk-demo-secret-capture';
  const values = [
    JSON.stringify({ echo: secret, api_key: secret }),
    JSON.stringify({ echo: secret, Cookie: `session="${secret}"` }),
    JSON.stringify({ echo: secret, setCookie: { nested: [`session="${secret}"; Path=/ordinary-path`] } }),
    JSON.stringify({ echo: secret, proxyAuthorization: 'Bearer ' + secret }),
    JSON.stringify({ echo: secret, password: 123456789 }),
    `ordinary ${secret} password=${secret}`,
    `ordinary ${secret} Bearer ${secret}`,
    `ordinary ${secret} https://example.org/?api_key=${secret}`,
    JSON.stringify({ echo: secret, message: 'password=' + secret })
  ];
  for (const value of values) for (const sse of value.startsWith('{') ? [false, true] : [false]) {
    const text = sse ? `data: ${JSON.stringify({ echo: secret })}\n\ndata: ${value}\n\ndata: [DONE]\n\n` : value;
    const component = value.includes('123456789') ? '123456789' : secret;
    const start = text.lastIndexOf(component);
    for (let cut = start + 1; cut < start + component.length; cut++) for (const complete of [false, true]) {
      const result = capture([complete ? text : text.slice(0, cut)], new DetailRedactor(), complete ? { limit: cut } : {}, complete);
      assert.equal(result.text, '', `${sse ? 'SSE' : 'text/JSON'} at ${cut}: ${value}`);
      assert.equal(result.descriptor.state, 'omitted-for-safety');
      assert.equal(result.descriptor.complete, complete); assert.equal(result.descriptor.truncated, complete);
      for (const forbidden of [secret, 'demo-secret-capture', 'secret-capture', component.slice(1)]) assert.equal(result.text.includes(forbidden), false);
    }
  }
  for (const text of ['{"echo":"visible","api_key":"known-value","message":"safe ordinary prefix', '{"echo":"visible","message":"safe ordinary prefix']) {
    const result = capture([text], new DetailRedactor(), {}, false);
    assert.equal(JSON.parse(result.text).message, 'safe ordinary prefix');
  }
});

test('partial non-JSON SSE data discovers unfinished credentials before earlier events and group echoes', () => {
  const secret = 'sk-demo-secret-capture';
  for (const value of [`Bearer ${secret}`, `password=${secret}`, `https://example.org/?api_key=${secret}`]) {
    const text = `data: ${JSON.stringify({ echo: secret })}\n\ndata: ${value}\n\n`;
    const start = text.lastIndexOf(secret);
    for (let cut = start + 1; cut < start + secret.length; cut++) for (const complete of [false, true]) {
      const redactor = new DetailRedactor(), earlier = new BodyCapture(), tail = new BodyCapture(complete ? { limit: cut } : {});
      earlier.add(JSON.stringify({ echo: secret })); earlier.end();
      tail.add(complete ? text : text.slice(0, cut)); if (complete) tail.end();
      for (const body of [earlier, tail]) body.learn(redactor);
      for (const body of [earlier, tail]) {
        const output = body.materialize(redactor);
        assert.equal(output.text, ''); assert.equal(output.descriptor.state, 'omitted-for-safety'); body.release();
      }
      assert.doesNotMatch(JSON.stringify(redactor.headers({ 'x-echo': secret })), /sk-demo-secret-capture|demo-secret-capture/);
    }
  }
  const safe = capture(['data: {"message":"keep completed event"}\n\ndata: ordinary unfinished prose'], new DetailRedactor(), {}, false);
  assert.equal(safe.descriptor.state, 'interrupted'); assert.match(safe.text, /keep completed event/); assert.doesNotMatch(safe.text, /unfinished prose/);
});

test('uncertain credential discovery suppresses earlier headers and every group body without changing stream forwarding', async () => {
  const secret = 'sk-demo-secret-capture';
  for (const [field, limit] of [['api_key', 47], ['Cookie', 56]]) for (const sse of [false, true]) for (const complete of [false, true]) {
    const json = JSON.stringify({ echo: secret, [field]: field === 'Cookie' ? `session="${secret}"` : secret });
    const head = sse ? `data: ${JSON.stringify({ echo: secret })}\n\ndata: ` : '';
    const text = head + json + (sse ? '\n\ndata: [DONE]\n\n' : '');
    const cut = head.length + limit;
    const req = Object.assign(new EventEmitter(), { method: 'POST', url: '/v1/chat/completions', headers: { 'x-echo': secret } });
    const res = Object.assign(new EventEmitter(), { write() {}, end() {}, writeHead() {}, getHeaders() { return {}; } });
    let group;
    const store = { generation: 0, health: mockDropHealth(), recordDrop: DetailedLogStore.prototype.recordDrop, open: async () => true, failure() { assert.fail('unexpected failure'); },
      publish({ produce, release }) { group = produce(); release(); return Promise.resolve(true); } };
    const root = new DetailRoot(req, res, store);
    root.input.add(JSON.stringify({ echo: secret })); root.input.end(); root.output.add(secret); root.output.end();
    root.responseHeaders = { 'x-echo': secret }; root.model = secret;
    for (let i = 0; i < 2; i++) {
      const attempt = root.attempt({ url: 'https://example.org/chat/completions', headers: { 'x-echo': secret }, body: JSON.stringify({ echo: secret }) });
      attempt.responseHeaders = { 'x-echo': secret };
      if (i === 0) { attempt.output.add(JSON.stringify({ echo: secret })); attempt.output.end(); continue; }
      if (complete) attempt.output.limit = cut;
      const wire = Buffer.from(complete ? text : text.slice(0, cut)), chunks = [];
      for await (const chunk of observeStream(Readable.from([...wire].map((byte) => Buffer.from([byte]))), attempt.output)) chunks.push(chunk);
      assert.deepEqual(Buffer.concat(chunks), wire, 'logging must not alter forwarded bytes');
      if (!complete) attempt.output.complete = false;
    }
    root.finalize();
    assert.equal(group.request.state, 'incomplete'); assert.equal(group.bodies.length, 6);
    assert.ok(group.bodies.every((body) => body.text === '' && body.descriptor.state === 'omitted-for-safety'));
    for (const forbidden of [secret, 'demo-secret-capture', 'secret-capture']) assert.equal(JSON.stringify(group).includes(forbidden), false);
    for (const headers of [group.request.headers, group.request.responseHeaders, ...group.attempts.flatMap((a) => [a.headers, a.responseHeaders])]) assert.match(JSON.stringify(headers), /OMITTED/);
  }
});

test('complete ordinary escaped text remains visible across a detailed group', () => {
  const ordinary = 'ordinary code \\u0061 and \\x61';
  const req = Object.assign(new EventEmitter(), { method: 'POST', url: '/v1/chat/completions', headers: { 'x-ordinary': ordinary } });
  const res = Object.assign(new EventEmitter(), { write() {}, end() {}, writeHead() {}, getHeaders() { return {}; } });
  let group;
  const store = { generation: 0, health: mockDropHealth(), recordDrop: DetailedLogStore.prototype.recordDrop, open: async () => true, failure() { assert.fail('unexpected failure'); },
    publish({ produce, release }) { group = produce(); release(); return Promise.resolve(true); } };
  const root = new DetailRoot(req, res, store);
  const payload = JSON.stringify({ model: 'demo', messages: [{ role: 'user', content: ordinary }] });
  root.input.add(payload); root.input.end(); root.output.add(JSON.stringify({ message: ordinary })); root.output.end();
  root.responseHeaders = { 'x-ordinary': ordinary };
  const attempt = root.attempt({ url: 'https://example.org/chat/completions', headers: { 'x-ordinary': ordinary }, body: payload });
  attempt.responseHeaders = { 'x-ordinary': ordinary }; attempt.output.add(JSON.stringify({ message: ordinary })); attempt.output.end();
  root.finalize();
  assert.equal(group.request.state, 'complete');
  assert.ok(group.bodies.every((body) => body.descriptor.state === 'complete' && body.descriptor.capturedBytes > 0));
  assert.equal(JSON.parse(group.bodies[0].text).messages[0].content, ordinary);
  assert.equal(JSON.parse(group.bodies[1].text).message, ordinary);
  assert.equal(JSON.parse(group.bodies[2].text).messages[0].content, ordinary);
  assert.equal(JSON.parse(group.bodies[3].text).message, ordinary);
  for (const headers of [group.request.headers, group.request.responseHeaders, group.attempts[0].headers, group.attempts[0].responseHeaders]) assert.equal(headers['x-ordinary'], ordinary);
});

test('escaped credentials redact decoded echoes without blanking the detailed group', () => {
  const secret = 'fixture-escaped-secret';
  for (const escaped of ['\\u0066ixture-escaped-secret', '\\x66ixture-escaped-secret']) for (const location of ['header', 'json', 'sse']) {
    const req = Object.assign(new EventEmitter(), { method: 'POST', url: '/v1/chat/completions', headers: { 'x-echo': secret } });
    const res = Object.assign(new EventEmitter(), { write() {}, end() {}, writeHead() {}, getHeaders() { return {}; } });
    let group;
    const store = { generation: 0, health: mockDropHealth(), recordDrop: DetailedLogStore.prototype.recordDrop, open: async () => true, failure() { assert.fail('unexpected failure'); },
      publish({ produce, release }) { group = produce(); release(); return Promise.resolve(true); } };
    const root = new DetailRoot(req, res, store);
    root.input.add(JSON.stringify({ echo: secret })); root.input.end(); root.output.add(secret); root.output.end();
    root.responseHeaders = { 'x-echo': secret }; root.model = secret;
    const attempt = root.attempt({ url: 'https://example.org/chat/completions', headers: { 'x-echo': secret }, body: JSON.stringify({ echo: secret }) });
    attempt.responseHeaders = { 'x-echo': secret, ...(location === 'header' ? { 'x-diagnostic': 'password=' + escaped } : {}) };
    const payload = JSON.stringify({ nested: { message: 'password=' + escaped } });
    attempt.output.add(location === 'header' ? secret : location === 'sse' ? 'data: ' + payload + '\n\ndata: [DONE]\n\n' : payload); attempt.output.end();
    root.finalize();
    assert.equal(group.request.state, 'complete', location);
    assert.ok(group.bodies.every((body) => body.text !== '' && body.descriptor.capturedBytes > 0 && body.descriptor.state === 'complete' && body.descriptor.complete));
    assert.equal(JSON.stringify(group).includes(secret), false);
    for (const headers of [group.request.headers, group.request.responseHeaders, group.attempts[0].headers, group.attempts[0].responseHeaders]) assert.doesNotMatch(JSON.stringify(headers), /OMITTED: incomplete credential discovery/);
  }
});

test('escaped credential names omit only the affected string and redact cross-group echoes', () => {
  const secret = 'fixture-escaped-name-secret', escaped = 'pass\\u0077ord=fixture-escaped-name-secret';
  const req = Object.assign(new EventEmitter(), { method: 'POST', url: '/v1/chat/completions', headers: { 'x-echo': secret } });
  const res = Object.assign(new EventEmitter(), { write() {}, end() {}, writeHead() {}, getHeaders() { return {}; } });
  let group;
  const store = { generation: 0, health: mockDropHealth(), recordDrop: DetailedLogStore.prototype.recordDrop, open: async () => true, failure() { assert.fail('unexpected failure'); },
    publish({ produce, release }) { group = produce(); release(); return Promise.resolve(true); } };
  const root = new DetailRoot(req, res, store);
  root.input.add(JSON.stringify({ messages: [{ role: 'user', content: escaped }], echo: secret })); root.input.end();
  root.output.add(JSON.stringify({ echo: secret, ordinary: 'visible' })); root.output.end(); root.finalize();
  assert.equal(group.request.state, 'complete');
  assert.ok(group.bodies.every((body) => body.descriptor.state === 'complete' && body.descriptor.capturedBytes > 0));
  assert.equal(JSON.stringify(group).includes(secret), false);
  assert.equal(JSON.parse(group.bodies[0].text).messages[0].content, '[OMITTED: ambiguous escaped credential]');
  assert.equal(JSON.parse(group.bodies[1].text).ordinary, 'visible');
  assert.equal(group.request.headers['x-echo'], '[REDACTED]');
});

test('escaped structured credential names, cookie components and URL keys redact decoded values', () => {
  const secret = 'fixture-escaped-structured-secret', cookieSecret = 'fixture-escaped-cookie-secret';
  const field = 'pass\\u0077ord', cookie = 'set\\u002dcookie', query = 'api\\u005fkey';
  const result = capture([JSON.stringify({ echo: `${secret} ${cookieSecret}`, [field]: secret, [cookie]: `session=${cookieSecret}; Path=/visible-path`, url: `https://example.test/?${query}=${secret}`, ordinary: 'visible' })]);
  const output = JSON.parse(result.text);
  assert.equal(result.descriptor.state, 'complete'); assert.equal(output.ordinary, 'visible');
  assert.equal(output[field], '[REDACTED]'); assert.equal(output[cookie], '[REDACTED]');
  for (const value of [secret, cookieSecret]) assert.equal(JSON.stringify(output).includes(value), false);
});

test('unread, interrupted, malformed and binary are explicit, never raw fallback', () => {
  assert.equal(capture([], undefined, {}, false).descriptor.state, 'unread');
  for (const text of ['{"password":"secret', Buffer.from([0xc3, 0x28]), 'data: {"key":"secret"}\n']) {
    const result = capture([text]); assert.equal(result.text, ''); assert.equal(result.descriptor.state, 'omitted-for-safety');
  }
  for (const text of ['bad \\u0073ecret', 'nested \\\\u0073ecret']) {
    const result = capture([text], undefined, {}, text.startsWith('nested'));
    assert.equal(result.text, ''); assert.equal(result.descriptor.state, 'omitted-for-safety');
  }
  const partial = capture(['plain partial'], undefined, {}, false);
  assert.equal(partial.descriptor.complete, false); assert.equal(partial.text, 'plain partial');
});

test('aggregate budget remains reserved until release; exhaustion affects only capture', async () => {
  const budget = new CaptureBudget(12);
  const a = new BodyCapture({ budget }), b = new BodyCapture({ budget });
  a.add('aaaaaa'); b.add('bbbbbb'); a.end(); b.end();
  assert.equal(b.materialize(new DetailRedactor()).descriptor.state, 'resource-limited'); assert.equal(budget.used, 12);
  a.release(); b.release(); assert.equal(budget.used, 0);
  const body = new BodyCapture({ limit: 3 });
  const source = Readable.from([Buffer.from('abc'), Buffer.from('def')]);
  const chunks = []; for await (const chunk of observeStream(source, body)) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString(), 'abcdef'); assert.equal(body.observedBytes, 6); body.release();
});

test('route allowlist excludes management, quota and discovery', () => {
  for (const route of ['/api/accounts', '/api/logs/details', '/api/meta', '/api/models', '/']) assert.equal(detailRoute('GET', route), false);
  for (const route of ['/api/test', '/api/probe', '/api/validate-upstreams', '/api/accounts/test', '/api/accounts/proxy-test', '/v1/responses']) assert.equal(detailRoute('POST', route), true);
  assert.equal(detailRoute('OPTIONS', '/v1/chat/completions'), false);
});

test('partial JSON retains safe message text, redacts escaped credentials and known suffixes at every cut', () => {
  for (const text of ['{"message":"safe prompt known-secret"}', '{"api_key":"secret-value"}', '{"password":"\\u0073ecret-value"}']) {
    for (let cut = text.indexOf(':') + 2; cut < text.length; cut++) {
      const result = capture([text], new DetailRedactor(['known-secret']), { limit: cut });
      assert.doesNotMatch(result.text, /secret-value|known-secret|\\u0073ecret/);
      if (text.startsWith('{"message"') && cut > text.indexOf('known')) assert.match(result.text, /safe prompt/);
    }
  }
  const fragmented = capture(['safe output known-sec'], new DetailRedactor(['known-secret']), {}, false);
  assert.equal(fragmented.text, 'safe output [REDACTED]');
  const hugeSecret = capture([JSON.stringify({ key: 'x'.repeat(65537), echo: 'x'.repeat(65537) })]);
  assert.equal(hugeSecret.descriptor.state, 'resource-limited'); assert.equal(hugeSecret.text, '');
  const deepPrefix = capture(['['.repeat(65)], new DetailRedactor(), {}, false);
  assert.equal(deepPrefix.descriptor.state, 'resource-limited'); assert.equal(deepPrefix.text, '');
});

test('short credentials never recursively rewrite generated markers, including later passes and new secrets', () => {
  const secrets = ['A', 'D', 'E', 'R', 'T', 'C', '[', ']'];
  const redactor = new DetailRedactor(secrets), expected = '[REDACTED]'.repeat(4096);
  assert.equal(redactor.known('A'.repeat(4096)), expected);
  assert.equal(redactor.known(expected), expected); assert.equal(redactor.limited, false);
  redactor.add('later-secret'); assert.equal(redactor.known('[REDACTED] later-secret'), '[REDACTED] [REDACTED]');
  for (const secret of ['a.b', '[foo]', 'a|b', '\\', '*', '?']) assert.equal(new DetailRedactor([secret]).known(secret), '[REDACTED]', 'patterns must be literal');
  const group = new DetailRedactor(), body = new BodyCapture();
  body.add(JSON.stringify({ password: secrets, message: 'A'.repeat(16), ordinary: 'keep this text' })); body.end();
  body.learn(group); const output = body.materialize(group); body.release();
  assert.equal(output.descriptor.state, 'complete'); assert.equal(group.limited, false);
  assert.deepEqual(JSON.parse(output.text), { password: '[REDACTED]', message: '[REDACTED]'.repeat(16), ordinary: 'keep this text' });
});

test('literal replacement bounds match work and large-prefix output before retaining slices and fails closed', () => {
  const marker = '[REDACTED]', redactor = new DetailRedactor(['A']);
  assert.equal(redactor.known('A'.repeat(16384)), marker.repeat(16384)); assert.equal(redactor.limited, false);
  assert.equal(redactor.known('A'.repeat(16385)), '[OMITTED: redaction resource limit]'); assert.equal(redactor.limited, true);
  const boundary = new DetailRedactor(['A']);
  assert.equal(boundary.known('x'.repeat(MAX_BODY_BYTES - marker.length) + 'A'), 'x'.repeat(MAX_BODY_BYTES - marker.length) + marker);
  for (const text of ['x'.repeat(MAX_BODY_BYTES - 1) + 'A', 'A' + 'x'.repeat(MAX_BODY_BYTES - 1)]) {
    const limited = new DetailRedactor(['A']); assert.equal(limited.known(text), '[OMITTED: redaction resource limit]'); assert.equal(limited.limited, true);
  }
  const budget = new CaptureBudget(), group = new DetailRedactor();
  const earlier = new BodyCapture({ budget }), pressure = new BodyCapture({ budget });
  earlier.add('ordinary earlier text'); earlier.end();
  pressure.add(JSON.stringify({ password: ['A', 'D', 'E', 'R', 'T', 'C', '[', ']'], message: 'A'.repeat(16385) })); pressure.end();
  for (const body of [earlier, pressure]) body.learn(group);
  for (const body of [earlier, pressure]) {
    const output = body.materialize(group); assert.equal(output.text, ''); assert.equal(output.descriptor.state, 'resource-limited');
    assert.equal(output.descriptor.complete, true); body.release();
  }
  assert.equal(group.limited, true); assert.equal(budget.used, 0);
});

test('model token parameters and usage counters are ordinary content, not credential secrets', () => {
  const input = { max_tokens: 12, messages: [{ content: 'ordinary version 12' }], usage: { prompt_tokens: 12, completion_tokens: 0, total_tokens: 12, cached_tokens: 0, input_tokens: 12, output_tokens: 0 } };
  const redactor = new DetailRedactor(); const output = JSON.parse(redactor.body(JSON.stringify(input)));
  assert.deepEqual(output, input); assert.equal(redactor.secrets.size, 0);
});

test('known secrets are removed from header names and every supported textual credential assignment', () => {
  const redactor = new DetailRedactor(['fixture-credential-X9']);
  assert.doesNotMatch(JSON.stringify(redactor.headers({ 'x-fixture-credential-X9': 'ordinary' })), /fixture-credential-X9/);
  for (const key of ['passwd', 'password', 'admin_key', 'apiKey', 'access_token', 'private-key', 'secret', 'credential', 'key']) {
    const output = new DetailRedactor().body(`ordinary version=12 ${key}=fixture-password-value`);
    assert.doesNotMatch(output, /fixture-password-value/); assert.match(output, /ordinary version=12/);
  }
});

test('valid JSON containing lone surrogate credentials does not discard unrelated fields or throw', () => {
  const result = capture(['{"api_key":"\\ud800","message":"ordinary","echo":"\\ud800"}']);
  const json = JSON.parse(result.text);
  assert.equal(result.descriptor.state, 'complete'); assert.equal(json.message, 'ordinary'); assert.equal(json.api_key, '[REDACTED]'); assert.equal(json.echo, '[REDACTED]');
});

test('native stream tap preserves backpressure and propagates destruction to the original source', async () => {
  let produced = 0;
  const source = Readable.from((function* () { for (let i = 0; i < 128; i++) { produced++; yield Buffer.alloc(16384, 97); } })(), { highWaterMark: 16384, objectMode: false });
  const capture = new BodyCapture({ limit: 100 });
  const tap = observeStream(source, capture);
  const sink = new Writable({ highWaterMark: 16384, write(chunk, encoding, callback) { setTimeout(callback, 1); } });
  const completed = pipeline(tap, sink);
  await new Promise((resolve) => setTimeout(resolve, 5)); assert.ok(produced < 128, 'the diagnostic tap must not drain a paused consumer');
  await completed; assert.equal(capture.observedBytes, 128 * 16384); capture.release();
  const held = new Readable({ read() { this.push(Buffer.alloc(16384)); } }), partial = new BodyCapture({ limit: 100 });
  const interrupted = observeStream(held, partial); interrupted.destroy();
  await new Promise((resolve) => setImmediate(resolve)); assert.equal(held.destroyed, true); partial.release();
  const closedSource = new Readable({ read() {} }), closedCapture = new BodyCapture();
  const closedTap = observeStream(closedSource, closedCapture); closedSource.destroy();
  await new Promise((resolve) => setImmediate(resolve)); assert.equal(closedTap.destroyed, true); assert.equal(closedTap.errored.code, 'ERR_STREAM_PREMATURE_CLOSE'); assert.equal(closedCapture.complete, false); closedCapture.release();
});

test('stream abort preserves the native error identity and code and converges only once on error/close', async () => {
  const source = new Readable({ read() {} }), body = new BodyCapture();
  const tap = observeStream(source, body), errors = [], closes = [];
  tap.on('error', (error) => errors.push(error)); tap.on('close', () => closes.push(true));
  const error = Object.assign(new Error('aborted'), { code: 'ECONNRESET' });
  source.emit('aborted'); source.destroy(error);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(errors, [error]); assert.equal(tap.errored, error); assert.equal(tap.errored.code, 'ECONNRESET'); assert.equal(closes.length, 1);
  assert.equal(body.complete, false); assert.equal(source.destroyed, true); body.release();
});

test('downstream wrapper keeps overloads, callbacks, return values and exactly-once finalization', async () => {
  const req = new EventEmitter(); Object.assign(req, { method: 'POST', url: '/v1/chat/completions', headers: { 'x-ordinary': 'visible' } });
  class Response extends EventEmitter {
    constructor() { super(); this.statusCode = 200; }
    getHeaders() { return { 'x-set': 'set header' }; }
    writeHead(status) { this.statusCode = status; return this; }
    write(chunk, encoding, callback) { if (typeof encoding === 'function') encoding(); else callback?.(); return false; }
    end(chunk, encoding, callback) { if (chunk) this.write(chunk, encoding); callback?.(); this.emit('finish'); return this; }
  }
  const res = new Response(), published = [];
  const store = { generation: 0, health: mockDropHealth(), recordDrop: DetailedLogStore.prototype.recordDrop, open: async () => true, failure() { assert.fail('unexpected store failure'); }, publish({ produce, release }) { return Promise.resolve().then(() => { published.push(produce()); release(); }); } };
  const root = new DetailRoot(req, res, store); root.input.add('{}'); root.input.end();
  assert.equal(res.writeHead(201, 'Created', { 'X-Ordinary': 'ordinary response', 'X-Passwd': 'header-secret' }), res);
  let callbacks = 0; assert.equal(res.write('hello ', () => callbacks++), false); assert.equal(res.end(new Uint8Array(Buffer.from('world')), undefined, () => callbacks++), res);
  res.emit('close'); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(callbacks, 2); assert.equal(published.length, 1);
  const group = published[0]; assert.equal(group.request.status, 201); assert.equal(group.request.responseHeaders['x-ordinary'], 'ordinary response');
  assert.equal(group.request.responseHeaders['x-passwd'], '[REDACTED]'); assert.equal(group.bodies[1].text, 'hello world'); assert.equal(group.bodies[1].descriptor.observedBytes, 11);
});

test('header URLs and textual authorization are learned before every group echo is materialized', async () => {
  const secrets = ['ingress-url-password', 'upstream-url-password', 'response-url-password', 'downstream-url-password', 'prose-bearer-value'];
  const req = Object.assign(new EventEmitter(), { method: 'POST', url: '/v1/chat/completions', headers: {
    'x-earlier-echo': secrets.join(' '), referer: 'https://user:ingress-url-password@example.org/'
  } });
  const res = Object.assign(new EventEmitter(), { write() {}, end() {}, writeHead() {}, getHeaders() { return {}; } });
  let group;
  const store = { generation: 0, health: mockDropHealth(), recordDrop: DetailedLogStore.prototype.recordDrop, open: async () => true, failure() { assert.fail('unexpected failure'); },
    publish({ produce, release }) { group = produce(); release(); return Promise.resolve(true); } };
  const root = new DetailRoot(req, res, store);
  root.input.add(JSON.stringify({ echo: secrets.join(' '), message: 'ordinary prompt' })); root.input.end();
  root.output.add('ordinary output ' + secrets.join(' ')); root.output.end();
  const attempt = root.attempt({ url: 'https://example.org/chat/completions', headers: {
    'x-earlier-echo': secrets.join(' '), referer: 'https://example.org/?api_key=upstream-url-password'
  }, body: JSON.stringify({ message: 'Bearer prose-bearer-value' }) });
  attempt.responseHeaders = { 'x-earlier-echo': secrets.join(' '), location: 'https://user:response-url-password@example.org/' };
  root.responseHeaders = { 'x-earlier-echo': secrets.join(' '), location: 'https://user:downstream-url-password@example.org/' };
  attempt.output.add(secrets.join(' ')); attempt.output.end(); root.finalize();
  for (const secret of secrets) assert.equal(JSON.stringify(group).includes(secret), false, secret);
  assert.match(group.bodies[0].text, /ordinary prompt/); assert.match(group.bodies[1].text, /ordinary output/);
  const headers = new DetailRedactor().headers({ 'x-echo': 'header-only-password', referer: 'https://user:header-only-password@example.org/' });
  assert.doesNotMatch(JSON.stringify(headers), /header-only-password/);
});

test('duplicate credential URL parameters are all learned before earlier header and body echoes', () => {
  const secrets = ['query-first-secret', 'query-second-secret', 'query-third-secret'];
  const url = `https://example.org/?api_key=${secrets[0]}&api_key=${secrets[1]}&password=${secrets[2]}&ordinary=visible`;
  const headers = new DetailRedactor().headers({ 'x-earlier-echo': secrets.join(' '), location: url });
  for (const secret of secrets) assert.equal(JSON.stringify(headers).includes(secret), false, secret);
  assert.match(headers.location, /ordinary=visible/);
  const body = capture([JSON.stringify({ earlier: secrets.join(' '), link: url, message: 'ordinary prompt' })]);
  for (const secret of secrets) assert.equal(body.text.includes(secret), false, secret);
  assert.equal(JSON.parse(body.text).message, 'ordinary prompt');
});

test('original credential syntax survives known syntax collisions and credential headers learn URL and assignment components', async (t) => {
  const secret = 'prefix-fixture-long-secret';
  const fixtures = [
    ['https', 'x-debug', `https://example.test/?api_key=${secret}`],
    ['Bearer', 'x-debug', `Bearer ${secret}`],
    ['api_key', 'x-debug', `https://example.test/?api_key=${secret}`],
    ['prefix-', 'x-credential', `https://example.test/?api_key=${secret}`],
    ['nested-debug-fixture', 'x-debug', `Bearer https://example.test/?api_key=${secret}`],
    ['nested-header-fixture', 'x-credential', `Bearer https://example.test/?api_key=${secret}`],
    ['assignment-header-fixture', 'x-credential', `Bearer api_key=${secret}`, true]
  ];
  for (const [known, name, value, requestCredential = false] of fixtures) await t.test(`${known}/${name}`, () => {
    const before = captureBudget.used, active = DetailRoot.active;
    const req = Object.assign(new EventEmitter(), { method: 'POST', url: '/v1/chat/completions', headers: { 'x-earlier': secret, ...(requestCredential ? { [name]: value } : {}) } });
    const res = Object.assign(new EventEmitter(), { write() {}, end() {}, writeHead() {}, getHeaders() { return {}; } });
    let group;
    const store = { generation: 0, health: mockDropHealth(), recordDrop: DetailedLogStore.prototype.recordDrop, open: async () => true, failure() { assert.fail('unexpected failure'); },
      publish({ produce, release }) { try { group = produce(); } finally { release(); } return Promise.resolve(true); } };
    const root = new DetailRoot(req, res, store, [known]);
    root.input.add(JSON.stringify({ echo: secret, message: 'ordinary prompt' })); root.input.end();
    root.output.add(JSON.stringify({ echo: secret })); root.output.end();
    const attempt = root.attempt({ url: 'https://upstream.test/chat/completions', body: JSON.stringify({ echo: secret }) });
    attempt.responseHeaders = { [name]: value };
    attempt.output.add(JSON.stringify({ echo: secret })); attempt.output.end(); root.finalize();
    assert.equal(root.redactor.secrets.has(secret), true, `${known}/${name}: learn the original complete component`);
    assert.equal(JSON.stringify(group).includes(secret), false);
    assert.equal(JSON.stringify(group).includes('fixture-long-secret'), false, 'no reconstructable suffix');
    assert.equal(group.request.state, 'complete'); assert.ok(group.bodies.every((body) => body.descriptor.state === 'complete'));
    assert.equal(JSON.parse(group.bodies[0].text).message, 'ordinary prompt');
    assert.equal(captureBudget.used, before); assert.equal(DetailRoot.active, active);
  });
  // URL userinfo and repeated query components use the same recognized-header branch.
  const redactor = new DetailRedactor();
  redactor.learnHeaders({ 'x-credential': 'https://fixture-user:fixture-pass@example.test/?api_key=first-fixture&api_key=second-fixture' });
  for (const component of ['fixture-user', 'fixture-pass', 'first-fixture', 'second-fixture']) assert.equal(redactor.known(component), '[REDACTED]');
});

test('outer scheme tokens cannot shadow complete inner URL or assignment credentials across root groups', () => {
  const fixtures = [
    ['prefix-fixture;tail-fixture', 'https://example.test/?api_key=prefix-fixture;tail-fixture'],
    ['prefix-fixture,tail-fixture', 'https://example.test/?api_key=prefix-fixture,tail-fixture'],
    ['fixture-nested-secret', 'api_key=fixture-nested-secret']
  ];
  for (const [secret, syntax] of fixtures) for (const wrapped of [false, true]) for (const location of ['header', 'json', 'sse']) {
    const before = captureBudget.used, active = DetailRoot.active, value = (wrapped ? 'Bearer ' : '') + syntax;
    const req = Object.assign(new EventEmitter(), { method: 'POST', url: '/v1/chat/completions', headers: { 'x-earlier': secret } });
    const res = Object.assign(new EventEmitter(), { write() {}, end() {}, writeHead() {}, getHeaders() { return {}; } });
    let group;
    const store = { generation: 0, health: mockDropHealth(), recordDrop: DetailedLogStore.prototype.recordDrop, open: async () => true, failure() { assert.fail('unexpected failure'); },
      publish({ produce, release }) { try { group = produce(); } finally { release(); } return Promise.resolve(true); } };
    const root = new DetailRoot(req, res, store);
    root.input.add(JSON.stringify({ echo: secret, message: 'ordinary prompt' })); root.input.end();
    root.output.add(JSON.stringify({ echo: secret, message: 'ordinary output' })); root.output.end();
    const attempt = root.attempt({ url: 'https://upstream.test/chat/completions', body: JSON.stringify({ echo: secret }) });
    attempt.responseHeaders = { 'x-earlier': secret, ...(location === 'header' ? { 'x-debug': value } : {}) };
    const payload = JSON.stringify({ echo: secret, ...(location !== 'header' ? { diagnostic: value } : {}) });
    attempt.output.add(location === 'sse' ? 'data: ' + payload + '\n\ndata: [DONE]\n\n' : payload); attempt.output.end(); root.finalize();
    assert.equal(root.redactor.secrets.has(secret), true, `${wrapped}/${location}/${syntax}: discover the entire original credential`);
    for (const forbidden of [secret, 'tail-fixture', 'fixture-nested-secret']) assert.equal(JSON.stringify(group).includes(forbidden), false);
    assert.equal(group.request.state, 'complete'); assert.ok(group.bodies.every((body) => body.descriptor.state === 'complete'));
    assert.equal(JSON.parse(group.bodies[0].text).message, 'ordinary prompt');
    assert.equal(JSON.parse(group.bodies[1].text).message, 'ordinary output');
    if (location === 'sse') assert.match(group.bodies[3].text, /\[DONE\]/);
    assert.equal(captureBudget.used, before); assert.equal(DetailRoot.active, active);
  }
});

test('outer scheme overlap counts inner tokens once at exact and excess work limits with monotonic starts', () => {
  for (const excess of [false, true]) {
    const redactor = new DetailRedactor(), starts = [], learns = { Authorization: 0, key: 0 };
    const originalExec = RegExp.prototype.exec, originalLearn = redactor.learnHeaders.bind(redactor);
    redactor.learnHeaders = (headers, ...options) => { for (const key of Object.keys(headers)) learns[key]++; originalLearn(headers, ...options); };
    let output;
    // Observe the real production matcher, not Set size or a test-only budget.
    // The synchronous patch is restored before any other test can execute.
    RegExp.prototype.exec = function(text) {
      const match = originalExec.call(this, text);
      if (match?.groups && Object.hasOwn(match.groups, 'scheme')) starts.push(match.index);
      return match;
    };
    try { output = redactor.text('Bearer key=x;\n'.repeat(8192) + (excess ? 'Bearer y' : '')); }
    finally { RegExp.prototype.exec = originalExec; }
    assert.equal(starts.length, 16384 + Number(excess));
    assert.ok(starts.every((start, i) => i === 0 || start > starts[i - 1]), 'never process the same outer scheme or restart an earlier scan');
    assert.deepEqual(learns, { Authorization: 8192, key: 8192 }, 'reject match 16385 before learning; inner matches consume the same budget');
    assert.equal(redactor.limited, excess);
    assert.equal(output, excess ? '[OMITTED: redaction resource limit]' : 'Bearer [REDACTED];\n'.repeat(8192));
  }
  const redactor = new DetailRedactor();
  assert.equal(redactor.text('Bearer Bearer key=x; ordinary=visible'), '[REDACTED] [REDACTED]; ordinary=visible');
  assert.equal(redactor.known('x'), '[REDACTED]');
  const markers = new DetailRedactor(['x']);
  assert.equal(markers.text('Bearer [REDACTED]; ordinary=visible'), 'Bearer [REDACTED]; ordinary=visible', 'generated markers remain stable');
});

test('outer scheme partial inner credentials omit every earlier echo and safe ordinary tails stay visible', () => {
  for (const separator of [';', ',']) {
    const secret = 'prefix-fixture' + separator + 'tail-fixture', syntax = 'Bearer https://example.test/?api_key=' + secret;
    // Cut after the outer Bearer match ended but inside the full URL credential.
    const cut = syntax.indexOf('tail-fixture') + 4;
    for (const complete of [false, true]) {
      const budget = new CaptureBudget(), redactor = new DetailRedactor();
      const earlier = new BodyCapture({ budget }), later = new BodyCapture({ budget, ...(complete ? { limit: cut } : {}) });
      earlier.add(JSON.stringify({ echo: secret })); earlier.end(); later.add(complete ? syntax : syntax.slice(0, cut)); if (complete) later.end();
      for (const body of [earlier, later]) body.learn(redactor);
      assert.equal(redactor.unsafe, true);
      for (const body of [earlier, later]) { const result = body.materialize(redactor); assert.equal(result.text, ''); assert.equal(result.descriptor.state, 'omitted-for-safety'); body.release(); }
      assert.doesNotMatch(JSON.stringify(redactor.headers({ 'x-earlier': secret })), /tail-fixture/); assert.equal(budget.used, 0);
    }
  }
  const safe = capture(['Bearer key=x; ordinary unfinished prose'], new DetailRedactor(), {}, false);
  assert.equal(safe.descriptor.state, 'interrupted'); assert.equal(safe.text, 'Bearer [REDACTED]; ordinary unfinished prose');
  const budget = new CaptureBudget(), redactor = new DetailRedactor();
  const earlier = new BodyCapture({ budget }), later = new BodyCapture({ budget });
  earlier.add('ordinary earlier body'); earlier.end(); later.add('Bearer key=x;\n'.repeat(8192) + 'Bearer y'); later.end();
  for (const body of [earlier, later]) body.learn(redactor);
  for (const body of [earlier, later]) { const result = body.materialize(redactor); assert.equal(result.text, ''); assert.equal(result.descriptor.state, 'resource-limited'); assert.equal(result.descriptor.complete, true); body.release(); }
  assert.equal(budget.used, 0);
});

test('text assignments stop at the existing work and output bounds before retaining excess output', () => {
  for (const count of [16383, 16384, 16385]) {
    const redactor = new DetailRedactor(); let learned = 0;
    const learnHeaders = redactor.learnHeaders.bind(redactor);
    redactor.learnHeaders = (headers) => { learned++; learnHeaders(headers); };
    const text = redactor.text('key=x;'.repeat(count));
    assert.equal(learned, Math.min(count, 16384), 'stop discovery before processing the excess assignment');
    assert.equal(redactor.limited, count > 16384, `assignment count ${count}`);
    assert.equal(text, count > 16384 ? '[OMITTED: redaction resource limit]' : 'key=[REDACTED];'.repeat(count));
  }
  // Match work includes ordinary assignments even when known() has no secrets.
  assert.ok(new DetailRedactor().text('ordinary=x;'.repeat(16385)) === '[OMITTED: redaction resource limit]');
  const safe = 'key=[REDACTED];';
  for (const tail of [false, true]) for (const excess of [0, 1]) {
    const padding = 'z'.repeat(MAX_BODY_BYTES - safe.length + excess);
    const input = tail ? 'key=x;' + padding : padding + ';key=x';
    const redactor = new DetailRedactor(), output = redactor.text(input);
    assert.equal(redactor.limited, excess === 1);
    assert.equal(output, excess ? '[OMITTED: redaction resource limit]' : tail ? safe + padding : padding + ';key=[REDACTED]');
  }
  const tooLong = new DetailRedactor();
  assert.equal(tooLong.text('z'.repeat(MAX_BODY_BYTES + 1)), '[OMITTED: redaction resource limit]');
  assert.equal(tooLong.limited, true);
});

test('bounded assignment assembly retains discovery inside overlapping original credential values', () => {
  const redactor = new DetailRedactor();
  assert.equal(redactor.text('password=first-fixture api_key=second-fixture; ordinary=visible'), 'password=[REDACTED]; ordinary=visible');
  assert.equal(redactor.known('first-fixture second-fixture'), '[REDACTED] [REDACTED]');
  assert.equal(redactor.limited, false);
  const nested = new DetailRedactor();
  nested.text('password=first-fixture https://example.test/?api_key=url-fixture');
  assert.equal(nested.known('url-fixture'), '[REDACTED]');
});

test('overlapping assignment value scans obey the existing cumulative length budget', () => {
  const count = 256;
  // For n copies of "key=x " and a tail of m characters, the original value
  // spans total 3*n*n + n*(m-1). Only ~21 KiB input exercises the real 5 MiB
  // cumulative scan boundary; no timing benchmark or production knob is needed.
  const tailLength = (MAX_BODY_BYTES - 3 * count * count) / count + 1;
  for (const delta of [-1, 0, 1]) {
    const redactor = new DetailRedactor(); let learned = 0;
    // Isolate scan work from the independent distinct-secret/64 KiB budget.
    redactor.learnHeaders = () => { learned++; };
    const output = redactor.text('key=x '.repeat(count) + 'z'.repeat(tailLength + delta));
    assert.equal(redactor.limited, delta > 0);
    assert.equal(learned, delta > 0 ? count - 1 : count, 'reject the excess span before learning or retaining it');
    assert.equal(output, delta > 0 ? '[OMITTED: redaction resource limit]' : 'key=[REDACTED]');
  }
});

test('assignment work pressure omits the whole root group and releases retained reservations', () => {
  const before = captureBudget.used, active = DetailRoot.active;
  const req = Object.assign(new EventEmitter(), { method: 'POST', url: '/v1/chat/completions', headers: { 'x-ordinary': 'visible' } });
  const res = Object.assign(new EventEmitter(), { write() {}, end() {}, writeHead() {}, getHeaders() { return {}; } });
  let group;
  const store = { generation: 0, health: mockDropHealth(), recordDrop: DetailedLogStore.prototype.recordDrop, open: async () => true, failure() { assert.fail('unexpected failure'); },
    publish({ produce, release }) { try { group = produce(); } finally { release(); } return Promise.resolve(true); } };
  const root = new DetailRoot(req, res, store);
  root.input.add('ordinary prompt'); root.input.end(); root.output.add('ordinary output'); root.output.end();
  const attempt = root.attempt({ url: 'https://example.test/chat/completions', body: '{}' });
  attempt.output.add('key=x;'.repeat(16385)); attempt.output.end(); root.finalize();
  assert.equal(group.request.state, 'resource-limited'); assert.equal(store.health.dropped, 1);
  assert.equal(store.health.dropReasons.redactionWorkLimit, 1);
  assert.equal(Object.values(store.health.dropReasons).reduce((a, b) => a + b, 0), 1);
  assert.ok(group.bodies.every((body) => body.text === '' && body.descriptor.state === 'resource-limited' && body.descriptor.complete));
  assert.match(JSON.stringify(group.request.headers), /OMITTED/);
  assert.equal(captureBudget.used, before); assert.equal(DetailRoot.active, active);
});

test('one root drop classifies capture, redaction and multiple-body limits without changing descriptors', () => {
  const makeRoot = ({ secrets = [], headers = {}, budget = null, profile = 'full' } = {}) => {
    let group;
    const req = Object.assign(new EventEmitter(), { method: 'POST', url: '/v1/chat/completions', headers });
    const res = Object.assign(new EventEmitter(), { write() {}, end() {}, writeHead() {}, getHeaders() { return {}; } });
    const store = { generation: 0, health: mockDropHealth(), recordDrop: DetailedLogStore.prototype.recordDrop,
      open: async () => true, failure() { assert.fail('unexpected failure'); },
      publish({ produce, release }) { try { group = produce(); } finally { release(); } return Promise.resolve(true); } };
    const root = new DetailRoot(req, res, store, secrets, { profile });
    if (budget) { root.input.budget = budget; root.output.budget = budget; }
    return { root, store, group: () => group };
  };
  const check = (fixture, key, count = 1) => {
    const { store, group } = fixture;
    assert.equal(store.health.dropped, count);
    assert.equal(store.health.dropReasons[key], count);
    assert.equal(Object.values(store.health.dropReasons).reduce((a, b) => a + b, 0), count);
    assert.equal(JSON.stringify({ request: group().request, attempts: group().attempts, bodies: group().bodies.map((body) => body.descriptor) }).includes('limitReason'), false, 'internal reason cannot enter manifest');
  };
  {
    const f = makeRoot({ budget: new CaptureBudget(1) });
    f.root.input.add('a'); f.root.input.end(); f.root.output.add('b'); f.root.output.end(); f.root.finalize();
    check(f, 'captureBudget'); assert.equal(f.group().bodies.filter((b) => b.descriptor.state === 'resource-limited').length, 2);
    assert.equal(f.root.input.budget.used, 0);
  }
  {
    const f = makeRoot({ secrets: ['x'], budget: new CaptureBudget(3) });
    f.root.input.add('x'); f.root.input.end(); f.root.output.end(); f.root.finalize();
    check(f, 'captureBudget'); assert.equal(f.group().bodies[0].descriptor.state, 'resource-limited');
    assert.equal(f.root.input.budget.used, 0);
  }
  {
    const f = makeRoot({ secrets: Array.from({ length: 257 }, (_, i) => `fixture-secret-${i}`) });
    f.root.input.add('safe'); f.root.input.end(); f.root.output.end(); f.root.finalize(); check(f, 'redactionSecretLimit');
  }
  for (const [headers, key] of [
    [{ 'x-ordinary': 'ordinary=x;'.repeat(16385) }, 'redactionWorkLimit'],
    [{ 'x-ordinary': 'z'.repeat(MAX_BODY_BYTES + 1) }, 'redactionOutputLimit']
  ]) {
    const f = makeRoot({ headers }); f.root.input.add('safe'); f.root.input.end(); f.root.output.end(); f.root.finalize(); check(f, key);
  }
  {
    const f = makeRoot({ secrets: Array.from({ length: 257 }, (_, i) => `fixture-secret-${i}`), budget: new CaptureBudget(1) });
    f.root.input.add('safe'); f.root.input.end(); f.root.output.add('also limited'); f.root.output.end(); f.root.finalize();
    check(f, 'captureBudget'); assert.equal(f.store.health.dropReasons.redactionSecretLimit, 0, 'budget outranks secret limit');
  }
  {
    const f = makeRoot(); f.root.input.limit = 3; f.root.input.add('abcdef'); f.root.input.end(); f.root.output.end(); f.root.finalize();
    assert.equal(f.group().bodies[0].descriptor.state, 'truncated');
    assert.equal(f.store.health.dropped, 0); // The ordinary per-body cap is truncation, not a resource drop.
  }
  {
    const f = makeRoot(); f.root.input.add('ambiguous { bytes'); f.root.input.end(); f.root.output.end(); f.root.finalize();
    assert.equal(f.store.health.dropped, 0); assert.equal(f.group().bodies[0].descriptor.state, 'omitted-for-safety');
  }
});

test('error profile counts multiple limited responses once and attempt fence remains independent', () => {
  let group;
  const req = Object.assign(new EventEmitter(), { method: 'POST', url: '/v1/chat/completions', headers: {} });
  const res = Object.assign(new EventEmitter(), { write() {}, end() {}, writeHead() {}, getHeaders() { return {}; } });
  const store = { generation: 0, health: mockDropHealth(), recordDrop: DetailedLogStore.prototype.recordDrop,
    open() { assert.fail('error-only root must not open'); }, failure() { assert.fail('unexpected failure'); },
    publish({ produce, release }) { try { group = produce(); } finally { release(); } return Promise.resolve(true); } };
  const root = new DetailRoot(req, res, store, [], { profile: 'error' });
  for (let i = 0; i < 2; i++) {
    const attempt = root.attempt({ url: 'https://fixture.test/chat/completions', body: '{}' });
    root.settleAttempt(attempt, { failed: true, responseBody: 'fixture response' });
    attempt.output.release(); attempt.output = new BodyCapture({ budget: new CaptureBudget(1) });
    attempt.output.add('limited'); attempt.output.end();
  }
  root.finalize(); root.finalize();
  assert.equal(group.request.state, 'resource-limited'); assert.equal(group.bodies.length, 2);
  assert.equal(store.health.dropped, 1); assert.equal(store.health.dropReasons.captureBudget, 1);
  assert.equal(Object.values(store.health.dropReasons).reduce((a, b) => a + b, 0), 1);
  const limitedRoot = new DetailRoot(req, res, store, [], { profile: 'error' });
  limitedRoot.attempts = Array(256).fill(null);
  assert.equal(limitedRoot.attempt({ url: 'https://fixture.test/chat/completions' }), null);
  assert.equal(store.health.dropReasons.attemptLimit, 1); assert.equal(store.health.dropped, 2);
  limitedRoot.attempts = []; limitedRoot.finalize();
});

test('unconsumed GET payloads remain unread instead of claiming a complete empty body', () => {
  for (const headers of [{}, { 'content-length': '0' }, { 'content-length': '2' }, { 'transfer-encoding': 'chunked' }]) {
    const req = Object.assign(new EventEmitter(), { method: 'GET', url: '/v1/models', headers });
    const res = Object.assign(new EventEmitter(), { write() {}, end() {}, writeHead() {}, getHeaders() { return {}; } });
    let group;
    const store = { generation: 0, health: mockDropHealth(), recordDrop: DetailedLogStore.prototype.recordDrop, open: async () => true, failure() { assert.fail('unexpected failure'); },
      publish({ produce, release }) { group = produce(); release(); return Promise.resolve(true); } };
    new DetailRoot(req, res, store).finalize();
    const unread = !!headers['transfer-encoding'] || headers['content-length'] === '2';
    assert.equal(group.bodies[0].descriptor.state, unread ? 'unread' : 'complete');
    assert.equal(group.bodies[0].descriptor.complete, !unread);
  }
});
