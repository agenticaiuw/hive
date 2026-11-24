//! The one-time Apple Remote Pairing identity, kept privately on the Hive Server.
//! This credential is separate from the phone's Hive connection token.
use ring::signature::{Ed25519KeyPair, KeyPair};
use std::{
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
};

static STORE: Mutex<()> = Mutex::new(());

/// An iPhone's UDID, as usbmuxd gives it: hex digits and dashes.
pub fn valid(device: &str) -> bool {
    (8..=80).contains(&device.len()) && device.bytes().all(|c| c.is_ascii_hexdigit() || c == b'-')
}

fn path(state: &Path, device: &str) -> Result<PathBuf, &'static str> {
    if !valid(device) {
        return Err("Invalid iPhone identifier.");
    }
    Ok(state
        .join("developer-pairing")
        .join(format!("{device}.plist")))
}
fn identity(bytes: &[u8]) -> Result<plist::Value, &'static str> {
    if bytes.len() > 16384 {
        return Err("Invalid Remote Pairing identity.");
    }
    let value: plist::Value =
        plist::from_bytes(bytes).map_err(|_| "Invalid Remote Pairing identity.")?;
    let d = value
        .as_dictionary()
        .ok_or("Invalid Remote Pairing identity.")?;
    let seed = d
        .get("private_key")
        .and_then(plist::Value::as_data)
        .ok_or("Invalid Remote Pairing identity.")?;
    let public = d
        .get("public_key")
        .and_then(plist::Value::as_data)
        .ok_or("Invalid Remote Pairing identity.")?;
    let id = d
        .get("identifier")
        .and_then(plist::Value::as_string)
        .ok_or("Invalid Remote Pairing identity.")?;
    let key = Ed25519KeyPair::from_seed_unchecked(seed)
        .map_err(|_| "Invalid Remote Pairing identity.")?;
    if key.public_key().as_ref() != public || id.is_empty() || id.len() > 128 {
        return Err("Invalid Remote Pairing identity.");
    }
    Ok(value)
}

pub fn load(state: &Path, device: &str) -> Result<Option<Vec<u8>>, &'static str> {
    let _guard = STORE.lock().map_err(|_| "Pairing store unavailable.")?;
    let path = path(state, device)?;
    match std::fs::read(path) {
        Ok(bytes) => {
            identity(&bytes)?;
            Ok(Some(bytes))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err("Couldn’t read the saved pairing identity."),
    }
}

/// Preserve an existing identity and write new identities atomically with 0600
/// permissions. Never expose their contents through dashboard file listings.
pub fn save(state: &Path, device: &str, bytes: &[u8]) -> Result<(), &'static str> {
    let proposed = identity(bytes)?;
    let _guard = STORE.lock().map_err(|_| "Pairing store unavailable.")?;
    let path = path(state, device)?;
    match std::fs::read(&path) {
        Ok(current) => {
            return if identity(&current)? == proposed {
                Ok(())
            } else {
                Err("This iPhone already has a different saved pairing identity.")
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err("Couldn’t read the saved pairing identity."),
    }
    let dir = path.parent().unwrap();
    std::fs::create_dir_all(dir).map_err(|_| "Couldn’t save the pairing identity.")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
            .map_err(|_| "Couldn’t protect the pairing store.")?;
    }
    let temporary = path.with_extension("partial");
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&temporary)
        .map_err(|_| "Couldn’t save the pairing identity.")?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| "Couldn’t save the pairing identity.")?;
    std::fs::rename(temporary, path).map_err(|_| "Couldn’t save the pairing identity.")
}

#[cfg(test)]
mod tests {
    use super::*;
    fn credential(seed: u8) -> Vec<u8> {
        let seed = [seed; 32];
        let key = Ed25519KeyPair::from_seed_unchecked(&seed).unwrap();
        let mut d = plist::Dictionary::new();
        d.insert("private_key".into(), plist::Value::Data(seed.to_vec()));
        d.insert(
            "public_key".into(),
            plist::Value::Data(key.public_key().as_ref().to_vec()),
        );
        d.insert("identifier".into(), "Hive-test".into());
        let mut bytes = vec![];
        plist::to_writer_xml(&mut bytes, &d).unwrap();
        bytes
    }
    #[test]
    fn identity_is_private_and_cannot_be_replaced() {
        let root = std::env::temp_dir().join(format!("hive-pairing-test-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let device = "00008110-001A2B3C00000000";
        assert!(load(&root, "../escape").is_err());
        assert!(save(&root, device, b"not a credential").is_err());
        let original = credential(1);
        save(&root, device, &original).unwrap();
        save(&root, device, &original).unwrap();
        assert!(save(&root, device, &credential(2)).is_err());
        assert_eq!(load(&root, device).unwrap().unwrap(), original);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(path(&root, device).unwrap())
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        std::fs::remove_dir_all(root).unwrap();
    }
}
