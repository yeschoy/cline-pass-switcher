// Synthetic container-only telemetry preload. Never load into production service.
const fs = require('node:fs');
const { monitorEventLoopDelay } = require('node:perf_hooks');
const histogram = monitorEventLoopDelay({ resolution: 20 });
histogram.enable();
let maxRssBytes = 0, maxHeapUsedBytes = 0, maxExternalBytes = 0;
const sample = () => {
  const memory = process.memoryUsage();
  maxRssBytes = Math.max(maxRssBytes, memory.rss);
  maxHeapUsedBytes = Math.max(maxHeapUsedBytes, memory.heapUsed);
  maxExternalBytes = Math.max(maxExternalBytes, memory.external);
  const report = {
    maxRssBytes, maxHeapUsedBytes, maxExternalBytes,
    eventLoopP99Ms: Number((histogram.percentile(99) / 1e6).toFixed(2)),
    eventLoopMaxMs: Number((histogram.max / 1e6).toFixed(2))
  };
  try { fs.writeFileSync('/data/isolated-observer.json', JSON.stringify(report), { mode: 0o600 }); } catch {}
};
setInterval(sample, 250).unref();
