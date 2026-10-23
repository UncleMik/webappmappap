import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('release', Path(__file__).with_name('publish-single-session.py'))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class PublishTests(unittest.TestCase):
    def exercise(self, *, healthy=True, migration_fails=False, conflict=False):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            old = b'old-auth-code'
            (root / 'backend/auth').mkdir(parents=True)
            (root / 'backend/auth/store.mjs').write_bytes(old)
            payload = {'backend/auth/store.mjs': b'new-auth-code',
                       'backend/auth/single-session-migration.sql': b'-- new migration'}
            before = {'backend/auth/store.mjs': old, 'backend/auth/single-session-migration.sql': None}
            operations = []

            def sql(source):
                operations.append(source)
                if source.startswith('BEGIN; SET LOCAL'):
                    if migration_fails:
                        raise RuntimeError('TEST_MIGRATION_FAILED')
                    if conflict:
                        (root / 'backend/auth/store.mjs').write_bytes(b'concurrent-code')
                return b'0'

            def run(args, **kwargs):
                operations.append(args)

            def dump(args, **kwargs):
                kwargs['stdout'].write(b'private-dump')

            with patch.object(release, 'ROOT', root), patch.object(release, 'run', run), \
                    patch.object(release, 'sql', sql), patch.object(release.subprocess, 'run', dump), \
                    patch.object(release, 'healthy', side_effect=[healthy, True]):
                error = None
                try:
                    release.apply_release(payload, before, root / 'backup')
                except RuntimeError as caught:
                    error = str(caught)
            return {
                'code': (root / 'backend/auth/store.mjs').read_bytes(),
                'migration_exists': (root / 'backend/auth/single-session-migration.sql').exists(),
                'backup': (root / 'backup/0').read_bytes(),
                'dump': (root / 'backup/auth.pgdump').read_bytes(),
                'operations': operations, 'error': error,
            }

    def test_success_backs_up_before_migration_and_preserves_new_code(self):
        result = self.exercise()
        self.assertIsNone(result['error'])
        self.assertEqual(result['code'], b'new-auth-code')
        self.assertEqual(result['backup'], b'old-auth-code')
        self.assertEqual(result['dump'], b'private-dump')
        self.assertEqual(result['operations'][0], ['systemctl', 'stop', 'wep-pril-auth'])
        self.assertTrue(result['migration_exists'])

    def test_health_failure_restores_code_without_reviving_old_tokens(self):
        result = self.exercise(healthy=False)
        self.assertEqual(result['error'], 'AUTH_HEALTH_FAILED')
        self.assertEqual(result['code'], b'old-auth-code')
        self.assertFalse(result['migration_exists'])
        self.assertTrue(any(isinstance(op, str) and 'DELETE FROM auth_sessions WHERE revoked_at IS NOT NULL' in op
                            for op in result['operations']))

    def test_failed_transaction_never_changes_code_or_cleans_existing_sessions(self):
        result = self.exercise(migration_fails=True)
        self.assertEqual(result['error'], 'TEST_MIGRATION_FAILED')
        self.assertEqual(result['code'], b'old-auth-code')
        self.assertFalse(result['migration_exists'])
        self.assertFalse(any(isinstance(op, str) and 'DELETE FROM auth_sessions' in op for op in result['operations']))

    def test_concurrent_edit_is_not_overwritten(self):
        result = self.exercise(conflict=True)
        self.assertEqual(result['error'], 'CONCURRENT_CHANGE:backend/auth/store.mjs')
        self.assertEqual(result['code'], b'concurrent-code')


if __name__ == '__main__':
    unittest.main()
