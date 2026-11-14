//! Hive Cloud client: the owner's private cloud for everything Hive keeps on a device.
//!
//! - [`deploy`]: put the Worker (cloud/hive-cloud/worker.js) into the owner's Cloudflare account.
//! - [`enroll`]: claim it with the first device, invite or recover later devices.
//! - [`sync`]: end-to-end encrypted push, pull, restore, verification and status.
//! - [`scan`]: what is uploaded from this device and what is left out, with reasons.
//! - [`crypto`], [`api`], [`config`]: keys, the HTTP API, and settings kept on this device.
pub mod api;
pub mod config;
pub mod crypto;
pub mod deploy;
pub mod enroll;
pub mod scan;
pub mod sync;
