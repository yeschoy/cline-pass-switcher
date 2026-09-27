// Disposable, local-only differential probe. Never opens repository operator state.
// Run with environment overrides unset; --ref must be an explicit hexadecimal commit.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Resolve through Git so replay still works after Trellis moves this task to archive/.
const root = execFileSync('git', ['-C', path.dirname(fileURLToPath(import.meta.url)), 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const { prepareAdminFixture, connectAdminFixture, fixtureHeaders } = await import(pathToFileURL(path.join(root, 'test/admin-fixture.js')).href);
const args = Object.fromEntries(process.argv.slice(2).map((arg) => { const match = /^--(ref|cases|repeats)=(.+)$/.exec(arg); if (!match) throw Error('expected --ref=<commit> [--cases=names] [--repeats=1..5]'); return [match[1], match[2]]; }));
if (!/^[a-f0-9]{7,40}$/.test(args.ref || '')) throw Error('an explicit hexadecimal commit is required');
const ref = execFileSync('git', ['rev-parse', '--verify', `${args.ref}^{commit}`], { cwd: root, encoding: 'utf8' }).trim();
// Only the two reviewed commits may run in this local-only probe. Review any new
// source/network paths separately before adding another revision.
const reviewedRefs = new Set(['7eeb3b220e1c2071056d5c763f5d12af0b946a2e', '378ff1f03112fc71d029508d1922ab230dfe8635']);
if (!reviewedRefs.has(ref)) throw Error('unreviewed benchmark revision');
const committed = (file) => execFileSync('git', ['show', `${ref}:${file}`], { cwd: root, maxBuffer: 10 * 1024 * 1024 });
// The fixture and installed dependency contract are shared with this checkout;
// reject drift instead of silently constructing a mixed-revision benchmark.
for (const file of ['test/admin-fixture.js', 'package.json', 'package-lock.json']) {
  if (!fs.readFileSync(path.join(root, file)).equals(committed(file))) throw Error(`local ${file} differs from the benchmark revision`);
}
const assetNames = execFileSync('git', ['ls-tree', '-r', '--name-only', ref, '--', 'lib', 'public'], { cwd: root, encoding: 'utf8' }).trim().split('\n').filter(Boolean);
if (!assetNames.includes('public/index.html') || !assetNames.some((name) => name.startsWith('lib/')) ||
    assetNames.some((name) => !/^(?:lib\/[A-Za-z0-9._-]+\.js|public\/index\.html)$/.test(name))) throw Error('unreviewed program asset');
const assets = assetNames.map((file) => [file, committed(file)]);
const repeats = args.repeats === undefined ? 2 : Number(args.repeats);
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 5) throw Error('repeats must be 1..5');
const scenarios = {
  rr1: { accounts: 1, mode: 'roundrobin' }, rr2: { accounts: 2, mode: 'roundrobin' }, rr10: { accounts: 10, mode: 'roundrobin' },
  health10rr: { accounts: 10, mode: 'roundrobin', seedHealth: true },
  health10load: { accounts: 10, mode: 'load-health', seedHealth: true },
  denseHealthRR: { accounts: 10, mode: 'roundrobin', seedHealth: true, denseHistory: true, n: 48 },
  denseHealthLoad: { accounts: 10, mode: 'load-health', seedHealth: true, denseHistory: true, n: 48 },
  load10: { accounts: 10, mode: 'load-health' },
  sticky10: { accounts: 10, mode: 'sticky', sticky: true },
  full0: { accounts: 2, mode: 'roundrobin', capacity: 1, delay: 40, wait: 0, n: 24, concurrency: 12 },
  full80: { accounts: 2, mode: 'roundrobin', capacity: 1, delay: 40, wait: 80, n: 24, concurrency: 12 },
  pool80: { accounts: 2, mode: 'roundrobin', capacity: 1, delay: 40, wait: 0, poolWait: 80, n: 24, concurrency: 12 },
  slow10: { accounts: 10, mode: 'roundrobin', capacity: 1, delay: 40, wait: 80, n: 48, concurrency: 12 },
  upstream429: { accounts: 2, mode: 'roundrobin', fail: true, n: 48, concurrency: 8 },
  rpm429: { accounts: 1, mode: 'roundrobin', rpm: 4, n: 24, concurrency: 12 },
  sse10: { accounts: 10, mode: 'roundrobin', sse: true, delay: 40, n: 48, concurrency: 8 },
  ssePaused: { accounts: 2, mode: 'roundrobin', sse: true, pauseClient: 120, mockChunks: 256, n: 12, concurrency: 4 },
  offSmall: { accounts: 2, mode: 'roundrobin', n: 48, concurrency: 4 },
  errorSuccess: { accounts: 2, mode: 'roundrobin', diag: 'error', n: 48, concurrency: 4 },
  errorFailOff: { accounts: 2, mode: 'roundrobin', fail: true, n: 48, concurrency: 4 },
  errorFail: { accounts: 2, mode: 'roundrobin', fail: true, diag: 'error', n: 48, concurrency: 4 },
  fullSmall: { accounts: 2, mode: 'roundrobin', diag: 'full', n: 48, concurrency: 4 },
  rawSmall: { accounts: 2, mode: 'roundrobin', diag: 'raw-full', n: 48, concurrency: 4 },
  offLarge: { accounts: 2, mode: 'roundrobin', bytes: 1024 * 1024, n: 12, concurrency: 2 },
  fullLarge: { accounts: 2, mode: 'roundrobin', diag: 'full', bytes: 1024 * 1024, n: 12, concurrency: 2 },
  rawLarge: { accounts: 2, mode: 'roundrobin', diag: 'raw-full', bytes: 1024 * 1024, n: 12, concurrency: 2 },
  off6m: { accounts: 2, mode: 'roundrobin', bytes: 6 * 1024 * 1024, n: 6, concurrency: 2 },
  full6m: { accounts: 2, mode: 'roundrobin', diag: 'full', bytes: 6 * 1024 * 1024, n: 6, concurrency: 2 },
  raw6m: { accounts: 2, mode: 'roundrobin', diag: 'raw-full', bytes: 6 * 1024 * 1024, n: 6, concurrency: 2 },
};
const names = args.cases ? args.cases.split(',') : ['rr1', 'rr2', 'rr10', 'load10', 'sticky10', 'health10rr', 'health10load', 'denseHealthRR', 'denseHealthLoad', 'full0', 'full80', 'pool80', 'slow10', 'upstream429', 'rpm429', 'sse10', 'ssePaused', 'offSmall', 'errorSuccess', 'errorFailOff', 'errorFail', 'fullSmall', 'rawSmall', 'offLarge', 'fullLarge', 'rawLarge', 'off6m', 'full6m', 'raw6m'];
if (!names.length || names.some((name) => !Object.hasOwn(scenarios, name))) throw Error('unknown case name');
// The test-only readiness override must not bypass the machine/container's
// actual memory floor when replaying raw workloads on a smaller host.
function rawMemoryReady() {
  const floor = 2n * 1024n * 1024n * 1024n;
  if (BigInt(os.totalmem()) < floor) return false;
  if (process.platform !== 'linux') return true;
  for (const file of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
    let value;
    try { value = fs.readFileSync(file, 'utf8').trim(); }
    catch (error) { if (error.code === 'ENOENT') continue; return false; }
    return value === 'max' || /^\d+$/.test(value) && BigInt(value) >= floor;
  }
  return false;
}
if (names.some((name) => scenarios[name].diag === 'raw-full') && !rawMemoryReady()) throw Error('raw benchmark needs at least 2 GiB of actual host/cgroup memory');
const source = committed('server.js').toString('utf8');
if (source.includes('load-health') === false && names.some((name) => scenarios[name].mode === 'load-health' || scenarios[name].poolWait !== undefined)) throw Error('this revision predates the requested mode or wait option');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const round = (n) => +n.toFixed(2);
const quantiles = (samples) => {
  const values = [...samples].sort((a, b) => a - b);
  return { n: values.length, p50: round(values[Math.ceil(values.length * .5) - 1]), p95: round(values[Math.ceil(values.length * .95) - 1]), p99: round(values[Math.ceil(values.length * .99) - 1]), max: round(values.at(-1)) };
};
const prelude = `import { monitorEventLoopDelay as __monitor, performance as __perf } from 'node:perf_hooks';
const __loop = __monitor({ resolution: 5 }); __loop.enable();
let __startCpu = process.cpuUsage(), __startElu = __perf.eventLoopUtilization(), __peakRss = 0, __peakHeap = 0;
let __sections = {};
const __sample = () => { const m = process.memoryUsage(); __peakRss = Math.max(__peakRss, m.rss); __peakHeap = Math.max(__peakHeap, m.heapUsed); };
const __timer = setInterval(__sample, 10); __timer.unref();
function __measure(name, fn) {
  const begin = __perf.now();
  const done = () => { const ms = __perf.now() - begin; const row = __sections[name] ||= { n: 0, totalMs: 0, maxMs: 0 }; row.n++; row.totalMs += ms; row.maxMs = Math.max(row.maxMs, ms); };
  try { const result = fn(); if (result && typeof result.then === 'function') return result.finally(done); done(); return result; } catch (error) { done(); throw error; }
}
function __metrics(reset = false) {
  __sample(); const c = process.cpuUsage(__startCpu), m = process.memoryUsage();
  const out = { cpuMs: +( (c.user+c.system)/1000 ).toFixed(2), loopP99Ms: +(__loop.percentile(99)/1e6).toFixed(2), loopMaxMs: +(__loop.max/1e6).toFixed(2), elu: +__perf.eventLoopUtilization(__startElu).utilization.toFixed(3), rssPeakMiB: +(__peakRss/1048576).toFixed(1), heapPeakMiB: +(__peakHeap/1048576).toFixed(1), rssEndMiB: +(m.rss/1048576).toFixed(1), sections: Object.fromEntries(Object.entries(__sections).map(([k,v])=>[k,{n:v.n,totalMs:+v.totalMs.toFixed(2),maxMs:+v.maxMs.toFixed(2)}])) };
  if (reset) { __startCpu = process.cpuUsage(); __startElu = __perf.eventLoopUtilization(); __loop.reset(); __sections = {}; __peakRss = 0; __peakHeap = 0; }
  return out;
}
`;
function instrument(text) {
  const names = ['readBody', 'sensitiveMessageValues', 'enabledAccounts', 'pipelineCandidates', 'buildPipelineGroups', 'strategyRank', 'successHealthProjection', 'acquireAccountLease', 'runChatChain', 'clineRequest', 'readFirstSseEvent', 'injectPrefs', 'commitStatistics', 'record'];
  for (const name of names) {
    const match = new RegExp(`(?<![A-Za-z])(?:(async) )?function ${name}\\(`, 'g');
    const hits = [...text.matchAll(match)]; if (hits.length !== 1) throw Error(`missing or ambiguous source seam: ${name}`);
    text = text.replace(match, (_, async) => `${async ? 'async ' : ''}function __original_${name}(`);
    text += `\nfunction ${name}(...args) { return __measure('${name}', () => __original_${name}(...args)); }\n`;
  }
  const old = 'fs.writeFileSync(tmp, JSON.stringify(obj, null, pretty ? 2 : undefined), { mode });\n    fs.renameSync(tmp, file);';
  if (text.split(old).length !== 2) throw Error('atomic write seam changed');
  text = text.replace(old, `const __bytes = __measure('json.stringify', () => JSON.stringify(obj, null, pretty ? 2 : undefined));\n    __measure('json.writeSync', () => fs.writeFileSync(tmp, __bytes, { mode }));\n    __measure('json.renameSync', () => fs.renameSync(tmp, file));`);
  const ordinary = 'const writes = [requestLogs.append(request)];';
  if (text.split(ordinary).length !== 2) throw Error('ordinary append seam changed');
  text = text.replace(ordinary, `const writes = [__measure('requestAppendAsync', () => requestLogs.append(request))];`);
  const local = "const p = url.pathname;";
  if (text.split(local).length !== 2) throw Error('dispatch seam changed');
  text = text.replace(local, `${local}\n  if (req.method === 'GET' && p === '/__benchmetrics' && req.socket.remoteAddress === '127.0.0.1' && req.headers['x-bench-token'] === process.env.CPS_BENCH_TOKEN) return sendJSON(res, 200, __metrics(url.searchParams.has('reset')));`);
  return prelude + text;
}
const programText = instrument(source);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cps-request-path-'));
let child;
const servers = new Set();
process.once('exit', () => { if (child) child.kill('SIGKILL'); try { fs.rmSync(temp, { recursive: true, force: true }); } catch {} });
async function listen(server) { return new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); servers.add(server); resolve(server.address().port); }); }); }
async function stop() {
  if (!child) return;
  const running = child;
  if (running.exitCode === null && running.signalCode === null) {
    const exited = new Promise((resolve) => running.once('exit', resolve));
    running.kill('SIGTERM');
    const timer = setTimeout(() => { if (running.exitCode === null && running.signalCode === null) running.kill('SIGKILL'); }, 4000);
    try { await exited; } finally { clearTimeout(timer); }
  }
  if (child === running) child = null;
}
async function freePort() { const s = http.createServer(), port = await listen(s); await new Promise((resolve) => s.close(resolve)); servers.delete(s); return port; }
async function start(program, dir, port, token, raw) {
  let output = '';
  child = spawn(process.execPath, [path.join(program, 'server.js')], { cwd: program, env: {
    PATH: process.env.PATH || '', HOME: temp, DATA_DIR: dir, PORT: String(port), BIND_HOST: '127.0.0.1',
    NODE_ENV: 'test', CPS_BENCH_TOKEN: token,
    ...(raw ? { CLINE_PASS_RAW_BODY_READY: '1', CLINE_PASS_TEST_RAW_MEMORY_BYTES: '2147483648' } : {}),
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => { output = (output + chunk.toString()).slice(-1024); });
  const begin = performance.now();
  while (!output.includes('OpenAI 兼容代理地址') && child.exitCode === null && performance.now() - begin < 15000) await pause(10);
  if (!output.includes('OpenAI 兼容代理地址')) throw Error('disposable server startup failed (no output retained)');
  await connectAdminFixture(port);
}
async function api(port, route, options = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, { signal: AbortSignal.timeout(15000), ...options, headers: fixtureHeaders(port, route, options.method || 'GET', options.headers || {}) });
  return { status: response.status, data: await response.json() };
}
async function oneCase(name, run) {
  const c = scenarios[name], dir = path.join(temp, `${name}-${run}`), program = path.join(dir, 'program'), state = path.join(dir, 'state');
  fs.mkdirSync(program, { recursive: true }); fs.mkdirSync(state);
  for (const [file, bytes] of assets) {
    const dest = path.join(program, file);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, bytes);
  }
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(program, 'node_modules'), 'dir');
  fs.writeFileSync(path.join(program, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(program, 'server.js'), programText);
  const hits = { count: 0, byAccount: {}, unexpected: 0, backpressure: 0, drains: 0 };
  const mock = http.createServer((req, res) => {
    const owner = /^Bearer synthetic-account-(\d+)$/.exec(req.headers.authorization || '');
    req.resume(); req.on('end', () => {
      if (req.url !== '/api/v1/chat/completions' || !owner || Number(owner[1]) >= c.accounts) { hits.unexpected++; res.writeHead(400); res.end('{}'); return; }
      const id = `a${owner[1]}`; hits.count++; hits.byAccount[id] = (hits.byAccount[id] || 0) + 1;
      setTimeout(() => {
        if (c.fail) { res.writeHead(429, { 'Content-Type': 'application/json' }); res.end('{"error":{"message":"synthetic provider limited","provider":"mock"}}'); return; }
        if (c.sse) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.write('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n');
          if (c.mockChunks) {
            const chunk = `data: {"choices":[{"delta":{"content":"${'x'.repeat(16384)}"}}]}\n\n`;
            let sent = 0;
            const pump = () => { if (res.destroyed) return;
              if (sent++ >= c.mockChunks) { res.end('data: [DONE]\n\n'); return; }
              if (!res.write(chunk)) { hits.backpressure++; res.once('drain', () => { hits.drains++; pump(); }); }
              else setImmediate(pump);
            };
            setImmediate(pump);
          } else setTimeout(() => res.end('data: [DONE]\n\n'), c.delay || 0);
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"choices":[{"message":{"content":"ok"}}],"usage":{"prompt_tokens":1,"completion_tokens":0,"total_tokens":1}}');
      }, c.sse ? 0 : c.delay || 0);
    });
  });
  const mockPort = await listen(mock), port = await freePort(), token = randomUUID();
  const config = { port, proxyKey: 'synthetic-client-key', upstreamBase: `http://127.0.0.1:${mockPort}/api/v1`, knownModels: ['synthetic-model'], perModel: { 'synthetic-model': { upstreams: ['mock'], maxRetries: 0 } },
    accounts: Array.from({ length: c.accounts }, (_, i) => ({ id: `a${i}`, name: `A${i}`, key: `synthetic-account-${i}`, enabled: true, maxConcurrent: c.capacity || 0, maxRpm: c.rpm || 0, perModel: {} })),
    accountMode: c.seedHealth ? 'single' : c.mode, concurrencyWaitMs: c.wait || 0,
    ...(c.poolWait !== undefined ? { poolFullWaitMs: c.poolWait } : {}),
    accountPipeline: { quotaPool: false, healthSort: false, sticky: false },
    detailedLogging: c.diag === 'full' || c.diag === 'raw-full', errorDetailLogging: c.diag === 'error', rawBodyLogging: c.diag === 'raw-full' };
  fs.writeFileSync(path.join(state, 'config.json'), JSON.stringify(config), { mode: 0o600 }); prepareAdminFixture(state);
  const payload = JSON.stringify({ model: 'synthetic-model', stream: !!c.sse, messages: [{ role: 'user', content: 'x'.repeat(c.bytes || 256) }] });
  const chat = async (i) => {
    const began = performance.now();
    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', signal: AbortSignal.timeout(15000),
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer synthetic-client-key', ...(c.sticky ? { 'Session-Id': `fixture-session-${i % 12}` } : {}) }, body: payload });
    if (c.pauseClient) {
      const reader = response.body.getReader(); await reader.read(); await pause(c.pauseClient);
      while (!(await reader.read()).done) {};
    } else await response.arrayBuffer();
    return { ms: performance.now() - began, status: response.status, attempts: Number(response.headers.get('x-cline-attempts') || 0), account: response.headers.get('x-cline-account') };
  };
  try {
    if (c.seedHealth) {
      await start(program, state, port, token, false);
      if ((await chat(0)).status !== 200) throw Error('synthetic health seed failed');
      await stop();
      const metaPath = path.join(state, 'metadata.json'), meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      const bucket = meta.statistics.minuteBuckets.at(-1), cell = bucket.accountHealth.a0;
      bucket.accountHealth.a0 = { ...cell, successes: 9, degrades: 1 };
      bucket.accountHealth.a1 = { ...cell, successes: 2, degrades: 8 };
      if (c.denseHistory) {
        const lastMinute = bucket.minute;
        meta.statistics.minuteBuckets = Array.from({ length: 1200 }, (_, i) => ({ ...bucket, minute: lastMinute - 1199 + i }));
      }
      fs.writeFileSync(metaPath, JSON.stringify(meta), { mode: 0o600 });
      config.accountMode = c.mode; fs.writeFileSync(path.join(state, 'config.json'), JSON.stringify(config), { mode: 0o600 });
    }
    await start(program, state, port, token, c.diag === 'raw-full');
    const metric = (reset = false) => fetch(`http://127.0.0.1:${port}/__benchmetrics${reset ? '?reset=1' : ''}`, { headers: { 'x-bench-token': token }, signal: AbortSignal.timeout(15000) }).then((res) => { if (!res.ok) throw Error('local metric endpoint rejected'); return res.json(); });
    const settings = (await api(port, '/api/logs/settings')).data;
    if (settings.rawBodyLogging !== (c.diag === 'raw-full') || (c.diag === 'raw-full' && !settings.rawBodyAvailable)) throw Error('unexpected diagnostic readiness');
    // Warm-up is separate. Never pre-consume finite RPM or warm up a failing Provider into another state.
    const warmN = c.rpm || c.fail || c.capacity ? 0 : c.bytes && c.bytes >= 6 * 1024 * 1024 ? 2 : 12;
    const warm = [], warmStart = performance.now();
    for (let i = 0; i < warmN; i++) warm.push(await chat(i));
    const warmMs = performance.now() - warmStart;
    if (warm.some((row) => row.status !== 200)) throw Error('warmup did not succeed');
    let initialDetailCount = 0;
    const initialDetailIds = new Set();
    if (c.diag === 'full' || c.diag === 'raw-full') {
      // Separate warmup manifests from the measured publication window.
      const until = performance.now() + 3000;
      while (true) { const list = await api(port, '/api/logs/details?limit=200');
        if (list.status !== 200) throw Error('warmup detail list unavailable');
        initialDetailCount = list.data.items.length;
        if (initialDetailCount >= warmN || performance.now() >= until) { for (const item of list.data.items) initialDetailIds.add(item.requestId); break; }
        await pause(20);
      }
    }
    const initialHealth = (await api(port, '/api/logs/settings')).data.health;
    const before = hits.count, beforeAccounts = { ...hits.byAccount }, beforeBackpressure = hits.backpressure, beforeDrains = hits.drains;
    await metric(true);
    const rows = [], began = performance.now();
    for (let offset = 0; offset < (c.n || 96); offset += c.concurrency || 12) {
      rows.push(...await Promise.all(Array.from({ length: Math.min(c.concurrency || 12, (c.n || 96) - offset) }, (_, j) => chat(offset + j))));
    }
    const wallMs = performance.now() - began;
    const responseMetrics = await metric(); // CPU/loop work until responses finish; detail publication may continue.
    // Diagnostic publication is asynchronous; poll only metadata summaries, never retrieve bodies.
    let detailCount = 0, detailStates = {}, detailBytesMax = 0;
    if (c.diag === 'full' || c.diag === 'raw-full' || (c.diag === 'error' && c.fail)) {
      // Near-limit sanitization can omit whole roots safely; never force admission to match the request count.
      await pause(c.bytes && c.bytes >= 6 * 1024 * 1024 ? 1000 : 80);
      const until = performance.now() + (c.bytes && c.bytes >= 6 * 1024 * 1024 ? 0 : 3000);
      let list;
      do { list = await api(port, '/api/logs/details?limit=200'); if (list.status !== 200) throw Error('detail list unavailable');
        detailCount = list.data.items.length - initialDetailCount;
        if (detailCount >= (c.n || 96) || performance.now() >= until) break; await pause(20);
      } while (true);
      if (detailCount < 0 || detailCount > (c.n || 96)) throw Error('unexpected detail root count');
      // Only large cases inspect descriptors; no stored body bytes are read.
      if (c.bytes && c.bytes >= 6 * 1024 * 1024) for (const item of list.data.items) {
        if (initialDetailIds.has(item.requestId)) continue;
        const detail = await api(port, `/api/logs/details/${item.requestId}`);
        for (const descriptor of detail.data.bodies) { detailStates[descriptor.state] = (detailStates[descriptor.state] || 0) + 1; detailBytesMax = Math.max(detailBytesMax, descriptor.capturedBytes || 0); }
      }
    } else await pause(80);
    const metrics = await metric();
    const health = (await api(port, '/api/logs/settings')).data.health;
    const reasons = Object.fromEntries(Object.entries(health.dropReasons || {}).map(([key, value]) => [key, value - (initialHealth.dropReasons?.[key] || 0)]).filter(([, value]) => value));
    const dropped = health.dropped - initialHealth.dropped;
    const distribution = {};
    for (const row of rows) { if (![200, 429].includes(row.status)) throw Error(`unexpected chat status ${row.status}`); if (row.account && !/^A\d+$/.test(row.account)) throw Error('unexpected account projection'); if (row.account) distribution[row.account] = (distribution[row.account] || 0) + 1; }
    const attempts = rows.reduce((n, row) => n + row.attempts, 0), actualCalls = hits.count - before;
    if (hits.unexpected || attempts !== actualCalls || rows.some((row) => row.attempts > 1 || row.status === 200 && row.attempts !== 1)) throw Error('unexpected upstream request or attempt count');
    const mockDistribution = Object.fromEntries(Object.entries(hits.byAccount).map(([id, count]) => [`A${id.slice(1)}`, count - (beforeAccounts[id] || 0)]).filter(([, count]) => count));
    if (JSON.stringify(Object.entries(distribution).sort()) !== JSON.stringify(Object.entries(mockDistribution).sort())) throw Error('response-account distribution differs from mock attempts');
    const upstream429 = rows.filter((row) => row.status === 429 && row.attempts === 1).length;
    const local429 = rows.filter((row) => row.status === 429 && row.attempts === 0).length;
    if (c.fail ? upstream429 !== actualCalls || local429 !== 0 : upstream429 !== 0 || c.rpm && local429 === 0 || c.capacity && c.wait === 0 && c.poolWait === undefined && !local429) throw Error('429 source assumption changed');
    if (Object.values(reasons).reduce((n, v) => n + v, 0) !== dropped) throw Error('detail drop accounting mismatch');
    return { case: name, run, inputBytes: Buffer.byteLength(payload), warmup: { n: warm.length, successes: warm.filter((row) => row.status === 200).length, wallMs: round(warmMs), ...(warm.length ? { latencyMs: quantiles(warm.map((row) => row.ms)) } : {}) }, n: rows.length, concurrency: c.concurrency || 12, accounts: c.accounts, maxConcurrent: c.capacity || 0, waitMs: c.wait || 0, poolWaitMs: c.poolWait ?? null, upstreamDelayMs: c.delay || 0, clientPauseMs: c.pauseClient || 0, mockBackpressure: { writes: hits.backpressure - beforeBackpressure, drains: hits.drains - beforeDrains }, mode: c.mode, historyMinutes: c.denseHistory ? 1200 : null, profile: c.diag || 'off', wallMs: round(wallMs), throughputRps: round(rows.length * 1000 / wallMs), latencyMs: quantiles(rows.map((row) => row.ms)), status: { success: rows.filter((row) => row.status === 200).length, local429, upstream429 }, attempts, mockCalls: actualCalls, distribution, drops: { dropped, reasons, captureDropped: health.captureDropped - initialHealth.captureDropped, retainedBytes: health.retainedPayloadBytes }, details: { roots: detailCount, states: detailStates, maxCapturedBytes: detailBytesMax }, responseMetrics: { cpuMs: responseMetrics.cpuMs, loopMaxMs: responseMetrics.loopMaxMs, rssPeakMiB: responseMetrics.rssPeakMiB }, metrics };
  } finally { await stop(); mock.closeAllConnections?.(); await new Promise((resolve) => mock.close(resolve)); servers.delete(mock); }
}
try {
  console.log(JSON.stringify({ kind: 'synthetic-request-path', ref, node: process.version, platform: `${process.platform}/${process.arch}`, repeats, cases: names }));
  for (const name of names) for (let i = 1; i <= repeats; i++) console.log(JSON.stringify(await oneCase(name, i)));
} finally {
  await stop();
  for (const server of servers) { server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve)); }
  fs.rmSync(temp, { recursive: true, force: true });
}
