import XCTest
import CoreGraphics
@testable import SpaceOKit

/// Teardown must never claim a tile is empty on the strength of a move it did not verify.
///
/// `ARCHITECTURE.md` §3.2 records that app-modal sheets refuse to move at all. When one of those
/// windows stays behind, releasing the slot hands the next session a tile that still renders the
/// previous agent's screen — the context leak tiling exists to prevent (§3.0).
final class StrandedWindowTeardownTests: XCTestCase {

    /// `SessionInfo` carries the tile as flat wire fields; comparing whole tiles is what the
    /// "did the next session get the occupied slot" assertion is actually about.
    private struct Tile: Equatable {
        let x: Double, y: Double, width: Double, height: Double

        init(_ info: SessionInfo) {
            x = info.x
            y = info.y
            width = info.width
            height = info.height
        }
    }

    private static let displayBounds = CGRect(x: 0, y: 0, width: 1280, height: 800)
    private static let userDisplayBounds = CGRect(x: 2_000, y: 0, width: 1440, height: 900)

    private final class FakeDisplayBacking: StageDisplayBacking, @unchecked Sendable {
        let displayID: CGDirectDisplayID
        let bounds = StrandedWindowTeardownTests.displayBounds
        private let lock = NSLock()
        private var attached = true

        init(id: CGDirectDisplayID) { displayID = id }

        var valid: Bool { lock.withLock { attached } }
        func invalidate() { lock.withLock { attached = false } }
    }

    /// One window that starts inside the session tile and only leaves if `allowMove` is set,
    /// the way an app-modal sheet only moves once its parent dismisses it.
    private final class WindowState: @unchecked Sendable {
        private let lock = NSLock()
        private var bounds: CGRect
        private var allowMove = false
        private var closed = false
        private(set) var moveAttempts = 0

        let windowID: CGWindowID = 4_242
        let pid: pid_t

        init(pid: pid_t, bounds: CGRect) {
            self.pid = pid
            self.bounds = bounds
        }

        func release() { lock.withLock { allowMove = true } }
        func close() { lock.withLock { closed = true } }

        func move(to frame: CGRect) {
            lock.withLock {
                moveAttempts += 1
                if allowMove { bounds = frame }
            }
        }

        var liveBounds: CGRect? { lock.withLock { closed ? nil : bounds } }
        /// Qualified: `ApplicationServices` exports a `WindowRef` of its own.
        var ref: SpaceOKit.WindowRef? {
            lock.withLock {
                closed
                    ? nil
                    : SpaceOKit.WindowRef(
                        windowID: windowID, pid: pid, title: "Save changes?", frame: bounds)
            }
        }
    }

    private func makeWindowDriver(_ state: WindowState, hasUserDisplay: Bool = true) -> SessionWindowDriver {
        SessionWindowDriver(
            windows: { pid in pid == state.pid ? [state.ref].compactMap { $0 } : [] },
            userDisplayBounds: { hasUserDisplay ? Self.userDisplayBounds : nil },
            move: { _, frame in state.move(to: frame) },
            liveBounds: { id in id == state.windowID ? state.liveBounds : nil })
    }

    /// `--keep-apps` never quits anything, so process liveness alone always looks like success.
    private func makeKeepAppsDriver() -> SessionAppTeardownDriver {
        SessionAppTeardownDriver(
            isAlive: { _ in true },
            quit: { _, _ in XCTFail("`--keep-apps` teardown must not quit any app") },
            waitForExit: { apps, _ in apps },
            cleanupTemporaryProfile: { _ in })
    }

    private func makePool(displayID: CGDirectDisplayID) -> DisplayPool {
        let backing = FakeDisplayBacking(id: displayID)
        // Retirement polls the online list, so an invalidated fake must leave it or every
        // release waits out the full removal timeout before reporting a failure it did not have.
        let stage = Stage(
            testingBacking: backing,
            onlineDisplayIDs: { backing.valid ? [displayID] : [] })
        return DisplayPool(
            sessionsPerDisplay: 2,
            displaySize: backing.bounds.size,
            stageFactory: { _, _, _, _ in stage },
            stageRetirer: { $0.invalidate(waitingForRemoval: 0) })
    }

    private func makeApp(startedByUs: Bool = true) throws -> LaunchedApp {
        let identity = try XCTUnwrap(ProcessIdentity.current(of: getpid()))
        return LaunchedApp(
            pid: identity.pid,
            identity: identity,
            bundleIdentifier: "dev.spaceo.stranded-window-test",
            name: "Editor",
            url: URL(fileURLWithPath: "/Applications/Editor.app"),
            startedByUs: startedByUs,
            devToolsPort: nil,
            temporaryProfile: nil)
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

    func testKeepAppsTeardownReportsWindowsThatRefusedToLeaveTheTile() throws {
        let pool = makePool(displayID: 91_001)
        let slot = try pool.allocate()
        let app = try makeApp()
        let window = WindowState(
            pid: app.pid,
            bounds: WindowPlacement.defaultFrame(in: slot.frame))
        let session = try AgentSession(
            id: "agent-1",
            slot: slot,
            teardownDriver: makeKeepAppsDriver(),
            windowDriver: makeWindowDriver(window),
            initialApps: [app])

        let report = session.destroy(quitApps: false, timeout: 0)

        XCTAssertFalse(report.isComplete, "a window still in the tile is not a complete teardown")
        XCTAssertGreaterThan(window.moveAttempts, 0, "evacuation must still be attempted")
        XCTAssertEqual(report.strandedWindows.map(\.windowID), [window.windowID])
        XCTAssertEqual(report.strandedWindows.first?.pid, app.pid)
        XCTAssertEqual(report.strandedWindows.first?.inTile, true)
        XCTAssertEqual(report.stillAttachedDisplayIDs, [91_001])
        XCTAssertEqual(report.pendingSessionIDs, ["agent-1"])
        XCTAssertTrue(report.recoveryDescription.contains("Save changes?"))

        // The app must stay in the ledger, or the next retry finds nothing to evacuate and
        // reports the very success this test exists to prevent.
        XCTAssertTrue(session.teardownPending)
        XCTAssertEqual(ProcessOwnership.owner(of: app.identity), "agent-1")
        XCTAssertFalse(session.destroy(quitApps: false, timeout: 0).isComplete)

        window.release()
        let retry = session.destroy(quitApps: false, timeout: 0)
        XCTAssertTrue(retry.isComplete, retry.recoveryDescription)
        XCTAssertEqual(retry.strandedWindows, [])
        XCTAssertNil(ProcessOwnership.owner(of: app.identity))
        XCTAssertTrue(pool.release(slot, retainEmpty: false))
    }

    func testHeadlessTeardownRetainsAdoptedWindowWithoutInventingUserDisplayDestination() throws {
        let pool = makePool(displayID: 91_005)
        let slot = try pool.allocate()
        let app = try makeApp(startedByUs: false)
        let window = WindowState(pid: app.pid, bounds: WindowPlacement.defaultFrame(in: slot.frame))
        let session = try AgentSession(
            id: "agent-1", slot: slot, teardownDriver: makeKeepAppsDriver(),
            windowDriver: makeWindowDriver(window, hasUserDisplay: false), initialApps: [app])

        let report = session.destroy(quitApps: true, timeout: 0)
        XCTAssertFalse(report.isComplete)
        XCTAssertEqual(window.moveAttempts, 0)
        XCTAssertEqual(report.strandedWindows.map(\.windowID), [window.windowID])
        XCTAssertEqual(report.stillAttachedDisplayIDs, [91_005])
        XCTAssertEqual(ProcessOwnership.owner(of: app.identity), "agent-1")
        XCTAssertTrue(session.teardownPending)

        window.close()
        XCTAssertTrue(session.destroy(quitApps: true, timeout: 0).isComplete)
        XCTAssertNil(ProcessOwnership.owner(of: app.identity))
        XCTAssertTrue(pool.release(slot, retainEmpty: false))
    }

    func testStrandedWindowKeepsTheTileAllocatedForTheNextSession() async throws {
        let pool = makePool(displayID: 91_002)
        let app = try makeApp()
        let window = WindowState(pid: app.pid, bounds: Self.displayBounds.insetBy(dx: 400, dy: 300))
        let appDriver = makeKeepAppsDriver()
        let windowDriver = makeWindowDriver(window)
        let manager = SessionManager(
            pool: pool,
            runJanitor: false,
            sessionFactory: { id, slot in
                // Only the first session owns the app; a second claim on the same pid would be
                // refused by `ProcessOwnership`, which is not what this test is measuring.
                try AgentSession(
                    id: id,
                    slot: slot,
                    teardownDriver: appDriver,
                    windowDriver: id == "agent-1" ? windowDriver : .live,
                    initialApps: id == "agent-1" ? [app] : [])
            })

        let created = await manager.handle(TestController.createRequest())
        XCTAssertTrue(created.ok, created.error ?? "")
        let firstTile = Tile(try XCTUnwrap(created.session))

        var destroy = TestController.request("session.destroy")
        destroy.session = "agent-1"
        destroy.quitApps = false
        let response = await manager.handle(destroy)

        XCTAssertFalse(response.ok, "keep-apps teardown must not report success here")
        XCTAssertEqual(response.teardown?.strandedWindows.map(\.windowID), [window.windowID])
        let liveSessions = await manager.count
        XCTAssertEqual(liveSessions, 1, "the session keeps its slot until the tile is empty")

        // The decisive assertion: the occupied tile must not be handed to the next agent.
        let recreated = await manager.handle(TestController.createRequest(session: "agent-2"))
        XCTAssertTrue(recreated.ok, recreated.error ?? "")
        XCTAssertNotEqual(Tile(try XCTUnwrap(recreated.session)), firstTile)

        window.close()
        let cleanup = await manager.handle(destroy)
        XCTAssertTrue(cleanup.ok, cleanup.error ?? "")
    }

    /// A window that left for the user's display is genuinely gone from the tile; teardown must
    /// still complete, or `--keep-apps` could never succeed at all.
    func testEvacuatedWindowStillCompletesTeardown() throws {
        let pool = makePool(displayID: 91_003)
        let slot = try pool.allocate()
        let app = try makeApp()
        let window = WindowState(
            pid: app.pid,
            bounds: WindowPlacement.defaultFrame(in: slot.frame))
        window.release()
        let session = try AgentSession(
            id: "agent-1",
            slot: slot,
            teardownDriver: makeKeepAppsDriver(),
            windowDriver: makeWindowDriver(window),
            initialApps: [app])

        let report = session.destroy(quitApps: false, timeout: 0)

        XCTAssertTrue(report.isComplete, report.recoveryDescription)
        XCTAssertEqual(report.strandedWindows, [])
        let movedBounds = try XCTUnwrap(window.liveBounds)
        XCTAssertTrue(Self.userDisplayBounds.contains(CGPoint(x: movedBounds.midX,
                                                             y: movedBounds.midY)))
        XCTAssertNil(ProcessOwnership.owner(of: app.identity))
    }

    func testDiscoveryFailuresRoundTripMergeAndPreventCompletion() throws {
        var report = TeardownReport(windowDiscoveryFailures: ["alpha: provider unavailable"])
        report.merge(TeardownReport(windowDiscoveryFailures: ["beta: deadline", "alpha: provider unavailable"]))
        XCTAssertEqual(report.windowDiscoveryFailures, ["alpha: provider unavailable", "beta: deadline"])
        XCTAssertFalse(report.isComplete)
        let decoded = try Wire.decoder.decode(TeardownReport.self, from: Wire.encoder.encode(report))
        XCTAssertEqual(decoded, report)
        XCTAssertTrue(decoded.recoveryDescription.contains("alpha: provider unavailable"))
        XCTAssertTrue(decoded.recoveryDescription.contains("beta: deadline"))
    }

    func testWireCarriesStrandedWindowsAndStillDecodesAnOlderDaemonsReport() throws {
        let stranded = StrandedWindowInfo(
            window: SpaceOKit.WindowRef(
                windowID: 4_242, pid: 99, title: "Save changes?", frame: .zero),
            inTile: true)
        let report = TeardownReport(
            strandedWindows: [stranded],
            stillAttachedDisplayIDs: [77],
            pendingSessionIDs: ["agent-1"])

        let decoded = try Wire.decoder.decode(
            TeardownReport.self,
            from: Wire.encoder.encode(report))
        XCTAssertEqual(decoded, report)
        XCTAssertFalse(decoded.isComplete)
        XCTAssertTrue(decoded.recoveryDescription.contains("window 4242"))

        // A daemon older than this field omits the key. A client that refused to decode that
        // would turn a running upgrade into an unreadable teardown failure.
        let legacy = Data(#"""
            {"survivingProcesses":[],"stillAttachedDisplayIDs":[],"pendingSessionIDs":[]}
            """#.utf8)
        let older = try Wire.decoder.decode(TeardownReport.self, from: legacy)
        XCTAssertEqual(older.strandedWindows, [])
        XCTAssertNil(older.windowDiscoveryFailures)
        XCTAssertTrue(older.isComplete)
    }

    /// The escalation the issue names: a failed `quitApps: true` teardown cannot be laundered
    /// into success by re-running destroy with `--keep-apps` while the windows are still there.
    func testKeepAppsCannotLaunderAFailedQuitTeardown() throws {
        let pool = makePool(displayID: 91_004)
        let slot = try pool.allocate()
        let app = try makeApp()
        let window = WindowState(
            pid: app.pid,
            bounds: WindowPlacement.defaultFrame(in: slot.frame))
        let session = try AgentSession(
            id: "agent-1",
            slot: slot,
            teardownDriver: SessionAppTeardownDriver(
                isAlive: { _ in true },
                quit: { _, _ in },
                waitForExit: { apps, _ in apps },
                cleanupTemporaryProfile: { _ in }),
            windowDriver: makeWindowDriver(window),
            initialApps: [app])

        let quitReport = session.destroy(quitApps: true, timeout: 0)
        XCTAssertEqual(quitReport.survivingProcesses.map(\.identity), [app.identity])

        let keepAppsReport = session.destroy(quitApps: false, timeout: 0)
        XCTAssertFalse(keepAppsReport.isComplete)
        XCTAssertEqual(keepAppsReport.strandedWindows.map(\.windowID), [window.windowID])
        XCTAssertEqual(ProcessOwnership.owner(of: app.identity), "agent-1")
    }
}
