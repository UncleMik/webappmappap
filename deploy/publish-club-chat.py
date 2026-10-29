"""Publish the approved student chat from a pinned private archive on Timeweb."""
import fcntl
import hashlib
import json
import os
import pwd
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
NGINX = Path('/etc/nginx/sites-available/wep-pril-domain')
BACKEND = {'http.mjs', 'main.mjs', 'migrate.mjs', 'club-chat.mjs', 'club-chat-migration.sql'}
FRONTEND = {'club.html', 'club.js', 'club-chat.html', 'club-chat.js', 'club-api.js', 'club-access.js', 'club-chat-live.css'}
BLOCK = '''    location = /api/auth/club/messages {
        auth_request off;
        client_max_body_size 16k;
        proxy_pass http://127.0.0.1:3001;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

'''.encode()


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
        raise RuntimeError('UNEXPECTED_RELEASE_PATH')
    if any(p.is_symlink() for p in (path, *path.parents)) or path.resolve() != path:
        raise RuntimeError('UNSAFE_RELEASE_TARGET')
    return path


def atomic(path, data):
    temporary = path.with_name(path.name + '.club-release-' + uuid.uuid4().hex)
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
    for _ in range(30):
        try:
            with opener.open('http://127.0.0.1:3001/api/auth/session', timeout=3) as response:
                if json.load(response) == {'authenticated': False, 'user': None}:
                    return
        except (OSError, ValueError):
            pass
        time.sleep(.2)
    raise RuntimeError('AUTH_HEALTH_FAILED')


def connection():
    for line in Path('/etc/wep-pril/auth.env').read_text().splitlines():
        if line.startswith('AUTH_DATABASE_URL='):
            value = shlex.split(line.split('=', 1)[1], comments=False)[0]
            parts = urllib.parse.urlsplit(value)
            role = urllib.parse.unquote(parts.username or '')
            if parts.hostname not in ('localhost', '127.0.0.1', '::1') or not re.fullmatch('[a-z_][a-z0-9_]*', role):
                break
            return parts, role
    raise RuntimeError('PRIVATE_DATABASE_CONFIGURATION_REQUIRED')


def postgres_check(archive, payload, stage):
    suffix = uuid.uuid4().hex
    scratch = Path('/var/lib/postgresql') / ('wep-pril-club-qa-' + suffix)
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
    for name in ('auth-pool.mjs', 'club-chat.test.mjs'):
        data = archive.read('qa/' + name)
        if len(data) > 100_000 or digest(data) != json.loads(archive.read('manifest.json'))['qa'][name]:
            raise RuntimeError('QA_FILE_TOO_LARGE')
        (work / 'test' / name).write_bytes(data)
    parts, role = connection()
    database = 'wep_pril_club_' + suffix + '_test'
    marker = 'webpril-club-check-' + suffix
    admin = ['runuser', '-u', 'postgres', '--', 'psql', '-XqAt', '-v', 'ON_ERROR_STOP=1', '-d', 'postgres', '-c']
    run(admin + [f'CREATE DATABASE {database} OWNER {role}'])
    try:
        run(admin + [f"COMMENT ON DATABASE {database} IS '{marker}'"])
        # Existing OS peer authentication, without widening pg_hba.conf for a test DB.
        postgres = pwd.getpwnam('postgres')
        for path in [scratch, *scratch.rglob('*')]:
            if not path.is_symlink():
                os.chown(path, postgres.pw_uid, postgres.pw_gid)
        env = dict(os.environ, AUTH_TEST_DATABASE_URL='postgresql://postgres@localhost/' + database + '?host=%2Fvar%2Frun%2Fpostgresql')
        result = subprocess.run(['runuser', '-u', 'postgres', '--', 'node', '--test', 'test/club-chat.test.mjs'], cwd=work, env=env,
                                capture_output=True, timeout=180)
        (stage / 'postgres-check.log').write_bytes(result.stdout + result.stderr)
        if result.returncode:
            raise RuntimeError('CLUB_POSTGRES_CHECK_FAILED:' + str(stage))
    finally:
        found = run(admin + [f"SELECT shobj_description(oid,'pg_database') FROM pg_database WHERE datname='{database}'"]).stdout.decode().strip()
        if found != marker or not re.fullmatch('wep_pril_club_[a-f0-9]{32}_test', database):
            raise RuntimeError('TEMPORARY_DATABASE_MARKER_MISMATCH')
        run(admin + [f'DROP DATABASE {database}'])
    print('CLUB_POSTGRES_CHECK_OK', flush=True)


def main():
    os.umask(0o077)
    if os.geteuid() != 0 or len(sys.argv) not in (2, 3) or (len(sys.argv) == 3 and sys.argv[2] != '--apply'):
        raise RuntimeError('ROOT_AND_PRIVATE_ARCHIVE_REQUIRED')
    apply = len(sys.argv) == 3
    with open('/run/lock/wep-pril-club-release.lock', 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        with zipfile.ZipFile(sys.argv[1]) as archive:
            manifest = json.loads(archive.read('manifest.json'))
            if not re.fullmatch('[a-f0-9]{40}', manifest['revision']):
                raise RuntimeError('PINNED_REVISION_REQUIRED')
            expected = {'backend/auth/' + n for n in BACKEND} | {'Фронт/' + n for n in FRONTEND}
            if set(manifest['files']) != expected:
                raise RuntimeError('INCOMPLETE_RELEASE')
            before, payload = {}, {}
            for name, info in manifest['files'].items():
                path = target(name)
                before[name] = path.read_bytes() if path.exists() else None
                payload[name] = archive.read('payload/' + name)
                if digest(before[name]) != info['before'] or digest(payload[name]) != info['sha256']:
                    raise RuntimeError('SOURCE_MISMATCH:' + name)
            nginx_before = NGINX.read_bytes()
            if NGINX.is_symlink() or digest(nginx_before) != manifest['nginxBefore']:
                raise RuntimeError('NGINX_SOURCE_MISMATCH')
            anchor = b'    location ^~ /api/auth/ {'
            if nginx_before.count(anchor) != 1 or b'location = /api/auth/club/messages {' in nginx_before:
                raise RuntimeError('UNEXPECTED_NGINX_ROUTES')
            nginx_after = nginx_before.replace(anchor, BLOCK + anchor, 1)
            healthy()
            stage = Path('/root') / ('wep-pril-club-release-' + str(time.time_ns()))
            stage.mkdir(mode=0o700)
            (stage / 'manifest.json').write_text(json.dumps(manifest))
            postgres_check(archive, payload, stage)
        if not apply:
            print('CLUB_PREFLIGHT_OK')
            return
        backup_output = run(['python3', str(ROOT / 'deploy/backup.py')], timeout=1800).stdout.decode().strip()
        backup = Path(backup_output.splitlines()[-1])
        if backup.resolve().parent != (ROOT / 'backups').resolve() or not (backup / 'complete').is_file():
            raise RuntimeError('COMPLETE_BACKUP_REQUIRED')
        run(['python3', str(ROOT / 'deploy/verify-backup.py'), str(backup)], timeout=1800)
        print('CLUB_BACKUP_RESTORE_VERIFIED', flush=True)
        for i, (name, data) in enumerate(before.items()):
            if data is not None:
                (stage / str(i)).write_bytes(data)
        (stage / 'nginx.conf').write_bytes(nginx_before)
        _, role = connection()
        sql = ("BEGIN; SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s'; SET ROLE wep_pril_auth_owner;\n"
               + payload['backend/auth/club-chat-migration.sql'].decode()
               + f'\nGRANT SELECT,INSERT ON club_messages TO {role}; GRANT USAGE,SELECT ON SEQUENCE club_messages_id_seq TO {role};\nCOMMIT;')
        run(['runuser', '-u', 'postgres', '--', 'psql', '-XqAt', '-v', 'ON_ERROR_STOP=1', '-d', 'wep_pril_auth'], input=sql.encode())
        written = []
        try:
            for name in sorted(payload, key=lambda n: n.endswith('.html')):
                path = target(name)
                if (path.read_bytes() if path.exists() else None) != before[name]:
                    raise RuntimeError('CONCURRENT_CHANGE:' + name)
                atomic(path, payload[name])
                written.append(name)
            if NGINX.read_bytes() != nginx_before:
                raise RuntimeError('NGINX_CONCURRENT_CHANGE')
            atomic(NGINX, nginx_after)
            run(['nginx', '-t'])
            run(['systemctl', 'restart', 'wep-pril-auth'])
            healthy()
            run(['systemctl', 'reload', 'nginx'])
            if any(digest(target(n).read_bytes()) != manifest['files'][n]['sha256'] for n in payload):
                raise RuntimeError('FINAL_CHECKSUM_MISMATCH')
        except BaseException:
            # Additive schema and any saved chat messages survive code rollback.
            for name in reversed(written):
                path = target(name)
                if path.read_bytes() != payload[name]:
                    raise RuntimeError('ROLLBACK_CONCURRENT_CHANGE') from None
                if before[name] is None:
                    path.unlink()
                else:
                    atomic(path, before[name])
            if NGINX.read_bytes() == nginx_after:
                atomic(NGINX, nginx_before)
            run(['nginx', '-t'])
            run(['systemctl', 'restart', 'wep-pril-auth'])
            run(['systemctl', 'reload', 'nginx'])
            healthy()
            raise
        print('CLUB_RELEASE_OK revision=' + manifest['revision'] + ' backup=' + str(backup) + ' rollback=' + str(stage))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(str(error) if isinstance(error, RuntimeError) else 'CLUB_RELEASE_FAILED_CHECK_PRIVATE_STAGE', file=sys.stderr)
        sys.exit(1)
