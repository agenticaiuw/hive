//! Plugging a trusted iPhone into Hive's Mac app performs its one-time setup.
//! The cloud receives the Apple pairing identity before it is written into Hive
//! on the phone. This is setup only; phone tools continue to run on the server.
use hive_phone_bootstrap::usb;
use std::{
    collections::{HashMap, HashSet},
    time::Duration,
};

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
        loop {
            let devices = runtime.block_on(async {
                tokio::time::timeout(Duration::from_secs(5), usb::devices()).await
            });
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
                                continue;
                            }
                            Some(bytes)
                        }
                        Err(ureq::Error::Status(404, _)) => None,
                        Err(_) => continue,
                    };
                    let credential = match credential.or_else(|| pending.get(&device).cloned()) {
                        Some(bytes) => bytes,
                        None => {
                            let identity = runtime.block_on(async {
                                tokio::time::timeout(Duration::from_secs(90), async {
                                    match usb::installed_identity(&device).await? {
                                        Some(bytes) => Ok(bytes),
                                        None => usb::create_identity(&device, &host).await,
                                    }
                                })
                                .await
                            });
                            let Ok(Ok(bytes)) = identity else {
                                continue;
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
                    let Ok(response) = response else {
                        continue;
                    };
                    let Ok(relay) = response.into_string() else {
                        continue;
                    };
                    let installed = runtime.block_on(async {
                        tokio::time::timeout(
                            Duration::from_secs(30),
                            usb::install(&device, &credential, relay.as_bytes()),
                        )
                        .await
                    });
                    if matches!(installed, Ok(Ok(()))) {
                        complete.insert(device.clone());
                        pending.remove(&device);
                    }
                }
            }
            std::thread::sleep(Duration::from_secs(5));
        }
    });
}
