"""Offline boundary/rollback tests; no server, network, npm or real services."""
import importlib.util
import json
from pathlib import Path
import tempfile
import shutil
import subprocess
import unittest
from unittest.mock import patch
import zipfile

SPEC = importlib.util.spec_from_file_location('publish_stars', Path(__file__).with_name('publish-stars.py'))
release = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(release)
REPO = Path(__file__).resolve().parents[1]


class PublisherTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=Path(__file__).parent)
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.patches = [patch.object(release, 'ROOT', self.root),
                        patch.object(release, 'NGINX', self.root / 'nginx.conf'),
                        patch.object(release, 'AUTH', self.root / 'auth.env'),
                        patch.object(release, 'ADMIN', self.root / 'admin.env'),
                        patch.object(release, 'DURATIONS', self.root / 'media/durations.json')]
        for p in self.patches:
            p.start()
            self.addCleanup(p.stop)
        if not hasattr(release.os, 'chown'):
            p = patch.object(release.os, 'chown', create=True)
            p.start()
            self.addCleanup(p.stop)

    def sample_durations(self):
        return json.dumps({'version': 1, 'rows': [{'lessonId': str(i), 'videoKey': '0:0',
            'contentHash': 'a' * 64, 'durationMs': 1000, 'provider': 'getcourse'} for i in range(1145)]}).encode()

    def bundle(self, change=None, extra=None):
        payload = {'backend/auth/' + n: (REPO / 'backend/auth' / n).read_bytes() for n in release.MIGRATIONS}
        payload.update({'backend/package.json': b'{}', 'backend/package-lock.json': b'{}'})
        manifest = {'revision': 'a' * 40, 'files': {n: {'before': None, 'sha256': release.digest(d)} for n, d in payload.items()},
                    'configBefore': {n: 'b' * 64 for n in ['nginx', 'authEnv', 'adminEnv']},
                    'durations': {'before': None, 'sha256': release.digest(self.sample_durations())}}
        if change:
            change(manifest, payload)
        archive = self.root / 'release.zip'
        with zipfile.ZipFile(archive, 'w') as z:
            z.writestr('manifest.json', json.dumps(manifest))
            z.writestr('course-durations.json', self.sample_durations())
            for n, data in payload.items():
                z.writestr('payload/' + n, data)
            if extra:
                z.writestr(extra, b'extra')
        return archive

    def test_target_allowlist_and_admin_mapping(self):
        self.assertEqual(release.target('Фронт/admin/index.html'), self.root / 'admin-frontend/index.html')
        for name in ['Фронт/../auth.env', '/backend/auth/a.mjs', 'backend/auth//a.mjs',
                     'backend/auth/./a.mjs', 'backend/auth/../../a.mjs', 'backend/auth/.env',
                     'backend/auth/a\\b.mjs', 'backend/private.json', 'deploy/a.py',
                     'Фронт/assets/a.js', 'Фронт/admin/x/a.js', 'backend/content/private.json',
                     'backend/auth/C:a.mjs']:
            with self.subTest(name=name), self.assertRaises(RuntimeError):
                release.target(name)

    def test_symlink_parent_rejected(self):
        outside = self.root / 'outside'
        outside.mkdir()
        (self.root / 'backend').mkdir()
        try:
            (self.root / 'backend/auth').symlink_to(outside, target_is_directory=True)
        except OSError:
            self.skipTest('OS does not allow unprivileged symlinks')
        with self.assertRaisesRegex(RuntimeError, 'UNSAFE_TARGET'):
            release.target('backend/auth/a.mjs')

    def test_valid_bundle_and_exact_members(self):
        manifest, payload, durations = release.archive_read(self.bundle())
        self.assertEqual(len(manifest['files']), 6)
        self.assertEqual(len(payload), 6)
        self.assertEqual(len(json.loads(durations)['rows']), 1145)
        with self.assertRaisesRegex(RuntimeError, 'INVALID_ZIP_MEMBERS'):
            release.archive_read(self.bundle(extra='secret.env'))

    def test_checksum_revision_and_before_required(self):
        for edit, code in [
            (lambda m, p: m.update(revision='main'), 'REVISION_REQUIRED'),
            (lambda m, p: m['files']['backend/package.json'].pop('before'), 'INVALID_FILE_PIN'),
            (lambda m, p: p.update({'backend/package.json': b'changed'}), 'PAYLOAD_CHECKSUM_FAILED')]:
            with self.subTest(code=code), self.assertRaisesRegex(RuntimeError, code):
                release.archive_read(self.bundle(change=edit))

    def test_duplicate_json_rejected(self):
        with self.assertRaisesRegex(RuntimeError, 'DUPLICATE_JSON_KEY'):
            release.unique_json(b'{"files":1,"files":2}')

    def test_runtime_content_parent_created_readable_before_stop(self):
        (self.root / 'backend').mkdir()
        content = self.root / 'backend/content'
        if release.os.name == 'nt':
            # Windows stat does not expose POSIX chmod bits; model the server's
            # stat result while still exercising real mkdir/chmod calls below.
            original_stat = Path.stat
            def server_stat(path, *args, **kwargs):
                observed = original_stat(path, *args, **kwargs)
                if path == content:
                    values = list(observed)
                    values[0] = (observed.st_mode & ~0o777) | 0o755
                    return release.os.stat_result(values)
                return observed
            stat_patch = patch.object(Path, 'stat', server_stat)
            stat_patch.start()
            self.addCleanup(stat_patch.stop)
        with patch.object(release.os, 'chown', create=True) as chown:
            release.prepare_runtime_parents([content / 'gamification-source.json'])
            chown.assert_called_once_with(content, 0, 0)
        self.assertTrue(content.is_dir())
        if release.os.name != 'nt':
            self.assertEqual(content.stat().st_mode & 0o777, 0o755)
        # Existing content is validated without rewriting ownership or mode.
        with patch.object(release.os, 'chown', create=True) as chown:
            release.prepare_runtime_parents([content / 'gamification-source.json'])
            chown.assert_not_called()
        with self.assertRaisesRegex(RuntimeError, 'RUNTIME_PARENT_REQUIRED'):
            release.prepare_runtime_parents([self.root / 'frontend/new.js'])
        with self.assertRaisesRegex(RuntimeError, 'UNSAFE_RUNTIME_PARENT'):
            release.prepare_runtime_parents([self.root / 'unapproved/new.js'])

    def test_vapid_smoke_with_real_local_web_push_without_key_output(self):
        node = shutil.which('node')
        if not node or not (REPO / 'backend/node_modules/web-push/package.json').is_file():
            self.skipTest('Local Node/web-push is not installed')
        # Exercise the exact production import/generation script, capture keys only
        # in process memory; unittest output and assertions never contain keys.
        result = subprocess.run([node, '--input-type=module', '-e', release.VAPID_SCRIPT],
                                cwd=REPO / 'backend', capture_output=True, timeout=15)
        self.assertEqual(result.returncode, 0, 'Real web-push VAPID generation failed')
        keys = json.loads(result.stdout)
        self.assertEqual(set(keys), {'publicKey', 'privateKey'})
        self.assertTrue(bool(release.re.fullmatch('[A-Za-z0-9_-]{87}', keys['publicKey'])))
        self.assertTrue(bool(release.re.fullmatch('[A-Za-z0-9_-]{43}', keys['privateKey'])))

    def test_nginx_patch_preserves_other_routes_and_is_idempotent(self):
        source = (REPO / 'deploy/nginx-domain.conf').read_bytes()
        # Remove only the already implemented additions from the reference.
        text = source.decode()
        for header in ['location ^~ /api/auth/internal/', 'location = /api/auth/gamification/actions']:
            start, end, _ = release.location(text, header)
            text = text[:start] + text[end:]
        text = text.replace('        proxy_set_header Cookie $http_cookie;\n', '').replace(
            '        proxy_set_header X-Webpril-Account $http_x_webpril_account;\n', '')
        changed = release.patch_nginx(text.encode())
        self.assertEqual(release.patch_nginx(changed), changed)
        self.assertIn(b'client_max_body_size 16k;', changed)
        self.assertIn(b'proxy_set_header X-Webpril-Account $http_x_webpril_account;', changed)
        self.assertEqual(release.location(text, 'location = /api/auth/personal')[2],
                         release.location(changed.decode(), 'location = /api/auth/personal')[2])

    def test_nginx_conflicting_internal_block_rejected(self):
        text = (REPO / 'deploy/nginx-domain.conf').read_text(encoding='utf-8')
        start, end, block = release.location(text, 'location ^~ /api/auth/internal/')
        source = (text[:start] + block.replace('return 404;', 'proxy_pass http://127.0.0.1:3001;') + text[end:]).encode()
        with self.assertRaisesRegex(RuntimeError, 'NGINX_INTERNAL_DENY_REQUIRED'):
            release.patch_nginx(source)

    def test_environment_preserves_keys_and_does_not_approve_audience(self):
        keys = {'publicKey': 'a' * 87, 'privateKey': 'b' * 43}
        source = b'AUTH_HMAC_SECRET=private\nAUTH_GAMIFICATION_ENABLED=false\nOTHER_SETTING=keep\n'
        after = release.patch_env(source, keys)
        self.assertEqual(release.patch_env(after), after)
        self.assertIn(b'AUTH_HMAC_SECRET=private', after)
        self.assertIn(b'OTHER_SETTING=keep', after)
        self.assertNotIn(b'medical', after)
        self.assertNotIn(b'audience', after)
        self.assertEqual(release.patch_env(after, {'publicKey': 'c' * 87, 'privateKey': 'd' * 43}), after)
        with self.assertRaisesRegex(RuntimeError, 'INCOMPLETE_EXISTING_VAPID'):
            release.patch_env(b'GAMIFICATION_PUSH_PUBLIC_KEY=partial\n', keys)

    def test_durations_reject_urls_unknowns_and_duplicates(self):
        value = json.loads(self.sample_durations())
        for mutate in [lambda v: v['rows'][0].update(url='https://private.invalid'),
                       lambda v: v['rows'][0].update(durationMs=None),
                       lambda v: v['rows'].__setitem__(1, v['rows'][0])]:
            current = json.loads(json.dumps(value))
            mutate(current)
            with self.assertRaises(RuntimeError):
                release.durations_check(json.dumps(current).encode())

    def test_only_four_migrations_and_no_existing_grants(self):
        payload = {'backend/auth/' + n: (REPO / 'backend/auth' / n).read_bytes() for n in release.MIGRATIONS}
        sql = release.migration_sql(payload)
        self.assertTrue(sql.startswith("BEGIN; SET LOCAL lock_timeout='3s'"))
        self.assertTrue(sql.endswith('COMMIT;'))
        self.assertNotIn('GRANT SELECT,INSERT,UPDATE,DELETE ON auth_users', sql)
        self.assertNotIn('ADD COLUMN IF NOT EXISTS poll_id', sql)
        payload['backend/auth/stars-migration.sql'] += b'\nCOMMIT;\n'
        with self.assertRaisesRegex(RuntimeError, 'UNSAFE_MIGRATION_CONTROL'):
            release.migration_sql(payload)

    def test_rollback_checks_all_before_restoring_any(self):
        one, two = self.root / 'one', self.root / 'two'
        one.write_bytes(b'new-one')
        two.write_bytes(b'operator-fix')
        with self.assertRaisesRegex(RuntimeError, 'ROLLBACK_CONCURRENT_CHANGE'):
            release.rollback_files([one, two], {one: b'old', two: None}, {one: b'new-one', two: b'new-two'})
        self.assertEqual(one.read_bytes(), b'new-one')
        two.write_bytes(b'new-two')
        release.rollback_files([one, two], {one: b'old', two: None}, {one: b'new-one', two: b'new-two'})
        self.assertEqual(one.read_bytes(), b'old')
        self.assertFalse(two.exists())

    def dependencies_bundle(self, extra=None):
        lock = json.dumps({'packages': {'node_modules/pg': {'version': '8.23.1'},
            'node_modules/web-push': {'version': '4.0.0'}, 'node_modules/dev': {'dev': True}}}).encode()
        files = {'pg/package.json': b'{}', 'web-push/package.json': b'{}'}
        if extra:
            files[extra] = b'bad'
        bundle = self.root / 'dependencies.zip'
        with zipfile.ZipFile(bundle, 'w') as z:
            z.writestr('dependencies-manifest.json', json.dumps({'version': 1, 'packageLockSha256': release.digest(lock),
                'files': {n: release.digest(d) for n, d in files.items()}}))
            for n, data in files.items():
                z.writestr(n, data)
        return bundle, lock

    def test_dependencies_outer_hash_lock_hash_dev_native_and_paths(self):
        bundle, lock = self.dependencies_bundle()
        release.unpack_dependencies(bundle, release.digest(bundle.read_bytes()), lock, self.root / 'good')
        for expected, lock_data, code in [('a' * 64, lock, 'DEPENDENCIES_CHECKSUM_FAILED'),
                                          (release.digest(bundle.read_bytes()), b'{}', 'DEPENDENCY_LOCK_MISMATCH')]:
            with self.assertRaisesRegex(RuntimeError, code):
                release.unpack_dependencies(bundle, expected, lock_data, self.root / 'bad')
        for name in ['pg/../../escape', 'pg/native.node', 'dev/package.json', 'pg/.env']:
            bundle, lock = self.dependencies_bundle(extra=name)
            with self.subTest(name=name), self.assertRaises(RuntimeError):
                release.unpack_dependencies(bundle, release.digest(bundle.read_bytes()), lock, self.root / 'bad')

    def test_repeat_detects_dependency_change_and_extra_file(self):
        bundle, lock = self.dependencies_bundle()
        checksum = release.digest(bundle.read_bytes())
        modules = self.root / 'backend/node_modules'
        release.unpack_dependencies(bundle, checksum, lock, modules)
        self.assertTrue(release.dependencies_match(bundle, checksum, lock))
        (modules / 'pg/package.json').write_bytes(b'changed')
        self.assertFalse(release.dependencies_match(bundle, checksum, lock))
        (modules / 'pg/package.json').write_bytes(b'{}')
        (modules / 'unexpected.js').write_bytes(b'extra')
        self.assertFalse(release.dependencies_match(bundle, checksum, lock))

    def test_module_swap_failure_restores_original(self):
        source, current, saved = [self.root / n for n in ['new', 'current', 'saved']]
        source.mkdir(); current.mkdir()
        (current / 'old').write_bytes(b'old')
        rename = release.os.rename
        def fail_new(a, b):
            if a == source:
                raise OSError('synthetic')
            return rename(a, b)
        with patch.object(release.os, 'rename', side_effect=fail_new), self.assertRaises(OSError):
            release.swap_modules(source, current, saved)
        self.assertTrue((current / 'old').is_file())
        self.assertFalse(saved.exists())

    def test_apply_failure_keeps_database_and_rolls_back_code(self):
        stage = self.root / 'stage'; stage.mkdir()
        backend = self.root / 'backend'; backend.mkdir()
        current = backend / 'node_modules'; current.mkdir()
        (current / 'version').write_bytes(b'old')
        modules = stage / 'node_modules'; modules.mkdir()
        (modules / 'version').write_bytes(b'new')
        code = self.root / 'app.mjs'; code.write_bytes(b'old')
        calls = []
        def command(args, **kwargs):
            calls.append(args)
            if args == ['nginx', '-t'] and calls.count(args) == 1:
                raise RuntimeError('SYNTHETIC_NGINX_FAILURE')
        with patch.object(release, 'verify_backup', return_value=self.root / 'backup'), \
             patch.object(release, 'stop_clean'), patch.object(release, 'healthy'), \
             patch.object(release, 'ledger_snapshot', return_value=[10, 100, 'hash']), \
             patch.object(release, 'sql_run') as sql, patch.object(release, 'run', side_effect=command):
            with self.assertRaisesRegex(RuntimeError, 'RELEASE_ROLLED_BACK_DATABASE_RETAINED'):
                release.apply_release(stage, {code: b'old'}, {code: b'new'}, modules, 'MIGRATE_ONCE')
            sql.assert_called_once_with('MIGRATE_ONCE')
        self.assertEqual(code.read_bytes(), b'old')
        self.assertEqual((current / 'version').read_bytes(), b'old')
        self.assertFalse(any('pg_restore' in str(args) for args in calls))

    def test_backup_failure_never_stops_services(self):
        stage = self.root / 'stage'; stage.mkdir()
        with patch.object(release, 'verify_backup', side_effect=RuntimeError('RESTORE_FAILED')), \
             patch.object(release, 'stop_clean') as stop, patch.object(release, 'sql_run') as sql:
            with self.assertRaisesRegex(RuntimeError, 'RESTORE_FAILED'):
                release.apply_release(stage, {}, {}, self.root / 'unused', 'UNUSED')
            stop.assert_not_called()
            sql.assert_not_called()

    def test_changed_ledger_prevents_any_application_write(self):
        stage = self.root / 'stage'; stage.mkdir()
        backend = self.root / 'backend'; backend.mkdir()
        current = backend / 'node_modules'; current.mkdir()
        (current / 'version').write_bytes(b'old')
        modules = stage / 'node_modules'; modules.mkdir()
        (modules / 'version').write_bytes(b'new')
        code = self.root / 'app.mjs'; code.write_bytes(b'old')
        with patch.object(release, 'verify_backup', return_value=self.root / 'backup'), \
             patch.object(release, 'stop_clean'), patch.object(release, 'healthy'), \
             patch.object(release, 'ledger_snapshot', side_effect=[[10, 100, 'hash'], [10, 99, 'other']]), \
             patch.object(release, 'sql_run') as sql, patch.object(release, 'run'):
            with self.assertRaisesRegex(RuntimeError, 'RELEASE_ROLLED_BACK_DATABASE_RETAINED'):
                release.apply_release(stage, {code: b'old'}, {code: b'new'}, modules, 'MIGRATE_ONCE')
            sql.assert_called_once_with('MIGRATE_ONCE')
        self.assertEqual(code.read_bytes(), b'old')
        self.assertEqual((current / 'version').read_bytes(), b'old')
        self.assertEqual(json.loads((stage / 'private/ledger-before.json').read_text()), [10, 100, 'hash'])

    def test_inspect_outputs_hashes_only_and_rejects_duplicates(self):
        path = self.root / 'backend/auth/main.mjs'
        path.parent.mkdir(parents=True)
        path.write_bytes(b'code')
        for p in [release.AUTH, release.ADMIN, release.NGINX]:
            p.write_bytes(b'private-secret')
        result = release.inspect(['backend/auth/main.mjs', 'Фронт/new.js'])
        self.assertEqual(result['files']['backend/auth/main.mjs'], release.digest(b'code'))
        self.assertIsNone(result['files']['Фронт/new.js'])
        self.assertNotIn('private-secret', json.dumps(result))
        with self.assertRaisesRegex(RuntimeError, 'INVALID_INSPECT_LIST'):
            release.inspect(['backend/auth/main.mjs'] * 2)


if __name__ == '__main__':
    unittest.main()
