//! The voice sidecar: python/sidecar_voice.py runs listen.py's `Ears` (the microphone with mic.py's
//! echo canceller, Silero VAD, Parakeet), voiceprint.py's `Voiceprint` (WeSpeaker) and speech.py's
//! `Voice` (Kokoro, or `say`) in one Python process, and this talks to it over JSON lines (the
//! protocol is in the sidecar's docstring and hive-sidecars-api.md).
//!
//! [`VoiceSidecar::start`] starts it; [`Ears`], [`Voice`] and [`Voiceprint`] are cheap handles on it
//! named after the Python objects voice_agent.py used. Two of voice_agent.py's rules run inside the
//! sidecar, next to what they ask about: `deaf` (the microphone is ignored while its own voice is
//! audible, the echo canceller can't hear the Mac and the sound comes out of speakers) and
//! `may_speak` (a sentence doesn't start while you're talking). [`VoiceSidecar::deaf`] and
//! [`VoiceSidecar::may_speak`] give the same answers from what the sidecar last reported.
//!
//! Threads: one reads the sidecar's events and keeps the state the getters return up to date at
//! once; another runs the callbacks (on_text, on_speech, on_ignored, on_play, cut's `then`) one at a
//! time, in the order the sidecar sent them, as listen.py and speech.py called them from their own
//! threads. A callback may call anything here, including the blocking `describe()`s.

use crate::process::{exit_code, guarded, reap, write_line};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, HashMap};
use std::ffi::OsString;
use std::io::{self, BufRead, BufReader};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

/// speech.py's ECHO: seconds the room keeps echoing after a sentence (the sidecar's hello says it).
pub const ECHO: f64 = 0.3;

type TextFn = Arc<dyn Fn(&str, bool) + Send + Sync>;
type SpeechFn = Arc<dyn Fn() + Send + Sync>;
type IgnoredFn = Arc<dyn Fn(f64, f64) + Send + Sync>;
type PlayFn = Arc<dyn Fn(&str) + Send + Sync>;
type LogFn = Arc<dyn Fn(&str) + Send + Sync>;
type Then = Box<dyn FnOnce() + Send>;

/// How to start the sidecar. The defaults are listen.Ears' and speech.Voice's; voice_agent.py
/// started it with `listening: false`.
pub struct VoiceOptions {
    /// The program and its arguments: `.venv/bin/python python/sidecar_voice.py` (tests use a fake).
    pub command: Vec<OsString>,
    /// With a voice (False: `--no-speak`, there is no [`Voice`]).
    pub speak: bool,
    /// With the enrolled voiceprint (models/voiceprint.npz), so other voices are left out.
    pub voiceprint: bool,
    /// Listening from the start (Ears' `listening`).
    pub listening: bool,
    /// Where the lines the model code prints go: Agent.log (stdout) by default.
    pub log: LogFn,
    /// How long [`VoiceSidecar::start`] waits for the sidecar to be ready (its imports).
    pub ready_timeout: Duration,
}

impl Default for VoiceOptions {
    fn default() -> Self {
        VoiceOptions {
            command: default_command(),
            speak: true,
            voiceprint: true,
            listening: true,
            log: Arc::new(|line: &str| hive_common::say(line)),
            ready_timeout: Duration::from_secs(120),
        }
    }
}

/// `<repo>/.venv/bin/python <repo>/python/sidecar_voice.py`.
pub fn default_command() -> Vec<OsString> {
    vec![
        hive_common::paths::sidecar_python().into_os_string(),
        hive_common::python_dir()
            .join("sidecar_voice.py")
            .into_os_string(),
    ]
}

/// The microphone as the sidecar last reported it (mic.py's `Microphone`).
#[derive(Clone, Debug, PartialEq)]
pub struct Microphone {
    /// The microphone's name ("" until it has opened one).
    pub name: String,
    pub error: Option<String>,
    pub tap_error: Option<String>,
    pub canceller_error: Option<String>,
    description: String,
}

impl Microphone {
    /// "on (it takes what the Mac plays out of what it hears)", or "off (why)".
    pub fn describe(&self) -> String {
        self.description.clone()
    }
}

#[derive(Default)]
struct Callbacks {
    on_text: Option<TextFn>,
    on_speech: Option<SpeechFn>,
    on_ignored: Option<IgnoredFn>,
    on_play: Option<PlayFn>,
}

struct Status {
    mic_level: f64,
    hears_the_mac_for: f64,
    microphone: Option<Microphone>,
    at: Instant,
}

struct State {
    hello: Option<Value>,
    listening: bool,
    talking: bool,
    status: Option<Status>,
    heard_times: BTreeMap<String, Instant>,
    heard_machine: bool,
    playing: bool,
    quiet_since: Option<Instant>,
    pending: usize,
    ears_model: bool,
    ears_error: Option<String>,
    replies: HashMap<u64, Value>,
    thens: BTreeMap<u64, Then>,
    exited: Option<String>,
}

struct Inner {
    stdin: Mutex<Option<ChildStdin>>,
    child: Mutex<Option<Child>>,
    state: Mutex<State>,
    changed: Condvar,
    callbacks: Mutex<Callbacks>,
    next_id: AtomicU64,
    closing: AtomicBool,
    speak: bool,
    voiceprint: bool,
    log: LogFn,
}

enum Dispatch {
    Text {
        text: String,
        final_: bool,
        times: Option<BTreeMap<String, Instant>>,
    },
    Speech,
    Ignored {
        seconds: f64,
        similarity: f64,
        heard_machine: bool,
    },
    Then(u64),
    Play(String),
    Closed,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl Inner {
    fn state(&self) -> MutexGuard<'_, State> {
        lock(&self.state)
    }

    fn id(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::Relaxed)
    }

    /// One command to the sidecar; false if it isn't running.
    fn send(&self, message: Value) -> bool {
        let mut stdin = lock(&self.stdin);
        let Some(pipe) = stdin.as_mut() else {
            return false;
        };
        if write_line(pipe, &message).is_err() {
            *stdin = None;
            return false;
        }
        true
    }

    fn stopped(&self) -> String {
        self.state()
            .exited
            .clone()
            .unwrap_or_else(|| "the voice sidecar isn't running".into())
    }

    /// A command with an id, and its reply (Err: the reply's error, or the sidecar stopped).
    fn request(&self, cmd: &str, mut fields: Map<String, Value>) -> Result<Value, String> {
        let id = self.id();
        fields.insert("cmd".into(), cmd.into());
        fields.insert("id".into(), id.into());
        if !self.send(Value::Object(fields)) {
            return Err(self.stopped());
        }
        let mut state = self.state();
        loop {
            if let Some(reply) = state.replies.remove(&id) {
                return match reply.get("error") {
                    Some(error) if !error.is_null() => Err(text_of(error)),
                    _ => Ok(reply),
                };
            }
            if let Some(exited) = &state.exited {
                return Err(exited.clone());
            }
            state = self.changed.wait(state).unwrap_or_else(|e| e.into_inner());
        }
    }

    fn describe(&self, what: &str) -> Result<Value, String> {
        let mut fields = Map::new();
        fields.insert("what".into(), what.into());
        self.request("describe", fields)
    }

    fn close(&self) {
        self.closing.store(true, Ordering::SeqCst);
        self.send(json!({"cmd": "quit"}));
        lock(&self.stdin).take(); // the end of its input: it stops talking and exits
        let child = lock(&self.child).take();
        if let Some(mut child) = child {
            reap(&mut child, Duration::from_secs(3));
        }
    }
}

fn text_of(value: &Value) -> String {
    value
        .as_str()
        .map(str::to_string)
        .unwrap_or_else(|| value.to_string())
}

fn opt_text(value: &Value) -> Option<String> {
    (!value.is_null()).then(|| text_of(value))
}

/// `now - seconds`, for the sidecar's "this long ago".
fn ago(now: Instant, seconds: f64) -> Instant {
    let seconds = if seconds.is_finite() {
        seconds.max(0.0)
    } else {
        0.0
    };
    now.checked_sub(Duration::from_secs_f64(seconds))
        .unwrap_or(now)
}

/// The running voice sidecar. Dropping it stops the sidecar (it stops talking and exits).
pub struct VoiceSidecar {
    inner: Arc<Inner>,
}

impl VoiceSidecar {
    /// Starts the sidecar and waits until its models' code is imported and Ears and Voice exist (as
    /// constructing them did in Python). The models themselves load in the background:
    /// [`Ears::describe`] and [`Voice::describe`] wait for them.
    pub fn start(options: VoiceOptions) -> io::Result<VoiceSidecar> {
        let (program, args) = options.command.split_first().ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "no command for the voice sidecar",
            )
        })?;
        let mut command = Command::new(program);
        command.args(args);
        if options.listening {
            command.arg("--listening");
        }
        if !options.speak {
            command.arg("--no-speak");
        }
        if !options.voiceprint {
            command.arg("--no-voiceprint");
        }
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());
        let mut child = command.spawn()?;
        let stdin = child.stdin.take();
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| io::Error::other("no stdout"))?;
        let inner = Arc::new(Inner {
            stdin: Mutex::new(stdin),
            child: Mutex::new(Some(child)),
            state: Mutex::new(State {
                hello: None,
                listening: options.listening,
                talking: false,
                status: None,
                heard_times: BTreeMap::new(),
                heard_machine: false,
                playing: false,
                quiet_since: None,
                pending: 0,
                ears_model: false,
                ears_error: None,
                replies: HashMap::new(),
                thens: BTreeMap::new(),
                exited: None,
            }),
            changed: Condvar::new(),
            callbacks: Mutex::new(Callbacks::default()),
            next_id: AtomicU64::new(1),
            closing: AtomicBool::new(false),
            speak: options.speak,
            voiceprint: options.voiceprint,
            log: options.log,
        });
        let (tx, rx) = channel();
        let reader = inner.clone();
        std::thread::Builder::new()
            .name("voice-sidecar-events".into())
            .spawn(move || read_events(reader, stdout, tx))?;
        let dispatcher = inner.clone();
        std::thread::Builder::new()
            .name("voice-sidecar-callbacks".into())
            .spawn(move || dispatch(dispatcher, rx))?;
        let deadline = Instant::now() + options.ready_timeout;
        let sidecar = VoiceSidecar { inner };
        let mut state = sidecar.inner.state();
        loop {
            if state.hello.is_some() {
                break;
            }
            if let Some(exited) = &state.exited {
                let error = io::Error::other(exited.clone());
                drop(state);
                return Err(error);
            }
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                drop(state);
                sidecar.close();
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "the voice sidecar didn't start",
                ));
            }
            state = sidecar
                .inner
                .changed
                .wait_timeout(state, left)
                .unwrap_or_else(|e| e.into_inner())
                .0;
        }
        drop(state);
        Ok(sidecar)
    }

    pub fn ears(&self) -> Ears {
        Ears {
            inner: self.inner.clone(),
        }
    }

    /// The voice; None when started without one (`--no-speak`).
    pub fn voice(&self) -> Option<Voice> {
        self.inner.speak.then(|| Voice {
            inner: self.inner.clone(),
        })
    }

    /// VoiceAgent.learn_its_voice: Kokoro renders a few sentences (nothing is played) and the
    /// voiceprint learns them as its own voice. Ok(false) when there's nothing to learn with (no
    /// Kokoro, no voiceprint model); Err is what the Python raised. Blocks for a few seconds.
    pub fn learn_its_voice(&self) -> Result<bool, String> {
        let reply = self.inner.request("learn_its_voice", Map::new())?;
        Ok(reply
            .get("learned")
            .and_then(Value::as_bool)
            .unwrap_or(false))
    }

    /// VoiceAgent.deaf, from what the sidecar last said (the sidecar applies it to every window).
    pub fn deaf(&self) -> bool {
        self.voice().is_some_and(|voice| voice.audible())
            && !self.ears().hears_the_mac()
            && crate::audio::output_is_speakers()
    }

    /// VoiceAgent.may_speak: not while you're talking (the sidecar asks it before each sentence).
    pub fn may_speak(&self) -> bool {
        !self.ears().talking()
    }

    /// Why the sidecar isn't running any more ("the voice sidecar stopped (exit 1)"), if it isn't.
    pub fn exited(&self) -> Option<String> {
        self.inner.state().exited.clone()
    }

    pub fn pid(&self) -> Option<u32> {
        self.inner
            .state()
            .hello
            .as_ref()
            .and_then(|h| h.get("pid"))
            .and_then(Value::as_u64)
            .map(|p| p as u32)
    }

    /// Stops it: its voice goes quiet, the microphone closes, the process exits (killed after 3 s).
    pub fn close(&self) {
        self.inner.close();
    }

    /// One command as is (for a stand-in sidecar's own commands: the tests').
    #[doc(hidden)]
    pub fn send_raw(&self, message: Value) -> bool {
        self.inner.send(message)
    }

    /// A command with an id, and its reply (for a stand-in sidecar's own commands: the tests').
    #[doc(hidden)]
    pub fn request_raw(&self, cmd: &str, fields: Map<String, Value>) -> Result<Value, String> {
        self.inner.request(cmd, fields)
    }
}

impl Drop for VoiceSidecar {
    fn drop(&mut self) {
        self.inner.close();
    }
}

/// listen.py's `Ears`: the microphone, Silero VAD and Parakeet, in the sidecar.
#[derive(Clone)]
pub struct Ears {
    inner: Arc<Inner>,
}

impl Ears {
    /// on_text(text, final), from the callback thread: with final false as the words come while you
    /// talk, then once with final true when you've finished (heard_times are set just before).
    pub fn set_on_text(&self, f: impl Fn(&str, bool) + Send + Sync + 'static) {
        lock(&self.inner.callbacks).on_text = Some(Arc::new(f));
    }

    /// on_speech(): you've talked long enough that it isn't a cough (~0.3 s), before any words.
    pub fn set_on_speech(&self, f: impl Fn() + Send + Sync + 'static) {
        lock(&self.inner.callbacks).on_speech = Some(Arc::new(f));
    }

    /// on_ignored(seconds, similarity): someone who isn't you talked (or its own voice: see
    /// [`Voiceprint::heard_machine`], set just before).
    pub fn set_on_ignored(&self, f: impl Fn(f64, f64) + Send + Sync + 'static) {
        lock(&self.inner.callbacks).on_ignored = Some(Arc::new(f));
    }

    /// "Parakeet (parakeet-tdt-0.6b-v2)", or "nothing (Parakeet: why)". Waits for Parakeet to load.
    pub fn describe(&self) -> String {
        match self.inner.describe("ears") {
            Ok(reply) => {
                let mut state = self.inner.state();
                state.ears_model = reply.get("model").and_then(Value::as_bool).unwrap_or(false);
                state.ears_error = reply.get("ears_error").and_then(opt_text);
                drop(state);
                reply.get("text").map(text_of).unwrap_or_default()
            }
            Err(error) => {
                self.inner.state().ears_error = Some(error.clone());
                format!("nothing (Parakeet: {error})")
            }
        }
    }

    /// Parakeet loaded (Python's `ears.model is not None`); known once [`Ears::describe`] returned.
    pub fn has_model(&self) -> bool {
        self.inner.state().ears_model
    }

    /// Why Parakeet (or Silero VAD) isn't working; known once [`Ears::describe`] returned.
    pub fn error(&self) -> Option<String> {
        self.inner.state().ears_error.clone()
    }

    /// Ears.listening: whether it's listening (the microphone is open).
    pub fn listening(&self) -> bool {
        self.inner.state().listening
    }

    /// listen(False) stops listening: what you were saying ends there, as if you'd paused, and the
    /// microphone closes until listen(True).
    pub fn listen(&self, on: bool) {
        {
            let mut state = self.inner.state();
            if state.listening == on {
                return;
            }
            state.listening = on;
        }
        self.inner.send(json!({"cmd": "listen", "on": on}));
    }

    /// What you're saying ends here, after what's already been heard, as if you'd paused.
    pub fn cut(&self) {
        self.inner.send(json!({"cmd": "cut", "then": null}));
    }

    /// cut(then=...): `then` runs on the callback thread after the cut's words (if any) went to
    /// on_text. If the sidecar stops first, it runs then (no more words will come).
    pub fn cut_then(&self, then: impl FnOnce() + Send + 'static) {
        let id = self.inner.id();
        {
            let mut state = self.inner.state();
            if state.exited.is_some() {
                drop(state);
                std::thread::spawn(move || guarded("cut's then", then));
                return;
            }
            state.thens.insert(id, Box::new(then));
        }
        self.inner.send(json!({"cmd": "cut", "then": id})); // (if this fails, the exit runs it)
    }

    /// In the middle of hearing you (Ears.talking).
    pub fn talking(&self) -> bool {
        self.inner.state().talking
    }

    /// The loudest sample so far; still 0 after a few seconds of listening means no microphone access.
    pub fn mic_level(&self) -> f64 {
        self.inner
            .state()
            .status
            .as_ref()
            .map_or(0.0, |s| s.mic_level)
    }

    /// For the latest final on_text: when you stopped talking ("stopped"), it decided you'd finished
    /// ("decided") and it had written it down ("written").
    pub fn heard_times(&self) -> BTreeMap<String, Instant> {
        self.inner.state().heard_times.clone()
    }

    /// The echo canceller is getting what the Mac plays, so the agent's voice won't be heard as you.
    /// False when the sidecar hasn't said so lately.
    pub fn hears_the_mac(&self) -> bool {
        self.inner
            .state()
            .status
            .as_ref()
            .is_some_and(|s| s.hears_the_mac_for > s.at.elapsed().as_secs_f64())
    }

    /// The microphone (mic.py's Microphone) as last reported; None until the first report.
    pub fn microphone(&self) -> Option<Microphone> {
        self.inner
            .state()
            .status
            .as_ref()
            .and_then(|s| s.microphone.clone())
    }

    pub fn mic_name(&self) -> String {
        self.microphone().map(|m| m.name).unwrap_or_default()
    }

    pub fn mic_error(&self) -> Option<String> {
        self.microphone().and_then(|m| m.error)
    }

    /// The voiceprint the ears check voices with; None when started without one.
    pub fn voiceprint(&self) -> Option<Voiceprint> {
        self.inner.voiceprint.then(|| Voiceprint {
            inner: self.inner.clone(),
        })
    }
}

/// speech.py's `Voice`: Kokoro (or `say`) and the player, in the sidecar.
#[derive(Clone)]
pub struct Voice {
    inner: Arc<Inner>,
}

impl Voice {
    /// on_play(words), from the callback thread: each sentence as it starts playing (for captions).
    pub fn set_on_play(&self, f: impl Fn(&str) + Send + Sync + 'static) {
        lock(&self.inner.callbacks).on_play = Some(Arc::new(f));
    }

    /// The voice's name: TTS_VOICE, "af_heart" by default, or "say".
    pub fn voice(&self) -> String {
        let state = self.inner.state();
        state
            .hello
            .as_ref()
            .and_then(|h| h.get("voice"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    }

    /// "Kokoro (af_heart)", or "the Mac's voice (Kokoro: why)". Waits (up to 30 s) for Kokoro.
    pub fn describe(&self) -> String {
        match self.inner.describe("voice") {
            Ok(reply) => reply.get("text").map(text_of).unwrap_or_default(),
            Err(error) => format!("no voice ({error})"),
        }
    }

    /// Says it, a sentence at a time, once may_speak (not while you're talking).
    pub fn say(&self, text: &str) {
        self.inner.state().pending += 1;
        if !self.inner.send(json!({"cmd": "say", "text": text})) {
            let mut state = self.inner.state();
            state.pending = state.pending.saturating_sub(1);
            self.inner.changed.notify_all();
        }
    }

    /// Stops talking at once and forgets anything it was about to say.
    pub fn stop(&self) {
        self.inner.send(json!({"cmd": "stop"}));
    }

    /// Speaking, or just finished and the room is still echoing.
    pub fn audible(&self) -> bool {
        let state = self.inner.state();
        state.playing
            || state
                .quiet_since
                .is_some_and(|t| t.elapsed().as_secs_f64() < echo(&state))
    }

    /// Seconds since it last spoke (0 while it's speaking; a lot if it never has).
    pub fn quiet_for(&self) -> f64 {
        let state = self.inner.state();
        if state.playing {
            return 0.0;
        }
        state.quiet_since.map_or(1e9, |t| t.elapsed().as_secs_f64())
    }

    /// Waits until everything said has played (or was stopped); false if `timeout` came first.
    pub fn wait(&self, timeout: Option<Duration>) -> bool {
        let deadline = timeout.map(|t| Instant::now() + t);
        let mut state = self.inner.state();
        while state.pending > 0 {
            state = match deadline {
                None => self
                    .inner
                    .changed
                    .wait(state)
                    .unwrap_or_else(|e| e.into_inner()),
                Some(deadline) => {
                    let left = deadline.saturating_duration_since(Instant::now());
                    if left.is_zero() {
                        return false;
                    }
                    self.inner
                        .changed
                        .wait_timeout(state, left)
                        .unwrap_or_else(|e| e.into_inner())
                        .0
                }
            };
        }
        true
    }
}

fn echo(state: &State) -> f64 {
    state
        .hello
        .as_ref()
        .and_then(|h| h.get("echo"))
        .and_then(Value::as_f64)
        .unwrap_or(ECHO)
}

/// voiceprint.py's `Voiceprint`, in the sidecar.
#[derive(Clone)]
pub struct Voiceprint {
    inner: Arc<Inner>,
}

impl Voiceprint {
    /// "on (your voice, VOICE_MATCH 0.4)", or "off (why)". Loads the model the first time.
    pub fn describe(&self) -> String {
        match self.inner.describe("voiceprint") {
            Ok(reply) => reply.get("text").map(text_of).unwrap_or_default(),
            Err(error) => format!("off ({error})"),
        }
    }

    /// The last thing left out was the agent's own voice (as of the latest on_ignored).
    pub fn heard_machine(&self) -> bool {
        self.inner.state().heard_machine
    }
}

fn read_events(inner: Arc<Inner>, stdout: ChildStdout, tx: Sender<Dispatch>) {
    let mut lines = BufReader::new(stdout);
    let mut line = String::new();
    loop {
        line.clear();
        match lines.read_line(&mut line) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        let now = Instant::now();
        let event: Value = match serde_json::from_str(line.trim_end()) {
            Ok(Value::Object(event)) => Value::Object(event),
            _ => {
                (inner.log)(line.trim_end());
                continue;
            }
        };
        let kind = event.get("event").and_then(Value::as_str).unwrap_or("");
        let field = |key: &str| event.get(key).cloned().unwrap_or(Value::Null);
        let number = |key: &str| event.get(key).and_then(Value::as_f64).unwrap_or(0.0);
        let flag = |key: &str| event.get(key).and_then(Value::as_bool).unwrap_or(false);
        let mut state = inner.state();
        let dispatch = match kind {
            "hello" => {
                state.hello = Some(event.clone());
                inner.changed.notify_all();
                None
            }
            "text" => {
                let final_ = flag("final");
                let times = final_.then(|| {
                    event
                        .get("heard_times")
                        .and_then(Value::as_object)
                        .map(|times| {
                            times
                                .iter()
                                .filter_map(|(k, v)| Some((k.clone(), ago(now, v.as_f64()?))))
                                .collect()
                        })
                        .unwrap_or_default()
                });
                Some(Dispatch::Text {
                    text: text_of(&field("text")),
                    final_,
                    times,
                })
            }
            "speech" => Some(Dispatch::Speech),
            "ignored" => Some(Dispatch::Ignored {
                seconds: number("seconds"),
                similarity: number("similarity"),
                heard_machine: flag("heard_machine"),
            }),
            "then" => event.get("id").and_then(Value::as_u64).map(Dispatch::Then),
            "talking" => {
                state.talking = flag("on");
                None
            }
            "play" => {
                state.playing = true;
                Some(Dispatch::Play(text_of(&field("words"))))
            }
            "played" => {
                state.playing = false;
                state.quiet_since = Some(now);
                None
            }
            "done" => {
                state.pending = state.pending.saturating_sub(1);
                inner.changed.notify_all();
                None
            }
            "status" => {
                let microphone =
                    event
                        .get("microphone")
                        .and_then(Value::as_object)
                        .map(|m| Microphone {
                            name: m
                                .get("name")
                                .and_then(Value::as_str)
                                .unwrap_or("")
                                .to_string(),
                            error: m.get("error").and_then(opt_text),
                            tap_error: m.get("tap_error").and_then(opt_text),
                            canceller_error: m.get("canceller_error").and_then(opt_text),
                            description: m
                                .get("describe")
                                .and_then(Value::as_str)
                                .unwrap_or("")
                                .to_string(),
                        });
                state.status = Some(Status {
                    mic_level: number("mic_level"),
                    hears_the_mac_for: number("hears_the_mac_for"),
                    microphone,
                    at: now,
                });
                None
            }
            "reply" => {
                if let Some(id) = event.get("id").and_then(Value::as_u64) {
                    state.replies.insert(id, event.clone());
                    inner.changed.notify_all();
                }
                None
            }
            "log" => {
                drop(state);
                (inner.log)(&text_of(&field("line")));
                continue;
            }
            "error" => {
                drop(state);
                (inner.log)(&format!("   ✗ voice sidecar: {}", text_of(&field("error"))));
                continue;
            }
            _ => None,
        };
        drop(state);
        if let Some(dispatch) = dispatch {
            let _ = tx.send(dispatch);
        }
    }
    // Its output ended: it exited (or is about to).
    let status = lock(&inner.child)
        .as_mut()
        .and_then(|child| reap(child, Duration::from_secs(5)));
    let why = match status {
        Some(status) => format!("the voice sidecar stopped (exit {})", exit_code(status)),
        None => "the voice sidecar stopped".to_string(),
    };
    {
        let mut state = inner.state();
        state.exited = Some(why.clone());
        state.playing = false;
        state.pending = 0;
        inner.changed.notify_all();
    }
    lock(&inner.stdin).take();
    if !inner.closing.load(Ordering::SeqCst) {
        (inner.log)(&format!("   ✗ {why}"));
    }
    let _ = tx.send(Dispatch::Closed);
}

fn dispatch(inner: Arc<Inner>, rx: Receiver<Dispatch>) {
    for event in rx {
        match event {
            Dispatch::Text {
                text,
                final_,
                times,
            } => {
                if let Some(times) = times {
                    inner.state().heard_times = times;
                }
                let on_text = lock(&inner.callbacks).on_text.clone();
                if let Some(on_text) = on_text {
                    guarded("on_text", || on_text(&text, final_));
                }
            }
            Dispatch::Speech => {
                let on_speech = lock(&inner.callbacks).on_speech.clone();
                if let Some(on_speech) = on_speech {
                    guarded("on_speech", || on_speech());
                }
            }
            Dispatch::Ignored {
                seconds,
                similarity,
                heard_machine,
            } => {
                inner.state().heard_machine = heard_machine;
                let on_ignored = lock(&inner.callbacks).on_ignored.clone();
                if let Some(on_ignored) = on_ignored {
                    guarded("on_ignored", || on_ignored(seconds, similarity));
                }
            }
            Dispatch::Then(id) => {
                let then = inner.state().thens.remove(&id);
                if let Some(then) = then {
                    guarded("cut's then", then);
                }
            }
            Dispatch::Play(words) => {
                let on_play = lock(&inner.callbacks).on_play.clone();
                if let Some(on_play) = on_play {
                    guarded("on_play", || on_play(&words));
                }
            }
            Dispatch::Closed => {
                let thens = std::mem::take(&mut inner.state().thens);
                for then in thens.into_values() {
                    guarded("cut's then", then);
                }
                return;
            }
        }
    }
}
