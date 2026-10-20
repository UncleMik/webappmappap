import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


def load(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), Path(__file__).with_name(name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


release = load('publish-video-timestamps')
support = load('publish-weekly-videos')
login = load('publish-required-login')


class TimestampPublisherTests(unittest.TestCase):
    def test_protected_onboarding_snapshot_publishes_and_repeats(self):
        source = Path(__file__).with_name('onboarding-video-live.html').read_bytes()
        protected = login.protect_html(source)
        target_name = 'frontend/video.html'
        info = release.FILES[target_name]
        for before in (protected, protected.replace(b'\n', b'\r\n')):
            with self.subTest(sha256=support.digest(before)), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                target = root / target_name
                target.parent.mkdir()
                target.write_bytes(before)
                after = b'<head>' + login.LOCK.encode() + b'\n<title>updated timestamps</title></head>'
                manifest = {target_name: {**info, 'new': support.digest(after)}}
                with patch.object(release, 'FILES', manifest):
                    files = release.select_baselines(root)
                    changed = support.publish(root, root / 'backup', files, lambda _: after,
                                              lambda: None, lambda: True)
                    self.assertTrue(changed)
                    self.assertEqual(target.read_bytes(), after)
                    self.assertEqual((root / 'backup' / target_name).read_bytes(), before)
                    self.assertIn(login.LOCK.encode(), target.read_bytes())
                    self.assertFalse(support.publish(root, root / 'backup', release.select_baselines(root),
                                                    lambda _: after, lambda: None, lambda: True))

    def test_unknown_edits_report_all_hashes_without_writes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'frontend').mkdir()
            for name in release.FILES:
                (root / name).write_bytes(b'unknown change')
            before = {p: p.read_bytes() for p in root.rglob('*') if p.is_file()}
            with self.assertRaises(RuntimeError) as error:
                release.select_baselines(root)
            for name in release.FILES:
                self.assertIn(name + ':SHA256=' + support.digest(b'unknown change'), str(error.exception))
            self.assertEqual(before, {p: p.read_bytes() for p in root.rglob('*') if p.is_file()})


if __name__ == '__main__':
    unittest.main()
