"""Match supplied article illustrations by title and encode WebP without pixel loss.

Usage: python prepare-server-articles.py articles.json drive-images.json download.zip output-dir
Inputs and generated content are deployment data, never frontend assets.
"""
import hashlib
import json
import pathlib
import re
import sys
import unicodedata
import zipfile
from PIL import Image

source, inventory, archive_path, destination = map(pathlib.Path, sys.argv[1:])
articles = json.loads(source.read_text(encoding='utf-8-sig'))
files = json.loads(inventory.read_text(encoding='utf-8-sig'))
destination.mkdir(parents=True, exist_ok=True)
uploads = destination / 'uploads' / 'articles'
originals = uploads / 'originals'
originals.mkdir(parents=True, exist_ok=True)

def normalize(title):
    title = unicodedata.normalize('NFC', title).lower().replace('ё', 'е')
    return re.sub(r'[^а-яa-z0-9]', '', title)

by_title = {}
with zipfile.ZipFile(archive_path) as archive:
    entries = {unicodedata.normalize('NFC', pathlib.PurePosixPath(entry.filename).name): entry for entry in archive.infolist() if not entry.is_dir()}
    if len(entries) != len(files): raise ValueError('ZIP and Drive file counts differ')
    for file in files:
        entry = entries[unicodedata.normalize('NFC', file['title'])]
        if entry.file_size != int(file['size']): raise ValueError('Size mismatch: ' + file['title'])
        data = archive.read(entry)
        number, title = re.match(r'^(\d+)\s+(.+)\.png$', file['title']).groups()
        original_name = f'drive-{int(number):03d}-{file["id"]}.png'
        (originals / original_name).write_bytes(data)
        by_title.setdefault(normalize(title), []).append({**file, 'original': original_name, 'drive_number': int(number), 'sha256': hashlib.sha256(data).hexdigest()})

report = {'articles': len(articles), 'drive_images': len(files), 'matches': [], 'missing': [], 'unused': [], 'original_bytes': sum(int(file['size']) for file in files), 'webp_bytes': 0}
used = set()
for article in articles:
    matches = by_title.get(normalize(article['title']), [])
    article['image'] = None
    if not matches:
        report['missing'].append({'id': article['id'], 'title': article['title']})
        continue
    file = next((file for file in matches if file['drive_number'] == article['number']), matches[0])
    used.add(file['id'])
    with Image.open(originals / file['original']) as image:
        image.load()
        name = f'{article["id"]}-{file["sha256"][:12]}.webp'
        image.save(uploads / name, format='WEBP', lossless=True, method=4, exact=True)
        with Image.open(uploads / name) as compressed:
            if image.size != compressed.size or image.convert('RGBA').tobytes() != compressed.convert('RGBA').tobytes():
                raise ValueError('Pixel mismatch: ' + article['id'])
    article['image'] = '/uploads/articles/' + name
    size = (uploads / name).stat().st_size
    report['webp_bytes'] += size
    report['matches'].append({'id': article['id'], 'drive_id': file['id'], 'source': file['title'], 'image': article['image'], 'original_sha256': file['sha256'], 'webp_sha256': hashlib.sha256((uploads / name).read_bytes()).hexdigest(), 'webp_bytes': size, 'pixel_identical': True})
report['unused'] = [file['title'] for file in files if file['id'] not in used]
(destination / 'articles.json').write_text(json.dumps(articles, ensure_ascii=False), encoding='utf-8')
(destination / 'migration-report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps({key: report[key] for key in ['articles', 'drive_images', 'missing', 'unused', 'original_bytes', 'webp_bytes']}, ensure_ascii=False))
