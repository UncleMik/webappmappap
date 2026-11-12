import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location('stars_check', Path(__file__).with_name('check-stars-postgres.py'))
check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(check)


class BundleBoundaryTests(unittest.TestCase):
    def test_rejects_paths_outside_source_inventory(self):
        for name in ['../auth.env', '/etc/wep-pril/auth.env', 'backend/../auth.env',
                     'backend/.env', 'backend/node_modules/pg/index.mjs',
                     'backend/test/../../outside.mjs', 'C:/outside.mjs',
                     'backend\\auth\\main.mjs', 'Фронт/assets/private.json']:
            with self.subTest(name=name):
                self.assertFalse(check.permitted(name))

    def test_accepts_only_required_source_and_fixture_classes(self):
        for name in ['backend/auth/main.mjs', 'backend/test/stars-core.test.mjs',
                     'backend/content/gamification-source.json', 'backend/seed/weekly-content.json',
                     'backend/package-lock.json', 'Фронт/admin/index.html',
                     'Фронт/assets/auth-mother-v1.webp']:
            with self.subTest(name=name):
                self.assertTrue(check.permitted(name))

    def test_checksum_failure_never_executes_bundle(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            bundle = root / 'source.zip'
            files = {name: '0' * 64 for name in ['backend/package.json', 'backend/package-lock.json', 'backend/test/auth-pool.mjs']}
            with zipfile.ZipFile(bundle, 'w') as archive:
                archive.writestr('manifest.json', json.dumps({'files': files}))
                for name in files:
                    archive.writestr(name, '{}')
            with self.assertRaisesRegex(RuntimeError, 'BUNDLE_CHECKSUM_FAILED'):
                check.unpack(bundle, root / 'stage')


if __name__ == '__main__':
    unittest.main()
