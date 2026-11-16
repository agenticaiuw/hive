//! Sharing the mouse and keyboard on the virtual monitor (tools.rs `take`/`let_go`, with
//! hive-monitor's `hold`/`release` and the helper's `share on|off`).
//!
//! While hive-monitor shares, the agent keeps the real cursor and keyboard on the virtual monitor
//! and the user's input goes to their own apps, so the agent takes control at once, however busy
//! the user's hands are, and the user's input never takes it back. Without sharing (hive-monitor
//! not answering, or the monitor being shown) the agent waits for still hands as before.
//!
//! Runs the real helper (build/agent-vhid-helper) in a dry run on a socket of its own, on a fake
//! Mac that stands in for hive-monitor. Skipped, with a note, when the helper isn't built (make).

mod common;

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use common::FakeSystem;
use hive_mac::{AgentVHID, MacTools};

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// The real helper in a dry run (no root, no devices, no watcher), on a socket in a new folder.
struct Helper {
    _dir: tempfile::TempDir,
    socket: PathBuf,
    child: Child,
}

impl Helper {
    fn start() -> Option<Helper> {
        let program = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../build/agent-vhid-helper");
        if !program.is_file() {
            eprintln!("skipped: build/agent-vhid-helper isn't built (make)");
            return None;
        }
        let dir = tempfile::Builder::new().prefix("avh-").tempdir().unwrap();
        let socket = dir.path().join("s.sock");
        let child = Command::new(program)
            .args(["--dry-run", "--no-watch", "--no-sound", "--quiet-ms", "300", "--socket"])
            .arg(&socket)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("start agent-vhid-helper");
        let deadline = Instant::now() + Duration::from_secs(5);
        while !socket.exists() {
            assert!(Instant::now() < deadline, "the helper didn't start");
            std::thread::sleep(Duration::from_millis(20));
        }
        Some(Helper { _dir: dir, socket, child })
    }

    fn raw(&self, line: &str) -> String {
        let mut s = UnixStream::connect(&self.socket).unwrap();
        s.write_all(format!("{line}\n").as_bytes()).unwrap();
        let mut reply = String::new();
        BufReader::new(s).read_line(&mut reply).unwrap();
        reply.trim().to_string()
    }
}

impl Drop for Helper {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Hive on the virtual monitor, with the user's hands busy (they touched something just now).
fn on_monitor(hold: Option<&str>) -> Arc<FakeSystem> {
    let system = Arc::new(FakeSystem {
        virtual_monitor: Some((-1440.0, 0.0, 1440.0, 900.0)),
        ..FakeSystem::default()
    });
    *lock(&system.cursor) = (-700.0, 400.0);
    *lock(&system.idle) = 0.0;
    *lock(&system.share_hold) = hold.map(str::to_string);
    system
}

#[test]
fn sharing_takes_control_at_once_and_the_users_hands_never_take_it_back() {
    let Some(helper) = Helper::start() else { return };
    let system = on_monitor(Some("ok holding"));
    helper.raw("human trackpad"); // the user is working
    let tools = MacTools::with(AgentVHID::new(&helper.socket, 1.0, false), system.clone());

    let started = Instant::now();
    assert_eq!(tools.take().unwrap(), None, "the agent has the mouse and keyboard");
    assert!(started.elapsed() < Duration::from_millis(250), "nothing waited for still hands");
    let status = helper.raw("status");
    assert!(status.contains("state=engaged") && status.contains("share=1"), "{status}");

    helper.raw("human trackpad");
    helper.raw("human keyboard");
    assert!(helper.raw("status").contains("state=engaged"), "the user's input went to their own apps");
    assert_eq!(tools.take().unwrap(), None, "the next step holds on");

    tools.let_go();
    let status = helper.raw("status");
    assert!(status.contains("state=disengaged") && status.contains("share=0"), "{status}");
    assert_eq!(*lock(&system.share_lines), ["hold", "hold", "release"]);
    assert!(lock(&system.activated).is_empty(), "hive-monitor puts the user's app back, not Hive");
}

#[test]
fn without_sharing_the_agent_waits_for_still_hands_as_before() {
    let Some(helper) = Helper::start() else { return };
    let system = on_monitor(Some("err showing")); // the user is looking at the virtual monitor
    *lock(&system.idle) = f64::INFINITY;
    let tools = MacTools::with(AgentVHID::new(&helper.socket, 1.0, false), system.clone());

    assert_eq!(tools.take().unwrap(), None);
    let status = helper.raw("status");
    assert!(status.contains("state=engaged") && status.contains("share=0"), "{status}");
    assert_eq!(*lock(&system.share_lines), ["hold"], "nothing to release");

    helper.raw("human trackpad");
    assert!(helper.raw("status").contains("state=disengaged reason=trackpad"), "the user's hands take it back");
}

#[test]
fn a_takeover_while_sharing_was_paused_ends_sharing() {
    let Some(helper) = Helper::start() else { return };
    let system = on_monitor(Some("ok holding"));
    let tools = MacTools::with(AgentVHID::new(&helper.socket, 1.0, false), system.clone());
    assert_eq!(tools.take().unwrap(), None);

    // The user shows the virtual monitor: hive-monitor tells the helper to count their hands again.
    helper.raw("share off");
    helper.raw("human trackpad");
    tools.took_over();
    assert_eq!(*lock(&system.share_lines), ["hold", "release"]);
    assert!(helper.raw("status").contains("share=0"));
}
