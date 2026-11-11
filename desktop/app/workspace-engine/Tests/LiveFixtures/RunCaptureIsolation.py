"""Live-only capture proof. Follow README.md; never run beside another live audit."""

import hashlib
import json
import os
import pathlib
import subprocess
import sys
import time
import traceback

if not __debug__:
    raise SystemExit(
        "Run without -O or PYTHONOPTIMIZE; this proof requires its assertions"
    )

if len(sys.argv) != 3:
    raise SystemExit(
        "usage: python3 RunCaptureIsolation.py PRIVATE_FIXTURE_DIR SIGNED_SPACEO_BINARY"
    )
root = pathlib.Path(sys.argv[1]).resolve()
if not (root / "Marker.app").is_dir() or not (root / "capture-marker").is_file():
    raise SystemExit("Build the two fixtures first; see README.md")
if (root / "report.json").exists() or (root / "enlarge").exists():
    raise SystemExit("Use a fresh fixture directory for each run")
os.umask(0o077)
binary = str(pathlib.Path(sys.argv[2]).resolve())
env = os.environ | {
    "SPACEO_SOCKET": str(root / "socket"),
    "SPACEO_SESSIONS_PER_DISPLAY": "2",
    "SPACEO_DISPLAY_SIZE": "2560x1440",
}
report = {
    "binarySHA256": hashlib.sha256(pathlib.Path(binary).read_bytes()).hexdigest(),
    "status": "failed",
}


def cli(args, timeout=40, required=True):
    p = subprocess.run(
        [binary, *args, "--json"],
        env=env,
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    try:
        r = json.loads(p.stdout)
    except ValueError:
        raise RuntimeError("No JSON response for " + args[0])
    if required and not r.get("ok"):
        raise RuntimeError(r.get("error", "Command failed"))
    return r


def doctor():
    return cli(["doctor"], required=False)


def topology(d):
    return {
        k: sorted(d["displays"][k])
        for k in ["userActive", "userOnline", "mirroredUser"]
    }


before = doctor()
report["before"] = before["displays"]
if before["displays"]["spaceO"] or before["displays"]["orphanedSpaceO"]:
    raise RuntimeError("Preexisting SpaceO display")
with (root / "daemon.log").open("w") as log:
    daemon = subprocess.Popen(
        [binary, "daemon"], env=env, stdout=log, stderr=subprocess.STDOUT
    )
    try:
        for _ in range(60):
            d = doctor()
            if (
                d.get("daemon", {}).get("matchesCLI")
                and d["daemon"].get("canDrive")
                and d["daemon"].get("canCapture")
            ):
                break
            if daemon.poll() is not None:
                raise RuntimeError("Daemon exited")
            time.sleep(0.25)
        else:
            raise RuntimeError("Daemon permissions unavailable")
        leases = {}
        for name in ["marker-a", "neighbor-b"]:
            r = cli(["session", "create", "--session", name, "--controller-ttl", "600"])
            leases[name] = r["controllerLeaseID"]
        sessions = cli(["session", "list", "--operator"])["sessions"]
        a = next(s for s in sessions if s["id"] == "marker-a")
        b = next(s for s in sessions if s["id"] == "neighbor-b")
        pool = cli(["pool"])["displays"]
        display = next(d for d in pool if d["displayID"] == b["displayID"])
        assert a["displayID"] == b["displayID"] and b["tileIndex"] == 1
        assert b["displayID"] not in before["displays"]["userOnline"]
        report["tiles"] = [
            {
                k: s[k]
                for k in ["id", "displayID", "tileIndex", "x", "y", "width", "height"]
            }
            for s in [a, b]
        ]
        r = cli(
            [
                "run",
                str(root / "Marker.app"),
                "--session",
                "marker-a",
                "--lease",
                leases["marker-a"],
            ],
            timeout=100,
        )
        report["launchOK"] = r["ok"]
        pid = int((root / "fixture.pid").read_text())
        report["fixturePID"] = pid
        (root / "enlarge").touch()
        time.sleep(2)
        args = [
            str(root / "capture-marker"),
            str(b["displayID"]),
            str(b["x"] - display["x"]),
            str(b["y"] - display["y"]),
            str(b["width"]),
            str(b["height"]),
            str(pid),
            str(root / "positive.png"),
        ]
        positive = subprocess.run(
            args, env=env, capture_output=True, text=True, timeout=30
        )
        (root / "positive.log").write_text(positive.stdout + positive.stderr)
        if positive.returncode:
            raise RuntimeError("Positive control failed; see private log")
        report["positive"] = json.loads(positive.stdout)
        assert report["positive"]["markerPixels"] > 1000, "No visible marker overlap"
        health = cli(
            ["verify", "--session", "marker-a", "--lease", leases["marker-a"]],
            required=False,
        )
        report["sessionHealth"] = {
            k: health.get(k) for k in ["ok", "findings", "isolation"]
        }
        report["fixtureWindows"] = health.get("session", {}).get("windows", [])
        assert not health["ok"] and health.get("findings"), (
            "Oversized window was not reported as a health failure"
        )
        captured = cli(
            [
                "screenshot",
                "--session",
                "neighbor-b",
                "--lease",
                leases["neighbor-b"],
                "--full",
                "-o",
                str(root / "protected.png"),
            ],
            required=False,
        )
        if not captured["ok"]:
            report["captureError"] = captured.get("error")
            raise RuntimeError("Capture refused; requires review")
        count = subprocess.run(
            [str(root / "capture-marker"), "count", str(root / "protected.png")],
            capture_output=True,
            text=True,
            timeout=30,
            check=True,
        )
        report["protectedMarkerPixels"] = int(count.stdout)
        assert report["protectedMarkerPixels"] == 0, (
            "Foreign marker leaked into protected capture"
        )
        report["status"] = "passed"
    except Exception as error:
        report["error"] = str(error)
        (root / "trace.log").write_text(traceback.format_exc())
    finally:
        try:
            stop = cli(["daemon", "stop", "--operator"], timeout=130)
            report["daemonStopOK"] = stop["ok"]
            daemon.wait(timeout=20)
        except Exception:
            report["status"] = "failed"
            report["cleanupError"] = True
            daemon.terminate()
            try:
                daemon.wait(timeout=15)
            except subprocess.TimeoutExpired:
                daemon.kill()
                daemon.wait()
        after = doctor()
        report["after"] = after["displays"]
        if "fixturePID" in report:
            report["fixtureExited"] = (
                subprocess.run(
                    ["kill", "-0", str(report["fixturePID"])], capture_output=True
                ).returncode
                != 0
            )
            if not report["fixtureExited"]:
                report["status"] = "failed"
        report["topologyUnchanged"] = topology(before) == topology(after)
        report["zeroRemainingDisplays"] = (
            not after["displays"]["spaceO"] and not after["displays"]["orphanedSpaceO"]
        )
        if not report["topologyUnchanged"] or not report["zeroRemainingDisplays"]:
            report["status"] = "failed"
        (root / "report.json").write_text(json.dumps(report, indent=2))
        (root / "exit").write_text("0" if report["status"] == "passed" else "1")

raise SystemExit(0 if report["status"] == "passed" else 1)
