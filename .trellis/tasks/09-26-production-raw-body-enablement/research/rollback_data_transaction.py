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
"v2":<tree hex>,"v2Config":<config hex>}. The journal also binds the
project, preserved v2 and prepared v1 device/inode identities. A journal from
the older prototype without those fields is refused, not silently upgraded.
The seal is not a substitute for the
external stopped-writer fence or sidecar backup/restore approval. Paths are
absolute; the active basename must be `data` and the root-private stage's
`preserved-v2-live/` must not exist. Journal and both rename parents are fsynced
at every boundary. A crash between the two renames leaves NO active DATA_DIR:
recover_gap() can only install verified v1 if preserved v2 is intact and active
is absent. A
crash after the second rename needs recover_active() to prove both trees and
finish the journal before the old image may start. A directory fd pins the
parent inode, NOT its children: an independently enforced STOP of every
writer (including other UID-1000 processes) is mandatory. No path/hash check
alone can make a hostile concurrent same-UID writer safe. Never retry replace()
or start an image in an ambiguous state.

`test_service_uid` is synthetic-only: with a fixed sentinel it accepts a 0750
service parent and 0700 service-owned data. A different UID is allowed only
for a root-owned 0700 /opt/cps-rollback-synthetic-<16 hex> anchor with separate
root-private stage/sealed-v1 below it on the same device. Operational `/`
refuses this parameter and always requires /opt/cline-pass-switcher (UID 1000).
No host fixture, process STOP, backup or image switch is created here.
"""
import ctypes
from contextlib import contextmanager
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
SYNTHETIC_NAME = re.compile(r'cps-rollback-synthetic-[0-9a-f]{16}\Z')
SYNTHETIC_MARKER = '.cps-rollback-synthetic-anchor'
SYNTHETIC_BYTES = b'cps-rollback-synthetic-anchor-v1\n'
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


def _rename_exclusive(source_fd, source_name, dest_fd, dest_name):
    """Linux renameat2, pinned parents, NOREPLACE. No path fallback."""
    require(sys.platform.startswith('linux'), 'renameat2 unavailable')
    libc = ctypes.CDLL(None, use_errno=True)
    try:
        operation = libc.renameat2
    except AttributeError:
        raise GateError('renameat2 unavailable') from None
    operation.argtypes = (ctypes.c_int, ctypes.c_char_p, ctypes.c_int,
                          ctypes.c_char_p, ctypes.c_uint)
    operation.restype = ctypes.c_int
    if operation(source_fd, os.fsencode(source_name), dest_fd,
                 os.fsencode(dest_name), 1) != 0:  # RENAME_NOREPLACE
        err = ctypes.get_errno()
        raise OSError(err, os.strerror(err))  # never include private paths


def _entry(fd, name):
    try:
        return os.stat(name, dir_fd=fd, follow_symlinks=False)
    except FileNotFoundError:
        return None


def _same(info, other):
    return info is not None and other is not None and all(
        getattr(info, key) == getattr(other, key)
        for key in ('st_dev', 'st_ino', 'st_mode', 'st_uid', 'st_gid'))


def _service_layout(anchor, owner, test_service_uid):
    if anchor == Path('/'):
        # A caller must not parameterize the real project/UID contract.
        require(test_service_uid is None, 'operational UID override refused')
        return 1000, 0o750
    if test_service_uid is None:
        return owner, 0o700  # existing same-UID local fixtures
    require(type(test_service_uid) is int and 0 <= test_service_uid and
            SYNTHETIC_NAME.fullmatch(anchor.name) and owner == os.geteuid(),
            'synthetic UID gate')
    _dir(anchor, owner=owner, mode=0o700)
    marker = anchor / SYNTHETIC_MARKER
    require(os.path.lexists(marker), 'synthetic anchor sentinel missing')
    info = marker.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and
            info.st_uid == owner and stat.S_IMODE(info.st_mode) == 0o600 and
            _fixed_bytes(marker, SYNTHETIC_BYTES) == SYNTHETIC_BYTES,
            'synthetic anchor sentinel gate')
    if test_service_uid != owner:
        require(test_service_uid == 1000 and owner == 0 and
                anchor.parent == Path('/opt'),
                'cross-UID synthetic anchor gate')
        private_path(anchor, anchor=Path('/opt'), owner=0, final_mode=0o700)
    return test_service_uid, 0o750


@contextmanager
def _parents(active, stage, anchor, owner, test_service_uid=None, *, gap=False):
    """Pin /opt and project (UID 1000), and the root-private stage parent.

    Checks are repeated before/after each mutation. This protects against
    accidental parent substitution, not an unfenced same-UID child writer.
    """
    opt = (Path('/opt') if anchor == Path('/') else anchor)
    project = active.parent
    opt_fd = os.open(opt, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    project_fd = stage_fd = -1
    try:
        opt_stat = os.fstat(opt_fd)
        require(stat.S_ISDIR(opt_stat.st_mode) and opt_stat.st_uid == owner and
                not stat.S_IMODE(opt_stat.st_mode) & 0o022 and
                _same(opt_stat, opt.lstat()), 'trusted ancestor changed')
        expected_project = 'cline-pass-switcher' if anchor == Path('/') else 'service'
        require(project.parent == opt and project.name == expected_project,
                'active parent layout')
        project_fd = os.open(project.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                             dir_fd=opt_fd)
        project_stat = os.fstat(project_fd)
        service_uid, project_mode = _service_layout(anchor, owner, test_service_uid)
        require(stat.S_ISDIR(project_stat.st_mode) and
                project_stat.st_uid == service_uid and
                stat.S_IMODE(project_stat.st_mode) == project_mode and
                _same(project_stat, _entry(opt_fd, project.name)), 'project parent gate')
        # Stage ancestry is root-private; its parent is not a UID-1000 child.
        private_path(stage.parent, anchor=anchor, owner=owner, final_mode=0o700)
        stage_fd = os.open(stage, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        stage_stat = os.fstat(stage_fd)
        require(stage_stat.st_uid == owner and stat.S_IMODE(stage_stat.st_mode) == 0o700 and
                _same(stage_stat, stage.lstat()) and
                project_stat.st_dev == stage_stat.st_dev, 'stage parent gate')
        active_stat = _entry(project_fd, 'data')
        if gap:
            require(active_stat is None, 'active path is not empty')
        else:
            require(active_stat is not None and stat.S_ISDIR(active_stat.st_mode) and
                    active_stat.st_uid == service_uid and
                    stat.S_IMODE(active_stat.st_mode) == 0o700,
                    'active data gate')
        yield opt_fd, project_fd, stage_fd, project_stat, stage_stat, active_stat, opt_stat
    finally:
        if stage_fd >= 0:
            os.close(stage_fd)
        if project_fd >= 0:
            os.close(project_fd)
        os.close(opt_fd)


def _boundary(active, stage, fds, *, active_info=None, preserved_info=None,
              prepared_info=None):
    opt_fd, project_fd, stage_fd, project_stat, stage_stat, _, opt_stat = fds
    require(_same(opt_stat, os.fstat(opt_fd)) and
            _same(opt_stat, active.parent.parent.lstat()) and
            _same(project_stat, os.fstat(project_fd)) and
            _same(project_stat, _entry(opt_fd, active.parent.name)) and
            _same(stage_stat, os.fstat(stage_fd)) and
            _same(stage_stat, stage.lstat()), 'parent swapped')
    actual = _entry(project_fd, 'data')
    require((actual is None if active_info is None else
             _same(actual, active_info) and stat.S_ISDIR(actual.st_mode)),
            'active entry changed')
    if preserved_info is not None:
        require(_same(_entry(stage_fd, 'preserved-v2-live'), preserved_info),
                'preserved entry changed')
    if prepared_info is not None:
        require(_same(_entry(stage_fd, 'prepared-v1'), prepared_info),
                'prepared entry changed')


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
    return _fixed_bytes(path, MARKER_BYTES)


def _fixed_bytes(path, expected):
    # Fixed marker, not operator JSON. Recheck by fd and exact size.
    info = path.lstat()
    require(info.st_size == len(expected), 'marker size')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        opened = os.fstat(fd)
        require((opened.st_dev, opened.st_ino, opened.st_size, opened.st_nlink) ==
                (info.st_dev, info.st_ino, info.st_size, 1), 'marker changed')
        value = os.read(fd, len(expected) + 1)
        require(os.fstat(fd).st_size == info.st_size and
                path.lstat().st_ino == info.st_ino, 'marker changed')
        return value
    finally:
        os.close(fd)


def _paths(active, stage, sealed_v1, anchor, owner, test_service_uid=None, *, gap=False, completed=False):
    anchor = _path(anchor, anchor)
    service_uid, project_mode = _service_layout(anchor, owner, test_service_uid)
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
    # The live project is UID-1000-owned; never treat it as a private stage.
    # _parents() pins and verifies its exact inode beneath the trusted /opt.
    # Refuse parent links even before the initial read-only tree inventory.
    ancestor = Path('/opt') if anchor == Path('/') else anchor
    parent_info = active.parent.lstat()
    require(active.parent.parent == ancestor and stat.S_ISDIR(parent_info.st_mode) and
            parent_info.st_uid == service_uid and
            stat.S_IMODE(parent_info.st_mode) == project_mode,
            'active parent layout/owner')
    private_path(stage, anchor=anchor, owner=owner, final_mode=0o700)
    private_path(sealed_v1.parent, anchor=anchor, owner=owner, final_mode=0o700)
    _marker(stage, owner)
    current = preserved if gap else active
    if gap:
        _missing(active)
    trees = (current, stage / 'sealed-v2', sealed_v1) + (() if completed else
             (stage / 'prepared-v1',))
    if completed:
        trees += (preserved,)
    for path in trees:
        _dir(path, owner=service_uid, mode=0o700)
    require(len({(p.lstat().st_dev, p.lstat().st_ino) for p in trees}) == len(trees),
            'data trees are not independent')
    device = active.parent.lstat().st_dev
    require(all(p.lstat().st_dev == device for p in
                (*trees, stage, sealed_v1.parent)), 'cross-device rename refused')
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
            {'version', 'phase', 'candidateId', 'image', 'v1', 'v2', 'v2Config',
             'v2Device', 'v2Inode', 'v1Device', 'v1Inode',
             'projectDevice', 'projectInode'} and
            type(record['version']) is int and record['version'] == 1 and
            record['phase'] in ('move-v2-intent', 'v2-preserved',
                                'install-v1-intent', 'v1-active') and
            type(record['candidateId']) is str and HEX.fullmatch(record['candidateId']) and
            type(record['image']) is str and IMAGE.fullmatch(record['image']) and
            all(type(record[key]) is str and HEX.fullmatch(record[key])
                for key in ('v1', 'v2', 'v2Config')) and
            all(type(record[key]) is int and record[key] > 0
                for key in ('v2Device', 'v2Inode', 'v1Device', 'v1Inode',
                            'projectDevice', 'projectInode')),
            'invalid journal fields')
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


def _seal_checks(sealed_v1, stage, v1, v2, v2_config, *, completed=False):
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
            (completed or (_tree(stage / 'prepared-v1') == v1 and
                           _raw_off(stage / 'prepared-v1') == seal['v1Config'])) and
            _tree(stage / 'sealed-v2') == v2 and
            _raw_off(stage / 'sealed-v2') == v2_config, 'sealed tree parity')


def _project_identity(fds, record):
    require((fds[3].st_dev, fds[3].st_ino) ==
            (record['projectDevice'], record['projectInode']),
            'project inode differs from journal')


def _preserved_identity(info, record):
    require(info is not None and (info.st_dev, info.st_ino) ==
            (record['v2Device'], record['v2Inode']), 'preserved inode differs from journal')


def _install(stage, active, preserved, record, fds, stopped_probe):
    # Only the exact gap state permits this transition. A same-UID child
    # writer is an external fence violation; detect drift, never overwrite.
    _, project_fd, stage_fd, _, _, _, _ = fds
    _project_identity(fds, record)
    preserved_info = _entry(stage_fd, preserved.name)
    prepared_info = _entry(stage_fd, 'prepared-v1')
    require(prepared_info is not None and preserved_info is not None,
            'missing transaction tree')
    _preserved_identity(preserved_info, record)
    require((prepared_info.st_dev, prepared_info.st_ino) ==
            (record['v1Device'], record['v1Inode']), 'prepared inode differs from journal')
    _boundary(active, stage, fds, preserved_info=preserved_info,
              prepared_info=prepared_info)
    require(_tree(preserved, active=True) == record['v2'] and
            _raw_off(preserved, active=True) == record['v2Config'] and
            _tree(stage / 'prepared-v1') == record['v1'], 'transaction tree drift')
    _boundary(active, stage, fds, preserved_info=preserved_info,
              prepared_info=prepared_info)
    record['phase'] = 'install-v1-intent'
    _journal(stage, record)
    _stopped(stopped_probe, record['candidateId'], record['image'])
    _boundary(active, stage, fds, preserved_info=preserved_info,
              prepared_info=prepared_info)
    _rename_exclusive(stage_fd, 'prepared-v1', project_fd, 'data')
    os.fsync(stage_fd)
    os.fsync(project_fd)
    _boundary(active, stage, fds, active_info=prepared_info,
              preserved_info=preserved_info)
    require(_tree(active) == record['v1'] and
            _tree(preserved, active=True) == record['v2'], 'post-rename parity')
    _boundary(active, stage, fds, active_info=prepared_info,
              preserved_info=preserved_info)
    _stopped(stopped_probe, record['candidateId'], record['image'])
    record['phase'] = 'v1-active'
    _journal(stage, record)


def replace(active, stage, sealed_v1, *, expected_v1, expected_v2,
            expected_v2_config, candidate_id, image, stopped_probe,
            anchor=Path('/'), owner=0, after_preserve=None, test_service_uid=None):
    """Explicitly authorized, fenced transaction. Caller must stop candidate first.

    `after_preserve` is an optional synthetic fault injector, never a hook for
    traffic or deployment. `test_service_uid` cannot override the operational
    anchor. Exceptions leave both versions and journal untouched.
    """
    require(all(type(x) is str and HEX.fullmatch(x)
                for x in (expected_v1, expected_v2, expected_v2_config, candidate_id)) and
            type(image) is str and IMAGE.fullmatch(image) and callable(stopped_probe),
            'invalid seal/STOP evidence')
    require(anchor != Path('/') or after_preserve is None,
            'synthetic fault hook refused on operational anchor')
    preserved = _paths(active, stage, sealed_v1, anchor, owner, test_service_uid)
    _missing(preserved)
    fd = _lock(stage)
    try:
        with _parents(active, stage, anchor, owner, test_service_uid) as fds:
            _, project_fd, stage_fd, _, _, active_info, _ = fds
            _missing(stage / 'phase.json')
            _missing(stage / 'phase.json.new')
            _stopped(stopped_probe, candidate_id, image)
            _seal_checks(sealed_v1, stage, expected_v1, expected_v2, expected_v2_config)
            _boundary(active, stage, fds, active_info=active_info)
            require(_tree(active, active=True) == expected_v2 and
                    _raw_off(active, active=True) == expected_v2_config,
                    'current v2 drift')
            _boundary(active, stage, fds, active_info=active_info)
            _stopped(stopped_probe, candidate_id, image)
            prepared_info = _entry(stage_fd, 'prepared-v1')
            require(prepared_info is not None, 'prepared tree missing')
            record = {'version': 1, 'phase': 'move-v2-intent',
                      'candidateId': candidate_id, 'image': image,
                      'v1': expected_v1, 'v2': expected_v2, 'v2Config': expected_v2_config,
                      'v2Device': active_info.st_dev, 'v2Inode': active_info.st_ino,
                      'v1Device': prepared_info.st_dev, 'v1Inode': prepared_info.st_ino,
                      'projectDevice': fds[3].st_dev, 'projectInode': fds[3].st_ino}
            _journal(stage, record, initial=True)  # durable BEFORE first rename
            _stopped(stopped_probe, candidate_id, image)
            _boundary(active, stage, fds, active_info=active_info,
                      prepared_info=prepared_info)
            require(_entry(stage_fd, preserved.name) is None, 'preserved slot occupied')
            _rename_exclusive(project_fd, 'data', stage_fd, preserved.name)
            os.fsync(project_fd)
            os.fsync(stage_fd)
            _boundary(active, stage, fds, preserved_info=active_info)
            require(_tree(preserved, active=True) == expected_v2, 'preserved v2 drift')
            _boundary(active, stage, fds, preserved_info=active_info)
            record['phase'] = 'v2-preserved'
            _journal(stage, record)
            if after_preserve is not None:
                after_preserve()  # synthetic test fault only
            _stopped(stopped_probe, candidate_id, image)
            _seal_checks(sealed_v1, stage, expected_v1, expected_v2, expected_v2_config)
            _install(stage, active, preserved, record, fds, stopped_probe)
    finally:
        os.close(fd)


def recover_gap(active, stage, sealed_v1, *, stopped_probe,
                anchor=Path('/'), owner=0, test_service_uid=None):
    """Resume ONLY a proved empty active slot after first rename; never boot old."""
    require(callable(stopped_probe), 'STOP probe required')
    preserved = _paths(active, stage, sealed_v1, anchor, owner, test_service_uid, gap=True)
    fd = _lock(stage)
    try:
        with _parents(active, stage, anchor, owner, test_service_uid, gap=True) as fds:
            _missing(stage / 'phase.json.new')
            record = _read_journal(stage)
            require(record['phase'] in ('move-v2-intent', 'v2-preserved',
                                        'install-v1-intent'), 'not an empty-gap phase')
            _stopped(stopped_probe, record['candidateId'], record['image'])
            _project_identity(fds, record)
            _boundary(active, stage, fds)
            _seal_checks(sealed_v1, stage, record['v1'], record['v2'], record['v2Config'])
            preserved_info = _entry(fds[2], preserved.name)
            _preserved_identity(preserved_info, record)
            _boundary(active, stage, fds, preserved_info=preserved_info)
            require(_tree(preserved, active=True) == record['v2'] and
                    _raw_off(preserved, active=True) == record['v2Config'],
                    'preserved v2 changed')
            _boundary(active, stage, fds, preserved_info=preserved_info)
            _install(stage, active, preserved, record, fds, stopped_probe)
    finally:
        os.close(fd)


def recover_active(active, stage, sealed_v1, *, stopped_probe,
                   anchor=Path('/'), owner=0, test_service_uid=None):
    """Prove the post-second-rename state and durably finish its journal.

    No container is started here. Unknown content, a prepared-v1 still in
    stage, a new active inode, or a residual journal temp all require manual
    fenced investigation. This is not a general rollback/replay command.
    """
    require(callable(stopped_probe), 'STOP probe required')
    preserved = _paths(active, stage, sealed_v1, anchor, owner, test_service_uid, completed=True)
    fd = _lock(stage)
    try:
        with _parents(active, stage, anchor, owner, test_service_uid) as fds:
            _missing(stage / 'phase.json.new')
            _missing(stage / 'prepared-v1')
            record = _read_journal(stage)
            require(record['phase'] in ('install-v1-intent', 'v1-active'),
                    'not a post-install phase')
            _stopped(stopped_probe, record['candidateId'], record['image'])
            _project_identity(fds, record)
            active_info = fds[5]
            require((active_info.st_dev, active_info.st_ino) ==
                    (record['v1Device'], record['v1Inode']),
                    'active inode differs from prepared journal')
            preserved_info = _entry(fds[2], preserved.name)
            _preserved_identity(preserved_info, record)
            _boundary(active, stage, fds, active_info=active_info,
                      preserved_info=preserved_info)
            _seal_checks(sealed_v1, stage, record['v1'], record['v2'],
                         record['v2Config'], completed=True)
            require(_tree(active) == record['v1'] and
                    _tree(preserved, active=True) == record['v2'] and
                    _raw_off(preserved, active=True) == record['v2Config'],
                    'post-install trees changed')
            _boundary(active, stage, fds, active_info=active_info,
                      preserved_info=preserved_info)
            _stopped(stopped_probe, record['candidateId'], record['image'])
            if record['phase'] == 'install-v1-intent':
                os.fsync(fds[1])
                os.fsync(fds[2])
                record['phase'] = 'v1-active'
                _journal(stage, record)
            _boundary(active, stage, fds, active_info=active_info,
                      preserved_info=preserved_info)
    finally:
        os.close(fd)
