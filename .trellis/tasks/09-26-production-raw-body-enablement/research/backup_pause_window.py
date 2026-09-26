#!/usr/bin/env python3
"""Backup-only 600s pause preparation; NO stop/start, restore or deployment.

Requires separate operational review and a fresh root-private stage. Probe is
read-only. Execute starts a persistent systemd-supervised exact-ID watchdog
BEFORE pause. Ambiguous pause leaves it armed even after HTTP recovery; only a
known-completed pause + proven HTTP recovery permits explicit cancellation.
The resulting copy always remains untrusted until isolated restore rehearsal.
Even the final source scan cannot prevent external writes after it finishes;
an external writer fence and recheck are required before accepting any backup.
No tool can promise 600s availability if Docker/systemd/host itself is broken.
"""
import argparse
import json
import http.client
import os
from pathlib import Path
import re
import signal
import stat
import subprocess
import sys
import time

from backup_window_common import (EXCLUDE, GateError, HEX, atomic_status, inventory,
                                  private_path, read_json, require, sha, sidecars, stage_gate)
from backup_window_watchdog import boot_id, read_state, state_path, SCRIPT as WATCHDOG_SCRIPT

SERVICE = 'cline-pass-console'
WINDOW = 600
RESERVE = 60
MEMORY = 536_870_912
ROOT = Path('/opt/cline-pass-switcher')
INSPECT = ('{{json .Id}} {{json .Name}} {{json .Image}} {{json .State.Status}} '
           '{{json .State.Health.Status}} {{json .RestartCount}} '
           '{{json .State.OOMKilled}} {{json .HostConfig.Memory}} '
           '{{json .Mounts}} {{json .Config.Labels}}')


def command(argv, timeout=15, max_output=8192):
    try:
        result = subprocess.run(argv, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                timeout=timeout, check=False)
        require(result.returncode == 0 and len(result.stdout) <= max_output, 'command failed')
        return result.stdout.decode('utf-8', errors='strict')
    except (OSError, subprocess.TimeoutExpired, UnicodeError) as exc:
        raise GateError('command unavailable or timed out') from exc


def fields(text, count):
    decoder = json.JSONDecoder()
    values = []
    for _ in range(count):
        value, end = decoder.raw_decode(text.lstrip())
        values.append(value)
        text = text.lstrip()[end:]
    require(not text.strip(), 'inspect shape')
    return values


class PauseOps:
    def __init__(self, cfg, run=command, boot=time.monotonic, *, owner=0, anchor=Path('/')):
        self.cfg, self.run, self.boot = cfg, run, boot
        self.owner, self.anchor = owner, anchor

    def inspect(self):
        values = fields(self.run(['docker', 'inspect', '--format', INSPECT,
                                  self.cfg.container_id]), 10)
        ident, name, image, status, health, restarts, oom, memory, mounts, labels = values
        require(ident == self.cfg.container_id and name == '/' + SERVICE and
                image == self.cfg.image and status in ('running', 'paused') and
                health == 'healthy' and type(restarts) is int and restarts == 0 and
                oom is False and type(memory) is int and memory == MEMORY and
                isinstance(mounts, list) and len(mounts) == 1 and
                isinstance(labels, dict) and labels.get('com.docker.compose.service') == SERVICE and
                len(labels) < 64, 'old container identity/health/memory fence')
        mount = mounts[0]
        require(isinstance(mount, dict) and mount.get('Type') == 'bind' and
                mount.get('Source') == str(self.cfg.data) and
                mount.get('Destination') == '/data' and mount.get('RW') is True,
                'data mount fence')
        require(self.run(['docker', 'compose', '-f', str(self.cfg.compose),
                          'ps', '-q', SERVICE]).strip() == ident,
                'Compose service identity drift')
        return ident, status

    def gateway_loaded(self):
        # nginx -T emits configuration to stdout; capture it only in memory, never log it.
        # An unusually large or unparseable projection is not accepted as proof.
        output = self.run(['nginx', '-T'], 15, 1024 * 1024)
        require(output.splitlines().count('# configuration file ' + str(self.cfg.gateway) + ':') == 1,
                'gateway not in active Nginx configuration')

    def unit(self):
        require(HEX.fullmatch(self.cfg.container_id), 'invalid container ID')
        return 'cps-backup-unpause-' + self.cfg.container_id + '.service'

    def watchdog_active(self, service, *, minimum=0):
        require(service == self.unit(), 'unexpected watchdog identity')
        deadline_ns = read_state(state_path(self.cfg.container_id), self.cfg.container_id)
        props_text = self.run(['systemctl', 'show', service, '--property=LoadState,ActiveState,SubState,MainPID,Type,Restart,RestartUSec,User,ExecStart'], 5, 2048)
        lines = [line.split('=', 1) for line in props_text.splitlines()]
        keys = {'LoadState', 'ActiveState', 'SubState', 'MainPID', 'Type', 'Restart',
                'RestartUSec', 'User', 'ExecStart'}
        require(len(lines) == len(keys) and all(len(line) == 2 for line in lines) and
                {line[0] for line in lines} == keys, 'watchdog service shape')
        props = dict(lines)
        require(props['LoadState'] == 'loaded' and props['ActiveState'] == 'active' and
                props['SubState'] == 'running' and re.fullmatch(r'[1-9][0-9]*', props['MainPID']) and
                props['Type'] == 'exec' and props['Restart'] == 'always' and
                props['RestartUSec'] == '1s' and
                props['User'] == '', 'watchdog not independently supervised')
        expected = (r'\{ path=/usr/bin/python3 ; argv\[\]=/usr/bin/python3 '
                    + re.escape(str(WATCHDOG_SCRIPT)) + r' --container-id '
                    + self.cfg.container_id + r' ; ignore_errors=no'
                    + r'(?: ; start_time=\[[^\]\n]{1,64}\] ; stop_time=\[[^\]\n]{1,64}\]'
                    + r' ; pid=[0-9]+ ; code=\([a-z]+\) ; status=[0-9]+/[0-9]+)? \}')
        require(re.fullmatch(expected, props['ExecStart']) is not None,
                'watchdog payload mismatch')
        remaining = deadline_ns / 1_000_000_000 - self.boot()
        require(minimum < remaining <= WINDOW + 2, 'watchdog deadline outside window')
        return remaining

    def arm(self):
        for path in ('/usr/bin/python3', '/usr/bin/docker'):
            binary = os.stat(path)
            require(stat.S_ISREG(binary.st_mode) and os.access(path, os.X_OK),
                    'independent runtime unavailable')
        private_path(WATCHDOG_SCRIPT.parent, anchor=self.anchor,
                     owner=self.owner, final_mode=0o700)
        info = WATCHDOG_SCRIPT.lstat()
        require(stat.S_ISREG(info.st_mode) and info.st_uid == self.owner and
                stat.S_IMODE(info.st_mode) == 0o600 and info.st_nlink == 1,
                'root-private watchdog script missing')
        service = self.unit()
        require(self.run(['systemctl', 'show', service,
                          '--property=LoadState', '--value']).strip() == 'not-found',
                'watchdog unit name occupied')
        path = state_path(self.cfg.container_id)
        require(not os.path.lexists(path), 'watchdog state already exists')
        deadline_ns = time.monotonic_ns() + WINDOW * 1_000_000_000
        record = json.dumps({'containerId': self.cfg.container_id, 'bootId': boot_id(),
                             'deadlineNs': deadline_ns}, sort_keys=True).encode()
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        try:
            require(os.write(fd, record) == len(record), 'short watchdog state write')
            os.fsync(fd)
        finally:
            os.close(fd)
        self.run(['systemd-run', '--unit=' + service.removesuffix('.service'),
                  '--property=Type=exec', '--property=Restart=always',
                  '--property=RestartSec=1s', '/usr/bin/python3',
                  str(WATCHDOG_SCRIPT), '--container-id', self.cfg.container_id])
        return service

    def cancel(self, service):
        require(service == self.unit(), 'unexpected watchdog identity')
        self.watchdog_active(service, minimum=-WINDOW * 1000)
        self.run(['systemctl', 'stop', service], 10)
        require(self.run(['systemctl', 'show', service,
                          '--property=ActiveState', '--value']).strip() == 'inactive',
                'watchdog cancellation ambiguous')
        # Keep the root-private record: never allow re-arming an ambiguous ID.

    def pause(self):
        self.run(['docker', 'pause', self.cfg.container_id], 20)

    def unpause(self):
        self.run(['docker', 'unpause', self.cfg.container_id], 20)

    def rsync(self, timeout):
        self.run(['rsync', '-a', '--numeric-ids', '--no-links', '--no-devices',
                  '--no-specials', '--delete', '--delete-excluded',
                  '--exclude=' + EXCLUDE, '--', str(self.cfg.data) + '/',
                  str(self.cfg.stage / 'data') + '/'], timeout)

    def healthy(self):
        require(self.inspect() == (self.cfg.container_id, 'running'), 'service not running')
        # Fixed public metadata path, no credentials or body, 200 alone is checked.
        connection = http.client.HTTPConnection('127.0.0.1', 3123, timeout=3)
        try:
            connection.request('GET', '/api/meta')
            require(connection.getresponse().status == 200, 'local HTTP recovery failed')
        except (OSError, ValueError) as exc:
            raise GateError('local HTTP recovery unavailable') from exc
        finally:
            connection.close()


def raw_empty(data, uid):
    for p in (data, data / 'detailed-logs', data / 'detailed-logs/raw'):
        info = p.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == uid and
                stat.S_IMODE(info.st_mode) == 0o700, 'raw directory gate')
    with os.scandir(data / 'detailed-logs/raw') as items:
        require(next(items, None) is None, 'raw groups present')


def probe(ops, cfg, *, anchor=Path('/'), uid=0, data_uid=1000, scan=inventory):
    require(os.geteuid() == uid and (anchor != Path('/') or cfg.root == ROOT),
            'root/canonical location required')
    stage_gate(cfg.stage, anchor=anchor, owner=uid, data_uid=data_uid)
    root_stage = cfg.stage.parent == anchor / 'root'
    if root_stage:
        private_path(cfg.stage.parent, anchor=anchor, owner=uid, final_mode=0o700)
    require((cfg.stage.is_relative_to(cfg.root.parent) or root_stage) and
            not cfg.stage.is_relative_to(cfg.root) and
            cfg.data == cfg.root / 'data' and cfg.compose == cfg.root / 'compose.yml',
            'backup stage/data/compose location')
    require(sha(cfg.compose) == cfg.compose_hash and
            sha(cfg.data / 'config.json') == cfg.config_hash, 'compose/config drift')
    config = read_json(cfg.data / 'config.json', 2 * 1024 * 1024)
    require(isinstance(config, dict) and config.get('rawBodyLogging') is False,
            'raw capture must remain explicitly disabled')
    sidecars(cfg.stage, root=cfg.root, compose=cfg.compose, service=SERVICE,
             gateway=cfg.gateway, nginx_root=cfg.nginx_root, owner=uid)
    ops.gateway_loaded()
    raw_empty(cfg.data, data_uid)
    scan(cfg.stage / 'data')
    require(ops.inspect() == (cfg.container_id, 'running'), 'old service not running')
    ops.healthy()
    return True


def execute(ops, cfg, *, anchor=Path('/'), uid=0, data_uid=1000,
            clock=time.monotonic, sleep=time.sleep, scan=inventory):
    probe(ops, cfg, anchor=anchor, uid=uid, data_uid=data_uid, scan=scan)
    started = clock()
    service = None
    attempted = verified = recovered = armed_verified = pause_completed = False
    try:
        # Ambiguous arm fails closed without pausing. Never disarm an unverified unit.
        service = ops.arm()
        remaining = ops.watchdog_active(service, minimum=WINDOW - RESERVE)
        armed_verified = True
        deadline = min(started + WINDOW - RESERVE, clock() + remaining - RESERVE)
        probe(ops, cfg, anchor=anchor, uid=uid, data_uid=data_uid, scan=scan)
        require(clock() < deadline, 'arm/setup deadline')
        # The second probe can outlive the watchdog. Recheck its exact supervised
        # unit/payload and reserve just before pause. A micro-race remains between
        # this check and Docker: Restart=always plus the persistent deadline state
        # provide recovery, not an absolute availability guarantee.
        ops.watchdog_active(service, minimum=RESERVE)
        attempted = True  # Docker timeout can mean the container was already paused.
        ops.pause()
        pause_completed = True

        def fenced():
            require(clock() < deadline and
                    ops.inspect() == (cfg.container_id, 'paused'),
                    'paused identity/deadline fence')
            ops.watchdog_active(service, minimum=RESERVE)

        fenced()
        stage_gate(cfg.stage, anchor=anchor, owner=uid, data_uid=data_uid)
        require(sha(cfg.compose, deadline) == cfg.compose_hash and
                sha(cfg.data / 'config.json', deadline) == cfg.config_hash,
                'quiescent compose/config drift')
        ops.rsync(max(1, min(450, int(deadline - clock()))))
        fenced()
        before = scan(cfg.data, source=True, deadline=deadline)
        fenced()
        copied = scan(cfg.stage / 'data', deadline=deadline)
        fenced()
        after = scan(cfg.data, source=True, deadline=deadline)
        fenced()
        require(before == copied == after, 'non-raw tree parity or external write drift')
        require(sha(cfg.compose, deadline) == cfg.compose_hash and
                sha(cfg.data / 'config.json', deadline) == cfg.config_hash,
                'post-copy compose/config drift')
        sidecars(cfg.stage, root=cfg.root, compose=cfg.compose, service=SERVICE,
                 gateway=cfg.gateway, nginx_root=cfg.nginx_root, owner=uid,
                 deadline=deadline)
        ops.gateway_loaded()
        raw_empty(cfg.data, data_uid)
        fenced()
        # Recheck after sidecar/gateway work: those checks may overlap an external
        # writer. This detects observed drift, not writes after this final scan;
        # acceptance still requires an external writer fence and recheck.
        require(scan(cfg.data, source=True, deadline=deadline) == copied,
                'final non-raw source drift')
        fenced()
        verified = True
    finally:
        if attempted:
            # Even if inspect fails, unpause the exact captured ID. A failed or
            # timed-out pause can complete later; never cancel in that case.
            try:
                try:
                    if ops.inspect() == (cfg.container_id, 'paused'):
                        ops.unpause()
                except (GateError, OSError):
                    ops.unpause()
                for attempt in range(10):
                    try:
                        ops.healthy()
                        recovered = True
                        break
                    except (GateError, OSError):
                        if attempt == 9 or clock() >= started + WINDOW - 5:
                            raise
                        sleep(1)
            except (GateError, OSError):
                try:
                    ops.unpause()
                except (GateError, OSError):
                    pass
                raise
        elif armed_verified:
            # Only a verified exact-payload watchdog can be disarmed after health.
            ops.healthy()
            recovered = True
        if recovered and armed_verified and (not attempted or pause_completed):
            ops.cancel(service)
    require(verified and recovered and clock() < started + WINDOW,
            'backup window did not finish safely')
    atomic_status(cfg.stage, 'quiescent-copy-verified-restore-pending')
    return True


def interrupted(_signal, _frame):
    raise GateError('window interrupted')


def parse(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument('--probe', action='store_true')
    action.add_argument('--execute', action='store_true')
    parser.add_argument('--ack-backup-only-window', action='store_true')
    parser.add_argument('--stage', type=Path, required=True)
    parser.add_argument('--compose-sha256', required=True)
    parser.add_argument('--config-sha256', required=True)
    parser.add_argument('--image', required=True)
    parser.add_argument('--container-id', required=True)
    parser.add_argument('--gateway', type=Path, required=True)
    parser.add_argument('--nginx-root', type=Path, default=Path('/etc/nginx'))
    cfg = parser.parse_args(argv)
    cfg.root = ROOT
    cfg.data = ROOT / 'data'
    cfg.compose = ROOT / 'compose.yml'
    require(all(HEX.fullmatch(v) for v in (cfg.compose_sha256, cfg.config_sha256,
                                          cfg.container_id)) and
            re.fullmatch(r'sha256:[0-9a-f]{64}', cfg.image) and
            cfg.stage.is_absolute() and cfg.gateway.is_absolute() and
            cfg.nginx_root.is_absolute() and '..' not in cfg.stage.parts and
            '..' not in cfg.gateway.parts and '..' not in cfg.nginx_root.parts and
            (not cfg.execute or cfg.ack_backup_only_window), 'explicit window parameters')
    cfg.compose_hash, cfg.config_hash = cfg.compose_sha256, cfg.config_sha256
    return cfg


def main(argv=None):
    try:
        cfg = parse(argv)
        ops = PauseOps(cfg)
        if cfg.probe:
            probe(ops, cfg)
            print('backup probe passed; stage untrusted')
        else:
            signal.signal(signal.SIGTERM, interrupted)
            signal.signal(signal.SIGINT, interrupted)
            execute(ops, cfg)
            print('quiescent non-raw copy verified; isolated restore pending; stage untrusted')
    except (GateError, OSError, ValueError, TypeError, KeyError, json.JSONDecodeError):
        print('backup window blocked; independently inspect exact container/watchdog/private stage',
              file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
