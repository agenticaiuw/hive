//! Local FLARE Large lip reading with live, replaceable caption drafts (python/lipread.py).
//!
//! Tap fn to open the camera; tap again to submit the final transcript. Capture and inference run
//! concurrently in a persistent worker (scripts/lipread_worker.py, PyTorch). Drafts never trigger
//! agent actions. LIPREAD_DIR overrides the installation directory (and LIPREAD_DEVICE, read by the
//! worker, chooses mps or cpu).
//!
//! The worker's protocol: JSON lines tagged with a session number. In: `{"command": "start" |
//! "stop", "session": n}`. Out: `{"ready": true, "model", "device"}`, `{"status": "..."}`,
//! `{"camera": "waiting" | "on" | "off" | "failed"}`, `{"framing": "..."}`, `{"preview": "<jpeg>"}`,
//! `{"partial": "...", "final": false}`, and the result `{"text": "..." | "error": "...", "final": true}`.

use crate::process::{alive, exit_code, reap, truthy, wait_timeout, write_line};
use serde_json::{json, Value};
use std::ffi::OsString;
use std::fmt;
use std::fs::OpenOptions;
use std::io::{self, BufRead, BufReader};
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::Duration;

pub const MODES: [&str; 2] = ["voice", "lips"];

/// How long [`LipReader::stop`] waited by default (Python's `stop(timeout=60)`).
pub const STOP_TIMEOUT: Duration = Duration::from_secs(60);

/// scripts/lipread_worker.py
pub fn worker() -> PathBuf {
    hive_common::repo_root()
        .join("scripts")
        .join("lipread_worker.py")
}

/// LIPREAD_DIR, else <state>/lipread.
pub fn home() -> PathBuf {
    std::env::var_os("LIPREAD_DIR")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| hive_common::state_dir().join("lipread"))
}

/// "voice" or "lips": what tapping fn does, kept in <state>/input-mode.
pub fn get_mode() -> String {
    match std::fs::read_to_string(hive_common::state_dir().join("input-mode")) {
        Ok(mode) if MODES.contains(&mode.trim()) => mode.trim().to_string(),
        _ => "voice".into(),
    }
}

/// Keeps the choice. InvalidInput ("input is one of voice, lips") for anything else.
pub fn set_mode(mode: &str) -> io::Result<String> {
    if !MODES.contains(&mode) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("input is one of {}", MODES.join(", ")),
        ));
    }
    personal_agent_core::thread_identity::atomic_write_standard(
        &hive_common::state_dir().join("input-mode"),
        mode.as_bytes(),
    )
    .map_err(io::Error::other)?;
    Ok(mode.to_string())
}

/// Whether lip reading is set up, and if not, what's missing.
pub fn available() -> (bool, String) {
    let runtime = home().join("flare");
    let required = [
        runtime.join(".venv/bin/python"),
        runtime.join("large.pt"),
        runtime.join("flare/hubert_asr.py"),
    ];
    if !required.iter().all(|path| path.exists()) {
        return (
            false,
            "FLARE isn't set up: run scripts/setup-lipread.sh".into(),
        );
    }
    (true, "FLARE Large (2026), local live captions".into())
}

/// The lip reader couldn't do what was asked; the text says why.
#[derive(Debug, Clone, PartialEq)]
pub struct LipReaderError(pub String);

impl fmt::Display for LipReaderError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for LipReaderError {}

type EventFn = Arc<dyn Fn(Value) + Send + Sync>;

struct Worker {
    generation: u64,
    child: Arc<Mutex<Child>>,
    stdin: Arc<Mutex<Option<ChildStdin>>>,
}

#[derive(Default)]
struct Got {
    set: bool,
    result: Option<Value>,
}

struct Inner {
    command: Vec<OsString>,
    cwd: PathBuf,
    log: Mutex<PathBuf>,
    on_event: EventFn,
    worker: Mutex<Option<Worker>>,
    generations: AtomicU64,
    recording: AtomicBool,
    finishing: AtomicBool,
    session: AtomicU64,
    got: Mutex<Got>,
    got_changed: Condvar,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// A persistent FLARE worker that loads the model once and transcribes camera frames between
/// start() and stop(). on_event gets its drafts and camera/model status (`{"camera": "on"|"off"}`,
/// `{"ready": true}`, `{"error": ...}`), from the thread reading the worker. Clones share it.
#[derive(Clone)]
pub struct LipReader {
    inner: Arc<Inner>,
}

impl LipReader {
    /// The FLARE worker in [`home`]/flare: `flare/.venv/bin/python scripts/lipread_worker.py`.
    pub fn new(on_event: impl Fn(Value) + Send + Sync + 'static) -> LipReader {
        let base = home();
        let command = vec![
            base.join("flare/.venv/bin/python").into_os_string(),
            worker().into_os_string(),
        ];
        LipReader::with_command(command, base.join("flare"), on_event)
    }

    /// Another worker program, run in `cwd` (the tests' stand-in).
    pub fn with_command(
        command: Vec<OsString>,
        cwd: impl Into<PathBuf>,
        on_event: impl Fn(Value) + Send + Sync + 'static,
    ) -> LipReader {
        LipReader {
            inner: Arc::new(Inner {
                command,
                cwd: cwd.into(),
                log: Mutex::new(hive_common::paths::home().join("Library/Logs/agent-lipread.log")),
                on_event: Arc::new(on_event),
                worker: Mutex::new(None),
                generations: AtomicU64::new(0),
                recording: AtomicBool::new(false),
                finishing: AtomicBool::new(false),
                session: AtomicU64::new(0),
                got: Mutex::new(Got::default()),
                got_changed: Condvar::new(),
            }),
        }
    }

    /// Where the worker's stderr is appended (~/Library/Logs/agent-lipread.log), for diagnosis.
    pub fn set_log(&self, path: impl Into<PathBuf>) {
        *lock(&self.inner.log) = path.into();
    }

    /// The camera session: each start() is a new one, and events from older ones are dropped.
    pub fn session(&self) -> u64 {
        self.inner.session.load(Ordering::SeqCst)
    }

    /// Between start() and stop().
    pub fn recording(&self) -> bool {
        self.inner.recording.load(Ordering::SeqCst)
    }

    /// Starts the worker (it loads the model) without opening the camera, unless it's running.
    pub fn open(&self) -> io::Result<()> {
        let mut worker = lock(&self.inner.worker);
        if let Some(running) = worker.as_ref() {
            if alive(&mut lock(&running.child)) {
                return Ok(());
            }
        }
        let log = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&*lock(&self.inner.log))?;
        let (program, args) =
            self.inner.command.split_first().ok_or_else(|| {
                io::Error::new(io::ErrorKind::InvalidInput, "no lip reader command")
            })?;
        let mut command = Command::new(program);
        command.args(args).current_dir(&self.inner.cwd);
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::from(log));
        // SAFETY: setsid is async-signal-safe (Python's start_new_session=True).
        unsafe {
            command.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
        let mut child = command.spawn()?;
        let stdin = child.stdin.take();
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| io::Error::other("no stdout"))?;
        let generation = self.inner.generations.fetch_add(1, Ordering::SeqCst) + 1;
        let child = Arc::new(Mutex::new(child));
        *worker = Some(Worker {
            generation,
            child: child.clone(),
            stdin: Arc::new(Mutex::new(stdin)),
        });
        let inner = self.inner.clone();
        std::thread::Builder::new()
            .name("lipread".into())
            .spawn(move || read(inner, generation, child, stdout))?;
        Ok(())
    }

    /// Camera on.
    pub fn start(&self) -> Result<(), LipReaderError> {
        if self.inner.finishing.load(Ordering::SeqCst) {
            return Err(LipReaderError(
                "Still finishing your previous phrase".into(),
            ));
        }
        self.open()
            .map_err(|e| LipReaderError(format!("the lip reader isn't running ({e})")))?;
        {
            let mut got = lock(&self.inner.got);
            self.inner.session.fetch_add(1, Ordering::SeqCst);
            *got = Got::default();
            self.inner.recording.store(true, Ordering::SeqCst);
        }
        self.send("start")
    }

    /// Camera off; what was read (may be ""). Err if it couldn't read it.
    pub fn stop(&self, timeout: Duration) -> Result<String, LipReaderError> {
        if !self.recording() {
            return Ok(String::new());
        }
        self.inner.recording.store(false, Ordering::SeqCst);
        self.inner.finishing.store(true, Ordering::SeqCst);
        let sent = self.send("stop");
        let completed = sent.is_ok() && {
            let got = lock(&self.inner.got);
            let (got, _) = self
                .inner
                .got_changed
                .wait_timeout_while(got, timeout, |got| !got.set)
                .unwrap_or_else(|e| e.into_inner());
            got.set
        };
        self.inner.finishing.store(false, Ordering::SeqCst);
        sent?;
        if !completed {
            return Err(LipReaderError(format!(
                "no answer from the lip reader in {:.0} s",
                timeout.as_secs_f64()
            )));
        }
        let result = lock(&self.inner.got)
            .result
            .clone()
            .unwrap_or_else(|| json!({}));
        if let Some(error) = result.get("error").filter(|e| truthy(e)) {
            return Err(LipReaderError(
                error
                    .as_str()
                    .map(str::to_string)
                    .unwrap_or_else(|| error.to_string()),
            ));
        }
        Ok(result
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string())
    }

    /// Ends the worker: closing its input turns the camera off and quits it (killed after 3 s).
    pub fn close(&self) {
        let current = lock(&self.inner.worker)
            .as_ref()
            .map(|w| (w.child.clone(), w.stdin.clone()));
        if let Some((child, stdin)) = current {
            if alive(&mut lock(&child)) {
                lock(&stdin).take();
                let exited = wait_until_exit(&child, Duration::from_secs(3));
                if !exited {
                    reap(&mut lock(&child), Duration::ZERO);
                }
            }
            lock(&stdin).take();
        }
        *lock(&self.inner.worker) = None;
        self.inner.recording.store(false, Ordering::SeqCst);
    }

    fn send(&self, command: &str) -> Result<(), LipReaderError> {
        let stdin = lock(&self.inner.worker).as_ref().map(|w| w.stdin.clone());
        let message = json!({"command": command, "session": self.session()});
        let written = match stdin {
            Some(stdin) => match lock(&stdin).as_mut() {
                Some(pipe) => write_line(pipe, &message),
                None => Err(io::Error::new(
                    io::ErrorKind::BrokenPipe,
                    "its input is closed",
                )),
            },
            None => Err(io::Error::new(io::ErrorKind::NotConnected, "no worker")),
        };
        written.map_err(|e| {
            self.inner.recording.store(false, Ordering::SeqCst);
            LipReaderError(format!("the lip reader isn't running ({e})"))
        })
    }
}

/// Polls (without holding the lock while waiting) until the worker exits.
fn wait_until_exit(child: &Mutex<Child>, timeout: Duration) -> bool {
    let deadline = std::time::Instant::now() + timeout;
    loop {
        if wait_timeout(&mut lock(child), Duration::ZERO).is_some() {
            return true;
        }
        if std::time::Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

impl Inner {
    fn current(&self, generation: u64) -> bool {
        lock(&self.worker)
            .as_ref()
            .is_some_and(|w| w.generation == generation)
    }
}

fn same_session(value: &Value, session: u64) -> bool {
    value.as_f64() == Some(session as f64)
}

fn read(inner: Arc<Inner>, generation: u64, child: Arc<Mutex<Child>>, stdout: ChildStdout) {
    for line in BufReader::new(stdout).lines() {
        let Ok(line) = line else { break };
        let Ok(event @ Value::Object(_)) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if !inner.current(generation) {
            continue;
        }
        if let Some(session) = event.get("session") {
            if !same_session(session, inner.session.load(Ordering::SeqCst)) {
                continue;
            }
        }
        let final_ = event.get("final").is_none_or(truthy);
        if final_ && (event.get("text").is_some() || event.get("error").is_some()) {
            let mut got = lock(&inner.got);
            got.result = Some(event.clone());
            got.set = true;
            inner.got_changed.notify_all();
        }
        (inner.on_event)(event);
    }
    if !inner.current(generation) {
        return;
    }
    let unanswered = !lock(&inner.got).set;
    if unanswered {
        wait_until_exit(&child, Duration::from_secs(3600));
        let code = lock(&child)
            .try_wait()
            .ok()
            .flatten()
            .map(exit_code)
            .unwrap_or(-1);
        let mut got = lock(&inner.got);
        if !got.set {
            got.result = Some(json!({"error": format!("the lip reader stopped (exit {code})")}));
            got.set = true;
            inner.got_changed.notify_all();
        }
    }
    (inner.on_event)(json!({"camera": "off"}));
}
