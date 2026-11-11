"""Private local request channel for the already-running personal agent."""
import json
import os
import queue
import socket
import stat
import subprocess
import threading
import time
from pathlib import Path

MAX_REQUEST_BYTES = 16384


class _PythonLocalRequests:
    def __init__(self, directory: Path, events):
        self.directory, self.events = directory, events
        self.path = directory / "request.sock"
        self.sock = None
        self.identity = None
        self.stop_event = threading.Event()

    def start(self):
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(self.directory, 0o700)
        try:
            info = self.path.lstat()
        except FileNotFoundError:
            info = None
        if info is not None:
            if not stat.S_ISSOCK(info.st_mode) or info.st_uid != os.getuid():
                raise RuntimeError("Refusing to replace an unexpected request socket path")
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as probe:
                probe.settimeout(0.5)
                try:
                    probe.connect(str(self.path))
                except (ConnectionRefusedError, FileNotFoundError):
                    self.path.unlink(missing_ok=True)
                else:
                    raise RuntimeError("Another personal-agent request channel is active")
        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            server.bind(str(self.path))
            os.chmod(self.path, 0o600)
            server.listen(4)
            server.settimeout(0.5)
        except Exception:
            server.close()
            raise
        self.sock = server
        self.identity = self.path.lstat().st_ino
        threading.Thread(target=self._serve, daemon=True, name="personal-agent-local-requests").start()

    def _serve(self):
        while not self.stop_event.is_set():
            try:
                connection, _ = self.sock.accept()
            except socket.timeout:
                continue
            except OSError:
                break
            threading.Thread(target=self._handle, args=(connection,), daemon=True).start()

    def _handle(self, connection):
        with connection:
            connection.settimeout(5)
            try:
                raw = b""
                while b"\n" not in raw and len(raw) <= MAX_REQUEST_BYTES:
                    chunk = connection.recv(min(4096, MAX_REQUEST_BYTES + 1 - len(raw)))
                    if not chunk:
                        break
                    raw += chunk
                if len(raw) > MAX_REQUEST_BYTES or b"\n" not in raw:
                    raise ValueError("invalid request length")
                request = json.loads(raw.split(b"\n", 1)[0])
                text = request.get("text") if isinstance(request, dict) else None
                if not isinstance(text, str) or not text.strip():
                    raise ValueError("text is required")
                reply = queue.Queue(maxsize=1)
                resume_goal = request.get("resume_goal", False)
                if not isinstance(resume_goal, bool):
                    raise ValueError("resume_goal must be a boolean")
                objective = request.get("goal_objective")
                if objective is not None and (not resume_goal or not isinstance(objective, str) or not objective.strip()):
                    raise ValueError("goal_objective requires a nonempty string and resume_goal")
                payload = (text.strip(), reply, time.monotonic() + 4)
                if resume_goal:
                    payload += (True, objective)
                self.events.put(("local_request", payload))
                result = reply.get(timeout=5)
            except Exception:
                result = {"ok": False, "error": "Request not accepted; check agent availability."}
            try:
                connection.sendall((json.dumps(result) + "\n").encode())
            except OSError:
                pass

    def close(self):
        self.stop_event.set()
        if self.sock:
            self.sock.close()
        try:
            if self.identity is not None and self.path.lstat().st_ino == self.identity:
                self.path.unlink()
        except FileNotFoundError:
            pass


RUST_LOCAL_REQUESTS = Path(__file__).resolve().parent.parent / "build/agent-local-requests"


class _RustLocalRequests:
    """Bridge the Rust socket server to the existing host event queue."""
    def __init__(self, directory, events, workspace_handler=None):
        self.directory, self.events = Path(directory), events
        self.workspace_handler = workspace_handler
        self.path = self.directory / ("workspace.sock" if workspace_handler else "request.sock")
        self.process = None
        self.write_lock = threading.Lock()
        self.reader = None

    def start(self):
        args = [str(RUST_LOCAL_REQUESTS), str(self.directory)]
        if self.workspace_handler:
            args.append("workspace")
        process = subprocess.Popen(args,
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=subprocess.DEVNULL, text=True, encoding="utf-8")
        self.process = process
        try:
            line = process.stdout.readline()
            if not line or json.loads(line).get("type") != "ready":
                raise RuntimeError("Could not start personal-agent request channel")
        except Exception:
            self.close()
            raise
        self.reader = threading.Thread(target=self._read, daemon=True, name="personal-agent-local-bridge")
        self.reader.start()

    def _read(self):
        for line in self.process.stdout:
            try:
                message = json.loads(line)
                if message.get("type") == "request" and not self.workspace_handler:
                    target = self._dispatch
                elif message.get("type") == "workspace_request" and self.workspace_handler:
                    target = self._dispatch_workspace
                else:
                    continue
                threading.Thread(target=target, args=(message,), daemon=True).start()
            except (ValueError, TypeError):
                continue

    def _dispatch_workspace(self, message):
        # Preserve the existing policy handler while Rust owns the public socket.
        client, handler = socket.socketpair()
        try:
            client.settimeout(50)
            threading.Thread(target=self.workspace_handler, args=(handler,), daemon=True).start()
            client.sendall((json.dumps(message["value"], ensure_ascii=False, separators=(",", ":")) + "\n").encode())
            data = bytearray()
            while b"\n" not in data and len(data) <= 64 * 1024 * 1024:
                chunk = client.recv(65536)
                if not chunk:
                    return
                data.extend(chunk)
            if len(data) > 64 * 1024 * 1024 or b"\n" not in data:
                return
            result = json.loads(data.split(b"\n", 1)[0])
            with self.write_lock:
                self.process.stdin.write(json.dumps({"id": message["id"], "result": result}) + "\n")
                self.process.stdin.flush()
        except (OSError, ValueError, TypeError):
            pass
        finally:
            client.close()

    def _dispatch(self, message):
        reply = queue.Queue(maxsize=1)
        payload = (message["text"], reply, time.monotonic() + 4)
        if message.get('receiptId'):
            payload += (message['resume_goal'], message.get('goal_objective'), message['receiptId'])
        elif message['resume_goal']:
            payload += (True, message.get('goal_objective'))
        try:
            self.events.put(("local_request", payload))
            result = reply.get(timeout=5)
            with self.write_lock:
                self.process.stdin.write(json.dumps({"id": message["id"], "result": result}) + "\n")
                self.process.stdin.flush()
        except (OSError, ValueError, queue.Empty):
            pass

    def close(self):
        process = self.process
        if process is None:
            return
        with self.write_lock:
            if process.stdin and not process.stdin.closed:
                process.stdin.close()
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            process.terminate()
            process.wait(timeout=2)
        if self.reader is not None:
            self.reader.join(timeout=2)
        if process.stdout and not process.stdout.closed:
            process.stdout.close()


class LocalRequests(_PythonLocalRequests):
    def __new__(cls, directory, events, *args, **kwargs):
        # WorkspaceRequests subclasses this server and provides its own protocol.
        if cls is LocalRequests and RUST_LOCAL_REQUESTS.is_file() and os.access(RUST_LOCAL_REQUESTS, os.X_OK):
            return _RustLocalRequests(directory, events)
        return super().__new__(cls)

    def start(self):
        if type(self) is LocalRequests:
            raise RuntimeError("Durable local request service is unavailable")
        return super().start()
