// Local browser verification only; all credentials/accounts/upstreams are synthetic.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { defaultAccountWorkflow } from '../../../../lib/account-workflow.js';
import { prepareAdminFixture } from '../../../../test/admin-fixture.js';

const root=process.cwd(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'cps-workflow-browser-'));
const stateFile=path.join(root,'.trellis/tasks/09-30-selection-workflow/research/browser-fixture-state.json');
const model='cline-pass/deepseek-v4.1-flash';let modelHits=0,stopping=false;
const listen=s=>new Promise(r=>s.listen(0,'127.0.0.1',()=>r(s.address().port)));
const mock=http.createServer((req,res)=>{req.resume();req.on('end',()=>{
  res.setHeader('Content-Type',req.method==='GET'?'application/json':'text/event-stream');
  if(req.method==='GET')return res.end(JSON.stringify(req.url.endsWith('/models')?{data:[{id:model}]}:{success:true,data:{limits:['five_hour','weekly','monthly'].map(type=>({type,percentUsed:5}))}}));
  modelHits++;res.end('data: '+JSON.stringify({choices:[{delta:{content:'Local fixture response'},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}})+'\n\ndata: [DONE]\n\n');
});});
const upstream=await listen(mock),socket=net.createServer(),port=await listen(socket);await new Promise(r=>socket.close(r));
const config={port,proxyKey:'fixture-client',upstreamBase:`http://127.0.0.1:${upstream}/api/v1`,knownModels:[model],modelAliases:{'pc/deepseek-v4.1-flash':model},accounts:Array.from({length:5},(_,i)=>({id:`demo${i}`,name:`本地演示账号 ${String.fromCharCode(65+i)}`,key:`fixture-${i}`,enabled:true,maxConcurrent:2,maxRpm:0,clientKeyId:'legacy',perModel:{}})),accountMode:'sticky',concurrencyWaitMs:1000,poolFullWaitMs:null,accountPipeline:{quotaPool:true,healthSort:true,sticky:true,order:['healthSort','quotaPool','sticky'],cachePoolSize:3,cachePoolMaxSize:5,cachePoolLowQuotaSize:0},accountWorkflow:{...defaultAccountWorkflow(),enabled:true},perModel:{[model]:{upstreams:['deepseek','fireworks'],pinMode:'strict',maxRetries:1}},errorRules:[],retryRules:[],detailedLogging:false,errorDetailLogging:false,errorDetailMigrationVersion:1};
fs.writeFileSync(path.join(dir,'config.json'),JSON.stringify(config));
fs.writeFileSync(path.join(dir,'metadata.json'),JSON.stringify({models:{[model]:{pipeline:'planner',upstreams:['deepseek','fireworks']}},history:[],catalog:[model],catalogFetchedAt:Date.now()}));
prepareAdminFixture(dir);
const child=spawn(process.execPath,['server.js'],{cwd:root,env:{PATH:process.env.PATH,NODE_ENV:'test',DATA_DIR:dir,BIND_HOST:'127.0.0.1',PORT:String(port)},stdio:['ignore','pipe','pipe']});
let ready='';child.stdout.on('data',b=>{ready=(ready+b).slice(-8000);});child.stderr.resume();
for(let i=0;i<250&&!ready.includes('OpenAI 兼容代理地址');i++){if(child.exitCode!==null)throw Error('fixture server failed');await new Promise(r=>setTimeout(r,20));}
if(!ready.includes('OpenAI 兼容代理地址'))throw Error('fixture startup timed out');
const requests=[];
for(const session of ['browser-one','browser-two','browser-three','browser-four','browser-one']){
  const res=await fetch(`http://127.0.0.1:${port}/v1/chat/completions`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer fixture-client'},body:JSON.stringify({model,session_id:session,stream:true,messages:[{role:'user',content:'Synthetic browser fixture'}]})});await res.text();requests.push(res.headers.get('x-cline-request-id'));
}
const state={url:`http://127.0.0.1:${port}`,dataDir:dir,requests,synthetic:true,modelHits,stopped:false};
fs.writeFileSync(stateFile,JSON.stringify(state,null,2)+'\n');console.log(JSON.stringify(state));
async function stop(){if(stopping)return;stopping=true;child.kill('SIGTERM');await new Promise(r=>child.once('exit',r));mock.closeAllConnections?.();await new Promise(r=>mock.close(r));fs.writeFileSync(stateFile,JSON.stringify({...state,modelHits,stopped:true},null,2)+'\n');process.exit(0);}
process.once('SIGTERM',()=>void stop());process.once('SIGINT',()=>void stop());
setTimeout(()=>void stop(),30*60*1000).unref();
