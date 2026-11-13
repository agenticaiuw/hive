//! The Codex app-server driver: sessions, tasks, goals, recovery (python/agent.py,
//! codex_app.py, provider_wait.py and the task-recovery state).
//!
//! - [`Agent`]: the agent's Codex: how its app-server is started, the thread parameters, the one
//!   server every task shares and the current conversation. The app makes one, with its [`Hooks`].
//! - [`ClaudeSession`]: the conversation on Claude instead (`AGENT_BACKEND=claude`, claude_agent.py):
//!   turns on one `claude` CLI process, driven like the Claude Agent SDK.
//! - [`Session`]: a conversation: one durable Codex thread (`codex-thread-id`) with a turn for
//!   each request.
//! - [`CodexTask`]: one request, its goal, the watchdog that keeps an active goal going, and
//!   recovery after Codex stops or the provider can't be reached.
//! - [`LookAhead`] / [`first_look`]: the screenshot sent with a request.
//! - [`describe_timing`]: the ⏱ line.
//! - [`task_recovery`], [`provider_wait`]: the state files that let a request continue after a
//!   restart or a provider outage.

mod agent;
mod app_server;
mod claude;
mod describe;
mod hooks;
mod look;
pub mod prompts;
pub mod provider_wait;
pub mod py;
mod session;
mod task;
pub mod task_recovery;
mod util;

#[cfg(test)]
mod tests;

pub use agent::{
    focus, print_event, Agent, Config, BUNDLED_CODEX, COMPACT_AT, EFFORT, MODEL, USAGE,
};
pub use app_server::{same_server, AppServer, OnMessage, OnToolCall, Server, DEFAULT_TIMEOUT};
pub use claude::{ClaudeSession, MODEL as CLAUDE_MODEL};
pub use describe::{describe_call, describe_timing, doing, sentence_ends, tool_error, Timing};
pub use hooks::{
    ActionLog, ActionTask, ContextRecorder, DeviceTools, FileProviderWait, Hooks, Knowledge,
    Memory, NoActionLog, NoContext, NoKnowledge, NoMemory, NoWorkspaceTools, ProviderWait,
    WorkspaceTools,
};
pub use look::{first_look, LookAhead, LOOK_AHEAD_FRESH};
pub use session::{forget, Session, TaskSession};
pub use task::{CodexTask, OnEvent, TaskOptions};
pub use task_recovery::{startup_recovery_record, OwnerLock};
pub use util::{monotonic, AgentError, Env, Event};
