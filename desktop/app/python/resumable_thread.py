"""Durable Codex thread identity, adapted from the staged resumable_thread.py.

Only a missing identity starts a thread. Invalid state and failed resumes never
fall back to thread/start. The lock also serializes first creation across processes.
"""
from __future__ import annotations

import ctypes
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile


class ResumeError(RuntimeError):
    pass


def state_dir() -> Path:
    return Path(os.environ.get("AGENT_STATE_DIR") or
                Path.home() / "Library/Application Support/Personal Agent")


RUST_STATE_LIBRARY = Path(__file__).resolve().parent.parent / "build/libagent-core.dylib"
_rust_state_library = None


def _state_library():
    global _rust_state_library
    if not RUST_STATE_LIBRARY.is_file() or not os.access(RUST_STATE_LIBRARY, os.R_OK):
        return None
    if _rust_state_library is None:
        library = ctypes.CDLL(str(RUST_STATE_LIBRARY))
        library.agent_atomic_write.argtypes = [ctypes.c_char_p, ctypes.c_size_t, ctypes.c_char_p, ctypes.c_size_t]
        library.agent_atomic_write.restype = ctypes.c_int
        library.agent_append_synced.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_size_t]
        library.agent_append_synced.restype = ctypes.c_int
        library.agent_recovery_apply.argtypes = [ctypes.c_char_p, ctypes.c_size_t, ctypes.c_char_p, ctypes.c_size_t,
                                                 ctypes.c_void_p, ctypes.c_size_t]
        library.agent_recovery_apply.restype = ctypes.c_int64
        _rust_state_library = library
    return _rust_state_library


def atomic_write(path: Path, text: str):
    library = _state_library()
    if library is not None:
        path_bytes, data = os.fsencode(path), text.encode("utf-8")
        error = library.agent_atomic_write(path_bytes, len(path_bytes), data, len(data))
        if error:
            raise OSError(error, os.strerror(error), str(path))
        return
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


def append_synced(stream, text):
    # An existing stream owns the descriptor; no Rust-owned background work survives it.
    library = _state_library()
    if library is not None:
        data = text.encode("utf-8")
        error = library.agent_append_synced(stream.fileno(), data, len(data))
        if error:
            raise OSError(error, os.strerror(error))
        return
    stream.write(text)
    stream.flush()
    os.fsync(stream.fileno())


RUST_IDENTITY = Path(__file__).resolve().parent.parent / "build/agent-thread-identity"


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
        if RUST_IDENTITY.is_file() and os.access(RUST_IDENTITY, os.X_OK):
            return self._connect_rust(server, params, observe)
        return self._connect_python(server, params, observe)

    def _connect_rust(self, server, params, observe):
        # The helper holds the cross-process lock through the request and commit.
        # A helper failure never falls back to another start attempt.
        process = subprocess.Popen([str(RUST_IDENTITY)], stdin=subprocess.PIPE,
                                   stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                   text=True, encoding="utf-8")
        method = None
        result = None
        try:
            def send(value):
                process.stdin.write(json.dumps(value, ensure_ascii=True) + "\n")
                process.stdin.flush()
            send({"path": str(self.path), "params": params, "expected": self.thread_id})
            while True:
                line = process.stdout.readline()
                if not line:
                    raise ResumeError("Thread identity helper stopped unexpectedly; conversation was not replaced")
                message = json.loads(line)
                if message.get("type") == "request":
                    method, options = message["method"], message["params"]
                    if method == "thread/resume":
                        self.thread_id = self.validate(options.get("threadId"))
                    try:
                        if observe:
                            observe(method + " input", options)
                        result = server.request(method, options)
                        send({"result": result})
                    except Exception as error:
                        send({"error": str(error)})
                elif message.get("type") == "error":
                    if message.get("io") is True and method is None:
                        raise OSError(message.get("error", "Thread identity helper failed"))
                    raise ResumeError(message.get("error", "Thread identity helper failed"))
                elif message.get("type") == "result":
                    identity = self.validate(message.get("id"))
                    self.thread_id = identity
                    if observe:
                        observe(method + " output", result)
                    return identity
                else:
                    raise ResumeError("Invalid response from thread identity helper")
        except Exception as error:
            if observe and method:
                observe(method + " error", {"error": str(error), "savedThreadId": self.thread_id})
            if method is None and isinstance(error, OSError):
                raise
            raise ResumeError(f"{error}; saved state: {self.path}") from error
        finally:
            if process.poll() is None:
                process.terminate()
            process.communicate()

    def _connect_python(self, server, params, observe=None):
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
                # Preserve the conversation and its saved dynamic tools while applying current
                # authentication/consent rules. This server supports instruction overrides on resume.
                for key in ("baseInstructions", "developerInstructions", "cwd", "sandbox", "permissions", "approvalPolicy",
                            "config"):  # config: the shell's network access
                    if key in params:
                        options[key] = params[key]
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
