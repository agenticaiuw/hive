//! Clears an idle host-health latch on the virtual display engine before the workspace starts
//! (python/workspace_recovery.py).
//!
//! The engine stops creating virtual displays after it samples memory pressure, swap activity or
//! an unreadable health reading, and it stays stopped until someone runs
//! `spaceo safety clear-host-health --operator` by hand. That left the virtual monitor unavailable
//! after every such sample, so the app now runs the same command itself, once, at startup.
//!
//! The engine's command keeps all of its own checks: it refuses while a SpaceO display is online,
//! while another owner holds the journal, for any failure other than host health, and while the
//! host is unhealthy right now. Nothing here bypasses those; a refusal is reported and the
//! workspace start then fails the way it did before.

use serde_json::Value;
use std::io::Read;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// What one engine command returned: exit status, stdout, stderr.
pub type Output = (i32, String, String);

/// Runs `command` (program first) for at most `timeout` seconds. 124 means timed out, 127 that it
/// could not run (python's `_run`).
pub fn run_command(command: &[&str], timeout: u64) -> Output {
    let mut child = match Command::new(command[0])
        .args(&command[1..])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(e) => return (127, String::new(), e.to_string()),
    };
    fn drain(pipe: Option<impl Read + Send + 'static>) -> std::thread::JoinHandle<String> {
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            if let Some(mut pipe) = pipe {
                let _ = pipe.read_to_end(&mut bytes);
            }
            String::from_utf8_lossy(&bytes).into_owned()
        })
    }
    let out = drain(child.stdout.take());
    let err = drain(child.stderr.take());
    let deadline = Instant::now() + Duration::from_secs(timeout);
    let code = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.code().unwrap_or(-1),
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = out.join();
                let _ = err.join();
                return (124, String::new(), "timed out".into());
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
            Err(e) => return (127, String::new(), e.to_string()),
        }
    };
    (
        code,
        out.join().unwrap_or_default(),
        err.join().unwrap_or_default(),
    )
}

fn last_line(texts: &[&str]) -> String {
    for text in texts {
        let lines: Vec<&str> = text
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .collect();
        if let Some(line) = lines.last() {
            return line.chars().take(300).collect();
        }
    }
    String::new()
}

fn py_str(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => "None".into(),
        Some(Value::String(s)) => s.clone(),
        Some(other) => other.to_string(),
    }
}

/// Returns (outcome, detail). Outcomes: not-latched, cleared, refused, skipped.
pub fn recover_if_latched(spaceo: &str, run: &dyn Fn(&[&str], u64) -> Output) -> (String, String) {
    let skipped = |detail: &str| ("skipped".to_string(), detail.to_string());
    let (_, out, _) = run(&[spaceo, "doctor", "--json"], 45);
    let Ok(Value::Object(report)) = serde_json::from_str::<Value>(&out) else {
        return skipped("the engine's health report could not be read");
    };
    let empty = Value::Object(Default::default());
    let safety = report
        .get("displaySafety")
        .filter(|v| truthy(v))
        .unwrap_or(&empty);
    let state = safety.get("state");
    if state.and_then(Value::as_str) == Some("ready") {
        return ("not-latched".into(), String::new());
    }
    let reason = match safety.get("reason") {
        Some(v) if truthy(v) => py_str(Some(v)),
        _ => String::new(),
    };
    if state.and_then(Value::as_str) != Some("blocked") || !reason.starts_with("host health:") {
        return if reason.is_empty() {
            skipped(&format!("display safety state is {}", py_str(state)))
        } else {
            skipped(&reason)
        };
    }
    let online = report
        .get("displays")
        .filter(|v| truthy(v))
        .and_then(|d| d.get("spaceO"))
        .map(truthy)
        .unwrap_or(false);
    if online {
        return skipped(&format!(
            "{reason}; a virtual display is still online, so the engine will not clear it"
        ));
    }
    // An idle daemon is a journal owner; with no display online it has nothing to lose.
    run(&[spaceo, "daemon", "stop"], 30);
    let (code, out, err) = run(&[spaceo, "safety", "clear-host-health", "--operator"], 120);
    if code == 0 {
        return ("cleared".into(), reason);
    }
    let why = last_line(&[&err, &out]);
    let why = if why.is_empty() {
        format!("exit status {code}")
    } else {
        why
    };
    ("refused".into(), format!("{reason}; {why}"))
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64() != Some(0.0),
        Value::String(s) => !s.is_empty(),
        Value::Array(a) => !a.is_empty(),
        Value::Object(o) => !o.is_empty(),
    }
}
