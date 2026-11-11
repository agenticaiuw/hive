use serde_json::{json, Value};
use std::{io, path::Path, process};
fn run(input: Value) -> Result<Value, &'static str> {
    match input.get("op").and_then(Value::as_str).unwrap_or("split") {
        "split" => {
            let text = input
                .get("text")
                .and_then(Value::as_str)
                .ok_or("Missing text")?;
            let size = input
                .get("size")
                .and_then(Value::as_u64)
                .and_then(|n| usize::try_from(n).ok())
                .ok_or("Invalid size")?;
            Ok(json!(personal_agent_core::ingest::split(text, size)?))
        }
        "verify" => {
            let path = input
                .get("path")
                .and_then(Value::as_str)
                .ok_or("Missing path")?;
            let marker = input
                .get("marker")
                .and_then(Value::as_str)
                .ok_or("Missing marker")?;
            personal_agent_core::ingest::in_rollout(Path::new(path), marker)
                .map(|found| json!(found))
                .map_err(|_| "Rollout unavailable")
        }
        _ => Err("Invalid operation"),
    }
}
fn main() {
    let result = serde_json::from_reader(io::stdin().lock())
        .map_err(|_| "Invalid request")
        .and_then(run);
    match result {
        Ok(value) => {
            if serde_json::to_writer(io::stdout().lock(), &value).is_err() {
                process::exit(1);
            }
        }
        Err(_) => {
            eprintln!("Ingestion operation failed");
            process::exit(1);
        }
    }
}
