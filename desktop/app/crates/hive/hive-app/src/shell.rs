//! The voice agent (python/voice_agent.py's `VoiceAgent`): tap fn and it listens; when you pause,
//! Codex does what you said, talking you through it. Hold fn and what you say is typed where you
//! are typing (dictation). One thread runs the event loop ([`VoiceAgent::run`]); the listener, the
//! voice, the helper, the lip reader and the request socket put events on its queue.

use crate::parts::{
    Backend, Captions, Closeable, Console, Ears, Host, LocalRequest, Look, Mac, Task, Voice,
};
use crate::util::{
    self, env_set, fill, monotonic, now, round, shortened, spoken, took_over, Dictation, Slot,
    CANCEL, CANT_HEAR_THE_MAC, CONTINUE, FILLERS, FOLLOW_UP, JUST_SPOKE, MIC_SILENT, TOOK_OVER,
};
use hive_knowledge::session_journal::{self, SessionJournal};
use hive_knowledge::task_recording::Recorder;
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

/// Set by SIGTERM and SIGINT (hive-agent's handlers): the main loop ends, as Python's
/// KeyboardInterrupt ended it, and [`VoiceAgent::shutdown`] hands back the mouse and keyboard.
pub static INTERRUPTED: AtomicBool = AtomicBool::new(false);

/// What the main loop is told (Python's `(kind, data)` tuples on `self.events`).
pub enum Event {
    Helper(BTreeMap<String, String>),
    /// What you've said so far, or (final) all of it, with when you stopped talking etc.
    Heard(String, bool, Option<BTreeMap<String, f64>>),
    HeardBarrier(u64),
    Timing(Timing),
    Task(Arc<dyn Task>, String, String),
    WorkspaceActivity(String, String),
    Ignored(f64, f64),
    Toggle,
    Overlay(String, Option<bool>),
    TypedRequest(String),
    LocalRequest(LocalRequest),
    Ingest(String),
    Input(String),
    Lips(String, Option<String>, Option<u64>),
    Camera(Value),
    /// What's heard from now on goes to this dictation, or (None) the agent.
    Route(Option<Arc<Dictation>>),
    Dictated(Arc<Dictation>),
    /// Agent menu › Speak Aloud ("speak on|off").
    Speak(bool),
    /// Agent menu › Show Floating Window ("window on|off").
    Window(bool),
}

impl Event {
    /// The kind Python's tuple had, for the tests.
    pub fn kind(&self) -> &'static str {
        match self {
            Event::Helper(_) => "helper",
            Event::Heard(..) => "heard",
            Event::HeardBarrier(_) => "heard_barrier",
            Event::Timing(_) => "timing",
            Event::Task(..) => "task",
            Event::WorkspaceActivity(..) => "workspace_activity",
            Event::Ignored(..) => "ignored",
            Event::Toggle => "toggle",
            Event::Overlay(..) => "overlay",
            Event::TypedRequest(_) => "typed_request",
            Event::LocalRequest(_) => "local_request",
            Event::Ingest(_) => "ingest",
            Event::Input(_) => "input",
            Event::Lips(..) => "lips",
            Event::Camera(_) => "camera",
            Event::Route(_) => "route",
            Event::Dictated(_) => "dictated",
            Event::Speak(_) => "speak",
            Event::Window(_) => "window",
        }
    }
}

/// The latest request's times, until its first words are heard (Python's `timing` dict), on
/// [`util::monotonic`]'s clock.
#[derive(Clone)]
pub struct Timing {
    pub task: Arc<dyn Task>,
    pub stopped: Option<f64>,
    pub decided: Option<f64>,
    pub written: Option<f64>,
    /// Its reply has been given to the voice (or the captions).
    pub queued: bool,
    pub answered: Option<f64>,
    pub spoken: bool,
}

impl Timing {
    pub fn new(task: Arc<dyn Task>, times: Option<&BTreeMap<String, f64>>) -> Timing {
        let get = |k: &str| times.and_then(|t| t.get(k).copied());
        Timing {
            task,
            stopped: get("stopped"),
            decided: get("decided"),
            written: get("written"),
            queued: false,
            answered: None,
            spoken: false,
        }
    }
}

/// Where a request's time went, from when you stopped talking to hearing its reply: '⏱  2.9 s
/// from when you stopped talking to hearing its reply: 0.8 s to be sure you'd finished, 0.1 s
/// writing it down, screenshot ready (taken as you talked), 1.6 s for Codex's first words (1 model
/// call), 0.4 s for the voice to start'.
pub fn describe_timing(timing: &Timing) -> String {
    let task = &timing.task;
    let began = task.began();
    let times = task.times();
    let t = |key: &str| times.iter().find(|(k, _)| k == key).map(|(_, v)| began + v);
    // `x or y`: a 0.0 counts as missing, as in Python.
    let given = |v: Option<f64>| v.filter(|v| *v != 0.0);
    let (stopped, decided, written) = (
        given(timing.stopped),
        given(timing.decided),
        given(timing.written),
    );
    let start = stopped.or(decided).or(written).unwrap_or(began);
    let mut parts: Vec<String> = Vec::new();
    if let (Some(s), Some(d)) = (stopped, decided) {
        parts.push(format!("{:.1} s to be sure you'd finished", d - s));
    }
    if let (Some(d), Some(w)) = (decided, written) {
        parts.push(format!("{:.1} s writing it down", w - d));
    }
    if let Some(w) = written {
        if began - w >= 0.1 {
            parts.push(format!("{:.1} s before the task started", began - w));
        }
    }
    let mut since = began;
    if let Some(look) = t("look") {
        parts.push(if task.looked_ahead() {
            "screenshot ready (taken as you talked)".to_owned()
        } else {
            format!("{:.1} s for the screenshot", look - since)
        });
        since = look;
    }
    if let Some(codex) = t("codex") {
        if codex - since >= 0.1 {
            parts.push(format!("{:.1} s for Codex to start", codex - since));
        }
        since = codex;
    }
    if let Some(words) = t("words") {
        let calls = task.calls_to_words();
        let s = if calls != 1 { "s" } else { "" };
        parts.push(format!(
            "{:.1} s for Codex's first words ({calls} model call{s})",
            words - since
        ));
        since = words;
    }
    let end = timing.answered.unwrap_or(since);
    if timing.spoken && end - since >= 0.05 {
        parts.push(format!("{:.1} s for the voice to start", end - since));
    }
    let heard = if timing.spoken { "hearing" } else { "seeing" };
    format!(
        "⏱  {:.1} s from when you stopped talking to {heard} its reply: {}",
        end - start,
        parts.join(", ")
    )
}

/// The same task (Python's `is`).
pub fn same(a: &Arc<dyn Task>, b: &Arc<dyn Task>) -> bool {
    std::ptr::addr_eq(Arc::as_ptr(a), Arc::as_ptr(b))
}

/// One task per device, at the same time (Python's `{"mac": ..., "phone": ...}`).
#[derive(Clone, Default)]
pub struct Tasks {
    pub mac: Option<Arc<dyn Task>>,
    pub phone: Option<Arc<dyn Task>>,
}

impl Tasks {
    pub fn get(&self, device: &str) -> Option<Arc<dyn Task>> {
        if device == "phone" {
            self.phone.clone()
        } else {
            self.mac.clone()
        }
    }
    pub fn set(&mut self, device: &str, task: Option<Arc<dyn Task>>) {
        if device == "phone" {
            self.phone = task;
        } else {
            self.mac = task;
        }
    }
    /// ("mac", task), ("phone", task), in that order.
    pub fn items(&self) -> [(&'static str, Option<Arc<dyn Task>>); 2] {
        [("mac", self.mac.clone()), ("phone", self.phone.clone())]
    }
    pub fn any(&self) -> bool {
        self.mac.is_some() || self.phone.is_some()
    }
    pub fn any_running(&self) -> bool {
        self.items()
            .iter()
            .any(|(_, t)| t.as_ref().is_some_and(|t| t.running()))
    }
}

/// The parts a [`VoiceAgent`] works with.
pub struct Parts {
    pub ears: Arc<dyn Ears>,
    /// None: --no-speak.
    pub voice: Option<Arc<dyn Voice>>,
    pub captions: Arc<dyn Captions>,
    pub mac: Arc<dyn Mac>,
    pub backend: Arc<dyn Backend>,
    pub host: Arc<dyn Host>,
    pub console: Arc<dyn Console>,
    /// Run by Agent.app: no terminal, and "@@" lines for its menu bar.
    pub app: bool,
}

/// An atomic flag with Python's attribute feel.
#[derive(Default)]
pub struct Flag(AtomicBool);

impl Flag {
    pub fn new(on: bool) -> Flag {
        Flag(AtomicBool::new(on))
    }
    pub fn get(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
    pub fn set(&self, on: bool) -> bool {
        self.0.swap(on, Ordering::SeqCst)
    }
}

pub struct VoiceAgent {
    me: Weak<VoiceAgent>,
    pub app: Flag,
    /// What macOS asks permission for.
    pub who: String,
    pub captions: Arc<dyn Captions>,
    pub voice: Option<Arc<dyn Voice>>,
    pub mac: Arc<dyn Mac>,
    pub ears: Arc<dyn Ears>,
    pub backend: Arc<dyn Backend>,
    pub host: Arc<dyn Host>,
    pub console: Arc<dyn Console>,
    events: Sender<Event>,
    inbox: Mutex<Receiver<Event>>,
    /// The window's mic button: the microphone stays off however fn is used.
    pub muted: Flag,
    /// Agent menu › Speak Aloud (kept in util::SPEAK_ALOUD): off, what it says is shown and
    /// saved but not spoken.
    pub speaking: Flag,
    /// Every task is recorded (task_recording); set by whoever builds the agent.
    pub recorder: Slot<Option<Arc<Recorder>>>,
    /// For the agent: you tapped fn.
    pub listening: Flag,
    pub discard_heard: Flag,
    pub heard_barrier: Slot<u64>,
    /// When you last tapped fn to talk; 0 while it isn't listening.
    pub listening_since: Slot<f64>,
    /// fn is down: it may be a tap, or the start of dictation.
    pub held: Slot<Option<Arc<Dictation>>>,
    /// fn + shift: the dictation in `held` goes on after you let go, until you press fn again.
    pub hands_free: Flag,
    /// fn went down during hands-free dictation: letting go types it.
    pub hands_free_ending: Flag,
    /// Where what's heard goes now, instead of the agent.
    pub dictation: Slot<Option<Arc<Dictation>>>,
    pub tasks: Slot<Tasks>,
    /// Device: what its task is doing, for the captions (in the order they started).
    pub doing: Slot<Vec<(String, String)>>,
    pub warned_about_mic: Flag,
    /// Its voice has been playing without the echo canceller hearing it.
    pub unheard_since: Slot<f64>,
    pub warned_about_tap: Flag,
    /// What you're saying started while it was talking.
    pub over_its_voice: Flag,
    /// The words you're saying, rewritten in place on one line.
    pub live: Flag,
    pub live_shown: Flag,
    /// When you took over a running task; 0 when not paused.
    pub paused_since: Slot<f64>,
    pub pause_announced: Flag,
    /// Device ("" for none): the last thing its task said.
    pub last_said: Slot<HashMap<String, String>>,
    /// (when, text): what it has said lately.
    pub said: Slot<Vec<(f64, String)>>,
    /// The Mac's look, taken as you started saying this.
    pub ahead: Slot<Option<Look>>,
    pub timing: Slot<Option<Timing>>,
    pub stopped: Flag,
    pub journal: Slot<Option<Arc<SessionJournal>>>,
    pub journal_warned: Flag,
    /// "voice" or "lips".
    pub input_mode: Slot<String>,
    pub lips: Slot<Option<Arc<dyn crate::parts::Lips>>>,
    pub lips_generation: Slot<u64>,
    pub embedded_workspace: Slot<Option<Arc<dyn Closeable>>>,
    pub local_requests: Slot<Option<Arc<dyn Closeable>>>,
    /// Where your cursor goes back to when the task ends.
    pub cursor_home: Slot<Option<(f64, f64)>>,
    viewer_voice_allowed: Flag,
    workspace_status_at: Slot<f64>,
    workspace_last_status: Slot<Option<(Value, Value)>>,
    watcher: Slot<Option<hive_mac::HelperWatcher>>,
    /// Ends the loop as Python's KeyboardInterrupt did (SIGTERM, SIGINT).
    pub interrupted: Arc<AtomicBool>,
}

fn obj(fields: Value) -> Map<String, Value> {
    match fields {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}

impl VoiceAgent {
    pub fn new(parts: Parts) -> Arc<VoiceAgent> {
        let (events, inbox) = channel();
        let live = parts.console.tty();
        let agent = Arc::new_cyclic(|me| VoiceAgent {
            me: me.clone(),
            app: Flag::new(parts.app),
            who: if parts.app {
                "Agent"
            } else {
                "the app you run ./voice.sh in"
            }
            .to_owned(),
            captions: parts.captions,
            voice: parts.voice,
            mac: parts.mac,
            ears: parts.ears,
            backend: parts.backend,
            host: parts.host,
            console: parts.console,
            events,
            inbox: Mutex::new(inbox),
            muted: Flag::new(false),
            speaking: Flag::new(util::setting(util::SPEAK_ALOUD)), // before its first words
            recorder: Slot::new(None),
            listening: Flag::new(false),
            discard_heard: Flag::new(false),
            heard_barrier: Slot::new(0),
            listening_since: Slot::new(0.0),
            held: Slot::new(None),
            hands_free: Flag::new(false),
            hands_free_ending: Flag::new(false),
            dictation: Slot::new(None),
            tasks: Slot::default(),
            doing: Slot::default(),
            warned_about_mic: Flag::new(false),
            unheard_since: Slot::new(0.0),
            warned_about_tap: Flag::new(false),
            over_its_voice: Flag::new(false),
            live: Flag::new(live),
            live_shown: Flag::new(false),
            paused_since: Slot::new(0.0),
            pause_announced: Flag::new(false),
            last_said: Slot::default(),
            said: Slot::default(),
            ahead: Slot::new(None),
            timing: Slot::new(None),
            stopped: Flag::new(false),
            journal: Slot::new(None),
            journal_warned: Flag::new(false),
            input_mode: Slot::new("voice".to_owned()),
            lips: Slot::new(None),
            lips_generation: Slot::new(0),
            embedded_workspace: Slot::new(None),
            local_requests: Slot::new(None),
            cursor_home: Slot::new(None),
            viewer_voice_allowed: Flag::new(true),
            workspace_status_at: Slot::new(0.0),
            workspace_last_status: Slot::new(None),
            watcher: Slot::new(None),
            interrupted: Arc::new(AtomicBool::new(false)),
        });
        if agent.voice.is_some() && agent.ears.has_voiceprint() {
            let me = agent.me.clone();
            let _ = std::thread::Builder::new()
                .name("learn-voice".into())
                .spawn(move || {
                    if let Some(agent) = me.upgrade() {
                        agent.learn_its_voice();
                    }
                });
        }
        agent.ears_listen(false); // until you tap fn
        agent
    }

    fn arc(&self) -> Arc<VoiceAgent> {
        self.me
            .upgrade()
            .expect("the agent is used through its Arc")
    }

    /// Puts an event on the main loop's queue.
    pub fn put(&self, event: Event) {
        let _ = self.events.send(event);
    }

    /// The next event on the queue, if any (for the tests: Python's `events.get_nowait()`).
    pub fn next_event(&self) -> Option<Event> {
        self.inbox
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .try_recv()
            .ok()
    }

    /// The muted wrapper around `ears.listen`.
    pub fn ears_listen(&self, on: bool) {
        self.ears.listen(on && !self.muted.get());
    }

    /// The task on the Mac.
    pub fn task(&self) -> Option<Arc<dyn Task>> {
        self.tasks.lock().mac.clone()
    }

    /// fn is down (`self.held is not None`).
    fn holding(&self) -> bool {
        self.held.lock().is_some()
    }

    fn mac_task_running(&self) -> bool {
        self.task().is_some_and(|t| t.running())
    }

    // -- from other threads --

    /// From the listener's thread: what you've said so far, or (final) all of it.
    pub fn heard(&self, text: &str, final_: bool) {
        let times = final_.then(|| self.ears.heard_times());
        self.put(Event::Heard(text.to_owned(), final_, times));
    }

    /// From the listener's thread: someone who isn't you talked (your voiceprint didn't match).
    pub fn ignored(&self, seconds: f64, similarity: f64) {
        self.put(Event::Ignored(seconds, similarity));
    }

    /// The floating window's text box: a typed request.
    pub fn on_input(&self, text: &str) {
        self.put(Event::TypedRequest(text.to_owned()));
    }

    /// The floating window's buttons.
    pub fn on_control(&self, kind: &str, value: Option<bool>) {
        self.put(Event::Overlay(kind.to_owned(), value));
    }

    /// Teaches the voiceprint its own voice, so its voice getting past the echo canceller isn't
    /// taken for you.
    pub fn learn_its_voice(&self) {
        if let Err(e) = self.ears.learn_its_voice() {
            self.out(&format!(
                "   (couldn't learn its own voice, so it may hear itself: {e})"
            ));
        }
    }

    /// From the listener's thread: you've started talking. If it was talking, it stops. Unless
    /// a task is working on the Mac (changing what's on it), it looks at the Mac now, for what
    /// you're asking.
    pub fn cut_in(&self) {
        let over = self.voice.as_ref().is_some_and(|v| v.audible());
        self.over_its_voice.set(over);
        if over {
            if let Some(voice) = &self.voice {
                voice.stop();
            }
            self.captions.say("");
        }
        let looking = self.listening.get()
            && self.held.lock().is_none()
            && self.dictation.lock().is_none()
            && !self.mac_task_running();
        self.ahead.set(if looking {
            self.backend.look_ahead()
        } else {
            None
        });
    }

    /// From the voice's thread: words start playing.
    pub fn on_play(&self, words: &str) {
        self.captions.say(words);
        let answered = {
            let mut timing = self.timing.lock();
            match timing.as_mut() {
                Some(t) if t.queued && t.answered.is_none() => {
                    t.answered = Some(monotonic());
                    t.spoken = true;
                    Some(t.clone())
                }
                _ => None,
            }
        };
        if let Some(timing) = answered {
            self.put(Event::Timing(timing));
        }
    }

    /// What it heard over its voice, or just after, was mostly what it was saying: echo that got
    /// through (Parakeet mishears some of it, so 70% of the words will do).
    pub fn its_own_words(&self, words: &str) -> bool {
        let t = now();
        let recent: Vec<String> = self
            .said
            .lock()
            .iter()
            .filter(|(when, _)| t - when < 30.0)
            .map(|(_, text)| text.clone())
            .collect();
        let mine: std::collections::HashSet<String> =
            util::stems(&recent.join(" ")).into_iter().collect();
        let heard = util::stems(words);
        heard.len() >= 3
            && heard.iter().filter(|w| mine.contains(*w)).count() as f64 >= 0.7 * heard.len() as f64
    }

    // -- the main loop --

    /// Watches the helper for as long as it runs (fn, and who has control).
    pub fn watch_helper(&self) {
        let events = self.events.clone();
        let watcher = hive_mac::HelperWatcher::start(self.mac.socket(), move |fields| {
            let _ = events.send(Event::Helper(fields.0.into_iter().collect()));
        });
        self.watcher.set(Some(watcher));
    }

    /// Saves it in the session journal (python/session_journal.py).
    pub fn log(&self, kind: &str, text: &str, fields: Value) {
        let Some(journal) = self.journal.get() else {
            return;
        };
        journal.add(kind, text, obj(fields));
        if let Some(error) = journal.error() {
            if !self.journal_warned.set(true) {
                self.out(&format!(
                    "   ✗ the session journal couldn't be saved: {error}"
                ));
            }
        }
    }

    pub fn start_journal(&self) {
        let mut about = Map::new();
        about.insert("backend".into(), json!(self.backend.describe_model()));
        about.insert(
            "voice".into(),
            self.voice
                .as_ref()
                .map(|v| json!(v.name()))
                .unwrap_or(Value::Null),
        );
        about.insert("app".into(), json!(self.app.get()));
        match SessionJournal::new(about, None) {
            Ok(journal) => {
                let journal = Arc::new(journal);
                session_journal::set_current(Some(journal.clone()));
                self.journal.set(Some(journal));
            }
            Err(e) => self.out(&format!(
                "   ✗ the session journal couldn't be started: {e}"
            )),
        }
    }

    /// Waits for speech to be ready, away from the request and workspace loop.
    pub fn announce_audio(&self) {
        let hearing = self.ears.describe();
        if !self.ears.has_model() {
            self.out(&format!(
                "Voice input unavailable: {hearing}. Typed requests remain available."
            ));
            self.tell(
                "status",
                "Voice input unavailable; typed requests are ready",
            );
            return;
        }
        let microphone = self
            .ears
            .microphone()
            .map(|m| m.description)
            .unwrap_or_else(|| "None".into());
        let name = hive_sidecars::audio::name(hive_sidecars::audio::microphone());
        let name = if name.is_empty() {
            "none".to_owned()
        } else {
            name
        };
        self.out(&format!(
            "Hears you with: {hearing}, microphone: {name}, echo cancellation: {microphone}.\nOnly listening to \
             you: {}.",
            self.ears.describe_voiceprint()
        ));
        self.tell("status", "Ready");
    }

    fn spawn(&self, name: &str, job: impl FnOnce(Arc<VoiceAgent>) + Send + 'static) {
        let me = self.arc();
        let _ = std::thread::Builder::new()
            .name(name.into())
            .spawn(move || job(me));
    }

    /// Runs the main loop until [`shutdown`](Self::shutdown) or a signal.
    pub fn run(&self) {
        self.start_journal();
        self.apply_menu_settings();
        let app = self.app.get();
        if app && env_set("AGENT_SPACEO_COMMAND") {
            self.spawn("personal-agent-workspace", |me| {
                me.start_embedded_workspace()
            });
        } else if app {
            self.spawn("virtual-monitor", |me| me.start_virtual_monitor());
        }
        if app {
            let events = Mutex::new(self.events.clone());
            let sink = Arc::new(move |request: LocalRequest| {
                let _ = events
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .send(Event::LocalRequest(request));
            });
            match self
                .host
                .local_requests(&hive_common::state_dir().join("control"), sink)
            {
                Ok(requests) => {
                    self.local_requests.set(Some(requests));
                }
                Err(error) => self.out(&format!("Local request channel unavailable: {error}")),
            }
        }
        self.watch_helper();
        self.out(&format!(
            "Ready. Tap fn and say what you want done; tap fn again to turn the mic off.{}\n",
            if app { "" } else { " Ctrl-C to quit." }
        ));
        self.tell("listening", "0");
        self.tell("status", "Typed requests ready; voice input is loading");
        self.spawn("personal-agent-audio-ready", |me| me.announce_audio());
        let context = hive_common::state_dir().join("context/index.html");
        if context.exists() {
            self.tell("context", &context.display().to_string());
        }
        if let Some(journal) = self.journal.get() {
            journal.touch();
            self.tell("panel", &journal.panel_path().display().to_string()); // the Agent Context panel reads it
        }
        if self.host.lips_mode() == "lips" {
            self.set_input("lips", false);
        } else {
            self.tell("input", "voice");
        }
        if !self.app.get() {
            self.out(&format!("Agent context: {}", context.display()));
            if let Some(journal) = self.journal.get() {
                self.out(&format!(
                    "This session is saved in {}",
                    journal.dir.display()
                ));
            }
        }
        self.resume_at_start();
        let inbox = self.inbox.lock().unwrap_or_else(|e| e.into_inner());
        while !self.stopped.get()
            && !self.interrupted.load(Ordering::SeqCst)
            && !INTERRUPTED.load(Ordering::SeqCst)
        {
            self.tick();
            let event = match inbox.recv_timeout(Duration::from_millis(300)) {
                Ok(event) => event,
                Err(RecvTimeoutError::Timeout) => continue,
                Err(RecvTimeoutError::Disconnected) => break,
            };
            self.dispatch(event);
        }
    }

    /// One event from the queue.
    pub fn dispatch(&self, event: Event) {
        match event {
            Event::Helper(fields) => self.on_helper(&fields),
            Event::Heard(text, final_, times) => self.on_heard(&text, final_, times.as_ref()),
            Event::HeardBarrier(barrier) => {
                if barrier == self.heard_barrier.get() {
                    self.discard_heard.set(false);
                }
            }
            Event::Timing(timing) => self.out(&describe_timing(&timing)),
            Event::Task(task, kind, text) => self.on_task_event(&task, &kind, &text),
            Event::WorkspaceActivity(kind, text) => {
                if let Some(task) = self.task() {
                    self.on_task_event(&task, &kind, &text);
                }
            }
            Event::Ignored(seconds, similarity) => self.on_ignored(seconds, similarity),
            Event::Toggle => self.set_listening(!self.listening.get()),
            Event::Overlay(kind, value) => self.on_overlay(&kind, value),
            Event::TypedRequest(text) => {
                self.captions.hearing(&text);
                self.on_transcript(&text, None, true, false, None);
            }
            Event::LocalRequest(request) => self.on_local_request(request),
            Event::Ingest(path) => self.start_ingest(&path),
            Event::Input(mode) => self.set_input(&mode, true),
            Event::Lips(text, error, generation) => {
                self.on_lips(&text, error.as_deref(), generation)
            }
            Event::Camera(event) => self.on_camera(&event),
            Event::Route(dictation) => {
                self.dictation.set(dictation);
            }
            Event::Dictated(dictation) => {
                self.dictation.set(None);
                self.type_dictation(&dictation);
            }
            Event::Speak(on) => self.set_speaking(on),
            Event::Window(on) => self.set_window(on, "the menu"),
        }
    }

    /// Speak Aloud and Show Floating Window as they were left, for the menu's checkmarks and
    /// before anything is said or shown.
    fn apply_menu_settings(&self) {
        let speaking = self.speaking.get();
        let window = util::setting(util::FLOATING_WINDOW);
        self.tell("speak", if speaking { "1" } else { "0" });
        self.tell("window", if window { "1" } else { "0" });
        if !window {
            self.captions.hidden(true);
            self.out(
                "🫥 Show Floating Window is off (Agent menu): the card shows only while you use fn",
            );
        }
        if !speaking {
            self.out(
                "🔇 Speak Aloud is off (Agent menu): replies are shown and logged, not spoken",
            );
        }
    }

    /// Agent menu › Speak Aloud ("speak on|off"). Off stops what it's saying at once and it says
    /// nothing more: what it would have said still goes to the card, the log and the journal. On,
    /// the next thing it says is spoken; no restart. The microphone is left as it is. Kept for the
    /// next launch. The app's thread calls it too, so it goes quiet even while the loop is busy.
    pub fn set_speaking(&self, on: bool) {
        self.speaking.set(on);
        if let Err(error) = util::set_setting(util::SPEAK_ALOUD, on) {
            self.out(&format!(
                "   ✗ Speak Aloud couldn't be kept for next time: {error}"
            ));
        }
        if !on {
            if let Some(voice) = &self.voice {
                let cut_off = voice.audible();
                voice.stop();
                if cut_off {
                    // what it was saying, on the card instead
                    let last = self.said.lock().last().map(|(_, text)| text.clone());
                    if let Some(text) = last {
                        self.captions.say(&spoken(&text));
                    }
                }
            }
        }
        self.tell("speak", if on { "1" } else { "0" });
        self.log(
            "speak aloud",
            if on { "on" } else { "off" },
            json!({"from": "the menu"}),
        );
        self.out(if on {
            "🔊 Speak Aloud on (Agent menu): replies are spoken"
        } else {
            "🔇 Speak Aloud off (Agent menu): replies are shown and logged, not spoken"
        });
    }

    /// Agent menu › Show Floating Window ("window on|off"), or the card's – (off). Off, the card
    /// stays hidden, task or not, except while you use fn; it's still told everything, so turning
    /// it on shows it as it is now. The task and the voice carry on either way. Kept for the next
    /// launch; the menu's checkmark follows.
    pub fn set_window(&self, on: bool, from: &str) {
        if let Err(error) = util::set_setting(util::FLOATING_WINDOW, on) {
            self.out(&format!(
                "   ✗ Show Floating Window couldn't be kept for next time: {error}"
            ));
        }
        self.captions.hidden(!on);
        self.tell("window", if on { "1" } else { "0" });
        self.log(
            "floating window",
            if on { "shown" } else { "hidden" },
            json!({"from": from}),
        );
        self.out(&if on {
            format!("🪟 floating window shown ({from})")
        } else {
            format!("🫥 floating window hidden ({from}); Hive keeps working, and fn still opens it")
        });
    }

    /// Agent menu › Quit Agent or Restart Agent, in the log and the session journal before it
    /// stops, so a quit isn't taken for a crash. The app's thread calls it.
    pub fn note_menu_stop(&self, what: &str) {
        self.log("app", what, json!({}));
        self.out(&format!("⏏  {what}"));
    }

    /// An update's restart continues the request; otherwise (the app, Codex) the saved request
    /// that didn't finish is continued.
    fn resume_at_start(&self) {
        let state = hive_common::state_dir();
        let mut resume = state.join("updates").join("update-resume");
        if !resume.exists() {
            resume = state.join("update-resume"); // finish a handoff from an older version
        }
        let app = self.app.get();
        if app && resume.exists() {
            let resumed = (|| -> Result<(), String> {
                let saved = self.backend.recovery_current()?;
                std::fs::rename(&resume, resume.with_file_name("update-resumed"))
                    .map_err(|e| hive_knowledge::util::os_error(&e, &resume))?;
                let active = saved
                    .as_ref()
                    .map(|s| s.get("status") == Some(&json!("active")));
                if active != Some(false) {
                    self.put(Event::TypedRequest(
                        "The agent update has been installed and restarted. This maintenance restart was not a \
                         user request to stop; continue the prior authorized request in this same conversation, \
                         unless the user separately stopped or paused it. Work on other independent tasks if one \
                         is blocked. Verify the new version and any uncertain effects before acting; do not \
                         schedule the same update again or repeat actions that may already have happened."
                            .into(),
                    ));
                }
                Ok(())
            })();
            if let Err(error) = resumed {
                self.out(&format!("Could not resume after the update: {error}"));
            }
        } else if app
            && std::env::var("AGENT_BACKEND").unwrap_or_else(|_| "codex".into()) == "codex"
        {
            // A durable reservation is committed before connecting. A crash during the
            // continuation therefore never causes an automatic replay loop.
            match self.backend.restore() {
                Ok(Some(task)) => {
                    task.set_on_event(self.task_events(&task));
                    self.tasks.lock().set(&task.device(), Some(task.clone()));
                    task.start(false);
                    self.out("Restoring the saved conversation and checking unfinished work.");
                }
                Ok(None) => {}
                Err(error) => self.out(&format!("Could not restore unfinished work: {error}")),
            }
        }
    }

    /// Where a task's events go: the main loop, with the task. The callback holds the task until
    /// its last event ("done" or "failed"), so the events of a task that was stopped or replaced
    /// still reach the journal, and then lets go, so the task and its callback don't keep each
    /// other alive.
    pub fn task_events(&self, task: &Arc<dyn Task>) -> crate::parts::OnEvent {
        let events = Mutex::new(self.events.clone());
        let task = Mutex::new(Some(task.clone()));
        Arc::new(move |kind: &str, text: &str| {
            let held = {
                let mut task = task.lock().unwrap_or_else(|e| e.into_inner());
                if matches!(kind, "done" | "failed") {
                    task.take()
                } else {
                    task.clone()
                }
            };
            if let Some(task) = held {
                let _ = events
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .send(Event::Task(task, kind.to_owned(), text.to_owned()));
            }
        })
    }

    pub fn start_embedded_workspace(&self) {
        let Ok(spaceo) = std::env::var("AGENT_SPACEO_COMMAND") else {
            return;
        };
        // A host-health latch left by an earlier sample would refuse the display below.
        match self.host.recover_workspace(&spaceo) {
            Ok((outcome, detail)) => {
                if outcome != "not-latched" {
                    self.out(&format!(
                        "Virtual workspace safety latch {outcome}: {detail}"
                    ));
                }
            }
            Err(error) => self.out(&format!(
                "Virtual workspace safety latch check failed: {error}"
            )),
        }
        let events = Mutex::new(self.events.clone());
        let on_activity = Arc::new(move |kind: &str, text: &str| {
            let _ = events
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .send(Event::WorkspaceActivity(kind.to_owned(), text.to_owned()));
        });
        match self.host.start_workspace(&spaceo, on_activity) {
            Ok(workspace) => {
                if self.stopped.get() {
                    workspace.close();
                } else {
                    self.embedded_workspace.set(Some(workspace));
                }
            }
            Err(error) => {
                self.host
                    .workspace_error(&format!("Could not start the virtual workspace: {error}"));
                self.out(&format!("Virtual workspace unavailable: {error}"));
            }
        }
    }

    /// A request from another program through the request socket.
    pub fn on_local_request(&self, request: LocalRequest) {
        if std::time::Instant::now() >= request.deadline {
            (request.reply)(
                json!({"ok": false, "error": "The request expired before it could start."}),
            );
            return;
        }
        if self.tasks.get().any_running() {
            (request.reply)(
                json!({"ok": false, "error": "The personal-agent is already working."}),
            );
            return;
        }
        let result = (|| -> Result<(), String> {
            if request.resume_goal {
                if !self.backend.server_running() {
                    return Err("Codex server is not ready; goal was not resumed.".into());
                }
                let path = hive_common::state_dir().join("codex-thread-id");
                let thread = std::fs::read_to_string(&path)
                    .map_err(|e| hive_knowledge::util::os_error(&e, &path))?;
                let mut params =
                    json!({"threadId": thread.trim(), "status": "active", "origin": "user"});
                if let Some(objective) = request.goal_objective.as_deref().filter(|o| !o.is_empty())
                {
                    params["objective"] = json!(objective);
                }
                let result = match self.backend.request("thread/goal/set", params, 3.0) {
                    None => return Err("Codex server is not ready; goal was not resumed.".into()),
                    Some(result) => result?,
                };
                let status = result
                    .get("goal")
                    .and_then(|g| g.get("status"))
                    .and_then(Value::as_str);
                if status != Some("active") {
                    return Err("Codex did not confirm the goal is active.".into());
                }
            }
            // Another program sent this, not you: one short line, never a screenful of its words.
            self.captions.agent_request(&shortened(&request.text, 160));
            self.on_transcript(&request.text, None, true, true, request.receipt_id.clone());
            Ok(())
        })();
        (request.reply)(match result {
            Ok(()) => json!({"ok": true}),
            Err(error) => json!({"ok": false, "error": error}),
        });
    }

    /// Agent menu → Add … to Context: the app wrote the text you chose to path (and asked you
    /// first). It goes into the conversation in the background (ingest).
    pub fn start_ingest(&self, path: &str) {
        let prepared = (|| -> Result<hive_common::ingest::Ingestion, String> {
            let path = std::path::Path::new(path);
            let bytes =
                std::fs::read(path).map_err(|e| hive_knowledge::util::os_error(&e, path))?;
            let content = String::from_utf8_lossy(&bytes).into_owned();
            let (title, text) = content.split_once('\n').unwrap_or((&content, "")); // the app's first line is the title
            std::fs::remove_file(path).map_err(|e| hive_knowledge::util::os_error(&e, path))?;
            hive_common::ingest::prepare(text, title.trim(), "Agent menu")
        })();
        let ing = match prepared {
            Ok(ing) => ing,
            Err(e) => {
                self.log(
                    "ingest done",
                    &format!("not added: {e}"),
                    json!({"status": "failed"}),
                );
                self.out(&format!("   ✗ couldn't add that text: {e}"));
                self.tell("status", &format!("Couldn't add the text: {e}"));
                return;
            }
        };
        self.out(&format!(
            "   📥 adding “{}” ({} characters, {} parts) to the conversation",
            ing.title,
            hive_common::ingest::commas(ing.chars),
            ing.parts.len()
        ));
        self.tell(
            "status",
            &format!(
                "Adding “{}” to the conversation…",
                util::head(&ing.title, 40)
            ),
        );
        self.spawn("ingest", move |me| me.ingest(&ing));
    }

    pub fn ingest(&self, ing: &hive_common::ingest::Ingestion) {
        let mut run_turn = |prompt: &str| -> hive_common::ingest::Turn {
            let deadline = now() + 300.0; // wait for a request on the Mac to finish: one turn at a time
            while self.tasks.get().any_running() && now() < deadline {
                std::thread::sleep(Duration::from_millis(500));
            }
            let task = self.backend.task(
                &format!("(adding “{}” to the conversation)", ing.title),
                None,
                "mac",
                None,
            );
            // Document chunks are data, not an independently resumable user task.
            task.set_durable_recovery(false);
            task.set_prompt(prompt.to_owned());
            let me = self.me.clone();
            task.set_on_event(Arc::new(move |kind: &str, text: &str| {
                if kind == "context" {
                    if let Some(me) = me.upgrade() {
                        me.tell("context", text);
                    }
                }
            }));
            task.start(false);
            if !task.wait_done(240.0) {
                task.stop();
                return hive_common::ingest::Turn {
                    thread: task.thread_id(),
                    on_session_thread: task.on_thread(),
                    reply: None,
                    error: Some("no reply from Codex in 4 minutes".into()),
                };
            }
            let (ended, reply) = (task.ended(), task.final_text());
            let error = if ended.is_empty() && reply.as_deref().is_some_and(|r| !r.is_empty()) {
                None
            } else if ended.is_empty() {
                Some("no reply".to_owned())
            } else {
                Some(ended)
            };
            hive_common::ingest::Turn {
                thread: task.thread_id(),
                on_session_thread: task.on_thread(),
                reply,
                error,
            }
        };
        let host = self.host.clone();
        let mut find_rollout = |thread: &str| host.rollout_for(thread);
        let mut log = |kind: &str, text: &str, fields: Map<String, Value>| {
            self.log(kind, text, Value::Object(fields))
        };
        let mut wait = |d: Duration| std::thread::sleep(d);
        let outcome = hive_common::ingest::send(
            ing,
            &mut run_turn,
            &mut find_rollout,
            &mut log,
            &mut wait,
            Duration::from_secs(3),
        );
        let status = match outcome {
            Ok(outcome) => outcome
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("failed")
                .to_owned(),
            Err(e) => {
                self.log(
                    "ingest done",
                    &format!("{}: failed: {e}", ing.title),
                    json!({"id": ing.id, "status": "failed"}),
                );
                "failed".to_owned()
            }
        };
        let words = match status.as_str() {
            "verified" => "Added to the conversation (verified)",
            "sent" => "Sent, but not verified",
            _ => "Couldn't add it",
        };
        self.out(&format!("   📥 “{}”: {}", ing.title, words.to_lowercase()));
        self.tell(
            "status",
            &format!("{words}: “{}”", util::head(&ing.title, 40)),
        );
    }

    fn bump_lips_generation(&self) {
        *self.lips_generation.lock() += 1;
    }

    fn new_lips(&self) -> Arc<dyn crate::parts::Lips> {
        let events = Mutex::new(self.events.clone());
        self.host.new_lips(Arc::new(move |event: Value| {
            let _ = events
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .send(Event::Camera(event));
        }))
    }

    /// Agent menu → Input: Voice (the microphone) or Lip Reading (the camera, while fn is tapped on).
    pub fn set_input(&self, mode: &str, announce: bool) {
        let mut mode = mode.to_owned();
        if mode == "lips" {
            let (ok, why) = self.host.lips_available();
            if !ok {
                self.out(&format!("   ✗ lip reading isn't available: {why}"));
                self.tell("status", "Lip reading isn't set up: see the log");
                mode = "voice".into();
            }
        }
        if self.listening.get() {
            self.set_listening(false);
        }
        if mode != "lips" {
            if let Some(lips) = self.lips.set(None) {
                lips.close();
            }
        }
        self.input_mode.set(mode.clone());
        self.bump_lips_generation();
        let _ = self.host.set_lips_mode(&mode);
        self.tell("input", &mode);
        if mode == "lips" && self.app.get() && self.lips.lock().is_none() {
            let lips = self.new_lips();
            self.lips.set(Some(lips.clone()));
            let _ = lips.open(); // warm the model without opening the camera
        }
        if announce {
            self.log("input", &mode, json!({}));
            self.out(&format!(
                "   input: {}",
                if mode == "lips" {
                    "lip reading (tap fn, mouth it, tap fn)"
                } else {
                    "voice"
                }
            ));
        }
    }

    /// Lip reading mode's tap of fn: the camera on, or off and what it read becomes a request.
    /// The caption and menu bar icon follow the camera itself (on_camera), not the tap: they say
    /// "on" only once it is recording.
    pub fn set_lips(&self, on: bool) {
        self.listening.set(on);
        self.ears_listen(self.holding()); // the microphone is only for dictation (holding fn)
        self.tell("listening", if on { "1" } else { "0" });
        if on {
            self.backend.new_session();
            self.bump_lips_generation();
            self.captions.hearing("");
            self.captions.say("");
            self.captions.camera("starting");
            let lips = match self.lips.get() {
                Some(lips) => lips,
                None => {
                    let lips = self.new_lips();
                    self.lips.set(Some(lips.clone()));
                    lips
                }
            };
            if let Err(e) = lips.start() {
                self.listening.set(false);
                self.captions.camera("off");
                self.tell("listening", "0");
                self.captions.say(&e);
                self.out(&format!("   ✗ lip reading: {e}"));
                return;
            }
            self.log("lip reading", "camera requested", json!({}));
            self.out("📷 turning the camera on: mouth what you want, then tap fn");
            return;
        }
        self.captions.dismiss();
        self.stop_tasks_for_fn();
        self.bump_lips_generation();
        self.captions.camera("off");
        self.tell("camera", "0");
        self.log("lip reading", "stopped", json!({}));
        self.out("   (stopped lip reading)");
        if let Some(lips) = self.lips.get() {
            std::thread::spawn(move || {
                let _ = lips.stop();
            });
        }
    }

    /// What the lip reading worker says about the camera.
    pub fn on_camera(&self, event: &Value) {
        if let Some(session) = event.get("session").filter(|s| !s.is_null()) {
            let current = self.lips.get().and_then(|l| l.session());
            if Some(session) != current.map(|c| json!(c)).as_ref() {
                return;
            }
        }
        let reading = || self.listening.get() && self.input_mode.get() == "lips";
        let text = |key: &str| {
            event
                .get(key)
                .map(hive_knowledge::pyjson::str_of)
                .unwrap_or_default()
        };
        if event.get("framing").is_some() && reading() {
            self.captions.framing(&text("framing"));
        }
        if event.get("preview").is_some() && reading() {
            self.captions.preview(&text("preview"));
        }
        if event.get("partial").is_some() {
            if reading() {
                self.captions.doing("");
                self.captions.hearing(&text("partial"));
            }
            return;
        }
        if event.get("status").is_some() && reading() {
            self.captions.doing(&text("status"));
        }
        if hive_knowledge::pyjson::truthy(event.get("ready")) {
            self.log(
                "lip reading",
                "model ready",
                json!({"model": event.get("model"), "device": event.get("device")}),
            );
        }
        let state = match event.get("camera") {
            None | Some(Value::Null) => {
                if hive_knowledge::pyjson::truthy(event.get("error")) {
                    let error = text("error");
                    self.out(&format!("   ✗ lip reading: {error}"));
                    if self.input_mode.get() == "lips" {
                        self.captions.doing("");
                        self.captions.say(&format!("Lip reading failed: {error}"));
                        if hive_knowledge::pyjson::truthy(event.get("final")) {
                            self.captions.camera("off");
                            self.listening.set(false);
                            self.tell("listening", "0");
                        }
                    }
                }
                return;
            }
            Some(_) => text("camera"),
        };
        let on = state == "on";
        self.tell("camera", if on { "1" } else { "0" });
        if state == "failed" {
            self.captions.camera("off");
            self.captions
                .say("Camera couldn't open: allow Agent in Privacy & Security › Camera");
            let error = event.get("error").map(hive_knowledge::pyjson::str_of);
            self.log(
                "lip reading",
                error.as_deref().unwrap_or("camera failed"),
                json!({"outcome": "failed"}),
            );
            self.out(&format!(
                "   ✗ lip reading: {}",
                error.as_deref().unwrap_or("None")
            ));
            if reading() {
                self.listening.set(false);
                self.tell("listening", "0");
            }
            return;
        }
        if reading() {
            self.captions.camera(&state); // "waiting", "on"
        }
        if on {
            self.log("lip reading", "camera on", json!({}));
            self.out("🟢 📷 camera on");
        } else if state == "off" {
            self.log("lip reading", "camera off", json!({}));
        }
    }

    pub fn on_lips(&self, text: &str, error: Option<&str>, generation: Option<u64>) {
        if generation.is_some_and(|g| g != self.lips_generation.get()) {
            return;
        }
        self.captions.doing("");
        let error = error.filter(|e| !e.is_empty());
        if error.is_some() || text.is_empty() {
            self.captions.hearing("");
            match error {
                Some(error) => {
                    self.captions.say(&format!("Lip reading failed: {error}"));
                    self.log("lip reading", error, json!({"outcome": "failed"}));
                    self.out(&format!("   ✗ lip reading: {error}"));
                }
                None => {
                    self.captions
                        .say("Couldn't read your lips. Face the camera and try again.");
                    self.log("lip reading", "nothing read", json!({"outcome": "empty"}));
                    self.out("   (couldn't read anything)");
                }
            }
            return;
        }
        self.log("lip reading", text, json!({"outcome": "read"}));
        self.captions.hearing(text);
        self.on_transcript(text, None, false, false, None);
    }

    /// Toggles listening without replacing the durable Codex conversation.
    pub fn set_listening(&self, on: bool) {
        if on == self.listening.get() {
            return;
        }
        if self.input_mode.get() == "lips" {
            return self.set_lips(on);
        }
        self.listening.set(on);
        if on {
            self.backend.new_session();
            if env_set("AGENT_SPACEO_COMMAND") {
                self.tell("workspace-resume", "1");
            }
        } else {
            self.captions.dismiss();
            if let Some(voice) = &self.voice {
                voice.stop(); // quiet now; the agent keeps working until the window's x
            }
            self.discard_heard.set(true);
            *self.heard_barrier.lock() += 1;
        }
        self.ears_listen(on || self.holding());
        if !on {
            let barrier = self.heard_barrier.get();
            let events = Mutex::new(self.events.clone());
            self.ears.cut(Some(Box::new(move || {
                let _ = events
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .send(Event::HeardBarrier(barrier));
            })));
        }
        self.listening_since.set(if on { now() } else { 0.0 });
        self.captions.listening(on);
        self.captions.focus(on && !self.agent_has_control()); // fn opened it: type a request, or say it
        self.tell("listening", if on { "1" } else { "0" });
        self.log(
            if on { "listening" } else { "stopped listening" },
            "",
            json!({}),
        );
        self.out(if on {
            "🎙  listening (tap fn to turn the mic off)"
        } else {
            "   (mic off; tap fn to talk)"
        });
    }

    /// The agent has the mouse and keyboard now (its typing must not go into the card).
    pub fn agent_has_control(&self) -> bool {
        self.mac.is_engaged().unwrap_or(false)
    }

    /// The window's x stops both devices and silences any ongoing spoken response.
    pub fn stop_tasks_for_fn(&self) {
        let mut stopped = Vec::new();
        let tasks = self.tasks.set(Tasks::default());
        for (device, task) in tasks.items() {
            if let Some(task) = task.filter(|t| t.running()) {
                task.stop();
                stopped.push(device);
            }
        }
        self.hand_back();
        if let Some(voice) = &self.voice {
            voice.stop();
        }
        if let Ok(engine) = std::env::var("AGENT_SPACEO_COMMAND") {
            if !engine.is_empty() && stopped.contains(&"mac") && !self.host.pause_workspace(&engine)
            {
                self.out("   ✗ Could not confirm the workspace input was paused.");
            }
        }
        self.doing.lock().clear();
        self.timing.set(None);
        self.captions.active(false);
        self.show_doing();
        if !stopped.is_empty() {
            self.log("stopped by fn", "", json!({"stopped": stopped}));
        }
    }

    /// A line for Agent.app's menu bar.
    pub fn tell(&self, what: &str, text: &str) {
        if self.app.get() {
            self.console.line(&format!("@@ {what} {text}"));
        }
    }

    pub fn tick(&self) {
        let audible_here = util::workspace_voice_allowed();
        if !audible_here && self.viewer_voice_allowed.get() {
            if let Some(voice) = &self.voice {
                voice.stop();
            }
        }
        self.viewer_voice_allowed.set(audible_here);
        if env_set("AGENT_SPACEO_COMMAND") && monotonic() >= self.workspace_status_at.get() {
            self.workspace_status_at.set(monotonic() + 2.0);
            let path = hive_common::state_dir().join("workspace-status.json");
            if let Some(status) = std::fs::read_to_string(&path)
                .ok()
                .and_then(|t| serde_json::from_str::<Value>(&t).ok())
                .filter(Value::is_object)
            {
                let state = (
                    status.get("state").cloned().unwrap_or(Value::Null),
                    status.get("message").cloned().unwrap_or(Value::Null),
                );
                if Some(&state) != self.workspace_last_status.lock().as_ref() {
                    self.workspace_last_status.set(Some(state.clone()));
                    if state.0 == json!("error") {
                        let message = hive_knowledge::pyjson::str_of(&state.1);
                        self.tell(
                            "status",
                            &format!("Workspace unavailable: {}", util::head(&message, 150)),
                        );
                        self.out(&format!(
                            "   ✗ Workspace unavailable: {}",
                            util::head(&message, 300)
                        ));
                    }
                }
            }
        }
        if let Some(held) = self.held.get() {
            if !held.state().shown && now() - held.since > 0.4 {
                self.show_dictating(&held, true); // held longer than a tap
            }
        }
        let since = self.listening_since.get();
        if !self.warned_about_mic.get()
            && self.ears.mic_level() == 0.0
            && since != 0.0
            && now() - since > 5.0
        {
            self.warned_about_mic.set(true);
            self.out(&fill(MIC_SILENT, &[&self.who]));
        }
        let microphone = self.ears.microphone();
        if self.ears.listening()
            && self.voice.as_ref().is_some_and(|v| v.audible())
            && !self.ears.hears_the_mac()
            && microphone.is_some()
        {
            if self.unheard_since.get() == 0.0 {
                self.unheard_since.set(now());
            }
            if now() - self.unheard_since.get() > 2.0 && !self.warned_about_tap.get() {
                self.warned_about_tap.set(true);
                let microphone = microphone.unwrap_or_default();
                let why = microphone
                    .tap_error
                    .filter(|e| !e.is_empty())
                    .or(microphone.canceller_error.filter(|e| !e.is_empty()))
                    .unwrap_or_else(|| "macOS gives it silence".into());
                self.out(&fill(CANT_HEAR_THE_MAC, &[&why, &self.who]));
            }
        } else {
            self.unheard_since.set(0.0);
        }
        if self.paused_since.get() != 0.0
            && !self.pause_announced.get()
            && now() - self.paused_since.get() > 1.0
            && self.mac_task_running()
        {
            self.pause_announced.set(true);
            self.out(
                "⏸  you have the mouse and keyboard; the agent keeps working without the screen. Press fn or say \
                 “continue” to hand them back (or say something new).",
            );
        }
    }

    /// The floating window's buttons: the x stops the agent; the mic mutes what it hears; the –
    /// hides the window (Show Floating Window off) while the task and the voice carry on.
    pub fn on_overlay(&self, kind: &str, value: Option<bool>) {
        if kind == "close" {
            self.out("✋ stopped from the window's x");
            self.stop_tasks_for_fn();
            self.captions.paused("");
            self.captions.agent_request("");
            self.paused_since.set(0.0);
            self.pause_announced.set(false);
        } else if kind == "mute" {
            self.muted.set(value.unwrap_or(false));
            self.ears_listen(self.listening.get() || self.holding());
            self.captions.muted(self.muted.get());
            self.out(if self.muted.get() {
                "🔇 transcription muted; the agent keeps working"
            } else {
                "🎙  transcription on"
            });
        } else if kind == "hidden" {
            self.set_window(!value.unwrap_or(true), "the card's –");
        }
    }

    /// You took over a running Mac task a moment ago or more (not just now, with this fn press).
    pub fn paused_by_you(&self) -> bool {
        let since = self.paused_since.get();
        self.mac_task_running() && since != 0.0 && now() - since > 0.8
    }

    /// The saved request's state, if the Mac's task has one.
    fn save_recovery(&self, status: &str, failed: &str) {
        let Some(task) = self.task() else { return };
        let Some(id) = task.recovery_id() else { return };
        if let Err(error) = self.backend.recovery_finish(&id, status) {
            self.out(&format!("{failed}: {error}"));
        }
    }

    /// fn while you have control of a running task: the agent takes it back once your hands are off.
    pub fn resume_control(&self) {
        self.out("▶️  fn: handing control back to the agent (hands off the keyboard and trackpad)");
        self.captions
            .paused("Resuming once your hands are off the keyboard and trackpad…");
        self.save_recovery("active", "Could not save the resume state"); // the same as saying "continue"
        self.take_control();
    }

    pub fn on_helper(&self, event: &BTreeMap<String, String>) {
        let state = event.get("state").map(String::as_str);
        if matches!(state, Some("engaged" | "disengaged")) {
            if let Some(recorder) = self.recorder.get() {
                let text = if state == Some("engaged") {
                    "agent has the mouse and keyboard".to_owned()
                } else {
                    format!(
                        "control went back to you ({})",
                        event.get("reason").map(String::as_str).unwrap_or("")
                    )
                };
                recorder.event("control", &text);
            }
        }
        if state == Some("engaged") {
            self.captions.focus(false); // the agent types now, in the app in front, not into the card
        }
        let fn_key = event.get("fn").map(String::as_str);
        if self.hands_free.get() && fn_key.is_some() {
            // fn + shift's dictation: the next press of fn (with shift or without) types it
            match fn_key {
                Some("down") => {
                    self.hands_free_ending.set(true);
                }
                Some("tap" | "up") if self.hands_free_ending.get() => self.finish_dictation(),
                _ => {} // letting go of the fn + shift that started it; shift itself
            }
            return;
        }
        match fn_key {
            Some("down") => {
                self.start_dictation();
                if self.host.shift_held() {
                    self.dictate_hands_free(); // shift, then fn
                }
            }
            Some("other") if self.holding() && self.host.shift_held() => {
                self.dictate_hands_free(); // fn, then shift
            }
            Some("tap") => {
                self.drop_dictation();
                if self.paused_by_you() {
                    self.resume_control();
                } else {
                    self.set_listening(!self.listening.get());
                }
            }
            Some("other") => {
                // fn+arrow, fn+delete, ...: a shortcut
                self.drop_dictation();
                self.ears_listen(self.listening.get());
            }
            Some("up") => self.finish_dictation(),
            _ if state == Some("engaged") && self.mac_task_running() => {
                if self.pause_announced.get() {
                    self.out("▶️  continuing");
                }
                self.paused_since.set(0.0);
                self.pause_announced.set(false);
                self.captions.paused("");
            }
            _ if state == Some("disengaged")
                && took_over(event.get("reason").map(String::as_str))
                && self.paused_since.get() == 0.0 =>
            {
                // You have the mouse and keyboard. The task keeps working on what doesn't need the
                // screen (the shell, files, APIs); its screen actions wait until you press fn.
                self.paused_since.set(now());
                if self.mac_task_running() {
                    self.captions.paused(TOOK_OVER);
                }
            }
            _ => {}
        }
    }

    // -- dictation: hold fn --

    /// fn went down. Until it's let go, what you say is dictation (dropped if it was a tap).
    /// What you were saying to the agent before ends here, and goes to the agent.
    pub fn start_dictation(&self) {
        let held = Arc::new(Dictation::new());
        self.held.set(Some(held.clone()));
        let events = Mutex::new(self.events.clone());
        self.ears.cut(Some(Box::new(move || {
            let _ = events
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .send(Event::Route(Some(held)));
        })));
        self.ears_listen(true);
    }

    /// fn + shift: dictation only (Parakeet, as when you hold fn), and it goes on after you let
    /// go, so you can say a lot without holding a key. Press fn again and it's typed.
    pub fn dictate_hands_free(&self) {
        let Some(held) = self.held.get() else {
            return;
        };
        self.hands_free.set(true);
        self.hands_free_ending.set(false);
        self.captions.hands_free(true);
        self.show_dictating(&held, true);
        self.out("✍️  dictating until you press fn (fn + shift)");
    }

    pub fn drop_dictation(&self) {
        self.end_hands_free();
        if let Some(held) = self.held.set(None) {
            held.state().dropped = true;
            let events = Mutex::new(self.events.clone());
            self.ears.cut(Some(Box::new(move || {
                let _ = events
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .send(Event::Route(None));
            })));
            self.show_dictating(&held, false);
        }
    }

    /// fn was let go after a hold: once the last of what you said is written down, it's typed.
    pub fn finish_dictation(&self) {
        self.end_hands_free();
        if let Some(held) = self.held.set(None) {
            let events = Mutex::new(self.events.clone());
            let dictated = held.clone();
            self.ears.cut(Some(Box::new(move || {
                let _ = events
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .send(Event::Dictated(dictated));
            })));
            self.ears_listen(self.listening.get());
            self.show_dictating(&held, false);
        }
    }

    fn end_hands_free(&self) {
        self.hands_free_ending.set(false);
        if self.hands_free.set(false) {
            self.captions.hands_free(false);
        }
    }

    pub fn show_dictating(&self, held: &Dictation, on: bool) {
        let changed = {
            let mut state = held.state();
            let changed = state.shown != on;
            state.shown = on;
            changed
        };
        if changed {
            self.captions.dictating(on);
            self.tell("dictating", if on { "1" } else { "0" });
        }
    }

    pub fn on_dictated(&self, text: &str, final_: bool) {
        let Some(dictation) = self.dictation.get() else {
            return;
        };
        if final_ {
            self.over_its_voice.set(false);
            if !text.is_empty() {
                dictation.state().words.push(text.to_owned());
            }
        }
        if !dictation.dropped() {
            self.captions
                .hearing(&dictation.text(if final_ { "" } else { text }));
        }
    }

    pub fn type_dictation(&self, dictation: &Dictation) {
        let text = dictation.text("");
        if dictation.dropped() || text.is_empty() {
            return;
        }
        let words = text.split_whitespace().count();
        let logged = if std::env::var("AGENT_JOURNAL_DICTATION").as_deref() == Ok("1") {
            text.as_str()
        } else {
            ""
        };
        self.log("dictation", logged, json!({"words": words}));
        self.out(&format!("✍️  typing what you dictated ({words} words)")); // not the words: they're yours
        self.spawn("dictation", move |me| {
            if let Some(error) = me.host.paste(&text) {
                me.out(&format!(
                    "   couldn't type it ({error}); it's on the clipboard, so ⌘V pastes it"
                ));
                me.host.notify(
                    "Couldn't type what you dictated. It's on the clipboard: ⌘V pastes it.",
                    "Agent",
                );
            }
        });
    }

    /// Prints a line. The words you're saying, if they're showing, make way and come back with
    /// the next ones.
    pub fn out(&self, text: &str) {
        if self.live_shown.set(false) {
            self.console.raw("\r\x1b[K");
        }
        self.console.line(text);
        if let Some(recorder) = self.recorder.get() {
            if !text.trim_start().starts_with('🎞') {
                recorder.event("hive", text);
            }
        }
    }

    pub fn show_live(&self, text: &str) {
        if self.live.get() {
            let width = self.console.columns().saturating_sub(5);
            let count = text.chars().count();
            let text = if count > width {
                let keep = width.saturating_sub(1);
                format!("…{}", text.chars().skip(count - keep).collect::<String>())
            } else {
                text.to_owned()
            };
            self.console.raw(&format!("\r\x1b[K🎙  {text}"));
            self.live_shown.set(true);
        } else if !self.app.get() {
            // (the app's log gets only the whole of it)
            self.console.line(&format!("🎙  {text}"));
        }
    }

    pub fn on_ignored(&self, seconds: f64, similarity: f64) {
        let own = self.ears.heard_machine();
        self.log(
            "voice left out",
            if own {
                "its own voice"
            } else {
                "not your voice"
            },
            json!({"seconds": round(seconds, 2), "similarity": round(similarity, 3)}),
        );
        let note = if own {
            format!("(its own voice, ignored: {seconds:.1} s)")
        } else {
            format!("(not your voice, ignored: {seconds:.1} s, {similarity:.2} like yours)")
        };
        if self.live.get() {
            // on the line your words show on, so a TV or people chatting don't fill the screen
            self.console
                .raw(&format!("\r\x1b[K\x1b[2m   {note}\x1b[0m"));
            self.live_shown.set(true);
        } else {
            self.out(&format!("   {note}"));
        }
    }

    /// times: when you stopped talking, it decided you'd finished and it had written it down.
    pub fn on_heard(&self, text: &str, final_: bool, times: Option<&BTreeMap<String, f64>>) {
        if self.dictation.lock().is_some() {
            self.on_dictated(text, final_);
            return;
        }
        if !self.listening.get() || self.discard_heard.get() {
            return;
        }
        self.captions.hearing(text);
        if !final_ {
            self.show_live(text);
            return;
        }
        if self.live_shown.set(false) {
            self.console.raw("\r\x1b[K");
        }
        self.on_transcript(text, times, false, false, None);
    }

    fn channel(&self, typed: bool) -> &'static str {
        if typed {
            "typed"
        } else if self.input_mode.get() == "lips" {
            "lip"
        } else {
            "voice"
        }
    }

    pub fn on_transcript(
        &self,
        text: &str,
        times: Option<&BTreeMap<String, f64>>,
        typed: bool,
        captured: bool,
        ingress_receipt: Option<String>,
    ) {
        let from_agent = ingress_receipt.is_some(); // it came through the request socket, not from you
        let mut ingress_receipt = ingress_receipt;
        let ahead = self.ahead.set(None);
        self.timing.set(None);
        let words = util::said_words(text);
        let over_its_voice = self.over_its_voice.set(false);
        let heard: Map<String, Value> = times
            .map(|t| {
                t.iter()
                    .map(|(k, v)| (k.clone(), json!(round(*v, 3))))
                    .collect()
            })
            .unwrap_or_default();
        if words.is_empty() {
            return;
        }
        if FILLERS.contains(&words.as_str()) {
            if !captured {
                let saved = self
                    .host
                    .admit(text, self.channel(typed))
                    .and_then(|r| self.host.finish(&r, "accepted"));
                if let Err(error) = saved {
                    self.out(&format!("Could not save the message: {error}"));
                }
            }
            self.log("you said", text, json!({"outcome": "filler, ignored"}));
            return; // a cough, a click, an "mm-hmm"
        }
        let just_spoke = over_its_voice
            || self
                .voice
                .as_ref()
                .is_some_and(|v| v.quiet_for() < JUST_SPOKE);
        if !typed && just_spoke && self.its_own_words(&words) {
            self.log(
                "you said",
                text,
                json!({"outcome": "its own voice, ignored"}),
            );
            self.out(&format!("   (heard its own voice: {text})"));
            return;
        }
        // An explicit stop is executed immediately, even if the receipt store is unavailable.
        // All other UI instructions are durably admitted first.
        let cancel = CANCEL.contains(&words.as_str());
        let mut owned_receipt = None;
        if !captured && !cancel {
            match self.host.admit(text, self.channel(typed)) {
                Ok(receipt) => {
                    owned_receipt = Some(receipt.clone());
                    ingress_receipt = Some(receipt);
                }
                Err(error) => {
                    self.out(&format!(
                        "Could not save the request; it was not started: {error}"
                    ));
                    return;
                }
            }
        }
        self.out(&format!("🗣  {text}"));

        if let Some(voice) = &self.voice {
            voice.stop(); // whatever it was saying is old news
        }
        self.captions.say("");
        self.captions.thinking("");
        if cancel {
            let tasks = self.tasks.get();
            let running: Vec<&str> = tasks
                .items()
                .iter()
                .filter(|(_, t)| t.as_ref().is_some_and(|t| t.running()))
                .map(|(d, _)| *d)
                .collect();
            self.log(
                "you said",
                text,
                json!({"outcome": "stop", "stopped": running}),
            );
            for device in &running {
                if let Some(task) = tasks.get(device) {
                    task.stop();
                }
                self.tasks.lock().set(device, None);
                self.doing.lock().retain(|(d, _)| d != device);
            }
            // A provider wait may have been durably armed while this process had no in-memory
            // task. A stop also fences that pending recovery.
            let fenced = (|| -> Result<(), String> {
                if let Some(saved) = self.backend.recovery_current()? {
                    let id = saved
                        .get("id")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_owned();
                    if saved.get("status") == Some(&json!("active"))
                        && self.backend.provider_status(&id)?.as_deref() == Some("waiting")
                    {
                        self.backend.recovery_finish(&id, "stopped")?;
                    }
                }
                Ok(())
            })();
            if let Err(error) = fenced {
                self.out(&format!("Could not save the stop fence: {error}"));
            }
            if !running.is_empty() {
                if running.contains(&"mac") {
                    self.hand_back();
                }
                self.show_doing();
                let any = self.tasks.lock().any();
                self.captions.active(any);
                self.say("Stopped.", None, None);
            }
            if !captured {
                let saved = self
                    .host
                    .admit(text, if typed { "typed" } else { "voice" })
                    .and_then(|r| self.host.finish(&r, "accepted"));
                if let Err(error) = saved {
                    self.out(&format!("Stopped, but could not save its receipt: {error}"));
                }
            }
            return;
        }
        let carry_on = CONTINUE.contains(&words.as_str());
        if carry_on && env_set("AGENT_SPACEO_COMMAND") {
            self.tell("workspace-resume", "1");
        }
        if carry_on && self.mac_task_running() {
            self.log("you said", text, json!({"outcome": "continue"}));
            self.save_recovery("active", "Could not save the resume state");
            if !env_set("AGENT_SPACEO_COMMAND") {
                self.take_control(); // it carries on from where things are now
            }
            if let Some(receipt) = owned_receipt {
                self.finish_ui_receipt(&receipt);
            }
            return;
        }

        let device = self.backend.focus(&words);
        let said = text.to_owned();
        let mut text = text.to_owned();
        let mut joined = false;
        let mut previous: Option<String> = None;
        let running = self.tasks.lock().get(&device).filter(|t| t.running());
        if let Some(task) = running {
            // a new request for the same device replaces the old one
            task.stop();
            if now() - task.started_at() < FOLLOW_UP {
                // you paused, then carried on
                text = format!("{} {text}", task.task());
                joined = true;
                self.out("   (adding that to what you just asked)");
            } else {
                previous = Some(task.task());
                self.out("   (interrupted the previous task)");
            }
        }
        if device == "mac" {
            self.paused_since.set(0.0);
            self.pause_announced.set(false);
        }
        self.last_said.lock().insert(device.clone(), String::new());
        let task = self
            .backend
            .task(&text, previous.as_deref(), &device, ahead);
        self.tasks.lock().set(&device, Some(task.clone()));
        task.set_receipt_id(ingress_receipt);
        self.captions.active(true);
        self.captions.activity(&if from_agent {
            format!("Request from another agent: {}", shortened(&said, 240))
        } else {
            format!("Request: {said}")
        });
        self.timing.set(Some(Timing::new(task.clone(), times)));
        task.set_on_event(self.task_events(&task));
        self.log(
            "you said",
            &said,
            json!({"outcome": "request", "heard": if heard.is_empty() { Value::Null } else { Value::Object(heard) }}),
        );
        self.log(
            "request",
            &text,
            json!({"device": device, "interrupted": previous, "added_to_last": if joined { json!(true) } else { Value::Null }}),
        );
        self.host.notify(
            &if from_agent {
                shortened(&text, 160)
            } else {
                text.clone()
            },
            "On it",
        );
        task.start(true);
        if let Some(receipt) = owned_receipt {
            self.finish_ui_receipt(&receipt);
        }
        if device == "mac"
            && !(env_set("AGENT_WORKSPACE_CONNECTION") || env_set("AGENT_SPACEO_COMMAND"))
        {
            self.prepare_screen(); // the task takes the mouse and keyboard only when it uses the screen
        }
    }

    pub fn finish_ui_receipt(&self, receipt: &str) {
        if let Err(error) = self.host.finish(receipt, "accepted") {
            self.out(&format!(
                "Request started, but receipt status is unknown: {error}"
            ));
        }
    }

    /// Asks where Hive should work (your screen or the virtual monitor) and sets that up. No
    /// answer keeps the last choice; the Mac tools use your screen whenever the monitor is off.
    pub fn start_virtual_monitor(&self) {
        let override_ = std::env::var("HIVE_VIRTUAL_MONITOR").ok();
        if !matches!(override_.as_deref(), Some("0" | "1"))
            && std::env::var("HIVE_ASK_WORK_SCREEN").unwrap_or_else(|_| "1".into()) != "0"
        {
            self.host.ask_work_screen();
        }
        if self.host.virtual_monitor_enabled() {
            if !self.host.ensure_virtual_monitor() {
                self.out("   ✗ The virtual monitor did not start; working on your screen.");
            }
        } else {
            self.host.virtual_monitor_off();
        }
        self.out(&format!(
            "Working on {}",
            if self.host.virtual_monitor_on() {
                "the virtual monitor."
            } else {
                "your screen, with your mouse and keyboard."
            }
        ));
    }

    pub fn prepare_screen(&self) {
        self.host.ensure_virtual_monitor();
        let here = self.host.cursor();
        if !self.host.on_virtual_monitor(here.0, here.1) {
            self.cursor_home.set(Some(here)); // where your cursor goes back to when the task ends
        }
    }

    /// You handed the screen back (fn, or "continue"): the agent has the mouse and keyboard again,
    /// and lets go of them if it doesn't use them for a while (the Mac tools' `handed_back`).
    pub fn take_control(&self) {
        self.prepare_screen();
        if let Err(e) = self.mac.engage() {
            // the helper still waits for your hands to be off
            self.out(&format!("   couldn't take control: {e}"));
        }
        if let Some(task) = self.task() {
            task.handed_back();
        }
    }

    pub fn on_task_event(&self, task: &Arc<dyn Task>, kind: &str, text: &str) {
        if kind == "context" {
            self.tell("context", text);
            return;
        }
        let device = task.device();
        let current = self
            .tasks
            .lock()
            .get(&device)
            .is_some_and(|t| same(&t, task));
        if !matches!(kind, "doing" | "data" | "plan_delta") {
            self.log(
                kind,
                text,
                json!({"device": device, "request": task.task(), "thread": task.thread_id(),
                       "interrupted": if current { Value::Null } else { json!(true) }}),
            );
        }
        if !current {
            return; // from a task that was interrupted
        }
        let mark = if device == "phone" { "📱 " } else { "" };
        match kind {
            "doing" => {
                {
                    let mut doing = self.doing.lock();
                    match doing.iter_mut().find(|(d, _)| *d == device) {
                        Some(entry) => entry.1 = text.to_owned(),
                        None => doing.push((device.clone(), text.to_owned())),
                    }
                }
                self.show_doing();
                if let Some(recorder) = self.recorder.get() {
                    recorder.event("status", &format!("{mark}{text}"));
                }
            }
            "action" => {
                self.out(&format!("   → {mark}{text}"));
                self.captions.activity(&format!("Tool: {mark}{text}"));
            }
            "think" | "plan" | "plan_delta" => {
                self.captions.thinking(util::head(text, 600));
                if kind == "plan" {
                    self.captions.activity(&format!("Plan: {text}"));
                }
            }
            "data" => self.captions.activity(text),
            "error" => self.out(&format!("   ✗ {mark}{text}")),
            "say" => {
                // its reply, a sentence or so at a time as Codex writes it
                self.out(&format!("   💬 {mark}{text}"));
                self.say(text, Some(&device), Some(task));
            }
            "announce" => {
                // a step that can't be undone (a send, a delete), said as it happens
                self.out(&format!("   ⚠️  {mark}{text}"));
                self.captions
                    .activity(&format!("One-way step: {mark}{text}"));
                let replied = self.last_said.lock().get(&device).cloned();
                self.say(text, Some(&device), None);
                let mut last_said = self.last_said.lock();
                match replied {
                    // not its reply: that's still said when it's done
                    Some(replied) => last_said.insert(device.clone(), replied),
                    None => last_said.remove(&device),
                };
            }
            "done" | "failed" => {
                self.tasks.lock().set(&device, None);
                let any = self.tasks.lock().any();
                self.captions.active(any);
                self.captions.activity(&if kind == "done" {
                    "Finished".to_owned()
                } else {
                    format!("Stopped: {text}")
                });
                if device == "mac" {
                    self.captions.paused("");
                    self.paused_since.set(0.0);
                    self.pause_announced.set(false);
                }
                self.doing.lock().retain(|(d, _)| *d != device);
                self.show_doing();
                if kind == "done" {
                    self.out(&format!("✅ {mark}done in {:.0} s\n", task.elapsed()));
                    if device == "mac" {
                        self.hand_back();
                    }
                    self.host.notify(text, "Done");
                    let said = self
                        .last_said
                        .lock()
                        .get(&device)
                        .is_some_and(|s| !s.is_empty());
                    if !said {
                        // (it has said its reply as it came)
                        self.say(text, Some(&device), Some(task));
                    }
                } else if text != "stopped" && task.final_text().as_deref() == Some(text) {
                    // It stopped on purpose and said why: often a step it won't take without you (a
                    // send, a delete). Its words are the answer, not an error.
                    self.out(&format!("✋ {mark}{text}\n"));
                    if device == "mac" {
                        self.hand_back();
                    }
                    self.host.notify(text, "Needs you");
                    let said = self
                        .last_said
                        .lock()
                        .get(&device)
                        .is_some_and(|s| !s.is_empty());
                    if !said {
                        self.say(text, Some(&device), Some(task));
                    }
                } else if text != "stopped" {
                    self.out(&format!("❌ {mark}{text}\n"));
                    if device == "mac" {
                        self.hand_back();
                    }
                    self.say("Sorry, that didn't work.", None, None);
                }
                if !self.tasks.lock().any() {
                    self.apply_scheduled_update();
                }
            }
            _ => {}
        }
    }

    /// Runs a prepared update outside this process only after every turn has finished.
    pub fn apply_scheduled_update(&self) {
        let state = hive_common::state_dir();
        let mut marker = state.join("updates").join("update-pending");
        if !marker.exists() {
            marker = state.join("update-pending"); // finish a handoff from an older version
        }
        if !marker.exists() {
            return;
        }
        let claimed: PathBuf = marker.with_file_name("update-applying");
        let started = std::fs::rename(&marker, &claimed)
            .map_err(|e| hive_knowledge::util::os_error(&e, &marker))
            .and_then(|()| {
                self.host
                    .start_update(&state.join("update.log"))
                    .map_err(|e| e.to_string())
            });
        match started {
            Ok(()) => self.out(
                "Installing the prepared update; the conversation will be available after restart.",
            ),
            Err(error) => {
                if claimed.exists() {
                    let _ = std::fs::rename(&claimed, &marker);
                }
                self.out(&format!("Could not start the update: {error}"));
            }
        }
    }

    /// The captions' small line: what each running task is doing ("Thinking", "Typing ...").
    pub fn show_doing(&self) {
        let doing = self
            .doing
            .lock()
            .iter()
            .filter(|(_, text)| !text.is_empty())
            .map(|(device, text)| format!("{}{text}", if device == "phone" { "📱 " } else { "" }))
            .collect::<Vec<_>>()
            .join("   ·   ");
        self.captions.doing(&doing);
        self.tell("status", if doing.is_empty() { "Ready" } else { &doing });
    }

    pub fn hand_back(&self) {
        if self.mac.disengage().is_ok() {
            let _ = self.mac.release_all();
        }
        // your cursor returns from the virtual monitor to where it was on your screen
        if let Some(home) = self.cursor_home.set(None) {
            let here = self.host.cursor();
            if self.host.on_virtual_monitor(here.0, here.1) {
                self.host.warp(home.0, home.1);
            }
        }
    }

    /// task: it's what that task says (the first of it ends the request's timing).
    pub fn say(&self, text: &str, device: Option<&str>, task: Option<&Arc<dyn Task>>) {
        self.last_said
            .lock()
            .insert(device.unwrap_or("").to_owned(), text.trim().to_owned());
        if text.is_empty() {
            return;
        }
        let will_speak =
            self.voice.is_some() && self.speaking.get() && util::workspace_voice_allowed();
        let shown = {
            let mut timing = self.timing.lock();
            match (task, timing.as_mut()) {
                (Some(task), Some(t)) if same(&t.task, task) && !t.queued => {
                    t.queued = true;
                    if !will_speak {
                        // shown, not said
                        t.answered = Some(monotonic());
                        Some(t.clone())
                    } else {
                        None
                    }
                }
                _ => None,
            }
        };
        if let Some(timing) = shown {
            self.out(&describe_timing(&timing));
        }
        if task.is_none() {
            // (what a task says is saved with the task's events)
            self.log(
                "agent said",
                text,
                json!({"device": device, "spoken": will_speak}),
            );
        }
        match self.voice.as_ref().filter(|_| will_speak) {
            Some(voice) => {
                let t = now();
                {
                    let mut said = self.said.lock();
                    said.retain(|(when, _)| t - when < 30.0);
                    said.push((t, text.to_owned()));
                }
                voice.say(&spoken(text)); // the captions show each sentence as it's spoken
            }
            None => self.captions.say(&spoken(text)),
        }
    }

    pub fn shutdown(&self) {
        self.stopped.set(true);
        if let Some(workspace) = self.embedded_workspace.set(None) {
            workspace.close();
        }
        if let Some(requests) = self.local_requests.set(None) {
            requests.close();
        }
        let state = hive_common::state_dir();
        let maintenance = state.join("updates").join("update-applying").exists()
            || state.join("update-applying").exists();
        for (_, task) in self.tasks.get().items() {
            if let Some(task) = task.filter(|t| t.running()) {
                if maintenance {
                    task.stop_for_maintenance();
                } else {
                    task.stop();
                }
            }
        }
        if let Some(voice) = &self.voice {
            voice.stop();
        }
        self.hand_back();
        self.captions.close();
        if let Some(lips) = self.lips.get() {
            lips.close(); // the camera, if on, turns off
        }
        if let Some(journal) = self.journal.set(None) {
            journal.end();
            session_journal::set_current(None);
        }
        if let Some(mut watcher) = self.watcher.set(None) {
            watcher.stop();
        }
    }
}
