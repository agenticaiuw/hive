//! The accessibility tree as lines (python/phone.py `_elements_compat`).
//!
//! hive-core's transport handles the plain documents WebDriverAgent sends; this is the fallback
//! python took through ElementTree when the XML uses namespaces or a DTD: names are resolved to
//! `{uri}local` as ElementTree does, and internal entities from the DOCTYPE are expanded.

use crate::phone::PhoneError;
use quick_xml::escape::resolve_predefined_entity;
use quick_xml::events::Event;
use quick_xml::{Reader, XmlVersion};
use std::collections::HashMap;

const INVALID: &str = "Invalid phone accessibility XML";

fn invalid<T>() -> Result<T, PhoneError> {
    Err(PhoneError(INVALID.into()))
}

/// `<!ENTITY name "value">` declarations of an internal subset.
fn entities(doctype: &str) -> HashMap<String, String> {
    let mut found = HashMap::new();
    let mut rest = doctype;
    while let Some(at) = rest.find("<!ENTITY") {
        rest = &rest[at + "<!ENTITY".len()..];
        let trimmed = rest.trim_start();
        let name_end = trimmed.find(char::is_whitespace).unwrap_or(trimmed.len());
        let name = &trimmed[..name_end];
        let after = trimmed[name_end..].trim_start();
        let Some(quote) = after.chars().next().filter(|c| *c == '"' || *c == '\'') else {
            continue;
        };
        let body = &after[1..];
        if let Some(end) = body.find(quote) {
            found.insert(name.to_string(), body[..end].to_string());
        }
    }
    found
}

fn resolve(prefixes: &[HashMap<String, String>], prefix: Option<&str>) -> Option<String> {
    let key = prefix.unwrap_or("");
    for scope in prefixes.iter().rev() {
        if let Some(uri) = scope.get(key) {
            return Some(uri.clone()).filter(|u| !u.is_empty() || prefix.is_some());
        }
    }
    if prefix == Some("xml") {
        return Some("http://www.w3.org/XML/1998/namespace".into());
    }
    None
}

fn qualified(
    prefixes: &[HashMap<String, String>],
    name: &str,
    attribute: bool,
) -> Result<String, PhoneError> {
    match name.split_once(':') {
        Some((prefix, local)) => match resolve(prefixes, Some(prefix)) {
            Some(uri) => Ok(format!("{{{uri}}}{local}")),
            None => invalid(),
        },
        None if attribute => Ok(name.to_string()),
        None => Ok(match resolve(prefixes, None) {
            Some(uri) => format!("{{{uri}}}{name}"),
            None => name.to_string(),
        }),
    }
}

pub fn visible_elements(source: &str, secrets: &[String]) -> Result<Vec<String>, PhoneError> {
    let mut source = source.to_string();
    for secret in secrets {
        source = source.replace(secret.as_str(), "[hidden]");
    }
    let mut reader = Reader::from_str(&source);
    let mut custom: HashMap<String, String> = HashMap::new();
    let mut scopes: Vec<HashMap<String, String>> = Vec::new();
    let mut roots = 0usize;
    let mut out = Vec::new();
    loop {
        let event = reader.read_event().or_else(|_| invalid())?;
        let (element, empty) = match event {
            Event::DocType(text) => {
                custom = entities(text.as_ref());
                continue;
            }
            Event::Start(e) => (e, false),
            Event::Empty(e) => (e, true),
            Event::End(_) => {
                scopes.pop();
                continue;
            }
            Event::Eof => break,
            _ => continue,
        };
        if scopes.is_empty() {
            roots += 1;
        }
        let tag = element.name().as_ref().to_string();
        let mut raw = Vec::new();
        let mut scope = HashMap::new();
        for attribute in element.attributes() {
            let attribute = attribute.or_else(|_| invalid())?;
            let key = attribute.key.as_ref().to_string();
            let value = attribute
                .normalized_value_with(XmlVersion::Implicit1_0, 4, |name| {
                    resolve_predefined_entity(name).or_else(|| custom.get(name).map(String::as_str))
                })
                .or_else(|_| invalid())?
                .into_owned();
            if key == "xmlns" {
                scope.insert(String::new(), value);
            } else if let Some(prefix) = key.strip_prefix("xmlns:") {
                scope.insert(prefix.to_string(), value);
            } else {
                raw.push((key, value));
            }
        }
        scopes.push(scope);
        let result = (|| -> Result<(), PhoneError> {
            let name = qualified(&scopes, &tag, false)?;
            let mut attrs: HashMap<String, String> = HashMap::new();
            for (key, value) in raw {
                attrs.insert(qualified(&scopes, &key, true)?, value);
            }
            describe(&name, &attrs, &mut out);
            Ok(())
        })();
        if empty {
            scopes.pop();
        }
        result?;
    }
    if !scopes.is_empty() || roots != 1 {
        return invalid();
    }
    Ok(out)
}

fn float(attrs: &HashMap<String, String>, key: &str) -> Option<f64> {
    attrs.get(key)?.trim().parse::<f64>().ok()
}

fn describe(tag: &str, attrs: &HashMap<String, String>, out: &mut Vec<String>) {
    if attrs.get("visible").map(String::as_str) != Some("true")
        || [
            "AppiumAUT",
            "XCUIElementTypeApplication",
            "XCUIElementTypeWindow",
        ]
        .contains(&tag)
    {
        return;
    }
    let label = attrs
        .get("label")
        .filter(|s| !s.is_empty())
        .or_else(|| attrs.get("name"))
        .map(String::as_str)
        .unwrap_or("");
    if tag == "XCUIElementTypeOther" && label.is_empty() {
        return;
    }
    let (Some(x), Some(y), Some(w), Some(h)) = (
        float(attrs, "x"),
        float(attrs, "y"),
        float(attrs, "width"),
        float(attrs, "height"),
    ) else {
        return;
    };
    let kind = tag.strip_prefix("XCUIElementType").unwrap_or(tag);
    let short: String = label.chars().take(120).collect();
    let mut line = format!(
        "({:.0}, {:.0}) {} {}",
        x + w / 2.0,
        y + h / 2.0,
        kind,
        serde_json::to_string(&short).unwrap_or_default()
    );
    if let Some(value) = attrs
        .get("value")
        .filter(|v| !v.is_empty() && v.as_str() != label && !kind.contains("Secure"))
    {
        let short: String = value.chars().take(120).collect();
        line.push_str(&format!(
            " value={}",
            serde_json::to_string(&short).unwrap_or_default()
        ));
    }
    out.push(line);
}
