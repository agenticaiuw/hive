//! `hive-tasks`: the owner's instructions to every coding agent, and the hooks that keep agents
//! from dropping them (see the library's docs).

use hive_tasks::{default_path, project_of, render_board, sync_soon, Cloud, Ledger};
use serde_json::Value;
use std::io::Read;

const HELP: &str = "\
hive-tasks hook claude|codex    a harness hook: reads the hook's JSON on stdin
hive-tasks add M<n>             register what message M<n> asks for: a JSON list on stdin of
                                {\"quote\", \"title\", \"minutes\", \"value\": low|medium|high}
                                (a standing preference: \"kind\": \"rule\", \"paths\": [globs]); [] for nothing
hive-tasks report               a JSON list on stdin of {\"id\": \"T<n>\", \"status\", \"outcome\", \"evidence\"};
                                status: open, active, done, waiting, blocked, dropped
hive-tasks done T<n> <outcome>  report one task done
hive-tasks board [--all] [--json]   this project's tasks (--all: every project)
hive-tasks board --cloud        every machine's board from the cloud copy, as JSON
hive-tasks show T<n>|M<n>|R<n>  one task's report, a message and its tasks, or a rule
hive-tasks rules [--all]        the owner's rules, where each applies and how often it was shown
hive-tasks rule-off R<n>        stop applying a rule
hive-tasks install|uninstall [--claude] [--codex]
                                put the hooks into (or take them out of) Claude Code and Codex
hive-tasks sync                 push what changed to the cloud copy (~/.config/hive/tasks.json) and
                                take in the rules set on other machines (runs by itself after changes)
hive-tasks web                  open Hive's dashboard with every machine's tasks (its window on the Mac)
";

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let hook = args.first().map(String::as_str) == Some("hook");
    let code = match run(&args) {
        Ok(out) => {
            if !out.is_empty() {
                println!("{out}");
            }
            0
        }
        // A hook never breaks the agent's turn: it prints nothing and lets the harness go on.
        Err(e) if hook => {
            eprintln!("hive-tasks: {e}");
            0
        }
        Err(e) => {
            eprintln!("{e}");
            if e.contains("readonly database") || e.contains("unable to open database") {
                eprintln!(
                    "A sandbox may be keeping this from writing the board. Run the hive-tasks \
                     command on its own (not chained with other commands) and Hive's hook does it."
                );
            }
            1
        }
    };
    std::process::exit(code);
}

fn stdin_json() -> Result<Value, String> {
    let mut text = String::new();
    std::io::stdin()
        .read_to_string(&mut text)
        .map_err(|e| e.to_string())?;
    serde_json::from_str(text.trim()).map_err(|e| format!("Stdin isn't JSON: {e}"))
}

fn run(args: &[String]) -> Result<String, String> {
    let flag = |f: &str| args.iter().any(|a| a == f);
    let arg = |i: usize| args.get(i).map(String::as_str).unwrap_or("");
    let cmd = arg(0);
    if cmd.is_empty() || matches!(cmd, "help" | "-h" | "--help") {
        return Ok(HELP.trim_end().to_string());
    }
    if matches!(cmd, "install" | "uninstall") {
        let harnesses: Vec<&str> = ["claude", "codex"]
            .into_iter()
            .filter(|h| flag(&format!("--{h}")))
            .collect();
        let harnesses = if harnesses.is_empty() {
            vec!["claude", "codex"]
        } else {
            harnesses
        };
        return install(cmd == "install", &harnesses);
    }
    if cmd == "sync" {
        return sync(flag("--quiet"));
    }
    if cmd == "web" {
        return web();
    }
    let path = default_path();
    let ledger = Ledger::open(&path)?;
    let here = || {
        project_of(
            &std::env::current_dir()
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_default(),
        )
        .id
    };
    match cmd {
        "hook" => {
            let harness = match arg(1) {
                h @ ("claude" | "codex") => h,
                other => return Err(format!("hook takes claude or codex, not {other:?}")),
            };
            let input = stdin_json()?;
            if inside_hive() {
                return Ok(String::new());
            }
            let out = ledger.hook(harness, &input)?;
            if input["hook_event_name"] != "PreToolUse" {
                sync_soon(&path);
            }
            Ok(if out.is_null() {
                String::new()
            } else {
                out.to_string()
            })
        }
        "add" => {
            let id = arg(1)
                .trim_start_matches(['M', 'm'])
                .parse::<i64>()
                .map_err(|_| "add M<n>".to_string())?;
            let out = ledger.add(id, &stdin_json()?)?.join("\n");
            sync_soon(&path);
            Ok(out)
        }
        "report" => {
            let out = ledger.report(&stdin_json()?)?.join("\n");
            sync_soon(&path);
            Ok(out)
        }
        "done" => {
            let outcome = args.get(2..).unwrap_or_default().join(" ");
            let report = serde_json::json!([{"id": arg(1), "status": "done", "outcome": outcome}]);
            let out = ledger.report(&report)?.join("\n");
            sync_soon(&path);
            Ok(out)
        }
        // Every machine's board, as the cloud copy has it (what the dashboard shows).
        "board" if flag("--cloud") => {
            let cloud = Cloud::load().ok_or("No cloud copy set up (~/.config/hive/tasks.json).")?;
            Ok(serde_json::to_string(&cloud.get("/v1/board")?).unwrap_or_default())
        }
        "board" => {
            let project = (!flag("--all")).then(here);
            let board = ledger.board(project.as_deref())?;
            Ok(if flag("--json") {
                serde_json::to_string_pretty(&board).unwrap_or_default()
            } else {
                render_board(&board)
            })
        }
        "show" => Ok(serde_json::to_string_pretty(&ledger.show(arg(1))?).unwrap_or_default()),
        "rules" => {
            let project = (!flag("--all")).then(here);
            Ok(
                serde_json::to_string_pretty(&ledger.rule_list(project.as_deref())?)
                    .unwrap_or_default(),
            )
        }
        "rule-off" => {
            let out = ledger.rule_off(arg(1))?;
            sync_soon(&path);
            Ok(out)
        }
        other => Err(format!("Unknown command {other:?}.\n{HELP}")),
    }
}

/// One sync at a time (a lock next to the ledger); a sync started while another runs leaves it
/// to that one, which goes on until nothing is left to push.
fn sync(quiet: bool) -> Result<String, String> {
    let Some(cloud) = Cloud::load() else {
        return Err("No cloud copy set up (~/.config/hive/tasks.json).".into());
    };
    let path = default_path();
    let ledger = Ledger::open(&path)?; // makes the folder the lock goes in
    let lock_path = path.with_file_name("sync.lock");
    let lock = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&lock_path)
        .map_err(|e| e.to_string())?;
    use std::os::unix::io::AsRawFd;
    if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        return Ok(if quiet {
            String::new()
        } else {
            "A sync is already running.".into()
        });
    }
    let said = ledger.sync(&cloud)?;
    Ok(if quiet { String::new() } else { said })
}

/// Opens Hive's dashboard: on the Mac its window in Hive.app (`hive://tasks`), else the board page
/// signed in, with a one-use code that never appears on screen.
fn web() -> Result<String, String> {
    if cfg!(target_os = "macos")
        && std::process::Command::new("open")
            .arg("hive://tasks")
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok_and(|s| s.success())
    {
        return Ok("Opened Hive's dashboard.".into());
    }
    let cloud = Cloud::load().ok_or("No cloud copy set up (~/.config/hive/tasks.json).")?;
    let answer = cloud.post("/v1/login-code", &serde_json::json!({}))?;
    let code = answer["code"]
        .as_str()
        .ok_or("The cloud gave no sign-in code.")?;
    let link = format!("{}/login?code={code}", cloud.url);
    if cfg!(target_os = "macos") {
        std::process::Command::new("open")
            .arg(&link)
            .status()
            .map_err(|e| e.to_string())?;
        Ok(format!("Opened {} (signed in for a year).", cloud.url))
    } else {
        Err("Run hive-tasks web on your Mac; this machine has no browser.".into())
    }
}

/// Hive's own agent (its Codex and Claude) puts the owner's requests on the board itself (see
/// `Ledger::hive_request`), so the hooks stay out of its way: Hive sets HIVE_TASKS_OFF=1 for
/// them, and a Hive built before that is recognized by being an ancestor process.
fn inside_hive() -> bool {
    if std::env::var("HIVE_TASKS_OFF").is_ok_and(|v| v == "1") {
        return true;
    }
    let Ok(out) = std::process::Command::new("ps")
        .args(["-axo", "pid=,ppid=,comm="])
        .output()
    else {
        return false;
    };
    let table: std::collections::HashMap<i64, (i64, String)> = String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|line| {
            let mut parts = line.split_whitespace();
            let pid = parts.next()?.parse().ok()?;
            let ppid = parts.next()?.parse().ok()?;
            Some((pid, (ppid, parts.collect::<Vec<_>>().join(" "))))
        })
        .collect();
    let mut pid = unsafe { libc::getppid() } as i64;
    for _ in 0..16 {
        match table.get(&pid) {
            Some((_, comm)) if comm.contains("/Hive.app/") => return true,
            Some((ppid, _)) if *ppid > 1 && *ppid != pid => pid = *ppid,
            _ => return false,
        }
    }
    false
}

/// Copies this program to ~/.local/bin and adds its hooks to Claude Code's
/// ~/.claude/settings.json and Codex's ~/.codex/hooks.json (a copy of each file is kept as
/// <file>.hive-tasks.bak first); uninstall takes the hooks out again. Other hooks are kept.
fn install(on: bool, harnesses: &[&str]) -> Result<String, String> {
    let home = hive_common::paths::home();
    let bin = home.join(".local/bin/hive-tasks");
    if on {
        let me = std::env::current_exe().map_err(|e| e.to_string())?;
        if me != bin {
            std::fs::create_dir_all(bin.parent().unwrap()).map_err(|e| e.to_string())?;
            // Replace, don't overwrite in place: a running hook may have the old file open.
            let tmp = bin.with_extension("new");
            std::fs::copy(&me, &tmp).map_err(|e| e.to_string())?;
            std::fs::rename(&tmp, &bin).map_err(|e| e.to_string())?;
        }
    }
    let mut out = Vec::new();
    for harness in harnesses {
        let file = match *harness {
            "claude" => home.join(".claude/settings.json"),
            _ => home.join(".codex/hooks.json"),
        };
        let before = std::fs::read_to_string(&file).unwrap_or_else(|_| "{}".into());
        let settings: Value = serde_json::from_str(&before)
            .map_err(|e| format!("{} isn't JSON: {e}", file.display()))?;
        let command = format!("{} hook {harness}", bin.display());
        let after = hive_tasks::merge_hooks(settings, harness, on.then_some(command.as_str()));
        let text = serde_json::to_string_pretty(&after).map_err(|e| e.to_string())? + "\n";
        if text != before {
            if file.exists() {
                std::fs::copy(&file, file.with_extension("json.hive-tasks.bak"))
                    .map_err(|e| e.to_string())?;
            }
            std::fs::create_dir_all(file.parent().unwrap()).map_err(|e| e.to_string())?;
            std::fs::write(&file, text).map_err(|e| e.to_string())?;
        }
        out.push(format!(
            "{} hooks {} {}",
            harness,
            if on { "in" } else { "out of" },
            file.display()
        ));
    }
    Ok(out.join("\n"))
}
