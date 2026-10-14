import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const script = fileURLToPath(new URL('./live-pool-generator.mjs', import.meta.url));
const secret = 'synthetic-local-key-1234567890';
async function run(reply, beat = '{"ok":true}\n') {
  let hits = 0;
  const times = [];
  const server = http.createServer((req, res) => {
    hits++;
    times.push(performance.now());
    assert.equal(req.headers.authorization, `Bearer ${secret}`);
    assert.equal(req.url, '/v1/chat/completions');
    req.resume();
    req.on('end', () => reply(res, hits));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const child = spawn(process.execPath, [script, `--origin=http://127.0.0.1:${server.address().port}`, '--model=local/mock', '--execute', '--preflight-confirmed', '--local-test-only'], { stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout.on('data', (data) => { out += data; });
  child.stderr.on('data', (data) => { err += data; });
  child.stdio[3].end(`${secret}\n`);
  child.stdio[4].write(beat);
  const timer = setInterval(() => { if (!child.stdio[4].destroyed) child.stdio[4].write(beat); }, 1000);
  try {
    let timeout;
    const exit = await Promise.race([
      new Promise((resolve) => child.once('exit', (code) => resolve(code))),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(Error('test timeout')), 9000); }),
    ]).finally(() => clearTimeout(timeout));
    assert.equal(exit, 0, err);
    assert.doesNotMatch(out + err, /synthetic-local-key|local\/mock|127\.0\.0\.1/);
    return { result: JSON.parse(out), hits, times };
  } finally {
    clearInterval(timer); child.kill(); child.stdio[4].end();
    await new Promise((resolve) => server.close(resolve));
  }
}

test('first local 429 stops before another paid request, without emitting secret/identity', async () => {
  const { result, hits } = await run((res) => {
    res.writeHead(429, { 'X-Cline-Attempts': '0' }); res.end('{"error":{"message":"private"}}');
  });
  assert.equal(hits, 1);
  assert.equal(result.stop, 'first_429');
  assert.equal(result.stages[0].local429, 1);
  assert.equal(result.launched, 1);
});

test('a 200 error envelope is not counted as a useful success and prevents ramp', async () => {
  const { result, hits } = await run((res) => {
    res.writeHead(200, { 'X-Cline-Attempts': '1' }); res.end('{"error":{"message":"private"}}');
  });
  assert.equal(hits, 1);
  assert.equal(result.stages[0].success, 0);
  assert.equal(result.stop, 'invalid');
});

test('429 after a real attempt stops without assuming its origin', async () => {
  const { result, hits } = await run((res, index) => {
    if (index === 1) { res.writeHead(200, { 'X-Cline-Attempts': '1' }); res.end('{"choices":[{"message":{"content":"OK"}}]}'); }
    else { res.writeHead(429, { 'X-Cline-Attempts': '1' }); res.end(); }
  });
  assert.equal(hits, 2);
  assert.equal(result.stop, 'first_429');
  assert.equal(result.stages[1].attempted429, 1);
  assert.equal(result.peakClientInFlight, 1);
});

test('paced 60 RPM drops catch-up instead of flooding after dry run', async () => {
  const { result, hits, times } = await run((res, index) => {
    res.writeHead(index === 4 ? 429 : 200, { 'X-Cline-Attempts': '1' });
    res.end(index === 4 ? '' : '{"choices":[{"message":{"content":"OK"}}]}');
  });
  assert.equal(hits, 4);
  assert.equal(result.stop, 'first_429');
  assert.ok(times[2] - times[1] >= 850, 'paced step must wait for its next second');
  assert.ok(times[3] - times[2] >= 850, 'paced step must not catch up in a burst');
  assert.equal(result.limits.rpm, 350);
  assert.equal(result.limits.requests, 900);
  assert.equal(result.limits.inflight, 64);
});

test('watcher veto prevents any traffic', async () => {
  const { result, hits } = await run((res) => res.end(), '{"ok":false}\n');
  assert.equal(hits, 0);
  assert.equal(result.stop, 'health_guard');
});
