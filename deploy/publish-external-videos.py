#!/usr/bin/env python3
"""Publish a checksummed external-video repair from a root-only private stage."""
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import time
import urllib.request

APP = Path('/opt/wep_pril')
TARGETS = {'backend/course-video-links.mjs', 'frontend/course-lesson.js',
           'frontend/article.js', 'frontend/article.html'}
sha = lambda data: hashlib.sha256(data).hexdigest()


def run(*args):
    result = subprocess.run(args, capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError('COMMAND_FAILED:' + args[0])
    return result.stdout


def healthy():
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open('http://127.0.0.1:3001/api/auth/session', timeout=8) as response:
        assert json.load(response)['authenticated'] is False
    with opener.open('http://127.0.0.1:3000/api/health', timeout=8) as response:
        assert json.load(response)['status'] == 'ok'


def restart():
    run('systemctl', 'restart', 'wep-pril-auth')
    for _ in range(30):
        try:
            healthy()
            return
        except Exception:
            time.sleep(.3)
    raise RuntimeError('HEALTH_FAILED')


def atomic(path, data, metadata):
    temporary = path.with_name(path.name + '.external-video-release')
    assert not path.is_symlink() and not temporary.exists()
    try:
        with temporary.open('xb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, metadata.st_mode & 0o777)
        os.chown(temporary, metadata.st_uid, metadata.st_gid)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def table_hashes(connection):
    names = [r[0] for r in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")]
    return {name: sha(repr(connection.execute('SELECT * FROM "' + name.replace('"', '""') + '" ORDER BY rowid').fetchall()).encode())
            for name in names if name != 'course_video_links'}


def main():
    assert os.geteuid() == 0 and len(sys.argv) == 3
    stage = Path(sys.argv[1]).resolve()
    assert stage.parent == Path('/root') and stage.name.startswith('wep-pril-external-videos-')
    assert sys.argv[2] in ('--inspect', '--apply')
    manifest = json.loads((stage / 'manifest.json').read_text())
    assert set(manifest) == TARGETS
    healthy()
    before, metadata = {}, {}
    for name, expected in manifest.items():
        path = APP / name
        assert not any(p.is_symlink() for p in (path, *path.parents))
        before[name] = path.read_bytes()
        metadata[name] = path.stat()
        assert sha(before[name]) == expected['old'], 'SOURCE_CHANGED:' + name
        assert sha((stage / 'files' / name).read_bytes()) == expected['new']
    database = APP / 'data/articles.sqlite'
    connection = sqlite3.connect(database)
    original = connection.execute('SELECT body_json,sha256 FROM course_video_links WHERE singleton=1').fetchone()
    assert sha(original[0].encode()) == original[1]
    untouched = table_hashes(connection)
    sources = json.loads((stage / 'school-embeds-private.json').read_text())
    assert len(sources) == 154 and len({s['lessonId'] for s in sources}) == 154
    sources = {s['lessonId']: s['frames'] for s in sources}
    registry = json.loads(original[0])
    changed = 0
    for row in registry['rows']:
        row.pop('contentHash', None)
        if row['provider'] != 'rutube':
            continue
        prefix = row['url'].rstrip('/') + '/?p='
        candidates = [url for url in sources[row['lessonId']] if url.startswith(prefix)]
        assert len(candidates) == 1, 'SOURCE_VIDEO_MISMATCH'
        changed += row['url'] != candidates[0]
        row['url'] = candidates[0]
    assert changed == 154 and len(registry['rows']) == 1147
    (stage / 'registry-private.json').write_text(json.dumps(registry))
    os.chmod(stage / 'registry-private.json', 0o600)
    copy = sqlite3.connect(stage / 'validation.sqlite')
    connection.backup(copy)
    copy.close()
    os.chmod(stage / 'validation.sqlite', 0o600)
    script = """import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {importCourseVideoLinks,loadCourseVideoLinks} from './files/backend/course-video-links.mjs';
const db=new DatabaseSync(process.argv[2]);
const source=JSON.parse(readFileSync(new URL('./registry-private.json',import.meta.url)));
const result=importCourseVideoLinks(db,source);
if(result.links!==1147||loadCourseVideoLinks(db).size!==1147)throw Error('REGISTRY_CHECK');
db.close(); console.log(JSON.stringify(result));"""
    (stage / 'import.mjs').write_text(script)
    run('node', str(stage / 'import.mjs'), str(stage / 'validation.sqlite'))
    result = {'validatedLinks': 1147, 'restoredRutubeKeys': changed, 'otherTablesUnchanged': True}
    if sys.argv[2] == '--inspect':
        print(json.dumps(result))
        return
    backup = stage / 'before'
    backup.mkdir(mode=0o700)
    snapshot = sqlite3.connect(backup / 'articles-before.sqlite')
    connection.backup(snapshot)
    snapshot.close()
    os.chmod(backup / 'articles-before.sqlite', 0o600)
    for name, data in before.items():
        target = backup / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    (backup / 'registry-private.json').write_text(json.dumps(original))
    os.chmod(backup / 'registry-private.json', 0o600)
    written = []
    try:
        for name in manifest:
            written.append(name)
            atomic(APP / name, (stage / 'files' / name).read_bytes(), metadata[name])
        run('node', str(stage / 'import.mjs'), str(database))
        assert table_hashes(connection) == untouched
        restart()
        assert all(sha((APP / name).read_bytes()) == expected['new'] for name, expected in manifest.items())
    except BaseException:
        connection.execute('UPDATE course_video_links SET body_json=?,sha256=? WHERE singleton=1', original)
        connection.commit()
        for name in reversed(written):
            atomic(APP / name, before[name], metadata[name])
        restart()
        raise
    connection.close()
    result.update(status='PUBLISHED', backup=str(backup))
    (stage / 'result.json').write_text(json.dumps(result, indent=2))
    print(json.dumps(result))


if __name__ == '__main__':
    main()
