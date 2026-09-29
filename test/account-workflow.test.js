import test from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultAccountWorkflow, normalizeAccountWorkflow, normalizeSelectionCounters,
  effectiveRoutingHealth, rankWorkflowCandidates,
} from '../lib/account-workflow.js';

test('workflow defaults preserve legacy routing and expose optimistic account health', () => {
  const flow = defaultAccountWorkflow();
  assert.equal(flow.version, 1);
  assert.equal(flow.enabled, false);
  assert.equal(flow.bindingEnabled, true);
  assert.equal(flow.selector, 'least-selections');
  assert.equal(flow.unknownHealth, 'optimistic');
  assert.equal(flow.healthFilter, false);
  assert.deepEqual(flow.missSteps, ['quota', 'health']);
  flow.missSteps.reverse();
  assert.deepEqual(defaultAccountWorkflow().missSteps, ['quota', 'health']);
});

test('workflow rejects illegal steps and malformed fields without mutating input', () => {
  const draft = { ...defaultAccountWorkflow(), enabled: true, missSteps: ['health', 'quota'], minimumHealth: .8 };
  const before = structuredClone(draft);
  assert.deepEqual(normalizeAccountWorkflow(draft), draft);
  assert.deepEqual(draft, before);
  for (const patch of [
    { version: 2 }, { enabled: 'true' }, { bindingEnabled: 1 }, { selector: 'eval' },
    { unknownHealth: 'zero' }, { onBindingBusy: 'loop' }, { minimumHealth: -1 },
    { minimumHealth: 101 }, { minimumHealth: NaN }, { missSteps: ['health', 'health'] },
    { missSteps: ['auth', 'health'] }, { missSteps: ['quota'] }, { hidden: true },
  ]) assert.throws(() => normalizeAccountWorkflow({ ...draft, ...patch }));
  assert.throws(() => normalizeAccountWorkflow(null));
});

test('unknown routing health100 does not invent observed statistics', () => {
  const candidate = { id: 'new', healthRate: null, successes: 0, samples: 0 };
  assert.equal(effectiveRoutingHealth(candidate.healthRate, 'optimistic'), 1);
  assert.equal(effectiveRoutingHealth(candidate.healthRate, 'unknown-last'), null);
  assert.equal(effectiveRoutingHealth(.37, 'optimistic'), .37);
  assert.deepEqual(candidate, { id: 'new', healthRate: null, successes: 0, samples: 0 });
});

test('minimum selection count dominates health and current load', () => {
  const rows = [{ id: 'a', healthRate: 1 }, { id: 'b', healthRate: .2 }, { id: 'c', healthRate: null }];
  const counts = { a: { count: 9 }, b: { count: 0 }, c: { count: 2 } };
  const activeCounts = new Map([['a', 0], ['b', 3], ['c', 1]]);
  const ranked = rankWorkflowCandidates(rows, { selector: 'least-selections', counts, activeCounts, cursor: 0, unknownHealth: 'optimistic' });
  assert.deepEqual(ranked.map(r => r.id), ['b', 'c', 'a']);
  assert.deepEqual(rows.map(r => r.id), ['a', 'b', 'c']);
  assert.equal(counts.a.count, 9);
});

test('equal minimum counts prefer idle accounts then stable rotation', () => {
  const rows = [{ id: 'c', healthRate: null }, { id: 'a', healthRate: .5 }, { id: 'b', healthRate: 1 }];
  const options = { selector: 'least-selections', counts: {}, activeCounts: new Map([['a', 6]]), cursor: 0, unknownHealth: 'optimistic' };
  assert.deepEqual(rankWorkflowCandidates(rows, options).map(r => r.id), ['b', 'c', 'a']);
  assert.deepEqual(rankWorkflowCandidates(rows, { ...options, activeCounts: new Map(), cursor: 1 }).map(r => r.id), ['b', 'c', 'a']);
});

test('count choices distribute equal available accounts and never count the preview itself', () => {
  const rows = Array.from({ length: 18 }, (_, i) => ({ id: `a${String(i).padStart(2, '0')}`, healthRate: null }));
  const counts = {};
  for (let i = 0; i < 181; i++) {
    const ranked = rankWorkflowCandidates(rows, { selector: 'least-selections', counts, activeCounts: new Map(), cursor: i, unknownHealth: 'optimistic' });
    const id = ranked[0].id;
    counts[id] = { count: (counts[id]?.count || 0) + 1 };
  }
  const values = Object.values(counts).map(x => x.count);
  assert.equal(values.reduce((a, b) => a + b, 0), 181);
  assert.equal(Math.max(...values) - Math.min(...values), 1);
  const before = structuredClone(counts);
  rankWorkflowCandidates(rows, { selector: 'least-selections', counts, activeCounts: new Map(), cursor: 0, unknownHealth: 'optimistic' });
  assert.deepEqual(counts, before);
});

test('other picker modes remain distinct and health unknown policy is explicit', () => {
  const rows = [{ id: 'a', healthRate: .9 }, { id: 'b', healthRate: null }, { id: 'c', healthRate: .2 }];
  const base = { counts: {}, activeCounts: new Map([['a', 1], ['b', 5], ['c', 0]]), cursor: 0, unknownHealth: 'optimistic' };
  assert.equal(rankWorkflowCandidates(rows, { ...base, selector: 'health' })[0].id, 'b');
  assert.equal(rankWorkflowCandidates(rows, { ...base, selector: 'health', unknownHealth: 'unknown-last' })[0].id, 'a');
  assert.equal(rankWorkflowCandidates(rows, { ...base, selector: 'least-connections' })[0].id, 'c');
  assert.equal(rankWorkflowCandidates(rows, { ...base, selector: 'roundrobin', cursor: 1 })[0].id, 'b');
});

test('persistent counters preserve stable IDs, prune only removed IDs and reject corruption', () => {
  assert.deepEqual(normalizeSelectionCounters(undefined, new Set(['a'])), { version: 1, sequence: 0, accounts: {} });
  const stored = { version: 1, sequence: 15, accounts: { a: { count: 12, lastSelected: 15 }, gone: { count: 1, lastSelected: 1 } } };
  const result = normalizeSelectionCounters(stored, new Set(['a', 'new']));
  assert.deepEqual(result, { version: 1, sequence: 15, accounts: { a: { count: 12, lastSelected: 15 } } });
  assert.ok(stored.accounts.gone);
  for (const value of [null, { ...stored, version: 2 }, { ...stored, sequence: -1 },
    { ...stored, accounts: { a: { count: -1, lastSelected: 0 } } },
    { ...stored, accounts: { a: { count: 2 ** 53, lastSelected: 0 } } },
    { ...stored, accounts: { a: { count: 1, lastSelected: 0, injected: true } } },
  ]) assert.throws(() => normalizeSelectionCounters(value, new Set(['a'])));
});

test('special stable IDs never mutate object prototypes', () => {
  const raw = JSON.parse('{"version":1,"sequence":1,"accounts":{"__proto__":{"count":1,"lastSelected":1}}}');
  const state = normalizeSelectionCounters(raw, new Set(['__proto__']));
  assert.ok(Object.hasOwn(state.accounts, '__proto__'));
  assert.equal(Object.getPrototypeOf(state.accounts), Object.prototype);
  assert.equal({}.count, undefined);
});
