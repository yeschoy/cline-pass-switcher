// Pure contracts for the guided account-selection path. Runtime leases stay in server.js.
export const WORKFLOW_SELECTORS = Object.freeze(['least-selections', 'roundrobin', 'least-connections', 'health']);
const BUSY_ACTIONS = new Set(['overflow', 'wait-overflow', 'reject']);
const UNKNOWN_POLICIES = new Set(['optimistic', 'unknown-last']);
const plain = value => !!value && typeof value === 'object' && !Array.isArray(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const own = (value, key) => Object.hasOwn(value, key);

export function defaultAccountWorkflow() {
  return {
    version: 1, enabled: false, bindingEnabled: true, onBindingBusy: 'overflow',
    missSteps: ['quota', 'health'], quotaFilter: true, quotaPools: ['hot', 'warm', 'unknown'], healthFilter: false,
    minimumHealth: 0.2, unknownHealth: 'optimistic', selector: 'least-selections',
  };
}

export function normalizeAccountWorkflow(value) {
  const defaults = defaultAccountWorkflow();
  if (value === undefined) return defaults;
  if (!plain(value)) throw new Error('accountWorkflow must be an object');
  if (Object.keys(value).some(key => !own(defaults, key))) throw new Error('accountWorkflow contains an unknown field');
  const out = { ...defaults, ...value };
  if (out.version !== 1) throw new Error('unsupported accountWorkflow version');
  for (const key of ['enabled', 'bindingEnabled', 'quotaFilter', 'healthFilter']) {
    if (typeof out[key] !== 'boolean') throw new Error(`accountWorkflow.${key} must be boolean`);
  }
  if (!BUSY_ACTIONS.has(out.onBindingBusy)) throw new Error('invalid accountWorkflow.onBindingBusy');
  if (!WORKFLOW_SELECTORS.includes(out.selector)) throw new Error('invalid accountWorkflow.selector');
  if (!UNKNOWN_POLICIES.has(out.unknownHealth)) throw new Error('invalid accountWorkflow.unknownHealth');
  if (typeof out.minimumHealth !== 'number' || !Number.isFinite(out.minimumHealth) || out.minimumHealth < 0 || out.minimumHealth > 1) throw new Error('accountWorkflow.minimumHealth must be from0 to1');
  if (!Array.isArray(out.quotaPools) || !out.quotaPools.length || out.quotaPools.length > 3 || new Set(out.quotaPools).size !== out.quotaPools.length || out.quotaPools.some(pool => !['hot', 'warm', 'unknown'].includes(pool))) throw new Error('accountWorkflow.quotaPools must contain distinct active quota roles');
  if (!Array.isArray(out.missSteps) || out.missSteps.length !== 2 || new Set(out.missSteps).size !== 2 || out.missSteps.some(step => !['quota', 'health'].includes(step))) throw new Error('accountWorkflow.missSteps must contain quota and health exactly once');
  out.missSteps = [...out.missSteps];
  out.quotaPools = [...out.quotaPools];
  return out;
}

export function effectiveRoutingHealth(observed, policy = 'optimistic') {
  if (!UNKNOWN_POLICIES.has(policy)) throw new Error('invalid unknown health policy');
  if (observed === null || observed === undefined) return policy === 'optimistic' ? 1 : null;
  if (typeof observed !== 'number' || !Number.isFinite(observed) || observed < 0 || observed > 1) throw new Error('invalid observed account health');
  return observed;
}

export function normalizeSelectionCounters(value, validIds) {
  if (value === undefined) return { version: 1, sequence: 0, accounts: {} };
  if (!plain(value) || value.version !== 1 || !integer(value.sequence) || !plain(value.accounts) || Object.keys(value).some(key => !['version', 'sequence', 'accounts'].includes(key))) throw new Error('invalid selectionCounters state');
  const accounts = {};
  if (Object.keys(value.accounts).length > 100000) throw new Error('selectionCounters exceeds account bound');
  for (const [id, row] of Object.entries(value.accounts)) {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(id) || !plain(row) || Object.keys(row).length !== 2 || !own(row, 'count') || !own(row, 'lastSelected') || !integer(row.count) || !integer(row.lastSelected) || row.lastSelected > value.sequence) throw new Error('invalid selectionCounters account entry');
    if (!validIds.has(id)) continue;
    Object.defineProperty(accounts, id, { value: { count: row.count, lastSelected: row.lastSelected }, enumerable: true, configurable: true, writable: true });
  }
  return { version: 1, sequence: value.sequence, accounts };
}

export function rankWorkflowCandidates(candidates, {
  selector = 'least-selections', counts = {}, activeCounts = new Map(), cursor = 0,
  unknownHealth = 'optimistic',
} = {}) {
  if (!WORKFLOW_SELECTORS.includes(selector)) throw new Error('invalid workflow selector');
  const stable = [...candidates].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  if (!stable.length) return stable;
  const start = integer(cursor) ? cursor % stable.length : 0;
  const rotated = [...stable.slice(start), ...stable.slice(0, start)];
  const position = new Map(rotated.map((row, index) => [row.id, index]));
  const count = id => {
    const row = counts instanceof Map ? counts.get(id) : own(counts, id) ? counts[id] : undefined;
    if (row === undefined) return 0;
    if (!plain(row) || !integer(row.count)) throw new Error('invalid workflow selection count');
    return row.count;
  };
  const active = id => activeCounts.get(id) || 0;
  const health = row => effectiveRoutingHealth(row.healthRate, unknownHealth) ?? -1;
  return rotated.sort((left, right) => {
    let order = 0;
    if (selector === 'least-selections') order = count(left.id) - count(right.id) || active(left.id) - active(right.id);
    else if (selector === 'least-connections') order = active(left.id) - active(right.id);
    else if (selector === 'health') order = health(right) - health(left) || active(left.id) - active(right.id);
    return order || position.get(left.id) - position.get(right.id);
  });
}
