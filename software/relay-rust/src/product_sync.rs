//! Port of `shared/productSync.js`.
//!
//! Two things here are unusually sensitive:
//!
//! 1. `record_version_key` feeds every `WHERE excluded.version_key > ...`
//!    conflict resolution in D1, so it must be byte-identical to the JS.
//! 2. Ordering uses JS `String.prototype.localeCompare`, i.e. ICU root
//!    collation — NOT code-unit order. See [`locale_compare`].

use serde_json::{Map, Value};

use crate::util::jsonjs::{stable_fingerprint, stringify};
use crate::util::time::{iso_from_ms, now_iso, parse_iso};
use crate::util::{js_number, js_string, js_truthy, slice_utf16};

pub const PRODUCT_SYNC_SCHEMA_VERSION: &str = "product-sync.v1";

#[derive(Debug, Clone, Copy)]
pub struct Limits {
    pub max_payload_bytes: usize,
    pub max_sessions: usize,
    pub max_deleted_sessions: usize,
    pub max_turns_per_session: usize,
    pub max_deleted_turns_per_session: usize,
    pub max_turn_bytes: usize,
    pub max_session_metadata_bytes: usize,
    pub max_memory_entities: usize,
    pub max_memory_relations: usize,
    pub max_memory_record_bytes: usize,
}

pub const PRODUCT_SYNC_LIMITS: Limits = Limits {
    max_payload_bytes: 8 * 1024 * 1024,
    max_sessions: 100,
    max_deleted_sessions: 1_000,
    max_turns_per_session: 80,
    max_deleted_turns_per_session: 400,
    max_turn_bytes: 64 * 1024,
    max_session_metadata_bytes: 32 * 1024,
    max_memory_entities: 5_000,
    max_memory_relations: 10_000,
    max_memory_record_bytes: 64 * 1024,
};

/// A normalization failure. `Type` maps to HTTP 400, `Range` to 413 — the JS
/// distinguishes them with `error instanceof RangeError`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SyncError {
    Type(String),
    Range(String),
}

impl SyncError {
    pub fn message(&self) -> &str {
        match self {
            SyncError::Type(m) | SyncError::Range(m) => m,
        }
    }

    pub fn status(&self) -> u16 {
        match self {
            SyncError::Type(_) => 400,
            SyncError::Range(_) => 413,
        }
    }
}

type SyncResult<T> = Result<T, SyncError>;

// ---------------------------------------------------------------------------
// Collation
// ---------------------------------------------------------------------------

/// Primary collation weight, matching ICU root order for the character set
/// `ID_PATTERN` permits (`A-Za-z0-9._:-`) plus the ISO-timestamp characters.
///
/// Derived empirically from Node: `_` < `-` < `:` < `.` < digits < letters,
/// with letters compared case-insensitively at the primary level.
fn primary_weight(c: char) -> u32 {
    match c {
        '_' => 1,
        '-' => 2,
        ':' => 3,
        '.' => 4,
        '0'..='9' => 10 + (c as u32 - '0' as u32),
        'a'..='z' => 100 + (c as u32 - 'a' as u32),
        'A'..='Z' => 100 + (c as u32 - 'A' as u32),
        // Everything outside the identifier charset sorts after letters, in
        // code-point order. IDs never contain such characters.
        other => 1000 + other as u32,
    }
}

/// Tertiary weight: lowercase sorts before uppercase.
fn tertiary_weight(c: char) -> u8 {
    u8::from(c.is_ascii_uppercase())
}

/// Port of `String.prototype.localeCompare` for the characters these records
/// can actually contain.
///
/// Code-unit comparison is NOT a valid substitute: it disagrees on mixed case
/// (`"a" < "B"` under ICU, `"a" > "B"` by code unit) and on `_` versus `-`.
pub fn locale_compare(left: &str, right: &str) -> std::cmp::Ordering {
    let primary = left
        .chars()
        .map(primary_weight)
        .cmp(right.chars().map(primary_weight));
    if primary != std::cmp::Ordering::Equal {
        return primary;
    }
    left.chars()
        .map(tertiary_weight)
        .cmp(right.chars().map(tertiary_weight))
}

/// Port of `compareIso`, which is `localeCompare` over the raw strings.
fn compare_iso(left: &str, right: &str) -> std::cmp::Ordering {
    locale_compare(left, right)
}

// ---------------------------------------------------------------------------
// Primitive normalizers
// ---------------------------------------------------------------------------

fn assert_object(name: &str, value: Option<&Value>) -> SyncResult<()> {
    match value {
        Some(Value::Object(_)) => Ok(()),
        _ => Err(SyncError::Type(format!("{name} must be an object"))),
    }
}

/// Port of `normalizeId` with `ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/`.
fn normalize_id_str(name: &str, text: &str) -> SyncResult<String> {
    let text = text.trim();
    let n = text.chars().count();
    let valid = (1..=128).contains(&n) && {
        let mut chars = text.chars();
        let first = chars.next().unwrap();
        first.is_ascii_alphanumeric()
            && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '-'))
    };
    if !valid {
        return Err(SyncError::Type(format!("{name} must be a stable identifier")));
    }
    Ok(text.to_string())
}

fn normalize_id(name: &str, value: Option<&Value>) -> SyncResult<String> {
    normalize_id_str(name, &js_string(value))
}

/// `value || fallback` then `normalizeId`.
fn normalize_id_or(name: &str, value: Option<&Value>, fallback: &str) -> SyncResult<String> {
    if js_truthy(value) {
        normalize_id_str(name, &js_string(value))
    } else {
        normalize_id_str(name, fallback)
    }
}

/// Port of `normalizeTimestamp`, re-emitting through `toISOString()`.
fn normalize_timestamp_value(name: &str, value: Option<&Value>) -> SyncResult<String> {
    let err = || SyncError::Type(format!("{name} must be an ISO timestamp"));
    // `if (!value || Number.isNaN(date.getTime())) throw`
    if !js_truthy(value) {
        return Err(err());
    }
    let ms = match value {
        Some(Value::String(s)) => parse_iso(s).ok_or_else(err)?,
        Some(Value::Number(n)) => {
            let f = n.as_f64().ok_or_else(err)?;
            if !f.is_finite() {
                return Err(err());
            }
            f as i64
        }
        _ => return Err(err()),
    };
    Ok(iso_from_ms(ms))
}

/// `input.a || input.b` — the first truthy of two fields.
fn either<'a>(value: &'a Value, first: &str, second: &str) -> Option<&'a Value> {
    match value.get(first) {
        Some(v) if js_truthy(Some(v)) => Some(v),
        _ => value.get(second),
    }
}

fn normalize_revision(value: Option<&Value>) -> SyncResult<u64> {
    let n = js_number(value);
    // `Number.isSafeInteger(n) && n >= 0`
    if !n.is_finite() || n.fract() != 0.0 || n < 0.0 || n > 9_007_199_254_740_991.0 {
        return Err(SyncError::Type(
            "sync.revision must be a non-negative integer".to_string(),
        ));
    }
    Ok(n as u64)
}

fn assert_byte_limit(name: &str, value: &Value, max_bytes: usize) -> SyncResult<()> {
    let bytes = stringify(value).len();
    if bytes > max_bytes {
        return Err(SyncError::Range(format!("{name} exceeds {max_bytes} bytes")));
    }
    Ok(())
}

/// `String(value || fallback).trim().slice(0, n)`
fn bounded_string(value: Option<&Value>, fallback: &str, max: usize, trim: bool) -> String {
    let raw = if js_truthy(value) {
        js_string(value)
    } else {
        fallback.to_string()
    };
    let raw = if trim { raw.trim().to_string() } else { raw };
    slice_utf16(&raw, max)
}

// ---------------------------------------------------------------------------
// Record comparison / merge
// ---------------------------------------------------------------------------

/// Port of `compareVersionedRecords`.
pub fn compare_versioned_records(left: &Value, right: &Value) -> std::cmp::Ordering {
    let updated = compare_iso(
        &js_string(left.get("updatedAt")),
        &js_string(right.get("updatedAt")),
    );
    if updated != std::cmp::Ordering::Equal {
        return updated;
    }

    // A tombstone wins an otherwise-equal update.
    let deleted = js_truthy(left.get("deletedAt")).cmp(&js_truthy(right.get("deletedAt")));
    if deleted != std::cmp::Ordering::Equal {
        return deleted;
    }

    let source = locale_compare(
        &js_string(left.get("sourceDeviceId")),
        &js_string(right.get("sourceDeviceId")),
    );
    if source != std::cmp::Ordering::Equal {
        return source;
    }

    locale_compare(&stable_fingerprint(left), &stable_fingerprint(right))
}

/// Port of `recordVersionKey`.
///
/// `<isoUpdatedAt>|<0|1>|<sourceDeviceId>|<fingerprint>` — compared
/// LEXICOGRAPHICALLY by SQLite in every product upsert.
pub fn record_version_key(record: &Value) -> SyncResult<String> {
    let timestamp =
        normalize_timestamp_value("record.updatedAt", either(record, "updatedAt", "createdAt"))?;
    let deleted = if js_truthy(record.get("deletedAt")) {
        "1"
    } else {
        "0"
    };
    let source_device_id = normalize_id_or(
        "record.sourceDeviceId",
        record.get("sourceDeviceId"),
        "unknown-device",
    )?;

    Ok(format!(
        "{timestamp}|{deleted}|{source_device_id}|{}",
        stable_fingerprint(record)
    ))
}

/// Port of `mergeRecords`: keep the winner per id, preserving first-seen order.
fn merge_records(records: Vec<Value>, id_key: &str) -> Vec<Value> {
    let mut order: Vec<String> = Vec::new();
    let mut by_id: Map<String, Value> = Map::new();

    for record in records {
        let id = js_string(record.get(id_key));
        match by_id.get(&id) {
            Some(current) => {
                if compare_versioned_records(&record, current) == std::cmp::Ordering::Greater {
                    by_id.insert(id, record);
                }
            }
            None => {
                order.push(id.clone());
                by_id.insert(id, record);
            }
        }
    }

    order
        .into_iter()
        .filter_map(|id| by_id.get(&id).cloned())
        .collect()
}

fn compare_session_order(left: &Value, right: &Value) -> std::cmp::Ordering {
    // Newest first, then by id.
    compare_iso(
        &js_string(right.get("updatedAt")),
        &js_string(left.get("updatedAt")),
    )
    .then_with(|| {
        locale_compare(
            &js_string(left.get("sessionId")),
            &js_string(right.get("sessionId")),
        )
    })
}

fn compare_turn_order(left: &Value, right: &Value) -> std::cmp::Ordering {
    compare_iso(
        &js_string(left.get("createdAt")),
        &js_string(right.get("createdAt")),
    )
    .then_with(|| locale_compare(&js_string(left.get("id")), &js_string(right.get("id"))))
}

fn compare_memory_order(left: &Value, right: &Value) -> std::cmp::Ordering {
    locale_compare(&js_string(left.get("id")), &js_string(right.get("id")))
}

// ---------------------------------------------------------------------------
// Record normalizers
// ---------------------------------------------------------------------------

/// Apply JS object-spread semantics: start from a copy of the input, then
/// overwrite named keys. `IndexMap::insert` keeps an existing key's position,
/// which is exactly what `{...input, key: value}` does.
fn spread(input: &Value) -> Map<String, Value> {
    match input {
        Value::Object(map) => map.clone(),
        _ => Map::new(),
    }
}

fn normalize_turn(
    input: &Value,
    name: &str,
    source_device_id: &str,
    limits: &Limits,
) -> SyncResult<Value> {
    assert_object(name, Some(input))?;

    let id = normalize_id(&format!("{name}.id"), either(input, "id", "turnId"))?;
    let created_at = normalize_timestamp_value(
        &format!("{name}.createdAt"),
        either(input, "createdAt", "updatedAt"),
    )?;
    let updated_at = if js_truthy(input.get("updatedAt")) {
        normalize_timestamp_value(&format!("{name}.updatedAt"), input.get("updatedAt"))?
    } else {
        created_at.clone()
    };
    let deleted_at = if js_truthy(input.get("deletedAt")) {
        Value::String(normalize_timestamp_value(
            &format!("{name}.deletedAt"),
            input.get("deletedAt"),
        )?)
    } else {
        Value::Null
    };
    let record_source = normalize_id_or(
        &format!("{name}.sourceDeviceId"),
        input.get("sourceDeviceId"),
        source_device_id,
    )?;

    let mut map = spread(input);
    map.insert("id".into(), id.into());
    map.insert("createdAt".into(), created_at.into());
    map.insert("updatedAt".into(), updated_at.into());
    let is_deleted = !deleted_at.is_null();
    map.insert("deletedAt".into(), deleted_at);
    map.insert("sourceDeviceId".into(), record_source.into());

    if !is_deleted {
        map.insert(
            "role".into(),
            bounded_string(input.get("role"), "assistant", 40, false).into(),
        );
        // `String(input.content ?? '')` uses `??`, so `0` and `false` survive.
        map.insert(
            "content".into(),
            match input.get("content") {
                None | Some(Value::Null) => Value::String(String::new()),
                Some(v) => Value::String(js_string(Some(v))),
            },
        );
    }

    let normalized = Value::Object(map);
    assert_byte_limit(name, &normalized, limits.max_turn_bytes)?;
    Ok(normalized)
}

fn normalize_session(
    input: &Value,
    name: &str,
    source_device_id: &str,
    limits: &Limits,
) -> SyncResult<Value> {
    assert_object(name, Some(input))?;

    let session_id = normalize_id(&format!("{name}.sessionId"), input.get("sessionId"))?;
    let created_at = normalize_timestamp_value(
        &format!("{name}.createdAt"),
        either(input, "createdAt", "updatedAt"),
    )?;
    let updated_at = if js_truthy(input.get("updatedAt")) {
        normalize_timestamp_value(&format!("{name}.updatedAt"), input.get("updatedAt"))?
    } else {
        created_at.clone()
    };
    let deleted_at = if js_truthy(input.get("deletedAt")) {
        Value::String(normalize_timestamp_value(
            &format!("{name}.deletedAt"),
            input.get("deletedAt"),
        )?)
    } else {
        Value::Null
    };
    let record_source = normalize_id_or(
        &format!("{name}.sourceDeviceId"),
        input.get("sourceDeviceId"),
        source_device_id,
    )?;
    let title = bounded_string(input.get("title"), "New session", 240, true);

    let raw_turns = match input.get("turns") {
        Some(Value::Array(items)) => items.clone(),
        _ => vec![],
    };
    let mut turns = Vec::with_capacity(raw_turns.len());
    for (index, turn) in raw_turns.iter().enumerate() {
        turns.push(normalize_turn(
            turn,
            &format!("{name}.turns[{index}]"),
            &record_source,
            limits,
        )?);
    }
    let mut turns = merge_records(turns, "id");

    let active_turns = turns
        .iter()
        .filter(|t| !js_truthy(t.get("deletedAt")))
        .count();
    let deleted_turns = turns.len() - active_turns;
    if active_turns > limits.max_turns_per_session {
        return Err(SyncError::Range(format!(
            "{name}.turns exceeds {} active turns",
            limits.max_turns_per_session
        )));
    }
    if deleted_turns > limits.max_deleted_turns_per_session {
        return Err(SyncError::Range(format!(
            "{name}.turns exceeds {} turn tombstones",
            limits.max_deleted_turns_per_session
        )));
    }
    turns.sort_by(compare_turn_order);

    let mut map = spread(input);
    map.insert("sessionId".into(), session_id.into());
    map.insert(
        "title".into(),
        if title.is_empty() {
            "New session".into()
        } else {
            Value::String(title)
        },
    );
    map.insert("createdAt".into(), created_at.into());
    map.insert("updatedAt".into(), updated_at.into());
    map.insert("deletedAt".into(), deleted_at);
    map.insert("sourceDeviceId".into(), record_source.into());
    map.insert("turns".into(), Value::Array(turns));

    // `{ ...normalized, turns: undefined }` — the turns key disappears from
    // the serialized metadata used for the size check.
    let mut metadata = map.clone();
    metadata.shift_remove("turns");
    assert_byte_limit(
        &format!("{name} metadata"),
        &Value::Object(metadata),
        limits.max_session_metadata_bytes,
    )?;

    Ok(Value::Object(map))
}

fn normalize_memory_records(
    input: Option<&Value>,
    kind: &str,
    source_device_id: &str,
    max_records: usize,
    max_record_bytes: usize,
) -> SyncResult<Vec<Value>> {
    let items = match input {
        None | Some(Value::Null) => vec![],
        Some(Value::Array(items)) => items.clone(),
        _ => {
            return Err(SyncError::Type(format!(
                "sync.memory.{kind}s must be an array"
            )))
        }
    };

    if items.len() > max_records {
        return Err(SyncError::Range(format!(
            "sync.memory.{kind}s exceeds {max_records} records"
        )));
    }

    let mut normalized = Vec::with_capacity(items.len());
    for (index, record) in items.iter().enumerate() {
        let name = format!("sync.memory.{kind}s[{index}]");
        assert_object(&name, Some(record))?;

        let id = normalize_id(&format!("{name}.id"), record.get("id"))?;
        let created_at = normalize_timestamp_value(
            &format!("{name}.createdAt"),
            either(record, "createdAt", "updatedAt"),
        )?;
        let updated_at = if js_truthy(record.get("updatedAt")) {
            normalize_timestamp_value(&format!("{name}.updatedAt"), record.get("updatedAt"))?
        } else {
            created_at.clone()
        };
        let deleted_at = if js_truthy(record.get("deletedAt")) {
            Value::String(normalize_timestamp_value(
                &format!("{name}.deletedAt"),
                record.get("deletedAt"),
            )?)
        } else {
            Value::Null
        };
        let record_source = normalize_id_or(
            &format!("{name}.sourceDeviceId"),
            record.get("sourceDeviceId"),
            source_device_id,
        )?;

        let mut map = spread(record);
        map.insert("id".into(), id.into());
        map.insert("createdAt".into(), created_at.into());
        map.insert("updatedAt".into(), updated_at.into());
        map.insert("deletedAt".into(), deleted_at);
        map.insert("sourceDeviceId".into(), record_source.into());

        if kind == "entity" {
            map.insert(
                "type".into(),
                bounded_string(record.get("type"), "Note", 80, true).into(),
            );
            map.insert(
                "name".into(),
                bounded_string(record.get("name"), "Untitled", 240, true).into(),
            );
        } else {
            map.insert(
                "from".into(),
                normalize_id(&format!("{name}.from"), record.get("from"))?.into(),
            );
            map.insert(
                "to".into(),
                normalize_id(&format!("{name}.to"), record.get("to"))?.into(),
            );
            map.insert(
                "type".into(),
                bounded_string(record.get("type"), "related_to", 80, true).into(),
            );
        }

        let value = Value::Object(map);
        assert_byte_limit(&name, &value, max_record_bytes)?;
        normalized.push(value);
    }

    let mut merged = merge_records(normalized, "id");
    merged.sort_by(compare_memory_order);
    Ok(merged)
}

/// Port of `normalizeProductSync`.
pub fn normalize_product_sync(input: &Value, limits: &Limits) -> SyncResult<Value> {
    assert_object("sync", Some(input))?;

    let account_id = normalize_id("sync.accountId", input.get("accountId"))?;
    let source_device_id = normalize_id_or(
        "sync.sourceDeviceId",
        input.get("sourceDeviceId"),
        "unknown-device",
    )?;
    let generated_at = if js_truthy(input.get("generatedAt")) {
        normalize_timestamp_value("sync.generatedAt", input.get("generatedAt"))?
    } else {
        now_iso()
    };

    let raw_sessions = match input.get("sessions") {
        None | Some(Value::Null) => vec![],
        Some(Value::Array(items)) => items.clone(),
        _ => return Err(SyncError::Type("sync.sessions must be an array".to_string())),
    };
    let mut sessions = Vec::with_capacity(raw_sessions.len());
    for (index, session) in raw_sessions.iter().enumerate() {
        sessions.push(normalize_session(
            session,
            &format!("sync.sessions[{index}]"),
            &source_device_id,
            limits,
        )?);
    }
    let mut sessions = merge_records(sessions, "sessionId");

    let active = sessions
        .iter()
        .filter(|s| !js_truthy(s.get("deletedAt")))
        .count();
    let deleted = sessions.len() - active;
    if active > limits.max_sessions {
        return Err(SyncError::Range(format!(
            "sync.sessions exceeds {} active sessions",
            limits.max_sessions
        )));
    }
    if deleted > limits.max_deleted_sessions {
        return Err(SyncError::Range(format!(
            "sync.sessions exceeds {} session tombstones",
            limits.max_deleted_sessions
        )));
    }
    sessions.sort_by(compare_session_order);

    let memory_input = match input.get("memory") {
        None | Some(Value::Null) => Value::Object(Map::new()),
        Some(v) => v.clone(),
    };
    assert_object("sync.memory", Some(&memory_input))?;
    let entities = normalize_memory_records(
        memory_input.get("entities"),
        "entity",
        &source_device_id,
        limits.max_memory_entities,
        limits.max_memory_record_bytes,
    )?;
    let relations = normalize_memory_records(
        memory_input.get("relations"),
        "relation",
        &source_device_id,
        limits.max_memory_relations,
        limits.max_memory_record_bytes,
    )?;

    let mut memory = Map::new();
    memory.insert("entities".into(), Value::Array(entities));
    memory.insert("relations".into(), Value::Array(relations));

    let mut normalized = Map::new();
    normalized.insert("schemaVersion".into(), PRODUCT_SYNC_SCHEMA_VERSION.into());
    normalized.insert("accountId".into(), account_id.into());
    normalized.insert("sourceDeviceId".into(), source_device_id.into());
    normalized.insert(
        "revision".into(),
        normalize_revision(input.get("revision"))?.into(),
    );
    normalized.insert("generatedAt".into(), generated_at.into());
    normalized.insert("sessions".into(), Value::Array(sessions));
    normalized.insert("memory".into(), Value::Object(memory));

    let normalized = Value::Object(normalized);
    assert_byte_limit("sync payload", &normalized, limits.max_payload_bytes)?;
    Ok(normalized)
}

#[cfg(test)]
mod tests;
