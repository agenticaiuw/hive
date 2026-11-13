//! `<state>/dream/register.json`: every signature ever seen and where it stands: open, proposed
//! (a branch passed the gate), rejected (the gate said no; the branch is kept), landed (someone
//! ran `hive-dream land`), ignored (someone said so). Each occurrence is counted once, however
//! many collect runs overlap it.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;

use crate::evidence::{round2, Cluster};
use crate::time;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Open,
    Proposed,
    Rejected,
    Landed,
    Ignored,
}

impl Status {
    pub fn parse(s: &str) -> Option<Status> {
        match s {
            "open" => Some(Status::Open),
            "proposed" => Some(Status::Proposed),
            "rejected" => Some(Status::Rejected),
            "landed" => Some(Status::Landed),
            "ignored" => Some(Status::Ignored),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Status::Open => "open",
            Status::Proposed => "proposed",
            Status::Rejected => "rejected",
            Status::Landed => "landed",
            Status::Ignored => "ignored",
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Change {
    pub t: f64,
    pub status: Status,
    pub note: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Entry {
    pub slug: String,
    pub category: String,
    pub status: Status,
    pub first_seen: f64,
    pub last_seen: f64,
    pub count: u64,
    pub minutes: f64,
    /// Occurrence ids already counted, with their time (dropped after [`KEEP_IDS_DAYS`]).
    #[serde(default)]
    pub seen: BTreeMap<String, f64>,
    #[serde(default)]
    pub branch: Option<String>,
    #[serde(default)]
    pub worktree: Option<String>,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub attempts: u32,
    #[serde(default)]
    pub last_attempt: Option<f64>,
    #[serde(default)]
    pub landed_at: Option<f64>,
    #[serde(default)]
    pub landed_commits: Vec<String>,
    #[serde(default)]
    pub history: Vec<Change>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Register {
    #[serde(default)]
    pub version: u32,
    /// Until when the last collect read (the next one starts there unless told otherwise).
    #[serde(default)]
    pub last_collect: Option<f64>,
    #[serde(default)]
    pub entries: BTreeMap<String, Entry>,
}

pub const KEEP_IDS_DAYS: f64 = 45.0;

/// What a collect changed in the register, for the report.
#[derive(Clone, Debug, Default)]
pub struct Applied {
    pub new: Vec<String>,
    /// Landed fixes whose signature was seen again after landing: reopened.
    pub regressed: Vec<String>,
}

impl Register {
    /// A missing file is an empty register; a corrupt one is an error (never overwritten).
    pub fn load(path: &Path) -> Result<Register, String> {
        match std::fs::read_to_string(path) {
            Ok(text) => serde_json::from_str(&text)
                .map_err(|e| format!("{} is not a register ({e}); fix or move it", path.display())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Register {
                version: 1,
                ..Default::default()
            }),
            Err(e) => Err(format!("{}: {e}", path.display())),
        }
    }

    pub fn save(&self, path: &Path) -> Result<(), String> {
        let text = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        crate::paths::write_atomic(path, &text)
    }

    /// Adds a collect run's clusters: new signatures start open; occurrences already counted
    /// aren't counted again; a landed signature seen after it landed is reopened.
    pub fn apply(&mut self, clusters: &[Cluster], now: f64) -> Applied {
        let mut applied = Applied::default();
        for c in clusters {
            let entry = self.entries.entry(c.signature.clone()).or_insert_with(|| {
                applied.new.push(c.signature.clone());
                Entry {
                    slug: c.slug.clone(),
                    category: c.category.clone(),
                    status: Status::Open,
                    first_seen: c.first_t,
                    last_seen: c.last_t,
                    count: 0,
                    minutes: 0.0,
                    seen: BTreeMap::new(),
                    branch: None,
                    worktree: None,
                    reason: None,
                    attempts: 0,
                    last_attempt: None,
                    landed_at: None,
                    landed_commits: Vec::new(),
                    history: vec![Change {
                        t: now,
                        status: Status::Open,
                        note: "first seen".into(),
                    }],
                }
            });
            let per = if c.count > 0 {
                c.minutes / c.count as f64
            } else {
                0.0
            };
            let mut fresh_after_landing = false;
            for (id, t) in &c.occurrences {
                let t = *t;
                if entry.seen.contains_key(id) {
                    continue;
                }
                entry.seen.insert(id.clone(), t);
                entry.count += 1;
                entry.minutes = round2(entry.minutes + per);
                if entry.landed_at.is_some_and(|landed| t > landed) {
                    fresh_after_landing = true;
                }
            }
            entry.first_seen = entry.first_seen.min(c.first_t);
            entry.last_seen = entry.last_seen.max(c.last_t);
            if entry.status == Status::Landed && fresh_after_landing {
                entry.status = Status::Open;
                entry.history.push(Change {
                    t: now,
                    status: Status::Open,
                    note: format!(
                        "seen again after landing on {}",
                        time::iso(entry.landed_at.unwrap_or(0.0))
                    ),
                });
                applied.regressed.push(c.signature.clone());
            }
            let cutoff = now - KEEP_IDS_DAYS * 86400.0;
            entry.seen.retain(|_, t| *t >= cutoff);
        }
        applied
    }

    pub fn set(
        &mut self,
        signature: &str,
        status: Status,
        note: &str,
        now: f64,
    ) -> Result<(), String> {
        let entry = self
            .entries
            .get_mut(signature)
            .ok_or_else(|| format!("no signature {signature:?} in the register"))?;
        entry.status = status;
        if status == Status::Landed {
            entry.landed_at = Some(now);
        }
        entry.history.push(Change {
            t: now,
            status,
            note: note.to_string(),
        });
        Ok(())
    }

    /// The signature whose slug, branch or signature text is `key`.
    pub fn find(&self, key: &str) -> Option<String> {
        self.entries
            .iter()
            .find(|(sig, e)| {
                sig.as_str() == key
                    || e.slug == key
                    || e.branch.as_deref() == Some(key)
                    || e.branch
                        .as_deref()
                        .is_some_and(|b| b.trim_start_matches("dream/").ends_with(key))
            })
            .map(|(sig, _)| sig.clone())
    }

    pub fn status(&self, signature: &str) -> Status {
        self.entries
            .get(signature)
            .map_or(Status::Open, |e| e.status)
    }
}
