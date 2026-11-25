import Foundation

/// Hive Phone's link to its Hive (the server's side is phone/src/link.rs), from the moment the app opens (Launcher/Main.m).
/// It dials out to the server over one WebSocket, takes its phone calls ({id, method, path, body}) and answers each ({id,
/// status, body}) through `calls`, in this process; nothing can reach in. The Hive Server, on the owner's tailnet, is
/// dialled through Tailscale inside the app (Tailnet.swift).
///
/// A new phone discovers a Hive on the owner's tailnet. A paired phone reconnects to its saved server.
@objc(HiveLink) public final class Link: NSObject, URLSessionWebSocketDelegate {
    @objc public static let shared = Link()
    static let protocolVersion = 1

    /// Answers the server's phone calls once phone control runs: Runner's, set by the test that is phone control
    /// (HivePhone.testRun) after the developer image is mounted. Until then each call gets `control` as its error.
    var calls: ((String, String, String, @escaping (Int, String) -> Void) -> Void)? { didSet { changed() } }
    /// How setting phone control up stands while it's off (Launcher/Main.m), for the dashboard's card.
    @objc public var control = "" { didSet { changed() } }

    private(set) var pairing: Pairing?
    private(set) var connected = false
    private(set) var refused = false
    /// Where to install a newer Hive, once Hive Server says this one is behind (phone/src/link.rs): Dashboard's "Update Hive".
    private(set) var update: URL?
    private var session: URLSession?
    private var socket: URLSessionWebSocketTask?
    private var failing = false, retry = 0
    private let auto = TailnetPairing()

    static var version: String {
        (Bundle.main.object(forInfoDictionaryKey: "HiveVersion") as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "dev"
    }

    @objc public func start() {
        pairing = Pairing.load()
        NotificationCenter.default.addObserver(forName: Tailnet.changed, object: nil, queue: .main) { [weak self] _ in
            // Once Tailscale is up, the first dial; after a failure the backoff in reconnect dials again.
            if let self, self.socket == nil, !self.failing, self.pairing != nil, Tailnet.shared.running { self.connect() }
        }
        connect()
        // Unpaired or refused: look for the Hive Server.
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

    /// Unpaired: Tailscale first (signed in from the dashboard), then the Hive Server on it. Failing: it may bring a new
    /// pairing.
    private func lookForPairing() {
        // The Mac can select a different server over USB while this app is running.
        if let saved = Pairing.load(), saved != pairing {
            adopt(saved)
            return
        }
        guard pairing == nil || failing else { return }
        if pairing == nil { Tailnet.shared.start() }
        let previous = pairing
        auto.look(savedHost: previous?.host) { [weak self] found in
            guard let self, self.pairing == previous, Pairing.load() == previous,
                  (previous == nil || self.failing), found != previous else { return }
            found.save()
            self.adopt(found)
        }
    }

    private func adopt(_ found: Pairing) {
        pairing = found
        update = nil
        refused = false
        failing = false
        retry = 0
        let old = socket
        socket = nil
        connected = false
        old?.cancel(with: .goingAway, reason: nil)
        session?.invalidateAndCancel()
        session = nil
        changed()
        connect()
    }

    private func connect() {
        guard socket == nil, let p = pairing else { return }
        if !Tailnet.shared.running { Tailnet.shared.start(); return }
        if session == nil {
            let cfg = URLSessionConfiguration.ephemeral
            cfg.timeoutIntervalForRequest = 25
            cfg.timeoutIntervalForResource = 30
            if let proxy = Tailnet.shared.proxy { cfg.proxyConfigurations = [proxy] }
            session = URLSession(configuration: cfg, delegate: self, delegateQueue: .main)
        }
        var r = URLRequest(url: p.url)
        r.setValue("Bearer \(p.token)", forHTTPHeaderField: "Authorization")
        r.setValue("phone:iphone", forHTTPHeaderField: "X-Hive-Node")
        r.setValue(Link.version, forHTTPHeaderField: "X-Hive-Version")
        r.setValue(Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String, forHTTPHeaderField: "X-Hive-Build")
        r.setValue("\(Link.protocolVersion)", forHTTPHeaderField: "X-Hive-Protocol")
        let ws = session!.webSocketTask(with: r)
        ws.maximumMessageSize = 2 << 20
        socket = ws
        ws.resume()
        receive(ws)
    }

    public func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        guard webSocketTask == socket else { return }
        connected = true
        failing = false
        retry = 0
        refused = false
        changed()
        sendDeveloperIdentity()
    }

    /// The pairing identity this iPhone made with Hive by itself (Launcher/src/pair.rs), for the Hive Server to keep too,
    /// as it keeps one a computer makes over USB (phone/src/bootstrap.rs). Sent once the link is up.
    @objc public func saveDeveloperIdentity(_ device: String) {
        UserDefaults.standard.set(device, forKey: "HiveIdentityToSend")
        sendDeveloperIdentity()
    }

    private func sendDeveloperIdentity() {
        guard connected, let device = UserDefaults.standard.string(forKey: "HiveIdentityToSend"), let p = pairing, let session,
              let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first,
              let identity = try? Data(contentsOf: documents.appendingPathComponent("developer-pairing.plist")) else { return }
        var r = URLRequest(url: p.dashboard.appendingPathComponent("phone/bootstrap/\(device)"))
        r.httpMethod = "POST"
        r.setValue("Bearer \(p.token)", forHTTPHeaderField: "Authorization")
        r.setValue("application/x-plist", forHTTPHeaderField: "Content-Type")
        r.httpBody = identity
        session.dataTask(with: r) { _, response, _ in
            // Kept (200), or the server already keeps an earlier identity this iPhone trusts (409): either way it's done.
            guard let status = (response as? HTTPURLResponse)?.statusCode, status == 200 || status == 409 else { return }
            UserDefaults.standard.removeObject(forKey: "HiveIdentityToSend")
        }.resume()
    }

    /// The window (Dashboard.swift) follows the link and Tailscale through one notification.
    private func changed() { NotificationCenter.default.post(name: Tailnet.changed, object: nil) }

    /// How it stands, in the owner's words, for the window.
    var summary: String {
        let t = Tailnet.shared
        guard let p = pairing else {
            return t.running ? "Signed in to Tailscale. Looking for your Hive Server there (on the same Tailscale account)…" :
                "Sign in with Tailscale (the same account as your Hive Server)."
        }
        if !t.running {
            return t.loginURL != nil ? "Your Hive Server is on your tailnet: sign Hive in with Tailscale to reach it." :
                t.state.hasPrefix("Tailscale didn't") ? t.state : "Starting Tailscale…"
        }
        if refused { return "\(p.host) turned this pairing down: Hive asks it again through Tailscale." }
        return connected ? "Connected to \(p.host)." : "Connecting to \(p.host)…"
    }

    private func reconnect(_ ws: URLSessionWebSocketTask) {
        guard ws == socket else { return }
        socket = nil
        failing = true
        connected = false
        let status = (ws.response as? HTTPURLResponse)?.statusCode ?? 0
        // The server turned this pairing down: lookForPairing asks it for a new one.
        if status == 401 || status == 403 { refused = true }
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
                    if let data, let command = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] {
                        if command.keys.contains("update") {
                            // Only iOS's own installer link: it installs the new build over this one, keeping its data.
                            self.update = (command["update"] as? String).flatMap { URL(string: $0) }.flatMap { $0.scheme == "itms-services" ? $0 : nil }
                            self.changed()
                        } else {
                            self.forward(command, ws)
                        }
                    }
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
        guard let calls else {
            let off = ["value": ["error": "phone control is off", "message": control.isEmpty ? "Phone control is starting." : control]]
            let text = (try? JSONSerialization.data(withJSONObject: off)).map { String(decoding: $0, as: UTF8.self) } ?? ""
            return reply(id, 503, text, ws)
        }
        Link.performControl { [weak self] in
            calls(method, path, body) { [weak self] status, text in self?.reply(id, status, text, ws) }
        }
    }

    static func performControl(_ work: @escaping () -> Void) {
        // XCTest pumps the run loop while waiting for input to finish. It must
        // not hold receive's main-queue block: UIKit/WebKit callbacks may need
        // that same serial queue to finish the action (including taps in Hive).
        CFRunLoopPerformBlock(CFRunLoopGetMain(), RunLoop.Mode.common.rawValue as CFString, work)
        CFRunLoopWakeUp(CFRunLoopGetMain())
    }

    private func reply(_ id: String, _ status: Int, _ text: String, _ ws: URLSessionWebSocketTask) {
        var (status, text) = (status, text)
        if text.utf8.count > 12 << 20 { (status, text) = (502, "{\"error\":\"response too large\"}") }
        guard let json = try? JSONSerialization.data(withJSONObject: ["id": id, "status": status, "body": text]),
              let str = String(data: json, encoding: .utf8) else { return }
        ws.send(.string(str)) { [weak self] err in
            if err != nil { DispatchQueue.main.async { self?.reconnect(ws) } }
        }
    }
}
