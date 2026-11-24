import UIKit
import WebKit

/// Hive's window, shown by the test that is Hive (HivePhone.swift) in its own runner app whenever that app is in front:
/// the paired Hive Server's dashboard, signed in with the phone's own key (Pairing.dashboard), and above it how the link
/// stands, with Tailscale's sign-in while the node needs it. The link and the automation run on behind it.
final class Dashboard: UIViewController, WKNavigationDelegate {
    private(set) static var window: UIWindow?
    /// Taps on Reload, which the probes count to see the window take touches.
    static var taps = 0

    /// Shows the window now, and puts it back in whichever scene the runner app has when one connects or comes to the
    /// front: an icon launch, or coming back from another app, may bring a new one.
    static func show() {
        attach()
        for n in [UIScene.willConnectNotification, UIScene.willEnterForegroundNotification, UIScene.didActivateNotification,
                  UIApplication.didBecomeActiveNotification] {
            NotificationCenter.default.addObserver(forName: n, object: nil, queue: .main) { _ in attach() }
        }
    }

    /// The runner's window scene: the one in front, else any; nil if it has none.
    static var scene: UIWindowScene? {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        return scenes.first { $0.activationState == .foregroundActive } ?? scenes.first { $0.activationState == .foregroundInactive } ?? scenes.first
    }

    private static func attach() {
        let s = scene
        let w = window ?? {
            let w = s.map { UIWindow(windowScene: $0) } ?? UIWindow(frame: UIScreen.main.bounds)
            w.rootViewController = Dashboard()
            // Above whatever window XCTest's runner app keeps.
            w.windowLevel = .normal + 1
            return w
        }()
        if let s, w.windowScene !== s { w.windowScene = s }
        w.isHidden = false
        w.makeKeyAndVisible()
        window = w
    }

    static var reloadFrame: CGRect {
        guard let d = window?.rootViewController as? Dashboard, d.isViewLoaded else { return .zero }
        return d.reload.convert(d.reload.bounds, to: nil)
    }

    private let status = UILabel()
    private let signIn = UIButton(type: .system)
    private let reload = UIButton(type: .system)
    private var web: WKWebView?
    private var shown: URL?

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        status.numberOfLines = 0
        status.font = .preferredFont(forTextStyle: .footnote)
        status.textColor = .secondaryLabel
        signIn.setTitle("Sign in with Tailscale", for: .normal)
        signIn.addAction(UIAction { _ in if let u = Tailnet.shared.loginURL { UIApplication.shared.open(u) } }, for: .touchUpInside)
        reload.setTitle("Reload", for: .normal)
        reload.addAction(UIAction { [weak self] _ in Dashboard.taps += 1; self?.shown = nil; self?.refresh() }, for: .touchUpInside)
        for b in [signIn, reload] { b.setContentHuggingPriority(.required, for: .horizontal) }
        let bar = UIStackView(arrangedSubviews: [status, signIn, reload])
        bar.spacing = 12
        bar.alignment = .center
        bar.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(bar)
        let g = view.safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            bar.topAnchor.constraint(equalTo: g.topAnchor, constant: 4),
            bar.leadingAnchor.constraint(equalTo: g.leadingAnchor, constant: 16),
            bar.trailingAnchor.constraint(equalTo: g.trailingAnchor, constant: -16),
        ])
        NotificationCenter.default.addObserver(forName: Tailnet.changed, object: nil, queue: .main) { [weak self] _ in self?.refresh() }
        refresh()
    }

    private func refresh() {
        status.text = Link.shared.summary
        signIn.isHidden = Tailnet.shared.loginURL == nil || Tailnet.shared.running
        guard let p = Link.shared.pairing, !p.tailnet || Tailnet.shared.running else { return }
        // WebKit's network process takes its proxy from the data store, so it's set before each new page.
        let store = WKWebsiteDataStore.default()
        if shown != p.dashboard { store.proxyConfigurations = p.tailnet ? Tailnet.shared.proxy.map { [$0] } ?? [] : [] }
        if web == nil {
            let cfg = WKWebViewConfiguration()
            cfg.websiteDataStore = store
            let w = WKWebView(frame: .zero, configuration: cfg)
            w.navigationDelegate = self
            w.translatesAutoresizingMaskIntoConstraints = false
            view.addSubview(w)
            NSLayoutConstraint.activate([
                w.topAnchor.constraint(equalTo: status.superview!.bottomAnchor, constant: 4),
                w.leadingAnchor.constraint(equalTo: view.leadingAnchor),
                w.trailingAnchor.constraint(equalTo: view.trailingAnchor),
                w.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            ])
            web = w
        }
        if shown != p.dashboard {
            shown = p.dashboard
            web?.load(URLRequest(url: p.dashboard))
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { shown = nil }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { shown = nil }
}
