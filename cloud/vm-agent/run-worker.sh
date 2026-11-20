#!/bin/sh
# Start the Hive VM worker: one sandboxed Chromium on a private virtual display (hive-vm-worker.service).
# Control is a Unix socket under state/; nothing listens on the network.
set -eu
root="$HOME/hive-vm-agent"
chrome="$root/browsers/chromium-1254/chrome-linux-arm64"
export HIVE_VM_STATE="$root/state"
export HIVE_VM_BROWSER="$chrome/chrome"
export CHROME_DEVEL_SANDBOX="$chrome/chrome_sandbox"
# Through the UW VPN (vpn.sh) when it is connected: the browser then uses only that.
if ss -Hltn "sport = :11080" | grep -q .; then export HIVE_VM_PROXY=socks5://127.0.0.1:11080; fi
umask 077
exec xvfb-run -a -s "-screen 0 1440x900x24 -nolisten tcp" /usr/local/bin/node "$root/app/server.mjs"
