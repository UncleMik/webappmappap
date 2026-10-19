"""Filesystem/command-double checks; never contacts a server or provider."""

import importlib.util
import json
from pathlib import Path
import tempfile
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location('browser_check', Path(__file__).with_name('check-auth-browser.py'))
qa = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(qa)
NONCE = '1234567890abcdef1234567890abcdef'
NGINX = Path(__file__).with_name('nginx-domain.conf').read_text(encoding='utf-8')


class BrowserCheckTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.env = root / 'auth.env'
        self.nginx = root / 'nginx.conf'
        self.runtime = root / 'run' / 'flag.env'
        self.dropin = root / 'run' / 'unit.d' / 'check.conf'
        self.runtime.parent.mkdir()
        self.env.write_bytes(b'AUTH_ENABLED=false\nAUTH_HMAC_SECRET=test-only-placeholder\n')
        self.original_env = self.env.read_bytes()
        self.nginx.write_text(NGINX, encoding='utf-8')
        self.events = []
        self.enabled = False
        self.timer = False
        self.guard_loaded = False
        self.fail_once = None
        self.bad_guard_probe = False
        self.bad_enabled_response = False
        self.patches = [
            patch.object(qa, 'ENV_FILE', self.env),
            patch.object(qa, 'NGINX_FILE', self.nginx),
            patch.object(qa, 'QA_ROOT', root / 'checks'),
            patch.object(qa, 'RUN_ENV', self.runtime),
            patch.object(qa, 'DROPIN', self.dropin),
            patch.object(qa, 'preflight'),
            patch.object(qa, 'read_probe_address', return_value='8.8.8.8'),
            patch.object(qa, 'run', side_effect=self.fake_run),
            patch.object(qa, 'session_state', side_effect=self.fake_session),
            patch.object(qa.subprocess, 'run', side_effect=self.fake_direct_run),
            patch.object(qa.time, 'sleep'),
        ]
        for item in self.patches:
            item.start()

    def tearDown(self):
        for item in reversed(self.patches):
            item.stop()
        self.temp.cleanup()

    def fake_session(self, enabled):
        return not (enabled and self.bad_enabled_response) and self.enabled == enabled

    def fake_direct_run(self, args, **kwargs):
        return self.fake_run(*args, **kwargs)

    def fake_run(self, *args, **kwargs):
        self.events.append((args, self.runtime.exists(), self.timer, self.guard_loaded))
        if self.fail_once and self.fail_once(args):
            self.fail_once = None
            raise RuntimeError('Injected command failure')
        if args[0] == '/usr/bin/systemd-run':
            self.timer = True
        elif args[:3] == ('/usr/bin/systemctl', 'is-active', '--quiet'):
            if not self.timer:
                raise RuntimeError('Timer is absent')
        elif args[:3] == ('/usr/bin/systemctl', 'reload', 'nginx'):
            self.guard_loaded = qa.MARKER in self.nginx.read_text(encoding='utf-8')
        elif args[:3] == ('/usr/bin/systemctl', 'restart', qa.SERVICE):
            self.enabled = self.runtime.exists() and self.dropin.exists()
        elif args[:3] == ('/usr/bin/systemctl', 'stop', qa.SERVICE):
            self.enabled = False
        elif args[:2] == ('/usr/bin/systemctl', 'stop') and args[2].endswith('.timer'):
            self.timer = False
        elif args[0] == '/usr/bin/curl':
            code = b'200' if self.bad_guard_probe or not self.guard_loaded else b'403'
            return SimpleNamespace(stdout=code, returncode=0)
        elif args not in [('/usr/sbin/nginx', '-t'), ('/usr/bin/systemctl', 'daemon-reload')]:
            raise AssertionError('Unexpected command in isolated test: ' + repr(args))
        return SimpleNamespace(stdout=b'', returncode=0)

    def assert_closed(self):
        self.assertFalse(self.enabled)
        self.assertFalse(self.runtime.exists())
        self.assertFalse(self.dropin.exists())
        self.assertEqual(self.env.read_bytes(), self.original_env)
        self.assertEqual(self.nginx.read_text(encoding='utf-8'), NGINX)

    def test_timer_and_nginx_guard_precede_runtime_enable(self):
        state = qa.start_check(NONCE)
        self.assertTrue(self.enabled)
        self.assertTrue(self.timer)
        self.assertIn('allow 8.8.8.8;', self.nginx.read_text(encoding='utf-8'))
        for _, has_runtime, timer, guard in self.events:
            if has_runtime:
                self.assertTrue(timer)
                self.assertTrue(guard)
        self.assertEqual(self.env.read_bytes(), self.original_env)
        self.assertNotIn('test-only-placeholder', state.read_text(encoding='utf-8'))
        qa.close_check(state)
        self.assert_closed()

    def test_failed_nginx_validation_does_not_enable_auth(self):
        self.fail_once = lambda args: args == ('/usr/sbin/nginx', '-t')
        with self.assertRaises(RuntimeError):
            qa.start_check(NONCE)
        self.assert_closed()
        self.assertFalse(any(runtime for _, runtime, _, _ in self.events))

    def test_missing_ip_denial_does_not_enable_auth(self):
        self.bad_guard_probe = True
        with self.assertRaises(RuntimeError):
            qa.start_check(NONCE)
        self.assert_closed()
        self.assertFalse(any(runtime for _, runtime, _, _ in self.events))

    def test_failed_timer_does_not_enable_auth(self):
        self.fail_once = lambda args: args[0] == '/usr/bin/systemd-run'
        with self.assertRaises(RuntimeError):
            qa.start_check(NONCE)
        self.assert_closed()
        self.assertFalse(any(runtime for _, runtime, _, _ in self.events))

    def test_failed_auth_health_removes_runtime_override(self):
        self.bad_enabled_response = True
        with self.assertRaises(RuntimeError):
            qa.start_check(NONCE)
        self.assert_closed()
        self.assertFalse(self.timer)

    def test_close_preserves_concurrent_settings_outside_its_guard(self):
        state = qa.start_check(NONCE)
        changed_env = self.original_env + b'AUTH_REPLY_TO=example@example.org\n'
        self.env.write_bytes(changed_env)
        self.nginx.write_text(self.nginx.read_text(encoding='utf-8') + '# unrelated change\n', encoding='utf-8')
        qa.close_check(state)
        self.assertEqual(self.env.read_bytes(), changed_env)
        self.assertEqual(self.nginx.read_text(encoding='utf-8'), NGINX + '# unrelated change\n')
        self.assertTrue(json.loads(state.read_text(encoding='utf-8'))['closed'])
        before = len(self.events)
        qa.close_check(state)
        self.assertEqual(len(self.events), before)

    def test_failed_close_stops_listener_and_keeps_ip_guard(self):
        state = qa.start_check(NONCE)
        self.fail_once = lambda args: args[:3] == ('/usr/bin/systemctl', 'restart', qa.SERVICE)
        with self.assertRaises(RuntimeError):
            qa.close_check(state)
        self.assertFalse(self.enabled)
        self.assertIn(qa.MARKER, self.nginx.read_text(encoding='utf-8'))
        self.assertEqual(self.env.read_bytes(), self.original_env)

    def test_guard_does_not_change_article_route(self):
        guarded, guard = qa.add_guard(NGINX, '8.8.8.8', NONCE)
        self.assertEqual(guarded.replace(guard, '', 1), NGINX)
        self.assertIn('deny all;', guard)
        with self.assertRaises(RuntimeError):
            qa.add_guard(guarded, '8.8.8.8', NONCE)
        with self.assertRaises(RuntimeError):
            qa.add_guard(NGINX + NGINX, '8.8.8.8', NONCE)


class ProbeTests(unittest.TestCase):
    def test_recent_exact_probe_is_required(self):
        now = datetime(2026, 10, 19, 7, 10, tzinfo=timezone.utc)

        def line(address, timestamp, nonce=NONCE):
            return (address + ' - - [' + timestamp.strftime('%d/%b/%Y:%H:%M:%S %z')
                    + '] "GET /api/auth/session?qa=' + nonce + ' HTTP/2.0" 503 100 "-" "Browser"')

        self.assertEqual(qa.probe_address(line('8.8.8.8', now), NONCE, now), '8.8.8.8')
        invalid = [line('127.0.0.1', now), line('8.8.8.8', now - timedelta(minutes=21)),
                   line('8.8.8.8', now, '0' * 32),
                   line('8.8.8.8', now) + '\n' + line('1.1.1.1', now)]
        for text in invalid:
            with self.assertRaises(RuntimeError):
                qa.probe_address(text, NONCE, now)


if __name__ == '__main__':
    unittest.main()
