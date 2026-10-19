"""Publish redirects only: GitHub Pages cannot check the school's session."""
from pathlib import Path
import sys


def prepare(destination):
    destination = Path(destination)
    destination.mkdir(parents=True, exist_ok=True)
    if any(destination.iterdir()):
        raise RuntimeError('PAGES_OUTPUT_MUST_BE_EMPTY')
    source = Path(__file__).resolve().parents[1] / 'Фронт'
    page = '''<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><meta http-equiv="refresh" content="0;url=https://app.legkie-rody.ru/login.html">
<title>Вход в приложение</title><script>
const target = new URL('https://app.legkie-rody.ru/login.html');
const path = location.pathname.replace(/^\\/webappmappap\\//, '/');
const query = new URLSearchParams(location.search);
target.searchParams.set('next', query.get('next') || path + location.search + location.hash);
location.replace(target.href);
</script></head><body><a href="https://app.legkie-rody.ru/login.html">Войти в приложение</a></body></html>'''
    for name in [p.name for p in source.glob('*.html')] + ['404.html']:
        (destination / name).write_text(page, encoding='utf-8')
    (destination / '.nojekyll').touch()


if __name__ == '__main__':
    prepare(sys.argv[1] if len(sys.argv) > 1 else '_site')
