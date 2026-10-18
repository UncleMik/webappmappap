#!/usr/bin/env python3
"""Install the reviewed GetCourse marker adapter while public auth is disabled."""

import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import time
from urllib.error import HTTPError
from urllib.request import ProxyHandler, build_opener, urlopen

ROOT = Path('/opt/wep_pril/backend')
TARGET = ROOT / 'auth/providers.mjs'
SOURCE = 'https://raw.githubusercontent.com/UncleMik/webappmappap/aa8eea7fb8b8ac9785d5238eddb060ce15b5a388/backend/auth/providers.mjs'
EXPECTED = '123b4d887a988c3c1a94b2f7670eee46bec16ed8ca691b5a22ee0c8fc0d94107'
NODE = '/usr/local/bin/node'
SERVICE = 'wep-pril-auth'
SESSION_URL = 'http://127.0.0.1:3001/api/auth/session'
BACKUP_DIR = Path('/root')
LOCAL_HTTP = build_opener(ProxyHandler({}))


def run(*args, **kwargs):
    subprocess.run(args, check=True, capture_output=True, **kwargs)


def auth_is_disabled():
    try:
        with LOCAL_HTTP.open(SESSION_URL, timeout=2) as response:
            return False
    except HTTPError as error:
        result = json.load(error)
        return (error.code == 503 and result.get('error') == 'auth_unavailable'
                and result.get('message') == 'Вход ещё не подключён. Попробуйте позже.')
    except (OSError, ValueError):
        return False


def main():
    if os.geteuid() != 0:
        raise SystemExit('RUN_AS_ROOT')
    run(NODE, '--env-file=/etc/wep-pril/auth.env', '--input-type=module', '-e',
        "import {readConfig} from './auth/config.mjs'; process.exit(readConfig().enabled ? 2 : 0)",
        cwd=ROOT, env={'PATH': '/usr/local/bin:/usr/bin:/bin', 'LANG': 'C.UTF-8'})
    if not auth_is_disabled():
        raise SystemExit('STOP: expected working auth listener with public login disabled')
    with urlopen(SOURCE, timeout=20) as response:
        source = response.read(65537)
    if len(source) > 65536 or hashlib.sha256(source).hexdigest() != EXPECTED:
        raise SystemExit('STOP: provider checksum mismatch; no changes made')

    original, metadata = TARGET.read_bytes(), TARGET.stat()
    stamp = str(time.time_ns())
    stage = TARGET.with_name('.providers-stage-' + stamp + '.mjs')
    backup = BACKUP_DIR / ('wep-pril-providers-' + stamp + '.bak')
    try:
        stage.write_bytes(source)
        os.chmod(stage, stat.S_IMODE(metadata.st_mode))
        os.chown(stage, metadata.st_uid, metadata.st_gid)
        run(NODE, '--check', str(stage))
        descriptor = os.open(backup, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(descriptor, 'wb') as output:
            output.write(original)
        print('BACKUP=' + str(backup), flush=True)
        os.replace(stage, TARGET)
        try:
            run('systemctl', 'restart', SERVICE)
            for attempt in range(20):
                if auth_is_disabled():
                    break
                time.sleep(0.25)
            else:
                raise RuntimeError('Disabled auth response was not restored after restart')
        except Exception:
            stage.write_bytes(original)
            os.chmod(stage, stat.S_IMODE(metadata.st_mode))
            os.chown(stage, metadata.st_uid, metadata.st_gid)
            os.replace(stage, TARGET)
            run('systemctl', 'restart', SERVICE)
            raise SystemExit('UPDATE_FAILED: original provider restored; public login must stay disabled')
    finally:
        stage.unlink(missing_ok=True)
    print('SOURCE_SHA256_OK')
    print('PROVIDER_UPDATED_AUTH_DISABLED')


if __name__ == '__main__':
    try:
        main()
    except Exception:
        raise SystemExit('UPDATE_FAILED: check private configuration and the reported backup')
