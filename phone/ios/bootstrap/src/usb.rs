//! One-time setup performed by Hive on a Mac for a plugged-in, trusted phone.
//! Neither trust reset nor unpairing is used. Callers back up the identity to
//! their Hive Server before writing it into the app's Documents directory.
use super::Failure;
use idevice::{
    IdeviceService, RemoteXpcClient,
    core_device_proxy::CoreDeviceProxy,
    remote_pairing::{RemotePairingClient, RpPairingFile},
    rsd::RsdHandshake,
    services::{
        afc::{AfcClient, opcode::AfcFopenMode},
        house_arrest::HouseArrestClient,
    },
    usbmuxd::{Connection, UsbmuxdAddr, UsbmuxdConnection, UsbmuxdDevice},
};

pub async fn devices() -> Result<Vec<String>, Failure> {
    let mut mux = UsbmuxdConnection::default()
        .await
        .map_err(|_| Failure::Unreachable)?;
    Ok(mux
        .get_devices()
        .await
        .map_err(|_| Failure::Unreachable)?
        .into_iter()
        .filter(|d| d.connection_type == Connection::Usb)
        .map(|d| d.udid)
        .collect())
}

async fn device(udid: &str) -> Result<UsbmuxdDevice, Failure> {
    let mut mux = UsbmuxdConnection::default()
        .await
        .map_err(|_| Failure::Unreachable)?;
    mux.get_devices()
        .await
        .map_err(|_| Failure::Unreachable)?
        .into_iter()
        .find(|d| d.connection_type == Connection::Usb && d.udid == udid)
        .ok_or(Failure::Unreachable)
}

async fn documents(udid: &str) -> Result<AfcClient, Failure> {
    let device = device(udid).await?;
    let provider = device.to_provider(UsbmuxdAddr::default(), "Hive");
    let house = HouseArrestClient::connect(&provider)
        .await
        .map_err(|_| Failure::Unreachable)?;
    house
        .vend_documents("app.hive.xctrunner")
        .await
        .map_err(|_| Failure::Unreachable)
}

/// Read an already installed identity before making a new one. An unreadable
/// or malformed existing identity is an error; it must never be replaced silently.
pub async fn installed_identity(udid: &str) -> Result<Option<Vec<u8>>, Failure> {
    let mut docs = documents(udid).await?;
    let entries = docs.list_dir("/").await.map_err(|_| Failure::Unreachable)?;
    if !entries.iter().any(|name| name == "developer-pairing.plist") {
        return Ok(None);
    }
    let mut file = docs
        .open("developer-pairing.plist", AfcFopenMode::RdOnly)
        .await
        .map_err(|_| Failure::Identity)?;
    let bytes = file.read_entire().await.map_err(|_| Failure::Identity)?;
    file.close().await.map_err(|_| Failure::Identity)?;
    RpPairingFile::from_bytes(&bytes).map_err(|_| Failure::Identity)?;
    Ok(Some(bytes))
}

/// Create a Remote Pairing identity through the phone's existing USB trust.
/// This does not alter the ordinary lockdown pairing record.
pub async fn create_identity(udid: &str, host: &str) -> Result<Vec<u8>, Failure> {
    let device = device(udid).await?;
    let provider = device.to_provider(UsbmuxdAddr::default(), "Hive");
    let proxy = CoreDeviceProxy::connect(&provider)
        .await
        .map_err(|_| Failure::Verification)?;
    let port = proxy.tunnel_info().server_rsd_port;
    let mut adapter = proxy
        .create_software_tunnel()
        .map_err(|_| Failure::Tunnel)?
        .to_async_handle();
    let stream = adapter.connect(port).await.map_err(|_| Failure::Tunnel)?;
    let handshake = RsdHandshake::new(stream)
        .await
        .map_err(|_| Failure::Discovery)?;
    let service = handshake
        .services
        .get("com.apple.internal.dt.coredevice.untrusted.tunnelservice")
        .ok_or(Failure::Discovery)?;
    let stream = adapter
        .connect(service.port)
        .await
        .map_err(|_| Failure::Tunnel)?;
    let mut connection = RemoteXpcClient::new(stream)
        .await
        .map_err(|_| Failure::Discovery)?;
    connection
        .do_handshake()
        .await
        .map_err(|_| Failure::Discovery)?;
    connection
        .recv_root()
        .await
        .map_err(|_| Failure::Discovery)?;
    let mut pairing = RemotePairingClient::new(connection, host);
    let mut identity = RpPairingFile::generate(host);
    pairing
        .connect(&mut identity, async || "000000".to_string())
        .await
        .map_err(|_| Failure::Verification)?;
    Ok(identity.to_bytes())
}

/// Install only after the caller has saved the identity on the Hive Server.
/// Existing identity material is compared before writing, never overwritten.
pub async fn install(udid: &str, identity: &[u8], relay: &[u8]) -> Result<(), Failure> {
    let expected = RpPairingFile::from_bytes(identity).map_err(|_| Failure::Identity)?;
    if let Some(existing) = installed_identity(udid).await? {
        let current = RpPairingFile::from_bytes(&existing).map_err(|_| Failure::Identity)?;
        if current.public_key_bytes() != expected.public_key_bytes() {
            return Err(Failure::Identity);
        }
    }
    let mut docs = documents(udid).await?;
    for (name, bytes) in [
        ("developer-pairing.plist", identity),
        ("phone-relay.json", relay),
    ] {
        let temporary = format!(".{name}.hive-setup");
        let mut file = docs
            .open(&temporary, AfcFopenMode::WrOnly)
            .await
            .map_err(|_| Failure::Identity)?;
        file.write_entire(bytes)
            .await
            .map_err(|_| Failure::Identity)?;
        file.close().await.map_err(|_| Failure::Identity)?;
        docs.rename(&temporary, name)
            .await
            .map_err(|_| Failure::Identity)?;
    }
    Ok(())
}
