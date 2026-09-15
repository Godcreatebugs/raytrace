import io
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest
from project_manager import snapshot, allowed
from projects import validate_archive
from project_broker import authorize
import hashlib

class ProjectTests(unittest.TestCase):
    def test_proxy_token_revocation_and_deleted_sandbox(self):
        with tempfile.TemporaryDirectory() as temp:
            state=Path(temp);path=state/'project.json'
            record={'status':'created','proxy_token_hash':hashlib.sha256(b'test-token').hexdigest()}
            path.write_text(json.dumps(record))
            self.assertIsNotNone(authorize(state,'test-token'))
            self.assertIsNone(authorize(state,'wrong-token'))
            record['status']='deleted';path.write_text(json.dumps(record))
            self.assertIsNone(authorize(state,'test-token'))
            record.pop('proxy_token_hash');path.write_text(json.dumps(record))
            self.assertIsNone(authorize(state,'test-token'))
    def test_secret_and_generated_exclusions(self):
        for name in ['.env', '.env.local', 'sub/.env', 'secret.pem', '.npmrc', '.git/config', 'node_modules/a.js']:
            self.assertFalse(allowed(name), name)
        self.assertTrue(allowed('src/main.py'))

    def test_import_preserves_edits_excludes_secrets_and_links(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)/'repo'; root.mkdir()
            subprocess.run(['git','init','-q',str(root)],check=True)
            (root/'main.py').write_text('modified working tree')
            (root/'.env').write_text('SECRET=never-copy')
            (root/'link').symlink_to('/etc/passwd')
            subprocess.run(['git','-C',str(root),'add','main.py','.env','link'],check=True)
            archive = Path(temp)/'input.tar.gz'
            manifest, skipped, _ = snapshot(root, archive)
            self.assertEqual(set(manifest), {'main.py'})
            self.assertIn('.env', skipped)
            self.assertIn('link', skipped)
            validate_archive(archive)
            with tarfile.open(archive) as tar:
                self.assertEqual(tar.extractfile('main.py').read(), b'modified working tree')

    def test_archive_rejects_traversal_and_links(self):
        for name, kind in [('../escape',tarfile.REGTYPE),('/absolute',tarfile.REGTYPE),('link',tarfile.SYMTYPE)]:
            with tempfile.TemporaryDirectory() as temp:
                path=Path(temp)/'bad.tar.gz'
                with tarfile.open(path,'w:gz') as tar:
                    entry=tarfile.TarInfo(name);entry.type=kind;entry.linkname='/etc/passwd'
                    tar.addfile(entry,io.BytesIO())
                with self.assertRaises(ValueError):validate_archive(path)

if __name__=='__main__':unittest.main()
