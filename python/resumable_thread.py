"""Durable Codex thread identity, adapted from the staged resumable_thread.py.

Only a missing identity starts a thread. Invalid state and failed resumes never
fall back to thread/start. The lock also serializes first creation across processes.
"""
from __future__ import annotations

import fcntl
import os
from pathlib import Path
import re
import tempfile


class ResumeError(RuntimeError):
    pass


def state_dir() -> Path:
    return Path(os.environ.get("AGENT_STATE_DIR") or
                Path.home() / "Library/Application Support/Personal Agent")


def atomic_write(path: Path, text: str):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temporary = tempfile.mkstemp(dir=path.parent, prefix=".pending-")
    # On failure retain the temporary file for diagnosis, never remove user data.
    with os.fdopen(fd, "w", encoding="utf-8") as stream:
        stream.write(text)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)
    directory = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


class ResumableThread:
    def __init__(self, path):
        self.path = Path(path)
        self.thread_id = None

    @staticmethod
    def validate(value):
        if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,200}", value):
            raise ResumeError("Invalid saved or returned thread ID; refusing to replace the conversation")
        return value

    def connect(self, server, params, observe=None):
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        fd = os.open(str(self.path) + ".lock", os.O_CREAT | os.O_RDWR, 0o600)
        with os.fdopen(fd, "w") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            try:
                saved = self.path.read_text(encoding="utf-8").strip()
            except FileNotFoundError:
                saved = None
            except UnicodeError as error:
                raise ResumeError(f"Invalid saved thread state at {self.path}; refusing to replace the conversation") from error
            if self.thread_id is not None and saved != self.thread_id:
                raise ResumeError(f"Saved thread identity changed or disappeared at {self.path}; "
                                  "refusing to replace the conversation")
            if saved is not None:
                try:
                    self.thread_id = self.validate(saved)
                except ResumeError as error:
                    raise ResumeError(f"{error}; saved state: {self.path}") from error
                method, options = "thread/resume", {"threadId": self.thread_id}
            else:
                # A crash/timeout during creation is ambiguous. Block another start
                # even after a process restart instead of silently losing that thread.
                atomic_write(self.path, "!thread-start-pending\n")
                method, options = "thread/start", dict(params, ephemeral=False)
            try:
                if observe:
                    observe(method + " input", options)
                result = server.request(method, options)
                identity = self.validate(result.get("thread", {}).get("id"))
                if saved is not None and identity != saved:
                    raise ResumeError("Resumed thread ID mismatch")
                if result["thread"].get("ephemeral") is True:
                    raise ResumeError("Server returned an ephemeral thread")
                if saved is None:
                    atomic_write(self.path, identity + "\n")
                self.thread_id = identity
                if observe:
                    observe(method + " output", result)
                return identity
            except Exception as error:
                if observe:
                    observe(method + " error", {"error": str(error), "savedThreadId": self.thread_id})
                raise ResumeError(f"{method} failed: {error}. Conversation was not replaced; "
                                  f"saved state: {self.path}") from error
