//! The iPhone through its relay (WebDriverAgent on the phone behind it).
use serde_json::{json, Value};
use std::sync::Mutex;
use std::time::Duration;

pub struct Phone {
    sid: Mutex<Option<String>>,
    scale: Mutex<Option<f64>>,
}

const DOWN: &str = "The iPhone isn't connected to its relay: Hive Phone has to be open on it. The owner needs to open Hive Phone on the iPhone.";

impl Phone {
    pub fn new() -> Phone {
        Phone { sid: Mutex::new(None), scale: Mutex::new(None) }
    }

    fn config(&self) -> Result<(String, String), String> {
        let own = [hive_node::conf_path("phone-relay"), "/home/ubuntu/hive-vm-agent/state/phone-relay.json".into()].iter()
            .find_map(|p| std::fs::read_to_string(p).ok()).and_then(|t| serde_json::from_str::<Value>(&t).ok());
        if let Some(c) = own {
            return Ok((c["url"].as_str().unwrap_or("").trim_end_matches('/').to_string(), c["token"].as_str().unwrap_or("").to_string()));
        }
        let board = std::fs::read_to_string("/root/.config/hive/tasks.json").map_err(|_| "Hive has no phone relay configured".to_string())?;
        let c: Value = serde_json::from_str(&board).map_err(|e| e.to_string())?;
        Ok((format!("{}/v1/phone", c["url"].as_str().unwrap_or("").trim_end_matches('/')), c["token"].as_str().unwrap_or("").to_string()))
    }

    fn raw(&self, path: &str, method: &str, body: Option<Value>, secs: u64) -> Result<(u16, Value), String> {
        let (url, token) = self.config()?;
        let req = ureq::request(method, &format!("{url}{path}")).timeout(Duration::from_secs(secs))
            .set("authorization", &format!("Bearer {token}"));
        let res = match body { Some(b) => req.set("content-type", "application/json").send_string(&b.to_string()), None => req.call() };
        let parse = |r: ureq::Response| serde_json::from_str(&r.into_string().unwrap_or_default()).unwrap_or(json!({}));
        match res {
            Ok(r) => { let st = r.status(); Ok((st, parse(r))) }
            Err(ureq::Error::Status(st, r)) => Ok((st, parse(r))),
            Err(e) => Err(format!("Couldn't reach the phone relay: {e}")),
        }
    }

    fn wda(&self, path: &str, method: &str, body: Option<Value>, secs: u64) -> Result<Value, String> {
        let (st, v) = self.raw(&format!("/api{path}"), method, body, secs)?;
        let fail = if !v["value"]["error"].is_null() {
            Some(v["value"]["message"].as_str().or(v["value"]["error"].as_str()).unwrap_or("phone error").to_string())
        } else if st >= 400 { Some(v["error"].as_str().unwrap_or("phone command failed").to_string()) } else { None };
        if let Some(f) = fail {
            let l = f.to_lowercase();
            if ["offline", "disconnected", "not connected", "unavailable", "timed out"].iter().any(|w| l.contains(w)) { return Err(DOWN.into()); }
            return Err(f.lines().next().unwrap_or("").chars().take(300).collect());
        }
        Ok(v)
    }

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
        if let Some(head) = hive_node::b64::decode(&b64[..b64.len().min(44)]) {
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

    fn touch(&self, moves: Vec<Value>) -> Result<(), String> {
        self.in_session("/actions", "POST", Some(json!({ "actions": [{ "type": "pointer", "id": "finger",
            "parameters": { "pointerType": "touch" }, "actions": moves }] })), 30).map(|_| ())
    }

    pub fn call(&self, tool: &str, a: &Value) -> Result<Value, String> {
        let f = |k: &str| a[k].as_f64().unwrap_or(0.0);
        let shot = |msg: &str| -> Result<Value, String> {
            std::thread::sleep(Duration::from_millis(600));
            Ok(json!({ "text": msg, "images": [self.screenshot()?] }))
        };
        match tool {
            "phone_unlock" => {
                let (st, v) = self.raw("/agent/unlock-now", "POST", Some(json!({})), 150)?;
                *self.sid.lock().unwrap() = None;
                if v["unlocked"].as_bool() == Some(true) { return Ok(json!({ "text": "The iPhone is unlocked." })); }
                Err(format!("The phone didn't unlock ({}). Don't retry; stop using the phone and say why.", v["error"].as_str().map(String::from).unwrap_or(format!("relay said {st}"))))
            }
            "phone_screenshot" => Ok(json!({ "text": "The iPhone's screen.", "images": [self.screenshot()?] })),
            "phone_tap" => {
                let (x, y) = self.points(f("x"), f("y"))?;
                self.touch(vec![json!({ "type": "pointerMove", "duration": 0, "x": x, "y": y }), json!({ "type": "pointerDown", "button": 0 }),
                    json!({ "type": "pause", "duration": 60 }), json!({ "type": "pointerUp", "button": 0 })])?;
                shot("Tapped.")
            }
            "phone_swipe" => {
                let (ax, ay) = self.points(f("x"), f("y"))?;
                let (bx, by) = self.points(f("to_x"), f("to_y"))?;
                self.touch(vec![json!({ "type": "pointerMove", "duration": 0, "x": ax, "y": ay }), json!({ "type": "pointerDown", "button": 0 }),
                    json!({ "type": "pointerMove", "duration": 300, "x": bx, "y": by }), json!({ "type": "pointerUp", "button": 0 })])?;
                shot("Swiped.")
            }
            "phone_type" => {
                let chars: Vec<String> = a["text"].as_str().unwrap_or("").chars().map(String::from).collect();
                self.in_session("/wda/keys", "POST", Some(json!({ "value": chars })), 60)?;
                shot("Typed.")
            }
            "phone_home" => {
                if self.locked()? { return Err("The iPhone is locked; call phone_unlock first.".into()); }
                self.wda("/wda/homescreen", "POST", Some(json!({})), 30)?;
                shot("Home screen.")
            }
            "phone_open_app" => {
                if self.locked()? { return Err("The iPhone is locked; call phone_unlock first.".into()); }
                self.in_session("/wda/apps/activate", "POST", Some(json!({ "bundleId": a["bundle_id"] })), 30)?;
                shot("Opened.")
            }
            _ => Err(format!("no phone tool {tool}")),
        }
    }
}
