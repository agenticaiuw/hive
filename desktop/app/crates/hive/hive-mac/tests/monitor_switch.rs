//! The virtual monitor's right Option switch (tools/hive_monitor.m, `hive-monitor switch`).
//!
//! The helper is compiled from the source into a temporary folder and runs its own `selftest`:
//! what counts as a tap of right Option (on its own, under 0.7 s; not with a key, a click, shift
//! or left Option, and not held) and keeping the cursor on the monitor. The Rust side is checked
//! too: `switch_running` is true exactly while something holds the switch's lock, which is how
//! Hive starts one switch and never two (two would each take the same tap and cancel out).
//! Skipped, with a note, when clang isn't there.

use std::os::unix::io::AsRawFd;
use std::path::Path;
use std::process::Command;
use std::sync::Mutex;

/// One test at a time: a process started by one test (clang, the helper) briefly shares every
/// open file of this one until it execs, a lock the other test is checking included.
static SERIAL: Mutex<()> = Mutex::new(());

#[test]
fn the_switch_counts_only_a_tap_of_right_option() {
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../tools/hive_monitor.m");
    let dir = tempfile::tempdir().unwrap();
    let binary = dir.path().join("hive-monitor");
    let built = Command::new("clang")
        .args(["-fobjc-arc", "-O2", "-Wall", "-Werror"])
        .arg(&source)
        .arg("-o")
        .arg(&binary)
        .args([
            "-framework",
            "Cocoa",
            "-framework",
            "ApplicationServices",
            "-framework",
            "ScreenCaptureKit",
            "-framework",
            "CoreMedia",
            "-framework",
            "CoreVideo",
            "-framework",
            "QuartzCore",
            "-framework",
            "IOSurface",
        ])
        .output();
    let Ok(built) = built else {
        eprintln!("skipped: no clang");
        return;
    };
    assert!(
        built.status.success(),
        "{}",
        String::from_utf8_lossy(&built.stderr)
    );
    let ran = Command::new(&binary).arg("selftest").output().unwrap();
    assert!(
        ran.status.success() && String::from_utf8_lossy(&ran.stdout).trim() == "ok",
        "{}",
        String::from_utf8_lossy(&ran.stderr)
    );
}

#[test]
fn hive_starts_the_switch_only_when_none_holds_its_lock() {
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let state = tempfile::tempdir().unwrap();
    std::env::set_var("AGENT_STATE_DIR", state.path());
    assert_eq!(
        hive_mac::virtual_monitor::switch_lock(),
        state.path().join("monitor-switch.lock")
    );
    assert!(
        !hive_mac::virtual_monitor::switch_running(),
        "nothing holds the lock yet"
    );
    assert!(
        !hive_mac::virtual_monitor::switch_running(),
        "checking doesn't keep the lock"
    );
    let held = std::fs::File::open(hive_mac::virtual_monitor::switch_lock()).unwrap();
    assert_eq!(
        unsafe { libc::flock(held.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) },
        0
    );
    assert!(
        hive_mac::virtual_monitor::switch_running(),
        "a running switch holds the lock"
    );
    drop(held);
    assert!(
        !hive_mac::virtual_monitor::switch_running(),
        "and it's free once that switch ends"
    );
}
