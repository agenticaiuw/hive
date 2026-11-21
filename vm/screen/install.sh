#!/bin/sh
# Sets up the VM agent's screen: a desktop (openbox, a taskbar with Terminal and Chrome) on the
# worker's Xvfb :99, x11vnc sharing it on loopback port 5901 for the owner's "VM Screen" app
# (through an SSH tunnel), and vm-shot, which the Mac's "VM Screenshot" app runs over SSH.
# Run on the VM as root: sudo sh screen/install.sh
# Safe to run again: it keeps the screen-share password, and restarts a service only when its own
# files changed (a restart of vm-screen-share drops whoever is watching).
set -eu
here=$(cd "$(dirname "$0")" && pwd)
user=ubuntu
home=/home/ubuntu
as_user() { runuser -u "$user" -- "$@"; }

DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends \
  openbox tint2 xfce4-terminal x11-xserver-utils x11vnc adwaita-icon-theme humanity-icon-theme python3 \
  x11-apps xdotool

# Which services' files change with this install (checked before anything is replaced).
differs() { ! cmp -s "$1" "$2"; }
desktop_changed=; share_changed=
if differs "$here/vm-desktop" /usr/local/bin/vm-desktop || differs "$here/vm-desktop.service" /etc/systemd/system/vm-desktop.service \
  || differs "$here/tint2rc" "$home/.config/tint2/tint2rc"; then desktop_changed=1; fi
if differs "$here/vm-screen-share" /usr/local/bin/vm-screen-share || differs "$here/vm-screen-share.service" /etc/systemd/system/vm-screen-share.service; then
  share_changed=1
fi
rc_before=$(cat "$home/.config/openbox/rc.xml" 2>/dev/null || true)

install -m 755 "$here/vm-desktop" "$here/vm-chrome" "$here/vm-screen-share" "$here/vm-shot" /usr/local/bin/
install -m 644 "$here/vm-desktop.service" "$here/vm-screen-share.service" /etc/systemd/system/

as_user mkdir -p "$home/.config/tint2" "$home/.config/openbox" "$home/.local/share/applications" "$home/.vnc"
install -o "$user" -g "$user" -m 644 "$here/tint2rc" "$home/.config/tint2/tint2rc"
install -o "$user" -g "$user" -m 644 "$here/hive-terminal.desktop" "$here/hive-chrome.desktop" \
  "$home/.local/share/applications/"

# Openbox's stock config with one desktop and the window rules in openbox-applications.xml.
python3 - "$here/openbox-applications.xml" /etc/xdg/openbox/rc.xml "$home/.config/openbox/rc.xml" <<'PY'
import re, sys
rules = open(sys.argv[1]).read().strip()
rc = open(sys.argv[2]).read()
rc = re.sub(r'<applications>.*?</applications>', lambda m: rules, rc, count=1, flags=re.S)
rc = re.sub(r'(<desktops>.*?<number>)\d+(</number>)', r'\g<1>1\2', rc, count=1, flags=re.S)
open(sys.argv[3], 'w').write(rc)
PY
chown "$user:$user" "$home/.config/openbox/rc.xml"

# The screen-share password (VNC uses 8 characters). The Mac's VM Screen app reads it over SSH.
if [ ! -s "$home/.vnc/vm-screen.passwd" ]; then
  as_user sh -c 'umask 077; tr -dc A-Za-z0-9 </dev/urandom | head -c 8 > "$0"; echo >> "$0"' "$home/.vnc/vm-screen.passwd"
fi

[ "$(cat "$home/.config/openbox/rc.xml")" = "$rc_before" ] || desktop_changed=1

systemctl daemon-reload
systemctl enable --now vm-screen-share vm-desktop
if [ -n "$desktop_changed" ]; then systemctl restart vm-desktop; fi
if [ -n "$share_changed" ]; then systemctl restart vm-screen-share; fi
