import { performance } from 'node:perf_hooks';
import crypto from 'node:crypto';
import { rankWorkflowCandidates } from '../../../../lib/account-workflow.js';

const rows = Array.from({ length: 43 }, (_, index) => ({ id: `a${String(index).padStart(2, '0')}`, healthRate: null }));
const counts = Object.fromEntries(rows.map((row, index) => [row.id, { count: index % 7, lastSelected: index }]));
const activeCounts = new Map(rows.map((row, index) => [row.id, index % 6]));
const config = { accounts: rows.map(row => ({ id: row.id, name: row.id, key: 'synthetic', perModel: {} })), accountWorkflow: { healthFilter: true, minimumHealth: .2 } };
const snapshot = { version: 1, sequence: 300, accounts: counts };
const buckets = Array.from({ length: 1162 }, () => ({ accountHealth: counts }));

function meanMicroseconds(iterations, fn) {
  for (let i = 0; i < 1000; i++) fn(i);
  const start = performance.now();
  for (let i = 0; i < iterations; i++) fn(i);
  return (performance.now() - start) * 1000 / iterations;
}

const result = {
  node: process.version, arch: process.arch, accountCount: rows.length, accountMinuteCells: buckets.length * rows.length,
  meanMicroseconds: {
    rank43: meanMicroseconds(20000, index => rankWorkflowCandidates(rows, { selector: 'least-selections', counts, activeCounts, cursor: index })),
    revisionHash: meanMicroseconds(20000, () => crypto.createHash('sha256').update(JSON.stringify(config)).digest('hex')),
    counterSerialize: meanMicroseconds(20000, () => JSON.stringify(snapshot)),
    uncachedHealthScanSurrogate: meanMicroseconds(200, () => {
      let hits = 0;
      for (const row of rows) for (const bucket of buckets) if (bucket.accountHealth[row.id]) hits++;
      return hits;
    }),
  },
};
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
