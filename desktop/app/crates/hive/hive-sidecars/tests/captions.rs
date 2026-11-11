//! The captions client (python/captions.py) against a stand-in for build/agent-vhid-captions that
//! writes down every line it's sent and answers as tools/captions.swift does: a request typed into
//! the entry field, the mute and close buttons, and whether the entry field has the keyboard.

use hive_sidecars::Captions;
use serde_json::{json, Value};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

/// CAPTIONS is the process's: tests take turns.
static ENV: Mutex<()> = Mutex::new(());

fn env_lock() -> MutexGuard<'static, ()> {
    ENV.lock().unwrap_or_else(|e| e.into_inner())
}

const OVERLAY: &str = r#"
import json, sys
record = open(sys.argv[0] + ".got", "a")
def emit(**e): print(json.dumps(e), flush=True)
for line in sys.stdin:
    record.write(line); record.flush()
    message = json.loads(line)
    if "focus" in message:
        emit(focused=message["focus"])
    if message.get("doing") == "(type)":
        emit(text="   ")
        emit(text="  open safari  ")
    if message.get("doing") == "(buttons)":
        emit(mute=True)
        emit(mute=False)
        emit(close=False)
        emit(close=True)
        emit(mute="yes")
"#;

/// An executable stand-in overlay in a temporary folder; what it was sent is in `<it>.got`.
fn overlay(dir: &Path, script: &str) -> PathBuf {
    let python =
        std::env::var("HIVE_TEST_PYTHON").unwrap_or_else(|_| "/usr/bin/env python3".into());
    let path = dir.join("agent-vhid-captions");
    std::fs::write(&path, format!("#!{python}\n{script}")).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    path
}

fn got(program: &Path) -> Vec<Value> {
    let text = std::fs::read_to_string(program.with_extension("got")).unwrap_or_default();
    text.lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

fn wait_for(what: &str, check: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        if check() {
            return;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    panic!("timed out waiting for {what}");
}

#[test]
fn every_caption_goes_to_the_overlay_as_one_json_line() {
    let _env = env_lock();
    std::env::remove_var("CAPTIONS");
    let dir = tempfile::tempdir().unwrap();
    let program = overlay(dir.path(), OVERLAY);
    let captions = Captions::with_overlay(true, &program);
    assert!(captions.shown());
    captions.listening(true);
    captions.focus(true);
    captions.dictating(false);
    captions.camera("waiting");
    captions.dismiss();
    captions.framing("Move a little to the left");
    captions.preview("/9j/4AAQ");
    captions.hearing("open saf");
    captions.say("Opening Safari — “now”.");
    captions.doing("Typing “weather”");
    captions.thinking("Looking for the address bar");
    captions.agent_request("from another program");
    captions.paused("Paused: press fn to go on");
    captions.muted(true);
    captions.activity("Safari");
    captions.active(false);
    captions.clear();
    captions.close();
    assert_eq!(
        got(&program),
        [
            json!({"listening": true}),
            json!({"focus": true}),
            json!({"dictating": false}),
            json!({"camera": "waiting"}),
            json!({"dismiss": true}),
            json!({"framing": "Move a little to the left"}),
            json!({"preview": "/9j/4AAQ"}),
            json!({"hearing": "open saf"}),
            json!({"say": "Opening Safari — “now”."}),
            json!({"doing": "Typing “weather”"}),
            json!({"thinking": "Looking for the address bar"}),
            json!({"agent_request": "from another program"}),
            json!({"paused": "Paused: press fn to go on"}),
            json!({"muted": true}),
            json!({"activity": "Safari"}),
            json!({"active": false}),
            json!({"clear": true}),
        ]
    );
    captions.say("after it closed"); // nothing, and no panic
    assert_eq!(got(&program).len(), 17);
}

#[test]
fn what_you_type_the_buttons_and_the_keyboard_come_back() {
    let _env = env_lock();
    std::env::remove_var("CAPTIONS");
    let dir = tempfile::tempdir().unwrap();
    let program = overlay(dir.path(), OVERLAY);
    let captions = Captions::with_overlay(true, &program);
    let inputs = Arc::new(Mutex::new(Vec::<String>::new()));
    let controls = Arc::new(Mutex::new(Vec::<(String, Option<bool>)>::new()));
    let focused = Arc::new(Mutex::new(Vec::<bool>::new()));
    let (i, c, f) = (inputs.clone(), controls.clone(), focused.clone());
    captions.set_on_input(move |text| i.lock().unwrap().push(text.into()));
    captions.set_on_control(move |kind, on| c.lock().unwrap().push((kind.into(), on)));
    captions.set_on_focused(move |on| f.lock().unwrap().push(on));
    assert_eq!(captions.focused(), None);

    captions.doing("(type)");
    wait_for("the typed request", || !inputs.lock().unwrap().is_empty());
    assert_eq!(*inputs.lock().unwrap(), ["open safari"]);

    captions.doing("(buttons)");
    wait_for("the buttons", || controls.lock().unwrap().len() == 3);
    assert_eq!(
        *controls.lock().unwrap(),
        [
            ("mute".to_string(), Some(true)),
            ("mute".to_string(), Some(false)),
            ("close".to_string(), None)
        ]
    );

    captions.focus(true);
    wait_for("focused", || captions.focused() == Some(true));
    captions.focus(false);
    wait_for("not focused", || captions.focused() == Some(false));
    assert_eq!(*focused.lock().unwrap(), [true, false]);
    captions.close();
}

#[test]
fn captions_0_shows_none() {
    let _env = env_lock();
    let dir = tempfile::tempdir().unwrap();
    let program = overlay(dir.path(), OVERLAY);
    std::env::set_var("CAPTIONS", "0");
    let captions = Captions::with_overlay(true, &program);
    std::env::remove_var("CAPTIONS");
    assert!(!captions.shown());
    captions.say("nobody sees this");
    captions.close();
    assert!(got(&program).is_empty());
}

#[test]
fn not_shown_or_not_built_does_nothing() {
    let _env = env_lock();
    std::env::remove_var("CAPTIONS");
    let dir = tempfile::tempdir().unwrap();
    let program = overlay(dir.path(), OVERLAY);
    let hidden = Captions::with_overlay(false, &program);
    assert!(!hidden.shown());
    hidden.say("nobody sees this");
    hidden.close();
    assert!(got(&program).is_empty());
    let missing = Captions::with_overlay(true, &dir.path().join("not-built"));
    assert!(!missing.shown());
    missing.listening(true);
    missing.close();
}

#[test]
fn an_overlay_that_quit_is_left_alone() {
    let _env = env_lock();
    std::env::remove_var("CAPTIONS");
    let dir = tempfile::tempdir().unwrap();
    let program = overlay(dir.path(), "import sys\nsys.exit(0)\n");
    let captions = Captions::with_overlay(true, &program);
    std::thread::sleep(Duration::from_millis(500));
    for _ in 0..3 {
        captions.say("into the void"); // nothing, and no panic
    }
    let started = Instant::now();
    captions.close();
    assert!(started.elapsed() < Duration::from_secs(2));
}
