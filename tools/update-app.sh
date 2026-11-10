#!/bin/bash
# Updates ~/Applications/Agent.app to the current tools/app.swift, signed with your certificate so
# macOS keeps its permissions (Screen Recording, Microphone, Accessibility...). No sudo: it doesn't
# touch the helper (./install.sh does that). Quits Agent and opens the new one.
#
#   tools/update-app.sh            build, check the signature, install, reopen
#   tools/update-app.sh --check    only say how the installed and built apps are signed
set -euo pipefail
cd "$(dirname "$0")/.."
APP="$HOME/Applications/Agent.app"

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
  describe "$APP"
  describe build/Agent.app
  exit 0
fi

export SIGN_REQUIRED=${SIGN_REQUIRED-1}
[ "${SIGN:-}" = "-" ] && SIGN_REQUIRED=0
make build/Agent.app build/agent-vhid-captions
codesign --verify --strict build/Agent.app
describe build/Agent.app

pkill -f "/Agent.app/Contents/MacOS/Agent" || true  # its voice agent sees the app go and stops too
for _ in $(seq 50); do pgrep -qf "/Agent.app/Contents/MacOS/Agent" || break; sleep 0.1; done
mkdir -p "$HOME/Applications"
rm -rf "$APP"
ditto build/Agent.app "$APP"
describe "$APP"
open "$APP"
