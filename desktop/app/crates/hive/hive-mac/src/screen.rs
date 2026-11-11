//! Screenshots in-process: ScreenCaptureKit takes the picture already scaled to the size the
//! model sees, with the mouse pointer drawn in when asked, and ImageIO encodes it. This replaces
//! Python's `screencapture` (a PNG at full resolution) followed by `sips` (scale and re-encode).
//!
//! The display list (SCShareableContent) costs tens of milliseconds to fetch, so it is kept and
//! fetched again only when a display isn't in it or a capture with it fails.

use std::ffi::{c_char, c_void, CStr};
use std::sync::{mpsc, Mutex};
use std::time::Duration;

use block2::RcBlock;
use objc2::runtime::{AnyObject, Bool};
use objc2::{class, msg_send};

use crate::ffi::{self, CGDirectDisplayID, CGImageRef, Cf};

#[link(name = "ScreenCaptureKit", kind = "framework")]
extern "C" {}

/// How long ScreenCaptureKit gets to answer.
const WAIT: Duration = Duration::from_secs(5);

/// An encoding for a captured image.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Format {
    /// JPEG at this quality (0..1); sips's `formatOptions 70` is 0.7.
    Jpeg(f64),
    Png,
}

/// A captured image (a retained CGImage).
pub struct Image(CGImageRef);

unsafe impl Send for Image {}

impl Image {
    pub fn width(&self) -> usize {
        unsafe { ffi::CGImageGetWidth(self.0) }
    }
    pub fn height(&self) -> usize {
        unsafe { ffi::CGImageGetHeight(self.0) }
    }
    pub fn encode(&self, format: Format) -> Result<Vec<u8>, String> {
        let (kind, quality) = match format {
            Format::Jpeg(q) => ("public.jpeg", Some(q)),
            Format::Png => ("public.png", None),
        };
        unsafe {
            let data = ffi::CFDataCreateMutable(std::ptr::null(), 0);
            if data.is_null() {
                return Err("couldn't allocate the image".into());
            }
            let data = Cf(data as *const c_void);
            let kind = Cf::string(kind);
            let dest = ffi::CGImageDestinationCreateWithData(
                data.0 as *mut c_void,
                kind.0,
                1,
                std::ptr::null(),
            );
            if dest.is_null() {
                return Err("couldn't encode the image".into());
            }
            let dest = Cf(dest);
            let value = quality.map(Cf::number);
            let options = match &value {
                Some(value) => {
                    let keys = [ffi::kCGImageDestinationLossyCompressionQuality];
                    let values = [value.0];
                    Cf(ffi::CFDictionaryCreate(
                        std::ptr::null(),
                        keys.as_ptr(),
                        values.as_ptr(),
                        1,
                        std::ptr::addr_of!(ffi::kCFTypeDictionaryKeyCallBacks),
                        std::ptr::addr_of!(ffi::kCFTypeDictionaryValueCallBacks),
                    ))
                }
                None => Cf(std::ptr::null()),
            };
            ffi::CGImageDestinationAddImage(dest.0, self.0, options.0);
            if !ffi::CGImageDestinationFinalize(dest.0) {
                return Err("couldn't encode the image".into());
            }
            let len = ffi::CFDataGetLength(data.0) as usize;
            let bytes = ffi::CFDataGetBytePtr(data.0);
            Ok(if bytes.is_null() {
                Vec::new()
            } else {
                std::slice::from_raw_parts(bytes, len).to_vec()
            })
        }
    }
}

impl Drop for Image {
    fn drop(&mut self) {
        unsafe { ffi::CGImageRelease(self.0) }
    }
}

/// The display the agent works on: Hive's virtual monitor while it is on, else the main display.
pub fn work_display() -> CGDirectDisplayID {
    crate::virtual_monitor::display()
        .map(|(id, _)| id)
        .unwrap_or_else(ffi::main_display)
}

/// A retained SCShareableContent.
struct Content(*mut AnyObject);

unsafe impl Send for Content {}

impl Drop for Content {
    fn drop(&mut self) {
        unsafe {
            let _: () = msg_send![self.0, release];
        }
    }
}

static CONTENT: Mutex<Option<Content>> = Mutex::new(None);

struct Sent<T>(T);
unsafe impl<T> Send for Sent<T> {}

fn describe(error: *mut AnyObject) -> String {
    if error.is_null() {
        return "no answer".into();
    }
    unsafe {
        let text: *mut AnyObject = msg_send![error, localizedDescription];
        if text.is_null() {
            return "unknown error".into();
        }
        let utf8: *const c_char = msg_send![text, UTF8String];
        if utf8.is_null() {
            return "unknown error".into();
        }
        CStr::from_ptr(utf8).to_string_lossy().into_owned()
    }
}

fn fetch_content() -> Result<Content, String> {
    let (tx, rx) = mpsc::channel::<Result<Sent<*mut AnyObject>, String>>();
    let block = RcBlock::new(move |content: *mut AnyObject, error: *mut AnyObject| {
        let _ = tx.send(if content.is_null() {
            Err(describe(error))
        } else {
            let kept: *mut AnyObject = unsafe { msg_send![content, retain] };
            Ok(Sent(kept))
        });
    });
    unsafe {
        let _: () = msg_send![class!(SCShareableContent), getShareableContentWithCompletionHandler: &*block];
    }
    match rx.recv_timeout(WAIT) {
        Ok(Ok(content)) => Ok(Content(content.0)),
        Ok(Err(why)) => Err(why),
        Err(_) => Err("ScreenCaptureKit didn't list the displays".into()),
    }
}

/// The SCDisplay for `display` in `content` (borrowed from it), if it is there.
fn find_display(content: &Content, display: CGDirectDisplayID) -> Option<*mut AnyObject> {
    unsafe {
        let displays: *mut AnyObject = msg_send![content.0, displays];
        if displays.is_null() {
            return None;
        }
        let count: usize = msg_send![displays, count];
        (0..count).find_map(|i| {
            let d: *mut AnyObject = msg_send![displays, objectAtIndex: i];
            let id: u32 = msg_send![d, displayID];
            (id == display).then_some(d)
        })
    }
}

fn capture_with(
    display: *mut AnyObject,
    width: usize,
    height: usize,
    cursor: bool,
) -> Result<Image, String> {
    unsafe {
        let none: *mut AnyObject = msg_send![class!(NSArray), array];
        let filter: *mut AnyObject = msg_send![class!(SCContentFilter), alloc];
        let filter: *mut AnyObject =
            msg_send![filter, initWithDisplay: display, excludingWindows: none];
        if filter.is_null() {
            return Err("ScreenCaptureKit refused the display".into());
        }
        let config: *mut AnyObject = msg_send![class!(SCStreamConfiguration), new];
        let _: () = msg_send![config, setWidth: width];
        let _: () = msg_send![config, setHeight: height];
        let _: () = msg_send![config, setShowsCursor: Bool::new(cursor)];
        let (tx, rx) = mpsc::channel::<Result<Sent<CGImageRef>, String>>();
        let block = RcBlock::new(move |image: CGImageRef, error: *mut AnyObject| {
            let _ = tx.send(if image.is_null() {
                Err(describe(error))
            } else {
                Ok(Sent(ffi::CGImageRetain(image)))
            });
        });
        let _: () = msg_send![class!(SCScreenshotManager), captureImageWithFilter: filter,
                              configuration: config, completionHandler: &*block];
        let answer = rx.recv_timeout(WAIT);
        let _: () = msg_send![filter, release];
        let _: () = msg_send![config, release];
        match answer {
            Ok(Ok(image)) => Ok(Image(image.0)),
            Ok(Err(why)) => Err(why),
            Err(_) => Err("ScreenCaptureKit didn't take the screenshot".into()),
        }
    }
}

/// Captures `display` scaled to `width` x `height` pixels, with the mouse pointer drawn in when
/// `cursor`. Fails (rather than returning only the wallpaper) without Screen Recording permission.
pub fn capture(
    display: CGDirectDisplayID,
    width: usize,
    height: usize,
    cursor: bool,
) -> Result<Image, String> {
    objc2::rc::autoreleasepool(|_| {
        let mut cached = CONTENT.lock().unwrap_or_else(|e| e.into_inner());
        let mut fresh = false;
        loop {
            if cached.is_none() {
                *cached = Some(
                    fetch_content().map_err(|why| format!("couldn't take a screenshot: {why}"))?,
                );
                fresh = true;
            }
            let content = cached.as_ref().expect("just set");
            let found = find_display(content, display);
            let taken = match found {
                Some(d) => capture_with(d, width.max(1), height.max(1), cursor),
                None => Err(format!("display {display} isn't available to capture")),
            };
            match taken {
                Ok(image) => return Ok(image),
                Err(_) if !fresh => *cached = None, // the displays changed since: list them again
                Err(why) => return Err(format!("couldn't take a screenshot: {why}")),
            }
        }
    })
}

/// Captures the display the agent works on and encodes it.
pub fn capture_work_display(
    width: usize,
    height: usize,
    cursor: bool,
    format: Format,
) -> Result<Vec<u8>, String> {
    capture(work_display(), width, height, cursor)?.encode(format)
}

/// The size in pixels of the display the agent works on.
pub fn work_display_pixels() -> (usize, usize) {
    ffi::display_pixels(work_display())
}
