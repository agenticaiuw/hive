//! hive-dream: Hive's nightly self-review, done by Hive's own agent. `collect` reads what went
//! wrong since the last run (journals, task recordings, Agent.log; no model) into clusters of
//! normalised failure signatures; `fix` hands the cluster that lost the most time to Hive's agent
//! (a request through Hive's socket) in a private git worktree: first a test that must fail on the
//! code as it is, then the fix; a deterministic gate decides whether the branch is proposed or
//! rejected; the nightly run (`deploy`) lands a proposed fix on main, builds, pushes and restarts
//! Hive when nobody is using it, and `land` does the landing by hand. Nothing here uses the screen
//! or sends a message.

pub mod agentlog;
pub mod ci;
pub mod collect;
pub mod deploy;
pub mod evidence;
pub mod fix;
pub mod gate;
pub mod git;
pub mod journal;
pub mod land;
pub mod normalize;
pub mod paths;
pub mod proc;
pub mod register;
pub mod report;
pub mod rustscan;
pub mod schedule;
pub mod time;
pub mod timeline;
