"""Offline independent checks of sanitized historical evidence; never sends requests."""
import argparse
from collections import Counter
from datetime import datetime
import hashlib
import json
from pathlib import Path


def timestamp(value):
    return datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()


def overlap(intervals, target):
    changes = Counter()
    for start, end in intervals:
        assert end >= start
        changes[start] += 1
        changes[end] -= 1
    peak = active = 0
    segments = []
    times = sorted(changes)
    for index, point in enumerate(times):
        active += changes[point]
        assert active >= 0
        peak = max(peak, active)
        if index + 1 < len(times):
            segments.append((point, times[index + 1], active))
    assert active == 0
    def held(level):
        longest = current = total = 0.0
        for start, end, count in segments:
            if count >= level:
                current += end - start
                total += end - start
                longest = max(longest, current)
            else:
                current = 0.0
        return {'longestSeconds': longest, 'totalSeconds': total}
    return {'peak': peak, 'atPeak': held(peak) if peak else None, 'atTarget': held(target)}


def read_events(path):
    return [json.loads(line) for line in path.read_text().splitlines() if line]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source-root', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    base = args.source_root
    used = []
    def path(relative):
        value = base / relative
        used.append(value)
        return value
    client = read_events(path('runs/20260930-workflow-pool-v2/requests-compact.jsonl'))
    stages = json.loads(path('runs/20260930-workflow-pool-v2/stage-summary.json').read_text())
    routing = {}
    for name in ['burst80', 'paced80', 'tail']:
        data = json.loads(path(f'diagnostics/workflow-pool-{name}-routing-20260930.json').read_text())
        for row in data['rows']:
            assert row['requestId'] not in routing
            routing[row['requestId']] = row
    workflow = []
    for stage in stages:
        if stage['stage'] == 'auth_probe':
            continue
        rows = [r for r in client if r['stage'] == stage['stage']]
        assert len(rows) == stage['completed']
        routes = [routing[r['headers']['x-cline-request-id']] for r in rows]
        successes = [r for r in rows if r['success']]
        assert all(r['status'] == 200 and r['done'] and r['finish_reason'] not in (None, 'error')
                   and r['ttft_s'] is not None and (r['content_chars'] or r['reasoning_chars']) for r in successes)
        assert len(successes) == stage['succeeded']
        attempts = [a for r in routes for a in r['attempts']]
        errors = [a for a in attempts if a['upstreamStatus'] == 429]
        failed_routes = [r for r in routes if r['status'] == 429]
        assert all(len(r['attempts']) == 2 and all(a['upstreamStatus'] == 429 for a in r['attempts']) for r in failed_routes)
        assert all(r['switched'] and len({a['account'] for a in r['attempts']})==2 for r in failed_routes)
        assert all(a['responseType'] == 'html' and a['responseBytes'] == 142
                   and a['ruleId'] == 'general-429' and a['errorScope'] == 'unknown'
                   and a['scopeEvidence'] == 'ambiguous_rate_limit' for a in errors)
        intervals = [(timestamp(r['started_at']) + r['ttft_s'], timestamp(r['started_at']) + r['duration_s']) for r in successes]
        inflight = [(timestamp(r['started_at']), timestamp(r['started_at']) + r['duration_s']) for r in rows]
        # Account loads at the time strict successful generation reaches its maximum.
        points = sorted({x for span in intervals for x in span})
        account_peak = {}
        for point in points:
            loads = Counter(routing[r['headers']['x-cline-request-id']]['account'] for r in successes
                            if timestamp(r['started_at']) + r['ttft_s'] <= point < timestamp(r['started_at']) + r['duration_s'])
            if sum(loads.values()) > sum(account_peak.values()):
                account_peak = dict(loads)
        workflow.append({
            'stage': stage['stage'], 'targetConcurrency': stage['concurrency'], 'issued': len(rows),
            'strictSuccess': len(successes), 'successRate': len(successes)/len(rows),
            'maxOutputTokens': stage['max_tokens'], 'targetRps': stage['target_rps'],
            'clientOverlap': overlap(inflight, stage['concurrency']),
            'successfulGeneration': overlap(intervals, stage['concurrency']),
            'serverMatched': len(routes), 'strategyCounts': dict(Counter(r['strategy'] for r in routes)),
            'accountsUsed': len({r['account'] for r in routes}),
            'accountSuccessfulGenerationAtPeak': account_peak,
            'upstreamAttempts': len(attempts), 'upstream429Attempts': len(errors),
            'terminal429': len(failed_routes), 'distinct429Accounts': len({a['account'] for a in errors}),
            'extraAttemptsFromTerminal429': sum(len(r['attempts'])-1 for r in failed_routes),
            'localAdmissionRejections': sum(r.get('errorCategory') in ('capacity','rpm') or r.get('blockedBy') in ('concurrency','rpm','mixed') for r in routes),
            'workflowHealthNodeCounts': dict(Counter(n['after'] for r in routes for w in r.get('workflow',[]) for n in w.get('nodes',[]) if n['node']=='health' and 'after' in n)),
        })
    assert sum(s['issued'] for s in workflow) == 294
    assert sum(s['terminal429'] for s in workflow) == 25
    assert sum(s['upstream429Attempts'] for s in workflow) == 50
    assert sum(s['localAdmissionRejections'] for s in workflow) == 0

    ip_events = read_events(path('diagnostics/ip-scope-crossover-20260929.jsonl'))
    ip_rows = [r for r in ip_events if r['kind'] == 'request']
    ip_ready = next(r for r in ip_events if r['kind'] == 'ready')
    assert len({r['seq'] for r in ip_rows}) == len(ip_rows) == 216
    assert ip_ready['public_egress_ipv4'] != ip_ready['alternate_egress_ipv4']
    assert sum(r['success'] for r in ip_rows) == 207
    assert all(r['network']['tls_authorized'] and r['network']['target_ipv4']=='35.186.247.105' for r in ip_rows)
    fingerprints = Counter(r['error_body_sha256'] for r in ip_rows if r['status']==429)
    assert len(fingerprints) == 1 and sum(fingerprints.values()) == 9
    assert all('retry-after' not in r.get('headers',{}) for r in ip_rows if r['status']==429)
    assert not any(r['account']=='P3' for r in ip_rows if r['stage'] in ('A_load_100','B_load_100'))
    crossovers = []
    for event in ip_events:
        if event['kind'] != 'crossover_complete':
            continue
        trigger = next(r for r in ip_rows if r['seq']==event['trigger_seq'])
        rows = [next(r for r in ip_rows if r['seq']==item['seq']) for item in event['rows']]
        assert len(rows)==6
        for label in ['P1','P2','P3']:
            account = [r for r in rows if r['account']==label]
            assert len(account)==2
            assert all((r['status']==429 and not r['success']) if r['route']==trigger['route'] else (r['status']==200 and r['success']) for r in account)
        times = [timestamp(r['started_at']) for r in rows]
        crossovers.append({'stage':event['stage'],'limitedRoute':trigger['route'],
                           'triggerStartedAt':trigger['started_at'],'launchSpreadMs':(max(times)-min(times))*1000,
                           'rows':[{'account':r['account'],'route':r['route'],'status':r['status'],'success':r['success']} for r in rows]})
    assert {r['limitedRoute'] for r in crossovers}=={'A','B'}
    echoes = json.loads(path('diagnostics/ip-route-postflight.json').read_text())
    assert all(r['ip']==ip_ready['public_egress_ipv4' if r['route']=='A' else 'alternate_egress_ipv4'] for r in echoes['fresh_connection_echoes'])
    ip_stages = [r for r in ip_events if r['kind']=='stage_complete']
    for stage in ip_stages:
        rows = [r for r in ip_rows if r['stage']==stage['stage']]
        assert len(rows)==stage['issued'] and sum(r['success'] for r in rows)==stage['success']

    cap_events = read_events(path('diagnostics/cap-six-ten-20260929.jsonl'))
    cap_cases = {r['case']:r for r in cap_events if r['kind']=='cap_case_complete'}
    samples = [r for r in cap_events if r['kind']=='cap_sample']
    assert all(len(r['per_account'])==10 and sum(r['per_account'])==r['total']<=60 and all(0<=n<=6 for n in r['per_account']) for r in samples)
    for case in cap_cases.values():
        assert case['passed'] and case['peak_total_leases']==60
        assert case['per_account_peak_leases']==[6]*10 and case['final_total_leases']==0
        assert case['production_config_hash_unchanged']
    live_rows = [r for r in cap_events if r['kind']=='request' and r['stage']=='live_cap6' and r['label']=='initial']
    assert len(live_rows)==60 and all(r['status']==200 and r['success'] and r['stream_done'] for r in live_rows)
    live_overlap = overlap([(timestamp(r['started_at'])+r['ttft_ms']/1000,timestamp(r['started_at'])+r['elapsed_ms']/1000) for r in live_rows],60)
    assert live_overlap['peak']==60 and live_overlap['atTarget']['longestSeconds']>30
    assert cap_cases['live']['overflow_request']['status']==429
    assert cap_cases['mock']['after_one_release']['total']==59
    assert cap_cases['mock']['after_refill']['per_account']==[6]*10

    count_events = read_events(path('diagnostics/account-count-2v10-20260929.jsonl'))
    count_rows = [r for r in count_events if r['kind']=='request']
    assert len(count_rows)==376
    count_stages=[]
    for event in count_events:
        if event['kind']!='stage_complete' or event['stage']=='preflight-10':
            continue
        rows=[r for r in count_rows if r['stage']==event['stage']]
        assert len(rows)==event['issued']
        errors=[r for r in rows if r['status']==429]
        assert len(errors)==1 and errors[0]['error_body_sha256'] in fingerprints
        count_stages.append({'stage':event['stage'],'accountsUsed':len({r['account'] for r in rows}),
                             'issued':len(rows),'success':sum(r['success'] for r in rows),'terminal429':len(errors)})
    assert [r['accountsUsed'] for r in count_stages]==[2,10,10,2]
    result={
        'offlineOnly':True,'modelRequestsIssued':0,'allAssertionsPassed':True,
        'sources':[{'path':str(p.relative_to(base)),'bytes':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()} for p in used],
        'workflowStages':workflow,
        'twoEgress':{'requests':len(ip_rows),'successes':207,'statuses':dict(Counter(str(r['status']) for r in ip_rows)),
                    'egressA':ip_ready['public_egress_ipv4'],'egressB':ip_ready['alternate_egress_ipv4'],
                    'errorFingerprints':dict(fingerprints),'idleAccountNotInLoad':True,
                    'crossovers':crossovers,'stageSummaries':ip_stages,'freshEgressEchoes':echoes['fresh_connection_echoes']},
        'tenAccountSix':{'sampleCount':len(samples),'initialSuccesses':60,'perAccountLeasePeak':[6]*10,
                         'generationOverlap':live_overlap,'liveOverflow':cap_cases['live']['overflow_request'],
                         'mockReleaseRefillVerified':True,'finalLeases':0},
        'twoVsTen':count_stages,
    }
    args.output.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({'allAssertionsPassed':True,'workflow':[{'stage':s['stage'],'success':s['strictSuccess'],'issued':s['issued'],'peak':s['successfulGeneration']['peak'],'peakHoldSeconds':s['successfulGeneration']['atPeak']['longestSeconds'],'upstream429':s['upstream429Attempts']} for s in workflow],
                     'egressCrossovers':len(crossovers),'egressRequests':len(ip_rows),'capSixPeak':live_overlap['peak'],'capSixHoldSeconds':live_overlap['atTarget']['longestSeconds']},ensure_ascii=False))

if __name__ == '__main__':
    main()
