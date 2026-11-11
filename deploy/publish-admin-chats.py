"""Publish admin chat moderation without changing the production database.

Usage: python3 publish-admin-chats.py private.zip [--apply]
The default runs hash checks and real PostgreSQL QA. Apply also verifies a
fresh backup restore and replaces the six approved files, with code rollback.
"""
import fcntl
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import pwd
import re
import shutil
import stat
import subprocess
import sys
import time
import urllib.request
import uuid
import zipfile

ROOT = Path('/opt/wep_pril')
FILES = {
    'backend/auth/admin.mjs', 'backend/auth/admin-http.mjs',
    'backend/auth/admin-chats.mjs', 'Фронт/admin/index.html',
    'Фронт/admin/panel.js', 'Фронт/admin/ui.css',
}
TESTS = ('test/admin.test.mjs', 'test/admin-chats.test.mjs', 'test/club-chat.test.mjs')
REQUIRED_QA = {'backend/' + n for n in TESTS} | {
    'backend/test/auth-pool.mjs', 'backend/package.json',
    'Фронт/admin/index.html', 'Фронт/admin/panel.js', 'Фронт/admin/ui.css',
    'Фронт/assets/auth-mother-v1.webp',
}
HASH = re.compile(r'[a-f0-9]{64}')


def digest(data):
    return hashlib.sha256(data).hexdigest() if data is not None else None


def run(args, stage, label, **options):
    """Keep subprocess output in the root-only stage, including timeout output."""
    try:
        result = subprocess.run(args, capture_output=True,
                                timeout=options.pop('timeout', 180), **options)
        (stage / (label + '.log')).write_bytes(result.stdout + result.stderr)
    except subprocess.TimeoutExpired as error:
        (stage / (label + '.log')).write_bytes((error.stdout or b'') + (error.stderr or b''))
        raise RuntimeError(label.upper() + '_TIMEOUT') from None
    if result.returncode:
        raise RuntimeError(label.upper() + '_FAILED')
    return result.stdout


def target(name):
    if name not in FILES:
        raise RuntimeError('UNEXPECTED_RELEASE_PATH')
    path = ROOT / name if name.startswith('backend/') else ROOT / 'admin-frontend' / Path(name).name
    if any(p.is_symlink() for p in (path, *path.parents)) or path.resolve() != path:
        raise RuntimeError('UNSAFE_RELEASE_TARGET')
    if not path.parent.is_dir() or (path.exists() and not path.is_file()):
        raise RuntimeError('MISSING_RELEASE_DIRECTORY_OR_INVALID_TARGET')
    return path


def current(name):
    path = target(name)
    return path.read_bytes() if path.exists() else None


def atomic(path, data):
    temporary = path.with_name(path.name + '.admin-chats-' + uuid.uuid4().hex)
    metadata = path.stat() if path.exists() else path.parent.stat()
    mode = path.stat().st_mode & 0o777 if path.exists() else 0o644
    try:
        with temporary.open('xb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, mode)
        os.chown(temporary, metadata.st_uid, metadata.st_gid)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def healthy():
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    for _ in range(40):
        try:
            with opener.open('http://127.0.0.1:3001/api/auth/session', timeout=3) as response:
                if json.load(response) == {'authenticated': False, 'user': None}:
                    return
        except (OSError, ValueError):
            pass
        time.sleep(.2)
    raise RuntimeError('AUTH_HEALTH_FAILED')


def qa_path(name):
    path = PurePosixPath(name)
    if str(path) != name or path.is_absolute() or any(p in ('..', '.', '') for p in name.split('/')) or '\\' in name:
        return False
    if any(p in ('node_modules', 'seed', 'env', '.git') or p.startswith('.') for p in path.parts):
        return False
    return ((name.startswith('backend/') and path.suffix in ('.mjs', '.sql'))
            or name == 'backend/package.json'
            or (name.startswith('Фронт/admin/') and path.suffix in ('.html', '.js', '.css', '.webp', '.svg', '.png'))
            or name == 'Фронт/assets/auth-mother-v1.webp')


def read_archive(filename):
    with zipfile.ZipFile(filename) as archive:
        entries = archive.infolist()
        names = [entry.filename for entry in entries]
        if len(names) > 1500 or len(set(names)) != len(names) or sum(e.file_size for e in entries) > 50_000_000:
            raise RuntimeError('UNSAFE_ARCHIVE_SIZE_OR_DUPLICATES')
        for entry in entries:
            if entry.file_size > 5_000_000 or entry.is_dir() or stat.S_ISLNK(entry.external_attr >> 16) or entry.flag_bits & 1:
                raise RuntimeError('UNSAFE_ARCHIVE_ENTRY')
        if 'manifest.json' not in names or archive.getinfo('manifest.json').file_size > 500_000:
            raise RuntimeError('MANIFEST_REQUIRED')
        manifest = json.loads(archive.read('manifest.json'))
        if not re.fullmatch('[a-f0-9]{40}', manifest['revision']) or set(manifest['files']) != FILES:
            raise RuntimeError('INCOMPLETE_PINNED_RELEASE')
        qa = manifest['qa']
        if not REQUIRED_QA <= set(qa) or not all(qa_path(n) for n in qa):
            raise RuntimeError('UNSAFE_OR_INCOMPLETE_QA_FILES')
        expected = {'manifest.json'} | {'payload/' + n for n in FILES} | {'qa/' + n for n in qa}
        if set(names) != expected:
            raise RuntimeError('UNEXPECTED_ARCHIVE_FILES')
        payload, baseline = {}, {}
        for name, info in manifest['files'].items():
            if set(info) != {'before', 'sha256'} or not HASH.fullmatch(info['sha256']) or (info['before'] is not None and not HASH.fullmatch(info['before'])):
                raise RuntimeError('INVALID_RELEASE_HASH')
            payload[name] = archive.read('payload/' + name)
            if digest(payload[name]) != info['sha256']:
                raise RuntimeError('PAYLOAD_CHECKSUM_MISMATCH:' + name)
        for name, checksum in qa.items():
            baseline[name] = archive.read('qa/' + name)
            if not HASH.fullmatch(checksum) or digest(baseline[name]) != checksum:
                raise RuntimeError('QA_CHECKSUM_MISMATCH:' + name)
        return manifest, payload, baseline


def postgres_check(baseline, payload, stage):
    suffix = uuid.uuid4().hex
    scratch = Path('/var/lib/postgresql') / ('wep-pril-admin-chats-qa-' + suffix)
    database = 'wep_pril_admin_chats_' + suffix + '_test'
    marker = 'webpril-admin-chats-check-' + suffix
    admin = ['runuser', '-u', 'postgres', '--', 'psql', '-XqAt', '-v', 'ON_ERROR_STOP=1', '-d', 'postgres', '-c']
    created = False
    try:
        scratch.mkdir(mode=0o700)
        # Copy only runtime code and SQL, never private env, seed data or uploads.
        shutil.copytree(ROOT / 'backend', scratch / 'backend',
                        ignore=lambda directory, names: [n for n in names if
                            (Path(directory) / n).is_symlink() or n in ('node_modules', 'seed', 'env', '.git')
                            or n.startswith('.') or ((Path(directory) / n).is_file()
                            and Path(n).suffix not in ('.mjs', '.sql') and n != 'package.json')])
        for name, data in {**baseline, **payload}.items():
            path = scratch / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        (scratch / 'backend/node_modules').symlink_to(ROOT / 'backend/node_modules', target_is_directory=True)
        postgres = pwd.getpwnam('postgres')
        for path in [scratch, *scratch.rglob('*')]:
            if not path.is_symlink():
                os.chown(path, postgres.pw_uid, postgres.pw_gid)
                os.chmod(path, 0o700 if path.is_dir() else 0o600)
        run(admin + [f'CREATE DATABASE {database}'], stage, 'qa-create')
        created = True
        run(admin + [f"COMMENT ON DATABASE {database} IS '{marker}'"], stage, 'qa-marker')
        env = {'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': str(scratch),
               'AUTH_TEST_DATABASE_URL': 'postgresql://postgres@localhost/' + database + '?host=%2Fvar%2Frun%2Fpostgresql'}
        run(['runuser', '-u', 'postgres', '--', 'node', '--test', *TESTS], stage,
            'postgres-check', cwd=scratch / 'backend', env=env, timeout=300)
    finally:
        if created:
            observed = run(admin + [f"SELECT shobj_description(oid,'pg_database') FROM pg_database WHERE datname='{database}'"], stage, 'qa-check-marker').decode().strip()
            if observed != marker or not re.fullmatch('wep_pril_admin_chats_[a-f0-9]{32}_test', database):
                raise RuntimeError('TEMPORARY_DATABASE_MARKER_MISMATCH')
            run(admin + [f'DROP DATABASE {database} WITH (FORCE)'], stage, 'qa-drop')
        if scratch.parent == Path('/var/lib/postgresql') and re.fullmatch('wep-pril-admin-chats-qa-[a-f0-9]{32}', scratch.name):
            shutil.rmtree(scratch, ignore_errors=False)
    print('ADMIN_CHATS_POSTGRES_CHECK_OK', flush=True)


def main():
    os.umask(0o077)
    if os.geteuid() != 0 or len(sys.argv) not in (2, 3) or (len(sys.argv) == 3 and sys.argv[2] != '--apply'):
        raise RuntimeError('ROOT_AND_PRIVATE_ARCHIVE_REQUIRED')
    with open('/run/lock/wep-pril-club-release.lock', 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        stage = Path('/root') / ('wep-pril-admin-chats-release-' + uuid.uuid4().hex)
        stage.mkdir(mode=0o700)
        print('ADMIN_CHATS_PRIVATE_STAGE=' + str(stage), flush=True)
        manifest, payload, baseline = read_archive(sys.argv[1])
        before = {name: current(name) for name in FILES}
        for name, data in before.items():
            if digest(data) != manifest['files'][name]['before']:
                raise RuntimeError('SOURCE_MISMATCH:' + name)
        (stage / 'manifest.json').write_text(json.dumps(manifest))
        healthy()
        postgres_check(baseline, payload, stage)
        if len(sys.argv) == 2:
            print('ADMIN_CHATS_PREFLIGHT_OK revision=' + manifest['revision'])
            return
        backup_output = run(['python3', str(ROOT / 'deploy/backup.py')], stage, 'backup', timeout=1800).decode().strip()
        backup = Path(backup_output.splitlines()[-1])
        if backup.resolve().parent != (ROOT / 'backups').resolve() or not (backup / 'complete').is_file():
            raise RuntimeError('COMPLETE_BACKUP_REQUIRED')
        run(['python3', str(ROOT / 'deploy/verify-backup.py'), str(backup)], stage, 'verify-backup', timeout=1800)
        print('ADMIN_CHATS_BACKUP_RESTORE_VERIFIED', flush=True)
        for name, data in before.items():
            if current(name) != data:
                raise RuntimeError('CONCURRENT_CHANGE:' + name)
            if data is not None:
                saved = stage / 'before' / name
                saved.parent.mkdir(parents=True, exist_ok=True)
                saved.write_bytes(data)
        written = []
        try:
            for name in sorted(payload, key=lambda n: n.endswith('.html')):
                if current(name) != before[name]:
                    raise RuntimeError('CONCURRENT_CHANGE:' + name)
                atomic(target(name), payload[name])
                written.append(name)
            run(['systemctl', 'restart', 'wep-pril-auth'], stage, 'restart')
            healthy()
            if any(digest(current(n)) != manifest['files'][n]['sha256'] for n in payload):
                raise RuntimeError('FINAL_CHECKSUM_MISMATCH')
        except BaseException:
            for name in reversed(written):
                if current(name) != payload[name]:
                    raise RuntimeError('ROLLBACK_CONCURRENT_CHANGE:' + name) from None
                if before[name] is None:
                    target(name).unlink()
                else:
                    atomic(target(name), before[name])
            run(['systemctl', 'restart', 'wep-pril-auth'], stage, 'rollback-restart')
            healthy()
            raise
        print('ADMIN_CHATS_RELEASE_OK revision=' + manifest['revision'] + ' backup=' + str(backup) + ' rollback=' + str(stage))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(str(error) if isinstance(error, RuntimeError) else 'ADMIN_CHATS_RELEASE_FAILED_CHECK_PRIVATE_STAGE', file=sys.stderr)
        sys.exit(1)
