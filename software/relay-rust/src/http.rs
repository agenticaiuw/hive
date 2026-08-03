//! Response construction and request parsing, matching Express + `cors()`.

use serde_json::{json, Value};
use worker::{Headers, Request, Response, Result};

use crate::util::jsonjs::stringify;

/// The `cors()` middleware adds this to EVERY response, including errors.
/// The dashboard depends on it.
pub const ALLOW_ORIGIN: &str = "*";
/// npm `cors` default methods, emitted on preflight.
pub const ALLOW_METHODS: &str = "GET,HEAD,PUT,PATCH,POST,DELETE";

fn base_headers() -> Result<Headers> {
    let headers = Headers::new();
    headers.set("Access-Control-Allow-Origin", ALLOW_ORIGIN)?;
    Ok(headers)
}

/// A JSON response with Express's exact content type.
pub fn json_response(status: u16, body: &Value) -> Result<Response> {
    let headers = base_headers()?;
    headers.set("Content-Type", "application/json; charset=utf-8")?;
    Ok(Response::builder()
        .with_status(status)
        .with_headers(headers)
        .fixed(stringify(body).into_bytes()))
}

/// A JSON response carrying extra headers (e.g. `Cache-Control`).
pub fn json_response_with(status: u16, body: &Value, extra: &[(&str, &str)]) -> Result<Response> {
    let headers = base_headers()?;
    headers.set("Content-Type", "application/json; charset=utf-8")?;
    for (key, value) in extra {
        headers.set(key, value)?;
    }
    Ok(Response::builder()
        .with_status(status)
        .with_headers(headers)
        .fixed(stringify(body).into_bytes()))
}

/// `{ ok: false, error: <message> }` — the relay's universal error envelope.
pub fn error_response(status: u16, message: &str) -> Result<Response> {
    json_response(status, &json!({ "ok": false, "error": message }))
}

/// A binary response with an exact header block.
///
/// The nRF firmware sniffs headers with a case-insensitive substring match
/// that INCLUDES the `": "` separator, so every value here must have exactly
/// one space after the colon and no extra parameters.
pub fn binary_response(status: u16, bytes: Vec<u8>, extra: &[(&str, String)]) -> Result<Response> {
    let headers = base_headers()?;
    for (key, value) in extra {
        headers.set(key, value)?;
    }
    Ok(Response::builder()
        .with_status(status)
        .with_headers(headers)
        .fixed(bytes))
}

/// 204 with an EMPTY body — the bridge long-poll timeout signal.
///
/// The Mac agent distinguishes this from a 200 with an empty payload.
pub fn no_content() -> Result<Response> {
    let headers = base_headers()?;
    Ok(Response::builder()
        .with_status(204)
        .with_headers(headers)
        .empty())
}

/// CORS preflight, answered before authentication just as `cors()` does.
pub fn preflight(req: &Request) -> Result<Response> {
    let headers = base_headers()?;
    headers.set("Access-Control-Allow-Methods", ALLOW_METHODS)?;
    // npm `cors` reflects the requested headers and marks the response as
    // varying on them.
    if let Ok(Some(requested)) = req.headers().get("Access-Control-Request-Headers") {
        headers.set("Access-Control-Allow-Headers", &requested)?;
        headers.set("Vary", "Access-Control-Request-Headers")?;
    }
    headers.set("Content-Length", "0")?;
    Ok(Response::builder()
        .with_status(204)
        .with_headers(headers)
        .empty())
}

/// Outcome of parsing a request body as JSON.
pub enum JsonBody {
    /// Parsed successfully.
    Parsed(Value),
    /// Content-Type did not match, so `express.json` left `req.body` as
    /// `undefined`. Every handler reads it with `?.` / `??`, so this is safe.
    Absent,
    /// Body-parser threw. Express's default error handler answers with an
    /// HTML error page rather than the `{ok:false,error}` envelope.
    Malformed,
}

impl JsonBody {
    pub fn value(&self) -> Option<&Value> {
        match self {
            JsonBody::Parsed(value) => Some(value),
            _ => None,
        }
    }

    /// `request.body?.<key>`
    pub fn get(&self, key: &str) -> Option<&Value> {
        self.value().and_then(|body| body.get(key))
    }
}

/// 12 MiB, matching `express.json({ limit: '12mb' })`.
pub const JSON_BODY_LIMIT: usize = 12 * 1024 * 1024;

fn content_type(req: &Request) -> String {
    req.headers()
        .get("Content-Type")
        .ok()
        .flatten()
        .unwrap_or_default()
        .to_lowercase()
}

fn mime_of(content_type: &str) -> String {
    content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_string()
}

/// Port of `express.json({ limit: '12mb' })`.
pub async fn parse_json_body(req: &mut Request) -> JsonBody {
    if mime_of(&content_type(req)) != "application/json" {
        return JsonBody::Absent;
    }

    let Ok(text) = req.text().await else {
        return JsonBody::Malformed;
    };
    if text.len() > JSON_BODY_LIMIT {
        return JsonBody::Malformed;
    }
    // body-parser treats an empty body as `{}` only when strict parsing is
    // off; with the defaults an empty body yields `undefined`.
    if text.trim().is_empty() {
        return JsonBody::Absent;
    }

    match serde_json::from_str::<Value>(&text) {
        Ok(value) => JsonBody::Parsed(value),
        Err(_) => JsonBody::Malformed,
    }
}

/// The content types `express.raw` accepts on `POST /v1/pendant/command`.
pub const RAW_AUDIO_TYPES: &[&str] = &["audio/wav", "audio/x-wav", "application/octet-stream"];

/// Port of the raw parser mounted on the pendant upload route.
///
/// A non-matching Content-Type leaves `req.body` as a non-Buffer, which the
/// handler reports as "Raw audio body is required."
pub async fn parse_raw_audio_body(req: &mut Request) -> Vec<u8> {
    let mime = mime_of(&content_type(req));
    if !RAW_AUDIO_TYPES.contains(&mime.as_str()) {
        return Vec::new();
    }
    match req.bytes().await {
        Ok(bytes) if bytes.len() <= JSON_BODY_LIMIT => bytes,
        _ => Vec::new(),
    }
}

/// Read a query-string parameter.
pub fn query_param(req: &Request, name: &str) -> Option<String> {
    let url = req.url().ok()?;
    url.query_pairs()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.to_string())
}

/// Read a request header case-insensitively.
pub fn header(req: &Request, name: &str) -> String {
    req.headers().get(name).ok().flatten().unwrap_or_default()
}

/// Express's default error handler answers malformed or oversized bodies with
/// an HTML page rather than the `{ok:false,error}` envelope.
///
/// DELIBERATE DEVIATION: the status (400) and `text/html` content type match,
/// but the HTML body text is not reproduced byte for byte. No client parses it.
pub fn malformed_body_response() -> Result<Response> {
    let headers = Headers::new();
    headers.set("Access-Control-Allow-Origin", ALLOW_ORIGIN)?;
    headers.set("Content-Type", "text/html; charset=utf-8")?;
    Ok(Response::builder()
        .with_status(400)
        .with_headers(headers)
        .fixed(
            b"<!DOCTYPE html>\n<html><head><title>Error</title></head><body><pre>BadRequestError: invalid JSON body</pre></body></html>"
                .to_vec(),
        ))
}
