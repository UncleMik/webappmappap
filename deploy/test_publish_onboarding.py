import importlib.util
import os
from pathlib import Path
import tempfile
import unittest


spec = importlib.util.spec_from_file_location('onboarding_release', Path(__file__).with_name('publish-onboarding.py'))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class OnboardingPublishTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / 'root'
        (self.root / 'backend').mkdir(parents=True)
        (self.root / 'frontend').mkdir()
        (self.root / 'backend/auth.mjs').write_bytes(b'old')
        self.files = {
            'backend/auth.mjs': {'source': 'backend/auth.mjs', 'old': release.digest(b'old'), 'new': release.digest(b'new'),},
            'frontend/onboarding.html': {'source': 'frontend/onboarding.html', 'old': None, 'new': release.digest(b'page')},
        }
        self.data = {'backend/auth.mjs': b'new', 'frontend/onboarding.html': b'page'}
        self.column = False
        self.events = []

    def tearDown(self):
        self.temp.cleanup()

    def run_release(self, *, download=None, migrate=None, healthy=None, backup_db=None):
        def make_column():
            self.events.append('migrate')
            self.column = True
        def save_backup(path):
            self.events.append('backup')
            path.write_bytes(b'private-archive')
        return release.publish(
            self.root, Path(self.temp.name) / 'backup', self.files,
            download or self.data.__getitem__, lambda: self.column,
            backup_db or save_backup, migrate or make_column,
            lambda: self.events.append('stop'), lambda: self.events.append('restart'),
            healthy or (lambda after: True))

    def test_publish_and_idempotent_skip(self):
        self.assertTrue(self.run_release())
        self.assertEqual((self.root / 'backend/auth.mjs').read_bytes(), b'new')
        self.assertEqual((self.root / 'frontend/onboarding.html').read_bytes(), b'page')
        self.assertEqual((Path(self.temp.name) / 'backup/backend/auth.mjs').read_bytes(), b'old')
        self.assertEqual(self.events, ['backup', 'stop', 'migrate', 'restart'])
        self.assertFalse(self.run_release())
        self.assertEqual(self.events, ['backup', 'stop', 'migrate', 'restart'])

    def test_foreign_baseline_and_corrupt_download_fail_before_backup(self):
        (self.root / 'backend/auth.mjs').write_bytes(b'foreign')
        with self.assertRaisesRegex(RuntimeError, 'SOURCE_MISMATCH'):
            self.run_release()
        self.assertFalse((Path(self.temp.name) / 'backup').exists())
        (self.root / 'backend/auth.mjs').write_bytes(b'old')
        with self.assertRaisesRegex(RuntimeError, 'DOWNLOAD_MISMATCH'):
            self.run_release(download=lambda _: b'corrupt')
        self.assertFalse(self.events)

    def test_unexpected_symlink_fails_closed(self):
        try:
            (self.root / 'frontend/onboarding.html').symlink_to(self.root / 'backend/auth.mjs')
        except OSError:
            self.skipTest('Creating symlinks needs a Windows privilege on this host')
        with self.assertRaisesRegex(RuntimeError, 'UNSAFE_TARGET'):
            self.run_release()
        self.assertFalse(self.events)

    def test_failed_health_restores_files_and_restarts(self):
        with self.assertRaisesRegex(RuntimeError, 'HEALTH_CHECK_FAILED'):
            self.run_release(healthy=lambda after: not after)
        self.assertEqual((self.root / 'backend/auth.mjs').read_bytes(), b'old')
        self.assertFalse((self.root / 'frontend/onboarding.html').exists())
        self.assertEqual(self.events, ['backup', 'stop', 'migrate', 'restart', 'restart'])
        self.assertTrue(self.column)  # Additive migration is intentionally retained.

    def test_migration_failure_keeps_files_and_recovers_service(self):
        def fail():
            self.events.append('migrate')
            raise RuntimeError('MIGRATION_FAILED')
        with self.assertRaisesRegex(RuntimeError, 'MIGRATION_FAILED'):
            self.run_release(migrate=fail)
        self.assertEqual((self.root / 'backend/auth.mjs').read_bytes(), b'old')
        self.assertFalse((self.root / 'frontend/onboarding.html').exists())
        self.assertEqual(self.events, ['backup', 'stop', 'migrate', 'restart'])

    def test_existing_new_files_missing_column_only_migrates(self):
        (self.root / 'backend/auth.mjs').write_bytes(b'new')
        (self.root / 'frontend/onboarding.html').write_bytes(b'page')
        self.assertTrue(self.run_release(healthy=lambda after: after))
        self.assertEqual(self.events, ['backup', 'stop', 'migrate', 'restart'])

    def test_backup_failure_never_stops_service(self):
        def fail(_):
            raise RuntimeError('BACKUP_FAILED')
        with self.assertRaisesRegex(RuntimeError, 'BACKUP_FAILED'):
            self.run_release(backup_db=fail)
        self.assertFalse(self.events)

    @unittest.skipIf(os.name == 'nt', 'POSIX file mode test')
    def test_atomic_write_is_readable_with_private_umask(self):
        target = self.root / 'frontend/onboarding.html'
        previous = os.umask(0o077)
        try:
            release.atomic_write(target, b'page')
        finally:
            os.umask(previous)
        self.assertEqual(target.stat().st_mode & 0o777, 0o644)


if __name__ == '__main__':
    unittest.main()
