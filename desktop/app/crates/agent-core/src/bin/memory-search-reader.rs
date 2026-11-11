//! Read candidate memory rows only; caller retains all query and disclosure filters.
use rusqlite::{params_from_iter, types::ValueRef, Connection, OpenFlags};
use serde_json::{json, Value};
use std::{env, io, path::Path, process, time::Duration};
fn run(path: &Path, request: Value) -> Result<Value, String> {
    let mode = request
        .get("mode")
        .and_then(Value::as_str)
        .ok_or("Invalid mode")?;
    let terms = request
        .get("terms")
        .and_then(Value::as_array)
        .ok_or("Invalid terms")?;
    if terms.is_empty() || terms.len() > 12 {
        return Err("Invalid terms".into());
    }
    let terms: Vec<&str> = terms
        .iter()
        .map(|v| v.as_str().ok_or("Invalid term".to_owned()))
        .collect::<Result<_, _>>()?;
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| e.to_string())?;
    conn.busy_timeout(Duration::from_secs(1))
        .map_err(|e| e.to_string())?;
    let (clauses, args, limit) = match mode {
        "search" if terms.len() <= 6 => {
            let mut args = Vec::new();
            for term in &terms {
                let escaped = term
                    .replace('\\', "\\\\")
                    .replace('%', "\\%")
                    .replace('_', "\\_");
                let pattern = format!("%{escaped}%");
                args.push(pattern.clone());
                args.push(pattern);
            }
            (
                vec![
                    "(lower(statement) LIKE ? ESCAPE '\\' OR lower(source) LIKE ? ESCAPE '\\')";
                    terms.len()
                ]
                .join(" AND "),
                args,
                30,
            )
        }
        "automatic" => (
            vec!["lower(statement) LIKE ?"; terms.len()].join(" OR "),
            terms.iter().map(|t| format!("%{t}%")).collect(),
            200,
        ),
        _ => return Err("Invalid mode".into()),
    };
    let query = format!("SELECT statement, source, kind, observed_at FROM memories WHERE {clauses} ORDER BY observed_at DESC, id DESC LIMIT {limit}");
    let mut stmt = conn.prepare(&query).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params_from_iter(args), |row| {
            (0..4)
                .map(|i| {
                    Ok(match row.get_ref(i)? {
                        ValueRef::Null | ValueRef::Blob(_) => Value::Null,
                        ValueRef::Integer(v) => json!(v),
                        ValueRef::Real(v) => json!(v),
                        ValueRef::Text(v) => match std::str::from_utf8(v) {
                            Ok(s) => json!(s),
                            Err(_) => return Err(rusqlite::Error::InvalidQuery),
                        },
                    })
                })
                .collect::<rusqlite::Result<Vec<_>>>()
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    Ok(json!(rows))
}
fn main() {
    let mut args = env::args_os();
    args.next();
    let Some(path) = args.next() else {
        process::exit(2)
    };
    if args.next().is_some() {
        process::exit(2)
    }
    let value = serde_json::from_reader(io::stdin().lock())
        .map_err(|_| "Invalid request".to_owned())
        .and_then(|v| run(Path::new(&path), v));
    match value {
        Ok(value) => {
            if serde_json::to_writer(io::stdout().lock(), &value).is_err() {
                process::exit(1);
            }
        }
        Err(_) => {
            eprintln!("Memory unavailable");
            process::exit(1)
        }
    }
}
