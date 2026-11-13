#!/usr/bin/env bash
# Installs Hive's nightly dream on its cloud VM: run as root from the repo clone
# (sudo bash /var/lib/hive-dream/hive/cloud/dream/install.sh). It copies nightly.sh next to the
# clone (the clone moves under a running night) and adds hive-dream.service and hive-dream.timer:
# every night at 09:30 UTC (03:30 in Madison in winter), caught up after a reboot (Persistent).
# The GitHub workflow's daily warm-up (08:00 UTC) has the macOS check's build cache ready by then.
set -euo pipefail
ROOT=${HIVE_DREAM_ROOT:-/var/lib/hive-dream}
here=$(cd "$(dirname "$0")" && pwd)
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
install -m 700 "$here/nightly.sh" "$ROOT/nightly.sh"

cat > /etc/systemd/system/hive-dream.service <<UNIT
[Unit]
Description=Hive's nightly dream: its own agent fixes one recurring failure, test first
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
ExecStart=$ROOT/nightly.sh
Environment=HIVE_DREAM_ROOT=$ROOT
TimeoutStartSec=6h
Nice=10
IOSchedulingClass=idle
UNIT

cat > /etc/systemd/system/hive-dream.timer <<UNIT
[Unit]
Description=Hive's nightly dream at 09:30 UTC

[Timer]
OnCalendar=*-*-* 09:30:00 UTC
Persistent=true

[Install]
WantedBy=timers.target
UNIT

systemctl daemon-reload
systemctl enable --now hive-dream.timer
systemctl list-timers hive-dream.timer --no-pager
