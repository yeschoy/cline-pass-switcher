"""Check the exact live candidate and record machine-verified, admin-pending deployment."""

import hashlib
import json
import os
import pathlib
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request


ROOT = pathlib.Path('/opt/cline-pass-switcher')
GATEWAY = ROOT / 'deployments/20260924-052044-c35cd746-admin-auth/gateway.conf'
ENV = ROOT / 'deployments/20260924-052044-c35cd746-admin-auth/admin.env'


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read_json(path):
    with path.open(encoding='utf-8') as handle:
        return json.load(handle)


def atomic_replace(path, content):
    temp = path.with_name('.' + path.name + '.' + str(os.getpid()) + '.tmp')
    descriptor = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'wb') as handle:
        handle.write(content)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temp, path)
    descriptor = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def docker_json(args):
    result = subprocess.run(['docker', *args], capture_output=True, text=True, check=False)
    require(result.returncode == 0, 'Docker inspection or internal probe failed')
    return json.loads(result.stdout)


def status(url, headers=None):
    request = urllib.request.Request(url, headers=headers or {})
    try:
        with urllib.request.urlopen(request, timeout=8) as response:
            return response.status
    except urllib.error.HTTPError as error:
        return error.code
    except Exception:
        return None


def identity(config):
    accounts = config.get('accounts') or []
    ids = sorted(str(row.get('id', '')) for row in accounts)
    owners = sorted(f"{row.get('id', '')}:{row.get('clientKeyId', 'legacy')}" for row in accounts)
    return {'count': len(accounts), 'ids': hashlib.sha256('|'.join(ids).encode()).hexdigest(),
            'owners': hashlib.sha256('|'.join(owners).encode()).hexdigest()}


def main():
    require(len(sys.argv) == 4, 'expected release, source commit and independent public status')
    _, release_name, commit, public_status = sys.argv
    require(re.fullmatch(r'20[0-9]{6}-[a-f0-9]{7}-[a-z0-9-]+', release_name) is not None and
            re.fullmatch(r'[a-f0-9]{40}', commit) is not None and public_status == '200',
            'invalid postcheck arguments')
    stage = ROOT / '.deploy' / release_name
    built = read_json(stage / 'build-evidence.json')
    rehearsed = read_json(stage / 'rehearsal-evidence.json')
    backed = read_json(stage / 'backup-evidence.json')
    phase = read_json(stage / 'phase.json')
    manifest = backed['manifest']
    require(phase.get('phase') == 'candidate-running' and
            phase.get('candidateImage') == built['image'] and
            phase.get('candidateContainer'), 'candidate switch phase missing')

    live = None
    for _ in range(120):
        projected = docker_json(['inspect', 'cline-pass-console'])[0]
        if projected.get('State', {}).get('Health', {}).get('Status') == 'healthy':
            live = projected
            break
        time.sleep(.5)
    require(live is not None and live.get('Id') == phase['candidateContainer'] and
            live.get('Image') == built['image'] and live.get('State', {}).get('Status') == 'running' and
            live.get('RestartCount') == 0 and live.get('State', {}).get('OOMKilled') is False,
            'candidate image/health/restart gate failed')
    host = live.get('HostConfig', {})
    require(host.get('Memory') == 536870912 and host.get('ReadonlyRootfs') is True and
            host.get('CapDrop') == ['ALL'] and live.get('Config', {}).get('User') == '1000:1000' and
            not any(value.startswith('CLINE_PASS_RAW_BODY_READY=1') for value in
                    live.get('Config', {}).get('Env') or []),
            'candidate runtime hardening or raw-readiness gate failed')
    require(sha(ROOT / 'compose.yml') == built['candidateComposeSha256'] and
            sha(ROOT / 'data/config.json') == rehearsed['predictedConfigSha256'] and
            sha(ROOT / 'data/admin-auth.json') == manifest['admin-auth.json']['sha256'] and
            sha(ENV) == manifest['admin.env']['sha256'] and
            sha(GATEWAY) == manifest['gateway.conf']['sha256'],
            'candidate Compose/config/admin/gateway hash gate failed')
    config = read_json(ROOT / 'data/config.json')
    metadata = read_json(ROOT / 'data/metadata.json')
    counters = read_json(ROOT / 'data/selection-counters.json')
    workflow = config.get('accountWorkflow') or {}
    target_size = metadata.get('cachePoolTargetSize')
    require(identity(config) == rehearsed['accountIdentity'] and
            config.get('accountMode') == 'sticky' and
            workflow.get('enabled') is False and workflow.get('healthFilter') is False and
            workflow.get('minimumHealth') == .2 and config.get('rawBodyLogging') is False and
            metadata.get('statistics', {}).get('version') == 5 and
            isinstance(target_size, int) and 5 <= target_size <= 100 and
            counters.get('version') == 1,
            'candidate account/policy/statistics/counter gate failed')
    local_gateway = status('http://127.0.0.1:3123/api/meta')
    local_direct = status('http://127.0.0.1:3124/api/meta')
    local_console = status('http://127.0.0.1:3123/')
    require((local_gateway, local_direct, local_console) == (200, 200, 200),
            'local app/gateway/console probe failed')

    networks = live.get('NetworkSettings', {}).get('Networks') or {}
    internal = [(name, value) for name, value in networks.items()
                if 'cline-pass-switcher' in (value.get('Aliases') or [])]
    require(len(internal) == 1, 'internal service alias is missing or ambiguous')
    probe = "fetch('http://cline-pass-switcher:3123/api/meta').then(r=>console.log(JSON.stringify({status:r.status}))).catch(()=>process.exit(1))"
    internal_result = docker_json(['run', '--rm', '--network', internal[0][0],
                                   '--user', '1000:1000', '--read-only', '--cap-drop', 'ALL',
                                   '--security-opt', 'no-new-privileges', '--memory', '536870912',
                                   '--entrypoint', 'node', built['image'], '-e', probe])
    require(internal_result.get('status') == 200, 'internal service alias probe failed')

    client_key = config.get('proxyKey') or ''
    require(isinstance(client_key, str) and client_key, 'effective legacy client key unavailable')
    denied = {}
    for route in ('/api/models', '/api/statistics', '/api/logs/requests', '/api/logs/details/settings'):
        denied[route] = status('http://127.0.0.1:3123' + route,
                               {'Authorization': 'Bearer ' + client_key})
    require(all(code == 401 for code in denied.values()),
            'client-key-only protected management denial failed')
    logs = subprocess.run(['docker', 'logs', '--tail', '150', live['Id']],
                          capture_output=True, text=True, check=False)
    require(logs.returncode == 0 and all(marker not in (logs.stdout + logs.stderr) for marker in
            ('SyntaxError:', 'EACCES', 'invalid selectionCounters', 'unsupported statistics version')),
            'fatal startup marker observed; private logs retained on host')
    require(sha(ROOT / 'data/config.json') == rehearsed['predictedConfigSha256'] and
            sha(ROOT / 'deployment.json') == manifest['deployment.json']['sha256'],
            'config or deployment record changed during acceptance checks')

    result = {'release': release_name, 'commit': commit, 'image': built['image'],
              'container': live['Id'], 'startedAt': live.get('State', {}).get('StartedAt'),
              'health': 'healthy', 'restarts': 0, 'oomKilled': False,
              'memory': host.get('Memory'), 'accountIdentity': rehearsed['accountIdentity'],
              'configSha256': rehearsed['predictedConfigSha256'],
              'statisticsVersion': 5, 'cachePoolTargetSize': target_size,
              'workflowEnabled': False, 'healthFilter': False, 'rawBodyLogging': False,
              'selectionCounterVersion': 1,
              'localGatewayMeta': local_gateway, 'localAppMeta': local_direct,
              'localConsole': local_console, 'internalAliasMeta': 200,
              'independentPublicMeta': 200, 'clientKeyOnlyDenied': denied,
              'authenticatedAdminViews': False, 'status': 'awaiting-admin-acceptance'}
    atomic_replace(stage / 'postcheck-evidence.json', (json.dumps(result, sort_keys=True) + '\n').encode())
    deployment = {'release': release_name, 'commit': commit, 'image': built['image'],
                  'previousRelease': read_json(stage / 'pre-switch-backup-2/deployment.json').get('release'),
                  'previousImage': built['previousImage'],
                  'sourceArchiveSha256': built['archiveSha256'],
                  'configSha256': rehearsed['predictedConfigSha256'],
                  'status': 'awaiting-admin-acceptance',
                  'machineVerification': {'imageHealthy': True, 'accountIdentityPreserved': True,
                                          'configMigrationPredicted': True, 'localMeta': 200,
                                          'internalMeta': 200, 'independentPublicMeta': 200,
                                          'clientKeyOnlyDenied': True, 'rawCaptureOff': True},
                  'adminAcceptance': {'authenticatedProtectedViews': False,
                                      'quotaRefreshValidation': False,
                                      'realBrowserInteraction': False}}
    atomic_replace(ROOT / 'deployment.json', (json.dumps(deployment, sort_keys=True, indent=2) + '\n').encode())
    require(read_json(ROOT / 'deployment.json').get('image') == built['image'] and
            sha(ROOT / 'data/config.json') == rehearsed['predictedConfigSha256'],
            'postcheck record or config changed after publication')
    phase['phase'] = 'machine-local-passed'
    atomic_replace(stage / 'phase.json', (json.dumps(phase, sort_keys=True) + '\n').encode())
    print(json.dumps(result, sort_keys=True))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'ok': False, 'error': str(error)}))
        sys.exit(1)
