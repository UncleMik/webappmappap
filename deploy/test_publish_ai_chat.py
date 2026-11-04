import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

spec = importlib.util.spec_from_file_location('publish_ai', Path(__file__).with_name('publish-ai-chat.py'))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class ReleaseTests(unittest.TestCase):
    def test_nginx_requires_unique_anchor_and_preserves_other_locations(self):
        original = b'server {\n    location = /api/auth/personal { x; }\n    location ^~ /api/auth/ { y; }\n}\n'
        updated = release.nginx_patch(original)
        self.assertIn(b'proxy_read_timeout 75s;', updated)
        self.assertIn(b'location = /api/auth/personal { x; }', updated)
        self.assertEqual(updated.count(b'location = /api/auth/ai/messages'), 1)
        with self.assertRaises(RuntimeError):
            release.nginx_patch(updated)
        with self.assertRaises(RuntimeError):
            release.nginx_patch(original + original)

    def test_secret_is_validated_and_other_environment_is_preserved(self):
        original = b'AUTH_ENABLED=true\nOTHER=unchanged\n'
        result = release.environment_patch(original, 'a' * 64)
        self.assertTrue(result.startswith(original))
        self.assertIn(b'LARA_WEB_URL=https://admin.legkie-rody.ru/internal/lara-web/reply', result)
        with self.assertRaises(RuntimeError):
            release.environment_patch(original, 'bad\nINJECTION=true')
        with self.assertRaises(RuntimeError):
            release.environment_patch(result, 'b' * 64)

    def test_manifest_requires_exact_paths_and_matching_source(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            payload = {name: ('new:' + name).encode() for name in release.FILES}
            manifest = {'revision': 'a' * 40, 'files': {name: {'before': None, 'sha256': release.digest(data)} for name, data in payload.items()}}
            path = root / 'release.zip'
            with zipfile.ZipFile(path, 'w') as archive:
                archive.writestr('manifest.json', json.dumps(manifest))
                for name, data in payload.items():
                    archive.writestr('payload/' + name, data)
            with patch.object(release, 'ROOT', root):
                _, actual, _ = release.load_release(path)
                self.assertEqual(actual, payload)
                changed = release.target('backend/auth/config.mjs')
                changed.parent.mkdir(parents=True)
                changed.write_bytes(b'concurrent edit')
                with self.assertRaises(RuntimeError):
                    release.load_release(path)
                with self.assertRaises(RuntimeError):
                    release.target('../../auth.env')


if __name__ == '__main__':
    unittest.main()
