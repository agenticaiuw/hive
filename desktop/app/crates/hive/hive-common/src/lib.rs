//! What every Hive crate shares.
//!
//! - [`paths`]: the repository, its build folder and the agent's state folder.
//! - [`settings`]: the `.env` file at the top of the repository, loaded into the environment.
//! - [`tools`]: the contract between a device's tools (`mac`, `phone`) and the Codex driver,
//!   in MCP's result shape, and the conversion to Codex's dynamic-tool replies.
//! - [`ingest`]: text the user added to the conversation (python/ingest.py).
//! - [`mcp`]: a minimal MCP server over stdio, for tools Codex starts as its own process.

pub mod ingest;
pub mod mcp;
pub mod paths;
pub mod settings;
pub mod tools;

pub use personal_agent_core::thread_identity::{atomic_write, validate_identity, ResumableThread};
pub use paths::{build_dir, python_dir, repo_root, state_dir};

/// Prints one line for Agent.log (the app host copies the agent's stdout there) and flushes it.
pub fn say(line: impl AsRef<str>) {
    use std::io::Write;
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{}", line.as_ref());
    let _ = out.flush();
}
