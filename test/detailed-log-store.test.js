import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DetailedLogStore, parseDetailQuery } from '../lib/detailed-log-store.js';

async function setup(t, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cps-details-'));
  const store = new DetailedLogStore({ dir, ...options });
  await store.queue;
  t.after(async () => { await store.close(); await fs.rm(dir, { recursive: true, force: true }); });
  return store;
}
function publish(store, { ts = store.now(), text = 'sanitized prompt', generation = store.generation, requestId = randomUUID() } = {}) {
  const bodyId = randomUUID(); let released = false;
  return { requestId, bodyId, released: () => released, done: store.publish({ ts, requestId, generation, release: () => { released = true; }, produce: () => ({ request: { requestId, ts, status: 200, model: 'model', headers: { ordinary: 'not on listing' } }, attempts: [], bodies: [{ text, descriptor: { bodyId, capturedBytes: Buffer.byteLength(text) } }] }) }) };
}

test('independent owner-only groups, metadata-only paging, on-demand body and restart', async (t) => {
  let bodyReads = 0;
  const io = { ...fs, open: async (name, ...args) => { if (name.endsWith('.txt')) bodyReads++; return fs.open(name, ...args); } };
  const store = await setup(t, { io });
  const a = publish(store), b = publish(store); await a.done; await b.done;
  const first = await store.query({ limit: 1 });
  assert.equal(first.items.length, 1); assert.ok(first.nextCursor); assert.equal(bodyReads, 0);
  assert.equal(JSON.stringify(first).includes('not on listing'), false);
  const second = await store.query(parseDetailQuery(new URLSearchParams({ limit: '1', cursor: first.nextCursor })));
  assert.notEqual(first.items[0].requestId, second.items[0].requestId);
  assert.equal(await store.body(a.requestId, a.bodyId), 'sanitized prompt'); assert.equal(bodyReads, 1);
  assert.equal((await fs.stat(path.join(store.dir, a.requestId, a.bodyId + '.txt'))).mode & 0o777, 0o600);
  assert.equal((await fs.stat(store.dir)).mode & 0o777, 0o700);
  const restarted = new DetailedLogStore({ dir: store.dir }); t.after(() => restarted.close());
  assert.equal((await restarted.query()).items.length, 2);
  await store.clear(); assert.equal((await store.query()).items.length, 0);
  await assert.rejects(store.body(a.requestId, a.bodyId), { statusCode: 404 });
});

test('fixed drop reasons reconcile at every store admission edge, saturate and reset on restart', async (t) => {
  const store = await setup(t);
  const expected = Object.keys(store.health.dropReasons);
  assert.equal(store.health.dropped, 0);
  assert.ok(expected.length > 0 && expected.every((key) => store.health.dropReasons[key] === 0));
  const count = (key, total) => {
    assert.equal(store.health.dropReasons[key], total);
    assert.equal(Object.values(store.health.dropReasons).reduce((a, b) => a + b, 0), store.health.dropped);
  };
  const queue = store.pending; store.pending = 128;
  const blocked = publish(store); assert.equal(await blocked.done, false); assert.equal(blocked.released(), true);
  store.pending = queue; count('storeQueue', 1);
  const stale = publish(store, { generation: -1 }); assert.equal(await stale.done, false); count('storeStale', 1);
  const expired = publish(store, { ts: store.now() - store.maxAgeMs }); assert.equal(await expired.done, false); count('storeStale', 2);
  const invalid = publish(store, { requestId: 'invalid-id' }); assert.equal(await invalid.done, false); count('storeStale', 3);
  const missingOpen = store.publish({ generation: store.generation, ts: store.now(), requestId: randomUUID(), requireOpen: true, release() {}, produce() { assert.fail('no associated root'); } });
  assert.equal(await missingOpen, false); count('storeOpenRoot', 1);
  const accepted = publish(store); assert.equal(await accepted.done, true, 'normal publication does not count as dropped');
  const small = await setup(t, { maxTotalBytes: 1 });
  const sizeRejected = publish(small); assert.equal(await sizeRejected.done, false); assert.equal(small.health.dropReasons.storeSize, 1);
  const full = await setup(t, { maxInventoryEntries: 0 });
  const capacityRejected = publish(full); assert.equal(await capacityRejected.done, false); assert.equal(full.health.dropReasons.storeCapacity, 1);
  const hugeId = randomUUID(), hugeTs = store.now();
  const hugeManifest = store.publish({ generation: store.generation, ts: hugeTs, requestId: hugeId, release() {}, produce() {
    return { request: { requestId: hugeId, ts: hugeTs, model: 'x'.repeat(1024 * 1024) }, attempts: [], bodies: [] };
  } });
  assert.equal(await hugeManifest, false); count('storeSize', 1);
  store.failure(); store.health.corrupt++;
  assert.equal(store.health.failures, 1); assert.equal(store.health.corrupt, 1); assert.equal(store.health.dropped, 6);
  store.recordDrop('untrusted-label'); count('other', 1);
  const rebooted = new DetailedLogStore({ dir: store.dir }); t.after(() => rebooted.close()); await rebooted.queue;
  assert.equal(rebooted.health.dropped, 0); assert.ok(expected.every((key) => rebooted.health.dropReasons[key] === 0));
  // The saturation policy freezes the complete distribution rather than overflowing one bucket.
  store.health.dropped = Number.MAX_SAFE_INTEGER - 1;
  store.health.dropReasons = Object.fromEntries(expected.map((key) => [key, key === 'other' ? Number.MAX_SAFE_INTEGER - 1 : 0]));
  store.recordDrop('captureBudget'); count('captureBudget', 1);
  store.recordDrop('storeQueue'); count('storeQueue', 0);
  assert.equal(store.health.dropped, Number.MAX_SAFE_INTEGER);
});

test('late generation and open-root association fences count one reason and release publication', async (t) => {
  const store = await setup(t);
  const open = { requestId: randomUUID(), ts: store.now(), generation: store.generation, method: 'POST', pathname: '/v1/chat/completions' };
  assert.equal(await store.open(open), true);
  await fs.rm(path.join(store.dir, open.requestId, 'manifest.json'));
  let released = 0;
  const missing = await store.publish({ ...open, requireOpen: true, release() { released++; }, produce() { assert.fail('missing open root must not be materialized'); } });
  assert.equal(missing, false); assert.equal(released, 1);
  assert.equal(store.health.dropReasons.storeOpenRoot, 1);

  let lateClear;
  const io = { ...fs, writeFile: async (file, ...args) => {
    await fs.writeFile(file, ...args);
    if (String(file).endsWith('manifest.json') && String(file).includes('.tmp-')) lateClear = fenced.clear();
  } };
  const fenced = await setup(t, { io });
  const candidate = publish(fenced); assert.equal(await candidate.done, false);
  await lateClear;
  assert.equal(candidate.released(), true); assert.equal(fenced.pending, 0);
  assert.equal(fenced.health.dropReasons.storeStale, 1);
  assert.equal(fenced.health.dropped, 1);
  assert.equal(Object.values(fenced.health.dropReasons).reduce((a, b) => a + b, 0), 1);
  assert.equal((await fenced.query()).items.length, 0);
});

test('runtime publication, query and expiry reuse the startup inventory until explicit reconciliation', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cps-details-index-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const seed = new DetailedLogStore({ dir }); await seed.queue;
  const first = publish(seed); await first.done; await seed.close();

  let corpusOpens = 0, manifestReads = 0, bodyReads = 0;
  const io = {
    ...fs,
    opendir: async (name, ...args) => { if (String(name).startsWith(dir)) corpusOpens++; return fs.opendir(name, ...args); },
    open: async (name, ...args) => {
      if (String(name).startsWith(dir) && name.endsWith('manifest.json')) manifestReads++;
      if (String(name).startsWith(dir) && name.endsWith('.txt')) bodyReads++;
      return fs.open(name, ...args);
    }
  };
  const store = new DetailedLogStore({ dir, io }); t.after(() => store.close()); await store.queue;
  corpusOpens = 0; manifestReads = 0; bodyReads = 0;

  const second = publish(store); assert.equal(await second.done, true);
  assert.equal((await store.query()).items.length, 2);
  await store.serial(() => store.expire());
  assert.equal(corpusOpens, 0, 'normal runtime work must not walk the corpus');
  assert.equal(manifestReads, 0, 'normal runtime work must not reread stored manifests');
  assert.equal(bodyReads, 0, 'metadata work must never read detailed bodies');

  const externalId = randomUUID();
  await fs.mkdir(path.join(dir, externalId));
  await fs.writeFile(path.join(dir, externalId, 'manifest.json'), JSON.stringify({ request: { requestId: externalId, ts: store.now(), status: 200 }, attempts: [], bodies: [] }));
  assert.equal((await store.query()).items.length, 2, 'external files wait for reconciliation');
  await store.serial(() => store.reconcile());
  assert.equal((await store.query()).items.length, 3);
  assert.ok(corpusOpens > 0); assert.ok(manifestReads > 0); assert.equal(bodyReads, 0);
});

test('bounded inventory fails closed without deleting roots and explicit clear recovers', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cps-details-inventory-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const seed = new DetailedLogStore({ dir }); await seed.queue;
  await publish(seed).done; await publish(seed).done; await seed.close();
  const roots = (await fs.readdir(dir)).sort(); assert.equal(roots.length, 3); assert.ok(roots.includes('raw'));

  const limited = new DetailedLogStore({ dir, maxInventoryEntries: 1 }); t.after(() => limited.close()); await limited.queue;
  assert.equal(limited.inventoryOverflow, true); assert.ok(limited.health.failures >= 1);
  await assert.rejects(limited.query(), { statusCode: 503, message: 'detailed storage unavailable' });
  assert.deepEqual((await fs.readdir(dir)).sort(), roots, 'inventory pressure must not evict durable roots');
  assert.deepEqual(await limited.clear(), { ok: true });
  assert.equal(limited.inventoryOverflow, false); assert.equal((await limited.query()).items.length, 0);
});

test('small byte/age budgets evict oldest roots, reject older late completions, expire while idle', async (t) => {
  let now = 100;
  const store = await setup(t, { now: () => now, maxAgeMs: 100, maxTotalBytes: 850 });
  const a = publish(store, { ts: 90, text: 'a'.repeat(200) }); await a.done;
  const b = publish(store, { ts: 95, text: 'b'.repeat(200) }); await b.done;
  assert.deepEqual((await store.query()).items.map((r) => r.requestId), [b.requestId]);
  const old = publish(store, { ts: 80, text: 'c'.repeat(200) }); assert.equal(await old.done, false);
  assert.equal((await store.query()).items[0].requestId, b.requestId);
  now = 200; assert.equal((await store.query()).items.length, 0);
});

test('clear fences queued/active generations and permits new roots', async (t) => {
  let unblock; const gate = new Promise((resolve) => { unblock = resolve; });
  const store = await setup(t); store.serial(() => gate);
  const old = publish(store); const clear = store.clear(); const fresh = publish(store);
  unblock(); assert.equal(await old.done, false); await clear; assert.equal(await fresh.done, true);
  assert.equal(old.released(), true); assert.equal((await store.query()).items.length, 1);
});

test('safe failure health, reservation release, orphan recovery and path safety', async (t) => {
  const io = { ...fs, rename: async () => { throw new Error('ENOSPC SECRET PATH'); } };
  const store = await setup(t, { io }); const item = publish(store);
  assert.equal(await item.done, false); assert.equal(item.released(), true); assert.equal(store.pending, 0);
  assert.equal(store.health.failures, 1); assert.doesNotMatch(JSON.stringify(store.health), /SECRET/);
  assert.deepEqual(await fs.readdir(store.dir), ['raw']);
  for (const id of ['../config.json', 'bad', randomUUID() + '/x']) await assert.rejects(store.detail(id), { statusCode: 400 });
  const orphan = path.join(store.dir, '.tmp-' + randomUUID()); await fs.mkdir(orphan); await fs.writeFile(path.join(orphan, randomUUID() + '.txt'), 'sanitized');
  const restarted = new DetailedLogStore({ dir: store.dir }); t.after(() => restarted.close()); await restarted.queue;
  assert.deepEqual(await fs.readdir(store.dir), ['raw']);
});

test('abandoned publication groups recover through clear or maintenance after rename and cleanup failures', async (t) => {
  for (const boundary of ['clear', 'maintenance', 'publication']) {
    let broken = false, now = 1000;
    const io = { ...fs,
      rename: async (...args) => { if (broken) throw new Error('fixture rename failure'); return fs.rename(...args); },
      rm: async (name, ...args) => { if (broken && path.basename(name).startsWith('.tmp-')) throw new Error('fixture cleanup failure'); return fs.rm(name, ...args); }
    };
    const store = await setup(t, { io, now: () => now, maxAgeMs: 1000 });
    const successful = publish(store); assert.equal(await successful.done, true);
    broken = true;
    const failed = publish(store); assert.equal(await failed.done, false);
    assert.equal(failed.released(), true); assert.equal(store.pending, 0); assert.equal(store.health.failures, 2);
    const temporary = (await fs.readdir(store.dir)).find((name) => name.startsWith('.tmp-')); assert.ok(temporary);
    assert.equal(await fs.readFile(path.join(store.dir, temporary, failed.bodyId + '.txt'), 'utf8'), 'sanitized prompt');
    broken = false;
    if (boundary === 'clear') assert.deepEqual(await store.clear(), { ok: true });
    else if (boundary === 'maintenance') { now = 1100; await store.query(); }
    else assert.equal(await publish(store).done, true);
    assert.equal((await fs.readdir(store.dir)).some((name) => name.startsWith('.tmp-')), false, boundary);
    if (boundary !== 'clear') assert.equal(await store.body(successful.requestId, successful.bodyId), 'sanitized prompt', 'maintenance preserves successful records');
    else assert.deepEqual(await fs.readdir(store.dir), ['raw']);
    assert.equal(await publish(store).done, true, 'released reservations and serial queue remain usable');
  }
});

test('queued maintenance and clear cannot delete a temporary group still owned by a blocked publication', async (t) => {
  let unblock, written;
  const gate = new Promise((resolve) => { unblock = resolve; }), ready = new Promise((resolve) => { written = resolve; });
  const io = { ...fs, writeFile: async (file, ...args) => { await fs.writeFile(file, ...args); if (file.endsWith('.txt')) { written(); await gate; } } };
  t.after(() => unblock());
  const store = await setup(t, { io });
  const item = publish(store); await ready;
  const temporary = (await fs.readdir(store.dir)).find((name) => name.startsWith('.tmp-')); assert.ok(temporary);
  const query = store.query(), clear = store.clear(), fresh = publish(store);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await fs.readFile(path.join(store.dir, temporary, item.bodyId + '.txt'), 'utf8'), 'sanitized prompt');
  unblock(); assert.equal(await item.done, false, 'clear generation fences the blocked old publication');
  await query; assert.deepEqual(await clear, { ok: true }); assert.equal(await fresh.done, true);
  assert.equal(item.released(), true); assert.equal(fresh.released(), true); assert.equal(store.pending, 0);
  assert.deepEqual((await store.query()).items.map((row) => row.requestId), [fresh.requestId]);
});

test('persistent temporary deletion failure rejects clear and maintenance safely, then recovers', async (t) => {
  let broken = false;
  const io = { ...fs,
    rename: async (...args) => { if (broken) throw new Error('PRIVATE fixture rename failure'); return fs.rename(...args); },
    rm: async (name, ...args) => { if (broken && path.basename(name).startsWith('.tmp-')) throw new Error('PRIVATE fixture cleanup failure'); return fs.rm(name, ...args); }
  };
  const store = await setup(t, { io }); broken = true;
  const failed = publish(store); assert.equal(await failed.done, false); const generation = store.generation;
  await assert.rejects(store.clear(), { statusCode: 503, message: 'detailed storage unavailable' });
  assert.equal(store.generation, generation + 1, 'even failed clear fences pre-clear roots');
  await assert.rejects(store.query(), { statusCode: 503, message: 'detailed storage unavailable' });
  assert.ok(store.health.failures >= 4); assert.doesNotMatch(JSON.stringify(store.health), /PRIVATE/);
  assert.equal(failed.released(), true); assert.equal(store.pending, 0);
  broken = false; assert.deepEqual(await store.clear(), { ok: true }); assert.deepEqual(await fs.readdir(store.dir), ['raw']);
});

test('temporary cleanup preserves unknown files, corrupt groups and symlink targets at every boundary', async (t) => {
  const store = await setup(t); store.close();
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'cps-details-outside-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.writeFile(path.join(outside, 'operator.txt'), 'operator content');
  const unknownName = '.tmp-not-a-generated-id', unknownContent = '.tmp-' + randomUUID(), linkedContent = '.tmp-' + randomUUID(), link = '.tmp-' + randomUUID();
  for (const name of [unknownName, unknownContent, linkedContent]) await fs.mkdir(path.join(store.dir, name));
  for (const name of [unknownName, unknownContent]) await fs.writeFile(path.join(store.dir, name, 'operator.txt'), 'operator content');
  await fs.symlink(outside, path.join(store.dir, link));
  await fs.symlink(path.join(outside, 'operator.txt'), path.join(store.dir, linkedContent, randomUUID() + '.txt'));
  const corruptId = randomUUID(); await fs.mkdir(path.join(store.dir, corruptId));
  await fs.writeFile(path.join(store.dir, corruptId, 'manifest.json'), '{corrupt operator data');
  const restarted = new DetailedLogStore({ dir: store.dir }); restarted.close(); await restarted.queue;
  await restarted.query();
  assert.equal(await fs.readFile(path.join(store.dir, corruptId, 'manifest.json'), 'utf8'), '{corrupt operator data');
  await restarted.clear();
  for (const name of [unknownName, unknownContent]) assert.equal(await fs.readFile(path.join(store.dir, name, 'operator.txt'), 'utf8'), 'operator content');
  assert.equal((await fs.lstat(path.join(store.dir, link))).isSymbolicLink(), true);
  assert.equal((await fs.readdir(path.join(store.dir, linkedContent))).length, 1);
  assert.equal(await fs.readFile(path.join(outside, 'operator.txt'), 'utf8'), 'operator content');
});

test('strict query filters and generated body identity prevent traversal/symlink reading', async (t) => {
  for (const query of ['limit=0', 'limit=201', 'limit=2.5', 'from=NaN', 'to=9007199254740992', 'other=x', 'requestId=../x', 'cursor=bad', 'cursor=', 'status=600', 'result=unknown', 'limit=1&limit=2']) assert.throws(() => parseDetailQuery(new URLSearchParams(query)), { statusCode: 400 });
  const store = await setup(t); const item = publish(store); await item.done;
  const file = path.join(store.dir, item.requestId, item.bodyId + '.txt'); await fs.unlink(file); await fs.symlink('../manifest.json', file);
  await assert.rejects(store.body(item.requestId, item.bodyId), { statusCode: 404 });
});

test('error-profile manifests reject missing or duplicate attempt identities', async (t) => {
  const store = await setup(t);
  for (const attempts of [
    [{ captureState: 'no-response' }],
    (() => { const callId = randomUUID(); return [{ attemptIndex: 0, callId }, { attemptIndex: 0, callId }]; })(),
  ]) {
    const requestId = randomUUID(); let released = false;
    const result = await store.publish({ generation: store.generation, ts: store.now(), requestId, release() { released = true; }, produce: () => ({ request: { requestId, ts: store.now(), profile: 'error', state: 'complete', attemptCount: attempts.length }, attempts, bodies: [] }) });
    assert.equal(result, false); assert.equal(released, true); await assert.rejects(store.detail(requestId), { statusCode: 404 });
  }
});

test('transient read/rename failure and expected missing never disable later publication or delete data', async (t) => {
  let failRead = false, failRename = false;
  const io = { ...fs, open: async (...args) => { if (failRead) throw Object.assign(new Error('temporary secret EIO'), { code: 'EIO' }); return fs.open(...args); }, rename: async (...args) => { if (failRename) throw Object.assign(new Error('temporary ENOSPC'), { code: 'ENOSPC' }); return fs.rename(...args); } };
  const store = await setup(t, { io }); const first = publish(store); await first.done;
  const file = path.join(store.dir, first.requestId, 'manifest.json'), before = await fs.readFile(file);
  failRead = true;
  const restarted = new DetailedLogStore({ dir: store.dir, io }); t.after(() => restarted.close()); await restarted.queue;
  assert.deepEqual(await fs.readFile(file), before, 'startup I/O failure must preserve original manifest');
  failRead = false;
  assert.equal((await restarted.query()).items.length, 1);
  failRename = true; assert.equal(await publish(store).done, false); failRename = false;
  assert.equal(await publish(store).done, true);
  const failures = store.health.failures;
  await store.clear(); await assert.rejects(store.body(first.requestId, first.bodyId), { statusCode: 404 });
  assert.equal(store.health.failures, failures); assert.equal(await publish(store).done, true);
});

test('retention has no record-count eviction, corrupt groups survive and open roots recover interrupted', async (t) => {
  const store = await setup(t, { maxGroups: 1 });
  const first = publish(store), second = publish(store); await first.done; await second.done;
  assert.equal((await store.query()).items.length, 2);
  const requestId = randomUUID();
  await store.open({ requestId, ts: store.now(), generation: store.generation, method: 'POST', pathname: '/v1/chat/completions' });
  assert.equal((await store.detail(requestId)).request.state, 'open');
  const corrupt = path.join(store.dir, first.requestId, 'manifest.json'); await fs.writeFile(corrupt, '{corrupt-but-preserved');
  const restarted = new DetailedLogStore({ dir: store.dir }); t.after(() => restarted.close()); await restarted.queue;
  assert.equal((await restarted.detail(requestId)).request.state, 'interrupted');
  assert.equal(await fs.readFile(corrupt, 'utf8'), '{corrupt-but-preserved');
  assert.equal((await restarted.query()).items.length, 2);
});

test('evicted active roots cannot be recreated by late completion', async (t) => {
  const store = await setup(t, { maxTotalBytes: 600, now: () => 100, maxAgeMs: 100 });
  const requestId = randomUUID(); await store.open({ requestId, ts: 2, generation: store.generation, method: 'POST', pathname: '/v1/chat/completions' });
  const newer = publish(store, { ts: 95, text: 'n'.repeat(200) }); assert.equal(await newer.done, true);
  await assert.rejects(store.detail(requestId), { statusCode: 404 });
  let released = false;
  const result = await store.publish({ requestId, ts: 2, generation: store.generation, requireOpen: true, produce() { assert.fail('evicted body must not be materialized'); }, release() { released = true; } });
  assert.equal(result, false); assert.equal(released, true); assert.deepEqual((await store.query()).items.map((row) => row.requestId), [newer.requestId]);
});

test('async close drains accepted publications and drops post-close work with release', async (t) => {
  let unblock, bodyWritten;
  const gate = new Promise((resolve) => { unblock = resolve; });
  const ready = new Promise((resolve) => { bodyWritten = resolve; });
  let hold = true;
  const io = {
    ...fs,
    async writeFile(file, ...args) {
      await fs.writeFile(file, ...args);
      if (hold && file.endsWith('.txt')) { bodyWritten(); await gate; }
    },
  };
  const store = await setup(t, { io });
  const accepted = publish(store); await ready;
  let closed = false; const closing = store.close().then(() => { closed = true; });
  await new Promise((resolve) => setImmediate(resolve)); assert.equal(closed, false, 'close waits for accepted work');
  const rejected = publish(store); assert.equal(await rejected.done, false); assert.equal(rejected.released(), true);
  hold = false; unblock(); assert.equal(await accepted.done, true); await closing;
  assert.equal(store.health.dropped, 1); assert.equal(store.health.dropReasons.storeQueue, 1);
  assert.equal(accepted.released(), true); assert.equal(store.pending, 0);
});

test('clear racing an opened body returns ordinary missing and permits subsequent writes', async (t) => {
  let blocked = false, unblock, opened;
  const gate = new Promise((resolve) => { unblock = resolve; });
  const ready = new Promise((resolve) => { opened = resolve; });
  const io = { ...fs, open: async (file, ...args) => {
    const handle = await fs.open(file, ...args);
    if (!blocked || !file.endsWith('.txt')) return handle;
    return { stat: () => handle.stat(), close: () => handle.close(), readFile: async (...readArgs) => { opened(); await gate; return handle.readFile(...readArgs); } };
  } };
  const store = await setup(t, { io }); const first = publish(store); await first.done; blocked = true;
  const reading = store.body(first.requestId, first.bodyId); const rejected = assert.rejects(reading, { statusCode: 404 });
  await ready; await store.clear(); unblock(); await rejected;
  assert.equal(store.health.failures, 0); assert.equal(await publish(store).done, true);
});
