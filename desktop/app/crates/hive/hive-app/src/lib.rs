//! Hive's desktop agent: the voice shell Hive.app runs (python/voice_agent.py), its event loop,
//! and the wiring of the other hive crates into it.
//!
//! - [`shell`]: [`VoiceAgent`], the event loop and everything it does with what it hears.
//! - [`parts`]: what the shell works with, as traits (the tests give fakes).
//! - [`real`]: the real parts: the voice sidecar, the captions window, the helper,
//!   Codex with its hooks, the workspace, the request socket and the update.
//! - [`cloud_brain`]: the brain in the cloud: requests go to Hive's cloud agent, and this Mac serves
//!   its calls on the Mac's tools.
//! - [`app`]: `hive-agent` (and `hive-agent --task`); [`auth_mcp`]: `hive-auth-mcp`; [`phone_mcp`]: `hive-phone-mcp`.
//! - [`util`]: voice_agent.py's module-level pieces.

pub mod app;
pub mod auth_mcp;
pub mod cloud_brain;
pub mod live;
pub mod parts;
pub mod phone_mcp;
pub mod real;
pub mod shell;
pub mod util;

pub use shell::{describe_timing, Event, Parts, Tasks, Timing, VoiceAgent};
