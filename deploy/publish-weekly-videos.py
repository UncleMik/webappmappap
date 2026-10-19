"""Publish only the approved three-video integration; no secrets, database or nginx changes."""
import hashlib
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request


def digest(data):
    return hashlib.sha256(data.replace(b'\r\n', b'\n')).hexdigest() if data is not None else None


def publish(root, backup, files, download, restart, healthy):
    root = root.resolve(strict=True)
    targets, before, payloads = {}, {}, {}
    for name, info in files.items():
        target = root / name
        if not target.resolve().is_relative_to(root) or any(p.is_symlink() for p in (target, *target.parents)):
            raise RuntimeError('UNSAFE_TARGET')
        old = target.read_bytes() if target.exists() else None
        if digest(old) not in (info['old'], info['new']):
            raise RuntimeError('SOURCE_MISMATCH:' + name)
        data = download(info['source'])
        if digest(data) != info['new']:
            raise RuntimeError('DOWNLOAD_MISMATCH:' + name)
        targets[name], before[name], payloads[name] = target, old, data
    if all(digest(before[n]) == files[n]['new'] for n in files):
        if not healthy():
            raise RuntimeError('ALREADY_PRESENT_BUT_UNHEALTHY')
        return False
    backup.mkdir(mode=0o700, parents=False, exist_ok=False)
    for n, old in before.items():
        if old is not None:
            saved = backup / n
            saved.parent.mkdir(parents=True, exist_ok=True)
            saved.write_bytes(old); saved.chmod(0o600)
    changed = []
    def write(target, data):
        temp = target.with_name(target.name + '.video-release.tmp')
        fd = os.open(temp, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
        try:
            with os.fdopen(fd, 'wb') as stream:
                stream.write(data)
            temp.chmod(0o644)
            os.replace(temp, target)
        finally:
            if temp.exists():
                temp.unlink()
    try:
        for n in files:
            target = targets[n]
            current = target.read_bytes() if target.exists() else None
            if current != before[n]:
                raise RuntimeError('CONCURRENT_CHANGE:' + n)
            if digest(current) == files[n]['new']:
                continue
            write(target, payloads[n]); changed.append(n)
        restart()
        if not healthy():
            raise RuntimeError('HEALTH_CHECK_FAILED')
    except Exception:
        conflict = False
        for n in reversed(changed):
            if targets[n].read_bytes() != payloads[n]:
                conflict = True
                continue
            if before[n] is None:
                targets[n].unlink()
            else:
                write(targets[n], before[n])
        restart()
        if conflict:
            raise RuntimeError('ROLLBACK_CONCURRENT_CHANGE') from None
        raise
    return True


# Release hashes are filled from the reviewed source files before publication.
FILES = {'backend/auth/weekly-videos.mjs': {'source': 'backend/auth/weekly-videos.mjs', 'old': None, 'new': '6efdfb72328df4d60afd4e33dc4ff2ddae1679c191a33dd359f3abfc13baed9b'}, 'backend/auth/http.mjs': {'source': 'backend/auth/http.mjs', 'old': '3246db1260151539c69424cca8d3055a018d514ee5a9664b5dce4bb79280560a', 'new': '7d9bd1f1d47f41099bbb8061e7fb520ff6a5631c97e154a80e2397e1f684c725'}, 'frontend/weekly-videos.js': {'source': 'Фронт/weekly-videos.js', 'old': None, 'new': '70c3f37e982bb8c5b5475a5c66235b16262d9e19825dabff6b0cd02eb59ce07a'}, 'frontend/weekly-video-player.js': {'source': 'Фронт/weekly-video-player.js', 'old': None, 'new': '5c72c1b8bd113ef92ca46f002b4cb026c681437a248fcdc949122b78430759ca'}, 'frontend/video.js': {'source': 'Фронт/video.js', 'old': '0fc593def4b57048322d92813ab5f2d45bb691192209ac35b151737fc666881a', 'new': '1a13ee270b464b5603ace97617122f6dcd75234781c4edc650544318c96d7b13'}, 'frontend/video.css': {'source': 'Фронт/video.css', 'old': 'dbdf736bcbb4cf82c5dfc82bd8826e8958f6102ef14f7bd7202b8ea743603ec6', 'new': 'd4d27e1f7876f173e8477f16765d409a2c5e237420d5fb2b671d718a1e1beab8'}, 'frontend/login.js': {'source': 'Фронт/login.js', 'old': '67561c66575ae317e16c623968ae33ddf9ad4d2ec14f6777b747d7059fdb68d4', 'new': '2abd86b9af5dfd8a3657c32ca9e47325de37e039b8232e90346b4c0e776a872e'}, 'frontend/journey.html': {'source': 'Фронт/journey.html', 'old': 'e6ccb2ed983b75eeab1254c3c24f68cc24d7da7d9e72e0a69247c7df7f41df3c', 'new': '889e175c6d98b92a749e989d34a9f90998aca38164d0ddaea6c34be7a3fa42da'}, 'frontend/video.html': {'source': 'Фронт/video.html', 'old': '121a1e42ed4e2a79b5b5b1224e2e667eadde9a8f113668c20d5902af3db39266', 'new': '38413e2722d298c0a4575ba99d0cc60d1102964befff4eafba7fb649c648293d'}, 'frontend/login.html': {'source': 'Фронт/login.html', 'old': '1c2c7328850703e40e569a457605b2b46730c1ed657bb6918080f2d5280f6511', 'new': '6ac993f9609cdbbcb3ee5c2a7388895aecd43fcc96e12bdc78d32c7bdad9a532'}}


def main():
    if os.geteuid() != 0 or len(sys.argv) != 2 or not re.fullmatch(r'[0-9a-f]{40}', sys.argv[1]):
        raise SystemExit('ROOT_AND_PINNED_REVISION_REQUIRED')
    if not FILES:
        raise SystemExit('RELEASE_MANIFEST_MISSING')
    subprocess.run(['systemctl', 'is-active', '--quiet', 'wep-pril-auth'], check=True)
    revision = sys.argv[1]
    def download(source):
        url = 'https://raw.githubusercontent.com/UncleMik/webappmappap/' + revision + '/' + urllib.parse.quote(source, safe='/')
        with urllib.request.urlopen(url, timeout=25) as response:
            data = response.read(200001)
        if len(data) > 200000:
            raise RuntimeError('RELEASE_FILE_TOO_LARGE')
        return data
    def restart():
        subprocess.run(['systemctl', 'restart', 'wep-pril-auth'], check=True, timeout=30, capture_output=True)
    def healthy():
        for _ in range(6):
            try:
                with urllib.request.urlopen('http://127.0.0.1:3001/api/auth/session', timeout=3) as response:
                    if response.status != 200:
                        return False
                try:
                    urllib.request.urlopen('http://127.0.0.1:3001/api/auth/videos/contractions-lesson', timeout=3)
                except urllib.error.HTTPError as error:
                    return error.code == 401
                return False
            except (OSError, urllib.error.URLError):
                time.sleep(.5)
        return False
    backup = Path('/root') / ('wep-pril-video-backup-' + str(time.time_ns()))
    try:
        changed = publish(Path('/opt/wep_pril'), backup, FILES, download, restart, healthy)
    except Exception as error:
        print('WEEKLY_VIDEOS_PUBLISH_FAILED=' + (str(error) if isinstance(error, RuntimeError) else type(error).__name__))
        raise SystemExit(1) from None
    print('WEEKLY_VIDEOS_PUBLISHED_OK')
    print('BACKUP_DIR=' + str(backup) if changed else 'ALREADY_CURRENT')


if __name__ == '__main__':
    main()
