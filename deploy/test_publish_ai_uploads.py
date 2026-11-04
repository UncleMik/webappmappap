import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('uploads', Path(__file__).with_name('publish-ai-uploads.py'))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)

class UploadReleaseTests(unittest.TestCase):
    def test_changes_only_known_route_and_disables_body_disk_buffering(self):
        original = ('before\n' + release.OLD_ROUTE + 'after\n').encode()
        updated = release.patch_nginx(original)
        self.assertTrue(updated.startswith(b'before\n'))
        self.assertTrue(updated.endswith(b'after\n'))
        for directive in (b'15m;', b'proxy_http_version 1.1;', b'proxy_request_buffering off;', b'proxy_read_timeout 160s;'):
            self.assertIn(directive, updated)
        with self.assertRaises(RuntimeError):
            release.patch_nginx(updated)
        with self.assertRaises(RuntimeError):
            release.patch_nginx(original + original)

    def test_unknown_target_is_rejected(self):
        with self.assertRaises(RuntimeError):
            release.target('../auth.env')

if __name__ == '__main__':
    unittest.main()
