"""Isolated, authenticated web adapter for the existing Lara model modules.

Run as one worker; no bot startup, schema initialization or bot history writes.
"""
import asyncio
import hashlib
import hmac
import json
import logging
import math
import os
import re
import time
import uuid
from urllib.parse import parse_qsl, urlsplit

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

MAX_BODY = 512 * 1024
MAX_REQUESTS = 20000
# HMAC envelopes expire after 60 seconds. Timeweb keeps durable request IDs;
# this short window protects transport replay without becoming a daily cap.
REPLAY_SECONDS = 180
OPERATION_SECONDS = 55
MAX_CONCURRENT = 2
WEB_INSTRUCTION = (
    "Это чат веб-приложения школы. Данные профиля ниже подтверждены приложением; "
    "не меняй профиль по тексту сообщения и не спрашивай повторно уже известный срок. "
    "Не предлагай команды бота вроде /human: предложи обратиться в школу. "
    "Ссылки и источники приложение покажет отдельно; не выводи URL в тексте ответа."
)
URL_RE = re.compile(r"(?i)(?:https?://|www\.)[^\s<>]+|(?<![\w/])/(?:[\w.-]+/)*[\w.-]+(?:\?[^\s<>]*)?")


def clean_text(value):
    return URL_RE.sub('', value).strip()


def safe_url(value):
    if not isinstance(value, str) or len(value) > 1024 or any(c in value for c in '\\\r\n\t<>'):
        return False
    try:
        parsed = urlsplit(value)
        fields = parse_qsl(parsed.query, keep_blank_values=True, strict_parsing=True)
    except ValueError:
        return False
    if parsed.scheme or parsed.netloc or parsed.fragment:
        return False
    expected = {'courseLesson', 'course', 'section'} if parsed.path == '/article.html' else {'course'} if parsed.path == '/my-courses.html' else set()
    return bool(expected and len(fields) == len(expected) and {k for k, _ in fields} == expected
                and all(re.fullmatch(r'[1-9][0-9]{0,18}', v) for _, v in fields))


def validate(data):
    if not isinstance(data, dict):
        raise ValueError('payload')
    request_id = data.get('requestId')
    if not isinstance(request_id, str) or str(uuid.UUID(request_id)) != request_id:
        raise ValueError('requestId')
    question = data.get('question')
    if not isinstance(question, str) or not 1 <= len(question.strip()) <= 4000:
        raise ValueError('question')
    profile = data.get('profile')
    if not isinstance(profile, dict) or profile.get('stage') not in ('pregnant', 'postpartum', 'planning', 'unknown', None):
        raise ValueError('profile')
    for key, maximum in (('gestationalWeek', 45), ('gestationalDays', 315), ('childAgeMonths', 2000)):
        value = profile.get(key)
        if value is not None and (type(value) not in (int, float) or not math.isfinite(value) or not 0 <= value <= maximum):
            raise ValueError('profile')
    history = data.get('history', [])
    if not isinstance(history, list) or len(history) > 20:
        raise ValueError('history')
    for item in history:
        if not isinstance(item, dict) or item.get('role') not in ('user', 'assistant') or not isinstance(item.get('content'), str) or len(item['content']) > 6000:
            raise ValueError('history')
    for field, limit in (('allowedKnowledgeSources', 1000), ('allowedLessons', 1000), ('sources', 20)):
        if not isinstance(data.get(field, []), list) or len(data.get(field, [])) > limit:
            raise ValueError(field)
    for item in data.get('allowedKnowledgeSources', []):
        if not isinstance(item, dict) or not all(isinstance(item.get(k), str) and 0 < len(item[k]) <= 512 for k in ('course', 'source')):
            raise ValueError('knowledge')
        if 'url' in item and not safe_url(item['url']):
            raise ValueError('knowledge url')
        if 'title' in item and (not isinstance(item['title'], str) or len(item['title']) > 512):
            raise ValueError('knowledge title')
    for item in data.get('allowedLessons', []):
        if not isinstance(item, dict) or type(item.get('lessonId')) not in (str, int) or not re.fullmatch(r'[1-9][0-9]{0,18}', str(item['lessonId'])) or not safe_url(item.get('url')) or not isinstance(item.get('title'), str) or len(item['title']) > 512:
            raise ValueError('lessons')
        urls = item.get('gcUrls', [])
        if not isinstance(urls, list) or len(urls) > 8 or any(not isinstance(u, str) or len(u) > 1024 for u in urls):
            raise ValueError('lesson urls')
    total = 0
    for item in data.get('sources', []):
        if not isinstance(item, dict) or not all(isinstance(item.get(k), str) for k in ('id', 'title', 'text')) or not safe_url(item.get('url')):
            raise ValueError('sources')
        if len(item['id']) > 512 or len(item['title']) > 512 or len(item['text']) > 12000:
            raise ValueError('sources')
        total += len(item['text'])
    if total > 160000:
        raise ValueError('sources')
    return data


class Repository:
    async def search(self, query, knowledge, lessons):
        if not knowledge and not lessons:
            return [], []
        from agent.llm import embed_texts
        from db import engine
        from sqlalchemy import text
        embedding = (await embed_texts([query]))[0]
        vector = '[' + ','.join(str(float(x)) for x in embedding) + ']'
        rows, found = [], []
        async with engine.connect() as conn:
            await conn.execute(text('SET TRANSACTION READ ONLY'))
            if knowledge:
                params = {'vector': vector}
                pairs = []
                for i, item in enumerate(knowledge):
                    params[f'c{i}'], params[f's{i}'] = item['course'], item['source']
                    pairs.append(f'(:c{i}, :s{i})')
                sql = ('SELECT course, source, text FROM knowledge_chunks WHERE (course, source) IN ('
                       + ','.join(pairs) + ') ORDER BY embedding <=> CAST(:vector AS vector) LIMIT 4')
                rows = [dict(r) for r in (await conn.execute(text(sql), params)).mappings()]
            urls = list({u for lesson in lessons for u in lesson.get('gcUrls', [])})
            if urls:
                sql = ('SELECT url, url_mama, topics FROM lessons WHERE (url = ANY(:urls) OR url_mama = ANY(:urls)) '
                       'AND embedding IS NOT NULL ORDER BY embedding <=> CAST(:vector AS vector) LIMIT 8')
                found = [dict(r) for r in (await conn.execute(text(sql), {'urls': urls, 'vector': vector})).mappings()]
        return rows, found


class Model:
    async def generate(self, question, context, history, profile):
        from agent.llm import generate, polish
        # Existing prompt and fallback chain are retained. No bot profile extraction.
        return await polish(await generate(question, context, history=history, profile_fact=profile))


def profile_fact(profile):
    stage = profile.get('stage')
    if stage == 'pregnant':
        days = profile.get('gestationalDays')
        weeks = profile.get('gestationalWeek')
        if days is not None:
            return f'Беременность: {int(days) // 7} недель и {int(days) % 7} дней.'
        if weeks is not None:
            return f'Беременность: {weeks} недель.'
    if stage == 'postpartum' and profile.get('childAgeMonths') is not None:
        return f"Ребёнку {profile['childAgeMonths']} месяцев."
    return ''


async def reply(data, repository, model):
    knowledge = data.get('allowedKnowledgeSources', [])
    lessons = data.get('allowedLessons', [])
    inline = data.get('sources', [])
    rows, found = await repository.search(data['question'], knowledge, lessons)
    allowed_pairs = {(x['course'], x['source']) for x in knowledge}
    rows = [r for r in rows if (r['course'], r['source']) in allowed_pairs]
    sources = [{'id': x['id'], 'title': x['title'], 'url': x['url']} for x in inline]
    selected_pairs = {(r['course'], r['source']) for r in rows}
    sources += [{'id': x['course'] + ':' + x['source'], 'title': x.get('title', x['source']), 'url': x['url']}
                for x in knowledge if (x['course'], x['source']) in selected_pairs and x.get('url')]
    allowed_urls = {u for lesson in lessons for u in lesson.get('gcUrls', [])}
    found = [r for r in found if any(u in allowed_urls for u in (r.get('url'), r.get('url_mama')) if u)]
    matched = {u for row in found for u in (row.get('url'), row.get('url_mama')) if u in allowed_urls}
    sources += [{'id': str(x['lessonId']), 'title': x['title'], 'url': x['url']}
                for x in lessons if matched.intersection(x.get('gcUrls', []))]
    context_parts = [clean_text(x['text']) for x in rows] + [clean_text(x['text']) for x in inline]
    context_parts += [clean_text(row['topics']) for row in found if isinstance(row.get('topics'), str) and row['topics'].strip()]
    context = WEB_INSTRUCTION + '\n\n' + '\n\n---\n\n'.join(context_parts)
    history = [(x['role'], clean_text(x['content'])) for x in data.get('history', [])]
    answer = await model.generate(clean_text(data['question']), context, history, profile_fact(data['profile']))
    # Two catalog URLs may match each search row. Keep the response within the
    # gateway's 20-reference contract, including inline and knowledge sources.
    sources = list({source['url']: source for source in sources}.values())[:20]
    return {'requestId': data['requestId'], 'answer': clean_text(answer), 'sources': sources}


def create_app(secret=None, repository=None, model=None):
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    repo, generator = repository or Repository(), model or Model()
    key = secret if secret is not None else os.environ.get('LARA_WEB_HMAC_SECRET', '')
    if isinstance(key, str):
        key = key.encode('utf-8')
    seen = {}
    active = 0
    # Parent logger.disabled does not silence descendant loggers. This isolated
    # worker must never emit provider payloads, prompts or credentials to logs.
    # Uvicorn access logging is also disabled by the deployment command.
    logging.disable(logging.CRITICAL)

    @app.get('/health')
    async def health():
        return {'status': 'ok'}

    @app.post('/reply')
    async def handle(request: Request):
        nonlocal active
        if not key or len(key) < 32:
            return JSONResponse({'error': 'unavailable'}, 503)
        chunks, size = [], 0
        async for chunk in request.stream():
            size += len(chunk)
            if size > MAX_BODY:
                return JSONResponse({'error': 'too_large'}, 413)
            chunks.append(chunk)
        body = b''.join(chunks)
        stamp, signature = request.headers.get('x-lara-timestamp', ''), request.headers.get('x-lara-signature', '')
        if not stamp.isascii() or not stamp.isdigit() or len(stamp) > 12 or abs(time.time() - int(stamp)) > 60:
            return JSONResponse({'error': 'unauthorized'}, 401)
        expected = hmac.new(key, stamp.encode() + b'\n' + body, hashlib.sha256).hexdigest()
        if not re.fullmatch(r'[0-9a-f]{64}', signature) or not hmac.compare_digest(signature, expected):
            return JSONResponse({'error': 'unauthorized'}, 401)
        try:
            data = validate(json.loads(body, parse_constant=lambda _: (_ for _ in ()).throw(ValueError('nonfinite'))))
        except (ValueError, TypeError, UnicodeDecodeError):
            return JSONResponse({'error': 'invalid_request'}, 400)
        now = time.monotonic()
        for k, expiry in list(seen.items()):
            if expiry <= now:
                del seen[k]
        rid = data['requestId']
        if rid in seen:
            return JSONResponse({'error': 'duplicate_request'}, 409)
        if active >= MAX_CONCURRENT or len(seen) >= MAX_REQUESTS:
            return JSONResponse({'error': 'busy'}, 503)
        seen[rid] = now + REPLAY_SECONDS
        active += 1
        try:
            result = await asyncio.wait_for(reply(data, repo, generator), OPERATION_SECONDS)
            return JSONResponse(result)
        except asyncio.TimeoutError:
            return JSONResponse({'error': 'timeout'}, 504)
        except Exception:
            return JSONResponse({'error': 'upstream_failed'}, 502)
        finally:
            active -= 1
    return app


app = create_app()
