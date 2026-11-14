//! Sync: push this device's Hive data to its Hive Cloud, pull other devices' changes, restore
//! everything into a clean folder, and prove the cloud copy can be read back.
//!
//! A file becomes one record. Its bytes are cut into 1 MiB chunks, each encrypted and stored
//! under the SHA-256 of its ciphertext; the record's encrypted metadata lists the chunks. Chunks
//! travel in packs of up to 8 MiB, so thousands of small files take a few requests. Writes are
//! compare-and-set on the record version. When two devices change the same path, nothing is
//! lost: the other version is kept beside it under a `.conflict-`, `.from-cloud-` or
//! `.before-cloud-` name. Deleting a file writes a tombstone; the cloud keeps the previous
//! version for 30 days.
use crate::api::{ApiError, Client, NOT_HIVE};
use crate::config::{cloud_dir, now_ms, write_private, Config, Secrets};
use crate::crypto::{self, Keys, CHUNK};
use crate::scan::{self, Item, Kind, Root};
use ring::digest;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::{Read, Write};
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// The server takes packs of up to 8 MiB, headers included.
const PACK_BYTES: usize = 8 * 1024 * 1024 - 64 * 1024;
/// With R2, the server stores at most 40 new chunks per request (each R2 call is a subrequest).
const R2_PACK_COUNT: usize = 40;
/// How much is buffered before uploading, and fetched at once when downloading.
const WINDOW: usize = 32 * 1024 * 1024;
const PARALLEL: usize = 4;
const RECORDS_PER_POST: usize = 200;
const RECORD_POST_BYTES: usize = 3_000_000;

pub struct Engine {
    pub config: Config,
    pub keys: Keys,
    pub api: Client,
    pub db: Connection,
    pub roots: Vec<Root>,
}

#[derive(Clone, Debug, Default)]
struct Row {
    record_id: String,
    version: i64,
    sha256: String,
    size: i64,
    mtime_ns: i64,
    deleted: bool,
}

#[derive(Default, Debug)]
pub struct PushReport {
    pub scanned: usize,
    pub uploaded_files: usize,
    pub new_bytes: u64,
    pub unchanged: usize,
    pub deleted: usize,
    pub conflicts: Vec<String>,
    pub waiting_files: usize,
    pub waiting_bytes: u64,
    pub errors: Vec<String>,
    pub verified: bool,
    pub excluded: BTreeMap<&'static str, (u64, u64)>,
}

#[derive(Default, Debug)]
pub struct PullReport {
    pub applied: usize,
    pub deleted: usize,
    pub conflicts: Vec<String>,
    pub errors: Vec<String>,
}

#[derive(Default, Debug)]
pub struct RestoreReport {
    pub files: usize,
    pub bytes: u64,
    pub symlinks: usize,
    pub tombstones: usize,
    pub by_root: BTreeMap<String, (usize, u64)>,
    pub failures: Vec<String>,
}

pub struct PushOptions {
    pub allow_mass_delete: bool,
    pub max_new_bytes: Option<u64>,
}

struct Pending {
    change: Value,
    rel: String,
    row: Row,
    meta: Value,
}

enum Prepared {
    Unchanged(Row),
    Change(Box<Pending>),
    NoSpace,
}

struct Job {
    meta: Value,
    dest: PathBuf,
}

pub fn open_db(path: &Path) -> Result<Connection, String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("creating {}: {e}", dir.display()))?;
    }
    let db = Connection::open(path).map_err(|e| format!("opening {}: {e}", path.display()))?;
    db.execute_batch(
        "PRAGMA journal_mode = WAL;
         CREATE TABLE IF NOT EXISTS files (rel TEXT PRIMARY KEY, record_id TEXT NOT NULL, version INTEGER NOT NULL,
           sha256 TEXT NOT NULL, size INTEGER NOT NULL, mtime_ns INTEGER NOT NULL, deleted INTEGER NOT NULL, synced_at INTEGER NOT NULL);
         CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);",
    )
    .map_err(|e| format!("preparing the sync database: {e}"))?;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    Ok(db)
}

pub fn host_of(url: &str) -> String {
    url.split("://").nth(1).unwrap_or(url).trim_end_matches('/').to_string()
}

fn api_err(e: ApiError) -> String {
    e.to_string()
}

fn mtime_of(m: &std::fs::Metadata) -> i64 {
    m.mtime() * 1_000_000_000 + m.mtime_nsec()
}

impl Engine {
    pub fn load() -> Result<Engine, String> {
        let config = Config::load()?.ok_or("This device is not connected to a Hive Cloud yet.")?;
        let host = host_of(&config.url);
        let secrets = Secrets::system();
        let token = secrets.get(&host, "device-token")?;
        let key = crypto::unhex(&secrets.get(&host, "account-key")?).ok_or("the saved account key is damaged")?;
        let master: [u8; 32] = key.try_into().map_err(|_| "the saved account key has the wrong length")?;
        let keys = Keys::new(master);
        if keys.check() != config.key_check {
            return Err("the saved account key does not match this Hive Cloud".into());
        }
        let api = Client::new(&config.url, Some(token))?;
        let db = open_db(&cloud_dir().join("sync.sqlite3"))?;
        Ok(Engine { config, keys, api, db, roots: scan::roots() })
    }

    // ---- local bookkeeping -------------------------------------------------------------------

    fn rows(&self) -> Result<HashMap<String, Row>, String> {
        let mut stmt = self
            .db
            .prepare("SELECT rel, record_id, version, sha256, size, mtime_ns, deleted FROM files")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    Row {
                        record_id: r.get(1)?,
                        version: r.get(2)?,
                        sha256: r.get(3)?,
                        size: r.get(4)?,
                        mtime_ns: r.get(5)?,
                        deleted: r.get::<_, i64>(6)? != 0,
                    },
                ))
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<HashMap<_, _>, _>>().map_err(|e| e.to_string())
    }

    fn save_row(&self, rel: &str, row: &Row) -> Result<(), String> {
        self.db
            .execute(
                "INSERT INTO files (rel, record_id, version, sha256, size, mtime_ns, deleted, synced_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                 ON CONFLICT(rel) DO UPDATE SET record_id = ?2, version = ?3, sha256 = ?4, size = ?5, mtime_ns = ?6, deleted = ?7, synced_at = ?8",
                params![rel, row.record_id, row.version, row.sha256, row.size, row.mtime_ns, row.deleted as i64, now_ms()],
            )
            .map(|_| ())
            .map_err(|e| format!("saving sync state: {e}"))
    }

    pub fn kv(&self, k: &str) -> Option<String> {
        self.db.query_row("SELECT v FROM kv WHERE k = ?1", [k], |r| r.get(0)).optional().ok().flatten()
    }

    pub fn set_kv(&self, k: &str, v: &str) -> Result<(), String> {
        self.db
            .execute("INSERT INTO kv (k, v) VALUES (?1, ?2) ON CONFLICT(k) DO UPDATE SET v = ?2", params![k, v])
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    /// True until this device has pulled from the cloud and synced anything.
    pub fn first_sync(&self) -> bool {
        self.kv("cursor").is_none() && self.db.query_row("SELECT COUNT(*) FROM files", [], |r| r.get::<_, i64>(0)).unwrap_or(0) == 0
    }

    // ---- push --------------------------------------------------------------------------------

    pub fn push(&self, opts: &PushOptions) -> Result<PushReport, String> {
        let scan = scan::scan(&self.roots);
        let mut report = PushReport { scanned: scan.items.len(), excluded: scan.excluded.clone(), ..Default::default() };
        let rows = self.rows()?;
        // Files that came from outside another device's state folder keep their cloud names.
        let relocated = self.relocated(&rows);
        let back: HashMap<&str, &str> = relocated.iter().map(|(local, cloud)| (cloud.as_str(), local.as_str())).collect();
        let items: Vec<scan::Item> = scan
            .items
            .iter()
            .map(|i| match relocated.get(&i.rel) {
                Some(cloud) => scan::Item { rel: cloud.clone(), ..i.clone() },
                None => i.clone(),
            })
            .collect();
        let present: HashSet<&str> = items.iter().map(|i| i.rel.as_str()).collect();

        let deletions: Vec<(String, Row)> = rows
            .iter()
            .filter(|(rel, row)| !row.deleted && row.size >= 0 && !present.contains(rel.as_str()))
            .filter(|(rel, _)| {
                let local = back.get(rel.as_str()).copied().unwrap_or(rel.as_str());
                let root = local.split('/').next().unwrap_or("");
                let configured = self.roots.iter().any(|r| r.name == root);
                configured && !scan.missing_roots.iter().any(|m| m == root) && !excluded_now(local)
            })
            .map(|(rel, row)| (rel.clone(), row.clone()))
            .collect();
        let live = rows.values().filter(|r| !r.deleted).count();
        if deletions.len() > 20 && deletions.len() * 4 > live && !opts.allow_mass_delete {
            return Err(format!(
                "{} of {} synced files are gone from this device at once. Sync stopped so the cloud copy is not deleted. \
                 If you meant to delete them, run `hive-cloud push --allow-mass-delete`.",
                deletions.len(),
                live
            ));
        }

        let server = self.api.get("/v1/status").map_err(api_err)?;
        let used = server["storage"]["usedBytes"].as_u64().unwrap_or(0);
        let mut budget = match server["storage"]["capacityBytes"].as_u64() {
            Some(cap) => (cap / 100 * 95).saturating_sub(used),
            None => u64::MAX,
        };
        if let Some(max) = opts.max_new_bytes {
            budget = budget.min(max);
        }
        let per_pack = if server["storage"]["backend"] == "r2" { R2_PACK_COUNT } else { 5000 };
        let mut up = Uploader::new(&self.api, budget, per_pack);

        let mut pending: Vec<Pending> = Vec::new();
        let mut written: Vec<(String, i64, Vec<String>)> = Vec::new();
        let mut out_of_space = false;
        for item in &items {
            let row = rows.get(&item.rel);
            if let Some(row) = row {
                if !row.deleted && row.size == item.size as i64 && row.mtime_ns == item.mtime_ns {
                    report.unchanged += 1;
                    continue;
                }
            }
            if out_of_space {
                report.waiting_files += 1;
                report.waiting_bytes += item.size;
                continue;
            }
            match self.prepare_item(item, row, &mut up) {
                Ok(Prepared::Unchanged(row)) => {
                    self.save_row(&item.rel, &row)?;
                    report.unchanged += 1;
                }
                Ok(Prepared::Change(p)) => {
                    pending.push(*p);
                    let bytes: usize = pending.iter().map(|p| p.change["meta"].as_str().map(str::len).unwrap_or(0) + 200).sum();
                    if pending.len() >= RECORDS_PER_POST || bytes > RECORD_POST_BYTES {
                        up.flush()?;
                        self.post_records(&mut pending, &mut report, &mut written)?;
                    }
                }
                Ok(Prepared::NoSpace) => {
                    out_of_space = true;
                    report.waiting_files += 1;
                    report.waiting_bytes += item.size;
                }
                Err(e) => report.errors.push(format!("{}: {e}", item.rel)),
            }
        }
        for (rel, row) in &deletions {
            let meta = json!({ "v": 1, "path": rel, "deleted": true, "device": self.config.device_id });
            pending.push(Pending {
                change: json!({
                    "id": row.record_id, "baseVersion": row.version, "deleted": true, "size": 0,
                    "meta": self.keys.seal_meta(&row.record_id, meta.to_string().as_bytes()),
                }),
                rel: rel.clone(),
                row: Row { deleted: true, ..row.clone() },
                meta,
            });
            if pending.len() >= RECORDS_PER_POST {
                up.flush()?;
                self.post_records(&mut pending, &mut report, &mut written)?;
            }
        }
        up.flush()?;
        self.post_records(&mut pending, &mut report, &mut written)?;
        report.new_bytes = up.new_bytes;
        report.deleted = deletions.len();
        report.verified = report.errors.is_empty() && self.verify_written(&written, &rows)?;
        let now = now_ms();
        self.set_kv("last_push_at", &now.to_string())?;
        if report.verified && report.waiting_files == 0 {
            self.set_kv("last_verified_sync_at", &now.to_string())?;
        }
        self.remember_conflicts(&report.conflicts)?;
        Ok(report)
    }

    fn remember_conflicts(&self, new: &[String]) -> Result<(), String> {
        if new.is_empty() {
            return Ok(());
        }
        let mut all: Vec<String> = serde_json::from_str(&self.kv("conflicts").unwrap_or_else(|| "[]".into())).unwrap_or_default();
        all.extend(new.iter().cloned());
        let keep = all.len().saturating_sub(50);
        self.set_kv("conflicts", &serde_json::to_string(&all[keep..]).unwrap())
    }

    fn prepare_item(&self, item: &Item, row: Option<&Row>, up: &mut Uploader) -> Result<Prepared, String> {
        let record_id = self.keys.record_id(&item.rel);
        let mut meta = json!({
            "v": 1, "path": item.rel, "mtimeNs": item.mtime_ns, "mode": item.mode,
            "device": self.config.device_id,
        });
        let (sha, chunks, size, cipher_size) = match &item.kind {
            Kind::Symlink(target) => {
                meta["kind"] = json!("symlink");
                meta["target"] = json!(target);
                (crypto::sha256_hex(target.as_bytes()), Vec::new(), 0, 0)
            }
            Kind::File | Kind::Sqlite => {
                meta["kind"] = json!(if item.kind == Kind::Sqlite { "sqlite" } else { "file" });
                let snapshot;
                let source: &Path = if item.kind == Kind::Sqlite {
                    snapshot = sqlite_snapshot(&item.abs)?;
                    snapshot.path()
                } else {
                    &item.abs
                };
                let size = std::fs::metadata(source).map(|m| m.len()).map_err(|e| format!("reading: {e}"))?;
                if !up.reserve(size + 28 * size.div_ceil(CHUNK as u64)) {
                    return Ok(Prepared::NoSpace);
                }
                let (sha, chunks, cipher) = self.encrypt_file(source, up)?;
                (sha, chunks, size, cipher)
            }
        };
        if let Some(row) = row {
            if !row.deleted && row.sha256 == sha && row.record_id == record_id && row.version > 0 {
                return Ok(Prepared::Unchanged(Row { size: item.size as i64, mtime_ns: item.mtime_ns, ..row.clone() }));
            }
        }
        meta["size"] = json!(size);
        meta["sha256"] = json!(sha);
        meta["chunks"] = json!(chunks.iter().map(|(h, n)| json!([h, n])).collect::<Vec<_>>());
        let blobs: Vec<String> = {
            let mut seen = HashSet::new();
            chunks.iter().filter(|(h, _)| seen.insert(h.clone())).map(|(h, _)| h.clone()).collect()
        };
        let base = row.filter(|r| r.record_id == record_id).map(|r| r.version).unwrap_or(0);
        let change = json!({
            "id": record_id, "baseVersion": base, "deleted": false, "blobs": blobs, "size": cipher_size,
            "meta": self.keys.seal_meta(&record_id, meta.to_string().as_bytes()),
        });
        let row = Row { record_id, version: base, sha256: sha, size: item.size as i64, mtime_ns: item.mtime_ns, deleted: false };
        Ok(Prepared::Change(Box::new(Pending { change, rel: item.rel.clone(), row, meta })))
    }

    /// Encrypt a file chunk by chunk into the uploader. Returns (SHA-256 of the plaintext,
    /// [(chunk hash, plaintext length)], ciphertext bytes).
    #[allow(clippy::type_complexity)]
    fn encrypt_file(&self, path: &Path, up: &mut Uploader) -> Result<(String, Vec<(String, usize)>, u64), String> {
        let mut file = std::fs::File::open(path).map_err(|e| format!("reading: {e}"))?;
        let mut whole = digest::Context::new(&digest::SHA256);
        let mut chunks = Vec::new();
        let mut cipher = 0u64;
        let mut buf = vec![0u8; CHUNK];
        loop {
            let n = read_full(&mut file, &mut buf).map_err(|e| format!("reading: {e}"))?;
            if n == 0 {
                break;
            }
            whole.update(&buf[..n]);
            let sealed = self.keys.seal_chunk(&buf[..n]);
            let hash = crypto::sha256_hex(&sealed);
            cipher += sealed.len() as u64;
            chunks.push((hash.clone(), n));
            up.add(hash, sealed)?;
            if n < CHUNK {
                break;
            }
        }
        Ok((crypto::hex(whole.finish().as_ref()), chunks, cipher))
    }

    fn post_records(&self, pending: &mut Vec<Pending>, report: &mut PushReport, written: &mut Vec<(String, i64, Vec<String>)>) -> Result<(), String> {
        let mut retry: Vec<Pending> = Vec::new();
        for round in 0..3 {
            if pending.is_empty() {
                break;
            }
            let changes: Vec<Value> = pending.iter().map(|p| p.change.clone()).collect();
            let res = self.api.post("/v1/records", &json!({ "changes": changes })).map_err(api_err)?;
            let results = res["results"].as_array().cloned().unwrap_or_default();
            if results.len() != pending.len() {
                return Err("the cloud answered a different number of records than were sent".into());
            }
            for (p, r) in pending.drain(..).zip(results) {
                if r["ok"] == json!(true) {
                    let version = r["version"].as_i64().unwrap_or(0);
                    self.save_row(&p.rel, &Row { version, ..p.row.clone() })?;
                    let blobs = p.change["blobs"].as_array().into_iter().flatten().filter_map(|b| b.as_str().map(String::from)).collect();
                    written.push((p.row.record_id.clone(), version, blobs));
                    if !p.row.deleted {
                        report.uploaded_files += 1;
                    }
                } else if r["error"] == "conflict" && round < 2 {
                    let current = r["current"].clone();
                    let current_version = current["version"].as_i64().unwrap_or(0);
                    let current_deleted = current["deleted"] == json!(true);
                    let remote: Option<Value> = if current.is_null() {
                        None
                    } else {
                        let plain = self.keys.open_meta(&p.row.record_id, current["meta"].as_str().unwrap_or(""))?;
                        serde_json::from_slice(&plain).ok()
                    };
                    let same = (remote.as_ref().is_some_and(|m| m["sha256"] == p.meta["sha256"]) && !current_deleted)
                        || (p.row.deleted && current_deleted);
                    if same {
                        self.save_row(&p.rel, &Row { version: current_version, ..p.row.clone() })?;
                        continue;
                    }
                    if let (Some(mut remote_meta), false) = (remote, current_deleted) {
                        let who: String = remote_meta["device"].as_str().unwrap_or("other").trim_start_matches("d_").chars().take(6).collect();
                        let copy = format!("{}.conflict-{}-{}", p.rel, who, now_ms());
                        let copy_id = self.keys.record_id(&copy);
                        remote_meta["path"] = json!(copy);
                        retry.push(Pending {
                            change: json!({
                                "id": copy_id, "baseVersion": 0, "deleted": false, "blobs": current["blobs"].clone(),
                                "size": current["size"].clone(), "meta": self.keys.seal_meta(&copy_id, remote_meta.to_string().as_bytes()),
                            }),
                            rel: copy.clone(),
                            row: Row {
                                record_id: copy_id,
                                version: 0,
                                sha256: remote_meta["sha256"].as_str().unwrap_or("").into(),
                                // Not on this device yet: the next pull brings it down.
                                size: -1,
                                mtime_ns: 0,
                                deleted: false,
                            },
                            meta: remote_meta,
                        });
                        report.conflicts.push(format!("{} (the other device's version is kept as {copy})", p.rel));
                    }
                    let mut again = p;
                    again.change["baseVersion"] = json!(current_version);
                    retry.push(again);
                } else {
                    report.errors.push(format!("{}: {}", p.rel, r["error"].as_str().unwrap_or("rejected")));
                }
            }
            pending.append(&mut retry);
        }
        for p in pending.drain(..) {
            report.errors.push(format!("{}: still conflicting after retries", p.rel));
        }
        Ok(())
    }

    /// Read back what this run wrote: every record at the version we hold and every chunk
    /// present. With nothing written, spot-check records this device synced earlier.
    fn verify_written(&self, written: &[(String, i64, Vec<String>)], rows: &HashMap<String, Row>) -> Result<bool, String> {
        let mut expect: Vec<(String, i64)> = written.iter().map(|(id, v, _)| (id.clone(), *v)).collect();
        if expect.is_empty() {
            expect = rows.values().filter(|r| r.version > 0).take(25).map(|r| (r.record_id.clone(), r.version)).collect();
        }
        for group in expect.chunks(200) {
            let ids: Vec<&str> = group.iter().map(|(id, _)| id.as_str()).collect();
            let res = self.api.get(&format!("/v1/records?ids={}", ids.join(","))).map_err(api_err)?;
            let found: HashMap<String, i64> = res["records"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|r| Some((r["id"].as_str()?.to_string(), r["version"].as_i64()?)))
                .collect();
            for (id, version) in group {
                match found.get(id) {
                    Some(v) if v >= version => {}
                    _ => {
                        // The cloud lost or never got this record: forget it so the next push sends it again.
                        self.db.execute("DELETE FROM files WHERE record_id = ?1", [id]).map_err(|e| e.to_string())?;
                        return Ok(false);
                    }
                }
            }
        }
        let blobs: Vec<String> = written.iter().flat_map(|(_, _, b)| b.iter().cloned()).collect::<HashSet<_>>().into_iter().collect();
        Ok(self.api.missing(&blobs).map_err(api_err)?.is_empty())
    }

    // ---- reading from the cloud --------------------------------------------------------------

    /// Every current record after `since`, decrypted. Returns them and the new cursor.
    fn changes_since(&self, since: i64) -> Result<(Vec<(Value, Value)>, i64), String> {
        let mut cursor = since;
        let mut out = Vec::new();
        loop {
            let page = self.api.get(&format!("/v1/changes?since={cursor}&limit=500")).map_err(api_err)?;
            for change in page["changes"].as_array().into_iter().flatten() {
                let id = change["id"].as_str().unwrap_or("");
                let meta: Value = serde_json::from_slice(&self.keys.open_meta(id, change["meta"].as_str().unwrap_or(""))?)
                    .map_err(|e| format!("record {id} has unreadable metadata: {e}"))?;
                out.push((change.clone(), meta));
            }
            cursor = page["next"].as_i64().unwrap_or(cursor);
            if page["hasMore"] != json!(true) {
                return Ok((out, cursor));
            }
        }
    }

    /// Fetch chunks in 8 MiB packs, several at once, checking each against its hash.
    fn fetch_chunks(&self, wanted: &[(String, usize)]) -> Result<HashMap<String, Vec<u8>>, String> {
        let mut seen = HashSet::new();
        let mut groups: Vec<Vec<String>> = Vec::new();
        let mut size = 0;
        for (hash, n) in wanted {
            if !seen.insert(hash.clone()) {
                continue;
            }
            if groups.is_empty() || size + n + 64 > PACK_BYTES || groups.last().unwrap().len() >= 1000 {
                groups.push(Vec::new());
                size = 0;
            }
            size += n + 64;
            groups.last_mut().unwrap().push(hash.clone());
        }
        let api = &self.api;
        let results: Vec<Result<Vec<(String, Vec<u8>)>, String>> = std::thread::scope(|s| {
            let groups = &groups;
            let handles: Vec<_> = (0..PARALLEL.min(groups.len()))
                .map(|t| {
                    s.spawn(move || {
                        let mut got = Vec::new();
                        for group in groups.iter().skip(t).step_by(PARALLEL) {
                            got.extend(fetch_group(api, group)?);
                        }
                        Ok(got)
                    })
                })
                .collect();
            handles.into_iter().map(|h| h.join().unwrap_or_else(|_| Err("download thread failed".into()))).collect()
        });
        let mut out = HashMap::new();
        for r in results {
            out.extend(r?);
        }
        Ok(out)
    }

    /// Write one record's content to `dest`, verifying every chunk and the whole file.
    fn download(&self, meta: &Value, dest: &Path, cache: &HashMap<String, Vec<u8>>) -> Result<u64, String> {
        let dir = dest.parent().ok_or("no parent folder")?;
        std::fs::create_dir_all(dir).map_err(|e| format!("creating {}: {e}", dir.display()))?;
        if meta["kind"] == "symlink" {
            let _ = std::fs::remove_file(dest);
            std::os::unix::fs::symlink(meta["target"].as_str().unwrap_or(""), dest).map_err(|e| format!("linking: {e}"))?;
            return Ok(0);
        }
        let chunks: Vec<(String, usize)> = meta["chunks"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|c| Some((c[0].as_str()?.to_string(), c[1].as_u64()? as usize)))
            .collect::<Option<_>>()
            .ok_or("the record's chunk list is damaged")?;
        let tmp = dir.join(format!(".{}.hive-cloud-{}", dest.file_name().and_then(|n| n.to_str()).unwrap_or("f"), std::process::id()));
        let result = (|| {
            let mut out = std::fs::File::create(&tmp).map_err(|e| format!("writing {}: {e}", tmp.display()))?;
            let mut whole = digest::Context::new(&digest::SHA256);
            let mut total = 0u64;
            let mut window: HashMap<String, Vec<u8>> = HashMap::new();
            for (i, (hash, _)) in chunks.iter().enumerate() {
                if !cache.contains_key(hash) && !window.contains_key(hash) {
                    let mut take = Vec::new();
                    let mut size = 0;
                    for (h, n) in &chunks[i..] {
                        if !take.is_empty() && size + n > WINDOW {
                            break;
                        }
                        if !cache.contains_key(h) {
                            take.push((h.clone(), *n));
                            size += n;
                        }
                    }
                    window = self.fetch_chunks(&take)?;
                }
                let sealed = cache.get(hash).or_else(|| window.get(hash)).ok_or_else(|| format!("chunk {hash} is missing from the cloud"))?;
                let plain = self.keys.open_chunk(sealed)?;
                whole.update(&plain);
                total += plain.len() as u64;
                out.write_all(&plain).map_err(|e| format!("writing: {e}"))?;
            }
            out.sync_all().map_err(|e| format!("writing: {e}"))?;
            if crypto::hex(whole.finish().as_ref()) != meta["sha256"].as_str().unwrap_or("") {
                return Err("the downloaded file does not match its recorded SHA-256".to_string());
            }
            Ok(total)
        })();
        let total = match result {
            Ok(t) => t,
            Err(e) => {
                let _ = std::fs::remove_file(&tmp);
                return Err(e);
            }
        };
        let mode = meta["mode"].as_u64().unwrap_or(0o600) as u32 & 0o777;
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(mode | 0o600));
        std::fs::rename(&tmp, dest).map_err(|e| format!("saving {}: {e}", dest.display()))?;
        Ok(total)
    }

    /// Download many records, small ones fetched together in packs.
    fn run_jobs(&self, jobs: Vec<Job>) -> Vec<(Job, Result<u64, String>)> {
        let small = |job: &Job| job.meta["size"].as_u64().unwrap_or(0) as usize <= PACK_BYTES;
        let run = |group: Vec<Job>, out: &mut Vec<(Job, Result<u64, String>)>| {
            let wanted: Vec<(String, usize)> = group
                .iter()
                .filter(|j| small(j))
                .flat_map(|j| j.meta["chunks"].as_array().cloned().unwrap_or_default())
                .filter_map(|c| Some((c[0].as_str()?.to_string(), c[1].as_u64()? as usize)))
                .collect();
            // If the batch fetch fails, each file fetches its own chunks and reports its own error.
            let cache = self.fetch_chunks(&wanted).unwrap_or_default();
            for job in group {
                let r = self.download(&job.meta, &job.dest, &cache);
                out.push((job, r));
            }
        };
        let mut out = Vec::new();
        let mut group: Vec<Job> = Vec::new();
        let mut group_bytes = 0usize;
        for job in jobs {
            let size = if small(&job) { job.meta["size"].as_u64().unwrap_or(0) as usize } else { 0 };
            if !group.is_empty() && (group_bytes + size > WINDOW || group.len() >= 2000) {
                run(std::mem::take(&mut group), &mut out);
                group_bytes = 0;
            }
            group_bytes += size;
            group.push(job);
        }
        if !group.is_empty() {
            run(group, &mut out);
        }
        out
    }

    /// Everything in the cloud, written fresh into `dir` (which must be empty or missing).
    pub fn restore(&self, dir: &Path) -> Result<RestoreReport, String> {
        if dir.exists() && std::fs::read_dir(dir).map(|mut d| d.next().is_some()).unwrap_or(true) {
            return Err(format!("{} is not empty; restore only into an empty folder", dir.display()));
        }
        let mut report = RestoreReport::default();
        let (changes, _) = self.changes_since(0)?;
        let mut jobs = Vec::new();
        for (change, meta) in changes {
            if change["deleted"] == json!(true) {
                report.tombstones += 1;
                continue;
            }
            let rel = meta["path"].as_str().unwrap_or("").to_string();
            match scan::restore_path(dir, &rel) {
                Some(dest) => jobs.push(Job { meta, dest }),
                None => report.failures.push(format!("{rel}: unsafe path")),
            }
        }
        for (job, result) in self.run_jobs(jobs) {
            let rel = job.meta["path"].as_str().unwrap_or("").to_string();
            match result {
                Ok(bytes) => {
                    if job.meta["kind"] == "symlink" {
                        report.symlinks += 1;
                    } else {
                        report.files += 1;
                        report.bytes += bytes;
                    }
                    let root = rel.split('/').next().unwrap_or("").to_string();
                    let e = report.by_root.entry(root).or_insert((0, 0));
                    e.0 += 1;
                    e.1 += bytes;
                }
                Err(e) => report.failures.push(format!("{rel}: {e}")),
            }
        }
        Ok(report)
    }

    /// Cloud paths from another device's recordings or voiceprint root, which this device has no
    /// root for, land in its state folder (`local_dest`). Their names here are the state folder's,
    /// so push maps them back to their cloud names rather than upload them again under new ones:
    /// local name -> cloud name.
    fn relocated(&self, rows: &HashMap<String, Row>) -> HashMap<String, String> {
        rows.keys()
            .filter(|rel| {
                let root = rel.split('/').next().unwrap_or("");
                !self.roots.iter().any(|r| r.name == root)
            })
            .filter_map(|rel| Some((scan::cloud_name(&self.roots, &self.local_dest(rel)?)?, rel.clone())))
            .filter(|(local, _)| !rows.contains_key(local))
            .collect()
    }

    /// Where a cloud path goes on this device. Recordings and the voiceprint that lived outside
    /// the state folder on another Mac land inside it here.
    fn local_dest(&self, rel: &str) -> Option<PathBuf> {
        scan::local_path(&self.roots, rel).or_else(|| {
            let state = self.roots.iter().find(|r| r.name == "state")?.path.clone();
            let (root, rest) = rel.split_once('/')?;
            match root {
                "recordings" => scan::restore_path(&state.join("recordings"), rest),
                "voiceprint" => Some(state.join("voiceprint.npz")),
                _ => None,
            }
        })
    }

    /// Bring other devices' changes onto this device. On the first sync of a device that joined
    /// an existing cloud, the cloud's copy wins and this device's differing copy is kept beside it.
    pub fn pull(&self) -> Result<PullReport, String> {
        let mut report = PullReport::default();
        let rows = self.rows()?;
        let first = self.first_sync();
        let since: i64 = self.kv("cursor").and_then(|v| v.parse().ok()).unwrap_or(0);
        let (changes, next) = self.changes_since(since)?;
        let stamp = now_ms();
        let mut updates: Vec<(String, Row)> = Vec::new();
        let mut jobs: Vec<(Job, String, Row)> = Vec::new();
        for (change, meta) in changes {
            let id = change["id"].as_str().unwrap_or("").to_string();
            let version = change["version"].as_i64().unwrap_or(0);
            let deleted = change["deleted"] == json!(true);
            let rel = meta["path"].as_str().unwrap_or("").to_string();
            let row = rows.get(&rel);
            if row.is_some_and(|r| r.record_id == id && r.version >= version && r.size >= 0) {
                continue;
            }
            let Some(dest) = self.local_dest(&rel) else {
                report.errors.push(format!("{rel}: no place for it on this device"));
                continue;
            };
            let local = std::fs::symlink_metadata(&dest).ok();
            let cloud_sha = meta["sha256"].as_str().unwrap_or("").to_string();
            let local_sha = || {
                if local.as_ref().is_some_and(|m| m.file_type().is_symlink()) {
                    std::fs::read_link(&dest).ok().map(|t| crypto::sha256_hex(t.to_string_lossy().as_bytes()))
                } else {
                    file_sha(&dest)
                }
            };
            let synced = Row { record_id: id.clone(), version, sha256: cloud_sha.clone(), size: 0, mtime_ns: 0, deleted };
            let local_changed = match (row, &local) {
                (_, None) => false,
                (Some(r), Some(m)) if r.size == m.len() as i64 && r.mtime_ns == mtime_of(m) => false,
                (Some(r), Some(_)) => local_sha().map(|s| s != r.sha256).unwrap_or(true),
                (None, Some(_)) => true,
            };
            if deleted {
                if local.is_some() && !local_changed {
                    std::fs::remove_file(&dest).map_err(|e| format!("{rel}: {e}"))?;
                    report.deleted += 1;
                }
                if !local_changed {
                    updates.push((rel, synced));
                }
                continue;
            }
            if let Some(m) = &local {
                if local_sha().as_deref() == Some(cloud_sha.as_str()) {
                    // Same content already here.
                    updates.push((rel, Row { size: m.len() as i64, mtime_ns: mtime_of(m), ..synced }));
                    continue;
                }
            }
            let side = |tag: &str| {
                let mut name = dest.file_name().map(|n| n.to_os_string()).unwrap_or_default();
                name.push(format!(".{tag}-{stamp}"));
                dest.with_file_name(name)
            };
            if local_changed && first {
                let aside = side("before-cloud");
                std::fs::rename(&dest, &aside).map_err(|e| format!("{rel}: moving this device's copy aside: {e}"))?;
                report.conflicts.push(format!("{rel}: the cloud's copy is in place; this device's copy was kept as {}", aside.display()));
                jobs.push((Job { meta, dest }, rel, synced));
            } else if local_changed || (meta["kind"] == "sqlite" && local.is_some()) {
                // This device's copy stays; a database another process may hold open is never replaced underneath it.
                let copy = side("from-cloud");
                report.conflicts.push(format!("{rel}: this device's copy kept; the cloud's copy saved as {}", copy.display()));
                if let Some(r) = row {
                    updates.push((rel.clone(), Row { record_id: id.clone(), version, ..r.clone() }));
                }
                jobs.push((Job { meta, dest: copy }, String::new(), synced));
            } else {
                jobs.push((Job { meta, dest }, rel, synced));
            }
        }
        let mut keyed: HashMap<PathBuf, (String, Row)> = HashMap::new();
        let mut list = Vec::new();
        for (job, rel, row) in jobs {
            keyed.insert(job.dest.clone(), (rel, row));
            list.push(job);
        }
        for (job, result) in self.run_jobs(list) {
            let (rel, row) = keyed.remove(&job.dest).unwrap_or_default();
            match result {
                Ok(_) if rel.is_empty() => {}
                Ok(_) => {
                    let m = std::fs::symlink_metadata(&job.dest).map_err(|e| e.to_string())?;
                    updates.push((rel, Row { size: m.len() as i64, mtime_ns: mtime_of(&m), ..row }));
                    report.applied += 1;
                }
                Err(e) => report.errors.push(format!("{}: {e}", job.meta["path"].as_str().unwrap_or("?"))),
            }
        }
        for (rel, row) in updates {
            self.save_row(&rel, &row)?;
        }
        // On errors keep the cursor, so the failed ones are tried again; finished ones are skipped by version.
        self.set_kv("cursor", &if report.errors.is_empty() { next } else { since }.to_string())?;
        self.remember_conflicts(&report.conflicts)?;
        Ok(report)
    }

    /// Download records and check them byte for byte: every chunk's hash, the decryption and
    /// the whole file's SHA-256. Checks `sample` records spread over the set (all when None).
    pub fn verify(&self, sample: Option<usize>) -> Result<(usize, u64, Vec<String>), String> {
        let (changes, _) = self.changes_since(0)?;
        let mut all: Vec<Value> = changes
            .into_iter()
            .filter(|(c, m)| c["deleted"] != json!(true) && m["kind"] != "symlink")
            .map(|(_, m)| m)
            .collect();
        if let Some(n) = sample {
            let step = (all.len() / n.max(1)).max(1);
            all = all.into_iter().step_by(step).take(n).collect();
        }
        let tmp = cloud_dir().join("verify-tmp");
        let _ = std::fs::remove_dir_all(&tmp);
        let mut failures = Vec::new();
        let mut bytes = 0;
        let count = all.len();
        for (i, group) in all.chunks(500).enumerate() {
            let jobs = group.iter().enumerate().map(|(k, meta)| Job { meta: meta.clone(), dest: tmp.join(format!("{i}-{k}")) }).collect();
            for (job, result) in self.run_jobs(jobs) {
                match result {
                    Ok(b) => bytes += b,
                    Err(e) => failures.push(format!("{}: {e}", job.meta["path"].as_str().unwrap_or("?"))),
                }
                let _ = std::fs::remove_file(&job.dest);
            }
        }
        let _ = std::fs::remove_dir_all(&tmp);
        Ok((count, bytes, failures))
    }

    // ---- status ------------------------------------------------------------------------------

    pub fn status(&self, last: Option<(&str, &str)>) -> Value {
        let ms = |k: &str| self.kv(k).and_then(|v| v.parse::<i64>().ok());
        let conflicts: Vec<String> = serde_json::from_str(&self.kv("conflicts").unwrap_or_else(|| "[]".into())).unwrap_or_default();
        let saved = |k: &str| serde_json::from_str::<Value>(&self.kv(k).unwrap_or_else(|| "null".into())).unwrap_or(Value::Null);
        let (state, error) = match last {
            Some((s, e)) => (s.to_string(), (s != "ok").then(|| e.to_string())),
            None => match saved("last_state") {
                Value::Object(o) => (
                    o.get("state").and_then(|s| s.as_str()).unwrap_or("unknown").to_string(),
                    o.get("error").and_then(|e| e.as_str()).filter(|e| !e.is_empty()).map(String::from),
                ),
                _ => ("never synced".into(), None),
            },
        };
        json!({
            "state": state,
            "lastError": error,
            "lastVerifiedSyncAt": ms("last_verified_sync_at"),
            "lastAttemptAt": ms("last_attempt_at"),
            "conflicts": conflicts,
            "pending": saved("pending"),
            "excluded": saved("excluded"),
            "device": { "id": self.config.device_id, "name": self.config.device_name },
            "cloud": self.config.url,
        })
    }

    /// One full round. A device's first round pulls first, so a fresh install takes the cloud's
    /// copy instead of overwriting it; after that it pushes first. Records the outcome where the
    /// app and other devices see it.
    pub fn run_once(&self, opts: &PushOptions) -> (Value, Result<(PushReport, PullReport), String>) {
        let now = now_ms();
        let _ = self.set_kv("last_attempt_at", &now.to_string());
        let result = if self.first_sync() {
            self.pull().and_then(|pull| self.push(opts).map(|push| (push, pull)))
        } else {
            self.push(opts).and_then(|push| self.pull().map(|pull| (push, pull)))
        };
        let (state, message) = match &result {
            Ok((push, pull)) => {
                let excluded: BTreeMap<_, _> = push.excluded.iter().map(|(k, (f, b))| (k.to_string(), json!({ "files": f, "bytes": b }))).collect();
                let _ = self.set_kv("excluded", &json!(excluded).to_string());
                let _ = self.set_kv(
                    "pending",
                    &json!({
                        "waitingForSpace": { "files": push.waiting_files, "bytes": push.waiting_bytes },
                        "failed": push.errors.len() + pull.errors.len(),
                    })
                    .to_string(),
                );
                if !push.errors.is_empty() || !pull.errors.is_empty() {
                    ("error", push.errors.iter().chain(pull.errors.iter()).take(3).cloned().collect::<Vec<_>>().join("; "))
                } else if push.waiting_files > 0 {
                    ("waiting_for_space", format!("{} files wait for cloud space", push.waiting_files))
                } else if !push.verified {
                    ("error", "the upload could not be read back from the cloud".into())
                } else {
                    ("ok", String::new())
                }
            }
            Err(e) if e.contains("unreachable") => ("offline", e.clone()),
            Err(e) => ("error", e.clone()),
        };
        let _ = self.set_kv("last_state", &json!({ "state": state, "error": message, "at": now }).to_string());
        let status = self.status(Some((state, &message)));
        let _ = write_private(&cloud_dir().join("status.json"), serde_json::to_string_pretty(&status).unwrap().as_bytes());
        // Other devices see counts and times only, never paths.
        let shared = json!({
            "state": status["state"], "lastVerifiedSyncAt": status["lastVerifiedSyncAt"],
            "lastAttemptAt": status["lastAttemptAt"], "pending": status["pending"],
            "conflicts": status["conflicts"].as_array().map(|c| c.len()).unwrap_or(0),
        });
        let _ = self.api.post("/v1/status", &json!({ "status": shared }));
        (status, result)
    }
}

/// Buffers encrypted chunks and uploads the ones the cloud lacks, in packs, several at once.
struct Uploader<'a> {
    api: &'a Client,
    per_pack: usize,
    pending: Vec<(String, Vec<u8>)>,
    in_pending: HashSet<String>,
    pending_bytes: u64,
    budget: u64,
    new_bytes: u64,
}

impl<'a> Uploader<'a> {
    fn new(api: &'a Client, budget: u64, per_pack: usize) -> Uploader<'a> {
        Uploader { api, per_pack, pending: Vec::new(), in_pending: HashSet::new(), pending_bytes: 0, budget, new_bytes: 0 }
    }

    /// Set aside room for a file before reading it; false when the cloud is out of space.
    fn reserve(&mut self, bytes: u64) -> bool {
        if bytes > self.budget {
            return false;
        }
        self.budget -= bytes;
        true
    }

    fn add(&mut self, hash: String, bytes: Vec<u8>) -> Result<(), String> {
        if self.in_pending.insert(hash.clone()) {
            self.pending_bytes += bytes.len() as u64;
            self.pending.push((hash, bytes));
        }
        if self.pending_bytes >= WINDOW as u64 {
            self.flush()?;
        }
        Ok(())
    }

    fn flush(&mut self) -> Result<(), String> {
        if self.pending.is_empty() {
            return Ok(());
        }
        let pending = std::mem::take(&mut self.pending);
        self.in_pending.clear();
        let buffered = std::mem::take(&mut self.pending_bytes);
        let hashes: Vec<String> = pending.iter().map(|(h, _)| h.clone()).collect();
        let missing: HashSet<String> = self.api.missing(&hashes).map_err(api_err)?.into_iter().collect();
        let uploads: Vec<(String, Vec<u8>)> = pending.into_iter().filter(|(h, _)| missing.contains(h)).collect();
        let need: u64 = uploads.iter().map(|(_, b)| b.len() as u64).sum();
        // Chunks the cloud already had cost no space: give that room back.
        self.budget = self.budget.saturating_add(buffered.saturating_sub(need));
        let mut packs: Vec<Vec<(String, Vec<u8>)>> = Vec::new();
        let mut size = 0;
        for (h, b) in uploads {
            if packs.is_empty() || size + b.len() + 36 > PACK_BYTES || packs.last().unwrap().len() >= self.per_pack {
                packs.push(Vec::new());
                size = 0;
            }
            size += b.len() + 36;
            packs.last_mut().unwrap().push((h, b));
        }
        let api = self.api;
        let results: Vec<Result<(), String>> = std::thread::scope(|s| {
            let packs = &packs;
            let handles: Vec<_> = (0..PARALLEL.min(packs.len()))
                .map(|t| {
                    s.spawn(move || {
                        for pack in packs.iter().skip(t).step_by(PARALLEL) {
                            send_pack(api, pack)?;
                        }
                        Ok(())
                    })
                })
                .collect();
            handles.into_iter().map(|h| h.join().unwrap_or_else(|_| Err("upload thread failed".into()))).collect()
        });
        for r in results {
            r?;
        }
        self.new_bytes += need;
        Ok(())
    }
}

fn backoff(stalls: u32) {
    std::thread::sleep(Duration::from_secs((1u64 << stalls.min(5)).min(30)));
}

fn send_pack(api: &Client, pack: &[(String, Vec<u8>)]) -> Result<(), String> {
    let mut left: Vec<&(String, Vec<u8>)> = pack.iter().collect();
    let mut stalls = 0;
    while !left.is_empty() {
        let items: Vec<(&str, &[u8])> = left.iter().map(|(h, b)| (h.as_str(), b.as_slice())).collect();
        match api.put_pack(&items) {
            Ok(res) => {
                let before = left.len();
                let retry: HashSet<String> = res.retry.into_iter().collect();
                left.retain(|(h, _)| retry.contains(h));
                if left.len() < before {
                    stalls = 0;
                    continue;
                }
            }
            // Only Hive Cloud's own refusals are final; an answer from Cloudflare's edge is retried.
            Err(ApiError::Http { status, code, message }) if status != 0 && status < 500 && status != 429 && code != NOT_HIVE => {
                return Err(format!("the cloud refused a chunk pack ({status} {code}): {message}"));
            }
            Err(e) if stalls >= 6 => return Err(e.to_string()),
            Err(_) => {}
        }
        stalls += 1;
        if stalls > 6 {
            return Err("the cloud kept asking for the same chunks again".into());
        }
        backoff(stalls);
    }
    Ok(())
}

fn fetch_group(api: &Client, group: &[String]) -> Result<Vec<(String, Vec<u8>)>, String> {
    let mut left: Vec<String> = group.to_vec();
    let mut out = Vec::new();
    let mut stalls = 0;
    while !left.is_empty() {
        match api.get_pack(&left) {
            Ok(got) if !got.is_empty() => {
                stalls = 0;
                let mut have = HashSet::new();
                for (hash, bytes) in got {
                    if crypto::sha256_hex(&bytes) != hash {
                        return Err(format!("chunk {hash} came back different from what was stored"));
                    }
                    have.insert(hash.clone());
                    out.push((hash, bytes));
                }
                left.retain(|h| !have.contains(h));
                continue;
            }
            Ok(_) => return Err(format!("chunk {} is missing from the cloud", left[0])),
            Err(ApiError::Http { status, code, message }) if status < 500 && status != 429 && code != NOT_HIVE => {
                return Err(format!("the cloud refused to send chunks ({status} {code}): {message}"));
            }
            Err(e) if stalls >= 5 => return Err(e.to_string()),
            Err(_) => {}
        }
        stalls += 1;
        backoff(stalls);
    }
    Ok(out)
}

fn excluded_now(rel: &str) -> bool {
    match rel.split_once('/') {
        Some(("state", rest)) => scan::state_exclusion(rest).is_some(),
        _ => false,
    }
}

fn read_full(file: &mut std::fs::File, buf: &mut [u8]) -> std::io::Result<usize> {
    let mut n = 0;
    while n < buf.len() {
        match file.read(&mut buf[n..])? {
            0 => break,
            k => n += k,
        }
    }
    Ok(n)
}

fn file_sha(path: &Path) -> Option<String> {
    let mut file = std::fs::File::open(path).ok()?;
    let mut ctx = digest::Context::new(&digest::SHA256);
    let mut buf = vec![0u8; CHUNK];
    loop {
        let n = read_full(&mut file, &mut buf).ok()?;
        if n == 0 {
            break;
        }
        ctx.update(&buf[..n]);
    }
    Some(crypto::hex(ctx.finish().as_ref()))
}

struct Snapshot(PathBuf);
impl Snapshot {
    fn path(&self) -> &Path {
        &self.0
    }
}
impl Drop for Snapshot {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// A consistent copy of a database another process may be writing.
fn sqlite_snapshot(path: &Path) -> Result<Snapshot, String> {
    let dir = cloud_dir().join("tmp");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
    let dest = dir.join(format!("snapshot-{}-{}.sqlite3", std::process::id(), now_ms()));
    let db = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX)
        .map_err(|e| format!("opening database: {e}"))?;
    db.busy_timeout(Duration::from_secs(10)).map_err(|e| e.to_string())?;
    db.execute("VACUUM INTO ?1", [dest.to_string_lossy().to_string()]).map_err(|e| format!("copying database: {e}"))?;
    Ok(Snapshot(dest))
}

/// Make sure only one sync runs at a time on this device.
pub fn lock() -> Result<std::fs::File, String> {
    use std::os::fd::AsRawFd;
    let dir = cloud_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(dir.join("sync.lock"))
        .map_err(|e| e.to_string())?;
    // SAFETY: flock on a file descriptor we own.
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        return Err("another Hive Cloud sync is already running on this device".into());
    }
    Ok(file)
}
