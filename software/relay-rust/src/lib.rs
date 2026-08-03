//! Rust/WASM port of the AI Pendant Cloudflare relay.
//!
//! This is a byte-compatible drop-in for `cloud-relay/server.js`: identical
//! paths, methods, status codes, JSON key order, header names, auth semantics,
//! D1 schema usage and R2 object keys.
//!
//! Layering: everything that can be tested on the host toolchain (job
//! transitions, scope checks, credential hashing, telemetry mapping, product
//! sync) lives in dependency-free modules. Only the binding glue — D1, R2,
//! Workers AI, HTTP — is `wasm32`-gated, so `cargo test` runs natively and
//! fast.

pub mod audio_storage;
pub mod device_auth;
pub mod jobs;
pub mod product_sync;
pub mod routing;
pub mod util;

pub mod store;

#[cfg(target_arch = "wasm32")]
pub mod config;
#[cfg(target_arch = "wasm32")]
pub mod http;
#[cfg(target_arch = "wasm32")]
pub mod routes;
#[cfg(target_arch = "wasm32")]
pub mod speech;
#[cfg(target_arch = "wasm32")]
pub mod worker_entry;
