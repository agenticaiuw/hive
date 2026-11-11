import AppKit
import XCTest
@testable import SpaceOKit
@testable import SpaceOViewer

/// Keyboard and VoiceOver regressions for SPAO-123.
///
/// These exercise the policy and the actual surface event seam. They do not post synthetic input
/// to another process, so a failure cannot escape the test runner.
@MainActor
final class ViewerAccessibilityTests: XCTestCase {

    func testSlowPanDoesNotBecomeAnInputCaptureClick() throws {
        let view = VMSurfaceView(frame: NSRect(x: 0, y: 0, width: 800, height: 450), configureForDisplay: false)
        view.displayBounds = CGRect(x: 0, y: 0, width: 1600, height: 900)
        view.zoom = 2
        var captureRequests = 0
        var panSteps = 0
        view.onCaptureRequest = { captureRequests += 1 }
        view.onPan = { _ in panSteps += 1 }
        func event(_ type: NSEvent.EventType, x: CGFloat) throws -> NSEvent {
            try XCTUnwrap(NSEvent.mouseEvent(
                with: type, location: CGPoint(x: x, y: 100), modifierFlags: [],
                timestamp: 0, windowNumber: 0, context: nil, eventNumber: 0,
                clickCount: 1, pressure: 1))
        }
        view.mouseDown(with: try event(.leftMouseDown, x: 100))
        for x in 101...110 {
            view.mouseDragged(with: try event(.leftMouseDragged, x: CGFloat(x)))
        }
        view.mouseUp(with: try event(.leftMouseUp, x: 110))
        XCTAssertGreaterThan(panSteps, 0)
        XCTAssertEqual(captureRequests, 0, "A slow drag must not capture the host keyboard and pointer")
        view.mouseDown(with: try event(.leftMouseDown, x: 100))
        view.mouseUp(with: try event(.leftMouseUp, x: 100))
        XCTAssertEqual(captureRequests, 1, "An intentional click still requests control")
    }

    func testLocalExitRemainsConsumedThroughKeyUpAfterControlDisables() throws {
        let view = VMSurfaceView(frame: NSRect(x: 0, y: 0, width: 800, height: 450), configureForDisplay: false)
        view.interactionEnabled = true
        var exitCount = 0
        var forwarded: [(down: Bool, keyCode: UInt16)] = []
        view.onExitControl = {
            exitCount += 1
            view.interactionEnabled = false
        }
        view.onKey = { down, keyCode, _, _ in
            forwarded.append((down, keyCode))
        }

        XCTAssertTrue(view.handleKeyEvent(try keyEvent(
            type: .keyDown,
            keyCode: ViewerControlPolicy.localExitKeyCode,
            modifiers: [.control, .command]
        ), down: true))
        XCTAssertFalse(view.interactionEnabled,
                       "the real exit callback disables Control during key-down")
        XCTAssertTrue(view.handleKeyEvent(try keyEvent(
            type: .keyDown,
            keyCode: ViewerControlPolicy.localExitKeyCode,
            modifiers: [.control, .command]
        ), down: true), "an exact repeat remains part of the local exit sequence")
        XCTAssertTrue(view.handleKeyEvent(try keyEvent(
            type: .keyUp,
            keyCode: ViewerControlPolicy.localExitKeyCode,
            modifiers: []
        ), down: false))

        XCTAssertEqual(exitCount, 1, "only key-down performs the local exit")
        XCTAssertTrue(forwarded.isEmpty,
                      "neither half of the reserved chord may reach the remote input path")
    }

    func testOrdinaryEscapeRecoversFromALostLocalExitKeyUp() throws {
        let view = VMSurfaceView(frame: .zero, configureForDisplay: false)
        view.interactionEnabled = true
        var forwarded: [(keyCode: UInt16, modifiers: NSEvent.ModifierFlags)] = []
        view.onExitControl = { view.interactionEnabled = false }
        view.onKey = { _, keyCode, modifiers, _ in
            forwarded.append((keyCode, modifiers))
        }

        XCTAssertTrue(view.handleKeyEvent(try keyEvent(
            type: .keyDown,
            keyCode: ViewerControlPolicy.localExitKeyCode,
            modifiers: [.control, .command]
        ), down: true))
        // Simulate focus loss swallowing the matching key-up, followed by a later Control session.
        view.interactionEnabled = true

        XCTAssertTrue(view.handleKeyEvent(try keyEvent(
            type: .keyDown,
            keyCode: ViewerControlPolicy.localExitKeyCode,
            modifiers: []
        ), down: true))
        XCTAssertEqual(forwarded.count, 1,
                       "a fresh ordinary Escape must clear stale exit tracking and forward")
        XCTAssertEqual(forwarded.first?.keyCode, ViewerControlPolicy.localExitKeyCode)
        XCTAssertTrue(forwarded.first?.modifiers.isEmpty == true)
    }

    func testExactLocalExitStartsANewSequenceAfterReenablingControl() throws {
        let view = VMSurfaceView(frame: .zero, configureForDisplay: false)
        view.interactionEnabled = true
        var exitCount = 0
        view.onExitControl = {
            exitCount += 1
            view.interactionEnabled = false
        }
        view.onKey = { _, _, _, _ in XCTFail("the local exit was forwarded") }

        XCTAssertTrue(view.handleKeyEvent(try keyEvent(
            type: .keyDown,
            keyCode: ViewerControlPolicy.localExitKeyCode,
            modifiers: [.control, .command]
        ), down: true))
        XCTAssertEqual(exitCount, 1)

        // Lose key-up, then begin a genuinely new Control session.
        view.interactionEnabled = true
        XCTAssertTrue(view.handleKeyEvent(try keyEvent(
            type: .keyDown,
            keyCode: ViewerControlPolicy.localExitKeyCode,
            modifiers: [.control, .command]
        ), down: true))
        XCTAssertEqual(exitCount, 2,
                       "re-enabling Control must end stale exit-key tracking")
        XCTAssertFalse(view.interactionEnabled)
    }

    func testNearMissesStillReachTheRemoteInputPath() throws {
        let view = VMSurfaceView(frame: .zero, configureForDisplay: false)
        view.interactionEnabled = true
        var forwarded: [UInt16] = []
        view.onKey = { _, keyCode, _, _ in forwarded.append(keyCode) }

        XCTAssertTrue(view.handleKeyEvent(try keyEvent(
            type: .keyDown,
            keyCode: ViewerControlPolicy.localExitKeyCode,
            modifiers: []
        ), down: true))
        XCTAssertTrue(view.handleKeyEvent(try keyEvent(
            type: .keyDown,
            keyCode: ViewerControlPolicy.localExitKeyCode,
            modifiers: [.command]
        ), down: true))
        XCTAssertTrue(view.handleKeyEvent(try keyEvent(
            type: .keyDown,
            keyCode: ViewerControlPolicy.localExitKeyCode,
            modifiers: [.control, .command, .option]
        ), down: true))
        XCTAssertTrue(view.handleKeyEvent(try keyEvent(
            type: .keyDown,
            keyCode: 0,
            modifiers: [.control, .command]
        ), down: true))

        XCTAssertEqual(forwarded, [ViewerControlPolicy.localExitKeyCode,
                                   ViewerControlPolicy.localExitKeyCode,
                                   ViewerControlPolicy.localExitKeyCode, 0],
                       "ordinary Escape and near misses must still reach the remote display")
    }

    func testCapsLockDoesNotMakeTheExitChordUndiscoverable() throws {
        let view = VMSurfaceView(frame: .zero, configureForDisplay: false)
        view.interactionEnabled = true
        var exited = false
        view.onExitControl = { exited = true }
        view.onKey = { _, _, _, _ in XCTFail("the local exit was forwarded") }

        XCTAssertTrue(view.handleKeyEvent(try keyEvent(
            type: .keyDown,
            keyCode: ViewerControlPolicy.localExitKeyCode,
            modifiers: [.control, .command, .capsLock]
        ), down: true))
        XCTAssertTrue(exited)
    }

    func testSurfaceExposesRemoteDisplayRoleAndControlState() {
        let view = VMSurfaceView(frame: .zero, configureForDisplay: false)
        view.displayName = "Stage — Studio"
        view.streamRunning = true
        view.interactionEnabled = true

        XCTAssertTrue(view.isAccessibilityElement())
        XCTAssertEqual(view.accessibilityRole(), .group)
        XCTAssertEqual(view.accessibilityLabel(), "Remote display, Stage — Studio")
        XCTAssertEqual(view.accessibilityValue() as? String,
                       "Live stream. Control enabled.")
        XCTAssertEqual(
            view.accessibilityHelp(),
            "Keyboard and pointer input go to the remote display. Press "
                + "Control-Command-Escape to exit Control."
        )

        view.interactionEnabled = false
        view.streamRunning = false
        XCTAssertEqual(view.accessibilityValue() as? String,
                       "Stream unavailable. Viewing only.")
        XCTAssertEqual(
            view.accessibilityHelp(),
            "The remote display stream is unavailable. Control cannot be enabled until "
                + "the stream is live."
        )
    }

    func testSurfaceExplainsWhyAPhysicalDisplayCannotEnterControl() {
        let view = VMSurfaceView(frame: .zero, configureForDisplay: false)
        view.displayName = "Built-in Retina Display"
        view.streamRunning = true
        view.controlUnavailableReason =
            "Control unavailable. Physical displays are view-only; select a SpaceO display."

        XCTAssertEqual(
            view.accessibilityHelp(),
            "Control unavailable. Physical displays are view-only; select a SpaceO display."
        )
    }

    func testControlAdmissionExplainsEveryBlockedPermissionStateInWords() {
        XCTAssertEqual(
            ViewerControlPolicy.controlRequest(
                enabling: true,
                hasSelectedDisplay: false,
                selectedDisplayIsSpaceO: false,
                hasActiveSession: false,
                streamRunning: true,
                screenRecordingGranted: true,
                accessibilityGranted: true
            ),
            .blocked("Control unavailable. Select a display first.")
        )

        let noStream = ViewerControlPolicy.controlRequest(
            enabling: true,
            hasSelectedDisplay: true,
            selectedDisplayIsSpaceO: true,
            hasActiveSession: true,
            streamRunning: false,
            screenRecordingGranted: true,
            accessibilityGranted: true
        )
        let noCapture = ViewerControlPolicy.controlRequest(
            enabling: true,
            hasSelectedDisplay: true,
            selectedDisplayIsSpaceO: true,
            hasActiveSession: true,
            streamRunning: true,
            screenRecordingGranted: false,
            accessibilityGranted: true
        )
        let noAccessibility = ViewerControlPolicy.controlRequest(
            enabling: true,
            hasSelectedDisplay: true,
            selectedDisplayIsSpaceO: true,
            hasActiveSession: true,
            streamRunning: true,
            screenRecordingGranted: true,
            accessibilityGranted: false
        )
        guard case let .blocked(streamMessage) = noStream,
              case let .blocked(captureMessage) = noCapture,
              case let .blocked(accessibilityMessage) = noAccessibility else {
            return XCTFail("a missing stream or permission must block Control")
        }
        XCTAssertTrue(streamMessage.contains("live stream"))
        XCTAssertTrue(captureMessage.contains("Screen Recording permission"))
        XCTAssertTrue(accessibilityMessage.contains("Accessibility permission"))

        let physicalDisplay = ViewerControlPolicy.controlRequest(
            enabling: true,
            hasSelectedDisplay: true,
            selectedDisplayIsSpaceO: false,
            hasActiveSession: true,
            streamRunning: true,
            screenRecordingGranted: true,
            accessibilityGranted: true
        )
        let emptyStage = ViewerControlPolicy.controlRequest(
            enabling: true,
            hasSelectedDisplay: true,
            selectedDisplayIsSpaceO: true,
            hasActiveSession: false,
            streamRunning: true,
            screenRecordingGranted: true,
            accessibilityGranted: true
        )
        guard case let .blocked(physicalMessage) = physicalDisplay,
              case let .blocked(emptyMessage) = emptyStage else {
            return XCTFail("physical and empty displays must never admit Control")
        }
        XCTAssertTrue(physicalMessage.contains("view-only"))
        XCTAssertTrue(emptyMessage.contains("active agent session"))
    }

    func testModelRequiresAnActiveSessionAndLiveStreamAndDisablesControlWhenItStops() throws {
        let display = DisplayEntry(
            id: 7,
            bounds: CGRect(x: 0, y: 0, width: 1_920, height: 1_080),
            isSpaceO: true,
            isActive: true,
            name: "Stage — Test"
        )
        let session = try sessionInfo(id: "agent", displayID: display.id, frame: display.bounds)
        var blockedAnnouncements: [String] = []
        let blocked = ViewerModel(
            automaticRefresh: false,
            initialDisplays: [display],
            initialSelectedID: display.id,
            initialPermissions: PermissionState(
                screenRecording: true,
                accessibility: true
            ),
            initialSessions: [session],
            initialStreamRunning: false,
            accessibilityAnnouncement: { blockedAnnouncements.append($0) }
        )
        blocked.setInteractionEnabled(true)
        XCTAssertFalse(blocked.interactionEnabled)
        XCTAssertTrue(blocked.note?.isWarning == true)
        XCTAssertTrue(blocked.note?.text.contains("live stream") == true)
        XCTAssertTrue(blockedAnnouncements.last?.contains("live stream") == true)

        var liveAnnouncements: [String] = []
        let live = ViewerModel(
            automaticRefresh: false,
            initialDisplays: [display],
            initialSelectedID: display.id,
            initialPermissions: PermissionState(
                screenRecording: true,
                accessibility: true
            ),
            initialSessions: [session],
            initialStreamRunning: true,
            accessibilityAnnouncement: { liveAnnouncements.append($0) }
        )
        live.setInteractionEnabled(true)
        XCTAssertTrue(live.interactionEnabled)
        XCTAssertTrue(live.input.interactionEnabled)

        live.handleUnexpectedStreamStop(TestStreamError())

        XCTAssertFalse(live.streamRunning)
        XCTAssertFalse(live.interactionEnabled)
        XCTAssertFalse(live.input.interactionEnabled)
        XCTAssertTrue(live.note?.isWarning == true)
        XCTAssertTrue(live.note?.text.contains("Control disabled") == true)
        XCTAssertTrue(live.note?.text.contains("capture connection lost") == true)
        XCTAssertTrue(liveAnnouncements.last?.contains("Control disabled") == true)

        var failureAnnouncements: [String] = []
        let failed = ViewerModel(
            automaticRefresh: false,
            initialDisplays: [display],
            initialSelectedID: display.id,
            initialPermissions: PermissionState(
                screenRecording: true,
                accessibility: true
            ),
            initialStreamRunning: false,
            accessibilityAnnouncement: { failureAnnouncements.append($0) }
        )
        failed.handleStreamStartFailure(TestStreamError())
        XCTAssertFalse(failed.interactionEnabled)
        XCTAssertTrue(failed.note?.isWarning == true)
        XCTAssertTrue(failed.note?.text.contains("failed to start") == true)
        XCTAssertTrue(failureAnnouncements.last?.contains("Control unavailable") == true)
    }

    func testModelRefusesControlOnPhysicalOrEmptySpaceODisplays() {
        let physical = DisplayEntry(
            id: 1,
            bounds: CGRect(x: 0, y: 0, width: 1_920, height: 1_080),
            isSpaceO: false,
            isActive: true,
            name: "Main Display"
        )
        let stage = DisplayEntry(
            id: 7,
            bounds: CGRect(x: 1_920, y: 0, width: 1_920, height: 1_080),
            isSpaceO: true,
            isActive: true,
            name: "Stage"
        )
        let model = ViewerModel(
            automaticRefresh: false,
            initialDisplays: [physical, stage],
            initialSelectedID: physical.id,
            initialPermissions: PermissionState(screenRecording: true, accessibility: true),
            initialStreamRunning: true,
            accessibilityAnnouncement: { _ in }
        )

        model.setInteractionEnabled(true)
        XCTAssertFalse(model.interactionEnabled)
        XCTAssertTrue(model.note?.text.contains("view-only") == true)

        model.selectDisplay(stage.id)
        model.setInteractionEnabled(true)
        XCTAssertFalse(model.interactionEnabled)
        XCTAssertTrue(model.note?.text.contains("active agent session") == true)
    }

    func testDisablingControlReleasesEveryDeliveredRemoteKey() {
        let target = SpaceOKit.WindowRef(
            windowID: 41,
            pid: getpid() + 1,
            title: "Target",
            frame: CGRect(x: 0, y: 0, width: 800, height: 600)
        )
        let display = inputTestDisplay(id: 7)
        let delivered = expectation(description: "remote key-downs delivered")
        delivered.expectedFulfillmentCount = 2
        let released = expectation(description: "held remote keys released")
        released.expectedFulfillmentCount = 2
        let recorder = PostedKeyRecorder(onDown: { delivered.fulfill() },
                                         onUp: { released.fulfill() })
        let controller = ViewerInputController(
            keyPoster: recorder.record,
            frontWindowProvider: { _ in target }
        )
        controller.display = display
        controller.interactionEnabled = true

        controller.key(down: true, keyCode: 0, modifiers: [], characters: "a")
        controller.key(down: true, keyCode: 11, modifiers: [], characters: "b")
        wait(for: [delivered], timeout: 1)
        controller.interactionEnabled = false
        // The drain is scheduled onto the delivery queue rather than awaited, so the releases
        // land shortly after the setter returns instead of inside it.
        wait(for: [released], timeout: 1)

        XCTAssertEqual(recorder.events.count, 4)
        for keyCode: UInt16 in [0, 11] {
            let events = recorder.events.filter { $0.keyCode == keyCode }
            XCTAssertEqual(events.map(\.down), [true, false],
                           "each delivered down needs one matching up")
            XCTAssertTrue(events.allSatisfy { $0.pid == target.pid })
        }
    }

    func testDisplayTransitionReleasesDeliveredRemoteKeyBeforeClearingTarget() {
        let target = SpaceOKit.WindowRef(
            windowID: 42,
            pid: getpid() + 2,
            title: "Target",
            frame: CGRect(x: 0, y: 0, width: 800, height: 600)
        )
        let delivered = expectation(description: "remote key-down delivered")
        let released = expectation(description: "held remote key released")
        let recorder = PostedKeyRecorder(onDown: { delivered.fulfill() },
                                         onUp: { released.fulfill() })
        let controller = ViewerInputController(
            keyPoster: recorder.record,
            frontWindowProvider: { _ in target }
        )
        controller.display = inputTestDisplay(id: 7)
        controller.interactionEnabled = true
        controller.key(down: true, keyCode: 0,
                       modifiers: NSEvent.ModifierFlags.command, characters: "a")
        wait(for: [delivered], timeout: 1)

        controller.display = inputTestDisplay(id: 8)
        wait(for: [released], timeout: 1)

        XCTAssertEqual(recorder.events.map(\.down), [true, false])
        XCTAssertEqual(recorder.events.map(\.pid), [target.pid, target.pid])
        XCTAssertFalse(controller.interactionEnabled)
    }

    func testTransitionRestoresRouteInstalledByInFlightDownAfterTheScheduledDrain() {
        let log = TransitionLog()
        var scheduled: (() -> Void)?

        ViewerInputTransition.drainAndRestore(
            restore: {
                log.events.append("restore")
                if let current = log.route {
                    log.restored.append(current)
                    log.route = nil
                }
            },
            scheduling: { work in
                log.events.append("schedule")
                // Stands in for the delivery queue: the caller hands the cleanup over and
                // returns, rather than waiting for the queue to reach it.
                scheduled = work
            },
            drain: {
                log.events.append("drain")
                // Models a down that passed admission before the transition and publishes its
                // captured route while the transition's cleanup is still queued.
                log.route = 41
            })

        XCTAssertEqual(log.events, ["restore", "schedule"],
                       "a transition must not run the drain on the caller's thread")
        XCTAssertTrue(log.restored.isEmpty)

        scheduled?()

        XCTAssertEqual(log.events, ["restore", "schedule", "drain", "restore"],
                       "the second restore belongs after the drain, on the delivery queue")
        XCTAssertEqual(log.restored, [41])
        XCTAssertNil(log.route)
    }

    /// PAR-47: both setters run on the main actor, and the drain can sit behind seconds of
    /// Accessibility work. Awaiting it beachballed the UI at exactly the moment — the emergency
    /// exit chord, a display change mid-drag — when it has to stay responsive.
    func testDisablingControlSchedulesTheDrainInsteadOfBlockingTheCaller() {
        let target = SpaceOKit.WindowRef(
            windowID: 43,
            pid: getpid() + 3,
            title: "Target",
            frame: CGRect(x: 0, y: 0, width: 800, height: 600)
        )
        let delivered = expectation(description: "remote key-down delivered")
        let releaseStarted = expectation(description: "held-key release started on input queue")
        let releaseFinished = expectation(description: "held-key release finished")
        // Stands in for the multi-second Accessibility work a real drain sits behind. Bounded so
        // a regression to `queue.sync` fails the assertion below instead of hanging the suite.
        let unblockDrain = DispatchSemaphore(value: 0)
        let releasedKeys = ReleasedKeyLog()

        let controller = ViewerInputController(
            keyPoster: { code, _, down, _, _ in
                guard !down else { return delivered.fulfill() }
                releaseStarted.fulfill()
                _ = unblockDrain.wait(timeout: .now() + 5)
                releasedKeys.append(UInt16(code))
                releaseFinished.fulfill()
            },
            frontWindowProvider: { _ in target }
        )
        controller.display = inputTestDisplay(id: 9)
        controller.interactionEnabled = true
        controller.key(down: true, keyCode: 0, modifiers: [], characters: "a")
        wait(for: [delivered], timeout: 1)

        controller.interactionEnabled = false

        XCTAssertTrue(releasedKeys.keys.isEmpty,
                      "the setter returned only after the blocked drain — it awaited the queue")
        XCTAssertFalse(controller.interactionEnabled)

        // The drain still runs, and still releases the held key — just off the caller's thread.
        wait(for: [releaseStarted], timeout: 1)
        unblockDrain.signal()
        wait(for: [releaseFinished], timeout: 1)
        XCTAssertEqual(releasedKeys.keys, [0])
    }

    func testEntryAndExitAnnouncementsIncludeStateAndEscapeRoute() {
        let entered = ViewerAccessibility.controlAnnouncement(
            enabled: true,
            displayName: "Stage — Studio"
        )
        XCTAssertTrue(entered.contains("Control enabled"))
        XCTAssertTrue(entered.contains("Stage — Studio"))
        XCTAssertTrue(entered.contains(ViewerControlPolicy.localExitDescription))

        let exited = ViewerAccessibility.controlAnnouncement(
            enabled: false,
            displayName: "Stage — Studio"
        )
        XCTAssertTrue(exited.contains("Control disabled"))
        XCTAssertTrue(exited.contains("stay on this Mac"))
    }

    private func keyEvent(type: NSEvent.EventType,
                          keyCode: UInt16,
                          modifiers: NSEvent.ModifierFlags) throws -> NSEvent {
        try XCTUnwrap(NSEvent.keyEvent(
            with: type,
            location: .zero,
            modifierFlags: modifiers,
            timestamp: 0,
            windowNumber: 0,
            context: nil,
            characters: "\u{1b}",
            charactersIgnoringModifiers: "\u{1b}",
            isARepeat: false,
            keyCode: keyCode
        ))
    }

    private func inputTestDisplay(id: CGDirectDisplayID) -> DisplayEntry {
        DisplayEntry(
            id: id,
            bounds: CGRect(x: 0, y: 0, width: 1_920, height: 1_080),
            isSpaceO: true,
            isActive: true,
            name: "Stage \(id)"
        )
    }

    private func sessionInfo(id: String,
                             displayID: CGDirectDisplayID,
                             frame: CGRect) throws -> SessionInfo {
        let json = """
        {
          "id": "\(id)", "displayID": \(displayID),
          "x": \(frame.minX), "y": \(frame.minY),
          "width": \(frame.width), "height": \(frame.height),
          "tileIndex": 0, "tileCapacity": 1,
          "exclusiveDisplay": true,
          "spaces": [], "hasOwnSpace": true,
          "apps": [], "windows": [],
          "createdAt": "2026-07-30T00:00:00Z",
          "teardownPending": false, "runtimeAttached": true
        }
        """
        return try Wire.decoder.decode(SessionInfo.self, from: Data(json.utf8))
    }
}

private struct TestStreamError: LocalizedError {
    var errorDescription: String? { "capture connection lost" }
}

private struct PostedKey {
    let keyCode: UInt16
    let down: Bool
    let pid: pid_t
}

private final class PostedKeyRecorder {
    private let lock = NSLock()
    private var stored: [PostedKey] = []
    private let onDown: () -> Void
    private let onUp: () -> Void

    init(onDown: @escaping () -> Void, onUp: @escaping () -> Void = {}) {
        self.onDown = onDown
        self.onUp = onUp
    }

    var events: [PostedKey] {
        lock.withLock { stored }
    }

    func record(_ code: CGKeyCode, _ flags: CGEventFlags, _ down: Bool,
                _ characters: String?, _ pid: pid_t) throws {
        lock.withLock {
            stored.append(PostedKey(keyCode: UInt16(code), down: down, pid: pid))
        }
        if down { onDown() } else { onUp() }
    }
}

/// Reference-typed scratch state for closures a transition hands off, which are `@Sendable` and
/// so cannot capture mutable locals. Both are only ever touched from one thread at a time.
private final class TransitionLog: @unchecked Sendable {
    var events: [String] = []
    var restored: [Int] = []
    var route: Int?
}

private final class ReleasedKeyLog: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: [UInt16] = []

    var keys: [UInt16] { lock.withLock { stored } }

    func append(_ key: UInt16) {
        lock.withLock { stored.append(key) }
    }
}

/// What VoiceOver reads for a session row or tile: its title, whether it is waiting for the
/// person or paused, recent activity, and the announcements for changes nobody asked for.
final class ViewerSessionLabelAccessibilityTests: XCTestCase {

    private func session(title: String? = nil) throws -> SessionInfo {
        let json = """
        {
          "id":"s-1","displayID":7,"x":0,"y":0,"width":100,"height":100,
          "tileIndex":0,"tileCapacity":1,"exclusiveDisplay":true,
          "spaces":[],"hasOwnSpace":false,"apps":[],"windows":[],
          "createdAt":"2026-07-30T00:00:00Z","teardownPending":false,"runtimeAttached":true
        }
        """
        var value = try Wire.decoder.decode(SessionInfo.self, from: Data(json.utf8))
        value.title = title
        return value
    }

    func testRowLabelLeadsWithTheTitleAndTheHelpRequest() throws {
        var waiting = try session(title: "Checkout")
        waiting.inputPaused = true
        waiting.agentPauseReason = "needs 2FA code"
        let label = ViewerAccessibility.sessionLabel(waiting, recentActions: 3)
        XCTAssertTrue(label.hasPrefix("Checkout, session s-1."), label)
        XCTAssertTrue(label.contains("Agent needs you: needs 2FA code."), label)
        XCTAssertTrue(label.contains("3 agent actions in the last minute."), label)

        var paused = try session()
        paused.inputPaused = true
        let pausedLabel = ViewerAccessibility.sessionLabel(paused, breached: true)
        XCTAssertTrue(pausedLabel.hasPrefix("Session s-1."), pausedLabel)
        XCTAssertTrue(pausedLabel.contains("Agent input paused."), pausedLabel)
        XCTAssertTrue(pausedLabel.contains("Isolation breach reported."), pausedLabel)
        XCTAssertFalse(pausedLabel.contains("agent action"), pausedLabel)
    }

    func testRecentActivityCountsOnlyTheLastMinute() {
        let now = Date(timeIntervalSinceReferenceDate: 1_000)
        let stamps = [now.addingTimeInterval(-90), now.addingTimeInterval(-30), now.addingTimeInterval(-1)]
        XCTAssertEqual(ViewerAccessibility.recentActionCount(stamps, now: now), 2)
    }

    func testSelectionEndedAnnouncementNamesWhatReplacedIt() {
        XCTAssertEqual(ViewerAccessibility.selectionEndedAnnouncement(
            endedTitle: "Checkout", replacementTitle: "Research"),
            "Checkout ended. Now showing Research.")
        XCTAssertEqual(ViewerAccessibility.selectionEndedAnnouncement(
            endedTitle: "Checkout", replacementTitle: nil),
            "Checkout ended. No session selected.")
    }

    func testKeyDestinationPrefersTheSessionsAppNameAndBoundsTheTitle() throws {
        var owned = try session()
        owned.apps = [try Wire.decoder.decode(AppInfo.self, from: Data(
            #"{"pid":100,"name":"Safari","startedByUs":true}"#.utf8))]
        let window = WindowRef(windowID: 1, pid: 100, title: String(repeating: "x", count: 400),
                               frame: .zero)
        let destination = ViewerKeyDestination.resolve(window: window, sessions: [owned]) { _ in "Other" }
        XCTAssertEqual(destination.appName, "Safari")
        XCTAssertTrue(destination.isSessionApp)
        XCTAssertEqual(destination.title.count, ViewerKeyDestination.maximumTitleLength)
        XCTAssertTrue(destination.title.hasSuffix("…"))

        let untitled = ViewerKeyDestination.resolve(
            window: WindowRef(windowID: 2, pid: 7, title: "", frame: .zero),
            sessions: [owned]) { _ in nil }
        XCTAssertEqual(untitled.title, "pid 7")
        XCTAssertFalse(untitled.isSessionApp)
    }
}
