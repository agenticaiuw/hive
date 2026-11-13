//! Captions on the screen (python/captions.py): what the agent is saying, and under that what it's
//! doing right now; while it's listening or you're dictating, a line saying so on top, with what
//! you're saying under it. build/agent-vhid-captions (tools/captions.swift) draws them over every app;
//! clicks go through them and the agent's screenshots leave them out. Its protocol is JSON lines,
//! one key per message (see tools/captions.swift).
//!
//! `CAPTIONS=0`: no captions.

use crate::process::{alive, reap, write_line};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

type InputFn = Arc<dyn Fn(&str) + Send + Sync>;
type ControlFn = Arc<dyn Fn(&str, Option<bool>) + Send + Sync>;
type FocusedFn = Arc<dyn Fn(bool) + Send + Sync>;

/// build/agent-vhid-captions
pub fn overlay() -> PathBuf {
    hive_common::build_dir().join("agent-vhid-captions")
}

struct Overlay {
    child: Child,
    stdin: ChildStdin,
}

#[derive(Default)]
struct Callbacks {
    on_input: Option<InputFn>,
    on_control: Option<ControlFn>,
    on_focused: Option<FocusedFn>,
}

struct Inner {
    overlay: Mutex<Option<Overlay>>,
    callbacks: Mutex<Callbacks>,
    focused: Mutex<Option<bool>>,
    shown: bool,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Does nothing when `show` is false, the overlay isn't built (make), or CAPTIONS=0.
#[derive(Clone)]
pub struct Captions {
    inner: Arc<Inner>,
}

impl Captions {
    pub fn new(show: bool) -> Captions {
        Captions::with_overlay(show, &overlay())
    }

    /// With another overlay program (the tests' stand-in).
    pub fn with_overlay(show: bool, program: &Path) -> Captions {
        let wanted =
            show && std::env::var("CAPTIONS").map_or(true, |v| v != "0") && program.exists();
        let started = wanted
            .then(|| {
                Command::new(program)
                    .stdin(Stdio::piped())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::null())
                    .spawn()
                    .ok()
            })
            .flatten();
        let inner = Arc::new(Inner {
            overlay: Mutex::new(None),
            callbacks: Mutex::new(Callbacks::default()),
            focused: Mutex::new(None),
            shown: started.is_some(),
        });
        if let Some(mut child) = started {
            let stdout = child.stdout.take();
            if let Some(stdin) = child.stdin.take() {
                *lock(&inner.overlay) = Some(Overlay { child, stdin });
            }
            if let Some(stdout) = stdout {
                let reader = inner.clone();
                let _ = std::thread::Builder::new()
                    .name("captions".into())
                    .spawn(move || read(reader, stdout));
            }
        }
        Captions { inner }
    }

    /// The overlay is running (Python: the Captions object has `on_input` and `on_control`).
    pub fn shown(&self) -> bool {
        self.inner.shown
    }

    /// A request typed into the card's entry field.
    pub fn set_on_input(&self, f: impl Fn(&str) + Send + Sync + 'static) {
        lock(&self.inner.callbacks).on_input = Some(Arc::new(f));
    }

    /// The card's buttons: ("mute", Some(on)) for the mic button, ("close", None) for the x,
    /// ("hidden", Some(true)) for the – (hide the card; the task goes on).
    pub fn set_on_control(&self, f: impl Fn(&str, Option<bool>) + Send + Sync + 'static) {
        lock(&self.inner.callbacks).on_control = Some(Arc::new(f));
    }

    /// The entry field got or gave back the keyboard ({"focused": bool} from the overlay).
    pub fn set_on_focused(&self, f: impl Fn(bool) + Send + Sync + 'static) {
        lock(&self.inner.callbacks).on_focused = Some(Arc::new(f));
    }

    /// Whether the entry field has the keyboard, as the overlay last said; None until it says.
    pub fn focused(&self) -> Option<bool> {
        *lock(&self.inner.focused)
    }

    /// The "Listening · tap fn to turn the mic off" line on top, while it listens.
    pub fn listening(&self, on: bool) {
        self.send(json!({"listening": on}));
    }

    /// Typing goes to the card's entry field (fn opened it), or back to the app in front.
    pub fn focus(&self, on: bool) {
        self.send(json!({"focus": on}));
    }

    /// The "Dictating · let go of fn to type it" line on top instead, while you hold fn.
    pub fn dictating(&self, on: bool) {
        self.send(json!({"dictating": on}));
    }

    /// Dictation started with fn + shift: it goes on after you let go, and the line says
    /// "press fn to type it".
    pub fn hands_free(&self, on: bool) {
        self.send(json!({"hands_free": on}));
    }

    /// The camera line on top in lip reading mode: "starting", "waiting" (for macOS's permission),
    /// "on" (it is recording), or "off" (none).
    pub fn camera(&self, state: &str) {
        self.send(json!({"camera": state}));
    }

    pub fn dismiss(&self) {
        self.send(json!({"dismiss": true}));
    }

    /// Show Floating Window off (true): the card stays hidden, task or not, except while fn is in
    /// use. Everything sent meanwhile is kept, so `hidden(false)` shows it as it is now.
    pub fn hidden(&self, on: bool) {
        self.send(json!({"hidden": on}));
    }

    pub fn framing(&self, text: &str) {
        self.send(json!({"framing": text}));
    }

    pub fn preview(&self, jpeg: &str) {
        self.send(json!({"preview": jpeg}));
    }

    /// What you're saying, as you say it; it fades a little after you stop.
    pub fn hearing(&self, words: &str) {
        self.send(json!({"hearing": words}));
    }

    /// The words it's saying now; they fade once there's been time to read them.
    pub fn say(&self, words: &str) {
        self.send(json!({"say": words}));
    }

    /// The small line under the words, e.g. 'Typing “weather”'; "" removes it.
    pub fn doing(&self, text: &str) {
        self.send(json!({"doing": text}));
    }

    /// Public progress or reasoning summary, shown while the task runs.
    pub fn thinking(&self, text: &str) {
        self.send(json!({"thinking": text}));
    }

    /// A request another program sent (not your words), in its own row; "" removes it.
    pub fn agent_request(&self, text: &str) {
        self.send(json!({"agent_request": text}));
    }

    /// Why the agent is paused and how to let it go on (press fn); "" removes it.
    pub fn paused(&self, text: &str) {
        self.send(json!({"paused": text}));
    }

    pub fn muted(&self, on: bool) {
        self.send(json!({"muted": on}));
    }

    pub fn activity(&self, text: &str) {
        self.send(json!({"activity": text}));
    }

    pub fn active(&self, on: bool) {
        self.send(json!({"active": on}));
    }

    pub fn clear(&self) {
        self.send(json!({"clear": true}));
    }

    /// The overlay quits when its input ends (killed if it hasn't in 2 s).
    pub fn close(&self) {
        let overlay = lock(&self.inner.overlay).take();
        if let Some(Overlay { mut child, stdin }) = overlay {
            drop(stdin);
            reap(&mut child, Duration::from_secs(2));
        }
    }

    fn send(&self, message: Value) {
        let mut overlay = lock(&self.inner.overlay);
        let Some(running) = overlay.as_mut() else {
            return;
        };
        if !alive(&mut running.child) {
            return;
        }
        if write_line(&mut running.stdin, &message).is_err() {
            *overlay = None;
        }
    }
}

fn read(inner: Arc<Inner>, stdout: ChildStdout) {
    for line in BufReader::new(stdout).lines() {
        let Ok(line) = line else { break };
        let Ok(Value::Object(message)) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let callbacks = {
            let c = lock(&inner.callbacks);
            (
                c.on_input.clone(),
                c.on_control.clone(),
                c.on_focused.clone(),
            )
        };
        let (on_input, on_control, on_focused) = callbacks;
        if let Some(text) = message
            .get("text")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|t| !t.is_empty())
        {
            if let Some(f) = &on_input {
                f(text);
            }
        }
        if let Some(muted) = message.get("mute").and_then(Value::as_bool) {
            if let Some(f) = &on_control {
                f("mute", Some(muted));
            }
        }
        if message.get("close") == Some(&Value::Bool(true)) {
            if let Some(f) = &on_control {
                f("close", None);
            }
        }
        if let Some(hidden) = message.get("hidden").and_then(Value::as_bool) {
            if let Some(f) = &on_control {
                f("hidden", Some(hidden));
            }
        }
        if let Some(focused) = message.get("focused").and_then(Value::as_bool) {
            *lock(&inner.focused) = Some(focused);
            if let Some(f) = &on_focused {
                f(focused);
            }
        }
    }
}
