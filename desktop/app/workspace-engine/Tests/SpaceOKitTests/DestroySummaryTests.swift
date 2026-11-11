import XCTest
import CoreGraphics
@testable import SpaceOKit

/// Every session ending is explained.
///
/// `session.destroy` used to answer `destroyed 'x'` and nothing else: which apps were quit,
/// which needed force, which adopted apps were merely released, and whether the recording was
/// actually finalized (`try? recorder.finish` swallowed the error) all had to be inferred. The
/// janitor's reclamation said even less. These tests pin the summary and its `reason`.
final class DestroySummaryTests: XCTestCase {

    private final class Clock: @unchecked Sendable {
        private let lock = NSLock()
        private var value = Date(timeIntervalSince1970: 9_000)
        func now() -> Date { lock.withLock { value } }
        func advance(_ seconds: TimeInterval) { lock.withLock { value = value.addingTimeInterval(seconds) } }
    }

    private final class Liveness: @unchecked Sendable {
        private let lock = NSLock()
        private var alive = true
        func set(_ value: Bool) { lock.withLock { alive = value } }
        func get() -> Bool { lock.withLock { alive } }
    }

    /// A process table where graceful quits work except for apps that only die when forced.
    private final class World: @unchecked Sendable {
        private let lock = NSLock()
        private var alive: Set<ProcessIdentity>
        private let stubborn: Set<ProcessIdentity>

        init(alive: [LaunchedApp], stubborn: [LaunchedApp]) {
            self.alive = Set(alive.map(\.identity))
            self.stubborn = Set(stubborn.map(\.identity))
        }

        func isAlive(_ identity: ProcessIdentity) -> Bool { lock.withLock { alive.contains(identity) } }
        func quit(_ app: LaunchedApp, force: Bool) {
            lock.withLock {
                if force || !stubborn.contains(app.identity) { alive.remove(app.identity) }
            }
        }
        func survivors(_ apps: [LaunchedApp]) -> [LaunchedApp] {
            lock.withLock { apps.filter { alive.contains($0.identity) } }
        }
    }

    private final class DisplayBacking: StageDisplayBacking {
        let displayID: CGDirectDisplayID
        let bounds = CGRect(x: 0, y: 0, width: 1_280, height: 800)
        init(displayID: CGDirectDisplayID) { self.displayID = displayID }
        var valid: Bool { true }
        func invalidate() {}
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

    private func app(_ pid: pid_t, _ name: String, launched: Bool = true, profile: Bool = false) -> LaunchedApp {
        LaunchedApp(
            pid: pid, identity: ProcessIdentity(pid: pid, startedAtMicroseconds: UInt64(pid) * 10),
            bundleIdentifier: "dev.spaceo.\(name.lowercased())", name: name,
            url: URL(fileURLWithPath: "/Applications/\(name).app"), startedByUs: launched,
            devToolsPort: nil,
            temporaryProfile: profile ? URL(fileURLWithPath: "/private/tmp/spaceo-profile-\(pid)") : nil)
    }

    private struct Fixture {
        let manager: SessionManager
        let clock: Clock
        let liveness: Liveness
    }

    private func fixture(
        displayID: CGDirectDisplayID,
        apps: [LaunchedApp],
        stubborn: [LaunchedApp] = [],
        recordingRoot: URL? = nil
    ) -> Fixture {
        let clock = Clock()
        let liveness = Liveness()
        let world = World(alive: apps, stubborn: stubborn)
        let backing = DisplayBacking(displayID: displayID)
        let stage = Stage(testingBacking: backing, onlineDisplayIDs: { [displayID] })
        let pool = DisplayPool(
            sessionsPerDisplay: 1, displaySize: backing.bounds.size,
            stageFactory: { _, _, _, _ in stage },
            stageRetirer: { $0.invalidate(waitingForRemoval: 0) })
        let manager = SessionManager(
            pool: pool,
            runJanitor: false,
            reclamationPolicy: SessionReclamationPolicy(
                defaultTTL: 300, gracePeriod: 30,
                now: { clock.now() }, ownerIsAlive: { _ in liveness.get() }),
            recordingRootDirectory: recordingRoot,
            sessionFactory: { id, slot in
                try AgentSession(
                    id: id, slot: slot,
                    teardownDriver: SessionAppTeardownDriver(
                        isAlive: { world.isAlive($0) },
                        quit: { world.quit($0, force: $1) },
                        waitForExit: { apps, _ in world.survivors(apps) },
                        cleanupTemporaryProfile: { _ in }),
                    windowDriver: .windowlessForTesting,
                    watcherFactory: { _, _ in throw CancellationError() },
                    initialApps: apps)
            })
        return Fixture(manager: manager, clock: clock, liveness: liveness)
    }

    private func create(_ manager: SessionManager, _ id: String, record: String? = nil) async throws {
        var create = TestController.createRequest(session: id)
        create.record = record
        let created = await manager.handle(create)
        XCTAssertTrue(created.ok, created.error ?? "")
    }

    private func destroyedEvents(_ session: String, since: UInt64) -> [DaemonEvent] {
        EventBus.shared.replay(since: since, limit: 4_096).events
            .filter { $0.kind == "session.destroyed" && $0.session == session }
    }

    func testOwnerDestroyReportsQuitForcedReleasedProfilesAndClipboard() async throws {
        let editor = app(81_001, "Editor")
        let stubborn = app(81_002, "Stubborn")
        let notes = app(81_003, "Notes", launched: false)
        let browser = app(81_004, "Browser", profile: true)
        let fixture = fixture(displayID: 96_001, apps: [editor, stubborn, notes, browser],
                              stubborn: [stubborn])
        try await create(fixture.manager, "summary-owner")
        var clip = TestController.request("clipboard.set", session: "summary-owner")
        clip.text = "secret the agent staged"
        let staged = await fixture.manager.handle(clip)
        XCTAssertTrue(staged.ok, staged.error ?? "")
        let bus = EventBus.shared.latestSeq

        let destroyed = await fixture.manager.handle(
            TestController.request("session.destroy", session: "summary-owner"))

        XCTAssertTrue(destroyed.ok, destroyed.error ?? "")
        XCTAssertEqual(destroyed.message, "destroyed 'summary-owner'")
        let summary = try XCTUnwrap(destroyed.destroySummary)
        XCTAssertEqual(summary.reason, "owner")
        XCTAssertEqual(summary.quitApps, ["Browser", "Editor", "Stubborn"])
        XCTAssertEqual(summary.forcedApps, ["Stubborn"])
        XCTAssertEqual(summary.releasedApps, ["Notes"], "adopted apps are released, never quit")
        XCTAssertEqual(summary.profilesRemoved, 1)
        XCTAssertTrue(summary.clipboardCleared)
        XCTAssertNil(summary.actionCount, "no recorder, so no action count is claimed")
        XCTAssertGreaterThanOrEqual(summary.durationSeconds, 0)
        XCTAssertTrue(summary.summaryLine.contains("quit Browser, Editor, Stubborn (1 forced)"),
                      summary.summaryLine)

        let event = try XCTUnwrap(destroyedEvents("summary-owner", since: bus).last)
        XCTAssertEqual(event.detail["reason"], "owner")
        XCTAssertEqual(event.detail["forced"], "Stubborn")
    }

    func testKeepAppsReleasesLaunchedAppsInsteadOfQuittingThem() async throws {
        let editor = app(81_011, "Editor")
        let fixture = fixture(displayID: 96_002, apps: [editor])
        try await create(fixture.manager, "summary-keep")
        var destroy = TestController.request("session.destroy", session: "summary-keep")
        destroy.quitApps = false

        let destroyed = await fixture.manager.handle(destroy)

        XCTAssertTrue(destroyed.ok, destroyed.error ?? "")
        XCTAssertEqual(destroyed.destroySummary?.quitApps, [])
        XCTAssertEqual(destroyed.destroySummary?.releasedApps, ["Editor"])
        XCTAssertEqual(destroyed.destroySummary?.clipboardCleared, false)
    }

    func testOperatorAndJanitorEndingsCarryTheirReason() async throws {
        let operatorFixture = fixture(displayID: 96_003, apps: [app(81_021, "Editor")])
        try await create(operatorFixture.manager, "summary-operator")
        var destroy = Request(cmd: "session.destroy")
        destroy.session = "summary-operator"
        destroy.operatorScope = true
        let byOperator = await operatorFixture.manager.handle(destroy)
        XCTAssertEqual(byOperator.destroySummary?.reason, "operator")

        // The janitor's reaper checks real liveness before reclaiming, so this app must be a
        // process that is really alive: this test process, quit only in the fake world.
        let identity = try XCTUnwrap(ProcessIdentity.current(of: getpid()))
        let live = LaunchedApp(
            pid: identity.pid, identity: identity, bundleIdentifier: "dev.spaceo.editor",
            name: "Editor", url: URL(fileURLWithPath: "/Applications/Editor.app"),
            startedByUs: true, devToolsPort: nil, temporaryProfile: nil)
        let janitorFixture = fixture(displayID: 96_004, apps: [live])
        try await create(janitorFixture.manager, "summary-janitor")
        let bus = EventBus.shared.latestSeq
        janitorFixture.liveness.set(false)
        janitorFixture.clock.advance(1)
        _ = try await janitorFixture.manager.runJanitorPass()
        janitorFixture.clock.advance(31)
        _ = try await janitorFixture.manager.runJanitorPass()

        let event = try XCTUnwrap(destroyedEvents("summary-janitor", since: bus).last,
                                  "the janitor's reclamation must be announced")
        XCTAssertEqual(event.detail["reason"], "janitor_abandoned")
        XCTAssertEqual(event.detail["quit"], "Editor")
    }

    func testRecorderFinishFailureIsReportedInsteadOfSwallowed() async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("spaceo-destroy-summary-\(UUID())", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let fixture = fixture(displayID: 96_005, apps: [], recordingRoot: root)
        try await create(fixture.manager, "summary-recording", record: "actions")
        let recorder = await fixture.manager.recorders["summary-recording"]
        let directory = try XCTUnwrap(recorder?.directory)
        // The manifest has nowhere to go: finishing must fail, and the caller must hear it.
        try FileManager.default.removeItem(at: directory)

        let destroyed = await fixture.manager.handle(
            TestController.request("session.destroy", session: "summary-recording"))

        XCTAssertTrue(destroyed.ok, destroyed.error ?? "")
        let summary = try XCTUnwrap(destroyed.destroySummary)
        XCTAssertEqual(summary.recordingPath, directory.path)
        XCTAssertNotNil(summary.recordingError)
        XCTAssertEqual(summary.actionCount, 0)
        XCTAssertTrue(summary.summaryLine.contains("not finalized"), summary.summaryLine)
    }
}
