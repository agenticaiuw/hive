"""Talk with your Mac, and it talks back.

Hold Right Option and speak, in any window. GPT-Live (OpenAI's live voice model) answers out loud
and hands anything that takes real work (using the computer, looking things up, careful
reasoning) to the computer agent: Codex with your own model, e.g. gpt-6-astra, which does it on
screen with the real mouse and keyboard. Touch any key, the trackpad or the mouse to take over.

    ./voice.sh        (sets up .venv and runs this when .env has OPENAI_API_KEY)

  hold Right Option        talk; it stops speaking so it can listen
  say "stop"               stop the computer agent
  touch keys / trackpad    take over; double-tap Right Option to let it continue

A conversation stays open while you talk and while the agent works, and closes after
LIVE_IDLE_SECONDS (in .env, default 45) of quiet, because GPT-Live bills by the second. Holding
Right Option again opens a new one that remembers what was said.
"""

from __future__ import annotations

import asyncio
import base64
import collections
import json
import os
import re
import signal
import subprocess
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import settings  # noqa: E402

settings.load()

from agent import CodexTask, describe_model, find_codex  # noqa: E402
from agent_vhid import AgentVHID, AgentVHIDError, NotAllowed  # noqa: E402
from voice_agent import HUMAN, notify, spoken, wait_for_helper  # noqa: E402

try:
    import websockets
    from websockets.exceptions import InvalidStatus
except ImportError:
    sys.exit("Missing packages: run ./voice.sh (it sets up .venv), or .venv/bin/python -m pip install -r requirements.txt")

URL = os.environ.get("LIVE_URL", "wss://api.openai.com/v1/live/sessions")
MODEL = os.environ.get("LIVE_MODEL") or "gpt-live-1"
VOICE = os.environ.get("LIVE_VOICE") or "marin"
IDLE_SECONDS = float(os.environ.get("LIVE_IDLE_SECONDS") or 45)
AUDIO_OFF = os.environ.get("LIVE_AUDIO") in ("none", "tone")  # tests
PRICE_PER_MINUTE = 0.05
RATE = 24000       # GPT-Live's default format, both ways: 24 kHz mono 16-bit PCM
MAX_APPEND = 1500  # characters; GPT-Live takes up to 500 tokens per context append

INSTRUCTIONS = """\
You are the voice of a personal assistant that can operate the user's Mac. The user talks to you \
by holding a key, so whenever you hear them they are speaking to you. Be warm and natural, and \
brief: one or two short sentences unless they ask for more.

Backend tools
A computer agent, a much stronger reasoning model, works for you. It sees the screen and uses \
the real mouse and keyboard: it can open apps and websites, click, type, read what is on screen, \
fill in forms, write and edit text, look things up, do calculations and answer hard questions. \
It takes from a few seconds to a few minutes. It won't buy, send, delete, change settings or type \
passwords unless the user asked for exactly that.

Delegation policy
Generate <|SpawnThinking|> when the user asks for anything to be done on the computer, asks about \
what is on their screen, asks a factual question, or wants a calculation, writing, advice or \
anything else that needs care, and when they change, correct or stop a task in progress.
Do not generate <|SpawnThinking|> for greetings, thanks, small talk, a request to repeat yourself, \
or a question about what the agent is doing right now; answer that from your notes.
Generate <|SpawnThinking|> before giving an answer that depends on backend work. Do not guess the \
result while waiting: a short acknowledgement such as "On it." is enough. Never say something is \
done until the result arrives, then tell the user in your own words, briefly.

Interruption policy
Stop speaking when the user interrupts. Listen to what they say.

Backchannel policy
Use few backchannels; the user speaks in short push-to-talk turns.
"""


MIC_SILENT = ("   The microphone only gives silence. Allow microphone access for the app you run ./voice.sh in "
              "(System Settings › Privacy & Security › Microphone), then restart ./voice.sh.")


def is_cancel(text: str) -> bool:
    """'Stop', 'cancel that', 'okay never mind': a short request to stop the computer agent."""
    words = " ".join(re.sub(r"[^\w' ]", " ", text.lower()).split())
    return 0 < len(words.split()) <= 4 and bool(re.search(r"\b(stop|cancel|abort|never ?mind|quit)\b", words)) \
        and not re.search(r"\b(talking|speaking)\b", words)


def describe_error(event: dict) -> str:
    error = event.get("error") or {}
    return error.get("message") or json.dumps(error)


def cue():
    if not AUDIO_OFF:
        subprocess.Popen(["afplay", "-v", "0.25", "/System/Library/Sounds/Tink.aiff"],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


class LiveError(Exception):
    pass


def has_sound(pcm: bytes) -> bool:
    """GPT-Live streams output audio all the time; between sentences it is exact zeros."""
    return bool(pcm.strip(b"\0"))


def clean(text: str) -> str:
    """Drops the non-verbal tags in GPT-Live's transcript, like [hum] or [laughs]."""
    return " ".join(re.sub(r"\[[^\]]*\]", " ", text).split())


class Speaker:
    """Plays GPT-Live's voice as it streams in."""

    def __init__(self):
        import sounddevice
        self._buffer = bytearray()
        self._lock = threading.Lock()
        self._voice_until = 0.0
        self._stream = sounddevice.RawOutputStream(samplerate=RATE, channels=1, dtype="int16", callback=self._fill)
        self._stream.start()

    def _fill(self, out, frames, _time, _status):
        n = frames * 2
        with self._lock:
            chunk = bytes(self._buffer[:n])
            del self._buffer[:n]
        out[:len(chunk)] = chunk
        out[len(chunk):] = bytes(n - len(chunk))

    def play(self, pcm: bytes):
        with self._lock:
            self._buffer.extend(pcm)
            if has_sound(pcm):
                self._voice_until = time.time() + len(self._buffer) / (2 * RATE)

    def stop(self):
        """Drops what hasn't been played yet."""
        with self._lock:
            self._buffer.clear()
            self._voice_until = 0.0

    @property
    def playing(self) -> bool:
        """Still saying something (the silence GPT-Live sends in between doesn't count)."""
        return time.time() < self._voice_until

    def close(self):
        self._stream.stop()
        self._stream.close()


class Microphone:
    """Stays open while the agent runs. A Mac can take seconds to open its microphone after it has
    been idle, and push-to-talk has to catch your first word. What it hears is only sent while you
    hold Right Option (see LiveAgent._on_mic)."""

    def __init__(self, on_audio):
        self.on_audio = on_audio
        self._stream = None
        self.last_audio = 0.0

    def open(self):  # blocking: call it off the event loop
        import sounddevice
        self.close()
        self._stream = sounddevice.RawInputStream(samplerate=RATE, channels=1, dtype="int16",
                                                  blocksize=RATE // 50, callback=self._callback)
        self.last_audio = time.time()
        self._stream.start()

    def _callback(self, data, _frames, _time, _status):
        self.last_audio = time.time()
        self.on_audio(bytes(data))

    @property
    def is_open(self) -> bool:
        return self._stream is not None

    @property
    def stalled(self) -> bool:
        """Open but no audio for a while: the device went away (AirPods, iPhone mic, ...)."""
        return self._stream is not None and time.time() - self.last_audio > 2

    def close(self):
        stream, self._stream = self._stream, None
        if stream:
            stream.stop()
            stream.close()


class NoSpeaker(Speaker):
    def __init__(self):
        self._buffer, self._lock, self._voice_until = bytearray(), threading.Lock(), 0.0

    def play(self, pcm: bytes):
        pass

    def close(self):
        pass


class NoMicrophone(Microphone):
    def open(self):
        self._stream = True

    @property
    def stalled(self) -> bool:
        return False

    def close(self):
        self._stream = None


class ToneMicrophone(NoMicrophone):
    """Tests: hears a steady tone, so they can check what gets sent and when."""

    def open(self):
        super().open()
        def hum():
            while self._stream:
                self.on_audio(b"\x10\x01" * (RATE // 50))
                time.sleep(0.02)
        threading.Thread(target=hum, daemon=True).start()


class LiveAgent:
    def __init__(self):
        self.loop = asyncio.get_running_loop()
        self.background: set[asyncio.Task] = set()
        self.mac = AgentVHID()
        mic = {"none": NoMicrophone, "tone": ToneMicrophone}.get(os.environ.get("LIVE_AUDIO", ""), Microphone)
        self.mic = mic(self._heard)
        self.speaker: Speaker | None = None
        self.audio_lock = asyncio.Lock()  # opening devices and restarting PortAudio take turns
        self.mic_audio: asyncio.Queue[bytes] = asyncio.Queue()
        self.sending = False  # the microphone goes to GPT-Live: while you hold Right Option, and a moment after
        self.preroll: collections.deque[bytes] = collections.deque(maxlen=15)  # the 0.3 s before you pressed
        self.mic_alive = False  # it has delivered something other than zeros
        self.mic_heard_something = False
        self.warned_about_mic = False
        self.ws = None
        self.connecting: asyncio.Future | None = None
        self.closing = False
        self.stopping = False  # shutting down
        self.closed = asyncio.Event()
        self.close_reason: str | None = None
        self.usage = 0.0
        self.event_seq = 0
        self.listening = False
        self.turns: list[list[str]] = []  # [role, text], from GPT-Live's transcripts
        self.new_user_turn = True
        self.handed_over = 0  # turns before this index were already given to the agent
        self.checked_for_stop = 0
        self.last_heard = 0.0  # when the last fragment of your transcript arrived
        self.last_fragment = 0.0  # when the last fragment of anyone's transcript arrived
        self.last_activity = time.time()
        self.line: str | None = None  # whose transcript is being printed on the current line
        self.delegation_lock = asyncio.Lock()
        self.task: CodexTask | None = None
        self.task_seq = 0
        self.delegation: str | None = None  # the GPT-Live delegation the running task answers
        self.progress: list[str] = []
        self.last_progress = 0.0
        self.stopped_at = 0.0
        self.paused_since = 0.0
        self.pause_announced = False

    # -- printing --

    def say_line(self, text: str):
        self.end_line()
        print(text, flush=True)

    def end_line(self):
        if self.line:
            print(flush=True)
            self.line = None

    # -- background work --

    def spawn(self, coro) -> asyncio.Task:
        task = asyncio.ensure_future(coro)
        self.background.add(task)  # the loop only keeps a weak reference
        task.add_done_callback(self._finished)
        return task

    def _finished(self, task: asyncio.Task):
        self.background.discard(task)
        if not task.cancelled() and task.exception():
            self.say_line(f"   ✗ internal error: {task.exception()!r}")

    def from_thread(self, fn, *args):
        try:
            self.loop.call_soon_threadsafe(fn, *args)
        except RuntimeError:  # shutting down
            pass

    def _heard(self, pcm: bytes):  # audio thread
        self.from_thread(self._on_mic, pcm)

    def _on_mic(self, pcm: bytes):
        if has_sound(pcm):
            self.mic_alive = True
        if self.sending:
            self.mic_heard_something = self.mic_heard_something or has_sound(pcm)
            self.mic_audio.put_nowait(pcm)
        else:
            self.preroll.append(pcm)  # kept on this Mac, and only the last 0.3 s

    # -- audio devices --

    async def open_audio(self):
        try:
            async with self.audio_lock:
                await self.loop.run_in_executor(None, self.mic.open)
        except Exception as e:  # PortAudio's device list is stale, or there's no microphone
            self.say_line(f"   (microphone: {e}; trying again)")
            await self.reset_audio()

    async def reset_audio(self):
        """Restarts PortAudio and reopens the microphone (and the speaker, mid-conversation) on the
        Mac's current default devices. PortAudio only looks for devices when it starts, so one that
        came or went since (AirPods, an iPhone, a Zoom or Teams virtual device) needs a restart."""
        if AUDIO_OFF or self.audio_lock.locked():
            return
        async with self.audio_lock:
            had_speaker, self.speaker = self.speaker, None
            try:
                await self.loop.run_in_executor(None, self._restart_portaudio, had_speaker)
                if had_speaker and self.ws:
                    self.speaker = await self.loop.run_in_executor(None, Speaker)
            except Exception as e:
                self.say_line(f"   ✗ microphone: {e}")

    def _restart_portaudio(self, speaker: Speaker | None):  # executor thread
        import sounddevice
        self.mic.close()
        if speaker:
            speaker.close()
        sounddevice._terminate()
        sounddevice._initialize()
        self.mic.open()

    def watch_helper(self):
        while True:
            try:
                for event in AgentVHID(self.mac.socket_path).watch():
                    self.from_thread(self.on_helper, event)
            except (AgentVHIDError, OSError):
                pass
            time.sleep(2)  # helper restarted or not up yet

    # -- your side: Right Option and the helper --

    def on_helper(self, event: dict):
        talk = event.get("talk")
        if talk == "down" and not self.listening:
            self.start_listening()
        elif talk == "up" and self.listening:
            self.listening = False
            self.last_activity = time.time()
            self.loop.call_later(0.4, self.stop_sending)  # the end of your last word
        elif event.get("state") == "engaged" and self.task_running():
            if self.pause_announced:
                self.say_line("▶️  continuing")
                self.thinking("The user handed control back; the agent is carrying on.")
            self.paused_since, self.pause_announced = 0.0, False
        elif event.get("state") == "disengaged" and event.get("reason") in HUMAN and self.task_running() \
                and not self.paused_since:
            self.paused_since = time.time()

    def start_listening(self):
        self.listening = True
        self.new_user_turn = True
        self.mic_heard_something = False
        if not self.sending:
            self.sending = True
            while self.preroll:
                self.mic_audio.put_nowait(self.preroll.popleft())
        if self.speaker:
            self.speaker.stop()  # you're talking over it
        cue()
        self.say_line("🎙  listening...")
        if not self.mic.is_open or self.mic.stalled:
            self.spawn(self.reset_audio())
        if not self.ws and not self.connecting:
            self.connecting = self.spawn(self.open_session())

    def stop_sending(self):
        if self.listening:
            return  # you started talking again
        self.sending = False
        if not AUDIO_OFF and not self.mic_heard_something and not self.warned_about_mic:
            self.warned_about_mic = True
            self.say_line(MIC_SILENT)

    # -- the GPT-Live session --

    def session_config(self, with_history: bool) -> dict:
        config = {
            "model": MODEL,
            "instructions": INSTRUCTIONS,
            "audio": {"format": {"type": "audio/pcm", "rate": RATE}, "output": {"voice": VOICE}},
            "delegation": {"type": "client"},
        }
        if with_history and self.turns:
            config["input"] = self.history()
        return config

    def history(self) -> list[dict]:
        """What was said in earlier conversations, so a new one carries on from there."""
        items = []
        for role, text in self.turns[-16:]:
            if clean(text):
                part = {"type": "input_text" if role == "user" else "output_text", "text": clean(text)[:600]}
                items.append({"type": "message", "role": role, "content": [part]})
        return items

    async def open_session(self):
        try:
            try:
                ws = await self.connect(with_history=True)
            except LiveError as e:
                if not self.turns or "input" not in str(e):
                    raise
                ws = await self.connect(with_history=False)
            self.ws, self.usage, self.close_reason = ws, 0.0, None
            self.closed.clear()
            async with self.audio_lock:
                self.speaker = NoSpeaker() if AUDIO_OFF else await self.loop.run_in_executor(None, Speaker)
            self.spawn(self.read(ws))
            self.spawn(self.stream_audio(ws))
        except Exception as e:
            if isinstance(e, InvalidStatus):
                e = f"HTTP {e.response.status_code} {e.response.body.decode(errors='replace')[:300]}"
            self.say_line(f"   ✗ couldn't reach GPT-Live: {e}")
            while not self.mic_audio.empty():
                self.mic_audio.get_nowait()
        finally:
            self.connecting = None

    async def connect(self, with_history: bool):
        ws = await websockets.connect(URL, additional_headers={"Authorization": f"Bearer {os.environ['OPENAI_API_KEY']}"},
                                      max_size=None, open_timeout=10, close_timeout=2)
        try:
            await ws.send(json.dumps({"type": "session.start", "session": self.session_config(with_history)}))
            async with asyncio.timeout(10):
                while True:
                    event = json.loads(await ws.recv())
                    if event.get("type") == "session.started":
                        return ws
                    if event.get("type") == "error":
                        raise LiveError(describe_error(event))
        except BaseException:
            await ws.close()
            raise

    async def stream_audio(self, ws):
        """Sends the microphone while you hold Right Option and silence the rest of the time:
        GPT-Live listens to one continuous stream and decides itself when you've finished."""
        silence_start, silence_sent = None, 0
        while self.ws is ws:
            await asyncio.sleep(0.04)
            chunks = []
            while not self.mic_audio.empty():
                chunks.append(self.mic_audio.get_nowait())
            pcm = b"".join(chunks)
            if pcm or self.sending:
                silence_start = None
            else:
                now = time.monotonic()
                if silence_start is None:
                    silence_start, silence_sent = now, 0
                due = int((now - silence_start) * RATE) - silence_sent
                silence_sent += due
                pcm = bytes(2 * due)
            if pcm:
                try:
                    await ws.send(json.dumps({"type": "session.input_audio.append",
                                              "audio": base64.b64encode(pcm).decode()}))
                except websockets.ConnectionClosed:
                    break

    async def read(self, ws):
        try:
            async for raw in ws:
                try:
                    self.on_event(json.loads(raw))
                except Exception as e:  # one odd event shouldn't end the conversation
                    self.say_line(f"   ✗ couldn't handle a GPT-Live event: {e!r}")
        except websockets.ConnectionClosed:
            pass
        finally:
            if self.ws is ws:
                self.session_over()

    def on_event(self, event: dict):
        kind = event.get("type")
        if kind == "session.output_audio.delta":
            pcm = base64.b64decode(event["delta"])
            if self.speaker and not self.listening:
                self.speaker.play(pcm)
            if has_sound(pcm):
                self.last_activity = time.time()
        elif kind == "session.input_transcript.delta":
            self.transcript("user", event.get("delta", ""))
            self.last_heard = time.time()
        elif kind == "session.output_transcript.delta":
            self.transcript("assistant", event.get("delta", ""))
        elif kind == "session.delegation.created":
            self.spawn(self.on_delegation(event["delegation"]["id"]))
        elif kind in ("session.usage.updated", "session.closed"):
            self.usage = (event.get("usage") or {}).get("seconds", self.usage)
            if kind == "session.closed":
                self.close_reason = event.get("reason")
                self.closed.set()
        elif kind == "error":
            self.say_line(f"   ✗ GPT-Live: {describe_error(event)}")

    def transcript(self, role: str, text: str):
        if not text:
            return
        now = time.time()
        if not self.turns or self.turns[-1][0] != role or (role == "user" and self.new_user_turn):
            self.turns.append([role, ""])
            self.end_line()
            if role == "user":
                self.new_user_turn = False
        elif now - self.last_fragment > 1 and not text[0].isspace() and not self.turns[-1][1][-1:].isspace():
            text = " " + text  # a new sentence after a pause comes without its space
        self.last_fragment = now
        self.turns[-1][1] += text
        if self.line != role:
            self.end_line()
            print("🗣  " if role == "user" else "🔊 ", end="")
            self.line = role
        print(text, end="", flush=True)
        self.last_activity = time.time()

    async def send(self, event: dict) -> bool:
        if not self.ws:
            return False
        self.event_seq += 1
        event["event_id"] = f"agent_{self.event_seq}"
        try:
            await self.ws.send(json.dumps(event))
            return True
        except websockets.ConnectionClosed:
            return False

    async def commentary(self, delegation_id: str, content: str) -> bool:
        """Something for GPT-Live to tell you, in its own words."""
        return await self.send({"type": "session.commentary.append", "delegation_id": delegation_id,
                                "content": content[:MAX_APPEND]})

    def thinking(self, content: str, delegation_id: str | None = None):
        """Background for GPT-Live, which it uses if you ask but doesn't say on its own."""
        if self.ws:
            self.spawn(self.send({"type": "session.thinking.append",
                                             "delegation_id": delegation_id or self.delegation,
                                             "content": content[-MAX_APPEND:]}))

    async def close_session(self):
        ws = self.ws
        if not ws or self.closing:
            return
        self.closing = True
        try:
            await ws.send(json.dumps({"type": "session.close"}))
            await asyncio.wait_for(self.closed.wait(), 2)  # its final usage comes with session.closed
        except (websockets.ConnectionClosed, asyncio.TimeoutError):
            pass
        await ws.close()

    def session_over(self):
        self.ws, self.closing = None, False
        if self.speaker:
            self.speaker.close()
            self.speaker = None
        self.delegation = None  # a running task's result is read out by the Mac's own voice instead
        why = {"expired": ", it reached GPT-Live's time limit", "content": ", GPT-Live's safety filter ended it",
               "connection_lost": ", the connection dropped"}.get(self.close_reason or "", "")
        self.say_line(f"   (conversation closed{why}: {self.usage:.0f} s, about "
                      f"${self.usage / 60 * PRICE_PER_MINUTE:.2f}. Hold Right Option to talk again.)")
        if self.listening and not self.connecting:
            self.connecting = self.spawn(self.open_session())
        elif not self.stopping:
            self.spawn(self.reset_audio())  # picks up any audio device that came or went, for next time

    # -- the computer agent --

    async def on_delegation(self, delegation_id: str):
        """GPT-Live decided this needs the computer agent. The event doesn't say what was asked:
        that's in your transcript, which can trail the event a little."""
        async with self.delegation_lock:
            start = self.handed_over
            deadline = time.time() + 3
            while time.time() < deadline:
                if self.request_since(start) and not self.listening and time.time() - self.last_heard > 0.5:
                    break
                await asyncio.sleep(0.1)
            request = self.request_since(start)
            self.handed_over = len(self.turns)
            if is_cancel(request):
                stopped = await self.stop_task() or time.time() - self.stopped_at < 10
                await self.commentary(delegation_id, "The computer agent has stopped." if stopped
                                      else "The computer agent wasn't doing anything.")
            elif not request:
                if self.task_running():
                    self.thinking(f"The computer agent is still working on: {self.task.task}", delegation_id)
                else:
                    await self.commentary(delegation_id, "The computer agent didn't catch the request. "
                                                         "Ask the user to say it again.")
            else:
                previous = self.task.task if self.task_running() else None
                if previous:
                    await self.stop_task(quiet=True)
                    self.say_line("   (interrupted the previous task)")
                self.start_task(request, previous, self.conversation(before=start), delegation_id)

    def request_since(self, start: int) -> str:
        return " ".join(clean(text) for role, text in self.turns[start:] if role == "user").strip()

    def conversation(self, before: int) -> str:
        return "\n".join(f"{'User' if role == 'user' else 'Assistant'}: {clean(text)}"
                         for role, text in self.turns[max(0, before - 10):before] if clean(text))

    def start_task(self, request: str, previous: str | None, conversation: str, delegation_id: str):
        self.task_seq += 1
        seq = self.task_seq
        self.delegation = delegation_id
        self.progress, self.paused_since, self.pause_announced = [], 0.0, False
        self.say_line(f"🧠 computer agent: {request}")
        self.task = CodexTask(request, previous=previous, conversation=conversation,
                              on_event=lambda kind, text: self.from_thread(self.on_task_event, seq, kind, text))
        self.task.start()
        try:
            self.mac.engage_after_talk()  # the helper still waits until your hands are off
        except NotAllowed:
            self.say_line("   Double-tap Right Option to hand over the mouse and keyboard.")
        except AgentVHIDError as e:
            self.say_line(f"   ✗ couldn't take control: {e}")

    def on_task_event(self, seq: int, kind: str, text: str):
        if seq != self.task_seq:
            return  # from a task that was stopped or replaced
        if kind == "action":
            self.say_line(f"   → {text}")
            self.progress.append(text)
        elif kind == "error":
            self.say_line(f"   ✗ {text}")
            self.progress.append(f"error: {text}")
        elif kind == "say":
            self.say_line(f"   💬 {text}")
        elif kind in ("done", "failed"):
            self.task = None
            self.last_activity = time.time()
            self.hand_back()
            if kind == "done":
                self.say_line("✅ done")
                self.spawn(self.report(f"The computer agent finished. Its report: {text}", text))
            else:
                self.say_line(f"❌ {text}")
                self.spawn(self.report(f"The computer agent couldn't finish ({text[:200]}).",
                                                  "Sorry, that didn't work."))

    async def report(self, content: str, fallback: str):
        """GPT-Live says it in its own words; with no conversation open, the Mac's voice reads it."""
        if self.delegation and await self.commentary(self.delegation, content):
            return
        notify(spoken(fallback), "Done")
        subprocess.Popen(["say", spoken(fallback)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    def task_running(self) -> bool:
        return bool(self.task and self.task.running)

    async def stop_task(self, quiet: bool = False) -> bool:
        task = self.task
        if not (task and task.running):
            return False
        self.task, self.task_seq = None, self.task_seq + 1
        await self.loop.run_in_executor(None, task.stop)
        self.stopped_at = time.time()
        self.hand_back()
        if not quiet:
            self.say_line("⏹  stopped")
        return True

    def hand_back(self):
        try:
            self.mac.disengage()
            self.mac.release_all()
        except AgentVHIDError:
            pass

    def check_for_stop(self, now: float):
        """"Stop" stops the computer agent right away, whether or not GPT-Live hands it over."""
        if self.listening or now - self.last_heard < 0.6 or self.checked_for_stop >= len(self.turns):
            return
        said = self.request_since(self.checked_for_stop)
        self.checked_for_stop = len(self.turns)
        if self.task_running() and is_cancel(said):
            self.spawn(self.stop_task())

    # -- the main loop --

    async def run(self):
        await self.open_audio()
        threading.Thread(target=self.watch_helper, daemon=True).start()
        print("Ready. Hold Right Option and talk. Ctrl-C to quit.\n", flush=True)
        started = time.time()
        while True:
            await asyncio.sleep(0.25)
            now = time.time()
            if not AUDIO_OFF and not self.mic_alive and not self.warned_about_mic and now - started > 2:
                self.warned_about_mic = True
                self.say_line(MIC_SILENT)
            if self.mic.stalled:
                await self.reset_audio()
            if self.paused_since and not self.pause_announced and not self.listening \
                    and now - self.paused_since > 1.0 and self.task_running():
                self.pause_announced = True  # after a moment, so holding Right Option to talk doesn't print it
                self.say_line("⏸  you have control. Double-tap Right Option to let it continue, or hold it to "
                              "say something new.")
                self.thinking("The user took over the mouse and keyboard, so the agent is paused until they "
                              "double-tap Right Option.")
            if self.progress and self.delegation and now - self.last_progress > 3:
                self.last_progress = now
                self.thinking("Computer agent progress: " + "; ".join(self.progress))
                self.progress = []
            self.check_for_stop(now)
            if self.ws and not self.listening and not self.sending and not self.task_running() \
                    and not (self.speaker and self.speaker.playing) and now - self.last_activity > IDLE_SECONDS:
                await self.close_session()

    async def shutdown(self):
        self.stopping = True
        await self.stop_task(quiet=True)
        self.hand_back()
        self.mic.close()
        await self.close_session()


async def run_until_stopped() -> int:
    agent = LiveAgent()
    main_task = asyncio.current_task()

    def stop():  # Ctrl-C reaches us and ./voice.sh, which then sends SIGTERM: the first one counts
        if not agent.stopping:
            agent.stopping = True
            main_task.cancel()

    for sig in (signal.SIGINT, signal.SIGTERM):
        agent.loop.add_signal_handler(sig, stop)
    try:
        await agent.run()
    except asyncio.CancelledError:
        pass
    finally:
        await agent.shutdown()
    return 0


def main(argv: list[str]) -> int:
    if "-h" in argv or "--help" in argv:
        print(__doc__)
        return 0
    settings.fix_newlines()
    if not os.environ.get("OPENAI_API_KEY"):
        print("Put your OpenAI API key in .env (OPENAI_API_KEY=...), or run ./voice.sh --superwhisper.")
        return 1
    find_codex()
    if not wait_for_helper(AgentVHID()):
        return 1
    key_from = ".env" if "OPENAI_API_KEY" in settings.from_file else "your shell environment"
    print(f"Voice: {MODEL} ({VOICE}), OpenAI key from {key_from}. Computer agent: {describe_model()}.", flush=True)
    return asyncio.run(run_until_stopped())


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
