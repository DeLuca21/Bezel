"""Exercise the installer in a temporary repository and XDG data directory."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

INSTALLER = Path(__file__).resolve().parent.parent / 'scripts/install-local.py'
UUID = 'bezel@deluca21'


def manifest(root):
    return {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in root.rglob('*') if p.is_file()}


class LocalInstallTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='bezel-install-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / 'scripts').mkdir()
        shutil.copy2(INSTALLER, self.root / 'scripts/install-local.py')
        self.source = self.root / UUID
        (self.source / 'schemas').mkdir(parents=True)
        (self.source / 'metadata.json').write_text(json.dumps({'uuid': UUID}))
        (self.source / 'extension.js').write_text('// first version\n')
        (self.source / 'schemas/test.gschema.xml').write_text(
            '<schemalist><schema id="org.example.bezeltest" path="/org/example/bezeltest/">'
            '<key name="enabled" type="b"><default>false</default></key>'
            '</schema></schemalist>')
        self.data = self.root / 'data'
        self.destination = self.data / 'gnome-shell/extensions' / UUID
        self.env = {**os.environ, 'XDG_DATA_HOME': str(self.data)}

    def run_installer(self, success=True):
        result = subprocess.run(['python3', str(self.root / 'scripts/install-local.py')],
                                env=self.env, text=True, capture_output=True)
        self.assertEqual(result.returncode == 0, success, result.stdout + result.stderr)
        return result

    def test_install_replacement_and_backup(self):
        self.run_installer()
        self.assertTrue((self.destination / 'schemas/gschemas.compiled').is_file())
        previous = manifest(self.destination)
        (self.source / 'extension.js').write_text('// second version\n')
        self.run_installer()
        backups = list((self.root / '.backups').glob('local-install-*/' + UUID))
        self.assertEqual(len(backups), 1)
        self.assertEqual(manifest(backups[0]), previous)
        self.assertEqual((self.destination / 'extension.js').read_text(), '// second version\n')
        self.assertEqual(list(self.destination.parent.glob('.bezel-install-*')), [])

    def test_invalid_schema_preserves_installed_files(self):
        self.run_installer()
        previous = manifest(self.destination)
        (self.source / 'schemas/test.gschema.xml').write_text('<invalid>')
        self.run_installer(success=False)
        self.assertEqual(manifest(self.destination), previous)

    def test_symlink_installation_is_preserved(self):
        target = self.root / 'external-extension'
        target.mkdir()
        (target / 'keep').write_text('unchanged')
        self.destination.parent.mkdir(parents=True)
        self.destination.symlink_to(target, target_is_directory=True)
        self.run_installer(success=False)
        self.assertTrue(self.destination.is_symlink())
        self.assertEqual((target / 'keep').read_text(), 'unchanged')

    def test_uuid_mismatch_does_not_install(self):
        (self.source / 'metadata.json').write_text(json.dumps({'uuid': 'different'}))
        self.run_installer(success=False)
        self.assertFalse(self.destination.exists())


if __name__ == '__main__':
    unittest.main()
