"""Give Agent one persistent SpaceO MCP session, preserving it across short restarts.

The upstream controller retains the lease and renews it. Startup claims the existing
workspace first; it creates one only when the daemon explicitly says it does not exist.
All other failures are surfaced and are never followed by a replacement session.
"""
import json
import os
import re
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from local_request import LocalRequests, MAX_REQUEST_BYTES, RUST_LOCAL_REQUESTS, _RustLocalRequests
from resumable_thread import atomic_write, state_dir
import workspace_fence

WORKSPACE = "personal-agent-workspace"
INTERNAL_PREFIX = "agent-workspace-internal-"
ALLOWED_TOOLS = frozenset({
    "spaceo_session_list", "spaceo_open_app", "spaceo_open_url", "spaceo_wait_for",
    "spaceo_find", "spaceo_read_text", "spaceo_read_screen", "spaceo_list_targets",
    "spaceo_attach_target", "spaceo_screenshot", "spaceo_click", "spaceo_scroll",
    "spaceo_select_text", "spaceo_move", "spaceo_drag", "spaceo_type", "spaceo_press_key",
    "spaceo_list_windows", "spaceo_events", "workspace_authenticate_passwords",
})

# The user permits workspace interaction despite incomplete isolation coverage.
# A click or key can have irreversible effects: the agent must still avoid
# sending, submitting, purchasing, publishing, and other irreversible actions.
WORKSPACE_ACTIONS = frozenset({
    "spaceo_open_app", "spaceo_click", "spaceo_scroll", "spaceo_select_text",
    "spaceo_move", "spaceo_drag", "spaceo_type", "spaceo_press_key",
})


CAPABILITY_BASE = ("Shell: personal-agent profile configured in workspace mode; effective file/OS grants unverified. "
                   "Launcher: separate app instance requested; managed Chromium uses a private profile, "
                   "not the user's signed-in session. Safari/Passwords sharing unverified.")
ISOLATION_DIMENSIONS = ("menu_bar_owner", "window_server_front_process", "key_input_route",
                        "text_input_route", "cursor_location", "active_space")

def prefer_safari():
    """A local user preference, not a default for other installations."""
    try:
        return (state_dir() / "browser-preference").read_text().strip().lower() == "safari"
    except OSError:
        return False

def passwords_target(engine):
    """Resolve only a single Passwords window owned by this workspace, without reading secrets."""
    result = subprocess.run([engine, "session", "list", "--operator", "--json"],
                            capture_output=True, text=True, timeout=5, check=True)
    data = json.loads(result.stdout)
    if data.get("ok") is not True:
        raise ValueError("The workspace session could not be inspected.")
    sessions = [s for s in data.get("sessions", []) if s.get("id") == WORKSPACE and s.get("runtimeAttached") is True]
    if len(sessions) != 1:
        raise ValueError("The workspace session is unavailable or ambiguous.")
    session = sessions[0]
    if session.get("inputPaused") is not False:
        raise ValueError("Workspace input is paused; authentication was not attempted.")
    apps = [a for a in session.get("apps", []) if a.get("bundleID") == "com.apple.Passwords"
            and isinstance(a.get("pid"), int) and a["pid"] > 0]
    if len(apps) != 1:
        raise ValueError("Open one Passwords app in the workspace first.")
    pid = apps[0]["pid"]
    windows = [w for w in session.get("windows", []) if w.get("pid") == pid and w.get("onStage") is True
               and isinstance(w.get("windowID"), int) and w["windowID"] > 0]
    if len(windows) != 1:
        raise ValueError("The workspace Passwords window is unavailable or ambiguous.")
    return pid, windows[0]["windowID"]

def capability_report(result=None):
    """Summarize only recognized verification evidence; never infer missing checks."""
    if not result or result.get("isError"):
        return CAPABILITY_BASE + " Isolation: unverified (no successful current audit)."
    text = Bridge.description(result)
    match = re.search(r"\bisolation:\s*(intact|partial|breached)\b", text, re.I)
    verdict = match.group(1).lower() if match else "unverified"
    rows = []
    for dimension in ISOLATION_DIMENSIONS:
        found = re.search(r"(?m)^\s*-\s*" + dimension +
                          r":\s*(passed|failed|unknown)\s*\[(observed|inferred|unknown)\]", text, re.I)
        rows.append(dimension + "=" + (found.group(1).lower() + "/" + found.group(2).lower() if found else "unreported"))
    return CAPABILITY_BASE + " Latest isolation audit: " + verdict + "; " + ", ".join(rows) + ". Missing or inferred evidence is not proof."


class EnvironmentObservations:
    """Only allowlisted metadata; never persist tool output, arguments, or exception text."""
    def __init__(self):
        self.lock = threading.Lock()
        self.display = None
        self.isolation = None
        self.errors = []
        self.session_observation = None
        self.session_refresh = "not attempted"

    def display_seen(self, display):
        with self.lock:
            self.display = str(display) if str(display).isdigit() else None

    def refresh_session(self, call):
        """Read only our owned session listing; retain strictly bounded metadata."""
        try:
            result = call("spaceo_session_list", {})
            if not isinstance(result, dict) or result.get("isError"):
                raise ValueError("listing unavailable")
            text = Bridge.description(result)
            # A block starts at a non-indented session header; never parse other sessions.
            blocks = re.split(r"(?m)(?=^(?:\[yours\] )?session ')", text)
            matches = [b for b in blocks if re.match(
                r"^\[yours\] session '" + re.escape(WORKSPACE) + r"' on whole display \d+[,\n]", b)]
            if len(matches) != 1:
                raise ValueError("missing or ambiguous owned session")
            block = matches[0]
            display = re.match(r"^\[yours\] session '[^']+' on whole display (\d+)", block).group(1)
            lines = re.findall(r"(?m)^  input: ([^\n]*)$", block)
            if len(lines) > 1:
                raise ValueError("ambiguous input state")
            state, reason = "unknown", "not reported"
            if lines:
                if re.fullmatch(r"PAUSED(?: \([^\n]*\))?", lines[0]):
                    state = "paused"
                    if lines[0] == "PAUSED (operator has Control)":
                        reason = "operator control reported by workspace; cause not established"
                    elif lines[0].startswith("PAUSED (agent: "):
                        reason = "agent reason reported; free text withheld for privacy"
                elif lines[0] in ("UNPAUSED", "ACTIVE"):
                    state = "unpaused"
                else:
                    raise ValueError("unrecognized input state")
            observation = {"display": display, "input_state": state, "reason": reason,
                           "observed_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                           "monotonic": time.monotonic()}
            with self.lock:
                self.session_observation, self.session_refresh = observation, "observed"
        except Exception:
            with self.lock:
                self.session_refresh = "failed or malformed; last observation is stale"

    def record(self, name, result=None, failed=False):
        stamp = datetime.now(timezone.utc).isoformat(timespec="seconds")
        with self.lock:
            if name == "spaceo_verify_isolation":
                self.isolation = (stamp, capability_report(result)) if result and not result.get("isError") else None
            if failed or (isinstance(result, dict) and result.get("isError")):
                self.errors = (self.errors + [{"tool": name if name in ALLOWED_TOOLS else "workspace request", "at": stamp}])[-5:]

    def report(self):
        with self.lock:
            display, audit, errors = self.display, self.isolation, list(self.errors)
            current = dict(self.session_observation) if self.session_observation else None
            refresh = self.session_refresh
        fresh = bool(current and refresh == "observed" and time.monotonic() - current["monotonic"] <= 30)
        current_view = {"status": "observed" if fresh else ("stale" if current else "unavailable"),
                        "display": current["display"] if current else None,
                        "input_state": current["input_state"] if current else "unknown",
                        "reason": current["reason"] if current else "not reported",
                        "observed_at": current["observed_at"] if current else None, "refresh": refresh}
        return {
            "workspace": {"configured_session": WORKSPACE,
                          "observed_display_at_last_bootstrap": display or "unknown",
                          "current_session_and_display": current_view,
                          "user_holds_control": ("reported by workspace; cause not established" if fresh and current["reason"].startswith("operator control reported") else "unknown; follow any live pause/control response")},
            "model_permissions": {"configured_when_spaceo_enabled": "personal-agent extends workspace; writable memory, captures and update-handoff roots and workspace socket; network proxy enabled, registry.npmjs.org allowed",
                                  "effective_file_network_and_os_permissions": "unknown; runtime and OS restrictions may further limit access"},
            "browser": "Managed Chromium launcher configures a separate private profile; exact app/session sharing and Safari/Passwords are unverified.",
            "isolation": {"last_audit": audit[1] if audit else "unknown; no successful cached audit",
                          "observed_at": audit[0] if audit else None,
                          "keyboard_text_routes": "unknown unless explicitly reported in the audit; inferred or stale evidence is not proof"},
            "supported_workspace_tools_allowlist": sorted(ALLOWED_TOOLS),
            "recent_failures": errors,
            "failure_details": "Only tool names and times retained; inspect the immediate tool response for details.",
        }


class WorkspaceRequests(LocalRequests):
    """Use the existing MCP owner's lease; never create a competing workspace."""
    def __init__(self, directory, bridge, on_activity=None):
        super().__init__(directory, None)
        self.path = directory / "workspace.sock"
        self.bridge = bridge
        self.on_activity = on_activity

    def start(self):
        if RUST_LOCAL_REQUESTS.is_file() and os.access(RUST_LOCAL_REQUESTS, os.X_OK):
            self._rust_server = _RustLocalRequests(self.directory, None, self._handle)
            self._rust_server.start()
        else:
            self._rust_server = None
            super().start()

    def close(self):
        if getattr(self, "_rust_server", None) is not None:
            self._rust_server.close()
        else:
            super().close()

    def call_with_transient_health_retry(self, name, arguments):
        # Only the daemon's preflight receipt proves this request was not dispatched.
        # Do not retry timeouts, generic health errors, or post-dispatch failures.
        deadline = time.monotonic() + 30
        while True:
            result = self.bridge.call(name, arguments)
            text = Bridge.description(result)
            retryable = result.get("isError") and re.match(
                r"^\[display_creation_failed\] could not create the agent display: "
                r"pre_dispatch_transient_host_health: host health refused: "
                r"(?:memory_pressure|swap_activity); ", text)
            if not retryable or time.monotonic() >= deadline:
                return result
            if self.on_activity:
                self.on_activity("data", "Workspace resources are recovering; waiting to retry the rejected action.")
            time.sleep(1)

    def _handle(self, connection):
        with connection:
            connection.settimeout(50)
            try:
                raw = b""
                while b"\n" not in raw and len(raw) <= MAX_REQUEST_BYTES:
                    chunk = connection.recv(min(4096, MAX_REQUEST_BYTES + 1 - len(raw)))
                    if not chunk:
                        break
                    raw += chunk
                if len(raw) > MAX_REQUEST_BYTES or b"\n" not in raw:
                    raise ValueError("invalid request length")
                value = json.loads(raw.split(b"\n", 1)[0])
                if not isinstance(value, dict):
                    raise ValueError("request must be an object")
                if value.get("method") == "status":
                    self.bridge.observations.refresh_session(self.bridge.call)
                    result = {"content": [{"type": "text", "text": json.dumps(self.bridge.observations.report())}]}
                    if self.on_activity:
                        report = self.bridge.observations.report()
                        current = report["workspace"]["current_session_and_display"]
                        self.on_activity("data", "Workspace: " + current["status"] + "; display " + str(current["display"] or "unknown") + "; input " + current["input_state"] + "; " + current["reason"] + ". Keyboard isolation and Safari sharing unverified.")
                elif value.get("method") == "list":
                    result = self.bridge.request("tools/list", {})
                    result["tools"] = [t for t in result.get("tools", []) if t.get("name") in ALLOWED_TOOLS
                                       and not (prefer_safari() and t.get("name") == "spaceo_open_url")]
                    result["tools"].append({"name": "workspace_authenticate_passwords",
                        "description": "Unlock the workspace Passwords app using the locally saved Mac credential, without exposing it. Takes no arguments.",
                        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False}})
                else:
                    name, arguments = value.get("name"), value.get("arguments", {})
                    if name not in ALLOWED_TOOLS or not isinstance(arguments, dict):
                        raise ValueError("tool is not available")
                    if name == "workspace_authenticate_passwords":
                        if arguments:
                            raise ValueError("Authentication takes no arguments.")
                        import credentials
                        pid, window_id = passwords_target(self.bridge.proc.args[0])
                        if self.on_activity:
                            self.on_activity("action", "Unlocking workspace Passwords")
                        message = credentials.native("fill-workspace-passwords", str(pid), str(window_id))
                        response = {"ok": True, "result": {"content": [{"type": "text", "text": message}]}}
                        connection.sendall((json.dumps(response) + "\n").encode())
                        return
                    if prefer_safari() and (name == "spaceo_open_url" or
                                            (name == "spaceo_open_app" and "chrome" in json.dumps(arguments).lower())):
                        raise ValueError("Chrome is disabled by user preference; use Safari if workspace isolation permits")
                    if name in WORKSPACE_ACTIONS:
                        arguments.pop("strict", None)
                        arguments.pop("require_isolation", None)
                    if "session" in arguments and arguments["session"] != WORKSPACE:
                        raise ValueError("only the personal-agent workspace is available")
                    if name != "spaceo_session_list":
                        arguments["session"] = WORKSPACE
                    if self.on_activity:
                        self.on_activity("action", "Virtual workspace: " + name)
                    result = self.call_with_transient_health_retry(name, arguments)
                    self.bridge.observations.record(name, result)
                    if self.on_activity:
                        text = Bridge.description(result)
                        if name == "spaceo_verify_isolation":
                            detail = capability_report(result)
                        elif name in {"spaceo_read_text", "spaceo_read_screen", "spaceo_find"}:
                            detail = text[:1600] + ("…" if len(text) > 1600 else "")
                        else:
                            detail = "Failed" if result.get("isError") else "Completed"
                        self.on_activity("data", f"{name}: {detail or 'No text returned'}")
                response = {"ok": True, "result": result}
            except Exception as error:
                self.bridge.observations.record(value.get("name", "workspace request") if isinstance(locals().get("value"), dict) else "workspace request", failed=True)
                response = {"ok": False, "error": str(error)}
            try:
                connection.sendall((json.dumps(response) + "\n").encode())
            except OSError:
                pass


class Bridge:
    def __init__(self, command, on_activity=None):
        self.proc = subprocess.Popen([command, "mcp"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=None, text=True, bufsize=1)
        self.lock = threading.Lock()
        self.pending = {}
        self.serial = 0
        self.request_lock = threading.Lock()
        self.endpoint = None
        self.embedded = False
        self.bootstrapped = False
        self.failure = None
        self.on_activity = on_activity
        self.observations = EnvironmentObservations()
        self.status("starting", "Starting the virtual workspace")
        self.reader = threading.Thread(target=self.read, daemon=True)
        self.reader.start()

    def write(self, value):
        with self.lock:
            self.proc.stdin.write(json.dumps(value, ensure_ascii=False) + "\n")
            self.proc.stdin.flush()

    def read(self):
        for line in self.proc.stdout:
            try:
                data = json.loads(line)
            except ValueError:
                continue
            request_id = data.get("id")
            pending = self.pending.get(request_id)
            if pending is not None:
                pending[1] = data
                pending[0].set()
            elif not self.embedded and not (isinstance(request_id, str) and request_id.startswith(INTERNAL_PREFIX)):
                sys.stdout.write(line)
                sys.stdout.flush()
        for event, _ in list(self.pending.values()):
            event.set()

    def call(self, name, arguments):
        return self.request("tools/call", {"name": name, "arguments": arguments})

    def request(self, method, params):
        with self.request_lock:
            self.serial += 1
            key = INTERNAL_PREFIX + str(self.serial)
        item = [threading.Event(), None]
        self.pending[key] = item
        try:
            self.write({"jsonrpc": "2.0", "id": key, "method": method, "params": params})
            if not item[0].wait(45) or item[1] is None:
                raise RuntimeError(f"{method} did not answer")
            if "error" in item[1] or not isinstance(item[1].get("result"), dict):
                raise RuntimeError(f"{method} failed at the MCP protocol layer")
            return item[1]["result"]
        finally:
            self.pending.pop(key, None)

    @staticmethod
    def description(result):
        return " ".join(str(c.get("text", "")) for c in result.get("content", []) if isinstance(c, dict))

    def bootstrap(self):
        self.bootstrapped = True
        if workspace_fence.policy(state_dir()) == "closed":
            raise RuntimeError("Workspace was explicitly closed; an explicit user request is required to reopen it")
        saw_existing = False
        deadline = time.monotonic() + 5
        # The daemon fences records from its predecessor while its recovery janitor runs.
        # Wait for an explicit unknown-session response before creating a replacement.
        detached_deadline = time.monotonic() + 45
        saw_detached = False
        while True:
            claim = self.call("spaceo_session_claim", {"session": WORKSPACE})
            if not claim.get("isError"):
                workspace_fence.settle_existing(state_dir())
                self.publish_display()
                return
            description = self.description(claim)
            # Older daemons reported this particular detached claim as bad_request.
            # Match the session and complete fixed prefix, not arbitrary bad requests.
            legacy_detached = ("[bad_request] session '" + WORKSPACE +
                               "' belongs to a previous daemon and is detached: ")
            if description.startswith("[session_detached] ") or description.startswith(legacy_detached):
                saw_detached = True
                if time.monotonic() < detached_deadline:
                    time.sleep(0.25)
                    continue
                raise RuntimeError("Detached workspace cleanup did not finish: " + description)
            if saw_detached and "[unknown_session]" in description:
                break
            if "only an abandoned session" not in description or time.monotonic() >= deadline:
                break
            saw_existing = True
            time.sleep(0.25)  # the old MCP process can take a moment to exit on restart
        if saw_existing:
            raise RuntimeError("Existing workspace could not be recovered: " + description)
        if "[unknown_session]" not in description:
            raise RuntimeError("Could not recover the workspace: " + description)
        created = workspace_fence.create_once(state_dir(), lambda: self.call("spaceo_session_create", {
            "name": WORKSPACE, "title": "Agent workspace", "preset": "exclusive",
            "orphan_grace_seconds": 1800, "ttl_seconds": 3600}))
        if created.get("isError"):
            raise RuntimeError("Could not create the workspace: " + self.description(created))
        self.publish_display()

    def start_embedded(self):
        """Hold the single workspace lease for the personal-agent process itself."""
        self.embedded = True
        self.request("initialize", {"protocolVersion": "2025-03-26", "capabilities": {},
                                    "clientInfo": {"name": "personal-agent", "version": "1"}})
        self.write({"jsonrpc": "2.0", "method": "notifications/initialized"})
        self.bootstrap()
        self.endpoint = WorkspaceRequests(state_dir() / "control", self, self.on_activity)
        self.endpoint.start()
        if self.on_activity:
            self.on_activity("data", capability_report())

    def close(self):
        if self.endpoint:
            self.endpoint.close()
            self.endpoint = None
        try:
            self.proc.stdin.close()
            self.proc.wait(timeout=5)
        except (OSError, subprocess.TimeoutExpired):
            self.proc.terminate()

    def publish_display(self):
        listing = self.call("spaceo_session_list", {})
        if listing.get("isError"):
            raise RuntimeError("Could not find the workspace display: " + self.description(listing))
        pattern = r"\[yours\]\s+session\s+'" + re.escape(WORKSPACE) + r"'\s+on\s+whole\s+display\s+(\d+)"
        match = re.search(pattern, self.description(listing))
        if not match:
            raise RuntimeError("The exclusive workspace display could not be identified")
        self.observations.display_seen(match.group(1))
        atomic_write(state_dir() / "workspace-display-id", match.group(1) + "\n")
        self.status("ready", "Virtual workspace ready")

    @staticmethod
    def status(state, message):
        atomic_write(state_dir() / "workspace-status.json", json.dumps({"state": state, "message": message}) + "\n")

    def run(self):
        try:
            for line in sys.stdin:
                try:
                    value = json.loads(line)
                except ValueError:
                    continue
                if self.failure and value.get("method") == "tools/call" and "id" in value:
                    sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": value["id"],
                        "result": {"isError": True, "content": [{"type": "text", "text":
                            "Agent workspace is unavailable: " + self.failure}]}}) + "\n")
                    sys.stdout.flush()
                    continue
                self.write(value)
                if value.get("method") == "notifications/initialized" and not self.bootstrapped:
                    try:
                        self.bootstrap()
                        self.endpoint = WorkspaceRequests(state_dir() / "control", self)
                        self.endpoint.start()
                    except Exception as error:
                        self.failure = str(error)
                        self.status("error", self.failure)
                        print("Agent workspace unavailable: " + self.failure, file=sys.stderr, flush=True)
        finally:
            self.close()


if __name__ == "__main__":
    if len(sys.argv) != 2 or not os.path.isabs(sys.argv[1]):
        raise SystemExit("Usage: spaceo_mcp_bridge.py /absolute/path/to/spaceo")
    Bridge(sys.argv[1]).run()
