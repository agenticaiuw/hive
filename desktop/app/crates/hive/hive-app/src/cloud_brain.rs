//! Hive on the Mac with its brain in the cloud (owner, 2026-11-18: "The Mac's agent still thinks on
//! the Mac. Its Codex runs locally; the design goal is a cloud brain driving the Mac").
//!
//! - [`MacPeer`]: this Mac as a device of Hive's cloud agent. It puts its tools on the board
//!   (POST /v1/mac/hello), asks for the agent's next call on them (GET /v1/mac/next, which the board
//!   holds open), runs it with hive-mac's MacTools and every rule they keep (the owner taking the
//!   mouse and keyboard; a one-way step quoting the owner's own words for that request, which the
//!   board sends with the call) and posts what came of it (POST /v1/mac/result). The board's side is
//!   cloud/tasks/mac.js; the agent's is cloud/vm-agent/mac-mcp.mjs.
//! - [`CloudBackend`]: what the owner asks Hive on the Mac goes to the cloud agent as a request
//!   (POST /v1/requests, from "mac"), and the Mac follows it (GET /v1/requests/state?steps=1): its
//!   replies are said, its steps shown, its end is the task's end, and the window's x stops it
//!   (POST /v1/requests/stop). The Mac's own Codex is what's left when the cloud can't take it: the
//!   board out of reach, this Mac not connected for a Mac task, or a turn that isn't a request
//!   (adding a document to the conversation). `HIVE_BRAIN=local` keeps everything on the Mac.

use crate::parts::{self, Backend, Look, OnEvent};
use hive_common::tools::ToolNamespace;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, Weak};
use std::time::{Duration, Instant};

/// The cloud board, as this module uses it (a fake in tests).
pub trait Board: Send + Sync {
    fn post(&self, path: &str, body: &Value) -> Result<Value, String>;
    /// `GET path`, given `wait_s` seconds more than usual, for a page the board holds open.
    fn get(&self, path: &str, wait_s: u64) -> Result<Value, String>;
    /// This Mac's name on the board.
    fn machine(&self) -> String;
}

impl Board for hive_tasks::Cloud {
    fn post(&self, path: &str, body: &Value) -> Result<Value, String> {
        hive_tasks::Cloud::post(self, path, body)
    }
    fn get(&self, path: &str, wait_s: u64) -> Result<Value, String> {
        self.get_for(path, 10 + wait_s)
    }
    fn machine(&self) -> String {
        self.machine.clone()
    }
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// How often things happen (shorter in tests).
#[derive(Clone, Debug)]
pub struct Pace {
    /// How long the board holds a "next call?" open (mac.js caps it at 25).
    pub wait_s: u64,
    /// Between looks at a request the Mac follows.
    pub follow: Duration,
    /// After the board didn't answer, before asking again (doubling up to `most_retry`).
    pub retry: Duration,
    pub most_retry: Duration,
    /// The Mac's tools let go of the helper after this long without a call.
    pub idle: Duration,
    /// The board out of reach this long while the Mac follows a request: it stops following.
    pub lost: Duration,
    /// The board answered a "next call?" this recently: the cloud agent can reach this Mac.
    pub fresh: Duration,
    /// Tools and about put on the board again after this long (they only change with an update).
    pub hello_again: Duration,
}

impl Default for Pace {
    fn default() -> Pace {
        Pace {
            wait_s: 20,
            follow: Duration::from_millis(1200),
            retry: Duration::from_secs(3),
            most_retry: Duration::from_secs(60),
            idle: Duration::from_secs(90),
            lost: Duration::from_secs(180),
            fresh: Duration::from_secs(60),
            hello_again: Duration::from_secs(600),
        }
    }
}

/// Makes the Mac's tools: hive-mac's MacTools, a fresh set after they let go when idle.
pub type MakeTools = Box<dyn Fn() -> Arc<dyn ToolNamespace> + Send + Sync>;

/// This Mac, serving the cloud agent's calls on its tools.
pub struct MacPeer {
    board: Arc<dyn Board>,
    make: MakeTools,
    tools: Mutex<Option<Arc<dyn ToolNamespace>>>,
    name: String,
    pace: Pace,
    /// The requests this Mac sent and follows: their tasks hear each step the agent takes here.
    listeners: Mutex<HashMap<i64, OnEvent>>,
    /// When the board last answered a "next call?" (None: not yet, or it failed since).
    answered: Mutex<Option<Instant>>,
    last_call: Mutex<Option<Instant>>,
    /// A call is running now, and when the last one ended (or the peer started): for the updater,
    /// which waits for the Mac to be quiet (hive_tasks::update).
    in_call: AtomicBool,
    quiet_since: Mutex<Instant>,
    stopped: AtomicBool,
}

impl MacPeer {
    pub fn new(board: Arc<dyn Board>, make: MakeTools, pace: Pace) -> Arc<MacPeer> {
        let name = board.machine().trim().to_lowercase();
        Arc::new(MacPeer {
            board,
            make,
            tools: Mutex::new(None),
            name,
            pace,
            listeners: Mutex::new(HashMap::new()),
            answered: Mutex::new(None),
            last_call: Mutex::new(None),
            in_call: AtomicBool::new(false),
            quiet_since: Mutex::new(Instant::now()),
            stopped: AtomicBool::new(false),
        })
    }

    /// Serves the cloud agent's calls in the background until [`MacPeer::stop`].
    pub fn start(self: &Arc<Self>) {
        let me = self.clone();
        let _ = std::thread::Builder::new()
            .name("mac-peer".into())
            .spawn(move || me.serve());
    }

    pub fn stop(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        self.close_tools();
    }

    /// This Mac's name on the board.
    pub fn name(&self) -> &str {
        &self.name
    }

    /// The cloud agent can reach this Mac: the board answered its last "next call?" lately.
    pub fn connected(&self) -> bool {
        lock(&self.answered).is_some_and(|at| at.elapsed() < self.pace.fresh)
    }

    fn tools(&self) -> Arc<dyn ToolNamespace> {
        lock(&self.tools).get_or_insert_with(|| (self.make)()).clone()
    }

    fn close_tools(&self) {
        let tools = lock(&self.tools).take();
        if let Some(tools) = tools {
            tools.close();
        }
    }

    /// Puts this Mac and its tools on the board, for the agent's tool list.
    pub fn hello(&self) -> Result<(), String> {
        let tools = self.tools();
        self.board.post(
            "/v1/mac/hello",
            &json!({"mac": self.name, "tools": tools.tools(), "about": tools.about()}),
        )?;
        Ok(())
    }

    fn serve(&self) {
        let mut retry = self.pace.retry;
        let mut said_hello: Option<Instant> = None;
        while !self.stopped.load(Ordering::SeqCst) {
            if said_hello.is_none_or(|at| at.elapsed() > self.pace.hello_again) {
                if self.hello().is_err() {
                    *lock(&self.answered) = None;
                    self.pause(retry);
                    retry = (retry * 2).min(self.pace.most_retry);
                    continue;
                }
                said_hello = Some(Instant::now());
            }
            match self.next() {
                Ok(call) => {
                    retry = self.pace.retry;
                    match call {
                        Some(call) => self.run(&call),
                        None => self.let_go_when_idle(),
                    }
                }
                Err(_) => {
                    *lock(&self.answered) = None;
                    said_hello = None;
                    self.pause(retry);
                    retry = (retry * 2).min(self.pace.most_retry);
                }
            }
        }
    }

    /// The agent's next call on this Mac, if one comes while the board holds the question open.
    pub fn next(&self) -> Result<Option<Value>, String> {
        let path = format!(
            "/v1/mac/next?mac={}&wait={}",
            encode(&self.name),
            self.pace.wait_s
        );
        let answer = self.board.get(&path, self.pace.wait_s)?;
        *lock(&self.answered) = Some(Instant::now());
        Ok(answer.get("call").filter(|c| c.is_object()).cloned())
    }

    /// Runs one call with the Mac's tools and posts what came of it. A step for a request this Mac
    /// follows is shown on it as it happens, and a one-way step the tools took is said aloud.
    pub fn run(&self, call: &Value) {
        *lock(&self.last_call) = Some(Instant::now());
        self.in_call.store(true, Ordering::SeqCst);
        let id = call["id"].as_i64().unwrap_or(0);
        let name = call["name"].as_str().unwrap_or("");
        let args = match call.get("arguments") {
            Some(a) if a.is_object() => a.clone(),
            _ => json!({}),
        };
        let step = args["step"].as_str().unwrap_or("").trim().to_owned();
        let one_way = step.to_lowercase().starts_with("one-way");
        let on_event = call["request"]
            .as_i64()
            .and_then(|r| lock(&self.listeners).get(&r).cloned());
        if let Some(on_event) = &on_event {
            if !step.is_empty() && !one_way {
                on_event("action", &step);
            }
        }
        let tools = self.tools();
        // What the owner said for this request: a one-way step must quote it (hive-mac's check_step).
        tools.set_words(call["words"].as_str().unwrap_or(""));
        let ran = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| tools.call(name, &args)));
        let body = match ran {
            Ok(Ok(result)) => {
                if one_way && result["isError"] != json!(true) {
                    if let Some(on_event) = &on_event {
                        let said = step.split_once(':').map_or(step.as_str(), |(_, rest)| rest);
                        on_event("announce", said.trim());
                    }
                }
                json!({"id": id, "result": result})
            }
            Ok(Err(error)) => json!({"id": id, "result": {
                "content": [{"type": "text", "text": format!("Failed: {error}")}], "isError": true}}),
            Err(_) => {
                self.close_tools();
                json!({"id": id, "error": format!("The Mac's {name} tool crashed.")})
            }
        };
        for attempt in 0..3 {
            if self.board.post("/v1/mac/result", &body).is_ok() {
                break;
            }
            if attempt < 2 {
                self.pause(self.pace.retry);
            }
        }
        *lock(&self.last_call) = Some(Instant::now());
        *lock(&self.quiet_since) = Instant::now();
        self.in_call.store(false, Ordering::SeqCst);
    }

    /// No call of the cloud agent's is running on this Mac, and none has for `how_long`.
    pub fn quiet_for(&self, how_long: Duration) -> bool {
        !self.in_call.load(Ordering::SeqCst) && lock(&self.quiet_since).elapsed() >= how_long
    }

    /// Steps the agent takes on this Mac for `request` go to `on_event` while it's followed.
    pub fn listen(&self, request: i64, on_event: OnEvent) {
        lock(&self.listeners).insert(request, on_event);
    }

    pub fn unlisten(&self, request: i64) {
        lock(&self.listeners).remove(&request);
    }

    /// The owner just took the mouse and keyboard (the tools put their cursor and app back).
    pub fn took_over(&self) {
        let tools = lock(&self.tools).clone();
        if let Some(tools) = tools {
            tools.took_over();
        }
    }

    /// The owner handed the screen back.
    pub fn handed_back(&self) {
        let tools = lock(&self.tools).clone();
        if let Some(tools) = tools {
            tools.handed_back();
        }
    }

    fn let_go_when_idle(&self) {
        let idle = lock(&self.last_call).is_some_and(|at| at.elapsed() > self.pace.idle);
        if idle {
            *lock(&self.last_call) = None;
            self.close_tools();
        }
    }

    fn pause(&self, how_long: Duration) {
        let until = Instant::now() + how_long;
        while !self.stopped.load(Ordering::SeqCst) && Instant::now() < until {
            std::thread::sleep(Duration::from_millis(50).min(how_long));
        }
    }
}

/// A query string value, percent-encoded.
fn encode(value: &str) -> String {
    value
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// The shell's backend with the brain in the cloud: requests go to Hive's cloud agent, everything
/// else (the conversation's files, recovery, the app-server) stays the Mac's own Codex.
pub struct CloudBackend {
    local: Arc<dyn Backend>,
    board: Arc<dyn Board>,
    peer: Arc<MacPeer>,
    pace: Pace,
    /// The request each device's last task was, so a newer request that interrupts it follows it.
    last: Arc<Mutex<HashMap<String, i64>>>,
}

impl CloudBackend {
    pub fn new(local: Arc<dyn Backend>, board: Arc<dyn Board>, peer: Arc<MacPeer>, pace: Pace) -> CloudBackend {
        CloudBackend {
            local,
            board,
            peer,
            pace,
            last: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

/// The backend Hive.app runs: the cloud brain, with this Mac serving its calls, when the board's
/// config is here (~/.config/hive/tasks.json) and `HIVE_BRAIN` isn't "local"; else `local` alone.
pub fn backend(local: Arc<dyn Backend>) -> (Arc<dyn Backend>, Option<Arc<MacPeer>>) {
    if std::env::var("HIVE_BRAIN").is_ok_and(|b| b.trim().eq_ignore_ascii_case("local")) {
        return (local, None);
    }
    let Some(cloud) = hive_tasks::Cloud::load() else {
        return (local, None);
    };
    let board: Arc<dyn Board> = Arc::new(cloud);
    let make: MakeTools = Box::new(|| Arc::new(hive_mac::MacTools::new()) as Arc<dyn ToolNamespace>);
    let peer = MacPeer::new(board.clone(), make, Pace::default());
    peer.start();
    let backend = CloudBackend::new(local, board, peer.clone(), Pace::default());
    (Arc::new(backend), Some(peer))
}

impl Backend for CloudBackend {
    fn task(&self, text: &str, previous: Option<&str>, device: &str, ahead: Option<Look>) -> Arc<dyn parts::Task> {
        let local = self.local.task(text, previous, device, ahead);
        Arc::new_cyclic(|me| CloudJob {
            me: me.clone(),
            text: text.to_owned(),
            device: device.to_owned(),
            follows_previous: previous.is_some_and(|p| !p.is_empty()),
            local,
            board: self.board.clone(),
            peer: self.peer.clone(),
            pace: self.pace.clone(),
            last: self.last.clone(),
            state: Mutex::new(JobState {
                started_at: crate::util::now(),
                began: crate::util::monotonic(),
                ..JobState::default()
            }),
            changed: Condvar::new(),
        })
    }
    fn focus(&self, words: &str) -> String {
        self.local.focus(words)
    }
    fn new_session(&self) {
        self.local.new_session()
    }
    fn look_ahead(&self) -> Option<Look> {
        self.local.look_ahead()
    }
    fn describe_model(&self) -> String {
        format!("Hive's cloud agent (on the Mac when it can't: {})", self.local.describe_model())
    }
    fn server_running(&self) -> bool {
        self.local.server_running()
    }
    fn request(&self, method: &str, params: Value, timeout: f64) -> Option<Result<Value, String>> {
        self.local.request(method, params, timeout)
    }
    fn restore(&self) -> Result<Option<Arc<dyn parts::Task>>, String> {
        // A request in the cloud goes on there by itself; what's restored is the Mac's own.
        self.local.restore()
    }
    fn recovery_current(&self) -> Result<Option<Value>, String> {
        self.local.recovery_current()
    }
    fn recovery_finish(&self, id: &str, status: &str) -> Result<(), String> {
        self.local.recovery_finish(id, status)
    }
    fn provider_status(&self, id: &str) -> Result<Option<String>, String> {
        self.local.provider_status(id)
    }
}

#[derive(Clone, Copy, Default, PartialEq, Debug)]
enum Mode {
    #[default]
    NotStarted,
    Cloud,
    Local,
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum Stop {
    /// The owner stopped it: the cloud agent is told to stop.
    Owner,
    /// Hive restarts for an update: the request goes on in the cloud.
    Maintenance,
}

#[derive(Default)]
struct JobState {
    mode: Mode,
    look: bool,
    request: Option<i64>,
    on_event: Option<OnEvent>,
    /// A turn with its own prompt (a document added to the conversation): the Mac's Codex.
    prompt: bool,
    started_at: f64,
    began: f64,
    finished_at: Option<f64>,
    final_text: Option<String>,
    ended: String,
    over: bool,
    stop: Option<Stop>,
}

/// One request, on Hive's cloud agent (or on the Mac's Codex when the cloud can't take it).
pub struct CloudJob {
    me: Weak<CloudJob>,
    text: String,
    device: String,
    follows_previous: bool,
    local: Arc<dyn parts::Task>,
    board: Arc<dyn Board>,
    peer: Arc<MacPeer>,
    pace: Pace,
    last: Arc<Mutex<HashMap<String, i64>>>,
    state: Mutex<JobState>,
    changed: Condvar,
}

/// How a request ended, read from its state: the event, its text, and its reply.
fn end_of(state: &Value, said: Option<&str>) -> Option<(&'static str, String, Option<String>)> {
    let request = &state["request"];
    let outcome = request["outcome"].as_str().unwrap_or("").trim().to_owned();
    match request["status"].as_str()? {
        "done" => {
            let empty = Vec::new();
            let tasks = state["tasks"].as_array().unwrap_or(&empty);
            if tasks.iter().any(|t| matches!(t["status"].as_str(), Some("waiting" | "blocked"))) {
                // It stopped for the owner, or short of the end: its words are the answer.
                let text = if outcome.is_empty() { "It stopped before it finished.".to_owned() } else { outcome };
                return Some(("failed", text.clone(), Some(text)));
            }
            let reply = said.map(str::to_owned).filter(|s| !s.is_empty()).unwrap_or(if outcome.is_empty() {
                "Done.".to_owned()
            } else {
                outcome
            });
            Some(("done", reply.clone(), Some(reply)))
        }
        "failed" => {
            let text = if outcome.is_empty() { "Hive's cloud agent couldn't do it.".to_owned() } else { outcome };
            Some(("failed", text, None))
        }
        _ => None,
    }
}

impl CloudJob {
    fn st(&self) -> MutexGuard<'_, JobState> {
        lock(&self.state)
    }

    fn mode(&self) -> Mode {
        self.st().mode
    }

    fn emit(&self, kind: &str, text: &str) {
        let on_event = self.st().on_event.clone();
        if let Some(on_event) = on_event {
            on_event(kind, text);
        }
    }

    /// Ends it once: `kind` ("done" or "failed") with `text`.
    fn finish(&self, kind: &str, text: &str, final_text: Option<String>, ended: &str, emit: bool) {
        {
            let mut st = self.st();
            if st.over {
                return;
            }
            st.over = true;
            st.final_text = final_text;
            st.ended = ended.to_owned();
            st.finished_at = Some(crate::util::now());
        }
        self.changed.notify_all();
        if emit {
            self.emit(kind, text);
        }
    }

    /// Runs it on the Mac's Codex instead.
    fn run_locally(&self, why: Option<&str>) {
        let look = {
            let mut st = self.st();
            st.mode = Mode::Local;
            st.look
        };
        if let Some(why) = why {
            self.emit("error", why);
        }
        self.local.start(look);
    }

    /// Waits up to `how_long`, or until it's stopped.
    fn rest(&self, how_long: Duration) {
        let st = self.st();
        if st.stop.is_none() {
            let _ = self.changed.wait_timeout(st, how_long);
        }
    }

    /// Sends the request and follows it to its end.
    fn follow(&self) {
        let follows = if self.follows_previous { lock(&self.last).get(&self.device).copied() } else { None };
        let sent = match follows {
            Some(request) => self
                .board
                .post("/v1/runs/message", &json!({"request": request, "text": self.text, "from": "mac"}))
                .and_then(|v| v["request"].as_i64().ok_or_else(|| format!("the board answered {v}"))),
            None => self
                .board
                .post("/v1/requests", &json!({"text": self.text, "from": "mac"}))
                .and_then(|v| v["id"].as_i64().ok_or_else(|| format!("the board answered {v}"))),
        };
        let id = match sent {
            Ok(id) => id,
            Err(error) => {
                if self.st().stop.is_some() {
                    return; // stopped before it was sent: nothing to tell the cloud
                }
                return self.run_locally(Some(&format!(
                    "Hive's cloud agent can't be reached, so this runs on the Mac ({error})"
                )));
            }
        };
        self.st().request = Some(id);
        lock(&self.last).insert(self.device.clone(), id);
        let me = self.me.clone();
        self.peer.listen(
            id,
            Arc::new(move |kind: &str, text: &str| {
                if let Some(me) = me.upgrade() {
                    me.emit(kind, text);
                }
            }),
        );
        let mut seen: HashSet<(String, i64)> = HashSet::new();
        let mut planned = false;
        let mut said: Option<String> = None;
        let mut reached = Instant::now();
        loop {
            let stop = self.st().stop;
            if let Some(stop) = stop {
                if stop == Stop::Owner {
                    let _ = self.board.post("/v1/requests/stop", &json!({"id": id}));
                }
                break;
            }
            match self.board.get(&format!("/v1/requests/state?id={id}&steps=1"), 0) {
                Ok(state) => {
                    reached = Instant::now();
                    self.show(&state, &mut seen, &mut planned, &mut said);
                    if let Some((kind, text, reply)) = end_of(&state, said.as_deref()) {
                        let ended = if kind == "done" { "" } else { text.as_str() };
                        self.finish(kind, &text, reply, ended, true);
                        break;
                    }
                }
                Err(error) if reached.elapsed() > self.pace.lost => {
                    let text = format!("Lost touch with Hive's cloud agent; the request goes on there ({error})");
                    self.finish("failed", &text, None, &text, true);
                    break;
                }
                Err(_) => {}
            }
            self.rest(self.pace.follow);
        }
        self.peer.unlisten(id);
    }

    /// What's new in the request: its plan, the agent's replies (said), its steps (shown).
    fn show(&self, state: &Value, seen: &mut HashSet<(String, i64)>, planned: &mut bool, said: &mut Option<String>) {
        let empty = Vec::new();
        let tasks = state["tasks"].as_array().unwrap_or(&empty);
        if !*planned && tasks.len() > 1 {
            *planned = true;
            let plan: Vec<String> = tasks
                .iter()
                .enumerate()
                .map(|(i, t)| format!("{}. {}", i + 1, t["title"].as_str().unwrap_or("")))
                .collect();
            self.emit("plan", &plan.join("\n"));
        }
        for step in state["steps"].as_array().unwrap_or(&empty) {
            let key = (step["run"].as_str().unwrap_or("").to_owned(), step["n"].as_i64().unwrap_or(0));
            if !seen.insert(key) {
                continue;
            }
            let text = step["text"].as_str().unwrap_or("").trim();
            match step["kind"].as_str().unwrap_or("") {
                "say" => {
                    let words = text.trim_start_matches('💬').trim();
                    if !words.is_empty() {
                        *said = Some(words.to_owned());
                        self.emit("say", words);
                    }
                }
                "action" => self.emit("doing", text.trim_start_matches('→').trim()),
                "done" | "failed" => {} // the request's end says how it went
                _ if text.starts_with('⏳') || text.starts_with("Got ") => self.emit("doing", text),
                _ if !text.is_empty() => self.emit("data", text),
                _ => {}
            }
        }
    }
}

impl parts::Task for CloudJob {
    fn task(&self) -> String {
        self.text.clone()
    }
    fn device(&self) -> String {
        self.device.clone()
    }
    fn running(&self) -> bool {
        let (mode, over) = {
            let st = self.st();
            (st.mode, st.over)
        };
        match mode {
            Mode::Local => self.local.running(),
            Mode::Cloud => !over,
            Mode::NotStarted => false,
        }
    }
    fn start(&self, look: bool) {
        let local = {
            let mut st = self.st();
            if st.mode != Mode::NotStarted || st.over {
                return;
            }
            st.look = look;
            // A Mac task needs this Mac reachable by the cloud agent; the phone is the cloud's anyway.
            st.prompt || (self.device == "mac" && !self.peer.connected())
        };
        if local {
            return self.run_locally(None);
        }
        {
            let mut st = self.st();
            st.mode = Mode::Cloud;
            st.started_at = crate::util::now();
            st.began = crate::util::monotonic();
        }
        let me = self.me.upgrade();
        let _ = std::thread::Builder::new().name("cloud-task".into()).spawn(move || {
            if let Some(me) = me {
                me.follow();
            }
        });
    }
    fn stop(&self) {
        let mode = self.mode();
        match mode {
            Mode::Local => self.local.stop(),
            Mode::NotStarted => self.finish("failed", "stopped", None, "stopped", false),
            Mode::Cloud => {
                self.st().stop = Some(Stop::Owner);
                self.changed.notify_all();
                self.finish("failed", "stopped", None, "stopped", true);
            }
        }
    }
    fn stop_for_maintenance(&self) {
        match self.mode() {
            Mode::Local => self.local.stop_for_maintenance(),
            _ => {
                self.st().stop = Some(Stop::Maintenance);
                self.finish("failed", "stopped", None, "stopped", false);
            }
        }
    }
    fn started_at(&self) -> f64 {
        match self.mode() {
            Mode::Local => self.local.started_at(),
            _ => self.st().started_at,
        }
    }
    fn elapsed(&self) -> f64 {
        match self.mode() {
            Mode::Local => self.local.elapsed(),
            _ => {
                let st = self.st();
                st.finished_at.unwrap_or_else(crate::util::now) - st.started_at
            }
        }
    }
    fn began(&self) -> f64 {
        match self.mode() {
            Mode::Local => self.local.began(),
            _ => self.st().began,
        }
    }
    fn times(&self) -> Vec<(String, f64)> {
        match self.mode() {
            Mode::Local => self.local.times(),
            _ => Vec::new(),
        }
    }
    fn looked_ahead(&self) -> bool {
        self.mode() == Mode::Local && self.local.looked_ahead()
    }
    fn calls_to_words(&self) -> i64 {
        match self.mode() {
            Mode::Local => self.local.calls_to_words(),
            _ => 0,
        }
    }
    fn thread_id(&self) -> Option<String> {
        match self.mode() {
            Mode::Local => self.local.thread_id(),
            _ => None,
        }
    }
    fn on_thread(&self) -> bool {
        self.mode() == Mode::Local && self.local.on_thread()
    }
    fn recovery_id(&self) -> Option<String> {
        match self.mode() {
            Mode::Local => self.local.recovery_id(),
            _ => None,
        }
    }
    fn set_receipt_id(&self, receipt: Option<String>) {
        self.local.set_receipt_id(receipt);
    }
    fn set_on_event(&self, on_event: OnEvent) {
        self.st().on_event = Some(on_event.clone());
        self.local.set_on_event(on_event);
    }
    fn set_prompt(&self, prompt: String) {
        self.st().prompt = true;
        self.local.set_prompt(prompt);
    }
    fn set_durable_recovery(&self, durable: bool) {
        self.local.set_durable_recovery(durable);
    }
    fn handed_back(&self) {
        match self.mode() {
            Mode::Local => self.local.handed_back(),
            _ => self.peer.handed_back(),
        }
    }
    fn took_over(&self) {
        match self.mode() {
            Mode::Local => self.local.took_over(),
            _ => self.peer.took_over(),
        }
    }
    fn wait_done(&self, seconds: f64) -> bool {
        if self.mode() == Mode::Local {
            return self.local.wait_done(seconds);
        }
        let deadline = Instant::now() + Duration::from_secs_f64(seconds.max(0.0));
        let mut st = self.st();
        loop {
            if st.over || st.mode == Mode::NotStarted {
                return true;
            }
            if st.mode == Mode::Local {
                drop(st);
                let left = deadline.saturating_duration_since(Instant::now()).as_secs_f64();
                return self.local.wait_done(left);
            }
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return false;
            }
            st = self.changed.wait_timeout(st, left.min(Duration::from_millis(200))).unwrap_or_else(|e| e.into_inner()).0;
        }
    }
    fn final_text(&self) -> Option<String> {
        match self.mode() {
            Mode::Local => self.local.final_text(),
            _ => self.st().final_text.clone(),
        }
    }
    fn ended(&self) -> String {
        match self.mode() {
            Mode::Local => self.local.ended(),
            _ => self.st().ended.clone(),
        }
    }
}
