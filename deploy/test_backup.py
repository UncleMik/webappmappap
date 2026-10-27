import datetime
import importlib.util
import json
import pathlib
import sqlite3
import subprocess
import tempfile
import unittest
from contextlib import closing
from types import SimpleNamespace
from unittest.mock import patch


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, pathlib.Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


backup = load('webpril_backup', 'backup.py')
verify = load('webpril_verify_backup', 'verify-backup.py')
STAMP = datetime.datetime(2026, 10, 27, 3, 15, tzinfo=datetime.timezone.utc)
LISTING = '''100; 1259 10 TABLE public auth_users postgres
101; 1259 11 TABLE public auth_sessions postgres
102; 1259 12 TABLE public course_access_checks postgres
103; 0 10 TABLE DATA public auth_users postgres
104; 0 11 TABLE DATA public auth_sessions postgres
105; 0 12 TABLE DATA public course_access_checks postgres
'''


class BackupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        (self.root / 'data').mkdir()
        (self.root / 'uploads').mkdir()
        (self.root / 'uploads' / 'sample.txt').write_text('fixture', encoding='utf-8')
        with closing(sqlite3.connect(self.root / 'data' / 'articles.sqlite')) as db:
            db.execute('CREATE TABLE articles (id INTEGER)')
            db.execute('INSERT INTO articles VALUES (1)')
            db.commit()
        self.calls = []
        self.posix = patch.object(backup, 'require_posix')
        self.posix.start()
        self.addCleanup(self.posix.stop)

    def command(self, arguments, **kwargs):
        self.calls.append(arguments)
        if 'pg_dump' in arguments:
            kwargs['stdout'].write(b'pgdump-fixture')
        return SimpleNamespace(stdout=LISTING if '--list' in arguments else '')

    def test_complete_only_after_all_three_verified_and_old_completed_rotated(self):
        folder = self.root / 'backups'
        folder.mkdir()
        for day in range(1, 8):
            old = folder / f'202610{day:02}T031500Z'
            old.mkdir()
            (old / 'complete').write_text('ok\n')
        incomplete = folder / '20261008T031500Z'
        incomplete.mkdir()
        target = backup.run_backup(self.root, command=self.command, now=STAMP)
        self.assertEqual((target / 'complete').read_text(), 'ok\n')
        self.assertEqual(len(json.loads((target / 'manifest.json').read_text())['files']), 3)
        self.assertFalse((folder / '20261001T031500Z').exists())
        self.assertTrue(incomplete.exists())
        self.assertIn(['pg_restore', '--file', '/dev/null', str(target / 'auth.pgcustom')], self.calls)
        with closing(sqlite3.connect(target / 'articles.sqlite')) as db:
            self.assertEqual(db.execute('SELECT count(*) FROM articles').fetchone()[0], 1)

    def test_failed_postgres_validation_never_marks_or_rotates(self):
        folder = self.root / 'backups'
        folder.mkdir()
        old = folder / '20261001T031500Z'
        old.mkdir()
        (old / 'complete').write_text('ok\n')

        def failing(arguments, **kwargs):
            if '--file' in arguments:
                raise subprocess.CalledProcessError(1, arguments)
            return self.command(arguments, **kwargs)

        with self.assertRaises(subprocess.CalledProcessError):
            backup.run_backup(self.root, command=failing, now=STAMP)
        self.assertFalse((folder / '20261027T031500Z' / 'complete').exists())
        self.assertTrue(old.exists())

    def test_failed_dump_never_marks_complete(self):
        def failing(arguments, **kwargs):
            if 'pg_dump' in arguments:
                raise subprocess.CalledProcessError(1, arguments)
            return self.command(arguments, **kwargs)

        with self.assertRaises(subprocess.CalledProcessError):
            backup.run_backup(self.root, command=failing, now=STAMP)
        self.assertFalse((self.root / 'backups' / '20261027T031500Z' / 'complete').exists())


class RestoreTests(unittest.TestCase):
    def setUp(self):
        BackupTests.setUp(self)
        self.verify_posix = patch.object(verify, 'require_posix')
        self.verify_posix.start()
        self.addCleanup(self.verify_posix.stop)
        self.target = backup.run_backup(self.root, command=self.command, now=STAMP)
        self.calls.clear()

    def command(self, arguments, **kwargs):
        self.calls.append(arguments)
        if 'pg_dump' in arguments:
            kwargs['stdout'].write(b'pgdump-fixture')
        if '--list' in arguments:
            return SimpleNamespace(stdout=LISTING)
        if 'psql' in arguments:
            query = arguments[arguments.index('-c') + 1]
            if 'tablename FROM' in query:
                return SimpleNamespace(stdout='auth_sessions\nauth_users\ncourse_access_checks\n')
            if 'shobj_description' in query:
                return SimpleNamespace(stdout='wep_pril_restore_check:abcdef0123456789\n')
        return SimpleNamespace(stdout='')

    def test_isolated_restore_checks_tables_and_drops_only_marked_db(self):
        result = verify.verify_backup(self.target, root=self.root, command=self.command,
                                      suffix='abcdef0123456789')
        name = 'wep_pril_restore_check_abcdef0123456789'
        self.assertEqual(result['tables'], 3)
        self.assertTrue(any('createdb' in call and name in call for call in self.calls))
        self.assertTrue(any('pg_restore' in call and '-d' in call and name in call for call in self.calls))
        self.assertTrue(any('dropdb' in call and name in call for call in self.calls))
        self.assertFalse(any('dropdb' in call and 'wep_pril_auth' in call for call in self.calls))

    def test_tampering_is_rejected_before_database_creation(self):
        with (self.target / 'auth.pgcustom').open('ab') as file:
            file.write(b'bad')
        with self.assertRaisesRegex(RuntimeError, 'checksum'):
            verify.verify_backup(self.target, root=self.root, command=self.command,
                                 suffix='abcdef0123456789')
        self.assertFalse(any('createdb' in call for call in self.calls))

    def test_bad_marker_preserves_check_database(self):
        original = self.command

        def wrong_marker(arguments, **kwargs):
            value = original(arguments, **kwargs)
            if 'shobj_description' in ' '.join(arguments):
                return SimpleNamespace(stdout='wrong\n')
            return value

        with self.assertRaisesRegex(RuntimeError, 'marker differs'):
            verify.verify_backup(self.target, root=self.root, command=wrong_marker,
                                 suffix='abcdef0123456789')
        self.assertFalse(any('dropdb' in call for call in self.calls))


if __name__ == '__main__':
    unittest.main()
