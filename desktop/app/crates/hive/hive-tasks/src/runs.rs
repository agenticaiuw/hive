//! What Hive's agent on this Mac is doing, live on the owner's board in the cloud (POST /v1/runs,
//! cloud/tasks/worker.js), so the dashboard on every node shows it as it happens, beside what Hive's
//! cloud agent and the browser extensions' agents are doing.
//!
//! The app hands each line of its session journal to [`RunStream::note`]: a request the owner gives
//! starts a run; each thing the agent then does, thinks or says (its lines carry the request) is a
//! step of that run; "done" or "failed" ends it, and the owner stopping Hive with fn stops it. A
//! thread sends the steps a few at a time every couple of seconds, numbered so a post sent twice
//! lands once. Sending never holds up the agent: with no cloud copy (~/.config/hive/tasks.json)
//! nothing is sent, and what a post couldn't deliver goes with the next one (at most MOST_UNSENT
//! steps a run).

use crate::Cloud;
use serde_json::{json, Value};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const EVERY: Duration = Duration::from_secs(2);
const MOST_UNSENT: usize = 300;
const MOST_A_POST: usize = 100;
/// How long closing waits for the last post: quitting Hive never hangs on the cloud.
const LAST_POST_WAIT: Duration = Duration::from_secs(3);

/// The journal's kinds that are steps of the run under way.
const STEP_KINDS: [&str; 5] = ["action", "think", "say", "done", "failed"];

/// Sends this Mac's runs to the board from its own thread. Dropping it sends what's left first
/// (waiting at most LAST_POST_WAIT for it).
pub struct RunStream {
    lines: Option<Sender<(String, String, String, i64)>>,
    finished: Mutex<Option<Receiver<()>>>,
}

impl RunStream {
    /// Streams the runs of journal session `session` (its id names them: "<session>-1", "-2"…).
    pub fn start(session: &str) -> RunStream {
        match Cloud::load() {
            Some(cloud) => {
                let machine = cloud.machine.clone();
                Self::start_with(session, &machine, move |body| {
                    cloud.post("/v1/runs", body).map(|_| ())
                })
            }
            None => RunStream {
                lines: None,
                finished: Mutex::new(None),
            },
        }
    }

    /// The same, posting each body with `post` (tests).
    pub fn start_with(
        session: &str,
        machine: &str,
        mut post: impl FnMut(&Value) -> Result<(), String> + Send + 'static,
    ) -> RunStream {
        let (lines, received) = channel::<(String, String, String, i64)>();
        let (finish, finished) = channel::<()>();
        let mut runs = Runs::new(session, machine);
        let started = std::thread::Builder::new()
            .name("hive-runs".into())
            .spawn(move || {
                let mut next = Instant::now() + EVERY;
                loop {
                    let wait = next.saturating_duration_since(Instant::now());
                    match received.recv_timeout(wait) {
                        Ok((kind, text, request, at)) => {
                            if runs.note(&kind, &text, &request, at) {
                                runs.send(&mut post); // a run ended: say so now
                            }
                            continue;
                        }
                        Err(RecvTimeoutError::Timeout) => {}
                        Err(RecvTimeoutError::Disconnected) => {
                            runs.send(&mut post);
                            let _ = finish.send(());
                            return;
                        }
                    }
                    runs.send(&mut post);
                    next = Instant::now() + EVERY;
                }
            })
            .is_ok();
        RunStream {
            lines: started.then_some(lines),
            finished: Mutex::new(started.then_some(finished)),
        }
    }

    /// One line of the session journal: its kind, text and fields (`request` names the request a
    /// step is part of).
    pub fn note(&self, kind: &str, text: &str, fields: &Value) {
        let Some(lines) = &self.lines else { return };
        let request = fields
            .get("request")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let _ = lines.send((kind.to_string(), text.to_string(), request, at));
    }
}

impl Drop for RunStream {
    fn drop(&mut self) {
        self.lines = None; // the thread sends what's left and ends
        let finished = self.finished.lock().ok().and_then(|mut f| f.take());
        if let Some(finished) = finished {
            let _ = finished.recv_timeout(LAST_POST_WAIT);
        }
    }
}

struct Run {
    id: String,
    title: String,
    status: Option<&'static str>,
    count: u64,
    unsent: Vec<Value>,
    shown: bool,
    ended: bool,
}

/// The runs of one journal session, and what of them the board hasn't got yet.
pub struct Runs {
    session: String,
    machine: String,
    started: u64,
    runs: Vec<Run>,
}

impl Runs {
    pub fn new(session: &str, machine: &str) -> Runs {
        Runs {
            session: session.to_string(),
            machine: machine.to_string(),
            started: 0,
            runs: vec![],
        }
    }

    /// Takes one journal line; true when it ended a run.
    pub fn note(&mut self, kind: &str, text: &str, request: &str, at: i64) -> bool {
        let text = text.trim();
        match kind {
            "request" => {
                // A new request: one still going under the same words was left behind.
                for run in self.runs.iter_mut().filter(|r| r.title == text && r.status.is_none()) {
                    run.status = Some("stopped");
                }
                self.started += 1;
                self.runs.push(Run {
                    id: format!("{}-{}", self.session, self.started),
                    title: text.to_string(),
                    status: None,
                    count: 0,
                    unsent: vec![],
                    shown: false,
                    ended: false,
                });
                false
            }
            "stopped by fn" => {
                let mut ended = false;
                for run in self.runs.iter_mut().filter(|r| r.status.is_none()) {
                    run.status = Some("stopped");
                    ended = true;
                }
                ended
            }
            kind if STEP_KINDS.contains(&kind) && !text.is_empty() => {
                let Some(run) = self
                    .runs
                    .iter_mut()
                    .rev()
                    .find(|r| r.status.is_none() && (request.is_empty() || r.title == request.trim()))
                else {
                    return false;
                };
                run.count += 1;
                run.unsent
                    .push(json!({"n": run.count, "at": at, "kind": kind, "text": text}));
                if run.unsent.len() > MOST_UNSENT {
                    let extra = run.unsent.len() - MOST_UNSENT;
                    run.unsent.drain(..extra);
                }
                if kind == "done" || kind == "failed" {
                    run.status = Some(if kind == "done" { "done" } else { "failed" });
                    return true;
                }
                false
            }
            _ => false,
        }
    }

    /// Posts what the board hasn't got; stops at the first post that fails (the cloud is away), to
    /// try again next time.
    pub fn send(&mut self, post: &mut impl FnMut(&Value) -> Result<(), String>) {
        for run in self.runs.iter_mut() {
            while !run.ended && (!run.shown || !run.unsent.is_empty() || run.status.is_some()) {
                let steps: Vec<Value> = run.unsent.iter().take(MOST_A_POST).cloned().collect();
                let last = run.status.filter(|_| run.unsent.len() <= MOST_A_POST);
                let mut body = json!({
                    "machine": self.machine, "run": run.id, "agent": "mac", "title": run.title,
                    "steps": steps,
                });
                if let Some(status) = last {
                    body["status"] = json!(status);
                }
                if post(&body).is_err() {
                    return;
                }
                let through = steps.last().and_then(|s| s["n"].as_u64()).unwrap_or(0);
                run.unsent.retain(|s| s["n"].as_u64().unwrap_or(0) > through);
                run.shown = true;
                run.ended = last.is_some();
                if !run.ended && run.unsent.is_empty() {
                    break; // still going, and the board has all of it
                }
            }
        }
        self.runs.retain(|r| !r.ended);
    }
}
