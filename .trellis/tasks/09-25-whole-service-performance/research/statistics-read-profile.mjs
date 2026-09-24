// Local-only GET /api/statistics source profile. Synthetic v5 fixtures are never retained.
// Run: env -u CLINE_PASS_KEY -u PROXY_KEY -u PUBLIC_BASE_URL -u PORT node .trellis/tasks/09-25-whole-service-performance/research/statistics-read-profile.mjs [--ref=6abd3a0]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../');
const { prepareAdminFixture, connectAdminFixture, fixtureHeaders } = await import(pathToFileURL(path.join(root, 'test/admin-fixture.js')).href);
const ref = process.argv.find(arg => arg.startsWith('--ref='))?.slice(6);
if (ref && !/^[0-9a-f]{7,40}$/.test(ref)) throw Error('expected explicit commit SHA');
let source = ref ? execFileSync('git', ['show', `${ref}:server.js`], { cwd: root, encoding: 'utf8' }) : fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const instrument = `import { performance as perf, monitorEventLoopDelay } from 'node:perf_hooks';
const samples = {}, frames = [], delay = monitorEventLoopDelay({resolution:1}); delay.enable();
const startCpu = process.cpuUsage();
function measured(name, work) {
  const frame = { start: perf.now(), child: 0 }; frames.push(frame);
  try { return work(); } finally {
    frames.pop(); const inclusive = perf.now() - frame.start;
    if (frames.length) frames.at(-1).child += inclusive;
    const row = samples[name] ||= { n:0, totalMs:0, selfMs:0, maxMs:0 };
    row.n++; row.totalMs += inclusive; row.selfMs += inclusive - frame.child; row.maxMs = Math.max(row.maxMs, inclusive);
  }
}
process.on('exit', () => { const cpu=process.cpuUsage(startCpu), mem=process.memoryUsage(); fs.writeFileSync(process.env.CPS_PERF_FILE, JSON.stringify({sections:samples, cpuMs:(cpu.user+cpu.system)/1000, loopMaxMs:delay.max/1e6, rssMiB:mem.rss/1048576, heapMiB:mem.heapUsed/1048576})); });\n`;
for (const name of ['pruneStatistics','aggregateRange','aggregateModelRange','statisticsModelIds','modelProviderProjection','providerUsageProjection','successHealthProjection','aggregateSuccessHealth','sendJSON']) {
  const seam = `function ${name}(`;
  if (!source.includes(seam) && name === 'providerUsageProjection') continue; // removed by the single-pass projection
  if (source.split(seam).length !== 2) throw Error(`cannot instrument ${name}`);
  source = source.replace(seam, `function original_${name}(`);
  source += `\nfunction ${name}(...args) { return measured('${name}', () => original_${name}(...args)); }\n`;
}
const route = "const generatedAt = Date.now(), recentGlobal = aggregateRange().aggregate;";
const modelLine = "const models = statisticsModelIds().map((id) => { const recent24h = projectAggregate(aggregateModelRange(id, generatedAt)); return { id, recent24h, coverage: modelCoverage(id, generatedAt), providerStatistics: modelProviderProjection(id,generatedAt) }; });";
const accountLine = "const accounts = config.accounts.map((account) => { const recent = aggregateRange(account.id).aggregate; return { id: account.id, name: account.name, enabled: account.enabled !== false, lifetime: projectAggregate(META.statistics.lifetime.accounts[account.id] || emptyAggregate()), recent24h: projectAggregate(recent), health: healthProjection(account), quota: statisticsQuotaProjection(account, generatedAt) }; });";
for (const [seam, replacement] of [[route,"const generatedAt = Date.now(), recentGlobal = measured('route.global', () => aggregateRange().aggregate);"],[modelLine,`const models = measured('route.models', () => ${modelLine.slice('const models = '.length, -1)});`],[accountLine,`const accounts = measured('route.accounts', () => ${accountLine.slice('const accounts = '.length, -1)});`]]) {
  if (!source.includes(seam)) throw Error(`route seam changed: ${seam.slice(0,40)}`);
  source = source.replace(seam,replacement);
}
const sendSeam = 'res.end(JSON.stringify(obj));';
if (!source.includes(sendSeam)) throw Error('sendJSON stringify seam changed');
source = source.replace(sendSeam,"res.end(measured('response.stringify', () => JSON.stringify(obj)));");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cps-statistics-read-'));
let child;
process.once('exit', () => {
  try { child?.kill('SIGKILL'); } catch {}
  try { fs.rmSync(temp, {recursive:true, force:true}); } catch {}
});
for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) process.once(signal, () => process.exit(code));
const program = path.join(temp, 'program'); fs.mkdirSync(program);
for (const item of ['lib','public','node_modules']) fs.symlinkSync(path.join(root,item),path.join(program,item),'dir');
fs.writeFileSync(path.join(program,'package.json'),'{"type":"module"}');
fs.writeFileSync(path.join(program,'server.js'),instrument+source);
const listen = server => new Promise(resolve => server.listen(0,'127.0.0.1',()=>resolve(server.address().port)));
const close = server => new Promise(resolve => server.close(resolve));
const mock = http.createServer((req,res) => { req.resume(); req.on('end',()=> { res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({choices:[{message:{content:'ok',provider_metadata:{gateway:{routing:{finalProvider:'one'}}}}}],usage:{prompt_tokens:0,completion_tokens:1,prompt_tokens_details:{cached_tokens:0}}})); }); });
const models = ['cline-pass/kimi-k3','cline-pass/glm-5.3','cline-pass/deepseek-v4-flash','cline-pass/deepseek-v4-pro'];
const quantiles = values => { const sorted=[...values].sort((a,b)=>a-b); return {n:sorted.length,p50:+sorted[Math.floor(sorted.length*.5)].toFixed(2),p95:+sorted[Math.floor(sorted.length*.95)].toFixed(2),max:+sorted.at(-1).toFixed(2)}; };
async function stop() {
  if (!child) return;
  const active=child; child=null;
  if (active.exitCode!==null || active.signalCode!==null) return;
  await new Promise(resolve => {
    const timer=setTimeout(()=>active.kill('SIGKILL'),5000);
    active.once('exit',()=>{clearTimeout(timer);resolve();});
    active.kill('SIGTERM');
  });
}
try {
  const mockPort = await listen(mock), reserved=http.createServer(), port=await listen(reserved); await close(reserved);
  const dir=path.join(temp,'state'); fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir,'config.json'), JSON.stringify({port,proxyKey:'synthetic-client-only',upstreamBase:`http://127.0.0.1:${mockPort}`,knownModels:models,accounts:[{id:'synthetic',name:'Synthetic',key:'synthetic-upstream-only',enabled:true,maxRpm:0,maxConcurrent:0,perModel:{}}],accountMode:'single',perModel:Object.fromEntries(models.map(id=>[id,{upstreams:['one']}]))}));
  prepareAdminFixture(dir);
  const start = async label => {
    let output=''; const begun=performance.now();
    child=spawn(process.execPath,[path.join(program,'server.js')],{cwd:root,env:{PATH:process.env.PATH||'',DATA_DIR:dir,BIND_HOST:'127.0.0.1',PORT:String(port),CPS_PERF_FILE:path.join(temp,`${label}.json`)},stdio:['ignore','pipe','pipe']});
    child.stdout.on('data',b=>{output+=b;}); child.stderr.on('data',b=>{output+=b;});
    while (!output.includes('OpenAI 兼容代理地址') && child.exitCode===null && performance.now()-begun<15000) await new Promise(resolve=>setTimeout(resolve,15));
    if (!output.includes('OpenAI 兼容代理地址')) throw Error(`synthetic start failed: ${output.slice(0,200)}`);
    await connectAdminFixture(port); return performance.now()-begun;
  };
  await start('seed');
  const chat = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer synthetic-client-only'},body:JSON.stringify({model:models[0],messages:[{role:'user',content:'synthetic'}]})});
  if (chat.status!==200) throw Error(`synthetic seed chat: ${chat.status}`);
  await chat.arrayBuffer(); await stop();
  const base = JSON.parse(fs.readFileSync(path.join(dir,'metadata.json'))), seed=base.statistics.minuteBuckets.at(-1);
  // Clone only schema-valid native v5 cells, with bounded cardinality (max 1200 * 12 < 50k per owner).
  const cases=[['sparse-1x1',1,1,1],['dense-1x1',1200,1,1],['sparse-4x3',1,4,3],['dense-4x3',1200,4,3]];
  const output=[];
  for (const [label,count,modelCount,providerCount] of cases) {
    const metadata=structuredClone(base), minute=Math.floor(Date.now()/60000);
    const buckets=Array.from({length:count},(_,index)=> {
      const b=structuredClone(seed); b.minute=minute-count+1+index;
      b.models={}; b.modelFinal={}; b.providerHealth={}; b.providerUsage={}; b.valuation={};
      for (const id of models.slice(0,modelCount)) {
        b.models[id]=structuredClone(seed.models[models[0]]);
        b.modelFinal[id]=structuredClone(seed.modelFinal[models[0]]);
        b.providerHealth[id]={}; b.providerUsage[id]={};
        for (let p=0;p<providerCount;p++) {
          const slug=p===0?'one':`synthetic-${p}`;
          b.providerHealth[id][slug]=structuredClone(seed.providerHealth[models[0]].one);
          b.providerUsage[id][slug]=structuredClone(seed.providerUsage[models[0]].one);
        }
        if (id===models[0] && seed.valuation[models[0]]) b.valuation[id]=structuredClone(seed.valuation[models[0]]);
      }
      return b;
    });
    metadata.statistics.minuteBuckets=buckets;
    fs.writeFileSync(path.join(dir,'metadata.json'),JSON.stringify(metadata));
    const metadataBytes=fs.statSync(path.join(dir,'metadata.json')).size;
    const startupMs=await start(label);
    const read=async()=>{const t=performance.now(),res=await fetch(`http://127.0.0.1:${port}/api/statistics`,{headers:fixtureHeaders(port,'/api/statistics')}); const body=await res.arrayBuffer(); if(res.status!==200)throw Error(`GET statistics: ${res.status}`);return {ms:performance.now()-t,body:body.byteLength};};
    for(let i=0;i<3;i++) await read();
    const times=[];let bytes=0;for(let i=0;i<24;i++){const result=await read();times.push(result.ms);bytes=result.body;}
    await stop();
    output.push({label,metadataBytes,modelCount,providerCount,startupMs:+startupMs.toFixed(2),responseBytes:bytes,latencyMs:quantiles(times),server:JSON.parse(fs.readFileSync(path.join(temp,`${label}.json`)))});
  }
  console.log(JSON.stringify({kind:'statistics-read-local-v5',node:process.version,ref:ref||'working-tree',cases:output,caveat:'24 sequential warmed loopback GETs, sample instrumentation inclusive/exclusive, CPU/loop/memory whole child incl startup; 1200 cloned schema-valid v5 buckets, not real workload.'},null,2));
} finally { await stop(); await close(mock); fs.rmSync(temp,{recursive:true,force:true}); }
