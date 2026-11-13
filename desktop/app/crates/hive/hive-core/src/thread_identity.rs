//! Durable, process-safe identity for one non-ephemeral Codex conversation.
//!
//! A missing identity may start a thread once. Every existing identity is resumed,
//! never replaced. The pending marker intentionally survives an ambiguous start.

use fs4::FileExt;
use serde_json::{Map, Value};
use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);
const PENDING: &str = "!thread-start-pending\n";
// "config" carries the shell's network access (sandbox_workspace_write.network_access).
const RESUME_KEYS: [&str; 7] = [
    "baseInstructions",
    "developerInstructions",
    "cwd",
    "sandbox",
    "permissions",
    "approvalPolicy",
    "config",
];

/// A synchronous adapter to an already initialized app-server connection.
pub trait SessionTransport {
    fn request(&mut self, method: &str, params: Value) -> Result<Value, String>;
}

#[derive(Debug)]
pub enum IdentityError {
    Io {
        context: &'static str,
        source: io::Error,
    },
    InvalidIdentity,
    IdentityChanged,
    IdentityMismatch,
    EphemeralThread,
    InvalidParameters,
    Request {
        method: &'static str,
        message: String,
    },
}

impl fmt::Display for IdentityError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io { context, source } => write!(f, "{context}: {source}"),
            Self::InvalidIdentity => write!(f, "Invalid saved or returned thread ID; refusing to replace the conversation"),
            Self::IdentityChanged => write!(f, "Saved thread identity changed or disappeared; refusing to replace the conversation"),
            Self::IdentityMismatch => write!(f, "Resumed thread ID mismatch; conversation was not replaced"),
            Self::EphemeralThread => write!(f, "Server returned an ephemeral thread; conversation was not replaced"),
            Self::InvalidParameters => write!(f, "Thread parameters must be an object"),
            Self::Request { method, message } => write!(f, "{method} failed: {message}. Conversation was not replaced"),
        }
    }
}
impl std::error::Error for IdentityError {}

fn io_error(context: &'static str, source: io::Error) -> IdentityError {
    IdentityError::Io { context, source }
}

pub fn validate_identity(value: &str) -> Result<&str, IdentityError> {
    if !value.is_empty()
        && value.len() <= 200
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        Ok(value)
    } else {
        Err(IdentityError::InvalidIdentity)
    }
}

fn ensure_parent(path: &Path) -> Result<&Path, IdentityError> {
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder
        .create(parent)
        .map_err(|e| io_error("Could not create thread state directory", e))?;
    Ok(parent)
}

/// Atomically replace a file and flush its contents and containing directory.
/// On failure a partially written temporary file is intentionally retained for diagnosis.
pub fn atomic_write(path: &Path, data: &[u8]) -> Result<(), IdentityError> {
    atomic_write_impl(path, data, true)
}

/// Match the host's normal fsync behavior for non-identity state files.
pub fn atomic_write_standard(path: &Path, data: &[u8]) -> Result<(), IdentityError> {
    atomic_write_impl(path, data, false)
}

fn flush(file: &File, full: bool) -> io::Result<()> {
    if full {
        return file.sync_all();
    }
    #[cfg(unix)]
    {
        use std::os::fd::AsRawFd;
        if unsafe { libc::fsync(file.as_raw_fd()) } == 0 {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        }
    }
    #[cfg(not(unix))]
    {
        file.sync_all()
    }
}

fn atomic_write_impl(path: &Path, data: &[u8], full: bool) -> Result<(), IdentityError> {
    let parent = ensure_parent(path)?;
    let mut created = None;
    for _ in 0..100 {
        let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let temp = parent.join(format!(".pending-{}-{sequence}", std::process::id()));
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        match options.open(&temp) {
            Ok(file) => {
                created = Some((temp, file));
                break;
            }
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(io_error("Could not create pending thread state", e)),
        }
    }
    let (temp, mut file) = created.ok_or_else(|| {
        io_error(
            "Could not allocate pending thread state",
            io::Error::new(io::ErrorKind::AlreadyExists, "temporary names exhausted"),
        )
    })?;
    file.write_all(data)
        .and_then(|_| flush(&file, full))
        .map_err(|e| io_error("Could not persist thread state", e))?;
    drop(file);
    fs::rename(&temp, path).map_err(|e| io_error("Could not replace thread state", e))?;
    // Directory fsync is available on the macOS/Linux targets of the current agent.
    #[cfg(unix)]
    File::open(parent)
        .and_then(|directory| flush(&directory, full))
        .map_err(|e| io_error("Could not sync thread state directory", e))?;
    Ok(())
}

struct IdentityLock(File);
impl IdentityLock {
    fn acquire(path: &Path) -> Result<Self, IdentityError> {
        ensure_parent(path)?;
        let mut lock_name = path.as_os_str().to_os_string();
        lock_name.push(".lock");
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let file = options
            .open(PathBuf::from(lock_name))
            .map_err(|e| io_error("Could not open identity lock", e))?;
        file.lock_exclusive()
            .map_err(|e| io_error("Could not acquire identity lock", e))?;
        Ok(Self(file))
    }
}
impl Drop for IdentityLock {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.0);
    }
}

/// One logical conversation. Retain the same object for in-process identity-change checks.
pub struct ResumableThread {
    path: PathBuf,
    thread_id: Option<String>,
}

impl ResumableThread {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            thread_id: None,
        }
    }
    /// Restore the caller's in-process identity guard across bridge invocations.
    pub fn with_expected(
        path: impl Into<PathBuf>,
        expected: Option<String>,
    ) -> Result<Self, IdentityError> {
        if let Some(id) = &expected {
            validate_identity(id)?;
        }
        Ok(Self {
            path: path.into(),
            thread_id: expected,
        })
    }
    pub fn thread_id(&self) -> Option<&str> {
        self.thread_id.as_deref()
    }

    pub fn connect<T: SessionTransport>(
        &mut self,
        server: &mut T,
        params: &Value,
    ) -> Result<String, IdentityError> {
        let input = params.as_object().ok_or(IdentityError::InvalidParameters)?;
        let _lock = IdentityLock::acquire(&self.path)?;
        let saved = match fs::read_to_string(&self.path) {
            Ok(value) => Some(value.trim().to_owned()),
            Err(e) if e.kind() == io::ErrorKind::NotFound => None,
            Err(e) => return Err(io_error("Could not read saved thread identity", e)),
        };
        if self.thread_id.is_some() && self.thread_id != saved {
            return Err(IdentityError::IdentityChanged);
        }
        let (method, options): (&'static str, Value) = match saved.as_deref() {
            Some(id) => {
                validate_identity(id)?;
                self.thread_id = Some(id.to_owned());
                let mut options = Map::new();
                options.insert("threadId".into(), Value::String(id.to_owned()));
                for key in RESUME_KEYS {
                    if let Some(value) = input.get(key) {
                        options.insert(key.into(), value.clone());
                    }
                }
                ("thread/resume", Value::Object(options))
            }
            None => {
                atomic_write(&self.path, PENDING.as_bytes())?;
                let mut options = input.clone();
                options.insert("ephemeral".into(), Value::Bool(false));
                ("thread/start", Value::Object(options))
            }
        };
        let result = server
            .request(method, options)
            .map_err(|message| IdentityError::Request { method, message })?;
        let thread = result
            .get("thread")
            .and_then(Value::as_object)
            .ok_or(IdentityError::InvalidIdentity)?;
        let id = thread
            .get("id")
            .and_then(Value::as_str)
            .ok_or(IdentityError::InvalidIdentity)?;
        validate_identity(id)?;
        if let Some(existing) = saved.as_deref() {
            if existing != id {
                return Err(IdentityError::IdentityMismatch);
            }
        }
        if thread.get("ephemeral") == Some(&Value::Bool(true)) {
            return Err(IdentityError::EphemeralThread);
        }
        if saved.is_none() {
            atomic_write(&self.path, format!("{id}\n").as_bytes())?;
        }
        self.thread_id = Some(id.to_owned());
        Ok(id.to_owned())
    }
}
