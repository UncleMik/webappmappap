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
    def archive(self, path, names=None, bad_hash=False):
        code = b'print("example")\n'
        manifest = {'revision': 'a' * 40, 'files': {installer.APP_PATH: ('0' * 64 if bad_hash else hashlib.sha256(code).hexdigest())}}
        with zipfile.ZipFile(path, 'w') as z:
            z.writestr('manifest.json', json.dumps(manifest))
            z.writestr('payload/' + installer.APP_PATH, code)
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
        with self.assertRaises(installer.InstallError):
            installer.patch_nginx(NGINX + NGINX)
        with self.assertRaises(installer.InstallError):
            installer.patch_nginx(result.replace('deny all;', 'allow all;'))
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
            pre = ('a' * 40, b'new code', b'old nginx', b'new nginx', app, pg, None,
                   {'POSTGRES_DB': 'school', 'POSTGRES_HOST': 'db'}, True, (old_code, old_env, old_marker))
            def write(path, data, mode):
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(data)
            def sql(_, query, *args):
                return '0' if 'pg_class c' in query else '1'
            def fail_create(argv, *args, **kwargs):
                if argv[:2] == ['docker', 'create']:
                    raise installer.InstallError('simulated failure')
                raise AssertionError('unexpected command')
            with patch.multiple(installer, CODE=code, ENV=env, MARKER=marker, NGINX=nginx, BACKUP_ROOT=folder), \
                 patch.object(installer, 'atomic_write', side_effect=write), \
                 patch.object(installer, 'inspect', side_effect=lambda name: app if name == 'lr_app' else pg), \
                 patch.object(installer, 'psql', side_effect=sql), patch.object(installer, 'run', side_effect=fail_create):
                with self.assertRaises(installer.InstallError):
                    installer.install(pre, 'x' * 32)
            self.assertEqual(code.read_bytes(), old_code)
            self.assertEqual(env.read_bytes(), old_env)
            self.assertEqual(marker.read_bytes(), old_marker)
            self.assertEqual(nginx.read_bytes(), b'old nginx')


if __name__ == '__main__':
    unittest.main()
