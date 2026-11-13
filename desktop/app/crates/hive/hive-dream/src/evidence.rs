//! Occurrences (one failure, seen at one time, with where it was seen) and clusters (every
//! occurrence of one signature). The journal and the recording often see the same event: those
//! are merged into one occurrence by signature and time, so nothing is counted twice.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

use crate::normalize::{cut, fnv64, slug};
use crate::time;

/// Where an occurrence was seen.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum Source {
    Journal,
    Recording,
    AgentLog,
    Settings,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Occurrence {
    pub category: String,
    /// The cluster key: "<category>: <signature text>".
    pub signature: String,
    /// When it started (epoch seconds).
    pub t: f64,
    /// Every event time this occurrence stands for (for merging the same event across sources).
    #[serde(default)]
    pub times: Vec<f64>,
    pub minutes: f64,
    pub sources: Vec<Source>,
    /// `journal <session>:<line>`, `recording <folder>@<seconds>s`, `Agent.log:<line>`.
    pub refs: Vec<String>,
    /// What it said, shortened (private: stays in the state folder).
    pub example: String,
    /// A task's ending (stopped, failed, interrupted): two endings at the same moment are one.
    #[serde(default)]
    pub outcome: bool,
}

impl Occurrence {
    pub fn new(category: &str, text: &str, t: f64, source: Source, reference: String) -> Self {
        Occurrence {
            category: category.to_string(),
            signature: format!("{category}: {text}"),
            t,
            times: vec![t],
            minutes: 0.0,
            sources: vec![source],
            refs: vec![reference],
            example: String::new(),
            outcome: false,
        }
    }

    pub fn minutes(mut self, minutes: f64) -> Self {
        self.minutes = minutes.max(0.0);
        self
    }

    pub fn example(mut self, text: &str) -> Self {
        self.example = cut(&text.replace('\n', " | "), 240);
        self
    }

    pub fn outcome(mut self) -> Self {
        self.outcome = true;
        self
    }

    /// Stable across runs over the same data: the register uses it to count each event once.
    pub fn id(&self) -> String {
        format!(
            "{:016x}",
            fnv64(&format!("{}@{}", self.signature, self.t.round() as i64))
        )
    }
}

/// What each category is and whether `fix` may hand it to Codex.
pub struct Category {
    pub name: &'static str,
    pub title: &'static str,
    pub fixable: bool,
}

pub const CATEGORIES: &[Category] = &[
    Category {
        name: "wait_for_control",
        title: "the agent waited for the user to hand back the screen",
        fixable: true,
    },
    Category {
        name: "takeover",
        title: "the user had the mouse and keyboard while a task needed them",
        fixable: true,
    },
    Category {
        name: "phone",
        title: "the iPhone or its relay didn't answer",
        fixable: true,
    },
    Category {
        name: "provider",
        title: "Codex or the model provider failed",
        fixable: true,
    },
    Category {
        name: "self_stop_x",
        title: "the agent clicked the x on Hive's own floating window",
        fixable: true,
    },
    Category {
        name: "unfinished",
        title: "a task ended stopped or failed",
        fixable: true,
    },
    Category {
        name: "repeat_calls",
        title: "the same call three or more times in a row",
        fixable: true,
    },
    Category {
        name: "tool_error",
        title: "a tool call failed",
        fixable: true,
    },
    Category {
        name: "log_error",
        title: "an error in Agent.log",
        fixable: true,
    },
    Category {
        name: "restart_storm",
        title: "Hive restarted again and again",
        fixable: false,
    },
    Category {
        name: "interrupted",
        title: "the user stopped or replaced a running task",
        fixable: false,
    },
    Category {
        name: "settings_changed",
        title: "a setting changed with no request or menu action recorded",
        fixable: false,
    },
    Category {
        name: "regression_words",
        title: "the user said something came back (again, still, I thought we changed)",
        fixable: false,
    },
];

pub fn category(name: &str) -> Option<&'static Category> {
    CATEGORIES.iter().find(|c| c.name == name)
}

/// Whether `fix` may pick this signature: its category is fixable, and an unfinished task's
/// class says something more specific than "other".
pub fn fixable(category_name: &str, signature: &str) -> bool {
    category(category_name).is_some_and(|c| c.fixable)
        && !(category_name == "unfinished" && signature.ends_with(": other"))
}

/// Within this many seconds, the same signature from two sources is one event.
pub const SAME_EVENT_SECS: f64 = 3.0;

/// Merges occurrences that are the same event seen by two sources (journal and recording):
/// same signature, or both a task's ending, at times within [`SAME_EVENT_SECS`]. The recording's
/// signature wins for endings (it can tell the card's x from fn); minutes are the larger.
pub fn merge(mut all: Vec<Occurrence>) -> Vec<Occurrence> {
    all.sort_by(|a, b| a.t.total_cmp(&b.t).then(a.signature.cmp(&b.signature)));
    let mut out: Vec<Occurrence> = Vec::new();
    for occ in all {
        let found = out.iter_mut().rev().take(400).find(|o| {
            let same = o.signature == occ.signature || (o.outcome && occ.outcome);
            let other_source = !occ.sources.iter().all(|s| o.sources.contains(s));
            same && other_source
                && o.times
                    .iter()
                    .any(|a| occ.times.iter().any(|b| (a - b).abs() <= SAME_EVENT_SECS))
        });
        match found {
            Some(o) => {
                if o.outcome && occ.outcome && occ.sources.contains(&Source::Recording) {
                    o.signature = occ.signature.clone();
                    o.category = occ.category.clone();
                    o.example = occ.example.clone();
                }
                o.minutes = o.minutes.max(occ.minutes);
                o.t = o.t.min(occ.t);
                o.times.extend(occ.times);
                for s in occ.sources {
                    if !o.sources.contains(&s) {
                        o.sources.push(s);
                    }
                }
                o.refs.extend(occ.refs);
                if o.example.is_empty() {
                    o.example = occ.example;
                }
            }
            None => out.push(occ),
        }
    }
    out
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Cluster {
    pub signature: String,
    pub slug: String,
    pub category: String,
    pub fixable: bool,
    pub count: u64,
    pub minutes: f64,
    pub first_seen: String,
    pub last_seen: String,
    pub first_t: f64,
    pub last_t: f64,
    /// Up to 12 references, newest first.
    pub refs: Vec<String>,
    /// Up to 3 different examples.
    pub examples: Vec<String>,
    /// Each occurrence's id and time (for the register's counting).
    pub occurrences: Vec<(String, f64)>,
    /// Filled in from the register when the evidence is written.
    #[serde(default)]
    pub status: String,
}

pub const MAX_REFS: usize = 12;

/// One cluster per signature, most minutes lost first (then most often, then name).
pub fn cluster(occurrences: &[Occurrence]) -> Vec<Cluster> {
    let mut by: BTreeMap<&str, Vec<&Occurrence>> = BTreeMap::new();
    for o in occurrences {
        by.entry(o.signature.as_str()).or_default().push(o);
    }
    let mut out: Vec<Cluster> = by
        .into_iter()
        .map(|(signature, mut list)| {
            list.sort_by(|a, b| b.t.total_cmp(&a.t));
            let first_t = list.iter().map(|o| o.t).fold(f64::INFINITY, f64::min);
            let last_t = list.iter().map(|o| o.t).fold(f64::NEG_INFINITY, f64::max);
            let mut refs = Vec::new();
            for o in &list {
                for r in &o.refs {
                    if refs.len() < MAX_REFS && !refs.contains(r) {
                        refs.push(r.clone());
                    }
                }
            }
            let mut examples: Vec<String> = Vec::new();
            for o in &list {
                if !o.example.is_empty() && examples.len() < 3 && !examples.contains(&o.example) {
                    examples.push(o.example.clone());
                }
            }
            let category = list[0].category.clone();
            Cluster {
                signature: signature.to_string(),
                slug: slug(signature),
                fixable: fixable(&category, signature),
                category,
                count: list.len() as u64,
                minutes: round2(list.iter().map(|o| o.minutes).sum()),
                first_seen: time::iso(first_t),
                last_seen: time::iso(last_t),
                first_t,
                last_t,
                refs,
                examples,
                occurrences: list.iter().map(|o| (o.id(), o.t)).collect(),
                status: String::new(),
            }
        })
        .collect();
    out.sort_by(|a, b| {
        b.minutes
            .total_cmp(&a.minutes)
            .then(b.count.cmp(&a.count))
            .then(a.signature.cmp(&b.signature))
    });
    out
}

pub fn round2(x: f64) -> f64 {
    (x * 100.0).round() / 100.0
}

/// What a collect run read, for the evidence file and the report.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Counts {
    pub journal_sessions: usize,
    pub journal_events: usize,
    pub recordings: usize,
    pub recordings_skipped_as_test_runs: usize,
    pub agent_log_lines: usize,
    pub occurrences_before_merge: usize,
    pub occurrences: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Evidence {
    pub version: u32,
    pub generated: String,
    pub since: f64,
    pub until: f64,
    pub since_local: String,
    pub until_local: String,
    pub counts: Counts,
    pub clusters: Vec<Cluster>,
    /// Signatures the register had never seen.
    #[serde(default)]
    pub new: Vec<String>,
    /// Landed signatures seen again after landing (reopened).
    #[serde(default)]
    pub regressed: Vec<String>,
    #[serde(default)]
    pub warnings: Vec<String>,
}
