#!/bin/bash
# Starts Karabiner's virtual HID daemon (if it isn't already running) and the
# helper, both as root, with one password prompt. Ctrl-C stops both.
#
#   ./run.sh [helper options]      e.g. ./run.sh --verbose
set -euo pipefail
cd "$(dirname "$0")"

DAEMON='/Library/Application Support/org.pqrs/Karabiner-DriverKit-VirtualHIDDevice/Applications/Karabiner-VirtualHIDDevice-Daemon.app/Contents/MacOS/Karabiner-VirtualHIDDevice-Daemon'

[ -x build/agent-vhid-helper ] || make

sudo -v  # ask for the password once; the two sudo calls below reuse it

daemon_pid=""
if ! pgrep -qx Karabiner-VirtualHIDDevice-Daemon; then
  echo "starting Karabiner-VirtualHIDDevice-Daemon (log: /tmp/agent-vhid-daemon.log)"
  sudo "$DAEMON" >/tmp/agent-vhid-daemon.log 2>&1 &
  daemon_pid=$!
fi
cleanup() {
  if [ -n "$daemon_pid" ]; then
    sudo kill "$daemon_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT

sudo build/agent-vhid-helper "$@"
