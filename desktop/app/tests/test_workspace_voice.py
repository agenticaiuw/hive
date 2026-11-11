import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "python"))
import voice_agent


class WorkspaceVoiceTests(unittest.TestCase):
    def test_speech_follows_workspace_visibility(self):
        with tempfile.TemporaryDirectory() as folder, \
             mock.patch.dict(os.environ, {"AGENT_SPACEO_COMMAND": "/test"}), \
             mock.patch.object(voice_agent, "state_dir", return_value=Path(folder)):
            self.assertFalse(voice_agent.workspace_voice_allowed())
            state = Path(folder) / "workspace-viewer-visible"
            state.write_text("1\n")
            self.assertTrue(voice_agent.workspace_voice_allowed())
            state.write_text("0\n")
            self.assertFalse(voice_agent.workspace_voice_allowed())

    def test_non_workspace_mode_keeps_voice(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertTrue(voice_agent.workspace_voice_allowed())


if __name__ == "__main__":
    unittest.main()
