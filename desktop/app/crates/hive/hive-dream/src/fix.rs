//! `hive-dream fix`: for the open clusters that lost the most time, a git worktree of the repo on
//! a local `dream/<date>-<slug>` branch from origin/main, and two steps by Hive's own agent (a
//! request through its socket, as `hive-ask` sends; HIVE_DREAM_AGENT=codex asks the Codex CLI
//! instead; never Claude): step 1 a test, committed and run on the code as it is, which must
//! fail; step 2 the fix. Then the gate on both, and one squashed commit on the branch. Landing is
//! `land` (by hand) or the nightly run (`deploy`); the shared working tree is never touched here.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::evidence::{category, Cluster};
use crate::gate::{self, Verdict};
use crate::normalize::{cut, redact};
use crate::register::{Register, Status};
use crate::{collect, git, paths, proc, time};

pub const CODEX_TIMEOUT_SECS: u64 = 60 * 60;
/// How long each of the two requests to Hive may take.
pub const HIVE_WAIT_MINUTES: u64 = 90;
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
    /// Who wrote the test and the fix: "hive" (Hive's own agent, through its request socket) or
    /// "codex" (the Codex CLI, HIVE_DREAM_AGENT=codex).
    #[serde(default)]
    pub agent: String,
    /// How step 1's test failed on the code as it was: "assertion" (it ran and failed) or
    /// "compile" (it needs code that isn't there yet). Only an assertion lands by itself.
    #[serde(default)]
    pub red: String,
    /// The test-only commit (step 1), before the two were squashed into one.
    #[serde(default)]
    pub test_commit: Option<String>,
    /// What the nightly run did with a proposed fix: landed, built, pushed, restarted, or why not.
    #[serde(default)]
    pub deployed: Option<String>,
    /// Anything worth a look: files changed in ~/hive itself while the agent worked, and so on.
    #[serde(default)]
    pub notes: Vec<String>,
}

/// Who writes the test and the fix: Hive's own agent unless HIVE_DREAM_AGENT=codex.
pub fn agent() -> &'static str {
    match std::env::var("HIVE_DREAM_AGENT").as_deref() {
        Ok("codex") => "codex",
        _ => "hive",
    }
}

/// What hive-ask's exit status means for the step: Ok(true) the agent finished, Ok(false) it
/// ended without finishing (its changes still go to the gate), Err why nothing can be used.
pub fn hive_ask_outcome(code: Option<i32>, timed_out: bool) -> Result<bool, String> {
    if timed_out {
        return Err(format!(
            "Hive was still working after {} minutes; nothing was committed",
            HIVE_WAIT_MINUTES
        ));
    }
    match code {
        Some(0) => Ok(true),
        Some(1) | Some(3) => Ok(false),
        Some(2) => Err("the request was stopped (x)".into()),
        Some(4) => Err(format!(
            "Hive was still working after {HIVE_WAIT_MINUTES} minutes; nothing was committed"
        )),
        Some(5) => Err("Hive didn't take the request (is it running?)".into()),
        other => Err(format!("hive-ask exited with {other:?}")),
    }
}

/// How a test run that failed on the old code failed: "assertion" when a test ran and failed,
/// "compile" when it didn't build, "" when it isn't clear.
pub fn red_kind(output: &str) -> &'static str {
    if output.contains("test result: FAILED") || output.contains("panicked at") {
        "assertion"
    } else if output.contains("could not compile") || output.contains("error[E") {
        "compile"
    } else {
        ""
    }
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

/// Where to work, how to build, and what not to do, for whichever agent writes the change.
pub struct Setup<'a> {
    pub agent: &'a str,
    pub worktree: &'a Path,
    pub branch: &'a str,
    pub dream: &'a Path,
}

fn quote(path: &Path) -> String {
    format!("'{}'", path.to_string_lossy().replace('\'', "'\\''"))
}

/// The failure and where its code is: the same for both steps.
fn failure(c: &Cluster, worktree: &Path, terms: &[String]) -> String {
    let title = category(&c.category).map_or(c.category.as_str(), |k| k.title);
    let mut p = String::from("## The failure\n\n");
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
    if !c.refs.is_empty() {
        p.push_str(
            "- Where it was seen (journals, recordings, Agent.log), to read more if you need to:\n",
        );
        for r in c.refs.iter().take(6) {
            p.push_str(&format!("  - {}\n", redact(r, terms)));
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
    p
}

fn intro(s: &Setup, step: &str) -> String {
    let wt = quote(s.worktree);
    let env = crate::gate::test_env(s.dream, s.agent)
        .into_iter()
        .filter(|(k, _)| k != "HOME" && k != "PATH")
        .map(|(k, v)| format!("{k}={}", quote(Path::new(&v))))
        .collect::<Vec<_>>()
        .join(" ");
    let mut p = String::new();
    if s.agent == "hive" {
        p.push_str("This is your nightly dream, from hive-dream (Hive's self-review), not a request the user typed: they are probably asleep. Your own logs show a failure that keeps coming back; you fix it in your own code, test first. ");
        p.push_str("Do all of it in the shell: no screen, no phone, no messages, no speaking, nothing that needs the user.\n\n");
    } else {
        p.push_str("You are fixing one recurring failure in Hive, a macOS desktop agent. Hive's nightly review found it in its own logs.\n\n");
    }
    p.push_str(&format!("{step}\n\n"));
    p.push_str(&format!(
        "Work only in the git worktree {wt} (branch {}): a copy of the Hive repo (Rust workspace at desktop/app/crates/hive, plus desktop/app/crates/agent-core). `cd {wt}` first. Never edit ~/hive itself.\n\n",
        s.branch
    ));
    p.push_str(&format!(
        "Build and test with these set (a build folder hive-dream keeps; offline):\n\n    cd {wt} && export {env}\n    cargo test --offline --manifest-path desktop/app/crates/hive/Cargo.toml -p <crate> <test name>\n\n(agent-core: `--manifest-path desktop/app/crates/agent-core/Cargo.toml`.) Your sandbox blocks Unix sockets and local ports, so tests that use a crate's fake helper or fake relay fail with \"Operation not permitted\": that is the sandbox, not the code. hive-dream runs the tests outside the sandbox afterwards.\n\n"
    ));
    p
}

const RULES: &str = "## Rules (a checker rejects the change otherwise)\n\n\
- Editing prompt text, tool descriptions, strings, comments or documentation is not a fix and is rejected. Hive's prompts (hive-codex/src/prompts.rs) are off limits. The fix changes behaviour in code, and comes with a test.\n\
- Do not touch: credentials or authentication code (credentials.rs, auth_mcp.rs, authenticate tools), the phone passcode, the one-way quote check (check_step), the knowledge base's secret filter, settings defaults (hive-common/src/settings.rs), install.sh, the root helper (desktop/app/src/*.cpp, *.hpp), launchd files, the VM poster's approval flow, hive-dream itself, or any Cargo.toml or Cargo.lock (no new dependencies).\n\
- Do not remove tests or mark them #[ignore].\n\
- Change only files under desktop/app/crates/.\n\
- No personal data (names, emails, phone numbers, accounts) in code, tests or comments: use made-up values.\n\
- Cargo is offline: don't fetch anything. Don't run Hive, don't use the screen, don't send messages.\n\
- Do not commit, push or make branches: hive-dream commits and checks each step.\n";

/// Step 1: a test that fails on the code as it is, and nothing else.
pub fn test_prompt(c: &Cluster, s: &Setup, terms: &[String]) -> String {
    let mut p = intro(s, "Step 1 of 2: write a failing test that shows the problem. Only the test; the fix is step 2.");
    p.push_str(&failure(c, s.worktree, terms));
    p.push_str(
        "\n## What to do now\n\n\
1. Find the code path that produces this failure. Read the code; the lines above are what it printed.\n\
2. Write a test that fails because of the problem and reproduces it deterministically: a unit test in the crate's `#[cfg(test)] mod tests`, or a file in the crate's `tests/`. No network, no real screen, no real phone, no real accounts, no sleeping for real time if a clock can be passed in.\n\
3. The test calls code that exists now and fails on an assertion. A test that only fails because it calls a function that doesn't exist yet doesn't show the problem: it is kept for a person to judge and never lands by itself.\n\
4. Run it and see it fail. Change no code outside tests in this step: hive-dream commits the test, runs it on the code as it is, and rejects it if it passes.\n\n",
    );
    p.push_str(RULES);
    p.push_str("\nThe evidence rarely proves a single cause: aim the test at the case the code mishandles, the wait that could end sooner or the state it forgets, and say what you assumed. If no test can be written safely, change nothing and say why.\n\nIn your last message: the test's name, what it shows and how it failed.\n");
    p
}

/// Step 2: the fix, now that the test is committed and seen failing.
pub fn fix_prompt(
    c: &Cluster,
    s: &Setup,
    terms: &[String],
    test_files: &[String],
    red: &str,
) -> String {
    let mut p = intro(
        s,
        "Step 2 of 2: fix the code so the failing test from step 1 passes.",
    );
    p.push_str(&failure(c, s.worktree, terms));
    p.push_str(&format!(
        "\n## The test from step 1\n\nCommitted in {} and seen failing on the code as it is:\n\n```\n{}\n```\n",
        test_files.join(", "),
        cut(&redact(red, terms), 1500)
    ));
    p.push_str(
        "\n## What to do now\n\n\
1. Change the Rust code so the test passes: a deterministic fix in a tool, the harness, a timeout, a retry, state handling or error handling. Keep the test as it is (you may add more tests).\n\
2. Run that crate's tests. hive-dream then runs the crate's tests and builds the whole workspace outside the sandbox, and rejects the change if anything fails.\n\n",
    );
    p.push_str(RULES);
    p.push_str("\nIn your last message: the cause, the fix, and the test result.\n");
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
        "Dream fix: {}\n\n{}. Seen {} times, about {:.0} minutes lost ({} to {}).\nHive's nightly dream: its agent wrote a test that failed on the code as it was, then this fix, in a\nprivate worktree; hive-dream's gate ran the crate's tests and built the workspace.\n\nDream-Cluster: {}\n",
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

pub fn save_result(night: &Path, r: &FixResult) -> Result<(), String> {
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

fn rejected(r: &mut FixResult, why: String) {
    r.outcome = "rejected".into();
    r.verdict = Some(Verdict {
        passed: false,
        reasons: vec![why],
        warnings: Vec::new(),
        files: Vec::new(),
        test_lines: 0,
        code_lines: 0,
        packages: Vec::new(),
        tests: Vec::new(),
    });
}

/// Commits what changed in the worktree, by name, as hive-dream.
fn commit_all(worktree: &Path, message: &str, msg_file: &Path) -> Result<Option<String>, String> {
    let files = git::dirty(worktree)?;
    if files.is_empty() {
        return Ok(None);
    }
    let mut add: Vec<&str> = vec!["add", "--"];
    add.extend(files.iter().map(String::as_str));
    git::git(worktree, &add)?;
    commit(worktree, message, msg_file)?;
    git::rev(worktree, "HEAD").map(Some)
}

fn commit(worktree: &Path, message: &str, msg_file: &Path) -> Result<(), String> {
    paths::write_atomic(msg_file, message)?;
    git::git(
        worktree,
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
    )
    .map(|_| ())
}

/// What the agent said at the end of a step.
struct Said {
    finished: bool,
    text: String,
}

/// One step: the prompt to Hive (through hive-ask, which waits for the task to end) or to the
/// Codex CLI. Err when nothing it did can be used.
fn ask(
    s: &Setup,
    name: &str,
    step: &str,
    text: &str,
    run_dir: &Path,
    r: &mut FixResult,
) -> Result<Said, String> {
    paths::write_atomic(&run_dir.join(format!("prompt-{step}.md")), text)?;
    let started = std::time::Instant::now();
    let said = if s.agent == "hive" {
        let hive_ask = paths::hive_ask();
        if !hive_ask.is_file() {
            return Err(format!("no hive-ask at {}", hive_ask.display()));
        }
        let argv: Vec<String> = vec![
            hive_ask.to_string_lossy().into_owned(),
            "--wait".into(),
            HIVE_WAIT_MINUTES.to_string(),
            "--source-id".into(),
            format!("hive-dream-{name}-{step}"),
            "-".into(),
        ];
        let ran = proc::run(
            &argv,
            s.worktree,
            &[],
            Some(text),
            &run_dir.join(format!("hive-{step}.log")),
            Duration::from_secs(HIVE_WAIT_MINUTES * 60 + 300),
        )?;
        r.codex_exit = ran.code;
        r.codex_timed_out = ran.timed_out;
        let finished = hive_ask_outcome(ran.code, ran.timed_out)?;
        let tail: String = {
            let lines: Vec<&str> = ran.output.lines().collect();
            lines[lines.len().saturating_sub(30)..].join("\n")
        };
        Said {
            finished,
            text: tail,
        }
    } else {
        let codex = paths::codex();
        if !codex.is_file() {
            return Err(format!("no Codex CLI at {}", codex.display()));
        }
        let env = gate::test_env(s.dream, "codex");
        let get = |key: &str| {
            env.iter()
                .find(|(k, _)| k == key)
                .map(|(_, v)| v.clone())
                .unwrap_or_default()
        };
        let (state, cargo_home) = (get("AGENT_STATE_DIR"), get("CARGO_HOME"));
        // Codex keeps the real HOME (its sign-in); everything else as the tests have it.
        let codex_env: Vec<(String, String)> =
            env.iter().filter(|(k, _)| k != "HOME").cloned().collect();
        let last = run_dir.join(format!("last-message-{step}.txt"));
        let mut argv: Vec<String> = vec![
            codex.to_string_lossy().into_owned(),
            "exec".into(),
            "--ignore-user-config".into(),
            "--ignore-rules".into(),
            "-s".into(),
            "workspace-write".into(),
            "-C".into(),
            s.worktree.to_string_lossy().into_owned(),
            "--add-dir".into(),
            s.dream.join("target").to_string_lossy().into_owned(),
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
        let ran = proc::run(
            &argv,
            s.worktree,
            &codex_env,
            Some(text),
            &run_dir.join(format!("codex-{step}.jsonl")),
            Duration::from_secs(CODEX_TIMEOUT_SECS),
        )?;
        r.codex_exit = ran.code;
        r.codex_timed_out = ran.timed_out;
        Said {
            finished: ran.ok,
            text: std::fs::read_to_string(&last).unwrap_or_default(),
        }
    };
    r.codex_seconds += (started.elapsed().as_secs_f64() * 10.0).round() / 10.0;
    Ok(said)
}

/// Files that are dirty in ~/hive now and weren't before the agent worked.
fn new_in_main(repo: &Path, before: &[String]) -> Vec<String> {
    git::dirty(repo)
        .unwrap_or_default()
        .into_iter()
        .filter(|f| !before.contains(f))
        .collect()
}

fn try_attempt(
    dream: &Path,
    night: &Path,
    date: &str,
    c: &Cluster,
    r: &mut FixResult,
) -> Result<(), String> {
    let repo = paths::repo();
    let agent = agent();
    r.agent = agent.into();
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
    let terms = paths::load_private_terms(dream).unwrap_or_default();
    let private = paths::load_private_terms(dream);
    let setup = Setup {
        agent,
        worktree: &worktree,
        branch: &branch,
        dream,
    };
    let main_before = git::dirty(&repo).unwrap_or_default();

    // Step 1: the test, alone.
    let said = ask(
        &setup,
        &name,
        "test",
        &test_prompt(c, &setup, &terms),
        &run_dir,
        r,
    )?;
    r.codex_said = cut(&redact(&said.text, &terms), 2000);
    let changed = new_in_main(&repo, &main_before);
    if !changed.is_empty() {
        r.notes.push(format!(
            "changed in ~/hive itself while the agent wrote the test (hive-dream left them alone): {}",
            changed.join(", ")
        ));
    }
    let message = commit_message(c);
    let Some(test_commit) = commit_all(
        &worktree,
        &format!("Dream test: {}\n", cut(&c.signature, 120)),
        &run_dir.join("test-commit-message.txt"),
    )?
    else {
        rejected(
            r,
            if said.finished {
                "step 1 wrote no test".into()
            } else {
                format!("step 1 wrote no test (exit {:?})", r.codex_exit)
            },
        );
        return Ok(());
    };
    r.test_commit = Some(test_commit.clone());
    let changes = git::changes(&worktree, &base, &test_commit)?;
    let s = gate::check_static(&changes, &message, private.as_deref());
    if s.test_lines == 0 {
        rejected(r, "step 1 added no test code".into());
        return Ok(());
    }
    if s.code_lines > 0 {
        rejected(
            r,
            format!("step 1 changed {} code lines outside tests", s.code_lines),
        );
        return Ok(());
    }
    let packages = gate::touched_packages(&worktree, &s.files);
    if packages.is_empty() {
        rejected(r, "step 1's test is in no Rust crate".into());
        return Ok(());
    }
    let red_log = run_dir.join("red.log");
    let red_runs = gate::run_tests(&worktree, dream, &packages, &red_log);
    let Some(red) = red_runs.iter().find(|t| !t.ok) else {
        rejected(
            r,
            "step 1's test passes on the code as it is, so it doesn't show the problem".into(),
        );
        return Ok(());
    };
    r.red = red_kind(&std::fs::read_to_string(&red_log).unwrap_or_default()).into();
    if r.red.is_empty() {
        rejected(
            r,
            format!(
                "step 1's test run failed, but not on a test or a build: {}",
                red.summary
            ),
        );
        return Ok(());
    }

    // Step 2: the fix.
    let prompt = fix_prompt(c, &setup, &terms, &s.files, &red.summary);
    let said = ask(&setup, &name, "fix", &prompt, &run_dir, r)?;
    r.codex_said = cut(&redact(&said.text, &terms), 2000);
    let changed = new_in_main(&repo, &main_before);
    if !changed.is_empty() {
        r.notes.push(format!(
            "changed in ~/hive itself while the agent fixed it (hive-dream left them alone): {}",
            changed.join(", ")
        ));
    }
    let Some(head) = commit_all(&worktree, &message, &run_dir.join("commit-message.txt"))? else {
        rejected(r, "step 2 changed nothing".into());
        return Ok(());
    };

    // The gate, on the test and the fix together.
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
    let head = if verdict.passed {
        // One commit for the test and its fix, so main never has a red commit.
        git::git(&worktree, &["reset", "--soft", "--quiet", &base])?;
        commit(&worktree, &message, &run_dir.join("commit-message.txt"))?;
        git::rev(&worktree, "HEAD")?
    } else {
        head
    };
    r.commit = Some(head.clone());
    r.diffstat = git::git(&worktree, &["diff", "--stat", &base, &head])
        .unwrap_or_default()
        .trim_end()
        .to_string();
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
