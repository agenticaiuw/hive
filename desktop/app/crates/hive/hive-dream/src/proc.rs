//! Running a child (cargo, codex) in its own process group with a time limit, its output
//! appended to a log file and kept for the caller.

use std::io::Write;
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

pub struct Ran {
    pub ok: bool,
    pub code: Option<i32>,
    pub timed_out: bool,
    /// stdout and stderr, as written to the log.
    pub output: String,
}

/// Runs `argv` in `cwd` with `env` added, `stdin` piped in, everything it prints appended to
/// `log`. After `limit` the whole process group is stopped (TERM, then KILL).
pub fn run(
    argv: &[String],
    cwd: &Path,
    env: &[(String, String)],
    stdin: Option<&str>,
    log: &Path,
    limit: Duration,
) -> Result<Ran, String> {
    if let Some(dir) = log.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let out_path = log.with_extension(format!("part-{}", std::process::id()));
    let out =
        std::fs::File::create(&out_path).map_err(|e| format!("{}: {e}", out_path.display()))?;
    let err = out.try_clone().map_err(|e| e.to_string())?;
    let mut cmd = Command::new(&argv[0]);
    cmd.args(&argv[1..])
        .current_dir(cwd)
        .stdout(Stdio::from(out))
        .stderr(Stdio::from(err))
        .stdin(if stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .process_group(0);
    for (k, v) in env {
        cmd.env(k, v);
    }
    let mut child = cmd.spawn().map_err(|e| format!("{}: {e}", argv[0]))?;
    if let Some(text) = stdin {
        if let Some(mut pipe) = child.stdin.take() {
            let _ = pipe.write_all(text.as_bytes());
        }
    }
    let started = Instant::now();
    let pgid = child.id() as i32;
    let mut timed_out = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => {}
            Err(e) => return Err(e.to_string()),
        }
        if started.elapsed() > limit {
            timed_out = true;
            // SAFETY: signalling our own child's process group.
            unsafe { libc::kill(-pgid, libc::SIGTERM) };
            std::thread::sleep(Duration::from_secs(5));
            unsafe { libc::kill(-pgid, libc::SIGKILL) };
            break child.wait().ok();
        }
        std::thread::sleep(Duration::from_millis(500));
    };
    let output =
        String::from_utf8_lossy(&std::fs::read(&out_path).unwrap_or_default()).into_owned();
    let _ = std::fs::remove_file(&out_path);
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log)
    {
        let _ = writeln!(
            f,
            "$ {} ({:.0}s{})\n{output}",
            argv.join(" "),
            started.elapsed().as_secs_f64(),
            if timed_out { ", timed out" } else { "" }
        );
    }
    let code = status.and_then(|s| s.code());
    Ok(Ran {
        ok: !timed_out && code == Some(0),
        code,
        timed_out,
        output,
    })
}
