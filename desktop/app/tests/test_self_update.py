"""Prepared updates are handed off outside the running agent process."""
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'python'))
os.environ['AGENT_BACKEND'] = 'codex'
import voice_agent


class UpdateTest(unittest.TestCase):
    def test_claims_pending_update_and_detaches(self):
        with tempfile.TemporaryDirectory() as directory, \
             mock.patch.object(voice_agent, 'state_dir', return_value=Path(directory)), \
             mock.patch.object(voice_agent.subprocess, 'Popen') as popen:
            marker = Path(directory) / 'update-pending'
            marker.write_text('ready\n')
            instance = mock.Mock()
            voice_agent.VoiceAgent._apply_scheduled_update(instance)
            self.assertFalse(marker.exists())
            self.assertTrue((Path(directory) / 'update-applying').exists())
            self.assertTrue(popen.call_args.kwargs['start_new_session'])

    def test_failed_handoff_restores_pending(self):
        with tempfile.TemporaryDirectory() as directory, \
             mock.patch.object(voice_agent, 'state_dir', return_value=Path(directory)), \
             mock.patch.object(voice_agent.subprocess, 'Popen', side_effect=OSError('failed')):
            marker = Path(directory) / 'update-pending'
            marker.write_text('ready\n')
            voice_agent.VoiceAgent._apply_scheduled_update(mock.Mock())
            self.assertTrue(marker.exists())

    def test_claims_handoff_in_writable_updates_directory(self):
        with tempfile.TemporaryDirectory() as directory, \
             mock.patch.object(voice_agent, 'state_dir', return_value=Path(directory)), \
             mock.patch.object(voice_agent.subprocess, 'Popen') as popen:
            updates = Path(directory) / 'updates'
            updates.mkdir()
            (updates / 'update-pending').write_text('ready\n')
            voice_agent.VoiceAgent._apply_scheduled_update(mock.Mock())
            self.assertTrue((updates / 'update-applying').exists())
            self.assertTrue(popen.call_args.kwargs['start_new_session'])


if __name__ == '__main__':
    unittest.main()
