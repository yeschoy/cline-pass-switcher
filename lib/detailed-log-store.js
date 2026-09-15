import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
export const validDetailId = (id) => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id);
const order = (a, b) => a.ts - b.ts || a.requestId.localeCompare(b.requestId);
const missing = () => Object.assign(new Error('detailed record unavailable'), { statusCode: 404 });
const invalid = () => Object.assign(new Error('invalid detailed log query'), { statusCode: 400 });

export function parseDetailQuery(params) {
  const allowed = new Set(['limit', 'cursor', 'requestId', 'from', 'to', 'model', 'account', 'status']);
  const query = { limit: 50 };
  for (const [key, value] of params) {
    if (!allowed.has(key) || Object.hasOwn(query, key) && key !== 'limit' || params.getAll(key).length !== 1 || value.length > (key === 'cursor' ? 512 : 300)) throw invalid();
    if (['limit', 'from', 'to', 'status'].includes(key)) {
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw invalid();
      query[key] = Number(value);
    } else query[key] = value;
  }
  if (query.limit < 1 || query.limit > 200 || query.status !== undefined && (query.status < 100 || query.status > 599) || query.from > query.to) throw invalid();
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
  constructor({ dir, maxAgeMs = MAX_AGE_MS, maxTotalBytes = MAX_TOTAL_BYTES, now = Date.now, io = fs } = {}) {
    this.dir = dir; this.maxAgeMs = maxAgeMs; this.maxTotalBytes = maxTotalBytes; this.now = now; this.io = io;
    this.generation = 0; this.pending = 0;
    this.health = { failures: 0, dropped: 0, corrupt: 0, lastFailure: null };
    this.queue = this.startup().catch(() => this.failure());
    this.timer = setInterval(() => { void this.serial(() => this.expire()).catch(() => {}); }, Math.min(maxAgeMs, 60000)); this.timer.unref();
  }
  close() { clearInterval(this.timer); }
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
    return { requestId, ts, method, pathname, model, accounts, status, result, complete, state, attemptCount };
  }
  validate(group, id) {
    if (group.request?.requestId !== id || !Number.isSafeInteger(group.request.ts) || !Array.isArray(group.attempts) || !Array.isArray(group.bodies) || group.bodies.length > 514) throw new SyntaxError('invalid manifest');
    if (group.attempts.length > 256 || new Set(group.bodies.map((body) => body?.bodyId)).size !== group.bodies.length || group.request.model !== undefined && typeof group.request.model !== 'string' || group.request.accounts !== undefined && (!Array.isArray(group.request.accounts) || group.request.accounts.some((a) => typeof a !== 'string'))) throw new SyntaxError('invalid manifest metadata');
    for (const body of group.bodies) if (!body || !validDetailId(body.bodyId) || !Number.isSafeInteger(body.capturedBytes) || body.capturedBytes < 0 || body.capturedBytes > 5 * 1024 * 1024) throw new SyntaxError('invalid body descriptor');
    return group;
  }
  // Stream one bounded manifest at a time. Neither listing nor retention keeps a
  // corpus-sized index or reads body content; unreadable groups are never deleted.
  async *scan() {
    await this.safeDirectory(this.dir);
    for await (const entry of await this.io.opendir(this.dir)) {
      const temporary = /^\.tmp-[0-9a-f-]+$/.test(entry.name);
      if ((!validDetailId(entry.name) && !temporary) || !entry.isDirectory()) continue;
      const dir = path.join(this.dir, entry.name); let bytes = 0, unsafe = false; const sizes = new Map();
      for await (const file of await this.io.opendir(dir)) {
        if (!file.isFile()) { unsafe = true; continue; }
        const size = (await this.io.lstat(path.join(dir, file.name))).size; bytes += size;
        if (sizes.size < 1028) sizes.set(file.name, size);
      }
      let group;
      if (unsafe) { this.health.corrupt++; yield { requestId: entry.name, bytes: this.maxTotalBytes, row: null }; continue; }
      if (temporary) { yield { requestId: entry.name, bytes, row: null }; continue; }
      try {
        group = this.validate(JSON.parse(await this.readFile(dir, 'manifest.json', 1024 * 1024)), entry.name);
        if (group.bodies.some((body) => sizes.get(body.bodyId + '.txt') !== body.capturedBytes)) throw new SyntaxError('missing or corrupt body');
      }
      catch (error) { group = null; if (error instanceof SyntaxError) this.health.corrupt++; else if (error.code !== 'ENOENT') this.failure(); }
      yield { requestId: entry.name, bytes, row: group ? this.summary(group.request) : null };
    }
  }
  // Only call at serial boundaries where no publication owns a temporary group.
  // Unknown entries or symlinks are not ours to delete, even under a UUID name.
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
      if (owned) await this.remove(entry.name);
      else this.health.corrupt++;
    }
  }
  async startup() {
    await this.io.mkdir(this.dir, { recursive: true, mode: 0o700 }); await this.safeDirectory(this.dir); await this.io.chmod(this.dir, 0o700);
    await this.cleanupTemporary();
    for await (const entry of await this.io.opendir(this.dir)) {
      if (!validDetailId(entry.name) || !entry.isDirectory()) continue;
      const dir = path.join(this.dir, entry.name);
      let group;
      try { group = this.validate(JSON.parse(await this.readFile(dir, 'manifest.json', 1024 * 1024)), entry.name); }
      catch (error) { if (error instanceof SyntaxError) this.health.corrupt++; else if (error.code !== 'ENOENT') this.failure(); continue; }
      if (group.request.state === 'open') {
        group.request.state = 'interrupted'; group.request.complete = false;
        const metadata = JSON.stringify(group);
        if (!await this.admit(Buffer.byteLength(metadata), group.request)) continue;
        try { await this.safeDirectory(dir); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        const tmp = path.join(dir, '.manifest-' + randomUUID());
        try { await this.io.writeFile(tmp, metadata, { mode: 0o600, flag: 'wx' }); await this.io.rename(tmp, path.join(dir, 'manifest.json')); }
        finally { await this.io.rm(tmp, { force: true }); }
      }
      const referenced = new Set(group.bodies.map((body) => body.bodyId + '.txt'));
      for await (const file of await this.io.opendir(dir)) {
        if (file.isFile() && (file.name.startsWith('.manifest-') || /^[0-9a-f-]+\.txt$/.test(file.name) && !referenced.has(file.name))) await this.io.rm(path.join(dir, file.name));
      }
    }
    await this.expire();
  }
  async remove(id) { await this.io.rm(path.join(this.dir, id), { recursive: true, force: true }); }
  async expire() {
    await this.cleanupTemporary();
    for await (const group of this.scan()) if (group.row && group.row.ts <= this.now() - this.maxAgeMs) await this.remove(group.requestId);
    // Restart also enforces byte retention, without a third record-count limit.
    await this.admit(0);
  }
  async admit(required, candidate = null) {
    for (;;) {
      let bytes = 0, oldest = null, unknown = false;
      for await (const group of this.scan()) { bytes += group.bytes; unknown ||= !group.row; if (group.row && (!oldest || order(group.row, oldest) < 0)) oldest = group.row; }
      if (bytes + required <= this.maxTotalBytes) return true;
      if (unknown || !oldest || candidate && order(candidate, oldest) < 0) return false;
      await this.remove(oldest.requestId);
    }
  }
  // Sanitize/materialize within one queue. Keep raw capture reservations alive
  // until publication/cleanup; response handlers never await this operation.
  open({ generation, ts, requestId, method, pathname }) {
    return this.publish({ generation, ts, requestId, release() {}, produce: () => ({ request: { requestId, ts, method, pathname, status: null, complete: false, state: 'open', attemptCount: 0 }, attempts: [], bodies: [] }) });
  }
  publish({ generation, ts, requestId, produce, release, requireOpen = false }) {
    if (this.pending >= 128) { this.health.dropped++; release(); return Promise.resolve(false); }
    this.pending++;
    return this.serial(async () => {
      let tmp = null;
      try {
        if (generation !== this.generation || ts <= this.now() - this.maxAgeMs || !validDetailId(requestId)) { this.health.dropped++; return false; }
        if (requireOpen) {
          let previous;
          try { previous = JSON.parse(await this.readFile(path.join(this.dir, requestId), 'manifest.json', 1024 * 1024)); }
          catch (error) { if (error.code === 'ENOENT' || error.statusCode === 404) { this.health.dropped++; return false; } throw error; }
          if (previous.request?.state !== 'open') { this.health.dropped++; return false; }
        }
        const { request, attempts, bodies } = produce();
        const group = this.validate({ request, attempts, bodies: bodies.map((body) => body.descriptor) }, requestId);
        const metadata = JSON.stringify(group);
        const bytes = Buffer.byteLength(metadata) + bodies.reduce((sum, body) => sum + Buffer.byteLength(body.text), 0);
        if (Buffer.byteLength(metadata) > 1024 * 1024 || bytes > this.maxTotalBytes) { this.health.dropped++; return false; }
        await this.expire();
        if (!await this.admit(bytes, { ts, requestId })) { this.health.dropped++; return false; }
        tmp = path.join(this.dir, '.tmp-' + randomUUID());
        await this.safeDirectory(this.dir); await this.io.mkdir(tmp, { mode: 0o700 });
        for (const body of bodies) await this.io.writeFile(path.join(tmp, body.descriptor.bodyId + '.txt'), body.text, { mode: 0o600, flag: 'wx' });
        await this.io.writeFile(path.join(tmp, 'manifest.json'), metadata, { mode: 0o600, flag: 'wx' });
        if (generation !== this.generation || ts <= this.now() - this.maxAgeMs) { this.health.dropped++; return false; }
        if (requireOpen) {
          const dir = path.join(this.dir, requestId);
          // Admission may have evicted this active root. Never recreate it.
          try { await this.safeDirectory(dir); } catch (error) { if (error.code === 'ENOENT' || error.statusCode === 404) { this.health.dropped++; return false; } throw error; }
          for (const body of bodies) await this.io.rename(path.join(tmp, body.descriptor.bodyId + '.txt'), path.join(dir, body.descriptor.bodyId + '.txt'));
          await this.io.rename(path.join(tmp, 'manifest.json'), path.join(dir, 'manifest.json'));
          await this.io.rm(tmp, { recursive: true, force: true }); tmp = null;
        } else { await this.io.rename(tmp, path.join(this.dir, requestId)); tmp = null; }
        return true;
      } catch { this.failure(); return false; }
      finally { if (tmp) try { await this.io.rm(tmp, { recursive: true, force: true }); } catch { this.failure(); } release(); this.pending--; }
    });
  }
  query(query = {}) {
    return this.serial(async () => {
      await this.expire(); const page = []; const limit = query.limit || 50;
      for await (const { row } of this.scan()) {
        if (!row || query.requestId && row.requestId !== query.requestId || query.from !== undefined && row.ts < query.from || query.to !== undefined && row.ts > query.to || query.status !== undefined && row.status !== query.status || query.model && !(row.model || '').includes(query.model) || query.account && !(row.accounts || []).some((a) => a.includes(query.account)) || query.cursor && order(row, query.cursor) >= 0) continue;
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
        const group = this.validate(JSON.parse(await this.readFile(path.join(this.dir, id), 'manifest.json', 1024 * 1024)), id);
        if (group.request.ts <= this.now() - this.maxAgeMs) { await this.remove(id); throw missing(); }
        for (const body of group.bodies) {
          const file = await this.io.lstat(path.join(this.dir, id, body.bodyId + '.txt'));
          if (!file.isFile() || file.size !== body.capturedBytes) throw missing();
        }
        return group;
      } catch (error) {
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
      return { ok: true };
    });
  }
}
