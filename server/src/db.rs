//! Hive's one database: requests, projects, tasks, agents, messages, rules, memory, nodes, calls, files, sim, log.
use rusqlite::types::{Value as Sql, ValueRef};
use rusqlite::{params_from_iter, Connection};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::sync::Mutex;

pub const SCHEMA: &str = "
create table if not exists requests(id integer primary key, at integer, node text, agent text, text text, context text,
  status text default 'new', reply text);
create table if not exists projects(slug text primary key, title text default '', summary text default '',
  default_nodes text default '[]', status text default 'active', updated integer default 0);
create table if not exists tasks(id integer primary key, request_id integer, project text default '', title text, quote text,
  nodes text default '[]', level text default 'normal', status text default 'open', agent_id integer, outcome text,
  why text, need text, at integer, updated integer, every integer default 0, depends_on integer default 0,
  continue_agent integer default 0, external_ref text default '');
create table if not exists rules(id integer primary key, text text, quote text, scope text default '', code text,
  at integer, active integer default 1);
create table if not exists agents(id integer primary key, task_id integer, kind text default 'codex', role text default 'worker', name text, thread text,
  status text default 'working', at integer, updated integer, tools text default '', model text default '', effort text default '',
  usage text default '{}', cursors text default '{}');
create table if not exists messages(id integer primary key, at integer, from_agent integer default 0, from_task integer default 0,
  to_agent integer default 0, to_task integer default 0, kind text default 'fact', hops integer default 1, text text, seen integer default 0);
create table if not exists log(id integer primary key, at integer, agent_id integer, task_id integer, request_id integer,
  who text, text text);
create table if not exists nodes(id text primary key, kind text, name text, notes text default '', tools text default '[]', seen integer,
  version text);
create table if not exists calls(id integer primary key, node text, tool text, args text, status text default 'queued',
  result text, agent_id integer, at integer);
create table if not exists tokens(hash text primary key, node text, node_id text default '', at integer);
create table if not exists memory(id integer primary key, tier text not null, key text default '', title text default '',
  value text default '', meta text default '{}', uses integer default 0, fails integer default 0, verified_at integer default 0, updated integer default 0);
create virtual table if not exists memory_fts using fts5(tier, ref_id unindexed, key_or_host, body, tokenize='porter unicode61');
create table if not exists files(id integer primary key, name text, size integer, node text, at integer);
create table if not exists sim(id integer primary key, problem text, what text, files text default '', engine text default '',
  model text default '', predicted text default '', fixed text default '', missed text default '', passed integer default 0,
  total integer default 0, net_loc integer default 0, status text default 'proposed', commit_sha text default '', at integer);
create index if not exists log_agent on log(agent_id, id);
create index if not exists log_task on log(task_id, id);
create index if not exists tasks_status on tasks(status);
create index if not exists messages_pair on messages(from_task, to_task, id);
create index if not exists messages_inbox on messages(to_agent, kind, seen);
create index if not exists memory_tier_key on memory(tier, key);
";

pub fn now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

pub struct Db(Mutex<Connection>);

fn to_sql(v: &Value) -> Sql {
    match v {
        Value::Null => Sql::Null,
        Value::Bool(b) => Sql::Integer(*b as i64),
        Value::Number(n) => n.as_i64().map(Sql::Integer).unwrap_or_else(|| Sql::Real(n.as_f64().unwrap_or(0.0))),
        Value::String(s) => Sql::Text(s.clone()),
        other => Sql::Text(other.to_string()),
    }
}

fn from_sql(v: ValueRef) -> Value {
    match v {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(i) => json!(i),
        ValueRef::Real(f) => json!(f),
        ValueRef::Text(t) => json!(String::from_utf8_lossy(t)),
        ValueRef::Blob(b) => json!(format!("<{} bytes>", b.len())),
    }
}

#[macro_export]
macro_rules! args {
    ($($x:expr),* $(,)?) => { &[$(serde_json::json!($x)),*][..] };
}

impl Db {
    pub fn open(path: &str) -> Db {
        let c = Connection::open(path).expect("open database");
        c.execute_batch("pragma journal_mode=wal; pragma busy_timeout=5000;").ok();
        c.execute_batch(SCHEMA).expect("schema");
        // Columns added since older databases were made (harmless no-op once present).
        for sql in [
            "alter table tasks add column every integer default 0",
            "alter table tasks add column depends_on integer default 0",
            "alter table tasks add column continue_agent integer default 0",
            "alter table tasks add column external_ref text default ''",
            "alter table agents add column name text",
            "alter table agents add column at integer",
            "alter table agents add column updated integer",
            "alter table agents add column tools text default ''",
            "alter table agents add column model text default ''",
            "alter table agents add column effort text default ''",
            "alter table agents add column role text default 'worker'",
            "alter table agents add column usage text default '{}'",
            "alter table agents add column cursors text default '{}'",
            "alter table messages add column to_agent integer default 0",
            "alter table messages add column seen integer default 0",
            "alter table tokens add column node_id text default ''",
            "alter table sim add column net_loc integer default 0",
            "alter table nodes add column display_name text",
            "update agents set role='external' where kind='claude' and coalesce(role,'worker')='worker'",
        ] { c.execute_batch(sql).ok(); }
        let db = Db(Mutex::new(c));
        db.migrate_legacy();
        crate::memory::sync_fts(&db);
        db
    }

    fn has_table(&self, name: &str) -> bool {
        self.get("select 1 from sqlite_master where type='table' and name=?", args!(name)).is_some()
    }

    /// Fold legacy fragmented tables into the consolidated schema and drop them cleanly.
    fn migrate_legacy(&self) {
        if self.has_table("node_tokens") {
            for r in self.all("select node, hash from node_tokens", &[]) {
                self.run("update tokens set node_id=? where hash=?", args!(r["node"].clone(), r["hash"].clone()));
            }
            self.run("drop table if exists node_tokens", &[]);
        }
        if self.has_table("inbox") {
            self.run("insert into messages(at, from_agent, from_task, to_agent, to_task, kind, hops, text, seen) \
                select coalesce(at,0), 0, 0, coalesce(agent_id,0), 0, 'inbox', 1, coalesce(text,''), coalesce(seen,0) from inbox", &[]);
            self.run("drop table if exists inbox", &[]);
        }
        if self.has_table("session_events") {
            let mut by_agent: HashMap<i64, Map<String, Value>> = HashMap::new();
            for r in self.all("select agent, source, max(offset) as off from session_events group by agent, source", &[]) {
                if let (Some(aid), Some(src), Some(off)) = (r["agent"].as_i64(), r["source"].as_str(), r["off"].as_u64()) {
                    by_agent.entry(aid).or_default().insert(src.to_string(), json!(off));
                }
            }
            for (aid, map) in by_agent {
                self.run("update agents set cursors=? where id=?", args!(Value::Object(map).to_string(), aid));
            }
            self.run("drop table if exists session_events", &[]);
        }
        if self.has_table("usage") {
            for r in self.all("select thread, agent_id, total, input, output, cached from usage", &[]) {
                let thread = r["thread"].as_str().unwrap_or("");
                let aid = r["agent_id"].as_i64().unwrap_or(0);
                if !thread.is_empty() {
                    self.save_usage(thread, aid, &json!({
                        "totalTokens": r["total"], "inputTokens": r["input"],
                        "outputTokens": r["output"], "cachedInputTokens": r["cached"],
                    }));
                }
            }
            self.run("drop table if exists usage", &[]);
        }
        if self.has_table("apple_links") {
            for r in self.all("select external_id, kind, task_id from apple_links where task_id>0", &[]) {
                let eref = format!("{}:{}", r["kind"].as_str().unwrap_or("reminder"), r["external_id"].as_str().unwrap_or(""));
                self.run("update tasks set external_ref=? where id=? and coalesce(external_ref,'')=''", args!(eref, r["task_id"].clone()));
            }
            self.run("drop table if exists apple_links", &[]);
        }
        if self.has_table("info") {
            for r in self.all("select key, value, updated from info", &[]) {
                let k = r["key"].as_str().unwrap_or("");
                if !k.is_empty() && self.get("select 1 from memory where tier='profile' and key=?", args!(k)).is_none() {
                    self.run("insert into memory(tier, key, value, updated) values('profile',?,?,?)",
                        args!(k, r["value"].clone(), r["updated"].as_i64().unwrap_or(0)));
                }
            }
            self.run("drop table if exists info", &[]);
        }
        if self.has_table("contacts") {
            for r in self.all("select name, relation, email, phone, org, notes, updated from contacts", &[]) {
                let name = r["name"].as_str().unwrap_or("");
                if !name.is_empty() && self.get("select 1 from memory where tier='contact' and lower(key)=lower(?)", args!(name)).is_none() {
                    let meta = json!({ "email": r["email"], "phone": r["phone"], "org": r["org"] }).to_string();
                    self.run("insert into memory(tier, key, title, value, meta, updated) values('contact',?,?,?,?,?)",
                        args!(name, r["relation"].clone(), r["notes"].clone(), meta, r["updated"].as_i64().unwrap_or(0)));
                }
            }
            self.run("drop table if exists contacts", &[]);
        }
        if self.has_table("playbooks") {
            for r in self.all("select host, title, steps, selectors, uses, fails, verified_at, updated from playbooks", &[]) {
                let host = r["host"].as_str().unwrap_or("");
                let title = r["title"].as_str().unwrap_or("");
                if !host.is_empty() && self.get("select 1 from memory where tier='playbook' and key=? and lower(title)=lower(?)", args!(host, title)).is_none() {
                    let meta = json!({ "selectors": r["selectors"] }).to_string();
                    self.run("insert into memory(tier, key, title, value, meta, uses, fails, verified_at, updated) values('playbook',?,?,?,?,?,?,?,?)",
                        args!(host, title, r["steps"].clone(), meta, r["uses"].as_i64().unwrap_or(0),
                              r["fails"].as_i64().unwrap_or(0), r["verified_at"].as_i64().unwrap_or(0), r["updated"].as_i64().unwrap_or(0)));
                }
            }
            self.run("drop table if exists playbooks", &[]);
        }
    }

    /// Upsert cumulative token usage for a thread into `agents.usage` (agent 0 = orchestrator row).
    pub fn save_usage(&self, thread: &str, agent: i64, usage: &Value) {
        if !usage["totalTokens"].is_number() || thread.is_empty() { return; }
        if agent == 0 {
            self.run("insert or ignore into agents(id, kind, role, name, status, at, updated) values(0, 'orchestrator', 'orchestrator', 'orchestrator', 'system', ?, ?)", args!(now(), now()));
        }
        let existing = self.get("select usage from agents where id=?", args!(agent))
            .and_then(|r| r["usage"].as_str().map(String::from))
            .and_then(|s| serde_json::from_str::<Map<String, Value>>(&s).ok())
            .unwrap_or_default();
        let mut map = existing;
        map.insert(thread.to_string(), json!({
            "total": usage["totalTokens"].as_i64().unwrap_or(0),
            "input": usage["inputTokens"].as_i64().unwrap_or(0),
            "output": usage["outputTokens"].as_i64().unwrap_or(0),
            "cached": usage["cachedInputTokens"].as_i64().unwrap_or(0),
        }));
        self.run("update agents set usage=? where id=?", args!(Value::Object(map).to_string(), agent));
    }

    /// Aggregate token usage across threads recorded on an agent row (0 = orchestrator).
    pub fn usage_for(&self, agent: i64) -> Option<Value> {
        let raw = self.get("select usage from agents where id=?", args!(agent))?.get("usage")?.as_str()?.to_string();
        let map = serde_json::from_str::<Map<String, Value>>(&raw).ok()?;
        if map.is_empty() { return None; }
        let (mut total, mut input, mut output, mut cached) = (0i64, 0i64, 0i64, 0i64);
        for v in map.values() {
            total += v["total"].as_i64().unwrap_or(0);
            input += v["input"].as_i64().unwrap_or(0);
            output += v["output"].as_i64().unwrap_or(0);
            cached += v["cached"].as_i64().unwrap_or(0);
        }
        Some(json!({ "total": total, "input": input, "output": output, "cached": cached }))
    }

    pub fn all(&self, sql: &str, args: &[Value]) -> Vec<Value> {
        let c = self.0.lock().unwrap();
        let mut st = match c.prepare(sql) { Ok(s) => s, Err(e) => { eprintln!("sql {sql}: {e}"); return vec![]; } };
        let names: Vec<String> = st.column_names().into_iter().map(|s| s.to_string()).collect();
        let rows = st.query_map(params_from_iter(args.iter().map(to_sql)), |r| {
            let mut m = Map::new();
            for (i, n) in names.iter().enumerate() { m.insert(n.clone(), from_sql(r.get_ref(i)?)); }
            Ok(Value::Object(m))
        });
        match rows { Ok(rows) => rows.flatten().collect(), Err(e) => { eprintln!("sql {sql}: {e}"); vec![] } }
    }

    pub fn get(&self, sql: &str, args: &[Value]) -> Option<Value> {
        self.all(sql, args).into_iter().next()
    }

    pub fn run(&self, sql: &str, args: &[Value]) -> i64 {
        let c = self.0.lock().unwrap();
        match c.execute(sql, params_from_iter(args.iter().map(to_sql))) {
            Ok(_) => c.last_insert_rowid(),
            Err(e) => { eprintln!("sql {sql}: {e}"); 0 }
        }
    }

    pub fn batch(&self, statements: &[(&str, Vec<Value>)]) -> Result<(), String> {
        let mut c = self.0.lock().unwrap();
        let tx = c.transaction().map_err(|e| e.to_string())?;
        for (sql, values) in statements { tx.execute(sql, params_from_iter(values.iter().map(to_sql))).map_err(|e| e.to_string())?; }
        tx.commit().map_err(|e| e.to_string())
    }

    /// User-visible tables (hides auth tokens and SQLite FTS5 internal shadow tables).
    pub fn tables(&self) -> Vec<String> {
        self.all("select name from sqlite_master where type='table' order by name", &[])
            .into_iter()
            .filter_map(|r| r["name"].as_str().map(String::from))
            .filter(|n| n != "tokens" && !n.starts_with("memory_fts") && !n.starts_with("sqlite_"))
            .collect()
    }
}

/// Whether a rule's scope applies: '' always; project:<slug>; node:<kind>; site:<host> (and subdomains); app:<name>; folder:<path>.
pub fn scope_applies(scope: &str, nodes: &[String], site: &str, app: &str, folder: &str, project: &str) -> bool {
    let Some((kind, val)) = scope.split_once(':') else { return scope.is_empty() };
    let val = val.trim();
    match kind {
        "project" => !project.is_empty() && project.eq_ignore_ascii_case(val),
        "node" => nodes.iter().any(|n| n == val),
        "site" => {
            let site = site.trim_start_matches("www.");
            let val = val.trim_start_matches("www.");
            !site.is_empty() && (site == val || site.ends_with(&format!(".{val}")) || site.starts_with(val))
        }
        "app" => !app.is_empty() && app.eq_ignore_ascii_case(val),
        "folder" => !folder.is_empty() && folder.starts_with(val),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn scopes() {
        let mac = vec!["mac".to_string()];
        assert!(scope_applies("", &[], "", "", "", ""));
        assert!(scope_applies("project:hive", &[], "", "", "", "Hive"));
        assert!(!scope_applies("project:hive", &[], "", "", "", "other"));
        assert!(scope_applies("node:mac", &mac, "", "", "", ""));
        assert!(!scope_applies("node:phone", &mac, "", "", "", ""));
        assert!(scope_applies("site:youtube.com", &[], "m.youtube.com", "", "", ""));
        assert!(!scope_applies("site:youtube.com", &[], "", "", "", ""));
        assert!(scope_applies("folder:/Users/x/hive", &[], "", "", "/Users/x/hive/server", ""));
        assert!(scope_applies("app:Notes", &[], "", "notes", "", ""));
    }
    #[test]
    fn round_trip() {
        let db = Db::open(":memory:");
        let id = db.run("insert into tasks(title, nodes, at) values(?, ?, ?)", args!("t", ["mac"], 5));
        let row = db.get("select * from tasks where id=?", args!(id)).unwrap();
        assert_eq!(row["title"], "t");
        assert_eq!(row["nodes"], "[\"mac\"]");
        assert_eq!(row["status"], "open");
    }
    #[test]
    fn older_database_gains_repeats() {
        let path = std::env::temp_dir().join(format!("hive-old-{}.db", std::process::id()));
        Connection::open(&path).unwrap().execute_batch("create table tasks(id integer primary key, title text, status text, updated integer); \
            create table agents(id integer primary key, task_id integer, kind text)").unwrap();
        let db = Db::open(path.to_str().unwrap());
        db.run("insert into tasks(title, status, updated, every, depends_on, continue_agent) values('daily', 'done', 0, 24, 0, 0)", &[]);
        db.run("insert into tasks(title, status, updated) values('once', 'done', 0)", &[]);
        db.run("insert into agents(task_id, kind, role, model, effort) values(1, 'codex', 'worker', 'gpt-6.1-terra', 'low')", &[]);
        assert_eq!(db.get("select role, model, effort from agents where task_id=1", &[]),
            Some(json!({ "role": "worker", "model": "gpt-6.1-terra", "effort": "low" })));
        let tables = db.tables();
        assert!(tables.iter().any(|t| t == "sim") && tables.iter().any(|t| t == "projects") && tables.iter().any(|t| t == "messages"));
        let due = db.all("select title from tasks where every>0 and status='done' and updated<=?-every*3600000", args!(now()));
        assert_eq!(due, vec![json!({ "title": "daily" })]);
        drop(db);
        std::fs::remove_file(&path).ok();
    }
    #[test]
    fn migrates_and_drops_legacy_tables_and_hides_internals() {
        let path = std::env::temp_dir().join(format!("hive-legacy-{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        Connection::open(&path).unwrap().execute_batch("
            create table tasks(id integer primary key, title text, status text, updated integer);
            create table agents(id integer primary key, task_id integer, kind text, status text);
            create table tokens(hash text primary key, node text, at integer);
            create table node_tokens(node text primary key, hash text unique);
            create table inbox(id integer primary key, agent_id integer, text text, at integer, seen integer default 0);
            create table session_events(agent integer, source text, offset integer, primary key(agent,source,offset));
            create table usage(thread text primary key, agent_id integer, total integer, input integer, output integer, cached integer);
            create table apple_links(external_id text primary key, kind text, task_id integer, project text, updated integer);
            create table info(key text primary key, value text, updated integer);
            create table contacts(id integer primary key, name text, relation text, email text, phone text, org text, notes text, updated integer);
            create table playbooks(id integer primary key, host text, title text, steps text, selectors text, uses integer, fails integer, verified_at integer, updated integer);
            insert into tasks(id, title, status, updated) values(1, 'T', 'open', 1);
            insert into agents(id, task_id, kind, status) values(2, 1, 'claude', 'idle');
            insert into tokens(hash, node, at) values('h1', 'mac:mbp', 1);
            insert into node_tokens(node, hash) values('mac-1', 'h1');
            insert into inbox(agent_id, text, at, seen) values(2, 'ping', 10, 0);
            insert into session_events(agent, source, offset) values(2, 'a.jsonl', 50), (2, 'a.jsonl', 120);
            insert into usage(thread, agent_id, total, input, output, cached) values('t0', 0, 90, 70, 20, 10), ('t2', 2, 55, 40, 15, 5);
            insert into apple_links(external_id, kind, task_id, project, updated) values('ek-9', 'reminder', 1, '', 1);
            insert into info(key, value, updated) values('city', 'Madison', 1);
            insert into contacts(name, relation, email, phone, org, notes, updated) values('Sam', 'peer', 's@x.edu', '', 'UW', 'lab', 1);
            insert into playbooks(host, title, steps, selectors, uses, fails, verified_at, updated) values('canvas.wisc.edu', 'Grades', 'Open grades', '.grade', 3, 0, 1, 1);
        ").unwrap();
        let db = Db::open(path.to_str().unwrap());
        let tables = db.tables();
        assert_eq!(tables, vec!["agents", "calls", "files", "log", "memory", "messages", "nodes", "projects", "requests", "rules", "sim", "tasks"]);
        assert_eq!(db.get("select node_id from tokens where hash='h1'", &[]).unwrap()["node_id"], "mac-1");
        assert_eq!(db.get("select text, seen from messages where to_agent=2 and kind='inbox'", &[]).unwrap()["text"], "ping");
        assert_eq!(db.get("select cursors from agents where id=2", &[]).unwrap()["cursors"], "{\"a.jsonl\":120}");
        assert_eq!(db.usage_for(0).unwrap()["total"], 90);
        assert_eq!(db.usage_for(2).unwrap()["total"], 55);
        assert_eq!(db.get("select external_ref from tasks where id=1", &[]).unwrap()["external_ref"], "reminder:ek-9");
        assert_eq!(crate::memory::get_profile(&db, "city"), "city: Madison");
        assert_eq!(crate::memory::playbooks_for_host(&db, "canvas.wisc.edu").len(), 1);
        assert!(crate::memory::search(&db, "Sam", "contact", 5).len() == 1);
        drop(db);
        std::fs::remove_file(&path).ok();
    }
}
