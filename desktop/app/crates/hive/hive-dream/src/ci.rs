//! The macOS check on GitHub Actions (`.github/workflows/dream.yml`), and the VM's side of it.
//!
//! The dream runs on Hive's cloud VM (Linux), where hive-mac, hive-sidecars and hive-app don't
//! build. So every fix goes to a `dream/<name>` branch, and a macOS runner judges it:
//!
//! - `ci-gate` (no push rights) runs the test commit's tests on the code as it was (the red
//!   check) and, when the branch also has the fix, squashes it onto main and runs the gate there
//!   (the green check). It writes what it found to `--out`.
//! - `ci-publish` (with the workflow's token) pushes the squashed commit to main when both checks
//!   passed and the test failed on an assertion, deletes the branch when it merged or can't, and
//!   publishes `result.json` and the logs as `refs/dream/ci/<name>`.
//!
//! The VM waits for that ref ([`wait`]): after pushing only the test when its crate doesn't build
//! on Linux (step 2 needs to see how it failed), and after pushing the fix.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::fix::red_kind;
use crate::{gate, git, paths};

/// How long the VM waits for the macOS check (it builds the workspace, then runs tests).
pub const WAIT_SECS: u64 = 75 * 60;
const POLL_SECS: u64 = 30;

/// What the macOS check found for one push of a dream branch.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct CiResult {
    /// The branch tip it judged.
    pub head: String,
    /// The test-only commit ("Dream test: …").
    pub test: String,
    /// "red" when the branch had only the test, "green" when it also had the fix.
    pub stage: String,
    /// Whether the test failed on the code as it was, and how ("assertion" or "compile").
    pub red_failed: bool,
    pub red_kind: String,
    pub red_summary: String,
    /// The gate on main + the squashed fix (green stage only).
    pub green: Option<gate::Verdict>,
    /// The squashed commit the merge would push, and whether it reached main.
    pub merge_commit: Option<String>,
    pub merged: bool,
    pub branch_deleted: bool,
    /// Why it didn't merge, in words.
    pub reasons: Vec<String>,
    /// The Actions run, when known.
    pub run_url: String,
}

/// Whether this run sends its fixes to the macOS check: always on Linux (the VM), or when
/// HIVE_DREAM_CI=1. HIVE_DREAM_CI=0 keeps everything local.
pub fn enabled() -> bool {
    match std::env::var("HIVE_DREAM_CI").as_deref() {
        Ok("1") => true,
        Ok("0") => false,
        _ => cfg!(target_os = "linux"),
    }
}

pub fn result_ref(name: &str) -> String {
    format!("refs/dream/ci/{name}")
}

/// The first commit after `base` whose subject starts with "Dream test:".
pub fn find_test_commit(repo: &Path, base: &str, head: &str) -> Result<String, String> {
    let out = git::git(
        repo,
        &["log", "--reverse", "--format=%H %s", &format!("{base}..{head}")],
    )?;
    out.lines()
        .find_map(|l| {
            let (sha, subject) = l.split_once(' ')?;
            subject.starts_with("Dream test:").then(|| sha.to_string())
        })
        .ok_or_else(|| "no \"Dream test:\" commit on the branch".into())
}

/// Pushes `sha` to `dream/<name>` (a fast-forward: the fix goes on top of the test).
pub fn push(repo: &Path, name: &str, sha: &str) -> Result<(), String> {
    git::git(
        repo,
        &["push", "--quiet", "origin", &format!("{sha}:refs/heads/dream/{name}")],
    )
    .map(|_| ())
}

/// Deletes `dream/<name>` on GitHub (a fix the VM rejected after its test went up).
pub fn delete_branch(repo: &Path, name: &str) -> Result<(), String> {
    git::git(
        repo,
        &["push", "--quiet", "origin", "--delete", &format!("refs/heads/dream/{name}")],
    )
    .map(|_| ())
}

/// The published result for `dream/<name>`, if there is one.
pub fn fetch_result(repo: &Path, name: &str) -> Result<Option<(CiResult, String)>, String> {
    let r = result_ref(name);
    let listed = git::git(repo, &["ls-remote", "origin", &r])?;
    if listed.trim().is_empty() {
        return Ok(None);
    }
    git::git(repo, &["fetch", "--quiet", "--no-tags", "origin", &format!("+{r}:{r}")])?;
    let json = git::git(repo, &["show", &format!("{r}:result.json")])?;
    let result: CiResult = serde_json::from_str(&json).map_err(|e| format!("result.json: {e}"))?;
    let log = git::git(repo, &["show", &format!("{r}:red.log")]).unwrap_or_default();
    Ok(Some((result, log)))
}

/// Waits until the macOS check has published a result for `head`. Returns it and its red log.
pub fn wait(repo: &Path, name: &str, head: &str, limit: Duration) -> Result<(CiResult, String), String> {
    let started = Instant::now();
    loop {
        match fetch_result(repo, name) {
            Ok(Some((r, log))) if r.head == head => return Ok((r, log)),
            Ok(_) => {}
            Err(e) => eprintln!("hive-dream: waiting for the macOS check: {e}"),
        }
        if started.elapsed() >= limit {
            return Err(format!(
                "the macOS check had no result for {} after {} minutes",
                &head[..head.len().min(10)],
                limit.as_secs() / 60
            ));
        }
        std::thread::sleep(Duration::from_secs(POLL_SECS));
    }
}

fn tail(text: &str, lines: usize) -> String {
    let all: Vec<&str> = text.lines().collect();
    all[all.len().saturating_sub(lines)..].join("\n")
}

fn branch_name() -> Result<String, String> {
    let full = std::env::var("GITHUB_REF_NAME").map_err(|_| "GITHUB_REF_NAME isn't set")?;
    full.strip_prefix("dream/")
        .filter(|n| !n.is_empty() && n.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c)))
        .map(str::to_string)
        .ok_or_else(|| format!("{full} isn't a dream branch"))
}

fn worktree(repo: &Path, dir: &Path, commit: &str) -> Result<(), String> {
    if dir.exists() {
        let _ = git::git(repo, &["worktree", "remove", "--force", &dir.to_string_lossy()]);
        let _ = std::fs::remove_dir_all(dir);
    }
    git::git(
        repo,
        &["worktree", "add", "--quiet", "--detach", &dir.to_string_lossy(), commit],
    )
    .map(|_| ())
}

fn commit_in(dir: &Path, message: &str, msg_file: &Path) -> Result<String, String> {
    paths::write_atomic(msg_file, message)?;
    git::git(
        dir,
        &[
            "-c", "user.name=hive-dream", "-c", "user.email=hive-dream@localhost",
            "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null",
            "commit", "--quiet", "--no-verify", "-F", &msg_file.to_string_lossy(),
        ],
    )?;
    git::rev(dir, "HEAD")
}

/// `hive-dream ci-gate --out DIR`, run in the checkout of a dream branch on a macOS runner.
/// Never pushes. Writes `result.json`, `red.log`, `tests.log` and the squashed commit's message.
pub fn gate(out: &Path) -> Result<CiResult, String> {
    std::fs::create_dir_all(out).map_err(|e| format!("{}: {e}", out.display()))?;
    let repo = std::env::current_dir().map_err(|e| e.to_string())?;
    let dream = paths::dream_dir();
    let _name = branch_name()?;
    let head = git::rev(&repo, "HEAD")?;
    let main = git::rev(&repo, "origin/main")?;
    let base = git::git(&repo, &["merge-base", "HEAD", "origin/main"])?.trim().to_string();
    let test = find_test_commit(&repo, &base, &head)?;
    let mut r = CiResult {
        head: head.clone(),
        test: test.clone(),
        stage: if head == test { "red" } else { "green" }.into(),
        run_url: match (std::env::var("GITHUB_SERVER_URL"), std::env::var("GITHUB_REPOSITORY"), std::env::var("GITHUB_RUN_ID")) {
            (Ok(s), Ok(repo), Ok(id)) => format!("{s}/{repo}/actions/runs/{id}"),
            _ => String::new(),
        },
        ..Default::default()
    };

    // Red: the test on the code as it was. Only tests may change in that commit.
    let red_dir = dream.join("ci").join("red");
    worktree(&repo, &red_dir, &test)?;
    let changes = git::changes(&red_dir, &base, &test)?;
    let s = gate::check_static(&changes, "Dream test", None);
    let red_log = out.join("red.log");
    if s.test_lines == 0 || s.code_lines > 0 {
        r.reasons.push(format!(
            "the test commit has {} test lines and {} code lines outside tests (it must have only tests)",
            s.test_lines, s.code_lines
        ));
    } else {
        let packages = gate::touched_packages(&red_dir, &s.files);
        let runs = gate::run_tests(&red_dir, &dream, &packages, &red_log);
        match runs.iter().find(|t| !t.ok) {
            Some(failed) => {
                r.red_failed = true;
                r.red_kind = red_kind(&std::fs::read_to_string(&red_log).unwrap_or_default()).into();
                r.red_summary = failed.summary.clone();
                if r.red_kind.is_empty() {
                    r.reasons.push(format!("the test run failed, but not on a test or a build: {}", failed.summary));
                } else if r.red_kind == "compile" {
                    r.reasons.push("the test only failed to compile on the old code, so it doesn't prove the problem: left for a person".into());
                }
            }
            None => r.reasons.push("the test passes on the code as it was, so it doesn't show the problem".into()),
        }
    }
    if !red_log.exists() {
        paths::write_atomic(&red_log, "")?;
    }

    // Green: the whole branch squashed onto main as it is now, then the gate.
    if r.stage == "green" && r.red_failed && !r.red_kind.is_empty() {
        let message = git::git(&repo, &["log", "-1", "--format=%B", &head])?;
        let green_dir = dream.join("ci").join("green");
        worktree(&repo, &green_dir, &main)?;
        match git::git(&green_dir, &["merge", "--squash", "--quiet", &head]) {
            Err(e) => r.reasons.push(format!("doesn't apply to main as it is now: {}", e.lines().next().unwrap_or(""))),
            Ok(_) => {
                let squashed = commit_in(&green_dir, &message, &out.join("commit-message.txt"))?;
                let verdict = gate::judge(&green_dir, &dream, &main, &squashed, &message, None, &out.join("tests.log"))?;
                if verdict.passed {
                    r.merge_commit = Some(squashed);
                } else {
                    r.reasons.extend(verdict.reasons.iter().map(|x| format!("gate: {x}")));
                }
                r.green = Some(verdict);
            }
        }
        if r.red_kind != "assertion" {
            r.merge_commit = None;
        }
    }
    // Only the end of each log goes into the published result.
    for f in ["red.log", "tests.log"] {
        let path = out.join(f);
        if let Ok(text) = std::fs::read_to_string(&path) {
            paths::write_atomic(&path, &tail(&text, 400))?;
        }
    }
    save(out, &r)?;
    Ok(r)
}

fn save(out: &Path, r: &CiResult) -> Result<(), String> {
    paths::write_atomic(
        &out.join("result.json"),
        &serde_json::to_string_pretty(r).map_err(|e| e.to_string())?,
    )
}

/// `hive-dream ci-publish --out DIR`: what `ci-gate` decided, pushed with the workflow's token
/// (HIVE_DREAM_PUSH_URL, the repo's https URL with the token in it; never printed).
pub fn publish(out: &Path) -> Result<CiResult, String> {
    let repo = std::env::current_dir().map_err(|e| e.to_string())?;
    let url = std::env::var("HIVE_DREAM_PUSH_URL").map_err(|_| "HIVE_DREAM_PUSH_URL isn't set")?;
    let name = branch_name()?;
    let text = std::fs::read_to_string(out.join("result.json"))
        .map_err(|e| format!("no result.json from ci-gate: {e}"))?;
    let mut r: CiResult = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let push = |args: &[&str]| -> Result<(), String> {
        let mut all = vec!["push", "--quiet", url.as_str()];
        all.extend_from_slice(args);
        // git's own error names the URL; keep the token out of anything printed.
        git::git(&repo, &all).map(|_| ()).map_err(|e| e.replace(url.as_str(), "<origin>"))
    };
    if let Some(sha) = r.merge_commit.clone() {
        match push(&[&format!("{sha}:refs/heads/main")]) {
            Ok(()) => r.merged = true,
            Err(e) => r.reasons.push(format!("pushing to main failed (it moved?): {e}")),
        }
    }
    // A branch that merged, or that can't (its test doesn't fail, or the fix failed the gate),
    // goes; one that only waits for its fix (red stage, test failed) or for a person stays.
    let stays = (r.stage == "red" && r.red_failed && !r.red_kind.is_empty())
        || (!r.merged && r.red_kind == "compile" && r.green.as_ref().is_some_and(|g| g.passed));
    if !stays {
        match push(&["--delete", &format!("refs/heads/dream/{name}")]) {
            Ok(()) => r.branch_deleted = true,
            Err(e) => r.reasons.push(format!("deleting the branch failed: {e}")),
        }
    }
    save(out, &r)?;
    let files: Vec<(&str, PathBuf)> = ["result.json", "red.log", "tests.log", "commit-message.txt"]
        .into_iter()
        .map(|f| (f, out.join(f)))
        .filter(|(_, p)| p.is_file())
        .collect();
    let commit = snapshot(&repo, &files, &format!("Dream check for dream/{name} at {}", &r.head[..r.head.len().min(10)]))?;
    push(&["--force", &format!("{commit}:{}", result_ref(&name))])?;
    Ok(r)
}

/// A parentless commit holding just `files` (git plumbing, with a private index).
fn snapshot(repo: &Path, files: &[(&str, PathBuf)], message: &str) -> Result<String, String> {
    let index = std::env::temp_dir().join(format!("hive-dream-index-{}", std::process::id()));
    let _ = std::fs::remove_file(&index);
    let run = |args: &[&str]| -> Result<String, String> {
        let o = Command::new("git")
            .arg("-C")
            .arg(repo)
            .args(args)
            .env("GIT_INDEX_FILE", &index)
            .env("GIT_AUTHOR_NAME", "hive-dream")
            .env("GIT_AUTHOR_EMAIL", "hive-dream@localhost")
            .env("GIT_COMMITTER_NAME", "hive-dream")
            .env("GIT_COMMITTER_EMAIL", "hive-dream@localhost")
            .output()
            .map_err(|e| e.to_string())?;
        if o.status.success() {
            Ok(String::from_utf8_lossy(&o.stdout).trim().to_string())
        } else {
            Err(format!("git {}: {}", args.join(" "), String::from_utf8_lossy(&o.stderr).trim()))
        }
    };
    for (name, path) in files {
        let blob = run(&["hash-object", "-w", &path.to_string_lossy()])?;
        run(&["update-index", "--add", "--cacheinfo", &format!("100644,{blob},{name}")])?;
    }
    let tree = run(&["write-tree"])?;
    let commit = run(&["commit-tree", &tree, "-m", message])?;
    let _ = std::fs::remove_file(&index);
    Ok(commit)
}
