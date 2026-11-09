#!/usr/bin/env python3
"""Prepare optimized school images and verify private S3 archives on Timeweb."""
import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import hashlib
import hmac
from io import BytesIO
import json
from pathlib import Path
from tempfile import NamedTemporaryFile
import re
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import Request, urlopen

from PIL import Image, ImageOps

ROOT = Path('/opt/wep_pril')
MEDIA_CONFIG = Path('/etc/wep-pril-media/free-weekly-media.json')
HOST = 's3.twcstorage.ru'
ARCHIVE_MANIFEST = 'article-originals/v1/manifest-20261109.json'
RESAMPLE = getattr(Image, 'Resampling', Image).LANCZOS


def digest(data):
    return hashlib.sha256(data).hexdigest()


def request(config, method, key, data=None, mime=None):
    path = '/' + config['bucket'] + '/' + quote(key, safe='/')
    now = datetime.now(timezone.utc)
    stamp, day = now.strftime('%Y%m%dT%H%M%SZ'), now.strftime('%Y%m%d')
    body_hash = digest(data or b'')
    headers = {'host': HOST, 'x-amz-content-sha256': body_hash, 'x-amz-date': stamp}
    if mime:
        headers['content-type'] = mime
    signed = ';'.join(sorted(headers))
    canonical = '\n'.join([method, path, '', ''.join(
        name + ':' + headers[name] + '\n' for name in sorted(headers)), signed, body_hash])
    scope = '/'.join([day, config['region'], 's3', 'aws4_request'])
    message = '\n'.join(['AWS4-HMAC-SHA256', stamp, scope, digest(canonical.encode())])
    key_bytes = ('AWS4' + config['secretKey']).encode()
    for part in (day, config['region'], 's3', 'aws4_request'):
        key_bytes = hmac.digest(key_bytes, part.encode(), 'sha256')
    signature = hmac.digest(key_bytes, message.encode(), 'sha256').hex()
    headers['authorization'] = (
        'AWS4-HMAC-SHA256 Credential=' + config['accessKey'] + '/' + scope
        + ', SignedHeaders=' + signed + ', Signature=' + signature)
    try:
        with urlopen(Request('https://' + HOST + path, method=method, headers=headers, data=data),
                     timeout=30) as response:
            return response.read(), response.headers.get_content_type()
    except HTTPError as exc:
        raise RuntimeError(f'S3 {method} failed for {key}: HTTP {exc.code}') from None


def verify_private(config, key):
    url = 'https://' + HOST + '/' + config['bucket'] + '/' + quote(key, safe='/')
    try:
        with urlopen(Request(url, method='HEAD'), timeout=15):
            raise RuntimeError(f'Archive key is accessible without authentication: {key}')
    except HTTPError as exc:
        if exc.code not in (401, 403):
            raise RuntimeError(f'Unexpected anonymous response for {key}: HTTP {exc.code}') from None


def store_verified(config, key, data, mime):
    request(config, 'PUT', key, data, mime)
    received, received_type = request(config, 'GET', key)
    if digest(received) != digest(data) or received_type != mime:
        raise RuntimeError(f'S3 readback mismatch for {key}')


def webp(data, width, quality, *, method=5):
    with Image.open(BytesIO(data)) as source:
        image = ImageOps.exif_transpose(source)
        image.thumbnail((width, width), RESAMPLE)
        output = BytesIO()
        image.save(output, format='WEBP', quality=quality, method=method)
        result = output.getvalue()
        with Image.open(BytesIO(result)) as check:
            check.load()
            if check.size != image.size:
                raise RuntimeError('Invalid resized image')
        return result


def original_files():
    folder = ROOT / 'uploads/articles/originals'
    files = sorted(folder.iterdir())
    if not files or any(path.is_symlink() or not path.is_file()
                        or not re.fullmatch(r'[A-Za-z0-9_-]+\.png', path.name) for path in files):
        raise RuntimeError('Unexpected article originals directory')
    return files


def prepare(stage, config):
    stage.mkdir(mode=0o700)
    articles = sorted((ROOT / 'uploads/articles').glob('*.webp'))
    if not articles:
        raise RuntimeError('No article covers found')
    (stage / 'articles').mkdir()
    (stage / 'article-cards').mkdir()

    def archive(path):
        data = path.read_bytes()
        checksum = digest(data)
        key = f'article-originals/v1/{checksum}/{path.name}'
        store_verified(config, key, data, 'image/png')
        return {'name': path.name, 'key': key, 'sha256': checksum, 'bytes': len(data)}

    def article(path):
        if path.is_symlink() or not re.fullmatch(r'[a-z0-9-]+\.webp', path.name):
            raise RuntimeError('Unexpected article cover path')
        data = path.read_bytes()
        full = webp(data, 1040, 85)
        card = webp(data, 640, 82)
        full = min((data, full), key=len)
        card = min((full, card), key=len)
        (stage / 'articles' / path.name).write_bytes(full)
        (stage / 'article-cards' / path.name).write_bytes(card)
        return {'name': path.name, 'before': len(data), 'full': len(full), 'card': len(card),
                'before_sha256': digest(data), 'full_sha256': digest(full), 'card_sha256': digest(card)}

    def weekly(number):
        position = f'{number:03d}'
        original, mime = request(config, 'GET', f'free-weekly/v1/covers/{position}.png')
        if mime != 'image/png':
            raise RuntimeError(f'Invalid source cover {position}')
        data = webp(original, 800, 85)
        key = f'free-weekly/v1/covers-webp/{position}.webp'
        store_verified(config, key, data, 'image/webp')
        return {'key': key, 'before': len(original), 'after': len(data), 'sha256': digest(data)}

    with ThreadPoolExecutor(max_workers=6) as pool:
        originals = list(pool.map(archive, original_files()))
        verify_private(config, originals[0]['key'])
        archive_manifest = (json.dumps(originals, sort_keys=True, indent=2) + '\n').encode()
        store_verified(config, ARCHIVE_MANIFEST, archive_manifest, 'application/json')
        verify_private(config, ARCHIVE_MANIFEST)
        print('S3 originals verified', len(originals), sum(x['bytes'] for x in originals), flush=True)
        covers = list(pool.map(article, articles))
        print('Article covers prepared', len(covers),
              *(sum(x[key] for x in covers) for key in ('before', 'full', 'card')), flush=True)
        videos = list(pool.map(weekly, range(1, 127)))
        verify_private(config, videos[0]['key'])
        print('S3 weekly WebP verified', len(videos),
              *(sum(x[key] for x in videos) for key in ('before', 'after')), flush=True)

    (stage / 'manifest.json').write_text(json.dumps({
        'originals': originals, 'articles': covers, 'weekly_covers': videos,
    }, indent=2) + '\n', encoding='utf-8')


def prepare_course_covers(source, stage, config):
    files = sorted(source.iterdir(), key=lambda path: path.name)
    if not files or any(path.is_symlink() or not path.is_file()
                        or not re.fullmatch(r'(?:[1-9]|10)\.png', path.name) for path in files):
        raise RuntimeError('Supply PNG sources named 1.png to 10.png for the approved cover slots')

    covers = []
    for path in files:
        data = path.read_bytes()
        with Image.open(BytesIO(data)) as original:
            if original.format != 'PNG' or original.size != (1200, 800):
                raise RuntimeError(f'Expected a 1200 x 800 PNG for slot {path.stem}')
        optimized = webp(data, 1200, 89, method=6)
        if len(optimized) >= len(data):
            raise RuntimeError(f'WebP did not reduce the size of slot {path.stem}')
        covers.append((path, data, optimized))

    stage.mkdir(mode=0o700)
    manifest = []
    for path, data, optimized in covers:
        checksum = digest(data)
        key = f'course-covers/v1/originals/{checksum}/{path.name}'
        store_verified(config, key, data, 'image/png')
        verify_private(config, key)
        filename = f'school-{path.stem}.webp'
        (stage / filename).write_bytes(optimized)
        manifest.append({'name': path.name, 'key': key, 'sha256': checksum, 'bytes': len(data),
                         'webp': filename, 'webp_sha256': digest(optimized), 'webp_bytes': len(optimized)})

    archive_manifest = (json.dumps(manifest, sort_keys=True, indent=2) + '\n').encode()
    key = 'course-covers/v1/manifests/' + digest(archive_manifest) + '.json'
    store_verified(config, key, archive_manifest, 'application/json')
    verify_private(config, key)
    (stage / 'manifest.json').write_bytes(archive_manifest)
    print(f'Verified {len(manifest)} archived originals and prepared WebP in {stage}')


def restore_originals(config):
    data, mime = request(config, 'GET', ARCHIVE_MANIFEST)
    if mime != 'application/json':
        raise RuntimeError('Invalid article archive manifest')
    originals = json.loads(data)
    folder = ROOT / 'uploads/articles/originals'
    folder.mkdir(exist_ok=True)
    for item in originals:
        name = item['name']
        if not re.fullmatch(r'[A-Za-z0-9_-]+\.png', name):
            raise RuntimeError('Invalid original filename')
        path = folder / name
        if path.exists():
            if digest(path.read_bytes()) != item['sha256']:
                raise RuntimeError(f'Existing original differs: {name}')
            continue
        data, mime = request(config, 'GET', item['key'])
        if mime != 'image/png' or digest(data) != item['sha256']:
            raise RuntimeError(f'Archived original differs: {name}')
        with NamedTemporaryFile(dir=folder, prefix='.restore-', delete=False) as handle:
            temporary = Path(handle.name)
            try:
                handle.write(data)
                handle.close()
                temporary.chmod(0o644)
                temporary.replace(path)
            finally:
                temporary.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='action', required=True)
    commands.add_parser('prepare').add_argument('stage', type=Path)
    course_command = commands.add_parser('prepare-course-covers')
    course_command.add_argument('source', type=Path)
    course_command.add_argument('stage', type=Path)
    commands.add_parser('restore-originals')
    args = parser.parse_args()
    config = json.loads(MEDIA_CONFIG.read_text(encoding='utf-8'))
    if args.action == 'prepare':
        prepare(args.stage, config)
    elif args.action == 'prepare-course-covers':
        prepare_course_covers(args.source, args.stage, config)
    else:
        restore_originals(config)


if __name__ == '__main__':
    main()
