"""The voice models that stay in Python (python/listen.py, mic.py, voiceprint.py, speech.py; the
voice sidecar, python/sidecar_voice.py, serves them to the Rust agent): how an utterance is put
together once it can tell voices apart, its own voice (Kokoro) left out, only you heard with your
voice enrolled (Samantha plays you, Daniel someone nearby), and the echo canceller taking what the
Mac plays out of what the microphone hears, with Parakeet really transcribing. Nothing is played
aloud: `say` writes files. The voice agent itself is tested in Rust (crates/hive/hive-app,
crates/hive/hive-sidecars).

    .venv/bin/python tests/test_voice_models.py
"""

import os
import subprocess
import sys
import tempfile
import time
import unittest
import wave

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "python"))

import listen  # noqa: E402
import mic  # noqa: E402
import voiceprint  # noqa: E402

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
