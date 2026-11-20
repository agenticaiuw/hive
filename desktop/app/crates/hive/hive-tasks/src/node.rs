//! What this machine's Hive runs, for the board (cloud/tasks/nodes.js). Every call to the board says
//! which node it is (x-hive-node: "mac:owner-mbp" for Hive's agent on a Mac, "cli:…" for the
//! hive-tasks command and its hooks), the release it runs (x-hive-version: set when a release is
//! built, "dev" for a build made by hand) and the board routes it was written against
//! (x-hive-protocol). The board writes it down for the dashboard, answers with the newest release
//! for this kind of node (x-hive-latest, kept here for the updater), and refuses routes it no
//! longer serves with what to do, which comes back as the call's error.

use std::sync::{Mutex, OnceLock};

/// The board's routes this code was written against (cloud/shared/protocol.json).
pub const PROTOCOL: u32 = 1;

/// This build's release (`HIVE_VERSION` when it was built), or "dev" for a build made by hand.
pub const VERSION: &str = match option_env!("HIVE_VERSION") {
    Some(v) => v,
    None => "dev",
};

static KIND: OnceLock<&'static str> = OnceLock::new();
static LATEST: Mutex<Option<String>> = Mutex::new(None);

/// Says which kind of node this program is, once, before its first call: "mac" for Hive's agent on
/// a Mac. Anything that never says (the hive-tasks command, its hooks) is "cli".
pub fn set_kind(kind: &'static str) {
    let _ = KIND.set(kind);
}

pub fn kind() -> &'static str {
    KIND.get().copied().unwrap_or("cli")
}

/// The headers a call from `machine` carries.
pub fn headers(machine: &str) -> [(&'static str, String); 3] {
    [
        ("x-hive-node", format!("{}:{}", kind(), machine.to_lowercase())),
        ("x-hive-version", VERSION.to_string()),
        ("x-hive-protocol", PROTOCOL.to_string()),
    ]
}

/// The newest release the board last named for this kind of node, if it has named one.
pub fn latest() -> Option<String> {
    LATEST.lock().ok()?.clone()
}

pub(crate) fn saw_latest(latest: Option<&str>) {
    if let (Some(v), Ok(mut held)) = (latest, LATEST.lock()) {
        if held.as_deref() != Some(v) {
            *held = Some(v.to_string());
        }
    }
}

/// Whether this build should put in `latest` by itself: a release build on an older release. A build
/// made by hand ("dev") is the owner's work in progress and is never replaced.
pub fn wants_update(latest: Option<&str>) -> bool {
    matches!(latest, Some(v) if VERSION != "dev" && v != VERSION)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_call_says_which_node_and_release_and_routes() {
        let [node, version, protocol] = headers("Owner-MBP");
        assert_eq!(node, ("x-hive-node", format!("{}:owner-mbp", kind())));
        assert_eq!(version, ("x-hive-version", VERSION.to_string()));
        assert_eq!(protocol, ("x-hive-protocol", PROTOCOL.to_string()));
    }

    #[test]
    fn only_a_release_build_on_an_older_release_updates_itself() {
        assert!(!wants_update(None));
        if VERSION == "dev" {
            assert!(!wants_update(Some("9c1b2a3d4e5f")), "a build made by hand is never replaced");
        } else {
            assert!(wants_update(Some("000000000000")));
            assert!(!wants_update(Some(VERSION)));
        }
    }

    #[test]
    fn the_newest_release_the_board_named_is_kept() {
        saw_latest(None);
        saw_latest(Some("9c1b2a3d4e5f"));
        assert_eq!(latest().as_deref(), Some("9c1b2a3d4e5f"));
    }
}
