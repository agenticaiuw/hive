#!/bin/bash
# One attempt after the next login; the engine itself refuses unsafe recovery.
set -u
script_dir="$(cd "$(dirname "$0")" && pwd)"
log_file="$HOME/Library/Logs/PersonalAgent-workspace-recovery.log"
plist="$HOME/Library/LaunchAgents/local.personal-agent.workspace-recovery.plist"
sleep 30
{
  date
  echo 'Attempting the documented idle-host display recovery.'
  bash "$script_dir/recover-spaceo.sh"
  result=$?
  echo "Recovery exit status: $result"
} >> "$log_file" 2>&1
rm -f "$plist"
