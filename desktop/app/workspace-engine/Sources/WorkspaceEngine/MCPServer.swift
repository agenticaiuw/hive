// `workspace-engine mcp`: the MCP server Hive's bridge talks to over stdio (JSON-RPC, one message
// per line). It answers initialize and tools/list itself and passes tool calls to the daemon,
// starting the daemon when none is running. Its connection to the daemon is the session's holder:
// when this process ends, the session waits to be claimed.
import Darwin
import Foundation
import WorkspaceCore

public protocol DaemonLink: AnyObject {
    func tool(_ name: String, _ arguments: [String: Any]) throws -> [String: Any]
    func close()
}

public final class MCPServer {
    let link: DaemonLink
    private let output = NSLock()
    private let calls = DispatchGroup()
    /// Where replies go; stdout unless a test catches them.
    var write: (String) -> Void = { line in
        FileHandle.standardOutput.write(Data((line + "\n").utf8))
    }

    public init(link: DaemonLink) {
        self.link = link
    }

    public func run() -> Int32 {
        while let line = readLine(strippingNewline: true) {
            handle(line)
        }
        calls.wait()
        link.close()
        return 0
    }

    func send(_ object: [String: Any]) {
        guard JSONSerialization.isValidJSONObject(object),
              let data = try? JSONSerialization.data(withJSONObject: object) else { return }
        output.lock()
        write(String(decoding: data, as: UTF8.self))
        output.unlock()
    }

    func reply(_ id: Any, result: [String: Any]) {
        send(["jsonrpc": "2.0", "id": id, "result": result])
    }

    func handle(_ line: String) {
        guard let message = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any] else {
            send(["jsonrpc": "2.0", "id": NSNull(), "error": ["code": -32700, "message": "parse error"]])
            return
        }
        let id = message["id"]
        let params = message["params"] as? [String: Any] ?? [:]
        switch message["method"] as? String {
        case "initialize":
            guard let id else { return }
            reply(id, result: ["protocolVersion": params["protocolVersion"] as? String ?? "2025-03-26",
                               "capabilities": ["tools": [String: Any]()],
                               "serverInfo": ["name": "hive-workspace-engine", "version": Engine.version]])
        case "ping":
            if let id { reply(id, result: [:]) }
        case "tools/list":
            if let id { reply(id, result: ["tools": Catalog.tools]) }
        case "tools/call":
            guard let id else { return }
            let name = params["name"] as? String ?? ""
            let arguments = params["arguments"] as? [String: Any] ?? [:]
            calls.enter()
            DispatchQueue.global().async { [self] in
                defer { calls.leave() }
                let result: [String: Any]
                do {
                    result = try link.tool(name, arguments)
                } catch let error as WorkspaceError {
                    result = MCP.failure(error)
                } catch {
                    result = MCP.failure(WorkspaceError("internal", "\(error)"))
                }
                reply(id, result: result)
            }
        case let method?:
            if let id, !method.hasPrefix("notifications/") {
                send(["jsonrpc": "2.0", "id": id, "error": ["code": -32601, "message": "method not found: \(method)"]])
            }
        case nil:
            break
        }
    }
}

/// The link to the daemon, which it starts if it isn't running and renews the lease on.
public final class SpawningLink: DaemonLink {
    let state: URL
    let path: String
    private let lock = NSLock()
    private var client: DaemonClient?
    private var closed = false

    public init(state: URL) {
        self.state = state
        path = Wire.socketPath(state: state)
        let renew = Thread { [weak self] in
            while let self, !self.isClosed {
                sleep(30)
                if let client = self.current() { _ = try? client.send("renew", timeout: 10) }
            }
        }
        renew.name = "workspace-lease-renewal"
        renew.start()
    }

    var isClosed: Bool {
        lock.lock()
        defer { lock.unlock() }
        return closed
    }

    func current() -> DaemonClient? {
        lock.lock()
        defer { lock.unlock() }
        return client?.isOpen == true ? client : nil
    }

    func connection() throws -> DaemonClient {
        lock.lock()
        defer { lock.unlock() }
        if let client, client.isOpen { return client }
        if let made = DaemonClient(path: path, role: "mcp") {
            client = made
            return made
        }
        try SpawningLink.spawnDaemon(state: state)
        let deadline = Date().addingTimeInterval(10)
        while Date() < deadline {
            usleep(100_000)
            if let made = DaemonClient(path: path, role: "mcp") {
                client = made
                return made
            }
        }
        throw WorkspaceError("daemon_unavailable", "the workspace engine's background process didn't start (see workspace-engine/daemon.log in Hive's state folder)")
    }

    public func tool(_ name: String, _ arguments: [String: Any]) throws -> [String: Any] {
        let reply = try connection().send("tool", ["name": name, "arguments": arguments], timeout: 60)
        guard let result = reply["result"] as? [String: Any] else {
            throw WorkspaceError("internal", "the background process gave no result")
        }
        return result
    }

    public func close() {
        lock.lock()
        closed = true
        let client = self.client
        self.client = nil
        lock.unlock()
        client?.close()
    }

    /// Starts `workspace-engine daemon run` in a session of its own, so it outlives this process.
    static func spawnDaemon(state: URL) throws {
        let executable = Engine.executablePath()
        let directory = Paths.engineDir(state: state)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let log = directory.appendingPathComponent("daemon.log").path
        if let size = (try? FileManager.default.attributesOfItem(atPath: log))?[.size] as? Int, size > 1_000_000 {
            try? FileManager.default.removeItem(atPath: log)
        }
        var attributes: posix_spawnattr_t?
        posix_spawnattr_init(&attributes)
        defer { posix_spawnattr_destroy(&attributes) }
        posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_SETSID))
        var actions: posix_spawn_file_actions_t?
        posix_spawn_file_actions_init(&actions)
        defer { posix_spawn_file_actions_destroy(&actions) }
        posix_spawn_file_actions_addopen(&actions, 0, "/dev/null", O_RDONLY, 0)
        posix_spawn_file_actions_addopen(&actions, 1, log, O_WRONLY | O_CREAT | O_APPEND, 0o600)
        posix_spawn_file_actions_adddup2(&actions, 1, 2)
        var environment = ProcessInfo.processInfo.environment
        environment["AGENT_STATE_DIR"] = state.path
        let words: [String] = [executable, "daemon", "run"]
        let arguments: [UnsafeMutablePointer<CChar>?] = words.map { strdup($0) } + [nil]
        let variables: [UnsafeMutablePointer<CChar>?] = environment.map { strdup("\($0.key)=\($0.value)") } + [nil]
        defer {
            arguments.forEach { free($0) }
            variables.forEach { free($0) }
        }
        var pid: pid_t = 0
        let result = posix_spawn(&pid, executable, &actions, &attributes, arguments, variables)
        guard result == 0 else {
            throw WorkspaceError("daemon_unavailable", "couldn't start the background process: \(String(cString: strerror(result)))")
        }
        // Reap it if it ends while this process lives.
        Thread.detachNewThread { var status: Int32 = 0; waitpid(pid, &status, 0) }
    }
}
