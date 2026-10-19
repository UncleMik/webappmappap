import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('video_release', Path(__file__).with_name('publish-weekly-videos.py'))
release = importlib.util.module_from_spec(spec); spec.loader.exec_module(release)


class PublishVideosTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name); (self.root / 'existing').write_bytes(b'old')
        self.files = {
            'existing': {'old': release.digest(b'old'), 'new': release.digest(b'new'), 'source': 'one'},
            'added': {'old': None, 'new': release.digest(b'added'), 'source': 'two'},
        }
        self.download = lambda name: b'new' if name == 'one' else b'added'
        self.restarts = []
    def tearDown(self):
        self.temp.cleanup()
    def run_release(self, **kwargs):
        release.publish(self.root, self.root / 'backup', self.files, kwargs.get('download', self.download),
                        lambda: self.restarts.append(True), kwargs.get('healthy', lambda: True))
    def test_publish_and_repeat(self):
        self.run_release(); self.run_release()
        self.assertEqual((self.root / 'existing').read_bytes(), b'new')
        self.assertEqual((self.root / 'backup/existing').read_bytes(), b'old')
        self.assertEqual(len(self.restarts), 1)
    def test_foreign_baseline_stops_before_writing(self):
        (self.root / 'existing').write_bytes(b'foreign')
        with self.assertRaisesRegex(RuntimeError, 'SOURCE_MISMATCH'):
            self.run_release()
        self.assertFalse((self.root / 'added').exists()); self.assertFalse(self.restarts)
    def test_corrupt_download_stops_before_writing(self):
        with self.assertRaisesRegex(RuntimeError, 'DOWNLOAD_MISMATCH'):
            self.run_release(download=lambda _: b'bad')
        self.assertEqual((self.root / 'existing').read_bytes(), b'old'); self.assertFalse(self.restarts)
    def test_failed_health_restores_old_and_removes_new(self):
        with self.assertRaisesRegex(RuntimeError, 'HEALTH_CHECK_FAILED'):
            self.run_release(healthy=lambda: False)
        self.assertEqual((self.root / 'existing').read_bytes(), b'old')
        self.assertFalse((self.root / 'added').exists()); self.assertEqual(len(self.restarts), 2)
