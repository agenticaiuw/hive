//! Parse the agent's intentionally small .env format without interpreting shell syntax.
use std::path::Path;

pub fn read(path: &Path) -> Result<Vec<(String, String)>, String> {
    let contents = match std::fs::read(path) {
        Ok(bytes) => String::from_utf8(bytes).map_err(|_| "Invalid settings encoding")?,
        Err(_) => return Ok(Vec::new()),
    };
    Ok(parse(&contents))
}

fn py_whitespace(c: char) -> bool {
    c.is_whitespace() || ('\u{001c}'..='\u{001f}').contains(&c)
}

pub fn parse(contents: &str) -> Vec<(String, String)> {
    let mut result = Vec::new();
    // Python splitlines accepts more than CR/LF, including Unicode separators.
    for line in contents.split(|c| {
        matches!(
            c,
            '\n' | '\r'
                | '\u{000b}'
                | '\u{000c}'
                | '\u{001c}'
                | '\u{001d}'
                | '\u{001e}'
                | '\u{0085}'
                | '\u{2028}'
                | '\u{2029}'
        )
    }) {
        let line = line.trim_matches(py_whitespace);
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key
            .strip_prefix("export ")
            .unwrap_or(key)
            .trim_matches(py_whitespace);
        let mut value = value.trim_matches(py_whitespace);
        let bytes = value.as_bytes();
        if bytes.len() >= 2
            && bytes[0] == *bytes.last().unwrap()
            && (bytes[0] == b'\'' || bytes[0] == b'"')
        {
            value = &value[1..value.len() - 1];
        } else if let Some((before, _)) = value.split_once(" #") {
            value = before.trim_end_matches(py_whitespace);
        }
        if !value.is_empty() {
            result.push((key.to_owned(), value.to_owned()));
        }
    }
    result
}
