#!/usr/bin/env bash
# Hive's nightly dream on its cloud VM, run as root by hive-dream.service (install.sh puts a copy
# of this file in /var/lib/hive-dream). It brings the repo clone up to main, builds hive-dream,
# mirrors what the Mac uploaded (`hive-dream sync`), runs the night (collect, up to three fixes by
# Hive's VM agent, test first, sent to a dream/* branch for the macOS check), and puts the morning
# report in R2 (hive-recordings/dream/<date>/report.md).
#
#   nightly.sh [--force]     --force runs again on a night that already ran
set -euo pipefail

ROOT=${HIVE_DREAM_ROOT:-/var/lib/hive-dream}
export RUSTUP_HOME=$ROOT/rustup CARGO_HOME=$ROOT/cargo
export PATH=$CARGO_HOME/bin:/usr/local/bin:/usr/bin:/bin
export HIVE_DREAM_DIR=$ROOT/dream HIVE_DREAM_REPO=$ROOT/hive
export AGENT_STATE_DIR=$HIVE_DREAM_DIR/mirror/state
export HIVE_AGENT_LOG=$HIVE_DREAM_DIR/mirror/Agent.log
export HIVE_RECORDINGS_DIR=$HIVE_DREAM_DIR/mirror/recordings
export HIVE_DREAM_AGENT=vm HIVE_DREAM_CI=1
BUCKET=${HIVE_R2_BUCKET:-hive-recordings}
umask 077
mkdir -p "$HIVE_DREAM_DIR"

say() { echo "$(date -u +%FT%TZ) nightly.sh: $*"; }

# The clone follows main; only the dream's own worktrees branch off it.
git -C "$HIVE_DREAM_REPO" fetch --quiet origin main
git -C "$HIVE_DREAM_REPO" reset --quiet --hard origin/main
git -C "$HIVE_DREAM_REPO" worktree prune
say "main is at $(git -C "$HIVE_DREAM_REPO" log -1 --format='%h %s')"

# The gate's tests run offline, so everything main needs is fetched first.
cargo fetch --quiet --locked --manifest-path "$HIVE_DREAM_REPO/desktop/app/crates/hive/Cargo.toml"
cargo build --quiet --release --locked -p hive-dream \
  --manifest-path "$HIVE_DREAM_REPO/desktop/app/crates/hive/Cargo.toml" --target-dir "$ROOT/gate-target"
DREAM=$ROOT/gate-target/release/hive-dream

say "$("$DREAM" sync)"
"$DREAM" nightly "$@"

# The morning report goes to the cloud with everything else.
night=$(find "$HIVE_DREAM_DIR" -maxdepth 1 -type d -name '20[0-9][0-9]-[01][0-9]-[0-3][0-9]' -printf '%f\n' | sort | tail -1)
report=$HIVE_DREAM_DIR/$night/report.md
if [ -n "$night" ] && [ -f "$report" ]; then
  bash -lc 'wrangler r2 object put "$1/dream/$2/report.md" --remote --file "$3" --content-type "text/markdown; charset=utf-8" >/dev/null' \
    nightly "$BUCKET" "$night" "$report" && say "report: r2://$BUCKET/dream/$night/report.md"
fi
