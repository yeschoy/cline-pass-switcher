// Local-only synthetic probe; touches only a disposable DATA_DIR and loopback listeners.
// Run: env -u CLINE_PASS_KEY -u PROXY_KEY -u PUBLIC_BASE_URL -u PORT node .trellis/tasks/09-25-whole-service-performance/research/remaining-flows.mjs [logs|quota|proxy|all]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../');
const { JsonlLogGroup } = await import(pathToFileURL(path.join(root, 'lib/jsonl-log-store.js')).href);
const { DetailedLogStore } = await import(pathToFileURL(path.join(root, 'lib/detailed-log-store.js')).href);
const { prepareAdminFixture, connectAdminFixture, fixtureHeaders } = await import(pathToFileURL(path.join(root, 'test/admin-fixture.js')).href);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cps-remaining-flows-'));
const servers = [], sockets = new Set();
let child = null;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const listen = server => new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); servers.push(server); resolve(server.address().port); }); });
const stop = async () => {
  if (!child) return;
  const running = child; child = null;
  if (running.exitCode === null && running.signalCode === null) {
    running.kill('SIGTERM');
    await Promise.race([new Promise(resolve => running.once('exit', resolve)), pause(5000).then(() => { running.kill('SIGKILL'); })]);
  }
};
const measure = async fn => { const cpu = process.cpuUsage(), at = performance.now(), value = await fn(), elapsed = performance.now() - at, delta = process.cpuUsage(cpu); return { wallMs: +elapsed.toFixed(2), cpuMs: +((delta.user + delta.system) / 1000).toFixed(2), value }; };
const summary = rows => { const x = [...rows].sort((a,b)=>a-b); return { n:x.length, p50Ms:+x[Math.floor(x.length*.5)].toFixed(2), p95Ms:+x[Math.floor(x.length*.95)].toFixed(2), maxMs:+x.at(-1).toFixed(2) }; };
async function logs() {
  const result = [];
  // Two independently restarted stores over identical valid synthetic files; fixture writes are excluded from recovery timers.
  for (const [requests, errors, details] of [[1000, 100, 100], [30000, 3000, 2000]]) {
    const dir = path.join(temp, `logs-${requests}`), ordinary = path.join(dir, 'logs'), detailed = path.join(dir, 'detailed-logs');
    fs.mkdirSync(ordinary, { recursive:true }); fs.mkdirSync(detailed); fs.mkdirSync(path.join(detailed,'raw'));
    const now = Date.now(), reqRows = [], errRows = [];
    for (let i=0; i<requests; i++) reqRows.push(JSON.stringify({ts:now-i,requestId:`synthetic-${i}`,requestedModel:i%5?'synthetic-model':'rare-model',resolvedModel:'synthetic-model',status:200,result:'success',durationMs:2})+'\n');
    for (let i=0; i<errors; i++) errRows.push(JSON.stringify({ts:now-i,requestId:`synthetic-err-${i}`,attemptIndex:0,status:503,category:'upstream',reason:'synthetic unavailable'})+'\n');
    const segments = (prefix,rows,per=1000) => { for(let i=0;i<rows.length;i+=per) fs.writeFileSync(path.join(ordinary,`${prefix}-${now}-${String(i).padStart(6,'0')}.jsonl`),rows.slice(i,i+per).join(''),{mode:0o600}); };
    segments('requests',reqRows); segments('errors',errRows);
    const detailIds=[];
    for (let i=0;i<details;i++) {
      const id=randomUUID(), folder=path.join(detailed,id); detailIds.push(id); fs.mkdirSync(folder);
      fs.writeFileSync(path.join(folder,'manifest.json'),JSON.stringify({request:{requestId:id,ts:now-i,method:'POST',pathname:'/v1/chat/completions',profile:'full',model:i%5?'synthetic-model':'rare-model',accounts:['synthetic'],status:200,result:'success',complete:true,state:'complete',attemptCount:0},attempts:[],bodies:[]}),{mode:0o600});
    }
    const loop = monitorEventLoopDelay({resolution:1}); loop.enable(); let group, store;
    try {
      const ready = await measure(async () => {
        const begin = performance.now();
        group = new JsonlLogGroup({dir:ordinary,streams:{requests:{maxRecords:50000},errors:{maxRecords:10000}},maxTotalBytes:100*1024*1024});
        store = new DetailedLogStore({dir:detailed});
        const [ordinaryReadyMs, detailReadyMs] = await Promise.all([group.ready.then(()=>performance.now()-begin),store.queue.then(()=>performance.now()-begin)]);
        return {ordinaryReadyMs:+ordinaryReadyMs.toFixed(2),detailReadyMs:+detailReadyMs.toFixed(2),ordinaryStatus:group.status,detailReady:store.ready,ordinarySegments:group.files('requests').length+group.files('errors').length,detailEntries:store.entries.size};
      });
      const ordinaryPage=[], ordinaryRare=[], detailPage=[], detailRare=[], detailId=[];
      for(let i=0;i<12;i++) {
        ordinaryPage.push(await measure(()=>group.query('requests',{limit:20})));
        ordinaryRare.push(await measure(()=>group.query('requests',{limit:20,filters:{requestedModel:'absent-model'}})));
        detailPage.push(await measure(()=>store.query({limit:20})));
        detailRare.push(await measure(()=>store.query({limit:20,model:'absent-model'})));
        detailId.push(await measure(()=>store.detail(detailIds[0])));
      }
      const brief = rows => ({wall:summary(rows.map(r=>r.wallMs)),cpu:summary(rows.map(r=>r.cpuMs)),items:rows[0].value.items?.length});
      result.push({requests,errors,details,ordinaryBytes:reqRows.reduce((n,s)=>n+Buffer.byteLength(s),0)+errRows.reduce((n,s)=>n+Buffer.byteLength(s),0),ready,query:{ordinaryFirst:brief(ordinaryPage),ordinaryAbsent:brief(ordinaryRare),detailFirst:brief(detailPage),detailAbsent:brief(detailRare),detailExact:{wall:summary(detailId.map(r=>r.wallMs)),cpu:summary(detailId.map(r=>r.cpuMs))}},loopMaxMs:+(loop.max/1e6).toFixed(2),heapMiB:+(process.memoryUsage().heapUsed/1048576).toFixed(1)});
    } finally { loop.disable(); await Promise.allSettled([group?.close(),store?.close()]); }
    if (requests === 30000) {
      const mock = http.createServer((req,res)=>{req.resume();req.on('end',()=>{res.setHeader('Content-Type','application/json');res.end('{"choices":[{"message":{"content":"ok"}}]}');});});
      const upstreamPort = await listen(mock), port=await freePort();
      const config={port,proxyKey:'synthetic-client-key',upstreamBase:`http://127.0.0.1:${upstreamPort}/api/v1`,knownModels:['synthetic-model'],accounts:[{id:'synthetic',name:'Synthetic',key:'synthetic-account',enabled:true,perModel:{}}]};
      const session=await startService(config,'log-restart',{},dir);
      try {
        const initial=await request(port,'/api/logs/requests?limit=20',{headers:fixtureHeaders(port,'/api/logs/requests')});
        const chatDuring=await chat(port);
        const detailPage=await request(port,'/api/logs/details?limit=20',{headers:fixtureHeaders(port,'/api/logs/details')});
        let last=initial, polls=0;
        while(last.status===503&&polls++<100) {await pause(10);last=await request(port,'/api/logs/requests?limit=20',{headers:fixtureHeaders(port,'/api/logs/requests')});}
        if(last.status!==200 || detailPage.status!==200 || chatDuring.status!==200) throw Error(`log service smoke ${last.status}/${detailPage.status}/${chatDuring.status}`);
        result.at(-1).service={bootAndLoginMs:session.bootMs,ordinaryFirstStatus:initial.status,ordinaryAfterStatus:last.status,ordinary503Polls:polls,detailStatus:detailPage.status,detailWaitMs:+detailPage.ms.toFixed(2),chatStatus:chatDuring.status,chatMs:+chatDuring.ms.toFixed(2)};
      } finally {await stop();result.at(-1).service.process=JSON.parse(fs.readFileSync(session.metricPath,'utf8'));}
    }
  }
  return result;
}
async function startService(config, label, extraEnv={}, stateDir=null) {
  const dir = stateDir || path.join(temp, `service-${label}`); if (!stateDir) fs.mkdirSync(dir);
  const program = path.join(temp, `program-${label}`); fs.mkdirSync(program);
  for (const name of ['lib','public','node_modules']) fs.symlinkSync(path.join(root,name),path.join(program,name),'dir');
  fs.writeFileSync(path.join(program,'package.json'),'{"type":"module"}');
  // Local disposable copy only: exit snapshot is process-wide (not per request or a CPU flamegraph).
  const prelude = `import { monitorEventLoopDelay as __monitor } from 'node:perf_hooks';\nimport __fs from 'node:fs';\nconst __loop=__monitor({resolution:1});__loop.enable();const __cpu=process.cpuUsage();\nprocess.on('exit',()=>{const c=process.cpuUsage(__cpu),m=process.memoryUsage();__fs.writeFileSync(process.env.CPS_METRICS,JSON.stringify({cpuMs:(c.user+c.system)/1000,loopMaxMs:__loop.max/1e6,rssMiB:m.rss/1048576,heapMiB:m.heapUsed/1048576}));});\n`;
  fs.writeFileSync(path.join(program,'server.js'),prelude + fs.readFileSync(path.join(root,'server.js'),'utf8'));
  fs.writeFileSync(path.join(dir,'config.json'),JSON.stringify(config),{mode:0o600}); prepareAdminFixture(dir);
  const at=performance.now(); let output='';
  child=spawn(process.execPath,[path.join(program,'server.js')],{cwd:root,env:{PATH:process.env.PATH||'',DATA_DIR:dir,PORT:String(config.port),BIND_HOST:'127.0.0.1',CPS_METRICS:path.join(temp,`metrics-${label}.json`),...extraEnv},stdio:['ignore','pipe','pipe']});
  for(const stream of [child.stdout,child.stderr]) stream.on('data',b=>{output+=b.toString().slice(0,256); output=output.slice(-1024);});
  while(!output.includes('OpenAI 兼容代理地址') && child.exitCode===null && performance.now()-at<15000) await pause(10);
  if(!output.includes('OpenAI 兼容代理地址')) throw Error(`local service did not start (${output.slice(0,250)})`);
  await connectAdminFixture(config.port);
  return {dir,bootMs:+(performance.now()-at).toFixed(2),metricPath:path.join(temp,`metrics-${label}.json`)};
}
async function freePort() { const server=http.createServer(), port=await listen(server); await new Promise(resolve=>server.close(resolve)); servers.splice(servers.indexOf(server),1); return port; }
const request = async (port, route, options={}) => { const t=performance.now(), response=await fetch(`http://127.0.0.1:${port}${route}`,options), text=await response.text(); return {status:response.status,ms:performance.now()-t,bytes:Buffer.byteLength(text)}; };
const chat = (port) => request(port,'/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer synthetic-client-key'},body:JSON.stringify({model:'synthetic-model',messages:[{role:'user',content:'synthetic small request'}]})});
async function quota() {
  const records=[]; let active=0,maxActive=0;
  const mock=http.createServer((req,res)=>{req.resume();req.on('end',()=>{
    if(req.url.includes('usage-limits')) {active++;maxActive=Math.max(maxActive,active);const hit={type:'quota',start:performance.now()};records.push(hit);return setTimeout(()=>{active--;hit.end=performance.now();res.setHeader('Content-Type','application/json');res.end(JSON.stringify({success:true,data:{limits:[{type:'five_hour',percentUsed:1},{type:'weekly',percentUsed:2},{type:'monthly',percentUsed:3}]}}));},35);}
    records.push({type:'chat',start:performance.now()});res.setHeader('Content-Type','application/json');res.end('{"choices":[{"message":{"content":"ok"}}],"usage":{"prompt_tokens":1,"completion_tokens":0,"total_tokens":1}}');
  });});
  const upstreamPort=await listen(mock), cases=[];
  for(const enabled of [false,true]) {
    const label=`quota-${enabled}`, port=await freePort(), before=records.length, count=8;
    const config={port,proxyKey:'synthetic-client-key',upstreamBase:`http://127.0.0.1:${upstreamPort}/api/v1`,knownModels:['synthetic-model'],accounts:Array.from({length:count},(_,i)=>({id:`a${i}`,name:`A${i}`,key:`synthetic-account-${i}`,enabled:true,maxConcurrent:0,perModel:{}})),accountMode:'roundrobin',accountPipeline:{quotaPool:enabled,healthSort:false,sticky:false}};
    const session=await startService(config,label,enabled?{NODE_ENV:'test',CLINE_PASS_TEST_QUOTA_SUCCESS_MS:'120'}:{});
    try {
      // Warm-up without counting its latency; a timer tick in test mode runs every 10 ms.
      const warm=await chat(port); if(warm.status!==200) throw Error(`warm chat ${warm.status}`);
      const samples=[]; const began=performance.now();
      while(performance.now()-began<1500) { const row=await chat(port); if(row.status!==200) throw Error(`chat ${row.status}`); samples.push(row.ms); await pause(12); }
      // Allow pending quota calls to settle, then inspect server-side safe projection.
      await pause(80);
      const stats=await request(port,'/api/statistics',{headers:fixtureHeaders(port,'/api/statistics')});
      if(stats.status!==200) throw Error(`stats ${stats.status}`);
      const hits=records.slice(before), quotaHits=hits.filter(r=>r.type==='quota'), finishedQuota=quotaHits.filter(r=>Number.isFinite(r.end)), chatHits=hits.filter(r=>r.type==='chat');
      cases.push({enabled,bootMs:session.bootMs,trialMs:+(performance.now()-began).toFixed(1),chat:summary(samples),statisticsGetMs:+stats.ms.toFixed(2),quotaCalls:quotaHits.length,chatCalls:chatHits.length,chatArrivalsDuringQuota:chatHits.filter(c=>quotaHits.some(q=>q.start<=c.start&&c.start<q.end)).length,quotaMockWaitMs:finishedQuota.length?summary(finishedQuota.map(q=>q.end-q.start)):null,maxConcurrentQuota:maxActive});
    } finally {await stop();cases.at(-1).process=JSON.parse(fs.readFileSync(session.metricPath,'utf8'));}
  }
  return cases;
}
async function proxy() {
  let upstreamConnections=0,httpConnects=0,socksConnects=0;
  const upstream=http.createServer((req,res)=>{req.resume();req.on('end',()=>{res.setHeader('Content-Type','application/json');res.end('{"choices":[{"message":{"content":"ok"}}]}');});});
  upstream.on('connection',s=>{upstreamConnections++;sockets.add(s);s.once('close',()=>sockets.delete(s));});
  const upstreamPort=await listen(upstream);
  const hp=http.createServer(); hp.on('connect',(req,client,head)=>{httpConnects++;const target=net.connect(upstreamPort,'127.0.0.1',()=>{setTimeout(()=>{if(client.destroyed)return;client.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)target.write(head);client.pipe(target);target.pipe(client);},8);}); for(const s of [client,target]){sockets.add(s);s.once('close',()=>sockets.delete(s));}target.on('error',()=>client.destroy());client.on('error',()=>target.destroy());});
  const hpPort=await listen(hp);
  const socks=net.createServer(client=>{socksConnects++;let buf=Buffer.alloc(0),stage=0;client.on('data',function accept(chunk){buf=Buffer.concat([buf,chunk]);if(stage===0){if(buf.length<2||buf.length<2+buf[1])return;buf=buf.subarray(2+buf[1]);client.write(Buffer.from([5,0]));stage=1;}if(stage===1){if(buf.length<10)return;const atyp=buf[3],addressLength=atyp===1?4:atyp===3?1+buf[4]:0;if(!addressLength||buf.length<4+addressLength+2)return;const p=buf.readUInt16BE(4+addressLength),left=buf.subarray(6+addressLength);buf=Buffer.alloc(0);stage=2;if(p!==upstreamPort)return client.destroy();const target=net.connect(upstreamPort,'127.0.0.1',()=>{setTimeout(()=>{if(client.destroyed)return;client.write(Buffer.from([5,0,0,1,127,0,0,1,0,0]));if(left.length)target.write(left);client.removeListener('data',accept);client.pipe(target);target.pipe(client);},8);});sockets.add(target);target.once('close',()=>sockets.delete(target));target.on('error',()=>client.destroy());}});sockets.add(client);client.once('close',()=>sockets.delete(client));client.on('error',()=>{});});
  const socksPort=await listen(socks), cases=[];
  for(const [label,url] of [['direct',''],['http-connect',`http://127.0.0.1:${hpPort}`],['socks5',`socks5://127.0.0.1:${socksPort}`]]) {
    const port=await freePort(), config={port,proxyKey:'synthetic-client-key',upstreamBase:`http://127.0.0.1:${upstreamPort}/api/v1`,knownModels:['synthetic-model'],accounts:[{id:'synthetic',name:'Synthetic',key:'synthetic-account',enabled:true,proxyUrl:url,perModel:{}}],accountMode:'single',accountPipeline:{quotaPool:false,healthSort:false,sticky:false}};
    const session=await startService(config,label);
    try {
      const before={upstreamConnections,httpConnects,socksConnects},samples=[];
      for(let i=0;i<24;i++) {const row=await chat(port);if(row.status!==200)throw Error(`${label}: HTTP ${row.status}`);samples.push(row.ms);}
      cases.push({label,firstMs:+samples[0].toFixed(2),warm:summary(samples.slice(1)),upstreamTcp:upstreamConnections-before.upstreamConnections,httpConnects:httpConnects-before.httpConnects,socksConnects:socksConnects-before.socksConnects,bootMs:session.bootMs});
    } finally { await stop(); if(cases.at(-1)?.label===label) cases.at(-1).process=JSON.parse(fs.readFileSync(session.metricPath,'utf8')); }
  }
  return cases;
}
try {
  const mode=process.argv[2]||'all';if(!['logs','quota','proxy','all'].includes(mode))throw Error('expected logs|quota|proxy|all');
  const out={kind:'local-only-remaining-flows',node:process.version,mode};
  if(mode==='all'||mode==='logs')out.logs=await logs();
  if(mode==='all'||mode==='quota')out.quota=await quota();
  if(mode==='all'||mode==='proxy')out.proxy=await proxy();
  console.log(JSON.stringify(out,null,2));
} finally {
  await stop();for(const s of sockets)s.destroy();for(const server of servers.reverse())await new Promise(resolve=>server.close(resolve));
  fs.rmSync(temp,{recursive:true,force:true});
}
