import XCTest
@testable import SpaceOKit
@testable import SpaceOMCP

/// The MCP argument boundary for the tools added in the 2026-09 ergonomics round. Every tool
/// must translate exactly to the daemon command it stands for and refuse malformed shapes here,
/// before a round trip, with a message that names the alternative.
final class MCPToolTranslationTests: XCTestCase {
    func testPoolTrimRequiresExplicitOperatorScope() throws {
        let request = try MCPServer.toolRequest(name: "spaceo_pool_trim", arguments: ["operator": true])
        XCTAssertEqual(request.cmd, "pool.trim")
        XCTAssertEqual(request.operatorScope, true)
        for args: [String: Any] in [[:], ["operator": false], ["operator": "true"], ["operator": true, "all": true]] {
            XCTAssertThrowsError(try MCPServer.toolRequest(name: "spaceo_pool_trim", arguments: args))
        }
    }

    func testToolCatalogueIsExactlyTheAdvertisedSet() throws {
        let names = MCPServer.toolSchemas.compactMap { $0["name"] as? String }
        XCTAssertEqual(names.count, 35)
        XCTAssertEqual(Set(names).count, names.count, "tool names must be unique")
        for tool in [
            "spaceo_open_url", "spaceo_wait_for", "spaceo_find", "spaceo_read_text", "spaceo_run_steps",
            "spaceo_clipboard_set", "spaceo_clipboard_get", "spaceo_session_set_title", "spaceo_events",
        ] {
            XCTAssertTrue(names.contains(tool), "\(tool) missing from tools/list")
        }
    }

    /// spaceo_run_steps accepts exactly the tools whose daemon commands a batch may run.
    func testBatchableToolsAreExactlyTheDaemonsBatchCommands() throws {
        let minimal: [String: [String: Any]] = [
            "spaceo_click": ["element": "1"], "spaceo_type": ["text": "a"],
            "spaceo_press_key": ["key": "a"], "spaceo_scroll": ["element": "1", "dy": 1],
            "spaceo_move": ["element": "1"], "spaceo_drag": ["from_element": "1", "to_element": "2"],
            "spaceo_wait_for": ["condition": "ms", "value": "10"], "spaceo_find": ["query": "a"],
        ]
        XCTAssertEqual(MCPTool.batchableNames, Set(minimal.keys))
        let commands = try Set(minimal.map { try MCPServer.toolRequest(name: $0.key, arguments: $0.value).cmd })
        XCTAssertEqual(commands, SessionManager.batchStepCommands)
    }

    func testOpenURLTranslatesAndRefusesNonWebSchemes() throws {
        let request = try MCPServer.toolRequest(
            name: "spaceo_open_url",
            arguments: ["url": "https://example.com/a?b=1", "new_tab": true, "timeout": 20])
        XCTAssertEqual(request.cmd, "open.url")
        XCTAssertEqual(request.url, "https://example.com/a?b=1")
        XCTAssertEqual(request.newTab, true)
        XCTAssertEqual(request.timeout, 20)
        XCTAssertThrowsError(try MCPServer.toolRequest(name: "spaceo_open_url", arguments: ["url": "javascript:alert(1)"]))
        XCTAssertThrowsError(try MCPServer.toolRequest(name: "spaceo_open_url", arguments: [:]))
    }

    func testWaitForRequiresAKnownConditionAndAValue() throws {
        let request = try MCPServer.toolRequest(
            name: "spaceo_wait_for",
            arguments: ["condition": "element_label", "value": "Save", "timeout": 5])
        XCTAssertEqual(request.cmd, "wait")
        XCTAssertEqual(request.waitCondition, "element_label")
        XCTAssertEqual(request.waitValue, "Save")
        XCTAssertThrowsError(try MCPServer.toolRequest(name: "spaceo_wait_for", arguments: ["condition": "element_label"]))
        XCTAssertThrowsError(try MCPServer.toolRequest(name: "spaceo_wait_for", arguments: ["condition": "until_happy", "value": "x"]))
    }

    func testFindAndReadTextBounds() throws {
        let find = try MCPServer.toolRequest(name: "spaceo_find", arguments: ["query": "save", "role": "Button"])
        XCTAssertEqual(find.cmd, "ax.find")
        XCTAssertEqual(find.query, "save")
        XCTAssertEqual(find.role, "Button")
        XCTAssertThrowsError(try MCPServer.toolRequest(name: "spaceo_find", arguments: ["query": ""]))

        let text = try MCPServer.toolRequest(name: "spaceo_read_text", arguments: ["max_chars": 500, "element": "4"])
        XCTAssertEqual(text.cmd, "ax.text")
        XCTAssertEqual(text.maxChars, 500)
        XCTAssertEqual(text.element, "4")
        XCTAssertThrowsError(try MCPServer.toolRequest(name: "spaceo_read_text", arguments: ["max_chars": 0]))
        XCTAssertThrowsError(try MCPServer.toolRequest(name: "spaceo_read_text", arguments: ["max_chars": 20_001]))
    }

    func testRunStepsTranslatesEachStepThroughTheSameValidators() throws {
        let request = try MCPServer.toolRequest(
            name: "spaceo_run_steps",
            arguments: [
                "session": "s1",
                "stop_on_failure": false,
                "steps": [
                    ["tool": "spaceo_click", "arguments": ["element": "3"]],
                    ["tool": "spaceo_type", "arguments": ["text": "hello", "submit": true]],
                    ["tool": "spaceo_wait_for", "arguments": ["condition": "ms", "value": "200"]],
                ],
            ])
        XCTAssertEqual(request.cmd, "steps.run")
        XCTAssertEqual(request.session, "s1")
        XCTAssertEqual(request.stopOnFailure, false)
        XCTAssertEqual(request.steps?.map(\.cmd), ["click", "type", "wait"])
        XCTAssertEqual(request.steps?[1].submit, true)

        XCTAssertThrowsError(try MCPServer.toolRequest(
            name: "spaceo_run_steps",
            arguments: ["steps": [["tool": "spaceo_session_destroy"]]]), "destructive tools cannot be batched")
        XCTAssertThrowsError(try MCPServer.toolRequest(
            name: "spaceo_run_steps",
            arguments: ["steps": [["tool": "spaceo_click", "arguments": ["element": "3", "x": 1, "y": 2]]]]),
            "a bad step fails the whole batch before any round trip")
        XCTAssertThrowsError(try MCPServer.toolRequest(
            name: "spaceo_run_steps",
            arguments: ["session": "a", "steps": [["tool": "spaceo_click", "arguments": ["element": "3", "session": "b"]]]]),
            "a batch runs on one session")
        XCTAssertThrowsError(try MCPServer.toolRequest(
            name: "spaceo_run_steps",
            arguments: ["steps": Array(repeating: ["tool": "spaceo_click", "arguments": ["element": "1"]], count: 17)]))
    }

    func testRunStepsRejectsMalformedEnvelopesBeforeProducingARequest() throws {
        for value: Any in [NSNull(), 42, "ignored", [1, 2]] {
            XCTAssertThrowsError(try MCPServer.toolRequest(name: "spaceo_run_steps", arguments: [
                "steps": [["tool": "spaceo_scroll", "arguments": value]],
            ])) { error in
                XCTAssertEqual(String(describing: error), "step 0: arguments must be an object")
            }
        }
        // A typo in a later step rejects the whole translation; no partial plan escapes.
        XCTAssertThrowsError(try MCPServer.toolRequest(name: "spaceo_run_steps", arguments: [
            "steps": [["tool": "spaceo_type", "arguments": ["text": "synthetic"]],
                      ["tool": "spaceo_scroll", "argument": ["dy": 10]]],
        ])) { error in
            XCTAssertEqual(String(describing: error), "step 1: unexpected argument(s): argument")
        }
        // Omission continues through the same single-tool validator as an empty object.
        for step: [String: Any] in [["tool": "spaceo_type"], ["tool": "spaceo_type", "arguments": [:]]] {
            XCTAssertThrowsError(try MCPServer.toolRequest(name: "spaceo_run_steps", arguments: ["steps": [step]])) { error in
                XCTAssertEqual(String(describing: error), "'text' is required")
            }
        }
        let schema = try XCTUnwrap(MCPServer.toolSchemas.first { $0["name"] as? String == "spaceo_run_steps" })
        let input = try XCTUnwrap(schema["inputSchema"] as? [String: Any])
        let properties = try XCTUnwrap(input["properties"] as? [String: Any])
        let steps = try XCTUnwrap(properties["steps"] as? [String: Any])
        let items = try XCTUnwrap(steps["items"] as? [String: Any])
        XCTAssertEqual(items["additionalProperties"] as? Bool, false)
    }

    func testRunStepsBoundsRejectedNamesAndEnvelopeFields() {
        let oversizedName = "a" + String(repeating: "\u{301}", count: 100_000)
        XCTAssertThrowsError(try MCPServer.toolRequest(name: "spaceo_run_steps", arguments: [
            "steps": [["tool": oversizedName]],
        ])) { error in
            XCTAssertTrue(String(describing: error).contains("cannot be batched; use spaceo_click"))
            XCTAssertLessThan(String(describing: error).utf8.count, 300)
        }
        var step: [String: Any] = Dictionary(uniqueKeysWithValues: (0..<1000).map { ("extra_\($0)", NSNull()) })
        step["tool"] = "spaceo_scroll"
        XCTAssertThrowsError(try MCPServer.toolRequest(name: "spaceo_run_steps", arguments: ["steps": [step]])) { error in
            XCTAssertTrue(String(describing: error).contains("and 992 more"))
            XCTAssertLessThan(String(describing: error).utf8.count, 1024)
        }
    }

    func testPointerToolsAcceptElementReferencesInsteadOfCoordinates() throws {
        let scroll = try MCPServer.toolRequest(name: "spaceo_scroll", arguments: ["element": "7", "dy": -600])
        XCTAssertEqual(scroll.element, "7")
        XCTAssertNil(scroll.x)
        XCTAssertThrowsError(try MCPServer.toolRequest(name: "spaceo_scroll", arguments: ["element": "7", "x": 1, "y": 2, "dy": -1]))
        XCTAssertThrowsError(try MCPServer.toolRequest(name: "spaceo_scroll", arguments: ["dy": -600]), "neither form supplied")
        XCTAssertThrowsError(try MCPServer.toolRequest(name: "spaceo_move", arguments: ["element": "seven"]))

        let drag = try MCPServer.toolRequest(name: "spaceo_drag", arguments: ["from_element": "2", "to_element": "w5"])
        XCTAssertEqual(drag.fromElement, "2")
        XCTAssertEqual(drag.toElement, "w5")
        XCTAssertThrowsError(try MCPServer.toolRequest(name: "spaceo_drag", arguments: ["from_element": "2"]), "drag needs an end")
        XCTAssertThrowsError(try MCPServer.toolRequest(name: "spaceo_drag", arguments: ["x": 1, "y": 2, "to_element": "3", "to_x": 4, "to_y": 5]))
        XCTAssertThrowsError(try MCPServer.toolRequest(name: "spaceo_move", arguments: ["from_element": "2"]), "from_element belongs to drag")
    }

    func testTypingAndKeyErgonomics() throws {
        let type = try MCPServer.toolRequest(name: "spaceo_type", arguments: ["text": "abc", "replace": true, "submit": true])
        XCTAssertEqual(type.replace, true)
        XCTAssertEqual(type.submit, true)

        let held = try MCPServer.toolRequest(name: "spaceo_press_key", arguments: ["key": "right", "hold_ms": 800])
        XCTAssertEqual(held.holdMs, 800)
        let down = try MCPServer.toolRequest(name: "spaceo_press_key", arguments: ["key": "shift", "action": "down"])
        XCTAssertEqual(down.keyAction, "down")
        XCTAssertThrowsError(try MCPServer.toolRequest(name: "spaceo_press_key", arguments: ["key": "a", "hold_ms": 5_001]))
        XCTAssertThrowsError(try MCPServer.toolRequest(name: "spaceo_press_key", arguments: ["key": "a", "action": "hold"]))
    }

    func testSessionCreateExtensionsAndScreenshotAnnotate() throws {
        let create = try MCPServer.toolRequest(
            name: "spaceo_session_create",
            arguments: ["app": "TextEdit", "preset": "exclusive_1080p", "title": "Notes", "record": "actions"],
            defaultControllerOwner: TestController.owner())
        XCTAssertEqual(create.app, "TextEdit")
        XCTAssertEqual(create.preset, "exclusive_1080p")
        XCTAssertEqual(create.title, "Notes")
        XCTAssertEqual(create.record, "actions")
        XCTAssertThrowsError(try MCPServer.toolRequest(name: "spaceo_session_create", arguments: ["preset": "huge"], defaultControllerOwner: TestController.owner()))
        XCTAssertThrowsError(try MCPServer.toolRequest(name: "spaceo_session_create", arguments: ["files": ["/tmp/a"]], defaultControllerOwner: TestController.owner()), "files need an app")

        let annotated = try MCPServer.toolRequest(name: "spaceo_screenshot", arguments: ["annotate": true])
        XCTAssertEqual(annotated.annotate, true)
        XCTAssertThrowsError(try MCPServer.toolRequest(name: "spaceo_screenshot", arguments: ["annotate": true, "full": true]))

        let pause = try MCPServer.toolRequest(name: "spaceo_session_pause", arguments: ["reason": "needs 2FA"])
        XCTAssertEqual(pause.cmd, "session.control")
        XCTAssertEqual(pause.paused, true)
        XCTAssertEqual(pause.reason, "needs 2FA")

        let title = try MCPServer.toolRequest(name: "spaceo_session_set_title", arguments: ["title": "Invoices"])
        XCTAssertEqual(title.cmd, "session.annotate")
        XCTAssertEqual(title.title, "Invoices")

        let events = try MCPServer.toolRequest(name: "spaceo_events", arguments: ["since_seq": 41])
        XCTAssertEqual(events.cmd, "events.poll")
        XCTAssertEqual(events.sinceSeq, 41)
        XCTAssertThrowsError(try MCPServer.toolRequest(name: "spaceo_events", arguments: ["since_seq": -1]))

        let reused = try MCPServer.toolRequest(name: "spaceo_open_app", arguments: ["app": "Safari", "new_instance": true, "mute_audio": true])
        XCTAssertEqual(reused.newInstance, true)
        XCTAssertEqual(reused.muteAudio, true)
    }

    func testRenderingSurfacesHandoffRecoveryAndReceipts() {
        var failure = Response.failure(SpaceOError.staleSnapshot("gone"))
        failure.recovery = failure.recovery?.bound(session: "s1")
        failure.warnings = ["Recording stopped (capacity_exhausted)"]
        let rendered = MCPServer.renderFailure(failure)
        XCTAssertTrue(rendered.contains("[stale_snapshot]"))
        XCTAssertTrue(rendered.contains("WARNING: Recording stopped (capacity_exhausted)"))
        XCTAssertTrue(rendered.contains("recovery: {"), rendered)
        XCTAssertTrue(rendered.contains("\"tool\":\"spaceo_read_screen\""), rendered)
        XCTAssertTrue(rendered.contains("\"session\":\"s1\""), rendered)

        var success = Response(ok: true)
        success.handoff = OperatorHandoff(note: "fixed the typo", controlDurationSeconds: 12, windowsChanged: true, releasedAt: Date())
        success.message = "clicked"
        success.resolvedPoint = ResolvedPoint(x: 10, y: 20, source: "element", element: "3")
        success.wait = WaitReceipt(condition: "element_label", value: "Save", outcome: "met", elapsedSeconds: 1.25, matchedIndex: 4, probes: 5)
        success.steps = [StepReceipt(index: 0, cmd: "click", ok: true, executed: true, message: "ok"),
                         StepReceipt(index: 1, cmd: "type", ok: false, executed: false, error: "not executed", errorCode: "not_executed")]
        success.firstFailureIndex = 1
        let text = MCPServer.render(success)
        XCTAssertTrue(text.hasPrefix("HUMAN HANDOFF:"), text)
        XCTAssertTrue(text.contains("fixed the typo"))
        XCTAssertTrue(text.contains("resolved_point: (10,20) from element 3"), text)
        XCTAssertTrue(text.contains("wait: element_label 'Save', outcome=met"), text)
        XCTAssertTrue(text.contains("step 1 type: not executed"), text)
        XCTAssertTrue(text.contains("first_failure_index: 1"), text)
    }

    func testFailedCreateNamesOnlyAnEvidencedRetainedSession() throws {
        let json = """
        {"id":"partial","displayID":7,"x":0,"y":0,"width":1280,"height":800,
         "tileIndex":0,"tileCapacity":1,"exclusiveDisplay":true,"spaces":[],
         "hasOwnSpace":false,"apps":[],"windows":[],
         "createdAt":"2026-07-28T00:00:00Z","teardownPending":false}
        """
        var failure = Response.failure(SpaceOError.badRequest("synthetic launch failure"))
        failure.session = try Wire.decoder.decode(SessionInfo.self, from: Data(json.utf8))
        let create = Request(cmd: "session.create")

        XCTAssertFalse(MCPServer.renderFailure(failure, for: create).contains("retained session:"),
                       "a session without a returned lease is not evidence of retained ownership")
        failure.controllerLeaseID = UUID()
        let rendered = MCPServer.renderFailure(failure, for: create)
        XCTAssertTrue(rendered.contains("retained session: 'partial'"))
        XCTAssertTrue(rendered.contains("spaceo_session_destroy"))
        XCTAssertFalse(rendered.contains(failure.controllerLeaseID!.uuidString),
                       "never expose the controller lease in tool output")
        XCTAssertFalse(MCPServer.renderFailure(failure, for: Request(cmd: "open.app"))
            .contains("retained session:"), "another command's session field does not prove allocation")
        let maximumID = String(repeating: "s", count: SessionManager.maximumSessionIDCharacters)
        let maximumJSON = json.replacingOccurrences(of: "\"partial\"", with: "\"\(maximumID)\"")
        failure.session = try Wire.decoder.decode(SessionInfo.self, from: Data(maximumJSON.utf8))
        XCTAssertTrue(MCPServer.renderFailure(failure, for: create)
            .contains("retained session: '\(maximumID)'"), "a valid ID must remain actionable, not be clipped")
        let unicodeID = String(repeating: "😀", count: SessionManager.maximumSessionIDCharacters)
        XCTAssertEqual(unicodeID.utf8.count, SessionManager.maximumSessionIDBytes)
        let unicodeJSON = json.replacingOccurrences(of: "\"partial\"", with: "\"\(unicodeID)\"")
        failure.session = try Wire.decoder.decode(SessionInfo.self, from: Data(unicodeJSON.utf8))
        XCTAssertTrue(MCPServer.renderFailure(failure, for: create)
            .contains("retained session: '\(unicodeID)'"), "the largest valid UTF-8 ID must remain complete")
        for invalidID in [unicodeID + "😀", "bad/session"] {
            let invalidJSON = json.replacingOccurrences(of: "\"partial\"", with: "\"\(invalidID)\"")
            failure.session = try Wire.decoder.decode(SessionInfo.self, from: Data(invalidJSON.utf8))
            XCTAssertFalse(MCPServer.renderFailure(failure, for: create).contains("retained session:"),
                           "an invalid returned ID must not be offered as a recovery target")
        }
        failure.session = nil
        XCTAssertFalse(MCPServer.renderFailure(failure, for: create).contains("retained session:"))
    }

    func testBatchObservationReceiptIsBoundedRenderedAndWireCompatible() throws {
        var observation = Response(ok: true)
        observation.outline = "[3] Button — Save\n" + String(repeating: "é", count: 20_000)
        observation.snapshotID = "snapshot-3"
        observation.truncation = TruncationReport(shown: 25, truncated: true, reason: "web_find_cap",
                                                  hint: "narrow the query")
        let receipt = StepReceipt(index: 0, cmd: "ax.find", response: observation)
        XCTAssertLessThanOrEqual(receipt.outline?.utf8.count ?? 0, StepReceipt.maximumOutlineBytes)
        XCTAssertEqual(receipt.outputTruncated, true)
        XCTAssertTrue(receipt.outline?.hasSuffix("…") == true)
        XCTAssertEqual(receipt.snapshotID, "snapshot-3")
        XCTAssertEqual(receipt.truncation, observation.truncation)
        XCTAssertEqual(try Wire.decoder.decode(StepReceipt.self, from: Wire.encoder.encode(receipt)), receipt)
        let legacy = Data(#"{"index":0,"cmd":"wait","ok":true,"executed":true}"#.utf8)
        XCTAssertNil(try Wire.decoder.decode(StepReceipt.self, from: legacy).outline)
        XCTAssertNil(try Wire.decoder.decode(StepReceipt.self, from: legacy).truncation)
        var response = Response(ok: true)
        response.steps = [receipt]
        let rendered = MCPServer.render(response)
        XCTAssertTrue(rendered.contains("step 0 snapshot: snapshot-3"))
        XCTAssertTrue(rendered.contains("[3] Button — Save"))
        XCTAssertTrue(rendered.contains("step output truncated"))
        XCTAssertTrue(rendered.contains("reason: web_find_cap"))
        response.ok = false
        response.error = "later step failed"
        response.firstFailureIndex = 1
        response.steps?.append(StepReceipt(index: 1, cmd: "wait", ok: false, executed: true,
                                           error: "timed out", errorCode: "wait_timeout", completion: "timeout"))
        let failure = MCPServer.renderFailure(response)
        XCTAssertTrue(failure.contains("step 0 ax.find: ok"))
        XCTAssertTrue(failure.contains("step 1 wait: FAILED (timeout)"))
        XCTAssertTrue(failure.contains("first_failure_index: 1"))
        XCTAssertTrue(failure.contains("snapshot-3"))
        XCTAssertTrue(failure.contains("reason: web_find_cap"))
    }

    func testObservationCompletenessSurvivesMCPRenderingWithoutDuplicateFooter() {
        var response = Response(ok: true)
        response.outline = "(no matches in the inspected page controls)"
        let report = TruncationReport(shown: 0, truncated: true, reason: "web_index_cap",
                                      hint: "only the first 1000 page controls were searched")
        response.truncation = report
        XCTAssertTrue(MCPServer.render(response).contains(report.footer))
        response.message = "search result\n" + report.footer
        XCTAssertEqual(MCPServer.render(response).components(separatedBy: report.footer).count, 2)
        response.ok = false
        response.error = "later processing failed"
        XCTAssertTrue(MCPServer.renderFailure(response).contains(report.footer))
    }

    func testIsolationRenderingLeadsWithTheOneSentenceSummary() {
        let partial = IsolationReport(checks: [
            IsolationCheckReport(dimension: .menuBarOwner, coverage: .observed, status: .passed, evidence: "menu bar"),
            IsolationCheckReport(dimension: .keyInputRoute, coverage: .unknown, status: .unknown,
                                 evidence: "Accessibility focused-application proxy was unavailable"),
        ])
        let rendered = MCPServer.renderIsolation(partial)
        XCTAssertTrue(rendered.hasPrefix("isolation: partial — No disturbance to your desktop was observed;"), rendered)
        XCTAssertTrue(rendered.contains("keyboard routing"), rendered)
    }
}
