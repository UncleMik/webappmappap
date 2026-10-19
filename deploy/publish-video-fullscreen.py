#!/usr/bin/env python3
"""Publish only the approved video fullscreen controls on the existing server."""

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import sys
import time
import urllib.parse
import urllib.request


# Known-good, reviewed publisher supplies atomic writes, hash guards and rollback.
SUPPORT_REVISION = '09a042649ef3926ee57033b11830db02121f1507'
SUPPORT_SHA256 = '9bd67620cc53381ee119135c1028f2a044621b9612599656f036644a2aaa5474'
SOURCE_BASE = 'https://raw.githubusercontent.com/UncleMik/webappmappap/'
PUBLIC_BASE = 'https://app.legkie-rody.ru/'
FILES = {
    'frontend/video-fullscreen.js': {
        'source': 'Фронт/video-fullscreen.js', 'old': None,
        'new': 'b8aea6920bb576a90d2ff1ab3af6f9eb85cdeeea69c8834bebbdb3445383b1ce',
    },
    'frontend/video.css': {
        'source': 'Фронт/video.css',
        'old': 'e981137230574c62c33812ffe7a31404b0fc6a0c592b9208f2ecd883bb5422a5',
        'new': '289e7935b80b4774afb2d7042b83e51505f21ca838c6a167e7053cf5b8e8bd53',
    },
    'frontend/video.html': {
        'source': 'Фронт/video.html',
        'old': '95ee4241ca54ad57a9038c4990f6c85280ded8cf5ce25d564422406a44f9ed19',
        'new': '2c493e5162e907b619f0953266e783456f0fe35140d26b83290812bbf5b6d5a6',
    },
}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def read_url(url, limit=500_000):
    request = urllib.request.Request(url, headers={'Cache-Control': 'no-cache'})
    with urllib.request.urlopen(request, timeout=20) as response:
        data = response.read(limit + 1)
    if len(data) > limit:
        raise RuntimeError('RELEASE_FILE_TOO_LARGE')
    return data


def verified_support():
    url = SOURCE_BASE + SUPPORT_REVISION + '/deploy/publish-weekly-videos.py'
    source = read_url(url)
    if digest(source) != SUPPORT_SHA256:
        raise RuntimeError('SUPPORT_CHECKSUM_FAILED')
    target = Path('/root') / ('wep-pril-publish-support-' + SUPPORT_SHA256[:12] + '.py')
    if target.is_symlink() or (target.exists() and digest(target.read_bytes()) != SUPPORT_SHA256):
        raise RuntimeError('SUPPORT_FILE_MISMATCH')
    if not target.exists():
        fd = os.open(target, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(fd, 'wb') as stream:
            stream.write(source)
    spec = importlib.util.spec_from_file_location('wep_pril_publish_support', target)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.publish


def main():
    if os.geteuid() != 0 or len(sys.argv) != 2 or not re.fullmatch(r'[0-9a-f]{40}', sys.argv[1]):
        raise SystemExit('ROOT_AND_PINNED_REVISION_REQUIRED')
    revision = sys.argv[1]
    publish = verified_support()

    def download(source):
        return read_url(SOURCE_BASE + revision + '/' + urllib.parse.quote(source, safe='/'))

    def healthy():
        try:
            session = json.loads(read_url(PUBLIC_BASE + 'api/auth/session', 50_000))
            articles = json.loads(read_url(PUBLIC_BASE + 'api/health', 50_000))
            if session.get('authenticated') is not False or articles.get('status') != 'ok':
                return False
            for info in FILES.values():
                filename = Path(info['source']).name
                fresh_url = PUBLIC_BASE + urllib.parse.quote(filename) + '?release=' + str(time.time_ns())
                if digest(read_url(fresh_url)) != info['new']:
                    return False
            return True
        except (OSError, ValueError, RuntimeError):
            return False

    backup = Path('/root') / ('wep-pril-fullscreen-backup-' + str(time.time_ns()))
    try:
        changed = publish(Path('/opt/wep_pril'), backup, FILES, download, lambda: None, healthy)
    except Exception as error:
        print('VIDEO_FULLSCREEN_PUBLISH_FAILED=' + (
            str(error) if isinstance(error, RuntimeError) else type(error).__name__))
        raise SystemExit(1) from None
    print('VIDEO_FULLSCREEN_PUBLISHED_OK' if changed else 'VIDEO_FULLSCREEN_ALREADY_CURRENT')
    if changed:
        print('BACKUP_DIR=' + str(backup))


if __name__ == '__main__':
    main()
