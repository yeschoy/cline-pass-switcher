import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { BodyCapture, CaptureBudget, DetailRoot, observeStream, MAX_BODY_BYTES, MAX_RAW_BODY_BYTES, MAX_PAYLOAD_BYTES, MAX_SANITIZED_PAYLOAD_BYTES } from '../lib/detailed-log-capture.js';
import { DetailedLogStore, RAW_MAX_AGE_MS, MAX_TOTAL_BYTES } from '../lib/detailed-log-store.js';
import { projectRawHeaders } from '../lib/raw-detail-headers.js';

const rawGroup = (ts, requestId, text = 'fixture-raw-secret') => {
  const bodyId = randomUUID();
  return { requestId, bodyId, text, produce: () => ({
    request: { requestId, ts, method: 'POST', pathname: '/v1/chat/completions', profile: 'raw-full', model: '', accounts: [], status: 200, complete: true, state: 'complete', attemptCount: 0 },
    attempts: [], bodies: [{ text, descriptor: { bodyId, capturedBytes: Buffer.byteLength(text), observedBytes: Buffer.byteLength(text), redacted: false, state: 'complete', complete: true, truncated: false, omittedTailBytes: 0 } }]
  }) };
};
async function setup(t, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cps-raw-test-'));
  const store = new DetailedLogStore({ dir, ...options }); await store.queue;
  t.after(async () => { await store.close(); await fs.rm(dir, { recursive: true, force: true }); });
  return store;
}
const publish = (store, ts, text) => {
  const group = rawGroup(ts, randomUUID(), text);
  return { ...group, done: store.publish({ generation: store.generation, ts, requestId: group.requestId, profile: 'raw-full', release() {}, produce: group.produce }) };
};

test('production shared budget retains a separate 64 MiB sanitized fence without lowering the raw ceiling', () => {
  assert.equal(MAX_SANITIZED_PAYLOAD_BYTES, 64 * 1024 * 1024);
  const budget = new CaptureBudget(MAX_PAYLOAD_BYTES, MAX_SANITIZED_PAYLOAD_BYTES);
  const chunk = Buffer.alloc(MAX_BODY_BYTES, 0x61);
  const captures = Array.from({ length: 7 }, () => new BodyCapture({ budget }));
  captures.forEach((capture) => { capture.add(chunk); capture.end(); });
  assert.equal(budget.used, 6 * MAX_BODY_BYTES * 2);
  assert.equal(budget.sanitizedUsed, budget.used);
  assert.equal(captures[6].materialize({}).descriptor.state, 'resource-limited');
  const raw = new BodyCapture({ budget, raw: true, limit: MAX_RAW_BODY_BYTES });
  raw.add(Buffer.alloc(MAX_RAW_BODY_BYTES, 0x62)); raw.end();
  assert.equal(raw.materialize().descriptor.state, 'complete');
  assert.equal(budget.sanitizedUsed, 6 * MAX_BODY_BYTES * 2);
  assert.equal(budget.used, 6 * MAX_BODY_BYTES * 2 + MAX_RAW_BODY_BYTES * 2);
  captures.forEach((capture) => capture.release()); raw.release();
  assert.equal(budget.used, 0); assert.equal(budget.sanitizedUsed, 0);
});

test('raw capture retains exact valid UTF-8 up to 35 MiB with bounded reservation and invalid omission', () => {
  assert.equal(MAX_BODY_BYTES, 5 * 1024 * 1024);
  assert.equal(MAX_RAW_BODY_BYTES, 35 * 1024 * 1024);
  assert.equal(MAX_PAYLOAD_BYTES, 512 * 1024 * 1024);
  const budget = new CaptureBudget(2 * MAX_RAW_BODY_BYTES * 2);
  const data = Buffer.alloc(MAX_RAW_BODY_BYTES, 0x61);
  const captures = Array.from({ length: 3 }, () => new BodyCapture({ budget, raw: true, limit: MAX_RAW_BODY_BYTES }));
  captures.forEach((body) => { body.add(data); body.add('tail'); body.end(); });
  assert.equal(budget.used, MAX_RAW_BODY_BYTES * 4);
  assert.equal(captures[2].materialize().descriptor.state, 'resource-limited');
  const result = captures[0].materialize();
  assert.equal(result.descriptor.state, 'truncated'); assert.equal(result.descriptor.capturedBytes, MAX_RAW_BODY_BYTES);
  assert.equal(result.text, 'a'.repeat(MAX_RAW_BODY_BYTES));
  captures.forEach((body) => body.release()); assert.equal(budget.used, 0);
  const bom = new BodyCapture({ raw: true });
  bom.add(Buffer.from([0xef, 0xbb])); bom.add(Buffer.from([0xbf, 0x61])); bom.end();
  assert.equal(bom.materialize().text, '\ufeffa');
  assert.equal(bom.materialize().descriptor.capturedBytes, 4); bom.release();
  const invalid = new BodyCapture({ raw: true }); invalid.add(Buffer.from([0xff])); invalid.end();
  assert.equal(invalid.materialize().descriptor.state, 'omitted-for-safety'); invalid.release();
  const cut = new BodyCapture({ raw: true, limit: 2 }); cut.add(Buffer.from('你')); cut.end();
  assert.equal(cut.materialize().text, ''); assert.equal(cut.materialize().descriptor.state, 'truncated'); cut.release();
  const malformedCut = new BodyCapture({ raw: true, limit: 2 }); malformedCut.add(Buffer.from([0x61, 0xff, 0x62])); malformedCut.end();
  assert.equal(malformedCut.materialize().descriptor.state, 'omitted-for-safety'); malformedCut.release();
});

test('raw body read and restart preserve a leading UTF-8 BOM', async (t) => {
  const store = await setup(t);
  const item = publish(store, store.now(), '\ufefffixture-body');
  assert.equal(await item.done, true);
  assert.equal(await store.body(item.requestId, item.bodyId), '\ufefffixture-body');
  const reboot = new DetailedLogStore({ dir: store.dir }); t.after(() => reboot.close()); await reboot.queue;
  assert.equal(await reboot.body(item.requestId, item.bodyId), '\ufefffixture-body');
});

test('raw groups share store capacity, remain isolated from legacy and expire with corrupt manifests', async (t) => {
  let now = 4 * RAW_MAX_AGE_MS;
  const store = await setup(t, { now: () => now, maxTotalBytes: 1200 });
  const ts = now - RAW_MAX_AGE_MS + 1000;
  const item = publish(store, ts, 'fixture-raw-secret'); assert.equal(await item.done, true);
  const summary = (await store.query()).items[0]; assert.equal(summary.profile, 'raw-full');
  assert.equal(JSON.stringify(summary).includes('fixture-raw-secret'), false);
  assert.equal(await store.body(item.requestId, item.bodyId), 'fixture-raw-secret');
  const sends = await Promise.all(Array.from({ length: 4 }, () => store.body(item.requestId, item.bodyId, { holdRaw: true })));
  assert.ok(sends.every((entry) => entry.text === 'fixture-raw-secret'));
  await assert.rejects(store.body(item.requestId, item.bodyId, { holdRaw: true }), { statusCode: 503 });
  sends.forEach((entry) => { entry.release(); entry.release(); }); assert.equal(store.rawReads, 0);
  const rawPath = path.join(store.rawDir, `${ts}-${item.requestId}`);
  assert.equal((await fs.stat(rawPath)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(path.join(rawPath, item.bodyId + '.txt'))).mode & 0o777, 0o600);
  await assert.rejects(store.readFile(path.join(store.dir, item.requestId), 'manifest.json', 1024 * 1024), { code: 'ENOENT' });
  // Previous shared-key code rejects this distinct raw manifest profile even for small bodies.
  const manifest = JSON.parse(await fs.readFile(path.join(rawPath, 'manifest.json')));
  assert.throws(() => store.validate(manifest, item.requestId), SyntaxError);
  await fs.writeFile(path.join(rawPath, 'manifest.json'), '{broken manifest');
  const reboot = new DetailedLogStore({ dir: store.dir, now: () => now, maxTotalBytes: 1200 }); t.after(() => reboot.close()); await reboot.queue;
  await assert.rejects(reboot.detail(item.requestId), { statusCode: 404 });
  now += 1001; await reboot.serial(() => reboot.expire({ scanRaw: true }));
  await assert.rejects(fs.stat(rawPath), { code: 'ENOENT' });
  assert.equal(reboot.health.rawWarnings, 0);
  assert.equal(MAX_TOTAL_BYTES, 1024 * 1024 * 1024);
});

test('one raw deletion failure is reported and retried without retaining other expired owned groups', async (t) => {
  let now = 4 * RAW_MAX_AGE_MS, blocked = null;
  const io = { ...fs, rm: async (file, ...args) => { if (file === blocked) throw new Error('fixture private deletion failure'); return fs.rm(file, ...args); } };
  const store = await setup(t, { now: () => now, io }); const ts = now - RAW_MAX_AGE_MS + 10;
  const a = publish(store, ts, 'fixture-a'), b = publish(store, ts, 'fixture-b');
  assert.equal(await a.done, true); assert.equal(await b.done, true);
  const first = path.join(store.rawDir, `${ts}-${a.requestId}`), second = path.join(store.rawDir, `${ts}-${b.requestId}`);
  await fs.writeFile(path.join(first, 'manifest.json'), '{broken'); await fs.writeFile(path.join(second, 'manifest.json'), '{broken');
  blocked = first; now += 11;
  await assert.rejects(store.serial(() => store.expire({ scanRaw: true })), { statusCode: 503 });
  assert.ok(store.health.failures > 0); assert.doesNotMatch(JSON.stringify(store.health), /fixture private/);
  await assert.rejects(fs.stat(second), { code: 'ENOENT' }); assert.equal((await fs.stat(first)).isDirectory(), true);
  blocked = null; await store.serial(() => store.expire({ scanRaw: true })); await assert.rejects(fs.stat(first), { code: 'ENOENT' });
});

test('owned expired corrupt raw groups are deleted even when legacy inventory admission is fenced', async (t) => {
  let now = 4 * RAW_MAX_AGE_MS;
  const store = await setup(t, { now: () => now });
  const candidate = publish(store, now - RAW_MAX_AGE_MS + 10, 'fixture raw'); assert.equal(await candidate.done, true);
  const dir = path.join(store.rawDir, `${now - RAW_MAX_AGE_MS + 10}-${candidate.requestId}`);
  await fs.writeFile(path.join(dir, 'manifest.json'), '{corrupt');
  const legacyId = randomUUID();
  assert.equal(await store.publish({ generation: store.generation, ts: now, requestId: legacyId, release() {}, produce: () => ({ request: { requestId: legacyId, ts: now, profile: 'full', state: 'complete' }, attempts: [], bodies: [] }) }), true);
  now += 11;
  const limited = new DetailedLogStore({ dir: store.dir, now: () => now, maxInventoryEntries: 0 }); t.after(() => limited.close()); await limited.queue;
  assert.equal(limited.inventoryOverflow, true);
  await assert.rejects(fs.stat(dir), { code: 'ENOENT' });
});

test('sanitized and raw groups share one capacity and oldest-group eviction', async (t) => {
  const store = await setup(t); const ts = store.now(), legacyId = randomUUID(), legacyBodyId = randomUUID();
  assert.equal(await store.publish({ generation: store.generation, ts: ts - 1000, requestId: legacyId, release() {}, produce: () => ({ request: { requestId: legacyId, ts: ts - 1000, profile: 'full', state: 'complete', status: 200 }, attempts: [], bodies: [{ descriptor: { bodyId: legacyBodyId, capturedBytes: 100 }, text: 'a'.repeat(100) }] }) }), true);
  const oldBytes = store.totalBytes;
  const candidate = rawGroup(ts, randomUUID(), 'fixture raw body');
  const produced = candidate.produce(), rawBytes = Buffer.byteLength(JSON.stringify({ request: produced.request, attempts: produced.attempts, bodies: produced.bodies.map((body) => body.descriptor) })) + Buffer.byteLength(candidate.text);
  store.maxTotalBytes = Math.max(oldBytes, rawBytes) + 1;
  assert.ok(oldBytes + rawBytes > store.maxTotalBytes);
  assert.equal(await store.publish({ generation: store.generation, ts, requestId: candidate.requestId, profile: 'raw-full', release() {}, produce: candidate.produce }), true);
  assert.deepEqual((await store.query()).items.map((row) => row.requestId), [candidate.requestId]);
  await assert.rejects(store.detail(legacyId), { statusCode: 404 });
});

test('suspicious raw entries and symlinks cannot be served or cleared, and health warns without names', async (t) => {
  const store = await setup(t); const unknown = path.join(store.rawDir, 'operator-data');
  await fs.mkdir(unknown); await fs.writeFile(path.join(unknown, 'note'), 'fixture private');
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'cps-raw-outside-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  const id = randomUUID(), ts = Date.now() - RAW_MAX_AGE_MS - 1000;
  const unsafe = path.join(store.rawDir, `${ts}-${id}`);
  await fs.mkdir(unsafe); await fs.symlink(outside, path.join(unsafe, randomUUID() + '.txt'));
  await store.serial(() => store.reconcile());
  assert.equal(store.health.rawWarnings, 2);
  assert.doesNotMatch(JSON.stringify(store.health), /operator-data|fixture private/);
  await assert.rejects(store.detail(id), { statusCode: 404 });
  await assert.rejects(store.clear(), { statusCode: 503 });
  assert.equal(await fs.readFile(path.join(unknown, 'note'), 'utf8'), 'fixture private');
  assert.equal((await fs.lstat(path.join(unsafe, (await fs.readdir(unsafe))[0]))).isSymbolicLink(), true);
});

test('raw failed publication temporary ownership is recovered by minute maintenance; suspicious temporary remains', async (t) => {
  let broken = false;
  const io = { ...fs,
    rename: async (...args) => { if (broken) throw new Error('fixture rename failure'); return fs.rename(...args); },
    rm: async (name, ...args) => { if (broken && path.basename(name).startsWith('.tmp-')) throw new Error('fixture cleanup failure'); return fs.rm(name, ...args); }
  };
  const store = await setup(t, { io }); broken = true;
  assert.equal(await publish(store, store.now(), 'fixture-only').done, false);
  const temp = (await fs.readdir(store.rawDir)).find((name) => name.startsWith('.tmp-'));
  assert.ok(temp); assert.ok(store.health.failures >= 2);
  broken = false;
  const suspicious = path.join(store.rawDir, '.tmp-operator'); await fs.mkdir(suspicious);
  await fs.writeFile(path.join(suspicious, 'note'), 'private fixture');
  await store.serial(() => store.expire({ scanRaw: true }));
  assert.equal((await fs.readdir(store.rawDir)).includes(temp), false);
  assert.equal(await fs.readFile(path.join(suspicious, 'note'), 'utf8'), 'private fixture');
  assert.equal(store.health.rawWarnings, 1);
});

test('raw error capture retains only failed request/response bodies and projects no free-form metadata', async () => {
  const req = Object.assign(new EventEmitter(), { method: 'POST', url: '/v1/chat/completions', headers: { authorization: 'Bearer fixture-header-secret' } });
  const res = Object.assign(new EventEmitter(), { write() {}, end() {}, writeHead() {}, getHeaders() { return {}; } });
  let group;
  const store = { generation: 0, recordDrop() {}, failure() { assert.fail('publish must not fail'); }, publish({ produce, release }) { group = produce(); release(); return Promise.resolve(true); } };
  const root = new DetailRoot(req, res, store, [], { profile: 'raw-error' });
  const ok = root.attempt({ body: 'success-request', url: 'http://fixture/?key=private', headers: { 'content-type': 'text/plain', 'x-echo': 'fixture-header-secret' }, account: { key: 'account-secret' } });
  root.settleAttempt(ok, { failed: false, responseBody: 'success-response', responseHeaders: { 'content-type': 'text/plain' } });
  const failed = root.attempt({ body: 'failed-request-秘密', url: 'http://fixture/?key=private', headers: { 'content-type': 'application/json', authorization: 'Bearer account-secret' }, account: { name: 'fixture-header-secret' } });
  root.settleAttempt(failed, { failed: true, responseBody: 'failed-response', httpStatus: 500, responseHeaders: { 'content-type': 'application/json', 'x-echo': 'fixture-header-secret' } });
  root.finalize();
  assert.equal(group.request.profile, 'raw-error'); assert.equal(group.attempts.length, 1);
  assert.deepEqual(group.bodies.map((body) => body.text), ['failed-request-秘密', 'failed-response']);
  const metadata = JSON.stringify({ request: group.request, attempts: group.attempts });
  for (const forbidden of ['success-request', 'success-response', 'fixture-header-secret', 'account-secret', 'private']) assert.equal(metadata.includes(forbidden), false);
  assert.equal(group.bodies.every((body) => body.descriptor.redacted === false), true);
  assert.equal(group.request.headers, undefined);
  assert.deepEqual({ ...group.attempts[0].headers }, { 'content-type': 'application/json', authorization: '[REDACTED]' });
  assert.deepEqual({ ...group.attempts[0].responseHeaders }, { 'content-type': 'application/json' });
  assert.doesNotMatch(metadata, /text\/plain/);
});

test('raw full projects ingress, each native attempt and downstream headers without touching bodies', () => {
  const req = Object.assign(new EventEmitter(), { method: 'POST', url: '/v1/chat/completions', headers: { 'content-type': 'application/json', authorization: 'Bearer ingress-secret' }, rawHeaders: ['Content-Type', 'application/json', 'Authorization', 'Bearer ingress-secret'] });
  const response = { 'content-type': 'text/event-stream; charset=utf-8', 'set-cookie': 'id=downstream-secret' };
  const res = Object.assign(new EventEmitter(), { write() {}, end() {}, writeHead() { return this; }, getHeaders() { return response; } });
  let group;
  const store = { generation: 0, recordDrop() {}, failure() { assert.fail('publication failed'); }, open() { return Promise.resolve(); }, publish({ produce, release }) { group = produce(); release(); return Promise.resolve(true); } };
  const root = new DetailRoot(req, res, store, [], { profile: 'raw-full' });
  const first = root.attempt({ headers: { 'content-type': 'application/json', authorization: 'Bearer upstream-secret' }, body: 'request-secret-1', url: 'https://user:pass@fixture/?api_key=secret' });
  first.output.add('failed-response-secret'); first.output.end();
  root.settleAttempt(first, { failed: true, httpStatus: 500, responseHeaders: { 'content-type': 'application/json', 'set-cookie': 'id=upstream-secret' } });
  const second = root.attempt({ headers: { accept: 'text/event-stream' }, body: 'request-secret-2' });
  second.output.add('success-response-secret'); second.output.end();
  root.settleAttempt(second, { responseHeaders: { 'content-type': 'text/event-stream', authorization: 'Bearer upstream-secret' } });
  res.writeHead(200); root.output.add('downstream-body-secret'); root.output.end(); root.finalize();
  const metadata = JSON.stringify({ request: group.request, attempts: group.attempts });
  assert.deepEqual({ ...group.request.headers }, { 'content-type': 'application/json', authorization: '[REDACTED]' });
  assert.deepEqual({ ...group.request.responseHeaders }, { 'content-type': 'text/event-stream', 'set-cookie': '[REDACTED]' });
  assert.deepEqual({ ...group.attempts[0].headers }, { 'content-type': 'application/json', authorization: '[REDACTED]' });
  assert.deepEqual({ ...group.attempts[0].responseHeaders }, { 'content-type': 'application/json', 'set-cookie': '[REDACTED]' });
  assert.deepEqual({ ...group.attempts[1].headers }, { accept: 'text/event-stream' });
  assert.deepEqual({ ...group.attempts[1].responseHeaders }, { 'content-type': 'text/event-stream', authorization: '[REDACTED]' });
  assert.deepEqual(group.bodies.map((body) => body.text), ['', 'downstream-body-secret', 'request-secret-1', 'failed-response-secret', 'request-secret-2', 'success-response-secret']);
  for (const secret of ['ingress-secret', 'upstream-secret', 'downstream-secret', 'user:pass', 'api_key']) assert.equal(metadata.includes(secret), false);
  const validator = Object.create(DetailedLogStore.prototype);
  assert.doesNotThrow(() => validator.validate({ request: group.request, attempts: group.attempts, bodies: group.bodies.map((body) => body.descriptor) }, root.requestId, true, root.ts));
});

test('a preprojected empty response map cannot be repopulated from normalized native headers', () => {
  const req = Object.assign(new EventEmitter(), { method: 'POST', url: '/v1/chat/completions', headers: {} });
  const res = Object.assign(new EventEmitter(), { write() {}, end() {}, writeHead() { return this; }, getHeaders() { return {}; } });
  let group;
  const store = { generation: 0, recordDrop() {}, failure() { assert.fail('publication failed'); }, publish({ produce, release }) { group = produce(); release(); return Promise.resolve(true); } };
  const root = new DetailRoot(req, res, store, [], { profile: 'raw-error' });
  const attempt = root.attempt({ headers: {}, body: 'fixture request' });
  attempt.responseHeaders = projectRawHeaders({ 'content-type': 'application/json' }, Array.from({ length: 258 }, (_, i) => i % 2 ? 'private' : 'x-custom'));
  root.settleAttempt(attempt, { failed: true, httpStatus: 500, responseHeaders: { 'content-type': 'application/json' }, responseBody: 'fixture failure' });
  root.finalize();
  assert.deepEqual({ ...group.attempts[0].responseHeaders }, {});
  assert.equal(group.bodies.length, 2);
});

test('raw manifest validates safe headers on publication and read, old maps remain optional', async (t) => {
  const store = await setup(t), now = store.now(), item = rawGroup(now, randomUUID(), 'fixture raw');
  const invalid = rawGroup(now, randomUUID(), 'fixture rejected');
  assert.equal(await store.publish({ generation: store.generation, ts: now, requestId: invalid.requestId, profile: 'raw-full', release() {}, produce: () => { const group = invalid.produce(); group.request.headers = { authorization: 'fixture credential' }; return group; } }), false);
  assert.equal((await store.query()).items.some((row) => row.requestId === invalid.requestId), false);
  assert.equal(await store.publish({ generation: store.generation, ts: now, requestId: item.requestId, profile: 'raw-full', release() {}, produce: () => { const group = item.produce(); group.request.headers = projectRawHeaders({ 'content-type': 'application/json' }); return group; } }), true);
  const list = await store.query(); assert.equal(JSON.stringify(list).includes('headers'), false);
  assert.deepEqual((await store.detail(item.requestId)).request.headers, { 'content-type': 'application/json' });
  const dir = path.join(store.rawDir, `${now}-${item.requestId}`), manifest = JSON.parse(await fs.readFile(path.join(dir, 'manifest.json')));
  for (const unsafe of [{ authorization: 'Bearer fixture-secret' }, { authorization: 'gzip' }, { cookie: '0' }, { 'set-cookie': 'text/plain' }, { 'content-type': 'Bearer fixture-secret' }, { 'content-type': ['application/json'] }, Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`x-${i}`, 'fixture-secret']))]) {
    assert.throws(() => store.validate({ ...manifest, request: { ...manifest.request, headers: unsafe } }, item.requestId, true, now), SyntaxError);
  }
  manifest.request.headers = { 'content-type': 'Bearer fixture-secret' };
  await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  await assert.rejects(store.detail(item.requestId), { statusCode: 404 });
  await assert.rejects(store.body(item.requestId, manifest.bodies[0].bodyId), { statusCode: 404 });
  const old = publish(store, store.now(), 'old group'); assert.equal(await old.done, true);
  assert.equal((await store.detail(old.requestId)).request.headers, undefined);
});

test('raw error-only SSE keeps only the exact triggering event and failed request bytes', async () => {
  const req = Object.assign(new EventEmitter(), { method: 'POST', url: '/v1/chat/completions', headers: {} });
  const res = Object.assign(new EventEmitter(), { write() {}, end() {}, writeHead() {}, getHeaders() { return {}; } });
  let group;
  const store = { generation: 0, recordDrop() {}, publish({ produce, release }) { group = produce(); release(); return Promise.resolve(true); } };
  const root = new DetailRoot(req, res, store, [], { profile: 'raw-error' });
  const attempt = root.attempt({ body: '\ufefffailed-request', headers: { authorization: 'fixture-header-secret' }, url: 'http://fixture/chat/completions' });
  const success = Buffer.from('data: {"content":"ok"}\r\n\r\n');
  const failure = Buffer.from('data: {"error":"fixture-failed"}\r\n\r\n');
  const forwarded = [];
  for await (const chunk of observeStream(Readable.from([success, failure]), attempt.output)) forwarded.push(chunk);
  assert.deepEqual(Buffer.concat(forwarded), Buffer.concat([success, failure]));
  root.settleAttempt(attempt, { failed: true, httpStatus: 200, responseContentType: 'text/event-stream', responseBody: failure });
  root.finalize();
  assert.deepEqual(group.bodies.map((body) => body.text), ['\ufefffailed-request', failure.toString()]);
  assert.equal(group.bodies[1].descriptor.capturedBytes, failure.length);
  assert.doesNotMatch(JSON.stringify({ request: group.request, attempts: group.attempts }), /fixture-header-secret|fixture-failed|failed-request/);
});

test('raw error response uses observed upstream bytes, not replacement-decoded error text', async () => {
  const req = Object.assign(new EventEmitter(), { method: 'POST', url: '/v1/chat/completions', headers: {} });
  const res = Object.assign(new EventEmitter(), { write() {}, end() {}, writeHead() {}, getHeaders() { return {}; } });
  let group;
  const store = { generation: 0, recordDrop() {}, failure() { assert.fail('unexpected publish failure'); }, publish({ produce, release }) { group = produce(); release(); return Promise.resolve(true); } };
  const root = new DetailRoot(req, res, store, [], { profile: 'raw-error' });
  const attempt = root.attempt({ body: '{}', url: 'http://fixture/chat/completions' });
  for await (const _ of observeStream(Readable.from([Buffer.from([0xff])]), attempt.output)) {}
  root.settleAttempt(attempt, { failed: true, httpStatus: 500, responseContentType: 'application/json', responseBody: '�' });
  root.finalize();
  assert.equal(group.bodies.length, 2);
  assert.equal(group.bodies[1].descriptor.state, 'omitted-for-safety');
  assert.equal(group.bodies[1].text, '');
});
