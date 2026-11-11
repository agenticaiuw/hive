#!/bin/bash
# Updates ~/Applications/Hive.app to the current workspace-engine/Sources/UnifiedAgent/app.swift, signed with your certificate so
# macOS keeps its permissions (Screen Recording, Microphone, Accessibility...). No sudo: it doesn't
# touch the helper (./install.sh does that). Quits Agent and opens the new one.
#
#   tools/update-app.sh            build, check the signature, install, reopen
#   tools/update-app.sh --check    only say how the installed and built apps are signed
#   tools/update-app.sh --check-engine CANDIDATE INSTALLED    inspect engine compatibility only
set -euo pipefail
cd "$(dirname "$0")/.."
APP="$HOME/Applications/Hive.app"
APPLICATIONS="$HOME/Applications"
MIGRATOR="build/hive-bundle-migration"

build_engine_choice() {
  cargo build --quiet --locked --release --manifest-path crates/agent-core/Cargo.toml --bin workspace-engine-choice
}
engine_choice_bin=crates/agent-core/target/release/workspace-engine-choice

if [ "${1:-}" = "--check-engine" ]; then
  [ "$#" -eq 3 ] || { echo 'usage: update-app.sh --check-engine CANDIDATE INSTALLED' >&2; exit 2; }
  build_engine_choice
  exec "$engine_choice_bin" "$2" "$3"
fi

describe() {  # how macOS will know it: by certificate (stable) or by this exact build (not)
  if [ ! -d "$1" ]; then echo "$1: not there"; return; fi
  local requirement
  requirement=$(codesign -d -r- "$1" 2>&1 | sed -n 's/^\(# \)\{0,1\}designated => //p')
  case "$requirement" in
    *certificate*) echo "$1: signed with your certificate; permissions carry over to rebuilds" ;;
    *cdhash*) echo "$1: signed ad hoc; macOS knows only this exact build, so a rebuild must be allowed again" ;;
    *) echo "$1: unsigned or unreadable signature" ;;
  esac
}

if [ "${1:-}" = "--check" ]; then
  make -s "$MIGRATOR"
  installed=$("$MIGRATOR" select "$APPLICATIONS")
  describe "${installed:-$APP}"
  describe build/Agent.app
  exit 0
fi

# The sandboxed agent cannot always consult macOS's signing trust services.
# Queue the request there; the unsandboxed host builds and verifies before replacing anything.
if [ "${1:-}" = "--schedule" ]; then
  state="${AGENT_STATE_DIR:-$HOME/Library/Application Support/Personal Agent}"
  mkdir -p "$state/updates"
  umask 077
  printf 'ready\n' > "$state/updates/update-pending.tmp"
  mv "$state/updates/update-pending.tmp" "$state/updates/update-pending"
  echo 'Update scheduled for host build and verification after active agent turns finish.'
  exit 0
fi

# Fail before building or touching an app when legacy and new paths conflict.
make -s "$MIGRATOR"
installed=$("$MIGRATOR" select "$APPLICATIONS")
export SIGN_REQUIRED=${SIGN_REQUIRED-1}
[ "${SIGN:-}" = "-" ] && SIGN_REQUIRED=0
candidate=build/Agent.app
if [ -n "${AGENT_SPACEO_COMMAND:-}" ] || [ "${1:-}" = "--workspace" ] || { [ -n "$installed" ] && [ -x "$installed/Contents/Helpers/spaceo" ]; }; then
  candidate=build/Agent-WorkspaceCandidate.app
fi
make "$candidate" build/agent-vhid-captions build/agent-vhid-selection build/hive-agent
codesign --verify --deep --strict "$candidate"
describe "$candidate"

# TCC permissions follow the app's designated requirement. Refuse an update
# that would silently replace the existing identity and trigger fresh prompts.
if [ -n "$installed" ]; then
  requirement() {
    codesign -d -r- "$1" 2>&1 | sed -n -e 's/^# //' -e 's/^designated => //p'
  }
  installed_requirement=$(requirement "$installed")
  candidate_requirement=$(requirement "$candidate")
  if [ -z "$installed_requirement" ] || [ "$installed_requirement" != "$candidate_requirement" ]; then
    echo 'Update stopped: the new app has a different signing identity and could lose existing macOS permissions.' >&2
    exit 1
  fi
fi

# Build before staging or replacing anything, so a missing Rust toolchain or a
# failed build leaves the running app untouched.
engine_choice_built=0
if [ -n "$installed" ] && [ -x "$installed/Contents/Helpers/spaceo" ] && [ -x "$candidate/Contents/Helpers/spaceo" ]; then
  build_engine_choice
  engine_choice_built=1
fi

staged="$APPLICATIONS/.Hive-update-$$"
state="${AGENT_STATE_DIR:-$HOME/Library/Application Support/Personal Agent}"
backup="$state/app-backups/previous-$$"
mkdir -p "$HOME/Applications"
if [ -e "$staged" ] || [ -L "$staged" ] || [ -e "$backup" ] || [ -L "$backup" ]; then
  echo 'Update stopped: staging or backup path already exists.' >&2
  exit 1
fi
ditto "$candidate" "$staged"
codesign --verify --deep --strict "$staged"

# An app restart must not strand the display's still-running daemon with a
# different helper. Keep the existing engine for this update; the newly built
# engine can be installed once the display service is stopped safely.
installed_engine="${installed:-$APP}/Contents/Helpers/spaceo"
candidate_engine="$staged/Contents/Helpers/spaceo"
if [ -x "$installed_engine" ] && [ -x "$candidate_engine" ]; then
  [ "$engine_choice_built" -eq 1 ] || { echo 'Update stopped: workspace engines changed during staging.' >&2; exit 1; }
  engine_choice=$("$engine_choice_bin" "$candidate_engine" "$installed_engine")
  case "$engine_choice" in
    new) ;;
    preserve)
      cp "$installed_engine" "$candidate_engine"
      tools/sign.sh "$staged" local.personal-agent.Agent
      codesign --verify --deep --strict "$staged"
      [ "$(requirement "$staged")" = "$installed_requirement" ] || {
        echo 'Update stopped: signing identity changed while preserving the workspace engine.' >&2
        exit 1
      }
      echo 'Workspace engine update deferred until the current display service is stopped; installing the app update.'
      ;;
    *) echo 'Update stopped: the active workspace engine could not be identified safely.' >&2; exit 1 ;;
  esac
fi

launch_without_activation() {
  /usr/bin/swift -e '
import AppKit
let configuration = NSWorkspace.OpenConfiguration()
configuration.activates = false
var finished = false
var failed = false
NSWorkspace.shared.openApplication(at: URL(fileURLWithPath: CommandLine.arguments[1]), configuration: configuration) { _, error in
    if let error { fputs("Agent launch failed: \(error)\n", stderr); failed = true }
    finished = true
}
let deadline = Date().addingTimeInterval(20)
while !finished && Date() < deadline { RunLoop.current.run(until: Date().addingTimeInterval(0.1)) }
if !finished || failed { exit(1) }
' "$APP"
}

quit_agent() {
  /usr/bin/swift -e '
import AppKit
let url = URL(fileURLWithPath: CommandLine.arguments[1]).standardizedFileURL
let apps = NSRunningApplication.runningApplications(withBundleIdentifier: "local.personal-agent.Agent")
guard apps.allSatisfy({ $0.bundleURL?.standardizedFileURL == url }) else {
    fputs("Update stopped: another Agent bundle is running.\n", stderr); exit(1)
}
for app in apps where !app.terminate() {
    fputs("Update stopped: Agent refused to quit.\n", stderr); exit(1)
}
let deadline = Date().addingTimeInterval(15)
while apps.contains(where: { !$0.isTerminated }) && Date() < deadline {
    RunLoop.current.run(until: Date().addingTimeInterval(0.1))
}
guard apps.allSatisfy({ $0.isTerminated }) else {
    fputs("Update stopped: Agent did not quit; the installed app was not replaced.\n", stderr); exit(1)
}
' "${installed:-$APP}"
}
quit_agent
if ! prior_login=$("$MIGRATOR" commit "$installed" "$APP" "$staged" "$backup"); then
  if [ -n "$installed" ] && [ -d "$installed" ]; then
    original_app="$APP"
    APP="$installed"
    launch_without_activation || echo 'Previous app was restored but could not be relaunched.' >&2
    APP="$original_app"
  fi
  exit 1
fi
describe "$APP"
update_dir="$state/updates"
if [ -f "$state/update-applying" ] && [ ! -f "$update_dir/update-applying" ]; then
  update_dir="$state" # finish a handoff from an older version
fi
if [ -f "$update_dir/update-applying" ]; then
  mv "$update_dir/update-applying" "$update_dir/update-resume"
fi

if ! launch_without_activation; then
  [ ! -f "$update_dir/update-resume" ] || mv "$update_dir/update-resume" "$update_dir/update-applying"
  "$MIGRATOR" rollback "$installed" "$APP" "$staged" "$backup" "$prior_login"
  if [ -n "$installed" ]; then
    original_app="$APP"
    APP="$installed"
    launch_without_activation || true
    APP="$original_app"
  fi
  exit 1
fi
