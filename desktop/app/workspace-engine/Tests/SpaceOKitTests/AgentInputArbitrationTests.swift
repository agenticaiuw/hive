import CoreGraphics
import XCTest
@testable import SpaceOKit

final class AgentInputArbitrationTests: XCTestCase {
    private final class DisplayBacking: StageDisplayBacking {
        let displayID: CGDirectDisplayID = 97_001
        let bounds = CGRect(x: 0, y: 0, width: 1_280, height: 800)
        private let lock = NSLock()
        private var attached = true

        var valid: Bool { lock.withLock { attached } }
        func invalidate() { lock.withLock { attached = false } }
        var isAttached: Bool { lock.withLock { attached } }
    }

    private func manager(isolation: @escaping @Sendable () -> IsolationReport? = { nil }) -> SessionManager {
        let backing = DisplayBacking()
        let stage = Stage(
            testingBacking: backing,
            onlineDisplayIDs: { backing.isAttached ? [backing.displayID] : [] })
        let pool = DisplayPool(
            sessionsPerDisplay: 1,
            displaySize: backing.bounds.size,
            stageFactory: { _, _, _, _ in stage },
            stageRetirer: { $0.invalidate(waitingForRemoval: 0) })
        return SessionManager(
            pool: pool,
            runJanitor: false,
            isolationPreflight: isolation,
            sessionFactory: { AgentSession(id: $0, slot: $1) })
    }

    func testKnownIsolationBreachPausesBeforeResolvingInputTarget() async throws {
        let report = IsolationReport(checks: [.init(dimension: .menuBarOwner, coverage: .observed,
            status: .failed, evidence: "synthetic current state", failures: ["owned focus"])])
        let manager = manager(isolation: { report })
        let create = await manager.handle(TestController.createRequest(session: "breach"))
        XCTAssertTrue(create.ok)
        var click = TestController.request("click", session: "breach")
        click.x = 1; click.y = 1
        let response = await manager.handle(click)
        XCTAssertEqual(response.errorCode, "isolation_breached")
        let session = try await manager.resolve("breach")
        XCTAssertTrue(session.agentInputSnapshot().paused)
        let next = await manager.handle(click)
        XCTAssertTrue(next.error?.contains("paused") == true)
        var destroy = TestController.request("session.destroy", session: "breach")
        destroy.operatorScope = true
        let destroyed = await manager.handle(destroy)
        XCTAssertTrue(destroyed.ok)
    }

    func testUnknownRequiredIsolationRefusesBeforeInputWithoutInventingBreach() async throws {
        let manager = manager()
        let create = await manager.handle(TestController.createRequest(session: "unknown"))
        XCTAssertTrue(create.ok)
        var click = TestController.request("click", session: "unknown")
        click.x = 1; click.y = 1
        click.requiredIsolation = [.keyInputRoute]
        let response = await manager.handle(click)
        XCTAssertEqual(response.errorCode, "isolation_requirements_unmet")
        let session = try await manager.resolve("unknown")
        XCTAssertFalse(session.agentInputSnapshot().paused)
        let destroyed = await manager.handle(TestController.request("session.destroy", session: "unknown"))
        XCTAssertTrue(destroyed.ok)
    }

    func testOperatorPauseRefusesInputUntilResumeAndAppearsInTelemetry() async throws {
        let manager = manager()
        let create = await manager.handle(TestController.createRequest(session: "arbitration"))
        XCTAssertTrue(create.ok, create.error ?? "")

        var pause = Request(cmd: "session.control")
        pause.session = "arbitration"
        pause.paused = true
        pause.operatorScope = true
        let paused = await manager.handle(pause)
        XCTAssertTrue(paused.ok, paused.error ?? "")
        XCTAssertEqual(paused.session?.inputPaused, true)

        let session = try await manager.resolve("arbitration")
        XCTAssertThrowsError(try session.requireAgentInputAllowed(action: "click")) { error in
            XCTAssertTrue(error.localizedDescription.contains("paused by the human operator"))
        }

        var resume = pause
        resume.paused = false
        let resumed = await manager.handle(resume)
        XCTAssertTrue(resumed.ok, resumed.error ?? "")
        XCTAssertEqual(resumed.session?.inputPaused, false)
        XCTAssertNoThrow(try session.requireAgentInputAllowed(action: "click"))

        var destroy = Request(cmd: "session.destroy")
        destroy.session = "arbitration"
        destroy.operatorScope = true
        let destroyed = await manager.handle(destroy)
        XCTAssertTrue(destroyed.ok, destroyed.error ?? "")
    }

    /// The pause exists to give a person priority over the agent holding the lease, so that
    /// agent must not be able to lift it. A pause the agent set itself may be lifted by either.
    func testLeaseHolderCannotResumeAnOperatorPause() async throws {
        let manager = manager()
        let create = await manager.handle(TestController.createRequest(session: "priority"))
        XCTAssertTrue(create.ok, create.error ?? "")
        let lease = try XCTUnwrap(create.controllerLeaseID)

        var operatorPause = Request(cmd: "session.control")
        operatorPause.session = "priority"
        operatorPause.paused = true
        operatorPause.operatorScope = true
        let paused = await manager.handle(operatorPause)
        XCTAssertTrue(paused.ok, paused.error ?? "")

        var agentResume = Request(cmd: "session.control")
        agentResume.session = "priority"
        agentResume.paused = false
        agentResume.controllerLeaseID = lease
        let refused = await manager.handle(agentResume)
        XCTAssertFalse(refused.ok, "the paused agent resumed itself")
        XCTAssertTrue(refused.error?.contains("human operator") == true, refused.error ?? "")
        let session = try await manager.resolve("priority")
        XCTAssertThrowsError(try session.requireAgentInputAllowed(action: "type"))

        var operatorResume = operatorPause
        operatorResume.paused = false
        let resumed = await manager.handle(operatorResume)
        XCTAssertTrue(resumed.ok, resumed.error ?? "")
        XCTAssertNoThrow(try session.requireAgentInputAllowed(action: "type"))

        // The agent's own pause is its own to clear.
        var agentPause = agentResume
        agentPause.paused = true
        let selfPaused = await manager.handle(agentPause)
        XCTAssertTrue(selfPaused.ok, selfPaused.error ?? "")
        let selfResumed = await manager.handle(agentResume)
        XCTAssertTrue(selfResumed.ok, selfResumed.error ?? "")

        // Launching into a paused tile is input too: a new window lands where a person works.
        _ = await manager.handle(operatorPause)
        var run = Request(cmd: "run")
        run.session = "priority"
        run.app = "TextEdit"
        run.controllerLeaseID = lease
        let launch = await manager.handle(run)
        XCTAssertFalse(launch.ok)
        XCTAssertTrue(launch.error?.contains("paused by the human operator") == true, launch.error ?? "")

        var destroy = Request(cmd: "session.destroy")
        destroy.session = "priority"
        destroy.operatorScope = true
        let destroyed = await manager.handle(destroy)
        XCTAssertTrue(destroyed.ok, destroyed.error ?? "")
    }

    func testSessionIDsAreBounded() {
        XCTAssertNoThrow(try SessionManager.canonicalSessionID(
            String(repeating: "a", count: SessionManager.maximumSessionIDCharacters)))
        XCTAssertThrowsError(try SessionManager.canonicalSessionID(
            String(repeating: "a", count: SessionManager.maximumSessionIDCharacters + 1)))
        // Character count within bounds, byte count not: a multi-scalar grapheme cluster is
        // one Character but 25 UTF-8 bytes.
        XCTAssertThrowsError(try SessionManager.canonicalSessionID(
            String(repeating: "👨‍👩‍👧‍👦", count: 30)))
    }

    func testLatestAgentActionIsPublishedWithItsTimestamp() async throws {
        let manager = manager()
        let create = await manager.handle(TestController.createRequest(session: "activity"))
        XCTAssertTrue(create.ok, create.error ?? "")
        let session = try await manager.resolve("activity")
        let at = Date(timeIntervalSince1970: 1_234)
        session.recordAgentInputAction("drag", at: at)

        var list = Request(cmd: "session.list")
        list.operatorScope = true
        let response = await manager.handle(list)
        let info = try XCTUnwrap(response.sessions?.first { $0.id == "activity" })
        XCTAssertEqual(info.lastAgentAction, "drag")
        XCTAssertEqual(info.lastAgentActionAt, at)

        var destroy = Request(cmd: "session.destroy")
        destroy.session = "activity"
        destroy.operatorScope = true
        let destroyed = await manager.handle(destroy)
        XCTAssertTrue(destroyed.ok, destroyed.error ?? "")
    }
}
