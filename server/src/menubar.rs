//! On a Mac, Hive Server is in the menu bar while it runs: its dashboard, and Quit, which stops it until the Mac starts again
//! or Hive Server is opened again.
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, NSObject};
use objc2::{define_class, msg_send, sel, AnyThread, MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{NSApplication, NSApplicationActivationPolicy, NSImage, NSMenu, NSMenuItem, NSStatusBar, NSVariableStatusItemLength, NSWorkspace};
use objc2_foundation::{NSData, NSSize, NSString, NSURL};

unsafe extern "C" { fn getuid() -> u32; }

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "HiveServerMenu"]
    struct Menu;

    impl Menu {
        #[unsafe(method(dashboard:))]
        fn dashboard(&self, _from: Option<&AnyObject>) {
            let link = crate::setup::dashboard();
            if let Some(url) = NSURL::URLWithString(&NSString::from_str(&link)) { NSWorkspace::sharedWorkspace().openURL(&url); }
        }

        #[unsafe(method(quit:))]
        fn quit(&self, _from: Option<&AnyObject>) {
            // launchd would start it again at once: unload it instead (it loads again when the Mac starts, or Hive Server opens).
            std::process::Command::new("launchctl").args(["bootout", &format!("gui/{}/app.hive.server", unsafe { getuid() })]).status().ok();
            std::process::exit(0);
        }
    }
);

/// Runs the menu bar on this (the main) thread; never returns.
pub fn run() -> ! {
    let mtm = MainThreadMarker::new().expect("the menu bar runs on the main thread");
    let app = NSApplication::sharedApplication(mtm);
    app.setActivationPolicy(NSApplicationActivationPolicy::Accessory);
    let target: Retained<Menu> = unsafe { msg_send![Menu::alloc(mtm), init] };
    let item = NSStatusBar::systemStatusBar().statusItemWithLength(NSVariableStatusItemLength);
    let icon = NSImage::initWithData(NSImage::alloc(), &NSData::with_bytes(include_bytes!("../../dashboard/icon.png")));
    if let (Some(button), Some(icon)) = (item.button(mtm), icon) {
        icon.setSize(NSSize::new(18.0, 18.0));
        button.setImage(Some(&icon));
    }
    let menu = NSMenu::new(mtm);
    let add = |title: &str, action, key: &str| {
        let i = unsafe { NSMenuItem::initWithTitle_action_keyEquivalent(NSMenuItem::alloc(mtm), &NSString::from_str(title), action, &NSString::from_str(key)) };
        if action.is_some() { unsafe { i.setTarget(Some(&target)) }; }
        menu.addItem(&i);
    };
    add("Hive Server is running", None, "");
    add("Open Dashboard", Some(sel!(dashboard:)), "d");
    add("Quit Hive Server", Some(sel!(quit:)), "q");
    item.setMenu(Some(&menu));
    // Both stay for as long as Hive Server runs.
    std::mem::forget(item);
    std::mem::forget(target);
    app.run();
    std::process::exit(0)
}
