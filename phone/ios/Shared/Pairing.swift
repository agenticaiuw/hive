import Foundation
import UIKit

/// The pairing both iPhone apps take from the dashboard's "Connect an iPhone": "hive-phone:" + base64url(JSON {url, token}),
/// the server's phone WebSocket and the phone's key. Each app keeps its own copy in Documents/phone-relay.json (they can't
/// share a folder unsigned), so the owner's one copy has to reach both.
struct Pairing: Equatable {
    static let prefix = "hive-phone:"
    static var saved: URL { URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Documents/phone-relay.json") }

    let url: URL
    let token: String
    var host: String { url.host ?? "" }
    var tailnet: Bool { host.lowercased().hasSuffix(".ts.net") }
    /// The dashboard of the same Hive: the WebSocket's https twin, without /phone/device, signed in by the phone's own
    /// key (the server gives it a dashboard token of its own).
    var dashboard: URL {
        var c = URLComponents(url: url, resolvingAgainstBaseURL: false)!
        c.scheme = "https"
        c.path = String(c.path.dropLast("phone/device".count))
        c.query = nil
        c.fragment = "key=" + token
        return c.url!
    }

    static func checked(_ json: Any?) -> Pairing? {
        guard let d = json as? [String: Any], let endpoint = d["url"] as? String, let token = d["token"] as? String,
              (40...512).contains(token.count), let url = URL(string: endpoint), url.scheme == "wss",
              !(url.host ?? "").isEmpty, url.path.hasSuffix("/device") else { return nil }
        return Pairing(url: url, token: token)
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
