import UIKit
import WebKit

/// Hive's window, from the moment the app opens (Launcher/Main.m) and whenever it's in front: the paired Hive Server's
/// dashboard (Pairing.dashboard), which signs the owner's own devices in, and above it how the link stands, with
/// Tailscale's sign-in while the node needs it, and while phone control is off, a card on how to turn it on. The link and
/// the automation run on behind it.
@objc(HiveDashboard) public final class Dashboard: UIViewController, WKNavigationDelegate {
    private(set) static var window: UIWindow?
    /// Taps on Reload, which the probes count to see the window take touches.
    static var taps = 0

    /// Shows the window now, and puts it back in whichever scene the app has when one connects or comes to the front: an
    /// icon launch, or coming back from another app, may bring a new one.
    @objc public static func show() {
        attach()
        for n in [UIScene.willConnectNotification, UIScene.willEnterForegroundNotification, UIScene.didActivateNotification,
                  UIApplication.didBecomeActiveNotification] {
            NotificationCenter.default.addObserver(forName: n, object: nil, queue: .main) { _ in attach() }
        }
    }

    /// The app's window scene: the one in front, else any; nil if it has none.
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
    private let control = UILabel()
    private let signIn = UIButton(type: .system)
    private let reload = UIButton(type: .system)
    private let install = UIButton(type: .system)
    private let web = WKWebView(frame: .zero, configuration: WKWebViewConfiguration())
    private var shown: URL?
    private var page = "nothing yet"

    /// The status on its own lines across the top, the buttons on a row of their own under it (so neither squeezes the
    /// other), phone control's card, and the web view filling the rest.
    public override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        status.numberOfLines = 0
        status.font = .preferredFont(forTextStyle: .footnote)
        status.textColor = .secondaryLabel
        signIn.setTitle("Sign in with Tailscale", for: .normal)
        signIn.addAction(UIAction { _ in if let u = Tailnet.shared.loginURL { UIApplication.shared.open(u) } }, for: .touchUpInside)
        reload.setTitle("Reload", for: .normal)
        reload.addAction(UIAction { [weak self] _ in Dashboard.taps += 1; self?.shown = nil; self?.refresh() }, for: .touchUpInside)
        install.setTitle("Update Hive", for: .normal)
        install.addAction(UIAction { [weak self] _ in self?.updateHive() }, for: .touchUpInside)
        for b in [install, signIn, reload] {
            b.setContentHuggingPriority(.required, for: .horizontal)
            b.setContentCompressionResistancePriority(.required, for: .horizontal)
        }
        let buttons = UIStackView(arrangedSubviews: [install, signIn, reload, UIView()])
        buttons.spacing = 20
        control.numberOfLines = 0
        control.font = .preferredFont(forTextStyle: .callout)
        control.translatesAutoresizingMaskIntoConstraints = false
        let card = UIView()
        card.backgroundColor = .secondarySystemBackground
        card.layer.cornerRadius = 12
        card.addSubview(control)
        NSLayoutConstraint.activate([
            control.topAnchor.constraint(equalTo: card.topAnchor, constant: 12),
            control.bottomAnchor.constraint(equalTo: card.bottomAnchor, constant: -12),
            control.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 14),
            control.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -14),
        ])
        let bar = UIStackView(arrangedSubviews: [status, buttons, card])
        bar.axis = .vertical
        bar.spacing = 4
        bar.setCustomSpacing(8, after: buttons)
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
            web.bottomAnchor.constraint(equalTo: g.bottomAnchor),
        ])
        NotificationCenter.default.addObserver(forName: Tailnet.changed, object: nil, queue: .main) { [weak self] _ in self?.refresh() }
        refresh()
    }

    private func updateHive() {
        guard let url = Link.shared.update else { return }
        install.isEnabled = false
        install.setTitle("Opening installer…", for: .normal)
        UIApplication.shared.open(url, options: [:]) { [weak self] opened in
            guard let self else { return }
            self.install.isEnabled = true
            self.install.setTitle("Update Hive", for: .normal)
            let alert = UIAlertController(title: opened ? "Hive update" : "Couldn't open the installer",
                message: opened ? "Confirm Install in the iOS prompt. Hive updates on your Home Screen; reopen it when the download finishes." : "iOS couldn't open the Hive install link. Try Update Hive again.", preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "OK", style: .default))
            self.present(alert, animated: true)
        }
    }

    private func refresh() {
        status.text = Link.shared.summary
        signIn.isHidden = Tailnet.shared.loginURL == nil || Tailnet.shared.running
        install.isHidden = Link.shared.update == nil
        control.text = Link.shared.control
        control.superview?.isHidden = Link.shared.calls != nil || Link.shared.control.isEmpty
        guard let p = Link.shared.pairing, Tailnet.shared.running, shown != p.dashboard else { return }
        // WebKit's network process takes its proxy from the data store, so it's set before each new page.
        web.configuration.websiteDataStore.proxyConfigurations = Tailnet.shared.proxy.map { [$0] } ?? []
        shown = p.dashboard
        page = "loading \(p.host)"
        web.load(URLRequest(url: p.dashboard))
    }

    public func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { page = "loaded \(webView.url?.host ?? "the probe's page")" }
    public func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { failed(error) }
    public func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { failed(error) }
    private func failed(_ error: Error) { shown = nil; page = "failed: \(error.localizedDescription)" }
}
