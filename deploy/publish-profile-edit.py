#!/usr/bin/env python3
"""Publish the agreed profile editor from a hash-pinned private ZIP on Timeweb.

Usage: python3 publish-profile-edit.py /root/profile-edit.zip [--apply]
ZIP: manifest.json {revision, unitBefore, files: {repo_path: {before, sha256}}},
     payload/<repo_path>. No database schema change or data rollback.
"""

import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import urllib.request
import zipfile

ROOT = Path('/opt/wep_pril')
NGINX = Path('/etc/nginx/sites-available/wep-pril-domain')
AUTH_UNIT = Path('/etc/systemd/system/wep-pril-auth.service')
UNIT_SOURCE = 'deploy/wep-pril-auth.service'
NGINX_SOURCE = 'deploy/nginx-domain.conf'
BACKUP_SOURCE = 'deploy/backup.py'
VERIFY_BACKUP = ROOT / 'deploy/verify-backup.py'
REQUIRED = {UNIT_SOURCE, NGINX_SOURCE, BACKUP_SOURCE,
            'backend/auth/profile-photo.mjs', 'backend/auth/main.mjs',
            'backend/auth/http.mjs', 'backend/auth/store.mjs',
            'backend/auth/profile.mjs'}
PHOTO_LOCATION = re.compile(rb'(?m)^    location = /api/auth/profile-photo \{\n(?:        [^\n]*\n)+    \}')
AUTH_LOCATION = re.compile(rb'(?m)^    location \^~ /api/auth/ \{')


def digest(data):
    return hashlib.sha256(data).hexdigest() if data is not None else None


def command(args, *, timeout=120):
    return subprocess.run(args, check=True, stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, timeout=timeout)


def target(name):
    if name.startswith('Фронт/'):
        relative = Path('frontend') / name[6:]
    elif name.startswith(('backend/auth/', 'deploy/')):
        relative = Path(name)
    else:
        raise RuntimeError('UNEXPECTED_RELEASE_PATH')
    if any(part in ('', '.', '..') for part in relative.parts) or name.endswith('/'):
        raise RuntimeError('UNSAFE_RELEASE_PATH')
    path = ROOT / relative
    if ROOT not in path.parents or any(part.is_symlink() for part in (path, *path.parents)):
        raise RuntimeError('UNSAFE_RELEASE_PATH')
    if not path.parent.is_dir():
        raise RuntimeError('RELEASE_PARENT_MISSING')
    return path


def atomic(path, data):
    stat = path.stat() if path.exists() else None
    temporary = path.with_name(path.name + '.profile-release-' + str(time.time_ns()))
    try:
        with temporary.open('xb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, stat.st_mode & 0o777 if stat else 0o644)
        os.chown(temporary, stat.st_uid if stat else 0, stat.st_gid if stat else 0)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def health():
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    for _ in range(30):
        try:
            with opener.open('http://127.0.0.1:3001/api/auth/session', timeout=3) as response:
                if response.status == 200 and json.load(response) == {'authenticated': False, 'user': None}:
                    return
        except (OSError, ValueError):
            pass
        time.sleep(.3)
    raise RuntimeError('AUTH_HEALTH_FAILED')


def nginx_with_photo(before, source):
    source = source.replace(b'\r\n', b'\n')
    found = PHOTO_LOCATION.search(source)
    if not found or len(PHOTO_LOCATION.findall(source)) != 1:
        raise RuntimeError('PROFILE_PHOTO_LOCATION_MISSING')
    if PHOTO_LOCATION.search(before):
        if PHOTO_LOCATION.search(before).group() != found.group():
            raise RuntimeError('PROFILE_PHOTO_LOCATION_CONFLICT')
        return before
    anchor = AUTH_LOCATION.search(before)
    if not anchor:
        raise RuntimeError('AUTH_NGINX_LOCATION_MISSING')
    return before[:anchor.start()] + found.group() + b'\n\n' + before[anchor.start():]


def unit_with_state(before, source):
    normalized = before.replace(b'\r\n', b'\n')
    source = source.replace(b'\r\n', b'\n')
    if b'StateDirectory=wep-pril-auth\n' in normalized:
        after = normalized
    else:
        anchor = b'ProtectHome=true\n'
        if normalized.count(anchor) != 1:
            raise RuntimeError('AUTH_UNIT_ANCHOR_MISSING')
        after = normalized.replace(anchor, anchor + b'StateDirectory=wep-pril-auth\n')
    if after != source:
        raise RuntimeError('AUTH_UNIT_UNEXPECTED_CHANGE')
    ending = b'\r\n' if b'\r\n' in before else b'\n'
    return after.replace(b'\n', ending)


def manifest_payload(archive):
    manifest = json.loads(archive.read('manifest.json'))
    if not isinstance(manifest, dict) or not re.fullmatch('[0-9a-f]{40}', manifest.get('revision', '')):
        raise RuntimeError('PINNED_REVISION_REQUIRED')
    if not re.fullmatch('[0-9a-f]{64}', manifest.get('unitBefore', '')):
        raise RuntimeError('SYSTEMD_UNIT_PIN_REQUIRED')
    files = manifest.get('files')
    if not isinstance(files, dict) or not REQUIRED <= files.keys():
        raise RuntimeError('RELEASE_FILES_INCOMPLETE')
    if set(archive.namelist()) != {'manifest.json', *(f'payload/{name}' for name in files)}:
        raise RuntimeError('RELEASE_CONTENT_MISMATCH')
    before, payload = {}, {}
    for name, expected in files.items():
        if not isinstance(expected, dict) or set(expected) != {'before', 'sha256'}:
            raise RuntimeError('BAD_FILE_MANIFEST')
        path = target(name)
        before[name] = path.read_bytes() if path.exists() else None
        payload[name] = archive.read('payload/' + name)
        if digest(before[name]) != expected['before'] or digest(payload[name]) != expected['sha256']:
            raise RuntimeError('SOURCE_MISMATCH:' + name)
    return manifest, before, payload


def restore_target(name, expected, old):
    path = target(name)
    if (path.read_bytes() if path.exists() else None) != expected:
        raise RuntimeError('ROLLBACK_CONCURRENT_CHANGE:' + name)
    if old is None:
        path.unlink()
    else:
        atomic(path, old)


def main():
    os.umask(0o077)
    if os.geteuid() != 0 or len(sys.argv) not in (2, 3):
        raise RuntimeError('ROOT_AND_PRIVATE_RELEASE_REQUIRED')
    apply = len(sys.argv) == 3 and sys.argv[2] == '--apply'
    if len(sys.argv) == 3 and not apply:
        raise RuntimeError('UNKNOWN_OPTION')
    with open('/run/lock/wep-pril-profile-release.lock', 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        with zipfile.ZipFile(sys.argv[1]) as archive:
            manifest, before, payload = manifest_payload(archive)
        nginx_before = NGINX.read_bytes()
        unit_before = AUTH_UNIT.read_bytes()
        if digest(unit_before) != manifest['unitBefore']:
            raise RuntimeError('SYSTEMD_UNIT_SOURCE_MISMATCH')
        unit_after = unit_with_state(unit_before, payload[UNIT_SOURCE])
        nginx_after = nginx_with_photo(nginx_before, payload[NGINX_SOURCE])
        health()
        if not apply:
            print('PROFILE_RELEASE_PREFLIGHT_OK files=' + str(len(payload)))
            return

        backup_dir = Path('/root') / ('webpril-profile-release-' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
        backup_dir.mkdir(mode=0o700)
        (backup_dir / 'manifest.json').write_text(json.dumps(manifest), encoding='utf8')
        (backup_dir / 'nginx.conf').write_bytes(nginx_before)
        (backup_dir / 'auth.service').write_bytes(unit_before)
        for name, old in before.items():
            if old is not None:
                path = backup_dir / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(old)

        # Install the updated backup helper first, then prove a full database
        # restore and archive checksum before touching the running service.
        if (target(BACKUP_SOURCE).read_bytes() if target(BACKUP_SOURCE).exists() else None) != before[BACKUP_SOURCE]:
            raise RuntimeError('BACKUP_HELPER_CONCURRENT_CHANGE')
        atomic(target(BACKUP_SOURCE), payload[BACKUP_SOURCE])
        try:
            output = command(['python3', str(target(BACKUP_SOURCE))], timeout=1800).stdout.decode().strip()
            backup = Path(output.splitlines()[-1]).resolve()
            if backup.parent != (ROOT / 'backups').resolve() or not (backup / 'complete').is_file():
                raise RuntimeError('VERIFIED_BACKUP_PATH_REQUIRED')
            command(['python3', str(VERIFY_BACKUP), str(backup)], timeout=1800)
        except Exception:
            restore_target(BACKUP_SOURCE, payload[BACKUP_SOURCE], before[BACKUP_SOURCE])
            raise

        written = []
        stopped = False
        try:
            command(['systemctl', 'stop', 'wep-pril-auth'])
            stopped = True
            for name in sorted(payload, key=lambda item: item.endswith('.html')):
                if name == BACKUP_SOURCE:
                    continue
                path = target(name)
                if (path.read_bytes() if path.exists() else None) != before[name]:
                    raise RuntimeError('CONCURRENT_CHANGE:' + name)
                atomic(path, payload[name])
                written.append(name)
            if NGINX.read_bytes() != nginx_before or AUTH_UNIT.read_bytes() != unit_before:
                raise RuntimeError('SERVER_CONFIG_CONCURRENT_CHANGE')
            atomic(AUTH_UNIT, unit_after)
            command(['systemctl', 'daemon-reload'])
            atomic(NGINX, nginx_after)
            command(['nginx', '-t'])
            command(['systemctl', 'start', 'wep-pril-auth'])
            stopped = False
            health()
            command(['systemctl', 'reload', 'nginx'])
            if any(digest(target(name).read_bytes()) != manifest['files'][name]['sha256'] for name in payload):
                raise RuntimeError('FINAL_CHECKSUM_FAILED')
            if AUTH_UNIT.read_bytes() != unit_after or NGINX.read_bytes() != nginx_after:
                raise RuntimeError('SERVER_CONFIG_READBACK_FAILED')
        except Exception:
            if not stopped:
                command(['systemctl', 'stop', 'wep-pril-auth'])
            for name in reversed(written):
                restore_target(name, payload[name], before[name])
            restore_target(BACKUP_SOURCE, payload[BACKUP_SOURCE], before[BACKUP_SOURCE])
            if AUTH_UNIT.read_bytes() == unit_after:
                atomic(AUTH_UNIT, unit_before)
            if NGINX.read_bytes() == nginx_after:
                atomic(NGINX, nginx_before)
            command(['systemctl', 'daemon-reload'])
            command(['nginx', '-t'])
            command(['systemctl', 'start', 'wep-pril-auth'])
            command(['systemctl', 'reload', 'nginx'])
            health()
            raise
        print('PROFILE_RELEASE_OK revision=' + manifest['revision'] + ' backup=' + str(backup))
        print('ROLLBACK_FILES=' + str(backup_dir))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(str(error) if isinstance(error, RuntimeError) else 'PROFILE_RELEASE_FAILED', file=sys.stderr)
        sys.exit(1)
