import XCTest
import CoreGraphics
@testable import SpaceOKit

/// Events the stream documented but never emitted, and the changes nothing observed.
///
/// `window.escaped` and `window.reparked` were promised by `DaemonEvent.kind` and produced by
/// nobody; a dialog that refused to enter the tile was visible only to a later `verify`. Wake
/// and display reconfiguration had no observer at all, so a session whose virtual display
/// vanished across sleep failed its next action in an unrelated-looking way.
final class LifecycleEventTests: XCTestCase {

    /// One window of this test process that the watcher can be told to fail or succeed to move.
    private final class Fixture: @unchecked Sendable {
        let pid = getpid()
        var title = "Save"
        var lands = false
        private var contained = false
        var driver: WindowWatcherDriver {
            let window = WindowRef(windowID: 7_001, pid: pid, title: title,
                                   frame: CGRect(x: 3_000, y: 2_000, width: 400, height: 200))
            return WindowWatcherDriver(pid: pid, validate: {}, discover: { budget in
                try budget.consumeNode()
                return AXWindowDiscovery.Result(windows: [window], elements: [window.windowID: 1])
            }, isContained: { _, _ in self.contained }, move: { _, _, target in
                self.contained = self.lands
                return target
            })
        }
    }

    private final class Recorded: @unchecked Sendable {
        private let lock = NSLock()
        private var values: [String] = []
        func append(_ value: String) { lock.withLock { values.append(value) } }
        var all: [String] { lock.withLock { values } }
    }

    private final class DisplayBacking: StageDisplayBacking {
        let displayID: CGDirectDisplayID
        let bounds = CGRect(x: 0, y: 0, width: 1_280, height: 800)
        private let lock = NSLock()
        private var attached = true
        init(displayID: CGDirectDisplayID) { self.displayID = displayID }
        var valid: Bool { lock.withLock { attached } }
        func invalidate() { lock.withLock { attached = false } }
        /// What sleep does to a virtual display the daemon never asked to retire.
        func vanish() { lock.withLock { attached = false } }
    }

    private final class SessionBox: @unchecked Sendable {
        private let lock = NSLock()
        private var value: AgentSession?
        func set(_ session: AgentSession) { lock.withLock { value = session } }
        var session: AgentSession? { lock.withLock { value } }
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

    private func events(_ kind: String, session: String, since: UInt64) -> [DaemonEvent] {
        EventBus.shared.replay(since: since, limit: 4_096).events
            .filter { $0.kind == kind && $0.session == session }
    }

    private func makeManager(
        backing: DisplayBacking,
        box: SessionBox,
        watcher: WindowWatcher? = nil
    ) -> SessionManager {
        let displayID = backing.displayID
        let stage = Stage(testingBacking: backing,
                          onlineDisplayIDs: { backing.valid ? [displayID] : [] })
        let pool = DisplayPool(
            sessionsPerDisplay: 1, displaySize: backing.bounds.size,
            stageFactory: { _, _, _, _ in stage },
            stageRetirer: { $0.invalidate(waitingForRemoval: 0) })
        return SessionManager(
            pool: pool,
            runJanitor: false,
            onlineDisplayIDs: { backing.valid ? [displayID] : [] },
            sessionFactory: { id, slot in
                let session = try AgentSession(
                    id: id, slot: slot,
                    teardownDriver: SessionAppTeardownDriver(
                        isAlive: { _ in false }, quit: { _, _ in },
                        waitForExit: { _, _ in [] }, cleanupTemporaryProfile: { _ in }),
                    windowDriver: .windowlessForTesting,
                    watcherFactory: { _, _ in
                        guard let watcher else { throw CancellationError() }
                        return watcher
                    },
                    initialApps: [])
                box.set(session)
                return session
            })
    }

    private func liveApp() throws -> LaunchedApp {
        let identity = try XCTUnwrap(ProcessIdentity.current(of: getpid()))
        return LaunchedApp(
            pid: identity.pid, identity: identity, bundleIdentifier: "dev.spaceo.escape",
            name: "Escaper", url: URL(fileURLWithPath: "/Applications/Escaper.app"),
            startedByUs: true, devToolsPort: nil, temporaryProfile: nil)
    }

    // MARK: - Watcher containment events

    func testWatcherReportsTheFirstRefusalOnceAndARepark() {
        let fixture = Fixture()
        let watcher = WindowWatcher(testingPID: fixture.pid,
                                    region: { CGRect(x: 0, y: 0, width: 800, height: 600) },
                                    driver: fixture.driver)
        let recorded = Recorded()
        watcher.setContainmentHandler { event in
            switch event {
            case .escaped(let window): recorded.append("escaped \(window.windowID)")
            case .reparked(let window): recorded.append("reparked \(window.windowID)")
            }
        }

        watcher.sweep()
        watcher.sweep()
        XCTAssertEqual(recorded.all, ["escaped 7001"],
                       "a sheet that can never move must produce one event, not one per sweep")

        fixture.title = "Save (moved)"   // geometry unchanged, so force a retry explicitly
        watcher.release(7_001)
        fixture.lands = true
        watcher.sweep()
        XCTAssertEqual(recorded.all, ["escaped 7001", "reparked 7001"])
    }

    func testEscapeIsPublishedAndToldToTheOwnerOnceOnItsNextResponse() async throws {
        let fixture = Fixture()
        let watcher = WindowWatcher(testingPID: fixture.pid,
                                    region: { CGRect(x: 0, y: 0, width: 800, height: 600) },
                                    driver: fixture.driver)
        let box = SessionBox()
        let manager = makeManager(backing: DisplayBacking(displayID: 97_001), box: box, watcher: watcher)
        let created = await manager.handle(TestController.createRequest(session: "escape"))
        XCTAssertTrue(created.ok, created.error ?? "")
        let session = try XCTUnwrap(box.session)
        session.register(app: try liveApp(), windows: [])
        defer { watcher.stop() }
        let bus = EventBus.shared.latestSeq

        session.sweepStrayWindows()

        let escaped = events("window.escaped", session: "escape", since: bus)
        XCTAssertEqual(escaped.count, 1)
        XCTAssertEqual(escaped.first?.detail["window"], "7001")

        let heartbeat = TestController.request("session.heartbeat", session: "escape")
        let first = await manager.handle(heartbeat)
        XCTAssertTrue(first.ok, first.error ?? "")
        XCTAssertEqual(first.ambient, ["window 'Save' escaped your tile and refused placement"])
        let second = await manager.handle(heartbeat)
        XCTAssertNil(second.ambient, "the note is one-shot")
    }

    // MARK: - Wake and display reconfiguration

    func testLostDisplayIsMarkedPausedAndAnnouncedOnce() async throws {
        let backing = DisplayBacking(displayID: 97_002)
        let manager = makeManager(backing: backing, box: SessionBox())
        let created = await manager.handle(TestController.createRequest(session: "asleep"))
        XCTAssertTrue(created.ok, created.error ?? "")
        let bus = EventBus.shared.latestSeq

        let healthy = await manager.revalidateDisplays(reason: "wake")
        XCTAssertEqual(healthy, [], "a valid display is swept, not marked lost")

        backing.vanish()
        let lost = await manager.revalidateDisplays(reason: "wake")
        let again = await manager.revalidateDisplays(reason: "reconfiguration")

        XCTAssertEqual(lost, ["asleep"])
        XCTAssertEqual(again, [], "a loss is announced once")
        let announced = events("session.display_lost", session: "asleep", since: bus)
        XCTAssertEqual(announced.count, 1)
        XCTAssertEqual(announced.first?.detail["reason"], "wake")
        let listed = await manager.handle(Request(cmd: "session.list"))
        let info = try XCTUnwrap(listed.sessions?.first { $0.id == "asleep" })
        XCTAssertEqual(info.lifecycleReason, "display_lost")
        XCTAssertEqual(info.inputPaused, true)
        XCTAssertEqual(info.agentPauseReason, "display lost after wake/reconfiguration")
    }

    func testObserverCoalescesABurstIntoOneDeliveryAndPrefersWake() async throws {
        let recorded = Recorded()
        let delivered = expectation(description: "one debounced delivery")
        let observer = DisplayEnvironmentObserver(debounce: 0.05) { change in
            recorded.append(change.rawValue)
            delivered.fulfill()
        }
        // Never started: this exercises the debounce without registering with the system.
        for _ in 0..<20 { observer.notify(.reconfiguration) }
        observer.notify(.wake)
        observer.notify(.reconfiguration)

        await fulfillment(of: [delivered], timeout: 5)
        try await Task.sleep(nanoseconds: 200_000_000)
        XCTAssertEqual(recorded.all, ["wake"])
        XCTAssertEqual(observer.deliveries, 1)
    }
}
