#!/bin/sh
# UW-Madison's VPN (WiscVPN, GlobalProtect) for the worker's browser only.
#
#   vpn.sh          connect, in a tmux session ("wiscvpn") that stays up after you close the window:
#                   you type your NetID, password and Duo answer yourself
#   vpn.sh status   is it connected
#   vpn.sh down     disconnect
#
# openconnect signs in and hands the tunnel to ocproxy, a SOCKS5 proxy on 127.0.0.1:11080, which
# the browser uses with HIVE_VM_PROXY=socks5://127.0.0.1:11080. There is no tun device and no
# route change: SSH and everything else on the VM keep the normal network, and it needs no root.
# Needs: sudo apt-get install openconnect ocproxy tmux.
set -eu
port=${HIVE_VM_VPN_PORT:-11080}
portal=${HIVE_VM_VPN_PORTAL:-uwmadison.vpn.wisc.edu}
up() { ss -Hltn "sport = :$port" | grep -q .; }  # ocproxy is listening
case "${1:-up}" in
  up)
    if up; then echo "Already connected (proxy on 127.0.0.1:$port)."; exit 0; fi
    exec tmux new-session -A -s wiscvpn "$0" connect ;;
  connect)  # inside tmux
    echo "Signing in to $portal: type your NetID and password, then answer Duo (push, or a passcode)."
    echo "Once it says Connected, close this window; the VPN stays up."
    openconnect --protocol=gp --script-tun --script "ocproxy -D $port -k 30" "$portal" || true
    echo "The VPN is off. Press Return to close."; read -r _ ;;
  status)
    if up; then echo "connected (proxy on 127.0.0.1:$port)"; else echo "not connected"; exit 1; fi ;;
  down)
    tmux kill-session -t wiscvpn 2>/dev/null && echo "Disconnected." || echo "Not connected." ;;
  *) echo "usage: vpn.sh [up|status|down]" >&2; exit 2 ;;
esac
