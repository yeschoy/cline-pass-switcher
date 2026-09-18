import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JsonlLogGroup } from '../lib/jsonl-log-store.js';

const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), name));
const options = (dir, extra = {}) => ({
  dir,
  streams: { requests: { maxRecords: 50_000 }, errors: { maxRecords: 10_000 } },
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
  let group = new JsonlLogGroup(options(dir, { maxAgeMs: 5_000, segmentBytes: 180, streams: { requests: { maxRecords: 3 }, errors: { maxRecords: 3 } } }));
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
  group = new JsonlLogGroup(options(dir, { maxAgeMs: 5_000, segmentBytes: 180, streams: { requests: { maxRecords: 3 }, errors: { maxRecords: 3 } } }));
  t.after(() => close(group)); await group.ready;
  assert.equal((await group.query('requests', { limit: 10 })).items.length, 3);
  await group.clear('requests');
  assert.equal((await group.query('requests')).items.length, 0);
  assert.equal((await group.query('errors')).items.length, 1, 'clearing requests must not clear errors');
});

test('combined byte cap removes oldest records across both streams by reading only the boundary segment', async (t) => {
  const dir = tmp('cps-jsonl-total-'); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const counted = countedIo();
  const group = new JsonlLogGroup(options(dir, { io: counted.io, segmentBytes: 400, maxTotalBytes: 10_000, streams: { requests: { maxRecords: 10 }, errors: { maxRecords: 10 } } }));
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
