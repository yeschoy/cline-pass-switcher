#!/usr/bin/env python3
"""Only disposable synthetic paths and mock Docker: never contact production."""
from contextlib import redirect_stderr, redirect_stdout
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import code_cutover_backup as cut
from backup_window_common import GateError, inventory, sha

CID = '1' * 64


class RunTests(unittest.TestCase):
    def test_bounded_stdout_and_zero_output(self):
        child = [sys.executable, '-c', 'import os; os.write(1, b"safe")']
        self.assertEqual(cut.run(child, timeout=2, max_output=4), 'safe')
        self.assertEqual(cut.run([sys.executable, '-c', 'pass'], timeout=2,
                                 max_output=0), '')
        with self.assertRaisesRegex(GateError, '^external command failed$'):
            cut.run(child, timeout=2, max_output=0)

    def test_overflow_reads_at_most_cap_plus_one_kills_and_reaps(self):
        children, reads = [], []
        real_popen, real_read = subprocess.Popen, os.read

        def spawn(*args, **kwargs):
            child = real_popen(*args, **kwargs)
            children.append(child)
            return child

        def measured_read(fd, limit):
            chunk = real_read(fd, limit)
            if children and fd == children[-1].stdout.fileno():
                reads.append((limit, len(chunk)))
            return chunk

        script = ('import os; os.write(2, b"SYNTHETIC_PRIVATE_TOKEN"); '
                  'os.write(1, b"SYNTHETIC_PRIVATE_TOKEN"); '
                  '[(os.write(1, b"x" * 65536)) for _ in range(128)]')
        stdout, stderr = io.StringIO(), io.StringIO()
        with patch.object(cut.subprocess, 'Popen', side_effect=spawn), \
             patch.object(cut.os, 'read', side_effect=measured_read), \
             redirect_stdout(stdout), redirect_stderr(stderr):
            with self.assertRaisesRegex(GateError, '^external command failed$') as error:
                cut.run([sys.executable, '-c', script], timeout=2, max_output=64)
        self.assertEqual(len(children), 1)
        self.assertIsNotNone(children[0].returncode)
        self.assertTrue(reads)
        self.assertLessEqual(sum(n for _, n in reads), 65)
        self.assertTrue(all(n <= limit <= 65 for limit, n in reads))
        self.assertNotIn('SYNTHETIC_PRIVATE_TOKEN',
                         str(error.exception) + stdout.getvalue() + stderr.getvalue())

    def test_timeout_kills_and_reaps_without_printing_private_output(self):
        real_popen = subprocess.Popen
        for close_stdout in (False, True):
            with self.subTest(close_stdout=close_stdout):
                children = []

                def spawn(*args, **kwargs):
                    child = real_popen(*args, **kwargs)
                    children.append(child)
                    return child

                script = ('import os, time; os.write(1, b"SYNTHETIC_PRIVATE_TOKEN"); '
                          'os.write(2, b"SYNTHETIC_PRIVATE_TOKEN"); ' +
                          ('os.close(1); ' if close_stdout else '') + 'time.sleep(5)')
                stdout, stderr = io.StringIO(), io.StringIO()
                start = time.monotonic()
                with patch.object(cut.subprocess, 'Popen', side_effect=spawn), \
                     redirect_stdout(stdout), redirect_stderr(stderr):
                    with self.assertRaisesRegex(GateError, '^external command failed$') as error:
                        cut.run([sys.executable, '-c', script], timeout=0.2, max_output=64)
                self.assertLess(time.monotonic() - start, 2)
                self.assertEqual(len(children), 1)
                self.assertIsNotNone(children[0].returncode)
                self.assertNotIn('SYNTHETIC_PRIVATE_TOKEN',
                                 str(error.exception) + stdout.getvalue() + stderr.getvalue())


class FakeStat:
    def __init__(self, original, uid):
        self.original, self.st_uid = original, uid

    def __getattr__(self, name):
        return getattr(self.original, name)


class FakeDocker:
    def __init__(self):
        self.state = 'exited'
        self.copy_count = 0
        self.mutate = None

    def inspect(self, stopped=False):
        if self.state != ('exited' if stopped else 'running'):
            raise GateError('synthetic stop failed')
        return CID

    def copy(self, src, dest):
        self.copy_count += 1
        def ignore(parent, entries):
            return {'raw'} if Path(parent).name == 'detailed-logs' else set()
        shutil.copytree(src, dest, dirs_exist_ok=True, ignore=ignore, copy_function=shutil.copy2)
        if self.mutate:
            self.mutate(self.copy_count)


class BackupTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory(prefix='cps-code-backup-synthetic-')
        self.addCleanup(tmp.cleanup)
        self.anchor = Path(tmp.name).resolve()
        self.anchor.chmod(0o700)
        self.uid = os.geteuid()
        self.root = self.anchor / 'service'
        self.root.mkdir(mode=0o750)
        data = self.root / 'data'
        data.mkdir(mode=0o700)
        (data / 'config.json').write_text(json.dumps({
            'rawBodyLogging': False, 'accounts': [{'id': str(i)} for i in range(32)]}))
        (data / 'metadata.json').write_text('{}')
        (data / 'admin-auth.json').write_text('{}')
        logs = data / 'detailed-logs'
        logs.mkdir(mode=0o700)
        (logs / 'raw').mkdir(mode=0o700)
        (data / 'logs').mkdir(mode=0o700)
        (data / 'logs' / 'request.jsonl').write_text('synthetic row\n')
        (self.root / 'service.env').write_text('FAKE=synthetic\n')
        compose = self.root / 'compose.yml'
        compose.write_text('services:\n  cline-pass-console:\n    env_file:\n'
                           '      - ./service.env\n    image: synthetic\n')
        (self.root / 'deployment.json').write_text('{}')
        release = self.root / 'releases' / cut.RELEASE
        release.mkdir(parents=True, mode=0o755)
        release.parent.chmod(0o700)
        repo = Path(__file__).resolve().parents[4]
        for name in cut.SOURCE:
            dest = release / name
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.parent.chmod(0o755)
            dest.write_bytes(subprocess.check_output(['git', '-C', str(repo), 'show',
                                                     cut.COMMIT + ':' + name]))
            dest.chmod(0o644)
        nginx = self.anchor / 'nginx'
        (nginx / 'conf.d').mkdir(parents=True, mode=0o700)
        target = self.root / cut.GATEWAY_TARGET_REL
        target.parent.mkdir(parents=True, mode=0o700)
        target.write_text('synthetic gateway\n')
        self.gateway = nginx / 'conf.d' / 'cps-admin-gateway.conf'
        self.gateway.symlink_to(target)
        self.nginx_text = '# configuration file ' + str(self.gateway) + ':\nsynthetic gateway\n'
        self.real_run = cut.run
        self.nginx_run = patch.object(cut, 'run', side_effect=self.nginx_command)
        self.nginx_run.start()
        self.addCleanup(self.nginx_run.stop)
        for path in [compose, self.root / 'service.env', self.root / 'deployment.json', target]:
            path.chmod(0o600)
        parent = self.anchor / 'root'
        parent.mkdir(mode=0o700)
        self.stage = parent / ('cps-code-v1-' + 'a' * 16)
        self.cfg = SimpleNamespace(
            root=self.root, nginx_root=nginx, gateway=self.gateway, stage=self.stage,
            release=release,
            container_id=CID, compose_hash=sha(compose),
            config_hash=sha(data / 'config.json'),
            metadata_hash=sha(data / 'metadata.json'),
            admin_hash=sha(data / 'admin-auth.json'),
            sidecar_hashes={'compose.yml': sha(compose),
                            'service.env': sha(self.root / 'service.env'),
                            'deployment.json': sha(self.root / 'deployment.json'),
                            'gateway.conf': sha(target)})
        self.docker = FakeDocker()

    def nginx_command(self, argv, **kwargs):
        self.assertEqual(argv, ['nginx', '-T'])
        self.assertEqual(kwargs, {'timeout': 15, 'max_output': 1024 * 1024})
        return self.nginx_text

    def backup(self):
        return cut.stopped_backup(self.cfg, self.docker, anchor=self.anchor,
                                  owner=self.uid, uid=self.uid)

    def test_stopped_backup_and_restore_parity_remains_untrusted(self):
        self.assertTrue(self.backup())
        self.assertEqual(cut.read_json(self.stage / 'status.json'),
                         {'phase': 'copy-verified-boot-pending', 'trusted': False})
        self.assertEqual(inventory(self.root / 'data', source=True),
                         inventory(self.stage / 'data'))
        self.assertEqual(inventory(self.stage / 'data'),
                         inventory(self.stage / 'restored-v1'))
        self.assertFalse((self.stage / 'data' / 'detailed-logs' / 'raw').exists())
        self.assertEqual(self.docker.copy_count, 2)
        with self.assertRaises(GateError):
            self.backup()  # never reuse a prior seal after resuming writes

    def test_failed_or_ambiguous_stop_is_noop(self):
        self.docker.state = 'running'
        with self.assertRaises(GateError):
            self.backup()
        self.assertFalse(self.stage.exists())
        self.assertEqual(self.docker.copy_count, 0)
        self.docker.state = 'unknown'
        with self.assertRaises(GateError):
            self.backup()
        self.assertFalse(self.stage.exists())

    def test_backup_drift_stays_untrusted_and_never_restores_live(self):
        original = (self.root / 'data' / 'logs' / 'request.jsonl').read_bytes()
        self.docker.mutate = lambda n: (self.root / 'data' / 'logs' / 'request.jsonl').write_text(
            'new synthetic external write') if n == 1 else None
        with self.assertRaises(GateError):
            self.backup()
        self.assertEqual(cut.read_json(self.stage / 'status.json'),
                         {'phase': 'stopped-copy-pending', 'trusted': False})
        self.assertNotEqual((self.root / 'data' / 'logs' / 'request.jsonl').read_bytes(), original)
        self.assertFalse((self.stage / 'restored-v1').exists())

    def test_compose_and_sidecar_drift_noop(self):
        (self.root / 'compose.yml').write_text('unexpected compose change\n')
        with self.assertRaises(GateError):
            self.backup()
        self.assertFalse(self.stage.exists())
        self.assertEqual(self.docker.copy_count, 0)

    def test_gateway_link_target_drift_noop(self):
        # Another root-owned regular file with identical bytes/hash is not the authority.
        other = self.root / 'deployments' / 'elsewhere.conf'
        other.write_bytes((self.root / cut.GATEWAY_TARGET_REL).read_bytes())
        other.chmod(0o600)
        for link in (str(other), os.path.relpath(self.root / cut.GATEWAY_TARGET_REL,
                                                self.gateway.parent)):
            with self.subTest(link=link):
                self.gateway.unlink()
                self.gateway.symlink_to(link)
                with self.assertRaises(GateError):
                    self.backup()
                self.assertFalse(self.stage.exists())
                self.assertEqual(self.docker.copy_count, 0)

    def test_gateway_path_hash_and_loaded_config_noop(self):
        original = self.gateway
        other = original.parent / 'other.conf'
        original.rename(other)
        self.cfg.gateway = other
        with self.assertRaises(GateError):
            self.backup()
        self.cfg.gateway = original
        other.rename(original)
        target = self.root / cut.GATEWAY_TARGET_REL
        target.write_text('different but still synthetic\n')
        with self.assertRaises(GateError):
            self.backup()
        target.write_text('synthetic gateway\n')
        for dump in ('', '# configuration file ' + str(original) + ':\nother\n',
                     self.nginx_text + self.nginx_text):
            self.nginx_text = dump
            with self.assertRaises(GateError):
                self.backup()
            self.assertFalse(self.stage.exists())
            self.assertEqual(self.docker.copy_count, 0)

    def test_stale_initial_seal_and_interrupted_phase_block(self):
        self.stage.mkdir(mode=0o700)
        with self.assertRaises(GateError):
            self.backup()
        self.stage.rmdir()
        self.backup()
        with self.assertRaises(GateError):
            cut.phase(self.stage, 'copy-verified-boot-pending')
        (self.stage / 'status.json.new').write_text('interrupted')
        with self.assertRaises(GateError):
            cut.phase(self.stage, 'copy-verified-boot-pending')

    def test_uid1000_owned_stage_parent_refused(self):
        # A service-owned rollback parent is not root-private even when child mode is 0700.
        self.stage = self.root / ('cps-code-v1-' + 'a' * 16)
        self.cfg.stage = self.stage
        with self.assertRaises(GateError):
            self.backup()
        self.assertFalse(self.stage.exists())
        self.cfg.stage = self.anchor / 'root' / ('cps-code-v1-' + 'a' * 16)
        (self.anchor / 'root').chmod(0o770)
        with self.assertRaises(GateError):
            self.backup()
        self.assertFalse(self.cfg.stage.exists())

    def test_v2_owner_state_refused_before_stage(self):
        config = self.root / 'data' / 'config.json'
        state = json.loads(config.read_text())
        state['clientKeys'] = []
        for account in state['accounts']:
            account['clientKeyId'] = 'legacy'
        config.write_text(json.dumps(state))
        self.cfg.config_hash = sha(config)  # matching bytes alone do not make old-on-v2 safe
        with self.assertRaises(GateError):
            self.backup()
        self.assertFalse(self.stage.exists())

    def test_committed_source_provenance_and_tree_gate(self):
        repo = Path(__file__).resolve().parents[4]
        for name, digest in cut.SOURCE.items():
            content = subprocess.check_output(['git', '-C', str(repo), 'show',
                                               cut.COMMIT + ':' + name])
            self.assertEqual(hashlib.sha256(content).hexdigest(), digest)
        release = self.anchor / 'release'
        release.mkdir(mode=0o755)
        (release / 'server.js').write_text('synthetic')
        (release / 'server.js').chmod(0o644)
        cut.release_gate(release, {'server.js': sha(release / 'server.js')}, owner=self.uid)
        (release / 'server.js').write_text('changed')
        with self.assertRaises(GateError):
            cut.release_gate(release, {'server.js': cut.SOURCE['server.js']}, owner=self.uid)
        (release / 'server.js').unlink()
        (release / 'server.js').symlink_to(self.root / 'compose.yml')
        with self.assertRaises(GateError):
            cut.release_gate(release, {'server.js': sha(self.root / 'compose.yml')}, owner=self.uid)

    def test_source_owner_mode_path_gates_before_stage(self):
        self.assertEqual(cut.source_gates(self.cfg, self.docker, stopped=True, anchor=self.anchor,
                                          owner=self.uid, uid=self.uid)['gateway.conf'],
                         self.root / cut.GATEWAY_TARGET_REL)
        for path in (self.root, self.cfg.release.parent, self.cfg.release,
                     self.cfg.release / 'lib', self.cfg.release / 'server.js',
                     self.cfg.release / 'public/index.html',
                     self.cfg.release / 'lib/raw-detail-headers.js'):
            with self.subTest(path=path):
                real_lstat = Path.lstat
                def changed(p, *args, **kwargs):
                    info = real_lstat(p, *args, **kwargs)
                    if p == path:
                        return FakeStat(info, info.st_uid + 1)
                    return info
                with patch.object(Path, 'lstat', changed):
                    with self.assertRaises(GateError):
                        self.backup()
                self.assertFalse(self.stage.exists())
                self.assertEqual(self.docker.copy_count, 0)
        for path, mode in ((self.root, 0o755), (self.cfg.release.parent, 0o755),
                           (self.cfg.release, 0o700),
                           (self.cfg.release / 'server.js', 0o600)):
            original = path.stat().st_mode & 0o777
            path.chmod(mode)
            with self.assertRaises(GateError):
                self.backup()
            path.chmod(original)
            self.assertFalse(self.stage.exists())

    def test_nginx_dump_private_and_cli_gateway_authority(self):
        secret = b'SYNTHETIC_PRIVATE_TOKEN'
        with redirect_stdout(io.StringIO()) as stdout, redirect_stderr(io.StringIO()) as stderr:
            with self.assertRaises(GateError) as error:
                self.real_run([sys.executable, '-c',
                               'import os; os.write(1, b"SYNTHETIC_PRIVATE_TOKEN"); '
                               'os.write(2, b"SYNTHETIC_PRIVATE_TOKEN"); '
                               'raise SystemExit(1)'], timeout=2, max_output=1024 * 1024)
        self.assertNotIn(secret.decode(), str(error.exception) + stdout.getvalue() +
                         stderr.getvalue())
        args = ['--preflight', '--container-id', CID, '--gateway',
                str(self.anchor / 'nginx/conf.d/cps-admin-gateway.conf')]
        for key in ('compose', 'config', 'metadata', 'admin', 'env', 'gateway', 'deployment'):
            args.extend(['--' + key + '-sha256', 'a' * 64])
        with self.assertRaises(GateError):
            cut.parse(args)  # no arbitrary gateway even with a supplied full hash
        args[args.index('--gateway') + 1] = str(cut.GATEWAY_LOGICAL)
        self.assertEqual(cut.parse(args).gateway, cut.GATEWAY_LOGICAL)

    def test_release_location_inventory_noop(self):
        self.cfg.release = self.cfg.release.parent / 'other'
        with self.assertRaises(GateError):
            self.backup()
        self.assertFalse(self.stage.exists())

    def test_raw_group_refused_before_stage(self):
        (self.root / 'data' / 'detailed-logs' / 'raw' / 'synthetic').write_text('no raw')
        with self.assertRaises(GateError):
            self.backup()
        self.assertFalse(self.stage.exists())

    def test_docker_identity_and_candidate_image_gate(self):
        def responder(argv, **_kwargs):
            if '{{json .Config.Env}}' in argv:
                return json.dumps(['FAKE=synthetic'])
            if argv[:2] == ['docker', 'inspect']:
                vals = (CID, '/cline-pass-console', cut.OLD, 'running', 'healthy', 0,
                        False, cut.MEMORY,
                        [{'Type': 'bind', 'Source': str(self.root / 'data'),
                          'Destination': '/data', 'RW': True}],
                        {'com.docker.compose.service': cut.SERVICE})
                return ' '.join(json.dumps(x) for x in vals)
            if 'ps' in argv:
                return CID
            if 'image' in argv:
                return json.dumps(cut.NEW)
            raise AssertionError('unexpected command')
        docker = cut.Docker(self.cfg, command=responder)
        self.assertEqual(docker.inspect(), CID)
        with self.assertRaises(GateError):
            docker.inspect(stopped=True)
        def wrong_image(argv, **kwargs):
            return json.dumps(cut.OLD) if 'image' in argv else responder(argv, **kwargs)
        with self.assertRaises(GateError):
            cut.Docker(self.cfg, command=wrong_image).inspect()
        def ready(argv, **kwargs):
            return json.dumps(['CLINE_PASS_RAW_BODY_READY=1']) if \
                '{{json .Config.Env}}' in argv else responder(argv, **kwargs)
        with self.assertRaises(GateError):
            cut.Docker(self.cfg, command=ready).inspect()

    def test_ambiguous_up_has_no_automatic_old_on_v2_path(self):
        # This scoped helper intentionally has NO up/start/rollback method.
        # The existing transaction can be called only after an independent v2 seal.
        self.assertFalse(hasattr(self.docker, 'up'))
        self.assertFalse(hasattr(self.docker, 'start'))
        self.assertFalse(hasattr(cut, 'rollback'))
        source = Path(cut.__file__).read_text()
        self.assertNotIn("'up', '-d'", source)
        self.assertNotIn("'start',", source)


if __name__ == '__main__':
    unittest.main()
