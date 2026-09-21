import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
const RECONCILE_INTERVAL_MS = 60 * 60 * 1000;
const MAX_INVENTORY_ENTRIES = 100000;
const MAX_INVENTORY_BYTES = 64 * 1024 * 1024;
const INVENTORY_ENTRY_OVERHEAD = 256;
export const validDetailId = (id) => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id);
const order = (a, b) => a.ts - b.ts || a.requestId.localeCompare(b.requestId);
const missing = () => Object.assign(new Error('detailed record unavailable'), { statusCode: 404 });
const invalid = () => Object.assign(new Error('invalid detailed log query'), { statusCode: 400 });

export function parseDetailQuery(params) {
  const allowed = new Set(['limit', 'cursor', 'requestId', 'from', 'to', 'model', 'account', 'status', 'result']);
  const query = { limit: 50 };
  for (const [key, value] of params) {
    if (!allowed.has(key) || Object.hasOwn(query, key) && key !== 'limit' || params.getAll(key).length !== 1 || value.length > (key === 'cursor' ? 512 : 300)) throw invalid();
    if (['limit', 'from', 'to', 'status'].includes(key)) {
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw invalid();
      query[key] = Number(value);
    } else query[key] = value;
  }
  if (query.limit < 1 || query.limit > 200 || query.status !== undefined && (query.status < 100 || query.status > 599) || query.from > query.to || query.result !== undefined && !['success', 'client_cancelled', 'failed'].includes(query.result)) throw invalid();
  if (query.requestId !== undefined && !validDetailId(query.requestId)) throw invalid();
  if (query.cursor !== undefined) {
    try {
      if (!/^[A-Za-z0-9_-]+$/.test(query.cursor) || Buffer.from(query.cursor, 'base64url').toString('base64url') !== query.cursor) throw invalid();
      const cursor = JSON.parse(Buffer.from(query.cursor, 'base64url').toString());
      if (Object.keys(cursor).length !== 2 || !Number.isSafeInteger(cursor.ts) || cursor.ts < 0 || !validDetailId(cursor.requestId)) throw invalid();
      query.cursor = cursor;
    } catch { throw invalid(); }
  }
  return query;
}

export class DetailedLogStore {
  constructor({ dir, maxAgeMs = MAX_AGE_MS, maxTotalBytes = MAX_TOTAL_BYTES, maxInventoryEntries = MAX_INVENTORY_ENTRIES, maxInventoryBytes = MAX_INVENTORY_BYTES, now = Date.now, io = fs } = {}) {
    this.dir = dir; this.maxAgeMs = maxAgeMs; this.maxTotalBytes = maxTotalBytes; this.maxInventoryEntries = maxInventoryEntries; this.maxInventoryBytes = maxInventoryBytes; this.now = now; this.io = io;
    this.generation = 0; this.pending = 0; this.accepting = true; this.closed = false; this.closePromise = null;
    this.health = { failures: 0, dropped: 0, corrupt: 0, lastFailure: null };
    this.entries = new Map(); this.totalBytes = 0; this.unknownEntries = 0; this.inventoryBytes = 0;
    this.temporary = new Set(); this.ready = false; this.needsReconcile = false; this.inventoryOverflow = false; this.startupRecoveryPending = true;
    this.queue = this.startup().catch(() => this.failure());
    this.timer = setInterval(() => { void this.serial(() => this.expire()).catch(() => {}); }, Math.min(maxAgeMs, 60000)); this.timer.unref();
    this.reconcileTimer = setInterval(() => { void this.serial(() => this.reconcile()).catch(() => {}); }, RECONCILE_INTERVAL_MS); this.reconcileTimer.unref();
  }
  close() {
    if (this.closePromise) return this.closePromise;
    this.accepting = false;
    clearInterval(this.timer); clearInterval(this.reconcileTimer);
    this.closePromise = (async () => { await this.queue; this.closed = true; })();
    return this.closePromise;
  }
  failure() { this.health.failures++; this.health.lastFailure = 'detailed-storage-unavailable'; }
  serial(fn) {
    const work = this.queue.then(fn).catch((error) => {
      if (error.statusCode === 400 || error.statusCode === 404) throw error;
      this.failure(); throw Object.assign(new Error('detailed storage unavailable'), { statusCode: 503 });
    });
    this.queue = work.catch(() => {}); return work;
  }
  async safeDirectory(dir) {
    const stat = await this.io.lstat(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw missing();
  }
  async readFile(dir, name, maxBytes) {
    await this.safeDirectory(this.dir); await this.safeDirectory(dir);
    const entry = await this.io.lstat(path.join(dir, name));
    if (!entry.isFile() || entry.isSymbolicLink()) throw missing();
    const handle = await this.io.open(path.join(dir, name), constants.O_RDONLY | constants.O_NOFOLLOW);
    try { const stat = await handle.stat(); if (!stat.isFile() || stat.size > maxBytes) throw missing(); return await handle.readFile('utf8'); }
    finally { await handle.close(); }
  }
  summary(request) {
    const { requestId, ts, method, pathname, model, accounts, status, result, complete, state, attemptCount } = request;
    const profile = request.profile === 'error' ? 'error' : 'full';
    return { requestId, ts, method, pathname, model, accounts, status, result, complete, state, attemptCount, profile, httpStatus: request.httpStatus ?? status ?? null, outcomeStatus: request.outcomeStatus ?? status ?? null, captureState: request.captureState || state || null };
  }
  validate(group, id) {
    if (group.request?.requestId !== id || !Number.isSafeInteger(group.request.ts) || !Array.isArray(group.attempts) || !Array.isArray(group.bodies) || group.bodies.length > 514) throw new SyntaxError('invalid manifest');
    if (group.attempts.length > 256 || new Set(group.bodies.map((body) => body?.bodyId)).size !== group.bodies.length || group.request.model !== undefined && typeof group.request.model !== 'string' || group.request.accounts !== undefined && (!Array.isArray(group.request.accounts) || group.request.accounts.some((a) => typeof a !== 'string')) || group.request.profile !== undefined && !['full', 'error'].includes(group.request.profile)) throw new SyntaxError('invalid manifest metadata');
    const attemptIdentities = new Set();
    for (const attempt of group.attempts) {
      const hasIndex = attempt?.attemptIndex !== undefined, hasCallId = attempt?.callId !== undefined;
      if (hasIndex && (!Number.isSafeInteger(attempt.attemptIndex) || attempt.attemptIndex < 0) || hasCallId && !validDetailId(attempt.callId) || group.request.profile === 'error' && (!hasIndex || !hasCallId)) throw new SyntaxError('invalid attempt identity');
      if (hasIndex && hasCallId) { const identity = `${attempt.attemptIndex}\0${attempt.callId}`; if (attemptIdentities.has(identity)) throw new SyntaxError('duplicate attempt identity'); attemptIdentities.add(identity); }
    }
    for (const body of group.bodies) if (!body || !validDetailId(body.bodyId) || !Number.isSafeInteger(body.capturedBytes) || body.capturedBytes < 0 || body.capturedBytes > 5 * 1024 * 1024) throw new SyntaxError('invalid body descriptor');
    return group;
  }
  indexedEntry(entry) {
    const { indexBytes: _, ...value } = entry;
    return { ...value, indexBytes: INVENTORY_ENTRY_OVERHEAD + (entry.row ? Buffer.byteLength(JSON.stringify(entry.row)) : 0) };
  }
  canSetEntry(entry) {
    const previous = this.entries.get(entry.requestId);
    return this.entries.size + (previous ? 0 : 1) <= this.maxInventoryEntries && this.inventoryBytes - (previous?.indexBytes || 0) + entry.indexBytes <= this.maxInventoryBytes;
  }
  replaceEntries(entries, inventoryBytes) {
    let totalBytes = 0, unknownEntries = 0;
    for (const entry of entries.values()) { totalBytes += entry.bytes; if (!entry.row) unknownEntries++; }
    this.entries = entries; this.totalBytes = totalBytes; this.unknownEntries = unknownEntries; this.inventoryBytes = inventoryBytes; this.inventoryOverflow = false;
  }
  setEntry(value) {
    const entry = this.indexedEntry(value);
    if (!this.canSetEntry(entry)) { this.inventoryOverflow = true; throw new Error('detailed inventory capacity exceeded'); }
    this.forgetEntry(entry.requestId); this.entries.set(entry.requestId, entry); this.totalBytes += entry.bytes; this.inventoryBytes += entry.indexBytes; if (!entry.row) this.unknownEntries++;
  }
  forgetEntry(id) {
    const entry = this.entries.get(id); if (!entry) return;
    this.entries.delete(id); this.totalBytes -= entry.bytes; this.inventoryBytes -= entry.indexBytes; if (!entry.row) this.unknownEntries--;
  }
  oldest() {
    let oldest = null;
    for (const entry of this.entries.values()) if (entry.row && (!oldest || order(entry.row, oldest.row) < 0)) oldest = entry;
    return oldest;
  }
  // A full reconciliation reads bounded manifests and file sizes, never body content.
  async *scan({ state = {}, cleanupOrphans = false } = {}) {
    await this.safeDirectory(this.dir);
    for await (const entry of await this.io.opendir(this.dir)) {
      const temporary = /^\.tmp-[0-9a-f-]+$/.test(entry.name);
      if ((!validDetailId(entry.name) && !temporary) || !entry.isDirectory()) continue;
      const dir = path.join(this.dir, entry.name); let bytes = 0, unsafe = false; const sizes = new Map();
      for await (const file of await this.io.opendir(dir)) {
        if (!file.isFile()) { unsafe = true; continue; }
        const stat = await this.io.lstat(path.join(dir, file.name));
        if (!stat.isFile() || stat.isSymbolicLink()) { unsafe = true; continue; }
        bytes += stat.size; if (sizes.size < 1028) sizes.set(file.name, stat.size);
      }
      if (unsafe) { this.health.corrupt++; yield { requestId: entry.name, bytes: this.maxTotalBytes, manifestBytes: 0, row: null }; continue; }
      if (temporary) { yield { requestId: entry.name, bytes, manifestBytes: 0, row: null }; continue; }
      let group;
      try {
        group = this.validate(JSON.parse(await this.readFile(dir, 'manifest.json', 1024 * 1024)), entry.name);
        if (group.bodies.some((body) => sizes.get(body.bodyId + '.txt') !== body.capturedBytes)) throw new SyntaxError('missing or corrupt body');
      } catch (error) {
        group = null;
        if (error instanceof SyntaxError) this.health.corrupt++;
        else if (error.code !== 'ENOENT') { this.failure(); state.retry = true; }
      }
      if (!group) { yield { requestId: entry.name, bytes, manifestBytes: sizes.get('manifest.json') || 0, row: null }; continue; }
      if (cleanupOrphans) {
        const referenced = new Set(group.bodies.map((body) => body.bodyId + '.txt'));
        for (const [name, size] of [...sizes]) {
          if (name.startsWith('.manifest-') || /^[0-9a-f-]+\.txt$/.test(name) && !referenced.has(name)) {
            await this.io.rm(path.join(dir, name)); sizes.delete(name); bytes -= size;
          }
        }
      }
      yield { requestId: entry.name, bytes, manifestBytes: sizes.get('manifest.json') || 0, row: this.summary(group.request) };
    }
  }
  async cleanupTemporary() {
    await this.safeDirectory(this.dir);
    for await (const entry of await this.io.opendir(this.dir)) {
      if (!entry.name.startsWith('.tmp-') || !validDetailId(entry.name.slice(5)) || !entry.isDirectory()) continue;
      const dir = path.join(this.dir, entry.name); let owned = true;
      await this.safeDirectory(dir);
      for await (const file of await this.io.opendir(dir)) {
        if (!file.isFile() || file.name !== 'manifest.json' && !(file.name.endsWith('.txt') && validDetailId(file.name.slice(0, -4)))) { owned = false; break; }
        const stat = await this.io.lstat(path.join(dir, file.name));
        if (!stat.isFile() || stat.isSymbolicLink()) { owned = false; break; }
      }
      if (owned) { await this.io.rm(dir, { recursive: true, force: true }); this.temporary.delete(entry.name); this.forgetEntry(entry.name); }
      else this.health.corrupt++;
    }
  }
  async cleanupTrackedTemporary() {
    for (const name of [...this.temporary]) {
      const dir = path.join(this.dir, name); let stat;
      try { stat = await this.io.lstat(dir); }
      catch (error) { if (error.code === 'ENOENT') { this.temporary.delete(name); this.forgetEntry(name); continue; } throw error; }
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        this.health.corrupt++; this.temporary.delete(name); this.setEntry({ requestId: name, bytes: this.maxTotalBytes, manifestBytes: 0, row: null }); continue;
      }
      let owned = true;
      for await (const file of await this.io.opendir(dir)) {
        if (!file.isFile() || file.name !== 'manifest.json' && !(file.name.endsWith('.txt') && validDetailId(file.name.slice(0, -4)))) { owned = false; break; }
        const fileStat = await this.io.lstat(path.join(dir, file.name));
        if (!fileStat.isFile() || fileStat.isSymbolicLink()) { owned = false; break; }
      }
      if (!owned) {
        this.health.corrupt++; this.temporary.delete(name); this.setEntry({ requestId: name, bytes: this.maxTotalBytes, manifestBytes: 0, row: null }); continue;
      }
      await this.io.rm(dir, { recursive: true, force: true }); this.temporary.delete(name); this.forgetEntry(name);
    }
  }
  async startup() {
    await this.io.mkdir(this.dir, { recursive: true, mode: 0o700 }); await this.safeDirectory(this.dir); await this.io.chmod(this.dir, 0o700);
    await this.reconcile({ cleanupOrphans: true }); if (!this.needsReconcile) await this.ensureStartupRecovery();
  }
  async ensureStartupRecovery() {
    if (!this.startupRecoveryPending) return;
    this.startupRecoveryPending = false;
    try { await this.recoverStartup(); }
    catch (error) { this.startupRecoveryPending = true; throw error; }
  }
  async recoverStartup() {
    for (const indexed of [...this.entries.values()]) {
      if (indexed.row?.state !== 'open' || this.entries.get(indexed.requestId) !== indexed) continue;
      const dir = path.join(this.dir, indexed.requestId);
      const group = this.validate(JSON.parse(await this.readFile(dir, 'manifest.json', 1024 * 1024)), indexed.requestId);
      group.request.state = 'interrupted'; group.request.complete = false;
      const metadata = JSON.stringify(group), manifestBytes = Buffer.byteLength(metadata);
      if (!await this.admit(manifestBytes, group.request) || !this.entries.has(indexed.requestId)) continue;
      await this.safeDirectory(dir);
      const tmp = path.join(dir, '.manifest-' + randomUUID());
      try { await this.io.writeFile(tmp, metadata, { mode: 0o600, flag: 'wx' }); await this.io.rename(tmp, path.join(dir, 'manifest.json')); }
      finally { await this.io.rm(tmp, { force: true }); }
      this.setEntry({ ...indexed, bytes: indexed.bytes + manifestBytes - indexed.manifestBytes, manifestBytes, row: this.summary(group.request) });
    }
    await this.expire();
  }
  async reconcile({ cleanupOrphans = false } = {}) {
    await this.cleanupTemporary();
    const entries = new Map(), state = {}; let inventoryBytes = 0;
    for await (const value of this.scan({ state, cleanupOrphans })) {
      const entry = this.indexedEntry(value);
      if (entries.size + 1 > this.maxInventoryEntries || inventoryBytes + entry.indexBytes > this.maxInventoryBytes) {
        this.inventoryOverflow = true; throw new Error('detailed inventory capacity exceeded');
      }
      entries.set(entry.requestId, entry); inventoryBytes += entry.indexBytes;
    }
    this.replaceEntries(entries, inventoryBytes); this.ready = true; this.needsReconcile = !!state.retry;
    await this.expire({ skipEnsure: true });
  }
  async remove(id) { await this.io.rm(path.join(this.dir, id), { recursive: true, force: true }); this.forgetEntry(id); }
  async expire({ skipEnsure = false } = {}) {
    if (this.inventoryOverflow) throw new Error('detailed inventory unavailable');
    if (!skipEnsure && (!this.ready || this.needsReconcile)) {
      await this.reconcile({ cleanupOrphans: this.startupRecoveryPending });
      if (this.startupRecoveryPending && !this.needsReconcile) await this.ensureStartupRecovery();
      return;
    }
    if (!skipEnsure && this.startupRecoveryPending) { await this.ensureStartupRecovery(); return; }
    await this.cleanupTrackedTemporary();
    const cutoff = this.now() - this.maxAgeMs;
    for (const entry of [...this.entries.values()]) if (entry.row && entry.row.ts <= cutoff) await this.remove(entry.requestId);
    await this.admit(0);
  }
  async admit(required, candidate = null) {
    for (;;) {
      if (this.totalBytes + required <= this.maxTotalBytes) return true;
      const oldest = this.oldest();
      if (this.unknownEntries || !oldest || candidate && order(candidate, oldest.row) < 0) return false;
      await this.remove(oldest.requestId);
    }
  }
  // Sanitize/materialize within one queue. Keep raw capture reservations alive
  // until publication/cleanup; response handlers never await this operation.
  open({ generation, ts, requestId, method, pathname }) {
    return this.publish({ generation, ts, requestId, release() {}, produce: () => ({ request: { requestId, ts, method, pathname, status: null, complete: false, state: 'open', attemptCount: 0 }, attempts: [], bodies: [] }) });
  }
  publish({ generation, ts, requestId, produce, release, requireOpen = false }) {
    if (!this.accepting || this.pending >= 128) { this.health.dropped++; release(); return Promise.resolve(false); }
    this.pending++;
    return this.serial(async () => {
      let tmp = null, rootMutated = false;
      try {
        if (generation !== this.generation || ts <= this.now() - this.maxAgeMs || !validDetailId(requestId)) { this.health.dropped++; return false; }
        await this.expire();
        const previousEntry = requireOpen ? this.entries.get(requestId) : null;
        if (requireOpen) {
          if (!previousEntry?.row) { this.health.dropped++; return false; }
          let previous;
          try { previous = JSON.parse(await this.readFile(path.join(this.dir, requestId), 'manifest.json', 1024 * 1024)); }
          catch (error) { if (error.code === 'ENOENT' || error.statusCode === 404) { this.forgetEntry(requestId); this.health.dropped++; return false; } throw error; }
          if (previous.request?.state !== 'open') { this.health.dropped++; return false; }
        }
        const { request, attempts, bodies } = produce();
        const group = this.validate({ request, attempts, bodies: bodies.map((body) => body.descriptor) }, requestId);
        const metadata = JSON.stringify(group), manifestBytes = Buffer.byteLength(metadata);
        const bytes = manifestBytes + bodies.reduce((sum, body) => sum + Buffer.byteLength(body.text), 0);
        if (manifestBytes > 1024 * 1024 || bytes > this.maxTotalBytes) { this.health.dropped++; return false; }
        const nextEntry = this.indexedEntry({ requestId, bytes, manifestBytes, row: this.summary(group.request) });
        if (!this.canSetEntry(nextEntry) || !await this.admit(bytes, { ts, requestId })) { this.health.dropped++; return false; }
        if (requireOpen && !this.entries.has(requestId)) { this.health.dropped++; return false; }
        tmp = path.join(this.dir, '.tmp-' + randomUUID()); const temporaryName = path.basename(tmp); this.temporary.add(temporaryName);
        await this.safeDirectory(this.dir); await this.io.mkdir(tmp, { mode: 0o700 });
        for (const body of bodies) await this.io.writeFile(path.join(tmp, body.descriptor.bodyId + '.txt'), body.text, { mode: 0o600, flag: 'wx' });
        await this.io.writeFile(path.join(tmp, 'manifest.json'), metadata, { mode: 0o600, flag: 'wx' });
        if (generation !== this.generation || ts <= this.now() - this.maxAgeMs) { this.health.dropped++; return false; }
        if (requireOpen) {
          const dir = path.join(this.dir, requestId);
          try { await this.safeDirectory(dir); } catch (error) { if (error.code === 'ENOENT' || error.statusCode === 404) { this.forgetEntry(requestId); this.health.dropped++; return false; } throw error; }
          for (const body of bodies) {
            await this.io.rename(path.join(tmp, body.descriptor.bodyId + '.txt'), path.join(dir, body.descriptor.bodyId + '.txt'));
            rootMutated = true;
          }
          await this.io.rename(path.join(tmp, 'manifest.json'), path.join(dir, 'manifest.json')); rootMutated = true;
          await this.io.rm(tmp, { recursive: true, force: true });
        } else await this.io.rename(tmp, path.join(this.dir, requestId));
        this.temporary.delete(temporaryName); tmp = null;
        this.setEntry(nextEntry);
        return true;
      } catch { if (rootMutated) this.needsReconcile = true; this.failure(); return false; }
      finally {
        if (tmp) try { await this.io.rm(tmp, { recursive: true, force: true }); this.temporary.delete(path.basename(tmp)); }
        catch { this.failure(); }
        release(); this.pending--;
      }
    });
  }
  query(query = {}) {
    return this.serial(async () => {
      await this.expire(); const page = []; const limit = query.limit || 50;
      for (const { row } of this.entries.values()) {
        if (!row || query.requestId && row.requestId !== query.requestId || query.from !== undefined && row.ts < query.from || query.to !== undefined && row.ts > query.to || query.status !== undefined && row.status !== query.status || query.result && row.result !== query.result || query.model && !(row.model || '').includes(query.model) || query.account && !(row.accounts || []).some((a) => a.includes(query.account)) || query.cursor && order(row, query.cursor) >= 0) continue;
        page.push(row); page.sort((a, b) => order(b, a)); if (page.length > limit + 1) page.pop();
      }
      const more = page.length > limit; if (more) page.pop(); const last = page.at(-1);
      return { items: page, nextCursor: more ? Buffer.from(JSON.stringify({ ts: last.ts, requestId: last.requestId })).toString('base64url') : null, health: { ...this.health } };
    });
  }
  detail(id) {
    if (!validDetailId(id)) return Promise.reject(invalid());
    return this.serial(async () => {
      try {
        const metadata = await this.readFile(path.join(this.dir, id), 'manifest.json', 1024 * 1024);
        const group = this.validate(JSON.parse(metadata), id);
        if (group.request.ts <= this.now() - this.maxAgeMs) { await this.remove(id); throw missing(); }
        for (const body of group.bodies) {
          const file = await this.io.lstat(path.join(this.dir, id, body.bodyId + '.txt'));
          if (!file.isFile() || file.isSymbolicLink() || file.size !== body.capturedBytes) throw missing();
        }
        return group;
      } catch (error) {
        if (error.code === 'ENOENT') this.forgetEntry(id); else this.needsReconcile = true;
        if (error.code !== 'ENOENT' && error.statusCode !== 404) this.failure();
        throw missing();
      }
    });
  }
  async body(id, bodyId) {
    if (!validDetailId(bodyId)) throw invalid();
    const generation = this.generation, group = await this.detail(id);
    if (!group.bodies.some((body) => body.bodyId === bodyId)) throw missing();
    try {
      const text = await this.readFile(path.join(this.dir, id), bodyId + '.txt', 5 * 1024 * 1024);
      if (generation !== this.generation || group.request.ts <= this.now() - this.maxAgeMs) throw missing();
      await this.safeDirectory(path.join(this.dir, id));
      return text;
    } catch (error) { if (error.code !== 'ENOENT' && error.statusCode !== 404) this.failure(); throw missing(); }
  }
  clear() {
    this.generation++;
    return this.serial(async () => {
      await this.cleanupTemporary();
      for await (const entry of await this.io.opendir(this.dir)) if (validDetailId(entry.name) && entry.isDirectory()) await this.remove(entry.name);
      await this.reconcile();
      return { ok: true };
    });
  }
}
