//! `hive-dream collect`: reads the journals, the recordings and Agent.log since the last run (no
//! model), turns every failure into a normalised signature, merges what two sources saw at the
//! same moment, clusters, and writes `<dream>/<date>/evidence.json` and the register.

use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
use std::path::Path;

use crate::evidence::{self, Counts, Evidence, Occurrence, Source};
use crate::register::Register;
use crate::{agentlog, journal, paths, time, timeline};

/// A first run (no register yet) reads this far back; later runs read from the last run, and at
/// least this far (overlap is harmless: the register counts each occurrence once).
pub const DEFAULT_HOURS: f64 = 24.0;
/// The most a default run reads back.
pub const MAX_DEFAULT_HOURS: f64 = 7.0 * 24.0;
/// Starts closer together than this are one start seen twice (journal and Agent.log).
const SAME_START_SECS: f64 = 5.0;
/// Starts with gaps shorter than this are one chain; three or more in a chain is a storm.
pub const STORM_GAP_SECS: f64 = 300.0;
pub const STORM_MIN_STARTS: usize = 3;
/// A menu event this close to a settings file's change explains it.
pub const MENU_SECS: f64 = 10.0;
/// A request this long before a settings file's change, mentioning it, explains it.
pub const REQUEST_SECS: f64 = 30.0 * 60.0;

/// Settings files in the state folder: (file, journal kind Hive writes when its menu changes it,
/// words a request would use to ask for the change).
pub const SETTINGS: &[(&str, Option<&str>, &str)] = &[
    (
        "work-screen",
        None,
        r"(?i)\b(screen|monitor|display|workspace|virtual)\b",
    ),
    (
        "floating-window",
        Some("floating window"),
        r"(?i)\b(floating|window|card|panel)\b",
    ),
    (
        "speak-aloud",
        Some("speak aloud"),
        r"(?i)\b(speak|aloud|voice|talk)\b",
    ),
    (
        "input-mode",
        Some("input"),
        r"(?i)\b(voice|typ\w*|input|keyboard)\b",
    ),
    (
        "browser-preference",
        None,
        r"(?i)\b(browser|safari|chrome|firefox|arc)\b",
    ),
];

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct SettingSnap {
    pub value: String,
    pub mtime: f64,
}

pub type Snapshot = BTreeMap<String, SettingSnap>;

/// Whether one settings file changed in the window with nothing to explain it: no menu event
/// near the change and no request before it that mentions it. A file whose value and time match
/// the last snapshot didn't change.
pub fn settings_check(
    name: &str,
    current: Option<&SettingSnap>,
    previous: Option<&SettingSnap>,
    menu_times: &[f64],
    requests: &[(f64, String)],
    since: f64,
    until: f64,
) -> Option<Occurrence> {
    let (_, kind, words) = SETTINGS.iter().find(|(n, _, _)| *n == name)?;
    let cur = current?;
    if cur.mtime < since || cur.mtime > until {
        return None;
    }
    if previous == Some(cur) {
        return None;
    }
    if kind.is_some()
        && menu_times
            .iter()
            .any(|t| (t - cur.mtime).abs() <= MENU_SECS)
    {
        return None;
    }
    let words = Regex::new(words).ok()?;
    if requests.iter().any(|(t, text)| {
        *t <= cur.mtime + MENU_SECS && cur.mtime - t <= REQUEST_SECS && words.is_match(text)
    }) {
        return None;
    }
    let was = previous.map_or_else(|| "unknown".to_string(), |p| p.value.clone());
    Some(
        Occurrence::new(
            "settings_changed",
            &format!("{name} changed with no menu action or request recorded"),
            cur.mtime,
            Source::Settings,
            format!("setting {name}@{}", time::iso(cur.mtime)),
        )
        .example(&format!("{name}: {was} -> {}", cur.value)),
    )
}

/// Restart storms: starts (deduplicated) in chains with gaps under [`STORM_GAP_SECS`]; a chain of
/// [`STORM_MIN_STARTS`] or more is one occurrence lasting from its first start to its last.
pub fn restart_storms(mut starts: Vec<(f64, String)>, since: f64, until: f64) -> Vec<Occurrence> {
    starts.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut unique: Vec<(f64, Vec<String>)> = Vec::new();
    for (t, r) in starts {
        match unique.last_mut() {
            Some((last, refs)) if t - *last <= SAME_START_SECS => refs.push(r),
            _ => unique.push((t, vec![r])),
        }
    }
    let mut out = Vec::new();
    let mut chain: Vec<(f64, Vec<String>)> = Vec::new();
    let flush = |chain: &mut Vec<(f64, Vec<String>)>, out: &mut Vec<Occurrence>| {
        if chain.len() >= STORM_MIN_STARTS {
            let t0 = chain[0].0;
            let t1 = chain[chain.len() - 1].0;
            let mut o = Occurrence::new(
                "restart_storm",
                &format!(
                    "Hive started {STORM_MIN_STARTS} or more times with under {} minutes between starts",
                    STORM_GAP_SECS / 60.0
                ),
                t0,
                Source::AgentLog,
                chain[0].1[0].clone(),
            )
            // How long each restart cost isn't in the logs: no minutes are claimed.
            .example(&format!("{} starts in {:.1} minutes", chain.len(), (t1 - t0) / 60.0));
            o.times = chain.iter().map(|(t, _)| *t).collect();
            o.refs = chain
                .iter()
                .flat_map(|(_, r)| r.iter().cloned())
                .take(12)
                .collect();
            if t0 >= since && t0 <= until {
                out.push(o);
            }
        }
        chain.clear();
    };
    for start in unique {
        if chain
            .last()
            .is_some_and(|(t, _)| start.0 - t > STORM_GAP_SECS)
        {
            flush(&mut chain, &mut out);
        }
        chain.push(start);
    }
    flush(&mut chain, &mut out);
    out
}

pub struct Options {
    pub since_hours: Option<f64>,
    /// Write `<dream>/settings-snapshot.json` (off in dry runs).
    pub write: bool,
}

pub struct Collected {
    pub evidence: Evidence,
    pub date: String,
    pub evidence_path: std::path::PathBuf,
}

fn read_snapshot(state: &Path) -> Snapshot {
    let mut snap = Snapshot::new();
    for (name, _, _) in SETTINGS {
        let p = state.join(name);
        if let (Ok(v), Some(m)) = (std::fs::read_to_string(&p), paths::mtime(&p)) {
            snap.insert(
                name.to_string(),
                SettingSnap {
                    value: v.trim().chars().take(80).collect(),
                    mtime: m,
                },
            );
        }
    }
    snap
}

/// The window a run reads: `--since HOURS`, else from the last run (at least a day back).
pub fn window(register: &Register, since_hours: Option<f64>, until: f64) -> f64 {
    match since_hours {
        Some(h) => until - h * 3600.0,
        None => {
            let day = until - DEFAULT_HOURS * 3600.0;
            let floor = until - MAX_DEFAULT_HOURS * 3600.0;
            register.last_collect.map_or(day, |l| l.min(day)).max(floor)
        }
    }
}

pub fn run(opts: &Options) -> Result<Collected, String> {
    let state = paths::state_dir();
    let dream = paths::dream_dir();
    std::fs::create_dir_all(&dream).map_err(|e| format!("{}: {e}", dream.display()))?;
    let register_path = paths::register(&dream);
    let mut register = Register::load(&register_path)?;
    let until = time::now();
    let since = window(&register, opts.since_hours, until);
    let mut counts = Counts::default();
    let mut warnings = Vec::new();
    let mut all: Vec<Occurrence> = Vec::new();
    let mut starts: Vec<(f64, String)> = Vec::new();
    let mut menu: BTreeMap<String, Vec<f64>> = BTreeMap::new();
    let mut requests: Vec<(f64, String)> = Vec::new();

    // Journals.
    let sessions = state.join("sessions");
    match std::fs::read_dir(&sessions) {
        Ok(dir) => {
            let mut names: Vec<String> = dir
                .filter_map(Result::ok)
                .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect();
            names.sort();
            for name in names {
                let j = sessions.join(&name).join("journal.jsonl");
                if paths::mtime(&j).is_none_or(|m| m < since) {
                    continue;
                }
                let scan = journal::scan(&name, &j, since, until);
                counts.journal_sessions += 1;
                counts.journal_events += scan.events;
                all.extend(scan.occurrences);
                starts.extend(scan.starts);
                for (setting, t) in scan.settings_events {
                    menu.entry(setting).or_default().push(t);
                }
                requests.extend(scan.requests);
            }
        }
        Err(e) => warnings.push(format!("no journals: {}: {e}", sessions.display())),
    }

    // Recordings.
    let recordings = paths::recordings_dir();
    match std::fs::read_dir(&recordings) {
        Ok(dir) => {
            let mut names: Vec<String> = dir
                .filter_map(Result::ok)
                .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect();
            names.sort();
            for name in names {
                let tl = recordings.join(&name).join("timeline.jsonl");
                if paths::mtime(&tl).is_none_or(|m| m < since) {
                    continue;
                }
                let scan = timeline::scan(&name, &tl, since, until);
                if scan.test_run {
                    counts.recordings_skipped_as_test_runs += 1;
                    continue;
                }
                counts.recordings += 1;
                all.extend(scan.occurrences);
            }
        }
        Err(e) => warnings.push(format!("no recordings: {}: {e}", recordings.display())),
    }

    // Agent.log: machine lines, quits, starts; its ✗ lines only when no other source has them.
    let log = paths::agent_log();
    match std::fs::read(&log) {
        Ok(bytes) => {
            let text = String::from_utf8_lossy(&bytes);
            let end = paths::mtime(&log).unwrap_or(until);
            let scan = agentlog::scan_text(&text, since, until, end);
            counts.agent_log_lines = scan.lines;
            let known: HashSet<&str> = all.iter().map(|o| o.signature.as_str()).collect();
            let extra: Vec<Occurrence> = scan
                .tool_lines
                .into_iter()
                .filter(|o| !known.contains(o.signature.as_str()))
                .collect();
            all.extend(scan.occurrences);
            all.extend(extra);
            starts.extend(scan.starts);
        }
        Err(e) => warnings.push(format!("no Agent.log: {}: {e}", log.display())),
    }

    all.extend(restart_storms(starts, since, until));

    // Settings changed with nothing to explain them.
    let snap_path = dream.join("settings-snapshot.json");
    let previous: Snapshot = std::fs::read_to_string(&snap_path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default();
    let current = read_snapshot(&state);
    for (name, _, _) in SETTINGS {
        let times = menu.get(*name).cloned().unwrap_or_default();
        if let Some(o) = settings_check(
            name,
            current.get(*name),
            previous.get(*name),
            &times,
            &requests,
            since,
            until,
        ) {
            all.push(o);
        }
    }

    counts.occurrences_before_merge = all.len();
    let mut merged = evidence::merge(all);
    counts.occurrences = merged.len();
    evidence::charge_asked_again(&mut merged);
    let mut clusters = evidence::cluster(&merged);
    let applied = register.apply(&clusters, until);
    for c in &mut clusters {
        c.status = register.status(&c.signature).as_str().to_string();
    }
    register.last_collect = Some(until);
    register.version = 1;

    let date = time::date(until);
    let night = paths::night(&dream, &date);
    let evidence = Evidence {
        version: 1,
        generated: time::iso(until),
        since,
        until,
        since_local: time::iso(since),
        until_local: time::iso(until),
        counts,
        clusters,
        new: applied.new,
        regressed: applied.regressed,
        warnings,
    };
    let evidence_path = night.join("evidence.json");
    let text = serde_json::to_string_pretty(&evidence).map_err(|e| e.to_string())?;
    paths::write_atomic(&evidence_path, &text)?;
    register.save(&register_path)?;
    if opts.write {
        let snap = serde_json::to_string_pretty(&current).map_err(|e| e.to_string())?;
        paths::write_atomic(&snap_path, &snap)?;
    }
    Ok(Collected {
        evidence,
        date,
        evidence_path,
    })
}

/// The newest `<dream>/<date>/evidence.json`.
pub fn latest_evidence(dream: &Path) -> Option<(String, Evidence)> {
    let mut dates: Vec<String> = std::fs::read_dir(dream)
        .ok()?
        .filter_map(Result::ok)
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.len() == 10 && n.as_bytes()[4] == b'-' && n.as_bytes()[7] == b'-')
        .filter(|n| dream.join(n).join("evidence.json").is_file())
        .collect();
    dates.sort();
    let date = dates.pop()?;
    let text = std::fs::read_to_string(dream.join(&date).join("evidence.json")).ok()?;
    let evidence = serde_json::from_str(&text).ok()?;
    Some((date, evidence))
}
