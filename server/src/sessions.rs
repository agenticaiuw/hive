//! Authenticated transcript ingestion. Provider identities keep chats isolated; source offsets make retries harmless.
use crate::{args, db::now, hive::Hive};
use serde_json::{json, Map, Value};
use std::sync::Mutex;
static INGEST: Mutex<()> = Mutex::new(());
pub fn ingest(h: &Hive, b: &Value) -> Result<Value, String> {
    let _guard = INGEST.lock().unwrap();
    let name=b["session"].as_str().unwrap_or("");
    if !(name.starts_with("claude:") || name.starts_with("codex:")) || name.len()<10 { return Err("Missing provider session identity".into()) }
    let source=b["source"].as_str().ok_or("Missing transcript source")?;
    let events=b["events"].as_array().ok_or("Missing events")?;
    if events.len()>500 { return Err("Too many events".into()) }
    let agent=h.db.get("select * from agents where kind='claude' and name=?",args!(name));
    let aid=agent.as_ref().and_then(|a|a["id"].as_i64()).unwrap_or_else(|| h.db.run("insert into agents(kind,role,name,status,at,updated) values('claude','external',?,'idle',?,0)",args!(name,now())));
    let mut cursors: Map<String, Value> = agent.as_ref()
        .and_then(|a| a["cursors"].as_str())
        .and_then(|raw| serde_json::from_str(raw).ok())
        .unwrap_or_default();
    let mut high = cursors.get(source).and_then(|v| v.as_u64());
    // Transcripts are session activity, not owner-created work. Keep their history,
    // but attach it to a task only after the session explicitly saves one in Hive.
    let task=h.db.get("select t.id from tasks t where t.agent_id=? and coalesce(t.quote,'')!='Imported session' order by t.id desc limit 1",args!(aid))
        .and_then(|t|t["id"].as_i64()).unwrap_or(0);
    let mut writes = Vec::new();
    for e in events {
        let key=e["key"].as_u64().ok_or("Missing event offset")?;
        if high.is_some_and(|m| key <= m) { continue }
        high = Some(key);
        let at=h.db.get("select cast((julianday(?)-2440587.5)*86400000 as integer) as at",args!(e["timestamp"])).and_then(|r|r["at"].as_i64()).unwrap_or(0);
        let who=e["who"].as_str().unwrap_or("");
        let text=e["text"].as_str().unwrap_or("");
        if matches!(who,"owner"|"agent"|"tool"|"tool result") && !text.is_empty() {
            writes.push(("insert into log(at,agent_id,task_id,request_id,who,text) values(?,?,?,0,?,?)",args!(at,aid,task,who,text).to_vec()));
        }
        let status=if e["status"]=="working" && at>now()-120_000 {"working"} else {"idle"};
        writes.push(("update agents set status=?,updated=? where id=? and coalesce(updated,0)<=?",args!(status,at,aid,at).to_vec()));
        writes.push(("update tasks set status=?,updated=? where id=? and status in ('idle','working') and coalesce(updated,0)<=?",args!(status,at,task,at).to_vec()));
    }
    if let Some(m) = high {
        cursors.insert(source.to_string(), json!(m));
        writes.push(("update agents set cursors=? where id=?", args!(Value::Object(cursors).to_string(), aid).to_vec()));
    }
    h.db.batch(&writes)?;
    h.bump(); Ok(json!({"ok":true,"agent":aid,"task":task}))
}

#[cfg(test)] mod tests {
    use super::*;
    #[test] fn imports_once_and_keeps_provider_sessions_separate() {
        let state=std::env::temp_dir().join(format!("hive-stream-{}",std::process::id()));
        std::fs::create_dir_all(&state).unwrap();
        let h=Hive::new(crate::db::Db::open(":memory:"),state.clone(),None,crate::hive::Engine::Codex{cmd:String::new(),env:vec![]},String::new(),String::new());
        let b=json!({"session":"claude:session-one","source":"one.jsonl","folder":"/work/project","events":[{"key":0,"timestamp":"2020-01-01T00:00:00Z","who":"agent","text":"First answer","status":"working"}]});
        let a=ingest(&h,&b).unwrap(); ingest(&h,&b).unwrap();
        assert_eq!(h.db.all("select * from log",&[]).len(),1);
        assert_eq!(h.db.get("select status from agents where id=?",args!(a["agent"])).unwrap()["status"],"idle");
        let mut second=b.clone();second["session"]=json!("codex:session-two");
        let other=ingest(&h,&second).unwrap(); assert_ne!(a["agent"],other["agent"]);
        assert_eq!(a["task"],0);
        assert!(h.db.all("select * from tasks",&[]).is_empty());
        assert_eq!(h.db.all("select * from log where agent_id=?",args!(a["agent"])).len(),1);
        let tid=h.db.run("insert into tasks(title,quote,agent_id,status) values('Repair build','fix the build',?,'done')",args!(a["agent"]));
        let mut next=b.clone(); next["events"][0]["key"]=json!(1);
        assert_eq!(ingest(&h,&next).unwrap()["task"],tid);
        assert_eq!(h.db.all("select * from log where task_id=?",args!(tid)).len(),1);
        assert_eq!(h.db.get("select status from tasks where id=?",args!(tid)).unwrap()["status"],"done");
        std::fs::remove_dir_all(state).unwrap();
    }
}
