//! Hive changing itself, the Mac's part (the owner, 2026-11-20: "you're adding the capabilities of a
//! self-improving harness so that Hive can improve itself"). The VM's part is cloud/vm-agent
//! (improve.mjs, orchestrator.mjs improveOnVm): when a task finds Hive missing something, a code agent
//! there changes Hive. Hive on the Mac builds only on macOS, so a change to it is tested and put in
//! here, through one call the VM's orchestrator makes on this Mac, `hive_self`:
//!
//!   {action: "check", branch}    the change on branch hive/improve-… (pushed by the VM): its Rust crates
//!                                built and the touched ones tested, the touched scripts' tests run, and
//!                                the whole Mac release built (cloud/release.mjs mac --dry-run), in a
//!                                worktree of its own; nothing it builds touches the running Hive
//!   {action: "install", commit}  the change landed on main: a Mac release built from that commit and
//!                                published (every Mac on releases updates itself), and put in on this
//!                                Mac once Hive is idle, then Hive restarts on it
//!   {action: "board", commit}    the change landed on main and touches the board: the board deployed
//!                                from that commit (cloud/release.mjs board), with this Mac's own Cloudflare
//!                                sign-in, for a VM that has none
//!   {action: "site", commit}     the change landed on main and touches the dashboard: the dashboard
//!                                website deployed from that commit (cloud/release.mjs site), the same way
//!   {action: "phone", commit}    the change landed on main and touches Hive Phone: it built (Xcode, so on
//!                                a Mac) and published from that commit (cloud/release.mjs phone), which
//!                                SideStore then offers on every member's iPhone
//!   {action: "status", job}      how a job stands, and the release this Mac's Hive runs now
//!
//! A job runs in the background (a build takes minutes; one call on the Mac is held for six at most),
//! one at a time, and is kept as a file, so the status of an install reads the same after the restart
//! it ends with. It isn't one of the Mac's tools: a task's agent never sees it (mac-mcp.mjs calls only
//! the tools the Mac lists). Only what runs here is fixed: the commands come from which files changed,
//! never from the call.
//!
//! This Mac may run the owner's own build ("dev", built by hand from this folder). A release goes in
//! over it only when that build has nothing the release lacks: no uncommitted change to the Mac's
//! sources here, and this folder's commit is part of the release's.

use serde_json::{json, Value};
use std::io::Read as _;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// What a Mac release is built from (cloud/release.mjs MAC_SOURCES): a change to these here is the
/// owner's work the running build may hold.
pub const MAC_SOURCES: [&str; 14] = [
    "desktop/app/crates/hive", "desktop/app/tools", "desktop/app/Makefile", "dashboard/src", "dashboard/static",
    "dashboard/package.json", "dashboard/package-lock.json", "dashboard/svelte.config.js", "dashboard/vite.config.ts",
    "browser/chrome/src", "browser/chrome/package.mjs", "browser/chrome/package.json", "cloud/shared",
    "cloud/hive-cloud/worker.js",
];
/// The call's name.
pub const NAME: &str = "hive_self";
const CRATES: &str = "desktop/app/crates/hive";
/// One command of a check at most this long.
const STEP_LIMIT: Duration = Duration::from_secs(40 * 60);
/// How long an install waits for Hive to be idle before it leaves the release for the next start.
const IDLE_LIMIT: Duration = Duration::from_secs(6 * 3600);
/// What a failed command says, at most (its end, where the failures are).
const MOST_SAID: usize = 6000;

/// One command a check runs: in `dir` (relative to the change's worktree; "" is its root).
#[derive(Debug, Clone, PartialEq)]
pub struct Check {
    pub label: String,
    pub dir: String,
    pub program: String,
    pub args: Vec<String>,
}

fn check(label: &str, dir: &str, program: &str, args: &[&str]) -> Check {
    Check { label: label.into(), dir: dir.into(), program: program.into(), args: args.iter().map(|a| a.to_string()).collect() }
}

/// A branch the VM's orchestrator pushes a change of Hive's on.
pub fn valid_branch(branch: &str) -> bool {
    branch.strip_prefix("hive/improve-").is_some_and(|rest| {
        !rest.is_empty() && rest.len() <= 80 && rest.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b)) && !rest.contains("..")
    })
}

/// A full commit id.
pub fn valid_commit(commit: &str) -> bool {
    commit.len() == 40 && commit.bytes().all(|b| b.is_ascii_hexdigit())
}

/// The tests a change's files call for, before the whole release is built: the Rust crates built
/// (all of them, as a change to one can break those using it) and the touched ones tested, and the
/// tests of each script part it touched.
pub fn checks(files: &[String]) -> Vec<Check> {
    let mut out = Vec::new();
    let crates_dir = format!("{CRATES}/");
    let mut touched: Vec<String> = files
        .iter()
        .filter_map(|f| f.strip_prefix(&crates_dir))
        .filter_map(|rest| rest.split_once('/').map(|(name, _)| name.to_string()))
        .filter(|name| name.starts_with("hive-") && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'))
        .collect();
    touched.sort();
    touched.dedup();
    if files.iter().any(|f| f.starts_with(&crates_dir)) {
        out.push(check("Building Hive's Rust crates", CRATES, "cargo", &["check", "--workspace", "--all-targets", "--offline", "--quiet"]));
        for name in &touched {
            out.push(check(&format!("Testing {name}"), CRATES, "cargo", &["test", "-p", name, "--offline", "--quiet"]));
        }
    }
    if files.iter().any(|f| f.starts_with("desktop/") && !f.starts_with("desktop/app/") && f.ends_with(".mjs")) {
        out.push(check("Testing desktop's scripts", "", "/bin/sh", &["-c", "node --test desktop/tests/*.test.mjs"]));
    }
    if files.iter().any(|f| f.starts_with("dashboard/")) {
        out.push(check("Testing the dashboard", "dashboard", "npm", &["test", "--silent"]));
    }
    if files.iter().any(|f| f.starts_with("browser/chrome/")) {
        out.push(check("Testing the browser extension", "browser/chrome", "/bin/sh", &["-c", "node --test test/*.test.js"]));
    }
    out
}

/// Whether this Mac's Hive can take a release of `commit`: a release build always; the owner's own
/// build only when it has nothing the release lacks.
pub fn may_put_in_here(running: &str, changed_here: &[String], here_in_release: bool) -> Result<(), String> {
    if running != "dev" {
        return Ok(());
    }
    if !changed_here.is_empty() {
        let some: Vec<&str> = changed_here.iter().take(3).map(String::as_str).collect();
        return Err(format!(
            "this Mac runs the owner's own build, and its folder has changes not on main ({}{}), so the release isn't put in over it; it goes in with the owner's next build",
            some.join(", "),
            if changed_here.len() > 3 { ", …" } else { "" }
        ));
    }
    if !here_in_release {
        return Err("this Mac runs the owner's own build, from a commit the release doesn't have, so the release isn't put in over it; it goes in with the owner's next build".into());
    }
    Ok(())
}

/// The end of what a command said: where the failures are.
pub fn tail(said: &str) -> String {
    let lines: Vec<&str> = said.lines().collect();
    let kept = lines[lines.len().saturating_sub(80)..].join("\n");
    let start = kept.len().saturating_sub(MOST_SAID);
    let start = (start..=kept.len()).find(|i| kept.is_char_boundary(*i)).unwrap_or(kept.len());
    kept[start..].to_string()
}

/// The newest Node in ~/.nvm, where the owner's tools are; Hive.app's own PATH has none of them.
fn search_path(home: &Path) -> String {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(home.join(".nvm/versions/node")) {
        let mut versions: Vec<(Vec<u64>, PathBuf)> = entries
            .filter_map(Result::ok)
            .filter_map(|e| {
                let name = e.file_name().to_string_lossy().trim_start_matches('v').to_string();
                let parts: Vec<u64> = name.split('.').map(|p| p.parse().unwrap_or(0)).collect();
                Some((parts, e.path().join("bin")))
            })
            .collect();
        versions.sort();
        if let Some((_, bin)) = versions.pop() {
            dirs.push(bin);
        }
    }
    dirs.push(home.join(".cargo/bin"));
    for d in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"] {
        dirs.push(PathBuf::from(d));
    }
    dirs.iter().map(|d| d.display().to_string()).collect::<Vec<_>>().join(":")
}

fn secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Hive on this Mac changing itself: see the module's comment.
pub struct SelfChange {
    repo: PathBuf,
    home: PathBuf,
    jobs: PathBuf,
    idle: Arc<dyn Fn() -> bool + Send + Sync>,
    restart: Arc<dyn Fn(&str) + Send + Sync>,
    busy: Mutex<Option<String>>,
}

impl SelfChange {
    /// `repo` is the Hive folder this agent runs from; jobs are kept in `jobs`.
    pub fn new(repo: PathBuf, jobs: PathBuf, idle: Arc<dyn Fn() -> bool + Send + Sync>, restart: Arc<dyn Fn(&str) + Send + Sync>) -> Arc<SelfChange> {
        let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/"));
        Arc::new(SelfChange { repo, home, jobs, idle, restart, busy: Mutex::new(None) })
    }

    /// One `hive_self` call: what came of it, as a Mac tool's MCP result.
    pub fn call(self: &Arc<Self>, args: &Value) -> Value {
        let answer = match args["action"].as_str().unwrap_or("") {
            "check" => {
                let branch = args["branch"].as_str().unwrap_or("").trim().to_string();
                if !valid_branch(&branch) {
                    Err("check takes the branch a change of Hive's is on (hive/improve-…)".to_string())
                } else {
                    self.start("check", json!({ "branch": branch }))
                }
            }
            action @ ("install" | "board" | "site" | "phone") => {
                let commit = args["commit"].as_str().unwrap_or("").trim().to_lowercase();
                if !valid_commit(&commit) {
                    Err(format!("{action} takes the full id of the commit on main"))
                } else if action != "install" {
                    self.start(action, json!({ "commit": commit }))
                } else {
                    let notes: String = args["notes"].as_str().unwrap_or("").chars().take(200).collect();
                    self.start("install", json!({ "commit": commit, "notes": notes }))
                }
            }
            "status" => {
                let job = args["job"].as_str().unwrap_or("");
                self.read(job).map(|mut j| {
                    j["running"] = json!(hive_tasks::node::VERSION);
                    j
                })
            }
            _ => Err("hive_self takes action check, install, board, site, phone or status".to_string()),
        };
        match answer {
            Ok(v) => json!({ "content": [{ "type": "text", "text": v.to_string() }] }),
            Err(e) => json!({ "content": [{ "type": "text", "text": format!("Failed: {e}") }], "isError": true }),
        }
    }

    fn job_file(&self, job: &str) -> Option<PathBuf> {
        (!job.is_empty() && job.len() <= 40 && job.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'))
            .then(|| self.jobs.join(format!("{job}.json")))
    }

    fn read(&self, job: &str) -> Result<Value, String> {
        let file = self.job_file(job).ok_or("no such job")?;
        let text = std::fs::read_to_string(&file).map_err(|_| format!("no job {job} on this Mac"))?;
        serde_json::from_str(&text).map_err(|e| format!("job {job}: {e}"))
    }

    fn write(&self, job: &Value) {
        let Some(file) = self.job_file(job["id"].as_str().unwrap_or("")) else { return };
        let _ = std::fs::create_dir_all(&self.jobs);
        let tmp = file.with_extension("json.tmp");
        if std::fs::write(&tmp, serde_json::to_vec_pretty(job).unwrap_or_default()).is_ok() {
            let _ = std::fs::rename(&tmp, &file);
        }
    }

    fn start(self: &Arc<Self>, action: &str, with: Value) -> Result<Value, String> {
        let mut busy = self.busy.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(job) = busy.as_ref() {
            return Err(format!("this Mac is still on job {job}"));
        }
        let id = format!("{action}-{}-{}", secs(), std::process::id() % 10000);
        let mut job = json!({ "id": id, "action": action, "state": "running", "started": secs(), "steps": [] });
        for (k, v) in with.as_object().into_iter().flatten() {
            job[k] = v.clone();
        }
        self.write(&job);
        *busy = Some(id.clone());
        drop(busy);
        let me = self.clone();
        let started = job.clone();
        let spawned = std::thread::Builder::new().name("hive-self".into()).spawn(move || {
            let mut job = started;
            let ran = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                match job["action"].as_str().unwrap_or("").to_string().as_str() {
                    "check" => me.run_check(&mut job),
                    what @ ("board" | "site" | "phone") => me.run_deploy(&mut job, what),
                    _ => me.run_install(&mut job),
                }
            }));
            match ran {
                Ok(Ok(())) => {}
                Ok(Err(why)) => {
                    job["state"] = json!("failed");
                    job["failures"] = json!(why);
                }
                Err(_) => {
                    job["state"] = json!("failed");
                    job["failures"] = json!("the job crashed");
                }
            }
            job["ended"] = json!(secs());
            me.write(&job);
            *me.busy.lock().unwrap_or_else(|e| e.into_inner()) = None;
            if job["state"] == "installed" {
                (me.restart)(&format!("restart to run Hive {}, which Hive changed itself for", job["version"].as_str().unwrap_or("")));
            }
        });
        if spawned.is_err() {
            *self.busy.lock().unwrap_or_else(|e| e.into_inner()) = None;
            return Err("the job couldn't start".into());
        }
        Ok(json!({ "job": id, "state": "running" }))
    }

    fn path(&self) -> String {
        search_path(&self.home)
    }

    /// A command, with the owner's tools and nothing else of Hive's environment, at most `limit` long:
    /// whether it succeeded, and what it said.
    fn run(&self, dir: &Path, program: &str, args: &[String], limit: Duration) -> (bool, String) {
        let out = self.jobs.join(format!("out-{}-{}.txt", std::process::id(), secs()));
        let _ = std::fs::create_dir_all(&self.jobs);
        let Ok(file) = std::fs::File::create(&out) else { return (false, "couldn't keep its output".into()) };
        let Ok(err) = file.try_clone() else { return (false, "couldn't keep its output".into()) };
        let spawned = Command::new(program)
            .args(args)
            .current_dir(dir)
            .env_clear()
            .env("PATH", self.path())
            .env("HOME", &self.home)
            .env("USER", std::env::var("USER").unwrap_or_default())
            .env("LANG", "en_US.UTF-8")
            .env("CARGO_TERM_COLOR", "never")
            .env("NO_COLOR", "1")
            .stdin(Stdio::null())
            .stdout(file)
            .stderr(err)
            .spawn();
        let mut child = match spawned {
            Ok(c) => c,
            Err(e) => {
                let _ = std::fs::remove_file(&out);
                return (false, format!("{program} wouldn't start: {e}"));
            }
        };
        let until = Instant::now() + limit;
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break Some(status),
                Ok(None) if Instant::now() < until => std::thread::sleep(Duration::from_millis(500)),
                _ => {
                    let _ = child.kill();
                    let _ = child.wait();
                    break None;
                }
            }
        };
        let mut said = String::new();
        if let Ok(mut f) = std::fs::File::open(&out) {
            let mut bytes = Vec::new();
            let _ = f.read_to_end(&mut bytes);
            said = String::from_utf8_lossy(&bytes).into_owned();
        }
        let _ = std::fs::remove_file(&out);
        match status {
            Some(s) => (s.success(), said),
            None => (false, format!("{}\n(stopped after {} minutes)", said, limit.as_secs() / 60)),
        }
    }

    fn git(&self, args: &[&str]) -> Result<String, String> {
        let args: Vec<String> = ["-C", &self.repo.display().to_string()].iter().map(|s| s.to_string()).chain(args.iter().map(|s| s.to_string())).collect();
        let (ok, said) = self.run(&self.repo, "git", &args, Duration::from_secs(300));
        if ok {
            Ok(said.trim_end().to_string())
        } else {
            Err(format!("git {}: {}", args[2..].join(" "), tail(&said)))
        }
    }

    /// A worktree of `commit` beside the jobs, with the bundlers' installs from this folder.
    /// Where a job's worktree goes: a folder with no space in its path (the state folder is under
    /// "Application Support", and not every build tool takes a space).
    fn work_root(&self) -> PathBuf {
        std::env::temp_dir().join("hive-self-change")
    }

    fn worktree(&self, job: &str, commit: &str) -> Result<PathBuf, String> {
        let dir = self.work_root().join(job);
        let _ = std::fs::create_dir_all(self.work_root());
        let _ = self.git(&["worktree", "prune"]);
        self.git(&["worktree", "add", "--quiet", "--detach", &dir.display().to_string(), commit])?;
        for part in ["dashboard", "browser/chrome"] {
            let (have, need) = (self.repo.join(part).join("node_modules"), dir.join(part).join("node_modules"));
            if have.exists() && !need.exists() {
                let _ = std::os::unix::fs::symlink(&have, &need);
            }
        }
        Ok(dir)
    }

    fn drop_worktree(&self, dir: &Path) {
        let _ = self.git(&["worktree", "remove", "--force", &dir.display().to_string()]);
        let _ = std::fs::remove_dir_all(dir);
    }

    fn step(&self, job: &mut Value, label: &str, ok: bool, started: Instant) {
        if let Some(steps) = job["steps"].as_array_mut() {
            steps.push(json!({ "label": label, "ok": ok, "seconds": started.elapsed().as_secs() }));
        }
        self.write(job);
    }

    fn run_check(&self, job: &mut Value) -> Result<(), String> {
        let branch = job["branch"].as_str().unwrap_or("").to_string();
        self.git(&["fetch", "--quiet", "origin", "main", &format!("+refs/heads/{branch}:refs/remotes/origin/{branch}")])?;
        let commit = self.git(&["rev-parse", &format!("refs/remotes/origin/{branch}")])?;
        let files: Vec<String> = self
            .git(&["diff", "--name-only", &format!("refs/remotes/origin/main...{commit}")])?
            .lines()
            .map(str::to_string)
            .filter(|l| !l.is_empty())
            .collect();
        job["commit"] = json!(commit);
        job["files"] = json!(files);
        let dir = self.worktree(job["id"].as_str().unwrap_or("check"), &commit)?;
        let mut all = checks(&files);
        all.push(Check {
            label: "Building the whole Mac release".into(),
            dir: String::new(),
            program: "node".into(),
            args: vec![self.repo.join("cloud/release.mjs").display().to_string(), "mac".into(), "--from".into(), dir.display().to_string(), "--dry-run".into()],
        });
        let result = (|| {
            for c in &all {
                let started = Instant::now();
                let at = if c.dir.is_empty() { dir.clone() } else { dir.join(&c.dir) };
                let (ok, said) = self.run(&at, &c.program, &c.args, STEP_LIMIT);
                self.step(job, &c.label, ok, started);
                if !ok {
                    return Err(format!("{} failed:\n{}", c.label, tail(&said)));
                }
            }
            Ok(())
        })();
        self.drop_worktree(&dir);
        result?;
        job["state"] = json!("passed");
        Ok(())
    }

    /// The board, the dashboard website ("site") or Hive Phone deployed from a commit on main, as the owner
    /// deploys it from here. Hive Phone's release is published; one already of these sources stays.
    fn run_deploy(&self, job: &mut Value, what: &str) -> Result<(), String> {
        let commit = job["commit"].as_str().unwrap_or("").to_string();
        self.git(&["fetch", "--quiet", "origin", "main"])?;
        if self.git(&["merge-base", "--is-ancestor", &commit, "refs/remotes/origin/main"]).is_err() {
            return Err(format!("{commit} isn't on main"));
        }
        let dir = self.worktree(job["id"].as_str().unwrap_or(what), &commit)?;
        let started = Instant::now();
        let args = [self.repo.join("cloud/release.mjs").display().to_string(), what.into(), "--from".into(), dir.display().to_string()];
        let (ok, said) = self.run(&dir, "node", &args, STEP_LIMIT);
        self.drop_worktree(&dir);
        let name = match what {
            "site" => "the dashboard website",
            "phone" => "Hive Phone",
            _ => "the board",
        };
        self.step(job, &format!("Deploying {name}"), ok, started);
        if !ok {
            return Err(format!("{name} didn't deploy:\n{}", tail(&said)));
        }
        let version = said
            .lines()
            .find_map(|l| deployed_version(l, what))
            .ok_or_else(|| format!("the deploy didn't say it deployed:\n{}", tail(&said)))?;
        job["state"] = json!("deployed");
        job["version"] = json!(version);
        Ok(())
    }

    fn run_install(&self, job: &mut Value) -> Result<(), String> {
        let commit = job["commit"].as_str().unwrap_or("").to_string();
        self.git(&["fetch", "--quiet", "origin", "main"])?;
        if self.git(&["merge-base", "--is-ancestor", &commit, "refs/remotes/origin/main"]).is_err() {
            return Err(format!("{commit} isn't on main"));
        }
        let dir = self.worktree(job["id"].as_str().unwrap_or("install"), &commit)?;
        let started = Instant::now();
        let mut args = vec![self.repo.join("cloud/release.mjs").display().to_string(), "mac".into(), "--from".into(), dir.display().to_string()];
        let notes = job["notes"].as_str().unwrap_or("").to_string();
        if !notes.is_empty() {
            args.extend(["--notes".to_string(), notes]);
        }
        let (ok, said) = self.run(&dir, "node", &args, STEP_LIMIT);
        self.drop_worktree(&dir);
        self.step(job, "Building and publishing the Mac release", ok, started);
        if !ok {
            return Err(format!("the Mac release didn't build:\n{}", tail(&said)));
        }
        let version = said
            .lines()
            .find_map(|l| l.trim().strip_prefix("published mac ").map(|r| r.split([';', ' ']).next().unwrap_or("").to_string()))
            .filter(|v| !v.is_empty())
            .ok_or_else(|| format!("the release didn't say it published:\n{}", tail(&said)))?;
        job["version"] = json!(version);
        let mut sources = vec!["status", "--porcelain", "--"];
        sources.extend(MAC_SOURCES);
        let changed_here: Vec<String> = self.git(&sources)?.lines().map(|l| l.get(3..).unwrap_or(l).to_string()).filter(|l| !l.is_empty()).collect();
        let here_in_release = self.git(&["merge-base", "--is-ancestor", "HEAD", &commit]).is_ok();
        if let Err(why) = may_put_in_here(hive_tasks::node::VERSION, &changed_here, here_in_release) {
            job["state"] = json!("published");
            job["here"] = json!(why);
            return Ok(());
        }
        let Some(cloud) = hive_tasks::Cloud::load() else {
            job["state"] = json!("published");
            job["here"] = json!("this Mac has no board config to fetch the release from");
            return Ok(());
        };
        job["state"] = json!("waiting");
        self.write(job);
        let idle = self.idle.clone();
        match hive_tasks::update::put_in_when_idle(&self.repo, &cloud, &move || idle(), IDLE_LIMIT) {
            Ok(hive_tasks::update::Outcome::PutIn { to, .. }) => {
                job["state"] = json!("installed");
                job["version"] = json!(to);
            }
            Ok(hive_tasks::update::Outcome::Waiting(_)) => {
                job["state"] = json!("published");
                job["here"] = json!("Hive wasn't idle for six hours; this Mac puts the release in at its next start");
            }
            Ok(hive_tasks::update::Outcome::Current) => {
                job["state"] = json!("installed");
                job["here"] = json!("this Mac already runs it");
            }
            Err(why) => return Err(format!("the release didn't go in here: {why}")),
        }
        Ok(())
    }
}

/// The version a deploy's line says went out: "deployed board 9c1b…", "published phone 2026.1120.0815-9c1b…",
/// or, for Hive Phone, the release already of these sources ("phone: 2026… is already these sources").
fn deployed_version(line: &str, what: &str) -> Option<String> {
    let line = line.trim();
    let version = line
        .strip_prefix(&format!("deployed {what} "))
        .or_else(|| line.strip_prefix(&format!("published {what} ")).map(|v| v.split(';').next().unwrap_or("")))
        .or_else(|| line.strip_prefix(&format!("{what}: ")).and_then(|v| v.strip_suffix(" is already these sources; nothing to publish")))?;
    let version = version.trim();
    (!version.is_empty() && !version.contains(' ')).then(|| version.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn files(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn only_the_vms_change_branches_are_checked() {
        assert!(valid_branch("hive/improve-r12-1-1"));
        assert!(!valid_branch("main"));
        assert!(!valid_branch("hive/improve-"));
        assert!(!valid_branch("hive/improve-a;rm -rf"));
        assert!(!valid_branch("hive/improve-a/../../x"));
        assert!(!valid_branch("hive/improve-a..b"));
        assert!(valid_commit("0123456789abcdef0123456789abcdef01234567"));
        assert!(!valid_commit("0123456"));
        assert!(!valid_commit("0123456789abcdef0123456789abcdef0123456g"));
    }

    #[test]
    fn a_changes_files_say_what_runs() {
        let rust = checks(&files(&["desktop/app/crates/hive/hive-mac/src/tools.rs", "desktop/app/crates/hive/hive-app/src/x.rs", "desktop/app/crates/hive/hive-mac/src/y.rs"]));
        let labels: Vec<&str> = rust.iter().map(|c| c.label.as_str()).collect();
        assert_eq!(labels, ["Building Hive's Rust crates", "Testing hive-app", "Testing hive-mac"]);
        assert_eq!(rust[2].args, ["test", "-p", "hive-mac", "--offline", "--quiet"]);
        assert_eq!(rust[0].dir, CRATES);

        let lock = checks(&files(&["desktop/app/crates/hive/Cargo.lock"]));
        assert_eq!(lock.len(), 1, "the workspace's own files: built, no crate's tests");

        let scripts = checks(&files(&["desktop/vm-post.mjs", "dashboard/src/lib/agents.js", "browser/chrome/src/x.js"]));
        let labels: Vec<&str> = scripts.iter().map(|c| c.label.as_str()).collect();
        assert_eq!(labels, ["Testing desktop's scripts", "Testing the dashboard", "Testing the browser extension"]);
        assert!(checks(&files(&["cloud/tasks/worker.js", "README.md"])).is_empty(), "the VM tests the cloud's parts");
    }

    #[test]
    fn the_owners_own_build_takes_a_release_only_when_it_has_nothing_the_release_lacks() {
        assert!(may_put_in_here("abc123def456", &files(&["desktop/app/crates/hive/x.rs"]), false).is_ok(), "a release build always does");
        assert!(may_put_in_here("dev", &[], true).is_ok());
        let why = may_put_in_here("dev", &files(&["a.rs", "b.rs", "c.rs", "d.rs"]), true).unwrap_err();
        assert!(why.contains("a.rs, b.rs, c.rs, …"), "{why}");
        assert!(may_put_in_here("dev", &[], false).unwrap_err().contains("doesn't have"));
    }

    #[test]
    fn what_a_failure_said_is_its_end() {
        let said: String = (0..200).map(|i| format!("line {i}\n")).collect();
        let t = tail(&said);
        assert!(t.starts_with("line 120") && t.ends_with("line 199"), "{t}");
        assert!(tail(&"é".repeat(5000)).chars().all(|c| c == 'é'));
    }

    #[test]
    fn the_owners_tools_are_found_without_a_shell() {
        let home = tempfile::tempdir().unwrap();
        for v in ["v22.11.0", "v24.2.1", "v9.0.0"] {
            std::fs::create_dir_all(home.path().join(".nvm/versions/node").join(v).join("bin")).unwrap();
        }
        let path = search_path(home.path());
        assert!(path.starts_with(&format!("{}/.nvm/versions/node/v24.2.1/bin:", home.path().display())), "{path}");
        assert!(path.contains("/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"));
    }

    #[test]
    fn a_job_runs_in_the_background_one_at_a_time_and_its_status_reads_from_its_file() {
        let dir = tempfile::tempdir().unwrap();
        // A folder that isn't a repository: the check fails at its first git step, as a job.
        let me = SelfChange::new(dir.path().join("not-a-repo"), dir.path().join("jobs"), Arc::new(|| true), Arc::new(|_| {}));
        std::fs::create_dir_all(dir.path().join("not-a-repo")).unwrap();
        let bad = me.call(&json!({ "action": "check", "branch": "main" }));
        assert_eq!(bad["isError"], json!(true));
        let started = me.call(&json!({ "action": "check", "branch": "hive/improve-r1-1-1" }));
        let text: Value = serde_json::from_str(started["content"][0]["text"].as_str().unwrap()).unwrap();
        let job = text["job"].as_str().unwrap().to_string();
        assert_eq!(text["state"], "running");
        let until = Instant::now() + Duration::from_secs(30);
        let status = loop {
            let s = me.call(&json!({ "action": "status", "job": job }));
            let v: Value = serde_json::from_str(s["content"][0]["text"].as_str().unwrap()).unwrap();
            if v["state"] != "running" || Instant::now() > until {
                break v;
            }
            std::thread::sleep(Duration::from_millis(50));
        };
        assert_eq!(status["state"], "failed");
        assert!(status["failures"].as_str().unwrap().starts_with("git fetch"), "{status}");
        assert_eq!(status["running"], hive_tasks::node::VERSION);
        let none = me.call(&json!({ "action": "status", "job": "../../etc/passwd" }));
        assert_eq!(none["isError"], json!(true));
        for action in ["install", "board", "site", "phone"] {
            let short = me.call(&json!({ "action": action, "commit": "abc123" }));
            assert_eq!(short["isError"], json!(true), "{action} takes a full commit id");
            assert!(short["content"][0]["text"].as_str().unwrap().contains(&format!("{action} takes the full id")));
        }
        let unknown = me.call(&json!({ "action": "shell", "command": "ls" }));
        assert!(unknown["content"][0]["text"].as_str().unwrap().contains("check, install, board, site, phone or status"));
    }

    #[test]
    fn a_deploy_says_what_went_out() {
        assert_eq!(deployed_version("deployed board 9c1b2a3d4e5f", "board").as_deref(), Some("9c1b2a3d4e5f"));
        assert_eq!(deployed_version("deployed site 9c1b2a3d4e5f", "board"), None);
        assert_eq!(
            deployed_version("published phone 2026.1120.815-9c1b2a3d4e5f; SideStore offers it on every member's iPhone", "phone").as_deref(),
            Some("2026.1120.815-9c1b2a3d4e5f")
        );
        assert_eq!(
            deployed_version("phone: 2026.1120.815-9c1b2a3d4e5f is already these sources; nothing to publish", "phone").as_deref(),
            Some("2026.1120.815-9c1b2a3d4e5f")
        );
        assert_eq!(deployed_version("phone 2026.1120.815-9c1b: 30.1 MB IPA from HEAD", "phone"), None);
    }
}
