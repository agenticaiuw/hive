//! `hive connect [claude|codex|antigravity|all]`: idempotently wires `hive mcp` (and Claude Code lifecycle hooks)
//! into external agent harnesses so Claude Code, Codex, Antigravity, and T3 Code share one Hive rules + 3-tier memory bus.
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

const CLAUDE_EVENTS: &[&str] = &["SessionStart", "UserPromptSubmit", "PostToolUse", "PreCompact"];

fn home() -> Result<PathBuf, String> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .ok_or_else(|| "Could not determine home directory.".into())
}

fn hive_bin() -> String {
    let cur = std::env::current_exe().ok().map(|p| p.to_string_lossy().into_owned()).unwrap_or_else(|| "hive".into());
    #[cfg(target_os = "macos")]
    if Path::new("/Applications/Hive.app/Contents/MacOS/hive").exists() {
        return "/Applications/Hive.app/Contents/MacOS/hive".into();
    }
    cur
}

pub fn run(target: &str) -> Result<String, String> {
    let h = home()?;
    let bin = hive_bin();
    connect_in(&h, &bin, target)
}

fn connect_in(home: &Path, bin: &str, target: &str) -> Result<String, String> {
    let target = target.trim().to_ascii_lowercase();
    let targets: Vec<&str> = match target.as_str() {
        "" | "all" => vec!["claude", "codex", "gemini", "antigravity", "t3"],
        "claude" | "codex" | "gemini" | "antigravity" | "t3" => vec![target.as_str()],
        other => return Err(format!("Unknown harness '{other}'. Use: claude | codex | gemini | antigravity | t3 | all")),
    };
    let mut lines = Vec::new();
    for t in targets {
        match t {
            "claude" => {
                let p = home.join(".claude/settings.json");
                wire_claude_settings(&p, bin)?;
                wire_mcp_json(&home.join(".claude.json"), bin)?;
                lines.push(format!("Claude Code: wired MCP + hooks (SessionStart, UserPromptSubmit, PostToolUse, PreCompact) in {}", p.display()));
            }
            "codex" => {
                let p = home.join(".codex/config.toml");
                wire_codex_toml(&p, bin)?;
                lines.push(format!("Codex: wired [mcp_servers.hive] in {}", p.display()));
            }
            "gemini" => {
                wire_mcp_json(&home.join(".gemini/settings.json"), bin)?;
                lines.push("Gemini CLI connected.".into());
            }
            "t3" => {
                let root = home.join(".t3/userdata/providers/antigravity");
                let mut count = 0;
                if root.exists() {
                    for entry in std::fs::read_dir(root).map_err(|e| e.to_string())? {
                        let path = entry.map_err(|e| e.to_string())?.path();
                        if path.is_dir() {
                            wire_mcp_json(&path.join("config/mcp_config.json"), bin)?;
                            count += 1;
                        }
                    }
                }
                lines.push(format!("T3 Code: connected {count} existing Antigravity provider(s). Codex, Claude Code and Gemini CLI use their provider configuration. Restart provider sessions to load Hive. Custom provider homes need their own MCP configuration."));
            }
            "antigravity" => {
                let p = home.join(".gemini/antigravity/mcp_config.json");
                wire_mcp_json(&p, bin)?;
                lines.push(format!("Antigravity: wired mcpServers.hive in {}", p.display()));
            }
            _ => {}
        }
    }
    Ok(lines.join("\n"))
}

fn read_json_obj(path: &Path) -> Result<Value, String> {
    if !path.exists() { return Ok(json!({})); }
    let raw = std::fs::read_to_string(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    if raw.trim().is_empty() { return Ok(json!({})); }
    let v: Value = serde_json::from_str(&raw).map_err(|e| format!("invalid JSON in {}: {e}", path.display()))?;
    if !v.is_object() { return Err(format!("expected JSON object in {}", path.display())); }
    Ok(v)
}

fn write_json(path: &Path, val: &Value) -> Result<(), String> {
    if let Some(dir) = path.parent() { std::fs::create_dir_all(dir).map_err(|e| e.to_string())?; }
    let text = serde_json::to_string_pretty(val).map_err(|e| e.to_string())? + "\n";
    std::fs::write(path, text).map_err(|e| format!("write {}: {e}", path.display()))
}

fn wire_mcp_json(path: &Path, bin: &str) -> Result<(), String> {
    let mut doc = read_json_obj(path)?;
    if !doc["mcpServers"].is_object() { doc["mcpServers"] = json!({}); }
    doc["mcpServers"]["hive"] = json!({ "command": bin, "args": ["mcp"] });
    write_json(path, &doc)
}

fn wire_claude_settings(path: &Path, bin: &str) -> Result<(), String> {
    let mut doc = read_json_obj(path)?;
    if !doc["mcpServers"].is_object() { doc["mcpServers"] = json!({}); }
    doc["mcpServers"]["hive"] = json!({ "command": bin, "args": ["mcp"] });
    if !doc["hooks"].is_object() { doc["hooks"] = json!({}); }
    let hook_cmd = format!("\"{bin}\" hook");
    for ev in CLAUDE_EVENTS {
        if !doc["hooks"][*ev].is_array() { doc["hooks"][*ev] = json!([]); }
        let arr = doc["hooks"][*ev].as_array_mut().unwrap();
        let has_hive = arr.iter().any(|entry| {
            entry["hooks"].as_array().into_iter().flatten()
                .any(|h| h["command"].as_str().is_some_and(|c| c.contains("hive") && c.contains("hook")))
        });
        if !has_hive {
            arr.push(json!({ "hooks": [{ "type": "command", "command": hook_cmd }] }));
        }
    }
    write_json(path, &doc)
}

fn wire_codex_toml(path: &Path, bin: &str) -> Result<(), String> {
    let existing = if path.exists() {
        std::fs::read_to_string(path).map_err(|e| format!("read {}: {e}", path.display()))?
    } else {
        String::new()
    };
    let escaped = bin.replace('\\', "\\\\").replace('"', "\\\"");
    let block = format!("[mcp_servers.hive]\ncommand = \"{escaped}\"\nargs = [\"mcp\"]\n");
    let updated = upsert_toml_section(&existing, "[mcp_servers.hive]", &block);
    if let Some(dir) = path.parent() { std::fs::create_dir_all(dir).map_err(|e| e.to_string())?; }
    std::fs::write(path, updated).map_err(|e| format!("write {}: {e}", path.display()))
}

fn upsert_toml_section(src: &str, header: &str, replacement: &str) -> String {
    let lines: Vec<&str> = src.lines().collect();
    let mut out = Vec::new();
    let mut i = 0;
    let mut replaced = false;
    while i < lines.len() {
        if lines[i].trim() == header {
            replaced = true;
            out.push(replacement.trim_end());
            i += 1;
            while i < lines.len() && !lines[i].trim_start().starts_with('[') {
                i += 1;
            }
            continue;
        }
        out.push(lines[i]);
        i += 1;
    }
    let mut text = out.join("\n");
    if !replaced {
        if !text.is_empty() && !text.ends_with('\n') { text.push('\n'); }
        if !text.is_empty() { text.push('\n'); }
        text.push_str(replacement);
    } else if !text.ends_with('\n') {
        text.push('\n');
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connects_claude_codex_and_antigravity_idempotently() {
        let dir = std::env::temp_dir().join(format!("hive-connect-{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(dir.join(".codex")).unwrap();
        std::fs::write(dir.join(".codex/config.toml"), "model = \"gpt-5\"\n\n[mcp_servers.other]\ncommand = \"other\"\n").unwrap();
        std::fs::create_dir_all(dir.join(".claude")).unwrap();
        std::fs::write(dir.join(".claude/settings.json"), r#"{"theme":"dark"}"#).unwrap();

        std::fs::create_dir_all(dir.join(".t3/userdata/providers/antigravity/example/config")).unwrap();
        std::fs::write(dir.join(".t3/userdata/providers/antigravity/example/config/mcp_config.json"), r#"{"mcpServers":{"other":{"command":"other"}}}"#).unwrap();
        connect_in(&dir, "/Applications/Hive.app/Contents/MacOS/hive", "all").unwrap();
        // Second call is strictly idempotent (no duplicate hooks or TOML sections).
        connect_in(&dir, "/Applications/Hive.app/Contents/MacOS/hive", "all").unwrap();

        let claude: Value = serde_json::from_str(&std::fs::read_to_string(dir.join(".claude/settings.json")).unwrap()).unwrap();
        assert_eq!(claude["theme"], "dark");
        assert_eq!(claude["mcpServers"]["hive"]["args"], json!(["mcp"]));
        for ev in CLAUDE_EVENTS {
            assert_eq!(claude["hooks"][*ev].as_array().unwrap().len(), 1, "event {ev}");
        }

        let codex = std::fs::read_to_string(dir.join(".codex/config.toml")).unwrap();
        assert!(codex.contains("model = \"gpt-5\"") && codex.contains("[mcp_servers.other]"));
        assert_eq!(codex.matches("[mcp_servers.hive]").count(), 1);

        let ag: Value = serde_json::from_str(&std::fs::read_to_string(dir.join(".gemini/antigravity/mcp_config.json")).unwrap()).unwrap();
        assert_eq!(ag["mcpServers"]["hive"]["command"], "/Applications/Hive.app/Contents/MacOS/hive");

        for path in [".claude.json", ".gemini/settings.json", ".t3/userdata/providers/antigravity/example/config/mcp_config.json"] {
            let config: Value = serde_json::from_str(&std::fs::read_to_string(dir.join(path)).unwrap()).unwrap();
            assert_eq!(config["mcpServers"]["hive"]["args"], json!(["mcp"]));
            if path.starts_with(".t3") { assert_eq!(config["mcpServers"]["other"]["command"], "other"); }
        }
        std::fs::remove_dir_all(&dir).ok();
    }
}
