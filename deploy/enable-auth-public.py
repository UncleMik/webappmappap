#!/usr/bin/env python3
"""Permanently enable the tested auth service without changing credentials."""

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import time

SUPPORT = Path('/root/wep-pril-auth-browser-e5a6e570c6b7.py')
SUPPORT_SHA = 'e5a6e570c6b789982d3932aabc8a791d54a3b2d05b6aa136881f6f9f1ca82e7c'
BACKUPS = Path('/root/wep-pril-auth-public-backups')
FLAG = re.compile(rb'(?m)^[ \t]*(?:export[ \t]+)?AUTH_ENABLED[ \t]*=[^\r\n]*')


def enabled_environment(data):
    matches = list(FLAG.finditer(data))
    if len(matches) > 1:
        raise RuntimeError('Ambiguous enabled flag')
    if not matches:
        return data + (b'' if data.endswith(b'\n') else b'\n') + b'AUTH_ENABLED=true\n'
    match = matches[0]
    if not re.fullmatch(rb'[ \t]*(?:export[ \t]+)?AUTH_ENABLED[ \t]*=[ \t]*(?:true|false)[ \t]*', match.group()):
        raise RuntimeError('Unexpected enabled flag')
    return data[:match.start()] + b'AUTH_ENABLED=true' + data[match.end():]


def load_support():
    if SUPPORT.is_symlink() or hashlib.sha256(SUPPORT.read_bytes()).hexdigest() != SUPPORT_SHA:
        raise RuntimeError('Unexpected support script')
    spec = importlib.util.spec_from_file_location('auth_enable_support', SUPPORT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def assert_no_temporary_check(qa):
    if any(path.exists() or path.is_symlink() for path in (qa.RUN_ENV, qa.DROPIN)):
        raise RuntimeError('Temporary override remains')
    if qa.QA_ROOT.is_symlink():
        raise RuntimeError('Unexpected check directory')
    for path in qa.QA_ROOT.glob('*/state.json'):
        if path.is_symlink() or not json.loads(path.read_text(encoding='utf-8')).get('closed'):
            raise RuntimeError('Temporary check is not closed')
    # Validate the current auth route, including absence of allow/deny/include.
    # The generated guard is discarded: this operation never modifies Nginx.
    qa.add_guard(qa.NGINX_FILE.read_text(encoding='utf-8'), '127.0.0.1', '0' * 32)
    result = qa.run('/usr/bin/systemctl', 'list-units', '--type=timer', '--state=active',
                    '--no-legend', '--no-pager')
    if re.search(rb'wep-pril-auth-browser-[0-9]+\.timer', result.stdout):
        raise RuntimeError('Temporary close timer is still active')


def check_database(qa):
    source = ("import {readConfig,openPool} from './auth/config.mjs';let pool;"
              "try{pool=openPool(readConfig());"
              "await pool.query('SELECT 1 FROM auth_users LIMIT 0');"
              "await pool.query('SELECT 1 FROM auth_sessions LIMIT 0');}"
              "catch{process.exitCode=1;}finally{await pool?.end();}")
    qa.run('/usr/local/bin/node', '--env-file=' + str(qa.ENV_FILE), '--input-type=module',
           '-e', source, cwd=qa.BACKEND,
           env={'PATH': '/usr/local/bin:/usr/bin:/bin', 'LANG': 'C.UTF-8'})


class ActivationFailure(RuntimeError):
    def __init__(self, stage, rollback):
        super().__init__('Public activation failed')
        self.stage = stage
        self.rollback = rollback


def check_secret_file(qa):
    if os.geteuid() != 0:
        raise RuntimeError('Root is required')
    metadata = qa.ENV_FILE.stat()
    if qa.ENV_FILE.is_symlink() or metadata.st_uid != 0 or stat.S_IMODE(metadata.st_mode) != 0o600:
        raise RuntimeError('Unexpected secret file permissions')


def activate(qa):
    check_secret_file(qa)
    assert_no_temporary_check(qa)
    original = qa.ENV_FILE.read_bytes()
    candidate = enabled_environment(original)
    state = qa.run('/usr/bin/systemctl', 'show', qa.SERVICE,
                   '--property=UnitFileState', '--value').stdout.strip()
    if state not in (b'enabled', b'disabled'):
        raise RuntimeError('Unexpected boot configuration')
    was_enabled = state == b'enabled'
    if candidate == original:
        check_database(qa)
        qa.wait_for_session(True)
        qa.run('/usr/bin/systemctl', 'enable', qa.SERVICE)
        qa.run('/usr/bin/systemctl', 'is-enabled', '--quiet', qa.SERVICE)
        return None
    qa.preflight()
    check_database(qa)
    if BACKUPS.is_symlink() or BACKUPS.resolve() != BACKUPS.absolute():
        raise RuntimeError('Unexpected backup directory')
    BACKUPS.mkdir(mode=0o700, exist_ok=True)
    os.chmod(BACKUPS, 0o700)
    backup = BACKUPS / ('auth.env-' + str(time.time_ns()))
    qa.atomic_write(backup, original, 0o600)
    stage = 'WRITE_FLAG'
    changed = False
    try:
        if qa.ENV_FILE.read_bytes() != original:
            raise RuntimeError('Configuration changed before activation')
        qa.atomic_write(qa.ENV_FILE, candidate, 0o600)
        changed = True
        stage = 'RESTART_SERVICE'
        qa.run('/usr/bin/systemctl', 'restart', qa.SERVICE)
        stage = 'CHECK_SESSION'
        qa.wait_for_session(True)
        stage = 'CHECK_DATABASE'
        check_database(qa)
        stage = 'ENABLE_AT_BOOT'
        qa.run('/usr/bin/systemctl', 'enable', qa.SERVICE)
        qa.run('/usr/bin/systemctl', 'is-enabled', '--quiet', qa.SERVICE)
    except Exception as error:
        rollback = 'NOT_NEEDED'
        try:
            if changed:
                if qa.ENV_FILE.read_bytes() != candidate:
                    raise RuntimeError('Concurrent configuration change')
                qa.atomic_write(qa.ENV_FILE, original, 0o600)
                qa.run('/usr/bin/systemctl', 'restart', qa.SERVICE)
                qa.wait_for_session(False)
                if not was_enabled:
                    qa.run('/usr/bin/systemctl', 'disable', qa.SERVICE)
                rollback = 'CLOSED'
        except Exception:
            subprocess.run(['/usr/bin/systemctl', 'stop', qa.SERVICE],
                           capture_output=True, timeout=15, check=False)
            subprocess.run(['/usr/bin/systemctl', 'disable', qa.SERVICE],
                           capture_output=True, timeout=15, check=False)
            rollback = 'SERVICE_STOPPED_REVIEW_REQUIRED'
        raise ActivationFailure(stage, rollback) from error
    return backup


if __name__ == '__main__':
    qa = None
    try:
        qa = load_support()
        backup = activate(qa)
        print('AUTH_PUBLIC_ENABLED_OK' if backup else 'AUTH_PUBLIC_ALREADY_ENABLED_OK')
        if backup:
            print('BACKUP_FILE=' + str(backup))
        print('BOOT_AUTOSTART_ENABLED; NO_TEMPORARY_IP_GUARD_OR_CLOSE_TIMER')
    except Exception as error:
        print('AUTH_PUBLIC_ENABLE_FAILED; NO_SECRETS_PRINTED')
        if isinstance(error, ActivationFailure):
            print('STAGE=' + error.stage)
            print('ROLLBACK=' + error.rollback)
        if qa:
            print(qa.failure_report(error))
        raise SystemExit(1)
