//! A home computer has no public address, so its Hive keeps a long poll open at the relay (relay/) and answers each request
//! that arrives there. Requests come as plain HTTP and answers go back the same way.
use crate::http::{self, Req, Res};
use std::io::Read;
use std::sync::Arc;
use std::time::Duration;

pub fn start(address: String, key: String, handler: Arc<dyn Fn(Req) -> Res + Send + Sync>) {
    let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(60)).build();
    std::thread::spawn(move || loop {
        match agent.post(&format!("{address}/.relay/poll")).set("x-hive-key", &key).send_bytes(&[]) {
            Ok(r) if r.status() == 200 => {
                let rid = r.header("x-rid").unwrap_or("").to_string();
                let mut raw = vec![];
                r.into_reader().take(100 << 20).read_to_end(&mut raw).ok();
                let (agent, address, key, handler) = (agent.clone(), address.clone(), key.clone(), handler.clone());
                std::thread::spawn(move || {
                    let res = http::parse(&mut raw.as_slice(), 100 << 20).map(|req| handler(req)).unwrap_or_else(|| Res::err(400, "bad request"));
                    let mut out = vec![];
                    http::write(&mut out, &res).ok();
                    agent.post(&format!("{address}/.relay/reply")).set("x-hive-key", &key).set("x-rid", &rid).send_bytes(&out).ok();
                });
            }
            Ok(_) => {}
            Err(e) => { eprintln!("relay: {e}"); std::thread::sleep(Duration::from_secs(5)); }
        }
    });
}
