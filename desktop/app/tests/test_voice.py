"""Runs the voice agent against the helper in --dry-run mode and a fake Codex, with speech made
by `say` standing in for the microphone and Parakeet really transcribing it: tapping fn starts
and stops it listening, the words show up as you talk, a pause (or tapping fn) ends what you
said, holding fn dictates instead, "continue" carries on after you took over, talking over it
stops its voice, and with echo cancellation its own voice coming back into the microphone isn't taken for
you. With your voice enrolled (Samantha plays you), other voices are left out, even right
before or after you or under you. Nothing is played aloud: `say` writes files and the agent's
voice is a stand-in.

    .venv/bin/python tests/test_voice.py
"""

import json
import os
from pathlib import Path
os.environ["AGENT_BACKEND"] = "codex"  # these drive the fake Codex app-server (fake_codex.py), never the real Claude
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
import session_journal  # noqa: E402
import voiceprint  # noqa: E402

FAKE_CODEX = os.path.join(HERE, "fake_codex.py")
SPEECH = tempfile.mkdtemp(prefix="voice-speech-")
EARS = None  # loading Parakeet takes a few seconds; the tests share it
YOUR_VOICE = None  # Samantha's voiceprint
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


def your_voiceprint() -> voiceprint.Voiceprint:
    """Samantha, enrolled as you (in a temporary file, not models/voiceprint.npz)."""
    global YOUR_VOICE
    if YOUR_VOICE is None:
        voice = voiceprint.Voiceprint(os.path.join(SPEECH, "voiceprint.npz"))
        voice.threshold = voiceprint.MATCH
        if not voice.ready():
            raise unittest.SkipTest(f"no speaker model ({voice.error}); ./voice.sh downloads it")
        voice.add([speech(sentence) for sentence in voiceprint.SENTENCES])
        YOUR_VOICE = voice
    return YOUR_VOICE


def listen_to(samples: np.ndarray, then_quiet: bool = True):
    """The "microphone" hears samples in real time, then (then_quiet) a moment of quiet."""
    if then_quiet:
        samples = np.concatenate([samples, silence(1.6)])
    start = time.time()
    for i in range(0, len(samples), BLOCK):
        EARS.feed(samples[i:i + BLOCK])
        time.sleep(max(0, start + (i + BLOCK) / listen.RATE - time.time()))


def wait_for(check, what: str, timeout: float = 20):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if check():
            return
        time.sleep(0.05)
    raise AssertionError(f"timed out waiting for {what}")


class Voice:
    """Stands in for speech.Voice: writes down what it was asked to say, and "plays" it straight
    away (on_play). `playing` is whether it's audible right now."""

    def __init__(self, on_play=lambda words: None):
        self.said: list[str] = []
        self.calls: list[str] = []
        self.playing = False
        self.on_play = on_play

    def say(self, text):
        self.said.append(text)
        self.on_play(text)

    def stop(self):
        self.calls.append("stop")
        self.playing = False

    def audible(self):
        return self.playing

    def quiet_for(self):
        return 0.0 if self.playing else 1e9


class Captions:
    """Stands in for the on-screen captions: writes down what they'd show."""

    def __init__(self):
        self.words: list[str] = []
        self.on_input = lambda text: None
        self.thoughts: list[str] = []
        self.doings: list[str] = []
        self.listenings: list[bool] = []  # each time the header said it's listening, or stopped saying it
        self.hearings: list[str] = []
        self.dictatings: list[bool] = []

    def say(self, words):
        self.words.append(words)

    def listening(self, on):
        self.listenings.append(on)

    def hearing(self, words):
        self.hearings.append(words)

    def thinking(self, words):
        self.thoughts.append(words)

    def dictating(self, on):
        self.dictatings.append(on)

    def camera(self, on):
        self.cameras = getattr(self, "cameras", []) + [on]

    def doing(self, text):
        self.doings.append(text)

    def close(self):
        pass


class VoiceAgentTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        setup_ears()

    def setUp(self):
        self.helper = Helper()
        self.addCleanup(self.helper.stop)
        self.dir = tempfile.mkdtemp(prefix="voice-")
        isolation = mock.patch.dict(os.environ, {"AGENT_STATE_DIR": self.dir, "CODEX_HOME": self.dir})
        isolation.start()
        self.addCleanup(isolation.stop)
        agent._session = agent.Session()
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
        self.agent.voice = Voice(on_play=self.agent.on_play)
        self.heard: list[tuple[str, bool]] = []
        self.agent.heard = lambda text, final: (self.heard.append((text, final)),
                                                self.agent.events.put(("heard", (text, final, EARS.heard_times))))
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
        self.assertFalse(EARS.listening)  # until you tap fn
        self.tap_fn()
        wait_for(lambda: self.captions.listenings == [True], "it to listen")  # the tap, not just fn down

    def tap_fn(self):
        self.helper.raw("fn down")
        self.helper.raw("fn tap")

    def hold_fn(self):
        self.helper.raw("fn down")
        wait_for(lambda: self.agent.dictation, "it to start dictating")

    def _watch_gate(self):
        try:
            for event in AgentVHID(self.helper.socket).watch():
                self.gate.append(event)
        except AgentVHIDError:
            pass  # the helper stopped at the end of the test

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
        listen_to(speech("Open Calculator and work out twelve times thirty four."))
        wait_for(lambda: self.prompts(), "codex")
        partial = [text for text, final in self.heard if not final]
        self.assertTrue(any("Open calculator" in text for text in partial), partial)
        self.assertIn("12 times 34", self.prompts()[0])

        wait_for(lambda: self.agent.voice.said, "the reply")
        wait_for(lambda: self.agent.task is None, "the task to finish")
        self.assertEqual(self.agent.voice.said, ["Calculator shows 408."])  # once, though Codex says it twice
        states = [(e.get("state"), e.get("reason")) for e in self.gate if "state" in e]
        # It only waited (no clicks or typing), so it never took your mouse and keyboard.
        self.assertNotIn(("engaged", "engaged"), states)

    def test_the_session_is_saved_what_you_said_and_what_it_did(self):
        self.agent.events.put(("heard", ("Um.", True, None)))
        self.agent.events.put(("heard", ("Open Calculator and work out 12 times 34.", True, None)))
        wait_for(lambda: self.agent.voice.said, "the reply")
        wait_for(lambda: self.agent.task is None, "the task to finish")
        journal = self.agent.journal
        self.assertTrue(str(journal.dir).startswith(self.dir))  # (the test's own state folder)
        entries = session_journal.read(journal.dir)
        said = [(e["text"], e["outcome"]) for e in entries if e["kind"] == "you said"]
        self.assertEqual(said, [("Um.", "filler, ignored"), ("Open Calculator and work out 12 times 34.", "request")])
        request = next(e for e in entries if e["kind"] == "request")
        self.assertEqual(request["device"], "mac")
        self.assertIn("Calculator shows 408.", [e["text"] for e in entries if e["kind"] == "say"])
        done = next(e for e in entries if e["kind"] == "done")
        self.assertTrue(done["thread"])  # which Codex thread has the full context
        self.assertEqual(done["request"], "Open Calculator and work out 12 times 34.")
        manifest = json.loads((journal.dir / "manifest.json").read_text())
        self.assertIn(done["thread"], [t["thread"] for t in manifest["threads"]])
        self.assertIn("Calculator shows 408.", (journal.dir / "index.html").read_text())
        records = [json.loads(p.read_text()) for p in (Path(self.dir) / "context").glob("*.json")]
        self.assertTrue(records and all(r["session"] == journal.id for r in records))  # every payload, tagged

        self.agent.shutdown()
        self.assertEqual(session_journal.read(journal.dir)[-1]["kind"], "session ended")
        self.assertIsNotNone(json.loads((journal.dir / "manifest.json").read_text())["ended"])

    def test_text_you_add_goes_into_the_conversation_and_says_truthfully_if_it_got_there(self):
        inbox = Path(self.dir, "ingest-inbox")
        inbox.mkdir()
        dropped = inbox / "x.txt"
        dropped.write_text("Hivemind meeting\n" + "Alice: we should align on goals.\n\n" * 2000)
        self.agent.events.put(("ingest", str(dropped)))
        wait_for(lambda: any(e["kind"] == "ingest done" for e in session_journal.read(self.agent.journal.dir)),
                 "the text to be added", timeout=30)
        entries = session_journal.read(self.agent.journal.dir)
        started = next(e for e in entries if e["kind"] == "ingest started")
        self.assertEqual(started["text"], "Hivemind meeting")
        parts = [e for e in entries if e["kind"] == "ingest part"]
        self.assertEqual(len(parts), started["parts"])
        self.assertTrue(all(p["on_session_thread"] for p in parts))
        prompts = self.prompts()
        self.assertEqual(len(prompts), started["parts"])  # one turn each, on the session's thread
        self.assertTrue(all("not instructions" in p for p in prompts))
        done = next(e for e in entries if e["kind"] == "ingest done")
        self.assertEqual(done["status"], "sent")  # the fake Codex saves no rollout, so: not verified
        self.assertFalse(dropped.exists())  # the app's copy is gone; the private saved copy stays
        self.assertFalse(self.agent.voice.said)  # nothing said out loud

    def test_typed_request_from_caption_is_sent_to_the_agent(self):
        self.captions.on_input('What time is it?')
        wait_for(lambda: self.prompts(), 'the typed request')
        self.assertIn('What time is it?', self.prompts()[0])
        self.assertIn('What time is it?', self.captions.hearings)

    def test_lip_reading_turns_the_camera_on_until_the_second_tap(self):
        agent_events = self.agent.events

        class Reader:
            def __init__(self):
                self.started = 0
                self.stopped = False

            def start(self):
                self.started += 1
                agent_events.put(("camera", {"camera": "on"}))  # as the worker says once it records
                agent_events.put(("camera", {"partial": "What time", "final": False}))

            def stop(self, timeout=60):
                self.stopped = True
                return "What time is it?"

            def close(self):
                pass

        self.tap_fn()  # stop listening (setUp started it)
        wait_for(lambda: self.captions.listenings[-1] is False, "it to stop listening")
        with mock.patch("lipread.available", return_value=(True, "fake")):
            self.agent.events.put(("input", "lips"))
            wait_for(lambda: self.agent.input_mode == "lips", "lip reading mode")
        reader = self.agent.lips = Reader()
        self.tap_fn()
        wait_for(lambda: getattr(self.captions, "cameras", []) == ["starting", "on"], "the camera caption")
        wait_for(lambda: reader.started == 1, "the camera to start")
        wait_for(lambda: "What time" in self.captions.hearings, "live lip reading captions")
        self.assertFalse(self.prompts())  # an unfinished hypothesis must not become a command
        self.assertFalse(EARS.listening)  # the microphone stays closed
        self.tap_fn()
        wait_for(lambda: reader.stopped, "the camera to stop")
        self.assertFalse(self.prompts())  # closing must not submit the unfinished request
        self.assertEqual(self.captions.cameras, ["starting", "on", "off"])
        kinds = [(e["kind"], e["text"]) for e in session_journal.read(self.agent.journal.dir)]
        self.assertIn(("lip reading", "camera on"), kinds)
        self.assertNotIn(("lip reading", "What time is it?"), kinds)
        self.agent.events.put(("input", "voice"))
        wait_for(lambda: self.agent.input_mode == "voice", "voice mode again")

    def test_lip_reading_empty_results_and_errors_are_visible(self):
        for text, error, expected in [("", None, "Couldn't read your lips"),
                                      ("", "no face was found", "Lip reading failed: no face was found")]:
            with self.subTest(error=error):
                self.agent.events.put(("lips", (text, error)))
                wait_for(lambda: any(expected in w for w in self.captions.words), "visible lip reading feedback")
                self.assertEqual(self.captions.hearings[-1], "")
                self.assertFalse(self.prompts())

    def test_a_camera_that_wont_open_says_so_at_once_and_isnt_shown_as_on(self):
        agent_events = self.agent.events

        class Reader:
            def start(self):
                agent_events.put(("camera", {"camera": "waiting"}))
                agent_events.put(("camera", {"camera": "failed", "error": "the camera couldn't be opened"}))

            def close(self):
                pass

        self.tap_fn()
        wait_for(lambda: self.captions.listenings[-1] is False, "it to stop listening")
        with mock.patch("lipread.available", return_value=(True, "fake")):
            self.agent.events.put(("input", "lips"))
            wait_for(lambda: self.agent.input_mode == "lips", "lip reading mode")
        self.agent.lips = Reader()
        self.tap_fn()
        wait_for(lambda: "off" in getattr(self.captions, "cameras", []), "the camera caption to go")
        self.assertEqual(self.captions.cameras, ["starting", "waiting", "off"])  # never "on"
        self.assertTrue(any("Camera couldn't open" in w for w in self.captions.words))
        wait_for(lambda: not self.agent.listening, "it to stop waiting for the second tap")
        self.agent.events.put(("input", "voice"))

    def test_it_looks_at_the_mac_as_you_start_talking_and_says_where_the_time_went(self):
        looked = []

        class Look:  # instead of a screenshot of your screen
            def __init__(self):
                looked.append(time.monotonic())

            def seen(self):
                return "data:image/jpeg;base64,QUJD", "Open windows: Calculator."

        with mock.patch("voice_agent.LookAhead", Look):
            listen_to(speech("Open Calculator and work out twelve times thirty four."))
            wait_for(lambda: self.prompts(), "codex")
        self.assertEqual(len(looked), 1)
        self.assertLess(looked[0], EARS.heard_times["stopped"])  # while you were still talking
        self.assertEqual(self.runs()[0]["images"], 1)
        self.assertIn("Open windows: Calculator.", self.prompts()[0])
        wait_for(lambda: any(line.startswith("⏱") for line in self.printed), "the timing")
        timing = next(line for line in self.printed if line.startswith("⏱"))
        for step in ("from when you stopped talking to hearing its reply", "to be sure you'd finished",
                     "writing it down", "screenshot ready (taken as you talked)", "for Codex's first words"):
            self.assertIn(step, timing)
        pause = float(timing.split("s to be sure")[0].rsplit(" ", 2)[-2])
        self.assertAlmostEqual(pause, EARS.pause, delta=0.25)

    def test_tapping_fn_starts_and_stops_it_listening(self):
        self.agent.app = True  # and tells Agent.app's menu bar
        self.tap_fn()
        wait_for(lambda: "@@ listening 0" in self.printed, "it to stop listening")
        self.assertFalse(EARS.listening)
        listen_to(speech("Open Safari."))
        time.sleep(0.5)
        self.assertEqual(self.heard, [])  # not listening: nothing heard
        self.assertEqual(self.prompts(), [])
        self.tap_fn()
        wait_for(lambda: "@@ listening 1" in self.printed, "it to listen again")
        self.assertTrue(EARS.listening)
        self.assertEqual(self.captions.listenings, [True, False, True])
        listen_to(speech("Open Safari."))
        wait_for(lambda: self.prompts(), "codex")
        self.assertIn("Open Safari", self.prompts()[0])
        self.assertTrue(any("Open" in words for words in self.captions.hearings), self.captions.hearings)

    def test_tapping_fn_mid_sentence_cancels_unfinished_speech(self):
        listen_to(speech("Open Calculator and work out twelve times thirty four."), then_quiet=False)
        self.tap_fn()
        wait_for(lambda: not EARS.listening, "listening to stop")
        wait_for(lambda: not self.agent._discard_heard, "unfinished speech to drain", timeout=10)
        self.assertEqual(self.prompts(), [])
        self.assertFalse(EARS.listening)

    def test_holding_fn_types_what_you_say_into_the_app_in_front(self):
        typed = []
        self.agent.paste = typed.append  # returns None: it worked
        self.agent.app = True
        self.hold_fn()
        listen_to(speech("Hello there. See you at five."))
        self.helper.raw("fn up")
        wait_for(lambda: typed, "the dictation to be typed")
        self.assertIn("hello there", typed[0].lower())
        self.assertIn("see you at", typed[0].lower())
        self.assertEqual(self.prompts(), [])  # it isn't a task
        self.assertTrue(any("see you" in words.lower() for words in self.captions.hearings), self.captions.hearings)
        self.assertIn("@@ dictating 1", self.printed)
        self.assertIn("@@ dictating 0", self.printed)
        self.assertEqual(self.captions.dictatings, [True, False])
        self.assertFalse(any("see you" in line.lower() for line in self.printed))  # the log doesn't keep the words
        self.assertTrue(EARS.listening)  # and it's listening for the agent again
        listen_to(speech("Open Safari."))
        wait_for(lambda: self.prompts(), "codex")
        self.assertIn("Open Safari", self.prompts()[0])
        self.assertEqual(len(typed), 1)

    def test_letting_go_of_fn_mid_sentence_types_all_of_it(self):
        typed = []
        self.agent.paste = typed.append
        self.tap_fn()  # it stops listening for the agent
        wait_for(lambda: not EARS.listening, "it to stop listening")
        self.hold_fn()  # the microphone opens just for this
        listen_to(speech("Open Calculator and work out twelve times thirty four."), then_quiet=False)
        self.helper.raw("fn up")
        wait_for(lambda: typed, "the dictation to be typed", timeout=5)
        self.assertIn("12 times 34", typed[0])
        self.assertFalse(EARS.listening)
        self.assertEqual(self.prompts(), [])

    def test_fn_with_another_key_is_a_shortcut_not_dictation(self):
        typed = []
        self.agent.paste = typed.append
        self.hold_fn()
        listen_to(speech("Open Safari."))
        self.helper.raw("fn other")  # fn+arrow, say
        self.helper.raw("fn up")
        time.sleep(1)
        self.assertEqual(typed, [])
        self.assertEqual(self.prompts(), [])
        self.assertTrue(EARS.listening)

    def test_dictation_it_cant_type_is_left_on_the_clipboard(self):
        dictation = voice_agent.Dictation()
        dictation.words = ["Hello there."]
        self.agent.paste = lambda text: "it isn't allowed to press keys"
        self.agent.type_dictation(dictation)
        wait_for(lambda: any("couldn't type it" in line for line in self.printed), "the message")
        self.assertTrue(any("on the clipboard" in line for line in self.printed), self.printed)

    def test_a_request_is_the_goal_codex_keeps_working_on_until_done(self):
        listen_to(speech("Open Safari."))
        wait_for(lambda: self.prompts(), "codex")
        with open(self.codex_log) as f:
            goals = [entry["goal"] for entry in map(json.loads, f) if "goal" in entry]
        self.assertTrue(goals, "no goal was set, so the first turn to end would end the task")
        self.assertEqual(goals[0]["status"], "active")
        self.assertIn("Safari", goals[0]["objective"])

    def test_saying_continue_carries_on_after_you_take_over(self):
        os.environ["FAKE_CODEX_SECONDS"] = "60"
        listen_to(speech("Open Safari."))
        wait_for(lambda: self.prompts() and self.agent.task and self.agent.task.running, "codex")
        self.assertFalse(self.agent.mac.is_engaged())  # it takes the mouse only for a screen action
        tools = self.agent.task.tools["mac"]
        tools.mac = AgentVHID(self.helper.socket, speed=2)
        self.assertIsNone(tools.take())  # its first screen action takes control
        self.helper.raw("human trackpad")  # you took over
        wait_for(lambda: self.agent.pause_announced, "it to say how to let it carry on")
        self.assertTrue(any("“continue”" in line for line in self.printed), self.printed)
        self.assertEqual(tools.take(), "trackpad")  # its screen actions wait for you; the rest goes on
        self.assertTrue(self.agent.task.running)
        listen_to(speech("Continue."))
        wait_for(lambda: self.agent.mac.is_engaged(), "it to take control again")
        self.assertEqual(len(self.prompts()), 1)  # the same task, not a new one
        self.assertTrue(self.agent.task.running)
        self.assertIn("▶️  continuing", self.printed)

    def test_captions_show_what_its_doing(self):
        listen_to(speech("Open Calculator."))
        wait_for(lambda: self.agent.voice.said and self.agent.task is None, "the task to finish")
        self.assertIn("Looking at the screen", self.captions.doings)  # the fake Codex takes a screenshot
        self.assertEqual(self.captions.doings[-1], "")  # and when it's done, nothing
        self.assertTrue(any(line.startswith("✅ done in ") for line in self.printed), self.printed)

    def test_on_the_phone_it_works_on_the_phone_alongside_the_mac(self):
        os.environ["FAKE_CODEX_SECONDS"] = "60"
        listen_to(speech("Open Safari."))
        wait_for(lambda: self.prompts(), "codex")
        mac_task = self.agent.task
        listen_to(speech("Open Maps on my phone."))
        wait_for(lambda: len(self.prompts()) == 2, "the phone task")
        phone_run = self.runs()[1]
        self.assertIn("iPhone", phone_run["prompt"])
        self.assertIn("maps on my phone", phone_run["prompt"].lower())
        self.assertIn("This request is for the iPhone", phone_run["prompt"])
        self.assertIs(self.agent.task, mac_task)  # the Mac task carried on
        self.assertTrue(mac_task.running)
        self.assertTrue(self.agent.tasks["phone"].running)
        listen_to(speech("Stop."))  # stops both
        wait_for(lambda: not any(self.agent.tasks.values()), "both tasks to stop")

    def test_a_short_pause_doesnt_cut_you_off(self):
        listen_to(np.concatenate([speech("Open Safari."), silence(0.7), speech("Then search for the weather.")]))
        wait_for(lambda: self.prompts(), "codex")
        self.assertIn("Open Safari", self.prompts()[0])
        self.assertIn("search for the weather", self.prompts()[0])

    def test_trailing_off_on_and_waits_longer(self):
        listen_to(np.concatenate([speech("Open the browser and"), silence(1.8), speech("search for the weather.")]))
        wait_for(lambda: self.prompts(), "codex")
        time.sleep(0.5)
        self.assertEqual(len(self.prompts()), 1, self.prompts())
        self.assertIn("search for the weather", self.prompts()[0])

    def test_saying_more_right_after_adds_to_the_request(self):
        os.environ["FAKE_CODEX_SECONDS"] = "60"
        listen_to(speech("Open Safari."))
        wait_for(lambda: self.prompts(), "codex")
        listen_to(speech("And look up the weather in Paris."))
        wait_for(lambda: len(self.prompts()) == 2, "the second request")
        self.assertIn("Open Safari", self.prompts()[1])
        self.assertIn("weather in Paris", self.prompts()[1])
        self.assertIn("   (adding that to what you just asked)", self.printed)

    def test_saying_stop_stops_the_task(self):
        os.environ["FAKE_CODEX_SECONDS"] = "60"
        listen_to(speech("Open Safari."))
        wait_for(lambda: self.prompts() and self.agent.task and self.agent.task.running, "codex")
        listen_to(speech("Stop."))
        wait_for(lambda: self.agent.task is None, "the task to stop")
        self.assertEqual(self.agent.voice.said, ["Stopped."])
        self.assertEqual(len(self.prompts()), 1)

    def test_noise_and_silence_do_nothing(self):
        listen_to(np.concatenate([silence(1), noise(2)]))
        time.sleep(1)
        self.assertEqual(self.heard, [])
        self.assertEqual(self.prompts(), [])

    @mock.patch.object(listen.Ears, "hears_the_mac", return_value=True)  # echo cancellation is working
    def test_talking_over_it_stops_its_voice(self, _):
        self.agent.voice.playing = True
        finals_when_stopped = []
        stop = self.agent.voice.stop
        self.agent.voice.stop = lambda: (finals_when_stopped.append(len(self.finals())), stop())
        listen_to(speech("Wait, open Safari instead."))
        wait_for(lambda: self.prompts(), "codex")
        self.assertEqual(finals_when_stopped[0], 0)  # it went quiet as you started, not once you'd finished
        self.assertIn("Safari", self.prompts()[0])

    @mock.patch.object(listen.Ears, "hears_the_mac", return_value=True)
    def test_over_its_voice_its_own_words_are_ignored(self, _):
        self.agent.say("I typed twelve times thirty four into Calculator.")
        self.agent.voice.playing = True
        listen_to(speech("typed twelve times thirty four into Calculator", voice="Daniel"))
        wait_for(lambda: self.finals(), "the transcript")
        time.sleep(0.5)
        self.assertEqual(self.prompts(), [])
        self.assertTrue(any("heard its own voice" in line for line in self.printed), self.printed)

    def test_with_your_voice_enrolled_someone_elses_isnt_a_task(self):
        EARS.voiceprint = your_voiceprint()
        self.addCleanup(setattr, EARS, "voiceprint", None)
        listen_to(speech("Open Calculator and type twelve times thirty four.", voice="Daniel"))
        time.sleep(0.5)
        self.assertEqual(self.prompts(), [])
        self.assertTrue(any("not your voice" in line for line in self.printed), self.printed)
        listen_to(speech("Open Safari."))
        wait_for(lambda: self.prompts(), "codex")
        self.assertIn("Open Safari", self.prompts()[0])

    def test_without_echo_cancellation_it_doesnt_listen_while_it_talks(self):
        self.agent.voice.playing = True  # and EARS has no microphone, so nothing hears the Mac
        with mock.patch("audio.output_is_speakers", return_value=True):
            listen_to(speech("I opened Calculator for you.", voice="Daniel"))
            self.assertEqual(self.heard, [])
            self.agent.voice.playing = False
            listen_to(speech("Open Safari."))
        wait_for(lambda: self.prompts(), "codex")
        self.assertIn("Open Safari", self.prompts()[0])


def heard(who: str, seconds: float) -> list[listen.Heard]:
    """Windows of you, them (someone else) or a pause, for UtteranceTest's judge to tell apart."""
    value = {"you": 0.1, "them": 0.2, "pause": 0.0}[who]
    return [listen.Heard(np.full(listen.WINDOW, value, np.float32), who != "pause", None)
            for _ in range(round(seconds * listen.RATE / listen.WINDOW))]


def judge(windows: list[np.ndarray]) -> tuple[bool, float]:
    """Stands in for the voiceprint: it's you if most of the speech is."""
    yours = float(np.mean([np.isclose(w[0], 0.1) for w in windows]))
    return yours >= 0.5, yours


def who(utterance: listen.Utterance) -> tuple[float, float]:
    """Seconds of your speech and of theirs it kept."""
    values = [h.window[0] for h in utterance.kept if h.speech]
    return (sum(np.isclose(values, 0.1)) * listen.WINDOW / listen.RATE,
            sum(np.isclose(values, 0.2)) * listen.WINDOW / listen.RATE)


class UtteranceTest(unittest.TestCase):
    """How an utterance is put together phrase by phrase once it can tell voices apart (no models)."""

    def hear(self, utterance: listen.Utterance, *parts: tuple[str, float]) -> float | None:
        """Seconds into parts when it decided you'd finished, if it did."""
        at = 0.0
        for part in parts:
            for h in heard(*part):
                utterance.add(h)
                at += listen.WINDOW / listen.RATE
                if utterance.over(1.2, False):
                    return at
        return None

    def test_without_a_judge_everything_is_kept(self):
        utterance = listen.Utterance(heard("them", 0.1))
        self.hear(utterance, ("them", 1), ("pause", 0.5), ("you", 1))
        self.assertAlmostEqual(who(utterance)[1], 1.1, delta=0.05)
        self.assertAlmostEqual(who(utterance)[0], 1, delta=0.05)

    def test_someone_else_alone_is_left_out(self):
        utterance = listen.Utterance(heard("them", 0.1), judge)
        finished = self.hear(utterance, ("them", 2), ("pause", 0.5))
        self.assertIsNotNone(finished)
        self.assertLess(finished, 2.5)  # as soon as they paused
        self.assertEqual(utterance.speech, 0)
        self.assertEqual(len(utterance.ignored), 1)

    def test_them_talking_on_after_you_counts_as_quiet(self):
        utterance = listen.Utterance(heard("you", 0.1), judge)
        finished = self.hear(utterance, ("you", 1.5), ("pause", 0.3), ("them", 5))
        self.assertIsNotNone(finished, "it should notice you'd finished while they kept talking")
        self.assertLess(finished, 1.6 + 1.2 + listen.CHECK_AFTER + 0.1)
        yours, theirs = who(utterance)
        self.assertAlmostEqual(yours, 1.6, delta=0.05)
        self.assertEqual(theirs, 0)

    def test_them_carrying_on_right_after_you_is_cut_off(self):
        utterance = listen.Utterance(heard("you", 0.1), judge)
        finished = self.hear(utterance, ("you", 2.2), ("them", 5))
        self.assertIsNotNone(finished)
        yours, theirs = who(utterance)
        self.assertGreater(yours, 2.3 - 0.3)
        self.assertLess(theirs, 0.3)

    def test_you_starting_right_after_them_is_you(self):
        utterance = listen.Utterance(heard("them", 0.1), judge)
        self.hear(utterance, ("them", 3), ("you", 3))
        yours, theirs = who(utterance)
        self.assertAlmostEqual(yours, 3, delta=0.05)  # all of you...
        self.assertLessEqual(theirs, listen.RECHECK_WINDOW + listen.PREROLL)  # ...and not much of them
        self.assertTrue(utterance.ignored)

    def test_a_word_too_short_to_tell_goes_with_whats_next(self):
        utterance = listen.Utterance(heard("them", 0.1), judge)
        self.hear(utterance, ("pause", 0.3), ("you", 1))
        self.assertEqual(utterance.whose, True)  # the blip of them didn't decide it


class ItsOwnVoiceTest(unittest.TestCase):
    """It learns its own voice (Kokoro, rendered and never played) and leaves it out, with nobody
    enrolled and VOICE_MATCH 0; people (Samantha, Daniel) are still heard."""

    @classmethod
    def setUpClass(cls):
        import speech as tts
        cls.tts = tts.Voice()
        if cls.tts.kokoro() is None:
            raise unittest.SkipTest(f"Kokoro isn't set up ({cls.tts.error}); ./voice.sh does it")
        cls.print = voiceprint.Voiceprint(os.path.join(SPEECH, "nobody.npz"))
        cls.print.threshold = 0
        if not cls.print.ready():
            raise unittest.SkipTest(f"no speaker model ({cls.print.error}); ./voice.sh downloads it")
        cls.print.learn_voice([cls.tts.render(t) for t in voiceprint.SENTENCES[:3]], tts.RATE)

    def kokoro(self, text: str) -> np.ndarray:
        from scipy.signal import resample_poly
        return resample_poly(self.tts.render(text), 2, 3).astype(np.float32) * 0.4  # quieter, as through a room

    def test_its_voice_is_left_out(self):
        for text in ("Yes, I didn't see a way to do that on your phone.", "Okay, opening Safari now."):
            matched, _ = self.print.matches(self.kokoro(text))
            self.assertFalse(matched, text)
            self.assertTrue(self.print.heard_machine)

    def test_people_are_heard(self):
        for clip in (speech("Open Safari and look up the weather."), speech("What time is it?", voice="Daniel")):
            self.assertEqual(self.print.matches(clip), (True, 1.0))
            self.assertFalse(self.print.heard_machine)


class VoiceMatchTest(unittest.TestCase):
    """With your voice enrolled, Parakeet only gets you: Samantha plays you, Daniel someone nearby."""

    @classmethod
    def setUpClass(cls):
        setup_ears()
        cls.voiceprint = your_voiceprint()

    def setUp(self):
        self.finals, self.partials, self.spoke, self.ignored = [], [], [], []
        EARS.on_text = lambda text, final: (self.finals if final else self.partials).append(text)
        EARS.on_speech = lambda: self.spoke.append(time.time())
        EARS.on_ignored = lambda seconds, similarity: self.ignored.append(similarity)
        EARS.deaf = lambda: False
        EARS.voiceprint = self.voiceprint
        self.addCleanup(setattr, EARS, "voiceprint", None)
        EARS.listen(True)  # as if you'd tapped fn

    def chatter(self, repeat: int = 1) -> np.ndarray:
        return speech(" ".join(["Did you see the game last night? It was unbelievable, they came back in the "
                                "last two minutes and won it."] * repeat), voice="Daniel")

    def test_someone_else_isnt_heard(self):
        listen_to(self.chatter())
        time.sleep(1)
        self.assertEqual((self.finals, self.partials, self.spoke), ([], [], []))
        self.assertTrue(self.ignored)
        self.assertLess(max(self.ignored), voiceprint.MATCH)

    def test_you_right_after_them(self):
        listen_to(np.concatenate([self.chatter(), silence(0.3), speech("Open Safari.")]))
        wait_for(lambda: self.finals, "the transcript")
        self.assertEqual(self.finals, ["Open Safari."])
        self.assertEqual(len(self.spoke), 1)

    def test_you_finish_while_they_talk_on(self):
        audio = np.concatenate([speech("Open Safari."), silence(0.4), self.chatter(2)])
        hearing = threading.Thread(target=listen_to, args=(audio,))
        hearing.start()
        self.addCleanup(hearing.join)
        wait_for(lambda: self.finals, "the transcript")
        self.assertTrue(hearing.is_alive(), "it should be done while they're still talking")
        self.assertEqual(self.finals, ["Open Safari."])

    def test_you_over_a_tv(self):
        you = speech("Open Safari and look up the weather for tomorrow.")
        audio = self.chatter(2) * 0.5
        audio[listen.RATE:listen.RATE + len(you)] += you
        listen_to(audio)
        wait_for(lambda: self.finals, "the transcript")
        self.assertEqual(self.finals, ["Open Safari and look up the weather for tomorrow."])


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

    def setUp(self):
        EARS.listen(True)  # as if you'd tapped fn

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
