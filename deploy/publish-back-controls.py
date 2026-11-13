#!/usr/bin/env python3
"""Publish approved circular back controls, without restarting services."""
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import time
import urllib.parse
import urllib.request

FILES = {'back-control.css': {'old': None, 'new': '48e8ec1eee12fd1d136ea059be4eb931c3c36890bfe0380ae4b105b836fb4191'}, 'my-courses.js': {'old': 'deb2b066672a0cf1157e34c6837953133737bb5168349b63791cdd72ad00856e', 'new': '04ebee1ea013d0f6336b7d16c045602c261b2c04e81dd7a262a1de0abd5cdd87'}, 'about.html': {'old': '9642daff20958f4bbac3790a5eeeae8233994938500ef57f9702a1cef692db45', 'new': '9792956794b88f2c18bf3e749e99802ad280c109cea84cd14007d08f8606eb17'}, 'article.html': {'old': '2740e69b7d9a25887213a7b105edcfc12fa9ffe051e7bc3f82cba93ce3dc07f4', 'new': '6eddbaaca0d68f39447d9d3cbc99c7851f1fa816fde44c2bcd2773a461b3ae3b'}, 'articles.html': {'old': '989c92086f41c83fb498a7b7f0a3974785dacc7999a6203e42ccd950ff46ad93', 'new': 'acf08b759f806ee763dea065b5c8d0fedbeb16cf0a187074903c40774d66220a'}, 'baby.html': {'old': '82bde74d2ad6da854febca35ca56aaff356e9571cfd2d00ae46141605c7ee4e8', 'new': 'e5f915d359f43f8e5b3f8b4f1525d77e6a96831d8302d7bcdcacfdcb2a402768'}, 'club-chat.html': {'old': 'a5475d81d7be8d9ee193cd61e6c79b73e0554e4daba4a7471a518bf124d25bb3', 'new': '97a59ae4c1c8e5719f87c8d7b7c3a6c78e053ef0268ac1bd133cfe1868ab2bfb'}, 'courses.html': {'old': '541b2d787f8c68ad914fbd680407fe9c2222aa9caf92fb8a09a41222713abcdc', 'new': '18c6fd11eff47fad17dbe3e9aded60680c288320adb573181bdc0fecca4c955b'}, 'favorites.html': {'old': '28cc6c11d451acd485058f350b434364337ecfce85264d02d20ff053519bde7d', 'new': 'fe43c15c7c0357a75e9dcd57c77f2de1e6f9e25d148d91f3bb2ff9e7047a9f83'}, 'mom.html': {'old': '3370954b198d75f681e9c73ff0583cc0464ee9f3743cf87901cd62cc7960eca6', 'new': 'a481d61a56db982f6f7b781eae9561185d2da753374b5afe3980abd4be73a765'}, 'my-courses.html': {'old': '58030147de8b8b138d499c2bccb14c117202a3eed374a908077a7b4b8098129c', 'new': '67fcb6063562acb76a8e8dd263ad76015cf56f9e1a982526087ced9e18d8af4d'}, 'personal-data.html': {'old': '291a8ea6beb1cd220579eed1d590f279192d95d048f2e812ede6dbaafbab39ee', 'new': 'abc3398b49b82f08f3d5b729c50e01d726e85297d821ec1c98b02567200ba552'}, 'video.html': {'old': '3469cece4c86ac98b64f7e157828e6a624781b8534bfe948ea28a6142d4cd16c', 'new': 'be25cfd2118c205c46f45fc5e828d9c06d07990fd0f26fd8966918d3d597d40d'}, 'onboarding.html': {'old': '510092434467427d16ff2e8931d99922f4f276a4e46d6638f22a7210342f7f04', 'new': '44f61191af841af2df1b1eeeddc7f648edafad3047fd8da3526755d55b17a517'}}


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
            data = response.read(1000001)
        if len(data) > 1000000 or digest(data) != expected['new']:
            raise RuntimeError('RELEASE_CHECKSUM_MISMATCH:' + name)
        after[name] = data
    changed = [name for name in FILES if before[name] != after[name]]
    if not changed:
        print('ALREADY_CURRENT')
        return
    backup = Path('/root/wep-pril-back-controls-' + str(time.time_ns()))
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
    print('BACK_CONTROLS_PUBLISHED; NO_SERVICE_RESTART')
    print('BACKUP_DIR=' + str(backup))


if __name__ == '__main__':
    main()
