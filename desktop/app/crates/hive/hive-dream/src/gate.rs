//! The gate: code, not a model, decides whether a dream branch is "proposed" or "rejected".
//!
//! Static rules on the diff (all must hold):
//! - it adds or changes a test, and changes code outside tests (a change only to strings,
//!   comments or prompt text is not code);
//! - every file is under `desktop/app/crates/`; no crate manifest or lock file changes;
//! - no forbidden file and no forbidden item (credentials, authentication, phone passcode, the
//!   one-way quote check, the knowledge base's secret filter, settings defaults, installer, root
//!   helper, launchd files, the VM poster's approval flow, hive-dream itself) is touched, and no
//!   changed code line mentions a guarded word;
//! - no test is removed or ignored;
//! - no private term (from `<dream>/private-terms`) in the added lines or the commit message.
//!
//! Then the touched crates' tests must pass in the worktree (and the workspace must compile).

use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use crate::normalize::term_pattern;
use crate::rustscan;

/// One changed file: its old and new text (None when added or deleted) and the changed lines.
#[derive(Clone, Debug)]
pub struct FileChange {
    pub path: String,
    pub old: Option<String>,
    pub new: Option<String>,
    /// (0-based line in the new text, line)
    pub added: Vec<(usize, String)>,
    /// (0-based line in the old text, line)
    pub removed: Vec<(usize, String)>,
}

/// The cells a line diff may use before it treats the whole middle as changed.
const MAX_DIFF_CELLS: usize = 4_000_000;

/// Which old lines were removed and which new lines were added (0-based), by longest common
/// subsequence after trimming the common start and end. A middle too large to compare is all
/// changed (the gate then sees more, never less).
pub fn line_diff(old: &[&str], new: &[&str]) -> (Vec<usize>, Vec<usize>) {
    let mut pre = 0;
    while pre < old.len() && pre < new.len() && old[pre] == new[pre] {
        pre += 1;
    }
    let mut suf = 0;
    while suf < old.len() - pre
        && suf < new.len() - pre
        && old[old.len() - 1 - suf] == new[new.len() - 1 - suf]
    {
        suf += 1;
    }
    let a = &old[pre..old.len() - suf];
    let b = &new[pre..new.len() - suf];
    let (n, m) = (a.len(), b.len());
    if n == 0 || m == 0 || n * m > MAX_DIFF_CELLS || n > u16::MAX as usize || m > u16::MAX as usize
    {
        return ((pre..pre + n).collect(), (pre..pre + m).collect());
    }
    // lcs[i][j]: the LCS of a[i..] and b[j..].
    let w = m + 1;
    let mut lcs = vec![0u16; (n + 1) * w];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            lcs[i * w + j] = if a[i] == b[j] {
                lcs[(i + 1) * w + j + 1] + 1
            } else {
                lcs[(i + 1) * w + j].max(lcs[i * w + j + 1])
            };
        }
    }
    let (mut removed, mut added) = (Vec::new(), Vec::new());
    let (mut i, mut j) = (0, 0);
    while i < n && j < m {
        if a[i] == b[j] {
            i += 1;
            j += 1;
        } else if lcs[(i + 1) * w + j] >= lcs[i * w + j + 1] {
            removed.push(pre + i);
            i += 1;
        } else {
            added.push(pre + j);
            j += 1;
        }
    }
    removed.extend((i..n).map(|k| pre + k));
    added.extend((j..m).map(|k| pre + k));
    (removed, added)
}

impl FileChange {
    pub fn from_texts(path: &str, old: Option<&str>, new: Option<&str>) -> FileChange {
        let o: Vec<&str> = old.map_or(Vec::new(), |t| t.lines().collect());
        let n: Vec<&str> = new.map_or(Vec::new(), |t| t.lines().collect());
        let (removed, added) = line_diff(&o, &n);
        FileChange {
            path: path.to_string(),
            old: old.map(str::to_string),
            new: new.map(str::to_string),
            added: added.into_iter().map(|i| (i, n[i].to_string())).collect(),
            removed: removed.into_iter().map(|i| (i, o[i].to_string())).collect(),
        }
    }
}

/// Files no dream may touch (globs on the repo path; `*` stays inside one folder, `**` crosses).
pub const FORBIDDEN_PATHS: &[(&str, &str)] = &[
    ("**/credentials.rs", "credentials"),
    ("**/hive-credentials.rs", "credentials"),
    ("**/auth_mcp.rs", "authentication"),
    ("**/*auth*.rs", "authentication"),
    ("**/*passcode*", "phone passcode"),
    ("**/*secret*", "secrets"),
    (
        "desktop/app/crates/hive/hive-common/src/settings.rs",
        "settings defaults",
    ),
    ("desktop/app/crates/hive/hive-dream/**", "hive-dream itself"),
    ("**/install.sh", "installer"),
    ("desktop/app/src/*.cpp", "root helper"),
    ("desktop/app/src/*.hpp", "root helper"),
    ("**/*.plist", "launchd or bundle settings"),
    ("**/LaunchAgents/**", "launchd"),
    ("**/LaunchDaemons/**", "launchd"),
    ("cloud/vm-agent/posts.mjs", "the VM poster's approval flow"),
    ("cloud/vm-agent/poster.mjs", "the VM poster's approval flow"),
    ("cloud/vm-agent/hive-cred.mjs", "credentials"),
    ("cloud/server/approval*", "the VM poster's approval flow"),
    (
        "desktop/app/crates/agent-core/src/request_ledger.rs",
        "the one-way quote check",
    ),
    ("**/.env*", "secrets"),
];

/// Items no dream may touch, per file (path suffix, item names).
pub const FORBIDDEN_ITEMS: &[(&str, &[&str], &str)] = &[
    (
        "hive-codex/src/mcp.rs",
        &["check_step", "said"],
        "the one-way quote check",
    ),
    (
        "hive-mac/src/tools.rs",
        &["check_step", "authenticate_tool"],
        "the one-way quote check and authentication",
    ),
    (
        "hive-knowledge/src/knowledge.rs",
        &["secret", "SECRET_NAME", "SECRET_VALUE"],
        "the knowledge base's secret filter",
    ),
    (
        "hive-knowledge/src/memory_search.rs",
        &["AUTO_SECRET", "AUTO_OPTOUT", "SENSITIVE"],
        "the knowledge base's secret filter",
    ),
    (
        "hive-phone/src/tools.rs",
        &["AUTH_FAILED", "authenticate_phone"],
        "phone authentication",
    ),
    (
        "hive-phone/src/phone.rs",
        &["passcode_prompt_showing", "show_passcode_prompt"],
        "the phone passcode",
    ),
    (
        "hive-app/src/real.rs",
        &["show_passcode_prompt", "authenticate_phone"],
        "the phone passcode",
    ),
    (
        "hive-app/src/util.rs",
        &["SPEAK_ALOUD", "FLOATING_WINDOW", "setting", "set_setting"],
        "settings defaults",
    ),
    (
        "hive-mac/src/virtual_monitor.rs",
        &["choice", "choose", "choice_file"],
        "settings defaults",
    ),
    ("hive-codex/src/agent.rs", &["MODEL"], "the agent's model"),
];

/// Any item with a name like this, in any file.
static FORBIDDEN_NAME: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)authenticat|passcode|credential|secret|check_step|one_way").expect("names")
});

/// Words no changed code line (outside tests) may contain.
pub const FORBIDDEN_TOKENS: &[&str] = &[
    "check_step",
    "authenticat",
    "passcode",
    "credential",
    "password",
    "secret",
    "approval",
    "one-way",
    "one_way",
    "\"work-screen\"",
    "\"speak-aloud\"",
    "\"floating-window\"",
    "SPEAK_ALOUD",
    "FLOATING_WINDOW",
    "launchctl",
    "LaunchAgents",
    "sudo",
    ".env",
];

/// Prompt text: changing it is never a fix.
pub fn prompt_file(path: &str) -> bool {
    path.ends_with("hive-codex/src/prompts.rs")
        || path.ends_with(".md")
        || path.ends_with(".txt")
        || path.contains("/prompts/")
}

pub fn test_file(path: &str) -> bool {
    let name = path.rsplit('/').next().unwrap_or(path);
    path.contains("/tests/")
        || path.starts_with("tests/")
        || path.contains("/test/")
        || name.ends_with("_test.rs")
        || name.ends_with("_tests.rs")
        || (name.starts_with("test_") && name.ends_with(".py"))
        || name.contains(".test.")
}

pub fn glob_match(pattern: &str, path: &str) -> bool {
    let mut re = String::from("^");
    let p: Vec<char> = pattern.chars().collect();
    let mut i = 0;
    while i < p.len() {
        match p[i] {
            '*' if p.get(i + 1) == Some(&'*') => {
                // "**/" is any number of folders (including none).
                if p.get(i + 2) == Some(&'/') {
                    re.push_str("(?:.*/)?");
                    i += 3;
                } else {
                    re.push_str(".*");
                    i += 2;
                }
                continue;
            }
            '*' => re.push_str("[^/]*"),
            '?' => re.push_str("[^/]"),
            c => re.push_str(&regex::escape(&c.to_string())),
        }
        i += 1;
    }
    re.push('$');
    Regex::new(&re).is_ok_and(|r| r.is_match(path))
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct StaticResult {
    pub reasons: Vec<String>,
    pub warnings: Vec<String>,
    pub files: Vec<String>,
    /// Added test lines (code, not blank or comment).
    pub test_lines: usize,
    /// Changed code lines outside tests that change more than text.
    pub code_lines: usize,
}

fn reject(r: &mut StaticResult, why: String) {
    if !r.reasons.contains(&why) {
        r.reasons.push(why);
    }
}

fn compact(s: &str) -> String {
    s.chars().filter(|c| !c.is_whitespace()).collect()
}

static TEST_FN_ATTR: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"#\[\s*(?:[a-z_]+::)*test\s*(?:\]|\()").expect("test fn attr"));
static IGNORE_ATTR: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"#\[\s*ignore\b").expect("ignore"));

/// The static rules. `terms` is None when the private-terms file is missing (then skipped, with a
/// warning).
pub fn check_static(
    changes: &[FileChange],
    message: &str,
    terms: Option<&[String]>,
) -> StaticResult {
    let mut r = StaticResult {
        files: changes.iter().map(|c| c.path.clone()).collect(),
        ..Default::default()
    };
    if changes.is_empty() {
        reject(&mut r, "Codex changed nothing".into());
        return r;
    }
    let mut tests_removed = 0i64;
    for ch in changes {
        let path = ch.path.as_str();
        if !path.starts_with("desktop/app/crates/") {
            reject(&mut r, format!("{path} is outside desktop/app/crates"));
        }
        for (glob, what) in FORBIDDEN_PATHS {
            if glob_match(glob, path) {
                reject(&mut r, format!("{path} is guarded ({what})"));
            }
        }
        let name = path.rsplit('/').next().unwrap_or(path);
        if name == "Cargo.toml" || name == "Cargo.lock" {
            reject(
                &mut r,
                format!("{path}: a dream may not change crates or dependencies"),
            );
        }
        let rust = path.ends_with(".rs");
        let whole_test = test_file(path);
        let old_scan = ch.old.as_deref().filter(|_| rust).map(rustscan::scan);
        let new_scan = ch.new.as_deref().filter(|_| rust).map(rustscan::scan);
        let guarded_items: Vec<(&str, &str)> = FORBIDDEN_ITEMS
            .iter()
            .filter(|(suffix, _, _)| path.ends_with(suffix))
            .flat_map(|(_, names, what)| names.iter().map(move |n| (*n, *what)))
            .collect();

        // Code lines outside tests, compacted, per side (for "only text changed").
        let mut code_added: BTreeMap<String, i64> = BTreeMap::new();
        let mut code_lines = 0usize;
        let sides = [
            (&ch.added, new_scan.as_ref(), 1i64),
            (&ch.removed, old_scan.as_ref(), -1i64),
        ];
        for (lines, scan, sign) in sides {
            for (i, raw) in lines {
                let code = scan
                    .and_then(|s| s.stripped.get(*i))
                    .cloned()
                    .unwrap_or_else(|| raw.clone());
                let in_test = whole_test || scan.is_some_and(|s| s.is_test(*i));
                if let Some(s) = scan {
                    for item in s.items_at(*i) {
                        if FORBIDDEN_NAME.is_match(&item.name) {
                            reject(
                                &mut r,
                                format!("{path}: changes {} (a guarded name)", item.name),
                            );
                        }
                        for (n, what) in &guarded_items {
                            if item.name == *n {
                                reject(&mut r, format!("{path}: changes {n} ({what})"));
                            }
                        }
                    }
                }
                if TEST_FN_ATTR.is_match(&code) {
                    tests_removed -= sign;
                }
                if sign > 0 && IGNORE_ATTR.is_match(&code) {
                    reject(&mut r, format!("{path}: marks a test #[ignore]"));
                }
                let compacted = compact(&code);
                if in_test {
                    if sign > 0 && !compacted.is_empty() {
                        r.test_lines += 1;
                    }
                    continue;
                }
                let lower = raw.to_lowercase();
                for token in FORBIDDEN_TOKENS {
                    if lower.contains(&token.to_lowercase()) {
                        reject(&mut r, format!("{path}: a changed line mentions {token}"));
                    }
                }
                if rust && !prompt_file(path) && !compacted.is_empty() {
                    *code_added.entry(compacted).or_default() += sign;
                    code_lines += 1;
                }
            }
        }
        // A line whose code is the same on both sides changed only text (a string or comment).
        if code_added.values().any(|v| *v != 0) {
            r.code_lines += code_lines;
        }
    }
    if tests_removed > 0 {
        reject(&mut r, format!("removes {tests_removed} test(s)"));
    }
    if r.test_lines == 0 {
        reject(
            &mut r,
            "no test added or changed (a fix needs a test that reproduces the problem)".into(),
        );
    }
    if r.code_lines == 0 {
        reject(
            &mut r,
            "no code change outside tests (only strings, comments, prompts or text changed)".into(),
        );
    }
    match terms {
        None => r
            .warnings
            .push("no private-terms file: the private term check was skipped".into()),
        Some(terms) => {
            let patterns: Vec<Regex> = terms.iter().filter_map(|t| term_pattern(t)).collect();
            let hit = |text: &str| patterns.iter().any(|p| p.is_match(text));
            if hit(message) {
                reject(&mut r, "the commit message contains a private term".into());
            }
            for ch in changes {
                if hit(&ch.path) {
                    reject(&mut r, "a file name contains a private term".into());
                }
                for (i, line) in &ch.added {
                    if hit(line) {
                        reject(
                            &mut r,
                            format!("{} line {} contains a private term", ch.path, i + 1),
                        );
                    }
                }
            }
        }
    }
    r
}

/// A package the tests run for: a member of the hive workspace, or agent-core (its own manifest).
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum Package {
    Hive(String),
    AgentCore,
}

/// The packages the changed files belong to.
pub fn touched_packages(worktree: &Path, files: &[String]) -> Vec<Package> {
    let mut out: Vec<Package> = Vec::new();
    for f in files {
        let p = if f.starts_with("desktop/app/crates/agent-core/") {
            Some(Package::AgentCore)
        } else if let Some(rest) = f.strip_prefix("desktop/app/crates/hive/") {
            let dir = rest.split('/').next().unwrap_or("");
            let manifest = worktree
                .join("desktop/app/crates/hive")
                .join(dir)
                .join("Cargo.toml");
            std::fs::read_to_string(manifest).ok().and_then(|t| {
                t.lines()
                    .map(str::trim)
                    .find_map(|l| {
                        l.strip_prefix("name = \"")
                            .and_then(|s| s.strip_suffix('"'))
                    })
                    .map(|n| Package::Hive(n.to_string()))
            })
        } else {
            None
        };
        if let Some(p) = p {
            if !out.contains(&p) {
                out.push(p);
            }
        }
    }
    out.sort();
    out
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TestRun {
    pub command: String,
    pub ok: bool,
    pub seconds: f64,
    /// The `test result:` lines, or the end of the output when it failed.
    pub summary: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Verdict {
    pub passed: bool,
    pub reasons: Vec<String>,
    pub warnings: Vec<String>,
    pub files: Vec<String>,
    pub test_lines: usize,
    pub code_lines: usize,
    pub packages: Vec<Package>,
    pub tests: Vec<TestRun>,
}

/// The environment the tests run in: a private HOME and state folder under `<dream>/tmp`, the
/// dream's own target folder, no network, no recordings. TMPDIR stays the system's (a long one
/// breaks unix socket paths).
pub fn test_env(dream: &Path, name: &str) -> Vec<(String, String)> {
    let base = dream.join("tmp").join(name);
    let home = base.join("home");
    let state = base.join("state");
    let _ = std::fs::create_dir_all(&home);
    let _ = std::fs::create_dir_all(&state);
    let real_home = crate::paths::home();
    let cargo_home = std::env::var("CARGO_HOME")
        .unwrap_or_else(|_| real_home.join(".cargo").to_string_lossy().into_owned());
    let rustup_home = std::env::var("RUSTUP_HOME")
        .unwrap_or_else(|_| real_home.join(".rustup").to_string_lossy().into_owned());
    let path = format!(
        "{cargo_home}/bin:{}",
        std::env::var("PATH").unwrap_or_else(|_| "/usr/bin:/bin:/usr/sbin:/sbin".into())
    );
    vec![
        ("HOME".into(), home.to_string_lossy().into_owned()),
        ("CARGO_HOME".into(), cargo_home),
        ("RUSTUP_HOME".into(), rustup_home),
        ("PATH".into(), path),
        (
            "AGENT_STATE_DIR".into(),
            state.to_string_lossy().into_owned(),
        ),
        ("HIVE_RECORD".into(), "0".into()),
        (
            "CARGO_TARGET_DIR".into(),
            dream.join("target").to_string_lossy().into_owned(),
        ),
        ("CARGO_INCREMENTAL".into(), "0".into()),
        ("CARGO_PROFILE_DEV_DEBUG".into(), "0".into()),
        ("CARGO_PROFILE_TEST_DEBUG".into(), "0".into()),
        ("CARGO_NET_OFFLINE".into(), "true".into()),
        ("CARGO_TERM_COLOR".into(), "never".into()),
    ]
}

/// agent-core's own build folder. It's a separate cargo workspace with its own lock file, and
/// sharing the hive workspace's folder makes one build of personal-agent-core overwrite the
/// other's (the next hive build then fails with two "different" serde_json types).
pub fn core_target(dream: &Path) -> PathBuf {
    dream.join("target").join("agent-core")
}

pub const TEST_TIMEOUT_SECS: u64 = 30 * 60;

/// The hive crates that don't build on this OS: on Linux (Hive's cloud VM) the three that need
/// macOS frameworks. Their tests run in the macOS check on GitHub Actions (`ci`).
pub fn not_here() -> &'static [&'static str] {
    if cfg!(target_os = "macos") {
        &[]
    } else {
        &["hive-mac", "hive-sidecars", "hive-app"]
    }
}

/// Whether every package builds on this OS.
pub fn all_here(packages: &[Package]) -> bool {
    packages
        .iter()
        .all(|p| !matches!(p, Package::Hive(n) if not_here().contains(&n.as_str())))
}

/// Runs the touched packages' tests, then checks the whole hive workspace still compiles (on
/// Linux, without the crates in [`not_here`]).
pub fn run_tests(worktree: &Path, dream: &Path, packages: &[Package], log: &Path) -> Vec<TestRun> {
    let env = test_env(dream, "gate");
    let hive_manifest: PathBuf = worktree.join("desktop/app/crates/hive/Cargo.toml");
    let core_manifest: PathBuf = worktree.join("desktop/app/crates/agent-core/Cargo.toml");
    let mut commands: Vec<Vec<String>> = Vec::new();
    let hive: Vec<&String> = packages
        .iter()
        .filter_map(|p| match p {
            Package::Hive(n) if !not_here().contains(&n.as_str()) => Some(n),
            _ => None,
        })
        .collect();
    let m = |p: &Path| p.to_string_lossy().into_owned();
    if !hive.is_empty() {
        let mut c: Vec<String> = vec![
            "cargo".into(),
            "test".into(),
            "--offline".into(),
            "--manifest-path".into(),
            m(&hive_manifest),
        ];
        for n in &hive {
            c.push("-p".into());
            c.push((*n).clone());
        }
        commands.push(c);
    }
    if packages.contains(&Package::AgentCore) {
        commands.push(vec![
            "cargo".into(),
            "test".into(),
            "--offline".into(),
            "--manifest-path".into(),
            m(&core_manifest),
            "--target-dir".into(),
            m(&core_target(dream)),
        ]);
    }
    commands.push(vec![
        "cargo".into(),
        "test".into(),
        "--offline".into(),
        "--manifest-path".into(),
        m(&hive_manifest),
        "--workspace".into(),
        "--no-run".into(),
    ]);
    if let Some(c) = commands.last_mut() {
        for n in not_here() {
            c.push("--exclude".into());
            c.push((*n).into());
        }
    }
    let mut runs = Vec::new();
    for c in commands {
        let started = std::time::Instant::now();
        let result = crate::proc::run(
            &c,
            worktree,
            &env,
            None,
            log,
            std::time::Duration::from_secs(TEST_TIMEOUT_SECS),
        );
        let (ok, output) = match result {
            Ok(r) => (r.ok, r.output),
            Err(e) => (false, e),
        };
        let lines: Vec<&str> = output
            .lines()
            .filter(|l| {
                l.starts_with("test result:") || l.contains("error[") || l.starts_with("error:")
            })
            .collect();
        let summary = if ok {
            summarize_results(&lines)
        } else {
            let tail: Vec<&str> = output.lines().rev().take(25).collect();
            tail.into_iter().rev().collect::<Vec<_>>().join("\n")
        };
        let display = c[1..].join(" ").replace(&m(worktree), "<worktree>");
        runs.push(TestRun {
            command: format!("cargo {display}"),
            ok,
            seconds: (started.elapsed().as_secs_f64() * 10.0).round() / 10.0,
            summary,
        });
        if !ok {
            break;
        }
    }
    runs
}

static RESULT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(\d+) passed; (\d+) failed; (\d+) ignored").expect("result"));

fn summarize_results(lines: &[&str]) -> String {
    let (mut passed, mut failed, mut ignored, mut suites) = (0u64, 0u64, 0u64, 0u64);
    for l in lines {
        if let Some(c) = RESULT.captures(l) {
            suites += 1;
            passed += c[1].parse::<u64>().unwrap_or(0);
            failed += c[2].parse::<u64>().unwrap_or(0);
            ignored += c[3].parse::<u64>().unwrap_or(0);
        }
    }
    if suites == 0 {
        "compiled".into()
    } else {
        format!("{passed} passed, {failed} failed, {ignored} ignored in {suites} test binaries")
    }
}

/// The whole gate on `base..head` in the worktree.
pub fn judge(
    worktree: &Path,
    dream: &Path,
    base: &str,
    head: &str,
    message: &str,
    terms: Option<&[String]>,
    log: &Path,
) -> Result<Verdict, String> {
    let changes = crate::git::changes(worktree, base, head)?;
    let s = check_static(&changes, message, terms);
    let packages = touched_packages(worktree, &s.files);
    let tests = if changes.is_empty() {
        Vec::new()
    } else {
        run_tests(worktree, dream, &packages, log)
    };
    let mut reasons = s.reasons;
    if !changes.is_empty() && packages.is_empty() {
        reasons.push("no Rust crate touched, so no tests to run".into());
    }
    if let Some(t) = tests.iter().find(|t| !t.ok) {
        reasons.push(format!("tests failed: {}", t.command));
    }
    Ok(Verdict {
        passed: reasons.is_empty(),
        reasons,
        warnings: s.warnings,
        files: s.files,
        test_lines: s.test_lines,
        code_lines: s.code_lines,
        packages,
        tests,
    })
}
