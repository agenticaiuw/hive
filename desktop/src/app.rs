//! The Hive app. Opening it connects this computer to Hive (Hive's agents can use it while the app runs) and shows the
//! dashboard. Control+Option+Space on a Mac, Ctrl+Alt+Space on Windows, brings it up from anywhere and hides it again.
use global_hotkey::hotkey::{Code, HotKey, Modifiers};
use global_hotkey::{GlobalHotKeyEvent, GlobalHotKeyManager, HotKeyState};
use hive_protocol::Conf;
use tao::event::{Event, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoopBuilder};
use tao::window::WindowBuilder;

enum Msg { Key, Connected(Conf), Failed(String) }

/// Asked for when nothing is paired yet: the link the dashboard's Pair a device copies.
const CONNECT: &str = r#"<!doctype html><meta charset="utf-8"><style>
:root { color-scheme: light dark } body { font: 15px/1.45 -apple-system, system-ui, sans-serif; display: grid; place-items: center; height: 100vh; margin: 0 }
main { width: 420px } input { box-sizing: border-box; width: 100%; padding: 8px; font: inherit; border-radius: 8px; border: 1px solid #8886 }
button { margin-top: 8px; padding: 7px 14px; font: inherit; border-radius: 8px; border: 0; background: #b45309; color: #fff }</style>
<main><h2>Connect this computer to Hive</h2><p>On your Hive dashboard, choose <b>Pair a device</b>, then paste the link here.</p>
<form onsubmit="event.preventDefault(); m.textContent = 'Connecting…'; ipc.postMessage(l.value)"><input id="l" placeholder="Pairing link" autofocus><button>Connect</button></form>
<p id="m"></p></main><script>function failed(e) { m.textContent = e }</script>"#;

fn dashboard(c: &Conf) -> String { format!("{}/#key={}", c.server, c.token) }

pub fn run(conf: Option<Conf>, connect: fn(&str) -> Result<Conf, String>, serve: fn(Conf)) {
    let event_loop = EventLoopBuilder::<Msg>::with_user_event().build();
    let window = WindowBuilder::new().with_title("Hive").with_inner_size(tao::dpi::LogicalSize::new(1100.0, 760.0))
        .build(&event_loop).expect("window");
    let proxy = event_loop.create_proxy();
    let builder = wry::WebViewBuilder::new().with_ipc_handler(move |req: wry::http::Request<String>| {
        let (link, proxy) = (req.body().clone(), proxy.clone());
        std::thread::spawn(move || { proxy.send_event(match connect(&link) { Ok(c) => Msg::Connected(c), Err(e) => Msg::Failed(e) }).ok(); });
    });
    let builder = match &conf { Some(c) => builder.with_url(dashboard(c)), None => builder.with_html(CONNECT) };
    let webview = builder.build(&window).expect("webview");
    if let Some(c) = conf { std::thread::spawn(move || serve(c)); }

    let hotkeys = GlobalHotKeyManager::new().ok();
    if let Some(m) = &hotkeys { m.register(HotKey::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::Space)).ok(); }
    let proxy = event_loop.create_proxy();
    GlobalHotKeyEvent::set_event_handler(Some(move |e: GlobalHotKeyEvent| if e.state == HotKeyState::Pressed { proxy.send_event(Msg::Key).ok(); }));
    #[cfg(target_os = "macos")]
    let menu = menu();

    event_loop.run(move |event, _target, flow| {
        *flow = ControlFlow::Wait;
        let _ = (&hotkeys, &webview);
        let show = || { window.set_visible(true); window.set_minimized(false); window.set_focus(); };
        match event {
            #[cfg(target_os = "macos")]
            Event::NewEvents(tao::event::StartCause::Init) => menu.init_for_nsapp(),
            Event::UserEvent(Msg::Key) => if window.is_visible() && window.is_focused() {
                #[cfg(target_os = "macos")]
                { use tao::platform::macos::EventLoopWindowTargetExtMacOS; _target.hide_application(); }
                #[cfg(not(target_os = "macos"))]
                window.set_minimized(true);
            } else { show() },
            Event::UserEvent(Msg::Connected(c)) => { webview.load_url(&dashboard(&c)).ok(); std::thread::spawn(move || serve(c)); }
            Event::UserEvent(Msg::Failed(e)) => { webview.evaluate_script(&format!("failed({})", serde_json::json!(e))).ok(); }
            // A Mac app keeps running with its window closed (the Dock icon brings it back); on Windows closing quits.
            Event::WindowEvent { event: WindowEvent::CloseRequested, .. } =>
                if cfg!(target_os = "macos") { window.set_visible(false) } else { *flow = ControlFlow::Exit },
            Event::Reopen { .. } => show(),
            _ => {}
        }
    })
}

/// Without a menu bar a Mac app can't copy, paste or quit from the keyboard.
#[cfg(target_os = "macos")]
fn menu() -> muda::Menu {
    use muda::{PredefinedMenuItem as P, Submenu};
    let m = muda::Menu::new();
    let app = Submenu::with_items("Hive", true, &[&P::hide(None), &P::hide_others(None), &P::separator(), &P::quit(None)]).expect("menu");
    let edit = Submenu::with_items("Edit", true, &[&P::undo(None), &P::redo(None), &P::separator(),
        &P::cut(None), &P::copy(None), &P::paste(None), &P::select_all(None)]).expect("menu");
    m.append_items(&[&app, &edit]).expect("menu");
    m
}
