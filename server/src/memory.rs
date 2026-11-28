//! Three-tier memory (Tier 1: structured profile & contacts; Tier 2: verified site playbooks) backed by SQLite FTS5 BM25.
//! Tier 0 (passwords & payment cards) lives exclusively in encrypted `cred.rs` and is blocked from entering Tiers 1-2.
use crate::args;
use crate::db::{now, Db};
use hive_protocol::{short, str_val as s};
use serde_json::{json, Value};

pub const STALE_FAILS: i64 = 2;

/// Normalize a URL or host ("https://www.Canvas.wisc.edu:443/courses" -> "canvas.wisc.edu").
pub fn normalize_host(raw: &str) -> String {
    let t = raw.trim().to_ascii_lowercase();
    let rest = t.split_once("://").map(|(_, r)| r).unwrap_or(&t);
    let h = rest.split(['/', '?', '#']).next().unwrap_or("");
    let h = h.rsplit('@').next().unwrap_or(h).split(':').next().unwrap_or("");
    h.trim_start_matches("www.").trim_matches('.').to_string()
}

/// Extract normalized hostnames mentioned in free text (URLs or domain.tld tokens) for playbook auto-injection.
pub fn extract_hosts(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    for tok in text.split_whitespace() {
        let clean = tok.trim_matches(|c: char| matches!(c, '(' | ')' | '[' | ']' | '<' | '>' | ',' | ';' | '"' | '\'' | '.'));
        let candidate = if clean.contains("://") {
            normalize_host(clean)
        } else if clean.contains('.') && !clean.contains('@') && !clean.starts_with('/') {
            let h = normalize_host(clean);
            let parts: Vec<&str> = h.split('.').collect();
            let valid_tld = parts.last().is_some_and(|t| t.len() >= 2 && t.len() <= 8 && t.chars().all(|c| c.is_ascii_alphabetic()));
            let valid_host = parts.len() >= 2 && parts.iter().all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'));
            if valid_tld && valid_host { h } else { String::new() }
        } else {
            String::new()
        };
        if !candidate.is_empty() && !out.contains(&candidate) { out.push(candidate); }
    }
    out
}

/// Reject passwords, raw tokens, private keys, and Luhn-valid payment card numbers from plaintext Tiers 1-2.
pub fn looks_like_secret(key: &str, value: &str) -> bool {
    let k = key.trim().to_ascii_lowercase();
    const SECRET_KEYS: &[&str] = &[
        "password", "passwd", "passcode", "cvv", "cvc", "pin", "secret",
        "api_key", "apikey", "access_token", "refresh_token", "auth_token", "ssn", "card_number", "credit_card",
    ];
    if SECRET_KEYS.iter().any(|sk| k == *sk || k.ends_with(&format!("_{sk}"))) {
        return true;
    }
    if value.contains("PRIVATE KEY-----") { return true; }
    for tok in value.split_whitespace() {
        let t = tok.trim_matches(|c: char| matches!(c, '"' | '\'' | ',' | ';' | ')' | '('));
        const PREFIXES: &[&str] = &["sk-", "sk_live_", "sk_test_", "ghp_", "gho_", "ghu_", "ghs_", "xoxb-", "xoxp-", "AIza", "AKIA"];
        if PREFIXES.iter().any(|p| t.starts_with(p) && t.len() >= p.len() + 12) { return true; }
    }
    has_luhn_pan(value)
}

fn has_luhn_pan(text: &str) -> bool {
    // Scan contiguous runs of digits, spaces, and dashes for 13..=19 digit Luhn-valid payment card numbers.
    let mut run = String::new();
    let check = |r: &str| -> bool {
        let digits: Vec<u32> = r.chars().filter_map(|c| c.to_digit(10)).collect();
        if !(13..=19).contains(&digits.len()) { return false; }
        let mut sum = 0u32;
        for (i, &d) in digits.iter().rev().enumerate() {
            let v = if i % 2 == 1 { let x = d * 2; if x > 9 { x - 9 } else { x } } else { d };
            sum += v;
        }
        sum % 10 == 0
    };
    for c in text.chars() {
        if c.is_ascii_digit() || matches!(c, ' ' | '-') {
            run.push(c);
        } else {
            if check(&run) { return true; }
            run.clear();
        }
    }
    check(&run)
}

fn fts_query(raw: &str) -> String {
    let toks: Vec<String> = raw
        .split(|c: char| !c.is_ascii_alphanumeric() && c != '_')
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .take(12)
        .map(|t| format!("\"{}\"*", t.replace('"', "")))
        .collect();
    toks.join(" OR ")
}

fn index_row(db: &Db, tier: &str, ref_id: &str, key_or_host: &str, body: &str) {
    db.run("delete from memory_fts where tier=? and ref_id=?", args!(tier, ref_id));
    db.run("insert into memory_fts(tier, ref_id, key_or_host, body) values(?,?,?,?)", args!(tier, ref_id, key_or_host, body));
}

fn delete_fts(db: &Db, tier: &str, ref_id: &str) {
    db.run("delete from memory_fts where tier=? and ref_id=?", args!(tier, ref_id));
}

fn meta_obj(row: &Value) -> Value {
    serde_json::from_str(&s(&row["meta"])).unwrap_or_else(|_| json!({}))
}

fn contact_json(row: &Value) -> Value {
    let m = meta_obj(row);
    json!({
        "id": row["id"], "name": row["key"], "relation": row["title"],
        "email": m["email"].as_str().unwrap_or(""), "phone": m["phone"].as_str().unwrap_or(""),
        "org": m["org"].as_str().unwrap_or(""), "notes": row["value"], "updated": row["updated"],
    })
}

fn playbook_json(row: &Value) -> Value {
    let m = meta_obj(row);
    json!({
        "id": row["id"], "host": row["key"], "title": row["title"], "steps": row["value"],
        "selectors": m["selectors"].as_str().unwrap_or(""), "uses": row["uses"],
        "fails": row["fails"], "verified_at": row["verified_at"], "updated": row["updated"],
    })
}

fn fts_body(row: &Value) -> String {
    let m = meta_obj(row);
    match s(&row["tier"]).as_str() {
        "profile" => s(&row["value"]),
        "contact" => format!("{} {} {} {} {}", s(&row["title"]), s(&m["email"]), s(&m["phone"]), s(&m["org"]), s(&row["value"])).trim().to_string(),
        "playbook" => format!("{} {} {}", s(&row["title"]), s(&row["value"]), s(&m["selectors"])).trim().to_string(),
        _ => s(&row["value"]),
    }
}

/// Ensure FTS5 index matches existing rows in the unified `memory` table (<5ms).
pub fn sync_fts(db: &Db) {
    let want = db.get("select count(*) as n from memory", &[]).and_then(|r| r["n"].as_i64()).unwrap_or(0);
    let have = db.get("select count(*) as n from memory_fts", &[]).and_then(|r| r["n"].as_i64()).unwrap_or(0);
    if want == have { return; }
    db.run("delete from memory_fts", &[]);
    for r in db.all("select * from memory", &[]) {
        let tier = s(&r["tier"]);
        let ref_id = if tier == "profile" { s(&r["key"]) } else { r["id"].as_i64().unwrap_or(0).to_string() };
        index_row(db, &tier, &ref_id, &s(&r["key"]), &fts_body(&r));
    }
}

/// Backward-compatible profile read/write used by `info` tool and `/api/info` (with secret firewall + FTS sync).
pub fn save_profile(db: &Db, key: &str, value: &str) -> Result<String, String> {
    let (key, value) = (key.trim(), value.trim());
    if key.is_empty() || value.is_empty() { return Err("Give both key and value.".into()); }
    if looks_like_secret(key, value) {
        return Err("Refused to store a secret or payment card in plain memory; use the encrypted Tier 0 vault (hive-cred / type_password) instead.".into());
    }
    if let Some(id) = db.get("select id from memory where tier='profile' and key=?", args!(key)).and_then(|r| r["id"].as_i64()) {
        db.run("update memory set value=?, updated=? where id=?", args!(value, now(), id));
    } else {
        db.run("insert into memory(tier, key, value, updated) values('profile',?,?,?)", args!(key, value, now()));
    }
    index_row(db, "profile", key, key, value);
    Ok("Saved.".into())
}

pub fn get_profile(db: &Db, key: &str) -> String {
    let key = key.trim();
    let rows = if key.is_empty() { db.all("select key, value from memory where tier='profile' order by key", &[]) }
        else { db.all("select key, value from memory where tier='profile' and key=?", args!(key)) };
    rows.iter().map(|r| format!("{}: {}", s(&r["key"]), s(&r["value"]))).collect::<Vec<_>>().join("\n")
}

pub fn save_contact(db: &Db, a: &Value) -> Result<Value, String> {
    let name = s(&a["name"]).trim().to_string();
    if name.is_empty() { return Err("Give the contact's name.".into()); }
    let (rel, email, phone, org, notes) = (
        s(&a["relation"]).trim().to_string(),
        s(&a["email"]).trim().to_string(),
        s(&a["phone"]).trim().to_string(),
        s(&a["org"]).trim().to_string(),
        short(s(&a["notes"]).trim(), 400),
    );
    for (k, v) in [("name", &name), ("relation", &rel), ("email", &email), ("phone", &phone), ("org", &org), ("notes", &notes)] {
        if looks_like_secret(k, v) {
            return Err("Refused to store a secret or payment card in contacts; use Tier 0 (hive-cred) instead.".into());
        }
    }
    let existing = a["id"].as_i64().filter(|i| *i > 0)
        .or_else(|| db.get("select id from memory where tier='contact' and lower(key)=lower(?)", args!(name)).and_then(|r| r["id"].as_i64()));
    let id = if let Some(id) = existing {
        let cur = db.get("select * from memory where id=? and tier='contact'", args!(id)).map(|r| contact_json(&r)).unwrap_or(json!({}));
        let pick = |new: &str, old: &Value| if new.is_empty() { s(old) } else { new.to_string() };
        let (rel, email, phone, org, notes) = (
            pick(&rel, &cur["relation"]), pick(&email, &cur["email"]), pick(&phone, &cur["phone"]),
            pick(&org, &cur["org"]), pick(&notes, &cur["notes"]),
        );
        let meta = json!({ "email": email, "phone": phone, "org": org }).to_string();
        db.run("update memory set key=?, title=?, value=?, meta=?, updated=? where id=?",
            args!(name, rel, notes, meta, now(), id));
        id
    } else {
        let meta = json!({ "email": email, "phone": phone, "org": org }).to_string();
        db.run("insert into memory(tier, key, title, value, meta, updated) values('contact',?,?,?,?,?)",
            args!(name, rel, notes, meta, now()))
    };
    let raw = db.get("select * from memory where id=?", args!(id)).unwrap_or(json!({ "id": id }));
    index_row(db, "contact", &id.to_string(), &s(&raw["key"]), &fts_body(&raw));
    Ok(contact_json(&raw))
}

pub fn save_playbook(db: &Db, a: &Value) -> Result<Value, String> {
    let host = normalize_host(&s(&a["host"]));
    if host.is_empty() { return Err("Give the playbook's site host (e.g. canvas.wisc.edu).".into()); }
    let title = short(s(&a["title"]).trim(), 120);
    let steps = short(s(&a["steps"]).trim(), 1200);
    let selectors = short(s(&a["selectors"]).trim(), 600);
    if steps.is_empty() && selectors.is_empty() { return Err("Give verified steps or stable selectors for the playbook.".into()); }
    if selectors.to_ascii_lowercase().contains("data-hive") || steps.to_ascii_lowercase().contains("data-hive") {
        return Err("Playbooks must store stable CSS/ARIA/URL patterns, never transient data-hive indices.".into());
    }
    if looks_like_secret("steps", &steps) || looks_like_secret("selectors", &selectors) {
        return Err("Refused to store a secret or payment card in a site playbook; use Tier 0 (hive-cred) instead.".into());
    }
    let ts = now();
    let meta = json!({ "selectors": selectors }).to_string();
    let existing = a["id"].as_i64().filter(|i| *i > 0)
        .or_else(|| db.get("select id from memory where tier='playbook' and key=? and lower(title)=lower(?)", args!(host, title)).and_then(|r| r["id"].as_i64()));
    let id = if let Some(id) = existing {
        db.run("update memory set key=?, title=?, value=?, meta=?, fails=0, verified_at=?, updated=? where id=?",
            args!(host, title, steps, meta, ts, ts, id));
        id
    } else {
        db.run("insert into memory(tier, key, title, value, meta, uses, fails, verified_at, updated) values('playbook',?,?,?,?,0,0,?,?)",
            args!(host, title, steps, meta, ts, ts))
    };
    let raw = db.get("select * from memory where id=?", args!(id)).unwrap_or(json!({ "id": id }));
    index_row(db, "playbook", &id.to_string(), &s(&raw["key"]), &fts_body(&raw));
    Ok(playbook_json(&raw))
}

pub fn report_playbook(db: &Db, id: i64, ok: bool) -> Result<String, String> {
    if id <= 0 || db.get("select 1 from memory where id=? and tier='playbook'", args!(id)).is_none() {
        return Err(format!("No playbook #{id}."));
    }
    let ts = now();
    if ok {
        db.run("update memory set uses=uses+1, fails=0, verified_at=?, updated=? where id=?", args!(ts, ts, id));
        Ok(format!("Playbook #{id} verified (uses incremented, fails reset)."))
    } else {
        db.run("update memory set fails=fails+1, updated=? where id=?", args!(ts, id));
        let fails = db.get("select fails from memory where id=?", args!(id)).and_then(|r| r["fails"].as_i64()).unwrap_or(1);
        if fails >= STALE_FAILS {
            Ok(format!("Playbook #{id} marked stale ({fails} failures) and removed from auto-injection; update it after re-verifying."))
        } else {
            Ok(format!("Recorded failure on playbook #{id} ({fails}/{STALE_FAILS} before stale)."))
        }
    }
}

/// Active verified playbooks matching a URL or host (exact or parent domain; excludes stale `fails >= STALE_FAILS`).
pub fn playbooks_for_host(db: &Db, host_or_url: &str) -> Vec<Value> {
    let h = normalize_host(host_or_url);
    if h.is_empty() { return vec![]; }
    db.all("select * from memory where tier='playbook' and fails < ? order by uses desc, verified_at desc", args!(STALE_FAILS)).into_iter()
        .filter(|p| {
            let ph = s(&p["key"]);
            !ph.is_empty() && (h == ph || h.ends_with(&format!(".{ph}")))
        })
        .take(3)
        .map(|r| playbook_json(&r))
        .collect()
}

/// Format verified playbooks into a compact prompt/tool hint (bounded so it never bloats context).
pub fn format_playbooks_hint(rows: &[Value]) -> String {
    if rows.is_empty() { return String::new(); }
    let mut out = String::new();
    for p in rows {
        let title = s(&p["title"]);
        let head = if title.is_empty() { format!("[Playbook #{} for {}]", p["id"], s(&p["host"])) }
            else { format!("[Playbook #{} for {}: {}]", p["id"], s(&p["host"]), title) };
        out.push_str(&head);
        if !s(&p["steps"]).is_empty() { out.push_str(&format!("\n  Steps: {}", short(&s(&p["steps"]), 320))); }
        if !s(&p["selectors"]).is_empty() { out.push_str(&format!("\n  Selectors: {}", short(&s(&p["selectors"]), 200))); }
        out.push('\n');
    }
    short(out.trim_end(), 1000)
}

pub fn search(db: &Db, query: &str, tier: &str, limit: i64) -> Vec<Value> {
    let limit = limit.clamp(1, 25);
    let tier = tier.trim().to_ascii_lowercase();
    let fq = fts_query(query);
    if fq.is_empty() { return vec![]; }
    let hits = if tier.is_empty() {
        db.all("select tier, ref_id, key_or_host, body, bm25(memory_fts) as score from memory_fts where memory_fts match ? order by score limit ?",
            args!(fq, limit))
    } else {
        db.all("select tier, ref_id, key_or_host, body, bm25(memory_fts) as score from memory_fts where memory_fts match ? and tier=? order by score limit ?",
            args!(fq, tier, limit))
    };
    hits.into_iter().map(|h| {
        let t = s(&h["tier"]);
        let rid = s(&h["ref_id"]);
        match t.as_str() {
            "profile" => json!({ "tier": "profile", "key": h["key_or_host"], "value": h["body"] }),
            "contact" => db.get("select * from memory where id=? and tier='contact'", args!(rid.parse::<i64>().unwrap_or(0)))
                .map(|r| { let mut c = contact_json(&r); c["tier"] = json!("contact"); c }).unwrap_or(h),
            "playbook" => db.get("select * from memory where id=? and tier='playbook'", args!(rid.parse::<i64>().unwrap_or(0)))
                .map(|r| { let mut p = playbook_json(&r); p["tier"] = json!("playbook"); p["stale"] = json!(p["fails"].as_i64().unwrap_or(0) >= STALE_FAILS); p }).unwrap_or(h),
            _ => h,
        }
    }).collect()
}

/// Unified entry point for both the LLM `memory` tool and `POST /api/memory`.
pub fn exec(db: &Db, a: &Value) -> Result<Value, String> {
    let action = s(&a["action"]).trim().to_ascii_lowercase();
    match action.as_str() {
        "" | "search" => {
            let q = s(&a["query"]);
            let tier = s(&a["tier"]);
            if q.trim().is_empty() { return get(db, &tier, &s(&a["key"]), &s(&a["host"]), a["id"].as_i64().unwrap_or(0)); }
            Ok(json!({ "results": search(db, &q, &tier, a["limit"].as_i64().unwrap_or(10)) }))
        }
        "get" | "list" => get(db, &s(&a["tier"]), &s(&a["key"]), &s(&a["host"]), a["id"].as_i64().unwrap_or(0)),
        "save_profile" => save_profile(db, &s(&a["key"]), &s(&a["value"])).map(|m| json!({ "ok": true, "message": m })),
        "save_contact" => save_contact(db, a).map(|row| json!({ "ok": true, "contact": row })),
        "save_playbook" => save_playbook(db, a).map(|row| json!({ "ok": true, "playbook": row })),
        "report_playbook" => {
            let ok = a["ok"].as_bool().unwrap_or(true);
            report_playbook(db, a["id"].as_i64().unwrap_or(0), ok).map(|m| json!({ "ok": true, "message": m }))
        }
        "delete" => {
            match s(&a["tier"]).trim().to_ascii_lowercase().as_str() {
                "profile" => {
                    let k = s(&a["key"]).trim().to_string();
                    if k.is_empty() { return Err("Give key to delete a profile entry.".into()); }
                    db.run("delete from memory where tier='profile' and key=?", args!(k));
                    delete_fts(db, "profile", &k);
                    Ok(json!({ "ok": true, "deleted": k }))
                }
                "contact" => {
                    let id = a["id"].as_i64().filter(|i| *i > 0)
                        .or_else(|| db.get("select id from memory where tier='contact' and lower(key)=lower(?)", args!(s(&a["name"]).trim())).and_then(|r| r["id"].as_i64()))
                        .ok_or("Give contact id or name to delete.")?;
                    db.run("delete from memory where id=? and tier='contact'", args!(id));
                    delete_fts(db, "contact", &id.to_string());
                    Ok(json!({ "ok": true, "deleted": id }))
                }
                "playbook" => {
                    let id = a["id"].as_i64().filter(|i| *i > 0).ok_or("Give playbook id to delete.")?;
                    db.run("delete from memory where id=? and tier='playbook'", args!(id));
                    delete_fts(db, "playbook", &id.to_string());
                    Ok(json!({ "ok": true, "deleted": id }))
                }
                other => Err(format!("Unknown memory tier '{other}' (use profile, contact, or playbook).")),
            }
        }
        other => Err(format!("Unknown memory action '{other}' (use search, get, save_profile, save_contact, save_playbook, report_playbook, or delete).")),
    }
}

fn get(db: &Db, tier: &str, key: &str, host: &str, id: i64) -> Result<Value, String> {
    match tier.trim().to_ascii_lowercase().as_str() {
        "profile" => {
            let rows = if key.trim().is_empty() { db.all("select key, value, updated from memory where tier='profile' order by key", &[]) }
                else { db.all("select key, value, updated from memory where tier='profile' and key=?", args!(key.trim())) };
            Ok(json!({ "profile": rows }))
        }
        "contact" => {
            let rows = if id > 0 { db.all("select * from memory where id=? and tier='contact'", args!(id)) }
                else if !key.trim().is_empty() { db.all("select * from memory where tier='contact' and lower(key) like lower(?) order by key", args!(format!("%{}%", key.trim()))) }
                else { db.all("select * from memory where tier='contact' order by key limit 50", &[]) };
            Ok(json!({ "contacts": rows.iter().map(contact_json).collect::<Vec<_>>() }))
        }
        "playbook" => {
            if !host.trim().is_empty() && id <= 0 { return Ok(json!({ "playbooks": playbooks_for_host(db, host) })); }
            let rows = if id > 0 { db.all("select * from memory where id=? and tier='playbook'", args!(id)) }
                else { db.all("select * from memory where tier='playbook' order by fails asc, uses desc, updated desc limit 50", &[]) };
            Ok(json!({ "playbooks": rows.iter().map(playbook_json).collect::<Vec<_>>() }))
        }
        "" => {
            if !key.trim().is_empty() {
                return Ok(json!({ "profile": db.all("select key, value from memory where tier='profile' and key=?", args!(key.trim())) }));
            }
            if !host.trim().is_empty() {
                return Ok(json!({ "playbooks": playbooks_for_host(db, host) }));
            }
            Ok(json!({
                "profile": db.all("select key, value from memory where tier='profile' order by key", &[]),
                "contacts": db.all("select * from memory where tier='contact' order by key limit 30", &[]).iter().map(contact_json).collect::<Vec<_>>(),
                "playbooks": db.all("select * from memory where tier='playbook' order by fails asc, uses desc limit 30", &[]).iter().map(playbook_json).collect::<Vec<_>>(),
            }))
        }
        other => Err(format!("Unknown memory tier '{other}' (use profile, contact, playbook, or empty).")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_secrets_and_payment_cards() {
        assert!(looks_like_secret("password", "anything"));
        assert!(looks_like_secret("wifi_passcode", "1234"));
        assert!(looks_like_secret("token", "sk-abcdefghijklmnopqrstuvwxyz1234"));
        assert!(looks_like_secret("note", "my card is 4111 1111 1111 1111"));
        assert!(!looks_like_secret("phone", "608-555-0199"));
        assert!(!looks_like_secret("home_address", "123 Main St, Madison WI 53703"));
    }

    #[test]
    fn fts_search_across_all_tiers_and_stale_playbook_suppression() {
        let db = Db::open(":memory:");
        save_profile(&db, "home_address", "123 State St, Madison WI").unwrap();
        assert!(save_profile(&db, "api_key", "sk-abcdefghijklmnopqrstuvwxyz1234").is_err());
        let c = save_contact(&db, &json!({"name":"Alex Chen","relation":"advisor","email":"alex@example.edu","org":"UW Madison"})).unwrap();
        assert_eq!(c["relation"], "advisor");
        assert!(save_playbook(&db, &json!({"host":"canvas.wisc.edu","title":"Submit","steps":"click [data-hive=4]"})).is_err());
        let p = save_playbook(&db, &json!({"host":"https://www.canvas.wisc.edu/courses","title":"Check assignments","steps":"Open /courses then Upcoming","selectors":"a[href*='/assignments']"})).unwrap();
        let pid = p["id"].as_i64().unwrap();
        assert_eq!(p["host"], "canvas.wisc.edu");

        // FTS5 BM25 hits across profile, contact, playbook
        let hits = search(&db, "Madison", "", 10);
        assert!(hits.iter().any(|h| h["tier"] == "profile" && h["key"] == "home_address"));
        assert!(hits.iter().any(|h| h["tier"] == "contact" && h["name"] == "Alex Chen"));
        let phits = search(&db, "assignments canvas", "playbook", 10);
        assert_eq!(phits.len(), 1);

        // Auto-injection matches host + subdomains, suppresses after 2 failures
        assert_eq!(playbooks_for_host(&db, "https://sub.canvas.wisc.edu/x").len(), 1);
        report_playbook(&db, pid, false).unwrap();
        assert_eq!(playbooks_for_host(&db, "canvas.wisc.edu").len(), 1);
        report_playbook(&db, pid, false).unwrap();
        assert_eq!(playbooks_for_host(&db, "canvas.wisc.edu").len(), 0);
        // Re-verifying restores it
        report_playbook(&db, pid, true).unwrap();
        assert_eq!(playbooks_for_host(&db, "canvas.wisc.edu").len(), 1);
    }

    #[test]
    fn extracts_hosts_from_text() {
        assert_eq!(extract_hosts("Check https://www.canvas.wisc.edu/courses and mail@example.com or portal.wisc.edu."),
            vec!["canvas.wisc.edu", "portal.wisc.edu"]);
    }
}
