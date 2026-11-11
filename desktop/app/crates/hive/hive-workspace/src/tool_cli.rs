//! Calls the agent's virtual-workspace tools from a local task (scripts/workspace-tool.py):
//!
//!   workspace-tool status | list | call TOOL '{JSON arguments}'

use crate::pydump::dumps;
use crate::tools::default_state;
use base64::Engine as _;
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::os::unix::fs::DirBuilderExt;
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::time::Duration;

const MAX_RESPONSE: usize = 64 * 1024 * 1024;
const USAGE: &str = "Use: workspace-tool status | list | call TOOL '{JSON arguments}'";

/// One request line out, one reply line back.
pub fn call(socket: &Path, request: &Value) -> Result<Value, String> {
    let mut client = UnixStream::connect(socket).map_err(|e| e.to_string())?;
    let timeout = Some(Duration::from_secs(50));
    client
        .set_read_timeout(timeout)
        .and_then(|_| client.set_write_timeout(timeout))
        .map_err(|e| e.to_string())?;
    client
        .write_all((dumps(request, true) + "\n").as_bytes())
        .map_err(|e| e.to_string())?;
    let mut output: Vec<u8> = Vec::new();
    let mut buffer = vec![0u8; 65536];
    while !output.contains(&b'\n') {
        let count = client.read(&mut buffer).map_err(|e| e.to_string())?;
        if count == 0 {
            return Err("Workspace connection closed before replying".into());
        }
        output.extend_from_slice(&buffer[..count]);
        if output.len() > MAX_RESPONSE {
            return Err("Workspace response was too large".into());
        }
    }
    let line = output.split(|b| *b == b'\n').next().unwrap_or(&[]);
    serde_json::from_slice(line).map_err(|e| e.to_string())
}

/// Replaces image contents with text naming a file under `<state>/captures`.
pub fn materialize_images(state: &Path, value: &mut Value) -> Result<(), String> {
    let Some(contents) = value
        .get_mut("result")
        .and_then(|r| r.get_mut("content"))
        .and_then(Value::as_array_mut)
    else {
        return Ok(());
    };
    for content in contents.iter_mut() {
        if content.get("type") != Some(&json!("image")) {
            continue;
        }
        let suffix = match content
            .get("mimeType")
            .and_then(Value::as_str)
            .unwrap_or("")
        {
            "image/png" => ".png",
            "image/jpeg" => ".jpg",
            _ => return Err("Unexpected workspace image format".into()),
        };
        let data = content
            .get("data")
            .and_then(Value::as_str)
            .ok_or("missing image data")?;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data)
            .map_err(|e| e.to_string())?;
        let directory = state.join("captures");
        if !directory.is_dir() {
            std::fs::DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(&directory)
                .map_err(|e| e.to_string())?;
        }
        let mut file = tempfile::Builder::new()
            .prefix("workspace-")
            .suffix(suffix)
            .tempfile_in(&directory)
            .map_err(|e| e.to_string())?;
        file.write_all(&bytes).map_err(|e| e.to_string())?;
        let (_, path) = file.keep().map_err(|e| e.to_string())?;
        let object = content.as_object_mut().unwrap();
        object.remove("data");
        object.insert("type".into(), json!("text"));
        object.insert(
            "text".into(),
            json!(format!("Workspace image saved at {}", path.display())),
        );
    }
    Ok(())
}

/// The reply to print and the exit code.
pub fn run(state: &Path, args: &[String]) -> Result<(Value, i32), String> {
    let request = match args {
        [a] if a == "status" => json!({"method": "status"}),
        [a] if a == "list" => json!({"method": "list"}),
        [c, name, arguments] if c == "call" => {
            json!({"name": name, "arguments": serde_json::from_str::<Value>(arguments).map_err(|e| e.to_string())?})
        }
        _ => return Err(USAGE.into()),
    };
    let mut result = call(&state.join("control/workspace.sock"), &request)?;
    materialize_images(state, &mut result)?;
    let ok = result
        .get("ok")
        .map(|v| !matches!(v, Value::Null | Value::Bool(false)))
        .unwrap_or(false);
    let failed = result
        .get("result")
        .and_then(|r| r.get("isError"))
        .map(|v| !matches!(v, Value::Null | Value::Bool(false)))
        .unwrap_or(false);
    Ok((result, if ok && !failed { 0 } else { 1 }))
}

pub fn main(args: &[String]) -> i32 {
    match run(&default_state(), args) {
        Ok((result, code)) => {
            println!("{}", dumps(&result, false));
            code
        }
        Err(error) => {
            println!("{}", dumps(&json!({"ok": false, "error": error}), true));
            1
        }
    }
}
