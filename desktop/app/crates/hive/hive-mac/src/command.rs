//! Commands on the Mac, without taking its mouse or keyboard. Output is drained but only a small
//! prefix is kept for the cloud mailbox. A deadline ends the whole process group, including pipes
//! held by children in that group. Commands must not detach background jobs into another group.

use std::io::{self, Read};
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const OUTPUT_BYTES: usize = 64 * 1024;

#[derive(Debug)]
pub struct Output {
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub truncated: bool,
    pub timed_out: bool,
}

fn read(mut pipe: impl Read) -> (String, bool) {
    let mut kept = Vec::new();
    let mut buf = [0; 8192];
    let mut truncated = false;
    while let Ok(n) = pipe.read(&mut buf) {
        if n == 0 { break; }
        let take = n.min(OUTPUT_BYTES - kept.len());
        kept.extend_from_slice(&buf[..take]);
        truncated |= take < n;
    }
    (String::from_utf8_lossy(&kept).into_owned(), truncated)
}

pub fn run(shell: &str, command: &str, cwd: &Path, timeout: Duration) -> io::Result<Output> {
    let mut child = Command::new(shell)
        .args(["-lc", command])
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0)
        .spawn()?;
    let stdout = child.stdout.take().expect("stdout pipe");
    let stderr = child.stderr.take().expect("stderr pipe");
    let out = std::thread::spawn(move || read(stdout));
    let err = std::thread::spawn(move || read(stderr));
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Ok(Some(status)),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(10)),
            Ok(None) => break Ok(None),
            Err(error) => break Err(error),
        }
    };
    // The shell may have exited while a child still owns its output pipes. End those too before
    // joining the readers, even for successful commands. Never retry a timed out command silently.
    unsafe { libc::kill(-(child.id() as i32), libc::SIGKILL); }
    let _ = child.wait();
    let (stdout, out_cut) = out.join().unwrap_or_default();
    let (stderr, err_cut) = err.join().unwrap_or_default();
    let status = status?;
    Ok(Output { code: status.and_then(|s| s.code()), stdout, stderr,
        truncated: out_cut || err_cut, timed_out: status.is_none() })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn output_exit_code_cwd_and_large_pipes() {
        let dir = tempfile::tempdir().unwrap();
        let out = run("/bin/sh", "pwd; printf problem >&2; exit 7", dir.path(), Duration::from_secs(5)).unwrap();
        assert_eq!(out.code, Some(7));
        assert_eq!(Path::new(out.stdout.trim()).canonicalize().unwrap(), dir.path().canonicalize().unwrap());
        assert_eq!(out.stderr, "problem");
        let out = run("/bin/sh", "yes x | head -c 200000", dir.path(), Duration::from_secs(5)).unwrap();
        assert_eq!(out.stdout.len(), OUTPUT_BYTES);
        assert!(out.truncated);
        assert!(!out.timed_out);
    }

    #[test]
    fn timeout_and_background_children_do_not_hold_the_call_open() {
        let start = Instant::now();
        let out = run("/bin/sh", "sleep 30 & wait", Path::new("/tmp"), Duration::from_millis(100)).unwrap();
        assert!(out.timed_out);
        assert!(start.elapsed() < Duration::from_secs(3));
        let start = Instant::now();
        let out = run("/bin/sh", "sleep 30 &", Path::new("/tmp"), Duration::from_secs(1)).unwrap();
        assert_eq!(out.code, Some(0));
        assert!(start.elapsed() < Duration::from_secs(3));
    }
}
