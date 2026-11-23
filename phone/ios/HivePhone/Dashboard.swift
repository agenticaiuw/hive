import UIKit
import WebKit

/// Hive Phone's own window, shown by the test that runs Hive Phone (HivePhone.swift) in the runner app: the paired Hive's
/// dashboard, and above it how the link stands, with Tailscale's sign-in when the node needs it. The dashboard signs in
/// with the phone's own key (Link.Pairing.dashboard), and keeps its cookie.
final class Dashboard: UIViewController {
    private static var window: UIWindow?
    /// Taps on Reload, which the smoke test counts to see this window take touches while the runner drives the screen.
    static var taps = 0

    static func show() {
        let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        let w = scene.map { UIWindow(windowScene: $0) } ?? UIWindow(frame: UIScreen.main.bounds)
        w.rootViewController = Dashboard()
        w.windowLevel = .normal + 1
        w.makeKeyAndVisible()
        window = w
    }

    static var reloadFrame: CGRect {
        guard let d = window?.rootViewController as? Dashboard else { return .zero }
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
        signIn.setTitle("Sign in to Tailscale", for: .normal)
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
}
