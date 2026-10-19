"""Install mandatory session checks, preserving existing page and profile changes."""
import hashlib
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path('/opt/wep_pril')
MODULE_HASHES = {'Фронт/auth-gate.js': '31d86e6e0822937532f562aaa70a5fc9013bfd466f5dc2ac01e65f47baf63cec', 'Фронт/auth-return.js': 'ec069057486e957d7b221da1e353d8dc98656ea71edfddc64b7afd709fc1975d', 'deploy/nginx-domain.conf': '268a2f93611617cfa0a196ceaf97f342127f4428e453a2ee84cf00b6fbf134b5', 'deploy/nginx.conf': 'eb56c16c3d68b95c17714b224c4281ccedd6f3d626fb9ccf388efe49467d4058'}  # Filled from reviewed release bytes before publication.
BASELINE_CONFIG_HASHES = {'nginx-domain.conf': '80c734b1fb574317f0a90b0ada66c1c38bc9e3e623fcc3a1dfb85bf2aa8ef38d', 'nginx.conf': 'c9596da60677dd750143d930fab8ec55b9be72b67cc36fc02750d007e40d70d4'}  # Formatting-insensitive hashes of the known configurations.
LOCK = '\n  <style id="account-lock">html { visibility: hidden !important; }</style>\n  <script src="auth-gate.js?v=20261019-required"></script>'
CHECK = """      if (request.method === 'GET' && url.pathname === '/api/auth/check') {
        const user = await service.session(readSessionCookie(request));
        if (!user) throw new AuthError(401, 'sign_in_required', 'Войдите в аккаунт.');
        send(204); return;
      }
"""
PAGES = ['index', 'journey', 'ai', 'club', 'club-chat', 'profile', 'personal-data',
         'articles', 'article', 'baby', 'mom', 'courses', 'my-courses', 'video', 'onboarding']


def sha(data):
    return hashlib.sha256(data).hexdigest()


def text(data):
    return data.decode('utf-8').replace('\r\n', '\n')


def config_hash(data):
    source = re.sub(r'(?m)^\s*#.*$', '', text(data))
    return sha(re.sub(r'\s+', '', source).encode())


def protect_html(data):
    source = text(data)
    if 'id="account-lock"' in source:
        if LOCK not in source:
            raise RuntimeError('UNEXPECTED_PAGE_GATE')
        return data
    result, count = re.subn(r'<head\b[^>]*>', lambda m: m[0] + LOCK, source, count=1, flags=re.I)
    if count != 1:
        raise RuntimeError('HTML_HEAD_NOT_FOUND')
    return result.encode()


def protect_http(data):
    source = text(data)
    if "url.pathname === '/api/auth/check'" in source:
        if CHECK not in source:
            raise RuntimeError('UNEXPECTED_SERVER_GATE')
        return data
    marker = "      if (url.search) throw new AuthError(400, 'invalid_url', 'Неверный запрос.');\n"
    if source.count(marker) != 1:
        raise RuntimeError('AUTH_INSERTION_POINT_NOT_FOUND')
    return source.replace(marker, marker + CHECK).encode()


def protect_login(data):
    source = text(data)
    source = source.replace("import { returnPage } from './profile-dates.js';\n", '')
    if "from './auth-return.js'" not in source:
        source = "import { returnPage } from './auth-return.js';\n" + source
    start = source.find('// Return only')
    if start < 0:
        start = source.find('const nextPage =')
    end = source.find('function cooldown', start)
    if start < 0 or end < start:
        raise RuntimeError('LOGIN_RETURN_POINT_NOT_FOUND')
    source = source[:start] + "const nextPage = location.hash.startsWith('#next=') ? location.hash.slice(6) : new URLSearchParams(location.search).get('next');\nsignedIn.querySelector('a').href = returnPage(nextPage);\n" + source[end:]
    if 'window.top.location.replace(returnPage(nextPage))' not in source:
        marker = 'function authenticated(user) {'
        if source.count(marker) != 1:
            raise RuntimeError('LOGIN_AUTHENTICATED_POINT_NOT_FOUND')
        source = source.replace(marker, marker + '\n  if (nextPage) { window.top.location.replace(returnPage(nextPage)); return; }')
    return source.encode()


def protect_profile_dates(data):
    source = text(data)
    if "export { returnPage } from './auth-return.js';" in source:
        return data
    start = source.find('export function returnPage(')
    if start < 0 or not source.rstrip().endswith('}'):
        raise RuntimeError('PROFILE_RETURN_POINT_NOT_FOUND')
    return (source[:start] + "export { returnPage } from './auth-return.js';\n").encode()


def run(*args):
    subprocess.run(args, check=True, timeout=40, capture_output=True)


def atomic_write(path, data):
    temp = path.with_name(path.name + '.required-login.tmp')
    fd = os.open(temp, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
    try:
        with os.fdopen(fd, 'wb') as stream:
            if hasattr(os, 'fchmod'):
                os.fchmod(stream.fileno(), 0o644)
            else:
                temp.chmod(0o644)
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, path)
    finally:
        if temp.exists():
            temp.unlink()


def apply_release(before, after, backup, restart, validate_nginx, reload_nginx, healthy):
    backup.mkdir(mode=0o700, exist_ok=False)
    for number, (path, data) in enumerate(before.items()):
        if data is not None:
            saved = backup / str(number)
            saved.write_bytes(data)
            saved.chmod(0o600)
    manifest = {str(path): {'backup': str(i), 'old': sha(data) if data is not None else None, 'new': sha(after[path])}
                for i, (path, data) in enumerate(before.items())}
    (backup / 'manifest.json').write_text(__import__('json').dumps(manifest), encoding='utf-8')
    (backup / 'manifest.json').chmod(0o600)
    changed = []
    try:
        for path, data in after.items():
            if (path.read_bytes() if path.exists() else None) != before[path]:
                raise RuntimeError('CONCURRENT_CHANGE:' + path.name)
            if data == before[path]:
                continue
            atomic_write(path, data)
            changed.append(path)
        validate_nginx()
        restart()
        reload_nginx()
        if not healthy():
            raise RuntimeError('ACCESS_CHECK_FAILED')
    except Exception:
        conflict = False
        for path in reversed(changed):
            if path.is_symlink() or path.read_bytes() != after[path]:
                conflict = True
                continue
            if before[path] is None:
                path.unlink()
            else:
                atomic_write(path, before[path])
        validate_nginx()
        restart()
        reload_nginx()
        if conflict:
            raise RuntimeError('ROLLBACK_CONCURRENT_CHANGE') from None
        raise


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        return None


def status(url):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    try:
        with opener.open(url, timeout=8) as response:
            return response.status, response.headers
    except urllib.error.HTTPError as error:
        return error.code, error.headers


def healthy():
    for _ in range(10):
        try:
            if status('http://127.0.0.1:3001/api/auth/check')[0] != 401:
                time.sleep(.5)
                continue
            if status('http://127.0.0.1:3000/api/health')[0] != 200:
                return False
            origin = 'https://app.legkie-rody.ru'
            for route in ['/', '/journey.html?week=27', '/article.html?id=pregnancy-001', '/profile.html']:
                code, headers = status(origin + route)
                if code != 302 or '/login.html#next=' not in headers.get('Location', ''):
                    return False
            for route in ['/api/articles', '/api/weekly-content', '/uploads/articles/test.webp', '/weekly-videos.js']:
                if status(origin + route)[0] != 401:
                    return False
            return status(origin + '/login.html')[0] == 200 and status('https://129.101.119.250/article.html')[0] == 302
        except OSError:
            time.sleep(.5)
    return False


def main():
    if os.geteuid() != 0 or len(sys.argv) != 2 or not re.fullmatch('[0-9a-f]{40}', sys.argv[1]):
        raise RuntimeError('ROOT_AND_PINNED_REVISION_REQUIRED')
    if len(MODULE_HASHES) != 4 or len(BASELINE_CONFIG_HASHES) != 2:
        raise RuntimeError('RELEASE_MANIFEST_MISSING')
    base = 'https://raw.githubusercontent.com/UncleMik/webappmappap/' + sys.argv[1] + '/'
    downloaded = {}
    for name, expected in MODULE_HASHES.items():
        with urllib.request.urlopen(base + urllib.parse.quote(name, safe='/'), timeout=25) as response:
            payload = response.read(200001)
        if len(payload) > 200000 or sha(payload) != expected:
            raise RuntimeError('DOWNLOAD_CHECKSUM_FAILED:' + name)
        downloaded[name] = payload
    before, after = {}, {}

    def add(path, transform):
        path = path.absolute()
        if path.is_symlink() or path.resolve() != path:
            raise RuntimeError('UNSAFE_TARGET')
        data = path.read_bytes() if path.exists() else None
        before[path] = data
        after[path] = transform(data)

    for name in ['auth-gate.js', 'auth-return.js']:
        add(ROOT / 'frontend' / name, lambda _, n=name: downloaded['Фронт/' + n])
    add(ROOT / 'backend/auth/http.mjs', protect_http)
    add(ROOT / 'frontend/login.js', protect_login)
    profile_dates = ROOT / 'frontend/profile-dates.js'
    if profile_dates.exists():
        add(profile_dates, protect_profile_dates)
    for name in PAGES:
        path = ROOT / 'frontend' / (name + '.html')
        if path.exists():
            add(path, protect_html)
    add(ROOT / 'frontend/login.html', lambda d: re.sub(r'login\.js\?v=[^"\s]+', 'login.js?v=20261019-required', text(d)).encode())
    for name, target in [('nginx-domain.conf', 'wep-pril-domain'), ('nginx.conf', 'wep-pril')]:
        payload = downloaded['deploy/' + name]

        def replace_config(data, value=payload, config=name):
            if config_hash(data) not in [BASELINE_CONFIG_HASHES[config], config_hash(value)]:
                raise RuntimeError('UNEXPECTED_NGINX_CONFIG:' + config)
            return value
        add(Path('/etc/nginx/sites-available') / target, replace_config)
    backup = Path('/root/wep-pril-required-login-backup-' + str(time.time_ns()))
    apply_release(before, after, backup,
                  lambda: run('systemctl', 'restart', 'wep-pril-auth'),
                  lambda: run('nginx', '-t'), lambda: run('systemctl', 'reload', 'nginx'), healthy)
    print('REQUIRED_LOGIN_PUBLISHED_OK')
    print('BACKUP_DIR=' + str(backup))
    print('ANONYMOUS_PAGES_REDIRECT; MATERIALS_401; DATABASES_UNCHANGED')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('REQUIRED_LOGIN_PUBLISH_FAILED=' + (str(error) if isinstance(error, RuntimeError) else type(error).__name__))
        raise SystemExit(1) from None
