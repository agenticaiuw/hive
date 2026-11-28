//! Hive's brain: every request is planned into tasks and rules, each task gets an agent (a Codex thread, or a Claude Code
//! process: the engine is chosen per Hive), agents' tool calls reach the devices that declared those tools, and tools that
//! share a lock are used by one agent at a time.
use crate::args;
use crate::claude::{Claude, Out};
use crate::codex::{tool_result, Codex, Event};
use crate::db::{now, scope_applies, Db};
use crate::ops::{self, Actor, Role};
use crate::sim;
use crate::tools;
use hive_protocol::b64;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{mpsc, Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

#[derive(Default, Clone, Debug)]
struct TurnEvidence {
    last_failed: Option<String>,
    edited: bool,
    done_checks: u8,
}

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
    /// Per-agent execution evidence for gating premature done=true claims.
    evidence: Mutex<HashMap<i64, TurnEvidence>>,
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
/// The iPhone's node (phone/, run by this server); its tools share the lock "<id> touch".
const PHONE_ID: &str = "phone-iphone";

use hive_protocol::{short, str_val as s};
// The local phone relay polls even when the physical phone is disconnected.
fn node_online(node: &Value) -> bool {
    node["seen"].as_i64().unwrap_or(0) > now() - 90_000
        && (node["id"] != PHONE_ID || hive_phone::connected())
}

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
            turns: Mutex::new(HashMap::new()), watchers: Mutex::new(HashMap::new()), nudges: Mutex::new(HashMap::new()),
            rechecked: Mutex::new(HashSet::new()), evidence: Mutex::new(HashMap::new()), last: Mutex::new(HashMap::new()),
            locks: Mutex::new(HashMap::new()), changed: (Mutex::new(0), Condvar::new()),
            claudes: Mutex::new(HashMap::new()), mcp: Mutex::new(HashMap::new()),
        })
    }

    pub fn engine_name(&self) -> &'static str {
        if matches!(self.engine, Engine::Claude { .. }) { "claude" } else { "codex" }
    }

    pub fn model_for(&self, level: &str) -> (&'static str, &'static str) {
        let table = if matches!(self.engine, Engine::Claude { .. }) { &CLAUDE_LEVELS } else { &LEVELS };
        let (_, m, e) = table.iter().find(|l| l.0 == level).copied().unwrap_or(table[1]);
        (m, e)
    }

    /// Runs the iPhone's node here once the owner has connected one (phone/).
    pub fn start_phone(&self) {
        static ONCE: std::sync::Once = std::sync::Once::new();
        ONCE.call_once(|| {
            // Its token is made here, a new one each start: the node runs in this process.
            let token = crate::api::random(24);
            self.db.run("delete from tokens where node='phone:iPhone'", &[]);
            self.db.run("insert into tokens(hash, node, at) values(?,?,?)", args!(crate::api::hash(&token), "phone:iPhone", now()));
            hive_phone::start(self.state.clone(), hive_protocol::Conf { server: self.local.clone(), token, id: PHONE_ID.into() })
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
            args!(now(), agent, task, request, who, if matches!(who, "tool-item" | "orchestrator input") { text.to_string() } else { short(text, 20000) }));
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
        // The scheduler: a new request or task starts within a moment of being saved (every save bumps), else every 3 s.
        std::thread::spawn(move || loop {
            me.tick();
            let seen = *me.changed.0.lock().unwrap();
            std::thread::sleep(Duration::from_millis(200));
            me.wait_until(3000, || (*me.changed.0.lock().unwrap() != seen).then_some(()));
        });
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

    // External sessions have no provider process here. Their hook check-ins are the
    // only evidence of activity; keep unfinished work, expire running state after 2m, and archive stale idle tasks after 7d.
    fn expire_external_sessions(&self) {
        self.db.run("update tasks set status='idle', updated=? where status='working' and coalesce(updated,at,0)<? and agent_id in (select id from agents where kind='claude')", args!(now(), now()-120_000));
        self.db.run("update agents set status='idle' where kind='claude' and status='working' and coalesce(updated,at,0)<?", args!(now()-120_000));
        self.db.run("update tasks set status='dropped', updated=? where status='idle' and coalesce(updated,at,0)<?", args!(now(), now() - 7 * 86_400_000));
    }

    pub fn external_check_in(&self, agent: i64) {
        self.db.run("update agents set status='working', updated=? where id=? and kind='claude'", args!(now(), agent));
        self.db.run("update tasks set status='working', updated=? where agent_id=? and id=(select task_id from agents where id=?) and status in ('idle','working')", args!(now(), agent, agent));
    }

    fn tick(self: &Arc<Self>) {
        self.expire_external_sessions();
        self.maybe_retrospective();
        for r in self.db.all("select id from requests where status='new' order by id", &[]) {
            let id = r["id"].as_i64().unwrap_or(0);
            self.db.run("update requests set status='planning' where id=?", args!(id));
            let me = self.clone();
            std::thread::spawn(move || me.plan(id));
        }
        for t in self.db.all("select id, depends_on from tasks where status='open' and agent_id is null order by id", &[]) {
            let id = t["id"].as_i64().unwrap_or(0);
            let dep = t["depends_on"].as_i64().unwrap_or(0);
            if dep > 0 {
                let dep_status = self.db.get("select status from tasks where id=?", args!(dep)).map(|r| s(&r["status"])).unwrap_or_default();
                if dep_status == "dropped" {
                    self.db.run("update tasks set status='needs', why=?, need=?, updated=? where id=?",
                        args!(format!("Prerequisite task #{dep} was dropped."), "Drop this task or tell Hive how to proceed.", now(), id));
                    self.bump();
                    continue;
                }
                if dep_status != "done" { continue; }
            }
            self.db.run("update tasks set status='working', updated=? where id=?", args!(now(), id));
            let me = self.clone();
            std::thread::spawn(move || me.start_agent(id));
        }
        // Queued tasks wait while their assigned worker finishes its current task.
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
        // Only this engine's worker agents: the other's threads don't carry over.
        let kind = if matches!(self.engine, Engine::Claude { .. }) { CLAUDE_AGENT } else { "codex" };
        for a in self.db.all("select id from agents where kind=? and status='working' and thread is not null", args!(kind)) {
            let id = a["id"].as_i64().unwrap_or(0);
            if let Err(e) = self.start_turn(id, "Hive restarted while you were working. Carry on with your task.") {
                eprintln!("couldn't resume agent {id}: {e}");
            }
        }
    }

    // ---- planning: the orchestrator agent routes requests into projects, rules, worker tasks, and steers ----

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
    pub fn history(&self, query: &str, project: &str, before: i64, limit: i64) -> Vec<Value> {
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

    /// Compact control-plane index for the orchestrator agent: global + request-scoped rules, online nodes,
    /// project summaries, active tasks, and a 1-line recent request index. Deep details come via `inspect` / `history`.
    fn planner_input(&self, req: &Value) -> String {
        let ctx: Value = serde_json::from_str(&s(&req["context"])).unwrap_or(json!({}));
        let req_node = s(&req["node"]);
        let req_nodes = if req_node.is_empty() { vec![] } else { vec![req_node.clone()] };
        let (site, app, folder, project) = (s(&ctx["site"]), s(&ctx["app"]), s(&ctx["folder"]), s(&ctx["project"]));

        let mut t = String::from("The owner's rules:\n");
        let all_rules = self.db.all("select id, text, scope from rules where active=1 order by id", &[]);
        let mut hidden_rules = 0usize;
        for r in &all_rules {
            let scope = s(&r["scope"]);
            if scope_applies(&scope, &req_nodes, &site, &app, &folder, &project) {
                t += &format!("R{} [{}] {}\n", r["id"], scope, s(&r["text"]));
            } else {
                hidden_rules += 1;
            }
        }
        if hidden_rules > 0 {
            t += &format!("(+{hidden_rules} scoped rules loaded per worker; call inspect(kind=\"rules\") if needed)\n");
        }

        t += if self.repo.is_some() { "\nNodes: vm, hive" } else { "\nNodes: vm" };
        for n in self.db.all("select id, kind, coalesce(display_name,name) as name, seen from nodes order by kind", &[]) {
            let on = if node_online(&n) { "online" } else { "offline" };
            t += &format!(", {} ({}, {on})", s(&n["kind"]), s(&n["name"]));
        }

        let projects = ops::list_projects(self);
        if !projects.is_empty() {
            t += "\n\nProjects:\n";
            for p in projects.iter().take(12) {
                let sum = s(&p["summary"]);
                if sum.is_empty() {
                    t += &format!("- {}\n", s(&p["slug"]));
                } else {
                    t += &format!("- {}: {}\n", s(&p["slug"]), short(&sum, 220));
                }
            }
        }

        t += "\n\nOpen tasks:\n";
        for task in self.db.all("select t.id, t.title, t.status, t.nodes, t.project, t.agent_id, t.depends_on, t.need, a.task_id as on_task from tasks t
            left join agents a on a.id=t.agent_id where t.status in ('open','queued','working','needs','idle') order by t.id", &[]) {
            let who = match (task["agent_id"].as_i64(), task["on_task"].as_i64()) {
                (Some(a), Some(on)) if on != task["id"].as_i64().unwrap_or(0) => format!(", worker {a}, which is on #{on} now"),
                (Some(a), _) => format!(", worker {a}"),
                _ => String::new(),
            };
            let dep = task["depends_on"].as_i64().filter(|&d| d > 0).map(|d| format!(", depends_on #{d}")).unwrap_or_default();
            let need = if s(&task["status"]) == "needs" && !s(&task["need"]).is_empty() {
                format!(", needs: {}", short(&s(&task["need"]), 120))
            } else { String::new() };
            t += &format!("#{} [{}] {} (nodes {}, project {}{who}{dep}{need})\n",
                task["id"], s(&task["status"]), s(&task["title"]), s(&task["nodes"]), s(&task["project"]));
        }

        let before = req["id"].as_i64().unwrap_or(i64::MAX);
        let recent = self.db.all("select id, node, text from requests where id<? order by id desc limit 5", args!(before));
        if !recent.is_empty() {
            t += "\nRecent requests (use inspect or history for details):\n";
            for r in recent.iter().rev() {
                t += &format!("- #{} [{}]: {}\n", r["id"], s(&r["node"]), short(&s(&r["text"]), 140));
            }
        }

        t += &format!("\nRequest #{} from {} ({}):\n{}\n", req["id"], req_node, s(&req["agent"]), s(&req["text"]));
        let raw_ctx = s(&req["context"]);
        if !raw_ctx.is_empty() && raw_ctx != "null" && raw_ctx != "{}" { t += &format!("Context: {}\n", raw_ctx); }
        t
    }

    /// The orchestrator reads (never writes) Hive's own code, so it works in the checkout when this Hive has one.
    fn planner_cwd(&self) -> &std::path::Path { self.repo.as_deref().unwrap_or(&self.state) }

    fn prompt_key(name: &str) -> &str { if name == "agent" { "worker" } else { name } }

    /// The orchestrator's or worker agents' instructions (PROMPTS): the owner's own, edited on the dashboard's Instructions tab,
    /// else Hive's (server/orchestrator.md, server/worker.md). Accepts "agent" as a legacy alias for "worker".
    pub fn prompt(&self, name: &str) -> Option<String> {
        let key = Self::prompt_key(name);
        let own = PROMPTS.iter().find(|p| p.0 == key)?.1;
        let custom = std::fs::read_to_string(self.state.join(format!("{key}.md"))).ok().filter(|t| !t.trim().is_empty())
            .or_else(|| (key == "worker").then(|| std::fs::read_to_string(self.state.join("agent.md")).ok().filter(|t| !t.trim().is_empty())).flatten());
        Some(custom.unwrap_or_else(|| own.into()))
    }

    /// Save the owner's own instructions; empty, or Hive's own, goes back to Hive's.
    pub fn set_prompt(&self, name: &str, text: &str) -> Result<(), String> {
        let key = Self::prompt_key(name);
        let own = PROMPTS.iter().find(|p| p.0 == key).ok_or("There are no such instructions.")?.1;
        let path = self.state.join(format!("{key}.md"));
        if key == "worker" { std::fs::remove_file(self.state.join("agent.md")).ok(); }
        if text.trim().is_empty() || text.trim() == own.trim() { std::fs::remove_file(&path).ok(); return Ok(()); }
        std::fs::write(&path, text).map_err(|e| format!("Couldn't save them: {e}"))
    }

    fn plan_inner(self: &Arc<Self>, req: &Value) -> Result<String, String> {
        let id = req["id"].as_i64().unwrap_or(0);
        if let Engine::Claude { cmd, env } = &self.engine {
            let token = crate::api::random(24);
            let mcp_cfg = if self.local.is_empty() { None } else {
                self.mcp.lock().unwrap().insert(token.clone(), 0);
                Some(json!({ "mcpServers": { "hive": { "type": "http", "url": format!("{}/mcp/{token}", self.local) } } }).to_string())
            };
            let res = crate::claude::plan(cmd, env, self.planner_cwd(), CLAUDE_PLANNER, &self.prompt("orchestrator").unwrap_or_default(),
                &plan_schema(&self.kinds()), &self.planner_input(req), mcp_cfg.as_deref());
            self.mcp.lock().unwrap().remove(&token);
            let plan = res?;
            return Ok(self.apply_plan(id, req, &plan));
        }
        let codex = self.codex()?;
        let orch_tools: Vec<Value> = tools::orchestrator().iter().map(tools::for_codex).collect();
        let started = codex.request("thread/start", json!({
            "model": PLANNER_MODEL.0, "ephemeral": true, "approvalPolicy": "never", "sandbox": "read-only",
            "cwd": self.planner_cwd().to_string_lossy(), "developerInstructions": self.prompt("orchestrator").unwrap_or_default(),
            "dynamicTools": orch_tools,
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
        if !s(&req["agent"]).is_empty() { self.bump(); return s(&plan["reply"]); }
        for p in plan["projects"].as_array().into_iter().flatten() {
            if let Err(e) = ops::upsert_project(self, Actor::orchestrator(), &s(&p["slug"]), &s(&p["title"]), &s(&p["summary"]), None) {
                self.log(0, 0, id, "hive", &format!("Couldn't update project: {e}"));
            }
        }
        for r in plan["rules"].as_array().into_iter().flatten() {
            if let Err(e) = ops::add_rule(self, &s(&r["text"]), &s(&r["quote"]), &s(&r["scope"])) {
                self.log(0, 0, id, "hive", &format!("Couldn't save rule: {e}"));
            }
        }
        for g in plan["grant"].as_array().into_iter().flatten() {
            let tid = g["task"].as_i64().unwrap_or(0);
            if let Err(e) = ops::grant_nodes(self, Actor::orchestrator(), tid, &list(&g["nodes"])) {
                self.log(0, tid, id, "hive", &format!("Couldn't grant nodes to task #{tid}: {e}"));
            }
        }
        for t in plan["tasks"].as_array().into_iter().flatten() { self.add_task(id, t); }
        for t in plan["start"].as_array().into_iter().flatten().filter_map(Value::as_i64) {
            if let Err(e) = self.start_now(t) { self.log(0, t, id, "hive", &format!("Couldn't start task #{t}: {e}")); }
        }
        for t in plan["drop"].as_array().into_iter().flatten().filter_map(Value::as_i64) { self.drop_task(t); }
        for m in plan["messages"].as_array().into_iter().flatten() {
            let tid = m["task"].as_i64().unwrap_or(0);
            if let Err(e) = self.message_task(tid, id, &s(&m["text"]), "owner") {
                self.log(0, tid, id, "hive", &format!("Couldn't pass the message to task #{tid}: {e}"));
            }
        }
        self.bump();
        s(&plan["reply"])
    }

    /// A task for a request, written by the orchestrator or an external session. An external session works on its own tasks;
    /// any other task starts on a fresh worker (unless `continue_worker` is explicitly set).
    pub fn add_task(self: &Arc<Self>, request: i64, t: &Value) -> i64 {
        let level = s(&t["level"]);
        let level = if LEVELS.iter().any(|l| l.0 == level) { level } else { "normal".into() };
        let nodes = if t["nodes"].is_array() { t["nodes"].clone() } else { json!(["vm"]) };
        let every = t["every"].as_i64().unwrap_or(0).max(0);
        let depends_on = t["depends_on"].as_i64().unwrap_or(0).max(0);
        let continue_agent = t["continue_worker"].as_i64().or_else(|| t["continue_agent"].as_i64()).unwrap_or(0).max(0);
        let project = s(&t["project"]).trim().to_string();
        ops::touch_project(self, &project, &nodes);
        let tid = self.db.run(
            "insert into tasks(request_id, project, title, quote, nodes, level, every, depends_on, continue_agent, at, updated) values(?,?,?,?,?,?,?,?,?,?,?)",
            args!(request, project, s(&t["title"]), s(&t["quote"]), nodes, level, every, depends_on, continue_agent, now(), now()),
        );
        let requester = self.db.get("select agent from requests where id=?", args!(request)).map(|r| s(&r["agent"])).unwrap_or_default();
        if !requester.is_empty() {
            let agent = self.agent_for_session(&requester, tid);
            self.db.run("update tasks set agent_id=?, status='working' where id=?", args!(agent, tid));
        }
        self.log(0, tid, request, "hive", &format!("New task #{tid}: {}", s(&t["title"])));
        self.bump();
        tid
    }

    fn agent_for_session(&self, name: &str, task: i64) -> i64 {
        if let Some(a) = self.db.get("select id from agents where kind='claude' and name=?", args!(name)) {
            let id = a["id"].as_i64().unwrap_or(0);
            self.db.run("update agents set task_id=?, role='external', status='working', updated=? where id=?", args!(task, now(), id));
            return id;
        }
        self.db.run("insert into agents(task_id, kind, role, name, status, at, updated) values(?, 'claude', 'external', ?, 'working', ?, ?)",
            args!(task, name, now(), now()))
    }

    /// Schedule a one-shot or repeating (`every_hours > 0`) harness retrospective task using Hive's existing task loop.
    pub fn start_retrospective(self: &Arc<Self>, every_hours: i64) -> i64 {
        self.start_retrospective_mode(every_hours, false, "manual")
    }

    fn start_retrospective_mode(self: &Arc<Self>, every_hours: i64, subtract: bool, reason: &str) -> i64 {
        let quote = if subtract {
            format!("Run a Build-to-Delete harness retrospective ({reason}): call sim(mode=\"read\") to inspect dead/low-use tools, old-model SIM ablation candidates, rule scope bloat, and largest files. Target a net-negative LOC commit that deletes dead code, consolidates duplicates, or ablates obsolete workarounds without weakening tests, verify with reinstall, and record SIM outcome.")
        } else {
            format!("Run a harness retrospective ({reason}): call sim(mode=\"read\") to inspect recent friction, raw failure traces, and SIM; fix the highest-impact recurring harness failure (preferring simplification/deletion over adding code), verify with reinstall, and record SIM outcome.")
        };
        let rid = self.db.run("insert into requests(at, node, agent, text, context, status, reply) values(?, 'hive', '', ?, '{}', 'planned', 'Started harness retrospective.')",
            args!(now(), quote));
        let nodes = if self.repo.is_some() { json!(["hive", "vm"]) } else { json!(["hive"]) };
        self.add_task(rid, &json!({
            "title": "Harness retrospective", "quote": quote, "project": "hive",
            "nodes": nodes, "level": "hard", "every": every_hours.max(0),
        }))
    }

    /// Actively trigger a Harness retrospective when Hive has a local repo checkout and either:
    /// - Friction spike: >=12h since last retro AND (>=4 needs/dropped tasks or >=5 gate/timeout events in last 24h)
    /// - Cadence: >=24h since last retro AND >=20 completed tasks since last retro
    /// Alternates between friction-fix passes and explicit net-negative LOC subtraction/ablation passes.
    fn maybe_retrospective(self: &Arc<Self>) -> Option<i64> {
        if self.repo.is_none() { return None; }
        let active = self.db.get("select 1 from tasks where title='Harness retrospective' and status in ('open','queued','working','needs') limit 1", &[]).is_some();
        if active { return None; }
        let last_at = self.db.get("select coalesce(max(updated),0) as at from tasks where title='Harness retrospective'", &[])
            .and_then(|r| r["at"].as_i64()).unwrap_or(0);
        let since_last = now().saturating_sub(last_at);
        let since_24h = now() - 86_400_000;
        let bad_24h = self.db.get("select count(*) as n from tasks where status in ('needs','dropped') and coalesce(quote,'')!='Imported session' and updated>=?", args!(since_24h))
            .and_then(|r| r["n"].as_i64()).unwrap_or(0);
        let gate_24h = self.db.get("select count(*) as n from log where who='gate' and at>=?", args!(since_24h))
            .and_then(|r| r["n"].as_i64()).unwrap_or(0);
        let timeout_24h = self.db.get("select count(*) as n from calls where status='timeout' and at>=?", args!(since_24h))
            .and_then(|r| r["n"].as_i64()).unwrap_or(0);
        let done_since = self.db.get("select count(*) as n from tasks where status='done' and title!='Harness retrospective' and updated>?", args!(last_at))
            .and_then(|r| r["n"].as_i64()).unwrap_or(0);
        let reason = if since_last >= 12 * 3_600_000 && (bad_24h >= 4 || gate_24h + timeout_24h >= 5) {
            format!("auto friction spike: {bad_24h} needs/dropped, {gate_24h} gates, {timeout_24h} timeouts in 24h")
        } else if since_last >= 24 * 3_600_000 && done_since >= 20 {
            format!("auto cadence: {done_since} tasks completed since last retrospective")
        } else {
            return None;
        };
        let past_retros = self.db.get("select count(*) as n from tasks where title='Harness retrospective'", &[])
            .and_then(|r| r["n"].as_i64()).unwrap_or(0);
        Some(self.start_retrospective_mode(0, past_retros % 2 == 1, &reason))
    }

    // ---- agents ----

    fn instructions(&self, task: &Value) -> String {
        let nodes = self.task_kinds(task);
        let req = self.db.get("select * from requests where id=?", args!(task["request_id"].clone())).unwrap_or(json!({}));
        let ctx: Value = serde_json::from_str(&s(&req["context"])).unwrap_or(json!({}));
        let project = s(&task["project"]).trim().to_string();
        let (site, app, folder) = (s(&ctx["site"]), s(&ctx["app"]), s(&ctx["folder"]));
        let mut t = format!("{}\n\nYour task: #{} {}\nThe owner's words: \"{}\"\nThe whole request (from {}): {}\n",
            self.prompt("worker").unwrap_or_default(), task["id"], s(&task["title"]), s(&task["quote"]), s(&req["node"]), s(&req["text"]));
        if !project.is_empty() { t += &format!("Project: {project}\n"); }
        for entry in self.db.all("select who, text from log where task_id=? and who='owner' order by id", args!(task["id"].clone())) {
            t += &format!("\nOwner follow-up: {}\n", s(&entry["text"]));
        }
        for m in self.db.all("select from_task, kind, text from messages where to_task=? and kind!='inbox' order by id limit 10", args!(task["id"].clone())) {
            t += &format!("\nHandoff [{}] from task #{}: {}\n", s(&m["kind"]), m["from_task"], s(&m["text"]));
        }
        if !ctx.as_object().map(|o| o.is_empty()).unwrap_or(true) { t += &format!("Its context: {ctx}\n"); }
        if !project.is_empty() {
            let sum = self.db.get("select summary from projects where lower(slug)=lower(?)", args!(project.clone()))
                .map(|r| s(&r["summary"])).unwrap_or_default();
            if !sum.is_empty() { t += &format!("\nProject summary: {sum}\n"); }
            let recent_done = self.db.all("select id, title, outcome from tasks where lower(project)=lower(?) and status='done' and id!=? order by id desc limit 2",
                args!(project.clone(), task["id"].clone()));
            if !recent_done.is_empty() {
                t += "\nRecent completed tasks in this project (historical evidence, not standing rules):\n";
                for r in recent_done.iter().rev() {
                    t += &format!("- #{} {}: {}\n", r["id"], s(&r["title"]), short(&s(&r["outcome"]), 240));
                }
            }
            let recent_followups = self.db.all("select l.task_id, l.text from log l join tasks t on t.id=l.task_id where lower(t.project)=lower(?) and t.id!=? and l.who='owner' order by l.id desc limit 3",
                args!(project.clone(), task["id"].clone()));
            if !recent_followups.is_empty() {
                t += "Recent owner follow-ups in this project:\n";
                for f in recent_followups.iter().rev() {
                    t += &format!("- (on #{}) {}\n", f["task_id"], short(&s(&f["text"]), 240));
                }
            }
        }
        t += "\nUse `memory` (Tier 1 profile/contacts, Tier 2 verified site playbooks) and `history` on demand. Use `handoff` for bounded coordination with a peer worker in the same project, and `request_help` if you need an extra node capability or orchestrator help.\n";
        t += "\nThe owner's rules (scoped to this task; follow every one):\n";
        for r in self.db.all("select id, text, scope from rules where active=1 and (code is null or code='') order by id", &[]) {
            let scope = s(&r["scope"]);
            if !scope_applies(&scope, &nodes, &site, &app, &folder, &project) { continue; }
            t += &if scope.is_empty() { format!("- R{} {}\n", r["id"], s(&r["text"])) } else { format!("- R{} [{scope}] {}\n", r["id"], s(&r["text"])) };
        }
        if nodes.iter().any(|n| n == "browser") {
            let mut hosts = Vec::new();
            if !site.is_empty() { hosts.push(crate::memory::normalize_host(&site)); }
            for h in crate::memory::extract_hosts(&format!("{} {} {}", s(&task["title"]), s(&task["quote"]), s(&req["text"]))) {
                if !hosts.contains(&h) { hosts.push(h); }
            }
            let mut matched = Vec::new();
            for h in hosts {
                for p in crate::memory::playbooks_for_host(&self.db, &h) {
                    if !matched.iter().any(|m: &Value| m["id"] == p["id"]) { matched.push(p); }
                }
            }
            let hint = crate::memory::format_playbooks_hint(&matched);
            if !hint.is_empty() {
                t += &format!("\nVerified site playbook(s) (Tier 2 — call memory(action='report_playbook', id=..., ok=false) if outdated):\n{hint}\n");
            }
        }
        t += "\nWhere you work:\n";
        let has_vm = nodes.iter().any(|n| n == "vm" || n == "hive");
        let has_hive = nodes.iter().any(|n| n == "hive");
        if has_vm {
            match &self.repo {
                Some(_) => { t += VM_NOTES; }
                None => t += &format!("- The computer Hive runs on, the owner's own (you run as their user): your shell. Hive's files (shared \
                    with the dashboard and nodes) are in {}.", self.state.join("files").display()),
            }
        }
        if has_hive {
            if let Some(repo) = &self.repo {
                t += &format!("\n- Hive's own code: the git checkout at {}; README.md maps it. Other workers work in it at the same time: \
                    lock the files you'll change (lock) before you edit them, never edit one another worker holds, and commit only your own \
                    (git commit -m <message> -- <files>). Keep it lean. Commit locally with a clear message, then call reinstall. \
                    NEVER push directly to club `main` from an automated self-improvement: keep owner-specific changes local, and when an improvement \
                    generalizes to the majority of club members and saves everyone time, push a feature branch (`git push origin HEAD:hive/<slug>`) and open a \
                    draft PR (`gh pr create --draft`) with an anonymized `sim(mode=\"export\")` entry, test counts, and net-LOC delta for club review.", repo.display());
            }
        }
        for n in self.db.all("select kind, notes from nodes order by seen desc", &[]) {
            if nodes.contains(&s(&n["kind"])) && !s(&n["notes"]).is_empty() { t += &format!("\n- {}", s(&n["notes"])); }
        }
        if has_hive {
            t += &format!("\n\n{}\n\nCurrent SIM:\n{}", sim::PROTOCOL, sim::format(&self.db, self.repo.as_deref()));
        }
        t
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
        let (model, effort) = self.model_for(&s(&task["level"]));
        let on_claude = matches!(self.engine, Engine::Claude { .. });
        let kind = if on_claude { CLAUDE_AGENT } else { "codex" };
        // Fresh isolated worker by default. Reuse an existing worker only when explicitly bound or when
        // the orchestrator requested `continue_agent` for tightly coupled follow-up work.
        let owner = task["agent_id"].as_i64().or_else(|| {
            let cont = task["continue_agent"].as_i64().unwrap_or(0);
            (cont > 0 && self.db.get("select 1 from agents where id=? and kind=?", args!(cont, kind)).is_some() && self.ready_for_task(cont))
                .then_some(cont)
        });
        let agent = if let Some(agent) = owner {
            self.db.run("update tasks set agent_id=?, status='queued' where id=?", args!(agent, task_id));
            if !self.ready_for_task(agent) { self.bump(); return; }
            if let Some(c) = self.claudes.lock().unwrap().remove(&agent) { c.close(); }
            self.db.run("update agents set task_id=?, thread=null, tools='', status='working', updated=?, model=?, effort=? where id=?", args!(task_id, now(), model, effort, agent));
            agent
        } else {
            self.db.run("insert into agents(task_id, kind, role, name, status, at, updated, model, effort) values(?, ?, 'worker', ?, 'working', ?, ?, ?, ?)",
                args!(task_id, kind, short(&s(&task["title"]), 60), now(), now(), model, effort))
        };
        self.db.run("update tasks set agent_id=?, status='working', updated=? where id=?", args!(agent, now(), task_id));
        let result = if on_claude { self.claude_turn(agent, "Start on your task now.") }
            else { self.new_thread(agent, &task).and_then(|_| self.start_turn_with(agent, "Start on your task now.", effort)) };
        if let Err(e) = result {
            self.db.run("update tasks set status='needs', why=?, need=?, updated=? where id=?",
                args!(format!("Hive couldn't start a worker: {e}"), format!("Nothing from you if {} comes back by itself; send the task a message to retry.",
                    if on_claude { "Claude Code" } else { "Codex" }), now(), task_id));
            self.db.run("update agents set status='idle' where id=?", args!(agent));
            self.log(agent, task_id, 0, "hive", &format!("Couldn't start the worker: {e}"));
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
        self.start_turn_with(agent, text, self.model_for(&level).1)
    }

    /// A Codex thread for an agent, with the task's instructions and its devices' tools as they are now.
    fn new_thread(self: &Arc<Self>, agent: i64, task: &Value) -> Result<String, String> {
        let (model, _) = self.model_for(&s(&task["level"]));
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
        let a = self.db.get("select * from agents where id=?", args!(agent)).ok_or("no such agent")?;
        if s(&a["kind"]) == "claude" {
            self.db.run("update tasks set status='idle', why=null, need=null, updated=? where id=? and status in ('needs','done','dropped')", args!(now(), task_id));
            self.db.run("insert into messages(at, from_agent, from_task, to_agent, to_task, kind, hops, text, seen) values(?,0,0,?,?,'inbox',1,?,0)",
                args!(now(), agent, task_id, format!("From {from} about task #{task_id}: {text}")));
            self.bump();
            return Ok(());
        }
        if matches!(s(&task["status"]).as_str(), "needs" | "done" | "dropped") {
            self.db.run("update tasks set status='working', why=null, need=null, updated=? where id=?", args!(now(), task_id));
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

    /// A task waiting behind another agent's work starts now: Hive's loop gives it a free agent, or a new one.
    pub fn start_now(&self, task_id: i64) -> Result<(), String> {
        let _assignment = self.assignments.lock().unwrap();
        let t = self.db.get("select status from tasks where id=?", args!(task_id)).ok_or("there's no such task")?;
        if s(&t["status"]) != "queued" { return Err(format!("it's {}, not waiting", s(&t["status"]))); }
        self.db.run("update tasks set agent_id=null, status='open', updated=? where id=?", args!(now(), task_id));
        self.bump();
        Ok(())
    }

    pub fn drop_task(self: &Arc<Self>, task_id: i64) {
        let Some(task) = self.db.get("select status from tasks where id=?", args!(task_id)) else { return };
        if !matches!(s(&task["status"]).as_str(), "open" | "queued" | "working" | "needs" | "idle") { return; }
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
        self.db.save_usage(thread, agent, usage);
    }

    fn record_evidence(&self, agent: i64, edited: bool, failed: Option<String>) {
        if agent <= 0 { return; }
        let mut map = self.evidence.lock().unwrap();
        let ev = map.entry(agent).or_default();
        if edited { ev.edited = true; }
        else if let Some(err) = failed { ev.last_failed = Some(err); }
        else { ev.last_failed = None; ev.edited = false; }
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
                let item_type = s(&item["type"]);
                if method == "item/completed" {
                    if item_type == "commandExecution" {
                        let failed = item["exitCode"].as_i64().is_some_and(|c| c != 0) || s(&item["status"]) == "failed";
                        self.record_evidence(agent, false, failed.then(|| short(&format!("$ {} {}", s(&item["command"]), s(&item["aggregatedOutput"])), 200)));
                    } else if item_type == "fileChange" {
                        self.record_evidence(agent, true, None);
                    }
                }
                let line = match item_type.as_str() {
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
        let done_gate = end.as_ref().and_then(|e| {
            let mut map = self.evidence.lock().unwrap();
            let ev = map.entry(agent).or_default();
            let hit = gate_completion(e, ev);
            if hit.is_some() { ev.done_checks += 1; }
            hit
        });
        match (end, done_gate) {
            // Execution-verified completion gate: reject done=true once if the last action failed or edits went unverified.
            (Some(_), Some((tag, msg))) => {
                self.log(agent, task, 0, "gate", tag);
                let me = self.clone();
                std::thread::spawn(move || { me.start_turn(agent, &msg).ok(); });
            }
            // Before a stop reaches the owner, the agent checks once that it's truly theirs and not a tool falling short.
            (Some(e), None) if e["done"] != true && self.rechecked.lock().unwrap().insert(agent) => {
                self.log(agent, task, 0, "gate", "done:false recheck");
                let me = self.clone();
                std::thread::spawn(move || { me.start_turn(agent, &me.stop_recheck(task)).ok(); });
            }
            (Some(e), None) if self.finish(agent, task, &e) => {}
            _ => {
                let n = { let mut m = self.nudges.lock().unwrap(); let e = m.entry(agent).or_insert(0); *e += 1; *e };
                if n <= 2 {
                    self.log(agent, task, 0, "gate", "missing structured end_turn");
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

    /// Refresh discovery context at the existing bounded stop gate, without granting tools.
    fn stop_recheck(&self, task: i64) -> String {
        let mut text = format!("{RECHECK}\nGranted node kinds: {}.\nConnected-node inventory:", self.task_kinds(&self.db.get("select nodes from tasks where id=?", args!(task)).unwrap_or_default()).join(", "));
        for node in self.db.all("select id, kind, coalesce(display_name,name) as name, seen from nodes order by kind", &[]) {
            text += &format!("\n- {} ({}, {}): {}", s(&node["name"]), s(&node["kind"]), s(&node["id"]),
                if node_online(&node) { "online" } else { "offline" });
        }
        text
    }

    /// A task ended: done with the outcome, or needs the owner (exact why and need). False if it says neither.
    fn finish(&self, agent: i64, task: i64, e: &Value) -> bool {
        let info = self.db.get("select project, title from tasks where id=?", args!(task)).unwrap_or(json!({}));
        let (project, title) = (s(&info["project"]), s(&info["title"]));
        if e["done"] == true {
            let outcome = s(&e["outcome"]);
            self.db.run("update tasks set status='done', outcome=?, updated=? where id=?", args!(outcome, now(), task));
            self.db.run("update agents set status='done', updated=? where id=?", args!(now(), agent));
            self.log(agent, task, 0, "done", &outcome);
            ops::record_project_outcome(self, &project, task, &title, &outcome);
            self.log(0, task, 0, "worker", &format!("Task #{task} ({title}) done: {}", short(&outcome, 240)));
        } else if !s(&e["why"]).trim().is_empty() && !s(&e["need"]).trim().is_empty() {
            let (why, need) = (s(&e["why"]), s(&e["need"]));
            self.db.run("update tasks set status='needs', why=?, need=?, updated=? where id=?", args!(why, need, now(), task));
            self.db.run("update agents set status='idle', updated=? where id=?", args!(now(), agent));
            self.log(agent, task, 0, "needs you", &format!("{why} Needs: {need}"));
            self.log(0, task, 0, "worker", &format!("Task #{task} ({title}) needs owner: {}", short(&need, 200)));
        } else {
            return false;
        }
        self.nudges.lock().unwrap().remove(&agent);
        self.rechecked.lock().unwrap().remove(&agent);
        self.evidence.lock().unwrap().remove(&agent);
        self.bump();
        true
    }

    /// An external session says how its task ended.
    pub fn end_task(&self, task: i64, e: &Value) -> Result<(), String> {
        let agent = self.db.get("select agent_id from tasks where id=?", args!(task)).and_then(|r| r["agent_id"].as_i64()).ok_or(format!("there's no task #{task} with an agent"))?;
        if self.finish(agent, task, e) { Ok(()) } else { Err("Say done with the outcome, or needs with exactly why and what the owner must do.".into()) }
    }

    // ---- locks: tools that share a lock are used by one agent at a time ----

    pub(crate) fn take_lock(&self, name: &str, agent: i64) -> Result<(), String> {
        let got = self.wait_until(120_000, || {
            let mut l = self.locks.lock().unwrap();
            match l.get(name) {
                Some((holder, _)) if *holder != agent => None,
                _ => { l.insert(name.to_string(), (agent, now())); Some(()) }
            }
        });
        got.ok_or_else(|| {
            let holder = self.locks.lock().unwrap().get(name).map(|x| x.0).unwrap_or(0);
            format!("The {name} is in use by task {}; it frees up when that worker's turn ends. Try again, or handoff to that task.", self.holder(holder))
        })
    }

    /// "#12 Its title": the task an agent is on, for lock messages.
    fn holder(&self, agent: i64) -> String {
        self.db.get("select t.id, t.title from agents a join tasks t on t.id=a.task_id where a.id=?", args!(agent))
            .map(|r| format!("#{} {}", r["id"], s(&r["title"]))).unwrap_or_default()
    }

    /// Lock files in Hive's checkout for a worker, all or none: workers share the checkout, and none edits a file another holds.
    fn lock_files(&self, files: &[String], agent: i64) -> Result<Value, String> {
        let root = self.repo.as_ref().map(|r| format!("{}/", r.display())).unwrap_or_default();
        let files: Vec<String> = files.iter().map(|f| f.trim().strip_prefix(root.as_str()).unwrap_or(f.trim()).trim_start_matches("./").to_string())
            .filter(|f| !f.is_empty()).collect();
        if files.is_empty() { return Err("Name the files to lock.".into()); }
        let mut locks = self.locks.lock().unwrap();
        if let Some((file, holder)) = files.iter().find_map(|f| locks.get(&format!("file {f}")).filter(|h| h.0 != agent).map(|h| (f.clone(), h.0))) {
            drop(locks);
            return Err(format!("{file} is locked by task {}; it frees up when that worker's turn ends. Wait and lock it again, or handoff to that task.", self.holder(holder)));
        }
        for f in &files { locks.insert(format!("file {f}"), (agent, now())); }
        drop(locks);
        self.bump();
        Ok(json!(format!("Locked {}. No other worker can lock them until your turn ends.", files.join(", "))))
    }

    /// An agent's turn ended: its locks go. A Mac whose own pointer and keyboard it may have had goes back to the owner first, and
    /// its lock with it (unless the agent's next turn has used the Mac since).
    fn release_all(self: &Arc<Self>, agent: i64) {
        let (t0, mut macs) = (now(), vec![]);
        self.locks.lock().unwrap().retain(|lock, v| {
            if v.0 != agent { return true; }
            let mac = lock.strip_suffix(" input").and_then(|id| self.db.get("select * from nodes where id=? and kind='mac'", args!(id)));
            mac.map(|node| macs.push((lock.clone(), node))).is_some()
        });
        for (lock, node) in macs {
            let me = self.clone();
            std::thread::spawn(move || {
                me.call_node(&node, "mac_hand_back", &json!({}), agent, 30).ok();
                me.locks.lock().unwrap().retain(|l, v| !(*l == lock && v.0 == agent && v.1 <= t0));
                me.bump();
            });
        }
        self.bump();
    }

    pub fn locks(&self) -> Value {
        json!(self.locks.lock().unwrap().iter().map(|(k, v)| json!({ "lock": k, "agent": v.0, "since": v.1 })).collect::<Vec<_>>())
    }

    // ---- devices: each declares its tools; calls wait in the calls table until the device takes and answers them ----

    /// The device kinds Hive knows, for the orchestrator.
    pub(crate) fn kinds(&self) -> Vec<String> {
        let mut k = vec!["vm".to_string()];
        if self.repo.is_some() { k.push("hive".into()); }
        k.extend(self.db.all("select distinct kind from nodes order by kind", &[]).iter().map(|r| s(&r["kind"])));
        k
    }

    /// Strictly the node kinds granted to this task (defaulting to ["vm"] when unspecified).
    /// Keeps every worker's tool catalog lean (<15 tools) and enforces least privilege.
    fn task_kinds(&self, task: &Value) -> Vec<String> {
        let kinds = list(&task["nodes"]);
        if kinds.is_empty() { vec!["vm".into()] } else { kinds }
    }

    /// Tools a worker on these granted node kinds gets: core worker tools + strictly those devices' tools.
    fn tools_for(&self, kinds: &[String]) -> Vec<Value> {
        const HIDDEN: &[&str] = &["browser_type_password", "mac_type_password", "windows_type_password", "mac_hand_back", "mac_restore_phone_passcode"];
        let mut out: Vec<Value> = tools::worker(kinds);
        let mut names: HashSet<String> = out.iter().map(|t| s(&t["name"])).collect();
        for n in self.db.all("select kind, tools from nodes order by seen desc", &[]) {
            if !kinds.contains(&s(&n["kind"])) { continue; }
            for mut t in list_values(&n["tools"]) {
                let name = s(&t["name"]);
                if HIDDEN.contains(&name.as_str()) { continue; }
                if n["kind"] == "browser" {
                    t["inputSchema"]["properties"]["browser"] = json!({"type":"string", "description":"Browser device ID from browser_devices. Required when several browsers are online; use the same ID for every call involving its tabs."});
                }
                if names.insert(name) { out.push(t); }
            }
        }
        out
    }

    /// The device that declared this tool (the most recently seen one), and its declaration.
    fn device_for(&self, tool: &str) -> Option<(Value, Value)> {
        self.db.all("select id, kind, coalesce(display_name,name) as name, seen, tools from nodes order by seen desc", &[]).into_iter()
            .find_map(|n| list_values(&n["tools"]).into_iter().find(|t| t["name"] == tool).map(|t| (n.clone(), t)))
    }

    pub fn call_node(&self, node: &Value, tool: &str, args: &Value, agent: i64, secs: u64) -> Result<Value, String> {
        let (id, kind) = (s(&node["id"]), s(&node["kind"]));
        if id == PHONE_ID && !hive_phone::connected() {
            return Err("The iPhone is offline. Hive Phone needs to be open and connected before phone tools can run.".into());
        }
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

    // ---- tool calls from agents (orchestrator read-only tools + worker scoped tools) ----

    fn run_orchestrator_tool(&self, name: &str, a: &Value) -> (bool, String, Vec<String>) {
        let res: Result<String, String> = match name {
            "inspect" => ops::inspect(self, &s(&a["kind"]), a["id"].as_i64().unwrap_or(0), &s(&a["name"]))
                .map(|v| serde_json::to_string(&v).unwrap_or_default()),
            "history" => {
                let before = a["before"].as_i64().filter(|n| *n > 0).unwrap_or(i64::MAX);
                Ok(serde_json::to_string(&self.history(&s(&a["query"]), &s(&a["project"]), before, 10)).unwrap_or_default())
            }
            "info" => ops::info(self, &s(&a["key"]), &s(&a["value"])),
            "memory" => ops::memory(self, a).map(|v| serde_json::to_string(&v).unwrap_or_default()),
            _ => Err(format!("Orchestrator agent is read-only for tool '{name}'; delegate execution to a worker.")),
        };
        match res {
            Ok(text) => (true, text, vec![]),
            Err(err) => (false, err, vec![]),
        }
    }

    fn tool(self: &Arc<Self>, params: &Value) -> Value {
        let name = s(&params["tool"]);
        let a = &params["arguments"];
        let tid = s(&params["threadId"]);
        if self.watchers.lock().unwrap().contains_key(&tid) {
            let (ok, text, images) = self.run_orchestrator_tool(&name, a);
            return tool_result(ok, &text, &images);
        }
        let agent_row = self.db.get("select * from agents where thread=?", args!(tid)).unwrap_or(json!({}));
        let (agent, task) = (agent_row["id"].as_i64().unwrap_or(0), agent_row["task_id"].as_i64().unwrap_or(0));
        let (ok, text, images) = self.run_tool(&name, a, agent, task);
        tool_result(ok, &text, &images)
    }

    /// Cap large inline tool outputs (Context Rot prevention): spill >6,000 chars to files/ and return preview + path.
    fn cap_tool_output(&self, name: &str, text: String) -> String {
        let chars = text.chars().count();
        if chars <= 6_000 { return text; }
        let path = self.save_file(&format!("{name}-output.txt"), text.as_bytes(), "tool");
        let preview: String = text.chars().take(5_000).collect();
        format!("{preview}\n\n[Output truncated: full {chars} chars saved at {}. Inspect with shell/grep/head/tail if needed.]", path.display())
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
                if name != "sim" { self.record_evidence(agent, false, None); }
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
                let raw = if v.is_string() { s(&v) } else { s(&v["text"]) };
                let text = self.cap_tool_output(name, raw);
                record("completed", &text);
                (true, text, images)
            }
            Ok(v) => {
                let err = s(&v["error"]);
                if name != "sim" { self.record_evidence(agent, false, Some(format!("{name}: {}", short(&err, 200)))); }
                record("failed", &err);
                (false, err, vec![])
            }
            Err(e) => {
                if name != "sim" { self.record_evidence(agent, false, Some(format!("{name}: {}", short(&e, 200)))); }
                record("failed", &e);
                (false, e, vec![])
            }
        }
    }

    // ---- Claude Code agents (claude.rs): a process per worker while it works, its tools over MCP ----

    /// A message into a Claude worker's process (a steer mid-turn, else a new turn), starting the process if it isn't running.
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
        let task = self.db.get("select * from tasks where id=?", args!(a["task_id"].clone())).ok_or("the worker has no task")?;
        let (model, effort) = self.model_for(&s(&task["level"]));
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

    /// What a Claude worker's process said (None: it exited), as note() does for Codex's.
    fn claude_out(self: &Arc<Self>, agent: i64, c: &Claude, out: Option<Out>) {
        use std::sync::atomic::Ordering::SeqCst;
        let task = self.db.get("select task_id from agents where id=?", args!(agent)).and_then(|r| r["task_id"].as_i64()).unwrap_or(0);
        match out {
            Some(Out::Session(id)) => { self.db.run("update agents set thread=? where id=?", args!(id, agent)); }
            Some(Out::Command { text, failed }) => {
                self.record_evidence(agent, false, failed.then(|| short(&text, 200)));
                if !text.is_empty() { self.log(agent, task, 0, "command", &text); }
            }
            Some(Out::Log(who, text)) => {
                if who == "files" { self.record_evidence(agent, true, None); }
                if !text.is_empty() { self.log(agent, task, 0, who, &text); }
            }
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

    /// An MCP message from a Claude agent's process (agent=0 is the orchestrator; >0 is a worker), signed in by its secret.
    pub fn mcp(self: &Arc<Self>, token: &str, m: &Value) -> Result<Option<Value>, String> {
        let agent = self.mcp.lock().unwrap().get(token).copied().ok_or("no such agent")?;
        if agent == 0 {
            let tools = || tools::orchestrator().iter().map(tools::for_mcp).collect::<Vec<_>>();
            return Ok(hive_protocol::mcp::answer(m, "", tools, |name, a| self.run_orchestrator_tool(name, a)));
        }
        let task = self.db.get("select t.* from agents a join tasks t on t.id=a.task_id where a.id=?", args!(agent)).unwrap_or(json!({}));
        let tid = task["id"].as_i64().unwrap_or(0);
        let tools = || {
            let mut t: Vec<Value> = self.tools_for(&self.task_kinds(&task)).iter().map(tools::for_mcp).collect();
            t.push(crate::claude::end_turn());
            t
        };
        Ok(hive_protocol::mcp::answer(m, "", tools, |name, a| {
            if name != "end_turn" { return self.run_tool(name, a, agent, tid); }
            // What a Codex worker's final message would be: after_turn reads it when the turn's result comes.
            let end = json!({ "done": a["done"], "outcome": s(&a["outcome"]), "why": s(&a["why"]), "need": s(&a["need"]) });
            if !a["done"].is_boolean() { return (false, "Give done (true or false), with the outcome, or why and need.".into(), vec![]); }
            self.last.lock().unwrap().insert(agent, end.to_string());
            (true, "Recorded. End your turn now.".into(), vec![])
        }))
    }

    fn require_node(&self, task: i64, node: &str) -> Result<(), String> {
        if task <= 0 { return Ok(()); }
        let Some(trow) = self.db.get("select nodes from tasks where id=?", args!(task)) else { return Ok(()); };
        if self.task_kinds(&trow).iter().any(|k| k == node) { return Ok(()); }
        Err(format!("Task #{task} is not granted node '{node}'. Call request_help(kind=\"capability\", node=\"{node}\", ...) to ask the orchestrator."))
    }

    fn tool_inner(self: &Arc<Self>, name: &str, a: &Value, agent: i64, task: i64) -> Result<Value, String> {
        let actor = if agent == 0 && task == 0 { Actor::orchestrator() } else { Actor::worker(agent, task) };
        match name {
            "inspect" => {
                if !actor.is_control_plane() { return Err("Only the orchestrator agent can call inspect; workers use history or request_help.".into()); }
                return ops::inspect(self, &s(&a["kind"]), a["id"].as_i64().unwrap_or(0), &s(&a["name"]))
                    .map(|v| json!(serde_json::to_string(&v).unwrap_or_default()));
            }
            "browser_devices" => {
                self.require_node(task, "browser")?;
                return Ok(json!(serde_json::to_string(&self.db.all("select id, coalesce(display_name,name) as name, seen from nodes where kind='browser' order by seen desc", &[])).unwrap()));
            }
            "handoff" => {
                let to = a["task"].as_i64().ok_or("give the task id")?;
                return ops::handoff(self, actor, to, &s(&a["kind"]), &s(&a["text"])).map(|m| json!(m));
            }
            "request_help" => {
                return ops::request_help(self, actor, &s(&a["kind"]), &s(&a["text"]), &s(&a["node"])).map(|m| json!(m));
            }
            "history" => {
                let before = a["before"].as_i64().filter(|n| *n > 0).unwrap_or(i64::MAX);
                let rows = self.history(&s(&a["query"]), &s(&a["project"]), before, 10);
                return Ok(json!(serde_json::to_string(&rows).unwrap()));
            }
            "info" => return ops::info(self, &s(&a["key"]), &s(&a["value"])).map(|m| json!(m)),
            "memory" => return ops::memory(self, a).map(|v| json!(serde_json::to_string(&v).unwrap_or_default())),
            "type_password" => {
                let kind = match s(&a["kind"]).trim().to_ascii_lowercase().as_str() {
                    "" | "login" => "login",
                    "card" => "card",
                    other => return Err(format!("kind must be 'login' or 'card', got '{other}'")),
                };
                let (site, user, tool, field) = (s(&a["site"]), s(&a["username"]), s(&a["tool"]), s(&a["field"]));
                if kind == "card" {
                    if a["confirmed"] != true {
                        return Err("Payment card entry is a one-way door: confirm the item, total amount, and card with the owner first, then retry with confirmed=true.".into());
                    }
                    if field.trim().is_empty() {
                        return Err("Give field (number | exp | cvv | zip | cardholder) when kind='card'.".into());
                    }
                }
                if tool.is_empty() {
                    return if kind == "card" { crate::vm::type_card_field(&site, &field).map(|m| json!(m)) }
                        else { crate::vm::type_password(&site, &user).map(|m| json!(m)) };
                }
                let target = match tool.as_str() {
                    "browser_type" => "browser_type_password",
                    "mac_type" | "mac_input" => "mac_type_password",
                    "windows_type" | "windows_input" => "windows_type_password",
                    _ => return Err("tool must be browser_type, mac_type/mac_input, or windows_type/windows_input".into()),
                };
                let mut args = serde_json::from_str::<Value>(&s(&a["args"])).ok().filter(Value::is_object).unwrap_or(json!({}));
                args["kind"] = json!(kind); args["site"] = json!(site); args["username"] = json!(user); args["field"] = json!(field);
                let r = self.tool_inner(target, &args, agent, task)?;
                return Ok(if r["error"].is_null() {
                    if kind == "card" { json!(format!("Typed saved card '{}' field '{field}' with {tool}.", if site.is_empty() { "default" } else { &site })) }
                    else { json!(format!("Typed the saved password for {site} with {tool}.")) }
                } else { r });
            }
            "lock" => return self.lock_files(&list(&a["files"]), agent),
            "sim" => {
                self.require_node(task, "hive")?;
                return ops::sim_op(self, actor, a);
            }
            "reinstall" => {
                self.require_node(task, "hive")?;
                return ops::reinstall(self, actor, a["sim_id"].as_i64().unwrap_or(0))
                    .map(|r| json!(r.message))
                    .map_err(|(_, _, _, e)| e);
            }
            "rule" => return ops::add_rule(self, &s(&a["text"]), &s(&a["quote"]), &s(&a["scope"])).map(|r| json!(format!("Saved as R{r}."))),
            "page_code" => {
                self.require_node(task, "browser")?;
                return ops::set_page_code(self, a["rule"].as_i64().unwrap_or(0), &s(&a["css"]), &s(&a["js"])).map(|m| json!(m));
            }
            _ => {}
        }
        if actor.role == Role::Orchestrator {
            return Err(format!("Orchestrator agent cannot invoke execution tool '{name}'; dispatch a worker instead."));
        }
        let selected = a["browser"].as_str().filter(|id| !id.is_empty());
        let internal_kind = match name {
            "browser_type_password" => Some("browser"),
            "mac_type_password" | "mac_hand_back" => Some("mac"),
            "windows_type_password" => Some("windows"),
            _ => None,
        };
        let (node, decl) = if name.starts_with("browser_") {
            let devices = self.db.all("select id, kind, name, seen, tools from nodes where kind='browser' order by seen desc", &[]);
            let cutoff = now() - 90_000;
            let online: Vec<Value> = devices.iter().filter(|n| n["seen"].as_i64().unwrap_or(0) > cutoff).cloned().collect();
            if selected.is_none() && online.len() > 1 {
                return Err("Choose a browser device ID with browser_devices and pass browser on every call; tab IDs belong to that browser.".into());
            }
            let pool = if selected.is_some() || online.is_empty() { devices } else { online };
            pool.into_iter().filter(|n| selected.is_none_or(|id| n["id"] == id))
                .find_map(|n| {
                    list_values(&n["tools"]).into_iter().find(|t| t["name"] == name)
                        .or_else(|| internal_kind.map(|_| json!({})))
                        .map(|t| (n, t))
                })
        } else if let Some(kind) = internal_kind {
            self.db.get("select id, kind, name, seen, tools from nodes where kind=? order by seen desc limit 1", args!(kind))
                .map(|n| {
                    let decl = list_values(&n["tools"]).into_iter().find(|t| t["name"] == name).unwrap_or(json!({}));
                    (n, decl)
                })
        } else { self.device_for(name) }.ok_or(format!("Hive has no tool called {name}"))?;
        // Enforce capability boundary at runtime: a worker can only call devices granted to its task.
        self.require_node(task, &s(&node["kind"]))?;
        // Mobile Safari and native touch share the same phone, even with two workers: Safari takes the phone node's touch lock.
        if node["name"] == "Safari on iPhone" { self.take_lock(&format!("{PHONE_ID} touch"), agent)?; }
        // Screenshots change the Mac driver's shared target; takeover changes its
        // permission state. They must own the same lock as keyboard and mouse,
        // including when a connected device advertises an older tool list.
        let mac_input = node["kind"] == "mac" && matches!(name,
            "mac_screenshot" | "mac_take_over" | "mac_input" | "mac_click" | "mac_drag" |
            "mac_scroll" | "mac_key" | "mac_type" | "mac_type_password" | "mac_authenticate");
        if let Some(lock) = if mac_input { Some("input") } else { decl["lock"].as_str() } {
            self.take_lock(&format!("{} {lock}", s(&node["id"])), agent)?;
        }
        // Files cross with the call: vm_path's bytes go to the device, and a file the device sends back lands in Hive's files.
        let mut args = if matches!(name, "browser_type_password" | "mac_type_password" | "windows_type_password") {
            let mut safe = json!({ "kind": s(&a["kind"]), "site": s(&a["site"]), "username": s(&a["username"]), "field": s(&a["field"]) });
            if name == "browser_type_password" { safe["tab"] = a["tab"].clone(); safe["i"] = a["i"].clone(); }
            safe
        } else { a.clone() };
        if let Some(p) = a["vm_path"].as_str() {
            args["data"] = json!(b64::encode(&std::fs::read(p).map_err(|e| format!("couldn't read {p}: {e}"))?));
        }
        let secs = a["timeout"].as_u64().map(|t| t.clamp(1, 1800) + 15).or(decl["timeout"].as_u64()).unwrap_or(120);
        let mut r = self.call_node(&node, name, &args, agent, secs)?;
        if name == "browser_open" && r["error"].is_null() {
            let pbs = crate::memory::playbooks_for_host(&self.db, &s(&a["url"]));
            let hint = crate::memory::format_playbooks_hint(&pbs);
            if !hint.is_empty() {
                for p in &pbs {
                    if let Some(pid) = p["id"].as_i64() { self.db.run("update memory set uses=uses+1 where id=? and tier='playbook'", args!(pid)); }
                }
                let base = r["text"].as_str().map(String::from).unwrap_or_else(|| r.to_string());
                r["text"] = json!(format!("{base}\n\n{hint}"));
            }
        }
        if name == "mac_apple" && r["error"].is_null() {
            let act = s(&a["action"]);
            if matches!(act.as_str(), "delete_reminder" | "delete_event") {
                let ext = s(&a["external_id"]);
                if !ext.is_empty() {
                    self.db.run("update tasks set external_ref='' where external_ref like ?", args!(format!("%:{ext}")));
                }
            } else if task > 0 {
                if let Some(ext) = r["external_id"].as_str().filter(|v| !v.is_empty()) {
                    let kind = r["apple_kind"].as_str().unwrap_or("reminder");
                    self.db.run("update tasks set external_ref=? where id=?", args!(format!("{kind}:{ext}"), task));
                }
            }
        }
        if name == "mac_hand_back" || (name == "mac_input" && a["action"] == "hand_back") {
            let lock = format!("{} input", s(&node["id"]));
            self.locks.lock().unwrap().retain(|l, v| !(*l == lock && v.0 == agent));
            self.bump();
        }
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

/// The final message of every worker turn.
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
    let int = json!({ "type": "integer" });
    json!({
        "type": "object", "additionalProperties": false,
        "required": ["reply", "tasks", "messages", "grant", "rules", "projects", "start", "drop"],
        "properties": {
            "reply": st,
            "tasks": { "type": "array", "items": { "type": "object", "additionalProperties": false,
                "required": ["title", "quote", "nodes", "level", "project", "depends_on", "continue_worker", "every"],
                "properties": { "title": st, "quote": st, "project": st,
                    "nodes": { "type": "array", "items": { "type": "string", "enum": kinds } },
                    "level": { "type": "string", "enum": ["easy", "normal", "hard", "hardest"] },
                    "depends_on": int, "continue_worker": int, "every": int } } },
            "messages": { "type": "array", "items": { "type": "object", "additionalProperties": false, "required": ["task", "text"],
                "properties": { "task": int, "text": st } } },
            "grant": { "type": "array", "items": { "type": "object", "additionalProperties": false, "required": ["task", "nodes"],
                "properties": { "task": int, "nodes": { "type": "array", "items": { "type": "string", "enum": kinds } } } } },
            "rules": { "type": "array", "items": { "type": "object", "additionalProperties": false, "required": ["text", "quote", "scope"],
                "properties": { "text": st, "quote": st, "scope": st } } },
            "projects": { "type": "array", "items": { "type": "object", "additionalProperties": false, "required": ["slug", "title", "summary"],
                "properties": { "slug": st, "title": st, "summary": st } } },
            "start": { "type": "array", "items": int },
            "drop": { "type": "array", "items": int },
        }
    })
}

/// The orchestrator agent's instructions, Hive's own: the owner edits theirs on the dashboard's Instructions tab (Hive::prompt).
pub const PLANNER: &str = include_str!("../orchestrator.md");

/// What a worker that's about to stop for the owner hears first.
const RECHECK: &str = "Before this goes to the owner: is it truly something only they can do (their own decision, a one-way door like \
sending as them, deleting or paying, or their finger or face)? A tool falling short isn't. Missing task information is a discovery problem: search memory and history, then relevant sources \
on every accessible node (such as files, mail, browser sessions or phone apps) before asking the owner to supply it. Search only \
for information needed for this task, verify that any result belongs to the owner and task, and never guess. State which sources \
you checked and which were unavailable if you still cannot find it. If you need an extra device capability not \
granted to this task (such as phone for 2FA, mac, browser, or hive), call request_help(kind=\"capability\", ...) so the orchestrator can \
grant it. Then keep going. If it truly is theirs, end the same way again.";

/// What every worker agent hears first, Hive's own: the owner edits theirs on the dashboard's Instructions tab (Hive::prompt).
pub const WORKER: &str = include_str!("../worker.md");

/// Hive's own instructions by name, which the owner can replace with theirs: the orchestrator agent and worker agents.
pub const PROMPTS: [(&str, &str); 2] = [("orchestrator", PLANNER), ("worker", WORKER)];

/// Claude Code has no schema for a turn's final message, so its workers end with a tool instead.
const CLAUDE_NOTES: &str = "Hive's tools (handoff, request_help, history, rule, memory, type_password, and your task's granted device tools) are yours as MCP tools \
named mcp__hive__<name>. Hive doesn't read your final message: end every turn by calling mcp__hive__end_turn as your very last \
action, with done true and the outcome, or done false with exactly why you stopped and exactly what you need from the owner.";

const VM_NOTES: &str = "- This VM (Ubuntu, you're root): your shell. Its screen is Xvfb :99: \
`export DISPLAY=:99 XAUTHORITY=/home/ubuntu/.Xauthority-99`; `vm-chrome [url] &` opens its Chrome, `vm-shot > /tmp/s.png` and \
view_image show the screen, xdotool clicks and types. Tier 0 encrypted vault: `hive-cred list` shows saved logins and payment card labels/last4; `type_password` blind-types a login password or (only after explicit owner confirmation) a single card field, here or in a device. Hive's files \
(shared with the dashboard and nodes) are in /var/lib/hive/files.";

/// Execution-verified completion check for done=true (bounded to one rejection per attempt so it never deadlocks).
fn gate_completion(end: &Value, ev: &TurnEvidence) -> Option<(&'static str, String)> {
    if end["done"] != true || ev.done_checks > 0 { return None; }
    if let Some(err) = &ev.last_failed {
        return Some(("done:true unrecovered failure", format!(
            "Before marking this task done: your last action failed ({err}) and no successful command or tool call ran afterward to verify recovery. Verify the fix succeeded, then end again."
        )));
    }
    if ev.edited {
        return Some(("done:true unverified edit",
            "Before marking this task done: you modified files without running a command or check afterward to verify the change works. Verify it, then end again.".into()
        ));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn external_prompt_keeps_source_context_and_cannot_mutate_other_sessions() {
        let hive = Hive::new(Db::open(":memory:"), std::env::temp_dir(), None,
            Engine::Codex { cmd: String::new(), env: vec![] }, String::new(), String::new());
        hive.db.run("insert into tasks(id,title,status) values(991,'Other session','open')", &[]);
        let context = json!({"folder":"/club", "conversation": [
            {"role":"assistant","content": "x".repeat(6000)},
            {"role":"user","content":"cancel Workspace for the club"}]}).to_string();
        let req = json!({"id":1,"agent":"claude:source","text":"help me cancel it","context":context});
        let input = hive.planner_input(&req);
        assert!(input.contains("cancel Workspace for the club"));
        hive.apply_plan(1, &req, &json!({"reply":"Continue in Claude", "tasks":[],
            "drop":[991], "start":[], "messages":[{"task":991,"text":"help me cancel it"}]}));
        assert_eq!(hive.db.get("select status from tasks where id=991", &[]).unwrap()["status"], "open");
        assert!(hive.db.all("select * from log where task_id=991", &[]).is_empty());
    }

    #[test]
    fn disconnected_phone_relay_is_offline_and_does_not_queue_calls() {
        let hive = Hive::new(Db::open(":memory:"), std::env::temp_dir(), None,
            Engine::Codex { cmd: String::new(), env: vec![] }, String::new(), String::new());
        let phone = json!({"id": PHONE_ID, "kind": "phone", "seen": now()});
        assert!(!node_online(&phone));
        assert!(node_online(&json!({"id": "mac-test", "seen": now()})));
        assert!(!node_online(&json!({"id": "mac-test", "seen": now() - 100_000})));
        let error = hive.call_node(&phone, "phone_screenshot", &json!({}), 1, 180).unwrap_err();
        assert!(error.contains("iPhone is offline"));
        assert!(hive.db.all("select * from calls", &[]).is_empty());
    }

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
    fn a_turn_end_hands_the_mac_back_before_its_lock_goes() {
        let hive = Hive::new(Db::open(":memory:"), std::env::temp_dir(), None,
            Engine::Codex { cmd: String::new(), env: vec![] }, String::new(), String::new());
        hive.db.run("insert into nodes(id,kind,name,tools,seen) values('mac-t','mac','Mac','[]',?)", args!(now()));
        hive.locks.lock().unwrap().insert("mac-t input".into(), (1, now() - 1000));
        hive.locks.lock().unwrap().insert(format!("{PHONE_ID} touch"), (1, now() - 1000));
        hive.release_all(1);
        assert_eq!(hive.locks().as_array().unwrap().iter().map(|l| l["lock"].clone()).collect::<Vec<_>>(), vec![json!("mac-t input")]);
        // The Mac answers the hand-back; then its lock goes too.
        let call = hive.wait_until(5000, || hive.db.get("select id from calls where tool='mac_hand_back' and node='mac-t' and agent_id=1", &[])).unwrap();
        hive.db.run("update calls set status='done', result='{}' where id=?", args!(call["id"].clone()));
        hive.bump();
        assert!(hive.wait_until(5000, || hive.locks().as_array().unwrap().is_empty().then_some(())).is_some());
    }

    #[test]
    fn stop_recheck_refreshes_nodes_without_expanding_grants() {
        let hive = Hive::new(Db::open(":memory:"), std::env::temp_dir(), None,
            Engine::Codex { cmd: String::new(), env: vec![] }, String::new(), String::new());
        hive.db.run("insert into tasks(id,title,nodes) values(10,'lookup','[\"vm\"]')", &[]);
        hive.db.run("insert into nodes(id,kind,name,tools,seen) values('mac-test','mac','Test Mac','[]',?)", args!(now()));
        hive.db.run("insert into nodes(id,kind,name,tools,seen) values('browser-test','browser','Old browser','[]',0)", &[]);
        let text = hive.stop_recheck(10);
        assert!(text.contains("Granted node kinds: vm"));
        assert!(text.contains("Test Mac (mac, mac-test): online"));
        assert!(text.contains("Old browser (browser, browser-test): offline"));
        assert!(text.contains("search memory and history") && text.contains("every accessible node"));
        assert!(hive.require_node(10, "mac").is_err());
        hive.db.run("update nodes set seen=0 where id='mac-test'", &[]);
        assert!(hive.stop_recheck(10).contains("Test Mac (mac, mac-test): offline"));
    }

    #[test]
    fn agents_lock_the_files_they_edit_and_the_owner_edits_the_instructions() {
        let state = std::env::temp_dir().join(format!("hive-orchestrator-{}", std::process::id()));
        std::fs::create_dir_all(&state).unwrap();
        let hive = Hive::new(Db::open(":memory:"), state.clone(), None,
            Engine::Codex { cmd: String::new(), env: vec![] }, String::new(), String::new());
        hive.tool_inner("lock", &json!({"files": ["server/src/hive.rs", "./README.md"]}), 1, 0).unwrap();
        assert!(hive.tool_inner("lock", &json!({"files": ["server/src/api.rs", "README.md"]}), 2, 0).unwrap_err().contains("README.md is locked"));
        hive.tool_inner("lock", &json!({"files": ["server/src/api.rs"]}), 2, 0).unwrap();
        hive.release_all(1);
        hive.tool_inner("lock", &json!({"files": ["README.md"]}), 2, 0).unwrap();
        for (name, own) in PROMPTS {
            assert_eq!(hive.prompt(name).unwrap(), own);
            hive.set_prompt(name, "Do it all yourself.").unwrap();
            assert_eq!(hive.prompt(name).unwrap(), "Do it all yourself.");
            hive.set_prompt(name, "").unwrap();
            assert_eq!(hive.prompt(name).unwrap(), own);
        }
        hive.set_prompt("agent", "Be brief.").unwrap();
        assert!(hive.instructions(&json!({"id": 1, "title": "t"})).starts_with("Be brief.\n\nYour task: #1 t"));
        assert!(hive.prompt("../hive.db").is_none() && hive.set_prompt("../hive.db", "x").is_err());
        std::fs::remove_dir_all(&state).ok();
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
        hive.db.run("insert into agents(id, kind, role, name, status, at, updated) values(7, 'codex', 'worker', 'w7', 'working', 1, 1)", &[]);
        for total in [100, 120, 120] {
            hive.save_usage("session", 7, &json!({"totalTokens":total,"inputTokens":90,"outputTokens":30,"cachedInputTokens":50}));
        }
        hive.save_usage("session", 7, &Value::Null);
        let usage = hive.db.usage_for(7).unwrap();
        assert_eq!(usage["total"], 120);
        assert_eq!(usage["cached"], 50);
        // Orchestrator usage (agent 0) auto-creates its system row and aggregates cleanly.
        hive.save_usage("orch-1", 0, &json!({"totalTokens":40,"inputTokens":30,"outputTokens":10,"cachedInputTokens":5}));
        assert_eq!(hive.db.usage_for(0).unwrap()["total"], 40);
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
        assert_eq!(hive.locks()[0]["lock"], format!("{PHONE_ID} touch"));
        // Strict least-privilege: phone-only tasks don't get browser tools; browser-granted tasks do.
        let phone_tools = hive.tools_for(&hive.task_kinds(&json!({"nodes":["phone"]})));
        assert!(!phone_tools.iter().any(|t| t["name"] == "browser_tabs" || t["name"] == "browser_devices"));
        let browser_tools = hive.tools_for(&hive.task_kinds(&json!({"nodes":["browser"]})));
        assert!(browser_tools.iter().any(|t| t["name"] == "browser_devices"));
        assert!(browser_tools.iter().any(|t| t["name"] == "browser_tabs" && t["inputSchema"]["properties"]["browser"]["type"] == "string"));
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
        ops::record_project_outcome(&hive, "typing", tid, "Keyboard", "Built and tested");
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
        // Slim planner_input carries the project summary & 1-line request index; orchestrator uses inspect/history for raw followups.
        let req = hive.db.get("select * from requests where id=3", &[]).unwrap();
        let p_in = hive.planner_input(&req);
        assert!(p_in.contains("typing:") && p_in.contains("Built and tested") && p_in.contains("Build the keyboard"), "{p_in}");
        let inspected = hive.tool_inner("inspect", &json!({"kind":"project", "name":"typing"}), 0, 0).unwrap();
        assert!(inspected.as_str().unwrap().contains("Keep calibration"));
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
        assert_eq!(hive.db.all("select * from memory where tier='profile'", &[]).len(), 1);
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
    fn depends_on_gates_task_until_prerequisite_is_done() {
        let hive = Hive::new(Db::open(":memory:"), std::env::temp_dir(), None,
            Engine::Codex { cmd: String::new(), env: vec![] }, String::new(), String::new());
        let first = hive.add_task(0, &json!({"title":"Step 1", "project":"deploy", "quote":"build"}));
        let second = hive.add_task(0, &json!({"title":"Step 2", "project":"deploy", "quote":"ship", "depends_on": first}));
        hive.db.run("update tasks set status='working' where id=?", args!(first));
        // Second task stays open while prerequisite is not done.
        hive.tick();
        assert_eq!(hive.db.get("select status, agent_id from tasks where id=?", args!(second)).unwrap()["status"], "open");
        assert!(hive.db.get("select agent_id from tasks where id=?", args!(second)).unwrap()["agent_id"].is_null());
        // Once prerequisite finishes, tick picks up second (unavailable engine sets it to needs, proving it was dispatched).
        hive.db.run("update tasks set status='done' where id=?", args!(first));
        hive.tick();
        assert!(hive.wait_until(2000, || {
            hive.db.get("select status from tasks where id=?", args!(second)).filter(|r| r["status"] != "open")
        }).is_some());
    }

    #[test]
    fn fresh_worker_by_default_and_explicit_continue_worker_reuse() {
        for kind in ["codex", CLAUDE_AGENT] {
            let engine = if kind == "codex" { Engine::Codex { cmd: String::new(), env: vec![] } }
                else { Engine::Claude { cmd: String::new(), env: vec![] } };
            let hive = Hive::new(Db::open(":memory:"), std::env::temp_dir(), None,
                engine, String::new(), String::new());
            let current = hive.add_task(0, &json!({"title":"Current", "project":"handoff"}));
            let agent = hive.db.run("insert into agents(task_id, kind, role, status, thread) values(?, ?, 'worker', 'idle', 'thread')", args!(current, kind));
            hive.db.run("update tasks set agent_id=? where id=?", args!(agent, current));
            for status in ["working", "needs", "dropped", "open"] {
                hive.db.run("update tasks set status=? where id=?", args!(status, current));
                let next = hive.add_task(0, &json!({"title":"Next", "project":"handoff", "continue_worker": agent}));
                hive.start_agent(next);
                assert!(!hive.ready_for_task(agent));
                assert_eq!(hive.db.get("select task_id from agents where id=?", args!(agent)).unwrap()["task_id"], current);
                let t = hive.db.get("select * from tasks where id=?", args!(next)).unwrap();
                assert_ne!(t["agent_id"], agent, "busy worker is never blocked on; a fresh worker takes it");
                assert_ne!(t["status"], "queued");
            }
            // Even when the prior worker is free and on the same project, independent tasks get a fresh worker by default.
            hive.db.run("update tasks set status='done' where id=?", args!(current));
            hive.turns.lock().unwrap().insert("thread".into(), "turn".into());
            assert!(!hive.ready_for_task(agent));
            hive.turns.lock().unwrap().clear();
            assert!(hive.ready_for_task(agent));
            let isolated = hive.add_task(0, &json!({"title":"Isolated", "project":"handoff"}));
            hive.start_agent(isolated);
            assert_ne!(hive.db.get("select agent_id from tasks where id=?", args!(isolated)).unwrap()["agent_id"], agent);
            // Explicit continue_worker reuses that exact idle worker.
            let continued = hive.add_task(0, &json!({"title":"Continued", "project":"handoff", "continue_worker": agent}));
            hive.start_agent(continued);
            assert_eq!(hive.db.get("select task_id from agents where id=?", args!(agent)).unwrap()["task_id"], continued);
        }
    }

    #[test]
    fn the_orchestrator_sees_who_is_on_what_and_starts_and_drops_tasks() {
        let hive = Hive::new(Db::open(":memory:"), std::env::temp_dir(), None,
            Engine::Codex { cmd: String::new(), env: vec![] }, String::new(), String::new());
        hive.db.run("insert into tasks(id, status, title) values(10, 'working', 'Long job')", &[]);
        let busy = hive.db.run("insert into agents(task_id, kind, role, status) values(10, 'codex', 'worker', 'working')", &[]);
        hive.db.run("update tasks set agent_id=? where id=10", args!(busy));
        hive.db.run("insert into tasks(id, agent_id, status, title) values(11, ?, 'queued', 'Waiting'), (12, null, 'idle', 'Unwanted')", args!(busy));
        let input = hive.planner_input(&json!({ "id": 1, "text": "start the queued one" }));
        assert!(input.contains(&format!("#11 [queued] Waiting (nodes [], project , worker {busy}, which is on #10 now)")), "{input}");
        assert!(input.contains(&format!("#10 [working] Long job (nodes [], project , worker {busy})")), "{input}");
        assert!(input.starts_with("The owner's rules:") && input.trim_end().ends_with("start the queued one"), "the request comes last: {input}");
        hive.apply_plan(1, &json!({}), &json!({ "reply": "Starting #11 and dropping #12.", "tasks": [], "messages": [], "grant": [], "rules": [], "projects": [], "start": [11, 10], "drop": [12] }));
        let t = hive.db.get("select * from tasks where id=11", &[]).unwrap();
        assert_eq!((t["status"].clone(), t["agent_id"].clone()), (json!("open"), Value::Null), "Hive's loop gives it its own worker");
        assert_eq!(hive.db.get("select status from tasks where id=12", &[]).unwrap()["status"], "dropped");
        assert_eq!(hive.db.get("select status from tasks where id=10", &[]).unwrap()["status"], "working", "a working task isn't restarted");
        assert!(hive.db.get("select * from log where text=\"Couldn't start task #10: it's working, not waiting\"", &[]).is_some());
        assert!(PLANNER.contains("Never create a task whose job is coordinating other tasks"));
        assert_eq!(plan_schema(&[])["required"], json!(["reply", "tasks", "messages", "grant", "rules", "projects", "start", "drop"]));
    }

    #[test]
    fn scoped_rules_projects_and_role_boundaries_are_enforced() {
        let hive = Hive::new(Db::open(":memory:"), std::env::temp_dir(), None,
            Engine::Codex { cmd: String::new(), env: vec![] }, String::new(), String::new());
        ops::add_rule(&hive, "Global tone rule", "be concise", "").unwrap();
        ops::add_rule(&hive, "Alpha-only rule", "use bun in alpha", "project:alpha").unwrap();
        ops::add_rule(&hive, "Mac-only rule", "ask before closing tabs", "node:mac").unwrap();
        // Orchestrator sees global rule + count of hidden scoped rules (not noisy project/node rules).
        let req = json!({"id": 1, "node": "dashboard", "text": "hello", "context": "{}"});
        let p_in = hive.planner_input(&req);
        assert!(p_in.contains("Global tone rule"));
        assert!(!p_in.contains("Alpha-only rule") && !p_in.contains("Mac-only rule"));
        assert!(p_in.contains("+2 scoped rules"));
        // Worker on project=alpha, nodes=[vm] sees global + alpha rule, not mac rule.
        let alpha_task = json!({"id": 1, "request_id": 0, "project": "alpha", "title": "Build", "quote": "build", "nodes": "[\"vm\"]"});
        let instr = hive.instructions(&alpha_task);
        assert!(instr.contains("Global tone rule") && instr.contains("Alpha-only rule") && !instr.contains("Mac-only rule"));
        // Orchestrator cannot execute device/worker tools; worker cannot call inspect or ungranted node tools.
        assert!(hive.tool_inner("mac_screenshot", &json!({}), 0, 0).unwrap_err().contains("Orchestrator agent cannot invoke"));
        let tid = hive.add_task(0, &json!({"title":"VM only", "project":"alpha", "nodes":["vm"]}));
        assert!(hive.tool_inner("inspect", &json!({"kind":"rules"}), 1, tid).unwrap_err().contains("Only the orchestrator"));
        assert!(hive.tool_inner("sim", &json!({"mode":"read"}), 1, tid).unwrap_err().contains("not granted node 'hive'"));
        assert!(hive.tool_inner("browser_devices", &json!({}), 1, tid).unwrap_err().contains("not granted node 'browser'"));
        // Orchestrator can grant extra capability, and apply_plan can create projects & rules.
        let decl = json!([{"name":"browser_tabs","timeout":0}]);
        hive.db.run("insert into nodes(id,kind,name,tools,seen) values('b1','browser','Safari',?,?)", args!(decl.to_string(), now()));
        hive.apply_plan(1, &req, &json!({
            "reply": "Updated", "tasks": [], "messages": [], "start": [], "drop": [],
            "projects": [{"slug": "alpha", "title": "Alpha App", "summary": "Web client"}],
            "rules": [{"text": "Run tests", "quote": "always run tests", "scope": "project:alpha"}],
            "grant": [{"task": tid, "nodes": ["browser"]}]
        }));
        assert_eq!(hive.db.get("select title from projects where slug='alpha'", &[]).unwrap()["title"], "Alpha App");
        assert!(hive.tool_inner("browser_devices", &json!({}), 1, tid).is_ok());
    }

    #[test]
    fn handoff_and_request_help_enforce_project_scope_and_hop_limits() {
        let hive = Hive::new(Db::open(":memory:"), std::env::temp_dir(), None,
            Engine::Codex { cmd: String::new(), env: vec![] }, String::new(), String::new());
        let t_a1 = hive.add_task(1, &json!({"title":"Backend", "project":"shop", "quote":"api"}));
        let t_a2 = hive.add_task(1, &json!({"title":"Frontend", "project":"shop", "quote":"ui"}));
        let t_b = hive.add_task(2, &json!({"title":"Other", "project":"music", "quote":"song"}));
        // Cross-project handoff is rejected; workers must escalate via request_help.
        assert!(hive.tool_inner("handoff", &json!({"task": t_b, "kind": "fact", "text": "hi"}), 1, t_a1)
            .unwrap_err().contains("same project"));
        // Same-project handoffs succeed up to MAX_HANDOFF_HOPS (2), then block until orchestrator/owner intervenes.
        assert!(hive.tool_inner("handoff", &json!({"task": t_a2, "kind": "artifact", "text": "schema at /tmp/s.json"}), 1, t_a1).is_ok());
        let t_a2_row = hive.db.get("select * from tasks where id=?", args!(t_a2)).unwrap();
        assert!(hive.instructions(&t_a2_row).contains("schema at /tmp/s.json"));
        assert!(hive.tool_inner("handoff", &json!({"task": t_a1, "kind": "fact", "text": "endpoint ready"}), 2, t_a2).is_ok());
        assert!(hive.tool_inner("handoff", &json!({"task": t_a2, "kind": "question", "text": "hop 3"}), 1, t_a1)
            .unwrap_err().contains("hop limit"));
        assert!(!hive.db.all("select * from log where who='handoff'", &[]).is_empty());
        // request_help enforces capability node name and MAX_HELP_PER_TASK (2).
        assert!(hive.tool_inner("request_help", &json!({"kind": "capability", "text": "need safari", "node": ""}), 1, t_a1).is_err());
        assert!(hive.tool_inner("request_help", &json!({"kind": "capability", "text": "need safari", "node": "browser"}), 1, t_a1).is_ok());
        assert!(hive.tool_inner("request_help", &json!({"kind": "propose_task", "text": "add smoke test", "node": ""}), 1, t_a1).is_ok());
        assert!(hive.tool_inner("request_help", &json!({"kind": "orchestrator", "text": "third ask", "node": ""}), 1, t_a1)
            .unwrap_err().contains("help limit"));
        assert_eq!(hive.db.all("select * from requests where node=?", args!(format!("worker:#{t_a1}"))).len(), 2);
    }

    #[test]
    fn external_activity_expires_and_check_in_restores_unfinished_work() {
        let hive = Hive::new(Db::open(":memory:"), std::env::temp_dir(), None,
            Engine::Codex { cmd: String::new(), env: vec![] }, String::new(), String::new());
        let a = hive.agent_for_session("claude:old", 1);
        hive.db.run("insert into tasks(id,agent_id,status) values(1,?,'working'),(2,?,'needs'),(3,?,'done')", args!(a,a,a));
        hive.db.run("update agents set updated=? where id=?", args!(now()-900_001,a));
        hive.expire_external_sessions();
        assert_eq!(hive.db.get("select status from tasks where id=1", &[]).unwrap()["status"], "idle");
        hive.external_check_in(a);
        for (id,status) in [(1,"working"),(2,"needs"),(3,"done")] {
            assert_eq!(hive.db.get("select status from tasks where id=?", args!(id)).unwrap()["status"],status);
        }
        hive.expire_external_sessions();
        assert_eq!(hive.db.get("select status from tasks where id=1", &[]).unwrap()["status"], "working");
        hive.end_task(1, &json!({"done":true,"outcome":"verified"})).unwrap();
        assert_eq!(hive.db.get("select status from agents where id=?", args!(a)).unwrap()["status"], "done");
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
            let t = hive.db.get("select t.status, a.kind, a.role, a.name from tasks t join agents a on a.id=t.agent_id where t.id=?", args!(tid)).unwrap();
            assert_eq!((s(&t["status"]), s(&t["kind"]), s(&t["role"]), s(&t["name"])), ("working".into(), "claude".into(), "external".into(), name.into()));
            hive.end_task(tid, &json!({ "done": true, "outcome": "fixed" })).unwrap();
        }
        std::fs::remove_dir_all(&state).ok();
    }

    #[test]
    fn completion_gate_checks_execution_evidence_without_deadlocking() {
        let done = json!({ "done": true, "outcome": "fixed", "why": "", "need": "" });
        let not_done = json!({ "done": false, "outcome": "", "why": "blocked", "need": "approval" });
        // Pure conversational / 0-action tasks pass straight through.
        assert!(gate_completion(&done, &TurnEvidence::default()).is_none());
        assert!(gate_completion(&not_done, &TurnEvidence { last_failed: Some("err".into()), edited: true, done_checks: 0 }).is_none());
        // Unrecovered failure blocks once, then allows completion on retry so it never deadlocks.
        let mut ev = TurnEvidence { last_failed: Some("cargo test failed".into()), edited: false, done_checks: 0 };
        assert_eq!(gate_completion(&done, &ev).unwrap().0, "done:true unrecovered failure");
        ev.done_checks += 1;
        assert!(gate_completion(&done, &ev).is_none());
        // Unverified edit blocks once until a command/tool runs afterward.
        let ev_edit = TurnEvidence { last_failed: None, edited: true, done_checks: 0 };
        assert_eq!(gate_completion(&done, &ev_edit).unwrap().0, "done:true unverified edit");
    }

    #[test]
    fn sim_only_injected_for_hive_tasks_and_retrospective_uses_repeating_tasks() {
        let state = std::env::temp_dir().join(format!("hive-sim-test-{}", std::process::id()));
        std::fs::create_dir_all(&state).unwrap();
        let hive = Hive::new(Db::open(":memory:"), state.clone(), None,
            Engine::Codex { cmd: String::new(), env: vec![] }, String::new(), String::new());
        let normal = json!({ "id": 1, "request_id": 0, "title": "Check weather", "quote": "weather?", "nodes": "[\"vm\"]", "level": "easy" });
        assert!(!hive.instructions(&normal).contains("Self-Improvement Memory (SIM)"));
        let hive_task = json!({ "id": 2, "request_id": 0, "title": "Fix server", "quote": "fix server", "nodes": "[\"hive\",\"vm\"]", "level": "hard" });
        let instr = hive.instructions(&hive_task);
        assert!(instr.contains("Self-Improvement Memory (SIM)") && instr.contains("P1:"));
        let tid = hive.start_retrospective(24);
        let row = hive.db.get("select title, every, nodes from tasks where id=?", args!(tid)).unwrap();
        assert_eq!((s(&row["title"]), row["every"].as_i64(), s(&row["nodes"])), ("Harness retrospective".into(), Some(24), "[\"hive\"]".into()));
        std::fs::remove_dir_all(&state).ok();
    }

    #[test]
    fn hidden_tools_filtered_and_online_browser_routing_ignores_stale_duplicates() {
        let hive = Hive::new(Db::open(":memory:"), std::env::temp_dir(), None,
            Engine::Codex { cmd: String::new(), env: vec![] }, String::new(), String::new());
        let old_mac_tools = json!([
            {"name":"mac_input","lock":"input","timeout":0},
            {"name":"mac_type_password","timeout":0},
            {"name":"mac_hand_back","timeout":0},
            {"name":"mac_restore_phone_passcode","timeout":0}
        ]);
        hive.db.run("insert into nodes(id,kind,name,tools,seen) values('m1','mac','Mac',?,?)", args!(old_mac_tools.to_string(), now()));
        let mac_tools = hive.tools_for(&["mac".into()]);
        assert!(mac_tools.iter().any(|t| t["name"] == "mac_input"));
        for hidden in ["mac_type_password", "mac_hand_back", "mac_restore_phone_passcode"] {
            assert!(!mac_tools.iter().any(|t| t["name"] == hidden), "{hidden} should be hidden");
        }
        // Offline duplicate browser does not force manual browser_devices selection when only 1 browser is online.
        let bdecl = json!([{"name":"browser_tabs","timeout":0}]);
        hive.db.run("insert into nodes(id,kind,name,tools,seen) values('b-old','browser','Safari',?,?)", args!(bdecl.to_string(), now() - 600_000));
        hive.db.run("insert into nodes(id,kind,name,tools,seen) values('b-live','browser','Safari',?,?)", args!(bdecl.to_string(), now()));
        let err = hive.tool_inner("browser_tabs", &json!({}), 1, 0).unwrap_err();
        assert!(!err.contains("Choose"), "unexpected ambiguity error: {err}");
        assert_eq!(hive.db.get("select node from calls order by id desc limit 1", &[]).unwrap()["node"], "b-live");
        // Internal browser_type_password still dispatches to b-live even when absent from advertised tools[].
        std::thread::scope(|s| {
            let h = s.spawn(|| hive.tool_inner("browser_type_password", &json!({"site":"example.com","username":"u","tab":1,"i":2}), 1, 0));
            let call = hive.wait_until(2000, || hive.db.get("select id, node from calls where tool='browser_type_password'", &[])).unwrap();
            assert_eq!(call["node"], "b-live");
            hive.db.run("update calls set status='done', result='{\"text\":\"Filled.\"}' where id=?", args!(call["id"].clone()));
            hive.bump();
            assert_eq!(h.join().unwrap().unwrap()["text"], "Filled.");
        });
    }

    #[test]
    fn large_tool_outputs_spill_to_disk() {
        let state = std::env::temp_dir().join(format!("hive-spill-test-{}", std::process::id()));
        std::fs::create_dir_all(&state).unwrap();
        let hive = Hive::new(Db::open(":memory:"), state.clone(), None,
            Engine::Codex { cmd: String::new(), env: vec![] }, String::new(), String::new());
        let small = "hello world".to_string();
        assert_eq!(hive.cap_tool_output("browser_read", small.clone()), small);
        let huge = "a".repeat(8_000);
        let capped = hive.cap_tool_output("browser_read", huge.clone());
        assert!(capped.len() < 5_400 && capped.contains("Output truncated: full 8000 chars saved at"));
        let files = hive.db.all("select name, size from files", &[]);
        assert_eq!(files.len(), 1);
        assert_eq!(files[0]["size"], 8000);
        std::fs::remove_dir_all(&state).ok();
    }

    #[test]
    fn auto_retrospective_triggers_on_friction_spike_and_alternates_subtraction() {
        let state = std::env::temp_dir().join(format!("hive-auto-retro-{}", std::process::id()));
        std::fs::create_dir_all(&state).unwrap();
        let hive = Hive::new(Db::open(":memory:"), state.clone(), Some(state.clone()),
            Engine::Codex { cmd: String::new(), env: vec![] }, String::new(), String::new());
        // Quiet DB: no retrospective triggered.
        assert!(hive.maybe_retrospective().is_none());
        // 5 recent gates trigger a friction-spike retrospective.
        for _ in 0..5 {
            hive.db.run("insert into log(at, agent_id, task_id, request_id, who, text) values(?, 1, 1, 0, 'gate', 'done:true unrecovered')", args!(now()));
        }
        let first = hive.maybe_retrospective().expect("first retro should fire");
        assert!(hive.maybe_retrospective().is_none(), "active retro prevents duplicate");
        // Mark first retro done >13h ago: next trigger alternates to Build-to-Delete subtraction pass.
        hive.db.run("update tasks set status='done', updated=? where id=?", args!(now() - 13 * 3_600_000, first));
        let second = hive.maybe_retrospective().expect("second retro should fire");
        let quote = s(&hive.db.get("select quote from tasks where id=?", args!(second)).unwrap()["quote"]);
        assert!(quote.contains("Build-to-Delete") && quote.contains("net-negative LOC"), "{quote}");
        std::fs::remove_dir_all(&state).ok();
    }

    #[test]
    fn three_tier_memory_and_card_confirmation_gate() {
        let hive = Hive::new(Db::open(":memory:"), std::env::temp_dir(), Some(std::env::temp_dir()),
            Engine::Codex { cmd: String::new(), env: vec![] }, String::new(), String::new());
        // Tier 1 + Tier 2 via unified memory tool + secret firewall
        hive.tool_inner("memory", &json!({"action":"save_profile","key":"school","value":"UW Madison"}), 1, 0).unwrap();
        hive.tool_inner("memory", &json!({"action":"save_contact","name":"Jordan Lee","relation":"club lead","email":"jordan@example.edu"}), 1, 0).unwrap();
        hive.tool_inner("memory", &json!({"action":"save_playbook","host":"canvas.wisc.edu","title":"Grades","steps":"Open /grades","selectors":"table.grades"}), 1, 0).unwrap();
        assert!(hive.tool_inner("memory", &json!({"action":"save_profile","key":"visa","value":"4111 1111 1111 1111"}), 1, 0).is_err());
        let found = hive.tool_inner("memory", &json!({"action":"search","query":"Madison"}), 1, 0).unwrap();
        assert!(found.as_str().unwrap().contains("UW Madison"));

        // Tier 0 payment card requires explicit owner confirmation (one-way door)
        let err = hive.tool_inner("type_password", &json!({"kind":"card","site":"personal","field":"number","username":"","tool":"","args":""}), 1, 0).unwrap_err();
        assert!(err.contains("one-way door"), "{err}");

        // Browser worker prompt auto-injects verified playbook; hive worker uses draft PR governance
        let rid = hive.db.run("insert into requests(at, node, agent, text, context) values(?, 'dashboard', '', 'check canvas.wisc.edu grades', '{\"site\":\"canvas.wisc.edu\"}')", args!(now()));
        let tid = hive.db.run("insert into tasks(request_id, title, quote, nodes, status, at, updated) values(?, 'Check grades', 'check canvas.wisc.edu', '[\"browser\",\"hive\"]', 'open', ?, ?)", args!(rid, now(), now()));
        let task = hive.db.get("select * from tasks where id=?", args!(tid)).unwrap();
        let prompt = hive.instructions(&task);
        assert!(prompt.contains("Verified site playbook(s)") && prompt.contains("Open /grades"), "{prompt}");
        assert!(prompt.contains("gh pr create --draft") && prompt.contains("NEVER push directly to club `main`"), "{prompt}");
    }
}
