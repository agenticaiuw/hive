//! Self-Improvement Memory (SIM) and friction mining for Hive's own harness (arXiv:2611.18856).
//! Strictly for harness-editing tasks, never general task-solving agents. Upstream entries live in
//! append-only `server/sim.jsonl` (anonymized, shipped with releases); local instance entries live in
//! SQLite (`sim` table in hive.db) so local self-evolution never conflicts with upstream updates.
use crate::args;
use crate::db::{now, Db};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::Path;

const UPSTREAM: &str = include_str!("../sim.jsonl");

pub const PROTOCOL: &str = "Self-Improvement Memory (SIM) & Build-to-Delete protocol for editing Hive:\n\
- Call `sim(mode=\"read\")` first to inspect SIM history, raw failure traces, dead/high-failure tools, old-model ablation candidates, rule bloat, and largest files.\n\
- Reuse an existing root-cause `problem` name when it explains the failure; otherwise name a new one.\n\
- Actively subtract: delete dead/duplicate code, consolidate overlapping tools, and ablate old-model workarounds (prompt phrasing, parsing, retry thresholds) when newer models no longer need them. Never edit SPECS.md and never delete/weaken tests (`reinstall` rejects test-count regressions).\n\
- Before calling `reinstall`, call `sim(mode=\"propose\")` with a concrete pre-edit `predicted` fix, then pass that `sim_id` to `reinstall`. After verifying, record `fixed`/`missed` via `sim(mode=\"outcome\")` (never erase failed/reverted history).\n\
- Upstream governance: keep owner-specific edits local; for generalizable club fixes, append an anonymized `sim(mode=\"export\")` line to `server/sim.jsonl`, push a feature branch, and open a draft PR (`gh pr create --draft`)—never push directly to club `main`.";

fn s(v: &Value) -> String { hive_protocol::str_val(v).trim().to_string() }
fn key(problem: &str) -> String { problem.trim().to_ascii_lowercase() }

/// Anonymized upstream SIM shipped with Hive (reads live checkout file when present, else embedded copy).
pub fn upstream(repo: Option<&Path>) -> Vec<Value> {
    let raw = repo.and_then(|r| std::fs::read_to_string(r.join("server/sim.jsonl")).ok())
        .unwrap_or_else(|| UPSTREAM.to_string());
    raw.lines().filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str::<Value>(l).ok()).collect()
}

/// Record a pre-edit hypothesis + modification before evaluation. Deterministically merges identical
/// root-cause text (case-insensitive) to the first canonical phrasing.
pub fn propose(db: &Db, repo: Option<&Path>, engine: &str, model: &str, commit: &str, a: &Value) -> Result<i64, String> {
    let (problem, what, predicted) = (s(&a["problem"]), s(&a["what"]), s(&a["predicted"]));
    if problem.is_empty() || what.is_empty() || predicted.is_empty() {
        return Err("propose needs problem (root cause), what (edit + rationale), and predicted (what it should fix)".into());
    }
    let want = key(&problem);
    let canonical = upstream(repo).into_iter().map(|r| s(&r["problem"]))
        .chain(db.all("select distinct problem from sim order by id", &[]).into_iter().map(|r| s(&r["problem"])))
        .find(|p| key(p) == want).unwrap_or(problem);
    Ok(db.run("insert into sim(problem, what, files, engine, model, predicted, status, commit_sha, at) values(?,?,?,?,?,?,?,?,?)",
        args!(canonical, what, s(&a["files"]), engine, model, predicted, "proposed", commit, now())))
}

/// Append observed post-edit outcomes without erasing prior attempts.
pub fn outcome(db: &Db, id: i64, fixed: &str, missed: &str, status: &str) -> Result<(), String> {
    if id <= 0 || db.get("select 1 from sim where id=?", args!(id)).is_none() { return Err(format!("no SIM attempt #{id}")); }
    let status = match status.trim() {
        "active" | "missed" | "reverted" | "pruned" | "proposed" => status.trim(),
        "" => if !missed.trim().is_empty() && fixed.trim().is_empty() { "missed" } else { "active" },
        o => return Err(format!("invalid status '{o}' (use active, missed, reverted, or pruned)")),
    };
    db.run("update sim set fixed=?, missed=?, status=? where id=?", args!(fixed.trim(), missed.trim(), status, id));
    Ok(())
}

/// Automatically link `reinstall` test/build results and net LOC onto a SIM attempt (explicit id, else latest proposed).
pub fn record_eval(db: &Db, sim_id: i64, ok: bool, passed: i64, total: i64, net_loc: i64, commit: &str) -> Option<i64> {
    let id = if sim_id > 0 { sim_id } else {
        db.get("select id from sim where status='proposed' order by id desc limit 1", &[])?.get("id")?.as_i64()?
    };
    db.get("select 1 from sim where id=?", args!(id))?;
    let status = if ok { "active" } else { "missed" };
    db.run("update sim set passed=?, total=?, net_loc=?, status=?, commit_sha=case when ?!='' then ? else commit_sha end where id=?",
        args!(passed, total, net_loc, status, commit, commit, id));
    Some(id)
}

/// Format an anonymized JSONL line for appending to `server/sim.jsonl` when upstreaming a general fix.
pub fn export_line(db: &Db, id: i64) -> Result<String, String> {
    let r = db.get("select * from sim where id=?", args!(id)).ok_or(format!("no SIM attempt #{id}"))?;
    Ok(json!({
        "problem": s(&r["problem"]), "what": s(&r["what"]), "files": s(&r["files"]),
        "engine": s(&r["engine"]), "model": s(&r["model"]), "predicted": s(&r["predicted"]),
        "fixed": s(&r["fixed"]), "missed": s(&r["missed"]),
        "passed": r["passed"].as_i64().unwrap_or(0), "total": r["total"].as_i64().unwrap_or(0),
        "net_loc": r["net_loc"].as_i64().unwrap_or(0),
        "status": s(&r["status"]), "commit": s(&r["commit_sha"]),
    }).to_string())
}

/// Render full upstream + local SIM grouped by root cause (read in full, no retrieval/truncation).
pub fn format(db: &Db, repo: Option<&Path>) -> String {
    let mut groups: BTreeMap<String, (String, Vec<String>)> = BTreeMap::new();
    let mut push = |origin: &str, r: &Value| {
        let p = s(&r["problem"]);
        if p.is_empty() { return; }
        let (passed, total) = (r["passed"].as_i64().unwrap_or(0), r["total"].as_i64().unwrap_or(0));
        let score = if total > 0 { format!(" ({passed}/{total})") } else { String::new() };
        let net = r["net_loc"].as_i64().unwrap_or(0);
        let loc = if net != 0 { format!(" [{}{} LOC]", if net > 0 { "+" } else { "" }, net) } else { String::new() };
        let id = r["id"].as_i64().map(|n| format!("#{n} ")).unwrap_or_default();
        let mut line = format!("  - [{origin}] {id}[{}/{}] {}{score}{loc}: {}",
            s(&r["engine"]), s(&r["model"]), s(&r["status"]), s(&r["what"]));
        if !s(&r["files"]).is_empty() { line += &format!(" | files: {}", s(&r["files"])); }
        if !s(&r["predicted"]).is_empty() { line += &format!(" | predicted: {}", s(&r["predicted"])); }
        if !s(&r["fixed"]).is_empty() { line += &format!(" | fixed: {}", s(&r["fixed"])); }
        if !s(&r["missed"]).is_empty() { line += &format!(" | missed: {}", s(&r["missed"])); }
        let e = groups.entry(key(&p)).or_insert_with(|| (p, vec![]));
        e.1.push(line);
    };
    for r in upstream(repo) { push("upstream", &r); }
    for r in db.all("select * from sim order by id", &[]) { push("local", &r); }
    if groups.is_empty() { return "(no SIM entries yet)".into(); }
    groups.into_values().enumerate().map(|(i, (p, attempts))| {
        format!("P{}: {p}\n{}", i + 1, attempts.join("\n"))
    }).collect::<Vec<_>>().join("\n")
}

/// Collect largest source files in the checkout to guide subtraction & simplification passes.
fn largest_files(repo: &Path, limit: usize) -> Vec<(usize, String)> {
    fn walk(root: &Path, dir: &Path, out: &mut Vec<(usize, String)>) {
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for e in entries.flatten() {
            let p = e.path();
            let name = e.file_name();
            let name = name.to_string_lossy();
            if name.starts_with('.') || matches!(name.as_ref(), "target" | "node_modules" | "build") { continue; }
            if p.is_dir() { walk(root, &p, out); continue; }
            if matches!(p.extension().and_then(|x| x.to_str()), Some("rs" | "js" | "swift")) {
                if let Ok(text) = std::fs::read_to_string(&p) {
                    let rel = p.strip_prefix(root).unwrap_or(&p).to_string_lossy().replace('\\', "/");
                    out.push((text.lines().count(), rel));
                }
            }
        }
    }
    let mut files = vec![];
    for sub in ["server/src", "desktop", "phone/src", "browser", "protocol/src"] {
        let d = repo.join(sub);
        if d.is_dir() { walk(repo, &d, &mut files); }
    }
    files.sort_by(|a, b| b.0.cmp(&a.0));
    files.truncate(limit);
    files
}

/// Summarize recent harness friction + raw failure traces + subtraction targets (dead tools, old-model ablations, rule bloat, largest files).
pub fn friction(db: &Db, repo: Option<&Path>, days: i64) -> String {
    let days = days.clamp(1, 90);
    let since = now() - days * 86_400_000;
    let since_30d = now() - 30 * 86_400_000;
    let mut out = format!("Friction & Subtraction Audit (last {days}d):\n");

    let needs = db.all("select t.id, t.title, t.why, a.kind, a.model, a.effort from tasks t left join agents a on a.id=t.agent_id \
        where t.status='needs' and t.updated>=? order by t.updated desc limit 15", args!(since));
    out += &format!("\nTasks needing owner ({}):\n", needs.len());
    for r in &needs {
        out += &format!("- #{} [{}/{}/{}] {}: {}\n", r["id"], s(&r["kind"]), s(&r["model"]), s(&r["effort"]), s(&r["title"]), hive_protocol::short(&s(&r["why"]), 180));
    }

    let gates = db.all("select a.kind, a.model, l.text, count(*) n from log l left join agents a on a.id=l.agent_id \
        where l.who='gate' and l.at>=? group by a.kind, a.model, l.text order by n desc limit 10", args!(since));
    out += &format!("\nCompletion/recheck gates fired ({}):\n", gates.len());
    for r in &gates { out += &format!("- {}x [{}/{}] {}\n", r["n"], s(&r["kind"]), s(&r["model"]), s(&r["text"])); }

    let fails = db.all("select a.kind, a.model, substr(l.text, 1, 140) msg, count(*) n from log l left join agents a on a.id=l.agent_id \
        where ((l.who='tool-item' and l.text like '%\"status\":\"failed\"%') or (l.who='tool' and l.text like '%failed:%')) and l.at>=? \
        group by a.kind, a.model, msg order by n desc limit 15", args!(since));
    out += &format!("\nRecurring tool failures ({}):\n", fails.len());
    for r in &fails { out += &format!("- {}x [{}/{}] {}\n", r["n"], s(&r["kind"]), s(&r["model"]), s(&r["msg"])); }

    let timeouts = db.all("select node, tool, count(*) n from calls where status='timeout' and at>=? group by node, tool order by n desc limit 10", args!(since));
    out += &format!("\nNode call timeouts ({}):\n", timeouts.len());
    for r in &timeouts { out += &format!("- {}x {} {}\n", r["n"], s(&r["node"]), s(&r["tool"])); }

    // Raw failure traces (Meta-Harness): show actual failing steps from the most recent stalled/dropped tasks.
    let bad_tasks = db.all("select id, title, status, why from tasks where status in ('needs','dropped') and updated>=? order by updated desc limit 5", args!(since));
    if !bad_tasks.is_empty() {
        out += "\nRaw failure traces (latest failed/needs tasks):\n";
        for t in &bad_tasks {
            let tid = t["id"].as_i64().unwrap_or(0);
            out += &format!("- Task #{tid} [{}] {}: {}\n", s(&t["status"]), s(&t["title"]), hive_protocol::short(&s(&t["why"]), 140));
            let mut trace = db.all("select who, text from log where task_id=? and (who in ('gate','hive','needs you') or (who='tool-item' and text like '%\"status\":\"failed\"%')) order by id desc limit 4", args!(tid));
            trace.reverse();
            for step in trace {
                out += &format!("    [{}] {}\n", s(&step["who"]), hive_protocol::short(&s(&step["text"]), 180));
            }
        }
    }

    // 30-day tool health: flag dead/low-value (<5 calls) and high-failure (>=25% timeout/error) device tools.
    let tool_stats = db.all("select tool, count(*) n, \
        sum(case when status='timeout' or coalesce(result,'') like '%\"error\":%' then 1 else 0 end) bad \
        from calls where at>=? group by tool order by n desc", args!(since_30d));
    if !tool_stats.is_empty() {
        out += "\nDevice tool health (30d; flag <5 calls or >=25% failure for deletion/consolidation):\n";
        for r in &tool_stats {
            let (n, bad) = (r["n"].as_i64().unwrap_or(0), r["bad"].as_i64().unwrap_or(0));
            let pct = if n > 0 { (bad * 100) / n } else { 0 };
            let flag = if n < 5 { " [LOW-USE]" } else if pct >= 25 { " [HIGH-FAIL]" } else { "" };
            if !flag.is_empty() || bad > 0 {
                out += &format!("- {}: {} calls, {} bad ({}%){flag}\n", s(&r["tool"]), n, bad, pct);
            }
        }
    }

    // Old-model SIM ablation candidates: active workarounds built for models no longer in active rotation.
    let current_models: Vec<&str> = crate::hive::LEVELS.iter().chain(crate::hive::CLAUDE_LEVELS.iter()).map(|l| l.1).collect();
    let ablations: Vec<Value> = upstream(repo).into_iter().chain(db.all("select * from sim where status='active'", &[])).filter(|r| {
        let m = s(&r["model"]);
        s(&r["status"]) == "active" && !m.is_empty() && !current_models.iter().any(|cm| *cm == m)
    }).collect();
    if !ablations.is_empty() {
        out += "\nOld-model SIM ablation candidates (test deleting if current models no longer need them):\n";
        for r in ablations.iter().take(10) {
            out += &format!("- [{}] {}: {}\n", s(&r["model"]), s(&r["problem"]), hive_protocol::short(&s(&r["what"]), 140));
        }
    }

    // Rule scope bloat: detect over-accumulated scopes.
    let scopes = db.all("select case when scope='' then 'global' when instr(scope,':')>0 then substr(scope,1,instr(scope,':')) else scope end prefix, \
        count(*) n from rules where active=1 group by prefix order by n desc", &[]);
    if !scopes.is_empty() {
        let summary: Vec<String> = scopes.iter().map(|r| format!("{}={}", s(&r["prefix"]), r["n"])).collect();
        out += &format!("\nActive rules by scope: {}\n", summary.join(", "));
    }

    // Largest source files in checkout for subtraction passes.
    if let Some(repo) = repo {
        let big = largest_files(repo, 6);
        if !big.is_empty() {
            out += "\nLargest source files (candidates for simplification/deletion):\n";
            for (lines, path) in big { out += &format!("- {lines} lines: {path}\n"); }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merges_root_causes_and_preserves_attempt_history() {
        let db = Db::open(":memory:");
        let a1 = propose(&db, None, "codex", "gpt-6.1-terra", "abc1234", &json!({
            "problem": "Premature Completion Or Stop Without Execution Verification",
            "what": "Log gate triggers to sqlite", "files": "server/src/hive.rs",
            "predicted": "gate triggers appear in friction summary"
        })).unwrap();
        assert_eq!(record_eval(&db, a1, false, 18, 20, 12, "abc1234"), Some(a1));
        outcome(&db, a1, "", "missed claude bash errors", "missed").unwrap();
        let a2 = propose(&db, None, "claude", "claude-opus-5-5", "def5678", &json!({
            "problem": "premature completion or stop without execution verification",
            "what": "Inspect is_error on Claude Bash results", "files": "server/src/claude.rs",
            "predicted": "claude bash failures trigger gate"
        })).unwrap();
        assert_eq!(record_eval(&db, a2, true, 20, 20, -25, "def5678"), Some(a2));
        outcome(&db, a2, "claude bash failures trigger gate", "", "active").unwrap();

        let text = format(&db, None);
        assert_eq!(text.matches("premature completion or stop without execution verification").count(), 1);
        assert!(text.contains("[upstream]"));
        assert!(text.contains("[local] #1 [codex/gpt-6.1-terra] missed (18/20) [+12 LOC]"));
        assert!(text.contains("[local] #2 [claude/claude-opus-5-5] active (20/20) [-25 LOC]"));
        let exported: Value = serde_json::from_str(&export_line(&db, a2).unwrap()).unwrap();
        assert_eq!((exported["model"].as_str(), exported["passed"].as_i64(), exported["net_loc"].as_i64()),
            (Some("claude-opus-5-5"), Some(20), Some(-25)));
    }

    #[test]
    fn friction_report_includes_traces_tool_health_ablations_and_rule_bloat() {
        let db = Db::open(":memory:");
        let agent = db.run("insert into agents(task_id, kind, name, model, effort, at, updated) values(1, 'codex', 't', 'gpt-6.1-terra', 'low', ?, ?)", args!(now(), now()));
        let tid = db.run("insert into tasks(title, status, agent_id, why, at, updated) values('Check site', 'needs', ?, 'browser timed out', ?, ?)", args!(agent, now(), now()));
        db.run("insert into log(at, agent_id, task_id, request_id, who, text) values(?, ?, ?, 0, 'gate', 'done:true unrecovered failure')", args!(now(), agent, tid));
        db.run("insert into log(at, agent_id, task_id, request_id, who, text) values(?, ?, ?, 0, 'tool-item', '{\"type\":\"mcpToolCall\",\"tool\":\"browser_open\",\"status\":\"failed\",\"output\":\"timeout\"}')", args!(now(), agent, tid));
        db.run("insert into calls(node, tool, args, status, result, agent_id, at) values('browser-1', 'browser_open', '{}', 'timeout', '', ?, ?)", args!(agent, now()));
        db.run("insert into rules(text, quote, scope, at) values('r1','q1','folder:/a',?),('r2','q2','',?)", args!(now(), now()));
        db.run("insert into sim(problem, what, engine, model, status, at) values('legacy prompt quirk', 'retry regex', 'codex', 'gpt-4o-legacy', 'active', ?)", args!(now()));
        let report = friction(&db, None, 7);
        assert!(report.contains("gpt-6.1-terra") && report.contains("done:true unrecovered failure"));
        assert!(report.contains("Raw failure traces") && report.contains("browser_open"));
        assert!(report.contains("[LOW-USE]") && report.contains("gpt-4o-legacy") && report.contains("folder:=1"));
    }
}
