"""Publish the approved single-session release on Timeweb, with private backups.

Usage (root): python3 publish-single-session.py <40-character Git revision> [--apply]
Downloads and verifies the release before stopping auth. Does not change nginx,
provider settings, purchases, profiles or the articles database.
"""
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path('/opt/wep_pril')
RELEASE = {"backend/auth/store.mjs": "f3e46d7838339bb097c4c3065ef50b0d9f79affe28b931c89693221a9cc59d72", "backend/auth/service.mjs": "4d03eba027efd4f3e10d0507742b9e45437af9e01c10edd8b834e6b8db56eac6", "backend/auth/http.mjs": "8c0265960161776081a26c110d80d1e3f448f73686bb279525f508c9f5771a05", "backend/auth/schema.sql": "e3f8f0032201dbe8328aa9d0e0da9e0021ea1e65b41a3acca2ced9fd99826a49", "backend/auth/single-session-migration.sql": "19df1e421eb1f7780c2a95c180009b3bf27084ed817a0b9d4703259abbf5e1ed", "backend/auth/migrate.mjs": "b099332dca04a195104920a23a11f23882fe268ec27ed2202bb6999c0a2b22fa", "Фронт/auth-gate.js": "afb2e7925dd84202b7b4e3c1f9ddef7c6986d000c256dce2c3f8578f9213be53", "Фронт/login.js": "129d4455fd9ec97e356e7f5d1da00b469175a9c6d66add992c2703fd7b318626"}  # Generated from reviewed source bytes, keyed by repository path.
PREVIOUS = {"backend/auth/store.mjs": "92b66152d50c340111cb93b5b0f30029dfe20233bebed3590b03fc66b2e5338c", "backend/auth/service.mjs": "40fe4bc3d1c0ad7f1c9cd2bca4fbdd06c4fa5b0d66a37315b1174a7eb65440c0", "backend/auth/http.mjs": "e9d9268530eabb7f08c8547f10ba7bb18a763c85cb77ffb3fe49df58b0a64027", "backend/auth/schema.sql": "6a17dcc554d41e2edb8f5ead0b4c8697e3b90635e01d085f64269cba13a1de8a", "backend/auth/single-session-migration.sql": None, "backend/auth/migrate.mjs": "d7315f55d33ecbffc3d552280a6f8a220c5126ebef7b3ad5cc762f37622d65fe", "Фронт/auth-gate.js": "31d86e6e0822937532f562aaa70a5fc9013bfd466f5dc2ac01e65f47baf63cec", "Фронт/login.js": "e954a1fcdd5f23c806be8b3ccfa59497cb4160cb856d1b4c0dc93e7b780ec7cd"}  # Expected hashes on the server, keyed by repository path.


def sha(data):
    return hashlib.sha256(data).hexdigest()


def target(name):
    return ROOT / ('frontend/' + name[6:] if name.startswith('Фронт/') else name)


def run(args, **kwargs):
    return subprocess.run(args, check=True, timeout=60, stderr=subprocess.PIPE,
                          stdout=subprocess.PIPE, **kwargs)


def sql(source):
    return run(['runuser', '-u', 'postgres', '--', 'psql', '-XqAt',
                '-v', 'ON_ERROR_STOP=1', '-d', 'wep_pril_auth'], input=source.encode()).stdout


def atomic(path, data):
    temporary = path.with_name(path.name + '.single-session.tmp')
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0), 0o644)
    try:
        with os.fdopen(fd, 'wb') as stream:
            if hasattr(os, 'fchmod'):
                os.fchmod(stream.fileno(), 0o644)
            else:
                temporary.chmod(0o644)
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def healthy():
    for _ in range(20):
        try:
            with urllib.request.urlopen('http://127.0.0.1:3001/api/auth/session', timeout=3) as response:
                if response.status == 200 and json.load(response) == {'authenticated': False, 'user': None}:
                    return True
        except (OSError, ValueError):
            pass
        time.sleep(.25)
    return False


def apply_release(payload, before, backup):
    backup.mkdir(mode=0o700)
    manifest = {}
    for i, (name, data) in enumerate(before.items()):
        if data is not None:
            (backup / str(i)).write_bytes(data)
        manifest[name] = {'backup': str(i), 'old': sha(data) if data is not None else None,
                          'new': sha(payload[name])}
    (backup / 'manifest.json').write_text(json.dumps(manifest), encoding='utf-8')
    stopped = False
    migrated = False
    changed = []
    try:
        # Avoid an old process inserting sessions under the newly added unique index.
        stopped = True
        run(['systemctl', 'stop', 'wep-pril-auth'])
        with (backup / 'auth.pgdump').open('xb') as stream:
            subprocess.run(['runuser', '-u', 'postgres', '--', 'pg_dump', '-Fc',
                            '-d', 'wep_pril_auth'], stdout=stream, stderr=subprocess.PIPE,
                           timeout=60, check=True)
        sql('BEGIN; SET LOCAL lock_timeout=\'5s\'; SET LOCAL statement_timeout=\'15s\'; '
            'SET ROLE wep_pril_auth_owner;\n' +
            payload['backend/auth/single-session-migration.sql'].decode() + '\nCOMMIT;')
        migrated = True
        for name, data in payload.items():
            path = target(name)
            if (path.read_bytes() if path.exists() else None) != before[name]:
                raise RuntimeError('CONCURRENT_CHANGE:' + name)
            atomic(path, data)
            changed.append(name)
        run(['systemctl', 'start', 'wep-pril-auth'])
        if not healthy():
            raise RuntimeError('AUTH_HEALTH_FAILED')
        for name, data in payload.items():
            if target(name).read_bytes() != data:
                raise RuntimeError('FINAL_CHECKSUM_FAILED:' + name)
        duplicate = sql('SELECT count(*) FROM (SELECT user_id FROM auth_sessions '
                        'WHERE revoked_at IS NULL GROUP BY user_id HAVING count(*)>1) t;').strip()
        if duplicate != b'0':
            raise RuntimeError('DUPLICATE_ACTIVE_SESSIONS')
    except Exception:
        if stopped:
            run(['systemctl', 'stop', 'wep-pril-auth'])
            # Old code ignores revoked_at: discard revoked tokens before reverting it,
            # so rollback cannot revive an old login. Never restore the whole database.
            if migrated:
                sql('BEGIN; DELETE FROM auth_sessions WHERE revoked_at IS NOT NULL; '
                    'DROP INDEX IF EXISTS auth_sessions_one_active_user; COMMIT;')
            for name in reversed(changed):
                path = target(name)
                if path.read_bytes() != payload[name]:
                    raise RuntimeError('ROLLBACK_CONCURRENT_CHANGE_AUTH_STOPPED') from None
                if before[name] is None:
                    path.unlink()
                else:
                    atomic(path, before[name])
            run(['systemctl', 'start', 'wep-pril-auth'])
            if not healthy():
                raise RuntimeError('ROLLBACK_HEALTH_FAILED') from None
        raise


def main():
    import fcntl
    os.umask(0o077)
    if os.geteuid() != 0 or len(sys.argv) not in (2, 3) or not re.fullmatch('[0-9a-f]{40}', sys.argv[1]):
        raise RuntimeError('ROOT_AND_PINNED_REVISION_REQUIRED')
    if len(sys.argv) == 3 and sys.argv[2] != '--apply':
        raise RuntimeError('UNKNOWN_OPTION')
    if len(RELEASE) != 8 or set(RELEASE) != set(PREVIOUS):
        raise RuntimeError('RELEASE_MANIFEST_MISSING')
    with open('/run/lock/wep-pril-single-session.lock', 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        payload, before = {}, {}
        for name, expected in RELEASE.items():
            path = target(name)
            if path.is_symlink() or path.resolve() != path:
                raise RuntimeError('UNSAFE_TARGET')
            previous = path.read_bytes() if path.exists() else None
            digest = sha(previous) if previous is not None else None
            if digest not in (PREVIOUS[name], expected):
                raise RuntimeError('UNEXPECTED_SERVER_FILE:' + name)
            before[name] = previous
            url = 'https://raw.githubusercontent.com/UncleMik/webappmappap/' + sys.argv[1] + '/' + urllib.parse.quote(name)
            with urllib.request.urlopen(url, timeout=25) as response:
                data = response.read(250001)
            if len(data) > 250000 or sha(data) != expected:
                raise RuntimeError('DOWNLOAD_CHECKSUM_FAILED:' + name)
            payload[name] = data
        if all(before[name] == data for name, data in payload.items()):
            if not healthy() or sql("SELECT count(*) FROM pg_indexes WHERE schemaname='public' "
                                    "AND indexname='auth_sessions_one_active_user';").strip() != b'1':
                raise RuntimeError('INSTALLED_RELEASE_SCHEMA_OR_HEALTH_FAILED')
            print('SINGLE_SESSION_ALREADY_INSTALLED')
            return
        if any(before[name] is not None and sha(before[name]) != PREVIOUS[name] for name in payload):
            raise RuntimeError('PARTIAL_RELEASE_REQUIRES_INSPECTION')
        if len(sys.argv) == 2:
            print('SINGLE_SESSION_PREFLIGHT_OK: 8 verified files; auth stop, private backup, migration, restart')
            return
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
        backup = Path('/root') / ('webpril-single-session-' + stamp)
        apply_release(payload, before, backup)
        print('SINGLE_SESSION_PUBLISHED_OK; backup=' + str(backup))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Raw SQL/process errors can contain private values. Print only a fixed class.
        print(str(error) if isinstance(error, RuntimeError) else 'SINGLE_SESSION_RELEASE_FAILED', file=sys.stderr)
        sys.exit(1)
