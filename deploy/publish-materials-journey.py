#!/usr/bin/env python3
"""Publish scoped materials navigation changes with checksum and rollback checks."""
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import time
import urllib.parse
import urllib.request

FILES = {'baby.html': {'old': '846ce2f87e0a410e28b0ce9f1b955bdb5c9b3fc3b4ebc5f89a89add7df562465', 'new': 'ed8e7f6a899ee37da5ab59f023e99667ef31865427466326020de2d7c9985edb'}, 'mom.html': {'old': '7a83642af5b1c807662f04232f5304d3ee327f5d7fc76209f05175e1ac8b7380', 'new': 'd4ccf816dffeb2f91145ba7fc8aa349fe649d53a238ddb73dfb4df8fdbc4ccf1'}, 'club.html': {'old': 'fb8ff74b3c065c4901f936f9e58692088d396424c224b1ea364652650b1ff01e', 'new': '6e9737c710aa3e1149a160417a3e67f4e88c856408b5ccc7c025732f9240553f'}, 'article.js': {'old': 'b85c68f7258429b85b6d5bddfb6cfef1f37543fd13e7ad65730ef853f161b67c', 'new': '3a7b6a27f3e40248504fa2c3010abd4791102fc82cb9fcad3bba9f9b2db9d015'}, 'articles.html': {'old': '7702f20f1b6e7deb989ea52d8250ccba6cc25c607d4250458fe018af7b8a14bb', 'new': 'c9ff6567cc7022b27b9f609b6ba8c5cabd17fd70c28ab04f43bc094bcefd8629'}, 'video.js': {'old': '2be88cd7d590ee27c2d15e174efe2d83c163ea5106051f6803fc4c5ad491bf74', 'new': '5c8deca47dfb2afef5fd2644533612d5b8e884672513f972b0e3887023d3863b'}}


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
    temporary = path.with_name(path.name + '.materials-journey-release-' + str(time.time_ns()))
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
    backup = Path('/root/wep-pril-materials-journey-' + str(time.time_ns()))
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
    print('MATERIALS_JOURNEY_PUBLISHED; NO_SERVICE_RESTART')
    print('BACKUP_DIR=' + str(backup))


if __name__ == '__main__':
    main()
