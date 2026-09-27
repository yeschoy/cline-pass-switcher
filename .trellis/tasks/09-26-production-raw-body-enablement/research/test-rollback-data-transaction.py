#!/usr/bin/env python3
"""Local synthetic-only active-path transaction tests; never touch production."""
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
from types import SimpleNamespace
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
        self.root = Path(self.tmp.name).resolve() / ('cps-rollback-synthetic-' + 'a' * 16)
        self.root.mkdir(mode=0o700)
        self.owner = os.geteuid()
        if sys.platform != 'linux':
            # macOS tests only: simulate the FD addressing/occupied-slot
            # behavior. This is NOT an atomic NOREPLACE implementation; the
            # actual syscall must be validated on an isolated Linux host.
            def synthetic_rename(source_fd, source_name, dest_fd, dest_name):
                if tx._entry(dest_fd, dest_name) is not None:
                    raise FileExistsError('synthetic destination occupied')
                os.rename(source_name, dest_name, src_dir_fd=source_fd,
                          dst_dir_fd=dest_fd)
            p = patch.object(tx, '_rename_exclusive', synthetic_rename)
            p.start()
            self.addCleanup(p.stop)
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

    def recover_active(self):
        tx.recover_active(self.active, self.stage, self.sealed_v1,
                          stopped_probe=self.probe, anchor=self.root, owner=self.owner)

    def assert_no_live_change(self):
        self.assertEqual(tx._tree(self.active, active=True), self.v2)
        self.assertFalse(os.path.lexists(self.preserved))
        self.assertFalse(os.path.lexists(self.stage / 'phase.json'))

    def _test_uid_layout(self):
        # Same UID locally; the cross-UID variant is reserved for a disposable
        # root-owned /opt fixture on Linux, not emulated by changing production.
        self.service.chmod(0o750)
        marker = self.root / tx.SYNTHETIC_MARKER
        marker.write_bytes(tx.SYNTHETIC_BYTES)
        marker.chmod(0o600)

    def test_synthetic_service_layout_and_recovery(self):
        self._test_uid_layout()
        self.run_replace(test_service_uid=self.owner)
        self.assertEqual(tx._tree(self.active), self.v1)
        self.assertEqual(tx._tree(self.preserved, active=True), self.v2)
        tx.recover_active(self.active, self.stage, self.sealed_v1,
                          stopped_probe=self.probe, anchor=self.root, owner=self.owner,
                          test_service_uid=self.owner)
        self.assertEqual(tx._read_journal(self.stage)['phase'], 'v1-active')

    def test_synthetic_layout_rejects_missing_bad_or_linked_sentinel(self):
        self.service.chmod(0o750)
        with self.assertRaises(GateError):
            self.run_replace(test_service_uid=self.owner)
        marker = self.root / tx.SYNTHETIC_MARKER
        marker.write_bytes(tx.SYNTHETIC_BYTES)
        marker.chmod(0o644)
        with self.assertRaises(GateError):
            self.run_replace(test_service_uid=self.owner)
        marker.chmod(0o600)
        marker.unlink()
        marker.symlink_to(self.stage / tx.MARKER)
        with self.assertRaises(GateError):
            self.run_replace(test_service_uid=self.owner)
        marker.unlink()
        self.assertEqual(tx._tree(self.active, active=True), self.v2)
        self.assertFalse(os.path.lexists(self.preserved))
        self.assertFalse(os.path.lexists(self.stage / 'phase.json'))

    def test_synthetic_layout_rejects_wrong_owner_mode_and_links(self):
        self._test_uid_layout()
        self.service.chmod(0o700)
        with self.assertRaises(GateError):
            self.run_replace(test_service_uid=self.owner)
        self.service.chmod(0o750)
        with self.assertRaises(GateError):
            self.run_replace(test_service_uid=self.owner + 1)  # off-/opt cross-UID refused
        with patch.object(tx.os, 'geteuid', return_value=self.owner + 1):
            with self.assertRaises(GateError):
                self.run_replace(test_service_uid=self.owner)  # anchor owner != caller
        self.root.chmod(0o750)
        with self.assertRaises(GateError):
            self.run_replace(test_service_uid=self.owner)
        self.root.chmod(0o700)
        self.active.rename(self.service / 'original-data')
        self.active.symlink_to(self.service / 'original-data', target_is_directory=True)
        with self.assertRaises(GateError):
            self.run_replace(test_service_uid=self.owner)
        self.active.unlink()
        (self.service / 'original-data').rename(self.active)
        self.stage.chmod(0o750)
        with self.assertRaises(GateError):
            self.run_replace(test_service_uid=self.owner)
        self.stage.chmod(0o700)
        self.stage.rename(self.root / 'original-stage')
        self.stage.symlink_to(self.root / 'original-stage', target_is_directory=True)
        with self.assertRaises(GateError):
            self.run_replace(test_service_uid=self.owner)
        self.stage.unlink()
        (self.root / 'original-stage').rename(self.stage)
        self.assertEqual(tx._tree(self.active, active=True), self.v2)
        self.assertFalse(os.path.lexists(self.preserved))
        self.assertFalse(os.path.lexists(self.stage / 'phase.json'))

    def test_synthetic_noreplace_failure_preserves_unexpected_destination(self):
        self._test_uid_layout()
        rename = tx._rename_exclusive
        def race(source_fd, source_name, dest_fd, dest_name):
            if source_name == 'prepared-v1':
                self.active.mkdir(mode=0o700)
                (self.active / 'sentinel').write_bytes(b'unknown writer')
            return rename(source_fd, source_name, dest_fd, dest_name)
        with patch.object(tx, '_rename_exclusive', side_effect=race):
            with self.assertRaises(OSError):
                self.run_replace(test_service_uid=self.owner)
        self.assertEqual((self.active / 'sentinel').read_bytes(), b'unknown writer')
        self.assertEqual(tx._tree(self.preserved, active=True), self.v2)
        self.assertEqual(tx._read_journal(self.stage)['phase'], 'install-v1-intent')
        with self.assertRaises(GateError):
            tx.recover_gap(self.active, self.stage, self.sealed_v1,
                           stopped_probe=self.probe, anchor=self.root, owner=self.owner,
                           test_service_uid=self.owner)

    def test_operational_anchor_rejects_test_uid_without_touching_paths(self):
        with self.assertRaises(GateError):
            tx.replace(Path('/opt/cline-pass-switcher/data'), self.stage, self.sealed_v1,
                       expected_v1=self.v1, expected_v2=self.v2,
                       expected_v2_config=self.v2_config, candidate_id=CID,
                       image=IMAGE, stopped_probe=self.probe, test_service_uid=1000)
        with self.assertRaises(GateError):
            tx.replace(Path('/opt/cline-pass-switcher/data'), self.stage, self.sealed_v1,
                       expected_v1=self.v1, expected_v2=self.v2,
                       expected_v2_config=self.v2_config, candidate_id=CID,
                       image=IMAGE, stopped_probe=self.probe, after_preserve=lambda: None)

    def test_service_tree_ownership_is_checked_without_test_override(self):
        original = tx._dir
        checked = []

        def track(path, **kwargs):
            if path in (self.active, self.stage / 'sealed-v2',
                        self.stage / 'prepared-v1', self.sealed_v1):
                checked.append((path, kwargs.get('owner')))
            return original(path, **kwargs)

        with patch.object(tx, '_dir', side_effect=track):
            tx._paths(self.active, self.stage, self.sealed_v1, self.root, self.owner)
        self.assertEqual({path for path, _ in checked},
                         {self.active, self.stage / 'sealed-v2',
                          self.stage / 'prepared-v1', self.sealed_v1})
        self.assertTrue(all(uid == self.owner for _, uid in checked))

    def test_pinned_active_owner_mismatch_refuses_before_mutation(self):
        original = tx._entry

        def wrong_owner(fd, name):
            result = original(fd, name)
            if name != 'data' or result is None:
                return result
            return SimpleNamespace(**{
                key: getattr(result, key) for key in
                ('st_dev', 'st_ino', 'st_mode', 'st_gid')}, st_uid=self.owner + 1)

        with patch.object(tx, '_entry', side_effect=wrong_owner):
            with self.assertRaises(GateError):
                self.run_replace()
        self.assert_no_live_change()

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

        def race(source_fd, source_name, dest_fd, dest_name):
            if source_name == 'prepared-v1':
                self.active.mkdir(mode=0o700)
                (self.active / 'sentinel').write_bytes(b'unknown writer')
            return rename(source_fd, source_name, dest_fd, dest_name)

        with patch.object(tx, '_rename_exclusive', side_effect=race):
            with self.assertRaises(OSError):
                self.run_replace()
        self.assertEqual((self.active / 'sentinel').read_bytes(), b'unknown writer')
        self.assertEqual(tx._tree(self.preserved, active=True), self.v2)
        self.assertEqual(tx._read_journal(self.stage)['phase'], 'install-v1-intent')
        with self.assertRaises(GateError):
            self.recover()

    def test_post_second_rename_journal_crash_requires_proved_recovery(self):
        journal = tx._journal

        def crash(stage, record, **kwargs):
            if record['phase'] == 'v1-active':
                raise RuntimeError('synthetic crash before final journal')
            return journal(stage, record, **kwargs)

        with patch.object(tx, '_journal', side_effect=crash):
            with self.assertRaises(RuntimeError):
                self.run_replace()
        self.assertEqual(tx._read_journal(self.stage)['phase'], 'install-v1-intent')
        self.assertEqual(tx._tree(self.active), self.v1)
        self.assertEqual(tx._tree(self.preserved, active=True), self.v2)
        with self.assertRaises(GateError):
            self.recover()  # no empty gap; never attempt v1-over-v1
        self.recover_active()
        self.assertEqual(tx._read_journal(self.stage)['phase'], 'v1-active')
        self.recover_active()  # idempotent proof, no rename or image boot
        self.assertEqual(tx._tree(self.active), self.v1)

    def test_crash_immediately_after_second_rename_recovers_without_replay(self):
        rename = tx._rename_exclusive
        def crash(source_fd, source_name, dest_fd, dest_name):
            rename(source_fd, source_name, dest_fd, dest_name)
            if source_name == 'prepared-v1':
                raise RuntimeError('power loss after second rename')
        with patch.object(tx, '_rename_exclusive', side_effect=crash):
            with self.assertRaises(RuntimeError):
                self.run_replace()
        self.assertEqual(tx._read_journal(self.stage)['phase'], 'install-v1-intent')
        self.assertEqual(tx._tree(self.active), self.v1)
        self.recover_active()
        self.assertEqual(tx._read_journal(self.stage)['phase'], 'v1-active')
        self.assertEqual(tx._tree(self.preserved, active=True), self.v2)

    def test_first_intent_without_rename_is_not_a_recoverable_gap(self):
        rename = tx._rename_exclusive
        def crash(source_fd, source_name, dest_fd, dest_name):
            if source_name == 'data':
                raise RuntimeError('power loss before first rename')
            return rename(source_fd, source_name, dest_fd, dest_name)
        with patch.object(tx, '_rename_exclusive', side_effect=crash):
            with self.assertRaises(RuntimeError):
                self.run_replace()
        self.assertEqual(tx._tree(self.active, active=True), self.v2)
        self.assertEqual(tx._read_journal(self.stage)['phase'], 'move-v2-intent')
        with self.assertRaises(GateError):
            self.recover()
        with self.assertRaises(GateError):
            self.recover_active()

    def test_post_install_unknown_drift_or_running_candidate_refuses(self):
        self.run_replace()
        (self.active / 'metadata.json').write_bytes(b'unknown write')
        with self.assertRaises(GateError):
            self.recover_active()
        (self.active / 'metadata.json').write_bytes(b'meta-v1')
        self.probe = lambda: {'id': CID, 'image': IMAGE, 'state': 'running'}
        with self.assertRaises(GateError):
            self.recover_active()

    def test_identical_content_but_replaced_active_inode_refuses_finalization(self):
        self.run_replace()
        self.active.rename(self.service / 'original-v1')
        shutil.copytree(self.service / 'original-v1', self.active)
        self.assertEqual(tx._tree(self.active), self.v1)
        with self.assertRaises(GateError):
            self.recover_active()
        self.assertEqual(tx._read_journal(self.stage)['phase'], 'v1-active')

    def test_first_rename_destination_race_fail_closed(self):
        rename = tx._rename_exclusive

        def race(source_fd, source_name, dest_fd, dest_name):
            if source_name == 'data':
                self.preserved.mkdir(mode=0o700)
            return rename(source_fd, source_name, dest_fd, dest_name)

        with patch.object(tx, '_rename_exclusive', side_effect=race):
            with self.assertRaises(OSError):
                self.run_replace()
        self.assertEqual(tx._tree(self.active, active=True), self.v2)
        self.assertEqual(tx._read_journal(self.stage)['phase'], 'move-v2-intent')
        self.preserved.rmdir()

    def test_parent_swap_during_transaction_refuses(self):
        journal = tx._journal
        def swap(stage, record, **kwargs):
            result = journal(stage, record, **kwargs)
            if record['phase'] == 'move-v2-intent':
                self.service.rename(self.root / 'original-service')
                self.service.mkdir(mode=0o700)
            return result
        with patch.object(tx, '_journal', side_effect=swap):
            with self.assertRaises(GateError):
                self.run_replace()
        self.assertFalse(os.path.lexists(self.active))
        self.assertEqual(tx._tree(self.root / 'original-service' / 'data', active=True), self.v2)
        self.assertFalse(os.path.lexists(self.preserved))

    def test_same_uid_source_swap_at_first_syscall_detected_after_rename(self):
        rename = tx._rename_exclusive
        def swap(source_fd, source_name, dest_fd, dest_name):
            if source_name == 'data':
                self.active.rename(self.service / 'original-data')
                self.active.mkdir(mode=0o700)
                self._fixture(self.active, 'v2')
            return rename(source_fd, source_name, dest_fd, dest_name)
        with patch.object(tx, '_rename_exclusive', side_effect=swap):
            with self.assertRaises(GateError):
                self.run_replace()
        self.assertEqual(tx._read_journal(self.stage)['phase'], 'move-v2-intent')
        self.assertEqual(tx._tree(self.service / 'original-data', active=True), self.v2)
        self.assertEqual(tx._tree(self.preserved, active=True), self.v2)
        self.assertFalse(os.path.lexists(self.active))
        # The old tree is not silently discarded: the external fence failed.
        with self.assertRaises(GateError):
            self.recover()  # sealed v2 digest is not sufficient for identity

    def test_parent_swap_after_first_rename_refuses_install(self):
        journal = tx._journal
        def swap(stage, record, **kwargs):
            result = journal(stage, record, **kwargs)
            if record['phase'] == 'v2-preserved':
                self.service.rename(self.root / 'original-service')
                self.service.mkdir(mode=0o700)
            return result
        with patch.object(tx, '_journal', side_effect=swap):
            with self.assertRaises(GateError):
                self.run_replace()
        self.assertFalse(os.path.lexists(self.active))
        self.assertFalse(os.path.lexists(self.root / 'original-service' / 'data'))
        self.assertEqual(tx._tree(self.preserved, active=True), self.v2)
        with self.assertRaises(GateError):
            self.recover()  # pinned original parent cannot be quietly retargeted

    def test_child_swap_during_scan_refuses_before_first_rename(self):
        original = tx._tree
        def swap(tree, *, active=False):
            value = original(tree, active=active)
            if tree == self.active:
                self.active.rename(self.service / 'detached')
                self.active.mkdir(mode=0o700)
                self._fixture(self.active, 'v2')
            return value
        with patch.object(tx, '_tree', side_effect=swap):
            with self.assertRaises(GateError):
                self.run_replace()
        self.assertFalse(os.path.lexists(self.preserved))
        self.assertFalse(os.path.lexists(self.stage / 'phase.json'))

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
        self.service.chmod(0o770)
        with self.assertRaises(GateError):
            self.run_replace()
        self.service.chmod(0o700)
        self.service.rename(self.root / 'original-service')
        self.service.symlink_to(self.root / 'original-service', target_is_directory=True)
        with self.assertRaises(GateError):
            self.run_replace()
        self.service.unlink()
        (self.root / 'original-service').rename(self.service)
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
