//! Unified domain operations and role-based permissions shared by HTTP routes (api.rs) and LLM tools (tools.rs / hive.rs).
//! Keep api.rs thin for clients and tools.rs lean (<15 role-scoped tools) for agents; both execute here.
use crate::args;
use crate::db::{now, scope_applies};
use crate::hive::{list, Hive};
use crate::sim;
use serde_json::{json, Value};
use std::sync::Arc;

pub const MAX_HANDOFF_HOPS: i64 = 2;
pub const MAX_HELP_PER_TASK: i64 = 2;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    Owner,
    Orchestrator,
    Worker,
}

#[derive(Clone, Copy, Debug)]
pub struct Actor {
    pub role: Role,
    pub agent_id: i64,
    pub task_id: i64,
}

impl Actor {
    pub fn owner() -> Self { Self { role: Role::Owner, agent_id: 0, task_id: 0 } }
    pub fn orchestrator() -> Self { Self { role: Role::Orchestrator, agent_id: 0, task_id: 0 } }
    pub fn worker(agent_id: i64, task_id: i64) -> Self { Self { role: Role::Worker, agent_id, task_id } }
    pub fn is_control_plane(self) -> bool { matches!(self.role, Role::Owner | Role::Orchestrator) }
}

fn s(v: &Value) -> String { v.as_str().map(String::from).unwrap_or_else(|| if v.is_null() { String::new() } else { v.to_string() }) }
fn short(t: &str, n: usize) -> String { if t.chars().count() <= n { t.into() } else { t.chars().take(n).collect::<String>() + "…" } }

// ---- Projects ----

pub fn list_projects(hive: &Hive) -> Vec<Value> {
    let mut rows = hive.db.all("select * from projects order by updated desc, slug asc limit 50", &[]);
    let known: std::collections::HashSet<String> = rows.iter().map(|r| s(&r["slug"]).to_ascii_lowercase()).collect();
    for r in hive.db.all("select project, max(updated) as updated from tasks where trim(project)!='' group by project order by updated desc limit 30", &[]) {
        let slug = s(&r["project"]).trim().to_string();
        if !slug.is_empty() && !known.contains(&slug.to_ascii_lowercase()) {
            rows.push(json!({ "slug": slug, "title": slug, "summary": "", "default_nodes": "[]", "status": "active", "updated": r["updated"] }));
        }
    }
    rows
}

pub fn upsert_project(hive: &Hive, actor: Actor, slug: &str, title: &str, summary: &str, default_nodes: Option<&Value>) -> Result<Value, String> {
    if !actor.is_control_plane() { return Err("Only the owner or orchestrator can manage projects.".into()); }
    let slug = slug.trim();
    if slug.is_empty() { return Err("Give a project slug.".into()); }
    let existing = hive.db.get("select * from projects where slug=?", args!(slug));
    let title = if !title.trim().is_empty() { title.trim().to_string() }
        else { existing.as_ref().map(|r| s(&r["title"])).filter(|v| !v.is_empty()).unwrap_or_else(|| slug.to_string()) };
    let summary = if !summary.trim().is_empty() { short(summary.trim(), 500) }
        else { existing.as_ref().map(|r| s(&r["summary"])).unwrap_or_default() };
    let nodes = default_nodes.filter(|v| v.is_array()).cloned()
        .unwrap_or_else(|| existing.as_ref().and_then(|r| serde_json::from_str(&s(&r["default_nodes"])).ok()).unwrap_or(json!([])));
    hive.db.run(
        "insert into projects(slug, title, summary, default_nodes, status, updated) values(?,?,?,?,'active',?) \
         on conflict(slug) do update set title=excluded.title, summary=excluded.summary, default_nodes=excluded.default_nodes, updated=excluded.updated",
        args!(slug, title, summary, nodes.to_string(), now()),
    );
    hive.bump();
    Ok(hive.db.get("select * from projects where slug=?", args!(slug)).unwrap_or(json!({ "slug": slug })))
}

/// Ensure a project exists when a task references it, and append concise completed outcomes to its rolling summary.
pub fn touch_project(hive: &Hive, slug: &str, nodes: &Value) {
    let slug = slug.trim();
    if slug.is_empty() { return; }
    if hive.db.get("select 1 from projects where slug=?", args!(slug)).is_none() {
        let ns = if nodes.is_array() { nodes.to_string() } else { "[]".into() };
        hive.db.run("insert or ignore into projects(slug, title, summary, default_nodes, status, updated) values(?,?, '', ?, 'active', ?)",
            args!(slug, slug, ns, now()));
    } else {
        hive.db.run("update projects set updated=? where slug=?", args!(now(), slug));
    }
}

pub fn record_project_outcome(hive: &Hive, project: &str, task_id: i64, title: &str, outcome: &str) {
    let slug = project.trim();
    if slug.is_empty() { return; }
    let existing = hive.db.get("select summary from projects where slug=?", args!(slug)).map(|r| s(&r["summary"])).unwrap_or_default();
    let line = format!("#{task_id} {}: {}", short(title.trim(), 60), short(outcome.trim(), 160));
    let mut parts: Vec<String> = existing.split(" | ").map(str::trim).filter(|p| !p.is_empty()).map(String::from).collect();
    parts.push(line);
    if parts.len() > 3 { parts = parts.split_off(parts.len() - 3); }
    let summary = short(&parts.join(" | "), 480);
    hive.db.run(
        "insert into projects(slug, title, summary, default_nodes, status, updated) values(?,?,?,'[]','active',?) \
         on conflict(slug) do update set summary=excluded.summary, updated=excluded.updated",
        args!(slug, slug, summary, now()),
    );
}

// ---- Rules & Info ----

pub fn rules_for(hive: &Hive, nodes: &[String], site: &str, app: &str, folder: &str, project: &str) -> Vec<Value> {
    hive.db.all("select id, text, scope, code from rules where active=1 order by id", &[]).into_iter()
        .filter(|r| scope_applies(r["scope"].as_str().unwrap_or(""), nodes, site, app, folder, project)).collect()
}

pub fn add_rule(hive: &Hive, text: &str, quote: &str, scope: &str) -> Result<i64, String> {
    if text.trim().is_empty() || quote.trim().is_empty() { return Err("give the rule and the owner's exact words".into()); }
    let scope = scope.trim();
    if !(scope.is_empty() || ["project:", "node:", "site:", "app:", "folder:"].iter().any(|p| scope.starts_with(p))) {
        return Err("scope is project:<slug>, node:<kind>, site:<host>, app:<name>, folder:<path>, or empty for everywhere".into());
    }
    let rid = hive.db.run("insert into rules(text, quote, scope, at) values(?,?,?,?)", args!(text.trim(), quote.trim(), scope, now()));
    hive.log(0, 0, 0, "hive", &format!("New rule R{rid}: {}", text.trim()));
    hive.bump();
    Ok(rid)
}

pub fn delete_rule(hive: &Hive, actor: Actor, id: i64) -> Result<(), String> {
    if !actor.is_control_plane() { return Err("Only the owner or orchestrator can delete rules.".into()); }
    hive.db.run("update rules set active=0 where id=?", args!(id));
    hive.bump();
    Ok(())
}

pub fn set_page_code(hive: &Hive, rule: i64, css: &str, js: &str) -> Result<String, String> {
    let code = json!({ "css": css, "js": js }).to_string();
    hive.db.get("select id from rules where id=? and active=1 and scope like 'site:%'", args!(rule))
        .ok_or("give the id of an active site rule (R12 is 12)")?;
    hive.db.run("update rules set code=? where id=?", args!(code, rule));
    hive.bump();
    Ok("Saved: the owner's browsers apply it on that site's pages from their next load.".into())
}

pub fn info(hive: &Hive, key: &str, value: &str) -> String {
    let (key, value) = (key.trim(), value.trim());
    if !key.is_empty() && !value.is_empty() {
        hive.db.run("insert into info(key, value, updated) values(?,?,?) on conflict(key) do update set value=excluded.value, updated=excluded.updated",
            args!(key, value, now()));
        return "Saved.".into();
    }
    let rows = if key.is_empty() { hive.db.all("select key, value from info order by key", &[]) }
        else { hive.db.all("select key, value from info where key=?", args!(key)) };
    rows.iter().map(|r| format!("{}: {}", s(&r["key"]), s(&r["value"]))).collect::<Vec<_>>().join("\n")
}

// ---- Orchestrator On-Demand Inspection ----

pub fn inspect(hive: &Hive, kind: &str, id: i64, name: &str) -> Result<Value, String> {
    match kind.trim() {
        "project" => {
            let slug = name.trim();
            if slug.is_empty() { return Ok(json!({ "projects": list_projects(hive) })); }
            let project = hive.db.get("select * from projects where lower(slug)=lower(?)", args!(slug)).unwrap_or(json!({ "slug": slug }));
            let tasks = hive.db.all("select id, request_id, title, status, nodes, level, agent_id, depends_on, outcome, why, need, updated from tasks where lower(project)=lower(?) order by id desc limit 12", args!(slug));
            let followups = hive.db.all("select l.id, l.task_id, l.at, l.text from log l join tasks t on t.id=l.task_id where lower(t.project)=lower(?) and l.who='owner' order by l.id desc limit 10", args!(slug));
            let rules = hive.db.all("select id, text, scope from rules where active=1 and lower(scope)=lower(?) order by id", args!(format!("project:{slug}")));
            Ok(json!({ "project": project, "tasks": tasks, "followups": followups, "rules": rules }))
        }
        "task" => {
            let task = hive.db.get("select * from tasks where id=?", args!(id)).ok_or(format!("no task #{id}"))?;
            let worker = task["agent_id"].as_i64().and_then(|aid| hive.db.get("select id, role, kind, name, status, model, effort, task_id from agents where id=?", args!(aid)));
            let log = hive.db.all("select id, at, who, text from log where task_id=? and who not in ('session input','session configuration','model input') order by id desc limit 15", args!(id));
            let messages = hive.db.all("select id, at, from_task, to_task, kind, hops, text from messages where from_task=? or to_task=? order by id desc limit 10", args!(id, id));
            Ok(json!({ "task": task, "worker": worker, "recent_log": log, "messages": messages }))
        }
        "request" => {
            let req = hive.db.get("select * from requests where id=?", args!(id)).ok_or(format!("no request #{id}"))?;
            let tasks = hive.db.all("select id, title, project, status, nodes, outcome, why, need from tasks where request_id=? order by id", args!(id));
            let followups = hive.db.all("select id, task_id, at, text from log where (request_id=? or task_id in (select id from tasks where request_id=?)) and who='owner' order by id desc limit 15", args!(id, id));
            Ok(json!({ "request": req, "tasks": tasks, "followups": followups }))
        }
        "rules" => {
            let prefix = name.trim();
            let rows = if prefix.is_empty() {
                hive.db.all("select id, text, scope, quote from rules where active=1 order by id", &[])
            } else {
                hive.db.all("select id, text, scope, quote from rules where active=1 and lower(scope) like lower(?) order by id", args!(format!("{prefix}%")))
            };
            Ok(json!({ "rules": rows }))
        }
        "worker" => {
            if id <= 0 {
                let workers = hive.db.all("select a.id, a.role, a.kind, a.name, a.status, a.task_id, a.model, t.title, t.project from agents a left join tasks t on t.id=a.task_id where a.status in ('working','idle') order by a.id desc limit 20", &[]);
                return Ok(json!({ "workers": workers, "locks": hive.locks() }));
            }
            let worker = hive.db.get("select id, role, kind, name, status, task_id, model, effort, updated from agents where id=?", args!(id)).ok_or(format!("no worker #{id}"))?;
            let tasks = hive.db.all("select id, title, project, status, updated from tasks where agent_id=? order by id desc limit 5", args!(id));
            Ok(json!({ "worker": worker, "tasks": tasks }))
        }
        other => Err(format!("unknown inspect kind '{other}' (use project, task, request, rules, or worker)")),
    }
}

// ---- Capability Grant & Control Plane ----

/// Control-plane grant of extra device/node capabilities to an existing task (worker refreshes tools on next turn).
pub fn grant_nodes(hive: &Hive, actor: Actor, task_id: i64, extra: &[String]) -> Result<Vec<String>, String> {
    if !actor.is_control_plane() { return Err("Only the owner or orchestrator can grant additional nodes to a task.".into()); }
    let task = hive.db.get("select nodes from tasks where id=?", args!(task_id)).ok_or(format!("no task #{task_id}"))?;
    let mut nodes = list(&task["nodes"]);
    let allowed = hive.kinds();
    for n in extra {
        let n = n.trim();
        if !n.is_empty() && allowed.iter().any(|k| k == n) && !nodes.iter().any(|k| k == n) {
            nodes.push(n.to_string());
        }
    }
    hive.db.run("update tasks set nodes=?, updated=? where id=?", args!(json!(nodes).to_string(), now(), task_id));
    hive.log(0, task_id, 0, "hive", &format!("Granted nodes {:?} to task #{task_id}", nodes));
    hive.bump();
    Ok(nodes)
}

// ---- Structured Agent Communication ----

/// Bounded, typed worker-to-worker handoff (same project or request, max 2 hops, logged to orchestrator).
pub fn handoff(hive: &Arc<Hive>, actor: Actor, to_task: i64, kind: &str, text: &str) -> Result<String, String> {
    let text = text.trim();
    if to_task <= 0 || text.is_empty() { return Err("Give the target task id and handoff text.".into()); }
    if to_task == actor.task_id { return Err("Cannot hand off to your own task.".into()); }
    let kind = match kind.trim() {
        "" | "fact" => "fact",
        "artifact" => "artifact",
        "lock_release" => "lock_release",
        "question" => "question",
        other => return Err(format!("invalid handoff kind '{other}' (use artifact, fact, lock_release, or question)")),
    };
    let target = hive.db.get("select id, project, request_id, status, agent_id from tasks where id=?", args!(to_task))
        .ok_or(format!("there's no task #{to_task}"))?;
    if !matches!(s(&target["status"]).as_str(), "open" | "queued" | "working" | "needs" | "idle") {
        return Err(format!("task #{to_task} is {}, not active", s(&target["status"])));
    }
    if actor.role == Role::Worker && actor.task_id > 0 {
        let src = hive.db.get("select project, request_id from tasks where id=?", args!(actor.task_id)).unwrap_or(json!({}));
        let (sp, tp) = (s(&src["project"]).trim().to_string(), s(&target["project"]).trim().to_string());
        let (sr, tr) = (src["request_id"].as_i64().unwrap_or(0), target["request_id"].as_i64().unwrap_or(0));
        let same_project = !sp.is_empty() && sp.eq_ignore_ascii_case(&tp);
        let same_request = sr > 0 && sr == tr;
        if !sp.is_empty() && !tp.is_empty() && !same_project && !same_request {
            return Err(format!("Handoffs stay within the same project or request (yours is '{sp}', task #{to_task} is '{tp}'). Use request_help so the orchestrator can coordinate across projects."));
        }
        // Count hops between this pair since the last owner/orchestrator intervention on either task.
        let reset_at = hive.db.get("select coalesce(max(at),0) as at from log where task_id in (?,?) and who in ('owner','hive')",
            args!(actor.task_id, to_task)).and_then(|r| r["at"].as_i64()).unwrap_or(0);
        let hops = hive.db.get("select count(*) as n from messages where at>? and ((from_task=? and to_task=?) or (from_task=? and to_task=?))",
            args!(reset_at, actor.task_id, to_task, to_task, actor.task_id)).and_then(|r| r["n"].as_i64()).unwrap_or(0);
        if hops >= MAX_HANDOFF_HOPS {
            return Err(format!("Handoff hop limit ({MAX_HANDOFF_HOPS}) reached between task #{} and #{to_task}. Use request_help so the orchestrator can resolve it.", actor.task_id));
        }
        let hop = hops + 1;
        let envelope = format!("[handoff:{kind} from worker on task #{} (hop {hop}/{MAX_HANDOFF_HOPS})]: {text}", actor.task_id);
        hive.db.run("insert into messages(at, from_agent, from_task, to_task, kind, hops, text) values(?,?,?,?,?,?,?)",
            args!(now(), actor.agent_id, actor.task_id, to_task, kind, hop, text));
        hive.log(0, to_task, 0, "handoff", &format!("#{} -> #{to_task} [{kind} hop {hop}/{MAX_HANDOFF_HOPS}]: {}", actor.task_id, short(text, 400)));
        if target["agent_id"].is_null() {
            hive.bump();
            return Ok(format!("Queued {kind} handoff (hop {hop}/{MAX_HANDOFF_HOPS}) for task #{to_task} (delivered when its worker starts)."));
        }
        hive.message_task(to_task, 0, &envelope, &format!("worker #{}", actor.task_id))?;
        return Ok(format!("Delivered {kind} handoff (hop {hop}/{MAX_HANDOFF_HOPS}) to worker on task #{to_task}."));
    }
    hive.message_task(to_task, 0, text, "orchestrator")?;
    Ok(format!("Delivered to worker on task #{to_task}."))
}

/// Worker escalation to the orchestrator agent (bounded per task to prevent runaway churn).
pub fn request_help(hive: &Hive, actor: Actor, kind: &str, text: &str, node: &str) -> Result<String, String> {
    let text = text.trim();
    if text.is_empty() { return Err("Explain what you need from the orchestrator.".into()); }
    let kind = match kind.trim() {
        "" | "orchestrator" => "orchestrator",
        "capability" => "capability",
        "propose_task" => "propose_task",
        other => return Err(format!("invalid help kind '{other}' (use orchestrator, capability, or propose_task)")),
    };
    let node = node.trim();
    if kind == "capability" && node.is_empty() {
        return Err("Name the needed node kind (e.g. phone, mac, browser, hive) when kind='capability'.".into());
    }
    if actor.task_id > 0 {
        let count = hive.db.get("select count(*) as n from messages where from_task=? and to_task=0", args!(actor.task_id))
            .and_then(|r| r["n"].as_i64()).unwrap_or(0);
        if count >= MAX_HELP_PER_TASK {
            return Err(format!("Orchestrator help limit ({MAX_HELP_PER_TASK}) reached for task #{}. Finish or end with done=false if blocked on the owner.", actor.task_id));
        }
    }
    let msg_kind = format!("help:{kind}");
    hive.db.run("insert into messages(at, from_agent, from_task, to_task, kind, hops, text) values(?,?,?,0,?,1,?)",
        args!(now(), actor.agent_id, actor.task_id, msg_kind, text));
    let ctx = json!({ "from_task": actor.task_id, "help_kind": kind, "requested_node": node });
    let prompt = match kind {
        "capability" => format!("Worker on task #{} requests extra node capability '{node}': {text}", actor.task_id),
        "propose_task" => format!("Worker on task #{} proposes a separate follow-up task: {text}", actor.task_id),
        _ => format!("Worker on task #{} asks the orchestrator: {text}", actor.task_id),
    };
    let rid = hive.db.run("insert into requests(at, node, agent, text, context) values(?,?,?,?,?)",
        args!(now(), format!("worker:#{}", actor.task_id), "", prompt, ctx));
    hive.log(0, actor.task_id, rid, "worker", &format!("Escalated ({kind}): {}", short(text, 400)));
    hive.bump();
    Ok(format!("Escalated to the orchestrator (request #{rid}). Continue other independent work or wait for its steer."))
}

// ---- Harness / Self-Improvement ----

pub fn sim_op(hive: &Hive, actor: Actor, a: &Value) -> Result<Value, String> {
    let model = hive.db.get("select model from agents where id=?", args!(actor.agent_id)).map(|r| s(&r["model"])).unwrap_or_default();
    let commit = hive.repo.as_deref().map(crate::vm::head_sha).unwrap_or_default();
    match s(&a["mode"]).as_str() {
        "" | "read" => {
            let days = a["days"].as_i64().filter(|d| *d > 0).unwrap_or(7);
            Ok(json!(format!("{}\n\n{}", sim::format(&hive.db, hive.repo.as_deref()), sim::friction(&hive.db, days))))
        }
        "propose" => {
            let id = sim::propose(&hive.db, hive.repo.as_deref(), hive.engine_name(), &model, &commit, a)?;
            hive.bump();
            Ok(json!(format!("Recorded SIM attempt #{id}. Pass sim_id={id} to reinstall, then record outcome.")))
        }
        "outcome" => {
            sim::outcome(&hive.db, a["id"].as_i64().unwrap_or(0), &s(&a["fixed"]), &s(&a["missed"]), &s(&a["status"]))?;
            hive.bump();
            Ok(json!("Updated SIM outcome."))
        }
        "export" => sim::export_line(&hive.db, a["id"].as_i64().unwrap_or(0)).map(|l| json!(l)),
        other => Err(format!("unknown sim mode '{other}' (use read, propose, outcome, or export)")),
    }
}

pub fn reinstall(hive: &Hive, actor: Actor, sim_id: i64) -> Result<crate::vm::Reinstall, (i64, i64, String, String)> {
    let repo = hive.repo.as_ref().ok_or((0, 0, String::new(), "Hive isn't on a VM here".to_string()))?;
    if actor.role == Role::Worker && actor.agent_id > 0 {
        hive.take_lock("repo:hive", actor.agent_id).map_err(|e| (0, 0, String::new(), e))?;
    }
    match crate::vm::reinstall(repo) {
        Ok(r) => {
            sim::record_eval(&hive.db, sim_id, true, r.passed, r.total, &r.commit);
            Ok(r)
        }
        Err((passed, total, commit, e)) => {
            if total > 0 { sim::record_eval(&hive.db, sim_id, false, passed, total, &commit); }
            Err((passed, total, commit, e))
        }
    }
}
