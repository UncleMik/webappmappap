#!/usr/bin/env python3
"""Publish the reviewed first-party analytics bundle; retain additive tables on rollback."""
from contextlib import ExitStack
from pathlib import Path
import hashlib
import json
import os
import re
import stat
import subprocess
import sys
import time
import urllib.request
import zipfile

ROOT = Path('/opt/wep_pril')
MIGRATION = 'backend/auth/analytics-migration.sql'
TABLES = {'auth_analytics_events', 'auth_analytics_state', 'auth_analytics_exclusions'}
BACKEND = {MIGRATION, *('backend/auth/' + n for n in
    ('analytics.mjs', 'main.mjs', 'http.mjs', 'admin-http.mjs', 'migrations.mjs'))}
FRONTEND = {'Фронт/' + n for n in ('analytics.js', 'auth-client.js', 'auth-gate.js', 'app-navigation.js',
    'article.js', 'course-lesson.js', 'course-video-points.js', 'course-embed-points.js',
    'video-points.js', 'favorite-button.js', 'gamification-api.js', 'ai.js', 'app.js',
    'course-views.js', 'weekly-video-player.js', 'my-courses.js', 'weekly-poll.js')}
ADMIN = {'Фронт/admin/' + n for n in ('analytics.js', 'index.html', 'panel.js', 'ui.css')}
ALLOWED = BACKEND | FRONTEND | ADMIN
SHA = re.compile(r'[a-f0-9]{64}\Z')


def require(value, code):
    if not value:
        raise RuntimeError(code)


def digest(data):
    return hashlib.sha256(data).hexdigest() if data is not None else None


def run(args, **kwargs):
    return subprocess.run(args, check=True, capture_output=True,
        timeout=kwargs.pop('timeout', 120), **kwargs)


def target(name):
    require(name in ALLOWED, 'UNEXPECTED_PATH')
    if name.startswith('Фронт/admin/'):
        path = ROOT / 'admin-frontend' / name[len('Фронт/admin/'):]
    elif name.startswith('Фронт/'):
        path = ROOT / 'frontend' / name[len('Фронт/'):]
    else:
        path = ROOT / name
    require(not any(p.is_symlink() for p in (path, *path.parents)), 'UNSAFE_TARGET')
    require(path.parent.is_dir() and (not path.exists() or path.is_file()), 'INVALID_TARGET')
    return path


def load_bundle(bundle):
    with zipfile.ZipFile(bundle) as archive:
        members = archive.infolist()
        names = [m.filename for m in members]
        require(len(names) == len(set(names)) and len(names) <= 60, 'INVALID_MEMBERS')
        require(all(not m.is_dir() and not stat.S_ISLNK(m.external_attr >> 16)
            and m.file_size <= 2_000_000 for m in members)
            and sum(m.file_size for m in members) <= 20_000_000, 'UNSAFE_MEMBERS')
        manifest = json.loads(archive.read('manifest.json'))
        require(set(manifest) == {'revision', 'files'} and isinstance(manifest['revision'], str)
            and re.fullmatch(r'[a-f0-9]{40}', manifest['revision']), 'INVALID_MANIFEST')
        files = manifest['files']
        require(isinstance(files, dict) and BACKEND <= files.keys()
            and set(files) <= ALLOWED, 'INVALID_FILESET')
        require(set(names) == {'manifest.json', *('payload/' + n for n in files)}, 'INVALID_PACKAGE')
        payload = {}
        for name, pins in files.items():
            require(set(pins) == {'before', 'sha256'}
                and (pins['before'] is None or isinstance(pins['before'], str) and SHA.fullmatch(pins['before']))
                and isinstance(pins['sha256'], str) and SHA.fullmatch(pins['sha256']), 'INVALID_PINS')
            payload[name] = archive.read('payload/' + name)
            require(digest(payload[name]) == pins['sha256'], 'PAYLOAD_MISMATCH')
        return manifest, payload


def migration_sql(data):
    text = data.decode('utf-8')
    stripped = re.sub(r'--[^\n]*', '', text)
    require(set(re.findall(r'CREATE TABLE IF NOT EXISTS ([a-z_]+)', stripped, re.I)) == TABLES,
        'MIGRATION_TABLESET_CHANGED')
    statements = re.sub(r'\bON\s+DELETE\s+(?:CASCADE|SET\s+NULL)\b', '', stripped, flags=re.I)
    require(not re.search(r'\b(?:DROP|TRUNCATE|DELETE|UPDATE|ALTER|COPY|GRANT|COMMIT|ROLLBACK|BEGIN)\b', statements, re.I),
        'MIGRATION_NOT_ADDITIVE')
    grants = 'GRANT SELECT,INSERT,UPDATE,DELETE ON ' + ','.join(sorted(TABLES)) + ' TO wep_pril_auth;'
    return ("BEGIN; SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s'; "
        "SET LOCAL ROLE wep_pril_auth_owner; SELECT pg_advisory_xact_lock(1398030674);\n"
        + text + '\n' + grants + '\nCOMMIT;').encode()


def healthy():
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    for url, field, expected in [('http://127.0.0.1:3001/api/auth/session', 'authenticated', False),
        ('http://127.0.0.1:3000/api/health', 'status', 'ok')]:
        for attempt in range(30):
            try:
                with opener.open(url, timeout=3) as response:
                    if response.status == 200 and json.load(response).get(field) == expected:
                        break
            except (OSError, ValueError):
                pass
            require(attempt < 29, 'HEALTH_FAILED')
            time.sleep(.3)


def atomic(path, data, metadata):
    temporary = path.with_name(path.name + '.analytics-' + str(time.time_ns()))
    try:
        with temporary.open('xb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, stat.S_IMODE(metadata.st_mode) if metadata else 0o644)
        os.chown(temporary, metadata.st_uid if metadata else 0, metadata.st_gid if metadata else 0)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def verified_backup():
    result = run(['python3', str(ROOT / 'deploy/backup.py')], timeout=1800)
    path = Path(result.stdout.decode().strip().splitlines()[-1])
    require(path.resolve().parent == (ROOT / 'backups').resolve() and (path / 'complete').is_file(),
        'COMPLETE_BACKUP_REQUIRED')
    run(['python3', str(ROOT / 'deploy/verify-backup.py'), str(path)], timeout=1800)
    return path


def main():
    import fcntl
    require(os.geteuid() == 0 and len(sys.argv) in (2, 3), 'ROOT_AND_BUNDLE_REQUIRED')
    apply = len(sys.argv) == 3 and sys.argv[2] == '--apply'
    require(len(sys.argv) == 2 or apply, 'UNKNOWN_OPTION')
    os.umask(0o077)
    with ExitStack() as stack:
        for name in ('stars', 'club', 'ai', 'personal'):
            lock = stack.enter_context(open('/run/lock/wep-pril-' + name + '-release.lock', 'w'))
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        manifest, payload = load_bundle(sys.argv[1])
        paths = {n: target(n) for n in payload}
        before = {n: p.read_bytes() if p.exists() else None for n, p in paths.items()}
        require(all(digest(before[n]) == manifest['files'][n]['before'] for n in payload), 'SOURCE_MISMATCH')
        sql = migration_sql(payload[MIGRATION])
        for name, data in payload.items():
            if name.endswith(('.js', '.mjs')):
                run(['node', '--check', '--input-type=module'], input=data)
        healthy()
        if not apply:
            print('ANALYTICS_PREFLIGHT_OK revision=' + manifest['revision'])
            return
        backup = ROOT / 'deploy' / ('analytics-backup-' + str(time.time_ns()))
        backup.mkdir(mode=0o700)
        (backup / 'manifest.json').write_text(json.dumps(manifest), encoding='utf-8')
        metadata = {n: p.stat() if p.exists() else None for n, p in paths.items()}
        for index, name in enumerate(payload):
            if before[name] is not None:
                (backup / str(index)).write_bytes(before[name])
        database_backup = verified_backup()
        print('ANALYTICS_BACKUP_RESTORE_OK', flush=True)
        run(['runuser', '-u', 'postgres', '--', 'psql', '-XqAt', '-v', 'ON_ERROR_STOP=1',
            '-d', 'wep_pril_auth'], input=sql)
        written = []
        try:
            for name in sorted(payload, key=lambda n: n.endswith('.html')):
                path = paths[name]
                require((path.read_bytes() if path.exists() else None) == before[name], 'CONCURRENT_CHANGE')
                atomic(path, payload[name], metadata[name])
                written.append(name)
            run(['systemctl', 'restart', 'wep-pril-auth'])
            healthy()
            require(all(digest(paths[n].read_bytes()) == manifest['files'][n]['sha256'] for n in payload),
                'READBACK_FAILED')
        except BaseException:
            for name in reversed(written):
                require(digest(paths[name].read_bytes()) == manifest['files'][name]['sha256'],
                    'ROLLBACK_CONCURRENT_CHANGE')
                if before[name] is None:
                    paths[name].unlink()
                else:
                    atomic(paths[name], before[name], metadata[name])
            run(['systemctl', 'restart', 'wep-pril-auth'])
            healthy()
            raise RuntimeError('ANALYTICS_CODE_ROLLED_BACK_TABLES_PRESERVED') from None
        print(json.dumps({'published': manifest['revision'], 'files': len(payload),
            'codeBackup': str(backup), 'databaseBackup': str(database_backup), 'restoreVerified': True}))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('ANALYTICS_FAILED ' + (str(error) if isinstance(error, RuntimeError)
            and re.fullmatch(r'[A-Z_]+', str(error)) else type(error).__name__), file=sys.stderr)
        sys.exit(1)
