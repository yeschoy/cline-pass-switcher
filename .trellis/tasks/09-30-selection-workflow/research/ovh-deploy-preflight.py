"""Read-only, secret-free projection of the canonical production installation."""

import hashlib
import json
import os
import pathlib
import shutil
import stat
import subprocess
import yaml


ROOT = pathlib.Path('/opt/cline-pass-switcher')


def digest(path):
    value = hashlib.sha256()
    with path.open('rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            value.update(chunk)
    return value.hexdigest()


def read_json(path):
    with path.open('r', encoding='utf-8') as handle:
        return json.load(handle)


def command_json(argv):
    result = subprocess.run(argv, capture_output=True, text=True, check=False)
    if result.returncode:
        return None
    return json.loads(result.stdout)


def safe_file(name):
    target = ROOT / name
    if not target.is_file():
        return {'exists': False}
    mode = stat.S_IMODE(target.stat().st_mode)
    return {'exists': True, 'sha256': digest(target), 'mode': oct(mode)}


def main():
    record = read_json(ROOT / 'deployment.json')
    config = read_json(ROOT / 'data/config.json')
    metadata = read_json(ROOT / 'data/metadata.json')
    compose = command_json(['docker', 'compose', '--project-directory', str(ROOT), '-f', str(ROOT / 'compose.yml'), 'config', '--format', 'json'])
    inspected = command_json(['docker', 'inspect', 'cline-pass-console'])
    service = (compose or {}).get('services', {}).get('cline-pass-console', {})
    compose_text = (ROOT / 'compose.yml').read_text(encoding='utf-8')
    raw_compose = yaml.safe_load(compose_text) or {}
    raw_service = (raw_compose.get('services') or {}).get('cline-pass-console') or {}
    raw_env_files = raw_service.get('env_file') or []
    if isinstance(raw_env_files, (str, dict)):
        raw_env_files = [raw_env_files]
    env_file_paths = [entry if isinstance(entry, str) else entry.get('path') for entry in raw_env_files]
    gateway_candidates = []
    for directory in (pathlib.Path('/etc/nginx/conf.d'), pathlib.Path('/etc/nginx/sites-enabled')):
        if not directory.is_dir():
            continue
        for entry in directory.iterdir():
            if not entry.is_file() or entry.stat().st_size > 1024 * 1024:
                continue
            content = entry.read_text(encoding='utf-8', errors='replace')
            if '127.0.0.1:3123' in content:
                gateway_candidates.append({'path': str(entry), 'sha256': digest(entry)})
    old_release = record.get('release', '')
    container = inspected[0] if isinstance(inspected, list) and inspected else {}
    state = container.get('State', {})
    host = container.get('HostConfig', {})
    workflow = config.get('accountWorkflow') or {}
    pipeline = config.get('accountPipeline') or {}
    statistics = metadata.get('statistics') or {}
    counters_path = ROOT / 'data/selection-counters.json'
    counters = read_json(counters_path) if counters_path.is_file() else {}
    accounts = config.get('accounts') or []
    account_ids = sorted(str(row.get('id', '')) for row in accounts)
    account_owners = sorted(f"{row.get('id', '')}:{row.get('clientKeyId', 'legacy')}" for row in accounts)
    disk = shutil.disk_usage(ROOT)
    environment = service.get('environment') or {}
    out = {
        'deployment': {key: record.get(key) for key in ('release', 'commit', 'image', 'previousRelease', 'previousImage', 'status')},
        'files': {name: safe_file(name) for name in ('compose.yml', 'deployment.json', 'data/config.json', 'data/metadata.json', 'data/admin-auth.json', 'data/selection-counters.json')},
        'compose': {'available': compose is not None, 'image': service.get('image'),
                    'buildContext': (service.get('build') or {}).get('context') if isinstance(service.get('build'), dict) else service.get('build'),
                    'memory': service.get('mem_limit'), 'readOnly': service.get('read_only'),
                    'user': service.get('user'), 'environmentKeys': sorted(environment) if isinstance(environment, dict) else [],
                    'stopGracePeriod': service.get('stop_grace_period'),
                    'networkNames': sorted((service.get('networks') or {}).keys()),
                    'ports': service.get('ports'), 'tmpfs': service.get('tmpfs'),
                    'securityOpt': service.get('security_opt')},
        'composeMarkers': {'imageCount': compose_text.count('cline-pass-switcher:' + old_release),
                           'relativeContextCount': compose_text.count('./releases/' + old_release)},
        'rawComposeEnvFiles': env_file_paths,
        'gatewayConfigCandidates': gateway_candidates,
        'container': {'available': bool(container), 'id': container.get('Id'), 'image': container.get('Image'),
                      'status': state.get('Status'), 'health': (state.get('Health') or {}).get('Status'),
                      'startedAt': state.get('StartedAt'), 'restarts': container.get('RestartCount'),
                      'oomKilled': state.get('OOMKilled'), 'memory': host.get('Memory'),
                      'readOnlyRootfs': host.get('ReadonlyRootfs'), 'capDrop': host.get('CapDrop')},
        'config': {'accounts': len(accounts), 'accountIdSha256': hashlib.sha256('|'.join(account_ids).encode()).hexdigest(),
                   'accountOwnerSha256': hashlib.sha256('|'.join(account_owners).encode()).hexdigest(),
                   'finiteConcurrencyTotal': sum(int(row.get('maxConcurrent') or 0) for row in accounts),
                   'mode': config.get('accountMode'),
                   'workflowPresent': 'accountWorkflow' in config, 'workflowEnabled': workflow.get('enabled'),
                   'healthFilter': workflow.get('healthFilter'), 'minimumHealth': workflow.get('minimumHealth'),
                   'cachePoolSize': pipeline.get('cachePoolSize'), 'cachePoolMaxSize': pipeline.get('cachePoolMaxSize'),
                   'errorDetailLogging': config.get('errorDetailLogging'), 'rawBodyLogging': config.get('rawBodyLogging')},
        'metadata': {'statisticsVersion': statistics.get('version'), 'cachePoolTargetSize': metadata.get('cachePoolTargetSize'),
                     'selectionMirrorPresent': 'selectionCounters' in metadata},
        'counterSnapshot': {'present': counters_path.is_file(), 'version': counters.get('version'),
                            'accountEntries': len(counters.get('accounts') or {})},
        'diskFreeBytes': disk.free,
        'rawDirectoryPresent': (ROOT / 'data/detailed-logs/raw').exists(),
    }
    print(json.dumps(out, ensure_ascii=True, sort_keys=True))


if __name__ == '__main__':
    main()
