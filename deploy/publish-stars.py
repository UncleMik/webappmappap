"""Hash-pinned stars release. Run on Timeweb with sudo; default is preflight.

No SSH, content approval, audience change, push or database restoration here.
See docs/gamification/RELEASE.md for the bundle and inspection contract.
"""
import argparse
from contextlib import ExitStack
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
import time
import urllib.request
import uuid
import zipfile

ROOT = Path('/opt/wep_pril')
NGINX = Path('/etc/nginx/sites-available/wep-pril-domain')
AUTH = Path('/etc/wep-pril/auth.env')
ADMIN = Path('/etc/wep-pril/admin.env')
DURATIONS = Path('/etc/wep-pril-media/course-durations.json')
NODE = '/usr/local/bin/node'
MIGRATIONS = ['stars-migration.sql', 'stars-ai-migration.sql',
              'gamification-migration.sql', 'gamification-admin-migration.sql']
CONTENT = {'gamification-source.json', 'gamification-materials-reference.json', 'weekly-video-materials.json'}
SHA = re.compile('[a-f0-9]{64}')
SERVICES = ['wep-pril-auth', 'wep-pril']
VAPID_SCRIPT = "import { generateVAPIDKeys } from 'web-push'; console.log(JSON.stringify(generateVAPIDKeys()))"
TABLES = {'auth_stars_wallet', 'auth_stars_launch', 'auth_stars_material_progress',
          'auth_stars_weeks', 'auth_stars_week_purchases', 'auth_stars_ai_credits',
          'auth_stars_course_views', 'auth_stars_ai_daily_usage', 'auth_stars_ai_reservations',
          'auth_gamification_state', 'auth_gamification_actions', 'auth_gamification_launch',
          'gamification_settings', 'gamification_content', 'gamification_audit',
          'gamification_notification_preferences', 'gamification_notifications',
          'gamification_push_subscriptions', 'gamification_push_days',
          'gamification_presentations', 'auth_gamification_visits', 'auth_stars_legacy_reviews'}


def require(ok, code):
    if not ok:
        raise RuntimeError(code)


def digest(data):
    return hashlib.sha256(data).hexdigest() if data is not None else None


def safe(path):
    require(path.is_absolute() and not any(p.is_symlink() for p in (path, *path.parents))
            and path.resolve() == path, 'UNSAFE_TARGET')
    require(not path.exists() or path.is_file(), 'TARGET_NOT_FILE')
    return path


def read(path):
    safe(path)
    return path.read_bytes() if path.exists() else None


def target(name):
    require(isinstance(name, str), 'INVALID_PATH')
    p = PurePosixPath(name)
    require(name == p.as_posix() and not p.is_absolute() and '\\' not in name and ':' not in name
            and all(v not in ('', '.', '..') and not v.startswith('.') for v in p.parts), 'INVALID_PATH')
    parts = p.parts
    if len(parts) == 3 and parts[:2] == ('backend', 'auth') and p.suffix in {'.mjs', '.sql', '.json'}:
        path = ROOT / name
    elif name in {'backend/server.mjs', 'backend/package.json', 'backend/package-lock.json'}:
        path = ROOT / name
    elif len(parts) == 3 and parts[:2] == ('backend', 'content') and p.name in CONTENT:
        path = ROOT / name
    elif len(parts) == 2 and parts[0] == 'Фронт' and p.suffix in {'.html', '.js', '.css'}:
        path = ROOT / 'frontend' / p.name
    elif len(parts) == 3 and parts[:2] == ('Фронт', 'admin') and p.suffix in {'.html', '.js', '.css'}:
        path = ROOT / 'admin-frontend' / p.name
    else:
        raise RuntimeError('UNEXPECTED_PATH')
    return safe(path)


def run(args, **kwargs):
    return subprocess.run(args, check=True, capture_output=True,
                          timeout=kwargs.pop('timeout', 120), **kwargs)


def atomic(path, data, mode=None, owner=None):
    safe(path)
    metadata = path.stat() if path.exists() else None
    tmp = path.with_name(path.name + '.stars-' + uuid.uuid4().hex)
    try:
        with tmp.open('xb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        tmp.chmod(mode if mode is not None else (metadata.st_mode & 0o777 if metadata else 0o644))
        if owner is not None:
            os.chown(tmp, *owner)
        elif metadata:
            os.chown(tmp, metadata.st_uid, metadata.st_gid)
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)


def unique_json(data):
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, 'DUPLICATE_JSON_KEY')
            result[key] = value
        return result
    return json.loads(data, object_pairs_hook=pairs)


def durations_check(data):
    value = unique_json(data)
    require(set(value) == {'version', 'rows'} and value['version'] == 1 and isinstance(value['rows'], list), 'INVALID_DURATIONS')
    seen = set()
    for row in value['rows']:
        require(set(row) == {'lessonId', 'videoKey', 'contentHash', 'durationMs', 'provider'}, 'INVALID_DURATION_ROW')
        require(isinstance(row['lessonId'], str) and re.fullmatch('[A-Za-z0-9_-]{1,128}', row['lessonId'])
                and isinstance(row['videoKey'], str) and re.fullmatch('[0-9]+:[0-9]+', row['videoKey'])
                and isinstance(row['contentHash'], str) and SHA.fullmatch(row['contentHash'])
                and type(row['durationMs']) is int and 0 < row['durationMs'] <= 86_400_000
                and row['provider'] in {'getcourse', 'youtube', 'rutube'}, 'INVALID_DURATION_ROW')
        key = (row['lessonId'], row['videoKey'])
        require(key not in seen, 'DUPLICATE_DURATION')
        seen.add(key)
    require(len(seen) == 1145, 'VERIFIED_DURATIONS_COUNT_REQUIRED')


def archive_read(bundle):
    require(Path(bundle).stat().st_size <= 60_000_000, 'ZIP_TOO_LARGE')
    with zipfile.ZipFile(bundle) as archive:
        members = archive.infolist()
        require(len(members) <= 500 and len({i.filename for i in members}) == len(members), 'INVALID_ZIP_MEMBERS')
        require(all(i.file_size <= 10_000_000 and not i.is_dir() and not i.flag_bits & 1
                    and (i.external_attr >> 16) & 0o170000 != 0o120000 for i in members)
                and sum(i.file_size for i in members) <= 60_000_000, 'UNSAFE_ZIP')
        manifest = unique_json(archive.read('manifest.json'))
        require(set(manifest) == {'revision', 'files', 'configBefore', 'durations'}, 'INVALID_MANIFEST')
        require(isinstance(manifest['revision'], str) and re.fullmatch('[a-f0-9]{40}', manifest['revision']), 'REVISION_REQUIRED')
        files = manifest['files']
        require(isinstance(files, dict) and files and len(files) <= 480, 'INVALID_FILESET')
        required = {'backend/auth/' + n for n in MIGRATIONS} | {'backend/package.json', 'backend/package-lock.json'}
        require(required <= files.keys(), 'INCOMPLETE_RELEASE')
        require(set(manifest['configBefore']) == {'nginx', 'authEnv', 'adminEnv'}, 'CONFIG_PINS_REQUIRED')
        require(all(isinstance(v, str) and SHA.fullmatch(v) for v in manifest['configBefore'].values()), 'CONFIG_PINS_REQUIRED')
        require(set(archive.namelist()) == {'manifest.json', 'course-durations.json', *('payload/' + n for n in files)}, 'INVALID_ZIP_MEMBERS')
        payload = {}
        for name, info in files.items():
            target(name)
            require(set(info) == {'before', 'sha256'} and isinstance(info['sha256'], str)
                    and SHA.fullmatch(info['sha256']) and (info['before'] is None
                    or isinstance(info['before'], str) and SHA.fullmatch(info['before'])), 'INVALID_FILE_PIN')
            payload[name] = archive.read('payload/' + name)
            require(digest(payload[name]) == info['sha256'], 'PAYLOAD_CHECKSUM_FAILED')
        item = manifest['durations']
        require(set(item) == {'before', 'sha256'} and isinstance(item['sha256'], str) and SHA.fullmatch(item['sha256'])
                and (item['before'] is None or isinstance(item['before'], str) and SHA.fullmatch(item['before'])), 'INVALID_DURATION_PIN')
        durations = archive.read('course-durations.json')
        require(digest(durations) == item['sha256'], 'DURATION_CHECKSUM_FAILED')
        durations_check(durations)
        return manifest, payload, durations


def location(config, header):
    matches = list(re.finditer(r'(?m)^[ \t]*' + re.escape(header) + r'\s*\{', config))
    require(len(matches) == 1, 'NGINX_LOCATION_AMBIGUOUS')
    match = matches[0]
    # These exact proxy blocks must be simple. Never guess through nested blocks.
    end = config.find('}', match.end())
    require(end >= 0 and '{' not in config[match.end():end], 'NGINX_NESTED_LOCATION')
    return match.start(), end + 1, config[match.start():end + 1]


def patch_nginx(data):
    config = data.decode('utf-8')
    _, _, auth = location(config, 'location ^~ /api/auth/')
    require('proxy_pass http://127.0.0.1:3001;' in auth, 'NGINX_AUTH_UPSTREAM_REQUIRED')
    if re.search(r'location\s+\^~\s+/api/auth/internal/\s*\{', config):
        _, _, block = location(config, 'location ^~ /api/auth/internal/')
        require(re.fullmatch(r'\s*location \^~ /api/auth/internal/\s*\{\s*(?:auth_request off;\s*)?return 404;\s*\}', block), 'NGINX_INTERNAL_DENY_REQUIRED')
    else:
        start, _, _ = location(config, 'location ^~ /api/auth/')
        config = config[:start] + '    location ^~ /api/auth/internal/ {\n        auth_request off;\n        return 404;\n    }\n\n' + config[start:]
    if 'location = /api/auth/gamification/actions' in config:
        _, _, block = location(config, 'location = /api/auth/gamification/actions')
        require('client_max_body_size 16k;' in block and 'proxy_pass http://127.0.0.1:3001;' in block
                and 'auth_request off;' in block, 'NGINX_ACTIONS_CONFLICT')
    else:
        start, _, _ = location(config, 'location ^~ /api/auth/')
        config = config[:start] + '''    location = /api/auth/gamification/actions {
        auth_request off;
        client_max_body_size 16k;
        proxy_pass http://127.0.0.1:3001;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_connect_timeout 3s;
        proxy_read_timeout 15s;
        add_header Cache-Control "no-store" always;
    }

''' + config[start:]
    start, end, block = location(config, 'location /api/')
    for key, value in [('Cookie', '$http_cookie'), ('X-Webpril-Account', '$http_x_webpril_account')]:
        pattern = r'(?m)^\s*proxy_set_header ' + re.escape(key) + r'\s+([^;]+);'
        matches = re.findall(pattern, block)
        require(not matches or matches == [value], 'NGINX_FORWARD_CONFLICT')
        if not matches:
            block = block[:-1] + '    proxy_set_header ' + key + ' ' + value + ';\n    }'
    return (config[:start] + block + config[end:]).encode()


def env_values(data):
    result = {}
    for line in data.decode('utf-8').splitlines():
        match = re.match(r'^([A-Z][A-Z0-9_]*)=(.*)$', line)
        if match:
            require(match[1] not in result, 'DUPLICATE_ENV_KEY')
            result[match[1]] = match[2]
    return result


def patch_env(data, keys=None):
    values = env_values(data)
    names = ['GAMIFICATION_PUSH_PUBLIC_KEY', 'GAMIFICATION_PUSH_PRIVATE_KEY', 'GAMIFICATION_PUSH_SUBJECT']
    present = [bool(values.get(n)) for n in names]
    require(not any(present) or all(present), 'INCOMPLETE_EXISTING_VAPID')
    additions = {'AUTH_GAMIFICATION_ENABLED': 'true', 'GAMIFICATION_COURSE_DURATIONS': str(DURATIONS)}
    if not any(present):
        require(keys is not None and set(keys) == {'publicKey', 'privateKey'} and
                re.fullmatch('[A-Za-z0-9_-]{87}', keys['publicKey']) and
                re.fullmatch('[A-Za-z0-9_-]{43}', keys['privateKey']), 'VAPID_KEYS_REQUIRED')
        additions.update(dict(zip(names, [keys['publicKey'], keys['privateKey'], 'https://app.legkie-rody.ru/'])))
    lines = []
    for line in data.decode('utf-8').splitlines():
        key = line.split('=', 1)[0]
        lines.append(key + '=' + additions.pop(key) if key in additions else line)
    return ('\n'.join(lines) + '\n' + ''.join(k + '=' + v + '\n' for k, v in additions.items())).encode()


def nginx_preflight(stage, candidate):
    """Test the real main config with only this vhost redirected to a private copy."""
    main = Path('/etc/nginx/nginx.conf')
    original = read(main)
    require(original is not None, 'NGINX_MAIN_REQUIRED')
    config = original.decode('utf-8')
    pattern = r'(?m)^[ \t]*include /etc/nginx/sites-enabled/\*;[ \t]*$'
    require(len(re.findall(pattern, config)) == 1, 'NGINX_INCLUDE_LAYOUT_UNSUPPORTED')
    sites = sorted(Path('/etc/nginx/sites-enabled').iterdir())
    matching = [p for p in sites if p.resolve() == NGINX]
    require(len(matching) == 1, 'NGINX_ENABLED_SITE_REQUIRED')
    candidate_path = stage / 'nginx-vhost.conf'
    candidate_path.write_bytes(candidate)
    includes = []
    for path in sites:
        require(re.fullmatch('[A-Za-z0-9_.-]+', path.name), 'NGINX_INCLUDE_UNSAFE_NAME')
        includes.append('include ' + str(candidate_path if path == matching[0] else path) + ';')
    test_path = stage / 'nginx-main.conf'
    test_path.write_text(re.sub(pattern, '\n'.join(includes), config), encoding='utf-8')
    run(['nginx', '-t', '-c', str(test_path)])
    require(read(main) == original, 'NGINX_MAIN_CONCURRENT_CHANGE')


def reconcile(before):
    for path, data in before.items():
        require(read(path) == data, 'CONCURRENT_CHANGE')


def prepare_runtime_parents(paths):
    """Only content may be newly created; never guess a new runtime hierarchy."""
    allowed = {ROOT / 'backend', ROOT / 'backend/auth', ROOT / 'backend/content',
               ROOT / 'frontend', ROOT / 'admin-frontend'}
    content = ROOT / 'backend/content'
    for parent in sorted({p.parent for p in paths}):
        require(parent in allowed and parent.resolve() == parent
                and not any(p.is_symlink() for p in (parent, *parent.parents)), 'UNSAFE_RUNTIME_PARENT')
        if not parent.exists():
            require(parent == content and parent.parent.is_dir(), 'RUNTIME_PARENT_REQUIRED')
            parent.mkdir(mode=0o755)
            os.chown(parent, 0, 0)
            # Explicit chmod is necessary under the publisher's umask 077.
            parent.chmod(0o755)
        require(parent.is_dir(), 'RUNTIME_PARENT_NOT_DIRECTORY')
        metadata = parent.stat()
        require(metadata.st_uid == 0 and metadata.st_mode & 0o055 == 0o055,
                'RUNTIME_PARENT_OWNER_OR_READABILITY')
        if parent == content:
            require(metadata.st_gid == 0 and metadata.st_mode & 0o777 == 0o755,
                    'CONTENT_PARENT_ROOT_0755_REQUIRED')


def healthy():
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    for _ in range(30):
        try:
            with opener.open('http://127.0.0.1:3001/api/auth/session', timeout=2) as response:
                if json.load(response) == {'authenticated': False, 'user': None}:
                    with opener.open('http://127.0.0.1:3000/api/health', timeout=2) as api:
                        state = json.load(api)
                        require(state.get('status') == 'ok' and state.get('project') == 'wep_pril', 'API_HEALTH_FAILED')
                    run(['systemctl', 'is-active', *SERVICES])
                    return
        except (OSError, ValueError, subprocess.SubprocessError):
            pass
        time.sleep(.2)
    raise RuntimeError('HEALTH_FAILED')


def sql_run(sql):
    return run(['runuser', '-u', 'postgres', '--', 'psql', '-XqAt', '-v', 'ON_ERROR_STOP=1',
                '-d', 'wep_pril_auth'], input=sql.encode(), timeout=150).stdout.decode().strip()


def ledger_snapshot():
    # Hash only the original columns: capped is intentionally changed for polls.
    result = sql_run("""SET timezone='UTC'; SELECT json_build_array(count(*),COALESCE(sum(amount),0),
      md5(COALESCE(string_agg(md5(jsonb_build_array(id,user_id,source_message_id,article_id,
        video_id,poll_id,occurred_at,moscow_day,amount)::text),'' ORDER BY id),'')))
      FROM auth_points_ledger;""")
    value = json.loads(result)
    require(len(value) == 3, 'INVALID_LEDGER_SNAPSHOT')
    return value


def migration_sql(payload):
    texts = [payload['backend/auth/' + n].decode('utf-8') for n in MIGRATIONS]
    created = set(re.findall(r'CREATE TABLE IF NOT EXISTS ([a-z_]+)', '\n'.join(texts)))
    require(created == TABLES, 'MIGRATION_TABLESET_CHANGED')
    # The four reviewed SQL files must stay inside this one bounded transaction.
    for text in texts:
        stripped = re.sub(r'--[^\n]*', '', text)
        require(not re.search(r'\b(?:COMMIT|ROLLBACK|BEGIN\s*;|SET\s+(?:LOCAL\s+)?(?:ROLE|statement_timeout|lock_timeout)|GRANT|COPY|TRUNCATE)\b', stripped, re.I), 'UNSAFE_MIGRATION_CONTROL')
    grants = 'GRANT SELECT,INSERT,UPDATE,DELETE ON ' + ','.join(sorted(TABLES)) + ' TO wep_pril_auth;\n'
    grants += 'GRANT USAGE,SELECT ON SEQUENCE gamification_audit_id_seq,gamification_notifications_id_seq TO wep_pril_auth;\n'
    return ("BEGIN; SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s'; "
            "SET LOCAL ROLE wep_pril_auth_owner; SELECT pg_advisory_xact_lock(1398030674);\n"
            + '\n'.join(texts) + '\n' + grants + '\nCOMMIT;')


def verify_backup():
    output = run(['python3', str(ROOT / 'deploy/backup.py')], timeout=1800).stdout.decode().strip()
    backup = Path(output.splitlines()[-1])
    require(backup.resolve().parent == (ROOT / 'backups').resolve() and (backup / 'complete').is_file(), 'COMPLETE_BACKUP_REQUIRED')
    run(['python3', str(ROOT / 'deploy/verify-backup.py'), str(backup)], timeout=1800)
    return backup


def unpack_dependencies(bundle, expected, lock_data, destination):
    require(isinstance(expected, str) and SHA.fullmatch(expected)
            and Path(bundle).stat().st_size <= 20_000_000
            and digest(Path(bundle).read_bytes()) == expected, 'DEPENDENCIES_CHECKSUM_FAILED')
    with zipfile.ZipFile(bundle) as archive:
        members = archive.infolist()
        require(len(members) <= 4000 and len({i.filename for i in members}) == len(members)
                and all(i.file_size <= 10_000_000 and not i.is_dir() and not i.flag_bits & 1
                        and (i.external_attr >> 16) & 0o170000 != 0o120000 for i in members)
                and sum(i.file_size for i in members) <= 40_000_000, 'UNSAFE_DEPENDENCIES_ZIP')
        manifest = unique_json(archive.read('dependencies-manifest.json'))
        require(set(manifest) == {'version', 'packageLockSha256', 'files'} and manifest['version'] == 1
                and manifest['packageLockSha256'] == digest(lock_data), 'DEPENDENCY_LOCK_MISMATCH')
        files = manifest['files']
        require(isinstance(files, dict) and files and set(archive.namelist()) == {'dependencies-manifest.json', *files}, 'INVALID_DEPENDENCIES_MANIFEST')
        lock = unique_json(lock_data)
        packages = lock.get('packages', {})
        require(packages.get('node_modules/web-push', {}).get('version', '').split('.')[0] == '4', 'WEB_PUSH_4_REQUIRED')
        payload = {}
        for name, expected_hash in files.items():
            path = PurePosixPath(name)
            require(name == path.as_posix() and not path.is_absolute() and '\\' not in name and ':' not in name
                    and all(v not in ('', '.', '..') and not v.startswith('.') for v in path.parts)
                    and path.suffix.lower() not in {'.node', '.dll', '.so', '.exe', '.cmd', '.bat', '.ps1'}
                    and len(path.parts) >= 2, 'UNSAFE_DEPENDENCY_PATH')
            package = path.parts[0] if not path.parts[0].startswith('@') else '/'.join(path.parts[:2])
            info = packages.get('node_modules/' + package)
            require(info is not None and not info.get('dev') and not info.get('hasInstallScript'), 'UNEXPECTED_DEPENDENCY_PACKAGE')
            data = archive.read(name)
            require(isinstance(expected_hash, str) and SHA.fullmatch(expected_hash) and digest(data) == expected_hash, 'DEPENDENCY_FILE_CHECKSUM_FAILED')
            payload[name] = data
            if destination is not None:
                out = destination / name
                out.parent.mkdir(parents=True, exist_ok=True)
                out.write_bytes(data)
        require({'pg/package.json', 'web-push/package.json'} <= files.keys(), 'DEPENDENCIES_INCOMPLETE')
        return payload


def dependencies_match(bundle, checksum, lock_data):
    expected = unpack_dependencies(bundle, checksum, lock_data, None)
    modules = ROOT / 'backend/node_modules'
    tree_hash(modules)  # Reject unsafe symlinks/entries before any file reads.
    observed = {p.relative_to(modules).as_posix(): p for p in modules.rglob('*') if p.is_file()}
    return observed.keys() == expected.keys() and all(read(observed[n]) == data for n, data in expected.items())


def prepare_dependencies(stage, payload, bundle, checksum, generate_keys):
    import pwd
    account = pwd.getpwnam('wep-pril-auth')
    stage.chmod(0o750)
    os.chown(stage, 0, account.pw_gid)
    work = stage / 'dependencies'
    work.mkdir(mode=0o755)
    work.chmod(0o755)
    modules = work / 'node_modules'
    unpack_dependencies(bundle, checksum, payload['backend/package-lock.json'], modules)
    for path in [modules, *modules.rglob('*')]:
        path.chmod(0o755 if path.is_dir() else 0o644)
    keys = None
    if generate_keys:
        env = {'PATH': '/usr/local/bin:/usr/bin:/bin', 'LANG': 'C.UTF-8', 'HOME': '/nonexistent'}
        try:
            keys = unique_json(run(['runuser', '-u', 'wep-pril-auth', '--', NODE, '--input-type=module', '-e',
                VAPID_SCRIPT], cwd=work, env=env).stdout)
        except subprocess.SubprocessError:
            raise RuntimeError('VAPID_GENERATION_FAILED') from None
    return modules, keys


def tree_hash(path):
    require(path.is_dir() and not path.is_symlink() and not any(p.is_symlink() for p in path.parents), 'UNSAFE_MODULES')
    entries = []
    for item in sorted(path.rglob('*')):
        if item.is_symlink():
            require(item.resolve().is_relative_to(path.resolve()), 'MODULE_SYMLINK_ESCAPES')
            entries.append((str(item.relative_to(path)), 'link', os.readlink(item)))
        elif item.is_file():
            entries.append((str(item.relative_to(path)), 'file', digest(item.read_bytes())))
        else:
            require(item.is_dir(), 'UNSAFE_MODULE_ENTRY')
    return digest(json.dumps(entries).encode())


def swap_modules(source, current, saved):
    require(source.is_dir() and not source.is_symlink() and current.is_dir()
            and not current.is_symlink() and not saved.exists(), 'INVALID_MODULE_SWAP')
    os.rename(current, saved)
    try:
        os.rename(source, current)
    except BaseException:
        os.rename(saved, current)
        raise


def stop_clean():
    run(['systemctl', 'stop', *SERVICES], timeout=110)
    for service in SERVICES:
        fields = dict(line.split('=', 1) for line in run(['systemctl', 'show', service, '-p', 'ActiveState', '-p', 'Result']).stdout.decode().splitlines())
        require(fields == {'ActiveState': 'inactive', 'Result': 'success'}, 'SERVICE_STOP_NOT_CLEAN')


def rollback_files(written, before, after, metadata=None):
    # Check ALL targets first: never overwrite an operator's concurrent fix.
    require(all(read(p) == after[p] for p in written), 'ROLLBACK_CONCURRENT_CHANGE')
    for path in reversed(written):
        if before[path] is None:
            path.unlink()
        else:
            original = (metadata or {}).get(path)
            atomic(path, before[path], mode=original.st_mode & 0o777 if original else None,
                   owner=(original.st_uid, original.st_gid) if original else None)


def apply_release(stage, before, after, modules, sql):
    backup = verify_backup()
    private = stage / 'private'
    private.mkdir(mode=0o700)
    for index, (path, data) in enumerate(before.items()):
        if data is not None:
            (private / str(index)).write_bytes(data)
    (private / 'restore-map.json').write_text(json.dumps({str(p): {'file': str(i), 'before': digest(d), 'after': digest(after.get(p, d))}
        for i, (p, d) in enumerate(before.items())}))
    (private / 'database-backup-path').write_text(str(backup))
    reconcile(before)
    metadata = {p: p.stat() for p, d in before.items() if d is not None}
    current = ROOT / 'backend/node_modules'
    saved = stage / 'previous-node_modules'
    written = []
    swapped = False
    old_modules_hash = tree_hash(current)
    new_modules_hash = tree_hash(modules)
    try:
        stop_clean()
        reconcile(before)
        snapshot = ledger_snapshot()
        (private / 'ledger-before.json').write_text(json.dumps(snapshot))
        sql_run(sql)
        observed = ledger_snapshot()
        (private / 'ledger-after.json').write_text(json.dumps(observed))
        require(observed == snapshot, 'OLD_LEDGER_CHANGED')
        # No approval/rollout settings or opt-in subscriptions are inserted.
        for path in sorted(after, key=lambda p: p.suffix == '.html'):
            require(read(path) == before[path], 'CONCURRENT_CHANGE')
            if path == DURATIONS:
                require(not DURATIONS.parent.is_symlink(), 'UNSAFE_DURATION_DIRECTORY')
                DURATIONS.parent.mkdir(mode=0o750, exist_ok=True)
                os.chown(DURATIONS.parent, 0, 995)
                DURATIONS.parent.chmod(0o750)
                atomic(path, after[path], mode=0o640, owner=(0, 995))
            else:
                atomic(path, after[path])
            written.append(path)
        require(tree_hash(current) == old_modules_hash and tree_hash(modules) == new_modules_hash, 'MODULES_CONCURRENT_CHANGE')
        swap_modules(modules, current, saved)
        swapped = True
        run(['nginx', '-t'])
        run(['systemctl', 'start', *SERVICES])
        healthy()
        run(['systemctl', 'reload', 'nginx'])
        require(all(read(p) == d for p, d in after.items()), 'FINAL_CHECKSUM_FAILED')
    except BaseException:
        # Additive DB changes and ALL data survive. No pg_restore on production.
        try:
            stop_clean()
            if swapped:
                require(tree_hash(current) == new_modules_hash and tree_hash(saved) == old_modules_hash, 'ROLLBACK_MODULES_CHANGED')
            rollback_files(written, before, after, metadata)
            if swapped:
                os.rename(current, stage / 'failed-node_modules')
                os.rename(saved, current)
            run(['nginx', '-t'])
            run(['systemctl', 'start', *SERVICES])
            run(['systemctl', 'reload', 'nginx'])
            healthy()
            (private / 'rollback-result').write_text('code/config/dependencies restored; additive database retained\n')
        except BaseException:
            (private / 'fix-forward-required').write_text('Automatic rollback could not finish; services may be stopped\n')
            raise RuntimeError('ROLLBACK_INCOMPLETE_PRIVATE_STAGE_REQUIRED') from None
        raise RuntimeError('RELEASE_ROLLED_BACK_DATABASE_RETAINED') from None
    print('STARS_RELEASE_OK backup=' + str(backup) + ' stage=' + str(stage), flush=True)


def inspect(names):
    require(isinstance(names, list) and names and len(names) == len(set(names)), 'INVALID_INSPECT_LIST')
    return {'files': {n: digest(read(target(n))) for n in names},
            'configBefore': {'nginx': digest(read(NGINX)), 'authEnv': digest(read(AUTH)), 'adminEnv': digest(read(ADMIN))},
            'durationsBefore': digest(read(DURATIONS))}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('bundle', nargs='?')
    parser.add_argument('--dependencies', help='Offline production dependencies ZIP')
    parser.add_argument('--dependencies-sha256')
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--inspect', help='JSON array of repository-relative paths; prints hashes only')
    args = parser.parse_args()
    require(os.name == 'posix' and os.geteuid() == 0, 'ROOT_ON_TIMEWEB_REQUIRED')
    os.umask(0o077)
    if args.inspect:
        require(not args.bundle and not args.apply and not args.dependencies and not args.dependencies_sha256, 'INVALID_INSPECT_OPTIONS')
        print(json.dumps(inspect(unique_json(Path(args.inspect).read_bytes())), ensure_ascii=False))
        return
    require(args.bundle and args.dependencies and args.dependencies_sha256, 'BUNDLE_AND_DEPENDENCIES_REQUIRED')
    import fcntl
    with ExitStack() as stack:
        for name in ['stars', 'club', 'ai', 'personal']:
            lock = stack.enter_context(open('/run/lock/wep-pril-' + name + '-release.lock', 'w'))
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        manifest, payload, durations = archive_read(args.bundle)
        files = {target(n): d for n, d in payload.items()}
        config = {NGINX: read(NGINX), AUTH: read(AUTH), ADMIN: read(ADMIN)}
        require(all(v is not None for v in config.values()), 'INSTALLED_CONFIG_REQUIRED')
        # A successful repeat does not rerun migrations or regenerate keys.
        if all(read(p) == d for p, d in files.items()) and read(DURATIONS) == durations:
            require(patch_nginx(config[NGINX]) == config[NGINX] and patch_env(config[AUTH]) == config[AUTH], 'REPEAT_CONFIG_DRIFT')
            require(digest(config[ADMIN]) == manifest['configBefore']['adminEnv'], 'REPEAT_ADMIN_CONFIG_DRIFT')
            require(dependencies_match(args.dependencies, args.dependencies_sha256, payload['backend/package-lock.json']), 'REPEAT_DEPENDENCIES_DRIFT')
            healthy()
            print('STARS_ALREADY_INSTALLED revision=' + manifest['revision'])
            return
        before = {p: read(p) for p in files}
        for n, item in manifest['files'].items():
            require(digest(before[target(n)]) == item['before'], 'BEFORE_CHECKSUM_FAILED')
        for path, key in [(NGINX, 'nginx'), (AUTH, 'authEnv'), (ADMIN, 'adminEnv')]:
            require(digest(config[path]) == manifest['configBefore'][key], 'CONFIG_BEFORE_CHECKSUM_FAILED')
        before.update(config)
        before[DURATIONS] = read(DURATIONS)
        require(digest(before[DURATIONS]) == manifest['durations']['before'], 'DURATIONS_BEFORE_CHECKSUM_FAILED')
        nginx_after = patch_nginx(config[NGINX])
        sql = migration_sql(payload)
        prepare_runtime_parents(files)
        for name, data in payload.items():
            if name.endswith(('.js', '.mjs')):
                run([NODE, '--input-type=module', '--check'], input=data)
        run(['nginx', '-t'])
        healthy()
        stage = ROOT / ('stars-release-' + uuid.uuid4().hex)
        stage.mkdir(mode=0o700)
        (stage / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False))
        modules, keys = prepare_dependencies(stage, payload, args.dependencies, args.dependencies_sha256,
                                             not env_values(config[AUTH]).get('GAMIFICATION_PUSH_PUBLIC_KEY'))
        nginx_preflight(stage, nginx_after)
        after = dict(files)
        after.update({NGINX: nginx_after, AUTH: patch_env(config[AUTH], keys), DURATIONS: durations})
        reconcile(before)
        if not args.apply:
            print('STARS_PREFLIGHT_OK revision=' + manifest['revision'] + ' stage=' + str(stage))
            return
        apply_release(stage, before, after, modules, sql)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        code = str(error) if isinstance(error, RuntimeError) and re.fullmatch('[A-Z_]+', str(error)) else 'STARS_RELEASE_FAILED_PRIVATE_STAGE_REQUIRED'
        print(code, file=sys.stderr)
        sys.exit(1)
