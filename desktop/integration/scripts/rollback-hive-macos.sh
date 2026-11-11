#!/bin/bash
# Restore a verified previous Agent.app without changing login items or data.
set -euo pipefail
if [ "$#" -ne 1 ]; then echo 'Usage: rollback-hive-macos.sh /path/to/previous/Agent.app' >&2; exit 2; fi
repo_root=$(cd "$(dirname "$0")/../../.." && pwd)
current="$HOME/Applications/Hive.app"
old="$HOME/Applications/Agent.app"
[ ! -e "$old" ] || { echo 'Agent.app already exists; refusing a duplicate.' >&2; exit 1; }
if ps -axo comm= | grep -Fxq "$current/Contents/MacOS/Agent"; then echo 'The app is running; stop it before restoring its bundle.' >&2; exit 1; fi
HIVE_ROLLBACK=1 exec "$repo_root/desktop/integration/scripts/hive-app-transaction.sh" "$1" "$current" "$HOME/Library/Application Support/Personal Agent/Hive Backups" "$old"
