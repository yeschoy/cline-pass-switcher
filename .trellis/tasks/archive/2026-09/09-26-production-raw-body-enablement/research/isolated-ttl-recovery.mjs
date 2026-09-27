// Run only in an empty, synthetic-only DATA_DIR inside the committed candidate image.
// Exercises actual 48h raw store startup/restart recovery without waiting 48h.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DetailedLogStore, RAW_MAX_AGE_MS } from '/app/lib/detailed-log-store.js';

const data = '/data';
const entries = await fs.readdir(data);
if (entries.length !== 1 || entries[0] !== '.isolated-synthetic-only' ||
    await fs.readFile(path.join(data, entries[0]), 'utf8') !== 'cps-raw-ttl-synthetic-fixture-v1\n')
  throw Error('TTL fixture must be a marked, otherwise empty synthetic DATA_DIR');
const dir = path.join(data, 'detailed-logs');
const raw = path.join(dir, 'raw');
await fs.mkdir(raw, { recursive: true, mode: 0o700 });
const now = Date.now();
const oldId = randomUUID(), freshId = randomUUID();
const oldName = `${now - RAW_MAX_AGE_MS - 60_000}-${oldId}`;
const freshName = `${now}-${freshId}`;
const old = path.join(raw, oldName), fresh = path.join(raw, freshName);
await fs.mkdir(old, { mode: 0o700 });
await fs.writeFile(path.join(old, 'manifest.json'), '{invalid-synthetic-json', { mode: 0o600 });
await fs.mkdir(fresh, { mode: 0o700 });
await fs.writeFile(path.join(fresh, 'manifest.json'), JSON.stringify({
  request: { requestId: freshId, ts: now, method: 'POST', pathname: '/v1/chat/completions',
    profile: 'raw-full', model: '', accounts: [], status: 200, result: 'success',
    complete: true, state: 'complete', attemptCount: 0 }, attempts: [], bodies: [],
}), { mode: 0o600 });
const suspiciousId = randomUUID();
const suspicious = path.join(raw, `${now}-${suspiciousId}`);
await fs.symlink('/tmp/synthetic-nonexistent', suspicious);

async function verifyStartup() {
  const store = new DetailedLogStore({ dir });
  await store.queue;
  const expiredRemoved = await fs.stat(old).then(() => false, error => error.code === 'ENOENT');
  const suspiciousPreserved = await fs.lstat(suspicious).then(info => info.isSymbolicLink());
  const current = await store.detail(freshId);
  const oldDenied = await store.detail(oldId).then(() => false, error => error.statusCode === 404);
  const suspiciousDenied = await store.detail(suspiciousId).then(() => false, error => error.statusCode === 404);
  const result = { expiredRemoved, suspiciousPreserved, suspiciousDenied, currentRawProfile: current.request.profile === 'raw-full', oldDenied,
    rawWarnings: store.health.rawWarnings, failures: store.health.failures };
  await store.close();
  if (!result.expiredRemoved || !result.suspiciousPreserved || !result.suspiciousDenied || !result.currentRawProfile || !result.oldDenied || result.rawWarnings < 1 || result.failures !== 0) throw Error('raw 48h recovery gate failed');
  return result;
}
const startup = await verifyStartup();
const restart = await verifyStartup();
console.log(JSON.stringify({ kind: 'isolated-raw-ttl', startup, restart, syntheticOnly: true }));
