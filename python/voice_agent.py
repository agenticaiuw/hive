"""Talk to your Mac. Hold Right Option, say what you want done, let go: Superwhisper
transcribes it and Codex does it with the real mouse and keyboard, in whatever window
you're in. Touch anything to take over.

    python3 python/voice_agent.py [--no-speak]

  hold Right Option        talk (Superwhisper records in its "Computer Agent" mode; nothing is pasted)
  say "stop"               cancel the running task
  talk during a task       interrupts it and continues with the new instruction
  touch keys / trackpad    take over; double-tap Right Option to let it continue

Needs agent-vhid-helper running (./voice.sh starts everything) and Superwhisper.
"""

from __future__ import annotations

import array
import json
import os
import queue
import re
import signal
import subprocess
import sys
import threading
import time
import wave

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import settings  # noqa: E402
from agent import CodexTask, find_codex  # noqa: E402
from agent_vhid import AgentVHID, AgentVHIDError, NotAllowed  # noqa: E402

SUPERWHISPER = os.path.expanduser("~/Documents/superwhisper")
MODE_KEY = "agent"
MODE_NAME = "Computer Agent"
CANCEL = {"stop", "cancel", "never mind", "nevermind", "abort", "stop it", "stop that", "quit"}
# What Whisper models tend to "hear" in silence.
HALLUCINATIONS = {"in english", "thank you", "thanks for watching", "you", "bye", "okay", "so"}
HUMAN = {"keyboard", "trackpad", "mouse", "mouse_button"}


def superwhisper(url: str):
    subprocess.run(["open", "-g", url], check=False)


def active_mode() -> str:
    out = subprocess.run(["defaults", "read", "com.superduper.superwhisper", "activeModeKey"],
                         capture_output=True, text=True).stdout.strip()
    return out or "default"


def ensure_mode():
    """Creates Superwhisper's "Computer Agent" mode: plain transcription, nothing pasted.
    It copies your Default mode's voice model, language and vocabulary settings."""
    modes = os.path.join(SUPERWHISPER, "modes")
    path = os.path.join(modes, f"{MODE_KEY}.json")
    if os.path.exists(path):
        return
    try:
        with open(os.path.join(modes, "default.json")) as f:
            mode = json.load(f)
    except (OSError, ValueError):
        mode = {"language": "en", "voiceModelID": "small", "version": 1}
    mode.update({"key": MODE_KEY, "name": MODE_NAME, "type": "voice", "prompt": "", "autoPaste": False,
                 "scriptEnabled": False, "description": "Speak a task for the computer agent. Nothing is pasted."})
    os.makedirs(modes, exist_ok=True)
    with open(path, "w") as f:
        json.dump(mode, f, indent=2, sort_keys=True)
    print(f"Added the \"{MODE_NAME}\" mode to Superwhisper.")


def is_silent(wav_path: str, peak_threshold: int = 1200) -> bool:
    """True when a recording never gets loud enough to be speech. Whisper "hears" whole sentences
    in silence, so an accidental hold would otherwise turn into a task. Speech on a laptop mic
    peaks in the thousands; a quiet room stays in the hundreds."""
    try:
        with wave.open(wav_path) as w:
            if w.getsampwidth() != 2:
                return False
            samples = array.array("h", w.readframes(w.getnframes()))
    except (OSError, EOFError, wave.Error):
        return False
    return max(map(abs, samples), default=0) < peak_threshold


def notify(message: str, title: str = "Agent"):
    subprocess.Popen(["osascript", "-e", f"display notification {json.dumps(message)} with title {json.dumps(title)}"],
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def spoken(text: str) -> str:
    text = re.sub(r"[`*_#>]|\[([^\]]*)\]\([^)]*\)", lambda m: m.group(1) or "", text)
    return text if len(text) < 400 else text[:400].rsplit(" ", 1)[0] + "..."


class VoiceAgent:
    def __init__(self, speak: bool = True):
        self.speak = speak
        self.mac = AgentVHID()
        self.events: queue.Queue = queue.Queue()
        self.task: CodexTask | None = None
        self.listening = False
        self.previous_mode = "default"
        self.expect_transcript_until = 0.0
        self.paused_since = 0.0  # when you took over a running task; 0 when not paused
        self.pause_announced = False
        self.task_seq = 0

    # -- inputs, each on its own thread, all funneled into self.events --

    def watch_helper(self):
        while True:
            try:
                for event in AgentVHID(self.mac.socket_path).watch():
                    self.events.put(("helper", event))
            except (AgentVHIDError, OSError):
                pass
            time.sleep(2)  # helper restarted or not up yet

    def watch_recordings(self):
        """Superwhisper writes each recording's meta.json twice: when recording starts (with the
        mode it's in and no audio yet) and again once the transcript is ready."""
        folder = os.path.join(SUPERWHISPER, "recordings")
        seen = set(os.listdir(folder)) if os.path.isdir(folder) else set()
        waiting: dict[str, float] = {}
        while True:
            time.sleep(0.2)
            try:
                for name in set(os.listdir(folder)) - seen:
                    seen.add(name)
                    waiting[name] = time.time()
            except OSError:
                continue
            for name, since in list(waiting.items()):
                try:
                    with open(os.path.join(folder, name, "meta.json")) as f:
                        meta = json.load(f)
                except (OSError, ValueError):
                    if time.time() - since > 120:
                        del waiting[name]
                    continue  # not written yet
                if meta.get("modeName") != MODE_NAME:
                    del waiting[name]  # ordinary dictation in another mode
                    continue
                if not meta.get("duration") and time.time() - since < 60:
                    continue  # still recording or transcribing
                del waiting[name]
                silent = is_silent(os.path.join(folder, name, "output.wav"))
                self.events.put(("transcript", "" if silent else (meta.get("result") or "").strip()))

    # -- the main loop --

    def run(self):
        threading.Thread(target=self.watch_helper, daemon=True).start()
        threading.Thread(target=self.watch_recordings, daemon=True).start()
        print("Ready. Hold Right Option and say what you want done. Ctrl-C to quit.\n", flush=True)
        while True:
            self.tick()
            try:
                kind, data = self.events.get(timeout=0.3)
            except queue.Empty:
                continue
            if kind == "helper":
                self.on_helper(data)
            elif kind == "transcript":
                self.on_transcript(data)
            elif kind == "task":
                self.on_task_event(*data)

    def tick(self):
        if self.expect_transcript_until and time.time() > self.expect_transcript_until:
            self.expect_transcript_until = 0.0
            self.restore_mode()
            print("   (no transcript came back from Superwhisper)", flush=True)
        # Announced after a moment, so holding Right Option to talk doesn't print it first.
        if self.paused_since and not self.pause_announced and not self.listening and \
                time.time() - self.paused_since > 1.0 and self.task and self.task.running:
            self.pause_announced = True
            print("⏸  you have control. Double-tap Right Option to let it continue, or hold it to say "
                  "something new.", flush=True)

    def on_helper(self, event: dict):
        if event.get("talk") == "down" and not self.listening:
            self.listening = True
            mode = active_mode()
            self.previous_mode = mode if mode != MODE_KEY else self.previous_mode
            superwhisper(f"superwhisper://mode?key={MODE_KEY}")
            superwhisper("superwhisper://record")
            print("🎙  listening...", flush=True)
        elif event.get("talk") == "up" and self.listening:
            self.listening = False
            superwhisper("superwhisper://record")  # toggles recording off
            self.expect_transcript_until = time.time() + 30
        elif event.get("state") == "engaged" and self.task and self.task.running:
            if self.pause_announced:
                print("▶️  continuing", flush=True)
            self.paused_since, self.pause_announced = 0.0, False
        elif event.get("state") == "disengaged" and event.get("reason") in HUMAN and not self.paused_since:
            self.paused_since = time.time()

    def restore_mode(self):
        superwhisper(f"superwhisper://mode?key={self.previous_mode}")

    def on_transcript(self, text: str):
        self.expect_transcript_until = 0.0
        self.restore_mode()
        words = re.sub(r"[^\w' ]", "", text.lower()).strip()
        if not words or words in HALLUCINATIONS:
            print("   (didn't catch that)", flush=True)
            return
        print(f"🗣  {text}", flush=True)

        if words in CANCEL:
            if self.task and self.task.running:
                self.task.stop()
                self.task = None
                self.hand_back()
                self.say("Stopped.")
            return

        previous = None
        if self.task and self.task.running:
            previous = self.task.task
            self.task.stop()
            print("   (interrupted the previous task)", flush=True)
        self.paused_since, self.pause_announced = 0.0, False
        self.task_seq += 1
        self.task = CodexTask(text, previous=previous,
                              on_event=lambda kind, t, seq=self.task_seq: self.events.put(("task", (seq, kind, t))))
        notify(text, "On it")
        self.task.start()
        try:
            self.mac.engage_after_talk()  # the helper still waits for your hands to be off
        except NotAllowed:
            print("   Double-tap Right Option to hand over the mouse and keyboard.", flush=True)
        except AgentVHIDError as e:
            print(f"   couldn't take control: {e}", flush=True)

    def on_task_event(self, seq: int, kind: str, text: str):
        if seq != self.task_seq:
            return  # from a task that was interrupted
        if kind == "action":
            print(f"   → {text}", flush=True)
        elif kind == "error":
            print(f"   ✗ {text}", flush=True)
        elif kind == "say":
            print(f"   💬 {text}", flush=True)
        elif kind == "done":
            print("✅ done\n", flush=True)
            self.hand_back()
            notify(text, "Done")
            self.say(text)
            self.task = None
        elif kind == "failed":
            if text != "stopped":
                print(f"❌ {text}\n", flush=True)
                self.hand_back()
                self.say("Sorry, that didn't work.")
            self.task = None

    def hand_back(self):
        try:
            self.mac.disengage()
            self.mac.release_all()
        except AgentVHIDError:
            pass

    def say(self, text: str):
        if self.speak and text:
            subprocess.Popen(["say", spoken(text)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    def shutdown(self):
        if self.task and self.task.running:
            self.task.stop()
        self.hand_back()
        if self.listening or self.expect_transcript_until:
            self.restore_mode()


def interrupt(*_):
    raise KeyboardInterrupt


def wait_for_helper(mac: AgentVHID) -> bool:
    """Waits for agent-vhid-helper, which ./voice.sh starts alongside this, and its virtual devices."""
    status: dict = {}
    for attempt in range(60):
        try:
            status = mac.status()
            if status.get("vhid") in ("ready", "dry_run"):
                break
        except AgentVHIDError:
            pass
        time.sleep(0.5)
    if not status:
        print("agent-vhid-helper isn't running. Start everything with ./voice.sh (helper log: /tmp/agent-vhid-helper.log).")
        return False
    if status.get("talk") != "1":
        print("The running agent-vhid-helper is an older build without the talk gesture.\n"
              "Stop it (Ctrl-C in its window) and start everything with ./voice.sh.")
        return False
    if status.get("vhid") not in ("ready", "dry_run"):
        print(f"warning: virtual keyboard/mouse not ready ({status.get('vhid')}); see /tmp/agent-vhid-helper.log",
              flush=True)
    return True


def main(argv: list[str]) -> int:
    if "-h" in argv or "--help" in argv:
        print(__doc__)
        return 0
    settings.load()
    settings.fix_newlines()
    find_codex()
    if not os.path.isdir("/Applications/superwhisper.app"):
        print("Superwhisper isn't installed (https://superwhisper.com).")
        return 1
    if subprocess.run(["pgrep", "-qx", "superwhisper"]).returncode != 0:
        subprocess.run(["open", "-g", "-a", "superwhisper"])
    ensure_mode()

    agent = VoiceAgent(speak="--no-speak" not in argv)
    if not wait_for_helper(agent.mac):
        return 1

    signal.signal(signal.SIGTERM, interrupt)
    signal.signal(signal.SIGINT, interrupt)  # a script may start us with Ctrl-C ignored
    try:
        agent.run()
    except KeyboardInterrupt:
        pass
    finally:
        agent.shutdown()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
