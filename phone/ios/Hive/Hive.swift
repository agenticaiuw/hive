import UIKit
import WebKit

/// Hive, the iPhone app the owner uses: the paired Hive's dashboard, signed in with the phone's own key
/// (Pairing.dashboard, the server gives it a dashboard token of its own). Above it, how it stands, with Tailscale's
/// sign-in when its node (hive-app) needs it. Hive Phone, the runner, does the phone's automation on its own.
@main
final class App: UIResponder, UIApplicationDelegate, UIWindowSceneDelegate {
    var window: UIWindow?

    func application(_ application: UIApplication, configurationForConnecting session: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let c = UISceneConfiguration(name: nil, sessionRole: session.role)
        c.delegateClass = App.self
        return c
    }

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options: UIScene.ConnectionOptions) {
        guard let scene = scene as? UIWindowScene else { return }
        Tailnet.shared.hostname = "hive-app"
        let w = UIWindow(windowScene: scene)
        w.rootViewController = Dashboard()
        w.makeKeyAndVisible()
        window = w
    }
}

final class Dashboard: UIViewController, WKNavigationDelegate {
    private let status = UILabel()
    private let signIn = UIButton(type: .system)
    private let reload = UIButton(type: .system)
    private var web: WKWebView?
    private var shown: URL?
    private var pairing = Pairing.load()
    private var failed = false
    private let watch = PairingWatch()

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        status.numberOfLines = 0
        status.font = .preferredFont(forTextStyle: .footnote)
        status.textColor = .secondaryLabel
        signIn.setTitle("Sign in to Tailscale", for: .normal)
        signIn.addAction(UIAction { _ in if let u = Tailnet.shared.loginURL { UIApplication.shared.open(u) } }, for: .touchUpInside)
        reload.setTitle("Reload", for: .normal)
        reload.addAction(UIAction { [weak self] _ in self?.shown = nil; self?.refresh() }, for: .touchUpInside)
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
        // Unpaired, or its Hive didn't answer: look at the clipboard whenever it changes (timers stop in the background).
        Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
            guard let self, self.pairing == nil || self.failed else { return }
            self.watch.look { found in
                self.pairing = found
                self.failed = false
                self.shown = nil
                self.refresh()
            }
        }
        refresh()
    }

    private func refresh() {
        status.text = summary
        signIn.isHidden = Tailnet.shared.loginURL == nil || Tailnet.shared.running
        guard let p = pairing else { return }
        if p.tailnet && !Tailnet.shared.running { Tailnet.shared.start(); return }
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

    private var summary: String {
        guard let p = pairing else {
            return "Not paired yet. On your Hive Server's dashboard, Nodes → Connect an iPhone copies a pairing; Hive and Hive Phone each pick it up from the clipboard."
        }
        let t = Tailnet.shared
        if p.tailnet && !t.running {
            return t.loginURL != nil ? "Your Hive Server is on your tailnet: sign Hive in to Tailscale to reach it." :
                t.state.hasPrefix("Tailscale didn't") ? t.state : "Starting Tailscale…"
        }
        return failed ? "\(p.host) didn't answer. Reload, or copy a new pairing from the dashboard." : p.host
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { failed = false; status.text = summary }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { loadFailed() }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { loadFailed() }
    private func loadFailed() { failed = true; shown = nil; status.text = summary }
}
