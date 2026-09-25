import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
const deferred=()=>{let resolve,reject;const promise=new Promise((res,rej)=>{resolve=res;reject=rej;});return {promise,resolve,reject};};
function harness(){
  const elements=new Map(),calls=[],events={};
  const el=id=>{if(!elements.has(id))elements.set(id,{value:'',hidden:id==='#modelProvidersChannelView',disabled:false,textContent:'',innerHTML:'',attrs:{},setAttribute(k,v){this.attrs[k]=v;},replaceChildren(){this.innerHTML='';},addEventListener(){},focus(){this.focused=true;}});return elements.get(id);};
  const context=vm.createContext({document:{querySelector:el,addEventListener(){}},window:{addEventListener(name,callback){events[name]=callback;}},localStorage:{getItem:()=>''},fetch:()=>new Promise(()=>{}),setTimeout(){},clearTimeout(){},AbortController,URL,URLSearchParams,confirm:()=>true});
  const run=code=>vm.runInContext(code,context);run(script);
  context.call=(...args)=>{calls.push(args);return context.handler(...args);};run('api=(...args)=>call(...args)');
  run("ACCS={accounts:[{id:'draft',note:'unsaved',perModel:{m:{maxRetries:3}}}]};RAW_SCHEDULING={text:'invalid JSON'};ERROR_RULE_DRAFT=[{id:'draft'}];");
  const drafts=()=>run('JSON.stringify([ACCS,RAW_SCHEDULING,ERROR_RULE_DRAFT])');
  return {el,run,context,calls,drafts,events};
}
const price={version:'clinepass-2026-09-24-v1',collectedAt:'2026-09-24',models:{'cline-pass/deepseek-v4-flash':{tier:'peak/off-peak range',rates:[[220,660,7],[440,1320,14]]}}};
const aggregate={requests:2,inputTokens:10,inputKnownRequests:2,outputTokens:2,outputKnownRequests:2,totalTokens:null,totalKnownRequests:0,cachedTokens:3,cacheKnownRequests:2,cacheInputTokens:10,cacheInputCachedTokens:3,cacheInputKnownRequests:2,cacheTokenRatio:.3,cacheHitRequests:1,cacheHitRequestRate:.5};
const cost=(pricedRequests,lowPicoUsd,highPicoUsd,complete=false)=>({versions:{[price.version]:{pricedRequests,lowPicoUsd,highPicoUsd}},complete,from:0});
const coverage={complete:false,from:0};
const data={generatedAt:Date.now(),referencePrices:{current:price,versions:{[price.version]:price}},models:[{id:'cline-pass/deepseek-v4-flash',recent24h:aggregate,coverage:{complete:true,from:0},providerStatistics:{finalRequests:{successes:2,failures:1,samples:3,successRate:2/3},finalCoverage:coverage,valuation:cost(2,2881000,5762000),providers:[
  {id:'retry-failed',usage:{requests:0},health:{successes:0,degrades:1,samples:1,successRate:0,coverageComplete:false,coverageFrom:0},coverage,valuation:{versions:{},...coverage}},
  {id:'<script>evil</script>',usage:{...aggregate,requests:1,inputKnownRequests:1,outputKnownRequests:1,cacheKnownRequests:1},health:{successes:1,degrades:0,samples:1,successRate:1,coverageComplete:false,coverageFrom:0},coverage,valuation:cost(1,2881000,5762000)},
  {id:null,usage:{requests:1,inputTokens:0,inputKnownRequests:1,outputTokens:0,outputKnownRequests:1,cachedTokens:0,cacheKnownRequests:1,cacheTokenRatio:null},health:null,coverage,valuation:cost(1,0,0)},
]}}]};

test('model and channel projections use distinct denominators, attribute only final usage, and preserve drafts',async()=>{
  const h=harness(),before=h.drafts();h.context.handler=async()=>data;
  await h.run("switchSection('modelProviders')");
  assert.equal(h.el('#modelProvidersPanel').hidden,false);assert.equal(h.el('#navModelProviders').attrs['aria-pressed'],'true');assert.equal(h.el('#modelProvidersTitle').focused,true);
  assert.equal(h.calls.length,1);assert.equal(h.calls[0][0],'/api/statistics');
  assert.equal(h.el('#modelProvidersModelView').hidden,false);assert.equal(h.el('#modelProvidersChannelView').hidden,true);
  const model=h.el('#modelProvidersBody').innerHTML;
  assert.match(model,/66\.7% · 3 样本/);assert.match(model,/\$0\.000002881000 – \$0\.000005762000 · 峰谷参考区间 · 部分/);
  assert.match(model,/total 无数据（0 已知）/);assert.match(model,/成功率覆盖 统计不完整/);
  assert.doesNotMatch(model,/retry-failed|evil|未知渠道|最终请求：/);
  h.run("selectModelProviderView('channel')");
  const channel=h.el('#modelProvidersChannelBody').innerHTML;
  assert.equal(h.el('#modelProvidersChannelView').hidden,false);assert.equal(h.el('#modelProvidersModelView').hidden,true);
  assert.equal(h.el('#modelProvidersChannelTab').attrs['aria-pressed'],'true');assert.equal(h.el('#modelProvidersModelTab').attrs['aria-pressed'],'false');
  assert.match(h.el('#modelProvidersStatus').textContent,/渠道视图/);
  assert.match(channel,/retry-failed<\/td><td>0\.0% · 1 样本<\/td><td>无数据 \/ 无数据/);
  assert.match(channel,/&lt;script&gt;evil&lt;\/script&gt;<\/td><td>100\.0% · 1 样本/);
  assert.doesNotMatch(channel,/<script>evil<\/script>/);
  assert.match(channel,/未知渠道<\/td><td>不适用（无具名尝试）<\/td><td>0 \/ 0<\/td><td>0 · 无数据<\/td><td>\$0\.000000000000 – \$0\.000000000000 · 峰谷参考区间 · 部分/);
  assert.match(channel,/渠道尝试成功率不适用（无具名尝试）<br>最终成功归属用量请求 1/);
  assert.match(channel,/渠道成功率按具名尝试计算；用量与金额仅按最终成功请求归属/);
  assert.equal(h.el('#modelProvidersBody').innerHTML,'','inactive model rows are removed');
  assert.equal(h.calls.length,1,'tab change must not refetch');
  h.el('#modelProvidersFilter').value='retry';h.run('renderModelProviders()');assert.match(h.el('#modelProvidersChannelBody').innerHTML,/retry-failed/);assert.doesNotMatch(h.el('#modelProvidersChannelBody').innerHTML,/evil|未知渠道/);
  h.el('#modelProvidersFilter').value='no-match';h.run('renderModelProviders()');assert.match(h.el('#modelProvidersChannelBody').innerHTML,/没有匹配/);
  h.el('#modelProvidersFilter').value='flash';h.run('renderModelProviders()');assert.match(h.el('#modelProvidersChannelBody').innerHTML,/未知渠道/);
  h.run("selectModelProviderView('model')");assert.match(h.el('#modelProvidersBody').innerHTML,/66\.7% · 3 样本/);
  assert.equal(h.el('#modelProvidersChannelBody').innerHTML,'','inactive channel rows are removed, not retained as hidden DOM');
  h.run("selectModelProviderView('channel')");assert.match(h.el('#modelProvidersChannelBody').innerHTML,/未知渠道/,'channel rows rebuild from the same snapshot');
  assert.equal(h.calls.length,1,'search and tab change reuse accepted snapshot');
  await h.run("switchSection('console')");assert.equal(h.el('#modelProvidersPanel').hidden,true);assert.equal(h.drafts(),before);
});

test('v2 tariffs, frozen v1/v2 amounts and missing/zero remain distinct',async()=>{
  const h=harness(),v2='clinepass-2026-09-25-v2',source='https://docs.cline.bot/getting-started/clinepass',deepseek='https://api-docs.deepseek.com/quick_start/pricing/';
  const current={version:v2,collectedAt:'2026-09-25',rateScale:10000,source,models:{
    'cline-pass/mimo-v2.5':{tier:'single',rates:[[1400,2800,28,null]],source},
    'cline-pass/qwen3.7-plus':{tier:'context-band',rates:[[4000,16000,400,5000],[12000,48000,1200,15000]],source},
    'cline-pass/qwen3.7-max':{tier:'single',rates:[[25000,75000,5000,31250]],source},
    'cline-pass/deepseek-v4.1-flash':{tier:'peak/off-peak range',rates:[[1500,6000,30,null],[3000,12000,60,null]],source:deepseek},
    '<img src=x onerror=alert(1)>':{tier:'single',rates:[[0,0,0,null]],source:'<script>evil</script>'},
  }};
  const v1=price.version,history={...price,source,models:{...price.models,'cline-pass/mimo-v2.5':{tier:'single',rates:[[100,200,1]]}}};
  h.context.handler=async()=>({...data,referencePrices:{current,versions:{[v1]:history,[v2]:current}},models:[
    {id:'cline-pass/qwen3.7-plus',recent24h:aggregate,coverage,providerStatistics:{...data.models[0].providerStatistics,finalRequests:{successes:1,samples:1,successRate:1},valuation:{versions:{},complete:true,from:0},providers:[]}},
    {id:'cline-pass/mimo-v2.5',recent24h:{...aggregate,inputTokens:0,inputKnownRequests:1,outputTokens:0,outputKnownRequests:1,cachedTokens:0,cacheKnownRequests:1},coverage,providerStatistics:{...data.models[0].providerStatistics,finalRequests:{successes:3,samples:3,successRate:1},valuation:{versions:{[v1]:{pricedRequests:1,lowPicoUsd:1000000,highPicoUsd:1000000},[v2]:{pricedRequests:1,lowPicoUsd:0,highPicoUsd:0}},complete:true,from:0},providers:[]}},
  ]});
  await h.run("switchSection('modelProviders')");
  const tariffs=h.el('#modelProvidersTariffs').innerHTML,rows=h.el('#modelProvidersBody').innerHTML;
  assert.match(tariffs,/0\.0028/);assert.match(tariffs,/3\.125/);assert.match(tariffs,/0\.003/);
  assert.match(tariffs,/上下文档位与缓存写计数未知/);assert.match(tariffs,/低峰 \/ 高峰/);
  assert.match(tariffs,/低峰：0\.15 \/ 0\.6 \/ 0\.003 \/ —；高峰：0\.3 \/ 1\.2 \/ 0\.006 \/ —/);
  assert.match(tariffs,/api-docs\.deepseek\.com\/quick_start\/pricing/);assert.match(tariffs,/官方生效时间未知/);
  assert.match(html,/ClinePass 表仅列 V4\.1 Flash 高峰单价，低峰单价取自 DeepSeek 直连官网/);
  assert.match(tariffs,/&lt;img src=x onerror=alert\(1\)&gt;/);assert.doesNotMatch(tariffs,/<img src=x/);
  assert.match(rows,/不可计算（上下文档位与缓存写计数未知）/);
  assert.match(rows,/\$0\.000001000000 · 部分/);assert.match(rows,/clinepass-2026-09-24-v1/);assert.match(rows,/clinepass-2026-09-25-v2/);
  assert.match(rows,/input 0（1 已知）/);assert.match(rows,/已计 2 \/ 3 最终成功请求（其余不可计算）/);
  assert.match(rows,/clinepass-2026-09-24-v1[^]*来源 https:\/\/docs\.cline\.bot\/getting-started\/clinepass；官方生效时间未知/);
  assert.match(rows,/clinepass-2026-09-25-v2[^]*来源 https:\/\/docs\.cline\.bot\/getting-started\/clinepass；官方生效时间未知/);
  assert.match(h.run(`mpMoney({versions:{[${JSON.stringify(v2)}]:{pricedRequests:1,lowPicoUsd:2259000,highPicoUsd:4518000}},complete:true},{[${JSON.stringify(v2)}]:${JSON.stringify(current)}},'cline-pass/deepseek-v4.1-flash',2)`),/已计 1 \/ 2 最终成功请求（其余不可计算）/);
  const zero=h.run(`mpMoney({versions:{[${JSON.stringify(v2)}]:{pricedRequests:1,lowPicoUsd:0,highPicoUsd:0}},complete:true},{[${JSON.stringify(v2)}]:${JSON.stringify(current)}},'cline-pass/deepseek-v4.1-flash',1)`);
  assert.match(zero,/\$0\.000000000000/);assert.match(zero,/input\/output\/cached-read\/cached-write/);
  const inconsistent=h.run(`mpMoney({versions:{[${JSON.stringify(v2)}]:{pricedRequests:2,lowPicoUsd:0,highPicoUsd:0}},complete:false},{[${JSON.stringify(v2)}]:${JSON.stringify(current)}},'cline-pass/deepseek-v4.1-flash',1)`);
  assert.match(inconsistent,/已计 2 请求 · 最终成功请求数 1（覆盖不一致或计数溢出，不代表完整费用）/);
});

test('compact price is partial when final or model coverage is incomplete despite complete valuation',async()=>{
  const h=harness(),model=data.models[0],providerStatistics={...model.providerStatistics,finalRequests:{successes:2,failures:0,samples:2,successRate:1},valuation:cost(2,2881000,5762000,true)};
  h.context.handler=async()=>({...data,models:[{...model,providerStatistics:{...providerStatistics,finalCoverage:coverage}}]});
  await h.run("switchSection('modelProviders')");
  assert.match(h.el('#modelProvidersBody').innerHTML,/峰谷参考区间 · 部分/);
  h.context.handler=async()=>({...data,models:[{...model,coverage,providerStatistics:{...providerStatistics,finalCoverage:{complete:true,from:0}}}]});
  await h.run('loadModelProviders()');
  assert.match(h.el('#modelProvidersBody').innerHTML,/峰谷参考区间 · 部分/);
  h.context.handler=async()=>({...data,models:[{...model,providerStatistics:{...providerStatistics,finalCoverage:{complete:true,from:0}}}]});
  await h.run('loadModelProviders()');
  assert.match(h.el('#modelProvidersBody').innerHTML,/峰谷参考区间<\/td>/);
});

test('zero samples and unknown usage never become measured zero',async()=>{
  const h=harness();h.context.handler=async()=>({...data,models:[{id:'no-samples',recent24h:{inputTokens:0,inputKnownRequests:0},coverage,providerStatistics:{finalRequests:{successes:0,failures:0,samples:0,successRate:null},finalCoverage:coverage,valuation:{versions:{},...coverage},providers:[{id:'idle',usage:{requests:0},coverage,valuation:{versions:{},...coverage},health:{samples:0,successRate:null,coverageComplete:false,coverageFrom:0}}]}}]});
  await h.run("switchSection('modelProviders')");
  assert.match(h.el('#modelProvidersBody').innerHTML,/无数据 · 0 样本<\/td><td>无数据 \/ 无数据/);
  assert.doesNotMatch(h.el('#modelProvidersBody').innerHTML,/0\.0%/);
  h.run("selectModelProviderView('channel')");assert.match(h.el('#modelProvidersChannelBody').innerHTML,/无数据 · 0 样本/);
  assert.equal(h.run('mpRatio(0)'),'0.0%');assert.equal(h.run('mpRatio(null)'),'无数据');
});

test('model/provider older read cannot overwrite a newer tab, filter or account draft',async()=>{
  const h=harness(),old=deferred(),newer=deferred(),before=h.drafts();let count=0;
  h.context.handler=()=>++count===1?old.promise:newer.promise;
  const a=h.run("switchSection('modelProviders')");h.run("selectModelProviderView('channel')");h.el('#modelProvidersFilter').value='missing';
  const b=h.run('loadModelProviders()');newer.resolve(data);await b;
  assert.match(h.el('#modelProvidersChannelBody').innerHTML,/没有匹配/);
  old.resolve({...data,models:[]});await a;
  assert.match(h.el('#modelProvidersChannelBody').innerHTML,/没有匹配/);
  assert.match(h.el('#modelProvidersStatus').textContent,/渠道视图 · 生成于/);
  assert.equal(h.drafts(),before);
  const pending=h.run('loadModelProviders()');await h.run("switchSection('console')");await pending;
  assert.equal(h.el('#modelProvidersPanel').hidden,true);assert.match(h.el('#modelProvidersChannelBody').innerHTML,/没有匹配/);
});

test('stale failures and finally cannot replace an accepted channel view or cleared controller',async()=>{
  const h=harness(),old=deferred(),newer=deferred();let count=0;
  h.context.handler=()=>++count===1?old.promise:newer.promise;
  const a=h.run("switchSection('modelProviders')");h.run("selectModelProviderView('channel')");
  const b=h.run('loadModelProviders()');newer.resolve(data);await b;
  old.reject(new Error('old read failed'));await a;
  assert.match(h.el('#modelProvidersStatus').textContent,/渠道视图 · 生成于/);
  assert.match(h.el('#modelProvidersChannelBody').innerHTML,/retry-failed/);
  assert.equal(h.run('MODEL_PROVIDER_CONTROLLER'),null);
});

test('untrusted model and channel identifiers are escaped in either projection',async()=>{
  const h=harness();h.context.handler=async()=>({...data,models:[{...data.models[0],id:'<img src=x onerror=alert(1)>',providerStatistics:{...data.models[0].providerStatistics,providers:[data.models[0].providerStatistics.providers[1]]}}]});
  await h.run("switchSection('modelProviders')");assert.match(h.el('#modelProvidersBody').innerHTML,/&lt;img src=x onerror=alert\(1\)&gt;/);
  h.run("selectModelProviderView('channel')");const rows=h.el('#modelProvidersChannelBody').innerHTML;
  assert.match(rows,/&lt;img src=x onerror=alert\(1\)&gt;/);assert.match(rows,/&lt;script&gt;evil&lt;\/script&gt;/);
  assert.doesNotMatch(rows,/<img src=x|<script>evil<\/script>/);
});

test('model/provider bfcache return restarts only its visible read',async()=>{
  const h=harness();h.context.handler=async()=>data;
  await h.run("switchSection('modelProviders')");assert.equal(h.calls.length,1);
  h.events.pagehide();h.events.pageshow();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(h.calls.length,2);assert.match(h.el('#modelProvidersStatus').textContent,/生成于/);
  await h.run("switchSection('console')");h.events.pageshow();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(h.calls.length,2,'hidden section must not issue a statistics read');
});
