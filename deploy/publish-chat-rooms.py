"""Publish the combined chat-room and Lara module/failure release from a hash-pinned archive.

Usage: python3 publish-chat-rooms.py /root/chat-rooms.zip [--apply]
Dry run validates source hashes and runs the real PostgreSQL tests. Apply also
verifies a fresh backup restore, adds seven room states and an AI failure column, and atomically replaces code.
Code rollback preserves messages, reactions, reading positions and all other production data.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import sys
import time
import urllib.parse
import urllib.request
import uuid
import zipfile

ROOT = Path('/opt/wep_pril')
BACKEND = {'club-chat.mjs', 'http.mjs', 'main.mjs', 'migrate.mjs', 'club-rooms-migration.sql', 'ai-chat.mjs', 'ai-failure-migration.sql'}
ROOT_BACKEND = {'course-materials.mjs'}
FRONTEND = {'ai.js', 'ai.html', 'ai.css', 'club.html', 'club.js', 'club.css', 'club-access.js',
            'club-api.js', 'club-chat.js', 'club-chat-tools.js', 'club-rooms.js', 'club-chat.html'}
QA = {'auth-pool.mjs', 'club-chat.test.mjs', 'ai-chat.test.mjs', 'course-materials.test.mjs'}
NEW_FILES = {'backend/auth/club-rooms-migration.sql', 'backend/auth/ai-failure-migration.sql', 'Фронт/club-rooms.js'}
INSTALLED_SQL = {'schema.sql', 'single-session-migration.sql', 'club-chat-migration.sql',
                 'club-delete-migration.sql', 'chat-reactions-migration.sql', 'chat-reactions-extra-migration.sql',
                 'club-reading-migration.sql', 'ai-chat-migration.sql'}
FILES = {'backend/auth/' + n for n in BACKEND} | {'backend/' + n for n in ROOT_BACKEND} | {'Фронт/' + n for n in FRONTEND}



def digest(data):
    return hashlib.sha256(data).hexdigest() if data is not None else None


def run(args, **options):
    return subprocess.run(args, check=True, capture_output=True,
                          timeout=options.pop('timeout', 120), **options)


def target(name):
    if name.startswith('backend/auth/') and name[13:] in BACKEND:
        path = ROOT / name
    elif name.startswith('backend/') and name[8:] in ROOT_BACKEND:
        path = ROOT / name
    elif name.startswith('Фронт/') and name[6:] in FRONTEND:
        path = ROOT / 'frontend' / name[6:]
    else:
        raise RuntimeError('CHAT_ROOMS_UNEXPECTED_RELEASE_PATH')
    if any(p.is_symlink() for p in (path, *path.parents)) or path.resolve() != path:
        raise RuntimeError('CHAT_ROOMS_UNSAFE_RELEASE_TARGET')
    return path


def atomic(path, data):
    temporary = path.with_name(path.name + '.chat-rooms-' + uuid.uuid4().hex)
    metadata = path.stat() if path.exists() else None
    try:
        with temporary.open('xb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, metadata.st_mode & 0o777 if metadata else 0o644)
        if metadata:
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
    raise RuntimeError('CHAT_ROOMS_AUTH_HEALTH_FAILED')


def runtime_role():
    for line in Path('/etc/wep-pril/auth.env').read_text().splitlines():
        if line.startswith('AUTH_DATABASE_URL='):
            parts = urllib.parse.urlsplit(shlex.split(line.split('=', 1)[1], comments=False)[0])
            role = urllib.parse.unquote(parts.username or '')
            if (parts.hostname in ('localhost', '127.0.0.1', '::1') and parts.path == '/wep_pril_auth'
                    and re.fullmatch('[a-z_][a-z0-9_]*', role)):
                return role
    raise RuntimeError('CHAT_ROOMS_PRIVATE_DATABASE_CONFIGURATION_REQUIRED')


def postgres_check(archive, manifest, payload, stage):
    import pwd
    # The release overlays current installed auth sources; it does not bring an
    # older schema snapshot or rerun deletion/reaction migrations on production.
    for name in INSTALLED_SQL:
        path = ROOT / 'backend/auth' / name
        if not path.is_file() or any(p.is_symlink() for p in (path, *path.parents)):
            raise RuntimeError('CHAT_ROOMS_INSTALLED_SQL_REQUIRED:' + name)
    suffix = uuid.uuid4().hex
    scratch = Path('/var/lib/postgresql') / ('wep-pril-chat-rooms-qa-' + suffix)
    work = scratch / 'backend'
    work.mkdir(parents=True)
    (work / 'auth').mkdir()
    # Copy source dependencies only. No environment, configuration or private data.
    for source in (ROOT / 'backend/auth').iterdir():
        if source.suffix in {'.mjs', '.sql'}:
            if not source.is_file() or source.is_symlink():
                raise RuntimeError('CHAT_ROOMS_UNSAFE_QA_SOURCE')
            shutil.copyfile(source, work / 'auth' / source.name)
    for name in ['course-entitlements.mjs', 'course-materials.mjs', 'course-video-links.mjs']:
        source = ROOT / 'backend' / name
        if not source.is_file() or source.is_symlink():
            raise RuntimeError('CHAT_ROOMS_INSTALLED_DEPENDENCY_REQUIRED:' + name)
        shutil.copyfile(source, work / name)
    shutil.copyfile(ROOT / 'backend/package.json', work / 'package.json')
    (work / 'node_modules').symlink_to(ROOT / 'backend/node_modules', target_is_directory=True)
    (work / 'test').mkdir()
    for name, data in payload.items():
        if name.startswith('backend/'):
            (work / name[8:]).write_bytes(data)
    if set(manifest['qa']) != QA:
        raise RuntimeError('CHAT_ROOMS_INCOMPLETE_QA_FILES')
    for name in QA:
        data = archive.read('qa/' + name)
        if len(data) > 300_000 or digest(data) != manifest['qa'][name]:
            raise RuntimeError('CHAT_ROOMS_QA_CHECKSUM_MISMATCH')
        (work / 'test' / name).write_bytes(data)
    # Stay below PostgreSQL's 63-byte identifier limit, keeping the _test guard.
    database = 'wep_pril_chat_rooms_' + suffix + '_test'
    marker = 'webpril-chat-rooms-check-' + suffix
    admin = ['runuser', '-u', 'postgres', '--', 'psql', '-XqAt', '-v', 'ON_ERROR_STOP=1', '-d', 'postgres', '-c']
    run(admin + [f'CREATE DATABASE {database} OWNER postgres'])
    try:
        run(admin + [f"COMMENT ON DATABASE {database} IS '{marker}'"])
        postgres = pwd.getpwnam('postgres')
        for path in [scratch, *scratch.rglob('*')]:
            if not path.is_symlink():
                os.chown(path, postgres.pw_uid, postgres.pw_gid)
        env = {'PATH': os.environ.get('PATH', '/usr/local/bin:/usr/bin:/bin'), 'LANG': 'C.UTF-8',
               'HOME': '/var/lib/postgresql',
               'AUTH_TEST_DATABASE_URL': 'postgresql://postgres@localhost/' + database + '?host=%2Fvar%2Frun%2Fpostgresql'}
        result = subprocess.run(['runuser', '-u', 'postgres', '--', 'node', '--test', 'test/club-chat.test.mjs', 'test/ai-chat.test.mjs', 'test/course-materials.test.mjs'],
                                cwd=work, env=env, capture_output=True, timeout=180)
        (stage / 'postgres-check.log').write_bytes(result.stdout + result.stderr)
        if result.returncode:
            raise RuntimeError('CHAT_ROOMS_POSTGRES_CHECK_FAILED:' + str(stage))
    finally:
        observed = run(admin + [f"SELECT shobj_description(oid,'pg_database') FROM pg_database WHERE datname='{database}'"]).stdout.decode().strip()
        if observed != marker or not re.fullmatch('wep_pril_chat_rooms_[a-f0-9]{32}_test', database):
            raise RuntimeError('CHAT_ROOMS_TEMPORARY_DATABASE_MARKER_MISMATCH')
        run(admin + [f'DROP DATABASE {database}'])
        if scratch.parent == Path('/var/lib/postgresql') and re.fullmatch('wep-pril-chat-rooms-qa-[a-f0-9]{32}', scratch.name):
            shutil.rmtree(scratch)
    print('CHAT_ROOMS_POSTGRES_CHECK_OK', flush=True)


def read_archive(archive):
    expected = {'manifest.json'} | {'payload/' + name for name in FILES} | {'qa/' + name for name in QA}
    if set(archive.namelist()) != expected or len(archive.namelist()) != len(expected):
        raise RuntimeError('CHAT_ROOMS_INVALID_ARCHIVE_MEMBERS')
    if any(info.file_size > 300_000 for info in archive.infolist()):
        raise RuntimeError('CHAT_ROOMS_ARCHIVE_MEMBER_TOO_LARGE')
    manifest = json.loads(archive.read('manifest.json'))
    if not re.fullmatch('[a-f0-9]{40}', manifest.get('revision', '')):
        raise RuntimeError('CHAT_ROOMS_PINNED_REVISION_REQUIRED')
    if set(manifest.get('files', {})) != FILES or set(manifest.get('qa', {})) != QA:
        raise RuntimeError('CHAT_ROOMS_INCOMPLETE_RELEASE')
    before, payload = {}, {}
    for name, info in manifest['files'].items():
        path = target(name)
        before[name] = path.read_bytes() if path.exists() else None
        if before[name] is None and name not in NEW_FILES:
            raise RuntimeError('CHAT_ROOMS_INSTALLED_FILE_REQUIRED:' + name)
        payload[name] = archive.read('payload/' + name)
        if digest(before[name]) != info['before'] or digest(payload[name]) != info['sha256']:
            raise RuntimeError('CHAT_ROOMS_SOURCE_MISMATCH:' + name)
    for name in QA:
        if digest(archive.read('qa/' + name)) != manifest['qa'][name]:
            raise RuntimeError('CHAT_ROOMS_QA_CHECKSUM_MISMATCH:' + name)
    return manifest, before, payload


def verify_backup():
    backup_output = run(['python3', str(ROOT / 'deploy/backup.py')], timeout=1800).stdout.decode().strip()
    backup = Path(backup_output.splitlines()[-1])
    if backup.resolve().parent != (ROOT / 'backups').resolve() or not (backup / 'complete').is_file():
        raise RuntimeError('CHAT_ROOMS_COMPLETE_BACKUP_REQUIRED')
    run(['python3', str(ROOT / 'deploy/verify-backup.py'), str(backup)], timeout=1800)
    print('CHAT_ROOMS_BACKUP_RESTORE_VERIFIED', flush=True)
    return backup


def migrate(payload):
    # No new tables: existing runtime grants remain sufficient. DDL never runs
    # under the application role. Baseline migrations never run on production.
    sql = ("BEGIN; SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s'; SET LOCAL ROLE wep_pril_auth_owner;\n"
           + payload['backend/auth/club-rooms-migration.sql'].decode()
           + '\n' + payload['backend/auth/ai-failure-migration.sql'].decode() + '\nCOMMIT;')
    run(['runuser', '-u', 'postgres', '--', 'psql', '-XqAt', '-v', 'ON_ERROR_STOP=1', '-d', 'wep_pril_auth'], input=sql.encode())
    role = runtime_role()
    probe = (f"BEGIN; SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='10s'; SET LOCAL ROLE {role};\n"
             'SELECT failure_code FROM ai_chat_requests LIMIT 0;\n'
             'SELECT room,revision FROM club_state LIMIT 0;\n'
             'UPDATE ai_chat_requests SET failure_code=failure_code WHERE false;\n'
             'UPDATE club_state SET revision=revision WHERE false;\n'
             "SELECT pg_advisory_xact_lock(hashtext('webpril-chat-rooms-privilege-check'));\n"
             'ROLLBACK;')
    run(['runuser', '-u', 'postgres', '--', 'psql', '-XqAt', '-v', 'ON_ERROR_STOP=1', '-d', 'wep_pril_auth'], input=probe.encode())
    print('CHAT_ROOMS_RUNTIME_ROLE_PROBE_OK', flush=True)


def apply_release(manifest, before, payload, stage):
    backup = verify_backup()
    for i, (name, data) in enumerate(before.items()):
        if data is not None:
            (stage / str(i)).write_bytes(data)
    # Reconcile the installed hashes once more before changing the schema.
    for name, data in before.items():
        if (target(name).read_bytes() if target(name).exists() else None) != data:
            raise RuntimeError('CHAT_ROOMS_CONCURRENT_CHANGE:' + name)
    migrate(payload)
    written = []
    try:
        for name in sorted(payload, key=lambda n: n.endswith('.html')):
            path = target(name)
            if (path.read_bytes() if path.exists() else None) != before[name]:
                raise RuntimeError('CHAT_ROOMS_CONCURRENT_CHANGE:' + name)
            atomic(path, payload[name]); written.append(name)
        run(['systemctl', 'restart', 'wep-pril-auth'])
        healthy()
        run(['systemctl', 'is-active', 'wep-pril-auth', 'wep-pril'])
        if any(digest(target(n).read_bytes()) != manifest['files'][n]['sha256'] for n in payload):
            raise RuntimeError('CHAT_ROOMS_FINAL_CHECKSUM_MISMATCH')
    except BaseException:
        for name in reversed(written):
            path = target(name)
            if path.read_bytes() != payload[name]:
                raise RuntimeError('CHAT_ROOMS_ROLLBACK_CONCURRENT_CHANGE') from None
            if before[name] is None:
                path.unlink()
            else:
                atomic(path, before[name])
        run(['systemctl', 'restart', 'wep-pril-auth']); healthy()
        raise
    (stage / 'installed-checksums.json').write_text(json.dumps({name: {'before': digest(before[name]),
        'after': digest(target(name).read_bytes())} for name in payload}, ensure_ascii=False, indent=2))
    print('CHAT_ROOMS_RELEASE_OK revision=' + manifest['revision'] + ' backup=' + str(backup) + ' rollback=' + str(stage))


def main():
    import fcntl
    from contextlib import ExitStack
    os.umask(0o077)
    if os.geteuid() != 0 or len(sys.argv) not in (2, 3) or (len(sys.argv) == 3 and sys.argv[2] != '--apply'):
        raise RuntimeError('CHAT_ROOMS_ROOT_AND_PRIVATE_ARCHIVE_REQUIRED')
    with ExitStack() as stack:
        for name in ['club', 'ai']:
            lock = stack.enter_context(open('/run/lock/wep-pril-' + name + '-release.lock', 'w'))
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        with zipfile.ZipFile(sys.argv[1]) as archive:
            manifest, before, payload = read_archive(archive)
            healthy()
            for name, data in payload.items():
                if name.endswith(('.mjs', '.js')):
                    run(['node', '--input-type=module', '--check'], input=data)
            stage = Path('/root') / ('wep-pril-chat-rooms-release-' + str(time.time_ns()))
            stage.mkdir(mode=0o700)
            (stage / 'manifest.json').write_text(json.dumps(manifest))
            postgres_check(archive, manifest, payload, stage)
        if len(sys.argv) == 2:
            print('CHAT_ROOMS_PREFLIGHT_OK')
            return
        apply_release(manifest, before, payload, stage)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(str(error) if isinstance(error, RuntimeError) else 'CHAT_ROOMS_RELEASE_FAILED_CHECK_PRIVATE_STAGE', file=sys.stderr)
        sys.exit(1)
