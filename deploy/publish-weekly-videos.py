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
    return hashlib.sha256(data).hexdigest() if data is not None else None


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
FILES = {'backend/auth/weekly-videos.mjs': {'source': 'backend/auth/weekly-videos.mjs', 'old': '6efdfb72328df4d60afd4e33dc4ff2ddae1679c191a33dd359f3abfc13baed9b', 'new': 'ef467c66ba0ad88a6160d10250dfe7720b5c515fb6c38b77123aa783bfa5aa87'}, 'frontend/weekly-videos.js': {'source': 'Фронт/weekly-videos.js', 'old': '70c3f37e982bb8c5b5475a5c66235b16262d9e19825dabff6b0cd02eb59ce07a', 'new': '625c36b9aac350ffcfe9994ad702a04f8a98cab5950389f1bf15fb3c935d4fe9'}, 'frontend/weekly-video-player.js': {'source': 'Фронт/weekly-video-player.js', 'old': '5c72c1b8bd113ef92ca46f002b4cb026c681437a248fcdc949122b78430759ca', 'new': '1e3738712e3bc751b6186014834c33aa1ace57fdfa1c09126434aa88913537d3'}, 'frontend/journey.html': {'source': 'Фронт/journey.html', 'old': '889e175c6d98b92a749e989d34a9f90998aca38164d0ddaea6c34be7a3fa42da', 'new': 'ba9d28b142395c0ee0738769d14402953ff07ca4da62a5bdc10c135fb1656acc'}, 'frontend/journey.css': {'source': 'Фронт/journey.css', 'old': 'f36cd260dab96f5ef1cd18f3bf764f4e290438409725881f0a977d60f5617e14', 'new': '43de1a922eba3901c650f76fd656931d13f8924355da73b7256cc75ee113ec01'}, 'frontend/video.html': {'source': 'Фронт/video.html', 'old': '38413e2722d298c0a4575ba99d0cc60d1102964befff4eafba7fb649c648293d', 'new': 'd877f388d479a227c0752bcfa3efe18f9fe2332befa2e6b131132d749546e38c'}, 'frontend/video.js': {'source': 'Фронт/video.js', 'old': '1a13ee270b464b5603ace97617122f6dcd75234781c4edc650544318c96d7b13', 'new': '3e65f8a47b5f81a779ff3732c3bbdafb0cf829552ded954c8c3de5ddbfb8e656'}, 'frontend/video.css': {'source': 'Фронт/video.css', 'old': 'd4d27e1f7876f173e8477f16765d409a2c5e237420d5fb2b671d718a1e1beab8', 'new': 'f7339e7b2c53ee4f5480f07464fc6cd3982ef6e5839a6272fb0103ccbe86e709'}, 'frontend/assets/weekly-vitamins.png': {'source': 'Фронт/assets/weekly-vitamins.png', 'old': None, 'new': 'f0dd0409b64355a013aa07c8105aeaaef295dfbd9c4c0992477f241f582f3ab7'}, 'frontend/assets/weekly-head-massage.png': {'source': 'Фронт/assets/weekly-head-massage.png', 'old': None, 'new': '00b01853173b0f1e0e2f45ca7f51a77a908b91dc709aae9c189717d305b9500e'}, 'frontend/assets/weekly-confidence.png': {'source': 'Фронт/assets/weekly-confidence.png', 'old': None, 'new': 'af2175e8143fa3250bdaad38f326de3bf7926c70d23b12b66e67f4baa597c7ad'}}


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
            data = response.read(5000001)
        if len(data) > 5000000:
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
