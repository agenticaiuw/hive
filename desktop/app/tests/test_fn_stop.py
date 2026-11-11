"""Fn close cancels both devices and does not turn unfinished speech into a task."""
import queue
import sys
from pathlib import Path
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "python"))
import voice_agent


class FnStopTest(unittest.TestCase):
    def make_agent(self):
        a = voice_agent.VoiceAgent.__new__(voice_agent.VoiceAgent)
        a.app = False
        a.listening = True
        a.input_mode = "voice"
        a._discard_heard = False
        a._heard_barrier = 0
        a.held = None
        a.dictation = None
        a.events = queue.Queue()
        a.ears = mock.Mock()
        a.captions = mock.Mock()
        a.voice = mock.Mock()
        a.mac = mock.Mock()
        a.tasks = {"mac": mock.Mock(running=True), "phone": mock.Mock(running=True)}
        a.doing = {"mac": "Working"}
        a.timing = {}
        a.out = mock.Mock()
        a.on_transcript = mock.Mock()
        return a

    def test_close_stops_all_tasks_and_speech(self):
        agent = self.make_agent()
        mac, phone = agent.tasks.values()
        agent.set_listening(False)
        mac.stop.assert_called_once()
        phone.stop.assert_called_once()
        agent.voice.stop.assert_called_once()
        agent.mac.disengage.assert_called_once()
        agent.captions.listening.assert_called_once_with(False)
        self.assertEqual(agent.tasks, {"mac": None, "phone": None})
        agent.on_heard("unfinished request", True)
        agent.on_transcript.assert_not_called()

    def test_late_transcript_is_discarded_even_if_reopened(self):
        agent = self.make_agent()
        agent.set_listening(False)
        with mock.patch.object(voice_agent, "new_session"):
            agent.set_listening(True)
        agent.on_heard("late final", True)
        agent.on_transcript.assert_not_called()
        callback = agent.ears.cut.call_args.kwargs["then"]
        callback()
        kind, barrier = agent.events.get_nowait()
        self.assertEqual(kind, "heard_barrier")
        self.assertEqual(barrier, agent._heard_barrier)


if __name__ == "__main__":
    unittest.main()
