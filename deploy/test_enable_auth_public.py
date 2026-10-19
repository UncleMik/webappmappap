"""Isolated activation checks: no server, email, GetCourse or real database."""
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


enable = module('public_enable', 'enable-auth-public.py')
support = module('public_support', 'check-auth-browser.py')
NGINX = Path(__file__).with_name('nginx-domain.conf').read_text(encoding='utf-8')


class ActivationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.env = self.root / 'auth.env'
        self.original = b'AUTH_ENABLED=false\nAUTH_HMAC_SECRET=private-test-placeholder\n'
        self.env.write_bytes(self.original)
        self.nginx = self.root / 'nginx.conf'
        self.nginx.write_text(NGINX, encoding='utf-8')
        self.checks = self.root / 'checks'
        self.checks.mkdir()
        self.runtime = self.root / 'runtime.env'
        self.dropin = self.root / 'dropin.conf'
        self.events = []
        self.enabled = False
        self.boot = False
        self.fail_command = None
        self.bad_health = False
        self.timer = False
        self.patches = [patch.object(support, 'ENV_FILE', self.env),
                        patch.object(support, 'NGINX_FILE', self.nginx),
                        patch.object(support, 'QA_ROOT', self.checks),
                        patch.object(support, 'RUN_ENV', self.runtime),
                        patch.object(support, 'DROPIN', self.dropin),
                        patch.object(support, 'preflight'),
                        patch.object(support, 'run', side_effect=self.fake_run),
                        patch.object(support, 'wait_for_session', side_effect=self.health),
                        patch.object(enable, 'check_secret_file'),
                        patch.object(enable, 'BACKUPS', self.root / 'backups'),
                        patch.object(enable.subprocess, 'run', side_effect=self.direct_run)]
        for item in self.patches:
            item.start()

    def tearDown(self):
        for item in reversed(self.patches):
            item.stop()
        self.temp.cleanup()

    def direct_run(self, args, **kwargs):
        return self.fake_run(*args)

    def fake_run(self, *args, **kwargs):
        self.events.append(args)
        if self.fail_command and self.fail_command(args):
            self.fail_command = None
            raise subprocess.CalledProcessError(1, args, stderr=b'private-error-output')
        if args[:2] == ('/usr/bin/systemctl', 'list-units'):
            return SimpleNamespace(stdout=b'wep-pril-auth-browser-123.timer' if self.timer else b'')
        if args[:2] == ('/usr/bin/systemctl', 'show'):
            return SimpleNamespace(stdout=b'enabled\n' if self.boot else b'disabled\n')
        if args[:2] == ('/usr/bin/systemctl', 'restart'):
            self.enabled = b'AUTH_ENABLED=true\n' in self.env.read_bytes()
        elif args[:2] == ('/usr/bin/systemctl', 'enable'):
            self.boot = True
        elif args[:2] == ('/usr/bin/systemctl', 'disable'):
            self.boot = False
        elif args[:2] == ('/usr/bin/systemctl', 'stop'):
            self.enabled = False
        elif args[:2] == ('/usr/bin/systemctl', 'is-enabled') and not self.boot:
            raise RuntimeError('Boot enablement failed')
        return SimpleNamespace(stdout=b'')

    def health(self, expected):
        if self.enabled != expected or (expected and self.bad_health):
            raise RuntimeError('Unexpected health')

    def test_success_changes_only_flag_and_enables_boot(self):
        backup = enable.activate(support)
        self.assertTrue(self.enabled)
        self.assertTrue(self.boot)
        self.assertEqual(backup.read_bytes(), self.original)
        self.assertEqual(self.env.read_bytes(), self.original.replace(b'false', b'true', 1))
        self.assertEqual(self.nginx.read_text(encoding='utf-8'), NGINX)
        self.assertFalse(self.runtime.exists())
        self.assertFalse(self.dropin.exists())

    def test_failed_restart_rolls_back_disabled_configuration(self):
        self.fail_command = lambda args: args[:2] == ('/usr/bin/systemctl', 'restart')
        with self.assertRaises(enable.ActivationFailure) as caught:
            enable.activate(support)
        self.assertEqual(caught.exception.rollback, 'CLOSED')
        self.assertEqual(self.env.read_bytes(), self.original)
        self.assertFalse(self.enabled)
        self.assertFalse(self.boot)

    def test_failed_health_rolls_back_before_boot_enablement(self):
        self.bad_health = True
        with self.assertRaises(enable.ActivationFailure):
            enable.activate(support)
        self.assertEqual(self.env.read_bytes(), self.original)
        self.assertFalse(self.enabled)
        self.assertFalse(self.boot)

    def test_failed_boot_check_rolls_back_and_restores_previous_mode(self):
        self.fail_command = lambda args: args[:2] == ('/usr/bin/systemctl', 'is-enabled')
        with self.assertRaises(enable.ActivationFailure):
            enable.activate(support)
        self.assertEqual(self.env.read_bytes(), self.original)
        self.assertFalse(self.boot)
        self.assertFalse(self.enabled)

    def test_failed_activation_preserves_existing_boot_enablement(self):
        self.boot = True
        self.bad_health = True
        with self.assertRaises(enable.ActivationFailure):
            enable.activate(support)
        self.assertEqual(self.env.read_bytes(), self.original)
        self.assertTrue(self.boot)
        self.assertFalse(self.enabled)

    def test_concurrent_secret_change_is_not_overwritten_and_service_is_stopped(self):
        self.boot = True
        changed = self.original.replace(b'false', b'true', 1) + b'OTHER=changed-concurrently\n'
        def fail_health(expected):
            if expected:
                self.env.write_bytes(changed)
                raise RuntimeError('Concurrent change during failed health check')
        with patch.object(support, 'wait_for_session', side_effect=fail_health):
            with self.assertRaises(enable.ActivationFailure) as caught:
                enable.activate(support)
        self.assertEqual(caught.exception.rollback, 'SERVICE_STOPPED_REVIEW_REQUIRED')
        self.assertEqual(self.env.read_bytes(), changed)
        self.assertFalse(self.enabled)
        self.assertFalse(self.boot)

    def test_stale_timer_or_override_prevents_writing_secrets(self):
        self.timer = True
        with self.assertRaises(RuntimeError):
            enable.activate(support)
        self.assertEqual(self.env.read_bytes(), self.original)
        self.timer = False
        self.runtime.write_text('AUTH_ENABLED=true\n', encoding='utf-8')
        with self.assertRaises(RuntimeError):
            enable.activate(support)
        self.assertEqual(self.env.read_bytes(), self.original)

    def test_unclosed_check_or_ip_guard_prevents_public_activation(self):
        saved = self.checks / '123'
        saved.mkdir()
        state = saved / 'state.json'
        state.write_text(json.dumps({'closed':False}), encoding='utf-8')
        with self.assertRaises(RuntimeError):
            enable.activate(support)
        state.write_text(json.dumps({'closed':True}), encoding='utf-8')
        self.nginx.write_text(NGINX + '\n# WEBPRIL_AUTH_BROWSER_CHECK\n', encoding='utf-8')
        with self.assertRaises(RuntimeError):
            enable.activate(support)
        self.assertEqual(self.env.read_bytes(), self.original)

    def test_repeat_does_not_rewrite_secrets_or_restart_service(self):
        enable.activate(support)
        self.events.clear()
        self.assertIsNone(enable.activate(support))
        self.assertFalse(any(event[:2] == ('/usr/bin/systemctl','restart') for event in self.events))
        self.assertTrue(self.enabled)
        self.assertTrue(self.boot)


class FlagTests(unittest.TestCase):
    def test_flag_edit_preserves_crlf_and_other_values(self):
        source = b'OTHER="private value"\r\nAUTH_ENABLED=false\r\n'
        self.assertEqual(enable.enabled_environment(source), source.replace(b'false',b'true'))

    def test_missing_flag_is_added_and_ambiguous_flags_are_rejected(self):
        self.assertEqual(enable.enabled_environment(b'OTHER=value'), b'OTHER=value\nAUTH_ENABLED=true\n')
        for source in (b'AUTH_ENABLED=false\nAUTH_ENABLED=true\n', b'AUTH_ENABLED="false"\n'):
            with self.assertRaises(RuntimeError):
                enable.enabled_environment(source)


if __name__ == '__main__':
    unittest.main()
