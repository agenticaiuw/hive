//! hive-dream: see the crate docs (`src/lib.rs`) and `hive-dream help`.

use std::path::PathBuf;

use hive_dream::register::{Register, Status};
use hive_dream::{ci, collect, fix, land, paths, report, schedule, time};

const HELP: &str = "hive-dream: Hive's nightly self-review (collect, fix with Codex, gate, report).

  hive-dream collect [--since HOURS]     read journals, recordings and Agent.log into
                                         <state>/dream/<date>/evidence.json and the register
  hive-dream fix [--max N] [--cluster SLUG] [--dry-run]
                                         Codex in a worktree on a local dream/<date>-<slug>
                                         branch, then the gate (default --max 1)
  hive-dream report [--date YYYY-MM-DD]  rewrite and print the path of the morning report
  hive-dream land BRANCH [--dry-run]     cherry-pick a dream branch onto main in ~/hive (never pushes)
  hive-dream mark SLUG STATUS [--note TEXT]
                                         set a cluster open, ignored, landed, rejected or proposed
  hive-dream status                      the register: open, proposed, rejected, landed, ignored
  hive-dream nightly [--force]           what launchd runs: postpone checks, collect, fix --max 1, report
  hive-dream install-schedule [--exe PATH] [--print] [--no-load]
                                         write (and load) ~/Library/LaunchAgents/local.hive.dream.plist
  hive-dream uninstall-schedule
  hive-dream ci-gate --out DIR           the macOS check of a dream/* branch (GitHub Actions)
  hive-dream ci-publish --out DIR        push what ci-gate decided (needs HIVE_DREAM_PUSH_URL)

Everything is written under <state>/dream/ (HIVE_DREAM_DIR). Codex runs from ChatGPT.app
(HIVE_DREAM_CODEX); the repo is ~/hive (HIVE_DREAM_REPO).";

fn value(args: &[String], flag: &str) -> Option<String> {
    args.iter()
        .position(|a| a == flag)
        .and_then(|i| args.get(i + 1))
        .cloned()
}

fn has(args: &[String], flag: &str) -> bool {
    args.iter().any(|a| a == flag)
}

fn run(args: Vec<String>) -> Result<(), String> {
    let cmd = args.first().map(String::as_str).unwrap_or("help");
    let rest = &args[args.len().min(1)..];
    match cmd {
        "collect" => {
            let since_hours = match value(rest, "--since") {
                Some(v) => Some(
                    v.parse::<f64>()
                        .map_err(|_| format!("--since {v}: not a number of hours"))?,
                ),
                None => None,
            };
            let c = collect::run(&collect::Options {
                since_hours,
                write: true,
            })?;
            let dream = paths::dream_dir();
            let report = report::write(&dream, &c.date)?;
            let e = &c.evidence;
            println!(
                "read {} to {}: {} sessions, {} recordings ({} test runs left out), {} occurrences, {} clusters",
                e.since_local,
                e.until_local,
                e.counts.journal_sessions,
                e.counts.recordings,
                e.counts.recordings_skipped_as_test_runs,
                e.counts.occurrences,
                e.clusters.len()
            );
            for (i, cl) in e.clusters.iter().take(10).enumerate() {
                println!(
                    "{:>2}. {:>6.1} min {:>4}x [{}] {}",
                    i + 1,
                    cl.minutes,
                    cl.count,
                    cl.status,
                    cl.signature
                );
            }
            for w in &e.warnings {
                eprintln!("warning: {w}");
            }
            println!("evidence: {}", c.evidence_path.display());
            println!("report: {}", report.display());
            Ok(())
        }
        "fix" => {
            let max = value(rest, "--max").map_or(Ok(1), |v| {
                v.parse::<usize>().map_err(|_| format!("--max {v}"))
            })?;
            let opts = fix::Options {
                max,
                cluster: value(rest, "--cluster"),
                dry_run: has(rest, "--dry-run"),
            };
            if paths::load_private_terms(&paths::dream_dir()).is_none() {
                eprintln!(
                    "warning: no {}: the private term check will be skipped",
                    paths::private_terms(&paths::dream_dir()).display()
                );
            }
            let results = fix::run(&opts)?;
            for r in &results {
                println!("{}: {}", r.outcome, r.signature);
                if let Some(b) = &r.branch {
                    println!("  branch {b}");
                }
                if let Some(e) = &r.error {
                    println!("  error: {e}");
                }
                if let Some(v) = &r.verdict {
                    for reason in &v.reasons {
                        println!("  gate: {reason}");
                    }
                }
            }
            if !opts.dry_run && !results.is_empty() {
                if let Some((date, _)) = collect::latest_evidence(&paths::dream_dir()) {
                    println!(
                        "report: {}",
                        report::write(&paths::dream_dir(), &date)?.display()
                    );
                }
            }
            Ok(())
        }
        "report" => {
            let dream = paths::dream_dir();
            let date = match value(rest, "--date") {
                Some(d) => d,
                None => collect::latest_evidence(&dream).ok_or("no evidence yet")?.0,
            };
            println!("{}", report::write(&dream, &date)?.display());
            Ok(())
        }
        "land" => {
            let branch = rest
                .iter()
                .find(|a| !a.starts_with("--"))
                .cloned()
                .ok_or("land needs a branch: hive-dream land dream/<date>-<slug>")?;
            println!(
                "{}",
                land::run(&land::Options {
                    branch,
                    dry_run: has(rest, "--dry-run"),
                })?
            );
            Ok(())
        }
        "mark" => {
            let words: Vec<&String> = rest.iter().filter(|a| !a.starts_with("--")).collect();
            let note = value(rest, "--note").unwrap_or_else(|| "set by hand".into());
            let words: Vec<&String> = words.into_iter().filter(|w| **w != note).collect();
            let (key, status) = match words.as_slice() {
                [k, s] => (k.as_str(), s.as_str()),
                _ => return Err("mark needs SLUG STATUS".into()),
            };
            let status = Status::parse(status).ok_or(format!("unknown status {status}"))?;
            let path = paths::register(&paths::dream_dir());
            let mut register = Register::load(&path)?;
            let sig = register
                .find(key)
                .ok_or(format!("nothing in the register matches {key}"))?;
            register.set(&sig, status, &note, time::now())?;
            register.save(&path)?;
            println!("{}: {}", status.as_str(), sig);
            Ok(())
        }
        "status" => {
            let register = Register::load(&paths::register(&paths::dream_dir()))?;
            let mut entries: Vec<_> = register.entries.iter().collect();
            entries.sort_by(|a, b| b.1.minutes.total_cmp(&a.1.minutes));
            println!(
                "last collect: {}",
                register.last_collect.map_or("never".into(), time::iso)
            );
            for (sig, e) in entries {
                println!(
                    "{:<9} {:>7.1} min {:>4}x {}{}",
                    e.status.as_str(),
                    e.minutes,
                    e.count,
                    sig,
                    e.branch
                        .as_deref()
                        .map_or(String::new(), |b| format!("  [{b}]"))
                );
            }
            Ok(())
        }
        "nightly" => {
            let r = schedule::nightly(has(rest, "--force"));
            schedule::flush();
            r
        }
        "install-schedule" => {
            println!(
                "{}",
                schedule::install(
                    value(rest, "--exe").map(PathBuf::from),
                    has(rest, "--print"),
                    !has(rest, "--no-load"),
                )?
            );
            Ok(())
        }
        "uninstall-schedule" => {
            println!("{}", schedule::uninstall()?);
            Ok(())
        }
        "ci-gate" | "ci-publish" => {
            let out = PathBuf::from(value(rest, "--out").ok_or("--out DIR is needed")?);
            let r = if cmd == "ci-gate" {
                // A gate that can't run still answers, so the VM doesn't wait for nothing.
                ci::gate(&out).inspect_err(|e| ci::report_error(&out, e))?
            } else {
                ci::publish(&out)?
            };
            println!("{}", serde_json::to_string_pretty(&r).map_err(|e| e.to_string())?);
            Ok(())
        }
        "help" | "--help" | "-h" => {
            println!("{HELP}");
            Ok(())
        }
        other => Err(format!("unknown command {other:?}\n\n{HELP}")),
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if let Err(e) = run(args) {
        eprintln!("hive-dream: {e}");
        std::process::exit(1);
    }
}
