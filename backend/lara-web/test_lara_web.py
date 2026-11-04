import asyncio
import hashlib
import hmac
import json
import time
import uuid
import unittest
import sys
import types
from unittest.mock import patch

import httpx
import lara_web as web

KEY = b'test-secret-is-long-enough-for-hmac'


def payload():
    return {'requestId': str(uuid.uuid4()), 'question': 'Вопрос',
            'profile': {'stage': 'pregnant', 'gestationalDays': 100},
            'history': [], 'allowedKnowledgeSources': [], 'allowedLessons': [],
            'sources': [{'id': '1', 'title': 'Тема', 'text': 'Текст', 'url': '/article.html?courseLesson=1&course=1&section=1'}]}


class FakeRepo:
    async def search(self, query, knowledge, lessons):
        return [], []


class FakeModel:
    def __init__(self):
        self.calls = []

    async def generate(self, question, context, history, profile):
        self.calls.append((question, context, history, profile))
        return 'Ответ https://example.com/private /human'


class AdapterTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.model = FakeModel()
        self.app = web.create_app(KEY, FakeRepo(), self.model)
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url='http://test')

    async def asyncTearDown(self):
        await self.client.aclose()

    async def post(self, obj=None, raw=None, timestamp=None, sign_key=KEY):
        body = raw if raw is not None else json.dumps(obj, ensure_ascii=False).encode()
        stamp = str(int(time.time()) if timestamp is None else timestamp)
        signature = hmac.new(sign_key, stamp.encode() + b'\n' + body, hashlib.sha256).hexdigest()
        return await self.client.post('/reply', content=body, headers={'X-Lara-Timestamp': stamp, 'X-Lara-Signature': signature})

    async def test_auth_expiry_invalid_and_size(self):
        self.assertEqual((await self.post(payload(), sign_key=b'wrong')).status_code, 401)
        self.assertEqual((await self.post(payload(), timestamp=int(time.time()) - 61)).status_code, 401)
        self.assertEqual((await self.post(raw=b'{')).status_code, 400)
        self.assertEqual((await self.post(raw=b'x' * (web.MAX_BODY + 1))).status_code, 413)
        self.assertEqual(len(self.model.calls), 0)

    async def test_invalid_numbers_id_and_dangerous_links(self):
        p = payload()
        p['profile'] = {'stage': 'postpartum', 'childAgeMonths': 400}
        self.assertEqual((await self.post(p)).status_code, 200)
        for field in ('NaN', 'Infinity', '-Infinity'):
            p = payload()
            raw = json.dumps(p).replace('"gestationalDays": 100', f'"gestationalDays": {field}').encode()
            self.assertEqual((await self.post(raw=raw)).status_code, 400)
        p = payload()
        p['allowedLessons'] = [{'lessonId': True, 'title': 'X', 'url': '/article.html?courseLesson=1&course=1&section=1'}]
        self.assertEqual((await self.post(p)).status_code, 400)
        for path in ('/api/auth/logout', '//evil.example/a', '/article.html?courseLesson=1&course=1&section=1&other=1'):
            p = payload()
            p['sources'][0]['url'] = path
            self.assertEqual((await self.post(p)).status_code, 400)
        response = await self.client.post('/reply', content=b'{}', headers=[(b'x-lara-timestamp', str(int(time.time())).encode()), (b'x-lara-signature', b'\xff')])
        self.assertEqual(response.status_code, 401)

    async def test_reply_profile_link_and_duplicate(self):
        p = payload()
        p['question'] = 'Я на другой неделе'
        p['sources'][0]['text'] = 'Данные https://private.example/video'
        first = await self.post(p)
        self.assertEqual(first.status_code, 200)
        self.assertEqual(first.json()['requestId'], p['requestId'])
        self.assertNotIn('https:', first.json()['answer'])
        self.assertNotIn('/human', first.json()['answer'])
        self.assertIn('14 недель и 2 дней', self.model.calls[0][3])
        self.assertNotIn('private.example', self.model.calls[0][1])
        self.assertEqual((await self.post(p)).status_code, 409)
        self.assertEqual(len(self.model.calls), 1)

    async def test_no_sources_model_general_allowed(self):
        p = payload()
        p['sources'] = []
        res = await self.post(p)
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json()['answer'], 'Ответ')
        self.assertEqual(len(self.model.calls), 1)

    async def test_untrusted_repository_row_is_rejected(self):
        class Repo:
            async def search(self, *_):
                return [{'course': 'other', 'source': 'private', 'text': 'private'}], []
        self.app = web.create_app(KEY, Repo(), self.model)
        await self.client.aclose()
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url='http://test')
        p = payload()
        p['sources'] = []
        p['allowedKnowledgeSources'] = [{'course': 'allow', 'source': 'file'}]
        res = await self.post(p)
        self.assertEqual(res.json()['answer'], 'Ответ')
        self.assertEqual(len(self.model.calls), 1)
        self.assertNotIn('private', self.model.calls[0][1])

    async def test_only_matching_lesson_returns_web_link(self):
        class Repo:
            async def search(self, *_):
                return [], [{'url': 'https://gc.test/article.html?courseLesson=1&course=1&section=1', 'url_mama': None, 'topics': 'Тема'}]
        self.app = web.create_app(KEY, Repo(), self.model)
        await self.client.aclose()
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url='http://test')
        p = payload()
        p['allowedLessons'] = [
            {'lessonId': '1', 'title': 'Разрешённый', 'url': '/article.html?courseLesson=1&course=1&section=1', 'gcUrls': ['https://gc.test/article.html?courseLesson=1&course=1&section=1']},
            {'lessonId': '2', 'title': 'Другой', 'url': '/article.html?courseLesson=2&course=1&section=1', 'gcUrls': ['https://gc.test/article.html?courseLesson=2&course=1&section=1']},
        ]
        result = (await self.post(p)).json()
        self.assertIn({'id': '1', 'title': 'Разрешённый', 'url': '/article.html?courseLesson=1&course=1&section=1'}, result['sources'])
        self.assertNotIn('/article.html?courseLesson=2&course=1&section=1', str(result))
        self.assertNotIn('gc.test', str(result))
        self.assertIn('Тема', self.model.calls[0][1])

    async def test_repository_filters_in_sql_before_limit_readonly(self):
        statements = []
        class Result:
            def mappings(self):
                return []
        class Connection:
            async def __aenter__(self):
                return self
            async def __aexit__(self, *_):
                return False
            async def execute(self, sql, params=None):
                statements.append((str(sql), params))
                return Result()
        fake_llm = types.ModuleType('agent.llm')
        async def embed(_):
            return [[0.1, 0.2]]
        fake_llm.embed_texts = embed
        fake_agent = types.ModuleType('agent')
        fake_db = types.ModuleType('db')
        fake_db.engine = types.SimpleNamespace(connect=lambda: Connection())
        with patch.dict(sys.modules, {'agent': fake_agent, 'agent.llm': fake_llm, 'db': fake_db}):
            repo = web.Repository()
            await repo.search('q', [], [])
            self.assertEqual(statements, [])
            await repo.search('q', [{'course': 'A', 'source': 'B'}], [{'gcUrls': ['https://gc.test/1']}])
        self.assertEqual(statements[0][0], 'SET TRANSACTION READ ONLY')
        for sql, _ in statements[1:]:
            self.assertLess(sql.index('WHERE'), sql.index('LIMIT'))
        self.assertIn('(course, source) IN', statements[1][0])
        self.assertIn('url = ANY(:urls)', statements[2][0])
        self.assertEqual(statements[1][1]['c0'], 'A')
        self.assertTrue(all(not sql.startswith(('INSERT', 'UPDATE', 'DELETE')) for sql, _ in statements))

    async def test_combined_references_fit_gateway_contract(self):
        class Repo:
            async def search(self, *_):
                return [], [{'url': f'https://gc.test/{n}', 'url_mama': None, 'topics': 'Тема'} for n in range(1, 9)]
        self.app = web.create_app(KEY, Repo(), self.model)
        await self.client.aclose()
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url='http://test')
        p = payload()
        p['sources'] = [{'id': str(n), 'title': 'Тема', 'text': 'Текст',
                         'url': f'/article.html?courseLesson={n}&course=1&section=1'} for n in range(1, 21)]
        p['allowedLessons'] = [{'lessonId': str(n), 'title': 'Урок',
                                'url': f'/article.html?courseLesson={n}&course=1&section=1',
                                'gcUrls': [f'https://gc.test/{n-19}']} for n in range(20, 28)]
        response = await self.post(p)
        self.assertEqual(response.status_code, 200)
        references = response.json()['sources']
        self.assertEqual(len(references), 20)
        self.assertEqual(len({s['url'] for s in references}), 20)

    async def test_concurrency_guard(self):
        entered = asyncio.Event()
        release = asyncio.Event()
        class SlowModel:
            async def generate(self, *args):
                entered.set()
                await release.wait()
                return 'Ответ'
        self.app = web.create_app(KEY, FakeRepo(), SlowModel())
        await self.client.aclose()
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url='http://test')
        tasks = [asyncio.create_task(self.post(payload())) for _ in range(2)]
        await entered.wait()
        await asyncio.sleep(0)
        self.assertEqual((await self.post(payload())).status_code, 503)
        release.set()
        self.assertEqual([r.status_code for r in await asyncio.gather(*tasks)], [200, 200])

    async def test_provider_error_does_not_leak_or_allow_retry(self):
        class BadModel:
            async def generate(self, *args):
                raise ValueError('private provider details')
        self.app = web.create_app(KEY, FakeRepo(), BadModel())
        await self.client.aclose()
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url='http://test')
        p = payload()
        failed = await self.post(p)
        self.assertEqual(failed.status_code, 502)
        self.assertNotIn('private provider details', failed.text)
        self.assertEqual((await self.post(p)).status_code, 409)

    async def test_foreign_model_request_id_never_returned(self):
        class BadModel:
            async def generate(self, *args):
                return {'requestId': 'another-request', 'answer': 'x'}
        self.app = web.create_app(KEY, FakeRepo(), BadModel())
        await self.client.aclose()
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url='http://test')
        result = await self.post(payload())
        self.assertEqual(result.status_code, 502)
        self.assertNotIn('another-request', result.text)


if __name__ == '__main__':
    unittest.main()
