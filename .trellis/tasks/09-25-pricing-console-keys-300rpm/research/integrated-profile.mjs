// Integrated-tree rerun of the archived synthetic local-only source-section profiler.
// Never reads the default DATA_DIR. Compare cc17ac7 (pricing+UI, before multi-key)
// to integrated HEAD under the same isolated one-owner synthetic workload; optional
// --extended adds bounded retry/diagnostics/10-account paths, not production throughput.
// Run: env -u CLINE_PASS_KEY -u PROXY_KEY -u PUBLIC_BASE_URL -u PORT node .trellis/tasks/09-25-pricing-console-keys-300rpm/research/integrated-profile.mjs [--ref=cc17ac7] [--extended]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';

let root = path.dirname(fileURLToPath(import.meta.url));
while (!fs.existsSync(path.join(root, 'server.js')) || !fs.existsSync(path.join(root, '.trellis'))) {
  const parent = path.dirname(root);
  if (parent === root) throw Error('repository root not found for isolated profiler');
  root = parent;
}
const { prepareAdminFixture, connectAdminFixture, fixtureHeaders } = await import(pathToFileURL(path.join(root, 'test/admin-fixture.js')).href);
const ref = process.argv.find(arg=>arg.startsWith('--ref='))?.slice(6);
if (ref && !/^[a-f0-9]{7,40}$/.test(ref)) throw Error('expected an explicit hexadecimal commit');
const source = ref ? execFileSync('git',['show',`${ref}:server.js`],{cwd:root,encoding:'utf8'}) : fs.readFileSync(path.join(root, 'server.js'), 'utf8');
let instrumented = source;
const sections = ['pruneStatistics', 'commitStatistics', 'aggregateRange', 'aggregateModelRange', 'statisticsModelIds', 'modelProviderProjection', 'providerUsageProjection', 'successHealthProjection', 'record', 'sendJSON', 'injectPrefs'];
const prelude = `import { performance as perf, monitorEventLoopDelay } from 'node:perf_hooks';
const perfMetrics = {}; const loop = monitorEventLoopDelay({ resolution: 1 }); loop.enable(); const cpuStart = process.cpuUsage();
function measure(name, work) { const start = perf.now(); try { return work(); } finally { const ms = perf.now()-start; const row = perfMetrics[name] ||= { count: 0, sumMs: 0, maxMs: 0 }; row.count++; row.sumMs += ms; row.maxMs = Math.max(row.maxMs,ms); } }
process.on('exit', () => { const cpu = process.cpuUsage(cpuStart), mem = process.memoryUsage(); fs.writeFileSync(process.env.CPS_PERF_FILE, JSON.stringify({ sections: perfMetrics, cpuMs: (cpu.user+cpu.system)/1000, loopMaxMs: loop.max/1e6, rssMiB: mem.rss/1048576, heapMiB: mem.heapUsed/1048576 })); });
`;
for (const name of sections) {
  const declaration = `function ${name}(`;
  if (instrumented.split(declaration).length !== 2) throw Error(`cannot instrument ${name}`);
  instrumented = instrumented.replace(declaration, `function original_${name}(`);
  instrumented += `\nfunction ${name}(...args) { return measure('${name}', () => original_${name}(...args)); }\n`;
}
const expression = instrumented.includes('JSON.stringify(obj, null, pretty ? 2 : undefined)') ? 'JSON.stringify(obj, null, pretty ? 2 : undefined)' : 'JSON.stringify(obj, null, 2)';
const atomic = `fs.writeFileSync(tmp, ${expression}, { mode });\n    fs.renameSync(tmp, file);`;
if (!instrumented.includes(atomic)) throw Error('atomic write seam changed');
instrumented = instrumented.replace(atomic, `const encoded = measure('meta.stringify', () => ${expression});\n    measure('meta.write', () => fs.writeFileSync(tmp, encoded, { mode }));\n    measure('meta.rename', () => fs.renameSync(tmp, file));`);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cps-whole-perf-'));
// Instrumentation/argument validation below may throw before the main try/finally.
// Keep temporary synthetic state owned by this process even on that early exit.
process.once('exit', () => { try { fs.rmSync(temp, { recursive: true, force: true }); } catch {} });
const dir = path.join(temp, 'state'), program = path.join(temp, 'program');
try {
  fs.mkdirSync(dir); fs.mkdirSync(program);
  for (const name of ['lib', 'public', 'node_modules']) fs.symlinkSync(path.join(root, name), path.join(program, name), 'dir');
  fs.writeFileSync(path.join(program, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(program, 'server.js'), prelude + instrumented);
} catch (error) {
  fs.rmSync(temp, { recursive: true, force: true });
  throw error;
}
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = server => new Promise(resolve => server.close(resolve));
const mockHits = { chat: 0, models: 0, quota: 0 };
let retryHits = 0;
const mock = http.createServer((req, res) => {
  const chunks = []; req.on('data', chunk => chunks.push(chunk)); req.on('end', () => {
    const body = req.url.includes('chat/completions') ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    if (req.url.endsWith('/models')) { mockHits.models++; res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ data: Array.from({length: 100}, (_, i) => ({ id: `catalog-${i}` })) })); }
    if (req.url.includes('usage-limits')) { mockHits.quota++; res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ success: true, data: { limits: [{ type: 'five_hour', percentUsed: 0 }, { type: 'weekly', percentUsed: 10 }, { type: 'monthly', percentUsed: 20 }] } })); }
    mockHits.chat++;
    if (body.model === 'synthetic-wait') return setTimeout(() => { res.setHeader('Content-Type','application/json'); res.end('{"choices":[{"message":{"content":"ok"}}]}'); }, 40);
    if (body.model === 'synthetic-fail' || (body.model === 'synthetic-retry' && ++retryHits % 3 !== 0)) { res.writeHead(503, { 'Content-Type': 'application/json' }); return res.end('{"error":{"message":"synthetic unavailable"}}'); }
    if (body.stream) {
      res.writeHead(200, {'Content-Type':'text/event-stream'}); res.write('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n');
      if (body.model === 'synthetic-heavy-sse') {
        let sent = 0;
        const pump = () => { while (sent++ < 512) if (!res.write(`data: ${'x'.repeat(4096)}\n\n`)) return res.once('drain', pump); res.end('data: [DONE]\n\n'); };
        return pump();
      }
      return setTimeout(() => res.end('data: [DONE]\n\n'), body.model === 'synthetic-slow-sse' ? 150 : 5);
    }
    res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25, prompt_tokens_details: { cached_tokens: 0 } } }));
  });
});
let child;
const stop = async () => {
  if (!child) return;
  const running = child; child = null;
  if (running.exitCode !== null) return;
  running.kill('SIGTERM');
  await Promise.race([new Promise(resolve => running.once('exit',resolve)), new Promise(resolve => setTimeout(() => { running.kill('SIGKILL'); resolve(); }, 5000))]);
};
const models = ['cline-pass/glm-5.3', 'cline-pass/kimi-k3', 'cline-pass/deepseek-v4-flash', 'synthetic-model'];
const quantiles = samples => {
  const values = samples.map(x => x.ms).sort((a,b)=>a-b);
  return { n: values.length, ok: samples.filter(x => x.status === 200).length, p50: +values[Math.floor(values.length*.5)].toFixed(2), p95: +values[Math.floor(values.length*.95)].toFixed(2), p99: +values[Math.floor(values.length*.99)].toFixed(2), max: +values.at(-1).toFixed(2) };
};
try {
  const upstreamPort = await listen(mock);
  const reserved = http.createServer(), port = await listen(reserved); await close(reserved);
  fs.writeFileSync(path.join(dir,'config.json'), JSON.stringify({ port, proxyKey: 'synthetic-client-key', upstreamBase: `http://127.0.0.1:${upstreamPort}/api/v1`, knownModels: models,
    accounts: [{ id: 'synthetic', name: 'Synthetic', key: 'synthetic-upstream-key', enabled: true, maxConcurrent: 0, maxRpm: 0, perModel: {} }],
    perModel: Object.fromEntries(models.map(m => [m, { upstreams: ['first','second','third'] }])), accountMode: 'single', accountPipeline: { quotaPool: false, healthSort: false, sticky: false } }));
  prepareAdminFixture(dir);
  const start = async label => {
    let output = ''; const begun = performance.now();
    child = spawn(process.execPath, [path.join(program,'server.js')], { cwd: root, env: { PATH: process.env.PATH || '', DATA_DIR: dir, BIND_HOST: '127.0.0.1', PORT: String(port), CPS_PERF_FILE: path.join(temp,`${label}.json`) }, stdio: ['ignore','pipe','pipe'] });
    child.stdout.on('data', bytes => { output += bytes; }); child.stderr.on('data', bytes => { output += bytes; });
    while (!output.includes('OpenAI 兼容代理地址') && child.exitCode === null && performance.now()-begun < 15000) await new Promise(resolve => setTimeout(resolve, 15));
    if (!output.includes('OpenAI 兼容代理地址')) throw Error(`isolated startup failed: ${output.slice(0,200)}`);
    await connectAdminFixture(port);
    return performance.now()-begun;
  };
  const timed = async (p, options) => {
    const begun = performance.now(), res = await fetch(`http://127.0.0.1:${port}${p}`,options); const bytes = (await res.arrayBuffer()).byteLength;
    return { ms: performance.now()-begun, status: res.status, bytes };
  };
  const chat = (model, size, extra = {}) => timed('/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer synthetic-client-key', ...extra }, body: JSON.stringify({ model, stream: extra['x-sse'] === 'yes', messages: [{ role: 'user', content: 'x'.repeat(size) }] }) });
  const read = p => timed(p, { headers: fixtureHeaders(port,p) });
  const expected = (row, label, status = 200) => { if (row.status !== status) throw Error(`${label}: unexpected HTTP status ${row.status}`); return row; };
  const repeat = async (n, fn) => { const rows=[]; for (let i=0;i<n;i++) rows.push(expected(await fn(i), `sample ${i}`)); return quantiles(rows); };
  const sample = async label => {
    const startupMs = await start(label); await chat(models[0], 10); await read('/api/statistics');
    const small = await repeat(32, i => chat(models[i%4], 100));
    const halfMiB = await repeat(8, i => chat(models[i%4], 512*1024));
    const statistics = await repeat(16, () => read('/api/statistics'));
    const accounts = await repeat(8, () => read('/api/accounts'));
    const meta = await repeat(8, () => read('/api/meta'));
    const coldModels = expected(await read('/api/models'), 'cold admin models');
    const hotModels = await repeat(8, () => read('/api/models'));
    const html = await repeat(8, () => timed('/'));
    const initialReads = await repeat(4, async () => { const begun = performance.now(); const routes = ['/api/models','/api/accounts','/api/security','/api/meta','/api/model-aliases','/api/statistics']; const rows = await Promise.all(routes.map(read)); return { ms:performance.now()-begun, status:rows.every(row=>row.status===200)?200:500 }; });
    const sse = await repeat(8, () => chat(models[0],100,{'x-sse':'yes'}));
    const quota = expected(await timed('/api/statistics/quota-refresh',{method:'POST',headers:fixtureHeaders(port,'/api/statistics/quota-refresh','POST',{'Content-Type':'application/json'}),body:'{"force":true}'}), 'quota refresh');
    const logs = expected(await read('/api/logs/requests?limit=20'), 'request logs');
    const metadataBytes = fs.statSync(path.join(dir,'metadata.json')).size;
    await stop();
    return { label, startupMs:+startupMs.toFixed(1), metadataBytes, small, halfMiB, statistics, accounts, meta, coldModels, hotModels, html, initialReads, sse, quota, logs, mockHits:{...mockHits}, server:JSON.parse(fs.readFileSync(path.join(temp,`${label}.json`))) };
  };
  const sparse = await sample('sparse');
  const metadataPath = path.join(dir,'metadata.json'), metadata = JSON.parse(fs.readFileSync(metadataPath,'utf8'));
  const bucket = metadata.statistics.minuteBuckets.at(-1), minute = Math.floor(Date.now()/60000);
  metadata.statistics.minuteBuckets = Array.from({ length:1200 },(_,i)=>({ ...structuredClone(bucket), minute:minute-1199+i }));
  fs.writeFileSync(metadataPath, JSON.stringify(metadata));
  const dense = await sample('dense');
  let extended;
  if (process.argv.includes('--extended')) {
    const configPath = path.join(dir,'config.json'), config = JSON.parse(fs.readFileSync(configPath));
    config.knownModels.push('synthetic-retry','synthetic-fail','synthetic-wait','synthetic-slow-sse','synthetic-heavy-sse');
    config.perModel['synthetic-retry'] = { upstreams: ['first','second','third'] };
    config.perModel['synthetic-fail'] = { upstreams: ['first'] };
    config.perModel['synthetic-wait'] = { upstreams: ['first'] };
    config.perModel['synthetic-slow-sse'] = { upstreams: ['first'] };
    config.perModel['synthetic-heavy-sse'] = { upstreams: ['first'] };
    fs.writeFileSync(configPath,JSON.stringify(config));
    const startupMs = await start('extended');
    const beforeAuth = mockHits.chat;
    const unauthorized = await timed('/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer wrong'},body:'{"model":"synthetic-wait","messages":[]}'});
    if (unauthorized.status !== 401 || mockHits.chat !== beforeAuth) throw Error('unauthorized request reached mock');
    const beforeRetry = mockHits.chat, retry = await chat('synthetic-retry',512*1024);
    const retryAttempts = mockHits.chat-beforeRetry;
    if (retry.status !== 200 || retryAttempts !== 3) throw Error('expected three real same-account provider attempts');
    const sse = expected(await chat('synthetic-slow-sse',100,{'x-sse':'yes'}), 'slow SSE');
    const quota = expected(await timed('/api/statistics/quota-refresh',{method:'POST',headers:fixtureHeaders(port,'/api/statistics/quota-refresh','POST',{'Content-Type':'application/json'}),body:'{"force":true}'}), 'extended quota refresh');
    const settings = async body => expected(await timed('/api/logs/settings',{method:'POST',headers:fixtureHeaders(port,'/api/logs/settings','POST',{'Content-Type':'application/json'}),body:JSON.stringify(body)}), 'diagnostic settings');
    await settings({errorDetailLogging:true});
    const errorOnlySuccess = expected(await chat(models[0],100), 'error-only success');
    const errorOnlyFailure = expected(await chat('synthetic-fail',100), 'intentional upstream failure', 503);
    await settings({errorDetailLogging:false,detailedLogging:true});
    const full = expected(await chat(models[0],512*1024), 'full diagnostic success');
    const detailHealth = expected(await read('/api/logs/settings'), 'diagnostic health');
    const errorLogs = expected(await read('/api/logs/errors?limit=20'), 'error logs');
    const detailLogs = expected(await read('/api/logs/details?limit=20'), 'detail listing');
    await settings({detailedLogging:false});
    const large = expected(await chat(models[0],49*1024*1024), '49 MiB chat');
    const slowConsumer = await new Promise((resolve,reject) => {
      const began = performance.now(), request = http.request({hostname:'127.0.0.1',port,path:'/v1/chat/completions',method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer synthetic-client-key'}}, response => {
        let bytes = 0, paused = false;
        response.on('data',chunk => { bytes += chunk.length; if (!paused) { paused = true; response.pause(); setTimeout(()=>response.resume(),120); } });
        response.on('end',()=>resolve({status:response.statusCode,bytes,ms:performance.now()-began})); response.on('error',reject);
      });
      request.on('error',reject); request.end(JSON.stringify({model:'synthetic-heavy-sse',stream:true,messages:[]}));
    });
    if (slowConsumer.status !== 200 || slowConsumer.bytes < 2*1024*1024) throw Error('SSE slow consumer truncated output');
    const controller = new AbortController(), beganCancel = performance.now();
    const cancelledResponse = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer synthetic-client-key'},body:JSON.stringify({model:'synthetic-slow-sse',stream:true,messages:[]}),signal:controller.signal});
    await cancelledResponse.body.getReader().read(); controller.abort();
    await new Promise(resolve=>setTimeout(resolve,180));
    const cancelled = {status:cancelledResponse.status,ms:performance.now()-beganCancel};
    const cancelledRows = await read('/api/logs/requests?result=client_cancelled&limit=20');
    const cancelledItems = await (await fetch(`http://127.0.0.1:${port}/api/logs/requests?result=client_cancelled&limit=20`,{headers:fixtureHeaders(port,'/api/logs/requests')})).json();
    if (cancelledRows.status !== 200 || !cancelledItems.items?.some(item=>item.result === 'client_cancelled' && item.status === 499)) throw Error('cancelled SSE lost terminal row');
    await stop();
    const metrics = JSON.parse(fs.readFileSync(path.join(temp,'extended.json')));
    // Switching mode/scale requires a restart so a synthetic management edit is not mistaken for live routing.
    config.accounts = Array.from({length:10},(_,i)=>({id:`a${i}`,name:`A${i}`,key:`synthetic-account-${i}`,enabled:true,maxConcurrent:1,maxRpm:0,perModel:{}}));
    config.accountMode = 'sticky'; config.detailedLogging = false; config.errorDetailLogging = false;
    config.accountPipeline = { quotaPool:false, healthSort:true, sticky:true };
    fs.writeFileSync(configPath,JSON.stringify(config));
    const multiStartupMs = await start('multi');
    const sticky = await repeat(16, i => chat(models[i%4],100,{'Session-Id':`session-${i%4}`}));
    const waiting = await Promise.all(Array.from({length:12},()=>chat('synthetic-wait',100)));
    const waitingSummary = quantiles(waiting);
    const statistics = await repeat(8,()=>read('/api/statistics'));
    await stop();
    extended = { startupMs:+startupMs.toFixed(1), unauthorized, retry, retryAttempts, sse, quota, errorOnlySuccess, errorOnlyFailure, full, detailHealth, errorLogs, detailLogs, large, slowConsumer, cancelled, cancelledRows, metrics,
      multi:{startupMs:+multiStartupMs.toFixed(1), sticky, waiting:waitingSummary, statistics, metrics:JSON.parse(fs.readFileSync(path.join(temp,'multi.json')))} };
  }
  console.log(JSON.stringify({kind:'whole-service-synthetic-profile',node:process.version,ref:ref||'working-tree',sparse,dense,extended, caveat:'Section times are inclusive and include instrumentation overhead. One local process and loopback mock; 1200 cloned valid buckets, no production or browser profile. Extended large body consumes substantial memory.'},null,2));
} finally {
  await stop(); await close(mock); fs.rmSync(temp,{recursive:true,force:true});
}
