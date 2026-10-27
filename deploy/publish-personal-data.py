"""Apply a hash-pinned personal-data release from a private ZIP on Timeweb.

Usage: python3 publish-personal-data.py /root/release.zip [--apply]
The ZIP has manifest.json {revision,files:{repo_path:{before,sha256}}} and
payload/<repo_path>. No arbitrary ZIP extraction or database rollback occurs.
"""
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import urllib.request
import zipfile

ROOT = Path('/opt/wep_pril')
NGINX = Path('/etc/nginx/sites-available/wep-pril-domain')


def digest(value):
    return hashlib.sha256(value).hexdigest() if value is not None else None


def run(args, **kwargs):
    timeout = kwargs.pop('timeout', 120)
    return subprocess.run(args, check=True, stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, timeout=timeout, **kwargs)


def target(name):
    if name.startswith('Фронт/'):
        path = ROOT / 'frontend' / name[6:]
    elif name.startswith(('backend/auth/', 'deploy/')):
        path = ROOT / name
    else:
        raise RuntimeError('UNEXPECTED_RELEASE_PATH')
    if '..' in Path(name).parts or path.is_symlink() or path.resolve() != path:
        raise RuntimeError('UNSAFE_RELEASE_PATH')
    return path


def atomic(path, data):
    temporary = path.with_name(path.name + '.personal-release.tmp')
    try:
        with temporary.open('xb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        temporary.chmod(0o644)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def healthy():
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    for _ in range(30):
        try:
            with opener.open('http://127.0.0.1:3001/api/auth/session', timeout=3) as result:
                if json.load(result) == {'authenticated': False, 'user': None}:
                    return
        except (OSError, ValueError):
            pass
        time.sleep(.3)
    raise RuntimeError('AUTH_HEALTH_FAILED')


def main():
    import fcntl
    os.umask(0o077)
    if os.geteuid() != 0 or len(sys.argv) not in (2, 3):
        raise RuntimeError('ROOT_AND_PRIVATE_RELEASE_REQUIRED')
    apply = len(sys.argv) == 3 and sys.argv[2] == '--apply'
    if len(sys.argv) == 3 and not apply:
        raise RuntimeError('UNKNOWN_OPTION')
    with open('/run/lock/wep-pril-personal-release.lock', 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        with zipfile.ZipFile(sys.argv[1]) as archive:
            manifest = json.loads(archive.read('manifest.json'))
            if not re.fullmatch('[0-9a-f]{40}', manifest['revision']):
                raise RuntimeError('PINNED_REVISION_REQUIRED')
            payload, before = {}, {}
            for name, item in manifest['files'].items():
                path = target(name)
                before[name] = path.read_bytes() if path.exists() else None
                payload[name] = archive.read('payload/' + name)
                if digest(payload[name]) != item['sha256'] or digest(before[name]) != item['before']:
                    raise RuntimeError('SOURCE_MISMATCH:' + name)
        nginx_before = NGINX.read_bytes()
        nginx_after = nginx_before
        if b'location = /api/auth/personal {' not in nginx_before:
            match = re.search(rb'(?m)^([ \t]*)location \^~ /api/auth/ \{', nginx_before)
            if not match:
                raise RuntimeError('AUTH_NGINX_LOCATION_MISSING')
            config = payload['deploy/nginx-domain.conf'].decode()
            block = config.split('    location = /api/auth/personal {', 1)[1].split('\n    }', 1)[0]
            insert = ('    location = /api/auth/personal {' + block + '\n    }\n\n').encode()
            nginx_after = nginx_before[:match.start()] + insert + nginx_before[match.start():]
        healthy()
        if not apply:
            print('PERSONAL_RELEASE_PREFLIGHT_OK files=' + str(len(payload)))
            return
        backup = Path('/root') / ('webpril-personal-release-' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
        backup.mkdir(mode=0o700)
        (backup / 'manifest.json').write_text(json.dumps(manifest), encoding='utf8')
        (backup / 'nginx.conf').write_bytes(nginx_before)
        for i, (name, data) in enumerate(before.items()):
            if data is not None:
                (backup / str(i)).write_bytes(data)
        # New backup/restore tools must succeed before schema or application changes.
        helpers_written = []
        try:
            for name in ('deploy/backup.py', 'deploy/verify-backup.py'):
                atomic(target(name), payload[name])
                helpers_written.append(name)
            backup_result = run(['python3', str(ROOT / 'deploy/backup.py')], timeout=1800).stdout.decode().strip()
            backup_path = Path(backup_result.splitlines()[-1])
            if backup_path.resolve().parent != (ROOT / 'backups').resolve() or not (backup_path / 'complete').is_file():
                raise RuntimeError('VERIFIED_BACKUP_PATH_REQUIRED')
            run(['python3', str(ROOT / 'deploy/verify-backup.py'), str(backup_path)], timeout=1800)
        except Exception:
            for name in reversed(helpers_written):
                path = target(name)
                if path.read_bytes() != payload[name]:
                    raise RuntimeError('BACKUP_HELPER_CONCURRENT_CHANGE') from None
                if before[name] is None:
                    path.unlink()
                else:
                    atomic(path, before[name])
            raise
        written = []
        try:
            run(['systemctl', 'stop', 'wep-pril-auth'])
            migration = payload['backend/auth/personal-data-migration.sql'].decode()
            sql = "BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s'; SET ROLE wep_pril_auth_owner;\n" + migration + '\nCOMMIT;'
            run(['runuser', '-u', 'postgres', '--', 'psql', '-XqAt', '-v', 'ON_ERROR_STOP=1', '-d', 'wep_pril_auth'], input=sql.encode())
            # Scripts before HTML. Each target must still match its inspected source.
            ordered = sorted(payload, key=lambda name: name.endswith('.html'))
            for name in ordered:
                if name in ('deploy/backup.py', 'deploy/verify-backup.py'):
                    continue
                path = target(name)
                if (path.read_bytes() if path.exists() else None) != before[name]:
                    raise RuntimeError('CONCURRENT_CHANGE:' + name)
                atomic(path, payload[name])
                written.append(name)
            if NGINX.read_bytes() != nginx_before:
                raise RuntimeError('NGINX_CONCURRENT_CHANGE')
            atomic(NGINX, nginx_after)
            run(['nginx', '-t'])
            run(['systemctl', 'start', 'wep-pril-auth'])
            healthy()
            run(['systemctl', 'reload', 'nginx'])
            if any(digest(target(name).read_bytes()) != manifest['files'][name]['sha256'] for name in payload):
                raise RuntimeError('FINAL_CHECKSUM_FAILED')
        except Exception:
            run(['systemctl', 'stop', 'wep-pril-auth'])
            # The additive schema and any new data survive code rollback.
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
            run(['systemctl', 'start', 'wep-pril-auth'])
            run(['systemctl', 'reload', 'nginx'])
            healthy()
            raise
        print('PERSONAL_RELEASE_OK revision=' + manifest['revision'] + ' backup=' + str(backup))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(str(error) if isinstance(error, RuntimeError) else 'PERSONAL_RELEASE_FAILED', file=sys.stderr)
        sys.exit(1)
