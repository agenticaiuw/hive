"""Talk to your Mac, hands-free. It listens all the time and shows the words as you say them
(Parakeet, python/listen.py); when you pause, Codex does what you said with the real mouse and
keyboard in whatever window you're in, talking you through it out loud (Kokoro,
python/speech.py). Touch anything to take over. Listening and speaking run on this Mac.

    .venv/bin/python python/voice_agent.py [--no-speak]

  just talk                a pause of LISTEN_PAUSE seconds (1.2) ends what you're saying
  talk while it's talking  it goes quiet and listens
  say "stop"               cancel the running task
  talk during a task       interrupts it and continues with the new instruction
  touch keys / trackpad    take over; double-tap Right Option to let it continue
  "... on my phone"        does it on your iPhone (python/phone.py, PHONE_RELAY), while a task on
                           the Mac carries on. Any task can use the phone when it needs to.

What it says, and what it's doing, show as captions at the bottom of the screen (CAPTIONS=0 hides
them).

It keeps listening while it talks: whatever the Mac plays (its own voice, a video) is taken back
out of what the microphone hears (python/mic.py), so only you are heard. It waits for you to
finish before it starts saying something. Once you've taught it your voice (./voice.sh --enroll,
python/voiceprint.py), people talking nearby are ignored too.

Needs agent-vhid-helper running with --hands-free (./voice.sh starts everything).
"""

from __future__ import annotations

import json
import os
import queue
import re
import shutil
import signal
import subprocess
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import audio  # noqa: E402
import listen  # noqa: E402
import settings  # noqa: E402
import speech  # noqa: E402
from agent import CodexTask, describe_model, find_codex, focus, warm_up  # noqa: E402
from captions import Captions  # noqa: E402
from phone import Phone, PhoneError  # noqa: E402
from voiceprint import Voiceprint  # noqa: E402
from agent_vhid import AgentVHID, AgentVHIDError, NotAllowed  # noqa: E402

CANCEL = {"stop", "cancel", "never mind", "nevermind", "abort", "stop it", "stop that", "quit"}
FILLERS = {"yeah", "okay", "oh", "uh", "um", "hmm", "mm", "mmhmm", "mm-hmm", "uh-huh", "ah"}  # nothing to do
HUMAN = {"keyboard", "trackpad", "mouse", "mouse_button"}
FOLLOW_UP = 8  # seconds: saying more this soon after a request adds to it rather than replacing it
CANT_HEAR_THE_MAC = ("   It can't hear what the Mac is playing ({}), so it stops listening while it talks, and a video "
                     "playing out loud could be taken for you. Allow the app you run ./voice.sh in under System "
                     "Settings › Privacy & Security › Screen & System Audio Recording, then restart ./voice.sh.")
MIC_SILENT = ("   The microphone only gives silence. Allow microphone access for the app you run ./voice.sh in "
              "(System Settings › Privacy & Security › Microphone), then restart ./voice.sh.")


def notify(message: str, title: str = "Agent"):
    command = ["osascript", "-e", f"display notification {json.dumps(message)} with title {json.dumps(title)}"]
    threading.Thread(target=subprocess.run, args=(command,), daemon=True,
                     kwargs={"stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL}).start()


def spoken(text: str) -> str:
    text = re.sub(r"[`*_#>]|\[([^\]]*)\]\([^)]*\)", lambda m: m.group(1) or "", text)
    return text if len(text) < 600 else text[:600].rsplit(" ", 1)[0] + "..."


class VoiceAgent:
    def __init__(self, speak: bool = True, mac: AgentVHID | None = None, ears: listen.Ears | None = None,
                 captions: Captions | None = None):
        self.captions = captions or Captions(show=False)
        self.voice = speech.Voice(may_speak=self.may_speak, on_play=self.captions.say) if speak else None
        self.mac = mac or AgentVHID()
        self.events: queue.Queue = queue.Queue()
        self.ears = ears or listen.Ears(self.heard, deaf=self.deaf, voiceprint=Voiceprint())
        self.ears.on_text, self.ears.deaf, self.ears.on_speech = self.heard, self.deaf, self.cut_in
        self.ears.on_ignored = self.ignored
        self.tasks: dict[str, CodexTask | None] = {"mac": None, "phone": None}  # one per device, at the same time
        self.doing: dict[str, str] = {}  # device: what its task is doing, for the captions
        self.started = time.time()
        self.warned_about_mic = False
        self.unheard_since = 0.0  # its voice has been playing without the echo canceller hearing it
        self.warned_about_tap = False
        self.over_its_voice = False  # what you're saying started while it was talking
        self.live = sys.stdout.isatty()  # the words you're saying, rewritten in place on one line
        self.live_shown = False  # that line is on the screen now
        self.paused_since = 0.0  # when you took over a running task; 0 when not paused
        self.pause_announced = False
        self.last_said: dict[str | None, str] = {}  # device: the last thing its task said
        self.said: list[tuple[float, str]] = []  # (when, text): what it has said lately
        self.stopped = threading.Event()

    @property
    def task(self) -> CodexTask | None:
        """The task on the Mac."""
        return self.tasks["mac"]

    @task.setter
    def task(self, task: CodexTask | None):
        self.tasks["mac"] = task

    def heard(self, text: str, final: bool):
        """From the listener's thread: what you've said so far, or (final) all of it."""
        self.events.put(("heard", (text, final)))

    def ignored(self, seconds: float, similarity: float):
        """From the listener's thread: someone who isn't you talked (your voiceprint didn't match)."""
        self.events.put(("ignored", (seconds, similarity)))

    def deaf(self) -> bool:
        """Its own voice is coming out of the speakers and the echo canceller can't take it out."""
        return bool(self.voice and self.voice.audible() and not self.ears.hears_the_mac()
                    and audio.output_is_speakers())

    def may_speak(self) -> bool:
        return not self.ears.talking  # it doesn't start a sentence while you're talking

    def cut_in(self):
        """From the listener's thread: you've started talking. If it was talking, it stops."""
        self.over_its_voice = bool(self.voice and self.voice.audible())
        if self.over_its_voice:
            self.voice.stop()
            self.captions.say("")

    def its_own_words(self, words: str) -> bool:
        """What it heard over its voice was mostly what it was saying: echo that got through."""
        def stems(text: str) -> list[str]:  # "typed" and "type" match; numbers are said one way and written another
            return [w[:4] for w in re.sub(r"[^\w' ]", " ", text.lower()).split() if not w.isdigit()]
        mine = set(stems(" ".join(text for when, text in self.said if time.time() - when < 30)))
        heard = stems(words)
        return len(heard) >= 3 and sum(word in mine for word in heard) >= 0.8 * len(heard)

    # -- the main loop --

    def watch_helper(self):
        while not self.stopped.is_set():
            try:
                for event in AgentVHID(self.mac.socket_path).watch():
                    self.events.put(("helper", event))
            except (AgentVHIDError, OSError):
                pass
            time.sleep(2)  # helper restarted or not up yet

    def run(self):
        threading.Thread(target=self.watch_helper, daemon=True).start()
        self.out("Ready. Just say what you want done. Ctrl-C to quit.\n")
        while not self.stopped.is_set():
            self.tick()
            try:
                kind, data = self.events.get(timeout=0.3)
            except queue.Empty:
                continue
            if kind == "helper":
                self.on_helper(data)
            elif kind == "heard":
                self.on_heard(*data)
            elif kind == "task":
                self.on_task_event(*data)
            elif kind == "ignored":
                self.on_ignored(*data)

    def tick(self):
        if not self.warned_about_mic and self.ears.mic_level == 0 and time.time() - self.started > 5:
            self.warned_about_mic = True
            self.out(MIC_SILENT)
        if self.voice and self.voice.audible() and not self.ears.hears_the_mac() and self.ears.microphone:
            self.unheard_since = self.unheard_since or time.time()
            if time.time() - self.unheard_since > 2 and not self.warned_about_tap:
                self.warned_about_tap = True
                microphone = self.ears.microphone
                self.out(CANT_HEAR_THE_MAC.format(microphone.tap_error or microphone.canceller_error
                                                  or "macOS gives it silence"))
        else:
            self.unheard_since = 0.0
        if self.paused_since and not self.pause_announced and \
                time.time() - self.paused_since > 1.0 and self.task and self.task.running:
            self.pause_announced = True
            self.out("⏸  you have control. Double-tap Right Option to let it continue, or say something new.")

    def on_helper(self, event: dict):
        if event.get("state") == "engaged" and self.task and self.task.running:
            if self.pause_announced:
                self.out("▶️  continuing")
            self.paused_since, self.pause_announced = 0.0, False
        elif event.get("state") == "disengaged" and event.get("reason") in HUMAN and not self.paused_since:
            self.paused_since = time.time()

    def out(self, text: str):
        """Prints a line. The words you're saying, if they're showing, make way and come back with
        the next ones."""
        if self.live_shown:
            sys.stdout.write("\r\033[K")
            self.live_shown = False
        print(text, flush=True)

    def show_live(self, text: str):
        if self.live:
            width = shutil.get_terminal_size().columns - 5
            if len(text) > width:
                text = "…" + text[-(width - 1):]
            sys.stdout.write(f"\r\033[K🎙  {text}")
            sys.stdout.flush()
            self.live_shown = True
        else:
            print(f"🎙  {text}", flush=True)

    def on_ignored(self, seconds: float, similarity: float):
        note = f"(not your voice, ignored: {seconds:.1f} s, {similarity:.2f} like yours)"
        if self.live:  # on the line your words show on, so a TV or people chatting don't fill the screen
            sys.stdout.write(f"\r\033[K\033[2m   {note}\033[0m")
            sys.stdout.flush()
            self.live_shown = True
        else:
            self.out(f"   {note}")

    def on_heard(self, text: str, final: bool):
        if not final:
            self.show_live(text)
            return
        if self.live_shown:
            sys.stdout.write("\r\033[K")
            self.live_shown = False
        self.on_transcript(text)

    def on_transcript(self, text: str):
        words = re.sub(r"[^\w' -]", "", text.lower()).strip()
        over_its_voice, self.over_its_voice = self.over_its_voice, False
        if not words or words in FILLERS:
            return  # a cough, a click, an "mm-hmm"
        if over_its_voice and self.its_own_words(words):
            self.out(f"   (heard its own voice: {text})")
            return
        self.out(f"🗣  {text}")

        if self.voice:
            self.voice.stop()  # whatever it was saying is old news
        self.captions.say("")
        if words in CANCEL:
            running = [device for device, task in self.tasks.items() if task and task.running]
            for device in running:
                self.tasks[device].stop()
                self.tasks[device] = None
                self.doing.pop(device, None)
            if running:
                if "mac" in running:
                    self.hand_back()
                self.show_doing()
                self.say("Stopped.")
            return

        device = focus(words)
        previous, task = None, self.tasks[device]
        if task and task.running:  # a new request for the same device replaces the old one
            task.stop()
            if time.time() - task.started_at < FOLLOW_UP:  # you paused, then carried on
                text = f"{task.task} {text}"
                self.out("   (adding that to what you just asked)")
            else:
                previous = task.task
                self.out("   (interrupted the previous task)")
        if device == "mac":
            self.paused_since, self.pause_announced = 0.0, False
        self.last_said[device] = ""
        task = self.tasks[device] = CodexTask(text, previous=previous, device=device)
        task.on_event = lambda kind, t, task=task: self.events.put(("task", (task, kind, t)))
        notify(text, "On it")
        task.start()
        if device == "mac":
            try:
                self.mac.engage_by_voice()  # the helper still waits for your hands to be off
            except NotAllowed:
                self.out("   Double-tap Right Option to hand over the mouse and keyboard.")
            except AgentVHIDError as e:
                self.out(f"   couldn't take control: {e}")

    def on_task_event(self, task: CodexTask, kind: str, text: str):
        device = task.device
        if self.tasks[device] is not task:
            return  # from a task that was interrupted
        mark = "📱 " if device == "phone" else ""
        if kind == "doing":
            self.doing[device] = text
            self.show_doing()
        elif kind == "action":
            self.out(f"   → {mark}{text}")
        elif kind == "error":
            self.out(f"   ✗ {mark}{text}")
        elif kind == "say":  # its final report (and anything it says on the way)
            self.out(f"   💬 {mark}{text}")
            self.say(text, device)
        elif kind in ("done", "failed"):
            self.tasks[device] = None
            self.doing.pop(device, None)
            self.show_doing()
            if kind == "done":
                self.out(f"✅ {mark}done in {task.elapsed:.0f} s\n")
                if device == "mac":
                    self.hand_back()
                notify(text, "Done")
                if text.strip() != self.last_said.get(device):
                    self.say(text, device)
            elif text != "stopped":
                self.out(f"❌ {mark}{text}\n")
                if device == "mac":
                    self.hand_back()
                self.say("Sorry, that didn't work.")

    def show_doing(self):
        """The captions' small line: what each running task is doing ("Thinking", "Typing ...")."""
        self.captions.doing("   ·   ".join(("📱 " if device == "phone" else "") + text
                                           for device, text in self.doing.items() if text))

    def hand_back(self):
        try:
            self.mac.disengage()
            self.mac.release_all()
        except AgentVHIDError:
            pass

    def say(self, text: str, device: str | None = None):
        self.last_said[device] = text.strip()
        if not text:
            return
        if self.voice:
            self.said = [(when, t) for when, t in self.said if time.time() - when < 30] + [(time.time(), text)]
            self.voice.say(spoken(text))  # the captions show each sentence as it's spoken
        else:
            self.captions.say(spoken(text))

    def shutdown(self):
        self.stopped.set()
        for task in self.tasks.values():
            if task and task.running:
                task.stop()
        if self.voice:
            self.voice.stop()
        self.hand_back()
        self.captions.close()


def describe_phone() -> str:
    try:
        return "connected" if Phone().connected() else "not connected (run “Pocket Connect” on it)"
    except PhoneError as e:
        return "off" if not os.environ.get("PHONE_RELAY") else f"unreachable ({e})"


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
    if status.get("hands_free") != "1":
        print("The running agent-vhid-helper wasn't started with --hands-free, so the agent couldn't take control\n"
              "for what you say. Stop it (Ctrl-C in its window) and start everything with ./voice.sh.")
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
    threading.Thread(target=warm_up, daemon=True).start()  # Codex is ready by the time you've said something

    agent = VoiceAgent(speak="--no-speak" not in argv, captions=Captions())
    if not wait_for_helper(agent.mac):
        return 1
    hearing = agent.ears.describe()
    if agent.ears.model is None:
        print(f"Can't listen: {hearing}. Run ./voice.sh to set it up.")
        return 1
    time.sleep(0.5)  # the microphone and the tap are opening
    print(f"Listening all the time: {hearing}, microphone: {agent.ears.mic_name or agent.ears.mic_error or 'opening'}, "
          f"echo cancellation: {agent.ears.microphone.describe()}.\n"
          f"Only listening to you: {agent.ears.voiceprint.describe()}.\n"
          f"Voice: {agent.voice.describe() if agent.voice else 'off'}. Computer agent: {describe_model()}. "
          f"Phone: {describe_phone()}.", flush=True)

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
