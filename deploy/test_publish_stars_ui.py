"""Offline tests for the small UI-only/wallet publisher."""
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import zipfile

SPEC = importlib.util.spec_from_file_location('stars_ui_release', Path(__file__).with_name('publish-stars-ui.py'))
release = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(release)


class UiPublisherTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=Path(__file__).parent)
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        for name in ['frontend', 'backend/auth']:
            (self.root / name).mkdir(parents=True)
        root_patch = patch.object(release, 'ROOT', self.root)
        root_patch.start(); self.addCleanup(root_patch.stop)
        if not hasattr(release.os, 'chown'):
            chown_patch = patch.object(release.os, 'chown', create=True)
            chown_patch.start(); self.addCleanup(chown_patch.stop)

    def fixtures(self, core=False):
        before_data = {'Фронт/gamification.js': b'const old = 1;'}
        if core:
            before_data[release.CORE] = b'export const old = 1;'
        payload = {}
        for name, data in before_data.items():
            release.target(name).write_bytes(data)
            payload[name] = data.replace(b'old', b'updated')
        manifest = {'revision': 'a' * 40, 'files': {n: {'before': release.digest(d), 'sha256': release.digest(payload[n])}
                                                    for n, d in before_data.items()}}
        return manifest, payload

    def bundle(self, manifest, payload, extra=None):
        path = self.root / 'release.zip'
        with zipfile.ZipFile(path, 'w') as archive:
            archive.writestr('manifest.json', json.dumps(manifest))
            for name, data in payload.items():
                archive.writestr('payload/' + name, data)
            if extra:
                archive.writestr(extra, b'extra')
        return path

    def test_path_allowlist_and_traversal(self):
        for name in ['Фронт/../auth.env', 'Фронт//x.js', 'Фронт/./x.js', '/Фронт/x.js',
                     'Фронт/admin/x.js', 'Фронт/.env', 'Фронт/x\\z.js', 'backend/auth/main.mjs',
                     'backend/auth/stars-migration.sql', 'backend/server.mjs', 'Фронт/x:1.js']:
            with self.subTest(name=name), self.assertRaises(RuntimeError):
                release.target(name)
        self.assertEqual(release.target(release.CORE), self.root / release.CORE)

    def test_manifest_hashes_existing_before_and_exact_members(self):
        manifest, payload = self.fixtures()
        self.assertEqual(release.load_bundle(self.bundle(manifest, payload)), (manifest, payload))
        with self.assertRaisesRegex(RuntimeError, 'UI_INVALID_ZIP_MEMBERS'):
            release.load_bundle(self.bundle(manifest, payload, 'extra.env'))
        payload['Фронт/gamification.js'] += b'changed'
        with self.assertRaisesRegex(RuntimeError, 'UI_PAYLOAD_CHECKSUM_FAILED'):
            release.load_bundle(self.bundle(manifest, payload))
        manifest['files']['Фронт/gamification.js']['before'] = None
        with self.assertRaisesRegex(RuntimeError, 'UI_REAL_BEFORE_HASH_REQUIRED'):
            release.load_bundle(self.bundle(manifest, payload))

    def test_before_mismatch_and_metadata_drift(self):
        manifest, _ = self.fixtures()
        before = release.snapshot(manifest)
        release.target('Фронт/gamification.js').write_bytes(b'operator changed')
        with self.assertRaisesRegex(RuntimeError, 'UI_BEFORE_CHECKSUM_FAILED'):
            release.snapshot(manifest)
        with self.assertRaisesRegex(RuntimeError, 'UI_CONCURRENT_CHANGE'):
            release.reconcile(before)
        release.target('Фронт/gamification.js').write_bytes(before['Фронт/gamification.js'][0])
        mode, uid, gid = before['Фронт/gamification.js'][1]
        with patch.object(release, 'metadata', return_value=(mode ^ 0o100, uid, gid)):
            with self.assertRaisesRegex(RuntimeError, 'UI_CONCURRENT_CHANGE'):
                release.reconcile(before)

    def test_auth_restart_only_when_core_changes(self):
        for index, core in enumerate([False, True]):
            manifest, payload = self.fixtures(core=core)
            before = release.snapshot(manifest)
            original_metadata = {n: release.metadata(release.target(n)) for n in payload}
            with patch.object(release, 'stop_auth') as stop, patch.object(release, 'run') as run, \
                 patch.object(release, 'healthy'):
                release.apply_release(manifest, payload, before, self.root / ('stage' + str(index)))
                self.assertEqual(stop.call_count, int(core))
                self.assertEqual(run.call_args_list, [unittest.mock.call(['systemctl', 'start', 'wep-pril-auth'])] if core else [])
            for name, data in payload.items():
                self.assertEqual(release.read(release.target(name)), data)
                self.assertEqual(release.metadata(release.target(name)), original_metadata[name])

    def test_unchanged_core_does_not_restart_auth(self):
        manifest, payload = self.fixtures(core=True)
        payload[release.CORE] = release.read(release.target(release.CORE))
        manifest['files'][release.CORE]['sha256'] = release.digest(payload[release.CORE])
        with patch.object(release, 'stop_auth') as stop, patch.object(release, 'run') as run, patch.object(release, 'healthy'):
            release.apply_release(manifest, payload, release.snapshot(manifest), self.root / 'stage')
            stop.assert_not_called(); run.assert_not_called()

    def test_rollback_prechecks_whole_set(self):
        manifest, payload = self.fixtures(core=True)
        before = release.snapshot(manifest)
        for name, data in payload.items():
            release.target(name).write_bytes(data)
        release.target(release.CORE).write_bytes(b'operator hotfix')
        with self.assertRaisesRegex(RuntimeError, 'UI_ROLLBACK_CONCURRENT_CHANGE'):
            release.rollback(list(payload), before, payload)
        self.assertEqual(release.target('Фронт/gamification.js').read_bytes(), payload['Фронт/gamification.js'])
        self.assertEqual(release.target(release.CORE).read_bytes(), b'operator hotfix')

    def test_failed_health_rolls_back_only_files_and_auth(self):
        manifest, payload = self.fixtures(core=True)
        before = release.snapshot(manifest)
        with patch.object(release, 'stop_auth') as stop, patch.object(release, 'run') as run, \
             patch.object(release, 'healthy', side_effect=[RuntimeError('SYNTHETIC_FAILURE'), None]):
            with self.assertRaisesRegex(RuntimeError, 'UI_RELEASE_ROLLED_BACK'):
                release.apply_release(manifest, payload, before, self.root / 'stage')
            self.assertEqual(stop.call_count, 2)
            self.assertTrue(all(call.args[0] == ['systemctl', 'start', 'wep-pril-auth'] for call in run.call_args_list))
        for name, (data, meta) in before.items():
            self.assertEqual(release.target(name).read_bytes(), data)
            self.assertEqual(release.metadata(release.target(name)), meta)

    def test_syntax_command_checks_inline_js_without_executing(self):
        with patch.object(release, 'run') as run:
            release.syntax_check({'Фронт/a.js': b'let a=1;', release.CORE: b'export const a=1;',
                'Фронт/a.css': b'CSS', 'Фронт/a.html': b'<script type="application/json">{}</script><script>let inline=1;</script>'})
            self.assertEqual(run.call_count, 3)
            self.assertTrue(all(call.args[0] == ['/usr/local/bin/node', '--input-type=module', '--check'] for call in run.call_args_list))
            self.assertEqual(run.call_args_list[-1].kwargs['input'], b'let inline=1;')

    def test_real_local_node_rejects_invalid_syntax(self):
        node = shutil.which('node')
        if not node:
            self.skipTest('Local node unavailable')
        with patch.object(release, 'NODE', node):
            release.syntax_check({'Фронт/a.js': b'const a = 1;'})
            with self.assertRaises(subprocess.CalledProcessError):
                release.syntax_check({'Фронт/a.js': b'const = ;'})

    def test_inspect_only_hashes_and_no_missing_files(self):
        self.fixtures()
        result = release.inspect(['Фронт/gamification.js'])
        self.assertEqual(set(result), {'files'})
        self.assertNotIn('const old', json.dumps(result))
        with self.assertRaisesRegex(RuntimeError, 'UI_EXISTING_FILES_REQUIRED'):
            release.inspect(['Фронт/missing.js'])


if __name__ == '__main__':
    unittest.main()
