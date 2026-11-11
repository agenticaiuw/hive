"""Talk to your Mac. Tap fn and it listens, showing the words as you say them (Parakeet,
python/listen.py); when you pause, Codex does what you said with the real mouse and keyboard in
whatever window you're in, talking you through it out loud (Kokoro, python/speech.py). Tap fn
again and it stops listening; a task it's doing carries on. Hold fn instead and what you say is
typed into the app in front when you let go: dictation. Listening and speaking run on this Mac.

    .venv/bin/python python/voice_agent.py [--no-speak] [--app]

  tap fn                   it listens (the microphone opens), continuing the conversation. Tap
                           again: it stops, and does what you just said without waiting for you
                           to pause
  hold fn and talk         dictation: let go and your words are typed where you're typing (pasted,
                           with the clipboard put back), not given to the agent
  just talk                a pause of LISTEN_PAUSE seconds (0.8) ends what you're saying
  talk while it's talking  it goes quiet and listens
  say "stop"               cancel the running task
  talk during a task       interrupts it and continues with the new instruction
  touch keys / trackpad    take over; say "continue" to let it carry on
  "... on my phone"        does it on your iPhone (python/phone.py, PHONE_RELAY), while a task on
                           the Mac carries on. Any task can use the phone when it needs to.

As you start talking it takes the Mac's screenshot (agent.LookAhead), so the request goes to Codex
with it the moment you finish. After each request the log says where the time went, from when you
stopped talking to when it started answering ("⏱ ...").

What it says, and what it's doing, show as captions at the bottom of the screen (CAPTIONS=0 hides
them); while it listens, so do your words.

It keeps listening while it talks: whatever the Mac plays (its own voice, a video) is taken back
out of what the microphone hears (python/mic.py), so only you are heard. It waits for you to
finish before it starts saying something. Once you've taught it your voice (./voice.sh --enroll,
python/voiceprint.py), people talking nearby are ignored too.

Needs agent-vhid-helper running: ./install.sh has the Mac start it, ./voice.sh starts it otherwise.
--app is how Agent.app (tools/app.swift) runs it at login: "toggle" lines on stdin turn listening on
and off like fn, and "@@ listening 1|0", "@@ dictating 1|0" and "@@ status TEXT" lines on stdout are
for its menu bar.
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
PASTE = os.path.join(os.path.dirname(HERE), "build", "agent-vhid-paste")

import audio  # noqa: E402
import listen  # noqa: E402
import settings  # noqa: E402
import speech  # noqa: E402
from agent import CodexTask, LookAhead, describe_model, find_codex, focus, new_session, warm_up  # noqa: E402
from captions import Captions  # noqa: E402
from resumable_thread import state_dir  # noqa: E402
import ingest  # noqa: E402
import lipread  # noqa: E402
import session_journal  # noqa: E402
from phone import Phone, PhoneError  # noqa: E402
from voiceprint import SENTENCES, Voiceprint  # noqa: E402
from agent_vhid import AgentVHID, AgentVHIDError  # noqa: E402

CANCEL = {"stop", "cancel", "never mind", "nevermind", "abort", "stop it", "stop that", "quit"}
CONTINUE = {"continue", "go on", "keep going", "resume", "carry on", "go ahead", "you can continue"}
JUST_SPOKE = 3.0  # seconds after its voice stops that what's heard may still be its echo
FILLERS = {"yeah", "okay", "oh", "uh", "um", "hmm", "mm", "mmhmm", "mm-hmm", "uh-huh", "ah"}  # nothing to do
HUMAN = {"keyboard", "trackpad", "mouse", "mouse_button"}


def took_over(reason) -> bool:
    """You took the mouse and keyboard: by touching them while the agent had control, or just as it
    was taking control ("engage_cancelled_by_trackpad"). Either way fn hands control back."""
    return reason in HUMAN or str(reason or "").startswith("engage_cancelled")


def workspace_voice_allowed():
    """Only speak over the user's speakers while the workspace viewer is visible."""
    if not os.environ.get("AGENT_SPACEO_COMMAND"):
        return True
    try:
        return (state_dir() / "workspace-viewer-visible").read_text().strip() == "1"
    except OSError:
        return False


def startup_recovery_record():
    import task_recovery
    import provider_wait
    saved = task_recovery.current()
    provider_state = provider_wait.status(saved.get('id')) if saved else None
    if saved and saved.get('status') == 'active' and provider_state == 'waiting':
        return saved  # The process owner lock serializes harmless waiting across restarts.
    if provider_state == 'resolved':
        return None  # Dispatch may have happened before a crash; do not repeat it.
    return task_recovery.reserve('startup')


FOLLOW_UP = 8  # seconds: saying more this soon after a request adds to it rather than replacing it
CANT_HEAR_THE_MAC = ("   It can't hear what the Mac is playing ({}), so it stops listening while it talks, and a video "
                     "playing out loud could be taken for you. Allow {} under System Settings › Privacy & Security › "
                     "Screen & System Audio Recording, then restart it.")
MIC_SILENT = ("   The microphone only gives silence. Allow microphone access for {} (System Settings › Privacy & "
              "Security › Microphone), then restart it.")


def shortened(text: str, limit: int) -> str:
    """One line of at most `limit` characters, for the floating window."""
    line = " ".join(text.split())
    return line if len(line) <= limit else line[:limit].rstrip() + "…"


def notify(message: str, title: str = "Agent"):
    command = ["osascript", "-e", f"display notification {json.dumps(message)} with title {json.dumps(title)}"]
    threading.Thread(target=subprocess.run, args=(command,), daemon=True,
                     kwargs={"stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL}).start()


def paste(text: str) -> str | None:
    """Types text into the app in front: build/agent-vhid-paste pastes it, then puts back what was
    on the clipboard. None if it did; otherwise why not, and the text is left on the clipboard."""
    try:
        result = subprocess.run([PASTE], input=text, text=True, capture_output=True, timeout=10)
    except (OSError, subprocess.TimeoutExpired) as e:
        subprocess.run(["pbcopy"], input=text, text=True)
        return str(e)
    if result.returncode:
        return result.stderr.strip() or f"exit {result.returncode}"
    return None


class Dictation:
    """What you say while you hold fn, typed into the app in front when you let go."""

    def __init__(self):
        self.since = time.time()
        self.words: list[str] = []  # each thing you said, between pauses
        self.dropped = False  # it was a tap of fn, or fn+key, after all
        self.shown = False  # held long enough that the captions say it's dictating

    def text(self, partial: str = "") -> str:
        return " ".join(self.words + [partial]).strip()


def spoken(text: str) -> str:
    text = re.sub(r"[`*_#>]|\[([^\]]*)\]\([^)]*\)", lambda m: m.group(1) or "", text)
    return text if len(text) < 600 else text[:600].rsplit(" ", 1)[0] + "..."


class VoiceAgent:
    def __init__(self, speak: bool = True, mac: AgentVHID | None = None, ears: listen.Ears | None = None,
                 captions: Captions | None = None, app: bool = False):
        self.app = app  # run by Agent.app: no terminal, and "@@" lines for its menu bar
        self.who = "Agent" if app else "the app you run ./voice.sh in"  # what macOS asks permission for
        self.captions = captions or Captions(show=False)
        self.voice = speech.Voice(may_speak=self.may_speak, on_play=self.on_play) if speak else None
        self.mac = mac or AgentVHID()
        self.events: queue.Queue = queue.Queue()
        if hasattr(self.captions, 'on_input'):
            self.captions.on_input = lambda text: self.events.put(('typed_request', text))
        if hasattr(self.captions, 'on_control'):
            self.captions.on_control = lambda kind, value=None: self.events.put(('overlay', (kind, value)))
        self.ears = ears or listen.Ears(self.heard, deaf=self.deaf, voiceprint=Voiceprint(), listening=False)
        self.ears.on_text, self.ears.deaf, self.ears.on_speech = self.heard, self.deaf, self.cut_in
        self.ears.on_ignored = self.ignored
        if self.voice and self.ears.voiceprint is not None:
            threading.Thread(target=self.learn_its_voice, daemon=True, name="learn-voice").start()
        # Muted (the window's mic button): the microphone stays off however fn is used, and the agent
        # and the window keep going.
        self.muted = False
        _listen = self.ears.listen
        self.ears.listen = lambda on: _listen(bool(on) and not self.muted)
        # Every task is recorded: the screen as a video, with a timeline of Hive's status and the Mac's
        # state at exact times, uploaded to Cloudflare R2 afterwards (task_recording, cloud_archive).
        import task_recording
        import cloud_archive
        from agent_vhid import cursor_position as _cursor

        def _recording_title():
            running = [t for t in self.tasks.values() if t is not None]
            return getattr(running[0], "task", "") if running else ""

        def _engaged():
            mac = getattr(self, "mac", None)
            return bool(mac and mac.is_engaged())

        self.recorder = task_recording.Recorder(
            running=lambda: any(t is not None for t in self.tasks.values()),
            engaged=_engaged, title=_recording_title, cursor=_cursor,
            on_finished=lambda folder: cloud_archive.archive_in_background(
                report=lambda line: self.out(f"   🎞  {line}")))
        cloud_archive.archive_in_background(report=lambda line: self.out(f"   🎞  {line}"))
        # The knowledge base in the cloud: upload saves made while offline, refresh the Mac's copy.
        import knowledge
        knowledge.sync_in_background(report=lambda line: self.out(f"   📚  {line}"))
        self.ears.listen(False)  # until you tap fn
        self.listening = False  # for the agent: you tapped fn
        self._discard_heard = False
        self._heard_barrier = 0
        self.listening_since = 0.0  # when you last tapped fn to talk; 0 while it isn't listening
        self.held: Dictation | None = None  # fn is down: it may be a tap, or the start of dictation
        self.dictation: Dictation | None = None  # where what's heard goes now, instead of the agent
        self.paste = paste
        self.tasks: dict[str, CodexTask | None] = {"mac": None, "phone": None}  # one per device, at the same time
        self.doing: dict[str, str] = {}  # device: what its task is doing, for the captions
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
        self.ahead: LookAhead | None = None  # the Mac's look, taken as you started saying this
        self.timing: dict | None = None  # the latest request's times, until its first words are heard
        self.stopped = threading.Event()
        self.journal: session_journal.SessionJournal | None = None  # this session, saved (run starts it)
        self.journal_warned = False
        self.input_mode = "voice"  # or "lips": tap fn and it reads your lips (python/lipread.py); run() loads it
        self.lips: lipread.LipReader | None = None

    @property
    def task(self) -> CodexTask | None:
        """The task on the Mac."""
        return self.tasks["mac"]

    @task.setter
    def task(self, task: CodexTask | None):
        self.tasks["mac"] = task

    def heard(self, text: str, final: bool):
        """From the listener's thread: what you've said so far, or (final) all of it."""
        self.events.put(("heard", (text, final, getattr(self.ears, "heard_times", None) if final else None)))

    def ignored(self, seconds: float, similarity: float):
        """From the listener's thread: someone who isn't you talked (your voiceprint didn't match)."""
        self.events.put(("ignored", (seconds, similarity)))

    def learn_its_voice(self):
        """Teaches the voiceprint its own voice (a few sentences rendered, nothing played), so its
        voice getting past the echo canceller isn't taken for you."""
        try:
            voiceprint = self.ears.voiceprint
            if self.voice.kokoro() is None or not voiceprint.ready():
                return
            voiceprint.learn_voice([self.voice.render(t) for t in SENTENCES[:3]], speech.RATE)
        except Exception as e:
            self.out(f"   (couldn't learn its own voice, so it may hear itself: {e})")

    def deaf(self) -> bool:
        """Its own voice is coming out of the speakers and the echo canceller can't take it out."""
        return bool(self.voice and self.voice.audible() and not self.ears.hears_the_mac()
                    and audio.output_is_speakers())

    def may_speak(self) -> bool:
        return not self.ears.talking  # it doesn't start a sentence while you're talking

    def cut_in(self):
        """From the listener's thread: you've started talking. If it was talking, it stops. Unless
        a task is working on the Mac (changing what's on it), it looks at the Mac now, for what
        you're asking."""
        self.over_its_voice = bool(self.voice and self.voice.audible())
        if self.over_its_voice:
            self.voice.stop()
            self.captions.say("")
        looking = self.listening and not self.held and not self.dictation and not (self.task and self.task.running)
        self.ahead = LookAhead() if looking else None

    def on_play(self, words: str):
        """From the voice's thread: words start playing."""
        self.captions.say(words)
        timing = self.timing
        if timing and timing.get("queued") and "answered" not in timing:
            timing["answered"], timing["spoken"] = time.monotonic(), True
            self.events.put(("timing", timing))

    def its_own_words(self, words: str) -> bool:
        """What it heard over its voice, or just after, was mostly what it was saying: echo that
        got through (Parakeet mishears some of it, so 70% of the words will do)."""
        def stems(text: str) -> list[str]:  # "typed" and "type" match; numbers are said one way and written another
            return [w[:4] for w in re.sub(r"[^\w' ]", " ", text.lower()).split() if not w.isdigit()]
        mine = set(stems(" ".join(text for when, text in self.said if time.time() - when < 30)))
        heard = stems(words)
        return len(heard) >= 3 and sum(word in mine for word in heard) >= 0.7 * len(heard)

    # -- the main loop --

    def watch_helper(self):
        while not self.stopped.is_set():
            try:
                for event in AgentVHID(self.mac.socket_path).watch():
                    self.events.put(("helper", event))
            except (AgentVHIDError, OSError):
                pass
            time.sleep(2)  # helper restarted or not up yet

    def log(self, kind: str, text: str = "", **fields):
        """Saves it in the session journal (python/session_journal.py)."""
        journal = getattr(self, "journal", None)  # (tests may build it without __init__)
        if journal is None:
            return
        journal.add(kind, text, **fields)
        if journal.error and not getattr(self, "journal_warned", False):
            self.journal_warned = True
            self.out(f"   ✗ the session journal couldn't be saved: {journal.error}")

    def start_journal(self):
        try:
            self.journal = session_journal.SessionJournal({
                "backend": describe_model(), "voice": getattr(self.voice, "voice", None),
                "app": self.app})
            session_journal.current = self.journal
        except Exception as e:
            self.out(f"   ✗ the session journal couldn't be started: {e}")

    def announce_audio(self):
        """Wait for speech initialization away from the request and workspace loop."""
        hearing = self.ears.describe()
        if self.ears.model is None:
            self.out(f"Voice input unavailable: {hearing}. Typed requests remain available.")
            self.tell('status', "Voice input unavailable; typed requests are ready")
            return
        self.out(f"Hears you with: {hearing}, microphone: {audio.name(audio.microphone()) or 'none'}, "
                 f"echo cancellation: {self.ears.microphone.describe()}.\n"
                 f"Only listening to you: {self.ears.voiceprint.describe()}.")
        self.tell('status', 'Ready')

    def run(self):
        self.start_journal()
        self.embedded_workspace = None
        if self.app and os.environ.get("AGENT_SPACEO_COMMAND"):
            threading.Thread(target=self.start_embedded_workspace, daemon=True,
                             name="personal-agent-workspace").start()
        elif self.app:
            threading.Thread(target=self.start_virtual_monitor, daemon=True, name="virtual-monitor").start()
        self.local_requests = None
        if self.app:
            try:
                from local_request import LocalRequests
                self.local_requests = LocalRequests(state_dir() / "control", self.events)
                self.local_requests.start()
            except (OSError, RuntimeError) as error:
                self.local_requests = None
                self.out(f"Local request channel unavailable: {error}")
        threading.Thread(target=self.watch_helper, daemon=True).start()
        self.out("Ready. Tap fn and say what you want done; tap fn again to turn the mic off."
                 + ("" if self.app else " Ctrl-C to quit.") + "\n")
        self.tell("listening", "0")
        self.tell("status", "Typed requests ready; voice input is loading")
        threading.Thread(target=self.announce_audio, daemon=True, name='personal-agent-audio-ready').start()
        context = state_dir() / "context/index.html"
        if context.exists():
            self.tell("context", str(context))
        if self.journal:
            self.journal.touch()
            self.tell("panel", str(self.journal.panel_path))  # the Agent Context panel reads it
        if lipread.get_mode() == "lips":
            self.set_input("lips", announce=False)
        else:
            self.tell("input", "voice")
        if not self.app:
            self.out(f"Agent context: {context}")
            if self.journal:
                self.out(f"This session is saved in {self.journal.dir}")
        resume = state_dir() / "updates" / "update-resume"
        if not resume.exists():
            resume = state_dir() / "update-resume"  # finish a handoff from an older version
        if self.app and resume.exists():
            try:
                import task_recovery
                saved = task_recovery.current()
                resume.replace(resume.with_name("update-resumed"))
                if not saved or saved.get('status') == 'active':
                    self.events.put(("typed_request", "The agent update has been installed and restarted. "
                                 "This maintenance restart was not a user request to stop; continue the prior "
                                 "authorized request in this same conversation, unless the user separately "
                                 "stopped or paused it. Work on other independent tasks if one is blocked. Verify the new "
                                 "version and any uncertain effects before acting; do not schedule the "
                                 "same update again or repeat actions that may already have happened."))
            except (OSError, ValueError) as error:
                self.out(f"Could not resume after the update: {error}")
        elif self.app and os.environ.get('AGENT_BACKEND', 'codex') == 'codex':
            # A durable reservation is committed before connecting. A crash during
            # the continuation therefore never causes an automatic replay loop.
            try:
                import task_recovery
                owner = task_recovery.acquire_owner()
                record = None
                if owner:
                    record = startup_recovery_record()
                if record:
                    task = CodexTask('Continue the previously authorized work', device=record['device'])
                    task._startup_record = record
                    task._recovery_id = record['id']
                    task._receipt_id = record.get('receiptId')
                    task._recovery_owner = owner
                    task.on_event = lambda kind, text, task=task: self.events.put(('task', (task, kind, text)))
                    self.tasks[record['device']] = task
                    task.start(look=False)
                    self.out('Restoring the saved conversation and checking unfinished work.')
                elif owner:
                    owner.close()
            except (OSError, ValueError) as error:
                self.out(f'Could not restore unfinished work: {error}')
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
            elif kind == "heard_barrier":
                if data == self._heard_barrier:
                    self._discard_heard = False
            elif kind == "timing":
                self.out(describe_timing(data))
            elif kind == "task":
                self.on_task_event(*data)
            elif kind == "workspace_activity":
                task = self.tasks.get("mac")
                if task is not None:
                    self.on_task_event(task, *data)
            elif kind == "ignored":
                self.on_ignored(*data)
            elif kind == "toggle":
                self.set_listening(not self.listening)
            elif kind == "overlay":
                self.on_overlay(*data)
            elif kind == "typed_request":
                self.captions.hearing(data)
                self.on_transcript(data, typed=True)
            elif kind == "local_request":
                self.on_local_request(*data)
            elif kind == "ingest":
                self.start_ingest(data)
            elif kind == "input":
                self.set_input(data)
            elif kind == "lips":
                self.on_lips(*data)
            elif kind == "camera":
                self.on_camera(data)
            elif kind == "route":  # what's heard from now on goes to this dictation, or (None) the agent
                self.dictation = data
            elif kind == "dictated":
                self.dictation = None
                self.type_dictation(data)

    def start_embedded_workspace(self):
        from spaceo_mcp_bridge import Bridge
        workspace = None
        try:
            # A host-health latch left by an earlier sample would refuse the display below.
            import workspace_recovery
            outcome, detail = workspace_recovery.recover_if_latched(os.environ["AGENT_SPACEO_COMMAND"])
            if outcome != "not-latched":
                self.out(f"Virtual workspace safety latch {outcome}: {detail}")
        except Exception as error:
            self.out(f"Virtual workspace safety latch check failed: {error}")
        try:
            workspace = Bridge(os.environ["AGENT_SPACEO_COMMAND"],
                               on_activity=lambda kind, text: self.events.put(("workspace_activity", (kind, text))))
            workspace.start_embedded()
            if self.stopped.is_set():
                workspace.close()
            else:
                self.embedded_workspace = workspace
        except Exception as error:
            if workspace:
                workspace.close()
            Bridge.status("error", "Could not start the virtual workspace: " + str(error))
            self.out(f"Virtual workspace unavailable: {error}")

    def on_local_request(self, text, reply, deadline, resume_goal=False, goal_objective=None, receipt_id=None):
        if time.monotonic() >= deadline:
            reply.put({"ok": False, "error": "The request expired before it could start."})
            return
        if any(task and task.running for task in self.tasks.values()):
            reply.put({"ok": False, "error": "The personal-agent is already working."})
            return
        try:
            if resume_goal:
                import agent
                server = agent.running_server()
                if server is None:
                    raise RuntimeError("Codex server is not ready; goal was not resumed.")
                thread_id = (state_dir() / "codex-thread-id").read_text().strip()
                goal_params = {"threadId": thread_id, "status": "active", "origin": "user"}
                if goal_objective:
                    goal_params["objective"] = goal_objective
                result = server.request("thread/goal/set", goal_params, timeout=3)
                if (result.get("goal") or {}).get("status") != "active":
                    raise RuntimeError("Codex did not confirm the goal is active.")
            # Another program sent this, not you: one short line, never a screenful of its words.
            if hasattr(self.captions, "agent_request"):
                self.captions.agent_request(shortened(text, 160))
            else:
                self.captions.hearing("From another agent: " + shortened(text, 120))
            self.on_transcript(text, typed=True, captured=True, ingress_receipt=receipt_id)
            reply.put({"ok": True})
        except Exception as error:
            reply.put({"ok": False, "error": str(error)})

    def start_ingest(self, path: str):
        """Agent menu → Add … to Context: the app wrote the text you chose to path (and asked you
        first). It goes into the conversation in the background (python/ingest.py)."""
        try:
            with open(path, encoding="utf-8", errors="replace") as f:
                title, _, text = f.read().partition("\n")  # the app's first line is the title
            os.remove(path)
            ing = ingest.prepare(text, title.strip(), source="Agent menu")
        except (OSError, ValueError) as e:
            self.log("ingest done", f"not added: {e}", status="failed")
            self.out(f"   ✗ couldn't add that text: {e}")
            self.tell("status", f"Couldn't add the text: {e}")
            return
        self.out(f"   📥 adding “{ing.title}” ({ing.chars:,} characters, {len(ing.parts)} parts) to the conversation")
        self.tell("status", f"Adding “{ing.title[:40]}” to the conversation…")
        threading.Thread(target=self.ingest, args=(ing,), daemon=True).start()

    def ingest(self, ing: "ingest.Ingestion"):
        def run_turn(prompt: str):
            deadline = time.time() + 300  # wait for a request on the Mac to finish: one turn at a time
            while any(t and t.running for t in self.tasks.values()) and time.time() < deadline:
                time.sleep(0.5)
            task = CodexTask(f"(adding “{ing.title}” to the conversation)", device="mac")
            # Document chunks are data, not an independently resumable user task.
            task._durable_recovery = False
            task.prompt = prompt
            task.on_event = lambda kind, text: kind == "context" and self.tell("context", text)
            task.start(look=False)
            if not task._done.wait(240):
                task.stop()
                return getattr(task, "_thread", None), task.on_thread, None, "no reply from Codex in 4 minutes"
            error = None if not task._ended and task.final else (task._ended or "no reply")
            return getattr(task, "_thread", None), task.on_thread, task.final, error
        try:
            outcome = ingest.send(ing, run_turn, session_journal.rollout_for, self.log)
        except Exception as e:
            self.log("ingest done", f"{ing.title}: failed: {e}", id=ing.id, status="failed")
            outcome = {"status": "failed"}
        words = {"verified": "Added to the conversation (verified)", "sent": "Sent, but not verified",
                 "failed": "Couldn't add it"}[outcome["status"]]
        self.out(f"   📥 “{ing.title}”: {words.lower()}")
        self.tell("status", f"{words}: “{ing.title[:40]}”")

    def set_input(self, mode: str, announce: bool = True):
        """Agent menu → Input: Voice (the microphone) or Lip Reading (the camera, while fn is tapped on)."""
        if mode == "lips":
            ok, why = lipread.available()
            if not ok:
                self.out(f"   ✗ lip reading isn't available: {why}")
                self.tell("status", "Lip reading isn't set up: see the log")
                mode = "voice"
        if self.listening:
            self.set_listening(False)
        if mode != "lips" and self.lips:
            self.lips.close()
            self.lips = None
        self.input_mode = mode
        self._lips_generation = getattr(self, "_lips_generation", 0) + 1
        try:
            lipread.set_mode(mode)
        except OSError:
            pass
        self.tell("input", mode)
        if mode == "lips" and self.app and self.lips is None:
            self.lips = lipread.LipReader(on_event=lambda event: self.events.put(("camera", event)))
            self.lips.open()  # warm the model without opening the camera
        if announce:
            self.log("input", mode)
            self.out("   input: " + ("lip reading (tap fn, mouth it, tap fn)" if mode == "lips" else "voice"))

    def set_lips(self, on: bool):
        """Lip reading mode's tap of fn: the camera on, or off and what it read becomes a request.
        The caption and menu bar icon follow the camera itself (on_camera), not the tap: they say
        "on" only once it is recording."""
        self.listening = on
        self.ears.listen(self.held is not None)  # the microphone is only for dictation (holding fn)
        self.tell("listening", "1" if on else "0")
        if on:
            new_session()
            self._lips_generation = getattr(self, "_lips_generation", 0) + 1
            self.captions.hearing("")
            self.captions.say("")
            self.captions.camera("starting")
            try:
                if self.lips is None:
                    self.lips = lipread.LipReader(on_event=lambda event: self.events.put(("camera", event)))
                self.lips.start()
            except lipread.LipReaderError as e:
                self.listening = False
                self.captions.camera("off")
                self.tell("listening", "0")
                self.captions.say(str(e))
                self.out(f"   ✗ lip reading: {e}")
                return
            self.log("lip reading", "camera requested")
            self.out("📷 turning the camera on: mouth what you want, then tap fn")
            return
        if hasattr(self.captions, "dismiss"):
            self.captions.dismiss()
        self._stop_tasks_for_fn()
        self._lips_generation = getattr(self, "_lips_generation", 0) + 1
        self.captions.camera("off")
        self.tell("camera", "0")
        self.log("lip reading", "stopped")
        self.out("   (stopped lip reading)")
        lips = self.lips
        def read():
            try:
                if lips:
                    lips.stop()
            except lipread.LipReaderError:
                pass
        threading.Thread(target=read, daemon=True).start()

    def on_camera(self, event: dict):
        """What the lip reading worker says about the camera."""
        if event.get("session") is not None and event["session"] != getattr(self.lips, "session", None):
            return
        if "framing" in event and self.listening and self.input_mode == "lips":
            if hasattr(self.captions, "framing"):
                self.captions.framing(event["framing"])
        if "preview" in event and self.listening and self.input_mode == "lips":
            if hasattr(self.captions, "preview"):
                self.captions.preview(event["preview"])
        if "partial" in event:
            if self.listening and self.input_mode == "lips":
                self.captions.doing("")
                self.captions.hearing(event["partial"])
            return
        if "status" in event and self.listening and self.input_mode == "lips":
            self.captions.doing(event["status"])
        if event.get("ready"):
            self.log("lip reading", "model ready", model=event.get("model"), device=event.get("device"))
        state = event.get("camera")
        if state is None:
            if event.get("error"):
                self.out(f"   ✗ lip reading: {event['error']}")
                if self.input_mode == "lips":
                    self.captions.doing("")
                    self.captions.say(f"Lip reading failed: {event['error']}")
                    if event.get("final"):
                        self.captions.camera("off")
                        self.listening = False
                        self.tell("listening", "0")
            return
        on = state == "on"
        self.tell("camera", "1" if on else "0")
        if state == "failed":
            self.captions.camera("off")
            self.captions.say("Camera couldn't open: allow Agent in Privacy & Security › Camera")
            self.log("lip reading", event.get("error", "camera failed"), outcome="failed")
            self.out(f"   ✗ lip reading: {event.get('error')}")
            if self.listening and self.input_mode == "lips":
                self.listening = False
                self.tell("listening", "0")
            return
        if self.listening and self.input_mode == "lips":
            self.captions.camera(state)  # "waiting", "on"
        if on:
            self.log("lip reading", "camera on")
            self.out("🟢 📷 camera on")
        elif state == "off":
            self.log("lip reading", "camera off")

    def on_lips(self, text: str, error: str | None, generation=None):
        if generation is not None and generation != getattr(self, "_lips_generation", 0):
            return
        self.captions.doing("")
        if error or not text:
            self.captions.hearing("")
            self.captions.say(f"Lip reading failed: {error}" if error else
                              "Couldn't read your lips. Face the camera and try again.")
            self.log("lip reading", error or "nothing read", outcome="failed" if error else "empty")
            self.out(f"   ✗ lip reading: {error}" if error else "   (couldn't read anything)")
            return
        self.log("lip reading", text, outcome="read")
        self.captions.hearing(text)
        self.on_transcript(text)

    def set_listening(self, on: bool):
        """Toggle listening without replacing the durable Codex conversation."""
        if on == self.listening:
            return
        if getattr(self, "input_mode", "voice") == "lips":  # (tests may build it without __init__)
            return self.set_lips(on)
        self.listening = on
        if on:
            new_session()
            if os.environ.get("AGENT_SPACEO_COMMAND"):
                self.tell("workspace-resume", "1")
        else:
            if hasattr(self.captions, "dismiss"):
                self.captions.dismiss()
            if self.voice:
                self.voice.stop()  # quiet now; the agent keeps working until the window's x
            self._discard_heard = True
            self._heard_barrier += 1
        self.ears.listen(on or self.held is not None)
        if not on:
            barrier = self._heard_barrier
            self.ears.cut(then=lambda: self.events.put(("heard_barrier", barrier)))
        self.listening_since = time.time() if on else 0.0
        self.captions.listening(on)
        self.tell("listening", "1" if on else "0")
        self.log("listening" if on else "stopped listening")
        self.out("🎙  listening (tap fn to turn the mic off)" if on else "   (mic off; tap fn to talk)")

    def _stop_tasks_for_fn(self):
        """A close tap stops both devices and silences any ongoing spoken response."""
        stopped = []
        for device, task in self.tasks.items():
            if task and task.running:
                task.stop()
                stopped.append(device)
            self.tasks[device] = None
        self.hand_back()
        if self.voice:
            self.voice.stop()
        engine = os.environ.get("AGENT_SPACEO_COMMAND")
        if engine and "mac" in stopped:
            try:
                result = subprocess.run([engine, "session", "pause", "--session", "personal-agent-workspace",
                                         "--operator", "--reason", "Stopped by fn"],
                                        stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, timeout=3)
                if result.returncode:
                    self.out("   ✗ Could not confirm the workspace input was paused.")
            except (OSError, subprocess.TimeoutExpired):
                self.out("   ✗ Could not confirm the workspace input was paused.")
        self.doing.clear()
        self.timing = None
        if hasattr(self.captions, "active"):
            self.captions.active(False)
        self.show_doing()
        if stopped:
            self.log("stopped by fn", stopped=stopped)

    def tell(self, what: str, text: str):
        """A line for Agent.app's menu bar."""
        if self.app:
            print(f"@@ {what} {text}", flush=True)

    def tick(self):
        audible_here = workspace_voice_allowed()
        if not audible_here and getattr(self, "_viewer_voice_allowed", True) and self.voice:
            self.voice.stop()
        self._viewer_voice_allowed = audible_here
        if os.environ.get("AGENT_SPACEO_COMMAND") and time.monotonic() >= getattr(self, "_workspace_status_at", 0):
            self._workspace_status_at = time.monotonic() + 2
            try:
                status = json.loads((state_dir() / "workspace-status.json").read_text())
                state = (status.get("state"), status.get("message"))
                if state != getattr(self, "_workspace_last_status", None):
                    self._workspace_last_status = state
                    if state[0] == "error":
                        self.tell("status", "Workspace unavailable: " + str(state[1])[:150])
                        self.out("   ✗ Workspace unavailable: " + str(state[1])[:300])
            except (OSError, ValueError, TypeError):
                pass
        if self.held and not self.held.shown and time.time() - self.held.since > 0.4:
            self.show_dictating(self.held, True)  # held longer than a tap
        if not self.warned_about_mic and self.ears.mic_level == 0 and self.listening_since \
                and time.time() - self.listening_since > 5:
            self.warned_about_mic = True
            self.out(MIC_SILENT.format(self.who))
        if self.ears.listening and self.voice and self.voice.audible() and not self.ears.hears_the_mac() \
                and self.ears.microphone:
            self.unheard_since = self.unheard_since or time.time()
            if time.time() - self.unheard_since > 2 and not self.warned_about_tap:
                self.warned_about_tap = True
                microphone = self.ears.microphone
                self.out(CANT_HEAR_THE_MAC.format(microphone.tap_error or microphone.canceller_error
                                                  or "macOS gives it silence", self.who))
        else:
            self.unheard_since = 0.0
        if self.paused_since and not self.pause_announced and \
                time.time() - self.paused_since > 1.0 and self.task and self.task.running:
            self.pause_announced = True
            self.out("⏸  you have control. Press fn to let it carry on (or say something new).")

    def on_overlay(self, kind: str, value=None):
        """The floating window's buttons: the x stops the agent; the mic mutes what it hears."""
        if kind == "close":
            self.out("✋ stopped from the window's x")
            self._stop_tasks_for_fn()
            if hasattr(self.captions, "paused"):
                self.captions.paused("")
                self.captions.agent_request("")
            self.paused_since, self.pause_announced = 0.0, False
        elif kind == "mute":
            self.muted = bool(value)
            self.ears.listen(self.listening or self.held is not None)
            if hasattr(self.captions, "muted"):
                self.captions.muted(self.muted)
            self.out("🔇 transcription muted; the agent keeps working" if self.muted else "🎙  transcription on")

    def paused_by_you(self) -> bool:
        """You took over a running Mac task a moment ago or more (not just now, with this fn press)."""
        return bool(self.task and self.task.running and self.paused_since
                    and time.time() - self.paused_since > 0.8)

    def resume_control(self):
        """fn while you have control of a running task: the agent takes it back once your hands are off."""
        self.out("▶️  fn: handing control back to the agent (hands off the keyboard and trackpad)")
        if hasattr(self.captions, "paused"):
            self.captions.paused("Resuming once your hands are off the keyboard and trackpad…")
        if getattr(self.task, '_recovery_id', None):  # the same as saying "continue"
            try:
                import task_recovery
                task_recovery.finish(self.task._recovery_id, 'active')
            except (OSError, ValueError) as error:
                self.out(f'Could not save the resume state: {error}')
        self.take_control()

    def on_helper(self, event: dict):
        if event.get("state") in ("engaged", "disengaged") and getattr(self, "recorder", None):
            self.recorder.event("control", "agent has the mouse and keyboard" if event["state"] == "engaged"
                                else f"control went back to you ({event.get('reason', '')})")
        fn = event.get("fn")
        if fn == "down":
            self.start_dictation()
        elif fn == "tap":
            self.drop_dictation()
            if self.paused_by_you():
                self.resume_control()
            else:
                self.set_listening(not self.listening)
        elif fn == "other":  # fn+arrow, fn+delete, ...: a shortcut
            self.drop_dictation()
            self.ears.listen(self.listening)
        elif fn == "up":
            self.finish_dictation()
        elif event.get("state") == "engaged" and self.task and self.task.running:
            if self.pause_announced:
                self.out("▶️  continuing")
            self.paused_since, self.pause_announced = 0.0, False
            if hasattr(self.captions, "paused"):
                self.captions.paused("")
        elif event.get("state") == "disengaged" and took_over(event.get("reason")) and not self.paused_since:
            self.paused_since = time.time()
            if self.task and self.task.running and hasattr(self.captions, "paused"):
                self.captions.paused("Paused: you took over. Press fn to let the agent continue.")
            if self.task and getattr(self.task, '_recovery_id', None):
                try:
                    import task_recovery
                    with self.task._dispatch_lock:
                        task_recovery.finish(self.task._recovery_id, 'paused')
                except (OSError, ValueError) as error:
                    self.out(f'Could not save the takeover state: {error}')

    # -- dictation: hold fn --

    def start_dictation(self):
        """fn went down. Until it's let go, what you say is dictation (dropped if it was a tap).
        What you were saying to the agent before ends here, and goes to the agent."""
        held = self.held = Dictation()
        self.ears.cut(then=lambda: self.events.put(("route", held)))
        self.ears.listen(True)

    def drop_dictation(self):
        held, self.held = self.held, None
        if held:
            held.dropped = True
            self.ears.cut(then=lambda: self.events.put(("route", None)))
            self.show_dictating(held, False)

    def finish_dictation(self):
        """fn was let go after a hold: once the last of what you said is written down, it's typed."""
        held, self.held = self.held, None
        if held:
            self.ears.cut(then=lambda: self.events.put(("dictated", held)))
            self.ears.listen(self.listening)
            self.show_dictating(held, False)

    def show_dictating(self, held: Dictation, on: bool):
        if on != held.shown:
            held.shown = on
            self.captions.dictating(on)
            self.tell("dictating", "1" if on else "0")

    def on_dictated(self, text: str, final: bool):
        dictation = self.dictation
        if final:
            self.over_its_voice = False
            if text:
                dictation.words.append(text)
        if not dictation.dropped:
            self.captions.hearing(dictation.text("" if final else text))

    def type_dictation(self, dictation: Dictation):
        text = dictation.text()
        if dictation.dropped or not text:
            return
        self.log("dictation", text if os.environ.get("AGENT_JOURNAL_DICTATION") == "1" else "",
                 words=len(text.split()))
        self.out(f"✍️  typing what you dictated ({len(text.split())} words)")  # not the words: they're yours

        def type_it():
            error = self.paste(text)
            if error:
                self.out(f"   couldn't type it ({error}); it's on the clipboard, so ⌘V pastes it")
                notify("Couldn't type what you dictated. It's on the clipboard: ⌘V pastes it.")
        threading.Thread(target=type_it, daemon=True).start()

    def out(self, text: str):
        """Prints a line. The words you're saying, if they're showing, make way and come back with
        the next ones."""
        if self.live_shown:
            sys.stdout.write("\r\033[K")
            self.live_shown = False
        print(text, flush=True)
        recorder = getattr(self, "recorder", None)
        if recorder and not text.lstrip().startswith("🎞"):
            recorder.event("hive", text)

    def show_live(self, text: str):
        if self.live:
            width = shutil.get_terminal_size().columns - 5
            if len(text) > width:
                text = "…" + text[-(width - 1):]
            sys.stdout.write(f"\r\033[K🎙  {text}")
            sys.stdout.flush()
            self.live_shown = True
        elif not self.app:  # (the app's log gets only the whole of it)
            print(f"🎙  {text}", flush=True)

    def on_ignored(self, seconds: float, similarity: float):
        own = bool(getattr(self.ears.voiceprint, "heard_machine", False))
        self.log("voice left out", "its own voice" if own else "not your voice", seconds=round(seconds, 2),
                 similarity=round(similarity, 3))
        if own:
            note = f"(its own voice, ignored: {seconds:.1f} s)"
        else:
            note = f"(not your voice, ignored: {seconds:.1f} s, {similarity:.2f} like yours)"
        if self.live:  # on the line your words show on, so a TV or people chatting don't fill the screen
            sys.stdout.write(f"\r\033[K\033[2m   {note}\033[0m")
            sys.stdout.flush()
            self.live_shown = True
        else:
            self.out(f"   {note}")

    def on_heard(self, text: str, final: bool, times: dict | None = None):
        """times: when you stopped talking, it decided you'd finished and it had written it down
        (time.monotonic(), from the listener)."""
        if self.dictation:
            self.on_dictated(text, final)
            return
        if not self.listening or self._discard_heard:
            return
        self.captions.hearing(text)
        if not final:
            self.show_live(text)
            return
        if self.live_shown:
            sys.stdout.write("\r\033[K")
            self.live_shown = False
        self.on_transcript(text, times)

    def on_transcript(self, text: str, times: dict | None = None, typed: bool = False,
                      captured: bool = False, ingress_receipt: str | None = None):
        from_agent = ingress_receipt is not None  # it came through the request socket, not from you
        ahead, self.ahead, self.timing = self.ahead, None, None
        words = re.sub(r"[^\w' -]", "", text.lower()).strip()
        over_its_voice, self.over_its_voice = self.over_its_voice, False
        heard = {k: round(v, 3) for k, v in (times or {}).items() if isinstance(v, (int, float))}
        if not words:
            return
        if words in FILLERS:
            if not captured:
                try:
                    import ui_ingress
                    channel = 'typed' if typed else ('lip' if getattr(self, 'input_mode', 'voice') == 'lips' else 'voice')
                    receipt = ui_ingress.admit(text, channel)
                    ui_ingress.finish(receipt, 'accepted')
                except (OSError, ValueError, subprocess.SubprocessError) as error:
                    self.out(f'Could not save the message: {error}')
            self.log("you said", text, outcome="filler, ignored")
            return  # a cough, a click, an "mm-hmm"
        just_spoke = over_its_voice or bool(self.voice and self.voice.quiet_for() < JUST_SPOKE)
        if not typed and just_spoke and self.its_own_words(words):
            self.log("you said", text, outcome="its own voice, ignored")
            self.out(f"   (heard its own voice: {text})")
            return
        # An explicit stop is executed immediately, even if the receipt store is
        # unavailable. All other UI instructions are durably admitted first.
        owned_receipt = None
        if not captured and words not in CANCEL:
            try:
                import ui_ingress
                channel = 'typed' if typed else ('lip' if getattr(self, 'input_mode', 'voice') == 'lips' else 'voice')
                owned_receipt = ui_ingress.admit(text, channel)
                ingress_receipt = owned_receipt
            except (OSError, ValueError, subprocess.SubprocessError) as error:
                self.out(f'Could not save the request; it was not started: {error}')
                return
        self.out(f"🗣  {text}")

        if self.voice:
            self.voice.stop()  # whatever it was saying is old news
        self.captions.say("")
        if hasattr(self.captions, 'thinking'):
            self.captions.thinking("")
        if words in CANCEL:
            running = [device for device, task in self.tasks.items() if task and task.running]
            self.log("you said", text, outcome="stop", stopped=running)
            for device in running:
                self.tasks[device].stop()
                self.tasks[device] = None
                self.doing.pop(device, None)
            # A provider wait may have been durably armed while this process had
            # no in-memory task. A stop also fences that pending recovery.
            try:
                import task_recovery, provider_wait
                saved = task_recovery.current()
                if (saved and saved.get('status') == 'active' and
                        provider_wait.status(saved.get('id')) == 'waiting'):
                    task_recovery.finish(saved['id'], 'stopped')
            except (OSError, ValueError) as error:
                self.out(f'Could not save the stop fence: {error}')
            if running:
                if "mac" in running:
                    self.hand_back()
                self.show_doing()
                if hasattr(self.captions, 'active'):
                    self.captions.active(any(t is not None for t in self.tasks.values()))
                self.say("Stopped.")
            if not captured:
                try:
                    import ui_ingress
                    receipt = ui_ingress.admit(text, 'typed' if typed else 'voice')
                    ui_ingress.finish(receipt, 'accepted')
                except (OSError, ValueError, subprocess.SubprocessError) as error:
                    self.out(f'Stopped, but could not save its receipt: {error}')
            return
        if words in CONTINUE and os.environ.get("AGENT_SPACEO_COMMAND"):
            self.tell("workspace-resume", "1")
        if words in CONTINUE and self.task and self.task.running:
            self.log("you said", text, outcome="continue")
            if getattr(self.task, '_recovery_id', None):
                try:
                    import task_recovery
                    task_recovery.finish(self.task._recovery_id, 'active')
                except (OSError, ValueError) as error:
                    self.out(f'Could not save the resume state: {error}')
            if not os.environ.get("AGENT_SPACEO_COMMAND"):
                self.take_control()  # it carries on from where things are now
            if owned_receipt:
                self.finish_ui_receipt(owned_receipt)
            return

        device = focus(words)
        said, joined = text, False
        previous, task = None, self.tasks[device]
        if task and task.running:  # a new request for the same device replaces the old one
            task.stop()
            if time.time() - task.started_at < FOLLOW_UP:  # you paused, then carried on
                text, joined = f"{task.task} {text}", True
                self.out("   (adding that to what you just asked)")
            else:
                previous = task.task
                self.out("   (interrupted the previous task)")
        if device == "mac":
            self.paused_since, self.pause_announced = 0.0, False
        self.last_said[device] = ""
        task = self.tasks[device] = CodexTask(text, previous=previous, device=device, ahead=ahead)
        task._receipt_id = ingress_receipt
        if hasattr(self.captions, 'active'): self.captions.active(True)
        if hasattr(self.captions, 'activity'):
            self.captions.activity(f'Request from another agent: {shortened(said, 240)}' if from_agent
                                   else f'Request: {said}')
        self.timing = {"task": task, **(times or {})}
        task.on_event = lambda kind, t, task=task: self.events.put(("task", (task, kind, t)))
        self.log("you said", said, outcome="request", heard=heard or None)
        self.log("request", text, device=device, interrupted=previous, added_to_last=joined or None)
        notify(shortened(text, 160) if from_agent else text, "On it")
        task.start()
        if owned_receipt:
            self.finish_ui_receipt(owned_receipt)
        if device == "mac" and not (os.environ.get('AGENT_WORKSPACE_CONNECTION') or os.environ.get('AGENT_SPACEO_COMMAND')):
            self.take_control()

    def finish_ui_receipt(self, receipt):
        try:
            import ui_ingress
            ui_ingress.finish(receipt, 'accepted')
        except (OSError, ValueError, subprocess.SubprocessError) as error:
            self.out(f'Request started, but receipt status is unknown: {error}')

    def start_virtual_monitor(self):
        """Asks where Hive should work (your screen or the virtual monitor) and sets that up. No
        answer keeps the last choice; the Mac tools use your screen whenever the monitor is off."""
        try:
            import virtual_monitor
            if os.environ.get("HIVE_VIRTUAL_MONITOR") not in ("0", "1") and os.environ.get("HIVE_ASK_WORK_SCREEN", "1") != "0":
                virtual_monitor.ask()
            if virtual_monitor.enabled():
                if not virtual_monitor.ensure():
                    self.out("   ✗ The virtual monitor did not start; working on your screen.")
            else:
                virtual_monitor.off()
            self.out("Working on " + ("the virtual monitor." if virtual_monitor.bounds() else "your screen, with your mouse and keyboard."))
        except Exception as error:
            self.out(f"   ✗ Could not set up where Hive works: {error}")

    def take_control(self):
        try:
            import virtual_monitor
            from agent_vhid import cursor_position
            virtual_monitor.ensure()
            here = cursor_position()
            if not virtual_monitor.contains(*here):
                self._cursor_home = here  # where your cursor goes back to when the task ends
        except Exception:
            pass
        try:
            self.mac.engage()  # the helper still waits for your hands to be off
        except AgentVHIDError as e:
            self.out(f"   couldn't take control: {e}")

    def on_task_event(self, task: CodexTask, kind: str, text: str):
        if kind == "context":
            self.tell("context", text)
            return
        device = task.device
        current = self.tasks[device] is task
        if kind not in ("doing", "data", "plan_delta"):
            self.log(kind, text, device=device, request=task.task, thread=getattr(task, "_thread", None),
                     interrupted=None if current else True)
        if not current:
            return  # from a task that was interrupted
        mark = "📱 " if device == "phone" else ""
        if kind == "doing":
            self.doing[device] = text
            self.show_doing()
            if getattr(self, "recorder", None):
                self.recorder.event("status", f"{mark}{text}")
        elif kind == "action":
            self.out(f"   → {mark}{text}")
            if hasattr(self.captions, 'activity'): self.captions.activity(f'Tool: {mark}{text}')
        elif kind in ("think", "plan", "plan_delta"):
            if hasattr(self.captions, 'thinking'):
                self.captions.thinking(text[:600])
            if kind == 'plan' and hasattr(self.captions, 'activity'):
                self.captions.activity(f'Plan: {text}')
        elif kind == "data":
            if hasattr(self.captions, 'activity'): self.captions.activity(text)
        elif kind == "error":
            self.out(f"   ✗ {mark}{text}")
        elif kind == "say":  # its reply, a sentence or so at a time as Codex writes it
            self.out(f"   💬 {mark}{text}")
            self.say(text, device, task)
        elif kind in ("done", "failed"):
            self.tasks[device] = None
            if hasattr(self.captions, 'active'):
                self.captions.active(any(t is not None for t in self.tasks.values()))
            if hasattr(self.captions, 'activity'):
                self.captions.activity('Finished' if kind == 'done' else f'Stopped: {text}')
            if device == "mac" and hasattr(self.captions, "paused"):
                self.captions.paused("")
                self.paused_since, self.pause_announced = 0.0, False
            self.doing.pop(device, None)
            self.show_doing()
            if kind == "done":
                self.out(f"✅ {mark}done in {task.elapsed:.0f} s\n")
                if device == "mac":
                    self.hand_back()
                notify(text, "Done")
                if not self.last_said.get(device):  # (it has said its reply as it came)
                    self.say(text, device, task)
            elif text != "stopped":
                self.out(f"❌ {mark}{text}\n")
                if device == "mac":
                    self.hand_back()
                self.say("Sorry, that didn't work.")
            if not any(self.tasks.values()):
                self._apply_scheduled_update()

    def _apply_scheduled_update(self):
        """Run a prepared update outside this process only after every turn has finished."""
        marker = state_dir() / "updates" / "update-pending"
        if not marker.exists():
            marker = state_dir() / "update-pending"  # finish a handoff from an older version
        if not marker.exists():
            return
        claimed = marker.with_name("update-applying")
        try:
            marker.replace(claimed)
            log_path = state_dir() / "update.log"
            with log_path.open("a") as log:
                subprocess.Popen(["/bin/bash", os.path.join(os.path.dirname(HERE), "tools", "update-app.sh")],
                                 stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
            self.out("Installing the prepared update; the conversation will be available after restart.")
        except OSError as error:
            if claimed.exists():
                claimed.replace(marker)
            self.out(f"Could not start the update: {error}")

    def show_doing(self):
        """The captions' small line: what each running task is doing ("Thinking", "Typing ...")."""
        doing = "   ·   ".join(("📱 " if device == "phone" else "") + text
                               for device, text in self.doing.items() if text)
        self.captions.doing(doing)
        self.tell("status", doing or "Ready")

    def hand_back(self):
        try:
            self.mac.disengage()
            self.mac.release_all()
        except AgentVHIDError:
            pass
        try:  # your cursor returns from the virtual monitor to where it was on your screen
            import virtual_monitor
            from agent_vhid import cursor_position
            home = getattr(self, "_cursor_home", None)
            if home and virtual_monitor.contains(*cursor_position()):
                virtual_monitor.warp(*home)
            self._cursor_home = None
        except Exception:
            pass

    def say(self, text: str, device: str | None = None, task: CodexTask | None = None):
        """task: it's what that task says (the first of it ends the request's timing)."""
        self.last_said[device] = text.strip()
        if not text:
            return
        will_speak = bool(self.voice) and workspace_voice_allowed()
        timing = self.timing
        if task and timing and timing["task"] is task and not timing.get("queued"):
            timing["queued"] = True
            if not will_speak:  # shown, not said
                timing["answered"] = time.monotonic()
                self.out(describe_timing(timing))
        if task is None:  # (what a task says is saved with the task's events)
            self.log("agent said", text, device=device, spoken=will_speak)
        if will_speak:
            self.said = [(when, t) for when, t in self.said if time.time() - when < 30] + [(time.time(), text)]
            self.voice.say(spoken(text))  # the captions show each sentence as it's spoken
        else:
            self.captions.say(spoken(text))

    def shutdown(self):
        self.stopped.set()
        if getattr(self, "embedded_workspace", None):
            self.embedded_workspace.close()
        if getattr(self, "local_requests", None):
            self.local_requests.close()
        maintenance = ((state_dir() / 'updates' / 'update-applying').exists() or
                       (state_dir() / 'update-applying').exists())
        for task in self.tasks.values():
            if task and task.running:
                if maintenance and hasattr(task, 'stop_for_maintenance'):
                    task.stop_for_maintenance()
                else:
                    task.stop()
        if self.voice:
            self.voice.stop()
        self.hand_back()
        self.captions.close()
        if self.lips:
            self.lips.close()  # the camera, if on, turns off
        if self.journal:
            self.journal.end()
            self.journal = None


def describe_timing(timing: dict) -> str:
    """Where a request's time went, from when you stopped talking to hearing its reply: '⏱  2.9 s
    from when you stopped talking to hearing its reply: 0.8 s to be sure you'd finished, 0.1 s
    writing it down, screenshot ready (taken as you talked), 1.6 s for Codex's first words (1 model
    call), 0.4 s for the voice to start'."""
    task: CodexTask = timing["task"]
    t = {k: task.began + v for k, v in task.times.items()}  # (time.monotonic())
    stopped, decided, written = timing.get("stopped"), timing.get("decided"), timing.get("written")
    start = stopped or decided or written or task.began
    parts = []
    if stopped and decided:
        parts.append(f"{decided - stopped:.1f} s to be sure you'd finished")
    if decided and written:
        parts.append(f"{written - decided:.1f} s writing it down")
    if written and task.began - written >= 0.1:
        parts.append(f"{task.began - written:.1f} s before the task started")
    since = task.began
    if "look" in t:
        parts.append("screenshot ready (taken as you talked)" if task.looked_ahead
                     else f"{t['look'] - since:.1f} s for the screenshot")
        since = t["look"]
    if "codex" in t:
        if t["codex"] - since >= 0.1:
            parts.append(f"{t['codex'] - since:.1f} s for Codex to start")
        since = t["codex"]
    if "words" in t:
        calls = task.calls_to_words
        parts.append(f"{t['words'] - since:.1f} s for Codex's first words ({calls} model call{'s' * (calls != 1)})")
        since = t["words"]
    end = timing.get("answered", since)
    if timing.get("spoken") and end - since >= 0.05:
        parts.append(f"{end - since:.1f} s for the voice to start")
    heard = "hearing" if timing.get("spoken") else "seeing"
    return f"⏱  {end - start:.1f} s from when you stopped talking to {heard} its reply: " + ", ".join(parts)


def describe_phone() -> str:
    try:
        return "connected" if Phone().connected() else "not connected (run “Pocket Connect” on it)"
    except PhoneError as e:
        return "off" if not os.environ.get("PHONE_RELAY") else f"unreachable ({e})"


def interrupt(*_):
    raise KeyboardInterrupt


def helper_log() -> str:
    """Where agent-vhid-helper writes: the Mac's log once ./install.sh installed it, else ./voice.sh's."""
    installed = os.path.exists("/Library/LaunchDaemons/local.personal-agent.helper.plist")
    return "/Library/Logs/agent-vhid-helper.log" if installed else "/tmp/agent-vhid-helper.log"


def read_app(toggle, put=None):
    """Agent.app's menu: "toggle" is the same as tapping fn; "ingest PATH" adds the text in PATH to
    the conversation; "input voice|lips" picks how you talk to it. The end of stdin means the app quit."""
    for line in sys.stdin:
        line = line.strip()
        if line == "toggle":
            toggle()
        elif put and " " in line:
            what, _, arg = line.partition(" ")
            if what in ("ingest", "input"):
                put((what, arg))
    os.kill(os.getpid(), signal.SIGTERM)


def wait_for_helper(mac: AgentVHID, forever: bool = False) -> bool:
    """Waits for agent-vhid-helper (the Mac starts it once ./install.sh has installed it; ./voice.sh
    starts it otherwise) and its virtual devices. forever (Agent.app): keeps waiting, saying why."""
    told = ""
    attempt = 0
    while True:
        try:
            status = mac.status()
        except AgentVHIDError:
            status = {}
        ready = status.get("vhid") in ("ready", "dry_run")
        if status and status.get("fn") != "1":
            problem = ("The running agent-vhid-helper is an old one, without fn. Run ./install.sh again, or stop "
                       "it (Ctrl-C in its window) and start ./voice.sh.", "agent-vhid-helper is out of date")
        elif ready or (status and attempt >= 60):
            if not ready:
                print(f"warning: virtual keyboard/mouse not ready ({status.get('vhid')}); "
                      f"see {helper_log()}", flush=True)
            return True
        elif attempt >= 60:  # 30 s
            problem = ("agent-vhid-helper isn't running. Run ./install.sh to have the Mac start it, or start "
                       f"everything with ./voice.sh (helper log: {helper_log()}).",
                       "Waiting for agent-vhid-helper")
        else:
            attempt += 1
            time.sleep(0.5)
            continue
        if not forever:
            print(problem[0])
            return False
        if told != problem[0]:
            told = problem[0]
            print(problem[0], flush=True)
            print(f"@@ status {problem[1]}", flush=True)
        attempt += 1
        time.sleep(2)


def main(argv: list[str]) -> int:
    if "-h" in argv or "--help" in argv:
        print(__doc__)
        return 0
    app = "--app" in argv
    settings.load()
    settings.fix_newlines()
    find_codex()
    threading.Thread(target=warm_up, daemon=True).start()  # Codex is ready by the time you've said something

    agent: VoiceAgent | None = None
    if app:  # from the start, so the app quitting stops us even while we wait for the helper
        threading.Thread(target=read_app, args=(lambda: agent and agent.events.put(("toggle", None)),
                                                lambda event: agent and agent.events.put(event)),
                         daemon=True).start()
    mac = AgentVHID()
    if not wait_for_helper(mac, forever=app):
        return 1
    agent = VoiceAgent(speak="--no-speak" not in argv, mac=mac, captions=Captions(), app=app)
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
