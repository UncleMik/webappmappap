import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('release', Path(__file__).with_name('publish-required-login.py'))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class RequiredLogin(unittest.TestCase):
    def test_html_preserves_current_content_and_is_idempotent(self):
        page = '<!doctype html><html><head><title>Текущий экран</title></head><body>Свежие данные</body></html>'.encode()
        result = release.protect_html(page)
        self.assertIn('Свежие данные'.encode(), result)
        self.assertIn('Текущий экран'.encode(), result)
        self.assertEqual(result.count(b'id="account-lock"'), 1)
        self.assertEqual(release.protect_html(result), result)

    def test_auth_patch_preserves_profile_route(self):
        data = b"before\n" + "      if (url.search) throw new AuthError(400, 'invalid_url', 'Неверный запрос.');\n".encode() + b"after /api/auth/profile\n"
        result = release.protect_http(data)
        self.assertIn(b'/api/auth/profile', result)
        self.assertEqual(release.protect_http(result), result)
        self.assertRaises(RuntimeError, release.protect_http, b'unexpected')

    def test_login_patch_preserves_onboarding_and_has_one_return_import(self):
        data = b"import { returnPage } from './profile-dates.js';\n// Return only agreed page\nconst nextPage = 'old';\nfunction cooldown() {}\nfunction authenticated(user) { if (!user.profile.completedAt) onboarding(); window.top.location.replace(returnPage(nextPage)); }"
        result = release.protect_login(data)
        self.assertIn(b'if (!user.profile.completedAt) onboarding()', result)
        self.assertIn(b"location.hash.startsWith('#next=')", result)
        self.assertNotIn(b'profile-dates.js', result)
        self.assertEqual(release.protect_login(result), result)

    def test_profile_dates_preserves_all_date_functions(self):
        data = b"export function dates() {}\nexport function returnPage(raw) { return 'old'; }\n"
        result = release.protect_profile_dates(data)
        self.assertIn(b'export function dates() {}', result)
        self.assertIn(b"export { returnPage } from './auth-return.js';", result)
        self.assertEqual(release.protect_profile_dates(result), result)

    def test_publication_and_failure_restore_existing_files_and_remove_new_modules(self):
        for succeeds in [True, False]:
            with self.subTest(succeeds=succeeds), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                existing = root / 'existing'; existing.write_bytes(b'old')
                new = root / 'new'
                before, after = {existing: b'old', new: None}, {existing: b'changed', new: b'new'}
                calls = []
                def run():
                    release.apply_release(before, after, root/'backup', lambda: calls.append('restart'),
                                          lambda: calls.append('validate'), lambda: calls.append('reload'), lambda: succeeds)
                if succeeds:
                    run()
                    self.assertEqual(existing.read_bytes(), b'changed')
                    self.assertEqual(new.read_bytes(), b'new')
                else:
                    self.assertRaisesRegex(RuntimeError, 'ACCESS_CHECK_FAILED', run)
                    self.assertEqual(existing.read_bytes(), b'old')
                    self.assertFalse(new.exists())
                    self.assertEqual(calls.count('reload'), 2)
                self.assertEqual((root/'backup/0').read_bytes(), b'old')

if __name__ == '__main__':
    unittest.main()
