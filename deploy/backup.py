#!/usr/bin/env python3
"""Daily private backup of the content and account databases plus uploads."""

import datetime
import hashlib
import json
import os
import pathlib
import shutil
import sqlite3
import subprocess
import tarfile
from contextlib import closing


ROOT = pathlib.Path('/opt/wep_pril')
AUTH_DATABASE = 'wep_pril_auth'


def require_posix():
    if os.name != 'posix':
        raise RuntimeError('Server backup requires POSIX file permissions')


def run_backup(root=ROOT, *, command=subprocess.run, now=None):
    require_posix()
    root = pathlib.Path(root).resolve()
    backups = root / 'backups'
    backups.mkdir(mode=0o700, parents=True, exist_ok=True)
    backups.chmod(0o700)
    stamp = (now or datetime.datetime.now(datetime.timezone.utc)).strftime('%Y%m%dT%H%M%SZ')
    target = backups / stamp
    target.mkdir(mode=0o700, exist_ok=False)
    try:
        source_uri = 'file:' + str((root / 'data' / 'articles.sqlite').resolve()) + '?mode=ro'
        with closing(sqlite3.connect(source_uri, uri=True)) as source:
            with closing(sqlite3.connect(target / 'articles.sqlite')) as destination:
                source.backup(destination)
                if destination.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                    raise RuntimeError('Invalid SQLite backup')
        (target / 'articles.sqlite').chmod(0o600)

        with tarfile.open(target / 'uploads.tar.gz', 'w:gz') as archive:
            archive.add(root / 'uploads', arcname='uploads')
        (target / 'uploads.tar.gz').chmod(0o600)

        # Root creates this file before changing user. The postgres account can
        # write inherited stdout but cannot browse the private backup folder.
        pg_file = target / 'auth.pgcustom'
        descriptor = os.open(pg_file, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(descriptor, 'wb') as output:
            command(['runuser', '-u', 'postgres', '--', 'pg_dump', '-Fc', '-d', AUTH_DATABASE],
                    stdout=output, stderr=subprocess.PIPE, check=True)
        if pg_file.stat().st_size == 0:
            raise RuntimeError('Empty PostgreSQL backup')
        # Both TOC and contents must be readable before marking a set complete.
        command(['pg_restore', '--list', str(pg_file)], stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE, check=True)
        command(['pg_restore', '--file', '/dev/null', str(pg_file)], stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE, check=True)

        def checksum(name):
            digest = hashlib.sha256()
            with (target / name).open('rb') as source:
                for chunk in iter(lambda: source.read(1024 * 1024), b''):
                    digest.update(chunk)
            return digest.hexdigest()

        manifest = {
            'format': 1,
            'auth_database': AUTH_DATABASE,
            'files': {name: checksum(name)
                      for name in ('articles.sqlite', 'uploads.tar.gz', 'auth.pgcustom')},
        }
        metadata = target / 'manifest.json'
        metadata.write_text(json.dumps(manifest, sort_keys=True) + '\n', encoding='utf-8')
        metadata.chmod(0o600)
        marker = target / 'complete.tmp'
        marker.write_text('ok\n', encoding='ascii')
        marker.chmod(0o600)
        marker.replace(target / 'complete')

        completed = sorted(path for path in backups.iterdir()
                           if path.is_dir() and (path / 'complete').is_file())
        for old in completed[:-7]:
            if old.resolve().parent != backups.resolve():
                raise RuntimeError('Unsafe backup path')
            shutil.rmtree(old)
        return target
    except Exception:
        # Preserve incomplete backup for diagnosis. Rotation runs only after a
        # complete set exists, so failure there is reported separately.
        if (target / 'complete').is_file():
            print('Backup completed, but retention failed:', target)
        else:
            print('Backup failed; incomplete directory preserved:', target)
        raise


if __name__ == '__main__':
    print(run_backup())
