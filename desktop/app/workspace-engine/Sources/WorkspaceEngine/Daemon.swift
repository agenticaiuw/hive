// The background process that owns the workspace display (`workspace-engine daemon run`, started
// by the first `workspace-engine mcp` that needs it). The session outlives the agent's restarts
// because it lives here: a restarted agent claims it again. One daemon per state folder.
import AppKit
import CryptoKit
import Darwin
import Foundation
import WorkspaceCore

public enum Engine {
    public static let version = "1"

    public static func executablePath() -> String {
        var size: UInt32 = 0
        _NSGetExecutablePath(nil, &size)
        var buffer = [CChar](repeating: 0, count: Int(size) + 1)
        guard _NSGetExecutablePath(&buffer, &size) == 0 else { return CommandLine.arguments[0] }
        var resolved = [CChar](repeating: 0, count: Int(PATH_MAX) + 1)
        return realpath(buffer, &resolved) != nil ? String(cString: resolved) : String(cString: buffer)
    }

    /// The running binary's SHA-256: two processes match when they run the same build.
    public static func executableHash(_ path: String = executablePath()) -> String {
        guard let data = FileManager.default.contents(atPath: path) else { return "" }
        return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
}

public enum Daemon {
    public static func run(state: URL) -> Int32 {
        let directory = Paths.engineDir(state: state)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let lock = open(directory.appendingPathComponent("daemon.lock").path, O_RDWR | O_CREAT, 0o600)
        guard lock >= 0, flock(lock, LOCK_EX | LOCK_NB) == 0 else {
            FileHandle.standardError.write(Data("workspace-engine: the background process is already running\n".utf8))
            return 0
        }
        let simulated = ProcessInfo.processInfo.environment["HIVE_WORKSPACE_TEST_DISPLAY"] == "1"
        let manager = SessionManager(state: state,
                                     displays: simulated ? TestDisplays() : RealDisplays(),
                                     housekeeper: simulated ? NoHousekeeper() : RealHousekeeper(),
                                     health: simulated ? { nil } : HostHealth.problem)
        manager.janitor()
        let server = DaemonServer(state: state, manager: manager, simulated: simulated)
        do {
            try server.start()
        } catch {
            FileHandle.standardError.write(Data("workspace-engine: \(error)\n".utf8))
            return 1
        }
        let application = NSApplication.shared
        application.setActivationPolicy(.prohibited)
        application.run()
        return 0
    }
}

final class DaemonServer {
    let state: URL
    let manager: SessionManager
    let workspace: Workspace
    let simulated: Bool
    let socketPath: String
    let infoURL: URL
    let identity = Engine.executableHash()
    private let lock = NSLock()
    private var connections: [ClientID: String] = [:]
    private var serial = 0
    private var lastBusy = now()
    private var listener: Int32 = -1
    private var timer: DispatchSourceTimer?
    private var signals: [DispatchSourceSignal] = []
    private var lastUserApp: NSRunningApplication?
    static let idleExit: Double = 60

    init(state: URL, manager: SessionManager, simulated: Bool) {
        self.state = state
        self.manager = manager
        self.simulated = simulated
        workspace = Workspace(manager: manager, state: state, simulated: simulated)
        socketPath = Wire.socketPath(state: state)
        infoURL = Paths.engineDir(state: state).appendingPathComponent("daemon.json")
    }

    func start() throws {
        listener = try Wire.listen(socketPath)
        try JSONFile.write(["pid": Int(getpid()), "instanceID": manager.instanceID, "executableHash": identity,
                            "startedAt": now()], to: infoURL)
        let accept = Thread { [weak self] in self?.acceptLoop() }
        accept.name = "workspace-daemon-accept"
        accept.start()

        let timer = DispatchSource.makeTimerSource(queue: DispatchQueue(label: "workspace-daemon-housekeeping"))
        timer.schedule(deadline: .now() + 1, repeating: 1)
        timer.setEventHandler { [weak self] in self?.housekeeping() }
        timer.resume()
        self.timer = timer

        for number in [SIGTERM, SIGINT, SIGHUP] {
            signal(number, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
            source.setEventHandler { [weak self] in self?.shutdown("signal \(number)") }
            source.resume()
            signals.append(source)
        }
        if !simulated { watchFocus() }
    }

    private func acceptLoop() {
        while true {
            let fd = accept(listener, nil, nil)
            if fd < 0 {
                if errno == EINTR { continue }
                return
            }
            lock.lock()
            serial += 1
            let id = serial
            connections[id] = "unknown"
            lastBusy = now()
            lock.unlock()
            let thread = Thread { [weak self] in self?.serve(fd: fd, client: id) }
            thread.name = "workspace-daemon-client-\(id)"
            thread.start()
        }
    }

    private func serve(fd: Int32, client: ClientID) {
        let channel = LineChannel(fd: fd)
        let group = DispatchGroup()
        while let request = channel.readObject() {
            group.enter()
            DispatchQueue.global().async { [weak self] in
                defer { group.leave() }
                guard let self else { return }
                var reply = self.handle(request, client: client)
                reply["id"] = request["id"] ?? NSNull()
                channel.write(reply)
                if (request["op"] as? String) == "stop", reply["ok"] as? Bool == true {
                    DispatchQueue.main.async { self.shutdown("asked to stop") }
                }
            }
        }
        group.wait()
        channel.close()
        lock.lock()
        connections.removeValue(forKey: client)
        lastBusy = now()
        lock.unlock()
        manager.clientGone(client)
    }

    private func ok(_ fields: [String: Any] = [:]) -> [String: Any] {
        var reply = fields
        reply["ok"] = true
        return reply
    }

    private func refuse(_ error: WorkspaceError) -> [String: Any] {
        ["ok": false, "code": error.code, "error": error.message]
    }

    func handle(_ request: [String: Any], client: ClientID) -> [String: Any] {
        do {
            switch request["op"] as? String {
            case "hello":
                lock.lock()
                connections[client] = request["role"] as? String ?? "unknown"
                lock.unlock()
                return ok(["instanceID": manager.instanceID, "pid": Int(getpid())])
            case "tool":
                let name = try Arguments.string(request, "name")
                let arguments = request["arguments"] as? [String: Any] ?? [:]
                return ok(["result": workspace.call(name, arguments, client: client)])
            case "renew":
                manager.renew(client)
                return ok()
            case "status":
                return ok(["instanceID": manager.instanceID, "pid": Int(getpid()), "executableHash": identity,
                           "session": manager.summary() ?? NSNull()])
            case "operator_list":
                return ok(["sessions": operatorSessions()])
            case "display":
                guard let live = manager.live else { throw WorkspaceError("unknown_session", "there is no workspace session") }
                let bounds = live.display.bounds
                return ok(["displayID": Int(live.record.displayID), "x": bounds.minX, "y": bounds.minY,
                           "width": bounds.width, "height": bounds.height, "inputPaused": live.record.inputPaused,
                           "pauseReason": live.record.pauseReason ?? NSNull()])
            case "pause":
                try manager.setPaused(true, reason: request["reason"] as? String ?? "operator")
                return ok()
            case "resume":
                try manager.setPaused(false, reason: nil)
                return ok()
            case "operator_input":
                try workspace.operatorInput(request)
                return ok()
            case "stop":
                if let live = manager.live, live.holder != nil, live.holder != client, request["force"] as? Bool != true {
                    throw WorkspaceError("session_busy", "session '\(live.record.id)' is in use by a client; stop that client first, or pass --force to end the session anyway")
                }
                return ok()
            default:
                throw WorkspaceError("bad_request", "unknown request")
            }
        } catch let error as WorkspaceError {
            return refuse(error)
        } catch {
            return refuse(WorkspaceError("internal", "\(error)"))
        }
    }

    /// `session list --operator --json`: the session with its apps and their windows.
    func operatorSessions() -> [[String: Any]] {
        guard let live = manager.live else { return [] }
        let record = live.record
        let stage = live.stage
        let attached = manager.displays.online().contains(record.displayID)
        let windows = simulated ? [] : Windows.list(pids: Set(record.apps.map(\.pid))).filter { $0.layer == 0 }
        return [[
            "id": record.id, "title": record.title, "displayID": Int(record.displayID), "width": record.width,
            "height": record.height, "runtimeAttached": attached, "held": live.holder != nil,
            "inputPaused": record.inputPaused, "pauseReason": record.pauseReason ?? NSNull(),
            "apps": record.apps.map { ["name": $0.name, "bundleID": $0.bundleID, "pid": Int($0.pid), "managedBrowser": $0.managedBrowser] },
            "windows": windows.map { ["pid": Int($0.pid), "windowID": Int($0.windowID), "title": $0.title, "onStage": stage.holds($0.bounds)] },
        ]]
    }

    private func housekeeping() {
        manager.tick()
        if let live = manager.live, !simulated {
            manager.pruneApps(alive: Apps.alive)
            Apps.herd(live.record.apps.map(\.pid), onto: live.stage)
        }
        lock.lock()
        let busy = !connections.isEmpty || manager.live != nil
        if busy { lastBusy = now() }
        let idle = now() - lastBusy
        lock.unlock()
        if idle > DaemonServer.idleExit {
            DispatchQueue.main.async { self.shutdown("idle") }
        }
    }

    /// Workspace apps sometimes bring themselves to the front when they get a click. When one does,
    /// the user's own app goes back in front. (macOS may decline; the audit reports it if so.)
    private func watchFocus() {
        NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification,
                                                          object: nil, queue: .main) { [weak self] note in
            guard let self, let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
            guard let live = self.manager.live, live.record.apps.contains(where: { $0.pid == app.processIdentifier }) else {
                self.lastUserApp = app
                return
            }
            if live.record.inputPaused && live.record.pauseReason == "operator" { return }
            if let previous = self.lastUserApp, !previous.isTerminated { previous.activate() }
        }
    }

    func shutdown(_ reason: String) {
        manager.end("the engine stopped (\(reason))")
        if listener >= 0 { close(listener) }
        unlink(socketPath)
        try? FileManager.default.removeItem(at: infoURL)
        exit(0)
    }
}
