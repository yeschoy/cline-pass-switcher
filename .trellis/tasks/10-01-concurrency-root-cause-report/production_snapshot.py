"""Bounded read-only production projection; no model calls or runtime mutations."""
import argparse
import hashlib
import json
from pathlib import Path
import shlex
import stat
import subprocess

REMOTE = r'''
import collections, datetime, hashlib, json, pathlib, re, subprocess, time
now=int(time.time()*1000)
inspect=json.loads(subprocess.check_output(['docker','inspect','cline-pass-console']))[0]
data=next(row['Source'] for row in inspect['Mounts'] if row['Destination']=='/data')
assert data=='/opt/cline-pass-switcher/data'
root=pathlib.Path(data)
raw=(root/'config.json').read_bytes(); config=json.loads(raw)
meta_raw=(root/'metadata.json').read_bytes(); meta=json.loads(meta_raw)
accounts=sorted(config.get('accounts',[]),key=lambda a:a['id'])
labels={a['id']:'P'+str(i+1).zfill(2) for i,a in enumerate(accounts)}
owners={'legacy':'Legacy'}
owners.update({a['id']:'K'+str(i+1) for i,a in enumerate(sorted(config.get('clientKeys',[]),key=lambda a:a['id']))})
seeds=[config.get('apiKey'), config.get('proxyKey')]+[a.get('key') for a in config.get('clientKeys',[])]
for a in accounts: seeds.extend([a.get('key'),a.get('proxyUrl'),a.get('note'),a.get('name')]+list((a.get('headers') or {}).values()))
seeds=sorted({v for v in seeds if isinstance(v,str) and len(v)>=4},key=len,reverse=True)
def safe(v):
 if isinstance(v,str):
  for s in seeds:v=v.replace(s,'[REDACTED]')
  return re.sub(r'(?i)(Bearer\s+\S+|sk-[A-Za-z0-9_-]{20,})','[REDACTED]',v)[:500]
 if isinstance(v,list):return [safe(x) for x in v[:200]]
 if isinstance(v,dict):return {safe(k):safe(x) for k,x in v.items()}
 return v
def project(v,fields):return safe({k:v[k] for k in fields if k in v})
def counts(values):return dict(collections.Counter(str(v) if v is not None else 'null' for v in values))
def workflow_decisions(row):
 value=row.get('workflow')
 if isinstance(value,dict):return value.get('decisions',[])
 return value if isinstance(value,list) else []
minimum=now//60000-1439
buckets=[b for b in meta.get('statistics',{}).get('minuteBuckets',[]) if minimum<=b.get('minute',0)<=now//60000]
def health(account_id):
 sums={'successes':0,'degrades':0}
 for b in buckets:
  row=(b.get('accountHealth') or {}).get(account_id)
  if row is None:continue
  for k in sums:
   value=row.get(k)
   sums[k]=None if sums[k] is None or not isinstance(value,int) else sums[k]+value
 samples=None if None in sums.values() else sum(sums.values())
 return {**sums,'samples':samples,'successRate':sums['successes']/samples if samples else None}
def quota(account_id):
 q=(meta.get('accountQuotas') or {}).get(account_id,{})
 snap=q.get('snapshot') or {};limits=snap.get('limits') or {}; fetched=snap.get('fetchedAt')
 complete=all(isinstance(limits.get(k),dict) and isinstance(limits[k].get('percentUsed'),(int,float)) for k in ['five_hour','weekly','monthly'])
 fresh=complete and isinstance(fetched,int) and q.get('errorCategory') is None and q.get('lastSuccessAt')==fetched and (q.get('lastAttemptAt') or 0)<=fetched and 0<=now-fetched<=900000
 maximum=max(limits[k]['percentUsed'] for k in ['five_hour','weekly','monthly']) if complete else None
 pool='unknown' if not fresh else 'hot' if maximum<80 else 'warm' if maximum<95 else 'reserve'
 return {'fresh':fresh,'pool':pool,'maximumUsedPercent':maximum,'lastAttemptAt':q.get('lastAttemptAt'),'fetchedAt':fetched,'errorCategory':safe(q.get('errorCategory'))}
rows=[]
for a in accounts:
 state=(meta.get('accountStates') or {}).get(a['id'],{})
 reasons=[]
 if a.get('enabled',True) is False:reasons.append('disabled')
 if not a.get('key'):reasons.append('no-key')
 if state.get('banned') or state.get('hardQuarantined'):reasons.append('hard-quarantine')
 if (state.get('cooldownUntil') or 0)>now:reasons.append('cooldown')
 if state.get('protectionMonthlyAt'):reasons.append('monthly-protection')
 if state.get('protectionShortAt'):reasons.append('short-protection')
 if state.get('quotaDisposition'):reasons.append('quota-disposition')
 rows.append({'label':labels[a['id']],'owner':owners.get(a.get('clientKeyId') or 'legacy','unknown'),'enabled':a.get('enabled',True) is not False,'maxConcurrent':a.get('maxConcurrent',0),'maxRpm':a.get('maxRpm',0),'proxyConfigured':bool(a.get('proxyUrl')),'headerCount':len(a.get('headers') or {}),'persistentReasons':reasons,'health':health(a['id']),'quota':quota(a['id'])})
env={x.split('=',1)[0]:x.split('=',1)[1] for x in inspect['Config'].get('Env',[]) if '=' in x}
env_names=['NODE_ENV','CLINE_PASS_DIRECT_MAX_SOCKETS','CLINE_PASS_PROXY_MAX_SOCKETS','CLINE_PASS_SSE_FIRST_EVENT_MS','CLINE_PASS_SSE_STREAM_IDLE_MS']
source=subprocess.check_output(['docker','exec','cline-pass-console','sha256sum','/app/server.js'],text=True).split()[0]
window=now-30*60000;logs=[];scanned=0;malformed=0;cap=160*1024*1024
for path in sorted((root/'logs').glob('requests-*.jsonl'),key=lambda p:p.stat().st_mtime,reverse=True):
 if path.stat().st_mtime*1000<window:continue
 for line in path.open():
  scanned+=len(line.encode())
  if scanned>cap:break
  try:r=json.loads(line)
  except ValueError:malformed+=1;continue
  if window<=r.get('ts',0)<=now:logs.append(r)
 if scanned>cap:break
attempts=[a for r in logs for a in r.get('attempts',[])]
errors=[a for a in attempts if a.get('upstreamStatus')==429]
route_fields=['upstream','upstreams','exclude','pinMode','sort','maxRetries','providerCooldownMs']
result={
 'checkedAt':datetime.datetime.fromtimestamp(now/1000,datetime.timezone.utc).isoformat(),
 'readOnly':True,'modelRequestsIssued':0,
 'health':inspect['State'].get('Health',{}).get('Status'),'restarts':inspect['RestartCount'],
 'containerStartedAt':inspect['State'].get('StartedAt'),'image':inspect['Image'],
 'sourceSha256':source,'configSha256':hashlib.sha256(raw).hexdigest(),
 'configUnchangedDuringRead':(root/'config.json').read_bytes()==raw,
 'metadataSha256':hashlib.sha256(meta_raw).hexdigest(),
 'safeEnv':{k:env[k] for k in env_names if k in env},
 'totalAccounts':len(accounts),'enabledAccounts':sum(r['enabled'] for r in rows),
 'distinctEnabledCredentialCount':len({a.get('key') for a in accounts if a.get('enabled',True) is not False and a.get('key')}),
 'ownerPools':[{'owner':name,'enabled':sum(r['enabled'] and r['owner']==name for r in rows)} for name in owners.values()],
 'maxConcurrentCounts':counts(r['maxConcurrent'] for r in rows if r['enabled']),
 'maxRpmCounts':counts(r['maxRpm'] for r in rows if r['enabled']),
 'proxyEnabledAccounts':sum(r['enabled'] and r['proxyConfigured'] for r in rows),
 'accountMode':safe(config.get('accountMode')),
 'accountWorkflow':project(config.get('accountWorkflow',{}),['version','enabled','bindingEnabled','onBindingBusy','missSteps','quotaFilter','quotaPools','healthFilter','minimumHealth','unknownHealth','selector']),
 'accountPipeline':project(config.get('accountPipeline',{}),['quotaPool','healthSort','sticky','order','cachePoolSize','cachePoolMaxSize','cachePoolLowQuotaSize']),
 'cacheTargetPersisted':meta.get('cachePoolTargetSize'),
 'concurrencyWaitMs':config.get('concurrencyWaitMs'),'poolFullWaitMs':config.get('poolFullWaitMs'),
 'globalRoutes':{safe(k):project(v,route_fields) for k,v in config.get('perModel',{}).items()},
 'accountRouteOverrideCount':sum(bool(a.get('perModel')) for a in accounts if a.get('enabled',True) is not False),
 'errorRules':[{'order':i+1,**project(r,['id','scope','action','providers','models','when','reset'])} for i,r in enumerate(config.get('errorRules',[]))],
 'retryRules':[{'order':i+1,**project(r,['id','decision','when'])} for i,r in enumerate(config.get('retryRules',[]))],
 'accounts':rows,
 'recent30m':{'fromMs':window,'toMs':now,'requests':len(logs),'scanBytes':scanned,'scanTruncated':scanned>cap,'malformed':malformed,
  'statuses':counts(r.get('status') for r in logs),'results':counts(r.get('result') for r in logs),
  'attempts':len(attempts),'upstreamStatuses':counts(a.get('upstreamStatus') for a in attempts),
  'localAdmissionRejections':sum(r.get('blockedBy') in ['concurrency','rpm','mixed'] or r.get('errorCategory') in ['capacity','rpm'] for r in logs),
  'upstream429Scopes':counts(a.get('errorScope') for a in errors),'upstream429Evidence':counts(a.get('scopeEvidence') for a in errors),
  'upstream429Shapes':counts(str(a.get('responseContentType'))+':'+str(a.get('responseBytes')) for a in errors),
  'upstream429Rules':counts(a.get('ruleId') for a in errors),'requestsWithUpstream429':sum(any(a.get('upstreamStatus')==429 for a in r.get('attempts',[])) for r in logs),
  'successfulRequestsWithUpstream429':sum(r.get('result')=='success' and any(a.get('upstreamStatus')==429 for a in r.get('attempts',[])) for r in logs),
  'distinctFinalAccounts':len({r.get('accountId') for r in logs if r.get('accountId')}),
  'workflowStrategies':counts(r.get('strategy') for r in logs),
  'workflowCacheTargets':counts(r.get('cachePoolTargetSize') for r in logs),
  'workflowHealthCandidateCounts':counts(n.get('after') for r in logs for w in workflow_decisions(r) for n in w.get('nodes',[]) if n.get('node')=='health')},
 'unknownRuntimeState':['activeCounts','rpmWindows','sessionBindings','providerCircuits','quotaProvisional','exactUpstreamArrivalRate','actualClineEgressIp']}
print(json.dumps(result,ensure_ascii=False))
'''

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--via-local-proxy', action='store_true')
    args = parser.parse_args()
    repo = Path(subprocess.check_output(['git', 'rev-parse', '--show-toplevel'], text=True).strip())
    identity = repo / '167.114.158.4_ubuntu_49555_ed25519'
    info = identity.lstat()
    assert stat.S_ISREG(info.st_mode) and stat.S_IMODE(info.st_mode) == 0o600
    subprocess.run(['git', 'check-ignore', '-q', str(identity)], check=True)
    assert not args.output.exists(), 'Do not overwrite an earlier snapshot'
    ssh = ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10']
    if args.via_local_proxy:
        ssh += ['-o', 'ProxyCommand=nc -X connect -x 127.0.0.1:10808 %h %p']
    ssh += ['-i', str(identity), '-p', '49555', 'ubuntu@167.114.158.4',
            'sudo -n python3 -c ' + shlex.quote(REMOTE)]
    result = subprocess.run(ssh, capture_output=True, text=True, timeout=60)
    if result.returncode:
        raise SystemExit('Read-only SSH projection failed: ' + result.stderr[-800:])
    data = json.loads(result.stdout)
    data['localSourceMatches'] = data['sourceSha256'] == hashlib.sha256((repo / 'server.js').read_bytes()).hexdigest()
    args.output.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({k:data[k] for k in ['checkedAt','health','restarts','localSourceMatches','configUnchangedDuringRead','totalAccounts','enabledAccounts','distinctEnabledCredentialCount','ownerPools','maxConcurrentCounts','maxRpmCounts','proxyEnabledAccounts','accountWorkflow','accountPipeline','recent30m']},ensure_ascii=False))

if __name__ == '__main__':
    main()
