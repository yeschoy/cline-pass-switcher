import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Exercise the production calculation with controlled terminal timestamps, without
// a process-wide clock override or live upstream. HTTP/restart coverage is in the
// integration and pricing-key suites.
const source = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const prices = source.slice(source.indexOf('const LEGACY_REFERENCE_PRICE ='), source.indexOf('const STATISTICS_VERSION ='));
const calculation = source.slice(source.indexOf('function referenceValue('), source.indexOf('const MAX_ACCOUNT_MINUTE_CELLS ='));
assert.ok(prices.startsWith('const LEGACY_REFERENCE_PRICE =') && calculation.startsWith('function referenceValue('));
const value = vm.runInNewContext(`${prices}\n${calculation}\nreferenceValue`);
const flash = 'cline-pass/deepseek-v4.1-flash';
const usage = { inputTokens: 10, outputTokens: 2, cachedTokens: 3 };
const at = (timestamp, model = flash, tokens = usage) => value(model, tokens, Date.parse(timestamp));

// Compare exact integers, not cross-realm object prototypes.
function amount(timestamp, expected) {
  const result = at(timestamp);
  assert.equal(result.lowPicoUsd, expected, timestamp);
  assert.equal(result.highPicoUsd, expected, timestamp);
}

test('v3 selects both UTC weekday windows at terminal success, ignoring holidays', () => {
  for (const [time, expected] of [
    ['2026-09-28T00:59:59.999Z',2259000],['2026-09-28T01:00:00.000Z',4518000],
    ['2026-09-28T03:59:59.999Z',4518000],['2026-09-28T04:00:00.000Z',2259000],
    ['2026-09-28T05:59:59.999Z',2259000],['2026-09-28T06:00:00.000Z',4518000],
    ['2026-09-28T09:59:59.999Z',4518000],['2026-09-28T10:00:00.000Z',2259000],
    ['2026-10-02T09:59:59.999Z',4518000],['2026-10-03T01:00:00.000Z',2259000],
    ['2026-10-04T06:00:00.000Z',2259000],['2026-10-05T01:00:00.000Z',4518000],
    ['2026-10-01T01:00:00.000Z',4518000], // Chinese public holiday: deliberately not exempted.
  ]) amount(time,expected);
  // A stream can begin off-peak and finish at the boundary: only the terminal ts matters.
  amount('2026-09-28T00:59:59.999Z',2259000);
  amount('2026-09-28T01:00:00.000Z',4518000);
});

test('reference amount preserves unknown, explicit zero, fixed tariffs and overflow', () => {
  assert.equal(at('2026-09-28T01:00:00Z',flash,{...usage,cachedTokens:null}),null);
  assert.equal(at('2026-09-28T01:00:00Z',flash,{...usage,cachedTokens:11}),null);
  assert.equal(at('2026-09-28T01:00:00Z','cline-pass/qwen3.7-plus',usage),null);
  assert.equal(at('2026-09-28T01:00:00Z','unpriced',usage),null);
  assert.equal(at('2026-09-28T01:00:00Z',flash,{inputTokens:0,outputTokens:0,cachedTokens:0}).lowPicoUsd,0);
  assert.equal(at('2026-09-28T01:00:00Z','cline-pass/kimi-k3',usage).lowPicoUsd,
    at('2026-09-28T10:00:00Z','cline-pass/kimi-k3',usage).lowPicoUsd);
  assert.equal(at('2026-09-28T01:00:00Z',flash,{inputTokens:Number.MAX_SAFE_INTEGER,outputTokens:0,cachedTokens:0}).lowPicoUsd,null);
  assert.doesNotMatch(calculation,/minuteBuckets|priceVersions|holidayLookup/,'per-request pricing never scans history or a calendar');
});
