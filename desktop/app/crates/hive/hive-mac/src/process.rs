//! Running a helper process with a time limit (Python's `subprocess.run(..., timeout=...)`).

use std::ffi::OsStr;
use std::io::{self, Read, Write};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// What a finished process left: its exit code (None if a signal ended it) and its output.
#[derive(Debug, Default)]
pub struct Output {
    pub code: Option<i32>,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

impl Output {
    pub fn success(&self) -> bool {
        self.code == Some(0)
    }
    pub fn stdout_text(&self) -> String {
        String::from_utf8_lossy(&self.stdout).into_owned()
    }
    pub fn stderr_text(&self) -> String {
        String::from_utf8_lossy(&self.stderr).into_owned()
    }
}

/// Runs `program args...`, feeding it `input` (else no stdin) and capturing its output. With a
/// `timeout`, a process still running then is killed and the error is `TimedOut`.
pub fn run<I, S>(
    program: impl AsRef<OsStr>,
    args: I,
    input: Option<&[u8]>,
    timeout: Option<Duration>,
) -> io::Result<Output>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let mut child = Command::new(program)
        .args(args)
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let feeder = match (input, child.stdin.take()) {
        (Some(data), Some(mut stdin)) => {
            let data = data.to_vec();
            Some(std::thread::spawn(move || {
                let _ = stdin.write_all(&data);
            }))
        }
        _ => None,
    };
    let reader = |pipe: Option<Box<dyn Read + Send>>| {
        std::thread::spawn(move || {
            let mut out = Vec::new();
            if let Some(mut pipe) = pipe {
                let _ = pipe.read_to_end(&mut out);
            }
            out
        })
    };
    let stdout = reader(
        child
            .stdout
            .take()
            .map(|p| Box::new(p) as Box<dyn Read + Send>),
    );
    let stderr = reader(
        child
            .stderr
            .take()
            .map(|p| Box::new(p) as Box<dyn Read + Send>),
    );
    let deadline = timeout.map(|t| Instant::now() + t);
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if deadline.is_some_and(|d| Instant::now() >= d) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(io::Error::new(io::ErrorKind::TimedOut, "timed out"));
        }
        std::thread::sleep(Duration::from_millis(5));
    };
    if let Some(feeder) = feeder {
        let _ = feeder.join();
    }
    Ok(Output {
        code: status.code(),
        stdout: stdout.join().unwrap_or_default(),
        stderr: stderr.join().unwrap_or_default(),
    })
}

/// Starts `program args...` without waiting for it, its output thrown away. A thread reaps it.
pub fn spawn_detached<I, S>(program: impl AsRef<OsStr>, args: I) -> io::Result<()>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

/// An OS error's text without Rust's " (os error N)" suffix, like Python's `strerror`.
pub fn strerror(e: &io::Error) -> String {
    let text = e.to_string();
    match text.rfind(" (os error ") {
        Some(at) => text[..at].to_string(),
        None => text,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runs_feeds_and_times_out() {
        let out = run(
            "/bin/cat",
            Vec::<&str>::new(),
            Some(b"hello"),
            Some(Duration::from_secs(5)),
        )
        .unwrap();
        assert!(out.success());
        assert_eq!(out.stdout, b"hello");
        let out = run("/bin/sh", ["-c", "echo oops >&2; exit 3"], None, None).unwrap();
        assert_eq!(out.code, Some(3));
        assert_eq!(out.stderr_text(), "oops\n");
        let late = run("/bin/sleep", ["5"], None, Some(Duration::from_millis(100))).unwrap_err();
        assert_eq!(late.kind(), io::ErrorKind::TimedOut);
        let missing = run("/nonexistent/tool", Vec::<&str>::new(), None, None).unwrap_err();
        assert_eq!(missing.kind(), io::ErrorKind::NotFound);
        assert_eq!(strerror(&missing), "No such file or directory");
    }
}
