"""Remove only the obsolete preview link; preserve all other live page bytes."""
import os
from pathlib import Path
import time

page = Path('/opt/wep_pril/frontend/login.html')
tag = '<a class="auth-preview-link" href="profile.html">В приложение</a>'.encode()
if os.geteuid() != 0 or page.is_symlink():
    raise SystemExit('ROOT_AND_REGULAR_LOGIN_PAGE_REQUIRED')
old = page.read_bytes()
if tag not in old:
    if b'auth-preview-link' in old:
        raise SystemExit('UNEXPECTED_PREVIEW_LINK')
    print('LOGIN_LINK_ALREADY_REMOVED')
else:
    if old.count(tag) != 1:
        raise SystemExit('AMBIGUOUS_PREVIEW_LINK')
    backup = Path('/root/wep-pril-login-before-link-removal-' + str(time.time_ns()) + '.html')
    backup.write_bytes(old)
    backup.chmod(0o600)
    temp = page.with_name('.login-link-removal-' + str(time.time_ns()) + '.tmp')
    try:
        temp.write_bytes(old.replace(tag, b''))
        temp.chmod(0o644)
        if page.is_symlink() or page.read_bytes() != old:
            raise SystemExit('PAGE_CHANGED_CONCURRENTLY')
        temp.replace(page)
    finally:
        temp.unlink(missing_ok=True)
    print('LOGIN_LINK_REMOVED')
    print('BACKUP=' + str(backup))
