// The engine's real processes on a stand-in display (HIVE_WORKSPACE_TEST_DISPLAY=1): `mcp` starts
// the daemon, the daemon keeps the session when `mcp` goes away, a new `mcp` claims it, and the
// command line sees and stops it. Nothing is shown and no display is made.
import Foundation
import XCTest

final class ProcessTests: XCTestCase {
    var state: URL!
    var engine: URL!

    override func setUpWithError() throws {
        // The test bundle sits next to the products it was built with.
        engine = Bundle(for: ProcessTests.self).bundleURL.deletingLastPathComponent().appendingPathComponent("workspace-engine")
        try XCTSkipUnless(FileManager.default.isExecutableFile(atPath: engine.path), "build the workspace-engine product first")
        state = URL(fileURLWithPath: "/tmp/hws-\(UUID().uuidString.prefix(8))", isDirectory: true)
        try FileManager.default.createDirectory(at: state, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        _ = run(["daemon", "stop", "--force"])
        if let info = try? JSONSerialization.jsonObject(with: Data(contentsOf: state.appendingPathComponent("workspace-engine/daemon.json"))) as? [String: Any],
           let pid = info["pid"] as? Int32 {
            kill(pid, SIGKILL)
        }
        try? FileManager.default.removeItem(at: state)
    }

    var environment: [String: String] {
        var environment = ProcessInfo.processInfo.environment
        environment["AGENT_STATE_DIR"] = state.path
        environment["HIVE_WORKSPACE_TEST_DISPLAY"] = "1"
        return environment
    }

    @discardableResult
    func run(_ arguments: [String]) -> (Int32, String) {
        let process = Process()
        process.executableURL = engine
        process.arguments = arguments
        process.environment = environment
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        try? process.run()
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return (process.terminationStatus, String(decoding: data, as: UTF8.self))
    }

    func json(_ arguments: [String]) -> [String: Any] {
        (try? JSONSerialization.jsonObject(with: Data(run(arguments).1.utf8)) as? [String: Any]) ?? [:]
    }

    /// An `mcp` process to talk to.
    final class Client {
        let process = Process()
        let input = Pipe()
        let output = Pipe()
        var buffer = Data()
        var serial = 0

        init(engine: URL, environment: [String: String]) throws {
            process.executableURL = engine
            process.arguments = ["mcp"]
            process.environment = environment
            process.standardInput = input
            process.standardOutput = output
            process.standardError = FileHandle.nullDevice
            try process.run()
            _ = request("initialize", ["protocolVersion": "2025-03-26", "capabilities": [:] as [String: Any],
                                       "clientInfo": ["name": "test", "version": "1"]])
            send(["jsonrpc": "2.0", "method": "notifications/initialized"])
        }

        func send(_ object: [String: Any]) {
            let data = try! JSONSerialization.data(withJSONObject: object)
            input.fileHandleForWriting.write(data + Data("\n".utf8))
        }

        func request(_ method: String, _ params: [String: Any]) -> [String: Any] {
            serial += 1
            let id = "t-\(serial)"
            send(["jsonrpc": "2.0", "id": id, "method": method, "params": params])
            while true {
                if let newline = buffer.firstIndex(of: 0x0A) {
                    let line = buffer[buffer.startIndex..<newline]
                    buffer.removeSubrange(buffer.startIndex...newline)
                    if let reply = try? JSONSerialization.jsonObject(with: line) as? [String: Any], reply["id"] as? String == id {
                        return reply["result"] as? [String: Any] ?? reply
                    }
                    continue
                }
                let chunk = output.fileHandleForReading.availableData
                if chunk.isEmpty { return [:] }
                buffer.append(chunk)
            }
        }

        func call(_ name: String, _ arguments: [String: Any] = [:]) -> (Bool, String) {
            let result = request("tools/call", ["name": name, "arguments": arguments])
            let text = (result["content"] as? [[String: Any]])?.compactMap { $0["text"] as? String }.joined(separator: " ") ?? ""
            return ((result["isError"] as? Bool) == true, text)
        }

        func quit() {
            try? input.fileHandleForWriting.close()
            process.waitUntilExit()
        }
    }

    func testTheSessionOutlivesItsClientAndIsClaimedAgain() throws {
        let doctor = json(["doctor", "--json"])
        XCTAssertEqual((doctor["displaySafety"] as? [String: Any])?["state"] as? String, "ready")
        XCTAssertEqual((doctor["daemon"] as? [String: Any])?["running"] as? Bool, false)

        let first = try Client(engine: engine, environment: environment)
        let tools = (first.request("tools/list", [:])["tools"] as? [[String: Any]])?.compactMap { $0["name"] as? String } ?? []
        XCTAssertTrue(tools.contains("workspace_verify_isolation"))
        let claim = first.call("workspace_session_claim", ["session": "personal-agent-workspace"])
        XCTAssertTrue(claim.0)
        XCTAssertTrue(claim.1.hasPrefix("[unknown_session] "), claim.1)
        let created = first.call("workspace_session_create", ["name": "personal-agent-workspace", "title": "Agent workspace",
                                                               "preset": "exclusive", "orphan_grace_seconds": 1800, "ttl_seconds": 3600])
        XCTAssertFalse(created.0, created.1)
        let listing = first.call("workspace_session_list").1
        XCTAssertNotNil(listing.range(of: #"^\[yours\] session 'personal-agent-workspace' on whole display \d+, 1440x900\n"#, options: .regularExpression), listing)
        XCTAssertTrue(first.call("workspace_events", ["session": "personal-agent-workspace"]).1.contains("workspace_session_create ok"))
        XCTAssertTrue(first.call("workspace_screenshot", ["session": "personal-agent-workspace"]).1.hasPrefix("[unsupported] "))

        let operatorView = json(["session", "list", "--operator", "--json"])
        XCTAssertEqual(operatorView["ok"] as? Bool, true)
        let session = (operatorView["sessions"] as? [[String: Any]])?.first
        XCTAssertEqual(session?["id"] as? String, "personal-agent-workspace")
        XCTAssertEqual(session?["runtimeAttached"] as? Bool, true)
        XCTAssertEqual(session?["inputPaused"] as? Bool, false)

        let running = json(["doctor", "--json"])["daemon"] as? [String: Any]
        XCTAssertEqual(running?["running"] as? Bool, true)
        XCTAssertEqual(running?["matchesCLI"] as? Bool, true)
        XCTAssertFalse((running?["instanceID"] as? String ?? "").isEmpty)

        // A held session isn't stopped without --force.
        XCTAssertEqual(run(["daemon", "stop"]).0, 1)

        first.quit()
        let second = try Client(engine: engine, environment: environment)
        var claimed = second.call("workspace_session_claim", ["session": "personal-agent-workspace"])
        let deadline = Date().addingTimeInterval(5)
        while claimed.0 && claimed.1.contains("only an abandoned session") && Date() < deadline {
            usleep(100_000)
            claimed = second.call("workspace_session_claim", ["session": "personal-agent-workspace"])
        }
        XCTAssertFalse(claimed.0, claimed.1)
        XCTAssertTrue(second.call("workspace_session_list").1.hasPrefix("[yours] "))
        second.quit()

        XCTAssertEqual(run(["daemon", "stop", "--force"]).0, 0)
        XCTAssertEqual((json(["doctor", "--json"])["daemon"] as? [String: Any])?["running"] as? Bool, false)
        XCTAssertEqual((json(["session", "list", "--operator", "--json"])["sessions"] as? [[String: Any]])?.count, 0)
    }

    func testClearingHostHealthRefusesOtherBlocks() throws {
        let latch = state.appendingPathComponent("workspace-engine/display-safety.json")
        try FileManager.default.createDirectory(at: latch.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(#"{"reason":"display: the display never came online"}"#.utf8).write(to: latch)
        XCTAssertEqual(run(["safety", "clear-host-health"]).0, 2)
        XCTAssertEqual(run(["safety", "clear-host-health", "--operator"]).0, 1)
        XCTAssertEqual((json(["doctor", "--json"])["displaySafety"] as? [String: Any])?["state"] as? String, "blocked")
        XCTAssertEqual(run(["safety", "clear", "--operator"]).0, 0)
        XCTAssertEqual((json(["doctor", "--json"])["displaySafety"] as? [String: Any])?["state"] as? String, "ready")
    }
}
