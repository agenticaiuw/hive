//! The real C++ helper, build/agent-vhid-helper (src/main.cpp, server.hpp, gate.hpp, injector.hpp),
//! run with --dry-run (no root, no virtual devices) on a temporary socket: tests/test_dry_run.py's
//! DryRunTest and its two offline checks of the helper. It checks the HID reports the helper would
//! send (it logs them in a dry run) and the hand-over gate, driven by the Rust client on a fake Mac.
//! vhid_client.rs covers the same client against a fake helper.
//!
//! Each test starts its own helper; nothing here connects to the live helper's socket. Every test
//! is skipped, with a note, when the helper isn't built (make).

mod common;

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use common::FakeSystem;
use hive_mac::{AgentVHID, Fields, VhidError};

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// build/agent-vhid-helper, if it's built.
fn built() -> Option<PathBuf> {
    let helper = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../build/agent-vhid-helper");
    if helper.is_file() {
        Some(helper)
    } else {
        eprintln!("skipped: build/agent-vhid-helper isn't built (make)");
        None
    }
}

/// test_dry_run.py's `Helper`: the real helper in a dry run on a socket in a new temporary folder,
/// with what it writes to stderr collected line by line.
struct Helper {
    _dir: tempfile::TempDir,
    socket: PathBuf,
    lines: Arc<Mutex<Vec<String>>>,
    child: Child,
}

impl Helper {
    fn start(program: &Path, extra: &[&str]) -> Helper {
        Helper::start_with(
            program,
            &["--dry-run", "--no-watch", "--no-sound", "--verbose"],
            extra,
        )
    }

    fn start_with(program: &Path, base: &[&str], extra: &[&str]) -> Helper {
        let dir = tempfile::Builder::new()
            .prefix("avh-")
            .tempdir()
            .expect("temp dir");
        let socket = dir.path().join("s.sock");
        let mut child = Command::new(program)
            .args(base)
            .args(["--quiet-ms", "100", "--socket"])
            .arg(&socket)
            .args(extra)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .expect("start agent-vhid-helper");
        let lines = Arc::new(Mutex::new(Vec::new()));
        let stderr = child.stderr.take().unwrap();
        let collected = lines.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines() {
                let Ok(line) = line else { break };
                lock(&collected).push(line);
            }
        });
        let deadline = Instant::now() + Duration::from_secs(5);
        while !socket.exists() {
            if Instant::now() > deadline || matches!(child.try_wait(), Ok(Some(_))) {
                let _ = child.kill();
                let _ = child.wait();
                panic!(
                    "helper did not start:\n{}",
                    lock(&lines).join("\n")
                );
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        Helper {
            _dir: dir,
            socket,
            lines,
            child,
        }
    }

    /// `--start-engaged`, as DryRunTest's setUp; and a client of it that moves and types fast and
    /// straight, on a fake Mac (its cursor never moves, as in a dry run; its clipboard is pretend).
    fn engaged(program: &Path) -> (Helper, Arc<FakeSystem>, AgentVHID) {
        let helper = Helper::start(program, &["--start-engaged"]);
        let system = FakeSystem::new();
        let mac = AgentVHID::new(&helper.socket, 1.0, false).with_system(system.clone());
        (helper, system, mac)
    }

    /// One request on its own connection, closed right after.
    fn raw(&self, line: &str) -> String {
        let mut s = UnixStream::connect(&self.socket).expect("connect to the dry-run helper");
        s.write_all(format!("{line}\n").as_bytes()).unwrap();
        let mut reply = String::new();
        BufReader::new(s).read_line(&mut reply).unwrap();
        reply.trim().to_string()
    }

    fn count(&self) -> usize {
        lock(&self.lines).len()
    }

    /// Reports are logged from the dispatcher thread, after the request was answered: this waits a
    /// moment, and on until no more come.
    fn settle(&self) {
        std::thread::sleep(Duration::from_millis(100));
        let deadline = Instant::now() + Duration::from_secs(2);
        let mut seen = self.count();
        while Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(50));
            let now = self.count();
            if now == seen {
                break;
            }
            seen = now;
        }
    }

    /// How many lines it has written so far, once the reports for what was already sent are in
    /// (so they aren't taken for what comes next).
    fn mark(&self) -> usize {
        self.settle();
        self.count()
    }

    /// Every line it wrote after the first `since` lines.
    fn lines_since(&self, since: usize) -> Vec<String> {
        self.settle();
        lock(&self.lines)[since..].to_vec()
    }

    /// The reports it logged after the first `since` lines.
    fn reports(&self, since: usize) -> Vec<String> {
        self.settle();
        lock(&self.lines)[since..]
            .iter()
            .filter_map(|l| l.strip_prefix("[dry-run] "))
            .map(str::to_string)
            .collect()
    }
}

impl Drop for Helper {
    fn drop(&mut self) {
        // SIGTERM, as test_dry_run.py's stop(): the helper lets go of everything and removes its socket.
        unsafe {
            libc::kill(self.child.id() as libc::pid_t, libc::SIGTERM);
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if matches!(self.child.try_wait(), Ok(Some(_))) {
                return;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// A keyboard report as the dry run logs it.
fn keyboard(mods: u8, keys: &[u8]) -> String {
    let mut line = format!("keyboard mods=0x{mods:x} keys=");
    for k in keys {
        line.push_str(&format!(" 0x{k:x}"));
    }
    line
}

/// Every event from a watch until there are `n`, or 2 s have passed.
fn collect(mac: &AgentVHID, n: usize, during: impl FnOnce()) -> Vec<Fields> {
    let watch = mac.watch().expect("watch");
    let stopper = watch.stopper().expect("a watch stopper");
    let events = Arc::new(Mutex::new(Vec::new()));
    let seen = events.clone();
    let t = std::thread::spawn(move || {
        for event in watch {
            let Ok(event) = event else { return };
            let mut seen = lock(&seen);
            seen.push(event);
            if seen.len() == n {
                return;
            }
        }
    });
    std::thread::sleep(Duration::from_millis(100));
    during();
    let deadline = Instant::now() + Duration::from_secs(2);
    while lock(&events).len() < n && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    stopper.stop();
    t.join().unwrap();
    Arc::try_unwrap(events)
        .unwrap_or_else(|_| panic!("the watch thread has finished"))
        .into_inner()
        .unwrap_or_else(|e| e.into_inner())
}

fn state(mac: &AgentVHID) -> (String, String) {
    let status = mac.status().unwrap();
    (
        status.get("state").unwrap_or("").to_string(),
        status.get("reason").unwrap_or("").to_string(),
    )
}

// ---------------------------------------------------------------- DryRunTest

#[test]
fn status() {
    let Some(program) = built() else { return };
    let (_helper, _, mac) = Helper::engaged(&program);
    let status = mac.status().unwrap();
    assert_eq!(status.get("state"), Some("engaged"));
    assert_eq!(status.get("dry_run"), Some("1"));
    assert_eq!(status.get("vhid"), Some("dry_run"));
    assert_eq!(status.get("fn"), Some("1"));
}

#[test]
fn shortcut_presses_modifier_then_key() {
    let Some(program) = built() else { return };
    let (helper, _, mac) = Helper::engaged(&program);
    let n = helper.mark();
    mac.key("cmd+s").unwrap();
    assert_eq!(
        helper.reports(n),
        [
            keyboard(0x8, &[]),
            keyboard(0x8, &[0x16]),
            keyboard(0x8, &[]),
            keyboard(0, &[])
        ]
    );
}

#[test]
fn typing_uses_shift_for_capitals_and_symbols() {
    let Some(program) = built() else { return };
    let (helper, _, mac) = Helper::engaged(&program);
    let n = helper.mark();
    mac.type_text("Hi!").unwrap();
    assert_eq!(
        helper.reports(n),
        [
            keyboard(0x2, &[]),
            keyboard(0x2, &[0x0b]),
            keyboard(0x2, &[]),
            keyboard(0, &[]), // H
            keyboard(0, &[0x0c]),
            keyboard(0, &[]), // i
            keyboard(0x2, &[]),
            keyboard(0x2, &[0x1e]),
            keyboard(0x2, &[]),
            keyboard(0, &[]), // !
        ]
    );
}

#[test]
fn characters_off_the_keyboard_are_pasted() {
    // The Python replaced paste_text; the Rust client pastes itself, through the fake Mac's
    // clipboard and cmd+v, so cmd+v is among the reports.
    let Some(program) = built() else { return };
    let (helper, system, mac) = Helper::engaged(&program);
    let n = helper.mark();
    mac.type_text("a中文b").unwrap();
    assert_eq!(
        *system.clipboard_writes.lock().unwrap(),
        ["中文".as_bytes().to_vec(), b"what was there".to_vec()]
    );
    assert_eq!(
        helper.reports(n),
        [
            keyboard(0, &[0x04]),
            keyboard(0, &[]),
            keyboard(0x8, &[]),
            keyboard(0x8, &[0x19]),
            keyboard(0x8, &[]),
            keyboard(0, &[]), // cmd+v
            keyboard(0, &[0x05]),
            keyboard(0, &[]),
        ]
    );
}

#[test]
fn scroll_direction_follows_natural_scrolling() {
    let Some(program) = built() else { return };
    let (helper, _, mac) = Helper::engaged(&program);
    let n = helper.mark();
    mac.set_natural_scrolling(Some(true));
    mac.scroll(2, 0, None).unwrap();
    mac.set_natural_scrolling(Some(false));
    mac.scroll(1, 0, None).unwrap();
    assert_eq!(
        helper.reports(n),
        [
            "pointing buttons=0 x=0 y=0 wheel=1,0",
            "pointing buttons=0 x=0 y=0 wheel=1,0",
            "pointing buttons=0 x=0 y=0 wheel=-1,0",
        ]
    );
}

#[test]
fn large_moves_are_split_into_hid_sized_reports() {
    let Some(program) = built() else { return };
    let (helper, _, mac) = Helper::engaged(&program);
    let n = helper.mark();
    mac.send("move 300 -10").unwrap();
    assert_eq!(
        helper.reports(n),
        [
            "pointing buttons=0 x=127 y=-10 wheel=0,0",
            "pointing buttons=0 x=127 y=0 wheel=0,0",
            "pointing buttons=0 x=46 y=0 wheel=0,0",
        ]
    );
}

#[test]
fn drag_keeps_button_held_while_moving() {
    let Some(program) = built() else { return };
    let (helper, _, mac) = Helper::engaged(&program);
    let n = helper.mark();
    mac.send("buttons 1").unwrap(); // same connection: closing one releases everything
    mac.send("move 5 5").unwrap();
    assert_eq!(
        helper.reports(n)[..2],
        [
            "pointing buttons=1 x=0 y=0 wheel=0,0",
            "pointing buttons=1 x=5 y=5 wheel=0,0",
        ]
    );
}

#[test]
fn human_input_disengages_and_releases_everything() {
    let Some(program) = built() else { return };
    let (helper, _, mac) = Helper::engaged(&program);
    mac.send("keys 8 22").unwrap();
    let n = helper.mark();
    assert_eq!(helper.raw("human trackpad"), "ok");
    assert_eq!(
        helper.reports(n),
        [keyboard(0, &[]), "pointing buttons=0 x=0 y=0 wheel=0,0".into()]
    );
    assert!(matches!(mac.key("a"), Err(VhidError::Disengaged(_))));
    assert!(matches!(
        mac.click(None, "left", 1, None),
        Err(VhidError::Disengaged(_))
    ));
    assert_eq!(state(&mac), ("disengaged".into(), "trackpad".into()));
    mac.release_all().unwrap(); // always allowed
}

#[test]
fn engage_waits_for_quiet_period() {
    let Some(program) = built() else { return };
    let (helper, _, mac) = Helper::engaged(&program);
    helper.raw("human keyboard");
    let mac = Arc::new(mac);
    let waiter = {
        let mac = mac.clone();
        std::thread::spawn(move || mac.wait_engaged(Some(Duration::from_secs(3)), false))
    };
    std::thread::sleep(Duration::from_millis(100));
    mac.engage().unwrap();
    assert_eq!(mac.status().unwrap().get("state"), Some("arming"));
    assert!(waiter.join().unwrap().unwrap());
    assert_eq!(mac.status().unwrap().get("reason"), Some("engaged"));
    mac.key("a").unwrap(); // works again
}

#[test]
fn touch_while_arming_cancels() {
    let Some(program) = built() else { return };
    let (helper, _, mac) = Helper::engaged(&program);
    helper.raw("human keyboard");
    mac.engage().unwrap();
    helper.raw("human trackpad");
    std::thread::sleep(Duration::from_millis(250));
    assert_eq!(
        state(&mac),
        (
            "disengaged".into(),
            "engage_cancelled_by_trackpad".into()
        )
    );
}

#[test]
fn watch_streams_hand_overs() {
    let Some(program) = built() else { return };
    let (helper, _, mac) = Helper::engaged(&program);
    let events = collect(&mac, 2, || {
        helper.raw("human mouse");
    });
    let states: Vec<_> = events
        .iter()
        .map(|e| e.get("state").unwrap_or("").to_string())
        .collect();
    assert_eq!(states, ["engaged", "disengaged"]);
    assert_eq!(events[1].get("reason"), Some("mouse"));
}

#[test]
fn engage_hands_over_until_you_touch_something() {
    let Some(program) = built() else { return };
    let (helper, _, mac) = Helper::engaged(&program);
    helper.raw("human keyboard");
    mac.engage().unwrap();
    assert!(mac
        .wait_engaged(Some(Duration::from_secs(2)), false)
        .unwrap());
    helper.raw("human trackpad"); // touching anything takes it back
    assert_eq!(state(&mac), ("disengaged".into(), "trackpad".into()));
    mac.engage().unwrap(); // each task (or "continue") asks again
    assert!(mac
        .wait_engaged(Some(Duration::from_secs(2)), false)
        .unwrap());
    mac.disengage().unwrap();
    assert_eq!(
        state(&mac),
        ("disengaged".into(), "released_by_agent".into())
    );
}

#[test]
fn watch_streams_fn_which_leaves_control_alone() {
    let Some(program) = built() else { return };
    let (helper, _, mac) = Helper::engaged(&program);
    let events = collect(&mac, 5, || {
        for what in ["down", "tap", "down", "up", "other"] {
            // a tap, a hold, a shortcut
            assert_eq!(helper.raw(&format!("fn {what}")), "ok");
        }
    });
    let fns: Vec<_> = events.iter().skip(1).map(Fields::to_json).collect();
    assert_eq!(
        fns,
        [
            serde_json::json!({"fn": "down"}),
            serde_json::json!({"fn": "tap"}),
            serde_json::json!({"fn": "down"}),
            serde_json::json!({"fn": "up"}),
        ]
    );
    assert_eq!(mac.status().unwrap().get("state"), Some("engaged")); // talking or dictating isn't taking over
    assert!(helper.raw("fn sideways").starts_with("err"));
}

#[test]
fn modifier_click_holds_the_modifier() {
    let Some(program) = built() else { return };
    let (helper, _, mac) = Helper::engaged(&program);
    let n = helper.mark();
    mac.click(None, "left", 1, Some("cmd")).unwrap();
    assert_eq!(
        helper.reports(n),
        [
            keyboard(0x8, &[]),
            "pointing buttons=1 x=0 y=0 wheel=0,0".into(),
            "pointing buttons=0 x=0 y=0 wheel=0,0".into(),
            keyboard(0, &[]),
        ]
    );
}

#[test]
fn keys_are_released_when_a_client_disconnects() {
    let Some(program) = built() else { return };
    let (helper, _, _mac) = Helper::engaged(&program);
    let n = helper.mark();
    helper.raw("keys 2 4"); // raw() closes the connection right after
    let reports = helper.reports(n);
    assert!(reports.len() >= 2, "{reports:?}");
    assert_eq!(
        reports[reports.len() - 2..],
        [keyboard(0, &[]), "pointing buttons=0 x=0 y=0 wheel=0,0".into()]
    );
}

#[test]
fn move_reports_when_cursor_does_not_follow() {
    // In a dry run nothing moves the cursor, so the closed loop must give up.
    let Some(program) = built() else { return };
    let (_helper, _, mac) = Helper::engaged(&program);
    let (x, y) = mac.cursor();
    let x2 = if x > 100.0 { x - 40.0 } else { x + 40.0 };
    let start = Instant::now();
    assert!(matches!(mac.move_to(x2, y), Err(VhidError::MoveFailed(_))));
    assert!(start.elapsed() < Duration::from_secs(2));
}

#[test]
fn bad_requests() {
    let Some(program) = built() else { return };
    let (helper, _, mac) = Helper::engaged(&program);
    assert!(helper.raw("move 1").starts_with("err bad_request"));
    assert!(helper.raw("keys 300").starts_with("err bad_request"));
    assert!(helper.raw("launch missiles").starts_with("err bad_request"));
    assert!(matches!(
        mac.key("cmd+nosuchkey"),
        Err(VhidError::Invalid(_))
    ));
}

// ---------------------------------------------------------------- OfflineTest

#[test]
fn helper_refuses_to_run_without_root_or_watcher() {
    let Some(program) = built() else { return };
    let out = Command::new(&program).arg("--no-watch").output().unwrap();
    assert!(!out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).contains("only allowed with --dry-run"));
    // As root it would really start, on the live helper's socket: only check this as anyone else.
    if unsafe { libc::geteuid() } == 0 {
        eprintln!("skipped the root check: running as root");
        return;
    }
    let out = Command::new(&program).output().unwrap();
    assert_eq!(out.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&out.stderr).contains("must run as root"));
}

#[test]
fn helper_starts_disengaged_by_default() {
    let Some(program) = built() else { return };
    let helper = Helper::start(&program, &[]);
    assert!(helper
        .raw("move 1 1")
        .starts_with("err disengaged state=disengaged reason=startup"));
}

/// Hive's sound switch (Agent menu › Sound: Voice and Chimes, the state folder's `speak-aloud`) is
/// read at each chime: off, the helper says it would have chimed and doesn't; on (or no file at all),
/// it chimes. A dry run says "[sound] Glass" instead of playing it.
#[test]
fn hives_sound_switch_silences_the_chimes() {
    let Some(program) = built() else { return };
    let folder = tempfile::tempdir().unwrap();
    let setting = folder.path().join("speak-aloud");
    let helper = Helper::start_with(
        &program,
        &["--dry-run", "--no-watch", "--verbose"],
        &["--sound-setting", setting.to_str().unwrap()],
    );
    let mac = AgentVHID::new(&helper.socket, 1.0, false).with_system(FakeSystem::new());
    let engage = |what: &str| {
        let since = helper.mark();
        mac.engage().unwrap();
        assert!(
            mac.wait_engaged(Some(Duration::from_secs(3)), false).unwrap(),
            "{what}: engaged"
        );
        helper.lines_since(since)
    };

    let lines = engage("no setting yet");
    assert!(lines.iter().any(|l| l == "[sound] Glass"), "{lines:?}");

    std::fs::write(&setting, "off\n").unwrap();
    let since = helper.mark();
    mac.disengage().unwrap();
    let lines = helper.lines_since(since);
    assert!(lines.iter().any(|l| l == "[sound] muted: Funk"), "{lines:?}");
    assert!(!lines.iter().any(|l| l == "[sound] Funk"), "{lines:?}");
    let lines = engage("off");
    assert!(lines.iter().any(|l| l == "[sound] muted: Glass"), "{lines:?}");
    assert!(!lines.iter().any(|l| l == "[sound] Glass"), "{lines:?}");

    std::fs::write(&setting, "on\n").unwrap();
    let since = helper.mark();
    mac.disengage().unwrap();
    let lines = helper.lines_since(since);
    assert!(lines.iter().any(|l| l == "[sound] Funk"), "{lines:?}");
}
