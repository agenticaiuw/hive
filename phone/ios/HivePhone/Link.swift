import Foundation

/// Hive Phone's link to its Hive (the server's side is phone/src/link.rs). It dials out to the server over one WebSocket,
/// takes its phone calls ({id, method, path, body}) and answers each ({id, status, body}) with Runner, in this process;
/// nothing can reach in. A Hive on a tailnet (*.ts.net) is dialled through Tailscale inside the app (Tailnet.swift).
///
/// While Hive Phone isn't connected (unpaired, refused, or its Hive is gone or moved) it watches the clipboard for a
/// pairing (Pairing.swift). A connected phone never reads it.
final class Link: NSObject, URLSessionWebSocketDelegate {
    static let shared = Link()
    static let protocolVersion = 1

    private(set) var pairing: Pairing?
    private(set) var connected = false
    private(set) var refused = false
    private var session: URLSession?
    private var socket: URLSessionWebSocketTask?
    private var failing = false, retry = 0
    private let watch = PairingWatch()

    static var version: String {
        let v = Bundle.main.object(forInfoDictionaryKey: "HiveVersion") ?? Bundle(for: Link.self).object(forInfoDictionaryKey: "HiveVersion")
        return (v as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "dev"
    }

    func start() {
        pairing = Pairing.load()
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

    private func lookForPairing() {
        guard pairing == nil || failing else { return }
        watch.look { [weak self] found in
            guard let self else { return }
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
            self.connect()
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
    }

    private func reconnect(_ ws: URLSessionWebSocketTask) {
        guard ws == socket else { return }
        socket = nil
        failing = true
        connected = false
        let status = (ws.response as? HTTPURLResponse)?.statusCode ?? 0
        // The server turned this pairing down: take a new one from the clipboard when it comes.
        if status == 401 || status == 403 { refused = true; watch.reset() }
        ws.cancel(with: .goingAway, reason: nil)
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
}
