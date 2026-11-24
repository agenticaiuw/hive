//! Plugging a trusted iPhone into Hive's Mac app performs its one-time setup.
//! The cloud receives the Apple pairing identity before it is written into Hive
//! on the phone. This is setup only; phone tools continue to run on the server.
//! Neither trust reset nor unpairing is used, and errors are never logged: they
//! can carry pairing material.
use idevice::{
    core_device_proxy::CoreDeviceProxy,
    remote_pairing::{RemotePairingClient, RpPairingFile},
    rsd::RsdHandshake,
    services::{
        afc::{opcode::AfcFopenMode, AfcClient},
        house_arrest::HouseArrestClient,
    },
    usbmuxd::{Connection, UsbmuxdAddr, UsbmuxdConnection, UsbmuxdDevice},
    IdeviceService, RemoteXpcClient,
};
use std::{
    collections::{HashMap, HashSet},
    time::Duration,
};

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

pub fn start(c: &hive_protocol::Conf) {
    let (server, token, host) = (c.server.clone(), c.token.clone(), format!("Hive-{}", c.id));
    std::thread::spawn(move || {
        let Ok(runtime) = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
        else {
            return;
        };
        let agent = ureq::AgentBuilder::new()
            .timeout(Duration::from_secs(15))
            .build();
        let mut complete = HashSet::new();
        // Keep a newly created identity while a temporary cloud or USB failure
        // is retried, rather than repeatedly asking the device to pair.
        let mut pending = HashMap::<String, Vec<u8>>::new();
        // Why each plugged-in iPhone's setup hasn't finished, said once per change instead of retried silently.
        let mut said = HashMap::<String, String>::new();
        let mut say = |device: &str, why: String| {
            if said.get(device) != Some(&why) { eprintln!("iPhone setup: {why}"); said.insert(device.to_string(), why); }
        };
        loop {
            let devices = runtime
                .block_on(async { tokio::time::timeout(Duration::from_secs(5), devices()).await });
            match &devices {
                Ok(Err(e)) => say("", format!("couldn't list the iPhones plugged into this Mac: {e}")),
                Err(_) => say("", "listing the iPhones plugged into this Mac timed out".into()),
                Ok(Ok(found)) => say("", format!("{} iPhone(s) plugged in", found.len())),
            }
            if let Ok(Ok(devices)) = devices {
                complete.retain(|id| devices.contains(id));
                for device in devices {
                    if complete.contains(&device) {
                        continue;
                    }
                    let address = format!("{server}/api/phone/bootstrap/{device}");
                    let credential = match agent
                        .get(&address)
                        .set("Authorization", &format!("Bearer {token}"))
                        .call()
                    {
                        Ok(response) => {
                            use std::io::Read;
                            let mut bytes = vec![];
                            if response
                                .into_reader()
                                .take(16385)
                                .read_to_end(&mut bytes)
                                .is_err()
                                || bytes.len() > 16384
                            {
                                say(&device, "Hive Server's saved pairing for this iPhone couldn't be read".into());
                                continue;
                            }
                            Some(bytes)
                        }
                        Err(ureq::Error::Status(404, _)) => None,
                        Err(e) => { say(&device, format!("couldn't ask Hive Server for this iPhone's pairing: {e}")); continue }
                    };
                    let credential = match credential.or_else(|| pending.get(&device).cloned()) {
                        Some(bytes) => bytes,
                        None => {
                            let identity = runtime.block_on(async {
                                tokio::time::timeout(Duration::from_secs(90), async {
                                    match installed_identity(&device).await? {
                                        Some(bytes) => Ok(bytes),
                                        None => create_identity(&device, &host).await,
                                    }
                                })
                                .await
                            });
                            let bytes = match identity {
                                Ok(Ok(bytes)) => bytes,
                                Ok(Err(e)) => { say(&device, format!("couldn't pair with this iPhone: {e} (unlock it and tap Trust)")); continue }
                                Err(_) => { say(&device, "pairing with this iPhone timed out (unlock it and tap Trust)".into()); continue }
                            };
                            pending.insert(device.clone(), bytes.clone());
                            bytes
                        }
                    };
                    let response = agent
                        .post(&address)
                        .set("Authorization", &format!("Bearer {token}"))
                        .set("Content-Type", "application/x-plist")
                        .send_bytes(&credential);
                    let relay = match response.map(|r| r.into_string()) {
                        Ok(Ok(relay)) => relay,
                        Ok(Err(e)) => { say(&device, format!("Hive Server's answer couldn't be read: {e}")); continue }
                        Err(e) => { say(&device, format!("couldn't save this iPhone's pairing on Hive Server: {e}")); continue }
                    };
                    let installed = runtime.block_on(async {
                        tokio::time::timeout(
                            Duration::from_secs(30),
                            install(&device, &credential, relay.as_bytes()),
                        )
                        .await
                    });
                    match installed {
                        Ok(Ok(())) => {
                            say(&device, "done: Hive on this iPhone can turn on phone control".into());
                            complete.insert(device.clone());
                            pending.remove(&device);
                        }
                        Ok(Err(e)) => say(&device, format!("couldn't put the pairing into Hive on this iPhone: {e} (is Hive installed on it?)")),
                        Err(_) => say(&device, "putting the pairing into Hive on this iPhone timed out".into()),
                    }
                }
            }
            std::thread::sleep(Duration::from_secs(5));
        }
    });
}

async fn usb_devices() -> Result<Vec<UsbmuxdDevice>> {
    let mut mux = UsbmuxdConnection::default().await?;
    Ok(mux
        .get_devices()
        .await?
        .into_iter()
        .filter(|d| d.connection_type == Connection::Usb)
        .collect())
}

async fn devices() -> Result<Vec<String>> {
    Ok(usb_devices().await?.into_iter().map(|d| d.udid).collect())
}

async fn device(udid: &str) -> Result<UsbmuxdDevice> {
    Ok(usb_devices()
        .await?
        .into_iter()
        .find(|d| d.udid == udid)
        .ok_or("iPhone unplugged")?)
}

const DOCS: &str = "/Documents";

async fn documents(udid: &str) -> Result<AfcClient> {
    let provider = device(udid)
        .await?
        .to_provider(UsbmuxdAddr::default(), "Hive");
    let house = HouseArrestClient::connect(&provider).await?;
    // The app's whole container: iOS refuses "documents" to Hive (afc: Permission denied), and a development-signed app's
    // container is open to the computer that set it up. Files go in its Documents folder (DOCS).
    Ok(house.vend_container("app.hive.xctrunner").await?)
}

/// Read an already installed identity before making a new one. An unreadable
/// or malformed existing identity is an error; it must never be replaced silently.
async fn installed_identity(udid: &str) -> Result<Option<Vec<u8>>> {
    let mut docs = documents(udid).await?;
    if !docs
        .list_dir(DOCS)
        .await?
        .iter()
        .any(|name| name == "developer-pairing.plist")
    {
        return Ok(None);
    }
    let mut file = docs
        .open(format!("{DOCS}/developer-pairing.plist"), AfcFopenMode::RdOnly)
        .await?;
    let bytes = file.read_entire().await?;
    file.close().await?;
    RpPairingFile::from_bytes(&bytes)?;
    Ok(Some(bytes))
}

/// Create a Remote Pairing identity through the phone's existing USB trust.
/// This does not alter the ordinary lockdown pairing record.
async fn create_identity(udid: &str, host: &str) -> Result<Vec<u8>> {
    let provider = device(udid)
        .await?
        .to_provider(UsbmuxdAddr::default(), "Hive");
    let proxy = CoreDeviceProxy::connect(&provider).await?;
    let port = proxy.tunnel_info().server_rsd_port;
    let mut adapter = proxy.create_software_tunnel()?.to_async_handle();
    let handshake = RsdHandshake::new(adapter.connect(port).await?).await?;
    let service = handshake
        .services
        .get("com.apple.internal.dt.coredevice.untrusted.tunnelservice")
        .ok_or("no tunnel service")?;
    let mut connection = RemoteXpcClient::new(adapter.connect(service.port).await?).await?;
    connection.do_handshake().await?;
    connection.recv_root().await?;
    let mut pairing = RemotePairingClient::new(connection, host);
    let mut identity = RpPairingFile::generate(host);
    pairing
        .connect(&mut identity, async || "000000".to_string())
        .await?;
    Ok(identity.to_bytes())
}

/// Install only after the identity is saved on the Hive Server. Existing
/// identity material is compared before writing, never overwritten.
async fn install(udid: &str, identity: &[u8], relay: &[u8]) -> Result<()> {
    let expected = RpPairingFile::from_bytes(identity)?;
    if let Some(existing) = installed_identity(udid).await? {
        if RpPairingFile::from_bytes(&existing)?.public_key_bytes() != expected.public_key_bytes() {
            return Err("a different identity is installed".into());
        }
    }
    let mut docs = documents(udid).await?;
    for (name, bytes) in [
        ("developer-pairing.plist", identity),
        ("phone-relay.json", relay),
    ] {
        let temporary = format!("{DOCS}/.{name}.hive-setup");
        let mut file = docs.open(&temporary, AfcFopenMode::WrOnly).await?;
        file.write_entire(bytes).await?;
        file.close().await?;
        docs.rename(&temporary, &format!("{DOCS}/{name}")).await?;
    }
    Ok(())
}
