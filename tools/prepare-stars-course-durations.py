"""Read durations from the school's existing video sources; never download video.

Input is a private inventory exported from the validated course video registry.
Output contains lesson IDs, content hashes and durations, never source URLs.
Unknown durations remain unavailable for rewards. No browser duration is trusted.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
import json
from pathlib import Path
import re
import subprocess
import time


def identity(row):
    return hashlib.sha256(row['url'].encode()).hexdigest()


def probe(row):
    url, provider = row['url'], row['provider']
    if provider == 'getcourse' and re.fullmatch(r'https://fs\.getcourse\.ru/fileservice/file/download/a/25918/sc/\d+/h/[a-fA-F0-9]{32}\.(mp4|m4v|mov|webm)', url):
        command = ['ffprobe', '-v', 'error', '-rw_timeout', '10000000', '-probesize', '32768',
                   '-analyzeduration', '0', '-show_entries', 'format=duration', '-of', 'json', url]
        field = lambda result: result.get('format', {}).get('duration')
    elif provider in {'youtube', 'rutube'} and re.fullmatch(r'https://(?:www\.youtube(?:-nocookie)?\.com/embed/[A-Za-z0-9_-]+|rutube\.ru/play/embed/[A-Za-z0-9_-]+/?(?:\?p=[A-Za-z0-9_-]+)?)', url):
        command = ['yt-dlp', '--ignore-config', '--skip-download', '--no-playlist', '--no-warnings',
                   '--socket-timeout', '8', '--retries', '1', '--extractor-retries', '1',
                   '--print', '%(duration)j', url]
        field = lambda result: result
    else:
        return {'status': 'unrecognized_source'}
    try:
        result = subprocess.run(command, capture_output=True, timeout=35)
        seconds = float(field(json.loads(result.stdout))) if result.returncode == 0 else 0
        if 0 < seconds < 24 * 60 * 60:
            return {'status': 'verified', 'durationMs': round(seconds * 1000)}
    except (OSError, ValueError, TypeError, subprocess.TimeoutExpired):
        pass
    return {'status': 'unavailable'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('inventory', type=Path)
    parser.add_argument('output', type=Path)
    parser.add_argument('--workers', type=int, default=3, choices=range(1, 5))
    parser.add_argument('--limit', type=int)
    args = parser.parse_args()
    rows = json.loads(args.inventory.read_text(encoding='utf-8-sig'))['rows']
    unique = {identity(row): row for row in rows}
    cache_path = args.output.with_suffix('.cache.json')
    cache = json.loads(cache_path.read_text()) if cache_path.exists() else {}
    pending = [(key, row) for key, row in unique.items() if cache.get(key, {}).get('status') != 'verified']
    if args.limit is not None:
        pending = pending[:args.limit]
    args.output.parent.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    with ThreadPoolExecutor(max_workers=args.workers) as executor:
        tasks = {executor.submit(probe, row): key for key, row in pending}
        for index, task in enumerate(as_completed(tasks), 1):
            cache[tasks[task]] = task.result()
            if index % 10 == 0 or index == len(tasks):
                cache_path.write_text(json.dumps(cache), encoding='utf-8')
                print(f'Probed {index}/{len(tasks)}; verified {sum(v.get("status")=="verified" for v in cache.values())}; elapsed {round(time.monotonic()-started)}s', flush=True)
    output = []
    for row in rows:
        result = cache.get(identity(row), {})
        if result.get('status') == 'verified':
            output.append({key: row[key] for key in ['lessonId', 'videoKey', 'provider', 'contentHash']} | {'durationMs': result['durationMs']})
    args.output.write_text(json.dumps({'version': 1, 'rows': output}, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'rows': len(rows), 'verifiedRows': len(output), 'uniqueSources': len(unique),
                      'unverifiedRows': len(rows)-len(output)}), flush=True)


if __name__ == '__main__':
    main()
