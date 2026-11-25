//! Hive's brain: every request is planned into tasks and rules, each task gets an agent (a Codex thread, or a Claude Code
//! process: the engine is chosen per Hive), agents' tool calls reach the devices that declared those tools, and tools that
//! share a lock are used by one agent at a time.
use crate::args;
use crate::claude::{Claude, Out};
use crate::codex::{tool_result, Codex, Event};
use crate::db::{now, Db};
use crate::tools;
use hive_protocol::b64;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{mpsc, Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

pub struct Hive {
    pub db: Db,
    pub state: PathBuf,
    /// On the VM, Hive's checkout, which Hive changes itself from; None on a home computer.
    pub repo: Option<PathBuf>,
    pub engine: Engine,
    pub version: String,
    /// Where this Hive's API answers on this computer.
    pub local: String,
    codex: Mutex<Option<Arc<Codex>>>,
    events: Mutex<Option<mpsc::Sender<Event>>>,
    loaded: Mutex<HashSet<String>>,
    turns: Mutex<HashMap<String, String>>,
    watchers: Mutex<HashMap<String, mpsc::Sender<(String, Value)>>>,
    nudges: Mutex<HashMap<i64, u32>>,
    /// Agents sent back once to check that what they'd stop for is truly the owner's.
    rechecked: Mutex<HashSet<i64>>,
    last: Mutex<HashMap<i64, String>>,
    locks: Mutex<HashMap<String, (i64, i64)>>,
    assignments: Mutex<()>,
    changed: (Mutex<u64>, Condvar),
    /// Claude Code agents' processes while they work, by agent.
    claudes: Mutex<HashMap<i64, Arc<Claude>>>,
    /// Each running Claude agent's MCP secret, so only its own process calls tools as it.
    mcp: Mutex<HashMap<String, i64>>,
}

/// What Hive's agents and planner run on, with its program and environment (where it's signed in).
pub enum Engine {
    Codex { cmd: String, env: Vec<(String, String)> },
    Claude { cmd: String, env: Vec<(String, String)> },
}

pub const LEVELS: [(&str, &str, &str); 4] = [
    ("easy", "gpt-6-luna", "low"), ("normal", "gpt-6.1-terra", "low"),
    ("hard", "gpt-6.1-sol", "medium"), ("hardest", "gpt-6-astra", "high"),
];
const PLANNER_MODEL: (&str, &str) = ("gpt-6.1-terra", "low");
pub const CLAUDE_LEVELS: [(&str, &str, &str); 4] = [
    ("easy", "claude-haiku-5-5", "low"), ("normal", "claude-sonnet-5-5", "medium"),
    ("hard", "claude-opus-5-5", "high"), ("hardest", "claude-opus-5-5", "xhigh"),
];
const CLAUDE_PLANNER: (&str, &str) = ("claude-sonnet-5-5", "low");
/// Hive's own Claude Code agents; 'claude' is the owner's own sessions outside Hive (Claude Code, Codex, any agent with `hive mcp`),
/// named after their request's `agent`.
const CLAUDE_AGENT: &str = "claude-agent";

fn s(v: &Value) -> String { v.as_str().map(String::from).unwrap_or_else(|| if v.is_null() { String::new() } else { v.to_string() }) }
fn short(t: &str, n: usize) -> String { if t.chars().count() <= n { t.into() } else { t.chars().take(n).collect::<String>() + "…" } }
/// A tool list's names, which tell whether an agent's thread has today's tools.
fn names(tools: &[Value]) -> String {
    let mut n: Vec<String> = tools.iter().map(|t| s(&t["name"])).collect();
    n.sort();
    n.join(",")
}

fn list_values(v: &Value) -> Vec<Value> {
    let parsed: Value = match v { Value::String(t) => serde_json::from_str(t).unwrap_or(Value::Null), o => o.clone() };
    parsed.as_array().cloned().unwrap_or_default()
}
pub fn list(v: &Value) -> Vec<String> {
    let parsed: Value = match v { Value::String(t) => serde_json::from_str(t).unwrap_or(Value::Null), o => o.clone() };
    parsed.as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default()
}

impl Hive {
    pub fn new(db: Db, state: PathBuf, repo: Option<PathBuf>, engine: Engine, version: String, local: String) -> Arc<Hive> {
        Arc::new(Hive {
            db, state, repo, engine, version, local,
            assignments: Mutex::new(()),
            codex: Mutex::new(None), events: Mutex::new(None), loaded: Mutex::new(HashSet::new()),
            turns: Mutex::new(HashMap::new()), watchers: Mutex::new(HashMap::new()), nudges: Mutex::new(HashMap::new()), rechecked: Mutex::new(HashSet::new()), last: Mutex::new(HashMap::new()),
            locks: Mutex::new(HashMap::new()), changed: (Mutex::new(0), Condvar::new()),
            claudes: Mutex::new(HashMap::new()), mcp: Mutex::new(HashMap::new()),
        })
    }

    /// Runs the iPhone's node here once the owner has connected one (phone/).
    pub fn start_phone(&self) {
        static ONCE: std::sync::Once = std::sync::Once::new();
        ONCE.call_once(|| {
            // Its token is made here, a new one each start: the node runs in this process.
            let token = crate::api::random(24);
            self.db.run("delete from tokens where node='phone:iPhone'", &[]);
            self.db.run("insert into tokens(hash, node, at) values(?,?,?)", args!(crate::api::hash(&token), "phone:iPhone", now()));
            hive_phone::start(self.state.clone(), hive_protocol::Conf { server: self.local.clone(), token, id: "phone-iphone".into() })
        });
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
            args!(now(), agent, task, request, who, if who == "tool-item" { text.to_string() } else { short(text, 20000) }));
        self.bump();
    }

    // ---- Codex ----

    fn codex(self: &Arc<Self>) -> Result<Arc<Codex>, String> {
        let mut slot = self.codex.lock().unwrap();
        if let Some(c) = slot.as_ref() { if c.alive.load(std::sync::atomic::Ordering::SeqCst) { return Ok(c.clone()); } }
        let Engine::Codex { cmd, env } = &self.engine else { return Err("this Hive runs on Claude Code, not Codex".into()) };
        let tx = self.events.lock().unwrap().clone().ok_or("Hive isn't running yet")?;
        let c = Codex::spawn(cmd, env, tx)?;
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
        // Claimed tasks wait while their agent works on its current task.
        for a in self.db.all("select id from agents where kind!='claude' and status in ('idle','done') and exists (select 1 from tasks where id=agents.task_id and status='done') and exists (select 1 from tasks where agent_id=agents.id and status='queued')", &[]) {
            let agent = a["id"].as_i64().unwrap_or(0);
            if let Some(t) = self.db.get("select id from tasks where agent_id=? and status='queued' order by id limit 1", args!(agent)) {
                self.start_agent(t["id"].as_i64().unwrap_or(0));
            }
        }
        // A repeating task that's done runs again once its hours have passed since it ended.
        for t in self.db.all("select id, every from tasks where every>0 and status='done' and updated<=?-every*3600000", args!(now())) {
            let (id, every) = (t["id"].as_i64().unwrap_or(0), t["every"].as_i64().unwrap_or(0));
            let text = format!("Time for this task's next run (it repeats every {every} hours): do it again, using what you saved last time.");
            if let Err(e) = self.message_task(id, 0, &text, "hive") {
                eprintln!("couldn't repeat task {id}: {e}");
                self.db.run("update tasks set updated=? where id=?", args!(now(), id));
            }
        }
    }

    fn resume_working(self: &Arc<Self>) {
        // Only this engine's agents: the other's threads don't carry over.
        let kind = if matches!(self.engine, Engine::Claude { .. }) { CLAUDE_AGENT } else { "codex" };
        for a in self.db.all("select id from agents where kind=? and status='working' and thread is not null", args!(kind)) {
            let id = a["id"].as_i64().unwrap_or(0);
            if let Err(e) = self.start_turn(id, "Hive restarted while you were working. Carry on with your task.") {
                eprintln!("couldn't resume agent {id}: {e}");
            }
        }
    }

    // ---- planning: a request becomes rules, tasks and messages to agents ----

    pub fn plan(self: &Arc<Self>, id: i64) {
        let Some(req) = self.db.get("select * from requests where id=?", args!(id)) else { return };
        self.log(0, 0, id, "orchestrator input", &self.planner_input(&req));
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

    /// Retrieve original evidence, never inferred preferences. Bounds keep old conversations out of the harness.
    fn history(&self, query: &str, project: &str, before: i64, limit: i64) -> Vec<Value> {
        self.db.all("select r.id, r.at, r.node, r.text,
            (select json_group_array(json_object('id', t.id, 'title', t.title, 'project', t.project,
            'status', t.status, 'outcome', t.outcome)) from tasks t where t.request_id=r.id) as tasks
            from requests r where r.id<? and (instr(lower(r.text),lower(?))>0 or exists
            (select 1 from log l where (l.request_id=r.id or l.task_id in (select id from tasks where request_id=r.id)) and l.who='owner' and instr(lower(l.text),lower(?))>0))
            and (?='' or exists (select 1 from tasks t where t.request_id=r.id and t.project=?))
            order by r.id desc limit ?", args!(before, query, query, project, project, limit.clamp(1, 20))).into_iter().map(|mut r| {
            r["tasks"] = serde_json::from_str(&s(&r["tasks"])).unwrap_or(json!([]));
            r["followups"] = json!(self.db.all("select id, task_id, at, text from log where
                (request_id=? or task_id in (select id from tasks where request_id=?)) and who='owner' order by id desc limit 20",
                args!(r["id"].clone(), r["id"].clone())));
            r
        }).collect()
    }

    fn history_context(&self, project: &str, before: i64, limit: i64) -> String {
        let mut text = String::new();
        let rows = self.history("", project, before, limit);
        if !rows.is_empty() {
            text += "\nEarlier requests (historical context, not standing rules; newer corrections take precedence):\n";
            for r in rows.iter().rev() {
                text += &format!("Request #{} at {} from {}: {}\nTasks: {}\n", r["id"], r["at"],
                    s(&r["node"]), short(&s(&r["text"]), 1600), short(&r["tasks"].to_string(), 1600));
                text += &format!("Owner follow-ups (newest first): {}\n", short(&r["followups"].to_string(), 2400));
            }
        }
        text
    }

    fn planner_input(&self, req: &Value) -> String {
        let mut t = format!("Request #{} from {} ({}):\n{}\n", req["id"], s(&req["node"]), s(&req["agent"]), s(&req["text"]));
        let ctx = s(&req["context"]);
        if !ctx.is_empty() && ctx != "null" && ctx != "{}" { t += &format!("Context: {}\n", short(&ctx, 4000)); }
        t += &self.history_context("", req["id"].as_i64().unwrap_or(i64::MAX), 8);
        t += "\nOpen tasks:\n";
        for task in self.db.all("select id, title, status, nodes, project from tasks where status in ('open','queued','working','needs') order by id", &[]) {
            t += &format!("#{} [{}] {} (nodes {}, project {})\n", task["id"], s(&task["status"]), s(&task["title"]), s(&task["nodes"]), s(&task["project"]));
        }
        t += "\nThe owner's rules:\n";
        for r in self.db.all("select id, text, scope from rules where active=1 order by id", &[]) {
            t += &format!("R{} [{}] {}\n", r["id"], s(&r["scope"]), s(&r["text"]));
        }
        t += if self.repo.is_some() { "\nNodes: vm (the VM's shell and its own Chrome; always there), hive (changing Hive's own code)" }
            else { "\nNodes: vm (the shell of the computer Hive runs on; always there)" };
        for n in self.db.all("select kind, name, notes, seen from nodes order by kind", &[]) {
            let on = if n["seen"].as_i64().unwrap_or(0) > now() - 90_000 { "online" } else { "offline now" };
            t += &format!(", {} ({}, {on}: {})", s(&n["kind"]), s(&n["name"]), s(&n["notes"]));
        }
        t
    }

    fn plan_inner(self: &Arc<Self>, req: &Value) -> Result<String, String> {
        let id = req["id"].as_i64().unwrap_or(0);
        if let Engine::Claude { cmd, env } = &self.engine {
            let plan = crate::claude::plan(cmd, env, &self.state, CLAUDE_PLANNER, PLANNER, &plan_schema(&self.kinds()), &self.planner_input(req))?;
            return Ok(self.apply_plan(id, req, &plan));
        }
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
                "input": [{ "type": "text", "text": self.planner_input(req) }], "outputSchema": plan_schema(&self.kinds()) }), 60)?;
            let mut last = String::new();
            loop {
                let (method, params) = rx.recv_timeout(Duration::from_secs(240)).map_err(|_| "the planner took too long".to_string())?;
                if method == "thread/tokenUsage/updated" { self.save_usage(&thread, 0, &params["tokenUsage"]["total"]); }
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
        // A session outside Hive (a request with an `agent`) writes its own tasks with `hive mcp`: it has the context the
        // orchestrator lacks.
        if s(&req["agent"]).is_empty() {
            for t in plan["tasks"].as_array().into_iter().flatten() { self.add_task(id, t); }
        }
        for m in plan["messages"].as_array().into_iter().flatten() {
            let tid = m["task"].as_i64().unwrap_or(0);
            if let Err(e) = self.message_task(tid, id, &s(&m["text"]), "owner") {
                self.log(0, tid, id, "hive", &format!("Couldn't pass the message to task #{tid}: {e}"));
            }
        }
        self.bump();
        s(&plan["reply"])
    }

    /// A task for a request, written by the orchestrator or by the agent that took the request. A session outside Hive
    /// works on its own tasks itself; any other task gets a new agent.
    pub fn add_task(self: &Arc<Self>, request: i64, t: &Value) -> i64 {
        let level = s(&t["level"]);
        let level = if LEVELS.iter().any(|l| l.0 == level) { level } else { "normal".into() };
        let nodes = if t["nodes"].is_array() { t["nodes"].clone() } else { json!(["vm"]) };
        let every = t["every"].as_i64().unwrap_or(0).max(0);
        let tid = self.db.run("insert into tasks(request_id, project, title, quote, nodes, level, every, at, updated) values(?,?,?,?,?,?,?,?,?)",
            args!(request, s(&t["project"]), s(&t["title"]), s(&t["quote"]), nodes, level, every, now(), now()));
        let requester = self.db.get("select agent from requests where id=?", args!(request)).map(|r| s(&r["agent"])).unwrap_or_default();
        if !requester.is_empty() {
            let agent = self.agent_for_session(&requester, tid);
            self.db.run("update tasks set agent_id=?, status='working' where id=?", args!(agent, tid));
        }
        self.log(0, tid, request, "hive", &format!("New task #{tid}: {}", s(&t["title"])));
        self.bump();
        tid
    }

    /// A standing instruction, saved by the agent that heard it (it knows how far the owner meant it to reach).
    pub fn add_rule(&self, text: &str, quote: &str, scope: &str) -> Result<i64, String> {
        if text.trim().is_empty() || quote.trim().is_empty() { return Err("give the rule and the owner's exact words".into()); }
        if !(scope.is_empty() || ["node:", "site:", "app:", "folder:"].iter().any(|p| scope.starts_with(p))) {
            return Err("scope is node:<kind>, site:<host>, app:<name>, folder:<path>, or empty for everywhere".into());
        }
        let rid = self.db.run("insert into rules(text, quote, scope, at) values(?,?,?,?)", args!(text, quote, scope, now()));
        self.log(0, 0, 0, "hive", &format!("New rule R{rid}: {text}"));
        self.bump();
        Ok(rid)
    }

    fn agent_for_session(&self, name: &str, task: i64) -> i64 {
        if let Some(a) = self.db.get("select id from agents where kind='claude' and name=?", args!(name)) {
            let id = a["id"].as_i64().unwrap_or(0);
            self.db.run("update agents set task_id=?, status='working', updated=? where id=?", args!(task, now(), id));
            return id;
        }
        self.db.run("insert into agents(task_id, kind, name, status, at, updated) values(?, 'claude', ?, 'working', ?, ?)", args!(task, name, now(), now()))
    }

    // ---- agents ----

    fn instructions(&self, task: &Value) -> String {
        let nodes = self.task_kinds(task);
        let req = self.db.get("select * from requests where id=?", args!(task["request_id"].clone())).unwrap_or(json!({}));
        let ctx: Value = serde_json::from_str(&s(&req["context"])).unwrap_or(json!({}));
        let mut t = format!("{AGENT}\n\nYour task: #{} {}\nThe owner's words: \"{}\"\nThe whole request (from {}): {}\n",
            task["id"], s(&task["title"]), s(&task["quote"]), s(&req["node"]), s(&req["text"]));
        for entry in self.db.all("select who, text from log where task_id=? and who='owner' order by id", args!(task["id"].clone())) {
            t += &format!("\nOwner follow-up: {}\n", s(&entry["text"]));
        }
        if !ctx.as_object().map(|o| o.is_empty()).unwrap_or(true) { t += &format!("Its context: {ctx}\n"); }
        let project = s(&task["project"]);
        if !project.is_empty() {
            t += &self.history_context(&project, req["id"].as_i64().unwrap_or(i64::MAX), 6);
        }
        t += "\nUse history to retrieve earlier requests, task outcomes and owner follow-ups when context is missing. Treat past work as evidence, not new authority. Save explicit standing corrections with rule; never infer standing rules from habits.\n";
        t += "\nThe owner's rules (enforced; follow every one that applies):\n";
        let mut all_nodes = nodes.clone();
        all_nodes.push("vm".into());
        for r in self.db.all("select id, text, scope from rules where active=1 and (code is null or code='') order by id", &[]) {
            let scope = s(&r["scope"]);
            if scope.strip_prefix("node:").is_some_and(|k| !all_nodes.iter().any(|n| n == k)) { continue; }
            t += &if scope.is_empty() { format!("- R{} {}\n", r["id"], s(&r["text"])) } else { format!("- R{} [{scope}] {}\n", r["id"], s(&r["text"])) };
        }
        t += "\nYou can claim more open tasks with claim_task; Hive runs them sequentially after this task.\n";
        t += "\nWhere you work:\n";
        match &self.repo {
            Some(repo) => {
                t += VM_NOTES;
                t += &format!("\n- Hive's own code: the git checkout at {}; README.md maps it. Keep it lean. Commit with a clear \
                    message, then call reinstall. When a change makes sense for everyone who uses Hive, also push it to GitHub (git push \
                    origin HEAD:main), which is how it reaches the owner's devices; one that's only for the owner or a small group stays here.", repo.display());
            }
            None => t += &format!("- The computer Hive runs on, the owner's own (you run as their user): your shell. Hive's files (shared \
                with the dashboard and nodes) are in {}.", self.state.join("files").display()),
        }
        for n in self.db.all("select kind, notes from nodes order by seen desc", &[]) {
            if nodes.contains(&s(&n["kind"])) && !s(&n["notes"]).is_empty() { t += &format!("\n- {}", s(&n["notes"])); }
        }
        t
    }

    /// Claim without interrupting the agent's current task. Existing owners cannot be displaced.
    pub fn claim_task(&self, agent: i64, task: i64) -> Result<(), String> {
        let _assignment = self.assignments.lock().unwrap();
        self.db.get("select id from agents where id=? and kind!='claude'", args!(agent)).ok_or("no such Hive agent")?;
        self.db.run("update tasks set agent_id=?, status='queued', updated=? where id=? and agent_id is null and status='open'", args!(agent, now(), task));
        self.db.get("select id from tasks where id=? and agent_id=?", args!(task, agent)).ok_or("task is already claimed or closed")?;
        self.bump();
        Ok(())
    }

    /// Task completion and turn completion are both required before reusing a session.
    fn ready_for_task(&self, agent: i64) -> bool {
        let Some(a) = self.db.get("select a.thread from agents a join tasks t on t.id=a.task_id where a.id=? and a.status in ('idle','done') and t.status='done'", args!(agent)) else { return false };
        !self.turns.lock().unwrap().contains_key(&s(&a["thread"]))
            && !self.claudes.lock().unwrap().get(&agent).is_some_and(|c| c.busy.load(std::sync::atomic::Ordering::SeqCst))
    }

    pub fn start_agent(self: &Arc<Self>, task_id: i64) {
        let _assignment = self.assignments.lock().unwrap();
        let Some(task) = self.db.get("select * from tasks where id=?", args!(task_id)) else { return };
        if !matches!(s(&task["status"]).as_str(), "open" | "working" | "queued") { return; }
        let level = s(&task["level"]);
        let effort = LEVELS.iter().find(|l| l.0 == level).copied().unwrap_or(LEVELS[1]).2;
        let on_claude = matches!(self.engine, Engine::Claude { .. });
        let kind = if on_claude { CLAUDE_AGENT } else { "codex" };
        let owner = task["agent_id"].as_i64().or_else(|| {
            let project = s(&task["project"]);
            if project.is_empty() { return None; }
            self.db.get("select a.id from agents a join tasks t on t.agent_id=a.id where a.kind=? and t.project=? order by a.id desc limit 1", args!(kind, project)).and_then(|a| a["id"].as_i64())
        });
        let agent = if let Some(agent) = owner {
            self.db.run("update tasks set agent_id=?, status='queued' where id=?", args!(agent, task_id));
            if !self.ready_for_task(agent) { self.bump(); return; }
            if let Some(c) = self.claudes.lock().unwrap().remove(&agent) { c.close(); }
            self.db.run("update agents set task_id=?, thread=null, tools='', status='working', updated=? where id=?", args!(task_id, now(), agent));
            agent
        } else {
            self.db.run("insert into agents(task_id, kind, name, status, at, updated) values(?, ?, ?, 'working', ?, ?)",
                args!(task_id, kind, short(&s(&task["title"]), 60), now(), now()))
        };
        self.db.run("update tasks set agent_id=?, status='working', updated=? where id=?", args!(agent, now(), task_id));
        let result = if on_claude { self.claude_turn(agent, "Start on your task now.") }
            else { self.new_thread(agent, &task).and_then(|_| self.start_turn_with(agent, "Start on your task now.", effort)) };
        if let Err(e) = result {
            self.db.run("update tasks set status='needs', why=?, need=?, updated=? where id=?",
                args!(format!("Hive couldn't start an agent: {e}"), format!("Nothing from you if {} comes back by itself; send the task a message to retry.",
                    if on_claude { "Claude Code" } else { "Codex" }), now(), task_id));
            self.db.run("update agents set status='idle' where id=?", args!(agent));
            self.log(agent, task_id, 0, "hive", &format!("Couldn't start the agent: {e}"));
        }
        self.bump();
    }

    /// Where a task's agent works: Hive's checkout for a "hive" task, else a folder of its own.
    fn cwd(&self, task: &Value) -> PathBuf {
        let cwd = match &self.repo {
            Some(r) if list(&task["nodes"]).iter().any(|n| n == "hive") => r.clone(),
            _ => self.state.join("work").join(s(&task["id"])),
        };
        std::fs::create_dir_all(&cwd).ok();
        cwd
    }

    /// Read the provider's transcript rather than reconstructing it from dashboard activity.
    pub fn session_context(self: &Arc<Self>, task_id: i64) -> Result<Value, String> {
        let a = self.db.get("select a.* from agents a join tasks t on t.agent_id=a.id where t.id=? and a.task_id=t.id", args!(task_id)).ok_or("This task's live session has ended; its recorded inputs remain in the chat.")?;
        if s(&a["kind"]) != "codex" { return Err("Provider transcript inspection is available for Codex sessions only.".into()); }
        let thread = s(&a["thread"]);
        if thread.is_empty() { return Err("The session has not started.".into()); }
        let transcript = self.codex()?.request("thread/read", json!({"threadId":thread,"includeTurns":true}), 30)?;
        Ok(json!({"thread":thread,"providerTranscript":transcript,
            "hiveConfiguration":self.db.get("select text from log where task_id=? and who='session configuration' order by id desc limit 1",args!(task_id)),
            "hiveInstructions":self.db.get("select text from log where task_id=? and who='session input' order by id desc limit 1",args!(task_id)),
            "note":"Provider transcript and Hive instructions. The provider may compact older turns; hidden provider instructions and private reasoning are not exposed by its API."}))
    }

    fn start_turn(self: &Arc<Self>, agent: i64, text: &str) -> Result<(), String> {
        if self.db.get("select 1 from agents where id=? and kind=?", args!(agent, CLAUDE_AGENT)).is_some() { return self.claude_turn(agent, text); }
        let level = self.db.get("select t.level from agents a join tasks t on t.id=a.task_id where a.id=?", args!(agent)).map(|r| s(&r["level"])).unwrap_or_default();
        let effort = LEVELS.iter().find(|l| l.0 == level).map(|l| l.2).unwrap_or("low");
        self.start_turn_with(agent, text, effort)
    }

    /// A Codex thread for an agent, with the task's instructions and its devices' tools as they are now.
    fn new_thread(self: &Arc<Self>, agent: i64, task: &Value) -> Result<String, String> {
        let model = LEVELS.iter().find(|l| l.0 == s(&task["level"])).copied().unwrap_or(LEVELS[1]).1;
        let tools = self.tools_for(&self.task_kinds(task));
        let instructions = self.instructions(task);
        let r = self.codex()?.request("thread/start", json!({
            "model": model, "cwd": self.cwd(task).to_string_lossy(), "approvalPolicy": "never", "sandbox": "danger-full-access",
            "developerInstructions": instructions, "dynamicTools": tools.iter().map(tools::for_codex).collect::<Vec<_>>(),
        }), 60)?;
        let thread = s(&r["thread"]["id"]);
        if thread.is_empty() { return Err("Codex gave no thread".to_string()); }
        self.db.run("update agents set thread=?, tools=? where id=?", args!(thread, names(&tools), agent));
        self.loaded.lock().unwrap().insert(thread.clone());
        self.log(agent, task["id"].as_i64().unwrap_or(0), 0, "session input", &instructions);
        self.log(agent, task["id"].as_i64().unwrap_or(0), 0, "session configuration", &json!({"threadId":thread,"model":model,"tools":tools,"cwd":self.cwd(task),"approvalPolicy":"never","sandbox":"danger-full-access"}).to_string());
        Ok(thread)
    }

    fn start_turn_with(self: &Arc<Self>, agent: i64, text: &str, effort: &str) -> Result<(), String> {
        let a = self.db.get("select * from agents where id=?", args!(agent)).ok_or("no such agent")?;
        let task = self.db.get("select * from tasks where id=?", args!(a["task_id"].clone())).ok_or("no such task")?;
        let (mut thread, mut text) = (s(&a["thread"]), text.to_string());
        let codex = self.codex()?;
        // A Codex thread keeps the tools it started with, so once a device has changed its tools (an update), the agent goes
        // on in a new thread that has them, with its task's story so far.
        if s(&a["tools"]) != names(&self.tools_for(&self.task_kinds(&task))) {
            let mut story: Vec<String> = self.db.all("select who, text from log where agent_id=? order by id desc limit 80", args!(agent))
                .iter().map(|e| format!("{}: {}", s(&e["who"]), short(&s(&e["text"]), 400))).collect();
            story.reverse();
            thread = self.new_thread(agent, &task)?;
            text = format!("Your devices' tools changed (an update), so you go on in a new session. Your task so far, oldest first:\n{}\n\n{text}",
                story.join("\n"));
        } else if !self.loaded.lock().unwrap().contains(&thread) {
            codex.request("thread/resume", json!({ "threadId": thread }), 60)?;
            self.loaded.lock().unwrap().insert(thread.clone());
        }
        let r = codex.request("turn/start", json!({ "threadId": thread, "effort": effort, "input": [{ "type": "text", "text": text }],
            "outputSchema": end_schema() }), 60)?;
        self.log(agent, task["id"].as_i64().unwrap_or(0), 0, "model input", &text);
        let turn = s(&r["turn"]["id"]);
        if !turn.is_empty() { self.turns.lock().unwrap().insert(thread, turn); }
        self.db.run("update agents set status='working', updated=? where id=?", args!(now(), agent));
        Ok(())
    }

    /// A message for a task's agent: steered into its turn if it's working, else a new turn.
    pub fn message_task(self: &Arc<Self>, task_id: i64, request: i64, text: &str, from: &str) -> Result<(), String> {
        let task = self.db.get("select * from tasks where id=?", args!(task_id)).ok_or(format!("there's no task #{task_id}"))?;
        let agent = task["agent_id"].as_i64().ok_or("that task has no agent yet")?;
        self.log(agent, task_id, request, from, text);
        if matches!(s(&task["status"]).as_str(), "needs" | "done" | "dropped") {
            self.db.run("update tasks set status='working', why=null, need=null, updated=? where id=?", args!(now(), task_id));
        }
        let a = self.db.get("select * from agents where id=?", args!(agent)).ok_or("no such agent")?;
        if s(&a["kind"]) == "claude" {
            self.db.run("insert into inbox(agent_id, text, at) values(?,?,?)", args!(agent, format!("From {from} about task #{task_id}: {text}"), now()));
            self.bump();
            return Ok(());
        }
        if a["task_id"] != task["id"] {
            self.db.run("update tasks set status='queued', updated=? where id=?", args!(now(), task_id));
            self.bump();
            return Ok(());
        }
        let text = format!("Message from {from}: {text}");
        if s(&a["kind"]) == CLAUDE_AGENT {
            // Mid-turn it's a steer, read once the current tool calls finish; else it starts a turn.
            let busy = self.claudes.lock().unwrap().get(&agent).is_some_and(|c| c.busy.load(std::sync::atomic::Ordering::SeqCst));
            if !busy { self.nudges.lock().unwrap().remove(&agent); }
            return self.claude_turn(agent, &text);
        }
        let thread = s(&a["thread"]);
        let turn = self.turns.lock().unwrap().get(&thread).cloned();
        if let Some(turn) = turn {
            let steered = self.codex()?.request("turn/steer", json!({ "threadId": thread, "expectedTurnId": turn,
                "input": [{ "type": "text", "text": text }] }), 30);
            if steered.is_ok() { self.log(agent, task_id, request, "model input", &text); return Ok(()); }
        }
        self.nudges.lock().unwrap().remove(&agent);
        self.start_turn(agent, &text)
    }

    pub fn drop_task(self: &Arc<Self>, task_id: i64) {
        let Some(task) = self.db.get("select status from tasks where id=?", args!(task_id)) else { return };
        if !matches!(s(&task["status"]).as_str(), "open" | "queued" | "working" | "needs") { return; }
        self.db.run("update tasks set status='dropped', updated=? where id=?", args!(now(), task_id));
        if let Some(a) = self.db.get("select a.* from agents a join tasks t on t.agent_id=a.id where t.id=? and a.task_id=t.id", args!(task_id)) {
            let thread = s(&a["thread"]);
            if let Some(c) = a["id"].as_i64().and_then(|id| self.claudes.lock().unwrap().get(&id).cloned()) {
                // Its turn's result then ends it (after_turn); between turns there's nothing to wait for.
                if c.busy.load(std::sync::atomic::Ordering::SeqCst) { c.interrupt() } else { c.close() }
            }
            if let Some(turn) = self.turns.lock().unwrap().get(&thread).cloned() {
                if let Ok(c) = self.codex() { c.request("turn/interrupt", json!({ "threadId": thread, "turnId": turn }), 30).ok(); }
            }
            self.db.run("update agents set status='idle', updated=? where id=?", args!(now(), a["id"].clone()));
        }
        self.bump();
    }

    fn save_usage(&self, thread: &str, agent: i64, usage: &Value) {
        if usage["totalTokens"].is_number() {
            self.db.run("insert into usage(thread,agent_id,total,input,output,cached) values(?,?,?,?,?,?) on conflict(thread) do update set total=excluded.total,input=excluded.input,output=excluded.output,cached=excluded.cached",
                args!(thread, agent, usage["totalTokens"], usage["inputTokens"], usage["outputTokens"], usage["cachedInputTokens"]));
        }
    }

    fn note(self: &Arc<Self>, method: &str, params: Value) {
        let thread = s(&params["threadId"]);
        if let Some(tx) = self.watchers.lock().unwrap().get(&thread) { tx.send((method.to_string(), params)).ok(); return; }
        let Some(a) = self.db.get("select * from agents where thread=?", args!(thread)) else { return };
        let (agent, task) = (a["id"].as_i64().unwrap_or(0), a["task_id"].as_i64().unwrap_or(0));
        match method {
            "thread/tokenUsage/updated" => self.save_usage(&thread, agent, &params["tokenUsage"]["total"]),
            "turn/started" => { self.turns.lock().unwrap().insert(thread, s(&params["turn"]["id"])); }
            "item/started" | "item/completed" => {
                let item = &params["item"];
                let line = match s(&item["type"]).as_str() {
                    "agentMessage" if method == "item/completed" => {
                        let text = s(&item["text"]);
                        if ended(&text).is_some() { self.last.lock().unwrap().insert(agent, text); None } else { Some(("agent", text)) }
                    }
                    "commandExecution" | "fileChange" | "webSearch" | "imageView" | "mcpToolCall" =>
                        Some(("tool-item", item.to_string())),
                    _ => None,
                };
                if let Some((who, text)) = line { if !text.is_empty() { self.log(agent, task, 0, who, &text); } }
                if method == "item/completed" && item["type"] == "imageView" {
                    let path = s(&item["path"]);
                    if let Ok(bytes) = std::fs::read(&path) {
                        let name = std::path::Path::new(&path).file_name().and_then(|n| n.to_str()).unwrap_or("image.png");
                        let saved = self.save_file(name, &bytes, "agent");
                        if let Some(id) = saved.file_name().and_then(|n| n.to_str()).and_then(|n| n.split('-').next()) {
                            self.log(agent, task, 0, "image", &json!({"url": format!("api/files/{id}"), "tool": "view_image"}).to_string());
                        }
                    }
                }
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
            self.db.run("update agents set status=?, updated=? where id=?", args!(if t == "done" { "done" } else { "idle" }, now(), agent));
            self.bump();
            return;
        }
        match end {
            // Before a stop reaches the owner, the agent checks once that it's truly theirs and not a tool falling short.
            Some(e) if e["done"] != true && self.rechecked.lock().unwrap().insert(agent) => {
                let me = self.clone();
                std::thread::spawn(move || { me.start_turn(agent, RECHECK).ok(); });
            }
            Some(e) if self.finish(agent, task, &e) => {}
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

    /// A task ended: done with the outcome, or needs the owner (exact why and need). False if it says neither.
    fn finish(&self, agent: i64, task: i64, e: &Value) -> bool {
        if e["done"] == true {
            self.db.run("update tasks set status='done', outcome=?, updated=? where id=?", args!(s(&e["outcome"]), now(), task));
            self.db.run("update agents set status=case when kind='claude' then status else 'done' end, updated=? where id=?", args!(now(), agent));
            self.log(agent, task, 0, "done", &s(&e["outcome"]));
        } else if !s(&e["why"]).trim().is_empty() && !s(&e["need"]).trim().is_empty() {
            self.db.run("update tasks set status='needs', why=?, need=?, updated=? where id=?", args!(s(&e["why"]), s(&e["need"]), now(), task));
            self.db.run("update agents set status=case when kind='claude' then status else 'idle' end, updated=? where id=?", args!(now(), agent));
            self.log(agent, task, 0, "needs you", &format!("{} Needs: {}", s(&e["why"]), s(&e["need"])));
        } else {
            return false;
        }
        self.nudges.lock().unwrap().remove(&agent);
        self.rechecked.lock().unwrap().remove(&agent);
        self.bump();
        true
    }

    /// A Claude Code session says how its task ended.
    pub fn end_task(&self, task: i64, e: &Value) -> Result<(), String> {
        let agent = self.db.get("select agent_id from tasks where id=?", args!(task)).and_then(|r| r["agent_id"].as_i64()).ok_or(format!("there's no task #{task} with an agent"))?;
        if self.finish(agent, task, e) { Ok(()) } else { Err("Say done with the outcome, or needs with exactly why and what the owner must do.".into()) }
    }

    // ---- locks: tools that share a lock are used by one agent at a time ----

    fn take_lock(&self, name: &str, agent: i64) -> Result<(), String> {
        let got = self.wait_until(120_000, || {
            let mut l = self.locks.lock().unwrap();
            match l.get(name) {
                Some((holder, _)) if *holder != agent => None,
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

    // ---- devices: each declares its tools; calls wait in the calls table until the device takes and answers them ----

    /// The device kinds Hive knows, for the planner.
    fn kinds(&self) -> Vec<String> {
        let mut k = vec!["vm".to_string()];
        if self.repo.is_some() { k.push("hive".into()); }
        k.extend(self.db.all("select distinct kind from nodes order by kind", &[]).iter().map(|r| s(&r["kind"])));
        k
    }

    /// The devices a task's agent gets: the task's own, plus the owner's Mac and iPhone (for sign-in verifications) and, on a Hive
    /// with a checkout, Hive's own code: its way around a technical problem.
    fn task_kinds(&self, task: &Value) -> Vec<String> {
        let mut kinds = list(&task["nodes"]);
        let extra = if self.repo.is_some() { &["mac", "phone", "browser", "hive"][..] } else { &["mac", "phone", "browser"][..] };
        for k in extra { if !kinds.iter().any(|n| n == k) { kinds.push(k.to_string()); } }
        kinds
    }

    /// Every tool a task on these devices gets: the cloud's, then each device's (the most recently seen device of a kind wins).
    fn tools_for(&self, kinds: &[String]) -> Vec<Value> {
        let mut out: Vec<Value> = tools::cloud(kinds);
        let mut names: HashSet<String> = out.iter().map(|t| s(&t["name"])).collect();
        for n in self.db.all("select kind, tools from nodes order by seen desc", &[]) {
            if !kinds.contains(&s(&n["kind"])) { continue; }
            for mut t in list_values(&n["tools"]) {
                if n["kind"] == "browser" {
                    t["inputSchema"]["properties"]["browser"] = json!({"type":"string", "description":"Browser device ID from browser_devices. Required when several browsers are registered; use the same ID for every call involving its tabs."});
                }
                if names.insert(s(&t["name"])) { out.push(t); }
            }
        }
        out
    }

    /// The device that declared this tool (the most recently seen one), and its declaration.
    fn device_for(&self, tool: &str) -> Option<(Value, Value)> {
        self.db.all("select id, kind, name, seen, tools from nodes order by seen desc", &[]).into_iter()
            .find_map(|n| list_values(&n["tools"]).into_iter().find(|t| t["name"] == tool).map(|t| (n.clone(), t)))
    }

    pub fn call_node(&self, node: &Value, tool: &str, args: &Value, agent: i64, secs: u64) -> Result<Value, String> {
        let (id, kind) = (s(&node["id"]), s(&node["kind"]));
        // A device that's away for a moment (restarting into an update, its network changing) gets three minutes to come back.
        let here = || self.db.get("select seen from nodes where id=?", args!(id)).and_then(|n| n["seen"].as_i64()).filter(|t| *t >= now() - 90_000);
        if here().is_none() && self.wait_until(180_000, here).is_none() {
            return Err(format!("The owner's {kind} ({}) hasn't been connected to Hive for over three minutes, so {tool} can't run. Do the task \
                another way, or end saying it needs to be online.", s(&node["name"])));
        }
        let call = self.db.run("insert into calls(node, tool, args, agent_id, at) values(?,?,?,?,?)", args!(id, tool, args.clone(), agent, now()));
        self.bump();
        let done = self.wait_until(secs * 1000, || {
            self.db.get("select result from calls where id=? and status='done'", args!(call)).map(|r| s(&r["result"]))
        });
        self.db.run("update calls set args='{}' where id=?", args!(call)); // a typed password doesn't stay in the database
        match done {
            Some(r) => Ok(serde_json::from_str(&r).unwrap_or(json!({ "text": r }))),
            None => {
                self.db.run("update calls set status='timeout' where id=?", args!(call));
                Err(if here().is_none() { format!("The {kind} went offline during {tool} (it may be restarting into an update), so it may not have run: check, then try again.") }
                    else { format!("The {kind} didn't answer {tool} within {secs}s.") })
            }
        }
    }

    // ---- tool calls from agents ----

    fn tool(self: &Arc<Self>, params: &Value) -> Value {
        let name = s(&params["tool"]);
        let a = &params["arguments"];
        let agent_row = self.db.get("select * from agents where thread=?", args!(s(&params["threadId"]))).unwrap_or(json!({}));
        let (agent, task) = (agent_row["id"].as_i64().unwrap_or(0), agent_row["task_id"].as_i64().unwrap_or(0));
        let (ok, text, images) = self.run_tool(&name, a, agent, task);
        tool_result(ok, &text, &images)
    }

    /// A tool call, logged, as either engine answers it: whether it worked, its text, and its images (data URLs).
    fn run_tool(self: &Arc<Self>, name: &str, a: &Value, agent: i64, task: i64) -> (bool, String, Vec<String>) {
        let id = crate::api::random(12);
        let arguments = if name.contains("password") { json!({}) } else { a.clone() };
        let record = |status: &str, output: &str| self.log(agent, task, 0, "tool-item",
            &json!({"id": id, "type": "mcpToolCall", "tool": name, "arguments": arguments,
                "status": status, "output": output}).to_string());
        record("inProgress", "");
        match self.tool_inner(name, a, agent, task) {
            Ok(v) if v["error"].is_null() => {
                let images: Vec<String> = v["images"].as_array().map(|i| i.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default();
                for image in &images {
                    if let Some((header, encoded)) = image.split_once(",") {
                        let ext = match header {
                            "data:image/png;base64" => "png",
                            "data:image/jpeg;base64" => "jpg",
                            "data:image/webp;base64" => "webp",
                            _ => continue,
                        };
                        if let Some(bytes) = b64::decode(encoded) {
                            let path = self.save_file(&format!("{name}.{ext}"), &bytes, "agent");
                            if let Some(id) = path.file_name().and_then(|n| n.to_str()).and_then(|n| n.split('-').next()) {
                                self.log(agent, task, 0, "image", &json!({"url": format!("api/files/{id}"), "tool": name}).to_string());
                            }
                        }
                    }
                }
                let text = if v.is_string() { s(&v) } else { s(&v["text"]) };
                record("completed", &text);
                (true, text, images)
            }
            Ok(v) => { record("failed", &s(&v["error"])); (false, s(&v["error"]), vec![]) }
            Err(e) => { record("failed", &e); (false, e, vec![]) }
        }
    }

    // ---- Claude Code agents (claude.rs): a process per agent while it works, its tools over MCP ----

    /// A message into a Claude agent's process (a steer mid-turn, else a new turn), starting the process if it isn't running.
    fn claude_turn(self: &Arc<Self>, agent: i64, text: &str) -> Result<(), String> {
        let running = self.claudes.lock().unwrap().get(&agent).cloned();
        // One that just exited fails to take it; a new process resumes its session.
        if running.map(|c| c.say(text)).is_none_or(|r| r.is_err()) { self.spawn_claude(agent)?.say(text)?; }
        let task = self.db.get("select task_id from agents where id=?", args!(agent)).unwrap_or(json!({}));
        self.log(agent, task["task_id"].as_i64().unwrap_or(0), 0, "model input", text);
        self.db.run("update agents set status='working', updated=? where id=?", args!(now(), agent));
        Ok(())
    }

    fn spawn_claude(self: &Arc<Self>, agent: i64) -> Result<Arc<Claude>, String> {
        let Engine::Claude { cmd, env } = &self.engine else { return Err("this Hive runs on Codex, not Claude Code".into()) };
        let a = self.db.get("select * from agents where id=?", args!(agent)).ok_or("no such agent")?;
        let task = self.db.get("select * from tasks where id=?", args!(a["task_id"].clone())).ok_or("the agent has no task")?;
        let level = s(&task["level"]);
        let (_, model, effort) = CLAUDE_LEVELS.iter().find(|l| l.0 == level).copied().unwrap_or(CLAUDE_LEVELS[1]);
        let token = crate::api::random(24);
        let mcp = json!({ "mcpServers": { "hive": { "type": "http", "url": format!("{}/mcp/{token}", self.local) } } });
        let mut args: Vec<String> = ["--model", model, "--effort", effort].map(String::from).into();
        args.extend(["--append-system-prompt".into(), format!("{}\n\n{CLAUDE_NOTES}", self.instructions(&task)), "--mcp-config".into(), mcp.to_string()]);
        let thread = s(&a["thread"]);
        if thread.is_empty() { self.log(agent, task["id"].as_i64().unwrap_or(0), 0, "session input", &format!("{}\n\n{CLAUDE_NOTES}", self.instructions(&task))); }
        if !thread.is_empty() { args.extend(["--resume".into(), thread]); }
        self.mcp.lock().unwrap().insert(token.clone(), agent);
        let me = self.clone();
        let c = Claude::spawn(cmd, &args, env, &self.cwd(&task), token.clone(), move |c, out| me.claude_out(agent, c, out))
            .inspect_err(|_| { self.mcp.lock().unwrap().remove(&token); })?;
        self.claudes.lock().unwrap().insert(agent, c.clone());
        Ok(c)
    }

    /// What a Claude agent's process said (None: it exited), as note() does for Codex's.
    fn claude_out(self: &Arc<Self>, agent: i64, c: &Claude, out: Option<Out>) {
        use std::sync::atomic::Ordering::SeqCst;
        let task = self.db.get("select task_id from agents where id=?", args!(agent)).and_then(|r| r["task_id"].as_i64()).unwrap_or(0);
        match out {
            Some(Out::Session(id)) => { self.db.run("update agents set thread=? where id=?", args!(id, agent)); }
            Some(Out::Log(who, text)) => if !text.is_empty() { self.log(agent, task, 0, who, &text) },
            Some(Out::Ended { queued, .. }) if queued > 0 => {} // it goes straight on to the steers it hadn't taken
            Some(Out::Ended { error, .. }) => {
                c.busy.store(false, SeqCst);
                self.release_all(agent);
                if let Some(e) = error { self.log(agent, task, 0, "hive", &format!("Turn failed: {e}")); }
                self.after_turn(agent, task, if c.interrupted.swap(false, SeqCst) { "interrupted" } else { "completed" }.into());
                // Done or waiting on the owner: the process goes, and a message later resumes its session in a new one.
                if self.db.get("select 1 from agents where id=? and status='working'", args!(agent)).is_none() { c.close(); }
            }
            None => {
                self.mcp.lock().unwrap().remove(&c.token);
                let mut running = self.claudes.lock().unwrap();
                if running.get(&agent).is_some_and(|r| r.token == c.token) { running.remove(&agent); }
                drop(running);
                // Gone mid-turn without a result: that turn ended, and after_turn keeps it going a bounded number of times.
                if c.busy.swap(false, SeqCst) {
                    self.release_all(agent);
                    self.log(agent, task, 0, "hive", "Claude Code stopped mid-turn.");
                    self.after_turn(agent, task, "failed".into());
                }
            }
        }
    }

    /// An MCP message from a Claude agent's process, signed in by its secret. Ok(None) for a notification.
    pub fn mcp(self: &Arc<Self>, token: &str, m: &Value) -> Result<Option<Value>, String> {
        let agent = self.mcp.lock().unwrap().get(token).copied().ok_or("no such agent")?;
        let task = self.db.get("select t.* from agents a join tasks t on t.id=a.task_id where a.id=?", args!(agent)).unwrap_or(json!({}));
        let tid = task["id"].as_i64().unwrap_or(0);
        let tools = || {
            let mut t: Vec<Value> = self.tools_for(&self.task_kinds(&task)).iter().map(tools::for_mcp).collect();
            t.push(crate::claude::end_turn());
            t
        };
        Ok(hive_protocol::mcp::answer(m, "", tools, |name, a| {
            if name != "end_turn" { return self.run_tool(name, a, agent, tid); }
            // What a Codex agent's final message would be: after_turn reads it when the turn's result comes.
            let end = json!({ "done": a["done"], "outcome": s(&a["outcome"]), "why": s(&a["why"]), "need": s(&a["need"]) });
            if !a["done"].is_boolean() { return (false, "Give done (true or false), with the outcome, or why and need.".into(), vec![]); }
            self.last.lock().unwrap().insert(agent, end.to_string());
            (true, "Recorded. End your turn now.".into(), vec![])
        }))
    }

    fn tool_inner(self: &Arc<Self>, name: &str, a: &Value, agent: i64, task: i64) -> Result<Value, String> {
        match name {
            "browser_devices" => return Ok(json!(serde_json::to_string(&self.db.all("select id, name, seen from nodes where kind='browser' order by seen desc", &[])).unwrap())),
            "claim_task" => {
                self.claim_task(agent, a["task"].as_i64().ok_or("give the task id")?)?;
                return Ok(json!("Claimed. It runs after your current task."));
            }
            "message_agent" => {
                let to = a["task"].as_i64().ok_or("give the task id")?;
                self.message_task(to, 0, &s(&a["text"]), &format!("task #{task}'s agent"))?;
                return Ok(json!(format!("Sent to task #{to}'s agent.")));
            }
            "history" => {
                let before = a["before"].as_i64().filter(|n| *n > 0).unwrap_or(i64::MAX);
                let rows = self.history(&s(&a["query"]), &s(&a["project"]), before, 10);
                return Ok(json!(serde_json::to_string(&rows).unwrap()));
            }
            "info" => {
                let (key, value) = (s(&a["key"]), s(&a["value"]));
                if !key.is_empty() && !value.is_empty() {
                    self.db.run("insert into info(key, value, updated) values(?,?,?) on conflict(key) do update set value=excluded.value, updated=excluded.updated", args!(key, value, now()));
                    return Ok(json!("Saved."));
                }
                let rows = if key.is_empty() { self.db.all("select key, value from info order by key", &[]) } else { self.db.all("select key, value from info where key=?", args!(key)) };
                return Ok(json!(rows.iter().map(|r| format!("{}: {}", s(&r["key"]), s(&r["value"]))).collect::<Vec<_>>().join("\n")));
            }
            "type_password" => {
                let (site, user, tool) = (s(&a["site"]), s(&a["username"]), s(&a["tool"]));
                if tool.is_empty() { return crate::vm::type_password(&site, &user).map(|m| json!(m)); }
                let target = match tool.as_str() {
                    "browser_type" => "browser_type_password", "mac_type" => "mac_type_password",
                    "windows_type" => "windows_type_password",
                    _ => return Err("tool must be browser_type, mac_type, or windows_type".into()),
                };
                let mut args = serde_json::from_str::<Value>(&s(&a["args"])).ok().filter(Value::is_object).unwrap_or(json!({}));
                args["site"] = json!(site); args["username"] = json!(user);
                let r = self.tool_inner(target, &args, agent, task)?;
                return Ok(if r["error"].is_null() { json!(format!("Typed the saved password for {site} with {tool}.")) } else { r });
            }
            "reinstall" => return crate::vm::reinstall(self.repo.as_ref().ok_or("Hive isn't on a VM here")?),
            "rule" => return self.add_rule(&s(&a["text"]), &s(&a["quote"]), &s(&a["scope"])).map(|r| json!(format!("Saved as R{r}."))),
            "task" => {
                let request = self.db.get("select request_id from tasks where id=?", args!(task)).map(|r| r["request_id"].clone()).unwrap_or(json!(0));
                return Ok(json!(format!("Task #{} made; another agent takes it.", self.add_task(request.as_i64().unwrap_or(0), a))));
            }
            "page_code" => {
                let code = json!({ "css": s(&a["css"]), "js": s(&a["js"]) }).to_string();
                let rule = a["rule"].as_i64().unwrap_or(0);
                self.db.get("select id from rules where id=? and active=1 and scope like 'site:%'", args!(rule)).ok_or("give the id of an active site rule (R12 is 12)")?;
                self.db.run("update rules set code=? where id=?", args!(code, rule));
                self.bump();
                return Ok(json!("Saved: the owner's browsers apply it on that site's pages from their next load."));
            }
            _ => {}
        }
        let selected = a["browser"].as_str().filter(|id| !id.is_empty());
        let (node, decl) = if name.starts_with("browser_") {
            let devices = self.db.all("select id, kind, name, seen, tools from nodes where kind='browser' order by seen desc", &[]);
            if selected.is_none() && devices.len() > 1 { return Err("Choose a browser device ID with browser_devices and pass browser on every call; tab IDs belong to that browser.".into()); }
            devices.into_iter().filter(|n| selected.is_none_or(|id| n["id"] == id))
                .find_map(|n| list_values(&n["tools"]).into_iter().find(|t| t["name"] == name).map(|t| (n, t)))
        } else { self.device_for(name) }.ok_or(format!("Hive has no tool called {name}"))?;
        // Mobile Safari and native touch share the same phone, even with two agents.
        if node["name"] == "Safari on iPhone" { self.take_lock("iPhone touch", agent)?; }
        // Screenshots change the Mac driver's shared target; takeover changes its
        // permission state. They must own the same lock as keyboard and mouse,
        // including when a connected device advertises an older tool list.
        let mac_input = node["kind"] == "mac" && matches!(name,
            "mac_screenshot" | "mac_take_over" | "mac_click" | "mac_drag" |
            "mac_scroll" | "mac_key" | "mac_type" | "mac_type_password");
        if let Some(lock) = if mac_input { Some("input") } else { decl["lock"].as_str() } {
            self.take_lock(&format!("{} {lock}", s(&node["id"])), agent)?;
        }
        // Files cross with the call: vm_path's bytes go to the device, and a file the device sends back lands in Hive's files.
        let mut args = if matches!(name, "browser_type_password" | "mac_type_password" | "windows_type_password") {
            let mut safe = json!({ "site": s(&a["site"]), "username": s(&a["username"]) });
            if name == "browser_type_password" { safe["tab"] = a["tab"].clone(); safe["i"] = a["i"].clone(); }
            safe
        } else { a.clone() };
        if let Some(p) = a["vm_path"].as_str() {
            args["data"] = json!(b64::encode(&std::fs::read(p).map_err(|e| format!("couldn't read {p}: {e}"))?));
        }
        let secs = a["timeout"].as_u64().map(|t| t.clamp(1, 1800) + 15).or(decl["timeout"].as_u64()).unwrap_or(120);
        let mut r = self.call_node(&node, name, &args, agent, secs)?;
        if let (Some(data), Some(fname)) = (r["data"].as_str(), r["name"].as_str()) {
            let bytes = b64::decode(data).ok_or("the device sent a broken file")?;
            let path = self.save_file(fname, &bytes, &s(&node["kind"]));
            r = json!({ "text": format!("{}Saved at {}", r["text"].as_str().map(|t| format!("{t}\n")).unwrap_or_default(), path.display()) });
        }
        Ok(r)
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

fn plan_schema(kinds: &[String]) -> Value {
    let st = json!({ "type": "string" });
    json!({
        "type": "object", "additionalProperties": false, "required": ["reply", "tasks", "messages"],
        "properties": {
            "reply": st,
            "tasks": { "type": "array", "items": { "type": "object", "additionalProperties": false,
                "required": ["title", "quote", "nodes", "level", "project"],
                "properties": { "title": st, "quote": st, "project": st,
                    "nodes": { "type": "array", "items": { "type": "string", "enum": kinds } },
                    "level": { "type": "string", "enum": ["easy", "normal", "hard", "hardest"] } } } },
            "messages": { "type": "array", "items": { "type": "object", "additionalProperties": false, "required": ["task", "text"],
                "properties": { "task": { "type": "integer" }, "text": st } } },
        }
    })
}

const PLANNER: &str = "You are Hive's orchestrator. Every request from the owner (from any of their devices, the dashboard, or a \
Claude Code session) comes to you first, and you route it. You don't write rules or break work down: the agent that takes the \
request does, since it has the context.
- Use the earlier requests to resolve references such as it, this problem, and also, including recently completed work. The current request and explicit rules take precedence over historical context.
- messages: when the request is about an open task (a correction, an answer, more detail, stop), send it to that task's agent: \
task = its id, text = the owner's words.
- tasks: otherwise one new task (an existing agent for the same project can queue it): title = short imperative; quote = the owner's exact words; nodes = where the \
work happens (the nodes listed below; a request about what a site's pages show or do needs browser); level = \
easy|normal|hard|hardest; project = a short project name, the same as an open task's when related. None for a request from a \
Claude Code session (claude:…): that session writes its own. Answer questions yourself using the supplied conversation, outcomes and rules; do not create a task merely to restate an answer already available. Create a research task only when answering requires new evidence or device actions. When a question accompanies requested work, answer it in reply immediately and route the work. A problem report such as why did this fail, this should work, or fix this requests a repair: assign implementation and verification, not just investigation. Preserve the full intended outcome in the task title and quote.
- reply: answer the owner's question first when the evidence is available, then briefly say what work happens next. For an answer requiring no work, return empty tasks and messages.";

/// What an agent that's about to stop for the owner hears first.
const RECHECK: &str = "Before this goes to the owner: is it truly something only they can do (their own decision, a one-way door like \
sending as them, deleting or paying, or their finger or face)? A tool falling short isn't. Use the other device: Safari's page tools \
and the Mac's window tools see the same page differently. Ask for the whole Mac with mac_take_over, approve a sign-in's verification \
on their iPhone, or fix Hive's own code. Then keep going. If it truly is theirs, end the same way again.";

const AGENT: &str = "You are one of Hive's agents, working for the owner on one task. Hive is the owner's own agent system: its \
server runs on the computer you run on and reaches the owner's devices. Your first message tells the owner what you'll do and \
about how long it will take. Work until the task is done. Your turn's final message says how it ended: done with the outcome, or not done with the exact reason you stopped and exactly \
what you need from the owner. Done means every part of what the owner asked for is done; if any part isn't, it's not done. There is no \"stuck\": when something fails, try another way; ending a turn without either means you \
keep going. You heard the owner in context, so you write what follows from their words: a standing instruction \
(always, never, from now on, a preference) becomes a rule (the rule tool), scoped as far as they meant it and no further; work \
that's truly separate from yours becomes a task (the task tool). Never send a message \
as the owner, delete their things or pay unless their own words say to; anything you send uses their words verbatim or says an agent \
sends it on their behalf. Signing in never needs the owner: sign in yourself with their saved logins (type_password), and approve \
its verification yourself on the owner's iPhone (the phone tools: a Duo push, a code in Messages). A technical problem is yours to \
solve, not the owner's: the owner's Mac (its Hive app's shell, screen, mouse and keyboard) is your extra pair of hands, and when it's \
Hive itself that falls short, improve Hive's own code. When one app's window can't do it (a menu shortcut, a system dialog, a page \
that won't respond), don't end with a blocker: ask for the whole Mac with mac_take_over (why, and about how many minutes), and once \
the owner hands it over, use its own pointer and keyboard. Never take over their screen any other way, like bringing an app to the \
front. When you discover or use confirmed personal details belonging to the owner (for example their name, email or phone), \
save them with info during the task so later sessions can retrieve them. Check existing entries first; reuse their keys and save \
only new or corrected facts. Save facts from the owner or a verified personal source; never guesses, unrelated people, passwords, \
verification codes or tokens. Personal facts belong in info; only explicit standing instructions belong in rules. A request to fix \
a problem includes implementing and testing the repair; investigation alone does not complete it. Never print passwords or keys. Messages from the owner or other agents can arrive while you work; follow them.";

/// Claude Code has no schema for a turn's final message, so its agents end with a tool instead.
const CLAUDE_NOTES: &str = "Hive's tools (rule, task, info, type_password, message_agent and the devices') are yours as MCP tools \
named mcp__hive__<name>. Hive doesn't read your final message: end every turn by calling mcp__hive__end_turn as your very last \
action, with done true and the outcome, or done false with exactly why you stopped and exactly what you need from the owner.";

const VM_NOTES: &str = "- This VM (Ubuntu, you're root): your shell. Its screen is Xvfb :99: \
`export DISPLAY=:99 XAUTHORITY=/home/ubuntu/.Xauthority-99`; `vm-chrome [url] &` opens its Chrome, `vm-shot > /tmp/s.png` and \
view_image show the screen, xdotool clicks and types. Saved logins: `hive-cred list`, and type_password types one, here or in a device. Hive's files \
(shared with the dashboard and nodes) are in /var/lib/hive/files.";

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn device_lock_waits_for_release_even_after_a_minute() {
        let hive = Hive::new(Db::open(":memory:"), std::env::temp_dir(), None,
            Engine::Codex { cmd: String::new(), env: vec![] }, String::new(), String::new());
        hive.locks.lock().unwrap().insert("mac input".into(), (1, now() - 600_000));
        std::thread::scope(|scope| {
            let waiter = scope.spawn(|| hive.take_lock("mac input", 2));
            std::thread::sleep(Duration::from_millis(100));
            assert_eq!(hive.locks()[0]["agent"], 1);
            hive.release_all(1);
            waiter.join().unwrap().unwrap();
        });
        assert_eq!(hive.locks()[0]["agent"], 2);
        hive.take_lock("mac input", 2).unwrap();
        hive.release_all(2);
        assert_eq!(hive.locks(), json!([]));
    }

    #[test]
    fn mac_screenshot_and_takeover_lock_even_older_devices() {
        let hive = Hive::new(Db::open(":memory:"), std::env::temp_dir(), None,
            Engine::Codex { cmd: String::new(), env: vec![] }, String::new(), String::new());
        let decl = json!([{"name":"mac_screenshot","timeout":0},{"name":"mac_take_over","timeout":0},{"name":"mac_key","lock":"input","timeout":0}]);
        hive.db.run("insert into nodes(id,kind,name,tools,seen) values('mac-test','mac','Mac',?,?)", args!(decl.to_string(),now()));
        for name in ["mac_screenshot", "mac_take_over", "mac_key"] {
            hive.tool_inner(name, &json!({}), 1, 0).unwrap_err();
            assert_eq!(hive.locks()[0]["lock"], "mac-test input");
            assert_eq!(hive.locks()[0]["agent"], 1);
        }
        assert_eq!(hive.locks().as_array().unwrap().len(), 1);
    }

    #[test]
    fn session_usage_replaces_cumulative_totals_without_double_counting() {
        let hive = Hive::new(Db::open(":memory:"), std::env::temp_dir(), None,
            Engine::Codex { cmd: String::new(), env: vec![] }, String::new(), String::new());
        for total in [100, 120, 120] {
            hive.save_usage("session", 7, &json!({"totalTokens":total,"inputTokens":90,"outputTokens":30,"cachedInputTokens":50}));
        }
        hive.save_usage("session", 7, &Value::Null);
        let usage = hive.db.get("select * from usage where agent_id=7", &[]).unwrap();
        assert_eq!(usage["total"], 120);
        assert_eq!(usage["cached"], 50);
        assert_eq!(hive.db.all("select * from usage", &[]).len(), 1);
    }

    #[test]
    fn browser_selection_never_falls_back_to_another_device() {
        let hive = Hive::new(Db::open(":memory:"), std::env::temp_dir(), None,
            Engine::Codex { cmd: String::new(), env: vec![] }, String::new(), String::new());
        let decl = json!([{"name":"browser_tabs","inputSchema":{"type":"object","properties":{}},"timeout":0}]);
        for (id, name) in [("mac-browser", "Safari"), ("phone-browser", "Safari on iPhone")] {
            hive.db.run("insert into nodes(id,kind,name,tools,seen) values(?,'browser',?,?,?)", args!(id,name,decl.to_string(),now()));
        }
        assert!(hive.tool_inner("browser_tabs", &json!({}), 1, 0).unwrap_err().contains("Choose"));
        assert!(hive.tool_inner("browser_tabs", &json!({"browser":"missing"}), 1, 0).is_err());
        assert_eq!(hive.db.get("select count(*) as n from calls", &[]).unwrap()["n"], 0);
        hive.tool_inner("browser_tabs", &json!({"browser":"phone-browser"}), 1, 0).unwrap_err();
        assert_eq!(hive.db.get("select node from calls", &[]).unwrap()["node"], "phone-browser");
        assert_eq!(hive.locks()[0]["lock"], "iPhone touch");
        let kinds = hive.task_kinds(&json!({"nodes":["phone"]}));
        let tools = hive.tools_for(&kinds);
        assert!(tools.iter().any(|t| t["name"] == "browser_devices"));
        assert!(tools.iter().any(|t| t["name"] == "browser_tabs" && t["inputSchema"]["properties"]["browser"]["type"] == "string"));
    }

    #[test]
    fn history_preserves_corrections_and_completed_project_work() {
        let hive = Hive::new(Db::open(":memory:"), std::env::temp_dir(), None,
            Engine::Codex { cmd: String::new(), env: vec![] }, String::new(), String::new());
        for text in ["Build the keyboard", "Unrelated work", "Fix this problem"] {
            hive.db.run("insert into requests(text, node, context) values(?, 'dashboard', '{}')", args!(text));
        }
        let tid = hive.add_task(1, &json!({"title":"Keyboard", "project":"typing", "quote":"Build the keyboard"}));
        hive.db.run("update tasks set status='done', outcome='Built and tested' where id=?", args!(tid));
        hive.log(0, tid, 0, "owner", "Keep calibration across restarts");
        hive.log(0, tid, 0, "agent", "This is not owner evidence");
        let rows = hive.history("calibration", "typing", 3, 10);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["id"], 1);
        assert_eq!(rows[0]["tasks"][0]["outcome"], "Built and tested");
        assert_eq!(rows[0]["followups"].as_array().unwrap().len(), 1);
        assert!(hive.history("", "other", 3, 10).is_empty());
        assert!(hive.history("", "", 1, 10).is_empty());
        assert_eq!(hive.history("", "", 3, 1)[0]["id"], 2);
        let req = hive.db.get("select * from requests where id=3", &[]).unwrap();
        assert!(hive.planner_input(&req).contains("Keep calibration"));
        let task = hive.add_task(3, &json!({"title":"Fix", "project":"typing", "quote":"Fix this problem"}));
        let task = hive.db.get("select * from tasks where id=?", args!(task)).unwrap();
        let instructions = hive.instructions(&task);
        assert!(instructions.contains("Built and tested"));
        assert!(instructions.contains("Keep calibration"));
        assert!(!instructions.contains("Unrelated work"));
        assert!(hive.db.all("select * from rules", &[]).is_empty());
        let result = hive.tool_inner("history", &json!({"query":"calibration", "project":"typing", "before":0}), 0, 0).unwrap();
        let evidence: Value = serde_json::from_str(result.as_str().unwrap()).unwrap();
        assert_eq!(evidence[0]["id"], 1);
    }

    #[test]
    fn personal_facts_are_retrievable_by_later_agents() {
        let hive = Hive::new(Db::open(":memory:"), std::env::temp_dir(), None,
            Engine::Codex { cmd: String::new(), env: vec![] }, String::new(), String::new());
        hive.tool_inner("info", &json!({"key":"email", "value":"owner@example.test"}), 1, 1).unwrap();
        let later = hive.tool_inner("info", &json!({"key":"email", "value":""}), 2, 2).unwrap();
        assert!(later.as_str().unwrap().contains("owner@example.test"));
        hive.tool_inner("info", &json!({"key":"email", "value":"updated@example.test"}), 2, 2).unwrap();
        assert_eq!(hive.db.all("select * from info", &[]).len(), 1);
        assert!(hive.tool_inner("info", &json!({"key":"", "value":""}), 3, 3).unwrap().as_str().unwrap().contains("updated@example.test"));
        assert!(hive.db.all("select * from rules", &[]).is_empty());
    }

    #[test]
    fn inactive_task_messages_never_enter_current_thread() {
        let hive = Hive::new(Db::open(":memory:"), std::env::temp_dir(), None,
            Engine::Codex { cmd: String::new(), env: vec![] }, String::new(), String::new());
        let agent = hive.db.run("insert into agents(task_id,kind,thread,status) values(10,'codex','current-thread','working')", &[]);
        hive.db.run("insert into tasks(id,agent_id,status) values(10,?,'working')",args!(agent));
        hive.db.run("insert into tasks(id,agent_id,status) values(11,?,'done')",args!(agent));
        hive.message_task(11,0,"Follow up on the old task","owner").unwrap();
        assert_eq!(hive.db.get("select status from tasks where id=11", &[]).unwrap()["status"],"queued");
        assert_eq!(hive.db.get("select task_id from agents where id=?",args!(agent)).unwrap()["task_id"],10);
        assert!(hive.db.all("select * from log where who='model input'", &[]).is_empty());
        assert!(hive.session_context(11).unwrap_err().contains("live session has ended"));
    }

    #[test]
    fn dropping_a_task_preserves_its_agent_and_other_tasks() {
        let hive = Hive::new(Db::open(":memory:"), std::env::temp_dir(), None,
            Engine::Codex { cmd: String::new(), env: vec![] }, String::new(), String::new());
        let agent = hive.db.run("insert into agents(task_id,kind,status) values(10,'codex','working')", &[]);
        hive.db.run("insert into tasks(id,agent_id,status) values(10,?,'working')", args!(agent));
        hive.db.run("insert into tasks(id,agent_id,status) values(11,?,'queued')", args!(agent));
        hive.drop_task(10);
        hive.after_turn(agent, 10, "interrupted".into());
        assert_eq!(hive.db.get("select status from tasks where id=10", &[]).unwrap()["status"], "dropped");
        assert_eq!(hive.db.get("select status from tasks where id=11", &[]).unwrap()["status"], "queued");
        assert_eq!(hive.db.get("select status from agents where id=?", args!(agent)).unwrap()["status"], "idle");
        assert!(!hive.ready_for_task(agent));
        hive.db.run("update tasks set status='done' where id=10", &[]);
        hive.drop_task(10);
        assert_eq!(hive.db.get("select status from tasks where id=10", &[]).unwrap()["status"], "done");
    }

    #[test]
    fn claims_queue_without_displacing_current_work() {
        let hive = Hive::new(Db::open(":memory:"), std::env::temp_dir(), None,
            Engine::Codex { cmd: String::new(), env: vec![] }, String::new(), String::new());
        hive.db.run("insert into tasks(id, status) values(10, 'working')", &[]);
        let agent = hive.db.run("insert into agents(task_id, kind, status) values(10, 'codex', 'working')", &[]);
        let other = hive.db.run("insert into agents(kind) values('codex')", &[]);
        let task = hive.add_task(0, &json!({"title":"Next", "quote":"next"}));
        hive.claim_task(agent, task).unwrap();
        assert!(hive.claim_task(other, task).is_err());
        let a = hive.db.get("select * from agents where id=?", args!(agent)).unwrap();
        assert_eq!(a["task_id"], 10);
        assert_eq!(a["status"], "working");
        hive.message_task(task, 0, "More detail", "owner").unwrap();
        assert_eq!(hive.db.get("select status from tasks where id=?", args!(task)).unwrap()["status"], "queued");
        hive.drop_task(task);
        assert_eq!(hive.db.get("select status from agents where id=?", args!(agent)).unwrap()["status"], "working");
        let next = hive.add_task(0, &json!({"title":"Next task", "quote":"do next"}));
        hive.claim_task(agent, next).unwrap();
        assert!(hive.finish(agent, 10, &json!({"done":true,"outcome":"finished"})));
        // An unavailable engine stops the next task, but keeps the same agent and task history.
        hive.start_agent(next);
        let a = hive.db.get("select * from agents where id=?", args!(agent)).unwrap();
        assert_eq!(a["task_id"], next);
        assert_eq!(hive.db.get("select count(*) as n from agents", &[]).unwrap()["n"], 2);
        assert_eq!(hive.db.get("select agent_id from tasks where id=?", args!(task)).unwrap()["agent_id"], agent);
    }

    #[test]
    fn handoff_requires_completed_task_and_ended_turn() {
        for kind in ["codex", CLAUDE_AGENT] {
            let engine = if kind == "codex" { Engine::Codex { cmd: String::new(), env: vec![] } }
                else { Engine::Claude { cmd: String::new(), env: vec![] } };
            let hive = Hive::new(Db::open(":memory:"), std::env::temp_dir(), None,
                engine, String::new(), String::new());
            let current = hive.add_task(0, &json!({"title":"Current", "project":"handoff"}));
            let agent = hive.db.run("insert into agents(task_id, kind, status, thread) values(?, ?, 'idle', 'thread')", args!(current, kind));
            hive.db.run("update tasks set agent_id=? where id=?", args!(agent, current));
            let next = hive.add_task(0, &json!({"title":"Next", "project":"handoff"}));
            for status in ["working", "needs", "dropped", "open"] {
                hive.db.run("update tasks set status=? where id=?", args!(status, current));
                hive.start_agent(next);
                assert!(!hive.ready_for_task(agent));
                assert_eq!(hive.db.get("select task_id from agents where id=?", args!(agent)).unwrap()["task_id"], current);
                assert_eq!(hive.db.get("select status from tasks where id=?", args!(next)).unwrap()["status"], "queued");
                assert!(hive.db.all("select * from log where who='session input'", &[]).is_empty());
            }
            hive.db.run("update tasks set status='done' where id=?", args!(current));
            hive.turns.lock().unwrap().insert("thread".into(), "turn".into());
            hive.start_agent(next);
            assert!(!hive.ready_for_task(agent));
            hive.turns.lock().unwrap().clear();
            assert!(hive.ready_for_task(agent));
            hive.start_agent(next);
            assert_eq!(hive.db.get("select task_id from agents where id=?", args!(agent)).unwrap()["task_id"], next);
        }
    }

    #[test]
    fn a_session_outside_hive_works_on_its_own_tasks() {
        let state = std::env::temp_dir().join(format!("hive-sessions-test-{}", std::process::id()));
        std::fs::create_dir_all(&state).unwrap();
        let hive = Hive::new(crate::db::Db::open(":memory:"), state.clone(), None, Engine::Codex { cmd: String::new(), env: vec![] }, String::new(), String::new());
        let request = |agent: &str| hive.db.run("insert into requests(at, node, agent, text, status) values(?, 'mac', ?, 'fix it', 'done')", args!(now(), agent));
        let (claude, codex) = (request("claude:s1"), request("codex:s2"));
        for (rid, name) in [(claude, "claude:s1"), (codex, "codex:s2")] {
            let tid = hive.add_task(rid, &json!({ "title": "Fix it", "quote": "fix it" }));
            let t = hive.db.get("select t.status, a.kind, a.name from tasks t join agents a on a.id=t.agent_id where t.id=?", args!(tid)).unwrap();
            assert_eq!((s(&t["status"]), s(&t["kind"]), s(&t["name"])), ("working".into(), "claude".into(), name.into()));
            hive.end_task(tid, &json!({ "done": true, "outcome": "fixed" })).unwrap();
        }
        std::fs::remove_dir_all(&state).ok();
    }
}
