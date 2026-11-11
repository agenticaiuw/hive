import XCTest
import CoreGraphics
@testable import SpaceOKit

/// An owned app dying is the one lifecycle event that leaves no other trace.
///
/// README documents the daemon log as carrying "every failed request, janitor reclamation, and
/// lifecycle event". Reclaiming a whole abandoned *session* was recorded (`janitor.reaped`'s
/// sibling `janitor.reclaimed`); reclaiming the apps *inside* a live session was not. The session
/// simply went from "1 app, 1 window" to empty: no failed request, no findings once the ledger had
/// forgotten the app, and nothing in the log at any point.
///
/// Observed on 2026-08-29: a SpaceO-launched `SpaceO Viewer` owned by session `claude-viewer`
/// disappeared from the session between two commands. The only evidence in
/// `~/Library/Logs/SpaceO/daemon.log` for that whole minute was the two `window not found`
/// failures from the *next* command — the app's removal itself was silent, which is what made the
/// disappearance impossible to reason about after the fact.
final class JanitorReapObservabilityTests: XCTestCase {

    /// `SessionManager` writes through `DaemonLog.shared`, the way the daemon does, so the test
    /// points that singleton at a file it owns. The directory is per-class and deliberately not
    /// removed: `event()` is called from `SessionManager` for the rest of the test process, and
    /// deleting the path out from under it would turn later, unrelated tests into a stderr
    /// warning about an unwritable log. One small file in `$TMPDIR` is the cheaper trade.
    private static let directory: URL = {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("spaceo-janitor-reap-observability")
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }()

    private var logURL: URL { Self.directory.appendingPathComponent("daemon.log") }

    override func setUpWithError() throws {
        try? FileManager.default.removeItem(at: logURL)
        try DaemonLog.shared.configure(fileURL: logURL)
        ProcessOwnership.reset()
        AgentActivity.reset()
    }

    override func tearDownWithError() throws {
        ProcessOwnership.reset()
        AgentActivity.reset()
    }

    private final class CapturedSessions: @unchecked Sendable {
        private let lock = NSLock()
        private var sessions: [AgentSession] = []

        func add(_ session: AgentSession) { lock.withLock { sessions.append(session) } }
        var first: AgentSession? { lock.withLock { sessions.first } }
    }

    private final class DisplayBacking: StageDisplayBacking {
        let displayID: CGDirectDisplayID
        let bounds = CGRect(x: 0, y: 0, width: 1_280, height: 800)
        private let lock = NSLock()
        private var attached = true

        init(displayID: CGDirectDisplayID) { self.displayID = displayID }

        var valid: Bool { lock.withLock { attached } }
        func invalidate() { lock.withLock { attached = false } }
        var isAttached: Bool { lock.withLock { attached } }
    }

    private func makePool(displayID: CGDirectDisplayID) -> DisplayPool {
        let backing = DisplayBacking(displayID: displayID)
        let stage = Stage(
            testingBacking: backing,
            onlineDisplayIDs: { backing.isAttached ? [displayID] : [] })
        return DisplayPool(
            sessionsPerDisplay: 1,
            displaySize: backing.bounds.size,
            stageFactory: { _, _, _, _ in stage },
            stageRetirer: { $0.invalidate(waitingForRemoval: 0) })
    }

    /// This process's pid paired with a start time it does not have. `isAlive` compares both, so
    /// the identity is precisely, deterministically dead without launching or killing anything.
    private func deadApp(named name: String) -> LaunchedApp {
        let identity = ProcessIdentity(pid: getpid(), startedAtMicroseconds: 1)
        XCTAssertFalse(identity.isAlive, "the fixture must be a dead identity")
        return LaunchedApp(
            pid: identity.pid,
            identity: identity,
            bundleIdentifier: "dev.spaceo.janitor-reap-test",
            name: name,
            url: URL(fileURLWithPath: "/Applications/\(name).app"),
            startedByUs: true,
            devToolsPort: nil,
            temporaryProfile: nil)
    }

    private func logRecords() throws -> [[String: String]] {
        guard let text = try? String(contentsOf: logURL, encoding: .utf8) else { return [] }
        return try text.split(separator: "\n").map {
            try XCTUnwrap(JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: String])
        }
    }

    func testReapingAnOwnedAppIsRecordedInTheDaemonLog() async throws {
        let pool = makePool(displayID: 93_001)
        let created2 = CapturedSessions()
        let manager = SessionManager(
            pool: pool,
            runJanitor: false,
            sessionFactory: { id, slot in
                let session = AgentSession(id: id, slot: slot)
                created2.add(session)
                return session
            })
        let created = await manager.handle(TestController.createRequest())
        let sessionID = try XCTUnwrap(created.session?.id)
        // Awaited by XCTest, and it still runs when an assertion above fails. A fire-and-forget
        // `defer { Task { ... } }` races the next test for the same display id and can leave
        // a session alive past the assertion that was supposed to prove it gone.
        addTeardownBlock { _ = try? await manager.destroyAll(quitApps: false) }

        let session = try XCTUnwrap(created2.first)
        session.register(app: deadApp(named: "SpaceO Viewer"), windows: [])
        XCTAssertEqual(session.apps.count, 1)

        let reaped = try await manager.runJanitorPass()
        XCTAssertEqual(reaped, 1)
        XCTAssertEqual(session.apps.count, 0, "the janitor should have removed the dead app")

        let all = try logRecords()
        let records = all.filter { $0["kind"] == "janitor.reaped" }
        XCTAssertEqual(records.count, 1, """
            the app vanished from the session with nothing written to the daemon log; \
            records were \(all.map { $0["kind"] ?? "?" })
            """)
        // Unwrap rather than subscript: when this regresses there is no record at all, and a
        // subscript trap kills the whole xctest process instead of failing one test.
        let record = try XCTUnwrap(records.first)
        XCTAssertEqual(record["session"], sessionID)
        XCTAssertEqual(record["apps"], "1")
        XCTAssertEqual(record["names"], "SpaceO Viewer",
                       "the record has to name what died, or it cannot answer which app it was")
    }

    /// The log has to stay small enough to read whole: a pass that reaps nothing must be silent.
    func testAJanitorPassThatReapsNothingWritesNothing() async throws {
        let pool = makePool(displayID: 93_002)
        let manager = SessionManager(
            pool: pool, runJanitor: false,
            sessionFactory: { AgentSession(id: $0, slot: $1) })
        _ = await manager.handle(TestController.createRequest())
        // Awaited by XCTest, and it still runs when an assertion above fails. A fire-and-forget
        // `defer { Task { ... } }` races the next test for the same display id and can leave
        // a session alive past the assertion that was supposed to prove it gone.
        addTeardownBlock { _ = try? await manager.destroyAll(quitApps: false) }

        let reaped = try await manager.runJanitorPass()
        XCTAssertEqual(reaped, 0)
        XCTAssertEqual(try logRecords().filter { $0["kind"] == "janitor.reaped" }.count, 0)
    }
}
