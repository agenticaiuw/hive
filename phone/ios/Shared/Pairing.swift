import Foundation

/// The pairing Hive holds, in Documents/phone-relay.json: the server's phone WebSocket and the phone's key. Hive gets it
/// from the Hive Server over Tailscale (TailnetPairing).
struct Pairing: Equatable {
    static var saved: URL { URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Documents/phone-relay.json") }

    let url: URL
    let token: String
    var host: String { url.host ?? "" }
    /// On the owner's tailnet: its MagicDNS name, or its tailnet address (100.64.0.0/10) when MagicDNS is off.
    var tailnet: Bool {
        let h = host.lowercased(), p = h.split(separator: ".").compactMap { Int($0) }
        return h.hasSuffix(".ts.net") || (p.count == 4 && p[0] == 100 && (64..<128).contains(p[1]))
    }
    /// The dashboard of the same Hive: the WebSocket's web twin (http), without /phone/device. The server signs the
    /// owner's own devices in by themselves.
    var dashboard: URL {
        var c = URLComponents(url: url, resolvingAgainstBaseURL: false)!
        c.scheme = "http"
        c.path = String(c.path.dropLast("phone/device".count))
        c.query = nil
        return c.url!
    }

    static func checked(_ json: Any?) -> Pairing? {
        guard let d = json as? [String: Any], let endpoint = d["url"] as? String, let token = d["token"] as? String,
              (40...512).contains(token.count), let url = URL(string: endpoint), url.scheme == "ws",
              !(url.host ?? "").isEmpty, url.path.hasSuffix("/device") else { return nil }
        let p = Pairing(url: url, token: token)
        // Plain ws, only inside the owner's tailnet, which WireGuard encrypts.
        return p.tailnet ? p : nil
    }

    static func load() -> Pairing? {
        (try? Data(contentsOf: saved)).flatMap { checked(try? JSONSerialization.jsonObject(with: $0)) }
    }

    func save() {
        let json = try? JSONSerialization.data(withJSONObject: ["url": url.absoluteString, "token": token])
        try? json?.write(to: Pairing.saved, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
}

/// Pairing for the owner's own devices: once this app's node is signed in to Tailscale, it finds the Hive Server among its
/// peers (Tailnet.hives, then GET /health) and asks it for the phone's pairing. The server gives it only to a device on the
/// same Tailscale account as itself.
final class TailnetPairing {
    private var busy = false, last = Date.distantPast

    /// Tries every 10 seconds while it's asked to, once the node runs.
    func look(_ found: @escaping (Pairing) -> Void) {
        guard !busy, Tailnet.shared.running, let proxy = Tailnet.shared.proxy, last.timeIntervalSinceNow < -10 else { return }
        let hosts = Tailnet.hives(in: Tailnet.shared.status)
        guard !hosts.isEmpty else { return }
        busy = true
        last = Date()
        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest = 8
        cfg.proxyConfigurations = [proxy]
        let session = URLSession(configuration: cfg)
        Task {
            var pairing: Pairing?
            for host in hosts where pairing == nil {
                guard let base = URL(string: "http://\(host)"),
                      let (h, _) = try? await session.data(from: base.appendingPathComponent("health")),
                      (try? JSONSerialization.jsonObject(with: h) as? [String: Any])?["ok"] as? Bool == true else { continue }
                var r = URLRequest(url: base.appendingPathComponent("api/phone/tailnet"))
                r.httpMethod = "POST"
                guard let (b, res) = try? await session.data(for: r), (res as? HTTPURLResponse)?.statusCode == 200 else { continue }
                pairing = Pairing.checked(try? JSONSerialization.jsonObject(with: b))
            }
            session.invalidateAndCancel()
            let result = pairing
            await MainActor.run {
                self.busy = false
                if let result { result.save(); found(result) }
            }
        }
    }
}
