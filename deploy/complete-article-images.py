"""Fill missing article images from a verified deployment manifest; preserve other fields."""
import hashlib
import json
from pathlib import Path
import sqlite3
import sys
from datetime import datetime, timezone

bundle, database, uploads, backups = map(Path, sys.argv[1:])
manifest = json.loads((bundle / 'manifest.json').read_text(encoding='utf-8'))
assert len(manifest) == 4
assert {f['id'] for f in manifest} == {'pregnancy-114', 'pregnancy-117', 'pregnancy-123', 'pregnancy-126'}
for entry in manifest:
    for key, hash_key in [('original', 'original_sha256'), ('image', 'webp_sha256')]:
        name = Path(entry[key]).name
        assert hashlib.sha256((bundle / name).read_bytes()).hexdigest() == entry[hash_key]
    assert entry['image'].startswith('/uploads/articles/' + entry['id'] + '-')
db = sqlite3.connect(database)
db.execute('BEGIN IMMEDIATE')
try:
    before = list(db.execute('SELECT * FROM articles ORDER BY id'))
    columns = [r[1] for r in db.execute('PRAGMA table_info(articles)')]
    image_index = columns.index('image')
    id_index = columns.index('id')
    for entry in manifest:
        row = db.execute('SELECT image FROM articles WHERE id=?', (entry['id'],)).fetchone()
        assert row is not None and row[0] in (None, '', entry['image'])
    backups.mkdir(parents=True, exist_ok=True)
    backup_path = backups / ('before-article-images-' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ') + '.sqlite')
    with sqlite3.connect('file:' + str(database) + '?mode=ro', uri=True) as reader:
        with sqlite3.connect(backup_path) as backup:
            reader.backup(backup)
            assert backup.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
    for entry in manifest:
        for name, target in [(Path(entry['image']).name, uploads / 'articles'), (entry['original'], uploads / 'articles' / 'originals')]:
            target.mkdir(parents=True, exist_ok=True)
            destination = target / name
            data = (bundle / name).read_bytes()
            if destination.exists():
                assert destination.read_bytes() == data
            else:
                destination.write_bytes(data)
                destination.chmod(0o644)
        db.execute('UPDATE articles SET image=? WHERE id=?', (entry['image'], entry['id']))
    after = list(db.execute('SELECT * FROM articles ORDER BY id'))
    for old, new in zip(before, after, strict=True):
        assert old[id_index] == new[id_index]
        assert all(a == b for i, (a, b) in enumerate(zip(old, new)) if i != image_index)
    assert db.execute("SELECT count(*) FROM articles WHERE image IS NULL OR trim(image)=''").fetchone()[0] == 0
    db.commit()
    print(json.dumps({'updated': len(manifest), 'articlesWithImages': len(after), 'backup': str(backup_path)}))
except BaseException:
    db.rollback()
    raise
finally:
    db.close()
