#!/bin/bash
# Makes the agent part of the Mac: Agent in the menu bar, opened at login, and what it needs started
# by the Mac as root (agent-vhid-helper, and Karabiner's virtual keyboard and mouse daemon), so
# there's nothing to start by hand. Then tap fn in any window to talk to it, and again to stop;
# hold fn and talk to type what you say (dictation).
#
#   ./install.sh               install, or update after changing the code (asks for your password)
#   ./install.sh --uninstall   take it all out again (./voice.sh still works on its own)
#
# Once, afterwards, in System Settings › Privacy & Security: Input Monitoring for agent-vhid-helper
# (so touching anything takes control back), and Microphone, Screen & System Audio Recording and
# Accessibility (to type what you dictate) for Agent, when it asks.
set -euo pipefail
cd "$(dirname "$0")"

HELPER=/Library/PrivilegedHelperTools/agent-vhid-helper
LABEL=local.personal-agent.helper
PLIST=/Library/LaunchDaemons/$LABEL.plist
LOG=/Library/Logs/agent-vhid-helper.log
KARABINER_LABEL=org.pqrs.service.daemon.Karabiner-VirtualHIDDevice-Daemon
KARABINER_PLIST=/Library/LaunchDaemons/$KARABINER_LABEL.plist
KARABINER_OURS=third_party/Karabiner-DriverKit-VirtualHIDDevice/files/LaunchDaemons/$KARABINER_LABEL.plist
DAEMON='/Library/Application Support/org.pqrs/Karabiner-DriverKit-VirtualHIDDevice/Applications/Karabiner-VirtualHIDDevice-Daemon.app/Contents/MacOS/Karabiner-VirtualHIDDevice-Daemon'
APP="$HOME/Applications/Hive.app"
installed=$(python3 scripts/hive_bundle_migration.py select "$HOME/Applications")

if [ "$(id -u)" = 0 ]; then
  echo "Run it as yourself, without sudo: it asks for your password when it needs it."
  exit 1
fi

quit_app() {
  pkill -f "${1}/Contents/MacOS/Agent" || true  # its voice agent sees the app go and stops too
}

# Takes a daemon out of launchd, and waits until it's gone so it can be put back.
bootout() {
  sudo launchctl bootout "system/$1" 2>/dev/null || true
  for _ in $(seq 50); do
    sudo launchctl print "system/$1" >/dev/null 2>&1 || return 0
    sleep 0.1
  done
}

if [ "${1:-}" = "--uninstall" ]; then
  sudo -v
  uninstall_app="${installed:-$APP}"
  if [ -x "$uninstall_app/Contents/MacOS/Agent" ]; then
    "$uninstall_app/Contents/MacOS/Agent" --unregister  # out of the login items
  fi
  quit_app "$uninstall_app"
  rm -rf "$uninstall_app"
  bootout $LABEL
  sudo rm -f "$PLIST" "$HELPER"
  if [ -f "$KARABINER_PLIST" ] && cmp -s "$KARABINER_PLIST" "$KARABINER_OURS"; then  # the one this put there
    bootout $KARABINER_LABEL
    sudo rm -f "$KARABINER_PLIST"
  fi
  echo "Uninstalled. ./voice.sh still works on its own."
  exit 0
fi

if pgrep -qf "python/voice_agent.py" && ! pgrep -qf "voice_agent.py --app"; then
  echo "./voice.sh is running. Stop it (Ctrl-C in its window), then run this again."
  exit 1
fi
if python3 python/agent_vhid.py status >/dev/null 2>&1 && ! launchctl print system/$LABEL >/dev/null 2>&1; then
  echo "An agent-vhid-helper started by ./run.sh is running. Stop it (Ctrl-C in its window), then run this again."
  exit 1
fi
if [ ! -x "$DAEMON" ]; then
  echo "Karabiner-DriverKit-VirtualHIDDevice isn't installed; see Setup in README.md."
  exit 1
fi

# Signed with your certificate, or not at all: an ad-hoc build would lose Agent's permissions.
[ "${SIGN:-}" = "-" ] || export SIGN_REQUIRED=1
./voice.sh --setup  # builds everything, and fetches the Python packages and the models the first time
sudo -v

# The helper runs as root, so the Mac runs a root-owned copy of it, never the one in build/ (which
# anything running as you could replace).
copy=$(mktemp -d)
trap 'rm -rf "$copy"' EXIT
cp build/agent-vhid-helper "$copy/agent-vhid-helper"
tools/sign.sh "$copy/agent-vhid-helper" local.personal-agent.helper  # so Input Monitoring stays allowed after updates
bootout $LABEL
sudo install -o root -g wheel -m 755 "$copy/agent-vhid-helper" "$HELPER"
sudo tee "$PLIST" >/dev/null <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$HELPER</string>
    <string>--user</string>
    <string>$USER</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>StandardOutPath</key>
  <string>$LOG</string>
  <key>StandardErrorPath</key>
  <string>$LOG</string>
</dict>
</plist>
EOF
sudo chown root:wheel "$PLIST"
sudo chmod 644 "$PLIST"

# Karabiner's virtual keyboard and mouse need its daemon; its package leaves starting it to you.
if ! sudo launchctl print system/$KARABINER_LABEL >/dev/null 2>&1; then
  sudo pkill -x Karabiner-VirtualHIDDevice-Daemon 2>/dev/null || true  # one ./run.sh left behind
  sudo install -o root -g wheel -m 644 "$KARABINER_OURS" "$KARABINER_PLIST"
  sudo launchctl bootstrap system "$KARABINER_PLIST"
fi
sudo launchctl bootstrap system "$PLIST"

# The updater verifies identity, preserves the previous bundle, and rolls back on failure.
tools/update-app.sh

for _ in $(seq 20); do
  python3 python/agent_vhid.py status >/dev/null 2>&1 && break
  sleep 0.5
done
echo
echo "Installed. Hive is in the menu bar (the microphone) and opens at login. Tap fn to talk to it;"
echo "hold fn and talk to type what you say into the app you're in."
echo
echo "Once, in System Settings › Privacy & Security:"
if python3 python/agent_vhid.py status >/dev/null 2>&1; then
  echo "  - Input Monitoring: agent-vhid-helper is allowed already."
else
  echo "  - Input Monitoring: turn on agent-vhid-helper. If it isn't listed, add it with +"
  echo "    (Cmd-Shift-G, then $HELPER). It starts by itself within 10 s."
fi
echo "  - Microphone: allow Agent when it asks, the first time you tap fn."
echo "  - Screen & System Audio Recording: allow Agent when it asks, then Restart Agent from its menu."
echo "  - Accessibility: allow Agent when it asks, the first time you dictate (until then what you"
echo "    dictate is left on the clipboard)."
if [ "$(defaults read com.apple.HIToolbox AppleFnUsageType 2>/dev/null || echo 0)" != 0 ]; then
  echo
  echo "System Settings › Keyboard › \"Press 🌐 key to\" isn't Do Nothing, so each tap of fn also starts"
  echo "dictation (or the emoji picker, or switches the input source). Set it to Do Nothing."
fi
if defaults read com.superduper.superwhisper KeyboardShortcuts_toggleRecording 2>/dev/null |
    grep -q '"carbonKeyCode":63[,}]'; then
  echo
  echo "superwhisper records when you press fn too, and opens at login. Agent dictates now (hold fn), so"
  echo "quit superwhisper and take it out of System Settings › General › Login Items."
fi
echo
echo "Logs: ~/Library/Logs/Agent.log (the voice agent), $LOG (the helper)."
