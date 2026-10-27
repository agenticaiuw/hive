"""Listens all the time and writes down what you say as you say it, with Parakeet (NVIDIA's
open-source speech recognition model) running on this Mac through MLX.

Silero VAD (an open-source voice activity detector, models/silero_vad.onnx) notices when you
start talking. The words show up as you go, and once you stop for LISTEN_PAUSE seconds (1.2 by
default; longer if you trailed off on "and..." or a comma), the whole thing is transcribed once
more for the final text. Coughs and clicks too short to be speech are ignored. It hears through
python/mic.py, which takes whatever the Mac is playing (the agent's own voice, a video) back out
of what the microphone picks up. Once you've enrolled your voice (./voice.sh --enroll,
python/voiceprint.py), other people talking nearby are left out too.

    .venv/bin/python python/listen.py             # talk; it prints what it hears. Ctrl-C to stop.
    .venv/bin/python python/listen.py --download  # get the models now (./voice.sh does this)

STT_MODEL picks another Parakeet model (default mlx-community/parakeet-tdt-0.6b-v2, English;
mlx-community/parakeet-tdt-0.6b-v3 also knows 24 other European languages).
"""

from __future__ import annotations

import collections
import os
import queue
import re
import sys
import threading
import time
from typing import NamedTuple

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

from mic import Microphone  # noqa: E402

RATE = 16000
WINDOW = 512  # what Silero VAD looks at (32 ms)
START, STOP = 0.5, 0.35  # speech probability to start a stretch of talking, and to count as quiet
START_WINDOWS = 3  # ~0.1 s of speech in a row before it counts as you talking
MIN_SPEECH = 0.3  # seconds of speech an utterance needs; shorter is a cough or a click
PHRASE_GAP = 0.25  # with a voiceprint: a pause this long (s) may be one voice handing over to another...
CHECK_AFTER = 0.8  # ...and after this many seconds of speech it decides whose voice it is
RECHECK = 1.0  # while it's someone else: seconds of speech between checks for you starting to talk...
RECHECK_WINDOW = 2.0  # ...each over this much of the latest speech
MOST_CHECKED = 8.0  # seconds of speech the final check looks at, at most
OVER_THE_MAC = 12  # dB: while the Mac plays, speech has to be within this much of how loud you usually are
USUAL_LEVEL = -23  # dB: how loud you are until it has heard you a few times
PREROLL = 0.5  # seconds kept from before it noticed you talking
LONG_PAUSE = 2.5  # how long it waits when you trailed off mid-sentence
UNFINISHED = re.compile(r"(,|\b(and|or|but|so|then|to|the|a|an|um|uh|because|with|of|for|like|if|that))\W*$", re.I)
LIVE_WINDOW = 30  # seconds of the latest audio the live preview re-reads
CHUNK, OVERLAP = 120, 15  # the final pass reads long recordings in overlapping pieces
MIN_SECONDS = 2  # shorter audio is padded with silence
LEAD_IN = 0.3  # seconds of silence put before what it reads: audio that starts mid-word can come out as nothing
DEFAULT_MODEL = "mlx-community/parakeet-tdt-0.6b-v2"
VAD_MODEL = os.path.join(ROOT, "models", "silero_vad.onnx")
VAD_URL = "https://raw.githubusercontent.com/snakers4/silero-vad/v5.1.2/src/silero_vad/data/silero_vad.onnx"


class VAD:
    """Silero VAD v5: the chance that each 32 ms window is speech."""

    def __init__(self, path: str = VAD_MODEL):
        import onnxruntime
        options = onnxruntime.SessionOptions()
        options.inter_op_num_threads = options.intra_op_num_threads = 1
        self.session = onnxruntime.InferenceSession(path, options, providers=["CPUExecutionProvider"])
        self.reset()

    def reset(self):
        self.state = np.zeros((2, 1, 128), np.float32)
        self.context = np.zeros((1, 64), np.float32)

    def __call__(self, window: np.ndarray) -> float:
        x = np.concatenate([self.context, window[None, :]], axis=1)
        out, self.state = self.session.run(None, {"input": x, "state": self.state, "sr": np.array(RATE, np.int64)})
        self.context = x[:, -64:]
        return float(out[0, 0])


class Heard(NamedTuple):
    """One window of what the microphone heard."""
    window: np.ndarray
    speech: bool  # Silero VAD thinks it's speech (and not a pause)
    level: float | None  # dB, when it's clearly speech and the Mac is quiet: how loud you usually are


def latest(heard: list[Heard], seconds: float) -> list[Heard]:
    """The end of heard, with seconds of speech in it."""
    start, speech = len(heard), 0
    while start > 0 and speech < seconds * RATE / WINDOW:
        start -= 1
        speech += heard[start].speech
    return heard[start:]


class Utterance:
    """One stretch of you talking, a window at a time.

    With judge(windows of speech) -> (is it your voice, similarity), each phrase (speech between
    pauses of PHRASE_GAP) is checked before it's kept, and every RECHECK seconds while it goes on.
    Someone else's is left out and counts as quiet, so them talking on doesn't stop it noticing
    you've finished, and you starting right after them (or them right after you) is still you.
    Without a judge everything is kept."""

    def __init__(self, start: list[Heard], judge=None):
        self.judge = judge
        self.kept: list[Heard] = []  # your speech and the pauses in it
        self.speech = 0  # windows of your speech kept
        self.quiet = 0  # windows since you last said something
        self.confirmed = 0  # how much of kept was last checked to be you
        self.unconfirmed = 0  # windows of speech kept since
        self.whose: bool | None = None if judge else True  # the phrase going on: yours, theirs or unknown
        self.phrase: list[Heard] = []  # it, while unknown or someone else's (the end of it)
        self.phrase_speech = self.checked = self.gap = 0  # windows: its speech, that at the last check, pause
        self.similarity = 1.0
        self.others = 0  # phrases left out
        self.ignored: list[tuple[float, float]] = []  # theirs, to report: (seconds of speech, similarity)
        for heard in start:
            self.add(heard)

    @property
    def talking(self) -> bool:
        """It might be you, mid-sentence."""
        return self.speech > 0 or self.whose is not False

    @property
    def samples(self) -> np.ndarray:
        return np.concatenate([heard.window for heard in self.kept])

    @property
    def levels(self) -> list[float]:
        return [heard.level for heard in self.kept if heard.level is not None]

    def your_speech(self, seconds: float) -> list[np.ndarray]:
        return [heard.window for heard in self.kept if heard.speech][-int(seconds * RATE / WINDOW):]

    def add(self, heard: Heard):
        self.gap = 0 if heard.speech else self.gap + 1
        if self.whose:
            self._keep([heard])
        else:
            self.phrase.append(heard)
            self.phrase_speech += heard.speech
            self.quiet += 1
        if self.judge is None:
            return
        paused = self.gap * WINDOW / RATE >= PHRASE_GAP
        said = self.phrase_speech * WINDOW / RATE
        if self.whose:
            if paused:  # whoever talks next is checked again
                if self.unconfirmed * WINDOW / RATE >= MIN_SPEECH:
                    self._confirm()  # (an end that wasn't you is theirs, left out with the next window)
                if self.whose:
                    self.whose = None
            elif heard.speech and self.unconfirmed * WINDOW / RATE >= RECHECK:
                self._confirm()  # someone else might have carried on right after you, with no pause
        elif self.whose is None:
            if said >= CHECK_AFTER or (paused and said >= MIN_SPEECH):  # shorter goes with what's next
                self._check(self.phrase, self.phrase)
        elif paused:  # their phrase is over
            self._ignore(said)
        elif heard.speech and (self.phrase_speech - self.checked) * WINDOW / RATE >= RECHECK:
            # you might have started right after them, with no pause in between
            self._check(latest(self.phrase, RECHECK_WINDOW), latest(self.phrase, RECHECK_WINDOW + PREROLL),
                        late=True)
            if self.whose is False:  # only the end of it could ever be kept
                self.phrase = latest(self.phrase, RECHECK_WINDOW + PREROLL)

    def over(self, pause: float, unfinished: bool) -> bool:
        """You've finished, or it wasn't you."""
        if self.whose is None and self.phrase_speech and self.gap * WINDOW / RATE < PHRASE_GAP:
            return False  # someone's talking and it doesn't know who yet
        if not self.speech and self.whose is False:
            return False  # only someone else so far: you might start right after them
        if not self.speech and self.others:
            return True  # only someone else, and they've stopped
        waited = self.quiet * WINDOW / RATE
        return waited >= pause and (waited >= LONG_PAUSE or not unfinished)

    def end(self):
        if self.whose is False:  # someone else still talking
            self._ignore(self.phrase_speech * WINDOW / RATE)

    def _yours(self, heard: list[Heard]) -> tuple[bool, float]:
        return self.judge([h.window for h in heard if h.speech])

    def _check(self, judged: list[Heard], keep: list[Heard], late: bool = False):
        theirs = self.similarity
        yours, self.similarity = self._yours(judged)
        self.checked = self.phrase_speech
        if not yours:
            self.whose = False
            return
        if late:  # from where you started
            keep = keep[self._handover(keep, backward=True):]
        if len(keep) < len(self.phrase):  # they talked first
            self.ignored.append(((self.phrase_speech - sum(h.speech for h in keep)) * WINDOW / RATE, theirs))
        self._keep(keep)
        self.whose, self.phrase, self.phrase_speech = True, [], 0
        self.confirmed, self.unconfirmed = len(self.kept), 0

    def _confirm(self):
        """Whether what you've said since the last check is still you. If not, someone else took
        over somewhere in it, or in the end of what passed last time (half them can pass), and
        from there it's theirs."""
        yours, similarity = self._yours(self.kept[self.confirmed:])
        region = latest(self.kept, self.unconfirmed * WINDOW / RATE + RECHECK / 2)
        cut = len(self.kept) - len(region) + (len(region) if yours else self._handover(region))
        if cut < len(self.kept):
            theirs, self.kept[cut:] = self.kept[cut:], []
            self.speech -= sum(h.speech for h in theirs)
            self.quiet = len(self.kept) - max((i + 1 for i, h in enumerate(self.kept) if h.speech), default=0)
            self.quiet += len(theirs)
            self.phrase, self.phrase_speech = theirs, sum(h.speech for h in theirs)
            self.whose, self.similarity, self.checked = False, similarity, self.phrase_speech
        self.confirmed, self.unconfirmed = len(self.kept), 0

    def _handover(self, heard: list[Heard], backward: bool = False) -> int:
        """Where in heard you stop and someone else goes on (or, backward, where you start after
        them), to about a quarter second, from half a second at a time; erring towards keeping you.
        len(heard) (or 0) if it's you all through."""
        speech = [i for i, h in enumerate(heard) if h.speech]
        size, step = int(0.5 * RATE / WINDOW), int(0.25 * RATE / WINDOW)
        starts = list(range(0, max(1, len(speech) - size + 1), step))
        for start in reversed(starts) if backward else starts:
            if not self._yours([heard[i] for i in speech[start:start + size]])[0]:
                return speech[start + step] if start + step < len(speech) else len(heard)
        return 0 if backward else len(heard)

    def _ignore(self, seconds: float):
        self.ignored.append((seconds, self.similarity))
        self.others += 1
        self.whose, self.phrase, self.phrase_speech = None, [], 0

    def _keep(self, heard: list[Heard]):
        for h in heard:
            self.kept.append(h)
            self.speech += h.speech
            self.unconfirmed += h.speech
            self.quiet = 0 if h.speech else self.quiet + 1


class Ears:
    """on_text(text, final) is called from a background thread: with final=False as the words
    come while you talk, then once with final=True when you've finished. on_speech() is called
    once you've talked long enough that it isn't a cough (~0.3 s), before any words are ready.

    deaf() is asked for every bit of audio: while it's true what the microphone hears is
    ignored (the agent's own voice out of the speakers, when echo cancellation can't hear the
    Mac). mic=False leaves the microphone closed; feed() then takes the audio (the tests use it).

    With a voiceprint (python/voiceprint.py) you've enrolled, other voices are left out, phrase
    by phrase (Utterance): nothing shows or is written down until it's sure it's you, and each
    bit of someone else is passed to on_ignored(seconds, similarity) instead.
    on_utterance(samples), if set, gets the audio of each thing you said; words=False skips
    Parakeet altogether (enrolling only needs the audio)."""

    def __init__(self, on_text, mic: bool = True, deaf=lambda: False, voiceprint=None, words: bool = True):
        self.on_text = on_text
        self.on_speech = lambda: None
        self.on_ignored = lambda seconds, similarity: None
        self.on_utterance = None
        self.deaf = deaf
        self.voiceprint = voiceprint
        self.words = words
        self.pause = float(os.environ.get("LISTEN_PAUSE") or 1.2)
        self.model_id = os.environ.get("STT_MODEL") or DEFAULT_MODEL
        self.model = None
        self.error: str | None = None
        self.mic_level = 0.0  # loudest sample so far; still 0 after a few seconds means no microphone access
        self.talking = False  # in the middle of hearing you
        self._ready = threading.Event()
        self._lock = threading.Lock()
        self._blocks: queue.Queue = queue.Queue()
        self._capture: list[Heard] | None = None  # what you're saying, while you say it
        self._you = False  # the capture is you (and not someone else talking): its words may show
        self._finished: queue.Queue = queue.Queue()  # whole utterances waiting for the final pass
        self._live_text = ""
        self._levels: collections.deque[float] = collections.deque(maxlen=300)  # dB of your speech, Mac quiet
        self._wake = threading.Event()
        self._requests: queue.Queue = queue.Queue()  # transcribe() calls from other threads
        self._worker = threading.Thread(target=self._transcriber, daemon=True)  # MLX wants one thread
        if words:
            self._worker.start()
        else:
            self._ready.set()
        threading.Thread(target=self._segmenter, daemon=True).start()
        self.microphone = Microphone(self.feed) if mic else None  # last: it starts feeding at once

    # -- for the voice agent --

    def describe(self) -> str:
        self._ready.wait()
        short = self.model_id.rsplit("/", 1)[-1]
        return f"Parakeet ({short})" if self.model else f"nothing (Parakeet: {self.error})"

    @property
    def mic_name(self) -> str:
        return self.microphone.name if self.microphone else ""

    @property
    def mic_error(self) -> str | None:
        return self.microphone.error if self.microphone else None

    def hears_the_mac(self) -> bool:
        return bool(self.microphone and self.microphone.hears_the_mac())

    def feed(self, block: np.ndarray, playing: bool = False):
        """playing: the Mac was playing something, so what's left of its echo may sound like speech."""
        self._blocks.put((block, playing))

    def _gate(self) -> float:
        """While the Mac plays, quieter than this (dB) isn't you: leftover echo is much quieter
        than someone talking at the computer."""
        usual = float(np.median(self._levels)) if len(self._levels) >= 30 else USUAL_LEVEL
        return min(-25.0, max(-50.0, usual - OVER_THE_MAC))

    def transcribe(self, samples: np.ndarray) -> str:
        """Text for 16 kHz mono float32 audio."""
        if threading.current_thread() is self._worker:
            return self._read(samples)
        answer: queue.Queue = queue.Queue()
        self._requests.put((samples, answer))
        self._wake.set()
        return answer.get()

    # -- the segmenter thread: when you start and stop talking --

    def _checks_voices(self) -> bool:
        return bool(self.voiceprint and self.voiceprint.enrolled and self.voiceprint.ready())

    def _judge(self, windows: list[np.ndarray]) -> tuple[bool, float]:
        return self.voiceprint.matches(np.concatenate(windows)) if windows else (True, 1.0)

    def _segmenter(self):
        try:
            vad = VAD()
        except Exception as e:
            self.error = f"Silero VAD: {e}"
            return
        if self.voiceprint and self.voiceprint.enrolled:
            self.voiceprint.ready()  # loads its model before you say anything
        recent: collections.deque[Heard] = collections.deque(maxlen=int(PREROLL * RATE / WINDOW))  # a lead-in
        pending = np.zeros(0, np.float32)
        pending_playing = np.zeros(0, bool)
        run = 0  # windows of speech in a row, before it starts listening
        utterance: Utterance | None = None
        announced = False  # on_speech() was called for this utterance
        while True:
            block, playing = self._blocks.get()
            self.mic_level = max(self.mic_level, float(np.abs(block).max(initial=0)))
            pending = np.concatenate([pending, block])
            pending_playing = np.concatenate([pending_playing, np.full(len(block), playing)])
            while len(pending) >= WINDOW:
                window, pending = pending[:WINDOW], pending[WINDOW:]
                over_the_mac, pending_playing = pending_playing[:WINDOW].any(), pending_playing[WINDOW:]
                if self.deaf():
                    vad.reset()
                    recent.clear()
                    run = 0
                    continue
                p = vad(window)
                level = 10 * np.log10(float(np.mean(window ** 2)) + 1e-10)
                if over_the_mac and level < self._gate():
                    p = 0.0
                heard = Heard(window, p >= STOP, level if not over_the_mac and p >= 0.8 else None)
                recent.append(heard)
                if utterance is None:
                    run = run + 1 if p >= START else 0
                    if run < START_WINDOWS:
                        continue
                    start = list(recent)
                    start[:-run] = [h._replace(speech=False) for h in start[:-run]]  # only the run is speech yet
                    with self._lock:
                        utterance = Utterance(start, self._judge if self._checks_voices() else None)
                        self._capture, self._live_text = utterance.kept, ""
                else:
                    with self._lock:
                        utterance.add(heard)
                while utterance.ignored:
                    self.on_ignored(*utterance.ignored.pop(0))
                self.talking = utterance.talking
                if not announced and utterance.speech * WINDOW / RATE >= MIN_SPEECH:
                    announced = True
                    with self._lock:
                        self._you = True
                    self.on_speech()
                if not utterance.over(self.pause, bool(UNFINISHED.search(self._live_text))):
                    continue
                utterance.end()
                while utterance.ignored:
                    self.on_ignored(*utterance.ignored.pop(0))
                with self._lock:
                    self._capture, self._you = None, False
                done, utterance = utterance, None
                # the lead-in for what's next is the pause, less its start (maybe a word trailing off)
                while recent and len(recent) > done.gap - PHRASE_GAP * RATE / WINDOW:
                    recent.popleft()
                self.talking = False
                run, announced = 0, False
                vad.reset()
                said = done.speech * WINDOW / RATE
                if said < MIN_SPEECH:
                    continue
                if done.judge:  # all of it together decides too, not just each phrase
                    matched, similarity = self._judge(done.your_speech(MOST_CHECKED))
                    if not matched:
                        self.on_ignored(said, similarity)
                        continue
                self._levels.extend(done.levels)
                samples = done.samples
                if self.on_utterance:
                    self.on_utterance(samples)
                if self.words:
                    self._finished.put(samples)
            self._wake.set()

    # -- the worker thread: Parakeet --

    def _read(self, samples: np.ndarray) -> str:
        """Long recordings are read in overlapping pieces, as parakeet-mlx does for files."""
        if self.model is None or len(samples) < RATE // 10:
            return ""
        samples = np.concatenate([np.zeros(int(LEAD_IN * RATE), np.float32), samples])
        if len(samples) < MIN_SECONDS * RATE:  # on a very short clip it makes up a word ("Okay.")
            samples = np.pad(samples, (0, MIN_SECONDS * RATE - len(samples)))
        import mlx.core as mx
        from parakeet_mlx.alignment import (merge_longest_common_subsequence, merge_longest_contiguous,
                                            sentences_to_result, tokens_to_sentences)
        from parakeet_mlx.audio import get_logmel
        from parakeet_mlx.parakeet import DecodingConfig

        config = self.model.preprocessor_config
        def read(piece: np.ndarray):
            return self.model.generate(get_logmel(mx.array(piece), config))[0]

        if len(samples) <= CHUNK * RATE:
            return read(samples).text.strip()
        tokens: list = []
        for start in range(0, len(samples), (CHUNK - OVERLAP) * RATE):
            piece = samples[start:start + CHUNK * RATE]
            if len(piece) < RATE // 10:
                break
            result = read(piece)
            for token in result.tokens:
                token.start += start / RATE
                token.end = token.start + token.duration
            if not tokens:
                tokens = result.tokens
                continue
            try:
                tokens = merge_longest_contiguous(tokens, result.tokens, overlap_duration=OVERLAP)
            except RuntimeError:
                tokens = merge_longest_common_subsequence(tokens, result.tokens, overlap_duration=OVERLAP)
        return sentences_to_result(tokens_to_sentences(tokens, DecodingConfig().sentence)).text.strip()

    def _load(self):
        try:
            import mlx.core as mx
            from parakeet_mlx import from_pretrained
            if not os.path.exists(VAD_MODEL):
                raise FileNotFoundError("models/silero_vad.onnx isn't downloaded (./voice.sh does it)")
            self.model = from_pretrained(self.model_id, dtype=mx.float32)  # full precision
            self._read(np.zeros(RATE, dtype=np.float32))  # the first pass is slow; get it over with
        except Exception as e:  # not installed, not downloaded, no network for the first download
            self.model = None
            self.error = str(e).splitlines()[0][:200] if str(e) else type(e).__name__
        finally:
            self._ready.set()

    def _transcriber(self):
        self._load()
        shown_len = 0
        while True:
            self._wake.wait(0.1)
            self._wake.clear()
            while not self._requests.empty():
                samples, answer = self._requests.get()
                answer.put(self._read(samples))
            while not self._finished.empty():
                shown_len = 0
                self.on_text(self._read(self._finished.get()), True)
            with self._lock:
                capture = self._capture if self._you else None
                samples = np.concatenate([heard.window for heard in capture]) if capture else None
            if samples is None:
                shown_len = 0
            elif len(samples) >= RATE and len(samples) - shown_len >= RATE * 0.25:  # a quarter second more
                shown_len = len(samples)
                text = self._read(samples[-LIVE_WINDOW * RATE:])
                if text and text != self._live_text and self._capture is capture:
                    self._live_text = text
                    self.on_text(("… " if len(samples) > LIVE_WINDOW * RATE else "") + text, False)


def download() -> int:
    """Fetches Silero VAD into models/ and Parakeet into the Hugging Face cache, unless they're there."""
    if not os.path.exists(VAD_MODEL):
        import urllib.request
        print("Downloading the voice activity detector (Silero VAD, 2 MB)...", flush=True)
        try:
            os.makedirs(os.path.dirname(VAD_MODEL), exist_ok=True)
            urllib.request.urlretrieve(VAD_URL, VAD_MODEL + ".part")
            os.replace(VAD_MODEL + ".part", VAD_MODEL)
        except Exception as e:
            print(f"Couldn't download it: {e}")
            return 1
    from huggingface_hub import snapshot_download
    model_id = os.environ.get("STT_MODEL") or DEFAULT_MODEL
    try:
        snapshot_download(model_id, local_files_only=True)
        return 0
    except Exception:  # not downloaded yet
        pass
    print(f"Downloading the speech recognition model ({model_id}, about 2.4 GB, once)...", flush=True)
    try:
        snapshot_download(model_id)
        return 0
    except Exception as e:
        print(f"Couldn't download it: {e}")
        return 1


def main(argv: list[str]) -> int:
    import settings
    settings.load()
    if "--download" in argv:
        return download()

    from voiceprint import Voiceprint

    def show(text: str, final: bool):
        print(f"{'✔' if final else '…'} {text}", flush=True)
    ears = Ears(show, voiceprint=Voiceprint())
    ears.on_ignored = lambda seconds, similarity: print(
        f"  (not your voice, ignored: {seconds:.1f} s, {similarity:.2f} like yours)", flush=True)
    print(f"Listening with {ears.describe()}. Echo cancellation: {ears.microphone.describe()}. "
          f"Only you: {ears.voiceprint.describe()}. Talk; Ctrl-C to stop.", flush=True)
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
