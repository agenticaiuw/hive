//! Durable session, local request, memory, settings, and ingestion primitives.
//!
//! App-server requests and workspace actions remain under the host's control;
//! persistence helpers operate only on paths explicitly supplied by the caller.

pub mod ingest;
pub mod memory;
pub mod phone_transport;

pub mod request_ledger;
pub mod settings;
pub mod task_recovery;
pub mod thread_identity;
#[cfg(unix)]
pub mod workspace_client;
pub mod workspace_update;

/// Synchronously commit a private state file. Buffers remain owned by the caller.
///
/// # Safety
/// Both pointers must be valid for their supplied lengths until the call returns.
#[cfg(unix)]
#[no_mangle]
pub unsafe extern "C" fn agent_atomic_write(
    path: *const u8,
    path_len: usize,
    data: *const u8,
    data_len: usize,
) -> i32 {
    use std::os::unix::ffi::OsStrExt;
    if path.is_null() || data.is_null() {
        return libc::EINVAL;
    }
    let result = std::panic::catch_unwind(|| {
        let path = std::slice::from_raw_parts(path, path_len);
        if path.contains(&0) {
            return libc::EINVAL;
        }
        let data = std::slice::from_raw_parts(data, data_len);
        let path = std::path::Path::new(std::ffi::OsStr::from_bytes(path));
        match thread_identity::atomic_write_standard(path, data) {
            Ok(()) => 0,
            Err(thread_identity::IdentityError::Io { source, .. }) => {
                source.raw_os_error().unwrap_or(libc::EIO)
            }
            Err(_) => libc::EIO,
        }
    });
    result.unwrap_or(libc::EIO)
}

/// Append bytes to an open journal descriptor and synchronize it before returning.
///
/// # Safety
/// The data pointer must be valid for the supplied length until this call returns.
#[cfg(unix)]
#[no_mangle]
pub unsafe extern "C" fn agent_append_synced(fd: i32, data: *const u8, len: usize) -> i32 {
    if fd < 0 || data.is_null() {
        return libc::EINVAL;
    }
    let result = std::panic::catch_unwind(|| {
        let bytes = std::slice::from_raw_parts(data, len);
        let mut written = 0;
        while written < bytes.len() {
            let count = libc::write(fd, bytes[written..].as_ptr().cast(), bytes.len() - written);
            if count < 0 {
                let error = std::io::Error::last_os_error();
                if error.kind() == std::io::ErrorKind::Interrupted {
                    continue;
                }
                return error.raw_os_error().unwrap_or(libc::EIO);
            }
            if count == 0 {
                return libc::EIO;
            }
            written += count as usize;
        }
        if libc::fsync(fd) == 0 {
            0
        } else {
            std::io::Error::last_os_error()
                .raw_os_error()
                .unwrap_or(libc::EIO)
        }
    });
    result.unwrap_or(libc::EIO)
}

/// Apply a locked recovery-state operation, writing one JSON result into the caller buffer.
///
/// # Safety
/// Pointers must remain valid for their supplied lengths until the call returns.
#[cfg(unix)]
#[no_mangle]
pub unsafe extern "C" fn agent_recovery_apply(
    directory: *const u8,
    directory_len: usize,
    request: *const u8,
    request_len: usize,
    output: *mut u8,
    output_len: usize,
) -> i64 {
    use std::os::unix::ffi::OsStrExt;
    if directory.is_null() || request.is_null() || output.is_null() {
        return -(libc::EINVAL as i64);
    }
    let result = std::panic::catch_unwind(|| {
        let path = std::slice::from_raw_parts(directory, directory_len);
        if path.contains(&0) {
            return Err(libc::EINVAL);
        }
        let input = std::slice::from_raw_parts(request, request_len);
        let req: serde_json::Value = serde_json::from_slice(input).map_err(|_| libc::EINVAL)?;
        let directory = std::path::Path::new(std::ffi::OsStr::from_bytes(path));
        let value = match task_recovery::apply(directory, &req) {
            Ok(result) => serde_json::json!({"ok":true,"result":result}),
            Err(message) => serde_json::json!({"ok":false,"error":message}),
        };
        let bytes = serde_json::to_vec(&value).map_err(|_| libc::EIO)?;
        if bytes.len() > output_len {
            return Err(libc::EOVERFLOW);
        }
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), output, bytes.len());
        Ok(bytes.len() as i64)
    });
    match result {
        Ok(Ok(n)) => n,
        Ok(Err(e)) => -(e as i64),
        Err(_) => -(libc::EIO as i64),
    }
}
