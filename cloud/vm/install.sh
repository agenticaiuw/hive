#!/bin/bash
# Install or update Hive on the VM (as root, from the checkout in /opt/hive).
set -euo pipefail
cd /opt/hive
cargo build --release -p hive-server -p hive-phone
install -m 644 cloud/vm/hive-server.service cloud/vm/hive-phone.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now hive-server
if [ ! -s /root/.config/hive/phone.json ]; then
  sleep 2
  target/release/hive-phone pair http://127.0.0.1:8800 "$(HIVE_STATE=/var/lib/hive target/release/hive-server code)"
fi
systemctl enable --now hive-phone
systemctl restart hive-server hive-phone
