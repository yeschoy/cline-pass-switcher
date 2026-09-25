// Synthetic, local-only rollback rehearsal. Run from repository root: node .trellis/tasks/archive/2026-09/09-25-expand-reference-prices/research/rollback-check.mjs
// Never prints child output, fixture credentials, request bodies or raw operator files.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let repo = path.dirname(fileURLToPath(import.meta.url));
while (!fs.existsSync(path.join(repo, 'server.js')) || !fs.existsSync(path.join(repo, 'package.json'))) {
  const parent = path.dirname(repo);
  if (parent === repo) throw Error('repository root not found');
  repo = parent;
}
const oldVersion = 'clinepass-2026-09-24-v1';
const newVersion = 'clinepass-2026-09-25-v2';
const oldModel = 'cline-pass/kimi-k3';
const newModel = 'cline-pass/mimo-v2.5';
const readyMarker = 'OpenAI 兼容代理地址';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cps-rollback-rehearsal-'));
const dataDir = path.join(root, 'data');
const backupV1 = path.join(root, 'private-v1-backup');
const backupV2 = path.join(root, 'private-v2-backup');
const oldTree = path.join(root, 'old-program');
const children = new Set();
let mock;
let stage = 'setup';
let port;

function check(condition) { assert.ok(condition); }
function metadata(dir = dataDir) { return JSON.parse(fs.readFileSync(path.join(dir, 'metadata.json'), 'utf8')); }
function sha(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function priceCell(meta, model, version) {
  const buckets = meta.statistics.minuteBuckets;
  const cells = buckets.flatMap((bucket) => Object.values(bucket.valuation?.[model] || {}).map((versions) => versions[version]).filter(Boolean));
  check(cells.length === 1);
  return cells[0];
}
function historicalV1(meta) {
  check(meta.statistics.version === 5);
  check(Object.keys(meta.statistics.priceVersions).includes(oldVersion));
  check(!Object.keys(meta.statistics.priceVersions).includes(newVersion));
  check(meta.statistics.priceVersions[oldVersion].models[oldModel].rates[0][0] === 3000);
  const cell = priceCell(meta, oldModel, oldVersion);
  check(cell.pricedRequests === 1 && cell.lowPicoUsd === 51900000 && cell.highPicoUsd === 51900000);
  check(meta.statistics.lifetime.global.requests === 1);
}
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const chosen = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return chosen;
}
function childEnv() {
  // Do not inherit user/prod keys, network proxy settings or test flags.
  return { DATA_DIR: dataDir, BIND_HOST: '127.0.0.1', NODE_ENV: 'test', PORT: String(port) };
}
async function launch(serverFile, shouldStart) {
  const child = spawn(process.execPath, [serverFile], {
    cwd: path.dirname(serverFile), env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  let out = '', err = '', settled = false;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(false), 10000);
    function finish(ok) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (ok) resolve(shouldStart ? child : null);
      else reject(new Error('startup condition not met'));
    }
    child.stdout.on('data', (bytes) => {
      out = (out + bytes.toString()).slice(-8192);
      if (shouldStart && out.includes(readyMarker)) finish(true);
    });
    child.stderr.on('data', (bytes) => { err = (err + bytes.toString()).slice(-8192); });
    child.once('error', () => finish(false));
    child.once('exit', (code, signal) => {
      children.delete(child);
      if (shouldStart) finish(false);
      else finish(code !== 0 && signal === null && !out.includes(readyMarker) && /invalid statistics price snapshot/.test(err));
    });
  });
}
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 1800))]);
  if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
  children.delete(child);
}
async function request(model) {
  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'synthetic' }] }),
    signal: AbortSignal.timeout(5000),
  });
  await res.arrayBuffer(); // Drain but never print responses.
  check(res.status === 200);
}
function snapshot(from, to) {
  fs.cpSync(from, to, { recursive: true, force: false, errorOnExist: true });
  fs.chmodSync(to, 0o700);
}
async function cleanup() {
  await Promise.allSettled([...children].map(stop));
  if (mock) await new Promise((resolve) => mock.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => { void cleanup().finally(() => process.exit(1)); });
}
try {
  fs.chmodSync(root, 0o700);
  fs.mkdirSync(dataDir, { mode: 0o700 });
  fs.mkdirSync(oldTree, { mode: 0o700 });
  // Pin the pre-v2 baseline; HEAD advances when this task is committed or archived.
  const oldSource = execFileSync('git', ['show', '08f27f8:server.js'], { cwd: repo, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  check(oldSource.includes(oldVersion) && !oldSource.includes(newVersion));
  check(fs.readFileSync(path.join(repo, 'server.js'), 'utf8').includes(newVersion));
  fs.writeFileSync(path.join(oldTree, 'server.js'), oldSource, { mode: 0o600 });
  fs.copyFileSync(path.join(repo, 'package.json'), path.join(oldTree, 'package.json'));
  fs.cpSync(path.join(repo, 'lib'), path.join(oldTree, 'lib'), { recursive: true });
  fs.symlinkSync(path.join(repo, 'node_modules'), path.join(oldTree, 'node_modules'), 'dir');
  // No public/index.html is requested: this rehearsal uses only the native chat route.
  mock = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/chat/completions') {
      req.resume(); res.writeHead(404); res.end(); return;
    }
    let body = '';
    req.on('data', (chunk) => { body += chunk; if (body.length > 4096) req.destroy(); });
    req.on('end', () => {
      let parsed;
      try { parsed = JSON.parse(body); } catch { res.writeHead(400); res.end(); return; }
      if (![oldModel, newModel].includes(parsed.model)) { res.writeHead(400); res.end(); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'synthetic reply' } }],
        usage: { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 3 } } }));
    });
  });
  await new Promise((resolve, reject) => { mock.once('error', reject); mock.listen(0, '127.0.0.1', resolve); });
  port = await freePort();
  const config = { port, upstreamBase: `http://127.0.0.1:${mock.address().port}`,
    accounts: [{ id: 'synthetic', name: 'Synthetic', key: 'local-fixture-only', enabled: true, perModel: {} }],
    knownModels: [oldModel, newModel], accountMode: 'single', activeAccount: 0 };
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify(config), { mode: 0o600 });

  stage = 'old v1 generation';
  let child = await launch(path.join(oldTree, 'server.js'), true);
  await request(oldModel);
  await stop(child);
  const v1 = metadata();
  historicalV1(v1);
  snapshot(dataDir, backupV1); // Entire private state, not a hand-edited v2 metadata file.
  const v1Bytes = fs.readFileSync(path.join(backupV1, 'metadata.json'));
  const v1Hash = sha(v1Bytes);
  console.log('PASS old baseline created frozen v1 cell and private full-state backup');

  stage = 'new v2 generation';
  child = await launch(path.join(repo, 'server.js'), true);
  await request(newModel);
  await stop(child);
  const v2 = metadata();
  check(v2.statistics.priceVersions[oldVersion].models[oldModel].rates[0][0] === 3000);
  check(priceCell(v2, oldModel, oldVersion).lowPicoUsd === 51900000);
  check(v2.statistics.priceVersions[newVersion].rateScale === 10000);
  check(v2.statistics.lifetime.global.requests === 2);
  const v2Cell = priceCell(v2, newModel, newVersion);
  check(v2Cell.pricedRequests === 1 && v2Cell.lowPicoUsd === 1548400 && v2Cell.highPicoUsd === 1548400);
  snapshot(dataDir, backupV2); // Retain newer history separately before restoring old data.
  const v2Bytes = fs.readFileSync(path.join(dataDir, 'metadata.json'));
  const v2ConfigBytes = fs.readFileSync(path.join(dataDir, 'config.json'));
  const v2Hash = sha(v2Bytes);
  check(v2Hash !== v1Hash);
  console.log('PASS current tree retained v1 and created distinct v2 snapshot/cell');

  stage = 'old rejects v2 without mutation';
  await launch(path.join(oldTree, 'server.js'), false);
  check(fs.readFileSync(path.join(dataDir, 'metadata.json')).equals(v2Bytes));
  check(fs.readFileSync(path.join(dataDir, 'config.json')).equals(v2ConfigBytes));
  check(sha(fs.readFileSync(path.join(backupV2, 'metadata.json'))) === v2Hash);
  console.log('PASS old baseline rejected v2 before listening; config/metadata bytes unchanged');

  stage = 'restore private v1 backup and restart old';
  fs.rmSync(dataDir, { recursive: true });
  snapshot(backupV1, dataDir);
  check(fs.readFileSync(path.join(dataDir, 'metadata.json')).equals(v1Bytes));
  child = await launch(path.join(oldTree, 'server.js'), true);
  historicalV1(metadata());
  check(fs.readFileSync(path.join(dataDir, 'metadata.json')).equals(v1Bytes));
  // A new old-binary write succeeds, proving rollback is usable, not merely parseable.
  await request(oldModel);
  await stop(child);
  const restored = metadata();
  check(restored.statistics.lifetime.global.requests === 2);
  check(priceCell(restored, oldModel, oldVersion).pricedRequests === 2);
  check(priceCell(restored, oldModel, oldVersion).lowPicoUsd === 103800000);
  check(!Object.hasOwn(restored.statistics.priceVersions, newVersion));
  check(sha(fs.readFileSync(path.join(backupV2, 'metadata.json'))) === v2Hash);
  console.log('PASS private v1 restore restarted old baseline and preserved historical v1; v2 kept separately, not visible to old');
  console.log('PASS all synthetic rollback checks');
} catch {
  // Never dump child stderr, fixture credentials, raw metadata or untrusted response text.
  console.error(`FAIL ${stage}`);
  process.exitCode = 1;
} finally {
  await cleanup();
}
