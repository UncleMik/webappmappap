#!/usr/bin/env python3
import datetime, pathlib, sqlite3, tarfile, shutil

root = pathlib.Path('/opt/wep_pril')
backups = root / 'backups'
target = backups / datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
target.mkdir(mode=0o700, parents=True)
try:
    with sqlite3.connect(f'file:{root}/data/articles.sqlite?mode=ro', uri=True) as source, sqlite3.connect(target / 'articles.sqlite') as destination:
        source.backup(destination)
        if destination.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
            raise RuntimeError('Invalid database backup')
    with tarfile.open(target / 'uploads.tar.gz', 'w:gz') as archive:
        archive.add(root / 'uploads', arcname='uploads')
    (target / 'complete').write_text('ok\n')
    completed = sorted(path for path in backups.iterdir() if path.is_dir() and (path / 'complete').exists())
    for old in completed[:-7]:
        if old.resolve().parent != backups.resolve(): raise RuntimeError('Unsafe backup path')
        shutil.rmtree(old)
    print(target)
except Exception:
    print('Backup failed; incomplete directory preserved:', target)
    raise
