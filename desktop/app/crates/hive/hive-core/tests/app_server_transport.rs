//! The app-server transport binary that hive-codex runs between Hive and `codex app-server`
//! (ported from tests/test_rust_app_server_transport.py). Children are /bin/sh scripts.
#![cfg(unix)]
use std::io::{Read, Write};
use std::os::unix::process::ExitStatusExt;
use std::path::Path;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::thread;
use std::time::{Duration, Instant};

const TRANSPORT: &str = env!("CARGO_BIN_EXE_hive-app-server-transport");

fn transport(script: &str, args: &[&str]) -> Command {
    let mut command = Command::new(TRANSPORT);
    command.args(["/bin/sh", "-c", script, "sh"]).args(args);
    command
}

/// Waits for the transport like Python's `timeout=`, killing it instead of hanging the suite.
fn wait(child: &mut Child, limit: Duration) -> ExitStatus {
    let deadline = Instant::now() + limit;
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            return status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            panic!("transport did not exit within {limit:?}");
        }
        thread::sleep(Duration::from_millis(10));
    }
}

/// Kills a process the test started if an assertion fails before it is reaped.
struct KillOnDrop(Option<Child>, Option<libc::pid_t>);
impl Drop for KillOnDrop {
    fn drop(&mut self) {
        if let Some(child) = self.0.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
        if let Some(pid) = self.1 {
            unsafe { libc::kill(pid, libc::SIGKILL) };
        }
    }
}

#[test]
fn forwards_exact_bytes_and_preserves_exit_code() {
    // Reads one line, echoes it byte for byte, adds another, and exits 7.
    let mut child = transport("head -n 1; printf 'last\\n'; exit 7", &[])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut stdout = child.stdout.take().unwrap();
    let reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        stdout.read_to_end(&mut bytes).unwrap();
        bytes
    });
    let mut stdin = child.stdin.take().unwrap();
    stdin.write_all("héllo\n".as_bytes()).unwrap();
    drop(stdin);
    let status = wait(&mut child, Duration::from_secs(5));
    assert_eq!(reader.join().unwrap(), "héllo\nlast\n".as_bytes());
    assert_eq!(status.code(), Some(7));
}

#[test]
fn propagates_child_signal() {
    let mut child = transport("kill -TERM $$", &[])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    drop(child.stdin.take());
    let status = wait(&mut child, Duration::from_secs(5));
    assert_eq!(status.signal(), Some(libc::SIGTERM), "{status:?}");
}

#[test]
fn host_disconnect_reaps_uncooperative_child() {
    let dir = tempfile::tempdir().unwrap();
    let pidfile = dir.path().join("pid");
    // Records its pid (atomically, so a half-written file is never read), then ignores stdin.
    let script = "echo $$ > \"$1.tmp\" && mv \"$1.tmp\" \"$1\" && exec sleep 60";
    let child = transport(script, &[pidfile.to_str().unwrap()])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut guard = KillOnDrop(Some(child), None);
    let deadline = Instant::now() + Duration::from_secs(5);
    while !Path::new(&pidfile).exists() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(10));
    }
    assert!(pidfile.exists(), "child never started");
    let pid: libc::pid_t = std::fs::read_to_string(&pidfile)
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    guard.1 = Some(pid);
    let child = guard.0.as_mut().unwrap();
    drop(child.stdin.take()); // the host goes away
    let status = wait(child, Duration::from_secs(6));
    guard.0 = None;
    assert_eq!(status.signal(), Some(libc::SIGKILL), "{status:?}");
    let alive = unsafe { libc::kill(pid, 0) };
    let error = std::io::Error::last_os_error().raw_os_error();
    assert_eq!(
        (alive, error),
        (-1, Some(libc::ESRCH)),
        "child {pid} survived"
    );
    guard.1 = None;
}
