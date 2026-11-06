"""Hash-pinned Timeweb Lara conversation release; no DO/nginx/environment changes.
Usage: python3 publish-lara-conversations.py /root/release.zip [--apply]
Preflight creates only a fresh marked test database and synthetic QA files.
Apply requires fresh backup+isolated restore before bounded additive migration.
After frontend activation backend rollback is prohibited; static rollback only.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import sys
import time
import urllib.parse
import urllib.request
import uuid
import zipfile

ROOT = Path('/opt/wep_pril')
BACKEND = {'ai-chat.mjs', 'http.mjs', 'main.mjs', 'migrate.mjs', 'ai-conversations-migration.sql'}
ROOT_BACKEND = set()
FRONTEND = {'ai.html', 'ai.css', 'ai.js'}
QA = {'auth-pool.mjs', 'ai-chat.test.mjs'}
NEW_FILES = {'backend/auth/ai-conversations-migration.sql'}
INSTALLED_SQL = {'schema.sql', 'single-session-migration.sql', 'ai-chat-migration.sql', 'ai-failure-migration.sql'}
FILES = {'backend/auth/' + n for n in BACKEND} | {'Фронт/' + n for n in FRONTEND}
OPTIONAL_FRONTEND = {'ai-conversations.js'}
OPTIONAL_QA = {'ai-conversations.test.mjs', 'ai-conversations-migration.test.mjs'}




def digest(data):
    return hashlib.sha256(data).hexdigest() if data is not None else None


def run(args, **options):
    return subprocess.run(args, check=True, capture_output=True,
                          timeout=options.pop('timeout', 120), **options)


def target(name):
    if name.startswith('backend/auth/') and name[13:] in BACKEND:
        path = ROOT / name
    elif name.startswith('backend/') and name[8:] in ROOT_BACKEND:
        path = ROOT / name
    elif name.startswith('Фронт/') and name[6:] in FRONTEND:
        path = ROOT / 'frontend' / name[6:]
    else:
        raise RuntimeError('LARA_CONVERSATIONS_UNEXPECTED_RELEASE_PATH')
    if any(p.is_symlink() for p in (path, *path.parents)) or path.resolve() != path:
        raise RuntimeError('LARA_CONVERSATIONS_UNSAFE_RELEASE_TARGET')
    return path


def atomic(path, data):
    temporary = path.with_name(path.name + '.lara-conv-' + uuid.uuid4().hex)
    metadata = path.stat() if path.exists() else None
    try:
        with temporary.open('xb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, metadata.st_mode & 0o777 if metadata else 0o644)
        if metadata:
            os.chown(temporary, metadata.st_uid, metadata.st_gid)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def healthy():
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    for _ in range(40):
        try:
            with opener.open('http://127.0.0.1:3001/api/auth/session', timeout=3) as response:
                if json.load(response) == {'authenticated': False, 'user': None}:
                    return
        except (OSError, ValueError):
            pass
        time.sleep(.2)
    raise RuntimeError('LARA_CONVERSATIONS_AUTH_HEALTH_FAILED')


def runtime_role():
    for line in Path('/etc/wep-pril/auth.env').read_text().splitlines():
        if line.startswith('AUTH_DATABASE_URL='):
            parts = urllib.parse.urlsplit(shlex.split(line.split('=', 1)[1], comments=False)[0])
            role = urllib.parse.unquote(parts.username or '')
            if (parts.hostname in ('localhost', '127.0.0.1', '::1') and parts.path == '/wep_pril_auth'
                    and re.fullmatch('[a-z_][a-z0-9_]*', role)):
                return role
    raise RuntimeError('LARA_CONVERSATIONS_PRIVATE_DATABASE_CONFIGURATION_REQUIRED')


def postgres_check(archive, manifest, payload, stage):
    import pwd
    # The release overlays current installed auth sources; it does not bring an
    # older schema snapshot or rerun deletion/reaction migrations on production.
    for name in INSTALLED_SQL:
        path = ROOT / 'backend/auth' / name
        if not path.is_file() or any(p.is_symlink() for p in (path, *path.parents)):
            raise RuntimeError('LARA_CONVERSATIONS_INSTALLED_SQL_REQUIRED:' + name)
    suffix = uuid.uuid4().hex
    scratch = Path('/var/lib/postgresql') / ('wep-pril-lara-conv-qa-' + suffix)
    work = scratch / 'backend'
    work.mkdir(parents=True)
    (work / 'auth').mkdir()
    # Copy source dependencies only. No environment, configuration or private data.
    for source in (ROOT / 'backend/auth').iterdir():
        if source.suffix in {'.mjs', '.sql'}:
            if not source.is_file() or source.is_symlink():
                raise RuntimeError('LARA_CONVERSATIONS_UNSAFE_QA_SOURCE')
            shutil.copyfile(source, work / 'auth' / source.name)
    for name in ['course-entitlements.mjs', 'course-materials.mjs', 'course-video-links.mjs']:
        source = ROOT / 'backend' / name
        if not source.is_file() or source.is_symlink():
            raise RuntimeError('LARA_CONVERSATIONS_INSTALLED_DEPENDENCY_REQUIRED:' + name)
        shutil.copyfile(source, work / name)
    shutil.copyfile(ROOT / 'backend/package.json', work / 'package.json')
    (work / 'node_modules').symlink_to(ROOT / 'backend/node_modules', target_is_directory=True)
    (work / 'test').mkdir()
    for name, data in payload.items():
        if name.startswith('backend/'):
            (work / name[8:]).write_bytes(data)
    if set(manifest['qa']) != QA:
        raise RuntimeError('LARA_CONVERSATIONS_INCOMPLETE_QA_FILES')
    for name in QA:
        data = archive.read('qa/' + name)
        if len(data) > 300_000 or digest(data) != manifest['qa'][name]:
            raise RuntimeError('LARA_CONVERSATIONS_QA_CHECKSUM_MISMATCH')
        (work / 'test' / name).write_bytes(data)
    # Stay below PostgreSQL's 63-byte identifier limit, keeping the _test guard.
    database = 'wep_pril_lara_conv_' + suffix + '_test'
    marker = 'webpril-lara-conv-check-' + suffix
    admin = ['runuser', '-u', 'postgres', '--', 'psql', '-XqAt', '-v', 'ON_ERROR_STOP=1', '-d', 'postgres', '-c']
    run(admin + [f'CREATE DATABASE {database} OWNER postgres'])
    try:
        run(admin + [f"COMMENT ON DATABASE {database} IS '{marker}'"])
        postgres = pwd.getpwnam('postgres')
        for path in [scratch, *scratch.rglob('*')]:
            if not path.is_symlink():
                os.chown(path, postgres.pw_uid, postgres.pw_gid)
        env = {'PATH': os.environ.get('PATH', '/usr/local/bin:/usr/bin:/bin'), 'LANG': 'C.UTF-8',
               'HOME': '/var/lib/postgresql',
               'AUTH_TEST_DATABASE_URL': 'postgresql://postgres@localhost/' + database + '?host=%2Fvar%2Frun%2Fpostgresql'}
        result = subprocess.run(['runuser', '-u', 'postgres', '--', 'node', '--test', *['test/' + name for name in sorted(QA) if name.endswith('.test.mjs')]],
                                cwd=work, env=env, capture_output=True, timeout=180)
        (stage / 'postgres-check.log').write_bytes(result.stdout + result.stderr)
        if result.returncode:
            raise RuntimeError('LARA_CONVERSATIONS_POSTGRES_CHECK_FAILED:' + str(stage))
    finally:
        observed = run(admin + [f"SELECT shobj_description(oid,'pg_database') FROM pg_database WHERE datname='{database}'"]).stdout.decode().strip()
        if observed != marker or not re.fullmatch('wep_pril_lara_conv_[a-f0-9]{32}_test', database):
            raise RuntimeError('LARA_CONVERSATIONS_TEMPORARY_DATABASE_MARKER_MISMATCH')
        run(admin + [f'DROP DATABASE {database}'])
        if scratch.parent == Path('/var/lib/postgresql') and re.fullmatch('wep-pril-lara-conv-qa-[a-f0-9]{32}', scratch.name):
            shutil.rmtree(scratch)
    print('LARA_CONVERSATIONS_POSTGRES_CHECK_OK', flush=True)


def read_archive(archive):
    expected = {'manifest.json'} | {'payload/' + name for name in FILES} | {'qa/' + name for name in QA}
    if set(archive.namelist()) != expected or len(archive.namelist()) != len(expected):
        raise RuntimeError('LARA_CONVERSATIONS_INVALID_ARCHIVE_MEMBERS')
    if any(info.file_size > 300_000 for info in archive.infolist()):
        raise RuntimeError('LARA_CONVERSATIONS_ARCHIVE_MEMBER_TOO_LARGE')
    manifest = json.loads(archive.read('manifest.json'))
    if not re.fullmatch('[a-f0-9]{40}', manifest.get('revision', '')):
        raise RuntimeError('LARA_CONVERSATIONS_PINNED_REVISION_REQUIRED')
    if set(manifest.get('files', {})) != FILES or set(manifest.get('qa', {})) != QA:
        raise RuntimeError('LARA_CONVERSATIONS_INCOMPLETE_RELEASE')
    before, payload = {}, {}
    for name, info in manifest['files'].items():
        path = target(name)
        before[name] = path.read_bytes() if path.exists() else None
        if before[name] is None and name not in NEW_FILES:
            raise RuntimeError('LARA_CONVERSATIONS_INSTALLED_FILE_REQUIRED:' + name)
        payload[name] = archive.read('payload/' + name)
        if digest(before[name]) != info['before'] or digest(payload[name]) != info['sha256']:
            raise RuntimeError('LARA_CONVERSATIONS_SOURCE_MISMATCH:' + name)
    for name in QA:
        if digest(archive.read('qa/' + name)) != manifest['qa'][name]:
            raise RuntimeError('LARA_CONVERSATIONS_QA_CHECKSUM_MISMATCH:' + name)
    return manifest, before, payload


def verify_backup():
    backup_output = run(['python3', str(ROOT / 'deploy/backup.py')], timeout=1800).stdout.decode().strip()
    backup = Path(backup_output.splitlines()[-1])
    if backup.resolve().parent != (ROOT / 'backups').resolve() or not (backup / 'complete').is_file():
        raise RuntimeError('LARA_CONVERSATIONS_COMPLETE_BACKUP_REQUIRED')
    run(['python3', str(ROOT / 'deploy/verify-backup.py'), str(backup)], timeout=1800)
    print('LARA_CONVERSATIONS_BACKUP_RESTORE_VERIFIED', flush=True)
    return backup


def migrate(payload):
    sql = ("BEGIN; SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s'; SET LOCAL ROLE wep_pril_auth_owner;\n"
           + payload['backend/auth/ai-conversations-migration.sql'].decode('utf-8') + '\nCOMMIT;')
    run(['runuser', '-u', 'postgres', '--', 'psql', '-XqAt', '-v', 'ON_ERROR_STOP=1', '-d', 'wep_pril_auth'], input=sql.encode())
    role = runtime_role()
    probe = f"""BEGIN; SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='10s'; SET LOCAL ROLE {role};
SELECT id,user_id,title,title_expires_at,legacy,created_at,updated_at FROM ai_chat_conversations LIMIT 0;
SELECT conversation_id FROM ai_chat_requests LIMIT 0;
UPDATE ai_chat_conversations SET title=title WHERE false;
UPDATE ai_chat_requests SET conversation_id=conversation_id WHERE false;
DO $probe$ DECLARE synthetic_user uuid:=gen_random_uuid(); synthetic_request uuid:=gen_random_uuid(); synthetic_conversation uuid;
BEGIN
  INSERT INTO auth_users(id,email,getcourse_id) VALUES(synthetic_user,synthetic_user::text||'@example.invalid',4611686018427387904+floor(random()*1000000000)::bigint);
  INSERT INTO ai_chat_requests(user_id,request_id,question,question_hash,rights_hash,status)
    VALUES(synthetic_user,synthetic_request,'Synthetic release privilege probe','probe','probe','failed');
  SELECT conversation_id INTO synthetic_conversation FROM ai_chat_requests WHERE user_id=synthetic_user AND request_id=synthetic_request;
  IF NOT EXISTS(SELECT 1 FROM ai_chat_conversations WHERE id=synthetic_conversation AND user_id=synthetic_user AND legacy) THEN
    RAISE EXCEPTION 'synthetic legacy trigger failed';
  END IF;
END $probe$;
SELECT bool_and(has_table_privilege(current_user,'ai_chat_conversations',p))::int FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) p;
ROLLBACK;"""
    result=run(['runuser', '-u', 'postgres', '--', 'psql', '-XqAt', '-v', 'ON_ERROR_STOP=1', '-d', 'wep_pril_auth'], input=probe.encode())
    if result.stdout.decode().splitlines().count('1') != 1:
        raise RuntimeError('LARA_CONVERSATIONS_RUNTIME_PRIVILEGE_FAILED')
    print('LARA_CONVERSATIONS_RUNTIME_ROLE_PROBE_OK', flush=True)


def configure(manifest):
    global FILES, FRONTEND, QA, NEW_FILES
    files=set(manifest.get('files',{})); qa=set(manifest.get('qa',{}))
    required={'backend/auth/'+n for n in BACKEND}|{'Фронт/'+n for n in {'ai.html','ai.css','ai.js'}}
    extras=files-required
    if not required <= files or not extras <= {'Фронт/'+n for n in OPTIONAL_FRONTEND}:
        raise RuntimeError('LARA_CONVERSATIONS_UNEXPECTED_FILESET')
    if not {'auth-pool.mjs','ai-chat.test.mjs'} <= qa or not qa <= {'auth-pool.mjs','ai-chat.test.mjs'}|OPTIONAL_QA:
        raise RuntimeError('LARA_CONVERSATIONS_UNEXPECTED_QA_SET')
    FILES=files; FRONTEND={'ai.html','ai.css','ai.js'}|{n[6:] for n in extras}; QA=qa
    NEW_FILES={'backend/auth/ai-conversations-migration.sql'}|extras


def no_new_chat_writes():
    result=run(['runuser','-u','postgres','--','psql','-XqAt','-v','ON_ERROR_STOP=1','-d','wep_pril_auth','-c',
      'SELECT EXISTS(SELECT 1 FROM ai_chat_requests r JOIN ai_chat_conversations c ON c.id=r.conversation_id AND c.user_id=r.user_id WHERE NOT c.legacy)::int'])
    return result.stdout.decode().strip()=='0'


def ai_snapshot():
    # Aggregate structural metadata only; no questions, answers or user IDs leave PG.
    sql="""SELECT json_build_object('requests',count(*),'accounts',count(DISTINCT user_id),
        'pending',count(*) FILTER(WHERE status='pending'),'minId',min(id),'maxId',max(id),
        'metadataHash',md5(COALESCE(string_agg(concat_ws('|',id::text,user_id::text,request_id::text,status,accepted_at::text,question_hash,rights_hash,COALESCE(failure_code,'')),E'\\n' ORDER BY id),''))) FROM ai_chat_requests;
      SELECT json_build_object('usageRows',count(*),'used',COALESCE(sum(used),0),
        'metadataHash',md5(COALESCE(string_agg(concat_ws('|',user_id::text,day_moscow::text,used::text),E'\\n' ORDER BY user_id,day_moscow),''))) FROM ai_chat_daily_usage;"""
    output=run(['runuser','-u','postgres','--','psql','-XqAt','-v','ON_ERROR_STOP=1','-d','wep_pril_auth','-c',sql]).stdout.decode()
    rows=[json.loads(line) for line in output.splitlines() if line]
    if len(rows)!=2:raise RuntimeError('LARA_CONVERSATIONS_SNAPSHOT_INVALID')
    return rows


def reconcile(before):
    for name,data in before.items():
        path=target(name)
        if (path.read_bytes() if path.exists() else None)!=data:
            raise RuntimeError('LARA_CONVERSATIONS_CONCURRENT_CHANGE:'+name)


def service(action):
    # Existing systemd graceful SIGTERM timeout is 90sec; never force-kill ourselves.
    run(['systemctl',action,'wep-pril-auth'],timeout=100)


def apply_release(manifest,before,payload,stage):
    backup=verify_backup()
    for i,(name,data) in enumerate(before.items()):
        if data is not None: (stage/str(i)).write_bytes(data)
    (stage/'database-backup-path').write_text(str(backup),encoding='utf-8')
    reconcile(before)
    written=[]; activated=False; migrated=False; started=False
    try:
        print('LARA_CONVERSATIONS_DRAINING_AUTH',flush=True)
        service('stop')
        result=run(['systemctl','show','wep-pril-auth','-p','ActiveState','-p','Result'])
        fields=dict(line.split('=',1) for line in result.stdout.decode().splitlines() if '=' in line)
        if fields.get('ActiveState')!='inactive' or fields.get('Result')!='success':
            raise RuntimeError('LARA_CONVERSATIONS_AUTH_STOP_NOT_CLEAN')
        reconcile(before)
        snapshot=ai_snapshot()
        (stage/'ai-metadata-before.json').write_text(json.dumps(snapshot,indent=2))
        migrate(payload); migrated=True
        after=ai_snapshot()
        (stage/'ai-metadata-after.json').write_text(json.dumps(after,indent=2))
        if after!=snapshot:raise RuntimeError('LARA_CONVERSATIONS_MIGRATION_METADATA_CHANGED')
        for name in sorted(n for n in payload if n.startswith('backend/')):
            atomic(target(name),payload[name]); written.append(name)
        service('start'); started=True; healthy()
        # Persist the rollback boundary BEFORE the first static write. Other tabs
        # may already fetch a new .js file even before HTML's cache-buster changes.
        activated=True
        (stage/'frontend-activation-started').write_text('1\n')
        for name in sorted((n for n in payload if n.startswith('Фронт/')),key=lambda n:n.endswith('.html')):
            if (target(name).read_bytes() if target(name).exists() else None)!=before[name]:
                raise RuntimeError('LARA_CONVERSATIONS_CONCURRENT_CHANGE:'+name)
            atomic(target(name),payload[name]); written.append(name)
        healthy()
        run(['systemctl','is-active','wep-pril-auth','wep-pril'])
        if any(digest(target(n).read_bytes())!=manifest['files'][n]['sha256'] for n in payload):
            raise RuntimeError('LARA_CONVERSATIONS_FINAL_CHECKSUM_MISMATCH')
    except BaseException:
        # Stop new requests before checking the only permitted old-backend rollback.
        # After activation (even partial) keep all new backend files and schema.
        if activated:
            rollback=[n for n in reversed(written) if n.startswith('Фронт/')]
        else:
            service('stop')
            if migrated and not no_new_chat_writes():
                (stage/'fix-forward-required').write_text('nonlegacy data exists\n')
                service('start')
                raise RuntimeError('LARA_CONVERSATIONS_FIX_FORWARD_REQUIRED') from None
            rollback=list(reversed(written))
        for name in rollback:
            path=target(name)
            if (path.read_bytes() if path.exists() else None)!=payload[name]:
                raise RuntimeError('LARA_CONVERSATIONS_ROLLBACK_CONCURRENT_CHANGE') from None
            if before[name] is None: path.unlink()
            else: atomic(path,before[name])
        service('start'); healthy()
        (stage/'rollback-kind').write_text('frontend-only\n' if activated else 'preactivation-code\n')
        raise RuntimeError('LARA_CONVERSATIONS_FRONTEND_ROLLED_BACK_BACKEND_RETAINED' if activated else 'LARA_CONVERSATIONS_PREACTIVATION_ROLLED_BACK') from None
    (stage/'installed-checksums.json').write_text(json.dumps({n:{'before':digest(before[n]),'after':digest(target(n).read_bytes())} for n in payload},ensure_ascii=False,indent=2))
    print('LARA_CONVERSATIONS_RELEASE_OK revision='+manifest['revision']+' backup='+str(backup)+' rollback='+str(stage),flush=True)


def main():
    import fcntl
    from contextlib import ExitStack
    os.umask(0o077)
    if os.geteuid()!=0 or len(sys.argv) not in (2,3) or (len(sys.argv)==3 and sys.argv[2]!='--apply'):
        raise RuntimeError('LARA_CONVERSATIONS_ROOT_AND_PRIVATE_ARCHIVE_REQUIRED')
    with ExitStack() as stack:
        for name in ['club','ai']:
            lock=stack.enter_context(open('/run/lock/wep-pril-'+name+'-release.lock','w'))
            fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        with zipfile.ZipFile(sys.argv[1]) as archive:
            configure(json.loads(archive.read('manifest.json')))
            manifest,before,payload=read_archive(archive)
            healthy()
            for name,data in payload.items():
                if name.endswith(('.js','.mjs')): run(['node','--input-type=module','--check'],input=data)
            stage=Path('/root')/('wep-pril-lara-conv-release-'+str(time.time_ns()))
            stage.mkdir(mode=0o700)
            (stage/'manifest.json').write_text(json.dumps(manifest))
            postgres_check(archive,manifest,payload,stage)
        if len(sys.argv)==2:
            print('LARA_CONVERSATIONS_PREFLIGHT_OK',flush=True);return
        apply_release(manifest,before,payload,stage)


if __name__=='__main__':
    try: main()
    except Exception as error:
        # No stderr SQL/config/provider payloads; diagnostics remain private.
        code=str(error) if isinstance(error,RuntimeError) and re.fullmatch(r'[A-Z_]+(?::[A-Za-z0-9_./-]+)?',str(error)) else 'LARA_CONVERSATIONS_RELEASE_FAILED_CHECK_PRIVATE_STAGE'
        print(code,file=sys.stderr);sys.exit(1)
