//! Choose an update that keeps an active virtual display's engine compatible
//! (python/workspace_update.py). The decision itself is agent-core's `workspace_update`, which the
//! updater already uses through its `workspace-engine-choice` binary; this is the same pair of
//! functions plus the `workspace-update CANDIDATE INSTALLED` command line python had.

pub use personal_agent_core::workspace_update::{
    compare_engines, decision, doctor, EngineChoice, DOCTOR_TIMEOUT,
};

use std::path::Path;

/// `workspace-update CANDIDATE INSTALLED`: prints `new`, `preserve` or `unsafe`.
pub fn main(args: &[String]) -> i32 {
    let [candidate, installed] = args else {
        eprintln!("Usage: workspace-update CANDIDATE INSTALLED");
        return 1;
    };
    println!(
        "{}",
        compare_engines(Path::new(candidate), Path::new(installed), DOCTOR_TIMEOUT).as_str()
    );
    0
}
