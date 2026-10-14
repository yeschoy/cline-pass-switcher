#!/usr/bin/env node
// Live traffic requires independent private preflight and continuous aggregate health watcher.
// Never import operator configuration or emit request/response content, identity or URL.
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';

const LIMIT = Object.freeze({ rpm: 350, requests: 900, seconds: 300, inflight: 64 });
const mono = () => performance.now();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(1, ms)));
const percentile = (sorted, p) => sorted.length ? Math.round(sorted[Math.ceil(sorted.length * p) - 1]) : null;

function options(args) {
  const o = {};
  for (const arg of args) {
    const match = /^--(origin|model|execute|preflight-confirmed|local-test-only)(?:=(.*))?$/.exec(arg);
    if (!match || Object.hasOwn(o, match[1]) || ((match[1] === 'origin' || match[1] === 'model') === (match[2] === undefined))) throw Error('invalid_options');
    o[match[1]] = match[2] === undefined ? true : match[2];
  }
  if (o.execute !== true || o['preflight-confirmed'] !== true || !o.origin || !o.model || o.model.length > 300 || !/^[\w.\-/]{1,300}$/.test(o.model)) throw Error('preflight_required');
  let url;
  try { url = new URL(o.origin); } catch { throw Error('invalid_origin'); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || !url.hostname || (url.protocol !== 'https:' && !(o['local-test-only'] && url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname))) || (o['local-test-only'] && !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname))) throw Error('invalid_origin');
  return { url, model: o.model };
}

async function main() {
  const { url, model } = options(process.argv.slice(2));
  // fd3 is a private, one-line credential pipe; fd4 is a continuous boolean health gate.
  // Missing/unreadable descriptors fail closed before any network request.
  let credential = '';
  for await (const chunk of fs.createReadStream(null, { fd: 3, autoClose: false, encoding: 'utf8' })) {
    credential += chunk;
    if (credential.length > 257) throw Error('invalid_private_credential');
  }
  if (!/^[^\r\n\x00-\x1f\x7f]{16,256}\n?$/.test(credential)) throw Error('invalid_private_credential');
  const key = credential.endsWith('\n') ? credential.slice(0, -1) : credential;
  if (key.length < 16) throw Error('invalid_private_credential');
  const agent = url.protocol === 'https:' ? new https.Agent({ keepAlive: true, maxSockets: LIMIT.inflight }) : new http.Agent({ keepAlive: true, maxSockets: LIMIT.inflight });
  let lastHealth = 0, stopped = null, launched = 0, inflight = 0, peak = 0;
  const active = new Set();
  const stages = [];
  const launchTimes = [];
  const start = mono();
  // Reserve two seconds for abort, drain and aggregate output inside the five-minute envelope.
  const deadline = start + (LIMIT.seconds - 2) * 1000;
  const stop = (reason) => {
    if (stopped) return;
    stopped = reason;
    for (const req of active) req.destroy();
  };
  let monitorBuffer = '';
  const monitor = fs.createReadStream(null, { fd: 4, autoClose: false, encoding: 'utf8' });
  monitor.on('data', (chunk) => {
    monitorBuffer += chunk;
    if (monitorBuffer.length > 1024) return stop('health_protocol');
    let end;
    while ((end = monitorBuffer.indexOf('\n')) !== -1) {
      const line = monitorBuffer.slice(0, end); monitorBuffer = monitorBuffer.slice(end + 1);
      try {
        const beat = JSON.parse(line);
        if (Object.keys(beat).length !== 1 || beat.ok !== true) return stop('health_guard');
        lastHealth = mono();
      } catch { return stop('health_protocol'); }
    }
  });
  monitor.on('error', () => stop('health_lost'));
  monitor.on('end', () => stop('health_lost'));
  const signals = () => stop('operator_stop');
  process.on('SIGINT', signals); process.on('SIGTERM', signals);
  const guard = setInterval(() => {
    if (mono() >= deadline) stop('deadline');
    if (mono() - lastHealth > 6000) stop('health_lost');
  }, 100);
  const healthy = () => !stopped && mono() < deadline && lastHealth && mono() - lastHealth <= 6000;
  const allowed = () => {
    while (launchTimes.length && launchTimes[0] <= mono() - 60000) launchTimes.shift();
    return healthy() && launched < LIMIT.requests && inflight < LIMIT.inflight && launchTimes.length < LIMIT.rpm;
  };
  const waitSlot = async () => {
    while (healthy() && launched < LIMIT.requests) {
      if (allowed()) return true;
      await sleep(20);
    }
    return false;
  };
  const recent = [];
  let baseline = null;
  function classify(result, stage) {
    stage.completed++;
    if (result.attempts !== null) { stage.attempts += result.attempts; stage.attemptsKnown++; }
    if (result.kind === 'success') { stage.success++; stage.latencies.push(result.ms); if (baseline === null) baseline = result.ms; }
    else stage[result.kind] = (stage[result.kind] || 0) + 1;
    recent.push(result); if (recent.length > 20) recent.shift();
    if (result.kind === 'local429' || result.kind === 'attempted429' || result.kind === 'unknown429') stop('first_429');
    else if (result.kind === 'auth' || result.kind === 'invalid' || result.kind === 'fanout' || result.kind === 'network' || result.kind === 'unavailable') stop(result.kind);
    else if (recent.filter((r) => r.kind === 'server5xx' || r.kind === 'timeout').length >= 2) stop('error_guard');
    else if (recent.length === 20 && recent.filter((r) => r.kind === 'success').length < 19) stop('success_guard');
    else if (baseline !== null && recent.length === 20 && percentile(recent.filter((r) => r.kind === 'success').map((r) => r.ms).sort((a,b) => a-b), .95) > Math.max(10000, baseline * 2)) stop('latency_guard');
  }
  function request(stage) {
    const sent = mono(); launched++; inflight++; peak = Math.max(peak, inflight);
    stage.offered++; stage.peakClientInFlight = Math.max(stage.peakClientInFlight, inflight);
    launchTimes.push(sent);
    const data = JSON.stringify({ model, stream: false, max_tokens: 8, session_id: randomUUID(), messages: [{ role: 'user', content: 'Reply OK.' }] });
    return new Promise((resolve) => {
      let settled = false, req;
      const finish = (kind, attempts = null) => {
        if (settled) return;
        settled = true; active.delete(req); inflight--;
        classify({ kind: stopped ? 'cancelled' : kind, attempts, ms: mono() - sent }, stage);
        resolve();
      };
      const transport = url.protocol === 'https:' ? https : http;
      try {
        req = transport.request(new URL('/v1/chat/completions', url), {
          method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          agent, timeout: 30000,
        }, (res) => {
          const attemptText = res.headers['x-cline-attempts'];
          const attempts = typeof attemptText === 'string' && /^(0|[1-9]\d?)$/.test(attemptText) ? Number(attemptText) : null;
          // Terminal error headers are sufficient: trip the guard before waiting for any body.
          if (res.statusCode !== 200) {
            // A positive attempt count may end in upstream 429 OR a subsequent local RPM 429.
            const kind = res.statusCode === 429 ? attempts === 0 ? 'local429' : attempts > 0 ? 'attempted429' : 'unknown429' :
              res.statusCode === 401 || res.statusCode === 403 ? 'auth' : res.statusCode === 503 ? 'unavailable' : res.statusCode >= 500 ? 'server5xx' : 'invalid';
            finish(kind, attempts);
            res.destroy();
            return;
          }
          // Parse only bounded 200 JSON to disqualify HTTP-200 error envelopes. Never expose raw bytes.
          let bytes = 0, chunks = [];
          res.on('data', (chunk) => {
            bytes += chunk.length;
            if (res.statusCode === 200 && bytes <= 65536) chunks.push(chunk);
            if (bytes > 65536) { stop('response_too_large'); res.destroy(); }
          });
          res.on('end', () => {
            if (settled) return;
            let kind = 'invalid';
            if (bytes <= 65536) {
              try {
                const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                kind = !body.error && Array.isArray(body.choices) && body.choices.some((c) => (typeof c?.message?.content === 'string' && c.message.content.trim()) || c?.message?.tool_calls?.length) ? 'success' : 'invalid';
              } catch { kind = 'invalid'; }
            }
            chunks = [];
            if (attempts > 1) kind = 'fanout';
            else if (attempts !== 1) kind = 'invalid';
            finish(kind, attempts);
          });
          res.on('error', () => finish('network', attempts));
        });
        active.add(req);
        req.on('timeout', () => { req.destroy(); finish('timeout'); });
        req.on('error', () => finish('network'));
        req.end(data);
      } catch { if (req) req.destroy(); finish('network'); }
    });
  }
  const stage = (name) => ({ name, offered: 0, completed: 0, success: 0, peakClientInFlight: 0, attempts: 0, attemptsKnown: 0, latencies: [], startedUtc: new Date().toISOString(), started: mono() });
  const summarize = (s) => {
    const durationSeconds = (mono() - s.started) / 1000;
    s.latencies.sort((a,b) => a-b);
    const result = { name: s.name, startedUtc: s.startedUtc, endedUtc: new Date().toISOString(), durationSeconds: +durationSeconds.toFixed(3), offered: s.offered, completed: s.completed, success: s.success, successRate: s.completed ? +(s.success / s.completed).toFixed(4) : null,
      goodputRps: +(s.success / durationSeconds).toFixed(3), completedRps: +(s.completed / durationSeconds).toFixed(3), peakClientInFlight: s.peakClientInFlight, attempts: s.attempts, attemptsKnown: s.attemptsKnown,
      p50Ms: percentile(s.latencies, .5), p95Ms: percentile(s.latencies, .95), p99Ms: percentile(s.latencies, .99), latencySamples: s.latencies.length };
    for (const kind of ['local429','attempted429','unknown429','server5xx','auth','unavailable','invalid','fanout','timeout','network','cancelled']) result[kind] = s[kind] || 0;
    stages.push(result);
  };
  try {
    // No traffic until a fresh positive health beat arrives.
    while (!lastHealth && !stopped && mono() < start + 5000) await sleep(20);
    if (!lastHealth && !stopped) stop('health_lost');
    if (healthy()) {
      const dry = stage('dry_run');
      if (await waitSlot()) await request(dry);
      summarize(dry);
      if (dry.success !== 1 || dry.attemptsKnown !== 1 || dry.attempts !== 1) stop('dry_run_failed');
    }
    for (const rate of [60, 120, 240, 350]) {
      if (!healthy()) break;
      const s = stage(`paced_${rate}`), seconds = rate === 350 ? 120 : 6;
      // Missed ticks are dropped, never replayed. The sliding 60s limiter spans stages.
      const until = s.started + seconds * 1000, interval = 60000 / rate;
      for (let next = s.started; mono() < until && healthy(); next += interval) {
        while (mono() < next && healthy()) await sleep(Math.min(20, next - mono()));
        if (!healthy() || mono() >= until || launched >= LIMIT.requests) break;
        if (allowed()) void request(s);
      }
      const drainUntil = mono() + 1000;
      while (inflight && (healthy() || mono() < drainUntil)) await sleep(20);
      summarize(s);
      if (launched >= LIMIT.requests) { stop('request_budget'); break; }
    }
    for (const size of [1, 2, 4, 8, 16, 32, 64]) {
      if (!healthy()) break;
      const s = stage(`burst_${size}`);
      const jobs = [];
      for (let i = 0; i < size && healthy(); i++) {
        if (launched >= LIMIT.requests) { stop('request_budget'); break; }
        if (!await waitSlot()) break;
        jobs.push(request(s));
      }
      await Promise.all(jobs);
      summarize(s);
    }
  } finally {
    stop(stopped || 'steps_complete');
    // Bounded drain; abort has already destroyed outstanding sockets.
    const drainUntil = mono() + 1000;
    while (inflight && mono() < drainUntil) await sleep(20);
    clearInterval(guard); monitor.destroy(); agent.destroy();
    process.off('SIGINT', signals); process.off('SIGTERM', signals);
    console.log(JSON.stringify({ schema: 1, limits: LIMIT, stop: stopped, launched, completed: stages.reduce((n,s) => n + s.completed, 0), peakClientInFlight: peak, stages }));
  }
}

main().catch(() => { console.error('benchmark setup failed (no traffic if preflight failed); details suppressed'); process.exitCode = 1; });
