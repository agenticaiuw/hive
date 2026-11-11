use personal_agent_core::thread_identity::{
    validate_identity, IdentityError, ResumableThread, SessionTransport,
};
use serde_json::{json, Value};
use std::fs;
use std::sync::{Arc, Barrier, Mutex};
use std::time::Duration;

#[derive(Default)]
struct Fake {
    calls: Vec<(String, Value)>,
    response_id: Option<String>,
    failure: bool,
    ephemeral: bool,
}
impl SessionTransport for Fake {
    fn request(&mut self, method: &str, params: Value) -> Result<Value, String> {
        self.calls.push((method.to_owned(), params.clone()));
        if self.failure {
            return Err("unavailable".into());
        }
        Ok(
            json!({"thread": {"id": self.response_id.as_deref().unwrap_or_else(|| params.get("threadId").and_then(Value::as_str).unwrap_or("thread-123")), "ephemeral": self.ephemeral}}),
        )
    }
}

#[test]
fn create_and_resume_same_persistent_thread_with_only_supported_overrides() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("private").join("thread-id");
    let mut identity = ResumableThread::new(&path);
    let mut server = Fake::default();
    assert_eq!(
        identity
            .connect(&mut server, &json!({"ephemeral": true, "model": "test"}))
            .unwrap(),
        "thread-123"
    );
    assert_eq!(server.calls[0].0, "thread/start");
    assert_eq!(server.calls[0].1["ephemeral"], false);
    assert_eq!(fs::read_to_string(&path).unwrap(), "thread-123\n");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    let mut after_restart = ResumableThread::new(&path);
    assert_eq!(after_restart.connect(&mut server, &json!({"baseInstructions": "new base", "cwd": "/work", "model": "ignored", "approvalPolicy": "never"})).unwrap(), "thread-123");
    assert_eq!(
        server.calls[1],
        (
            "thread/resume".into(),
            json!({"threadId": "thread-123", "baseInstructions": "new base", "cwd": "/work", "approvalPolicy": "never"})
        )
    );
}

#[test]
fn uncertain_start_keeps_pending_marker_and_never_starts_twice() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("thread-id");
    let mut server = Fake {
        failure: true,
        ..Fake::default()
    };
    let err = ResumableThread::new(&path)
        .connect(&mut server, &json!({}))
        .unwrap_err();
    assert!(matches!(
        err,
        IdentityError::Request {
            method: "thread/start",
            ..
        }
    ));
    assert_eq!(
        fs::read_to_string(&path).unwrap(),
        "!thread-start-pending\n"
    );
    server.failure = false;
    assert!(matches!(
        ResumableThread::new(&path).connect(&mut server, &json!({})),
        Err(IdentityError::InvalidIdentity)
    ));
    assert_eq!(server.calls.len(), 1);
}

#[test]
fn failed_resume_or_wrong_identity_never_replaces_saved_thread() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("thread-id");
    fs::write(&path, "original\n").unwrap();
    let mut unavailable = Fake {
        failure: true,
        ..Fake::default()
    };
    let mut identity = ResumableThread::new(&path);
    assert!(matches!(
        identity.connect(&mut unavailable, &json!({})),
        Err(IdentityError::Request {
            method: "thread/resume",
            ..
        })
    ));
    assert_eq!(identity.thread_id(), Some("original"));
    let mut mismatched = Fake {
        response_id: Some("other".into()),
        ..Fake::default()
    };
    assert!(matches!(
        identity.connect(&mut mismatched, &json!({})),
        Err(IdentityError::IdentityMismatch)
    ));
    assert_eq!(fs::read_to_string(path).unwrap(), "original\n");
}

#[test]
fn changed_missing_invalid_and_ephemeral_identities_fail_closed() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("thread-id");
    let mut server = Fake::default();
    let mut identity = ResumableThread::new(&path);
    identity.connect(&mut server, &json!({})).unwrap();
    fs::write(&path, "different\n").unwrap();
    assert!(matches!(
        identity.connect(&mut server, &json!({})),
        Err(IdentityError::IdentityChanged)
    ));
    fs::remove_file(&path).unwrap();
    assert!(matches!(
        identity.connect(&mut server, &json!({})),
        Err(IdentityError::IdentityChanged)
    ));
    fs::write(&path, [0xff, 0xfe]).unwrap();
    assert!(ResumableThread::new(&path)
        .connect(&mut server, &json!({}))
        .is_err());
    fs::remove_file(&path).unwrap();
    let mut ephemeral = Fake {
        ephemeral: true,
        ..Fake::default()
    };
    assert!(matches!(
        ResumableThread::new(&path).connect(&mut ephemeral, &json!({})),
        Err(IdentityError::EphemeralThread)
    ));
    assert_eq!(fs::read_to_string(path).unwrap(), "!thread-start-pending\n");
    assert!(validate_identity("valid_ABC-123").is_ok());
    for bad in ["", "bad space", "emoji-🦀", "../escape", &"x".repeat(201)] {
        assert!(validate_identity(bad).is_err());
    }
}

struct ConcurrentFake {
    calls: Arc<Mutex<Vec<String>>>,
}
impl SessionTransport for ConcurrentFake {
    fn request(&mut self, method: &str, params: Value) -> Result<Value, String> {
        self.calls.lock().unwrap().push(method.into());
        if method == "thread/start" {
            std::thread::sleep(Duration::from_millis(80));
        }
        Ok(
            json!({"thread": {"id": params.get("threadId").and_then(Value::as_str).unwrap_or("one-shared-thread")}}),
        )
    }
}

#[test]
fn concurrent_clients_serialize_creation_and_resume_the_same_identity() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("thread-id");
    let barrier = Arc::new(Barrier::new(3));
    let calls = Arc::new(Mutex::new(Vec::new()));
    let handles: Vec<_> = (0..2)
        .map(|_| {
            let (path, barrier, calls) = (path.clone(), barrier.clone(), calls.clone());
            std::thread::spawn(move || {
                barrier.wait();
                ResumableThread::new(path)
                    .connect(&mut ConcurrentFake { calls }, &json!({}))
                    .unwrap()
            })
        })
        .collect();
    barrier.wait();
    for handle in handles {
        assert_eq!(handle.join().unwrap(), "one-shared-thread");
    }
    assert_eq!(
        *calls.lock().unwrap(),
        vec!["thread/start", "thread/resume"]
    );
}

struct ProcessFake {
    log: std::path::PathBuf,
    crash_fixture: bool,
}
impl SessionTransport for ProcessFake {
    fn request(&mut self, method: &str, params: Value) -> Result<Value, String> {
        use std::io::Write;
        let mut log = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.log)
            .unwrap();
        writeln!(log, "{method}").unwrap();
        log.sync_all().unwrap();
        if method == "thread/start" {
            std::thread::sleep(if self.crash_fixture {
                Duration::from_secs(30)
            } else {
                Duration::from_millis(100)
            });
        }
        Ok(
            json!({"thread": {"id": params.get("threadId").and_then(Value::as_str).unwrap_or("cross-process-thread")}}),
        )
    }
}

#[test]
fn child_identity_worker() {
    let Some(path) = std::env::var_os("AGENT_TEST_THREAD_FILE") else {
        return;
    };
    let log = std::env::var_os("AGENT_TEST_CALL_LOG").expect("call log required");
    let crash_fixture = std::env::var_os("AGENT_TEST_WAIT_FOR_KILL").is_some();
    let id = ResumableThread::new(std::path::PathBuf::from(path))
        .connect(
            &mut ProcessFake {
                log: log.into(),
                crash_fixture,
            },
            &json!({}),
        )
        .unwrap();
    assert_eq!(id, "cross-process-thread");
}

fn child_command(path: &std::path::Path, log: &std::path::Path) -> std::process::Command {
    let mut cmd = std::process::Command::new(std::env::current_exe().unwrap());
    cmd.args(["--exact", "child_identity_worker", "--nocapture"])
        .env("AGENT_TEST_THREAD_FILE", path)
        .env("AGENT_TEST_CALL_LOG", log)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped());
    cmd
}

#[test]
fn separate_processes_create_only_one_conversation() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("thread-id");
    let log = dir.path().join("calls");
    let children: Vec<_> = (0..3)
        .map(|_| child_command(&path, &log).spawn().unwrap())
        .collect();
    for child in children {
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    let calls = fs::read_to_string(log).unwrap();
    assert_eq!(calls.lines().filter(|s| *s == "thread/start").count(), 1);
    assert_eq!(calls.lines().filter(|s| *s == "thread/resume").count(), 2);
    assert_eq!(fs::read_to_string(path).unwrap(), "cross-process-thread\n");
}

#[test]
fn killed_start_process_leaves_pending_identity_and_no_duplicate_start() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("thread-id");
    let log = dir.path().join("calls");
    let mut child = child_command(&path, &log)
        .env("AGENT_TEST_WAIT_FOR_KILL", "1")
        .spawn()
        .unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    let started = || {
        fs::read_to_string(&log)
            .map(|text| text == "thread/start\n")
            .unwrap_or(false)
    };
    while !started() && std::time::Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    if !started() {
        let _ = child.kill();
        let _ = child.wait();
        panic!("child did not reach app-server request");
    }
    child.kill().unwrap();
    child.wait().unwrap();
    assert_eq!(
        fs::read_to_string(&path).unwrap(),
        "!thread-start-pending\n"
    );
    let mut server = Fake::default();
    assert!(matches!(
        ResumableThread::new(path).connect(&mut server, &json!({})),
        Err(IdentityError::InvalidIdentity)
    ));
    assert!(server.calls.is_empty());
    assert_eq!(fs::read_to_string(log).unwrap().lines().count(), 1);
}

#[test]
fn shared_python_and_rust_fixture_agree_on_start_and_resume_contract() {
    let dir = tempfile::tempdir().unwrap();
    let rust_path = dir.path().join("rust-thread");
    let python_path = dir.path().join("python-thread");
    let mut rust = ResumableThread::new(&rust_path);
    let mut server = Fake::default();
    let start = json!({"ephemeral": true, "model": "example", "developerInstructions": "rules"});
    let resume = json!({"baseInstructions": "base", "developerInstructions": "new rules", "cwd": "/tmp", "model": "excluded"});
    let first = rust.connect(&mut server, &start).unwrap();
    let second = ResumableThread::new(&rust_path)
        .connect(&mut server, &resume)
        .unwrap();
    let rust_result = json!({"first": first, "second": second, "calls": server.calls,
                             "saved": fs::read_to_string(&rust_path).unwrap()});
    let script = r#"
import json,sys
from pathlib import Path
from resumable_thread import ResumableThread
class Server:
 def __init__(self): self.calls=[]
 def request(self, method, params):
  self.calls.append([method,params])
  return {'thread': {'id': params.get('threadId','thread-123'), 'ephemeral': False}}
p=Path(sys.argv[1]); s=Server()
a=ResumableThread(p).connect(s, {'ephemeral':True,'model':'example','developerInstructions':'rules'})
b=ResumableThread(p).connect(s, {'baseInstructions':'base','developerInstructions':'new rules','cwd':'/tmp','model':'excluded'})
print(json.dumps({'first':a,'second':b,'calls':s.calls,'saved':p.read_text()}))
"#;
    let python_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("python");
    let output = std::process::Command::new("python3")
        .args(["-c", script])
        .arg(&python_path)
        .env("PYTHONPATH", python_dir)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let python_result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(rust_result, python_result);
}
