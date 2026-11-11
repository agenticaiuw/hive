//! SQLite persistence for sourced personal-memory tool records.
use rusqlite::{types::ValueRef, Connection};
use serde_json::{json, Value};
use std::fs::{self, OpenOptions};
use std::path::Path;
use std::time::Duration;

pub fn execute(state: &Path, request: &Value) -> Result<Value, String> {
    let op = request
        .get("op")
        .and_then(Value::as_str)
        .ok_or("Invalid memory operation")?;
    let directory = state.join("memory");
    let database = directory.join("personal-memory.sqlite3");
    if op == "list" && !database.exists() {
        return Ok(json!({"content": [{"type":"text", "text":"No memories stored yet."}]}));
    }
    if op == "add" {
        let statement = request
            .get("statement")
            .and_then(Value::as_str)
            .ok_or("Invalid statement")?;
        let source = request
            .get("source")
            .and_then(Value::as_str)
            .ok_or("Invalid source")?;
        let kind = request
            .get("kind")
            .and_then(Value::as_str)
            .ok_or("Invalid kind")?;
        if statement.trim().is_empty()
            || statement.chars().count() > 2000
            || source.trim().is_empty()
            || source.chars().count() > 1024
            || !["fact", "inference", "question"].contains(&kind)
        {
            return Err("Invalid memory record".into());
        }
        fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
            fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))
                .map_err(|e| e.to_string())?;
            OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(false)
                .mode(0o600)
                .open(&database)
                .map_err(|e| e.to_string())?;
        }
        #[cfg(not(unix))]
        OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(false)
            .open(&database)
            .map_err(|e| e.to_string())?;
    } else if op != "list" {
        return Err("Invalid memory operation".into());
    }
    let mut db = Connection::open(&database).map_err(|e| e.to_string())?;
    db.busy_timeout(Duration::from_secs(5))
        .map_err(|e| e.to_string())?;
    db.execute("CREATE TABLE IF NOT EXISTS memories (id INTEGER PRIMARY KEY, statement TEXT NOT NULL, source TEXT NOT NULL, kind TEXT NOT NULL, observed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(statement, source, kind))", []).map_err(|e| e.to_string())?;
    let transaction = db.transaction().map_err(|e| e.to_string())?;
    if op == "add" {
        transaction
            .execute(
                "INSERT OR IGNORE INTO memories(statement, source, kind) VALUES (?, ?, ?)",
                [
                    request["statement"].as_str().unwrap().trim(),
                    request["source"].as_str().unwrap().trim(),
                    request["kind"].as_str().unwrap(),
                ],
            )
            .map_err(|e| e.to_string())?;
    }
    let mut stmt = transaction.prepare("SELECT id, statement, source, kind, observed_at FROM memories ORDER BY id DESC LIMIT 100").map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            (0..5)
                .map(|i| match row.get_ref(i)? {
                    ValueRef::Null => Ok(Value::Null),
                    ValueRef::Integer(v) => Ok(json!(v)),
                    ValueRef::Real(v) => Ok(json!(v)),
                    ValueRef::Text(v) => std::str::from_utf8(v).map(|s| json!(s)).map_err(|e| {
                        rusqlite::Error::FromSqlConversionFailure(
                            i,
                            rusqlite::types::Type::Text,
                            Box::new(e),
                        )
                    }),
                    ValueRef::Blob(_) => Err(rusqlite::Error::InvalidColumnType(
                        i,
                        "blob".into(),
                        rusqlite::types::Type::Blob,
                    )),
                })
                .collect::<rusqlite::Result<Vec<_>>>()
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    drop(stmt);
    transaction.commit().map_err(|e| e.to_string())?;
    let text = serde_json::to_string(&rows).map_err(|e| e.to_string())?;
    Ok(json!({"content": [{"type":"text", "text":text}]}))
}
