//! Hive's brain: every request is planned into tasks and rules, each task gets an agent (a Codex thread),
//! agents' tool calls reach the nodes, and only one agent at a time drives the Mac's input or the phone.
use crate::args;
use crate::codex::{tool_result, Codex, Event};
use crate::db::{now, Db};
use crate::{phone, tools};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{mpsc, Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

pub struct Hive {
    pub db: Db,
    pub state: PathBuf,
    pub repo: PathBuf,
    pub codex_cmd: String,
    pub codex_env: Vec<(String, String)>,
    pub owner_key: String,
    pub version: String,
    codex: Mutex<Option<Arc<Codex>>>,
    events: Mutex<Option<mpsc::Sender<Event>>>,
    loaded: Mutex<HashSet<String>>,
    turns: Mutex<HashMap<String, String>>,
    watchers: Mutex<HashMap<String, mpsc::Sender<(String, Value)>>>,
    nudges: Mutex<HashMap<i64, u32>>,
    last: Mutex<HashMap<i64, String>>,
    locks: Mutex<HashMap<String, (i64, i64)>>,
    changed: (Mutex<u64>, Condvar),
    pub phone: phone::Phone,
}

pub const LEVELS: [(&str, &str, &str); 4] = [
    ("easy", "gpt-6-luna", "low"), ("normal", "gpt-6.1-terra", "low"),
    ("hard", "gpt-6.1-sol", "medium"), ("hardest", "gpt-6-astra", "high"),
];
const PLANNER_MODEL: (&str, &str) = ("gpt-6.1-terra", "low");

fn s(v: &Value) -> String { v.as_str().map(String::from).unwrap_or_else(|| if v.is_null() { String::new() } else { v.to_string() }) }
fn short(t: &str, n: usize) -> String { if t.chars().count() <= n { t.into() } else { t.chars().take(n).collect::<String>() + "…" } }
pub fn list(v: &Value) -> Vec<String> {
    let parsed: Value = match v { Value::String(t) => serde_json::from_str(t).unwrap_or(Value::Null), o => o.clone() };
    parsed.as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default()
}

impl Hive {
    pub fn new(db: Db, state: PathBuf, repo: PathBuf, codex_cmd: String, codex_env: Vec<(String, String)>, owner_key: String, version: String) -> Arc<Hive> {
        let phone = phone::Phone::new(state.clone());
        Arc::new(Hive {
            db, state, repo, codex_cmd, codex_env, owner_key, version, phone,
            codex: Mutex::new(None), events: Mutex::new(None), loaded: Mutex::new(HashSet::new()),
            turns: Mutex::new(HashMap::new()), watchers: Mutex::new(HashMap::new()), nudges: Mutex::new(HashMap::new()), last: Mutex::new(HashMap::new()),
            locks: Mutex::new(HashMap::new()), changed: (Mutex::new(0), Condvar::new()),
        })
    }

    // ---- change notification: one counter, everyone who waits re-checks when it moves ----

    pub fn bump(&self) {
        *self.changed.0.lock().unwrap() += 1;
        self.changed.1.notify_all();
    }

    pub fn wait_until<T>(&self, ms: u64, mut f: impl FnMut() -> Option<T>) -> Option<T> {
        let end = Instant::now() + Duration::from_millis(ms);
        loop {
            let seen = *self.changed.0.lock().unwrap();
            if let Some(v) = f() { return Some(v); }
            let left = end.saturating_duration_since(Instant::now());
            if left.is_zero() { return None; }
            let g = self.changed.0.lock().unwrap();
            if *g != seen { continue; }
            let _ = self.changed.1.wait_timeout(g, left.min(Duration::from_secs(5))).unwrap();
        }
    }

    pub fn log(&self, agent: i64, task: i64, request: i64, who: &str, text: &str) {
        self.db.run("insert into log(at, agent_id, task_id, request_id, who, text) values(?,?,?,?,?,?)",
            args!(now(), agent, task, request, who, short(text, 20000)));
        self.bump();
    }

    // ---- Codex ----

    fn codex(self: &Arc<Self>) -> Result<Arc<Codex>, String> {
        let mut slot = self.codex.lock().unwrap();
        if let Some(c) = slot.as_ref() { if c.alive.load(std::sync::atomic::Ordering::SeqCst) { return Ok(c.clone()); } }
        let tx = self.events.lock().unwrap().clone().ok_or("Hive isn't running yet")?;
        let c = Codex::spawn(&self.codex_cmd, &self.codex_env, tx)?;
        self.loaded.lock().unwrap().clear();
        *slot = Some(c.clone());
        Ok(c)
    }

    pub fn run(self: &Arc<Self>) {
        let (tx, rx) = mpsc::channel();
        *self.events.lock().unwrap() = Some(tx);
        // Whatever was mid-way when Hive last stopped picks up again.
        self.db.run("update requests set status='new' where status='planning'", &[]);
        let me = self.clone();
        std::thread::spawn(move || me.resume_working());
        let me = self.clone();
        std::thread::spawn(move || loop { me.tick(); me.wait_until(3000, || None::<()>); });
        for ev in rx {
            match ev {
                Event::Tool(id, params) => {
                    let me = self.clone();
                    std::thread::spawn(move || {
                        let result = me.tool(&params);
                        if let Ok(c) = me.codex() { c.respond(id, result); }
                    });
                }
                Event::Note(method, params) => self.note(&method, params),
                Event::Stopped => {
                    eprintln!("Codex stopped; agents resume when it's back");
                    self.turns.lock().unwrap().clear();
                    let me = self.clone();
                    std::thread::spawn(move || { std::thread::sleep(Duration::from_secs(3)); me.resume_working(); });
                }
            }
        }
    }

    fn tick(self: &Arc<Self>) {
        for r in self.db.all("select id from requests where status='new' order by id", &[]) {
            let id = r["id"].as_i64().unwrap_or(0);
            self.db.run("update requests set status='planning' where id=?", args!(id));
            let me = self.clone();
            std::thread::spawn(move || me.plan(id));
        }
        for t in self.db.all("select id from tasks where status='open' and agent_id is null order by id", &[]) {
            let id = t["id"].as_i64().unwrap_or(0);
            self.db.run("update tasks set status='working', updated=? where id=?", args!(now(), id));
            let me = self.clone();
            std::thread::spawn(move || me.start_agent(id));
        }
    }

    fn resume_working(self: &Arc<Self>) {
        for a in self.db.all("select id from agents where kind='codex' and status='working' and thread is not null", &[]) {
            let id = a["id"].as_i64().unwrap_or(0);
            if let Err(e) = self.start_turn(id, "Hive restarted while you were working. Carry on with your task.") {
                eprintln!("couldn't resume agent {id}: {e}");
            }
        }
    }

    // ---- planning: a request becomes rules, tasks and messages to agents ----

    pub fn plan(self: &Arc<Self>, id: i64) {
        let Some(req) = self.db.get("select * from requests where id=?", args!(id)) else { return };
        let outcome = self.plan_inner(&req);
        match outcome {
            Ok(reply) => {
                self.db.run("update requests set status='planned', reply=? where id=?", args!(reply, id));
                self.log(0, 0, id, "hive", &reply);
            }
            Err(e) => {
                self.db.run("update requests set status='failed', reply=? where id=?", args!(format!("Hive couldn't plan this: {e}"), id));
                self.log(0, 0, id, "hive", &format!("Couldn't plan this request: {e}"));
            }
        }
        self.bump();
    }

    fn planner_input(&self, req: &Value) -> String {
        let mut t = format!("Request #{} from {} ({}):\n{}\n", req["id"], s(&req["node"]), s(&req["agent"]), s(&req["text"]));
        let ctx = s(&req["context"]);
        if !ctx.is_empty() && ctx != "null" && ctx != "{}" { t += &format!("Context: {}\n", short(&ctx, 4000)); }
        t += "\nOpen tasks:\n";
        for task in self.db.all("select id, title, status, nodes, project from tasks where status in ('open','working','needs') order by id", &[]) {
            t += &format!("#{} [{}] {} (nodes {}, project {})\n", task["id"], s(&task["status"]), s(&task["title"]), s(&task["nodes"]), s(&task["project"]));
        }
        t += "\nThe owner's rules:\n";
        for r in self.db.all("select id, text, scope from rules where active=1 order by id", &[]) {
            t += &format!("R{} [{}] {}\n", r["id"], s(&r["scope"]), s(&r["text"]));
        }
        t += "\nNodes online: ";
        let online: Vec<String> = self.db.all("select kind, name from nodes where seen > ?", args!(now() - 90_000))
            .iter().map(|n| format!("{} ({})", s(&n["kind"]), s(&n["name"]))).collect();
        t += &if online.is_empty() { "vm only".to_string() } else { format!("vm, {}", online.join(", ")) };
        t
    }

    fn plan_inner(self: &Arc<Self>, req: &Value) -> Result<String, String> {
        let id = req["id"].as_i64().unwrap_or(0);
        let codex = self.codex()?;
        let started = codex.request("thread/start", json!({
            "model": PLANNER_MODEL.0, "ephemeral": true, "approvalPolicy": "never", "sandbox": "read-only",
            "cwd": self.state.to_string_lossy(), "developerInstructions": PLANNER,
        }), 60)?;
        let thread = s(&started["thread"]["id"]);
        let (tx, rx) = mpsc::channel();
        self.watchers.lock().unwrap().insert(thread.clone(), tx);
        let result = (|| {
            codex.request("turn/start", json!({ "threadId": thread, "effort": PLANNER_MODEL.1,
                "input": [{ "type": "text", "text": self.planner_input(req) }], "outputSchema": plan_schema() }), 60)?;
            let mut last = String::new();
            loop {
                let (method, params) = rx.recv_timeout(Duration::from_secs(240)).map_err(|_| "the planner took too long".to_string())?;
                if method == "item/completed" && params["item"]["type"] == "agentMessage" { last = s(&params["item"]["text"]); }
                if method == "turn/completed" {
                    if let Some(e) = params["turn"]["error"].as_object() { return Err(format!("planner error: {}", s(&e["message"].clone()))); }
                    break;
                }
            }
            serde_json::from_str::<Value>(&last).map_err(|e| format!("the planner's answer wasn't JSON ({e})"))
        })();
        self.watchers.lock().unwrap().remove(&thread);
        let plan = result?;
        Ok(self.apply_plan(id, req, &plan))
    }

    pub fn apply_plan(self: &Arc<Self>, id: i64, req: &Value, plan: &Value) -> String {
        for r in plan["rules"].as_array().into_iter().flatten() {
            let rid = self.db.run("insert into rules(text, quote, scope, at) values(?,?,?,?)", args!(s(&r["text"]), s(&r["quote"]), s(&r["scope"]), now()));
            self.log(0, 0, id, "hive", &format!("New rule R{rid}: {}", s(&r["text"])));
        }
        let requester = s(&req["agent"]);
        for t in plan["tasks"].as_array().into_iter().flatten() {
            let level = s(&t["level"]);
            let level = if LEVELS.iter().any(|l| l.0 == level) { level } else { "normal".into() };
            let tid = self.db.run("insert into tasks(request_id, project, title, quote, nodes, level, at, updated) values(?,?,?,?,?,?,?,?)",
                args!(id, s(&t["project"]), s(&t["title"]), s(&t["quote"]), t["nodes"].clone(), level, now(), now()));
            if let Some(session) = requester.strip_prefix("claude:") {
                // A Claude Code session's tasks are its own: it works on them itself.
                let agent = self.agent_for_session(session, tid);
                self.db.run("update tasks set agent_id=?, status='working' where id=?", args!(agent, tid));
            }
            self.log(0, tid, id, "hive", &format!("New task #{tid}: {}", s(&t["title"])));
        }
        for m in plan["messages"].as_array().into_iter().flatten() {
            let tid = m["task"].as_i64().unwrap_or(0);
            if let Err(e) = self.message_task(tid, &s(&m["text"]), "owner") {
                self.log(0, tid, id, "hive", &format!("Couldn't pass the message to task #{tid}: {e}"));
            }
        }
        self.bump();
        s(&plan["reply"])
    }

    fn agent_for_session(&self, session: &str, task: i64) -> i64 {
        let name = format!("claude:{session}");
        if let Some(a) = self.db.get("select id from agents where kind='claude' and name=?", args!(name)) {
            let id = a["id"].as_i64().unwrap_or(0);
            self.db.run("update agents set task_id=?, status='working', updated=? where id=?", args!(task, now(), id));
            return id;
        }
        self.db.run("insert into agents(task_id, kind, name, status, at, updated) values(?, 'claude', ?, 'working', ?, ?)", args!(task, name, now(), now()))
    }

    // ---- agents ----

    fn instructions(&self, task: &Value) -> String {
        let nodes = list(&task["nodes"]);
        let req = self.db.get("select * from requests where id=?", args!(task["request_id"].clone())).unwrap_or(json!({}));
        let ctx: Value = serde_json::from_str(&s(&req["context"])).unwrap_or(json!({}));
        let mut t = format!("{AGENT}\n\nYour task: #{} {}\nThe owner's words: \"{}\"\nThe whole request (from {}): {}\n",
            task["id"], s(&task["title"]), s(&task["quote"]), s(&req["node"]), s(&req["text"]));
        if !ctx.as_object().map(|o| o.is_empty()).unwrap_or(true) { t += &format!("Its context: {ctx}\n"); }
        t += "\nThe owner's rules (enforced; follow every one that applies):\n";
        let mut all_nodes = nodes.clone();
        all_nodes.push("vm".into());
        for r in self.db.all("select id, text, scope from rules where active=1 and (code is null or code='') order by id", &[]) {
            let scope = s(&r["scope"]);
            if scope.strip_prefix("node:").is_some_and(|k| !all_nodes.iter().any(|n| n == k)) { continue; }
            t += &if scope.is_empty() { format!("- {}\n", s(&r["text"])) } else { format!("- [{scope}] {}\n", s(&r["text"])) };
        }
        t += "\nWhere you work:\n";
        t += VM_NOTES;
        for n in &nodes {
            match n.as_str() {
                "mac" => t += "\n- The owner's Mac: mac_* tools (screenshot, click, type, keys, shell). One agent at a time drives its keyboard and mouse; the shell runs alongside.",
                "browser" => t += "\n- The owner's own Chrome, signed in to their accounts: browser_* tools. Use browser_js for anything a page script can do. If one way fails, write different code; never give up on the first error. save_page_rule changes how a site looks for good.",
                "phone" => t += "\n- The owner's iPhone: phone_* tools. One agent at a time touches it.",
                "hive" => t += &format!("\n- Hive's own code: the git checkout at {} (Rust server in server/, Mac node and CLI in node/, Chrome extension in extension/, dashboard in server/dashboard.html). Keep it lean. Commit with a clear message, push to origin main, then call reinstall.", self.repo.display()),
                _ => {}
            }
        }
        t
    }

    pub fn start_agent(self: &Arc<Self>, task_id: i64) {
        let Some(task) = self.db.get("select * from tasks where id=?", args!(task_id)) else { return };
        let level = s(&task["level"]);
        let (_, model, effort) = LEVELS.iter().find(|l| l.0 == level).copied().unwrap_or(LEVELS[1]);
        let nodes = list(&task["nodes"]);
        let agent = self.db.run("insert into agents(task_id, kind, name, status, at, updated) values(?, 'codex', ?, 'working', ?, ?)",
            args!(task_id, short(&s(&task["title"]), 60), now(), now()));
        self.db.run("update tasks set agent_id=?, status='working', updated=? where id=?", args!(agent, now(), task_id));
        let cwd = if nodes.iter().any(|n| n == "hive") { self.repo.clone() } else { self.state.join("work").join(task_id.to_string()) };
        std::fs::create_dir_all(&cwd).ok();
        let result = (|| {
            let codex = self.codex()?;
            let r = codex.request("thread/start", json!({
                "model": model, "cwd": cwd.to_string_lossy(), "approvalPolicy": "never", "sandbox": "danger-full-access",
                "developerInstructions": self.instructions(&task), "dynamicTools": tools::for_nodes(&nodes),
            }), 60)?;
            let thread = s(&r["thread"]["id"]);
            if thread.is_empty() { return Err("Codex gave no thread".to_string()); }
            self.db.run("update agents set thread=? where id=?", args!(thread, agent));
            self.loaded.lock().unwrap().insert(thread);
            self.start_turn_with(agent, "Start on your task now.", effort)
        })();
        if let Err(e) = result {
            self.db.run("update tasks set status='needs', why=?, need=?, updated=? where id=?",
                args!(format!("Hive couldn't start an agent: {e}"), "Nothing from you if Codex comes back by itself; send the task a message to retry.", now(), task_id));
            self.db.run("update agents set status='idle' where id=?", args!(agent));
            self.log(agent, task_id, 0, "hive", &format!("Couldn't start the agent: {e}"));
        }
        self.bump();
    }

    fn start_turn(self: &Arc<Self>, agent: i64, text: &str) -> Result<(), String> {
        let level = self.db.get("select t.level from agents a join tasks t on t.id=a.task_id where a.id=?", args!(agent)).map(|r| s(&r["level"])).unwrap_or_default();
        let effort = LEVELS.iter().find(|l| l.0 == level).map(|l| l.2).unwrap_or("low");
        self.start_turn_with(agent, text, effort)
    }

    fn start_turn_with(self: &Arc<Self>, agent: i64, text: &str, effort: &str) -> Result<(), String> {
        let a = self.db.get("select * from agents where id=?", args!(agent)).ok_or("no such agent")?;
        let thread = s(&a["thread"]);
        let codex = self.codex()?;
        if !self.loaded.lock().unwrap().contains(&thread) {
            codex.request("thread/resume", json!({ "threadId": thread }), 60)?;
            self.loaded.lock().unwrap().insert(thread.clone());
        }
        let r = codex.request("turn/start", json!({ "threadId": thread, "effort": effort, "input": [{ "type": "text", "text": text }],
            "outputSchema": end_schema() }), 60)?;
        let turn = s(&r["turn"]["id"]);
        if !turn.is_empty() { self.turns.lock().unwrap().insert(thread, turn); }
        self.db.run("update agents set status='working', updated=? where id=?", args!(now(), agent));
        Ok(())
    }

    /// A message for a task's agent: steered into its turn if it's working, else a new turn.
    pub fn message_task(self: &Arc<Self>, task_id: i64, text: &str, from: &str) -> Result<(), String> {
        let task = self.db.get("select * from tasks where id=?", args!(task_id)).ok_or(format!("there's no task #{task_id}"))?;
        let agent = task["agent_id"].as_i64().ok_or("that task has no agent yet")?;
        self.log(agent, task_id, 0, from, text);
        if matches!(s(&task["status"]).as_str(), "needs" | "done" | "dropped") {
            self.db.run("update tasks set status='working', why=null, need=null, updated=? where id=?", args!(now(), task_id));
        }
        let a = self.db.get("select * from agents where id=?", args!(agent)).ok_or("no such agent")?;
        if s(&a["kind"]) == "claude" {
            self.db.run("insert into inbox(agent_id, text, at) values(?,?,?)", args!(agent, format!("From {from} about task #{task_id}: {text}"), now()));
            self.bump();
            return Ok(());
        }
        let thread = s(&a["thread"]);
        let turn = self.turns.lock().unwrap().get(&thread).cloned();
        let text = format!("Message from {from}: {text}");
        if let Some(turn) = turn {
            let steered = self.codex()?.request("turn/steer", json!({ "threadId": thread, "expectedTurnId": turn,
                "input": [{ "type": "text", "text": text }] }), 30);
            if steered.is_ok() { return Ok(()); }
        }
        self.nudges.lock().unwrap().remove(&agent);
        self.start_turn(agent, &text)
    }

    pub fn drop_task(self: &Arc<Self>, task_id: i64) {
        self.db.run("update tasks set status='dropped', updated=? where id=?", args!(now(), task_id));
        if let Some(a) = self.db.get("select a.* from agents a join tasks t on t.agent_id=a.id where t.id=?", args!(task_id)) {
            let thread = s(&a["thread"]);
            if let Some(turn) = self.turns.lock().unwrap().get(&thread).cloned() {
                if let Ok(c) = self.codex() { c.request("turn/interrupt", json!({ "threadId": thread, "turnId": turn }), 30).ok(); }
            }
            self.db.run("update agents set status='done' where id=?", args!(a["id"].clone()));
        }
        self.bump();
    }

    fn note(self: &Arc<Self>, method: &str, params: Value) {
        let thread = s(&params["threadId"]);
        if let Some(tx) = self.watchers.lock().unwrap().get(&thread) { tx.send((method.to_string(), params)).ok(); return; }
        let Some(a) = self.db.get("select * from agents where thread=?", args!(thread)) else { return };
        let (agent, task) = (a["id"].as_i64().unwrap_or(0), a["task_id"].as_i64().unwrap_or(0));
        match method {
            "turn/started" => { self.turns.lock().unwrap().insert(thread, s(&params["turn"]["id"])); }
            "item/completed" => {
                let item = &params["item"];
                let line = match s(&item["type"]).as_str() {
                    "agentMessage" => {
                        let text = s(&item["text"]);
                        if ended(&text).is_some() { self.last.lock().unwrap().insert(agent, text); None } else { Some(("agent", text)) }
                    }
                    "commandExecution" => Some(("command", format!("$ {}\n{}", s(&item["command"]), short(&s(&item["aggregatedOutput"]), 3000)))),
                    "fileChange" => Some(("files", item["changes"].as_array().map(|c| c.iter().map(|x| s(&x["path"])).collect::<Vec<_>>().join(", ")).unwrap_or_default())),
                    "webSearch" => Some(("search", s(&item["query"]))),
                    _ => None,
                };
                if let Some((who, text)) = line { if !text.is_empty() { self.log(agent, task, 0, who, &text); } }
            }
            "turn/completed" => {
                self.turns.lock().unwrap().remove(&thread);
                self.release_all(agent);
                if let Some(e) = params["turn"]["error"].as_object() { self.log(agent, task, 0, "hive", &format!("Turn failed: {}", s(&e["message"].clone()))); }
                self.after_turn(agent, task, s(&params["turn"]["status"]));
            }
            _ => {}
        }
    }

    /// A turn's end says how the task stands: done (outcome), or needs the owner (exact why and need). Anything else: keep going.
    fn after_turn(self: &Arc<Self>, agent: i64, task: i64, status: String) {
        let t = self.db.get("select status from tasks where id=?", args!(task)).map(|r| s(&r["status"])).unwrap_or_default();
        let end = self.last.lock().unwrap().remove(&agent).and_then(|m| ended(&m));
        if t != "working" || status == "interrupted" {
            self.db.run("update agents set status=?, updated=? where id=?", args!(if t == "done" || t == "dropped" { "done" } else { "idle" }, now(), agent));
            self.bump();
            return;
        }
        match end {
            Some(e) if e["done"] == true => {
                self.db.run("update tasks set status='done', outcome=?, updated=? where id=?", args!(s(&e["outcome"]), now(), task));
                self.db.run("update agents set status='done', updated=? where id=?", args!(now(), agent));
                self.log(agent, task, 0, "done", &s(&e["outcome"]));
                self.nudges.lock().unwrap().remove(&agent);
            }
            Some(e) if !s(&e["why"]).trim().is_empty() && !s(&e["need"]).trim().is_empty() => {
                self.db.run("update tasks set status='needs', why=?, need=?, updated=? where id=?", args!(s(&e["why"]), s(&e["need"]), now(), task));
                self.db.run("update agents set status='idle', updated=? where id=?", args!(now(), agent));
                self.log(agent, task, 0, "needs you", &format!("{} Needs: {}", s(&e["why"]), s(&e["need"])));
                self.nudges.lock().unwrap().remove(&agent);
            }
            _ => {
                let n = { let mut m = self.nudges.lock().unwrap(); let e = m.entry(agent).or_insert(0); *e += 1; *e };
                if n <= 2 {
                    let me = self.clone();
                    std::thread::spawn(move || {
                        me.start_turn(agent, "The task isn't finished and you didn't say exactly why you stopped and what you need from \
                            the owner. Keep going.").ok();
                    });
                } else {
                    let words = self.db.get("select text from log where agent_id=? and who='agent' order by id desc limit 1", args!(agent)).map(|r| s(&r["text"])).unwrap_or_default();
                    self.db.run("update tasks set status='needs', why=?, need=?, updated=? where id=?",
                        args!(format!("The agent stopped three times without finishing or saying why. Its last words: {}", short(&words, 1500)), "Reply to the task with what to do.", now(), task));
                    self.db.run("update agents set status='idle', updated=? where id=?", args!(now(), agent));
                }
            }
        }
        self.bump();
    }

    // ---- locks: one agent at a time on the Mac's input and the phone's screen ----

    fn take_lock(&self, name: &str, agent: i64) -> Result<(), String> {
        let got = self.wait_until(120_000, || {
            let mut l = self.locks.lock().unwrap();
            match l.get(name) {
                Some((holder, last)) if *holder != agent && now() - last < 60_000 => None,
                _ => { l.insert(name.to_string(), (agent, now())); Some(()) }
            }
        });
        got.ok_or_else(|| {
            let holder = self.locks.lock().unwrap().get(name).map(|x| x.0).unwrap_or(0);
            let title = self.db.get("select t.id, t.title from agents a join tasks t on t.id=a.task_id where a.id=?", args!(holder))
                .map(|r| format!("#{} {}", r["id"], s(&r["title"]))).unwrap_or_default();
            format!("The {name} is in use by task {title}; it frees up when that agent's turn ends. Try again, or message that task.")
        })
    }

    fn release_all(&self, agent: i64) {
        self.locks.lock().unwrap().retain(|_, v| v.0 != agent);
        self.bump();
    }

    pub fn locks(&self) -> Value {
        json!(self.locks.lock().unwrap().iter().map(|(k, v)| json!({ "lock": k, "agent": v.0, "since": v.1 })).collect::<Vec<_>>())
    }

    // ---- nodes: tool calls wait in the calls table until the node takes and answers them ----

    pub fn call_node(&self, kind: &str, tool: &str, args: &Value, agent: i64, secs: u64) -> Result<Value, String> {
        let node = self.db.get("select id from nodes where kind=? and seen > ? order by seen desc limit 1", args!(kind, now() - 90_000))
            .map(|r| s(&r["id"]))
            .ok_or_else(|| format!("The owner's {kind} isn't connected to Hive right now, so this tool can't run. Do the task another way, \
                or end saying the {kind} needs to be online (for the Mac: Hive running; for Chrome: the Hive extension)."))?;
        let id = self.db.run("insert into calls(node, tool, args, agent_id, at) values(?,?,?,?,?)", args!(node, tool, args.clone(), agent, now()));
        self.bump();
        let done = self.wait_until(secs * 1000, || {
            self.db.get("select result from calls where id=? and status='done'", args!(id)).map(|r| s(&r["result"]))
        });
        match done {
            Some(r) => Ok(serde_json::from_str(&r).unwrap_or(json!({ "text": r }))),
            None => {
                self.db.run("update calls set status='timeout' where id=?", args!(id));
                Err(format!("The {kind} didn't answer {tool} within {secs}s."))
            }
        }
    }

    // ---- tool calls from agents ----

    fn tool(self: &Arc<Self>, params: &Value) -> Value {
        let name = s(&params["tool"]);
        let a = &params["arguments"];
        let agent_row = self.db.get("select * from agents where thread=?", args!(s(&params["threadId"]))).unwrap_or(json!({}));
        let (agent, task) = (agent_row["id"].as_i64().unwrap_or(0), agent_row["task_id"].as_i64().unwrap_or(0));
        self.log(agent, task, 0, "tool", &format!("{name} {}", short(&a.to_string(), 300)));
        let r = self.tool_inner(&name, a, agent, task);
        match r {
            Ok(v) => {
                let images: Vec<String> = v["images"].as_array().map(|i| i.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default();
                let text = if v["text"].is_string() { s(&v["text"]) } else if v.is_string() { s(&v) } else { v.to_string() };
                tool_result(v["error"].is_null(), if v["error"].is_null() { &text } else { v["error"].as_str().unwrap_or("failed") }, &images)
            }
            Err(e) => { self.log(agent, task, 0, "tool", &format!("{name} failed: {e}")); tool_result(false, &e, &[]) }
        }
    }

    fn tool_inner(self: &Arc<Self>, name: &str, a: &Value, agent: i64, task: i64) -> Result<Value, String> {
        if let Some(lock) = tools::lock_for(name) { self.take_lock(lock, agent)?; }
        match name {
            "message_agent" => {
                let to = a["task"].as_i64().ok_or("give the task id")?;
                self.message_task(to, &s(&a["text"]), &format!("task #{task}'s agent"))?;
                Ok(json!(format!("Sent to task #{to}'s agent.")))
            }
            "list_tasks" => {
                let rows = self.db.all("select id, title, status, nodes, project from tasks where status in ('open','working','needs') order by id", &[]);
                Ok(json!(rows.iter().map(|t| format!("#{} [{}] {} (nodes {})", t["id"], s(&t["status"]), s(&t["title"]), s(&t["nodes"]))).collect::<Vec<_>>().join("\n")))
            }
            "info" => {
                let (key, value) = (s(&a["key"]), s(&a["value"]));
                if !key.is_empty() && !value.is_empty() {
                    self.db.run("insert into info(key, value, updated) values(?,?,?) on conflict(key) do update set value=excluded.value, updated=excluded.updated", args!(key, value, now()));
                    return Ok(json!("Saved."));
                }
                let rows = if key.is_empty() { self.db.all("select key, value from info order by key", &[]) } else { self.db.all("select key, value from info where key=?", args!(key)) };
                Ok(json!(rows.iter().map(|r| format!("{}: {}", s(&r["key"]), s(&r["value"]))).collect::<Vec<_>>().join("\n")))
            }
            "save_page_rule" => {
                let site = s(&a["site"]).trim_start_matches("https://").trim_start_matches("http://").split('/').next().unwrap_or("").to_string();
                if site.is_empty() { return Err("give the site's host".into()); }
                let code = json!({ "css": s(&a["css"]), "js": s(&a["js"]) }).to_string();
                self.db.run("update rules set active=0 where scope=? and text=? and code is not null", args!(format!("site:{site}"), s(&a["text"])));
                let id = self.db.run("insert into rules(text, quote, scope, code, at) values(?,?,?,?,?)", args!(s(&a["text"]), "", format!("site:{site}"), code, now()));
                Ok(json!(format!("Saved as rule R{id}; the extension applies it on {site} from the next page load.")))
            }
            "vm_type_password" => crate::vm::type_password(&s(&a["site"]), &s(&a["username"])).map(|m| json!(m)),
            "reinstall" => crate::vm::reinstall(&self.repo),
            "mac_get_file" => {
                let r = self.call_node("mac", name, a, agent, 600)?;
                let data = crate::b64::decode(&s(&r["data"])).ok_or("the Mac sent no file")?;
                let fname = std::path::Path::new(&s(&a["path"])).file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or("file".into());
                let path = self.save_file(&fname, &data, "mac");
                Ok(json!(format!("Saved on the VM at {}", path.display())))
            }
            "mac_put_file" => {
                let data = std::fs::read(s(&a["vm_path"])).map_err(|e| format!("couldn't read {}: {e}", s(&a["vm_path"])))?;
                self.call_node("mac", name, &json!({ "path": s(&a["path"]), "data": crate::b64::encode(&data) }), agent, 600)
            }
            n if n.starts_with("mac_") => {
                let secs = if n == "mac_shell" { a["timeout"].as_u64().unwrap_or(120).clamp(5, 1800) + 15 } else { 90 };
                self.call_node("mac", n, a, agent, secs)
            }
            n if n.starts_with("browser_") => self.call_node("browser", n, a, agent, 120),
            n if n.starts_with("phone_") => self.phone.call(n, a),
            _ => Err(format!("Hive has no tool called {name}")),
        }
    }

    pub fn save_file(&self, name: &str, data: &[u8], node: &str) -> PathBuf {
        let clean: String = name.chars().map(|c| if c.is_alphanumeric() || ".-_ ".contains(c) { c } else { '_' }).collect();
        let id = self.db.run("insert into files(name, size, node, at) values(?,?,?,?)", args!(clean, data.len(), node, now()));
        let dir = self.state.join("files");
        std::fs::create_dir_all(&dir).ok();
        let path = dir.join(format!("{id}-{clean}"));
        std::fs::write(&path, data).ok();
        self.bump();
        path
    }
}

/// The final message of every agent turn.
fn end_schema() -> Value {
    let st = json!({ "type": "string" });
    json!({ "type": "object", "additionalProperties": false, "required": ["done", "outcome", "why", "need"],
        "properties": { "done": { "type": "boolean" }, "outcome": st, "why": st, "need": st } })
}

fn ended(text: &str) -> Option<Value> {
    serde_json::from_str::<Value>(text).ok().filter(|v| v["done"].is_boolean())
}

fn plan_schema() -> Value {
    let st = json!({ "type": "string" });
    json!({
        "type": "object", "additionalProperties": false, "required": ["reply", "rules", "tasks", "messages"],
        "properties": {
            "reply": st,
            "rules": { "type": "array", "items": { "type": "object", "additionalProperties": false, "required": ["text", "quote", "scope"],
                "properties": { "text": st, "quote": st, "scope": st } } },
            "tasks": { "type": "array", "items": { "type": "object", "additionalProperties": false,
                "required": ["title", "quote", "nodes", "level", "project"],
                "properties": { "title": st, "quote": st, "project": st,
                    "nodes": { "type": "array", "items": { "type": "string", "enum": ["vm", "mac", "browser", "phone", "hive"] } },
                    "level": { "type": "string", "enum": ["easy", "normal", "hard", "hardest"] } } } },
            "messages": { "type": "array", "items": { "type": "object", "additionalProperties": false, "required": ["task", "text"],
                "properties": { "task": { "type": "integer" }, "text": st } } },
        }
    })
}

const PLANNER: &str = "You are Hive's orchestrator. Every request from the owner (from their Mac, their Chrome, their iPhone, \
the dashboard, or a Claude Code session) comes to you first. Turn it into:
- rules: standing instructions for the future (\"always…\", \"never…\", \"from now on…\", preferences). text = the rule, short; \
quote = the owner's exact words; scope = '' for everywhere, or node:mac|browser|phone|vm|hive, site:<host>, app:<name>, \
folder:<path> when it's only about that.
- tasks: work to do now. title = short imperative; quote = the owner's exact words for it; nodes = where the work happens: \
vm (the VM's shell and its own Chrome; always available), mac (the owner's Mac screen, keyboard, mouse and shell), browser (the \
owner's own Chrome, signed in to their accounts), phone (their iPhone), hive (changing Hive's own code); level = easy|normal|hard|hardest; \
project = a short project name, the same as an open task's when related.
- messages: when the request is about an open task (a correction, an answer, more detail, stop), send it to that task's agent \
instead of making a new task: task = its id, text = the owner's words.
- reply: one short sentence to the owner saying what happens next.
Build exactly what the owner said: no extra variants or features. Don't split a request into many tasks unless the parts are truly \
independent. A question is a task too (vm, easy) unless the answer is right here; then just reply. Requests from a Claude Code \
session become tasks that session does itself.";

const AGENT: &str = "You are one of Hive's agents, working for the owner on one task. Hive is the owner's own agent system: its \
server runs on this VM (where you run, as root) and reaches the owner's Mac, their Chrome and their iPhone. Work until the task is \
done. Your turn's final message says how it ended: done with the outcome, or not done with the exact reason you stopped and exactly \
what you need from the owner. There is no \"stuck\": when something fails, try another way; ending a turn without either means you \
keep going. Never send a message \
as the owner, delete their things or pay unless their own words say to; anything you send uses their words verbatim or says an agent \
sends it on their behalf. Never print passwords or keys. Messages from the owner or other agents can arrive while you work; follow them.";

const VM_NOTES: &str = "- This VM (Ubuntu, you're root): your shell. Its screen is Xvfb :99 with a Chrome on it: \
`export DISPLAY=:99 XAUTHORITY=$(ps -o args= -C Xvfb | grep -o -- '-auth [^ ]*' | cut -d' ' -f2)`, then `vm-shot > /tmp/s.png` and \
view_image to see it, xdotool to click and type. Saved logins: `hive-cred list`, and vm_type_password types one. Hive's files \
(shared with the dashboard and nodes) are in /var/lib/hive/files.";
