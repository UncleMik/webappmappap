import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

spec = importlib.util.spec_from_file_location('voice_release', Path(__file__).with_name('publish-ai-voice.py'))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class VoiceReleaseTests(unittest.TestCase):
    def test_streams_voice_without_changing_messages_or_auth_routes(self):
        messages = '    location = /api/auth/ai/messages {\n        client_max_body_size 15m;\n    }\n'
        before = ('server {\n' + messages + release.AUTH_ROUTE + '        client_max_body_size 4k;\n    }\n}\n').encode()
        after = release.patch_nginx(before)
        self.assertEqual(after.replace((release.VOICE_ROUTE + '\n').encode(), b''), before)
        self.assertEqual(release.patch_nginx(after), after)
        for directive in ('client_max_body_size 8m;', 'proxy_request_buffering off;', 'proxy_http_version 1.1;', 'proxy_read_timeout 160s;'):
            self.assertIn(directive, release.VOICE_ROUTE)
        for invalid in (after.replace(b'client_max_body_size 8m;', b'client_max_body_size 16m;'), before + before, b'server {}'):
            with self.assertRaises(RuntimeError):
                release.patch_nginx(invalid)

    def test_archive_checks_current_files_and_rejects_changed_source(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            files = {}
            for name in release.FILES:
                target = root / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(b'old')
                files[name] = {'before': hashlib.sha256(b'old').hexdigest(), 'sha256': hashlib.sha256(b'new').hexdigest()}
            archive = root / 'release.zip'
            with zipfile.ZipFile(archive, 'w') as package:
                package.writestr('manifest.json', json.dumps({'revision': 'a' * 40, 'files': files}))
                for name in release.FILES:
                    package.writestr('payload/' + name, b'new')
            with patch.object(release, 'target', side_effect=lambda name: root / name):
                self.assertEqual(release.load(archive)[2][release.FILES[0]], b'new')
                (root / release.FILES[0]).write_bytes(b'changed')
                with self.assertRaisesRegex(RuntimeError, 'SOURCE_OR_PAYLOAD_MISMATCH'):
                    release.load(archive)

    def test_paths_outside_release_are_rejected(self):
        with self.assertRaises(RuntimeError):
            release.target('../auth.env')


if __name__ == '__main__':
    unittest.main()
