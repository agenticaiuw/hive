import XCTest
import CoreGraphics
@testable import SpaceOKit

/// Every refusal says what actually happened and what to do next, for an MCP agent and a CLI
/// user alike. Each test pins one failure an agent hit in practice and the guidance it now gets.
final class ErrorGuidanceTests: XCTestCase {

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

    // MARK: - Fixtures

    private final class Clock: @unchecked Sendable {
        private let lock = NSLock()
        private var value: Date
        init(_ value: Date = Date(timeIntervalSince1970: 1_000)) { self.value = value }
        func now() -> Date { lock.withLock { value } }
        func advance(_ seconds: TimeInterval) { lock.withLock { value = value.addingTimeInterval(seconds) } }
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

    private final class Captured: @unchecked Sendable {
        private let lock = NSLock()
        private var sessions: [AgentSession] = []
        func add(_ session: AgentSession) { lock.withLock { sessions.append(session) } }
        var first: AgentSession? { lock.withLock { sessions.first } }
    }

    private func makePool(displayID: CGDirectDisplayID, perDisplay: Int = 4,
                          budget: ResourceBudget = .default) -> DisplayPool {
        let backing = DisplayBacking(displayID: displayID)
        let stage = Stage(testingBacking: backing,
                          onlineDisplayIDs: { backing.isAttached ? [displayID] : [] })
        return DisplayPool(sessionsPerDisplay: perDisplay, displaySize: backing.bounds.size,
                           budget: budget, stageFactory: { _, _, _, _ in stage },
                           stageRetirer: { $0.invalidate(waitingForRemoval: 0) })
    }

    private func makeManager(
        displayID: CGDirectDisplayID,
        perDisplay: Int = 4,
        budget: ResourceBudget = .default,
        clock: Clock? = nil,
        captured: Captured? = nil
    ) -> SessionManager {
        let policy = clock.map { clock in
            SessionReclamationPolicy(defaultTTL: 10, gracePeriod: 5,
                                     now: { clock.now() }, ownerIsAlive: { _ in true })
        } ?? SessionReclamationPolicy()
        return SessionManager(
            pool: makePool(displayID: displayID, perDisplay: perDisplay, budget: budget),
            runJanitor: false,
            reclamationPolicy: policy,
            sessionFactory: { id, slot in
                let session = AgentSession(id: id, slot: slot)
                captured?.add(session)
                return session
            })
    }

    private func create(_ manager: SessionManager, name: String?, owner: String = "unit-test-controller",
                        lease: UUID = TestController.leaseID) async -> Response {
        await manager.handle(TestController.createRequest(session: name, ownerID: owner, leaseID: lease))
    }

    /// This process's pid with a start time it never had: deterministically dead.
    private func deadApp(named name: String, pid: pid_t = getpid()) -> LaunchedApp {
        let identity = ProcessIdentity(pid: pid, startedAtMicroseconds: 1)
        return LaunchedApp(pid: identity.pid, identity: identity, bundleIdentifier: "dev.spaceo.error-guidance",
                           name: name, url: URL(fileURLWithPath: "/Applications/\(name).app"),
                           startedByUs: true, devToolsPort: nil, temporaryProfile: nil)
    }

    // MARK: - 1. App exited is not "no windows yet"

    func testEmptySessionSaysNoAppIsAttachedAndPointsAtOpenApp() throws {
        let session = AgentSession(id: "agent-1", slot: try makePool(displayID: 97_001).allocate())
        XCTAssertThrowsError(try session.resolveDiscoveredWindow(nil)) { error in
            let spaceo = error as? SpaceOError
            XCTAssertEqual(spaceo?.code, "window_not_ready")
            XCTAssertTrue(error.localizedDescription.contains("no app is attached to session 'agent-1'"),
                          error.localizedDescription)
            XCTAssertEqual(spaceo?.recovery?.tool, "spaceo_open_app")
            XCTAssertNotEqual(spaceo?.recovery?.tool, "spaceo_list_windows")
        }
    }

    func testCrashedAppIsReportedAsExitedBeforeAndAfterTheJanitorReapsIt() throws {
        let session = AgentSession(id: "agent-1", slot: try makePool(displayID: 97_002).allocate())
        session.register(app: deadApp(named: "TextEdit"), windows: [])

        // Before the janitor runs: the dead app is still in `apps`.
        XCTAssertThrowsError(try session.resolveDiscoveredWindow(nil)) { error in
            XCTAssertEqual((error as? SpaceOError)?.code, "application_exited")
            XCTAssertTrue(error.localizedDescription.contains("TextEdit (pid \(getpid())) exited at"),
                          error.localizedDescription)
            XCTAssertEqual((error as? SpaceOError)?.recovery?.tool, "spaceo_open_app")
        }

        XCTAssertEqual(session.reapExitedApps(), 1)
        XCTAssertEqual(session.recentlyExited.map(\.name), ["TextEdit"])
        XCTAssertNil(session.recentlyExited.first?.status, "no public API reports a non-child's status")
        XCTAssertThrowsError(try session.resolveDiscoveredWindow(nil)) { error in
            XCTAssertEqual((error as? SpaceOError)?.code, "application_exited")
        }

        let info = SessionInfo(session)
        XCTAssertEqual(info.exitedApps?.map(\.name), ["TextEdit"])
        XCTAssertEqual(info.exitedApps?.first?.startedByUs, true)
        XCTAssertEqual(info.lifecycleReason, "app_exited")
    }

    func testExitHistoryIsBoundedAndMostRecentFirst() throws {
        let session = AgentSession(id: "agent-1", slot: try makePool(displayID: 97_003).allocate())
        for index in 0..<12 {
            session.register(app: deadApp(named: "App\(index)", pid: pid_t(70_000 + index)), windows: [])
            session.reapExitedApps()
        }
        XCTAssertEqual(session.recentlyExited.count, AgentSession.maximumRecentlyExited)
        XCTAssertEqual(session.recentlyExited.first?.name, "App11")
        XCTAssertEqual(SessionInfo(session).exitedApps?.count, 8)
    }

    func testFreshSessionHasNoExitHistoryOnTheWire() throws {
        let session = AgentSession(id: "agent-1", slot: try makePool(displayID: 97_004).allocate())
        let info = SessionInfo(session)
        XCTAssertNil(info.exitedApps)
        XCTAssertEqual(info.lifecycleReason, "window_absent_reason_unknown")
    }

    // MARK: - 2. Pool full is resource_limit, not bad_request

    func testBudgetRefusalsAreResourceLimitsWithTheirKind() {
        let budget = ResourceBudget.default
        XCTAssertThrowsError(try budget.admitSession(usage: .init(sessions: budget.maximumSessions))) { error in
            guard case .resourceLimit(let kind, _, let retry)? = error as? SpaceOError else {
                return XCTFail("\(error)")
            }
            XCTAssertEqual(kind, .sessions)
            XCTAssertNil(retry, "the budget alone cannot know when another session is released")
            XCTAssertEqual((error as? SpaceOError)?.code, "resource_limit")
        }
        XCTAssertThrowsError(try budget.admitDisplay(
            size: CGSize(width: 1920, height: 1080), capacity: 1,
            usage: .init(displays: budget.maximumDisplays))) { error in
            guard case .resourceLimit(.displays, _, _)? = error as? SpaceOError else { return XCTFail("\(error)") }
        }
        XCTAssertThrowsError(try budget.admitDisplay(
            size: CGSize(width: 1920, height: 1080), capacity: 1,
            usage: .init(creationsInLastMinute: budget.maximumCreationsPerMinute),
            rateWindowClearsIn: 12.2)) { error in
            guard case .resourceLimit(.creationRate, _, let retry)? = error as? SpaceOError else {
                return XCTFail("\(error)")
            }
            XCTAssertEqual(retry, 12.2)
            XCTAssertTrue(error.localizedDescription.contains("retry in 13 s"), error.localizedDescription)
            XCTAssertEqual((error as? SpaceOError)?.recovery?.tool, "spaceo_pool_status")
            XCTAssertTrue((error as? SpaceOError)?.recovery?.then.contains("retry after 13 s") == true)
        }
        // Without a window hint the rate limit still clears within a minute.
        XCTAssertThrowsError(try budget.admitDisplay(
            size: CGSize(width: 1920, height: 1080), capacity: 1,
            usage: .init(creationsInLastMinute: budget.maximumCreationsPerMinute))) { error in
            guard case .resourceLimit(.creationRate, _, 60?)? = error as? SpaceOError else { return XCTFail("\(error)") }
        }
    }

    func testFullPoolNamesHoldersAndTheEarliestReclaim() async throws {
        let clock = Clock()
        var budget = ResourceBudget.default
        budget.maximumSessions = 1
        let manager = makeManager(displayID: 97_010, budget: budget, clock: clock)
        addTeardownBlock { _ = try? await manager.destroyAll(quitApps: false) }
        let first = await create(manager, name: "research")
        XCTAssertTrue(first.ok, first.error ?? "")

        let refused = await create(manager, name: nil, owner: "second", lease: UUID())
        XCTAssertFalse(refused.ok)
        XCTAssertEqual(refused.errorCode, "resource_limit")
        XCTAssertNil(refused.retryAfterSeconds, "a live owner's session has no known release time")
        XCTAssertEqual(refused.holders?.map(\.session), ["research"])
        XCTAssertEqual(refused.holders?.first?.owner, "unit test controller")
        XCTAssertEqual(refused.holders?.first?.abandoned, false)
        XCTAssertNil(refused.holders?.first?.reclaimableInSeconds)
        XCTAssertEqual(refused.recovery?.tool, "spaceo_pool_status")
        XCTAssertNil(refused.recovery?.arguments["session"], "pool_status takes no session argument")

        // Lease expiry at t+10 abandons the session; grace 5 frees it at t+15. At t+12: 3 s.
        clock.advance(12)
        let later = await create(manager, name: nil, owner: "second", lease: UUID())
        XCTAssertEqual(later.errorCode, "resource_limit")
        XCTAssertEqual(later.retryAfterSeconds, 3)
        XCTAssertEqual(later.holders?.first?.abandoned, true)
        XCTAssertEqual(later.holders?.first?.reclaimableInSeconds, 3)
        XCTAssertTrue(later.error?.contains("retry in 3 s") == true, later.error ?? "")
        XCTAssertTrue(later.recovery?.then.contains("retry after 3 s") == true)
        // Holders never carry app or window content.
        let encoded = String(decoding: try JSONEncoder().encode(later.holders), as: UTF8.self)
        XCTAssertFalse(encoded.contains("apps") || encoded.contains("windows"), encoded)
    }

    // MARK: - 4. Recovery hints are bound on the thrown-error path

    func testThrownStaleSnapshotRecoveryNamesTheRequestSessionAndWindow() async throws {
        let manager = makeManager(displayID: 97_020)
        addTeardownBlock { _ = try? await manager.destroyAll(quitApps: false) }
        _ = await create(manager, name: "alpha")
        _ = await create(manager, name: "beta", owner: "other", lease: UUID())

        var click = TestController.request("click", session: "alpha")
        click.element = "3"
        click.snapshotID = UUID().uuidString
        click.window = 42
        let refused = await manager.handle(click)
        XCTAssertEqual(refused.errorCode, "stale_snapshot")
        XCTAssertEqual(refused.recovery?.tool, "spaceo_read_screen")
        XCTAssertEqual(refused.recovery?.arguments["session"], "alpha")
        XCTAssertEqual(refused.recovery?.arguments["window"], "42")
        XCTAssertFalse(refused.error?.contains("spaceo ax") == true, refused.error ?? "")
    }

    func testBindingOnlyFillsArgumentsTheToolAccepts() {
        let list = RecoveryHint(tool: "spaceo_session_list", then: "x").bound(session: "s1", window: 7)
        XCTAssertTrue(list.arguments.isEmpty, "\(list.arguments)")
        let create = RecoveryHint(tool: "spaceo_session_create", then: "x").bound(session: "dead", window: nil)
        XCTAssertNil(create.arguments["session"])
        let windows = RecoveryHint(tool: "spaceo_list_windows", arguments: ["timeout": "10"], then: "x")
            .bound(session: "s1", window: 7)
        XCTAssertEqual(windows.arguments, ["timeout": "10", "session": "s1"])
    }

    // MARK: - 5. Messages are surface-neutral

    func testAgentFacingMessagesCarryNoCLIOnlySyntax() {
        let messages = [
            SpaceOError.elementNotPressable(role: "AXGroup", actions: []).description,
            SpaceOError.unavailable(capability: "x").description,
            SpaceOError.resourceLimit(kind: .sessions, detail: "full", retryAfter: 4).description,
        ]
        for message in messages {
            XCTAssertFalse(message.contains("`spaceo"), message)
            XCTAssertFalse(message.contains("--"), message)
        }
    }

    // MARK: - 6. Ambiguous sessions

    func testAmbiguousSessionNamesTheCandidatesAndTheArgument() async throws {
        let manager = makeManager(displayID: 97_030)
        addTeardownBlock { _ = try? await manager.destroyAll(quitApps: false) }
        _ = await create(manager, name: "alpha", owner: "a", lease: UUID())
        _ = await create(manager, name: "beta", owner: "b", lease: UUID())
        let refused = await manager.handle(Request(cmd: "windows"))
        XCTAssertEqual(refused.errorCode, "bad_request")
        let message = try XCTUnwrap(refused.error)
        XCTAssertTrue(message.contains("2 sessions exist (alpha, beta)"), message)
        XCTAssertTrue(message.contains("session argument"), message)
        XCTAssertTrue(message.contains("--session"), message)
    }

    func testAmbiguousSessionListIsBounded() async throws {
        let manager = makeManager(displayID: 97_031)
        addTeardownBlock { _ = try? await manager.destroyAll(quitApps: false) }
        for index in 0..<10 {
            let created = await create(manager, name: "s\(index)", owner: "o\(index)", lease: UUID())
            XCTAssertTrue(created.ok, created.error ?? "")
        }
        let error = await manager.ambiguousSessionError()
        XCTAssertTrue(error.description.contains("10 sessions exist (s0, s1, s2, s3, s4, s5, s6, s7 and 2 more)"),
                      error.description)
    }

    func testLeaseCoveringExactlyOneSessionIsTheDefault() async throws {
        let manager = makeManager(displayID: 97_032)
        addTeardownBlock { _ = try? await manager.destroyAll(quitApps: false) }
        let mine = UUID()
        _ = await create(manager, name: "alpha", owner: "a", lease: UUID())
        _ = await create(manager, name: "mine", owner: "me", lease: mine)
        let resolved = try await manager.resolveForRead(nil, leaseID: mine)
        XCTAssertEqual(resolved.id, "mine")
        do {
            _ = try await manager.resolveForRead(nil, leaseID: UUID())
            XCTFail("a lease covering no session must not pick one")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("2 sessions exist"))
        }
    }

    func testNoSessionsMessageIsNeutral() async {
        let manager = makeManager(displayID: 97_033)
        let refused = await manager.handle(Request(cmd: "windows"))
        XCTAssertEqual(refused.error, "no sessions exist; create a session first")
    }

    // MARK: - 8. Names and apps

    func testExistingNameSaysWhoHoldsItAndSuggestsOmittingIt() async throws {
        let manager = makeManager(displayID: 97_040)
        addTeardownBlock { _ = try? await manager.destroyAll(quitApps: false) }
        _ = await create(manager, name: "research")

        let foreign = await create(manager, name: "research", owner: "other", lease: UUID())
        let message = try XCTUnwrap(foreign.error)
        XCTAssertTrue(message.contains("session 'research' already exists: live, held by 'unit test controller'"),
                      message)
        XCTAssertTrue(message.contains("omit the name"), message)

        let own = await create(manager, name: "research", lease: UUID())
        XCTAssertTrue(own.error?.contains("already exists and is yours") == true, own.error ?? "")
    }

    func testAppNotFoundSuggestsNearestInstalledNames() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("spaceo-app-catalog-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        func bundle(_ path: String, displayName: String? = nil) throws {
            let contents = root.appendingPathComponent(path).appendingPathComponent("Contents")
            try FileManager.default.createDirectory(at: contents, withIntermediateDirectories: true)
            if let displayName {
                let plist: NSDictionary = ["CFBundleDisplayName": displayName]
                try plist.write(to: contents.appendingPathComponent("Info.plist"))
            }
        }
        try bundle("TextEdit.app")
        try bundle("Google Chrome.app")
        try bundle("Utilities/Activity Monitor.app")
        try bundle("Adobe Photoshop 2024/Adobe Photoshop 2024.app")
        try bundle("Code.app", displayName: "Visual Studio Code")
        try FileManager.default.createDirectory(at: root.appendingPathComponent("Notes"),
                                                withIntermediateDirectories: true)

        let entries = AppNameCatalog.entries(in: [root.path])
        XCTAssertEqual(entries.count, 5)
        XCTAssertEqual(AppNameCatalog.match("google chrome", in: entries)?.lastPathComponent, "Google Chrome.app")
        XCTAssertEqual(AppNameCatalog.match("Text Edit", in: entries)?.lastPathComponent, "TextEdit.app")
        XCTAssertEqual(AppNameCatalog.match("activity monitor", in: entries)?.lastPathComponent,
                       "Activity Monitor.app")
        XCTAssertEqual(AppNameCatalog.match("Adobe Photoshop 2024", in: entries)?.lastPathComponent,
                       "Adobe Photoshop 2024.app")
        XCTAssertEqual(AppNameCatalog.match("visual studio code", in: entries)?.lastPathComponent, "Code.app")
        XCTAssertNil(AppNameCatalog.match("Numbers", in: entries))

        XCTAssertEqual(AppNameCatalog.suggestions(for: "TextEdt", in: entries), ["TextEdit"])
        XCTAssertEqual(AppNameCatalog.suggestions(for: "Chrome", in: entries), ["Google Chrome"])
        XCTAssertEqual(AppNameCatalog.suggestions(for: "Photoshop", in: entries), ["Adobe Photoshop 2024"])
        XCTAssertEqual(AppNameCatalog.suggestions(for: "Zzyzx Qwerty", in: entries), [])
        XCTAssertLessThanOrEqual(AppNameCatalog.suggestions(for: "e", in: entries).count, 3)

        let message = SessionManager.appNotFoundMessage("TextEdt", suggestions: ["TextEdit"])
        XCTAssertEqual(message, "could not find an application named 'TextEdt'; did you mean 'TextEdit'? "
                       + "An app's full .app path or bundle identifier also works.")
        XCTAssertEqual(AppNameCatalog.editDistance("kitten", "sitting"), 3)
    }
}

// MARK: - Detached sessions (7)

final class DetachedSessionGuidanceTests: XCTestCase {
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

    private let timestamp = Date(timeIntervalSince1970: 1_700_300_000)
    private let oldDaemon = UUID(uuidString: "91000000-0000-0000-0000-000000000001")!
    private let newDaemon = UUID(uuidString: "92000000-0000-0000-0000-000000000002")!

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

    func testDetachedSessionIsNamedAsDetachedWithRecoveryToCreate() async throws {
        let container = FileManager.default.temporaryDirectory
            .appendingPathComponent("spaceo-detached-guidance-\(UUID())", isDirectory: true)
        try FileManager.default.createDirectory(at: container, withIntermediateDirectories: false,
                                                attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(at: container) }
        let store = try SessionStore(rootDirectory: container.appendingPathComponent("state", isDirectory: true),
                                     namespace: "guidance")
        let app = DurableSessionApp(
            identity: ProcessIdentity(pid: 63_001, startedAtMicroseconds: 630_001),
            provenance: .launched, bundleIdentifier: "dev.spaceo.guidance", name: "Guidance App",
            url: URL(fileURLWithPath: "/Applications/Guidance.app"))
        let record = DurableSessionRecord(
            id: "orphan", revision: 1,
            createdAt: timestamp.addingTimeInterval(-120), updatedAt: timestamp.addingTimeInterval(-10),
            ownershipState: .owned, runtimeState: .attached, operationState: .ready,
            recoveryState: .notNeeded, lastActivityAt: timestamp.addingTimeInterval(-20),
            owner: DurableSessionOwner(id: "prior", kind: .mcp, label: "Prior MCP"),
            lease: DurableSessionLease(
                daemonInstanceID: oldDaemon, leaseID: UUID(), generation: 1,
                acquiredAt: timestamp.addingTimeInterval(-100),
                lastHeartbeatAt: timestamp.addingTimeInterval(-20),
                expiresAt: timestamp.addingTimeInterval(280)),
            apps: [app])
        try store.save(SessionLedger(storeRevision: 1, writerDaemonInstanceID: oldDaemon, updatedAt: timestamp,
                                     nextAutomaticSessionNumber: 2, sessions: [record]))
        let now = timestamp
        let recovery = SessionRecoveryCoordinator(
            store: store,
            recovery: DetachedSessionRecovery(
                daemonInstanceID: newDaemon,
                policy: try DetachedSessionRecoveryPolicy(gracePeriod: 30, gracefulQuitTimeout: 0,
                                                          forceQuitTimeout: 0),
                now: { now },
                currentIdentity: { $0 == app.identity.pid ? app.identity : nil },
                quit: { _, _ in },
                waitForExit: { apps, _ in apps.map(\.identity) }),
            now: { now })
        _ = try recovery.startup()
        let backing = DisplayBacking(displayID: 97_050)
        let stage = Stage(testingBacking: backing, onlineDisplayIDs: { backing.isAttached ? [97_050] : [] })
        let manager = try SessionManager(
            pool: DisplayPool(sessionsPerDisplay: 1, displaySize: backing.bounds.size,
                              stageFactory: { _, _, _, _ in stage }, stageRetirer: { $0.invalidate() }),
            runJanitor: false, sessionStore: store, recoveryCoordinator: recovery,
            daemonInstanceID: newDaemon)

        var windows = Request(cmd: "windows")
        windows.session = "orphan"
        let refused = await manager.handle(windows)
        XCTAssertEqual(refused.errorCode, "session_detached")
        let message = try XCTUnwrap(refused.error)
        XCTAssertTrue(message.contains("session 'orphan' was detached by a daemon restart at "), message)
        XCTAssertTrue(message.contains("create a new session"), message)
        XCTAssertEqual(refused.recovery?.tool, "spaceo_session_create")
        XCTAssertNil(refused.recovery?.arguments["session"], "never ask to recreate the detached name")

        var unknown = Request(cmd: "windows")
        unknown.session = "never-existed"
        let missing = await manager.handle(unknown)
        XCTAssertEqual(missing.errorCode, "unknown_session")

        let taken = await manager.handle(TestController.createRequest(session: "orphan"))
        XCTAssertTrue(taken.error?.contains("session 'orphan' already exists: detached by a daemon restart (last held by 'Prior MCP')") == true,
                      taken.error ?? "")
        XCTAssertTrue(taken.error?.contains("omit the name") == true)
    }
}
