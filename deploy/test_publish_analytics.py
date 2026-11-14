import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

spec = importlib.util.spec_from_file_location('publish_analytics', Path(__file__).with_name('publish-analytics.py'))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class ReleaseChecks(unittest.TestCase):
    def bundle(self, path, *, bad_hash=False, extra=False, backend_only=False):
        payload = {name: b'export {};' for name in release.REQUIRED}
        if backend_only:
            payload = {name: data for name, data in payload.items() if name in release.BACKEND}
        manifest = {'revision': 'a' * 40, 'files': {name: {'before': None,
            'sha256': hashlib.sha256(data).hexdigest()} for name, data in payload.items()}}
        if bad_hash:
            manifest['files'][release.MIGRATION]['sha256'] = 'b' * 64
        with zipfile.ZipFile(path, 'w') as archive:
            archive.writestr('manifest.json', json.dumps(manifest))
            for name, data in payload.items():
                archive.writestr('payload/' + name, data)
            if extra:
                archive.writestr('payload/../../unreviewed.env', b'forbidden')

    def test_bundle_rejects_unreviewed_members_and_changed_bytes(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'release.zip'
            self.bundle(path)
            self.assertEqual(len(release.load_bundle(path)[1]), len(release.REQUIRED))
            for options in ({'bad_hash': True}, {'extra': True}, {'backend_only': True}):
                self.bundle(path, **options)
                with self.assertRaises(RuntimeError):
                    release.load_bundle(path)

    def test_migration_allows_cascade_cleanup_but_rejects_destructive_statements(self):
        sql = '\n'.join('CREATE TABLE IF NOT EXISTS ' + name
            + '(user_id uuid REFERENCES auth_users(id) ON DELETE CASCADE);' for name in release.TABLES).encode()
        self.assertIn(b'SET LOCAL ROLE wep_pril_auth_owner', release.migration_sql(sql))
        self.assertIn(b'GRANT SELECT,INSERT,UPDATE,DELETE', release.migration_sql(sql))
        for statement in (b'DROP TABLE auth_users;', b'DELETE FROM auth_users;', b'COMMIT;', b'ALTER TABLE auth_users DROP COLUMN email;'):
            with self.assertRaises(RuntimeError):
                release.migration_sql(sql + statement)

    def test_admin_and_customer_targets_stay_separate(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'frontend').mkdir()
            (root / 'admin-frontend').mkdir()
            with patch.object(release, 'ROOT', root):
                self.assertEqual(release.target('Фронт/admin/analytics.js'), root / 'admin-frontend/analytics.js')
                self.assertEqual(release.target('Фронт/analytics.js'), root / 'frontend/analytics.js')
                with self.assertRaises(RuntimeError):
                    release.target('Фронт/../auth.env')


if __name__ == '__main__':
    unittest.main()
