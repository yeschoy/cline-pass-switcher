"""Install and build one immutable source release without touching live service state."""

import copy
import hashlib
import json
import os
import pathlib
import re
import stat
import subprocess
import sys
import tarfile


ROOT = pathlib.Path('/opt/cline-pass-switcher')
ALLOWED = {'.dockerignore', 'Dockerfile', 'LICENSE', 'README.md', 'config.example.json',
           'lib', 'package-lock.json', 'package.json', 'public', 'server.js'}
SOURCE_FILES = ('server.js', 'public/index.html', 'lib/account-workflow.js')


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def sha(path):
    value = hashlib.sha256()
    with path.open('rb') as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b''):
            value.update(block)
    return value.hexdigest()


def command_json(args):
    result = subprocess.run(args, capture_output=True, text=True, check=False)
    require(result.returncode == 0, 'read-only Docker projection failed')
    return json.loads(result.stdout)


def write_private(path, data):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'w', encoding='utf-8') as handle:
        handle.write(data)
        handle.flush()
        os.fsync(handle.fileno())


def compose_projection(path):
    return command_json(['docker', 'compose', '--project-directory', str(ROOT), '-f', str(path),
                         'config', '--format', 'json'])


def extract_archive(archive, release):
    count = total = 0
    with tarfile.open(archive, 'r:') as source:
        members = source.getmembers()
        for member in members:
            parts = pathlib.PurePosixPath(member.name).parts
            require(parts and parts[0] in ALLOWED and all(part not in ('', '.', '..') for part in parts),
                    'archive path is not allowlisted')
            require(not member.issym() and not member.islnk() and (member.isfile() or member.isdir()),
                    'archive contains unsupported member')
            count += 1
            total += member.size
            require(count <= 5000 and total <= 25 * 1024 * 1024, 'archive exceeds release bounds')
        for member in members:
            destination = release.joinpath(*pathlib.PurePosixPath(member.name).parts)
            if member.isdir():
                destination.mkdir(parents=True, exist_ok=True, mode=0o755)
            else:
                destination.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
                descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
                with os.fdopen(descriptor, 'wb') as target:
                    source_file = source.extractfile(member)
                    require(source_file is not None, 'archive member unreadable')
                    for block in iter(lambda: source_file.read(1024 * 1024), b''):
                        target.write(block)
        for parent, directories, files in os.walk(release):
            os.chmod(parent, 0o755)
            for name in directories:
                os.chmod(pathlib.Path(parent) / name, 0o755)
            for name in files:
                os.chmod(pathlib.Path(parent) / name, 0o644)
    return count


def main():
    require(len(sys.argv) == 10, 'expected release and eight immutable identities')
    (_, release_name, archive_hash, server_hash, html_hash, workflow_hash, compose_hash,
     config_hash, old_image, old_container) = sys.argv
    require(re.fullmatch(r'20[0-9]{6}-[a-f0-9]{7}-[a-z0-9-]+', release_name) is not None,
            'invalid release name')
    require(all(re.fullmatch(r'[a-f0-9]{64}', value) for value in
                (archive_hash, server_hash, html_hash, workflow_hash, compose_hash, config_hash)),
            'invalid digest argument')
    require(re.fullmatch(r'sha256:[a-f0-9]{64}', old_image) is not None and
            re.fullmatch(r'[a-f0-9]{64}', old_container) is not None,
            'invalid Docker identity argument')
    archive = pathlib.Path('/tmp') / (release_name + '.tar')
    archive_stat = archive.lstat()
    require(stat.S_ISREG(archive_stat.st_mode) and archive_stat.st_nlink == 1 and
            archive_stat.st_size <= 25 * 1024 * 1024 and sha(archive) == archive_hash,
            'uploaded archive does not match local source')
    require(sha(ROOT / 'compose.yml') == compose_hash and sha(ROOT / 'data/config.json') == config_hash,
            'live Compose/config drift before release preparation')
    with (ROOT / 'deployment.json').open(encoding='utf-8') as handle:
        previous = json.load(handle)
    current = command_json(['docker', 'inspect', 'cline-pass-console'])[0]
    require(previous.get('image') == old_image and current.get('Image') == old_image and
            current.get('Id') == old_container and current.get('State', {}).get('Status') == 'running' and
            current.get('State', {}).get('Health', {}).get('Status') == 'healthy',
            'live image/container changed before preparation')

    private_root = ROOT / '.deploy'
    if not private_root.exists():
        private_root.mkdir(mode=0o700)
    require(private_root.is_dir() and not private_root.is_symlink() and
            stat.S_IMODE(private_root.stat().st_mode) == 0o700 and private_root.stat().st_uid == 0,
            'private staging root is not trusted')
    stage = private_root / release_name
    release = ROOT / 'releases' / release_name
    require(not stage.exists() and not release.exists(), 'release or stage already exists')
    stage.mkdir(mode=0o700)
    release.mkdir(mode=0o755)
    member_count = extract_archive(archive, release)
    source_hashes = {name: sha(release / name) for name in SOURCE_FILES}
    require(source_hashes == dict(zip(SOURCE_FILES, (server_hash, html_hash, workflow_hash))),
            'extracted source hash mismatch')

    original = (ROOT / 'compose.yml').read_text(encoding='utf-8')
    old_release = previous.get('release')
    require(isinstance(old_release, str) and re.fullmatch(r'[A-Za-z0-9-]+', old_release),
            'previous release name is invalid')
    old_tag = 'cline-pass-switcher:' + old_release
    old_context = './releases/' + old_release
    new_tag = 'cline-pass-switcher:' + release_name
    new_context = './releases/' + release_name
    require(original.count(old_tag) == 1 and original.count(old_context) == 1,
            'expected exactly one image and context marker')
    candidate = original.replace(old_tag, new_tag).replace(old_context, new_context)
    before_lines, after_lines = original.splitlines(), candidate.splitlines()
    changed = [index for index, (before, after) in enumerate(zip(before_lines, after_lines)) if before != after]
    require(len(before_lines) == len(after_lines) and len(changed) == 2,
            'candidate Compose changed more than image and context lines')
    candidate_path = stage / 'candidate-compose.yml'
    write_private(candidate_path, candidate)
    original_config = compose_projection(ROOT / 'compose.yml')
    candidate_config = compose_projection(candidate_path)
    original_service = original_config['services']['cline-pass-console']
    candidate_service = candidate_config['services']['cline-pass-console']
    require(original_service.get('image') == old_tag and candidate_service.get('image') == new_tag and
            candidate_service.get('build', {}).get('context') == str(release),
            'candidate Compose resolves to the wrong source')
    before = copy.deepcopy(original_config)
    after = copy.deepcopy(candidate_config)
    for value in (before, after):
        value['services']['cline-pass-console']['image'] = '<image>'
        value['services']['cline-pass-console']['build']['context'] = '<context>'
    require(before == after, 'resolved Compose has unrelated changes')

    build_log = stage / 'build.log'
    descriptor = os.open(build_log, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'w', encoding='utf-8') as log:
        built = subprocess.run(['docker', 'compose', '--project-directory', str(ROOT), '-f', str(candidate_path),
                                'build', 'cline-pass-console'], stdout=log, stderr=subprocess.STDOUT,
                               check=False)
    require(built.returncode == 0, 'candidate Compose build failed; private build log retained')
    image = command_json(['docker', 'image', 'inspect', new_tag])[0]['Id']
    require(re.fullmatch(r'sha256:[a-f0-9]{64}', image) is not None, 'invalid candidate image ID')
    script = "const fs=require('node:fs'),crypto=require('node:crypto');const names=['server.js','public/index.html','lib/account-workflow.js'];console.log(JSON.stringify(Object.fromEntries(names.map(name=>[name,crypto.createHash('sha256').update(fs.readFileSync('/app/'+name)).digest('hex')]))))"
    image_files = command_json(['docker', 'run', '--rm', '--network', 'none', '--user', '1000:1000',
                                '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
                                '--memory', '536870912', '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m',
                                '--entrypoint', 'node', image, '-e', script])
    require(image_files == source_hashes, 'candidate image source hash/readability mismatch')
    evidence = {'release': release_name, 'archiveSha256': archive_hash,
                'archiveMembers': member_count, 'sourceHashes': source_hashes,
                'candidateComposeSha256': sha(candidate_path), 'image': image,
                'previousImage': old_image, 'previousContainer': old_container,
                'composeOnlyImageAndContext': True, 'imageReadableAsUid1000': True}
    write_private(stage / 'build-evidence.json', json.dumps(evidence, sort_keys=True) + '\n')
    print(json.dumps(evidence, sort_keys=True))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'ok': False, 'error': str(error)}))
        sys.exit(1)
