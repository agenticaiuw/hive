//! `hive-dream fix`: for the open clusters that lost the most time, a git worktree of the repo on
//! a local `dream/<date>-<slug>` branch from origin/main, Codex (the user's ChatGPT account, never
//! Claude) asked for a failing test and then a code fix, a commit in that worktree, and the gate.
//! Nothing is merged, pushed or restarted; the shared working tree is never touched.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::evidence::{category, Cluster};
use crate::gate::{self, Verdict};
use crate::normalize::{cut, redact};
use crate::register::{Register, Status};
use crate::{collect, git, paths, proc, time};

pub const CODEX_TIMEOUT_SECS: u64 = 60 * 60;
/// `fix` won't start with less free disk than this (a worktree and a target folder).
pub const MIN_FREE_BYTES: u64 = 3 * 1024 * 1024 * 1024;
/// A cluster qualifies when seen this often and losing this many minutes.
pub const MIN_COUNT: u64 = 2;
pub const MIN_MINUTES: f64 = 1.0;
/// After this many attempts a cluster is left for a person.
pub const MAX_ATTEMPTS: u32 = 3;

pub struct Options {
    pub max: usize,
    pub cluster: Option<String>,
    pub dry_run: bool,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct FixResult {
    pub signature: String,
    pub slug: String,
    /// The attempt's folder under `<night>/fixes/` (the slug, plus `-2` for a second attempt).
    #[serde(default)]
    pub run: String,
    pub category: String,
    pub count: u64,
    pub minutes: f64,
    pub first_seen: String,
    pub last_seen: String,
    pub refs: Vec<String>,
    /// proposed, rejected, error, or dry-run.
    pub outcome: String,
    pub error: Option<String>,
    pub branch: Option<String>,
    pub worktree: Option<String>,
    pub base: Option<String>,
    pub commit: Option<String>,
    pub diffstat: String,
    pub verdict: Option<Verdict>,
    pub codex_exit: Option<i32>,
    pub codex_timed_out: bool,
    pub codex_seconds: f64,
    /// Codex's last message, shortened and with private terms taken out.
    pub codex_said: String,
    pub land: Option<String>,
    pub started: String,
    pub finished: String,
}

/// The clusters `fix` would take, best first.
pub fn candidates<'a>(
    clusters: &'a [Cluster],
    register: &Register,
    only: Option<&str>,
) -> Vec<&'a Cluster> {
    clusters
        .iter()
        .filter(|c| c.fixable)
        .filter(|c| match only {
            Some(key) => {
                (c.slug == key || c.signature == key)
                    && matches!(
                        register.status(&c.signature),
                        Status::Open | Status::Rejected
                    )
            }
            None => {
                register.status(&c.signature) == Status::Open
                    && c.count >= MIN_COUNT
                    && c.minutes >= MIN_MINUTES
                    && register
                        .entries
                        .get(&c.signature)
                        .is_none_or(|e| e.attempts < MAX_ATTEMPTS)
            }
        })
        .collect()
}

/// Where the code for each kind of failure lives (repo paths), for the prompt.
fn category_hints(category: &str) -> &'static [&'static str] {
    match category {
        "wait_for_control" | "takeover" => &[
            "desktop/app/crates/hive/hive-mac/src/tools.rs (wait_for_control, take/hand back the screen)",
            "desktop/app/crates/hive/hive-mac/src/vhid.rs (the virtual mouse and keyboard)",
        ],
        "phone" => &[
            "desktop/app/crates/agent-core/src/phone_transport.rs",
            "desktop/app/crates/hive/hive-phone/src/phone.rs",
            "desktop/app/crates/hive/hive-phone/src/tools.rs",
        ],
        "self_stop_x" => &[
            "desktop/app/crates/hive/hive-mac/src/tools.rs (clicks; Hive's own windows)",
            "desktop/app/crates/hive/hive-sidecars/src/captions.rs (the floating window)",
        ],
        "provider" | "unfinished" => &[
            "desktop/app/crates/hive/hive-codex/src/agent.rs",
            "desktop/app/crates/hive/hive-codex/src/task.rs",
        ],
        _ => &[],
    }
}

/// Files that contain the longest literal piece of the signature or an example.
fn code_hints(worktree: &Path, c: &Cluster) -> Vec<String> {
    let mut pieces: Vec<String> = Vec::new();
    let text = c
        .signature
        .split_once(": ")
        .map_or(c.signature.as_str(), |x| x.1);
    for source in std::iter::once(text).chain(c.examples.iter().map(String::as_str)) {
        for piece in source.split(['<', '>', '"', '\'', '`', '|']) {
            let piece = piece.trim().trim_end_matches(['.', ':', ',', ';']);
            if piece.chars().count() >= 14 && piece.chars().count() <= 80 {
                pieces.push(piece.to_string());
            }
        }
    }
    pieces.sort_by_key(|p| std::cmp::Reverse(p.len()));
    let mut files: Vec<String> = Vec::new();
    for piece in pieces.iter().take(6) {
        if let Ok(out) = git::git(
            worktree,
            &["grep", "-F", "-l", "-e", piece, "--", "desktop/app/crates"],
        ) {
            for f in out.lines().take(4) {
                if !files.iter().any(|x| x == f) {
                    files.push(f.to_string());
                }
            }
        }
        if files.len() >= 6 {
            break;
        }
    }
    files
}

pub fn prompt(c: &Cluster, worktree: &Path, terms: &[String]) -> String {
    let title = category(&c.category).map_or(c.category.as_str(), |k| k.title);
    let mut p = String::new();
    p.push_str("You are fixing one recurring failure in Hive, a macOS desktop agent (Rust workspace at desktop/app/crates/hive, plus desktop/app/crates/agent-core). Hive's nightly review found it in its own logs. Work only in this git worktree.\n\n");
    p.push_str("## The failure\n\n");
    p.push_str(&format!("- Signature: {}\n", redact(&c.signature, terms)));
    p.push_str(&format!("- What it is: {title}\n"));
    p.push_str(&format!(
        "- Seen {} times between {} and {}, about {:.0} minutes lost.\n",
        c.count, c.first_seen, c.last_seen, c.minutes
    ));
    if !c.examples.is_empty() {
        p.push_str("- What Hive logged (shortened):\n");
        for e in &c.examples {
            p.push_str(&format!("  - {}\n", redact(e, terms)));
        }
    }
    let hints: Vec<String> = category_hints(&c.category)
        .iter()
        .map(|s| s.to_string())
        .chain(code_hints(worktree, c))
        .collect();
    if !hints.is_empty() {
        p.push_str("\n## Where to look first\n\n");
        for h in hints {
            p.push_str(&format!("- {h}\n"));
        }
    }
    p.push_str(
        "\n## What to do\n\n\
1. Find the code path that produces this failure. Read the code; the lines above are what it printed.\n\
2. First write a test that fails because of the problem and reproduces it deterministically: a unit test in the crate's `#[cfg(test)] mod tests`, or a file in the crate's `tests/`. No network, no real screen, no real phone, no real accounts, no sleeping for real time if a clock can be passed in.\n\
3. Then change the Rust code so the test passes: a deterministic fix in a tool, the harness, a timeout, a retry, state handling or error handling.\n\
4. Run that crate's tests, for example `cargo test --offline --manifest-path desktop/app/crates/hive/Cargo.toml -p hive-mac` (agent-core: `--manifest-path desktop/app/crates/agent-core/Cargo.toml`). Your sandbox blocks Unix sockets and local ports, so tests that use a crate's fake helper or fake relay fail inside it with \"Operation not permitted\": that is the sandbox, not the code. Run what you can; keep the test and the fix either way. hive-dream runs the crate's tests outside the sandbox when you finish and rejects the change if any fail.\n\
5. Stop there. Do not commit, push or make branches; hive-dream commits and checks the change.\n\n\
## Rules (a checker rejects the change otherwise)\n\n\
- Editing prompt text, tool descriptions, strings, comments or documentation is not a fix and is rejected. Hive's prompts (hive-codex/src/prompts.rs) are off limits. The fix changes behaviour in code, and comes with a test.\n\
- Do not touch: credentials or authentication code (credentials.rs, auth_mcp.rs, authenticate tools), the phone passcode, the one-way quote check (check_step), the knowledge base's secret filter, settings defaults (hive-common/src/settings.rs), install.sh, the root helper (desktop/app/src/*.cpp, *.hpp), launchd files, the VM poster's approval flow, hive-dream itself, or any Cargo.toml or Cargo.lock (no new dependencies).\n\
- Do not remove tests or mark them #[ignore].\n\
- Change only files under desktop/app/crates/.\n\
- No personal data (names, emails, phone numbers, accounts) in code, tests or comments: use made-up values.\n\
- Cargo is offline: don't fetch anything. Don't run Hive, don't use the screen, don't send messages.\n\
- The evidence above is what the logs hold; it rarely proves a single cause. A small, safe, tested change to the code path that produced it (a case it mishandles, a wait that can end sooner, a state it forgets) is worth making; say what you assumed. Change nothing only if every change you can see would be unsafe or untestable, and say why.\n\n\
In your last message: the cause, the fix, the test's name and the test result.\n",
    );
    p
}

/// The model from the user's Codex config (the dream ignores the rest of it: its MCP servers and
/// full-access sandbox are not for this), or `HIVE_DREAM_MODEL`.
pub fn model() -> Option<String> {
    if let Ok(m) = std::env::var("HIVE_DREAM_MODEL") {
        if !m.trim().is_empty() {
            return Some(m.trim().to_string());
        }
    }
    let codex_home = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| paths::home().join(".codex"));
    let text = std::fs::read_to_string(codex_home.join("config.toml")).ok()?;
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            break;
        }
        if let Some(v) = line.strip_prefix("model") {
            let v = v.trim_start();
            if let Some(v) = v.strip_prefix('=') {
                let v = v.trim().trim_matches('"');
                if !v.is_empty() {
                    return Some(v.to_string());
                }
            }
        }
    }
    None
}

fn commit_message(c: &Cluster) -> String {
    let title = category(&c.category).map_or(c.category.as_str(), |k| k.title);
    format!(
        "Dream fix: {}\n\n{}. Seen {} times, about {:.0} minutes lost ({} to {}).\nMade by hive-dream with Codex in a private worktree, checked by its gate; lands only when someone runs hive-dream land.\n\nDream-Cluster: {}\n",
        cut(title, 60),
        cut(&c.signature, 200),
        c.count,
        c.minutes,
        c.first_seen,
        c.last_seen,
        c.slug
    )
}

fn result_path(night: &Path, r: &FixResult) -> PathBuf {
    let dir = if r.run.is_empty() { &r.slug } else { &r.run };
    night.join("fixes").join(dir).join("result.json")
}

/// Every fix result written for one night.
pub fn results(night: &Path) -> Vec<FixResult> {
    let mut out: Vec<FixResult> = std::fs::read_dir(night.join("fixes"))
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .filter_map(|e| std::fs::read_to_string(e.path().join("result.json")).ok())
        .filter_map(|t| serde_json::from_str(&t).ok())
        .collect();
    out.sort_by(|a, b| a.started.cmp(&b.started));
    out
}

fn save_result(night: &Path, r: &FixResult) -> Result<(), String> {
    let text = serde_json::to_string_pretty(r).map_err(|e| e.to_string())?;
    paths::write_atomic(&result_path(night, r), &text)
}

/// Picks up to `max` clusters from the newest evidence and tries each.
pub fn run(opts: &Options) -> Result<Vec<FixResult>, String> {
    let dream = paths::dream_dir();
    let (date, evidence) =
        collect::latest_evidence(&dream).ok_or("no evidence yet: run hive-dream collect first")?;
    let register_path = paths::register(&dream);
    let register = Register::load(&register_path)?;
    let picked: Vec<Cluster> = candidates(&evidence.clusters, &register, opts.cluster.as_deref())
        .into_iter()
        .take(opts.max)
        .cloned()
        .collect();
    if picked.is_empty() {
        eprintln!("hive-dream fix: no open cluster qualifies (fixable, seen {MIN_COUNT}+ times, {MIN_MINUTES}+ minutes, under {MAX_ATTEMPTS} attempts)");
        return Ok(Vec::new());
    }
    let night = paths::night(&dream, &date);
    let mut out = Vec::new();
    for c in picked {
        let r = if opts.dry_run {
            let r = FixResult {
                outcome: "dry-run".into(),
                ..base_result(&c)
            };
            println!(
                "would fix: {} ({} times, {:.1} minutes)",
                c.signature, c.count, c.minutes
            );
            r
        } else {
            let r = attempt(&dream, &night, &date, &c);
            let mut register = Register::load(&register_path)?;
            record(&mut register, &r);
            register.save(&register_path)?;
            save_result(&night, &r)?;
            r
        };
        out.push(r);
    }
    Ok(out)
}

fn base_result(c: &Cluster) -> FixResult {
    FixResult {
        signature: c.signature.clone(),
        slug: c.slug.clone(),
        category: c.category.clone(),
        count: c.count,
        minutes: c.minutes,
        first_seen: c.first_seen.clone(),
        last_seen: c.last_seen.clone(),
        refs: c.refs.clone(),
        started: time::iso(time::now()),
        ..Default::default()
    }
}

/// The register after an attempt: proposed or rejected (branch kept); an error leaves it open.
pub fn record(register: &mut Register, r: &FixResult) {
    let now = time::now();
    let Some(entry) = register.entries.get_mut(&r.signature) else {
        return;
    };
    entry.attempts += 1;
    entry.last_attempt = Some(now);
    if r.branch.is_some() {
        entry.branch = r.branch.clone();
        entry.worktree = r.worktree.clone();
    }
    let (status, note) = match r.outcome.as_str() {
        "proposed" => (Status::Proposed, "the gate passed".to_string()),
        "rejected" => (
            Status::Rejected,
            r.verdict.as_ref().map_or_else(
                || r.error.clone().unwrap_or_default(),
                |v| v.reasons.join("; "),
            ),
        ),
        _ => {
            entry.reason = r.error.clone();
            return;
        }
    };
    entry.reason = Some(note.clone());
    let _ = register.set(&r.signature, status, &note, now);
}

fn attempt(dream: &Path, night: &Path, date: &str, c: &Cluster) -> FixResult {
    let mut r = base_result(c);
    match try_attempt(dream, night, date, c, &mut r) {
        Ok(()) => {}
        Err(e) => {
            r.outcome = "error".into();
            r.error = Some(e);
        }
    }
    r.finished = time::iso(time::now());
    r
}

fn try_attempt(
    dream: &Path,
    night: &Path,
    date: &str,
    c: &Cluster,
    r: &mut FixResult,
) -> Result<(), String> {
    let repo = paths::repo();
    let codex = paths::codex();
    if !codex.is_file() {
        return Err(format!("no Codex CLI at {}", codex.display()));
    }
    if let Some(free) = paths::free_bytes(dream) {
        if free < MIN_FREE_BYTES {
            return Err(format!(
                "only {:.1} GB free; fix needs {} GB",
                free as f64 / 1e9,
                MIN_FREE_BYTES / (1024 * 1024 * 1024)
            ));
        }
    }
    // A fresh base: origin/main as it is now (fetching changes no working tree).
    if let Err(e) = git::git(&repo, &["fetch", "--quiet", "origin", "main"]) {
        eprintln!("hive-dream fix: fetch failed, using the last known origin/main: {e}");
    }
    let base = git::rev(&repo, "origin/main")?;
    let mut name = format!("{date}-{}", c.slug);
    let mut n = 2;
    while git::branch_exists(&repo, &format!("dream/{name}"))
        || dream.join("worktrees").join(&name).exists()
    {
        name = format!("{date}-{}-{n}", c.slug);
        n += 1;
    }
    let branch = format!("dream/{name}");
    // One folder per attempt (a second attempt the same night gets its own).
    r.run = name.trim_start_matches(&format!("{date}-")).to_string();
    let run_dir = night.join("fixes").join(&r.run);
    std::fs::create_dir_all(&run_dir).map_err(|e| format!("{}: {e}", run_dir.display()))?;
    let worktree = dream.join("worktrees").join(&name);
    let wt = worktree.to_string_lossy().into_owned();
    git::git(
        &repo,
        &["worktree", "add", "--quiet", "-b", &branch, &wt, &base],
    )?;
    r.branch = Some(branch.clone());
    r.worktree = Some(wt.clone());
    r.base = Some(base.clone());

    // Codex, in the worktree, with the workspace-write sandbox.
    let terms = paths::load_private_terms(dream).unwrap_or_default();
    let text = prompt(c, &worktree, &terms);
    paths::write_atomic(&run_dir.join("prompt.md"), &text)?;
    let env = gate::test_env(dream, "codex");
    let state = env
        .iter()
        .find(|(k, _)| k == "AGENT_STATE_DIR")
        .map(|(_, v)| v.clone())
        .unwrap_or_default();
    let cargo_home = env
        .iter()
        .find(|(k, _)| k == "CARGO_HOME")
        .map(|(_, v)| v.clone())
        .unwrap_or_default();
    // Codex keeps the real HOME (its sign-in); everything else as the tests have it.
    let codex_env: Vec<(String, String)> = env.into_iter().filter(|(k, _)| k != "HOME").collect();
    let last = run_dir.join("last-message.txt");
    let mut argv: Vec<String> = vec![
        codex.to_string_lossy().into_owned(),
        "exec".into(),
        "--ignore-user-config".into(),
        "--ignore-rules".into(),
        "-s".into(),
        "workspace-write".into(),
        "-C".into(),
        wt.clone(),
        "--add-dir".into(),
        dream.join("target").to_string_lossy().into_owned(),
        "--add-dir".into(),
        cargo_home,
        "--add-dir".into(),
        state,
    ];
    if let Some(m) = model() {
        argv.push("-m".into());
        argv.push(m);
    }
    argv.extend([
        "-c".into(),
        "model_reasoning_effort=\"high\"".into(),
        "--json".into(),
        "-o".into(),
        last.to_string_lossy().into_owned(),
        "--color".into(),
        "never".into(),
        "-".into(),
    ]);
    let started = std::time::Instant::now();
    let ran = proc::run(
        &argv,
        &worktree,
        &codex_env,
        Some(&text),
        &run_dir.join("codex.jsonl"),
        Duration::from_secs(CODEX_TIMEOUT_SECS),
    )?;
    r.codex_seconds = (started.elapsed().as_secs_f64() * 10.0).round() / 10.0;
    r.codex_exit = ran.code;
    r.codex_timed_out = ran.timed_out;
    r.codex_said = cut(
        &redact(&std::fs::read_to_string(&last).unwrap_or_default(), &terms),
        2000,
    );

    // Commit whatever Codex changed, by name, in the private worktree.
    let files = git::dirty(&worktree)?;
    if files.is_empty() {
        r.outcome = "rejected".into();
        r.verdict = Some(Verdict {
            passed: false,
            reasons: vec![if ran.ok {
                "Codex changed nothing".into()
            } else {
                format!(
                    "Codex changed nothing (exit {:?}{})",
                    ran.code,
                    if ran.timed_out { ", timed out" } else { "" }
                )
            }],
            warnings: Vec::new(),
            files: Vec::new(),
            test_lines: 0,
            code_lines: 0,
            packages: Vec::new(),
            tests: Vec::new(),
        });
        return Ok(());
    }
    let mut add: Vec<&str> = vec!["add", "--"];
    add.extend(files.iter().map(String::as_str));
    git::git(&worktree, &add)?;
    let message = commit_message(c);
    let msg_file = run_dir.join("commit-message.txt");
    paths::write_atomic(&msg_file, &message)?;
    git::git(
        &worktree,
        &[
            "-c",
            "user.name=hive-dream",
            "-c",
            "user.email=hive-dream@localhost",
            "-c",
            "commit.gpgsign=false",
            "-c",
            "core.hooksPath=/dev/null",
            "commit",
            "--quiet",
            "--no-verify",
            "-F",
            &msg_file.to_string_lossy(),
        ],
    )?;
    let head = git::rev(&worktree, "HEAD")?;
    r.commit = Some(head.clone());
    r.diffstat = git::git(&worktree, &["diff", "--stat", &base, &head])
        .unwrap_or_default()
        .trim_end()
        .to_string();

    // The gate.
    let private = paths::load_private_terms(dream);
    let verdict = gate::judge(
        &worktree,
        dream,
        &base,
        &head,
        &message,
        private.as_deref(),
        &run_dir.join("tests.log"),
    )?;
    paths::write_atomic(
        &run_dir.join("gate.json"),
        &serde_json::to_string_pretty(&verdict).map_err(|e| e.to_string())?,
    )?;
    r.outcome = if verdict.passed {
        "proposed"
    } else {
        "rejected"
    }
    .into();
    if verdict.passed {
        r.land = Some(format!("hive-dream land {branch}"));
    }
    r.verdict = Some(verdict);
    Ok(())
}
