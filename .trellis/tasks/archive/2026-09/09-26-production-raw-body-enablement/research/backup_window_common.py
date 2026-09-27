"""Backup-only local helpers. No production defaults, restore, deploy or raw reads.

Operational entry point: backup_pause_window.py. All output is fixed, never file
names, contents, subprocess stderr, or private configuration values.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import time

RAW = ('detailed-logs', 'raw')
EXCLUDE = '/detailed-logs/raw/***'
MAX_ENTRIES = 100_000
MAX_BYTES = 4 * 1024**3
HEX = re.compile(r'[0-9a-f]{64}\Z')


class GateError(Exception):
    pass


def require(ok, reason):
    if not ok:
        raise GateError(reason)


def private_path(path, *, anchor=Path('/'), owner=0, final_mode=None):
    """Require every existing component from anchor to path root-owned/private.

    anchor is / in the operational CLI. Synthetic tests may supply their own
    isolated private root, but cannot relax this in the CLI.
    """
    require(path.is_absolute() and anchor.is_absolute() and path.is_relative_to(anchor)
            and '..' not in path.parts, 'unsafe stage path')
    current = anchor
    for part in ((), *[(p,) for p in path.relative_to(anchor).parts]):
        if part:
            current = current / part[0]
        info = current.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == owner and
                not stat.S_IMODE(info.st_mode) & 0o022 and
                (final_mode is None or current != path or stat.S_IMODE(info.st_mode) == final_mode),
                'stage ancestry not private')


def regular(path, limit=None):
    before = path.lstat()
    require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and
            (limit is None or before.st_size <= limit), 'regular file gate')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    after = os.fstat(fd)
    if not (stat.S_ISREG(after.st_mode) and after.st_nlink == 1 and
            (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) ==
            (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns)):
        os.close(fd)
        raise GateError('file changed during open')
    return fd, before


def sha(path, deadline=None):
    fd, before = regular(path)
    try:
        h = hashlib.sha256()
        size = 0
        while chunk := os.read(fd, 1024 * 1024):
            require(deadline is None or time.monotonic() < deadline, 'backup deadline')
            size += len(chunk)
            h.update(chunk)
        after = os.fstat(fd)
        current = path.lstat()
        fields = ('st_dev', 'st_ino', 'st_size', 'st_mode', 'st_uid', 'st_gid',
                  'st_mtime_ns', 'st_ctime_ns', 'st_nlink')
        require(size == before.st_size and all(
            all(getattr(x, k) == getattr(before, k) for k in fields)
            for x in (after, current)), 'file changed during hash')
        return h.hexdigest()
    finally:
        os.close(fd)


def read_json(path, limit=8192):
    fd, before = regular(path, limit)
    try:
        content = os.read(fd, limit + 1)
        require(len(content) <= limit and os.fstat(fd).st_size == before.st_size and
                path.lstat().st_ino == before.st_ino, 'private JSON changed')
        return json.loads(content)
    finally:
        os.close(fd)


def stage_gate(stage, *, anchor=Path('/'), owner=0, data_uid=1000):
    private_path(stage, anchor=anchor, owner=owner, final_mode=0o700)
    private_path(stage / 'sidecars-complete', anchor=anchor, owner=owner, final_mode=0o700)
    info = (stage / 'data').lstat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == data_uid and
            stat.S_IMODE(info.st_mode) == 0o700, 'precopy data ownership')
    status = stage / 'status.json'
    info = status.lstat()
    require(stat.S_IMODE(info.st_mode) == 0o600 and info.st_uid == owner and
            read_json(status) == {'phase': 'precopy-unverified', 'trusted': False} and
            not os.path.lexists(stage / 'status.json.new'), 'untrusted status required')
    return True


def compose_env_source(compose, service, root):
    """Narrow literal Compose YAML contract. Anything complex needs manual review.

    Only one list-form env_file under the exact service is accepted; reject YAML
    anchors/interpolation/quoted paths and noncanonical/escaping paths instead of guessing.
    """
    fd, before = regular(compose, 65536)
    try:
        text = os.read(fd, 65537).decode('utf-8')
        require(len(text.encode()) == before.st_size, 'compose changed')
    finally:
        os.close(fd)
    lines = text.splitlines()
    require(not any('\t' in line or '${' in line or '&' in line or '*' in line for line in lines),
            'unsupported compose syntax')
    service_lines = []
    inside_services = inside_service = False
    for line in lines:
        if re.fullmatch(r'services:\s*(?:#.*)?', line):
            inside_services = True
            continue
        if inside_services and re.match(r'\S', line):
            inside_services = inside_service = False
        if inside_services and re.match(r'  [^ #][^:]*:', line):
            inside_service = line.split(':', 1)[0].strip() == service
        if inside_service:
            service_lines.append(line)
    indexes = [i for i, line in enumerate(service_lines) if re.fullmatch(r'    env_file:\s*', line)]
    require(len(indexes) == 1, 'service env_file authority')
    i = indexes[0]
    require(i + 1 < len(service_lines), 'service env_file missing')
    match = re.fullmatch(r'      - ([./a-zA-Z0-9_-]+)(?:\s+#.*)?', service_lines[i + 1])
    require(match, 'service env_file shape')
    for line in service_lines[i + 2:]:
        if not line.strip() or line.lstrip().startswith('#'):
            continue
        if len(line) - len(line.lstrip()) <= 4:
            break  # Next service-level field, not part of env_file.
        raise GateError('service env_file shape')  # No second item or nested syntax.
    require(root.is_absolute() and root == root.resolve(strict=True),
            'canonical project root')
    env = Path(match[1])
    require('..' not in env.parts and env.suffix == '.env', 'service env path')
    path = Path(os.path.normpath(env if env.is_absolute() else compose.parent / env))
    require(path != root and path.is_relative_to(root), 'env path outside root')
    # lstat every component: a link inside the project must not redirect the
    # sidecar read, even when its target also happens to be inside the project.
    current = root
    for part in path.relative_to(root).parts[:-1]:
        current /= part
        require(stat.S_ISDIR(current.lstat().st_mode), 'service env symlink/directory')
    require(stat.S_ISREG(path.lstat().st_mode), 'service env regular file')
    return path


def sidecars(stage, *, root, compose, service, gateway, nginx_root, owner=0, deadline=None):
    base = stage / 'sidecars-complete'
    manifest = base / 'source-manifest.json'
    info = manifest.lstat()
    require(info.st_uid == owner and stat.S_IMODE(info.st_mode) == 0o600,
            'manifest ownership')
    record = read_json(manifest)
    names = {'compose.yml', 'service.env', 'gateway.conf', 'deployment.json'}
    require(isinstance(record, dict) and set(record) ==
            {'files', 'gatewayLogicalPath', 'gatewayLinkTarget'} and
            isinstance(record['files'], dict) and set(record['files']) == names and
            {p.name for p in base.iterdir()} == names | {'source-manifest.json'},
            'unknown sidecar manifest')
    require(gateway.is_absolute() and gateway.is_relative_to(nginx_root) and
            '..' not in gateway.parts and gateway.is_symlink() and
            record['gatewayLogicalPath'] == str(gateway) and
            record['gatewayLinkTarget'] == os.readlink(gateway), 'gateway link drift')
    resolved = gateway.resolve(strict=True)
    require(resolved.is_relative_to(root.resolve(strict=True)) or
            resolved.is_relative_to(nginx_root.resolve(strict=True)),
            'gateway target outside expected roots')
    sources = {'compose.yml': compose, 'deployment.json': root / 'deployment.json',
               'service.env': compose_env_source(compose, service, root),
               'gateway.conf': resolved}
    for name in sorted(names):
        require(deadline is None or time.monotonic() < deadline, 'backup deadline')
        entry = record['files'][name]
        require(isinstance(entry, dict) and set(entry) ==
                {'source', 'sha256', 'uid', 'gid', 'mode'} and
                (entry['source'] == str(sources[name]) or
                 (name == 'gateway.conf' and isinstance(entry['source'], str) and
                  Path(entry['source']).resolve(strict=True) == sources[name])) and
                isinstance(entry['sha256'], str) and HEX.fullmatch(entry['sha256']) and
                all(type(entry[k]) is int and entry[k] >= 0 for k in ('uid', 'gid', 'mode')) and
                entry['mode'] <= 0o700 and entry['mode'] & 0o077 == 0,
                'sidecar authority/metadata')
        for p in (sources[name], base / name):
            info = p.lstat()
            require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and
                    (info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)) ==
                    (entry['uid'], entry['gid'], entry['mode']) and
                    sha(p, deadline) == entry['sha256'], 'sidecar parity')
    return True


def inventory(base, *, source=False, deadline=None):
    """Framed path/bytes/owner/mode parity; no raw traversal or names in output."""
    h = hashlib.sha256()
    count = total = 0
    root = base.lstat()
    require(stat.S_ISDIR(root.st_mode), 'data root')
    h.update(f'D\0{root.st_uid}\0{root.st_gid}\0{stat.S_IMODE(root.st_mode)}\0'.encode())

    def walk(parent, parts):
        nonlocal count, total
        with os.scandir(parent) as entries:
            children = []
            for item in entries:
                children.append(item)
                require(len(children) + count <= MAX_ENTRIES, 'entry bound')
        for item in sorted(children, key=lambda e: e.name):
            require(deadline is None or time.monotonic() < deadline, 'backup deadline')
            rel = parts + (item.name,)
            require(len(rel) <= 16 and len(item.name.encode('utf-8', 'surrogateescape')) <= 255 and
                    not any(c in item.name for c in ('\n', '\r', '\x00')), 'unsafe tree entry')
            info = item.stat(follow_symlinks=False)
            if rel == RAW:
                require(source and stat.S_ISDIR(info.st_mode), 'raw must be excluded')
                continue
            require((stat.S_ISREG(info.st_mode) and info.st_nlink == 1) or
                    stat.S_ISDIR(info.st_mode), 'unexpected tree entry')
            count += 1
            require(count <= MAX_ENTRIES, 'entry bound')
            total += info.st_size if stat.S_ISREG(info.st_mode) else 0
            require(total <= MAX_BYTES, 'byte bound')
            h.update(('/'.join(rel) + '\0').encode('utf-8', 'surrogateescape'))
            h.update(f'{info.st_uid}\0{info.st_gid}\0{stat.S_IMODE(info.st_mode)}\0'.encode())
            if stat.S_ISDIR(info.st_mode):
                h.update(b'D\0')
                walk(item.path, rel)
                now = item.stat(follow_symlinks=False)
                require((info.st_dev, info.st_ino, info.st_mtime_ns, info.st_ctime_ns) ==
                        (now.st_dev, now.st_ino, now.st_mtime_ns, now.st_ctime_ns),
                        'directory changed during scan')
            else:
                h.update(b'F\0')
                h.update(info.st_size.to_bytes(8, 'big'))
                h.update(bytes.fromhex(sha(Path(item.path), deadline)))
    walk(base, ())
    now = base.lstat()
    require((root.st_dev, root.st_ino, root.st_mtime_ns, root.st_ctime_ns,
             root.st_mode, root.st_uid, root.st_gid) ==
            (now.st_dev, now.st_ino, now.st_mtime_ns, now.st_ctime_ns,
             now.st_mode, now.st_uid, now.st_gid), 'data root changed during scan')
    return h.digest(), count, total


def atomic_status(stage, phase, *, source_tree, copy_tree, image, container_id,
                  config_sha256, compose_sha256):
    """Seal only verified non-raw inventory; isolated restore remains separate."""
    require(type(phase) is str and phase == 'quiescent-copy-verified-restore-pending',
            'status phase')

    def tree(value):
        require(type(value) is tuple and len(value) == 3, 'status tree shape')
        digest, entries, size = value
        require(type(digest) is bytes and len(digest) == 32 and
                type(entries) is int and 0 <= entries <= MAX_ENTRIES and
                type(size) is int and 0 <= size <= MAX_BYTES, 'status tree bounds')
        return {'sha256': digest.hex(), 'entries': entries, 'bytes': size}

    source, copy = tree(source_tree), tree(copy_tree)
    require(source == copy and type(image) is str and
            re.fullmatch(r'sha256:[0-9a-f]{64}', image) is not None and
            type(container_id) is str and HEX.fullmatch(container_id) and
            type(config_sha256) is str and HEX.fullmatch(config_sha256) and
            type(compose_sha256) is str and HEX.fullmatch(compose_sha256),
            'status evidence mismatch')
    record = {'phase': phase, 'trusted': False, 'sourceTree': source, 'copyTree': copy,
              'image': image, 'containerId': container_id,
              'configSha256': config_sha256, 'composeSha256': compose_sha256}
    encoded = (json.dumps(record, sort_keys=True) + '\n').encode()
    status = stage / 'status.json'
    info = status.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and
            info.st_uid == os.geteuid() and stat.S_IMODE(info.st_mode) == 0o600 and
            read_json(status) == {'phase': 'precopy-unverified', 'trusted': False},
            'untrusted status changed before seal')
    temp = stage / 'status.json.new'
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        require(os.write(fd, encoded) == len(encoded), 'short status write')
        os.fsync(fd)
    finally:
        os.close(fd)
    os.replace(temp, stage / 'status.json')
    fd = os.open(stage, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)
