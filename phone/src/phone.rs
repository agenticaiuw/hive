//! The iPhone's tools, through Hive Phone's WebSocket (link.rs) to Hive Phone's own runner, which answers as WebDriverAgent does (ios/HivePhone/Runner.swift).
use crate::link;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub struct Phone {
    state: PathBuf,
    sid: Mutex<Option<String>>,
    scale: Mutex<Option<f64>>,
}

const DOWN: &str = "The iPhone isn't connected to Hive: Hive Phone has to be open on it. The owner needs to open Hive Phone on the iPhone.";
const PROMPT: &str = "type == 'XCUIElementTypeStaticText' AND visible == 1 AND (label CONTAINS[c] 'enter passcode' OR label CONTAINS[c] 'enter iphone passcode')";
const NOT_THE_LOCK_SCREEN: [&str; 13] = ["incorrect", "try again", "failed", "attempts remaining", "unavailable", "disabled", "new passcode",
    "change passcode", "reset", "erase", "payment", "pay ", "purchase"];
pub const PASSCODE: &str = "phone-passcode";
pub const PAUSED: &str = "phone-unlock-paused";

fn nothing_entered(why: &str) -> String { format!("{why} No passcode was entered.") }
fn sleep(ms: u64) { std::thread::sleep(Duration::from_millis(ms)) }

/// A WebDriverAgent call's JSON, or what went wrong in words.
pub fn wda(path: &str, method: &str, body: Option<Value>, secs: u64) -> Result<Value, String> {
    let fail = match link::call(method, path, &body.map(|b| b.to_string()).unwrap_or_default(), secs) {
        Err(e) => Err(e),
        Ok((st, text)) => {
            let v: Value = serde_json::from_str(&text).unwrap_or(json!({}));
            if !v["value"]["error"].is_null() { Err(v["value"]["message"].as_str().or(v["value"]["error"].as_str()).unwrap_or("phone error").to_string()) }
            else if st >= 400 { Err(v["error"].as_str().unwrap_or("phone command failed").to_string()) } else { Ok(v) }
        }
    };
    fail.map_err(|f| {
        let l = f.to_lowercase();
        if ["offline", "disconnected", "not connected", "unavailable"].iter().any(|w| l.contains(w)) { return DOWN.into(); }
        if l.contains("timed out") { return format!("The iPhone did not finish {method} {path} within {secs}s. It may still complete; inspect the screen before retrying."); }
        f.lines().next().unwrap_or("").chars().take(300).collect()
    })
}

impl Phone {
    pub fn new(state: PathBuf) -> Phone {
        Phone { state, sid: Mutex::new(None), scale: Mutex::new(None) }
    }

    fn wda(&self, path: &str, method: &str, body: Option<Value>, secs: u64) -> Result<Value, String> { wda(path, method, body, secs) }

    fn session(&self) -> Result<String, String> {
        if let Some(s) = self.sid.lock().unwrap().clone() { return Ok(s); }
        let st = self.wda("/status", "GET", None, 30)?;
        let sid = match st["sessionId"].as_str() {
            Some(s) => s.to_string(),
            None => {
                let m = self.wda("/session", "POST", Some(json!({ "capabilities": { "alwaysMatch": { "shouldWaitForQuiescence": false } } })), 60)?;
                m["sessionId"].as_str().or(m["value"]["sessionId"].as_str()).ok_or("the phone relay gave no session")?.to_string()
            }
        };
        *self.sid.lock().unwrap() = Some(sid.clone());
        Ok(sid)
    }

    fn in_session(&self, path: &str, method: &str, body: Option<Value>, secs: u64) -> Result<Value, String> {
        let sid = self.session()?;
        match self.wda(&format!("/session/{sid}{path}"), method, body.clone(), secs) {
            Err(e) if e.to_lowercase().contains("session") => {
                *self.sid.lock().unwrap() = None;
                let sid = self.session()?;
                self.wda(&format!("/session/{sid}{path}"), method, body, secs)
            }
            r => r,
        }
    }

    fn screenshot(&self) -> Result<String, String> {
        let v = self.wda("/screenshot", "GET", None, 45)?;
        let b64 = v["value"].as_str().filter(|s| !s.is_empty()).ok_or("the phone returned no screenshot")?.to_string();
        if let Some(head) = hive_protocol::b64::decode(&b64[..b64.len().min(44)]) {
            if head.len() >= 24 {
                let width = u32::from_be_bytes([head[16], head[17], head[18], head[19]]) as f64;
                if let Ok(w) = self.in_session("/window/size", "GET", None, 30) {
                    if let Some(pw) = w["value"]["width"].as_f64().filter(|x| *x > 0.0) { *self.scale.lock().unwrap() = Some(width / pw); }
                }
            }
        }
        Ok(format!("data:image/png;base64,{b64}"))
    }

    fn points(&self, x: f64, y: f64) -> Result<(i64, i64), String> {
        if self.scale.lock().unwrap().is_none() { self.screenshot()?; }
        let s = self.scale.lock().unwrap().unwrap_or(1.0);
        Ok(((x / s).round() as i64, (y / s).round() as i64))
    }

    fn locked(&self) -> Result<bool, String> {
        self.wda("/wda/locked", "GET", None, 30)?["value"].as_bool().ok_or("the iPhone didn't say whether it's locked".into())
    }

    // XCTest can wait for an app to become idle after applying an action. Its
    // completion must fit inside the phone tool's 180-second deadline.
    fn touch(&self, moves: Vec<Value>) -> Result<(), String> {
        self.in_session("/actions", "POST", Some(json!({ "actions": [{ "type": "pointer", "id": "finger",
            "parameters": { "pointerType": "touch" }, "actions": moves }] })), 120).map(|_| ())
    }

    /// The passcode the owner saved on the dashboard, if it's for this iPhone and the last try didn't go unconfirmed.
    fn passcode(&self) -> Result<String, String> {
        let saved: Value = std::fs::read(self.state.join(PASSCODE)).ok().and_then(|b| serde_json::from_slice(&b).ok())
            .ok_or_else(|| nothing_entered("No passcode is saved for this iPhone; the owner saves it on the dashboard (Nodes)."))?;
        if self.state.join(PAUSED).exists() {
            return Err(nothing_entered("Unlocking is paused after a try the iPhone didn't confirm: the owner checks the phone, then saves the passcode again on the dashboard (Nodes)."));
        }
        if self.wda("/wda/device/info", "GET", None, 30)?["value"]["uuid"] != saved["device"] {
            return Err(nothing_entered("Hive Phone was installed again since the passcode was saved; the owner saves it again on the dashboard (Nodes)."));
        }
        Ok(saved["passcode"].as_str().unwrap_or("").to_string())
    }

    /// Wake with the home button, swipe up from just above the bottom edge, wait for "Enter Passcode", check it's the system's
    /// plain unlock prompt with one secure field, then write the passcode into that field once. A try the phone doesn't
    /// confirm pauses unlocking, so it's never repeated unseen.
    fn unlock(&self) -> Result<(), String> {
        if !self.locked()? { return Ok(()); }
        let pin = self.passcode()?;
        let find = |q: &str| -> Result<Vec<Value>, String> {
            Ok(self.in_session("/elements", "POST", Some(json!({ "using": "predicate string", "value": q })), 30)?["value"].as_array().cloned().unwrap_or_default())
        };
        if find(PROMPT)?.is_empty() {
            self.in_session("/wda/pressButton", "POST", Some(json!({ "name": "home" })), 30)?;
            sleep(400);
            let size = self.in_session("/window/size", "GET", None, 30)?;
            let (w, h) = (size["value"]["width"].as_f64().unwrap_or(0.0), size["value"]["height"].as_f64().unwrap_or(0.0));
            if !(w > 0.0 && h > 0.0) { return Err(nothing_entered("The iPhone gave no screen size.")); }
            let x = (w / 2.0).round();
            self.touch(vec![json!({ "type": "pointerMove", "duration": 0, "x": x, "y": (h - 11.0).round() }), json!({ "type": "pointerDown", "button": 0 }),
                json!({ "type": "pointerMove", "duration": 300, "x": x, "y": (h * 0.2).round() }), json!({ "type": "pointerUp", "button": 0 })])?;
            let until = Instant::now() + Duration::from_secs(6);
            loop {
                if !find(PROMPT)?.is_empty() { break; }
                if !self.locked()? { return Ok(()); }
                if Instant::now() > until { return Err(nothing_entered("The passcode keypad didn't come up after waking the iPhone and swiping up.")); }
                sleep(200);
            }
        }
        if self.wda("/wda/activeAppInfo", "GET", None, 30)?["value"]["bundleId"] != "com.apple.springboard" {
            return Err(nothing_entered("The iPhone isn't showing its system passcode screen."));
        }
        let labels = visible_labels(self.in_session("/source", "GET", None, 60)?["value"].as_str().unwrap_or(""));
        if NOT_THE_LOCK_SCREEN.iter().any(|w| labels.contains(w)) || !(labels.contains("enter passcode") || labels.contains("enter iphone passcode")) {
            return Err(nothing_entered("This isn't the plain unlock passcode prompt, or it shows a failed try."));
        }
        let fields = find("type == 'XCUIElementTypeSecureTextField' AND visible == 1")?;
        if fields.len() != 1 { return Err(nothing_entered("The passcode screen doesn't show exactly one passcode field.")); }
        let field = fields[0]["ELEMENT"].as_str().or(fields[0]["element-6066-11e4-a52e-4f735466cecf"].as_str())
            .filter(|f| !f.is_empty() && f.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-'))
            .ok_or_else(|| nothing_entered("Couldn't address the passcode field."))?.to_string();
        std::fs::write(self.state.join(PAUSED), "").map_err(|e| nothing_entered(&format!("Couldn't note the try ({e}).")))?;
        self.in_session(&format!("/element/{field}/value"), "POST", Some(json!({ "value": [pin] })), 30)?;
        for _ in 0..12 {
            sleep(500);
            if !self.locked()? { std::fs::remove_file(self.state.join(PAUSED)).ok(); return Ok(()); }
        }
        Err("The iPhone hasn't confirmed it's unlocked. Unlocking is paused: the owner checks the phone, then saves the passcode again on the dashboard (Nodes)".into())
    }

    pub fn call(&self, tool: &str, a: &Value) -> Result<Value, String> {
        let f = |k: &str| a[k].as_f64().unwrap_or(0.0);
        let shot = |msg: &str| -> Result<Value, String> {
            std::thread::sleep(Duration::from_millis(600));
            Ok(json!({ "text": msg, "images": [self.screenshot()?] }))
        };
        let op = if tool == "phone_input" { a["action"].as_str().unwrap_or("") } else { tool.strip_prefix("phone_").unwrap_or(tool) };
        match op {
            "unlock" => {
                let r = self.unlock();
                *self.sid.lock().unwrap() = None;
                r.map(|_| json!({ "text": "The iPhone is unlocked." }))
                    .map_err(|e| format!("The phone didn't unlock ({e}). Don't retry; stop using the phone and say why."))
            }
            "screenshot" => Ok(json!({ "text": "The iPhone's screen.", "images": [self.screenshot()?] })),
            "tap" => {
                let (x, y) = self.points(f("x"), f("y"))?;
                self.touch(vec![json!({ "type": "pointerMove", "duration": 0, "x": x, "y": y }), json!({ "type": "pointerDown", "button": 0 }),
                    json!({ "type": "pause", "duration": 60 }), json!({ "type": "pointerUp", "button": 0 })])?;
                shot("Tapped.")
            }
            "swipe" => {
                let (ax, ay) = self.points(f("x"), f("y"))?;
                let (bx, by) = self.points(f("to_x"), f("to_y"))?;
                self.touch(vec![json!({ "type": "pointerMove", "duration": 0, "x": ax, "y": ay }), json!({ "type": "pointerDown", "button": 0 }),
                    json!({ "type": "pointerMove", "duration": 300, "x": bx, "y": by }), json!({ "type": "pointerUp", "button": 0 })])?;
                shot("Swiped.")
            }
            "type" => {
                let chars: Vec<String> = a["text"].as_str().unwrap_or("").chars().map(String::from).collect();
                self.in_session("/wda/keys", "POST", Some(json!({ "value": chars })), 120)?;
                shot("Typed.")
            }
            "home" => {
                if self.locked()? { return Err("The iPhone is locked; call phone_unlock first.".into()); }
                self.wda("/wda/homescreen", "POST", Some(json!({})), 120)?;
                shot("Home screen.")
            }
            "open_app" => {
                if self.locked()? { return Err("The iPhone is locked; call phone_unlock first.".into()); }
                self.in_session("/wda/apps/activate", "POST", Some(json!({ "bundleId": a["bundle_id"] })), 120)?;
                shot("Opened.")
            }
            _ => Err(format!("no phone tool {tool}")),
        }
    }
}

/// The labels of the visible elements in WebDriverAgent's page source, lowercased.
fn visible_labels(tree: &str) -> String {
    let mut out = String::new();
    for tag in tree.split("<XCUIElementType").skip(1) {
        let tag = tag.split('>').next().unwrap_or("");
        let attr = |k: &str| tag.split(&format!(" {k}=\"")).nth(1).and_then(|v| v.split('"').next()).unwrap_or("").to_string();
        if attr("visible") == "true" { out += &attr("label").to_lowercase(); out.push(' '); }
    }
    out
}

#[cfg(test)]
mod tests {
    #[test]
    fn reads_visible_labels() {
        let tree = r#"<XCUIElementTypeStaticText type="x" label="Enter Passcode" visible="true"/><XCUIElementTypeButton label="Erase" visible="false"/>"#;
        assert_eq!(super::visible_labels(tree), "enter passcode ");
    }
}
