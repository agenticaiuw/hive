//! Tools that let Codex use the user's iPhone (python/phone_mcp.py): screenshots to see, taps,
//! swipes and typing to act. The Codex driver calls them in-process, alongside a Mac task if there
//! is one, so the voice agent can work on the phone while it, or you, use the Mac.
//!
//! Every coordinate is a point on the phone's screen, which is what the screenshots it returns are
//! measured in.

use crate::phone::{Phone, PhoneError};
use hive_common::mcp::{batch_tool, check_step, look_schema, step_schema};
use hive_common::tools::{
    error_text, image_bytes, is_error, ok_text, result, text, texts, ToolNamespace,
};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// Seconds for the phone's screen to catch up before the screenshot after an action.
pub const SETTLE: Duration = Duration::from_millis(400);
/// What a batch waits before its one closing look: mac_mcp.py's SETTLE, which `run_batch` used for
/// both devices.
pub const BATCH_SETTLE: Duration = Duration::from_millis(300);

pub const BATCHABLE: [&str; 7] = [
    "tap",
    "tap_element",
    "swipe",
    "type_text",
    "press_home",
    "open_app",
    "wait",
];

/// Signs in at a verified iPhone system passcode prompt with the saved device passcode
/// (python/credentials.py `authenticate_phone`). The app wires hive-mac's implementation; any `Err`
/// is reported to the model as "not confirmed" without detail.
pub trait PhoneAuthenticator: Send + Sync {
    fn authenticate_phone(&self, phone: &Phone) -> Result<String, String>;
}

const AUTH_FAILED: &str = "Phone authentication was not confirmed. Check that the WebDriverAgent relay app is online, \
the device passcode is configured in Agent → Authentication, and a system passcode prompt is visible. \
Do not retry a failed attempt; check the phone yourself.";

fn point(desc: &str) -> Value {
    json!({"type": "number", "description": desc})
}

/// The tool list, byte for byte python/phone_mcp.py's `TOOLS`.
pub fn tool_list() -> Vec<Value> {
    let look = look_schema();
    let step = step_schema();
    let mut tools = vec![
        json!({
            "name": "authenticate",
            "description": "Use the locally saved device passcode at a verified iPhone system passcode prompt. \
        Requires the configured phone to stay connected through the WebDriverAgent relay app. \
        Takes no secret arguments; this is not for app passwords or payments. \
        On a locked iPhone just call this: it wakes the screen and brings up the passcode keypad itself (the keypad \
        only stays up a few seconds, so don't swipe to it first). \
        Returns status only. If unavailable or rejected, stop and let the user authenticate; never retry or ask for the passcode in chat.",
            "inputSchema": {"type": "object", "properties": {}, "additionalProperties": false},
        }),
        json!({
            "name": "screenshot",
            "description": "See the iPhone's screen. Every x/y in the other tools is a point in this image.",
            "inputSchema": {"type": "object", "properties": {}},
        }),
        json!({
            "name": "tap",
            "description": "Tap the phone's screen at (x, y).",
            "inputSchema": {"type": "object", "properties": {
                "x": point("x in the latest phone screenshot"), "y": point("y in the latest phone screenshot"),
                "step": step, "screenshot": look,
            }, "required": ["step", "x", "y"]},
        }),
        json!({
            "name": "tap_element",
            "description": "Tap a button, link or field by its label (from elements, or the text on it). More \
        reliable than coordinates for small targets.",
            "inputSchema": {"type": "object", "properties": {"label": {"type": "string"}, "step": step,
                                                             "screenshot": look},
                            "required": ["step", "label"]},
        }),
        json!({
            "name": "swipe",
            "description": "Drag a finger from one point to another: to scroll a list swipe up (from_y > to_y), \
        to go back swipe right from the left edge, to search the home screen swipe down from \
        its middle.",
            "inputSchema": {"type": "object", "properties": {
                "from_x": point("Start x"), "from_y": point("Start y"), "to_x": point("End x"), "to_y": point("End y"),
                "screenshot": look,
            }, "required": ["from_x", "from_y", "to_x", "to_y"]},
        }),
        json!({
            "name": "type_text",
            "description": "Type into the field that has focus (tap it first). '\\n' presses Return.",
            "inputSchema": {"type": "object", "properties": {"text": {"type": "string"}, "step": step,
                                                             "screenshot": look},
                            "required": ["step", "text"]},
        }),
        json!({
            "name": "press_home",
            "description": "Go to the home screen of an unlocked iPhone. It checks first: on a locked iPhone it never \
        goes home (that freezes the phone's relay), it only wakes the screen; unlock with authenticate.",
            "inputSchema": {"type": "object", "properties": {"screenshot": look}},
        }),
        json!({
            "name": "open_app",
            "description": "Open an app by its bundle id, e.g. com.apple.mobilesafari, com.apple.MobileSMS, \
        com.apple.mobilenotes, com.apple.mobilemail, com.apple.Maps, com.apple.Preferences, \
        com.apple.camera, com.apple.mobilephone, com.google.chrome.ios. For an app whose id you \
        don't know, swipe down on the home screen and type its name.",
            "inputSchema": {"type": "object", "properties": {"bundle_id": {"type": "string"}, "screenshot": look},
                            "required": ["bundle_id"]},
        }),
        json!({
            "name": "elements",
            "description": "List what's on the phone's screen (buttons, fields, text) with the center of each, from \
        the accessibility tree: exact positions and labels for tap or tap_element.",
            "inputSchema": {"type": "object", "properties": {}},
        }),
        json!({
            "name": "wait",
            "description": "Wait for something on the phone to load, then look again.",
            "inputSchema": {"type": "object", "properties": {
                "seconds": {"type": "number", "minimum": 0.1, "maximum": 30}, "screenshot": look,
            }, "required": ["seconds"]},
        }),
    ];
    tools.push(batch_tool(
        &BATCHABLE,
        "[{\"tool\": \"tap\", \"x\": 220, \"y\": 90}, {\"tool\": \"type_text\", \"text\": \"pizza\\\\n\"}]",
    ));
    tools
}

/// python/phone_mcp.py `INSTRUCTIONS`: what the stand-alone MCP server said about itself.
pub const INSTRUCTIONS: &str = "Use the user's iPhone like a person: look with screenshot, act with tap, swipe and type_text (or \
several at once with batch). Coordinates are points in the phone screenshots. Give every action a `step` saying what \
it does; one that can't be undone starts with \"One-way:\" and quotes the user's words asking for it.";

/// The screenshot at one pixel per point, as JPEG: coordinates in it are what taps use.
pub fn shrink(png: &[u8], width: i64) -> Result<Vec<u8>, String> {
    let mut out: *mut u8 = std::ptr::null_mut();
    let mut length = 0usize;
    // SAFETY: png is valid for png.len() bytes and out/length are valid for writes; on success the
    // buffer is copied and released once with agent_phone_bytes_free.
    unsafe {
        let status = personal_agent_core::phone_transport::agent_phone_shrink(
            png.as_ptr(),
            png.len(),
            width,
            &mut out,
            &mut length,
        );
        if status < 0 {
            return Err("Phone screenshot conversion failed".into());
        }
        if status > 0 {
            return Err(format!(
                "Command 'sips' returned non-zero exit status {status}."
            ));
        }
        let bytes = std::slice::from_raw_parts(out, length).to_vec();
        personal_agent_core::phone_transport::agent_phone_bytes_free(out, length);
        Ok(bytes)
    }
}

/// Python's `repr()` of a str.
pub(crate) fn py_repr(s: &str) -> String {
    let quote = if s.contains('\'') && !s.contains('"') {
        '"'
    } else {
        '\''
    };
    let mut out = String::from(quote);
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c == quote => {
                out.push('\\');
                out.push(c);
            }
            c if (c as u32) < 0x20 || c as u32 == 0x7f => {
                out.push_str(&format!("\\x{:02x}", c as u32))
            }
            c => out.push(c),
        }
    }
    out.push(quote);
    out
}

/// Python's `str()` of a JSON value, for the confirmations ("Tapped (220, 90).").
fn py_str(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => "None".into(),
        Value::Bool(true) => "True".into(),
        Value::Bool(false) => "False".into(),
        other => other.to_string(),
    }
}

enum Fail {
    /// A `PhoneError`: reported to the model as an error result.
    Phone(PhoneError),
    /// Anything else (a bad argument, a failed conversion): the driver reports "Failed: ...".
    Other(String),
}

impl From<PhoneError> for Fail {
    fn from(e: PhoneError) -> Fail {
        Fail::Phone(e)
    }
}

fn arg<'a>(a: &'a Value, key: &str) -> Result<&'a Value, Fail> {
    a.get(key).ok_or_else(|| Fail::Other(format!("'{key}'")))
}

fn number(a: &Value, key: &str) -> Result<f64, Fail> {
    match arg(a, key)? {
        Value::Number(n) => Ok(n.as_f64().unwrap_or(0.0)),
        Value::String(s) => s
            .trim()
            .parse::<f64>()
            .map_err(|_| Fail::Other(format!("could not convert string to float: {}", py_repr(s)))),
        other => Err(Fail::Other(format!(
            "float() argument must be a string or a real number, not {other}"
        ))),
    }
}

fn string<'a>(a: &'a Value, key: &str) -> Result<&'a str, Fail> {
    arg(a, key)?
        .as_str()
        .ok_or_else(|| Fail::Other(format!("'{key}' must be a string")))
}

fn wants_look(a: &Value) -> bool {
    match a.get("screenshot") {
        None => true,
        Some(Value::Bool(b)) => *b,
        Some(Value::Null) => false,
        Some(Value::Number(n)) => n.as_f64() != Some(0.0),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

pub struct PhoneTools {
    phone: Mutex<Option<Arc<Phone>>>,
    /// What the user said in this conversation: a one-way step must quote it.
    words: Mutex<String>,
    authenticator: Option<Arc<dyn PhoneAuthenticator>>,
    settle: Duration,
}

impl Default for PhoneTools {
    fn default() -> Self {
        PhoneTools::new()
    }
}

impl PhoneTools {
    /// The phone is connected to on first use, from `PHONE_RELAY`; a `PhoneError` then is reported
    /// by `call`, as python did.
    pub fn new() -> PhoneTools {
        PhoneTools {
            phone: Mutex::new(None),
            words: Mutex::new(String::new()),
            authenticator: None,
            settle: SETTLE,
        }
    }

    pub fn with_phone(phone: Phone) -> PhoneTools {
        PhoneTools {
            phone: Mutex::new(Some(Arc::new(phone))),
            words: Mutex::new(String::new()),
            authenticator: None,
            settle: SETTLE,
        }
    }

    /// The `authenticate` tool's implementation (hive-mac's credentials).
    pub fn with_authenticator(mut self, authenticator: Arc<dyn PhoneAuthenticator>) -> PhoneTools {
        self.authenticator = Some(authenticator);
        self
    }

    /// How long to wait for the phone's screen before the screenshot after an action.
    pub fn with_settle(mut self, settle: Duration) -> PhoneTools {
        self.settle = settle;
        self
    }

    /// What the user asked for in this conversation lately: a one-way step must quote it.
    pub fn set_words(&self, words: &str) {
        *self.words.lock().unwrap() = words.to_string();
    }

    /// mac_mcp.py `check_step` against this conversation's words: the refusal, if any.
    pub fn check_step(&self, args: &Value) -> Option<Value> {
        check_step(args, &self.words.lock().unwrap())
    }

    pub fn phone(&self) -> Result<Arc<Phone>, PhoneError> {
        let mut slot = self.phone.lock().unwrap();
        if slot.is_none() {
            *slot = Some(Arc::new(Phone::new(None)?));
        }
        Ok(slot.as_ref().unwrap().clone())
    }

    /// A screenshot (JPEG, one pixel per point) and a line about it; `note` goes first.
    pub fn look_note(&self, note: &str) -> Result<Value, String> {
        self.look_inner(note).map_err(|f| match f {
            Fail::Phone(e) => e.0,
            Fail::Other(m) => m,
        })
    }

    fn look_inner(&self, note: &str) -> Result<Value, Fail> {
        let phone = self.phone()?;
        let png = phone.screenshot()?;
        let (width, height) = phone.size(Some(&png))?;
        let jpeg = shrink(&png, width).map_err(Fail::Other)?;
        let summary = format!(
            "Phone screenshot {width}x{height} points. In front: {}.",
            phone.front_app()
        );
        let line = if note.is_empty() {
            summary
        } else {
            format!("{note}\n{summary}")
        };
        Ok(result(
            vec![text(line), image_bytes("image/jpeg", &jpeg)],
            false,
        ))
    }

    fn act(
        &self,
        a: &Value,
        done: String,
        action: impl FnOnce(&Phone) -> Result<(), PhoneError>,
    ) -> Result<Value, Fail> {
        if let Some(refused) = self.check_step(a) {
            return Ok(refused);
        }
        action(&*self.phone()?)?;
        if wants_look(a) {
            std::thread::sleep(self.settle);
            return self.look_inner(&done);
        }
        Ok(ok_text(done))
    }

    /// `PhoneTools.call`: a `PhoneError` becomes an error result, anything else an `Err`.
    fn call_inner(&self, name: &str, a: &Value) -> Result<Value, String> {
        match self.run(name, a) {
            Ok(v) => Ok(v),
            Err(Fail::Phone(e)) => Ok(error_text(e.0)),
            Err(Fail::Other(m)) => Err(m),
        }
    }

    fn run(&self, name: &str, a: &Value) -> Result<Value, Fail> {
        if name == "authenticate" {
            if a.as_object().map(|o| !o.is_empty()).unwrap_or(!a.is_null()) {
                return Ok(error_text(
                    "Authentication takes no arguments; never pass a passcode.",
                ));
            }
            let confirmed =
                self.phone()
                    .map_err(|e| e.0)
                    .and_then(|phone| match &self.authenticator {
                        Some(auth) => auth.authenticate_phone(&phone),
                        None => Err("no authenticator".into()),
                    });
            return Ok(match confirmed {
                Ok(message) => ok_text(message),
                Err(why) => {
                    // The model only ever sees AUTH_FAILED. The reason goes to the Mac-side log
                    // (stderr) so a failed unlock can be fixed, with the relay's secrets masked.
                    let mut why = why;
                    if let Ok(phone) = self.phone() {
                        for secret in phone.secret_strings() {
                            why = why.replace(&secret, "[secret]");
                        }
                    }
                    eprintln!("phone authenticate was not confirmed: {why}");
                    error_text(AUTH_FAILED)
                }
            });
        }
        if name == "wait" {
            let seconds = number(a, "seconds")?.min(30.0);
            if seconds > 0.0 {
                std::thread::sleep(Duration::from_secs_f64(seconds));
            }
            return if wants_look(a) {
                self.look_inner("")
            } else {
                Ok(ok_text("Waited."))
            };
        }
        match name {
            "screenshot" => self.look_inner(""),
            "tap" => {
                let (x, y) = (number(a, "x")?, number(a, "y")?);
                let done = format!("Tapped ({}, {}).", py_str(&a["x"]), py_str(&a["y"]));
                self.act(a, done, |p| p.tap(x, y))
            }
            "tap_element" => {
                let label = string(a, "label")?.to_string();
                let done = format!("Tapped {}.", py_repr(&label));
                self.act(a, done, |p| p.tap_element(&label))
            }
            "swipe" => {
                let (fx, fy, tx, ty) = (
                    number(a, "from_x")?,
                    number(a, "from_y")?,
                    number(a, "to_x")?,
                    number(a, "to_y")?,
                );
                self.act(a, "Swiped.".into(), |p| p.swipe(fx, fy, tx, ty, 0.3))
            }
            "type_text" => {
                let typed = string(a, "text")?.to_string();
                self.act(a, "Typed.".into(), |p| p.type_text(&typed))
            }
            "press_home" => self.act(a, "Home screen.".into(), |p| p.home()),
            "open_app" => {
                let bundle = string(a, "bundle_id")?.to_string();
                self.act(a, format!("Opened {bundle}."), |p| p.open_app(&bundle))
            }
            "elements" => {
                let lines = self.phone()?.elements()?;
                Ok(ok_text(if lines.is_empty() {
                    "Nothing recognizable on screen.".to_string()
                } else {
                    lines
                        .iter()
                        .take(300)
                        .cloned()
                        .collect::<Vec<_>>()
                        .join("\n")
                }))
            }
            "batch" => match self.check_step(a) {
                Some(refused) => Ok(refused),
                None => self.batch(a).map_err(Fail::Other),
            },
            _ => Ok(error_text(format!("Unknown tool {}", py_repr(name)))),
        }
    }

    /// mac_mcp.py `run_batch`: the steps without screenshots, then one look.
    fn batch(&self, args: &Value) -> Result<Value, String> {
        let steps: Vec<Value> = match args.get("steps") {
            Some(Value::Array(steps)) => steps.clone(),
            _ => Vec::new(),
        };
        if steps
            .iter()
            .any(|s| s.get("tool").and_then(Value::as_str) == Some("authenticate"))
        {
            // Authentication is never chained with other actions. Alone, as the batch's only step
            // and with no arguments, it is the same as calling authenticate.
            let alone =
                steps.len() == 1 && steps[0].as_object().map(|o| o.len() == 1).unwrap_or(false);
            if !alone {
                return Ok(error_text(
                    "authenticate can't be combined with other steps or given arguments; \
send it as the only step: [{\"tool\": \"authenticate\"}].",
                ));
            }
            return self.call_inner("authenticate", &json!({}));
        }
        let mut done: Vec<&str> = Vec::new();
        for (i, step) in steps.iter().enumerate() {
            let Some(object) = step.as_object() else {
                return Err("batch steps must be objects".into());
            };
            let mut object = object.clone();
            let name = object
                .remove("tool")
                .and_then(|v| v.as_str().map(str::to_owned))
                .unwrap_or_default();
            let Some(known) = BATCHABLE.iter().find(|b| **b == name) else {
                return Ok(error_text(format!(
                    "Step {}: {} can't go in a batch (use one of {}).",
                    i + 1,
                    py_repr(&name),
                    BATCHABLE.join(", ")
                )));
            };
            object.insert("screenshot".into(), Value::Bool(false));
            let res = self.call_inner(&name, &Value::Object(object))?;
            if is_error(&res) {
                let before = if done.is_empty() {
                    String::new()
                } else {
                    format!(" after {}", done.join(", "))
                };
                return Ok(error_text(format!(
                    "Step {} ({}) failed{}: {}",
                    i + 1,
                    name,
                    before,
                    texts(&res)
                )));
            }
            done.push(known);
        }
        let note = format!("Did {} steps: {}.", done.len(), done.join(", "));
        if wants_look(args) {
            std::thread::sleep(self.settle.min(BATCH_SETTLE));
            return self.look_inner(&note).or_else(|f| match f {
                Fail::Phone(e) => Ok(error_text(e.0)),
                Fail::Other(m) => Err(m),
            });
        }
        Ok(ok_text(note))
    }
}

impl ToolNamespace for PhoneTools {
    fn namespace(&self) -> &'static str {
        "phone"
    }

    fn about(&self) -> &'static str {
        "The user's iPhone: see its screen and tap, swipe and type."
    }

    fn tools(&self) -> Vec<Value> {
        tool_list()
    }

    fn call(&self, tool: &str, args: &Value) -> Result<Value, String> {
        self.call_inner(tool, args)
    }

    fn set_words(&self, words: &str) {
        PhoneTools::set_words(self, words);
    }

    fn look(&self, _context: bool) -> Result<Value, String> {
        match self.look_inner("") {
            Ok(v) => Ok(v),
            Err(Fail::Phone(e)) => Ok(error_text(e.0)),
            Err(Fail::Other(m)) => Err(m),
        }
    }
}
