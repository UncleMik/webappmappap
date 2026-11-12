"""Package only source and public fixtures for the isolated PostgreSQL check."""
import hashlib
import importlib.util
import json
from pathlib import Path
import zipfile

root = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('stars_check', root / 'deploy/check-stars-postgres.py')
check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(check)
candidates = list((root / 'backend').rglob('*')) + list((root / 'Фронт/admin').glob('*'))
candidates += [root / name for name in ['Фронт/assets/auth-mother-v1.webp', 'Фронт/push-worker.js', 'docs/content/getcourse-offers-2026-10-22.json']]
files = {p.relative_to(root).as_posix(): p.read_bytes() for p in candidates if p.is_file() and check.permitted(p.relative_to(root).as_posix())}
target = root / 'output/verification/stars-postgres-source.zip'
target.parent.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED) as archive:
    for name, data in files.items(): archive.writestr(name, data)
    archive.writestr('manifest.json', json.dumps({'version':1, 'files':{n:hashlib.sha256(b).hexdigest() for n,b in files.items()}}))
print(json.dumps({'files':len(files), 'bytes':target.stat().st_size, 'sha256':hashlib.sha256(target.read_bytes()).hexdigest()}))
