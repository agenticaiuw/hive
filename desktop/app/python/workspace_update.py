"""Choose an update that keeps an active virtual display's engine compatible."""
import json
import subprocess
import sys


def decision(candidate: dict, installed: dict) -> str:
    daemon = candidate.get("daemon")
    old = installed.get("daemon")
    if (not isinstance(daemon, dict) or not isinstance(daemon.get("running"), bool)
            or not isinstance(old, dict) or not isinstance(old.get("running"), bool)
            or daemon["running"] != old["running"]):
        return "unsafe"
    if not daemon["running"]:
        return "new"
    if not daemon.get("instanceID") or old.get("instanceID") != daemon["instanceID"]:
        return "unsafe"
    if daemon.get("matchesCLI") is True:
        return "new"
    if old.get("matchesCLI") is True:
        return "preserve"
    return "unsafe"


def doctor(path: str) -> dict:
    try:
        result = subprocess.run([path, "doctor", "--json"], capture_output=True,
                                text=True, timeout=8, check=False)
        value = json.loads(result.stdout)
        return value if isinstance(value, dict) else {}
    except (OSError, subprocess.TimeoutExpired, ValueError):
        return {}


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("Usage: workspace_update.py CANDIDATE INSTALLED")
    print(decision(doctor(sys.argv[1]), doctor(sys.argv[2])))
