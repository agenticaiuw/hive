//! What an agent spent on a stretch of work, read from its session's transcript: Claude Code's
//! `~/.claude/projects/<project>/<session>.jsonl` or Codex's `rollout-….jsonl` (the path each
//! session's hooks hand over, kept in the `scans` table).
//!
//! - Busy time: the stretch's wall time less every gap over [`IDLE_GAP`] between transcript lines,
//!   so a session left waiting overnight doesn't count as work.
//! - Tokens: Claude Code writes each reply's usage on every line of that reply (counted once per
//!   reply id; `usage.iterations` when it's there, else the top-level counts); Codex writes running
//!   totals (`token_count` events), so the stretch's tokens are the last total minus the total
//!   before it began. "In" counts everything the model read (cached reads too), "out" what it wrote.

use crate::parse_iso_utc;
use serde_json::Value;
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::Path;

/// A gap this long between transcript lines is the agent waiting, not working.
pub const IDLE_GAP: i64 = 30 * 60;

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Spent {
    pub busy_seconds: i64,
    pub tokens_in: i64,
    pub tokens_out: i64,
}

/// The time on a transcript line, read without parsing the whole line.
fn line_time(line: &str) -> Option<i64> {
    let at = line.find("\"timestamp\":\"")? + 13;
    parse_iso_utc(line.get(at..at + 19)?)
}

fn n(v: &Value, key: &str) -> i64 {
    v.get(key).and_then(Value::as_i64).unwrap_or(0)
}

/// Claude Code's usage for one reply: (in, out).
fn claude_usage(usage: &Value) -> (i64, i64) {
    let one = |u: &Value| {
        (
            n(u, "input_tokens")
                + n(u, "cache_creation_input_tokens")
                + n(u, "cache_read_input_tokens"),
            n(u, "output_tokens"),
        )
    };
    match usage.get("iterations").and_then(Value::as_array) {
        Some(list) if !list.is_empty() => list
            .iter()
            .map(one)
            .fold((0, 0), |a, b| (a.0 + b.0, a.1 + b.1)),
        _ => one(usage),
    }
}

/// What the agent spent between `from` and `to` (seconds since the epoch), or None when there's
/// no transcript to read.
pub fn spent(path: &Path, from: i64, to: i64) -> Option<Spent> {
    let file = std::fs::File::open(path).ok()?;
    let mut times = vec![from];
    let mut replies: HashMap<String, (i64, i64)> = HashMap::new();
    let mut loose = (0, 0);
    // Codex's running totals: the last one before the stretch and the last one in it.
    let mut before: Option<(i64, i64)> = None;
    let mut last: Option<(i64, i64)> = None;
    for line in BufReader::new(file).lines() {
        let Ok(line) = line else { continue };
        let Some(at) = line_time(&line) else { continue };
        if at > to {
            break;
        }
        let codex = line.contains("\"token_count\"");
        if at < from && !codex {
            continue;
        }
        if at >= from {
            times.push(at);
        }
        if !codex && !line.contains("\"usage\"") {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if codex {
            let Some(total) = v.pointer("/payload/info/total_token_usage") else {
                continue;
            };
            let t = (n(total, "input_tokens"), n(total, "output_tokens"));
            if at < from {
                before = Some(t);
            } else {
                last = Some(t);
            }
        } else if let Some(usage) = v.pointer("/message/usage") {
            let u = claude_usage(usage);
            match v.pointer("/message/id").and_then(Value::as_str) {
                Some(id) => {
                    replies.insert(id.to_string(), u);
                }
                None => loose = (loose.0 + u.0, loose.1 + u.1),
            }
        }
    }
    times.push(to);
    let busy_seconds = times
        .windows(2)
        .map(|w| (w[1] - w[0]).max(0))
        .filter(|gap| *gap <= IDLE_GAP)
        .sum();
    let (mut tokens_in, mut tokens_out) =
        replies.values().fold(loose, |a, b| (a.0 + b.0, a.1 + b.1));
    if let Some(end) = last {
        let start = before.unwrap_or((0, 0));
        tokens_in += (end.0 - start.0).max(0);
        tokens_out += (end.1 - start.1).max(0);
    }
    Some(Spent {
        busy_seconds,
        tokens_in,
        tokens_out,
    })
}
