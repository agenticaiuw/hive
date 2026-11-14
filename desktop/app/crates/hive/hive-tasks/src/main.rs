//! `hive-tasks`: the owner's instructions to every coding agent, and the hooks that keep agents
//! from dropping them (see the library's docs).

use hive_tasks::{default_path, project_of, render_board, Ledger};
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
hive-tasks show T<n>|M<n>|R<n>  one task's report, a message and its tasks, or a rule
hive-tasks rules [--all]        the owner's rules, where each applies and how often it was shown
hive-tasks rule-off R<n>        stop applying a rule
hive-tasks install|uninstall [--claude] [--codex]
                                put the hooks into (or take them out of) Claude Code and Codex
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
    let ledger = Ledger::open(&default_path())?;
    let here = || {
        project_of(
            &std::env::current_dir()
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_default(),
        )
    };
    match cmd {
        "hook" => {
            let harness = match arg(1) {
                h @ ("claude" | "codex") => h,
                other => return Err(format!("hook takes claude or codex, not {other:?}")),
            };
            let out = ledger.hook(harness, &stdin_json()?)?;
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
            Ok(ledger.add(id, &stdin_json()?)?.join("\n"))
        }
        "report" => Ok(ledger.report(&stdin_json()?)?.join("\n")),
        "done" => {
            let outcome = args.get(2..).unwrap_or_default().join(" ");
            let report = serde_json::json!([{"id": arg(1), "status": "done", "outcome": outcome}]);
            Ok(ledger.report(&report)?.join("\n"))
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
        "rule-off" => ledger.rule_off(arg(1)),
        other => Err(format!("Unknown command {other:?}.\n{HELP}")),
    }
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
