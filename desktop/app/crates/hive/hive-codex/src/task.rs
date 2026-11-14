//! One request, run on the shared app-server in the background (agent.py's `CodexTask`): its
//! turn on the session's thread, the goal that keeps Codex going until the request is done, the
//! watchdog that wakes an idle goal, recovery after Codex stops, and the wait for the provider
//! after a connection failure.

use crate::agent::Agent;
use crate::app_server::{OnMessage, OnToolCall, Server, DEFAULT_TIMEOUT};
use crate::describe::{describe_call, doing, sentence_ends, tool_error};
use crate::hooks::Knowledge;
use crate::look::{first_look, LookAhead};
use crate::prompts;
use crate::provider_wait::{Reservation, INTERVAL_SECONDS};
use crate::py;
use crate::session::{forget, TaskSession};
use crate::task_recovery::{self, OwnerLock};
use crate::util::{lock, monotonic, panic_text, unix_time, AgentError, Event};
use hive_common::tools::{tool_reply, ToolNamespace};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs::File;
use std::io::Write;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, Weak};

/// A task's events: `(kind, text)`, where kind is "action" (a tool call, for the activity view),
/// "doing" (what it's doing in plain words, or "Thinking"), "announce" (a step that can't be
/// undone, as it happens), "error", "say" (a sentence of the
/// reply, as soon as it's written), "think" (a reasoning summary), "plan" / "plan_delta" (Codex's
/// commentary), "data" (a tool's result, for the activity view), "context" (the context
/// inspector's page) and, once, "done" or "failed".
pub type OnEvent = Arc<dyn Fn(&str, &str) + Send + Sync>;

/// `CodexTask(task, previous=, on_event=, device=, session=, ahead=)`'s keyword arguments.
#[derive(Default)]
pub struct TaskOptions {
    /// The request this one replaces, which was stopped partway through.
    pub previous: Option<String>,
    pub on_event: Option<OnEvent>,
    /// "mac" or "phone" (from the request's words when not given: [`crate::focus`]).
    pub device: Option<String>,
    /// The conversation it's part of (default: the agent's current one).
    pub session: Option<Arc<dyn TaskSession>>,
    /// The Mac's look, taken as you started saying it (for a Mac request).
    pub ahead: Option<Arc<LookAhead>>,
}

/// Work a task runs on a thread of its own (what agent.py gave `threading.Thread`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Job {
    Run(bool),
    Interrupt,
    PauseGoalAndInterrupt,
    AwaitGoalContinuation(Option<String>),
    Recover,
}

const RECOVERY_WAIT: &str = "__recovery_wait__";

type Clock = Box<dyn FnMut() -> f64 + Send>;
type DoneWait = Box<dyn FnMut(&CodexTask, f64) -> bool + Send>;

/// What the tests put in place of threads, the clock and waits (Python's `mock.patch`).
#[derive(Default)]
pub(crate) struct TestHooks {
    /// When set, jobs are recorded here instead of run.
    pub spawned: Mutex<Option<Vec<Job>>>,
    /// The goal watchdog's clock.
    pub clock: Mutex<Option<Clock>>,
    /// In place of the waits on `done` (watchdog and provider waits).
    pub done_wait: Mutex<Option<DoneWait>>,
    /// In place of `_interrupt`.
    pub interrupt: Mutex<Option<Box<dyn FnMut() + Send>>>,
}

pub(crate) struct State {
    pub prompt: String,
    pub final_: Option<String>,
    pub started_at: f64,
    pub began: f64,
    pub elapsed: f64,
    pub on_thread: bool,
    pub told: bool,
    pub ended: String,
    pub server: Option<Arc<dyn Server>>,
    pub thread: Option<String>,
    pub turn: Option<String>,
    pub context: i64,
    pub times: Vec<(String, f64)>,
    pub looked_ahead: bool,
    pub model_calls: i64,
    pub thought: i64,
    pub wrote: i64,
    pub calls_to_words: i64,
    pub written: HashMap<String, String>,
    pub phases: HashMap<String, String>,
    pub said: HashMap<String, usize>,
    pub started: bool,
    pub stopped: bool,
    pub context_warning: bool,
    pub between_goal_turns: bool,
    pub goal_before: Option<(Value, Value)>,
    pub recovery_running: bool,
    pub routing_retry_available: bool,
    pub routing_failure: bool,
    pub provider_available: bool,
    pub provider_waiting: bool,
    pub recovery_id: Option<String>,
    pub receipt_id: Option<String>,
    pub durable_recovery: bool,
    pub startup_record: Option<Value>,
    pub recovery_owner: Option<OwnerLock>,
    pub maintenance_handoff: bool,
}

/// One request. Build it with [`CodexTask::new`], then [`CodexTask::start`] it.
pub struct CodexTask {
    pub(crate) agent: Arc<Agent>,
    me: Weak<CodexTask>,
    task: String,
    device: String,
    pub(crate) ahead: Option<Arc<LookAhead>>,
    on_event: Mutex<OnEvent>,
    session: Mutex<Arc<dyn TaskSession>>,
    pub(crate) state: Mutex<State>,
    pub(crate) done: Event,
    pub(crate) turn_over: Event,
    dispatch_lock: Mutex<()>,
    pub(crate) log: Mutex<Option<File>>,
    pub(crate) tools: Mutex<HashMap<String, Arc<dyn ToolNamespace>>>,
    pub(crate) test: TestHooks,
    /// Its turn's process when Claude runs the requests (`AGENT_BACKEND=claude`).
    pub(crate) claude: crate::claude::TaskPart,
    /// Its name in the action memory.
    action_run: String,
}

static ACTION_RUNS: AtomicU64 = AtomicU64::new(0);

/// A name for a run of a task, unique on this Mac: the time, the process and a count.
fn next_action_run() -> String {
    let n = ACTION_RUNS.fetch_add(1, Ordering::Relaxed);
    format!(
        "{}-{}-{n}",
        (unix_time() * 1000.0) as u64,
        std::process::id()
    )
}

fn obj(value: Option<&Value>) -> Value {
    match value {
        Some(v) if py::truthy(Some(v)) => v.clone(),
        _ => json!({}),
    }
}

fn status_of(value: &Value) -> Option<&str> {
    value.get("status").and_then(Value::as_str)
}

/// `(thread.get("status") or {}).get("type")`.
fn thread_status(state: &Value) -> Option<String> {
    let thread = obj(state.get("thread"));
    let status = obj(thread.get("status"));
    status
        .get("type")
        .and_then(Value::as_str)
        .map(str::to_owned)
}

fn accepts_input(state: &Value) -> bool {
    obj(state.get("thread")).get("canAcceptDirectInput") != Some(&Value::Bool(false))
}

fn continuation(thread: &Option<String>, text: &str) -> Value {
    json!({"threadId": thread, "input": [{"type": "text", "text": text}]})
}

impl CodexTask {
    pub fn new(agent: &Arc<Agent>, task: &str, options: TaskOptions) -> Arc<CodexTask> {
        let device = options
            .device
            .unwrap_or_else(|| crate::agent::focus(task).to_owned());
        let previous = options
            .previous
            .filter(|p| !p.is_empty())
            .map(|p| prompts::previous_text(&p))
            .unwrap_or_default();
        let prompt = prompts::request(
            prompts::focus_text(&device),
            &task.replace('"', "'"),
            &previous,
        );
        let session = options.session.unwrap_or_else(|| agent.task_session());
        let ahead = if device == "mac" { options.ahead } else { None };
        Arc::new_cyclic(|me| CodexTask {
            agent: agent.clone(),
            me: me.clone(),
            task: task.to_owned(),
            device,
            ahead,
            on_event: Mutex::new(
                options
                    .on_event
                    .unwrap_or_else(|| Arc::new(|_: &str, _: &str| {})),
            ),
            session: Mutex::new(session),
            state: Mutex::new(State {
                prompt,
                final_: None,
                started_at: 0.0,
                began: monotonic(),
                elapsed: 0.0,
                on_thread: false,
                told: false,
                ended: String::new(),
                server: None,
                thread: None,
                turn: None,
                context: 0,
                times: Vec::new(),
                looked_ahead: false,
                model_calls: 0,
                thought: 0,
                wrote: 0,
                calls_to_words: 0,
                written: HashMap::new(),
                phases: HashMap::new(),
                said: HashMap::new(),
                started: false,
                stopped: false,
                context_warning: false,
                between_goal_turns: false,
                goal_before: None,
                recovery_running: false,
                routing_retry_available: true,
                routing_failure: false,
                provider_available: false,
                provider_waiting: false,
                recovery_id: None,
                receipt_id: None,
                durable_recovery: true,
                startup_record: None,
                recovery_owner: None,
                maintenance_handoff: false,
            }),
            done: Event::new(false),
            turn_over: Event::new(false),
            dispatch_lock: Mutex::new(()),
            log: Mutex::new(None),
            tools: Mutex::new(HashMap::new()),
            test: TestHooks::default(),
            claude: Default::default(),
            action_run: next_action_run(),
        })
    }

    // -- what the voice agent reads and sets ------------------------------------------------

    /// The request's words.
    pub fn task(&self) -> &str {
        &self.task
    }
    /// "mac" or "phone".
    pub fn device(&self) -> &str {
        &self.device
    }
    pub(crate) fn st(&self) -> MutexGuard<'_, State> {
        lock(&self.state)
    }
    pub(crate) fn arc(&self) -> Arc<CodexTask> {
        self.me.upgrade().expect("a task is used through its Arc")
    }
    /// Started and not finished yet.
    pub fn running(&self) -> bool {
        self.st().started && !self.done.is_set()
    }
    /// Its final reply (Python's `final`); None if it failed or was stopped.
    pub fn final_text(&self) -> Option<String> {
        self.st().final_.clone()
    }
    /// Why it failed, "stopped", or "" (Python's `_ended`).
    pub fn ended(&self) -> String {
        self.st().ended.clone()
    }
    /// When it started, `time.time()`.
    pub fn started_at(&self) -> f64 {
        self.st().started_at
    }
    /// When it started, on [`crate::monotonic`]'s clock.
    pub fn began(&self) -> f64 {
        self.st().began
    }
    /// Seconds it took.
    pub fn elapsed(&self) -> f64 {
        self.st().elapsed
    }
    /// Seconds from its start: "look", "codex" (turn started), "words", "end", in order.
    pub fn times(&self) -> Vec<(String, f64)> {
        self.st().times.clone()
    }
    /// Its screenshot was taken as you started talking.
    pub fn looked_ahead(&self) -> bool {
        self.st().looked_ahead
    }
    /// Model calls up to and including the one that started the reply.
    pub fn calls_to_words(&self) -> i64 {
        self.st().calls_to_words
    }
    /// It ran on its session's thread (else on one of its own).
    pub fn on_thread(&self) -> bool {
        self.st().on_thread
    }
    /// Codex's id for its thread (Python's `_thread`).
    pub fn thread_id(&self) -> Option<String> {
        self.st().thread.clone()
    }
    /// The saved request it owns (`task-recovery.json`'s id), if any.
    pub fn recovery_id(&self) -> Option<String> {
        self.st().recovery_id.clone()
    }
    /// The text sent to Codex (before what's attached); voice_agent's ingest replaces it.
    pub fn set_prompt(&self, prompt: impl Into<String>) {
        self.st().prompt = prompt.into();
    }
    pub fn set_on_event(&self, on_event: OnEvent) {
        *lock(&self.on_event) = on_event;
    }
    /// The ingress receipt the saved request links to.
    pub fn set_receipt_id(&self, receipt: Option<String>) {
        self.st().receipt_id = receipt;
    }
    /// False: not a request to save and continue after a restart (document chunks).
    pub fn set_durable_recovery(&self, durable: bool) {
        self.st().durable_recovery = durable;
    }
    /// Makes it the continuation of a saved request (`startup_recovery_record`), holding the
    /// owner lock: it resumes that conversation instead of sending a request.
    pub fn set_startup_record(&self, record: Value, owner: Option<OwnerLock>) {
        let mut s = self.st();
        s.recovery_id = record.get("id").and_then(Value::as_str).map(str::to_owned);
        s.receipt_id = record
            .get("receiptId")
            .and_then(Value::as_str)
            .map(str::to_owned);
        s.startup_record = Some(record);
        s.recovery_owner = owner;
    }
    /// Runs `f` while no continuation can start or stop take effect (Python's
    /// `with task._dispatch_lock:`).
    pub fn with_dispatch_lock<R>(&self, f: impl FnOnce() -> R) -> R {
        let _guard = lock(&self.dispatch_lock);
        f()
    }
    pub(crate) fn session(&self) -> Arc<dyn TaskSession> {
        lock(&self.session).clone()
    }
    pub(crate) fn set_on_thread(&self, on: bool) {
        self.st().on_thread = on;
    }
    pub(crate) fn told(&self) -> bool {
        self.st().told
    }
    pub(crate) fn set_told(&self) {
        self.st().told = true;
    }
    fn server(&self) -> Option<Arc<dyn Server>> {
        self.st().server.clone()
    }
    fn state_dir(&self) -> std::path::PathBuf {
        self.agent.state_dir()
    }
    fn log_path(&self) -> String {
        self.agent.config.log.display().to_string()
    }

    /// The handlers its own thread's notifications and tool calls go to.
    pub(crate) fn handlers(&self) -> (OnMessage, OnToolCall) {
        let (a, b) = (self.me.clone(), self.me.clone());
        (
            Arc::new(move |method: &str, params: &Value| {
                if let Some(task) = a.upgrade() {
                    task.on_message(method, params);
                }
            }),
            Arc::new(move |params: &Value| match b.upgrade() {
                Some(task) => task.call_tool(params),
                None => hive_common::tools::reply_text(false, "Stopped by the user."),
            }),
        )
    }

    // -- running ----------------------------------------------------------------------------

    /// Starts it in the background. `look`: attach a screenshot taken now (first_look).
    pub fn start(self: &Arc<Self>, look: bool) -> Arc<CodexTask> {
        {
            let mut s = self.st();
            s.began = monotonic();
            s.started_at = unix_time();
            s.started = true;
        }
        self.session().add(self);
        self.spawn(Job::Run(look));
        self.clone()
    }

    pub(crate) fn spawn(&self, job: Job) {
        if let Some(list) = lock(&self.test.spawned).as_mut() {
            list.push(job);
            return;
        }
        let me = self.arc();
        std::thread::spawn(move || me.run_job(job));
    }

    pub(crate) fn run_job(&self, job: Job) {
        match job {
            Job::Run(look) => self.run(look),
            Job::Interrupt => self.interrupt(),
            Job::PauseGoalAndInterrupt => self.pause_goal_and_interrupt(),
            Job::AwaitGoalContinuation(turn) => self.await_goal_continuation(turn.as_deref()),
            Job::Recover => {
                self.recover_goal_server();
                self.st().recovery_running = false;
            }
        }
    }

    pub(crate) fn log_write(&self, text: &str) {
        if let Some(file) = lock(&self.log).as_mut() {
            let _ = file.write_all(text.as_bytes());
        }
    }

    /// This run, as the action memory knows it.
    pub(crate) fn action_task(&self) -> crate::hooks::ActionTask {
        crate::hooks::ActionTask {
            run: self.action_run.clone(),
            request: self.task.clone(),
            device: self.device.clone(),
            receipt: self.st().receipt_id.clone(),
        }
    }

    /// Gives a finished step to the action memory, which records it on a thread of its own:
    /// this returns at once and never fails the step.
    pub(crate) fn record_action(&self, namespace: &str, tool: &str, args: &Value, ok: bool) {
        let task = self.action_task();
        let actions = self.agent.hooks.actions.clone();
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            actions.step(&task, namespace, tool, args, ok)
        }));
    }

    fn run(&self, look: bool) {
        {
            let task = self.action_task();
            let actions = self.agent.hooks.actions.clone();
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| actions.begin(&task)));
        }
        if self.agent.backend() == "claude" {
            return crate::claude::run(self, look);
        }
        let file = std::fs::OpenOptions::new()
            .append(true)
            .create(true)
            .open(&self.agent.config.log)
            .ok();
        *lock(&self.log) = file;
        self.log_write(&format!(
            "\n=== {}: {}  ({})\n",
            self.device,
            self.task,
            self.agent.describe_model()
        ));
        let startup = self.st().startup_record.is_some();
        let result = if startup {
            self.restore_task()
        } else {
            self.converse(look)
        };
        let result = result.map(|_| {
            self.done.wait(None);
            if self.st().turn.is_some() {
                self.turn_over.wait(Some(10.0)); // when it was stopped, Codex ends the turn in a moment
            }
        });
        match result {
            Ok(()) => {}
            Err(AgentError::Exit(message)) => {
                self.finish("failed", &message, None); // Codex isn't installed
            }
            Err(e) => {
                self.finish(
                    "failed",
                    &format!("Codex: {e} (see {})", self.log_path()),
                    None,
                );
            }
        }
        let (server, thread, on_thread) = {
            let s = self.st();
            (s.server.clone(), s.thread.clone(), s.on_thread)
        };
        if let (Some(server), Some(thread)) = (server, thread) {
            if !on_thread {
                forget(server.as_ref(), &thread);
            }
        }
        let mac = lock(&self.tools).get("mac").cloned();
        if let Some(mac) = mac {
            mac.close();
        }
        let owner = self.st().recovery_owner.take();
        drop(owner);
        lock(&self.log).take();
    }

    /// What the user asked for in this conversation lately: this request and the ones before it in
    /// the last two hours. A step that can't be undone must quote it (`hive_common::mcp::check_step`).
    pub fn words(&self) -> String {
        let now = unix_time();
        let mut recent: Vec<String> = self
            .session()
            .tasks()
            .iter()
            .filter(|t| !std::ptr::eq(t.as_ref(), self))
            .filter(|t| t.started_at() != 0.0 && now - t.started_at() < 2.0 * 3600.0)
            .map(|t| t.task().to_owned())
            .collect();
        recent.push(self.task().to_owned());
        recent.join("\n")
    }

    /// The devices' tools for this task, each told what the user said (`words`).
    pub(crate) fn device_tools_for_task(&self) -> HashMap<String, Arc<dyn ToolNamespace>> {
        let tools = self.agent.device_tools();
        let words = self.words();
        for device in tools.values() {
            device.set_words(&words);
        }
        tools
    }

    /// One device's tools while the task runs ("mac", "phone"): the app tells the Mac's when you
    /// hand the screen back (`handed_back`).
    pub fn device_tool(&self, device: &str) -> Option<Arc<dyn ToolNamespace>> {
        lock(&self.tools).get(device).cloned()
    }

    fn converse(&self, look: bool) -> Result<(), AgentError> {
        let tools = self.device_tools_for_task();
        *lock(&self.tools) = tools.clone();
        let mut attached = String::new();
        let mut image = None;
        let mut seen = None;
        let workspace = self.agent.env.get("AGENT_WORKSPACE_CONNECTION").is_some()
            || self.agent.env.get("AGENT_WORKSPACE_ENGINE").is_some();
        if look && !(self.device == "mac" && workspace) {
            seen = self.ahead.as_ref().and_then(|a| a.seen());
            let ahead = seen.is_some();
            self.st().looked_ahead = ahead;
            if seen.is_none() {
                seen = tools
                    .get(&self.device)
                    .and_then(|t| first_look(t.as_ref(), self.device == "mac"));
            }
            self.time("look");
        }
        if let Some((url, about)) = seen {
            image = Some(url);
            attached = format!(
                "\nAttached: a screenshot of the {} taken as they asked, in the same coordinates as its tools. {about}\n",
                prompts::device_name(&self.device)
            );
            let text = if self.st().looked_ahead {
                "screenshot (taken as you started talking)"
            } else {
                "screenshot (attached to the request)"
            };
            self.event("action", text);
        }
        if self.st().stopped {
            self.finish("failed", "stopped", None);
            return Ok(());
        }
        let server = self.agent.codex_server()?;
        self.st().server = Some(server.clone());
        let session = self.session();
        let params = self.agent.thread_params()?;
        let (thread, earlier) = session.thread_for(&self.arc(), &server, params, None)?;
        self.st().thread = Some(thread.clone());
        let (on_thread, durable) = {
            let s = self.st();
            (s.on_thread, s.durable_recovery)
        };
        if on_thread && durable {
            let mut s = self.st();
            if !s.stopped && !self.done.is_set() {
                let dir = self.state_dir();
                s.recovery_owner = task_recovery::acquire_owner(&dir)?;
                if s.recovery_owner.is_none() {
                    return Err(AgentError::Resume(
                        "Another process owns the saved task".into(),
                    ));
                }
                let receipt = s.receipt_id.clone();
                s.recovery_id = Some(task_recovery::begin(
                    &dir,
                    &self.device,
                    &thread,
                    receipt.as_deref(),
                )?);
            }
        }
        self.record_context(
            "session connected",
            &json!({"threadId": thread, "note": prompts::SESSION_CONNECTED_NOTE}),
        );
        if let Some(error) = session.context_error() {
            self.event(
                "error",
                &format!("Thread context could not be saved: {error}"),
            );
        }
        if !on_thread {
            self.log_write(
                "(the session's thread is busy: this one runs on a thread of its own)\n",
            );
        }
        if self.st().stopped {
            session.release(self);
            self.finish("failed", "stopped", None);
            return Ok(());
        }
        if self.st().turn.is_some() && !self.turn_over.is_set() {
            // Resuming a persisted goal can start a native continuation before
            // thread/resume returns. It is already our turn; do not start another.
            self.time("codex");
            return Ok(());
        }
        // A goal an earlier task left on the thread (blocked, paused, complete) isn't this request's.
        // Note which one it is, so this task ends on what it did, not on that old status: otherwise
        // every task after a blocked one gets a "diagnose the blocker" turn and ends as failed.
        self.st().goal_before = None;
        if on_thread {
            let _ = (|| -> Result<(), AgentError> {
                let before = obj(server
                    .request("thread/goal/get", json!({"threadId": thread}), 5.0)?
                    .get("goal"));
                if py::truthy(Some(&before)) && status_of(&before) != Some("active") {
                    self.st().goal_before = Some(goal_stamp(&before));
                }
                if status_of(&before) != Some("active") {
                    // This request becomes the thread's goal, so Codex keeps taking turns until the model
                    // marks it complete (or blocked). Without one, the first turn that ended was the whole
                    // task: "save a backup, then delete the channel" ended after 20 s of reading code.
                    server.request(
                        "thread/goal/set",
                        json!({"threadId": thread, "objective": py::chars(&self.task, 4000), "status": "active",
                               "origin": "user"}),
                        5.0,
                    )?;
                }
                Ok(())
            })();
        }
        // The knowledge base in the cloud took over from the local memory store, whose facts
        // were copied into it; every turn reminds the agent to use it and add to it.
        let memory_hint = format!(
            "{}{}",
            self.agent.hooks.knowledge.turn_hint(),
            prompts::STEP_HINT
        );
        let memory = self.agent.hooks.memory.clone();
        let remembered = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            memory.automatic_context(&self.task)
        }))
        .ok()
        .and_then(Result::ok)
        // Memory must never prevent a user task from starting.
        .unwrap_or_else(|| json!({"status": "unavailable", "results": []}));
        let memory_context =
            if remembered.get("status").and_then(Value::as_str) == Some("unavailable") {
                prompts::MEMORY_UNAVAILABLE.to_owned()
            } else if py::truthy(remembered.get("results")) {
                format!(
                    "{}{}\n",
                    prompts::MEMORY_HEADER,
                    py::dumps(&remembered["results"], false)
                )
            } else {
                String::new()
            };
        // What the knowledge base has for it (facts, and the steps that worked in an earlier task
        // like it), from the Mac's copies: no network, and nothing at all on any failure.
        let knowledge_context = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            memory.knowledge_context(&self.task)
        }))
        .ok()
        .flatten()
        .filter(|text| !text.trim().is_empty())
        .map(|text| format!("\n{}\n", text.trim_end()))
        .unwrap_or_default();
        let prompt = self.st().prompt.clone();
        let mut inputs = vec![json!({"type": "text",
            "text": format!("{earlier}{prompt}{attached}{memory_hint}{memory_context}{knowledge_context}")})];
        if let Some(url) = &image {
            inputs.push(json!({"type": "image", "url": url}));
        }
        let mut start = json!({"threadId": thread, "input": inputs, "effort": self.agent.effort(), "summary": "auto"});
        if self.agent.fast() {
            start["serviceTier"] = json!("priority");
        }
        let mut logged_start = start.clone();
        let omitted = match (memory_context.is_empty(), knowledge_context.is_empty()) {
            (true, true) => "",
            (false, true) => "\n[Automatic memory omitted from context log.]\n",
            (true, false) => "\n[Automatic knowledge omitted from context log.]\n",
            (false, false) => "\n[Automatic memory and knowledge omitted from context log.]\n",
        };
        logged_start["input"][0]["text"] =
            json!(format!("{earlier}{prompt}{attached}{memory_hint}{omitted}"));
        self.record_context("turn/start input", &logged_start);
        let turn = match server.request("turn/start", start, DEFAULT_TIMEOUT) {
            Ok(reply) => {
                let turn = reply
                    .get("turn")
                    .and_then(|t| t.get("id"))
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                if let Some(activity) = memory.activity_summary(&remembered) {
                    // Do not copy personal memory into the general agent log.
                    self.emit("data", &activity);
                }
                if !knowledge_context.is_empty() {
                    let lines = knowledge_context.trim().lines().count().saturating_sub(1);
                    self.emit(
                        "data",
                        &format!("Knowledge base: attached {lines} lines it has for this request"),
                    );
                }
                turn.ok_or_else(|| AgentError::Value("'turn'".into()))?
            }
            Err(e) => {
                self.session().release(self);
                return Err(e);
            }
        };
        self.time("codex");
        let stopped = {
            let mut s = self.st();
            s.turn = Some(turn);
            s.stopped
        };
        if stopped {
            self.interrupt(); // stop() came while the turn was starting
        }
        Ok(())
    }

    pub(crate) fn record_context(&self, kind: &str, payload: &Value) {
        let thread = self.st().thread.clone();
        let recorder = self.agent.hooks.context.clone();
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            recorder.record(kind, payload, Some(&self.task), thread.as_deref())
        }))
        .unwrap_or_else(|panic| Err(panic_text(&*panic)));
        match result {
            Ok(Some(path)) => self.emit("context", &path),
            Ok(None) => {}
            Err(error) => {
                // An inspector failure must not kill the JSON-RPC reader or obscure a
                // tool result, and the user must know that their view is incomplete.
                let first = {
                    let mut s = self.st();
                    !std::mem::replace(&mut s.context_warning, true)
                };
                if first {
                    self.event(
                        "error",
                        &format!("Agent context could not be saved: {error}"),
                    );
                }
            }
        }
    }

    /// on_event, without the log.
    fn emit(&self, kind: &str, text: &str) {
        let on_event = lock(&self.on_event).clone();
        on_event(kind, text);
    }

    pub(crate) fn event(&self, kind: &str, text: &str) {
        if lock(&self.log).is_some() {
            let since = monotonic() - self.st().began;
            self.log_write(&format!("{since:6.1}s  {kind}: {text}\n"));
        }
        self.emit(kind, text);
    }

    pub(crate) fn time(&self, step: &str) {
        let mut s = self.st();
        if !s.times.iter().any(|(k, _)| k == step) {
            let at = monotonic() - s.began;
            s.times.push((step.to_owned(), at));
        }
    }

    /// Where its time went, e.g. 'screenshot 0.0 s (taken as you talked), Codex started at 0.1 s,
    /// first words at 3.2 s, 2 model calls, 310 tokens thinking, 40 written, done at 4.0 s'.
    pub fn describe_times(&self) -> String {
        let s = self.st();
        let t = |key: &str| s.times.iter().find(|(k, _)| k == key).map(|(_, v)| *v);
        let mut parts = Vec::new();
        if let Some(look) = t("look") {
            parts.push(format!(
                "screenshot {look:.1} s{}",
                if s.looked_ahead {
                    " (taken as you talked)"
                } else {
                    ""
                }
            ));
        }
        if let Some(codex) = t("codex") {
            parts.push(format!("Codex started at {codex:.1} s"));
        }
        if let Some(words) = t("words") {
            parts.push(format!("first words at {words:.1} s"));
        }
        if s.model_calls != 0 {
            let calls = s.model_calls;
            parts.push(format!(
                "{calls} model call{}, {} tokens thinking, {} written",
                if calls > 1 { "s" } else { "" },
                s.thought,
                s.wrote
            ));
        }
        if let Some(end) = t("end") {
            parts.push(format!("done at {end:.1} s"));
        }
        parts.join(", ")
    }

    /// Says each sentence of a message as soon as Codex has written it, rather than waiting for
    /// the whole message: the voice starts on the first while the rest is still coming.
    pub(crate) fn speak(&self, item_id: &str, text: &str, whole: bool) {
        let said_text = {
            let mut s = self.st();
            let said = s.said.get(item_id).copied().unwrap_or(0);
            let mut rest: String = text.chars().skip(said).collect();
            if !whole {
                rest = match sentence_ends(&rest).last() {
                    Some(&end) => rest.chars().take(end).collect(),
                    None => String::new(),
                };
            }
            if py::strip(&rest).is_empty() {
                return;
            }
            s.said.insert(item_id.to_owned(), said + py::len(&rest));
            if !s.times.iter().any(|(k, _)| k == "words") {
                s.calls_to_words = s.model_calls + 1; // (its usage comes once it's done writing)
            }
            py::strip(&rest).to_owned()
        };
        self.time("words");
        self.event("say", &said_text);
    }

    /// Reports the end, once. `expected_turn`: only if it's still between the goal's turns,
    /// after that turn.
    pub(crate) fn finish(&self, kind: &str, text: &str, expected_turn: Option<&str>) -> bool {
        let (recovery_id, handoff, stopped, started) = {
            let mut s = self.st();
            if self.done.is_set()
                || expected_turn
                    .is_some_and(|t| !s.between_goal_turns || s.turn.as_deref() != Some(t))
            {
                return false;
            }
            s.elapsed = if s.started {
                monotonic() - s.began
            } else {
                0.0
            };
            if kind != "done" {
                s.ended = text.to_owned();
            }
            self.done.set();
            (
                s.recovery_id.clone(),
                s.maintenance_handoff,
                s.stopped,
                s.started,
            )
        };
        {
            let outcome = if kind == "done" {
                "done"
            } else if stopped {
                "stopped"
            } else if handoff {
                "interrupted"
            } else {
                "failed"
            };
            let task = self.action_task();
            let actions = self.agent.hooks.actions.clone();
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                actions.end(&task, outcome)
            }));
        }
        if let Some(id) = recovery_id.filter(|_| !handoff) {
            let status = if stopped { "stopped" } else { "finished" };
            if let Err(error) = task_recovery::finish(&self.state_dir(), &id, status) {
                self.event("error", &format!("Could not save task state: {error}"));
            }
        }
        if started {
            self.time("end");
            if lock(&self.log).is_some() {
                let times = self.describe_times();
                self.log_write(&format!("   ({times})\n"));
            }
        }
        self.event(kind, text);
        true
    }

    /// What came of it, for a thread that didn't see it.
    pub fn outcome(&self) -> String {
        if self.running() {
            return "(still working on it)".into();
        }
        let s = self.st();
        if let Some(text) = s.final_.as_deref().filter(|t| !t.is_empty()) {
            return py::dumps(&json!(text), false);
        }
        if s.ended == "stopped" {
            "(stopped before finishing)".into()
        } else {
            format!("(failed: {})", py::chars(&s.ended, 150))
        }
    }

    pub(crate) fn on_message(&self, method: &str, params: &Value) {
        let turn_id = py::text(params.get("turnId"))
            .or_else(|| params.get("turn").and_then(|t| py::text(t.get("id"))))
            .map(str::to_owned);
        if method == "turn/started" && turn_id.is_some() {
            let interrupt_late_turn = {
                let mut s = self.st();
                if s.stopped && s.between_goal_turns {
                    // A start request can cross a user's stop while in flight. Target
                    // the newly reported turn as well as the previously known one.
                    s.turn = turn_id.clone();
                    true
                } else {
                    if (s.turn.is_none() || s.between_goal_turns)
                        && !s.stopped
                        && !self.done.is_set()
                    {
                        s.turn = turn_id.clone();
                        if s.thread.is_none() {
                            s.thread = py::text(params.get("threadId")).map(str::to_owned);
                        }
                        s.between_goal_turns = false;
                        s.routing_failure = false;
                        self.turn_over.clear();
                        s.final_ = None;
                    }
                    false
                }
            };
            if interrupt_late_turn {
                self.spawn(Job::Interrupt);
                return;
            }
        }
        {
            let s = self.st();
            if let (Some(id), Some(current)) = (&turn_id, &s.turn) {
                if id != current {
                    return; // from a turn before this one
                }
            }
        }
        if matches!(
            method,
            "item/started"
                | "item/completed"
                | "turn/started"
                | "turn/completed"
                | "error"
                | "exited"
                | "thread/tokenUsage/updated"
        ) {
            self.record_context(method, params);
        }
        let item = obj(params.get("item"));
        let itype = item.get("type").and_then(Value::as_str).unwrap_or("");
        let get = |key: &str, default: &str| {
            item.get(key)
                .map(py::str_of)
                .unwrap_or_else(|| default.to_owned())
        };
        if method == "turn/completed" || method == "exited" {
            self.turn_over.set();
            let context = self.st().context;
            if context != 0 && lock(&self.log).is_some() {
                self.log_write(&format!(
                    "   (the conversation is {:.0}k tokens)\n",
                    context as f64 / 1000.0
                ));
            }
        }
        let stopped = self.st().stopped;
        match (method, itype) {
            ("thread/tokenUsage/updated", _) => {
                // after each call to the model
                let last = obj(obj(params.get("tokenUsage")).get("last"));
                let n = |key: &str| last.get(key).and_then(Value::as_i64).unwrap_or(0);
                let mut s = self.st();
                s.context = n("inputTokens") + n("outputTokens");
                s.model_calls += 1;
                s.thought += n("reasoningOutputTokens");
                s.wrote += 0.max(n("outputTokens") - n("reasoningOutputTokens"));
            }
            ("item/started", "agentMessage") => {
                let phase = py::text(item.get("phase"))
                    .unwrap_or("final_answer")
                    .to_owned();
                self.st().phases.insert(get("id", ""), phase);
            }
            ("item/agentMessage/delta", _) if !stopped => {
                let id = params.get("itemId").map(py::str_of).unwrap_or_default();
                let delta = params.get("delta").map(py::str_of).unwrap_or_default();
                let (written, commentary) = {
                    let mut s = self.st();
                    let written = s.written.entry(id.clone()).or_default();
                    written.push_str(&delta);
                    let written = written.clone();
                    (
                        written,
                        s.phases.get(&id).map(String::as_str) == Some("commentary"),
                    )
                };
                if commentary {
                    self.event("plan_delta", py::strip(&written));
                } else {
                    self.speak(&id, &written, false);
                }
            }
            ("item/started", "contextCompaction") => {
                self.event("action", "compacting the conversation");
                self.event("doing", "Summing up the conversation so far");
            }
            ("turn/started", _) => self.event("doing", "Thinking"),
            ("item/started", "commandExecution") => {
                let command = match item.get("command") {
                    Some(v) if py::truthy(Some(v)) => py::str_of(v),
                    _ => String::new(),
                };
                let operations: Vec<String> = workspace_tool_calls(&command);
                if !operations.is_empty() {
                    let names = operations.join(", ");
                    self.event("action", &format!("Virtual workspace: {names}"));
                    self.event("doing", &format!("Using {names}"));
                } else {
                    self.event("action", "Running a local command");
                    self.event("doing", "Running a local command");
                }
                // The shell doesn't need the mouse: the user can have it meanwhile.
                if let Some(mac) = lock(&self.tools).get("mac").cloned() {
                    std::thread::spawn(move || mac.let_go());
                }
            }
            ("item/completed", "commandExecution") => {
                let code = item.get("exitCode").filter(|c| !c.is_null());
                // Python's `code == 0` (False == 0 too)
                let ended =
                    if code.and_then(Value::as_f64) == Some(0.0) || code == Some(&json!(false)) {
                        "completed"
                    } else {
                        "ended"
                    };
                let exit = code
                    .map(|c| format!(" (exit {})", py::str_of(c)))
                    .unwrap_or_default();
                self.event("data", &format!("Local command {ended}{exit}"));
                self.event("doing", "Thinking");
                let paths: Vec<Value> = item
                    .get("commandActions")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(|a| a.get("path").filter(|p| p.is_string()).cloned())
                    .collect();
                let ok = ended == "completed" && item.get("status") != Some(&json!("failed"));
                self.record_action(
                    "shell",
                    "command",
                    &json!({"command": item.get("command"), "cwd": item.get("cwd"), "paths": paths}),
                    ok,
                );
            }
            ("item/completed", "fileChange") => {
                let changes: Vec<Value> = item
                    .get("changes")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                let paths: Vec<Value> = changes
                    .iter()
                    .flat_map(|c| {
                        let kind = c.get("kind");
                        [c.get("path"), kind.and_then(|k| k.get("move_path"))]
                    })
                    .flatten()
                    .filter(|p| p.is_string())
                    .cloned()
                    .collect();
                let kinds: Vec<Value> = changes
                    .iter()
                    .map(|c| {
                        let kind = c.get("kind");
                        kind.and_then(|k| k.get("type"))
                            .or(kind.filter(|k| k.is_string()))
                            .cloned()
                            .unwrap_or_else(|| json!("change"))
                    })
                    .collect();
                if !changes.is_empty() {
                    let ok = item.get("status") == Some(&json!("completed"));
                    self.record_action(
                        "shell",
                        "file_change",
                        &json!({"paths": paths, "kinds": kinds}),
                        ok,
                    );
                }
            }
            ("item/started", "dynamicToolCall") => {
                self.event(
                    "action",
                    &describe_call(&item, self.agent.hooks.knowledge.as_ref()),
                );
                self.event("doing", &doing(&item));
                let empty = json!({});
                let arguments = match item.get("arguments") {
                    Some(v) if py::truthy(Some(v)) => v,
                    _ => &empty,
                };
                let step = match arguments.get("step") {
                    Some(v) if py::truthy(Some(v)) => py::strip(&py::str_of(v)).to_owned(),
                    _ => String::new(),
                };
                if step.to_lowercase().starts_with("one-way")
                    && hive_common::mcp::check_step(arguments, &self.words()).is_none()
                {
                    // Said aloud: it can't be undone.
                    let said = step.split_once(':').map(|(_, rest)| rest).unwrap_or(&step);
                    self.event("announce", py::strip(said));
                }
            }
            ("item/started", "mcpToolCall") => {
                let arguments = py::dumps(&obj(item.get("arguments")), false);
                self.event(
                    "action",
                    &format!(
                        "{}.{}({})",
                        get("server", "tool"),
                        get("tool", ""),
                        py::chars(&arguments, 300)
                    ),
                );
                self.event(
                    "doing",
                    &format!("Using {}: {}", get("server", "tool"), get("tool", "")),
                );
            }
            ("item/completed", "mcpToolCall") => {
                let result = obj(item.get("result"));
                let texts: Vec<String> = match result.get("content") {
                    Some(Value::Array(parts)) => parts
                        .iter()
                        .filter(|p| p.get("type").and_then(Value::as_str) == Some("text"))
                        .map(|p| p.get("text").map(py::str_of).unwrap_or_default())
                        .collect(),
                    _ => Vec::new(),
                };
                let mut data = texts.join("\n");
                if py::len(&data) > 20_000 {
                    data = format!(
                        "{}\n[Activity view shortened this result.]",
                        py::chars(&data, 20_000)
                    );
                }
                let shown = if data.is_empty() {
                    "No text returned".to_owned()
                } else {
                    data
                };
                self.event(
                    "data",
                    &format!(
                        "Result from {}.{}: {shown}",
                        get("server", "tool"),
                        get("tool", "")
                    ),
                );
                self.event("doing", "Thinking");
            }
            ("item/completed", "dynamicToolCall") => {
                if let Some(error) = tool_error(&item) {
                    self.event("error", &error);
                }
                self.event("doing", "Thinking");
            }
            ("item/started", "webSearch") => {
                let query = match item.get("query") {
                    Some(v) if py::truthy(Some(v)) => py::str_of(v),
                    _ => String::new(),
                };
                self.event("action", &format!("web search: {query}"));
                self.event("doing", "Searching the web");
            }
            ("item/completed", "agentMessage")
                if !py::strip(item.get("text").and_then(Value::as_str).unwrap_or(""))
                    .is_empty() =>
            {
                let text = item["text"].as_str().unwrap_or_default().to_owned();
                let id = get("id", "");
                let phase = match py::text(item.get("phase")) {
                    Some(p) => Some(p.to_owned()),
                    None => self.st().phases.get(&id).cloned(),
                };
                if phase.as_deref() == Some("commentary") {
                    self.event("plan", py::strip(&text));
                } else {
                    let stopped = {
                        let mut s = self.st();
                        s.final_ = Some(py::strip(&text).to_owned());
                        s.stopped
                    };
                    if !stopped {
                        self.speak(&id, &text, true); // what the deltas haven't said
                    }
                }
            }
            ("item/completed", "reasoning") if py::truthy(item.get("summary")) => {
                let parts: Vec<String> = item["summary"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|p| py::strip(&py::str_of(p)).to_owned())
                    .filter(|p| !p.is_empty())
                    .collect();
                self.event("think", py::chars(&parts.join(" "), 600));
            }
            ("error", _) if !py::truthy(params.get("willRetry")) => {
                let message = obj(params.get("error"))
                    .get("message")
                    .map(py::str_of)
                    .unwrap_or_else(|| "None".into());
                self.event("error", py::chars(&message, 300));
            }
            ("turn/completed", _) => {
                let turn = obj(params.get("turn"));
                let status = turn.get("status").and_then(Value::as_str);
                if stopped || status == Some("interrupted") {
                    self.finish("failed", "stopped", None);
                } else if status == Some("failed") {
                    let error = obj(turn.get("error"));
                    if Self::recoverable_goal_error(&error) {
                        {
                            let mut s = self.st();
                            s.routing_failure = error.get("message").and_then(Value::as_str)
                                == Some("workspace routing discovery failed");
                            s.provider_available = false;
                            s.between_goal_turns = true;
                        }
                        self.event("error", "Temporary provider failure; checking whether the active goal can continue.");
                        self.spawn(Job::AwaitGoalContinuation(turn_id));
                    } else {
                        let message = match error.get("message") {
                            Some(m) if py::truthy(Some(m)) => py::str_of(m),
                            _ => "Codex failed".to_owned(),
                        };
                        self.finish("failed", py::chars(&message, 300), None);
                    }
                } else {
                    // Do not close the task's tools after an intermediate goal turn. Codex can
                    // start the next turn on this same thread immediately after this notification.
                    self.st().between_goal_turns = true;
                    self.spawn(Job::AwaitGoalContinuation(turn_id));
                }
            }
            ("exited", _) => {
                let on_thread = self.st().on_thread;
                if on_thread && !stopped && !self.done.is_set() {
                    self.begin_goal_recovery();
                } else {
                    let code = params
                        .get("code")
                        .map(py::str_of)
                        .unwrap_or_else(|| "None".into());
                    self.finish(
                        "failed",
                        &format!(
                            "Codex stopped unexpectedly (exit code {code}); see {}",
                            self.log_path()
                        ),
                        None,
                    );
                }
            }
            _ => {}
        }
    }

    fn begin_goal_recovery(&self) {
        // A pending RPC can observe the exit before the server's exit notification.
        // Both paths must hand off to one reconnect worker, not finish the task.
        {
            let mut s = self.st();
            if s.recovery_running || s.provider_waiting || s.stopped || self.done.is_set() {
                return;
            }
            s.recovery_running = true;
        }
        self.event(
            "error",
            "Codex stopped; reconnecting the saved goal conversation.",
        );
        self.spawn(Job::Recover);
    }

    /// Reconnects the exact persisted thread after a server exit, without replaying its turn.
    pub(crate) fn recover_goal_server(&self) {
        if let Err(error) = self.recover_goal_server_steps() {
            self.finish(
                "failed",
                &format!("Could not reconnect the saved goal conversation: {error}"),
                None,
            );
            self.session().release(self);
        }
    }

    fn recover_goal_server_steps(&self) -> Result<(), AgentError> {
        let expected_thread = {
            let mut s = self.st();
            if s.stopped || self.done.is_set() {
                return Ok(());
            }
            let expected = s.thread.clone().ok_or_else(|| {
                AgentError::Resume("No saved conversation identity to recover".into())
            })?;
            s.turn = None;
            s.between_goal_turns = false;
            self.turn_over.clear();
            expected
        };
        let server = self.agent.codex_server()?;
        self.st().server = Some(server.clone());
        let params = self.agent.thread_params()?;
        let (resumed, _) =
            self.session()
                .thread_for(&self.arc(), &server, params, Some(&expected_thread))?;
        if resumed != expected_thread {
            return Err(AgentError::Resume(
                "Recovered conversation did not match its saved identity".into(),
            ));
        }
        self.st().thread = Some(resumed.clone());
        if self.st().stopped || self.done.is_set() {
            return Ok(());
        }
        let goal = obj(server
            .request("thread/goal/get", json!({"threadId": resumed}), 10.0)?
            .get("goal"));
        if status_of(&goal) == Some("blocked") {
            if !self.claim_recovery_wait(|_| true) {
                return Ok(());
            }
            self.spawn(Job::AwaitGoalContinuation(Some(RECOVERY_WAIT.into())));
            return Ok(());
        }
        if status_of(&goal) != Some("active") {
            let status = describe_status(&goal);
            self.finish(
                "failed",
                &format!("Goal was not resumed after reconnect: {status}"),
                None,
            );
            self.session().release(self);
            return Ok(());
        }
        {
            let s = self.st();
            if s.turn.is_some() && !self.turn_over.is_set() {
                return Ok(()); // Native goal continuation was already adopted during resume.
            }
            if s.between_goal_turns {
                return Ok(()); // The native turn finished while reconnecting; its watchdog owns continuation.
            }
        }
        let status = server.request(
            "thread/read",
            json!({"threadId": resumed, "includeTurns": false}),
            10.0,
        )?;
        if thread_status(&status).as_deref() != Some("idle") {
            // The server can report a running thread without replaying its
            // turn/started notification after resume. Keep a watchdog alive
            // until it becomes idle or a new turn is observed.
            if !self.claim_recovery_wait(|_| true) {
                return Ok(());
            }
            self.event("doing", "Waiting for the reconnected goal");
            self.spawn(Job::AwaitGoalContinuation(Some(RECOVERY_WAIT.into())));
            return Ok(());
        }
        let latest = obj(server
            .request("thread/goal/get", json!({"threadId": resumed}), 10.0)?
            .get("goal"));
        if !self.claim_recovery_wait(|_| status_of(&latest) == Some("active")) {
            return Ok(());
        }
        match self.continuation_start(continuation(&Some(resumed), prompts::CONTINUE_RECONNECTED)) {
            Ok(_) => {}
            Err(AgentError::Codex(message)) => {
                // A timeout can mean the start was accepted. Poll the same thread
                // rather than replaying the request or declaring it failed.
                if !server.alive() {
                    return Err(AgentError::Codex(message));
                }
                self.event(
                    "error",
                    "Continuation response unavailable; checking the saved conversation.",
                );
            }
            Err(other) => return Err(other),
        }
        let watch = {
            let s = self.st();
            !s.stopped
                && !self.done.is_set()
                && s.between_goal_turns
                && s.turn.as_deref() == Some(RECOVERY_WAIT)
        };
        if watch {
            self.spawn(Job::AwaitGoalContinuation(Some(RECOVERY_WAIT.into())));
        }
        Ok(())
    }

    /// Takes the thread's next turn for the recovery watchdog, unless it's stopped, done, already
    /// has a turn or is between turns (or `also` says no).
    fn claim_recovery_wait(&self, also: impl Fn(&State) -> bool) -> bool {
        let mut s = self.st();
        if s.stopped || self.done.is_set() || !also(&s) || s.turn.is_some() || s.between_goal_turns
        {
            return false;
        }
        s.turn = Some(RECOVERY_WAIT.into());
        s.between_goal_turns = true;
        true
    }

    /// Resumes only the recorded conversation; never replays the interrupted request.
    pub(crate) fn restore_task(&self) -> Result<(), AgentError> {
        let record = self.st().startup_record.clone().unwrap_or_default();
        *lock(&self.tools) = self.device_tools_for_task();
        let id = record
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let saved_thread = record
            .get("thread")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        {
            let mut s = self.st();
            s.recovery_id = Some(id.clone());
            s.thread = Some(saved_thread.clone());
        }
        if self.agent.hooks.provider.exists(&self.state_dir(), &id)? {
            if !self.wait_for_provider(false, None) {
                return Ok(());
            }
            self.st().routing_failure = true;
        }
        let server = self.agent.codex_server()?;
        self.st().server = Some(server.clone());
        let params = self.agent.thread_params()?;
        let (thread, _) =
            self.session()
                .thread_for(&self.arc(), &server, params, Some(&saved_thread))?;
        if thread != saved_thread {
            return Err(AgentError::Resume("Saved conversation changed".into()));
        }
        self.st().thread = Some(thread.clone());
        if self.st().stopped {
            return Ok(());
        }
        if self.st().turn.is_some() && !self.turn_over.is_set() {
            return Ok(());
        }
        let goal = obj(server
            .request("thread/goal/get", json!({"threadId": thread}), 10.0)?
            .get("goal"));
        if !py::truthy(Some(&goal)) {
            let state = server.request(
                "thread/read",
                json!({"threadId": thread, "includeTurns": false}),
                10.0,
            )?;
            if thread_status(&state).as_deref() != Some("idle")
                || !accepts_input(&state)
                || self.st().stopped
            {
                return Err(AgentError::Resume(
                    "Saved conversation is not idle or cannot accept input".into(),
                ));
            }
            {
                let mut s = self.st();
                s.turn = Some(RECOVERY_WAIT.into());
                s.between_goal_turns = true;
                if s.routing_failure {
                    s.routing_retry_available = false;
                }
            }
            self.continuation_start(continuation(&Some(thread), prompts::CONTINUE_RESTORED))?;
            return Ok(());
        }
        if !matches!(status_of(&goal), Some("active") | Some("blocked")) {
            let status = describe_status(&goal);
            self.finish("failed", &format!("Goal was not resumed: {status}"), None);
            self.session().release(self);
            return Ok(());
        }
        {
            let mut s = self.st();
            s.turn = Some(RECOVERY_WAIT.into());
            s.between_goal_turns = true;
        }
        self.await_goal_continuation(Some(RECOVERY_WAIT));
        Ok(())
    }

    /// A failed turn that the active goal may continue after: a provider outage, not usage
    /// limits or sign-in failures.
    pub fn recoverable_goal_error(error: &Value) -> bool {
        if error.get("message").and_then(Value::as_str)
            == Some("workspace routing discovery failed")
        {
            return true;
        }
        let info = error.get("codexErrorInfo");
        if matches!(
            info.and_then(Value::as_str),
            Some("serverOverloaded") | Some("internalServerError")
        ) {
            return true;
        }
        let Some(info) = info.and_then(Value::as_object).filter(|i| i.len() == 1) else {
            return false;
        };
        let (kind, details) = info.iter().next().expect("one entry");
        if !matches!(
            kind.as_str(),
            "httpConnectionFailed"
                | "responseStreamConnectionFailed"
                | "responseStreamDisconnected"
        ) {
            return false;
        }
        let status = details
            .as_object()
            .and_then(|d| d.get("httpStatusCode"))
            .filter(|s| !s.is_null());
        match status {
            None => true,
            Some(s) => s
                .as_f64()
                .is_some_and(|code| [500.0, 502.0, 503.0, 504.0].contains(&code)),
        }
    }

    fn clock(&self) -> f64 {
        match lock(&self.test.clock).as_mut() {
            Some(clock) => clock(),
            None => monotonic(),
        }
    }

    fn done_wait(&self, seconds: f64) -> bool {
        let mut hook = lock(&self.test.done_wait);
        match hook.as_mut() {
            Some(wait) => wait(self, seconds),
            None => {
                drop(hook);
                self.done.wait(Some(seconds))
            }
        }
    }

    /// Still between the goal's turns, after `turn`, and not done.
    fn still_after(&self, turn: Option<&str>) -> bool {
        let s = self.st();
        !self.done.is_set() && s.between_goal_turns && s.turn.as_deref() == turn
    }

    /// Keeps tool ownership while Codex continues an active goal; never restarts a stopped goal.
    pub(crate) fn await_goal_continuation(&self, finished_turn: Option<&str>) {
        let (routing_failure, retry, recovery_id, provider_available) = {
            let s = self.st();
            (
                s.routing_failure,
                s.routing_retry_available,
                s.recovery_id.clone(),
                s.provider_available,
            )
        };
        if routing_failure && !retry {
            if self.finish(
                "failed",
                "Provider routing remained unavailable",
                finished_turn,
            ) {
                self.session().release(self);
            }
            return;
        }
        if routing_failure
            && recovery_id.is_some()
            && !provider_available
            && !self.wait_for_provider(true, finished_turn)
        {
            return;
        }
        let (idle, check) = (
            self.agent.config.goal_watchdog_idle,
            self.agent.config.goal_watchdog_check,
        );
        let idle_since = self.clock();
        let mut next_retry = idle_since + idle;
        let mut check_failures: u32 = 0;
        let mut wake_attempted = false;
        let mut blocked_busy_checks = 0;
        while self.still_after(finished_turn) {
            let Some(server) = self.server() else { return };
            let thread = self.st().thread.clone();
            let reply = server
                .request("thread/goal/get", json!({"threadId": thread}), 5.0)
                .and_then(|result| match result.get("goal") {
                    Some(goal) => Ok(obj(Some(goal))),
                    None => Err(AgentError::Codex(
                        "Goal status response was incomplete".into(),
                    )),
                });
            let goal = match reply {
                Ok(mut goal) => {
                    let before = self.st().goal_before.clone();
                    if let Some(before) = before {
                        if status_of(&goal) != Some("active") && goal_stamp(&goal) == before {
                            goal = json!({}); // left over from an earlier task, untouched by this one: this task set no goal
                        }
                    }
                    check_failures = 0;
                    goal
                }
                Err(error) => {
                    if !self.still_after(finished_turn) {
                        return;
                    }
                    if !server.alive() {
                        if self.st().on_thread {
                            self.begin_goal_recovery();
                        } else if self.finish(
                            "failed",
                            "Codex stopped while checking goal continuation.",
                            finished_turn,
                        ) {
                            self.session().release(self);
                        }
                        return;
                    }
                    check_failures += 1;
                    if check_failures == 1 {
                        self.event(
                            "error",
                            &format!("Goal status unavailable; retrying: {error}"),
                        );
                    }
                    self.done_wait(30f64.min(2f64.powi(check_failures.min(5) as i32)));
                    continue;
                }
            };
            // A continuation can begin while the status request is in flight. Its
            // older response must never finish or release the newly active turn.
            if !self.still_after(finished_turn) {
                return;
            }
            let (routing_failure, retry, stopped, recovery_id) = {
                let s = self.st();
                (
                    s.routing_failure,
                    s.routing_retry_available,
                    s.stopped,
                    s.recovery_id.clone(),
                )
            };
            if routing_failure && !retry && status_of(&goal) == Some("active") {
                if self.finish(
                    "failed",
                    "Provider routing remained unavailable",
                    finished_turn,
                ) {
                    self.session().release(self);
                }
                return;
            }
            if status_of(&goal) != Some("active") {
                let status = goal.get("status").filter(|s| !s.is_null()).cloned();
                if status.is_none() && routing_failure && retry && !stopped {
                    let attempt = (|| -> Result<Flow, AgentError> {
                        let state = server.request(
                            "thread/read",
                            json!({"threadId": thread, "includeTurns": false}),
                            5.0,
                        )?;
                        let kind = thread_status(&state);
                        if kind.as_deref() != Some("idle") && blocked_busy_checks < 10 {
                            // A completion notification can precede the server's idle transition.
                            blocked_busy_checks += 1;
                            self.done_wait(1.0);
                            return Ok(Flow::Continue);
                        }
                        if kind.as_deref() == Some("idle")
                            && accepts_input(&state)
                            && !self.st().stopped
                            && self.between_after(finished_turn)
                        {
                            let latest = server.request(
                                "thread/goal/get",
                                json!({"threadId": thread}),
                                5.0,
                            )?;
                            if !py::truthy(latest.get("goal")) && !self.st().stopped {
                                self.st().routing_retry_available = false;
                                self.event("doing", "Retrying after a provider connection failure");
                                self.continuation_start(continuation(
                                    &thread,
                                    prompts::CONTINUE_AFTER_PROVIDER_FAILURE,
                                ))?;
                                return Ok(Flow::Return);
                            }
                        }
                        Ok(Flow::On)
                    })();
                    match attempt {
                        Ok(Flow::Continue) => continue,
                        Ok(Flow::Return) => return,
                        Ok(Flow::On) => {}
                        Err(error) => self.event(
                            "error",
                            &format!("Could not continue after provider failure: {error}"),
                        ),
                    }
                }
                if status.as_ref().and_then(Value::as_str) == Some("blocked")
                    && recovery_id.is_some()
                    && !self.st().stopped
                {
                    let attempt = (|| -> Result<Flow, AgentError> {
                        let state = server.request(
                            "thread/read",
                            json!({"threadId": thread, "includeTurns": false}),
                            5.0,
                        )?;
                        let kind = thread_status(&state);
                        if kind.as_deref() != Some("idle") && blocked_busy_checks < 10 {
                            blocked_busy_checks += 1;
                            self.done_wait(1.0);
                            return Ok(Flow::Continue);
                        }
                        if kind.as_deref() == Some("idle")
                            && accepts_input(&state)
                            && !self.st().stopped
                            && self.between_after(finished_turn)
                        {
                            let latest = server.request(
                                "thread/goal/get",
                                json!({"threadId": thread}),
                                5.0,
                            )?;
                            if status_of(&obj(latest.get("goal"))) != Some("blocked")
                                || self.st().stopped
                                || !self.between_after(finished_turn)
                            {
                                return Ok(Flow::Continue);
                            }
                            let id = recovery_id.clone().unwrap_or_default();
                            if task_recovery::reserve(&self.state_dir(), "blocked", Some(&id))?
                                .is_some()
                            {
                                self.event("doing", "Checking for other available work");
                                {
                                    let mut s = self.st();
                                    if s.routing_failure {
                                        s.routing_retry_available = false;
                                    }
                                }
                                self.continuation_start(continuation(
                                    &thread,
                                    prompts::REASSESS_BLOCKED,
                                ))?;
                                return Ok(Flow::Return);
                            }
                        }
                        Ok(Flow::On)
                    })();
                    match attempt {
                        Ok(Flow::Continue) => continue,
                        Ok(Flow::Return) => return,
                        Ok(Flow::On) => {}
                        Err(error) => self.event(
                            "error",
                            &format!("Could not reassess blocked work: {error}"),
                        ),
                    }
                }
                let routing_failed = status.is_none() && self.st().routing_failure;
                let status_text = status.as_ref().map(py::str_of);
                let kind = if matches!(status_text.as_deref(), None | Some("complete"))
                    && !routing_failed
                {
                    "done"
                } else {
                    "failed"
                };
                let final_text = self.st().final_.clone().filter(|f| !f.is_empty());
                let text = final_text.unwrap_or_else(|| {
                    if routing_failed {
                        "Provider routing remained unavailable".into()
                    } else if status.as_ref().is_some_and(|s| py::truthy(Some(s))) {
                        format!("Goal stopped: {}", status_text.clone().unwrap_or_default())
                    } else {
                        "Done.".into()
                    }
                });
                if self.finish(kind, &text, finished_turn) {
                    self.session().release(self);
                }
                return;
            }
            if !wake_attempted && self.clock() >= next_retry {
                // Only wake an actually idle, still-authorized thread. Never replay the last
                // turn: its tools may already have changed state. A native continuation that
                // races this request wins at the server's single-turn boundary.
                let attempt = (|| -> Result<(), AgentError> {
                    let state = server.request(
                        "thread/read",
                        json!({"threadId": thread, "includeTurns": false}),
                        5.0,
                    )?;
                    if thread_status(&state).as_deref() == Some("idle")
                        && accepts_input(&state)
                        && !self.st().stopped
                        && self.between_after(finished_turn)
                    {
                        let latest =
                            server.request("thread/goal/get", json!({"threadId": thread}), 5.0)?;
                        if status_of(&obj(latest.get("goal"))) == Some("active")
                            && !self.st().stopped
                            && self.between_after(finished_turn)
                        {
                            self.event("doing", "Continuing the active goal");
                            wake_attempted = true; // A timeout can still mean the turn was accepted.
                            {
                                let mut s = self.st();
                                if s.routing_failure {
                                    s.routing_retry_available = false;
                                }
                            }
                            self.continuation_start(continuation(
                                &thread,
                                prompts::CONTINUE_ACTIVE_GOAL,
                            ))?;
                        }
                    }
                    Ok(())
                })();
                if let Err(error) = attempt {
                    self.event(
                        "error",
                        &format!("Goal watchdog could not continue: {error}"),
                    );
                }
                next_retry = self.clock() + 60.0;
            }
            self.done_wait(check);
        }
    }

    /// Between the goal's turns, after `turn` (whether or not it's done).
    fn between_after(&self, turn: Option<&str>) -> bool {
        let s = self.st();
        s.between_goal_turns && s.turn.as_deref() == turn
    }

    /// Waits through the configured proxy without resetting a stop or replaying a request.
    pub(crate) fn wait_for_provider(&self, arm: bool, expected_turn: Option<&str>) -> bool {
        self.event(
            "doing",
            "Waiting for provider access through the configured network",
        );
        self.st().provider_waiting = true;
        let result = self.wait_for_provider_steps(arm, expected_turn);
        let available = match result {
            Ok(available) => available,
            Err(error) => {
                self.finish(
                    "failed",
                    &format!("Provider recovery state unavailable: {error}"),
                    None,
                );
                self.session().release(self);
                false
            }
        };
        self.st().provider_waiting = false;
        available
    }

    fn wait_for_provider_steps(
        &self,
        arm: bool,
        expected_turn: Option<&str>,
    ) -> Result<bool, AgentError> {
        let dir = self.state_dir();
        let provider = self.agent.hooks.provider.clone();
        let authorized = |state: &Option<Value>, id: &Option<String>| match state {
            Some(state) => {
                state.get("id").and_then(Value::as_str) == id.as_deref()
                    && state.get("status").and_then(Value::as_str) == Some("active")
            }
            None => false,
        };
        while !self.done.is_set() && !self.st().stopped {
            if expected_turn.is_some() && !self.between_after(expected_turn) {
                return Ok(false);
            }
            let id = self.st().recovery_id.clone();
            let state = task_recovery::current(&dir)?;
            if !authorized(&state, &id) {
                self.st().recovery_id = None; // never overwrite a stop, pause or newer owner
                self.finish(
                    "failed",
                    "Provider recovery authorization is no longer active",
                    None,
                );
                self.session().release(self);
                return Ok(false);
            }
            let identity = id.clone().unwrap_or_default();
            let reservation = provider.reserve(&dir, &identity, arm)?;
            let delay = match reservation {
                None => {
                    self.finish("failed", "Provider recovery state is unavailable", None);
                    self.session().release(self);
                    return Ok(false);
                }
                Some(Reservation::Expired) => {
                    self.finish(
                        "failed",
                        "Provider access did not return within the recovery window",
                        None,
                    );
                    self.session().release(self);
                    return Ok(false);
                }
                Some(Reservation::Check) => {
                    if provider.reachable(&self.agent.env) {
                        if self.st().stopped || self.done.is_set() {
                            return Ok(false);
                        }
                        let latest = task_recovery::current(&dir)?;
                        if !authorized(&latest, &id) {
                            self.st().recovery_id = None;
                            self.finish(
                                "failed",
                                "Provider recovery authorization is no longer active",
                                None,
                            );
                            self.session().release(self);
                            return Ok(false);
                        }
                        let workspace = self.agent.env.get("AGENT_WORKSPACE_ENGINE").is_some()
                            || self.agent.env.get("AGENT_WORKSPACE_CONNECTION").is_some();
                        if workspace && !provider.workspace_is_open(&dir) {
                            self.event("doing", "Provider is reachable; workspace is closed, so recovery is waiting");
                            self.done_wait(30.0);
                            continue;
                        }
                        provider.resolve(&dir, &identity)?;
                        self.st().provider_available = true;
                        return Ok(true);
                    }
                    INTERVAL_SECONDS
                }
                Some(Reservation::Waiting { delay }) => delay,
            };
            self.done_wait(30f64.min(delay));
        }
        Ok(false)
    }

    /// Starts a continuation turn, unless the task was stopped or its saved request is no
    /// longer this task's to continue. (Serialized with stop; callbacks use a different lock.)
    pub(crate) fn continuation_start(&self, params: Value) -> Result<Value, AgentError> {
        let _dispatch = lock(&self.dispatch_lock);
        if self.st().stopped || self.done.is_set() {
            return Err(AgentError::Resume("Task was stopped".into()));
        }
        let id = self.st().recovery_id.clone();
        if let Some(id) = id {
            let state = task_recovery::current(&self.state_dir())?;
            let ok = state.is_some_and(|s| {
                s.get("id").and_then(Value::as_str) == Some(id.as_str())
                    && s.get("status").and_then(Value::as_str) == Some("active")
            });
            if !ok {
                self.st().recovery_id = None; // do not overwrite a pause, stop, or newer owner
                return Err(AgentError::Resume(
                    "Task authorization is no longer active".into(),
                ));
            }
        }
        let server = self
            .server()
            .ok_or_else(|| AgentError::Codex("turn/start: Codex isn't running".into()))?;
        server.request("turn/start", params, 10.0)
    }

    /// Answers Codex's call to one of our tools.
    pub(crate) fn call_tool(&self, params: &Value) -> Value {
        let namespace = py::text(params.get("namespace"))
            .unwrap_or(&self.device)
            .to_owned();
        let tool = params.get("tool").and_then(Value::as_str);
        let arguments = obj(params.get("arguments"));
        let knowledge: &dyn Knowledge = self.agent.hooks.knowledge.as_ref();
        if knowledge.is_call(Some(&namespace), tool, &arguments) {
            return self.call_knowledge(&namespace, params);
        }
        self.record_context("tool input", params);
        let tools = lock(&self.tools).get(&namespace).cloned();
        let stopped = self.st().stopped;
        if !stopped && namespace == "tool_search" {
            // Codex hands its tool search to us in the long-running conversation; there is nothing to
            // load, so say how to reach the sign-in tools instead of failing.
            let reply = hive_common::tools::reply_text(true, prompts::TOOL_SEARCH_REPLY);
            self.record_context(
                "tool output",
                &json!({"callId": params.get("callId"), "result": reply}),
            );
            self.event(
                "data",
                "Result from tool_search: pointed it to the sign-in tools",
            );
            return reply;
        }
        let reply = match (stopped, tools) {
            (false, Some(tools)) => {
                let run = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    self.run_tool(&namespace, tools, params, &arguments)
                }));
                let reply = match run {
                    Ok(Ok(result)) => tool_reply(&result),
                    Ok(Err(error)) => {
                        hive_common::tools::reply_text(false, format!("Failed: {error}"))
                    }
                    Err(panic) => hive_common::tools::reply_text(
                        false,
                        format!("Failed: {}", panic_text(&*panic)),
                    ),
                };
                let ok = reply.get("success") == Some(&Value::Bool(true));
                self.record_action(&namespace, tool.unwrap_or(""), &arguments, ok);
                reply
            }
            _ => {
                let text = if stopped {
                    "Stopped by the user.".to_owned()
                } else {
                    let ns = params
                        .get("namespace")
                        .map(py::str_of)
                        .unwrap_or_else(|| "None".into());
                    format!("There are no {ns} tools.")
                };
                hive_common::tools::reply_text(false, text)
            }
        };
        self.record_context(
            "tool output",
            &json!({"callId": params.get("callId"), "result": reply}),
        );
        let items = reply
            .get("contentItems")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let parts: Vec<String> = items
            .iter()
            .filter(|c| c.get("type").and_then(Value::as_str) == Some("inputText"))
            .map(|c| c.get("text").map(py::str_of).unwrap_or_default())
            .collect();
        let images = items
            .iter()
            .filter(|c| c.get("type").and_then(Value::as_str) == Some("inputImage"))
            .count();
        let mut content = parts.join("\n");
        let length = py::len(&content);
        if length > 20_000 {
            content = format!(
                "{}\n[Activity view shows the first 20,000 of {} characters.]",
                py::chars(&content, 20_000),
                py::thousands(length)
            );
        }
        let shown_namespace = py::text(params.get("namespace"))
            .unwrap_or(&self.device)
            .to_owned();
        let shown_tool = params
            .get("tool")
            .map(py::str_of)
            .unwrap_or_else(|| "None".into());
        let detail = format!("Result from {shown_namespace}.{shown_tool}: ");
        let body = if !content.is_empty() {
            content
        } else if images > 0 {
            format!("{images} image(s) captured")
        } else {
            "No text returned".into()
        };
        self.event("data", &format!("{detail}{body}"));
        reply
    }

    fn run_tool(
        &self,
        namespace: &str,
        tools: Arc<dyn ToolNamespace>,
        params: &Value,
        arguments: &Value,
    ) -> Result<Value, String> {
        let tool = params
            .get("tool")
            .and_then(Value::as_str)
            .ok_or_else(|| "'tool'".to_owned())?;
        let encoded = match tool {
            "read_ingested" => arguments.get("id"),
            "type_text" => arguments.get("text"),
            _ => None,
        }
        .and_then(Value::as_str)
        .unwrap_or("");
        if namespace == "mac"
            && (encoded.starts_with("workspace:") || encoded.starts_with("memory:"))
        {
            let (prefix, body) = encoded.split_once(':').unwrap_or((encoded, ""));
            let request: Value = serde_json::from_str(body).map_err(|e| e.to_string())?;
            if !request.is_object() {
                return Err("Tool request must be a JSON object".into());
            }
            let workspace = self.agent.hooks.workspace_tools.clone();
            return if prefix == "workspace" {
                workspace.workspace(&request)
            } else {
                workspace.memory(&request)
            };
        }
        if namespace == "mac"
            && self.agent.env.get("AGENT_WORKSPACE_ENGINE").is_some()
            && tool != "read_ingested"
        {
            return Ok(
                json!({"isError": true, "content": [{"type": "text", "text": prompts::PHYSICAL_INPUT_DISABLED}]}),
            );
        }
        tools.call(tool, arguments)
    }

    /// The knowledge base's tools (or mac.batch knowledge steps). The context and activity logs get
    /// what was looked up or saved, not the facts' values; the cloud database is their record.
    fn call_knowledge(&self, namespace: &str, params: &Value) -> Value {
        let knowledge = self.agent.hooks.knowledge.clone();
        let arguments = obj(params.get("arguments"));
        let tool = params.get("tool").and_then(Value::as_str);
        let shown = knowledge.describe(Some(namespace), tool, &arguments);
        let mut logged = params.clone();
        logged["arguments"] = json!({"logged as": shown});
        self.record_context("tool input", &logged);
        let (result, summary) = if self.st().stopped {
            (
                json!({"isError": true, "content": [{"type": "text", "text": "Stopped by the user."}]}),
                "stopped".to_owned(),
            )
        } else {
            let call = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                knowledge.call(Some(namespace), tool, &arguments, &self.task, &self.device)
            }))
            .unwrap_or_else(|panic| Err(panic_text(&*panic)));
            match call {
                Ok(done) => done,
                // report to the model instead of failing the call
                Err(error) => (
                    json!({"isError": true, "content": [{"type": "text", "text": format!("Knowledge base error: {error}")}]}),
                    format!("error: {error}"),
                ),
            }
        };
        let reply = tool_reply(&result);
        self.record_context(
            "tool output",
            &json!({"callId": params.get("callId"), "result": {"success": reply["success"], "logged as": summary}}),
        );
        self.event("data", &format!("Result from {shown}: {summary}"));
        reply
    }

    pub(crate) fn interrupt(&self) {
        if let Some(hook) = lock(&self.test.interrupt).as_mut() {
            hook();
            return;
        }
        let (turn, thread, server) = {
            let s = self.st();
            (s.turn.clone(), s.thread.clone(), s.server.clone())
        };
        let (Some(turn), Some(thread), Some(server)) = (turn, thread, server) else {
            return;
        };
        let _ = server.request(
            "turn/interrupt",
            json!({"threadId": thread, "turnId": turn}),
            10.0,
        );
    }

    pub(crate) fn pause_goal_and_interrupt(&self) {
        // Stop is a control action, not a prompt. Pause the existing goal before
        // interrupting so native continuation and the watchdog cannot wake it.
        let (on_thread, server, thread) = {
            let s = self.st();
            (s.on_thread, s.server.clone(), s.thread.clone())
        };
        if let (true, Some(server), Some(thread)) = (on_thread, server, thread) {
            let paused = (|| -> Result<(), AgentError> {
                let result = server.request("thread/goal/get", json!({"threadId": thread}), 5.0)?;
                if status_of(&obj(result.get("goal"))) == Some("active") {
                    server.request(
                        "thread/goal/set",
                        json!({"threadId": thread, "status": "paused", "origin": "user"}),
                        5.0,
                    )?;
                }
                Ok(())
            })();
            if paused.is_err() {
                self.event(
                    "error",
                    "Could not confirm the goal was paused; check its status.",
                );
            }
        }
        self.interrupt();
    }

    /// Waits for it to end; its final reply (None if it failed or was stopped).
    pub fn wait(&self) -> Option<String> {
        self.done.wait(None);
        self.final_text()
    }

    /// Waits up to `seconds` for it to end; whether it has (Python's `task._done.wait(240)`).
    pub fn wait_done(&self, seconds: f64) -> bool {
        self.done.wait(Some(seconds))
    }

    /// Stops Codex's turn. (An action already under way on the Mac stops when control is handed
    /// back: the helper refuses the rest of it.)
    pub fn stop(&self) {
        if self.agent.backend() == "claude" {
            return crate::claude::stop(self);
        }
        let (turn, on_thread, server, thread) = {
            let _dispatch = lock(&self.dispatch_lock);
            let mut s = self.st();
            s.stopped = true;
            (
                s.turn.clone(),
                s.on_thread,
                s.server.is_some(),
                s.thread.is_some(),
            )
        };
        if turn.is_some() || (on_thread && server && thread) {
            self.spawn(Job::PauseGoalAndInterrupt);
        }
        self.st().final_ = None;
        self.finish("failed", "stopped", None);
    }

    /// Interrupts for an update without recording a user stop or pausing the goal.
    pub fn stop_for_maintenance(&self) {
        {
            let _dispatch = lock(&self.dispatch_lock);
            let mut s = self.st();
            s.maintenance_handoff = true;
            s.stopped = true;
        }
        self.interrupt();
        self.st().final_ = None;
        self.finish("failed", "maintenance interruption", None);
    }
}

enum Flow {
    Continue,
    Return,
    On,
}

/// `(createdAt, updatedAt)` of a goal.
fn goal_stamp(goal: &Value) -> (Value, Value) {
    (
        goal.get("createdAt").cloned().unwrap_or(Value::Null),
        goal.get("updatedAt").cloned().unwrap_or(Value::Null),
    )
}

/// `goal.get('status') or 'no active goal'`.
fn describe_status(goal: &Value) -> String {
    match goal.get("status") {
        Some(s) if py::truthy(Some(s)) => py::str_of(s),
        _ => "no active goal".into(),
    }
}

/// The engine operations a workspace-tool command calls: `build/workspace-tool call workspace_...`, or
/// `scripts/workspace-tool.py call workspace_...` from before it was Rust.
fn workspace_tool_calls(command: &str) -> Vec<String> {
    use std::sync::OnceLock;
    static PATTERN: OnceLock<regex::Regex> = OnceLock::new();
    let pattern = PATTERN.get_or_init(|| {
        regex::Regex::new(r"workspace-tool(?:\.py)?\s+call\s+(workspace_[a-z_]+)")
            .expect("valid pattern")
    });
    pattern
        .captures_iter(command)
        .map(|c| c[1].to_owned())
        .collect()
}
