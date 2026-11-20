"""The wake words: "hive" shows the floating window, "bye" puts it away (the owner, 2026-11-20: "make
sure hive and bye are wakewords and not using the same transcription model").

A model of their own hears them, never Parakeet: Moonshine tiny (Useful Sensors' 27M-parameter
English recognizer, as sherpa-onnx's quantized release: models/wake, 28 MB), run with onnxruntime.
listen.Ears hands it everything short that's said, listening or not, muted or not, and nothing it
takes as a wake word goes on to Parakeet.

Left to itself, Moonshine writes a lone "hive" as a commoner word ("Five.", "Hi.", "I've"), so the
word is also scored directly: how likely Moonshine finds "Hive" against what it would have written.
On 10 macOS voices (2026-11-20) that heard "hive" 17 times in 30 and "bye" 25 in 30, with 5 false
hits in 200 other phrases, all as "bye" ("Bike." 3, "Buy it.", "Thanks."); Moonshine's own text
alone heard "hive" 0 times in 30. sherpa-onnx's GigaSpeech keyword spotter heard 11 in 32.

  python/wake.py --download   puts the model in models/wake once (./voice.sh, tools/first-open.sh)
"""

import base64
import hashlib
import os
import re
import sys
import tarfile
import tempfile
import urllib.request

import numpy as np

RATE = 16000
HERE = os.path.dirname(os.path.abspath(__file__))
MODELS = os.path.join(HERE, "..", "models", "wake")
RELEASE = ("https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/"
           "sherpa-onnx-moonshine-tiny-en-quantized-2026-02-27.tar.bz2")
SHA256 = "9ec31b342d8fa3240c3b81b8f82e1cf7e3ac467c93ca5a999b741d5887164f8d"
FILES = ["encoder_model.ort", "decoder_model_merged.ort", "tokens.txt"]
BYE = {"bye", "by", "buy"}  # one sound: Moonshine writes "bye" either way
HIVE = [["▁H", "ive"], ["▁h", "ive"]]  # "Hive" as Moonshine's word pieces
ENDINGS = [[], ["."], ["!"]]
# How much less likely than what Moonshine would have written "Hive" may be and still count
# (natural log). -4 heard 16 of 30 with no false "hive" in 230; -5 heard 20 with 1.
MARGIN = float(os.environ.get("WAKE_MARGIN") or -4.0)
LEAD = 0.3  # seconds of quiet either side, as Moonshine was trained on
ROOM = 0.003  # that quiet's level (about -50 dBFS): digital silence there halved what it heard
LONGEST = 10  # word pieces it writes at most: a wake word is one or two


def downloaded() -> bool:
    return all(os.path.exists(os.path.join(MODELS, name)) for name in FILES)


def download():
    """The model from sherpa-onnx's GitHub release, checked against its known SHA-256."""
    if downloaded():
        return
    os.makedirs(MODELS, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="hive-wake-") as tmp:
        archive = os.path.join(tmp, "wake.tar.bz2")
        print("Downloading the wake-word model (Moonshine tiny, 28 MB)...", flush=True)
        urllib.request.urlretrieve(RELEASE, archive)
        with open(archive, "rb") as f:
            got = hashlib.sha256(f.read()).hexdigest()
        if got != SHA256:
            raise RuntimeError(f"the wake-word model's checksum is {got}, not {SHA256}")
        with tarfile.open(archive, "r:bz2") as tar:
            members = {os.path.basename(m.name): m for m in tar.getmembers() if m.isfile()}
            for name in FILES:
                data = tar.extractfile(members[name]).read()
                with open(os.path.join(MODELS, name + ".part"), "wb") as out:
                    out.write(data)
                os.replace(os.path.join(MODELS, name + ".part"), os.path.join(MODELS, name))


class WakeWords:
    """heard(samples) with one thing said (16 kHz mono float32, a few seconds at most) answers
    "hive" or "bye" if that's all it was, else None."""

    def __init__(self, folder: str = MODELS):
        import onnxruntime as ort
        if not all(os.path.exists(os.path.join(folder, name)) for name in FILES):
            raise FileNotFoundError("models/wake isn't downloaded (./voice.sh does it)")
        options = ort.SessionOptions()
        options.intra_op_num_threads = options.inter_op_num_threads = 1
        self._encoder = ort.InferenceSession(os.path.join(folder, "encoder_model.ort"), options,
                                             providers=["CPUExecutionProvider"])
        self._decoder = ort.InferenceSession(os.path.join(folder, "decoder_model_merged.ort"), options,
                                             providers=["CPUExecutionProvider"])
        self._past = [(i.name, i.shape[1], i.shape[3]) for i in self._decoder.get_inputs()
                      if i.name.startswith("past_key_values")]
        self._pieces: dict[int, str] = {}
        with open(os.path.join(folder, "tokens.txt"), encoding="utf-8") as tokens:
            for line in tokens:
                piece, number = line.rstrip("\n").rsplit(" ", 1)
                self._pieces[int(number)] = base64.b64decode(piece).decode("utf-8", "replace")
        ids = {piece: number for number, piece in self._pieces.items()}
        self._quiet = np.random.default_rng(0).standard_normal(int(LEAD * RATE)).astype(np.float32) * ROOM
        self._hive = [[ids[p] for p in spelling + ending] + [EOS] for spelling in HIVE for ending in ENDINGS]

    def heard(self, samples: np.ndarray) -> str | None:
        quiet = self._quiet
        audio = np.concatenate([quiet, np.asarray(samples, np.float32), quiet])
        states = self._encoder.run(None, {"input_values": audio[None],
                                          "attention_mask": np.ones((1, len(audio)), np.int64)})[0]
        written, likelihood = self._write(states)
        words = re.findall(r"[a-z']+", written.lower())
        if words == ["hive"]:
            return "hive"
        if len(words) == 1 and words[0] in BYE:
            return "bye"
        if max(self._likelihood(states, spelling) for spelling in self._hive) - likelihood >= MARGIN:
            return "hive"
        return None

    def _logprobs(self, states: np.ndarray, pieces: list[int]) -> np.ndarray:
        """Each next piece's log-probability after each of pieces (which start with BOS)."""
        frames = states.shape[1]
        feed = {"input_ids": np.array([pieces], np.int64), "encoder_hidden_states": states,
                "encoder_attention_mask": np.ones((1, frames), np.int64), "use_cache_branch": np.array([False])}
        for name, heads, size in self._past:
            feed[name] = np.zeros((1, heads, frames if ".encoder." in name else 0, size), np.float32)
        logits = self._decoder.run(["logits"], feed)[0][0].astype(np.float64)
        logits -= logits.max(axis=-1, keepdims=True)
        return logits - np.log(np.exp(logits).sum(axis=-1, keepdims=True))

    def _likelihood(self, states: np.ndarray, pieces: list[int]) -> float:
        logprobs = self._logprobs(states, [BOS] + pieces[:-1])
        return float(sum(logprobs[i, piece] for i, piece in enumerate(pieces)))

    def _write(self, states: np.ndarray) -> tuple[str, float]:
        """What Moonshine would write (greedily), and how likely it finds that."""
        pieces: list[int] = []
        while len(pieces) < LONGEST and (not pieces or pieces[-1] != EOS):
            pieces.append(int(self._logprobs(states, [BOS] + pieces)[-1].argmax()))
        text = "".join(self._pieces[p] for p in pieces if p > EOS).replace("▁", " ").strip()
        return text, self._likelihood(states, pieces)


BOS, EOS = 1, 2  # Moonshine's <s> and </s>


if __name__ == "__main__":
    if "--download" in sys.argv:
        download()
        print("models/wake: ready" if downloaded() else "models/wake: missing")
