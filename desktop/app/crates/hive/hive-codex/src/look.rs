//! The first look at a request's device: a screenshot sent with the request so Codex can act
//! straight away instead of spending a step (seconds) asking to look.

use crate::util::{lock, monotonic, Event};
use hive_common::tools::ToolNamespace;
use serde_json::Value;
use std::sync::{Arc, Mutex};

/// Seconds a look taken as you started talking stays good for your request.
pub const LOOK_AHEAD_FRESH: f64 = 30.0;

/// A screenshot of the device right now: (the image as a data: URL, what the tools say about
/// it), or None if it can't be taken (agent.py's `first_look`). `context`: the Mac's tools also
/// list its open windows and browser tabs.
pub fn first_look(tools: &dyn ToolNamespace, context: bool) -> Option<(String, String)> {
    let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| tools.look(context)))
        .ok()?
        .ok()?;
    if hive_common::tools::is_error(&res) {
        return None;
    }
    let content = res.get("content").and_then(Value::as_array)?;
    let image = content
        .iter()
        .find(|c| c.get("type").and_then(Value::as_str) == Some("image"))?;
    let about: Vec<&str> = content
        .iter()
        .filter(|c| c.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|c| c.get("text").and_then(Value::as_str))
        .collect();
    let url = format!(
        "data:{};base64,{}",
        image.get("mimeType").and_then(Value::as_str)?,
        image.get("data").and_then(Value::as_str)?
    );
    Some((url, about.join(" ")))
}

type Seen = Option<(String, String)>;

/// The Mac's first look at a request (the screenshot, every window and the browsers' tabs),
/// taken in the background while you're still saying it: the voice agent starts one as you
/// start talking and gives it to the request's task (`TaskOptions::ahead`), which then goes to
/// Codex the moment you've finished instead of looking first (agent.py's `LookAhead`).
pub struct LookAhead {
    at: Mutex<f64>,
    seen: Mutex<Seen>,
    done: Event,
}

impl LookAhead {
    /// Looks with a fresh set of the Mac's tools (closed once it has looked).
    pub fn new(agent: &crate::Agent) -> Arc<LookAhead> {
        let tools = (agent.hooks.device_tools)();
        Self::taking(move || {
            let mac = tools.iter().find(|t| t.namespace() == "mac")?;
            let seen = first_look(mac.as_ref(), true);
            mac.close();
            seen
        })
    }

    /// Looks with `take` instead (Python's `LookAhead(take=...)`, for the tests).
    pub fn taking(take: impl FnOnce() -> Seen + Send + 'static) -> Arc<LookAhead> {
        let ahead = Arc::new(LookAhead {
            at: Mutex::new(monotonic()),
            seen: Mutex::new(None),
            done: Event::new(false),
        });
        let me = ahead.clone();
        std::thread::spawn(move || {
            let seen = std::panic::catch_unwind(std::panic::AssertUnwindSafe(take))
                .ok()
                .flatten();
            *lock(&me.seen) = seen;
            me.done.set();
        });
        ahead
    }

    /// The look, once it's taken (None if it couldn't be, or it's too old to trust).
    pub fn seen(&self) -> Seen {
        if monotonic() - *lock(&self.at) > LOOK_AHEAD_FRESH || !self.done.wait(Some(5.0)) {
            return None;
        }
        lock(&self.seen).clone()
    }

    /// When it started, on [`crate::monotonic`]'s clock.
    pub fn at(&self) -> f64 {
        *lock(&self.at)
    }

    /// Makes it `seconds` older (Python's `ahead.at -= ...`, for the tests).
    pub fn backdate(&self, seconds: f64) {
        *lock(&self.at) -= seconds;
    }
}
