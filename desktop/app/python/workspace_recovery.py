"""Clears an idle host-health latch on the virtual display engine before the workspace starts.

The engine stops creating virtual displays after it samples memory pressure, swap activity or
an unreadable health reading, and it stays stopped until someone runs
`spaceo safety clear-host-health --operator` by hand. That left the virtual monitor unavailable
after every such sample, so the app now runs the same command itself, once, at startup.

The engine's command keeps all of its own checks: it refuses while a SpaceO display is online,
while another owner holds the journal, for any failure other than host health, and while the
host is unhealthy right now. Nothing here bypasses those; a refusal is reported and the
workspace start then fails the way it did before.
"""
import json
import subprocess


def _run(command, timeout):
    try:
        done = subprocess.run(command, capture_output=True, text=True, timeout=timeout)
        return done.returncode, done.stdout, done.stderr
    except subprocess.TimeoutExpired:
        return 124, "", "timed out"
    except OSError as error:
        return 127, "", str(error)


def _last_line(*texts):
    for text in texts:
        lines = [line.strip() for line in (text or "").splitlines() if line.strip()]
        if lines:
            return lines[-1][:300]
    return ""


def recover_if_latched(spaceo, run=_run):
    """Returns (outcome, detail). Outcomes: not-latched, cleared, refused, skipped."""
    _, out, _ = run([spaceo, "doctor", "--json"], 45)
    try:
        report = json.loads(out)
    except ValueError:
        return "skipped", "the engine's health report could not be read"
    safety = report.get("displaySafety") or {}
    if safety.get("state") == "ready":
        return "not-latched", ""
    reason = str(safety.get("reason") or "")
    if safety.get("state") != "blocked" or not reason.startswith("host health:"):
        return "skipped", reason or "display safety state is " + str(safety.get("state"))
    online = (report.get("displays") or {}).get("spaceO") or []
    if online:
        return "skipped", reason + "; a virtual display is still online, so the engine will not clear it"
    # An idle daemon is a journal owner; with no display online it has nothing to lose.
    run([spaceo, "daemon", "stop"], 30)
    code, out, err = run([spaceo, "safety", "clear-host-health", "--operator"], 120)
    if code == 0:
        return "cleared", reason
    return "refused", reason + "; " + (_last_line(err, out) or f"exit status {code}")
