//! What CoreAudio says about this Mac's sound devices, asked directly so it's always current
//! (python/audio.py). Reading these properties opens nothing: no microphone, no speaker.

use std::ffi::{c_char, c_void, CStr};

/// kAudioObjectSystemObject
const SYSTEM: u32 = 1;

#[repr(C)]
struct Address {
    selector: u32,
    scope: u32,
    element: u32,
}

#[link(name = "CoreAudio", kind = "framework")]
extern "C" {
    fn AudioObjectGetPropertyData(
        object: u32,
        address: *const Address,
        qualifier_size: u32,
        qualifier: *const c_void,
        size: *mut u32,
        data: *mut c_void,
    ) -> i32;
    fn AudioObjectGetPropertyDataSize(
        object: u32,
        address: *const Address,
        qualifier_size: u32,
        qualifier: *const c_void,
        size: *mut u32,
    ) -> i32;
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFStringGetCString(
        string: *const c_void,
        buffer: *mut c_char,
        size: isize,
        encoding: u32,
    ) -> u8;
    fn CFRelease(object: *const c_void);
}

const UTF8: u32 = 0x0800_0100;

fn code(s: &[u8; 4]) -> u32 {
    u32::from_be_bytes(*s)
}

fn address(selector: &[u8; 4], scope: &[u8; 4]) -> Address {
    Address {
        selector: code(selector),
        scope: code(scope),
        element: 0,
    }
}

fn get_u32(object: u32, selector: &[u8; 4], scope: &[u8; 4]) -> Option<u32> {
    let address = address(selector, scope);
    let mut value: u32 = 0;
    let mut size = std::mem::size_of::<u32>() as u32;
    // SAFETY: value and size are valid for the call; CoreAudio writes at most `size` bytes.
    let status = unsafe {
        AudioObjectGetPropertyData(
            object,
            &address,
            0,
            std::ptr::null(),
            &mut size,
            &mut value as *mut u32 as *mut c_void,
        )
    };
    (status == 0).then_some(value)
}

pub fn default_input() -> Option<u32> {
    get_u32(SYSTEM, b"dIn ", b"glob")
}

pub fn default_output() -> Option<u32> {
    get_u32(SYSTEM, b"dOut", b"glob")
}

pub fn devices() -> Vec<u32> {
    let address = address(b"dev#", b"glob");
    let mut size: u32 = 0;
    // SAFETY: size is a valid out-pointer.
    if unsafe { AudioObjectGetPropertyDataSize(SYSTEM, &address, 0, std::ptr::null(), &mut size) }
        != 0
    {
        return Vec::new();
    }
    let mut ids = vec![0u32; size as usize / 4];
    // SAFETY: ids holds `size` bytes.
    let status = unsafe {
        AudioObjectGetPropertyData(
            SYSTEM,
            &address,
            0,
            std::ptr::null(),
            &mut size,
            ids.as_mut_ptr() as *mut c_void,
        )
    };
    if status != 0 {
        return Vec::new();
    }
    ids.truncate(size as usize / 4);
    ids
}

pub fn has_input(device: u32) -> bool {
    let address = address(b"stm#", b"inpt");
    let mut size: u32 = 0;
    // SAFETY: size is a valid out-pointer.
    (unsafe { AudioObjectGetPropertyDataSize(device, &address, 0, std::ptr::null(), &mut size) })
        == 0
        && size > 0
}

/// The microphone it listens with: the macOS-selected input, including Bluetooth headsets.
pub fn microphone() -> Option<u32> {
    default_input()
}

/// The device's name, or "?".
pub fn name(device: Option<u32>) -> String {
    let Some(device) = device.filter(|d| *d != 0) else {
        return "?".into();
    };
    let address = address(b"lnam", b"glob");
    let mut string: *const c_void = std::ptr::null();
    let mut size = std::mem::size_of::<*const c_void>() as u32;
    // SAFETY: string and size are valid; the property is a CFStringRef we own and release.
    let status = unsafe {
        AudioObjectGetPropertyData(
            device,
            &address,
            0,
            std::ptr::null(),
            &mut size,
            &mut string as *mut *const c_void as *mut c_void,
        )
    };
    if status != 0 || string.is_null() {
        return "?".into();
    }
    let mut buffer = [0 as c_char; 256];
    // SAFETY: buffer holds 256 bytes; CFStringGetCString NUL-terminates what it writes.
    let name = unsafe {
        let ok = CFStringGetCString(string, buffer.as_mut_ptr(), buffer.len() as isize, UTF8);
        CFRelease(string);
        if ok == 0 {
            String::new()
        } else {
            CStr::from_ptr(buffer.as_ptr())
                .to_string_lossy()
                .into_owned()
        }
    };
    name
}

/// True when the agent's voice comes out of something the microphone can hear: the Mac's own
/// speakers or a display's, rather than headphones, AirPods or a headset.
pub fn output_is_speakers() -> bool {
    let Some(device) = default_output().filter(|d| *d != 0) else {
        return true;
    };
    let transport = get_u32(device, b"tran", b"glob");
    if transport == Some(code(b"bltn")) {
        return get_u32(device, b"ssrc", b"outp") != Some(code(b"hdpn")); // the headphone jack, or the speakers
    }
    [code(b"hdmi"), code(b"dprt"), code(b"airp")]
        .into_iter()
        .any(|t| transport == Some(t))
}
