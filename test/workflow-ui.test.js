import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { defaultAccountWorkflow } from '../lib/account-workflow.js';

const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
function harness() {
  const elements = new Map(), calls = [];
  const el = id => {
    if (!elements.has(id)) elements.set(id, { value: '', checked: false, hidden: false, disabled: false, style: {}, textContent: '', innerHTML: '', attrs: {}, listeners: {},
      setAttribute(key, value) { this.attrs[key] = value; }, addEventListener(key, value) { this.listeners[key] = value; }, focus() { this.focused = true; }, showModal() { this.open = true; }, close() { this.open = false; } });
    return elements.get(id);
  };
  const context = vm.createContext({ document: { querySelector: el, addEventListener() {}, activeElement: null }, window: { addEventListener() {} }, localStorage: { getItem() { return ''; } }, fetch() { return new Promise(() => {}); }, setTimeout() { return 1; }, clearTimeout() {}, confirm: () => true, AbortController, URL, URLSearchParams, console });
  const run = code => vm.runInContext(code, context);
  run(script);
  context.fixture = { mode: 'sticky', active: 0, concurrencyWaitMs: 1000, poolFullWaitMs: null, errorRules: [], retryRules: [],
    configurationRevision: '1'.repeat(64), accountWorkflow: defaultAccountWorkflow(), selectionCounters: { persistent: true, persistenceError: false },
    accountPipeline: { quotaPool: true, healthSort: true, sticky: true, order: ['healthSort', 'quotaPool', 'sticky'], cachePoolSize: 3, cachePoolMaxSize: 10, cachePoolLowQuotaSize: 0, sessionBindingExplicitTtlMs: 7200000, sessionBindingFallbackTtlMs: 900000, sessionBindingMaxEntries: 50000 },
    cachePool: { targetSize: 3 }, accounts: [0, 1, 2].map(i => ({ id: `a${i}`, clientKeyId: i === 2 ? 'team' : 'legacy', name: i ? `Account ${i}` : '<img src=x onerror=alert(1)>', key: `fixture-secret-${i}`, note: 'preserve', enabled: true, maxConcurrent: 7, maxRpm: 0, headers: { 'X-Fixture': 'keep' }, perModel: { model: { upstreams: ['one'] } }, activeCount: 0, selectionCount: i + 1, health: { successRate: null, samples: 0 }, cachePoolRole: 'active' })) };
  context.calls = calls;
  el('#pipelineSteps').children = ['healthSort', 'quotaPool', 'sticky'].map(step => ({ dataset: { pipelineStep: step } }));
  run("ACCS=fixture;CLIENT_KEYS=[{id:'legacy',name:'Legacy'},{id:'team',name:'Team'}]; $('#accMode').value='sticky';$('#monthlyQuotaThreshold').value='0.20';$('#concurrencyWaitMs').value='1000';$('#poolFullWaitMs').value=''; for(const [key,id] of Object.entries(PIPELINE_NUMBER_CONTROLS))$('#'+id).value=String(fixture.accountPipeline[key]); for(const [key,id] of Object.entries(RAW_PIPELINE_CONTROLS))$('#'+id).checked=fixture.accountPipeline[key]; hydrateErrorRuleDraft([]);hydrateRetryRuleDraft([]); hydrateAccountWorkflow(fixture,{force:true}); api=async(path,body)=>{calls.push({path,body});return {ok:false,error:{message:'fixture'}}};");
  el('#accMode').options = ['single', 'roundrobin', 'sticky', 'least-connections', 'weighted-roundrobin', 'priority-failover', 'load-health'].map(value => ({ value }));
  return { context, el, run, calls, value: code => JSON.parse(run(`JSON.stringify(${code})`)) };
}

test('guided graph has fixed system guards, real binding branches and draft-only edits', () => {
  const h = harness();
  h.run("updateWorkflowField('enabled',true)");
  assert.equal(h.run('WORKFLOW_DRAFT.enabled'), true);
  assert.equal(h.context.fixture.accountWorkflow.enabled, false);
  assert.equal(h.calls.length, 0);
  assert.match(h.el('#workflowCanvas').innerHTML, /绑定命中|命中绑定/);
  assert.match(h.el('#workflowCanvas').innerHTML, /计数/);
  assert.match(h.el('#workflowCanvas').innerHTML, /data-workflow-system/);
  assert.match(h.el('#workflowStatus').textContent, /未保存|草稿/);
  assert.match(html, /id="workflowStatus"[^>]*aria-live="polite"/);
});

test('workflow filter order supports keyboard moves and rejects system-node dragging', () => {
  const h = harness();
  h.run("moveWorkflowStep('health',-1)");
  assert.deepEqual(h.value('WORKFLOW_DRAFT.missSteps'), ['health', 'quota']);
  assert.equal(h.el('#workflowNode-health').focused, true);
  const before = h.value('WORKFLOW_DRAFT');
  h.run("moveWorkflowStep('authentication',1)");
  assert.deepEqual(h.value('WORKFLOW_DRAFT'), before);
  assert.match(h.el('#workflowCanvas').innerHTML, /上移|下移/);
  assert.match(html, /workflow-layout/);
});

test('workflow unknown-health copy and counter table never expose keys or raw account HTML', () => {
  const h = harness();
  h.run("updateWorkflowField('enabled',true); selectWorkflowNode('health')");
  assert.match(h.el('#workflowProperties').innerHTML, /100%/);
  assert.match(h.el('#workflowCounterBody').innerHTML, /未采样/);
  assert.match(h.el('#workflowCounterBody').innerHTML, /&lt;img/);
  assert.doesNotMatch(h.el('#workflowCounterBody').innerHTML, /fixture-secret|<img/);
});

test('health filter offers20% by default and upgrades an old zero draft only when enabled', () => {
  const h = harness();
  h.run("selectWorkflowNode('health')");
  assert.match(h.el('#workflowProperties').innerHTML, /value="20"/);
  h.run("updateWorkflowField('minimumHealth',0); updateWorkflowField('healthFilter',true)");
  assert.equal(h.run('collectAccountWorkflow().minimumHealth'), .2);
  h.run("updateWorkflowField('minimumHealth',.35); updateWorkflowField('healthFilter',false); updateWorkflowField('healthFilter',true)");
  assert.equal(h.run('collectAccountWorkflow().minimumHealth'), .35);
  assert.equal(h.calls.length, 0, 'editing the threshold does not save until the explicit action');
  h.run("updateWorkflowField('unknownHealth','unknown-last'); renderWorkflowCounters()");
  assert.match(h.el('#workflowCounterBody').innerHTML, /筛选100% · 健康优先靠后/);
  const markup = h.run("workflowTraceMarkup({kind:'new-selection',counted:true,countBefore:0,countAfter:1,nodes:[{node:'binding',result:'invalidated'},{node:'health',result:'filtered',minimumHealth:.2,before:2,after:1}]})");
  assert.match(markup, /绑定已失格，重新选号/);
  assert.match(markup, /阈值 20%/);
});

test('invalid workflow numeric drafts stay visible and prevent writes', async () => {
  const h = harness();
  h.run("updateWorkflowField('enabled',true); updateWorkflowField('minimumHealth','')");
  assert.throws(() => h.run('collectAccountWorkflow()'));
  assert.equal(h.run('WORKFLOW_DRAFT.minimumHealth'), '');
  await h.run('saveAccounts()'); assert.equal(h.calls.length, 0);
  h.run("updateWorkflowField('minimumHealth',.8)");
  assert.equal(h.run('collectAccountWorkflow().minimumHealth'), .8);
});

test('workflow save includes revision and preserves account fields; conflict keeps the draft', async () => {
  const h = harness();
  h.run("updateWorkflowField('enabled',true); api=async(path,body)=>{calls.push({path,body});return {ok:false,error:{message:'configuration changed'}}}");
  await h.run('saveAccounts()');
  assert.equal(h.calls.length, 1, h.el('#accMsg').textContent);
  const payload = h.calls[0].body;
  assert.equal(payload.accountWorkflow.selector, 'least-selections');
  assert.equal(payload.expectedConfigurationRevision, '1'.repeat(64));
  assert.equal(payload.accounts[0].note, 'preserve'); assert.equal(payload.accounts[0].headers['X-Fixture'], 'keep');
  assert.equal(payload.accounts[0].perModel.model.upstreams[0], 'one');
  assert.equal(h.run('WORKFLOW_DRAFT.enabled'), true);
  assert.match(h.el('#accMsg').textContent, /configuration changed/);
});

test('stale workflow preview cannot overwrite a newer edit or change counters', async () => {
  const h = harness();
  h.context.promise = new Promise(resolve => { h.context.resolvePreview = resolve; });
  h.run("updateWorkflowField('enabled',true); api=async(path,body)=>{calls.push({path,body});return promise}");
  const before = h.value('ACCS.accounts.map(a=>a.selectionCount)');
  const pending = h.run('previewAccountWorkflowDraft()');
  await Promise.resolve();
  h.run("updateWorkflowField('selector','least-connections')");
  h.context.resolvePreview({ simulation: true, selectedAccountName: 'STALE', decision: { kind: 'new-selection', accountId: 'a0', counted: true, countBefore: 1, countAfter: 2, nodes: [] } });
  await pending;
  assert.doesNotMatch(h.el('#workflowPreviewResult').innerHTML, /STALE/);
  assert.deepEqual(h.value('ACCS.accounts.map(a=>a.selectionCount)'), before);
});

test('counter reset requires explicit confirmation and does not discard an unsaved workflow', async () => {
  const h = harness();
  h.context.confirm = () => false;
  await h.run('resetAccountSelectionCounts()'); assert.equal(h.calls.length, 0);
  h.context.confirm = () => true;
  h.run("updateWorkflowField('selector','least-connections'); api=async(path,body)=>{calls.push({path,body});return path.endsWith('reset-counts')?{ok:true,resetAccounts:2}: {...fixture,accounts:fixture.accounts.map(a=>({...a,selectionCount:a.clientKeyId==='legacy'?0:a.selectionCount}))};}");
  await h.run('resetAccountSelectionCounts()');
  assert.equal(h.calls[0].body.clientKeyId, 'legacy');
  assert.equal(h.calls[0].body.expectedConfigurationRevision, '1'.repeat(64));
  assert.equal(h.run('WORKFLOW_DRAFT.selector'), 'least-connections');
  assert.deepEqual(h.value('ACCS.accounts.map(a=>a.selectionCount)'), [0, 0, 3]);
});

test('workflow hydration does not silently overwrite a dirty draft with another saved version', () => {
  const h = harness(); h.run("updateWorkflowField('selector','health')");
  h.context.newSnapshot = { ...h.context.fixture, configurationRevision: '2'.repeat(64), accountWorkflow: { ...defaultAccountWorkflow(), selector: 'roundrobin' } };
  h.run('hydrateAccountWorkflow(newSnapshot)');
  assert.equal(h.run('WORKFLOW_DRAFT.selector'), 'health');
  assert.equal(h.run('WORKFLOW_CONFIGURATION_REVISION'), '1'.repeat(64));
  assert.match(h.el('#workflowStatus').textContent, /变化|冲突|重新载入/);
});

test('counter reset confirmation uses saved membership rather than unsaved account rows', async () => {
  const h = harness(); const messages = [];
  h.context.confirm = message => { messages.push(message); return false; };
  h.run("ACCS.accounts.splice(0,1); ACCS.accounts.push({name:'Unsaved',clientKeyId:'legacy',key:'local-draft'}); renderWorkflowCounters()");
  await h.run('resetAccountSelectionCounts()');
  assert.match(messages[0], /2个账号/);
  assert.doesNotMatch(h.el('#workflowCounterBody').innerHTML, /Unsaved|local-draft/);
  assert.match(h.el('#workflowCounterBody').innerHTML, /&lt;img/);
});

test('showing login invalidates pending workflow reads', async () => {
  const h = harness();
  h.context.promise = new Promise(resolve => { h.context.resolvePreview = resolve; });
  h.run("updateWorkflowField('enabled',true); api=async()=>promise");
  const pending = h.run('previewAccountWorkflowDraft()'); await Promise.resolve();
  h.run('showLogin()');
  h.context.resolvePreview({ simulation: true, decision: { kind: 'new-selection', accountId: 'PRIVATE-LATE', counted: true, countBefore: 1, countAfter: 2, nodes: [] } });
  await pending;
  assert.doesNotMatch(h.el('#workflowPreviewResult').innerHTML, /PRIVATE-LATE/);
});


test('reset success remains explicit if its refresh fails', async () => {
  const h = harness();
  h.run("api=async(path)=>{if(path.endsWith('reset-counts'))return {ok:true,resetAccounts:2};throw Error('network failed');}");
  await h.run('resetAccountSelectionCounts()');
  assert.match(h.el('#workflowCounterStatus').textContent, /已重置.*刷新失败.*不要重复/);
});

test('guided mode disables the legacy preset action as well as its picker', () => {
  const h = harness(); h.run("updateWorkflowField('enabled',true)");
  assert.equal(h.el('#accountPresetPreview').disabled, true);
});


test('pending count reset stays disabled through workflow redraw and cannot reenter', async () => {
  const h = harness(); let finish;
  h.context.promise = new Promise(resolve => { finish = resolve; });
  h.run("api=async(path,body)=>{calls.push({path,body});return promise}");
  const pending = h.run('resetAccountSelectionCounts()'); await Promise.resolve();
  assert.equal(h.el('#workflowResetCounts').disabled, true);
  h.run("updateWorkflowField('selector','health')");
  assert.equal(h.el('#workflowResetCounts').disabled, true);
  await h.run('resetAccountSelectionCounts()'); assert.equal(h.calls.length, 1);
  finish({ok:false,error:{message:'fixture failed'}}); await pending;
  assert.equal(h.el('#workflowResetCounts').disabled, false);
});

test('clean refresh adopts new workflow context instead of creating a false conflict', () => {
  const h = harness(); assert.equal(h.run('workflowDirty()'), false);
  h.context.newSnapshot = {...h.context.fixture,configurationRevision:'2'.repeat(64)};
  h.el('#cachePoolSize').value='4';
  h.run('hydrateAccountWorkflow(newSnapshot,{wasDirty:false})');
  assert.equal(h.run('WORKFLOW_CONFLICT'), false);
  assert.equal(h.run('WORKFLOW_CONFIGURATION_REVISION'), '2'.repeat(64));
  assert.equal(h.run('workflowDirty()'), false);
});
