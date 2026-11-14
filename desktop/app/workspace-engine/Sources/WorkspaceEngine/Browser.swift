// The workspace's own Chrome-family browser: a separate copy with a private profile in the engine's
// folder (never the user's signed-in one), listening for the DevTools protocol on a local port.
// Tabs are opened, listed and brought forward over that port's HTTP endpoints.
import AppKit
import Darwin
import Foundation
import WorkspaceCore

enum Browser {
    /// The first Chrome-family browser installed.
    static func installed() -> URL? {
        for id in Apps.chromium {
            if let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: id) { return url }
        }
        return nil
    }

    static func isChromium(_ url: URL) -> Bool {
        guard let id = Bundle(url: url)?.bundleIdentifier else { return false }
        return Apps.chromium.contains(id)
    }

    /// A free local port.
    static func freePort() -> Int? {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { return nil }
        defer { close(fd) }
        var address = sockaddr_in()
        address.sin_family = sa_family_t(AF_INET)
        address.sin_addr.s_addr = inet_addr("127.0.0.1")
        address.sin_port = 0
        let bound = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
        }
        guard bound == 0 else { return nil }
        var length = socklen_t(MemoryLayout<sockaddr_in>.size)
        let named = withUnsafeMutablePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &length) }
        }
        return named == 0 ? Int(UInt16(bigEndian: address.sin_port)) : nil
    }

    /// Starts the browser; returns it and its DevTools port.
    static func start(_ url: URL, profile: URL, page: String?) throws -> (NSRunningApplication, Int) {
        guard let port = freePort() else { throw WorkspaceError("launch_failed", "no local port was free for the workspace browser") }
        try FileManager.default.createDirectory(at: profile, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let app = try Apps.launch(url, arguments: [
            "--user-data-dir=\(profile.path)", "--remote-debugging-port=\(port)", "--remote-debugging-address=127.0.0.1",
            "--no-first-run", "--no-default-browser-check", "--disable-session-crashed-bubble", "--new-window",
            page ?? "about:blank",
        ])
        let deadline = Date().addingTimeInterval(15)
        while Date() < deadline {
            if (try? request("GET", port: port, path: "/json/version")) != nil { return (app, port) }
            usleep(200_000)
        }
        throw WorkspaceError("launch_failed", "the workspace browser started but its DevTools port never answered")
    }

    static func request(_ method: String, port: Int, path: String) throws -> Any {
        guard let url = URL(string: "http://127.0.0.1:\(port)\(path)") else { throw WorkspaceError("bad_request", "bad browser address") }
        var request = URLRequest(url: url, timeoutInterval: 5)
        request.httpMethod = method
        final class Box { var data: Data?; var error: Error? }
        let box = Box()
        let done = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: request) { data, _, error in
            box.data = data
            box.error = error
            done.signal()
        }.resume()
        guard done.wait(timeout: .now() + 6) == .success, let data = box.data else {
            throw WorkspaceError("browser_unavailable", "the workspace browser didn't answer: \(box.error?.localizedDescription ?? "timed out")")
        }
        return (try? JSONSerialization.jsonObject(with: data)) ?? String(decoding: data, as: UTF8.self)
    }

    /// The browser's tabs: id, title and address.
    static func tabs(port: Int) throws -> [[String: String]] {
        let list = try request("GET", port: port, path: "/json/list") as? [[String: Any]] ?? []
        return list.filter { ($0["type"] as? String) == "page" }.map {
            ["id": $0["id"] as? String ?? "", "title": $0["title"] as? String ?? "", "url": $0["url"] as? String ?? ""]
        }
    }

    static func open(_ page: String, port: Int) throws -> [String: String] {
        guard let encoded = page.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) else {
            throw WorkspaceError("bad_request", "the URL could not be encoded")
        }
        let made = try request("PUT", port: port, path: "/json/new?\(encoded)") as? [String: Any] ?? [:]
        let id = made["id"] as? String ?? ""
        if !id.isEmpty { _ = try? request("GET", port: port, path: "/json/activate/\(id)") }
        return ["id": id, "url": made["url"] as? String ?? page]
    }

    static func activate(_ id: String, port: Int) throws {
        guard id.range(of: #"^[A-Za-z0-9._-]{1,128}$"#, options: .regularExpression) != nil else {
            throw WorkspaceError("bad_request", "\"target\" is a tab id from workspace_list_targets")
        }
        guard try tabs(port: port).contains(where: { $0["id"] == id }) else {
            throw WorkspaceError("unknown_target", "the workspace browser has no tab \(id)")
        }
        _ = try request("GET", port: port, path: "/json/activate/\(id)")
    }
}
