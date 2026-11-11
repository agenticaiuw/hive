//! Knowledge base, cloud archive, memory search, task recording, session journal, context panel.
//!
//! The Rust port of Hive's Python modules of the same names (python/knowledge.py,
//! cloud_archive.py, task_recording.py, session_journal.py, context_panel.py, agent_context.py,
//! memory_search.py, ui_ingress.py): same files on disk, same strings, same environment variables.
//! Everything blocks; the few background jobs run on their own named threads.

pub mod agent_context;
pub mod cloud_archive;
pub mod context_panel;
pub mod knowledge;
pub mod memory_search;
pub mod pyjson;
pub mod session_journal;
pub mod task_recording;
pub mod ui_ingress;
pub mod util;

/// A callback for one line of progress (Python's `report=print`-style arguments).
pub type Report = std::sync::Arc<dyn Fn(&str) + Send + Sync>;
