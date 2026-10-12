import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { JsonlLogGroup, ORDINARY_LOG_FILTERS } from '../lib/jsonl-log-store.js';

const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), name));
const streams = (requests = 50_000, errors = 10_000) => ({
  requests: { maxRecords: requests, filters: ORDINARY_LOG_FILTERS.requests },
  errors: { maxRecords: errors, filters: ORDINARY_LOG_FILTERS.errors },
});
const options = (dir, extra = {}) => ({
  dir,
  streams: streams(),
  maxAgeMs: 30 * 24 * 60 * 60 * 1000,
  segmentBytes: 5 * 1024 * 1024,
  maxTotalBytes: 100 * 1024 * 1024,
  ...extra,
});

function countedIo(overrides = {}) {
  const calls = { readdir: 0, readFile: 0, stat: 0, lstat: 0 };
  const io = new Proxy(fsp, {
    get(target, property) {
      if (property in overrides) return overrides[property];
      const value = target[property];
      if (typeof value !== 'function') return value;
      return (...args) => {
        if (Object.hasOwn(calls, property)) calls[property]++;
        return value.apply(target, args);
      };
    },
  });
  return { io, calls };
}

async function close(group) { if (group) await group.close(); }

test('startup recovery is asynchronous, queries are truthful and recovery-time appends survive', async (t) => {
  const dir = tmp('cps-jsonl-startup-'); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const now = Date.now();
  fs.writeFileSync(path.join(dir, 'requests-legacy.jsonl'), `${JSON.stringify({ ts: now, requestId: 'legacy', strategy: 'single' })}\n`, { mode: 0o600 });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let held = true;
  const counted = countedIo({
    async readdir(...args) {
      if (held) { held = false; await gate; }
      counted.calls.readdir++;
      return fsp.readdir(...args);
    },
  });
  const group = new JsonlLogGroup(options(dir, { io: counted.io }));
  t.after(() => close(group));
  await group.append('requests', { ts: now + 1, requestId: 'during-recovery', strategy: 'sticky' });
  await assert.rejects(group.query('requests'), (error) => error?.statusCode === 503 && /initializing/.test(error.message));
  await assert.rejects(group.clear('requests'), (error) => error?.statusCode === 503);
  release(); await group.ready;
  const page = await group.query('requests', { limit: 10 });
  assert.deepEqual(page.items.map((row) => row.requestId), ['during-recovery', 'legacy']);
});

test('ready append and below-threshold maintenance never scan historical segments', async (t) => {
  const dir = tmp('cps-jsonl-hot-'); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (let i = 0; i < 3; i++) fs.writeFileSync(path.join(dir, `requests-old-${i}.jsonl`), `${JSON.stringify({ ts: i + 1, requestId: `old-${i}`, strategy: 'single' })}\n`, { mode: 0o600 });
  const counted = countedIo(), group = new JsonlLogGroup(options(dir, { io: counted.io }));
  t.after(() => close(group)); await group.ready;
  for (const key of Object.keys(counted.calls)) counted.calls[key] = 0;
  const now = Date.now();
  for (let i = 0; i < 100; i++) await group.append('requests', { ts: now + i, requestId: `new-${i}`, strategy: 'sticky' });
  await group.maintain();
  assert.deepEqual(counted.calls, { readdir: 0, readFile: 0, stat: 0, lstat: 0 });
  const page = await group.query('requests', { limit: 2 });
  assert.deepEqual(page.items.map((row) => row.requestId), ['new-99', 'new-98']);
  assert.ok(counted.calls.readFile <= 1, `first page read ${counted.calls.readFile} segments`);
});

test('rolling, restart, malformed tails, filtering, expiry and independent clear remain compatible', async (t) => {
  const dir = tmp('cps-jsonl-compat-'); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const now = Date.now();
  let group = new JsonlLogGroup(options(dir, { maxAgeMs: 5_000, segmentBytes: 180, streams: streams(3, 3) }));
  await group.ready;
  await group.append('requests', { ts: now - 10_000, requestId: 'expired', strategy: 'single' });
  for (let i = 0; i < 5; i++) await group.append('requests', { ts: now + i, requestId: `r${i}`, strategy: i % 2 ? 'sticky' : 'roundrobin' });
  await group.append('errors', { ts: now, requestId: 'e1', attemptIndex: 0, category: 'network' });
  await group.maintain();
  assert.deepEqual((await group.query('requests', { limit: 10 })).items.map((row) => row.requestId), ['r4', 'r3', 'r2']);
  assert.ok((await group.query('requests', { filters: { strategy: 'sticky' } })).items.every((row) => row.strategy === 'sticky'));
  await close(group);
  const last = fs.readdirSync(dir).filter((name) => name.startsWith('requests-') && name.endsWith('.jsonl')).sort().at(-1);
  fs.appendFileSync(path.join(dir, last), '{"incomplete":');
  group = new JsonlLogGroup(options(dir, { maxAgeMs: 5_000, segmentBytes: 180, streams: streams(3, 3) }));
  t.after(() => close(group)); await group.ready;
  assert.equal((await group.query('requests', { limit: 10 })).items.length, 3);
  await group.clear('requests');
  assert.equal((await group.query('requests')).items.length, 0);
  assert.equal((await group.query('errors')).items.length, 1, 'clearing requests must not clear errors');
});

test('combined byte cap removes oldest records across both streams by reading only the boundary segment', async (t) => {
  const dir = tmp('cps-jsonl-total-'); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const counted = countedIo();
  const group = new JsonlLogGroup(options(dir, { io: counted.io, segmentBytes: 400, maxTotalBytes: 10_000, streams: streams(10, 10) }));
  t.after(() => close(group)); await group.ready;
  const now = Date.now();
  await group.append('requests', { ts: now, requestId: 'old', pad: 'x'.repeat(220) });
  await group.append('errors', { ts: now + 1, requestId: 'new', attemptIndex: 0, pad: 'y'.repeat(220) });
  for (const key of Object.keys(counted.calls)) counted.calls[key] = 0;
  group.maxTotalBytes = 420;
  await group.maintain();
  assert.equal(counted.calls.readdir, 0);
  assert.equal(counted.calls.readFile, 1, 'only the oldest boundary segment is read');
  assert.equal((await group.query('requests')).items.length, 0);
  assert.equal((await group.query('errors')).items[0].requestId, 'new');
  assert.ok(fs.readdirSync(dir).filter((file) => file.endsWith('.jsonl')).every((file) => fs.statSync(path.join(dir, file)).size <= 420));
});

test('recovery rewrites dirty segments from disk with full payloads and deduplicated', async (t) => {
  const dir = tmp('cps-jsonl-recovery-rewrite-'); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const now = Date.now();
  const row = (i, extra = {}) => JSON.stringify({ ts: now + i, requestId: `r${i}`, pipelineSteps: [{ step: i, pad: 'p'.repeat(50) }], ...extra });
  const anonymous = JSON.stringify({ ts: now + 9, note: 'no-request-id' });
  fs.writeFileSync(path.join(dir, 'requests-a.jsonl'), `${row(1)}\n${row(2)}\n${anonymous}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(dir, 'requests-b.jsonl'), `${row(2, { strategy: 'dup' })}\n${row(3)}\n${anonymous}\n{"incomplete":`, { mode: 0o600 });
  fs.writeFileSync(path.join(dir, 'requests-c.jsonl'), `${row(4)}\n`, { mode: 0o600 });
  const group = new JsonlLogGroup(options(dir)); t.after(() => close(group)); await group.ready;
  const items = (await group.query('requests', { limit: 10 })).items;
  assert.deepEqual(items.map((item) => item.requestId ?? item.note).sort(), ['no-request-id', 'r1', 'r2', 'r3', 'r4']);
  assert.equal(items.find((item) => item.requestId === 'r2').strategy, 'dup', 'later duplicate wins');
  assert.ok(items.filter((item) => item.requestId).every((item) => item.pipelineSteps[0].pad.length === 50), 'rewritten rows keep nested payloads');
  const names = fs.readdirSync(dir).filter((name) => name.endsWith('.jsonl'));
  assert.ok(names.includes('requests-c.jsonl'), 'clean segments are kept in place');
  assert.ok(!names.includes('requests-a.jsonl') && !names.includes('requests-b.jsonl'), 'dirty segments are replaced');
  assert.ok(names.every((name) => !fs.readFileSync(path.join(dir, name), 'utf8').includes('"incomplete":')));
});

test('recovery catalog overflow preserves disk data and exposes safe unavailability', async (t) => {
  const dir = tmp('cps-jsonl-recovery-cap-'); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (let i = 0; i < 2; i++) fs.writeFileSync(path.join(dir, `requests-${i}.jsonl`), `${JSON.stringify({ ts: Date.now() + i, requestId: `r${i}` })}\n`, { mode: 0o600 });
  const group = new JsonlLogGroup(options(dir, { maxSegments: 1 })); t.after(() => close(group));
  await assert.rejects(group.ready, /catalog capacity/);
  await assert.rejects(group.query('requests'), (error) => error?.statusCode === 503 && /unavailable/.test(error.message));
  assert.equal(fs.readdirSync(dir).filter((name) => name.endsWith('.jsonl')).length, 2);
});

test('append storage failure is fail-open and leaves the queryable catalog truthful', async (t) => {
  const dir = tmp('cps-jsonl-fail-open-'); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const counted = countedIo({ async open() { throw Object.assign(new Error('PRIVATE fixture path'), { code: 'EIO' }); } });
  const group = new JsonlLogGroup(options(dir, { io: counted.io })); t.after(() => close(group)); await group.ready;
  await group.append('requests', { ts: Date.now(), requestId: 'not-persisted' });
  assert.equal(group.health.failures, 1);
  assert.equal(group.health.lastFailure, 'ordinary-log-write-failed');
  assert.equal((await group.query('requests')).items.length, 0);
});

test('cursor distinguishes equal-timestamp error attempts and stale cursor restarts safely', async (t) => {
  const dir = tmp('cps-jsonl-cursor-'); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const group = new JsonlLogGroup(options(dir)); t.after(() => close(group)); await group.ready;
  for (let attemptIndex = 0; attemptIndex < 3; attemptIndex++) await group.append('errors', { ts: 10, requestId: 'same', attemptIndex });
  const first = await group.query('errors', { limit: 1 });
  const second = await group.query('errors', { limit: 1, cursor: first.nextCursor });
  const third = await group.query('errors', { limit: 1, cursor: second.nextCursor });
  assert.deepEqual(new Set([first.items[0].attemptIndex, second.items[0].attemptIndex, third.items[0].attemptIndex]), new Set([0, 1, 2]));
  assert.equal(third.nextCursor, null);
  await group.clear('errors');
  await group.append('errors', { ts: 20, requestId: 'fresh', attemptIndex: 0 });
  assert.equal((await group.query('errors', { limit: 1, cursor: first.nextCursor })).items[0].requestId, 'fresh');
});

test('single-record and pending record/byte fences drop diagnostics without growing a blocked queue', async (t) => {
  const dir = tmp('cps-jsonl-pending-'); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let releaseWrite;
  const gate = new Promise((resolve) => { releaseWrite = resolve; });
  let block = true;
  const io = {
    ...fsp,
    async open(...args) {
      const handle = await fsp.open(...args);
      return {
        write: async (...writeArgs) => { if (block) await gate; return handle.write(...writeArgs); },
        read: (...readArgs) => handle.read(...readArgs),
        close: (...closeArgs) => handle.close(...closeArgs),
      };
    },
  };
  const group = new JsonlLogGroup(options(dir, {
    io,
    maxRecordBytes: 256,
    maxPendingRecords: 2,
    maxPendingBytes: 320,
  }));
  t.after(() => close(group)); await group.ready;
  const first = group.append('errors', { ts: 1, requestId: 'first', attemptIndex: 0, reason: 'a'.repeat(60) });
  const second = group.append('errors', { ts: 2, requestId: 'second', attemptIndex: 0, reason: 'b'.repeat(60) });
  const dropped = await group.append('errors', { ts: 3, requestId: 'third', attemptIndex: 0, reason: 'c'.repeat(60) });
  assert.equal(dropped, false);
  assert.equal(group.health.pendingRecords, 2);
  assert.ok(group.health.pendingBytes <= 320);
  assert.equal(group.health.dropped, 1);
  assert.equal(await group.append('errors', { ts: 4, requestId: 'oversized', attemptIndex: 0, reason: 'x'.repeat(300) }), false);
  assert.equal(group.health.dropped, 2);
  block = false; releaseWrite(); await Promise.all([first, second]);
  assert.equal(group.health.pendingRecords, 0); assert.equal(group.health.pendingBytes, 0);
  assert.deepEqual(new Set((await group.query('errors')).items.map((row) => row.requestId)), new Set(['first', 'second']));
});

function seeded(seed) {
  let state = seed >>> 0;
  return () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 2 ** 32; };
}

function corpusRecord(prefix, random, i, base) {
  const pick = (list) => list[Math.floor(random() * list.length)];
  const record = { ts: base + Math.floor(i / 3) };
  if (i % 3 === 0 && random() < 0.3) {
    const anonymous = pick([undefined, 0, '']);
    if (anonymous !== undefined) record.requestId = anonymous;
  } else if (random() < 0.1) record.requestId = 10_000 + i;
  else record.requestId = `${pick(['req-', 'Req-', 'REQ-'])}${i}-${pick(['a', 'B', 'cd'])}`;
  const optional = (key, values) => { const value = pick(values); if (value !== undefined) record[key] = value; };
  optional('requestedModel', ['pc/DeepSeek-v4', 'gpt-5', 'cline-pass/glm', undefined]);
  optional('resolvedModel', ['cline-pass/deepseek-v4', 'cline-pass/GLM', null, undefined]);
  optional('accountId', ['a1', 'A2', 'acc-3', undefined]);
  optional('accountName', ['Alpha', 'beta', null, undefined]);
  optional('status', [200, 200, 429, 500, '500', null, undefined]);
  optional('upstreamStatus', [200, 503, null, undefined]);
  optional('accountAction', ['cooldown', { type: 'degrade', id: 'a1' }, undefined]);
  optional('accountActions', [[{ action: 'cooldown', accountId: 'a1' }], [], ['hard-quarantine'], undefined]);
  record.pad = 'p'.repeat(Math.floor(random() * 120));
  if (prefix === 'requests') {
    optional('strategy', ['sticky', 'roundrobin', 'load-health', undefined]);
    optional('result', ['success', 'failed', 'client_cancelled', undefined]);
    optional('stream', [true, false, 'true', undefined]);
    optional('actualProvider', ['deepseek', 'Fireworks', null, undefined]);
    optional('targetProviders', [['deepseek', 'fireworks'], ['alibaba'], 'deepseek', undefined]);
    optional('overflow', [true, false, undefined]);
    optional('switched', [true, false, undefined]);
    optional('errorCategory', ['capacity', 'upstream', 'proxy', null, undefined]);
  } else {
    const attempt = pick([0, 1, 2, undefined, '01', '2']);
    if (attempt !== undefined) record.attemptIndex = attempt;
    optional('targetProvider', ['deepseek', 'Fireworks', undefined]);
    optional('providerPath', [['deepseek', 'alibaba'], [], undefined]);
    for (const key of ['category', 'ruleId', 'ruleScope', 'ruleAction', 'errorScope', 'failureClass', 'healthAction']) optional(key, [`${key}-x`, `${key.toUpperCase()}-Y`, undefined]);
    optional('scopeEvidence', [['status', 'body'], 'header', undefined]);
    optional('responseContentType', ['application/json', 'text/html', undefined]);
  }
  return record;
}

async function walk(fetchPage, filters, limit) {
  const items = [], cursors = [];
  let cursor = '';
  for (let page = 0; page < 1_000; page++) {
    const result = await fetchPage({ limit, cursor, filters });
    items.push(...result.items); cursors.push(result.nextCursor);
    if (!result.nextCursor) break;
    cursor = result.nextCursor;
  }
  return { items, cursors };
}

async function assertEquivalent(group, prefix, filters, limit = 9) {
  const indexed = await walk((options) => group.query(prefix, options), filters, limit);
  const legacy = await walk((options) => group._legacyQueryPass(prefix, options, true), filters, limit);
  assert.deepEqual(indexed.items, legacy.items, `${prefix} ${JSON.stringify(filters)} items`);
  assert.deepEqual(indexed.cursors, legacy.cursors, `${prefix} ${JSON.stringify(filters)} cursors`);
  return indexed.items;
}

const FILTER_VALUES = {
  from: (base) => [String(base + 20), base + 1_000],
  to: (base) => [String(base + 30), 'nan'],
  requestId: () => ['req-1', 'REQ-12', '1-b', '10005', 'zzz', true],
  status: () => ['500', '200', '429', '0'],
  upstreamStatus: () => ['503', '200'],
  stream: () => [true, false, 'true'],
  overflow: () => [true, false],
  switched: () => [true, false],
};
const GENERIC_VALUES = ['a', 'DEEP', 'cool', 'zzz', 'x', '1', '"', 'Y'];

async function buildCorpus(group, base, count = { requests: 240, errors: 150 }) {
  for (const prefix of ['requests', 'errors']) {
    const random = seeded(prefix === 'requests' ? 7 : 11);
    const order = Array.from({ length: count[prefix] }, (_, i) => i).sort(() => random() - 0.5);
    for (const i of order) await group.append(prefix, corpusRecord(prefix, random, i, base));
  }
}

test('indexed filtering and pagination are equivalent to the legacy full scan for every whitelisted key', async (t) => {
  const dir = tmp('cps-jsonl-equivalence-'); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const base = Date.now() - 60_000;
  let group = new JsonlLogGroup(options(dir, { segmentBytes: 3_000 }));
  await group.ready;
  await buildCorpus(group, base);
  assert.ok(group.files('requests').length > 5, 'corpus spans several segments');
  const random = seeded(3);
  const check = async () => {
    for (const prefix of ['requests', 'errors']) {
      assert.equal((await assertEquivalent(group, prefix, {})).length, prefix === 'requests' ? 240 : 150);
      for (const key of ORDINARY_LOG_FILTERS[prefix]) {
        for (const value of (FILTER_VALUES[key]?.(base) ?? GENERIC_VALUES)) await assertEquivalent(group, prefix, { [key]: value });
      }
      for (let i = 0; i < 25; i++) {
        const keys = ORDINARY_LOG_FILTERS[prefix].filter(() => random() < 0.12);
        const filters = Object.fromEntries(keys.map((key) => { const values = FILTER_VALUES[key]?.(base) ?? GENERIC_VALUES; return [key, values[Math.floor(random() * values.length)]]; }));
        await assertEquivalent(group, prefix, filters, 1 + Math.floor(random() * 20));
      }
      await assertEquivalent(group, prefix, { pad: 'ppppp' }, 4);
      await assertEquivalent(group, prefix, { pad: 'p'.repeat(119), model: 'deep' }, 3);
    }
  };
  await check();
  await close(group);
  group = new JsonlLogGroup(options(dir, { segmentBytes: 3_000 }));
  t.after(() => close(group)); await group.ready;
  assert.equal(group.health.sidecarsRejected, 0);
  await check();
});

test('old cursors resume, vanished cursor segments restart and walks never repeat or skip rows', async (t) => {
  const dir = tmp('cps-jsonl-cursor-walk-'); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const base = Date.now() - 60_000;
  const group = new JsonlLogGroup(options(dir, { segmentBytes: 2_000 })); t.after(() => close(group)); await group.ready;
  for (let i = 0; i < 90; i++) await group.append('errors', { ts: base + Math.floor(i / 4), requestId: `r-${Math.floor(i / 3)}`, attemptIndex: i % 3, pad: 'z'.repeat(40) });
  const legacyFirst = await group._legacyQueryPass('errors', { limit: 10, cursor: '', filters: {} }, true);
  const legacySecond = await group._legacyQueryPass('errors', { limit: 10, cursor: legacyFirst.nextCursor, filters: {} }, true);
  assert.deepEqual(await group.query('errors', { limit: 10, cursor: legacyFirst.nextCursor }), legacySecond);
  const seen = new Set();
  let cursor = '', pages = 0;
  do {
    const page = await group.query('errors', { limit: 7, cursor });
    for (const row of page.items) { const key = `${row.requestId}/${row.attemptIndex}`; assert.ok(!seen.has(key), `duplicate ${key}`); seen.add(key); }
    cursor = page.nextCursor; pages++;
  } while (cursor);
  assert.equal(seen.size, 90); assert.equal(pages, 13);
  const gone = Buffer.from(JSON.stringify({ ts: base, requestId: 'r-1', attemptIndex: 0, segment: 'errors-gone.jsonl', line: 0 })).toString('base64url');
  assert.deepEqual(await group.query('errors', { limit: 5, cursor: gone }), await group.query('errors', { limit: 5 }));
});

test('exact requestId and sparse filters read only hit rows by offset without readFile', async (t) => {
  const dir = tmp('cps-jsonl-offset-'); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const opened = [];
  const counted = countedIo({ async open(file, flags, mode) { if (flags === 'r') opened.push(path.basename(file)); return fsp.open(file, flags, mode); } });
  const group = new JsonlLogGroup(options(dir, { io: counted.io, segmentBytes: 2_000 })); t.after(() => close(group)); await group.ready;
  const base = Date.now() - 60_000, ids = [];
  for (let i = 0; i < 200; i++) {
    const requestId = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
    ids.push(requestId);
    await group.append('requests', { ts: base + i, requestId, status: i % 67 === 5 ? 500 : 200, pad: 'q'.repeat(60) });
  }
  assert.ok(group.files('requests').length > 10);
  counted.calls.readFile = 0; opened.length = 0;
  const target = ids[37];
  const exact = await group.query('requests', { filters: { requestId: target.toUpperCase() } });
  assert.deepEqual(exact.items.map((row) => row.requestId), [target]);
  assert.equal(counted.calls.readFile, 0);
  assert.equal(opened.length, 1, 'only the hit segment is opened');
  assert.ok(fs.readFileSync(path.join(dir, opened[0]), 'utf8').includes(target));
  opened.length = 0;
  const sparse = await group.query('requests', { filters: { status: '500' } });
  assert.deepEqual(sparse.items.map((row) => row.requestId), [ids[139], ids[72], ids[5]]);
  assert.equal(counted.calls.readFile, 0);
  assert.ok(opened.length <= 3, `opened ${opened.length} segments for three hits`);
  opened.length = 0;
  let cursor = '';
  for (let page = 0; page < 9; page++) cursor = (await group.query('requests', { limit: 10, cursor })).nextCursor;
  opened.length = 0;
  const tenth = await group.query('requests', { limit: 10, cursor });
  assert.deepEqual(tenth.items.map((row) => row.requestId), ids.slice(100, 110).reverse());
  assert.equal(counted.calls.readFile, 0);
  assert.ok(opened.length <= 2, 'page ten opens only the segments holding its rows');
});

test('sidecars are written for immutable segments and let restart skip parsing closed segments', async (t) => {
  const dir = tmp('cps-jsonl-sidecar-'); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const base = Date.now() - 60_000;
  let group = new JsonlLogGroup(options(dir, { segmentBytes: 3_000 }));
  await group.ready;
  for (let i = 0; i < 120; i++) await group.append('requests', { ts: base + i, requestId: `s-${i}`, accountName: `acc-${i % 4}`, status: i % 10 ? 200 : 500, pad: 'w'.repeat(30) });
  for (let i = 0; i < 30; i++) await group.append('errors', { ts: base + i, requestId: `s-${i}`, attemptIndex: i % 2, category: 'network' });
  const segmentNames = () => fs.readdirSync(dir).filter((name) => name.endsWith('.jsonl')).sort();
  const sidecarNames = () => fs.readdirSync(dir).filter((name) => name.endsWith('.jsonl.idx')).sort();
  assert.equal(sidecarNames().length, segmentNames().length - 2, 'every rolled segment has a sidecar; active ones do not yet');
  const before = { requests: await walk((o) => group.query('requests', o), { status: '500' }, 4), errors: await walk((o) => group.query('errors', o), {}, 7) };
  await close(group);
  assert.deepEqual(sidecarNames(), segmentNames().map((name) => `${name}.idx`), 'shutdown persists active sidecars');
  for (const name of sidecarNames()) assert.equal(fs.statSync(path.join(dir, name)).mode & 0o777, 0o600);

  const reads = [];
  const counted = countedIo({ async readFile(file, ...rest) { reads.push(path.basename(String(file))); return fsp.readFile(file, ...rest); } });
  group = new JsonlLogGroup(options(dir, { segmentBytes: 3_000, io: counted.io }));
  await group.ready;
  assert.ok(reads.length > 0 && reads.every((name) => name.endsWith('.jsonl.idx')), `restart read ${reads.filter((name) => !name.endsWith('.idx'))}`);
  assert.deepEqual(await walk((o) => group.query('requests', o), { status: '500' }, 4), before.requests);
  assert.deepEqual(await walk((o) => group.query('errors', o), {}, 7), before.errors);
  await close(group);

  const requestSegments = segmentNames().filter((name) => name.startsWith('requests-'));
  const sidecarOf = (name) => path.join(dir, `${name}.idx`);
  fs.rmSync(sidecarOf(requestSegments[0]));
  fs.truncateSync(sidecarOf(requestSegments[1]), 40);
  const tampered = fs.readFileSync(sidecarOf(requestSegments[2]), 'utf8').replace('acc-1', 'acc-9');
  fs.writeFileSync(sidecarOf(requestSegments[2]), tampered);
  const [header, body] = (() => { const text = fs.readFileSync(sidecarOf(requestSegments[3]), 'utf8'); const split = text.indexOf('\n'); return [JSON.parse(text.slice(0, split)), JSON.parse(text.slice(split + 1))]; })();
  body.filters = body.filters.slice(1);
  const foreign = JSON.stringify(body);
  fs.writeFileSync(sidecarOf(requestSegments[3]), `${JSON.stringify({ ...header, sha256: createHash('sha256').update(foreign).digest('hex') })}\n${foreign}`);
  fs.appendFileSync(path.join(dir, requestSegments[4]), `${JSON.stringify({ ts: base + 500, requestId: 'late', status: 500 })}\n`);
  fs.writeFileSync(path.join(dir, 'requests-ghost.jsonl.idx'), 'orphan');
  fs.writeFileSync(path.join(dir, `.${requestSegments[0]}.idx.tmp`), 'stray');

  reads.length = 0;
  group = new JsonlLogGroup(options(dir, { segmentBytes: 3_000, io: counted.io }));
  t.after(() => close(group)); await group.ready;
  const reparsed = reads.filter((name) => name.endsWith('.jsonl')).sort();
  assert.deepEqual(reparsed, requestSegments.slice(0, 5).sort(), 'only segments with missing or invalid sidecars are parsed');
  assert.equal(group.health.sidecarsRejected, 4);
  const after = await walk((o) => group.query('requests', o), { status: '500' }, 4);
  assert.deepEqual(after.items.map((row) => row.requestId), ['late', ...before.requests.items.map((row) => row.requestId)]);
  assert.ok(!fs.existsSync(path.join(dir, 'requests-ghost.jsonl.idx')), 'orphan sidecar removed');
  assert.ok(!fs.existsSync(path.join(dir, `.${requestSegments[0]}.idx.tmp`)), 'stray temp removed');
  assert.deepEqual(sidecarNames(), segmentNames().map((name) => `${name}.idx`), 'rebuilt sidecars cover every closed segment');
  await assertEquivalent(group, 'requests', { account: 'acc-1' });

  await group.clear('requests');
  assert.ok(!fs.readdirSync(dir).some((name) => name.startsWith('requests-')), 'clear removes request segments and sidecars');
  assert.ok(fs.readdirSync(dir).some((name) => name.startsWith('errors-') && name.endsWith('.idx')), 'clear keeps error sidecars');
});

test('maintenance keeps the index, sidecars and catalog consistent', async (t) => {
  const dir = tmp('cps-jsonl-maintain-index-'); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let now = Date.now();
  const group = new JsonlLogGroup(options(dir, { now: () => now, maxAgeMs: 100_000, segmentBytes: 1_500, maxTotalBytes: 1_000_000, streams: streams(150, 40) }));
  t.after(() => close(group)); await group.ready;
  await buildCorpus(group, now - 50_000, { requests: 200, errors: 60 });
  await group.maintain();
  for (const prefix of ['requests', 'errors']) await assertEquivalent(group, prefix, { model: 'deep' });
  assert.equal((await assertEquivalent(group, 'requests', {})).length, 150);
  assert.equal((await assertEquivalent(group, 'errors', {})).length, 40);
  now += 50_040;
  await group.maintain();
  await assertEquivalent(group, 'requests', { status: '500' });
  group.maxTotalBytes = 6_000;
  await group.maintain();
  for (const prefix of ['requests', 'errors']) await assertEquivalent(group, prefix, {}, 5);
  const segments = fs.readdirSync(dir).filter((name) => name.endsWith('.jsonl'));
  for (const name of fs.readdirSync(dir).filter((file) => file.endsWith('.idx'))) assert.ok(segments.includes(name.slice(0, -4)), `orphan sidecar ${name}`);
});

test('index row fence degrades to the full scan path and recovers when rows fit again', async (t) => {
  const dir = tmp('cps-jsonl-degraded-'); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const group = new JsonlLogGroup(options(dir, { segmentBytes: 1_000, maxIndexRows: 20 })); t.after(() => close(group)); await group.ready;
  const base = Date.now() - 60_000;
  await buildCorpus(group, base, { requests: 60, errors: 10 });
  assert.equal(group.health.indexDegraded, true);
  await assertEquivalent(group, 'requests', { account: 'a' });
  await assertEquivalent(group, 'errors', { category: 'x' });
  group.maxIndexRows = 1_000;
  await group.maintain();
  assert.equal(group.health.indexDegraded, false);
  await assertEquivalent(group, 'requests', { account: 'a' });
  await assertEquivalent(group, 'requests', { requestId: 'req-1' });
});

test('exact requestId lookup keeps rows with irregular attemptIndex and mixed-length case-insensitive ids', async (t) => {
  const dir = tmp('cps-jsonl-exact-irregular-'); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const base = Date.now() - 60_000;
  let group = new JsonlLogGroup(options(dir, { segmentBytes: 400 }));
  await group.ready;
  const rows = [
    { requestId: 'Abc', attemptIndex: '01' }, { requestId: 'abc', attemptIndex: 2 }, { requestId: 'xABCx', attemptIndex: 0 },
    { requestId: 'ABC', attemptIndex: [1] }, { requestId: 'zz', attemptIndex: null }, { requestId: 0, attemptIndex: '3' },
  ];
  for (let i = 0; i < 24; i++) await group.append('errors', { ts: base + (i >> 1), ...rows[i % rows.length], pad: 'e'.repeat(30) });
  const check = async () => {
    for (const requestId of ['abc', 'ABC', 'aBc', 'XABCX', 'xabcx', 'ZZ', '0', 'nope']) await assertEquivalent(group, 'errors', { requestId }, 4);
  };
  await check();
  assert.equal((await group.query('errors', { filters: { requestId: 'XABCX' } })).items.length, 4);
  await close(group);
  group = new JsonlLogGroup(options(dir, { segmentBytes: 400 }));
  t.after(() => close(group)); await group.ready;
  await check();
});

test('a same-size rewritten segment is answered from disk in the same query and reindexed', async (t) => {
  const dir = tmp('cps-jsonl-same-size-'); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const base = Date.now() - 60_000;
  const group = new JsonlLogGroup(options(dir, { segmentBytes: 600 }));
  t.after(() => close(group)); await group.ready;
  for (let i = 0; i < 30; i++) await group.append('requests', { ts: base + i, requestId: `id-${String(i).padStart(2, '0')}`, status: 200 });
  const victim = group.files('requests')[0];
  const file = path.join(dir, victim);
  const original = fs.readFileSync(file, 'utf8');
  const swapped = original.replace(/"id-(\d\d)","status":200/g, (_, n) => `"ix-${n}","status":500`);
  assert.equal(Buffer.byteLength(swapped), Buffer.byteLength(original));
  fs.writeFileSync(file, swapped);
  const disk = await group._legacyQueryPass('requests', { limit: 50, cursor: '', filters: {} }, true);
  assert.deepEqual(await group.query('requests', { limit: 50 }), disk);
  assert.ok(disk.items.some((row) => row.requestId.startsWith('ix-')));
  await group.maintain();
  assert.equal(group.health.indexDegraded, false);
  await assertEquivalent(group, 'requests', { status: '500' }, 3);
  await assertEquivalent(group, 'requests', { requestId: 'IX-01' }, 3);
});
