//! "Make this computer my Hive": Hive's server runs inside the app, started the same way on every computer (server/src/lib.rs),
//! and this computer joins it as one of its devices.
use hive_protocol::Conf;
use std::path::PathBuf;

const LOCAL: &str = "127.0.0.1:8790";

fn dir() -> PathBuf { hive_protocol::conf_path("home").with_extension("") }

pub fn is_on() -> bool { dir().join("owner-key").exists() }

/// Starts this computer's Hive (setting it up the first time) and connects this computer to it. Returns the dashboard's
/// address (signed in) and this computer's connection.
pub fn start(say: &dyn Fn(&str)) -> Result<(String, Conf), String> {
    let state = dir();
    hive_server::start(hive_server::Config { state: state.clone(), addr: LOCAL.into(), repo: None }, say)?;
    crate::os::stay_on();
    let local = format!("http://{LOCAL}");
    let conf = match hive_protocol::load("node") {
        Some(c) if c.server == local => c,
        _ => (0..40).find_map(|_| {
            std::thread::sleep(std::time::Duration::from_millis(250));
            hive_protocol::pair("node", &local, &hive_server::owner_key(&state), crate::os::KIND, &crate::os::host(), "").ok()
        }).ok_or("Hive didn't start. Quit the app and open it again.")?,
    };
    say("Getting your Hive its secure address…");
    let address = (0..240).find_map(|_| hive_server::address(&state).or_else(|| { std::thread::sleep(std::time::Duration::from_millis(500)); None }))
        .filter(|a| ureq::get(a).timeout(std::time::Duration::from_secs(10)).call().is_ok())
        .ok_or("Hive is running, but the internet can't reach this computer: its router didn't open Hive's ports (UPnP is off), \
            or the internet provider shares one address among many homes. A computer with its own address, like a VM, works anywhere.")?;
    Ok((format!("{address}/#key={}", conf.token), conf))
}
