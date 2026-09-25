// Local-only planning probe. Synthetic credentials/data; no production services or data.
// Run from repository root: env -u CLINE_PASS_KEY -u PROXY_KEY -u PUBLIC_BASE_URL -u PORT node .trellis/tasks/09-25-pricing-console-keys-300rpm/research/local-latency-probe.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

const { prepareAdminFixture, connectAdminFixture, fixtureHeaders } = await import(pathToFileURL(path.join(process.cwd(), 'test/admin-fixture.js')).href);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cps-plan-probe-'));
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const mock = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url.endsWith('/models')) return res.end(JSON.stringify({ data: [] }));
    if (req.url.includes('usage-limits')) return res.end(JSON.stringify({ success: true, data: { limits: [{ type: 'five_hour', percentUsed: 10 }, { type: 'weekly', percentUsed: 10 }, { type: 'monthly', percentUsed: 10 }] } }));
    res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25, prompt_tokens_details: { cached_tokens: 0 } } }));
  });
});
let child = null;
const stop = async () => {
  if (!child || child.exitCode !== null) return;
  const running = child; child = null;
  running.kill('SIGTERM');
  await Promise.race([new Promise((resolve) => running.once('exit', resolve)), new Promise((resolve) => setTimeout(() => { running.kill('SIGKILL'); resolve(); }, 3000))]);
};
const models = ['cline-pass/glm-5.3', 'cline-pass/kimi-k3', 'cline-pass/deepseek-v4-flash', 'synthetic-model'];
const summary = (values) => {
  const ordered = values.map((x) => x.ms).sort((a, b) => a - b);
  return { n: values.length, ok: values.filter((x) => x.status === 200).length,
    p50Ms: +ordered[Math.floor(ordered.length * 0.5)].toFixed(1),
    p95Ms: +ordered[Math.floor(ordered.length * 0.95)].toFixed(1),
    maxMs: +ordered.at(-1).toFixed(1) };
};
try {
  const upstreamPort = await listen(mock);
  const reservation = http.createServer(), port = await listen(reservation);
  await new Promise((resolve) => reservation.close(resolve));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ port, proxyKey: 'synthetic-client-key', upstreamBase: `http://127.0.0.1:${upstreamPort}/api/v1`, knownModels: models,
    accounts: [{ id: 'synthetic', name: 'Synthetic', key: 'synthetic-upstream-key', enabled: true, maxConcurrent: 0, maxRpm: 0, perModel: {} }],
    accountMode: 'single', accountPipeline: { quotaPool: false, healthSort: false, sticky: false } }));
  prepareAdminFixture(dir);
  const start = async () => {
    let output = '';
    const began = performance.now();
    child = spawn(process.execPath, ['server.js'], { cwd: process.cwd(), env: { ...process.env, DATA_DIR: dir, BIND_HOST: '127.0.0.1', PORT: String(port), CLINE_PASS_KEY: '', PROXY_KEY: '', PUBLIC_BASE_URL: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (bytes) => { output += bytes; });
    child.stderr.on('data', (bytes) => { output += bytes; });
    while (!output.includes('OpenAI 兼容代理地址') && child.exitCode === null && performance.now() - began < 15000) await new Promise((resolve) => setTimeout(resolve, 15));
    if (child.exitCode !== null || !output.includes('OpenAI 兼容代理地址')) throw new Error(`isolated startup failed: ${output.slice(0, 200)}`);
    await connectAdminFixture(port);
    return +(performance.now() - began).toFixed(1);
  };
  const timed = async (pathname, options) => {
    const began = performance.now(), res = await fetch(`http://127.0.0.1:${port}${pathname}`, options);
    await res.arrayBuffer();
    return { ms: performance.now() - began, status: res.status };
  };
  const chat = (model, bytes) => timed('/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer synthetic-client-key' }, body: JSON.stringify({ model, messages: [{ role: 'user', content: 'x'.repeat(bytes) }] }) });
  const stat = () => timed('/api/statistics', { headers: fixtureHeaders(port, '/api/statistics') });
  const accounts = () => timed('/api/accounts', { headers: fixtureHeaders(port, '/api/accounts') });
  const sample = async (label, startupMs) => {
    await chat(models[0], 10); await stat(); // one warm-up for both service and client
    const small = []; for (let i = 0; i < 32; i++) small.push(await chat(models[i % models.length], 100));
    const halfMiB = []; for (let i = 0; i < 8; i++) halfMiB.push(await chat(models[i % models.length], 512 * 1024));
    const statistics = []; for (let i = 0; i < 16; i++) statistics.push(await stat());
    const accountReads = []; for (let i = 0; i < 8; i++) accountReads.push(await accounts());
    return { label, startupMs, metadataBytes: fs.statSync(path.join(dir, 'metadata.json')).size,
      smallSequential: summary(small), halfMiBSequential: summary(halfMiB), statisticsSequential: summary(statistics), accountsSequential: summary(accountReads) };
  };
  const warmStartMs = await start();
  const baseline = await sample('one-minute-bucket', warmStartMs);
  await stop();
  // Valid synthetic v5 buckets cloned from the running service; no operator files or credentials.
  const metaPath = path.join(dir, 'metadata.json'), meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  const existing = meta.statistics.minuteBuckets.at(-1), minute = Math.floor(Date.now() / 60000);
  meta.statistics.minuteBuckets = Array.from({ length: 1200 }, (_, index) => ({ ...structuredClone(existing), minute: minute - 1199 + index }));
  fs.writeFileSync(metaPath, JSON.stringify(meta));
  const corpusStartMs = await start();
  const corpus = await sample('1200-synthetic-minute-buckets', corpusStartMs);
  console.log(JSON.stringify({ kind: 'local-planning-probe', node: process.version, baseline, corpus,
    caveat: 'Sequential loopback mock, one account/four models; synthetic cloned minute buckets are not real historical traffic, measurements are not CPU profiles or production SLOs.' }, null, 2));
} finally {
  await stop();
  await new Promise((resolve) => mock.close(resolve));
  fs.rmSync(dir, { recursive: true, force: true });
}
