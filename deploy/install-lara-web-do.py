#!/usr/bin/env python3
"""Install the isolated Lara web worker. Secrets enter only through JSON stdin."""
import argparse
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys
import tempfile
import time
import urllib.request
import zipfile

APP_PATH = 'backend/lara-web/lara_web.py'
REQUIREMENTS_PATH = 'backend/lara-web/requirements-web.txt'
PINNED_REQUIREMENTS = b'Pillow==13.0.0\npypdfium2==5.14.0\nav==19.0.2\n'
VENDORS = Path('/opt/legkie-rody/web/vendors')
NGINX = Path('/etc/nginx/sites-available/lr-admin')
ENABLED = Path('/etc/nginx/sites-enabled/lr-admin')
ENV = Path('/etc/legkie-rody-web.env')
CODE = Path('/opt/legkie-rody/web/lara_web.py')
MARKER = Path('/opt/legkie-rody/web/.lara-web-managed')
BACKUP_ROOT = Path('/root')
BEGIN = '    # BEGIN LARA WEB MANAGED\n'
END = '    # END LARA WEB MANAGED\n'
LEGACY_BLOCK = BEGIN + '''    location ^~ /internal/lara-web/ {
        allow 129.101.119.250;
        allow 127.0.0.1;
        deny all;
        client_max_body_size 512k;
        proxy_read_timeout 65s;
        proxy_pass http://127.0.0.1:8100/;
    }
''' + END
BLOCK = LEGACY_BLOCK.replace('client_max_body_size 512k;', 'client_max_body_size 15m;\n        client_body_timeout 90s;').replace(
    'proxy_read_timeout 65s;', 'proxy_http_version 1.1;\n        proxy_request_buffering off;\n        proxy_read_timeout 90s;')


class InstallError(Exception):
    pass


def run(argv, data=None, ok=True):
    try:
        p = subprocess.run(argv, input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=120)
    except subprocess.TimeoutExpired:
        if ok:
            raise InstallError('A required system operation timed out; inspect its state before retry') from None
        return subprocess.CompletedProcess(argv, 124, '', '')
    if ok and p.returncode:
        raise InstallError('A required system operation failed')
    return p


def metadata(opener=None):
    opener = opener or urllib.request.build_opener(urllib.request.ProxyHandler({})).open
    result = []
    for name in ('region', 'id'):
        with opener('http://169.254.169.254/metadata/v1/' + name, timeout=3) as response:
            result.append(response.read(100).decode('ascii').strip())
    if result != ['fra1', '578560550']:
        raise InstallError('This is not the approved DigitalOcean server')


def package(path):
    try:
        with zipfile.ZipFile(path) as z:
            names = z.namelist()
            paths = {APP_PATH, REQUIREMENTS_PATH}
            expected = {'manifest.json'} | {'payload/' + name for name in paths}
            if len(names) != len(expected) or set(names) != expected or any(x.file_size > 1024 * 1024 for x in z.infolist()):
                raise InstallError('Invalid package contents')
            manifest = json.loads(z.read('manifest.json'))
            if not isinstance(manifest, dict) or not re.fullmatch(r'[0-9a-f]{40}', manifest.get('revision', '')):
                raise InstallError('Invalid manifest revision')
            files = manifest.get('files')
            if (not isinstance(files, dict) or set(files) != paths
                    or any(not isinstance(value, str) or not re.fullmatch(r'[0-9a-f]{64}', value) for value in files.values())):
                raise InstallError('Invalid manifest files')
            contents = {name: z.read('payload/' + name) for name in paths}
            if any(hashlib.sha256(value).hexdigest() != files[name] for name, value in contents.items()):
                raise InstallError('Package checksum mismatch')
            if contents[REQUIREMENTS_PATH] != PINNED_REQUIREMENTS:
                raise InstallError('Unexpected web dependency pins')
            return manifest['revision'], contents[APP_PATH], contents[REQUIREMENTS_PATH]
    except (OSError, zipfile.BadZipFile, KeyError, ValueError, TypeError):
        raise InstallError('Invalid package') from None


def patch_nginx(text):
    if text.count(BEGIN) != text.count(END) or text.count(BEGIN) > 1:
        raise InstallError('Ambiguous managed nginx block')
    if BEGIN in text:
        begin, end = text.index(BEGIN), text.index(END) + len(END)
        if text[begin:end] not in (BLOCK, LEGACY_BLOCK):
            raise InstallError('Managed nginx block differs from expected')
        return text[:begin] + BLOCK + text[end:]
    # This deliberately accepts only the known, simple nginx server layout.
    lines = text.splitlines(keepends=True)
    depth = 0
    servers, start = [], None
    for i, line in enumerate(lines):
        clean = line.split('#', 1)[0]
        if '"' in clean or "'" in clean:
            raise InstallError('Unsupported nginx quoting')
        if re.match(r'^\s*server\s*\{\s*$', clean):
            if depth != 0:
                raise InstallError('Unexpected nginx nesting')
            start = i
        depth += clean.count('{') - clean.count('}')
        if depth < 0:
            raise InstallError('Invalid nginx configuration')
        if start is not None and depth == 0:
            servers.append((start, i + 1))
            start = None
    if depth or start is not None:
        raise InstallError('Invalid nginx configuration')
    targets = [(a, b) for a, b in servers if re.search(r'(?m)^\s*server_name\s+admin\.legkie-rody\.ru\s*;', ''.join(lines[a:b]))
               and re.search(r'(?m)^\s*listen\s+443\s+ssl\s*;', ''.join(lines[a:b]))]
    if len(targets) != 1:
        raise InstallError('Cannot uniquely identify the TLS server')
    a, b = targets[0]
    positions = [i for i in range(a, b) if re.match(r'^\s*location\s+/\s*\{\s*$', lines[i].split('#', 1)[0])]
    if len(positions) != 1 or '/internal/lara-web/' in text:
        raise InstallError('Cannot uniquely place nginx route')
    lines.insert(positions[0], BLOCK)
    return ''.join(lines)


def inspect(name, required=True):
    p = run(['docker', 'inspect', name], ok=False)
    if p.returncode:
        if required:
            raise InstallError('Required container is missing')
        return None
    return json.loads(p.stdout)[0]


def env_dict(container):
    return dict(item.split('=', 1) for item in container['Config']['Env'] if '=' in item)


def read_secret():
    raw = sys.stdin.buffer.read(8193)
    if len(raw) > 8192:
        raise InstallError('Invalid secret input')
    try:
        value = json.loads(raw)
        secret = value['secret']
        if set(value) != {'secret'} or not isinstance(secret, str) or len(secret.encode()) < 32 or len(secret) > 1024 or any(x in secret for x in '\r\n\0'):
            raise ValueError()
        return secret
    except (ValueError, KeyError, TypeError, UnicodeDecodeError):
        raise InstallError('Invalid secret input') from None


def psql(postgres, sql, database='postgres'):
    user = env_dict(postgres).get('POSTGRES_USER', 'postgres')
    if not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]{0,62}', user):
        raise InstallError('Unsupported database user')
    return run(['docker', 'exec', '-i', 'lr_postgres', 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-qAt', '-U', user, '-d', database], sql).stdout.strip()


def role_exists(pg):
    return psql(pg, "SELECT count(*) FROM pg_roles WHERE rolname='lara_web_reader';\n") == '1'


def atomic_write(path, data, mode):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix='.lara-web-')
    try:
        os.fchmod(fd, mode)
        with os.fdopen(fd, 'wb') as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def snapshot(path):
    return path.read_bytes() if path.exists() else None


def vendor_bundle(requirements, image):
    """Use only a separately prepared immutable bundle; never install dependencies."""
    digest = hashlib.sha256(requirements).hexdigest()
    folder = VENDORS / digest
    if any(path.is_symlink() for path in (folder, *folder.parents)) or not folder.is_dir():
        raise InstallError('Web dependency bundle is missing or has a symlink')
    if any(path.is_symlink() for path in folder.rglob('*')):
        raise InstallError('Web dependency bundle contains a symlink')
    marker = folder / '.bundle.json'
    try:
        if not marker.is_file() or marker.stat().st_size > 4096:
            raise ValueError()
        value = json.loads(marker.read_bytes())
    except (OSError, ValueError, TypeError):
        raise InstallError('Invalid web dependency bundle marker') from None
    if value != {'requirementsSha256': digest, 'baseImage': image}:
        raise InstallError('Web dependency bundle does not match requirements and base image')
    return folder


def restore(path, original, mode):
    if original is None:
        path.unlink(missing_ok=True)
    else:
        atomic_write(path, original, mode)


@contextmanager
def deployment_lock():
    # Only --apply creates this persistent lock file; --check stays read-only.
    import fcntl
    fd = os.open('/run/lock/lara-web-deploy.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise InstallError('Another deployment is already running') from None
        yield
    finally:
        os.close(fd)


def preflight(archive):
    metadata()
    revision, code, requirements = package(archive)
    if not ENABLED.is_symlink() or NGINX.is_symlink() or ENABLED.resolve() != NGINX or not NGINX.is_file():
        raise InstallError('Unexpected nginx site path')
    original_nginx = NGINX.read_bytes()
    patched = patch_nginx(original_nginx.decode('utf-8')).encode()
    app, pg, web = inspect('lr_app'), inspect('lr_postgres'), inspect('lr_web', False)
    vendor = vendor_bundle(requirements, app['Image'])
    for container in (app, pg):
        if not container['State']['Running'] or 'legkie-rody_default' not in container['NetworkSettings']['Networks']:
            raise InstallError('Existing application or database is not running as expected')
    env = env_dict(app)
    for name in ('POSTGRES_HOST', 'POSTGRES_PORT', 'POSTGRES_DB'):
        if name == 'POSTGRES_PORT':
            continue
        if not env.get(name):
            raise InstallError('Missing database configuration')
    if not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]{0,62}', env['POSTGRES_DB']):
        raise InstallError('Unsupported database name')
    if web and (not MARKER.is_file() or not ENV.is_file() or web.get('Config', {}).get('Labels', {}).get('com.legkie-rody.lara-web') != 'managed'):
        raise InstallError('Existing web container is not managed by this installer')
    exists = role_exists(pg)
    if exists and (not MARKER.is_file() or not ENV.is_file()):
        raise InstallError('Existing database role is not managed by this installer')
    if any(p.is_symlink() for p in (CODE, ENV, MARKER)):
        raise InstallError('Unexpected managed path symlink')
    if not exists and (MARKER.exists() or ENV.exists() or CODE.exists() or web):
        raise InstallError('Incomplete previous installation requires inspection')
    originals = (snapshot(CODE), snapshot(ENV), snapshot(MARKER))
    return revision, code, original_nginx, patched, app, pg, web, env, exists, originals, requirements, vendor


def install(pre, secret):
    revision, code, original_nginx, patched, app, pg, web, old_env, exists, originals, requirements, vendor = pre
    if vendor_bundle(requirements, app['Image']) != vendor:
        raise InstallError('Web dependency bundle changed during preflight')
    started = [app['State']['StartedAt'], pg['State']['StartedAt']]
    old_code, old_config, old_marker = originals
    original_hash = hashlib.sha256(original_nginx).digest()
    stamp = time.strftime('%Y%m%d%H%M%S') + '-' + secrets.token_hex(4)
    backup = BACKUP_ROOT / ('lara-web-release-' + stamp)
    backup.mkdir(mode=0o700)
    for name, contents in [('nginx', original_nginx), ('code', old_code), ('env', old_config), ('marker', old_marker)]:
        if contents is not None:
            atomic_write(backup / name, contents, 0o600)
    new_role = False
    old_renamed = False
    old_stopped = False
    new_container = None
    written = {}
    dbname = old_env['POSTGRES_DB']
    dbpassword = secrets.token_hex(32)
    if exists:
        previous = dict(line.split('=', 1) for line in old_config.decode().splitlines() if '=' in line)
        dbpassword = previous['POSTGRES_PASSWORD']
    old_name = 'lr_web_previous_' + stamp.replace('-', '_')
    try:
        if hashlib.sha256(NGINX.read_bytes()).digest() != original_hash:
            raise InstallError('Nginx configuration changed during preflight')
        if [inspect('lr_app')['State']['StartedAt'], inspect('lr_postgres')['State']['StartedAt']] != started:
            raise InstallError('Existing application or database restarted during preflight')
        if (snapshot(CODE), snapshot(ENV), snapshot(MARKER)) != originals:
            raise InstallError('Managed files changed during preflight')
        if not exists:
            sql = ("BEGIN;\nCREATE ROLE lara_web_reader LOGIN PASSWORD '" + dbpassword + "' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;\n"
                   'ALTER ROLE lara_web_reader SET default_transaction_read_only=on;\n'
                   'GRANT CONNECT ON DATABASE "' + dbname + '" TO lara_web_reader;\nCOMMIT;\n')
            psql(pg, sql)
            new_role = True
            psql(pg, 'GRANT USAGE ON SCHEMA public TO lara_web_reader;\nGRANT SELECT ON public.knowledge_chunks, public.lessons TO lara_web_reader;\n', dbname)
        # Reject inherited public privileges on any other table, or write access anywhere.
        audit = psql(pg, "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND c.relkind IN ('r','p','v','m','f') AND (has_table_privilege('lara_web_reader',c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR ((n.nspname <> 'public' OR c.relname NOT IN ('knowledge_chunks','lessons')) AND has_table_privilege('lara_web_reader',c.oid,'SELECT')));\n", dbname)
        if audit != '0':
            raise InstallError('Database role has excessive inherited access')
        role_audit = psql(pg, "SELECT count(*) FROM pg_roles r WHERE r.rolname='lara_web_reader' AND r.rolcanlogin AND r.rolconfig @> ARRAY['default_transaction_read_only=on'] AND NOT (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls) AND NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid);\n")
        if role_audit != '1':
            raise InstallError('Database role properties are unexpected')
        privileges = psql(pg, "SELECT (has_table_privilege('lara_web_reader','public.knowledge_chunks','SELECT') AND has_table_privilege('lara_web_reader','public.lessons','SELECT') AND NOT has_schema_privilege('lara_web_reader','public','CREATE') AND NOT has_database_privilege('lara_web_reader',current_database(),'CREATE'))::int;\n", dbname)
        if privileges != '1':
            raise InstallError('Database role privileges are unexpected')
        model_names = {'MAX_OUTPUT_TOKENS', 'MAX_OUTPUT_TOKENS_DETAIL', 'MAX_OUTPUT_TOKENS_VISION',
                       'EMBED_MODEL', 'EMBED_DIM', 'RAG_CHUNKS', 'POLISH_ENABLED', 'POLISH_MODEL', 'POLISH_TIMEOUT'}
        values = {k: v for k, v in old_env.items() if k.startswith(('GEMINI_', 'GROK_', 'GROQ_')) or k in model_names}
        values.update({'POSTGRES_HOST': old_env['POSTGRES_HOST'], 'POSTGRES_PORT': old_env.get('POSTGRES_PORT', '5432'),
                       'POSTGRES_DB': dbname, 'POSTGRES_USER': 'lara_web_reader', 'POSTGRES_PASSWORD': dbpassword,
                       'LARA_WEB_HMAC_SECRET': secret, 'BOT_ENABLED': 'false', 'MAX_ENABLED': 'false', 'GETCOURSE_MODE': 'off',
                       'PYTHONPATH': '/web/vendor:/web:/code', 'PYTHONDONTWRITEBYTECODE': '1'})
        if any('\n' in v or '\r' in v or '\0' in v for v in values.values()):
            raise InstallError('Unsupported runtime configuration')
        if (snapshot(CODE), snapshot(ENV), snapshot(MARKER)) != originals:
            raise InstallError('Managed files changed during deployment')
        env_bytes = ''.join(k + '=' + v + '\n' for k, v in values.items()).encode()
        marker_bytes = (revision + '\n').encode()
        atomic_write(CODE, code, 0o644)
        written[CODE] = (code, old_code, 0o644)
        atomic_write(ENV, env_bytes, 0o600)
        written[ENV] = (env_bytes, old_config, 0o600)
        atomic_write(MARKER, marker_bytes, 0o600)
        written[MARKER] = (marker_bytes, old_marker, 0o600)
        if web:
            run(['docker', 'stop', '--time', '70', 'lr_web'])
            old_stopped = True
            run(['docker', 'rename', 'lr_web', old_name])
            old_renamed = True
        created = run(['docker', 'create', '--name', 'lr_web', '--label', 'com.legkie-rody.lara-web=managed', '--restart', 'unless-stopped',
             '--network', 'legkie-rody_default', '--memory', '384m', '--cpus', '0.75', '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,size=32m',
             '-p', '127.0.0.1:8100:8100', '--env-file', str(ENV), '-v', str(CODE) + ':/web/lara_web.py:ro',
             '-v', str(vendor) + ':/web/vendor:ro',
             app['Image'], 'uvicorn', 'lara_web:app', '--host', '0.0.0.0', '--port', '8100', '--workers', '1',
             '--loop', 'asyncio', '--no-access-log'])
        new_container = created.stdout.strip()
        if not re.fullmatch(r'[a-f0-9]{64}', new_container):
            raise InstallError('Invalid new container identifier')
        run(['docker', 'start', new_container])
        healthy = False
        for _ in range(20):
            try:
                with urllib.request.urlopen('http://127.0.0.1:8100/health', timeout=2) as r:
                    healthy = r.status == 200 and json.loads(r.read(1024)).get('status') == 'ok'
                if healthy:
                    break
            except Exception:
                time.sleep(1)
        if not healthy:
            raise InstallError('New web worker health check failed')
        if hashlib.sha256(NGINX.read_bytes()).digest() != original_hash:
            raise InstallError('Nginx configuration changed during deployment')
        atomic_write(NGINX, patched, 0o644)
        run(['nginx', '-t'])
        run(['nginx', '-s', 'reload'])
        if [inspect('lr_app')['State']['StartedAt'], inspect('lr_postgres')['State']['StartedAt']] != started:
            raise InstallError('Existing application or database restarted during deployment')
        if old_renamed:
            run(['docker', 'rm', old_name])
        print('Installed revision', revision, '; private backup', backup)
    except Exception:
        if new_container and re.fullmatch(r'[a-f0-9]{64}', new_container):
            run(['docker', 'rm', '-f', new_container], ok=False)
        for path, (our_value, original, mode) in written.items():
            if snapshot(path) == our_value:
                restore(path, original, mode)
        if old_renamed:
            run(['docker', 'rename', old_name, 'lr_web'], ok=False)
            run(['docker', 'start', 'lr_web'], ok=False)
        elif old_stopped:
            run(['docker', 'start', 'lr_web'], ok=False)
        # Avoid overwriting a concurrent third-party nginx edit.
        if NGINX.read_bytes() == patched:
            restore(NGINX, original_nginx, 0o644)
            if not run(['nginx', '-t'], ok=False).returncode:
                run(['nginx', '-s', 'reload'], ok=False)
        if new_role:
            try:
                psql(pg, 'ALTER ROLE lara_web_reader NOLOGIN;\n')
            except Exception:
                pass
        raise InstallError('Installation failed; rollback attempted') from None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('archive')
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument('--check', action='store_true')
    modes.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    try:
        if os.geteuid() != 0:
            raise InstallError('Root is required')
        secret = read_secret()
        if args.apply:
            with deployment_lock():
                pre = preflight(args.archive)
                install(pre, secret)
        else:
            pre = preflight(args.archive)
            print('Preflight passed for revision', pre[0])
    except Exception as exc:
        print(str(exc) if isinstance(exc, InstallError) else 'Preflight or installation failed', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
