import Foundation
import Network

/// Tailscale inside each iPhone app (tailscale/libtailscale, built by build.sh), for a Hive Server at home on the owner's
/// tailnet: the app finds it there (TailnetPairing) and reaches it through its node's local SOCKS5 proxy, so the iPhone
/// needs neither the Tailscale app nor a VPN. Each app is its own node (`hostname`), since apps can't share one; its keys
/// stay in the app's container, so the owner signs each in once, in Safari.
final class Tailnet {
    static let shared = Tailnet()
    /// Its name on the tailnet, set before start: hive-phone (Hive Phone) or hive-app (Hive).
    var hostname = "hive-phone"
    static let changed = Notification.Name("hive.changed")

    /// tailscale's backend state: NeedsLogin, Starting, Running, ...
    private(set) var state = ""
    private(set) var loginURL: URL?
    private(set) var proxy: ProxyConfiguration?
    /// The node's last status (ipnstate.Status, as LocalAPI's /localapi/v0/status serves it), with its peers.
    private(set) var status: [String: Any] = [:]
    private var sd: Int32 = -1
    private var polling = false

    var running: Bool { proxy != nil }

    func start() {
        guard sd < 0 else { return }
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("tailscale")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let s = tailscale_new()
        tailscale_set_dir(s, dir.path)
        tailscale_set_hostname(s, hostname)
        tailscale_set_logfd(s, -1)
        guard tailscale_start(s) == 0 else { update("Tailscale didn't start: \(Tailnet.error(s))", nil, nil); return }
        sd = s
        // Up returns once the node is signed in and running; until then the status carries the sign-in link.
        DispatchQueue.global().async { _ = tailscale_up(s) }
        Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in self?.poll() }
        poll()
    }

    private func poll() {
        guard sd >= 0, !polling else { return }
        polling = true
        let s = sd, needProxy = proxy == nil
        DispatchQueue.global().async {
            var out: UnsafeMutablePointer<CChar>?
            var st: [String: Any] = [:]
            if tailscale_status_json(s, &out) == 0, let out {
                st = (try? JSONSerialization.jsonObject(with: Data(bytes: out, count: strlen(out)))) as? [String: Any] ?? [:]
                free(out)
            }
            let state = st["BackendState"] as? String ?? ""
            let login = (st["AuthURL"] as? String).flatMap { $0.isEmpty ? nil : URL(string: $0) }
            let proxy = state == "Running" && needProxy ? Tailnet.loopback(s) : nil
            DispatchQueue.main.async {
                self.polling = false
                self.status = st
                self.update(state, state == "Running" ? nil : login, proxy)
            }
        }
    }

    private func update(_ state: String, _ login: URL?, _ proxy: ProxyConfiguration?) {
        let before = (self.state, loginURL, running)
        self.state = state
        loginURL = login
        if let proxy { self.proxy = proxy }
        if before != (self.state, loginURL, running) { NotificationCenter.default.post(name: Tailnet.changed, object: nil) }
    }

    /// The peers that may be the owner's Hive Server, as hosts to try: online, named hive-something (as Hive Server names
    /// its node), and not one of these iPhone apps' own nodes.
    static func hives(in status: [String: Any]) -> [String] {
        let peers = (status["Peer"] as? [String: Any] ?? [:]).values.compactMap { $0 as? [String: Any] }
        return peers.compactMap { p -> (String, String)? in
            let name = (p["HostName"] as? String ?? "").lowercased()
            guard p["Online"] as? Bool == true, name.hasPrefix("hive"), !name.hasPrefix("hive-app"), !name.hasPrefix("hive-phone") else { return nil }
            var host = p["DNSName"] as? String ?? ""
            if host.hasSuffix(".") { host.removeLast() }
            if host.isEmpty { host = (p["TailscaleIPs"] as? [String])?.first ?? "" }
            return host.isEmpty ? nil : (name, host)
        }.sorted { $0.0 < $1.0 }.map { $0.1 }
    }

    /// The node's SOCKS5 proxy onto the tailnet (user "tsnet", a random password), as URLSession and WebKit take it.
    private static func loopback(_ s: Int32) -> ProxyConfiguration? {
        var addr = [CChar](repeating: 0, count: 64), cred = [CChar](repeating: 0, count: 33), api = [CChar](repeating: 0, count: 33)
        guard tailscale_loopback(s, &addr, addr.count, &cred, &api) == 0 else { return nil }
        let a = String(cString: addr)
        guard let colon = a.lastIndex(of: ":"), let port = UInt16(a[a.index(after: colon)...]), let p = NWEndpoint.Port(rawValue: port) else { return nil }
        let proxy = ProxyConfiguration(socksv5Proxy: .hostPort(host: NWEndpoint.Host(String(a[..<colon])), port: p))
        proxy.applyCredential(username: "tsnet", password: String(cString: cred))
        return proxy
    }

    private static func error(_ s: Int32) -> String {
        var buf = [CChar](repeating: 0, count: 256)
        return tailscale_errmsg(s, &buf, buf.count) == 0 ? String(cString: buf) : "unknown error"
    }
}
