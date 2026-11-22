#!/bin/bash
# Install or update Hive on the VM (as root, from the checkout in /opt/hive).
set -euo pipefail
cd /opt/hive
export CARGO_TARGET_DIR=/opt/hive/target PATH=/usr/local/cargo/bin:/root/.cargo/bin:$PATH RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/root/.cargo
cargo build --release -p hive-server
install -m 644 vm/hive-server.service /etc/systemd/system/
install -m 755 vm/hive-cred /usr/local/bin/hive-cred
systemctl daemon-reload
systemctl enable --now hive-server
systemctl restart hive-server
