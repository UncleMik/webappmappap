"""Publish only the auth gate; preserve all poll, chat and account data.

Run as root on Timeweb: python3 publish-poll-chat-navigation.py auth-gate.js
"""
import hashlib
import os
from pathlib import Path
import shutil
import sys
import tempfile
from datetime import datetime, timezone

TARGET = Path('/opt/wep_pril/frontend/auth-gate.js')
EXPECTED = '167cd9eca0865e2eb53f8125903b848cb02c306a6a29c4b89de4f27c004d27c5'


def digest(data):
    return hashlib.sha256(data).hexdigest()


def main():
    data = Path(sys.argv[1]).read_bytes()
    if TARGET.is_symlink() or TARGET.resolve() != TARGET:
        raise RuntimeError('Unsafe target')
    previous = TARGET.read_bytes()
    if previous == data:
        print('Already published:', digest(data))
        return
    if digest(previous) != EXPECTED:
        raise RuntimeError('Installed auth gate changed; review before publishing')
    if b'checkEpoch' not in data or len(data) > 15000:
        raise RuntimeError('Unexpected release source')
    backup = Path('/root') / ('poll-chat-navigation-' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ'))
    backup.mkdir(mode=0o700)
    shutil.copy2(TARGET, backup / 'auth-gate.js')
    stat = TARGET.stat()
    fd, temporary = tempfile.mkstemp(prefix='.auth-gate-', dir=TARGET.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, stat.st_mode & 0o777)
        os.chown(temporary, stat.st_uid, stat.st_gid)
        os.replace(temporary, TARGET)
    finally:
        Path(temporary).unlink(missing_ok=True)
    assert TARGET.read_bytes() == data
    print('Published:', digest(data), 'Backup:', backup)


if __name__ == '__main__':
    main()
