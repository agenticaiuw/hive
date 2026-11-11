import CoreGraphics
import XCTest
@testable import SpaceOKit
@testable import SpaceOViewer

/// SPAO-205. The walkthrough's "Try it" step is the ordinary operator create followed by a
/// `run` under the returned lease; the "Connect" step prints the exact registration text.
final class ViewerWalkthroughTests: XCTestCase {

    private final class RequestRecorder: @unchecked Sendable {
        private let lock = NSLock()
        private var storage: [Request] = []
        func append(_ request: Request) { lock.withLock { storage.append(request) } }
        var requests: [Request] { lock.withLock { storage } }
    }

    @MainActor
    func testTryItCreatesASessionThenRunsTextEditUnderTheSameLease() async throws {
        let recorder = RequestRecorder()
        let json = """
        {
          "id":"walk","displayID":7,"x":0,"y":0,"width":100,"height":100,
          "tileIndex":0,"tileCapacity":1,"exclusiveDisplay":true,
          "spaces":[],"hasOwnSpace":true,"apps":[],"windows":[],
          "createdAt":"2026-07-30T00:00:00Z","teardownPending":false,"runtimeAttached":true
        }
        """
        let session = try Wire.decoder.decode(SessionInfo.self, from: Data(json.utf8))
        let model = ViewerModel(
            automaticRefresh: false,
            daemonTransport: { request in
                recorder.append(request)
                switch request.cmd {
                case "session.create":
                    var response = Response(ok: true)
                    response.session = session
                    response.controllerLeaseID = request.controllerLeaseID
                    return response
                case "session.list":
                    var response = Response(ok: true)
                    response.sessions = [session]
                    return response
                default:
                    return .success("launched")
                }
            },
            accessibilityAnnouncement: { _ in })

        XCTAssertFalse(model.walkthroughSessionCreated)
        model.createSessionAndLaunch(app: "TextEdit")
        try await waitUntil { model.walkthroughSessionCreated }

        let sequence = recorder.requests.filter { ["session.create", "run"].contains($0.cmd) }
        XCTAssertEqual(sequence.map(\.cmd), ["session.create", "run"])
        let create = sequence[0]
        let run = sequence[1]
        XCTAssertEqual(create.controllerOwner?.kind, .viewer)
        XCTAssertNotNil(create.controllerLeaseID)
        XCTAssertEqual(run.session, "walk")
        XCTAssertEqual(run.app, "TextEdit")
        XCTAssertEqual(run.controllerLeaseID, create.controllerLeaseID,
                       "the launch runs under the lease the create returned")
        XCTAssertNil(run.files)
        XCTAssertEqual(model.viewerOwnedLeases["walk"], create.controllerLeaseID,
                       "the lease is kept so the poll heartbeats it")
        XCTAssertFalse(model.walkthroughLaunchInFlight)
    }

    @MainActor
    func testFailedLaunchIsReportedAndDoesNotMarkTheStepDone() async throws {
        let model = ViewerModel(
            automaticRefresh: false,
            daemonTransport: { request in
                request.cmd == "session.create"
                    ? .failure(SpaceOError.badRequest("no capacity"))
                    : .success()
            },
            accessibilityAnnouncement: { _ in })
        model.createSessionAndLaunch(app: "TextEdit")
        try await waitUntil { model.events.contains { $0.title == "Walkthrough step failed" } }
        XCTAssertFalse(model.walkthroughSessionCreated)
        XCTAssertFalse(model.walkthroughLaunchInFlight)
    }

    @MainActor
    func testWalkthroughVisibilityIsRememberedAndHelpBringsItBack() {
        let model = ViewerModel(automaticRefresh: false, accessibilityAnnouncement: { _ in })
        model.applyControlPlane(sessions: [], poolResponse: Response(ok: true))
        XCTAssertTrue(model.walkthroughInline, "a first launch shows the card")
        model.dismissWalkthrough()
        XCTAssertFalse(model.walkthroughInline)
        XCTAssertTrue(model.preferences.walkthroughDismissed)
        model.presentWalkthrough()
        XCTAssertTrue(model.walkthroughPresented)
    }

    func testRegistrationCommandsMatchTheSetupDocumentation() {
        let path = "/Users/me/.local/bin/spaceo"
        XCTAssertEqual(
            ViewerAgentClient.claudeCode.registrationCommand(spaceoPath: path),
            "claude mcp add -s user spaceo -- '/Users/me/.local/bin/spaceo' mcp")
        XCTAssertEqual(
            ViewerAgentClient.codex.registrationCommand(spaceoPath: path),
            """
            [mcp_servers.spaceo]
            command = "/Users/me/.local/bin/spaceo"
            args = ["mcp"]
            """)
        XCTAssertEqual(
            ViewerAgentClient.cursor.registrationCommand(spaceoPath: path),
            ViewerAgentClient.claudeDesktop.registrationCommand(spaceoPath: path),
            "Cursor and Claude Desktop share the mcpServers JSON shape")
        XCTAssertTrue(ViewerAgentClient.cursor.registrationCommand(spaceoPath: path)
            .contains("\"command\": \"/Users/me/.local/bin/spaceo\", \"args\": [\"mcp\"]"))
    }

    func testRegistrationCommandsQuoteHostilePaths() {
        let path = "/Users/o'brien/bin/space\"o"
        XCTAssertEqual(
            ViewerAgentClient.claudeCode.registrationCommand(spaceoPath: path),
            "claude mcp add -s user spaceo -- '/Users/o'\"'\"'brien/bin/space\"o' mcp")
        XCTAssertTrue(ViewerAgentClient.codex.registrationCommand(spaceoPath: path)
            .contains("command = \"/Users/o'brien/bin/space\\\"o\""))
        XCTAssertEqual(
            ViewerAgentClient.claudeCode.registrationCommand(spaceoPath: "spaceo"),
            "claude mcp add -s user spaceo -- spaceo mcp",
            "the bare command is left for PATH lookup")
    }

    @MainActor
    private func waitUntil(timeout: TimeInterval = 2, _ condition: @MainActor () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTFail("condition was not met within \(timeout)s")
    }
}
