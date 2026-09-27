#!/usr/bin/env python3
"""Synthetic paths and fake operations only: never Docker, Nginx or systemd."""
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import unittest
from contextlib import redirect_stdout
from unittest.mock import patch
from types import SimpleNamespace

import backup_pause_window as pause
import backup_window_common as common
import backup_window_watchdog as watchdog


def put(path, body):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(body)
    path.chmod(0o600)


class FakeOps:
    def __init__(self, cfg):
        self.cfg = cfg
        self.state = 'running'
        self.timer = False
        self.actions = []
        self.failure = None
        self.advance = None
        self.boot = time.monotonic

    def inspect(self, *, recovering=False, deadline=None):
        self.actions.append('inspect')
        return (self.cfg.container_id, self.state, 'healthy') if recovering else (self.cfg.container_id, self.state)

    def healthy(self, *, timeout=0):
        self.actions.append('healthy')
        if self.failure == 'health' or self.state != 'running':
            raise common.GateError('synthetic unhealthy')

    def gateway_loaded(self):
        self.actions.append('gateway')

    def arm(self):
        self.actions.append('arm')
        self.timer = True
        if self.failure == 'arm-timeout':
            raise common.GateError('synthetic arm ambiguity')
        return 'synthetic.service'

    def watchdog_active(self, service, *, minimum=0):
        self.actions.append('watchdog_active')
        if self.failure == 'timer' or not self.timer:
            raise common.GateError('synthetic watchdog failure')
        return 599

    def cancel(self, service):
        self.actions.append('cancel')
        assert self.state == 'running' and self.failure != 'health'
        self.timer = False

    def pause(self):
        self.actions.append('pause')
        self.state = 'paused'
        if self.failure == 'ambiguous':
            raise common.GateError('synthetic ambiguous pause')

    def unpause(self, timeout=20):
        self.actions.append('unpause')
        if self.failure == 'unpause':
            raise common.GateError('synthetic unpause failure')
        self.state = 'running'

    def rsync(self, timeout):
        self.actions.append('rsync')
        assert self.state == 'paused' and 0 < timeout <= 450
        if self.failure == 'copy':
            raise common.GateError('synthetic copy failure')
        dest = self.cfg.stage / 'data'
        for child in dest.iterdir():
            if child.is_dir():
                shutil.rmtree(child)
            else:
                child.unlink()
        shutil.copytree(self.cfg.data, dest, dirs_exist_ok=True,
                        ignore=lambda parent, names: ['raw'] if Path(parent).name == 'detailed-logs' else [],
                        copy_function=shutil.copy2)
        if self.failure == 'mismatch':
            put(dest / 'metadata.json', b'changed')
        if self.failure == 'writer':
            put(self.cfg.data / 'metadata.json', b'external writer')
        if self.failure == 'deadline':
            self.advance(545)


class PauseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='cps-backup-fixture-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.root.chmod(0o700)
        (self.root / 'opt').mkdir(mode=0o700)
        self.stage = self.root / 'opt/stage'
        self.data = self.root / 'opt/service/data'
        self.compose = self.root / 'opt/service/compose.yml'
        for d in (self.stage, self.stage / 'data', self.stage / 'sidecars-complete',
                  self.data):
            d.mkdir(parents=True, mode=0o700)
        put(self.compose, b'services:\n  cline-pass-console:\n    env_file:\n      - ./service.env\n')
        put(self.root / 'opt/service/deployment.json', b'synthetic deployment')
        put(self.root / 'opt/service/service.env', b'synthetic env')
        self.gateway = self.root / 'nginx/sites-enabled/site'
        target = self.root / 'nginx/sites-available/site'
        put(target, b'synthetic gateway')
        self.gateway.parent.mkdir(parents=True)
        self.gateway.symlink_to(target)
        for name in ('config.json', 'metadata.json', 'admin-auth.json'):
            put(self.data / name, b'{"rawBodyLogging":false}' if name == 'config.json'
                else ('synthetic ' + name).encode())
        put(self.data / 'logs/ordinary.jsonl', b'synthetic log')
        raw = self.data / 'detailed-logs/raw'
        raw.mkdir(parents=True, mode=0o700)
        for d in (self.data / 'logs', raw.parent):
            d.chmod(0o700)
        put(self.stage / 'status.json', b'{"phase":"precopy-unverified","trusted":false}')
        records = {}
        for name, src in (('compose.yml', self.compose),
                          ('service.env', self.root / 'opt/service/service.env'),
                          ('gateway.conf', target),
                          ('deployment.json', self.root / 'opt/service/deployment.json')):
            shutil.copy2(src, self.stage / 'sidecars-complete' / name)
            info = src.stat()
            records[name] = {'source': str(src), 'sha256': common.sha(src),
                             'uid': info.st_uid, 'gid': info.st_gid,
                             'mode': stat.S_IMODE(info.st_mode)}
        put(self.stage / 'sidecars-complete/source-manifest.json', json.dumps({
            'files': records, 'gatewayLogicalPath': str(self.gateway),
            'gatewayLinkTarget': os.readlink(self.gateway)}).encode())
        shutil.copytree(self.data, self.stage / 'data', dirs_exist_ok=True,
                        ignore=lambda parent, names: ['raw'] if Path(parent).name == 'detailed-logs' else [])
        self.cfg = SimpleNamespace(stage=self.stage, root=self.root / 'opt/service', data=self.data,
                                   compose=self.compose, compose_hash=common.sha(self.compose),
                                   config_hash=common.sha(self.data / 'config.json'),
                                   gateway=self.gateway, nginx_root=self.root / 'nginx',
                                   container_id='a' * 64, image='sha256:' + 'b' * 64)
        self.ops = FakeOps(self.cfg)
        self.kw = {'anchor': self.root, 'uid': os.geteuid(), 'data_uid': os.geteuid()}

    def test_success_stays_untrusted_and_uses_only_pause(self):
        self.assertTrue(pause.probe(self.ops, self.cfg, **self.kw))
        self.assertTrue(pause.execute(self.ops, self.cfg, **self.kw))
        digest, entries, size = common.inventory(self.data, source=True)
        expected_tree = {'sha256': digest.hex(), 'entries': entries, 'bytes': size}
        self.assertEqual(common.read_json(self.stage / 'status.json'), {
            'phase': 'quiescent-copy-verified-restore-pending', 'trusted': False,
            'sourceTree': expected_tree, 'copyTree': expected_tree,
            'image': self.cfg.image, 'containerId': self.cfg.container_id,
            'configSha256': self.cfg.config_hash, 'composeSha256': self.cfg.compose_hash})
        self.assertEqual(common.inventory(self.stage / 'data'),
                         common.inventory(self.data, source=True))
        self.assertFalse((self.stage / 'status.json.new').exists())
        self.assertLess(self.ops.actions.index('arm'), self.ops.actions.index('pause'))
        self.assertEqual(self.ops.actions[self.ops.actions.index('pause') - 1], 'watchdog_active')
        self.assertLess(self.ops.actions.index('unpause'), self.ops.actions.index('cancel'))
        self.assertFalse(self.ops.timer)
        self.assertFalse((self.stage / 'data/detailed-logs/raw').exists())

    def test_execute_waits_for_delayed_health_before_disarming_watchdog(self):
        now = [time.monotonic()]
        recovered_at = []
        def delayed_health(*, timeout=0):
            self.ops.actions.append('healthy')
            if timeout:
                self.assertEqual(self.ops.state, 'running')
                self.assertTrue(self.ops.timer)
                self.assertGreaterEqual(timeout, 30)
                now[0] += 31  # synthetic 30-second Docker health cadence
                recovered_at.append(len(self.ops.actions))
        self.ops.healthy = delayed_health
        self.assertTrue(pause.execute(self.ops, self.cfg, **self.kw, clock=lambda: now[0]))
        self.assertEqual(len(recovered_at), 1)
        self.assertLessEqual(recovered_at[0], self.ops.actions.index('cancel'))
        self.assertFalse(self.ops.timer)

    def test_watchdog_unpaused_running_unhealthy_then_recovers_without_redundant_unpause(self):
        now = [0.0]
        state, calls, run = self.docker_fixture()
        original_inspect = self.ops.inspect
        def watchdog_wins(*, recovering=False, deadline=None):
            if recovering:
                self.ops.state = 'running'  # watchdog unpaused after fenced copy
                state.update(health='unhealthy', http=503)
            return original_inspect(recovering=recovering, deadline=deadline)
        def advance(seconds):
            self.assertTrue(self.ops.timer)
            now[0] += seconds
            if now[0] >= 31:
                state['health'] = 'healthy'
            if now[0] >= 34:
                state['http'] = 200
        real = pause.PauseOps(self.cfg, run, boot=lambda: now[0], sleep=advance)
        def health(*, timeout=0):
            self.ops.actions.append('healthy')
            real.healthy(timeout=timeout)
        self.ops.inspect = watchdog_wins
        self.ops.healthy = health
        self.ops.boot = lambda: now[0]
        self.assertTrue(pause.execute(self.ops, self.cfg, **self.kw, clock=lambda: now[0]))
        self.assertEqual(now[0], 34)
        self.assertNotIn('unpause', self.ops.actions)
        self.assertIn(pause.META_GET, calls)
        self.assertLess(self.ops.actions.index('healthy', self.ops.actions.index('pause')),
                        self.ops.actions.index('cancel'))
        self.assertFalse(self.ops.timer)

    def test_copy_error_after_watchdog_unpause_waits_for_recovery_before_cancel(self):
        now = [0.0]
        state, calls, run = self.docker_fixture()
        original_inspect = self.ops.inspect
        def watchdog_wins(*, recovering=False, deadline=None):
            if recovering:
                self.ops.state = 'running'
                state.update(health='unhealthy', http=503)
            return original_inspect(recovering=recovering, deadline=deadline)
        def advance(seconds):
            self.assertTrue(self.ops.timer)
            now[0] += seconds
            if now[0] >= 31:
                state['health'] = 'healthy'
            if now[0] >= 34:
                state['http'] = 200
        real = pause.PauseOps(self.cfg, run, boot=lambda: now[0], sleep=advance)
        def health(*, timeout=0):
            self.ops.actions.append('healthy')
            real.healthy(timeout=timeout)
        self.ops.inspect = watchdog_wins
        self.ops.healthy = health
        self.ops.boot = lambda: now[0]
        self.ops.failure = 'copy'
        with self.assertRaises(common.GateError):
            pause.execute(self.ops, self.cfg, **self.kw, clock=lambda: now[0])
        self.assertEqual(now[0], 34)
        self.assertNotIn('unpause', self.ops.actions)
        self.assertIn(pause.META_GET, calls)
        self.assertLess(self.ops.actions.index('healthy', self.ops.actions.index('rsync')),
                        self.ops.actions.index('cancel'))
        self.assertFalse(self.ops.timer)
        self.assertEqual(common.read_json(self.stage / 'status.json'),
                         {'phase': 'precopy-unverified', 'trusted': False})

    def test_watchdog_unpaused_but_health_times_out_leaves_guard_armed(self):
        original = self.ops.inspect
        def watchdog_wins(*, recovering=False, deadline=None):
            if recovering:
                self.ops.state = 'running'
            return original(recovering=recovering, deadline=deadline)
        self.ops.inspect = watchdog_wins
        self.ops.failure = 'unpause'  # redundant Docker unpause would fail
        def never_healthy(*, timeout=0):
            self.ops.actions.append('healthy')
            if timeout:
                self.assertTrue(self.ops.timer)
                self.assertLessEqual(timeout, pause.RECOVERY_WAIT)
                raise common.GateError('synthetic health timeout')
        self.ops.healthy = never_healthy
        with self.assertRaises(common.GateError):
            pause.execute(self.ops, self.cfg, **self.kw)
        self.assertNotIn('unpause', self.ops.actions)
        self.assertNotIn('cancel', self.ops.actions)
        self.assertTrue(self.ops.timer)

    def test_identity_drift_after_pause_does_not_unpause_or_cancel(self):
        original = self.ops.inspect
        def drift(*, recovering=False, deadline=None):
            if recovering:
                raise pause.IdentityDrift('synthetic Compose identity drift')
            return original()
        self.ops.inspect = drift
        with self.assertRaises(pause.IdentityDrift):
            pause.execute(self.ops, self.cfg, **self.kw)
        self.assertIn('pause', self.ops.actions)
        self.assertNotIn('unpause', self.ops.actions)
        self.assertNotIn('cancel', self.ops.actions)
        self.assertTrue(self.ops.timer)

    def test_inspect_command_failure_is_not_an_identity_change_or_cancellation(self):
        original = self.ops.inspect
        def unavailable(*, recovering=False, deadline=None):
            if recovering:
                raise common.GateError('synthetic Docker command unavailable')
            return original()
        self.ops.inspect = unavailable
        with self.assertRaises(common.GateError):
            pause.execute(self.ops, self.cfg, **self.kw)
        self.assertIn('unpause', self.ops.actions)  # exact-ID best effort
        self.assertNotIn('cancel', self.ops.actions)
        self.assertTrue(self.ops.timer)

    def test_status_seal_rejects_malformed_evidence_before_creating_file(self):
        tree = common.inventory(self.data, source=True)
        evidence = {'source_tree': tree, 'copy_tree': tree, 'image': self.cfg.image,
                    'container_id': self.cfg.container_id,
                    'config_sha256': self.cfg.config_hash,
                    'compose_sha256': self.cfg.compose_hash}
        status = self.stage / 'status.json'
        original = status.read_bytes()
        cases = (
            ('phase', 'precopy-unverified'),
            ('source_tree', (tree[0][:-1], tree[1], tree[2])),
            ('source_tree', (tree[0], True, tree[2])),
            ('source_tree', (tree[0], common.MAX_ENTRIES + 1, tree[2])),
            ('source_tree', (tree[0], tree[1], common.MAX_BYTES + 1)),
            ('copy_tree', (tree[0], tree[1], tree[2] + 1)),
            ('image', 'sha256:' + 'A' * 64),
            ('container_id', 'short'),
            ('config_sha256', 'A' * 64),
            ('compose_sha256', 'bad'),
        )
        for name, value in cases:
            with self.subTest(name=name, value=str(value)[:32]):
                args = dict(evidence)
                phase = 'quiescent-copy-verified-restore-pending'
                if name == 'phase':
                    phase = value
                else:
                    args[name] = value
                with self.assertRaises(common.GateError):
                    common.atomic_status(self.stage, phase, **args)
                self.assertEqual(status.read_bytes(), original)
                self.assertFalse((self.stage / 'status.json.new').exists())
        self.assertTrue(common.stage_gate(self.stage, anchor=self.root,
                                           owner=os.geteuid(), data_uid=os.geteuid()))

    def test_status_seal_refuses_changed_initial_record_before_temp_creation(self):
        tree = common.inventory(self.data, source=True)
        original = (self.stage / 'status.json').read_bytes()
        for changed in (b'{"phase":"already-sealed","trusted":false}',
                        b'{"phase":"precopy-unverified","trusted":true}'):
            with self.subTest(changed=changed):
                put(self.stage / 'status.json', changed)
                with self.assertRaises(common.GateError):
                    common.atomic_status(self.stage, 'quiescent-copy-verified-restore-pending',
                                         source_tree=tree, copy_tree=tree, image=self.cfg.image,
                                         container_id=self.cfg.container_id,
                                         config_sha256=self.cfg.config_hash,
                                         compose_sha256=self.cfg.compose_hash)
                self.assertEqual((self.stage / 'status.json').read_bytes(), changed)
                self.assertFalse((self.stage / 'status.json.new').exists())
        put(self.stage / 'status.json', original)
        (self.stage / 'status.json').chmod(0o644)
        with self.assertRaises(common.GateError):
            common.atomic_status(self.stage, 'quiescent-copy-verified-restore-pending',
                                 source_tree=tree, copy_tree=tree, image=self.cfg.image,
                                 container_id=self.cfg.container_id,
                                 config_sha256=self.cfg.config_hash,
                                 compose_sha256=self.cfg.compose_hash)
        self.assertEqual((self.stage / 'status.json').read_bytes(), original)
        self.assertFalse((self.stage / 'status.json.new').exists())
        (self.stage / 'status.json').chmod(0o600)

    def test_status_seal_fsyncs_file_before_replace_then_directory(self):
        tree = common.inventory(self.data, source=True)
        fsync, replace = os.fsync, os.replace
        events = []

        def sync(fd):
            events.append('file' if stat.S_ISREG(os.fstat(fd).st_mode) else 'directory')
            return fsync(fd)

        def swap(src, dst):
            events.append('replace')
            return replace(src, dst)

        with patch.object(common.os, 'fsync', side_effect=sync), \
             patch.object(common.os, 'replace', side_effect=swap):
            common.atomic_status(self.stage, 'quiescent-copy-verified-restore-pending',
                                 source_tree=tree, copy_tree=tree, image=self.cfg.image,
                                 container_id=self.cfg.container_id,
                                 config_sha256=self.cfg.config_hash,
                                 compose_sha256=self.cfg.compose_hash)
        self.assertEqual(events, ['file', 'replace', 'directory'])
        self.assertFalse(common.read_json(self.stage / 'status.json')['trusted'])
        self.assertFalse((self.stage / 'status.json.new').exists())

    def test_status_seal_failure_occurs_only_after_service_recovery(self):
        original = (self.stage / 'status.json').read_bytes()
        def fail_seal(*args, **kwargs):
            self.assertEqual(self.ops.state, 'running')
            self.assertFalse(self.ops.timer)
            self.assertLess(self.ops.actions.index('healthy'), self.ops.actions.index('cancel'))
            raise common.GateError('synthetic seal failure')
        with patch.object(pause, 'atomic_status', side_effect=fail_seal):
            with self.assertRaises(common.GateError):
                pause.execute(self.ops, self.cfg, **self.kw)
        self.assertEqual((self.stage / 'status.json').read_bytes(), original)
        self.assertFalse((self.stage / 'status.json.new').exists())

    def move_stage(self, destination):
        destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.stage.rename(destination)
        self.stage = self.cfg.stage = destination

    def test_root_direct_stage_is_admitted_by_probe_and_execute(self):
        self.move_stage(self.root / 'root/cps-backup-prestage-synthetic')
        self.assertTrue(pause.probe(self.ops, self.cfg, **self.kw))
        self.assertTrue(pause.execute(self.ops, self.cfg, **self.kw))
        self.assertLess(self.ops.actions.index('arm'), self.ops.actions.index('pause'))
        self.assertFalse(common.read_json(self.stage / 'status.json')['trusted'])

    def test_root_stage_rejects_nonprivate_parent_before_arm(self):
        parent = self.root / 'root'
        self.move_stage(parent / 'cps-backup-prestage-synthetic')
        parent.chmod(0o755)
        with self.assertRaises(common.GateError):
            pause.execute(self.ops, self.cfg, **self.kw)
        self.assertNotIn('arm', self.ops.actions)

    def test_root_nested_stage_rejected_before_arm(self):
        self.move_stage(self.root / 'root/nested/cps-backup-prestage-synthetic')
        with self.assertRaises(common.GateError):
            pause.execute(self.ops, self.cfg, **self.kw)
        self.assertNotIn('arm', self.ops.actions)

    def test_live_project_stage_rejected_before_arm(self):
        self.move_stage(self.cfg.root / 'cps-backup-prestage-synthetic')
        with self.assertRaises(common.GateError):
            pause.execute(self.ops, self.cfg, **self.kw)
        self.assertNotIn('arm', self.ops.actions)

    def test_pre_pause_drift_no_pause(self):
        for path in (self.compose, self.data / 'config.json', self.root / 'opt/service/service.env'):
            with self.subTest(path=path.name):
                old = path.read_bytes()
                put(path, b'drift')
                with self.assertRaises(common.GateError):
                    pause.execute(self.ops, self.cfg, **self.kw)
                self.assertNotIn('pause', self.ops.actions)
                put(path, old)
                self.ops.actions.clear()

    def test_failures_recover_or_leave_timer(self):
        for failure in ('ambiguous', 'copy', 'mismatch', 'writer', 'deadline', 'unpause', 'health'):
            with self.subTest(failure=failure):
                self.ops.failure = failure
                now = [time.monotonic()]
                self.ops.advance = lambda s: now.__setitem__(0, now[0] + s)
                with self.assertRaises(common.GateError):
                    pause.execute(self.ops, self.cfg, **self.kw, clock=lambda: now[0])
                if failure in ('unpause', 'ambiguous'):
                    self.assertNotIn('cancel', self.ops.actions)
                    self.assertTrue(self.ops.timer)
                elif failure != 'health':
                    self.assertLess(self.ops.actions.index('healthy', self.ops.actions.index('unpause')),
                                    self.ops.actions.index('cancel'))
                self.assertEqual(common.read_json(self.stage / 'status.json'),
                                 {'phase': 'precopy-unverified', 'trusted': False})
                self.assertFalse((self.stage / 'status.json.new').exists())
                self.ops.failure = None
                self.ops.state = 'running'
                self.ops.timer = False
                self.ops.actions.clear()
                put(self.data / 'metadata.json', b'synthetic metadata.json')

    def test_writer_after_parity_scans_and_sidecar_checks_blocks_verification(self):
        gateway_loaded = self.ops.gateway_loaded
        calls = [0]

        def write_after_final_gateway_check():
            gateway_loaded()
            calls[0] += 1
            if calls[0] == 3:  # two probes, then post-copy sidecar/gateway checks
                put(self.data / 'logs/ordinary.jsonl', b'external writer after scans')

        self.ops.gateway_loaded = write_after_final_gateway_check
        with self.assertRaises(common.GateError):
            pause.execute(self.ops, self.cfg, **self.kw)
        self.assertEqual(calls[0], 3)
        self.assertIn('unpause', self.ops.actions)
        self.assertLess(self.ops.actions.index('unpause'), self.ops.actions.index('cancel'))
        self.assertEqual(self.ops.state, 'running')
        self.assertFalse(common.read_json(self.stage / 'status.json')['trusted'])
        self.assertNotEqual(common.inventory(self.data, source=True),
                            common.inventory(self.stage / 'data'))

    def test_post_arm_drift_recovers_without_pause(self):
        arm = self.ops.arm
        def drift_after_arm():
            result = arm()
            put(self.data / 'config.json', b'{"rawBodyLogging":true}')
            return result
        self.ops.arm = drift_after_arm
        with self.assertRaises(common.GateError):
            pause.execute(self.ops, self.cfg, **self.kw)
        self.assertNotIn('pause', self.ops.actions)
        self.assertLess(self.ops.actions.index('healthy', self.ops.actions.index('arm')),
                        self.ops.actions.index('cancel'))
        self.assertFalse(common.read_json(self.stage / 'status.json')['trusted'])

    def test_inactive_watchdog_blocks_pause(self):
        self.ops.failure = 'timer'
        with self.assertRaises(common.GateError):
            pause.execute(self.ops, self.cfg, **self.kw)
        self.assertNotIn('pause', self.ops.actions)
        self.assertEqual(self.ops.state, 'running')

    def test_watchdog_failure_immediately_after_second_probe_blocks_pause(self):
        original_probe = pause.probe
        original_check = self.ops.watchdog_active
        probes = [0]
        fail_next_check = [False]

        def probe_then_fail(*args, **kwargs):
            result = original_probe(*args, **kwargs)
            probes[0] += 1
            if probes[0] == 2:
                fail_next_check[0] = True
            return result

        def check(service, *, minimum=0):
            if fail_next_check[0]:
                fail_next_check[0] = False
                self.ops.actions.append('watchdog_active')
                self.assertEqual(minimum, pause.RESERVE)
                raise common.GateError('synthetic post-probe watchdog verification failure')
            return original_check(service, minimum=minimum)

        self.ops.watchdog_active = check
        with patch.object(pause, 'probe', side_effect=probe_then_fail), \
             self.assertRaises(common.GateError):
            pause.execute(self.ops, self.cfg, **self.kw)
        self.assertEqual(probes[0], 2)
        self.assertNotIn('pause', self.ops.actions)
        self.assertEqual(self.ops.state, 'running')
        self.assertFalse(common.read_json(self.stage / 'status.json')['trusted'])
        # No pause was attempted; a still-active, verified unit may be cancelled
        # only after health is checked in the no-op recovery branch.
        first_check = self.ops.actions.index('watchdog_active')
        failed_check = self.ops.actions.index('watchdog_active', first_check + 1)
        self.assertIn('healthy', self.ops.actions[failed_check + 1:self.ops.actions.index('cancel')])

    def test_ambiguous_pause_after_recheck_keeps_watchdog_armed(self):
        self.ops.failure = 'ambiguous'
        with self.assertRaises(common.GateError):
            pause.execute(self.ops, self.cfg, **self.kw)
        self.assertEqual(self.ops.actions[self.ops.actions.index('pause') - 1], 'watchdog_active')
        self.assertIn('unpause', self.ops.actions)
        self.assertNotIn('cancel', self.ops.actions)
        self.assertTrue(self.ops.timer)
        self.assertEqual(self.ops.state, 'running')

    def test_ambiguous_arm_does_not_pause_or_cancel(self):
        self.ops.failure = 'arm-timeout'
        with self.assertRaises(common.GateError):
            pause.execute(self.ops, self.cfg, **self.kw)
        self.assertNotIn('pause', self.ops.actions)
        self.assertNotIn('cancel', self.ops.actions)
        self.assertTrue(self.ops.timer)

    def docker_fixture(self):
        state = {'status': 'running', 'health': 'healthy', 'image': self.cfg.image,
                 'restarts': 0, 'mount': str(self.cfg.data), 'http': 200}
        calls = []
        def run(argv, timeout=15, max_output=8192):
            calls.append(argv)
            if argv == pause.META_GET:
                self.assertLessEqual(timeout, 3)
                self.assertEqual(max_output, 3)
                return str(state['http'])
            if argv[:2] == ['docker', 'inspect']:
                values = (self.cfg.container_id, '/' + pause.SERVICE, state['image'],
                          state['status'], state['health'], state['restarts'], False,
                          pause.MEMORY,
                          [{'Type': 'bind', 'Source': state['mount'],
                            'Destination': '/data', 'RW': True}],
                          {'com.docker.compose.service': pause.SERVICE})
                return ' '.join(json.dumps(v) for v in values)
            self.assertEqual(argv, ['docker', 'compose', '-f', str(self.cfg.compose),
                                    'ps', '-q', pause.SERVICE])
            return self.cfg.container_id
        return state, calls, run

    def test_paused_docker_unhealthy_or_starting_is_not_a_running_health_pass(self):
        state, _calls, run = self.docker_fixture()
        ops = pause.PauseOps(self.cfg, run)
        for health in ('unhealthy', 'starting', 'healthy'):
            state.update(status='paused', health=health)
            with self.subTest(health=health):
                self.assertEqual(ops.inspect(), (self.cfg.container_id, 'paused'))
        state['status'] = 'running'
        state['health'] = 'unhealthy'
        with self.assertRaises(common.GateError):
            ops.healthy()  # HTTP 200 cannot substitute for running Docker health.
        for health in ('unhealthy', 'starting', 'missing', None):
            state['health'] = health
            with self.subTest(running_health=health), self.assertRaises(common.GateError):
                ops.inspect()
        state.update(status='paused', health='unhealthy')
        for key, bad in (('image', 'sha256:' + 'c' * 64), ('restarts', 1),
                         ('mount', '/wrong')):
            original = state[key]
            state[key] = bad
            with self.subTest(fence=key), self.assertRaises(pause.IdentityDrift):
                ops.inspect()
            state[key] = original
        state.update(status='running', health='healthy')
        def failed_docker(argv, **kwargs):
            if argv[:2] == ['docker', 'inspect']:
                raise common.GateError('synthetic command unavailable')
            return run(argv, **kwargs)
        ops.run = failed_docker
        with self.assertRaises(common.GateError) as error:
            ops.inspect(recovering=True, deadline=ops.boot() + 3)
        self.assertNotIsInstance(error.exception, pause.IdentityDrift)

    def test_delayed_health_recovery_requires_both_http_and_docker_proof(self):
        state, calls, run = self.docker_fixture()
        now = [0.0]
        state['health'] = 'unhealthy'
        def advance(seconds):
            self.assertLessEqual(seconds, 1)
            now[0] += seconds
            if now[0] >= 31:
                state['health'] = 'healthy'
            if now[0] >= 34:
                state['http'] = 200
        state['http'] = 503
        ops = pause.PauseOps(self.cfg, run, boot=lambda: now[0], sleep=advance)
        ops.healthy(timeout=55)
        self.assertEqual(now[0], 34)
        self.assertGreaterEqual(len([c for c in calls if c[:2] == ['docker', 'inspect']]), 35)
        self.assertEqual(calls[-1][:2], ['docker', 'compose'])  # final strict reinspection

    def test_recovery_timeout_and_identity_ambiguity_keep_watchdog_armed(self):
        state, _calls, run = self.docker_fixture()
        now = [0.0]
        state['health'] = 'unhealthy'
        ops = pause.PauseOps(self.cfg, run, boot=lambda: now[0],
                             sleep=lambda seconds: now.__setitem__(0, now[0] + seconds))
        with self.assertRaises(common.GateError):
            ops.healthy(timeout=55)
        self.assertEqual(now[0], 55)
        now[0] = 0
        def drift(seconds):
            now[0] += seconds
            state['status'] = 'paused'
        ops.sleep = drift
        with self.assertRaises(common.GateError):
            ops.healthy(timeout=55)
        self.assertEqual(now[0], 1)  # no retry through ambiguous state
        state['status'] = 'running'
        now[0] = 0
        def slow_inspect(argv, timeout=15, max_output=8192):
            self.assertLessEqual(timeout, 3)
            result = run(argv, timeout=timeout, max_output=max_output)
            now[0] += timeout  # Docker commands consume the whole permitted slice.
            return result
        ops.run = slow_inspect
        with self.assertRaises(common.GateError):
            ops.healthy(timeout=5)
        self.assertLessEqual(now[0], 5)  # no HTTP or cancel beyond recovery deadline

        def never_recovers(*, timeout=0):
            if not timeout:
                return FakeOps.healthy(self.ops)
            self.assertTrue(self.ops.timer)
            self.assertLessEqual(timeout, 55)
            raise common.GateError('synthetic recovery timeout')
        self.ops.healthy = never_recovers
        with self.assertRaises(common.GateError):
            pause.execute(self.ops, self.cfg, **self.kw)
        self.assertIn('unpause', self.ops.actions)
        self.assertNotIn('cancel', self.ops.actions)
        self.assertTrue(self.ops.timer)
        self.assertFalse(common.read_json(self.stage / 'status.json')['trusted'])

    def test_curl_meta_is_fixed_bounded_and_requires_exact_status(self):
        self.assertEqual(pause.META_GET, [
            '/usr/bin/curl', '--disable', '--silent', '--max-time', '3',
            '--connect-timeout', '2', '--noproxy', '*', '-o', '/dev/null',
            '-w', '%{http_code}', '--url', 'http://127.0.0.1:3123/api/meta'])
        state, _calls, run = self.docker_fixture()
        def actual_run(argv, timeout=15, max_output=8192):
            if argv == pause.META_GET:
                return pause.command(argv, timeout=timeout, max_output=max_output)
            return run(argv, timeout=timeout, max_output=max_output)
        ops = pause.PauseOps(self.cfg, actual_run)
        for code, output, ok in ((0, b'200', True), (0, b'200\n', False),
                                 (0, b'302', False), (0, b'401', False),
                                 (1, b'200', False), (0, b'200200', False),
                                 (0, b'\xff', False)):
            with self.subTest(code=code, output=output):
                with patch.object(pause.subprocess, 'run', return_value=subprocess.CompletedProcess(
                        pause.META_GET, code, output, b'SYNTHETIC SECRET')) as call:
                    if ok:
                        ops.healthy()
                    else:
                        with self.assertRaises(common.GateError):
                            ops.healthy()
                call.assert_called_once_with(pause.META_GET, stdout=subprocess.PIPE,
                    stderr=subprocess.DEVNULL, timeout=3, check=False)
        self.assertEqual(state['status'], 'running')

    def test_trickling_http_response_cannot_extend_recovery_wall_deadline(self):
        state, _calls, run = self.docker_fixture()
        now = [0.0]
        def actual_run(argv, timeout=15, max_output=8192):
            if argv == pause.META_GET:
                return pause.command(argv, timeout=timeout, max_output=max_output)
            return run(argv, timeout=timeout, max_output=max_output)
        ops = pause.PauseOps(self.cfg, actual_run, boot=lambda: now[0],
                             sleep=lambda seconds: now.__setitem__(0, now[0] + seconds))
        tries = []
        def trickle(argv, **kwargs):
            self.assertEqual(argv, pause.META_GET)
            timeout = kwargs['timeout']
            self.assertLessEqual(timeout, 3)
            tries.append(timeout)
            now[0] += timeout  # bytes arrive periodically, but the process is killed at wall timeout
            raise subprocess.TimeoutExpired(argv, timeout, output=b'20SYNTHETIC SECRET')
        with patch.object(pause.subprocess, 'run', side_effect=trickle) as call:
            with self.assertRaises(common.GateError):
                ops.healthy(timeout=55)
        self.assertEqual(now[0], 55)
        self.assertGreater(len(tries), 1)
        self.assertEqual(len(tries), call.call_count)
        self.assertEqual(state['status'], 'running')

    def test_gateway_loaded_accepts_utf8_nginx_comment_without_logging(self):
        output = (f'# 配置校验\n# configuration file {self.gateway}:\n'
                  'server { listen 3123; }\n').encode('utf-8')
        with patch.object(pause.subprocess, 'run', return_value=subprocess.CompletedProcess(
                ['nginx', '-T'], 0, output, b'')) as run, redirect_stdout(io.StringIO()) as stdout:
            self.assertIsNone(pause.PauseOps(self.cfg).gateway_loaded())
        self.assertEqual(stdout.getvalue(), '')
        run.assert_called_once_with(['nginx', '-T'], stdout=subprocess.PIPE,
                                    stderr=subprocess.DEVNULL, timeout=15, check=False)

    def test_command_utf8_remains_strict_and_output_bounded(self):
        for output, limit in ((b'\xff', 8192), (b'x' * 8193, 8192),
                              (b'x' * (1024 * 1024 + 1), 1024 * 1024)):
            with self.subTest(length=len(output)):
                with patch.object(pause.subprocess, 'run', return_value=subprocess.CompletedProcess(
                        ['synthetic'], 0, output, b'')):
                    with self.assertRaises(common.GateError) as error:
                        pause.command(['synthetic'], max_output=limit)
                self.assertNotIn('synthetic', str(error.exception))

    def service_fixture(self):
        service = self.ops.cfg.container_id
        service = 'cps-backup-unpause-' + service + '.service'
        payload = ('ExecStart={ path=/usr/bin/python3 ; argv[]=/usr/bin/python3 '
                   + str(watchdog.SCRIPT) + ' --container-id ' + self.cfg.container_id
                   + ' ; ignore_errors=no }')
        state = {'text': ('LoadState=loaded\nActiveState=active\nSubState=running\n'
                          'MainPID=123\nType=exec\nRestart=always\nRestartUSec=1s\nUser=\n'
                          + payload + '\n')}
        def run(argv, timeout=15, max_output=8192):
            self.assertEqual(argv, ['systemctl', 'show', service,
                '--property=LoadState,ActiveState,SubState,MainPID,Type,Restart,RestartUSec,User,ExecStart'])
            return state['text']
        return service, state, run

    def test_exact_watchdog_unit_and_payload_verified_before_pause(self):
        service, state, run = self.service_fixture()
        ops = pause.PauseOps(self.cfg, run, boot=lambda: 1000)
        with patch.object(pause, 'read_state', return_value=1599_000_000_000):
            self.assertEqual(ops.watchdog_active(service, minimum=540), 599)
            ops.boot = lambda: 1060
            with self.assertRaises(common.GateError):
                ops.watchdog_active(service, minimum=540)
            with self.assertRaises(common.GateError):
                ops.watchdog_active('wrong.service', minimum=0)

    def test_watchdog_reserve_is_measured_after_systemd_query(self):
        service, _state, run = self.service_fixture()
        now = [1000]

        def delayed_run(*args, **kwargs):
            result = run(*args, **kwargs)
            now[0] = 1540  # 59 seconds remain after the systemd query.
            return result

        ops = pause.PauseOps(self.cfg, delayed_run, boot=lambda: now[0])
        with patch.object(pause, 'read_state', return_value=1599_000_000_000):
            with self.assertRaises(common.GateError):
                ops.watchdog_active(service, minimum=pause.RESERVE)

    def test_watchdog_fails_closed_on_ambiguous_service_payload(self):
        service, state, run = self.service_fixture()
        ops = pause.PauseOps(self.cfg, run, boot=lambda: 1000)
        expected = state['text']
        with patch.object(pause, 'read_state', return_value=1599_000_000_000):
            for bad in (expected.replace('Type=exec', 'Type=oneshot'),
                        expected.replace('Restart=always', 'Restart=no'),
                        expected.replace('RestartUSec=1s', 'RestartUSec=1min'),
                        expected.replace('MainPID=123', 'MainPID=0'),
                        expected.replace('User=', 'User=ubuntu'),
                        expected.replace('ActiveState=active', 'ActiveState=inactive'),
                        expected.replace(self.cfg.container_id, 'c' * 64),
                        expected.replace('python3', 'docker'),
                        expected.replace('ignore_errors=no', 'ignore_errors=yes'),
                        expected + 'ExecStart=another command\n'):
                with self.subTest(bad=bad[:50]):
                    state['text'] = bad
                    with self.assertRaises(common.GateError):
                        ops.watchdog_active(service, minimum=540)
            state['text'] = expected
            with patch.object(pause, 'read_state', side_effect=common.GateError('bad record')):
                with self.assertRaises(common.GateError):
                    ops.watchdog_active(service, minimum=540)

    def test_arm_creates_exclusive_state_before_starting_supervised_service(self):
        private_root = self.root / 'root'
        private_root.mkdir(mode=0o700)
        script = private_root / 'cps-backup-window-watchdog.py'
        put(script, b'# synthetic watchdog')
        record = watchdog.state_path(self.cfg.container_id, private_root)
        commands = []
        def run(argv, timeout=15, max_output=8192):
            commands.append(argv)
            if argv[0] == 'systemd-run':
                self.assertEqual(json.loads(record.read_text())['containerId'], self.cfg.container_id)
                self.assertEqual(stat.S_IMODE(record.stat().st_mode), 0o600)
                return ''
            return 'not-found\n'
        original_stat = os.stat
        def stat_binary(path, *args, **kwargs):
            if path in ('/usr/bin/docker', '/usr/bin/python3'):
                return original_stat(sys.executable)
            return original_stat(path, *args, **kwargs)
        ops = pause.PauseOps(self.cfg, run, owner=os.geteuid(), anchor=self.root)
        with patch.object(pause, 'WATCHDOG_SCRIPT', script), \
             patch.object(pause, 'state_path', lambda ident: watchdog.state_path(ident, private_root)), \
             patch.object(pause, 'boot_id', return_value='12345678-1234-1234-1234-123456789abc'), \
             patch.object(pause.os, 'stat', side_effect=stat_binary), \
             patch.object(pause.os, 'access', return_value=True):
            self.assertEqual(ops.arm(), ops.unit())
            self.assertEqual(commands[-1], ['systemd-run',
                '--unit=cps-backup-unpause-' + self.cfg.container_id,
                '--property=Type=exec', '--property=Restart=always',
                '--property=RestartSec=1s', '/usr/bin/python3', str(script),
                '--container-id', self.cfg.container_id])
            with self.assertRaises(common.GateError):
                ops.arm()  # existing record/unit cannot be silently reused
        self.assertEqual(len([c for c in commands if c[0] == 'systemd-run']), 1)

    def test_late_pause_after_deadline_and_restart_retries_same_id(self):
        ident = self.cfg.container_id
        state = {'status': 'running', 'unpauses': 0, 'attempts': []}
        def run(argv, **kwargs):
            state['attempts'].append(argv)
            if argv[1] == 'inspect':
                output = (json.dumps(ident) + ' ' + json.dumps(state['status'])).encode()
                return subprocess.CompletedProcess(argv, 0, output)
            self.assertEqual(argv, ['/usr/bin/docker', 'unpause', ident])
            state['status'] = 'running'
            state['unpauses'] += 1
            return subprocess.CompletedProcess(argv, 0, b'')
        deadline = 1_000_000_000
        watchdog.tick(ident, deadline, clock=lambda: deadline - 1, run=run)
        self.assertFalse(state['attempts'])
        watchdog.tick(ident, deadline, clock=lambda: deadline + 1, run=run)
        self.assertEqual(state['unpauses'], 0)  # first firing sees running
        state['status'] = 'paused'  # delayed Docker pause arrives AFTER deadline
        watchdog.tick(ident, deadline, clock=lambda: deadline + 2, run=run)
        self.assertEqual(state['unpauses'], 1)
        # A late, unrelated ID must never receive an unpause even if inspect lies.
        def wrong_id(argv, **kwargs):
            return subprocess.CompletedProcess(argv, 0,
                (json.dumps('c' * 64) + ' "paused"').encode())
        with self.assertRaises(watchdog.GateError):
            watchdog.tick(ident, deadline, clock=lambda: deadline + 2, run=wrong_id)
        state['status'] = 'paused'  # process crash / systemd restart; same record
        private_root = self.root / 'root'
        private_root.mkdir(mode=0o700)
        record = watchdog.state_path(ident, private_root)
        put(record, json.dumps({'containerId': ident, 'bootId': '12345678-1234-1234-1234-123456789abc',
                                'deadlineNs': deadline}).encode())
        def stop(_):
            raise InterruptedError('synthetic service restart boundary')
        with patch.object(watchdog, 'boot_id', return_value='12345678-1234-1234-1234-123456789abc'):
            def crash(_argv, **_kwargs):
                raise RuntimeError('synthetic process crash; systemd restart required')
            with self.assertRaises(RuntimeError):
                watchdog.supervise(ident, root=private_root, owner=os.geteuid(),
                                   clock=lambda: deadline + 3, run=crash, sleep=stop)
            self.assertEqual(state['unpauses'], 1)
            with self.assertRaises(InterruptedError):
                watchdog.supervise(ident, root=private_root, owner=os.geteuid(),
                                   clock=lambda: deadline + 3, run=run, sleep=stop)
        self.assertEqual(state['unpauses'], 2)
        self.assertTrue(all(cmd[-1] == ident for cmd in state['attempts']))
        with self.assertRaises(watchdog.GateError):
            watchdog.read_state(record, 'c' * 64, root=private_root, owner=os.geteuid())


if __name__ == '__main__':
    unittest.main()
