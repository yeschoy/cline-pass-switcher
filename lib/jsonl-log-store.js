import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const DAY = 24 * 60 * 60 * 1000;
const DEFAULT_SEGMENT_BYTES = 5 * 1024 * 1024;
const DEFAULT_TOTAL_BYTES = 100 * 1024 * 1024;
const DEFAULT_MAX_SEGMENTS = 10_000;
const DEFAULT_MAX_CATALOG_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_RECOVERY_RECORDS = 120_000;
const DEFAULT_MAX_RECOVERY_BYTES = 128 * 1024 * 1024;
const DEFAULT_MAX_RECORD_BYTES = 64 * 1024;
const DEFAULT_MAX_PENDING_RECORDS = 10_000;
const DEFAULT_MAX_PENDING_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_INDEX_ROWS = 120_000;
const DEFAULT_MAX_SIDECAR_BYTES = 8 * 1024 * 1024;
const CATALOG_ENTRY_BYTES = 256;
const YIELD_EVERY = 1_000;
const SCAN_YIELD_EVERY = 5_000;
const READ_COALESCE_BYTES = 1024 * 1024;
const READ_COALESCE_GAP = 16 * 1024;
const RESIDUAL_BATCH = 64;
const SIDECAR_SUFFIX = '.idx';
const SIDECAR_VERSION = 1;
const SPECIAL_FILTERS = new Set(['from', 'to', 'requestId']);

// The HTTP whitelist and the indexed columns are the same contract.
export const ORDINARY_LOG_FILTERS = Object.freeze({
  requests: Object.freeze(['from', 'to', 'requestId', 'model', 'requestedModel', 'resolvedModel', 'account', 'accountId', 'accountName', 'strategy', 'status', 'result', 'upstreamStatus', 'stream', 'provider', 'actualProvider', 'targetProviders', 'overflow', 'switched', 'accountAction', 'errorCategory', 'inboundProtocol']),
  errors: Object.freeze(['from', 'to', 'requestId', 'model', 'requestedModel', 'resolvedModel', 'account', 'accountId', 'accountName', 'status', 'upstreamStatus', 'category', 'provider', 'targetProvider', 'accountAction', 'ruleId', 'ruleScope', 'ruleAction', 'errorScope', 'scopeEvidence', 'failureClass', 'healthAction', 'responseContentType']),
});

// Every record field that matches() reads for a filter key; must stay in sync with matches().
const FILTER_FIELDS = {
  model: ['requestedModel', 'resolvedModel'],
  account: ['accountId', 'accountName'],
  provider: ['actualProvider', 'targetProvider', 'targetProviders', 'providerPath'],
  accountAction: ['accountAction', 'accountActions'],
};

const immediate = () => new Promise((resolve) => setImmediate(resolve));
const serialized = (record) => `${JSON.stringify(record)}\n`;
const safeRecord = (record) => record && typeof record === 'object' && !Array.isArray(record) ? record : {};
const safeFile = (prefix, name) => name.startsWith(`${prefix}-`) && name.endsWith('.jsonl') && !name.startsWith('.');
const unavailable = (message) => Object.assign(new Error(message), { statusCode: 503 });
const lineHash = (line) => createHash('sha256').update(line).digest('base64url');
const sidecarName = (name) => `${name}${SIDECAR_SUFFIX}`;
const sameNumber = (left, right) => left === right || (left !== left && right !== right);
const fieldsFor = (key) => Object.hasOwn(FILTER_FIELDS, key) ? FILTER_FIELDS[key] : [key];
const isEnumerable = Object.prototype.propertyIsEnumerable;
const plainScalar = (value) => value === undefined || value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));
const encodeNumber = (value) => Number.isFinite(value) ? value : String(value);
const decodeNumber = (value) => typeof value === 'number' ? value
  : value === 'NaN' ? NaN : value === 'Infinity' ? Infinity : value === '-Infinity' ? -Infinity : undefined;

function recordIdentity(prefix, record) {
  if (record?.requestId) return `${prefix}\0${record.requestId}\0${prefix === 'errors' ? record.attemptIndex ?? -1 : ''}`;
  return `${prefix}\0#${lineHash(serialized(record))}`;
}

function projectionFor(key, record) {
  const picked = Object.create(null);
  for (const field of fieldsFor(key)) if (isEnumerable.call(record, field)) picked[field] = record[field];
  return JSON.stringify(picked);
}

// Same JSON object as projectionFor(); a top-level toJSON(key) needs the generic path for its key argument.
const projectors = new Map();
function projectorFor(key) {
  let projector = projectors.get(key);
  if (projector) return projector;
  const fields = fieldsFor(key).map((field) => [field, `${JSON.stringify(field)}:`]);
  projector = (record) => {
    let text = '{';
    for (const [field, label] of fields) {
      if (!isEnumerable.call(record, field)) continue;
      const value = record[field];
      if (value !== null && typeof value === 'object' && typeof value.toJSON === 'function') return projectionFor(key, record);
      const json = JSON.stringify(value);
      if (json === undefined) continue;
      text += text.length > 1 ? `,${label}${json}` : `${label}${json}`;
    }
    return `${text}}`;
  };
  projectors.set(key, projector);
  return projector;
}

// The index must describe the bytes on disk, so non-plain values are re-read from the serialized line.
function indexSource(value, line) {
  const proto = Object.getPrototypeOf(value);
  if ((proto === Object.prototype || proto === null) && typeof value.toJSON !== 'function'
    && plainScalar(value.ts) && plainScalar(value.requestId) && plainScalar(value.attemptIndex)) return value;
  return JSON.parse(line.toString('utf8'));
}

// Recovery must stay bounded by the catalog size, not by the bytes on disk.
function recoveryEntry(entry) {
  const { ts, requestId, attemptIndex } = entry.value;
  return { value: { ts, requestId, attemptIndex }, file: entry.file, line: entry.line, offset: entry.offset, bytes: entry.bytes, identity: entry.identity };
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
  let malformed = 0, offset = 0;
  for (let line = 0; line < lines.length; line++) {
    if (line && line % YIELD_EVERY === 0) await immediate();
    const size = Buffer.byteLength(lines[line]) + 1;
    const start = offset;
    offset += size;
    if (!lines[line]) continue;
    try {
      const value = JSON.parse(lines[line]);
      if (!value || typeof value !== 'object' || Array.isArray(value)) { malformed++; continue; }
      entries.push({ value, file, line, offset: start, bytes: size, identity: recordIdentity(prefix, value) });
    } catch { malformed++; }
  }
  return { entries, malformed, truncated, bytes: Buffer.byteLength(text) };
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

// Columnar filter facts for one segment: no bodies, only the projections matches() reads.
class SegmentIndex {
  constructor(keys) {
    this.keys = keys;
    this.count = 0;
    this.frozen = false;
    this.ts = [];
    this.offset = [];
    this.length = [];
    this.ai = [];
    this.ids = [];
    this.irregular = new Map();
    this.hashes = new Map();
    this.idMap = new Map();
    this.maxIdLength = 0;
    this.dicts = Object.create(null);
    this.cols = Object.create(null);
    this.lookup = Object.create(null);
    for (const key of keys) { this.dicts[key] = []; this.cols[key] = []; this.lookup[key] = new Map(); }
    this.projectors = keys.map(projectorFor);
    this.order = null;
    this.orderCount = -1;
  }

  add(record, offset, length, hashOf) {
    const row = this.count;
    const requestId = record.requestId, attemptIndex = record.attemptIndex;
    const id = String(requestId || '');
    const keys = this.keys, projections = new Array(keys.length);
    for (let position = 0; position < keys.length; position++) projections[position] = this.projectors[position](record);
    let raw = null;
    if (!(typeof requestId === 'string' || requestId === undefined || requestId === null)) (raw ||= {}).requestId = requestId;
    if (String(Number(attemptIndex ?? -1)) !== String(attemptIndex ?? -1)) (raw ||= {}).attemptIndex = attemptIndex;
    this.ts.push(Number(record.ts));
    this.offset.push(offset);
    this.length.push(length);
    this.ai.push(Number(attemptIndex ?? -1));
    this.ids.push(id);
    if (raw) this.irregular.set(row, raw);
    if (!(raw && 'requestId' in raw) && id) this._mapId(id, row);
    if (!requestId) this.hashes.set(row, hashOf());
    for (let position = 0; position < keys.length; position++) {
      const key = keys[position], text = projections[position], lookup = this.lookup[key];
      let code = lookup.get(text);
      if (code === undefined) { code = this.dicts[key].length; this.dicts[key].push(text); lookup.set(text, code); }
      this.cols[key].push(code);
    }
    this.count++;
  }

  _mapId(id, row) {
    const lower = id.toLowerCase();
    const prior = this.idMap.get(lower);
    if (prior === undefined) this.idMap.set(lower, row);
    else if (typeof prior === 'number') this.idMap.set(lower, [prior, row]);
    else prior.push(row);
    if (lower.length > this.maxIdLength) this.maxIdLength = lower.length;
  }

  freeze() {
    if (this.frozen) return this;
    this.ts = Float64Array.from(this.ts);
    this.offset = Uint32Array.from(this.offset);
    this.length = Uint32Array.from(this.length);
    this.ai = Float64Array.from(this.ai);
    for (const key of this.keys) {
      const size = this.dicts[key].length;
      const Type = size <= 0x100 ? Uint8Array : size <= 0x10000 ? Uint16Array : Uint32Array;
      this.cols[key] = Type.from(this.cols[key]);
    }
    this.lookup = null;
    this.frozen = true;
    return this;
  }

  compareRows(left, right) {
    return this.ts[left] - this.ts[right] || this.ids[left].localeCompare(this.ids[right]) || this.ai[left] - this.ai[right] || left - right;
  }

  // entryOrder(row, cursor) for a cursor that points into this segment.
  compareCursor(row, cursor) {
    return this.ts[row] - cursor.ts || this.ids[row].localeCompare(cursor.requestId) || this.ai[row] - cursor.attemptIndex || row - cursor.line;
  }

  orderFor(count) {
    if (this.order && this.orderCount === count) return this.order;
    const order = new Uint32Array(count);
    for (let row = 0; row < count; row++) order[row] = row;
    order.sort((left, right) => this.compareRows(right, left));
    this.order = order;
    this.orderCount = count;
    return order;
  }

  identity(prefix, row) {
    const raw = this.irregular.get(row);
    const requestId = raw && 'requestId' in raw ? raw.requestId : this.ids[row];
    if (!requestId) return `${prefix}\0#${this.hashes.get(row)}`;
    const attemptIndex = raw && 'attemptIndex' in raw ? raw.attemptIndex : this.ai[row];
    return `${prefix}\0${requestId}\0${prefix === 'errors' ? attemptIndex ?? -1 : ''}`;
  }

  serialize(segment, bytes, filters) {
    const count = this.count;
    const list = (values, map = (value) => value) => Array.from({ length: count }, (_, row) => map(values[row]));
    return JSON.stringify({
      segment, bytes, records: count, filters,
      ts: list(this.ts, encodeNumber),
      offset: list(this.offset),
      length: list(this.length),
      attemptIndex: list(this.ai, encodeNumber),
      requestId: list(this.ids),
      irregular: [...this.irregular],
      hashes: [...this.hashes],
      dicts: Object.fromEntries(this.keys.map((key) => [key, this.dicts[key]])),
      cols: Object.fromEntries(this.keys.map((key) => [key, list(this.cols[key])])),
    });
  }

  static fromSidecar(buffer, { name, bytes, filters, keys }) {
    const text = buffer.toString('utf8');
    const split = text.indexOf('\n');
    if (split < 0) return null;
    let header, body;
    try { header = JSON.parse(text.slice(0, split)); } catch { return null; }
    const bodyText = text.slice(split + 1);
    if (header?.v !== SIDECAR_VERSION || typeof header.sha256 !== 'string') return null;
    if (createHash('sha256').update(bodyText).digest('hex') !== header.sha256) return null;
    try { body = JSON.parse(bodyText); } catch { return null; }
    if (!body || typeof body !== 'object' || body.segment !== name || body.bytes !== bytes) return null;
    const count = body.records;
    if (!Number.isSafeInteger(count) || count < 1) return null;
    if (!Array.isArray(body.filters) || body.filters.length !== filters.length || body.filters.some((key, position) => key !== filters[position])) return null;
    const sized = (value) => Array.isArray(value) && value.length === count;
    if (![body.ts, body.offset, body.length, body.attemptIndex, body.requestId].every(sized)) return null;
    const index = new SegmentIndex(keys);
    const ts = new Float64Array(count), offset = new Uint32Array(count), length = new Uint32Array(count), ai = new Float64Array(count);
    let expected = 0;
    for (let row = 0; row < count; row++) {
      const start = body.offset[row], size = body.length[row];
      if (start !== expected || !Number.isSafeInteger(size) || size < 2) return null;
      expected = start + size;
      const time = decodeNumber(body.ts[row]), attempt = decodeNumber(body.attemptIndex[row]);
      if (time === undefined || attempt === undefined || typeof body.requestId[row] !== 'string') return null;
      ts[row] = time; offset[row] = start; length[row] = size; ai[row] = attempt;
    }
    if (expected !== bytes || expected > 0xffffffff) return null;
    const rowList = (value, check) => Array.isArray(value) && value.every((item, position) => Array.isArray(item) && item.length === 2
      && Number.isSafeInteger(item[0]) && item[0] >= 0 && item[0] < count && (!position || item[0] > value[position - 1][0]) && check(item[1]));
    if (!rowList(body.irregular, (raw) => raw && typeof raw === 'object' && !Array.isArray(raw) && ('requestId' in raw || 'attemptIndex' in raw))) return null;
    if (!rowList(body.hashes, (hash) => typeof hash === 'string' && hash.length > 0)) return null;
    index.ts = ts; index.offset = offset; index.length = length; index.ai = ai;
    index.ids = body.requestId;
    index.irregular = new Map(body.irregular);
    index.hashes = new Map(body.hashes);
    for (let row = 0; row < count; row++) {
      const raw = index.irregular.get(row);
      const requestId = raw && 'requestId' in raw ? raw.requestId : index.ids[row];
      if (raw && 'requestId' in raw && String(requestId || '') !== index.ids[row]) return null;
      if (raw && 'attemptIndex' in raw && !sameNumber(Number(raw.attemptIndex ?? -1), ai[row])) return null;
      if (!requestId !== index.hashes.has(row)) return null;
      if (!(raw && 'requestId' in raw) && index.ids[row]) index._mapId(index.ids[row], row);
    }
    if (!body.dicts || typeof body.dicts !== 'object' || !body.cols || typeof body.cols !== 'object') return null;
    for (const key of keys) {
      const dict = body.dicts[key], col = body.cols[key];
      if (!Array.isArray(dict) || !dict.length || !sized(col)) return null;
      for (const projection of dict) {
        if (typeof projection !== 'string') return null;
        try { const parsed = JSON.parse(projection); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null; }
        catch { return null; }
      }
      if (!col.every((code) => Number.isSafeInteger(code) && code >= 0 && code < dict.length)) return null;
      index.dicts[key] = dict;
      index.cols[key] = col;
    }
    index.count = count;
    index.frozen = false;
    return index.freeze();
  }
}

function indexFromEntries(keys, entries, prefix) {
  const index = new SegmentIndex(keys);
  for (const entry of entries) index.add(entry.value, entry.offset, entry.bytes, () => entry.identity.slice(prefix.length + 2));
  return index;
}

function segmentFromIndex(name, prefix, bytes, index, { active = false, handle = null } = {}) {
  let minTs = Infinity, maxTs = -Infinity;
  for (let row = 0; row < index.count; row++) {
    const ts = index.ts[row];
    if (Number.isFinite(ts)) { minTs = Math.min(minTs, ts); maxTs = Math.max(maxTs, ts); }
  }
  return {
    name, prefix, bytes, records: index.count,
    minTs: minTs === Infinity ? 0 : minTs,
    maxTs: maxTs === -Infinity ? 0 : maxTs,
    active, handle, index, sidecar: false,
  };
}

function decodeCursor(cursor) {
  if (!cursor) return null;
  let value;
  try { value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); }
  catch { return null; }
  if (!value || typeof value !== 'object' || typeof value.segment !== 'string') return null;
  return {
    segment: value.segment,
    ts: Number(value.ts),
    requestId: String(value.requestId || ''),
    attemptIndex: Number(value.attemptIndex ?? -1),
    line: Number(value.line),
  };
}

function filterPlan(filters, keys) {
  const indexed = new Set(keys);
  const plan = { from: null, to: null, requestId: null, columns: [], residual: null };
  for (const [key, expected] of Object.entries(filters || {})) {
    if (expected === undefined || expected === null || expected === '') continue;
    if (key === 'from') plan.from = Number(expected);
    else if (key === 'to') plan.to = Number(expected);
    else if (key === 'requestId') plan.requestId = { expected, lower: String(expected).toLowerCase(), boolean: typeof expected === 'boolean' };
    else if (indexed.has(key)) plan.columns.push({ key, expected });
    else (plan.residual ||= {})[key] = expected;
  }
  return plan;
}

function rowTester(plan, index) {
  const { from, to, requestId } = plan;
  const columns = plan.columns.map(({ key, expected }) => ({
    key, expected, col: index.cols[key], dict: index.dicts[key], memo: new Int8Array(index.dicts[key].length),
  }));
  const ts = index.ts, ids = index.ids, irregular = index.irregular;
  return (row) => {
    if (from !== null && !(ts[row] >= from)) return false;
    if (to !== null && !(ts[row] <= to)) return false;
    if (requestId) {
      const raw = irregular.size ? irregular.get(row) : undefined;
      if (raw && 'requestId' in raw) { if (!matches({ requestId: raw.requestId }, { requestId: requestId.expected })) return false; }
      else if (requestId.boolean || !ids[row].toLowerCase().includes(requestId.lower)) return false;
    }
    for (const column of columns) {
      const code = column.col[row];
      let state = column.memo[code];
      if (!state) {
        state = matches(JSON.parse(column.dict[code]), { [column.key]: column.expected }) ? 1 : 2;
        column.memo[code] = state;
      }
      if (state !== 1) return false;
    }
    return true;
  };
}

// Rows of one segment in scan order, starting strictly after the cursor when it points here.
function candidateRows(plan, index, count, cursor) {
  const exact = plan.requestId && !plan.requestId.boolean && plan.requestId.lower.length >= index.maxIdLength;
  if (exact) {
    const rows = [];
    const hit = index.idMap.get(plan.requestId.lower);
    if (typeof hit === 'number') rows.push(hit);
    else if (hit) rows.push(...hit);
    for (const [row, raw] of index.irregular) if ('requestId' in raw) rows.push(row);
    return rows
      .filter((row) => row < count && (!cursor || index.compareCursor(row, cursor) < 0))
      .sort((left, right) => index.compareRows(right, left));
  }
  const order = index.orderFor(count);
  if (!cursor) return order;
  let low = 0, high = order.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (index.compareCursor(order[middle], cursor) < 0) high = middle;
    else low = middle + 1;
  }
  return order.subarray(low);
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
    maxRecordBytes = DEFAULT_MAX_RECORD_BYTES,
    maxPendingRecords = DEFAULT_MAX_PENDING_RECORDS,
    maxPendingBytes = DEFAULT_MAX_PENDING_BYTES,
    maxIndexRows = DEFAULT_MAX_INDEX_ROWS,
    maxSidecarBytes = DEFAULT_MAX_SIDECAR_BYTES,
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
    this.maxRecordBytes = maxRecordBytes;
    this.maxPendingRecords = maxPendingRecords;
    this.maxPendingBytes = maxPendingBytes;
    this.maxIndexRows = maxIndexRows;
    this.maxSidecarBytes = maxSidecarBytes;
    this.pendingRecords = 0;
    this.pendingBytes = 0;
    this.catalogOverflow = false;
    this.status = 'initializing';
    this.health = { failures: 0, dropped: 0, pendingRecords: 0, pendingBytes: 0, lastFailure: null, indexDegraded: false, sidecarsRejected: 0 };
    this.queue = Promise.resolve();
    this.maintenanceScheduled = false;
    this.closed = false;
    this.catalogGeneration = 0;
    this.structureGeneration = 0;
    this.states = new Map(Object.entries(streams).map(([prefix, value]) => {
      const filters = Array.isArray(value.filters) ? value.filters.filter((key) => typeof key === 'string') : [];
      return [prefix, {
        prefix,
        maxRecords: value.maxRecords,
        filters,
        keys: [...new Set(filters.filter((key) => !SPECIAL_FILTERS.has(key)))],
        segments: [],
        live: [],
        active: null,
        sequence: 0,
        recoveryBytes: 0,
      }];
    }));
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
  _indexedRows() {
    let rows = 0;
    for (const segment of new Set([...this._allSegments(), ...this._allLiveSegments()])) rows += segment.index?.count || 0;
    return rows;
  }

  _isSidecar(name) {
    return name.endsWith(`.jsonl${SIDECAR_SUFFIX}`) && [...this.states.keys()].some((prefix) => safeFile(prefix, name.slice(0, -SIDECAR_SUFFIX.length)));
  }

  _isTempSidecar(name, prefixes = [...this.states.keys()]) {
    return name.startsWith('.') && name.endsWith(`.jsonl${SIDECAR_SUFFIX}.tmp`) && prefixes.some((prefix) => safeFile(prefix, name.slice(1, -SIDECAR_SUFFIX.length - 4)));
  }

  _checkCatalog() {
    const count = this._allSegments().length;
    if (count > this.maxSegments || count * CATALOG_ENTRY_BYTES > this.maxCatalogBytes) {
      this.catalogOverflow = true;
      this.status = 'unavailable';
      throw new Error('ordinary log catalog capacity exceeded');
    }
  }

  async _loadSidecar(name, prefix, bytes) {
    const state = this._state(prefix);
    const file = path.join(this.dir, sidecarName(name));
    try {
      const stat = await this.io.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > this.maxSidecarBytes) { this.health.sidecarsRejected++; return null; }
      const buffer = await this.io.readFile(file);
      const index = SegmentIndex.fromSidecar(buffer, { name, bytes, filters: state.filters, keys: state.keys });
      if (!index) { this.health.sidecarsRejected++; return null; }
      return { index, bytes: buffer.length };
    } catch {
      this.health.sidecarsRejected++;
      return null;
    }
  }

  async _writeSidecar(segment) {
    const index = segment.index;
    if (!index || !index.count || segment.active || this.maxSidecarBytes <= 0) return;
    const state = this._state(segment.prefix);
    const name = sidecarName(segment.name), temp = `.${name}.tmp`;
    try {
      const body = index.serialize(segment.name, segment.bytes, state.filters);
      const data = `${JSON.stringify({ v: SIDECAR_VERSION, sha256: createHash('sha256').update(body).digest('hex') })}\n${body}`;
      if (Buffer.byteLength(data) > this.maxSidecarBytes) return;
      await this.io.rm(path.join(this.dir, temp), { force: true });
      await this.io.writeFile(path.join(this.dir, temp), data, { mode: 0o600, flag: 'wx' });
      await this.io.rename(path.join(this.dir, temp), path.join(this.dir, name));
      segment.sidecar = true;
    } catch {
      await this.io.rm(path.join(this.dir, temp), { force: true }).catch(() => {});
      this.health.failures++;
      this.health.lastFailure = 'ordinary-log-index-write-failed';
    }
  }

  async _recover() {
    await this.directoryReady;
    const prefixes = [...this.states.keys()];
    const listing = await this.io.readdir(this.dir);
    const names = listing.filter((name) => prefixes.some((prefix) => safeFile(prefix, name))).sort();
    const sidecars = new Set(listing.filter((name) => this._isSidecar(name)));
    const strays = listing.filter((name) => this._isTempSidecar(name, prefixes));
    if (names.length > this.maxSegments || names.length * CATALOG_ENTRY_BYTES > this.maxCatalogBytes) throw new Error('ordinary log catalog capacity exceeded');
    const parsedFiles = [];
    const prefixByFile = new Map();
    const winners = new Map();
    let recoveryRecords = 0, recoveryBytes = 0;
    for (let i = 0; i < names.length; i++) {
      if (i && i % 32 === 0) await immediate();
      const name = names[i];
      if (this._isLiveName(name)) continue;
      const prefix = prefixes.find((candidate) => safeFile(candidate, name));
      if (!prefix) continue;
      const state = this._state(prefix);
      let stat;
      try { stat = await this.io.lstat(path.join(this.dir, name)); }
      catch (error) { if (error?.code === 'ENOENT') continue; throw error; }
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('ordinary log recovery capacity exceeded');
      let file = null;
      const loaded = sidecars.has(sidecarName(name)) ? await this._loadSidecar(name, prefix, stat.size) : null;
      if (loaded) {
        if (recoveryBytes + loaded.bytes > this.maxRecoveryBytes) throw new Error('ordinary log recovery capacity exceeded');
        recoveryBytes += loaded.bytes;
        const { index } = loaded;
        const entries = Array.from({ length: index.count }, (_, row) => ({
          value: { ts: index.ts[row], requestId: index.ids[row], attemptIndex: index.ai[row] },
          file: name, line: row, offset: index.offset[row], bytes: index.length[row], identity: index.identity(prefix, row),
        }));
        file = { name, prefix, malformed: 0, truncated: false, bytes: stat.size, entries, index, sidecar: true };
      } else {
        if (recoveryBytes + stat.size > this.maxRecoveryBytes) throw new Error('ordinary log recovery capacity exceeded');
        let buffer;
        try { buffer = await this.io.readFile(path.join(this.dir, name)); }
        catch (error) { if (error?.code === 'ENOENT') continue; throw error; }
        const parsed = await parseBuffer(buffer, name, prefix);
        buffer = null;
        recoveryBytes += parsed.bytes;
        const index = indexFromEntries(state.keys, parsed.entries, prefix);
        file = { name, prefix, malformed: parsed.malformed, truncated: parsed.truncated, bytes: parsed.bytes, entries: parsed.entries.map(recoveryEntry), index, sidecar: false };
      }
      recoveryRecords += file.entries.length;
      if (recoveryRecords > this.maxRecoveryRecords) throw new Error('ordinary log recovery capacity exceeded');
      prefixByFile.set(name, prefix);
      parsedFiles.push(file);
      for (const entry of file.entries) winners.set(entry.identity, entry);
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
      let pending = [], pendingBytes = 0;
      const flush = async () => {
        if (!pending.length) return;
        recovered.get(state.prefix).push(...await this._writeSegments(state.prefix, pending));
        pending = []; pendingBytes = 0;
      };
      for (const file of files) {
        const kept = file.entries.filter((entry) => winners.get(entry.identity) === entry && keep.has(entry));
        const unchanged = kept.length === file.entries.length && file.malformed === 0 && !file.truncated && file.bytes <= this.segmentBytes;
        if (unchanged && kept.length) {
          const segment = segmentFromIndex(file.name, state.prefix, file.bytes, file.index.freeze());
          segment.sidecar = file.sidecar;
          recovered.get(state.prefix).push(segment);
          continue;
        }
        dirty.push(file.name);
        if (!kept.length) continue;
        const offsets = new Set(kept.map((entry) => entry.offset));
        let parsed;
        try { parsed = await this._readSegment({ name: file.name, prefix: state.prefix }); }
        catch (error) { if (error?.code === 'ENOENT') continue; throw error; }
        for (const entry of parsed.entries) {
          if (!offsets.has(entry.offset)) continue;
          pending.push(entry.value); pendingBytes += entry.bytes;
        }
        if (pendingBytes >= this.segmentBytes) await flush();
      }
      await flush();
      for (const name of dirty) { await this._unlink(name); await this._unlink(sidecarName(name)); }
    }
    parsedFiles.length = 0;
    winners.clear();

    await this._mutate(async () => {
      for (const state of this.states.values()) {
        const merged = new Map();
        for (const segment of [...recovered.get(state.prefix), ...state.live]) merged.set(segment.name, segment);
        state.segments = [...merged.values()].sort(segmentOrder);
      }
      if (this.catalogOverflow) throw new Error('ordinary log catalog capacity exceeded');
      this._checkCatalog();
      this._enforceIndexCap();
      await this._maintainNow();
      this.status = 'ready';
      this.catalogGeneration++;
      this.structureGeneration++;
    });

    await this._mutate(async () => {
      const catalogued = new Set(this._allSegments().map((segment) => segment.name));
      for (const segment of this._allSegments()) if (!segment.active && !segment.sidecar) await this._writeSidecar(segment);
      for (const name of sidecars) if (!catalogued.has(name.slice(0, -SIDECAR_SUFFIX.length))) await this._unlink(name);
      for (const name of strays) await this._unlink(name);
    }, { failOpen: true });
  }

  async _writeSegments(prefix, values) {
    if (!values.length) return [];
    const state = this._state(prefix);
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
    } catch (error) {
      for (const item of pending) {
        await this.io.rm(path.join(this.dir, item.temp), { force: true }).catch(() => {});
        await this.io.rm(path.join(this.dir, item.name), { force: true }).catch(() => {});
      }
      throw error;
    }
    const segments = pending.map((item) => {
      const index = new SegmentIndex(state.keys);
      let offset = 0;
      for (const entry of item.chunk) {
        index.add(entry.value, offset, entry.line.length, () => lineHash(entry.line));
        offset += entry.line.length;
      }
      return segmentFromIndex(item.name, prefix, item.body.length, index.freeze());
    });
    for (const segment of segments) await this._writeSidecar(segment);
    return segments;
  }

  async _unlink(name) {
    try { await this.io.unlink(path.join(this.dir, name)); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
  }

  async _newActive(state) {
    const name = `${state.prefix}-${this.now()}-${process.pid}-${state.sequence++}-${randomUUID()}.jsonl`;
    const handle = await this.io.open(path.join(this.dir, name), 'a', 0o600);
    const segment = segmentFromIndex(name, state.prefix, 0, new SegmentIndex(state.keys), { active: true, handle });
    state.active = segment;
    state.live.push(segment);
    if (this.status === 'ready') state.segments.push(segment);
    return segment;
  }

  async _closeSegment(state, segment, { persist = true } = {}) {
    if (!segment) return;
    const wasActive = segment.active || !!segment.handle;
    if (segment.handle) { await segment.handle.close(); segment.handle = null; }
    segment.active = false;
    if (state.active === segment) state.active = null;
    segment.index?.freeze();
    if (persist && wasActive && segment.records) await this._writeSidecar(segment);
  }

  _dropIndex(segment) {
    if (!segment.index) return;
    segment.index = null;
    this.health.indexDegraded = true;
  }

  _enforceIndexCap() {
    let rows = this._indexedRows();
    if (rows <= this.maxIndexRows) return;
    for (const segment of this._allSegments().sort(segmentOrder)) {
      if (rows <= this.maxIndexRows) break;
      if (!segment.index) continue;
      rows -= segment.index.count;
      this._dropIndex(segment);
    }
  }

  append(prefix, record) {
    const state = this._state(prefix);
    const value = safeRecord(record);
    let line;
    try { line = Buffer.from(serialized(value)); }
    catch {
      this.health.dropped++;
      this.health.lastFailure = 'ordinary-log-record-invalid';
      return Promise.resolve(false);
    }
    if (this.closed || line.length > this.maxRecordBytes) {
      this.health.dropped++;
      this.health.lastFailure = this.closed ? 'ordinary-log-closed' : 'ordinary-log-record-too-large';
      return Promise.resolve(false);
    }
    if (this.pendingRecords + 1 > this.maxPendingRecords || this.pendingBytes + line.length > this.maxPendingBytes) {
      this.health.dropped++;
      this.health.lastFailure = 'ordinary-log-pending-capacity';
      return Promise.resolve(false);
    }
    this.pendingRecords++;
    this.pendingBytes += line.length;
    this.health.pendingRecords = this.pendingRecords;
    this.health.pendingBytes = this.pendingBytes;
    return this._mutate(async () => {
      try {
        await this.directoryReady;
        if (this.catalogOverflow) { this.health.dropped++; return false; }
        if (this.status !== 'ready') {
          const recoveryBytes = [...this.states.values()].reduce((sum, item) => sum + item.live.reduce((n, segment) => n + segment.bytes, 0), 0);
          if (recoveryBytes + line.length > this.maxTotalBytes) { this.health.dropped++; return false; }
        }
        let segment = state.active;
        if (segment && segment.bytes && segment.bytes + line.length > this.segmentBytes) { await this._closeSegment(state, segment); segment = null; }
        if (!segment) {
          const count = this.status === 'ready' ? this._allSegments().length : this._allLiveSegments().length;
          if (count >= this.maxSegments || (count + 1) * CATALOG_ENTRY_BYTES > this.maxCatalogBytes) {
            this.catalogOverflow = true;
            this.status = 'unavailable';
            this.health.dropped++;
            return false;
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
          await this._closeSegment(state, segment, { persist: false }).catch(() => {});
          await this._unlink(segment.name).catch(() => {});
          state.segments = state.segments.filter((item) => item !== segment);
          state.live = state.live.filter((item) => item !== segment);
          this.structureGeneration++;
          throw error;
        }
        if (segment.index) {
          if (this._indexedRows() + 1 > this.maxIndexRows) this._dropIndex(segment);
          else {
            try { segment.index.add(indexSource(value, line), segment.bytes, line.length, () => lineHash(line)); }
            catch { this._dropIndex(segment); }
          }
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
        return true;
      } finally {
        this.pendingRecords--;
        this.pendingBytes -= line.length;
        this.health.pendingRecords = this.pendingRecords;
        this.health.pendingBytes = this.pendingBytes;
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
    await this._closeSegment(state, segment, { persist: false });
    await this._unlink(segment.name);
    await this._unlink(sidecarName(segment.name));
    state.segments = state.segments.filter((item) => item !== segment);
    state.live = state.live.filter((item) => item !== segment);
    this.catalogGeneration++;
    this.structureGeneration++;
  }

  async _readSegment(segment) {
    const buffer = await this.io.readFile(path.join(this.dir, segment.name));
    return parseBuffer(buffer, segment.name, segment.prefix);
  }

  async _replaceSegment(state, segment, values) {
    await this._closeSegment(state, segment, { persist: false });
    const replacements = await this._writeSegments(state.prefix, values);
    await this._unlink(segment.name);
    await this._unlink(sidecarName(segment.name));
    state.segments = state.segments.filter((item) => item !== segment);
    state.live = state.live.filter((item) => item !== segment);
    for (const replacement of replacements) { state.segments.push(replacement); state.live.push(replacement); }
    state.segments.sort(segmentOrder);
    this.catalogGeneration++;
    this.structureGeneration++;
  }

  async _trimSegment(state, segment, keep) {
    const parsed = await this._readSegment(segment);
    const entries = parsed.entries.sort(entryOrder);
    await this._replaceSegment(state, segment, entries.filter(keep).map((entry) => entry.value));
  }

  // A segment loses its index only under the row fence or a detected mismatch; rebuild it when it fits again.
  async _reindexMissing() {
    for (const state of this.states.values()) {
      for (const segment of state.segments) {
        if (segment.index || !segment.records) continue;
        if (this._indexedRows() + segment.records > this.maxIndexRows) continue;
        const parsed = await this._readSegment(segment);
        if (parsed.malformed || parsed.truncated || parsed.entries.length !== segment.records || parsed.bytes !== segment.bytes) continue;
        const index = indexFromEntries(state.keys, parsed.entries, state.prefix);
        segment.index = segment.active ? index : index.freeze();
        if (!segment.active) await this._writeSidecar(segment);
      }
    }
    this.health.indexDegraded = this._allSegments().some((segment) => segment.records && !segment.index);
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
    if (this.health.indexDegraded) await this._reindexMissing();
  }

  async maintain() {
    this._assertReady();
    return this._mutate(() => this._maintainNow());
  }

  // Full-scan reference path: used when some segment has no index (row fence or detected mismatch).
  async _legacyQueryPass(prefix, { limit, cursor, filters }, allowRetry) {
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
    if ((!cursorFound || missing || generation !== this.catalogGeneration) && allowRetry) return this._legacyQueryPass(prefix, { limit, cursor: '', filters }, false);
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

  // Reads only the requested rows by byte range and checks each against its index facts.
  async _readRows(items) {
    const values = new Array(items.length).fill(null);
    const mismatched = new Set();
    let stale = false;
    const groups = new Map();
    items.forEach((item, position) => {
      let group = groups.get(item.segment);
      if (!group) groups.set(item.segment, group = []);
      group.push(position);
    });
    for (const [segment, positions] of groups) {
      const offsetOf = (position) => items[position].index.offset[items[position].row];
      const lengthOf = (position) => items[position].index.length[items[position].row];
      positions.sort((left, right) => offsetOf(left) - offsetOf(right));
      let handle;
      try { handle = await this.io.open(path.join(this.dir, segment.name), 'r'); }
      catch (error) { if (error?.code === 'ENOENT') { stale = true; continue; } throw error; }
      try {
        for (let first = 0; first < positions.length;) {
          const start = offsetOf(positions[first]);
          let end = start + lengthOf(positions[first]), last = first + 1;
          while (last < positions.length) {
            const next = offsetOf(positions[last]), nextEnd = next + lengthOf(positions[last]);
            if (next - end > READ_COALESCE_GAP || nextEnd - start > READ_COALESCE_BYTES) break;
            end = Math.max(end, nextEnd);
            last++;
          }
          const buffer = Buffer.allocUnsafe(end - start);
          let filled = 0;
          while (filled < buffer.length) {
            const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, start + filled);
            if (!bytesRead) break;
            filled += bytesRead;
          }
          for (let k = first; k < last; k++) {
            const position = positions[k], { index, row } = items[position];
            const from = offsetOf(position) - start, to = from + lengthOf(position);
            let value = null;
            if (to <= filled && buffer[to - 1] === 0x0a) {
              try { value = JSON.parse(buffer.toString('utf8', from, to - 1)); } catch { value = null; }
            }
            if (value && typeof value === 'object' && !Array.isArray(value)
              && sameNumber(Number(value.ts), index.ts[row]) && String(value.requestId || '') === index.ids[row]) values[position] = value;
            else { stale = true; mismatched.add(segment); }
          }
          first = last;
        }
      } finally { await handle.close().catch(() => {}); }
    }
    return { values, stale, mismatched };
  }

  async _indexedQueryPass(state, { limit, cursor, filters }, allowRetry) {
    const structure = this.structureGeneration;
    const plan = filterPlan(filters, state.keys);
    const snapshot = state.segments.filter((segment) => segment.records && segment.index)
      .sort(newestSegmentOrder)
      .map((segment) => ({ segment, index: segment.index, count: segment.index.count }));
    let cursorKey = decodeCursor(cursor), start = 0;
    if (cursorKey) {
      start = snapshot.findIndex((item) => item.segment.name === cursorKey.segment);
      if (start < 0) { start = 0; cursorKey = null; }
    }
    const target = limit + 1;
    const results = [];
    let batch = [], stale = false, scanned = 0, hasMore = false;
    const mismatched = new Set();
    const flush = async (rows) => {
      const read = await this._readRows(rows);
      if (read.stale) stale = true;
      for (const segment of read.mismatched) mismatched.add(segment);
      rows.forEach((item, position) => {
        const value = read.values[position];
        if (value && (!plan.residual || matches(value, plan.residual))) results.push({ ...item, value });
      });
    };
    scan: for (let s = start; s < snapshot.length; s++) {
      const { segment, index, count } = snapshot[s];
      const test = rowTester(plan, index);
      const rows = candidateRows(plan, index, count, s === start ? cursorKey : null);
      for (let i = 0; i < rows.length; i++) {
        if (++scanned % SCAN_YIELD_EVERY === 0) await immediate();
        const row = rows[i];
        if (!test(row)) continue;
        batch.push({ segment, index, row });
        if (!plan.residual) {
          if (results.length + batch.length >= target) { hasMore = true; batch.pop(); break scan; }
        } else if (batch.length >= Math.max(RESIDUAL_BATCH, target - results.length)) {
          const rowsToRead = batch; batch = [];
          await flush(rowsToRead);
          if (results.length >= target) break scan;
        }
      }
    }
    if (batch.length) await flush(batch);
    if (plan.residual && results.length >= target) hasMore = true;
    // Same-name bytes that disagree with their index are never transient: rebuild later, answer from disk now.
    if (stale && (mismatched.size || !allowRetry)) {
      this.health.failures++;
      this.health.lastFailure = 'ordinary-log-index-stale';
    }
    if (mismatched.size) {
      for (const segment of mismatched) if (state.segments.includes(segment)) this._dropIndex(segment);
      this._scheduleMaintenance();
      return this._legacyQueryPass(state.prefix, { limit, cursor, filters }, true);
    }
    if ((stale || structure !== this.structureGeneration) && allowRetry) return this._queryPass(state.prefix, { limit, cursor, filters }, false);
    const visible = results.slice(0, limit), last = visible.at(-1);
    return {
      items: visible.map((item) => item.value),
      nextCursor: hasMore && visible.length === limit && last ? Buffer.from(JSON.stringify({
        ts: last.value.ts,
        requestId: last.value.requestId || '',
        attemptIndex: last.value.attemptIndex ?? -1,
        segment: last.segment.name,
        line: last.row,
      })).toString('base64url') : null,
    };
  }

  async _queryPass(prefix, options, allowRetry) {
    const state = this._state(prefix);
    await this.queue;
    if (state.segments.some((segment) => segment.records && !segment.index)) return this._legacyQueryPass(prefix, options, allowRetry);
    return this._indexedQueryPass(state, options, allowRetry);
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
      await this._closeSegment(state, state.active, { persist: false });
      const known = new Set();
      for (const segment of state.segments) { known.add(segment.name); known.add(sidecarName(segment.name)); }
      const names = await this.io.readdir(this.dir);
      for (const name of names) {
        if (safeFile(prefix, name) || this._isTempSidecar(name, [prefix])) known.add(name);
        else if (name.endsWith(SIDECAR_SUFFIX) && safeFile(prefix, name.slice(0, -SIDECAR_SUFFIX.length))) known.add(name);
      }
      for (const name of known) await this._unlink(name);
      state.segments = [];
      state.live = [];
      state.active = null;
      state.sequence = 0;
      this.catalogGeneration++;
      this.structureGeneration++;
      this.health.indexDegraded = this._allSegments().some((segment) => segment.records && !segment.index);
    });
  }

  files(prefix) { return this._state(prefix).segments.map((segment) => segment.name).sort(); }

  close() {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    clearInterval(this.timer);
    this.closePromise = (async () => {
      await this.ready.catch(() => {});
      await this.queue;
      for (const state of this.states.values()) await this._closeSegment(state, state.active);
    })();
    return this.closePromise;
  }
}
