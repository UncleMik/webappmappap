#!/usr/bin/env python3
"""Prepare a NEW local PostgreSQL 17 auth database; never rotate existing secrets.

Run without --apply to review. Applying creates persistent service/database access
and must be authorized. External provider keys remain empty and AUTH_ENABLED=false.
No existing databases, users, backups, frontend files or article services are removed.
"""
import argparse
import datetime
import os
import pathlib
import secrets
import shutil
import subprocess


ROOT = pathlib.Path('/opt/wep_pril')
PRIVATE = pathlib.Path('/etc/wep-pril')
PG = pathlib.Path('/etc/postgresql/17/main')
ROLE = 'wep_pril_auth'
TEST_ROLE = 'wep_pril_auth_test'
OWNER = 'wep_pril_auth_owner'


def command(args, label, text=None):
    result = subprocess.run(args, input=text, text=True, capture_output=True)
    if result.returncode:
        # Never print a provider key, password, URL or raw SQL error to the console.
        raise SystemExit('Stopped at: ' + label + '. Existing state is preserved; do not rotate credentials.')
    return result.stdout.strip()


def sql(text, label, database='postgres'):
    return command(['runuser', '-u', 'postgres', '--', 'psql', '-X', '-qAt',
                    '-v', 'ON_ERROR_STOP=1', '-d', database], label, text)


def new_file(path, content, mode=0o600):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    with os.fdopen(descriptor, 'w', encoding='utf-8') as stream:
        # A private umask must not make the non-secret PostgreSQL config unreadable.
        os.fchmod(stream.fileno(), mode)
        stream.write(content)
        stream.flush()
        os.fsync(stream.fileno())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    if not args.apply:
        print('Plan: local-only PostgreSQL; separate owner/runtime/test roles and databases;')
        print('a system user without shell; root-only secret files; schema and minimal grants.')
        print('Does not configure provider keys, start auth, change nginx or enable public login.')
        return
    if os.name != 'posix' or os.geteuid() != 0:
        raise SystemExit('Run as root on the agreed server.')
    import pwd
    os.umask(0o077)
    schema_file = pathlib.Path(__file__).resolve().parent.parent / 'backend/auth/schema.sql'
    if not schema_file.is_file() or not (PG / 'pg_hba.conf').is_file():
        raise SystemExit('Schema or PostgreSQL 17 cluster missing.')
    # Only a newly installed cluster may be reconfigured by this script.
    existing = sql("SELECT count(*) FROM pg_database WHERE datname NOT IN ('postgres','template0','template1');", 'preflight databases')
    roles = sql("SELECT count(*) FROM pg_roles WHERE rolname IN ('wep_pril_auth','wep_pril_auth_test','wep_pril_auth_owner');", 'preflight roles')
    if existing != '0' or roles != '0':
        raise SystemExit('Existing databases/roles found. Inspect them; no overwrite or rotation was performed.')
    if PRIVATE.is_symlink() or (PRIVATE.exists() and PRIVATE.stat().st_uid != 0):
        raise SystemExit('Unexpected private directory ownership.')
    for target in [PRIVATE / 'auth.env', PRIVATE / 'auth-test.env', PG / 'conf.d/wep-pril-auth.conf']:
        if target.exists() or target.is_symlink():
            raise SystemExit('A configuration already exists; inspect it without rotating secrets.')
    try:
        pwd.getpwnam('wep-pril-auth')
    except KeyError:
        pass
    else:
        raise SystemExit('Service user already exists; inspect it before continuing.')
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    backup = ROOT / 'backups' / ('auth-db-config-' + stamp)
    backup.mkdir(mode=0o700)
    for filename in ['postgresql.conf', 'pg_hba.conf']:
        shutil.copy2(PG / filename, backup / filename)
    new_file(PG / 'conf.d/wep-pril-auth.conf', """# Small local auth database. Keep fsync and WAL safety enabled.
listen_addresses = '127.0.0.1'
max_connections = 30
shared_buffers = '64MB'
work_mem = '2MB'
maintenance_work_mem = '32MB'
effective_cache_size = '256MB'
password_encryption = 'scram-sha-256'
statement_timeout = '5s'
idle_in_transaction_session_timeout = '10s'
jit = off
log_statement = 'none'
log_min_error_statement = 'panic'
log_error_verbosity = 'terse'
log_parameter_max_length = 0
log_parameter_max_length_on_error = 0
""", 0o644)
    hba = PG / 'pg_hba.conf'
    policy = """# App roles may connect only to their own database over IPv4 loopback.
host wep_pril_auth wep_pril_auth 127.0.0.1/32 scram-sha-256
host wep_pril_auth_test wep_pril_auth_test 127.0.0.1/32 scram-sha-256
local all wep_pril_auth,wep_pril_auth_test reject
host all wep_pril_auth,wep_pril_auth_test 0.0.0.0/0 reject
host all wep_pril_auth,wep_pril_auth_test ::/0 reject
"""
    hba.write_text(policy + hba.read_text(encoding='utf-8'), encoding='utf-8')
    command(['pg_ctlcluster', '17', 'main', 'restart'], 'restart new PostgreSQL cluster')
    command(['useradd', '--system', '--user-group', '--no-create-home',
             '--home-dir', '/nonexistent', '--shell', '/usr/sbin/nologin', 'wep-pril-auth'], 'create service user')
    PRIVATE.mkdir(mode=0o700, exist_ok=True)
    PRIVATE.chmod(0o700)
    password = secrets.token_hex(32)
    test_password = secrets.token_hex(32)
    # Write secrets before CREATE ROLE so even an interrupted apply is recoverable.
    values = {
        'AUTH_ENABLED': 'false', 'AUTH_ORIGIN': 'https://app.legkie-rody.ru',
        'AUTH_PORT': '3001', 'AUTH_DATABASE_URL': f'postgresql://{ROLE}:{password}@127.0.0.1:5432/{ROLE}',
        'AUTH_HMAC_SECRET': secrets.token_urlsafe(48), 'AUTH_DB_POOL_SIZE': '10',
        'AUTH_MAILS_PER_MINUTE': '120', 'AUTH_GETCOURSE_PER_MINUTE': '30',
        'UNISENDER_API_KEY': '', 'UNISENDER_TEMPLATE_ID': '',
        'UNISENDER_TRANSACTIONAL_APPROVED': 'false', 'AUTH_REPLY_TO': '',
        'GETCOURSE_ORIGIN': 'https://legkierody.ru', 'GETCOURSE_IMPORT_KEY': '',
    }
    new_file(PRIVATE / 'auth.env', ''.join(f'{key}={value}\n' for key, value in values.items()))
    new_file(PRIVATE / 'auth-test.env', f'AUTH_TEST_DATABASE_URL=postgresql://{TEST_ROLE}:{test_password}@127.0.0.1:5432/{TEST_ROLE}\n')
    sql(f"""CREATE ROLE {OWNER} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE ROLE {ROLE} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION CONNECTION LIMIT 12 PASSWORD '{password}';
CREATE ROLE {TEST_ROLE} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION CONNECTION LIMIT 12 PASSWORD '{test_password}';
CREATE DATABASE {ROLE} OWNER {OWNER};
CREATE DATABASE {TEST_ROLE} OWNER {TEST_ROLE};
REVOKE ALL ON DATABASE {ROLE} FROM PUBLIC;
GRANT CONNECT ON DATABASE {ROLE} TO {ROLE};
REVOKE ALL ON DATABASE {TEST_ROLE} FROM PUBLIC;
""", 'create separate databases and roles')
    sql(f'BEGIN; SET ROLE {OWNER};\n' + schema_file.read_text(encoding='utf-8') + f"""
RESET ROLE;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO {ROLE};
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO {ROLE};
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO {ROLE};
ALTER DEFAULT PRIVILEGES FOR ROLE {OWNER} IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO {ROLE};
ALTER DEFAULT PRIVILEGES FOR ROLE {OWNER} IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO {ROLE};
COMMIT;
""", 'migrate schema and grant runtime privileges', ROLE)
    print('Prepared: isolated runtime database, test database, schema and service user.')
    print('Secret files: root:root 0600 in /etc/wep-pril; values were not printed.')
    print('Provider keys remain empty. AUTH_ENABLED=false. Auth service was not started.')
    print('PostgreSQL configuration backup:', backup)


if __name__ == '__main__':
    main()
