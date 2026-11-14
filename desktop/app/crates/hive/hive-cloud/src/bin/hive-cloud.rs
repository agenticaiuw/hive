//! hive-cloud: set up, sync and check the owner's private Hive Cloud.
use hive_cloud::config::{cloud_dir, now_ms, Config};
use hive_cloud::deploy::{self, Cloudflare, Plan};
use hive_cloud::sync::{self, Engine, PushOptions};
use hive_cloud::{crypto, enroll, scan};
use serde_json::Value;
use std::io::{BufRead, IsTerminal, Write};
use std::path::PathBuf;
use std::time::{Duration, Instant};

const HELP: &str = "hive-cloud: your private Hive Cloud

Set up
  deploy [--name N] [--account ID] [--no-r2] [--yes]
                         Create your Hive Cloud in your Cloudflare account and connect this
                         device as its owner. Reads a Cloudflare API token (template \"Edit
                         Cloudflare Workers\") from CLOUDFLARE_API_TOKEN or asks for it.
  deploy --update [--name N]
                         Replace the cloud's code with this version; keeps all data.
  claim <url>            Become the owner of a Hive Cloud you deployed yourself (wrangler).
                         Reads the claim secret from HIVE_CLOUD_CLAIM_SECRET or asks for it.
  invite [--minutes M]   Make a one-use link (default 15 minutes) for another device.
  join <link>            Connect this device with an invite link.
  recover <url> [code]   Connect this device with the recovery code.
  disconnect             Remove this device from its cloud and forget its keys.

Sync
  sync                   Upload this device's changes, then download other devices' changes.
  push | pull            Only one direction.
      --allow-mass-delete   Let a sync delete more than a quarter of the cloud's files.
      --max-new-mb N        Upload at most N MB of new data this time.
  watch [--every S] [--parent PID]
                         Keep syncing (every 60 s, and right away when cloud/nudge is touched);
                         with --parent, stop when that process is gone (Hive.app starts it so).
  restore <empty folder> Download everything into a folder, checked byte for byte.
  verify [--all|--sample N]
                         Download records and check every chunk and file hash (default 50).

Look
  status [--json]        Sync state, last verified sync, conflicts, storage, devices.
  devices                Devices connected to this cloud.
  revoke <device id>     Remove a device (lost or sold).
  inventory              What would be uploaded and what is left out, and why. Sends nothing.
";

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let cmd = args.first().map(String::as_str).unwrap_or("help");
    let rest = &args[args.len().min(1)..];
    let result = match cmd {
        "deploy" => cmd_deploy(rest),
        "claim" => cmd_claim(rest),
        "invite" => cmd_invite(rest),
        "join" => cmd_join(rest),
        "recover" => cmd_recover(rest),
        "disconnect" => enroll::disconnect().map(|m| println!("{m}")),
        "sync" | "push" | "pull" => cmd_sync(cmd, rest),
        "watch" => cmd_watch(rest),
        "restore" => cmd_restore(rest),
        "verify" => cmd_verify(rest),
        "status" => cmd_status(rest),
        "devices" => cmd_devices(),
        "revoke" => cmd_revoke(rest),
        "inventory" => cmd_inventory(),
        "help" | "--help" | "-h" => {
            print!("{HELP}");
            Ok(())
        }
        other => Err(format!("unknown command {other:?}. Run `hive-cloud help`.")),
    };
    if let Err(e) = result {
        eprintln!("hive-cloud: {e}");
        std::process::exit(1);
    }
}

// ---- small helpers ---------------------------------------------------------------------------

fn flag(args: &[String], name: &str) -> bool {
    args.iter().any(|a| a == name)
}

fn opt(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned()
}

fn positional(args: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    let mut skip = false;
    for a in args {
        if skip {
            skip = false;
        } else if a.starts_with("--") {
            skip = matches!(a.as_str(), "--name" | "--account" | "--minutes" | "--every" | "--sample" | "--max-new-mb");
        } else {
            out.push(a.clone());
        }
    }
    out
}

/// Read one line; when stdin is a terminal, without echoing it.
fn read_secret(prompt: &str) -> Result<String, String> {
    let stdin = std::io::stdin();
    let tty = stdin.is_terminal();
    let mut saved = None;
    if tty {
        eprint!("{prompt}");
        let _ = std::io::stderr().flush();
        // SAFETY: plain termios calls on fd 0 with a zeroed struct filled by tcgetattr.
        unsafe {
            let mut t: libc::termios = std::mem::zeroed();
            if libc::tcgetattr(0, &mut t) == 0 {
                saved = Some(t);
                t.c_lflag &= !libc::ECHO;
                libc::tcsetattr(0, libc::TCSANOW, &t);
            }
        }
    }
    let mut line = String::new();
    let read = stdin.lock().read_line(&mut line);
    if let Some(t) = saved {
        // SAFETY: restores the settings read above.
        unsafe {
            libc::tcsetattr(0, libc::TCSANOW, &t);
        }
        eprintln!();
    }
    read.map_err(|e| e.to_string())?;
    let line = line.trim().to_string();
    if line.is_empty() {
        return Err("nothing was entered".into());
    }
    Ok(line)
}

fn confirm(question: &str) -> bool {
    if !std::io::stdin().is_terminal() {
        return false;
    }
    eprint!("{question} [y/N] ");
    let _ = std::io::stderr().flush();
    let mut line = String::new();
    let _ = std::io::stdin().lock().read_line(&mut line);
    matches!(line.trim(), "y" | "Y" | "yes")
}

fn size(bytes: u64) -> String {
    let b = bytes as f64;
    if b >= 1e9 {
        format!("{:.2} GB", b / 1e9)
    } else if b >= 1e6 {
        format!("{:.1} MB", b / 1e6)
    } else if b >= 1e3 {
        format!("{:.0} KB", b / 1e3)
    } else {
        format!("{bytes} B")
    }
}

fn ago(ms: Option<i64>) -> String {
    let Some(ms) = ms else { return "never".into() };
    let s = (now_ms() - ms).max(0) / 1000;
    match s {
        0..=59 => format!("{s} s ago"),
        60..=3599 => format!("{} min ago", s / 60),
        3600..=86_399 => format!("{} h ago", s / 3600),
        _ => format!("{} days ago", s / 86_400),
    }
}

fn print_recovery(code: &str) {
    println!();
    println!("  Recovery code (shown once; Hive does not keep it anywhere):");
    println!();
    println!("      {code}");
    println!();
    println!("  Write it down or save it in your password manager. With it, any new device");
    println!("  can reach your data if you lose all of your devices. Without it and without a");
    println!("  connected device, nobody (not you, not Hive, not Cloudflare) can decrypt it.");
    println!();
}

// ---- set up ----------------------------------------------------------------------------------

fn cmd_deploy(args: &[String]) -> Result<(), String> {
    let update = flag(args, "--update");
    if !update {
        if let Some(c) = Config::load()? {
            return Err(format!("this device is already connected to {}. Run `hive-cloud disconnect` first.", c.url));
        }
    }
    let token = match std::env::var("CLOUDFLARE_API_TOKEN").ok().filter(|t| !t.trim().is_empty()) {
        Some(t) => t,
        None => read_secret("Cloudflare API token: ")?,
    };
    let cf = Cloudflare::new(token);
    let accounts = cf.accounts()?;
    let account = match opt(args, "--account") {
        Some(id) => accounts.into_iter().find(|a| a.id == id).ok_or("that token cannot reach that account")?,
        None if accounts.len() == 1 => accounts.into_iter().next().unwrap(),
        None if accounts.is_empty() => return Err("this token cannot reach any Cloudflare account".into()),
        None => {
            let list: Vec<String> = accounts.iter().map(|a| format!("  {}  {}", a.id, a.name)).collect();
            return Err(format!("this token reaches several accounts; pick one with --account:\n{}", list.join("\n")));
        }
    };
    let script = opt(args, "--name").unwrap_or_else(|| "hive-cloud".into());
    if !script.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-') || script.len() > 54 {
        return Err("--name takes lowercase letters, digits and dashes".into());
    }
    let exists = cf.script_exists(&account.id, &script)?;
    let subdomain = cf.subdomain(&account.id)?;
    let Some(sub) = subdomain.clone() else {
        return Err("this Cloudflare account has no workers.dev name yet. Open Workers & Pages in the Cloudflare dashboard once to choose one, then run this again.".into());
    };
    let url = format!("https://{script}.{sub}.workers.dev");

    if update {
        if !exists {
            return Err(format!("there is no Worker named {script} to update"));
        }
        // Keep the storage it already uses: switching would strand the chunks already stored.
        let health = deploy::wait_healthy(&url, Duration::from_secs(20))?;
        let bucket = (health["storage"] == "r2").then(|| format!("{script}-chunks"));
        cf.upload(&account.id, &script, bucket.as_deref(), None)?;
        let health = deploy::wait_healthy(&url, Duration::from_secs(60))?;
        println!("Updated {url} to Hive Cloud {}.", health["version"].as_str().unwrap_or("?"));
        return Ok(());
    }
    if exists {
        return Err(format!(
            "a Worker named {script} already exists in this account. `--update` replaces its code and keeps its data; `--name` picks another name."
        ));
    }
    let bucket = (!flag(args, "--no-r2") && cf.r2_enabled(&account.id)).then(|| format!("{script}-chunks"));
    let plan = Plan { account, script: script.clone(), bucket, exists, subdomain };
    println!("{}", plan.describe());
    if !flag(args, "--yes") && !confirm("Create it?") {
        return Err("nothing was created (add --yes to skip this question)".into());
    }
    let mut bucket = plan.bucket.clone();
    if let Some(b) = &bucket {
        if !cf.ensure_bucket(&plan.account.id, b)? {
            println!("R2 is not enabled on this account; using Durable Object storage instead.");
            bucket = None;
        }
    }
    let claim_secret = crypto::b64url(&crypto::random::<32>());
    cf.upload(&plan.account.id, &script, bucket.as_deref(), Some(&crypto::sha256_hex(claim_secret.as_bytes())))?;
    cf.enable_workers_dev(&plan.account.id, &script)?;
    println!("Uploaded. Waiting for {url} to answer…");
    deploy::wait_healthy(&url, Duration::from_secs(120))?;
    let (config, code) = enroll::claim(&url, &claim_secret)?;
    println!("Your Hive Cloud is at {url}");
    println!("This device ({}) is connected as {}.", config.device_name, config.device_id);
    print_recovery(&code);
    println!("Next: `hive-cloud sync` uploads this device's Hive data; `hive-cloud invite` adds another device.");
    Ok(())
}

fn cmd_claim(args: &[String]) -> Result<(), String> {
    let url = positional(args).into_iter().next().ok_or("usage: hive-cloud claim <url>")?;
    let secret = match std::env::var("HIVE_CLOUD_CLAIM_SECRET").ok().filter(|s| !s.is_empty()) {
        Some(s) => s,
        None => read_secret("Claim secret: ")?,
    };
    let health = deploy::wait_healthy(&url, Duration::from_secs(30))?;
    if health["claimed"] == serde_json::json!(true) {
        return Err(format!("{url} already has an owner"));
    }
    let (config, code) = enroll::claim(&url, &secret)?;
    println!("This device ({}) now owns {}.", config.device_name, config.url);
    print_recovery(&code);
    Ok(())
}

fn cmd_invite(args: &[String]) -> Result<(), String> {
    let minutes: u64 = opt(args, "--minutes").map(|m| m.parse().map_err(|_| "--minutes takes a number")).transpose()?.unwrap_or(15);
    if !(1..=1440).contains(&minutes) {
        return Err("--minutes is 1 to 1440".into());
    }
    let engine = Engine::load()?;
    let (link, _) = enroll::invite(&engine, minutes * 60)?;
    println!("On the other device, within {minutes} minutes, run:\n\n    hive-cloud join '{link}'\n");
    println!("The link works once. It carries the key to your data, so send it only to yourself.");
    Ok(())
}

fn cmd_join(args: &[String]) -> Result<(), String> {
    let pos = positional(args);
    let (url, code) = match pos.as_slice() {
        [link] => enroll::parse_link(link)?,
        [url, code] => (url.clone(), code.clone()),
        _ => return Err("usage: hive-cloud join '<invite link>'".into()),
    };
    let config = enroll::join(&url, &code)?;
    println!("Connected {} to {} as {}.", config.device_name, config.url, config.device_id);
    println!("Run `hive-cloud sync` to bring this device's Hive data in. Quit Hive first if it is running here.");
    Ok(())
}

fn cmd_recover(args: &[String]) -> Result<(), String> {
    let pos = positional(args);
    let url = pos.first().ok_or("usage: hive-cloud recover <url> [recovery code]")?;
    let code = match pos.get(1) {
        Some(c) => c.clone(),
        None => read_secret("Recovery code: ")?,
    };
    let config = enroll::recover(url, &code)?;
    println!("Connected {} to {} with the recovery code, as {}.", config.device_name, config.url, config.device_id);
    println!("Run `hive-cloud sync` to bring your Hive data onto this device, or `hive-cloud restore <folder>` to look at it first.");
    Ok(())
}

// ---- sync ------------------------------------------------------------------------------------

fn push_options(args: &[String]) -> Result<PushOptions, String> {
    let max = opt(args, "--max-new-mb").map(|m| m.parse::<u64>().map(|n| n * 1_000_000).map_err(|_| "--max-new-mb takes a number")).transpose()?;
    Ok(PushOptions { allow_mass_delete: flag(args, "--allow-mass-delete"), max_new_bytes: max })
}

fn print_push(p: &sync::PushReport) {
    println!(
        "Upload: {} files scanned, {} sent ({} new), {} unchanged, {} deleted.",
        p.scanned,
        p.uploaded_files,
        size(p.new_bytes),
        p.unchanged,
        p.deleted
    );
    if p.waiting_files > 0 {
        println!("  {} files ({}) wait for cloud space.", p.waiting_files, size(p.waiting_bytes));
    }
    for c in &p.conflicts {
        println!("  conflict: {c}");
    }
    for e in p.errors.iter().take(10) {
        println!("  failed: {e}");
    }
    println!("  {}", if p.verified { "Read back from the cloud: OK." } else { "Not verified." });
}

fn print_pull(p: &sync::PullReport) {
    println!("Download: {} files updated, {} deleted.", p.applied, p.deleted);
    for c in &p.conflicts {
        println!("  conflict: {c}");
    }
    for e in p.errors.iter().take(10) {
        println!("  failed: {e}");
    }
}

fn cmd_sync(cmd: &str, args: &[String]) -> Result<(), String> {
    let _lock = sync::lock()?;
    let engine = Engine::load()?;
    let opts = push_options(args)?;
    let started = Instant::now();
    match cmd {
        "push" => print_push(&engine.push(&opts)?),
        "pull" => print_pull(&engine.pull()?),
        _ => {
            let (status, result) = engine.run_once(&opts);
            let (push, pull) = result?;
            print_push(&push);
            print_pull(&pull);
            println!("State: {} ({:.1} s).", status["state"].as_str().unwrap_or("?"), started.elapsed().as_secs_f64());
            if status["state"] != "ok" {
                return Err(status["lastError"].as_str().unwrap_or("sync did not finish").to_string());
            }
        }
    }
    Ok(())
}

fn cmd_watch(args: &[String]) -> Result<(), String> {
    let every: u64 = opt(args, "--every").map(|s| s.parse().map_err(|_| "--every takes seconds")).transpose()?.unwrap_or(60);
    let parent: Option<i32> = opt(args, "--parent").map(|s| s.parse().map_err(|_| "--parent takes a process ID")).transpose()?;
    // SAFETY: kill with signal 0 only checks that the process exists.
    let orphaned = || parent.is_some_and(|pid| unsafe { libc::kill(pid, 0) } != 0 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH));
    let _lock = sync::lock()?;
    let engine = Engine::load()?;
    let opts = push_options(args)?;
    let nudge = cloud_dir().join("nudge");
    let stamp = |p: &PathBuf| std::fs::metadata(p).and_then(|m| m.modified()).ok();
    let mut failures = 0u32;
    loop {
        let seen = stamp(&nudge);
        let (status, result) = engine.run_once(&opts);
        let state = status["state"].as_str().unwrap_or("?").to_string();
        match &result {
            Ok((push, pull)) => println!(
                "[{}] {state}: {} sent ({}), {} received",
                now_ms() / 1000,
                push.uploaded_files,
                size(push.new_bytes),
                pull.applied
            ),
            Err(e) => println!("[{}] {state}: {e}", now_ms() / 1000),
        }
        let _ = std::io::stdout().flush();
        failures = if state == "ok" || state == "waiting_for_space" { 0 } else { failures + 1 };
        // Offline or failing: back off up to 15 minutes. A nudge still syncs right away.
        let wait = Duration::from_secs((every << failures.min(4)).min(900));
        let start = Instant::now();
        while start.elapsed() < wait {
            std::thread::sleep(Duration::from_secs(2));
            if orphaned() {
                return Ok(());
            }
            if stamp(&nudge) != seen {
                break;
            }
        }
    }
}

fn cmd_restore(args: &[String]) -> Result<(), String> {
    let dir = positional(args).into_iter().next().ok_or("usage: hive-cloud restore <empty folder>")?;
    let engine = Engine::load()?;
    let started = Instant::now();
    let r = engine.restore(&PathBuf::from(&dir))?;
    println!("Restored {} files ({}) and {} links into {dir} in {:.1} s.", r.files, size(r.bytes), r.symlinks, started.elapsed().as_secs_f64());
    for (root, (n, b)) in &r.by_root {
        println!("  {root}: {n} files, {}", size(*b));
    }
    if r.tombstones > 0 {
        println!("  {} deleted items were skipped (kept 30 days in the cloud's history).", r.tombstones);
    }
    if !r.failures.is_empty() {
        for f in r.failures.iter().take(20) {
            println!("  failed: {f}");
        }
        return Err(format!("{} files could not be restored", r.failures.len()));
    }
    println!("Every file matched its SHA-256.");
    Ok(())
}

fn cmd_verify(args: &[String]) -> Result<(), String> {
    let sample = if flag(args, "--all") { None } else { Some(opt(args, "--sample").and_then(|s| s.parse().ok()).unwrap_or(50)) };
    let engine = Engine::load()?;
    let (checked, bytes, failures) = engine.verify(sample)?;
    println!("Downloaded and checked {checked} files ({}).", size(bytes));
    if failures.is_empty() {
        println!("All of them decrypted and matched their SHA-256.");
        Ok(())
    } else {
        for f in failures.iter().take(20) {
            println!("  failed: {f}");
        }
        Err(format!("{} files failed the check", failures.len()))
    }
}

// ---- look ------------------------------------------------------------------------------------

fn cmd_status(args: &[String]) -> Result<(), String> {
    let engine = Engine::load()?;
    let mut status = engine.status(None);
    let server = engine.api.get("/v1/status");
    // Offline is a state to report; a cloud that no longer knows this device is a failure, so the
    // app and scripts can tell from the exit status.
    let removed = match &server {
        Err(hive_cloud::api::ApiError::Http { status: 401 | 403, message, .. }) => Some(message.clone()),
        _ => None,
    };
    let refused = || Err(format!("the cloud refused this device: {}", removed.clone().unwrap_or_default()));
    if flag(args, "--json") {
        status["server"] = server.unwrap_or_else(|e| serde_json::json!({ "unreachable": e.to_string() }));
        println!("{}", serde_json::to_string_pretty(&status).unwrap());
        return if removed.is_some() { refused() } else { Ok(()) };
    }
    println!("Cloud: {}", engine.config.url);
    println!("This device: {} ({})", engine.config.device_name, engine.config.device_id);
    println!("State: {}", status["state"].as_str().unwrap_or("?"));
    if let Some(e) = status["lastError"].as_str() {
        println!("  {e}");
    }
    println!("Last verified sync: {}", ago(status["lastVerifiedSyncAt"].as_i64()));
    println!("Last attempt: {}", ago(status["lastAttemptAt"].as_i64()));
    if let Some(p) = status["pending"].as_object() {
        let files = p.get("waitingForSpace").and_then(|w| w["files"].as_u64()).unwrap_or(0);
        if files > 0 {
            println!("Waiting for space: {files} files");
        }
    }
    for c in status["conflicts"].as_array().into_iter().flatten().rev().take(5) {
        println!("Conflict: {}", c.as_str().unwrap_or(""));
    }
    match server {
        Ok(s) => {
            let st = &s["storage"];
            let cap = st["capacityBytes"].as_u64().map(|c| format!(" of {}", size(c))).unwrap_or_default();
            println!(
                "Cloud storage: {}{cap} in {} chunks ({}); {} files, {} deleted kept in history",
                size(st["usedBytes"].as_u64().unwrap_or(0)),
                st["chunks"],
                st["backend"].as_str().unwrap_or("?"),
                s["records"]["live"],
                s["records"]["deleted"]
            );
            println!("Devices:");
            print_devices(&s["devices"]);
        }
        Err(e) => println!("Cloud: {e}"),
    }
    if removed.is_some() {
        return refused();
    }
    Ok(())
}

fn print_devices(devices: &Value) {
    for d in devices.as_array().into_iter().flatten() {
        let state = if d["revokedAt"].is_null() { "" } else { "  (removed)" };
        let synced = d["status"]["lastVerifiedSyncAt"].as_i64();
        println!(
            "  {}  {:<24} {:<6} last seen {}, last verified sync {}{}{}",
            d["id"].as_str().unwrap_or("?"),
            d["name"].as_str().unwrap_or("?"),
            d["platform"].as_str().unwrap_or("?"),
            ago(d["lastSeenAt"].as_i64()),
            ago(synced),
            if d["current"] == serde_json::json!(true) { "  (this device)" } else { "" },
            state
        );
    }
}

fn cmd_devices() -> Result<(), String> {
    let engine = Engine::load()?;
    let res = engine.api.get("/v1/devices").map_err(|e| e.to_string())?;
    print_devices(&res["devices"]);
    Ok(())
}

fn cmd_revoke(args: &[String]) -> Result<(), String> {
    let id = positional(args).into_iter().next().ok_or("usage: hive-cloud revoke <device id>")?;
    let engine = Engine::load()?;
    engine.api.delete(&format!("/v1/devices/{id}")).map_err(|e| e.to_string())?;
    println!("Removed {id}. It can no longer read or write this cloud.");
    if id == engine.config.device_id {
        println!("That was this device; run `hive-cloud disconnect` to forget the keys here too.");
    }
    Ok(())
}

fn cmd_inventory() -> Result<(), String> {
    let roots = scan::roots();
    let s = scan::scan(&roots);
    println!("Uploaded from this device:");
    for r in &roots {
        println!("  {:<11} {}", r.name, r.path.display());
    }
    let mut by_top: std::collections::BTreeMap<String, (u64, u64)> = Default::default();
    for item in &s.items {
        let mut parts = item.rel.splitn(3, '/');
        let root = parts.next().unwrap_or("");
        let top = match (parts.next(), parts.next()) {
            (Some(t), Some(_)) => format!("{root}/{t}/"),
            (Some(t), None) => format!("{root}/{t}"),
            _ => root.to_string(),
        };
        let key = if top.ends_with('/') { top } else { format!("{root}/ (top-level files)") };
        let e = by_top.entry(key).or_default();
        e.0 += 1;
        e.1 += item.size;
    }
    let total: u64 = s.items.iter().map(|i| i.size).sum();
    for (k, (n, b)) in &by_top {
        println!("    {k:<40} {n:>7} files  {:>10}", size(*b));
    }
    println!("  total: {} files, {}", s.items.len(), size(total));
    println!("Left out, with the reason:");
    for (reason, (n, b)) in &s.excluded {
        println!("    {reason:<52} {n:>7} files  {:>10}", size(*b));
    }
    if !s.missing_roots.is_empty() {
        println!("Not found on this device: {}", s.missing_roots.join(", "));
    }
    Ok(())
}
