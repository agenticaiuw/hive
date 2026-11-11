"""Hive's voice sidecar: what the Rust agent (crates/hive/hive-sidecars) hears and speaks through.

The models stay in Python and run here: listen.py's Ears (the microphone, with mic.py taking what the
Mac plays back out of it; Silero VAD; Parakeet), voiceprint.py (WeSpeaker) and speech.py's Voice
(Kokoro, or the Mac's `say`). This serves them to the agent as JSON lines: commands on stdin, events
on stdout.

They are one process because they share state that changes every 32 ms: what the microphone hears is
ignored while the agent's own voice is audible and the echo canceller can't hear the Mac (deaf), the
voice doesn't start a sentence while you're talking (may_speak), and it learns its own voice by
rendering Kokoro straight into the voiceprint model. Both rules are python/voice_agent.py's.

    .venv/bin/python python/sidecar_voice.py [--listening] [--no-speak] [--no-voiceprint]

It reads its settings (TTS_VOICE, LISTEN_PAUSE, STT_MODEL, VOICE_MATCH, ...) from its environment:
the agent loads .env before starting it.

stdin, one JSON object per line:
  {"cmd": "listen", "on": true}         Ears.listen
  {"cmd": "cut", "then": 7}             Ears.cut; "then" (or null) comes back as {"event": "then", "id": 7}
                                        once the words heard before the cut have gone out
  {"cmd": "say", "text": "..."}         Voice.say; every say ends with one {"event": "done"}
  {"cmd": "stop"}                       Voice.stop
  {"cmd": "describe", "id": 1, "what": "ears" | "voice" | "voiceprint"}
  {"cmd": "learn_its_voice", "id": 2}   render a few sentences with Kokoro into the voiceprint
  {"cmd": "quit"}                       (or the end of stdin) stop talking and exit

stdout, one JSON object per line:
  {"event": "hello", "pid", "speak", "voice", "echo", "voiceprint", "listening"}   once, when it's ready
  {"event": "text", "text": "...", "final": false}                                 the words so far
  {"event": "text", "text": "...", "final": true, "heard_times": {"stopped": 0.9, "decided": 0.1,
      "written": 0.0}}                  all of it; heard_times are seconds before this line was written
  {"event": "speech"}                   on_speech: you've talked long enough that it isn't a cough
  {"event": "ignored", "seconds": 1.2, "similarity": 0.1, "heard_machine": false}
  {"event": "then", "id": 7}
  {"event": "talking", "on": true}      Ears.talking changed
  {"event": "play", "words": "..."}     on_play: a sentence starts playing...
  {"event": "played"}                   ...and has stopped playing
  {"event": "done"}                     one say's text is all played (or dropped by stop)
  {"event": "status", "listening", "mic_level", "hears_the_mac_for", "microphone": {"name", "error",
      "tap_error", "canceller_error", "describe"} | null}                         every 0.25 s
  {"event": "reply", "id": 1, ...} or {"event": "reply", "id": 1, "error": "..."}
  {"event": "log", "line": "..."}       a line the model code printed (for Agent.log)
  {"event": "error", "error": "..."}    a command it couldn't carry out
"""

from __future__ import annotations

import json
import os
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

STATUS_EVERY = 0.25  # seconds between status events
HEARS_THE_MAC = 1.0  # mic.py: the tap carried sound this recently


class Talking:
    """Mixed into listen.Ears: reports each change of `talking`, which it sets for every window."""

    _talking = False
    on_talking = staticmethod(lambda on: None)

    @property
    def talking(self) -> bool:
        return self._talking

    @talking.setter
    def talking(self, on: bool):
        changed = bool(on) != self._talking
        self._talking = bool(on)
        if changed:
            self.on_talking(self._talking)


class Watched:
    """A player process (afplay, say) that reports when it has stopped playing."""

    def __init__(self, process, stopped):
        self._process, self._stopped = process, stopped

    def poll(self):
        return self._process.poll()

    def terminate(self):
        return self._process.terminate()

    def wait(self, timeout=None):
        code = self._process.wait(timeout)
        self._stopped()
        return code


class Reporting:
    """Mixed into speech.Voice: reports each sentence stopping and each text being done."""

    on_played = staticmethod(lambda: None)
    on_done = staticmethod(lambda: None)

    def _start(self, command):
        try:
            player = super()._start(command)
        except Exception:
            self.on_played()
            raise
        return Watched(player, self.on_played)

    def _done(self):
        super()._done()
        self.on_done()


def reporting_ears(ears_class, server: "Server"):
    """listen.Ears (or a stand-in) that tells server when `talking` changes, from its first window."""
    return type("ReportingEars", (Talking, ears_class), {"on_talking": staticmethod(server.on_talking)})


def reporting_voice(voice_class, server: "Server"):
    """speech.Voice (or a stand-in) that tells server when a sentence stops and a text is done."""
    return type("ReportingVoice", (Reporting, voice_class), {"on_played": staticmethod(server.on_played),
                                                            "on_done": staticmethod(server.on_done)})


class LogLines:
    """sys.stdout while serving: each line printed becomes a log event."""

    encoding = "utf-8"

    def __init__(self, emit):
        self._emit = emit
        self._partial = ""
        self._lock = threading.Lock()

    def write(self, text: str) -> int:
        with self._lock:
            lines = (self._partial + text).split("\n")
            self._partial = lines.pop()
        for line in lines:
            self._emit(line)
        return len(text)

    def flush(self):
        pass

    def isatty(self) -> bool:
        return False


class Server:
    """Serves one Ears and one Voice (or none: --no-speak) over JSON lines on out."""

    def __init__(self, out, output_is_speakers=lambda: True):
        self._out = out
        self._lock = threading.Lock()
        self.output_is_speakers = output_is_speakers
        self.ears = None
        self.voice = None
        self.quitting = threading.Event()

    def emit(self, event: str, **fields):
        line = json.dumps({"event": event, **fields}, ensure_ascii=False)
        with self._lock:
            try:
                self._out.write(line + "\n")
                self._out.flush()
            except (OSError, ValueError):
                pass  # the agent has gone; the end of stdin stops us

    # -- VoiceAgent's rules, here where what they ask about is --

    def deaf(self) -> bool:
        """Its own voice is coming out of the speakers and the echo canceller can't take it out."""
        return bool(self.voice and self.voice.audible() and self.ears is not None
                    and not self.ears.hears_the_mac() and self.output_is_speakers())

    def may_speak(self) -> bool:
        return not (self.ears is not None and self.ears.talking)  # not while you're talking

    # -- Ears' and Voice's callbacks --

    def on_text(self, text: str, final: bool):
        if not final:
            self.emit("text", text=text, final=False)
            return
        now = time.monotonic()
        times = getattr(self.ears, "heard_times", None) or {}
        self.emit("text", text=text, final=True, heard_times={k: now - v for k, v in times.items()})

    def on_speech(self):
        self.emit("speech")

    def on_ignored(self, seconds: float, similarity: float):
        voiceprint = getattr(self.ears, "voiceprint", None)
        self.emit("ignored", seconds=float(seconds), similarity=float(similarity),
                  heard_machine=bool(getattr(voiceprint, "heard_machine", False)))

    def on_talking(self, on: bool):
        self.emit("talking", on=on)

    def on_play(self, words: str):
        self.emit("play", words=words)

    def on_played(self):
        self.emit("played")

    def on_done(self):
        self.emit("done")

    # -- serving --

    def attach(self, ears, voice=None):
        self.ears, self.voice = ears, voice
        ears.on_speech = self.on_speech
        ears.on_ignored = self.on_ignored

    def hello(self, echo: float):
        self.emit("hello", pid=os.getpid(), speak=self.voice is not None,
                  voice=getattr(self.voice, "voice", None), echo=echo,
                  voiceprint=getattr(self.ears, "voiceprint", None) is not None,
                  listening=bool(self.ears.listening))

    def status(self) -> dict:
        ears = self.ears
        microphone = getattr(ears, "microphone", None)
        hears_for = 0.0
        if ears.hears_the_mac():
            hears_for = max(0.0, HEARS_THE_MAC - (time.monotonic() - microphone.heard_mac_at))
        return {"listening": bool(ears.listening), "mic_level": float(ears.mic_level),
                "hears_the_mac_for": hears_for,
                "microphone": None if microphone is None else {
                    "name": microphone.name, "error": microphone.error, "tap_error": microphone.tap_error,
                    "canceller_error": microphone.canceller_error, "describe": microphone.describe()}}

    def _report(self):
        while not self.quitting.wait(STATUS_EVERY):
            try:
                self.emit("status", **self.status())
            except Exception as e:  # (a status is never worth stopping for)
                self.emit("error", error=f"status: {e}")

    def describe(self, what: str) -> dict:
        if what == "ears":
            text = self.ears.describe()
            # "ears_error", not "error": a reply with "error" is a failed request, and Parakeet can be
            # up while Silero VAD or the final-text model isn't.
            return {"text": text, "model": self.ears.model is not None, "ears_error": self.ears.error}
        if what == "voice" and self.voice is not None:
            return {"text": self.voice.describe()}
        if what == "voiceprint" and getattr(self.ears, "voiceprint", None) is not None:
            return {"text": self.ears.voiceprint.describe()}
        raise ValueError(f"there's no {what} to describe")

    def learn_its_voice(self) -> bool:
        """VoiceAgent.learn_its_voice: a few sentences rendered (nothing played) teach the voiceprint
        its own voice, so its voice getting past the echo canceller isn't taken for you."""
        voiceprint = getattr(self.ears, "voiceprint", None)
        if self.voice is None or voiceprint is None:
            return False
        if self.voice.kokoro() is None or not voiceprint.ready():
            return False
        import speech
        from voiceprint import SENTENCES
        voiceprint.learn_voice([self.voice.render(t) for t in SENTENCES[:3]], speech.RATE)
        return True

    def answer(self, request_id, work):
        """work() in its own thread (it may wait for a model to load); its dict is the reply."""
        def run():
            try:
                self.emit("reply", id=request_id, **work())
            except Exception as e:
                self.emit("reply", id=request_id, error=str(e) or type(e).__name__)
        threading.Thread(target=run, daemon=True).start()

    def handle(self, message: dict) -> bool:
        """One command; False to stop serving."""
        cmd = message.get("cmd")
        if cmd == "listen":
            self.ears.listen(bool(message.get("on")))
        elif cmd == "cut":
            then = message.get("then")
            self.ears.cut(None if then is None else (lambda: self.emit("then", id=then)))
        elif cmd == "say":
            text = message.get("text")
            if self.voice is not None and isinstance(text, str) and text.strip():
                self.voice.say(text)
            else:
                self.emit("done")
        elif cmd == "stop":
            if self.voice is not None:
                self.voice.stop()
        elif cmd == "describe":
            self.answer(message.get("id"), lambda: self.describe(message.get("what")))
        elif cmd == "learn_its_voice":
            self.answer(message.get("id"), lambda: {"learned": self.learn_its_voice()})
        elif cmd == "quit":
            return False
        else:
            self.emit("error", error=f"no command {cmd!r}")
        return True

    def serve(self, stdin):
        threading.Thread(target=self._report, daemon=True, name="sidecar-status").start()
        while True:
            line = stdin.readline()
            if not line:
                break
            line = line.strip()
            if not line:
                continue
            try:
                message = json.loads(line)
                if not isinstance(message, dict):
                    raise ValueError("not a JSON object")
            except ValueError as e:
                self.emit("error", error=f"couldn't read {line[:200]!r}: {e}")
                continue
            try:
                if not self.handle(message):
                    break
            except Exception as e:
                self.emit("error", error=f"{message.get('cmd')}: {type(e).__name__}: {e}")
        self.quitting.set()
        if self.voice is not None:
            self.voice.stop()  # nothing keeps playing once the agent is gone


def protocol_out():
    """The protocol gets stdout to itself: fd 1 now goes to stderr (a C library writing there can't
    break a line), and print() (the model code's "✗ ..." lines) becomes log events."""
    out = os.fdopen(os.dup(1), "w", encoding="utf-8")
    os.dup2(2, 1)
    return out


def main(argv: list[str]) -> int:
    out = protocol_out()
    server = Server(out)
    sys.stdout = LogLines(lambda line: server.emit("log", line=line))
    import audio
    import listen
    import speech
    from voiceprint import Voiceprint
    server.output_is_speakers = audio.output_is_speakers
    voice = None
    if "--no-speak" not in argv:
        voice = reporting_voice(speech.Voice, server)(may_speak=server.may_speak, on_play=server.on_play)
    server.voice = voice  # (the ears may ask deaf() as soon as they hear anything)
    ears = reporting_ears(listen.Ears, server)(server.on_text, deaf=server.deaf,
                                               voiceprint=None if "--no-voiceprint" in argv else Voiceprint(),
                                               listening="--listening" in argv)
    server.attach(ears, voice)
    server.hello(speech.ECHO)
    server.serve(sys.stdin)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
