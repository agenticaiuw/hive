//! Fakes for hive-app's tests: the ears, the voice, the window, the helper, Codex and the rest of
//! the Mac, as Python's tests had with `mock`. Nothing here opens the microphone, plays audio,
//! touches the clipboard, the cursor, notifications or the screen, starts Codex, or talks to the
//! real agent-vhid-helper (which moves the real mouse and keyboard): [`FakeHelper`] is a helper of
//! its own on a temporary socket. Each test runs in a temporary AGENT_STATE_DIR (and CODEX_HOME),
//! one test at a time per file, since the environment and the session journal are the process's.
#![allow(dead_code)]

use hive_app::parts::{
    Backend, Captions, Closeable, Console, Ears, Host, Lips, LocalRequest, Look, Mac, Mic, OnEvent,
    Task, Voice,
};
use hive_app::{Parts, VoiceAgent};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::ffi::OsString;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, Weak};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

pub fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// What a fake was asked, in order.
pub struct Rec<T>(Mutex<Vec<T>>);

impl<T> Default for Rec<T> {
    fn default() -> Self {
        Rec(Mutex::new(Vec::new()))
    }
}

impl<T: Clone> Rec<T> {
    pub fn push(&self, value: T) {
        lock(&self.0).push(value)
    }
    pub fn all(&self) -> Vec<T> {
        lock(&self.0).clone()
    }
    pub fn len(&self) -> usize {
        lock(&self.0).len()
    }
    pub fn is_empty(&self) -> bool {
        lock(&self.0).is_empty()
    }
    pub fn last(&self) -> Option<T> {
        lock(&self.0).last().cloned()
    }
    pub fn clear(&self) {
        lock(&self.0).clear()
    }
}

pub fn wait_for(what: &str, timeout: f64, check: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs_f64(timeout);
    while Instant::now() < deadline {
        if check() {
            return;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    panic!("timed out waiting for {what}");
}

pub fn sleep(seconds: f64) {
    std::thread::sleep(Duration::from_secs_f64(seconds));
}

/// Something that blocks whoever passes until it's opened.
pub struct Gate {
    open: Mutex<bool>,
    changed: Condvar,
    pub waiting: AtomicUsize,
}

impl Gate {
    pub fn new(open: bool) -> Gate {
        Gate {
            open: Mutex::new(open),
            changed: Condvar::new(),
            waiting: AtomicUsize::new(0),
        }
    }
    pub fn close(&self) {
        *lock(&self.open) = false;
    }
    pub fn open(&self) {
        *lock(&self.open) = true;
        self.changed.notify_all();
    }
    pub fn pass(&self) {
        let mut open = lock(&self.open);
        if !*open {
            self.waiting.fetch_add(1, Ordering::SeqCst);
            while !*open {
                open = self.changed.wait(open).unwrap_or_else(|e| e.into_inner());
            }
            self.waiting.fetch_sub(1, Ordering::SeqCst);
        }
    }
}

// -- the environment --

static ENV: Mutex<()> = Mutex::new(());

/// A temporary AGENT_STATE_DIR and CODEX_HOME, and none of the workspace's variables, for one
/// test at a time; put back as they were afterwards.
pub struct Isolated {
    saved: Vec<(String, Option<OsString>)>,
    pub dir: tempfile::TempDir,
    _guard: MutexGuard<'static, ()>,
}

impl Isolated {
    pub fn new() -> Isolated {
        let guard = lock(&ENV);
        let dir = tempfile::Builder::new()
            .prefix("hive-app-")
            .tempdir()
            .expect("a temp dir");
        let mut isolated = Isolated {
            saved: Vec::new(),
            dir,
            _guard: guard,
        };
        let state = isolated.dir.path().to_path_buf();
        isolated.set("AGENT_STATE_DIR", &state);
        isolated.set("CODEX_HOME", &state);
        isolated.set("AGENT_ENV_FILE", "/dev/null");
        for name in [
            "AGENT_SPACEO_COMMAND",
            "AGENT_WORKSPACE_CONNECTION",
            "AGENT_JOURNAL_DICTATION",
            "AGENT_BACKEND",
            "HIVE_VIRTUAL_MONITOR",
            "HIVE_ASK_WORK_SCREEN",
            "PHONE_RELAY",
        ] {
            isolated.unset(name);
        }
        isolated
    }

    fn remember(&mut self, key: &str) {
        if !self.saved.iter().any(|(k, _)| k == key) {
            self.saved.push((key.to_owned(), std::env::var_os(key)));
        }
    }

    pub fn set(&mut self, key: &str, value: impl AsRef<std::ffi::OsStr>) {
        self.remember(key);
        std::env::set_var(key, value);
    }

    pub fn unset(&mut self, key: &str) {
        self.remember(key);
        std::env::remove_var(key);
    }

    pub fn path(&self) -> &Path {
        self.dir.path()
    }
}

impl Default for Isolated {
    fn default() -> Self {
        Isolated::new()
    }
}

impl Drop for Isolated {
    fn drop(&mut self) {
        for (key, value) in self.saved.drain(..).rev() {
            match value {
                Some(value) => std::env::set_var(&key, value),
                None => std::env::remove_var(&key),
            }
        }
    }
}

// -- the ears, the voice, the window --

/// listen.Ears: what it hears is given to the agent by the test (`agent.heard`, as on_text does,
/// and `agent.cut_in`, as on_speech does).
pub struct FakeEars {
    pub on: AtomicBool,
    pub calls: Rec<String>,
    /// cut's `then`s, when the test runs them itself.
    pub thens: Mutex<Vec<Box<dyn FnOnce() + Send>>>,
    pub hold_thens: AtomicBool,
    pub times: Mutex<BTreeMap<String, f64>>,
    pub model: AtomicBool,
    pub description: Mutex<String>,
    /// `describe` waits here (Parakeet loading).
    pub loading: Gate,
    pub described: AtomicUsize,
    pub level: Mutex<f64>,
    pub hears_mac: AtomicBool,
    pub mic: Mutex<Option<Mic>>,
    pub voiceprint: AtomicBool,
    pub machine: AtomicBool,
    pub learned: AtomicUsize,
}

impl Default for FakeEars {
    fn default() -> Self {
        FakeEars {
            on: AtomicBool::new(false),
            calls: Rec::default(),
            thens: Mutex::new(Vec::new()),
            hold_thens: AtomicBool::new(false),
            times: Mutex::new(BTreeMap::new()),
            model: AtomicBool::new(true),
            description: Mutex::new("Parakeet (fake)".into()),
            loading: Gate::new(true),
            described: AtomicUsize::new(0),
            level: Mutex::new(0.5),
            hears_mac: AtomicBool::new(true),
            mic: Mutex::new(None),
            voiceprint: AtomicBool::new(false),
            machine: AtomicBool::new(false),
            learned: AtomicUsize::new(0),
        }
    }
}

impl FakeEars {
    pub fn listening_now(&self) -> bool {
        self.on.load(Ordering::SeqCst)
    }
    /// Runs the `then`s held back so far.
    pub fn run_thens(&self) {
        let thens: Vec<_> = lock(&self.thens).drain(..).collect();
        for then in thens {
            then();
        }
    }
    /// When you stopped talking, it decided you'd finished and wrote it down: `ago` seconds ago.
    pub fn heard_at(&self, stopped: f64, decided: f64, written: f64) {
        let now = hive_app::util::monotonic();
        let mut times = lock(&self.times);
        times.insert("stopped".into(), now - stopped);
        times.insert("decided".into(), now - decided);
        times.insert("written".into(), now - written);
    }
}

impl Ears for FakeEars {
    fn listen(&self, on: bool) {
        self.calls.push(format!("listen {on}"));
        self.on.store(on, Ordering::SeqCst);
    }
    fn listening(&self) -> bool {
        self.listening_now()
    }
    fn cut(&self, then: Option<Box<dyn FnOnce() + Send>>) {
        self.calls.push(format!("cut {}", then.is_some()));
        if let Some(then) = then {
            if self.hold_thens.load(Ordering::SeqCst) {
                lock(&self.thens).push(then);
            } else {
                then();
            }
        }
    }
    fn mic_level(&self) -> f64 {
        *lock(&self.level)
    }
    fn hears_the_mac(&self) -> bool {
        self.hears_mac.load(Ordering::SeqCst)
    }
    fn microphone(&self) -> Option<Mic> {
        lock(&self.mic).clone()
    }
    fn heard_times(&self) -> BTreeMap<String, f64> {
        lock(&self.times).clone()
    }
    fn describe(&self) -> String {
        self.described.fetch_add(1, Ordering::SeqCst);
        self.loading.pass();
        lock(&self.description).clone()
    }
    fn has_model(&self) -> bool {
        self.model.load(Ordering::SeqCst)
    }
    fn has_voiceprint(&self) -> bool {
        self.voiceprint.load(Ordering::SeqCst)
    }
    fn describe_voiceprint(&self) -> String {
        if self.has_voiceprint() {
            "on (your voice, VOICE_MATCH 0.4)".into()
        } else {
            "None".into()
        }
    }
    fn heard_machine(&self) -> bool {
        self.machine.load(Ordering::SeqCst)
    }
    fn learn_its_voice(&self) -> Result<bool, String> {
        self.learned.fetch_add(1, Ordering::SeqCst);
        Ok(true)
    }
}

/// speech.Voice as test_voice.py's `Voice`: writes down what it was asked to say and "plays" it
/// straight away (on_play). `playing`: audible right now.
#[derive(Default)]
pub struct FakeVoice {
    pub said: Rec<String>,
    pub calls: Rec<String>,
    pub playing: AtomicBool,
    pub agent: Mutex<Option<Weak<VoiceAgent>>>,
    /// Called on stop (e.g. to see when it went quiet).
    pub on_stop: Mutex<Option<Box<dyn Fn() + Send>>>,
}

impl Voice for FakeVoice {
    fn say(&self, text: &str) {
        self.said.push(text.to_owned());
        let agent = lock(&self.agent).as_ref().and_then(Weak::upgrade);
        if let Some(agent) = agent {
            agent.on_play(text);
        }
    }
    fn stop(&self) {
        if let Some(f) = lock(&self.on_stop).as_ref() {
            f();
        }
        self.calls.push("stop".into());
        self.playing.store(false, Ordering::SeqCst);
    }
    fn audible(&self) -> bool {
        self.playing.load(Ordering::SeqCst)
    }
    fn quiet_for(&self) -> f64 {
        if self.audible() {
            0.0
        } else {
            1e9
        }
    }
    fn name(&self) -> String {
        "fake".into()
    }
}

/// The floating window: writes down what it'd show, as (sender, what).
#[derive(Default)]
pub struct FakeCaptions {
    pub calls: Rec<(String, String)>,
}

impl FakeCaptions {
    pub fn of(&self, sender: &str) -> Vec<String> {
        self.calls
            .all()
            .into_iter()
            .filter(|(s, _)| s == sender)
            .map(|(_, v)| v)
            .collect()
    }
    pub fn count(&self, sender: &str) -> usize {
        self.of(sender).len()
    }
    fn put(&self, sender: &str, value: impl ToString) {
        self.calls.push((sender.to_owned(), value.to_string()));
    }
}

impl Captions for FakeCaptions {
    fn say(&self, words: &str) {
        self.put("say", words)
    }
    fn listening(&self, on: bool) {
        self.put("listening", on)
    }
    fn focus(&self, on: bool) {
        self.put("focus", on)
    }
    fn dictating(&self, on: bool) {
        self.put("dictating", on)
    }
    fn hands_free(&self, on: bool) {
        self.put("hands_free", on)
    }
    fn camera(&self, state: &str) {
        self.put("camera", state)
    }
    fn dismiss(&self) {
        self.put("dismiss", "")
    }
    fn framing(&self, text: &str) {
        self.put("framing", text)
    }
    fn preview(&self, jpeg: &str) {
        self.put("preview", jpeg)
    }
    fn hearing(&self, words: &str) {
        self.put("hearing", words)
    }
    fn doing(&self, text: &str) {
        self.put("doing", text)
    }
    fn thinking(&self, text: &str) {
        self.put("thinking", text)
    }
    fn agent_request(&self, text: &str) {
        self.put("agent_request", text)
    }
    fn paused(&self, text: &str) {
        self.put("paused", text)
    }
    fn muted(&self, on: bool) {
        self.put("muted", on)
    }
    fn activity(&self, text: &str) {
        self.put("activity", text)
    }
    fn active(&self, on: bool) {
        self.put("active", on)
    }
    fn hidden(&self, on: bool) {
        self.put("hidden", on)
    }
    fn close(&self) {
        self.put("close", "")
    }
}

// -- the helper --

/// agent-vhid-helper, as a mock: who has control is what the test says.
pub struct FakeMac {
    pub engaged: AtomicBool,
    pub calls: Rec<String>,
    pub socket: PathBuf,
}

impl FakeMac {
    /// `socket`: where the watch connects (nothing listens there).
    pub fn new(socket: PathBuf) -> FakeMac {
        FakeMac {
            engaged: AtomicBool::new(false),
            calls: Rec::default(),
            socket,
        }
    }
    pub fn count(&self, call: &str) -> usize {
        self.calls.all().iter().filter(|c| *c == call).count()
    }
}

impl Mac for FakeMac {
    fn is_engaged(&self) -> Result<bool, String> {
        Ok(self.engaged.load(Ordering::SeqCst))
    }
    fn engage(&self) -> Result<(), String> {
        self.calls.push("engage".into());
        Ok(())
    }
    fn disengage(&self) -> Result<(), String> {
        self.calls.push("disengage".into());
        Ok(())
    }
    fn release_all(&self) -> Result<(), String> {
        self.calls.push("release_all".into());
        Ok(())
    }
    fn socket(&self) -> PathBuf {
        self.socket.clone()
    }
}

struct HelperGate {
    state: &'static str,
    reason: String,
    arming_since: Option<Instant>,
    watchers: Vec<UnixStream>,
}

impl HelperGate {
    fn describe(&self) -> String {
        format!("state={} reason={}", self.state, self.reason)
    }
    fn notify(&mut self, line: &str) {
        self.watchers
            .retain_mut(|w| w.write_all(format!("{line}\n").as_bytes()).is_ok());
    }
    fn transition(&mut self, next: &'static str, reason: &str) {
        self.state = next;
        self.reason = reason.to_owned();
        let line = format!("event {}", self.describe());
        self.notify(&line);
    }
}

struct HelperShared {
    gate: Mutex<HelperGate>,
    stop: AtomicBool,
    released: AtomicUsize,
}

/// A fake agent-vhid-helper on a temporary socket, with the real one's hand-over gate (dry run:
/// it moves nothing): engage arms it and it's engaged once 100 ms pass with your hands off;
/// "human SOURCE" takes control back; "fn WHAT" is what watchers hear when fn is used.
pub struct FakeHelper {
    _dir: tempfile::TempDir,
    pub socket: PathBuf,
    shared: Arc<HelperShared>,
    threads: Vec<JoinHandle<()>>,
}

impl FakeHelper {
    pub fn start() -> FakeHelper {
        let dir = tempfile::Builder::new()
            .prefix("avh-")
            .tempdir()
            .expect("a temp dir");
        let socket = dir.path().join("s.sock");
        let listener = UnixListener::bind(&socket).expect("bind the fake helper");
        let shared = Arc::new(HelperShared {
            gate: Mutex::new(HelperGate {
                state: "disengaged",
                reason: "startup".into(),
                arming_since: None,
                watchers: Vec::new(),
            }),
            stop: AtomicBool::new(false),
            released: AtomicUsize::new(0),
        });
        let accepting = {
            let shared = shared.clone();
            std::thread::spawn(move || {
                for stream in listener.incoming() {
                    if shared.stop.load(Ordering::SeqCst) {
                        break;
                    }
                    if let Ok(stream) = stream {
                        let shared = shared.clone();
                        std::thread::spawn(move || serve(&shared, stream));
                    }
                }
            })
        };
        let ticking = {
            let shared = shared.clone();
            std::thread::spawn(move || {
                while !shared.stop.load(Ordering::SeqCst) {
                    {
                        let mut gate = lock(&shared.gate);
                        if gate.state == "arming"
                            && gate
                                .arming_since
                                .is_some_and(|t| t.elapsed() >= Duration::from_millis(100))
                        {
                            gate.transition("engaged", "engaged");
                        }
                    }
                    std::thread::sleep(Duration::from_millis(5));
                }
            })
        };
        FakeHelper {
            _dir: dir,
            socket,
            shared,
            threads: vec![accepting, ticking],
        }
    }

    /// One request on its own connection (test_dry_run.py's `raw`).
    pub fn raw(&self, line: &str) -> String {
        let mut s = UnixStream::connect(&self.socket).expect("connect to the fake helper");
        s.write_all(format!("{line}\n").as_bytes()).unwrap();
        let mut reply = String::new();
        BufReader::new(s).read_line(&mut reply).unwrap();
        reply.trim().to_owned()
    }

    pub fn state(&self) -> String {
        lock(&self.shared.gate).state.to_owned()
    }

    pub fn watchers(&self) -> usize {
        lock(&self.shared.gate).watchers.len()
    }

    /// A client of this helper (never the real one).
    pub fn client(&self) -> hive_mac::AgentVHID {
        hive_mac::AgentVHID::new(&self.socket, 1.0, false)
    }
}

fn serve(shared: &Arc<HelperShared>, stream: UnixStream) {
    let Ok(reader) = stream.try_clone() else {
        return;
    };
    let mut reader = BufReader::new(reader);
    let mut writer = stream;
    loop {
        let mut line = String::new();
        match reader.read_line(&mut line) {
            Ok(0) | Err(_) => return,
            Ok(_) => {}
        }
        let line = line.trim_end_matches(['\n', '\r']);
        let mut words = line.split_whitespace();
        let command = words.next().unwrap_or("");
        let arg = words.next();
        let mut gate = lock(&shared.gate);
        let reply = match command {
            "watch" => {
                let hello = format!("ok watching\nevent {}\n", gate.describe());
                if writer.write_all(hello.as_bytes()).is_ok() {
                    if let Ok(w) = writer.try_clone() {
                        gate.watchers.push(w);
                    }
                }
                drop(gate);
                let mut sink = String::new();
                while matches!(reader.read_line(&mut sink), Ok(n) if n > 0) {
                    sink.clear();
                }
                return;
            }
            "ping" => "ok pong".to_owned(),
            "status" => format!(
                "ok {} vhid=dry_run watch=ok dry_run=1 fn=1",
                gate.describe()
            ),
            "release" => {
                shared.released.fetch_add(1, Ordering::SeqCst);
                "ok".into()
            }
            "disengage" => {
                if gate.state != "disengaged" {
                    gate.transition("disengaged", "released_by_agent");
                }
                "ok".into()
            }
            "engage" => {
                if gate.state == "disengaged" {
                    gate.arming_since = Some(Instant::now());
                    gate.transition("arming", "engage_requested");
                }
                "ok".into()
            }
            "human" => {
                let source = arg.unwrap_or("simulated");
                match gate.state {
                    "engaged" => gate.transition("disengaged", source),
                    "arming" => {
                        gate.transition("disengaged", &format!("engage_cancelled_by_{source}"))
                    }
                    _ => {}
                }
                "ok".into()
            }
            "fn" => {
                gate.notify(&format!("event fn={}", arg.unwrap_or("tap")));
                "ok".into()
            }
            _ => format!("err bad_request unknown command: {command}"),
        };
        drop(gate);
        if writer.write_all(format!("{reply}\n").as_bytes()).is_err() {
            return;
        }
    }
}

impl Drop for FakeHelper {
    fn drop(&mut self) {
        self.shared.stop.store(true, Ordering::SeqCst);
        let _ = UnixStream::connect(&self.socket); // wakes the accept loop
        for w in lock(&self.shared.gate).watchers.drain(..) {
            let _ = w.shutdown(std::net::Shutdown::Both);
        }
        for t in self.threads.drain(..) {
            let _ = t.join();
        }
    }
}

// -- Codex --

/// One request (agent.CodexTask, as `mock.Mock(running=True)` or a scripted run).
pub struct FakeTask {
    me: Weak<FakeTask>,
    pub text: String,
    pub device: String,
    pub previous: Option<String>,
    pub ahead: bool,
    pub running: AtomicBool,
    pub stops: AtomicUsize,
    pub maintenance_stops: AtomicUsize,
    pub starts: Rec<bool>,
    pub receipt: Mutex<Option<String>>,
    pub on_event: Mutex<Option<OnEvent>>,
    pub prompt: Mutex<Option<String>>,
    pub durable: Mutex<Option<bool>>,
    pub recovery: Mutex<Option<String>>,
    pub thread: Mutex<Option<String>>,
    pub started_at: f64,
    pub began: f64,
    pub times: Mutex<Vec<(String, f64)>>,
    pub looked_ahead: AtomicBool,
    pub final_text: Mutex<Option<String>>,
    pub ended: Mutex<String>,
    pub handed_back: AtomicUsize,
    /// What a started task does (Some: say this, then done).
    pub reply: Mutex<Option<String>>,
    pub trace: Option<Arc<Rec<String>>>,
}

impl FakeTask {
    pub fn new(text: &str, device: &str) -> Arc<FakeTask> {
        FakeTask::build(text, device, None, false, None, None)
    }

    /// A task that's already running (Python's `mock.Mock(running=True)`).
    pub fn running(text: &str, device: &str) -> Arc<FakeTask> {
        let task = FakeTask::new(text, device);
        task.running.store(true, Ordering::SeqCst);
        task
    }

    fn build(
        text: &str,
        device: &str,
        previous: Option<&str>,
        ahead: bool,
        reply: Option<String>,
        trace: Option<Arc<Rec<String>>>,
    ) -> Arc<FakeTask> {
        let now = hive_app::util::now();
        Arc::new_cyclic(|me| FakeTask {
            me: me.clone(),
            text: text.to_owned(),
            device: device.to_owned(),
            previous: previous.map(str::to_owned),
            ahead,
            running: AtomicBool::new(false),
            stops: AtomicUsize::new(0),
            maintenance_stops: AtomicUsize::new(0),
            starts: Rec::default(),
            receipt: Mutex::new(None),
            on_event: Mutex::new(None),
            prompt: Mutex::new(None),
            durable: Mutex::new(None),
            recovery: Mutex::new(None),
            thread: Mutex::new(Some("thread-1".into())),
            started_at: now,
            began: hive_app::util::monotonic(),
            times: Mutex::new(Vec::new()),
            looked_ahead: AtomicBool::new(ahead),
            final_text: Mutex::new(None),
            ended: Mutex::new(String::new()),
            handed_back: AtomicUsize::new(0),
            reply: Mutex::new(reply),
            trace,
        })
    }

    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }

    pub fn stop_count(&self) -> usize {
        self.stops.load(Ordering::SeqCst)
    }

    /// Codex says something (its on_event).
    pub fn emit(&self, kind: &str, text: &str) {
        let on_event = lock(&self.on_event).clone();
        if let Some(on_event) = on_event {
            on_event(kind, text);
        }
    }

    /// It finished with this reply.
    pub fn finish(&self, reply: &str) {
        *lock(&self.final_text) = Some(reply.to_owned());
        self.running.store(false, Ordering::SeqCst);
        self.emit("done", reply);
    }

    pub fn as_task(self: &Arc<Self>) -> Arc<dyn Task> {
        self.clone()
    }
}

impl Task for FakeTask {
    fn task(&self) -> String {
        self.text.clone()
    }
    fn device(&self) -> String {
        self.device.clone()
    }
    fn running(&self) -> bool {
        self.is_running()
    }
    fn start(&self, look: bool) {
        if let Some(trace) = &self.trace {
            trace.push("start".into());
        }
        self.starts.push(look);
        self.running.store(true, Ordering::SeqCst);
        let reply = lock(&self.reply).clone();
        if let (Some(reply), Some(me)) = (reply, self.me.upgrade()) {
            // as tests/fake_codex.py: it looks at the screen, then answers
            std::thread::spawn(move || {
                sleep(0.05);
                me.emit("doing", "Looking at the screen");
                *lock(&me.times) = vec![
                    ("look".into(), 0.05),
                    ("codex".into(), 0.1),
                    ("words".into(), 0.3),
                ];
                sleep(0.05);
                if !me.is_running() {
                    return;
                }
                me.emit("say", &reply);
                me.finish(&reply);
            });
        }
    }
    fn stop(&self) {
        self.stops.fetch_add(1, Ordering::SeqCst);
        let was = self.running.swap(false, Ordering::SeqCst);
        *lock(&self.ended) = "stopped".into();
        if was {
            self.emit("failed", "stopped");
        }
    }
    fn stop_for_maintenance(&self) {
        self.maintenance_stops.fetch_add(1, Ordering::SeqCst);
        self.running.store(false, Ordering::SeqCst);
    }
    fn started_at(&self) -> f64 {
        self.started_at
    }
    fn elapsed(&self) -> f64 {
        hive_app::util::now() - self.started_at
    }
    fn began(&self) -> f64 {
        self.began
    }
    fn times(&self) -> Vec<(String, f64)> {
        lock(&self.times).clone()
    }
    fn looked_ahead(&self) -> bool {
        self.looked_ahead.load(Ordering::SeqCst)
    }
    fn calls_to_words(&self) -> i64 {
        1
    }
    fn thread_id(&self) -> Option<String> {
        lock(&self.thread).clone()
    }
    fn on_thread(&self) -> bool {
        true
    }
    fn recovery_id(&self) -> Option<String> {
        lock(&self.recovery).clone()
    }
    fn set_receipt_id(&self, receipt: Option<String>) {
        *lock(&self.receipt) = receipt;
    }
    fn set_on_event(&self, on_event: OnEvent) {
        *lock(&self.on_event) = Some(on_event);
    }
    fn set_prompt(&self, prompt: String) {
        *lock(&self.prompt) = Some(prompt);
    }
    fn set_durable_recovery(&self, durable: bool) {
        *lock(&self.durable) = Some(durable);
    }
    fn handed_back(&self) {
        self.handed_back.fetch_add(1, Ordering::SeqCst);
    }
    fn wait_done(&self, seconds: f64) -> bool {
        let deadline = Instant::now() + Duration::from_secs_f64(seconds);
        while self.is_running() {
            if Instant::now() >= deadline {
                return false;
            }
            sleep(0.01);
        }
        true
    }
    fn final_text(&self) -> Option<String> {
        lock(&self.final_text).clone()
    }
    fn ended(&self) -> String {
        lock(&self.ended).clone()
    }
}

/// Codex: the tasks it was asked for, and the saved request's files as the test sets them.
pub struct FakeBackend {
    pub tasks: Rec<Arc<FakeTask>>,
    pub sessions: AtomicUsize,
    pub looks: AtomicUsize,
    /// What each new task says before it's done (None: it runs until stopped).
    pub reply: Mutex<Option<String>>,
    pub server: AtomicBool,
    pub requests: Rec<(String, Value, f64)>,
    pub response: Mutex<Value>,
    pub recovery: Mutex<Option<Value>>,
    pub finished: Rec<(String, String)>,
    pub provider: Mutex<Option<String>>,
    pub restored: Mutex<Option<Arc<FakeTask>>>,
    pub trace: Arc<Rec<String>>,
}

impl FakeBackend {
    pub fn new(trace: Arc<Rec<String>>) -> FakeBackend {
        FakeBackend {
            tasks: Rec::default(),
            sessions: AtomicUsize::new(0),
            looks: AtomicUsize::new(0),
            reply: Mutex::new(None),
            server: AtomicBool::new(true),
            requests: Rec::default(),
            response: Mutex::new(json!({"goal": {"status": "active"}})),
            recovery: Mutex::new(None),
            finished: Rec::default(),
            provider: Mutex::new(None),
            restored: Mutex::new(None),
            trace,
        }
    }
    pub fn texts(&self) -> Vec<String> {
        self.tasks.all().iter().map(|t| t.text.clone()).collect()
    }
    pub fn last(&self) -> Arc<FakeTask> {
        self.tasks.last().expect("a task")
    }
}

impl Backend for FakeBackend {
    fn task(
        &self,
        text: &str,
        previous: Option<&str>,
        device: &str,
        ahead: Option<Look>,
    ) -> Arc<dyn Task> {
        let reply = lock(&self.reply).clone();
        let task = FakeTask::build(
            text,
            device,
            previous,
            ahead.is_some(),
            reply,
            Some(self.trace.clone()),
        );
        self.tasks.push(task.clone());
        task
    }
    fn focus(&self, words: &str) -> String {
        hive_codex::focus(words).to_owned()
    }
    fn new_session(&self) {
        self.sessions.fetch_add(1, Ordering::SeqCst);
    }
    fn look_ahead(&self) -> Option<Look> {
        self.looks.fetch_add(1, Ordering::SeqCst);
        Some(Arc::new(()) as Look)
    }
    fn describe_model(&self) -> String {
        "fake-model, low effort".into()
    }
    fn server_running(&self) -> bool {
        self.server.load(Ordering::SeqCst)
    }
    fn request(&self, method: &str, params: Value, timeout: f64) -> Option<Result<Value, String>> {
        if !self.server_running() {
            return None;
        }
        self.requests.push((method.to_owned(), params, timeout));
        Some(Ok(lock(&self.response).clone()))
    }
    fn restore(&self) -> Result<Option<Arc<dyn Task>>, String> {
        Ok(lock(&self.restored).take().map(|t| t as Arc<dyn Task>))
    }
    fn recovery_current(&self) -> Result<Option<Value>, String> {
        Ok(lock(&self.recovery).clone())
    }
    fn recovery_finish(&self, id: &str, status: &str) -> Result<(), String> {
        self.finished.push((id.to_owned(), status.to_owned()));
        let mut recovery = lock(&self.recovery);
        if let Some(saved) = recovery
            .as_mut()
            .filter(|s| s.get("id") == Some(&json!(id)))
        {
            saved["status"] = json!(status);
        }
        Ok(())
    }
    fn provider_status(&self, _id: &str) -> Result<Option<String>, String> {
        Ok(lock(&self.provider).clone())
    }
}

// -- the rest of the Mac --

/// What the lip reading worker says.
pub type OnValue = Arc<dyn Fn(Value) + Send + Sync>;
/// The request socket's requests.
pub type OnRequest = Arc<dyn Fn(LocalRequest) + Send + Sync>;

/// lipread.LipReader.
#[derive(Default)]
pub struct FakeLips {
    pub opened: AtomicUsize,
    pub starts: AtomicUsize,
    pub stopped: AtomicBool,
    pub closed: AtomicUsize,
    /// What the worker says once the camera is asked for (the Python tests' Reader.start).
    pub on_start: Mutex<Vec<Value>>,
    pub start_error: Mutex<Option<String>>,
    pub text: Mutex<String>,
    pub events: Mutex<Option<OnValue>>,
}

impl Lips for FakeLips {
    fn open(&self) -> Result<(), String> {
        self.opened.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
    fn start(&self) -> Result<(), String> {
        self.starts.fetch_add(1, Ordering::SeqCst);
        if let Some(error) = lock(&self.start_error).clone() {
            return Err(error);
        }
        let events = lock(&self.events).clone();
        if let Some(events) = events {
            for event in lock(&self.on_start).clone() {
                events(event);
            }
        }
        Ok(())
    }
    fn stop(&self) -> Result<String, String> {
        self.stopped.store(true, Ordering::SeqCst);
        Ok(lock(&self.text).clone())
    }
    fn close(&self) {
        self.closed.fetch_add(1, Ordering::SeqCst);
    }
}

/// Something running that's closed at shutdown.
#[derive(Default)]
pub struct FakeClosable {
    pub closed: AtomicUsize,
}

impl Closeable for FakeClosable {
    fn close(&self) {
        self.closed.fetch_add(1, Ordering::SeqCst);
    }
}

/// Notifications, typing, the virtual monitor, the workspace, lip reading's settings, the
/// request ledger and the update, all pretend.
pub struct FakeHost {
    pub notes: Rec<(String, String)>,
    pub pasted: Rec<String>,
    pub paste_error: Mutex<Option<String>>,
    /// A shift key is down.
    pub shift: AtomicBool,
    pub asked_screen: AtomicUsize,
    pub vm_enabled: AtomicBool,
    pub vm_ensured: AtomicUsize,
    pub vm_off: AtomicUsize,
    pub vm_on: AtomicBool,
    pub cursor: Mutex<(f64, f64)>,
    pub on_vm: AtomicBool,
    pub warps: Rec<(f64, f64)>,
    pub paused: Rec<String>,
    pub pause_ok: AtomicBool,
    pub latch: Mutex<Result<(String, String), String>>,
    pub workspace: Arc<FakeClosable>,
    pub workspace_error: Mutex<Option<String>>,
    pub workspace_started: AtomicUsize,
    pub activity: Mutex<Option<OnEvent>>,
    pub workspace_errors: Rec<String>,
    pub request_socket: Arc<FakeClosable>,
    pub requests: Mutex<Option<OnRequest>>,
    pub lips_ok: Mutex<(bool, String)>,
    pub lips_mode: Mutex<String>,
    pub lips: Arc<FakeLips>,
    pub admits: Rec<(String, String)>,
    pub admit_error: Mutex<Option<String>>,
    /// `admit` waits here (a busy main loop).
    pub admitting: Gate,
    pub finishes: Rec<(String, String)>,
    pub finish_error: Mutex<Option<String>>,
    pub updates: Rec<PathBuf>,
    pub update_error: Mutex<Option<String>>,
    pub trace: Arc<Rec<String>>,
}

impl FakeHost {
    pub fn new(trace: Arc<Rec<String>>) -> FakeHost {
        FakeHost {
            notes: Rec::default(),
            pasted: Rec::default(),
            paste_error: Mutex::new(None),
            shift: AtomicBool::new(false),
            asked_screen: AtomicUsize::new(0),
            vm_enabled: AtomicBool::new(false),
            vm_ensured: AtomicUsize::new(0),
            vm_off: AtomicUsize::new(0),
            vm_on: AtomicBool::new(false),
            cursor: Mutex::new((100.0, 100.0)),
            on_vm: AtomicBool::new(false),
            warps: Rec::default(),
            paused: Rec::default(),
            pause_ok: AtomicBool::new(true),
            latch: Mutex::new(Ok(("not-latched".into(), String::new()))),
            workspace: Arc::new(FakeClosable::default()),
            workspace_error: Mutex::new(None),
            workspace_started: AtomicUsize::new(0),
            activity: Mutex::new(None),
            workspace_errors: Rec::default(),
            request_socket: Arc::new(FakeClosable::default()),
            requests: Mutex::new(None),
            lips_ok: Mutex::new((true, "fake".into())),
            lips_mode: Mutex::new("voice".into()),
            lips: Arc::new(FakeLips::default()),
            admits: Rec::default(),
            admit_error: Mutex::new(None),
            admitting: Gate::new(true),
            finishes: Rec::default(),
            finish_error: Mutex::new(None),
            updates: Rec::default(),
            update_error: Mutex::new(None),
            trace,
        }
    }
}

impl Host for FakeHost {
    fn notify(&self, message: &str, title: &str) {
        self.notes.push((message.to_owned(), title.to_owned()));
    }
    fn paste(&self, text: &str) -> Option<String> {
        self.pasted.push(text.to_owned());
        lock(&self.paste_error).clone()
    }
    fn shift_held(&self) -> bool {
        self.shift.load(Ordering::SeqCst)
    }
    fn ask_work_screen(&self) {
        self.asked_screen.fetch_add(1, Ordering::SeqCst);
    }
    fn virtual_monitor_enabled(&self) -> bool {
        self.vm_enabled.load(Ordering::SeqCst)
    }
    fn ensure_virtual_monitor(&self) -> bool {
        self.vm_ensured.fetch_add(1, Ordering::SeqCst);
        true
    }
    fn virtual_monitor_off(&self) {
        self.vm_off.fetch_add(1, Ordering::SeqCst);
    }
    fn virtual_monitor_on(&self) -> bool {
        self.vm_on.load(Ordering::SeqCst)
    }
    fn on_virtual_monitor(&self, _x: f64, _y: f64) -> bool {
        self.on_vm.load(Ordering::SeqCst)
    }
    fn cursor(&self) -> (f64, f64) {
        *lock(&self.cursor)
    }
    fn warp(&self, x: f64, y: f64) {
        self.warps.push((x, y));
    }
    fn pause_workspace(&self, engine: &str) -> bool {
        self.paused.push(engine.to_owned());
        self.pause_ok.load(Ordering::SeqCst)
    }
    fn recover_workspace(&self, _spaceo: &str) -> Result<(String, String), String> {
        lock(&self.latch).clone()
    }
    fn start_workspace(
        &self,
        _spaceo: &str,
        on_activity: OnEvent,
    ) -> Result<Arc<dyn Closeable>, String> {
        self.workspace_started.fetch_add(1, Ordering::SeqCst);
        *lock(&self.activity) = Some(on_activity);
        match lock(&self.workspace_error).clone() {
            Some(error) => Err(error),
            None => Ok(self.workspace.clone()),
        }
    }
    fn workspace_error(&self, message: &str) {
        self.workspace_errors.push(message.to_owned());
    }
    fn local_requests(
        &self,
        _dir: &Path,
        on_request: Arc<dyn Fn(LocalRequest) + Send + Sync>,
    ) -> Result<Arc<dyn Closeable>, String> {
        *lock(&self.requests) = Some(on_request);
        Ok(self.request_socket.clone())
    }
    fn lips_available(&self) -> (bool, String) {
        lock(&self.lips_ok).clone()
    }
    fn lips_mode(&self) -> String {
        lock(&self.lips_mode).clone()
    }
    fn set_lips_mode(&self, mode: &str) -> std::io::Result<String> {
        *lock(&self.lips_mode) = mode.to_owned();
        Ok(mode.to_owned())
    }
    fn new_lips(&self, on_event: Arc<dyn Fn(Value) + Send + Sync>) -> Arc<dyn Lips> {
        *lock(&self.lips.events) = Some(on_event);
        self.lips.clone()
    }
    fn admit(&self, text: &str, channel: &str) -> Result<String, String> {
        self.admitting.pass();
        self.trace.push("admit".into());
        self.admits.push((text.to_owned(), channel.to_owned()));
        match lock(&self.admit_error).clone() {
            Some(error) => Err(error),
            None => Ok(format!("receipt-{}", self.admits.len())),
        }
    }
    fn finish(&self, receipt: &str, status: &str) -> Result<(), String> {
        self.trace.push("finish".into());
        self.finishes.push((receipt.to_owned(), status.to_owned()));
        match lock(&self.finish_error).clone() {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }
    fn rollout_for(&self, _thread: &str) -> Option<PathBuf> {
        None
    }
    fn start_update(&self, log: &Path) -> std::io::Result<()> {
        self.updates.push(log.to_path_buf());
        match lock(&self.update_error).clone() {
            Some(error) => Err(std::io::Error::other(error)),
            None => Ok(()),
        }
    }
}

/// stdout: what was printed.
#[derive(Default)]
pub struct FakeConsole {
    pub lines: Rec<String>,
    pub raws: Rec<String>,
}

impl Console for FakeConsole {
    fn line(&self, text: &str) {
        self.lines.push(text.to_owned());
    }
    fn raw(&self, text: &str) {
        self.raws.push(text.to_owned());
    }
    fn tty(&self) -> bool {
        false
    }
    fn columns(&self) -> usize {
        80
    }
}

// -- the agent with all of them --

pub struct Setup {
    /// Run by Agent.app ("@@" lines).
    pub app: bool,
    /// With a voice (else --no-speak).
    pub voice: bool,
    /// The helper to use instead of [`FakeMac`].
    pub mac: Option<Arc<dyn Mac>>,
    /// Codex to use instead of [`FakeBackend`].
    pub backend: Option<Arc<dyn Backend>>,
    pub ears: FakeEars,
}

impl Default for Setup {
    fn default() -> Self {
        Setup {
            app: false,
            voice: true,
            mac: None,
            backend: None,
            ears: FakeEars::default(),
        }
    }
}

pub struct Harness {
    pub agent: Arc<VoiceAgent>,
    pub ears: Arc<FakeEars>,
    pub voice: Arc<FakeVoice>,
    pub captions: Arc<FakeCaptions>,
    pub mac: Arc<FakeMac>,
    pub backend: Arc<FakeBackend>,
    pub host: Arc<FakeHost>,
    pub console: Arc<FakeConsole>,
    /// admit, start and finish, in the order they happened.
    pub trace: Arc<Rec<String>>,
    thread: Mutex<Option<JoinHandle<()>>>,
    pub env: Isolated,
}

impl Harness {
    pub fn new() -> Harness {
        Harness::with(Setup::default())
    }

    pub fn app() -> Harness {
        Harness::with(Setup {
            app: true,
            ..Setup::default()
        })
    }

    pub fn with(setup: Setup) -> Harness {
        Harness::isolated(Isolated::new(), setup)
    }

    pub fn isolated(env: Isolated, setup: Setup) -> Harness {
        let trace: Arc<Rec<String>> = Arc::default();
        let ears = Arc::new(setup.ears);
        let voice = Arc::new(FakeVoice::default());
        let captions = Arc::new(FakeCaptions::default());
        let mac = Arc::new(FakeMac::new(env.path().join("no-helper.sock")));
        let backend = Arc::new(FakeBackend::new(trace.clone()));
        let host = Arc::new(FakeHost::new(trace.clone()));
        let console = Arc::new(FakeConsole::default());
        let agent = VoiceAgent::new(Parts {
            ears: ears.clone(),
            voice: setup.voice.then(|| voice.clone() as Arc<dyn Voice>),
            captions: captions.clone(),
            mac: setup.mac.unwrap_or_else(|| mac.clone()),
            backend: setup.backend.unwrap_or_else(|| backend.clone()),
            host: host.clone(),
            console: console.clone(),
            app: setup.app,
        });
        *lock(&voice.agent) = Some(Arc::downgrade(&agent));
        Harness {
            agent,
            ears,
            voice,
            captions,
            mac,
            backend,
            host,
            console,
            trace,
            thread: Mutex::new(None),
            env,
        }
    }

    /// Handles what's on the queue now (when the loop isn't running).
    pub fn drain(&self) {
        while let Some(event) = self.agent.next_event() {
            self.agent.dispatch(event);
        }
    }

    /// The main loop, on a thread of its own.
    pub fn start(&self) {
        let agent = self.agent.clone();
        let thread = std::thread::Builder::new()
            .name("voice-agent".into())
            .spawn(move || agent.run())
            .unwrap();
        *lock(&self.thread) = Some(thread);
    }

    /// Ends the loop (as quitting does) and shuts the agent down.
    pub fn stop(&self) {
        self.agent.stopped.set(true);
        if let Some(thread) = lock(&self.thread).take() {
            let _ = thread.join();
        }
        self.agent.shutdown();
    }

    pub fn printed(&self) -> Vec<String> {
        self.console.lines.all()
    }

    pub fn has_printed(&self, line: &str) -> bool {
        self.printed().iter().any(|l| l == line)
    }

    pub fn printed_with(&self, part: &str) -> bool {
        self.printed().iter().any(|l| l.contains(part))
    }

    pub fn wait_printed(&self, line: &str) {
        wait_for(&format!("{line:?} to be printed"), 5.0, || {
            self.has_printed(line)
        });
    }

    pub fn state(&self) -> PathBuf {
        self.env.path().to_path_buf()
    }

    /// The session journal's entries.
    pub fn journal(&self) -> Vec<Value> {
        let journal = self.agent.journal.get().expect("a journal");
        hive_knowledge::session_journal::read(&journal.dir).expect("the journal reads")
    }

    pub fn journal_kinds(&self) -> Vec<(String, String)> {
        self.journal()
            .iter()
            .map(|e| {
                (
                    e["kind"].as_str().unwrap_or("").to_owned(),
                    e["text"].as_str().unwrap_or("").to_owned(),
                )
            })
            .collect()
    }

    /// You tapped fn (as the helper's watch says it).
    pub fn tap_fn(&self) {
        self.helper_event(&[("fn", "down")]);
        self.helper_event(&[("fn", "tap")]);
    }

    pub fn helper_event(&self, fields: &[(&str, &str)]) {
        let fields: BTreeMap<String, String> = fields
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        self.agent.put(hive_app::Event::Helper(fields));
    }

    /// You said this and paused (on_text's final text).
    pub fn say(&self, text: &str) {
        self.ears.heard_at(0.9, 0.05, 0.0);
        self.agent.heard(text, true);
    }
}

impl Default for Harness {
    fn default() -> Self {
        Harness::new()
    }
}

impl Drop for Harness {
    fn drop(&mut self) {
        self.stop();
    }
}
