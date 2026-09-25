#!/usr/bin/env python3
"""Read-only production ordinary-log aggregation. Run via SSH stdin, never copy JSONL.

Only bounded counters, UTC timestamps, report-local account ordinals and fixed
allowlisted diagnostic labels leave the host. No config, detailed body, Header,
session, message, raw reason text or credential is emitted.
"""
import collections
import datetime as dt
import json
import os
import re
import stat
import subprocess
import sys
import time

ROOT = '/opt/cline-pass-switcher/data/logs'
MAX_INPUT_BYTES = 128 * 1024 * 1024
MAX_SEGMENTS = 10000
MAX_LINE_BYTES = 65536 + 1024
MAX_ROWS = {'requests': 120000, 'errors': 120000}
NAME = re.compile(r'^(requests|errors)-[A-Za-z0-9_.-]{1,100}\.jsonl$')
UUID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
KNOWN_MODELS = {'glm-5.3-flash', 'kimi-k3', 'deepseek-v4-flash', 'deepseek-v4.1-flash',
                'qwen3.8-max', 'minimax-m3', 'glm-5.3', 'glm-5.2', 'deepseek-v4-pro',
                'mimo-v2.5-pro', 'mimo-v2.5', 'kimi-k2.6', 'qwen3.7-plus',
                'kimi-k2.7-code', 'qwen3.7-max'}
KNOWN_PROVIDERS = {'deepseek', 'fireworks', 'togetherai', 'friendli', 'baseten', 'azure',
                   'alibaba', 'deepinfra', 'novita', 'openai-compatible-private', 'auto'}
KNOWN_RESULTS = {'success', 'failed', 'client_cancelled'}
KNOWN_CATEGORIES = {'upstream', 'routing', 'capacity', 'proxy', 'network', 'transport',
                    'quota', 'auth', 'cancelled', 'unknown', 'http_server', 'structured_unsupported',
                    'ambiguous_rate_limit', 'transport_timeout', 'rpm', 'quota_protection'}
KNOWN_SCOPES = {'account', 'provider', 'request', 'unknown'}
KNOWN_EVIDENCE = {'fresh_account_quota', 'structured_account_quota', 'routing_final_provider',
                  'structured_provider', 'ambiguous_rate_limit', 'http_auth', 'transport_timeout',
                  'transport_proxy', 'transport_network', 'structured_unsupported', 'http_server',
                  'http_request', 'unclassified_failure'}
KNOWN_SELECTION = {'capacity-unavailable', 'rpm-unavailable', 'quota-protection',
                   'no-eligible-accounts', 'no-account', 'cache-pool-active'}
KNOWN_ACTIONS = {'degrade', 'cooldown', 'hard-quarantine', 'ignore'}
KNOWN_MEDIA = {'application/json', 'text/html', 'text/plain', 'text/event-stream'}

def utc_ms(value):
    return (dt.datetime.fromtimestamp(value / 1000, dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%S') +
            f'.{value % 1000:03d}Z') if value is not None else None

def timestamp(value):
    return value if isinstance(value, int) and not isinstance(value, bool) and 0 < value < 4102444800000 else None

def code(value):
    return value if isinstance(value, int) and not isinstance(value, bool) and 100 <= value <= 599 else None

def model(value):
    # Only deliberately bounded canonical model slugs; arbitrary caller text is never printed.
    if not isinstance(value, str) or not value.startswith('cline-pass/'): return 'other'
    slug = value[len('cline-pass/'):]
    return slug if slug in KNOWN_MODELS else 'other'

def provider(value):
    return value if isinstance(value, str) and value in KNOWN_PROVIDERS else 'other'

def category(value):
    return value if isinstance(value, str) and value in KNOWN_CATEGORIES else 'other'

def fixed(value, allowed):
    return value if isinstance(value, str) and value in allowed else 'other'

def media(value):
    if not isinstance(value, str): return 'other'
    return fixed(value.split(';', 1)[0].strip().lower(), KNOWN_MEDIA)

def size_bucket(value):
    if not isinstance(value, int) or isinstance(value, bool) or value < 0: return 'unknown'
    if value == 0: return 'zero'
    if value <= 256: return '1-256'
    if value <= 4096: return '257-4096'
    return 'over-4096'

def reason_kind(value):
    # Classify known wording in memory; never emit or hash the reason itself.
    if not isinstance(value, str): return 'unknown'
    text = value[:16384].lower()
    for label, words in (
        ('no-provider', ('no available provider', 'provider unavailable', 'unsupported model')),
        ('stream-terminated', ('gateway_stream_terminated', 'stream error after response started', 'stream terminated')),
        ('empty-response', ('empty response content',)),
        ('empty-user-message', ('user message must have content',)),
        ('rate-limit', ('too many requests', 'rate limit', 'rate_limit')),
        ('timeout', ('timeout', 'timed out')),
        ('auth', ('unauthorized', 'invalid api key', 'authentication failed')),
    ):
        if any(word in text for word in words): return label
    return 'other'

def outcome(row):
    value = row.get('result')
    if isinstance(value, str) and value in KNOWN_RESULTS: return value
    if value is not None: return 'unknown'
    status = code(row.get('status'))
    if status == 499: return 'client_cancelled'
    if status is not None: return 'success' if status < 400 else 'failed'
    return 'unknown'

def container_start_ms():
    value = subprocess.run(['docker', 'inspect', '--format', '{{.State.StartedAt}}', 'cline-pass-console'],
                           stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                           text=True, check=True, timeout=10).stdout.strip()
    if not re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|\+00:00)', value):
        raise RuntimeError('unrecognized container start timestamp')
    return int(dt.datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp() * 1000)

def top_accounts(rows, labels):
    counts = collections.Counter(labels.get(row['account'], 'unknown') for row in rows)
    top = dict(counts.most_common(12))
    if len(counts) > 12:
        top['other-accounts'] = sum(counts.values()) - sum(top.values())
    return top

def main():
    now = int(time.time() * 1000)
    start = container_start_ms()
    if start > now: raise RuntimeError('container start is in the future')
    windows = {'retained': 0, 'container': start, 'last24h': now - 86400000, 'last1h': now - 3600000}
    paths = {'requests': [], 'errors': []}
    total_bytes = 0
    # Use a directory fd and O_NOFOLLOW: a segment must be the same regular inode
    # scanned below, not a symlink swapped in between stat and open.
    dirfd = os.open(ROOT, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        with os.scandir(dirfd) as entries:
            for entry in entries:
                match = NAME.fullmatch(entry.name)
                if not match: raise RuntimeError('unexpected ordinary-log directory entry')
                if sum(map(len, paths.values())) >= MAX_SEGMENTS: raise RuntimeError('segment audit cap exceeded')
                st = entry.stat(follow_symlinks=False)
                if not stat.S_ISREG(st.st_mode): raise RuntimeError('nonregular ordinary-log segment')
                total_bytes += st.st_size
                if total_bytes > MAX_INPUT_BYTES: raise RuntimeError('ordinary-log input exceeds bounded audit cap')
                paths[match.group(1)].append((entry.name, st))
        requests, errors, error_keys = {}, [], {}
        health = {kind: {'segments': len(names), 'rows': 0, 'invalid': 0, 'deduplicated': 0,
                         'minTs': None, 'maxTs': None} for kind, names in paths.items()}
        for kind, names in paths.items():
            for filename, expected in sorted(names):
                fd = os.open(filename, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=dirfd)
                with os.fdopen(fd, 'rb') as stream:
                    actual = os.fstat(stream.fileno())
                    if (not stat.S_ISREG(actual.st_mode) or (actual.st_dev, actual.st_ino) !=
                            (expected.st_dev, expected.st_ino) or actual.st_size < expected.st_size):
                        raise RuntimeError('ordinary-log segment changed during audit')
                    remaining = expected.st_size
                    while remaining:
                        line = stream.readline(min(remaining, MAX_LINE_BYTES + 1))
                        if not line: raise RuntimeError('ordinary-log segment shrank during audit')
                        remaining -= len(line)
                        h = health[kind]
                        h['rows'] += 1
                        if h['rows'] > MAX_ROWS[kind]: raise RuntimeError('ordinary-log row audit cap exceeded')
                        complete = line.endswith(b'\n')
                        if not complete and remaining:
                            # Drain one overlong row in bounded chunks, without parsing or retaining it.
                            while remaining:
                                chunk = stream.readline(min(remaining, MAX_LINE_BYTES + 1))
                                if not chunk: raise RuntimeError('ordinary-log segment shrank during audit')
                                remaining -= len(chunk)
                                if chunk.endswith(b'\n'): break
                        if not complete or len(line) > MAX_LINE_BYTES:
                            h['invalid'] += 1
                            continue
                        try: row = json.loads(line)
                        except (ValueError, UnicodeDecodeError, RecursionError):
                            h['invalid'] += 1
                            continue
                        if not isinstance(row, dict) or (ts := timestamp(row.get('ts'))) is None:
                            h['invalid'] += 1
                            continue
                        ident = row.get('requestId')
                        if not isinstance(ident, str) or not UUID.fullmatch(ident):
                            h['invalid'] += 1
                            continue
                        h['minTs'] = min(h['minTs'], ts) if h['minTs'] is not None else ts
                        h['maxTs'] = max(h['maxTs'], ts) if h['maxTs'] is not None else ts
                        if kind == 'requests':
                            attempts = row.get('attempts')
                            legacy_502 = (row.get('result') is None and row.get('stream') is True and
                                          code(row.get('status')) == 502 and isinstance(attempts, list) and
                                          bool(attempts) and all(isinstance(a, dict) and code(a.get('status')) == 200
                                                                 for a in attempts))
                            item = {'ts': ts, 'id': ident, 'result': outcome(row), 'status': code(row.get('status')),
                                    'model': model(row.get('resolvedModel') or row.get('requestedModel')),
                                    'account': row.get('accountId') if isinstance(row.get('accountId'), str) else None,
                                    'legacy502': legacy_502, 'errorCategory': category(row.get('errorCategory')),
                                    'selection': fixed(row.get('selectionReason'), KNOWN_SELECTION)}
                            if ident in requests:
                                h['deduplicated'] += 1
                                if requests[ident]['ts'] > ts: continue
                            requests[ident] = item
                        else:
                            index = row.get('attemptIndex')
                            key = (ident, index) if type(index) is int and 0 <= index <= MAX_ROWS['errors'] else None
                            item = {'ts': ts, 'id': ident, 'status': code(row.get('status')),
                                    'upstreamStatus': code(row.get('upstreamStatus')),
                                    'model': model(row.get('resolvedModel') or row.get('requestedModel')),
                                    'account': row.get('accountId') if isinstance(row.get('accountId'), str) else None,
                                    'provider': provider(row.get('targetProvider')),
                                    'category': category(row.get('category')),
                                    'scope': fixed(row.get('errorScope'), KNOWN_SCOPES),
                                    'evidence': fixed(row.get('scopeEvidence'), KNOWN_EVIDENCE),
                                    'failureClass': fixed(row.get('failureClass'), {'rate_limit', 'auth', 'network', 'timeout', 'server', 'unsupported', 'other'}),
                                    'media': media(row.get('responseContentType')),
                                    'bytes': size_bucket(row.get('responseBytes')),
                                    'accountAction': fixed(row.get('accountAction'), KNOWN_ACTIONS),
                                    'ruleAction': fixed(row.get('ruleAction'), KNOWN_ACTIONS),
                                    'retryDecision': fixed(row.get('retryDecision'), {'stop', 'continue'}),
                                    'reason': reason_kind(row.get('reason'))}
                            if key is not None and key in error_keys:
                                h['deduplicated'] += 1
                                old = error_keys[key]
                                if errors[old]['ts'] <= ts: errors[old] = item
                            else:
                                if key is not None: error_keys[key] = len(errors)
                                errors.append(item)
    finally:
        os.close(dirfd)
    report = {'auditUtc': utc_ms(now), 'containerStartedUtc': utc_ms(start), 'inputBytes': total_bytes,
              'retained': {key: {**value, 'minTs': utc_ms(value['minTs']), 'maxTs': utc_ms(value['maxTs'])}
                           for key, value in health.items()}, 'windows': {}}
    for name, threshold in windows.items():
        reqs = [row for row in requests.values() if row['ts'] >= threshold and row['ts'] <= now]
        errs = [row for row in errors if row['ts'] >= threshold and row['ts'] <= now]
        by_id = {row['id']: row for row in reqs}
        ids = {row['id'] for row in errs}
        final_fail = [row for row in reqs if row['result'] == 'failed']
        attempts_with_final = collections.Counter(by_id[row['id']]['result'] for row in errs if row['id'] in by_id)
        ids_by_final = collections.Counter(by_id[ident]['result'] for ident in ids if ident in by_id)
        outcome_counts = collections.Counter(row['result'] for row in reqs)
        by_model = collections.Counter(row['model'] for row in final_fail)
        upstream_429 = [row for row in errs if row['upstreamStatus'] == 429]
        local_429 = [row for row in final_fail if row['status'] == 429 and row['errorCategory'] in ('capacity', 'rpm', 'quota_protection')]
        # Account IDs/names are never emitted, even if historical rows are untrusted.
        # Ordinals are scoped to this single report, not stable identities across runs.
        accounts = {value: 'account-' + str(i + 1) for i, value in
                    enumerate(sorted({row['account'] for row in requests.values() if row['account']} |
                                     {row['account'] for row in errors if row['account']}))}
        summary = {
            'requests': len(reqs), 'outcomes': dict(sorted(outcome_counts.items())),
            'requestStatuses': dict(sorted(collections.Counter(str(row['status']) for row in reqs).items())),
            'lastFinalFailureUtc': utc_ms(max((row['ts'] for row in final_fail), default=None)),
            'suspectedLegacyStream502': sum(row['legacy502'] for row in reqs),
            'failedWithoutSuspectedLegacy502': sum(not row['legacy502'] for row in final_fail),
            'outcomeStatusConflicts': sum((row['result'] == 'success' and row['status'] is not None and row['status'] >= 400) or
                                          (row['result'] == 'failed' and row['status'] is not None and (row['status'] < 400 or row['status'] == 499)) or
                                          (row['result'] == 'client_cancelled' and row['status'] != 499)
                                          for row in reqs),
            'finalFailedByAccountOrdinal': top_accounts(final_fail, accounts),
            'finalFailedByModel': dict(by_model.most_common(12)),
            'finalFailedByCategory': dict(collections.Counter(row['errorCategory'] for row in final_fail).most_common()),
            'errorAttempts': len(errs), 'errorRequestIds': len(ids),
            'errorAttemptsByAccountOrdinal': top_accounts(errs, accounts),
            'errorAttemptsWithFinalOutcome': dict(attempts_with_final),
            'errorRequestIdsByFinalOutcome': dict(ids_by_final),
            'finalFailedWithErrorRequestId': sum(row['id'] in ids for row in final_fail),
            'local429WithErrorRequestId': sum(row['id'] in ids for row in local_429),
            'errorRequestIdsWithoutFinalInWindow': len(ids - by_id.keys()),
            'errorRequestIdsWithoutRetainedFinal': len(ids - requests.keys()),
            'errorStatuses': dict(sorted(collections.Counter(str(row['status']) for row in errs).items())),
            'upstreamStatuses': dict(sorted(collections.Counter(str(row['upstreamStatus']) for row in errs).items())),
            'errorCategories': dict(collections.Counter(row['category'] for row in errs).most_common()),
            'errorAttemptsByModel': dict(collections.Counter(row['model'] for row in errs).most_common(12)),
            'reasonKinds': dict(collections.Counter(row['reason'] for row in errs).most_common()),
            'failedProviderLabels': dict(collections.Counter(row['provider'] for row in errs).most_common(10)),
            'local429Selection': dict(collections.Counter(row['selection'] for row in local_429).most_common()),
            'upstream429': {
                'attempts': len(upstream_429),
                'scope': dict(collections.Counter(row['scope'] for row in upstream_429).most_common()),
                'evidence': dict(collections.Counter(row['evidence'] for row in upstream_429).most_common()),
                'failureClass': dict(collections.Counter(row['failureClass'] for row in upstream_429).most_common()),
                'media': dict(collections.Counter(row['media'] for row in upstream_429).most_common()),
                'provider': dict(collections.Counter(row['provider'] for row in upstream_429).most_common()),
                'model': dict(collections.Counter(row['model'] for row in upstream_429).most_common()),
                'accountOrdinal': top_accounts(upstream_429, accounts),
                'responseBytes': dict(collections.Counter(row['bytes'] for row in upstream_429).most_common()),
                'accountAction': dict(collections.Counter(row['accountAction'] for row in upstream_429).most_common()),
                'ruleAction': dict(collections.Counter(row['ruleAction'] for row in upstream_429).most_common()),
                'retryDecision': dict(collections.Counter(row['retryDecision'] for row in upstream_429).most_common()),
            },
        }
        if name in ('container', 'last24h', 'last1h'):
            hour = lambda row: dt.datetime.fromtimestamp(row['ts']/1000, dt.timezone.utc).strftime('%Y-%m-%dT%H')
            summary['failedByUtcHour'] = dict(sorted(collections.Counter(hour(row) for row in final_fail).items()))
            summary['local429ByUtcHour'] = dict(sorted(collections.Counter(hour(row) for row in local_429).items()))
            summary['upstream429ByUtcHour'] = dict(sorted(collections.Counter(hour(row) for row in upstream_429).items()))
        # Retained history may span 30 days. Day+fixed reason gives time evidence
        # without any raw free-text label or per-request diagnostic output.
        daily = collections.defaultdict(collections.Counter)
        for row in errs:
            day = dt.datetime.fromtimestamp(row['ts']/1000, dt.timezone.utc).strftime('%Y-%m-%d')
            daily[day][row['reason']] += 1
        summary['errorReasonByUtcDay'] = {day: dict(counts) for day, counts in sorted(daily.items())}
        report['windows'][name] = summary
    print(json.dumps(report, ensure_ascii=True, separators=(',', ':'), sort_keys=True))

if __name__ == '__main__':
    try:
        main()
    except Exception:
        # Python tracebacks, Docker stderr and filesystem paths are not safe audit output.
        print('ordinary-log audit stopped: unsafe, changed or unreadable input', file=sys.stderr)
        sys.exit(1)
