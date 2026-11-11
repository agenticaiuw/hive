"""The voice sidecar with no models, microphone or speakers, for hive-sidecars' tests.

It is python/sidecar_voice.py's real Server, protocol and reporting mixins, over:
  - FakeEars: listen.Ears' surface, with what it hears scripted by the test ({"cmd": "fake", ...});
  - FakeVoiceprint: voiceprint.Voiceprint's surface;
  - Silent: python/speech.py's real Voice with its player swapped for `sleep FAKE_PLAY_SECONDS`
    (TTS_VOICE=say by default, so no Kokoro; otherwise Kokoro's model path points nowhere).

Needs only the standard library (any python3).
"""

import os
import queue
import subprocess
import sys
import threading
import time
from pathlib import Path

PYTHON = Path(__file__).resolve().parents[5] / "python"
sys.path.insert(0, str(PYTHON))

import sidecar_voice  # noqa: E402
import speech  # noqa: E402

os.environ.setdefault("TTS_VOICE", "say")
speech.MODEL = "/nonexistent/kokoro-v1.0.onnx"  # never the real Kokoro, whatever TTS_VOICE says
PLAY = float(os.environ.get("FAKE_PLAY_SECONDS") or 0.3)


def raw_clock() -> float:
    return time.clock_gettime(time.CLOCK_UPTIME_RAW)


class Silent(speech.Voice):
    """Plays nothing: each sentence takes PLAY seconds of `sleep`."""

    def __init__(self, **kwargs):
        self.played: list[str] = []
        self.said_at: list[float] = []
        super().__init__(**kwargs)

    def say(self, text):
        self.said_at.append(raw_clock())
        super().say(text)

    def _start(self, command):
        self.played.append(command[1] if command[0] == "say" else "(audio)")
        return subprocess.Popen(["sleep", str(PLAY)])


class FakeMicrophone:
    def __init__(self):
        self.name, self.error, self.tap_error, self.canceller_error = "Fake Microphone", None, None, None
        self.heard_mac_at = 0.0

    def describe(self):
        return "on (it takes what the Mac plays out of what it hears)"

    def hears_the_mac(self):
        return time.monotonic() - self.heard_mac_at < 1.0


class FakeVoiceprint:
    def __init__(self):
        self.heard_machine = False

    def describe(self):
        return "on (your voice, VOICE_MATCH 0.4)"

    def ready(self):
        return True


class FakeEars:
    """listen.Ears' surface. What you're saying (capture) goes out as final text when you pause
    (hear(..., final=True)) or it's cut, in order, from a "transcribing" thread, as Ears does."""

    def __init__(self, on_text, deaf=lambda: False, voiceprint=None, listening=True):
        self.on_text, self.deaf, self.voiceprint, self.listening = on_text, deaf, voiceprint, listening
        self.on_speech = lambda: None
        self.on_ignored = lambda seconds, similarity: None
        self.model, self.error = "fake", os.environ.get("FAKE_EARS_ERROR") or None
        self.mic_level = 0.0
        self.talking = False
        self.heard_times = {}
        self.microphone = FakeMicrophone()
        self.calls = []
        self.capture = ""
        self._finished = queue.Queue()
        threading.Thread(target=self._transcriber, daemon=True).start()

    def describe(self):
        return "Parakeet (fake)"

    def hears_the_mac(self):
        return self.microphone.hears_the_mac()

    def listen(self, on):
        if on == self.listening:
            return
        self.calls.append(["listen", on])
        self.listening = on
        if not on:
            self.cut()

    def cut(self, then=None):
        self.calls.append(["cut", then is not None])
        if self.capture:
            self._finished.put(self.capture)
            self.capture = ""
        if then:
            self._finished.put(then)

    def hear(self, text, final):
        if not self.listening:
            return
        if final:
            self.capture = ""
            self._finished.put(text)
        else:
            self.capture = text
            self.on_text(text, False)

    def _transcriber(self):
        while True:
            finished = self._finished.get()
            if callable(finished):
                finished()
                continue
            time.sleep(0.05)  # "writing it down"
            now = time.monotonic()
            self.heard_times = {"stopped": now - 0.9, "decided": now - 0.05, "written": now}
            self.on_text(finished, True)


class FakeServer(sidecar_voice.Server):
    speakers = True

    def handle(self, message):
        if message.get("cmd") != "fake":
            return super().handle(message)
        ears = self.ears
        if message.get("speech"):
            ears.on_speech()
        if "hear" in message:
            ears.hear(message["hear"], bool(message.get("final")))
        if "ignored" in message:
            ears.voiceprint.heard_machine = bool(message.get("machine"))
            ears.on_ignored(*message["ignored"])
        if "talking" in message:
            ears.talking = message["talking"]
        if "mic_level" in message:
            ears.mic_level = message["mic_level"]
        if message.get("mac_plays"):
            ears.microphone.heard_mac_at = time.monotonic()
        if "speakers" in message:
            self.speakers = message["speakers"]
        if "print" in message:
            print(message["print"], flush=True)
        if "stall" in message:  # the transcriber is busy this long (what's cut after it waits)
            ears._finished.put(lambda: time.sleep(message["stall"]))
        if "exit" in message:  # it crashes
            os._exit(message["exit"])
        if "bench" in message:  # partial texts, each stamped just before it goes out
            stamps = []
            for i in range(message["bench"]):
                stamps.append(raw_clock())
                self.on_text(f"bench {i}", False)
                time.sleep(0.002)
            self.emit("reply", id=message["id"], stamps=stamps)
            return True
        if message.get("stamp"):  # when this command arrived
            self.arrived.append(raw_clock())
        if "id" in message:
            voice = self.voice
            self.emit("reply", id=message["id"], deaf=self.deaf(), may_speak=self.may_speak(), calls=ears.calls,
                      played=getattr(voice, "played", []), said_at=getattr(voice, "said_at", []),
                      play_at=self.play_at, arrived=self.arrived)
        return True

    arrived: list
    play_at: list

    def on_play(self, words):
        self.play_at.append(raw_clock())
        super().on_play(words)


def main(argv):
    out = sidecar_voice.protocol_out()
    server = FakeServer(out)
    server.arrived, server.play_at = [], []
    server.output_is_speakers = lambda: server.speakers
    sys.stdout = sidecar_voice.LogLines(lambda line: server.emit("log", line=line))
    voice = None
    if "--no-speak" not in argv:
        voice = sidecar_voice.reporting_voice(Silent, server)(may_speak=server.may_speak, on_play=server.on_play)
    server.voice = voice
    ears = sidecar_voice.reporting_ears(FakeEars, server)(
        server.on_text, deaf=server.deaf, voiceprint=None if "--no-voiceprint" in argv else FakeVoiceprint(),
        listening="--listening" in argv)
    server.attach(ears, voice)
    if "--die" in argv:
        sys.exit(3)
    server.hello(speech.ECHO)
    server.serve(sys.stdin)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
