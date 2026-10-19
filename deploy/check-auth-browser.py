#!/usr/bin/env python3
"""Temporarily test the real auth service behind an IP guard and a close timer."""

import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import time
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from urllib.error import HTTPError
from urllib.request import ProxyHandler, build_opener

BACKEND = Path('/opt/wep_pril/backend')
ENV_FILE = Path('/etc/wep-pril/auth.env')
NGINX_FILE = Path('/etc/nginx/sites-available/wep-pril-domain')
ACCESS_LOG = Path('/var/log/nginx/access.log')
QA_ROOT = Path('/root/wep-pril-auth-browser-check')
RUN_ENV = Path('/run/wep-pril-auth-browser-check.env')
DROPIN = Path('/run/systemd/system/wep-pril-auth.service.d/90-browser-check.conf')
RUN_ENV_CONTENT = b'# Temporary browser check; disappears after reboot\nAUTH_ENABLED=true\n'
DROPIN_CONTENT = b'[Service]\nEnvironmentFile=/run/wep-pril-auth-browser-check.env\n'
PROVIDER_SHA = '123b4d887a988c3c1a94b2f7670eee46bec16ed8ca691b5a22ee0c8fc0d94107'
SERVICE = 'wep-pril-auth'
MARKER = '# WEBPRIL_AUTH_BROWSER_CHECK'
LOCAL_HTTP = build_opener(ProxyHandler({}))


def run(*args, **kwargs):
    return subprocess.run(args, check=True, capture_output=True, timeout=25, **kwargs)


def atomic_write(path, data, mode=None):
    if path.is_symlink():
        raise RuntimeError('Symlink target is not supported')
    metadata = path.stat() if path.exists() else None
    if metadata and not stat.S_ISREG(metadata.st_mode):
        raise RuntimeError('Expected a regular file')
    stage = path.with_name('.' + path.name + '.auth-check-' + str(time.time_ns()))
    try:
        descriptor = os.open(stage, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(descriptor, 'wb') as output:
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        os.chmod(stage, mode if mode is not None else stat.S_IMODE(metadata.st_mode) if metadata else 0o600)
        if metadata and hasattr(os, 'chown'):
            os.chown(stage, metadata.st_uid, metadata.st_gid)
        os.replace(stage, path)
    finally:
        stage.unlink(missing_ok=True)


def enable_runtime():
    if RUN_ENV.exists() or DROPIN.exists() or RUN_ENV.is_symlink() or DROPIN.is_symlink():
        raise RuntimeError('Unexpected runtime override')
    DROPIN.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
    atomic_write(RUN_ENV, RUN_ENV_CONTENT, 0o600)
    atomic_write(DROPIN, DROPIN_CONTENT, 0o644)
    run('/usr/bin/systemctl', 'daemon-reload')


def disable_runtime():
    for path, expected in ((DROPIN, DROPIN_CONTENT), (RUN_ENV, RUN_ENV_CONTENT)):
        if path.is_symlink():
            raise RuntimeError('Unexpected runtime symlink')
        if path.exists():
            if path.read_bytes() != expected:
                raise RuntimeError('Runtime override changed')
            path.unlink()
    run('/usr/bin/systemctl', 'daemon-reload')


def add_guard(text, address, nonce):
    if MARKER in text:
        raise RuntimeError('A browser check is already configured')
    pattern = re.compile(r'(?m)^([ \t]*)location\s+\^~\s+/api/auth/\s*\{[ \t]*$')
    matches = list(pattern.finditer(text))
    if len(matches) != 1:
        raise RuntimeError('Expected exactly one auth location')
    match = matches[0]
    end = re.search(r'(?m)^' + re.escape(match.group(1)) + r'\}[ \t]*$', text[match.end():])
    if not end:
        raise RuntimeError('Auth location is not closed')
    block = text[match.end():match.end() + end.start()]
    if 'proxy_pass http://127.0.0.1:3001;' not in block or re.search(r'(?m)^\s*(?:allow|deny|include)\s', block):
        raise RuntimeError('Unexpected existing auth configuration')
    indent = match.group(1) + '    '
    guard = ('\n' + indent + MARKER + ' ' + nonce + ' BEGIN\n'
             + indent + 'allow ' + str(ipaddress.ip_address(address)) + ';\n'
             + indent + 'deny all;\n'
             + indent + MARKER + ' ' + nonce + ' END\n')
    return text[:match.end()] + guard + text[match.end():], guard


def probe_address(log_text, nonce, now):
    if not re.fullmatch(r'[a-f0-9]{32}', nonce):
        raise RuntimeError('Invalid browser probe')
    needle = '"GET /api/auth/session?qa=' + nonce + ' HTTP/'
    addresses = set()
    for line in log_text.splitlines():
        if needle not in line:
            continue
        match = re.match(r'^(\S+) .*?\[([^\]]+)\]', line)
        if not match:
            continue
        timestamp = parsedate_to_datetime(match.group(2).replace('/', ' ').replace(':', ' ', 1))
        age = (now - timestamp).total_seconds()
        address = ipaddress.ip_address(match.group(1))
        if -60 <= age <= 20 * 60 and address.is_global:
            addresses.add(str(address))
    if len(addresses) != 1:
        raise RuntimeError('Expected one recent browser address')
    return addresses.pop()


def read_probe_address(nonce):
    with ACCESS_LOG.open('rb') as source:
        source.seek(0, os.SEEK_END)
        source.seek(max(0, source.tell() - 4 * 1024 * 1024))
        text = source.read().decode('utf-8', errors='replace')
    return probe_address(text, nonce, datetime.now(timezone.utc))


def session_state(enabled):
    try:
        with LOCAL_HTTP.open('http://127.0.0.1:3001/api/auth/session', timeout=2) as response:
            result = json.load(response)
            return enabled and response.status == 200 and result.get('authenticated') is False and result.get('user') is None
    except HTTPError as error:
        result = json.load(error)
        return (not enabled and error.code == 503 and result.get('error') == 'auth_unavailable'
                and result.get('message') == 'Вход ещё не подключён. Попробуйте позже.')
    except (OSError, ValueError):
        return False


def wait_for_session(enabled):
    for _ in range(20):
        if session_state(enabled):
            return
        time.sleep(0.25)
    raise RuntimeError('Unexpected auth response')


def nginx_reload():
    run('/usr/sbin/nginx', '-t')
    run('/usr/bin/systemctl', 'reload', 'nginx')


def check_loopback_denied():
    # A successful reload command does not wait for the new workers to serve.
    # Keep auth disabled while polling new connections for the actual denial.
    for attempt in range(20):
        result = run('/usr/bin/curl', '--noproxy', '*', '--resolve',
                     'app.legkie-rody.ru:443:127.0.0.1', '-sS', '--max-time', '2',
                     '-o', '/dev/null', '-w', '%{http_code}',
                     'https://app.legkie-rody.ru/api/auth/session')
        if result.stdout.strip() == b'403':
            return
        if attempt < 19:
            time.sleep(0.25)
    raise RuntimeError('IP guard was not confirmed')


def failure_report(error):
    """Only fixed labels, own code locations and numeric command exit status."""
    lines = ['AUTH_BROWSER_CHECK_FAILED: keep login closed; no secrets printed']
    seen = set()
    for _ in range(3):
        if error is None or id(error) in seen:
            break
        seen.add(id(error))
        if isinstance(error, subprocess.CalledProcessError):
            lines.append('ERROR_KIND=COMMAND_FAILED')
            lines.append('COMMAND_EXIT=' + str(int(error.returncode)))
        elif isinstance(error, subprocess.TimeoutExpired):
            lines.append('ERROR_KIND=COMMAND_TIMEOUT')
        elif isinstance(error, OSError):
            lines.append('ERROR_KIND=OS_ERROR')
            if isinstance(error.errno, int):
                lines.append('OS_ERRNO=' + str(error.errno))
        else:
            lines.append('ERROR_KIND=CHECK_FAILED')
        current = error.__traceback__
        while current:
            frame = current.tb_frame
            if frame.f_code.co_filename == __file__:
                lines.append('AT=' + frame.f_code.co_name + ':' + str(current.tb_lineno))
            current = current.tb_next
        error = error.__context__
    return '\n'.join(lines)


def save_state(path, state):
    atomic_write(path, (json.dumps(state) + '\n').encode('utf-8'), 0o600)


def close_check(state_path):
    state_path = state_path.resolve(strict=True)
    if state_path.parent.parent != QA_ROOT.resolve() or state_path.name != 'state.json':
        raise RuntimeError('Unexpected check state path')
    state = json.loads(state_path.read_text(encoding='utf-8'))
    if state.get('closed'):
        return
    try:
        disable_runtime()
        run('/usr/bin/systemctl', 'restart', SERVICE)
        wait_for_session(False)
        current = NGINX_FILE.read_text(encoding='utf-8')
        guard = state['guard']
        if current.count(guard) == 1:
            atomic_write(NGINX_FILE, current.replace(guard, '', 1).encode('utf-8'))
            try:
                nginx_reload()
            except Exception:
                atomic_write(NGINX_FILE, current.encode('utf-8'))
                raise
        elif MARKER in current:
            raise RuntimeError('Guard changed; auth remains disabled')
        state['closed'] = True
        save_state(state_path, state)
        subprocess.run(['/usr/bin/systemctl', 'stop', state['unit'] + '.timer'],
                       capture_output=True, timeout=15, check=False)
    except Exception:
        # Keep the existing IP guard and stop the listener if closing fails.
        subprocess.run(['/usr/bin/systemctl', 'stop', SERVICE],
                       capture_output=True, timeout=15, check=False)
        raise


def preflight():
    if os.geteuid() != 0:
        raise RuntimeError('Root is required')
    metadata = ENV_FILE.stat()
    if metadata.st_uid != 0 or stat.S_IMODE(metadata.st_mode) != 0o600:
        raise RuntimeError('Unexpected secret file permissions')
    if any(path.resolve() != path.absolute() for path in (RUN_ENV, DROPIN)):
        raise RuntimeError('Unexpected runtime path redirection')
    if RUN_ENV.exists() or DROPIN.exists() or RUN_ENV.is_symlink() or DROPIN.is_symlink():
        raise RuntimeError('A runtime override already exists')
    run('/usr/local/bin/node', '--env-file=' + str(ENV_FILE), '--input-type=module', '-e',
        "import {readConfig} from './auth/config.mjs'; process.exit(readConfig().enabled ? 2 : 0)",
        cwd=BACKEND, env={'PATH': '/usr/local/bin:/usr/bin:/bin', 'LANG': 'C.UTF-8'})
    if not session_state(False):
        raise RuntimeError('Expected working auth listener with login disabled')
    if hashlib.sha256((BACKEND / 'auth/providers.mjs').read_bytes()).hexdigest() != PROVIDER_SHA:
        raise RuntimeError('Unexpected auth provider version')


def start_check(nonce):
    preflight()
    address = read_probe_address(nonce)
    original = NGINX_FILE.read_text(encoding='utf-8')
    guarded, guard = add_guard(original, address, nonce)
    if QA_ROOT.is_symlink():
        raise RuntimeError('Unexpected runtime directory')
    QA_ROOT.mkdir(mode=0o700, exist_ok=True)
    os.chmod(QA_ROOT, 0o700)
    directory = QA_ROOT / str(time.time_ns())
    directory.mkdir(mode=0o700)
    atomic_write(directory / 'nginx.before', original.encode('utf-8'), 0o600)
    unit = 'wep-pril-auth-browser-' + directory.name
    state_path = directory / 'state.json'
    save_state(state_path, {'guard': guard, 'unit': unit, 'closed': False})
    try:
        atomic_write(NGINX_FILE, guarded.encode('utf-8'))
        nginx_reload()
        check_loopback_denied()
        run('/usr/bin/systemd-run', '--unit=' + unit, '--on-active=15m',
            '--timer-property=AccuracySec=1s', sys.executable, str(Path(__file__).resolve()),
            '--close', str(state_path))
        run('/usr/bin/systemctl', 'is-active', '--quiet', unit + '.timer')
        enable_runtime()
        run('/usr/bin/systemctl', 'restart', SERVICE)
        wait_for_session(True)
    except Exception:
        close_check(state_path)
        raise
    return state_path


if __name__ == '__main__':
    try:
        if len(sys.argv) == 3 and sys.argv[1] == '--close':
            if os.geteuid() != 0:
                raise RuntimeError('Root is required')
            close_check(Path(sys.argv[2]))
            print('AUTH_BROWSER_CHECK_CLOSED')
        elif len(sys.argv) == 2:
            state_path = start_check(sys.argv[1])
            print('AUTH_BROWSER_CHECK_READY_15_MINUTES')
            print('CLOSE_COMMAND=' + sys.executable + ' ' + str(Path(__file__).resolve())
                  + ' --close ' + str(state_path))
        else:
            raise RuntimeError('Expected probe or close command')
    except Exception as error:
        raise SystemExit(failure_report(error))
