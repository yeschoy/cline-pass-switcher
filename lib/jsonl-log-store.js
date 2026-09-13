import fs from 'node:fs';
import path from 'node:path';

const DAY = 24 * 60 * 60 * 1000;
const DEFAULT_SEGMENT_BYTES = 5 * 1024 * 1024;

const safeFiles = (dir, prefix) => {
  try { return fs.readdirSync(dir).filter((name) => name.startsWith(`${prefix}-`) && name.endsWith('.jsonl')).sort(); }
  catch (error) { if (error?.code === 'ENOENT') return []; throw error; }
};

function readFileRecords(dir, files) {
  const records = [];
  for (const file of files) {
    const text = fs.readFileSync(path.join(dir, file), 'utf8');
    const lines = text.split('\n');
    if (text && !text.endsWith('\n')) lines.pop();
    for (let line = 0; line < lines.length; line++) {
      if (!lines[line]) continue;
      try {
        const value = JSON.parse(lines[line]);
        if (value && typeof value === 'object' && !Array.isArray(value)) records.push({ value, file, line });
      } catch { /* tolerate a damaged complete line and continue */ }
    }
  }
  return records;
}

function serialized(record) { return `${JSON.stringify(record)}\n`; }
function recordIdentity(prefix, record) {
  if (record?.requestId) return `${prefix}\0${record.requestId}\0${prefix === 'errors' ? record.attemptIndex ?? -1 : ''}`;
  return `${prefix}\0${serialized(record)}`;
}
function dedupeValues(prefix, values) {
  const unique = new Map();
  for (const value of values) unique.set(recordIdentity(prefix, value), value);
  return [...unique.values()];
}

function rewriteRecords(dir, prefix, values, segmentBytes = DEFAULT_SEGMENT_BYTES) {
  const oldFiles = safeFiles(dir, prefix);
  const nonce = `${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2)}`;
  const pending = [];
  let chunk = '';
  const flush = () => {
    if (!chunk) return;
    const index = pending.length;
    const finalName = `${prefix}-${nonce}-${String(index).padStart(4, '0')}.jsonl`;
    const tempName = `.${finalName}.tmp`;
    fs.writeFileSync(path.join(dir, tempName), chunk, { mode: 0o600 });
    pending.push({ tempName, finalName });
    chunk = '';
  };
  try {
    for (const value of values) {
      const line = serialized(value);
      if (chunk && Buffer.byteLength(chunk) + Buffer.byteLength(line) > segmentBytes) flush();
      chunk += line;
      if (Buffer.byteLength(chunk) >= segmentBytes) flush();
    }
    flush();
    for (const item of pending) fs.renameSync(path.join(dir, item.tempName), path.join(dir, item.finalName));
    const replacements = new Set(pending.map((item) => item.finalName));
    for (const file of oldFiles) if (!replacements.has(file)) fs.unlinkSync(path.join(dir, file));
  } catch (error) {
    for (const item of pending) {
      try { fs.unlinkSync(path.join(dir, item.tempName)); } catch (cleanupError) { if (cleanupError?.code !== 'ENOENT') console.error(`[日志] temporary cleanup failed: ${cleanupError.message}`); }
    }
    throw error;
  }
}

export function enforceCombinedLimit(dir, maxBytes, segmentBytes = DEFAULT_SEGMENT_BYTES) {
  let files;
  try { files = fs.readdirSync(dir).filter((name) => /^(requests|errors)-.*\.jsonl$/.test(name)).sort(); }
  catch (error) { if (error?.code === 'ENOENT') return; throw error; }
  const diskBytes = files.reduce((total, file) => total + fs.statSync(path.join(dir, file)).size, 0);
  if (diskBytes <= maxBytes) return;
  const unique = new Map();
  for (const entry of readFileRecords(dir, files)) {
    const type = entry.file.startsWith('errors-') ? 'errors' : 'requests';
    unique.set(recordIdentity(type, entry.value), { type, value: entry.value, bytes: Buffer.byteLength(serialized(entry.value)) });
  }
  let records = [...unique.values()];
  records.sort((a, b) => Number(a.value.ts) - Number(b.value.ts));
  let total = records.reduce((sum, entry) => sum + entry.bytes, 0);
  while (records.length && total > maxBytes) total -= records.shift().bytes;
  for (const prefix of ['requests', 'errors']) rewriteRecords(dir, prefix, records.filter((entry) => entry.type === prefix).map((entry) => entry.value), segmentBytes);
}

export class JsonlLogStore {
  constructor({ dir, prefix, maxRecords, maxAgeMs = 30 * DAY, segmentBytes = DEFAULT_SEGMENT_BYTES, totalBytes = 100 * 1024 * 1024 }) {
    this.dir = dir;
    this.prefix = prefix;
    this.maxRecords = maxRecords;
    this.maxAgeMs = maxAgeMs;
    this.segmentBytes = segmentBytes;
    this.totalBytes = totalBytes;
    this.queue = Promise.resolve();
    this.appends = 0;
    this.sequence = 0;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.compact();
  }
  files() { return safeFiles(this.dir, this.prefix); }
  readRecords() { return readFileRecords(this.dir, this.files()); }
  activeFile(bytes) {
    const last = this.files().at(-1);
    if (last) {
      const full = path.join(this.dir, last);
      if (fs.statSync(full).size + bytes <= this.segmentBytes) return full;
    }
    return path.join(this.dir, `${this.prefix}-${Date.now()}-${String(this.sequence++).padStart(4, '0')}.jsonl`);
  }
  append(record) {
    const projected = record && typeof record === 'object' && !Array.isArray(record) ? record : {};
    this.queue = this.queue.then(() => {
      const line = serialized(projected);
      fs.appendFileSync(this.activeFile(Buffer.byteLength(line)), line, { mode: 0o600 });
      this.appends++;
      if (this.appends % 100 === 0) this.compact();
    }).catch((error) => { console.error(`[日志] ${this.prefix} append failed: ${error.message}`); });
    return this.queue;
  }
  compact() {
    const cutoff = Date.now() - this.maxAgeMs;
    let records = dedupeValues(this.prefix, this.readRecords().map((entry) => entry.value)).filter((record) => Number(record.ts) >= cutoff);
    if (records.length > this.maxRecords) records = records.slice(-this.maxRecords);
    let bytes = records.reduce((sum, record) => sum + Buffer.byteLength(serialized(record)), 0);
    while (records.length && bytes > this.totalBytes) bytes -= Buffer.byteLength(serialized(records.shift()));
    if (!this.files().length && !records.length) return;
    rewriteRecords(this.dir, this.prefix, records, this.segmentBytes);
  }
  query({ limit = 50, cursor = '', filters = {} } = {}) {
    const count = Math.min(200, Math.max(1, Number(limit) || 50));
    let records = this.readRecords().sort((a, b) => Number(b.value.ts) - Number(a.value.ts)
      || String(b.value.requestId || '').localeCompare(String(a.value.requestId || ''))
      || b.file.localeCompare(a.file) || b.line - a.line);
    const match = ({ value: record }) => Object.entries(filters).every(([key, expected]) => {
      if (expected === undefined || expected === null || expected === '') return true;
      if (key === 'from') return Number(record.ts) >= Number(expected);
      if (key === 'to') return Number(record.ts) <= Number(expected);
      if (key === 'model') return [record.requestedModel, record.resolvedModel].some((value) => String(value || '').toLowerCase().includes(String(expected).toLowerCase()));
      if (key === 'account') return [record.accountId, record.accountName].some((value) => String(value || '').toLowerCase().includes(String(expected).toLowerCase()));
      if (key === 'provider') return [record.actualProvider, record.targetProvider, ...(record.targetProviders || []), ...(record.providerPath || [])].some((value) => String(value || '').toLowerCase().includes(String(expected).toLowerCase()));
      if (key === 'accountAction') return [record.accountAction, ...(record.accountActions || [])].some((value) => JSON.stringify(value).toLowerCase().includes(String(expected).toLowerCase()));
      if (key === 'status' || key === 'upstreamStatus') return Number(record[key]) === Number(expected);
      const actual = record[key];
      if (Array.isArray(actual)) return actual.some((value) => JSON.stringify(value).toLowerCase().includes(String(expected).toLowerCase()));
      if (typeof expected === 'boolean') return actual === expected;
      return String(actual ?? '').toLowerCase().includes(String(expected).toLowerCase());
    });
    records = records.filter(match);
    let offset = 0;
    if (cursor) {
      try {
        const key = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
        let found = records.findIndex((entry) => entry.file === key.segment && entry.line === key.line);
        if (found < 0) found = records.findIndex((entry) => Number(entry.value.ts) === Number(key.ts)
          && String(entry.value.requestId || '') === String(key.requestId || '')
          && Number(entry.value.attemptIndex ?? -1) === Number(key.attemptIndex ?? -1));
        offset = found >= 0 ? found + 1 : 0;
      } catch { offset = 0; }
    }
    const page = records.slice(offset, offset + count);
    const last = page.at(-1);
    const nextCursor = offset + count < records.length && last ? Buffer.from(JSON.stringify({
      ts: last.value.ts,
      requestId: last.value.requestId || '',
      attemptIndex: last.value.attemptIndex ?? -1,
      segment: last.file,
      line: last.line,
    })).toString('base64url') : null;
    return { items: page.map((entry) => entry.value), nextCursor };
  }
  clear() {
    this.queue = this.queue.then(() => { for (const file of this.files()) fs.unlinkSync(path.join(this.dir, file)); });
    return this.queue;
  }
}
