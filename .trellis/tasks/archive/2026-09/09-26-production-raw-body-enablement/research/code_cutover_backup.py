#!/usr/bin/env python3
"""Fail-closed raw-OFF code-switch preflight and stopped-v1 backup ONLY.

No Docker stop/start/up, Compose install, live restore, or production defaults.
The operator must independently maintain a continuous ingress/all-writers fence.
A verified copy is NOT rollback-ready until isolated exact-old-image boot,
sidecar/Compose transaction and candidate-up recovery are separately reviewed.
Never use an old snapshot after the service has resumed writes.
"""
import argparse
import json
import os
from pathlib import Path
import re
import selectors
import stat
import subprocess
import sys
import time

from backup_window_common import (EXCLUDE, GateError, HEX, compose_env_source,
                                  inventory, private_path, read_json, require,
                                  sha, sidecars)
from backup_pause_window import INSPECT, MEMORY, ROOT, SERVICE, fields

OLD = 'sha256:0bd1deaefb04b6c2c3f1e3417eddc07b3fc6dd6398212ff98e6a783c3c62100c'
NEW = 'sha256:bd49772e0a42a2f4f90bc35ce32408485d411caca46efe40c4b13c959105669d'
COMMIT = '4d4ee8798f20a03e842d5cd52f21188bd1f0f88a'
RELEASE = '20260927-raw-off-4d4ee87'
# SHA-256 of the 13 allowlisted regular files in `git archive 4d4ee87`.
SOURCE = {
    '.dockerignore': 'c4ddd3fb14dda3bebb1498481ce82cfb9c14f523c72db3b2908ffdbc535a173c',
    'Dockerfile': '266a64b4b064602625be4b9562c256f49d1a59a81bb78f1c4232cc879bc9b5bc',
    'LICENSE': 'f76f91cf40d96df45ffbd3030a90f5090777c98fe4764700aa9275bb97b4bb71',
    'README.md': 'dabec30775fc34690c7f0943d7bc7e8fd959e6a89383500040a22b15abd409ad',
    'config.example.json': 'a571ee03b7741147c15cf0768f8319aa26f9688f660752449a3bea53545f57be',
    'lib/detailed-log-capture.js': 'b7f4c1bd4b7d8260870e26b8686ab5670f858fc3b9fc4074f50a68f62ad259f7',
    'lib/detailed-log-store.js': '75a73fafc2a2349657a752b0f966375b32027d3ce82732b2e35028d0426cea13',
    'lib/jsonl-log-store.js': 'f1193419a8bb35d024ac927298ff0593fec6e505cf9e9e754b74c6e5a8267917',
    'lib/raw-detail-headers.js': 'fdbaa9c160599915e111ac62f91a369c20f7252c5db1662575a10258cb04c143',
    'package-lock.json': '04e71221812f698fa8a39c159139677cf9cb29abbc139cfd2094bc373101c6ea',
    'package.json': '94c7aba3f6a268c4e4df91e80e6899aa2288938b941c6e2ae5a2290f0dc27368',
    'public/index.html': '6ebcc7cde0f381290c44c4f6b3cb66cc87e638dc724673d68c919f6bb342b39e',
    'server.js': 'e5c28ff8d30ab3660950a2ed8b1b9c7d498be1dcdbf6e3518642f94fd9ef139d',
}
STAGE_NAME = re.compile(r'cps-code-v1-[0-9a-f]{16}\Z')
GATEWAY_ROOT = Path('/etc/nginx')
GATEWAY_LOGICAL = GATEWAY_ROOT / 'conf.d/cps-admin-gateway.conf'
GATEWAY_TARGET_REL = Path('deployments/20260924-052044-c35cd746-admin-auth/gateway.conf')


def run(argv, timeout=20, max_output=8192):
    """Bound private stdout while reading; one deadline covers output and exit."""
    deadline = time.monotonic() + timeout
    process = None
    try:
        process = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        output = bytearray()
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ)
            while True:
                remaining = deadline - time.monotonic()
                require(remaining > 0, 'external command failed')
                require(selector.select(remaining), 'external command failed')
                # Read no more than one byte beyond the cap, even for a large pipe.
                chunk = os.read(process.stdout.fileno(),
                                min(65536, max_output + 1 - len(output)))
                if not chunk:
                    break
                output.extend(chunk)
                require(len(output) <= max_output, 'external command failed')
        remaining = deadline - time.monotonic()
        require(remaining > 0, 'external command failed')
        require(process.wait(timeout=remaining) == 0, 'external command failed')
        return output.decode('utf-8', errors='strict')
    except (OSError, subprocess.TimeoutExpired, UnicodeError):
        raise GateError('external command failed') from None
    finally:
        if process is not None:
            process.stdout.close()
            if process.poll() is None:
                try:
                    process.kill()
                except ProcessLookupError:  # Exited between poll and kill.
                    pass
            process.wait()  # Reap even on overflow/timeout; never drain private output.


class Docker:
    def __init__(self, cfg, command=run):
        self.cfg, self.command = cfg, command

    def inspect(self, stopped=False):
        cfg = self.cfg
        values = fields(self.command(['docker', 'inspect', '--format', INSPECT,
                                      cfg.container_id]), 10)
        ident, name, image, state, health, restarts, oom, memory, mounts, labels = values
        require(ident == cfg.container_id and name == '/' + SERVICE and image == OLD and
                state == ('exited' if stopped else 'running') and
                (health in ('healthy', 'unhealthy', 'starting', None) if stopped else
                 health == 'healthy') and
                type(restarts) is int and restarts == 0 and oom is False and
                type(memory) is int and memory == MEMORY and
                isinstance(mounts, list) and len(mounts) == 1 and
                isinstance(labels, dict) and labels.get('com.docker.compose.service') == SERVICE and
                len(labels) < 64, 'old container identity/state gate')
        mount = mounts[0]
        require(isinstance(mount, dict) and mount.get('Type') == 'bind' and
                mount.get('Source') == str(cfg.root / 'data') and
                mount.get('Destination') == '/data' and mount.get('RW') is True,
                'old data mount gate')
        require(self.command(['docker', 'compose', '-f', str(cfg.root / 'compose.yml'),
                              'ps', '--all', '-q', SERVICE]).strip() == ident,
                'old Compose container drift')
        # Docker's environment projection may include credentials. It is parsed
        # in memory and never returned, logged, or included in an error message.
        environment = json.loads(self.command(['docker', 'inspect', '--format',
                                               '{{json .Config.Env}}', ident]))
        require(isinstance(environment, list) and
                all(isinstance(value, str) for value in environment) and
                not any(value.startswith('CLINE_PASS_RAW_BODY_READY=') for value in environment),
                'raw readiness must remain absent')
        require(self.command(['docker', 'image', 'inspect', '--format', '{{json .Id}}', NEW]).strip() ==
                json.dumps(NEW), 'candidate image identity drift')
        return ident

    def copy(self, src, dest):
        # Copy only into a fresh, root-private stage; never onto the live data tree.
        self.command(['rsync', '-a', '--numeric-ids', '--no-links', '--no-devices',
                      '--no-specials', '--delete', '--delete-excluded',
                      '--exclude=' + EXCLUDE, '--', str(src) + '/', str(dest) + '/'],
                     timeout=300, max_output=0)


def raw_off(data, uid):
    for path in (data, data / 'detailed-logs', data / 'detailed-logs' / 'raw'):
        info = path.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == uid and
                stat.S_IMODE(info.st_mode) == 0o700, 'raw directory gate')
    require(not any((data / 'detailed-logs' / 'raw').iterdir()), 'raw child not empty')
    config = read_json(data / 'config.json', 4 * 1024 * 1024)
    require(isinstance(config, dict) and config.get('rawBodyLogging') is False and
            isinstance(config.get('accounts'), list) and len(config['accounts']) == 32 and
            'clientKeys' not in config and
            all(isinstance(a, dict) and 'clientKeyId' not in a
                for a in config['accounts']), 'raw-off/v1/32-account contract drift')
    return sha(data / 'config.json')


def sources(cfg, *, owner=0, anchor=Path('/'), command=None):
    root = cfg.root
    compose = root / 'compose.yml'
    env = compose_env_source(compose, SERVICE, root)
    gateway = cfg.gateway
    logical = (GATEWAY_LOGICAL if anchor == Path('/') else
               cfg.nginx_root / 'conf.d/cps-admin-gateway.conf')
    expected_target = root / GATEWAY_TARGET_REL
    require(gateway == logical and gateway.is_absolute() and '..' not in gateway.parts and
            cfg.nginx_root == (GATEWAY_ROOT if anchor == Path('/') else anchor / 'nginx'),
            'gateway logical authority')
    for directory in (cfg.nginx_root, gateway.parent):
        entry = directory.lstat()
        require(stat.S_ISDIR(entry.st_mode) and entry.st_uid == owner and
                not stat.S_IMODE(entry.st_mode) & 0o022,
                'gateway directory authority')
    link_info = gateway.lstat()
    require(stat.S_ISLNK(link_info.st_mode) and link_info.st_uid == owner and
            os.readlink(gateway) == str(expected_target) and
            gateway.resolve(strict=True) == expected_target and
            expected_target.is_file(), 'gateway link/target authority')
    info = expected_target.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and
            info.st_uid == owner and stat.S_IMODE(info.st_mode) == 0o600 and
            info.st_size <= 65536 and
            sha(expected_target) == cfg.sidecar_hashes['gateway.conf'],
            'gateway target identity')
    # nginx -T tests and dumps the current on-disk include graph; it does NOT
    # attest that a running Nginx worker has reloaded those bytes. Never print
    # its output: it can contain the private proxy attestation token.
    text = (command or run)(['nginx', '-T'], timeout=15, max_output=1024 * 1024)
    marker = '# configuration file ' + str(gateway) + ':\n'
    sections = text.split(marker)
    require(len(sections) == 2 and sections[1], 'gateway not unique in disk include graph')
    section = sections[1].split('\n# configuration file ', 1)[0]
    # nginx may insert one separating newline after a file; otherwise demand
    # byte-for-byte text equality rather than trusting a filename-only marker.
    fd = os.open(expected_target, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        loaded = os.read(fd, 65537).decode('utf-8', errors='strict')
        require(len(loaded.encode()) == info.st_size and
                os.fstat(fd).st_ino == info.st_ino and
                sha(expected_target) == cfg.sidecar_hashes['gateway.conf'] and
                section in (loaded, loaded + '\n'), 'gateway disk include content drift')
    finally:
        os.close(fd)
    return {'compose.yml': compose, 'service.env': env,
            'gateway.conf': expected_target, 'deployment.json': root / 'deployment.json'}, str(expected_target)


def release_gate(path, expected=SOURCE, owner=0):
    """Read-only committed archive identity; a tag alone is not source evidence."""
    root = path.lstat()
    require(stat.S_ISDIR(root.st_mode) and root.st_uid == owner and
            stat.S_IMODE(root.st_mode) == 0o755, 'candidate source root gate')
    nested = {name.split('/')[0] for name in expected if '/' in name}
    require({p.name for p in path.iterdir()} ==
            {name for name in expected if '/' not in name} | nested,
            'candidate source inventory gate')
    for folder in nested:
        directory = path / folder
        info = directory.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == owner and
                stat.S_IMODE(info.st_mode) == 0o755 and
                {p.name for p in directory.iterdir()} ==
                {name.split('/')[1] for name in expected if name.startswith(folder + '/')},
                'candidate source directory gate')
    for name, digest in expected.items():
        file = path / name
        info = file.lstat()
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and
                info.st_uid == owner and stat.S_IMODE(info.st_mode) == 0o644 and
                info.st_size <= 2 * 1024 * 1024 and sha(file) == digest,
                'candidate source file gate')


def source_gates(cfg, docker, *, stopped=False, owner=0, uid=1000,
                 anchor=Path('/')):
    require(os.geteuid() == owner and (anchor != Path('/') or
            (cfg.root == ROOT and cfg.nginx_root == GATEWAY_ROOT)), 'canonical root gate')
    require(cfg.root.is_absolute() and cfg.root == cfg.root.resolve(strict=True) and
            (anchor == Path('/') or cfg.root == anchor / 'service'), 'project path gate')
    project = cfg.root.lstat()
    require(stat.S_ISDIR(project.st_mode) and project.st_uid == uid and
            stat.S_IMODE(project.st_mode) == 0o750, 'project owner/mode gate')
    require(cfg.release == cfg.root / 'releases' / RELEASE,
            'candidate release location gate')
    parent = cfg.release.parent.lstat()
    require(stat.S_ISDIR(parent.st_mode) and parent.st_uid == uid and
            stat.S_IMODE(parent.st_mode) == 0o700, 'candidate release parent gate')
    release_gate(cfg.release, owner=owner)
    require(sha(cfg.root / 'compose.yml') == cfg.compose_hash and
            raw_off(cfg.root / 'data', uid) == cfg.config_hash and
            sha(cfg.root / 'data' / 'metadata.json') == cfg.metadata_hash and
            sha(cfg.root / 'data' / 'admin-auth.json') == cfg.admin_hash,
            'live source hash drift')
    mapping, _ = sources(cfg, owner=owner, anchor=anchor)
    require({name: sha(path) for name, path in mapping.items()} == cfg.sidecar_hashes,
            'live sidecar hash drift')
    require(docker.inspect(stopped=stopped) == cfg.container_id,
            'old container drift')
    return mapping


def _write_file(path, payload):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        require(os.write(fd, payload) == len(payload), 'short private write')
        os.fsync(fd)
    finally:
        os.close(fd)


def sync_dir(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def phase(stage, name):
    """Durable marker, never 'trusted'; no automatic resume after interruption."""
    require(name in ('stopped-copy-pending', 'copy-verified-boot-pending'),
            'invalid backup phase')
    path, temp = stage / 'status.json', stage / 'status.json.new'
    require(not os.path.lexists(temp), 'interrupted private phase')
    if os.path.lexists(path):
        require(read_json(path) == {'phase': 'stopped-copy-pending', 'trusted': False} and
                name == 'copy-verified-boot-pending', 'stale backup phase')
    else:
        require(name == 'stopped-copy-pending', 'missing backup phase')
    _write_file(temp, (json.dumps({'phase': name, 'trusted': False}, sort_keys=True) + '\n').encode())
    os.replace(temp, path)
    sync_dir(stage)


def _copy_sidecar(source, dest):
    info = source.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and
            info.st_uid == os.geteuid() and info.st_size <= 65536 and
            stat.S_IMODE(info.st_mode) & 0o077 == 0 and
            stat.S_IMODE(info.st_mode) <= 0o700, 'sidecar source gate')
    original = sha(source)
    input_fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    output_fd = os.open(dest, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        require(os.fstat(input_fd).st_ino == info.st_ino, 'sidecar changed during open')
        left = info.st_size
        while left:
            chunk = os.read(input_fd, min(left, 65536))
            require(chunk, 'short sidecar read')
            require(os.write(output_fd, chunk) == len(chunk), 'short sidecar write')
            left -= len(chunk)
        os.fchown(output_fd, info.st_uid, info.st_gid)
        os.fchmod(output_fd, stat.S_IMODE(info.st_mode))
        os.fsync(output_fd)
    finally:
        os.close(input_fd)
        os.close(output_fd)
    require(sha(source) == original and sha(dest) == original, 'sidecar copy drift')
    return {'source': str(source), 'sha256': original, 'uid': info.st_uid,
            'gid': info.st_gid, 'mode': stat.S_IMODE(info.st_mode)}


def stopped_backup(cfg, docker, *, anchor=Path('/'), owner=0, uid=1000,
                   scan=inventory):
    """Caller already stopped exact old container and owns a durable writer fence.

    No recovery/start on failure: an ambiguous STOP or copy is a manual fenced hold.
    """
    require(cfg.stage is not None and STAGE_NAME.fullmatch(cfg.stage.name) and
            cfg.stage.parent == (Path('/root') if anchor == Path('/') else anchor / 'root') and
            not os.path.lexists(cfg.stage), 'new private stage required')
    private_path(cfg.stage.parent, anchor=anchor, owner=owner, final_mode=0o700)
    mapping = source_gates(cfg, docker, stopped=True, owner=owner, uid=uid, anchor=anchor)
    raw_off(cfg.root / 'data', uid)
    # Record initial live inventory before creating even a private staging directory.
    initial = scan(cfg.root / 'data', source=True)
    source_gates(cfg, docker, stopped=True, owner=owner, uid=uid, anchor=anchor)
    os.mkdir(cfg.stage, 0o700)
    private_path(cfg.stage, anchor=anchor, owner=owner, final_mode=0o700)
    phase(cfg.stage, 'stopped-copy-pending')
    base = cfg.stage / 'sidecars-complete'
    os.mkdir(base, 0o700)
    records = {name: _copy_sidecar(src, base / name)
               for name, src in sorted(mapping.items())}
    _, link = sources(cfg, owner=owner, anchor=anchor)
    manifest = {'files': records, 'gatewayLogicalPath': str(cfg.gateway),
                'gatewayLinkTarget': link}
    _write_file(base / 'source-manifest.json',
                (json.dumps(manifest, sort_keys=True) + '\n').encode())
    sync_dir(base)
    sidecars(cfg.stage, root=cfg.root, compose=cfg.root / 'compose.yml',
             service=SERVICE, gateway=cfg.gateway, nginx_root=cfg.nginx_root, owner=owner)
    # A new destination plus an anchored raw exclusion. Do not rsync into live DATA_DIR.
    os.mkdir(cfg.stage / 'data', 0o700)
    source_root = (cfg.root / 'data').lstat()
    if (source_root.st_uid, source_root.st_gid) != (os.geteuid(), os.getegid()):
        os.chown(cfg.stage / 'data', source_root.st_uid, source_root.st_gid)
    docker.copy(cfg.root / 'data', cfg.stage / 'data')
    require(scan(cfg.root / 'data', source=True) == initial and
            scan(cfg.stage / 'data') == initial and
            scan(cfg.root / 'data', source=True) == initial,
            'source-copy-source tree drift')
    require(not os.path.lexists(cfg.stage / 'data' / 'detailed-logs' / 'raw'),
            'raw unexpectedly copied')
    # A second independent private restore proves file parity, NOT old-image boot.
    os.mkdir(cfg.stage / 'restored-v1', 0o700)
    if (source_root.st_uid, source_root.st_gid) != (os.geteuid(), os.getegid()):
        os.chown(cfg.stage / 'restored-v1', source_root.st_uid, source_root.st_gid)
    docker.copy(cfg.stage / 'data', cfg.stage / 'restored-v1')
    require(scan(cfg.stage / 'restored-v1') == initial and
            scan(cfg.stage / 'data') == initial and
            scan(cfg.root / 'data', source=True) == initial,
            'isolated restore parity drift')
    source_gates(cfg, docker, stopped=True, owner=owner, uid=uid, anchor=anchor)
    sidecars(cfg.stage, root=cfg.root, compose=cfg.root / 'compose.yml',
             service=SERVICE, gateway=cfg.gateway, nginx_root=cfg.nginx_root, owner=owner)
    require(scan(cfg.root / 'data', source=True) == initial, 'final source drift')
    phase(cfg.stage, 'copy-verified-boot-pending')
    return True


def parse(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    actions = parser.add_mutually_exclusive_group(required=True)
    actions.add_argument('--preflight', action='store_true')
    actions.add_argument('--seal-stopped', action='store_true')
    parser.add_argument('--ack-independent-stop-and-fence', action='store_true')
    parser.add_argument('--stage', type=Path)
    parser.add_argument('--container-id', required=True)
    parser.add_argument('--compose-sha256', required=True)
    parser.add_argument('--config-sha256', required=True)
    parser.add_argument('--metadata-sha256', required=True)
    parser.add_argument('--admin-sha256', required=True)
    parser.add_argument('--env-sha256', required=True)
    parser.add_argument('--gateway-sha256', required=True)
    parser.add_argument('--deployment-sha256', required=True)
    parser.add_argument('--gateway', type=Path, required=True)
    cfg = parser.parse_args(argv)
    require(cfg.gateway == GATEWAY_LOGICAL and
            all(type(x) is str and HEX.fullmatch(x) for x in
                (cfg.container_id, cfg.compose_sha256, cfg.config_sha256,
                 cfg.metadata_sha256, cfg.admin_sha256, cfg.env_sha256,
                 cfg.gateway_sha256, cfg.deployment_sha256)) and
            cfg.gateway.is_absolute() and '..' not in cfg.gateway.parts and
            (not cfg.seal_stopped or (cfg.ack_independent_stop_and_fence and
                                      cfg.stage is not None)), 'explicit fence parameters')
    cfg.root, cfg.nginx_root = ROOT, GATEWAY_ROOT
    cfg.release = ROOT / 'releases' / RELEASE
    cfg.compose_hash, cfg.config_hash = cfg.compose_sha256, cfg.config_sha256
    cfg.metadata_hash, cfg.admin_hash = cfg.metadata_sha256, cfg.admin_sha256
    cfg.sidecar_hashes = {'compose.yml': cfg.compose_hash, 'service.env': cfg.env_sha256,
                          'gateway.conf': cfg.gateway_sha256,
                          'deployment.json': cfg.deployment_sha256}
    return cfg


def main(argv=None):
    try:
        cfg = parse(argv)
        docker = Docker(cfg)
        if cfg.preflight:
            source_gates(cfg, docker)
            print('read-only old-image preflight passed; no backup accepted')
        else:
            stopped_backup(cfg, docker)
            print('stopped v1 copy parity passed; isolated boot and switch NOT authorized')
    except (GateError, OSError, ValueError, TypeError, KeyError, json.JSONDecodeError):
        print('code cutover backup blocked; keep ingress fenced and inspect private phase',
              file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
