import XCTest
import CoreGraphics
@testable import SpaceOKit
@testable import SpaceOMCP

/// What an LLM agent pays for on every call: the tool catalogue and each receipt. These pin the
/// compact defaults, the verbose escape hatch, and the per-connection state that lets receipts
/// say only what changed. Pure logic only — no socket, WindowServer, or daemon.
final class MCPCompactReceiptTests: XCTestCase {

    // MARK: Fixtures

    private static let dimensions: [IsolationDimension] = IsolationDimension.allCases

    private func intactReport() -> IsolationReport {
        IsolationReport(checks: Self.dimensions.map {
            IsolationCheckReport(dimension: $0, coverage: .observed, status: .passed,
                                 evidence: "synthetic observation of \($0.rawValue) that stayed put")
        })
    }

    private func partialReport() -> IsolationReport {
        IsolationReport(checks: Self.dimensions.map {
            $0 == .keyInputRoute
                ? IsolationCheckReport(dimension: $0, coverage: .unknown, status: .unknown,
                                       evidence: "Accessibility focused-application proxy was unavailable")
                : IsolationCheckReport(dimension: $0, coverage: .observed, status: .passed,
                                       evidence: "passed \($0.rawValue)")
        })
    }

    /// A successful click the way the daemon returns it after `enrich`: readiness, geometry,
    /// per-window geometries, display target, action receipt and a full isolation report.
    private func dogfoodClick(outcome: String? = "confirmed") -> Response {
        var response = Response(ok: true)
        var readiness = ReadinessReport(applicationCount: 1, windowCount: 1, attached: true,
                                        paused: false, canDrive: true)
        readiness.visibility = "unknown"
        response.readiness = readiness
        let window = WindowRef(windowID: 42, pid: 900, title: "Untitled",
                               frame: CGRect(x: 1_552, y: 40, width: 1_360, height: 820))
        let geometry = GeometryReceipt(sessionGeneration: UUID(), displayID: 7,
                                       displayBounds: CGRect(x: 1_512, y: 0, width: 1_440, height: 900),
                                       window: window, process: nil, backingScale: 2)
        response.geometry = geometry
        response.geometries = [geometry]
        response.displayTarget = DisplayTargetReceipt(identity: UUID(), displayID: 7,
                                                      logicalBounds: CGRect(x: 1_512, y: 0, width: 1_440, height: 900),
                                                      backingScale: 2)
        var action = ActionReceipt(command: "click", windowID: 42, route: "accessibility-action",
                                   completion: "operation_completed_postcondition_not_asserted",
                                   requestedDuration: nil, elapsedSeconds: 0.04)
        action.outcome = outcome
        response.action = action
        response.isolation = intactReport()
        response.drift = response.isolation?.legacyDrift
        return response
    }

    // MARK: 1. Compact receipts

    func testIntactClickRendersUnder300BytesAndVerboseRestoresTheTable() {
        let response = dogfoodClick()
        let compact = MCPServer.render(response, context: MCPRenderContext(command: "click", session: "s1"))
        XCTAssertLessThanOrEqual(compact.utf8.count, 300, compact)
        XCTAssertTrue(compact.hasPrefix("click: confirmed (accessibility-action)"), compact)
        XCTAssertTrue(compact.contains("isolation: intact (6/6 checks covered)"), compact)
        XCTAssertFalse(compact.contains("readiness:"), "ready is the expected state; say nothing")
        XCTAssertFalse(compact.contains("geometry:"), "action receipts carry no token the agent passes back")
        XCTAssertFalse(compact.contains("displayTarget"), compact)
        XCTAssertFalse(compact.contains(response.geometry!.token))

        let verbose = MCPServer.render(response, context: MCPRenderContext(verbose: true, command: "click"))
        for dimension in Self.dimensions {
            XCTAssertTrue(verbose.contains("- \(dimension.rawValue): passed [observed]"), verbose)
        }
        XCTAssertTrue(verbose.contains("readiness: ready"), verbose)
        XCTAssertTrue(verbose.contains("geometry: \(response.geometry!.token)"), verbose)
        XCTAssertTrue(verbose.contains("displayTarget: "), verbose)
        XCTAssertTrue(verbose.contains("completion=operation_completed_postcondition_not_asserted"), verbose)
    }

    func testActionLineFallsBackToCompletionWithoutAnOutcome() {
        let text = MCPServer.render(dogfoodClick(outcome: nil), context: MCPRenderContext(command: "click"))
        XCTAssertTrue(text.hasPrefix("click: operation_completed_postcondition_not_asserted (accessibility-action)"), text)
    }

    func testPartialIsolationListsOnlyChecksThatDidNotPass() {
        let text = MCPServer.renderIsolation(partialReport())
        XCTAssertTrue(text.hasPrefix("isolation: partial — No disturbance"), text)
        XCTAssertTrue(text.contains("continue for reversible steps"), "the next step stays in the compact form")
        XCTAssertTrue(text.contains("- key_input_route: unknown [unknown]"), text)
        XCTAssertFalse(text.contains("menu_bar_owner"), "passed checks are omitted unless verbose")
        XCTAssertTrue(MCPServer.renderIsolation(partialReport(), verbose: true).contains("menu_bar_owner: passed"))
    }

    func testBreachAlwaysRendersTheFullTable() {
        let breached = IsolationReport(checks: Self.dimensions.map {
            $0 == .menuBarOwner
                ? IsolationCheckReport(dimension: $0, coverage: .observed, status: .failed,
                                       evidence: "menu bar moved", failures: ["agent app owns the menu bar"])
                : IsolationCheckReport(dimension: $0, coverage: .observed, status: .passed, evidence: "ok")
        })
        let text = MCPServer.renderIsolation(breached)
        XCTAssertTrue(text.hasPrefix("ISOLATION BREACH"), text)
        XCTAssertEqual(text.components(separatedBy: "\n- ").count - 1, Self.dimensions.count, text)
        XCTAssertTrue(text.contains("failure: agent app owns the menu bar"))
    }

    func testReadinessAppearsOnlyWhenBlocked() {
        var response = Response(ok: true)
        response.readiness = ReadinessReport(applicationCount: 1, windowCount: 0, attached: true,
                                             paused: false, canDrive: true)
        XCTAssertTrue(MCPServer.render(response, context: MCPRenderContext(command: "run")).contains("readiness: blocked"))
    }

    func testGeometryStaysOnObservationsTheAgentPassesItBackFrom() {
        var response = dogfoodClick()
        response.action = nil
        response.isolation = nil
        response.drift = nil
        response.snapshotID = "abc"
        let token = response.geometry!.token
        for command in ["ax", "ax.find", "windows", "screenshot"] {
            XCTAssertTrue(MCPServer.render(response, context: MCPRenderContext(command: command)).contains(token), command)
        }
        XCTAssertFalse(MCPServer.render(response, context: MCPRenderContext(command: "verify")).contains(token))
    }

    func testDisplayTargetIsShownOnlyWhenItChangesForThatSession() {
        let memory = MCPConnectionMemory(verbose: false)
        let first = DisplayTargetReceipt(identity: UUID(), displayID: 7,
                                         logicalBounds: CGRect(x: 0, y: 0, width: 100, height: 100), backingScale: 2)
        let moved = DisplayTargetReceipt(identity: first.identity, displayID: 7,
                                         logicalBounds: CGRect(x: 0, y: 0, width: 200, height: 100), backingScale: 2)
        XCTAssertFalse(memory.displayTargetChanged(session: "s1", target: first), "first sighting is silent")
        XCTAssertFalse(memory.displayTargetChanged(session: "s1", target: first))
        XCTAssertTrue(memory.displayTargetChanged(session: "s1", target: moved))
        XCTAssertFalse(memory.displayTargetChanged(session: "s2", target: moved), "tracked per session")

        var response = Response(ok: true)
        response.displayTarget = moved
        let text = MCPServer.render(response, context: MCPRenderContext(command: "click", displayTargetChanged: true))
        XCTAssertTrue(text.contains("displayTarget: ") && text.contains("CHANGED"), text)
    }

    func testDestroySummaryReplacesTheBareMessage() {
        var response = Response.success("destroyed 'x'")
        response.destroySummary = DestroySummary(
            reason: "owner", quitApps: ["TextEdit", "Calculator"], releasedApps: ["Safari"],
            durationSeconds: 252, actionCount: 37, recordingPath: "/tmp/rec")
        let text = MCPServer.render(response, context: MCPRenderContext(command: "session.destroy", session: "x"))
        XCTAssertEqual(text, "destroyed 'x' (owner): quit TextEdit, Calculator; released Safari; 4m12s, 37 actions; recording: /tmp/rec")
    }

    func testMenuListingsCarryMarkers() {
        var response = Response(ok: true)
        response.menu = [
            MenuItemInfo(title: "New", shortcut: "⌘N"),
            MenuItemInfo(title: "Open Recent", hasSubmenu: true),
            MenuItemInfo(title: "Revert", enabled: false),
            MenuItemInfo(title: "Show Ruler", checked: true),
        ]
        let text = MCPServer.render(response, context: MCPRenderContext(command: "menu", menuPath: ["File"]))
        XCTAssertTrue(text.contains("[File] New ⌘N"), text)
        XCTAssertTrue(text.contains("[File] Open Recent ▸"), text)
        XCTAssertTrue(text.contains("[File] Revert (disabled)"), text)
        XCTAssertTrue(text.contains("[File] ✓ Show Ruler"), text)
        response.menu = [MenuItemInfo(title: "File"), MenuItemInfo(title: "Edit")]
        XCTAssertTrue(MCPServer.render(response, context: MCPRenderContext(command: "menu")).contains("[File]\n[Edit]"))
    }

    /// Live dogfood printed every menu twice: once from `menu`, once from the daemon's outline.
    /// A press reported the whole sibling menu as well; it now reports only what it pressed.
    func testMenuItemsRenderOnceAndAPressOmitsItsSiblings() {
        var response = Response(ok: true)
        response.menu = [MenuItemInfo(title: "New", shortcut: "⌘N"), MenuItemInfo(title: "Open…", shortcut: "⌘O")]
        response.outline = "  New  ⌘N\n  Open…  ⌘O"
        response.message = "2 item(s) in File of pid 7"
        let listed = MCPServer.render(response, context: MCPRenderContext(command: "menu", menuPath: ["File"]))
        XCTAssertEqual(listed.components(separatedBy: "New").count - 1, 1, listed)

        response.message = "pressed File › New in pid 7 (⌘N)"
        let pressed = MCPServer.render(response, context: MCPRenderContext(
            command: "menu", menuPath: ["File", "New"], menuPressed: true))
        XCTAssertFalse(pressed.contains("Open…"), pressed)
        XCTAssertTrue(pressed.contains("pressed File › New"), pressed)
        let verbose = MCPServer.render(response, context: MCPRenderContext(
            verbose: true, command: "menu", menuPath: ["File", "New"], menuPressed: true))
        XCTAssertTrue(verbose.contains("[File] Open… ⌘O"), verbose)
    }

    func testWindowMarkersAndSessionListOwnership() throws {
        let window: [String: Any] = [
            "windowID": 42, "pid": 900, "title": "Save", "x": 0, "y": 0, "width": 10, "height": 10,
            "onStage": true, "spaces": [1], "focused": true, "modal": true, "defaultTarget": true,
        ]
        var response = Response(ok: true)
        response.windows = [try Wire.decoder.decode(WindowInfo.self, from: JSONSerialization.data(withJSONObject: window))]
        XCTAssertTrue(MCPServer.render(response).contains("\"Save\" [focused] [modal] [default]"))

        func session(_ id: String, redacted: Bool) throws -> SessionInfo {
            var object: [String: Any] = [
                "id": id, "displayID": 7, "x": 0, "y": 0, "width": 100, "height": 100,
                "tileIndex": 0, "tileCapacity": 2, "exclusiveDisplay": false, "spaces": [1],
                "hasOwnSpace": true, "apps": [], "windows": [], "createdAt": "2026-01-01T00:00:00Z",
                "teardownPending": false, "idleSeconds": 2_400, "orphanGraceSeconds": 300,
                "leaseExpiresAt": "2999-01-01T00:00:00Z",
                "exitedApps": [["name": "TextEdit", "pid": 4, "exitedAt": "2026-01-01T00:00:00Z",
                                "startedByUs": true, "status": "exited(0)"]],
            ]
            if redacted { object["redacted"] = true }
            return try Wire.decoder.decode(SessionInfo.self, from: JSONSerialization.data(withJSONObject: object))
        }
        var list = Response(ok: true)
        list.sessions = [try session("mine", redacted: false), try session("theirs", redacted: true)]
        let text = MCPServer.render(list, context: MCPRenderContext(command: "session.list", ownedSessions: ["mine"]))
        XCTAssertTrue(text.contains("[yours] session 'mine'"), text)
        XCTAssertFalse(text.contains("[yours] session 'theirs'"), text)
        XCTAssertTrue(text.contains("session 'theirs' on tile 1/2 of display 7, 100x100 at (0,0) [another controller; contents redacted]"), text)
        XCTAssertTrue(text.contains("idle 40m; lease expires in "), text)
        XCTAssertTrue(text.contains("orphan grace 5m"), text)
        XCTAssertTrue(text.contains("exited app TextEdit (pid 4, exited(0), "), text)

        // Live dogfood: after its client exited, the session read only "[another controller;
        // contents redacted]" — nothing said the new connection could take it back.
        var abandoned = try session("orphan", redacted: true)
        abandoned.abandoned = true
        abandoned.graceRemainingSeconds = 95
        var orphanList = Response(ok: true)
        orphanList.sessions = [abandoned]
        let orphanText = MCPServer.render(orphanList, context: MCPRenderContext(command: "session.list"))
        XCTAssertTrue(orphanText.contains("[abandoned: spaceo_session_claim within 1m35s keeps its apps]"), orphanText)
        XCTAssertFalse(orphanText.contains("lease expires"), "an abandoned lease can never renew")
    }

    // MARK: 2. Errors speak MCP

    /// Every constructible error and every prose `nextAction` the daemon can send.
    private func everyError() -> [SpaceOError] {
        [
            .applicationExited("x"), .windowNotReady("x"), .staleSnapshot("x"), .staleGeometry("x"),
            .isolationUnverified("x"), .isolationBreached("x"), .daemonStopping, .waitQueueTimeout("x"),
            .batchQueueTimeout("x"), .unavailable(capability: "x"), .accessibilityDenied,
            .screenRecordingDenied, .daemonDraining, .sessionPaused("x"), .leaseRequired("x"),
            .webTargetAmbiguous("x"), .stageCreationFailed("x"), .unknownSession("x"), .launchFailed("x"),
            .windowNotFound("x"), .unsupportedTarget("x"),
            .elementNotPressable(role: "AXStaticText", actions: []), .captureFailed("x"), .badRequest("x"),
        ]
    }

    private static let proseNextActions = [
        "spaceo doctor --json", "spaceo ax --help", "spaceo windows --help",
        "spaceo windows --timeout 10 --help", "spaceo verify --help", "spaceo session list --json",
        "spaceo daemon wait --help", "retry session create after `spaceo daemon wait`",
        "spaceo session list --json (inputPaused, operatorHandoff)", "spaceo session create --help",
        "spaceo targets --help", "spaceo daemon", "spaceo something-new --flag 3 --help",
        "retry after a short back-off; the daemon is serving its connection ceiling",
        "resolve_focus_or_placement_then_explicitly_resume", "wait_for_matching_window",
    ]

    private func assertSpeaksMCP(_ text: String, file: StaticString = #filePath, line: UInt = #line) {
        for rendered in text.split(separator: "\n") {
            XCTAssertFalse(rendered.hasPrefix("next action: spaceo "), text, file: file, line: line)
        }
        XCTAssertFalse(text.contains("--help"), text, file: file, line: line)
    }

    func testEveryFailureRendersWithoutCLISyntax() {
        var trace = Request(cmd: "click")
        trace.diagnosticTraceID = "trace-123"
        for error in everyError() {
            let response = Response.failure(error)
            let text = MCPServer.renderFailure(response, for: trace)
            assertSpeaksMCP(text)
            XCTAssertTrue(text.hasSuffix("trace: trace-123"), text)
            if response.recovery != nil {
                XCTAssertFalse(text.contains("next action:"), "recovery already names the tool: \(text)")
            }
        }
        for next in Self.proseNextActions {
            var response = Response(ok: false)
            response.error = "synthetic"
            response.nextAction = next
            assertSpeaksMCP(MCPServer.renderFailure(response))
        }
        var notRunning = Response.failure(Transport.TransportError.notRunning("/tmp/x"))
        notRunning.recovery = nil
        assertSpeaksMCP(MCPServer.renderFailure(notRunning))
    }

    func testNextActionTranslationNamesTools() {
        XCTAssertEqual(MCPPresentation.translateNextAction("spaceo windows --timeout 10 --help"),
                       "call spaceo_list_windows (timeout: 10)")
        XCTAssertEqual(MCPPresentation.translateNextAction("spaceo ax --help"), "call spaceo_read_screen")
        XCTAssertEqual(MCPPresentation.translateNextAction("spaceo session list --json (inputPaused, operatorHandoff)"),
                       "call spaceo_session_list (inputPaused, operatorHandoff)")
        XCTAssertEqual(MCPPresentation.translateNextAction("spaceo doctor --json"), "ask the user to run `spaceo doctor`")
        XCTAssertEqual(MCPPresentation.translateNextAction("spaceo verify --help"), "call spaceo_verify_isolation")
        XCTAssertEqual(MCPPresentation.translateNextAction("spaceo targets --help"), "call spaceo_list_targets")
        XCTAssertEqual(MCPPresentation.translateNextAction("wait_for_matching_window"), "wait_for_matching_window")
    }

    func testErrorBodyNamesToolsInsteadOfCLICommands() {
        let text = MCPServer.renderFailure(Response.failure(SpaceOError.elementNotPressable(role: "AXStaticText", actions: [])))
        XCTAssertTrue(text.contains("Read the screen again") && text.contains("spaceo_read_screen"), text)
        XCTAssertFalse(text.contains("`spaceo ax`"), text)
    }

    func testCapacityFailuresNameRetryAndHolders() {
        var response = Response(ok: false)
        response.errorCode = "resource_limit"
        response.error = "every tile is in use"
        response.retryAfterSeconds = 12
        response.holders = [
            PoolHolder(session: "agent-3", owner: "Claude Code", idleSeconds: 2_400, abandoned: true, reclaimableInSeconds: 20),
            PoolHolder(session: "agent-4"),
        ]
        let text = MCPServer.renderFailure(response)
        XCTAssertTrue(text.contains("retry after 12s; held by: agent-3 (Claude Code, idle 40m, abandoned — frees in 20s); agent-4"), text)
    }

    // MARK: 3. Implicit session

    private func context(holding sessions: [String]) throws -> MCPControllerContext {
        let context = MCPControllerContext(owner: DurableSessionOwner(id: "mcp-test", kind: .mcp, label: "SpaceO MCP"),
                                           memory: MCPConnectionMemory(verbose: false))
        for id in sessions {
            var create = Request(cmd: "session.create")
            create.session = id
            var response = Response(ok: true)
            response.session = try Wire.decoder.decode(SessionInfo.self, from: JSONSerialization.data(withJSONObject: [
                "id": id, "displayID": 7, "x": 0, "y": 0, "width": 100, "height": 100,
                "tileIndex": 0, "tileCapacity": 2, "exclusiveDisplay": false, "spaces": [1],
                "hasOwnSpace": true, "apps": [], "windows": [], "createdAt": "2026-01-01T00:00:00Z",
                "teardownPending": false,
            ] as [String: Any]))
            response.controllerLeaseID = UUID()
            context.record(response, for: create)
        }
        return context
    }

    func testOmittedSessionMeansTheOneThisConnectionHolds() throws {
        let context = try context(holding: ["mine"])
        let click = try context.prepare(MCPServer.toolRequest(name: "spaceo_click", arguments: ["element": "3"]))
        XCTAssertEqual(click.session, "mine", "another agent's session on the daemon must not make omission fail")
        XCTAssertEqual(click.controllerLeaseID, context.storedLease(for: "mine"))
        let read = try context.prepare(MCPServer.toolRequest(name: "spaceo_read_screen", arguments: [:]))
        XCTAssertEqual(read.session, "mine")
        let list = try context.prepare(MCPServer.toolRequest(name: "spaceo_session_list", arguments: [:]))
        XCTAssertNil(list.session, "inventory is not session-addressed")
    }

    func testOmittedSessionWithSeveralLeasesAsksForOne() throws {
        let context = try context(holding: ["b", "a"])
        XCTAssertThrowsError(try context.prepare(MCPServer.toolRequest(name: "spaceo_click", arguments: ["element": "3"]))) { error in
            XCTAssertEqual("\(error)", "this connection holds sessions a, b; pass session")
        }
        XCTAssertEqual(try context.prepare(MCPServer.toolRequest(name: "spaceo_click", arguments: ["element": "3", "session": "b"])).session, "b")
    }

    func testSessionArgumentDescriptionExplainsTheDefault() throws {
        let click = try XCTUnwrap(MCPServer.toolSchemas.first { $0["name"] as? String == "spaceo_click" })
        let properties = try XCTUnwrap((click["inputSchema"] as? [String: Any])?["properties"] as? [String: Any])
        let session = try XCTUnwrap(properties["session"] as? [String: Any])
        XCTAssertTrue((session["description"] as? String ?? "").contains("Omit to use the session this connection created"))
    }

    // MARK: 4. Argument forgiveness

    func testUnexpectedArgumentsListAcceptedAndSuggest() {
        XCTAssertThrowsError(try MCPServer.toolRequest(name: "spaceo_click", arguments: ["session_id": "s", "element": "3"])) { error in
            let text = "\(error)"
            XCTAssertTrue(text.hasPrefix("unexpected argument(s): session_id; accepted: "), text)
            XCTAssertTrue(text.contains("element, "), text)
            XCTAssertTrue(text.contains("did you mean 'session_id' → 'session'?"), text)
        }
        XCTAssertThrowsError(try MCPServer.toolRequest(name: "spaceo_type", arguments: ["txt": "hi"])) { error in
            XCTAssertTrue("\(error)".contains("'txt' → 'text'"), "\(error)")
        }
        XCTAssertThrowsError(try MCPServer.toolRequest(name: "spaceo_click", arguments: ["elementId": "3"])) { error in
            XCTAssertTrue("\(error)".contains("'elementId' → 'element'"), "\(error)")
        }
        XCTAssertThrowsError(try MCPServer.toolRequest(name: "spaceo_type", arguments: ["text_value": "hi"])) { error in
            XCTAssertTrue("\(error)".contains("'text_value' → 'text'"), "\(error)")
        }
        XCTAssertThrowsError(try MCPServer.toolRequest(name: "spaceo_session_list", arguments: ["x": 1])) { error in
            XCTAssertTrue("\(error)".contains("accepted: none"), "\(error)")
        }
        // Hidden compatibility fields are accepted but never advertised back.
        XCTAssertThrowsError(try MCPServer.toolRequest(name: "spaceo_session_create", arguments: ["nmae": "x"],
                                                        defaultControllerOwner: TestController.owner())) { error in
            XCTAssertFalse("\(error)".contains("controller_id"), "\(error)")
            XCTAssertTrue("\(error)".contains("'nmae' → 'name'"), "\(error)")
        }
    }

    func testForgivenessStaysBoundedForHostileArgumentMaps() {
        var arguments: [String: Any] = Dictionary(uniqueKeysWithValues: (0..<1_000).map { ("extra_\($0)", NSNull()) })
        arguments[String(repeating: "x", count: 100_000)] = 1
        XCTAssertThrowsError(try MCPServer.toolRequest(name: "spaceo_click", arguments: arguments)) { error in
            XCTAssertLessThan("\(error)".utf8.count, 1_024)
        }
    }

    func testSessionIsAnAliasOfNameOnCreate() throws {
        let create = try MCPServer.toolRequest(name: "spaceo_session_create", arguments: ["session": "notes"],
                                               defaultControllerOwner: TestController.owner())
        XCTAssertEqual(create.session, "notes")
        XCTAssertThrowsError(try MCPServer.toolRequest(name: "spaceo_session_create", arguments: ["session": "a", "name": "b"],
                                                        defaultControllerOwner: TestController.owner()))
        XCTAssertEqual(MCPPresentation.editDistance("sesion", "session", limit: 2), 1)
        XCTAssertEqual(MCPPresentation.editDistance("abcdef", "session", limit: 2), 3)
    }

    // MARK: 5. Lean catalogue

    func testCatalogueIsLeanAndFullyDescribed() throws {
        let data = try JSONSerialization.data(withJSONObject: ["tools": MCPServer.toolSchemas], options: [.sortedKeys])
        // 34 tools in 31 KB; the 32-tool catalogue this round started from was 37.6 KB.
        XCTAssertLessThanOrEqual(data.count, 31_000, "tools/list is \(data.count) bytes")
        for schema in MCPServer.toolSchemas {
            let name = schema["name"] as? String ?? "?"
            let description = schema["description"] as? String ?? ""
            XCTAssertLessThanOrEqual(description.count, 400, "\(name) description is \(description.count) characters")
            XCTAssertFalse(description.isEmpty, name)
            let properties = ((schema["inputSchema"] as? [String: Any])?["properties"] as? [String: Any]) ?? [:]
            for (property, value) in properties {
                let text = (value as? [String: Any])?["description"] as? String ?? ""
                XCTAssertFalse(text.isEmpty, "\(name).\(property) has no description")
            }
        }
        let create = try XCTUnwrap(MCPServer.toolSchemas.first { $0["name"] as? String == "spaceo_session_create" })
        let createProperties = try XCTUnwrap((create["inputSchema"] as? [String: Any])?["properties"] as? [String: Any])
        for hidden in ["controller_id", "controller_kind", "controller_label"] {
            XCTAssertNil(createProperties[hidden], "\(hidden) is accepted silently, not advertised")
        }
        let click = try XCTUnwrap(MCPServer.toolSchemas.first { $0["name"] as? String == "spaceo_click" })
        let clickProperties = try XCTUnwrap((click["inputSchema"] as? [String: Any])?["properties"] as? [String: Any])
        XCTAssertNotNil(clickProperties["label"], "the daemon accepts click by exact label")
        XCTAssertNotNil(clickProperties["observe"])
        XCTAssertNotNil(clickProperties["verbose"])
        // Hidden controller fields still work for callers that relied on them.
        let legacy = try MCPServer.toolRequest(name: "spaceo_session_create",
                                               arguments: ["controller_label": "Research agent"],
                                               defaultControllerOwner: TestController.owner())
        XCTAssertEqual(legacy.controllerOwner?.label, "Research agent")
    }

    func testPresentationArgumentsAreValidatedAndNeverForwarded() throws {
        let click = try MCPServer.toolRequest(name: "spaceo_click", arguments: ["element": "3", "observe": "full", "verbose": true])
        XCTAssertEqual(click.cmd, "click")
        XCTAssertEqual(MCPCallOptions(arguments: ["observe": "full", "verbose": true], connectionVerbose: false),
                       MCPCallOptions(verbose: true, observe: .full))
        XCTAssertEqual(MCPCallOptions(arguments: [:], connectionVerbose: true), MCPCallOptions(verbose: true, observe: .diff))
        XCTAssertThrowsError(try MCPServer.toolRequest(name: "spaceo_click", arguments: ["element": "3", "observe": "all"]))
        XCTAssertThrowsError(try MCPServer.toolRequest(name: "spaceo_click", arguments: ["element": "3", "verbose": "yes"]))
        XCTAssertThrowsError(try MCPServer.toolRequest(name: "spaceo_read_screen", arguments: ["observe": "diff"]),
                             "observe is offered only on actions")
        XCTAssertThrowsError(try MCPServer.toolRequest(name: "spaceo_run_steps", arguments: [
            "steps": [["tool": "spaceo_click", "arguments": ["element": "3", "observe": "none"]]],
        ]))
        XCTAssertNoThrow(try MCPServer.toolRequest(name: "spaceo_run_steps", arguments: [
            "verbose": true, "steps": [["tool": "spaceo_click", "arguments": ["element": "3"]]],
        ]))
    }

    // MARK: 6. Version drift

    func testRevalidatedDriftFromAReplacedDaemonIsNotDelivered() {
        let memory = MCPConnectionMemory(verbose: false)
        XCTAssertFalse(memory.hasUndeliveredDaemonDrift)
        memory.setDaemonDrift(MCPPresentation.daemonDriftWarning(
            daemonVersion: "1.0.5", daemonPID: 36_079, clientVersion: "1.0.7"))
        XCTAssertTrue(memory.hasUndeliveredDaemonDrift)
        // Revalidation found that the daemon answering now is this server's build.
        memory.setDaemonDrift(nil)
        XCTAssertFalse(memory.hasUndeliveredDaemonDrift)
        XCTAssertTrue(memory.drainNotes().isEmpty)
        XCTAssertNil(memory.daemonDrift)
    }

    func testDriftIsRecomputedOnlyForADifferentDaemonInstance() {
        let memory = MCPConnectionMemory(verbose: false)
        let original = UUID(), replacement = UUID()
        XCTAssertTrue(memory.driftNeedsCheck(for: original), "startup drift names no daemon instance")
        memory.setDaemonDrift("drift from the original daemon", daemonInstance: original)
        XCTAssertFalse(memory.driftNeedsCheck(for: original))
        XCTAssertTrue(memory.driftNeedsCheck(for: replacement), "a replacement is judged from its own reply")
        memory.setDaemonDrift(nil, daemonInstance: replacement)
        XCTAssertFalse(memory.hasUndeliveredDaemonDrift)
    }

    func testReplyDriftSurvivesALaterMatchingReplyInTheSameCall() {
        let memory = MCPConnectionMemory(verbose: false)
        // An aggregate destroy or an action's observation spans a restart: daemon A's reply was
        // used, then a matching replacement answered before the result was delivered.
        memory.setDaemonDrift("drift from A", daemonInstance: UUID(), fromReply: true)
        memory.setDaemonDrift(nil, daemonInstance: UUID(), fromReply: true)
        XCTAssertNil(memory.daemonDrift, "classification follows the latest producer")
        XCTAssertTrue(memory.hasUndeliveredDaemonDrift)
        XCTAssertEqual(memory.drainNotes(), ["WARNING: drift from A"])
        XCTAssertTrue(memory.drainNotes().isEmpty, "one time only")
    }

    func testPingDriftSupersededBeforeAnyReplyIsNotDelivered() {
        let memory = MCPConnectionMemory(verbose: false)
        memory.setDaemonDrift("startup drift from a replaced daemon")
        memory.setDaemonDrift(nil, daemonInstance: UUID(), fromReply: true)
        XCTAssertFalse(memory.hasUndeliveredDaemonDrift)
        XCTAssertTrue(memory.drainNotes().isEmpty)
    }

    func testUnreachableDaemonDoesNotClearAVerifiedDriftWarning() {
        let memory = MCPConnectionMemory(verbose: false)
        let warning = MCPPresentation.daemonDriftWarning(
            daemonVersion: "1.0.5", daemonPID: 36_079, clientVersion: "1.0.7")
        memory.setDaemonDrift(warning)
        let controller = MCPControllerContext(memory: memory)
        MCPServer.revalidateDaemonDrift(
            socketPath: "/tmp/spaceo-absent-\(UUID().uuidString.prefix(8)).sock", controller: controller)
        XCTAssertEqual(memory.daemonDrift, warning, "no provenance reply is not proof the drift ended")
        XCTAssertTrue(memory.hasUndeliveredDaemonDrift)
    }

    func testDriftWarningLeadsTheFirstResultOnlyAndRewritesUnknownCommands() {
        let memory = MCPConnectionMemory(verbose: false)
        let warning = MCPPresentation.daemonDriftWarning(daemonVersion: "1.1.0", daemonPID: 77, clientVersion: "1.1.1")
        XCTAssertEqual(warning, "the running SpaceO daemon is 1.1.0 (pid 77) but this MCP server is 1.1.1; "
                       + "some tools will fail until the user runs `spaceo daemon restart --operator`.")
        memory.setDaemonDrift(warning)
        let first = MCPServer.prependingNotes(memory.drainNotes(), to: ["content": [["type": "text", "text": "ok"]]])
        XCTAssertEqual(((first["content"] as? [[String: Any]])?.first?["text"] as? String), "WARNING: " + warning + "\nok")
        XCTAssertTrue(memory.drainNotes().isEmpty, "one time only")

        var unknown = Response.failure(SpaceOError.badRequest("unknown command 'menu'"))
        let rewritten = MCPServer.rewritingOutdatedDaemon(unknown, drift: memory.daemonDrift)
        XCTAssertEqual(rewritten.errorCode, "daemon_outdated")
        XCTAssertTrue(rewritten.error?.contains("spaceo daemon restart --operator") == true)
        assertSpeaksMCP(MCPServer.renderFailure(rewritten))
        unknown.error = "unknown command 'menu'"
        XCTAssertEqual(MCPServer.rewritingOutdatedDaemon(unknown, drift: nil).errorCode, "bad_request",
                       "without evidence of drift an unknown command stays the agent's error")
    }

    // MARK: 7. Resilience

    func testEndedSessionDropsItsLeaseAndQueuesANoteFromRenewal() throws {
        let context = try context(holding: ["gone", "live"])
        let renewal = try XCTUnwrap(context.renewalRequests().first { $0.session == "gone" })
        context.recordRenewal(Response.failure(SpaceOError.unknownSession("gone")), for: renewal)
        XCTAssertNil(context.storedLease(for: "gone"))
        XCTAssertNotNil(context.storedLease(for: "live"))
        XCTAssertEqual(context.memory.drainNotes(),
                       ["NOTE: session 'gone' ended (the daemon no longer has it); create a new session with spaceo_session_create"])
        // With one lease left, omission resolves to it again.
        XCTAssertEqual(try context.prepare(MCPServer.toolRequest(name: "spaceo_click", arguments: ["element": "1"])).session, "live")

        var detached = Response(ok: false)
        detached.errorCode = "session_detached"
        detached.error = "the daemon restarted"
        let click = try context.prepare(MCPServer.toolRequest(name: "spaceo_click", arguments: ["element": "1"]))
        context.record(detached, for: click)
        XCTAssertNil(context.storedLease(for: "live"), "a direct call that proves the session ended drops the lease")
    }

    func testDaemonRestartReplaysOnlyReadsAndCreate() {
        for read in ["ax", "ax.find", "windows", "screenshot", "session.list", "session.create"] {
            XCTAssertTrue(MCPServer.replayableAfterDaemonRestart.contains(read), read)
        }
        for mutation in ["click", "type", "key", "run", "session.destroy", "steps.run", "clipboard.set"] {
            XCTAssertFalse(MCPServer.replayableAfterDaemonRestart.contains(mutation), mutation)
        }
        XCTAssertEqual(MCPServer.MCPDaemonRestart(started: true).description,
                       "the SpaceO daemon restarted; sessions from before the restart have ended — create a new session with spaceo_session_create")
    }

    // MARK: 8. Observe

    func testObservePlansADiffAgainstTheLastSnapshotForThatWindow() throws {
        let memory = MCPConnectionMemory(verbose: false)
        var click = Request(cmd: "click")
        click.session = "s1"
        click.element = "3"
        click.diagnosticTraceID = "t"
        let response = dogfoodClick()

        let noBase = MCPServer.observeRequest(after: click, response: response, mode: .diff, memory: memory)
        XCTAssertNil(noBase.request)
        XCTAssertEqual(noBase.line, "after action: read the screen for fresh indices")

        let full = MCPServer.observeRequest(after: click, response: response, mode: .full, memory: memory)
        XCTAssertEqual(full.request?.cmd, "ax")
        XCTAssertNil(full.request?.since)
        XCTAssertEqual(full.request?.window, 42)

        var read = Request(cmd: "ax")
        read.session = "s1"
        var observed = dogfoodClick()
        observed.action = nil
        observed.snapshotID = "base-snapshot-id"
        let controller = MCPControllerContext(memory: memory)
        MCPServer.rememberSnapshot(observed, for: read, controller: controller)
        let diff = MCPServer.observeRequest(after: click, response: response, mode: .diff, memory: memory)
        XCTAssertEqual(diff.request?.since, "base-snapshot-id")
        XCTAssertEqual(diff.request?.session, "s1")
        XCTAssertEqual(diff.request?.diagnosticTraceID, "t")

        XCTAssertNil(MCPServer.observeRequest(after: click, response: response, mode: .none, memory: memory).request)
        var web = click
        web.element = "w3"
        let skipped = MCPServer.observeRequest(after: web, response: response, mode: .diff, memory: memory)
        XCTAssertNil(skipped.request)
        XCTAssertNil(skipped.line, "web indices are live page order; no native diff")
        var failed = response
        failed.ok = false
        XCTAssertNil(MCPServer.observeRequest(after: click, response: failed, mode: .diff, memory: memory).request)
    }

    func testObservationRenderingNeverFailsTheAction() {
        var diff = Response(ok: true)
        diff.snapshotID = "new-snapshot"
        diff.outline = "added (1):\n  + [7] Button — OK\n3 element(s) unchanged."
        diff.diff = ScreenDiff(baseSnapshotID: "base", added: ["[7] Button — OK"], removed: [], changed: [], unchangedCount: 3, baseMissing: false)
        let text = MCPServer.renderObservation(diff, mode: .diff, base: "base-snapshot-id")
        XCTAssertTrue(text.hasPrefix("after action: snapshot new-snapshot (changes since base-sna)"), text)
        XCTAssertTrue(text.contains("[7] Button — OK"))

        diff.diff?.baseMissing = true
        XCTAssertTrue(MCPServer.renderObservation(diff, mode: .diff, base: "b").contains("read the screen for fresh indices"))

        let failure = Response.failure(SpaceOError.windowNotReady("gone"))
        XCTAssertEqual(MCPServer.renderObservation(failure, mode: .diff, base: "b"), "observe: unavailable (window_not_ready)")
    }
}
