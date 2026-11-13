//! Inspect recent receipts or admit/finalize one through JSON on stdin.
use serde_json::{json, Value};
use std::{
    env,
    io::{self, Read},
    path::Path,
    process,
};
const MAX_INPUT: u64 = 1024 * 1024;
fn run(directory: &Path, mode: &str) -> Result<Value, String> {
    if mode == "list" {
        return hive_core::request_ledger::list(directory);
    }
    let mut data = Vec::new();
    io::stdin()
        .lock()
        .take(MAX_INPUT + 1)
        .read_to_end(&mut data)
        .map_err(|_| "Invalid input")?;
    if data.len() as u64 > MAX_INPUT {
        return Err("Invalid input".into());
    }
    let input: Value = serde_json::from_slice(&data).map_err(|_| "Invalid input")?;
    match mode {
        "list-page" => {
            let before = match input.get("cursor") {
                None | Some(Value::Null) => None,
                Some(Value::String(cursor)) => Some(
                    cursor
                        .strip_prefix("r:")
                        .and_then(|v| v.parse::<i64>().ok())
                        .filter(|v| *v > 0)
                        .ok_or("Invalid input")?,
                ),
                _ => return Err("Invalid input".into()),
            };
            let limit = match input.get("limit") {
                None => 100,
                Some(Value::Number(n)) => n
                    .as_u64()
                    .and_then(|n| usize::try_from(n).ok())
                    .filter(|n| (1..=100).contains(n))
                    .ok_or("Invalid input")?,
                _ => return Err("Invalid input".into()),
            };
            let (receipts, next) =
                hive_core::request_ledger::list_page(directory, before, limit)?;
            Ok(json!({"receipts":receipts,"nextCursor":next.map(|n| format!("r:{n}"))}))
        }
        "admit" => {
            let text = input
                .get("text")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|v| !v.is_empty())
                .ok_or("Invalid input")?;
            let source = match input.get("sourceId") {
                None | Some(Value::Null) => None,
                Some(Value::String(v)) => Some(v.as_str()),
                _ => return Err("Invalid input".into()),
            };
            let objective = match input.get("goalObjective") {
                None | Some(Value::Null) => None,
                Some(Value::String(v)) if !v.trim().is_empty() => Some(v.as_str()),
                _ => return Err("Invalid input".into()),
            };
            let receipt =
                hive_core::request_ledger::admit(directory, source, text, objective)?;
            Ok(
                json!({"receiptId":receipt.id, "duplicate":receipt.duplicate, "status":receipt.status}),
            )
        }
        "finish" => {
            let id = input
                .get("receiptId")
                .and_then(Value::as_str)
                .ok_or("Invalid input")?;
            let status = input
                .get("status")
                .and_then(Value::as_str)
                .ok_or("Invalid input")?;
            hive_core::request_ledger::finish(directory, id, status)?;
            Ok(json!({"ok":true}))
        }
        _ => Err("Invalid mode".into()),
    }
}
fn main() {
    let mut args = env::args_os();
    args.next();
    let Some(directory) = args.next() else {
        eprintln!("Missing control directory");
        process::exit(2)
    };
    let mode = args.next().unwrap_or_else(|| "list".into());
    let Some(mode) = mode.to_str() else {
        process::exit(2)
    };
    if args.next().is_some() {
        process::exit(2);
    }
    match run(Path::new(&directory), mode) {
        Ok(value) => {
            if serde_json::to_writer(io::stdout().lock(), &value).is_err() {
                process::exit(1);
            }
        }
        Err(_) => {
            eprintln!("Request ledger unavailable");
            process::exit(1);
        }
    }
}
