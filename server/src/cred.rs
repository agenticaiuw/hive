//! Tier 0 secret vault: logins and payment cards encrypted with systemd-creds under the VM's machine key, in a root-only
//! folder. Nothing here prints a password, card number, or CVV. The `hive-cred` command (sudo hive-server cred) manages them:
//!   hive-cred list | add <site> [username] | remove <site> [username] | add-card <label> [brand] | remove-card <label>
use serde_json::{json, Value};
use std::io::{BufRead, Write};
use std::process::{Command, Stdio};

const DIR: &str = "/var/lib/hive-credentials";
const NAME: &str = "hive-logins";
fn store() -> String { format!("{DIR}/store.cred") }
fn s(v: &Value) -> &str { v.as_str().unwrap_or("").trim() }
fn is_card(v: &Value) -> bool { s(&v["kind"]) == "card" }

/// "https://login.wisc.edu/idp/..." or "login.wisc.edu" → "login.wisc.edu".
fn host(url: &str) -> String {
    let t = url.trim().to_lowercase();
    let rest = t.split_once("://").map(|(_, r)| r).unwrap_or(&t);
    let h = rest.split(['/', '?', '#']).next().unwrap_or("");
    let h = h.rsplit('@').next().unwrap_or(h).split(':').next().unwrap_or("");
    h.to_string()
}

fn load() -> Result<Vec<Value>, String> {
    if !std::path::Path::new(&store()).exists() { return Ok(vec![]); }
    let out = Command::new("systemd-creds").args(["decrypt", &format!("--name={NAME}"), &store(), "-"]).output().map_err(|e| e.to_string())?;
    if !out.status.success() { return Err(format!("couldn't open the saved credentials (root only): {}", String::from_utf8_lossy(&out.stderr).trim())); }
    serde_json::from_slice(&out.stdout).map_err(|e| e.to_string())
}

fn save(entries: &[Value]) -> Result<(), String> {
    std::fs::create_dir_all(DIR).and_then(|_| private(DIR, 0o700)).map_err(|e| e.to_string())?;
    let part = format!("{}.part", store());
    let mut c = Command::new("systemd-creds").args(["encrypt", &format!("--name={NAME}"), "-", &part]).stdin(Stdio::piped()).spawn().map_err(|e| e.to_string())?;
    c.stdin.take().unwrap().write_all(serde_json::to_string(entries).unwrap().as_bytes()).map_err(|e| e.to_string())?;
    if !c.wait().map(|st| st.success()).unwrap_or(false) { return Err("systemd-creds couldn't encrypt the credentials".into()); }
    std::fs::rename(&part, store()).map_err(|e| e.to_string())?;
    private(&store(), 0o600).map_err(|e| e.to_string())
}

/// Select a login only for the exact host, never a related or public-suffix domain.
pub fn pick(site: &str, username: &str) -> Result<Value, String> {
    select(&load()?, site, username)
}

/// Select a single field (`number|exp|cvv|zip|cardholder`) from a saved payment card by exact label.
pub fn pick_card(label: &str, field: &str) -> Result<String, String> {
    select_card(&load()?, label, field)
}

fn select(entries: &[Value], site: &str, username: &str) -> Result<Value, String> {
    let h = host(site);
    if h.is_empty() { return Err("Give the login's site.".into()); }
    let found: Vec<&Value> = entries.iter().filter(|l| {
        !is_card(l) && host(s(&l["url"])) == h && (username.is_empty() || s(&l["username"]) == username)
    }).collect();
    match found.len() {
        1 => Ok(found[0].clone()),
        0 => Err(format!("No saved login for {site}")),
        _ => Err(format!("{site} has several logins; give username, one of: {}",
            found.iter().map(|l| s(&l["username"])).collect::<Vec<_>>().join(", "))),
    }
}

fn select_card(entries: &[Value], label: &str, field: &str) -> Result<String, String> {
    let field = field.trim().to_ascii_lowercase();
    if !matches!(field.as_str(), "number" | "exp" | "cvv" | "zip" | "cardholder") {
        return Err("Card field must be one of: number, exp, cvv, zip, cardholder.".into());
    }
    let label = label.trim();
    let cards: Vec<&Value> = entries.iter().filter(|e| {
        is_card(e) && (label.is_empty() || s(&e["label"]).eq_ignore_ascii_case(label))
    }).collect();
    let card = match cards.len() {
        1 => cards[0],
        0 => return Err(format!("No saved payment card '{}'", if label.is_empty() { "(any)" } else { label })),
        _ => return Err(format!("Several saved cards; give label, one of: {}",
            cards.iter().map(|c| format!("{} (****{})", s(&c["label"]), s(&c["last4"]))).collect::<Vec<_>>().join(", "))),
    };
    let val = s(&card[&field]);
    if val.is_empty() { return Err(format!("Saved card '{}' has no {field}.", s(&card["label"]))); }
    Ok(val.to_string())
}

fn prompt_secret(prompt: &str) -> String {
    eprint!("{prompt}");
    let echo = |on: &str| { Command::new("stty").arg(on).stdin(Stdio::inherit()).stderr(Stdio::null()).status().ok(); };
    echo("-echo");
    let mut line = String::new();
    std::io::stdin().lock().read_line(&mut line).ok();
    echo("echo");
    eprintln!();
    line.trim_end_matches(['\r', '\n']).trim().to_string()
}

pub fn main(args: &[String]) -> Result<(), String> {
    let arg = |i: usize| args.get(i).map(|a| a.trim()).unwrap_or("");
    let same = |l: &Value| !is_card(l) && host(s(&l["url"])) == host(arg(1)) && (arg(2).is_empty() || s(&l["username"]) == arg(2));
    match arg(0) {
        "list" => {
            let entries = load()?;
            let mut logins: Vec<(String, String)> = entries.iter().filter(|e| !is_card(e))
                .map(|l| (host(s(&l["url"])), s(&l["username"]).to_string())).collect();
            let mut cards: Vec<(String, String, String)> = entries.iter().filter(|e| is_card(e))
                .map(|c| (s(&c["label"]).to_string(), s(&c["brand"]).to_string(), s(&c["last4"]).to_string())).collect();
            logins.sort();
            cards.sort();
            for (h, u) in &logins { println!("{h}\t{u}"); }
            for (l, b, last4) in &cards { println!("card:{l}\t{b} ****{last4}"); }
            eprintln!("{} logins, {} cards", logins.len(), cards.len());
        }
        "add" if !arg(1).is_empty() => {
            let password = prompt_secret(&format!("Password for {} at {}: ", if arg(2).is_empty() { "(no username)" } else { arg(2) }, host(arg(1))));
            if password.is_empty() { return Err("no password given".into()); }
            let mut entries: Vec<Value> = load()?.into_iter().filter(|l| !(!is_card(l) && host(s(&l["url"])) == host(arg(1)) && s(&l["username"]) == arg(2))).collect();
            entries.push(json!({ "kind": "login", "title": host(arg(1)), "url": arg(1), "username": arg(2), "password": password }));
            save(&entries)?;
            println!("Saved the login for {}.", host(arg(1)));
        }
        "add-card" if !arg(1).is_empty() => {
            let label = arg(1);
            let brand = if arg(2).is_empty() { "card" } else { arg(2) };
            let number: String = prompt_secret(&format!("Card number for {label}: ")).chars().filter(|c| c.is_ascii_digit()).collect();
            if number.len() < 12 { return Err("card number looks too short".into()); }
            let last4 = number[number.len() - 4..].to_string();
            let exp = prompt_secret("Expiry (MM/YY): ");
            let cvv = prompt_secret("CVV: ");
            let zip = prompt_secret("Billing ZIP: ");
            let cardholder = prompt_secret("Cardholder name: ");
            let mut entries: Vec<Value> = load()?.into_iter().filter(|e| !(is_card(e) && s(&e["label"]).eq_ignore_ascii_case(label))).collect();
            entries.push(json!({
                "kind": "card", "label": label, "brand": brand, "last4": last4,
                "number": number, "exp": exp, "cvv": cvv, "zip": zip, "cardholder": cardholder
            }));
            save(&entries)?;
            println!("Saved payment card '{label}' ({brand} ****{last4}).");
        }
        "remove" if !arg(1).is_empty() => {
            let entries = load()?;
            let kept: Vec<Value> = entries.iter().filter(|l| !same(l)).cloned().collect();
            save(&kept)?;
            println!("Removed {} login(s).", entries.len() - kept.len());
        }
        "remove-card" if !arg(1).is_empty() => {
            let label = arg(1);
            let entries = load()?;
            let kept: Vec<Value> = entries.iter().filter(|e| !(is_card(e) && s(&e["label"]).eq_ignore_ascii_case(label))).cloned().collect();
            save(&kept)?;
            println!("Removed {} card(s).", entries.len() - kept.len());
        }
        _ => return Err("usage: hive-cred list | add <site> [username] | remove <site> [username] | add-card <label> [brand] | remove-card <label>".into()),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn selects_only_the_requested_host_and_login() {
        let logins = vec![
            serde_json::json!({"url":"login.example.com", "username":"a", "password":"test"}),
            serde_json::json!({"url":"login.example.com", "username":"b", "password":"test2"}),
            serde_json::json!({"kind":"card", "label":"personal", "brand":"visa", "last4":"4242", "number":"4242424242424242", "exp":"12/29", "cvv":"123", "zip":"53703", "cardholder":"Owner"}),
        ];
        assert!(super::select(&logins, "example.com", "a").is_err());
        assert!(super::select(&logins, "evil.login.example.com", "a").is_err());
        assert!(super::select(&logins, "login.example.com", "").is_err());
        assert_eq!(super::select(&logins, "https://login.example.com/", "b").unwrap()["password"], "test2");
        assert_eq!(super::select_card(&logins, "personal", "exp").unwrap(), "12/29");
        assert_eq!(super::select_card(&logins, "", "zip").unwrap(), "53703");
        assert!(super::select_card(&logins, "personal", "unknown").is_err());
        assert!(super::select_card(&logins, "missing", "cvv").is_err());
    }
    #[test]
    fn hosts() {
        assert_eq!(super::host("https://www.Login.wisc.edu:443/idp/x?y"), "www.login.wisc.edu");
        assert_eq!(super::host("wisc.edu"), "wisc.edu");
        assert_eq!(super::host(" user@x.com/a "), "x.com");
    }
}

#[cfg(unix)]
fn private(path: &str, mode: u32) -> std::io::Result<()> { use std::os::unix::fs::PermissionsExt; std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)) }
#[cfg(not(unix))]
fn private(_: &str, _: u32) -> std::io::Result<()> { Ok(()) }
