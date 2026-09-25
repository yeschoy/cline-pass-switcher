// Bounded, isolated local-only probe. No repository operator data, raw capture or external network.
// Run: env -u CLINE_PASS_KEY -u PROXY_KEY -u PUBLIC_BASE_URL -u PORT node .trellis/tasks/09-25-whole-service-performance/research/worst-cases.mjs [all|recover|capture|catalog]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../');
const { prepareAdminFixture, connectAdminFixture, fixtureHeaders } = await import(pathToFileURL(path.join(root, 'test/admin-fixture.js')).href);
const mode = process.argv[2] || 'all';
if (!['all', 'recover', 'capture', 'catalog'].includes(mode) || process.argv.length > 3) throw Error('expected all|recover|capture|catalog');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cps-worst-cases-'));
const servers = new Set();
let child = null;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const round = n => +n.toFixed(2);
const summary = numbers => { const a = [...numbers].sort((x, y) => x - y); return { n: a.length, p50Ms: round(a[Math.floor(a.length * .5)]), p95Ms: round(a[Math.floor(a.length * .95)]), maxMs: round(a.at(-1)) }; };
const listen = server => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => { server.off('error', reject); servers.add(server); resolve(server.address().port); });
});
async function freePort() { const server = http.createServer(), port = await listen(server); await new Promise(resolve => server.close(resolve)); servers.delete(server); return port; }
const stop = async () => {
  if (!child) return;
  const running = child; child = null;
  if (running.exitCode !== null || running.signalCode !== null) return;
  running.kill('SIGTERM');
  await new Promise(resolve => { const timer=setTimeout(()=>{if(running.exitCode===null)running.kill('SIGKILL');resolve();},3500);running.once('exit',()=>{clearTimeout(timer);resolve();}); });
};
// Process exit is also a safety net if a setup assertion throws outside an awaited finally.
process.once('exit', () => { if (child) child.kill('SIGKILL'); try { fs.rmSync(temp, { recursive: true, force: true }); } catch {} });
const ioPrelude = `import { monitorEventLoopDelay as __monitor } from 'node:perf_hooks';
import __fs from 'node:fs';
const __loop=__monitor({resolution:1});__loop.enable();let __cpu=process.cpuUsage();let __peak=0;
const __timer=setInterval(()=>{__peak=Math.max(__peak,process.memoryUsage().rss)},10);__timer.unref();
globalThis.__cpsIo={calls:0,waitMs:0};
globalThis.__cpsMetrics=(reset=false)=>{const cpu=process.cpuUsage(__cpu),mem=process.memoryUsage();const out={cpuMs:(cpu.user+cpu.system)/1000,loopMaxMs:__loop.max/1e6,rssMiB:mem.rss/1048576,rssPeakMiB:Math.max(__peak,mem.rss)/1048576,heapMiB:mem.heapUsed/1048576,io:{...globalThis.__cpsIo}};if(reset){__cpu=process.cpuUsage();__loop.reset();__peak=mem.rss;globalThis.__cpsIo={calls:0,waitMs:0};}return out;};
`;
const ioHook = `const __slowIo = async (filename) => { if (process.env.CPS_SLOW_IO !== '1') return;
 const name=String(filename);if (!(name.includes('/logs/') && name.endsWith('.jsonl') || name.includes('/detailed-logs/') && name.endsWith('/manifest.json'))) return;
 globalThis.__cpsIo.calls++;if(name.endsWith('/manifest.json') && globalThis.__cpsIo.calls%16!==0)return;
 const start=performance.now();await new Promise(resolve=>setTimeout(resolve,2));globalThis.__cpsIo.waitMs+=performance.now()-start;
};
`;
function makeProgram(label) {
  const dir = path.join(temp, `program-${label}`), lib = path.join(dir, 'lib');
  fs.mkdirSync(lib, { recursive: true });
  for (const name of ['public', 'node_modules']) fs.symlinkSync(path.join(root, name), path.join(dir, name), 'dir');
  for (const name of fs.readdirSync(path.join(root, 'lib'))) {
    const src = path.join(root, 'lib', name), dest = path.join(lib, name);
    if (name === 'jsonl-log-store.js' || name === 'detailed-log-store.js') {
      let code = fs.readFileSync(src, 'utf8');
      const importLine = name === 'jsonl-log-store.js' ? "import fsp from 'node:fs/promises';" : "import fs from 'node:fs/promises';";
      const variable = name === 'jsonl-log-store.js' ? 'fsp' : 'fs';
      if (!code.startsWith(importLine)) throw Error('storage import seam changed');
      code = code.replace(importLine, `${importLine.replace(`import ${variable}`, `import __nativeFs`)}\nimport { performance } from 'node:perf_hooks';\n${ioHook}\nconst ${variable}=new Proxy(__nativeFs,{get(target,key){if(key==='open')return async (filename,...args)=>{const handle=await target.open(filename,...args);const read=handle.readFile.bind(handle);handle.readFile=async (...opts)=>{await __slowIo(filename);return read(...opts);};return handle;};if(key==='readFile')return async (filename,...args)=>{await __slowIo(filename);return target.readFile(filename,...args);};return Reflect.get(target,key);}});`);
      fs.writeFileSync(dest, code);
    } else fs.symlinkSync(src, dest);
  }
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
  const source = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const seam = "    if (req.method === 'GET' && p === '/api/meta') {";
  if (source.split(seam).length !== 2) throw Error('probe endpoint seam changed');
  const localEndpoint = `    if (req.method === 'GET' && p === '/__local_performance' && req.headers['x-probe-token'] === process.env.CPS_PROBE_TOKEN && req.socket.remoteAddress === '127.0.0.1') return sendJSON(res,200,globalThis.__cpsMetrics(url.searchParams.has('reset')));\n`;
  fs.writeFileSync(path.join(dir, 'server.js'), ioPrelude + source.replace(seam, localEndpoint + seam));
  return dir;
}
async function start(label, stateDir, upstreamPort, slow = false) {
  const port = await freePort(), program = makeProgram(label), token = randomUUID();
  const config = { port, proxyKey: 'fictional-client-key', upstreamBase: `http://127.0.0.1:${upstreamPort}/api/v1`, knownModels: ['synthetic-model'], detailedLogging: false, errorDetailLogging: false, rawBodyLogging: false,
    accounts: [{ id:'synthetic', name:'Synthetic', key:'fictional-upstream-key', enabled:true, maxConcurrent:0, perModel:{} }], accountMode:'single', accountPipeline:{quotaPool:false,healthSort:false,sticky:false} };
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify(config), { mode:0o600 });
  prepareAdminFixture(stateDir);
  let output = ''; const begun=performance.now();
  child=spawn(process.execPath,[path.join(program,'server.js')],{cwd:program,env:{PATH:process.env.PATH||'',HOME:temp,DATA_DIR:stateDir,PORT:String(port),BIND_HOST:'127.0.0.1',CPS_PROBE_TOKEN:token,CPS_SLOW_IO:slow?'1':'0'},stdio:['ignore','pipe','pipe']});
  for (const stream of [child.stdout,child.stderr]) stream.on('data', buffer => { output=(output+buffer.toString()).slice(-2048); });
  while (!output.includes('OpenAI 兼容代理地址') && child.exitCode===null && performance.now()-begun<15000) await pause(10);
  if (!output.includes('OpenAI 兼容代理地址')) throw Error(`local startup failed (${output.replace(/[^a-zA-Z0-9 .:]/g,' ').slice(-160)})`);
  const listenMs = round(performance.now()-begun);
  await connectAdminFixture(port);
  return { port, token, listenMs, loginMs:round(performance.now()-begun-listenMs) };
}
async function request(session, route, options={}) {
  const at=performance.now(), res=await fetch(`http://127.0.0.1:${session.port}${route}`,{signal:AbortSignal.timeout(15000),...options});
  const text=await res.text();return { status:res.status, ms:round(performance.now()-at), bytes:Buffer.byteLength(text), ...(options.parse?{json:JSON.parse(text)}:{}) };
}
const admin = (s,route,options={}) => request(s,route,{...options,headers:fixtureHeaders(s.port,route,options.method||'GET',options.headers||{})});
const metrics = (s,reset=false) => request(s,`/__local_performance${reset?'?reset=1':''}`,{headers:{'x-probe-token':s.token},parse:true}).then(r=>r.json);
const chat = (s,body) => request(s,'/v1/chat/completions',{method:'POST',headers:{Authorization:'Bearer fictional-client-key','Content-Type':'application/json'},body:JSON.stringify({model:'synthetic-model',messages:[{role:'user',content:body}]})});
async function repeat(n,work) { const rows=[];for(let i=0;i<n;i++)rows.push(await work(i));return summary(rows.map(row=>row.ms)); }
async function waitReady(s, route, timeoutMs=14000) {
  const at=performance.now();let first=null,last=null,failures=0;
  do { last=await admin(s,route);first ||= last.status;if(last.status===200)return {first,status:last.status,ms:round(performance.now()-at),failures};if(last.status!==503)throw Error(`${route} recovery HTTP ${last.status}`);failures++;await pause(20); } while(performance.now()-at<timeoutMs);
  throw Error(`${route} still unavailable after ${timeoutMs} ms`);
}
function seed(stateDir) {
  const ordinary=path.join(stateDir,'logs'), details=path.join(stateDir,'detailed-logs');fs.mkdirSync(ordinary);fs.mkdirSync(details);
  const now=Date.now(), requests=49000, errors=9000, roots=5000, perSegment=1000;
  const line = (kind,i) => JSON.stringify(kind==='requests' ? {ts:now-i,requestId:`synthetic-request-${i}`,requestedModel:'synthetic-model',resolvedModel:'synthetic-model',status:200,result:'success',durationMs:2,selectionReason:'single',targetProviders:['mock'],extra:'x'.repeat(160)} : {ts:now-i,requestId:`synthetic-error-${i}`,attemptIndex:0,status:503,category:'upstream',reason:'synthetic failure',extra:'y'.repeat(160)})+'\n';
  let ordinaryBytes=0;
  for (const [kind,count] of [['requests',requests],['errors',errors]]) for(let start=0;start<count;start+=perSegment){
    let data='';for(let i=start;i<Math.min(start+perSegment,count);i++)data+=line(kind,i);
    fs.writeFileSync(path.join(ordinary,`${kind}-${now}-${String(start).padStart(6,'0')}.jsonl`),data,{mode:0o600});ordinaryBytes+=Buffer.byteLength(data);
  }
  for(let i=0;i<roots;i++){
    const id=randomUUID(),dir=path.join(details,id);fs.mkdirSync(dir,{mode:0o700});
    fs.writeFileSync(path.join(dir,'manifest.json'),JSON.stringify({request:{requestId:id,ts:now-i,method:'POST',pathname:'/v1/chat/completions',profile:'full',model:'synthetic-model',accounts:['synthetic'],status:200,result:'success',complete:true,state:'complete',attemptCount:0},attempts:[],bodies:[]}),{mode:0o600});
  }
  return { requests,errors,roots,ordinaryBytes,segments:Math.ceil(requests/perSegment)+Math.ceil(errors/perSegment),percentRecordRetention:{requests:98,errors:90},percentDetailInventoryEntries:5 };
}
async function recover(upstreamPort) {
  const state=path.join(temp,'recover-state');fs.mkdirSync(state);
  const corpus=seed(state),cases=[];
  for(const slow of [false,true]){
    const s=await start(`recovery-${slow}`,state,upstreamPort,slow);
    try{
      const firstOrdinary=await admin(s,'/api/logs/requests?limit=20');
      const firstDetail=admin(s,'/api/logs/details?limit=20');
      const concurrentChat=await Promise.all(Array.from({length:6},()=>chat(s,'synthetic small')));
      if(concurrentChat.some(r=>r.status!==200))throw Error('chat failed during cold recovery');
      const detail=await firstDetail;if(detail.status!==200)throw Error(`detailed recovery HTTP ${detail.status}`);
      const ready=await waitReady(s,'/api/logs/requests?limit=20');
      const query={ordinaryFirst:await repeat(5,()=>admin(s,'/api/logs/requests?limit=20')),ordinaryAbsent:await repeat(5,()=>admin(s,'/api/logs/requests?limit=20&model=absent-model')),detailFirst:await repeat(5,()=>admin(s,'/api/logs/details?limit=20')),detailAbsent:await repeat(5,()=>admin(s,'/api/logs/details?limit=20&model=absent-model'))};
      cases.push({slow,listenMs:s.listenMs,loginMs:s.loginMs,firstOrdinaryStatus:firstOrdinary.status,firstDetailWaitMs:detail.ms,ordinaryReady:ready,concurrentChat:summary(concurrentChat.map(r=>r.ms)),query,process:await metrics(s)});
      if(![200,503].includes(firstOrdinary.status) || !ready.status)throw Error('untruthful cold query');
    }finally{await stop();}
  }
  return {corpus,cases, injection:'copy-only readFile delay 2 ms on every ordinary segment and every 16th detailed manifest; wait accounted by process metrics; seed time excluded'};
}
async function capture(upstreamPort, mock) {
  const state=path.join(temp,'capture-state');fs.mkdirSync(state);
  const s=await start('capture',state,upstreamPort);
  const content='x'.repeat(5*1024*1024-4096),bodyBytes=Buffer.byteLength(JSON.stringify({model:'synthetic-model',messages:[{role:'user',content}]}));
  const modes=[];
  try {
    await waitReady(s,'/api/logs/requests?limit=1');
    for (const [label,settings,fail] of [['off',{detailedLogging:false,errorDetailLogging:false},false],['error-success',{detailedLogging:false,errorDetailLogging:true},false],['error-failure',{detailedLogging:false,errorDetailLogging:true},true],['full',{detailedLogging:true,errorDetailLogging:false},false]]) {
      const saved=await admin(s,'/api/logs/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(settings),parse:true});
      if(saved.status!==200 || saved.json.rawBodyLogging!==false)throw Error('sanitized settings not saved');
      mock.chatFailure=fail;
      await metrics(s,true);
      const rows=[];
      for(let i=0;i<5;i++){const row=await chat(s,content);if(row.status!==(fail?503:200))throw Error(`${label} chat HTTP ${row.status}`);rows.push(row.ms);}
      // Publication is asynchronous. Poll for the expected count, but do not count this as chat latency.
      const expected=label==='error-failure'||label==='full'?5:0;
      const began=performance.now();let listed;
      do {listed=await admin(s,'/api/logs/details?limit=200',{parse:true});if(listed.status!==200)throw Error('detail list failed');if(listed.json.items.length>=modes.reduce((n,m)=>n+m.expected,0)+expected)break;await pause(15);}while(performance.now()-began<10000);
      const settingsRead=await admin(s,'/api/logs/settings',{parse:true});
      const health=settingsRead.json.health;
      if(settingsRead.status!==200 || listed.json.items.length!==modes.reduce((n,m)=>n+m.expected,0)+expected || health.retainedPayloadBytes!==0 || Object.values(health.dropReasons).reduce((a,b)=>a+b,0)!==health.dropped)throw Error(`capture admission/publication failure in ${label}: list=${listed.json.items.length} expected=${modes.reduce((n,m)=>n+m.expected,0)+expected} health=${JSON.stringify(health)}`);
      modes.push({label,expected,chat:summary(rows),metrics:await metrics(s),health:{dropped:health.dropped,dropReasons:health.dropReasons,captureDropped:health.captureDropped,retainedPayloadBytes:health.retainedPayloadBytes},details:listed.json.items.length});
    }
    const listed=await admin(s,'/api/logs/details?limit=200',{parse:true});
    if(listed.json.items.some(r=>r.profile!=='full'&&r.profile!=='error'))throw Error('unsafe profile');
    const profiles={};
    for(const row of listed.json.items){
      const detail=await admin(s,`/api/logs/details/${row.requestId}`,{parse:true});
      if(detail.status!==200 || detail.json.bodies.some(b=>b.redacted!==true))throw Error('unsafe or unavailable sanitized manifest');
      const entry=profiles[row.profile] ||= {roots:0,bodyStates:{},maxCapturedBytes:0,largeCompleteBodies:0};entry.roots++;
      for(const b of detail.json.bodies){entry.bodyStates[b.state]=(entry.bodyStates[b.state]||0)+1;entry.maxCapturedBytes=Math.max(entry.maxCapturedBytes,b.capturedBytes);if(b.capturedBytes>=4.9*1048576&&!b.truncated&&b.complete)entry.largeCompleteBodies++;}
    }
    if(profiles.full?.roots!==5 || profiles.error?.roots!==5)throw Error('detail profile counts mismatch');
    const rawDir=path.join(state,'detailed-logs','raw');if(fs.readdirSync(rawDir).length)throw Error('raw data unexpectedly retained');
    return {bodyBytes,bodyMiB:round(bodyBytes/1048576),requestsPerMode:5,modes,profiles,rawFiles:0};
  }finally{mock.chatFailure=false;await stop();}
}
async function catalog(upstreamPort,mock) {
  const state=path.join(temp,'catalog-state');fs.mkdirSync(state);
  const s=await start('catalog',state,upstreamPort);
  try{
    mock.catalogFailure=true;mock.catalogDelay=80;
    const before=mock.models,failed=await admin(s,'/api/models');
    if(failed.status!==200 || mock.models-before!==1)throw Error('cold catalog failure path changed');
    const afterFailure=JSON.parse(fs.readFileSync(path.join(state,'metadata.json'),'utf8'));
    const failedCacheAbsent=!afterFailure.catalog;
    if(!failedCacheAbsent)throw Error('failed catalog unexpectedly cached');
    mock.catalogFailure=false;mock.catalogDelay=200;
    const run=async n=>{const rows=await Promise.all(Array.from({length:n},()=>admin(s,'/api/models')));if(rows.some(r=>r.status!==200))throw Error('catalog GET failed');return summary(rows.map(r=>r.ms));};
    await metrics(s,true);
    const startHits=mock.models,cold=await run(12),coldMetrics=await metrics(s,true),coldCalls=mock.models-startHits;
    const warm=await run(12),warmMetrics=await metrics(s),warmCalls=mock.models-startHits-coldCalls;
    const meta=JSON.parse(fs.readFileSync(path.join(state,'metadata.json'),'utf8'));
    if(coldCalls<1 || coldCalls>12 || warmCalls!==0 || !Array.isArray(meta.catalog) || meta.catalog.length!==10)throw Error('catalog calls/cache count inconsistent');
    return {upstreamDelayMs:200,failedMockStatus:503,failedApiStatus:failed.status,failedCacheAbsentBeforeRetry:failedCacheAbsent,concurrent:12,cold:{latency:cold,mockCalls:coldCalls,local:coldMetrics},warm:{latency:warm,mockCalls:warmCalls,local:warmMetrics}};
  }finally{mock.catalogFailure=false;await stop();}
}
try {
  const mock={models:0,chats:0,chatFailure:false,catalogFailure:false,catalogDelay:0};
  const upstream=http.createServer((req,res)=>{
    req.resume();req.on('end',()=>{
      res.setHeader('Content-Type','application/json');
      if(req.url.endsWith('/models')) { mock.models++;const fail=mock.catalogFailure,delay=mock.catalogDelay;return setTimeout(()=>{res.statusCode=fail?503:200;res.end(fail?'{}':JSON.stringify({data:Array.from({length:10},(_,i)=>({id:`synthetic-${i}`}))}));},delay); }
      mock.chats++;res.statusCode=mock.chatFailure?503:200;res.end(mock.chatFailure?'{"error":{"message":"synthetic unavailable"}}':'{"choices":[{"message":{"content":"ok"}}],"usage":{"prompt_tokens":1,"completion_tokens":0,"total_tokens":1}}');
    });
  });
  const port=await listen(upstream);
  const result={kind:'bounded-local-worst-cases',node:process.version,mode,limits:'ordinary 49k/9k records, detailed 5k roots, 5 serial 5 MiB chats per mode, 12 concurrent catalog GETs; no raw or external requests'};
  if(['all','recover'].includes(mode))result.recovery=await recover(port);
  if(['all','capture'].includes(mode))result.capture=await capture(port,mock);
  if(['all','catalog'].includes(mode))result.catalog=await catalog(port,mock);
  console.log(JSON.stringify(result,null,2));
}finally{
  await stop();for(const server of servers) { server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve)); }
  fs.rmSync(temp,{recursive:true,force:true});
}
