"""Local FLARE Large lip reading with live, replaceable caption drafts.

Tap fn to open the camera; tap again to submit the final transcript. Capture and
inference run concurrently in a persistent worker. Drafts never trigger agent actions.
Set LIPREAD_DIR to override the installation directory and LIPREAD_DEVICE to choose
mps or cpu. The model is a full-context recognizer used on rolling windows, not a
causal streaming model; latency and accuracy depend on the Mac and video conditions.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
from pathlib import Path

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from resumable_thread import atomic_write, state_dir  # noqa: E402

WORKER = os.path.join(os.path.dirname(HERE), "scripts", "lipread_worker.py")
MODES = ("voice", "lips")



def home() -> Path:
    return Path(os.environ.get("LIPREAD_DIR") or state_dir() / "lipread")


def get_mode() -> str:
    try:
        mode = (state_dir() / "input-mode").read_text().strip()
    except OSError:
        return "voice"
    return mode if mode in MODES else "voice"


def set_mode(mode: str) -> str:
    if mode not in MODES:
        raise ValueError(f"input is one of {', '.join(MODES)}")
    atomic_write(state_dir() / "input-mode", mode)
    return mode


def available() -> tuple[bool, str]:
    """Whether lip reading is set up, and if not, what's missing."""
    base = home()
    runtime = base / "flare"
    required = (runtime / ".venv/bin/python", runtime / "large.pt", runtime / "flare/hubert_asr.py")
    if not all(path.exists() for path in required):
        return False, "FLARE isn't set up: run scripts/setup-lipread.sh"
    return True, "FLARE Large (2026), local live captions"



class LipReaderError(Exception):
    pass


class LipReader:
    """A persistent FLARE worker that loads the model once and transcribes camera frames
    between start() and stop(). on_event(dict) gets drafts and camera/model status
    ({"camera": "on"|"off"}, {"ready": true}, {"error": ...})."""

    def __init__(self, command: list[str] | None = None, cwd: str | None = None, on_event=None):
        base = home()
        self.command = command or [str(base / "flare/.venv/bin/python"), WORKER]
        self.cwd = cwd or str(base / "flare")
        self.on_event = on_event or (lambda event: None)
        self.proc: subprocess.Popen | None = None
        self.recording = False
        self._finishing = False
        self.session = 0
        self._result: dict | None = None
        self._got = threading.Event()
        self._lock = threading.Lock()

    def open(self):
        if self.proc and self.proc.poll() is None:
            return
        log = open(os.path.expanduser("~/Library/Logs/agent-lipread.log"), "a")  # the worker's errors, for diagnosis
        self.proc = subprocess.Popen(self.command, cwd=self.cwd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=log, text=True, start_new_session=True)
        log.close()
        threading.Thread(target=self._read, daemon=True).start()

    def start(self):
        """Camera on."""
        if self._finishing:
            raise LipReaderError("Still finishing your previous phrase")
        self.open()
        with self._lock:
            self.session += 1
            self._result, self.recording = None, True
            self._got.clear()
        self._send("start")

    def stop(self, timeout: float = 60) -> str:
        """Camera off; what was read (may be ''). Raises LipReaderError if it couldn't read it."""
        if not self.recording:
            return ""
        self.recording = False
        self._finishing = True
        try:
            self._send("stop")
            completed = self._got.wait(timeout)
        finally:
            self._finishing = False
        if not completed:
            raise LipReaderError(f"no answer from the lip reader in {timeout:.0f} s")
        result = self._result or {}
        if result.get("error"):
            raise LipReaderError(result["error"])
        return (result.get("text") or "").strip()

    def close(self):
        if self.proc and self.proc.poll() is None:
            try:
                self.proc.stdin.close()  # the worker turns the camera off and quits
                self.proc.wait(3)
            except (OSError, subprocess.TimeoutExpired):
                self.proc.kill()
                self.proc.wait()
        if self.proc and self.proc.stdin and not self.proc.stdin.closed:
            self.proc.stdin.close()
        if self.proc and self.proc.stdout:
            self.proc.stdout.close()
        self.proc, self.recording = None, False

    def _send(self, line: str):
        try:
            self.proc.stdin.write(json.dumps({"command": line, "session": self.session}) + "\n")
            self.proc.stdin.flush()
        except (OSError, AttributeError) as e:
            self.recording = False
            raise LipReaderError(f"the lip reader isn't running ({e})") from e

    def _read(self):
        proc = self.proc
        for line in proc.stdout:
            try:
                event = json.loads(line)
            except ValueError:
                continue
            if proc is not self.proc or event.get("session", self.session) != self.session:
                continue
            if event.get("final", True) and ("text" in event or "error" in event):
                self._result = event
                self._got.set()
            self.on_event(event)
        if proc is not self.proc:
            return
        if not self._got.is_set():
            self._result = {"error": f"the lip reader stopped (exit {proc.wait()})"}
            self._got.set()
        self.on_event({"camera": "off"})
