#!/usr/bin/env python3
"""Apply a private, hash-pinned course-program ZIP, with backup and rollback.

Usage: python3 publish-course-programs.py release.zip [--apply]
manifest.json: {revision, files: {repo_path: {before, sha256}}}
Payload entries: payload/<repo_path>. No database or configuration changes.
"""
import fcntl
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
ALLOWED_BACKEND = {'backend/auth/http.mjs', 'backend/course-materials.mjs'}


def digest(data):
    return hashlib.sha256(data).hexdigest() if data is not None else None


def target(name):
    if name in ALLOWED_BACKEND:
        relative = Path(name)
    elif name.startswith('Фронт/') and Path(name).suffix in {'.html', '.css', '.js'}:
        relative = Path('frontend') / name[6:]
    else:
        raise RuntimeError('UNEXPECTED_PATH')
    path = ROOT / relative
    if '..' in relative.parts or ROOT not in path.parents or any(p.is_symlink() for p in (path, *path.parents)):
        raise RuntimeError('UNSAFE_PATH')
    if not path.parent.is_dir():
        raise RuntimeError('PARENT_MISSING')
    return path


def atomic(path, data):
    stat = path.stat() if path.exists() else None
    temporary = path.with_name(path.name + '.program-release-' + str(time.time_ns()))
    try:
        with temporary.open('xb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, stat.st_mode & 0o777 if stat else 0o644)
        os.chown(temporary, stat.st_uid if stat else 0, stat.st_gid if stat else 0)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def healthy():
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    for _ in range(40):
        try:
            for url, field, value in [('http://127.0.0.1:3001/api/auth/session', 'authenticated', False),
                                      ('http://127.0.0.1:3000/api/health', 'status', 'ok')]:
                with opener.open(url, timeout=3) as response:
                    if response.status != 200 or json.load(response).get(field) != value:
                        raise RuntimeError('HEALTH_FAILED')
            return
        except (OSError, ValueError, RuntimeError):
            time.sleep(.25)
    raise RuntimeError('HEALTH_FAILED')


def restart():
    subprocess.run(['systemctl', 'restart', 'wep-pril-auth.service'], check=True, timeout=40)
    healthy()


def main():
    os.umask(0o077)
    if os.geteuid() != 0 or len(sys.argv) not in (2, 3) or (len(sys.argv) == 3 and sys.argv[2] != '--apply'):
        raise RuntimeError('ROOT_AND_PRIVATE_RELEASE_REQUIRED')
    with open('/run/lock/wep-pril-course-programs.lock', 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        with zipfile.ZipFile(sys.argv[1]) as archive:
            manifest = json.loads(archive.read('manifest.json'))
            if not re.fullmatch('[0-9a-f]{40}', manifest.get('revision', '')):
                raise RuntimeError('REVISION_REQUIRED')
            files = manifest['files']
            if not files or set(archive.namelist()) != {'manifest.json', *('payload/' + name for name in files)}:
                raise RuntimeError('MANIFEST_MISMATCH')
            before, payload = {}, {}
            for name, expected in files.items():
                path = target(name)
                before[name] = path.read_bytes() if path.exists() else None
                payload[name] = archive.read('payload/' + name)
                if digest(before[name]) != expected['before'] or digest(payload[name]) != expected['sha256']:
                    raise RuntimeError('SOURCE_MISMATCH:' + name)
        healthy()
        if len(sys.argv) == 2:
            print('COURSE_PROGRAMS_PREFLIGHT_OK files=' + str(len(files)))
            return
        backup = Path('/root') / ('wep-pril-course-programs-' + str(time.time_ns()))
        backup.mkdir(mode=0o700)
        (backup / 'manifest.json').write_text(json.dumps(manifest), encoding='utf8')
        for name, data in before.items():
            if data is not None:
                saved = backup / name
                saved.parent.mkdir(parents=True, exist_ok=True)
                saved.write_bytes(data)
        written = []
        backend_changed = bool(ALLOWED_BACKEND.intersection(files))
        try:
            # Code and styles precede HTML cache-version references.
            for name in sorted(files, key=lambda n: n.endswith('.html')):
                if (target(name).read_bytes() if target(name).exists() else None) != before[name]:
                    raise RuntimeError('CONCURRENT_CHANGE:' + name)
                written.append(name)
                atomic(target(name), payload[name])
            if backend_changed:
                restart()
            else:
                healthy()
            if any(digest(target(name).read_bytes()) != files[name]['sha256'] for name in files):
                raise RuntimeError('READBACK_MISMATCH')
        except BaseException:
            for name in reversed(written):
                if target(name).read_bytes() != payload[name]:
                    raise RuntimeError('ROLLBACK_CONCURRENT_CHANGE:' + name)
                if before[name] is None:
                    target(name).unlink()
                else:
                    atomic(target(name), before[name])
            if backend_changed:
                restart()
            raise
        print('COURSE_PROGRAMS_PUBLISHED files=' + str(len(files)))
        print('BACKUP_DIR=' + str(backup))


if __name__ == '__main__':
    main()
