import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
function harness(){
  const elements=new Map(),calls=[],events={};
  const el=id=>{if(!elements.has(id))elements.set(id,{value:'',hidden:false,disabled:false,textContent:'',innerHTML:'',attrs:{},setAttribute(k,v){this.attrs[k]=v;},addEventListener(){},focus(){this.focused=true;}});return elements.get(id);};
  const context=vm.createContext({document:{querySelector:el,addEventListener(){}},window:{addEventListener(name,callback){events[name]=callback;}},localStorage:{getItem:()=>''},fetch:()=>new Promise(()=>{}),setTimeout(){},clearTimeout(){},AbortController,URL,URLSearchParams,confirm:()=>true});
  const run=code=>vm.runInContext(code,context);run(script);
  context.call=(...args)=>{calls.push(args);return context.handler(...args);};run('api=(...args)=>call(...args)');
  run("ACCS={accounts:[{id:'draft',note:'unsaved',perModel:{m:{maxRetries:3}}}]};RAW_SCHEDULING={text:'invalid JSON'};ERROR_RULE_DRAFT=[{id:'draft'}];");
  const drafts=()=>run('JSON.stringify([ACCS,RAW_SCHEDULING,ERROR_RULE_DRAFT])');
  return {el,run,context,calls,drafts,events};
}
const price={version:'clinepass-2026-09-24-v1',collectedAt:'2026-09-24',models:{'cline-pass/deepseek-v4-flash':{tier:'peak/off-peak range',rates:[[220,660,7],[440,1320,14]]}}};
const aggregate={requests:1,inputTokens:10,inputKnownRequests:1,outputTokens:2,outputKnownRequests:1,totalTokens:null,totalKnownRequests:0,cachedTokens:3,cacheKnownRequests:1,cacheInputKnownRequests:1,cacheTokenRatio:.3,cacheHitRequestRate:1};
const cost={versions:{[price.version]:{pricedRequests:1,lowPicoUsd:2881000,highPicoUsd:5762000}},complete:false,from:0};
const data={generatedAt:Date.now(),referencePrices:{current:price,versions:{[price.version]:price}},models:[{id:'cline-pass/deepseek-v4-flash',recent24h:aggregate,coverage:{complete:true,from:0},providerStatistics:{finalRequests:{successes:1,samples:1,successRate:1},finalCoverage:{complete:false,from:0},valuation:cost,providers:[{id:'<script>evil</script>',usage:{...aggregate,requests:1},health:{successes:1,samples:1,successRate:1,coverageComplete:false,coverageFrom:0},coverage:{complete:false,from:0},valuation:cost}]}}]};

test('model/provider page renders safe reference range, unknown totals and preserves drafts on filter/navigation',async()=>{
  const h=harness(),before=h.drafts();h.context.handler=async()=>data;
  await h.run("switchSection('modelProviders')");
  assert.equal(h.el('#modelProvidersPanel').hidden,false);assert.equal(h.el('#navModelProviders').attrs['aria-pressed'],'true');assert.equal(h.el('#modelProvidersTitle').focused,true);
  assert.equal(h.calls.length,1);assert.equal(h.calls[0][0],'/api/statistics');
  const markup=h.el('#modelProvidersBody').innerHTML;
  assert.match(markup,/峰谷参考区间/);assert.match(markup,/\$0\.000002881000 – \$0\.000005762000/);assert.match(markup,/&lt;script&gt;evil&lt;\/script&gt;/);assert.doesNotMatch(markup,/<script>evil<\/script>/);
  assert.match(markup,/无数据/);assert.match(markup,/统计不完整/);
  assert.match(markup,/成功率 统计不完整 · 自 .* Token 24h 完整/);
  assert.match(markup,/渠道尝试[^]*成功率 统计不完整 · 自 .* Token 统计不完整/);
  assert.match(markup,/2026-09-24；cline-pass\/deepseek-v4-flash/);
  assert.match(markup,/0\.22\/0\.66\/0\.007 ～ 0\.44\/1\.32\/0\.014/);
  h.el('#modelProvidersFilter').value='no-match';h.run('renderModelProviders()');assert.match(h.el('#modelProvidersBody').innerHTML,/没有匹配/);
  h.el('#modelProvidersFilter').value='flash';h.run('renderModelProviders()');assert.match(h.el('#modelProvidersBody').innerHTML,/峰谷参考区间/);
  await h.run("switchSection('console')");assert.equal(h.el('#modelProvidersPanel').hidden,true);assert.equal(h.drafts(),before);
});

test('model/provider older read cannot overwrite current visit or navigate into another panel',async()=>{
  const h=harness(),old=deferred(),newer=deferred();let count=0;
  h.context.handler=()=>++count===1?old.promise:newer.promise;
  const a=h.run("switchSection('modelProviders')");const b=h.run('loadModelProviders()');newer.resolve({...data,models:[]});await b;
  old.resolve(data);await a;assert.match(h.el('#modelProvidersBody').innerHTML,/没有匹配/);
  h.context.handler=()=>old.promise;const pending=h.run('loadModelProviders()');await h.run("switchSection('console')");await pending;
  assert.equal(h.el('#modelProvidersPanel').hidden,true);assert.match(h.el('#modelProvidersBody').innerHTML,/没有匹配/);
});

test('model/provider bfcache return restarts only its visible read',async()=>{
  const h=harness();h.context.handler=async()=>data;
  await h.run("switchSection('modelProviders')");assert.equal(h.calls.length,1);
  h.events.pagehide();h.events.pageshow();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(h.calls.length,2);assert.match(h.el('#modelProvidersStatus').textContent,/生成于/);
  await h.run("switchSection('console')");h.events.pageshow();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(h.calls.length,2,'hidden section must not issue a statistics read');
});

test('model/provider no sample and unpriced valuation remain unavailable, explicit zero remains zero',()=>{
  const h=harness();
  assert.match(h.run("mpMoney({versions:{}},{},'other')"),/不可计算/);
  assert.match(h.run("mpMoney({versions:{v:{pricedRequests:1,lowPicoUsd:0,highPicoUsd:0}},complete:true},{v:{collectedAt:'2026-09-24',models:{m:{tier:'single'}}}},'m')"),/\$0\.000000000000/);
  assert.equal(h.run('mpRatio(null)'), '无数据');assert.equal(h.run('mpRatio(0)'), '0.0%');
  assert.match(h.run("mpHealthCoverage({coverageComplete:false,coverageFrom:0})"),/统计不完整/);
});
