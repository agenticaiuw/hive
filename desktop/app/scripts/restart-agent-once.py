#!/usr/bin/env python3
"""One-off Agent restart. Default: plan only. --prepare builds without launching.

--execute is deliberately required to quit/install/launch. No sudo,
synthetic keys, UI scripting, data cleanup, or installer. All backups are retained.
"""
import argparse
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import tempfile
import time

REPO = Path(__file__).resolve().parents[1]
APP = Path.home() / "Applications/Agent.app"
IDENTIFIER = "local.personal-agent.Agent"

CONTROL = r'''
import AppKit
let mode = CommandLine.arguments[1]
let url = URL(fileURLWithPath: CommandLine.arguments[2]).standardizedFileURL
let apps = NSRunningApplication.runningApplications(withBundleIdentifier: "local.personal-agent.Agent")
guard apps.allSatisfy({ $0.bundleURL?.standardizedFileURL == url }) else {
    fputs("Another Agent bundle is running; refusing to touch it.\n", stderr); exit(1)
}
if mode == "quit" {
    for app in apps {
        guard app.terminate() else { fputs("Agent refused graceful quit.\n", stderr); exit(1) }
    }
    let deadline = Date().addingTimeInterval(15)
    while apps.contains(where: { !$0.isTerminated }) && Date() < deadline {
        RunLoop.current.run(until: Date().addingTimeInterval(0.1))
    }
    guard apps.allSatisfy({ $0.isTerminated }) else {
        fputs("Agent did not quit; no force kill or replacement performed.\n", stderr); exit(1)
    }
} else if mode == "launch" {
    guard apps.isEmpty else { fputs("Agent is already running.\n", stderr); exit(1) }
    let config = NSWorkspace.OpenConfiguration()
    config.activates = false
    config.arguments = ["--listen-once"]
    var finished = false
    var failed = false
    NSWorkspace.shared.openApplication(at: url, configuration: config) { _, error in
        failed = error != nil
        if let error { fputs("Launch failed: \(error)\n", stderr) }
        finished = true
    }
    let deadline = Date().addingTimeInterval(20)
    while !finished && Date() < deadline {
        RunLoop.current.run(until: Date().addingTimeInterval(0.1))
    }
    if !finished || failed { exit(1) }
} else { exit(2) }
'''


def run(*args, env=None):
    subprocess.run([str(a) for a in args], check=True, env=env)


def replace_once(text, old, new):
    if text.count(old) != 1:
        raise RuntimeError("Source changed; refusing an ambiguous one-off patch: " + old[:70])
    return text.replace(old, new, 1)


def patched_sources(repo, stage):
    app = (repo / "tools/app.swift").read_text()
    app = replace_once(app, "    var quitting = false", '''    var quitting = false
    var listenOnce = CommandLine.arguments.contains("--listen-once")''')
    app = replace_once(app, '                statusLine.title = String(line.dropFirst("@@ status ".count))',
                       '''                statusLine.title = String(line.dropFirst("@@ status ".count))
                if statusLine.title == "Ready", listenOnce {
                    listenOnce = false
                    if !listening { toggle() }
                }''')
    app = replace_once(app, '                listening = line.hasSuffix("1")',
                       '                listening = line.hasSuffix("1")\n'
                       '                if listening { try? Data("listening\\n".utf8).write(to: '
                       f'URL(fileURLWithPath: "{stage}/listening"), options: .atomic) }}')
    app = replace_once(app, "        process.environment = environment",
                       '        environment["CAPTIONS"] = "1"\n'
                       f'        environment["AGENT_ONCE_VISIBLE"] = "{stage}/visible"\n'
                       "        process.environment = environment")
    # A one-off restart must not change login preferences or discard rotated logs.
    app = replace_once(app, '        if !UserDefaults.standard.bool(forKey: "loginItemSet") {',
                       '        if false { // leave login registration untouched in this build')
    app = replace_once(app, '            try? manager.removeItem(at: old)',
                       '            // Preserve any old log; a failed move leaves the current log in place.')
    captions = (repo / "tools/captions.swift").read_text()
    captions = replace_once(captions, "        window.orderFrontRegardless()",
                            '''        window.orderFrontRegardless()
        if listening, let path = ProcessInfo.processInfo.environment["AGENT_ONCE_VISIBLE"] {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in
                if let self, self.listening, self.window.isVisible, self.window.alphaValue > 0 {
                    try? Data("visible\\n".utf8).write(to: URL(fileURLWithPath: path), options: .atomic)
                }
            }
        }''')
    return app, captions


def prepare(repo=REPO):
    # Generated paths are controlled here and contain no Swift string metacharacters.
    stage = Path(tempfile.mkdtemp(prefix="agent-restart-", dir="/private/tmp"))
    app_source, captions_source = patched_sources(repo, stage)
    bundle = stage / "Agent.app"
    binary = bundle / "Contents/MacOS/Agent"
    binary.parent.mkdir(parents=True)
    for name, source in (("app", app_source), ("captions", captions_source), ("control", CONTROL)):
        (stage / f"{name}.swift").write_text(source)
    info = plistlib.loads((repo / "tools/Agent-Info.plist").read_bytes())
    info["AgentRepository"] = str(repo)
    (bundle / "Contents/Info.plist").write_bytes(plistlib.dumps(info))
    cache = stage / "module-cache"
    for source, target in (("app", binary), ("captions", stage / "agent-vhid-captions"),
                           ("control", stage / "control")):
        run("/usr/bin/swiftc", "-O", "-module-cache-path", cache,
            stage / f"{source}.swift", "-o", target)
    # Signed like make signs it (your Apple Development certificate), so macOS keeps Agent's
    # permissions; it refuses to fall back to ad hoc, which would make them all be asked again.
    run(repo / "tools/sign.sh", bundle, IDENTIFIER, env={**os.environ, "SIGN_REQUIRED": "1"})
    run("/usr/bin/codesign", "--verify", "--strict", bundle)
    print(f"Prepared (nothing launched): {stage}", flush=True)
    return stage


def preflight(repo=REPO, app=APP):
    if app.is_symlink() or not app.is_dir():
        raise RuntimeError(f"Expected an installed, non-symlink app: {app}")
    info = plistlib.loads((app / "Contents/Info.plist").read_bytes())
    if info.get("CFBundleIdentifier") != IDENTIFIER or info.get("AgentRepository") != str(repo):
        raise RuntimeError("Installed bundle identity/repository does not match")
    if not os.access(repo / ".venv/bin/python", os.X_OK):
        raise RuntimeError("Existing Python environment is missing; no setup/download will be attempted")


def execute(stage, repo=REPO, app=APP, timeout=120):
    preflight(repo, app)
    # Stage installation on the destination filesystem BEFORE disturbing the running app.
    suffix = stage.name
    incoming = app.with_name(f"Agent.incoming-{suffix}.app")
    backup = app.with_name(f"Agent.backup-{suffix}.app")
    overlay = repo / "build/agent-vhid-captions"
    overlay_backup = overlay.with_name(f"agent-vhid-captions.backup-{suffix}")
    overlay_incoming = overlay.with_name(f"agent-vhid-captions.incoming-{suffix}")
    for path in (incoming, backup, overlay_backup, overlay_incoming):
        if path.exists() or path.is_symlink():
            raise RuntimeError(f"Refusing to overwrite {path}")
    shutil.copytree(stage / "Agent.app", incoming)
    shutil.copy2(stage / "agent-vhid-captions", overlay_incoming)
    run(stage / "control", "quit", app)
    app.rename(backup)
    try:
        incoming.rename(app)
        if overlay.exists():
            overlay.rename(overlay_backup)
        overlay_incoming.rename(overlay)
    except OSError:
        # Preserve every artifact; restore the previous app if installation failed.
        if app.exists():
            app.rename(incoming)
        backup.rename(app)
        if overlay_backup.exists() and not overlay.exists():
            overlay_backup.rename(overlay)
        raise
    print(f"Previous app retained: {backup}", flush=True)
    print(f"Previous overlay retained if present: {overlay_backup}", flush=True)
    run(stage / "control", "launch", app)
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if (stage / "listening").exists() and (stage / "visible").exists():
            print("Agent acknowledged listening; captions reported a visible window.")
            return
        time.sleep(0.2)
    raise RuntimeError("No listening + visible acknowledgement within 120 seconds. "
                       "App left running; no automatic retry/toggle/rollback. "
                       f"Artifacts: {stage}. Check Agent permissions/helper manually.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--prepare", action="store_true")
    mode.add_argument("--execute", action="store_true")
    args = parser.parse_args()
    if not (args.prepare or args.execute):
        print(f"PLAN ONLY: compile temporary app + captions from {REPO}; ad-hoc sign; "
              f"gracefully quit {APP}; preserve old bundle/overlay; install; launch without "
              "activation; wait for Ready; send one toggle; verify listening + visible acknowledgements. "
              "Use --prepare for compilation only, --execute to actually restart.")
        return
    if args.execute:
        preflight()
    stage = prepare()
    if args.execute:
        execute(stage)


if __name__ == "__main__":
    main()
