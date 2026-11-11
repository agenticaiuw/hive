//! Small things the modules share: the local clock in Python's formats, running a command with a
//! time limit, `which`, random hex ids, HTML escaping, private files.

use std::ffi::OsStr;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// `time.time()`.
pub fn now() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0)
}

/// `time.time_ns()`.
pub fn now_ns() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
}

/// A moment on this Mac's clock (`datetime.fromtimestamp(t)` / `time.localtime(t)`).
#[derive(Clone, Copy, Debug)]
pub struct Local {
    pub year: i32,
    pub month: u32,
    pub day: u32,
    pub hour: u32,
    pub minute: u32,
    pub second: u32,
    pub micros: u32,
    /// Seconds east of UTC.
    pub offset: i64,
}

impl Local {
    pub fn at(t: f64) -> Local {
        let total = (t * 1e6).round_ties_even() as i64;
        let (secs, micros) = (
            total.div_euclid(1_000_000),
            total.rem_euclid(1_000_000) as u32,
        );
        let mut tm = std::mem::MaybeUninit::<libc::tm>::zeroed();
        let seconds = secs as libc::time_t;
        // SAFETY: both pointers are valid for the call; localtime_r fills `tm`.
        let tm = unsafe {
            libc::localtime_r(&seconds, tm.as_mut_ptr());
            tm.assume_init()
        };
        Local {
            year: tm.tm_year + 1900,
            month: (tm.tm_mon + 1) as u32,
            day: tm.tm_mday as u32,
            hour: tm.tm_hour as u32,
            minute: tm.tm_min as u32,
            second: tm.tm_sec as u32,
            micros,
            offset: tm.tm_gmtoff as i64,
        }
    }

    pub fn now() -> Local {
        Local::at(now())
    }

    /// `%Y-%m-%d`.
    pub fn date(&self) -> String {
        format!("{:04}-{:02}-{:02}", self.year, self.month, self.day)
    }

    /// `%H:%M:%S`.
    pub fn time(&self) -> String {
        format!("{:02}:{:02}:{:02}", self.hour, self.minute, self.second)
    }

    /// `isoformat(timespec="seconds")` of a naive local time: `2026-11-11T14:10:00`.
    pub fn iso_seconds(&self) -> String {
        format!("{}T{}", self.date(), self.time())
    }

    /// `isoformat(timespec="milliseconds")` of a naive local time: `2026-11-11T14:10:00.123`.
    pub fn iso_millis(&self) -> String {
        format!("{}.{:03}", self.iso_seconds(), self.micros / 1000)
    }

    /// `datetime.now().astimezone().isoformat(timespec="seconds")`: `2026-11-11T14:10:00-06:00`.
    pub fn iso_seconds_offset(&self) -> String {
        let sign = if self.offset < 0 { '-' } else { '+' };
        let off = self.offset.abs();
        let mut out = format!(
            "{}{sign}{:02}:{:02}",
            self.iso_seconds(),
            off / 3600,
            (off % 3600) / 60
        );
        if off % 60 != 0 {
            out.push_str(&format!(":{:02}", off % 60));
        }
        out
    }
}

/// Runs a command with an optional time limit (Python's `subprocess.run(..., timeout=)`), its
/// output captured. Past the limit the process is killed and the error says so.
pub fn run(
    command: &mut Command,
    input: Option<&[u8]>,
    timeout: Option<Duration>,
) -> io::Result<Output> {
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    command.stdin(if input.is_some() {
        Stdio::piped()
    } else {
        Stdio::null()
    });
    let mut child = command.spawn()?;
    if let (Some(data), Some(mut stdin)) = (input, child.stdin.take()) {
        let data = data.to_vec();
        std::thread::spawn(move || {
            let _ = stdin.write_all(&data);
        });
    }
    let out = reader(child.stdout.take());
    let err = reader(child.stderr.take());
    let status = match wait(&mut child, timeout)? {
        Some(status) => status,
        None => {
            let _ = child.kill();
            let _ = child.wait();
            let seconds = timeout.map(|t| t.as_secs_f64()).unwrap_or_default();
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                format!(
                    "Command '{:?}' timed out after {} seconds",
                    command.get_program(),
                    crate::pyjson::float(seconds)
                ),
            ));
        }
    };
    Ok(Output {
        status,
        stdout: out.join().unwrap_or_default(),
        stderr: err.join().unwrap_or_default(),
    })
}

fn reader<R: Read + Send + 'static>(stream: Option<R>) -> std::thread::JoinHandle<Vec<u8>> {
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(mut s) = stream {
            let _ = s.read_to_end(&mut buf);
        }
        buf
    })
}

/// Waits for the child up to `timeout` (forever with None). None when it is still running.
pub fn wait(
    child: &mut Child,
    timeout: Option<Duration>,
) -> io::Result<Option<std::process::ExitStatus>> {
    let Some(limit) = timeout else {
        return child.wait().map(Some);
    };
    let deadline = Instant::now() + limit;
    loop {
        if let Some(status) = child.try_wait()? {
            return Ok(Some(status));
        }
        if Instant::now() >= deadline {
            return Ok(None);
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// A process's exit code as Python's `returncode`: negative for the signal that ended it.
pub fn returncode(status: &std::process::ExitStatus) -> i32 {
    use std::os::unix::process::ExitStatusExt;
    status
        .code()
        .unwrap_or_else(|| -status.signal().unwrap_or(0))
}

/// `shutil.which(name)`: the first executable file of that name on PATH.
pub fn which(name: &str) -> Option<PathBuf> {
    use std::os::unix::fs::PermissionsExt;
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(name))
        .find(|candidate| {
            std::fs::metadata(candidate)
                .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
                .unwrap_or(false)
        })
}

/// `uuid.uuid4().hex`.
pub fn uuid_hex() -> String {
    let mut bytes = [0u8; 16];
    let filled = std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut bytes))
        .is_ok();
    if !filled {
        // Never expected on macOS; still unique enough for file names.
        let seed = now_ns() ^ ((std::process::id() as u128) << 64);
        bytes.copy_from_slice(&seed.to_le_bytes());
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// `html.escape(text, quote=True)`.
pub fn escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#x27;"),
            c => out.push(c),
        }
    }
    out
}

/// Python's resumable_thread.atomic_write: write a temporary file (0600) next to it, then rename.
pub fn atomic_write(path: &Path, text: &str) -> io::Result<()> {
    personal_agent_core::thread_identity::atomic_write_standard(path, text.as_bytes())
        .map_err(|e| io::Error::other(e.to_string()))
}

/// `Path.mkdir(parents=True, exist_ok=True, mode=0o700)`: the last folder gets mode 0700 when it
/// is made (an existing one keeps its mode).
pub fn make_private_dir(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    if path.is_dir() {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    match std::fs::DirBuilder::new().mode(0o700).create(path) {
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists && path.is_dir() => Ok(()),
        other => other,
    }
}

pub fn chmod(path: &Path, mode: u32) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
}

/// Python's text of an OSError about a file: `[Errno 2] No such file or directory: '/x'`.
pub fn os_error(error: &io::Error, path: &Path) -> String {
    match error.raw_os_error() {
        Some(code) => {
            // SAFETY: strerror returns a pointer to a static message for any code.
            let message = unsafe { std::ffi::CStr::from_ptr(libc::strerror(code)) }
                .to_string_lossy()
                .into_owned();
            format!(
                "[Errno {code}] {message}: {}",
                crate::pyjson::repr_str(&path.to_string_lossy())
            )
        }
        None => error.to_string(),
    }
}

/// The names in a folder that Python's `glob("*")` lists (not the hidden ones), sorted as paths.
pub fn listing(dir: &Path) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = std::fs::read_dir(dir)
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .filter(|e| !e.file_name().to_string_lossy().starts_with('.'))
                .map(|e| e.path())
                .collect()
        })
        .unwrap_or_default();
    out.sort();
    out
}

pub fn file_name(path: &Path) -> String {
    path.file_name()
        .map(OsStr::to_string_lossy)
        .map(|s| s.into_owned())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes_like_python_html() {
        assert_eq!(
            escape("<a href=\"x\">'&'</a>"),
            "&lt;a href=&quot;x&quot;&gt;&#x27;&amp;&#x27;&lt;/a&gt;"
        );
    }

    #[test]
    fn uuid_is_32_hex() {
        let id = uuid_hex();
        assert_eq!(id.len(), 32);
        assert!(id.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(id, uuid_hex());
    }

    #[test]
    fn local_time_formats() {
        let t = Local::at(0.0);
        assert_eq!(t.iso_millis().len(), "1970-01-01T00:00:00.000".len());
        assert!(Local::now().iso_seconds_offset().len() >= 25);
    }

    #[test]
    fn run_times_out() {
        let err = run(
            Command::new("/bin/sleep").arg("5"),
            None,
            Some(Duration::from_millis(100)),
        )
        .unwrap_err();
        assert!(err.to_string().contains("timed out"));
        let out = run(
            &mut Command::new("/bin/cat"),
            Some(b"hi"),
            Some(Duration::from_secs(5)),
        )
        .unwrap();
        assert_eq!(out.stdout, b"hi");
    }
}
