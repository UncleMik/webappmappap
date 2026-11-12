"""Run a hash-checked source bundle against a fresh PostgreSQL test database.

This does not load production environment files, copy user data, migrate the
production database, publish code, or start a persistent application server.
Usage on Timeweb: sudo python3 check-stars-postgres.py /private/source.zip
"""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys
import uuid
import zipfile


BASE = Path('/var/lib/postgresql')
NAME = re.compile(r'webpril-stars-check-[0-9a-f]{16}')
DBNAME = re.compile(r'webpril_stars_[0-9a-f]{16}_test')


def run(args, **kwargs):
    return subprocess.run(args, check=True, capture_output=True,
                          timeout=kwargs.pop('timeout', 90), **kwargs)


def permitted(name):
    path = PurePosixPath(name)
    if path.is_absolute() or any(p in ('', '.', '..') or p.startswith('.') for p in path.parts):
        return False
    if '\\' in name or ':' in name:
        return False
    if name in {'Фронт/assets/auth-mother-v1.webp', 'Фронт/push-worker.js', 'backend/lara-source-map.json',
                'backend/test/fixtures/profile-edit-noise.jpg',
                'docs/content/getcourse-offers-2026-10-22.json'}:
        return True
    if name.startswith('Фронт/admin/') and path.suffix in {'.html', '.js', '.css'}:
        return len(path.parts) == 3
    if not name.startswith('backend/') or path.suffix not in {'.mjs', '.json', '.sql'}:
        return False
    if len(path.parts) == 2:
        return path.suffix == '.mjs' or path.name in {'package.json', 'package-lock.json'}
    return path.parts[1] in {'auth', 'test', 'content', 'seed'} and len(path.parts) <= 4


def unpack(bundle, scratch):
    with zipfile.ZipFile(bundle) as archive:
        members = archive.infolist()
        if len({item.filename for item in members}) != len(members):
            raise RuntimeError('DUPLICATE_BUNDLE_PATH')
        if any(item.file_size > 10_000_000 for item in members) or sum(item.file_size for item in members) > 80_000_000:
            raise RuntimeError('BUNDLE_TOO_LARGE')
        manifest = json.loads(archive.read('manifest.json'))
        files = manifest.get('files', {})
        if not files or set(archive.namelist()) != {'manifest.json', *files}:
            raise RuntimeError('INVALID_BUNDLE_MANIFEST')
        if not all(permitted(name) for name in files):
            raise RuntimeError('UNEXPECTED_BUNDLE_PATH')
        required = {'backend/package.json', 'backend/package-lock.json', 'backend/test/auth-pool.mjs'}
        if not required <= files.keys():
            raise RuntimeError('INCOMPLETE_BUNDLE')
        for name, expected in files.items():
            data = archive.read(name)
            if hashlib.sha256(data).hexdigest() != expected:
                raise RuntimeError('BUNDLE_CHECKSUM_FAILED')
            target = scratch / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
        return manifest


def unpack_npm(bundle, destination, expected):
    if not re.fullmatch('[a-f0-9]{64}', expected) or hashlib.sha256(Path(bundle).read_bytes()).hexdigest() != expected:
        raise RuntimeError('NPM_RUNNER_CHECKSUM_FAILED')
    with zipfile.ZipFile(bundle) as archive:
        files = json.loads(archive.read('runner-manifest.json'))['files']
        if set(archive.namelist()) != {'runner-manifest.json', *files} or len(archive.namelist()) != len(files)+1:
            raise RuntimeError('INVALID_NPM_RUNNER')
        if sum(i.file_size for i in archive.infolist()) > 40_000_000:
            raise RuntimeError('NPM_RUNNER_TOO_LARGE')
        for name, digest in files.items():
            p = PurePosixPath(name)
            if p.is_absolute() or '..' in p.parts or '\\' in name or ':' in name:
                raise RuntimeError('INVALID_NPM_RUNNER_PATH')
            data = archive.read(name)
            if hashlib.sha256(data).hexdigest() != digest:
                raise RuntimeError('NPM_RUNNER_CHECKSUM_FAILED')
            path = destination / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
    return destination / 'bin/npm-cli.js'


def unpack_dependencies(bundle, destination, expected, lock_checksum):
    if not re.fullmatch('[a-f0-9]{64}', expected) or hashlib.sha256(Path(bundle).read_bytes()).hexdigest() != expected:
        raise RuntimeError('DEPENDENCY_CHECKSUM_FAILED')
    with zipfile.ZipFile(bundle) as archive:
        manifest = json.loads(archive.read('dependencies-manifest.json'))
        files = manifest['files']
        if manifest.get('packageLockSha256') != lock_checksum or set(archive.namelist()) != {'dependencies-manifest.json', *files} or len(archive.namelist()) != len(files)+1:
            raise RuntimeError('DEPENDENCY_LOCK_MISMATCH')
        if sum(i.file_size for i in archive.infolist()) > 20_000_000 or not {'pg/package.json', 'web-push/package.json'} <= files.keys():
            raise RuntimeError('INVALID_DEPENDENCY_BUNDLE')
        for name, digest in files.items():
            p = PurePosixPath(name)
            if p.is_absolute() or '..' in p.parts or '\\' in name or ':' in name or p.suffix in {'.node','.dll','.so','.exe'}:
                raise RuntimeError('INVALID_DEPENDENCY_PATH')
            data = archive.read(name)
            if hashlib.sha256(data).hexdigest() != digest:
                raise RuntimeError('DEPENDENCY_CHECKSUM_FAILED')
            path = destination / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)


def main(bundle, dependencies, dependencies_checksum):
    if os.name != 'posix' or os.geteuid() != 0:
        raise RuntimeError('RUN_AS_ROOT_ON_TEST_HOST')
    import pwd
    suffix = uuid.uuid4().hex[:16]
    scratch = BASE / ('webpril-stars-check-' + suffix)
    database = 'webpril_stars_' + suffix + '_test'
    marker = 'webpril-stars-check:' + suffix
    if not NAME.fullmatch(scratch.name) or not DBNAME.fullmatch(database):
        raise RuntimeError('INVALID_TEMPORARY_NAME')
    scratch.mkdir(mode=0o700)
    report = Path('/root') / scratch.name
    report.mkdir(mode=0o700)
    admin = ['runuser', '-u', 'postgres', '--', 'psql', '-XqAt', '-v', 'ON_ERROR_STOP=1', '-d', 'postgres', '-c']
    created = False
    try:
        manifest = unpack(bundle, scratch)
        unpack_dependencies(dependencies, scratch / 'backend/node_modules', dependencies_checksum,
                            manifest['files']['backend/package-lock.json'])
        (report / 'manifest.json').write_text(json.dumps(manifest), encoding='utf-8')
        postgres = pwd.getpwnam('postgres')
        for path in [scratch, *scratch.rglob('*')]:
            if path.is_symlink():
                raise RuntimeError('UNEXPECTED_SYMLINK')
            os.chown(path, postgres.pw_uid, postgres.pw_gid)
        env = {'PATH': os.environ.get('PATH', '/usr/local/bin:/usr/bin:/bin'), 'LANG': 'C.UTF-8',
               'HOME': str(scratch), 'npm_config_cache': str(scratch / 'npm-cache'),
               'npm_config_userconfig': str(scratch / 'npm-user.conf'),
               'npm_config_globalconfig': str(scratch / 'npm-global.conf'),
               'npm_config_prefix': str(scratch)}
        work = scratch / 'backend'
        run(admin + [f'CREATE DATABASE {database} OWNER postgres'])
        created = True
        run(admin + [f"COMMENT ON DATABASE {database} IS '{marker}'"])
        env['AUTH_TEST_DATABASE_URL'] = f'postgresql://postgres@localhost/{database}?host=%2Fvar%2Frun%2Fpostgresql'
        test_files = sorted(str(p.relative_to(work)) for p in (work / 'test').glob('*.test.mjs'))
        if not test_files:
            raise RuntimeError('NO_TEST_FILES')
        with (report / 'postgres-tests.log').open('wb') as log:
            result = subprocess.run(['runuser', '-u', 'postgres', '--', 'nice', '-n', '10',
                                     'node', '--test', '--test-timeout=120000', '--test-concurrency=2', *test_files],
                                    cwd=work, env=env, stdout=log, stderr=subprocess.STDOUT, timeout=420)
        print('\n'.join((report / 'postgres-tests.log').read_text(errors='replace').splitlines()[-12:]), flush=True)
        if result.returncode:
            raise RuntimeError('POSTGRES_TESTS_FAILED')
        print('POSTGRES_TESTS_OK report=' + str(report), flush=True)
    finally:
        if created:
            observed = run(admin + [f"SELECT shobj_description(oid,'pg_database') FROM pg_database WHERE datname='{database}'"]).stdout.decode().strip()
            if observed != marker:
                raise RuntimeError('DATABASE_MARKER_MISMATCH_PRESERVED')
            run(admin + [f'DROP DATABASE {database} WITH (FORCE)'])
        if scratch.parent == BASE and NAME.fullmatch(scratch.name) and scratch.resolve() == scratch:
            shutil.rmtree(scratch)
        print('CHECK_REPORT=' + str(report), flush=True)


if __name__ == '__main__':
    if len(sys.argv) != 4:
        raise SystemExit('Usage: check-stars-postgres.py source.zip production-dependencies.zip dependency-sha256')
    try:
        main(*sys.argv[1:])
    except Exception as error:
        # Never print environment, SQL rows, subprocess argv or credentials.
        code = str(error) if isinstance(error, RuntimeError) and re.fullmatch('[A-Z_]+', str(error)) else 'CHECK_FAILED_SEE_PRIVATE_REPORT'
        print(code, file=sys.stderr)
        raise SystemExit(1)
