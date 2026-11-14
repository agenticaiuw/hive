import CoreGraphics
import Foundation
import XCTest
@testable import WorkspaceCore
@testable import WorkspaceEngine

final class FakeLink: DaemonLink {
    var calls: [(String, [String: Any])] = []
    let lock = NSLock()
    func tool(_ name: String, _ arguments: [String: Any]) throws -> [String: Any] {
        lock.lock()
        calls.append((name, arguments))
        lock.unlock()
        if name == "boom" { throw WorkspaceError("daemon_gone", "gone") }
        return MCP.text("ran \(name)")
    }
    func close() {}
}

final class ProtocolTests: XCTestCase {
    func server() -> (MCPServer, () -> [[String: Any]]) {
        let server = MCPServer(link: FakeLink())
        let lock = NSLock()
        var lines: [String] = []
        server.write = { line in
            lock.lock()
            lines.append(line)
            lock.unlock()
        }
        return (server, {
            lock.lock()
            defer { lock.unlock() }
            return lines.compactMap { try? JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any] }
        })
    }

    func wait(_ replies: () -> [[String: Any]], count: Int) -> [[String: Any]] {
        let deadline = Date().addingTimeInterval(5)
        while replies().count < count && Date() < deadline { usleep(10_000) }
        return replies()
    }

    func testInitializeEchoesTheIdAndProtocolVersion() {
        let (server, replies) = server()
        server.handle(#"{"jsonrpc":"2.0","id":"agent-workspace-internal-1","method":"initialize","params":{"protocolVersion":"2025-03-26"}}"#)
        let reply = replies()[0]
        XCTAssertEqual(reply["id"] as? String, "agent-workspace-internal-1")
        XCTAssertEqual((reply["result"] as? [String: Any])?["protocolVersion"] as? String, "2025-03-26")
    }

    func testNotificationsGetNoReply() {
        let (server, replies) = server()
        server.handle(#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#)
        XCTAssertTrue(replies().isEmpty)
    }

    func testToolCallsGoToTheDaemonAndErrorsComeBackAsToolErrors() {
        let (server, replies) = server()
        server.handle(#"{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"workspace_session_list","arguments":{}}}"#)
        server.handle(#"{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"boom","arguments":{}}}"#)
        let all = wait(replies, count: 2)
        let byID = Dictionary(uniqueKeysWithValues: all.map { ($0["id"] as? Int ?? -1, $0["result"] as? [String: Any] ?? [:]) })
        XCTAssertEqual(((byID[7]?["content"] as? [[String: Any]])?.first?["text"]) as? String, "ran workspace_session_list")
        XCTAssertEqual(byID[8]?["isError"] as? Bool, true)
        XCTAssertEqual(((byID[8]?["content"] as? [[String: Any]])?.first?["text"]) as? String, "[daemon_gone] gone")
    }

    func testUnknownMethodsAreProtocolErrors() {
        let (server, replies) = server()
        server.handle(#"{"jsonrpc":"2.0","id":3,"method":"resources/list"}"#)
        XCTAssertEqual((replies()[0]["error"] as? [String: Any])?["code"] as? Int, -32601)
    }

    /// Every tool Hive's bridge lets the agent use (bridge.rs ALLOWED_TOOLS; it adds
    /// workspace_authenticate_passwords itself), and the ones the bridge calls on its own.
    func testTheCatalogHasWhatHiveUses() {
        let names = Set(Catalog.names)
        for name in ["workspace_session_list", "workspace_launch_app", "workspace_visit_url", "workspace_wait_for",
                     "workspace_find", "workspace_read_text", "workspace_read_screen", "workspace_list_targets",
                     "workspace_attach_target", "workspace_screenshot", "workspace_click", "workspace_scroll",
                     "workspace_select_text", "workspace_move", "workspace_drag", "workspace_type",
                     "workspace_press_key", "workspace_list_windows", "workspace_events",
                     "workspace_session_claim", "workspace_session_create", "workspace_verify_isolation"] {
            XCTAssertTrue(names.contains(name), name)
        }
        XCTAssertFalse(names.contains("workspace_authenticate_passwords"))
        for tool in Catalog.tools {
            XCTAssertTrue(JSONSerialization.isValidJSONObject(tool))
            XCTAssertNotNil((tool["inputSchema"] as? [String: Any])?["type"])
        }
    }

    func testIsolationTextMatchesWhatHiveParses() throws {
        let checks = [IsolationCheck("menu_bar_owner", .passed, .observed, "x"),
                      IsolationCheck("active_space", .passed, .inferred, "y")]
        let text = Reports.isolation(checks)
        XCTAssertTrue(text.hasPrefix("Isolation: partial\n"))
        let row = try NSRegularExpression(pattern: #"(?im)^\s*-\s*active_space:\s*(passed|failed|unknown)\s*\[(observed|inferred|unknown)\]"#)
        XCTAssertEqual(row.numberOfMatches(in: text, range: NSRange(text.startIndex..., in: text)), 1)
        XCTAssertEqual(Reports.verdict([IsolationCheck("a", .passed, .observed, "")]), "intact")
        XCTAssertEqual(Reports.verdict(checks + [IsolationCheck("b", .failed, .observed, "")]), "breached")
    }

    func testChords() throws {
        let (code, flags) = try Input.chord("shift+cmd+t")
        XCTAssertEqual(code, 17)
        XCTAssertEqual(flags, [.maskShift, .maskCommand])
        XCTAssertEqual(try Input.chord("Return").0, 36)
        XCTAssertThrowsError(try Input.chord("hyper+x"))
        XCTAssertThrowsError(try Input.chord("cmd+"))
    }

    func testStageCoordinates() throws {
        let stage = Stage(bounds: CGRect(x: 3000, y: 2000, width: 1440, height: 900))
        XCTAssertEqual(try stage.global(10, 20), CGPoint(x: 3010, y: 2020))
        XCTAssertThrowsError(try stage.global(1440, 0))
        XCTAssertThrowsError(try stage.global(-1, 0))
        XCTAssertTrue(stage.holds(CGRect(x: 3100, y: 2100, width: 400, height: 300)))
        XCTAssertFalse(stage.holds(CGRect(x: 0, y: 0, width: 400, height: 300)))
        let slot = stage.slot(0, size: CGSize(width: 5000, height: 5000))
        XCTAssertTrue(stage.bounds.contains(slot))
    }

    func testSocketPathsFitAndDifferPerStateFolder() {
        let long = URL(fileURLWithPath: "/" + String(repeating: "x", count: 120), isDirectory: true)
        let path = Wire.socketPath(state: long, environment: [:])
        XCTAssertLessThan(path.utf8.count, 104)
        XCTAssertNotEqual(path, Wire.socketPath(state: URL(fileURLWithPath: "/" + String(repeating: "y", count: 120)), environment: [:]))
    }
}
