#!/usr/bin/env python3
"""Prove a complete backup restores into a fresh, isolated PostgreSQL DB."""

import hashlib
import json
import os
import pathlib
import re
import sqlite3
import subprocess
import sys
import tarfile
import uuid
from contextlib import closing


ROOT = pathlib.Path('/opt/wep_pril')
BACKUP_NAME = re.compile(r'^\d{8}T\d{6}Z$')
CHECK_NAME = re.compile(r'^wep_pril_restore_check_[0-9a-f]{16}$')
EXPECTED = {'articles.sqlite', 'uploads.tar.gz', 'auth.pgcustom'}


def require_posix():
    if os.name != 'posix':
        raise RuntimeError('Restore check requires POSIX server tools')


def postgres(command, arguments, **kwargs):
    return command(['runuser', '-u', 'postgres', '--', *arguments],
                   check=True, stderr=subprocess.PIPE, **kwargs)


def archive_tables(listing, kind):
    pattern = re.compile(r'^\d+;\s+\d+\s+\d+\s+' + kind + r'\s+public\s+([a-z][a-z0-9_]*)\s', re.I)
    return {match.group(1) for line in listing.splitlines() if (match := pattern.match(line))}


def verify_backup(path, *, root=ROOT, command=subprocess.run, suffix=None):
    require_posix()
    root = pathlib.Path(root).resolve()
    path = pathlib.Path(path).resolve()
    if path.parent != (root / 'backups').resolve() or not BACKUP_NAME.fullmatch(path.name):
        raise ValueError('Backup must be a dated directory under the configured backup root')
    if not (path / 'complete').is_file() or (path / 'complete').read_text(encoding='ascii') != 'ok\n':
        raise RuntimeError('Backup is not complete')
    manifest = json.loads((path / 'manifest.json').read_text(encoding='utf-8'))
    if manifest.get('format') != 1 or manifest.get('auth_database') != 'wep_pril_auth' or set(manifest.get('files', {})) != EXPECTED:
        raise RuntimeError('Backup manifest is invalid')
    for name in EXPECTED:
        digest = hashlib.sha256()
        with (path / name).open('rb') as file:
            for chunk in iter(lambda: file.read(1024 * 1024), b''):
                digest.update(chunk)
        if digest.hexdigest() != manifest['files'][name]:
            raise RuntimeError('Backup file checksum mismatch: ' + name)
    with closing(sqlite3.connect(f'file:{path / "articles.sqlite"}?mode=ro', uri=True)) as sqlite:
        if sqlite.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
            raise RuntimeError('SQLite backup is invalid')
    with tarfile.open(path / 'uploads.tar.gz', 'r:gz') as archive:
        if not archive.getmembers() or not all(member.name == 'uploads' or member.name.startswith('uploads/') for member in archive):
            raise RuntimeError('Uploads archive is invalid')

    dump = path / 'auth.pgcustom'
    listing = command(['pg_restore', '--list', str(dump)], capture_output=True, text=True, check=True).stdout
    tables = archive_tables(listing, 'TABLE')
    data_tables = archive_tables(listing, 'TABLE DATA')
    if not {'auth_users', 'auth_sessions', 'course_access_checks'} <= tables or tables != data_tables:
        raise RuntimeError('PostgreSQL archive table inventory is incomplete')
    command(['pg_restore', '--file', '/dev/null', str(dump)], stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE, check=True)

    suffix = suffix or uuid.uuid4().hex[:16]
    name = 'wep_pril_restore_check_' + suffix
    if not CHECK_NAME.fullmatch(name):
        raise ValueError('Invalid restore check database name')
    marker = 'wep_pril_restore_check:' + suffix
    created = False
    try:
        postgres(command, ['createdb', '--template=template0', name], stdout=subprocess.DEVNULL)
        created = True
        postgres(command, ['psql', '-X', '-v', 'ON_ERROR_STOP=1', '-d', 'postgres',
                           '-c', f"COMMENT ON DATABASE {name} IS '{marker}'"], stdout=subprocess.DEVNULL)
        # postgres cannot traverse the root-only backup directory. Root opens
        # the archive and passes only the stream to the isolated restore.
        with dump.open('rb') as input_file:
            postgres(command, ['pg_restore', '--exit-on-error', '--single-transaction',
                               '--no-owner', '--no-acl', '-d', name], stdin=input_file,
                     stdout=subprocess.DEVNULL)
        result = postgres(command, ['psql', '-X', '-At', '-v', 'ON_ERROR_STOP=1', '-d', name,
                                    '-c', "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename"],
                          stdout=subprocess.PIPE, text=True)
        restored = {line for line in result.stdout.splitlines() if line}
        if restored != tables:
            raise RuntimeError('Restored PostgreSQL table inventory differs from the archive')
        return {'tables': len(restored), 'backup': str(path)}
    finally:
        if created:
            observed = postgres(command, ['psql', '-X', '-At', '-v', 'ON_ERROR_STOP=1', '-d', 'postgres',
                                          '-c', f"SELECT shobj_description(oid, 'pg_database') FROM pg_database WHERE datname='{name}'"],
                                stdout=subprocess.PIPE, text=True).stdout.strip()
            if observed != marker:
                raise RuntimeError('Restore check database marker differs; temporary database preserved')
            postgres(command, ['dropdb', '--if-exists', name], stdout=subprocess.DEVNULL)


if __name__ == '__main__':
    if len(sys.argv) != 2:
        raise SystemExit('Usage: python3 verify-backup.py /opt/wep_pril/backups/YYYYMMDDTHHMMSSZ')
    result = verify_backup(sys.argv[1])
    print(f"Verified isolated restore of {result['tables']} PostgreSQL tables from {result['backup']}")
