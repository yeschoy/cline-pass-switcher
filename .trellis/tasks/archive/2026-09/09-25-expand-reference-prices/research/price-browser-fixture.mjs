// Local-only real-browser price fixture. All keys and usage are synthetic.
// Run from repository root: node .trellis/tasks/archive/2026-09/09-25-expand-reference-prices/research/price-browser-fixture.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
let root = path.dirname(fileURLToPath(import.meta.url));
while (!fs.existsSync(path.join(root, 'server.js')) || !fs.existsSync(path.join(root, 'test/admin-fixture.js'))) {
  const parent = path.dirname(root);
  if (parent === root) throw Error('repository root not found');
  root = parent;
}
const { prepareAdminFixture } = await import(pathToFileURL(path.join(root, 'test/admin-fixture.js')).href);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cps-price-browser-'));
const listen = server => new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(server.address().port); }); });
const upstream = http.createServer((req,res) => { req.resume(); req.on('end', () => {
  res.setHeader('Content-Type','application/json');
  if (req.url.endsWith('/models')) return res.end('{"data":[]}');
  if (req.url.includes('usage-limits')) return res.end('{"success":true,"data":{"limits":[{"type":"five_hour","percentUsed":10},{"type":"weekly","percentUsed":15},{"type":"monthly","percentUsed":20}]}}');
  res.end(JSON.stringify({choices:[{message:{content:'ok',provider_metadata:{gateway:{routing:{finalProvider:'one'}}}}}],usage:{prompt_tokens:10,completion_tokens:2,total_tokens:12,prompt_tokens_details:{cached_tokens:3}}}));
}); });
let child=null, stopped=false;
async function stop(){if(stopped)return;stopped=true;try{if(child?.exitCode===null&&child.signalCode===null){const running=child;running.kill('SIGTERM');await new Promise(resolve=>{const timer=setTimeout(()=>running.kill('SIGKILL'),4000);running.once('exit',()=>{clearTimeout(timer);resolve();});});}if(upstream.listening)await new Promise(resolve=>upstream.close(resolve));}finally{fs.rmSync(dir,{recursive:true,force:true});}}
process.once('exit',()=>{if(child?.exitCode===null)child.kill('SIGKILL');try{fs.rmSync(dir,{recursive:true,force:true});}catch{}});
process.once('SIGTERM',()=>{void stop().then(()=>process.exit(0));});
process.once('SIGINT',()=>{void stop().then(()=>process.exit(0));});
try {
  const upstreamPort=await listen(upstream),reservation=http.createServer(),port=await listen(reservation);await new Promise(resolve=>reservation.close(resolve));
  const ids=['glm-5.3','glm-5.3-flash','kimi-k3','deepseek-v4-pro','deepseek-v4.1-flash','mimo-v2.5','mimo-v2.5-pro','minimax-m3','muse-spark-1.3-contributor','qwen3.8-max','qwen3.7-max','qwen3.7-plus'].map(x=>'cline-pass/'+x);
  fs.writeFileSync(path.join(dir,'config.json'),JSON.stringify({port,proxyKey:'synthetic-client-key',upstreamBase:`http://127.0.0.1:${upstreamPort}/api/v1`,knownModels:ids,accounts:[{id:'synthetic',name:'Synthetic',key:'synthetic-upstream-key',enabled:true,perModel:{}}],perModel:{'cline-pass/deepseek-v4.1-flash':{upstreams:['one']}}}),{mode:0o600});
  prepareAdminFixture(dir);
  let output='';child=spawn(process.execPath,['server.js'],{cwd:root,env:{PATH:process.env.PATH||'',DATA_DIR:dir,PORT:String(port),BIND_HOST:'127.0.0.1'},stdio:['ignore','pipe','pipe']});
  for(const stream of [child.stdout,child.stderr])stream.on('data',bytes=>{output=(output+bytes.toString()).slice(-1024);});
  const deadline=Date.now()+10000;while(!output.includes('OpenAI 兼容代理地址')&&child.exitCode===null&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,15));
  if(!output.includes('OpenAI 兼容代理地址'))throw Error(`isolated startup failed: ${output.slice(-180)}`);
  const response=await fetch(`http://127.0.0.1:${port}/v1/chat/completions`,{method:'POST',headers:{Authorization:'Bearer synthetic-client-key','Content-Type':'application/json'},body:JSON.stringify({model:'cline-pass/deepseek-v4.1-flash',messages:[{role:'user',content:'synthetic'}]})});
  if(response.status!==200)throw Error(`synthetic chat failed: ${response.status}`);await response.arrayBuffer();
  console.log(`fixture: http://127.0.0.1:${port}/`);
  await new Promise(()=>{});
} catch(error){console.error(String(error.message||error));await stop();process.exitCode=1;}
