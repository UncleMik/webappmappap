#!/usr/bin/env python3
"""Publish approved lesson descriptions and timestamps without restarting services."""
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import time
import urllib.parse
import urllib.request

SUPPORT_REVISION = 'b98269cf110bc92876bb5600ade53cdd4de1745c'
SUPPORT_SHA = '9bd67620cc53381ee119135c1028f2a044621b9612599656f036644a2aaa5474'
FILES = {'frontend/weekly-videos.js': {'source': 'Фронт/weekly-videos.js', 'old': '625c36b9aac350ffcfe9994ad702a04f8a98cab5950389f1bf15fb3c935d4fe9', 'new': '7f9c213d6fb4d402c2192f8ab96e898e29a435ff369536b8e7e11db0836cc888'}, 'frontend/weekly-video-player.js': {'source': 'Фронт/weekly-video-player.js', 'old': '1e3738712e3bc751b6186014834c33aa1ace57fdfa1c09126434aa88913537d3', 'new': '02d1cf1286ee685075b6caf4e3997a9e326f94eaef87a9e15efc4e422eccb259'}, 'frontend/video.js': {'source': 'Фронт/video.js', 'old': '3e65f8a47b5f81a779ff3732c3bbdafb0cf829552ded954c8c3de5ddbfb8e656', 'new': '17d6d0edd506d3d9a991a73b458c1e0bb4de3fa8a0490e4ab4e7aade4b491b6c'}, 'frontend/video.css': {'source': 'Фронт/video.css', 'old': '4f269b94f9455bdb2ab659d57bc3f9e0a5937c6af22e4dd16277c9d6f5a03b85', 'new': 'af271f0c283fc7e7ddd3b911a961a670f23203571e4fe1b3467c65b6af8404c5'}, 'frontend/video.html': {'source': 'Фронт/video.html', 'old': '933c12356a45cac9d666fb29042d238533b8de296dc7e04e2ded569b0ee15075', 'new': 'fde07f21d74ae4485877faeb7c7f42f6d0cf4138d74d30830d2974e5e1f78a72'}, 'frontend/journey.html': {'source': 'Фронт/journey.html', 'old': 'ba9d28b142395c0ee0738769d14402953ff07ca4da62a5bdc10c135fb1656acc', 'new': 'd02d034dc1172d545fe5518f176a9f6f324abb042153147c8fd1206c346ecd68'}}

def read_url(url):
    with urllib.request.urlopen(url, timeout=20) as response:
        data = response.read(200001)
    if len(data) > 200000:
        raise RuntimeError('RELEASE_FILE_TOO_LARGE')
    return data

def healthy():
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open('http://127.0.0.1:3001/api/auth/session', timeout=5) as response:
            session = json.load(response)
            if response.status != 200 or session.get('authenticated') is not False:
                return False
        with opener.open('http://127.0.0.1:3000/api/health', timeout=5) as response:
            return response.status == 200 and json.load(response).get('status') == 'ok'
    except (OSError, ValueError):
        return False

def main():
    if os.geteuid() != 0 or len(sys.argv) != 2 or not re.fullmatch(r'[0-9a-f]{40}',sys.argv[1]):
        raise SystemExit('ROOT_AND_PINNED_REVISION_REQUIRED')
    revision = sys.argv[1]
    base = 'https://raw.githubusercontent.com/UncleMik/webappmappap/'
    support = read_url(base + SUPPORT_REVISION + '/deploy/publish-weekly-videos.py')
    if hashlib.sha256(support).hexdigest() != SUPPORT_SHA:
        raise RuntimeError('PUBLISH_SUPPORT_CHECKSUM_FAILED')
    namespace = {'__name__':'video_timestamps_publish_support'}
    exec(compile(support,'reviewed_publish_support.py','exec'),namespace)
    if not healthy():
        raise RuntimeError('PREFLIGHT_HEALTH_FAILED')
    def download(name):
        return read_url(base + revision + '/' + urllib.parse.quote(name,safe='/'))
    backup = Path('/root/wep-pril-video-timestamps-backup-' + str(time.time_ns()))
    # The reviewed publisher provides SHA checks, atomic files and rollback.
    # Every target is in frontend/. The restart callback deliberately does nothing.
    changed = namespace['publish'](Path('/opt/wep_pril'), backup, FILES,
                                   download, lambda: None, healthy)
    print('VIDEO_TIMESTAMPS_PUBLISHED_OK')
    print('BACKUP_DIR=' + str(backup) if changed else 'ALREADY_CURRENT')
    print('AUTH_AND_MATERIALS_HEALTH_OK; NO_SERVICE_RESTART')

if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('VIDEO_TIMESTAMPS_PUBLISH_FAILED=' + (str(error) if isinstance(error,RuntimeError) else type(error).__name__))
        raise SystemExit(1) from None
