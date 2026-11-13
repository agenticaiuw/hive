//! hive-dream: Hive's nightly self-review, done by Hive's own agent, on Hive's cloud VM. `sync`
//! mirrors what the Mac uploaded to R2 (journals, recordings' timelines, Agent.log); `collect`
//! reads it (no model) into clusters of normalised failure signatures; `fix` hands the cluster
//! that lost the most time to Hive's VM agent in a private git worktree: first a test that must
//! fail on the code as it is, then the fix; a deterministic gate decides whether the branch is
//! proposed or rejected; `ci` sends a proposed branch to the macOS check on GitHub Actions, which
//! runs the tests Linux can't and squash-merges it into main when they pass. `land` lands a branch
//! by hand. Nothing here uses the screen or sends a message.

pub mod agentlog;
pub mod ci;
pub mod collect;
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
pub mod sync;
pub mod time;
pub mod timeline;
