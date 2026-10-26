"""The agent's voice: Kokoro-82M, an open-source text-to-speech model that runs on this Mac.
Natural and calm, and quick: it starts speaking while it's still working on the next sentence.
Each sentence plays through afplay, so it comes out of whatever the sound output is right now.

    .venv/bin/python python/speech.py "Hello, I'm your Mac."        # try it
    TTS_VOICE=am_michael .venv/bin/python python/speech.py "Hello."  # try another voice

  TTS_VOICE   af_heart (default), af_sarah, af_bella, am_michael, am_adam, bf_emma, bm_george, ...
              (af/am: American, bf/bm: British), or "say" for the Mac's own voice
  TTS_SPEED   1.0 is normal

./voice.sh downloads the model into models/ (350 MB, once). Without it, or without the Python
packages (requirements.txt), it falls back to the Mac's `say`.
"""

from __future__ import annotations

import os
import queue
import re
import subprocess
import sys
import tempfile
import threading
import time
import wave

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
MODEL = os.path.join(ROOT, "models", "kokoro-v1.0.onnx")
VOICES = os.path.join(ROOT, "models", "voices-v1.0.bin")
LANGS = {"a": "en-us", "b": "en-gb", "e": "es", "f": "fr-fr", "h": "hi", "i": "it", "p": "pt-br"}
RATE = 24000
ECHO = 0.3  # seconds the room keeps echoing after a sentence (for when the listener can't cancel it)


def sentences(text: str) -> list[str]:
    """Splits text where it can pause, so the first sentence plays while the next is made."""
    parts = [p.strip() for p in re.split(r"(?<=[.!?;:])\s+|\n+", text) if p.strip()]
    merged: list[str] = []
    for part in parts:  # very short pieces ("Done.") sound better joined to the next
        if merged and len(merged[-1]) < 12:
            merged[-1] += " " + part
        else:
            merged.append(part)
    return merged


class Voice:
    """may_speak() is asked before each sentence; it waits while that's false (you're talking).
    on_play(words) is told each sentence as it starts playing (for captions)."""

    def __init__(self, may_speak=lambda: True, on_play=lambda words: None):
        self.may_speak = may_speak
        self.on_play = on_play
        self.voice = os.environ.get("TTS_VOICE") or "af_heart"
        self.speed = float(os.environ.get("TTS_SPEED") or 1.0)
        self.error: str | None = None
        self._kokoro = None
        self._ready = threading.Event()
        self._texts: queue.Queue = queue.Queue()
        self._audio: queue.Queue = queue.Queue()
        self._generation = 0  # stop() moves on to a new one; anything from an older one is dropped
        self._pending = 0     # things said that haven't finished playing
        self._idle = threading.Condition()
        self._player: subprocess.Popen | None = None
        self._quiet_since = 0.0  # when the last sentence finished playing
        self._dir = tempfile.mkdtemp(prefix="agent-voice-")
        if self.voice == "say":
            self._ready.set()
        else:
            threading.Thread(target=self._load, daemon=True).start()
        threading.Thread(target=self._make_audio, daemon=True).start()
        threading.Thread(target=self._play, daemon=True).start()

    def _load(self):
        try:
            from kokoro_onnx import Kokoro
            if not os.path.exists(MODEL):
                raise FileNotFoundError("the model isn't downloaded (./voice.sh does it)")
            kokoro = Kokoro(MODEL, VOICES)
            if self.voice not in kokoro.get_voices():
                raise ValueError(f"there's no voice {self.voice!r} (try af_heart, am_michael or bf_emma)")
            self._kokoro = kokoro
        except Exception as e:  # missing packages or model: the Mac's voice will do
            self.error = str(e) if isinstance(e, (FileNotFoundError, ValueError)) else f"{type(e).__name__}: {e}"
        finally:
            self._ready.set()

    def describe(self) -> str:
        self._ready.wait(30)
        if self._kokoro:
            return f"Kokoro ({self.voice})"
        return f"the Mac's voice (Kokoro: {self.error})" if self.error else "the Mac's voice"

    def say(self, text: str):
        if text.strip():
            with self._idle:
                self._pending += 1
            self._texts.put((self._generation, text))

    def stop(self):
        """Stops talking at once and forgets anything it was about to say."""
        self._generation += 1
        player = self._player
        if player and player.poll() is None:
            try:
                player.terminate()
            except ProcessLookupError:
                pass

    def audible(self) -> bool:
        """Speaking, or just finished and the room is still echoing."""
        player = self._player
        return (player is not None and player.poll() is None) or time.monotonic() < self._quiet_since + ECHO

    def wait(self, timeout: float | None = None) -> bool:
        with self._idle:
            return self._idle.wait_for(lambda: self._pending == 0, timeout)

    def _done(self):
        with self._idle:
            self._pending -= 1
            self._idle.notify_all()

    def render(self, text: str):
        """One piece of text as float32 samples at 24 kHz."""
        samples, _rate = self._kokoro.create(text, voice=self.voice, speed=self.speed,
                                             lang=LANGS.get(self.voice[0], "en-us"))
        return samples

    def _make_audio(self):
        while True:
            generation, text = self._texts.get()
            self._ready.wait()
            try:
                if generation != self._generation:
                    continue
                if not self._kokoro:
                    self._audio.put((generation, ["say", text], text))
                    continue
                for sentence in sentences(text):
                    if generation != self._generation:
                        break
                    self._audio.put((generation, ["afplay", self._wav(self.render(sentence))], sentence))
            except Exception as e:
                print(f"   ✗ voice: {e}", flush=True)
            finally:
                self._audio.put((generation, None, None))  # this text is done: _play calls _done

    def _wav(self, samples) -> str:
        import numpy as np
        fd, path = tempfile.mkstemp(suffix=".wav", dir=self._dir)
        with os.fdopen(fd, "wb") as f, wave.open(f) as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(RATE)
            w.writeframes((np.clip(samples, -1, 1) * 32767).astype("<i2").tobytes())
        return path

    def _start(self, command: list[str]) -> subprocess.Popen:
        return subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    def _play(self):
        while True:
            generation, command, words = self._audio.get()
            if command is None:
                self._done()
                continue
            try:
                while not self.may_speak() and generation == self._generation:
                    time.sleep(0.05)
                if generation == self._generation:
                    self.on_play(words)
                    self._player = self._start(command)
                    self._player.wait()
                    self._quiet_since = time.monotonic()
            except Exception as e:
                print(f"   ✗ voice: {e}", flush=True)
            finally:
                if command[0] == "afplay":
                    try:
                        os.unlink(command[1])
                    except OSError:
                        pass


def main(argv: list[str]) -> int:
    sys.path.insert(0, HERE)
    import settings
    settings.load()
    text = " ".join(argv) or "Hi! I'm the voice of your computer agent. Just tell me what to do."
    voice = Voice()
    print(f"Speaking with {voice.describe()}.")
    voice.say(text)
    voice.wait()
    time.sleep(0.3)  # the last bit still in the speakers
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
