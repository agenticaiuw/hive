//! The iPhone through its relay (python/phone.py): the iPhone runs WebDriverAgent inside its
//! controller app (the WebDriverAgent relay app, WebDriverAgentRunner-Runner), which keeps a connection open to a
//! Cloudflare Worker; this asks that Worker. `PHONE_RELAY` is the relay's folder: `endpoint.txt` has
//! its address, `private/secrets.json` its CONTROL_TOKEN (read when needed, never printed or passed
//! on a command line).

use serde_json::{json, Value};
use std::ffi::{CStr, CString};
use std::fmt;
use std::sync::Mutex;

pub const OFFLINE: &str = "The iPhone isn't connected to its relay. On the iPhone (unlocked), open the WebDriverAgent relay app (WebDriverAgentRunner-Runner), then try again.";

/// press_home on a locked iPhone (see [`Phone::home`]); it's also the line in Agent.log and the
/// session journal (the task's error event).
pub const LOCKED_HOME: &str =
    "press_home refused: the iPhone is locked, and going home on a locked iPhone freezes \
WebDriverAgent until the relay app is reopened, so no home-screen request was sent.";
pub const UNLOCK_STEPS: &str =
    "To unlock it, call authenticate: it brings up the passcode keypad itself and types the saved passcode.";
const LOCK_UNKNOWN: &str =
    "press_home refused: the iPhone didn't say whether it's locked, so no home-screen request \
was sent (on a locked iPhone that freezes WebDriverAgent). Look with screenshot or elements first.";

/// A failure the phone tools report to the model as an error result (python's `PhoneError`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PhoneError(pub String);

impl fmt::Display for PhoneError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for PhoneError {}

fn err<T>(message: impl Into<String>) -> Result<T, PhoneError> {
    Err(PhoneError(message.into()))
}

/// Where requests go. Production: agent-core's relay transport; tests: a fake.
pub trait Transport: Send + Sync {
    /// One JSON request in agent-core's phone transport protocol; `None` if it failed outright.
    fn call(&self, payload: &Value) -> Option<Value>;
}

/// agent-core's `agent_phone_call`, called in-process (python reached it through ctypes).
pub struct CoreTransport;

impl Transport for CoreTransport {
    fn call(&self, payload: &Value) -> Option<Value> {
        let input = CString::new(payload.to_string()).ok()?;
        // SAFETY: `input` is a valid NUL-terminated string for the whole call; the returned
        // pointer is read once and released with agent_phone_free.
        unsafe {
            let result = personal_agent_core::phone_transport::agent_phone_call(input.as_ptr());
            if result.is_null() {
                return None;
            }
            let parsed = serde_json::from_slice(CStr::from_ptr(result).to_bytes()).ok();
            personal_agent_core::phone_transport::agent_phone_free(result);
            parsed
        }
    }
}

#[derive(Default)]
struct State {
    session: Option<String>,
    size: Option<(i64, i64)>, // points
}

pub struct Phone {
    pub folder: String,
    pub base: String,
    transport: Box<dyn Transport>,
    state: Mutex<State>,
}

/// Python's `OSError.strerror`: the message without Rust's " (os error N)" suffix.
fn strerror(e: &std::io::Error) -> String {
    let text = e.to_string();
    match text.find(" (os error") {
        Some(at) => text[..at].to_string(),
        None => text,
    }
}

impl Phone {
    /// `folder`, else `PHONE_RELAY`. `PhoneError` when it isn't set up.
    pub fn new(folder: Option<&str>) -> Result<Phone, PhoneError> {
        Phone::with_transport(folder, Box::new(CoreTransport))
    }

    pub fn with_transport(
        folder: Option<&str>,
        transport: Box<dyn Transport>,
    ) -> Result<Phone, PhoneError> {
        let folder = folder
            .map(str::to_owned)
            .or_else(|| std::env::var("PHONE_RELAY").ok())
            .unwrap_or_default();
        if folder.is_empty() {
            return err("Phone control isn't set up: PHONE_RELAY (in .env) isn't set.");
        }
        let base = match std::fs::read_to_string(format!("{folder}/endpoint.txt")) {
            Ok(text) => text.trim().trim_end_matches('/').to_string(),
            Err(e) => {
                return err(format!(
                    "Phone control isn't set up: can't read the relay's endpoint.txt ({}).",
                    strerror(&e)
                ))
            }
        };
        Ok(Phone {
            folder,
            base,
            transport,
            state: Mutex::new(State::default()),
        })
    }

    fn secrets(&self) -> Option<Value> {
        let bytes = std::fs::read(format!("{}/private/secrets.json", self.folder)).ok()?;
        serde_json::from_slice(&bytes).ok()
    }

    pub(crate) fn secret_strings(&self) -> Vec<String> {
        match self.secrets() {
            Some(Value::Object(map)) => map
                .values()
                .filter_map(Value::as_str)
                .filter(|s| s.chars().count() >= 16)
                .map(str::to_owned)
                .collect(),
            _ => Vec::new(),
        }
    }

    fn call(
        &self,
        operation: &str,
        path: &str,
        method: &str,
        body: Value,
        sensitive: bool,
    ) -> Result<Value, PhoneError> {
        let session = self.state.lock().unwrap().session.clone();
        let payload = json!({"operation": operation, "folder": self.folder, "base": self.base,
                             "session": session, "path": path, "method": method,
                             "body": body, "sensitive": sensitive});
        let Some(mut response) = self.transport.call(&payload) else {
            return err("The phone relay transport failed.");
        };
        self.state.lock().unwrap().session = response
            .get("session")
            .and_then(Value::as_str)
            .map(str::to_owned);
        if let Some(error) = response.get("error") {
            return err(error
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| error.to_string()));
        }
        Ok(response
            .get_mut("value")
            .map(Value::take)
            .unwrap_or(Value::Null))
    }

    pub fn request(
        &self,
        path: &str,
        method: &str,
        body: Value,
        sensitive: bool,
    ) -> Result<Value, PhoneError> {
        self.call("request", path, method, body, sensitive)
    }

    pub fn connected(&self) -> Result<bool, PhoneError> {
        let health = self.request("/health", "GET", Value::Null, false)?;
        Ok(match health.get("connected") {
            Some(Value::Bool(b)) => *b,
            Some(Value::Null) | None => false,
            Some(Value::Number(n)) => n.as_f64() != Some(0.0),
            Some(Value::String(s)) => !s.is_empty(),
            Some(_) => true,
        })
    }

    /// The WebDriver session id, creating one if needed.
    pub fn session(&self) -> Result<String, PhoneError> {
        let value = self.call("session", "", "GET", Value::Null, false)?;
        match value {
            Value::String(s) => Ok(s),
            _ => err("The phone relay returned an invalid session."),
        }
    }

    pub fn in_session(&self, path: &str, method: &str, body: Value) -> Result<Value, PhoneError> {
        self.call("in_session", path, method, body, false)
    }

    // -- seeing --

    /// PNG, in pixels (3 per point on most iPhones).
    pub fn screenshot(&self) -> Result<Vec<u8>, PhoneError> {
        use base64::Engine;
        let reply = self.request("/api/screenshot", "GET", Value::Null, false)?;
        let data = reply["value"]
            .as_str()
            .ok_or_else(|| PhoneError("The phone returned no screenshot.".into()))?;
        base64::engine::general_purpose::STANDARD
            .decode(data)
            .map_err(|_| PhoneError("The phone returned an invalid screenshot.".into()))
    }

    /// The screen in points, which taps use. Asked again if the screenshot's shape changes (rotated).
    pub fn size(&self, png: Option<&[u8]>) -> Result<(i64, i64), PhoneError> {
        {
            let mut state = self.state.lock().unwrap();
            if let (Some(png), Some(size)) = (png, state.size) {
                if png.len() >= 24 {
                    let w = u32::from_be_bytes([png[16], png[17], png[18], png[19]]);
                    let h = u32::from_be_bytes([png[20], png[21], png[22], png[23]]);
                    if (w > h) != (size.0 > size.1) {
                        state.size = None;
                    }
                }
            }
            if let Some(size) = state.size {
                return Ok(size);
            }
        }
        let value = self.in_session("/window/size", "GET", Value::Null)?;
        let dim = |key: &str| {
            let v = &value["value"][key];
            v.as_i64().or_else(|| v.as_f64().map(|f| f as i64))
        };
        let (Some(w), Some(h)) = (dim("width"), dim("height")) else {
            return err("The phone returned no screen size.");
        };
        self.state.lock().unwrap().size = Some((w, h));
        Ok((w, h))
    }

    pub fn front_app(&self) -> String {
        let Ok(reply) = self.request("/api/wda/activeAppInfo", "GET", Value::Null, false) else {
            return "unknown".into();
        };
        let value = &reply["value"];
        if !value.is_object() {
            return "unknown".into();
        }
        let name = value["name"]
            .as_str()
            .filter(|s| !s.is_empty())
            .unwrap_or("?");
        let bundle = match &value["bundleId"] {
            Value::Null => "None".to_string(),
            Value::String(s) => s.clone(),
            other => other.to_string(),
        };
        format!("{name} ({bundle})")
    }

    /// The visible things on screen: `(x, y) Button "Send"`, with x, y its center in points.
    pub fn elements(&self) -> Result<Vec<String>, PhoneError> {
        let reply = self.in_session("/source", "GET", Value::Null)?;
        let Some(source) = reply["value"].as_str() else {
            return err("Invalid phone accessibility source");
        };
        match self.call(
            "visible_elements",
            "",
            "GET",
            json!({"source": source}),
            false,
        ) {
            Ok(Value::Array(lines)) => Ok(lines
                .into_iter()
                .filter_map(|l| l.as_str().map(str::to_owned))
                .collect()),
            Ok(_) => err("Invalid phone accessibility XML"),
            Err(e) if e.0 == "Phone accessibility XML requires Python parsing" => {
                crate::elements::visible_elements(source, &self.secret_strings())
            }
            Err(e) => Err(e),
        }
    }

    // -- acting --

    fn action(&self, name: &str, args: Value) -> Result<(), PhoneError> {
        let plan = self.call(
            "action_plan",
            "",
            "GET",
            json!({"name": name, "args": args}),
            false,
        )?;
        let path = plan["path"].as_str().unwrap_or("").to_string();
        let body = plan["body"].clone();
        if plan["in_session"].as_bool().unwrap_or(false) {
            self.in_session(&path, "POST", body)?;
        } else {
            self.request(&path, "POST", body, false)?;
        }
        Ok(())
    }

    pub fn tap(&self, x: f64, y: f64) -> Result<(), PhoneError> {
        self.action("tap", json!({"x": x, "y": y}))
    }

    pub fn tap_element(&self, label: &str) -> Result<(), PhoneError> {
        let literal = serde_json::to_string(label).unwrap_or_default();
        let element = self.call(
            "tap_element",
            "",
            "GET",
            json!({"label": label, "literal": literal}),
            false,
        )?;
        match element.as_str() {
            Some(id) if is_element_id(id) => {
                self.in_session(&format!("/element/{id}/click"), "POST", json!({}))?;
                Ok(())
            }
            _ => err(format!("Nothing called {literal} on screen.")),
        }
    }

    pub fn swipe(
        &self,
        from_x: f64,
        from_y: f64,
        to_x: f64,
        to_y: f64,
        seconds: f64,
    ) -> Result<(), PhoneError> {
        self.action(
            "swipe",
            json!({"from_x": from_x, "from_y": from_y, "to_x": to_x, "to_y": to_y, "seconds": seconds}),
        )
    }

    pub fn type_text(&self, text: &str) -> Result<(), PhoneError> {
        self.action("type_text", json!({"text": text}))
    }

    /// Whether the iPhone is locked (WebDriverAgent's /wda/locked). Anything but a yes or a no is
    /// an error, so [`home`](Self::home) never guesses.
    pub fn locked(&self) -> Result<bool, PhoneError> {
        let reply = self.request("/api/wda/locked", "GET", Value::Null, false)?;
        reply["value"]
            .as_bool()
            .ok_or_else(|| PhoneError(LOCK_UNKNOWN.into()))
    }

    /// Lights the screen with the home button, as the relay's own unlock does on a locked iPhone:
    /// it stays locked, and WebDriverAgent keeps answering.
    pub fn wake(&self) -> Result<(), PhoneError> {
        self.in_session("/wda/pressButton", "POST", json!({"name": "home"}))?;
        Ok(())
    }

    /// Whether the system passcode keypad is up, by its "Enter Passcode" title: one small query
    /// (about 0.4 s), not the whole screen's description (about 2 s), so it can be asked often.
    pub fn passcode_prompt_showing(&self) -> Result<bool, PhoneError> {
        let found = self.in_session(
            "/elements",
            "POST",
            json!({"using": "predicate string",
                   "value": "type == 'XCUIElementTypeStaticText' AND visible == 1 AND \
(label CONTAINS[c] 'enter passcode' OR label CONTAINS[c] 'enter iphone passcode')"}),
        )?;
        Ok(found["value"].as_array().is_some_and(|a| !a.is_empty()))
    }

    /// On a locked iPhone, brings up the passcode keypad: wakes the screen, swipes up from the
    /// bottom edge and waits for the keypad (it takes about 3 s to show). An untouched iPhone keeps
    /// the keypad up only about 7 seconds before its screen sleeps again (measured 2026-11-13), so
    /// authenticate does this itself, right before it checks and types; when the model did it,
    /// a step or two earlier, the keypad was gone by the time authenticate looked. An unlocked
    /// iPhone, or one already showing the keypad, is left as it is.
    pub fn show_passcode_prompt(&self) -> Result<(), PhoneError> {
        use std::time::{Duration, Instant};
        if !self.locked()? || self.passcode_prompt_showing()? {
            return Ok(());
        }
        self.wake()?;
        std::thread::sleep(Duration::from_millis(400));
        let (width, height) = self.size(None)?;
        let (width, height) = (width as f64, height as f64);
        // From just above the bottom edge: closer than 4 points is the home-indicator gesture.
        self.swipe(width / 2.0, height - 11.0, width / 2.0, height * 0.2, 0.3)?;
        let until = Instant::now() + Duration::from_secs(6);
        while Instant::now() < until {
            if self.passcode_prompt_showing()? {
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(200));
        }
        err("The passcode keypad didn't come up after waking the iPhone and swiping up.")
    }

    /// The home screen, on an unlocked iPhone only. WebDriverAgent's homescreen call on a locked
    /// iPhone hangs it: the relay stays connected but every later request times out until the
    /// relay app is opened again (2026-11-12, 20:27). So it asks first; a locked iPhone only has
    /// its screen woken, and the model is told how to unlock it.
    pub fn home(&self) -> Result<(), PhoneError> {
        if self.locked()? {
            return err(match self.wake() {
                Ok(()) => format!("{LOCKED_HOME} It woke the screen instead. {UNLOCK_STEPS}"),
                Err(e) => format!(
                    "{LOCKED_HOME} Waking the screen didn't work either ({e}). {UNLOCK_STEPS}"
                ),
            });
        }
        self.action("home", json!({}))
    }

    pub fn open_app(&self, bundle_id: &str) -> Result<(), PhoneError> {
        let n = bundle_id.chars().count();
        let valid = (3..=200).contains(&n)
            && bundle_id
                .chars()
                .all(|c| c == '-' || c == '.' || is_word(c));
        if !valid {
            return err(format!(
                "{} isn't an app's bundle id (like com.apple.mobilesafari).",
                crate::tools::py_repr(bundle_id)
            ));
        }
        self.action("open_app", json!({"bundle_id": bundle_id}))
    }
}

/// Python's `\w` for str patterns: letters, digits and the underscore.
fn is_word(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// `re.fullmatch(r"[\w-]+", id)`.
fn is_element_id(id: &str) -> bool {
    !id.is_empty() && id.chars().all(|c| c == '-' || is_word(c))
}

/// `python phone.py`: is the phone connected? Exit status and the line to print.
pub fn status_line() -> (i32, String) {
    let phone = match Phone::new(None) {
        Ok(phone) => phone,
        Err(e) => return (1, e.0),
    };
    match phone.connected() {
        Ok(true) => {}
        Ok(false) => return (1, OFFLINE.to_string()),
        Err(e) => return (1, e.0),
    }
    match phone.size(None) {
        Ok((w, h)) => (
            0,
            format!(
                "Connected. Screen {w}x{h} points; in front: {}.",
                phone.front_app()
            ),
        ),
        Err(e) => (1, e.0),
    }
}
