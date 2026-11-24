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

    private static var dashboard: Dashboard? { (window?.rootViewController as? Dashboard).flatMap { $0.isViewLoaded ? $0 : nil } }

    /// Where Reload and the web view are on the screen, and how the page went, for the probes.
    static var reloadFrame: CGRect { dashboard.map { $0.reload.convert($0.reload.bounds, to: nil) } ?? .zero }
    static var webFrame: CGRect { dashboard.map { $0.web.convert($0.web.bounds, to: nil) } ?? .zero }
    static var page: String { dashboard?.page ?? "no window" }

    /// A page for the probes to load while there's no pairing (and so no dashboard): it shows the web view renders here.
    static func preview() {
        guard let d = dashboard, Link.shared.pairing == nil else { return }
        d.page = "loading the probe's page"
        d.web.loadHTMLString("<meta name=viewport content='width=device-width'><h1 style='font-family:system-ui'>Hive</h1>" +
                             "<p style='font-family:system-ui'>The probe's page, in Hive's web view.</p>", baseURL: nil)
    }

    private let status = UILabel()
    private let signIn = UIButton(type: .system)
    private let reload = UIButton(type: .system)
    private let web = WKWebView(frame: .zero, configuration: WKWebViewConfiguration())
    private var shown: URL?
    private var page = "nothing yet"

    /// The status on its own lines across the top, the buttons on a row of their own under it (so neither squeezes the
    /// other), and the web view filling the rest.
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
        for b in [signIn, reload] {
            b.setContentHuggingPriority(.required, for: .horizontal)
            b.setContentCompressionResistancePriority(.required, for: .horizontal)
        }
        let buttons = UIStackView(arrangedSubviews: [signIn, reload, UIView()])
        buttons.spacing = 20
        let bar = UIStackView(arrangedSubviews: [status, buttons])
        bar.axis = .vertical
        bar.spacing = 4
        web.navigationDelegate = self
        for v in [bar, web] { v.translatesAutoresizingMaskIntoConstraints = false; view.addSubview(v) }
        let g = view.safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            bar.topAnchor.constraint(equalTo: g.topAnchor, constant: 4),
            bar.leadingAnchor.constraint(equalTo: g.leadingAnchor, constant: 16),
            bar.trailingAnchor.constraint(equalTo: g.trailingAnchor, constant: -16),
            web.topAnchor.constraint(equalTo: bar.bottomAnchor, constant: 4),
            web.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            web.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            web.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])
        NotificationCenter.default.addObserver(forName: Tailnet.changed, object: nil, queue: .main) { [weak self] _ in self?.refresh() }
        refresh()
    }

    private func refresh() {
        status.text = Link.shared.summary
        signIn.isHidden = Tailnet.shared.loginURL == nil || Tailnet.shared.running
        guard let p = Link.shared.pairing, !p.tailnet || Tailnet.shared.running, shown != p.dashboard else { return }
        // WebKit's network process takes its proxy from the data store, so it's set before each new page.
        web.configuration.websiteDataStore.proxyConfigurations = p.tailnet ? Tailnet.shared.proxy.map { [$0] } ?? [] : []
        shown = p.dashboard
        page = "loading \(p.host)"
        web.load(URLRequest(url: p.dashboard))
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { page = "loaded \(webView.url?.host ?? "the probe's page")" }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { failed(error) }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { failed(error) }
    private func failed(_ error: Error) { shown = nil; page = "failed: \(error.localizedDescription)" }
}
