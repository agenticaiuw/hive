//! The fn key's type bar on a Mac: press fn and let go (by itself) and a small floating window takes a request; return sends
//! it to Hive's orchestrator and shows the answer; escape, its close button or fn again hides it. The window doesn't take
//! the front from the owner's app, and macOS shows Hive the fn key only once Hive has the Accessibility permission. Hive's
//! menu in the menu bar quits it (macOS won't replace a running app with a new download).
use block2::RcBlock;
use dispatch2::DispatchQueue;
use objc2::rc::Retained;
use objc2::{MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{NSApplication, NSApplicationActivationPolicy, NSBackingStoreType, NSEvent, NSEventMask, NSEventModifierFlags, NSEventType,
    NSFloatingWindowLevel, NSFont, NSMenu, NSMenuItem, NSPanel, NSStatusBar, NSTextField, NSVariableStatusItemLength, NSWindowStyleMask, NSWorkspace};
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
