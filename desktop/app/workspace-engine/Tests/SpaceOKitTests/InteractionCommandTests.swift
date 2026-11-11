import XCTest
import CoreGraphics
@testable import SpaceOKit
@testable import SpaceOMCP

/// The interaction round's daemon and tool surface — `menu`, `session_resumed`, label matching
/// fields — driven through `SessionManager.handle` and the MCP translator against a fake display.
final class InteractionCommandTests: XCTestCase {

    private final class Backing: StageDisplayBacking, @unchecked Sendable {
        let displayID: CGDirectDisplayID
        let bounds = CGRect(x: 0, y: 0, width: 1_280, height: 800)
        private let lock = NSLock()
        private var attached = true
        init(displayID: CGDirectDisplayID) { self.displayID = displayID }
        var valid: Bool { lock.withLock { attached } }
        func invalidate() { lock.withLock { attached = false } }
        var isAttached: Bool { lock.withLock { attached } }
    }

    /// Time moves only when a wait sleeps, so a paused-session wait times out instantly.
    private final class Clock: @unchecked Sendable {
        private let lock = NSLock()
        private var time = Date(timeIntervalSince1970: 1_000)
        var runtime: WaitRuntime {
            WaitRuntime(now: { self.lock.withLock { self.time } },
                        sleep: { duration in self.lock.withLock { self.time = self.time.addingTimeInterval(duration) } })
        }
    }

    override func setUp() {
        super.setUp()
        ProcessOwnership.reset()
        AgentActivity.reset()
    }

    override func tearDown() {
        ProcessOwnership.reset()
        AgentActivity.reset()
        super.tearDown()
    }

    private func makeManager(displayID: CGDirectDisplayID, runtime: WaitRuntime = .live) -> SessionManager {
        let backing = Backing(displayID: displayID)
        let stage = Stage(testingBacking: backing, onlineDisplayIDs: { backing.isAttached ? [displayID] : [] })
        let pool = DisplayPool(sessionsPerDisplay: 2, displaySize: backing.bounds.size,
                               stageFactory: { _, _, _, _ in stage },
                               stageRetirer: { $0.invalidate(waitingForRemoval: 0) })
        return SessionManager(pool: pool, runJanitor: false, waitRuntime: runtime,
                              sessionFactory: { AgentSession(id: $0, slot: $1) })
    }

    private func create(_ manager: SessionManager, name: String) async {
        let response = await manager.handle(TestController.createRequest(session: name))
        XCTAssertTrue(response.ok, response.error ?? "")
    }

    private func control(_ manager: SessionManager, _ session: String, paused: Bool, note: String? = nil) async {
        var request = Request(cmd: "session.control")
        request.session = session
        request.paused = paused
        request.operatorScope = true
        request.handoffNote = note
        let response = await manager.handle(request)
        XCTAssertTrue(response.ok, response.error ?? "")
    }

    // MARK: - session_resumed

    func testSessionResumedWaitsOutAnOperatorPauseAndCarriesTheNote() async throws {
        let manager = makeManager(displayID: 97_401, runtime: Clock().runtime)
        await create(manager, name: "resume")
        await control(manager, "resume", paused: true)

        var wait = TestController.request("wait", session: "resume")
        wait.waitCondition = "session_resumed"
        wait.timeout = 1
        let whilePaused = await manager.handle(wait)
        XCTAssertTrue(whilePaused.ok, "waiting for the human is allowed while paused: \(whilePaused.error ?? "")")
        XCTAssertEqual(whilePaused.wait?.outcome, "timeout")

        await control(manager, "resume", paused: false, note: "entered the 2FA code")
        let resumed = await manager.handle(wait)
        XCTAssertTrue(resumed.ok, resumed.error ?? "")
        XCTAssertEqual(resumed.wait?.outcome, "met")
        XCTAssertEqual(resumed.wait?.handoffNote, "entered the 2FA code")
        XCTAssertTrue(resumed.message?.contains("operator note: entered the 2FA code") == true,
                      resumed.message ?? "")
        XCTAssertNotNil(resumed.handoff, "the structured hand-off is still delivered once")
        let again = await manager.handle(wait)
        XCTAssertEqual(again.wait?.outcome, "met")
        XCTAssertNil(again.wait?.handoffNote, "the note was consumed by the first delivery")
    }

    func testSessionResumedTakesNoValueAndMatchOnlyRefinesElementConditions() async throws {
        XCTAssertEqual(try WaitCondition.parse(kind: "session_resumed", value: nil), .sessionResumed)
        XCTAssertEqual(try WaitCondition.parse(kind: "session_resumed", value: ""), .sessionResumed)
        XCTAssertThrowsError(try WaitCondition.parse(kind: "session_resumed", value: "x"))
        XCTAssertTrue(WaitCondition.knownKinds.contains("session_resumed"))

        let manager = makeManager(displayID: 97_402, runtime: Clock().runtime)
        await create(manager, name: "match")
        var ms = TestController.request("wait", session: "match")
        ms.waitCondition = "ms"; ms.waitValue = "1"; ms.match = "contains"
        let refused = await manager.handle(ms)
        XCTAssertEqual(refused.errorCode, "bad_request")
        var label = TestController.request("wait", session: "match")
        label.waitCondition = "element_label"; label.waitValue = "Name"; label.match = "fuzzy"
        let badMode = await manager.handle(label)
        XCTAssertEqual(badMode.errorCode, "bad_request")
        XCTAssertTrue(badMode.error?.contains("exact or contains") == true, badMode.error ?? "")
    }

    func testWaitReceiptCarriesMatchedWindowAndNoteThroughTheLoop() async throws {
        struct Evaluator: WaitEvaluating {
            func probe(_ condition: WaitCondition) async throws -> WaitProbeResult {
                .met(WaitProbe(matchedTitle: "Report.pdf", matchedWindowID: 4_242, handoffNote: nil))
            }
        }
        let receipt = try await WaitLoop.run(
            .windowTitleContains("Report"), policy: WaitPolicy(deadline: 1), evaluator: Evaluator(),
            now: { Date(timeIntervalSince1970: 0) }, sleep: { _ in })
        XCTAssertEqual(receipt.matchedWindowID, 4_242)
        XCTAssertEqual(receipt.matchedTitle, "Report.pdf")
    }

    // MARK: - menu

    func testMenuIsLeaseScopedAndAuthorisesBeforeValidatingArguments() async throws {
        XCTAssertTrue(DaemonCommand.ownerScopedMutations.contains("menu"))
        let manager = makeManager(displayID: 97_403)
        await create(manager, name: "menus")
        for press in [false, true] {
            var foreign = Request(cmd: "menu")
            foreign.session = "menus"
            foreign.controllerLeaseID = UUID()
            foreign.press = press
            foreign.menuPath = Array(repeating: "x", count: 9)
            let refused = await manager.handle(foreign)
            XCTAssertFalse(refused.ok)
            XCTAssertTrue(refused.error?.contains("lease") == true,
                          "a foreign client learns only that a lease is required: \(refused.error ?? "")")
        }
        var owned = TestController.request("menu", session: "menus")
        owned.menuPath = Array(repeating: "x", count: 9)
        let invalid = await manager.handle(owned)
        XCTAssertEqual(invalid.errorCode, "bad_request")
        XCTAssertTrue(invalid.error?.contains("limit is 6") == true, invalid.error ?? "")

        var foreignPid = TestController.request("menu", session: "menus")
        foreignPid.pid = 1
        let notOurs = await manager.handle(foreignPid)
        XCTAssertEqual(notOurs.errorCode, "bad_request")
        XCTAssertTrue(notOurs.error?.contains("in this session") == true, notOurs.error ?? "")
    }

    func testMenuPressHonoursAPause() async throws {
        let manager = makeManager(displayID: 97_404)
        await create(manager, name: "paused-menu")
        await control(manager, "paused-menu", paused: true)
        var press = TestController.request("menu", session: "paused-menu")
        press.menuPath = ["File", "New"]
        press.press = true
        let refused = await manager.handle(press)
        XCTAssertEqual(refused.errorCode, "session_paused")
    }

    // MARK: - Tool and CLI surface

    func testMenuToolTranslatesAndValidates() throws {
        let request = try MCPServer.toolRequest(
            name: "spaceo_menu", arguments: ["path": ["File", "Export as PDF…"], "press": true, "pid": 42])
        XCTAssertEqual(request.cmd, "menu")
        XCTAssertEqual(request.menuPath, ["File", "Export as PDF…"])
        XCTAssertEqual(request.press, true)
        XCTAssertEqual(request.pid, 42)
        XCTAssertNil(try MCPServer.toolRequest(name: "spaceo_menu", arguments: [:]).menuPath)
        for bad: [String: Any] in [
            ["press": true], ["path": Array(repeating: "x", count: 7)], ["path": [""]],
            ["path": "File"], ["pid": 0], ["path": [String(repeating: "x", count: 257)]],
        ] {
            XCTAssertThrowsError(try MCPServer.toolRequest(name: "spaceo_menu", arguments: bad), "\(bad)")
        }
        let schema = try XCTUnwrap(MCPServer.toolSchemas.first { $0["name"] as? String == "spaceo_menu" })
        XCTAssertLessThanOrEqual((schema["description"] as? String ?? "").count, 400)
    }

    func testWaitAndClickToolsCarryMatchAndRole() throws {
        let resumed = try MCPServer.toolRequest(name: "spaceo_wait_for", arguments: ["condition": "session_resumed"])
        XCTAssertEqual(resumed.waitCondition, "session_resumed")
        XCTAssertThrowsError(try MCPServer.toolRequest(name: "spaceo_wait_for", arguments: ["condition": "element_label"]))
        let label = try MCPServer.toolRequest(name: "spaceo_wait_for", arguments: [
            "condition": "element_label", "value": "Name", "match": "contains", "role": "TextField"])
        XCTAssertEqual(label.match, "contains")
        XCTAssertEqual(label.role, "TextField")
        XCTAssertThrowsError(try MCPServer.toolRequest(name: "spaceo_wait_for", arguments: [
            "condition": "element_label", "value": "Name", "match": "fuzzy"]))
        let click = try MCPServer.toolRequest(name: "spaceo_click", arguments: [
            "label": "Save", "match": "contains", "role": "Button"])
        XCTAssertEqual(click.match, "contains")
        XCTAssertEqual(click.role, "Button")
        XCTAssertThrowsError(try MCPServer.toolRequest(name: "spaceo_click", arguments: ["element": "3", "match": "exact"]))
    }

    func testCLISpecAcceptsMenuAndMatchFlags() {
        XCTAssertEqual(CLISpec.allowedFlags["menu"]?.isSuperset(of: ["press", "pid", "session", "lease"]), true)
        XCTAssertTrue(CLISpec.booleanFlags.contains("press"))
        XCTAssertTrue(CLISpec.valueFlags.contains("match"))
        XCTAssertEqual(CLISpec.allowedFlags["wait"]?.isSuperset(of: ["match", "role"]), true)
        XCTAssertEqual(CLISpec.allowedFlags["click"]?.isSuperset(of: ["match", "role"]), true)
    }
}
