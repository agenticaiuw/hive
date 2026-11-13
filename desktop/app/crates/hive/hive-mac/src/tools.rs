//! Tools that let an AI agent use this Mac the way a person does: screenshots to see, and the
//! real mouse and keyboard (through agent-vhid-helper) to act (python/mac_mcp.py). The Codex
//! driver calls [`MacTools`] in-process as the "mac" namespace; `hive-mac-mcp` serves them over
//! stdio as an MCP server for any other agent.
//!
//! Every coordinate is a pixel in the screenshot images these tools return. The tools take the
//! mouse and keyboard only for screen actions and let go of them when the agent turns to other work
//! (the shell, thinking), so the user can use their Mac meanwhile. When the user touches a key, the
//! trackpad or a mouse while the agent has them, screen actions stop until they press fn; the tools
//! tell the model to carry on with work that doesn't need the screen.
//!
//! Every action that changes something carries a `step`: one sentence, shown to the user, of what it
//! does. A step that can't be undone (it sends something others will see, deletes, pays or publishes)
//! begins with "One-way:" and quotes the user's words that ask for it; the tools refuse it when those
//! words aren't in what the user said (`words`).

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{mpsc, Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use hive_common::mcp::{
    batch_tool, check_step, look_schema, py_repr, run_batch, step_schema, truthy, SETTLE,
};
use hive_common::tools::{error_text, image_bytes, ok_text, result, text, ToolNamespace};
use serde_json::{json, Value};

use crate::credentials::{self, CredentialError, Native, NativeHelper};
use crate::desktop::{self, json_quote, Window};
use crate::screen::Format;
use crate::system::{RealMac, System};
use crate::vhid::{fmt0, py_round, AgentVHID, Screenshot, TextBox, VhidError};
use crate::virtual_monitor::inside;

/// one image pixel per screen point on most Mac displays
pub const MAX_WIDTH: f64 = 1440.0;
/// JPEG quality of the screenshots (sips's `formatOptions 70`).
pub const JPEG_QUALITY: f64 = 0.7;

/// Without a screen action for this long, the agent lets go of the mouse and keyboard.
pub const IDLE_RELEASE: Duration = Duration::from_secs(10);
/// How long a screen action waits for the user's hands to be off the keyboard and trackpad.
pub const ENGAGE_WAIT: Duration = Duration::from_secs(5);
/// While Hive works on the virtual monitor, the user touching the mouse or keyboard doesn't stop
/// it: a screen step waits until their hands have been still this long, then takes the mouse and
/// keyboard for itself and puts the user's cursor and app back afterwards. Nothing waits for fn.
pub const USER_STILL: Duration = Duration::from_millis(1500);
/// How long a step on the virtual monitor waits for the user's hands to be still.
pub const SHARE_WAIT: Duration = Duration::from_secs(60);

pub const ABOUT: &str = "The user's Mac: see the screen and use the real mouse and keyboard.";

pub const BATCHABLE: [&str; 8] = [
    "click",
    "move_mouse",
    "drag",
    "scroll",
    "type_text",
    "press_key",
    "open_app",
    "wait",
];

const BATCH_EXAMPLE: &str = r#"[{"tool": "press_key", "keys": "cmd+l"}, {"tool": "type_text", "text": "weather in Paris\n"}]"#;

/// Apps where Cmd+N gives the agent a window of its own instead of taking one the user has open.
/// Added to a look at the virtual monitor while no app's window is on it.
pub const EMPTY_MONITOR: &str =
    " No app's window is on the virtual monitor yet. open_app puts one here (a new \
window if the app is already open), and switch_window brings over a window that is open on the \
user's screen. Do that yourself; don't ask the user to.";

pub const NEW_WINDOW_APPS: [&str; 7] = [
    "Safari",
    "Google Chrome",
    "Arc",
    "Firefox",
    "Brave Browser",
    "Microsoft Edge",
    "Finder",
];

pub const INSTRUCTIONS: &str = "Use this Mac like a person: look with screenshot, act with click, type_text and \
     press_key (or several at once with batch). Coordinates are screenshot pixels. If a tool says the user has the \
     mouse and keyboard, keep doing the work that doesn't need the screen, and call wait_for_control only when the \
     screen is the one way forward. Give every action a `step` saying what it does; one that can't be undone \
     starts with \"One-way:\" and quotes the user's words asking for it.";

/// The MCP server's name (`hive-mac-mcp`).
pub const SERVER_NAME: &str = "agent-vhid-mac";

fn point(desc: &str) -> Value {
    json!({"type": "number", "description": desc})
}

/// The `read_selected_text` tool.
pub fn read_selected_text_tool() -> Value {
    json!({
        "name": "read_selected_text",
        "description": "Read the entire text currently selected in the focused app directly into this conversation. \
                        Does not change the clipboard. If the app does not expose the selection, reports that; \
                        never reads secure password fields. Selections over 500 KB are explicitly refused.",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": false},
    })
}

/// The `authenticate` tool (authentication_mcp.py serves it as `authenticate_mac`).
pub fn authenticate_tool() -> Value {
    json!({
        "name": "authenticate",
        "description": "Types the user's saved Mac password into the field that has the keyboard focus and presses \
                        Return, the way the user would. Click the password field first (for example the \
                        Passwords/AutoFill prompt's field). Takes no arguments; the password never reaches you. \
                        Take a screenshot afterwards to see the result.",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": false},
    })
}

/// The Mac's tools, MCP-style, in python/mac_mcp.py's order (batch last).
pub fn tools() -> Vec<Value> {
    let look = look_schema();
    let step = step_schema();
    vec![
        read_selected_text_tool(),
        authenticate_tool(),
        json!({
            "name": "screenshot",
            "description": "See the screen. Returns an image of the main display with the mouse pointer drawn in. \
                            Every x/y in the other tools is a pixel in this image.",
            "inputSchema": {"type": "object", "properties": {}},
        }),
        json!({
            "name": "click",
            "description": "Move the mouse to (x, y) like a person and click. clicks=2 double-clicks, 3 triple-clicks.",
            "inputSchema": {"type": "object", "properties": {
                "x": point("Pixel x in the latest screenshot"),
                "y": point("Pixel y in the latest screenshot"),
                "button": {"type": "string", "enum": ["left", "right", "middle"], "default": "left"},
                "clicks": {"type": "integer", "minimum": 1, "maximum": 3, "default": 1},
                "modifiers": {"type": "string", "description": "Keys held during the click, like 'cmd' or 'shift+cmd'."},
                "step": step, "screenshot": look,
            }, "required": ["step", "x", "y"]},
        }),
        json!({
            "name": "move_mouse",
            "description": "Move the mouse to (x, y) without clicking, e.g. to open a hover menu or show a tooltip.",
            "inputSchema": {"type": "object", "properties": {
                "x": point("Pixel x"), "y": point("Pixel y"), "screenshot": look,
            }, "required": ["x", "y"]},
        }),
        json!({
            "name": "drag",
            "description": "Press the left button at one point, move to another, and let go (move files, select text, \
                            resize windows).",
            "inputSchema": {"type": "object", "properties": {
                "from_x": point("Start x"), "from_y": point("Start y"),
                "to_x": point("End x"), "to_y": point("End y"), "step": step, "screenshot": look,
            }, "required": ["step", "from_x", "from_y", "to_x", "to_y"]},
        }),
        json!({
            "name": "scroll",
            "description": "Scroll the area under (x, y). down > 0 reveals content further down, down < 0 goes back \
                            up; likewise right. One notch is roughly three lines of text.",
            "inputSchema": {"type": "object", "properties": {
                "x": point("Pixel x of the area to scroll"), "y": point("Pixel y of the area to scroll"),
                "down": {"type": "integer", "minimum": -50, "maximum": 50, "default": 0},
                "right": {"type": "integer", "minimum": -50, "maximum": 50, "default": 0},
                "screenshot": look,
            }, "required": ["x", "y"]},
        }),
        json!({
            "name": "type_text",
            "description": "Type text on the keyboard into whatever has focus (click the field first). \
                            '\\n' presses Return. Emoji and other characters a US keyboard can't type are pasted.",
            "inputSchema": {"type": "object", "properties": {
                "text": {"type": "string"}, "step": step, "screenshot": look,
            }, "required": ["step", "text"]},
        }),
        json!({
            "name": "press_key",
            "description": "Press a key or shortcut, e.g. 'return', 'escape', 'tab', 'cmd+t', 'cmd+shift+4', 'cmd+l', \
                            'up', 'pagedown', 'delete' (backspace), 'forwarddelete', 'f5'. Modifiers: cmd, ctrl, \
                            alt/option, shift.",
            "inputSchema": {"type": "object", "properties": {
                "keys": {"type": "string"},
                "repeat": {"type": "integer", "minimum": 1, "maximum": 50, "default": 1},
                "step": step, "screenshot": look,
            }, "required": ["step", "keys"]},
        }),
        json!({
            "name": "open_app",
            "description": "Open an app (or a System Settings pane, file, or anything Spotlight finds) by typing its \
                            name into Spotlight and pressing Return.",
            "inputSchema": {"type": "object", "properties": {
                "name": {"type": "string"}, "screenshot": look,
            }, "required": ["name"]},
        }),
        json!({
            "name": "find_text",
            "description": "Find a word or phrase on screen with on-device text recognition and return the exact \
                            center of each match. More precise than estimating from the screenshot, especially for \
                            small buttons, menu items and links.",
            "inputSchema": {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]},
        }),
        json!({
            "name": "read_screen",
            "description": "Read all the text on screen with on-device text recognition, line by line, each with \
                            the pixel center of the line. Good for small print the screenshot shows poorly.",
            "inputSchema": {"type": "object", "properties": {}},
        }),
        json!({
            "name": "wait",
            "description": "Wait for something to load or finish, then look again.",
            "inputSchema": {"type": "object", "properties": {
                "seconds": {"type": "number", "minimum": 0.1, "maximum": 30}, "screenshot": look,
            }, "required": ["seconds"]},
        }),
        json!({
            "name": "wait_for_control",
            "description": "Use when a tool says the user has the mouse and keyboard and the screen is the only \
                            way forward (do everything else first). Waits until they hand it back (they press fn or \
                            say \"continue\"), then returns a fresh screenshot.",
            "inputSchema": {"type": "object", "properties": {
                "timeout_seconds": {"type": "number", "minimum": 5, "maximum": 600, "default": 120},
            }},
        }),
        json!({
            "name": "read_clipboard",
            "description": "Return the text on the clipboard, e.g. after copying something with cmd+c: up to \
                            8,000 characters from offset, saying how long it is when there's more.",
            "inputSchema": {"type": "object", "properties": {
                "offset": {"type": "integer", "minimum": 0, "default": 0},
            }},
        }),
        json!({
            "name": "read_ingested",
            "description": "Read a part of a text the user added with Add to Context (a transcript, say) that was \
                            too long to keep in the conversation. Its id and number of parts were given when it \
                            was added; an empty id means the latest one.",
            "inputSchema": {"type": "object", "properties": {
                "id": {"type": "string", "default": ""},
                "part": {"type": "integer", "minimum": 1, "default": 1},
            }},
        }),
        json!({
            "name": "windows",
            "description": "List every open window, front to back, with its app and title (including ones that are \
                            minimized, hidden or on another desktop), and the tabs open in Safari and Chrome.",
            "inputSchema": {"type": "object", "properties": {}},
        }),
        json!({
            "name": "switch_window",
            "description": "Bring an open window to the front by its title, or part of it, as `windows` lists it: \
                            switches to its app, then to that window. Use it rather than opening a document that is \
                            already open. Returns a screenshot.",
            "inputSchema": {"type": "object", "properties": {
                "title": {"type": "string"},
                "app": {"type": "string", "description": "The window's app, when several apps have a window with \
                                                         that title."},
            }, "required": ["title"]},
        }),
        batch_tool(&BATCHABLE, BATCH_EXAMPLE),
    ]
}

/// How screenshot pixels map to screen points. Fixed for a given display setup.
pub fn geometry(system: &dyn System) -> Screenshot {
    let (ox, oy, w, h) = system.work_display(); // the virtual monitor while it is on
    let width = w.min(MAX_WIDTH).trunc().max(1.0);
    let height = py_round(h * width / w);
    Screenshot {
        path: PathBuf::new(),
        width: width as usize,
        height: height.max(0.0) as usize,
        scale: w / width,
        origin: (ox, oy),
    }
}

/// A JSON value as Python's `str()` shows it in a message (`f"Clicked ({a['x']}, ...)"`).
fn py_str(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => "None".into(),
        Value::Bool(true) => "True".into(),
        Value::Bool(false) => "False".into(),
        other => other.to_string(),
    }
}

/// `a[key]`, failing like Python's KeyError.
fn arg<'a>(a: &'a Value, key: &str) -> Result<&'a Value, String> {
    a.get(key).ok_or_else(|| py_repr(key))
}

/// Python's `float(v)`.
fn float(v: &Value) -> Result<f64, String> {
    match v {
        Value::Number(n) => n.as_f64().ok_or_else(|| "number out of range".into()),
        Value::Bool(b) => Ok(if *b { 1.0 } else { 0.0 }),
        Value::String(s) => s
            .trim()
            .parse()
            .map_err(|_| format!("could not convert string to float: {}", py_repr(s))),
        other => Err(format!(
            "float() argument must be a string or a real number, not {}",
            type_name(other)
        )),
    }
}

/// Python's `int(v)`.
fn int(v: &Value) -> Result<i64, String> {
    match v {
        Value::Number(n) => n
            .as_i64()
            .or_else(|| n.as_f64().map(|f| f.trunc() as i64))
            .ok_or_else(|| "bad number".into()),
        Value::Bool(b) => Ok(*b as i64),
        Value::String(s) => s
            .trim()
            .parse()
            .map_err(|_| format!("invalid literal for int() with base 10: {}", py_repr(s))),
        other => Err(format!(
            "int() argument must be a string, a bytes-like object or a real number, not {}",
            type_name(other)
        )),
    }
}

fn type_name(v: &Value) -> &'static str {
    match v {
        Value::Null => "'NoneType'",
        Value::Array(_) => "'list'",
        Value::Object(_) => "'dict'",
        _ => "'object'",
    }
}

/// `a.get(key, default)` as text (Python's `a.get("button", "left")`).
fn str_or<'a>(a: &'a Value, key: &str, default: &'a str) -> &'a str {
    a.get(key).and_then(Value::as_str).unwrap_or(default)
}

/// The text of a string argument, failing like Python when it is missing.
fn text_arg<'a>(a: &'a Value, key: &str) -> Result<&'a str, String> {
    let v = arg(a, key)?;
    v.as_str()
        .ok_or_else(|| format!("{key} must be a string, not {}", v))
}

/// The Mac's tools for one agent: the helper's keyboard and mouse, and this Mac's screen.
pub struct MacTools {
    pub mac: Arc<AgentVHID>,
    pub system: Arc<dyn System>,
    /// The Hive bundle's credential helper (for `authenticate`).
    pub native: Arc<dyn Native>,
    /// Reads Caps Lock (for `authenticate`).
    pub caps_lock: Arc<dyn Fn() -> bool + Send + Sync>,
    /// build/agent-vhid-selection (for `read_selected_text`).
    pub selection_tool: PathBuf,
    /// Who has the mouse and keyboard, shared with the thread that lets go of them when idle.
    control: Arc<Control>,
}

/// The mouse and keyboard, held only while the screen is in use.
struct Control {
    mac: Arc<AgentVHID>,
    system: Arc<dyn System>,
    /// Where the user's cursor and front app were, and the agent's, on the virtual monitor.
    spots: Mutex<Spots>,
    /// What the user said in this conversation: a one-way step must quote it.
    words: Mutex<String>,
    /// Held during a screen action, so control isn't let go mid-action.
    acting: Mutex<()>,
    state: Mutex<Holding>,
    /// Set by close(): the idle thread ends.
    closed: (Mutex<bool>, Condvar),
}

struct Holding {
    last_act: Option<Instant>,
    /// The agent asked for the mouse and keyboard and hasn't let go of them.
    holding: bool,
    /// This task hasn't had control yet: a takeover before it doesn't count.
    fresh: bool,
}

/// A cursor position and the app in front.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Spot {
    cursor: Option<(f64, f64)>,
    pid: Option<i32>,
}

/// On the virtual monitor, one cursor and one front app are shared: the user's spot is put back
/// whenever the agent gives them the mouse and keyboard, and the agent's when it takes them again.
#[derive(Default)]
struct Spots {
    user: Option<Spot>,
    agent: Option<Spot>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl Control {
    fn acted(&self) {
        lock(&self.state).last_act = Some(Instant::now());
    }

    /// Hands the mouse and keyboard back while the agent works without the screen.
    fn let_go(&self) {
        let _acting = lock(&self.acting);
        {
            let mut state = lock(&self.state);
            if !state.holding {
                return;
            }
            state.holding = false;
        }
        if let Ok(status) = self.mac.status() {
            if matches!(status.get("state"), Some("engaged" | "arming")) {
                let _ = self.mac.disengage().and_then(|_| self.mac.release_all());
            }
        }
        self.give_back();
    }

    /// Whether Hive works on the virtual monitor, sharing the mouse and keyboard with the user.
    fn sharing(&self) -> bool {
        self.system.virtual_monitor().is_some()
    }

    /// Just before the agent takes the mouse and keyboard: notes where the user's cursor is and
    /// which app they have in front (unless the cursor is still on the virtual monitor).
    fn remember_user(&self) {
        let Some(monitor) = self.system.virtual_monitor() else {
            return;
        };
        let (x, y) = self.system.cursor();
        if !inside(monitor, x, y) {
            lock(&self.spots).user = Some(Spot {
                cursor: Some((x, y)),
                pid: self.system.frontmost_pid(),
            });
        }
    }

    /// The agent let go of the mouse and keyboard, or the user took them: the user's cursor goes
    /// back where it was on their screen and their app back in front. The agent's are noted.
    fn give_back(&self) {
        let Some(monitor) = self.system.virtual_monitor() else {
            return;
        };
        let mut spots = lock(&self.spots);
        let Some(user) = spots.user.take() else {
            return;
        };
        let (x, y) = self.system.cursor();
        let front = self.system.frontmost_pid();
        let on_monitor = inside(monitor, x, y);
        spots.agent = Some(Spot {
            cursor: on_monitor.then_some((x, y)),
            pid: front,
        });
        drop(spots);
        if let (true, Some((ux, uy))) = (on_monitor, user.cursor) {
            self.system.warp(ux, uy);
        }
        if let Some(pid) = user.pid.filter(|p| *p != 0 && front != Some(*p)) {
            self.system.activate(pid);
        }
    }

    /// The agent has the mouse and keyboard again: its cursor and app come back.
    fn back_to_agent(&self) {
        let Some(agent) = lock(&self.spots).agent.take() else {
            return;
        };
        if let Some((x, y)) = agent.cursor {
            self.system.warp(x, y);
        }
        if let Some(pid) = agent.pid.filter(|p| *p != 0) {
            if self.system.frontmost_pid() != Some(pid) {
                self.system.activate(pid);
                std::thread::sleep(Duration::from_millis(300)); // it comes forward before the step
            }
        }
    }

    fn let_go_when_idle(&self) {
        let (closed, wake) = &self.closed;
        let mut done = lock(closed);
        while !*done {
            done = wake
                .wait_timeout(done, Duration::from_secs(1))
                .unwrap_or_else(|e| e.into_inner())
                .0;
            if *done {
                break;
            }
            drop(done);
            let idle = {
                let state = lock(&self.state);
                state.holding && state.last_act.map_or(true, |t| t.elapsed() > IDLE_RELEASE)
            };
            if idle {
                self.let_go();
            }
            done = lock(closed);
        }
    }

    fn close(&self) {
        *lock(&self.closed.0) = true;
        self.closed.1.notify_all();
    }
}

impl Default for MacTools {
    fn default() -> Self {
        MacTools::new()
    }
}

impl MacTools {
    /// The real Mac, through the helper at its usual socket: still a person's curved moves and
    /// typing, just a quick one (speed 2).
    pub fn new() -> MacTools {
        MacTools::with(
            AgentVHID::new(crate::vhid::default_socket(), 2.0, true),
            Arc::new(RealMac),
        )
    }

    /// These tools with this helper client and this Mac (a fake one in tests).
    pub fn with(mac: AgentVHID, system: Arc<dyn System>) -> MacTools {
        let mac = Arc::new(mac.with_system(system.clone()));
        let control = Arc::new(Control {
            mac: mac.clone(),
            system: system.clone(),
            spots: Mutex::new(Spots::default()),
            words: Mutex::new(String::new()),
            acting: Mutex::new(()),
            state: Mutex::new(Holding {
                last_act: None,
                holding: false,
                fresh: true,
            }),
            closed: (Mutex::new(false), Condvar::new()),
        });
        let idle = control.clone();
        std::thread::Builder::new()
            .name("mac-let-go".into())
            .spawn(move || idle.let_go_when_idle())
            .expect("spawn the idle thread");
        MacTools {
            mac,
            system,
            native: Arc::new(NativeHelper),
            caps_lock: Arc::new(credentials::caps_lock_on),
            selection_tool: hive_common::build_dir().join("agent-vhid-selection"),
            control,
        }
    }

    // -- the mouse and keyboard, only while the screen is in use --

    /// What the user said in this conversation lately: a one-way step must quote it.
    pub fn set_words(&self, words: &str) {
        *lock(&self.control.words) = words.to_string();
    }

    /// Refuses a one-way step that doesn't quote the user ([`check_step`]).
    pub fn check_step(&self, a: &Value) -> Option<Value> {
        check_step(a, &lock(&self.control.words))
    }

    /// Takes the mouse and keyboard for a screen action, once the user's hands are off them. `None`
    /// when the agent has them; else why not (the user took over, or is busy with them).
    ///
    /// On the virtual monitor a takeover doesn't stop the agent: the step waits (up to
    /// [`SHARE_WAIT`]) for the user's hands to be still for [`USER_STILL`], then takes them.
    pub fn take(&self) -> Result<Option<String>, VhidError> {
        let why_not = match self.take_once()? {
            Some(reason)
                if self.control.sharing()
                    && (crate::vhid::took_over(Some(&reason)) || reason == "busy") =>
            {
                self.take_back()?
            }
            other => other,
        };
        if why_not.is_none() {
            self.control.back_to_agent();
        }
        Ok(why_not)
    }

    /// On the virtual monitor, after the user used the mouse and keyboard: waits for their hands
    /// to be still, then asks the helper again (it waits its own quiet moment, and gives up if they
    /// touch anything meanwhile).
    fn take_back(&self) -> Result<Option<String>, VhidError> {
        let deadline = Instant::now() + SHARE_WAIT;
        loop {
            while self.system.seconds_since_input() < USER_STILL.as_secs_f64() {
                if Instant::now() >= deadline {
                    return Ok(Some("busy".into()));
                }
                std::thread::sleep(Duration::from_millis(200));
            }
            let status = self.mac.status()?;
            if status.get("state") != Some("engaged") {
                if status.get("reason") == Some("watcher_unavailable") {
                    return Ok(Some("watcher_unavailable".into()));
                }
                self.control.remember_user();
                self.mac.engage()?;
                if !self.mac.wait_engaged(Some(ENGAGE_WAIT), false)? {
                    if Instant::now() >= deadline {
                        return Ok(Some("busy".into()));
                    }
                    continue;
                }
            }
            let mut s = lock(&self.control.state);
            s.holding = true;
            s.fresh = false;
            return Ok(None);
        }
    }

    fn take_once(&self) -> Result<Option<String>, VhidError> {
        let status = self.mac.status()?;
        let state = status.get("state").unwrap_or("").to_string();
        let mut reason = status.get("reason").unwrap_or("").to_string();
        let have = |fresh: bool| {
            let mut s = lock(&self.control.state);
            s.holding = true;
            if !fresh {
                s.fresh = false;
            }
        };
        if state == "engaged" {
            have(false);
            return Ok(None);
        }
        if state == "arming" {
            self.control.remember_user();
            if self.mac.wait_engaged(Some(ENGAGE_WAIT), false)? {
                have(false);
                return Ok(None);
            }
            reason = self.mac.status()?.get("reason").unwrap_or("").to_string();
        } else if reason == "watcher_unavailable" {
            return Ok(Some(reason));
        } else if lock(&self.control.state).fresh || !crate::vhid::took_over(Some(&reason)) {
            // The agent let go after a pause, or this is the task's first screen action: ask again.
            self.control.remember_user();
            self.mac.engage()?;
            lock(&self.control.state).fresh = false;
            if self.mac.wait_engaged(Some(ENGAGE_WAIT), false)? {
                have(true);
                return Ok(None);
            }
            reason = self.mac.status()?.get("reason").unwrap_or("").to_string();
            if reason.is_empty() {
                reason = "busy".into();
            }
        }
        Ok(Some(reason).filter(|r| !r.is_empty()))
    }

    /// Hands the mouse and keyboard back while the agent works without the screen.
    pub fn let_go(&self) {
        self.control.let_go();
    }

    /// The user just took the mouse and keyboard (the helper said so). On the virtual monitor
    /// their cursor and app come straight back to their screen; the agent goes on.
    /// Doesn't wait for a step in progress (that step may be waiting for the user's hands).
    pub fn took_over(&self) {
        self.control.give_back();
    }

    /// The user pressed fn to give the screen back: the agent holds it as if it had just used it,
    /// so it's let go again if the agent doesn't need it for a while.
    pub fn handed_back(&self) {
        let mut s = lock(&self.control.state);
        s.holding = true;
        s.fresh = false;
        s.last_act = Some(Instant::now());
    }

    /// Whether the agent holds the mouse and keyboard (it asked for them and hasn't let go).
    pub fn holding(&self) -> bool {
        lock(&self.control.state).holding
    }

    /// What a screen action says when it couldn't have the mouse and keyboard: on the virtual
    /// monitor, that the user has been busy with them; else [`MacTools::not_yours`].
    pub fn not_now(&self, reason: &str) -> Value {
        if self.control.sharing() && reason == "busy" {
            return error_text(format!(
                "The user has kept using the mouse and keyboard for the last {} s. Hive works on the virtual \
                 monitor, so it takes them for each step as soon as the user's hands are still for a moment; \
                 nothing waits for fn. Carry on with what doesn't need the screen, then try the step again.",
                SHARE_WAIT.as_secs()
            ));
        }
        Self::not_yours(reason)
    }

    /// What a screen action says when the agent doesn't have the mouse and keyboard.
    pub fn not_yours(reason: &str) -> Value {
        if crate::vhid::took_over(Some(reason)) || reason == "busy" {
            let how = if crate::vhid::HUMAN_SOURCES.contains(&reason) {
                "took over"
            } else {
                "is using them"
            };
            return error_text(format!(
                "The user {how} the mouse and keyboard ({}), so screen actions wait until they press fn. Don't stop \
                 working: carry on with everything that doesn't need the screen (the shell, files, APIs, reading \
                 what you already have). Call wait_for_control only when the screen is the one way forward, then \
                 look at the new screenshot before acting; things may have changed.",
                reason.replace('_', " ")
            ));
        }
        error_text(format!(
            "You don't have the mouse and keyboard ({reason}). Work without the screen, or call wait_for_control."
        ))
    }

    /// Ends this task's hold on the Mac: the idle thread stops and the helper connection closes.
    pub fn close(&self) {
        self.control.close();
        self.mac.close();
    }

    // -- seeing --

    /// A screenshot (JPEG, the mouse pointer drawn in) and a line about it, after `note`.
    /// `context`: also list every open window and the browsers' tabs, for the first look at a task.
    pub fn look_note(&self, note: &str, context: bool) -> Result<Value, String> {
        let g = geometry(&*self.system);
        let shown = self.system.windows();
        let tabs = context.then(|| {
            let (tx, rx) = mpsc::channel();
            let (system, listed) = (self.system.clone(), shown.clone());
            std::thread::spawn(move || {
                let _ = tx.send(system.browser_tabs(&listed)); // while the screenshot is taken
            });
            rx
        });
        let jpeg = self
            .system
            .capture(g.width, g.height, true, Format::Jpeg(JPEG_QUALITY))?;
        let (x, y) = self.system.cursor();
        let (cx, cy) = g.from_screen(x, y);
        let app = self.system.frontmost_app();
        let front = shown
            .iter()
            .find(|w| w.app == app && w.on_screen && !w.title.is_empty());
        let where_ = if self.system.virtual_monitor().is_some() {
            "Screenshot of the virtual monitor, "
        } else {
            "Screenshot "
        };
        let mut summary = format!(
            "{where_}{}x{} px. Mouse pointer at ({}, {}). Frontmost app: {app}{}.",
            g.width,
            g.height,
            fmt0(cx),
            fmt0(cy),
            front
                .map(|w| format!(", window {}", json_quote(&w.title)))
                .unwrap_or_default()
        );
        if self.system.windows_on_virtual_monitor() == Some(0) {
            summary.push_str(EMPTY_MONITOR);
        }
        if let Some(rx) = tabs {
            let tabs = rx.recv_timeout(Duration::from_secs(2)).unwrap_or_default();
            summary.push('\n');
            summary.push_str(&desktop::describe(&shown, &tabs));
        }
        let said = if note.is_empty() {
            summary
        } else {
            format!("{note}\n{summary}")
        };
        Ok(result(
            vec![text(said), image_bytes("image/jpeg", &jpeg)],
            false,
        ))
    }

    /// Words on screen, with positions converted to screenshot pixels.
    pub fn boxes(&self) -> Result<Vec<TextBox>, VhidError> {
        let g = geometry(&*self.system);
        Ok(self
            .mac
            .read_screen(None)?
            .into_iter()
            .map(|b| {
                let (x, y) = g.from_screen(b.x, b.y);
                TextBox {
                    x,
                    y,
                    w: b.w / g.scale,
                    h: b.h / g.scale,
                    ..b
                }
            })
            .collect())
    }

    // -- acting --

    /// Does `act` with the mouse and keyboard, then looks (unless `args.screenshot` is false).
    /// The human taking over, or the helper refusing, is a tool error the model can act on.
    pub fn act(
        &self,
        args: &Value,
        act: impl FnOnce() -> Result<(), VhidError>,
        done: &str,
    ) -> Result<Value, String> {
        if let Some(refused) = self.check_step(args) {
            return Ok(refused);
        }
        let acted = {
            let _acting = lock(&self.control.acting);
            let acted = (|| {
                if let Some(why_not) = self.take()? {
                    return Ok(Some(why_not));
                }
                if let Some(b) = self.system.virtual_monitor() {
                    let (x, y) = self.system.cursor();
                    if !inside(b, x, y) {
                        self.system.warp(b.0 + b.2 / 2.0, b.1 + b.3 / 2.0);
                        std::thread::sleep(Duration::from_millis(300)); // macOS ignores mouse moves for a moment after
                    }
                }
                act().map(|_| None)
            })();
            self.control.acted();
            acted
        };
        match acted {
            Ok(None) => {}
            Ok(Some(why_not)) => return Ok(self.not_now(&why_not)),
            Err(VhidError::Disengaged(e)) => {
                let reason = e
                    .find("reason=")
                    .map(|at| {
                        e[at + 7..]
                            .chars()
                            .take_while(|c| c.is_alphanumeric() || *c == '_' || *c == '-')
                            .collect::<String>()
                    })
                    .filter(|r| !r.is_empty())
                    .unwrap_or_else(|| "unknown".into());
                if self.control.sharing() && crate::vhid::took_over(Some(&reason)) {
                    self.control.give_back();
                    return Ok(error_text(
                        "The user touched the mouse or keyboard during this step, so it may be only partly done. Look at \
                         the screen and do what's left: the next step takes the mouse and keyboard back as soon as \
                         their hands are still. Nothing waits for fn.",
                    ));
                }
                return Ok(Self::not_yours(&reason));
            }
            Err(VhidError::Io(e)) => return Err(e),
            Err(e) => return Ok(error_text(format!("Failed: {e}"))),
        }
        if args.get("screenshot").map(truthy).unwrap_or(true) {
            std::thread::sleep(SETTLE);
            return self.look_note(done, false);
        }
        Ok(ok_text(done))
    }

    /// Moves the app that just came to the front onto the virtual monitor (nothing while it is
    /// off). An app that was already open gets a new window first where that is safe, so a window
    /// the user is using stays where they left it.
    pub fn to_virtual_monitor(
        &self,
        before: Option<i32>,
        running: &HashSet<String>,
        new_window: bool,
    ) -> Result<(), VhidError> {
        if self.system.virtual_monitor().is_none() {
            return Ok(());
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut pid = self.system.frontmost_pid();
        while pid == before && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(250));
            pid = self.system.frontmost_pid();
        }
        let app = self.system.frontmost_app();
        if new_window && running.contains(&app) && NEW_WINDOW_APPS.contains(&app.as_str()) {
            self.mac.key("cmd+n")?;
            std::thread::sleep(Duration::from_millis(800));
        }
        if let Some(pid) = pid.filter(|p| *p != 0) {
            self.system.place_on_virtual_monitor(pid);
            std::thread::sleep(Duration::from_millis(400));
        }
        Ok(())
    }

    /// Runs one tool (MacTools.call). `Err` is what Python let escape as an exception.
    pub fn call_tool(&self, name: &str, a: &Value) -> Result<Value, String> {
        if name == "read_selected_text" {
            if truthy(a) {
                return Ok(error_text("This tool takes no arguments."));
            }
            return Ok(self.read_selected_text());
        }
        if name == "authenticate" {
            if truthy(a) {
                return Ok(error_text(
                    "Authentication takes no arguments; never pass a password.",
                ));
            }
            let _acting = lock(&self.control.acting);
            if self.take().map_err(|e| e.to_string())?.is_some() {
                return Ok(error_text(
                    "The user has control. Wait for control before authenticating.",
                ));
            }
            let keyboard = AgentVHID::new(self.mac.socket_path.clone(), 1.0, false)
                .with_system(self.system.clone());
            let said =
                credentials::authenticate_mac_with(&keyboard, &*self.native, &*self.caps_lock);
            self.control.acted();
            return Ok(match said {
                Ok(said) => ok_text(said),
                Err(CredentialError(e)) => error_text(e),
            });
        }
        let g = geometry(&*self.system);
        let at = |x_key: &str, y_key: &str| -> Result<(f64, f64), String> {
            Ok(g.to_screen(float(arg(a, x_key)?)?, float(arg(a, y_key)?)?))
        };
        match name {
            "screenshot" => self.look_note("", false),
            "click" => {
                let p = at("x", "y")?;
                if self.system.own_window_at(p.0, p.1) {
                    return Ok(error_text(format!(
                        "Not clicked: ({}, {}) is on Hive's own floating window, the card that shows what you're \
                         doing. It isn't part of the task, and its x would stop this task. Click the app you're \
                         working in instead; if the card covers what you need, scroll or move that window.",
                        py_str(&a["x"]),
                        py_str(&a["y"])
                    )));
                }
                let clicks = match a.get("clicks") {
                    Some(v) => int(v)?,
                    None => 1,
                };
                let button = str_or(a, "button", "left");
                let modifiers = a.get("modifiers").and_then(Value::as_str);
                let done = format!("Clicked ({}, {}).", py_str(&a["x"]), py_str(&a["y"]));
                self.act(
                    a,
                    || self.mac.click(Some(p), button, clicks, modifiers),
                    &done,
                )
            }
            "move_mouse" => {
                let (x, y) = at("x", "y")?;
                let done = format!("Mouse at ({}, {}).", py_str(&a["x"]), py_str(&a["y"]));
                self.act(a, || self.mac.move_to(x, y), &done)
            }
            "drag" => {
                let (x1, y1) = at("from_x", "from_y")?;
                let (x2, y2) = at("to_x", "to_y")?;
                self.act(a, || self.mac.drag(x1, y1, x2, y2, "left"), "Dragged.")
            }
            "scroll" => {
                let p = at("x", "y")?;
                let count = |key| {
                    a.get(key)
                        .map(int)
                        .transpose()
                        .map(|n| n.unwrap_or(0))
                        .map_err(VhidError::Invalid)
                };
                self.act(
                    a,
                    || self.mac.scroll(count("down")?, count("right")?, Some(p)),
                    "Scrolled.",
                )
            }
            "type_text" => {
                let t = text_arg(a, "text")?;
                self.act(a, || self.mac.type_text(t), "Typed.")
            }
            "press_key" => {
                let keys = text_arg(a, "keys")?;
                let done = format!("Pressed {keys}.");
                self.act(
                    a,
                    || {
                        let repeat = a
                            .get("repeat")
                            .map(int)
                            .transpose()
                            .map_err(VhidError::Invalid)?
                            .unwrap_or(1);
                        for _ in 0..repeat {
                            self.mac.key(keys)?;
                        }
                        Ok(())
                    },
                    &done,
                )
            }
            "open_app" => {
                let app = text_arg(a, "name")?;
                let on_monitor = if self.system.virtual_monitor().is_some() {
                    " Its window is on the virtual monitor."
                } else {
                    ""
                };
                let done = format!("Opened {} from Spotlight.{on_monitor}", py_repr(app));
                self.act(
                    a,
                    || {
                        let before = self.system.frontmost_pid();
                        let running: HashSet<String> =
                            self.system.windows().into_iter().map(|w| w.app).collect();
                        self.mac.key("cmd+space")?;
                        std::thread::sleep(Duration::from_millis(400));
                        self.mac.type_text(app)?;
                        std::thread::sleep(Duration::from_millis(600)); // Spotlight's top hit settles
                        self.mac.key("return")?;
                        std::thread::sleep(Duration::from_millis(500)); // the app starts coming up
                        self.to_virtual_monitor(
                            before,
                            &running,
                            !a["_same_window"].as_bool().unwrap_or(false),
                        )
                    },
                    &done,
                )
            }
            "wait" => {
                let seconds = float(arg(a, "seconds")?)?.min(30.0);
                if seconds < 0.0 {
                    return Err("sleep length must be non-negative".into());
                }
                std::thread::sleep(Duration::from_secs_f64(seconds));
                if a.get("screenshot").map(truthy).unwrap_or(true) {
                    self.look_note("", false)
                } else {
                    Ok(ok_text("Waited."))
                }
            }
            "wait_for_control" => {
                let timeout = match a.get("timeout_seconds") {
                    Some(v) => float(v)?,
                    None => 120.0,
                };
                {
                    let _acting = lock(&self.control.acting);
                    if self.take().map_err(|e| e.to_string())?.is_none() {
                        self.control.acted();
                        return self.look_note("You have the mouse and keyboard.", false);
                    }
                }
                if self.control.sharing() {
                    // nothing waits for fn here: take() already waited for the user's hands
                    return Ok(self.not_now("busy"));
                }
                self.system.notify(
                    "Hive needs the screen. Press fn when it can have the mouse and keyboard.",
                );
                let wait = Duration::try_from_secs_f64(timeout.max(0.0)).unwrap_or(Duration::MAX);
                if self
                    .mac
                    .wait_engaged(Some(wait), false)
                    .map_err(|e| e.to_string())?
                {
                    self.handed_back();
                    return self.look_note(
                        "You have the mouse and keyboard again. The user may have changed things; check this \
                         screenshot before continuing.",
                        false,
                    );
                }
                Ok(error_text(format!(
                    "The user hasn't handed the screen back after {} s. Finish what you can without it, then say \
                     where you got to and what needs the screen.",
                    fmt0(timeout)
                )))
            }
            "find_text" => self.find_text(text_arg(a, "text")?),
            "windows" => {
                let shown = self.system.windows();
                Ok(ok_text(desktop::describe(
                    &shown,
                    &self.system.browser_tabs(&shown),
                )))
            }
            "switch_window" => {
                self.switch_window(text_arg(a, "title")?, a.get("app").and_then(Value::as_str))
            }
            "read_screen" => self.read_screen(),
            "batch" => {
                if let Some(refused) = self.check_step(a) {
                    return Ok(refused);
                }
                run_batch(
                    &mut |n, args| self.call_tool(n, args),
                    &mut |note| self.look_note(note, false),
                    a,
                    &BATCHABLE,
                )
            }
            "read_clipboard" => {
                let clip = String::from_utf8_lossy(&self.system.clipboard()).into_owned();
                let offset = match a.get("offset") {
                    Some(v) if truthy(v) => int(v)?,
                    _ => 0,
                };
                Ok(ok_text(hive_common::ingest::clipboard_slice(&clip, offset)))
            }
            "read_ingested" => {
                let id = a
                    .get("id")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty());
                let part = match a.get("part") {
                    Some(v) if truthy(v) => int(v)?,
                    _ => 1,
                };
                Ok(ok_text(hive_common::ingest::read_part(id, part)))
            }
            _ => Ok(error_text(format!("Unknown tool {}", py_repr(name)))),
        }
    }

    /// The text selected in the focused app, from build/agent-vhid-selection.
    pub fn read_selected_text(&self) -> Value {
        let run = crate::process::run(
            &self.selection_tool,
            Vec::<&str>::new(),
            None,
            Some(Duration::from_secs(5)),
        );
        match run {
            Err(_) => error_text(
                "Couldn't read the selection. Build agent-vhid-selection and check Accessibility.",
            ),
            Ok(out) if !out.success() => {
                let why = out.stderr_text().trim().to_string();
                error_text(if why.is_empty() {
                    "The app didn't expose selected text.".to_string()
                } else {
                    why
                })
            }
            Ok(out) => ok_text(out.stdout_text()),
        }
    }

    /// Switches to the window's app with Spotlight if it isn't in front, then presses cmd+` (the
    /// app's next window) until the window is in front, like a person would.
    pub fn switch_window(&self, title: &str, app: Option<&str>) -> Result<Value, String> {
        let wanted = title.trim().to_lowercase();
        let of = app.unwrap_or("").trim().to_lowercase();
        let matches = |w: &Window| {
            !wanted.is_empty()
                && w.title.to_lowercase().contains(&wanted)
                && w.app.to_lowercase().contains(&of)
        };
        let shown = self.system.windows();
        let Some(target) = shown.iter().find(|w| matches(w)).cloned() else {
            return Ok(error_text(format!(
                "No open window has {} in its title.\n{}",
                py_repr(title),
                desktop::describe(&shown, &Vec::new())
            )));
        };
        if self.system.frontmost_app() != target.app {
            // (no new window: it's an open one that's wanted)
            let switched = self.call_tool(
                "open_app",
                &json!({"name": target.app, "screenshot": false, "_same_window": true}),
            )?;
            if hive_common::tools::is_error(&switched) {
                return Ok(switched);
            }
        }
        let tries = shown.iter().filter(|w| w.app == target.app).count() + 1;
        for _ in 0..tries {
            let front = desktop::front_window_in(&self.system.windows(), &target.app);
            if let Some(front) = front.filter(|f| matches(f)) {
                // On the virtual monitor, the agent sees and works there only: the window comes
                // over from the user's screen.
                let moved = self.system.virtual_monitor().is_some() && {
                    let why = self.system.place_on_virtual_monitor(front.pid);
                    why.is_empty()
                };
                std::thread::sleep(SETTLE);
                return self.look_note(
                    &format!(
                        "{}'s window {} is in front{}.",
                        target.app,
                        json_quote(&front.title),
                        if moved {
                            ", moved onto the virtual monitor"
                        } else {
                            ""
                        }
                    ),
                    false,
                );
            }
            let pressed = self.act(&json!({"screenshot": false}), || self.mac.key("cmd+`"), "")?;
            if hive_common::tools::is_error(&pressed) {
                return Ok(pressed);
            }
            std::thread::sleep(Duration::from_millis(300)); // the window comes forward
        }
        self.look_note(
            &format!(
                "Couldn't bring {} forward with cmd+` (it may be minimized or on another desktop). Try {}'s Window \
                 menu, which lists its windows.",
                json_quote(&target.title),
                target.app
            ),
            false,
        )
    }

    pub fn find_text(&self, phrase: &str) -> Result<Value, String> {
        let words: Vec<String> = phrase
            .to_lowercase()
            .split_whitespace()
            .map(str::to_string)
            .collect();
        if words.is_empty() {
            return Ok(error_text("Give some text to find."));
        }
        let boxes = match self.boxes() {
            Ok(b) => b,
            Err(e) => return Err(e.to_string()),
        };
        Ok(ok_text(find_in(&boxes, phrase, &words)))
    }

    pub fn read_screen(&self) -> Result<Value, String> {
        let boxes = self.boxes().map_err(|e| e.to_string())?;
        Ok(ok_text(read_lines(&boxes)))
    }
}

/// find_text's answer for these boxes (screenshot pixels).
pub fn find_in(boxes: &[TextBox], phrase: &str, words: &[String]) -> String {
    let strip = |s: &str| {
        s.to_lowercase()
            .trim_matches(|c| ".,:;!?".contains(c))
            .to_string()
    };
    let mut matches: Vec<(f64, f64, String)> = Vec::new();
    for (i, b) in boxes.iter().enumerate() {
        let run = &boxes[i..(i + words.len()).min(boxes.len())];
        if run.len() == words.len()
            && run.iter().all(|r| r.line == b.line)
            && run.iter().map(|r| strip(&r.text)).collect::<Vec<_>>() == words
        {
            let left = run[0].x;
            let top = run.iter().map(|r| r.y).fold(f64::INFINITY, f64::min);
            let right = run
                .iter()
                .map(|r| r.x + r.w)
                .fold(f64::NEG_INFINITY, f64::max);
            let bottom = run
                .iter()
                .map(|r| r.y + r.h)
                .fold(f64::NEG_INFINITY, f64::max);
            matches.push(((left + right) / 2.0, (top + bottom) / 2.0, b.line.clone()));
        }
    }
    let mut partial = false;
    if matches.is_empty() {
        // fall back to lines that contain the phrase
        partial = true;
        let mut seen: HashSet<(String, i64)> = HashSet::new();
        let lowered = phrase.to_lowercase();
        for b in boxes {
            let key = (b.line.clone(), py_round(b.y / 8.0) as i64);
            if b.line.to_lowercase().contains(&lowered) && !seen.contains(&key) {
                seen.insert(key);
                let line: Vec<&TextBox> = boxes
                    .iter()
                    .filter(|r| r.line == b.line && (r.y - b.y).abs() < 8.0)
                    .collect();
                let hits: Vec<&TextBox> = line
                    .iter()
                    .copied()
                    .filter(|r| r.text.to_lowercase().contains(&words[0]))
                    .collect();
                let first = hits.first().or(line.first()).expect("b is in its own line");
                matches.push((
                    first.x + first.w / 2.0,
                    first.y + first.h / 2.0,
                    b.line.clone(),
                ));
            }
        }
    }
    if matches.is_empty() {
        return format!(
            "{} is not visible on screen (text recognition found no match).",
            py_repr(phrase)
        );
    }
    let lines: Vec<String> = matches
        .iter()
        .take(12)
        .map(|(x, y, line)| format!("({}, {})  in line: {}", fmt0(*x), fmt0(*y), py_repr(line)))
        .collect();
    let head = if partial {
        "No exact match; lines containing it:".to_string()
    } else {
        format!("Found {} at:", py_repr(phrase))
    };
    format!("{head}\n{}", lines.join("\n"))
}

/// read_screen's answer for these boxes (screenshot pixels): one line of text per line on screen.
pub fn read_lines(boxes: &[TextBox]) -> String {
    let mut lines: Vec<((String, i64), Vec<&TextBox>)> = Vec::new();
    for b in boxes {
        let key = (b.line.clone(), py_round(b.y / 6.0) as i64);
        match lines.iter_mut().find(|(k, _)| *k == key) {
            Some((_, words)) => words.push(b),
            None => lines.push((key, vec![b])),
        }
    }
    let out: Vec<String> = lines
        .iter()
        .map(|((line, _), words)| {
            let left = words.iter().map(|w| w.x).fold(f64::INFINITY, f64::min);
            let top = words.iter().map(|w| w.y).fold(f64::INFINITY, f64::min);
            let right = words
                .iter()
                .map(|w| w.x + w.w)
                .fold(f64::NEG_INFINITY, f64::max);
            let bottom = words
                .iter()
                .map(|w| w.y + w.h)
                .fold(f64::NEG_INFINITY, f64::max);
            format!(
                "({}, {}) {line}",
                fmt0((left + right) / 2.0),
                fmt0((top + bottom) / 2.0)
            )
        })
        .collect();
    if out.is_empty() {
        return "No text recognized on screen.".into();
    }
    out.into_iter().take(400).collect::<Vec<_>>().join("\n")
}

impl ToolNamespace for MacTools {
    fn namespace(&self) -> &'static str {
        "mac"
    }
    fn about(&self) -> &'static str {
        ABOUT
    }
    fn tools(&self) -> Vec<Value> {
        tools()
    }
    fn call(&self, tool: &str, args: &Value) -> Result<Value, String> {
        self.call_tool(tool, args)
    }
    fn look(&self, context: bool) -> Result<Value, String> {
        self.look_note("", context)
    }
    fn close(&self) {
        MacTools::close(self);
    }
    fn set_words(&self, words: &str) {
        MacTools::set_words(self, words);
    }
    fn let_go(&self) {
        MacTools::let_go(self);
    }
    fn handed_back(&self) {
        MacTools::handed_back(self);
    }
    fn took_over(&self) {
        MacTools::took_over(self);
    }
}

impl Drop for MacTools {
    fn drop(&mut self) {
        self.control.close();
    }
}

// --- authentication_mcp.py: credential-free authentication tools, including for older
// persisted conversations. The combined server (with the phone's authenticate) is hive-app's. ---

/// The authentication server's name.
pub const AUTHENTICATION_SERVER_NAME: &str = "agent-authentication";

pub const AUTHENTICATION_INSTRUCTIONS: &str = "Use only for account sign-in/unlock explicitly relevant to the user \
     task. No secrets in arguments. A failed attempt is not retried. Authentication never authorizes sending \
     messages or making transactions.";

pub const UNKNOWN_AUTHENTICATION_TOOL: &str = "Unknown authentication tool.";

/// The Mac's part of the authentication tools: `authenticate_mac` and `read_selected_text`.
pub fn authentication_tools() -> (Value, Value) {
    let mut mac = authenticate_tool();
    mac["name"] = json!("authenticate_mac");
    (mac, read_selected_text_tool())
}

/// Calls the Mac's authentication tools by their authentication_mcp names (`authenticate_mac`,
/// `read_selected_text`); anything else is "Unknown authentication tool." (the phone's
/// `authenticate_phone` is the phone's).
pub fn call_authentication(tools: &MacTools, name: &str, args: &Value) -> Result<Value, String> {
    match name {
        "authenticate_mac" => tools.call_tool("authenticate", args),
        "read_selected_text" => tools.call_tool("read_selected_text", args),
        _ => Ok(error_text(UNKNOWN_AUTHENTICATION_TOOL)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn word(text: &str, line: &str, x: f64, y: f64) -> TextBox {
        TextBox {
            text: text.into(),
            line: line.into(),
            confidence: 1.0,
            x,
            y,
            w: 30.0,
            h: 10.0,
        }
    }

    #[test]
    fn finds_phrases_and_lines() {
        let boxes = [
            word("Sign", "Sign in now", 10.0, 100.0),
            word("in", "Sign in now", 50.0, 100.0),
            word("now", "Sign in now", 90.0, 100.0),
            word("Cancel", "Cancel", 10.0, 200.0),
        ];
        let words = |p: &str| {
            p.to_lowercase()
                .split_whitespace()
                .map(str::to_string)
                .collect::<Vec<_>>()
        };
        assert_eq!(
            find_in(&boxes, "sign in", &words("sign in")),
            "Found 'sign in' at:\n(45, 105)  in line: 'Sign in now'"
        );
        assert_eq!(
            find_in(&boxes, "in no", &words("in no")),
            "No exact match; lines containing it:\n(65, 105)  in line: 'Sign in now'"
        );
        assert_eq!(
            find_in(&boxes, "Help", &words("Help")),
            "'Help' is not visible on screen (text recognition found no match)."
        );
        assert_eq!(
            read_lines(&boxes),
            "(65, 105) Sign in now\n(25, 205) Cancel"
        );
        assert_eq!(read_lines(&[]), "No text recognized on screen.");
    }

    #[test]
    fn tool_list_matches_python() {
        let names: Vec<String> = tools()
            .iter()
            .map(|t| t["name"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(names.len(), 19);
        assert_eq!(
            names.first().map(String::as_str),
            Some("read_selected_text")
        );
        assert_eq!(names.last().map(String::as_str), Some("batch"));
        let batch = tools().pop().unwrap();
        assert!(batch["description"]
            .as_str()
            .unwrap()
            .contains(r#""text": "weather in Paris\n"}]. Stops"#));
        let (mac, selected) = authentication_tools();
        assert_eq!(mac["name"], "authenticate_mac");
        assert_eq!(selected["name"], "read_selected_text");
    }
}
