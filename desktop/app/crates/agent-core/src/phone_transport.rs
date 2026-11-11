//! Phone relay requests and WebDriver session management. No credentials are passed in argv.
use serde_json::{json, Value};
use std::{
    ffi::{CStr, CString},
    io::Write,
    process::{Command, Stdio},
    thread,
    time::Duration,
};

const OFFLINE: &str = "The iPhone isn't connected to its relay. On the iPhone (unlocked), run the Shortcut “Pocket Connect” to start its controller, then try again.";

fn request(
    input: &Value,
    path: &str,
    method: &str,
    body: &Value,
    sensitive: bool,
) -> Result<Value, String> {
    let folder = input["folder"].as_str().ok_or("Missing relay folder")?;
    let base = input["base"].as_str().ok_or("Missing relay endpoint")?;
    let secrets: Value = serde_json::from_slice(
        &std::fs::read(format!("{folder}/private/secrets.json"))
            .map_err(|_| "Can't read the phone relay credentials")?,
    )
    .map_err(|_| "Can't read the phone relay credentials")?;
    let token = secrets["CONTROL_TOKEN"]
        .as_str()
        .ok_or("Can't read the phone relay credentials")?;
    let mut config = format!(
        "header = {}\n",
        serde_json::to_string(&format!("Authorization: Bearer {token}")).unwrap()
    );
    if !body.is_null() {
        config.push_str(&format!(
            "data-binary = {}\n",
            serde_json::to_string(&body.to_string()).unwrap()
        ));
    }
    for attempt in 0..if sensitive { 1 } else { 5 } {
        let mut child = Command::new("curl")
            .args([
                "--ipv4",
                "--http1.1",
                "--connect-timeout",
                "8",
                "--max-time",
                "35",
                "--silent",
                "--show-error",
                "--user-agent",
                "Mozilla/5.0",
                "--config",
                "-",
                "--request",
                method,
                "--header",
                "Content-Type: application/json",
                "--write-out",
                "\n%{http_code}",
                &format!("{base}{path}"),
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|_| "Can't start the phone relay transport")?;
        child
            .stdin
            .take()
            .ok_or("Can't start the phone relay transport")?
            .write_all(config.as_bytes())
            .map_err(|_| "Can't send the phone relay request")?;
        let output = child
            .wait_with_output()
            .map_err(|_| "Can't receive the phone relay response")?;
        if !output.status.success() {
            if output.status.code() == Some(35) && attempt < 2 && !sensitive {
                thread::sleep(Duration::from_millis(400));
                continue;
            }
            if sensitive {
                return Err("Authentication transport failed; no automatic retry. Check the phone yourself.".into());
            }
            let err = String::from_utf8_lossy(&output.stderr);
            return Err(format!(
                "Can't reach the phone's relay ({}).",
                if err.trim().is_empty() {
                    output.status.to_string()
                } else {
                    err.trim().to_string()
                }
            ));
        }
        let out = String::from_utf8_lossy(&output.stdout);
        let (reply, status) = out
            .rsplit_once('\n')
            .ok_or("The relay returned an unreadable response")?;
        let value: Value = match serde_json::from_str(reply) {
            Ok(v) => v,
            Err(_) => {
                return Err(if sensitive {
                    "Authentication returned an unreadable response; no automatic retry.".into()
                } else {
                    format!(
                        "The relay answered HTTP {status}: {}",
                        reply.chars().take(200).collect::<String>()
                    )
                })
            }
        };
        if status == "429" && attempt < 4 && !sensitive {
            thread::sleep(Duration::from_millis(500 * (attempt + 1)));
            continue;
        }
        if status == "503" {
            return Err(OFFLINE.into());
        }
        if status == "504" {
            return Err("The iPhone didn't answer in time. Is it unlocked, with its controller app running?".into());
        }
        if status.parse::<u16>().unwrap_or(0) >= 400 {
            if sensitive {
                return Err("Authentication request was not confirmed; no automatic retry. Check the phone yourself.".into());
            }
            let e = value.get("error").unwrap_or(&value);
            return Err(format!(
                "The relay said HTTP {status}: {}",
                if let Some(s) = e.as_str() {
                    s.to_string()
                } else {
                    e.to_string()
                }
            ));
        }
        if let Some(error) = value
            .get("value")
            .and_then(|v| v.get("error"))
            .and_then(Value::as_str)
            .filter(|e| !e.is_empty())
        {
            if sensitive {
                return Err("Phone authentication was not confirmed; no automatic retry. Check the phone yourself.".into());
            }
            let msg = value["value"]["message"].as_str().unwrap_or("");
            return Err(format!("{error}: {msg}")
                .trim_end_matches([':', ' '])
                .into());
        }
        return Ok(value);
    }
    Err("The phone's relay stayed busy.".into())
}
fn session(input: &Value, sid: &mut Option<String>) -> Result<String, String> {
    if sid.is_none() {
        let status = request(input, "/api/status", "GET", &Value::Null, false)?;
        let mut id = status["sessionId"].as_str().map(str::to_owned);
        if id.is_none() {
            let made = request(
                input,
                "/api/session",
                "POST",
                &json!({"capabilities":{"alwaysMatch":{"shouldWaitForQuiescence":false}}}),
                false,
            )?;
            id = made["sessionId"]
                .as_str()
                .or_else(|| made["value"]["sessionId"].as_str())
                .map(str::to_owned);
        }
        *sid =
            Some(id.ok_or("The iPhone's controller has no session; run “Pocket Connect” again.")?);
        let _ = request(
            input,
            &format!("/api/session/{}/appium/settings", sid.as_ref().unwrap()),
            "POST",
            &json!({"settings":{"waitForIdleTimeout":0,"animationCoolOffTimeout":0}}),
            false,
        );
    }
    Ok(format!("/api/session/{}", sid.as_ref().unwrap()))
}

fn in_session(
    input: &Value,
    sid: &mut Option<String>,
    path: &str,
    method: &str,
    body: &Value,
) -> Result<Value, String> {
    let first = session(input, sid).and_then(|s| request(input, &(s + path), method, body, false));
    match first {
        Err(ref e) if e.to_lowercase().contains("session") => {
            *sid = None;
            session(input, sid).and_then(|s| request(input, &(s + path), method, body, false))
        }
        other => other,
    }
}

fn tap_element(input: &Value, sid: &mut Option<String>, body: &Value) -> Result<Value, String> {
    let label = body["label"].as_str().ok_or("Invalid phone label")?;
    let literal = body["literal"].as_str().ok_or("Invalid phone label")?;
    let first = in_session(
        input,
        sid,
        "/element",
        "POST",
        &json!({"using":"accessibility id", "value":label}),
    );
    let found = match first {
        Err(ref e)
            if e.to_lowercase().contains("unable to find")
                || e.to_lowercase().contains("no such element") =>
        {
            in_session(
                input,
                sid,
                "/element",
                "POST",
                &json!({"using":"predicate string", "value":format!("name == {literal} OR label == {literal}")}),
            )?
        }
        other => other?,
    };
    let element = found["value"]["ELEMENT"]
        .as_str()
        .filter(|s| !s.is_empty())
        .or_else(|| found["value"]["element-6066-11e4-a52e-4f735466cecf"].as_str());
    Ok(json!(element))
}

fn visible_elements(input: &Value, body: &Value) -> Result<Value, String> {
    use quick_xml::{events::Event, Reader};
    let mut source = body["source"]
        .as_str()
        .ok_or("Invalid phone accessibility source")?
        .to_string();
    if let Some(folder) = input["folder"].as_str() {
        if let Ok(bytes) = std::fs::read(format!("{folder}/private/secrets.json")) {
            if let Ok(Value::Object(secrets)) = serde_json::from_slice::<Value>(&bytes) {
                for secret in secrets
                    .values()
                    .filter_map(Value::as_str)
                    .filter(|s| s.chars().count() >= 16)
                {
                    source = source.replace(secret, "[hidden]");
                }
            }
        }
    }
    let mut reader = Reader::from_str(&source);
    let mut out = Vec::new();
    let mut depth = 0usize;
    let mut roots = 0usize;
    loop {
        let event = reader
            .read_event()
            .map_err(|_| "Invalid phone accessibility XML")?;
        let empty = matches!(event, Event::Empty(_));
        match event {
            Event::Start(e) | Event::Empty(e) => {
                if depth == 0 {
                    roots += 1;
                }
                if !empty {
                    depth += 1;
                }
                let name = e.name().as_ref().to_string();
                if name.contains(':') {
                    return Err("Phone accessibility XML requires Python parsing".into());
                }
                let mut attrs = std::collections::HashMap::new();
                for a in e.attributes() {
                    let a = a.map_err(|_| "Invalid phone accessibility XML")?;
                    let key = a.key.as_ref().to_string();
                    if key == "xmlns" || key.contains(':') {
                        return Err("Phone accessibility XML requires Python parsing".into());
                    }
                    let value = a
                        .normalized_value(quick_xml::XmlVersion::Implicit1_0)
                        .map_err(|_| "Invalid phone accessibility XML")?
                        .into_owned();
                    attrs.insert(key, value);
                }
                if attrs.get("visible").map(String::as_str) != Some("true")
                    || [
                        "AppiumAUT",
                        "XCUIElementTypeApplication",
                        "XCUIElementTypeWindow",
                    ]
                    .contains(&name.as_str())
                {
                    continue;
                }
                let label = attrs
                    .get("label")
                    .filter(|s| !s.is_empty())
                    .or_else(|| attrs.get("name"))
                    .map(String::as_str)
                    .unwrap_or("");
                if name == "XCUIElementTypeOther" && label.is_empty() {
                    continue;
                }
                let get = |key: &str| attrs.get(key).and_then(|s| s.parse::<f64>().ok());
                let (Some(x), Some(y), Some(w), Some(h)) =
                    (get("x"), get("y"), get("width"), get("height"))
                else {
                    continue;
                };
                let kind = name.strip_prefix("XCUIElementType").unwrap_or(&name);
                let label_short: String = label.chars().take(120).collect();
                let mut line = format!(
                    "({:.0}, {:.0}) {} {}",
                    x + w / 2.0,
                    y + h / 2.0,
                    kind,
                    serde_json::to_string(&label_short).unwrap()
                );
                if let Some(value) = attrs
                    .get("value")
                    .filter(|v| !v.is_empty() && v.as_str() != label && !kind.contains("Secure"))
                {
                    let short: String = value.chars().take(120).collect();
                    line.push_str(&format!(
                        " value={}",
                        serde_json::to_string(&short).unwrap()
                    ));
                }
                out.push(line);
            }
            Event::End(_) => {
                depth = depth
                    .checked_sub(1)
                    .ok_or("Invalid phone accessibility XML")?;
            }
            Event::Eof => break,
            Event::DocType(_) => {
                return Err("Phone accessibility XML requires Python parsing".into())
            }
            _ => {}
        }
    }
    if depth != 0 || roots != 1 {
        return Err("Invalid phone accessibility XML".into());
    }
    Ok(json!(out))
}

// Keep action construction independent of the relay so it can be tested without a device.
fn action_plan(body: &Value) -> Result<Value, String> {
    let args = &body["args"];
    let (path, request_body, in_session) = match body["name"].as_str().unwrap_or("") {
        "tap" => ("/wda/tap", json!({"x": args["x"], "y": args["y"]}), true),
        "swipe" => (
            "/wda/dragfromtoforduration",
            json!({
                "fromX": args["from_x"], "fromY": args["from_y"],
                "toX": args["to_x"], "toY": args["to_y"], "duration": args["seconds"]
            }),
            true,
        ),
        "type_text" => ("/wda/keys", json!({"value": [args["text"]]}), true),
        "home" => ("/api/wda/homescreen", json!({}), false),
        "open_app" => (
            "/wda/apps/activate",
            json!({"bundleId": args["bundle_id"]}),
            true,
        ),
        _ => return Err("Unknown phone action".into()),
    };
    Ok(json!({"path": path, "body": request_body, "in_session": in_session}))
}

fn execute(input: Value) -> Value {
    let mut sid = input["session"].as_str().map(str::to_owned);
    let path = input["path"].as_str().unwrap_or("");
    let method = input["method"].as_str().unwrap_or("GET");
    let body = &input["body"];
    let result = match input["operation"].as_str().unwrap_or("request") {
        "action_plan" => action_plan(body),
        "session" => session(&input, &mut sid).map(Value::String),
        "in_session" => in_session(&input, &mut sid, path, method, body),
        "tap_element" => tap_element(&input, &mut sid, body),
        "visible_elements" => visible_elements(&input, body),
        _ => request(
            &input,
            path,
            method,
            body,
            input["sensitive"].as_bool().unwrap_or(false),
        ),
    };
    match result {
        Ok(value) => json!({"value":value,"session":sid}),
        Err(error) => json!({"error":error,"session":sid}),
    }
}
/// Input and result are UTF-8 JSON, with ownership of the returned string transferred to the caller.
///
/// # Safety
/// `input` must be null or point to a valid NUL-terminated string for the duration of the call.
#[no_mangle]
pub unsafe extern "C" fn agent_phone_call(
    input: *const std::os::raw::c_char,
) -> *mut std::os::raw::c_char {
    if input.is_null() {
        return std::ptr::null_mut();
    }
    let result = std::panic::catch_unwind(|| {
        let input = CStr::from_ptr(input).to_bytes();
        let response = match serde_json::from_slice(input) {
            Ok(v) => execute(v),
            Err(_) => json!({"error":"Invalid phone request"}),
        };
        CString::new(response.to_string()).unwrap().into_raw()
    });
    result.unwrap_or(std::ptr::null_mut())
}
/// Release a response returned by `agent_phone_call`.
///
/// # Safety
/// `value` must be null or a pointer returned by `agent_phone_call` that has not been freed.
#[no_mangle]
pub unsafe extern "C" fn agent_phone_free(value: *mut std::os::raw::c_char) {
    if !value.is_null() {
        drop(CString::from_raw(value));
    }
}

/// Convert a PNG screenshot to a point-width JPEG using the platform image utility.
/// Returns zero on success, a positive utility exit status, or -1 on an I/O error.
///
/// # Safety
/// `png` must point to `png_len` readable bytes. `out` and `out_len` must be valid
/// writable pointers. On success, release the output once with `agent_phone_bytes_free`.
#[no_mangle]
pub unsafe extern "C" fn agent_phone_shrink(
    png: *const u8,
    png_len: usize,
    width: i64,
    out: *mut *mut u8,
    out_len: *mut usize,
) -> i32 {
    if png.is_null() || out.is_null() || out_len.is_null() {
        return -1;
    }
    let result = std::panic::catch_unwind(|| -> Result<i32, std::io::Error> {
        let dir = tempfile::Builder::new().prefix("phone-shot-").tempdir()?;
        let src = dir.path().join("s.png");
        let dst = dir.path().join("s.jpg");
        std::fs::write(&src, std::slice::from_raw_parts(png, png_len))?;
        let output = Command::new("sips")
            .args([
                "--resampleWidth",
                &width.to_string(),
                "-s",
                "format",
                "jpeg",
                "-s",
                "formatOptions",
                "75",
            ])
            .arg(&src)
            .arg("--out")
            .arg(&dst)
            .output()?;
        if !output.status.success() {
            return Ok(output.status.code().filter(|n| *n > 0).unwrap_or(1));
        }
        let mut bytes = std::fs::read(dst)?.into_boxed_slice();
        *out_len = bytes.len();
        *out = bytes.as_mut_ptr();
        std::mem::forget(bytes);
        Ok(0)
    });
    result
        .unwrap_or(Err(std::io::Error::other(
            "phone screenshot conversion failed",
        )))
        .unwrap_or(-1)
}

/// Release an output buffer returned by `agent_phone_shrink`.
///
/// # Safety
/// `ptr` and `len` must be exactly the values returned by a successful call and
/// the buffer must not have been freed already.
#[no_mangle]
pub unsafe extern "C" fn agent_phone_bytes_free(ptr: *mut u8, len: usize) {
    if !ptr.is_null() {
        drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(ptr, len)));
    }
}
