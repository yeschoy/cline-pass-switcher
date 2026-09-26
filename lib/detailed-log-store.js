import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { validRawHeaders } from './raw-detail-headers.js';

export const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const RAW_MAX_AGE_MS = 48 * 60 * 60 * 1000;
export const RAW_MAX_BODY_BYTES = 35 * 1024 * 1024;
const RAW_NAME = /^(\d{1,16})-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;
const rawName = (ts, id) => `${ts}-${id}`;
const ownedRawName = (name) => { const match = RAW_NAME.exec(name); return match && Number.isSafeInteger(Number(match[1])) && Number(match[1]) > 0 && String(Number(match[1])) === match[1] ? { ts: Number(match[1]), requestId: match[2] } : null; };
export const MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
const RECONCILE_INTERVAL_MS = 60 * 60 * 1000;
const MAX_INVENTORY_ENTRIES = 100000;
const MAX_INVENTORY_BYTES = 64 * 1024 * 1024;
const INVENTORY_ENTRY_OVERHEAD = 256;
// Fixed categories; never accept request-derived labels.
export const DETAIL_DROP_REASONS = Object.freeze(['activeLimit', 'attemptLimit', 'attemptCaptureFailure', 'captureBudget', 'redactionSecretLimit', 'redactionWorkLimit', 'redactionOutputLimit', 'redactionOther', 'storeQueue', 'storeStale', 'storeOpenRoot', 'storeSize', 'storeCapacity', 'other']);
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
    this.dir = dir; this.rawDir = path.join(dir, 'raw'); this.rawMaxAgeMs = RAW_MAX_AGE_MS; this.rawReads = 0; this.maxAgeMs = maxAgeMs; this.maxTotalBytes = maxTotalBytes; this.maxInventoryEntries = maxInventoryEntries; this.maxInventoryBytes = maxInventoryBytes; this.now = now; this.io = io;
    this.generation = 0; this.pending = 0; this.accepting = true; this.closed = false; this.closePromise = null;
    this.health = { failures: 0, dropped: 0, corrupt: 0, lastFailure: null, rawWarnings: 0, dropReasons: Object.fromEntries(DETAIL_DROP_REASONS.map((reason) => [reason, 0])) };
    this.entries = new Map(); this.totalBytes = 0; this.unknownEntries = 0; this.inventoryBytes = 0;
    this.temporary = new Set(); this.ready = false; this.needsReconcile = false; this.inventoryOverflow = false; this.startupRecoveryPending = true;
    this.queue = this.startup().catch(() => this.failure());
    this.timer = setInterval(() => { void this.serial(() => this.expire({ scanRaw: true })).catch(() => {}); }, Math.min(maxAgeMs, 60000)); this.timer.unref();
    this.reconcileTimer = setInterval(() => { void this.serial(() => this.reconcile()).catch(() => {}); }, RECONCILE_INTERVAL_MS); this.reconcileTimer.unref();
  }
  close() {
    if (this.closePromise) return this.closePromise;
    this.accepting = false;
    clearInterval(this.timer); clearInterval(this.reconcileTimer);
    this.closePromise = (async () => { await this.queue; this.closed = true; })();
    return this.closePromise;
  }
  recordDrop(reason) {
    // Saturate the whole distribution together: no partial increment or unsafe sum.
    if (this.health.dropped >= Number.MAX_SAFE_INTEGER) return;
    const key = DETAIL_DROP_REASONS.includes(reason) ? reason : 'other';
    this.health.dropReasons[key]++;
    this.health.dropped++;
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
  async readFile(dir, name, maxBytes, raw = false) {
    await this.safeDirectory(this.dir); if (dir === this.rawDir || dir.startsWith(this.rawDir + path.sep)) await this.safeDirectory(this.rawDir); await this.safeDirectory(dir);
    const entry = await this.io.lstat(path.join(dir, name));
    if (!entry.isFile() || entry.isSymbolicLink()) throw missing();
    const handle = await this.io.open(path.join(dir, name), constants.O_RDONLY | constants.O_NOFOLLOW);
    try { const stat = await handle.stat(); if (!stat.isFile() || stat.size > maxBytes) throw missing(); if (raw) {
      const bytes = Buffer.allocUnsafe(stat.size); let offset = 0;
      while (offset < bytes.length) { const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset); if (!bytesRead) throw missing(); offset += bytesRead; }
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    }
    return await handle.readFile('utf8'); }
    finally { await handle.close(); }
  }
  summary(request) {
    const { requestId, ts, method, pathname, model, accounts, status, result, complete, state, attemptCount } = request;
    const profile = ['full', 'error', 'raw-full', 'raw-error'].includes(request.profile) ? request.profile : 'full';
    return { requestId, ts, method, pathname, model, accounts, status, result, complete, state, attemptCount, profile, httpStatus: request.httpStatus ?? status ?? null, outcomeStatus: request.outcomeStatus ?? status ?? null, captureState: request.captureState || state || null };
  }
  validate(group, id, raw = false, directoryTs = null) {
    if (group.request?.requestId !== id || !Number.isSafeInteger(group.request.ts) || !Array.isArray(group.attempts) || !Array.isArray(group.bodies) || group.bodies.length > 514) throw new SyntaxError('invalid manifest');
    if (group.attempts.length > 256 || new Set(group.bodies.map((body) => body?.bodyId)).size !== group.bodies.length || group.request.model !== undefined && typeof group.request.model !== 'string' || group.request.accounts !== undefined && (!Array.isArray(group.request.accounts) || group.request.accounts.some((a) => typeof a !== 'string')) || !(['full', 'error'].includes(group.request.profile ?? 'full') && !raw || ['raw-full', 'raw-error'].includes(group.request.profile) && raw && group.request.ts === directoryTs)) throw new SyntaxError('invalid manifest metadata');
    if (raw) {
      // Only independently safe Header maps; no free-form URL/account/model fields.
      const requestKeys = ['requestId','ts','method','pathname','profile','model','accounts','status','httpStatus','outcomeStatus','result','complete','state','captureState','attemptCount','omittedAttempts','requestBody','responseBody','headers','responseHeaders'];
      const attemptKeys = ['callId','attemptIndex','ts','method','status','httpStatus','outcomeStatus','captureState','state','requestBody','responseBody','headers','responseHeaders'];
      const paths = new Set(['/chat/completions','/v1/chat/completions','/api/v1/chat/completions','/api/test','/api/probe','/api/validate-upstreams','/api/accounts/test','/api/accounts/proxy-test','/v1/responses','/models','/v1/models','/api/v1/models']);
      const statusOK = (value) => value === null || value === undefined || Number.isInteger(value) && value >= 100 && value <= 599;
      const stateOK = (value) => typeof value === 'string' && ['open','complete','incomplete','interrupted','resource-limited','pending','success','response-error','no-response','transport-failed','stream-transport-failed','stream-started','client-cancelled'].includes(value);
      if (Object.keys(group.request).some((key) => !requestKeys.includes(key)) || group.request.model !== '' || group.request.accounts?.length !== 0 || !['POST','GET'].includes(group.request.method) || !paths.has(group.request.pathname) || !statusOK(group.request.status) || !statusOK(group.request.httpStatus) || !statusOK(group.request.outcomeStatus) || group.request.result !== null && group.request.result !== undefined && !['success','failed','client_cancelled'].includes(group.request.result) || !stateOK(group.request.state) || typeof group.request.complete !== 'boolean' || group.request.omittedAttempts !== undefined && (!Number.isSafeInteger(group.request.omittedAttempts) || group.request.omittedAttempts < 0) || group.request.captureState !== undefined && !stateOK(group.request.captureState) || !Number.isSafeInteger(group.request.attemptCount) || group.request.attemptCount !== group.attempts.length || group.request.headers !== undefined && (!validRawHeaders(group.request.headers) || group.request.profile === 'raw-error') || group.request.responseHeaders !== undefined && (!validRawHeaders(group.request.responseHeaders) || group.request.profile === 'raw-error') || group.attempts.some((attempt) => !attempt || Object.keys(attempt).some((key) => !attemptKeys.includes(key)) || attempt.headers !== undefined && !validRawHeaders(attempt.headers) || attempt.responseHeaders !== undefined && !validRawHeaders(attempt.responseHeaders) || !statusOK(attempt.status) || !statusOK(attempt.httpStatus) || !statusOK(attempt.outcomeStatus) || !stateOK(attempt.state) || !stateOK(attempt.captureState) || !['POST','GET'].includes(attempt.method) || !Number.isSafeInteger(attempt.ts) || attempt.ts < 0)) throw new SyntaxError('unsafe raw metadata');
      if (group.bodies.some((body) => !body || typeof body !== 'object')) throw new SyntaxError('invalid raw body');
      const bodyIds = new Set(group.bodies.map((body) => body.bodyId));
      if ([group.request.requestBody, group.request.responseBody, ...group.attempts.flatMap((attempt) => [attempt.requestBody, attempt.responseBody])].some((id) => id !== undefined && !bodyIds.has(id))) throw new SyntaxError('invalid raw body reference');
      if (group.bodies.some((body) => Object.keys(body).some((key) => !['bodyId','observedBytes','capturedBytes','truncated','complete','state','omittedTailBytes','redacted'].includes(key)) || !Number.isSafeInteger(body.observedBytes) || body.observedBytes < 0 || body.observedBytes > Number.MAX_SAFE_INTEGER || !Number.isSafeInteger(body.omittedTailBytes) || body.omittedTailBytes < 0 || !['complete','truncated','interrupted','unread','omitted-for-safety','resource-limited'].includes(body.state) || typeof body.truncated !== 'boolean' || typeof body.complete !== 'boolean')) throw new SyntaxError('unsafe raw descriptor');
    }
    const attemptIdentities = new Set();
    for (const attempt of group.attempts) {
      const hasIndex = attempt?.attemptIndex !== undefined, hasCallId = attempt?.callId !== undefined;
      if (hasIndex && (!Number.isSafeInteger(attempt.attemptIndex) || attempt.attemptIndex < 0) || hasCallId && !validDetailId(attempt.callId) || ['error', 'raw-error'].includes(group.request.profile) && (!hasIndex || !hasCallId)) throw new SyntaxError('invalid attempt identity');
      if (hasIndex && hasCallId) { const identity = `${attempt.attemptIndex}\0${attempt.callId}`; if (attemptIdentities.has(identity)) throw new SyntaxError('duplicate attempt identity'); attemptIdentities.add(identity); }
    }
    for (const body of group.bodies) if (!body || !validDetailId(body.bodyId) || !Number.isSafeInteger(body.capturedBytes) || body.capturedBytes < 0 || body.capturedBytes > (raw ? RAW_MAX_BODY_BYTES : 5 * 1024 * 1024) || raw && body.redacted !== false) throw new SyntaxError('invalid body descriptor');
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
  // The timestamp in a strict directory name establishes ownership without trusting
  // manifest bytes. Never follow or remove an unexpected file or link.
  async rawOwned(dir, name) {
    const identity = ownedRawName(name);
    if (!identity) return null;
    await this.safeDirectory(this.rawDir); await this.safeDirectory(dir);
    const sizes = new Map(); let bytes = 0;
    for await (const file of await this.io.opendir(dir)) {
      if (!file.isFile() || file.name !== 'manifest.json' && !(file.name.endsWith('.txt') && validDetailId(file.name.slice(0, -4))) && !(file.name.startsWith('.manifest-') && validDetailId(file.name.slice(10)))) return null;
      const stat = await this.io.lstat(path.join(dir, file.name));
      if (!stat.isFile() || stat.isSymbolicLink()) return null;
      bytes += stat.size;
      if (sizes.size > 514) return null;
      sizes.set(file.name, stat.size);
    }
    return { ...identity, sizes, bytes };
  }
  async scanRaw() {
    await this.safeDirectory(this.rawDir);
    const entries = []; let warnings = 0, suspicious = 0, overflow = false;
    const add = (value) => { if (entries.length < this.maxInventoryEntries) entries.push(value); else overflow = true; };
    for await (const item of await this.io.opendir(this.rawDir)) {
      const dir = path.join(this.rawDir, item.name);
      const temporary = item.name.startsWith('.tmp-') && ownedRawName(item.name.slice(5));
      const owned = item.isDirectory() && await this.rawOwned(dir, temporary ? item.name.slice(5) : item.name);
      if (temporary && owned) {
        // No publication is active at startup/reconciliation; during minute work
        // the serial queue excludes active writers.
        await this.io.rm(dir, { recursive: true, force: true }); continue;
      }
      if (!owned || owned.ts > this.now()) { warnings++; add({ requestId: `raw-unknown-${++suspicious}`, bytes: this.maxTotalBytes, manifestBytes: 0, row: null, raw: true, dirName: null }); continue; }
      if (owned.ts <= this.now() - this.rawMaxAgeMs) {
        // Recheck ownership immediately before recursive deletion, including corrupt manifests.
        if (await this.rawOwned(dir, item.name)) {
          try { await this.io.rm(dir, { recursive: true, force: true }); continue; }
          catch { this.failure(); add({ requestId: owned.requestId, bytes: this.maxTotalBytes, manifestBytes: 0, row: null, raw: true, dirName: item.name }); continue; }
        }
        warnings++; add({ requestId: `raw-unknown-${++suspicious}`, bytes: this.maxTotalBytes, manifestBytes: 0, row: null, raw: true, dirName: null }); continue;
      }
      let group = null;
      try {
        group = this.validate(JSON.parse(await this.readFile(dir, 'manifest.json', 1024 * 1024)), owned.requestId, true, owned.ts);
        if (group.bodies.some((body) => owned.sizes.get(body.bodyId + '.txt') !== body.capturedBytes)) throw new SyntaxError('invalid raw body size');
      } catch (error) { if (error instanceof SyntaxError) this.health.corrupt++; else if (error.code !== 'ENOENT' && error.statusCode !== 404) { this.failure(); this.needsReconcile = true; } }
      add({ requestId: owned.requestId, bytes: owned.bytes, manifestBytes: owned.sizes.get('manifest.json') || 0, row: group ? this.summary(group.request) : null, raw: true, dirName: item.name });
    }
    this.health.rawWarnings = Math.min(warnings, Number.MAX_SAFE_INTEGER);
    if (overflow) { this.inventoryOverflow = true; throw new Error('raw inventory capacity exceeded'); }
    return entries;
  }
  async refreshRaw() {
    const entries = new Map([...this.entries].filter(([, entry]) => !entry.raw)); let inventoryBytes = 0;
    for (const entry of entries.values()) inventoryBytes += entry.indexBytes;
    for (const value of await this.scanRaw()) {
      const entry = this.indexedEntry(value);
      if (entries.has(entry.requestId) || entries.size + 1 > this.maxInventoryEntries || inventoryBytes + entry.indexBytes > this.maxInventoryBytes) { this.inventoryOverflow = true; throw new Error('raw inventory unavailable'); }
      entries.set(entry.requestId, entry); inventoryBytes += entry.indexBytes;
    }
    this.replaceEntries(entries, inventoryBytes);
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
    await this.io.mkdir(this.rawDir, { recursive: true, mode: 0o700 }); await this.safeDirectory(this.rawDir); await this.io.chmod(this.rawDir, 0o700);
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
      const dir = indexed.raw ? path.join(this.rawDir, indexed.dirName) : path.join(this.dir, indexed.requestId);
      const group = this.validate(JSON.parse(await this.readFile(dir, 'manifest.json', 1024 * 1024)), indexed.requestId, !!indexed.raw, indexed.raw ? indexed.row.ts : null);
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
    // Raw TTL must run even when the unrelated legacy catalog cannot fit.
    const rawEntries = await this.scanRaw();
    await this.cleanupTemporary();
    const entries = new Map(), state = {}; let inventoryBytes = 0;
    for await (const value of this.scan({ state, cleanupOrphans })) {
      const entry = this.indexedEntry(value);
      if (entries.size + 1 > this.maxInventoryEntries || inventoryBytes + entry.indexBytes > this.maxInventoryBytes) {
        this.inventoryOverflow = true; throw new Error('detailed inventory capacity exceeded');
      }
      entries.set(entry.requestId, entry); inventoryBytes += entry.indexBytes;
    }
    for (const value of rawEntries) {
      const entry = this.indexedEntry(value);
      if (entries.has(entry.requestId) || entries.size + 1 > this.maxInventoryEntries || inventoryBytes + entry.indexBytes > this.maxInventoryBytes) { this.inventoryOverflow = true; throw new Error('raw inventory capacity exceeded'); }
      entries.set(entry.requestId, entry); inventoryBytes += entry.indexBytes;
    }
    this.replaceEntries(entries, inventoryBytes); this.ready = true; this.needsReconcile = !!state.retry;
    await this.expire({ skipEnsure: true });
  }
  async remove(id) {
    const entry = this.entries.get(id);
    if (entry?.raw) {
      if (!entry.dirName || !await this.rawOwned(path.join(this.rawDir, entry.dirName), entry.dirName)) { this.health.rawWarnings++; throw new Error('raw ownership unavailable'); }
      await this.io.rm(path.join(this.rawDir, entry.dirName), { recursive: true, force: true });
    } else await this.io.rm(path.join(this.dir, id), { recursive: true, force: true });
    this.forgetEntry(id);
  }
  async expire({ skipEnsure = false, scanRaw = false } = {}) {
    if (this.inventoryOverflow) { if (scanRaw) await this.scanRaw(); throw new Error('detailed inventory unavailable'); }
    if (!skipEnsure && (!this.ready || this.needsReconcile)) {
      await this.reconcile({ cleanupOrphans: this.startupRecoveryPending });
      if (this.startupRecoveryPending && !this.needsReconcile) await this.ensureStartupRecovery();
      return;
    }
    if (!skipEnsure && this.startupRecoveryPending) { await this.ensureStartupRecovery(); return; }
    await this.cleanupTrackedTemporary();
    if (scanRaw) await this.refreshRaw();
    const cutoff = this.now() - this.maxAgeMs;
    for (const entry of [...this.entries.values()]) if (entry.raw ? entry.dirName && ownedRawName(entry.dirName)?.ts <= this.now() - this.rawMaxAgeMs : entry.row && entry.row.ts <= cutoff) await this.remove(entry.requestId);
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
  open({ generation, ts, requestId, method, pathname, profile = 'full' }) {
    return this.publish({ generation, ts, requestId, profile, release() {}, produce: () => ({ request: { requestId, ts, method, pathname, profile, ...(profile === 'raw-full' ? { model: '', accounts: [] } : {}), status: null, complete: false, state: 'open', attemptCount: 0 }, attempts: [], bodies: [] }) });
  }
  publish({ generation, ts, requestId, profile = 'full', produce, release, requireOpen = false }) {
    if (!this.accepting || this.pending >= 128) { this.recordDrop('storeQueue'); release(); return Promise.resolve(false); }
    this.pending++;
    return this.serial(async () => {
      let tmp = null, rootMutated = false;
      const raw = profile === 'raw-full' || profile === 'raw-error';
      const age = raw ? this.rawMaxAgeMs : this.maxAgeMs;
      const rootDir = raw ? this.rawDir : this.dir;
      const groupName = raw ? rawName(ts, requestId) : requestId;
      try {
        if (generation !== this.generation || ts <= this.now() - age || !validDetailId(requestId) || raw && (!Number.isSafeInteger(ts) || ts <= 0 || ts > this.now())) { this.recordDrop('storeStale'); return false; }
        await this.expire();
        const previousEntry = requireOpen ? this.entries.get(requestId) : null;
        if (requireOpen) {
          if (!previousEntry?.row) { this.recordDrop('storeOpenRoot'); return false; }
          let previous;
          try { previous = JSON.parse(await this.readFile(path.join(rootDir, groupName), 'manifest.json', 1024 * 1024)); }
          catch (error) { if (error.code === 'ENOENT' || error.statusCode === 404) { this.forgetEntry(requestId); this.recordDrop('storeOpenRoot'); return false; } throw error; }
          if (previous.request?.state !== 'open') { this.recordDrop('storeOpenRoot'); return false; }
        }
        const { request, attempts, bodies } = produce();
        const group = this.validate({ request, attempts, bodies: bodies.map((body) => body.descriptor) }, requestId, raw, raw ? ts : null);
        const metadata = JSON.stringify(group), manifestBytes = Buffer.byteLength(metadata);
        const bytes = manifestBytes + bodies.reduce((sum, body) => sum + Buffer.byteLength(body.text), 0);
        if (manifestBytes > 1024 * 1024 || bytes > this.maxTotalBytes) { this.recordDrop('storeSize'); return false; }
        const nextEntry = this.indexedEntry({ requestId, bytes, manifestBytes, row: this.summary(group.request), ...(raw ? { raw: true, dirName: groupName } : {}) });
        if (!this.canSetEntry(nextEntry) || !await this.admit(bytes, { ts, requestId })) { this.recordDrop('storeCapacity'); return false; }
        if (requireOpen && !this.entries.has(requestId)) { this.recordDrop('storeOpenRoot'); return false; }
        tmp = path.join(rootDir, '.tmp-' + (raw ? rawName(ts, randomUUID()) : randomUUID())); const temporaryName = path.basename(tmp); if (!raw) this.temporary.add(temporaryName);
        await this.safeDirectory(rootDir); await this.io.mkdir(tmp, { mode: 0o700 });
        for (const body of bodies) await this.io.writeFile(path.join(tmp, body.descriptor.bodyId + '.txt'), body.text, { mode: 0o600, flag: 'wx' });
        await this.io.writeFile(path.join(tmp, 'manifest.json'), metadata, { mode: 0o600, flag: 'wx' });
        if (generation !== this.generation || ts <= this.now() - age) { this.recordDrop('storeStale'); return false; }
        if (requireOpen) {
          const dir = path.join(rootDir, groupName);
          try { await this.safeDirectory(dir); } catch (error) { if (error.code === 'ENOENT' || error.statusCode === 404) { this.forgetEntry(requestId); this.recordDrop('storeOpenRoot'); return false; } throw error; }
          for (const body of bodies) {
            await this.io.rename(path.join(tmp, body.descriptor.bodyId + '.txt'), path.join(dir, body.descriptor.bodyId + '.txt'));
            rootMutated = true;
          }
          await this.io.rename(path.join(tmp, 'manifest.json'), path.join(dir, 'manifest.json')); rootMutated = true;
          await this.io.rm(tmp, { recursive: true, force: true });
        } else await this.io.rename(tmp, path.join(rootDir, groupName));
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
      const entry = this.entries.get(id), raw = !!entry?.raw;
      if (raw && (!entry.row || !entry.dirName)) throw missing();
      const dir = raw ? path.join(this.rawDir, entry.dirName) : path.join(this.dir, id);
      try {
        if (raw && !await this.rawOwned(dir, entry.dirName)) throw missing();
        const metadata = await this.readFile(dir, 'manifest.json', 1024 * 1024);
        const group = this.validate(JSON.parse(metadata), id, raw, raw ? ownedRawName(entry.dirName).ts : null);
        if (group.request.ts <= this.now() - (raw ? this.rawMaxAgeMs : this.maxAgeMs)) { await this.remove(id); throw missing(); }
        for (const body of group.bodies) {
          const file = await this.io.lstat(path.join(dir, body.bodyId + '.txt'));
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
  async body(id, bodyId, { holdRaw = false } = {}) {
    if (!validDetailId(bodyId)) throw invalid();
    const raw = !!this.entries.get(id)?.raw;
    if (raw && this.rawReads >= 4) throw Object.assign(new Error('detailed storage unavailable'), { statusCode: 503 });
    if (raw) this.rawReads++;
    let group;
    try { group = await this.detail(id); }
    catch (error) { if (raw) this.rawReads--; throw error; }
    const generation = this.generation;
    let held = false;
    try {
      if (!group.bodies.some((body) => body.bodyId === bodyId)) throw missing();
      const dir = raw ? path.join(this.rawDir, rawName(group.request.ts, id)) : path.join(this.dir, id);
      const text = await this.readFile(dir, bodyId + '.txt', raw ? RAW_MAX_BODY_BYTES : 5 * 1024 * 1024, raw);
      if (raw && Buffer.byteLength(text) !== group.bodies.find((body) => body.bodyId === bodyId).capturedBytes) throw missing();
      if (generation !== this.generation || group.request.ts <= this.now() - (raw ? this.rawMaxAgeMs : this.maxAgeMs)) throw missing();
      await this.safeDirectory(dir);
      if (holdRaw) {
        held = raw;
        let released = false;
        return { text, release: () => { if (released) return; released = true; if (raw) this.rawReads--; } };
      }
      return text;
    } catch (error) { if (error.code !== 'ENOENT' && error.statusCode !== 404) this.failure(); throw missing(); }
    finally { if (raw && !held) this.rawReads--; }
  }
  clear() {
    this.generation++;
    return this.serial(async () => {
      await this.cleanupTemporary();
      for await (const entry of await this.io.opendir(this.dir)) if (validDetailId(entry.name) && entry.isDirectory()) await this.remove(entry.name);
      await this.refreshRaw();
      for (const entry of [...this.entries.values()]) if (entry.raw && entry.dirName) await this.remove(entry.requestId);
      await this.reconcile();
      if (this.health.rawWarnings) throw new Error('suspicious raw entries require manual review');
      return { ok: true };
    });
  }
}
