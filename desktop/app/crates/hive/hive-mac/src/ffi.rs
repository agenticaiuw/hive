//! The bits of CoreGraphics, CoreFoundation and ImageIO the Mac side reads: where the cursor is,
//! the displays, the window list, the modifier flags, and image encoding. Plain `extern "C"`.

#![allow(non_upper_case_globals, non_snake_case)]

use std::ffi::{c_char, c_void};

pub type CFTypeRef = *const c_void;
pub type CFStringRef = *const c_void;
pub type CFArrayRef = *const c_void;
pub type CFDictionaryRef = *const c_void;
pub type CFNumberRef = *const c_void;
pub type CFMutableDataRef = *mut c_void;
pub type CGImageRef = *const c_void;
pub type CGDirectDisplayID = u32;

#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct CGPoint {
    pub x: f64,
    pub y: f64,
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct CGSize {
    pub width: f64,
    pub height: f64,
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct CGRect {
    pub origin: CGPoint,
    pub size: CGSize,
}

unsafe impl objc2::encode::Encode for CGPoint {
    const ENCODING: objc2::encode::Encoding =
        objc2::encode::Encoding::Struct("CGPoint", &[f64::ENCODING, f64::ENCODING]);
}
unsafe impl objc2::encode::Encode for CGSize {
    const ENCODING: objc2::encode::Encoding =
        objc2::encode::Encoding::Struct("CGSize", &[f64::ENCODING, f64::ENCODING]);
}
unsafe impl objc2::encode::Encode for CGRect {
    const ENCODING: objc2::encode::Encoding =
        objc2::encode::Encoding::Struct("CGRect", &[CGPoint::ENCODING, CGSize::ENCODING]);
}

pub const UTF8: u32 = 0x0800_0100;
pub const kCFNumberDoubleType: i32 = 13;

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    pub fn CFRelease(cf: CFTypeRef);
    pub fn CFArrayGetCount(array: CFArrayRef) -> isize;
    pub fn CFArrayGetValueAtIndex(array: CFArrayRef, index: isize) -> *const c_void;
    pub fn CFDictionaryGetValue(dict: CFDictionaryRef, key: *const c_void) -> *const c_void;
    pub fn CFDictionaryCreate(
        allocator: *const c_void,
        keys: *const *const c_void,
        values: *const *const c_void,
        count: isize,
        key_callbacks: *const c_void,
        value_callbacks: *const c_void,
    ) -> CFDictionaryRef;
    pub static kCFTypeDictionaryKeyCallBacks: c_void;
    pub static kCFTypeDictionaryValueCallBacks: c_void;
    pub fn CFStringCreateWithBytes(
        allocator: *const c_void,
        bytes: *const u8,
        len: isize,
        encoding: u32,
        external: bool,
    ) -> CFStringRef;
    pub fn CFStringGetLength(s: CFStringRef) -> isize;
    pub fn CFStringGetMaximumSizeForEncoding(length: isize, encoding: u32) -> isize;
    pub fn CFStringGetCString(
        s: CFStringRef,
        buffer: *mut c_char,
        size: isize,
        encoding: u32,
    ) -> bool;
    pub fn CFNumberCreate(allocator: *const c_void, kind: i32, value: *const c_void)
        -> CFNumberRef;
    pub fn CFNumberGetValue(number: CFNumberRef, kind: i32, value: *mut c_void) -> bool;
    pub fn CFBooleanGetValue(boolean: *const c_void) -> bool;
    pub fn CFDataCreateMutable(allocator: *const c_void, capacity: isize) -> CFMutableDataRef;
    pub fn CFDataGetLength(data: *const c_void) -> isize;
    pub fn CFDataGetBytePtr(data: *const c_void) -> *const u8;
}

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    pub fn CGEventCreate(source: *const c_void) -> *const c_void;
    pub fn CGEventGetLocation(event: *const c_void) -> CGPoint;
    pub fn CGEventSourceFlagsState(state: i32) -> u64;
    pub fn CGEventSourceSecondsSinceLastEventType(state: i32, event_type: u32) -> f64;
    pub fn CGMainDisplayID() -> CGDirectDisplayID;
    pub fn CGDisplayBounds(display: CGDirectDisplayID) -> CGRect;
    pub fn CGGetActiveDisplayList(
        max: u32,
        displays: *mut CGDirectDisplayID,
        count: *mut u32,
    ) -> i32;
    pub fn CGGetOnlineDisplayList(
        max: u32,
        displays: *mut CGDirectDisplayID,
        count: *mut u32,
    ) -> i32;
    pub fn CGDisplayVendorNumber(display: CGDirectDisplayID) -> u32;
    pub fn CGDisplayModelNumber(display: CGDirectDisplayID) -> u32;
    pub fn CGDisplayCopyDisplayMode(display: CGDirectDisplayID) -> *const c_void;
    pub fn CGDisplayModeGetPixelWidth(mode: *const c_void) -> usize;
    pub fn CGDisplayModeGetPixelHeight(mode: *const c_void) -> usize;
    pub fn CGDisplayModeRelease(mode: *const c_void);
    pub fn CGWarpMouseCursorPosition(point: CGPoint) -> i32;
    pub fn CGWindowListCopyWindowInfo(option: u32, relative_to: u32) -> CFArrayRef;
    pub fn CGImageGetWidth(image: CGImageRef) -> usize;
    pub fn CGImageGetHeight(image: CGImageRef) -> usize;
    pub fn CGImageRetain(image: CGImageRef) -> CGImageRef;
    pub fn CGImageRelease(image: CGImageRef);
}

#[link(name = "ImageIO", kind = "framework")]
extern "C" {
    pub fn CGImageDestinationCreateWithData(
        data: CFMutableDataRef,
        kind: CFStringRef,
        count: usize,
        options: CFDictionaryRef,
    ) -> *const c_void;
    pub fn CGImageDestinationAddImage(
        dest: *const c_void,
        image: CGImageRef,
        properties: CFDictionaryRef,
    );
    pub fn CGImageDestinationFinalize(dest: *const c_void) -> bool;
    pub static kCGImageDestinationLossyCompressionQuality: CFStringRef;
}

/// An owned CoreFoundation object, released when dropped.
pub struct Cf(pub CFTypeRef);

impl Cf {
    pub fn string(s: &str) -> Cf {
        Cf(unsafe {
            CFStringCreateWithBytes(std::ptr::null(), s.as_ptr(), s.len() as isize, UTF8, false)
        })
    }
    pub fn number(v: f64) -> Cf {
        Cf(unsafe {
            CFNumberCreate(
                std::ptr::null(),
                kCFNumberDoubleType,
                &v as *const f64 as *const c_void,
            )
        })
    }
}

impl Drop for Cf {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { CFRelease(self.0) }
        }
    }
}

/// A CFString's text ("" for null or something that won't convert).
pub fn cf_string(s: CFStringRef) -> String {
    if s.is_null() {
        return String::new();
    }
    unsafe {
        let size = CFStringGetMaximumSizeForEncoding(CFStringGetLength(s), UTF8) + 1;
        let mut buffer = vec![0u8; size.max(1) as usize];
        if !CFStringGetCString(s, buffer.as_mut_ptr() as *mut c_char, size, UTF8) {
            return String::new();
        }
        let end = buffer.iter().position(|&b| b == 0).unwrap_or(buffer.len());
        String::from_utf8_lossy(&buffer[..end]).into_owned()
    }
}

/// A CFNumber as a double (0 for null).
pub fn cf_number(n: CFNumberRef) -> f64 {
    let mut value = 0.0f64;
    if !n.is_null() {
        unsafe {
            CFNumberGetValue(
                n,
                kCFNumberDoubleType,
                &mut value as *mut f64 as *mut c_void,
            )
        };
    }
    value
}

/// Cursor position in global screen points (origin at the main display's top-left).
pub fn cursor_position() -> (f64, f64) {
    unsafe {
        let event = CGEventCreate(std::ptr::null());
        if event.is_null() {
            return (0.0, 0.0);
        }
        let p = CGEventGetLocation(event);
        CFRelease(event);
        (p.x, p.y)
    }
}

/// A display's frame as (x, y, width, height) in points.
pub type Bounds = (f64, f64, f64, f64);

fn bounds_of(display: CGDirectDisplayID) -> Bounds {
    let r = unsafe { CGDisplayBounds(display) };
    (r.origin.x, r.origin.y, r.size.width, r.size.height)
}

/// The online displays' ids (up to 16), including ones that are asleep or mirrored.
pub fn online_displays() -> Option<Vec<CGDirectDisplayID>> {
    let mut ids = [0u32; 16];
    let mut count = 0u32;
    if unsafe { CGGetOnlineDisplayList(16, ids.as_mut_ptr(), &mut count) } != 0 {
        return None;
    }
    Some(ids[..count as usize].to_vec())
}

/// (x, y, width, height) of every display, in points. Includes displays that are asleep.
pub fn display_bounds() -> Vec<Bounds> {
    let mut ids = [0u32; 16];
    let mut count = 0u32;
    unsafe { CGGetActiveDisplayList(16, ids.as_mut_ptr(), &mut count) };
    if count == 0 {
        // every display is asleep
        unsafe { CGGetOnlineDisplayList(16, ids.as_mut_ptr(), &mut count) };
    }
    ids[..count as usize]
        .iter()
        .map(|&d| bounds_of(d))
        .collect()
}

pub fn main_display() -> CGDirectDisplayID {
    unsafe { CGMainDisplayID() }
}

pub fn main_display_bounds() -> Bounds {
    bounds_of(main_display())
}

pub fn display_frame(display: CGDirectDisplayID) -> Bounds {
    bounds_of(display)
}

pub fn display_identity(display: CGDirectDisplayID) -> (u32, u32) {
    unsafe {
        (
            CGDisplayVendorNumber(display),
            CGDisplayModelNumber(display),
        )
    }
}

/// The display's size in pixels (its current mode's backing store), or its size in points if
/// that isn't known.
pub fn display_pixels(display: CGDirectDisplayID) -> (usize, usize) {
    unsafe {
        let mode = CGDisplayCopyDisplayMode(display);
        if !mode.is_null() {
            let size = (
                CGDisplayModeGetPixelWidth(mode),
                CGDisplayModeGetPixelHeight(mode),
            );
            CGDisplayModeRelease(mode);
            if size.0 > 0 && size.1 > 0 {
                return size;
            }
        }
    }
    let (_, _, w, h) = bounds_of(display);
    (w as usize, h as usize)
}

pub fn warp(x: f64, y: f64) {
    unsafe { CGWarpMouseCursorPosition(CGPoint { x, y }) };
}

/// A shift key is down (kCGEventSourceStateHIDSystemState's shift flag).
pub fn shift_down() -> bool {
    unsafe { CGEventSourceFlagsState(1) & (1 << 17) != 0 }
}

/// Seconds since the last input from any mouse, trackpad or keyboard, the helper's virtual one
/// included (kCGEventSourceStateHIDSystemState). Not kCGAnyInputEventType: some event that isn't
/// a person's comes many times a second, so it's always near 0. These are the clicks, moves,
/// drags, keys, modifier keys, scrolls and trackpad gestures.
pub fn seconds_since_input() -> f64 {
    const PEOPLE: [u32; 16] = [1, 2, 3, 4, 5, 6, 7, 10, 11, 12, 22, 25, 26, 27, 29, 30];
    PEOPLE
        .iter()
        .map(|t| unsafe { CGEventSourceSecondsSinceLastEventType(1, *t) })
        .fold(f64::INFINITY, f64::min)
}

/// Caps Lock is on (kCGEventSourceStateHIDSystemState's alpha-shift flag).
pub fn caps_lock_on() -> bool {
    unsafe { CGEventSourceFlagsState(1) & (1 << 16) != 0 }
}
