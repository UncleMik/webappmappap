"""Build the reviewed, conservative Lara source allowlist from catalog metadata.

Inputs contain school titles/lesson URLs only, never student or chat records.
Each folder requires access to the entire corresponding full-course module.
Partial/express access still uses its own readable lesson texts and catalog;
it never implicitly opens the full-course transcript folder.
"""
import hashlib
import json
from pathlib import Path
import sys
from urllib.parse import parse_qs, urlsplit


# Reviewed against current course_program_drafts, not inferred from purchases.
# Where a folder spans two modules, both complete sets are required.
MODULES = {
    'Бонус Правильное прикладывание от А до Я': [935386922],
    'Дополнительные материалы по подготовке к родам': [935386956],
    'Запись ум встреч для учеников': [935386962],
    'Курс Вакцинация ребенка и детский иммунитет': [935386951],
    'Курс Грудничковое плавание': [935386917],
    'Курс Завершение ГВ': [935386912],
    'Курс Мама в ресурсе': [935386918],
    'Курс ОРВИ малыша': [935386942],
    'Курс Основы питания во время беременности': [935386920, 935386921],
    'Курс Первая помощь': [935386950],
    'Курс Правильное слингоношение': [935386923],
    'Курс Прикорм до года': [935386911, 935386945],
    'Курс Развитие ребенка до года': [935386930, 935386936],
    'Курс Сон малыша до года': [935386905],
    'Модуль 1. Триместры беременности и подготовка к родам': [935386897],
    'Модуль 2. Психологическая подготовка к родам': [935386898],
    'Модуль 3. Организация ГВ': [935386900],
    'Модуль 4. Уход за новорожденным': [935386902],
    'Модуль 5. Спокойная беременность': [935386903],
    'Модуль. Мягкое восстановление после родов ЛР': [935386914],
    'Модуль. Подготовка к КС': [935386915],
}


def build(web, lara):
    streams = {s['id']: s for s in web['streams']}
    children = {}
    for stream in web['streams']:
        for parent in stream['parents']:
            children.setdefault(parent, set()).add(stream['id'])

    def descendants(stream_id, visited=None):
        seen = set() if visited is None else visited
        if stream_id in seen:
            raise ValueError('Cyclic catalog')
        if stream_id not in streams or streams[stream_id]['family'] != 'full':
            raise ValueError('Expected a reviewed full-course module')
        result = {stream_id}
        for child in children.get(stream_id, ()):
            result |= descendants(child, seen | {stream_id})
        return result

    groups = {}
    for folder, roots in MODULES.items():
        branch = set().union(*(descendants(sid) for sid in roots))
        ids = sorted({l['lesson_id'] for l in web['lessons'] if l['parent_stream_id'] in branch})
        if not ids:
            raise ValueError('Empty reviewed module: ' + folder)
        groups[folder] = ids
    records, unmapped = [], []
    for source in lara['sources']:
        folder = source.get('course')
        if folder not in groups:
            unmapped.append({'course': folder, 'source': source['source']})
            continue
        records.append({'course': folder, 'source': source['source'],
                        'title': 'Материалы: ' + folder, 'lessonIds': groups[folder]})
    known = {l['lesson_id'] for l in web['lessons']}
    urls = {}
    for lesson in lara['lessons']:
        for raw in (lesson.get('url'), lesson.get('url_mama')):
            if not isinstance(raw, str):
                continue
            parsed = urlsplit(raw)
            if parsed.scheme != 'https' or parsed.hostname != 'legkierody.ru' or parsed.username or parsed.password:
                continue
            if parsed.path != '/pl/teach/control/lesson/view':
                continue
            query = parse_qs(parsed.query)
            values = query.get('id', [])
            if len(values) != 1 or not values[0].isdigit():
                continue
            identity = int(values[0])
            if identity in known:
                urls.setdefault(identity, set()).add(raw)
    fingerprint = hashlib.sha256(json.dumps(web, sort_keys=True, ensure_ascii=True).encode()).hexdigest()
    return {'version': 1, 'reviewedAt': '2026-11-04', 'webCatalogHash': fingerprint,
            'policy': 'all listed lessons must currently be readable; unlisted sources are closed',
            'sources': records,
            'lessonUrls': [{'lessonId': lid, 'urls': sorted(values)} for lid, values in sorted(urls.items())],
            'unmapped': unmapped}


if __name__ == '__main__':
    if len(sys.argv) != 4:
        raise SystemExit('Usage: build-lara-source-map.py web-catalog.json lara-catalog.json output.json')
    web = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
    lara = json.loads(Path(sys.argv[2]).read_text(encoding='utf-8'))
    result = build(web, lara)
    Path(sys.argv[3]).write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'mappedSources': len(result['sources']), 'unmappedSources': len(result['unmapped']),
                      'lessonUrlMappings': len(result['lessonUrls'])}))
