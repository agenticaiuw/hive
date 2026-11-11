#!/bin/bash
# Replace one app path with a verified candidate, preserving a rollback copy.
# Does not stop/restart the app or alter launch items, helpers, or user state.
set -euo pipefail
if [ "$#" -lt 3 ] || [ "$#" -gt 4 ]; then echo 'Usage: hive-app-transaction.sh CANDIDATE.app EXISTING.app BACKUP_DIR [DESTINATION.app]' >&2; exit 2; fi
candidate=$1
installed=$2
backup_dir=$3
destination=${4:-$installed}
script_dir=$(cd "$(dirname "$0")" && pwd)
rename_exclusive() { python3 "$script_dir/rename-exclusive.py" "$1" "$2"; }
[ -d "$candidate/Contents" ] && [ -d "$installed/Contents" ] || { echo 'Candidate and existing apps must exist.' >&2; exit 1; }
if [ "$destination" != "$installed" ] && [ -e "$destination" ]; then echo 'Destination already exists; refusing duplicate installation.' >&2; exit 1; fi
lock="${installed}.hive-install-lock"
mkdir "$lock" || { echo 'Another app transaction may be active; verify before removing its lock.' >&2; exit 1; }
trap 'rmdir "$lock"' EXIT
expected='local.personal-agent.Agent'
for app in "$candidate" "$installed"; do
  [ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$app/Contents/Info.plist")" = "$expected" ] || { echo 'Bundle identity mismatch.' >&2; exit 1; }
  codesign --verify --deep --strict "$app"
done
if [ "${HIVE_ROLLBACK:-}" != 1 ]; then
  [ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleDisplayName' "$candidate/Contents/Info.plist")" = Hive ] || { echo 'Candidate display name is not Hive.' >&2; exit 1; }
fi
authorities() { codesign -dv --verbose=4 "$1" 2>&1 | awk '/^Authority=|^TeamIdentifier=/'; }
old_authority=$(authorities "$installed")
new_authority=$(authorities "$candidate")
old_entitlements=$(codesign -d --entitlements :- "$installed" 2>/dev/null | shasum -a 256 | awk '{print $1}')
new_entitlements=$(codesign -d --entitlements :- "$candidate" 2>/dev/null | shasum -a 256 | awk '{print $1}')
[ "$old_entitlements" = "$new_entitlements" ] || { echo 'App entitlements differ; refusing replacement.' >&2; exit 1; }
if [ "${HIVE_INSTALL_TEST_ADHOC:-}" = 1 ]; then
  case "$installed" in /tmp/*|/private/tmp/*|/var/folders/*) ;; *) echo 'Ad-hoc test mode is limited to temporary fixtures.' >&2; exit 1;; esac
else
  [ -n "$old_authority" ] && [ "$old_authority" = "$new_authority" ] && printf '%s' "$old_authority" | grep -q '^Authority=' || { echo 'Signing identities differ or are ad hoc; refusing replacement.' >&2; exit 1; }
fi
mkdir -p "$backup_dir"
stamp=$(date -u +%Y%m%dT%H%M%SZ)-$$
backup="$backup_dir/Agent-$stamp.app"
stage="${destination}.hive-stage-$stamp"
previous="${installed}.hive-previous-$stamp"
failed="${destination}.hive-failed-$stamp"
[ ! -e "$backup" ] && [ ! -e "$stage" ] && [ ! -e "$previous" ] || { echo 'Recovery path already exists.' >&2; exit 1; }
ditto "$installed" "$backup"
codesign --verify --deep --strict "$backup"
ditto "$candidate" "$stage"
codesign --verify --deep --strict "$stage"
restore() {
  if [ -d "$previous" ]; then
    if [ "${candidate_installed:-0}" = 1 ] && [ -e "$destination" ]; then rename_exclusive "$destination" "$failed"; fi
    if [ ! -e "$installed" ]; then rename_exclusive "$previous" "$installed"; fi
  fi
  if [ -d "$stage" ]; then rm -rf "$stage"; fi
  rmdir "$lock"
}
trap restore EXIT
rename_exclusive "$installed" "$previous"
if [ "${HIVE_TEST_FAIL_AFTER_MOVE:-}" = 1 ] && [ "${HIVE_INSTALL_TEST_ADHOC:-}" = 1 ]; then exit 1; fi
rename_exclusive "$stage" "$destination"
candidate_installed=1
codesign --verify --deep --strict "$destination"
rename_exclusive "$previous" "$backup_dir/Original-$stamp"
# Retain both old copies outside Applications for explicit rollback.
rmdir "$lock"
trap - EXIT
printf 'Updated %s. Rollback copies: %s and %s\n' "$destination" "$backup" "$backup_dir/Original-$stamp"
