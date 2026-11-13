//! hive-ask: give Hive a task and follow it live, for other agents such as Claude Code.
//!
//!   hive-ask [--wait MINUTES] [--source-id ID] [--json] TEXT...   send TEXT, follow it to the end
//!   hive-ask --no-follow TEXT...                                  send it, print its receipt
//!   hive-ask --follow RECEIPT|latest [--from-end] [--json]        follow a request already sent
//!
//! TEXT of "-" is read from stdin. The request goes to `<state>/control/request.sock`, as every
//! local request does; what Hive then says and does for it is read from
//! `<state>/control/live/<receipt>.jsonl` (src/live.rs) and printed as it happens, with
//! Agent.log's marks (💬 its words, → its steps, ⏸ paused while you have the mouse and keyboard).
//!
//! Exit status: 0 done, 3 it stopped and needs you, 1 failed, 2 stopped, 4 still going when
//! --wait (default 120 minutes) ran out, 5 not accepted or acceptance unknown, 64 usage.
//!
//! Run it in the background (Claude Code: run_in_background) and you're told when it ends.

use hive_app::live::{self, Live};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const USAGE: &str = "usage: hive-ask [--wait MINUTES] [--source-id ID] [--json] [--no-follow] TEXT...\n       hive-ask --follow RECEIPT|latest [--from-end] [--wait MINUTES] [--json]\nTEXT of - is read from stdin.";

struct Options {
    text: Vec<String>,
    follow: Option<String>,
    no_follow: bool,
    from_end: bool,
    json: bool,
    wait: Duration,
    source_id: Option<String>,
}

fn parse(args: &[String]) -> Result<Options, String> {
    let mut o = Options {
        text: Vec::new(),
        follow: None,
        no_follow: false,
        from_end: false,
        json: false,
        wait: Duration::from_secs(120 * 60),
        source_id: None,
    };
    let mut args = args.iter();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--follow" => o.follow = Some(args.next().ok_or("--follow needs a receipt")?.clone()),
            "--no-follow" => o.no_follow = true,
            "--from-end" => o.from_end = true,
            "--json" => o.json = true,
            "--wait" => {
                let minutes: f64 = args
                    .next()
                    .and_then(|m| m.parse().ok())
                    .filter(|m: &f64| *m > 0.0)
                    .ok_or("--wait takes minutes")?;
                o.wait = Duration::from_secs_f64(minutes * 60.0);
            }
            "--source-id" => {
                o.source_id = Some(args.next().ok_or("--source-id needs an id")?.clone())
            }
            "-h" | "--help" => return Err(String::new()),
            "--" => o.text.extend(args.by_ref().cloned()),
            flag if flag.starts_with("--") => return Err(format!("unknown option {flag}")),
            word => o.text.push(word.to_owned()),
        }
    }
    if o.follow.is_some() != o.text.is_empty() {
        return Err("give TEXT to send, or --follow RECEIPT".into());
    }
    Ok(o)
}

fn socket() -> PathBuf {
    hive_common::state_dir()
        .join("control")
        .join("request.sock")
}

/// Sends the request; its receipt, or why not (and whether it may have been accepted anyway).
fn send(text: &str, source_id: &str) -> Result<String, String> {
    let mut stream = UnixStream::connect(socket())
        .map_err(|e| format!("Hive isn't taking requests ({}): {e}", socket().display()))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(8)))
        .map_err(|e| e.to_string())?;
    let mut line = json!({"text": text, "sourceId": source_id}).to_string();
    line.push('\n');
    if line.len() > 16384 {
        return Err("the request is longer than Hive takes (16 KB)".into());
    }
    stream
        .write_all(line.as_bytes())
        .map_err(|e| format!("couldn't send it ({e}); whether Hive took it is unknown"))?;
    let mut reply = String::new();
    BufReader::new(stream.take(16384))
        .read_line(&mut reply)
        .map_err(|e| format!("no answer ({e}); whether Hive took it is unknown"))?;
    let reply: Value = serde_json::from_str(reply.trim())
        .map_err(|_| "an answer that isn't JSON; whether Hive took it is unknown".to_owned())?;
    let receipt = reply
        .get("receiptId")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let repeat = reply.get("error").and_then(Value::as_str)
        == Some("Request already received; no repeat was started.");
    match (reply.get("ok").and_then(Value::as_bool), receipt) {
        (Some(true), Some(receipt)) => Ok(receipt),
        (_, Some(receipt)) if repeat => Ok(receipt),
        (_, receipt) => Err(format!(
            "not accepted: {}{}",
            reply
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("no reason given"),
            receipt
                .map(|r| format!(" (receipt {r})"))
                .unwrap_or_default()
        )),
    }
}

fn exit_code(event: &Value) -> i32 {
    match event.get("kind").and_then(Value::as_str) {
        Some("done") => 0,
        Some("needs_you") => 3,
        Some("stopped") => 2,
        _ => 1,
    }
}

/// Prints the request's events as they come; the exit status of its last one, or 4.
fn follow(receipt: &str, from_end: bool, json: bool, wait: Duration) -> i32 {
    let live = Live::default();
    let path = live.path(receipt);
    let started = Instant::now();
    let mut offset = if from_end {
        std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0)
    } else {
        0
    };
    let mut told_waiting = false;
    loop {
        let (events, next) = live::read_from(&path, offset);
        offset = next;
        for event in &events {
            if json {
                println!("{event}");
            } else {
                println!("{}", live::display(event));
            }
            if live::ends(event) {
                return exit_code(event);
            }
        }
        let _ = std::io::stdout().flush();
        if started.elapsed() >= wait {
            eprintln!("hive-ask: still going after the wait; follow it again with: hive-ask --follow {receipt}");
            return 4;
        }
        if offset == 0 && !told_waiting && started.elapsed() > Duration::from_secs(10) {
            eprintln!("hive-ask: Hive took the request ({receipt}) but hasn't started it yet");
            told_waiting = true;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let o = match parse(&args) {
        Ok(o) => o,
        Err(e) => {
            if !e.is_empty() {
                eprintln!("hive-ask: {e}");
            }
            eprintln!("{USAGE}");
            std::process::exit(if e.is_empty() { 0 } else { 64 });
        }
    };
    if let Some(receipt) = &o.follow {
        let receipt = if receipt == "latest" {
            match Live::default().latest() {
                Some(r) => r,
                None => {
                    eprintln!("hive-ask: no requests yet");
                    std::process::exit(5);
                }
            }
        } else {
            receipt.clone()
        };
        if !live::valid_receipt(&receipt) {
            eprintln!("hive-ask: not a receipt: {receipt}");
            std::process::exit(64);
        }
        std::process::exit(follow(&receipt, o.from_end, o.json, o.wait));
    }
    let mut text = o.text.join(" ");
    if text == "-" {
        text.clear();
        if std::io::stdin().read_to_string(&mut text).is_err() {
            eprintln!("hive-ask: couldn't read stdin");
            std::process::exit(64);
        }
    }
    let text = text.trim();
    if text.is_empty() {
        eprintln!("{USAGE}");
        std::process::exit(64);
    }
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let source_id = o
        .source_id
        .clone()
        .unwrap_or_else(|| format!("hive-ask-{}-{nanos}", std::process::id()));
    match send(text, &source_id) {
        Ok(receipt) => {
            println!("Sent to Hive (receipt {receipt}).");
            if o.no_follow {
                return;
            }
            std::process::exit(follow(&receipt, false, o.json, o.wait));
        }
        Err(e) => {
            eprintln!("hive-ask: {e}");
            std::process::exit(5);
        }
    }
}
