"""Guarded two-field Compose switch. On ambiguity, preserve state for inspection."""

import hashlib
import json
import os
import pathlib
import re
import subprocess
import sys
import urllib.request


ROOT = pathlib.Path('/opt/cline-pass-switcher')
GATEWAY = ROOT / 'deployments/20260924-052044-c35cd746-admin-auth/gateway.conf'
GATEWAY_LINK = pathlib.Path('/etc/nginx/conf.d/cps-admin-gateway.conf')
ENV = ROOT / 'deployments/20260924-052044-c35cd746-admin-auth/admin.env'


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def sha(path):
    value = hashlib.sha256()
    with path.open('rb') as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b''):
            value.update(block)
    return value.hexdigest()


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


def inspect():
    result = subprocess.run(['docker', 'inspect', 'cline-pass-console'], capture_output=True, text=True, check=False)
    require(result.returncode == 0, 'live Docker inspect failed')
    return json.loads(result.stdout)[0]


def probe(url):
    try:
        with urllib.request.urlopen(url, timeout=5) as response:
            return response.status
    except Exception:
        return None


def main():
    require(len(sys.argv) in (2, 3) and (len(sys.argv) == 2 or sys.argv[2] == '--preflight'),
            'expected release name and optional preflight mode')
    release_name = sys.argv[1]
    preflight_only = len(sys.argv) == 3
    require(re.fullmatch(r'20[0-9]{6}-[a-f0-9]{7}-[a-z0-9-]+', release_name) is not None,
            'invalid release name')
    stage = ROOT / '.deploy' / release_name
    built = read_json(stage / 'build-evidence.json')
    rehearsed = read_json(stage / 'rehearsal-evidence.json')
    backed = read_json(stage / 'backup-evidence.json')
    manifest = backed['manifest']
    backup = stage / 'pre-switch-backup-2'
    require(rehearsed.get('compatibleRollbackOnCopiedState') is True and
            backed.get('atomicInstallRestoreScratch') is True and
            built.get('composeOnlyImageAndContext') is True and
            not (stage / 'phase.json').exists(), 'pre-switch gates or phase state invalid')
    for name in manifest:
        require(sha(backup / name) == manifest[name]['sha256'], 'private rollback backup changed')
    require(GATEWAY_LINK.is_symlink() and GATEWAY_LINK.resolve() == GATEWAY and
            sha(GATEWAY) == manifest['gateway.conf']['sha256'] and
            sha(ENV) == manifest['admin.env']['sha256'] and
            sha(ROOT / 'data/admin-auth.json') == manifest['admin-auth.json']['sha256'] and
            sha(ROOT / 'deployment.json') == manifest['deployment.json']['sha256'],
            'admin/gateway/deployment sidecar drift before switch')
    require(sha(ROOT / 'compose.yml') == manifest['compose.yml']['sha256'] and
            sha(ROOT / 'data/config.json') == manifest['config.json']['sha256'] and
            sha(stage / 'candidate-compose.yml') == built['candidateComposeSha256'],
            'Compose/config/candidate bytes drift before switch')
    current = inspect()
    require(current.get('Id') == built['previousContainer'] and
            current.get('Image') == built['previousImage'] and
            current.get('State', {}).get('Status') == 'running' and
            current.get('State', {}).get('Health', {}).get('Status') == 'healthy' and
            current.get('RestartCount') == 0,
            'live container changed before switch')
    image = subprocess.run(['docker', 'image', 'inspect', 'cline-pass-switcher:' + release_name],
                           capture_output=True, text=True, check=False)
    require(image.returncode == 0 and json.loads(image.stdout)[0]['Id'] == built['image'],
            'candidate image tag no longer matches rehearsed image')
    require(probe('http://127.0.0.1:3123/api/meta') == 200 and
            probe('http://127.0.0.1:3124/api/meta') == 200,
            'local public gateway or direct app was unhealthy before switch')
    if preflight_only:
        print(json.dumps({'ready': True, 'release': release_name, 'oldContainer': current['Id'],
                          'oldImage': current['Image'], 'candidateImage': built['image'],
                          'configSha256': sha(ROOT / 'data/config.json'),
                          'predictedConfigSha256': rehearsed['predictedConfigSha256'],
                          'gatewayMeta': 200, 'directAppMeta': 200}, sort_keys=True))
        return

    phase = {'phase': 'prepared', 'release': release_name, 'previousContainer': built['previousContainer'],
             'previousImage': built['previousImage'], 'candidateImage': built['image'],
             'oldComposeSha256': manifest['compose.yml']['sha256'],
             'candidateComposeSha256': built['candidateComposeSha256'],
             'oldConfigSha256': manifest['config.json']['sha256'],
             'predictedConfigSha256': rehearsed['predictedConfigSha256']}
    atomic_replace(stage / 'phase.json', (json.dumps(phase, sort_keys=True) + '\n').encode())
    candidate_bytes = (stage / 'candidate-compose.yml').read_bytes()
    atomic_replace(ROOT / 'compose.yml', candidate_bytes)
    require(sha(ROOT / 'compose.yml') == built['candidateComposeSha256'],
            'candidate Compose install did not match rehearsed bytes')
    phase['phase'] = 'compose-installed'
    atomic_replace(stage / 'phase.json', (json.dumps(phase, sort_keys=True) + '\n').encode())
    log_path = stage / 'switch.log'
    descriptor = os.open(log_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'w', encoding='utf-8') as log:
        try:
            switched = subprocess.run(['docker', 'compose', '--project-directory', str(ROOT),
                                       '-f', str(ROOT / 'compose.yml'), 'up', '-d', '--no-build',
                                       '--no-deps', 'cline-pass-console'], stdout=log,
                                      stderr=subprocess.STDOUT, timeout=120, check=False)
        except subprocess.TimeoutExpired:
            raise RuntimeError('Compose switch timed out; inspect possibly changed live state')
    require(switched.returncode == 0, 'Compose switch failed; inspect possibly changed live state')
    phase['phase'] = 'up-command-returned'
    atomic_replace(stage / 'phase.json', (json.dumps(phase, sort_keys=True) + '\n').encode())
    latest = inspect()
    require(latest.get('Image') == built['image'] and latest.get('State', {}).get('Status') == 'running',
            'Compose returned but candidate image is not running')
    phase['phase'] = 'candidate-running'
    phase['candidateContainer'] = latest['Id']
    atomic_replace(stage / 'phase.json', (json.dumps(phase, sort_keys=True) + '\n').encode())
    print(json.dumps({'ok': True, 'phase': phase['phase'], 'release': release_name,
                      'candidateContainer': latest['Id'], 'candidateImage': latest['Image'],
                      'configSha256': sha(ROOT / 'data/config.json')}, sort_keys=True))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'ok': False, 'error': str(error)}))
        sys.exit(1)
