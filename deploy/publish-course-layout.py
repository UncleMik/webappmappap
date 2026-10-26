#!/usr/bin/env python3
"""Publish the approved course / section / lesson screens, without restarting services."""
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import time
import urllib.parse
import urllib.request

FILES = {'assets/course-module-covers.webp': {'old': None, 'new': '1bedd5e5947fd25e3cfa681d1851a33bdd687b44512197533087cd00c225dcde'}, 'course-layout.css': {'old': None, 'new': '2232d10f1564201da7fc9b94bfbaa3e01f6b21f08aeabd9d61b07c481bb4536b'}, 'course-ui.js': {'old': None, 'new': '0ca11127cf51fae8bc5ef7f3a57b11d7a3e905604b70b943c04dd0f362f24044'}, 'course-views.js': {'old': 'b5ac5c6f276169b8e208eb6c0a810aedaed3aa547c2ca18affd1f1cfecfcbb0e', 'new': '2a6ce83fb68fd2b1ba7ad0f4a360350c463889a220fc62eafd0e859f43245c15'}, 'course-reader.css': {'old': '240cfbc0b01ca09a57e9784f5018801f6cf58686a5a40c02a0750f4e0127d133', 'new': '507366ec8d4c1099625ab29839a1a50e144ac4e68a2c6e741d7cdd1f6f9a7f98'}, 'my-courses.css': {'old': '3f56fa8fd6900ac9c6b033d5c3dc66d4905b4ad391bd63c7e38fc631d49a74d5', 'new': '83aa6e69f0f2cc74e16745c2438ecf848ddb1bbf4293f20ab867501d2e90795a'}, 'course-lesson.js': {'old': 'eebe902b17b36cf62d04f7e3efd0921c9468bd64adb4930e2f39b12aa0e89e3c', 'new': '90537ff5c3893d9a81baef3e3bc56ceab3cc492a262db2de81e77c98d128da4e'}, 'my-courses.js': {'old': '1fa955301832c65962579966555c9a0d444eefd4f39117f9a443096c419e1b2f', 'new': '0eb7e60fea439d383ffbe0bb7fa4843aff45b30714a0fae55998366922890bba'}, 'article.js': {'old': '90faa74eb7b3fa93716cfb911a326b5e9131f8aeb7bb7920934315cf52c685f3', 'new': '03fe688902965edf39a73dc1924437a5cc1c5fb9ade8870629d9a76a71e951a0'}, 'my-courses.html': {'old': '853fe51203b615f6a48ce30b3b253251b0e368cdb6bc90425690b115662e99d9', 'new': '7b2e4187d17046b32180df4e5a5085ba7e0d471431938b9a37ed84a688362e3a'}, 'article.html': {'old': '56503ee26448ae88fe811c34a3445af8c6fd22fe038509e14c167622046ae8c6', 'new': 'aaa5c3d8fa84c104ad245fcccc8d9c86d7035e412eae14f2eae7d4a86e73dfe0'}}


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
    temporary = path.with_name(path.name + '.course-layout-release-' + str(time.time_ns()))
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
    backup = Path('/root/wep-pril-course-layout-' + str(time.time_ns()))
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
    print('COURSE_LAYOUT_PUBLISHED; NO_SERVICE_RESTART')
    print('BACKUP_DIR=' + str(backup))


if __name__ == '__main__':
    main()
