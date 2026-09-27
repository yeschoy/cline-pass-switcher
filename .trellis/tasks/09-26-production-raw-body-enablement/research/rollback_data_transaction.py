"""Raw-OFF rollback DATA_DIR rename boundary, NOT a deployment/stop/start tool.

Callable only with a separately enforced all-writers/ingress fence and an exact
candidate STOP probe. No Docker commands, network calls or CLI; the canonical
operational path is a refusal guard, not an execution default. The caller must
independently seal a complete v2 copy and restore v1 to a new path,
then explicitly authorize the loss/retention decision. No old image is started.

The stage is root-private and contains the exact marker below, `seal.json`,
`sealed-v2/` and `prepared-v1/`. `sealed-v1` is an independent immutable private tree.
The external backup owner writes seal.json BEFORE this helper is called; it must
contain {"version":1,"v1":<tree hex>,"v1Config":<config hex>,
"v2":<tree hex>,"v2Config":<config hex>}. It is not a substitute for the
external stopped-writer fence or sidecar backup/restore approval. Paths are
absolute; the active basename must be `data` and the root-private stage's
`preserved-v2-live/` must not exist. Journal and both rename parents are fsynced
at every boundary. A crash
between the two renames leaves NO active DATA_DIR: recover_gap() can only install
verified v1 if the preserved v2 is still intact and the active path is absent.
Never retry replace() or start an image in an ambiguous state.
"""
import ctypes
import fcntl
import json
import os
from pathlib import Path
import re
import stat
import sys

from backup_window_common import GateError, HEX, inventory, private_path, read_json, require, sha

MARKER = '.cps-rollback-data-transaction'
MARKER_BYTES = b'cps-rollback-data-transaction-v1\n'
STAGE_NAME = re.compile(r'cps-rollback-data-[0-9a-f]{16}\Z')
IMAGE = re.compile(r'sha256:[0-9a-f]{64}\Z')
# Not an arbitrary maximum: this is the existing bounded non-raw inventory gate.
# The backup/seal owner must independently verify the entire tree and sidecars.


def _path(path, anchor):
    require(isinstance(path, Path) and path.is_absolute() and
            '..' not in path.parts and '.' not in path.parts and
            path.is_relative_to(anchor), 'absolute private path required')
    return path


def _missing(path):
    require(not os.path.lexists(path), 'destination already exists')


def _dir(path, *, owner=None, mode=None):
    require(os.path.lexists(path), 'required directory missing')
    info = path.lstat()
    require(stat.S_ISDIR(info.st_mode) and
            (owner is None or info.st_uid == owner) and
            (mode is None or stat.S_IMODE(info.st_mode) == mode), 'directory gate')
    return info


def _rename_exclusive(source, dest):
    """No TOCTOU overwrite of a newly created directory. Never fall back to rename."""
    libc = ctypes.CDLL(None, use_errno=True)
    src, dst = os.fsencode(source), os.fsencode(dest)
    if sys.platform.startswith('linux'):
        operation = libc.renameat2
        operation.argtypes = (ctypes.c_int, ctypes.c_char_p, ctypes.c_int,
                              ctypes.c_char_p, ctypes.c_uint)
        result = operation(-100, src, -100, dst, 1)  # RENAME_NOREPLACE
    elif sys.platform == 'darwin':
        operation = libc.renamex_np
        operation.argtypes = (ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint)
        result = operation(src, dst, 4)  # RENAME_EXCL
    else:
        raise GateError('atomic no-replace rename unavailable')
    if result != 0:
        err = ctypes.get_errno()
        raise OSError(err, os.strerror(err))  # never include private paths


def _fsync_dir(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _marker(stage, owner):
    p = stage / MARKER
    info = p.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and
            info.st_uid == owner and stat.S_IMODE(info.st_mode) == 0o600 and
            _marker_bytes(p) == MARKER_BYTES, 'transaction marker gate')


def _marker_bytes(path):
    # A fixed marker, not an operator JSON field. Recheck by fd and exact size.
    info = path.lstat()
    require(info.st_size == len(MARKER_BYTES), 'marker size')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        opened = os.fstat(fd)
        require((opened.st_dev, opened.st_ino, opened.st_size, opened.st_nlink) ==
                (info.st_dev, info.st_ino, info.st_size, 1), 'marker changed')
        value = os.read(fd, len(MARKER_BYTES) + 1)
        require(os.fstat(fd).st_size == info.st_size and
                path.lstat().st_ino == info.st_ino, 'marker changed')
        return value
    finally:
        os.close(fd)


def _paths(active, stage, sealed_v1, anchor, owner, *, gap=False):
    anchor = _path(anchor, anchor)
    if anchor == Path('/'):
        require(owner == 0 and os.geteuid() == 0 and
                active == Path('/opt/cline-pass-switcher/data') and
                stage.is_relative_to(Path('/root')) and
                sealed_v1.is_relative_to(Path('/root')), 'operational root/path gate')
    else:
        # Non-root path substitution exists only for disposable local tests.
        require(anchor.name.startswith('cps-rollback-synthetic-') and
                owner == os.geteuid(), 'synthetic anchor gate')
    _path(active, anchor)
    _path(stage, anchor)
    _path(sealed_v1, anchor)
    require(active.name == 'data' and STAGE_NAME.fullmatch(stage.name) and
            sealed_v1.name == 'data' and
            len({active, stage, sealed_v1}) == 3 and
            all(not a.is_relative_to(b) and not b.is_relative_to(a)
                for a, b in ((active, stage), (active, sealed_v1), (stage, sealed_v1))),
            'rollback path layout')
    preserved = stage / 'preserved-v2-live'
    # active parent need not be 0700, but must be root-owned and not writable by
    # service UID/group/other. Private backup/stage parents must be 0700.
    private_path(active.parent, anchor=anchor, owner=owner)
    private_path(stage, anchor=anchor, owner=owner, final_mode=0o700)
    private_path(sealed_v1.parent, anchor=anchor, owner=owner, final_mode=0o700)
    _marker(stage, owner)
    current = preserved if gap else active
    if gap:
        _missing(active)
    for path in (current, stage / 'sealed-v2', stage / 'prepared-v1', sealed_v1):
        _dir(path, mode=0o700)
    require(len({(p.lstat().st_dev, p.lstat().st_ino) for p in
                 (current, stage / 'sealed-v2', stage / 'prepared-v1', sealed_v1)}) == 4,
            'data trees are not independent')
    device = active.parent.lstat().st_dev
    require(all(p.lstat().st_dev == device for p in
                (current, stage, stage / 'sealed-v2', stage / 'prepared-v1', sealed_v1,
                 sealed_v1.parent)), 'cross-device rename refused')
    return preserved


def _raw_off(tree, *, active=False):
    raw = tree / 'detailed-logs' / 'raw'
    if os.path.lexists(raw):
        require(active, 'raw child in rollback material')
        _dir(raw)
        require(not any(raw.iterdir()), 'raw group present')
    config = tree / 'config.json'
    value = read_json(config, limit=4 * 1024 * 1024)
    require(isinstance(value, dict) and value.get('rawBodyLogging', False) is False,
            'raw must remain off')
    return sha(config)


def _tree(tree, *, active=False):
    _raw_off(tree, active=active)
    digest, _, _ = inventory(tree, source=active)
    return digest.hex()


def _stopped(probe, candidate_id, image):
    # The caller supplies a fresh, independent exact-container inspection. It
    # must ALSO maintain the all-writers fence; a STOP check is not that fence.
    result = probe()
    require(type(result) is dict and result ==
            {'id': candidate_id, 'image': image, 'state': 'exited'},
            'exact candidate not stopped')


def _journal(stage, record, *, initial=False):
    dest = stage / 'phase.json'
    temp = stage / 'phase.json.new'
    _missing(temp)  # interrupted write needs investigation, not silent replay
    if initial:
        _missing(dest)
    else:
        info = dest.lstat()
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and
                stat.S_IMODE(info.st_mode) == 0o600 and info.st_uid == os.geteuid(),
                'journal changed')
    payload = (json.dumps(record, sort_keys=True, separators=(',', ':')) + '\n').encode()
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        require(os.write(fd, payload) == len(payload), 'short journal write')
        os.fsync(fd)
    finally:
        os.close(fd)
    os.replace(temp, dest)
    _fsync_dir(stage)


def _read_journal(stage):
    info = (stage / 'phase.json').lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and
            info.st_uid == os.geteuid() and stat.S_IMODE(info.st_mode) == 0o600,
            'invalid journal')
    record = read_json(stage / 'phase.json', limit=4096)
    require(type(record) is dict and set(record) ==
            {'version', 'phase', 'candidateId', 'image', 'v1', 'v2', 'v2Config'} and
            type(record['version']) is int and record['version'] == 1 and
            record['phase'] in ('move-v2-intent', 'v2-preserved',
                                'install-v1-intent', 'v1-active') and
            type(record['candidateId']) is str and HEX.fullmatch(record['candidateId']) and
            type(record['image']) is str and IMAGE.fullmatch(record['image']) and
            all(type(record[key]) is str and HEX.fullmatch(record[key])
                for key in ('v1', 'v2', 'v2Config')), 'invalid journal fields')
    return record


def _lock(stage):
    lock = stage / '.lock'
    fd = os.open(lock, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    info = os.fstat(fd)
    try:
        require(stat.S_ISREG(info.st_mode) and info.st_uid == os.geteuid() and
                info.st_nlink == 1 and stat.S_IMODE(info.st_mode) == 0o600 and
                lock.lstat().st_ino == info.st_ino, 'lock gate')
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BaseException:
        os.close(fd)
        raise
    return fd


def _seal_checks(sealed_v1, stage, v1, v2, v2_config):
    seal_path = stage / 'seal.json'
    info = seal_path.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and
            info.st_uid == os.geteuid() and stat.S_IMODE(info.st_mode) == 0o600,
            'external seal gate')
    seal = read_json(seal_path, limit=4096)
    require(type(seal) is dict and set(seal) ==
            {'version', 'v1', 'v1Config', 'v2', 'v2Config'} and
            type(seal['version']) is int and seal['version'] == 1 and
            all(type(seal[key]) is str and HEX.fullmatch(seal[key]) for key in
                ('v1', 'v1Config', 'v2', 'v2Config')) and
            (seal['v1'], seal['v2'], seal['v2Config']) == (v1, v2, v2_config) and
            _tree(sealed_v1) == v1 and _raw_off(sealed_v1) == seal['v1Config'] and
            _tree(stage / 'prepared-v1') == v1 and
            _raw_off(stage / 'prepared-v1') == seal['v1Config'] and
            _tree(stage / 'sealed-v2') == v2 and
            _raw_off(stage / 'sealed-v2') == v2_config, 'sealed tree parity')


def _install(stage, active, preserved, record):
    # Only the exact gap state permits this transition; do not overwrite an
    # unexpected new live path. A stale intent with both paths present refuses.
    _missing(active)
    require(_tree(preserved, active=True) == record['v2'] and
            _raw_off(preserved, active=True) == record['v2Config'],
            'preserved v2 changed')
    prepared = stage / 'prepared-v1'
    require(_tree(prepared) == record['v1'], 'prepared v1 changed')
    record['phase'] = 'install-v1-intent'
    _journal(stage, record)
    _missing(active)
    _rename_exclusive(prepared, active)
    _fsync_dir(stage)
    _fsync_dir(active.parent)
    require(_tree(active) == record['v1'] and
            _tree(preserved, active=True) == record['v2'], 'post-rename parity')
    record['phase'] = 'v1-active'
    _journal(stage, record)


def replace(active, stage, sealed_v1, *, expected_v1, expected_v2,
            expected_v2_config, candidate_id, image, stopped_probe,
            anchor=Path('/'), owner=0, after_preserve=None):
    """Explicitly authorized, fenced transaction. Caller must stop candidate first.

    `after_preserve` is an optional synthetic fault injector, never a hook for
    traffic or deployment. Exceptions leave both versions and journal untouched.
    """
    require(all(type(x) is str and HEX.fullmatch(x)
                for x in (expected_v1, expected_v2, expected_v2_config, candidate_id)) and
            type(image) is str and IMAGE.fullmatch(image) and callable(stopped_probe),
            'invalid seal/STOP evidence')
    preserved = _paths(active, stage, sealed_v1, anchor, owner)
    _missing(preserved)
    fd = _lock(stage)
    try:
        _missing(stage / 'phase.json')
        _missing(stage / 'phase.json.new')
        _stopped(stopped_probe, candidate_id, image)
        _seal_checks(sealed_v1, stage, expected_v1, expected_v2, expected_v2_config)
        require(_tree(active, active=True) == expected_v2 and
                _raw_off(active, active=True) == expected_v2_config, 'current v2 drift')
        _stopped(stopped_probe, candidate_id, image)
        record = {'version': 1, 'phase': 'move-v2-intent',
                  'candidateId': candidate_id, 'image': image,
                  'v1': expected_v1, 'v2': expected_v2, 'v2Config': expected_v2_config}
        _journal(stage, record, initial=True)  # durable BEFORE first rename
        _missing(preserved)
        _rename_exclusive(active, preserved)
        _fsync_dir(active.parent)
        _fsync_dir(stage)
        record['phase'] = 'v2-preserved'
        _journal(stage, record)
        if after_preserve is not None:
            after_preserve()  # synthetic test fault only
        _stopped(stopped_probe, candidate_id, image)
        _seal_checks(sealed_v1, stage, expected_v1, expected_v2, expected_v2_config)
        _install(stage, active, preserved, record)
    finally:
        os.close(fd)


def recover_gap(active, stage, sealed_v1, *, stopped_probe,
                anchor=Path('/'), owner=0):
    """Resume ONLY a proved empty active slot after first rename; never boot old."""
    require(callable(stopped_probe), 'STOP probe required')
    preserved = _paths(active, stage, sealed_v1, anchor, owner, gap=True)
    fd = _lock(stage)
    try:
        _missing(stage / 'phase.json.new')
        record = _read_journal(stage)
        require(record['phase'] in ('move-v2-intent', 'v2-preserved',
                                    'install-v1-intent'), 'not an empty-gap phase')
        _stopped(stopped_probe, record['candidateId'], record['image'])
        _missing(active)
        _seal_checks(sealed_v1, stage, record['v1'], record['v2'], record['v2Config'])
        require(_tree(preserved, active=True) == record['v2'] and
                _raw_off(preserved, active=True) == record['v2Config'],
                'preserved v2 changed')
        _install(stage, active, preserved, record)
    finally:
        os.close(fd)
