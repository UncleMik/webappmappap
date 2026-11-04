import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import sys
import types
import unittest
from unittest.mock import patch
import zipfile

spec = importlib.util.spec_from_file_location('installer', Path(__file__).with_name('install-lara-web-do.py'))
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)

NGINX = '''server {
    server_name admin.legkie-rody.ru;
    location / {
        proxy_pass http://127.0.0.1:8090;
    }
    listen 443 ssl; # managed by Certbot
}
server {
    listen 80;
    server_name admin.legkie-rody.ru;
}
'''


class InstallerTests(unittest.TestCase):
    def archive(self, path, names=None, bad_hash=False, requirements=None):
        code = b'print("example")\n'
        requirements = installer.PINNED_REQUIREMENTS if requirements is None else requirements
        manifest = {'revision': 'a' * 40, 'files': {installer.APP_PATH: ('0' * 64 if bad_hash else hashlib.sha256(code).hexdigest()),
                                                  installer.REQUIREMENTS_PATH: hashlib.sha256(requirements).hexdigest()}}
        with zipfile.ZipFile(path, 'w') as z:
            z.writestr('manifest.json', json.dumps(manifest))
            z.writestr('payload/' + installer.APP_PATH, code)
            z.writestr('payload/' + installer.REQUIREMENTS_PATH, requirements)
            for extra in names or []:
                z.writestr(extra, 'extra')

    def test_manifest_and_path_pinning(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / 'release.zip'
            self.archive(p)
            self.assertEqual(installer.package(p)[0], 'a' * 40)
            for name in ('../escape', 'payload/backend/lara-web/other.py', 'payload//etc/passwd'):
                self.archive(p, [name])
                with self.assertRaises(installer.InstallError):
                    installer.package(p)
            self.archive(p, bad_hash=True)
            with self.assertRaises(installer.InstallError):
                installer.package(p)
            self.archive(p, requirements=b'Pillow>=13\n')
            with self.assertRaises(installer.InstallError):
                installer.package(p)
            self.archive(p, requirements=b'x' * (1024 * 1024 + 1))
            with self.assertRaises(installer.InstallError):
                installer.package(p)

    def test_vendor_bundle_pins_image_hash_and_no_symlinks(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(installer, 'VENDORS', Path(tmp)):
            digest = hashlib.sha256(installer.PINNED_REQUIREMENTS).hexdigest()
            folder = Path(tmp) / digest
            folder.mkdir()
            marker = folder / '.bundle.json'
            expected = {'requirementsSha256': digest, 'baseImage': 'sha256:base'}
            marker.write_text(json.dumps(expected))
            self.assertEqual(installer.vendor_bundle(installer.PINNED_REQUIREMENTS, 'sha256:base'), folder)
            for value in ({**expected, 'baseImage': 'other'}, {**expected, 'requirementsSha256': '0' * 64}, {**expected, 'extra': True}):
                marker.write_text(json.dumps(value))
                with self.assertRaises(installer.InstallError):
                    installer.vendor_bundle(installer.PINNED_REQUIREMENTS, 'sha256:base')
            marker.write_text(json.dumps(expected))
            with patch.object(Path, 'is_symlink', side_effect=lambda: True), self.assertRaises(installer.InstallError):
                installer.vendor_bundle(installer.PINNED_REQUIREMENTS, 'sha256:base')
            nested = folder / 'nested'
            nested.mkdir()
            link = nested / 'link'
            link.write_bytes(b'pretend-link')
            original = Path.is_symlink
            with patch.object(Path, 'is_symlink', autospec=True, side_effect=lambda p: p == link or original(p)), self.assertRaises(installer.InstallError):
                installer.vendor_bundle(installer.PINNED_REQUIREMENTS, 'sha256:base')

    def test_wrong_server_is_rejected(self):
        class Response:
            def __init__(self, data): self.data = data
            def __enter__(self): return self
            def __exit__(self, *_): return False
            def read(self, *_): return self.data
        def opener(url, timeout):
            return Response(b'fra1' if url.endswith('/region') else b'1')
        with self.assertRaises(installer.InstallError):
            installer.metadata(opener)

    def test_unique_nginx_and_idempotent(self):
        result = installer.patch_nginx(NGINX)
        self.assertEqual(result.count(installer.BEGIN), 1)
        self.assertLess(result.index(installer.BEGIN), result.index('    location /'))
        self.assertEqual(installer.patch_nginx(result), result)
        legacy = result.replace(installer.BLOCK, installer.LEGACY_BLOCK)
        self.assertEqual(installer.patch_nginx(legacy), result)
        self.assertIn('client_max_body_size 15m;', result)
        self.assertIn('proxy_request_buffering off;', result)
        self.assertIn('client_body_timeout 90s;', result)
        self.assertIn('proxy_read_timeout 90s;', result)
        with self.assertRaises(installer.InstallError):
            installer.patch_nginx(NGINX + NGINX)
        with self.assertRaises(installer.InstallError):
            installer.patch_nginx(result.replace('deny all;', 'allow all;'))
        with self.assertRaises(installer.InstallError):
            installer.patch_nginx(legacy.replace('512k', '513k'))
        with self.assertRaises(installer.InstallError):
            installer.patch_nginx(NGINX.replace('location / {', 'location /internal/lara-web/ { }\n    location / {'))

    def test_rollback_restores_only_known_paths(self):
        path = Path('/only/owned/file')
        with patch.object(installer, 'atomic_write') as write:
            installer.restore(path, b'original', 0o600)
            write.assert_called_once_with(path, b'original', 0o600)
        with patch.object(Path, 'unlink') as unlink:
            installer.restore(path, None, 0o600)
            unlink.assert_called_once_with(missing_ok=True)

    def test_subprocess_failure_does_not_expose_stderr(self):
        fake = type('Result', (), {'returncode': 1, 'stdout': '', 'stderr': 'secret-value'})()
        with patch.object(installer.subprocess, 'run', return_value=fake):
            with self.assertRaises(installer.InstallError) as raised:
                installer.run(['anything'])
        self.assertNotIn('secret-value', str(raised.exception))

    def test_deployment_lock_rejects_concurrent_apply(self):
        fake = types.SimpleNamespace(LOCK_EX=1, LOCK_NB=2, flock=lambda *_: (_ for _ in ()).throw(BlockingIOError()))
        with patch.dict(sys.modules, {'fcntl': fake}), patch.object(installer.os, 'O_NOFOLLOW', 0, create=True), \
             patch.object(installer.os, 'open', return_value=123), patch.object(installer.os, 'close') as close:
            with self.assertRaises(installer.InstallError):
                with installer.deployment_lock():
                    self.fail('lock must not be acquired')
            close.assert_called_once_with(123)

    def test_failure_after_writes_rolls_back_only_managed_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            code, env, marker, nginx = [folder / x for x in ('app.py', 'env', 'marker', 'nginx')]
            old_code = b'old code'
            old_env = b'POSTGRES_PASSWORD=previous-password\n'
            old_marker = b'old-revision\n'
            for path, data in ((code, old_code), (env, old_env), (marker, old_marker), (nginx, b'old nginx')):
                path.write_bytes(data)
            app = {'State': {'StartedAt': 'unchanged'}, 'Image': 'sha256:test'}
            pg = {'State': {'StartedAt': 'unchanged'}}
            pre = ('a' * 40, b'new code', b'old nginx', b'new nginx', app, pg, {'managed': True},
                   {'POSTGRES_DB': 'school', 'POSTGRES_HOST': 'db'}, True, (old_code, old_env, old_marker),
                   installer.PINNED_REQUIREMENTS, folder / 'vendor')
            def write(path, data, mode):
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(data)
            def sql(_, query, *args):
                return '0' if 'pg_class c' in query else '1'
            commands = []
            def fail_create(argv, *args, **kwargs):
                commands.append(argv)
                if argv[:2] == ['docker', 'create']:
                    self.assertIn(str(folder / 'vendor') + ':/web/vendor:ro', argv)
                    self.assertEqual(argv[argv.index('--loop') + 1], 'asyncio')
                    self.assertIn('PYTHONPATH=/web/vendor:/web:/code', env.read_text())
                    raise installer.InstallError('simulated failure')
                if argv[:2] in (['docker', 'stop'], ['docker', 'rename'], ['docker', 'start']):
                    return types.SimpleNamespace(returncode=0, stdout='')
                raise AssertionError('unexpected command')
            with patch.multiple(installer, CODE=code, ENV=env, MARKER=marker, NGINX=nginx, BACKUP_ROOT=folder), \
                 patch.object(installer, 'vendor_bundle', return_value=folder / 'vendor'), \
                 patch.object(installer, 'atomic_write', side_effect=write), \
                 patch.object(installer, 'inspect', side_effect=lambda name: app if name == 'lr_app' else pg), \
                 patch.object(installer, 'psql', side_effect=sql), patch.object(installer, 'run', side_effect=fail_create):
                with self.assertRaises(installer.InstallError):
                    installer.install(pre, 'x' * 32)
            self.assertEqual(code.read_bytes(), old_code)
            self.assertEqual(env.read_bytes(), old_env)
            self.assertEqual(marker.read_bytes(), old_marker)
            self.assertEqual(nginx.read_bytes(), b'old nginx')
            self.assertIn(['docker', 'stop', '--time', '70', 'lr_web'], commands)
            self.assertIn(['docker', 'start', 'lr_web'], commands)
            self.assertTrue(all('lr_app' not in command and 'lr_postgres' not in command for command in commands))

    def test_dependency_bundle_failure_precedes_any_install_writes(self):
        app = {'Image': 'sha256:base'}
        pre = ('a' * 40, b'code', b'nginx', b'new nginx', app, {}, None, {}, True, (None, None, None),
               installer.PINNED_REQUIREMENTS, Path('/bundle'))
        with patch.object(installer, 'vendor_bundle', side_effect=installer.InstallError('missing bundle')), \
             patch.object(installer, 'atomic_write') as write, patch.object(installer, 'run') as run, \
             patch.object(Path, 'mkdir') as mkdir:
            with self.assertRaises(installer.InstallError):
                installer.install(pre, 'x' * 32)
            write.assert_not_called()
            run.assert_not_called()
            mkdir.assert_not_called()

    def test_role_privilege_audit_blocks_code_replacement(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            nginx = folder / 'nginx'
            nginx.write_bytes(b'old nginx')
            app = {'State': {'StartedAt': 'unchanged'}, 'Image': 'sha256:base'}
            pg = {'State': {'StartedAt': 'unchanged'}}
            pre = ('a' * 40, b'code', b'old nginx', b'new nginx', app, pg, None,
                   {'POSTGRES_DB': 'school', 'POSTGRES_HOST': 'db'}, True,
                   (None, b'POSTGRES_PASSWORD=old\n', None), installer.PINNED_REQUIREMENTS, folder / 'vendor')
            with patch.multiple(installer, NGINX=nginx, BACKUP_ROOT=folder), \
                 patch.object(installer, 'vendor_bundle', return_value=folder / 'vendor'), \
                 patch.object(installer, 'snapshot', side_effect=lambda p: None if p != installer.ENV else pre[9][1]), \
                 patch.object(installer, 'atomic_write') as write, \
                 patch.object(installer, 'inspect', side_effect=lambda name: app if name == 'lr_app' else pg), \
                 patch.object(installer, 'psql', return_value='1') as sql, patch.object(installer, 'run') as run:
                with self.assertRaises(installer.InstallError):
                    installer.install(pre, 'x' * 32)
                self.assertTrue(any('has_table_privilege' in c.args[1] for c in sql.call_args_list))
                self.assertTrue(all(c.args[0] not in (installer.CODE, installer.ENV, installer.MARKER) for c in write.call_args_list))
                run.assert_not_called()


if __name__ == '__main__':
    unittest.main()
