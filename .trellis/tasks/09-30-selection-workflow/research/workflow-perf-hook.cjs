const fs = require('node:fs');
const { monitorEventLoopDelay, performance } = require('node:perf_hooks');

const target = process.env.CLINE_PASS_TEST_PERF_PATH;
if (target) {
  const loop = monitorEventLoopDelay({ resolution: 10 });
  const baseline = performance.eventLoopUtilization();
  const writes = [];
  let bytes = 0;
  const originalWrite = fs.writeFileSync;
  fs.writeFileSync = function(file, data, ...args) {
    if (!String(file).includes('selection-counters.json.')) return originalWrite.call(this, file, data, ...args);
    const start = performance.now();
    try { return originalWrite.call(this, file, data, ...args); }
    finally { writes.push(performance.now() - start); bytes += Buffer.byteLength(data); }
  };
  loop.enable();
  process.on('SIGTERM', () => {
    const sorted = [...writes].sort((a, b) => a - b);
    const percentile = value => sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * value) - 1)] : null;
    const utilization = performance.eventLoopUtilization(baseline);
    originalWrite.call(fs, target, JSON.stringify({
      loop: { meanMs: loop.mean / 1e6, p99Ms: loop.percentile(99) / 1e6, maxMs: loop.max / 1e6,
        utilization: utilization.utilization },
      persistence: { writes: writes.length, bytes, meanWriteMs: writes.reduce((sum, ms) => sum + ms, 0) / (writes.length || 1),
        p50WriteMs: percentile(.5), p95WriteMs: percentile(.95) },
      rssBytes: process.memoryUsage().rss,
    }));
    loop.disable();
  });
}
