#!/usr/bin/env python3
"""Root-private, systemd-supervised exact-ID pause recovery. Never starts containers.

Install this file as /root/cps-backup-window-watchdog.py (root:root, 0600) only
through a separately reviewed procedure. The state file is created exclusively
by backup_pause_window.py before systemd starts this service. Do not invoke the
retired stop/start path. No shell, credentials, names or mutable service aliases.
"""
import argparse
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import time


class GateError(Exception):
    pass


def require(ok, reason):
    if not ok:
        raise GateError(reason)


HEX = re.compile(r'[0-9a-f]{64}\Z')

ROOT = Path('/root')
SCRIPT = ROOT / 'cps-backup-window-watchdog.py'
BOOT = Path('/proc/sys/kernel/random/boot_id')
INTERVAL = 0.25  # Continue checking after deadline: a Docker pause may arrive late.
WINDOW_NS = 600_000_000_000


def state_path(container_id, root=ROOT):
    require(isinstance(container_id, str) and HEX.fullmatch(container_id), 'invalid container ID')
    return root / ('cps-backup-window-' + container_id + '.json')


def boot_id():
    value = BOOT.read_text().strip()
    require(re.fullmatch(r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}', value),
            'boot identity unavailable')
    return value


def read_state(path, ident, *, root=ROOT, owner=0):
    require(root.is_absolute() and not root.is_symlink(), 'watchdog root path')
    info = root.lstat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == owner and
            stat.S_IMODE(info.st_mode) == 0o700, 'watchdog root ownership')
    require(path == state_path(ident, root), 'watchdog state path mismatch')
    info = path.lstat()
    require(info.st_uid == owner and stat.S_IMODE(info.st_mode) == 0o600,
            'watchdog state ownership')
    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_size <= 1024,
            'watchdog state file shape')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(fd)
        value = json.loads(os.read(fd, 1025))
        after = os.fstat(fd)
        current = path.lstat()
        require(all((x.st_dev, x.st_ino, x.st_size, x.st_mtime_ns, x.st_ctime_ns,
                     x.st_uid, x.st_mode, x.st_nlink) ==
                    (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns,
                     info.st_uid, info.st_mode, info.st_nlink)
                    for x in (before, after, current)), 'watchdog state changed')
    finally:
        os.close(fd)
    require(isinstance(value, dict) and set(value) == {'containerId', 'bootId', 'deadlineNs'} and
            value['containerId'] == ident and value['bootId'] == boot_id() and
            type(value['deadlineNs']) is int and 0 < value['deadlineNs'] <= 2**63 - 1,
            'watchdog state mismatch')
    return value['deadlineNs']


def docker_state(ident, run):
    # Inspect by immutable full ID, never by name; response is independently checked.
    result = run(['/usr/bin/docker', 'inspect', '--format',
                  '{{json .Id}} {{json .State.Status}}', ident],
                 stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=5, check=False)
    require(result.returncode == 0 and len(result.stdout) <= 256,
            'docker inspect unavailable')
    decoder = json.JSONDecoder()
    text = result.stdout.decode('ascii').strip()
    found, offset = decoder.raw_decode(text)
    status, end = decoder.raw_decode(text[offset:].strip())
    require(not text[offset:].strip()[end:].strip() and found == ident and
            status in ('running', 'paused'), 'docker identity/state mismatch')
    return status


def tick(ident, deadline, *, clock=time.monotonic_ns, run=subprocess.run):
    if clock() < deadline:
        return
    if docker_state(ident, run) == 'paused':
        result = run(['/usr/bin/docker', 'unpause', ident], stdout=subprocess.DEVNULL,
                     stderr=subprocess.DEVNULL, timeout=5, check=False)
        require(result.returncode == 0, 'exact-ID unpause failed')
    # Never exit after unpause. Even when currently running, a late pause can arrive.


def supervise(ident, *, root=ROOT, owner=0, clock=time.monotonic_ns,
              run=subprocess.run, sleep=time.sleep):
    path = state_path(ident, root)
    while True:
        try:
            deadline = read_state(path, ident, root=root, owner=owner)
            tick(ident, deadline, clock=clock, run=run)
        except (GateError, OSError, ValueError, UnicodeError, subprocess.TimeoutExpired):
            # Fail closed on uncertain state; systemd keeps this process alive and
            # retries rather than mistaking one failed Docker command for recovery.
            pass
        sleep(INTERVAL)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--container-id', required=True)
    args = parser.parse_args(argv)
    try:
        require(os.geteuid() == 0, 'root required')
        supervise(args.container_id)
    except (GateError, OSError, ValueError):
        print('watchdog identity/state unavailable', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
