"""Install a private hash-pinned Lara gateway release on Timeweb.

python3 publish-ai-chat.py /root/release.zip [--apply]
Apply reads {"secret": "<64 hex characters>"} from stdin, never argv/logs.
"""
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import time
import urllib.request
import zipfile

ROOT = Path('/opt/wep_pril')
NGINX = Path('/etc/nginx/sites-available/wep-pril-domain')
ENV = Path('/etc/wep-pril/auth.env')
FILES = {
    'backend/auth/ai-chat.mjs', 'backend/auth/ai-chat-migration.sql',
    'backend/auth/config.mjs', 'backend/auth/http.mjs', 'backend/auth/main.mjs',
    'backend/course-materials.mjs', 'backend/lara-source-map.json',
    'Фронт/ai.js', 'Фронт/ai.html', 'Фронт/ai.css',
}
BLOCK = '''    location = /api/auth/ai/messages {
        auth_request off;
        client_max_body_size 24k;
        proxy_pass http://127.0.0.1:3001;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 75s;
        proxy_connect_timeout 5s;
        proxy_send_timeout 15s;
        add_header Cache-Control "no-store" always;
    }

'''


def digest(data):
    return hashlib.sha256(data).hexdigest() if data is not None else None


def run(args, **kwargs):
    return subprocess.run(args, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          timeout=kwargs.pop('timeout', 120), **kwargs)


def target(name):
    if name not in FILES:
        raise RuntimeError('UNEXPECTED_RELEASE_PATH')
    path = ROOT / ('frontend/' + name[6:] if name.startswith('Фронт/') else name)
    if path.is_symlink() or path.resolve() != path:
        raise RuntimeError('UNSAFE_RELEASE_PATH')
    return path


def atomic(path, data, mode=0o644):
    temporary = path.with_name(path.name + '.lara-release.tmp')
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        with temporary.open('xb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        temporary.chmod(mode)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def nginx_patch(before):
    text = before.decode('utf-8')
    if 'location = /api/auth/ai/messages {' in text:
        raise RuntimeError('AI_LOCATION_ALREADY_EXISTS_REVIEW_REQUIRED')
    matches = list(re.finditer(r'(?m)^    location \^~ /api/auth/ \{', text))
    if len(matches) != 1:
        raise RuntimeError('AUTH_LOCATION_NOT_UNIQUE')
    at = matches[0].start()
    return (text[:at] + BLOCK + text[at:]).encode('utf-8')


def environment_patch(before, secret):
    if not re.fullmatch('[0-9a-f]{64}', secret):
        raise RuntimeError('INVALID_PRIVATE_SECRET')
    lines = before.decode('utf-8').splitlines()
    if any(re.match(r'^LARA_WEB_(URL|SECRET)=', line) for line in lines):
        raise RuntimeError('AI_ENV_ALREADY_CONFIGURED_REVIEW_REQUIRED')
    lines += ['LARA_WEB_URL=https://admin.legkie-rody.ru/internal/lara-web/reply',
              'LARA_WEB_SECRET=' + secret]
    return ('\n'.join(lines) + '\n').encode('utf-8')


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


def load_release(path):
    with zipfile.ZipFile(path) as archive:
        manifest = json.loads(archive.read('manifest.json'))
        if not re.fullmatch('[0-9a-f]{40}', manifest.get('revision', '')) or set(manifest.get('files', {})) != FILES:
            raise RuntimeError('INVALID_PINNED_MANIFEST')
        payload, before = {}, {}
        for name, info in manifest['files'].items():
            file = target(name)
            before[name] = file.read_bytes() if file.exists() else None
            payload[name] = archive.read('payload/' + name)
            if digest(before[name]) != info['before'] or digest(payload[name]) != info['sha256']:
                raise RuntimeError('SOURCE_MISMATCH:' + name)
    return manifest, payload, before


def main():
    import fcntl
    os.umask(0o077)
    if os.geteuid() != 0 or len(sys.argv) not in (2, 3):
        raise RuntimeError('ROOT_AND_RELEASE_REQUIRED')
    apply = len(sys.argv) == 3 and sys.argv[2] == '--apply'
    if len(sys.argv) == 3 and not apply:
        raise RuntimeError('UNKNOWN_OPTION')
    with open('/run/lock/wep-pril-ai-release.lock', 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        manifest, payload, before = load_release(sys.argv[1])
        nginx_before, env_before = NGINX.read_bytes(), ENV.read_bytes()
        nginx_after = nginx_patch(nginx_before)
        healthy()
        if not apply:
            print('AI_RELEASE_PREFLIGHT_OK files=' + str(len(payload)))
            return
        private = json.load(sys.stdin)
        env_after = environment_patch(env_before, private.get('secret', ''))
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
        backup = Path('/root') / ('webpril-ai-release-' + stamp)
        backup.mkdir(mode=0o700)
        (backup / 'manifest.json').write_text(json.dumps(manifest), encoding='utf-8')
        (backup / 'nginx.before').write_bytes(nginx_before)
        (backup / 'auth.env.before').write_bytes(env_before)
        for index, (name, data) in enumerate(before.items()):
            if data is not None:
                (backup / str(index)).write_bytes(data)
        # A restore is proved before adding even the two new AI-only tables.
        result = run(['python3', str(ROOT / 'deploy/backup.py')], timeout=900).stdout.decode().strip()
        database_backup = Path(result.splitlines()[-1])
        if database_backup.resolve().parent != (ROOT / 'backups').resolve() or not (database_backup / 'complete').is_file():
            raise RuntimeError('VERIFIED_BACKUP_REQUIRED')
        run(['python3', str(ROOT / 'deploy/verify-backup.py'), str(database_backup)], timeout=900)
        (backup / 'database-backup-path').write_text(str(database_backup), encoding='utf-8')
        # This is an additive migration. Older code does not use these tables.
        migration = payload['backend/auth/ai-chat-migration.sql'].decode('utf-8')
        if re.search(r'\b(DROP|TRUNCATE)\b', migration, re.I):
            raise RuntimeError('DESTRUCTIVE_MIGRATION_REJECTED')
        sql = "BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s'; SET ROLE wep_pril_auth_owner;\n" + migration + '\nCOMMIT;'
        run(['runuser', '-u', 'postgres', '--', 'psql', '-XqAt', '-v', 'ON_ERROR_STOP=1', '-d', 'wep_pril_auth'], input=sql.encode())
        env_mode = stat.S_IMODE(ENV.stat().st_mode)
        written, environment_written, nginx_written = [], False, False
        try:
            for name in sorted(payload):
                if name.startswith('Фронт/'):
                    continue
                file = target(name)
                if (file.read_bytes() if file.exists() else None) != before[name]:
                    raise RuntimeError('CONCURRENT_CHANGE:' + name)
                atomic(file, payload[name])
                written.append(name)
            if ENV.read_bytes() != env_before or NGINX.read_bytes() != nginx_before:
                raise RuntimeError('CONCURRENT_CONFIGURATION_CHANGE')
            atomic(ENV, env_after, env_mode)
            environment_written = True
            run(['systemctl', 'restart', 'wep-pril-auth'])
            healthy()
            if NGINX.read_bytes() != nginx_before:
                raise RuntimeError('CONCURRENT_NGINX_CHANGE')
            atomic(NGINX, nginx_after)
            nginx_written = True
            run(['nginx', '-t'])
            run(['systemctl', 'reload', 'nginx'])
            for name in sorted(n for n in payload if n.startswith('Фронт/')):
                file = target(name)
                if file.read_bytes() != before[name]:
                    raise RuntimeError('CONCURRENT_CHANGE:' + name)
                atomic(file, payload[name])
                written.append(name)
            if any(digest(target(name).read_bytes()) != info['sha256'] for name, info in manifest['files'].items()):
                raise RuntimeError('FINAL_CHECKSUM_FAILED')
        except Exception:
            run(['systemctl', 'stop', 'wep-pril-auth'])
            for name in reversed(written):
                file = target(name)
                if file.read_bytes() != payload[name]:
                    raise RuntimeError('ROLLBACK_CONCURRENT_FILE_CHANGE') from None
                if before[name] is None:
                    file.unlink()
                else:
                    atomic(file, before[name])
            if environment_written:
                if ENV.read_bytes() != env_after:
                    raise RuntimeError('ROLLBACK_CONCURRENT_ENV_CHANGE') from None
                atomic(ENV, env_before, env_mode)
            if nginx_written:
                if NGINX.read_bytes() != nginx_after:
                    raise RuntimeError('ROLLBACK_CONCURRENT_NGINX_CHANGE') from None
                atomic(NGINX, nginx_before)
            run(['nginx', '-t'])
            run(['systemctl', 'start', 'wep-pril-auth'])
            healthy()
            run(['systemctl', 'reload', 'nginx'])
            # New AI tables and new user data are never dropped or overwritten.
            raise RuntimeError('AI_RELEASE_ROLLED_BACK') from None
        print('AI_RELEASE_OK revision=' + manifest['revision'] + ' backup=' + str(backup))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Exceptions can carry SQL/provider credentials; print only our codes.
        code = str(error) if isinstance(error, RuntimeError) and re.fullmatch(r'[A-Z_]+(?::[A-Za-z0-9_./-]+)?', str(error)) else type(error).__name__
        print('AI_RELEASE_FAILED ' + code, file=sys.stderr)
        sys.exit(1)
