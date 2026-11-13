//! The task recordings: `~/Movies/Hive/<folder>/timeline.jsonl` (`t` local time, `video` seconds
//! into screen.mov, `kind` hive / control / status / mac / recording). The same reading the
//! 2026-11-13 review of the recordings did: takeovers, waits for the screen, failed
//! calls, repeats, endings, and the agent clicking the x on Hive's own floating window.

use regex::Regex;
use serde_json::Value;
use std::path::Path;
use std::sync::LazyLock;

use crate::evidence::{Occurrence, Source};
use crate::journal::{error_signature, MAX_CALL_MINUTES, MAX_TASK_MINUTES, TAKEOVER, WAIT};
use crate::normalize::{
    agent_brief, call_text, error_category, ignorable_call, regression_words, tool_name,
    unfinished_class,
};
use crate::time;

struct Event {
    t: f64,
    video: Option<f64>,
    kind: String,
    text: String,
}

#[derive(Default)]
pub struct TimelineScan {
    pub occurrences: Vec<Occurrence>,
    /// A scripted test-suite run (a fake model answering "Open Safari."), left out.
    pub test_run: bool,
}

static TEST_PHRASES: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"^(Open Safari\.?|Open [Cc]alculator.*|What time is it\??|Wait, open Safari instead\.?|Open the browser and search for.*|Open Safari\. Then search.*|Hello there.*|Dear team.*|typed twelve.*|Stop\.|Continue\.|Open [Mm]aps on my phone\.|And look up the weather in Paris\.)$",
    )
    .expect("test phrases")
});

static TAKEN_BACK: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"control went back to you \((keyboard|trackpad|mouse|engage_cancelled_by_\w+)\)")
        .expect("taken back")
});

fn parse(text: &str) -> Vec<Event> {
    text.lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .filter_map(|v| {
            let t = time::parse_stamp(v.get("t")?.as_str()?)?;
            Some(Event {
                t,
                video: v.get("video").and_then(Value::as_f64),
                kind: v.get("kind")?.as_str()?.to_string(),
                text: v
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
            })
        })
        .collect()
}

pub fn scan(folder: &str, timeline: &Path, since: f64, until: f64) -> TimelineScan {
    let text = std::fs::read_to_string(timeline).unwrap_or_default();
    scan_text(folder, &text, since, until)
}

/// The folder's name starts with its local start time: "2026-11-13 04.11.44 <task>". References
/// use only that part (the rest is the task's words).
pub fn folder_stamp(folder: &str) -> &str {
    folder.get(..19).unwrap_or(folder)
}

pub fn scan_text(folder: &str, text: &str, since: f64, until: f64) -> TimelineScan {
    let ev = parse(text);
    let mut out = TimelineScan::default();
    if ev.is_empty() {
        return out;
    }
    let hive: Vec<&Event> = ev.iter().filter(|e| e.kind == "hive").collect();
    let requests: Vec<&str> = hive
        .iter()
        .filter_map(|e| e.text.strip_prefix("🗣"))
        .map(str::trim)
        .collect();
    out.test_run = hive.iter().any(|e| e.text.contains("Ctrl-C to quit"))
        && requests.iter().all(|r| TEST_PHRASES.is_match(r));
    if out.test_run {
        return out;
    }
    let start = ev
        .iter()
        .find(|e| e.kind == "recording" && e.text == "started")
        .map_or(ev[0].t, |e| e.t);
    let end = ev.iter().map(|e| e.t).fold(f64::NEG_INFINITY, f64::max);
    let stamp = folder_stamp(folder);
    let r = |e: &Event| {
        let secs = e.video.unwrap_or(e.t - start);
        format!("recording {stamp}@{secs:.1}s")
    };

    let mut occ: Vec<Occurrence> = Vec::new();
    let mut request_t: Option<f64> = None;
    // The user took the mouse and keyboard while a task was running: (since, ref, event times).
    let mut take: Option<(f64, String, Vec<f64>, String)> = None;
    let mut wait: Option<(f64, String, String)> = None;
    let mut last_call: Option<(f64, String)> = None;
    let mut agent_has = false;
    let mut run: Option<(String, Vec<(f64, String)>)> = None;

    let finish_take = |take: &mut Option<(f64, String, Vec<f64>, String)>,
                       occ: &mut Vec<Occurrence>,
                       at: f64,
                       how: &str| {
        if let Some((t0, reference, times, what)) = take.take() {
            let mut o = Occurrence::new("takeover", TAKEOVER, t0, Source::Recording, reference)
                .minutes((at - t0) / 60.0)
                .example(&format!("{what}; {how}"));
            o.times.extend(times);
            occ.push(o);
        }
    };
    let finish_wait = |wait: &mut Option<(f64, String, String)>,
                       occ: &mut Vec<Occurrence>,
                       at: f64,
                       how: &str| {
        if let Some((t0, reference, call)) = wait.take() {
            let mut o = Occurrence::new("wait_for_control", WAIT, t0, Source::Recording, reference)
                .minutes(((at - t0) / 60.0).min(MAX_CALL_MINUTES))
                .example(&format!("{call}{how}"));
            o.times.push(at);
            occ.push(o);
        }
    };
    let finish_run =
        |run: &mut Option<(String, Vec<(f64, String)>)>, occ: &mut Vec<Occurrence>, at: f64| {
            if let Some((call, hits)) = run.take() {
                if hits.len() >= 3 {
                    let (t0, reference) = hits[0].clone();
                    occ.push(
                        Occurrence::new(
                            "repeat_calls",
                            &format!("{} called 3 or more times in a row", tool_name(&call)),
                            t0,
                            Source::Recording,
                            reference,
                        )
                        .minutes(((at - t0) / 60.0).min(MAX_CALL_MINUTES))
                        .example(&format!("{call} x{}", hits.len())),
                    );
                }
            }
        };

    for (i, e) in ev.iter().enumerate() {
        match e.kind.as_str() {
            "control" => {
                if let Some(c) = TAKEN_BACK.captures(&e.text) {
                    if request_t.is_some() && take.is_none() {
                        take = Some((
                            e.t,
                            r(e),
                            Vec::new(),
                            format!("control went back ({})", &c[1]),
                        ));
                    }
                    agent_has = false;
                } else if e.text.starts_with("agent has") {
                    finish_take(&mut take, &mut occ, e.t, "handed back");
                    finish_wait(&mut wait, &mut occ, e.t, "");
                    agent_has = true;
                } else if e.text.starts_with("control went back") {
                    agent_has = false;
                }
            }
            "hive" => {
                let t = e.text.as_str();
                if let Some(request) = t.strip_prefix("🗣") {
                    finish_wait(&mut wait, &mut occ, e.t, "");
                    finish_run(&mut run, &mut occ, e.t);
                    request_t = Some(e.t);
                    if !agent_brief(request) {
                        if let Some(word) = regression_words(request) {
                            occ.push(
                                Occurrence::new(
                                    "regression_words",
                                    &format!("the user said \"{word}\""),
                                    e.t,
                                    Source::Recording,
                                    r(e),
                                )
                                .example(request.trim()),
                            );
                        }
                    }
                } else if t.starts_with('→') {
                    finish_wait(&mut wait, &mut occ, e.t, "");
                    if ignorable_call(t) {
                        finish_run(&mut run, &mut occ, e.t);
                        continue;
                    }
                    let call = call_text(t);
                    if call.starts_with("wait_for_control") {
                        wait = Some((e.t, r(e), call.clone()));
                    }
                    match run.as_mut() {
                        Some((c, hits)) if *c == call => hits.push((e.t, r(e))),
                        _ => {
                            finish_run(&mut run, &mut occ, e.t);
                            run = Some((call.clone(), vec![(e.t, r(e))]));
                        }
                    }
                    last_call = Some((e.t, call));
                } else if let Some(msg) = t.strip_prefix('✗') {
                    let msg = msg.trim();
                    let category = error_category(msg);
                    if category == "wait_for_control" && wait.is_some() {
                        finish_wait(&mut wait, &mut occ, e.t, &format!(" -> {msg}"));
                        continue;
                    }
                    finish_wait(&mut wait, &mut occ, e.t, "");
                    if category == "takeover" {
                        if let Some((_, _, times, _)) = take.as_mut() {
                            times.push(e.t);
                            continue;
                        }
                    }
                    let (_, text) = error_signature(msg);
                    let minutes = match (&last_call, category) {
                        (_, "takeover") => 0.0,
                        (Some((t0, _)), _) => ((e.t - t0) / 60.0).clamp(0.0, MAX_CALL_MINUTES),
                        _ => 0.0,
                    };
                    if text.chars().count() >= 4 {
                        occ.push(
                            Occurrence::new(category, &text, e.t, Source::Recording, r(e))
                                .minutes(minutes)
                                .example(msg),
                        );
                    }
                } else if t.starts_with('✅') || t.starts_with('✋') || t.starts_with('❌') {
                    finish_wait(&mut wait, &mut occ, e.t, "");
                    finish_run(&mut run, &mut occ, e.t);
                    finish_take(&mut take, &mut occ, e.t, "the task ended");
                    let minutes = request_t
                        .map_or(0.0, |r0| ((e.t - r0) / 60.0).clamp(0.0, MAX_TASK_MINUTES));
                    request_t = None;
                    if t.starts_with('✅') {
                        continue;
                    }
                    let o = if t.starts_with("✋ stopped from the window's x") {
                        // The agent's own click, if one landed just before while it had control.
                        let own = agent_has
                            && ev[..i].iter().rev().any(|x| {
                                x.kind == "hive"
                                    && e.t - x.t < 5.0
                                    && x.text.starts_with('→')
                                    && (x.text.contains("click")
                                        || x.text.contains("batch")
                                        || x.text.contains("drag"))
                            });
                        if own {
                            Occurrence::new(
                                "self_stop_x",
                                "the agent clicked the x on Hive's own floating window and stopped its task",
                                e.t,
                                Source::Recording,
                                r(e),
                            )
                            .example(&last_call.as_ref().map_or(String::new(), |(_, c)| {
                                format!("last call before the stop: {c}")
                            }))
                        } else {
                            Occurrence::new(
                                "interrupted",
                                "stopped by the user from the floating window's x",
                                e.t,
                                Source::Recording,
                                r(e),
                            )
                        }
                    } else {
                        let body = t.trim_start_matches(['✋', '❌']).trim();
                        Occurrence::new(
                            "unfinished",
                            unfinished_class(body),
                            e.t,
                            Source::Recording,
                            r(e),
                        )
                        .example(t)
                    };
                    occ.push(o.minutes(minutes).outcome());
                } else if wait.is_some() && !t.starts_with('⏸') {
                    finish_wait(&mut wait, &mut occ, e.t, "");
                }
            }
            _ => {}
        }
    }
    finish_take(&mut take, &mut occ, end, "the recording ended");
    finish_wait(&mut wait, &mut occ, end, "");
    finish_run(&mut run, &mut occ, end);
    out.occurrences = occ
        .into_iter()
        .filter(|o| o.t >= since && o.t <= until)
        .collect();
    out
}
