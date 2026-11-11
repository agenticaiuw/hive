"""Turning listening off with fn quiets the voice but leaves the agent working; the floating
window's x stops both devices. Neither turns unfinished speech into a task. fn while you have
control of a running task hands control back."""
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

    def test_fn_off_quiets_but_keeps_tasks(self):
        agent = self.make_agent()
        mac, phone = agent.tasks.values()
        agent.set_listening(False)
        mac.stop.assert_not_called()
        phone.stop.assert_not_called()
        agent.voice.stop.assert_called_once()
        agent.captions.listening.assert_called_once_with(False)
        agent.on_heard("unfinished request", True)
        agent.on_transcript.assert_not_called()

    def test_window_x_stops_all_tasks_and_speech(self):
        agent = self.make_agent()
        mac, phone = agent.tasks.values()
        agent.paused_since, agent.pause_announced = 0.0, False
        agent.on_overlay("close")
        mac.stop.assert_called_once()
        phone.stop.assert_called_once()
        agent.voice.stop.assert_called_once()
        agent.mac.disengage.assert_called_once()
        self.assertEqual(agent.tasks, {"mac": None, "phone": None})

    def test_fn_tap_after_takeover_resumes(self):
        agent = self.make_agent()
        agent.paused_since = voice_agent.time.time() - 5
        agent.tasks["mac"]._recovery_id = None
        agent.take_control = mock.Mock()
        agent.set_listening = mock.Mock()
        agent.on_helper({"fn": "tap"})
        agent.take_control.assert_called_once()
        agent.set_listening.assert_not_called()

    def test_touching_just_as_it_takes_control_pauses_and_fn_resumes(self):
        agent = self.make_agent()
        agent.paused_since, agent.pause_announced = 0.0, False
        agent.tasks["mac"]._recovery_id = None
        agent.on_helper({"state": "disengaged", "reason": "engage_cancelled_by_trackpad"})
        self.assertTrue(agent.paused_since)
        agent.captions.paused.assert_called_once_with("Paused: you took over. Press fn to let the agent continue.")
        agent.paused_since -= 5
        agent.take_control = mock.Mock()
        agent.set_listening = mock.Mock()
        agent.on_helper({"fn": "tap"})
        agent.take_control.assert_called_once()
        agent.set_listening.assert_not_called()

    def test_fn_never_says_it_stops_the_agent(self):
        swift = (Path(__file__).resolve().parents[1] / "tools" / "captions.swift").read_text()
        self.assertNotIn("tap fn to stop", swift)

    def test_fn_tap_that_itself_took_over_toggles_listening(self):
        agent = self.make_agent()
        agent.paused_since = voice_agent.time.time()  # this very fn press disengaged it
        agent.take_control = mock.Mock()
        agent.set_listening = mock.Mock()
        agent.on_helper({"fn": "tap"})
        agent.take_control.assert_not_called()
        agent.set_listening.assert_called_once_with(False)

    def test_mute_keeps_microphone_off(self):
        agent = self.make_agent()
        opened = []
        agent.muted = False
        agent.ears.listen = lambda on: opened.append(bool(on) and not agent.muted)
        agent.on_overlay("mute", True)
        self.assertEqual(opened[-1], False)
        agent.on_overlay("mute", False)
        self.assertEqual(opened[-1], True)

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
