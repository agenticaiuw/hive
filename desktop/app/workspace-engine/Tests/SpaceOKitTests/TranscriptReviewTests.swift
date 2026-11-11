import XCTest
import CoreGraphics
@testable import SpaceOKit
@testable import SpaceOMCP

final class TranscriptReviewTests: XCTestCase {
    func testDisplaySizedPanelHasNoInsetAtEitherOrigin() {
        for x in [1512.0, 1920.0, -1920.0] {
            let display = CGRect(x: x, y: 0, width: 1920, height: 1080)
            let panel = CGRect(x: 0, y: 0, width: 1920, height: 1080)
            XCTAssertEqual(WindowPlacement.targetFrame(for: panel, in: display), display)
            XCTAssertEqual(WindowPlacement.targetFrame(for: panel, in: display, policy: .cover), display)
        }
    }

    func testPreserveKeepsSettingsSizeAndAllCascadeFramesContained() {
        let display = CGRect(x: 1512, y: -500, width: 1920, height: 1080)
        let settings = CGRect(x: 0, y: 0, width: 560, height: 632)
        for index in 0..<100 {
            let result = WindowPlacement.targetFrame(for: settings, in: display, index: index)
            XCTAssertEqual(result.size, settings.size)
            XCTAssertTrue(display.contains(result))
        }
        XCTAssertEqual(WindowPlacement.targetFrame(for: settings, in: display, policy: .fit).size,
                       CGSize(width: 1840, height: 1000))
        XCTAssertEqual(WindowPlacement.overflowEdges(display.offsetBy(dx: 40, dy: 40), outside: display), ["right", "bottom"])
    }

    func testGeometryReceiptExpiresOnTopologyWindowOrSessionChange() {
        let generation = UUID()
        let frame = CGRect(x: 1920, y: 0, width: 1920, height: 1080)
        func receipt(_ session: UUID = generation, _ bounds: CGRect = frame, _ id: UInt32 = 41) -> GeometryReceipt {
            GeometryReceipt(sessionGeneration: session, displayID: 20, displayBounds: bounds,
                window: WindowRef(windowID: id, pid: 123, title: "", frame: frame), process: nil)
        }
        XCTAssertEqual(receipt(), receipt())
        XCTAssertNotEqual(receipt().token, receipt(UUID()).token)
        XCTAssertNotEqual(receipt().token, receipt(generation, frame.offsetBy(dx: -408, dy: 0)).token)
        XCTAssertNotEqual(receipt().token, receipt(generation, frame, 42).token)
    }

    func testEmptySessionNeverSatisfiesInteractiveReadiness() {
        let empty = ReadinessReport(applicationCount: 0, windowCount: 0, attached: true, paused: false, canDrive: true)
        XCTAssertEqual(empty.state, "blocked")
        XCTAssertTrue(empty.blockers.contains("application_window_not_ready"))
        XCTAssertEqual(empty.presentationVerification, "unverified")
        XCTAssertEqual(empty.visibility, "unknown")
        let paused = ReadinessReport(applicationCount: 1, windowCount: 1, attached: true, paused: true, canDrive: true)
        XCTAssertTrue(paused.blockers.contains("input_paused"))
    }

    func testPermissionMismatchIsDifferentFromStoppedDaemon() {
        var daemon = DaemonRuntimeInfo(version: "test", executableSHA256: nil,
            pid: 123, instanceID: UUID(), startedAt: Date())
        daemon.accessibilityGranted = false
        daemon.screenRecordingGranted = true
        let mismatch = PermissionReadinessReport(clientAX: true, clientCapture: true, daemon: daemon)
        XCTAssertTrue(mismatch.blockers.contains("permission_state_mismatch"))
        XCTAssertTrue(mismatch.nextAction?.contains("all sessions") == true)
        daemon.accessibilityGranted = nil
        daemon.screenRecordingGranted = nil
        let unknown = PermissionReadinessReport(clientAX: true, clientCapture: true, daemon: daemon)
        XCTAssertTrue(unknown.blockers.contains("permission_state_unknown"))
        XCTAssertFalse(unknown.blockers.contains("permission_state_mismatch"))
        XCTAssertEqual(PermissionReadinessReport(clientAX: true, clientCapture: true, daemon: nil).blockers,
                       ["daemon_not_running"])
    }

    func testResourceLimitsAndExplicitOverride() throws {
        let budget = ResourceBudget.default
        XCTAssertThrowsError(try budget.admitSession(usage: .init(sessions: budget.maximumSessions)))
        XCTAssertThrowsError(try budget.admitDisplay(size: CGSize(width: 1920, height: 1080), capacity: 1,
            usage: .init(displays: budget.maximumDisplays)))
        XCTAssertThrowsError(try budget.admitDisplay(size: CGSize(width: 1920, height: 1080), capacity: 1,
            usage: .init(creationsInLastMinute: budget.maximumCreationsPerMinute)))
        XCTAssertThrowsError(try budget.admitDisplay(size: CGSize(width: 1920, height: 1080), capacity: 1,
            usage: .init(pixels: budget.maximumTotalPixels)))
        XCTAssertEqual(ResourceBudget.fromEnvironment(["SPACEO_UNRESTRICTED_RESOURCES": "1"]), .unrestricted)
        XCTAssertTrue(ResourceLimitsReport(.unrestricted).unsafeOperatorMode)
    }

    func testLaunchArgumentsAreBoundedBeforeEffects() {
        XCTAssertNoThrow(try LaunchOptions.validate(arguments: ["--test-display", "20"], timeout: 15))
        for values in [Array(repeating: "a", count: 129), [String(repeating: "a", count: 4097)], ["bad\0argument"]] {
            XCTAssertThrowsError(try LaunchOptions.validate(arguments: values, timeout: 15))
        }
        XCTAssertThrowsError(try LaunchOptions.validate(arguments: [], timeout: .infinity))
    }

    func testStableErrorCodesSurviveWireEncoding() throws {
        let response = Response.failure(SpaceOError.staleSnapshot("refresh"))
        let decoded = try Wire.decoder.decode(Response.self, from: Wire.encoder.encode(response))
        XCTAssertFalse(decoded.ok)
        XCTAssertEqual(decoded.errorCode, "stale_snapshot")
        XCTAssertNotNil(decoded.nextAction)
    }

    func testStableLabelsRefuseMissingAndAmbiguousControls() throws {
        let identity = try XCTUnwrap(ProcessIdentity.current(of: getpid()))
        let button = AXNode(index: 7, role: "AXButton", label: "Settings", frame: nil, actions: ["AXPress"], depth: 0, enabled: true)
        func snapshot(_ nodes: [AXNode]) -> AXSnapshot {
            AXSnapshot(pid: identity.pid, windowID: 41, processIdentity: identity,
                       generation: UUID(), nodes: nodes, elements: [:])
        }
        XCTAssertEqual(try snapshot([button]).uniqueIndex(label: "Settings"), 7)
        XCTAssertThrowsError(try snapshot([button, button]).uniqueIndex(label: "Settings"))
        XCTAssertThrowsError(try snapshot([]).uniqueIndex(label: "Settings"))
        let request = try MCPServer.toolRequest(name: "spaceo_click", arguments: ["label": "Settings"])
        XCTAssertEqual(request.label, "Settings")
    }

    func testAssertionsRequireObservedCoverageAndKeepCurrentBreaches() {
        let inferred = IsolationReport(checks: [.init(dimension: .keyInputRoute,
            coverage: .inferred, status: .passed, evidence: "proxy")])
        XCTAssertFalse(VerificationAssertion(required: [.keyInputRoute], report: inferred).satisfied)
        let observed = IsolationReport(checks: [.init(dimension: .menuBarOwner,
            coverage: .observed, status: .passed, evidence: "unchanged")])
        let current = IsolationReport(checks: [.init(dimension: .menuBarOwner,
            coverage: .observed, status: .failed, evidence: "currently owned", failures: ["owned focus"])])
        XCTAssertTrue(VerificationAssertion(required: [.menuBarOwner], report: observed).satisfied)
        XCTAssertEqual(observed.includingCurrentFailures(current).verdict, .breached)
    }

    func testMCPNewOptionsAndMemoryCapture() throws {
        let request = try MCPServer.toolRequest(name: "spaceo_open_app", arguments: [
            "app": "Fixture.app", "allow_no_windows": true, "arguments": ["--display-id", "20"], "timeout": 3.0])
        XCTAssertTrue(request.allowNoWindows == true)
        XCTAssertEqual(request.arguments, ["--display-id", "20"])
        let image = try MCPServer.toolRequest(name: "spaceo_screenshot", arguments: [:])
        XCTAssertTrue(image.memory == true)
        XCTAssertNil(image.output)
        let place = try MCPServer.toolRequest(name: "spaceo_place_window", arguments: ["window": 42, "placement": "cover"])
        XCTAssertEqual(place.cmd, "place")
        XCTAssertTrue(DaemonCommand.ownerScopedMutations.contains(place.cmd))
        let click = try MCPServer.toolRequest(name: "spaceo_click", arguments: ["x": 2, "y": 3, "geometry": "old"])
        XCTAssertEqual(click.geometryToken, "old")
    }
}
