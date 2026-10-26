#!/usr/bin/env python3
"""Publish only the agreed journey course cards, without restarting services."""
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import time
import urllib.parse
import urllib.request

FILES = {'journey-courses.js': {'old': None, 'new': 'd6669b13383da5240adbbcd4bc7fab9c3def2ba1faff12305cc1aeb91f6e57a7'}, 'my-courses.js': {'old': 'f0e156ba6e1a878b14ad2a5f16f45f4d00697bfd6301f318cb8bdfed72c113be', 'new': '7f603a858d4dbe11c27371bb67b15ca65db25cda0f5660ec4a0df261cffee51f'}, 'journey.css': {'old': '43de1a922eba3901c650f76fd656931d13f8924355da73b7256cc75ee113ec01', 'new': '201807676dde88fbb3bb3bcb7936ffb6346de0eae5b968e47d6abfd030b8d426'}, 'my-courses.html': {'old': '73e549fbccc7c5e8cb5f006ca3522d4afc70a5dbca5953e7d0e13524e6d4766d', 'new': 'b3f60532437c904794fd88816888d6dce08597c8537213f3014072a9f94d542b'}, 'journey.html': {'old': '861120a8028fe22889b4bf7bfb36b1e507e31aa40dcf8f004b9720563e35786c', 'new': '5f059faa6528d5835bc1dfb69f24e97aec01d6fe59ecc18bb6ff08988c647fbf'}}


def digest(data):
    return hashlib.sha256(data).hexdigest() if data is not None else None


def healthy():
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    for url, field, value in [
        ('http://127.0.0.1:3001/api/auth/session', 'authenticated', False),
        ('http://127.0.0.1:3000/api/health', 'status', 'ok'),
    ]:
        with opener.open(url, timeout=8) as response:
            if response.status != 200 or json.load(response).get(field) != value:
                raise RuntimeError('HEALTH_CHECK_FAILED')


def write_file(path, data, mode=0o644, uid=0, gid=0):
    temporary = path.with_name(path.name + '.journey-release-' + str(time.time_ns()))
    try:
        with temporary.open('xb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, mode)
        os.chown(temporary, uid, gid)
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()


def main():
    if os.geteuid() != 0 or len(sys.argv) != 2 or not re.fullmatch(r'[0-9a-f]{40}', sys.argv[1]):
        raise RuntimeError('ROOT_AND_PINNED_COMMIT_REQUIRED')
    revision = sys.argv[1]
    root = Path('/opt/wep_pril/frontend')
    if any(path.is_symlink() for path in (root, *root.parents)):
        raise RuntimeError('UNSAFE_ROOT')
    healthy()
    before, after, metadata = {}, {}, {}
    for name, expected in FILES.items():
        path = root / name
        if path.is_symlink() or path.parent != root:
            raise RuntimeError('UNSAFE_TARGET')
        before[name] = path.read_bytes() if path.exists() else None
        if digest(before[name]) not in (expected['old'], expected['new']):
            raise RuntimeError('SOURCE_MISMATCH:' + name)
        if path.exists():
            stat = path.stat()
            metadata[name] = (stat.st_mode & 0o777, stat.st_uid, stat.st_gid)
        else:
            metadata[name] = (0o644, 0, 0)
        url = 'https://raw.githubusercontent.com/UncleMik/webappmappap/' + revision + '/' + urllib.parse.quote('Фронт/' + name)
        with urllib.request.urlopen(url, timeout=25) as response:
            data = response.read(200001)
        if len(data) > 200000 or digest(data) != expected['new']:
            raise RuntimeError('RELEASE_CHECKSUM_MISMATCH:' + name)
        after[name] = data
    changed = [name for name in FILES if before[name] != after[name]]
    if not changed:
        print('ALREADY_CURRENT')
        return
    backup = Path('/root/wep-pril-journey-courses-' + str(time.time_ns()))
    backup.mkdir(mode=0o700)
    for name, data in before.items():
        if data is not None:
            (backup / name).write_bytes(data)
    (backup / 'manifest.json').write_text(json.dumps({'revision': revision, 'files': FILES}, indent=2))
    written = []
    try:
        # Insertion order puts scripts and styles before their HTML references.
        for name in changed:
            written.append(name)
            write_file(root / name, after[name], *metadata[name])
        healthy()
        if any(digest((root / name).read_bytes()) != expected['new'] for name, expected in FILES.items()):
            raise RuntimeError('READBACK_MISMATCH')
    except BaseException:
        for name in reversed(written):
            if before[name] is None:
                (root / name).unlink(missing_ok=True)
            else:
                write_file(root / name, before[name], *metadata[name])
        raise
    print('JOURNEY_COURSES_PUBLISHED; NO_SERVICE_RESTART')
    print('BACKUP_DIR=' + str(backup))


if __name__ == '__main__':
    main()
