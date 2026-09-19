import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const script = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
const DEFAULT_PIPELINE_ORDER = ['excludeUnhealthy','quotaPool','healthSort','sticky'];
const fixture = () => ({mode:'single', active:1, concurrencyWaitMs:2000, accountErrorRules:{}, accountPipeline:{cachePoolSize:0,order:[...DEFAULT_PIPELINE_ORDER]}, accounts:[0,1,2].map(i => ({id:`id${i}`, name:i < 2 ? 'duplicate <name>' : 'other', note:`note${i}`, key:`fake${i}`, enabled:i !== 1, maxConcurrent:i+1, weight:i+1, priority:10+i, proxyUrl:'http://localhost:1234', headers:{'X-Test':'fixture'}, perModel:{model:{upstreams:['mock']}}, activeCount:0, cachePoolRole:i===0?'active':i===1?'standby':null}))});
function harness() {
  const elements = new Map(), calls = [], timers = new Map(), windowListeners = {};
  let timerId = 0;
  const el = id => { if (!elements.has(id)) elements.set(id, {value:'',checked:false,hidden:false,disabled:false,style:{},attrs:{},textContent:'',innerHTML:'',listeners:{},setAttribute(name,value){this.attrs[name]=value;},addEventListener(name,fn){this.listeners[name]=fn;},focus(){this.focused=true;},showModal(){this.open=true;},close(){this.open=false;}}); return elements.get(id); };
  const context = vm.createContext({document:{querySelector:el,addEventListener(){},activeElement:null},window:{addEventListener(name,fn){windowListeners[name]=fn;}},localStorage:{getItem(){return '';}},fetch:(...args)=>{calls.push(args);return new Promise(()=>{});},setTimeout(fn,ms){const id=++timerId;timers.set(id,{fn,ms});return id;},clearTimeout(id){timers.delete(id);},confirm:()=>true,AbortController,URL,URLSearchParams,console});
  const run = code => vm.runInContext(code, context);
  run(script); calls.length = 0;
  const pipelineList=el('#pipelineSteps');
  const classList=()=>{const values=new Set();return{add(...names){for(const name of names)values.add(name);},remove(...names){for(const name of names)values.delete(name);},contains(name){return values.has(name);}};};
  pipelineList.children=DEFAULT_PIPELINE_ORDER.map((step,index)=>{const position={textContent:String(index+1),attrs:{},setAttribute(name,value){this.attrs[name]=value;}},button=()=>({disabled:false,focusCalls:0,focus(){if(!this.disabled){this.focused=true;this.focusCalls++;}}}),up=button(),down=button();return{dataset:{pipelineStep:step},attrs:{},classList:classList(),position,up,down,setAttribute(name,value){this.attrs[name]=value;},querySelector(selector){return selector==='.pipeline-position'?position:selector==='.pipeline-move-up'?up:selector==='.pipeline-move-down'?down:null;},getBoundingClientRect(){return{top:0,height:20};}};});
  pipelineList.appendChild=node=>{const index=pipelineList.children.indexOf(node);if(index>=0)pipelineList.children.splice(index,1);pipelineList.children.push(node);return node;};
  el('#accMode').options = ['single','roundrobin','sticky','least-connections','weighted-roundrobin','priority-failover'].map(value=>({value}));
  context.snapshot = fixture();
  run("ACCS = snapshot; $('#accMode').value='single'; $('#concurrencyWaitMs').value='2000'; $('#cachePoolSize').value='0'; $('#accountErrorRules').value='{}'; renderAccounts();");
  const snapshot = () => JSON.parse(run('JSON.stringify(ACCS)'));
  return {run,el,calls,snapshot,context,timers,windowListeners,pipelineList};
}

test('bulk assignment is atomic, target-only, draft-only and independent of active radio', () => {
  const h = harness(), before = h.snapshot();
  h.run('selectAccount(0,true); selectAccount(1,true)');
  assert.match(h.el('#bulkSummary').textContent, /已选择 2 个账号/);
  assert.equal(h.el('#bulkSelectAll').indeterminate,true);
  assert.match(h.el('#accBody').innerHTML, /批量选择 duplicate &lt;name&gt;/);
  for (const invalid of ['', ' ', '1.5','-1','100001','NaN','Infinity','1e999']) {
    h.el('#bulkConcurrency').value = invalid; h.run('applyBulkConcurrency()');
    assert.deepEqual(h.snapshot(),before);
  }
  for (const valid of ['0','100000']) {
    h.el('#bulkConcurrency').value = valid; h.run('applyBulkConcurrency()');
    const expected = structuredClone(before); expected.accounts[0].maxConcurrent = expected.accounts[1].maxConcurrent = Number(valid);
    assert.deepEqual(h.snapshot(),expected);
  }
  assert.equal(h.calls.length,0);
  assert.match(h.el('#bulkFeedback').textContent,/尚未生效/);
});

test('search/select-all, empty selection, rename, deletion and unsaved objects cannot retarget', () => {
  const h = harness();
  h.el('#accSearch').value='note1'; h.run('clearBulkSelection(); selectAllAccounts(true)');
  assert.equal(h.run('BULK_SELECTION.size'),1);
  h.el('#bulkConcurrency').value='9'; h.run('applyBulkConcurrency()');
  assert.deepEqual(h.snapshot().accounts.map(a=>a.maxConcurrent),[1,9,3]);
  h.el('#accSearch').value='other'; h.run('clearBulkSelection()');
  assert.equal(h.run('BULK_SELECTION.size'),0);
  h.run('applyBulkConcurrency()'); assert.deepEqual(h.snapshot().accounts.map(a=>a.maxConcurrent),[1,9,3]);
  h.run("selectAllAccounts(true); ACCS.accounts[2].name='renamed'; renderAccounts()");
  assert.equal(h.run('BULK_SELECTION.size'),0);
  h.el('#accSearch').value=''; h.run('clearBulkSelection(); selectAccount(0,true); delAccount(0)');
  assert.equal(h.run('BULK_SELECTION.size'),0);
  h.run('addAccountRow(); selectAccount(2,true)');
  assert.equal(h.run('BULK_SELECTION.has(ACCS.accounts[2])'),true);
  h.run('applyBulkConcurrency()'); assert.equal(h.snapshot().accounts[2].maxConcurrent,9);
  h.el('#accSearch').value='no matches'; h.run('clearBulkSelection(); selectAllAccounts(true); applyBulkConcurrency()');
  assert.equal(h.el('#bulkApply').disabled,true); assert.equal(h.el('#bulkSelectAll').disabled,true);
  assert.match(h.el('#accBody').innerHTML,/无匹配账号/); assert.equal(h.calls.length,0);
});

test('redraw callers preserve live scheduling drafts including invalid JSON; explicit save sends complete draft', async () => {
  const h = harness();
  h.el('#accMode').value='sticky'; h.el('#concurrencyWaitMs').value='987'; h.el('#cachePoolSize').value='2'; h.el('#accountErrorRules').value='{ unfinished';
  h.el('#pipelineQuotaPool').checked=true; h.el('#pipelineSticky').checked=true;
  h.run('openAccountDrawer(0)'); h.el('#drawerNote').value='pending drawer note'; h.run('saveDrawer(); renderAccounts(); selectAccount(1,true)');
  h.el('#bulkConcurrency').value='42'; h.run('applyBulkConcurrency(); clearBulkSelection(); openAccountDrawer(0); saveDrawer()');
  assert.equal(h.snapshot().accounts[0].note,'pending drawer note');
  assert.equal(h.el('#accMode').value,'sticky'); assert.equal(h.el('#concurrencyWaitMs').value,'987'); assert.equal(h.el('#cachePoolSize').value,'2'); assert.equal(h.el('#accountErrorRules').value,'{ unfinished');
  assert.equal(h.el('#pipelineQuotaPool').checked,true); assert.equal(h.el('#pipelineSticky').checked,true);
  assert.equal(h.snapshot().active,1);
  await h.run('saveAccounts()'); assert.equal(h.calls.length,0);
  h.el('#accMode').value='single'; h.run('renderAccounts()');
  assert.match(h.el('#accBody').innerHTML,/data-i="1" checked/);
  h.el('#accountErrorRules').value='{"429":{"action":"ignore"}}';
  h.context.sent = [];
  h.run("api = async (path,body) => { sent.push({path,body}); return {ok:false,error:{message:'fixture rejection'}}; }");
  await h.run('saveAccounts()');
  const payload = JSON.parse(h.run('JSON.stringify(sent[0].body)'));
  assert.deepEqual(payload.accounts,h.snapshot().accounts.map(({activeCount,cachePoolRole,...a})=>a));
  assert.equal(payload.active,1); assert.equal(payload.concurrencyWaitMs,987);
  assert.deepEqual(payload.accountErrorRules,{'429':{action:'ignore'}});
  assert.deepEqual(payload.accountPipeline,{quotaPool:true,excludeUnhealthy:false,healthSort:false,sticky:true,order:DEFAULT_PIPELINE_ORDER,cachePoolSize:2});
  assert.equal(h.snapshot().accounts[1].maxConcurrent,42);
});

test('visual save and preset preview reject invalid cache pool drafts without coercion or requests', async () => {
  for (const value of ['', ' ', '-1', '1.5', '100001', 'NaN']) {
    const h=harness(),before=h.snapshot();h.el('#cachePoolSize').value=value;
    await h.run('saveAccounts()');assert.equal(h.calls.length,0,`save must reject ${JSON.stringify(value)}`);assert.deepEqual(h.snapshot(),before);assert.equal(h.el('#cachePoolSize').value,value);assert.match(h.el('#accMsg').textContent,/0–100000/);
    h.el('#preset').value='cache';h.run('previewPreset()');assert.equal(h.run('PENDING_PRESET'),null);assert.equal(h.el('#presetModal').style.display,undefined);assert.equal(h.calls.length,0);
  }
  for (const value of ['0','100000']) {
    const h=harness();h.el('#cachePoolSize').value=value;assert.equal(h.run('collectAccounts().accountPipeline.cachePoolSize'),Number(value));
  }
});

test('upstream setup proposals are deterministic, scope-guarded and save only after confirmation', async () => {
  const h=harness();
  h.run("UPSTREAM_SETUP={model:'model',accountId:'',results:{slow:{status:'ok',ms:20},fast:{status:'ok',ms:5},busy:{status:'limited',ms:1},broken:{status:'bad',ms:2},auth:{status:'unknown',accountFault:'auth',ms:1}}};");
  const cache=JSON.parse(h.run("JSON.stringify(upstreamSetupRoute('cache'))"));
  assert.deepEqual(cache,{upstreams:['fast','slow','busy'],exclude:['broken'],pinMode:'strict',sort:null});
  const available=JSON.parse(h.run("JSON.stringify(upstreamSetupRoute('available'))"));
  assert.deepEqual(available,{upstreams:['fast','slow','busy'],exclude:['broken'],pinMode:'preferred',sort:'ttft'});
  const automatic=JSON.parse(h.run("JSON.stringify(upstreamSetupRoute('automatic'))"));
  assert.deepEqual(automatic,{upstreams:[],exclude:['broken'],pinMode:'preferred',sort:null});
  h.context.saved=[];h.run("saveModelCfg=async(model,route)=>{saved.push({model,route});return true;};$('#upstreamSetupStrategy').value='cache';");
  await h.run('applyUpstreamSetup()');
  assert.deepEqual(JSON.parse(h.run('JSON.stringify(saved)')),[{model:'model',route:cache}]);
  assert.equal(h.run('UPSTREAM_SETUP'),null);assert.equal(h.el('#upstreamSetupModal').style.display,'none');

  h.run("UPSTREAM_SETUP={model:'model',accountId:'id0',results:{fast:{status:'ok',ms:1}}};$('#routeScope').value='id1';$('#upstreamSetupStrategy').value='cache';");
  await h.run('applyUpstreamSetup()');assert.equal(JSON.parse(h.run('JSON.stringify(saved)')).length,1);assert.match(h.el('#upstreamSetupStatus').textContent,/作用域已变化/);
});

test('real loadAll hydration resets controls, order and old selection on reload', async () => {
  const h = harness(); h.run("selectAllAccounts(true); movePipelineStep('sticky',-1)");
  const hydrated=fixture(); hydrated.accountPipeline.cachePoolSize=3; hydrated.accountPipeline.order=['sticky','healthSort','quotaPool','excludeUnhealthy'];
  h.context.responses = {'/api/models':{},'/api/accounts':hydrated,'/api/security':{},'/api/meta':{configured:true},'/api/model-aliases':{aliases:{}}};
  // Model rendering is unrelated to the account hydration boundary.
  h.run('render = () => {}; api = async path => responses[path]');
  h.el('#accountErrorRules').value='invalid draft'; h.el('#accMode').value='sticky';
  await h.run('loadAll()');
  assert.equal(h.run('BULK_SELECTION.size'),0); assert.equal(h.el('#accMode').value,'single'); assert.equal(Number(h.el('#cachePoolSize').value),3);
  assert.equal(h.el('#accountErrorRules').value,'{}'); assert.equal(h.el('#bulkApply').disabled,true);
  assert.deepEqual(JSON.parse(h.run('JSON.stringify(pipelineOrder())')),hydrated.accountPipeline.order);
  assert.equal(h.el('#pipelineOrderStatus').textContent,'','reload clears obsolete draft-only order feedback');
});

test('keyboard pipeline reorder keeps logical focus when the activated button stays enabled or reaches a boundary', () => {
  const upBoundary=harness(),quota=upBoundary.pipelineList.children.find(item=>item.dataset.pipelineStep==='quotaPool');
  upBoundary.context.button=quota.up;upBoundary.run("movePipelineStep('quotaPool',-1,button)");
  assert.deepEqual(JSON.parse(upBoundary.run('JSON.stringify(pipelineOrder())')),['quotaPool','excludeUnhealthy','healthSort','sticky']);
  assert.equal(quota.up.disabled,true);assert.equal(quota.up.focusCalls,0,'a disabled boundary button is never focused');
  assert.equal(quota.down.disabled,false);assert.equal(quota.down.focusCalls,1,'up at first transfers focus to down in the moved row');
  upBoundary.run('setPipelineOrder(PIPELINE_DEFAULT_ORDER)');
  assert.equal(quota.down.focusCalls,1,'drag/raw/load reorder owner does not move focus without an activated button');

  const middle=harness(),middleHealth=middle.pipelineList.children.find(item=>item.dataset.pipelineStep==='healthSort');
  middle.context.button=middleHealth.up;middle.run("movePipelineStep('healthSort',-1,button)");
  assert.equal(middleHealth.up.disabled,false);assert.equal(middleHealth.up.focusCalls,1,'an enabled activated button regains focus');
  assert.equal(middleHealth.down.focusCalls,0);

  const downBoundary=harness(),lastHealth=downBoundary.pipelineList.children.find(item=>item.dataset.pipelineStep==='healthSort');
  downBoundary.context.button=lastHealth.down;downBoundary.run("movePipelineStep('healthSort',1,button)");
  assert.deepEqual(JSON.parse(downBoundary.run('JSON.stringify(pipelineOrder())')),['excludeUnhealthy','quotaPool','sticky','healthSort']);
  assert.equal(lastHealth.down.disabled,true);assert.equal(lastHealth.down.focusCalls,0,'a disabled last-position button is never focused');
  assert.equal(lastHealth.up.disabled,false);assert.equal(lastHealth.up.focusCalls,1,'down at last transfers focus to up in the moved row');
  assert.equal(upBoundary.calls.length+middle.calls.length+downBoundary.calls.length,0);
});

test('native drag and keyboard-equivalent buttons share one ordered draft with announced positions', () => {
  const h=harness(); h.run('syncPipelineOrder()');
  assert.equal(h.pipelineList.children[0].up.disabled,true); assert.equal(h.pipelineList.children.at(-1).down.disabled,true);
  h.el('#pipelineSticky').checked=false;
  h.run("movePipelineStep('sticky',-1)");
  assert.deepEqual(JSON.parse(h.run('JSON.stringify(pipelineOrder())')),['excludeUnhealthy','quotaPool','sticky','healthSort']);
  assert.equal(h.pipelineList.children[2].position.textContent,'3'); assert.match(h.el('#pipelineOrderStatus').textContent,/第 3 位/);
  h.context.dragEvent={currentTarget:h.pipelineList.children[0],dataTransfer:{effectAllowed:'',setData(){}}};
  h.run("startPipelineDrag(dragEvent,'excludeUnhealthy'); endPipelineDrag()");
  assert.deepEqual(JSON.parse(h.run('JSON.stringify(pipelineOrder())')),['excludeUnhealthy','quotaPool','sticky','healthSort']);
  assert.match(h.el('#pipelineOrderStatus').textContent,/已取消拖动.*顺序未更改/);
  h.run("startPipelineDrag(dragEvent,'excludeUnhealthy')");
  const target=h.pipelineList.children.find(item=>item.dataset.pipelineStep==='healthSort');
  h.context.dropEvent={currentTarget:target,clientY:20,dataTransfer:{dropEffect:''},preventDefault(){}};
  h.run("dropPipelineDrag(dropEvent,'healthSort')");
  assert.deepEqual(JSON.parse(h.run('JSON.stringify(pipelineOrder())')),['quotaPool','sticky','healthSort','excludeUnhealthy']);
  assert.equal(h.pipelineList.children.at(-1).position.textContent,'4'); assert.equal(h.pipelineList.children.at(-1).down.disabled,true);
  assert.equal(h.el('#pipelineSticky').checked,false,'disabled steps keep their position and state');
  assert.match(h.el('#pipelineOrderStatus').textContent,/尚未保存/); assert.equal(h.calls.length,0);
});

test('apply rechecks visible membership even without redraw and deselection updates mixed state', () => {
  const h = harness();
  h.run('selectAllAccounts(true); selectAccount(1,false)');
  assert.equal(h.el('#bulkSelectAll').checked,false); assert.equal(h.el('#bulkSelectAll').indeterminate,true);
  h.run('selectAllAccounts(false)'); assert.equal(h.run('BULK_SELECTION.size'),0);
  h.el('#accSearch').value='note0'; h.run('clearBulkSelection(); selectAllAccounts(true)');
  h.run("ACCS.accounts[0].note='hidden now'");
  const before = h.snapshot(); h.el('#bulkConcurrency').value='77'; h.run('applyBulkConcurrency()');
  assert.deepEqual(h.snapshot(),before); assert.equal(h.run('BULK_SELECTION.size'),0);
  assert.equal(h.calls.length,0);
});

test('model and account summaries render stable-id statistics without entering account save payloads', async () => {
  const h=harness();
  h.run("ACCS.accounts[0].health={status:'available',score:92.5,results:10}; ACCS.accounts[0].statistics={recent24h:{cacheTokenRatio:.25,cacheInputKnownRequests:4,errors:2},lifetimeErrors:3}; renderAccounts()");
  assert.match(h.el('#accBody').innerHTML,/25\.0%/);assert.equal((h.el('#accBody').innerHTML.match(/25\.0%/g)||[]).length,1,'duplicate names must not share ID-keyed statistics');assert.match(h.el('#accBody').innerHTML,/4 请求有数据/);assert.match(h.el('#accBody').innerHTML,/available/);assert.match(h.el('#accBody').innerHTML,/92\.5/);assert.match(h.el('#accBody').innerHTML,/2 \/ 3/);
  h.context.sent=[];h.run("api=async(path,body)=>{sent.push({path,body});return {ok:false};}; $('#accountErrorRules').value='{}'");await h.run('saveAccounts()');
  const saved=JSON.parse(h.run('JSON.stringify(sent[0].body.accounts[0])'));
  assert.equal(Object.hasOwn(saved,'statistics'),false);assert.equal(Object.hasOwn(saved,'health'),false);

  h.el('#logPanel').hidden=true;
  h.context.modelData={proxyBase:'http://example/v1',subscription:[{id:'cline-pass/model',config:{upstreams:[],exclude:[]},configSource:'global',meta:{probedAt:1,pinnable:true,pipeline:'planner',canonicalSlug:'private/model',lastProvider:'private',lastMs:10,upstreams:['private'],upstreamDiscovery:'known'},statistics:{recent24h:{cacheTokenRatio:.5,cacheInputKnownRequests:2,cacheInputCachedTokens:5,cacheInputTokens:10},coverage:{complete:false}}}],catalog:[],catalogCount:0,officialFetch:null,accountId:null};
  h.run('DATA=modelData; render()');
  assert.match(h.el('#subBody').innerHTML,/50\.0%/);assert.match(h.el('#subBody').innerHTML,/2 请求有数据/);assert.match(h.el('#subBody').innerHTML,/统计积累中/);
  h.context.zeroModelStat={recent24h:{cacheTokenRatio:0,cacheInputKnownRequests:1,cacheInputCachedTokens:0,cacheInputTokens:10},coverage:{complete:true}};
  assert.match(h.run('modelCacheMetric(zeroModelStat)'),/0\.0%/);
  h.context.unknownModelStat={recent24h:{cacheTokenRatio:null,cacheInputKnownRequests:0},coverage:{complete:true}};
  assert.match(h.run('modelCacheMetric(unknownModelStat)'),/无数据/);
});

test('quota rendering preserves known zero/full values and labels partial, stale, failed and ineligible snapshots', () => {
  const h=harness();
  h.context.known={limits:{five_hour:{percentUsed:0,resetsAt:'2026-09-15T00:00:00.000Z'},weekly:{percentUsed:100},monthly:{percentUsed:37.5}}};
  assert.match(h.run("quotaLimit(known,'five_hour','5 小时')"),/^5 小时：剩余 100\.0%/);assert.match(h.run("quotaLimit(known,'weekly','每周')"),/^每周：剩余 0\.0%/);assert.match(h.run("quotaLimit(known,'monthly','每月')"),/^每月：剩余 62\.5%/);
  assert.doesNotMatch(h.run("quotaLimit(known,'monthly','每月')"),/已用/);
  h.context.invalid={limits:{five_hour:{percentUsed:'0',resetsAt:'bad'},weekly:{percentUsed:25,resetsAt:'2026-09-15'}}};assert.equal(h.run("quotaLimit(invalid,'five_hour','5 小时')"),'5 小时：未知 · 重置时间未提供');assert.match(h.run("quotaLimit(invalid,'weekly','每周')"),/重置时间 未提供/);
  const base={health:{status:'insufficient'},quota:{status:'unknown',pool:'unknown',fetchedAt:1000,lastAttemptAt:1000,lastSuccessAt:1000,limits:{weekly:{percentUsed:25}},errorCategory:null,refresh:{eligible:true,reason:null,state:'idle',nextAttemptAt:2000}}};
  h.context.row=base;assert.match(h.run('quotaState(row,1000)'),/部分可用/);
  h.context.row={...base,quota:{...base.quota,errorCategory:'rate_limit',lastAttemptAt:1500}};assert.match(h.run('quotaState(row,1500)'),/刷新失败（限流） · 显示上次成功额度/);
  h.context.row={...base,quota:{...base.quota,fetchedAt:null,lastSuccessAt:null,lastAttemptAt:1500,limits:{},errorCategory:'network'}};assert.match(h.run('quotaState(row,1500)'),/刷新失败（网络） · 尚无成功额度/);
  h.context.row={...base,quota:{...base.quota,fetchedAt:1000,lastSuccessAt:1000,limits:{five_hour:{percentUsed:1},weekly:{percentUsed:2},monthly:{percentUsed:3}}}};assert.match(h.run(`quotaState(row,${1000+16*60*1000})`),/过期 · 上次快照/);
  h.context.row={...base,quota:{...base.quota,lastAttemptAt:1001,limits:{five_hour:{percentUsed:1},weekly:{percentUsed:2},monthly:{percentUsed:3}}}};assert.match(h.run('quotaState(row,1001)'),/过期 · 上次快照/);
  h.context.row={...base,quota:{...base.quota,refresh:{eligible:false,reason:'disabled',state:'idle',nextAttemptAt:null}}};assert.match(h.run('quotaState(row,1000)'),/已禁用 · 上次额度/);
  h.context.row={...base,quota:{status:'unknown',pool:'unknown',fetchedAt:null,lastAttemptAt:null,lastSuccessAt:null,limits:{},errorCategory:null,refresh:{eligible:false,reason:'unconfigured',state:'idle',nextAttemptAt:null}}};assert.match(h.run('quotaState(row,1000)'),/未配置/);
});

test('quota forecast sums each account minimum and applies resets at fixed target boundaries', () => {
  const h=harness(),generatedAt=Date.parse('2026-09-15T00:00:00.000Z'),at=hours=>new Date(generatedAt+hours*60*60*1000).toISOString();
  h.context.forecastData={generatedAt,accounts:[
    {enabled:true,quota:{status:'fresh',limits:{five_hour:{percentUsed:20,resetsAt:at(2)},weekly:{percentUsed:40,resetsAt:at(8)},monthly:{percentUsed:10,resetsAt:at(24)}}}},
    {enabled:true,quota:{status:'fresh',limits:{five_hour:{percentUsed:100,resetsAt:at(2)},weekly:{percentUsed:0,resetsAt:at(25)},monthly:{percentUsed:0,resetsAt:at(25)}}}}
  ]};
  const forecast=JSON.parse(h.run('JSON.stringify(statisticsQuotaForecast(forecastData))'));
  assert.deepEqual(forecast,{totals:{current:60,twoHours:160,eightHours:190,twentyFourHours:200},maximum:200,included:2,excluded:0,incompleteResets:0});
});

test('quota forecast excludes untrusted snapshots and conservatively carries incomplete resets', () => {
  const h=harness(),generatedAt=Date.parse('2026-09-15T00:00:00.000Z'),at=hours=>new Date(generatedAt+hours*60*60*1000).toISOString(),complete={five_hour:{percentUsed:10,resetsAt:at(1)},weekly:{percentUsed:20,resetsAt:at(2)},monthly:{percentUsed:30,resetsAt:at(3)}};
  h.context.forecastData={generatedAt,accounts:[
    {enabled:true,quota:{status:'fresh',limits:{five_hour:{percentUsed:80,resetsAt:at(0)},weekly:{percentUsed:60,resetsAt:at(1)},monthly:{percentUsed:40,resetsAt:at(1)}}}},
    {enabled:true,quota:{status:'fresh',limits:{five_hour:{percentUsed:70},weekly:{percentUsed:60,resetsAt:'invalid'},monthly:{percentUsed:50,resetsAt:at(1)}}}},
    {enabled:false,quota:{status:'fresh',limits:complete}},
    {enabled:true,quota:{status:'stale',limits:complete}},
    {enabled:true,quota:{status:'fresh',limits:{five_hour:complete.five_hour,weekly:complete.weekly}}},
    {enabled:true,quota:{status:'fresh',limits:{...complete,monthly:{percentUsed:'30',resetsAt:at(3)}}}}
  ]};
  const forecast=JSON.parse(h.run('JSON.stringify(statisticsQuotaForecast(forecastData))'));
  assert.deepEqual(forecast,{totals:{current:50,twoHours:50,eightHours:50,twentyFourHours:50},maximum:200,included:2,excluded:4,incompleteResets:2});
  h.context.invalidGeneratedAt={generatedAt:-1,accounts:[{enabled:true,quota:{status:'fresh',limits:complete}}]};
  assert.deepEqual(JSON.parse(h.run('JSON.stringify(statisticsQuotaForecast(invalidGeneratedAt))')),{totals:{current:70,twoHours:70,eightHours:70,twentyFourHours:70},maximum:100,included:1,excluded:0,incompleteResets:1});
  h.context.noEligible={generatedAt,accounts:[{enabled:false,quota:{status:'fresh',limits:complete}}]};h.run('renderStatisticsQuotaForecast(noEligible)');
  for(const id of ['#statisticsQuotaCurrent','#statisticsQuota2h','#statisticsQuota8h','#statisticsQuota24h'])assert.equal(h.el(id).textContent,'无可用数据');
  assert.equal(h.el('#statisticsQuotaForecastMeta').textContent,'纳入 0 个账号 · 排除 1 个账号 · 重置时间不完整 0 个账号');
});

test('statistics visit refreshes on entry/timer/manual, coalesces, aborts stale work and preserves every draft owner', async () => {
  const h=harness(),aggregate={requests:0,errors:0,inputTokens:0,inputKnownRequests:0,outputTokens:0,outputKnownRequests:0,totalTokens:0,totalKnownRequests:0,cachedTokens:0,cacheKnownRequests:0,cacheInputCachedTokens:0,cacheInputTokens:0,cacheTokenRatio:null,cacheHitRequestRate:null,cacheHitRequests:0};
  h.context.statData={generatedAt:Date.now(),lifetime:{global:aggregate},recent24h:{global:aggregate},accounts:[{id:'id0',name:'<safe>',enabled:true,health:{status:'insufficient',results:0,score:null},lifetime:aggregate,recent24h:aggregate,quota:{status:'fresh',pool:'hot',fetchedAt:Date.now(),lastAttemptAt:Date.now(),lastSuccessAt:Date.now(),limits:{five_hour:{percentUsed:0},weekly:{percentUsed:50},monthly:{percentUsed:100}},errorCategory:null,refresh:{eligible:true,reason:null,state:'idle',nextAttemptAt:Date.now()+300000}}}],migration:{legacyRequests:0}};
  h.el('#statisticsPanel').hidden=true;h.el('#logPanel').hidden=true;h.el('#detailsPanel').hidden=true;
  h.run("selectAccount(1,true); openRawScheduling(); openAccountDrawer(0); $('#drawerNote').value='unsaved drawer'; $('#accountErrorRules').value='{ pending';");
  const before={accounts:h.snapshot(),bulk:h.run('BULK_SELECTION.size'),raw:h.el('#rawSchedulingJson').value,drawer:h.el('#drawerNote').value,rules:h.el('#accountErrorRules').value};
  h.context.statCalls=[];h.run("api=async(path,body,method,asText,options={})=>{statCalls.push({path,body,options});return path==='/api/statistics'?statData:{ok:true,refreshed:1,cached:0,deferred:0,skipped:0,failed:0,cancelled:0};}");
  await h.run("switchSection('statistics')");assert.deepEqual(h.context.statCalls.map(call=>[call.path,call.body?.force]),[['/api/statistics',undefined],['/api/statistics/quota-refresh',false],['/api/statistics',undefined]]);assert.match(h.el('#statisticsBody').innerHTML,/&lt;safe&gt;/);assert.equal(h.el('#statisticsQuotaCurrent').textContent,'可用 0.0 / 100.0 账号额度点（0.0%）');assert.match(h.el('#statisticsQuotaForecastMeta').textContent,/纳入 1 个账号.*重置时间不完整 1 个账号.*预测下限/);assert.match(h.el('#statisticsStatus').textContent,/额度刷新完成/);
  let timer=[...h.timers.values()].find(value=>value.ms===5*60*1000);assert.ok(timer);await timer.fn();assert.equal(h.context.statCalls.filter(call=>call.path==='/api/statistics/quota-refresh'&&call.body.force===false).length,2);
  await h.run('refreshStatisticsQuota(true)');assert.equal(h.context.statCalls.filter(call=>call.path==='/api/statistics/quota-refresh'&&call.body.force===true).length,1);
  assert.equal(typeof h.windowListeners.pagehide,'function');assert.equal(typeof h.windowListeners.pageshow,'function');
  h.windowListeners.pagehide();assert.equal([...h.timers.values()].some(value=>value.ms===5*60*1000),false);
  const restoreAt=h.context.statCalls.length;await h.windowListeners.pageshow();assert.deepEqual(h.context.statCalls.slice(restoreAt).map(call=>[call.path,call.body?.force]),[['/api/statistics',undefined],['/api/statistics/quota-refresh',false],['/api/statistics',undefined]]);assert.ok([...h.timers.values()].some(value=>value.ms===5*60*1000),'restored statistics visit owns a fresh timer');
  const restoredVisit=h.run('STATISTICS_VISIT_ID'),restoredCalls=h.context.statCalls.length;await h.windowListeners.pageshow();assert.equal(h.run('STATISTICS_VISIT_ID'),restoredVisit);assert.equal(h.context.statCalls.length,restoredCalls,'pageshow does not duplicate an active statistics visit');
  assert.deepEqual({accounts:h.snapshot(),bulk:h.run('BULK_SELECTION.size'),raw:h.el('#rawSchedulingJson').value,drawer:h.el('#drawerNote').value,rules:h.el('#accountErrorRules').value},before);
  h.context.statCalls=[];h.run("api=(path,body,method,asText,options={})=>{statCalls.push({path,body,options});if(path==='/api/statistics')return Promise.resolve(statData);return new Promise((resolve,reject)=>{pendingResolve=resolve;pendingReject=reject;});}");
  const first=h.run('refreshStatisticsQuota(true)'),second=h.run('refreshStatisticsQuota(false)');assert.equal(h.context.statCalls.filter(call=>call.path==='/api/statistics/quota-refresh').length,1,'manual/timer demand coalesces while active');const signal=h.context.statCalls.find(call=>call.path==='/api/statistics/quota-refresh').options.signal;assert.equal(signal.aborted,false);
  h.el('#statisticsStatus').textContent='hidden status';await h.run("switchSection('console')");assert.equal(signal.aborted,true);h.context.pendingReject(Object.assign(new Error('late failure'),{name:'AbortError'}));await Promise.all([first,second]);assert.equal(h.el('#statisticsStatus').textContent,'hidden status','stale catch/finally cannot update a hidden visit');assert.equal([...h.timers.values()].some(value=>value.ms===5*60*1000),false);
  assert.deepEqual({accounts:h.snapshot(),bulk:h.run('BULK_SELECTION.size'),raw:h.el('#rawSchedulingJson').value,drawer:h.el('#drawerNote').value,rules:h.el('#accountErrorRules').value},before);
});

function rawDraft(h) { return JSON.parse(h.el('#rawSchedulingJson').value); }
function liveScheduling(h) { return h.run('JSON.stringify(rawSchedulingControls())'); }

test('raw editor projects only live scheduling and all reference names; combined bulk/raw save preserves accounts', async () => {
  const h=harness();
  h.run('addAccountRow(); closeAccountDrawer(true); selectAccount(1,true)');
  h.el('#bulkConcurrency').value='42'; h.run('applyBulkConcurrency()');
  h.el('#accMode').value='sticky'; h.el('#concurrencyWaitMs').value='987';
  h.el('#accountErrorRules').value='{"418":{"action":"ban"}}';
  h.el('#pipelineQuotaPool').checked=true;
  h.el('#accSearch').value='other'; h.run('clearBulkSelection(); openRawScheduling()');
  const draft=rawDraft(h), before=h.snapshot();
  assert.deepEqual(Object.keys(draft),['accountMode','concurrencyWaitMs','accountErrorRules','accountPipeline','accountNames']);
  assert.deepEqual(draft.accountNames,before.accounts.map(a=>a.name));
  assert.equal(draft.accountMode,'sticky'); assert.equal(draft.concurrencyWaitMs,987);
  assert.deepEqual(draft.accountErrorRules,{'418':{action:'ban'}});
  assert.equal(draft.accountPipeline.quotaPool,true); assert.equal(draft.accountPipeline.cachePoolSize,0);
  draft.accountMode='priority-failover'; draft.concurrencyWaitMs=30000;
  draft.accountErrorRules={'100':{action:'ignore'},'599':{action:'cooldown',cooldownMs:2592000000}};
  draft.accountPipeline={quotaPool:false,excludeUnhealthy:true,healthSort:true,sticky:true,order:['sticky','healthSort','quotaPool','excludeUnhealthy'],cachePoolSize:100000};
  h.el('#rawSchedulingJson').value=JSON.stringify(draft); h.run('applyRawScheduling()');
  assert.deepEqual(h.snapshot(),before); assert.equal(h.calls.length,0);
  assert.equal(h.el('#rawSchedulingDialog').open,false);
  assert.match(h.el('#rawSchedulingFeedback').textContent,/尚未生效/);
  h.context.sent=[]; h.run("api=async(path,body)=>{sent.push({path,body});return {ok:false};}");
  await h.run('saveAccounts()');
  const payload=JSON.parse(h.run('JSON.stringify(sent[0].body)'));
  assert.deepEqual(payload.accounts,before.accounts.map(({activeCount,cachePoolRole,...a})=>a));
  assert.equal(payload.active,1); assert.equal(payload.accounts[1].maxConcurrent,42);
  assert.equal(payload.mode,draft.accountMode); assert.equal(payload.concurrencyWaitMs,30000);
  assert.deepEqual(payload.accountErrorRules,draft.accountErrorRules); assert.deepEqual(payload.accountPipeline,draft.accountPipeline);
});

test('successful raw save hydrates persisted values and clears obsolete draft feedback without discarding an open editor', async () => {
  const h=harness();
  h.run('selectAccount(1,true)'); h.el('#bulkConcurrency').value='42'; h.run('applyBulkConcurrency(); openRawScheduling()');
  const draft=rawDraft(h);
  draft.accountMode='sticky'; draft.concurrencyWaitMs=987;
  draft.accountErrorRules={'418':{action:'ban'}};
  draft.accountPipeline={quotaPool:true,excludeUnhealthy:false,healthSort:true,sticky:true,order:['quotaPool','sticky','healthSort','excludeUnhealthy'],cachePoolSize:2};
  h.el('#rawSchedulingJson').value=JSON.stringify(draft); h.run('applyRawScheduling()');
  const before=h.snapshot();
  assert.match(h.el('#rawSchedulingFeedback').textContent,/尚未生效/);
  h.context.sent=[];
  h.context.responses={'/api/models':{},'/api/security':{},'/api/meta':{configured:true},'/api/model-aliases':{aliases:{}},'/api/statistics':{models:[]}};
  // Only unrelated model rendering and the API are stubbed; saveAccounts/loadAll are production functions.
  h.run(`render=()=>{}; api=async(path,body)=>{
    sent.push({path,body});
    if(body){responses[path]=JSON.parse(JSON.stringify(body));return {ok:true,accounts:body.accounts.length,mode:body.mode};}
    return JSON.parse(JSON.stringify(responses[path]));
  }`);
  await h.run('saveAccounts()');
  assert.equal(h.context.sent.filter(call=>call.body).length,1);
  assert.equal(h.context.sent[0].path,'/api/accounts');
  assert.equal(h.context.sent.filter(call=>!call.body).length,6);
  assert.deepEqual(h.snapshot().accounts,before.accounts.map(({activeCount,cachePoolRole,...a})=>a));
  assert.equal(h.snapshot().active,1); assert.equal(h.snapshot().accounts[1].maxConcurrent,42);
  assert.equal(h.el('#accMode').value,draft.accountMode);
  assert.equal(Number(h.el('#concurrencyWaitMs').value),draft.concurrencyWaitMs); assert.equal(Number(h.el('#cachePoolSize').value),draft.accountPipeline.cachePoolSize);
  assert.deepEqual(JSON.parse(h.el('#accountErrorRules').value),draft.accountErrorRules);
  for(const [key,id] of Object.entries({quotaPool:'QuotaPool',excludeUnhealthy:'ExcludeUnhealthy',healthSort:'HealthSort',sticky:'Sticky'})) assert.equal(h.el('#pipeline'+id).checked,draft.accountPipeline[key]);
  assert.deepEqual(JSON.parse(h.run('JSON.stringify(pipelineOrder())')),draft.accountPipeline.order);
  assert.equal(h.el('#rawSchedulingFeedback').textContent,'');
  // Native input.value coerces hydrated numbers to strings; the minimal DOM stub does not.
  h.el('#concurrencyWaitMs').value=String(h.el('#concurrencyWaitMs').value); h.el('#cachePoolSize').value=String(h.el('#cachePoolSize').value);
  h.run('openRawScheduling()'); h.el('#rawSchedulingJson').value+=' ';
  const text=h.el('#rawSchedulingJson').value;
  await h.run('loadAll()');
  assert.equal(h.el('#rawSchedulingDialog').open,true);
  assert.equal(h.el('#rawSchedulingJson').value,text);
  h.run('applyRawScheduling()');
  assert.match(h.el('#rawSchedulingError').textContent,/重新打开/);
});

test('raw validation rejects every unsupported domain atomically without echoing input', () => {
  const h=harness(); h.run('openRawScheduling()'); const base=rawDraft(h), before=h.snapshot(), controls=liveScheduling(h);
  const invalid=['{ secret-value',null,[],{}, {...base,secret:'secret-value'}, ...['unknown',null,1].map(accountMode=>({...base,accountMode})),
    ...['1',true,null,-1,30001,1.5].map(concurrencyWaitMs=>({...base,concurrencyWaitMs})),
    ...[null,[],{}, {...base.accountPipeline,extra:true}, {...base.accountPipeline,sticky:1}, {...base.accountPipeline,cachePoolSize:-1}, {...base.accountPipeline,cachePoolSize:100001}, {...base.accountPipeline,cachePoolSize:1.5}, {...base.accountPipeline,cachePoolSize:'2'}, {...base.accountPipeline,order:null}, {...base.accountPipeline,order:['sticky']}, {...base.accountPipeline,order:['sticky','sticky','quotaPool','healthSort']}, {...base.accountPipeline,order:['sticky','quotaPool','healthSort','__proto__']}].map(accountPipeline=>({...base,accountPipeline})),
    ...[null,[],{'99':{action:'ban'}},{'600':{action:'ban'}},{'secret-value':{action:'ban'}},{'429':null},{'429':[]},{'429':{}},{'429':{action:'secret-value'}},{'429':{action:'ban',cooldownMs:1}},
      ...[undefined,null,true,'1',0,-1,1.5,2592000001].map(cooldownMs=>({'429':{action:'cooldown',cooldownMs}})),
      JSON.parse('{"__proto__":{"action":"ignore"}}'),{'429':JSON.parse('{"action":"ban","__proto__":{}}')}].map(accountErrorRules=>({...base,accountErrorRules})),
    {...base,accountNames:['renamed']}, {...base,accountNames:null}];
  for(const value of invalid){
    h.el('#rawSchedulingJson').value=typeof value==='string'?value:JSON.stringify(value); h.run('applyRawScheduling()');
    assert.deepEqual(h.snapshot(),before); assert.equal(liveScheduling(h),controls);
    assert.equal(h.el('#rawSchedulingDialog').open,true); assert.ok(h.el('#rawSchedulingError').textContent);
    assert.doesNotMatch(h.el('#rawSchedulingError').textContent,/secret-value/);
  }
  assert.equal(h.calls.length,0);
});

test('failed raw opening preserves invalid live input; cancel confirms dirty text and restores focus', () => {
  const h=harness(), before=h.snapshot();
  for(const text of ['{ unfinished','', '[]']){
    h.el('#accountErrorRules').value=text; h.run('renderAccounts(); openRawScheduling()');
    assert.equal(h.el('#accountErrorRules').value,text); assert.notEqual(h.el('#rawSchedulingDialog').open,true);
  }
  h.el('#accountErrorRules').value='{}';
  for(const value of ['', ' ', '-1','1.5','30001']){h.el('#concurrencyWaitMs').value=value;h.run('openRawScheduling()');assert.equal(h.el('#concurrencyWaitMs').value,value);assert.notEqual(h.el('#rawSchedulingDialog').open,true);}
  h.el('#concurrencyWaitMs').value='0';
  for(const value of ['', ' ', '-1','1.5','100001']){h.el('#cachePoolSize').value=value;h.run('openRawScheduling()');assert.equal(h.el('#cachePoolSize').value,value);assert.notEqual(h.el('#rawSchedulingDialog').open,true);}
  h.el('#cachePoolSize').value='0'; h.run("openRawScheduling($('#rawSchedulingOpen'))");
  h.el('#rawSchedulingJson').value+=' '; h.context.confirm=()=>false;
  let prevented=false; h.el('#rawSchedulingDialog').listeners.cancel({preventDefault(){prevented=true;}});
  assert.equal(prevented,true); assert.equal(h.el('#rawSchedulingDialog').open,true);
  h.context.confirm=()=>true; h.run('closeRawScheduling()');
  assert.equal(h.el('#rawSchedulingDialog').open,false); assert.equal(h.el('#rawSchedulingOpen').focused,true);
  assert.deepEqual(h.snapshot(),before); assert.equal(h.calls.length,0);
});

test('raw stale reload, scheduling edits, rename, deletion and duplicate reorder never overwrite newer drafts', () => {
  for(const change of ["ACCS=JSON.parse(JSON.stringify(ACCS))", "$('#accMode').value='sticky'", "$('#cachePoolSize').value='2'", "$('#accountErrorRules').value='invalid'", "$('#pipelineSticky').checked=true", "movePipelineStep('sticky',-1)", "ACCS.accounts[0].name='new'", 'ACCS.accounts.pop()', '[ACCS.accounts[0],ACCS.accounts[1]]=[ACCS.accounts[1],ACCS.accounts[0]]']){
    const h=harness();h.run('openRawScheduling()');const text=h.el('#rawSchedulingJson').value;
    h.run(change);const before=h.snapshot(),controls=liveScheduling(h);h.run('applyRawScheduling()');
    assert.deepEqual(h.snapshot(),before); assert.equal(liveScheduling(h),controls);
    assert.equal(h.el('#rawSchedulingJson').value,text);assert.match(h.el('#rawSchedulingError').textContent,/重新打开/);assert.equal(h.calls.length,0);
  }
});

test('cache-hit preset previews, cancels and saves only the scheduling draft plus editable priorities', async () => {
  const h=harness(),before=h.snapshot();h.el('#cachePoolSize').value='0';h.el('#concurrencyWaitMs').value='123';h.el('#preset').value='cache';
  h.run('previewPreset()');
  const pending=JSON.parse(h.run('JSON.stringify(PENDING_PRESET)'));
  assert.equal(pending.mode,'sticky');assert.equal(pending.concurrencyWaitMs,5000);assert.equal(pending.accountPipeline.cachePoolSize,2);
  assert.deepEqual(pending.accounts.map(account=>({name:account.name,key:account.key,enabled:account.enabled,proxyUrl:account.proxyUrl,headers:account.headers,perModel:account.perModel})),before.accounts.map(account=>({name:account.name,key:account.key,enabled:account.enabled,proxyUrl:account.proxyUrl,headers:account.headers,perModel:account.perModel})));
  assert.match(h.el('#presetAdjust').innerHTML,/优先级/);h.run("updatePresetAccount(0,'priority',7); closePreset()");
  assert.deepEqual(h.snapshot(),before);assert.equal(h.el('#cachePoolSize').value,'0');assert.equal(h.calls.length,0);
  h.context.sent=[];h.run("api=async(path,body)=>{sent.push({path,body});return {ok:false};}; previewPreset()");await h.run('applyPreset()');
  assert.equal(h.context.sent.length,1);assert.equal(h.context.sent[0].path,'/api/accounts');assert.equal(h.context.sent[0].body.accountPipeline.cachePoolSize,2);assert.equal(h.context.sent[0].body.mode,'sticky');assert.equal(h.context.sent[0].body.concurrencyWaitMs,5000);assert.equal(h.el('#cachePoolSize').value,2);
});

test('raw applied custom rules remain compatible with existing confirm-and-save presets', async () => {
  const h=harness();h.run('openRawScheduling()');const draft=rawDraft(h);
  draft.accountErrorRules={'418':{action:'ignore'}};h.el('#rawSchedulingJson').value=JSON.stringify(draft);h.run('applyRawScheduling()');
  h.context.sent=[];h.run("api=async(path,body)=>{sent.push({path,body});return {ok:false};}");
  h.el('#preset').value='stable';h.run('previewPreset(); closePreset()');assert.equal(h.context.sent.length,0);
  h.run('previewPreset()');await h.run('applyPreset()');
  h.el('#errorRulePreset').value='fast';h.run('previewErrorPreset(); closeErrorPreset()');assert.equal(h.context.sent.length,1);
  h.run('previewErrorPreset()');await h.run('applyErrorPreset()');
  for(const {body} of h.context.sent){assert.equal(body.accountErrorRules['418'].action,'ignore');assert.deepEqual(JSON.parse(JSON.stringify(body.accounts)),h.snapshot().accounts.map(({activeCount,cachePoolRole,...a})=>a));}
});

test('raw validator accepts six modes and numeric limits but rejects missing fields and non-JSON numeric types', () => {
  const h=harness(); h.run('openRawScheduling()');const base=rawDraft(h);
  for(const option of h.el('#accMode').options){
    h.context.candidate={...base,accountMode:option.value,concurrencyWaitMs:0,accountErrorRules:{'429':{action:'cooldown',cooldownMs:1}}};
    h.run('validateRawScheduling(candidate,RAW_SCHEDULING.names)');
  }
  for(const key of Object.keys(base)){
    h.context.candidate={...base};delete h.context.candidate[key];
    assert.throws(()=>h.run('validateRawScheduling(candidate,RAW_SCHEDULING.names)'));
  }
  for(const key of [...Object.keys(base.accountPipeline).filter(key=>key!=='cachePoolSize')])for(const value of [null,'true',0]){
    h.context.candidate={...base,accountPipeline:{...base.accountPipeline,[key]:value}};
    assert.throws(()=>h.run('validateRawScheduling(candidate,RAW_SCHEDULING.names)'));
  }
  for(const cachePoolSize of [0,100000]){h.context.candidate={...base,accountPipeline:{...base.accountPipeline,cachePoolSize}};h.run('validateRawScheduling(candidate,RAW_SCHEDULING.names)');}
  for(const cachePoolSize of [null,'2',true,-1,100001,1.5]){h.context.candidate={...base,accountPipeline:{...base.accountPipeline,cachePoolSize}};assert.throws(()=>h.run('validateRawScheduling(candidate,RAW_SCHEDULING.names)'));}
  for(const value of [NaN,Infinity]){
    h.context.candidate={...base,concurrencyWaitMs:value};
    assert.throws(()=>h.run('validateRawScheduling(candidate,RAW_SCHEDULING.names)'));
  }
});
