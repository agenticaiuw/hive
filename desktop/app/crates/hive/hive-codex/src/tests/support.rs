//! Stand-ins for what the Python tests mocked: the app-server, a task's session, the devices'
//! tools, the knowledge base, the context inspector and the provider wait. Nothing here touches
//! the real Codex, ~/.codex, the helper or the network.

use crate::provider_wait::{self, Reservation};
use crate::util::{lock, AgentError, Env};
use crate::{
    Agent, CodexTask, Config, ContextRecorder, Hooks, Knowledge, OnMessage, OnToolCall,
    ProviderWait, Server, TaskOptions, TaskSession,
};
use hive_common::tools::ToolNamespace;
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

type Respond = Box<dyn FnMut(&str, &Value) -> Result<Value, AgentError> + Send>;

/// An app-server whose answers a closure gives (Python's `mock.Mock()` server and `Fake`).
pub struct FakeServer {
    pub calls: Mutex<Vec<(String, Value)>>,
    pub alive: AtomicBool,
    pub attached: Mutex<Vec<String>>,
    pub detached: Mutex<Vec<String>>,
    respond: Mutex<Respond>,
}

impl FakeServer {
    pub fn new(
        respond: impl FnMut(&str, &Value) -> Result<Value, AgentError> + Send + 'static,
    ) -> Arc<FakeServer> {
        Arc::new(FakeServer {
            calls: Mutex::new(Vec::new()),
            alive: AtomicBool::new(true),
            attached: Mutex::new(Vec::new()),
            detached: Mutex::new(Vec::new()),
            respond: Mutex::new(Box::new(respond)),
        })
    }

    /// test_resumption.py's `Fake(error=, identity=)`: every request answers with a thread, the
    /// one asked for or "thread-123".
    pub fn identity(error: Option<&str>, identity: Option<&str>) -> Arc<FakeServer> {
        let error = error.map(str::to_owned);
        let identity = identity.map(str::to_owned);
        Self::new(move |_, params| {
            if let Some(e) = &error {
                return Err(AgentError::Codex(e.clone()));
            }
            let id = identity
                .clone()
                .or_else(|| params["threadId"].as_str().map(str::to_owned));
            Ok(json!({"thread": {"id": id.unwrap_or_else(|| "thread-123".into())}}))
        })
    }

    pub fn dead(self: Arc<Self>) -> Arc<FakeServer> {
        self.alive.store(false, Ordering::SeqCst);
        self
    }

    pub fn methods(&self) -> Vec<String> {
        lock(&self.calls).iter().map(|(m, _)| m.clone()).collect()
    }

    pub fn count(&self, method: &str) -> usize {
        self.methods().iter().filter(|m| *m == method).count()
    }

    pub fn last(&self, method: &str) -> Option<Value> {
        lock(&self.calls)
            .iter()
            .rev()
            .find(|(m, _)| m == method)
            .map(|(_, p)| p.clone())
    }

    pub fn dyn_(self: &Arc<Self>) -> Arc<dyn Server> {
        self.clone()
    }
}

impl Server for FakeServer {
    fn request(&self, method: &str, params: Value, _timeout: f64) -> Result<Value, AgentError> {
        lock(&self.calls).push((method.to_owned(), params.clone()));
        let mut respond = lock(&self.respond);
        respond(method, &params)
    }
    fn attach(&self, thread: &str, _: OnMessage, _: OnToolCall) {
        lock(&self.attached).push(thread.to_owned());
    }
    fn detach(&self, thread: &str) {
        lock(&self.detached).push(thread.to_owned());
    }
    fn alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }
}

/// A task's session as `mock.Mock()` was: `thread_for` answers what it's given, and calls are
/// counted.
#[derive(Default)]
pub struct MockSession {
    pub thread: Mutex<Option<(String, String)>>,
    pub expected: Mutex<Vec<Option<String>>>,
    pub releases: AtomicUsize,
}

impl MockSession {
    pub fn with_thread(thread: &str) -> Arc<MockSession> {
        let session = MockSession::default();
        *lock(&session.thread) = Some((thread.to_owned(), String::new()));
        Arc::new(session)
    }
    pub fn released(&self) -> usize {
        self.releases.load(Ordering::SeqCst)
    }
}

impl TaskSession for MockSession {
    fn add(&self, _: &Arc<CodexTask>) {}
    fn thread_for(
        &self,
        _: &Arc<CodexTask>,
        _: &Arc<dyn Server>,
        _: Value,
        expected_thread: Option<&str>,
    ) -> Result<(String, String), AgentError> {
        lock(&self.expected).push(expected_thread.map(str::to_owned));
        lock(&self.thread)
            .clone()
            .ok_or_else(|| AgentError::Resume("no thread".into()))
    }
    fn release(&self, _: &CodexTask) {
        self.releases.fetch_add(1, Ordering::SeqCst);
    }
    fn context_error(&self) -> Option<String> {
        None
    }
}

/// A device's tools: `wait` says "Waited." (as PhoneTools' does without a phone), `look` gives a
/// synthetic screenshot, and every call is recorded.
pub struct FakeTool {
    namespace: &'static str,
    pub calls: Mutex<Vec<(String, Value)>>,
    /// What every call returns instead (Python's `tool.call.return_value` / `side_effect`).
    pub result: Mutex<Option<Result<Value, String>>>,
    /// What `look` returns (Err: no screenshot).
    pub look: Mutex<Result<Value, String>>,
    pub looks: AtomicUsize,
    pub closed: AtomicUsize,
    /// What the task told it the user said (`set_words`).
    pub words: Mutex<String>,
    pub let_go: AtomicUsize,
}

impl FakeTool {
    pub fn new(namespace: &'static str) -> Arc<FakeTool> {
        Arc::new(FakeTool {
            namespace,
            calls: Mutex::new(Vec::new()),
            result: Mutex::new(None),
            look: Mutex::new(Ok(json!({"content": [
                {"type": "image", "mimeType": "image/png", "data": "QUJD"},
                {"type": "text", "text": "Synthetic windows: Notes"}]}))),
            looks: AtomicUsize::new(0),
            closed: AtomicUsize::new(0),
            words: Mutex::new(String::new()),
            let_go: AtomicUsize::new(0),
        })
    }
    pub fn returning(self: Arc<Self>, result: Result<Value, String>) -> Arc<FakeTool> {
        *lock(&self.result) = Some(result);
        self
    }
}

impl ToolNamespace for FakeTool {
    fn namespace(&self) -> &'static str {
        self.namespace
    }
    fn about(&self) -> &'static str {
        "A synthetic device."
    }
    fn tools(&self) -> Vec<Value> {
        let own = if self.namespace == "mac" {
            "batch"
        } else {
            "tap"
        };
        [own, "wait"]
            .iter()
            .map(|name| json!({"name": name, "description": format!("{name}."), "inputSchema": {"type": "object"}}))
            .collect()
    }
    fn call(&self, tool: &str, args: &Value) -> Result<Value, String> {
        lock(&self.calls).push((tool.to_owned(), args.clone()));
        if let Some(result) = lock(&self.result).clone() {
            return result;
        }
        Ok(hive_common::tools::ok_text(if tool == "wait" {
            "Waited."
        } else {
            "Done."
        }))
    }
    fn look(&self, _context: bool) -> Result<Value, String> {
        self.looks.fetch_add(1, Ordering::SeqCst);
        lock(&self.look).clone()
    }
    fn close(&self) {
        self.closed.fetch_add(1, Ordering::SeqCst);
    }
    fn set_words(&self, words: &str) {
        *lock(&self.words) = words.to_owned();
    }
    fn let_go(&self) {
        self.let_go.fetch_add(1, Ordering::SeqCst);
    }
}

/// A knowledge base with knowledge.NAMESPACE's two tools and nothing behind them.
pub struct TestKnowledge;
impl Knowledge for TestKnowledge {
    fn namespace(&self) -> Option<Value> {
        let tool = |name: &str| json!({"type": "function", "name": name, "description": name, "inputSchema": {"type": "object"}});
        Some(
            json!({"type": "namespace", "name": "knowledge", "description": "The owner's knowledge base.",
                    "tools": [tool("lookup"), tool("save")]}),
        )
    }
}

/// One record the context inspector was given.
#[derive(Clone, Debug)]
pub struct Record {
    pub kind: String,
    pub payload: Value,
    pub thread: Option<String>,
}

/// The context inspector, in memory (Python's ContextLog files under `<state>/context`).
#[derive(Default)]
pub struct MemoryContext {
    pub records: Mutex<Vec<Record>>,
    pub fail: Mutex<Option<String>>,
}

impl MemoryContext {
    pub fn all(&self) -> Vec<Record> {
        lock(&self.records).clone()
    }
}

impl ContextRecorder for MemoryContext {
    fn record(
        &self,
        kind: &str,
        payload: &Value,
        _task: Option<&str>,
        thread: Option<&str>,
    ) -> Result<Option<String>, String> {
        if let Some(error) = lock(&self.fail).clone() {
            return Err(error);
        }
        lock(&self.records).push(Record {
            kind: kind.into(),
            payload: payload.clone(),
            thread: thread.map(str::to_owned),
        });
        Ok(None)
    }
}

/// provider_wait as the tests patched it: scripted answers first, then the real state files
/// (and never a network probe).
#[derive(Default)]
pub struct ScriptedProvider {
    pub reservations: Mutex<VecDeque<Option<Reservation>>>,
    pub repeat: Mutex<Option<Option<Reservation>>>,
    pub reachable: Mutex<VecDeque<bool>>,
    pub always_reachable: AtomicBool,
    pub probes: AtomicUsize,
    pub arms: Mutex<Vec<bool>>,
    pub resolved: Mutex<Vec<String>>,
    pub fake_resolve: AtomicBool,
}

impl ProviderWait for ScriptedProvider {
    fn reserve(
        &self,
        dir: &Path,
        identity: &str,
        arm: bool,
    ) -> Result<Option<Reservation>, AgentError> {
        lock(&self.arms).push(arm);
        if let Some(next) = lock(&self.reservations).pop_front() {
            return Ok(next);
        }
        if let Some(always) = lock(&self.repeat).clone() {
            return Ok(always);
        }
        provider_wait::reserve(dir, identity, None, arm)
    }
    fn resolve(&self, dir: &Path, identity: &str) -> Result<bool, AgentError> {
        lock(&self.resolved).push(identity.to_owned());
        if self.fake_resolve.load(Ordering::SeqCst) {
            return Ok(true);
        }
        provider_wait::resolve(dir, identity)
    }
    fn reachable(&self, _env: &Env) -> bool {
        self.probes.fetch_add(1, Ordering::SeqCst);
        lock(&self.reachable)
            .pop_front()
            .unwrap_or_else(|| self.always_reachable.load(Ordering::SeqCst))
    }
    fn workspace_is_open(&self, _dir: &Path) -> bool {
        false
    }
}

/// An agent in a temporary state folder (Python's `Isolated`), with fake devices, a test
/// knowledge base, the in-memory context inspector and the scripted provider wait.
pub struct Harness {
    pub dir: Arc<tempfile::TempDir>,
    pub agent: Arc<Agent>,
    pub context: Arc<MemoryContext>,
    pub provider: Arc<ScriptedProvider>,
    pub mac: Arc<FakeTool>,
    pub phone: Arc<FakeTool>,
}

pub fn instructions_path() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../python/instructions.md")
}

/// The variables a test must not inherit from whoever runs it.
const ISOLATE: [&str; 16] = [
    "AGENT_WORKSPACE_ENGINE",
    "AGENT_WORKSPACE_CONNECTION",
    "AGENT_WORKSPACE_BRIDGE",
    "AGENT_FAST",
    "AGENT_MODEL",
    "AGENT_EFFORT",
    "AGENT_BACKEND",
    "CODEX_BIN",
    "FAKE_CODEX_LOG",
    "FAKE_CODEX_SECONDS",
    "FAKE_CODEX_REPLY",
    "FAKE_CODEX_STORE",
    "FAKE_CODEX_CRASH_ONCE",
    "FAKE_CODEX_RESUME_ERROR",
    "FAKE_CODEX_GOAL",
    "TEST_PROMPT",
];

impl Harness {
    pub fn new() -> Harness {
        Self::with(|_, _| {})
    }

    pub fn with(setup: impl FnOnce(&Env, &mut Config)) -> Harness {
        Self::with_hooks(setup, |_| {})
    }

    /// [`Harness::with`], with `adjust` changing the hooks the agent gets (a memory, an action
    /// log).
    pub fn with_hooks(
        setup: impl FnOnce(&Env, &mut Config),
        adjust: impl FnOnce(&mut Hooks),
    ) -> Harness {
        let dir = tempfile::Builder::new()
            .prefix("hive-codex-test-")
            .tempdir()
            .unwrap();
        Self::in_dir(
            Arc::new(dir),
            Arc::new(MemoryContext::default()),
            setup,
            adjust,
        )
    }

    /// Another agent (a new process, in the Python tests) on the same state folder, with the
    /// same context inspector.
    pub fn again(&self, setup: impl FnOnce(&Env, &mut Config)) -> Harness {
        Self::in_dir(self.dir.clone(), self.context.clone(), setup, |_| {})
    }

    fn in_dir(
        dir: Arc<tempfile::TempDir>,
        context: Arc<MemoryContext>,
        setup: impl FnOnce(&Env, &mut Config),
        adjust: impl FnOnce(&mut Hooks),
    ) -> Harness {
        let env = Env::default();
        for key in ISOLATE {
            env.unset(key);
        }
        env.set("AGENT_STATE_DIR", dir.path().display().to_string());
        env.set("CODEX_HOME", dir.path().display().to_string());
        env.set("AGENT_ENV_FILE", "/dev/null");
        let mut config = Config {
            log: dir.path().join("codex.log"),
            workdir: dir.path().join("work"),
            models_catalog: dir.path().join("models.json"),
            instructions: instructions_path(),
            transport: None,
            ..Config::default()
        };
        setup(&env, &mut config);
        let provider = Arc::new(ScriptedProvider::default());
        let (mac, phone) = (FakeTool::new("mac"), FakeTool::new("phone"));
        let (m, p) = (mac.clone(), phone.clone());
        let mut hooks = Hooks {
            device_tools: Arc::new(move || vec![m.clone() as Arc<dyn ToolNamespace>, p.clone()]),
            knowledge: Arc::new(TestKnowledge),
            context: context.clone(),
            provider: provider.clone(),
            ..Hooks::default()
        };
        adjust(&mut hooks);
        let agent = Agent::new(env, config, hooks);
        Harness {
            dir,
            agent,
            context,
            provider,
            mac,
            phone,
        }
    }

    pub fn path(&self) -> &Path {
        self.dir.path()
    }

    /// `agent.CodexTask(text)` with a mock session and threads recorded instead of started.
    pub fn task(&self, text: &str) -> (Arc<CodexTask>, Arc<MockSession>) {
        let session = Arc::new(MockSession::default());
        let task = CodexTask::new(
            &self.agent,
            text,
            TaskOptions {
                session: Some(session.clone()),
                ..TaskOptions::default()
            },
        );
        *lock(&task.test.spawned) = Some(Vec::new());
        (task, session)
    }

    /// The server the agent starts (Python's `mock.patch("agent.codex_server", return_value=...)`).
    pub fn serve(&self, server: &Arc<FakeServer>) {
        let server = server.dyn_();
        *lock(&self.agent.server_factory) = Some(Box::new(move |_: &Agent| Ok(server.clone())));
        *lock(&self.agent.params_override) = Some(json!({}));
    }
}

/// Events a task sends, collected.
#[derive(Clone, Default)]
pub struct Events(pub Arc<Mutex<Vec<(String, String)>>>);

impl Events {
    pub fn on_event(&self) -> crate::OnEvent {
        let events = self.0.clone();
        Arc::new(move |kind: &str, text: &str| {
            lock(&events).push((kind.to_owned(), text.to_owned()))
        })
    }
    pub fn all(&self) -> Vec<(String, String)> {
        lock(&self.0).clone()
    }
    pub fn has(&self, kind: &str, text: &str) -> bool {
        self.all().iter().any(|(k, t)| k == kind && t == text)
    }
    pub fn last(&self) -> Option<(String, String)> {
        self.all().last().cloned()
    }
}

/// Waits up to `seconds` for `check`.
pub fn until(seconds: f64, mut check: impl FnMut() -> bool) {
    let end = std::time::Instant::now() + std::time::Duration::from_secs_f64(seconds);
    while !check() {
        assert!(std::time::Instant::now() < end, "timed out");
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
}

/// A clock that answers these times in turn (Python's `mock.patch("agent.time.monotonic",
/// side_effect=[...])`), then the last for ever.
pub fn clock(times: &[f64]) -> Box<dyn FnMut() -> f64 + Send> {
    let mut times: VecDeque<f64> = times.iter().copied().collect();
    let mut last = 0.0;
    Box::new(move || {
        if let Some(t) = times.pop_front() {
            last = t;
        }
        last
    })
}

/// An action log that keeps what it was given: "begin <request>", "step <namespace>.<tool> <ok>
/// <arguments>", "end <outcome>".
#[derive(Default)]
pub struct ActionsSeen(pub Mutex<Vec<String>>);

impl ActionsSeen {
    pub fn all(&self) -> Vec<String> {
        lock(&self.0).clone()
    }
}

impl crate::hooks::ActionLog for ActionsSeen {
    fn begin(&self, task: &crate::hooks::ActionTask) {
        lock(&self.0).push(format!("begin {}", task.request));
    }
    fn step(
        &self,
        _task: &crate::hooks::ActionTask,
        namespace: &str,
        tool: &str,
        args: &Value,
        ok: bool,
    ) {
        lock(&self.0).push(format!("step {namespace}.{tool} {ok} {args}"));
    }
    fn end(&self, _task: &crate::hooks::ActionTask, outcome: &str) {
        lock(&self.0).push(format!("end {outcome}"));
    }
}
