"""Validate the standalone reference catalog without touching evidence databases."""
from pathlib import Path
import sqlite3
import tempfile
import unittest


CATALOG = Path(__file__).with_name('syscall_catalog.sql')
REQUIRED = {
    'open', 'openat', 'openat2', 'creat',
    'write', 'writev', 'pwrite64', 'pwritev', 'pwritev2',
    'unlink', 'unlinkat', 'rmdir', 'rename', 'renameat', 'renameat2',
    'truncate', 'ftruncate', 'mkdir', 'mkdirat',
}


class SyscallCatalogTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.db = sqlite3.connect(Path(self.temp.name) / 'catalog.db')
        self.addCleanup(self.db.close)
        self.sql = CATALOG.read_text()
        self.db.executescript(self.sql)

    def snapshot(self):
        return {
            name: self.db.execute(f'SELECT * FROM {name} ORDER BY 1').fetchall()
            for name in ('syscall_impact_levels', 'syscall_categories',
                         'syscall_catalog', 'syscall_catalog_readable')
        }

    def test_reimport_is_idempotent_and_preserves_unrelated_tables(self):
        before = self.snapshot()
        self.db.executescript("CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES ('keep');")
        self.db.executescript(self.sql)
        self.assertEqual(before, self.snapshot())
        self.assertEqual(self.db.execute('SELECT value FROM sentinel').fetchone(), ('keep',))
        self.assertEqual(self.db.execute('PRAGMA user_version').fetchone(), (0,))

    def test_required_syscalls_are_present_once_and_named(self):
        rows = self.db.execute('SELECT syscall_name FROM syscall_catalog').fetchall()
        names = [row[0] for row in rows]
        self.assertTrue(REQUIRED <= set(names), REQUIRED - set(names))
        self.assertEqual(len(names), len(set(names)))
        for name in names:
            self.assertRegex(name, r'^[a-z][a-z0-9_]*$')
        self.assertEqual(self.db.execute('PRAGMA foreign_key_check').fetchall(), [])
        self.assertEqual(self.db.execute('SELECT DISTINCT catalog_version FROM syscall_catalog').fetchall(), [(1,)])

    def test_lookup_and_conditional_defaults(self):
        self.assertEqual(self.db.execute(
            "SELECT category, default_impact_level FROM syscall_catalog_readable WHERE syscall_name='unlinkat'"
        ).fetchone(), ('Delete', 3))
        for name in ('openat', 'renameat2', 'ioctl', 'mmap', 'close', 'sendfile'):
            level, rule, evidence, notes = self.db.execute(
                'SELECT default_impact_level, classification_rule, required_evidence, interpretation_notes '
                'FROM syscall_catalog WHERE syscall_name=?', (name,)
            ).fetchone()
            self.assertIsNone(level, name)
            self.assertTrue(all(text.strip() for text in (rule, evidence, notes)), name)
        self.assertIsNone(self.db.execute(
            'SELECT * FROM syscall_catalog_readable WHERE syscall_name=?', ('unknown_syscall',)
        ).fetchone())

    def test_constraints_reject_invalid_classification(self):
        changes = [
            "UPDATE syscall_catalog SET category_id='missing' WHERE syscall_name='unlinkat'",
            "UPDATE syscall_catalog SET default_impact_level=4 WHERE syscall_name='unlinkat'",
            "UPDATE syscall_catalog SET classification_rule='' WHERE syscall_name='openat'",
            "UPDATE syscall_catalog SET required_evidence='' WHERE syscall_name='openat'",
            "UPDATE syscall_catalog SET catalog_version=0 WHERE syscall_name='openat'",
            "INSERT INTO syscall_impact_levels VALUES (4, 'Invalid', 'Invalid')",
        ]
        for statement in changes:
            with self.subTest(statement=statement):
                with self.assertRaises(sqlite3.IntegrityError):
                    self.db.execute(statement)
                self.db.rollback()

    def test_all_entries_have_documented_rules_and_evidence(self):
        documentation = CATALOG.with_name('SYSCALL_CATALOG.md').read_text()
        for name, rule, evidence, notes in self.db.execute(
            'SELECT syscall_name, classification_rule, required_evidence, interpretation_notes FROM syscall_catalog'
        ):
            with self.subTest(syscall=name):
                self.assertIn(f'| `{rule}` |', documentation)
                self.assertTrue(evidence.strip())
                self.assertTrue(notes.strip())


if __name__ == '__main__':
    unittest.main()
