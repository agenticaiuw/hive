//! Hive's action memory without the cloud: what a step's record never holds, how the same step and
//! the same run are counted instead of stored twice, the migration, and what goes with a request.
//! The cloud is a fake `cf` that runs D1's SQL on an in-memory SQLite database with the
//! repository's real schema. Every name, site and value here is made up.

mod common;

use hive_knowledge::actions::{self, Place, Recorder, StepInput, TaskInfo};
use hive_knowledge::knowledge::{Cli, CliOutput, KnowledgeBase, NOTICE};
use rusqlite::types::{Value as Sql, ValueRef};
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

// --- the fake cloud -----------------------------------------------------------------------------

/// `cf d1 ...` against an in-memory SQLite database.
struct FakeD1 {
    db: Mutex<rusqlite::Connection>,
    online: AtomicBool,
    migrations_applied: Mutex<usize>,
}

impl FakeD1 {
    fn new() -> Arc<FakeD1> {
        Arc::new(FakeD1 {
            db: Mutex::new(rusqlite::Connection::open_in_memory().unwrap()),
            online: AtomicBool::new(true),
            migrations_applied: Mutex::new(0),
        })
    }

    /// Only the first migration, as a database made before the action tables.
    fn with_facts_only() -> Arc<FakeD1> {
        let fake = FakeD1::new();
        let first = migrations().join("0001_knowledge.sql");
        fake.db
            .lock()
            .unwrap()
            .execute_batch(&std::fs::read_to_string(first).unwrap())
            .unwrap();
        fake
    }

    fn rows(&self, sql: &str) -> Vec<Value> {
        let db = self.db.lock().unwrap();
        select(&db, sql, Vec::new()).unwrap()
    }

    fn run_batch(&self, path: &Path) -> Result<Value, String> {
        let text = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
        let batch: Vec<Value> = serde_json::from_str(&text).map_err(|e| e.to_string())?;
        let db = self.db.lock().unwrap();
        let mut answers = Vec::new();
        for statement in batch {
            let sql = statement["sql"].as_str().ok_or("no sql")?;
            let params: Vec<Sql> = statement["params"]
                .as_array()
                .cloned()
                .unwrap_or_default()
                .iter()
                .map(|p| match p {
                    Value::Null => Sql::Null,
                    Value::Bool(b) => Sql::Integer(i64::from(*b)),
                    Value::Number(n) => n.as_i64().map(Sql::Integer).unwrap_or(Sql::Null),
                    Value::String(s) => Sql::Text(s.clone()),
                    other => Sql::Text(other.to_string()),
                })
                .collect();
            let results = select(&db, sql, params)?;
            answers.push(json!({"results": results, "success": true, "meta": {}}));
        }
        Ok(Value::Array(answers))
    }
}

fn select(db: &rusqlite::Connection, sql: &str, params: Vec<Sql>) -> Result<Vec<Value>, String> {
    let mut stmt = db.prepare(sql).map_err(|e| e.to_string())?;
    let names: Vec<String> = stmt.column_names().map(|n| n.to_string()).collect();
    let mut rows = stmt
        .query(rusqlite::params_from_iter(params))
        .map_err(|e| e.to_string())?;
    let mut results = Vec::new();
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let mut out = Map::new();
        for (i, name) in names.iter().enumerate() {
            let cell = match row.get_ref(i).unwrap() {
                ValueRef::Null | ValueRef::Blob(_) => Value::Null,
                ValueRef::Integer(v) => json!(v),
                ValueRef::Real(v) => json!(v),
                ValueRef::Text(t) => json!(String::from_utf8_lossy(t)),
            };
            out.insert(name.clone(), cell);
        }
        results.push(Value::Object(out));
    }
    Ok(results)
}

fn answer(value: Value) -> Result<CliOutput, String> {
    Ok(CliOutput {
        code: 0,
        stdout: value.to_string(),
        stderr: String::new(),
    })
}

fn failure(said: String) -> Result<CliOutput, String> {
    Ok(CliOutput {
        code: 1,
        stdout: String::new(),
        stderr: said,
    })
}

impl Cli for FakeD1 {
    fn run(&self, args: &[String], _timeout: Duration) -> Result<CliOutput, String> {
        if !self.online.load(Ordering::SeqCst) {
            return Err("no network".into());
        }
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        match args.as_slice() {
            ["d1", "list"] => answer(json!([{"name": "hive-knowledge", "uuid": "fake-db"}])),
            ["d1", "migrations", "apply", "fake-db", "--dir", dir] => {
                let db = self.db.lock().unwrap();
                let mut files: Vec<PathBuf> = std::fs::read_dir(dir)
                    .unwrap()
                    .map(|e| e.unwrap().path())
                    .collect();
                files.sort();
                for file in files {
                    if let Err(e) = db.execute_batch(&std::fs::read_to_string(file).unwrap()) {
                        return failure(e.to_string());
                    }
                }
                *self.migrations_applied.lock().unwrap() += 1;
                answer(json!([]))
            }
            ["d1", "query", "fake-db", "--batch", file] => {
                match self.run_batch(Path::new(file.trim_start_matches('@'))) {
                    Ok(value) => answer(value),
                    Err(e) => failure(format!("D1_ERROR: {e}: SQLITE_ERROR")),
                }
            }
            _ => failure(format!("unknown command {args:?}")),
        }
    }
}

fn migrations() -> PathBuf {
    common::hive_root().join("cloud/knowledge/migrations")
}

fn base(dir: &Path, cli: Arc<FakeD1>) -> KnowledgeBase {
    KnowledgeBase::with(dir.join("knowledge"), "hive-knowledge", migrations(), cli)
}

// --- steps --------------------------------------------------------------------------------------

fn mac(tool: &str, arguments: Value) -> StepInput {
    StepInput {
        namespace: "mac".into(),
        tool: tool.into(),
        arguments,
        ok: true,
    }
}

fn portal() -> Place {
    Place {
        app: Some("Safari".into()),
        window: Some("Course Portal".into()),
        url: Some("https://portal.example.edu/courses/cs-101?session=abc#top".into()),
    }
}

fn record(step: &StepInput, place: Option<&Place>) -> Value {
    actions::record(step, place, None, "2026-11-13T10:00:00-06:00").expect("a record")
}

#[test]
fn unsafe_text_flags_secrets_codes_and_tokens_only() {
    for bad in [
        "Typing the password into the field",
        "Enter the code 4F7K2Q",
        "verification code",
        "482913",
        "Authorization: Bearer abc",
        "sk-abcdefghijklmnop1234",
        "4111 1111 1111 1111",
        "the API key page",
    ] {
        assert!(actions::unsafe_text(bad), "{bad}");
    }
    for good in [
        "Clicking Sign in",
        "Visual Studio Code",
        "~/code/hive",
        "Course Portal – Week 3",
        "Opening the 2026-11-13 schedule",
    ] {
        assert!(!actions::unsafe_text(good), "{good}");
    }
}

#[test]
fn what_was_typed_is_never_recorded_except_an_address() {
    let typed = record(
        &mac(
            "type_text",
            json!({"text": "my reply to Alex: see you at 3", "step": "Typing the reply"}),
        ),
        Some(&portal()),
    );
    assert_eq!(typed["element"], Value::Null);
    assert_eq!(typed["reason"], json!("Typing the reply"));
    assert!(!typed.to_string().contains("see you at 3"));

    let address = record(
        &mac(
            "type_text",
            json!({"text": "portal.example.edu/login?next=/grades&ticket=9f8e7d"}),
        ),
        Some(&portal()),
    );
    assert_eq!(address["element"], json!("portal.example.edu/login"));
    assert!(!address.to_string().contains("ticket"));

    let email = record(&mac("type_text", json!({"text": "alex@example.org"})), None);
    assert_eq!(email["element"], Value::Null);
}

#[test]
fn passwords_codes_and_the_sign_in_tool_are_dropped_whole() {
    let password = record(
        &mac(
            "click",
            json!({"x": 10, "y": 20, "step": "Clicking into the password field"}),
        ),
        Some(&portal()),
    );
    assert_eq!(password["reason"], Value::Null);
    assert_eq!(password["host"], json!("portal.example.edu"));

    let signin = record(
        &mac(
            "authenticate",
            json!({"service": "portal.example.edu", "username": "arivera", "step": "Signing in as arivera"}),
        ),
        Some(&portal()),
    );
    assert_eq!(signin["element"], Value::Null);
    assert_eq!(signin["reason"], Value::Null);
    assert!(!signin.to_string().contains("arivera"));

    let code_window = Place {
        app: Some("Messages".into()),
        window: Some("Your code is 482913".into()),
        url: None,
    };
    let read = record(
        &mac("press_key", json!({"keys": "cmd+v"})),
        Some(&code_window),
    );
    assert_eq!(read["window"], Value::Null);
    assert_eq!(read["app"], json!("Messages"));
    assert!(!read.to_string().contains("482913"));

    // A workspace call is the workspace's, and a knowledge call is the knowledge base's.
    assert!(actions::record(
        &mac("type_text", json!({"text": "workspace:{\"op\":\"read\"}"})),
        None,
        None,
        ""
    )
    .is_none());
}

#[test]
fn a_page_keeps_its_site_but_not_its_query_or_tokens() {
    let (page, host, site) = actions::web_page(
        "https://user:pw@mail.example.co.uk:8443/inbox/AbC123dEf456GhI789jKl/view?id=5#x",
    )
    .unwrap();
    assert_eq!(page, "https://mail.example.co.uk/inbox/…/view");
    assert_eq!(host, "mail.example.co.uk");
    assert_eq!(site, "example.co.uk");
    assert_eq!(actions::registrable("portal.example.edu"), "example.edu");
    assert_eq!(actions::registrable("10.0.0.5"), "10.0.0.5");
    assert!(actions::web_page("file:///Users/someone/notes.txt").is_none());
    assert!(actions::web_page("javascript:alert(1)").is_none());
}

#[test]
fn a_command_keeps_its_programs_files_and_codebase_not_its_arguments() {
    let dir = tempfile::tempdir().unwrap();
    let repo = dir.path().join("demo-repo");
    std::fs::create_dir_all(repo.join(".git")).unwrap();
    std::fs::create_dir_all(repo.join("src")).unwrap();
    let cwd = repo.join("src").to_string_lossy().into_owned();
    let command = format!(
        "/bin/zsh -lc 'cd {cwd} && GIT_PAGER=cat git status && curl -H \"Authorization: Bearer abc\" https://api.example.com | jq .'"
    );
    assert_eq!(
        actions::command_heads(&command),
        vec!["git status", "curl", "jq"]
    );
    let rec = actions::record(
        &StepInput {
            namespace: "shell".into(),
            tool: "command".into(),
            arguments: json!({"command": command, "cwd": cwd, "paths": [format!("{cwd}/main.rs")]}),
            ok: true,
        },
        None,
        None,
        "2026-11-13T10:00:00-06:00",
    )
    .unwrap();
    assert_eq!(rec["element"], json!("git status; curl; jq"));
    assert_eq!(rec["codebase"], json!(repo.to_string_lossy()));
    assert!(rec["paths"]
        .as_array()
        .unwrap()
        .contains(&json!(format!("{cwd}/main.rs"))));
    assert!(!rec.to_string().contains("Bearer"));
    assert_eq!(rec["app"], json!("shell"));
    assert_eq!(
        actions::command_paths("ls /usr/bin/env ~/Documents/plans"),
        vec!["~/Documents/plans"]
    );
}

#[test]
fn the_same_step_is_one_key() {
    let a = actions::step_key(
        "mac",
        "portal.example.edu",
        "click",
        "Clicking the Sign in button.",
    );
    let b = actions::step_key("mac", "Portal.Example.edu", "click", "click sign in");
    assert_eq!(a, b);
    assert_ne!(
        a,
        actions::step_key("mac", "portal.example.edu", "click", "Sign out")
    );
}

// --- the schema ---------------------------------------------------------------------------------

#[test]
fn the_migrations_apply_cleanly_and_twice() {
    let db = rusqlite::Connection::open_in_memory().unwrap();
    let mut files: Vec<PathBuf> = std::fs::read_dir(migrations())
        .unwrap()
        .map(|e| e.unwrap().path())
        .collect();
    files.sort();
    assert!(files.iter().any(|f| f.ends_with("0002_actions.sql")));
    for _ in 0..2 {
        for file in &files {
            db.execute_batch(&std::fs::read_to_string(file).unwrap())
                .unwrap();
        }
    }
    let tables = select(
        &db,
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
        vec![],
    )
    .unwrap();
    let names: Vec<&str> = tables.iter().filter_map(|t| t["name"].as_str()).collect();
    assert_eq!(names, vec!["action_runs", "actions", "knowledge"]);
}

// --- recording, counting, uploading -------------------------------------------------------------

fn task(run: &str) -> TaskInfo {
    TaskInfo {
        run: run.into(),
        request: "Check my grades on the course portal".into(),
        device: "mac".into(),
        receipt: Some("r-1".into()),
    }
}

fn record_task(recorder: &Arc<Recorder>, run: &str) {
    let t = task(run);
    recorder.begin(&t);
    recorder.step(
        &t,
        mac(
            "open_app",
            json!({"name": "Safari", "step": "Opening Safari"}),
        ),
    );
    recorder.step(
        &t,
        mac(
            "type_text",
            json!({"text": "portal.example.edu", "step": "Going to the portal"}),
        ),
    );
    recorder.step(&t, mac("screenshot", json!({})));
    recorder.step(
        &t,
        mac("click", json!({"x": 1, "y": 2, "step": "Clicking Grades"})),
    );
    recorder.step(
        &t,
        mac("click", json!({"x": 1, "y": 3, "step": "Clicking Grades"})),
    );
    recorder.step(
        &t,
        mac(
            "type_text",
            json!({"text": "correct horse battery", "step": "Typing the password"}),
        ),
    );
    recorder.end(&t, "done");
    assert!(recorder.flush(Duration::from_secs(10)));
}

#[test]
fn a_step_already_stored_is_counted_not_stored_again() {
    let dir = tempfile::tempdir().unwrap();
    let fake = FakeD1::new();
    let kb = base(dir.path(), fake.clone());
    let place: actions::PlaceFn = Arc::new(portal);
    let recorder = Recorder::without_upload(kb.clone(), place);

    record_task(&recorder, "run-1");
    let waiting = actions::pending(&kb.folder);
    assert_eq!(waiting.len(), 1);
    let steps = waiting[0]["row"]["steps"].as_array().unwrap().clone();
    // the two clicks on Grades are one step, taken twice; the screenshot isn't one to repeat
    assert_eq!(steps.len(), 4, "{steps:?}");
    assert_eq!(steps[2]["what"], json!("Clicking Grades"));
    assert_eq!(steps[2]["n"], json!(2));
    assert!(steps.iter().all(|s| s["tool"] != json!("screenshot")));
    let text = std::fs::read_to_string(kb.folder.join("actions-pending.jsonl")).unwrap();
    assert!(!text.contains("correct horse"));
    assert!(!text.contains("session=abc"));
    assert_eq!(
        common::mode(&kb.folder.join("actions-pending.jsonl")),
        0o600
    );
    assert!(!kb.folder.join("actions-open/run-1.jsonl").exists());

    let first = actions::upload(&kb).unwrap();
    assert_eq!((first.runs, first.cached, first.offline), (1, 1, None));
    assert!(actions::pending(&kb.folder).is_empty());

    record_task(&recorder, "run-2");
    actions::upload(&kb).unwrap();

    let runs = fake.rows("SELECT seen_count, outcome, request, sites, hosts FROM action_runs");
    assert_eq!(runs.len(), 1, "{runs:?}");
    assert_eq!(runs[0]["seen_count"], json!(2));
    assert_eq!(runs[0]["outcome"], json!("done"));
    assert_eq!(runs[0]["sites"], json!("[\"example.edu\"]"));
    let stored = fake
        .rows("SELECT step_key, ok_count, error_count, element, reason FROM actions ORDER BY id");
    assert_eq!(stored.len(), 5, "{stored:?}");
    let grades = stored
        .iter()
        .find(|r| r["reason"] == json!("Clicking Grades"))
        .unwrap();
    assert_eq!(grades["ok_count"], json!(4));
    assert_eq!(
        grades["step_key"],
        json!("mac|portal.example.edu|click|click grade")
    );
    let all = serde_json::to_string(&stored).unwrap();
    assert!(!all.contains("password") && !all.contains("correct horse"));

    let (cached, copied) = actions::cached_runs(&kb.folder);
    assert_eq!(cached.len(), 1);
    assert!(copied.is_some());
}

#[test]
fn a_database_made_before_the_action_tables_gets_them() {
    let dir = tempfile::tempdir().unwrap();
    let fake = FakeD1::with_facts_only();
    let kb = base(dir.path(), fake.clone());
    std::fs::create_dir_all(&kb.folder).unwrap();
    std::fs::write(
        kb.folder.join("database.json"),
        r#"{"name": "hive-knowledge", "id": "fake-db"}"#,
    )
    .unwrap();
    let recorder = Recorder::without_upload(kb.clone(), Arc::new(portal));
    record_task(&recorder, "run-1");
    let done = actions::upload(&kb).unwrap();
    assert_eq!(done.runs, 1);
    assert_eq!(*fake.migrations_applied.lock().unwrap(), 1);
    assert_eq!(fake.rows("SELECT id FROM action_runs").len(), 1);
}

#[test]
fn offline_the_runs_wait_and_a_run_hive_quit_during_is_closed_later() {
    let dir = tempfile::tempdir().unwrap();
    let fake = FakeD1::new();
    fake.online.store(false, Ordering::SeqCst);
    let kb = base(dir.path(), fake.clone());
    let recorder = Recorder::without_upload(kb.clone(), Arc::new(portal));
    let t = task("run-quit");
    recorder.begin(&t);
    recorder.step(&t, mac("click", json!({"step": "Clicking Grades"})));
    assert!(recorder.flush(Duration::from_secs(10)));
    assert!(kb.folder.join("actions-open/run-quit.jsonl").exists());

    assert_eq!(
        actions::close_orphans(&kb.folder, Duration::ZERO).unwrap(),
        1
    );
    let waiting = actions::pending(&kb.folder);
    assert_eq!(waiting.len(), 1);
    assert_eq!(waiting[0]["row"]["outcome"], json!("unknown"));

    let report = actions::upload(&kb).unwrap();
    assert_eq!(report.runs, 0);
    assert_eq!(report.offline.as_deref(), Some("no network"));
    assert_eq!(actions::pending(&kb.folder).len(), 1);

    fake.online.store(true, Ordering::SeqCst);
    assert_eq!(actions::upload(&kb).unwrap().runs, 1);
    assert!(actions::pending(&kb.folder).is_empty());
}

// --- what goes with a request -------------------------------------------------------------------

fn fact(id: i64, subject: &str, attribute: &str, value: &str, learned: &str) -> Value {
    json!({"id": id, "subject": subject, "attribute": attribute, "value": value, "kind": "fact",
           "source": "Course Portal profile", "learned_at": learned, "confirmed_at": null,
           "outdated_at": null})
}

fn run(request: &str, outcome: &str, seen: &str, hosts: &[&str], steps: Value) -> Value {
    json!({"run_key": seen, "task_key": actions::task_key(request), "request": request,
           "outcome": outcome, "hosts": hosts, "sites": [], "apps": ["Safari"], "codebases": [],
           "steps": steps.to_string(), "last_seen": seen})
}

fn grades_steps() -> Value {
    json!([
        {"tool": "open_app", "where": "Safari", "what": "Safari", "ok": true, "n": 1},
        {"tool": "type_text", "where": "Safari", "what": "portal.example.edu", "ok": true, "n": 1},
        {"tool": "screenshot", "where": "portal.example.edu", "what": "", "ok": true, "n": 3},
        {"tool": "click", "where": "portal.example.edu", "what": "Clicking Grades", "ok": true, "n": 1},
        {"tool": "click", "where": "portal.example.edu", "what": "Clicking Archive", "ok": false, "n": 1},
        {"tool": "click", "where": "portal.example.edu", "what": "Clicking Fall 2026", "ok": true, "n": 2}
    ])
}

#[test]
fn a_request_gets_the_facts_and_the_steps_that_worked_last_time() {
    let facts = vec![
        fact(1, "owner", "student id", "A1234567", "2026-09-01"),
        fact(
            2,
            "owner",
            "course portal username",
            "arivera",
            "2026-09-02",
        ),
        fact(
            3,
            "Course Portal",
            "help desk phone",
            "555-0142",
            "2026-09-03",
        ),
        fact(4, "Dana Lee", "email", "dana@example.org", "2026-09-04"),
        fact(5, "owner", "portal password", "hunter2", "2026-09-05"),
    ];
    let mut outdated = fact(
        6,
        "Course Portal",
        "help desk phone",
        "555-0199",
        "2026-01-01",
    );
    outdated["outdated_at"] = json!("2026-09-03");
    let mut all_facts = facts.clone();
    all_facts.push(outdated);
    let runs = vec![
        run(
            "Book a study room",
            "done",
            "2026-11-12T09:00:00-06:00",
            &["rooms.example.edu"],
            grades_steps(),
        ),
        run(
            "Check my grades on the course portal",
            "failed",
            "2026-11-11T09:00:00-06:00",
            &["portal.example.edu"],
            json!([{"tool": "click", "where": "portal.example.edu", "what": "Clicking Help", "ok": true, "n": 1}]),
        ),
        run(
            "check my grades on the course portal",
            "done",
            "2026-11-10T09:00:00-06:00",
            &["portal.example.edu"],
            grades_steps(),
        ),
    ];
    let text =
        actions::context_from("Check my grades on the course portal", &all_facts, &runs).unwrap();
    println!("{text}");
    assert!(text.starts_with("Knowledge base, attached automatically. "));
    assert!(text.contains(NOTICE));
    assert!(text.contains("Course Portal · help desk phone: 555-0142"));
    assert!(text.contains("course portal username: arivera"));
    assert!(!text.contains("555-0199"), "outdated");
    assert!(!text.contains("hunter2"), "secret");
    assert!(!text.contains("Dana Lee"), "unrelated");
    // the same request, done, beats the newer failed one and the newer unrelated one
    assert!(
        text.contains("(\"check my grades on the course portal\", 2026-11-10, done)"),
        "{text}"
    );
    assert!(text.contains("1. [Safari] open_app: Safari"));
    assert!(text.contains("3. [portal.example.edu] click: Clicking Grades"));
    assert!(text.contains("4. click: Clicking Fall 2026 (×2)"));
    assert!(!text.contains("screenshot") && !text.contains("Archive"));
    assert!(text.chars().count() <= actions::CONTEXT_LIMIT);
}

#[test]
fn a_named_site_finds_a_similar_task_and_nothing_unrelated_is_attached() {
    let runs = vec![run(
        "Download the syllabus from the course portal",
        "done",
        "2026-11-10T09:00:00-06:00",
        &["portal.example.edu"],
        grades_steps(),
    )];
    let named = actions::context_from(
        "open portal.example.edu and find the week 3 slides",
        &[],
        &runs,
    );
    assert!(named.unwrap().contains("Download the syllabus"));
    assert!(actions::context_from("What's the weather tomorrow", &[], &runs).is_none());
}

#[test]
fn the_attached_text_stays_within_its_bound() {
    let long = "x".repeat(150);
    let facts: Vec<Value> = (0..40)
        .map(|i| {
            fact(
                i,
                "Course Portal",
                &format!("note {i}"),
                &format!("portal {long}"),
                "2026-09-01",
            )
        })
        .collect();
    let steps: Vec<Value> = (0..80)
        .map(|i| json!({"tool": "click", "where": "portal.example.edu", "what": format!("Clicking item {i} {long}"), "ok": true, "n": 1}))
        .collect();
    let runs = vec![run(
        "check the course portal",
        "done",
        "2026-11-10",
        &["portal.example.edu"],
        Value::Array(steps),
    )];
    let text = actions::context_from("check the course portal", &facts, &runs).unwrap();
    assert!(
        text.chars().count() <= actions::CONTEXT_LIMIT,
        "{}",
        text.chars().count()
    );
    assert!(text.lines().filter(|l| l.starts_with("- ")).count() <= actions::CONTEXT_FACTS);
    assert!(text.lines().all(|l| l.chars().count() <= 200));
}

#[test]
fn the_context_comes_from_the_macs_copies_and_respects_an_opt_out() {
    let dir = tempfile::tempdir().unwrap();
    let kb = base(dir.path(), FakeD1::new());
    std::fs::create_dir_all(&kb.folder).unwrap();
    std::fs::write(
        kb.folder.join("cache.json"),
        json!({"facts": [fact(1, "Course Portal", "help desk phone", "555-0142", "2026-09-03")]})
            .to_string(),
    )
    .unwrap();
    let recorder = Recorder::without_upload(kb.clone(), Arc::new(portal));
    record_task(&recorder, "run-1"); // waiting to go up: still used
    let text = actions::context("Check my grades on the course portal", &kb.folder).unwrap();
    assert!(text.contains("555-0142"));
    assert!(text.contains("click: Clicking Grades (×2)"), "{text}");
    assert!(actions::context(
        "Check the course portal but don't use my memory",
        &kb.folder
    )
    .is_none());
    assert!(actions::context("type my password into the course portal", &kb.folder).is_none());
    assert!(actions::context("anything", Path::new("/nonexistent/folder")).is_none());
}
