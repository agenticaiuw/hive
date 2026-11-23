import Foundation
import UIKit

/// Hive Phone's link to its Hive (the server's side is phone/src/link.rs). It dials out to the server over one WebSocket,
/// takes its phone calls ({id, method, path, body}) and answers each ({id, status, body}) with Runner, in this process;
/// nothing can reach in. A Hive on a tailnet (*.ts.net) is dialled through Tailscale inside the app (Tailnet.swift).
///
/// Pairing: the dashboard's "Connect an iPhone" copies "hive-phone:" + base64url(JSON {url, token}). While Hive Phone
/// isn't connected (unpaired, refused, or its Hive is gone or moved) it watches the clipboard (the change count, which
/// asks nothing) and reads a new copy once; a valid pairing is kept in Documents/phone-relay.json and the clipboard is
/// cleared. A connected phone never reads it.
final class Link: NSObject, URLSessionWebSocketDelegate {
    static let shared = Link()
    static let prefix = "hive-phone:"
    static let protocolVersion = 1

    struct Pairing: Equatable {
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
    }

    private(set) var pairing: Pairing?
    private(set) var connected = false
    private(set) var refused = false
    private var session: URLSession?
    private var socket: URLSessionWebSocketTask?
    private var failing = false, looking = false, seenClipboard = -1, retry = 0

    static var saved: URL { URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Documents/phone-relay.json") }

    static func checked(_ json: Any?) -> Pairing? {
        guard let d = json as? [String: Any], let endpoint = d["url"] as? String, let token = d["token"] as? String,
              (40...512).contains(token.count), let url = URL(string: endpoint), url.scheme == "wss",
              !(url.host ?? "").isEmpty, url.path.hasSuffix("/device") else { return nil }
        return Pairing(url: url, token: token)
    }

    static func pairing(from text: String) -> Pairing? {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard text.hasPrefix(prefix), text.count <= 4096 else { return nil }
        var b64 = String(text.dropFirst(prefix.count)).replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while b64.count % 4 != 0 { b64 += "=" }
        guard let data = Data(base64Encoded: b64) else { return nil }
        return checked(try? JSONSerialization.jsonObject(with: data))
    }

    static var version: String {
        let v = Bundle.main.object(forInfoDictionaryKey: "HiveVersion") ?? Bundle(for: Link.self).object(forInfoDictionaryKey: "HiveVersion")
        return (v as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "dev"
    }

    func start() {
        if let data = try? Data(contentsOf: Link.saved) { pairing = Link.checked(try? JSONSerialization.jsonObject(with: data)) }
        NotificationCenter.default.addObserver(forName: Tailnet.changed, object: nil, queue: .main) { [weak self] _ in
            // Once Tailscale is up, the first dial; after a failure the backoff in reconnect dials again.
            if let self, self.socket == nil, !self.failing, self.pairing?.tailnet == true, Tailnet.shared.running { self.connect() }
        }
        connect()
        // Unpaired or refused: look at the clipboard whenever it changes.
        Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in self?.lookForPairing() }
        Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { [weak self] _ in
            guard let ws = self?.socket else { return }
            ws.sendPing { err in
                DispatchQueue.main.async {
                    guard let self else { return }
                    if err != nil { self.reconnect(ws) } else { self.retry = 0; self.failing = false }
                }
            }
        }
    }

    private func changed() { NotificationCenter.default.post(name: Tailnet.changed, object: nil) }

    private func lookForPairing() {
        guard !looking, pairing == nil || failing else { return }
        let board = UIPasteboard.general
        guard board.changeCount != seenClipboard else { return }
        seenClipboard = board.changeCount
        guard board.hasStrings else { return }
        looking = true
        // Reading may show iOS's paste prompt, which blocks the reader until it's answered.
        DispatchQueue.global(qos: .userInitiated).async {
            let found = UIPasteboard.general.string.flatMap(Link.pairing(from:))
            if let found {
                let json = try? JSONSerialization.data(withJSONObject: ["url": found.url.absoluteString, "token": found.token])
                try? json?.write(to: Link.saved, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
                UIPasteboard.general.items = []
            }
            DispatchQueue.main.async {
                self.looking = false
                guard let found else { return }
                self.pairing = found
                self.refused = false
                self.failing = false
                self.retry = 0
                let old = self.socket
                self.socket = nil
                self.connected = false
                old?.cancel(with: .goingAway, reason: nil)
                self.session?.invalidateAndCancel()
                self.session = nil
                self.changed()
                self.connect()
            }
        }
    }

    private func connect() {
        guard socket == nil, let p = pairing else { return }
        if p.tailnet && !Tailnet.shared.running { Tailnet.shared.start(); return }
        if session == nil {
            let cfg = URLSessionConfiguration.ephemeral
            cfg.timeoutIntervalForRequest = 25
            cfg.timeoutIntervalForResource = 30
            if p.tailnet, let proxy = Tailnet.shared.proxy { cfg.proxyConfigurations = [proxy] }
            session = URLSession(configuration: cfg, delegate: self, delegateQueue: .main)
        }
        var r = URLRequest(url: p.url)
        r.setValue("Bearer \(p.token)", forHTTPHeaderField: "Authorization")
        r.setValue("phone:iphone", forHTTPHeaderField: "X-Hive-Node")
        r.setValue(Link.version, forHTTPHeaderField: "X-Hive-Version")
        r.setValue("\(Link.protocolVersion)", forHTTPHeaderField: "X-Hive-Protocol")
        let ws = session!.webSocketTask(with: r)
        ws.maximumMessageSize = 2 << 20
        socket = ws
        ws.resume()
        receive(ws)
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        guard webSocketTask == socket else { return }
        connected = true
        refused = false
        changed()
    }

    private func reconnect(_ ws: URLSessionWebSocketTask) {
        guard ws == socket else { return }
        socket = nil
        failing = true
        connected = false
        let status = (ws.response as? HTTPURLResponse)?.statusCode ?? 0
        // The server turned this pairing down: take a new one from the clipboard when it comes.
        if status == 401 || status == 403 { refused = true; seenClipboard = -1 }
        ws.cancel(with: .goingAway, reason: nil)
        changed()
        let delay = refused ? 60 : min(30, 1 << min(retry, 5))
        retry += 1
        DispatchQueue.main.asyncAfter(deadline: .now() + .seconds(delay)) { if self.socket == nil { self.connect() } }
    }

    private func receive(_ ws: URLSessionWebSocketTask) {
        ws.receive { [weak self] result in
            DispatchQueue.main.async {
                guard let self, ws == self.socket else { return }
                switch result {
                case .failure: self.reconnect(ws)
                case .success(let message):
                    self.refused = false
                    self.failing = false
                    let data: Data?
                    switch message {
                    case .string(let s): data = s.data(using: .utf8)
                    case .data(let d): data = d
                    @unknown default: data = nil
                    }
                    if let data, let command = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] { self.forward(command, ws) }
                    self.receive(ws)
                }
            }
        }
    }

    private static let routes = try! NSRegularExpression(pattern: "^/(status|screenshot|session|wda)(/|\\?|$)")

    private func forward(_ command: [String: Any], _ ws: URLSessionWebSocketTask) {
        guard let path = command["path"] as? String, let method = command["method"] as? String, let id = command["id"] as? String,
              let body = command["body"] as? String,
              Link.routes.firstMatch(in: path, range: NSRange(path.startIndex..., in: path)) != nil,
              !path.contains(".."), !path.contains("%"), !path.contains("\\"), ["GET", "POST", "DELETE"].contains(method) else { return }
        Runner.shared.handle(method, path, body) { [weak self] status, text in
            var (status, text) = (status, text)
            if text.utf8.count > 12 << 20 { (status, text) = (502, "{\"error\":\"response too large\"}") }
            guard let json = try? JSONSerialization.data(withJSONObject: ["id": id, "status": status, "body": text]),
                  let str = String(data: json, encoding: .utf8) else { return }
            ws.send(.string(str)) { err in
                if err != nil { DispatchQueue.main.async { self?.reconnect(ws) } }
            }
        }
    }

    /// How the link stands, in the owner's words, for the dashboard window.
    var summary: String {
        guard let p = pairing else {
            return "Not paired yet. On your Hive's dashboard, Nodes → Connect an iPhone copies a pairing; Hive Phone picks it up from the clipboard."
        }
        if p.tailnet && !Tailnet.shared.running {
            let t = Tailnet.shared
            return t.loginURL != nil ? "Your Hive is on your tailnet: sign this iPhone in to Tailscale to reach it." :
                t.state.hasPrefix("Tailscale didn't") ? t.state : "Starting Tailscale…"
        }
        if refused { return "\(p.host) turned this pairing down: connect the iPhone again from the dashboard." }
        return connected ? "Connected to \(p.host)." : "Connecting to \(p.host)…"
    }
}
