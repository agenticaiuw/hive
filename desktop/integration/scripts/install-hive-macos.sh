#!/bin/bash
# Upgrade the existing app to Hive.app while keeping bundle ID and data paths.
# This script never starts or stops the app or changes login-item registration.
set -euo pipefail
if [ "$#" -ne 1 ]; then echo 'Usage: install-hive-macos.sh /path/to/verified/Hive.app' >&2; exit 2; fi
repo_root=$(cd "$(dirname "$0")/../../.." && pwd)
old="$HOME/Applications/Agent.app"
new="$HOME/Applications/Hive.app"
if [ -e "$old" ] && [ -e "$new" ]; then echo 'Both app paths exist; resolve the duplicate before migration.' >&2; exit 1; fi
if ps -axo comm= | grep -Fxq "$old/Contents/MacOS/Agent" || ps -axo comm= | grep -Fxq "$new/Contents/MacOS/Agent"; then
  echo 'The app is running; stop it before replacing its bundle.' >&2; exit 1
fi
if [ -d "$old" ]; then current=$old; elif [ -d "$new" ]; then current=$new; else echo 'No existing app found.' >&2; exit 1; fi
exec "$repo_root/desktop/integration/scripts/hive-app-transaction.sh" "$1" "$current" "$HOME/Library/Application Support/Personal Agent/Hive Backups" "$new"
