import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonlLogStore, enforceCombinedLimit } from '../lib/jsonl-log-store.js';

const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), name));

test('JSONL store rolls, survives restart, filters, paginates, expires and clears independently', async (t) => {
  const dir = tmp('cps-jsonl-'); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const old = Date.now() - 10_000;
  const requests = new JsonlLogStore({ dir, prefix: 'requests', maxRecords: 3, maxAgeMs: 5_000, segmentBytes: 80, totalBytes: 10_000 });
  const errors = new JsonlLogStore({ dir, prefix: 'errors', maxRecords: 3, maxAgeMs: 5_000, segmentBytes: 80, totalBytes: 10_000 });
  await requests.append({ ts: old, requestId: 'old', strategy: 'single' });
  for (let i = 0; i < 5; i++) await requests.append({ ts: Date.now() + i, requestId: `r${i}`, strategy: i % 2 ? 'sticky' : 'roundrobin' });
  await errors.append({ ts: Date.now(), requestId: 'e1', category: 'network' });
  const damaged = requests.files().at(-1);
  fs.appendFileSync(path.join(dir, damaged), '{"incomplete":');
  requests.compact();
  assert.ok(requests.files().every((file) => fs.statSync(path.join(dir, file)).size <= 80), 'compaction must retain segment bounds');
  const restarted = new JsonlLogStore({ dir, prefix: 'requests', maxRecords: 3, maxAgeMs: 5_000, segmentBytes: 80, totalBytes: 10_000 });
  const page = restarted.query({ limit: 2 });
  assert.equal(page.items.length, 2); assert.ok(page.nextCursor);
  assert.equal(restarted.query({ limit: 2, cursor: page.nextCursor }).items.length, 1);
  assert.ok(restarted.query({ filters: { strategy: 'sticky' } }).items.every((x) => x.strategy === 'sticky'));
  assert.equal(restarted.query().items.some((x) => x.requestId === 'old'), false);
  await restarted.clear();
  assert.equal(restarted.query().items.length, 0);
  assert.equal(errors.query().items.length, 1, 'clearing request logs must not clear error logs');
});

test('combined JSONL byte cap removes oldest records across both types', async (t) => {
  const dir = tmp('cps-jsonl-total-'); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const a = new JsonlLogStore({ dir, prefix: 'requests', maxRecords: 10, totalBytes: 10000 });
  const b = new JsonlLogStore({ dir, prefix: 'errors', maxRecords: 10, totalBytes: 10000 });
  await a.append({ ts: 1, requestId: 'old', pad: 'x'.repeat(200) });
  await b.append({ ts: 2, requestId: 'new', pad: 'y'.repeat(200) });
  enforceCombinedLimit(dir, 300, 100);
  assert.equal(a.query().items.length, 0);
  assert.equal(b.query().items[0].requestId, 'new');
  assert.ok(fs.readdirSync(dir).filter((file) => file.endsWith('.jsonl')).every((file) => fs.statSync(path.join(dir, file)).size <= 300));
});

test('cursor distinguishes multiple error attempts with the same request id and timestamp', async (t) => {
  const dir = tmp('cps-jsonl-cursor-'); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new JsonlLogStore({ dir, prefix: 'errors', maxRecords: 10, segmentBytes: 10_000 });
  for (let attemptIndex = 0; attemptIndex < 3; attemptIndex++) await store.append({ ts: 10, requestId: 'same', attemptIndex });
  const first = store.query({ limit: 1 });
  const second = store.query({ limit: 1, cursor: first.nextCursor });
  const third = store.query({ limit: 1, cursor: second.nextCursor });
  assert.deepEqual(new Set([first.items[0].attemptIndex, second.items[0].attemptIndex, third.items[0].attemptIndex]), new Set([0, 1, 2]));
  assert.equal(third.nextCursor, null);
});
