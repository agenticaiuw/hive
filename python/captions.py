"""Captions on the screen: what the agent is saying, and under that what it's doing right now.
build/agent-vhid-captions (tools/captions.swift) draws them at the bottom of the screen, over
every app; clicks go through them and the agent's screenshots leave them out.

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

    def __init__(self, show: bool = True):
        self._proc: subprocess.Popen | None = None
        self._lock = threading.Lock()
        if show and os.environ.get("CAPTIONS", "1") != "0" and os.path.exists(OVERLAY):
            self._proc = subprocess.Popen([OVERLAY], stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,
                                          stderr=subprocess.DEVNULL, text=True)

    def say(self, words: str):
        """The words it's saying now; they fade once there's been time to read them."""
        self._send(say=words)

    def doing(self, text: str):
        """The small line under the words, e.g. 'Typing “weather”'; '' removes it."""
        self._send(doing=text)

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
                self._proc = None

    def _send(self, **message):
        with self._lock:
            if self._proc and self._proc.poll() is None:
                try:
                    self._proc.stdin.write(json.dumps(message) + "\n")
                    self._proc.stdin.flush()
                except OSError:
                    self._proc = None
