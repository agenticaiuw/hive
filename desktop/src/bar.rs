//! The fn key's type bar on a Mac: press fn and let go (by itself) and a small floating window takes a request; return sends
//! it to Hive's orchestrator and shows the answer; escape, its close button or fn again hides it. The window doesn't take
//! the front from the owner's app, and macOS shows Hive the fn key only once Hive has the Accessibility permission. Hive's
//! menu in the menu bar quits it (macOS won't replace a running app with a new download).
use block2::RcBlock;
use dispatch2::DispatchQueue;
use objc2::rc::Retained;
use objc2::{MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{NSAlert, NSAlertFirstButtonReturn, NSApplication, NSApplicationActivationPolicy, NSAutoresizingMaskOptions, NSBackingStoreType, NSEvent,
    NSEventMask, NSEventModifierFlags, NSEventType, NSFloatingWindowLevel, NSFont, NSMenu, NSMenuItem, NSPanel, NSScreen, NSStandardKeyBindingResponding, NSStatusBar, NSTextField, NSTextView,
    NSVariableStatusItemLength, NSWindowStyleMask, NSWorkspace};
use objc2_foundation::{NSDictionary, NSNumber, NSPoint, NSRect, NSSize, NSString};
use serde_json::json;
use std::cell::{Cell, RefCell};
use std::ptr::NonNull;
use std::time::{Duration, Instant};

struct Bar { panel: Retained<NSPanel>, field: Retained<NSTextField>, answer: Retained<NSTextField> }
thread_local! {
    static BAR: RefCell<Option<Bar>> = const { RefCell::new(None) };
    static FN_DOWN: Cell<Option<Instant>> = const { Cell::new(None) };
    static APP: RefCell<String> = const { RefCell::new(String::new()) };
}

fn rect(x: f64, y: f64, w: f64, h: f64) -> NSRect { NSRect::new(NSPoint::new(x, y), NSSize::new(w, h)) }

/// Runs the app's main thread (never returns).
pub fn run() {
    let mtm = MainThreadMarker::new().expect("the bar runs on the main thread");
    let app = NSApplication::sharedApplication(mtm);
    app.setActivationPolicy(NSApplicationActivationPolicy::Accessory);
    let style = NSWindowStyleMask::Titled | NSWindowStyleMask::Closable | NSWindowStyleMask::NonactivatingPanel;
    let panel = NSPanel::initWithContentRect_styleMask_backing_defer(NSPanel::alloc(mtm), rect(0.0, 0.0, 560.0, 150.0), style, NSBackingStoreType::Buffered, false);
    panel.setTitle(&NSString::from_str("Hive"));
    panel.setLevel(NSFloatingWindowLevel);
    panel.setHidesOnDeactivate(false);
    unsafe { panel.setReleasedWhenClosed(false) };
    let field = NSTextField::textFieldWithString(&NSString::from_str(""), mtm);
    field.setPlaceholderString(Some(&NSString::from_str("Ask Hive…")));
    field.setFont(Some(&NSFont::systemFontOfSize(17.0)));
    field.setFrame(rect(16.0, 104.0, 528.0, 30.0));
    let answer = NSTextField::wrappingLabelWithString(&NSString::from_str(""), mtm);
    answer.setSelectable(true);
    answer.setFrame(rect(16.0, 10.0, 528.0, 86.0));
    let view = panel.contentView().expect("a panel has a content view");
    view.addSubview(&field);
    view.addSubview(&answer);
    BAR.with(|b| *b.borrow_mut() = Some(Bar { panel, field, answer }));
    let item = NSStatusBar::systemStatusBar().statusItemWithLength(NSVariableStatusItemLength);
    if let (Some(button), Some(logo)) = (item.button(mtm), app.applicationIconImage()) {
        logo.setSize(NSSize::new(20.0, 20.0));
        button.setImage(Some(&logo));
    }
    let menu = NSMenu::new(mtm);
    menu.addItem(&*unsafe { NSMenuItem::initWithTitle_action_keyEquivalent(NSMenuItem::alloc(mtm), &NSString::from_str("Quit Hive"),
        Some(objc2::sel!(terminate:)), &NSString::from_str("q")) });
    item.setMenu(Some(&menu));
    std::mem::forget(item); // stays for as long as the app runs
    listen();
    app.run();
}

/// Asks macOS once for the Accessibility permission (which also lets the agents drive apps) and starts watching keys when
/// it's given.
fn listen() {
    let prompt = NSDictionary::<NSString, NSNumber>::from_slices(&[&*NSString::from_str("AXTrustedCheckOptionPrompt")], &[&*NSNumber::numberWithBool(true)]);
    if unsafe { crate::os::AXIsProcessTrustedWithOptions(Retained::as_ptr(&prompt).cast()) } { return watch(); }
    std::thread::spawn(|| {
        while !unsafe { crate::os::AXIsProcessTrusted() } { std::thread::sleep(Duration::from_secs(2)); }
        DispatchQueue::main().exec_async(watch);
    });
}

fn watch() {
    let mask = NSEventMask::FlagsChanged | NSEventMask::KeyDown;
    let others = RcBlock::new(|e: NonNull<NSEvent>| seen(unsafe { e.as_ref() }));
    let own = RcBlock::new(|e: NonNull<NSEvent>| -> *mut NSEvent { if typed(unsafe { e.as_ref() }) { std::ptr::null_mut() } else { e.as_ptr() } });
    // Both watch for as long as the app runs.
    std::mem::forget(NSEvent::addGlobalMonitorForEventsMatchingMask_handler(mask, &others));
    std::mem::forget(unsafe { NSEvent::addLocalMonitorForEventsMatchingMask_handler(mask, &own) });
}

/// fn pressed and let go within 0.6s with no other key toggles the bar (fn+delete, fn+arrows and the like don't).
fn seen(e: &NSEvent) {
    if e.r#type() == NSEventType::FlagsChanged && e.keyCode() == 63 {
        if e.modifierFlags().contains(NSEventModifierFlags::Function) { FN_DOWN.set(Some(Instant::now())); }
        else if FN_DOWN.take().is_some_and(|t| t.elapsed() < Duration::from_millis(600)) { toggle(); }
    } else {
        FN_DOWN.set(None);
    }
}

/// The bar's own keys: return sends, escape hides. True when the key was one of them.
fn typed(e: &NSEvent) -> bool {
    seen(e);
    if e.r#type() != NSEventType::KeyDown { return false; }
    match e.keyCode() { 36 | 76 => { send(); true } 53 => { with(|b| b.panel.orderOut(None)); true } _ => false }
}

fn with(f: impl FnOnce(&Bar)) { BAR.with(|b| if let Some(b) = b.borrow().as_ref() { f(b) }) }

fn toggle() {
    with(|b| {
        if b.panel.isVisible() { return b.panel.orderOut(None); }
        // The app the owner is in, for its rules.
        let front = NSWorkspace::sharedWorkspace().frontmostApplication().and_then(|a| a.localizedName()).map(|n| n.to_string());
        APP.with(|a| *a.borrow_mut() = front.unwrap_or_default());
        b.panel.center();
        b.panel.makeKeyAndOrderFront(None);
        b.panel.makeFirstResponder(Some(&b.field));
    });
}

fn send() {
    with(|b| {
        let text = b.field.stringValue().to_string();
        if text.trim().is_empty() { return; }
        b.field.setStringValue(&NSString::from_str(""));
        b.answer.setStringValue(&NSString::from_str(&format!("“{text}”: sent, waiting for Hive…")));
        let app = APP.with(|a| a.borrow().clone());
        std::thread::spawn(move || {
            let said = ask(&text, &app);
            DispatchQueue::main().exec_async(move || with(|b| b.answer.setStringValue(&NSString::from_str(&said))));
        });
    });
}

/// What Hive's orchestrator says to `text`, and the tasks it went to.
fn ask(text: &str, app: &str) -> String {
    let Some(c) = crate::tailnet::load() else { return "This Mac isn't paired with a Hive.".into() };
    match hive_protocol::call(&c, "POST", "/api/requests?wait=1", Some(&json!({ "text": text, "node": crate::os::KIND, "context": { "app": app } })), 180) {
        Ok((200, r)) => {
            let tasks: Vec<String> = r["tasks"].as_array().into_iter().flatten()
                .map(|t| format!("#{} {} ({})", t["id"], t["title"].as_str().unwrap_or(""), t["status"].as_str().unwrap_or(""))).collect();
            format!("{}\n{}", r["reply"].as_str().unwrap_or(""), tasks.join("\n")).trim().to_string()
        }
        Ok((code, r)) => format!("Hive answered {code}: {r}"),
        Err(e) => format!("Couldn't reach Hive: {e}"),
    }
}

/// Asks the owner, in a floating window, to hand over the Mac's own pointer and keyboard to a task's agent: who, why, and for about
/// how long. True once they press Hand over; false for Not now, or no answer in ten minutes (the window then closes).
/// One ask at a time: a second alert would sit on the first, and the first's timeout would close the wrong one.
static ASKING: std::sync::Mutex<String> = std::sync::Mutex::new(String::new());

pub fn hand_over(who: &str, why: &str, minutes: u64) -> Result<(), String> {
    {
        let mut asking = ASKING.lock().unwrap();
        if !asking.is_empty() { return Err(format!("The owner is already being asked for the Mac by {asking}; ask again once that's answered.")); }
        *asking = who.to_string();
    }
    let (tx, rx) = std::sync::mpsc::channel();
    let text = format!("{why}\n\nIt needs your pointer and keyboard for about {minutes} minute{}. A window shows what it does as it goes; \
        close it to take your Mac back.", if minutes == 1 { "" } else { "s" });
    let who = who.to_string();
    DispatchQueue::main().exec_async(move || {
        let mtm = MainThreadMarker::new().expect("main thread");
        let alert = NSAlert::new(mtm);
        alert.setMessageText(&NSString::from_str(&format!("{who} is asking for your Mac")));
        alert.setInformativeText(&NSString::from_str(&text));
        alert.addButtonWithTitle(&NSString::from_str("Hand over"));
        alert.addButtonWithTitle(&NSString::from_str("Not now"));
        alert.window().setLevel(NSFloatingWindowLevel);
        NSApplication::sharedApplication(mtm).activate();
        tx.send(alert.runModal() == NSAlertFirstButtonReturn).ok();
    });
    let handed = rx.recv_timeout(Duration::from_secs(600)).unwrap_or_else(|_| {
        DispatchQueue::main().exec_async(|| NSApplication::sharedApplication(MainThreadMarker::new().expect("main thread")).abortModal());
        false
    });
    ASKING.lock().unwrap().clear();
    if handed { Ok(()) } else {
        Err("The owner didn't hand the Mac over (they said not now, or didn't answer in ten minutes). Find another way, or end saying exactly what you need the Mac for.".into())
    }
}

thread_local! { static FOLLOW: RefCell<Option<(Retained<NSPanel>, Retained<NSTextView>, String)>> = const { RefCell::new(None) }; }

/// While a task's agent has the Mac: a floating window in the screen's corner with the task's log as it happens, until `until`.
/// Closing it gives the Mac back.
pub fn follow(task: i64, title: &str, until: Instant) {
    let title = format!("#{task} {title} has your Mac: close this to take it back");
    DispatchQueue::main().exec_async(move || {
        let mtm = MainThreadMarker::new().expect("main thread");
        let style = NSWindowStyleMask::Titled | NSWindowStyleMask::Closable | NSWindowStyleMask::Resizable | NSWindowStyleMask::NonactivatingPanel;
        let panel = NSPanel::initWithContentRect_styleMask_backing_defer(NSPanel::alloc(mtm), rect(0.0, 0.0, 480.0, 340.0), style, NSBackingStoreType::Buffered, false);
        panel.setTitle(&NSString::from_str(&title));
        panel.setLevel(NSFloatingWindowLevel);
        panel.setHidesOnDeactivate(false);
        unsafe { panel.setReleasedWhenClosed(false) };
        let scroll = NSTextView::scrollableTextView(mtm);
        let view = panel.contentView().expect("a panel has a content view");
        scroll.setFrame(view.bounds());
        scroll.setAutoresizingMask(NSAutoresizingMaskOptions::ViewWidthSizable | NSAutoresizingMaskOptions::ViewHeightSizable);
        let text = scroll.documentView().and_then(|v| v.downcast::<NSTextView>().ok()).expect("a scrollable text view");
        text.setEditable(false);
        text.setFont(Some(&NSFont::systemFontOfSize(12.0)));
        view.addSubview(&scroll);
        if let Some(screen) = NSScreen::mainScreen(mtm) {
            let f = screen.visibleFrame();
            panel.setFrameOrigin(NSPoint::new(f.origin.x + f.size.width - 496.0, f.origin.y + f.size.height - 356.0));
        }
        panel.orderFrontRegardless();
        FOLLOW.with(|f| *f.borrow_mut() = Some((panel, text, String::new())));
    });
    std::thread::spawn(move || {
        let c = crate::tailnet::load();
        let mut after = 0;
        loop {
            let mut lines = String::new();
            if let Some(Ok((200, r))) = c.as_ref().map(|c| hive_protocol::call(c, "GET", &format!("/api/tasks/{task}?after={after}"), None, 20)) {
                let log = r["log"].as_array().cloned().unwrap_or_default();
                // The first look starts with its last 40 entries.
                for e in log.iter().skip(if after == 0 { log.len().saturating_sub(40) } else { 0 }) {
                    let text: String = e["text"].as_str().unwrap_or("").chars().take(400).collect();
                    lines += &format!("{}: {}\n", e["who"].as_str().unwrap_or(""), text.trim());
                }
                after = log.last().and_then(|e| e["id"].as_i64()).unwrap_or(after);
            }
            let (tx, rx) = std::sync::mpsc::channel();
            DispatchQueue::main().exec_async(move || FOLLOW.with(|f| {
                let mut f = f.borrow_mut();
                let on = f.as_mut().is_some_and(|(panel, text, all)| {
                    if !panel.isVisible() || Instant::now() > until { panel.close(); return false; }
                    if !lines.is_empty() {
                        all.push_str(&lines);
                        text.setString(&NSString::from_str(all));
                        unsafe { text.scrollToEndOfDocument(None) };
                    }
                    true
                });
                if !on { *f = None; }
                tx.send(on).ok();
            }));
            if !rx.recv().unwrap_or(false) { break; }
            std::thread::sleep(Duration::from_secs(1));
        }
        crate::os::give_back();
    });
}
