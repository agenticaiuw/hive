//! CI only (phone.yml): App Store Connect makes this build's development provisioning profiles, listing every iPhone
//! registered to the owner's Apple developer account, so an iPhone registered today installs the next build. A run started
//! for a new iPhone (the workflow's `udid` input, read from the event file so it never shows in the public log) registers it
//! first.
//!
//! `hive-provision <out> <bundle id>...` writes <out>/<bundle id>.mobileprovision and .entitlements for each, and
//! <out>/devices.json (hive_phone::listing of each iPhone). The key is ASC_KEY_P8 (the .p8, base64 as for the Mac release),
//! ASC_KEY_ID and ASC_ISSUER_ID; the certificate is the one whose SHA-1 is HIVE_IOS_IDENTITY (IOS_CERTIFICATE, imported).
//! It prints no key, profile, UDID or device name.
use hive_protocol::b64;
use ring::signature::{EcdsaKeyPair, ECDSA_P256_SHA256_FIXED_SIGNING};
use serde_json::{json, Value};
use std::time::{SystemTime, UNIX_EPOCH};

const API: &str = "https://api.appstoreconnect.apple.com/v1";

fn env(k: &str) -> Result<String, String> { std::env::var(k).map_err(|_| format!("{k} isn't set")) }
fn b64url(d: &[u8]) -> String { b64::encode(d).trim_end_matches('=').replace('+', "-").replace('/', "_") }

/// App Store Connect's sign-in: a JWT, ES256 with the .p8, good for 20 minutes.
fn token() -> Result<String, String> {
    let bad = || "ASC_KEY_P8 isn't an App Store Connect .p8 key".to_string();
    let raw = env("ASC_KEY_P8")?;
    let pem = if raw.contains("-----BEGIN") { raw } else { String::from_utf8(b64::decode(&raw).ok_or_else(bad)?).map_err(|_| bad())? };
    let der = b64::decode(&pem.lines().filter(|l| !l.starts_with("-----")).collect::<String>()).ok_or_else(bad)?;
    let rng = ring::rand::SystemRandom::new();
    let key = EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &der, &rng).map_err(|_| bad())?;
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();
    let head = json!({ "alg": "ES256", "kid": env("ASC_KEY_ID")?, "typ": "JWT" });
    let claims = json!({ "iss": env("ASC_ISSUER_ID")?, "iat": now, "exp": now + 1200, "aud": "appstoreconnect-v1" });
    let body = format!("{}.{}", b64url(head.to_string().as_bytes()), b64url(claims.to_string().as_bytes()));
    let sig = key.sign(&rng, body.as_bytes()).map_err(|_| bad())?;
    Ok(format!("{body}.{}", b64url(sig.as_ref())))
}

struct Asc(String);

impl Asc {
    /// One call: its JSON, or its HTTP status and Apple's error code (never the detail, which can quote a UDID).
    fn call(&self, method: &str, path: &str, body: Option<Value>) -> Result<Value, (u16, String)> {
        let r = ureq::request(method, &format!("{API}/{path}")).set("Authorization", &format!("Bearer {}", self.0));
        let r = match body { Some(b) => r.set("Content-Type", "application/json").send_string(&b.to_string()), None => r.call() };
        match r {
            Ok(r) => Ok(serde_json::from_str(&r.into_string().unwrap_or_default()).unwrap_or(Value::Null)),
            Err(ureq::Error::Status(s, r)) => {
                let e: Value = serde_json::from_str(&r.into_string().unwrap_or_default()).unwrap_or(Value::Null);
                Err((s, e["errors"][0]["code"].as_str().unwrap_or("").to_string()))
            }
            Err(e) => Err((0, e.kind().to_string())),
        }
    }
    fn must(&self, method: &str, path: &str, body: Option<Value>) -> Result<Value, String> {
        let what = path.split(['?', '/']).next().unwrap_or(path);
        self.call(method, path, body).map_err(|(s, code)| format!("App Store Connect refused {method} {what} ({s} {code})"))
    }
    fn list(&self, path: &str) -> Result<Vec<Value>, String> {
        Ok(self.must("GET", path, None)?["data"].as_array().cloned().unwrap_or_default())
    }
}

fn main() {
    if let Err(e) = run() {
        eprintln!("::error title=iPhone signing::{e}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (out, ids) = args.split_first().filter(|(_, ids)| !ids.is_empty()).ok_or("usage: hive-provision <out> <bundle id>...")?;
    let out = std::path::Path::new(out);
    std::fs::create_dir_all(out).map_err(|e| e.to_string())?;
    let asc = Asc(token()?);

    let event: Value = std::env::var("GITHUB_EVENT_PATH").ok().and_then(|p| std::fs::read(p).ok())
        .and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or(Value::Null);
    let udid = event["inputs"]["udid"].as_str().unwrap_or("").trim();
    if !udid.is_empty() {
        let name = event["inputs"]["name"].as_str().map(str::trim).filter(|n| !n.is_empty()).unwrap_or("iPhone");
        // Already registered (or not a UDID at all, which Apple also answers with a 409): the list below tells which.
        match asc.call("POST", "devices", Some(json!({ "data": { "type": "devices", "attributes": { "name": name, "udid": udid, "platform": "IOS" } } }))) {
            Ok(_) | Err((409, _)) => {}
            Err((s, code)) => return Err(format!("App Store Connect didn't register the iPhone ({s} {code})")),
        }
    }
    let devices = asc.list("devices?filter[platform]=IOS&filter[status]=ENABLED&limit=200")?;
    let listed: Vec<String> = devices.iter().map(|d| hive_phone::listing(d["attributes"]["udid"].as_str().unwrap_or(""))).collect();
    if !udid.is_empty() && !listed.contains(&hive_phone::listing(udid)) {
        return Err("That iPhone isn't registered: check its UDID (the dashboard shows it) and run the workflow again.".into());
    }
    if devices.is_empty() { return Err("No iPhones are registered to this Apple developer account yet.".into()); }

    let identity = env("HIVE_IOS_IDENTITY")?.to_ascii_uppercase();
    let sha1 = |c: &Value| {
        let der = b64::decode(c["attributes"]["certificateContent"].as_str().unwrap_or("")).unwrap_or_default();
        ring::digest::digest(&ring::digest::SHA1_FOR_LEGACY_USE_ONLY, &der).as_ref().iter().map(|b| format!("{b:02X}")).collect::<String>()
    };
    let certificate = asc.list("certificates?filter[certificateType]=DEVELOPMENT,IOS_DEVELOPMENT&limit=200")?.into_iter()
        .find(|c| sha1(c) == identity)
        .ok_or("IOS_CERTIFICATE isn't one of this App Store Connect team's Apple Development certificates.")?;

    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();
    for id in ids {
        let bundle = match asc.list(&format!("bundleIds?filter[identifier]={id}&limit=200"))?.into_iter().find(|b| b["attributes"]["identifier"] == id.as_str()) {
            Some(b) => b,
            None => asc.must("POST", "bundleIds", Some(json!({ "data": { "type": "bundleIds",
                "attributes": { "identifier": id, "name": format!("Hive {id}").replace('.', " "), "platform": "IOS" } } })))?["data"].clone(),
        };
        let bundle = json!({ "type": "bundleIds", "id": bundle["id"] });
        let b = bundle["id"].as_str().unwrap_or("");
        // The app and its loopback extension both carry the packet tunnel.
        if !asc.list(&format!("bundleIds/{b}/bundleIdCapabilities"))?.iter().any(|c| c["attributes"]["capabilityType"] == "NETWORK_EXTENSIONS") {
            asc.must("POST", "bundleIdCapabilities", Some(json!({ "data": { "type": "bundleIdCapabilities",
                "attributes": { "capabilityType": "NETWORK_EXTENSIONS" }, "relationships": { "bundleId": { "data": bundle } } } })))?;
        }
        // A profile made anew each build with today's iPhones; earlier builds' go (what they signed still installs).
        for old in asc.list(&format!("bundleIds/{b}/profiles?limit=200"))? {
            if old["attributes"]["name"].as_str().is_some_and(|n| n.starts_with("Hive CI ")) {
                asc.must("DELETE", &format!("profiles/{}", old["id"].as_str().unwrap_or("")), None)?;
            }
        }
        let made = asc.must("POST", "profiles", Some(json!({ "data": { "type": "profiles",
            "attributes": { "name": format!("Hive CI {id} {now}"), "profileType": "IOS_APP_DEVELOPMENT" },
            "relationships": {
                "bundleId": { "data": bundle },
                "certificates": { "data": [{ "type": "certificates", "id": certificate["id"] }] },
                "devices": { "data": devices.iter().map(|d| json!({ "type": "devices", "id": d["id"] })).collect::<Vec<_>>() },
            } } })))?;
        let profile = b64::decode(made["data"]["attributes"]["profileContent"].as_str().unwrap_or("")).ok_or("App Store Connect sent no profile")?;
        let entitlements = entitlements(&profile).ok_or("The new profile has no entitlements")?;
        std::fs::write(out.join(format!("{id}.mobileprovision")), &profile).map_err(|e| e.to_string())?;
        let mut xml = vec![];
        plist::to_writer_xml(&mut xml, &entitlements).map_err(|e| e.to_string())?;
        std::fs::write(out.join(format!("{id}.entitlements")), xml).map_err(|e| e.to_string())?;
    }
    std::fs::write(out.join("devices.json"), json!(listed).to_string()).map_err(|e| e.to_string())?;
    println!("Profiles for {} bundle ids, listing {} iPhones.", ids.len(), devices.len());
    Ok(())
}

/// The entitlements a profile grants: the plist inside its CMS signature, which carries it unencrypted.
fn entitlements(profile: &[u8]) -> Option<plist::Value> {
    let find = |s: &[u8]| profile.windows(s.len()).position(|w| w == s);
    let (start, end) = (find(b"<?xml")?, find(b"</plist>")? + "</plist>".len());
    let v: plist::Value = plist::from_bytes(profile.get(start..end)?).ok()?;
    v.as_dictionary()?.get("Entitlements").cloned()
}

#[cfg(test)]
mod tests {
    #[test]
    fn reads_the_entitlements_inside_a_profile() {
        let mut p = b"\x30\x82junk<?xml version=\"1.0\" encoding=\"UTF-8\"?><plist version=\"1.0\"><dict><key>Entitlements</key><dict>\
            <key>get-task-allow</key><true/></dict></dict></plist>\x00more".to_vec();
        let e = super::entitlements(&p).unwrap();
        assert_eq!(e.as_dictionary().unwrap().get("get-task-allow").and_then(|v| v.as_boolean()), Some(true));
        p.truncate(20);
        assert!(super::entitlements(&p).is_none());
    }
    #[test]
    fn base64url_has_no_padding_or_url_characters() { assert_eq!(super::b64url(&[0xfb, 0xff]), "-_8"); }
}
