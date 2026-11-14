//! The owner's activity log (hive-mac's `activity`, mirrored to `state/activity/<date>.jsonl`):
//! what they did by hand right after Hive left a task unfinished or was stopped. That is a
//! demonstration of the task, and the fix gets it with the failure's other references.

use std::path::Path;

use serde_json::Value;

use crate::evidence::Occurrence;
use crate::normalize::cut;

/// What the owner did within this long after a task ended counts as doing it by hand.
pub const DEMO_SECS: f64 = 600.0;
/// At most this many steps of a demonstration are kept.
pub const DEMO_STEPS: usize = 6;

/// One line of the log: the app in front, its window and page from `at` on.
#[derive(Clone, Debug, PartialEq)]
pub struct Step {
    pub at: f64,
    pub app: String,
    pub window: Option<String>,
    pub page: Option<String>,
    /// Hive was working on a task then (the step may be Hive's own).
    pub hive: bool,
    /// A password manager or bank, logged by app name only.
    pub private: bool,
}

/// The steps in one day's log; lines that aren't steps are skipped.
pub fn parse(text: &str) -> Vec<Step> {
    let text_of = |v: &Value, k: &str| v.get(k).and_then(Value::as_str).map(str::to_string);
    text.lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter_map(|v| {
            Some(Step {
                at: v.get("at")?.as_f64()?,
                app: text_of(&v, "app").filter(|a| !a.is_empty())?,
                window: text_of(&v, "window"),
                page: text_of(&v, "page"),
                hive: v.get("hive").and_then(Value::as_bool).unwrap_or(false),
                private: v.get("private").and_then(Value::as_bool).unwrap_or(false),
            })
        })
        .collect()
}

/// Every step in `dir`'s logs from `since` to [`DEMO_SECS`] past `until`, oldest first.
pub fn read(dir: &Path, since: f64, until: f64) -> Vec<Step> {
    let mut out: Vec<Step> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().ends_with(".jsonl"))
        .filter_map(|e| std::fs::read_to_string(e.path()).ok())
        .flat_map(|t| parse(&t))
        .filter(|s| s.at >= since && s.at <= until + DEMO_SECS)
        .collect();
    out.sort_by(|a, b| a.at.total_cmp(&b.at));
    out
}

/// A step in a few words: "Safari: Course Search (enroll.wisc.edu/search)".
pub fn describe(step: &Step) -> String {
    if step.private {
        return format!("{} (private)", step.app);
    }
    let page = step.page.as_deref().map(|p| {
        let p = p.split_once("://").map_or(p, |(_, rest)| rest);
        cut(p.split(['?', '#']).next().unwrap_or(p), 60)
    });
    match (step.window.as_deref().filter(|w| !w.is_empty()), page) {
        (Some(w), Some(p)) => format!("{}: {} ({p})", step.app, cut(w, 60)),
        (Some(w), None) => format!("{}: {}", step.app, cut(w, 60)),
        (None, Some(p)) => format!("{} ({p})", step.app),
        (None, None) => step.app.clone(),
    }
}

/// Adds to each task ending (unfinished or stopped) what the owner did by hand in the
/// [`DEMO_SECS`] after it, as a reference "by hand after: <step> → <step>". Steps taken while
/// Hive was working are left out. Returns how many endings got one.
pub fn attach_demonstrations(occurrences: &mut [Occurrence], steps: &[Step]) -> usize {
    let mut attached = 0;
    for o in occurrences.iter_mut().filter(|o| o.outcome) {
        let mut said: Vec<String> = Vec::new();
        for s in steps
            .iter()
            .filter(|s| s.at > o.t && s.at <= o.t + DEMO_SECS && !s.hive)
        {
            let step = describe(s);
            if said.last() != Some(&step) {
                said.push(step);
            }
            if said.len() == DEMO_STEPS {
                break;
            }
        }
        if !said.is_empty() {
            o.refs.push(format!("by hand after: {}", said.join(" → ")));
            attached += 1;
        }
    }
    attached
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::evidence::Source;

    #[test]
    fn what_the_owner_did_after_a_failed_task_is_its_demonstration() {
        let log = [
            r#"{"at":95,"app":"Safari","hive":true,"window":"Hive's own step"}"#,
            r#"{"at":110,"app":"Safari","hive":true,"window":"Still Hive"}"#,
            r#"{"at":130,"app":"Safari","hive":false,"window":"Course Search","page":"https://enroll.wisc.edu/search?term=1272"}"#,
            r#"{"at":140,"app":"Passwords","hive":false,"private":true}"#,
            r#"{"at":150,"app":"Safari","hive":false,"window":"Course Search","page":"https://enroll.wisc.edu/search?term=1274"}"#,
            "not json",
            r#"{"at":900,"app":"Terminal","hive":false,"window":"zsh"}"#,
        ]
        .join("\n");
        let steps = parse(&log);
        assert_eq!(steps.len(), 6);
        let ended = |t: f64| {
            Occurrence::new(
                "unfinished",
                "gave up",
                t,
                Source::Journal,
                format!("journal s:{t}"),
            )
            .outcome()
        };
        let mut all = vec![
            ended(100.0),
            ended(5000.0),
            Occurrence::new("tool_error", "x", 100.0, Source::Journal, "j".into()),
        ];
        assert_eq!(attach_demonstrations(&mut all, &steps), 1);
        assert_eq!(
            all[0].refs.last().unwrap(),
            "by hand after: Safari: Course Search (enroll.wisc.edu/search) → Passwords (private) → Safari: Course Search (enroll.wisc.edu/search)"
        );
        assert_eq!(all[1].refs.len(), 1, "nothing done by hand after it");
        assert_eq!(all[2].refs.len(), 1, "not a task's ending");
    }
}
