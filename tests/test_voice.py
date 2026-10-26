"""Runs the voice agent against the helper in --dry-run mode and a fake Codex, with speech made
by `say` standing in for the microphone and Parakeet really transcribing it: it listens all the
time, the words show up as you talk, a pause ends what you said, talking over it stops its
voice, and with echo cancellation its own voice coming back into the microphone isn't taken for
you. Nothing is played aloud: `say` writes files and the agent's voice is a stand-in.

    .venv/bin/python tests/test_voice.py
"""

import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import wave
from unittest import mock

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(ROOT, "python"))

from test_dry_run import Helper  # noqa: E402
from agent_vhid import AgentVHID, AgentVHIDError  # noqa: E402
import agent  # noqa: E402
import listen  # noqa: E402
import mic  # noqa: E402
import voice_agent  # noqa: E402

FAKE_CODEX = os.path.join(HERE, "fake_codex.py")
SPEECH = tempfile.mkdtemp(prefix="voice-speech-")
EARS = None  # loading Parakeet takes a few seconds; the tests share it
BLOCK = 800  # 50 ms of "microphone" at a time


def speech(text: str, voice: str = "Samantha") -> np.ndarray:
    """`text` spoken by one of the Mac's voices, as 16 kHz mono float32 like the microphone gives."""
    wav = os.path.join(SPEECH, "s.wav")
    subprocess.run(["say", "-v", voice, "-o", wav, "--file-format=WAVE", "--data-format=LEI16@16000", text],
                   check=True)
    with wave.open(wav) as w:
        return np.frombuffer(w.readframes(w.getnframes()), "<i2").astype(np.float32) / 32768


def silence(seconds: float) -> np.ndarray:
    return np.zeros(int(seconds * listen.RATE), np.float32)


def noise(seconds: float) -> np.ndarray:
    """A fan and a couple of keyboard clicks: not speech."""
    x = np.random.default_rng(0).standard_normal(int(seconds * listen.RATE)).astype(np.float32) * 0.003
    for at in (0.4, 1.1):
        i = int(at * listen.RATE)
        x[i:i + 80] += np.hanning(80).astype(np.float32) * 0.3
    return x


def setup_ears():
    global EARS
    if EARS is None:
        EARS = listen.Ears(lambda *_: None, mic=False)
    if not EARS.describe().startswith("Parakeet"):
        raise unittest.SkipTest(f"Parakeet isn't set up ({EARS.error}); ./voice.sh does it")


def wait_for(check, what: str, timeout: float = 20):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if check():
            return
        time.sleep(0.05)
    raise AssertionError(f"timed out waiting for {what}")


class Voice:
    """Stands in for speech.Voice: writes down what it was asked to say. `playing` is whether
    it's audible right now."""

    def __init__(self):
        self.said: list[str] = []
        self.calls: list[str] = []
        self.playing = False

    def say(self, text):
        self.said.append(text)

    def stop(self):
        self.calls.append("stop")
        self.playing = False

    def audible(self):
        return self.playing


class Captions:
    """Stands in for the on-screen captions: writes down what they'd show."""

    def __init__(self):
        self.words: list[str] = []
        self.doings: list[str] = []

    def say(self, words):
        self.words.append(words)

    def doing(self, text):
        self.doings.append(text)

    def close(self):
        pass


class VoiceAgentTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        setup_ears()

    def setUp(self):
        self.helper = Helper("--hands-free")
        self.addCleanup(self.helper.stop)
        self.dir = tempfile.mkdtemp(prefix="voice-")
        self.codex_log = os.path.join(self.dir, "codex.jsonl")
        os.environ.update({"CODEX_BIN": FAKE_CODEX, "FAKE_CODEX_LOG": self.codex_log, "FAKE_CODEX_SECONDS": "0.3"})
        agent.stop_server()  # a fresh fake Codex, which writes to this test's log
        self.addCleanup(agent.stop_server)
        looker = mock.patch("agent.first_look", return_value=None)  # no screenshots of your screen
        looker.start()
        self.addCleanup(looker.stop)
        self.captions = Captions()
        self.agent = voice_agent.VoiceAgent(speak=False, mac=AgentVHID(self.helper.socket), ears=EARS,
                                            captions=self.captions)
        self.agent.voice = Voice()
        self.heard: list[tuple[str, bool]] = []
        self.agent.heard = lambda text, final: (self.heard.append((text, final)),
                                                self.agent.events.put(("heard", (text, final))))
        EARS.on_text = self.agent.heard
        notifier = mock.patch("voice_agent.notify")  # no notifications popping up on the screen
        notifier.start()
        self.addCleanup(notifier.stop)
        self.printed: list[str] = []
        real_print = print
        patcher = mock.patch("builtins.print", lambda *a, **k: (self.printed.append(" ".join(map(str, a))),
                                                               real_print(*a, **k)))
        patcher.start()
        self.addCleanup(patcher.stop)
        self.thread = threading.Thread(target=self.agent.run, daemon=True)
        self.thread.start()
        self.addCleanup(self.agent.shutdown)
        self.gate: list[dict] = []
        threading.Thread(target=self._watch_gate, daemon=True).start()
        time.sleep(0.3)  # the agent is watching the helper

    def _watch_gate(self):
        try:
            for event in AgentVHID(self.helper.socket).watch():
                self.gate.append(event)
        except AgentVHIDError:
            pass  # the helper stopped at the end of the test

    def listen_to(self, samples: np.ndarray):
        """The "microphone" hears samples in real time, then a moment of quiet."""
        samples = np.concatenate([samples, silence(1.6)])
        start = time.time()
        for i in range(0, len(samples), BLOCK):
            EARS.feed(samples[i:i + BLOCK])
            time.sleep(max(0, start + (i + BLOCK) / listen.RATE - time.time()))

    def finals(self) -> list[str]:
        return [text for text, final in self.heard if final]

    def runs(self) -> list[dict]:
        try:
            with open(self.codex_log) as f:
                return [run for run in map(json.loads, f) if "prompt" in run]
        except FileNotFoundError:
            return []

    def prompts(self) -> list[str]:
        return [run["prompt"] for run in self.runs()]

    def test_words_show_up_as_you_talk_and_the_task_goes_to_codex(self):
        self.listen_to(speech("Open Calculator and work out twelve times thirty four."))
        wait_for(lambda: self.prompts(), "codex")
        partial = [text for text, final in self.heard if not final]
        self.assertTrue(any("Open calculator" in text for text in partial), partial)
        self.assertIn("12 times 34", self.prompts()[0])

        wait_for(lambda: self.agent.voice.said, "the reply")
        wait_for(lambda: self.agent.task is None, "the task to finish")
        self.assertEqual(self.agent.voice.said, ["Calculator shows 408."])  # once, though Codex says it twice
        states = [(e.get("state"), e.get("reason")) for e in self.gate if "state" in e]
        self.assertIn(("engaged", "engaged_by_voice"), states)  # no key to hold: --hands-free
        self.assertEqual(states[-1], ("disengaged", "released_by_agent"))

    def test_captions_show_what_its_doing(self):
        self.listen_to(speech("Open Calculator."))
        wait_for(lambda: self.agent.voice.said and self.agent.task is None, "the task to finish")
        self.assertIn("Looking at the screen", self.captions.doings)  # the fake Codex takes a screenshot
        self.assertEqual(self.captions.doings[-1], "")  # and when it's done, nothing
        self.assertTrue(any(line.startswith("✅ done in ") for line in self.printed), self.printed)

    def test_on_the_phone_it_works_on_the_phone_alongside_the_mac(self):
        os.environ["FAKE_CODEX_SECONDS"] = "60"
        self.listen_to(speech("Open Safari."))
        wait_for(lambda: self.prompts(), "codex")
        mac_task = self.agent.task
        self.listen_to(speech("Open Maps on my phone."))
        wait_for(lambda: len(self.prompts()) == 2, "the phone task")
        phone_run = self.runs()[1]
        self.assertIn("iPhone", phone_run["prompt"])
        self.assertIn("maps on my phone", phone_run["prompt"].lower())
        self.assertEqual(phone_run["tools"], ["phone"])  # its tools, not the Mac's
        self.assertIs(self.agent.task, mac_task)  # the Mac task carried on
        self.assertTrue(mac_task.running)
        self.assertTrue(self.agent.tasks["phone"].running)
        self.listen_to(speech("Stop."))  # stops both
        wait_for(lambda: not any(self.agent.tasks.values()), "both tasks to stop")

    def test_a_short_pause_doesnt_cut_you_off(self):
        self.listen_to(np.concatenate([speech("Open Safari."), silence(0.7), speech("Then search for the weather.")]))
        wait_for(lambda: self.prompts(), "codex")
        self.assertIn("Open Safari", self.prompts()[0])
        self.assertIn("search for the weather", self.prompts()[0])

    def test_trailing_off_on_and_waits_longer(self):
        self.listen_to(np.concatenate([speech("Open the browser and"), silence(1.8), speech("search for the weather.")]))
        wait_for(lambda: self.prompts(), "codex")
        time.sleep(0.5)
        self.assertEqual(len(self.prompts()), 1, self.prompts())
        self.assertIn("search for the weather", self.prompts()[0])

    def test_saying_more_right_after_adds_to_the_request(self):
        os.environ["FAKE_CODEX_SECONDS"] = "60"
        self.listen_to(speech("Open Safari."))
        wait_for(lambda: self.prompts(), "codex")
        self.listen_to(speech("And look up the weather in Paris."))
        wait_for(lambda: len(self.prompts()) == 2, "the second request")
        self.assertIn("Open Safari", self.prompts()[1])
        self.assertIn("weather in Paris", self.prompts()[1])
        self.assertIn("   (adding that to what you just asked)", self.printed)

    def test_saying_stop_stops_the_task(self):
        os.environ["FAKE_CODEX_SECONDS"] = "60"
        self.listen_to(speech("Open Safari."))
        wait_for(lambda: self.prompts() and self.agent.task and self.agent.task.running, "codex")
        self.listen_to(speech("Stop."))
        wait_for(lambda: self.agent.task is None, "the task to stop")
        self.assertEqual(self.agent.voice.said, ["Stopped."])
        self.assertEqual(len(self.prompts()), 1)

    def test_noise_and_silence_do_nothing(self):
        self.listen_to(np.concatenate([silence(1), noise(2)]))
        time.sleep(1)
        self.assertEqual(self.heard, [])
        self.assertEqual(self.prompts(), [])

    @mock.patch.object(listen.Ears, "hears_the_mac", return_value=True)  # echo cancellation is working
    def test_talking_over_it_stops_its_voice(self, _):
        self.agent.voice.playing = True
        finals_when_stopped = []
        stop = self.agent.voice.stop
        self.agent.voice.stop = lambda: (finals_when_stopped.append(len(self.finals())), stop())
        self.listen_to(speech("Wait, open Safari instead."))
        wait_for(lambda: self.prompts(), "codex")
        self.assertEqual(finals_when_stopped[0], 0)  # it went quiet as you started, not once you'd finished
        self.assertIn("Safari", self.prompts()[0])

    @mock.patch.object(listen.Ears, "hears_the_mac", return_value=True)
    def test_over_its_voice_its_own_words_are_ignored(self, _):
        self.agent.say("I typed twelve times thirty four into Calculator.")
        self.agent.voice.playing = True
        self.listen_to(speech("typed twelve times thirty four into Calculator", voice="Daniel"))
        wait_for(lambda: self.finals(), "the transcript")
        time.sleep(0.5)
        self.assertEqual(self.prompts(), [])
        self.assertTrue(any("heard its own voice" in line for line in self.printed), self.printed)

    def test_without_echo_cancellation_it_doesnt_listen_while_it_talks(self):
        self.agent.voice.playing = True  # and EARS has no microphone, so nothing hears the Mac
        with mock.patch("audio.output_is_speakers", return_value=True):
            self.listen_to(speech("I opened Calculator for you.", voice="Daniel"))
            self.assertEqual(self.heard, [])
            self.agent.voice.playing = False
            self.listen_to(speech("Open Safari."))
        wait_for(lambda: self.prompts(), "codex")
        self.assertIn("Open Safari", self.prompts()[0])


class EchoCancellationTest(unittest.TestCase):
    """The agent talks out of the "speakers" and its voice comes back into the "microphone"
    through a simulated room; then you cut in. The echo canceller (python/mic.py) gets what the
    Mac played, as build/agent-vhid-tap would give it."""

    @classmethod
    def setUpClass(cls):
        setup_ears()
        cls.microphone = mic.Microphone(EARS.feed, devices=False)
        if cls.microphone.canceller_error:
            raise unittest.SkipTest(f"no echo canceller ({cls.microphone.canceller_error}); ./voice.sh installs it")

    def test_it_hears_you_and_not_its_own_voice(self):
        rate = listen.RATE
        agent = np.concatenate([speech("I opened Calculator and typed twelve times thirty four. The answer is four "
                                       "hundred and eight. Would you like me to copy it somewhere, or is there "
                                       "anything else you need?", voice="Daniel"), silence(2)])
        you = speech("Open Safari instead.")
        rng = np.random.default_rng(1)
        t = np.arange(int(0.25 * rate)) / rate
        room = rng.standard_normal(len(t)) * np.exp(-t / 0.05) * 0.3  # a desk, walls, 250 ms of reverb
        room[0] += 1
        cut_in = 5 * rate
        total = cut_in + len(you) + 2 * rate

        finals, spoke_at = [], []
        EARS.on_text = lambda text, final: final and finals.append(text)
        EARS.deaf = lambda: False
        played = np.zeros(total, np.float32)   # what the Mac plays: the agent, until you cut in
        heard = np.zeros(total + len(room), np.float32)  # what reaches the microphone
        heard[cut_in:cut_in + len(you)] += you * 0.5
        heard += rng.standard_normal(len(heard)).astype(np.float32) * 0.002
        EARS.on_speech = lambda: spoke_at.append(position[0])
        position = [0]
        start = time.time()
        for i in range(0, total, mic.FRAME):
            position[0] = i
            if not spoke_at:  # it stops talking once it notices you
                frame = agent[i:i + mic.FRAME] if i < len(agent) else np.zeros(0, np.float32)
                played[i:i + len(frame)] = frame
                delay = int(0.045 * rate)
                echo = np.convolve(np.tanh(frame * 0.15) / 1.5, room)  # loud, and small speakers distort a little
                heard[i + delay:i + delay + len(echo)] += echo
            self.microphone.from_mac(played[i:i + mic.FRAME])
            self.microphone.from_mic(heard[i:i + mic.FRAME])
            time.sleep(max(0, start + (i + mic.FRAME) / rate - time.time()))
        wait_for(lambda: finals, "the transcript")
        time.sleep(1)

        self.assertTrue(EARS.transcribe(heard[rate:cut_in]), "the echo should be loud enough to be words")
        self.assertEqual(len(spoke_at), 1, finals)  # its own voice never counted as you talking
        self.assertGreater(spoke_at[0], cut_in)
        self.assertLess(spoke_at[0], cut_in + rate)  # it noticed you within a second
        self.assertEqual(len(finals), 1, finals)
        self.assertIn("safari", finals[0].lower())


if __name__ == "__main__":
    unittest.main(verbosity=2)
