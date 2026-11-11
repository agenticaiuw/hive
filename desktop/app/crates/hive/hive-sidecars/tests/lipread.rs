//! Lip reading's plumbing (tests/test_lipread.py) with a fake worker: no camera, model or download.

use hive_sidecars::lipread::{self, LipReader, LipReaderError};
use serde_json::{json, Value};
use std::ffi::OsString;
use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

const FAKE: &str = r#"
import json, sys
def say(**e): print(json.dumps(e), flush=True)
say(ready=True)
on = False
session = 0
for line in sys.stdin:
    msg = json.loads(line)
    if msg["command"] == "start":
        session = msg["session"]
        on = True; say(camera="on", session=session)
        say(partial="open", final=False, session=session)
        say(text="STALE", final=True, session=session-1)
    elif msg["command"] == "stop" and on:
        on = False; say(camera="off", session=session)
        say(session=session, **({"error": "camera denied"} if "FAIL" in sys.argv else {"text": " open safari "}))
"#;

/// The environment is the process's: tests that change it take turns.
static ENV: Mutex<()> = Mutex::new(());

fn env_lock() -> MutexGuard<'static, ()> {
    ENV.lock().unwrap_or_else(|e| e.into_inner())
}

fn python() -> OsString {
    std::env::var_os("HIVE_TEST_PYTHON").unwrap_or_else(|| "python3".into())
}

struct Fixture {
    dir: tempfile::TempDir,
}

impl Fixture {
    fn new() -> Fixture {
        let dir = tempfile::Builder::new().prefix("lips-").tempdir().unwrap();
        std::fs::write(dir.path().join("worker.py"), FAKE).unwrap();
        Fixture { dir }
    }

    fn path(&self) -> &Path {
        self.dir.path()
    }

    fn reader(&self, extra: &[&str]) -> (LipReader, Arc<Mutex<Vec<Value>>>) {
        let events = Arc::new(Mutex::new(Vec::new()));
        let into = events.clone();
        let mut command = vec![python(), self.path().join("worker.py").into_os_string()];
        command.extend(extra.iter().map(OsString::from));
        let reader = LipReader::with_command(command, self.path(), move |event| {
            into.lock().unwrap().push(event)
        });
        reader.set_log(self.path().join("agent-lipread.log"));
        (reader, events)
    }
}

#[test]
fn camera_only_between_start_and_stop() {
    let fixture = Fixture::new();
    let (reader, events) = fixture.reader(&[]);
    reader.start().unwrap();
    assert_eq!(
        reader.stop(Duration::from_secs(10)),
        Ok("open safari".into())
    );
    let seen = events.lock().unwrap().clone();
    assert!(
        seen.contains(&json!({"camera": "on", "session": 1})),
        "{seen:?}"
    );
    assert!(
        seen.contains(&json!({"camera": "off", "session": 1})),
        "{seen:?}"
    );
    assert!(
        seen.contains(&json!({"partial": "open", "final": false, "session": 1})),
        "{seen:?}"
    );
    assert!(
        !seen.iter().any(|e| e.get("text") == Some(&json!("STALE"))),
        "{seen:?}"
    );
    assert_eq!(reader.stop(lipread::STOP_TIMEOUT), Ok(String::new())); // not recording: nothing to read
    reader.start().unwrap(); // and again, the model loaded once
    assert_eq!(
        reader.stop(Duration::from_secs(10)),
        Ok("open safari".into())
    );
    assert_eq!(reader.session(), 2);
    reader.close();
}

#[test]
fn a_failure_says_why() {
    let fixture = Fixture::new();
    let (reader, _) = fixture.reader(&["FAIL"]);
    reader.start().unwrap();
    assert_eq!(
        reader.stop(Duration::from_secs(10)),
        Err(LipReaderError("camera denied".into()))
    );
    reader.close();
}

#[test]
fn a_worker_that_stops_says_so_and_the_camera_is_off() {
    let fixture = Fixture::new();
    std::fs::write(
        fixture.path().join("worker.py"),
        "import sys\nsys.stdin.readline()\nsys.stdin.readline()\nsys.exit(4)\n",
    )
    .unwrap();
    let (reader, events) = fixture.reader(&[]);
    reader.start().unwrap();
    assert_eq!(
        reader.stop(Duration::from_secs(10)),
        Err(LipReaderError("the lip reader stopped (exit 4)".into()))
    );
    std::thread::sleep(Duration::from_millis(100));
    assert_eq!(
        events.lock().unwrap().last(),
        Some(&json!({"camera": "off"}))
    );
    reader.close();
}

#[test]
fn a_worker_that_cant_start_says_why() {
    let fixture = Fixture::new();
    let reader = LipReader::with_command(
        vec![fixture.path().join("missing").into_os_string()],
        fixture.path(),
        |_| {},
    );
    reader.set_log(fixture.path().join("agent-lipread.log"));
    let error = reader.start().unwrap_err();
    assert!(
        error.0.starts_with("the lip reader isn't running ("),
        "{error}"
    );
    assert!(!reader.recording());
}

#[test]
fn voice_is_the_default_and_the_choice_is_kept() {
    let _env = env_lock();
    let fixture = Fixture::new();
    std::env::set_var("AGENT_STATE_DIR", fixture.path());
    std::env::set_var("LIPREAD_DIR", fixture.path().join("lipread"));
    assert_eq!(lipread::get_mode(), "voice");
    assert_eq!(lipread::set_mode("lips").unwrap(), "lips");
    assert_eq!(lipread::get_mode(), "lips");
    assert_eq!(
        std::fs::read_to_string(fixture.path().join("input-mode")).unwrap(),
        "lips"
    );
    let error = lipread::set_mode("telepathy").unwrap_err();
    assert_eq!(error.kind(), std::io::ErrorKind::InvalidInput);
    assert_eq!(error.to_string(), "input is one of voice, lips");
    std::env::remove_var("AGENT_STATE_DIR");
    std::env::remove_var("LIPREAD_DIR");
}

#[test]
fn not_set_up_says_how() {
    let _env = env_lock();
    let fixture = Fixture::new();
    std::env::set_var("AGENT_STATE_DIR", fixture.path());
    std::env::set_var("LIPREAD_DIR", fixture.path().join("lipread"));
    let (ok, why) = lipread::available();
    assert!(!ok);
    assert!(why.contains("setup-lipread.sh"), "{why}");
    assert_eq!(lipread::home(), fixture.path().join("lipread"));
    std::env::remove_var("AGENT_STATE_DIR");
    std::env::remove_var("LIPREAD_DIR");
}
