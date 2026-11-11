import XCTest
import CoreGraphics
@testable import SpaceOKit

/// PAR-27: a `WindowWatcher` that cannot be built must not vanish without a trace.
///
/// The watcher is both mechanisms ARCHITECTURE.md §3.2 promises — the AX notification *and* the
/// periodic sweep behind it — and every health signal used to be derived from the dictionary the
/// failed watcher never entered. An app with no watcher therefore contributed nothing to the
/// audit, nothing to the containment counters, and nothing to the sweep: it looked perfect
/// precisely because nothing was watching it.
final class UnwatchedAppContainmentTests: XCTestCase {

    // MARK: - Fakes

    private final class FakeDisplayBacking: StageDisplayBacking, @unchecked Sendable {
        let bounds = CGRect(x: 0, y: 0, width: 1280, height: 800)
        private let lock = NSLock()
        private var id: CGDirectDisplayID

        init(id: CGDirectDisplayID) { self.id = id }

        var displayID: CGDirectDisplayID { lock.withLock { id } }
        var valid: Bool { lock.withLock { id != 0 } }
        func invalidate() { lock.withLock { id = 0 } }
    }

    /// A WindowServer whose geometry the test owns. `move` records the new frame the way the real
    /// one does, so `liveBounds` afterwards is the same authoritative re-read production performs.
    private final class FakeWindowServer: @unchecked Sendable {
        private let lock = NSLock()
        private var frames: [CGWindowID: CGRect] = [:]
        private var owner: [CGWindowID: pid_t] = [:]
        private(set) var moveCount = 0

        func add(window: CGWindowID, pid: pid_t, at frame: CGRect) {
            lock.withLock {
                frames[window] = frame
                owner[window] = pid
            }
        }

        func frame(of window: CGWindowID) -> CGRect? { lock.withLock { frames[window] } }

        var driver: SessionWindowDriver {
            SessionWindowDriver(
                windows: { [self] pid in
                    lock.withLock {
                        owner.filter { $0.value == pid }
                            .map { WindowRef(windowID: $0.key, pid: pid,
                                             title: "window \($0.key)",
                                             frame: frames[$0.key] ?? .zero) }
                            .sorted { $0.windowID < $1.windowID }
                    }
                },
                userDisplayBounds: { CGRect(x: 0, y: 0, width: 1440, height: 900) },
                move: { [self] window, frame in
                    lock.withLock {
                        moveCount += 1
                        frames[window.windowID] = frame
                    }
                },
                liveBounds: { [self] id in lock.withLock { frames[id] } })
        }
    }

    private struct RefusedWatcher: Error, CustomStringConvertible {
        var description: String { "Accessibility permission is off (test injection)" }
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

    private func makePool(displayID: CGDirectDisplayID) -> DisplayPool {
        let backing = FakeDisplayBacking(id: displayID)
        let stage = Stage(testingBacking: backing, onlineDisplayIDs: { [displayID] })
        return DisplayPool(
            sessionsPerDisplay: 1,
            displaySize: backing.bounds.size,
            stageFactory: { _, _, _, _ in stage },
            stageRetirer: { $0.invalidate(waitingForRemoval: 0) })
    }

    /// The session's own process, so `identity.isAlive` is true for the whole test without
    /// launching anything. Only the ledger is exercised here; no window is really touched.
    private func makeLiveApp() throws -> LaunchedApp {
        let identity = try XCTUnwrap(ProcessIdentity.current(of: getpid()))
        return LaunchedApp(
            pid: identity.pid,
            identity: identity,
            bundleIdentifier: "dev.spaceo.unwatched-test",
            name: "Unwatchable",
            url: URL(fileURLWithPath: "/Applications/Unwatchable.app"),
            startedByUs: true,
            devToolsPort: nil,
            temporaryProfile: nil)
    }

    private func makeSession(
        id: String,
        pool: DisplayPool,
        server: FakeWindowServer,
        watcherFactory: @escaping WindowWatcherFactory
    ) throws -> AgentSession {
        try AgentSession(
            id: id,
            slot: try pool.allocate(),
            teardownDriver: SessionAppTeardownDriver(
                isAlive: { _ in false },
                quit: { _, _ in },
                waitForExit: { _, _ in [] },
                cleanupTemporaryProfile: { _ in }),
            windowDriver: server.driver,
            watcherFactory: watcherFactory,
            initialApps: [])
    }

    // MARK: - The failure is recorded rather than dropped

    func testAWatcherThatCannotBeBuiltIsRecordedAndAudited() throws {
        let pool = makePool(displayID: 91_001)
        let server = FakeWindowServer()
        let session = try makeSession(id: "unwatched-audit", pool: pool, server: server,
                                      watcherFactory: { _, _ in throw RefusedWatcher() })
        defer { session.destroy(quitApps: false); _ = pool.releaseAll() }

        let app = try makeLiveApp()
        session.register(app: app, windows: [])

        XCTAssertEqual(session.watcherCreationFailures[app.pid],
                       "Accessibility permission is off (test injection)",
                       "a watcher that failed to construct must leave the reason behind; "
                       + "assigning nil into the dictionary records nothing at all")
        XCTAssertEqual(session.unwatchedApps.count, 1,
                       "an owned app with no watcher must be visible as unwatched")

        let findings = session.audit()
        XCTAssertTrue(findings.contains { $0.contains("no window watcher could be installed")
                                       && $0.contains("Unwatchable") },
                      "the audit must name the unwatched app, not pass silently: \(findings)")
    }

    /// The bug this ticket is really about: every health signal was derived from the dictionary
    /// the failed watcher never entered, so a session with no containment at all reported perfect
    /// health.
    func testAnUnwatchedAppIsNotReportedAsHealthyByTheContainmentCounters() throws {
        let pool = makePool(displayID: 91_002)
        let server = FakeWindowServer()
        let session = try makeSession(id: "unwatched-counters", pool: pool, server: server,
                                      watcherFactory: { _, _ in throw RefusedWatcher() })
        defer { session.destroy(quitApps: false); _ = pool.releaseAll() }

        let app = try makeLiveApp()
        session.register(app: app, windows: [])

        // Both of these read exactly as they would for a *healthy* session, because both are
        // derived from the dictionary the failed watcher never entered.
        XCTAssertEqual(session.containment.placed, 0)
        XCTAssertEqual(session.containment.refused, 0)
        XCTAssertEqual(session.watcherRegistrationFailures, [],
                       "a watcher that never existed cannot report a registration failure")

        // So the unwatched-app finding is the only thing left that can surface the failure.
        XCTAssertTrue(session.audit().contains { $0.contains("Unwatchable") },
                      "with every watcher-derived counter silent, an audit that does not report "
                      + "the unwatched app reports a healthy session with no containment at all")
    }

    // MARK: - The janitor takes over containment

    func testTheJanitorReparksAStrayWindowOfAnUnwatchedApp() throws {
        let pool = makePool(displayID: 91_003)
        let server = FakeWindowServer()
        let session = try makeSession(id: "unwatched-repark", pool: pool, server: server,
                                      watcherFactory: { _, _ in throw RefusedWatcher() })
        defer { session.destroy(quitApps: false); _ = pool.releaseAll() }

        let app = try makeLiveApp()
        session.register(app: app, windows: [])

        // The "Reopen?" dialog from the ticket: on the user's screen, a second after launch.
        let stray: CGWindowID = 4_242
        server.add(window: stray, pid: app.pid,
                   at: CGRect(x: 3_000, y: 2_000, width: 480, height: 320))
        XCTAssertFalse(WindowPlacement.isFullyInside(
            try XCTUnwrap(server.frame(of: stray)), session.frame))

        // No hand-driven sweep: the janitor pass is the only thing acting here, and
        // `sweepStrayWindows()` inside it is a structural no-op for an app with no watcher.
        session.runJanitorPass()

        let landed = try XCTUnwrap(server.frame(of: stray))
        XCTAssertTrue(WindowPlacement.isFullyInside(landed, session.frame),
                      "the janitor must re-park a stray window of an unwatched app; "
                      + "it landed at \(landed) for tile \(session.frame)")
    }

    func testAWatchedAppIsLeftToItsOwnWatcherByTheFallback() throws {
        let pool = makePool(displayID: 91_004)
        let server = FakeWindowServer()
        let app = try makeLiveApp()
        guard let watcher = try? WindowWatcher(pid: app.pid, region: { .zero },
                                               periodicSweep: false) else {
            throw XCTSkip("AXObserverCreate is unavailable in this environment")
        }
        let session = try makeSession(id: "watched-skip", pool: pool, server: server,
                                      watcherFactory: { _, _ in watcher })
        defer { session.destroy(quitApps: false); _ = pool.releaseAll() }

        session.register(app: app, windows: [])
        server.add(window: 7, pid: app.pid,
                   at: CGRect(x: 3_000, y: 2_000, width: 480, height: 320))

        XCTAssertEqual(session.unwatchedApps, [])
        XCTAssertEqual(session.reparkUnwatchedWindows(), 0,
                       "an app with a live watcher sweeps itself; the fallback must not "
                       + "duplicate that work on every janitor tick")
    }

    // MARK: - Recovery

    /// `AXObserverCreate` fails for transient reasons — Accessibility toggled off, or a pid
    /// adopted before its process was AX-registered — so giving up once would leave a session
    /// degraded for its whole life over a refusal that has since cleared.
    func testTheJanitorReinstallsAWatcherOnceItCanBeBuiltAgain() throws {
        let pool = makePool(displayID: 91_005)
        let server = FakeWindowServer()
        let app = try makeLiveApp()
        guard let recovered = try? WindowWatcher(pid: app.pid, region: { .zero },
                                                 periodicSweep: false) else {
            throw XCTSkip("AXObserverCreate is unavailable in this environment")
        }

        let accessibilityIsBack = NSLock()
        var permitted = false
        let session = try makeSession(id: "unwatched-recovers", pool: pool, server: server,
                                      watcherFactory: { _, _ in
            guard accessibilityIsBack.withLock({ permitted }) else { throw RefusedWatcher() }
            return recovered
        })
        defer { session.destroy(quitApps: false); _ = pool.releaseAll() }

        session.register(app: app, windows: [])
        XCTAssertEqual(session.unwatchedApps.count, 1)

        accessibilityIsBack.withLock { permitted = true }
        session.runJanitorPass()

        XCTAssertEqual(session.unwatchedApps, [],
                       "the janitor must retry construction, not stay degraded forever")
        XCTAssertNil(session.watcherCreationFailures[app.pid],
                     "a recovered watcher must clear its recorded failure, or the audit keeps "
                     + "reporting a problem that is fixed")
    }
}
