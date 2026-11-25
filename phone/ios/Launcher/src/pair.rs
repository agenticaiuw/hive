//! Phone control's Apple pairing, made on the iPhone itself (iOS 27 and later), so no computer is needed.
//!
//! From iOS 27 an iPhone can start a developer pairing with a computer: Settings → Privacy & Security → Developer Mode
//! lists the computers on its network that advertise `_remotepairing-pairable-host._tcp`, and pairs with the one the
//! person taps (idevice's `PairableHost`; StikDebug and AltStore pair the same way). Hive advertises itself there, from
//! this iPhone, with pinless pairing: the person taps Hive and enters their passcode, with no code to copy (iOS's fixed
//! code, 000000, if it asks for one anyway). Only this iPhone's own connection is answered, so another device on the
//! network can't become Hive's phone. The identity is the same kind a computer makes over USB.
use crate::Failure;
use idevice::remote_pairing::{PairableHost, PairableHostInfo, RpPairingFile, RpPairingSocket};
use std::{
    hash::{BuildHasher, RandomState},
    net::{IpAddr, Ipv4Addr},
    time::Duration,
};
use tokio::net::TcpListener;

/// Waits for this iPhone to pair with Hive and returns the identity (an `RpPairingFile` plist) and the iPhone's UDID.
pub async fn pair_on_device() -> Result<(Vec<u8>, String), Failure> {
    let listener = TcpListener::bind((Ipv4Addr::UNSPECIFIED, 0))
        .await
        .map_err(|_| Failure::Unreachable)?;
    let port = listener.local_addr().map_err(|_| Failure::Unreachable)?.port();
    // A new identity per attempt (RpPairingFile derives its identifier from this name), so it never replaces one the
    // iPhone already trusts.
    let identity = RpPairingFile::generate(&format!("Hive-{:016x}", RandomState::new().hash_one(port)));
    let mut host = PairableHostInfo::generate("Hive", "Mac17,7");
    host.allows_pinless_pairing = true;
    let txt = txt(&host.mdns_txt_records(&identity.identifier)).ok_or(Failure::Discovery)?;
    let _advertised = bonjour::Advert::new(&identity.identifier, port, &txt).ok_or(Failure::Discovery)?;
    loop {
        // iOS may take a suspended app's listening socket back: start again with a new one (Main.m tries again).
        let (stream, peer) = listener.accept().await.map_err(|_| Failure::Unreachable)?;
        match stream.local_addr() {
            Ok(local) if same_device(peer.ip(), local.ip()) => {}
            _ => continue,
        }
        let mut attempt = identity.clone();
        let mut pairing = PairableHost::new(RpPairingSocket::new_device(stream), host.clone());
        // The person may take a while over their passcode; a connection left by a cancelled attempt ends here.
        if let Ok(Ok(phone)) = tokio::time::timeout(Duration::from_secs(180), pairing.accept(&mut attempt, |_pin| async {})).await {
            return Ok((attempt.to_bytes(), phone.remotepairing_udid));
        }
    }
}

/// A connection this iPhone made to itself has the same address at both ends.
fn same_device(peer: IpAddr, local: IpAddr) -> bool {
    let plain = |ip: IpAddr| match ip {
        IpAddr::V6(v6) => v6.to_ipv4_mapped().map_or(IpAddr::V6(v6), IpAddr::V4),
        v4 => v4,
    };
    plain(peer) == plain(local)
}

/// A DNS-SD TXT record: each entry a length byte, then `key=value`.
fn txt(entries: &[(String, String)]) -> Option<Vec<u8>> {
    let mut record = vec![];
    for (key, value) in entries {
        let entry = format!("{key}={value}");
        record.push(u8::try_from(entry.len()).ok()?);
        record.extend_from_slice(entry.as_bytes());
    }
    (record.len() <= usize::from(u16::MAX)).then_some(record)
}

/// Advertising through the system's mDNSResponder (dns_sd), which needs no multicast entitlement on iOS.
#[cfg(target_vendor = "apple")]
mod bonjour {
    use std::ffi::{CString, c_char, c_void};
    #[repr(C)]
    pub struct Service {
        _private: [u8; 0],
    }
    unsafe extern "C" {
        fn DNSServiceRegister(
            service: *mut *mut Service,
            flags: u32,
            interface: u32,
            name: *const c_char,
            kind: *const c_char,
            domain: *const c_char,
            host: *const c_char,
            port: u16,
            txt_length: u16,
            txt: *const c_void,
            callback: *const c_void,
            context: *mut c_void,
        ) -> i32;
        fn DNSServiceRefDeallocate(service: *mut Service);
    }
    /// Advertised until dropped.
    pub struct Advert(*mut Service);
    impl Advert {
        pub fn new(name: &str, port: u16, txt: &[u8]) -> Option<Self> {
            let name = CString::new(name).ok()?;
            let kind = CString::new(idevice::remote_pairing::PAIRABLE_HOST_SERVICE_TYPE.trim_end_matches(".local.")).ok()?;
            let mut service = std::ptr::null_mut();
            // No callback: mDNSResponder registers it on this call; a name clash is renamed for us.
            let error = unsafe {
                DNSServiceRegister(
                    &mut service,
                    0,
                    0,
                    name.as_ptr(),
                    kind.as_ptr(),
                    std::ptr::null(),
                    std::ptr::null(),
                    port.to_be(),
                    u16::try_from(txt.len()).ok()?,
                    txt.as_ptr().cast(),
                    std::ptr::null(),
                    std::ptr::null_mut(),
                )
            };
            (error == 0 && !service.is_null()).then_some(Self(service))
        }
    }
    impl Drop for Advert {
        fn drop(&mut self) {
            unsafe { DNSServiceRefDeallocate(self.0) }
        }
    }
}

#[cfg(not(target_vendor = "apple"))]
mod bonjour {
    pub struct Advert;
    impl Advert {
        pub fn new(_: &str, _: u16, _: &[u8]) -> Option<Self> {
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn answers_only_this_iphone() {
        let ip = |s: &str| s.parse::<IpAddr>().unwrap();
        assert!(same_device(ip("192.168.1.20"), ip("192.168.1.20")));
        assert!(same_device(ip("::ffff:192.168.1.20"), ip("192.168.1.20")));
        assert!(same_device(ip("fe80::1"), ip("fe80::1")));
        assert!(!same_device(ip("192.168.1.21"), ip("192.168.1.20")));
        assert!(!same_device(ip("::ffff:192.168.1.21"), ip("::ffff:192.168.1.20")));
    }
    #[test]
    fn txt_record_is_length_prefixed() {
        let record = txt(&[("name".into(), "Hive".into()), ("flags".into(), "1".into())]).unwrap();
        assert_eq!(record, b"\x09name=Hive\x07flags=1");
        assert!(txt(&[("k".into(), "v".repeat(254))]).is_none());
    }
    /// The advertisement carries what an iPhone reads (instance name, port, TXT), checked with the system's own browser.
    #[cfg(target_os = "macos")]
    #[test]
    fn advertises_hive_as_a_pairable_host() {
        let identity = RpPairingFile::generate("Hive-test-advert");
        let host = PairableHostInfo::generate("Hive", "Mac17,7");
        let record = txt(&host.mdns_txt_records(&identity.identifier)).unwrap();
        let _advert = bonjour::Advert::new(&identity.identifier, 49999, &record).unwrap();
        let kind = idevice::remote_pairing::PAIRABLE_HOST_SERVICE_TYPE.trim_end_matches(".local.");
        let mut lookup = std::process::Command::new("dns-sd")
            .args(["-L", &identity.identifier, kind, "local."])
            .stdout(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        std::thread::sleep(Duration::from_secs(3));
        lookup.kill().unwrap();
        let output = String::from_utf8_lossy(&lookup.wait_with_output().unwrap().stdout).into_owned();
        assert!(output.contains(":49999"), "{output}");
        assert!(output.contains("name=Hive") && output.contains(&format!("identifier={}", identity.identifier)), "{output}");
    }
}
