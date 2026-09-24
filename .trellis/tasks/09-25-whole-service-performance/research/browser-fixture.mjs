// Local browser-performance fixture. Synthetic data and credentials only.
// Start from repo root: node .trellis/tasks/09-25-whole-service-performance/research/browser-fixture.mjs
// Stop with SIGTERM; both child service and temporary DATA_DIR are cleaned.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../');
const { prepareAdminFixture } = await import(pathToFileURL(path.join(root, 'test/admin-fixture.js')).href);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cps-browser-perf-'));
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const upstream = http.createServer((req, res) => {
  req.resume(); req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url.endsWith('/models')) return res.end(JSON.stringify({ data: Array.from({ length: 5000 }, (_, i) => ({ id: `synthetic-catalog-${i}` })) }));
    if (req.url.includes('usage-limits')) return res.end(JSON.stringify({ success: true, data: { limits: [{ type: 'five_hour', percentUsed: 10 }, { type: 'weekly', percentUsed: 15 }, { type: 'monthly', percentUsed: 20 }] } }));
    res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
  });
});
let child, stopped = false;
async function stop() {
  if (stopped) return; stopped = true;
  if (child?.exitCode === null) {
    const process = child; child = null; process.kill('SIGTERM');
    await Promise.race([new Promise((resolve) => process.once('exit', resolve)), new Promise((resolve) => setTimeout(() => { process.kill('SIGKILL'); resolve(); }, 4000))]);
  }
  await new Promise((resolve) => upstream.close(resolve));
  fs.rmSync(dir, { recursive: true, force: true });
}
process.once('SIGTERM', () => { void stop().then(() => process.exit(0)); });
process.once('SIGINT', () => { void stop().then(() => process.exit(0)); });
try {
  const upstreamPort = await listen(upstream);
  const portReservation = http.createServer(), port = await listen(portReservation);
  await new Promise((resolve) => portReservation.close(resolve));
  const models = Array.from({ length: 50 }, (_, i) => `synthetic-model-${i}`);
  const accounts = Array.from({ length: 10 }, (_, i) => ({ id: `synthetic-${i}`, name: `Synthetic ${i}`, key: `synthetic-upstream-${i}`, enabled: true, maxConcurrent: 0, maxRpm: 0, perModel: {} }));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ port, proxyKey: 'synthetic-client-key', upstreamBase: `http://127.0.0.1:${upstreamPort}/api/v1`, knownModels: models, accounts, accountMode: 'roundrobin', accountPipeline: { quotaPool: false, healthSort: false, sticky: false } }));
  prepareAdminFixture(dir);
  let output = '';
  child = spawn(process.execPath, ['server.js'], { cwd: root, env: { PATH: process.env.PATH || '', DATA_DIR: dir, PORT: String(port), BIND_HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (bytes) => { output += bytes; }); child.stderr.on('data', (bytes) => { output += bytes; });
  const deadline = Date.now() + 10000;
  while (!output.includes('OpenAI 兼容代理地址') && child.exitCode === null && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 15));
  if (!output.includes('OpenAI 兼容代理地址')) throw Error(`isolated service failed: ${output.slice(0, 200)}`);
  console.log(`fixture: http://127.0.0.1:${port}/`);
  await new Promise(() => {});
} catch (error) {
  console.error(String(error.message || error));
  await stop(); process.exitCode = 1;
}
