//! A conversation (agent.py's `Session`): the requests from when you tap fn to talk are turns on
//! one Codex thread, so each has the ones before it in context: what you said, what it saw and
//! did, and what it answered. Codex compacts the thread when it gets long.
//!
//! The thread's identity (`codex-thread-id` in the state folder) survives app and server
//! restarts: agent-core's [`ResumableThread`] resumes it, and only a missing identity starts a new
//! one. A thread takes one turn at a time. A request that replaces one being stopped waits a
//! moment for Codex to end that turn. One for the other device while a turn is under way (the
//! phone while the Mac works) gets a thread of its own, told what was said so far, and the
//! session's thread is told what came of it with its next request.
//!
//! [`Session::prepare`] starts the thread before the first request: Codex gets its connection to
//! the model ready when a thread starts, and the first request on a thread started a few seconds
//! earlier gets its first words 1 to 2.5 s sooner.

use crate::agent::Agent;
use crate::app_server::{same_server, OnMessage, OnToolCall, Server, DEFAULT_TIMEOUT};
use crate::prompts;
use crate::py;
use crate::task::CodexTask;
use crate::util::{lock, AgentError, Event};
use personal_agent_core::thread_identity::{
    validate_identity, IdentityError, ResumableThread, SessionTransport,
};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, Weak};

/// What a task needs from its conversation (a [`Session`]; the tests give their own).
pub trait TaskSession: Send + Sync {
    /// The task is one of its requests (at its start).
    fn add(&self, task: &Arc<CodexTask>);
    /// The thread for the task's turn (the session's own when it's free, else a new one, which
    /// `params` start) and what to tell it before the request: what was said that it hasn't seen.
    /// `expected_thread`: recovering that saved conversation (never another).
    fn thread_for(
        &self,
        task: &Arc<CodexTask>,
        server: &Arc<dyn Server>,
        params: Value,
        expected_thread: Option<&str>,
    ) -> Result<(String, String), AgentError>;
    /// The task's turn didn't start after all.
    fn release(&self, task: &CodexTask);
    /// Why the thread's context couldn't be recorded, if it couldn't.
    fn context_error(&self) -> Option<String>;
    /// Its requests, oldest first (for what the user said lately: `CodexTask::words`).
    fn tasks(&self) -> Vec<Arc<CodexTask>> {
        Vec::new()
    }
}

/// Unsubscribes from a thread without deleting its persisted history.
pub fn forget(server: &dyn Server, thread: &str) {
    server.detach(thread);
    let _ = server.request("thread/unsubscribe", json!({"threadId": thread}), 5.0);
}

#[derive(Default)]
struct Inner {
    /// Loaded lazily, after settings and test isolation are configured.
    identity: Option<ResumableThread>,
    server: Option<Arc<dyn Server>>,
    /// The session's thread on `server`.
    thread: Option<String>,
    closed: bool,
}

/// One conversation. Make it with [`Session::new`] (or use the agent's: [`Agent::session`]).
pub struct Session {
    agent: Weak<Agent>,
    state_path: Option<PathBuf>,
    me: Weak<Session>,
    /// Python's `_lock`: held while the thread is connected (never while the owner is told
    /// something, so notifications that come during a resume get through).
    inner: Mutex<Inner>,
    /// The task whose turn is on the thread, or was last.
    owner: Mutex<Option<Arc<CodexTask>>>,
    /// Its requests, oldest first.
    tasks: Mutex<Vec<Arc<CodexTask>>>,
    context_error: Mutex<Option<String>>,
    /// No turn under way on the thread.
    idle: Event,
}

impl Session {
    /// A conversation whose identity is saved at `state_path` (default: `codex-thread-id` in the
    /// state folder).
    pub fn new(agent: &Arc<Agent>, state_path: Option<PathBuf>) -> Arc<Session> {
        Self::with_agent(Arc::downgrade(agent), state_path)
    }

    pub(crate) fn with_agent(agent: Weak<Agent>, state_path: Option<PathBuf>) -> Arc<Session> {
        Arc::new_cyclic(|me| Session {
            agent,
            state_path,
            me: me.clone(),
            inner: Mutex::new(Inner::default()),
            owner: Mutex::new(None),
            tasks: Mutex::new(Vec::new()),
            context_error: Mutex::new(None),
            idle: Event::new(true),
        })
    }

    fn agent(&self) -> Result<Arc<Agent>, AgentError> {
        self.agent
            .upgrade()
            .ok_or_else(|| AgentError::Resume("Conversation is closed".into()))
    }

    /// Where its identity is saved.
    pub fn state_path(&self) -> PathBuf {
        match (&self.state_path, self.agent.upgrade()) {
            (Some(path), _) => path.clone(),
            (None, Some(agent)) => agent.state_dir().join("codex-thread-id"),
            (None, None) => hive_common::state_dir().join("codex-thread-id"),
        }
    }

    /// Its requests, oldest first.
    pub fn tasks(&self) -> Vec<Arc<CodexTask>> {
        lock(&self.tasks).clone()
    }

    /// One of its requests is running.
    pub fn busy(&self) -> bool {
        self.tasks().iter().any(|t| t.running())
    }

    /// The session's thread, once connected.
    pub fn thread(&self) -> Option<String> {
        lock(&self.inner).thread.clone()
    }

    /// No turn is under way on its thread.
    pub fn idle(&self) -> bool {
        self.idle.is_set()
    }

    /// Starts the session's thread now, in the background, if Codex is running.
    pub fn prepare(&self) {
        let Some(me) = self.me.upgrade() else { return };
        std::thread::spawn(move || me.prepare_now());
    }

    pub(crate) fn prepare_now(&self) {
        let Ok(agent) = self.agent() else { return };
        let Some(server) = agent.running_server() else {
            return; // the first request starts Codex, and the thread
        };
        let mut inner = lock(&self.inner);
        if inner.closed
            || inner.thread.is_some()
            || inner
                .server
                .as_ref()
                .is_some_and(|s| !same_server(s, &server))
        {
            return;
        }
        let Ok(params) = agent.thread_params() else {
            return;
        };
        // The first request tries again, and says what's wrong.
        let Ok(thread) = self.connect(&agent, &mut inner, &server, &params) else {
            return;
        };
        inner.server = Some(server.clone());
        inner.thread = Some(thread.clone());
        let (on_message, on_tool_call) = self.handlers();
        server.attach(&thread, on_message, on_tool_call);
    }

    /// Ends it: unsubscribes from its thread (in the background: prepare() may still be at it).
    pub fn close(&self) {
        let Some(me) = self.me.upgrade() else { return };
        std::thread::spawn(move || me.close_now());
    }

    pub(crate) fn close_now(&self) {
        let (server, thread) = {
            let mut inner = lock(&self.inner);
            inner.closed = true;
            (inner.server.clone(), inner.thread.take())
        };
        if let (Some(server), Some(thread)) = (server, thread) {
            if server.alive() {
                forget(server.as_ref(), &thread);
            }
        }
    }

    /// The thread's notifications and tool calls, for whichever task owns it.
    fn handlers(&self) -> (OnMessage, OnToolCall) {
        let (a, b) = (self.me.clone(), self.me.clone());
        (
            Arc::new(move |method: &str, params: &Value| {
                if let Some(session) = a.upgrade() {
                    session.on_message(method, params);
                }
            }),
            Arc::new(move |params: &Value| match b.upgrade() {
                Some(session) => session.call_tool(params),
                None => hive_common::tools::reply_text(false, "Failed: the conversation is closed"),
            }),
        )
    }

    fn on_message(&self, method: &str, params: &Value) {
        let owner = lock(&self.owner).clone();
        if let Some(owner) = &owner {
            owner.on_message(method, params);
        }
        if method == "turn/started" {
            self.idle.clear();
        } else if (method == "turn/completed" || method == "exited")
            && owner.as_ref().is_none_or(|o| !o.running())
        {
            self.idle.set();
        }
    }

    fn call_tool(&self, params: &Value) -> Value {
        let owner = lock(&self.owner).clone();
        match owner {
            Some(owner) => owner.call_tool(params),
            None => {
                hive_common::tools::reply_text(false, "Failed: no request owns this conversation")
            }
        }
    }

    /// The saved identity, read as it is (`ResumableThread.validate(path.read_text().strip())`).
    fn saved_identity(&self) -> Result<Option<String>, AgentError> {
        match std::fs::read(self.state_path()) {
            Ok(bytes) => {
                let text = String::from_utf8(bytes)
                    .map_err(|_| AgentError::Value("invalid UTF-8".into()))?;
                let id = validate_identity(py::strip(&text))
                    .map_err(|e| AgentError::Resume(e.to_string()))?;
                Ok(Some(id.to_owned()))
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    /// Connects (resumes, or starts if there's none saved) the session's thread on `server`,
    /// recording each step for the context inspector (Python's `Session._connect`).
    fn connect(
        &self,
        agent: &Agent,
        inner: &mut Inner,
        server: &Arc<dyn Server>,
        params: &Value,
    ) -> Result<String, AgentError> {
        let path = self.state_path();
        let identity = inner
            .identity
            .get_or_insert_with(|| ResumableThread::new(path.clone()));
        let recorder = agent.hooks.context.clone();
        let observe = |kind: &str, payload: &Value, thread: Option<&str>| {
            let recorded = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                recorder.record(kind, payload, None, thread)
            }))
            .unwrap_or_else(|panic| Err(crate::util::panic_text(&*panic)));
            if let Err(error) = recorded {
                *lock(&self.context_error) = Some(error);
            }
        };
        let mut transport = Transport {
            server: server.as_ref(),
            prior: identity.thread_id().map(str::to_owned),
            method: None,
            last: None,
            observe: &observe,
        };
        match identity.connect(&mut transport, params) {
            Ok(id) => {
                if let Some(method) = &transport.method {
                    observe(
                        &format!("{method} output"),
                        transport.last.as_ref().unwrap_or(&Value::Null),
                        Some(&id),
                    );
                }
                Ok(id)
            }
            Err(error) => {
                let saved = identity.thread_id().map(str::to_owned);
                if let Some(method) = &transport.method {
                    observe(
                        &format!("{method} error"),
                        &json!({"error": error.to_string(), "savedThreadId": saved}),
                        saved.as_deref(),
                    );
                }
                let io = matches!(&error, IdentityError::Io { source, .. } if source.kind() != std::io::ErrorKind::InvalidData);
                if transport.method.is_none() && io {
                    return Err(AgentError::Os(error.to_string()));
                }
                Err(AgentError::Resume(format!(
                    "{error}; saved state: {}",
                    path.display()
                )))
            }
        }
    }

    /// Connects its identity directly (Python's `ResumableThread(path).connect(server, params)`, for
    /// the tests).
    #[cfg(test)]
    pub(crate) fn connect_now(
        &self,
        server: &Arc<dyn Server>,
        params: &Value,
    ) -> Result<String, AgentError> {
        let agent = self.agent()?;
        let mut inner = lock(&self.inner);
        self.connect(&agent, &mut inner, server, params)
    }

    /// The requests before `task` and what came of them: all of them, for a thread of its own;
    /// for the session's thread, those that ran elsewhere and it hasn't been told about.
    fn said_before(&self, task: &Arc<CodexTask>, everything: bool) -> Result<String, AgentError> {
        let tasks = self.tasks();
        let index = tasks
            .iter()
            .position(|t| Arc::ptr_eq(t, task))
            .ok_or_else(|| AgentError::Value("the request is not in this conversation".into()))?;
        let mut lines = Vec::new();
        for t in &tasks[..index] {
            if everything || !(t.on_thread() || t.told()) {
                lines.push(format!(
                    "  They asked: {}",
                    py::dumps(&json!(t.task()), false)
                ));
                lines.push(format!("  You: {}", t.outcome()));
                if !everything && !t.running() {
                    t.set_told();
                }
            }
        }
        if lines.is_empty() {
            return Ok(String::new());
        }
        Ok(format!("{}{}\n\n", prompts::SAID_BEFORE, lines.join("\n")))
    }
}

/// The app-server, as agent-core's identity logic sees it: each request goes to Codex, and is
/// recorded for the context inspector ("{method} input", then "output" or "error").
struct Transport<'a> {
    server: &'a dyn Server,
    /// The identity before this connect (the thread the inspector files a start under).
    prior: Option<String>,
    method: Option<String>,
    last: Option<Value>,
    observe: &'a dyn Fn(&str, &Value, Option<&str>),
}

impl SessionTransport for Transport<'_> {
    fn request(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let thread = match method {
            "thread/resume" => params
                .get("threadId")
                .and_then(Value::as_str)
                .map(str::to_owned),
            _ => self.prior.clone(),
        };
        self.method = Some(method.to_owned());
        (self.observe)(&format!("{method} input"), &params, thread.as_deref());
        let result = self
            .server
            .request(method, params, DEFAULT_TIMEOUT)
            .map_err(|e| e.to_string())?;
        self.last = Some(result.clone());
        Ok(result)
    }
}

impl TaskSession for Session {
    fn add(&self, task: &Arc<CodexTask>) {
        lock(&self.tasks).push(task.clone());
    }

    fn tasks(&self) -> Vec<Arc<CodexTask>> {
        Session::tasks(self)
    }

    fn thread_for(
        &self,
        task: &Arc<CodexTask>,
        server: &Arc<dyn Server>,
        params: Value,
        expected_thread: Option<&str>,
    ) -> Result<(String, String), AgentError> {
        let agent = self.agent()?;
        let owner = {
            let mut inner = lock(&self.inner);
            if inner.closed {
                return Err(AgentError::Resume("Conversation is closed".into()));
            }
            if !inner
                .server
                .as_ref()
                .is_some_and(|s| same_server(s, server))
            {
                // the first request, or Codex restarted
                inner.server = Some(server.clone());
                inner.thread = None;
                *lock(&self.owner) = None;
                self.idle.set();
            }
            lock(&self.owner).clone()
        };
        if owner.is_some_and(|o| !o.running()) {
            self.idle.wait(Some(10.0)); // it was stopped: Codex ends its turn in a moment
        }
        let told = {
            let mut inner = lock(&self.inner);
            if let Some(expected) = expected_thread {
                let saved = match self.saved_identity() {
                    Ok(Some(saved)) => saved,
                    Ok(None) | Err(AgentError::Value(_)) => {
                        return Err(AgentError::Resume(
                            "Saved conversation is unavailable during recovery".into(),
                        ))
                    }
                    Err(other) => return Err(other),
                };
                if saved != expected || inner.thread.as_deref().is_some_and(|t| t != expected) {
                    return Err(AgentError::Resume(
                        "Saved conversation changed during recovery".into(),
                    ));
                }
                if !self.idle.is_set() {
                    return Err(AgentError::Resume(
                        "Saved conversation is already owned by another task".into(),
                    ));
                }
            }
            if self.idle.is_set() {
                *lock(&self.owner) = Some(task.clone());
                task.set_on_thread(true);
                self.idle.clear();
                if inner.thread.is_none() {
                    // Attach before resume: an active goal may emit its next turn or request a
                    // tool as soon as the persisted thread loads.
                    let mut preattached = None;
                    let connected = (|| -> Result<String, AgentError> {
                        preattached = self.saved_identity()?;
                        if let Some(id) = &preattached {
                            let (on_message, on_tool_call) = self.handlers();
                            server.attach(id, on_message, on_tool_call);
                        }
                        let thread = self.connect(&agent, &mut inner, server, &params)?;
                        let (on_message, on_tool_call) = self.handlers();
                        server.attach(&thread, on_message, on_tool_call);
                        Ok(thread)
                    })();
                    match connected {
                        Ok(thread) => inner.thread = Some(thread),
                        Err(error) => {
                            if let Some(id) = &preattached {
                                server.detach(id);
                            }
                            *lock(&self.owner) = None;
                            task.set_on_thread(false);
                            self.idle.set();
                            return Err(error);
                        }
                    }
                }
                let thread = inner.thread.clone().unwrap_or_default();
                drop(inner);
                return Ok((thread, self.said_before(task, false)?));
            }
            drop(inner);
            self.said_before(task, true)?
        };
        task.record_context("thread/start input", &params);
        let result = server.request("thread/start", params, DEFAULT_TIMEOUT)?;
        task.record_context("thread/start output", &result);
        let thread = result
            .get("thread")
            .and_then(|t| t.get("id"))
            .and_then(Value::as_str)
            .ok_or_else(|| AgentError::Value("'thread'".into()))?
            .to_owned();
        let (on_message, on_tool_call) = task.handlers();
        server.attach(&thread, on_message, on_tool_call);
        Ok((thread, told))
    }

    fn release(&self, task: &CodexTask) {
        let _inner = lock(&self.inner);
        if lock(&self.owner)
            .as_ref()
            .is_some_and(|o| std::ptr::eq(o.as_ref(), task))
        {
            self.idle.set();
        }
    }

    fn context_error(&self) -> Option<String> {
        lock(&self.context_error).clone()
    }
}
