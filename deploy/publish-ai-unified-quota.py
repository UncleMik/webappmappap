#!/usr/bin/env python3
"""Publish a hash-pinned AI quota bundle on Timeweb.

Usage: python3 publish-ai-unified-quota.py release.zip [--apply]
Without --apply, verify the bundle, installed files, syntax and local health.
"""

from contextlib import ExitStack
from datetime import datetime, timezone
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
BACKEND = {'backend/auth/ai-chat.mjs', 'backend/auth/stars-ai.mjs'}
FRONTEND = {'ai.js', 'gamification.js', 'index.html', 'ai.html',
            'app-navigation.js', 'article.html', 'articles.html', 'baby.html',
            'favorites.html', 'mom.html', 'video.html'}
ALLOWED = BACKEND | {'Фронт/' + name for name in FRONTEND}
SHA = re.compile(r'[0-9a-f]{64}\Z')


def require(ok, code):
    if not ok:
        raise RuntimeError(code)


def digest(data):
    return hashlib.sha256(data).hexdigest() if data is not None else None


def target(name):
    require(name in ALLOWED, 'UNEXPECTED_PATH')
    path = ROOT / ('frontend/' + name[6:] if name.startswith('Фронт/') else name)
    require(not any(part.is_symlink() for part in (path, *path.parents)), 'UNSAFE_PATH')
    require(path.is_file(), 'MISSING_TARGET')
    return path


def run(args, **kwargs):
    return subprocess.run(args, check=True, capture_output=True,
                          timeout=kwargs.pop('timeout', 120), **kwargs)


def healthy():
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    for url, field, expected in [
        ('http://127.0.0.1:3001/api/auth/session', 'authenticated', False),
        ('http://127.0.0.1:3000/api/health', 'status', 'ok'),
    ]:
        for attempt in range(30):
            try:
                with opener.open(url, timeout=3) as response:
                    if response.status == 200 and json.load(response).get(field) == expected:
                        break
            except (OSError, ValueError):
                pass
            if attempt == 29:
                raise RuntimeError('HEALTH_FAILED')
            time.sleep(.3)


def atomic(path, data, metadata):
    temporary = path.with_name(path.name + '.quota-' + str(time.time_ns()))
    try:
        with temporary.open('xb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, stat.S_IMODE(metadata.st_mode))
        os.chown(temporary, metadata.st_uid, metadata.st_gid)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def load_bundle(bundle):
    with zipfile.ZipFile(bundle) as archive:
        members = archive.infolist()
        names = [member.filename for member in members]
        require(len(names) == len(set(names)) and 'manifest.json' in names, 'INVALID_PACKAGE')
        for member in members:
            mode = member.external_attr >> 16
            require(not member.is_dir() and not stat.S_ISLNK(mode), 'UNSAFE_PACKAGE_MEMBER')
            require(member.file_size <= 2_000_000, 'OVERSIZE_PACKAGE_MEMBER')
        manifest = json.loads(archive.read('manifest.json'))
        require(isinstance(manifest, dict) and set(manifest) == {'revision', 'files'}, 'INVALID_MANIFEST')
        require(isinstance(manifest['revision'], str) and re.fullmatch(r'[0-9a-f]{40}', manifest['revision']), 'INVALID_REVISION')
        files = manifest['files']
        require(isinstance(files, dict) and files and set(files) <= ALLOWED, 'INVALID_FILESET')
        require(set(names) == {'manifest.json'} | {'payload/' + name for name in files}, 'INVALID_PACKAGE')
        payload = {}
        for name, pins in files.items():
            require(isinstance(pins, dict) and set(pins) == {'before', 'sha256'}, 'INVALID_PINS')
            require(isinstance(pins['before'], str) and SHA.fullmatch(pins['before'])
                    and isinstance(pins['sha256'], str) and SHA.fullmatch(pins['sha256']), 'INVALID_PINS')
            payload[name] = archive.read('payload/' + name)
            require(digest(payload[name]) == pins['sha256'], 'PAYLOAD_MISMATCH:' + name)
        return manifest, payload


def main():
    import fcntl
    require(os.name == 'posix' and os.geteuid() == 0 and len(sys.argv) in (2, 3), 'ROOT_AND_BUNDLE_REQUIRED')
    apply = len(sys.argv) == 3 and sys.argv[2] == '--apply'
    require(len(sys.argv) == 2 or apply, 'UNKNOWN_OPTION')
    os.umask(0o077)
    with ExitStack() as stack:
        # Same shared locks and acquisition order as the stars publishers.
        for name in ('stars', 'club', 'ai', 'personal'):
            lock = stack.enter_context(open('/run/lock/wep-pril-' + name + '-release.lock', 'w'))
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        manifest, payload = load_bundle(sys.argv[1])
        paths = {name: target(name) for name in payload}
        before = {name: path.read_bytes() for name, path in paths.items()}
        require(all(digest(before[name]) == manifest['files'][name]['before'] for name in payload), 'SOURCE_MISMATCH')
        metadata = {name: path.stat() for name, path in paths.items()}
        for name, data in payload.items():
            if name.endswith(('.js', '.mjs')):
                run(['node', '--check', '--input-type=module'], input=data)
        healthy()
        if not apply:
            print('AI_QUOTA_PREFLIGHT_OK revision=' + manifest['revision'])
            return

        stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
        backup = Path('/root') / ('webpril-ai-unified-quota-' + stamp + '-' + str(time.time_ns()))
        backup.mkdir(mode=0o700)
        (backup / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False), encoding='utf-8')
        for index, name in enumerate(payload):
            (backup / str(index)).write_bytes(before[name])

        written = []
        try:
            # Backend first, then restart; HTML is last so it loads the new JS.
            order = sorted(payload, key=lambda name: (0 if name in BACKEND else 2 if name.endswith('.html') else 1, name))
            backend_names = [name for name in order if name in BACKEND]
            for name in order:
                path = paths[name]
                require(path.read_bytes() == before[name], 'CONCURRENT_CHANGE:' + name)
                atomic(path, payload[name], metadata[name])
                written.append(name)
                if backend_names and name == backend_names[-1]:
                    run(['systemctl', 'restart', 'wep-pril-auth'])
                    healthy()
            require(all(digest(paths[name].read_bytes()) == manifest['files'][name]['sha256'] for name in payload), 'READBACK_FAILED')
            healthy()
        except BaseException:
            for name in reversed(written):
                path = paths[name]
                require(digest(path.read_bytes()) == manifest['files'][name]['sha256'], 'ROLLBACK_CONCURRENT_CHANGE:' + name)
                atomic(path, before[name], metadata[name])
            if any(name in BACKEND for name in written):
                run(['systemctl', 'restart', 'wep-pril-auth'])
            healthy()
            raise RuntimeError('AI_QUOTA_ROLLED_BACK') from None
        print('AI_QUOTA_PUBLISHED revision=' + manifest['revision'] + ' backup=' + str(backup))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        code = str(error) if isinstance(error, RuntimeError) and re.fullmatch(r'[A-Z_]+(?::[A-Za-z0-9_./-]+)?', str(error)) else type(error).__name__
        print('AI_QUOTA_FAILED ' + code, file=sys.stderr)
        sys.exit(1)
