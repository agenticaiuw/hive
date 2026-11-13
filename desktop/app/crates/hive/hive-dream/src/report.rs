//! `<dream>/<date>/report.md`: the morning report. Rewritten after collect and after each fix,
//! from the night's evidence.json and fixes/*/result.json. It quotes what Hive logged, so it stays
//! in the private state folder.

use std::fmt::Write as _;
use std::path::{Path, PathBuf};

use crate::evidence::{category, Evidence};
use crate::fix::{self, FixResult};
use crate::paths;

/// How many clusters the report lists in full.
pub const TOP: usize = 15;

fn md(s: &str) -> String {
    s.replace('|', "\\|").replace('\n', " ")
}

pub fn render(date: &str, ev: &Evidence, fixes: &[FixResult], exe: &str) -> String {
    let mut o = String::new();
    let c = &ev.counts;
    let _ = writeln!(o, "# Hive dream, {date}\n");
    let _ = writeln!(
        o,
        "Read {} to {}: {} journal sessions ({} events), {} recordings ({} scripted test runs left out), Agent.log ({} lines). {} occurrences ({} before merging what two sources saw at once) in {} clusters.\n",
        ev.since_local,
        ev.until_local,
        c.journal_sessions,
        c.journal_events,
        c.recordings,
        c.recordings_skipped_as_test_runs,
        c.agent_log_lines,
        c.occurrences,
        c.occurrences_before_merge,
        ev.clusters.len()
    );

    let _ = writeln!(o, "## Fixes\n");
    if fixes.is_empty() {
        let _ = writeln!(o, "No fix attempted for this night yet.\n");
    }
    for f in fixes {
        let _ = writeln!(o, "### {}: {}\n", f.outcome, md(&f.signature));
        let _ = writeln!(
            o,
            "- Evidence: seen {} times, about {:.0} minutes lost, {} to {}.",
            f.count, f.minutes, f.first_seen, f.last_seen
        );
        if !f.refs.is_empty() {
            let _ = writeln!(
                o,
                "- References: {}",
                f.refs
                    .iter()
                    .take(6)
                    .cloned()
                    .collect::<Vec<_>>()
                    .join(", ")
            );
        }
        if let Some(b) = &f.branch {
            let _ = writeln!(
                o,
                "- Branch: `{b}` (local only), worktree `{}`",
                f.worktree.as_deref().unwrap_or("")
            );
        }
        if let Some(e) = &f.error {
            let _ = writeln!(o, "- Error: {}", md(e));
        }
        let _ = writeln!(
            o,
            "- Codex: {:.0} s, exit {}{}",
            f.codex_seconds,
            f.codex_exit.map_or("none".into(), |c| c.to_string()),
            if f.codex_timed_out { ", timed out" } else { "" }
        );
        if !f.diffstat.is_empty() {
            let _ = writeln!(o, "- Diff:\n\n```\n{}\n```", f.diffstat);
        }
        if let Some(v) = &f.verdict {
            for t in &v.tests {
                let _ = writeln!(
                    o,
                    "- Test `{}`: {} in {:.0} s: {}",
                    t.command,
                    if t.ok { "passed" } else { "FAILED" },
                    t.seconds,
                    md(&t.summary)
                );
            }
            if v.passed {
                let _ = writeln!(
                    o,
                    "- Gate: passed ({} test lines, {} code lines).",
                    v.test_lines, v.code_lines
                );
            } else {
                let _ = writeln!(o, "- Gate: rejected:");
                for reason in &v.reasons {
                    let _ = writeln!(o, "  - {}", md(reason));
                }
            }
            for w in &v.warnings {
                let _ = writeln!(o, "- Warning: {}", md(w));
            }
        }
        if !f.codex_said.is_empty() {
            let _ = writeln!(
                o,
                "- Codex said:\n\n> {}\n",
                f.codex_said.trim().replace('\n', "\n> ")
            );
        }
        if let Some(b) = &f.branch {
            if f.outcome == "proposed" {
                let _ = writeln!(o, "- Land it (cherry-picks onto main in ~/hive, never pushes):\n\n```\n{exe} land {b}\n```\n");
            } else {
                let _ = writeln!(o, "- Not proposed; the branch is kept for a look: `git -C ~/hive log -p main..{b}`\n");
            }
        }
    }

    let alarms: Vec<_> = ev
        .clusters
        .iter()
        .filter(|c| {
            matches!(
                c.category.as_str(),
                "settings_changed" | "regression_words" | "restart_storm"
            )
        })
        .collect();
    if !alarms.is_empty() || !ev.regressed.is_empty() {
        let _ = writeln!(o, "## Alarms\n");
        for r in &ev.regressed {
            let _ = writeln!(o, "- Came back after it landed: {}", md(r));
        }
        for c in alarms {
            let _ = writeln!(
                o,
                "- {} ({} times, {} to {}): {}",
                md(&c.signature),
                c.count,
                c.first_seen,
                c.last_seen,
                c.examples
                    .iter()
                    .take(2)
                    .map(|e| md(e))
                    .collect::<Vec<_>>()
                    .join(" / ")
            );
        }
        let _ = writeln!(o);
    }

    let _ = writeln!(o, "## Top clusters\n");
    let _ = writeln!(
        o,
        "| # | minutes | count | category | signature | status | fixable |"
    );
    let _ = writeln!(o, "|---|---|---|---|---|---|---|");
    for (i, c) in ev.clusters.iter().take(TOP).enumerate() {
        let _ = writeln!(
            o,
            "| {} | {:.1} | {} | {} | {} | {} | {} |",
            i + 1,
            c.minutes,
            c.count,
            c.category,
            md(&c.signature),
            c.status,
            if c.fixable { "yes" } else { "no" }
        );
    }
    let _ = writeln!(o);
    for (i, c) in ev.clusters.iter().take(TOP).enumerate() {
        let title = category(&c.category).map_or("", |k| k.title);
        let _ = writeln!(o, "### {}. {}\n", i + 1, md(&c.signature));
        let _ = writeln!(
            o,
            "{title}. {} times, {:.1} minutes, first {}, last {}. Slug `{}`.\n",
            c.count, c.minutes, c.first_seen, c.last_seen, c.slug
        );
        for e in &c.examples {
            let _ = writeln!(o, "- `{}`", e.replace('`', "'"));
        }
        if !c.refs.is_empty() {
            let _ = writeln!(o, "- Seen at: {}", c.refs.join(", "));
        }
        let _ = writeln!(o);
    }
    if ev.clusters.len() > TOP {
        let _ = writeln!(
            o,
            "{} more clusters in evidence.json.\n",
            ev.clusters.len() - TOP
        );
    }
    if !ev.new.is_empty() {
        let _ = writeln!(o, "## New signatures ({})\n", ev.new.len());
        for s in ev.new.iter().take(30) {
            let _ = writeln!(o, "- {}", md(s));
        }
        let _ = writeln!(o);
    }
    if !ev.warnings.is_empty() {
        let _ = writeln!(o, "## Warnings\n");
        for w in &ev.warnings {
            let _ = writeln!(o, "- {}", md(w));
        }
    }
    o
}

/// Rewrites `<dream>/<date>/report.md` and returns its path.
pub fn write(dream: &Path, date: &str) -> Result<PathBuf, String> {
    let night = paths::night(dream, date);
    let text = std::fs::read_to_string(night.join("evidence.json"))
        .map_err(|e| format!("no evidence for {date}: {e}"))?;
    let ev: Evidence = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let fixes = fix::results(&night);
    let exe = std::env::current_exe()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| "hive-dream".into());
    let path = night.join("report.md");
    paths::write_atomic(&path, &render(date, &ev, &fixes, &exe))?;
    Ok(path)
}
