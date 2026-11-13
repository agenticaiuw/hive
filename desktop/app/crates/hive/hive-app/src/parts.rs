//! What the voice shell works with, as traits: the sidecar's ears and voice, the floating window,
//! the helper, the lip reader, Codex, and the rest of the Mac. [`crate::real`] has the real ones;
//! the tests give fakes (Python's tests used `mock`). Every [`Host`] method defaults to the real
//! thing, so a fake overrides the ones it needs.

use serde_json::Value;
use std::any::Any;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// A task's events: `(kind, text)` (see hive-codex's `OnEvent`).
pub type OnEvent = Arc<dyn Fn(&str, &str) + Send + Sync>;
/// The Mac's look, taken as you started talking (hive-codex's `LookAhead`), opaque to the shell.
pub type Look = Arc<dyn Any + Send + Sync>;

/// The microphone, as the ears report it (mic.py's `Microphone`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Mic {
    /// "on (...)" or "off (why)".
    pub description: String,
    pub tap_error: Option<String>,
    pub canceller_error: Option<String>,
}

/// listen.py's `Ears` as the shell uses them. Their callbacks (on_text, on_speech, on_ignored)
/// are wired to [`crate::VoiceAgent::heard`], `cut_in` and `ignored` by whoever builds them.
pub trait Ears: Send + Sync {
    /// Opens or closes the microphone (the shell's mute is applied before this).
    fn listen(&self, on: bool);
    fn listening(&self) -> bool;
    /// Ends what's being said now; `then` runs once the last of it is written down.
    fn cut(&self, then: Option<Box<dyn FnOnce() + Send>>);
    fn mic_level(&self) -> f64;
    fn hears_the_mac(&self) -> bool;
    /// None: no microphone (Python's `ears.microphone` is None).
    fn microphone(&self) -> Option<Mic>;
    /// For the latest final text: "stopped", "decided", "written", on [`crate::util::monotonic`].
    fn heard_times(&self) -> BTreeMap<String, f64>;
    /// "Parakeet (...)" or "nothing (why)"; waits for the model.
    fn describe(&self) -> String;
    /// Parakeet loaded (known once `describe` returned).
    fn has_model(&self) -> bool;
    /// It checks voices against yours (Python: `ears.voiceprint is not None`).
    fn has_voiceprint(&self) -> bool;
    /// The voiceprint's "on (...)" / "off (why)".
    fn describe_voiceprint(&self) -> String;
    /// The last thing left out was its own voice.
    fn heard_machine(&self) -> bool;
    /// Teaches the voiceprint its own voice (`learn_its_voice`).
    fn learn_its_voice(&self) -> Result<bool, String> {
        Ok(false)
    }
}

/// speech.py's `Voice`. on_play goes to [`crate::VoiceAgent::on_play`].
pub trait Voice: Send + Sync {
    fn say(&self, text: &str);
    fn stop(&self);
    fn audible(&self) -> bool;
    /// Seconds since it last played anything (1e9 if never).
    fn quiet_for(&self) -> f64;
    /// TTS_VOICE's name.
    fn name(&self) -> String {
        String::new()
    }
}

/// The floating window (captions.py). Every sender defaults to doing nothing.
#[allow(unused_variables)]
pub trait Captions: Send + Sync {
    fn say(&self, words: &str) {}
    fn listening(&self, on: bool) {}
    fn focus(&self, on: bool) {}
    fn dictating(&self, on: bool) {}
    fn hands_free(&self, on: bool) {}
    fn camera(&self, state: &str) {}
    fn dismiss(&self) {}
    fn framing(&self, text: &str) {}
    fn preview(&self, jpeg: &str) {}
    fn hearing(&self, words: &str) {}
    fn doing(&self, text: &str) {}
    fn thinking(&self, text: &str) {}
    fn agent_request(&self, text: &str) {}
    fn paused(&self, text: &str) {}
    fn muted(&self, on: bool) {}
    fn activity(&self, text: &str) {}
    fn active(&self, on: bool) {}
    /// Show Floating Window off (true): the card stays hidden except while fn is in use.
    fn hidden(&self, on: bool) {}
    fn close(&self) {}
}

/// agent-vhid-helper, as the shell uses it. Errors are the message (`str(e)`).
pub trait Mac: Send + Sync {
    fn is_engaged(&self) -> Result<bool, String>;
    fn engage(&self) -> Result<(), String>;
    fn disengage(&self) -> Result<(), String>;
    fn release_all(&self) -> Result<(), String>;
    /// The helper's socket, which `watch_helper` watches.
    fn socket(&self) -> PathBuf;
}

/// lipread.py's `LipReader`.
pub trait Lips: Send + Sync {
    /// Warms the model without opening the camera.
    fn open(&self) -> Result<(), String>;
    fn start(&self) -> Result<(), String>;
    fn stop(&self) -> Result<String, String>;
    fn close(&self);
    /// The current recording's number (events from others are dropped); None if it has none.
    fn session(&self) -> Option<u64> {
        None
    }
}

/// One request on Codex (agent.py's `CodexTask`).
pub trait Task: Send + Sync {
    /// The request's words.
    fn task(&self) -> String;
    /// "mac" or "phone".
    fn device(&self) -> String;
    fn running(&self) -> bool;
    /// Starts it in the background (`look`: attach a screenshot taken now).
    fn start(&self, look: bool);
    fn stop(&self);
    /// Stopped for an update's restart: it continues after.
    fn stop_for_maintenance(&self) {
        self.stop()
    }
    /// `time.time()` when it started.
    fn started_at(&self) -> f64;
    /// Seconds it took.
    fn elapsed(&self) -> f64;
    /// When it started, on [`crate::util::monotonic`].
    fn began(&self) -> f64;
    /// Seconds from `began`: "look", "codex", "words", "end".
    fn times(&self) -> Vec<(String, f64)>;
    fn looked_ahead(&self) -> bool;
    fn calls_to_words(&self) -> i64;
    /// Codex's thread (Python's `_thread`).
    fn thread_id(&self) -> Option<String>;
    fn on_thread(&self) -> bool;
    /// The saved request it owns (Python's `_recovery_id`).
    fn recovery_id(&self) -> Option<String>;
    fn set_receipt_id(&self, receipt: Option<String>);
    fn set_on_event(&self, on_event: OnEvent);
    fn set_prompt(&self, prompt: String);
    fn set_durable_recovery(&self, durable: bool);
    /// You handed the screen back: its Mac tools hold the mouse and keyboard again, and let go of
    /// them if they aren't used for a while (`task.tools["mac"].handed_back()`).
    fn handed_back(&self) {}
    /// You just took the mouse and keyboard: on the virtual monitor, its Mac tools put your cursor
    /// and app back on your screen, and the task goes on (`task.tools["mac"].took_over()`).
    fn took_over(&self) {}
    /// Waits for it to end; false after `seconds`.
    fn wait_done(&self, seconds: f64) -> bool;
    /// Its reply (Python's `final`).
    fn final_text(&self) -> Option<String>;
    /// Why it failed, "stopped", or "" (Python's `_ended`).
    fn ended(&self) -> String;
}

/// Codex: tasks, the conversation, and the files that let work continue after a restart.
pub trait Backend: Send + Sync {
    /// `CodexTask(text, previous=, device=, ahead=)`, not started.
    fn task(
        &self,
        text: &str,
        previous: Option<&str>,
        device: &str,
        ahead: Option<Look>,
    ) -> Arc<dyn Task>;
    /// The device a request is for (`focus`).
    fn focus(&self, words: &str) -> String;
    /// `new_session()`: the durable conversation, ready (listening started).
    fn new_session(&self);
    /// `LookAhead()`: starts taking the Mac's screenshot now.
    fn look_ahead(&self) -> Option<Look>;
    /// "gpt-..., low effort" for the journal.
    fn describe_model(&self) -> String;
    /// The app-server is running (`running_server() is not None`).
    fn server_running(&self) -> bool;
    /// A request to the running app-server; None if it isn't running (`running_server()`).
    fn request(&self, method: &str, params: Value, timeout: f64) -> Option<Result<Value, String>>;
    /// At start (app, Codex backend): the saved request to continue, as a task holding the owner
    /// lock (`acquire_owner` + `startup_recovery_record`), or None.
    fn restore(&self) -> Result<Option<Arc<dyn Task>>, String>;
    /// `task_recovery.current()`.
    fn recovery_current(&self) -> Result<Option<Value>, String>;
    /// `task_recovery.finish(id, status)`.
    fn recovery_finish(&self, id: &str, status: &str) -> Result<(), String>;
    /// `provider_wait.status(id)`: "waiting", "resolved" or None.
    fn provider_status(&self, id: &str) -> Result<Option<String>, String>;
}

/// Something running that is closed at shutdown (the workspace bridge, the request socket).
pub trait Closeable: Send + Sync {
    fn close(&self);
}

/// A request from the request socket (local_request.py), handed to the main loop.
pub struct LocalRequest {
    pub text: String,
    pub resume_goal: bool,
    pub goal_objective: Option<String>,
    pub receipt_id: Option<String>,
    /// When it must have started by.
    pub deadline: std::time::Instant,
    pub reply: Box<dyn Fn(Value) + Send>,
}

/// Where lines go: stdout (Hive.app copies it to Agent.log and reads the `@@` lines).
pub trait Console: Send + Sync {
    /// `print(text, flush=True)`.
    fn line(&self, text: &str);
    /// `sys.stdout.write(text); sys.stdout.flush()`.
    fn raw(&self, text: &str);
    /// stdout is a terminal (the words you say are rewritten in place on one line).
    fn tty(&self) -> bool;
    fn columns(&self) -> usize;
}

/// The real stdout.
#[derive(Default)]
pub struct Stdout {
    /// \r\n line endings (settings.fix_newlines: a terminal sudo switched to raw mode).
    pub crlf: bool,
}

impl Stdout {
    /// settings.fix_newlines(): \r\n line endings when stdout is a terminal.
    pub fn fixed() -> Stdout {
        Stdout {
            crlf: Stdout::default().tty(),
        }
    }
}

impl Console for Stdout {
    fn line(&self, text: &str) {
        self.raw(&format!("{text}\n"));
    }
    fn raw(&self, text: &str) {
        use std::io::Write;
        let text = if self.crlf {
            text.replace('\n', "\r\n")
        } else {
            text.to_owned()
        };
        let mut out = std::io::stdout().lock();
        let _ = out.write_all(text.as_bytes());
        let _ = out.flush();
    }
    fn tty(&self) -> bool {
        // SAFETY: isatty only reads the descriptor's state.
        unsafe { libc::isatty(1) == 1 }
    }
    fn columns(&self) -> usize {
        // shutil.get_terminal_size(): COLUMNS, else the terminal's, else 80.
        if let Some(n) = std::env::var("COLUMNS")
            .ok()
            .and_then(|c| c.parse::<usize>().ok())
            .filter(|n| *n > 0)
        {
            return n;
        }
        // SAFETY: TIOCGWINSZ fills the winsize we pass.
        unsafe {
            let mut size: libc::winsize = std::mem::zeroed();
            if libc::ioctl(1, libc::TIOCGWINSZ, &mut size) == 0 && size.ws_col > 0 {
                return size.ws_col as usize;
            }
        }
        80
    }
}

/// The rest of the Mac: notifications, typing dictation, the virtual monitor, the workspace,
/// lip reading's settings, the request ledger and the update. Defaults are the real thing.
pub trait Host: Send + Sync {
    fn notify(&self, message: &str, title: &str) {
        crate::util::notify(message, title)
    }
    /// Types dictation into the app in front; None if it did, else why not.
    fn paste(&self, text: &str) -> Option<String> {
        crate::util::paste(text)
    }
    /// A shift key is down: fn with shift dictates until fn again.
    fn shift_held(&self) -> bool {
        hive_mac::shift_held()
    }

    // -- where Hive works (virtual_monitor.py) --
    /// Asks where Hive should work (12 s, then the last choice).
    fn ask_work_screen(&self) {
        hive_mac::virtual_monitor::ask(12);
    }
    fn virtual_monitor_enabled(&self) -> bool {
        hive_mac::virtual_monitor::enabled()
    }
    /// Turns it on if it should be; false if it couldn't.
    fn ensure_virtual_monitor(&self) -> bool {
        hive_mac::virtual_monitor::ensure(std::time::Duration::from_secs(10)).is_some()
    }
    fn virtual_monitor_off(&self) {
        hive_mac::virtual_monitor::off()
    }
    /// The virtual monitor is on (`bounds()` isn't None).
    fn virtual_monitor_on(&self) -> bool {
        hive_mac::virtual_monitor::bounds().is_some()
    }
    fn on_virtual_monitor(&self, x: f64, y: f64) -> bool {
        hive_mac::virtual_monitor::contains(x, y)
    }
    fn cursor(&self) -> (f64, f64) {
        hive_mac::System::cursor(&hive_mac::RealMac)
    }
    fn warp(&self, x: f64, y: f64) {
        hive_mac::virtual_monitor::warp(x, y)
    }

    // -- the workspace (AGENT_SPACEO_COMMAND) --
    /// `<engine> session pause ... --reason "Stopped by fn"` worked (3 s).
    fn pause_workspace(&self, engine: &str) -> bool {
        crate::real::pause_workspace(engine)
    }
    /// workspace_recovery.recover_if_latched: (outcome, detail).
    fn recover_workspace(&self, spaceo: &str) -> Result<(String, String), String> {
        Ok(hive_workspace::recovery::recover_if_latched(
            spaceo,
            &hive_workspace::recovery::run_command,
        ))
    }
    /// The embedded workspace bridge, started (`Bridge(...).start_embedded()`).
    fn start_workspace(
        &self,
        spaceo: &str,
        on_activity: OnEvent,
    ) -> Result<Arc<dyn Closeable>, String> {
        crate::real::start_workspace(spaceo, on_activity)
    }
    /// `Bridge.status("error", message)`.
    fn workspace_error(&self, message: &str) {
        let _ = hive_workspace::bridge::write_status(&hive_common::state_dir(), "error", message);
    }
    /// The request socket in `dir` (LocalRequests).
    fn local_requests(
        &self,
        dir: &Path,
        on_request: Arc<dyn Fn(LocalRequest) + Send + Sync>,
    ) -> Result<Arc<dyn Closeable>, String> {
        crate::real::local_requests(dir, on_request)
    }

    // -- lip reading (lipread.py) --
    fn lips_available(&self) -> (bool, String) {
        hive_sidecars::lipread::available()
    }
    fn lips_mode(&self) -> String {
        hive_sidecars::lipread::get_mode()
    }
    fn set_lips_mode(&self, mode: &str) -> std::io::Result<String> {
        hive_sidecars::lipread::set_mode(mode)
    }
    fn new_lips(&self, on_event: Arc<dyn Fn(Value) + Send + Sync>) -> Arc<dyn Lips> {
        crate::real::new_lips(on_event)
    }

    // -- the request ledger (ui_ingress.py) --
    fn admit(&self, text: &str, channel: &str) -> Result<String, String> {
        hive_knowledge::ui_ingress::admit(text, channel)
    }
    fn finish(&self, receipt: &str, status: &str) -> Result<(), String> {
        hive_knowledge::ui_ingress::finish(receipt, status).map(drop)
    }

    /// A Codex thread's rollout file (session_journal.rollout_for).
    fn rollout_for(&self, thread: &str) -> Option<PathBuf> {
        hive_knowledge::session_journal::rollout_for(thread).map(PathBuf::from)
    }
    /// Starts `/bin/bash <repo>/tools/update-app.sh` in a session of its own, its output
    /// appended to `log`.
    fn start_update(&self, log: &Path) -> std::io::Result<()> {
        crate::real::start_update(log)
    }
}

/// The real Mac.
pub struct RealHost;
impl Host for RealHost {}
