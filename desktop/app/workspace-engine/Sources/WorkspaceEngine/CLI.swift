// The `workspace-engine` command line. Hive runs `mcp` (through its bridge), `doctor --json`,
// `session list --operator --json`, `daemon stop` and `safety clear-host-health --operator`.
// Only `mcp` ever starts the background process; the others only look at it or stop it.
import ApplicationServices
import CoreGraphics
import Foundation
import WorkspaceCore
import WorkspaceDisplay

public enum CLI {
    static let usage = """
    usage: workspace-engine mcp
           workspace-engine doctor [--json]
           workspace-engine session list [--operator] [--json]
           workspace-engine daemon stop [--force]
           workspace-engine safety clear-host-health --operator
           workspace-engine safety clear --operator
           workspace-engine version
    """

    public static func main(_ arguments: [String], state: URL = Paths.stateDir()) -> Int32 {
        let flags = Set(arguments.filter { $0.hasPrefix("--") })
        let words = arguments.filter { !$0.hasPrefix("--") }
        switch (words.first, words.dropFirst().first) {
        case ("mcp", nil):
            return MCPServer(link: SpawningLink(state: state)).run()
        case ("daemon", "run"):
            return Daemon.run(state: state)
        case ("daemon", "stop"):
            return stop(state: state, force: flags.contains("--force"))
        case ("session", "list"):
            return sessionList(state: state, json: flags.contains("--json"))
        case ("doctor", nil):
            let report = doctor(state: state)
            if flags.contains("--json") {
                print(JSONFile.string(report))
            } else {
                print(describe(report))
            }
            return 0
        case ("safety", "clear-host-health"), ("safety", "clear"):
            guard flags.contains("--operator") else {
                FileHandle.standardError.write(Data("This clears a safety block; run it as the operator with --operator.\n".utf8))
                return 2
            }
            return clearSafety(state: state, hostHealthOnly: words.dropFirst().first == "clear-host-health")
        case ("version", nil):
            print("workspace-engine \(Engine.version)")
            return 0
        default:
            FileHandle.standardError.write(Data((usage + "\n").utf8))
            return 2
        }
    }

    static func connect(_ state: URL) -> DaemonClient? {
        DaemonClient(path: Wire.socketPath(state: state), role: "cli")
    }

    static func fail(_ message: String) -> Int32 {
        FileHandle.standardError.write(Data((message + "\n").utf8))
        return 1
    }

    public static func doctor(state: URL) -> [String: Any] {
        let latch = SafetyLatch(state: state)
        var daemon: [String: Any] = ["running": false]
        var session: Any = NSNull()
        if let client = connect(state), let status = try? client.send("status", timeout: 10) {
            daemon = ["running": true, "instanceID": status["instanceID"] as? String ?? "", "pid": status["pid"] ?? NSNull(),
                      "matchesCLI": (status["executableHash"] as? String) == Engine.executableHash()]
            session = status["session"] ?? NSNull()
            client.close()
        }
        return [
            "ok": true,
            "engine": ["version": Engine.version, "executable": Engine.executablePath()],
            "virtualDisplaysAvailable": HiveVirtualDisplaysAvailable(),
            "permissions": ["accessibility": AXIsProcessTrusted(), "screenRecording": CGPreflightScreenCaptureAccess()],
            "displaySafety": latch.reason.map { ["state": "blocked", "reason": $0] } ?? ["state": "ready"],
            "displays": ["workspace": HiveWorkspaceDisplaysOnline().map { $0.intValue }],
            "daemon": daemon,
            "session": session,
        ]
    }

    static func describe(_ report: [String: Any]) -> String {
        let safety = report["displaySafety"] as? [String: Any] ?? [:]
        let daemon = report["daemon"] as? [String: Any] ?? [:]
        let permissions = report["permissions"] as? [String: Any] ?? [:]
        let displays = (report["displays"] as? [String: Any])?["workspace"] as? [Int] ?? []
        var lines = [
            "Virtual displays: \((report["virtualDisplaysAvailable"] as? Bool) == true ? "available" : "not available on this macOS")",
            "Display safety: \(safety["state"] as? String ?? "?")" + ((safety["reason"] as? String).map { " (\($0))" } ?? ""),
            "Workspace displays online: \(displays.isEmpty ? "none" : displays.map(String.init).joined(separator: ", "))",
            "Accessibility: \((permissions["accessibility"] as? Bool) == true ? "allowed" : "not allowed"); Screen Recording: \((permissions["screenRecording"] as? Bool) == true ? "allowed" : "not allowed")",
        ]
        if (daemon["running"] as? Bool) == true {
            lines.append("Background process: running (pid \(daemon["pid"] ?? "?"))" + ((daemon["matchesCLI"] as? Bool) == true ? "" : ", from a different build than this command"))
        } else {
            lines.append("Background process: not running")
        }
        if let session = report["session"] as? [String: Any] {
            lines.append("Session: '\(session["id"] ?? "")' on display \(session["displayID"] ?? "?")")
        }
        return lines.joined(separator: "\n")
    }

    static func sessionList(state: URL, json: Bool) -> Int32 {
        var sessions: [[String: Any]] = []
        if let client = connect(state) {
            defer { client.close() }
            do {
                sessions = (try client.send("operator_list", timeout: 10))["sessions"] as? [[String: Any]] ?? []
            } catch {
                if json { print(JSONFile.string(["ok": false, "error": "\(error)"])) } else { _ = fail("\(error)") }
                return 1
            }
        }
        if json {
            print(JSONFile.string(["ok": true, "sessions": sessions]))
            return 0
        }
        let views = sessions.map { session in
            SessionView(id: session["id"] as? String ?? "", title: session["title"] as? String ?? "",
                        displayID: UInt32(session["displayID"] as? Int ?? 0), width: session["width"] as? Int ?? 0,
                        height: session["height"] as? Int ?? 0, yours: false,
                        inputPaused: session["inputPaused"] as? Bool ?? false, pauseReason: session["pauseReason"] as? String,
                        apps: (session["apps"] as? [[String: Any]] ?? []).map {
                            SessionApp(name: $0["name"] as? String ?? "", bundleID: $0["bundleID"] as? String ?? "",
                                       pid: Int32($0["pid"] as? Int ?? 0), managedBrowser: $0["managedBrowser"] as? Bool ?? false)
                        },
                        idleSeconds: 0, orphanGraceSeconds: 0, ttlSeconds: 0, held: session["held"] as? Bool ?? false)
        }
        print(Reports.listing(views))
        return 0
    }

    static func stop(state: URL, force: Bool) -> Int32 {
        guard let client = connect(state) else {
            print("The workspace engine's background process isn't running.")
            return 0
        }
        do {
            try client.send("stop", ["force": force], timeout: 15)
        } catch {
            client.close()
            return fail("\(error)")
        }
        client.close()
        let path = Wire.socketPath(state: state)
        let deadline = Date().addingTimeInterval(20)
        while Date() < deadline {
            guard let fd = Wire.connect(path) else {
                print("Stopped the workspace engine's background process.")
                return 0
            }
            close(fd)
            usleep(100_000)
        }
        return fail("The background process didn't stop within 20 seconds.")
    }

    static func clearSafety(state: URL, hostHealthOnly: Bool) -> Int32 {
        let latch = SafetyLatch(state: state)
        guard let reason = latch.reason else {
            print("Display safety isn't blocked.")
            return 0
        }
        if hostHealthOnly && !reason.hasPrefix("host health:") {
            return fail("The block isn't about host health (\(reason)). Check the display, then run `workspace-engine safety clear --operator`.")
        }
        if !HiveWorkspaceDisplaysOnline().isEmpty {
            return fail("A workspace display is still online; the block stays until it's gone.")
        }
        if let client = connect(state) {
            let status = try? client.send("status", timeout: 10)
            client.close()
            if status?["session"] is [String: Any] {
                return fail("The engine's background process still has a session; stop it first (workspace-engine daemon stop).")
            }
        }
        if hostHealthOnly, let problem = HostHealth.problem() {
            return fail("The Mac is still unhealthy (\(problem)); the block stays.")
        }
        latch.clear()
        print("Cleared the display safety block (\(reason)).")
        return 0
    }
}
