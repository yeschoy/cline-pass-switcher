"""Immediate guarded rollback for the copy-proven compatible workflow migration."""

import hashlib
import json
import os
import pathlib
import re
import subprocess
import sys
import time
import urllib.request


ROOT = pathlib.Path('/opt/cline-pass-switcher')


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
    require(len(sys.argv) == 2, 'expected release name')
    release_name = sys.argv[1]
    require(re.fullmatch(r'20[0-9]{6}-[a-f0-9]{7}-[a-z0-9-]+', release_name) is not None,
            'invalid release name')
    stage = ROOT / '.deploy' / release_name
    built = read_json(stage / 'build-evidence.json')
    rehearsed = read_json(stage / 'rehearsal-evidence.json')
    backed = read_json(stage / 'backup-evidence.json')
    phase = read_json(stage / 'phase.json')
    manifest = backed['manifest']
    backup = stage / 'pre-switch-backup-2'
    require(rehearsed.get('compatibleRollbackOnCopiedState') is True and
            phase.get('candidateImage') == built['image'] and
            phase.get('phase') in ('compose-installed', 'up-command-returned', 'candidate-running'),
            'rollback phase or compatibility gate invalid')
    require(sha(backup / 'compose.yml') == manifest['compose.yml']['sha256'] and
            sha(backup / 'config.json') == manifest['config.json']['sha256'] and
            sha(ROOT / 'deployment.json') == manifest['deployment.json']['sha256'],
            'rollback backup or deployment record changed')
    current_hash = sha(ROOT / 'data/config.json')
    require(current_hash in (manifest['config.json']['sha256'], rehearsed['predictedConfigSha256']),
            'operator config changed after switch; preserve bytes and obtain intent')
    current = inspect()
    require(current.get('Image') in (built['image'], built['previousImage']),
            'an unexpected image is running')
    require(sha(ROOT / 'compose.yml') in (built['candidateComposeSha256'], manifest['compose.yml']['sha256']),
            'an unexpected Compose version is installed')
    previous_image = subprocess.run(['docker', 'image', 'inspect', built['previousImage']],
                                    capture_output=True, text=True, check=False)
    require(previous_image.returncode == 0, 'exact previous image is missing')

    phase['phase'] = 'rollback-started'
    atomic_replace(stage / 'phase.json', (json.dumps(phase, sort_keys=True) + '\n').encode())
    if current.get('Image') == built['image'] and current.get('State', {}).get('Status') == 'running':
        stopped = subprocess.run(['docker', 'stop', '-t', '10', current['Id']],
                                 capture_output=True, text=True, check=False)
        require(stopped.returncode == 0, 'candidate container could not be stopped')
    require(sha(ROOT / 'data/config.json') == current_hash,
            'config changed during rollback fence')
    if current_hash == rehearsed['predictedConfigSha256']:
        preserve = stage / 'post-switch-config-before-rollback.json'
        descriptor = os.open(preserve, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, 'wb') as handle:
            handle.write((ROOT / 'data/config.json').read_bytes())
            handle.flush()
            os.fsync(handle.fileno())
        atomic_replace(ROOT / 'data/config.json', (backup / 'config.json').read_bytes())
    atomic_replace(ROOT / 'compose.yml', (backup / 'compose.yml').read_bytes())
    require(sha(ROOT / 'compose.yml') == manifest['compose.yml']['sha256'] and
            sha(ROOT / 'data/config.json') == manifest['config.json']['sha256'],
            'restored Compose/config hash mismatch')
    phase['phase'] = 'old-compose-restored'
    atomic_replace(stage / 'phase.json', (json.dumps(phase, sort_keys=True) + '\n').encode())
    log_path = stage / 'rollback.log'
    descriptor = os.open(log_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'w', encoding='utf-8') as log:
        restarted = subprocess.run(['docker', 'compose', '--project-directory', str(ROOT),
                                    '-f', str(ROOT / 'compose.yml'), 'up', '-d', '--no-build',
                                    '--no-deps', 'cline-pass-console'], stdout=log,
                                   stderr=subprocess.STDOUT, timeout=120, check=False)
    require(restarted.returncode == 0, 'old Compose restart failed; retain rollback evidence')
    healthy = False
    for _ in range(120):
        old = inspect()
        if (old.get('Image') == built['previousImage'] and
                old.get('State', {}).get('Status') == 'running' and
                old.get('State', {}).get('Health', {}).get('Status') == 'healthy'):
            healthy = True
            break
        time.sleep(.5)
    require(healthy and probe('http://127.0.0.1:3123/api/meta') == 200 and
            probe('http://127.0.0.1:3124/api/meta') == 200,
            'exact old image did not pass local recovery probes')
    phase['phase'] = 'rolled-back'
    phase['restoredContainer'] = old['Id']
    atomic_replace(stage / 'phase.json', (json.dumps(phase, sort_keys=True) + '\n').encode())
    result = {'rolledBack': True, 'release': release_name, 'oldImage': old['Image'],
              'oldContainer': old['Id'], 'composeSha256': sha(ROOT / 'compose.yml'),
              'configSha256': sha(ROOT / 'data/config.json'), 'localMeta': 200}
    atomic_replace(stage / 'rollback-evidence.json', (json.dumps(result, sort_keys=True) + '\n').encode())
    print(json.dumps(result, sort_keys=True))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'ok': False, 'error': str(error)}))
        sys.exit(1)
