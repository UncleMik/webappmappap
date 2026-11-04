"""Publish the hash-pinned Lara attachment update without changing databases."""
import datetime
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import time
import urllib.request
import zipfile

ROOT = Path('/opt/wep_pril')
NGINX = Path('/etc/nginx/sites-available/wep-pril-domain')
FILES = ('backend/auth/ai-attachment.mjs', 'backend/auth/ai-chat.mjs', 'backend/auth/http.mjs',
         'Фронт/ai.js', 'Фронт/ai.css', 'Фронт/ai.html')
OLD_ROUTE = '''    location = /api/auth/ai/messages {
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
NEW_ROUTE = OLD_ROUTE.replace('client_max_body_size 24k;', '''client_max_body_size 15m;
        client_body_timeout 90s;
        proxy_http_version 1.1;
        proxy_request_buffering off;''').replace('proxy_read_timeout 75s;', 'proxy_read_timeout 160s;').replace('proxy_send_timeout 15s;', 'proxy_send_timeout 90s;')

def digest(value):
    return hashlib.sha256(value).hexdigest() if value is not None else None

def target(name):
    if name not in FILES:
        raise RuntimeError('UNEXPECTED_PATH')
    path = ROOT / ('frontend/' + name[6:] if name.startswith('Фронт/') else name)
    if any(p.is_symlink() for p in (path, *path.parents)):
        raise RuntimeError('UNSAFE_PATH')
    return path

def patch_nginx(data):
    text = data.decode()
    if text.count(OLD_ROUTE) != 1 or text.count('location = /api/auth/ai/messages {') != 1:
        raise RuntimeError('AI_ROUTE_CHANGED_REVIEW_REQUIRED')
    return text.replace(OLD_ROUTE, NEW_ROUTE).encode()

def run(args, **kwargs):
    return subprocess.run(args, check=True, capture_output=True, timeout=kwargs.pop('timeout', 110), **kwargs)

def healthy():
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    for _ in range(30):
        try:
            with opener.open('http://127.0.0.1:3001/api/auth/session', timeout=3) as r:
                if r.status == 200 and json.load(r).get('authenticated') is False:
                    return
        except (OSError, ValueError):
            pass
        time.sleep(.3)
    raise RuntimeError('AUTH_HEALTH_FAILED')

def atomic(path, data, metadata=None):
    temporary = path.with_name(path.name + '.uploads-' + str(time.time_ns()))
    try:
        with temporary.open('xb') as f:
            f.write(data); f.flush(); os.fsync(f.fileno())
        temporary.chmod(stat.S_IMODE(metadata.st_mode) if metadata else 0o644)
        if metadata:
            os.chown(temporary, metadata.st_uid, metadata.st_gid)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)

def load(path):
    with zipfile.ZipFile(path) as z:
        expected = {'manifest.json'} | {'payload/' + name for name in FILES}
        if set(z.namelist()) != expected or len(z.namelist()) != len(expected):
            raise RuntimeError('INVALID_PACKAGE')
        manifest = json.loads(z.read('manifest.json'))
        if set(manifest['files']) != set(FILES):
            raise RuntimeError('INVALID_MANIFEST')
        before, after = {}, {}
        for name in FILES:
            file = target(name)
            before[name] = file.read_bytes() if file.exists() else None
            after[name] = z.read('payload/' + name)
            if digest(before[name]) != manifest['files'][name]['before'] or digest(after[name]) != manifest['files'][name]['sha256']:
                raise RuntimeError('SOURCE_OR_PAYLOAD_MISMATCH:' + name)
        return manifest, before, after

def main():
    import fcntl
    os.umask(0o077)
    if os.geteuid() != 0 or len(sys.argv) not in (2, 3):
        raise RuntimeError('ROOT_AND_PACKAGE_REQUIRED')
    apply = len(sys.argv) == 3 and sys.argv[2] == '--apply'
    if len(sys.argv) == 3 and not apply:
        raise RuntimeError('UNKNOWN_OPTION')
    with open('/run/lock/wep-pril-ai-release.lock', 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        manifest, before, after = load(sys.argv[1])
        nginx_before = NGINX.read_bytes()
        nginx_after = patch_nginx(nginx_before)
        healthy()
        for name in FILES[:3]:
            run(['node', '--input-type=module', '--check'], input=after[name])
        if not apply:
            print('AI_UPLOADS_PREFLIGHT_OK'); return
        metadata = {name: target(name).stat() if before[name] is not None else None for name in FILES}
        nginx_metadata = NGINX.stat()
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
        backup = Path('/root') / ('webpril-ai-uploads-' + stamp)
        backup.mkdir(mode=0o700)
        (backup / 'manifest.json').write_text(json.dumps(manifest))
        (backup / 'nginx.before').write_bytes(nginx_before)
        for index, name in enumerate(FILES):
            if before[name] is not None:
                (backup / str(index)).write_bytes(before[name])
        written, nginx_written = [], False
        try:
            for name in FILES[:3]:
                file = target(name)
                if (file.read_bytes() if file.exists() else None) != before[name]:
                    raise RuntimeError('CONCURRENT_SOURCE_CHANGE')
                atomic(file, after[name], metadata[name]); written.append(name)
            run(['systemctl', 'restart', 'wep-pril-auth']); healthy()
            if NGINX.read_bytes() != nginx_before:
                raise RuntimeError('CONCURRENT_NGINX_CHANGE')
            atomic(NGINX, nginx_after, nginx_metadata); nginx_written = True
            run(['nginx', '-t']); run(['systemctl', 'reload', 'nginx'])
            for name in FILES[3:]:
                if target(name).read_bytes() != before[name]:
                    raise RuntimeError('CONCURRENT_SOURCE_CHANGE')
                atomic(target(name), after[name], metadata[name]); written.append(name)
            if any(target(name).read_bytes() != after[name] for name in FILES):
                raise RuntimeError('READBACK_FAILED')
        except BaseException:
            run(['systemctl', 'stop', 'wep-pril-auth'])
            for name in reversed(written):
                file = target(name)
                if file.read_bytes() != after[name]:
                    raise RuntimeError('ROLLBACK_CONCURRENT_CHANGE') from None
                if before[name] is None:
                    file.unlink()
                else:
                    atomic(file, before[name], metadata[name])
            if nginx_written:
                if NGINX.read_bytes() != nginx_after:
                    raise RuntimeError('ROLLBACK_NGINX_CHANGED') from None
                atomic(NGINX, nginx_before, nginx_metadata)
            run(['nginx', '-t']); run(['systemctl', 'start', 'wep-pril-auth']); healthy()
            run(['systemctl', 'reload', 'nginx'])
            raise RuntimeError('AI_UPLOADS_ROLLED_BACK') from None
        print('AI_UPLOADS_PUBLISHED revision=' + manifest['revision'] + ' backup=' + str(backup))

if __name__ == '__main__':
    main()
