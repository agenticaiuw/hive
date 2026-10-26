"""Listens all the time and writes down what you say as you say it, with Parakeet (NVIDIA's
open-source speech recognition model) running on this Mac through MLX.

Silero VAD (an open-source voice activity detector, models/silero_vad.onnx) notices when you
start talking. The words show up as you go, and once you stop for LISTEN_PAUSE seconds (1.2 by
default; longer if you trailed off on "and..." or a comma), the whole thing is transcribed once
more for the final text. Coughs and clicks too short to be speech are ignored. It hears through
python/mic.py, which takes whatever the Mac is playing (the agent's own voice, a video) back out
of what the microphone picks up.

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
OVER_THE_MAC = 12  # dB: while the Mac plays, speech has to be within this much of how loud you usually are
USUAL_LEVEL = -23  # dB: how loud you are until it has heard you a few times
PREROLL = 0.5  # seconds kept from before it noticed you talking
LONG_PAUSE = 2.5  # how long it waits when you trailed off mid-sentence
UNFINISHED = re.compile(r"(,|\b(and|or|but|so|then|to|the|a|an|um|uh|because|with|of|for|like|if|that))\W*$", re.I)
LIVE_WINDOW = 30  # seconds of the latest audio the live preview re-reads
CHUNK, OVERLAP = 120, 15  # the final pass reads long recordings in overlapping pieces
MIN_SECONDS = 2  # shorter audio is padded with silence
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


class Ears:
    """on_text(text, final) is called from a background thread: with final=False as the words
    come while you talk, then once with final=True when you've finished. on_speech() is called
    once you've talked long enough that it isn't a cough (~0.3 s), before any words are ready.

    deaf() is asked for every bit of audio: while it's true what the microphone hears is
    ignored (the agent's own voice out of the speakers, when echo cancellation can't hear the
    Mac). mic=False leaves the microphone closed; feed() then takes the audio (the tests use it)."""

    def __init__(self, on_text, mic: bool = True, deaf=lambda: False):
        self.on_text = on_text
        self.on_speech = lambda: None
        self.deaf = deaf
        self.pause = float(os.environ.get("LISTEN_PAUSE") or 1.2)
        self.model_id = os.environ.get("STT_MODEL") or DEFAULT_MODEL
        self.model = None
        self.error: str | None = None
        self.mic_level = 0.0  # loudest sample so far; still 0 after a few seconds means no microphone access
        self.talking = False  # in the middle of hearing you
        self._ready = threading.Event()
        self._lock = threading.Lock()
        self._blocks: queue.Queue = queue.Queue()
        self._capture: list[np.ndarray] | None = None  # what you're saying, while you say it
        self._finished: queue.Queue = queue.Queue()  # whole utterances waiting for the final pass
        self._live_text = ""
        self._levels: collections.deque[float] = collections.deque(maxlen=300)  # dB of your speech, Mac quiet
        self._wake = threading.Event()
        self._requests: queue.Queue = queue.Queue()  # transcribe() calls from other threads
        self._worker = threading.Thread(target=self._transcriber, daemon=True)  # MLX wants one thread
        self._worker.start()
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

    def _segmenter(self):
        try:
            vad = VAD()
        except Exception as e:
            self.error = f"Silero VAD: {e}"
            return
        preroll: collections.deque[np.ndarray] = collections.deque(maxlen=int(PREROLL * RATE / WINDOW))
        pending = np.zeros(0, np.float32)
        pending_playing = np.zeros(0, bool)
        run = speech = quiet = 0  # windows: speech in a row before starting; speech and quiet while talking
        announced = False  # on_speech() was called for this stretch
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
                    preroll.clear()
                    run = 0
                    continue
                p = vad(window)
                level = 10 * np.log10(float(np.mean(window ** 2)) + 1e-10)
                if over_the_mac and level < self._gate():
                    p = 0.0
                elif not over_the_mac and p >= 0.8:
                    self._levels.append(level)
                if self._capture is None:
                    preroll.append(window)
                    run = run + 1 if p >= START else 0
                    if run >= START_WINDOWS:
                        with self._lock:
                            self._capture, self._live_text = list(preroll), ""
                        self.talking = True
                        speech, quiet = run, 0
                        preroll.clear()
                    continue
                with self._lock:
                    self._capture.append(window)
                if p >= STOP:
                    speech, quiet = speech + 1, 0
                    if not announced and speech * WINDOW / RATE >= MIN_SPEECH:
                        announced = True
                        self.on_speech()
                else:
                    quiet += 1
                waited = quiet * WINDOW / RATE
                if waited >= self.pause and (waited >= LONG_PAUSE or not UNFINISHED.search(self._live_text)):
                    with self._lock:
                        capture, self._capture = self._capture, None
                    self.talking = False
                    run, announced = 0, False
                    vad.reset()
                    if speech * WINDOW / RATE >= MIN_SPEECH:
                        self._finished.put(np.concatenate(capture))
            self._wake.set()

    # -- the worker thread: Parakeet --

    def _read(self, samples: np.ndarray) -> str:
        """Long recordings are read in overlapping pieces, as parakeet-mlx does for files."""
        if self.model is None or len(samples) < RATE // 10:
            return ""
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
                capture = self._capture
                samples = np.concatenate(capture) if capture else None
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

    def show(text: str, final: bool):
        print(f"{'✔' if final else '…'} {text}", flush=True)
    ears = Ears(show)
    print(f"Listening with {ears.describe()}. Echo cancellation: {ears.microphone.describe()}. "
          "Talk; Ctrl-C to stop.", flush=True)
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
