//! The Hive app: this computer as one of a Hive's devices (Hive's agents can use it while the app runs), showing the
//! dashboard. The Hive itself, the server, is its own download. It never comes up over the owner's screen by itself: once
//! set up it starts hidden, and the Dock icon (taskbar on Windows) or Control+Option+H (Ctrl+Alt+H) shows and hides it.
//! Not Control+Option+Space: that switches the Mac's input language.
use global_hotkey::hotkey::{Code, HotKey, Modifiers};
use global_hotkey::{GlobalHotKeyEvent, GlobalHotKeyManager, HotKeyState};
use tao::event::{Event, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoopBuilder};
use tao::window::WindowBuilder;

enum Msg { Key, Show(String), Say(String) }

pub enum Start { Dashboard(String), Setup }

/// Joins the Hive the setup page's pairing link is from, on its own thread; returns the dashboard's address.
pub type Act = fn(&str) -> Result<String, String>;

const SETUP: &str = r#"<!doctype html><meta charset="utf-8"><style>
:root { color-scheme: light dark } body { font: 15px/1.45 -apple-system, system-ui, sans-serif; display: grid; place-items: center; height: 100vh; margin: 0 }
main { width: 440px } input { box-sizing: border-box; width: 100%; padding: 8px; font: inherit; border-radius: 8px; border: 1px solid #8886 }
button { margin-top: 8px; padding: 8px 16px; font: inherit; border-radius: 8px; border: 0; background: #b45309; color: #fff }
.muted { opacity: .65 }</style>
<main><h2>Set up Hive</h2><p>Hive's agents use your computers, phone and browser for you, with your ChatGPT account.</p>
<p>On your Hive's dashboard choose <b>Pair a device</b>, then paste the link here.</p>
<form onsubmit="event.preventDefault(); go(l.value)"><input id="l" placeholder="Pairing link"><button>Connect</button></form>
<p class="muted">No Hive yet? It's its own download, for a computer that stays on:
<a href="https://github.com/agenticaiuw/hive/releases/tag/latest">Releases</a>.</p><p id="m"></p></main><script>function go(x) { m.textContent = '…'; ipc.postMessage(x) } function say(t) { m.textContent = t }</script>"#;

pub fn run(start: Start, act: Act) {
    let event_loop = EventLoopBuilder::<Msg>::with_user_event().build();
    let quiet = !matches!(start, Start::Setup);
    let window = WindowBuilder::new().with_title("Hive").with_inner_size(tao::dpi::LogicalSize::new(1100.0, 760.0))
        .with_visible(!quiet || cfg!(windows)).with_focused(!quiet).build(&event_loop).expect("window");
    if quiet && cfg!(windows) { window.set_minimized(true) }
    let proxy = event_loop.create_proxy();
    let work = move |what: String| {
        let proxy = proxy.clone();
        std::thread::spawn(move || {
            proxy.send_event(match act(&what) { Ok(url) => Msg::Show(url), Err(e) => Msg::Say(e) }).ok();
        });
    };
    let builder = wry::WebViewBuilder::new().with_ipc_handler({ let work = work.clone(); move |req: wry::http::Request<String>| work(req.body().clone()) });
    let builder = match &start { Start::Dashboard(url) => builder.with_url(url), _ => builder.with_html(SETUP) };
    let webview = builder.build(&window).expect("webview");

    let hotkeys = GlobalHotKeyManager::new().ok();
    if let Some(m) = &hotkeys { m.register(HotKey::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyH)).ok(); }
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
            Event::UserEvent(Msg::Show(url)) => { webview.load_url(&url).ok(); }
            Event::UserEvent(Msg::Say(t)) => { webview.evaluate_script(&format!("say({})", serde_json::json!(t))).ok(); }
            // A Mac app keeps running with its window closed (the Dock icon brings it back). On Windows closing quits.
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
