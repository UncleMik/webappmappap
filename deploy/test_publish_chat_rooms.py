import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

spec = importlib.util.spec_from_file_location('chat_rooms_release', Path(__file__).with_name('publish-chat-rooms.py'))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class ChatRoomsReleaseTests(unittest.TestCase):
    def package(self, root, *, extra=None, wrong_hash=False):
        files = {}
        for name in release.FILES:
            path = root / ('frontend/' + name[6:] if name.startswith('Фронт/') else name)
            path.parent.mkdir(parents=True, exist_ok=True)
            if name not in release.NEW_FILES:
                path.write_bytes(b'old')
            files[name] = {'before': release.digest(path.read_bytes()) if path.exists() else None,
                           'sha256': release.digest(b'new')}
        if wrong_hash:
            files['backend/auth/http.mjs']['sha256'] = '0' * 64
        manifest = {'revision': 'a' * 40, 'files': files, 'qa': {name: release.digest(b'test') for name in release.QA}}
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, 'w') as archive:
            archive.writestr('manifest.json', json.dumps(manifest))
            for name in release.FILES:
                archive.writestr('payload/' + name, b'new')
            for name in release.QA:
                archive.writestr('qa/' + name, b'test')
            if extra:
                archive.writestr(extra, b'not allowed')
        buffer.seek(0)
        return buffer

    def test_exact_manifest_pins_current_and_new_files_without_allowing_secrets(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            package = self.package(root)
            with patch.object(release, 'ROOT', root), zipfile.ZipFile(package) as archive:
                manifest, before, payload = release.read_archive(archive)
                self.assertEqual(set(payload), release.FILES)
                self.assertEqual({name for name, value in before.items() if value is None}, release.NEW_FILES)
                self.assertEqual(len(manifest['qa']), 4)
            for name in ['../auth.env', 'backend/auth/.env', 'Фронт/../../secret', 'backend/lara-web/lara_web.py']:
                with self.assertRaises(RuntimeError):
                    release.target(name)

    def test_rejects_extra_archive_members_and_changed_or_corrupted_sources(self):
        for extra, corrupt in [('payload/backend/auth/.env', False), (None, True), (None, False)]:
            with self.subTest(extra=extra, corrupt=corrupt), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                package = self.package(root, extra=extra, wrong_hash=corrupt)
                if not extra and not corrupt:
                    (root / 'backend/auth/http.mjs').write_bytes(b'concurrent change')
                with patch.object(release, 'ROOT', root), zipfile.ZipFile(package) as archive:
                    with self.assertRaises(RuntimeError):
                        release.read_archive(archive)

    def test_backup_and_restore_finish_before_ddl_and_code_writes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / 'file.mjs'; path.write_bytes(b'old')
            events = []
            manifest = {'revision': 'a' * 40, 'files': {'file': {'sha256': release.digest(b'new')}}}
            def backup(): events.extend(['backup', 'restore_verified']); return root / 'verified-backup'
            def atomic(target, data): events.append('write'); target.write_bytes(data)
            with patch.object(release, 'target', return_value=path), patch.object(release, 'verify_backup', side_effect=backup), \
                    patch.object(release, 'migrate', side_effect=lambda payload: events.append('ddl')), \
                    patch.object(release, 'atomic', side_effect=atomic), patch.object(release, 'run'), patch.object(release, 'healthy'):
                release.apply_release(manifest, {'file': b'old'}, {'file': b'new'}, root)
            self.assertEqual(events, ['backup', 'restore_verified', 'ddl', 'write'])
            self.assertEqual(json.loads((root / 'installed-checksums.json').read_text())['file']['after'], release.digest(b'new'))

    def test_failed_backup_prevents_ddl_or_code_write(self):
        with patch.object(release, 'verify_backup', side_effect=RuntimeError('restore failed')), \
                patch.object(release, 'migrate') as migrate, patch.object(release, 'atomic') as atomic:
            with self.assertRaisesRegex(RuntimeError, 'restore failed'):
                release.apply_release({}, {}, {}, Path('unused'))
            migrate.assert_not_called(); atomic.assert_not_called()

    def test_code_rollback_preserves_additive_schema_and_existing_data(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); path = root / 'file.mjs'; path.write_bytes(b'old')
            manifest = {'revision': 'a' * 40, 'files': {'file': {'sha256': release.digest(b'new')}}}
            def atomic(target, data): target.write_bytes(data)
            with patch.object(release, 'target', return_value=path), patch.object(release, 'verify_backup', return_value=root), \
                    patch.object(release, 'migrate') as migrate, patch.object(release, 'atomic', side_effect=atomic), \
                    patch.object(release, 'run'), patch.object(release, 'healthy', side_effect=[RuntimeError('health failed'), None]):
                with self.assertRaisesRegex(RuntimeError, 'health failed'):
                    release.apply_release(manifest, {'file': b'old'}, {'file': b'new'}, root)
                migrate.assert_called_once()
            self.assertEqual(path.read_bytes(), b'old')

    def test_backup_runner_requires_complete_backup_and_calls_restore_verification(self):
        from types import SimpleNamespace
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); backup = root / 'backups' / '20261105T120000Z'
            backup.mkdir(parents=True); (backup / 'complete').write_text('ok\n')
            calls = []
            def run(args, **kwargs):
                calls.append(args)
                return SimpleNamespace(stdout=(str(backup) + '\n').encode())
            with patch.object(release, 'ROOT', root), patch.object(release, 'run', side_effect=run):
                self.assertEqual(release.verify_backup(), backup)
            self.assertEqual(calls[0][1], str(root / 'deploy/backup.py'))
            self.assertEqual(calls[1][1:], [str(root / 'deploy/verify-backup.py'), str(backup)])

    def test_owner_transaction_only_new_migrations_and_runtime_probe_rolls_back(self):
        calls = []
        with patch.object(release, 'runtime_role', return_value='runtime_role'), \
                patch.object(release, 'run', side_effect=lambda args, **kwargs: calls.append((args, kwargs['input'].decode()))):
            release.migrate({'backend/auth/club-rooms-migration.sql': b'-- room expansion',
                             'backend/auth/ai-failure-migration.sql': b'-- failure column'})
        self.assertEqual(len(calls), 2)
        ddl, probe = calls[0][1], calls[1][1]
        self.assertIn('SET LOCAL ROLE wep_pril_auth_owner;', ddl)
        self.assertLess(ddl.index('-- room expansion'), ddl.index('-- failure column'))
        self.assertTrue(ddl.endswith('COMMIT;'))
        self.assertIn('SET LOCAL ROLE runtime_role;', probe)
        self.assertTrue(probe.endswith('ROLLBACK;'))
        self.assertNotIn('GRANT', ddl); self.assertNotIn('CREATE TABLE', ddl)
        self.assertNotIn('DROP DATABASE', ddl)


if __name__ == '__main__':
    unittest.main()
