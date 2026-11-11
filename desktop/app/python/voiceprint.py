"""Tells your voice from anyone else's, so the voice agent ignores people talking nearby (and a
video playing on another device) instead of writing it down and acting on it.

WeSpeaker's ResNet34 (an open-source speaker recognition model trained on VoxCeleb; 26 MB,
CC BY 4.0, downloaded from Hugging Face) turns a stretch of speech into a voiceprint: 256 numbers
that come out alike for the same voice. You teach it yours once:

    ./voice.sh --enroll                              # read a few sentences aloud
    .venv/bin/python python/voiceprint.py --forget   # back to hearing everyone

Your voiceprint stays on this Mac, in models/voiceprint.npz. Enrolling again (with another
microphone, say) adds to it. VOICE_MATCH is how alike a sentence has to sound to count as you:
0.4 by default (your own voice scores around 0.6-0.9, other people's under 0.3); lower it if it
ignores you, raise it if it still hears others; 0 turns it off. A word or two gets a little more leeway.
"""

from __future__ import annotations

import os
import sys
import time

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

RATE = 16000
REPO = "Wespeaker/wespeaker-voxceleb-resnet34-LM"
REVISION = "f0c48c298fd835726c27956a5d617bad7115627e"
MODEL_FILE = "voxceleb_resnet34_LM.onnx"
PRINTS = os.path.join(ROOT, "models", "voiceprint.npz")
MATCH = 0.4
MIN_AUDIO = 0.25  # seconds of speech it needs to say anything at all
FULL = 1.5  # seconds of speech for a steady voiceprint; shorter ones are rougher...
SHORT_SLACK = 0.1  # ...so a word or two only has to be this much less alike
MACHINE = 0.45  # this alike to its own voice (Kokoro, through the speakers) is it hearing itself...
MACHINE_SHORT = 0.3  # ...or this, for a word or two (it measured 0.6-0.75 through a room, people about 0)
SENTENCES = [  # to read aloud when enrolling: varied sounds, about five seconds each
    "Open Safari and find the weather for this weekend in Seattle.",
    "Check my recent orders on Amazon and tell me when the next one arrives.",
    "Reply to the last message from my brother and say I'll call him tonight.",
    "Play some quiet jazz, then turn the volume down to about thirty percent.",
    "Stop. Never mind. Yes, go ahead with the second one, please.",
]


class Voiceprint:
    """matches(samples) says whether 16 kHz mono float32 speech is the enrolled voice, and how
    alike it is (cosine similarity, -1 to 1). With nobody enrolled, everyone matches."""

    def __init__(self, path: str = PRINTS):
        self.path = path
        self.threshold = float(os.environ.get("VOICE_MATCH") or MATCH)
        self.error: str | None = None
        self._session = None
        self.machine = np.zeros((0, 256), np.float32)  # the agent's own voice (learn_voice), never you
        self.heard_machine = False  # the last thing left out was its own voice
        try:
            with np.load(path) as saved:
                self.prints = saved["prints"].astype(np.float32)
        except (OSError, KeyError, ValueError):
            self.prints = np.zeros((0, 256), np.float32)

    @property
    def enrolled(self) -> bool:
        return len(self.prints) > 0

    @property
    def checks(self) -> bool:
        """Something is left out: other people (you're enrolled) or its own voice (learned)."""
        return (self.enrolled and self.threshold > 0) or len(self.machine) > 0

    def learn_voice(self, clips: list[np.ndarray], rate: int):
        """Learns the agent's own voice from some of its speech (rendered, not played), so what
        of it gets past the echo canceller is left out, even with nobody enrolled."""
        from math import gcd
        from scipy.signal import resample_poly
        g = gcd(RATE, rate)
        embeddings = np.stack([self.embed(resample_poly(c, RATE // g, rate // g).astype(np.float32)) for c in clips])
        mean = embeddings.mean(axis=0)
        self.machine = (mean / np.linalg.norm(mean))[None].astype(np.float32)

    def ready(self) -> bool:
        """Loads the model (the first time); False, with error set, if it can't."""
        if self._session is None and self.error is None:
            try:
                import kaldi_native_fbank  # noqa: F401
                import onnxruntime
                from huggingface_hub import hf_hub_download
                model = hf_hub_download(REPO, MODEL_FILE, revision=REVISION, local_files_only=True)
                options = onnxruntime.SessionOptions()
                options.inter_op_num_threads, options.intra_op_num_threads = 1, 2
                self._session = onnxruntime.InferenceSession(model, options, providers=["CPUExecutionProvider"])
                self.embed(np.zeros(RATE, np.float32))  # the first run is slow; get it over with
            except Exception as e:  # not installed, or not downloaded (./voice.sh does both)
                self.error = str(e).splitlines()[0][:200] if str(e) else type(e).__name__
        return self._session is not None

    def describe(self) -> str:
        if not self.enrolled:
            return "off (anyone talking nearby is heard; ./voice.sh --enroll teaches it your voice)"
        if self.threshold <= 0:
            return "off (VOICE_MATCH 0: everyone talking nearby is heard)"
        if not self.ready():
            return f"off ({self.error})"
        return f"on (your voice, VOICE_MATCH {self.threshold:g})"

    def embed(self, samples: np.ndarray) -> np.ndarray:
        """The voiceprint of some speech, scaled to length 1."""
        import kaldi_native_fbank as knf
        options = knf.FbankOptions()  # as WeSpeaker computes them
        options.frame_opts.samp_freq = RATE
        options.frame_opts.dither = 0.0
        options.frame_opts.window_type = "hamming"
        options.mel_opts.num_bins = 80
        fbank = knf.OnlineFbank(options)
        fbank.accept_waveform(RATE, (samples * 32768).tolist())
        fbank.input_finished()
        feats = np.array([fbank.get_frame(i) for i in range(fbank.num_frames_ready)], np.float32)
        feats -= feats.mean(axis=0)  # mean normalization over the utterance
        embedding = self._session.run(None, {"feats": feats[None]})[0][0]
        return embedding / (np.linalg.norm(embedding) + 1e-9)

    def needed(self, seconds: float) -> float:
        """How alike seconds of speech has to be."""
        short = min(1.0, max(0.0, (FULL - seconds) / (FULL - MIN_AUDIO)))
        return self.threshold - SHORT_SLACK * short

    def matches(self, samples: np.ndarray) -> tuple[bool, float]:
        if not self.checks or len(samples) < MIN_AUDIO * RATE or not self.ready():
            return True, 1.0
        seconds = len(samples) / RATE
        embedding = self.embed(samples)
        you = float(np.max(self.prints @ embedding)) if self.enrolled else 0.0
        if len(self.machine):
            short = min(1.0, max(0.0, (FULL - seconds) / (FULL - MIN_AUDIO)))
            itself = float(np.max(self.machine @ embedding))
            if itself >= MACHINE - (MACHINE - MACHINE_SHORT) * short and itself > you:
                self.heard_machine = True
                return False, you
        self.heard_machine = False
        if self.threshold <= 0 or not self.enrolled:
            return True, 1.0
        return you >= self.needed(seconds), you

    def add(self, clips: list[np.ndarray]):
        """Enrolls a voice from a few clips of it."""
        embeddings = np.stack([self.embed(clip) for clip in clips])
        mean = embeddings.mean(axis=0)
        self.prints = np.concatenate([self.prints, (mean / np.linalg.norm(mean))[None]])
        self.save()

    def save(self):
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        part = self.path + ".part.npz"
        np.savez(part, prints=self.prints)
        os.chmod(part, 0o600)
        os.replace(part, self.path)

    def forget(self):
        self.prints = np.zeros((0, 256), np.float32)
        if os.path.exists(self.path):
            os.remove(self.path)


def download() -> int:
    """Fetches the speaker model into the Hugging Face cache, unless it's there."""
    from huggingface_hub import hf_hub_download
    try:
        hf_hub_download(REPO, MODEL_FILE, revision=REVISION, local_files_only=True)
        return 0
    except Exception:  # not downloaded yet
        pass
    print("Downloading the speaker recognition model (WeSpeaker ResNet34, 26 MB, once)...", flush=True)
    try:
        hf_hub_download(REPO, MODEL_FILE, revision=REVISION)
        return 0
    except Exception as e:
        print(f"Couldn't download it: {e}")
        return 1


def enroll() -> int:
    """Has you read SENTENCES aloud and keeps the voiceprint."""
    import queue

    import listen
    voiceprint = Voiceprint()
    if not voiceprint.ready():
        print(f"Can't enroll: {voiceprint.error}. Run ./voice.sh once to set it up.")
        return 1
    heard: queue.Queue = queue.Queue()
    ears = listen.Ears(lambda *_: None, words=False)
    ears.on_utterance = heard.put  # the raw audio of each thing you say, nothing transcribed
    print("Teaching it your voice. Somewhere quiet, at your usual distance from the microphone, read each "
          "line aloud after it appears. Ctrl-C to give up.\n", flush=True)
    time.sleep(1)  # the microphone is opening
    if ears.mic_error:
        print(f"The microphone didn't open: {ears.mic_error}")
        return 1
    clips: list[np.ndarray] = []
    try:
        for sentence in SENTENCES:
            print(f"  “{sentence}”", flush=True)
            while True:
                clip = heard.get()
                if len(clip) >= 2 * RATE:
                    clips.append(clip)
                    break
                print("    (that was short; read the whole line)", flush=True)
    except KeyboardInterrupt:
        print("\nStopped; nothing saved.")
        return 1
    embeddings = [voiceprint.embed(clip) for clip in clips]
    mean = np.mean(embeddings, axis=0)
    mean /= np.linalg.norm(mean)
    odd = [i for i, e in enumerate(embeddings) if float(e @ mean) < voiceprint.threshold]
    if odd:
        print(f"\nLine {', '.join(str(i + 1) for i in odd)} didn't sound like the rest (someone else talking, "
              "or a lot of noise?). Nothing saved; try again somewhere quieter.")
        return 1
    voiceprint.add(clips)
    print(f"\nGot it. From now on the voice agent only listens to you ({len(voiceprint.prints)} voiceprint"
          f"{'s' if len(voiceprint.prints) > 1 else ''} in models/voiceprint.npz).", flush=True)
    return 0


def main(argv: list[str]) -> int:
    import settings
    settings.load()
    if "--download" in argv:
        return download()
    if "--forget" in argv:
        Voiceprint().forget()
        print("Forgot your voice; the voice agent hears everyone again.")
        return 0
    if "--enroll" in argv:
        return enroll()
    print(__doc__)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
