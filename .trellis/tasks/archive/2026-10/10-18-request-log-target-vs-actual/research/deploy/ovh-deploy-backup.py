"""Create verified private rollback sidecars and test atomic replacement before live switch."""

import hashlib
import json
import os
import pathlib
import re
import stat
import subprocess
import sys


ROOT = pathlib.Path('/opt/cline-pass-switcher')
GATEWAY_LINK = pathlib.Path('/etc/nginx/conf.d/cps-admin-gateway.conf')
GATEWAY = ROOT / 'deployments/20260924-052044-c35cd746-admin-auth/gateway.conf'
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


def inspect():
    result = subprocess.run(['docker', 'inspect', 'cline-pass-console'], capture_output=True, text=True, check=False)
    require(result.returncode == 0, 'live Docker inspect failed')
    return json.loads(result.stdout)[0]


def write_exclusive(path, content):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'wb') as handle:
        handle.write(content)
        handle.flush()
        os.fsync(handle.fileno())


def atomic_replace(path, content):
    temp = path.with_name('.' + path.name + '.' + str(os.getpid()) + '.tmp')
    write_exclusive(temp, content)
    os.replace(temp, path)
    descriptor = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def copy_verified(source, destination):
    before = source.lstat()
    require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and before.st_size <= 200 * 1024 * 1024,
            'unsafe or oversized backup source')
    digest_before = sha(source)
    descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with source.open('rb') as incoming, os.fdopen(descriptor, 'wb') as outgoing:
        for block in iter(lambda: incoming.read(1024 * 1024), b''):
            outgoing.write(block)
        outgoing.flush()
        os.fsync(outgoing.fileno())
    digest_after = sha(source)
    require(digest_before == digest_after == sha(destination), 'backup source-copy-source digest mismatch')
    return {'sha256': digest_before, 'bytes': before.st_size, 'sourceMode': oct(stat.S_IMODE(before.st_mode))}


def main():
    require(len(sys.argv) == 7, 'expected release and five pinned live identities')
    _, release_name, compose_hash, config_hash, old_image, old_container, gateway_hash = sys.argv
    require(re.fullmatch(r'20[0-9]{6}-[a-f0-9]{7}-[a-z0-9-]+', release_name) is not None and
            all(re.fullmatch(r'[a-f0-9]{64}', value) for value in
                (compose_hash, config_hash, old_container, gateway_hash)) and
            re.fullmatch(r'sha256:[a-f0-9]{64}', old_image) is not None,
            'invalid immutable identity')
    stage = ROOT / '.deploy' / release_name
    built = read_json(stage / 'build-evidence.json')
    rehearsed = read_json(stage / 'rehearsal-evidence.json')
    require(built.get('previousImage') == old_image and built.get('previousContainer') == old_container and
            rehearsed.get('compatibleRollbackOnCopiedState') is True and
            rehearsed.get('configBeforeSha256') == config_hash,
            'candidate source/rehearsal gate incomplete')
    require(GATEWAY_LINK.is_symlink() and GATEWAY_LINK.resolve() == GATEWAY,
            'gateway symlink no longer points to the verified private file')
    current = inspect()
    require(current.get('Id') == old_container and current.get('Image') == old_image and
            current.get('State', {}).get('Status') == 'running' and
            current.get('State', {}).get('Health', {}).get('Status') == 'healthy' and
            sha(ROOT / 'compose.yml') == compose_hash and sha(ROOT / 'data/config.json') == config_hash and
            sha(GATEWAY) == gateway_hash,
            'live image/Compose/config/gateway drift before backup')

    scratch = stage / 'atomic-scratch-2'
    require(not scratch.exists(), 'atomic scratch already exists')
    scratch.mkdir(mode=0o700)
    target = scratch / 'compose-test'
    write_exclusive(target, b'old\n')
    atomic_replace(target, b'candidate\n')
    require(target.read_bytes() == b'candidate\n', 'atomic install scratch check failed')
    atomic_replace(target, b'old\n')
    require(target.read_bytes() == b'old\n', 'atomic restore scratch check failed')

    backup = stage / 'pre-switch-backup-2'
    require(not backup.exists(), 'pre-switch backup already exists')
    backup.mkdir(mode=0o700)
    sources = {
        'compose.yml': ROOT / 'compose.yml',
        'deployment.json': ROOT / 'deployment.json',
        'config.json': ROOT / 'data/config.json',
        'metadata.json': ROOT / 'data/metadata.json',
        'admin-auth.json': ROOT / 'data/admin-auth.json',
        'admin.env': ENV,
        'gateway.conf': GATEWAY,
    }
    manifest = {name: copy_verified(source, backup / name) for name, source in sources.items()}
    require(manifest['compose.yml']['sha256'] == compose_hash and
            manifest['config.json']['sha256'] == config_hash and
            manifest['gateway.conf']['sha256'] == gateway_hash and
            sha(ROOT / 'compose.yml') == compose_hash and sha(ROOT / 'data/config.json') == config_hash and
            inspect().get('Id') == old_container,
            'live state drifted during private backup')
    result = {'release': release_name, 'manifest': manifest, 'rawGroupsExcluded': True,
              'gatewayLinkTarget': str(GATEWAY),
              'atomicInstallRestoreScratch': True, 'oldContainerPreserved': True,
              'predictedConfigSha256': rehearsed['predictedConfigSha256'],
              'candidateImage': built['image']}
    write_exclusive(stage / 'backup-evidence.json', (json.dumps(result, sort_keys=True) + '\n').encode())
    print(json.dumps(result, sort_keys=True))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'ok': False, 'error': str(error)}))
        sys.exit(1)
