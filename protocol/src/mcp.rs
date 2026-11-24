//! MCP (modelcontextprotocol.io): the JSON-RPC messages through which agents use tools, the same whether they come over HTTP
//! (Hive's own Claude Code agents, server/) or stdio (`hive mcp`, any agent on the owner's computers, desktop/). Both eras are
//! answered: a request with `_meta` naming its protocol version (2026-07-28 on), and the `initialize` handshake before it.
use serde_json::{json, Value};

/// Every version this answers, newest first: the newest per-request one, then the handshake ones.
const VERSIONS: [&str; 5] = ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

/// The answer to one message, or None for a notification (no id). `call` runs a tool: (success, text, images as data URLs).
pub fn answer(m: &Value, instructions: &str, tools: impl FnOnce() -> Vec<Value>, call: impl FnOnce(&str, &Value) -> (bool, String, Vec<String>)) -> Option<Value> {
    let id = m.get("id").cloned()?;
    let ok = |mut result: Value| { result["resultType"] = json!("complete"); Some(json!({ "jsonrpc": "2.0", "id": id, "result": result })) };
    let err = |code: i64, message: String, data: Value| Some(json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message, "data": data } }));
    let asked = &m["params"]["_meta"]["io.modelcontextprotocol/protocolVersion"];
    if let Some(v) = asked.as_str() {
        if !VERSIONS.contains(&v) { return err(-32022, "Unsupported protocol version".into(), json!({ "supported": VERSIONS, "requested": v })) }
    }
    let info = json!({ "name": "hive", "version": crate::VERSION });
    let mut caps = json!({ "capabilities": { "tools": {} } });
    if !instructions.is_empty() { caps["instructions"] = json!(instructions); }
    match m["method"].as_str().unwrap_or("") {
        "server/discover" => { caps["supportedVersions"] = json!(VERSIONS); caps["_meta"] = json!({ "io.modelcontextprotocol/serverInfo": info }); ok(caps) }
        "initialize" => {
            let wanted = m["params"]["protocolVersion"].as_str().unwrap_or("");
            caps["protocolVersion"] = json!(if VERSIONS[1..].contains(&wanted) { wanted } else { VERSIONS[1] });
            caps["serverInfo"] = info;
            ok(caps)
        }
        "ping" => ok(json!({})),
        "tools/list" => ok(json!({ "tools": tools() })),
        "tools/call" => {
            let (success, text, images) = call(m["params"]["name"].as_str().unwrap_or(""), &m["params"]["arguments"]);
            let mut content = vec![json!({ "type": "text", "text": text })];
            for url in &images {
                if let Some((mime, data)) = url.strip_prefix("data:").and_then(|u| u.split_once(";base64,")) {
                    content.push(json!({ "type": "image", "data": data, "mimeType": mime }));
                }
            }
            ok(json!({ "content": content, "isError": !success }))
        }
        method => err(-32601, format!("Hive has no {method}"), Value::Null),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn answers_both_eras() {
        let tools = || vec![json!({ "name": "info", "description": "d", "inputSchema": { "type": "object" } })];
        let none = |_: &str, _: &Value| -> (bool, String, Vec<String>) { unreachable!() };
        let a = |m: Value| answer(&m, "use it well", tools, none);
        let init = a(json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2025-06-18" } })).unwrap();
        assert_eq!((&init["result"]["protocolVersion"], &init["result"]["instructions"]), (&json!("2025-06-18"), &json!("use it well")));
        let newer = a(json!({ "id": 1, "method": "initialize", "params": { "protocolVersion": "2099-01-01" } })).unwrap();
        assert_eq!(newer["result"]["protocolVersion"], "2025-11-25", "an unknown handshake version gets the newest handshake one");
        assert!(a(json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })).is_none());
        let modern = |v: &str| json!({ "_meta": { "io.modelcontextprotocol/protocolVersion": v } });
        let found = a(json!({ "id": "d", "method": "server/discover", "params": modern("2026-07-28") })).unwrap();
        assert_eq!(found["result"]["supportedVersions"][0], "2026-07-28");
        assert_eq!(found["result"]["_meta"]["io.modelcontextprotocol/serverInfo"]["name"], "hive");
        let old = a(json!({ "id": 9, "method": "tools/list", "params": modern("1900-01-01") })).unwrap();
        assert_eq!((&old["error"]["code"], &old["error"]["data"]["requested"]), (&json!(-32022), &json!("1900-01-01")));
        let list = a(json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": modern("2026-07-28") })).unwrap();
        assert_eq!(list, json!({ "jsonrpc": "2.0", "id": 2, "result": { "tools": tools(), "resultType": "complete" } }));
        let call = answer(&json!({ "jsonrpc": "2.0", "id": "3", "method": "tools/call", "params": { "name": "shot", "arguments": { "a": 1 } } }), "", tools,
            |name, a| { assert_eq!((name, a), ("shot", &json!({ "a": 1 }))); (true, "here".into(), vec!["data:image/jpeg;base64,AAAA".into()]) }).unwrap();
        assert_eq!(call["id"], "3");
        assert_eq!(call["result"], json!({ "isError": false, "resultType": "complete", "content": [{ "type": "text", "text": "here" },
            { "type": "image", "data": "AAAA", "mimeType": "image/jpeg" }] }));
        let failed = answer(&json!({ "id": 4, "method": "tools/call", "params": { "name": "x" } }), "", tools, |_, _| (false, "no".into(), vec![])).unwrap();
        assert_eq!(failed["result"]["isError"], true);
        assert_eq!(a(json!({ "id": 5, "method": "resources/list" })).unwrap()["error"]["code"], -32601);
    }
}
