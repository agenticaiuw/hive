//! Hive's one database: requests, tasks, agents, rules, the log, nodes, tool calls, files, info.
use rusqlite::types::{Value as Sql, ValueRef};
use rusqlite::{params_from_iter, Connection};
use serde_json::{json, Map, Value};
use std::sync::Mutex;

pub const SCHEMA: &str = "
create table if not exists requests(id integer primary key, at integer, node text, agent text, text text, context text,
  status text default 'new', reply text);
create table if not exists tasks(id integer primary key, request_id integer, project text default '', title text, quote text,
  nodes text default '[]', level text default 'normal', status text default 'open', agent_id integer, outcome text,
  why text, need text, at integer, updated integer, every integer default 0);
create table if not exists rules(id integer primary key, text text, quote text, scope text default '', code text,
  at integer, active integer default 1);
create table if not exists agents(id integer primary key, task_id integer, kind text default 'codex', name text, thread text,
  status text default 'working', at integer, updated integer, tools text default '');
create table if not exists log(id integer primary key, at integer, agent_id integer, task_id integer, request_id integer,
  who text, text text);
create table if not exists usage(thread text primary key, agent_id integer, total integer, input integer, output integer, cached integer);
create table if not exists inbox(id integer primary key, agent_id integer, text text, at integer, seen integer default 0);
create table if not exists nodes(id text primary key, kind text, name text, notes text default '', tools text default '[]', seen integer,
  version text);
create table if not exists calls(id integer primary key, node text, tool text, args text, status text default 'queued',
  result text, agent_id integer, at integer);
create table if not exists tokens(hash text primary key, node text, at integer);
create table if not exists node_tokens(node text primary key, hash text unique);
create table if not exists info(key text primary key, value text, updated integer);
create table if not exists files(id integer primary key, name text, size integer, node text, at integer);
create index if not exists log_agent on log(agent_id, id);
create index if not exists log_task on log(task_id, id);
create index if not exists tasks_status on tasks(status);
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
        // Columns added since a database was made (fails harmlessly once it has them).
        c.execute_batch("alter table tasks add column every integer default 0").ok();
        c.execute_batch("alter table agents add column tools text default ''").ok();
        Db(Mutex::new(c))
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

    pub fn tables(&self) -> Vec<String> {
        self.all("select name from sqlite_master where type='table' order by name", &[])
            .into_iter().filter_map(|r| r["name"].as_str().map(String::from)).collect()
    }
}

/// Whether a rule's scope applies: '' always; node:<kind>; site:<host> (and its subdomains); app:<name>; folder:<path>.
pub fn scope_applies(scope: &str, nodes: &[String], site: &str, app: &str, folder: &str) -> bool {
    let Some((kind, val)) = scope.split_once(':') else { return scope.is_empty() };
    let val = val.trim();
    match kind {
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
        assert!(scope_applies("", &[], "", "", ""));
        assert!(scope_applies("node:mac", &mac, "", "", ""));
        assert!(!scope_applies("node:phone", &mac, "", "", ""));
        assert!(scope_applies("site:youtube.com", &[], "m.youtube.com", "", ""));
        assert!(!scope_applies("site:youtube.com", &[], "", "", ""));
        assert!(scope_applies("folder:/Users/x/hive", &[], "", "", "/Users/x/hive/server"));
        assert!(scope_applies("app:Notes", &[], "", "notes", ""));
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
        Connection::open(&path).unwrap().execute_batch("create table tasks(id integer primary key, title text, status text, updated integer)").unwrap();
        let db = Db::open(path.to_str().unwrap());
        db.run("insert into tasks(title, status, updated, every) values('daily', 'done', 0, 24)", &[]);
        db.run("insert into tasks(title, status, updated) values('once', 'done', 0)", &[]);
        let due = db.all("select title from tasks where every>0 and status='done' and updated<=?-every*3600000", args!(now()));
        assert_eq!(due, vec![json!({ "title": "daily" })]);
        drop(db);
        std::fs::remove_file(&path).ok();
    }
}
