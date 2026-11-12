"""Small hash-pinned UI/wallet correction; no database/config/dependency writes.

Sibling publish-stars.py is required for the existing safe IO/health helpers.
Default: read-only preflight. --apply writes only the manifest's allowlisted files.
"""
import argparse
from contextlib import ExitStack
from html.parser import HTMLParser
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import re
import sys
import uuid
import zipfile

SPEC = importlib.util.spec_from_file_location('stars_release_helpers', Path(__file__).with_name('publish-stars.py'))
helpers = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(helpers)
ROOT = Path('/opt/wep_pril')
NODE = '/usr/local/bin/node'
CORE = 'backend/auth/stars-core.mjs'
require, digest, read, atomic = helpers.require, helpers.digest, helpers.read, helpers.atomic
run, healthy, unique_json = helpers.run, helpers.healthy, helpers.unique_json


def target(name):
    require(isinstance(name, str), 'INVALID_UI_PATH')
    p = PurePosixPath(name)
    require(name == p.as_posix() and not p.is_absolute() and '\\' not in name and ':' not in name
            and all(part not in ('.', '..', '') and not part.startswith('.') for part in p.parts), 'INVALID_UI_PATH')
    if name == CORE:
        path = ROOT / name
    elif len(p.parts) == 2 and p.parts[0] == 'Фронт' and p.suffix in {'.html', '.js', '.css'}:
        path = ROOT / 'frontend' / p.name
    else:
        raise RuntimeError('UI_PATH_NOT_ALLOWLISTED')
    helpers.safe(path)
    require(path.parent.is_dir(), 'UI_PARENT_REQUIRED')
    return path


def load_bundle(bundle):
    require(Path(bundle).stat().st_size <= 20_000_000, 'UI_ZIP_TOO_LARGE')
    with zipfile.ZipFile(bundle) as archive:
        members = archive.infolist()
        require(1 < len(members) <= 100 and len({i.filename for i in members}) == len(members), 'UI_INVALID_ZIP_MEMBERS')
        require(all(not i.is_dir() and not i.flag_bits & 1 and i.file_size <= 3_000_000
                    and (i.external_attr >> 16) & 0o170000 != 0o120000 for i in members)
                and sum(i.file_size for i in members) <= 20_000_000, 'UI_UNSAFE_ZIP')
        manifest = unique_json(archive.read('manifest.json'))
        require(set(manifest) == {'revision', 'files'} and isinstance(manifest['revision'], str)
                and re.fullmatch('[a-f0-9]{40}', manifest['revision']), 'UI_INVALID_MANIFEST')
        files = manifest['files']
        require(isinstance(files, dict) and files and len(files) <= 99, 'UI_INVALID_FILESET')
        require(set(archive.namelist()) == {'manifest.json', *('payload/' + n for n in files)}, 'UI_INVALID_ZIP_MEMBERS')
        payload = {}
        for name, info in files.items():
            target(name)
            require(isinstance(info, dict) and set(info) == {'before', 'sha256'}
                    and all(isinstance(v, str) and re.fullmatch('[a-f0-9]{64}', v) for v in info.values()), 'UI_REAL_BEFORE_HASH_REQUIRED')
            data = archive.read('payload/' + name)
            require(digest(data) == info['sha256'], 'UI_PAYLOAD_CHECKSUM_FAILED')
            payload[name] = data
        return manifest, payload


def metadata(path):
    value = path.stat()
    return value.st_mode & 0o7777, value.st_uid, value.st_gid


def snapshot(manifest):
    before = {}
    for name, info in manifest['files'].items():
        path = target(name)
        data = read(path)
        require(data is not None and digest(data) == info['before'], 'UI_BEFORE_CHECKSUM_FAILED')
        before[name] = (data, metadata(path))
    return before


def reconcile(before):
    require(all(read(target(n)) == data and metadata(target(n)) == meta for n, (data, meta) in before.items()),
            'UI_CONCURRENT_CHANGE')


class InlineScripts(HTMLParser):
    def __init__(self):
        super().__init__()
        self.scripts, self.current = [], None

    def handle_starttag(self, tag, attrs):
        if tag == 'script':
            values = dict(attrs)
            if 'src' not in values and values.get('type', '') in {'', 'text/javascript', 'application/javascript', 'module'}:
                self.current = []

    def handle_data(self, data):
        if self.current is not None:
            self.current.append(data)

    def handle_endtag(self, tag):
        if tag == 'script' and self.current is not None:
            self.scripts.append(''.join(self.current).encode())
            self.current = None


def syntax_check(payload):
    for name, data in payload.items():
        sources = [data] if name.endswith(('.js', '.mjs')) else []
        if name.endswith('.html'):
            parser = InlineScripts()
            parser.feed(data.decode('utf-8'))
            sources = parser.scripts
        for source in sources:
            run([NODE, '--input-type=module', '--check'], input=source, timeout=15)


def stop_auth():
    run(['systemctl', 'stop', 'wep-pril-auth'], timeout=110)
    fields = dict(line.split('=', 1) for line in run(['systemctl', 'show', 'wep-pril-auth', '-p', 'ActiveState', '-p', 'Result']).stdout.decode().splitlines())
    require(fields == {'ActiveState': 'inactive', 'Result': 'success'}, 'UI_AUTH_STOP_NOT_CLEAN')


def rollback(written, before, payload):
    # Check the whole changed set before restoring any file or metadata.
    require(all(read(target(n)) == payload[n] and metadata(target(n)) == before[n][1] for n in written),
            'UI_ROLLBACK_CONCURRENT_CHANGE')
    for name in reversed(written):
        data, (mode, uid, gid) = before[name]
        atomic(target(name), data, mode=mode, owner=(uid, gid))


def apply_release(manifest, payload, before, stage):
    stage.mkdir(mode=0o700)
    stage.chmod(0o700)
    (stage / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False), encoding='utf-8')
    restore = {}
    for index, (name, (data, meta)) in enumerate(before.items()):
        (stage / str(index)).write_bytes(data)
        restore[name] = {'backup': str(index), 'metadata': meta, 'before': digest(data), 'after': digest(payload[name])}
    (stage / 'restore-map.json').write_text(json.dumps(restore, ensure_ascii=False), encoding='utf-8')
    reconcile(before)
    needs_auth = CORE in payload and payload[CORE] != before[CORE][0]
    written, stop_attempted = [], False
    try:
        if needs_auth:
            stop_attempted = True
            stop_auth()
        reconcile(before)
        # Scripts/styles before HTML; unchanged files need no write.
        for name in sorted(payload, key=lambda n: n.endswith('.html')):
            if payload[name] == before[name][0]:
                continue
            path = target(name)
            require(read(path) == before[name][0] and metadata(path) == before[name][1], 'UI_CONCURRENT_CHANGE')
            mode, uid, gid = before[name][1]
            atomic(path, payload[name], mode=mode, owner=(uid, gid))
            written.append(name)
        if needs_auth:
            run(['systemctl', 'start', 'wep-pril-auth'])
        healthy()
        require(all(read(target(n)) == data and metadata(target(n)) == before[n][1] for n, data in payload.items()), 'UI_FINAL_CHECKSUM_FAILED')
    except BaseException:
        try:
            if stop_attempted:
                stop_auth()
            rollback(written, before, payload)
            if stop_attempted:
                run(['systemctl', 'start', 'wep-pril-auth'])
            healthy()
            (stage / 'rollback-result').write_text('Only release files restored; no database changes\n')
        except BaseException:
            (stage / 'fix-forward-required').write_text('Concurrent change or failed restart; inspect before recovery\n')
            raise RuntimeError('UI_ROLLBACK_INCOMPLETE') from None
        raise RuntimeError('UI_RELEASE_ROLLED_BACK') from None
    print('STARS_UI_RELEASE_OK revision=' + manifest['revision'] + ' backup=' + str(stage), flush=True)


def inspect(names):
    require(isinstance(names, list) and names and all(isinstance(n, str) for n in names)
            and len(set(names)) == len(names), 'UI_INVALID_INSPECT_LIST')
    hashes = {n: digest(read(target(n))) for n in names}
    require(all(hashes.values()), 'UI_EXISTING_FILES_REQUIRED')
    return {'files': hashes}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('bundle', nargs='?')
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--inspect', help='JSON path list; prints existing file hashes only')
    args = parser.parse_args()
    require(os.name == 'posix' and os.geteuid() == 0, 'UI_ROOT_ON_TIMEWEB_REQUIRED')
    os.umask(0o077)
    if args.inspect:
        require(not args.bundle and not args.apply, 'UI_INVALID_INSPECT_OPTIONS')
        print(json.dumps(inspect(unique_json(Path(args.inspect).read_bytes())), ensure_ascii=False))
        return
    require(bool(args.bundle), 'UI_BUNDLE_REQUIRED')
    import fcntl
    with ExitStack() as stack:
        for name in ['stars', 'club', 'ai', 'personal']:
            lock = stack.enter_context(open('/run/lock/wep-pril-' + name + '-release.lock', 'w'))
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        manifest, payload = load_bundle(args.bundle)
        syntax_check(payload)
        healthy()
        if all(read(target(n)) == data for n, data in payload.items()):
            print('STARS_UI_ALREADY_INSTALLED revision=' + manifest['revision'])
            return
        before = snapshot(manifest)
        if not args.apply:
            reconcile(before)
            print('STARS_UI_PREFLIGHT_OK revision=' + manifest['revision'])
            return
        stage = ROOT / ('stars-ui-release-' + uuid.uuid4().hex)
        apply_release(manifest, payload, before, stage)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        code = str(error) if isinstance(error, RuntimeError) and re.fullmatch('[A-Z_]+', str(error)) else 'UI_RELEASE_FAILED'
        print(code, file=sys.stderr)
        sys.exit(1)
