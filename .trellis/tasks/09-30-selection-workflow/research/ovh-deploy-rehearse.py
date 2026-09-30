"""Rehearse candidate migration and exact old-image readback on private, non-raw copies."""

import hashlib
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import time


ROOT = pathlib.Path('/opt/cline-pass-switcher')


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read_json(path):
    with path.open(encoding='utf-8') as handle:
        return json.load(handle)


def run(args):
    result = subprocess.run(args, capture_output=True, text=True, check=False)
    require(result.returncode == 0, 'isolated Docker or copy command failed')
    return result.stdout.strip()


def docker_json(args):
    return json.loads(run(['docker', *args]))


def write_private(path, data):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'w', encoding='utf-8') as handle:
        handle.write(data)
        handle.flush()
        os.fsync(handle.fileno())


def identity(config):
    accounts = config.get('accounts') or []
    ids = sorted(str(row.get('id', '')) for row in accounts)
    owners = sorted(f"{row.get('id', '')}:{row.get('clientKeyId', 'legacy')}" for row in accounts)
    return {'count': len(accounts), 'ids': hashlib.sha256('|'.join(ids).encode()).hexdigest(),
            'owners': hashlib.sha256('|'.join(owners).encode()).hexdigest()}


def changes(before, after, prefix=''):
    if isinstance(before, dict) and isinstance(after, dict):
        result = []
        for key in sorted(set(before) | set(after)):
            field = prefix + key
            if key not in before or key not in after:
                result.append(field)
            else:
                result.extend(changes(before[key], after[key], field + '.'))
        return result
    if before != after:
        return [prefix.rstrip('.')]
    return []


def inspect(name):
    return docker_json(['inspect', name])[0]


def exercise(name, image, data, env_file):
    require(re.fullmatch(r'cps-[a-z0-9-]+', name) is not None, 'invalid rehearsal name')
    args = ['docker', 'run', '-d', '--name', name, '--network', 'none', '--user', '1000:1000',
            '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
            '--memory', '536870912', '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m',
            '--env-file', str(env_file), '--mount', f'type=bind,source={data},target=/data', image]
    identifier = run(args)
    require(re.fullmatch(r'[a-f0-9]{64}', identifier) is not None, 'invalid rehearsal container ID')
    try:
        ready = False
        for _ in range(80):
            state = inspect(name)['State']
            if state.get('Status') != 'running':
                break
            logs = run(['docker', 'logs', name])
            if 'OpenAI 兼容代理地址' in logs:
                ready = True
                break
            time.sleep(.25)
        require(ready, 'isolated image did not reach startup marker')
        probe = "fetch('http://127.0.0.1:3123/api/meta').then(r=>console.log(r.status)).catch(()=>process.exit(1))"
        require(run(['docker', 'exec', name, 'node', '-e', probe]).strip() == '200',
                'isolated meta probe failed')
        facts = inspect(name)
        host = facts.get('HostConfig', {})
        require(facts.get('Image') == image and host.get('Memory') == 536870912 and
                host.get('ReadonlyRootfs') is True and host.get('CapDrop') == ['ALL'] and
                facts.get('State', {}).get('OOMKilled') is False,
                'isolated image hardening/memory mismatch')
        return {'id': identifier, 'image': facts.get('Image'), 'meta': 200,
                'memory': host.get('Memory'), 'readOnlyRootfs': host.get('ReadonlyRootfs')}
    finally:
        stopped = subprocess.run(['docker', 'stop', '-t', '10', name], capture_output=True, text=True, check=False)
        require(stopped.returncode == 0, 'isolated rehearsal container could not be stopped')


def main():
    require(len(sys.argv) == 3, 'expected release and pinned live config digest')
    _, release_name, config_hash = sys.argv
    require(re.fullmatch(r'20[0-9]{6}-[a-f0-9]{7}-[a-z0-9-]+', release_name) is not None and
            re.fullmatch(r'[a-f0-9]{64}', config_hash) is not None, 'invalid argument')
    stage = ROOT / '.deploy' / release_name
    evidence = read_json(stage / 'build-evidence.json')
    require(evidence.get('release') == release_name and evidence.get('composeOnlyImageAndContext') is True,
            'candidate build evidence missing')
    require(sha(ROOT / 'data/config.json') == config_hash,
            'live config drift before private-copy rehearsal')
    current = inspect('cline-pass-console')
    require(current.get('Id') == evidence['previousContainer'] and
            current.get('Image') == evidence['previousImage'] and
            current.get('State', {}).get('Health', {}).get('Status') == 'healthy',
            'live container changed before rehearsal')

    candidate_data = stage / 'candidate-data'
    old_data = stage / 'old-image-data'
    require(not candidate_data.exists() and not old_data.exists(), 'rehearsal copy already exists')
    candidate_data.mkdir(mode=0o700)
    source = str(ROOT / 'data') + '/'
    run(['rsync', '-a', '--numeric-ids', '--exclude=/detailed-logs/raw/***', source,
         str(candidate_data) + '/'])
    require(sha(ROOT / 'data/config.json') == config_hash and
            sha(candidate_data / 'config.json') == config_hash,
            'live config drifted during private copy')
    raw = candidate_data / 'detailed-logs/raw'
    require(not raw.exists() or not any(raw.iterdir()), 'raw detailed groups entered ordinary copy')
    before = read_json(candidate_data / 'config.json')
    before_identity = identity(before)
    admin_hash = sha(candidate_data / 'admin-auth.json')
    env_entries = current.get('Config', {}).get('Env') or []
    require(env_entries and all(isinstance(entry, str) and '=' in entry and
                                '\n' not in entry and '\r' not in entry and '\x00' not in entry
                                for entry in env_entries), 'container environment cannot be privately replayed')
    require(not any(entry.startswith('CLINE_PASS_RAW_BODY_READY=1') for entry in env_entries),
            'raw-body readiness must remain off')
    env_file = stage / 'runtime.env'
    write_private(env_file, '\n'.join(env_entries) + '\n')

    candidate = exercise('cps-new-' + release_name, evidence['image'], candidate_data, env_file)
    migrated = read_json(candidate_data / 'config.json')
    migrated_meta = read_json(candidate_data / 'metadata.json')
    snapshot = read_json(candidate_data / 'selection-counters.json')
    changed = changes(before, migrated)
    workflow = migrated.get('accountWorkflow') or {}
    require(changed == ['accountWorkflow'] and identity(migrated) == before_identity and
            workflow.get('enabled') is False and workflow.get('healthFilter') is False and
            workflow.get('minimumHealth') == .2 and
            migrated_meta.get('statistics', {}).get('version') == 5 and
            snapshot.get('version') == 1 and len(snapshot.get('accounts') or {}) == 0 and
            sha(candidate_data / 'admin-auth.json') == admin_hash,
            'candidate migration exceeded declared disabled-workflow/counter scope')
    migrated_hash = sha(candidate_data / 'config.json')

    old_data.mkdir(mode=0o700)
    run(['rsync', '-a', '--numeric-ids', '--exclude=/detailed-logs/raw/***',
         str(candidate_data) + '/', str(old_data) + '/'])
    require(sha(old_data / 'config.json') == migrated_hash, 'old-image rehearsal copy mismatch')
    old = exercise('cps-old-' + release_name, evidence['previousImage'], old_data, env_file)
    old_config = read_json(old_data / 'config.json')
    require(sha(old_data / 'config.json') == migrated_hash and identity(old_config) == before_identity and
            read_json(old_data / 'metadata.json').get('statistics', {}).get('version') == 5 and
            sha(old_data / 'admin-auth.json') == admin_hash,
            'old image changed or rejected the candidate-migrated state')
    require(sha(ROOT / 'data/config.json') == config_hash and
            inspect('cline-pass-console').get('Id') == evidence['previousContainer'],
            'live state drifted during rehearsal')
    result = {'release': release_name, 'accountIdentity': before_identity,
              'configBeforeSha256': config_hash, 'predictedConfigSha256': migrated_hash,
              'configChangedPaths': changed, 'statisticsVersion': 5,
              'workflowEnabled': False, 'healthFilter': False, 'minimumHealth': .2,
              'counterSnapshotVersion': 1, 'counterEntries': 0,
              'adminAuthUnchanged': True, 'rawExcluded': True,
              'candidate': candidate, 'previousImageReadback': old,
              'compatibleRollbackOnCopiedState': True}
    write_private(stage / 'rehearsal-evidence.json', json.dumps(result, sort_keys=True) + '\n')
    print(json.dumps(result, sort_keys=True))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'ok': False, 'error': str(error)}))
        sys.exit(1)
