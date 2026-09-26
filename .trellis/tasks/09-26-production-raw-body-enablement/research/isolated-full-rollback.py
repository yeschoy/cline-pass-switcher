#!/usr/bin/env python3
"""Offline, synthetic-only backup/rollback rehearsal. Never use on a live DATA_DIR.

Usage (all paths direct children of ONE private, sentinel-marked synthetic root):
  isolated-full-rollback.py prepare --data ROOT/data --sidecars ROOT/sidecars --workspace ROOT/workspace
  # Mutate workspace/candidate-working/{data,sidecars} with synthetic v2 fixtures only.
  isolated-full-rollback.py snapshot-v2 --workspace ROOT/workspace
  isolated-full-rollback.py restore --workspace ROOT/workspace --expected-sha256 HASH --restored ROOT/restored

This is a quiet synthetic-tree check, NOT a concurrent production snapshot or an atomic
production rollback. Concurrent operator writes require a separate write/image/hash fence.
No image is started; old-image management/raw ingress isolation is a separate gate.
Failed/interrupted copies leave unaccepted staging on disk (never a sealed state).
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys

ROOT_MARKER = '.isolated-full-rollback-root'
ROOT_MARKER_BYTES = b'cps-full-rollback-private-synthetic-root-v1\n'
MARKER = '.isolated-synthetic-only'
MARKER_BYTES = b'cps-full-rollback-synthetic-fixture-v1\n'
DATA_FILES = ('config.json', 'metadata.json', 'admin-auth.json')
SIDECAR_FILES = ('compose.yml', 'service.env', 'gateway.conf', 'deployment.json')
MAX_FILES = 128
MAX_FILE_BYTES = 64 * 1024
MAX_TOTAL_BYTES = 2 * 1024 * 1024
RAW = ('detailed-logs', 'raw')
# The leading / anchors to DATA_DIR; *** excludes the directory AND every descendant.
RAW_EXCLUDE = '/detailed-logs/raw/***'


class GateError(Exception):
    pass


def fail_if(condition, message):
    if condition:
        raise GateError(message)


def directory(path):
    info = path.lstat()
    fail_if(not stat.S_ISDIR(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o700,
            'expected a real private directory (0700)')
    return info


def identity(info):
    # Ignore atime (reads themselves may update it); retain inode, owner, mode,
    # size, link count and modification/change clocks for quiet-tree checks.
    return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid,
            info.st_size, info.st_nlink, info.st_mtime_ns, info.st_ctime_ns)


def file_bytes(path, *, limit=MAX_FILE_BYTES):
    """Read bounded regular files by descriptor, rejecting swapped paths/hardlinks."""
    before = path.lstat()
    fail_if(not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > limit,
            'unsafe synthetic file')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        opened = os.fstat(fd)
        fail_if(not stat.S_ISREG(opened.st_mode) or opened.st_nlink != 1 or
                (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino) or
                opened.st_size > limit, 'synthetic file changed during open')
        chunks = []
        size = 0
        while chunk := os.read(fd, min(8192, limit + 1 - size)):
            size += len(chunk)
            fail_if(size > limit, 'synthetic file too large')
            chunks.append(chunk)
        after = os.fstat(fd)
        fail_if(identity(after) != identity(before) or identity(path.lstat()) != identity(before),
                'synthetic file changed during read')
        return b''.join(chunks)
    finally:
        os.close(fd)


def synthetic_root(path):
    """Do not resolve symlinks; verify the private, marked root itself."""
    fail_if('..' in Path(path).parts, 'parent traversal rejected')
    root = Path(os.path.abspath(path))
    info = directory(root)
    fail_if(info.st_uid != os.geteuid(), 'synthetic root must be owned by the operator')
    marker = root / ROOT_MARKER
    fail_if(stat.S_IMODE(marker.lstat().st_mode) != 0o600 or marker.lstat().st_uid != info.st_uid,
            'synthetic root marker must be private and operator-owned')
    fail_if(file_bytes(marker) != ROOT_MARKER_BYTES,
            'synthetic root marker mismatch')
    return root


def contained(root, path, *, exists=True):
    """Inspect every component below root, including staging parents; never follow links."""
    fail_if('..' in Path(path).parts, 'parent traversal rejected')
    p = Path(os.path.abspath(path))
    fail_if(p == root or root not in p.parents, 'path outside synthetic root')
    parts = p.relative_to(root).parts
    for n in range(1, len(parts)):
        directory(root.joinpath(*parts[:n]))
    if exists:
        directory(p)
    else:
        fail_if(p.exists() or p.is_symlink(), 'destination already exists')
        directory(p.parent)
    return p


def direct_child(root, path, *, exists=True):
    p = contained(root, path, exists=exists)
    fail_if(p.parent != root or p.name in (ROOT_MARKER, MARKER),
            'expected direct synthetic-root child')
    return p


def new_dir(root, path):
    p = contained(root, path, exists=False)
    p.mkdir(mode=0o700)
    directory(p)


def inventory(root, path, *, exclude_raw=False):
    """Digest non-raw bytes, ownership and modes (including tree root); never print values.

    The source raw entry must itself be a real directory. Its children may be huge or
    symlinks: do NOT enumerate, stat or read them. The rsync exclusion is independently
    verified by digesting the destination and rejecting any raw entry there.
    """
    path = contained(root, path)
    digest = hashlib.sha256()
    count = total = 0
    raw_seen = False

    def add_metadata(info, kind, rel):
        digest.update(('/'.join(rel) + '\0').encode())
        digest.update(f'{stat.S_IMODE(info.st_mode):04o}\0{info.st_uid}\0{info.st_gid}\0'.encode())
        digest.update(kind)

    add_metadata(path.lstat(), b'D\0', ())

    def visit(parent, parts):
        nonlocal count, total, raw_seen
        for item in sorted(parent.iterdir(), key=lambda p: p.name):
            rel = parts + (item.name,)
            fail_if(len(rel) > 12 or any(c in item.name for c in ('\n', '\r', '\x00')),
                    'invalid tree entry')
            info = item.lstat()
            if rel == RAW:
                fail_if(not stat.S_ISDIR(info.st_mode), 'raw entry is not a real directory')
                raw_seen = True
                if exclude_raw:
                    continue  # No descent, even for large files or symlinks inside raw.
                raise GateError('raw child must not enter an ordinary copy')
            fail_if(not (stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode)) or
                    (stat.S_ISREG(info.st_mode) and info.st_nlink != 1),
                    'symlink, hardlink or special file rejected')
            count += 1
            fail_if(count > MAX_FILES, 'synthetic fixture has too many entries')
            add_metadata(info, b'D\0' if stat.S_ISDIR(info.st_mode) else b'F\0', rel)
            if stat.S_ISDIR(info.st_mode):
                visit(item, rel)
                fail_if(identity(item.lstat()) != identity(info), 'source directory changed while reading')
            else:
                fail_if(info.st_size > MAX_FILE_BYTES, 'synthetic file too large')
                total += info.st_size
                fail_if(total > MAX_TOTAL_BYTES, 'synthetic tree too large')
                content = file_bytes(item)
                # Frame each file independently: raw concatenation lets adjacent
                # file content cross the following entry's metadata boundary.
                digest.update(len(content).to_bytes(8, 'big'))
                digest.update(hashlib.sha256(content).digest())
    visit(path, ())
    return digest.hexdigest(), raw_seen


def checked_tree(root, path, files, *, source_data=False, allow_empty_raw=False):
    path = contained(root, path)
    for name in (MARKER, *files):
        item = path / name
        content = file_bytes(item)
        fail_if(stat.S_IMODE(item.lstat().st_mode) != 0o600,
                'sensitive synthetic fixture file must be mode 0600')
        if name == MARKER:
            fail_if(content != MARKER_BYTES, 'synthetic sentinel mismatch')
    if allow_empty_raw:
        raw_dir = path.joinpath(*RAW)
        if raw_dir.exists() or raw_dir.is_symlink():
            directory(raw_dir)
            fail_if(any(raw_dir.iterdir()), 'raw groups must be absent for code-only rollback')
    digest, raw = inventory(root, path, exclude_raw=source_data or allow_empty_raw)
    fail_if(raw and not (source_data or allow_empty_raw), 'raw child must not enter an ordinary copy')
    return digest


def copy_tree(root, source, destination, *, data):
    source = contained(root, source)
    new_dir(root, destination)
    command = ['rsync', '-a', '--no-links', '--no-devices', '--no-specials']
    if data:
        command.append('--exclude=' + RAW_EXCLUDE)
    command += ['--', str(source) + '/', str(destination) + '/']
    try:
        subprocess.run(command, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except (OSError, subprocess.CalledProcessError) as error:
        raise GateError('rsync copy failed (inspect private staging)') from error
    expected, _ = inventory(root, source, exclude_raw=data)
    actual, raw = inventory(root, destination)
    fail_if(expected != actual or raw, 'copy verification failed or raw child present')
    return actual


def pair_digest(root, data, sidecars):
    h = hashlib.sha256()
    for tree, names in ((data, DATA_FILES), (sidecars, SIDECAR_FILES)):
        h.update(checked_tree(root, tree, names, allow_empty_raw=tree == data).encode('ascii'))
    return h.hexdigest()


def state_path(workspace):
    return workspace / 'state.json'


def write_state(workspace, state, *, replace=False):
    encoded = (json.dumps(state, sort_keys=True) + '\n').encode()
    target = state_path(workspace)
    if replace:
        temp = workspace / 'state.json.new'
        with temp.open('xb') as stream:
            os.chmod(temp, 0o600)
            stream.write(encoded)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, target)
    else:
        with target.open('xb') as stream:
            os.chmod(target, 0o600)
            stream.write(encoded)
            stream.flush()
            os.fsync(stream.fileno())


def read_state(workspace):
    p = state_path(workspace)
    info = p.lstat()
    fail_if(not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or
            stat.S_IMODE(info.st_mode) != 0o600, 'invalid rehearsal state')
    state = json.loads(file_bytes(p).decode('utf-8'))
    fail_if(set(state) != {'version', 'phase', 'v1', 'v2'} or state['version'] != 1 or
            state['phase'] not in ('prepared', 'sealed') or
            not re.fullmatch('[0-9a-f]{64}', state['v1']) or
            (state['v2'] is not None and not re.fullmatch('[0-9a-f]{64}', state['v2'])) or
            (state['phase'] == 'prepared' and state['v2'] is not None) or
            (state['phase'] == 'sealed' and state['v2'] is None),
            'invalid rehearsal state')
    return state


def tree_pair(parent):
    return parent / 'data', parent / 'sidecars'


def prepare(args):
    fail_if(Path(os.path.abspath(args.data)).parent != Path(os.path.abspath(args.sidecars)).parent or
            Path(os.path.abspath(args.data)).parent != Path(os.path.abspath(args.workspace)).parent,
            'inputs must share one synthetic root')
    root = synthetic_root(Path(os.path.abspath(args.data)).parent)
    data = direct_child(root, args.data)
    sidecars = direct_child(root, args.sidecars)
    workspace = direct_child(root, args.workspace, exists=False)
    fail_if(len({data, sidecars, workspace}) != 3, 'input and output paths must be distinct')
    checked_tree(root, data, DATA_FILES, source_data=True)
    before_data, _ = inventory(root, data, exclude_raw=True)
    before_sidecars = checked_tree(root, sidecars, SIDECAR_FILES)
    new_dir(root, workspace)
    pre = workspace / 'pre-v1'
    new_dir(root, pre)
    copy_tree(root, data, pre / 'data', data=True)
    copy_tree(root, sidecars, pre / 'sidecars', data=False)
    fail_if(inventory(root, data, exclude_raw=True)[0] != before_data or
            checked_tree(root, sidecars, SIDECAR_FILES) != before_sidecars,
            'source changed during backup; do not use this snapshot')
    working = workspace / 'candidate-working'
    new_dir(root, working)
    copy_tree(root, pre / 'data', working / 'data', data=True)
    copy_tree(root, pre / 'sidecars', working / 'sidecars', data=False)
    v1 = pair_digest(root, *tree_pair(pre))
    fail_if(pair_digest(root, *tree_pair(working)) != v1, 'candidate staging mismatch')
    write_state(workspace, {'version': 1, 'phase': 'prepared', 'v1': v1, 'v2': None})
    print('prepared synthetic v1; raw excluded and full non-raw bytes/modes/owners verified')


def snapshot_v2(args):
    root = synthetic_root(Path(os.path.abspath(args.workspace)).parent)
    workspace = direct_child(root, args.workspace)
    state = read_state(workspace)
    fail_if(state['phase'] != 'prepared', 'workspace is already sealed')
    fail_if(pair_digest(root, *tree_pair(workspace / 'pre-v1')) != state['v1'],
            'v1 digest mismatch')
    working = workspace / 'candidate-working'
    # Code-only raw=false precondition: the service may create an empty raw directory,
    # but any entry in it is a hard stop before the v2 copy can be sealed.
    digest = pair_digest(root, *tree_pair(working))
    post = workspace / 'post-v2'
    new_dir(root, post)
    copy_tree(root, working / 'data', post / 'data', data=True)
    copy_tree(root, working / 'sidecars', post / 'sidecars', data=False)
    fail_if(pair_digest(root, *tree_pair(post)) != digest or
            pair_digest(root, *tree_pair(working)) != digest, 'v2 changed during snapshot')
    write_state(workspace, {**state, 'phase': 'sealed', 'v2': digest}, replace=True)
    print(digest)


def restore(args):
    root = synthetic_root(Path(os.path.abspath(args.workspace)).parent)
    workspace = direct_child(root, args.workspace)
    restored = direct_child(root, args.restored, exists=False)
    fail_if(workspace == restored, 'restored path must be independent')
    state = read_state(workspace)
    fail_if(state['phase'] != 'sealed' or not re.fullmatch('[0-9a-f]{64}', args.expected_sha256),
            'missing sealed v2 or invalid expected digest')
    # All hash checks precede creation. Wrong hash/current drift is a no-op.
    fail_if(args.expected_sha256 != state['v2'] or
            pair_digest(root, *tree_pair(workspace / 'candidate-working')) != state['v2'] or
            pair_digest(root, *tree_pair(workspace / 'post-v2')) != state['v2'] or
            pair_digest(root, *tree_pair(workspace / 'pre-v1')) != state['v1'],
            'hash fence failed; preserve both versions and stop')
    new_dir(root, restored)
    pre = workspace / 'pre-v1'
    copy_tree(root, pre / 'data', restored / 'data', data=True)
    copy_tree(root, pre / 'sidecars', restored / 'sidecars', data=False)
    fail_if(pair_digest(root, *tree_pair(restored)) != state['v1'], 'restored v1 digest mismatch')
    print('restored synthetic v1 to new isolated path; post-v2 preserved; no image started')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    p = sub.add_parser('prepare')
    p.add_argument('--data', required=True)
    p.add_argument('--sidecars', required=True)
    p.add_argument('--workspace', required=True)
    p = sub.add_parser('snapshot-v2')
    p.add_argument('--workspace', required=True)
    p = sub.add_parser('restore')
    p.add_argument('--workspace', required=True)
    p.add_argument('--expected-sha256', required=True)
    p.add_argument('--restored', required=True)
    args = parser.parse_args()
    try:
        fail_if(any('..' in Path(value).parts for key, value in vars(args).items()
                    if key in ('data', 'sidecars', 'workspace', 'restored')),
                'parent traversal rejected')
        {'prepare': prepare, 'snapshot-v2': snapshot_v2, 'restore': restore}[args.command](args)
    except (GateError, OSError, ValueError, KeyError, TypeError) as error:
        # Never include paths, file contents or rsync stderr in public output.
        print('synthetic rollback gate failed (' + type(error).__name__ + ')', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
