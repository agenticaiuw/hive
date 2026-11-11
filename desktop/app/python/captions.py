"""Captions on the screen: what the agent is saying, and under that what it's doing right now; while
it's listening or you're dictating, a line saying so on top, with what you're saying under it.
build/agent-vhid-captions (tools/captions.swift) draws them at the bottom of the screen, over every
app; clicks go through them and the agent's screenshots leave them out.

    CAPTIONS=0   no captions
"""

from __future__ import annotations

import json
import os
import subprocess
import threading

HERE = os.path.dirname(os.path.abspath(__file__))
OVERLAY = os.path.join(os.path.dirname(HERE), "build", "agent-vhid-captions")


class Captions:
    """Does nothing when show is False, the overlay isn't built (make), or CAPTIONS=0."""

    def __init__(self, show: bool = True, on_input=None):
        self._proc: subprocess.Popen | None = None
        self._lock = threading.Lock()
        if show and os.environ.get("CAPTIONS", "1") != "0" and os.path.exists(OVERLAY):
            self._proc = subprocess.Popen([OVERLAY], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                          stderr=subprocess.DEVNULL, text=True)
            self.on_input = on_input or (lambda text: None)
            self.on_control = lambda kind, value=None: None  # the overlay's mute and close buttons
            threading.Thread(target=self._read, args=(self._proc,), daemon=True).start()

    def _read(self, proc):
        for line in proc.stdout:
            try:
                message = json.loads(line)
                value = message.get('text')
                if isinstance(value, str) and value.strip(): self.on_input(value.strip())
                if isinstance(message.get('mute'), bool): self.on_control('mute', message['mute'])
                if message.get('close') is True: self.on_control('close')
            except (ValueError, AttributeError):
                continue

    def listening(self, on: bool):
        """The "Listening · tap fn to turn the mic off" line on top, while it listens."""
        self._send(listening=on)

    def dictating(self, on: bool):
        """The "Dictating · let go of fn to type it" line on top instead, while you hold fn."""
        self._send(dictating=on)

    def camera(self, state: str):
        """The camera line on top in lip reading mode: "starting", "waiting" (for macOS's
        permission), "on" (it is recording), or "off" (none)."""
        self._send(camera=state)

    def dismiss(self):
        self._send(dismiss=True)

    def framing(self, text: str):
        self._send(framing=text)

    def preview(self, jpeg: str):
        self._send(preview=jpeg)

    def hearing(self, words: str):
        """What you're saying, as you say it; it fades a little after you stop."""
        self._send(hearing=words)

    def say(self, words: str):
        """The words it's saying now; they fade once there's been time to read them."""
        self._send(say=words)

    def doing(self, text: str):
        """The small line under the words, e.g. 'Typing “weather”'; '' removes it."""
        self._send(doing=text)

    def thinking(self, text: str):
        """Public progress or reasoning summary, shown while the task runs."""
        self._send(thinking=text)

    def agent_request(self, text: str):
        """A request another program sent (not your words), in its own row; '' removes it."""
        self._send(agent_request=text)

    def paused(self, text: str):
        """Why the agent is paused and how to let it go on (press fn); '' removes it."""
        self._send(paused=text)

    def muted(self, on: bool):
        self._send(muted=on)

    def activity(self, text: str):
        self._send(activity=text)

    def active(self, on: bool):
        self._send(active=on)

    def clear(self):
        self._send(clear=True)

    def close(self):
        with self._lock:
            if self._proc:
                try:
                    self._proc.stdin.close()  # the overlay quits when its input ends
                    self._proc.wait(2)
                except (OSError, subprocess.TimeoutExpired):
                    self._proc.kill()
                    self._proc.wait()
                if self._proc.stdout: self._proc.stdout.close()
                self._proc = None

    def _send(self, **message):
        with self._lock:
            if self._proc and self._proc.poll() is None:
                try:
                    self._proc.stdin.write(json.dumps(message) + "\n")
                    self._proc.stdin.flush()
                except OSError:
                    self._proc = None
