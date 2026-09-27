#!/usr/bin/env python3
"""Offline synthetic-only CLI self-test; no network, production or credentials."""
import importlib.util
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile

HELPER = Path(__file__).with_name('isolated-full-rollback.py')
spec = importlib.util.spec_from_file_location('isolated_full_rollback', HELPER)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def invoke(*args, ok=True):
    run = subprocess.run([sys.executable, str(HELPER), *map(str, args)],
                         capture_output=True, text=True, check=False)
    assert (run.returncode == 0) == ok, (args[0], run.returncode, run.stderr)
    return run.stdout.strip()


def put(path, content, mode=0o600):
    path.write_bytes(content)
    path.chmod(mode)


def tree(path):
    path.mkdir(mode=0o700)
    put(path / module.MARKER, module.MARKER_BYTES)


def parity(source, dest, root, *, data=False):
    source_digest, _ = module.inventory(root, source, exclude_raw=data)
    dest_digest, raw = module.inventory(root, dest)
    assert source_digest == dest_digest and not raw
    assert (stat.S_IMODE(source.stat().st_mode), source.stat().st_uid, source.stat().st_gid) == (
        stat.S_IMODE(dest.stat().st_mode), dest.stat().st_uid, dest.stat().st_gid)


with tempfile.TemporaryDirectory(prefix='cps-synthetic-rollback-') as temp:
    root = Path(temp)
    root.chmod(0o700)
    data, sidecars, workspace, restored = (root / n for n in
                                            ('data', 'sidecars', 'workspace', 'restored'))
    tree(data)
    tree(sidecars)
    for name in module.DATA_FILES:
        put(data / name, ('v1-synthetic-' + name).encode())
    for name in module.SIDECAR_FILES:
        put(sidecars / name, ('v1-synthetic-' + name).encode())
    (data / 'logs').mkdir(mode=0o700)
    put(data / 'logs' / 'ordinary.jsonl', b'fixture-log', mode=0o640)
    (data / 'empty').mkdir(mode=0o700)
    raw = data / 'detailed-logs' / 'raw'
    raw.mkdir(parents=True, mode=0o700)
    raw.parent.chmod(0o700)
    (raw / 'group').mkdir(mode=0o700)
    put(raw / 'group' / 'body.txt', b'SYNTHETIC_RAW_EXCLUSION_MARKER' * 6000)  # >64 KiB
    (raw / 'link').symlink_to(raw / 'group' / 'body.txt')
    base = ('prepare', '--data', data, '--sidecars', sidecars, '--workspace', workspace)
    # Root identity is mandatory, not merely the two child sentinels.
    invoke(*base, ok=False)
    assert not workspace.exists()
    put(root / module.ROOT_MARKER, b'wrong\n')
    invoke(*base, ok=False)
    put(root / module.ROOT_MARKER, module.ROOT_MARKER_BYTES)
    # With unframed file content, (a=metadata-of-b, b=empty) and
    # (a=empty, b=metadata-of-b) produce the same concatenated tree bytes.
    first, second = data / 'a', data / 'b'
    put(first, b'')
    put(second, b'')
    info = second.stat()
    next_metadata = b'b\0' + f'{stat.S_IMODE(info.st_mode):04o}\0{info.st_uid}\0{info.st_gid}\0'.encode() + b'F\0'
    put(first, next_metadata)
    digest_a, _ = module.inventory(root, data, exclude_raw=True)
    put(first, b'')
    put(second, next_metadata)
    digest_b, _ = module.inventory(root, data, exclude_raw=True)
    assert digest_a != digest_b
    first.unlink()
    second.unlink()
    os.link(root / module.ROOT_MARKER, root / 'marker-hardlink')
    invoke(*base, ok=False)
    (root / 'marker-hardlink').unlink()
    put(data / module.MARKER, b'wrong\n')
    invoke(*base, ok=False)
    put(data / module.MARKER, module.MARKER_BYTES)
    # Wrong/nested paths, symlink and hardlink reject before copying.
    invoke('prepare', '--data', data / 'logs', '--sidecars', sidecars,
           '--workspace', workspace, ok=False)
    invoke('prepare', '--data', data, '--sidecars', sidecars,
           '--workspace', data / 'nested-workspace', ok=False)
    invoke('prepare', '--data', data, '--sidecars', sidecars,
           '--workspace', data / '..' / 'workspace', ok=False)
    assert not workspace.exists()
    with tempfile.TemporaryDirectory(prefix='cps-other-root-') as other:
        invoke('prepare', '--data', data, '--sidecars', sidecars,
               '--workspace', Path(other) / 'workspace', ok=False)
    (data / 'linked').symlink_to(data / 'logs', target_is_directory=True)
    invoke(*base, ok=False)
    (data / 'linked').unlink()
    os.link(data / 'logs' / 'ordinary.jsonl', data / 'logs' / 'second.jsonl')
    invoke(*base, ok=False)
    (data / 'logs' / 'second.jsonl').unlink()
    (root / 'linked-data').symlink_to(data, target_is_directory=True)
    invoke('prepare', '--data', root / 'linked-data', '--sidecars', sidecars,
           '--workspace', workspace, ok=False)
    (root / 'linked-data').unlink()
    # raw itself must be a real directory; its descendants need not be small or link-free.
    raw.rename(data / 'detailed-logs' / 'raw-real')
    raw.symlink_to(data / 'detailed-logs' / 'raw-real', target_is_directory=True)
    invoke(*base, ok=False)
    raw.unlink()
    (data / 'detailed-logs' / 'raw-real').rename(raw)
    assert not workspace.exists()

    # A stale interrupted staging area has no prepared/sealed state and is never accepted.
    workspace.mkdir(mode=0o700)
    (workspace / 'pre-v1').mkdir(mode=0o700)
    invoke('snapshot-v2', '--workspace', workspace, ok=False)
    invoke(*base, ok=False)
    (workspace / 'pre-v1').rmdir()
    workspace.rmdir()  # Only the disposable synthetic fixture.

    invoke(*base)
    pre = workspace / 'pre-v1'
    working = workspace / 'candidate-working'
    for parent in (pre, working):
        assert not (parent / 'data' / 'detailed-logs' / 'raw').exists()
        parity(data, parent / 'data', root, data=True)
        parity(sidecars, parent / 'sidecars', root)
    assert (pre / 'data' / 'logs' / 'ordinary.jsonl').stat().st_mode & 0o777 == 0o640
    invoke(*base, ok=False)

    # The service creates an empty raw directory even while raw=false; only entries
    # are forbidden for a code-only post-v2 snapshot.
    candidate_raw = working / 'data' / 'detailed-logs' / 'raw'
    candidate_raw.mkdir(mode=0o700)
    put(candidate_raw / 'synthetic-body.txt', b'raw fixture must block v2 sealing')
    invoke('snapshot-v2', '--workspace', workspace, ok=False)
    assert not (workspace / 'post-v2').exists()
    (candidate_raw / 'synthetic-body.txt').unlink()
    # An interrupted v2 copy with a partial post directory cannot become sealed.
    partial = workspace / 'post-v2'
    partial.mkdir(mode=0o700)
    invoke('snapshot-v2', '--workspace', workspace, ok=False)
    assert b'"phase": "prepared"' in (workspace / 'state.json').read_bytes()
    partial.rmdir()  # Disposable fixture only; rehearsal helper itself never cleans staging.
    put(working / 'data' / 'config.json', b'v2-synthetic-config')
    put(working / 'sidecars' / 'compose.yml', b'v2-synthetic-compose')
    v2 = invoke('snapshot-v2', '--workspace', workspace)
    assert len(v2) == 64 and all(c in '0123456789abcdef' for c in v2)
    post = workspace / 'post-v2'
    for name in ('data', 'sidecars'):
        parity(working / name, post / name, root, data=name == 'data')
    assert not (post / 'data' / 'detailed-logs' / 'raw').exists()
    invoke('snapshot-v2', '--workspace', workspace, ok=False)

    invoke('restore', '--workspace', workspace, '--expected-sha256', '0' * 64,
           '--restored', restored, ok=False)
    assert not restored.exists()
    invoke('restore', '--workspace', workspace, '--expected-sha256', v2,
           '--restored', workspace / 'nested-restored', ok=False)
    assert not (workspace / 'nested-restored').exists()
    # Later operator-like drift (including metadata/mode/owner envelope) is a no-op.
    put(working / 'data' / 'config.json', b'concurrent-synthetic-save')
    invoke('restore', '--workspace', workspace, '--expected-sha256', v2,
           '--restored', restored, ok=False)
    assert not restored.exists() and (working / 'data' / 'config.json').read_bytes() == b'concurrent-synthetic-save'
    put(working / 'data' / 'config.json', b'v2-synthetic-config')
    old_mode = stat.S_IMODE(working.joinpath('data').stat().st_mode)
    (working / 'data').chmod(0o710)
    invoke('restore', '--workspace', workspace, '--expected-sha256', v2,
           '--restored', restored, ok=False)
    assert not restored.exists()
    (working / 'data').chmod(old_mode)
    # Symlink on any nested path component cannot redirect the sealed snapshot.
    candidate_sidecars = working / 'sidecars'
    candidate_sidecars.rename(working / 'sidecars-real')
    candidate_sidecars.symlink_to(working / 'sidecars-real', target_is_directory=True)
    invoke('restore', '--workspace', workspace, '--expected-sha256', v2,
           '--restored', restored, ok=False)
    assert not restored.exists()
    candidate_sidecars.unlink()
    (working / 'sidecars-real').rename(candidate_sidecars)

    invoke('restore', '--workspace', workspace, '--expected-sha256', v2, '--restored', restored)
    parity(pre / 'data', restored / 'data', root)
    parity(pre / 'sidecars', restored / 'sidecars', root)
    assert (restored / 'data' / 'config.json').read_bytes() == b'v1-synthetic-config.json'
    assert not (restored / 'data' / 'detailed-logs' / 'raw').exists()
    assert (post / 'data' / 'config.json').read_bytes() == b'v2-synthetic-config'
    parity(working / 'data', post / 'data', root, data=True)
    invoke('restore', '--workspace', workspace, '--expected-sha256', v2,
           '--restored', restored, ok=False)
    put(pre / 'data' / 'metadata.json', b'altered synthetic backup')
    second = root / 'second-restored'
    invoke('restore', '--workspace', workspace, '--expected-sha256', v2,
           '--restored', second, ok=False)
    assert not second.exists()
    print('synthetic-only rollback smoke passed: raw subtree, root/paths, ownership/modes, fences, retained v2')
