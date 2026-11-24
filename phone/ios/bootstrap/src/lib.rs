//! The part of Hive that runs before XCTest is available. No pairing setup,
//! unmount, device restart or identity replacement is reachable from this API.
use idevice::{
    RsdService,
    remote_pairing::{
        RemotePairingClient, RpPairingFile, RpPairingSocket, connect_tls_psk_tunnel_native,
    },
    rsd::RsdHandshake,
    services::{
        cryptexd::{self, Cryptex1Assets},
        lockdown::LockdownClient,
        mobile_image_mounter::ImageMounter,
    },
    tcp::adapter::Adapter,
};
use std::{
    ffi::{CStr, c_char},
    net::SocketAddr,
    path::Path,
    time::Duration,
};
use tokio::net::TcpStream;

/// Stable, non-sensitive errors for the launcher's status UI. Raw protocol errors
/// and pairing file contents must never enter logs or dashboard diagnostics.
#[repr(i32)]
#[derive(Debug, PartialEq, Eq)]
pub enum Failure {
    Arguments = 1,
    Identity = 2,
    Unreachable = 3,
    Verification = 4,
    Tunnel = 5,
    Discovery = 6,
    Assets = 7,
    Mount = 8,
    Timeout = 9,
    Runtime = 10,
}

/// Verify an existing Remote Pairing identity and ensure the DDI is mounted.
/// `endpoint` is the phone's Remote Pairing listener through Hive's loopback VPN.
/// `assets` contains a complete, downloaded DDI bundle selected by the launcher.
pub async fn ensure_mounted(
    endpoint: SocketAddr,
    identity: &Path,
    assets: &Path,
    cryptex: bool,
) -> Result<(), Failure> {
    let mut identity = RpPairingFile::read_from_file(identity)
        .await
        .map_err(|_| Failure::Identity)?;
    let stream = TcpStream::connect(endpoint)
        .await
        .map_err(|_| Failure::Unreachable)?;
    let mut pairing = RemotePairingClient::new(RpPairingSocket::new(stream), "Hive");
    pairing
        .attempt_pair_verify()
        .await
        .map_err(|_| Failure::Verification)?;
    // Do not call connect(): that method falls back to pair setup on failure.
    pairing
        .validate_pairing(&mut identity)
        .await
        .map_err(|_| Failure::Verification)?;
    let port = pairing
        .create_tcp_listener()
        .await
        .map_err(|_| Failure::Tunnel)?;
    let stream = TcpStream::connect(SocketAddr::new(endpoint.ip(), port))
        .await
        .map_err(|_| Failure::Tunnel)?;
    let tunnel = connect_tls_psk_tunnel_native(stream, pairing.encryption_key())
        .await
        .map_err(|_| Failure::Tunnel)?;
    let client_ip = tunnel
        .info
        .client_address
        .parse()
        .map_err(|_| Failure::Tunnel)?;
    let server_ip = tunnel
        .info
        .server_address
        .parse()
        .map_err(|_| Failure::Tunnel)?;
    let mtu = usize::from(tunnel.info.mtu);
    if mtu <= 60 {
        return Err(Failure::Tunnel);
    }
    let rsd_port = tunnel.info.server_rsd_port;
    let mut adapter = Adapter::new(Box::new(tunnel.into_inner()), client_ip, server_ip);
    adapter.set_mss(mtu.min(8192) - 60);
    let mut adapter = adapter.to_async_handle();
    let stream = adapter
        .connect(rsd_port)
        .await
        .map_err(|_| Failure::Discovery)?;
    let mut handshake = RsdHandshake::new(stream)
        .await
        .map_err(|_| Failure::Discovery)?;
    if cryptex {
        if cryptexd::installed_ddi(&mut adapter, &mut handshake)
            .await
            .map_err(|_| Failure::Mount)?
            .is_some()
        {
            return Ok(());
        }
        let assets = Cryptex1Assets::load(assets)
            .await
            .map_err(|_| Failure::Assets)?;
        cryptexd::install_ddi(&mut adapter, &mut handshake, &assets)
            .await
            .map_err(|_| Failure::Mount)?;
    } else {
        let mut mounter = ImageMounter::connect_rsd(&mut adapter, &mut handshake)
            .await
            .map_err(|_| Failure::Mount)?;
        if has_developer_image(&mounter.copy_devices().await.map_err(|_| Failure::Mount)?) {
            return Ok(());
        }
        let mut lockdown = LockdownClient::connect_rsd(&mut adapter, &mut handshake)
            .await
            .map_err(|_| Failure::Discovery)?;
        let chip = lockdown
            .get_value(Some("UniqueChipID"), None)
            .await
            .map_err(|_| Failure::Discovery)?;
        let chip = chip.as_unsigned_integer().ok_or(Failure::Discovery)?;
        let image = tokio::fs::read(assets.join("Image.dmg"))
            .await
            .map_err(|_| Failure::Assets)?;
        let cache = tokio::fs::read(assets.join("Image.dmg.trustcache"))
            .await
            .map_err(|_| Failure::Assets)?;
        let manifest = tokio::fs::read(assets.join("BuildManifest.plist"))
            .await
            .map_err(|_| Failure::Assets)?;
        mounter
            .mount_personalized_rsd(
                &mut adapter,
                &mut handshake,
                image,
                cache,
                &manifest,
                None,
                chip,
            )
            .await
            .map_err(|_| Failure::Mount)?;
        if !has_developer_image(&mounter.copy_devices().await.map_err(|_| Failure::Mount)?) {
            return Err(Failure::Mount);
        }
    }
    Ok(())
}

fn has_developer_image(devices: &[plist::Value]) -> bool {
    devices.iter().any(|value| {
        value
            .as_dictionary()
            .and_then(|d| d.get("MountPath"))
            .and_then(plist::Value::as_string)
            .is_some_and(|p| matches!(p, "/Developer" | "/System/Developer"))
    })
}

/// Runs on the launcher's worker queue, never its UIKit thread. Returns zero
/// only after the mounted image was verified. All pointers are borrowed.
///
/// # Safety
/// Arguments must point to valid NUL-terminated UTF-8 strings for this call.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hive_mount_ddi(
    endpoint: *const c_char,
    identity: *const c_char,
    assets: *const c_char,
    cryptex: bool,
) -> i32 {
    if endpoint.is_null() || identity.is_null() || assets.is_null() {
        return Failure::Arguments as i32;
    }
    let strings = unsafe {
        (
            CStr::from_ptr(endpoint).to_str(),
            CStr::from_ptr(identity).to_str(),
            CStr::from_ptr(assets).to_str(),
        )
    };
    let (Ok(endpoint), Ok(identity), Ok(assets)) = strings else {
        return Failure::Arguments as i32;
    };
    let Ok(endpoint) = endpoint.parse() else {
        return Failure::Arguments as i32;
    };
    let Ok(runtime) = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    else {
        return Failure::Runtime as i32;
    };
    match runtime.block_on(async {
        tokio::time::timeout(
            Duration::from_secs(300),
            ensure_mounted(endpoint, Path::new(identity), Path::new(assets), cryptex),
        )
        .await
    }) {
        Ok(Ok(())) => 0,
        Ok(Err(error)) => error as i32,
        Err(_) => Failure::Timeout as i32,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unrelated_mount_does_not_skip_developer_mount() {
        let mounted = |path: &str| {
            let mut d = plist::Dictionary::new();
            d.insert("MountPath".into(), path.into());
            plist::Value::Dictionary(d)
        };
        assert!(!has_developer_image(&[]));
        assert!(!has_developer_image(&[mounted("/private/var/other")]));
        assert!(has_developer_image(&[mounted("/System/Developer")]));
        assert!(has_developer_image(&[mounted("/Developer")]));
    }
    #[test]
    fn invalid_identity_returns_without_touching_network() {
        let endpoint = std::ffi::CString::new("127.0.0.1:1").unwrap();
        let missing = std::ffi::CString::new("/nonexistent/hive-pairing.plist").unwrap();
        assert_eq!(
            unsafe { hive_mount_ddi(endpoint.as_ptr(), missing.as_ptr(), missing.as_ptr(), false) },
            Failure::Identity as i32
        );
    }
    #[test]
    fn null_ffi_arguments_fail_without_accessing_device() {
        assert_eq!(
            unsafe { hive_mount_ddi(std::ptr::null(), std::ptr::null(), std::ptr::null(), false) },
            Failure::Arguments as i32
        );
    }
}
