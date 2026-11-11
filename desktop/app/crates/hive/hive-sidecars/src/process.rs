//! What the clients share about their child processes and JSON lines.

use serde_json::Value;
use std::io::{self, Write};
use std::process::{Child, ExitStatus};
use std::time::{Duration, Instant};

/// Python's `Popen.returncode`: the exit code, or minus the signal that ended it.
pub fn exit_code(status: ExitStatus) -> i32 {
    use std::os::unix::process::ExitStatusExt;
    status
        .code()
        .or_else(|| status.signal().map(|s| -s))
        .unwrap_or(-1)
}

/// The process's exit status, waiting at most `timeout` for it.
pub fn wait_timeout(child: &mut Child, timeout: Duration) -> Option<ExitStatus> {
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Some(status),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(10)),
            _ => return None,
        }
    }
}

/// Waits for it to exit, killing it if it hasn't within `timeout`.
pub fn reap(child: &mut Child, timeout: Duration) -> Option<ExitStatus> {
    wait_timeout(child, timeout).or_else(|| {
        let _ = child.kill();
        child.wait().ok()
    })
}

pub fn alive(child: &mut Child) -> bool {
    matches!(child.try_wait(), Ok(None))
}

/// One JSON object and a newline, flushed.
pub fn write_line(out: &mut impl Write, value: &Value) -> io::Result<()> {
    let mut line = serde_json::to_string(value).map_err(io::Error::other)?;
    line.push('\n');
    out.write_all(line.as_bytes())?;
    out.flush()
}

/// Python's truthiness of a JSON value.
pub fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0),
        Value::String(s) => !s.is_empty(),
        Value::Array(a) => !a.is_empty(),
        Value::Object(o) => !o.is_empty(),
    }
}

/// Runs a callback, keeping the thread that calls it alive if it panics.
pub fn guarded(what: &str, f: impl FnOnce()) {
    if std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).is_err() {
        eprintln!("hive-sidecars: the {what} callback panicked");
    }
}
