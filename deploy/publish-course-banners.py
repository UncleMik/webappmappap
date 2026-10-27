#!/usr/bin/env python3
"""Publish the approved GetCourse course banners, without restarting services."""
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import time
import urllib.parse
import urllib.request

FILES = {'course-banners.js': {'old': None, 'new': '338afab7527cb1877f17044b870ca73f92950136bddca43abff39119fefef3a0'}, 'course-banners.css': {'old': None, 'new': 'a6ed64323bb440f4362424a7fc2105f61515c351332e428b4ae14dcd73132308'}, 'assets/course-banners/267352508.webp': {'old': None, 'new': '43c3e6508cd652821d278267864b53cb00c009b2de805010cb1a46d1e162f620'}, 'assets/course-banners/430799983.webp': {'old': None, 'new': '91904d1be8999f26af63570f10eb7134863fa25be4e1bf09e770f75db204e804'}, 'assets/course-banners/820572152.webp': {'old': None, 'new': '411bab3ec48da221c7265aa1bd1c3b7158add90def30709aa820a087b32f57ab'}, 'assets/course-banners/853459064.webp': {'old': None, 'new': '3bd9f2dca03bd318a82bf7f33d1d9c2af733a0a4f20768ea551b71101699f6c6'}, 'assets/course-banners/935386893.webp': {'old': None, 'new': '35d193b7f7507f40209cb5d978fa2f9d0a90848c25f522601fa34bf1bb09389b'}, 'course-ui.js': {'old': '0ca11127cf51fae8bc5ef7f3a57b11d7a3e905604b70b943c04dd0f362f24044', 'new': '7d748812de250a248c43dbd9adda15548dbe6c2376721121fcdf78c294a0e208'}, 'journey-courses.js': {'old': 'd6669b13383da5240adbbcd4bc7fab9c3def2ba1faff12305cc1aeb91f6e57a7', 'new': '29cca5f70bd10f2464f30ee2df7438414249cf374e5bab2e399b5dcaa07912ce'}, 'my-courses.js': {'old': '0eb7e60fea439d383ffbe0bb7fa4843aff45b30714a0fae55998366922890bba', 'new': '7f3fac7e8647371bdd49c878af0f8e2f6b02cb44c03d9fa3ff8556faa70c6bac'}, 'journey.html': {'old': 'dfd5b1dcfcd981c6713127539a7d72e4d70451b7b250ba575444a54e68507096', 'new': 'ef0a9efea96cd44a8e4e21928d64a3cef22d68476eff2426f80572c1dbbfb620'}, 'my-courses.html': {'old': 'd08fffb6b1e8eb8d1c4bdeb7af0de5f471d3badf367ea7a997f511a5e0c0ffa6', 'new': 'c617c842480e5e1d61b7a92c30811433b8834c3377ff9fa3d6d7d81de25e8dc0'}}


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
    temporary = path.with_name(path.name + '.course-banners-release-' + str(time.time_ns()))
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
    backup = Path('/root/wep-pril-course-banners-' + str(time.time_ns()))
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
            (root / name).parent.mkdir(parents=True, exist_ok=True)
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
    print('COURSE_BANNERS_PUBLISHED; NO_SERVICE_RESTART')
    print('BACKUP_DIR=' + str(backup))


if __name__ == '__main__':
    main()
