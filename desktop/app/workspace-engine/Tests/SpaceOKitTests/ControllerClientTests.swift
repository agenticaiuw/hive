import Foundation
import XCTest
@testable import SpaceOKit
@testable import SpaceOMCP

final class ControllerClientTests: XCTestCase {

    func testMCPCreateUsesControllerMetadataAndTracksOnlyReturnedLease() throws {
        let processIdentity = try XCTUnwrap(ProcessIdentity.current(of: getpid()))
        let defaultOwner = DurableSessionOwner(
            id: "mcp-test",
            kind: .mcp,
            label: "SpaceO MCP",
            processIdentity: processIdentity
        )
        let context = MCPControllerContext(
            owner: defaultOwner,
            diagnosticRunID: "controller-client-test",
            diagnosticMetrics: true)
        let translated = try MCPServer.toolRequest(
            name: "spaceo_session_create",
            arguments: [
                "name": "research",
                "controller_id": "controller-7",
                "controller_label": "Research agent",
                "controller_kind": "other",
                "ttl_seconds": 90,
            ],
            defaultControllerOwner: context.owner
        )
        let request = try context.prepare(translated)

        XCTAssertEqual(request.cmd, "session.create")
        XCTAssertEqual(request.session, "research")
        XCTAssertEqual(request.controllerOwner?.id, "controller-7")
        XCTAssertEqual(request.controllerOwner?.label, "Research agent")
        XCTAssertEqual(request.controllerOwner?.kind, .other)
        XCTAssertEqual(request.controllerOwner?.processIdentity, processIdentity)
        XCTAssertEqual(request.controllerTTLSeconds, 90)
        XCTAssertNotNil(request.controllerLeaseID)
        XCTAssertEqual(request.diagnosticRunID, "controller-client-test")
        XCTAssertEqual(request.diagnosticMetrics, true)

        let returnedLease = UUID()
        var response = Response(ok: true)
        response.session = try Self.sessionInfo(id: "research")
        response.controllerLeaseID = returnedLease
        context.record(response, for: request)

        let mutation = try context.prepare(MCPServer.toolRequest(
            name: "spaceo_open_app",
            arguments: ["session": "research", "app": "TextEdit"]
        ))
        XCTAssertEqual(mutation.controllerLeaseID, returnedLease,
                       "the daemon-returned credential, not a guessed value, is authoritative")

        let heartbeat = try context.prepare(MCPServer.toolRequest(
            name: "spaceo_session_heartbeat",
            arguments: ["session": "research"]
        ))
        XCTAssertEqual(heartbeat.cmd, "session.heartbeat")
        XCTAssertEqual(heartbeat.controllerLeaseID, returnedLease)

        let destroy = try context.prepare(MCPServer.toolRequest(
            name: "spaceo_session_destroy",
            arguments: ["session": "research"]
        ))
        XCTAssertEqual(destroy.controllerLeaseID, returnedLease)
    }

    /// After an MCP client restart the new connection holds no lease. Claiming must work without
    /// one, and the lease the daemon returns must be kept exactly like a created session's.
    func testMCPClaimNeedsNoLeaseAndKeepsTheReturnedOne() throws {
        let context = MCPControllerContext(owner: DurableSessionOwner(
            id: "mcp-after-restart", kind: .mcp, label: "SpaceO MCP"))
        let translated = try MCPServer.toolRequest(
            name: "spaceo_session_claim", arguments: ["session": "research"])
        let request = try context.prepare(translated)
        XCTAssertEqual(request.cmd, "session.claim")
        XCTAssertEqual(request.session, "research")
        XCTAssertNil(request.controllerLeaseID, "a claim presents no lease; it is issued one")
        XCTAssertEqual(request.controllerOwner?.id, "mcp-after-restart")
        XCTAssertEqual(request.orphanGraceSeconds, 120)

        let lease = UUID()
        var response = Response(ok: true)
        response.session = try Self.sessionInfo(id: "research")
        response.controllerLeaseID = lease
        context.record(response, for: request)
        XCTAssertEqual(context.storedLease(for: "research"), lease)
        let click = try context.prepare(MCPServer.toolRequest(
            name: "spaceo_click", arguments: ["session": "research", "x": 1, "y": 1]))
        XCTAssertEqual(click.controllerLeaseID, lease)

        XCTAssertThrowsError(try MCPServer.toolRequest(name: "spaceo_session_claim", arguments: [:]),
                             "claim never picks a session for the agent")
        XCTAssertTrue(MCPServer.toolSchemas.contains { $0["name"] as? String == "spaceo_session_claim" })
    }

    func testCLIClaimSendsOwnerWithoutLeaseAndPrintsTheNewLease() throws {
        let lease = UUID()
        let capture = RequestCapture()
        let result = try withServer(capture: capture) { socketPath in
            try runSpaceO(["session", "claim", "--session", "research", "--orphan-grace", "300",
                           "--socket", socketPath])
        } response: { _ in
            var response = Response.success("claimed 'research'")
            response.controllerLeaseID = lease
            return response
        }
        XCTAssertEqual(result.status, 0, result.standardError)
        let request = try XCTUnwrap(capture.value)
        XCTAssertEqual(request.cmd, "session.claim")
        XCTAssertEqual(request.session, "research")
        XCTAssertNil(request.controllerLeaseID)
        XCTAssertEqual(request.controllerOwner?.kind, .cli)
        XCTAssertEqual(request.orphanGraceSeconds, 300)
        XCTAssertTrue(result.standardOutput.contains(lease.uuidString.lowercased()))
    }

    func testMCPCreateAsksForTheLongerMCPOrphanGraceAndBoundsIt() throws {
        let owner = MCPControllerContext.defaultOwner()
        let defaulted = try MCPServer.toolRequest(
            name: "spaceo_session_create", arguments: [:], defaultControllerOwner: owner)
        XCTAssertEqual(defaulted.orphanGraceSeconds, 120)
        let explicit = try MCPServer.toolRequest(
            name: "spaceo_session_create", arguments: ["orphan_grace_seconds": 600],
            defaultControllerOwner: owner)
        XCTAssertEqual(explicit.orphanGraceSeconds, 600)
        for invalid in [29, 1_801] {
            XCTAssertThrowsError(try MCPServer.toolRequest(
                name: "spaceo_session_create", arguments: ["orphan_grace_seconds": invalid],
                defaultControllerOwner: owner))
        }
    }

    func testMCPPartialCreateRetainsOnlyReturnedSessionAndLease() throws {
        let context = MCPControllerContext()
        let request = try context.prepare(Request(cmd: "session.create"))
        let lease = UUID()
        var response = Response.failure(SpaceOError.badRequest("synthetic launch failure"))
        response.session = try Self.sessionInfo(id: "partial")
        context.record(response, for: request)
        XCTAssertNil(context.storedLease(for: "partial"))
        response.controllerLeaseID = lease
        response.session = nil
        context.record(response, for: request)
        XCTAssertTrue(context.renewalRequests().isEmpty)
        response.session = try Self.sessionInfo(id: "partial")
        context.record(response, for: request)
        XCTAssertEqual(context.storedLease(for: "partial"), lease)
        var heartbeat = Request(cmd: "session.heartbeat")
        heartbeat.session = "partial"
        XCTAssertEqual(try context.prepare(heartbeat).controllerLeaseID, lease)
        var destroy = Request(cmd: "session.destroy")
        destroy.session = "partial"
        XCTAssertEqual(try context.prepare(destroy).controllerLeaseID, lease)
        response.controllerLeaseID = UUID()
        context.record(response, for: heartbeat)
        context.record(response, for: destroy)
        XCTAssertEqual(context.storedLease(for: "partial"), lease)
    }

    func testCLIPartialCreatePrintsReturnedLeaseAndKeepsFailureStatus() throws {
        let lease = UUID()
        let capture = RequestCapture()
        let result = try withServer(capture: capture) { socketPath in
            try runSpaceO(["session", "create", "--session", "partial", "--socket", socketPath])
        } response: { _ in
            var response = Response.failure(SpaceOError.badRequest("synthetic launch failure"))
            response.controllerLeaseID = lease
            return response
        }
        XCTAssertEqual(result.status, 1)
        XCTAssertTrue(result.standardOutput.contains(lease.uuidString.lowercased()))
        XCTAssertTrue(result.standardOutput.contains("Keep this credential secret"))
        XCTAssertTrue(result.standardError.contains("synthetic launch failure"))
    }

    func testAutomaticRenewalCannotRestoreReleasedOrReplacementLease() throws {
        let context = MCPControllerContext()
        var create = Request(cmd: "session.create")
        create.session = "owned"
        var response = Response(ok: true)
        response.session = try Self.sessionInfo(id: "owned")
        response.controllerLeaseID = UUID()
        context.record(response, for: create)
        let heartbeat = try XCTUnwrap(context.renewalRequests().first)
        XCTAssertEqual(heartbeat.session, "owned")
        var destroy = Request(cmd: "session.destroy")
        destroy.session = "owned"
        context.record(.success(), for: destroy)
        context.record(response, for: heartbeat)
        XCTAssertTrue(context.renewalRequests().isEmpty)
        let replacement = UUID()
        var recreated = response
        recreated.controllerLeaseID = replacement
        context.record(recreated, for: create)
        context.record(response, for: heartbeat)
        XCTAssertEqual(context.storedLease(for: "owned"), replacement)
        let release = try MCPServer.toolRequest(name: "spaceo_session_destroy", arguments: ["session": "owned", "keep_apps": true])
        XCTAssertEqual(release.quitApps, false)
    }

    func testMCPRequiresConnectionLocalLeaseForHeartbeatAndMutations() throws {
        let context = MCPControllerContext(owner: DurableSessionOwner(
            id: "mcp-test",
            kind: .mcp,
            label: "SpaceO MCP"
        ))

        for request in [
            try MCPServer.toolRequest(
                name: "spaceo_session_heartbeat",
                arguments: ["session": "external"]
            ),
            try MCPServer.toolRequest(
                name: "spaceo_click",
                arguments: ["session": "external", "x": 10, "y": 20]
            ),
        ] {
            XCTAssertThrowsError(try context.prepare(request)) { error in
                XCTAssertTrue("\(error)".contains("not recoverable from session.list"))
            }
        }
    }

    func testMCPAllowsNamedDetachedDestroyWithoutAStoredLease() throws {
        let context = MCPControllerContext(owner: DurableSessionOwner(
            id: "mcp-test",
            kind: .mcp,
            label: "SpaceO MCP"
        ))

        let request = try context.prepare(MCPServer.toolRequest(
            name: "spaceo_session_destroy",
            arguments: ["session": "detached-from-prior-daemon"]
        ))

        XCTAssertEqual(request.cmd, "session.destroy")
        XCTAssertEqual(request.session, "detached-from-prior-daemon")
        XCTAssertNil(request.controllerLeaseID)
    }

    func testMCPFullDestroyIsScopedToThisConnectionsLeasedSessions() throws {
        let context = MCPControllerContext(
            owner: DurableSessionOwner(
                id: "mcp-a",
                kind: .mcp,
                label: "SpaceO MCP"
            ),
            diagnosticRunID: "full-destroy-test",
            diagnosticMetrics: true
        )
        let leases = try [("alpha", UUID()), ("beta", UUID())].map { id, lease -> UUID in
            let create = try context.prepare(MCPServer.toolRequest(
                name: "spaceo_session_create",
                arguments: ["name": id],
                defaultControllerOwner: context.owner
            ))
            var response = Response(ok: true)
            response.session = try Self.sessionInfo(id: id)
            response.controllerLeaseID = lease
            context.record(response, for: create)
            return lease
        }

        let plan = try context.plan(MCPServer.toolRequest(
            name: "spaceo_session_destroy",
            arguments: ["all": true]
        ))

        guard case .ownedSessionDestroy(let requests) = plan else {
            return XCTFail("a full destroy must never be forwarded to the daemon as written")
        }
        XCTAssertEqual(requests.map(\.session), ["alpha", "beta"])
        XCTAssertEqual(requests.map(\.controllerLeaseID), leases)
        XCTAssertTrue(requests.allSatisfy {
            $0.controllerOwner == context.owner
                && $0.diagnosticRunID == "full-destroy-test"
                && $0.diagnosticMetrics == true
        })
        XCTAssertTrue(requests.allSatisfy { $0.cmd == "session.destroy" && $0.full == nil },
                      "every request must be a named, lease-authorized destroy")
    }

    func testMCPFullDestroyWithoutOwnedSessionsSweepsNothing() throws {
        let context = MCPControllerContext(owner: DurableSessionOwner(
            id: "mcp-observer",
            kind: .mcp,
            label: "SpaceO MCP"
        ))

        let plan = try context.plan(MCPServer.toolRequest(
            name: "spaceo_session_destroy",
            arguments: ["all": true]
        ))

        guard case .ownedSessionDestroy(let requests) = plan else {
            return XCTFail("a full destroy must never be forwarded to the daemon as written")
        }
        XCTAssertTrue(requests.isEmpty)

        let outcome = MCPServer.destroyOwnedSessions(
            requests, socketPath: temporarySocketPath(), controller: context)
        XCTAssertFalse(outcome.failed)
        XCTAssertTrue(outcome.text.contains("nothing to destroy"), outcome.text)
        XCTAssertTrue(outcome.destroyed.isEmpty)
    }

    /// The aggregate destroy sends its own requests; their replies still name the daemon that
    /// produced them, and a different build there must surface as drift.
    func testAggregateDestroyBindsDriftToTheReplyingDaemon() throws {
        let daemon = StubDaemon()
        let socketPath = temporarySocketPath()
        let other = DaemonRuntimeInfo(version: "0.0.0-other", executableSHA256: nil,
            executableBuildUUID: UUID().uuidString, pid: 4_242, instanceID: UUID(), startedAt: Date())
        let server = Transport.Server(path: socketPath) { request in
            var response = daemon.handle(request)
            response.daemon = other
            return response
        }
        try server.start()
        defer { server.stop() }
        let context = MCPControllerContext(owner: DurableSessionOwner(id: "mcp-drift", kind: .mcp, label: "SpaceO MCP"))
        let create = try context.prepare(MCPServer.toolRequest(
            name: "spaceo_session_create", arguments: ["name": "drift-session"],
            defaultControllerOwner: context.owner))
        context.record(try Transport.send(create, to: socketPath, timeout: 5), for: create)
        guard case .ownedSessionDestroy(let requests) = try context.plan(MCPServer.toolRequest(
            name: "spaceo_session_destroy", arguments: ["all": true])) else {
            return XCTFail("a full destroy is planned per owned session")
        }
        XCTAssertNil(context.memory.daemonDrift)
        let outcome = MCPServer.destroyOwnedSessions(requests, socketPath: socketPath, controller: context, timeout: 5)
        XCTAssertEqual(outcome.destroyed, ["drift-session"])
        XCTAssertTrue(outcome.driftBound)
        XCTAssertTrue(context.memory.daemonDrift?.contains("0.0.0-other") == true)
    }

    /// Two agents share one daemon by design. One finishing its task must not quit the other's
    /// apps mid-work, which is exactly what forwarding `full` to the daemon used to do.
    func testMCPFullDestroyLeavesAnotherConnectionsSessionAlive() throws {
        let daemon = StubDaemon()
        let socketPath = temporarySocketPath()
        let server = Transport.Server(path: socketPath) { daemon.handle($0) }
        try server.start()
        defer { server.stop() }

        func connection(_ id: String, session: String) throws -> MCPControllerContext {
            let context = MCPControllerContext(owner: DurableSessionOwner(
                id: id, kind: .mcp, label: "SpaceO MCP"))
            let request = try context.prepare(MCPServer.toolRequest(
                name: "spaceo_session_create",
                arguments: ["name": session],
                defaultControllerOwner: context.owner
            ))
            let response = try Transport.send(request, to: socketPath, timeout: 5)
            XCTAssertTrue(response.ok, response.error ?? "")
            context.record(response, for: request)
            return context
        }

        let agentA = try connection("mcp-a", session: "a-session")
        _ = try connection("mcp-b", session: "b-session")
        XCTAssertEqual(daemon.liveSessionIDs(), ["a-session", "b-session"])

        let outcome: (text: String, failed: Bool, destroyed: [String], driftBound: Bool)
        switch try agentA.plan(MCPServer.toolRequest(
            name: "spaceo_session_destroy", arguments: ["all": true])) {
        case .ownedSessionDestroy(let requests):
            outcome = MCPServer.destroyOwnedSessions(
                requests, socketPath: socketPath, controller: agentA, timeout: 5)
        case .single(let request):
            // Send it anyway, so removing the scoping fails this test on the damage it causes
            // rather than on a request shape the assertions below would never reach.
            let response = try Transport.send(request, to: socketPath, timeout: 5)
            agentA.record(response, for: request)
            outcome = (response.message ?? response.error ?? "", !response.ok, response.ok ? [request.session ?? "?"] : [],
                       response.daemon != nil)
        }

        XCTAssertFalse(outcome.failed, outcome.text)
        XCTAssertEqual(outcome.destroyed, ["a-session"])
        XCTAssertEqual(daemon.liveSessionIDs(), ["b-session"],
                       "agent B's session and its apps must survive agent A's cleanup")
        XCTAssertFalse(daemon.sawUnauthorizedFullDestroy,
                       "the daemon's unauthorized machine-wide sweep must never be reached")
        XCTAssertTrue(outcome.text.contains("a-session"), outcome.text)
        XCTAssertFalse(outcome.text.contains("b-session"), outcome.text)
    }

    /// The lease-checking part of the daemon's `session.destroy` contract, without a window server.
    private final class StubDaemon: @unchecked Sendable {
        private let lock = NSLock()
        private var sessions: [String: UUID] = [:]
        private var unauthorizedFullDestroy = false

        func liveSessionIDs() -> [String] {
            lock.withLock { sessions.keys.sorted() }
        }

        var sawUnauthorizedFullDestroy: Bool {
            lock.withLock { unauthorizedFullDestroy }
        }

        func handle(_ request: Request) -> Response {
            func rejection(_ error: String) -> Response {
                var response = Response(ok: false)
                response.error = error
                return response
            }
            return lock.withLock {
                switch request.cmd {
                case "session.create":
                    guard let id = request.session, let lease = request.controllerLeaseID,
                          let info = try? ControllerClientTests.sessionInfo(id: id) else {
                        return rejection("create needs a session and lease")
                    }
                    sessions[id] = lease
                    var response = Response(ok: true)
                    response.session = info
                    response.controllerLeaseID = lease
                    response.message = "created '\(id)'"
                    return response
                case "session.destroy":
                    if request.session == nil, request.full == true {
                        // `destroyAllNow`: no `resolveForMutation`, no ownership check.
                        unauthorizedFullDestroy = true
                        sessions.removeAll()
                        return .success("destroyed all sessions")
                    }
                    guard let id = request.session, let lease = sessions[id] else {
                        return rejection("unknown session")
                    }
                    guard request.controllerLeaseID == lease else {
                        return rejection("controller lease does not match session '\(id)'")
                    }
                    sessions.removeValue(forKey: id)
                    return .success("destroyed '\(id)'")
                default:
                    return rejection("unexpected command '\(request.cmd)'")
                }
            }
        }
    }

    func testMCPPublishesHeartbeatAndRejectsInvalidControllerCreateArguments() throws {
        let names = MCPServer.toolSchemas.compactMap { $0["name"] as? String }
        XCTAssertTrue(names.contains("spaceo_session_heartbeat"))

        let owner = MCPControllerContext.defaultOwner()
        XCTAssertEqual(owner.kind, .mcp)
        XCTAssertEqual(owner.label, "SpaceO MCP")
        XCTAssertNotNil(owner.processIdentity)

        for arguments: [String: Any] in [
            ["ttl_seconds": 29],
            ["ttl_seconds": 3_601],
            ["controller_kind": "daemon"],
            ["controller_label": " untrimmed"],
        ] {
            XCTAssertThrowsError(try MCPServer.toolRequest(
                name: "spaceo_session_create",
                arguments: arguments,
                defaultControllerOwner: owner
            ))
        }
    }

    func testMCPRenderingNeverDisclosesTopLevelLeaseCredential() {
        let lease = UUID()
        var response = Response(ok: true)
        response.message = "created"
        response.controllerLeaseID = lease

        XCTAssertFalse(MCPServer.render(response).contains(lease.uuidString))
    }

    func testMCPListRenderingLabelsDetachedRecoveryMetadataAndStalePlacement() throws {
        var response = Response(ok: true)
        response.sessions = [try detachedSessionInfo()]

        let rendered = MCPServer.render(response)

        XCTAssertTrue(rendered.contains(
            "session 'detached' [detached recovery record; no live display target]"
        ), rendered)
        XCTAssertTrue(rendered.contains(
            "last-known placement only: tile 2/4 of display 44"
        ), rendered)
        XCTAssertTrue(rendered.contains("lifecycle: reclaimable"), rendered)
        XCTAssertTrue(rendered.contains(
            "owner: Research agent (mcp, id controller-gone)"
        ), rendered)
        XCTAssertTrue(rendered.contains("last activity: 2026-07-28T01:02:03Z"), rendered)
        XCTAssertTrue(rendered.contains("age: 367s"), rendered)
        XCTAssertTrue(rendered.contains(
            "recovery blocker process-identity-imprecise: exact process identity unavailable"
        ), rendered)
        XCTAssertTrue(rendered.contains("recorded app TextEdit (pid 4321)"), rendered)
        XCTAssertFalse(rendered.contains("session 'detached' on tile"), rendered)
    }

    func testCLICreateSendsControllerContractAndPrintsSecretGuidance() throws {
        let requestedLease = UUID()
        let returnedLease = UUID()
        let capture = RequestCapture()
        let result = try withServer(capture: capture) { socketPath in
            try runSpaceO([
                "session", "create",
                "--socket", socketPath,
                "--session", "research",
                "--controller-id", "cli-test",
                "--controller-label", "Test CLI",
                "--controller-kind", "other",
                "--controller-ttl", "90",
                "--lease", requestedLease.uuidString,
            ])
        } response: { request in
            var response = Response(ok: true)
            response.message = "created '\(request.session ?? "?")'"
            response.controllerLeaseID = returnedLease
            return response
        }

        XCTAssertEqual(result.status, 0, result.standardError)
        let request = try XCTUnwrap(capture.value)
        XCTAssertEqual(request.cmd, "session.create")
        XCTAssertEqual(request.session, "research")
        XCTAssertEqual(request.controllerOwner?.id, "cli-test")
        XCTAssertEqual(request.controllerOwner?.label, "Test CLI")
        XCTAssertEqual(request.controllerOwner?.kind, .other)
        XCTAssertNil(request.controllerOwner?.processIdentity,
                     "short-lived CLI process exit must not abandon the session")
        XCTAssertEqual(request.controllerTTLSeconds, 90)
        XCTAssertEqual(request.controllerLeaseID, requestedLease)
        XCTAssertTrue(result.standardOutput.contains(returnedLease.uuidString.lowercased()))
        XCTAssertTrue(result.standardOutput.contains("Keep this credential secret"))
        XCTAssertTrue(result.standardOutput.contains("--lease <UUID>"))
        XCTAssertTrue(result.standardOutput.contains("cannot be recovered"))
    }

    func testCLIHeartbeatRequiresAndForwardsLease() throws {
        let missing = try runSpaceO([
            "session", "heartbeat",
            "--socket", temporarySocketPath(),
            "--session", "research",
        ])
        XCTAssertNotEqual(missing.status, 0)
        XCTAssertTrue(missing.standardError.contains("--lease UUID is required"))

        let lease = UUID()
        let capture = RequestCapture()
        let result = try withServer(capture: capture) { socketPath in
            try runSpaceO([
                "session", "heartbeat",
                "--socket", socketPath,
                "--session", "research",
                "--lease", lease.uuidString,
            ])
        } response: { request in
            var response = Response(ok: true)
            response.message = "renewed"
            response.controllerLeaseID = request.controllerLeaseID
            return response
        }

        XCTAssertEqual(result.status, 0, result.standardError)
        XCTAssertEqual(capture.value?.cmd, "session.heartbeat")
        XCTAssertEqual(capture.value?.session, "research")
        XCTAssertEqual(capture.value?.controllerLeaseID, lease)
        XCTAssertTrue(result.standardOutput.contains(lease.uuidString.lowercased()))
    }

    func testCLIMutationForwardsLease() throws {
        let lease = UUID()
        let capture = RequestCapture()
        let result = try withServer(capture: capture) { socketPath in
            try runSpaceO([
                "run", "TextEdit",
                "--socket", socketPath,
                "--session", "research",
                "--lease", lease.uuidString,
            ])
        } response: { _ in
            Response.success("launched")
        }

        XCTAssertEqual(result.status, 0, result.standardError)
        XCTAssertEqual(capture.value?.cmd, "run")
        XCTAssertEqual(capture.value?.controllerLeaseID, lease)
    }

    func testCLIDestroyForwardsLease() throws {
        let lease = UUID()
        let capture = RequestCapture()
        let result = try withServer(capture: capture) { socketPath in
            try runSpaceO([
                "session", "destroy",
                "--socket", socketPath,
                "--session", "research",
                "--lease", lease.uuidString,
            ])
        } response: { _ in
            Response.success("destroyed")
        }

        XCTAssertEqual(result.status, 0, result.standardError)
        XCTAssertEqual(capture.value?.cmd, "session.destroy")
        XCTAssertEqual(capture.value?.session, "research")
        XCTAssertEqual(capture.value?.controllerLeaseID, lease)
    }

    func testCLIDaemonStopSupportsGlobalJSONOutput() throws {
        let capture = RequestCapture()
        let result = try withServer(capture: capture) { socketPath in
            try runSpaceO([
                "daemon", "stop",
                "--socket", socketPath,
                "--json",
            ])
        } response: { _ in
            Response.success("stopping SpaceO daemon")
        }

        XCTAssertEqual(result.status, 0, result.standardError)
        XCTAssertEqual(capture.value?.cmd, "daemon.stop")
        let payload = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(result.standardOutput.utf8))
                as? [String: Any]
        )
        XCTAssertEqual(payload["ok"] as? Bool, true)
        XCTAssertEqual(payload["message"] as? String, "stopping SpaceO daemon")
    }

    func testCLIListRenderingLabelsDetachedRecoveryMetadataAndStalePlacement() throws {
        let capture = RequestCapture()
        let detached = try detachedSessionInfo()
        let result = try withServer(capture: capture) { socketPath in
            try runSpaceO([
                "session", "list",
                "--socket", socketPath,
            ])
        } response: { _ in
            var response = Response(ok: true)
            response.sessions = [detached]
            return response
        }

        XCTAssertEqual(result.status, 0, result.standardError)
        XCTAssertEqual(capture.value?.cmd, "session.list")
        XCTAssertTrue(result.standardOutput.contains(
            "session detached  DETACHED RECOVERY RECORD"
        ), result.standardOutput)
        XCTAssertTrue(result.standardOutput.contains(
            "last-known placement only: display 44 (tile 2/4)"
        ), result.standardOutput)
        XCTAssertTrue(result.standardOutput.contains("not a live target"), result.standardOutput)
        XCTAssertTrue(result.standardOutput.contains(
            "lifecycle: reclaimable"
        ), result.standardOutput)
        XCTAssertTrue(result.standardOutput.contains(
            "owner: Research agent (mcp, id controller-gone)"
        ), result.standardOutput)
        XCTAssertTrue(result.standardOutput.contains(
            "last activity: 2026-07-28T01:02:03Z"
        ), result.standardOutput)
        XCTAssertTrue(result.standardOutput.contains("age: 367s"), result.standardOutput)
        XCTAssertTrue(result.standardOutput.contains(
            "! process-identity-imprecise: exact process identity unavailable"
        ), result.standardOutput)
        XCTAssertTrue(result.standardOutput.contains(
            "recorded app  pid 4321  TextEdit"
        ), result.standardOutput)
        XCTAssertFalse(result.standardOutput.contains(
            "session detached  display"
        ), result.standardOutput)
    }

    private static func sessionInfo(id: String) throws -> SessionInfo {
        let json = """
        {
          "id": "\(id)",
          "displayID": 7,
          "x": 0,
          "y": 0,
          "width": 1280,
          "height": 800,
          "tileIndex": 0,
          "tileCapacity": 1,
          "exclusiveDisplay": true,
          "spaces": [],
          "hasOwnSpace": false,
          "apps": [],
          "windows": [],
          "createdAt": "2026-07-28T00:00:00Z",
          "teardownPending": false
        }
        """
        return try Wire.decoder.decode(SessionInfo.self, from: Data(json.utf8))
    }

    private func detachedSessionInfo() throws -> SessionInfo {
        let json = """
        {
          "id": "detached",
          "displayID": 44,
          "x": 640,
          "y": 0,
          "width": 640,
          "height": 800,
          "tileIndex": 1,
          "tileCapacity": 4,
          "exclusiveDisplay": false,
          "spaces": [],
          "hasOwnSpace": false,
          "apps": [
            {
              "pid": 4321,
              "name": "TextEdit",
              "bundleID": "com.apple.TextEdit",
              "startedByUs": true
            }
          ],
          "windows": [],
          "createdAt": "2026-07-28T01:00:00Z",
          "teardownPending": false,
          "runtimeAttached": false,
          "controllerOwner": {
            "id": "controller-gone",
            "kind": "mcp",
            "label": "Research agent"
          },
          "ageSeconds": 367,
          "lastActivityAt": "2026-07-28T01:02:03Z",
          "abandoned": true,
          "reclaimable": true,
          "recoveryBlockers": [
            {
              "code": "process-identity-imprecise",
              "message": "exact process identity unavailable"
            }
          ]
        }
        """
        return try Wire.decoder.decode(SessionInfo.self, from: Data(json.utf8))
    }

    func testCLIBatchFailureKeepsCompletedFailedAndSkippedReceipts() throws {
        let capture = RequestCapture()
        let result = try withServer(capture: capture, run: { socket in
            try self.runSpaceO(["steps", "--steps-json", #"[{"cmd":"wait"}]"#, "--socket", socket])
        }, response: { _ in
            var response = Response(ok: false)
            response.error = "wait timed out"
            response.errorCode = "wait_timeout"
            response.firstFailureIndex = 1
            response.handoff = OperatorHandoff(note: "test resume", controlDurationSeconds: 1,
                                               windowsChanged: false, releasedAt: Date())
            response.steps = [
                StepReceipt(index: 0, cmd: "ax.find", ok: true, executed: true,
                            outline: "[3] Button — Save", snapshotID: "test-snapshot",
                            truncation: TruncationReport(shown: 25, truncated: true, reason: "web_find_cap")),
                StepReceipt(index: 1, cmd: "wait", ok: false, executed: true,
                            error: "wait timed out", completion: "timeout"),
                StepReceipt(index: 2, cmd: "click", ok: false, executed: false),
            ]
            return response
        })
        XCTAssertEqual(result.status, 6, "a batch that stopped on a timed-out wait exits with the wait class")
        XCTAssertTrue(result.standardOutput.hasPrefix("HUMAN HANDOFF:"))
        XCTAssertTrue(result.standardOutput.contains("step 0 ax.find: ok"))
        XCTAssertTrue(result.standardOutput.contains("[3] Button — Save"))
        XCTAssertTrue(result.standardOutput.contains("snapshot: test-snapshot"))
        XCTAssertTrue(result.standardOutput.contains("reason: web_find_cap"))
        XCTAssertTrue(result.standardOutput.contains("step 1 wait: FAILED"))
        XCTAssertTrue(result.standardOutput.contains("step 2 click: not executed"))
        XCTAssertTrue(result.standardOutput.contains("first failure index: 1"))
        XCTAssertTrue(result.standardError.contains("wait timed out"))
    }

    private final class RequestCapture: @unchecked Sendable {
        private let lock = NSLock()
        private var stored: Request?

        var value: Request? {
            lock.withLock { stored }
        }

        func set(_ request: Request) {
            lock.withLock { stored = request }
        }
    }

    private struct CLIResult {
        let status: Int32
        let standardOutput: String
        let standardError: String
    }

    private func withServer(
        capture: RequestCapture,
        run: (String) throws -> CLIResult,
        response: @escaping @Sendable (Request) -> Response
    ) throws -> CLIResult {
        let socketPath = temporarySocketPath()
        let server = Transport.Server(path: socketPath) { request in
            capture.set(request)
            return response(request)
        }
        try server.start()
        defer { server.stop() }
        return try run(socketPath)
    }

    private func temporarySocketPath() -> String {
        "/tmp/so-client-\(UUID().uuidString.prefix(12)).sock"
    }

    private func runSpaceO(_ arguments: [String]) throws -> CLIResult {
        let executable = Bundle(for: ControllerClientTests.self).bundleURL
            .deletingLastPathComponent()
            .appendingPathComponent("spaceo")
        guard FileManager.default.isExecutableFile(atPath: executable.path) else {
            throw XCTSkip("spaceo executable was not built next to the test bundle")
        }

        let process = Process()
        let standardOutput = Pipe()
        let standardError = Pipe()
        process.executableURL = executable
        process.arguments = arguments
        process.standardOutput = standardOutput
        process.standardError = standardError
        try process.run()
        process.waitUntilExit()

        return CLIResult(
            status: process.terminationStatus,
            standardOutput: String(
                data: standardOutput.fileHandleForReading.readDataToEndOfFile(),
                encoding: .utf8
            ) ?? "<non-UTF-8 stdout>",
            standardError: String(
                data: standardError.fileHandleForReading.readDataToEndOfFile(),
                encoding: .utf8
            ) ?? "<non-UTF-8 stderr>"
        )
    }
}
