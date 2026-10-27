#!/usr/bin/env python3
"""Publish the approved lesson video subtopics, without restarting services."""
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import time
import urllib.parse
import urllib.request

FILES = {'course-video-player.js': {'old': 'ba843ef8eebc0b4f7198ecda7cb4141f2a97e48cc2150bacb0b93d904acc329f', 'new': 'a8593b0930977fd45bdaa972fe803d91a51ad4c75236f89eae95d3375ea23d0b'}, 'course-lesson.js': {'old': 'bc04a532c0f3b09ea2691c35f4675a7b1e57290ca6f874228379e9b5cae7a9e2', 'new': 'aeb166acf7e8cf89a822fd4780205b29137fbd5e18aebbf4fd65c9e3df40c88a'}, 'course-player.css': {'old': '18ae9c1dbf501ee874ad73926bb99ec0d3ad374e7900787e0453724bbce748a9', 'new': '1b7d97ea242901dbf1f217697266f5250865cd382e2f128a3ab4b265944acf98'}, 'article.js': {'old': 'c8ac62b6cc1d4c93e27755d73c91e5b8316e1ae93088feb78e1d967757717311', 'new': 'eb736d6c3bc637e5dd90cebce8125d6072e2cb32d6f661ac6d4584cab854fa02'}, 'article.html': {'old': 'aa1fa1de4aa478308547af3304d489a1dd310f30b3efa67d5d629b244e2874a6', 'new': '3c339032542921fe7b323d7ddabb4e311133d0c08040295744f9451f26a41b1b'}}


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
    temporary = path.with_name(path.name + '.course-subtopics-release-' + str(time.time_ns()))
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
        if any(p.is_symlink() for p in (path, *path.parents)) or root not in path.parents:
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
    backup = Path('/root/wep-pril-course-subtopics-' + str(time.time_ns()))
    backup.mkdir(mode=0o700)
    for name, data in before.items():
        if data is not None:
            (backup / name).parent.mkdir(parents=True, exist_ok=True)
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
    print('COURSE_SUBTOPICS_PUBLISHED; NO_SERVICE_RESTART')
    print('BACKUP_DIR=' + str(backup))


if __name__ == '__main__':
    main()
