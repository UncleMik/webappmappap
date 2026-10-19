#!/usr/bin/env python3
"""Publish only the reviewed account UI; never restart auth or modify its data."""
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import time
import urllib.parse
import urllib.request

SUPPORT_REVISION = '364dcfda90b9ed12177cd138753dfde26e060248'
SUPPORT_SHA = '803a5c0039f1f489556e945139cd0f67faa3e515587e6526d5ade267ee881deb'
FILES = {'frontend/account-ui.css': {'source': 'Фронт/account-ui.css',
                             'old': None,
                             'new': '08d3428c7f105af167fa61a1e192808dbc790fb3b52c3cb262e50893c862f017'},
 'frontend/account-access.js': {'source': 'Фронт/account-access.js',
                                'old': 'e469e3d36fb3386aafa9e53325eacd6661b9bd5772f16964941a302b0881c3e9',
                                'new': '0b0a1799ce0bec05797c272374cba93262721a243e651fcdc28fd60cef5eea6f'},
 'frontend/course-access.js': {'source': 'Фронт/course-access.js',
                               'old': '9592a678a2542135ecda27e322c3c960b837b10168aa8de2d261a80a27eba235',
                               'new': '7a2a74ff8d1e21d52d566c43c8b31ebad244d87da20bed6ce69ca60ab04a858a'},
 'frontend/courses.js': {'source': 'Фронт/courses.js',
                         'old': '7f39109250bf61097d3f92b539d20f9d2b4fb7bca97651539f3fcbd82c57dead',
                         'new': '010153a20851a704bd5da3087a0909d648b5802ada60e6e061aefb46b86bab87'},
 'frontend/profile.js': {'source': 'Фронт/profile.js',
                         'old': '32a275ecac5f0b2d99377fa839e6007dbac9a234011348dc79bc695076145ea0',
                         'new': '0735aae0a68f7b0399f67eff9d02909f64d6e07e090ead59e303b9b3e3dc9722'},
 'frontend/journey-week.js': {'source': 'Фронт/journey-week.js',
                              'old': '49a304938984b28feb6d0722f41df326bfcf51bfb80468290bb317057803c919',
                              'new': '06852963b9693d5941dd44b993406d53a3453b48365458d2718dbb408592d19e'},
 'frontend/baby-week.js': {'source': 'Фронт/baby-week.js',
                           'old': 'ee6d886600d590ef1c8419004ee5d48db5cc0102783379fc19d56d6057ecf6ef',
                           'new': 'cfe4557406a3239438e3c2c230e7ae519fe47afe343f9506e3254d8e202f0c8f'},
 'frontend/calendar-sheet.js': {'source': 'Фронт/calendar-sheet.js',
                                'old': 'abc568e8d73564c3af8f6354801177a5b3ae0d96dcca9c254ae8ce1a09ca59bb',
                                'new': 'ad33f2ea9892a44f40b13112b7415720c2d76f2e8b2de8be99ceb2517d9be3bc'},
 'frontend/index.html': {'source': 'Фронт/index.html',
                         'old': 'ecceafb9a3dbd6e65d172e7c869f793679bd09276d885723d0a7ad5ed8f65443',
                         'new': '65b6486c885eedc3b21e75fc234d99ac92482a964bd44b7c4293c217c7b2d158'},
 'frontend/personal-data.html': {'source': 'Фронт/personal-data.html',
                                 'old': 'eec3a2a2d978da5c3707b294fbe9d027d3da0faf1c1f689eba2b02d7e1b42c94',
                                 'new': '3c21d4c411b241650a6e90b7af2d6de6f3cac662618e359fe658a48e15204caa'},
 'frontend/my-courses.html': {'source': 'Фронт/my-courses.html',
                              'old': 'dc96a84f517b55b067b2f2810eaa390a1260443b08d335b7cdc9c601addd1022',
                              'new': 'fa0d780ccd92b642cecf5a22c175233c9eb854004a3b32d99d3d8255e07137cf'},
 'frontend/profile.html': {'source': 'Фронт/profile.html',
                           'old': 'b7a8b8d11d5379d994865606c07b5ed1980beb58d73154bc26280f0b0239aa0c',
                           'new': '8d523e93f21a9cbd01ada9191c8c87106d50955be69ca7a0e8b3f69f4a5a669c'},
 'frontend/courses.html': {'source': 'Фронт/courses.html',
                           'old': 'f264a5aa0db08c7ec0011632b226f6b308a9bc843e991325c701fa54b7eeea8f',
                           'new': '95e9ba13e17fc6ad978d17753436802f982e643d983df7a5e1f711a2be25640b'},
 'frontend/baby.html': {'source': 'Фронт/baby.html',
                        'old': '51dff97f25b06c41b6fd18863a8ac7675ba471dafe16f4869f24445c48b4ab40',
                        'new': '60a1cfbc514e9bd1259596b40a46442f65ac783326a684d01707c3bc55679c3e'},
 'frontend/mom.html': {'source': 'Фронт/mom.html',
                       'old': 'd82dda4e574c1ca5fff9a41031fdfd1fcb16b1a84013242168d1f1a933593095',
                       'new': 'd847ee4011c7ae22cedf177b0ebf1bfa99f2b8c36408c547bafcaef797d78d59'},
 'frontend/ai.html': {'source': 'Фронт/ai.html',
                      'old': '665153f30edb813c80c929a95db4f01f4fabd9ba4c74446db2b49fe93a22dc49',
                      'new': '15562156eb1b96cafd6bbcd7b4183e506e7546a1a02964bf7803ca91896111ce'}}

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
    namespace = {'__name__':'account_ui_publish_support'}
    exec(compile(support,'reviewed_publish_support.py','exec'),namespace)
    if not healthy():
        raise RuntimeError('PREFLIGHT_HEALTH_FAILED')
    def download(name):
        return read_url(base + revision + '/' + urllib.parse.quote(name,safe='/'))
    backup = Path('/root/wep-pril-account-ui-backup-' + str(time.time_ns()))
    # The reviewed publisher provides SHA checks, atomic files and rollback.
    # Every target is in frontend/. The restart callback deliberately does nothing.
    changed = namespace['publish'](Path('/opt/wep_pril'), backup, FILES,
                                   download, lambda: None, healthy)
    print('ACCOUNT_UI_PUBLISHED_OK')
    print('BACKUP_DIR=' + str(backup) if changed else 'ALREADY_CURRENT')
    print('AUTH_AND_MATERIALS_HEALTH_OK; NO_SERVICE_RESTART')

if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('ACCOUNT_UI_PUBLISH_FAILED=' + (str(error) if isinstance(error,RuntimeError) else type(error).__name__))
        raise SystemExit(1) from None
