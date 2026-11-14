//! ~/Library/Logs/Agent.log. Its lines carry no time; only the `--- started <UTC>` and `--- quit`
//! markers do, so a line counts as seen at its block's start (or the window's start, for the block
//! that was already running). Only machine lines count: warnings, sidecar and upload failures,
//! panics. The ✗ lines are the same tool errors the journals and recordings have.

use regex::Regex;
use std::collections::HashMap;
use std::sync::LazyLock;

use crate::evidence::{Occurrence, Source};
use crate::normalize::signature_text;
use crate::time;

#[derive(Default)]
pub struct LogScan {
    pub occurrences: Vec<Occurrence>,
    /// `✗` lines: kept apart, counted only when no journal or recording saw the same signature.
    pub tool_lines: Vec<Occurrence>,
    pub starts: Vec<(f64, String)>,
    pub lines: usize,
}

static MARKER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^--- (started|quit[^0-9]*?) (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{4})\s*$")
        .expect("marker")
});

static MACHINE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"^(?:warning:|Warning:|error:|Error:|thread '.*' panicked|Traceback \(most recent call last\)|\[engine-mcp\] tool \S+ failed|🎞\s+Recording .* failed|Voice input unavailable|Virtual workspace unavailable|agent-vhid-helper isn't running|the voice sidecar stopped)",
    )
    .expect("machine line")
});

/// `end`: when the log was last written (its mtime), for the last block.
pub fn scan_text(text: &str, since: f64, until: f64, end: f64) -> LogScan {
    let mut out = LogScan::default();
    let lines: Vec<&str> = text.lines().collect();
    out.lines = lines.len();
    // Block starts: (line index, time).
    let mut blocks: Vec<(usize, f64)> = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        if let Some(c) = MARKER.captures(line) {
            let Some(t) = time::parse_stamp(&c[2]) else {
                continue;
            };
            let reference = format!("Agent.log:{}", i + 1);
            if &c[1] == "started" {
                blocks.push((i, t));
                out.starts.push((t, reference));
            } else if t >= since && t <= until {
                out.occurrences.push(
                    Occurrence::new(
                        "restart_storm",
                        "Hive quit, not from its menu (macOS or another app asked)",
                        t,
                        Source::AgentLog,
                        reference,
                    )
                    .example(line),
                );
            }
        }
    }
    for (b, &(first, start)) in blocks.iter().enumerate() {
        let (last, stop) = blocks
            .get(b + 1)
            .map_or((lines.len(), end), |&(next, t)| (next, t));
        if stop < since || start > until {
            continue;
        }
        let at = start.max(since);
        // One occurrence per signature per block (a retry loop can print the same line
        // thousands of times); the example says how many lines.
        let mut seen: HashMap<String, (bool, usize, usize)> = HashMap::new();
        for (i, line) in lines.iter().enumerate().take(last).skip(first + 1) {
            let line = line.trim();
            let reference = format!("Agent.log:{}", i + 1);
            let (tool, o) = if let Some(msg) = line.strip_prefix('✗') {
                let msg = msg.trim();
                let (category, text) = crate::journal::error_signature(msg);
                (
                    true,
                    Occurrence::new(category, &text, at, Source::AgentLog, reference).example(msg),
                )
            } else if MACHINE.is_match(line) {
                (
                    false,
                    Occurrence::new(
                        "log_error",
                        &signature_text(line),
                        at,
                        Source::AgentLog,
                        reference,
                    )
                    .example(line),
                )
            } else {
                continue;
            };
            if let Some((_, _, n)) = seen.get_mut(&o.signature) {
                *n += 1;
                continue;
            }
            let list = if tool {
                &mut out.tool_lines
            } else {
                &mut out.occurrences
            };
            seen.insert(o.signature.clone(), (tool, list.len(), 1));
            list.push(o);
        }
        for (tool, index, n) in seen.into_values() {
            if n > 1 {
                let list = if tool {
                    &mut out.tool_lines
                } else {
                    &mut out.occurrences
                };
                let o = &mut list[index];
                o.example = format!("{} ({n} lines)", o.example);
            }
        }
    }
    out
}
