//! The session journals: `<state>/sessions/<session>/journal.jsonl`, one JSON event per line
//! (`time` in epoch seconds, `kind`, `text`, `request`, `interrupted`). The same parsing the
//! 2026-11-13 review of the journals did by hand.

use serde_json::Value;
use std::collections::HashMap;
use std::path::Path;

use crate::evidence::{Occurrence, Source};
use crate::normalize::{
    agent_brief, call_text, correction_words, error_category, ignorable_call, regression_words,
    signature_text, tool_name, unfinished_class,
};

/// A wait or a failing call that takes longer than this is something else (the app was asleep).
pub const MAX_CALL_MINUTES: f64 = 15.0;
/// A task's ending counts at most this much lost time.
pub const MAX_TASK_MINUTES: f64 = 60.0;
/// A task that finished after more than this many minutes was slow; the minutes past it count.
pub const SLOW_TASK_MINUTES: f64 = 10.0;

/// What one journal gave: its occurrences, its starts (for restart storms) and the times of
/// settings changes made from Hive's own menu or card (for "changed without a request").
#[derive(Default)]
pub struct JournalScan {
    pub occurrences: Vec<Occurrence>,
    pub starts: Vec<(f64, String)>,
    pub settings_events: Vec<(String, f64)>,
    /// Every request's time and words (for "a setting changed without a request").
    pub requests: Vec<(f64, String)>,
    pub events: usize,
}

/// Identical consecutive calls in one request: (request, call, [(t, line)]).
type Run = (String, String, Vec<(f64, usize)>);

struct Event {
    line: usize,
    t: f64,
    kind: String,
    text: String,
    request: String,
    interrupted: bool,
}

fn parse(text: &str) -> Vec<Event> {
    let mut out = Vec::new();
    for (i, line) in text.lines().enumerate() {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let s = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").to_string();
        let Some(t) = v.get("time").and_then(Value::as_f64) else {
            continue;
        };
        out.push(Event {
            line: i + 1,
            t,
            kind: s("kind"),
            text: s("text"),
            request: s("request"),
            interrupted: v
                .get("interrupted")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        });
    }
    out
}

/// Settings files and the journal kind Hive records when the user changes them from its menu.
pub const SETTINGS_KINDS: &[(&str, &str)] = &[
    ("floating-window", "floating window"),
    ("speak-aloud", "speak aloud"),
    ("input-mode", "input"),
];

/// Reads one session's journal; occurrences outside `since..=until` are left out.
pub fn scan(session: &str, journal: &Path, since: f64, until: f64) -> JournalScan {
    let text = std::fs::read_to_string(journal).unwrap_or_default();
    scan_text(session, &text, since, until)
}

pub fn scan_text(session: &str, text: &str, since: f64, until: f64) -> JournalScan {
    let events = parse(text);
    let mut out = JournalScan {
        events: events.len(),
        ..Default::default()
    };
    let in_window = |t: f64| t >= since && t <= until;
    let r = |line: usize| format!("journal {session}:{line}");
    let mut request_start: HashMap<String, f64> = HashMap::new();
    let mut last_action: Option<(f64, String)> = None;
    // A wait_for_control call, until the next event says how it ended.
    let mut wait: Option<(f64, usize, String)> = None;
    // Identical consecutive calls in one request: (request, call, [(t, line)]).
    let mut run: Option<Run> = None;
    let mut occ: Vec<Occurrence> = Vec::new();

    let flush_run = |run: &mut Option<Run>, occ: &mut Vec<Occurrence>, end: f64| {
        if let Some((_, call, hits)) = run.take() {
            if hits.len() >= 3 {
                let (t0, l0) = hits[0];
                let name = tool_name(&call);
                occ.push(
                    Occurrence::new(
                        "repeat_calls",
                        &format!("{name} called 3 or more times in a row"),
                        t0,
                        Source::Journal,
                        r(l0),
                    )
                    .minutes(((end - t0) / 60.0).min(MAX_CALL_MINUTES))
                    .example(&format!("{} x{}", call, hits.len())),
                );
            }
        }
    };

    for (i, e) in events.iter().enumerate() {
        // A wait ends at the next event of any kind.
        if let Some((t0, line, call)) = wait.take() {
            let timed_out = e.kind == "error" && error_category(&e.text) == "wait_for_control";
            let mut o = Occurrence::new("wait_for_control", WAIT, t0, Source::Journal, r(line))
                .minutes(((e.t - t0) / 60.0).min(MAX_CALL_MINUTES))
                .example(&if timed_out {
                    format!("{call} -> {}", e.text)
                } else {
                    call.clone()
                });
            if timed_out {
                o.times.push(e.t);
                o.refs.push(r(e.line));
            }
            occ.push(o);
            if timed_out {
                continue;
            }
        }
        match e.kind.as_str() {
            "session started" => out.starts.push((e.t, r(e.line))),
            "request" => {
                request_start.insert(e.text.clone(), e.t);
                out.requests.push((e.t, e.text.clone()));
                if !agent_brief(&e.text) {
                    let said = regression_words(&e.text)
                        .map(|w| ("regression_words", w))
                        .or_else(|| correction_words(&e.text).map(|w| ("correction", w)));
                    if let Some((category, word)) = said {
                        occ.push(
                            Occurrence::new(
                                category,
                                &format!("the user said \"{word}\""),
                                e.t,
                                Source::Journal,
                                r(e.line),
                            )
                            .example(&e.text),
                        );
                    }
                }
            }
            "action" => {
                let call = call_text(&e.text);
                if e.text.trim_start().starts_with("wait_for_control") {
                    wait = Some((e.t, e.line, call.clone()));
                }
                if ignorable_call(&e.text) {
                    flush_run(&mut run, &mut occ, e.t);
                } else {
                    let same = run
                        .as_ref()
                        .is_some_and(|(req, c, _)| *req == e.request && *c == call);
                    if same {
                        if let Some((_, _, hits)) = run.as_mut() {
                            hits.push((e.t, e.line));
                        }
                    } else {
                        flush_run(&mut run, &mut occ, e.t);
                        run = Some((e.request.clone(), call, vec![(e.t, e.line)]));
                    }
                }
                last_action = Some((e.t, e.request.clone()));
            }
            "error" => {
                let category = error_category(&e.text);
                let minutes = match (&last_action, category) {
                    (_, "takeover") => 0.0,
                    (Some((t0, req)), _) if *req == e.request => {
                        ((e.t - t0) / 60.0).clamp(0.0, MAX_CALL_MINUTES)
                    }
                    _ => 0.0,
                };
                let (_, text) = error_signature(&e.text);
                if text.chars().count() >= 4 && e.text.trim() != "failed" {
                    occ.push(
                        Occurrence::new(category, &text, e.t, Source::Journal, r(e.line))
                            .minutes(minutes)
                            .example(&e.text),
                    );
                }
            }
            "failed" => {
                flush_run(&mut run, &mut occ, e.t);
                let started = request_start.get(&e.request).copied().unwrap_or(e.t);
                let minutes = ((e.t - started) / 60.0).clamp(0.0, MAX_TASK_MINUTES);
                let o = if e.interrupted {
                    let before: Vec<&str> = events[i.saturating_sub(4)..i]
                        .iter()
                        .map(|x| x.kind.as_str())
                        .collect();
                    let why = if before.contains(&"stopped by fn") {
                        "stopped by the user (fn or the floating window's x)"
                    } else if before.contains(&"you said") || before.contains(&"request") {
                        "replaced by something the user said"
                    } else {
                        "interrupted"
                    };
                    Occurrence::new("interrupted", why, e.t, Source::Journal, r(e.line))
                } else {
                    let class = unfinished_class(&e.text);
                    Occurrence::new("unfinished", class, e.t, Source::Journal, r(e.line))
                };
                occ.push(o.minutes(minutes).example(&e.text).outcome());
            }
            "done" => {
                flush_run(&mut run, &mut occ, e.t);
                let took = request_start
                    .get(&e.request)
                    .map_or(0.0, |started| (e.t - started) / 60.0);
                if took > SLOW_TASK_MINUTES {
                    let past = (took - SLOW_TASK_MINUTES).min(MAX_TASK_MINUTES);
                    let slow = format!("a task took more than {SLOW_TASK_MINUTES:.0} minutes");
                    occ.push(
                        Occurrence::new("slow_task", &slow, e.t, Source::Journal, r(e.line))
                            .minutes(past)
                            .example(&format!("{took:.0} min: {}", e.request)),
                    );
                }
            }
            kind => {
                if let Some((name, _)) = SETTINGS_KINDS.iter().find(|(_, k)| *k == kind) {
                    out.settings_events.push((name.to_string(), e.t));
                }
            }
        }
    }
    if let Some((t0, line, call)) = wait.take() {
        let end = events.last().map_or(t0, |e| e.t);
        occ.push(
            Occurrence::new("wait_for_control", WAIT, t0, Source::Journal, r(line))
                .minutes(((end - t0) / 60.0).min(MAX_CALL_MINUTES))
                .example(&call),
        );
    }
    let end = events.last().map_or(0.0, |e| e.t);
    flush_run(&mut run, &mut occ, end);
    out.occurrences = occ.into_iter().filter(|o| in_window(o.t)).collect();
    out
}

/// One signature for every way Hive says the user has the mouse and keyboard.
pub const TAKEOVER: &str = "the user had the mouse and keyboard while a task needed the screen";
/// One signature for every wait for the user to hand the screen back, and its timeouts.
pub const WAIT: &str = "the agent waited for the user to hand back the mouse and keyboard";

/// The category and signature text of an error Hive gave a tool call.
pub fn error_signature(message: &str) -> (&'static str, String) {
    let category = error_category(message);
    let text = match category {
        "wait_for_control" => WAIT.to_string(),
        "takeover" => TAKEOVER.to_string(),
        _ => signature_text(message),
    };
    (category, text)
}
