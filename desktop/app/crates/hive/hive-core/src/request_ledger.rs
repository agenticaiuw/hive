//! Private durable admissions. Never replay a receipt whose outcome is uncertain.
use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use fs4::FileExt;
use regex::Regex;
use rusqlite::{params, Connection, OpenFlags};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
#[cfg(unix)]
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::Path,
    sync::OnceLock,
    time::Duration,
};

const KEY: &str = "request-ledger.key";
const DB: &str = "request-ledger.sqlite3";
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
fn random<const N: usize>() -> Result<[u8; N], String> {
    let mut bytes = [0; N];
    getrandom::fill(&mut bytes).map_err(|_| "Random source unavailable")?;
    Ok(bytes)
}
fn sensitive(text: &str) -> bool {
    static FILTER: OnceLock<Regex> = OnceLock::new();
    FILTER.get_or_init(|| Regex::new(r"(?i)(\b(?:password|passwd|passcode|passkey|pin|otp|one[ -]time|secret|credential|authorization|bearer|token|access[ _-]?token|refresh[ _-]?token|private[ _-]?key|api[ _-]?key)\b|\b(?:sk|ghp|github_pat)[-_][a-z0-9_-]{12,}\b|\b[a-z0-9+/=_-]{40,}\b)").unwrap()).is_match(text)
}
fn private_file(path: &Path, create: bool) -> Result<File, String> {
    let mut options = OpenOptions::new();
    options.read(true).write(create);
    if create {
        options.create_new(true);
    }
    #[cfg(unix)]
    {
        options.mode(0o600);
    }
    let file = options.open(path).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        let m = file.metadata().map_err(|e| e.to_string())?;
        if !m.is_file() || m.uid() != unsafe { libc::getuid() } || m.mode() & 0o077 != 0 {
            return Err("Unsafe ledger file permissions".into());
        }
    }
    Ok(file)
}
fn key(directory: &Path, allow_create: bool) -> Result<[u8; 32], String> {
    let lock_path = directory.join("request-ledger.key.lock");
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        options.mode(0o600);
    }
    let lock = options.open(lock_path).map_err(|e| e.to_string())?;
    lock.lock_exclusive().map_err(|e| e.to_string())?;
    let path = directory.join(KEY);
    let mut file = match private_file(&path, false) {
        Ok(f) => f,
        Err(_) if !path.exists() && allow_create => {
            let mut f = private_file(&path, true)?;
            let secret = random::<32>()?;
            f.write_all(&secret)
                .and_then(|_| f.sync_all())
                .map_err(|e| e.to_string())?;
            File::open(directory)
                .and_then(|f| f.sync_all())
                .map_err(|e| e.to_string())?;
            drop(f);
            private_file(&path, false)?
        }
        Err(e) => return Err(e),
    };
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    let secret: [u8; 32] = bytes.try_into().map_err(|_| "Invalid ledger key")?;
    let _ = FileExt::unlock(&lock);
    Ok(secret)
}
fn database(directory: &Path) -> Result<Connection, String> {
    fs::create_dir_all(directory).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    fs::set_permissions(directory, fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
    let path = directory.join(DB);
    if !path.exists() {
        match private_file(&path, true) {
            Ok(_) => {
                File::open(directory)
                    .and_then(|f| f.sync_all())
                    .map_err(|e| e.to_string())?;
            }
            Err(_) if path.exists() => (),
            Err(e) => return Err(e),
        }
    }
    let _ = private_file(&path, false)?;
    let db = Connection::open(path).map_err(|e| e.to_string())?;
    db.busy_timeout(Duration::from_secs(5))
        .map_err(|e| e.to_string())?;
    db.execute_batch("PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS receipts (source_hash BLOB PRIMARY KEY, receipt TEXT NOT NULL, status TEXT NOT NULL, nonce BLOB, ciphertext BLOB, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)").map_err(|e| e.to_string())?;
    Ok(db)
}
/// Open an existing ledger without changing permissions, schema, or files.
fn database_readonly(directory: &Path) -> Result<Connection, String> {
    let path = directory.join(DB);
    let _ = private_file(&path, false)?;
    let db = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| e.to_string())?;
    db.busy_timeout(Duration::from_secs(5))
        .map_err(|e| e.to_string())?;
    Ok(db)
}

/// Committed rows require an already-persisted key; inspection never creates a lock or key.
fn key_readonly(directory: &Path) -> Result<[u8; 32], String> {
    let file = private_file(&directory.join(KEY), false)?;
    let mut bytes = Vec::new();
    file.take(33)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    bytes.try_into().map_err(|_| "Invalid ledger key".into())
}

pub struct Receipt {
    pub id: String,
    pub duplicate: bool,
    pub status: String,
}
pub fn admit(
    directory: &Path,
    source: Option<&str>,
    text: &str,
    objective: Option<&str>,
) -> Result<Receipt, String> {
    let source = match source {
        Some(s)
            if !s.is_empty()
                && s.len() <= 256
                && s.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b)) =>
        {
            s.to_owned()
        }
        Some(_) => return Err("Invalid source ID".into()),
        None => format!("local:{}", hex(&random::<16>()?)),
    };
    let mut db = database(directory)?;
    let hash = Sha256::digest(source.as_bytes()).to_vec();
    let transaction = db
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    // Hold the admission lock while deciding whether a missing key may be created.
    let has_rows: bool = transaction
        .query_row("SELECT EXISTS(SELECT 1 FROM receipts)", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let secret = key(directory, !has_rows)?;
    let existing = transaction.query_row(
        "SELECT receipt,status FROM receipts WHERE source_hash=?1",
        [&hash],
        |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
    );
    match existing {
        Ok((id, status)) => {
            return Ok(Receipt {
                id,
                duplicate: true,
                status,
            })
        }
        Err(rusqlite::Error::QueryReturnedNoRows) => (),
        Err(e) => return Err(e.to_string()),
    }
    let id = hex(&random::<16>()?);
    let (nonce, ciphertext) = if sensitive(text) || objective.is_some_and(sensitive) {
        (None, None)
    } else {
        let material = serde_json::to_vec(&json!({"text":text,"goalObjective":objective}))
            .map_err(|_| "Invalid task")?;
        let nonce = random::<12>()?;
        let cipher = Aes256Gcm::new_from_slice(&secret).map_err(|_| "Invalid encryption key")?;
        let encrypted = cipher
            .encrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: &material,
                    aad: &hash,
                },
            )
            .map_err(|_| "Encryption failed")?;
        (Some(nonce.to_vec()), Some(encrypted))
    };
    transaction.execute("INSERT INTO receipts(source_hash,receipt,status,nonce,ciphertext) VALUES (?1,?2,'dispatching',?3,?4)", params![hash,id,nonce,ciphertext]).map_err(|e| e.to_string())?;
    transaction.commit().map_err(|e| e.to_string())?;
    Ok(Receipt {
        id,
        duplicate: false,
        status: "dispatching".into(),
    })
}
pub fn finish(directory: &Path, id: &str, status: &str) -> Result<(), String> {
    if !["accepted", "rejected", "unknown"].contains(&status) {
        return Err("Invalid status".into());
    }
    let db = database(directory)?;
    if db
        .execute(
            "UPDATE receipts SET status=?1 WHERE receipt=?2 AND status='dispatching'",
            params![status, id],
        )
        .map_err(|e| e.to_string())?
        != 1
    {
        return Err("Receipt unavailable".into());
    }
    Ok(())
}
pub fn list(directory: &Path) -> Result<Value, String> {
    Ok(list_page(directory, None, 100)?.0)
}

/// Descending insertion-order pages; start a fresh scan to observe later mutations.
pub fn list_page(
    directory: &Path,
    before: Option<i64>,
    limit: usize,
) -> Result<(Value, Option<i64>), String> {
    if !(1..=100).contains(&limit) || before.is_some_and(|n| n <= 0) {
        return Err("Invalid cursor".into());
    }
    let db = database_readonly(directory)?;
    let secret = key_readonly(directory)?;
    let has_rows: bool = db
        .query_row("SELECT EXISTS(SELECT 1 FROM receipts)", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if !has_rows {
        return Ok((json!([]), None));
    }
    let cipher = Aes256Gcm::new_from_slice(&secret).map_err(|_| "Invalid key")?;
    let mut stmt = db.prepare("SELECT source_hash,receipt,status,nonce,ciphertext,created_at,rowid FROM receipts WHERE rowid < ?1 ORDER BY rowid DESC LIMIT ?2").map_err(|e| e.to_string())?;
    let mut rows = stmt
        .query(params![before.unwrap_or(i64::MAX), (limit + 1) as i64])
        .map_err(|e| e.to_string())?;
    let mut output = Vec::new();
    let mut last_rowid = None;
    let mut more = false;
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        if output.len() == limit {
            more = true;
            break;
        }
        last_rowid = Some(row.get::<_, i64>(6).map_err(|e| e.to_string())?);
        let hash: Vec<u8> = row.get(0).map_err(|e| e.to_string())?;
        let nonce: Option<Vec<u8>> = row.get(3).map_err(|e| e.to_string())?;
        let ciphertext: Option<Vec<u8>> = row.get(4).map_err(|e| e.to_string())?;
        let material: Option<Value> = match (nonce, ciphertext) {
            (None, None) => None,
            (Some(n), Some(c)) if n.len() == 12 => {
                let plaintext = cipher
                    .decrypt(
                        Nonce::from_slice(&n),
                        Payload {
                            msg: &c,
                            aad: &hash,
                        },
                    )
                    .map_err(|_| "Decryption failed")?;
                Some(serde_json::from_slice(&plaintext).map_err(|_| "Invalid encrypted record")?)
            }
            _ => return Err("Invalid encrypted record".into()),
        };
        output.push(json!({"receiptId":row.get::<_,String>(1).map_err(|e| e.to_string())?, "status":row.get::<_,String>(2).map_err(|e| e.to_string())?, "createdAt":row.get::<_,String>(5).map_err(|e| e.to_string())?, "text":material.as_ref().and_then(|v| v.get("text")), "goalObjective":material.as_ref().and_then(|v| v.get("goalObjective")), "textOmitted":material.is_none()}));
    }
    Ok((json!(output), if more { last_rowid } else { None }))
}
