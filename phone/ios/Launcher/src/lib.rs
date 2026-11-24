//! The launcher's Rust half, linked into Hive's first executable (Main.m and
//! Mount.m) and its loopback packet tunnel (../Loopback).

// The mount API has no pairing setup, unmount, restart or identity replacement.
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
    net::{Ipv4Addr, SocketAddr},
    path::Path,
    time::Duration,
};
use tokio::net::TcpStream;

/// The phone's own Remote Pairing listener, as seen through Hive's loopback VPN,
/// and the VPN's address for Hive: the tunnel reflects packets between the two.
const PHONE: [u8; 4] = [10, 7, 0, 1];
const HIVE: [u8; 4] = [10, 7, 1, 1];

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
/// `port` is the phone's Remote Pairing listener, reached through Hive's loopback VPN.
/// `assets` contains a complete, downloaded DDI bundle selected by the launcher.
pub async fn ensure_mounted(
    port: u16,
    identity: &Path,
    assets: &Path,
    cryptex: bool,
) -> Result<(), Failure> {
    let mut identity = RpPairingFile::read_from_file(identity)
        .await
        .map_err(|_| Failure::Identity)?;
    let endpoint = SocketAddr::from((Ipv4Addr::from(PHONE), port));
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
/// Path arguments must point to valid NUL-terminated UTF-8 strings for this call.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hive_mount_ddi(
    port: u16,
    identity: *const c_char,
    assets: *const c_char,
    cryptex: bool,
) -> i32 {
    if identity.is_null() || assets.is_null() {
        return Failure::Arguments as i32;
    }
    let strings = unsafe {
        (
            CStr::from_ptr(identity).to_str(),
            CStr::from_ptr(assets).to_str(),
        )
    };
    let (Ok(identity), Ok(assets)) = strings else {
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
            ensure_mounted(port, Path::new(identity), Path::new(assets), cryptex),
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
        let missing = std::ffi::CString::new("/nonexistent/hive-pairing.plist").unwrap();
        assert_eq!(
            unsafe { hive_mount_ddi(1, missing.as_ptr(), missing.as_ptr(), false) },
            Failure::Identity as i32
        );
    }
    #[test]
    fn null_ffi_arguments_fail_without_accessing_device() {
        assert_eq!(
            unsafe { hive_mount_ddi(1, std::ptr::null(), std::ptr::null(), false) },
            Failure::Arguments as i32
        );
    }
}

/// Reflect only IPv4 packets belonging to Hive's /32 loopback route. Swapping
/// the two addresses preserves the IP and transport checksum sums, including
/// packets with IP options or fragmented transport payloads.
fn reflect_ipv4(packet: &mut [u8]) -> bool {
    if packet.len() < 20 || packet[0] >> 4 != 4 {
        return false;
    }
    let header = usize::from(packet[0] & 15) * 4;
    let length = usize::from(u16::from_be_bytes([packet[2], packet[3]]));
    if header < 20
        || length < header
        || length != packet.len()
        || packet[12..16] != HIVE
        || packet[16..20] != PHONE
    {
        return false;
    }
    for offset in 0..4 {
        packet.swap(12 + offset, 16 + offset);
    }
    true
}

/// # Safety
/// `bytes` must point to `count` writable bytes held exclusively for this call.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hive_reflect_ipv4(bytes: *mut u8, count: usize) -> bool {
    if bytes.is_null() || count > 65535 {
        return false;
    }
    reflect_ipv4(unsafe { std::slice::from_raw_parts_mut(bytes, count) })
}

#[cfg(test)]
mod packet_tests {
    use super::*;
    fn packet() -> Vec<u8> {
        let mut p = vec![0; 40];
        p[0] = 0x45;
        p[2..4].copy_from_slice(&40u16.to_be_bytes());
        p[12..16].copy_from_slice(&HIVE);
        p[16..20].copy_from_slice(&PHONE);
        p[20..24].copy_from_slice(&[0xab, 0xcd, 0xc0, 0x00]);
        p
    }
    #[test]
    fn reflection_keeps_ports_payload_and_checksum_sum() {
        let mut p = packet();
        let original = p.clone();
        let sum = |p: &[u8]| {
            p.chunks_exact(2)
                .map(|x| u16::from_be_bytes([x[0], x[1]]) as u32)
                .sum::<u32>()
        };
        assert!(reflect_ipv4(&mut p));
        assert_eq!(&p[12..16], &original[16..20]);
        assert_eq!(&p[16..20], &original[12..16]);
        assert_eq!(&p[20..], &original[20..]);
        assert_eq!(sum(&p), sum(&original));
    }
    #[test]
    fn invalid_or_unrelated_packets_are_unchanged() {
        let good = packet();
        for mut p in [
            vec![],
            vec![0; 19],
            {
                let mut p = good.clone();
                p[0] = 0x65;
                p
            },
            {
                let mut p = good.clone();
                p[0] = 0x44;
                p
            },
            {
                let mut p = good.clone();
                p[2] = 1;
                p
            },
            {
                let mut p = good.clone();
                p[16] = 8;
                p
            },
            {
                let mut p = good;
                p[12] = 127;
                p
            },
        ] {
            let before = p.clone();
            assert!(!reflect_ipv4(&mut p));
            assert_eq!(p, before);
        }
    }
}
