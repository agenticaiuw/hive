//! hive-dream: Hive's nightly self-review. `collect` reads what went wrong since the last run
//! (journals, task recordings, Agent.log; no model) into clusters of normalised failure
//! signatures; `fix` hands the cluster that lost the most time to Codex in a private git
//! worktree, asking for a failing test and a code fix; a deterministic gate decides whether the
//! branch is proposed or rejected; `land` cherry-picks a proposed branch onto main when a person
//! runs it. Nothing here merges, pushes, restarts Hive, uses the screen or sends a message.

pub mod agentlog;
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
pub mod time;
pub mod timeline;
