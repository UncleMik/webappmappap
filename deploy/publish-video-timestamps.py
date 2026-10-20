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
FILES = {'frontend/weekly-videos.js': {'source': 'Фронт/weekly-videos.js', 'old': '7f9c213d6fb4d402c2192f8ab96e898e29a435ff369536b8e7e11db0836cc888', 'new': '7f9c213d6fb4d402c2192f8ab96e898e29a435ff369536b8e7e11db0836cc888', 'previous': ['625c36b9aac350ffcfe9994ad702a04f8a98cab5950389f1bf15fb3c935d4fe9', 'fad4b0d41286ad836a02cfd736433757a1d21fbacb7bc99e224e958db25765c3', 'fe36cbefb7c5bbdc4faa1967144ddb180763144025d97e0e100b9f450aab6e47']}, 'frontend/weekly-video-player.js': {'source': 'Фронт/weekly-video-player.js', 'old': '35109afaba225c99c120704e98b7d89b5de0dc637d5c95a9f3ca503755366ab3', 'new': '35109afaba225c99c120704e98b7d89b5de0dc637d5c95a9f3ca503755366ab3', 'previous': ['02d1cf1286ee685075b6caf4e3997a9e326f94eaef87a9e15efc4e422eccb259', '0ffc438e6c27d80b94a62d2699a1d6201e09096499ea6b0e877f410cdacc295d', '1e3738712e3bc751b6186014834c33aa1ace57fdfa1c09126434aa88913537d3', 'bb29e59196c92ea40f0f926e99fb24db7d77ec75969e76bcbce0193930707058', 'd33c82ebd848a37577526e9efe2e299e21639b9b05504c952efa4dd362088e9b']}, 'frontend/video.js': {'source': 'Фронт/video.js', 'old': 'a07555cd2bf617982f9f787e6d2a59894fec87e3d5ddfcc1c7e18fd0ae43def7', 'new': 'a07555cd2bf617982f9f787e6d2a59894fec87e3d5ddfcc1c7e18fd0ae43def7', 'previous': ['17d6d0edd506d3d9a991a73b458c1e0bb4de3fa8a0490e4ab4e7aade4b491b6c', '2b45caaeef16e1d8c02eb8545432c273243f14944fa8cb54e167762c30585d8f', '2f01706d5581e600f4d8331fcdfac5040e2474adf105241b70f6e03336b37d7a', '3e65f8a47b5f81a779ff3732c3bbdafb0cf829552ded954c8c3de5ddbfb8e656', 'f2b70c20b440c8d10fc186fd4a33ecb936772e24dfc8981bb1b511a612a48746']}, 'frontend/video.css': {'source': 'Фронт/video.css', 'old': 'af271f0c283fc7e7ddd3b911a961a670f23203571e4fe1b3467c65b6af8404c5', 'new': 'af271f0c283fc7e7ddd3b911a961a670f23203571e4fe1b3467c65b6af8404c5', 'previous': ['289e7935b80b4774afb2d7042b83e51505f21ca838c6a167e7053cf5b8e8bd53', '4f269b94f9455bdb2ab659d57bc3f9e0a5937c6af22e4dd16277c9d6f5a03b85', '7e176ed4166b4447e3fe4e3799dd8c6fcfcccf0a07137a8fb5fe90328d57c6bc', 'e8bc335f048a64e5acef260f6cb4e4d0cec32011dc6c6da28cccae6c8e4dee71', 'e981137230574c62c33812ffe7a31404b0fc6a0c592b9208f2ecd883bb5422a5', 'f6abfb2e5005b94a501fd576b6d8181a00764381e6ac6b716a94947ad267b97e', 'f7339e7b2c53ee4f5480f07464fc6cd3982ef6e5839a6272fb0103ccbe86e709']}, 'frontend/video.html': {'source': 'Фронт/video.html', 'old': 'd2c3655978457ba1ed3a0b98a45dd717dc52a9e2d120779e1e34bff6589c7d7e', 'new': 'd2c3655978457ba1ed3a0b98a45dd717dc52a9e2d120779e1e34bff6589c7d7e', 'previous': ['20b5d54827a815a112df8e975f6db931f5fc9769f63070742740c34d92fac0ce', '2a4334b976d3ea37107fb73117c37201a061cd11cdfe66029aaae47773fe7575', '2c493e5162e907b619f0953266e783456f0fe35140d26b83290812bbf5b6d5a6', '4abc5ca4b237e39d1e3d12b0f4b8dc4ffed4a003e30eea65dc8f6efb06f6a1ae', '4fd7dd3c6b396d6c2c2dc622235d12e89675313150c8ddea221e37a185298e03', '6aca1c3d2530c3f25988bec4803192ccf58be09e01d57f2a2ff0c192e572dd1b', '6cf1fac3c09dd2266bccfd06648ad31c3513bf1591e60ec12a76f6ec533b9f52', '7a79dec787592259d900b1528c0a76257b32e007965b1ba7a8988c2ab4e66199', '8e5e1345a7f6a21e4e863ea8be67c64add660e5b429131cb028d6483062ff39b', '933c12356a45cac9d666fb29042d238533b8de296dc7e04e2ded569b0ee15075', '95ee4241ca54ad57a9038c4990f6c85280ded8cf5ce25d564422406a44f9ed19', 'c3be9adbd1a44bd25513699095cd107acfa9c246d9f4230a8345ec98ca61aae1', 'd877f388d479a227c0752bcfa3efe18f9fe2332befa2e6b131132d749546e38c', 'fde07f21d74ae4485877faeb7c7f42f6d0cf4138d74d30830d2974e5e1f78a72']}, 'frontend/journey.html': {'source': 'Фронт/journey.html', 'old': '6438a81f6940a08b3e61b10229fc05c65eddc31ae603baef097085a9e5425d02', 'new': '6438a81f6940a08b3e61b10229fc05c65eddc31ae603baef097085a9e5425d02', 'previous': ['57f1e6b0c20058577cf476e2e5856ccf02c9339e750729c01bae4ccf2f4d553c', '59c7c3cea973f3a021d60aa08c585d4e2c44da33909524ade9ab32a0fdd05b63', '80eeabb5c1e9dc050384208df51fefd46a0ddf248038d5c30b1bb9d204f4c555', '8b94a05342e695a1979be6fd4e7c434790f8c0df19519c34372cc9004260a823', 'a0b2bbe56dbae2d9d4de892103c5ea7bb3d33e9168585be544608688f4bfe0a9', 'ba9d28b142395c0ee0738769d14402953ff07ca4da62a5bdc10c135fb1656acc', 'd02d034dc1172d545fe5518f176a9f6f324abb042153147c8fd1206c346ecd68', 'eef408017e23793bceb6873b10db07f82bc76da31a1b27c3b1ee64fe873d6a5f']}, 'frontend/video-fullscreen.js': {'source': 'Фронт/video-fullscreen.js', 'old': 'b8aea6920bb576a90d2ff1ab3af6f9eb85cdeeea69c8834bebbdb3445383b1ce', 'new': 'b8aea6920bb576a90d2ff1ab3af6f9eb85cdeeea69c8834bebbdb3445383b1ce', 'previous': ['00e5c56f49ab1ee3e025ce62380259109274237cc69903905a420ff6e8e1609d', None]}}

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

def select_baselines(root):
    files = {name: dict(info) for name, info in FILES.items()}
    mismatches = []
    for name, info in files.items():
        target = root / name
        if not target.resolve().is_relative_to(root.resolve()) or any(
                p.is_symlink() for p in (target, *target.parents)):
            raise RuntimeError('UNSAFE_TARGET')
        data = target.read_bytes() if target.exists() else None
        actual = hashlib.sha256(data).hexdigest() if data is not None else None
        if actual in info.get('previous', []):
            info['old'] = actual
        if actual not in (info['old'], info['new']):
            mismatches.append(name + ':SHA256=' + str(actual))
    if mismatches:
        # Report all unexpected baselines, without disclosing file contents.
        raise RuntimeError('SOURCE_MISMATCH:' + ';'.join(mismatches))
    return files


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
    root = Path('/opt/wep_pril')
    # Accept only hashes from the reviewed player, onboarding and login releases.
    files = select_baselines(root)
    changed = namespace['publish'](root, backup, files,
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
