import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const DAY = 24 * 60 * 60 * 1000;
const DEFAULT_SEGMENT_BYTES = 5 * 1024 * 1024;
const DEFAULT_TOTAL_BYTES = 100 * 1024 * 1024;
const DEFAULT_MAX_SEGMENTS = 10_000;
const DEFAULT_MAX_CATALOG_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_RECOVERY_RECORDS = 120_000;
const DEFAULT_MAX_RECOVERY_BYTES = 128 * 1024 * 1024;
const CATALOG_ENTRY_BYTES = 256;
const YIELD_EVERY = 1_000;

const immediate = () => new Promise((resolve) => setImmediate(resolve));
const serialized = (record) => `${JSON.stringify(record)}\n`;
const safeRecord = (record) => record && typeof record === 'object' && !Array.isArray(record) ? record : {};
const safeFile = (prefix, name) => name.startsWith(`${prefix}-`) && name.endsWith('.jsonl') && !name.startsWith('.');
const unavailable = (message) => Object.assign(new Error(message), { statusCode: 503 });

function recordIdentity(prefix, record) {
  if (record?.requestId) return `${prefix}\0${record.requestId}\0${prefix === 'errors' ? record.attemptIndex ?? -1 : ''}`;
  return `${prefix}\0${serialized(record)}`;
}

function entryOrder(left, right) {
  return Number(left.value.ts) - Number(right.value.ts)
    || String(left.value.requestId || '').localeCompare(String(right.value.requestId || ''))
    || Number(left.value.attemptIndex ?? -1) - Number(right.value.attemptIndex ?? -1)
    || left.file.localeCompare(right.file) || left.line - right.line;
}

function newestEntryOrder(left, right) { return entryOrder(right, left); }
function segmentOrder(left, right) {
  return left.minTs - right.minTs || left.maxTs - right.maxTs || left.name.localeCompare(right.name);
}
function newestSegmentOrder(left, right) {
  return right.maxTs - left.maxTs || right.minTs - left.minTs || right.name.localeCompare(left.name);
}

async function parseBuffer(buffer, file, prefix) {
  const text = Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer);
  const lines = text.split('\n');
  const truncated = !!text && !text.endsWith('\n');
  if (truncated) lines.pop();
  const entries = [];
  let malformed = 0;
  for (let line = 0; line < lines.length; line++) {
    if (line && line % YIELD_EVERY === 0) await immediate();
    if (!lines[line]) continue;
    try {
      const value = JSON.parse(lines[line]);
      if (!value || typeof value !== 'object' || Array.isArray(value)) { malformed++; continue; }
      entries.push({ value, file, line, bytes: Buffer.byteLength(lines[line]) + 1, identity: recordIdentity(prefix, value) });
    } catch { malformed++; }
  }
  return { entries, malformed, truncated, bytes: Buffer.byteLength(text) };
}

function segmentFromEntries(name, prefix, bytes, entries, { active = false, handle = null } = {}) {
  let minTs = Infinity, maxTs = -Infinity;
  for (const entry of entries) {
    const ts = Number(entry.value.ts);
    if (Number.isFinite(ts)) { minTs = Math.min(minTs, ts); maxTs = Math.max(maxTs, ts); }
  }
  return {
    name, prefix, bytes, records: entries.length,
    minTs: minTs === Infinity ? 0 : minTs,
    maxTs: maxTs === -Infinity ? 0 : maxTs,
    active, handle,
  };
}

function matches(record, filters) {
  return Object.entries(filters).every(([key, expected]) => {
    if (expected === undefined || expected === null || expected === '') return true;
    if (key === 'from') return Number(record.ts) >= Number(expected);
    if (key === 'to') return Number(record.ts) <= Number(expected);
    if (key === 'model') return [record.requestedModel, record.resolvedModel].some((value) => String(value || '').toLowerCase().includes(String(expected).toLowerCase()));
    if (key === 'account') return [record.accountId, record.accountName].some((value) => String(value || '').toLowerCase().includes(String(expected).toLowerCase()));
    if (key === 'provider') return [record.actualProvider, record.targetProvider, ...(record.targetProviders || []), ...(record.providerPath || [])].some((value) => String(value || '').toLowerCase().includes(String(expected).toLowerCase()));
    if (key === 'accountAction') return [record.accountAction, ...(record.accountActions || [])].some((value) => String(JSON.stringify(value) ?? '').toLowerCase().includes(String(expected).toLowerCase()));
    if (key === 'status' || key === 'upstreamStatus') return Number(record[key]) === Number(expected);
    const actual = record[key];
    if (Array.isArray(actual)) return actual.some((value) => String(JSON.stringify(value) ?? '').toLowerCase().includes(String(expected).toLowerCase()));
    if (typeof expected === 'boolean') return actual === expected;
    return String(actual ?? '').toLowerCase().includes(String(expected).toLowerCase());
  });
}

export class JsonlLogGroup {
  constructor({
    dir,
    streams = { requests: { maxRecords: 50_000 }, errors: { maxRecords: 10_000 } },
    maxAgeMs = 30 * DAY,
    segmentBytes = DEFAULT_SEGMENT_BYTES,
    maxTotalBytes = DEFAULT_TOTAL_BYTES,
    maxSegments = DEFAULT_MAX_SEGMENTS,
    maxCatalogBytes = DEFAULT_MAX_CATALOG_BYTES,
    maxRecoveryRecords = DEFAULT_MAX_RECOVERY_RECORDS,
    maxRecoveryBytes = DEFAULT_MAX_RECOVERY_BYTES,
    now = Date.now,
    io = fsp,
  } = {}) {
    if (!dir) throw new TypeError('ordinary log directory is required');
    this.dir = dir;
    this.io = io;
    this.now = now;
    this.maxAgeMs = maxAgeMs;
    this.segmentBytes = segmentBytes;
    this.maxTotalBytes = maxTotalBytes;
    this.maxSegments = maxSegments;
    this.maxCatalogBytes = maxCatalogBytes;
    this.maxRecoveryRecords = maxRecoveryRecords;
    this.maxRecoveryBytes = maxRecoveryBytes;
    this.catalogOverflow = false;
    this.status = 'initializing';
    this.health = { failures: 0, dropped: 0, lastFailure: null };
    this.queue = Promise.resolve();
    this.maintenanceScheduled = false;
    this.closed = false;
    this.catalogGeneration = 0;
    this.states = new Map(Object.entries(streams).map(([prefix, value]) => [prefix, {
      prefix,
      maxRecords: value.maxRecords,
      segments: [],
      live: [],
      active: null,
      sequence: 0,
      recoveryBytes: 0,
    }]));
    this.directoryReady = this.io.mkdir(this.dir, { recursive: true, mode: 0o700 })
      .then(() => this.io.chmod(this.dir, 0o700));
    this.ready = this._recover().catch((error) => {
      this.status = 'unavailable';
      this.health.failures++;
      this.health.lastFailure = 'ordinary-log-recovery-failed';
      console.error('[日志] 普通日志恢复失败');
      throw error;
    });
    this.ready.catch(() => {});
    this.timer = setInterval(() => { if (this.status === 'ready') this._scheduleMaintenance(); }, Math.min(this.maxAgeMs, 60_000));
    this.timer.unref?.();
  }

  stream(prefix) {
    this._state(prefix);
    return {
      append: (record) => this.append(prefix, record),
      query: (options) => this.query(prefix, options),
      clear: () => this.clear(prefix),
      files: () => this.files(prefix),
    };
  }

  _state(prefix) {
    const state = this.states.get(prefix);
    if (!state) throw new TypeError(`unknown ordinary log stream: ${prefix}`);
    return state;
  }

  _mutate(fn, { failOpen = false } = {}) {
    const raw = this.queue.then(fn);
    const safe = raw.catch((error) => {
      if (failOpen) {
        this.health.failures++;
        this.health.lastFailure = 'ordinary-log-write-failed';
        console.error('[日志] 普通日志写入或维护失败');
      }
    });
    this.queue = safe;
    return failOpen ? safe : raw;
  }

  _assertReady() {
    if (this.status === 'initializing') throw unavailable('ordinary logs initializing');
    if (this.status !== 'ready') throw unavailable('ordinary logs unavailable');
  }

  _isLiveName(name) {
    for (const state of this.states.values()) if (state.live.some((segment) => segment.name === name)) return true;
    return false;
  }

  _allSegments() { return [...this.states.values()].flatMap((state) => state.segments); }
  _allLiveSegments() { return [...this.states.values()].flatMap((state) => state.live); }
  _totalBytes() { return this._allSegments().reduce((sum, segment) => sum + segment.bytes, 0); }
  _recordCount(state) { return state.segments.reduce((sum, segment) => sum + segment.records, 0); }

  _checkCatalog() {
    const count = this._allSegments().length;
    if (count > this.maxSegments || count * CATALOG_ENTRY_BYTES > this.maxCatalogBytes) {
      this.catalogOverflow = true;
      this.status = 'unavailable';
      throw new Error('ordinary log catalog capacity exceeded');
    }
  }

  async _recover() {
    await this.directoryReady;
    const names = (await this.io.readdir(this.dir)).filter((name) => [...this.states.keys()].some((prefix) => safeFile(prefix, name))).sort();
    if (names.length > this.maxSegments || names.length * CATALOG_ENTRY_BYTES > this.maxCatalogBytes) throw new Error('ordinary log catalog capacity exceeded');
    const parsedFiles = [];
    const prefixByFile = new Map();
    const winners = new Map();
    let recoveryRecords = 0, recoveryBytes = 0;
    for (let i = 0; i < names.length; i++) {
      if (i && i % 32 === 0) await immediate();
      const name = names[i];
      if (this._isLiveName(name)) continue;
      const prefix = [...this.states.keys()].find((candidate) => safeFile(candidate, name));
      if (!prefix) continue;
      let buffer;
      try {
        const stat = await this.io.lstat(path.join(this.dir, name));
        if (!stat.isFile() || stat.isSymbolicLink() || recoveryBytes + stat.size > this.maxRecoveryBytes) throw new Error('ordinary log recovery capacity exceeded');
        buffer = await this.io.readFile(path.join(this.dir, name));
      } catch (error) { if (error?.code === 'ENOENT') continue; throw error; }
      const parsed = await parseBuffer(buffer, name, prefix);
      recoveryBytes += parsed.bytes;
      recoveryRecords += parsed.entries.length;
      if (recoveryRecords > this.maxRecoveryRecords) throw new Error('ordinary log recovery capacity exceeded');
      prefixByFile.set(name, prefix);
      parsedFiles.push({ name, prefix, ...parsed });
      for (const entry of parsed.entries) winners.set(entry.identity, entry);
    }

    const cutoff = this.now() - this.maxAgeMs;
    let retained = [...winners.values()].filter((entry) => Number.isFinite(Number(entry.value.ts)) && Number(entry.value.ts) >= cutoff);
    for (const state of this.states.values()) {
      const own = retained.filter((entry) => prefixByFile.get(entry.file) === state.prefix).sort(entryOrder);
      if (own.length > state.maxRecords) {
        const ownSet = new Set(own), keep = new Set(own.slice(-state.maxRecords));
        retained = retained.filter((entry) => !ownSet.has(entry) || keep.has(entry));
      }
    }
    retained.sort(entryOrder);
    let retainedBytes = retained.reduce((sum, entry) => sum + entry.bytes, 0), drop = 0;
    while (drop < retained.length && retainedBytes > this.maxTotalBytes) retainedBytes -= retained[drop++].bytes;
    if (drop) retained = retained.slice(drop);
    const keep = new Set(retained);
    const recovered = new Map([...this.states.keys()].map((prefix) => [prefix, []]));

    for (const state of this.states.values()) {
      const files = parsedFiles.filter((file) => file.prefix === state.prefix);
      const dirty = [];
      const dirtyValues = [];
      for (const file of files) {
        const values = file.entries.filter((entry) => winners.get(entry.identity) === entry && keep.has(entry)).map((entry) => entry.value);
        const unchanged = values.length === file.entries.length && file.malformed === 0 && !file.truncated && file.bytes <= this.segmentBytes;
        if (unchanged && values.length) recovered.get(state.prefix).push(segmentFromEntries(file.name, state.prefix, file.bytes, file.entries));
        else {
          dirty.push(file.name);
          dirtyValues.push(...values);
        }
      }
      if (dirty.length) {
        const replacements = await this._writeSegments(state.prefix, dirtyValues);
        for (const name of dirty) await this._unlink(name);
        recovered.get(state.prefix).push(...replacements);
      }
    }

    await this._mutate(async () => {
      for (const state of this.states.values()) {
        const merged = new Map();
        for (const segment of [...recovered.get(state.prefix), ...state.live]) merged.set(segment.name, segment);
        state.segments = [...merged.values()].sort(segmentOrder);
      }
      if (this.catalogOverflow) throw new Error('ordinary log catalog capacity exceeded');
      this._checkCatalog();
      await this._maintainNow();
      this.status = 'ready';
      this.catalogGeneration++;
    });
  }

  async _writeSegments(prefix, values) {
    if (!values.length) return [];
    const chunks = [];
    let current = [], bytes = 0;
    for (const value of values) {
      const line = Buffer.from(serialized(value));
      if (current.length && bytes + line.length > this.segmentBytes) { chunks.push(current); current = []; bytes = 0; }
      current.push({ value, line }); bytes += line.length;
      if (bytes >= this.segmentBytes) { chunks.push(current); current = []; bytes = 0; }
    }
    if (current.length) chunks.push(current);
    const pending = [];
    try {
      for (const chunk of chunks) {
        const name = `${prefix}-${this.now()}-${randomUUID()}.jsonl`;
        const temp = `.${name}.tmp`;
        const body = Buffer.concat(chunk.map((entry) => entry.line));
        await this.io.writeFile(path.join(this.dir, temp), body, { mode: 0o600, flag: 'wx' });
        pending.push({ name, temp, body, chunk });
      }
      for (const item of pending) await this.io.rename(path.join(this.dir, item.temp), path.join(this.dir, item.name));
      return pending.map((item) => segmentFromEntries(item.name, prefix, item.body.length, item.chunk.map((entry, line) => ({ value: entry.value, file: item.name, line }))));
    } catch (error) {
      for (const item of pending) {
        await this.io.rm(path.join(this.dir, item.temp), { force: true }).catch(() => {});
        await this.io.rm(path.join(this.dir, item.name), { force: true }).catch(() => {});
      }
      throw error;
    }
  }

  async _unlink(name) {
    try { await this.io.unlink(path.join(this.dir, name)); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
  }

  async _newActive(state) {
    const name = `${state.prefix}-${this.now()}-${process.pid}-${state.sequence++}-${randomUUID()}.jsonl`;
    const handle = await this.io.open(path.join(this.dir, name), 'a', 0o600);
    const segment = segmentFromEntries(name, state.prefix, 0, [], { active: true, handle });
    state.active = segment;
    state.live.push(segment);
    if (this.status === 'ready') state.segments.push(segment);
    return segment;
  }

  async _closeSegment(state, segment) {
    if (!segment) return;
    if (segment.handle) { await segment.handle.close(); segment.handle = null; }
    segment.active = false;
    if (state.active === segment) state.active = null;
  }

  append(prefix, record) {
    const state = this._state(prefix);
    const value = safeRecord(record);
    const line = Buffer.from(serialized(value));
    return this._mutate(async () => {
      await this.directoryReady;
      if (this.catalogOverflow) { this.health.dropped++; return; }
      if (this.status !== 'ready') {
        const recoveryBytes = [...this.states.values()].reduce((sum, item) => sum + item.live.reduce((n, segment) => n + segment.bytes, 0), 0);
        if (recoveryBytes + line.length > this.maxTotalBytes) { this.health.dropped++; return; }
      }
      let segment = state.active;
      if (segment && segment.bytes && segment.bytes + line.length > this.segmentBytes) { await this._closeSegment(state, segment); segment = null; }
      if (!segment) {
        const count = this.status === 'ready' ? this._allSegments().length : this._allLiveSegments().length;
        if (count >= this.maxSegments || (count + 1) * CATALOG_ENTRY_BYTES > this.maxCatalogBytes) {
          this.catalogOverflow = true;
          this.status = 'unavailable';
          this.health.dropped++;
          return;
        }
        segment = await this._newActive(state);
      }
      try {
        let offset = 0;
        while (offset < line.length) {
          const { bytesWritten } = await segment.handle.write(line, offset, line.length - offset);
          if (!bytesWritten) throw new Error('ordinary log write made no progress');
          offset += bytesWritten;
        }
      } catch (error) {
        await this._closeSegment(state, segment).catch(() => {});
        await this._unlink(segment.name).catch(() => {});
        state.segments = state.segments.filter((item) => item !== segment);
        state.live = state.live.filter((item) => item !== segment);
        throw error;
      }
      const ts = Number(value.ts);
      segment.bytes += line.length;
      segment.records++;
      if (Number.isFinite(ts)) {
        segment.minTs = segment.records === 1 ? ts : Math.min(segment.minTs, ts);
        segment.maxTs = segment.records === 1 ? ts : Math.max(segment.maxTs, ts);
      }
      if (segment.bytes >= this.segmentBytes) await this._closeSegment(state, segment);
      if (this.status === 'ready') {
        this.catalogGeneration++;
        this._checkCatalog();
        if (this._recordCount(state) > state.maxRecords || this._totalBytes() > this.maxTotalBytes) this._scheduleMaintenance();
      }
    }, { failOpen: true });
  }

  _scheduleMaintenance() {
    if (this.maintenanceScheduled || this.closed) return;
    this.maintenanceScheduled = true;
    const timer = setImmediate(() => {
      this.maintenanceScheduled = false;
      if (this.status === 'ready') this._mutate(() => this._maintainNow(), { failOpen: true });
    });
    timer.unref?.();
  }

  async _deleteSegment(state, segment) {
    await this._closeSegment(state, segment);
    await this._unlink(segment.name);
    state.segments = state.segments.filter((item) => item !== segment);
    state.live = state.live.filter((item) => item !== segment);
    this.catalogGeneration++;
  }

  async _readSegment(segment) {
    const buffer = await this.io.readFile(path.join(this.dir, segment.name));
    return parseBuffer(buffer, segment.name, segment.prefix);
  }

  async _replaceSegment(state, segment, values) {
    await this._closeSegment(state, segment);
    const replacements = await this._writeSegments(state.prefix, values);
    await this._unlink(segment.name);
    state.segments = state.segments.filter((item) => item !== segment);
    state.live = state.live.filter((item) => item !== segment);
    for (const replacement of replacements) { state.segments.push(replacement); state.live.push(replacement); }
    state.segments.sort(segmentOrder);
    this.catalogGeneration++;
  }

  async _trimSegment(state, segment, keep) {
    const parsed = await this._readSegment(segment);
    const entries = parsed.entries.sort(entryOrder);
    await this._replaceSegment(state, segment, entries.filter(keep).map((entry) => entry.value));
  }

  async _maintainNow() {
    const cutoff = this.now() - this.maxAgeMs;
    for (const state of this.states.values()) {
      for (const segment of [...state.segments].sort(segmentOrder)) {
        if (!segment.records || segment.maxTs < cutoff) await this._deleteSegment(state, segment);
        else if (segment.minTs < cutoff) await this._trimSegment(state, segment, (entry) => Number(entry.value.ts) >= cutoff);
      }
      while (this._recordCount(state) > state.maxRecords) {
        const excess = this._recordCount(state) - state.maxRecords;
        const oldest = [...state.segments].sort(segmentOrder)[0];
        if (!oldest) break;
        if (oldest.records <= excess) await this._deleteSegment(state, oldest);
        else {
          let dropped = 0;
          await this._trimSegment(state, oldest, () => dropped++ >= excess);
        }
      }
    }
    while (this._totalBytes() > this.maxTotalBytes) {
      const excess = this._totalBytes() - this.maxTotalBytes;
      const oldest = this._allSegments().sort(segmentOrder)[0];
      if (!oldest) break;
      const state = this._state(oldest.prefix);
      if (oldest.bytes <= excess) await this._deleteSegment(state, oldest);
      else {
        const parsed = await this._readSegment(oldest);
        const entries = parsed.entries.sort(entryOrder);
        let removed = 0, index = 0;
        while (index < entries.length && removed < excess) removed += entries[index++].bytes;
        await this._replaceSegment(state, oldest, entries.slice(index).map((entry) => entry.value));
      }
    }
    this._checkCatalog();
  }

  async maintain() {
    this._assertReady();
    return this._mutate(() => this._maintainNow());
  }

  async _queryPass(prefix, { limit, cursor, filters }, allowRetry) {
    const state = this._state(prefix);
    await this.queue;
    const generation = this.catalogGeneration;
    const segments = [...state.segments].filter((segment) => segment.records).sort(newestSegmentOrder);
    let cursorKey = null;
    if (cursor) {
      try { cursorKey = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); }
      catch { cursorKey = null; }
    }
    let seeking = !!cursorKey && segments.some((segment) => segment.name === cursorKey.segment);
    let cursorFound = !seeking;
    const page = [];
    let missing = false;
    for (const segment of segments) {
      let parsed;
      try { parsed = await this._readSegment(segment); }
      catch (error) { if (error?.code === 'ENOENT') { missing = true; continue; } throw error; }
      const entries = parsed.entries.sort(newestEntryOrder);
      for (const entry of entries) {
        if (!matches(entry.value, filters)) continue;
        if (seeking) {
          const exact = entry.file === cursorKey.segment && entry.line === cursorKey.line;
          const identity = Number(entry.value.ts) === Number(cursorKey.ts)
            && String(entry.value.requestId || '') === String(cursorKey.requestId || '')
            && Number(entry.value.attemptIndex ?? -1) === Number(cursorKey.attemptIndex ?? -1);
          if (exact || identity) { seeking = false; cursorFound = true; }
          continue;
        }
        page.push(entry);
        if (page.length > limit) break;
      }
      if (page.length > limit) break;
    }
    if ((!cursorFound || missing || generation !== this.catalogGeneration) && allowRetry) return this._queryPass(prefix, { limit, cursor: '', filters }, false);
    const visible = page.slice(0, limit), last = visible.at(-1);
    return {
      items: visible.map((entry) => entry.value),
      nextCursor: page.length > limit && last ? Buffer.from(JSON.stringify({
        ts: last.value.ts,
        requestId: last.value.requestId || '',
        attemptIndex: last.value.attemptIndex ?? -1,
        segment: last.file,
        line: last.line,
      })).toString('base64url') : null,
    };
  }

  async query(prefix, { limit = 50, cursor = '', filters = {} } = {}) {
    this._assertReady();
    const count = Math.min(200, Math.max(1, Number(limit) || 50));
    return this._queryPass(prefix, { limit: count, cursor, filters }, true);
  }

  async clear(prefix) {
    this._assertReady();
    const state = this._state(prefix);
    return this._mutate(async () => {
      await this._closeSegment(state, state.active);
      const known = new Set(state.segments.map((segment) => segment.name));
      const names = await this.io.readdir(this.dir);
      for (const name of names) if (safeFile(prefix, name)) known.add(name);
      for (const name of known) await this._unlink(name);
      state.segments = [];
      state.live = [];
      state.active = null;
      state.sequence = 0;
      this.catalogGeneration++;
    });
  }

  files(prefix) { return this._state(prefix).segments.map((segment) => segment.name).sort(); }

  async close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    await this.queue;
    for (const state of this.states.values()) await this._closeSegment(state, state.active);
  }
}
