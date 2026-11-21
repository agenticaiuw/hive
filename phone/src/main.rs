//! `hive-phone`: the iPhone as a Hive device. It talks to the phone's relay and to Hive's cloud, so it can run anywhere
//! (on the VM, next to the server).
//!   hive-phone pair <server> <code>   connect with a pairing code from the dashboard
//!   hive-phone                        run it
mod phone;

use hive_protocol::{n, s, tool};
use serde_json::{json, Value};

fn tools() -> Vec<Value> {
    let xy = || json!({ "x": n("x in the latest screenshot"), "y": n("y in the latest screenshot") });
    let mut t = vec![
        tool("phone_unlock", "Unlock the iPhone with its saved passcode (the relay types it; you never see it). If it fails, stop using \
            the phone and say why.", json!({}), &[]),
        tool("phone_screenshot", "See the iPhone's screen. x/y in other phone tools are pixels in this image.", json!({}), &[]),
        tool("phone_tap", "Tap the iPhone at (x, y).", xy(), &["x", "y"]),
        tool("phone_swipe", "Swipe on the iPhone from (x, y) to (to_x, to_y).",
            { let mut p = xy(); p["to_x"] = n("end x"); p["to_y"] = n("end y"); p }, &["x", "y", "to_x", "to_y"]),
        tool("phone_type", "Type into the focused field on the iPhone ('\\n' = Return).", json!({ "text": s("Text") }), &["text"]),
        tool("phone_home", "Go to the iPhone's home screen (unlocked phones only).", json!({}), &[]),
        tool("phone_open_app", "Open an iPhone app by bundle id (e.g. com.apple.mobilesafari).", json!({ "bundle_id": s("Bundle id") }), &["bundle_id"]),
    ];
    for x in &mut t { x["lock"] = json!("touch"); x["timeout"] = json!(180); }
    t
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(|s| s.as_str()) {
        Some("pair") if args.len() == 3 => match hive_protocol::pair("phone", &args[1], &args[2], "phone", "iPhone", "") {
            Ok(_) => println!("The iPhone is connected to Hive."),
            Err(e) => { eprintln!("{e}"); std::process::exit(1) }
        },
        Some("--version") => println!("{}", hive_protocol::VERSION),
        None => {
            let Some(c) = hive_protocol::load("phone") else { eprintln!("Not connected: run `hive-phone pair <server> <code>`."); std::process::exit(1) };
            let phone = phone::Phone::new();
            hive_protocol::run(c, hive_protocol::Node { kind: "phone", name: "iPhone".into(), package: "hive-phone", tools: tools(),
                notes: "The owner's iPhone: phone_* tools. One agent at a time touches it.".into() },
                move |t, a| phone.call(t, a))
        }
        _ => { eprintln!("usage: hive-phone | hive-phone pair <server> <code>"); std::process::exit(2) }
    }
}
