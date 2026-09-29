// Local persistence microbenchmark. No upstream traffic and no production data.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const source=fs.readFileSync('server.js','utf8');
const between=(from,to)=>source.slice(source.indexOf(from),source.indexOf(to,source.indexOf(from)));
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cps-counter-cost-'));
const context=vm.createContext({fs,path,process,console,performance,SELECTION_COUNTERS_PATH:path.join(dir,'selection-counters.json'),META_PATH:path.join(dir,'metadata.json')});
vm.runInContext(between('const LEGACY_AGG_FIELDS =','function emptyHealth()'),context);
vm.runInContext(between('function atomicWriteJson(','const MISSING_ADMIN'),context);
vm.runInContext(between('function persistSelectionCounters()','const saveConfig'),context);
vm.runInContext(between('function selectionCounterFor(','function workflowSnapshot('),context);
vm.runInContext(between('function recordWorkflowSelection(','function workflowDecision('),context);
vm.runInContext(`
var selectionCountersDirty=false,selectionCounterPersistenceError=false;
var cells=50000,remaining=cells,buckets=[];
while(remaining){const accounts={};for(let i=0;i<Math.min(43,remaining);i++)accounts['a'+i]=emptyAggregate();buckets.push({minute:buckets.length,accounts});remaining-=Object.keys(accounts).length;}
var META={statistics:{minuteBuckets:buckets},selectionCounters:{version:1,sequence:0,accounts:Object.fromEntries(Array.from({length:43},(_,i)=>['a'+i,{count:0,lastSelected:0}]))}};
var wholeMetaCalls=0;
function saveMeta(){wholeMetaCalls++;atomicWriteJson(META_PATH,META,{pretty:false});}
var results={synthetic:true,cells,accountCount:43,wholeMetaBytes:0,compactBytes:0,oldSamples:[],newSamples:[]};
`,context);
context.results.wholeMetaBytes=Buffer.byteLength(vm.runInContext('JSON.stringify(META)',context));
// Same production writer, then the actual new recordWorkflowSelection function.
vm.runInContext(`for(let i=0;i<5;i++){const start=performance.now();saveMeta();results.oldSamples.push(performance.now()-start);} wholeMetaCalls=0;
for(let i=0;i<100;i++){const start=performance.now();recordWorkflowSelection({id:'a'+(i%43)});results.newSamples.push(performance.now()-start);}
results.compactBytes=fs.statSync(SELECTION_COUNTERS_PATH).size;results.wholeMetaCallsOnNewPath=wholeMetaCalls;`,context);
const result=JSON.parse(JSON.stringify(context.results));
assert.equal(result.wholeMetaCallsOnNewPath,0);assert.ok(result.compactBytes<10000);assert.ok(result.wholeMetaBytes>20000000);
const stats=a=>({meanMs:a.reduce((n,v)=>n+v,0)/a.length,p95Ms:[...a].sort((a,b)=>a-b)[Math.ceil(a.length*.95)-1],samples:a.length});
const report={...result,oldSamples:undefined,newSamples:undefined,oldFullMetadataWrite:stats(result.oldSamples),newActualSelectionRecord:stats(result.newSamples),temporaryDataDirectory:dir,limitations:'Serialization + synchronous atomic rename on this local disk only; existing completion-time full metadata writes are unchanged. This is not end-to-end production admission, crash/fsync durability, or an upstream capacity test.'};
fs.writeFileSync('.trellis/tasks/09-30-selection-workflow/research/counter-persistence-cost.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
