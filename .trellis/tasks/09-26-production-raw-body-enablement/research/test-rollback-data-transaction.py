#!/usr/bin/env python3
"""Local synthetic-only active-path transaction tests; never touch production."""
import json
import os
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch

import rollback_data_transaction as tx
from backup_window_common import GateError, sha

CID = '1' * 64
IMAGE = 'sha256:' + '2' * 64


class TransactionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='cps-rollback-synthetic-')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.root.chmod(0o700)
        self.owner = os.geteuid()
        self.service = self.root / 'service'
        self.service.mkdir(mode=0o700)
        self.active = self.service / 'data'
        self.active.mkdir(mode=0o700)
        self._fixture(self.active, 'v2')
        (self.active / 'detailed-logs' / 'raw').mkdir(parents=True, mode=0o700)
        (self.active / 'detailed-logs').chmod(0o700)
        self.stage = self.root / ('cps-rollback-data-' + 'a' * 16)
        self.stage.mkdir(mode=0o700)
        marker = self.stage / tx.MARKER
        marker.write_bytes(tx.MARKER_BYTES)
        marker.chmod(0o600)
        self.sealed_v1 = self.root / 'backup' / 'data'
        self.sealed_v1.parent.mkdir(mode=0o700)
        self.sealed_v1.mkdir(mode=0o700)
        self._fixture(self.sealed_v1, 'v1')
        shutil.copytree(self.sealed_v1, self.stage / 'prepared-v1')
        (self.stage / 'prepared-v1').chmod(0o700)
        self.sealed_v2 = self.stage / 'sealed-v2'
        self.sealed_v2.mkdir(mode=0o700)
        self._fixture(self.sealed_v2, 'v2')
        self.v1 = tx._tree(self.sealed_v1)
        self.v2 = tx._tree(self.sealed_v2)
        self.v2_config = sha(self.sealed_v2 / 'config.json')
        seal = self.stage / 'seal.json'
        seal.write_text(json.dumps({'version': 1, 'v1': self.v1,
                                    'v1Config': sha(self.sealed_v1 / 'config.json'),
                                    'v2': self.v2, 'v2Config': self.v2_config}))
        seal.chmod(0o600)
        self.preserved = self.stage / 'preserved-v2-live'
        self.probe = lambda: {'id': CID, 'image': IMAGE, 'state': 'exited'}

    def _fixture(self, tree, version):
        (tree / 'config.json').write_text(json.dumps({'rawBodyLogging': False, 'version': version}))
        (tree / 'metadata.json').write_bytes(('meta-' + version).encode())
        (tree / 'admin-auth.json').write_bytes(('auth-' + version).encode())
        (tree / 'logs').mkdir(mode=0o700)
        (tree / 'logs' / 'request.jsonl').write_bytes(('log-' + version).encode())
        (tree / 'detailed-logs').mkdir(mode=0o700)

    def run_replace(self, **kwargs):
        tx.replace(self.active, self.stage, self.sealed_v1, expected_v1=self.v1,
                   expected_v2=self.v2, expected_v2_config=self.v2_config,
                   candidate_id=CID, image=IMAGE, stopped_probe=self.probe,
                   anchor=self.root, owner=self.owner, **kwargs)

    def recover(self):
        tx.recover_gap(self.active, self.stage, self.sealed_v1,
                       stopped_probe=self.probe, anchor=self.root, owner=self.owner)

    def assert_no_live_change(self):
        self.assertEqual(tx._tree(self.active, active=True), self.v2)
        self.assertFalse(os.path.lexists(self.preserved))
        self.assertFalse(os.path.lexists(self.stage / 'phase.json'))

    def test_wrong_hash_config_and_stop_are_noop(self):
        with self.assertRaises(GateError):
            tx.replace(self.active, self.stage, self.sealed_v1, expected_v1=self.v1,
                       expected_v2='0' * 64, expected_v2_config=self.v2_config,
                       candidate_id=CID, image=IMAGE, stopped_probe=self.probe,
                       anchor=self.root, owner=self.owner)
        self.assert_no_live_change()
        self.v2_config = '0' * 64
        with self.assertRaises(GateError):
            self.run_replace()
        self.assert_no_live_change()
        self.v2_config = sha(self.sealed_v2 / 'config.json')
        self.probe = lambda: {'id': CID, 'image': IMAGE, 'state': 'running'}
        with self.assertRaises(GateError):
            self.run_replace()
        self.assert_no_live_change()

    def test_exact_v1_replacement_preserves_v2_and_refuses_replay(self):
        self.run_replace()
        self.assertEqual(tx._tree(self.active), self.v1)
        self.assertEqual(tx._tree(self.preserved, active=True), self.v2)
        self.assertEqual(tx._tree(self.sealed_v2), self.v2)
        self.assertEqual(tx._tree(self.sealed_v1), self.v1)
        self.assertEqual(tx._read_journal(self.stage)['phase'], 'v1-active')
        with self.assertRaises(GateError):
            self.recover()
        with self.assertRaises(GateError):
            self.run_replace()
        self.assertEqual(tx._tree(self.active), self.v1)

    def test_between_renames_failure_and_explicit_recovery(self):
        def fail():
            raise RuntimeError('synthetic fault between renames')
        with self.assertRaises(RuntimeError):
            self.run_replace(after_preserve=fail)
        self.assertFalse(os.path.lexists(self.active))
        self.assertEqual(tx._tree(self.preserved, active=True), self.v2)
        self.assertEqual(tx._read_journal(self.stage)['phase'], 'v2-preserved')
        self.recover()
        self.assertEqual(tx._tree(self.active), self.v1)
        self.assertEqual(tx._tree(self.preserved, active=True), self.v2)
        self.assertEqual(tx._read_journal(self.stage)['phase'], 'v1-active')

    def test_crash_after_first_rename_before_phase_update_recovers(self):
        journal = tx._journal

        def crash(stage, record, **kwargs):
            if record['phase'] == 'v2-preserved':
                raise RuntimeError('synthetic phase-write crash')
            return journal(stage, record, **kwargs)

        with patch.object(tx, '_journal', side_effect=crash):
            with self.assertRaises(RuntimeError):
                self.run_replace()
        self.assertFalse(os.path.lexists(self.active))
        self.assertEqual(tx._read_journal(self.stage)['phase'], 'move-v2-intent')
        self.recover()
        self.assertEqual(tx._tree(self.active), self.v1)
        self.assertEqual(tx._tree(self.preserved, active=True), self.v2)

    def test_ambiguous_new_live_path_or_drift_refuses_recovery(self):
        def fail():
            raise RuntimeError('injected')
        with self.assertRaises(RuntimeError):
            self.run_replace(after_preserve=fail)
        self.active.mkdir(mode=0o700)
        (self.active / 'config.json').write_text('{}')
        with self.assertRaises(GateError):
            self.recover()
        self.assertEqual((self.active / 'config.json').read_text(), '{}')
        (self.active / 'config.json').unlink()
        self.active.rmdir()
        (self.preserved / 'metadata.json').write_bytes(b'unknown post-stop write')
        with self.assertRaises(GateError):
            self.recover()
        self.assertFalse(os.path.lexists(self.active))
        self.assertTrue(self.preserved.is_dir())

    def test_new_live_path_between_check_and_install_cannot_be_overwritten(self):
        rename = tx._rename_exclusive

        def race(source, dest):
            if source == self.stage / 'prepared-v1':
                dest.mkdir(mode=0o700)
                (dest / 'sentinel').write_bytes(b'unknown writer')
            return rename(source, dest)

        with patch.object(tx, '_rename_exclusive', side_effect=race):
            with self.assertRaises(OSError):
                self.run_replace()
        self.assertEqual((self.active / 'sentinel').read_bytes(), b'unknown writer')
        self.assertEqual(tx._tree(self.preserved, active=True), self.v2)
        self.assertEqual(tx._read_journal(self.stage)['phase'], 'install-v1-intent')
        with self.assertRaises(GateError):
            self.recover()

    def test_seal_drift_is_noop(self):
        (self.stage / 'seal.json').write_text('{}')
        with self.assertRaises(GateError):
            self.run_replace()
        self.assert_no_live_change()

    def test_unprivate_symlink_hardlink_raw_and_destination_rejected(self):
        alias = self.root / 'alias'
        alias.symlink_to(self.stage, target_is_directory=True)
        with self.assertRaises(GateError):
            tx.replace(self.active, alias, self.sealed_v1, expected_v1=self.v1,
                       expected_v2=self.v2, expected_v2_config=self.v2_config,
                       candidate_id=CID, image=IMAGE, stopped_probe=self.probe,
                       anchor=self.root, owner=self.owner)
        self.stage.chmod(0o770)
        with self.assertRaises(GateError):
            self.run_replace()
        self.stage.chmod(0o700)
        os.link(self.sealed_v2 / 'metadata.json', self.sealed_v2 / 'hard')
        with self.assertRaises(GateError):
            self.run_replace()
        (self.sealed_v2 / 'hard').unlink()
        (self.active / 'detailed-logs/raw' / 'body').write_bytes(b'synthetic')
        with self.assertRaises(GateError):
            self.run_replace()
        (self.active / 'detailed-logs/raw/body').unlink()
        self.preserved.mkdir(mode=0o700)
        with self.assertRaises(GateError):
            self.run_replace()
        self.assertEqual(tx._tree(self.active, active=True), self.v2)
        self.assertFalse(os.path.lexists(self.stage / 'phase.json'))


if __name__ == '__main__':
    unittest.main()
