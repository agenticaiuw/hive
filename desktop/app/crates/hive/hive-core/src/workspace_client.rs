//! Request and response transport for the local workspace tool server.
use serde_json::Value;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::time::Duration;

pub const MAX_RESPONSE: u64 = 64 * 1024 * 1024;

pub fn request(socket: &Path, value: &Value, timeout: Duration) -> Result<Value, String> {
    let mut client = UnixStream::connect(socket).map_err(|_| "Workspace connection unavailable")?;
    client
        .set_read_timeout(Some(timeout))
        .map_err(|_| "Workspace connection unavailable")?;
    client
        .set_write_timeout(Some(timeout))
        .map_err(|_| "Workspace connection unavailable")?;
    serde_json::to_writer(&mut client, value).map_err(|_| "Workspace request could not be sent")?;
    client
        .write_all(b"\n")
        .map_err(|_| "Workspace request could not be sent")?;
    let mut bytes = Vec::new();
    let mut reader = BufReader::new(client).take(MAX_RESPONSE + 1);
    reader
        .read_until(b'\n', &mut bytes)
        .map_err(|_| "Workspace connection could not be read")?;
    if bytes.len() as u64 > MAX_RESPONSE {
        return Err("Workspace reply exceeds the size limit".into());
    }
    if !bytes.ends_with(b"\n") {
        return Err("Workspace connection closed before replying".into());
    }
    let response: Value =
        serde_json::from_slice(&bytes).map_err(|_| "Workspace returned invalid JSON")?;
    Ok(response)
}
