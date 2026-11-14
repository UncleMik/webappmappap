"""Run focused source tests on isolated PostgreSQL using installed production dependencies."""
import importlib.util
import os
from pathlib import Path
import pwd
import re
import shutil
import subprocess
import sys
import uuid

BASE = Path('/var/lib/postgresql')
TESTS = ['analytics.test.mjs', 'admin.test.mjs', 'admin-chats.test.mjs',
         'auth.test.mjs', 'gamification-admin.test.mjs', 'stars-migration.test.mjs']


def run(args, **kwargs):
    return subprocess.run(args, check=True, capture_output=True,
        timeout=kwargs.pop('timeout', 120), **kwargs)


def main(bundle):
    if os.name != 'posix' or os.geteuid() != 0:
        raise RuntimeError('ROOT_REQUIRED')
    spec = importlib.util.spec_from_file_location('checked_bundle', Path(__file__).with_name('check-stars-postgres.py'))
    checker = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(checker)
    suffix = uuid.uuid4().hex[:16]
    scratch = BASE / ('webpril-analytics-check-' + suffix)
    database = 'wep_pril_analytics_' + suffix + '_test'
    marker = 'analytics-check:' + suffix
    if not re.fullmatch(r'wep_pril_analytics_[a-f0-9]{16}_test', database):
        raise RuntimeError('INVALID_DATABASE')
    scratch.mkdir(mode=0o700)
    report = Path('/root') / scratch.name
    report.mkdir(mode=0o700)
    command = ['runuser', '-u', 'postgres', '--']
    sql = command + ['psql', '-XqAt', '-v', 'ON_ERROR_STOP=1', '-d', 'postgres', '-c']
    created = False
    try:
        checker.unpack(bundle, scratch)
        for name in TESTS:
            if not (scratch / 'backend/test' / name).is_file():
                raise RuntimeError('MISSING_FOCUSED_TEST')
        account = pwd.getpwnam('postgres')
        for path in [scratch, *scratch.rglob('*')]:
            if path.is_symlink():
                raise RuntimeError('UNEXPECTED_SYMLINK')
            os.chown(path, account.pw_uid, account.pw_gid)
        # The temporary test user only reads the installed, immutable dependency tree.
        (scratch / 'backend/node_modules').symlink_to('/opt/wep_pril/backend/node_modules', target_is_directory=True)
        run(sql + [f'CREATE DATABASE {database} OWNER postgres'])
        created = True
        run(sql + [f"COMMENT ON DATABASE {database} IS '{marker}'"])
        env = {'PATH': '/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C.UTF-8', 'HOME': str(scratch),
            'AUTH_TEST_DATABASE_URL': f'postgresql://postgres@localhost/{database}?host=%2Fvar%2Frun%2Fpostgresql'}
        with (report / 'tests.log').open('wb') as output:
            result = subprocess.run(command + ['nice', '-n', '10', 'node', '--test',
                '--test-concurrency=2', '--test-timeout=120000', *('test/' + n for n in TESTS)],
                cwd=scratch / 'backend', env=env, stdout=output, stderr=subprocess.STDOUT, timeout=420)
        print('\n'.join((report / 'tests.log').read_text(errors='replace').splitlines()[-12:]), flush=True)
        if result.returncode:
            raise RuntimeError('POSTGRES_CHECK_FAILED')
        print('ANALYTICS_POSTGRES_OK report=' + str(report), flush=True)
    finally:
        if created:
            actual = run(sql + [f"SELECT shobj_description(oid,'pg_database') FROM pg_database WHERE datname='{database}'"]).stdout.decode().strip()
            if actual != marker:
                raise RuntimeError('TEST_DATABASE_MARKER_MISMATCH')
            run(sql + [f'DROP DATABASE {database} WITH (FORCE)'])
        if scratch.parent == BASE and scratch.resolve() == scratch and re.fullmatch(r'webpril-analytics-check-[a-f0-9]{16}', scratch.name):
            shutil.rmtree(scratch)
        print('ANALYTICS_TEST_CLEANUP_OK', flush=True)


if __name__ == '__main__':
    try:
        if len(sys.argv) != 2:
            raise RuntimeError('SOURCE_BUNDLE_REQUIRED')
        main(sys.argv[1])
    except Exception as error:
        print(str(error) if isinstance(error, RuntimeError) and re.fullmatch(r'[A-Z_]+', str(error))
            else 'ANALYTICS_CHECK_FAILED_SEE_PRIVATE_LOG', file=sys.stderr)
        sys.exit(1)
