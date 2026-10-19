#!/usr/bin/env python3
"""Publish a pinned onboarding release to the existing auth service.

Only auth_users.profile is migrated. A failed release restores files, not
database rows; the nullable column is deliberately safe to leave in place.
"""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request


ROOT = Path('/opt/wep_pril')
DB = 'wep_pril_auth'
SERVICE = 'wep-pril-auth'
AUTH_ORIGIN = 'https://app.legkie-rody.ru'

# Root fills every old/new SHA-256 after final review and before publication.
# Backend JavaScript is listed first; frontend HTML is listed last.
FILES = {'backend/auth/http.mjs': {'source': 'backend/auth/http.mjs', 'old': '7d9bd1f1d47f41099bbb8061e7fb520ff6a5631c97e154a80e2397e1f684c725', 'new': '9524fb647adcf25787f75ab6462200bab080446d0820dceb67d97d7ae9109e6e'}, 'backend/auth/profile-migration.sql': {'source': 'backend/auth/profile-migration.sql', 'old': None, 'new': '6c628c8dc83192eae7fe8de89ae915cfd97c7ba6946c48b7ea3943f324f93644'}, 'backend/auth/profile.mjs': {'source': 'backend/auth/profile.mjs', 'old': None, 'new': '203b2a7ecf324b01e8470f2e0c4cf3b6b9c8f839fa9d9d72b24126f7b2e24db7'}, 'backend/auth/schema.sql': {'source': 'backend/auth/schema.sql', 'old': 'c6d4256c0b7de66e9561c065d0f782c1bb0160bdaea75094532df8e390973b98', 'new': '6a17dcc554d41e2edb8f5ead0b4c8697e3b90635e01d085f64269cba13a1de8a'}, 'backend/auth/service.mjs': {'source': 'backend/auth/service.mjs', 'old': 'f046b09e5d0d8801a3887b2b8245b4f4a7fc4c4b50c00b4206b057254af495a5', 'new': '40fe4bc3d1c0ad7f1c9cd2bca4fbdd06c4fa5b0d66a37315b1174a7eb65440c0'}, 'backend/auth/store.mjs': {'source': 'backend/auth/store.mjs', 'old': '229edf978d19e2a244feb673d1b0d7f5157cd94a20eb3fb5dc5e6952835efefb', 'new': '92b66152d50c340111cb93b5b0f30029dfe20233bebed3590b03fc66b2e5338c'}, 'frontend/account-profile.js': {'source': 'Фронт/account-profile.js', 'old': None, 'new': '30dd32531a49b8bb963ddfa5ad2c7148496e36e15c39d8691068f4ac9ac1bf27'}, 'frontend/account-ui.css': {'source': 'Фронт/account-ui.css', 'old': '08d3428c7f105af167fa61a1e192808dbc790fb3b52c3cb262e50893c862f017', 'new': 'bd13952b44fe7554b67cbda319fdd8e02f9ffd0b7a349a0e857a3f8b5a9ee7f6'}, 'frontend/app-navigation.js': {'source': 'Фронт/app-navigation.js', 'old': '33a9cf4bb5bee1f422b54b6b852a0e4d6702d0909b80807404f4de07cea9cb94', 'new': '759dad3d32a4fa192936aa74d639038a1e916bdc1b19a8ffc721257ec0e086ed'}, 'frontend/articles-api.js': {'source': 'Фронт/articles-api.js', 'old': '52fc02dfb93006808a4a9cf1a60499e9fd6400b4635aa45fdc2a4dc9af06b260', 'new': '841334cc072ab98cded4ecb2ac6ecf8fafa3108e1e452ca4b116b90b171fb3d2'}, 'frontend/baby-week.js': {'source': 'Фронт/baby-week.js', 'old': 'cfe4557406a3239438e3c2c230e7ae519fe47afe343f9506e3254d8e202f0c8f', 'new': 'b1d03b515e2c351fbc09661d5d9603d64b95bb5698b945f93a7452e0555f879d'}, 'frontend/calendar-sheet.js': {'source': 'Фронт/calendar-sheet.js', 'old': 'ad33f2ea9892a44f40b13112b7415720c2d76f2e8b2de8be99ceb2517d9be3bc', 'new': '8b9a15123b181880605435ee22886df6bee0aee593ff3ed4e6daa3bea922dbc8'}, 'frontend/journey-week.js': {'source': 'Фронт/journey-week.js', 'old': '06852963b9693d5941dd44b993406d53a3453b48365458d2718dbb408592d19e', 'new': '5d23bca877c2eeb6326cffb430ec839d98f660ec33ba9f13c32ba5222bd7d704'}, 'frontend/login.js': {'source': 'Фронт/login.js', 'old': '2abd86b9af5dfd8a3657c32ca9e47325de37e039b8232e90346b4c0e776a872e', 'new': '145ce74bbd2d4ca617100e125bb8d971b4e29e69c4af44a1c0b0e24ba63a3c81'}, 'frontend/mom-week.js': {'source': 'Фронт/mom-week.js', 'old': '114b9ec8afe3ed5729fe1f56b1ac38c993cf7603da3efe2f34d0480401191d26', 'new': 'f81dd429d2999ee518df84bd75ce9f26f94b0df407a7b5a9a587454fc4d5c635'}, 'frontend/onboarding.css': {'source': 'Фронт/onboarding.css', 'old': '1af9e34cbd6323f92f78ee01f41a1928aa81f53ee5e5531971bf0ade3b6372e0', 'new': '286cbad705e838a8e650b8c184b8295bf68df4e59e8eddf7bcf5328bb8d5f71f'}, 'frontend/onboarding.js': {'source': 'Фронт/onboarding.js', 'old': '5b192ddb892fca811540a211f2fae25de503bca1167b774a81da9bcde9c7c9ea', 'new': 'cd00a79481737ea1e7456581a89f9e6c4bafd90aefce92656ed89a65aba3243a'}, 'frontend/profile-dates.js': {'source': 'Фронт/profile-dates.js', 'old': None, 'new': 'ec9a1424b3937233bd3d1b2957b839bfb9d917b61317de27b53229c5c4251b38'}, 'frontend/video.js': {'source': 'Фронт/video.js', 'old': '3e65f8a47b5f81a779ff3732c3bbdafb0cf829552ded954c8c3de5ddbfb8e656', 'new': 'a07555cd2bf617982f9f787e6d2a59894fec87e3d5ddfcc1c7e18fd0ae43def7'}, 'frontend/weekly-video-player.js': {'source': 'Фронт/weekly-video-player.js', 'old': '1e3738712e3bc751b6186014834c33aa1ace57fdfa1c09126434aa88913537d3', 'new': '35109afaba225c99c120704e98b7d89b5de0dc637d5c95a9f3ca503755366ab3'}, 'frontend/ai.html': {'source': 'Фронт/ai.html', 'old': '15562156eb1b96cafd6bbcd7b4183e506e7546a1a02964bf7803ca91896111ce', 'new': 'ee6f26a06d8b2d8a32811bac8fa85ee98c52cca20355f79b4b361d2f197e9891'}, 'frontend/baby.html': {'source': 'Фронт/baby.html', 'old': '60a1cfbc514e9bd1259596b40a46442f65ac783326a684d01707c3bc55679c3e', 'new': '055af98897f69fa6150f4988df1d8c9ba5e395c3bca5b8f9100700514d7f06ca'}, 'frontend/club.html': {'source': 'Фронт/club.html', 'old': '8d59858d5c4e3d40805de3ad9784c830e5694331102dce10269dbab5366a0668', 'new': 'f710dfb846a296963fdccd9c82d7fc36840bea9d4ca68d9383112d726d4a9b93'}, 'frontend/index.html': {'source': 'Фронт/index.html', 'old': '65b6486c885eedc3b21e75fc234d99ac92482a964bd44b7c4293c217c7b2d158', 'new': 'b80c78e5cf5ed7c30bbd9cf07129401ff5b1ecb153be1a64eea3600b70df771c'}, 'frontend/journey.html': {'source': 'Фронт/journey.html', 'old': 'ba9d28b142395c0ee0738769d14402953ff07ca4da62a5bdc10c135fb1656acc', 'new': '59c7c3cea973f3a021d60aa08c585d4e2c44da33909524ade9ab32a0fdd05b63'}, 'frontend/login.html': {'source': 'Фронт/login.html', 'old': '6ac993f9609cdbbcb3ee5c2a7388895aecd43fcc96e12bdc78d32c7bdad9a532', 'new': '83f6dfb9f4d9209f7fe524955ccca564374271387176ba7eabc1b9c80a22d366'}, 'frontend/mom.html': {'source': 'Фронт/mom.html', 'old': 'd847ee4011c7ae22cedf177b0ebf1bfa99f2b8c36408c547bafcaef797d78d59', 'new': 'b487367d15a18dbe4d0404597d679593df8e6a9ee7d26d36999bc7b10ce7341a'}, 'frontend/onboarding.html': {'source': 'Фронт/onboarding.html', 'old': 'd702cbc3ec2829f2057b881408ed0128aafdf6d1014fb5da27368c26941a4592', 'new': '456e3c713a37233674f484a8857e6d9ff5d93d595949460c457e6ccd2fdef80d'}, 'frontend/personal-data.html': {'source': 'Фронт/personal-data.html', 'old': '3c21d4c411b241650a6e90b7af2d6de6f3cac662618e359fe658a48e15204caa', 'new': '9170112a14f0dac5a80a549ddf7df8f0501d6a34e8625fd7bbfe9c62b83dcaa3'}, 'frontend/profile.html': {'source': 'Фронт/profile.html', 'old': '8d523e93f21a9cbd01ada9191c8c87106d50955be69ca7a0e8b3f69f4a5a669c', 'new': '234057a806c9b97e379ba2d17f8d95876e73fdc7206e98f24005265cc30ff48e'}, 'frontend/video.html': {'source': 'deploy/onboarding-video-live.html', 'old': '4fd7dd3c6b396d6c2c2dc622235d12e89675313150c8ddea221e37a185298e03', 'new': '4abc5ca4b237e39d1e3d12b0f4b8dc4ffed4a003e30eea65dc8f6efb06f6a1ae'}}


def digest(data):
    return hashlib.sha256(data).hexdigest() if data is not None else None


def valid_manifest(files):
    if not files:
        raise RuntimeError('RELEASE_MANIFEST_MISSING')
    for name, info in files.items():
        path = PurePosixPath(name)
        if path.is_absolute() or '..' in path.parts or name != str(path) or path.parts[0] not in ('backend', 'frontend'):
            raise RuntimeError('UNSAFE_MANIFEST_PATH')
        if set(info) != {'source', 'old', 'new'}:
            raise RuntimeError('INVALID_MANIFEST')
        if (not isinstance(info['source'], str) or not info['source'] or
                PurePosixPath(info['source']).is_absolute() or '..' in PurePosixPath(info['source']).parts):
            raise RuntimeError('UNSAFE_SOURCE')
        if info['old'] is not None and not re.fullmatch('[0-9a-f]{64}', info['old']):
            raise RuntimeError('INVALID_OLD_HASH')
        if not re.fullmatch('[0-9a-f]{64}', info['new']):
            raise RuntimeError('INVALID_NEW_HASH')


def safe_target(root, name):
    target = root / name
    if not target.resolve().is_relative_to(root) or any(part.is_symlink() for part in (target, *target.parents) if part != root):
        raise RuntimeError('UNSAFE_TARGET')
    if not target.parent.is_dir():
        raise RuntimeError('TARGET_PARENT_MISSING')
    return target


def atomic_write(target, data):
    temp = target.with_name(target.name + '.onboarding-release.tmp')
    fd = os.open(temp, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
    try:
        # Deployment may run as root with umask 0077. The auth service and
        # static web server still need to read the published code and pages.
        with os.fdopen(fd, 'wb') as output:
            if hasattr(os, 'fchmod'):
                os.fchmod(output.fileno(), 0o644)
            else:
                temp.chmod(0o644)
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temp, target)
    finally:
        if temp.exists():
            temp.unlink()


def publish(root, backup, files, download, column_exists, backup_db, migrate, stop, restart, healthy):
    """Preflight everything before mutation; callbacks make failure paths testable."""
    valid_manifest(files)
    if root.is_symlink():
        raise RuntimeError('UNSAFE_ROOT')
    root = root.resolve(strict=True)
    targets, before, payloads = {}, {}, {}
    for name, info in files.items():
        target = safe_target(root, name)
        old = target.read_bytes() if target.exists() else None
        if digest(old) not in (info['old'], info['new']):
            raise RuntimeError('SOURCE_MISMATCH:' + name)
        data = download(info['source'])
        if digest(data) != info['new']:
            raise RuntimeError('DOWNLOAD_MISMATCH:' + name)
        targets[name], before[name], payloads[name] = target, old, data
    has_column = column_exists()
    all_new = all(digest(before[n]) == files[n]['new'] for n in files)
    if all_new and has_column:
        if not healthy(True):
            raise RuntimeError('ALREADY_PRESENT_BUT_UNHEALTHY')
        return False
    if not healthy(False) and not (all_new and not has_column):
        raise RuntimeError('PREFLIGHT_HEALTH_FAILED')
    backup.mkdir(mode=0o700, parents=False, exist_ok=False)
    backup.chmod(0o700)
    for name, old in before.items():
        if old is not None:
            saved = backup / name
            saved.parent.mkdir(parents=True, exist_ok=True)
            saved.parent.chmod(0o700)
            saved.write_bytes(old)
            saved.chmod(0o600)
    backup_db(backup / 'auth.pgcustom')
    changed = []
    stopped = False
    try:
        # Prevent requests while adding the column and replacing application files.
        stop(); stopped = True
        for name in files:
            target = safe_target(root, name)
            current = target.read_bytes() if target.exists() else None
            if current != before[name]:
                raise RuntimeError('CONCURRENT_CHANGE:' + name)
        if not has_column:
            migrate()
            if not column_exists():
                raise RuntimeError('MIGRATION_NOT_APPLIED')
        for name in files:
            target = safe_target(root, name)
            current = target.read_bytes() if target.exists() else None
            if current != before[name]:
                raise RuntimeError('CONCURRENT_CHANGE:' + name)
            if digest(current) == files[name]['new']:
                continue
            atomic_write(target, payloads[name])
            changed.append(name)
        restart(); stopped = False
        if not healthy(True):
            raise RuntimeError('HEALTH_CHECK_FAILED')
    except Exception:
        conflict = False
        for name in reversed(changed):
            target = targets[name]
            if target.is_symlink() or target.read_bytes() != payloads[name]:
                conflict = True
                continue
            if before[name] is None:
                target.unlink()
            else:
                atomic_write(target, before[name])
        try:
            restart()
        except Exception:
            raise RuntimeError('ROLLBACK_RESTART_FAILED') from None
        if conflict:
            raise RuntimeError('ROLLBACK_CONCURRENT_CHANGE') from None
        raise
    return True


def command(args, *, stdout=subprocess.DEVNULL):
    subprocess.run(args, check=True, timeout=120, stdin=subprocess.DEVNULL,
                   stdout=stdout, stderr=subprocess.DEVNULL)


def main():
    if os.geteuid() != 0 or len(sys.argv) != 2 or not re.fullmatch('[0-9a-f]{40}', sys.argv[1]):
        raise RuntimeError('ROOT_AND_PINNED_REVISION_REQUIRED')
    revision = sys.argv[1]
    command(['systemctl', 'is-active', '--quiet', SERVICE])

    def download(source):
        url = 'https://raw.githubusercontent.com/UncleMik/webappmappap/' + revision + '/' + urllib.parse.quote(source, safe='/')
        with urllib.request.urlopen(url, timeout=25) as response:
            data = response.read(5_000_001)
        if len(data) > 5_000_000:
            raise RuntimeError('RELEASE_FILE_TOO_LARGE')
        return data

    def column_exists():
        result = subprocess.run(['runuser', '-u', 'postgres', '--', 'psql', '-X', '-At', '-v', 'ON_ERROR_STOP=1', '-d', DB,
                                 '-c', "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='auth_users' AND column_name='profile' AND data_type='jsonb')"],
                                check=True, timeout=20, capture_output=True, text=True)
        return result.stdout.strip() == 't'

    def backup_db(path):
        fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        try:
            with os.fdopen(fd, 'wb') as output:
                command(['runuser', '-u', 'postgres', '--', 'pg_dump', '-Fc', '-d', DB], stdout=output)
                output.flush(); os.fsync(output.fileno())
            command(['pg_restore', '--list', str(path)])
            command(['pg_restore', '-f', '/dev/null', str(path)])
            hash_state = hashlib.sha256()
            with path.open('rb') as archive:
                for chunk in iter(lambda: archive.read(1024 * 1024), b''):
                    hash_state.update(chunk)
            sha = hash_state.hexdigest()
            checksum = path.with_suffix(path.suffix + '.sha256')
            fd = os.open(checksum, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            with os.fdopen(fd, 'w', encoding='ascii') as output:
                output.write(sha + '  ' + path.name + '\n')
                output.flush(); os.fsync(output.fileno())
        except Exception:
            path.unlink(missing_ok=True)
            path.with_suffix(path.suffix + '.sha256').unlink(missing_ok=True)
            raise

    def migrate():
        command(['runuser', '-u', 'postgres', '--', 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-d', DB,
                 '-c', 'ALTER TABLE auth_users ADD COLUMN IF NOT EXISTS profile jsonb'])

    def healthy(check_profile):
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        for attempt in range(6):
            try:
                with opener.open('http://127.0.0.1:3001/api/auth/session', timeout=3) as response:
                    if response.status != 200 or json.load(response).get('authenticated') is not False:
                        return False
                requests = [urllib.request.Request('http://127.0.0.1:3001/api/auth/videos/contractions-lesson')]
                if check_profile:
                    requests.append(urllib.request.Request('http://127.0.0.1:3001/api/auth/profile', data=b'{}',
                                    headers={'Origin': AUTH_ORIGIN, 'Content-Type': 'application/json'}, method='POST'))
                for request in requests:
                    try:
                        opener.open(request, timeout=3)
                        return False
                    except urllib.error.HTTPError as error:
                        if error.code != 401:
                            return False
                return True
            except (OSError, ValueError, urllib.error.URLError):
                if attempt < 5:
                    time.sleep(.5)
        return False

    backup = Path('/root') / ('wep-pril-onboarding-backup-' + str(time.time_ns()))
    changed = publish(ROOT, backup, FILES, download, column_exists, backup_db, migrate,
                      lambda: command(['systemctl', 'stop', SERVICE]),
                      lambda: command(['systemctl', 'restart', SERVICE]), healthy)
    print('ONBOARDING_PUBLISHED_OK')
    print('BACKUP_DIR=' + str(backup) if changed else 'ALREADY_CURRENT')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Never print command stderr: it could contain private database content.
        reason = str(error) if isinstance(error, RuntimeError) else type(error).__name__
        print('ONBOARDING_PUBLISH_FAILED=' + reason)
        raise SystemExit(1) from None
