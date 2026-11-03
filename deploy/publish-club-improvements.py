"""Publish club recovery, unread positions and full-history navigation from a hash-pinned private archive.

Usage: python3 publish-club-improvements.py /root/club-improvements.zip [--apply]
Dry run validates source hashes and runs the real PostgreSQL tests. Apply also
verifies a fresh backup restore, adds the reading table, and atomically replaces code.
Code rollback preserves messages, reactions, reading positions and all other production data.
"""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pwd
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
BACKEND = {'club-chat.mjs', 'http.mjs', 'migrate.mjs', 'club-reading-migration.sql'}
FRONTEND = {'club-chat.html', 'club-chat.js', 'club-chat-tools.js', 'club-chat-timeline.js', 'club-message-actions.js', 'club-chat-improvements.css', 'club-access.js', 'club.html'}
QA = {'auth-pool.mjs', 'club-chat.test.mjs'}
NEW_FILES = {'backend/auth/club-reading-migration.sql', 'Фронт/club-chat-tools.js', 'Фронт/club-chat-timeline.js', 'Фронт/club-chat-improvements.css'}
INSTALLED_SQL = {'schema.sql', 'single-session-migration.sql', 'club-chat-migration.sql',
                 'club-delete-migration.sql', 'chat-reactions-migration.sql', 'chat-reactions-extra-migration.sql'}


def digest(data):
    return hashlib.sha256(data).hexdigest() if data is not None else None


def run(args, **options):
    return subprocess.run(args, check=True, capture_output=True,
                          timeout=options.pop('timeout', 120), **options)


def target(name):
    if name.startswith('backend/auth/') and name[13:] in BACKEND:
        path = ROOT / name
    elif name.startswith('Фронт/') and name[6:] in FRONTEND:
        path = ROOT / 'frontend' / name[6:]
    else:
        raise RuntimeError('CLUB_IMPROVEMENTS_UNEXPECTED_RELEASE_PATH')
    if any(p.is_symlink() for p in (path, *path.parents)) or path.resolve() != path:
        raise RuntimeError('CLUB_IMPROVEMENTS_UNSAFE_RELEASE_TARGET')
    return path


def atomic(path, data):
    temporary = path.with_name(path.name + '.club-improvements-' + uuid.uuid4().hex)
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
    raise RuntimeError('CLUB_IMPROVEMENTS_AUTH_HEALTH_FAILED')


def runtime_role():
    for line in Path('/etc/wep-pril/auth.env').read_text().splitlines():
        if line.startswith('AUTH_DATABASE_URL='):
            parts = urllib.parse.urlsplit(shlex.split(line.split('=', 1)[1], comments=False)[0])
            role = urllib.parse.unquote(parts.username or '')
            if (parts.hostname in ('localhost', '127.0.0.1', '::1') and parts.path == '/wep_pril_auth'
                    and re.fullmatch('[a-z_][a-z0-9_]*', role)):
                return role
    raise RuntimeError('CLUB_IMPROVEMENTS_PRIVATE_DATABASE_CONFIGURATION_REQUIRED')


def postgres_check(archive, manifest, payload, stage):
    # The release overlays current installed auth sources; it does not bring an
    # older schema snapshot or rerun deletion/reaction migrations on production.
    for name in INSTALLED_SQL:
        path = ROOT / 'backend/auth' / name
        if not path.is_file() or any(p.is_symlink() for p in (path, *path.parents)):
            raise RuntimeError('CLUB_IMPROVEMENTS_INSTALLED_SQL_REQUIRED:' + name)
    suffix = uuid.uuid4().hex
    scratch = Path('/var/lib/postgresql') / ('wep-pril-club-improvements-qa-' + suffix)
    work = scratch / 'backend'
    work.mkdir(parents=True)
    shutil.copytree(ROOT / 'backend/auth', work / 'auth')
    shutil.copyfile(ROOT / 'backend/course-entitlements.mjs', work / 'course-entitlements.mjs')
    shutil.copyfile(ROOT / 'backend/package.json', work / 'package.json')
    (work / 'node_modules').symlink_to(ROOT / 'backend/node_modules', target_is_directory=True)
    (work / 'test').mkdir()
    for name, data in payload.items():
        if name.startswith('backend/auth/'):
            (work / 'auth' / Path(name).name).write_bytes(data)
    if set(manifest['qa']) != QA:
        raise RuntimeError('CLUB_IMPROVEMENTS_INCOMPLETE_QA_FILES')
    for name in QA:
        data = archive.read('qa/' + name)
        if len(data) > 100_000 or digest(data) != manifest['qa'][name]:
            raise RuntimeError('CLUB_IMPROVEMENTS_QA_CHECKSUM_MISMATCH')
        (work / 'test' / name).write_bytes(data)
    # Stay below PostgreSQL's 63-byte identifier limit, keeping the _test guard.
    database = 'wep_pril_club_ui_' + suffix + '_test'
    marker = 'webpril-club-improvements-check-' + suffix
    admin = ['runuser', '-u', 'postgres', '--', 'psql', '-XqAt', '-v', 'ON_ERROR_STOP=1', '-d', 'postgres', '-c']
    role = runtime_role()
    run(admin + [f'CREATE DATABASE {database} OWNER {role}'])
    try:
        run(admin + [f"COMMENT ON DATABASE {database} IS '{marker}'"])
        postgres = pwd.getpwnam('postgres')
        for path in [scratch, *scratch.rglob('*')]:
            if not path.is_symlink():
                os.chown(path, postgres.pw_uid, postgres.pw_gid)
        env = dict(os.environ, AUTH_TEST_DATABASE_URL='postgresql://postgres@localhost/' + database + '?host=%2Fvar%2Frun%2Fpostgresql')
        result = subprocess.run(['runuser', '-u', 'postgres', '--', 'node', '--test', 'test/club-chat.test.mjs'],
                                cwd=work, env=env, capture_output=True, timeout=180)
        (stage / 'postgres-check.log').write_bytes(result.stdout + result.stderr)
        if result.returncode:
            raise RuntimeError('CLUB_IMPROVEMENTS_POSTGRES_CHECK_FAILED:' + str(stage))
    finally:
        observed = run(admin + [f"SELECT shobj_description(oid,'pg_database') FROM pg_database WHERE datname='{database}'"]).stdout.decode().strip()
        if observed != marker or not re.fullmatch('wep_pril_club_ui_[a-f0-9]{32}_test', database):
            raise RuntimeError('CLUB_IMPROVEMENTS_TEMPORARY_DATABASE_MARKER_MISMATCH')
        run(admin + [f'DROP DATABASE {database}'])
        if scratch.parent == Path('/var/lib/postgresql') and re.fullmatch('wep-pril-club-improvements-qa-[a-f0-9]{32}', scratch.name):
            shutil.rmtree(scratch)
    print('CLUB_IMPROVEMENTS_POSTGRES_CHECK_OK', flush=True)


def main():
    os.umask(0o077)
    if os.geteuid() != 0 or len(sys.argv) not in (2, 3) or (len(sys.argv) == 3 and sys.argv[2] != '--apply'):
        raise RuntimeError('CLUB_IMPROVEMENTS_ROOT_AND_PRIVATE_ARCHIVE_REQUIRED')
    with open('/run/lock/wep-pril-club-release.lock', 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        with zipfile.ZipFile(sys.argv[1]) as archive:
            manifest = json.loads(archive.read('manifest.json'))
            if not re.fullmatch('[a-f0-9]{40}', manifest['revision']):
                raise RuntimeError('CLUB_IMPROVEMENTS_PINNED_REVISION_REQUIRED')
            if set(manifest['files']) != {'backend/auth/' + n for n in BACKEND} | {'Фронт/' + n for n in FRONTEND}:
                raise RuntimeError('CLUB_IMPROVEMENTS_INCOMPLETE_RELEASE')
            before, payload = {}, {}
            for name, info in manifest['files'].items():
                path = target(name)
                before[name] = path.read_bytes() if path.exists() else None
                if before[name] is None and name not in NEW_FILES:
                    raise RuntimeError('CLUB_IMPROVEMENTS_INSTALLED_FILE_REQUIRED:' + name)
                payload[name] = archive.read('payload/' + name)
                if len(payload[name]) > 200_000 or digest(before[name]) != info['before'] or digest(payload[name]) != info['sha256']:
                    raise RuntimeError('CLUB_IMPROVEMENTS_SOURCE_MISMATCH:' + name)
            healthy()
            stage = Path('/root') / ('wep-pril-club-improvements-release-' + str(time.time_ns()))
            stage.mkdir(mode=0o700)
            (stage / 'manifest.json').write_text(json.dumps(manifest))
            postgres_check(archive, manifest, payload, stage)
        if len(sys.argv) == 2:
            print('CLUB_IMPROVEMENTS_PREFLIGHT_OK')
            return
        backup_output = run(['python3', str(ROOT / 'deploy/backup.py')], timeout=1800).stdout.decode().strip()
        backup = Path(backup_output.splitlines()[-1])
        if backup.resolve().parent != (ROOT / 'backups').resolve() or not (backup / 'complete').is_file():
            raise RuntimeError('CLUB_IMPROVEMENTS_COMPLETE_BACKUP_REQUIRED')
        run(['python3', str(ROOT / 'deploy/verify-backup.py'), str(backup)], timeout=1800)
        print('CLUB_IMPROVEMENTS_BACKUP_RESTORE_VERIFIED', flush=True)
        for i, (name, data) in enumerate(before.items()):
            if data is not None:
                (stage / str(i)).write_bytes(data)
        role = runtime_role()
        sql = ("BEGIN; SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s'; SET ROLE wep_pril_auth_owner;\n"
               + payload['backend/auth/club-reading-migration.sql'].decode()
               + f'\nGRANT SELECT,INSERT,UPDATE ON club_reading TO {role};\nCOMMIT;')
        run(['runuser', '-u', 'postgres', '--', 'psql', '-XqAt', '-v', 'ON_ERROR_STOP=1', '-d', 'wep_pril_auth'], input=sql.encode())
        # Exercise the runtime privileges using zero-row operations only. No cursor,
        # message, reaction or account is added, advanced or deleted by this probe.
        probe = (f"BEGIN; SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='10s'; SET LOCAL ROLE {role};\n"
                 'SELECT r.last_read_id FROM club_reading r JOIN club_state s ON s.room=r.room LIMIT 0;\n'
                 'INSERT INTO club_reading(user_id,room,last_read_id) '
                 "SELECT author_id,room,id FROM club_messages WHERE false "
                 'ON CONFLICT(user_id,room) DO UPDATE SET last_read_id=GREATEST(club_reading.last_read_id,excluded.last_read_id);\n'
                 'UPDATE club_reading SET last_read_id=last_read_id WHERE false; ROLLBACK;')
        run(['runuser', '-u', 'postgres', '--', 'psql', '-XqAt', '-v', 'ON_ERROR_STOP=1', '-d', 'wep_pril_auth'], input=probe.encode())
        print('CLUB_IMPROVEMENTS_RUNTIME_ROLE_PROBE_OK', flush=True)
        written = []
        try:
            for name in sorted(payload, key=lambda n: n.endswith('.html')):
                path = target(name)
                if (path.read_bytes() if path.exists() else None) != before[name]:
                    raise RuntimeError('CLUB_IMPROVEMENTS_CONCURRENT_CHANGE:' + name)
                atomic(path, payload[name]); written.append(name)
            run(['systemctl', 'restart', 'wep-pril-auth'])
            healthy()
            if any(digest(target(n).read_bytes()) != manifest['files'][n]['sha256'] for n in payload):
                raise RuntimeError('CLUB_IMPROVEMENTS_FINAL_CHECKSUM_MISMATCH')
        except BaseException:
            for name in reversed(written):
                path = target(name)
                if path.read_bytes() != payload[name]:
                    raise RuntimeError('CLUB_IMPROVEMENTS_ROLLBACK_CONCURRENT_CHANGE') from None
                if before[name] is None:
                    path.unlink()
                else:
                    atomic(path, before[name])
            run(['systemctl', 'restart', 'wep-pril-auth']); healthy()
            raise
        print('CLUB_IMPROVEMENTS_RELEASE_OK revision=' + manifest['revision'] + ' backup=' + str(backup) + ' rollback=' + str(stage))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(str(error) if isinstance(error, RuntimeError) else 'CLUB_IMPROVEMENTS_RELEASE_FAILED_CHECK_PRIVATE_STAGE', file=sys.stderr)
        sys.exit(1)
