"""Speech model availability must not block the workspace and request loop."""
import os
import sys
import unittest
from pathlib import Path
from unittest import mock
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'python'))
os.environ.setdefault('AGENT_ENV_FILE', '/dev/null')
import voice_agent

class StartupTests(unittest.TestCase):
    def test_main_enters_request_loop_without_waiting_for_speech(self):
        agent = mock.Mock()
        agent.ears.describe.side_effect = AssertionError('startup waited for speech')
        with mock.patch.object(voice_agent.settings, 'load'), \
             mock.patch.object(voice_agent.settings, 'fix_newlines'), \
             mock.patch.object(voice_agent, 'find_codex'), \
             mock.patch.object(voice_agent, 'warm_up'), \
             mock.patch.object(voice_agent, 'wait_for_helper', return_value=True), \
             mock.patch.object(voice_agent, 'AgentVHID'), \
             mock.patch.object(voice_agent, 'Captions'), \
             mock.patch.object(voice_agent, 'VoiceAgent', return_value=agent), \
             mock.patch.object(voice_agent.signal, 'signal'):
            self.assertEqual(voice_agent.main(['--no-speak']), 0)
        agent.run.assert_called_once()
        agent.ears.describe.assert_not_called()

    def test_failed_speech_announces_typed_fallback(self):
        agent = voice_agent.VoiceAgent.__new__(voice_agent.VoiceAgent)
        agent.ears = mock.Mock(model=None)
        agent.ears.describe.return_value = 'missing model'
        agent.out = mock.Mock()
        agent.tell = mock.Mock()
        agent.announce_audio()
        agent.tell.assert_called_once_with('status', 'Voice input unavailable; typed requests are ready')

if __name__ == '__main__':
    unittest.main()
