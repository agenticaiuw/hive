//! A small HTTP/1.1 server on std: one thread per connection, one request per connection (or a WebSocket it becomes).
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::Arc;
use std::time::Duration;

pub struct Req {
    pub method: String,
    pub path: String,
    pub query: HashMap<String, String>,
    pub headers: HashMap<String, String>,
    pub body: Vec<u8>,
}

pub struct Res {
    pub status: u16,
    pub ctype: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
    /// For a 101: what takes the connection over once the answer is sent.
    pub upgrade: Option<Box<dyn FnOnce(Box<dyn hive_phone::Conn>, TcpStream) + Send>>,
}

impl Req {
    pub fn json(&self) -> serde_json::Value {
        serde_json::from_slice(&self.body).unwrap_or(serde_json::Value::Null)
    }
    pub fn q(&self, key: &str) -> &str {
        self.query.get(key).map(|s| s.as_str()).unwrap_or("")
    }
    pub fn cookie(&self, name: &str) -> Option<String> {
        let all = self.headers.get("cookie")?;
        all.split(';').find_map(|c| {
            let (k, v) = c.trim().split_once('=')?;
            (k == name).then(|| v.to_string())
        })
    }
}

impl Res {
    pub fn new(status: u16, ctype: &str, body: impl Into<Vec<u8>>) -> Res {
        Res { status, ctype: ctype.into(), headers: vec![], body: body.into(), upgrade: None }
    }
    pub fn json(value: &serde_json::Value) -> Res {
        Res::new(200, "application/json", value.to_string())
    }
    pub fn err(status: u16, message: &str) -> Res {
        Res::new(status, "application/json", serde_json::json!({ "error": message }).to_string())
    }
    pub fn header(mut self, k: &str, v: &str) -> Res {
        self.headers.push((k.into(), v.into()));
        self
    }
}

pub fn decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < b.len() => {
                match u8::from_str_radix(std::str::from_utf8(&b[i + 1..i + 3]).unwrap_or("zz"), 16) {
                    Ok(v) => { out.push(v); i += 2; }
                    Err(_) => out.push(b'%'),
                }
            }
            c => out.push(c),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

pub fn parse(stream: &mut impl Read, max_body: usize) -> Option<Req> {
    let mut r = BufReader::new(stream);
    let mut line = String::new();
    r.read_line(&mut line).ok()?;
    let mut parts = line.split_whitespace();
    let method = parts.next()?.to_string();
    let target = parts.next()?.to_string();
    let mut headers = HashMap::new();
    loop {
        let mut h = String::new();
        if r.read_line(&mut h).ok()? == 0 { break; }
        let h = h.trim_end();
        if h.is_empty() { break; }
        if let Some((k, v)) = h.split_once(':') {
            headers.insert(k.trim().to_ascii_lowercase(), v.trim().to_string());
        }
    }
    let len: usize = headers.get("content-length").and_then(|v| v.parse().ok()).unwrap_or(0);
    if len > max_body { return None; }
    let mut body = vec![0; len];
    r.read_exact(&mut body).ok()?;
    let (path, qs) = target.split_once('?').unwrap_or((&target, ""));
    let query = qs.split('&').filter(|p| !p.is_empty()).map(|p| {
        let (k, v) = p.split_once('=').unwrap_or((p, ""));
        (decode(k), decode(v))
    }).collect();
    Some(Req { method, path: decode(path), query, headers, body })
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK", 204 => "No Content", 301 => "Moved Permanently", 302 => "Found", 400 => "Bad Request", 401 => "Unauthorized",
        404 => "Not Found", 409 => "Conflict", 413 => "Too Large", 500 => "Internal Server Error", _ => "Status",
    }
}

pub fn write(stream: &mut impl Write, res: &Res) -> std::io::Result<()> {
    let mut head = if res.status == 101 { "HTTP/1.1 101 Switching Protocols\r\n".to_string() } else { format!("HTTP/1.1 {} {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\n",
        res.status, reason(res.status), res.ctype, res.body.len()) };
    for (k, v) in &res.headers { head.push_str(&format!("{k}: {v}\r\n")); }
    head.push_str("\r\n");
    stream.write_all(head.as_bytes())?;
    stream.write_all(&res.body)?;
    stream.flush()
}

pub fn serve(addr: &str, handler: Arc<dyn Fn(Req) -> Res + Send + Sync>) -> std::io::Result<()> {
    let listener = TcpListener::bind(addr)?;
    for stream in listener.incoming().flatten() {
        let handler = handler.clone();
        stream.set_read_timeout(Some(Duration::from_secs(60))).ok();
        let Ok(socket) = stream.try_clone() else { continue };
        std::thread::spawn(move || handle(stream, socket, &*handler));
    }
    Ok(())
}

/// `socket` is the connection's TCP socket (for its timeouts), under `stream` (which may be TLS).
pub fn handle(mut stream: impl hive_phone::Conn + 'static, socket: TcpStream, handler: &(dyn Fn(Req) -> Res + Send + Sync)) {
    let mut res = match parse(&mut stream, 512 << 20) {
        Some(req) => handler(req),
        None => Res::err(400, "bad request"),
    };
    if write(&mut stream, &res).is_ok() { if let Some(up) = res.upgrade.take() { up(Box::new(stream), socket) } }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_a_request() {
        let raw = b"POST /api/x%20y?a=1&b=hello+there HTTP/1.1\r\nContent-Length: 2\r\nCookie: a=1; hive=tok\r\n\r\n{}";
        let req = parse(&mut &raw[..], 1000).unwrap();
        assert_eq!(req.method, "POST");
        assert_eq!(req.path, "/api/x y");
        assert_eq!(req.q("b"), "hello there");
        assert_eq!(req.cookie("hive").as_deref(), Some("tok"));
        assert_eq!(req.body, b"{}");
    }
}
