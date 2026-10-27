#!/usr/bin/env python3
"""Publish the neutral bottom navigation for breathing opened from home."""
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import time
import urllib.parse
import urllib.request

FILES = {'video.css': {'old': 'a1c4112ca9ef9355c6b6d121df46b97c097d8c0266be4c3ec2cb3428f8e4331e', 'new': '05f712b39dd1ba251f3b4ecdf0052be9a66dab4b4b6afd684e2158d495f0c817'}, 'course-lesson.js': {'old': 'bfc6b5b1ba36958bf6f37be4c37ad1e997411ec186821bd13c09a2e75e94c900', 'new': '051eae1bb05575104ae693b25cf63844a3bf48aed4ed3f97332e29f7560a068e'}, 'article.js': {'old': '9974d37c8b73e561c7a9f449afe354710b8440861dbf6a10dc57e0b137a01739', 'new': '99d891289efa9891f9aa494608264ecf0b4e0703eb6fe036a215857fcf99e40e'}, 'school-video-routes.js': {'old': 'b3f855bbfc124c5f006ba540736fde7bb27393a5d2228b267b1d9fc46c167b81', 'new': '095bf7f49d8db52284ab18e5944381b729bb564ae8edb6b0445ace57b925f06d'}, 'video.js': {'old': '1fc80aba0c6f3ecfbe321bede130089eb5941ff4f3a51998508f451d9f9f47ee', 'new': '89cd2c937b3afa14fb3bc2f24d9aec2507f7ab70308896d254481fd4b471bc5e'}, 'article.html': {'old': '87226fbe7f2c491f6330c86335030f031138e520885619ec8796292a37086f44', 'new': '68392f41091ad5ad8619d0b45567b84e4b3592f2f141402823ab4304a530f24d'}, 'video.html': {'old': 'f8d6b631b9076039861c2d6f5be2ff1f53b22a6f8e828fd2c9501d122b680eab', 'new': '236480dd354c9a4cbff877b9eb4e08c669f32ca913913a86ca7cee42238873d1'}}


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
    temporary = path.with_name(path.name + '.breathing-navigation-release-' + str(time.time_ns()))
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
        url = 'https://raw.githubusercontent.com/UncleMik/webappmappap/' + revision + '/%D0%A4%D1%80%D0%BE%D0%BD%D1%82/' + name + '?release=' + revision
        with urllib.request.urlopen(url, timeout=25) as response:
            data = response.read(200001)
        if len(data) > 200000 or digest(data) != expected['new']:
            raise RuntimeError('RELEASE_CHECKSUM_MISMATCH:' + name)
        after[name] = data
    changed = [name for name in FILES if before[name] != after[name]]
    if not changed:
        print('ALREADY_CURRENT')
        return
    backup = Path('/root/wep-pril-breathing-navigation-' + str(time.time_ns()))
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
    print('BREATHING_NAVIGATION_PUBLISHED; NO_SERVICE_RESTART')
    print('BACKUP_DIR=' + str(backup))


if __name__ == '__main__':
    main()
