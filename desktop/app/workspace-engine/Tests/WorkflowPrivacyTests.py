"""Exercise the actual workflow command blocks with harmless fake commands."""

import os
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent


class WorkflowPrivacyTests(unittest.TestCase):
    def test_retained_publication_is_atomic_and_refuses_moved_tag(self):
        workflow = (ROOT / ".github/workflows/publish-retained.yml").read_text()
        block = workflow.split("      - name: Publish verified assets and scope together\n", 1)[1]
        command = textwrap.dedent(block.split("        run: |\n", 1)[1])
        for moved in (False, True):
            with self.subTest(moved=moved), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                tools = root / "bin"
                tools.mkdir()
                notes = "Hosting Viewer inside a SpaceO virtual display is unsupported"
                (root / "spaceo-release-notes.md").write_text(notes)
                stub = tools / "gh"
                stub.write_text('''#!/usr/bin/env python3
import os, pathlib, sys
args = sys.argv[1:]
if args[0] == 'api':
    print(os.environ['MOCK_REMOTE_TAG'])
elif args[:2] == ['release', 'create']:
    assert '--notes-file' in args and '--generate-notes' not in args
    notes = pathlib.Path(args[args.index('--notes-file') + 1]).read_text()
    assert 'Hosting Viewer inside a SpaceO virtual display is unsupported' in notes
    assert len([a for a in args if '/spaceo-release-candidate/' in a]) == 5
    pathlib.Path(os.environ['RUNNER_TEMP'], 'published').touch()
else:
    sys.exit(2)
''')
                stub.chmod(0o700)
                env = dict(os.environ, PATH=str(tools) + os.pathsep + os.environ["PATH"],
                           RUNNER_TEMP=directory, GITHUB_REPOSITORY="ParthJadhav/SpaceO",
                           SPACEO_RELEASE_TAG_OBJECT="expected",
                           MOCK_REMOTE_TAG="moved" if moved else "expected")
                result = subprocess.run(["/bin/bash", "-c", command], env=env,
                                        text=True, capture_output=True)
                self.assertEqual(result.returncode == 0, not moved, result.stderr)
                self.assertEqual((root / "published").exists(), not moved)


if __name__ == "__main__":
    unittest.main()
