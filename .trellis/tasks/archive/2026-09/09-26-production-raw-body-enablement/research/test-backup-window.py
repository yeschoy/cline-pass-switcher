#!/usr/bin/env python3
"""Focused synthetic safety contracts for the pause-only backup helpers."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import backup_pause_window as pause
import backup_window_common as common


class CommonTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='cps-tree-synthetic-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.root.chmod(0o700)
        self.stage = self.root / 'stage'
        (self.stage / 'sidecars-complete').mkdir(parents=True, mode=0o700)
        self.stage.chmod(0o700)
        (self.stage / 'data').mkdir(mode=0o700)
        (self.stage / 'status.json').write_text('{"phase":"precopy-unverified","trusted":false}')
        (self.stage / 'status.json').chmod(0o600)

    def test_private_parent_owner_and_symlink_fail(self):
        self.assertTrue(common.stage_gate(self.stage, anchor=self.root,
                                          owner=os.geteuid(), data_uid=os.geteuid()))
        self.stage.chmod(0o770)
        with self.assertRaises(common.GateError):
            common.stage_gate(self.stage, anchor=self.root,
                              owner=os.geteuid(), data_uid=os.geteuid())
        self.stage.chmod(0o700)
        fake = self.root / 'alias'
        fake.symlink_to(self.stage)
        with self.assertRaises(common.GateError):
            common.stage_gate(fake, anchor=self.root, owner=os.geteuid(), data_uid=os.geteuid())

    def test_root_like_stage_keeps_full_ancestry_gate(self):
        private_root = self.root / 'root'
        private_root.mkdir(mode=0o700)
        direct = private_root / 'cps-backup-prestage-synthetic'
        self.stage.rename(direct)
        self.assertTrue(common.stage_gate(direct, anchor=self.root,
                                          owner=os.geteuid(), data_uid=os.geteuid()))
        self.assertIsNone(common.private_path(private_root, anchor=self.root,
                                              owner=os.geteuid(), final_mode=0o700))
        private_root.chmod(0o755)
        with self.assertRaises(common.GateError):
            common.private_path(private_root, anchor=self.root,
                                owner=os.geteuid(), final_mode=0o700)
        private_root.chmod(0o770)
        with self.assertRaises(common.GateError):
            common.stage_gate(direct, anchor=self.root,
                              owner=os.geteuid(), data_uid=os.geteuid())
        private_root.chmod(0o700)
        alias = self.root / 'root-alias'
        alias.symlink_to(private_root, target_is_directory=True)
        with self.assertRaises(common.GateError):
            common.stage_gate(alias / direct.name, anchor=self.root,
                              owner=os.geteuid(), data_uid=os.geteuid())

    def test_framed_tree_and_raw_exclusion(self):
        src, dst = self.stage / 'source', self.stage / 'copy'
        src.mkdir(mode=0o700)
        dst.mkdir(mode=0o700)
        (src / 'detailed-logs/raw').mkdir(parents=True, mode=0o700)
        (src / 'detailed-logs').chmod(0o700)
        (dst / 'detailed-logs').mkdir(mode=0o700)
        for tree in (src, dst):
            (tree / 'a').write_bytes(b'abc')
            (tree / 'b').write_bytes(b'd')
        (src / 'detailed-logs/raw/secret').write_bytes(b'SYNTHETIC SECRET')
        self.assertEqual(common.inventory(src, source=True), common.inventory(dst))
        (dst / 'a').write_bytes(b'ab')
        (dst / 'b').write_bytes(b'cd')
        self.assertNotEqual(common.inventory(src, source=True), common.inventory(dst))
        (dst / 'detailed-logs/raw').mkdir()
        with self.assertRaises(common.GateError):
            common.inventory(dst)
        (dst / 'detailed-logs/raw').rmdir()
        (dst / 'link').symlink_to('a')
        with self.assertRaises(common.GateError):
            common.inventory(dst)

    def test_compose_authority_rejects_ambiguous_env(self):
        service = self.root / 'service'
        service.mkdir(mode=0o700)
        env = service / 'service.env'
        env.write_bytes(b'SYNTHETIC')
        compose = service / 'compose.yml'
        nested = service / 'private'
        nested.mkdir(mode=0o700)
        nested_env = nested / 'nested.env'
        nested_env.write_bytes(b'SYNTHETIC')
        for literal, expected in (('./service.env', env), ('service.env', env),
                                  (str(env), env), ('./private/nested.env', nested_env),
                                  (str(nested_env), nested_env)):
            compose.write_text('services:\n  cline-pass-console:\n    env_file:\n'
                               f'      - {literal}\n')
            self.assertEqual(common.compose_env_source(compose, 'cline-pass-console', service),
                             expected)
        compose.write_text('services:\n  cline-pass-console:\n    env_file:\n'
                           '      - ./service.env\n\n      # end of env list\n'
                           '    image: synthetic\n')
        self.assertEqual(common.compose_env_source(compose, 'cline-pass-console', service), env)
        for body in ('services:\n  cline-pass-console:\n    env_file: ./service.env\n',
                     'services:\n  cline-pass-console:\n    env_file:\n      - ../outside.env\n',
                     'services:\n  cline-pass-console:\n    env_file:\n      - ./service.env\n      - ./second.env\n',
                     'services:\n  cline-pass-console:\n    env_file:\n      - ./service.env\n\n      # another entry follows\n      - ./second.env\n',
                     'services:\n  cline-pass-console:\n    env_file:\n      - ./service.env\n      # comment\n      - ./second.env\n    image: synthetic\n',
                     f'services:\n  cline-pass-console:\n    env_file:\n      - {env}\n      - ./second.env\n',
                     'services:\n  cline-pass-console:\n    env_file:\n      - ${ENV_PATH}\n'):
            compose.write_text(body)
            with self.assertRaises(common.GateError):
                common.compose_env_source(compose, 'cline-pass-console', service)

    def test_compose_env_path_rejects_escape_and_symlinks(self):
        service = self.root / 'service'
        service.mkdir(mode=0o700)
        env = service / 'service.env'
        env.write_bytes(b'SYNTHETIC')
        compose = service / 'compose.yml'
        outside = self.root / 'outside.env'
        outside.write_bytes(b'SYNTHETIC')
        sibling = self.root / 'service-other'
        sibling.mkdir(mode=0o700)
        (sibling / 'service.env').write_bytes(b'SYNTHETIC')
        (service / 'linked.env').symlink_to(env)
        (service / 'linked-dir').symlink_to(service, target_is_directory=True)
        cases = (str(outside), str(sibling / 'service.env'),
                 str(service / '..' / 'outside.env'), '../outside.env',
                 './linked.env', './linked-dir/service.env')
        for literal in cases:
            with self.subTest(kind='unsafe env path', literal=literal):
                compose.write_text('services:\n  cline-pass-console:\n    env_file:\n'
                                   f'      - {literal}\n')
                with self.assertRaises(common.GateError):
                    common.compose_env_source(compose, 'cline-pass-console', service)
        alias = self.root / 'service-alias'
        alias.symlink_to(service, target_is_directory=True)
        compose.write_text('services:\n  cline-pass-console:\n    env_file:\n'
                           f'      - {alias}/service.env\n')
        with self.assertRaises(common.GateError):
            common.compose_env_source(compose, 'cline-pass-console', alias)

    def test_no_legacy_stop_start_entrypoint(self):
        base = Path(__file__).parent
        for script in ('backup_window.py', 'backup_window_watchdog.py'):
            result = subprocess.run([sys.executable, str(base / script)],
                                    capture_output=True, timeout=3)
            self.assertNotEqual(result.returncode, 0)
        source = (base / 'backup_pause_window.py').read_text()
        self.assertNotIn("['docker', 'stop'", source)
        self.assertNotIn("['docker', 'start'", source)
        self.assertNotIn("'compose', 'start'", source)

    def test_timer_not_armed_on_bad_cli_hash_or_path(self):
        args = ['--execute', '--ack-backup-only-window', '--stage', 'relative',
                '--compose-sha256', 'bad', '--config-sha256', '0' * 64,
                '--image', 'sha256:' + '1' * 64, '--container-id', '2' * 64,
                '--gateway', '/etc/nginx/sites-enabled/synthetic']
        with self.assertRaises(common.GateError):
            pause.parse(args)
        args[args.index('bad')] = '0' * 64
        with self.assertRaises(common.GateError):
            pause.parse(args)

    def test_command_never_prints_subprocess_stderr(self):
        with patch.object(pause.subprocess, 'run', return_value=subprocess.CompletedProcess(
                [], 1, b'SYNTHETIC SECRET', b'SYNTHETIC SECRET')):
            with self.assertRaises(common.GateError) as error:
                pause.command(['synthetic'])
            self.assertNotIn('SYNTHETIC', str(error.exception))


if __name__ == '__main__':
    unittest.main()
