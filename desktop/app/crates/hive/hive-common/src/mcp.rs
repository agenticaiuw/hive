//! A minimal MCP server over stdio (python/mac_mcp.py's `Server` and `main`), usable by any set of
//! tools: one JSON-RPC message per line in, one reply per line out. It answers `initialize`,
//! `ping`, `tools/list` and `tools/call`; notifications (no id) get no reply.
//!
//! Also what python/phone_mcp.py borrowed from mac_mcp.py: the `screenshot` argument every action
//! takes ([`look_schema`]), the `batch` tool ([`batch_tool`], [`run_batch`]) and python's `repr()`
//! of a string, which the tools' messages quote names with ([`py_repr`]).

use crate::tools::{result, text, texts, ToolNamespace};
use serde_json::{json, Map, Value};
use std::io::{BufRead, Write};
use std::sync::Arc;
use std::time::Duration;

pub const PROTOCOL_VERSIONS: [&str; 3] = ["2025-06-18", "2025-03-26", "2024-11-05"];

/// Seconds the screen gets to catch up before the screenshot that follows a batch.
pub const SETTLE: Duration = Duration::from_millis(300);

type Call = dyn Fn(&str, &Value) -> Result<Value, String> + Send + Sync;

/// An MCP server for one set of tools.
pub struct Server {
    call: Box<Call>,
    pub tool_list: Vec<Value>,
    pub name: String,
    pub instructions: String,
}

impl Server {
    /// `call(name, arguments)` runs a tool and returns its MCP result; `Err` is reported to the
    /// model as "Tool error: ..." rather than failing the request.
    pub fn new(
        call: impl Fn(&str, &Value) -> Result<Value, String> + Send + Sync + 'static,
        tool_list: Vec<Value>,
        name: &str,
        instructions: &str,
    ) -> Server {
        Server {
            call: Box::new(call),
            tool_list,
            name: name.into(),
            instructions: instructions.into(),
        }
    }

    /// A server for a device's tools (its `tools()` list, its `call`).
    pub fn for_namespace(tools: Arc<dyn ToolNamespace>, name: &str, instructions: &str) -> Server {
        let list = tools.tools();
        Server::new(
            move |tool, args| tools.call(tool, args),
            list,
            name,
            instructions,
        )
    }

    /// The reply to one message, or None for a notification.
    pub fn handle(&self, msg: &Value) -> Option<Value> {
        let id = msg.get("id").filter(|id| !id.is_null())?.clone();
        let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
        match method {
            "initialize" => {
                let asked = msg
                    .pointer("/params/protocolVersion")
                    .and_then(Value::as_str);
                let version = asked
                    .filter(|v| PROTOCOL_VERSIONS.contains(v))
                    .unwrap_or(PROTOCOL_VERSIONS[0]);
                Some(reply(
                    id,
                    json!({
                        "protocolVersion": version,
                        "capabilities": {"tools": {"listChanged": false}},
                        "serverInfo": {"name": self.name, "version": "1.0"},
                        "instructions": self.instructions,
                    }),
                ))
            }
            "ping" => Some(reply(id, json!({}))),
            "tools/list" => Some(reply(id, json!({"tools": self.tool_list}))),
            "tools/call" => {
                let params = msg.get("params").cloned().unwrap_or(Value::Null);
                let name = params
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let args = match params.get("arguments") {
                    None | Some(Value::Null) => json!({}),
                    Some(a) => a.clone(),
                };
                let ran = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    (self.call)(&name, &args)
                }));
                let res = match ran {
                    Ok(Ok(res)) => res,
                    Ok(Err(e)) => {
                        eprintln!("[{}] {name} failed: {e}", self.name);
                        result(vec![text(format!("Tool error: {e}"))], true)
                    }
                    Err(panic) => {
                        let e = panic_message(&panic);
                        eprintln!("[{}] {name} panicked: {e}", self.name);
                        result(vec![text(format!("Tool error: {e}"))], true)
                    }
                };
                Some(reply(id, res))
            }
            _ => Some(json!({"jsonrpc": "2.0", "id": id,
                             "error": {"code": -32601, "message": format!("no method {method}")}})),
        }
    }

    /// The reply line (without the newline) to one line read, or None.
    pub fn handle_line(&self, raw: &str) -> Option<String> {
        let raw = raw.trim();
        if raw.is_empty() {
            return None;
        }
        let reply = match serde_json::from_str::<Value>(raw) {
            Err(_) => Some(
                json!({"jsonrpc": "2.0", "id": null, "error": {"code": -32700, "message": "parse error"}}),
            ),
            Ok(Value::Array(batch)) => {
                let replies: Vec<Value> = batch.iter().filter_map(|m| self.handle(m)).collect();
                (!replies.is_empty()).then(|| Value::Array(replies))
            }
            Ok(msg) => self.handle(&msg),
        };
        reply.map(|r| r.to_string())
    }

    /// Answers every line of `input` on `output` until `input` ends.
    pub fn serve(&self, input: impl BufRead, mut output: impl Write) -> std::io::Result<()> {
        for line in input.lines() {
            if let Some(reply) = self.handle_line(&line?) {
                writeln!(output, "{reply}")?;
                output.flush()?;
            }
        }
        Ok(())
    }

    /// [`Server::serve`] on this process's stdin and stdout.
    pub fn serve_stdio(&self) -> std::io::Result<()> {
        self.serve(std::io::stdin().lock(), std::io::stdout().lock())
    }
}

fn reply(id: Value, res: Value) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "result": res})
}

fn panic_message(panic: &Box<dyn std::any::Any + Send>) -> String {
    panic
        .downcast_ref::<String>()
        .cloned()
        .or_else(|| panic.downcast_ref::<&str>().map(|s| s.to_string()))
        .unwrap_or_else(|| "panic".into())
}

/// The `screenshot` argument of every action (mac_mcp.py's LOOK).
pub fn look_schema() -> Value {
    json!({"type": "boolean", "default": true,
           "description": "Return a screenshot taken just after the action (default true)."})
}

/// The `batch` tool for a device whose batchable tools are `batchable`.
pub fn batch_tool(batchable: &[&str], example: &str) -> Value {
    json!({
        "name": "batch",
        "description": format!(
            "Do several actions in a row and get one screenshot at the end. Use it whenever you already know \
             the next steps; each separate call costs the user seconds. Each step is {{\"tool\": name, ...that \
             tool's arguments}}, the tool being one of {}. For example: {example}. Stops at the first step that \
             fails.", batchable.join(", ")),
        "inputSchema": {"type": "object", "properties": {
            "steps": {"type": "array", "minItems": 1, "maxItems": 20, "items": {
                "type": "object", "properties": {"tool": {"type": "string", "enum": batchable}},
                "required": ["tool"]}},
            "step": {"type": "string", "description": format!(
                "What the whole batch does, the way `step` says it for one action. {STEP_DESCRIPTION}")},
            "screenshot": look_schema(),
        }, "required": ["step", "steps"]},
    })
}

/// What a `step` argument is (mac_mcp.py's STEP): every action that changes something says what it
/// does, and one that can't be undone is marked "One-way:" and quotes the user's words for it.
pub const STEP_DESCRIPTION: &str = r#"Shown to the user as you act: one short sentence of what this does, e.g. "Opening the #general channel." If it can't be undone (it sends or posts something others will see, deletes data, pays or publishes), begin with "One-way:" and quote the user's own words that ask for it, e.g. "One-way: posting your message in #general (you said: \"send the backup to the general channel\").""#;

/// The `step` argument of an action (mac_mcp.py's STEP).
pub fn step_schema() -> Value {
    json!({"type": "string", "description": STEP_DESCRIPTION})
}

/// Lowercase words only, so a quote compares with what the user said whatever the punctuation
/// (mac_mcp.py's `said`).
pub fn said(words: &str) -> String {
    static WORD: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let word = WORD.get_or_init(|| regex::Regex::new(r"\w+(?:'\w+)*").expect("word pattern"));
    let lower = words.replace('\u{2019}', "'").to_lowercase();
    word.find_iter(&lower)
        .map(|m| m.as_str())
        .collect::<Vec<_>>()
        .join(" ")
}

/// Refuses a step marked one-way that doesn't quote the user's words for it (mac_mcp.py's
/// `check_step`). The agent says what each action does and whether it can be undone; this only
/// checks that the quote is really something the user said (`words`: their requests in this
/// conversation). `None` lets the action go ahead; `Some` is the refusal, before any input.
pub fn check_step(args: &Value, words: &str) -> Option<Value> {
    static QUOTE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let step = match args.get("step") {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(v) if !truthy(v) => String::new(),
        Some(v) => py_value_repr(v),
    };
    if !step.to_lowercase().trim_start().starts_with("one-way") {
        return None;
    }
    let quote = QUOTE.get_or_init(|| {
        regex::Regex::new("[\"\u{201C}]([^\"\u{201C}\u{201D}]{3,})[\"\u{201D}]")
            .expect("quote pattern")
    });
    let quotes: Vec<&str> = quote
        .captures_iter(&step)
        .filter_map(|c| c.get(1))
        .map(|m| m.as_str())
        .collect();
    let heard = format!(" {} ", said(words));
    if quotes.iter().any(|q| {
        let q = said(q);
        !q.is_empty() && heard.contains(&format!(" {q} "))
    }) {
        return None;
    }
    let listed = if quotes.is_empty() {
        py_repr("your quotes")
    } else {
        format!(
            "[{}]",
            quotes
                .iter()
                .map(|q| py_repr(q))
                .collect::<Vec<_>>()
                .join(", ")
        )
    };
    Some(result(
        vec![text(format!(
            "Refused: a one-way step (it can't be undone) needs the user's own words asking for it, quoted \
             exactly in `step`, and none of {listed} is something the user said. If they asked for it, quote \
             their words; if they didn't, don't do it: find a way that can be undone, or stop and ask them, \
             saying exactly what you'd do and where."
        ))],
        true,
    ))
}

/// Runs `args["steps"]` through `call` without screenshots, then looks once with `look(note)`
/// (after [`SETTLE`]). An `authenticate` step only runs alone and without arguments: that is how a
/// conversation whose saved tool list predates the authenticate tool can still use it.
pub fn run_batch(
    call: &mut dyn FnMut(&str, &Value) -> Result<Value, String>,
    look: &mut dyn FnMut(&str) -> Result<Value, String>,
    args: &Value,
    batchable: &[&str],
) -> Result<Value, String> {
    let steps: Vec<Value> = args
        .get("steps")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if steps
        .iter()
        .any(|s| s.get("tool").and_then(Value::as_str) == Some("authenticate"))
    {
        let alone = steps.len() == 1 && steps[0].as_object().is_some_and(|o| o.len() == 1);
        if !alone {
            return Ok(result(
                vec![text(
                    "authenticate can't be combined with other steps or given arguments; send it as the only step: \
                     [{\"tool\": \"authenticate\"}].",
                )],
                true,
            ));
        }
        return call("authenticate", &json!({}));
    }
    let mut done: Vec<String> = Vec::new();
    for (i, step) in steps.iter().enumerate() {
        let i = i + 1;
        let Some(step) = step.as_object() else {
            return Err(format!("Step {i} is not an object: {step}"));
        };
        let mut step: Map<String, Value> = step.clone();
        let name = step.remove("tool").unwrap_or_else(|| json!(""));
        let name = match name.as_str() {
            Some(n) if batchable.contains(&n) => n.to_string(),
            _ => {
                let shown = py_value_repr(&name);
                return Ok(result(
                    vec![text(format!(
                        "Step {i}: {shown} can't go in a batch (use one of {}).",
                        batchable.join(", ")
                    ))],
                    true,
                ));
            }
        };
        step.insert("screenshot".into(), json!(false));
        let res = call(&name, &Value::Object(step))?;
        if res.get("isError").and_then(Value::as_bool).unwrap_or(false) {
            let why = texts(&res);
            let before = if done.is_empty() {
                String::new()
            } else {
                format!(" after {}", done.join(", "))
            };
            return Ok(result(
                vec![text(format!("Step {i} ({name}) failed{before}: {why}"))],
                true,
            ));
        }
        done.push(name);
    }
    let note = format!("Did {} steps: {}.", done.len(), done.join(", "));
    if args.get("screenshot").map(truthy).unwrap_or(true) {
        std::thread::sleep(SETTLE);
        return look(&note);
    }
    Ok(result(vec![text(note)], false))
}

/// Python's truth value of a JSON value (`args.get("screenshot", True)`).
pub fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0),
        Value::String(s) => !s.is_empty(),
        Value::Array(a) => !a.is_empty(),
        Value::Object(o) => !o.is_empty(),
    }
}

/// Python's `repr()` of a string: 'single quotes' unless it has ' and no ".
pub fn py_repr(s: &str) -> String {
    let quote = if s.contains('\'') && !s.contains('"') {
        '"'
    } else {
        '\''
    };
    let mut out = String::with_capacity(s.len() + 2);
    out.push(quote);
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c == quote => {
                out.push('\\');
                out.push(c);
            }
            c if !py_printable(c) => {
                let n = c as u32;
                if n < 0x100 {
                    out.push_str(&format!("\\x{n:02x}"));
                } else if n < 0x10000 {
                    out.push_str(&format!("\\u{n:04x}"));
                } else {
                    out.push_str(&format!("\\U{n:08x}"));
                }
            }
            c => out.push(c),
        }
    }
    out.push(quote);
    out
}

/// Python's `repr()` of a JSON value, for the few messages that show one.
pub fn py_value_repr(v: &Value) -> String {
    match v {
        Value::String(s) => py_repr(s),
        Value::Null => "None".into(),
        Value::Bool(true) => "True".into(),
        Value::Bool(false) => "False".into(),
        other => other.to_string(),
    }
}

fn py_printable(c: char) -> bool {
    !(c.is_control()
        || matches!(c, '\u{a0}' | '\u{ad}' | '\u{1680}' | '\u{2000}'..='\u{200f}' | '\u{2028}'..='\u{202f}'
            | '\u{205f}'..='\u{206f}' | '\u{3000}' | '\u{feff}' | '\u{fff9}'..='\u{fffb}'))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::ok_text;

    fn server() -> Server {
        let tools = vec![
            json!({"name": "echo", "description": "Echo.", "inputSchema": {"type": "object"}}),
        ];
        Server::new(
            |name, args| match name {
                "echo" => Ok(ok_text(args.to_string())),
                "boom" => Err("it broke".into()),
                "panic" => panic!("bad"),
                _ => Ok(crate::tools::error_text(format!(
                    "Unknown tool {}",
                    py_repr(name)
                ))),
            },
            tools,
            "test-server",
            "Use it.",
        )
    }

    #[test]
    fn initialize_negotiates_the_protocol() {
        let s = server();
        let r = s
            .handle(&json!({"jsonrpc": "2.0", "id": 1, "method": "initialize",
                                 "params": {"protocolVersion": "2025-03-26"}}))
            .unwrap();
        assert_eq!(r["result"]["protocolVersion"], "2025-03-26");
        assert_eq!(
            r["result"]["serverInfo"],
            json!({"name": "test-server", "version": "1.0"})
        );
        assert_eq!(r["result"]["instructions"], "Use it.");
        assert_eq!(
            r["result"]["capabilities"],
            json!({"tools": {"listChanged": false}})
        );
        let r = s
            .handle(
                &json!({"id": 2, "method": "initialize", "params": {"protocolVersion": "1999"}}),
            )
            .unwrap();
        assert_eq!(r["result"]["protocolVersion"], PROTOCOL_VERSIONS[0]);
    }

    #[test]
    fn lists_calls_and_reports_errors_to_the_model() {
        let s = server();
        assert!(s
            .handle(&json!({"method": "notifications/initialized"}))
            .is_none());
        assert!(s.handle(&json!({"id": null, "method": "ping"})).is_none());
        assert_eq!(
            s.handle(&json!({"id": 3, "method": "ping"})).unwrap()["result"],
            json!({})
        );
        assert_eq!(
            s.handle(&json!({"id": 4, "method": "tools/list"})).unwrap()["result"]["tools"][0]
                ["name"],
            "echo"
        );
        let r = s
            .handle(&json!({"id": 5, "method": "tools/call", "params": {"name": "echo"}}))
            .unwrap();
        assert_eq!(r["result"]["content"][0]["text"], "{}");
        let r = s.handle(&json!({"id": 6, "method": "tools/call", "params": {"name": "boom", "arguments": {}}})).unwrap();
        assert_eq!(
            r["result"],
            result(vec![text("Tool error: it broke")], true)
        );
        let r = s
            .handle(&json!({"id": 7, "method": "tools/call", "params": {"name": "panic"}}))
            .unwrap();
        assert_eq!(r["result"]["isError"], true);
        let r = s.handle(&json!({"id": 8, "method": "nope"})).unwrap();
        assert_eq!(
            r["error"],
            json!({"code": -32601, "message": "no method nope"})
        );
    }

    #[test]
    fn serves_lines_batches_and_parse_errors() {
        let s = server();
        let input = "\n{\"id\":1,\"method\":\"ping\"}\nnot json\n[{\"id\":2,\"method\":\"ping\"},{\"method\":\"x\"}]\n[{\"method\":\"x\"}]\n";
        let mut out = Vec::new();
        s.serve(input.as_bytes(), &mut out).unwrap();
        let lines: Vec<Value> = String::from_utf8(out)
            .unwrap()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[0]["id"], 1);
        assert_eq!(lines[1]["error"]["code"], -32700);
        assert_eq!(lines[2].as_array().unwrap().len(), 1);
    }

    #[test]
    fn python_repr() {
        assert_eq!(py_repr("gssf"), "'gssf'");
        assert_eq!(py_repr("it's"), "\"it's\"");
        assert_eq!(py_repr("a'b\"c"), "'a\\'b\"c'");
        assert_eq!(py_repr("line\nnext\\"), "'line\\nnext\\\\'");
        assert_eq!(py_repr("中文 😀"), "'中文 😀'");
        assert_eq!(py_repr("\u{7}"), "'\\x07'");
        assert_eq!(py_value_repr(&json!(5)), "5");
        assert_eq!(py_value_repr(&Value::Null), "None");
    }

    #[test]
    fn batch_tool_lists_what_can_go_in_it() {
        let tool = batch_tool(&["tap", "wait"], "[{\"tool\": \"tap\"}]");
        assert_eq!(tool["name"], "batch");
        assert!(tool["description"]
            .as_str()
            .unwrap()
            .contains("the tool being one of tap, wait. For example: [{"));
        assert_eq!(
            tool["inputSchema"]["properties"]["steps"]["items"]["properties"]["tool"]["enum"],
            json!(["tap", "wait"])
        );
        assert_eq!(
            tool["inputSchema"]["properties"]["screenshot"],
            look_schema()
        );
    }

    #[test]
    fn batch_runs_steps_without_screenshots_then_looks_once() {
        let mut calls: Vec<(String, Value)> = Vec::new();
        let mut looks: Vec<String> = Vec::new();
        let res = run_batch(
            &mut |n, a| {
                calls.push((n.into(), a.clone()));
                Ok(ok_text("done"))
            },
            &mut |note| {
                looks.push(note.into());
                Ok(ok_text(note))
            },
            &json!({"steps": [{"tool": "tap", "x": 1}, {"tool": "wait", "seconds": 1}]}),
            &["tap", "wait"],
        )
        .unwrap();
        assert_eq!(texts(&res), "Did 2 steps: tap, wait.");
        assert_eq!(
            calls[0],
            ("tap".into(), json!({"x": 1, "screenshot": false}))
        );
        assert_eq!(looks, vec!["Did 2 steps: tap, wait."]);
    }

    #[test]
    fn batch_stops_at_a_step_it_cant_do() {
        let mut n = 0;
        let res = run_batch(
            &mut |name, _| {
                n += 1;
                Ok(if name == "wait" { crate::tools::error_text("too long") } else { ok_text("ok") })
            },
            &mut |_| unreachable!(),
            &json!({"steps": [{"tool": "tap"}, {"tool": "wait"}, {"tool": "tap"}], "screenshot": false}),
            &["tap", "wait"],
        )
        .unwrap();
        assert_eq!(texts(&res), "Step 2 (wait) failed after tap: too long");
        assert_eq!(n, 2);
        let res = run_batch(
            &mut |_, _| unreachable!(),
            &mut |_| unreachable!(),
            &json!({"steps": [{"tool": "screenshot"}]}),
            &["tap"],
        )
        .unwrap();
        assert_eq!(
            texts(&res),
            "Step 1: 'screenshot' can't go in a batch (use one of tap)."
        );
    }
}
