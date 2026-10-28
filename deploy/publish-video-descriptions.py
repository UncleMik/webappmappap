#!/usr/bin/env python3
"""Publish short video descriptions with pinned hashes, backup and rollback."""
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import time
import urllib.parse
import urllib.request

FILES = {'course-video-description.js': {'old': None, 'new': '6c4c91630ef3a843858bda6ab60496542b5fc1cf0bab955dbfa9e79b6106f55c'}, 'course-player.css': {'old': '983662a6abc23954f238fcaef0613c507c2a59dec4245e31822cac8a714f87e7', 'new': '33facaf7d4f7e4c05c02ecab9d1ebf82c1e0b0e8667d72071d548717b5a0f8a0'}, 'video.css': {'old': '05f712b39dd1ba251f3b4ecdf0052be9a66dab4b4b6afd684e2158d495f0c817', 'new': '81735d3290ac7522f1a5b898f2e08a31744e46f671cf852412f4ec3c7dafd00d'}, 'weekly-videos.js': {'old': '7f9c213d6fb4d402c2192f8ab96e898e29a435ff369536b8e7e11db0836cc888', 'new': '7a5e8ea89c8c9203e68f382807fa9f8f730c8f72107d4cc10585a81b6a9a98f2'}, 'weekly-video-player.js': {'old': '501d414af2588c82b7f20c4175e0622ce795b30cb144dfe691671f0e30b2fc14', 'new': '47945181b6a05c80bda6bbfbef543d02285f0a764367d5136e7e854f1d205143'}, 'course-lesson.js': {'old': '0bbfdeec30b898c33c81404d97af6dd2dd1e012cdb66bd0a7a6519b06e2c4beb', 'new': '2397832d6b0dc428c31ef017c55dee5d0d2b963068ac57b67f06f495a5ff8681'}, 'article.js': {'old': 'c1af6d4400c0f51ef139bc461fc0eb11cf9f33f382bb722481a52e919d9a50e2', 'new': '5cd311c71169dc070788fce1b87abb32f4bae3c2860624adc6ec1f892b0b4ff8'}, 'video.js': {'old': '5c8deca47dfb2afef5fd2644533612d5b8e884672513f972b0e3887023d3863b', 'new': 'df5471a3b922d6e560390c9e6c28bd1d8e597ee1b8a1acc6dfe060322d10f28c'}, 'article.html': {'old': '996585b9e430e7e6016a5d38949678972db8271a1b92c119cf46a193970129e6', 'new': '1aeccb311deeb4f38457f193939530bc7ce2a152194678f1c6364992381c9296'}, 'video.html': {'old': '68b812d77aac04fea03832776dc67d580f24404b71f640a787c28d104fefe4f5', 'new': 'ab029a9bd9bdd31e0932c3c6a18d1cd2de400bd7a11d5376805f3946b5a09ce8'}}


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
    temporary = path.with_name(path.name + '.video-descriptions-release-' + str(time.time_ns()))
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
    backup = Path('/root/wep-pril-video-descriptions-' + str(time.time_ns()))
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
    print('VIDEO_DESCRIPTIONS_PUBLISHED; NO_SERVICE_RESTART')
    print('BACKUP_DIR=' + str(backup))


if __name__ == '__main__':
    main()
