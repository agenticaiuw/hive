import XCTest
import AppKit
import CoreGraphics
import Darwin
@testable import SpaceOKit

/// Tests that touch the real WindowServer.
///
/// These skip (rather than fail) when the host lacks the TCC grants, so the suite stays honest
/// on a machine that has not been set up. Every test asserts in `tearDown` that it left no
/// phantom display behind — a leaked virtual monitor is a user-visible defect, not a detail.
final class IntegrationTests: XCTestCase {

    private static let failureLock = NSLock()
    private static var stopped = false
    private static var initialUserConfiguration: Stage.UserDisplayConfiguration?

    override func record(_ issue: XCTIssue) {
        Self.failureLock.withLock { Self.stopped = true }
        // Stop admission to later cases immediately, but let this case's defers retire
        // its displays before opening the lifecycle circuit in teardown.
        super.record(issue)
    }

    private var baselineDisplays: Set<CGDirectDisplayID> = []
    private var baselineUserDisplays: Stage.UserDisplayConfiguration?
    private var hasDisplayBaseline = false
    private var admittedLiveCase = false

    override func setUpWithError() throws {
        // This guard is deliberately before the first WindowServer call, including baselines.
        // A plain `swift test` must never opt a daily-use desktop into live mutations.
        guard ProcessInfo.processInfo.environment["SPACEO_LIVE_TESTS"] == "1" else {
            throw XCTSkip("live tests require scripts/test.sh live on a reserved host")
        }
        guard !Self.failureLock.withLock({ Self.stopped }) else {
            throw XCTSkip("live suite stopped after its first failure; no further display work")
        }
        continueAfterFailure = false
        let capabilities = Capabilities()
        guard capabilities.canDrive else {
            throw XCTSkip("SpaceO cannot drive sessions on this host: \(capabilities.report)")
        }
        // Pacing alone does not prove OS recovery. Sample again after the wait, before
        // display inventory/admission, so a quiet preflight cannot admit the whole long suite.
        Thread.sleep(forTimeInterval: 90)
        try requireHostHealth()
        try Stage.beginLiveTestCase()
        admittedLiveCase = true
        let initial = try Stage.liveTestUserConfiguration()
        baselineUserDisplays = Self.failureLock.withLock {
            if Self.initialUserConfiguration == nil { Self.initialUserConfiguration = initial }
            return Self.initialUserConfiguration
        }
        try requireUnchangedUserConfiguration(initial)
        // After admission, arm the baseline before any remaining prerequisite can skip.
        baselineDisplays = Set(try Stage.liveTestOnlineDisplayIDs())
        hasDisplayBaseline = true

        try XCTSkipUnless(capabilities.canDrive, """
            SpaceO cannot drive sessions on this host:
            \(capabilities.report)
            """)
    }

    private func requireHostHealth() throws {
        do {
            try LiveHostHealth.requireAdmission()
        } catch {
            Self.failureLock.withLock { Self.stopped = true }
            throw error
        }
    }

    private func requireUnchangedUserConfiguration(_ current: Stage.UserDisplayConfiguration) throws {
        guard let expected = baselineUserDisplays else {
            throw SpaceOError.stageCreationFailed("live suite has no physical display baseline")
        }
        let changes = current.changes(from: expected)
        guard changes.isEmpty else {
            XCTFail("physical display configuration changed during the live suite: \(changes.joined(separator: "; "))")
            throw SpaceOError.stageCreationFailed("live qualification topology changed; stop and inspect")
        }
    }

    override func tearDownWithError() throws {
        guard admittedLiveCase else { return }
        guard hasDisplayBaseline else {
            // Setup creates no display before the baseline. Keep its pending marker latched.
            Self.failureLock.withLock { Self.stopped = true }
            Stage.stopLiveDisplayWork()
            return
        }
        do {
            // Assertion failures must not disarm this verification. Defers have had a chance
            // to use the still-healthy retirement path; an OS failure still closes it itself.
            let deadline = ContinuousClock.now.advanced(by: .seconds(15))
            var current = Set(try Stage.liveTestOnlineDisplayIDs())
            while ContinuousClock.now < deadline, current != baselineDisplays {
                RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.1))
                current = Set(try Stage.liveTestOnlineDisplayIDs())
            }
            guard current == baselineDisplays else {
                throw SpaceOError.stageCreationFailed("live cleanup did not restore the display baseline")
            }
            if let baselineUserDisplays {
                let changes = try Stage.liveTestUserConfiguration().changes(from: baselineUserDisplays)
                guard changes.isEmpty else {
                    throw SpaceOError.stageCreationFailed("live cleanup changed the physical display configuration")
                }
            }
            if Self.failureLock.withLock({ Self.stopped }) {
                Stage.stopLiveDisplayWork()
            } else {
                try Stage.finishLiveTestCase()
            }
        } catch {
            Self.failureLock.withLock { Self.stopped = true }
            Stage.stopLiveDisplayWork()
            // Do not let normal XCTest exit deallocate an unverified display backing. The
            // supervisor records this request and retains the entire owned group. Self-stop
            // also protects direct invocations if no supervisor is present.
            FileHandle.standardError.write(Data("LIVE SAFETY STOP REQUEST: live cleanup could not be verified; inspect the retained owner\n".utf8))
            raise(SIGSTOP)
            while true { pause() } // A manual SIGCONT is not permission to resume test work.
        }
        // Cleanup is already verified. A health refusal must fail qualification and latch
        // future admission, without suspending an owner whose display has safely retired.
        do {
            try requireHostHealth()
            try LiveHostHealth.requireNativeReadiness()
        } catch {
            Stage.stopLiveDisplayWork()
            throw error
        }
    }

    // MARK: - Stage lifecycle
    //
    // Deliberately app-free: this isolates display create/destroy from anything an
    // application might be doing to keep the display alive.

    func testStageCreateAndDestroyLeavesNoDisplay() throws {
        let before = Set(Stage.onlineDisplayIDs())
        let userDisplaysBefore = Stage.userDisplayConfiguration()
        let stage = try Stage(name: "test-lifecycle", width: 1280, height: 800)
        let id = stage.displayID

        XCTAssertTrue(stage.isValid)
        XCTAssertTrue(Stage.activeDisplayIDs().contains(id), "stage did not register as a display")
        XCTAssertEqual(Set(Stage.onlineDisplayIDs()).subtracting(before), [id])
        let attachmentChanges = Stage.userDisplayConfiguration().changes(from: userDisplaysBefore)
        XCTAssertTrue(
            attachmentChanges.isEmpty,
            "attaching the virtual display changed a user monitor setting: "
                + attachmentChanges.joined(separator: "; "))

        XCTAssertTrue(stage.invalidate(), "virtual display did not retire before the timeout")
        XCTAssertFalse(Stage.onlineDisplayIDs().contains(id),
                       "invalidate() must not return while the display remains online")
        let retirementChanges = Stage.userDisplayConfiguration().changes(from: userDisplaysBefore)
        XCTAssertTrue(
            retirementChanges.isEmpty,
            "retiring the virtual display changed a user monitor setting: "
                + retirementChanges.joined(separator: "; "))
    }

    func testStageOwnsItsOwnSpace() throws {
        let stage = try Stage(name: "test-space", width: 1280, height: 800)
        defer { stage.invalidate() }

        XCTAssertFalse(stage.spaces.isEmpty, "a stage must own at least one managed Space")
        XCTAssertTrue(stage.hasOwnSpace,
                      "the stage's Space must be distinct from the user's active Space — this is "
                      + "what keeps agent windows composited instead of occlusion-paused")
    }

    func testMultipleStagesCoexist() throws {
        let before = Set(Stage.activeDisplayIDs())
        var stages: [Stage] = []
        defer { stages.forEach { $0.invalidate() } }

        for index in 1...3 {
            stages.append(try Stage(name: "test-multi-\(index)", width: 1024, height: 768))
        }

        let ids = Set(stages.map(\.displayID))
        XCTAssertEqual(ids.count, 3, "each agent must get a distinct display")
        XCTAssertEqual(Set(Stage.activeDisplayIDs()).subtracting(before), ids)

        let spaces = stages.flatMap(\.spaces)
        XCTAssertEqual(Set(spaces).count, spaces.count, "stages must not share a Space")
    }

    // MARK: - The isolation invariant
    //
    // Run a full agent workflow and prove none of the covered dimensions detected a breach.
    // Input-route coverage remains unknown until macOS provides a safe observation mechanism.

    func testFullWorkflowHasNoCoveredIsolationBreach() async throws {
        let appURL = try XCTUnwrap(AppLauncher.resolve("TextEdit"))
        let pool = DisplayPool(sessionsPerDisplay: 1, displaySize: CGSize(width: 1600, height: 1000))
        let session = AgentSession(id: "test-workflow", slot: try pool.allocate())
        var destroyed = false
        defer { if !destroyed { session.destroy() }; pool.releaseAll() }

        let scratch = URL(fileURLWithPath: NSTemporaryDirectory() + "spaceo-test-\(UUID().uuidString).txt")
        try "".write(to: scratch, atomically: true, encoding: .utf8)
        defer { try? FileManager.default.removeItem(at: scratch) }

        let before = IsolationSnapshot.captureStable()

        // Launch
        let app = try await session.launch(app: appURL, opening: [scratch])
        let afterLaunch = IsolationSnapshot.capture()
        XCTAssertTrue(
            afterLaunch.report(comparedTo: before).failures.isEmpty,
            "launch caused a covered isolation breach: \(afterLaunch.drift(from: before))"
        )

        // Placement
        let window = try XCTUnwrap(session.primaryWindow, "app produced no window")
        XCTAssertTrue(WindowPlacement.isInRegion(window, session.frame),
                      "window did not land in the session's tile")
        let windowSpaces = Set(WindowPlacement.spaces(of: window))
        XCTAssertFalse(windowSpaces.isEmpty)
        XCTAssertTrue(windowSpaces.isSubset(of: Set(session.stage.spaces)),
                      "window is on \(windowSpaces.sorted()), stage owns \(session.stage.spaces.sorted())")

        // Input
        let marker = "spaceo-\(UUID().uuidString.prefix(8))"
        try InputRouter.prepareForInput(window)
        try InputRouter.type("verified \(marker)", to: app.pid)

        // Poll rather than sleep a fixed amount: on a loaded machine the app can take a while
        // to drain the synthesised events, and a fixed sleep turns that into a flaky test.
        // Read back from *our* window rather than the app's focused element: if TextEdit was
        // already open before the test, the app-wide focus is some other document.
        var readBack = ""
        let inputDeadline = Date().addingTimeInterval(8)
        while Date() < inputDeadline {
            readBack = AXTree.text(in: window) ?? ""
            if readBack.contains(marker) { break }
            try await Task.sleep(nanoseconds: 150_000_000)
        }
        XCTAssertTrue(readBack.contains(marker),
                      "typed text never reached our window (value: '\(readBack.prefix(60))')")

        // Accessibility addressing stays live on a non-user display
        let snapshot = try session.snapshotAX(window: window)
        XCTAssertGreaterThan(snapshot.actionableCount, 0,
                             "AX tree went stale — the occlusion problem the display design avoids")

        // The invariant, over the whole workflow
        let after = IsolationSnapshot.capture()
        XCTAssertTrue(
            after.report(comparedTo: before).failures.isEmpty,
            "COVERED ISOLATION BREACH: \(after.drift(from: before).joined(separator: "; "))"
        )

        // Teardown must also be clean
        let displayID = session.stage.displayID
        session.destroy()
        pool.release(session.slot)
        destroyed = true
        XCTAssertFalse(Stage.onlineDisplayIDs().contains(displayID))

        // Ownership matters here: SpaceO must quit what it started, and must NOT kill an
        // instance that was already running before the session existed.
        if app.startedByUs {
            XCTAssertNil(NSRunningApplication(processIdentifier: app.pid),
                         "an app SpaceO started outlived its session")
        } else {
            XCTAssertNotNil(NSRunningApplication(processIdentifier: app.pid),
                            "SpaceO killed an app it merely adopted — it must never do that")
        }
    }

    func testCaptureOfAgentScreenIsActuallyRendered() async throws {
        try XCTSkipUnless(Capabilities().canCapture, "Screen Recording not granted")

        let appURL = try XCTUnwrap(AppLauncher.resolve("TextEdit"))
        let pool = DisplayPool(sessionsPerDisplay: 1, displaySize: CGSize(width: 1440, height: 900))
        let session = AgentSession(id: "test-capture", slot: try pool.allocate())
        defer { session.destroy(); pool.releaseAll() }

        let scratch = URL(fileURLWithPath: NSTemporaryDirectory() + "spaceo-cap-\(UUID().uuidString).txt")
        try "rendered content for capture".write(to: scratch, atomically: true, encoding: .utf8)
        defer { try? FileManager.default.removeItem(at: scratch) }

        _ = try await session.launch(app: appURL, opening: [scratch])
        let window = try XCTUnwrap(session.primaryWindow)
        try await Task.sleep(nanoseconds: 500_000_000)

        let windowShot = try await Capture.window(window)
        XCTAssertTrue(Capture.looksRendered(windowShot.image),
                      "window capture was blank — entropy \(Capture.visualEntropy(windowShot.image))")
        // A click takes window-local points, so the default capture has to hand back points.
        // While window captures were hard-coded to 2x and tile captures to 1x, a coordinate read
        // off a screenshot landed at half position with nothing in the response to reveal it.
        XCTAssertEqual(windowShot.geometry.scale, 1)
        XCTAssertEqual(Double(windowShot.image.width),
                       windowShot.geometry.pointWidth, accuracy: 1)

        let tileShot = try await Capture.region(session.stage, session.frame)
        XCTAssertEqual(tileShot.image.width, 1440)
        XCTAssertEqual(tileShot.geometry.scale, windowShot.geometry.scale,
                       "window and tile captures must agree on scale")
        XCTAssertTrue(Capture.looksRendered(tileShot.image),
                      "tile capture was blank — entropy \(Capture.visualEntropy(tileShot.image))")

        // A zoomed sub-region is expressed against the tile and clamped to it, so an agent can
        // never widen its view past its own tile by asking for a larger rect.
        let zoom = try await Capture.region(
            session.stage, session.frame,
            subRect: CGRect(x: 0, y: 0, width: 4_000, height: 4_000))
        XCTAssertEqual(zoom.image.width, 1440,
                       "an oversized region must clamp to the session's own tile")
    }

    // MARK: - Refusals

    func testUnknownSessionIsRejected() async {
        let manager = SessionManager()
        var request = Request(cmd: "windows")
        request.session = "does-not-exist"
        let response = await manager.handle(request)
        XCTAssertFalse(response.ok)
        XCTAssertTrue(response.error?.contains("does-not-exist") == true)
    }

    func testAmbiguousSessionIsRejectedRatherThanGuessed() async throws {
        let manager = SessionManager()
        _ = try await manager.create(name: "a")
        _ = try await manager.create(name: "b")
        defer { Task { try? await manager.destroyAll(quitApps: false) } }

        let response = await manager.handle(Request(cmd: "windows"))
        XCTAssertFalse(response.ok, "with two sessions live, an unnamed command must not pick one")
        XCTAssertTrue(response.error?.contains("2 sessions") == true)
    }

    // MARK: - Shared displays
    //
    // A virtual display is a whole framebuffer for the WindowServer to composite, so the
    // headline property here is "more sessions must not mean more displays".

    func testSessionsShareOneDisplayUntilItIsFull() throws {
        // Four usable 1280x800 tiles require a 2560x1600 canvas. The default 1920x1080
        // display would create 960x540 quadrants and is correctly rejected by the pool.
        let pool = DisplayPool(sessionsPerDisplay: 4,
                               displaySize: CGSize(width: 2560, height: 1600))
        defer { pool.releaseAll() }

        var slots: [DisplayPool.Slot] = []
        for _ in 0..<4 { slots.append(try pool.allocate()) }

        XCTAssertEqual(pool.displayCount, 1, "four sessions at 4-per-display need exactly one display")
        XCTAssertEqual(pool.sessionCount, 4)
        XCTAssertEqual(Set(slots.map { $0.stage.displayID }).count, 1)
        XCTAssertEqual(Set(slots.map(\.index)).count, 4, "tiles must be distinct")

        for i in slots.indices {
            for j in slots.indices where j > i {
                XCTAssertFalse(slots[i].frame.intersects(slots[j].frame),
                               "tile \(i) overlaps tile \(j) on a live display")
            }
        }

        // The fifth spills onto a second display.
        let fifth = try pool.allocate()
        XCTAssertEqual(pool.displayCount, 2)
        XCTAssertNotEqual(fifth.stage.displayID, slots[0].stage.displayID)

        pool.release(fifth)
        XCTAssertEqual(pool.displayCount, 1, "the spill display must be retired once it empties")
    }

    func testDisplayIsRetiredOnlyWhenTheLastTenantLeaves() throws {
        let before = Set(Stage.onlineDisplayIDs())
        let pool = DisplayPool(sessionsPerDisplay: 2)
        defer { pool.releaseAll() }

        let first = try pool.allocate()
        let second = try pool.allocate()
        let displayID = first.stage.displayID
        XCTAssertEqual(pool.displayCount, 1)

        pool.release(first)
        XCTAssertTrue(Stage.activeDisplayIDs().contains(displayID),
                      "the display must survive while a neighbour is still using it")

        pool.release(second)
        XCTAssertFalse(Stage.onlineDisplayIDs().contains(displayID))
        XCTAssertEqual(Set(Stage.onlineDisplayIDs()), before)
    }

    func testTwoSessionsOnOneDisplayStayInTheirOwnTiles() async throws {
        let appURL = try XCTUnwrap(AppLauncher.resolve("TextEdit"))
        let pool = DisplayPool(sessionsPerDisplay: 2)
        let left = AgentSession(id: "tile-left", slot: try pool.allocate())
        let right = AgentSession(id: "tile-right", slot: try pool.allocate())
        defer {
            left.destroy()                       // quits what it started; no leak into later runs
            right.destroy()
            pool.releaseAll()
        }

        XCTAssertEqual(left.stage.displayID, right.stage.displayID)
        XCTAssertFalse(left.frame.intersects(right.frame))

        let scratch = URL(fileURLWithPath: NSTemporaryDirectory() + "spaceo-tile-\(UUID().uuidString).txt")
        try "tile test".write(to: scratch, atomically: true, encoding: .utf8)
        defer { try? FileManager.default.removeItem(at: scratch) }

        let otherScratch = URL(fileURLWithPath: NSTemporaryDirectory()
                               + "spaceo-tile-other-\(UUID().uuidString).txt")
        try "other tile test".write(to: otherScratch, atomically: true, encoding: .utf8)
        defer { try? FileManager.default.removeItem(at: otherScratch) }

        let leftApp = try await left.launch(app: appURL, opening: [scratch])
        let rightApp = try await right.launch(app: appURL, opening: [otherScratch])
        XCTAssertNotEqual(leftApp.pid, rightApp.pid,
                          "two sessions must never adopt and fight over the same app process")

        let window = try XCTUnwrap(left.primaryWindow)
        let rightWindow = try XCTUnwrap(right.primaryWindow)

        XCTAssertTrue(WindowPlacement.isInRegion(window, left.frame),
                      "window landed outside its own session's tile")
        XCTAssertFalse(WindowPlacement.isInRegion(window, right.frame),
                       "window spilled into the neighbouring session's tile")
        XCTAssertTrue(WindowPlacement.isInRegion(rightWindow, right.frame))
        XCTAssertFalse(WindowPlacement.isInRegion(rightWindow, left.frame))
        // Match the production `verify` path: contain any late TextEdit window that appeared
        // after the launch result, then audit the settled session. On newer macOS builds the
        // untitled companion window can materialize between the assertions above and audit.
        right.sweepStrayWindows()
        let neighbourFindings = right.audit()
        XCTAssertTrue(
            neighbourFindings.isEmpty,
            "the neighbour should see nothing wrong; got \(neighbourFindings)"
        )
    }

    func testReleaseAllClearsOwnedSpaceBookkeeping() throws {
        let before = AgentActivity.ownedSpaces
        let pool = DisplayPool()
        _ = try pool.allocate()
        XCTAssertNotEqual(AgentActivity.ownedSpaces, before)

        pool.releaseAll()
        XCTAssertEqual(AgentActivity.ownedSpaces, before,
                       "released display Spaces must not cause false isolation breaches later")
    }

    // MARK: - Chromium web content
    //
    // The headline finding: synthetic input reaches a Chromium browser's chrome but never its
    // web content. This test is the proof that the DevTools path actually dispatches DOM events,
    // rather than the click silently evaporating — which is how it failed before.

    func testChromiumWebContentIsDrivenThroughDevTools() async throws {
        guard let chrome = AppLauncher.resolve("Google Chrome") else {
            throw XCTSkip("Google Chrome is not installed")
        }

        let page = URL(fileURLWithPath: NSTemporaryDirectory() + "spaceo-cdp-\(UUID().uuidString).html")
        try """
        <!doctype html><meta charset=utf-8><title>t</title>
        <button id=b>go</button><div id=out>0</div>
        <script>let n=0,r=0;
          b.onclick=()=>{n++;out.textContent=n};
          b.oncontextmenu=e=>{e.preventDefault();r++;out.textContent='r'+r};
        </script>
        """.write(to: page, atomically: true, encoding: .utf8)
        defer { try? FileManager.default.removeItem(at: page) }

        let pool = DisplayPool(sessionsPerDisplay: 1)
        let session = AgentSession(id: "test-cdp", slot: try pool.allocate())
        var destroyed = false
        defer {
            if !destroyed { session.destroy() }
            pool.releaseAll()
        }

        let before = IsolationSnapshot.captureStable()
        let app = try await session.launch(app: chrome, opening: [page])

        XCTAssertTrue(
            IsolationSnapshot.capture().report(comparedTo: before).failures.isEmpty,
            "browser launch caused a covered isolation breach before DevTools input")

        XCTAssertNotNil(app.devToolsPort,
                        "a Chromium browser must be launched with a DevTools port, or its web "
                        + "content cannot be driven at all")
        let profile = try XCTUnwrap(app.temporaryProfile)
        XCTAssertTrue(FileManager.default.fileExists(atPath: profile.path),
                      "launched Chromium instance did not create its private profile")
        let bridge = try XCTUnwrap(session.webBridge(for: app.pid),
                                   "no DevTools bridge attached to the launched browser")

        // The page must be readable...
        let elements = try await bridge.interactiveElements()
        XCTAssertTrue(elements.contains("[w0]"), "page elements were not enumerated: \(elements)")

        // ...and a click must actually reach the DOM.
        try await bridge.clickElement(index: 0)
        try await bridge.clickElement(index: 0)
        var counter = ""
        let deadline = Date().addingTimeInterval(5)
        while Date() < deadline {
            counter = (try? await bridge.evaluate("document.getElementById('out').textContent")) ?? ""
            if counter == "2" { break }
            try await Task.sleep(nanoseconds: 150_000_000)
        }
        XCTAssertEqual(counter, "2", "DOM clicks did not register — the page saw '\(counter)'")

        // Right-click must stay a right-click rather than being coerced to a left-click.
        try await bridge.clickElement(index: 0, button: .right)
        var afterRight = ""
        let rightDeadline = Date().addingTimeInterval(5)
        while Date() < rightDeadline {
            afterRight = (try? await bridge.evaluate("document.getElementById('out').textContent")) ?? ""
            if afterRight.hasPrefix("r") { break }
            try await Task.sleep(nanoseconds: 150_000_000)
        }
        XCTAssertEqual(afterRight, "r1", "right-click was lost or coerced — page saw '\(afterRight)'")

        // And none of the covered dimensions detected an attributable breach.
        let afterDriving = IsolationSnapshot.capture()
        XCTAssertTrue(
            afterDriving.report(comparedTo: before).failures.isEmpty,
            "driving a browser caused a covered isolation breach: "
                + afterDriving.breaches(from: before).joined(separator: "; ")
        )

        session.destroy()
        destroyed = true
        XCTAssertFalse(FileManager.default.fileExists(atPath: profile.path),
                       "destroying a browser session leaked its private profile")
    }

    func testAuditReportsAnAppThatExited() async throws {
        let appURL = try XCTUnwrap(AppLauncher.resolve("TextEdit"))
        let pool = DisplayPool()
        let session = AgentSession(id: "test-dead-app", slot: try pool.allocate())
        defer { session.destroy(); pool.releaseAll() }

        let scratch = URL(fileURLWithPath: NSTemporaryDirectory()
                          + "spaceo-dead-\(UUID().uuidString).txt")
        try "dead app audit".write(to: scratch, atomically: true, encoding: .utf8)
        defer { try? FileManager.default.removeItem(at: scratch) }
        let app = try await session.launch(app: appURL, opening: [scratch])

        AppLauncher.quit(app, force: true)
        let deadline = Date().addingTimeInterval(5)
        while NSRunningApplication(processIdentifier: app.pid) != nil, Date() < deadline {
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        XCTAssertNil(NSRunningApplication(processIdentifier: app.pid))
        XCTAssertTrue(session.audit().contains { $0.contains("exited") },
                      "refreshing windows must not erase the evidence that an owned app died")
    }

    // MARK: - Late windows
    //
    // Apps open windows after launch — restore prompts, dialogs, second documents — and every
    // one of those lands on the user's screen unless something pulls it back.

    /// Containment must come from the janitor itself — the AX observer, or the periodic sweep
    /// behind it. This test deliberately never calls `sweepStrayWindows()`: the old version did,
    /// inside its polling loop, which meant it passed whether or not a single notification was
    /// ever delivered. It was testing the sweep it performed, not the janitor.
    func testWindowWatcherContainsLateWindowsWithoutBeingSweptByHand() async throws {
        let appURL = try XCTUnwrap(AppLauncher.resolve("TextEdit"))
        let pool = DisplayPool(sessionsPerDisplay: 1)
        let session = AgentSession(id: "test-late", slot: try pool.allocate())
        defer { session.destroy(); pool.releaseAll() }

        let first = URL(fileURLWithPath: NSTemporaryDirectory() + "spaceo-late-a-\(UUID().uuidString).txt")
        try "one".write(to: first, atomically: true, encoding: .utf8)
        defer { try? FileManager.default.removeItem(at: first) }
        _ = try await session.launch(app: appURL, opening: [first])

        XCTAssertEqual(session.watcherRegistrationFailures, [String](),
                       "the AX observer must be fully registered, or containment is degraded "
                       + "to the periodic sweep alone and the audit should already say so")

        // Cmd-N asks the already-owned process to create a window after initial placement.
        // It keeps the test off the user's display and exercises the AX observer, not a second
        // independent app launch.
        let firstWindow = try XCTUnwrap(session.primaryWindow)
        try InputRouter.prepareForInput(firstWindow)
        try InputRouter.key(try KeyCombo.parse("cmd+n"), to: firstWindow.pid)

        // Generous enough for several periodic sweeps, so a missed notification is caught by the
        // backstop rather than failing the run.
        let deadline = Date().addingTimeInterval(max(10, WindowWatcher.periodicSweepInterval * 4))
        while Date() < deadline {
            session.refreshWindows()
            if session.windows.count >= 2,
               session.windows.allSatisfy({
                   WindowPlacement.isFullyInRegion($0.windowID, session.frame) ?? false
               }) {
                break
            }
            try await Task.sleep(nanoseconds: 200_000_000)
        }

        session.refreshWindows()
        XCTAssertGreaterThanOrEqual(session.windows.count, 2, "expected both documents")
        for window in session.windows {
            // Full bounds, not the midpoint: a window whose centre is in the tile can still be
            // spilling across the user's screen, which is the failure that matters.
            XCTAssertEqual(WindowPlacement.isFullyInRegion(window.windowID, session.frame), true,
                           "window '\(window.title)' is not fully inside the agent's tile")
        }
    }

    /// The janitor must reap a process that exited on its own, without waiting for an operator
    /// command — and reaping must release the ownership claim so the PID is adoptable again.
    func testJanitorReapsAnExitedAppAndReleasesItsClaim() async throws {
        let appURL = try XCTUnwrap(AppLauncher.resolve("TextEdit"))
        let pool = DisplayPool(sessionsPerDisplay: 1)
        let session = AgentSession(id: "test-reap", slot: try pool.allocate())
        defer { session.destroy(); pool.releaseAll() }

        let document = URL(fileURLWithPath: NSTemporaryDirectory() + "spaceo-reap-\(UUID().uuidString).txt")
        try "reap me".write(to: document, atomically: true, encoding: .utf8)
        defer { try? FileManager.default.removeItem(at: document) }
        let app = try await session.launch(app: appURL, opening: [document])
        XCTAssertEqual(ProcessOwnership.owner(of: app.identity), "test-reap")

        AppLauncher.quit(app, force: true)
        let deadline = Date().addingTimeInterval(10)
        while app.identity.isAlive && Date() < deadline {
            try await Task.sleep(nanoseconds: 200_000_000)
        }
        XCTAssertFalse(app.identity.isAlive, "the app should have exited")

        XCTAssertEqual(session.runJanitorPass(), 1, "the janitor should reap exactly one app")
        XCTAssertTrue(session.apps.isEmpty)
        XCTAssertNil(ProcessOwnership.owner(of: app.identity),
                     "a reaped app must not keep its process claim")
    }
}
