import Foundation
import UIKit

/// The pairing both iPhone apps hold: the server's phone WebSocket and the phone's key. Each app gets it from the Hive
/// Server over Tailscale (TailnetPairing), or else from the dashboard's "Connect an iPhone", which copies "hive-phone:" +
/// base64url(JSON {url, token}). Each app keeps its own copy in Documents/phone-relay.json (they can't share a folder
/// unsigned), so each finds it, or the one copied pairing has to reach both.
struct Pairing: Equatable {
    static let prefix = "hive-phone:"
    static var saved: URL { URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Documents/phone-relay.json") }

    let url: URL
    let token: String
    var host: String { url.host ?? "" }
    /// On the owner's tailnet: its MagicDNS name, or its tailnet address (100.64.0.0/10) when MagicDNS is off.
    var tailnet: Bool {
        let h = host.lowercased(), p = h.split(separator: ".").compactMap { Int($0) }
        return h.hasSuffix(".ts.net") || (p.count == 4 && p[0] == 100 && (64..<128).contains(p[1]))
    }
    /// The dashboard of the same Hive: the WebSocket's web twin (wss is https; ws, inside a tailnet, is http), without
    /// /phone/device, signed in by the phone's own key (the server gives it a dashboard token of its own).
    var dashboard: URL {
        var c = URLComponents(url: url, resolvingAgainstBaseURL: false)!
        c.scheme = url.scheme == "ws" ? "http" : "https"
        c.path = String(c.path.dropLast("phone/device".count))
        c.query = nil
        c.fragment = "key=" + token
        return c.url!
    }

    static func checked(_ json: Any?) -> Pairing? {
        guard let d = json as? [String: Any], let endpoint = d["url"] as? String, let token = d["token"] as? String,
              (40...512).contains(token.count), let url = URL(string: endpoint), url.scheme == "wss" || url.scheme == "ws",
              !(url.host ?? "").isEmpty, url.path.hasSuffix("/device") else { return nil }
        let p = Pairing(url: url, token: token)
        // Plain ws only inside the owner's tailnet, which WireGuard encrypts; anywhere else it must be wss.
        return url.scheme == "wss" || p.tailnet ? p : nil
    }

    static func from(_ text: String) -> Pairing? {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard text.hasPrefix(prefix), text.count <= 4096 else { return nil }
        var b64 = String(text.dropFirst(prefix.count)).replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while b64.count % 4 != 0 { b64 += "=" }
        guard let data = Data(base64Encoded: b64) else { return nil }
        return checked(try? JSONSerialization.jsonObject(with: data))
    }

    static func load() -> Pairing? {
        (try? Data(contentsOf: saved)).flatMap { checked(try? JSONSerialization.jsonObject(with: $0)) }
    }

    func save() {
        let json = try? JSONSerialization.data(withJSONObject: ["url": url.absoluteString, "token": token])
        try? json?.write(to: Pairing.saved, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
}

/// Pairing with no link, for the owner's own devices: once this app's node is signed in to Tailscale, it finds the Hive
/// Server among its peers (Tailnet.hives, then GET /health) and asks it for the phone's pairing. The server gives it only
/// to a device on the same Tailscale account as itself; a Hive Server on a cloud VM isn't on Tailscale, and the
/// clipboard is the way there.
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
            await MainActor.run {
                self.busy = false
                if let pairing { pairing.save(); found(pairing) }
            }
        }
    }
}

/// Watches the clipboard for a pairing (the change count, which asks nothing) and reads each new copy once. A pairing it
/// takes goes back on the clipboard for two minutes, this iPhone only, so the other app can take it too, and is gone after.
final class PairingWatch {
    private var seen = -1, looking = false

    /// Looks again even if the clipboard hasn't changed (a pairing the server turned down).
    func reset() { seen = -1 }

    func look(_ found: @escaping (Pairing) -> Void) {
        let board = UIPasteboard.general
        guard !looking, board.changeCount != seen else { return }
        seen = board.changeCount
        guard board.hasStrings else { return }
        looking = true
        // Reading may show iOS's paste prompt, which blocks the reader until it's answered.
        DispatchQueue.global(qos: .userInitiated).async {
            let text = UIPasteboard.general.string ?? ""
            let pairing = Pairing.from(text)
            if let pairing {
                pairing.save()
                UIPasteboard.general.setItems([["public.utf8-plain-text": text]],
                    options: [.localOnly: true, .expirationDate: Date().addingTimeInterval(120)])
            }
            DispatchQueue.main.async {
                self.looking = false
                self.seen = UIPasteboard.general.changeCount
                if let pairing { found(pairing) }
            }
        }
    }
}
