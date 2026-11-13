//! Serialized recovery-state transitions; user request text is never retained.
use crate::thread_identity::atomic_write_standard;
use fs4::FileExt;
use serde_json::{json, Value};
#[cfg(unix)]
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::{
    fs::{self, OpenOptions},
    io,
    path::Path,
};

pub fn apply(directory: &Path, request: &Value) -> Result<Value, String> {
    if serde_json::to_vec(request)
        .map_err(|_| "Invalid operation")?
        .len()
        > 65536
    {
        return Err("Invalid operation".into());
    }
    let op = request
        .get("op")
        .and_then(Value::as_str)
        .ok_or("Invalid operation")?;
    let mut dirs = fs::DirBuilder::new();
    dirs.recursive(true);
    #[cfg(unix)]
    dirs.mode(0o700);
    dirs.create(directory).map_err(|_| "State unavailable")?;
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    options.mode(0o600);
    let lock = options
        .open(directory.join("task-recovery.json.lock"))
        .map_err(|_| "State unavailable")?;
    lock.lock_exclusive().map_err(|_| "State unavailable")?;
    let path = directory.join("task-recovery.json");
    let mut record = match fs::read(&path) {
        Ok(bytes) => {
            if bytes.len() > 512 * 1024 {
                return Err("Invalid recovery state".into());
            }
            let value: Value =
                serde_json::from_slice(&bytes).map_err(|_| "Invalid recovery state")?;
            if !value.is_object() || value.get("version").and_then(Value::as_i64) != Some(1) {
                return Err("Invalid recovery state".into());
            }
            Some(value)
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => None,
        Err(_) => return Err("State unavailable".into()),
    };
    if let Some(value) = record.as_mut() {
        if value.as_object_mut().unwrap().remove("task").is_some() {
            atomic_write_standard(&path, format!("{}\n", value).as_bytes())
                .map_err(|_| "State unavailable")?;
        }
    }
    let mut save = false;
    let result = match op {
        "begin" => {
            let id = request
                .get("id")
                .and_then(Value::as_str)
                .filter(|v| !v.is_empty())
                .ok_or("Invalid ID")?;
            let device = request.get("device").cloned().ok_or("Invalid device")?;
            let thread = request.get("thread").cloned().ok_or("Invalid thread")?;
            let receipt = match request.get("receiptId") {
                None | Some(Value::Null) => None,
                Some(Value::String(value))
                    if value.len() == 32 && value.bytes().all(|b| b.is_ascii_hexdigit()) =>
                {
                    Some(value.clone())
                }
                _ => return Err("Invalid receipt ID".into()),
            };
            let mut next = json!({"version":1,"id":id,"device":device,"thread":thread,"status":"active","startup_attempts":0,"blocked_attempts":0});
            if let Some(receipt) = receipt {
                next["receiptId"] = json!(receipt);
            }
            record = Some(next);
            save = true;
            json!(id)
        }
        "current" => record.clone().unwrap_or(Value::Null),
        "finish" => {
            let identity = request.get("identity").cloned().unwrap_or(Value::Null);
            if let Some(value) = record.as_mut().filter(|r| r.get("id") == Some(&identity)) {
                value["status"] = request.get("status").cloned().unwrap_or(Value::Null);
                save = true;
                json!(true)
            } else {
                json!(false)
            }
        }
        "reserve" => {
            let kind = request
                .get("kind")
                .and_then(Value::as_str)
                .ok_or("Invalid recovery kind")?;
            if kind != "startup" && kind != "blocked" {
                return Err("Invalid recovery kind".into());
            }
            let field = format!("{kind}_attempts");
            if let Some(value) = record.as_mut() {
                let identity = request.get("identity").filter(|v| !v.is_null());
                let attempts = match value.get(&field) {
                    None => 0,
                    Some(v) => v.as_i64().ok_or("Invalid recovery state")?,
                };
                if value.get("status").and_then(Value::as_str) != Some("active")
                    || identity.is_some_and(|id| value.get("id") != Some(id))
                    || attempts >= 1
                {
                    Value::Null
                } else {
                    if !["id", "thread"].iter().all(|k| {
                        value
                            .get(k)
                            .and_then(Value::as_str)
                            .is_some_and(|v| !v.is_empty())
                    }) || !matches!(
                        value.get("device").and_then(Value::as_str),
                        Some("mac" | "phone")
                    ) {
                        return Err("Invalid recovery state".into());
                    }
                    value[&field] = json!(attempts + 1);
                    save = true;
                    value.clone()
                }
            } else {
                Value::Null
            }
        }
        _ => return Err("Invalid operation".into()),
    };
    if save {
        atomic_write_standard(&path, format!("{}\n", record.as_ref().unwrap()).as_bytes())
            .map_err(|_| "State unavailable")?;
    }
    let _ = FileExt::unlock(&lock);
    Ok(result)
}
