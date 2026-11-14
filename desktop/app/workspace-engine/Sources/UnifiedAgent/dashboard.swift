// Hive's dashboard in a window of Hive.app: the same app as the website, the phone and the browser
// extension (dashboard/ at the repository's root). `make build/dashboard` builds it for here
// (`npm run build:desktop`) into build/dashboard, and this window serves it from hive://app/.
// It answers the dashboard's /api/* itself, the same routes the website answers:
//
//   GET  /api/tasks          every machine's tasks (`hive-tasks board --cloud`), or this Mac's
//                            ledger (`hive-tasks board --all --json`) when the cloud is out of reach
//   GET  /api/agents         the agents it can hand a task to: Hive, through its request socket
//   POST /api/agents/send    {agent, text}: the text to Hive's request socket, as a request
//   GET  /api/folder         ?project&key: a folder and all its memories, from the cloud board
//   POST /api/folders        {project, name, about?}: makes a folder (on the cloud board)
//   POST /api/folders/memory {project, folder, kind, title, body}: a memory for the folder
//   POST /api/dictation      {action: start|stop|cancel}: this window records you; on stop, Hive's
//                            voice process reads it with the model that hears you ({text})
//
// Opened from the menu (Open Dashboard) or a hive:// link: `open hive://tasks`, which is what
// `hive-tasks web` does on the Mac. While it's open Hive is in the Dock and in ⌘-Tab.

import AppKit
import AVFoundation
import WebKit

@MainActor final class DashboardWindow: NSObject, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate {
    private var window: NSWindow?
    private var web: WKWebView?
    private let scheme: DashboardScheme

    init(files: URL, stateDir: URL) {
        scheme = DashboardScheme(files: files, stateDir: stateDir)
    }

    /// Shows the window at `path` ("/" is the task board).
    func show(path: String = "/") {
        let url = URL(string: "hive://app" + (path.hasPrefix("/") ? path : "/" + path))!
        if window == nil {
            make(url)
        } else if path != "/" || web?.url == nil {
            web?.load(URLRequest(url: url))
        }
        NSApp.setActivationPolicy(.regular)
        installMenu()
        NSApp.activate(ignoringOtherApps: true)
        window?.makeKeyAndOrderFront(nil)
    }

    /// The menu bar while the window is up. Hive otherwise lives in the menu bar with no menus,
    /// and without an Edit menu ⌘C, ⌘V and ⌘A do nothing in the page; View has full screen
    /// (⌃⌘F) and Reload (⌘R, for a freshly built dashboard). No Quit: closing this window
    /// shouldn't be one slip away from stopping Hive.
    private func installMenu() {
        guard NSApp.mainMenu?.item(withTitle: "Edit") == nil else { return }
        let bar = NSMenu()
        func item(_ title: String, _ action: Selector, _ key: String,
                  _ modifiers: NSEvent.ModifierFlags = .command, to target: AnyObject? = nil) -> NSMenuItem {
            let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
            item.keyEquivalentModifierMask = modifiers
            item.target = target
            return item
        }
        func add(_ title: String, _ items: [NSMenuItem]) {
            let menu = NSMenu(title: title)
            items.forEach(menu.addItem)
            let holder = NSMenuItem(title: title, action: nil, keyEquivalent: "")
            holder.submenu = menu
            bar.addItem(holder)
        }
        add("Hive", [
            item("Hide Hive", #selector(NSApplication.hide(_:)), "h"),
            item("Close Window", #selector(NSWindow.performClose(_:)), "w"),
        ])
        add("Edit", [
            item("Undo", Selector(("undo:")), "z"),
            item("Redo", Selector(("redo:")), "z", [.command, .shift]),
            .separator(),
            item("Cut", #selector(NSText.cut(_:)), "x"),
            item("Copy", #selector(NSText.copy(_:)), "c"),
            item("Paste", #selector(NSText.paste(_:)), "v"),
            item("Select All", #selector(NSText.selectAll(_:)), "a"),
        ])
        add("View", [
            item("Reload", #selector(reload), "r", to: self),
            item("Enter Full Screen", #selector(NSWindow.toggleFullScreen(_:)), "f", [.control, .command]),
        ])
        add("Window", [
            item("Minimize", #selector(NSWindow.performMiniaturize(_:)), "m"),
            item("Zoom", #selector(NSWindow.performZoom(_:)), ""),
        ])
        NSApp.mainMenu = bar
    }

    @objc private func reload() {
        web?.reload()
    }

    private func make(_ url: URL) {
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(scheme, forURLScheme: "hive")
        let web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = self
        web.uiDelegate = self
        web.underPageBackgroundColor = NSColor(red: 0.03, green: 0.04, blue: 0.06, alpha: 1)
        web.setValue(false, forKey: "drawsBackground")
        if #available(macOS 13.3, *) { web.isInspectable = true }
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1100, height: 820),
                              styleMask: [.titled, .closable, .miniaturizable, .resizable],
                              backing: .buffered, defer: false)
        window.title = "Hive"
        window.backgroundColor = web.underPageBackgroundColor
        window.contentView = web
        window.isReleasedWhenClosed = false
        window.delegate = self
        // Opens on the desktop the owner is on, and can go full screen (the green button, ⌃⌘F).
        window.collectionBehavior = [.moveToActiveSpace, .fullScreenPrimary]
        window.center()
        window.setFrameAutosaveName("HiveDashboard")
        web.load(URLRequest(url: url))
        self.window = window
        self.web = web
    }

    func windowWillClose(_ notification: Notification) {
        window = nil
        web = nil
        NSApp.setActivationPolicy(.accessory)  // back to the menu bar only
    }

    // Links out of the dashboard open in the browser, not in this window.
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
        if let url = action.request.url, url.scheme != "hive", url.scheme != "about" {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url { NSWorkspace.shared.open(url) }
        return nil
    }

    /// The dashboard path a hive:// link asks for: hive://tasks → "/", hive://voice → "/voice".
    static func path(for link: URL) -> String {
        let host = link.host ?? ""
        let rest = link.path
        if ["", "app", "tasks", "dashboard"].contains(host) { return rest.isEmpty ? "/" : rest }
        return "/" + host + rest
    }
}

/// Serves the built dashboard from hive://app/ and answers its /api/*.
final class DashboardScheme: NSObject, WKURLSchemeHandler {
    let files: URL
    let stateDir: URL
    private var stopped = Set<ObjectIdentifier>()

    init(files: URL, stateDir: URL) {
        self.files = files.standardizedFileURL
        self.stateDir = stateDir
    }

    func webView(_ webView: WKWebView, start task: any WKURLSchemeTask) {
        guard let url = task.request.url else { return }
        let path = url.path.isEmpty ? "/" : url.path
        guard path.hasPrefix("/api/") else {
            let (status, type, data) = staticFile(path)
            reply(task, url: url, status: status, type: type, data: data)
            return
        }
        let method = task.request.httpMethod ?? "GET"
        let body = task.request.httpBody ?? task.request.httpBodyStream.map(Self.read) ?? Data()
        let id = ObjectIdentifier(task)
        let state = stateDir
        DispatchQueue.global(qos: .userInitiated).async {
            let (status, data) = DashboardAPI.answer(method: method, path: path, query: url.query ?? "", body: body, stateDir: state)
            DispatchQueue.main.async {
                if self.stopped.remove(id) != nil { return }
                self.reply(task, url: url, status: status, type: "application/json; charset=utf-8", data: data)
            }
        }
    }

    func webView(_ webView: WKWebView, stop task: any WKURLSchemeTask) {
        stopped.insert(ObjectIdentifier(task))
    }

    private func reply(_ task: any WKURLSchemeTask, url: URL, status: Int, type: String, data: Data) {
        let headers = ["Content-Type": type, "Cache-Control": "no-store", "Content-Length": String(data.count)]
        task.didReceive(HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!)
        task.didReceive(data)
        task.didFinish()
    }

    /// A file of the build, or index.html for any other path (the dashboard routes in the page).
    private func staticFile(_ path: String) -> (Int, String, Data) {
        let wanted = files.appendingPathComponent(String(path.dropFirst())).standardizedFileURL
        var isDirectory: ObjCBool = false
        let inside = wanted.path.hasPrefix(files.path + "/")
        let file = inside && FileManager.default.fileExists(atPath: wanted.path, isDirectory: &isDirectory)
            && !isDirectory.boolValue ? wanted : files.appendingPathComponent("index.html")
        guard let data = try? Data(contentsOf: file) else {
            let text = "<!doctype html><body style='font:15px system-ui;background:#080a0f;color:#f7f8fa;margin:2rem'>"
                + "The dashboard isn't built yet. In Terminal: <code>make -C ~/hive/desktop/app build/dashboard</code></body>"
            return (404, "text/html; charset=utf-8", Data(text.utf8))
        }
        return (200, Self.type(of: file.pathExtension), data)
    }

    static func type(of ext: String) -> String {
        switch ext.lowercased() {
        case "html": return "text/html; charset=utf-8"
        case "js", "mjs": return "text/javascript; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "json", "webmanifest": return "application/json"
        case "svg": return "image/svg+xml"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "ico": return "image/x-icon"
        case "woff2": return "font/woff2"
        case "woff": return "font/woff"
        case "txt": return "text/plain; charset=utf-8"
        default: return "application/octet-stream"
        }
    }

    static func read(_ stream: InputStream) -> Data {
        var data = Data()
        stream.open()
        defer { stream.close() }
        var buffer = [UInt8](repeating: 0, count: 16384)
        while stream.hasBytesAvailable {
            let n = stream.read(&buffer, maxLength: buffer.count)
            if n <= 0 { break }
            data.append(buffer, count: n)
        }
        return data
    }
}

/// The dashboard's /api/* on the Mac. Runs off the main thread.
enum DashboardAPI {
    static let hiveAgent = "hive-mac"

    static func answer(method: String, path: String, query: String = "", body: Data, stateDir: URL) -> (Int, Data) {
        switch (method.uppercased(), path) {
        case ("GET", "/api/tasks"): return tasks()
        case ("GET", "/api/agents"): return agents(stateDir: stateDir)
        case ("POST", "/api/agents/send"): return send(body, stateDir: stateDir)
        case ("GET", "/api/folder"): return folder(query)
        case ("POST", "/api/folders"): return board("post", "/v1/folders", body)
        case ("POST", "/api/folders/memory"): return board("post", "/v1/folders/memory", body, thenSync: true)
        case ("POST", "/api/dictation"): return Dictation.answer(body, stateDir: stateDir)
        default: return (404, json(["error": "The desktop app doesn't answer \(path) yet."]))
        }
    }

    static func json(_ value: Any) -> Data {
        (try? JSONSerialization.data(withJSONObject: value)) ?? Data("{}".utf8)
    }

    // ---- tasks ----------------------------------------------------------------------------

    static func tasks() -> (Int, Data) {
        let tool = hiveTasks()
        if let out = run(tool, ["board", "--cloud"]), let board = try? JSONSerialization.jsonObject(with: out) {
            return (200, json(["source": "cloud", "board": board]))
        }
        if let out = run(tool, ["board", "--all", "--json"]), let board = try? JSONSerialization.jsonObject(with: out) {
            return (200, json(["source": "local", "note": "the cloud couldn't be reached", "board": board]))
        }
        return (502, json(["error": "hive-tasks couldn't read the board (\(tool))."]))
    }

    /// A folder and all its memories, as the cloud board has them (`hive-tasks get /v1/folder`).
    static func folder(_ query: String) -> (Int, Data) {
        var asked = URLComponents()
        asked.query = query
        let item = { (name: String) in asked.queryItems?.first(where: { $0.name == name })?.value ?? "" }
        var out = URLComponents()
        out.queryItems = [URLQueryItem(name: "project", value: item("project")), URLQueryItem(name: "key", value: item("key"))]
        return board("get", "/v1/folder?" + (out.percentEncodedQuery ?? ""), Data())
    }

    /// Asks the cloud board through `hive-tasks get|post` (the machine's sign-in stays with it).
    /// Everything is kept in the cloud first; `thenSync` has this Mac's ledger take it in now.
    static func board(_ verb: String, _ path: String, _ body: Data, thenSync: Bool = false) -> (Int, Data) {
        let tool = hiveTasks()
        guard let out = run(tool, [verb, path], input: verb == "post" ? body : nil),
              (try? JSONSerialization.jsonObject(with: out)) != nil else {
            return (502, json(["error": "Couldn't reach the cloud board (\(path))."]))
        }
        if thenSync { DispatchQueue.global().async { _ = run(tool, ["sync", "--quiet"], seconds: 60) } }
        return (200, out)
    }

    /// One JSON line to a Unix socket and the JSON line it answers. nil: nothing is listening
    /// there (or the line couldn't be sent); .some(nil): no readable answer within `seconds`.
    static func ask(socket path: String, _ request: [String: Any], seconds: Int) -> [String: Any]?? {
        let fd = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { return nil }
        defer { close(fd) }
        var wait = timeval(tv_sec: seconds, tv_usec: 0)
        setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &wait, socklen_t(MemoryLayout<timeval>.size))
        setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &wait, socklen_t(MemoryLayout<timeval>.size))
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8)
        guard bytes.count < MemoryLayout.size(ofValue: address.sun_path) else { return nil }
        withUnsafeMutableBytes(of: &address.sun_path) { $0.copyBytes(from: bytes) }
        let connected = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard connected == 0 else { return nil }
        var line = json(request)
        line.append(0x0A)
        let sent = line.withUnsafeBytes { write(fd, $0.baseAddress, line.count) }
        guard sent == line.count else { return nil }
        var answer = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while answer.count < 65536, !answer.contains(0x0A) {
            let n = read(fd, &buffer, buffer.count)
            if n <= 0 { break }
            answer.append(buffer, count: n)
        }
        guard let end = answer.firstIndex(of: 0x0A) else { return .some(nil) }
        return .some((try? JSONSerialization.jsonObject(with: answer[..<end])) as? [String: Any])
    }

    static func hiveTasks() -> String {
        let local = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".local/bin/hive-tasks").path
        return FileManager.default.isExecutableFile(atPath: local) ? local : "/opt/homebrew/bin/hive-tasks"
    }

    /// Runs `tool args`; its output when it exits 0 within `seconds`.
    static func run(_ tool: String, _ args: [String], input: Data? = nil, seconds: Double = 15) -> Data? {
        guard FileManager.default.isExecutableFile(atPath: tool) else { return nil }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: tool)
        process.arguments = args
        let out = Pipe()
        process.standardOutput = out
        process.standardError = FileHandle.nullDevice
        let stdin = input.map { _ in Pipe() }
        if let stdin { process.standardInput = stdin }
        do { try process.run() } catch { return nil }
        if let stdin, let input {
            stdin.fileHandleForWriting.write(input)
            try? stdin.fileHandleForWriting.close()
        }
        let timer = DispatchWorkItem { if process.isRunning { process.terminate() } }
        DispatchQueue.global().asyncAfter(deadline: .now() + seconds, execute: timer)
        let data = out.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        timer.cancel()
        return process.terminationStatus == 0 ? data : nil
    }

    // ---- agents ---------------------------------------------------------------------------

    static func socket(_ stateDir: URL) -> String {
        stateDir.appendingPathComponent("control/request.sock").path
    }

    static func agents(stateDir: URL) -> (Int, Data) {
        let up = FileManager.default.fileExists(atPath: socket(stateDir))
        var hive: [String: Any] = ["id": hiveAgent, "name": "Hive", "where": "this Mac", "available": up]
        if !up { hive["note"] = "Hive isn't running on this Mac, so it can't take a request." }
        return (200, json(["agents": [hive]]))
    }

    static func send(_ body: Data, stateDir: URL) -> (Int, Data) {
        let request = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] ?? [:]
        let text = (request["text"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard request["agent"] as? String == hiveAgent else {
            return (400, json(["accepted": false, "error": "The desktop app can only send to Hive for now."]))
        }
        guard !text.isEmpty, text.utf8.count <= 12000 else {
            return (400, json(["accepted": false, "error": text.isEmpty ? "Say what to do." : "That's too long for one request."]))
        }
        return (200, json(toHive(text, socket: socket(stateDir))))
    }

    /// One request through Hive's request socket: a JSON line out, a JSON line back
    /// (`{ok, receiptId?, status?, error?}`), read the way desktop/local-request.mjs reads it.
    static func toHive(_ text: String, socket path: String) -> [String: Any] {
        let notRunning: [String: Any] = ["accepted": false, "error": "Hive isn't running on this Mac, so it can't take a request."]
        let unknown: [String: Any] = ["accepted": NSNull(), "error": "No answer from Hive; it may have started anyway."]
        let request: [String: Any] = ["text": text, "sourceId": "dashboard:" + UUID().uuidString.lowercased()]
        guard let answer = ask(socket: path, request, seconds: 8) else { return notRunning }
        guard let reply = answer, let ok = reply["ok"] as? Bool else { return unknown }
        var out: [String: Any] = [:]
        if let receipt = reply["receiptId"] as? String { out["receiptId"] = receipt }
        let status = reply["status"] as? String ?? ""
        let error = reply["error"] as? String
        if ok {
            out["accepted"] = true
        } else if out["receiptId"] != nil, ["dispatching", "unknown"].contains(status) {
            out["accepted"] = NSNull()
        } else if status == "accepted", error == "Request already received; no repeat was started." {
            out["accepted"] = true
        } else {
            out["accepted"] = false
            out["error"] = error == "The personal-agent is already working."
                ? "Hive is busy with another task. Send it again when that one's done."
                : (error ?? "Hive didn't take it.")
        }
        return out
    }
}

/// Dictation for the composer. This window records you (16 kHz mono WAV, the rate Parakeet
/// reads) between start and stop, then hands the file to Hive's voice process
/// (python/sidecar_voice.py, `<state>/dictation.sock`), which reads it with the same model that
/// hears you when you tap fn. The recording is deleted once it's read.
enum Dictation {
    private static var recorder: AVAudioRecorder?
    private static var file: URL?

    static func answer(_ body: Data, stateDir: URL) -> (Int, Data) {
        let request = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] ?? [:]
        switch request["action"] as? String {
        case "start": return start()
        case "stop": return stop(stateDir)
        case "cancel":
            if let recorded = finish() { try? FileManager.default.removeItem(at: recorded) }
            return (200, DashboardAPI.json(["recording": false]))
        default: return (400, DashboardAPI.json(["error": "action is start, stop or cancel."]))
        }
    }

    static func start() -> (Int, Data) {
        guard allowed() else {
            return (403, DashboardAPI.json(["error": "Hive isn't allowed to use the microphone. Allow it in System Settings › Privacy & Security › Microphone."]))
        }
        let path = FileManager.default.temporaryDirectory.appendingPathComponent("hive-dictation-\(UUID().uuidString).wav")
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: 16000, AVNumberOfChannelsKey: 1,
            AVLinearPCMBitDepthKey: 16, AVLinearPCMIsFloatKey: false, AVLinearPCMIsBigEndianKey: false,
        ]
        let error: String? = DispatchQueue.main.sync {
            if let old = finish() { try? FileManager.default.removeItem(at: old) }
            do {
                let new = try AVAudioRecorder(url: path, settings: settings)
                guard new.record(forDuration: 600) else { return "The microphone wouldn't start recording." }
                recorder = new
                file = path
                return nil
            } catch {
                return "The microphone wouldn't start recording: \(error.localizedDescription)"
            }
        }
        if let error { return (500, DashboardAPI.json(["error": error])) }
        return (200, DashboardAPI.json(["recording": true]))
    }

    static func stop(_ stateDir: URL) -> (Int, Data) {
        guard let recorded = finish() else {
            return (409, DashboardAPI.json(["error": "Nothing was being recorded."]))
        }
        defer { try? FileManager.default.removeItem(at: recorded) }
        let socket = stateDir.appendingPathComponent("dictation.sock").path
        guard let answer = DashboardAPI.ask(socket: socket, ["wav": recorded.path], seconds: 120) else {
            return (503, DashboardAPI.json(["error": "Hive's voice isn't running, so it can't read what you said."]))
        }
        guard let reply = answer else {
            return (504, DashboardAPI.json(["error": "Hive's voice didn't answer in time."]))
        }
        if let error = reply["error"] as? String { return (502, DashboardAPI.json(["error": error])) }
        return (200, DashboardAPI.json(["text": reply["text"] as? String ?? ""]))
    }

    /// Stops recording; the file it made, if it was recording.
    private static func finish() -> URL? {
        let stopNow = {
            recorder?.stop()
            recorder = nil
            defer { file = nil }
            return file
        }
        return Thread.isMainThread ? stopNow() : DispatchQueue.main.sync(execute: stopNow)
    }

    /// Asks once (macOS shows its prompt for Hive) and waits for the answer.
    private static func allowed() -> Bool {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: return true
        case .notDetermined:
            let answered = DispatchSemaphore(value: 0)
            var granted = false
            AVCaptureDevice.requestAccess(for: .audio) { granted = $0; answered.signal() }
            _ = answered.wait(timeout: .now() + 120)
            return granted
        default: return false
        }
    }
}
