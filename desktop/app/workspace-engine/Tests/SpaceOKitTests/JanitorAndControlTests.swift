import XCTest
import CoreGraphics
import AppKit
import Darwin
@testable import SpaceOKit

/// Regressions for SPAO-127 (runtime janitor) and SPAO-134 (viewer control transitions).
///
/// Both tickets are about work that survives a state change it should not have survived: a
/// notification dropped during a sweep, an event delivered after Control was switched off. The
/// tests are deterministic — no timers, no WindowServer — because the failures they cover are
/// races, and a race reproduced by sleeping is a race not really covered.
final class JanitorAndControlTests: XCTestCase {

    // MARK: - SPAO-127: notification arriving during a sweep

    func testTheFirstCallerBecomesTheSweeper() {
        let coalescer = SweepCoalescer()
        XCTAssertTrue(coalescer.beginOrCoalesce())
        XCTAssertTrue(coalescer.isSweeping)
        XCTAssertFalse(coalescer.endOrRepeat())
        XCTAssertFalse(coalescer.isSweeping)
    }

    /// The exact dropped-notification bug: a request that lands while a sweep is running used to
    /// be discarded, so a window created a moment after the sweep started was in no sweep at all.
    func testANotificationDuringASweepIsHonouredNotDropped() {
        let coalescer = SweepCoalescer()
        XCTAssertTrue(coalescer.beginOrCoalesce())

        XCTAssertFalse(coalescer.beginOrCoalesce(),
                       "a second caller must not sweep concurrently")
        XCTAssertTrue(coalescer.endOrRepeat(),
                      "but its request must survive as a repeat")
        XCTAssertFalse(coalescer.endOrRepeat(),
                       "and the repeat clears it — one more sweep, not one per notification")
    }

    /// Coalescing, not queueing: a sweep is a full reconciliation, so N notifications during one
    /// sweep need exactly one more sweep.
    func testManyNotificationsDuringOneSweepCoalesceIntoOneRepeat() {
        let coalescer = SweepCoalescer()
        XCTAssertTrue(coalescer.beginOrCoalesce())
        for _ in 0..<50 { XCTAssertFalse(coalescer.beginOrCoalesce()) }
        XCTAssertTrue(coalescer.endOrRepeat())
        XCTAssertFalse(coalescer.endOrRepeat())
    }

    func testOwnershipIsHeldAcrossARepeatSoNoOneElseCanStartASweep() {
        let coalescer = SweepCoalescer()
        XCTAssertTrue(coalescer.beginOrCoalesce())
        XCTAssertFalse(coalescer.beginOrCoalesce())
        XCTAssertTrue(coalescer.endOrRepeat())
        // Mid-repeat: still owned, so a newcomer coalesces rather than sweeping in parallel.
        XCTAssertTrue(coalescer.isSweeping)
        XCTAssertFalse(coalescer.beginOrCoalesce())
    }

    func testCancelReleasesOwnershipWithoutPromisingAnotherSweep() {
        let coalescer = SweepCoalescer()
        XCTAssertTrue(coalescer.beginOrCoalesce())
        XCTAssertFalse(coalescer.beginOrCoalesce())
        coalescer.cancel()
        XCTAssertFalse(coalescer.isSweeping)
        XCTAssertFalse(coalescer.endOrRepeat(),
                       "shutdown must not leave a caller looping for a sweep that never comes")
    }

    func testConcurrentNotificationsNeverLoseTheLastRequest() {
        let coalescer = SweepCoalescer()
        let sweeps = NSCountedSet()
        let lock = NSLock()

        // One sweeper plus a storm of notifications; every notification must either be inside a
        // sweep that has not finished or cause another one.
        DispatchQueue.concurrentPerform(iterations: 200) { _ in
            guard coalescer.beginOrCoalesce() else { return }
            repeat {
                lock.withLock { sweeps.add("sweep") }
            } while coalescer.endOrRepeat()
        }
        XCTAssertFalse(coalescer.isSweeping)
        XCTAssertGreaterThan(sweeps.count(for: "sweep"), 0)
    }

    // MARK: - SPAO-127: containment must use full bounds

    func testAWindowInsideItsTileIsContained() {
        let tile = CGRect(x: 0, y: 0, width: 960, height: 540)
        XCTAssertTrue(WindowPlacement.isFullyInside(
            CGRect(x: 10, y: 10, width: 400, height: 300), tile))
        XCTAssertTrue(WindowPlacement.isFullyInside(tile, tile),
                      "a window exactly filling its tile is contained")
    }

    /// The oversized-window case: midpoint containment called this handled while the window
    /// spilled across a neighbouring session's tile.
    func testAnOversizedWindowIsNotContainedEvenWithItsCentreInPlace() {
        let tile = CGRect(x: 0, y: 0, width: 960, height: 540)
        let oversized = CGRect(x: -200, y: -100, width: 1400, height: 800)

        XCTAssertTrue(tile.contains(CGPoint(x: oversized.midX, y: oversized.midY)),
                      "its centre is in the tile — which is exactly why midpoint testing failed")
        XCTAssertFalse(WindowPlacement.isFullyInside(oversized, tile),
                       "but it crosses into the neighbour, so it is not contained")
    }

    /// The moved-after-placement case: a window we already placed drifts out later.
    func testAWindowThatDriftsOutAfterPlacementIsNoLongerContained() {
        let tile = CGRect(x: 0, y: 0, width: 960, height: 540)
        let placed = CGRect(x: 100, y: 100, width: 400, height: 300)
        XCTAssertTrue(WindowPlacement.isFullyInside(placed, tile))

        let drifted = placed.offsetBy(dx: 700, dy: 0)
        XCTAssertFalse(WindowPlacement.isFullyInside(drifted, tile),
                       "handled means we acted, not that it is still where we put it")
    }

    func testAWindowJustOverTheEdgeIsNotContained() {
        let tile = CGRect(x: 100, y: 100, width: 800, height: 600)
        XCTAssertTrue(WindowPlacement.isFullyInside(
            CGRect(x: 100, y: 100, width: 800, height: 600), tile))
        for escape in [CGRect(x: 99, y: 100, width: 800, height: 600),
                       CGRect(x: 100, y: 99, width: 800, height: 600),
                       CGRect(x: 100, y: 100, width: 801, height: 600),
                       CGRect(x: 100, y: 100, width: 800, height: 601)] {
            XCTAssertFalse(WindowPlacement.isFullyInside(escape, tile),
                           "\(escape) escapes \(tile) by a pixel and must be caught")
        }
    }

    func testDegenerateGeometryIsNeverReportedAsContained() {
        let tile = CGRect(x: 0, y: 0, width: 960, height: 540)
        XCTAssertFalse(WindowPlacement.isFullyInside(.infinite, tile))
        XCTAssertFalse(WindowPlacement.isFullyInside(.null, tile))
        XCTAssertFalse(WindowPlacement.isFullyInside(
            CGRect(x: CGFloat.nan, y: 0, width: 10, height: 10), tile))
        XCTAssertFalse(WindowPlacement.isFullyInside(
            CGRect(x: 0, y: 0, width: 10, height: 10), .zero),
            "a degenerate tile contains nothing")
    }

    // MARK: - PAR-25: `move` must wait for the size, not only the origin

    /// The race itself. `AX.setSize` had not published yet, so the window still reports its old
    /// extent at its new origin. `move` used to accept that and return, and the janitor's strict
    /// test — run on the very next line — called the window refused.
    func testAStaleOversizeReadIsNotTreatedAsLanded() {
        let tile = CGRect(x: 0, y: 0, width: 960, height: 540)
        let requested = WindowPlacement.defaultFrame(in: tile)
        let staleSize = CGRect(origin: requested.origin, size: CGSize(width: 1400, height: 900))

        XCTAssertFalse(WindowPlacement.isFullyInside(staleSize, tile),
                       "this is what the janitor sees, and it is not containment")
        XCTAssertFalse(WindowPlacement.hasLanded(staleSize, at: requested),
                       "so move must keep polling rather than hand it back as placed")
    }

    /// The regression the one-sided size test exists to avoid: an app that snaps its size down to
    /// a grid has placed the window successfully and must not cost the full deadline.
    func testASizeTheAppSnappedDownIsLanded() {
        let requested = CGRect(x: 100, y: 100, width: 800, height: 600)
        XCTAssertTrue(WindowPlacement.hasLanded(requested, at: requested))
        XCTAssertTrue(WindowPlacement.hasLanded(
            CGRect(x: 100, y: 100, width: 786, height: 583), at: requested),
            "smaller than asked for, at the right origin — still inside every region it was fitted to")
    }

    func testAnUnpublishedOriginIsStillNotLanded() {
        let requested = CGRect(x: 100, y: 100, width: 800, height: 600)
        for stale in [CGRect(x: 700, y: 100, width: 800, height: 600),
                      CGRect(x: 100, y: 700, width: 800, height: 600)] {
            XCTAssertFalse(WindowPlacement.hasLanded(stale, at: requested),
                           "\(stale) has not reached \(requested.origin)")
        }
        XCTAssertTrue(WindowPlacement.hasLanded(
            CGRect(x: 102, y: 98, width: 800, height: 600), at: requested),
            "rounding within the tolerance is not a refusal")
    }

    /// The invariant that ties the fix to the bug: anything `move` returns on must satisfy the
    /// stricter predicate the janitor immediately evaluates, so the two can no longer disagree.
    func testEveryFrameMoveAcceptsSatisfiesTheJanitorsStrictTest() {
        let tile = CGRect(x: 0, y: 0, width: 960, height: 540)
        let requested = WindowPlacement.defaultFrame(in: tile)
        XCTAssertGreaterThan(requested.minX - tile.minX, WindowPlacement.placementTolerance,
                             "the tile inset must exceed the origin slack, or the two can disagree")

        for published in [requested,
                          CGRect(origin: requested.origin,
                                 size: CGSize(width: requested.width - 14,
                                              height: requested.height - 9)),
                          CGRect(x: requested.minX + WindowPlacement.placementTolerance,
                                 y: requested.minY - WindowPlacement.placementTolerance,
                                 width: requested.width, height: requested.height)] {
            XCTAssertTrue(WindowPlacement.hasLanded(published, at: requested))
            XCTAssertTrue(WindowPlacement.isFullyInside(published, tile),
                          "\(published) satisfied move but not the janitor — that is the flake")
        }
    }

    // MARK: - PAR-28: the audit, repark, `onStage` and `placeAll` must agree with the janitor

    /// The ticket's scenario, as pure geometry: session A's tile on a 2560×1600 stage, holding a
    /// fixed-size dialog whose centre is in the tile while 360pt of it sits in session B's.
    /// Every containment call site must call this escaped, because `Capture.region` for session B
    /// picks up those pixels — a context leak between agents, not a cosmetic offset.
    func testTheOversizedDialogTheAuditUsedToMiss() {
        let tileA = CGRect(x: 0, y: 0, width: 1280, height: 1600)
        let tileB = CGRect(x: 1280, y: 0, width: 1280, height: 1600)
        let dialog = CGRect(x: -360, y: 350, width: 2000, height: 900)

        XCTAssertTrue(tileA.contains(CGPoint(x: dialog.midX, y: dialog.midY)),
                      "the midpoint test the audit used to run says this is fine")
        XCTAssertFalse(WindowPlacement.isFullyInside(dialog, tileA),
                       "so the audit, repark and onStage must not use it")
        XCTAssertTrue(dialog.intersects(tileB),
                      "because those pixels are what session B's capture would crop")
    }

    /// `nil` from the WindowServer means the window closed. Escaped and contained are different
    /// questions about it, and both answer "no" — the janitor must not chase a dead window id,
    /// and `onStage` must not claim a window that no longer exists is on the stage.
    func testAClosedWindowIsNeitherEscapedNorOnStage() {
        // windowID 0 is the offscreen placeholder: the WindowServer never publishes bounds for it,
        // which is the same nil the predicates see when a real window closes mid-sweep.
        let closed = WindowRef(windowID: 0, pid: 1, title: "gone", frame: .zero)
        let tile = CGRect(x: 0, y: 0, width: 960, height: 540)

        XCTAssertNil(WindowPlacement.isFullyInRegion(closed.windowID, tile),
                     "the WindowServer has no bounds for it, and that is not a containment answer")
        XCTAssertFalse(WindowPlacement.hasEscaped(closed, from: tile),
                       "a closed window is not drift, and reporting it would make audits flaky")
        XCTAssertFalse(WindowPlacement.isContained(closed, in: tile),
                       "nor is it on stage")
    }

    /// The clamp `placeAll` cascades against. A midpoint clamp let the third window hang past the
    /// tile edge — a frame SpaceO picked itself, which the strict acceptance check then rejects as
    /// the app refusing to move, failing the launch.
    func testTheCascadeNeverHandsPlaceAllAFrameItWouldReject() {
        for tile in [CGRect(x: 0, y: 0, width: 1280, height: 1600),
                     CGRect(x: 1280, y: 0, width: 1280, height: 1600),
                     CGRect(x: 0, y: 0, width: 400, height: 300)] {
            for index in 0..<8 {
                let frame = WindowPlacement.cascadeFrame(in: tile, index: index)
                XCTAssertTrue(WindowPlacement.isFullyInside(frame, tile),
                              "window \(index) cascaded to \(frame), outside \(tile)")
            }
        }
    }

    func testTheCascadeStillSeparatesWindowsWhileItFits() {
        let tile = CGRect(x: 0, y: 0, width: 1280, height: 1600)
        XCTAssertEqual(WindowPlacement.cascadeFrame(in: tile, index: 0),
                       WindowPlacement.defaultFrame(in: tile))
        XCTAssertNotEqual(WindowPlacement.cascadeFrame(in: tile, index: 1),
                          WindowPlacement.cascadeFrame(in: tile, index: 0),
                          "several windows of one app must stay reachable, not stack exactly")
        XCTAssertEqual(WindowPlacement.cascadeFrame(in: tile, index: 6),
                       WindowPlacement.defaultFrame(in: tile),
                       "past the clamp it falls back to the base frame rather than spilling")
    }

    /// Midpoint containment survives for exactly one question: which tile owns this window.
    func testTileOwnershipIsStillJudgedOnTheMidpoint() {
        let tileA = CGRect(x: 0, y: 0, width: 1280, height: 1600)
        let dialog = CGRect(x: -360, y: 350, width: 2000, height: 900)
        XCTAssertTrue(tileA.contains(CGPoint(x: dialog.midX, y: dialog.midY)),
                      "primaryWindow must still resolve this oversized dialog to session A, "
                          + "so the agent can act on the window it just opened")
    }

    func testThePeriodicSweepIntervalIsShortEnoughToMatter() {
        XCTAssertLessThanOrEqual(WindowWatcher.periodicSweepInterval, 5.0,
                                 "a stray dialog on the user's screen must be a blink, not a fixture")
        XCTAssertGreaterThan(WindowWatcher.periodicSweepInterval, 0)
    }

    // MARK: - SPAO-134: control epochs

    func testADisabledGateAdmitsNothing() {
        let gate = InputControlGate()
        XCTAssertNil(gate.admit(), "Control off means no event is admitted at all")
        XCTAssertFalse(gate.isEnabled)
    }

    func testAnAdmittedEventIsDeliverableWhileNothingChanges() throws {
        let gate = InputControlGate()
        gate.enable(displayID: 7)
        let ticket = try XCTUnwrap(gate.admit())
        XCTAssertTrue(gate.isCurrent(ticket))
        XCTAssertEqual(ticket.displayID, 7)
    }

    /// The core failure: an event validated at enqueue, delivered after Control was switched off.
    func testAQueuedEventIsDiscardedAfterControlIsDisabled() throws {
        let gate = InputControlGate()
        gate.enable(displayID: 7)
        let queued = try XCTUnwrap(gate.admit())

        gate.disable()
        XCTAssertFalse(gate.isCurrent(queued),
                       "a click must not execute after the user took control back")
        XCTAssertNil(gate.admit())
    }

    /// The other half: an event admitted for one display, delivered after the user selected
    /// another. The display id alone cannot catch a switch away and back.
    func testAQueuedEventIsDiscardedAfterTheDisplaySwitches() throws {
        let gate = InputControlGate()
        gate.enable(displayID: 7)
        let queued = try XCTUnwrap(gate.admit())

        gate.select(displayID: 9)
        XCTAssertFalse(gate.isCurrent(queued),
                       "an event bound for display 7 must not land on display 9")
    }

    func testSwitchingAwayAndBackDoesNotResurrectQueuedEvents() throws {
        let gate = InputControlGate()
        gate.enable(displayID: 7)
        let queued = try XCTUnwrap(gate.admit())

        gate.select(displayID: 9)
        gate.enable(displayID: 7)
        XCTAssertFalse(gate.isCurrent(queued),
                       "the display matches again, but the epoch says this event is from before "
                       + "a transition, which is what makes epochs necessary")
    }

    func testReEnablingTheSameDisplayStillInvalidatesOlderEvents() throws {
        let gate = InputControlGate()
        gate.enable(displayID: 7)
        let queued = try XCTUnwrap(gate.admit())
        gate.disable()
        gate.enable(displayID: 7)
        XCTAssertFalse(gate.isCurrent(queued))
        XCTAssertTrue(gate.isCurrent(try XCTUnwrap(gate.admit())))
    }

    func testSelectingNoDisplayTurnsControlOff() {
        let gate = InputControlGate()
        gate.enable(displayID: 7)
        gate.select(displayID: nil)
        XCTAssertFalse(gate.isEnabled, "there is nothing to drive, so nothing may be driven")
        XCTAssertNil(gate.admit())
    }

    func testEpochAdvancesOnEveryTransitionSoNoEventCanStraddleOne() {
        let gate = InputControlGate()
        var seen: Set<UInt64> = [gate.currentEpoch]
        for step in 0..<10 {
            if step.isMultiple(of: 2) { gate.enable(displayID: 1) } else { gate.disable() }
            XCTAssertFalse(seen.contains(gate.currentEpoch),
                           "every transition must produce a fresh epoch")
            seen.insert(gate.currentEpoch)
        }
    }

    /// A whole burst of events admitted before a disable must all be discarded, not just the
    /// last one — the backlog is exactly what used to execute after Control went off.
    func testAnEntireQueuedBurstIsInvalidatedByOneDisable() {
        let gate = InputControlGate()
        gate.enable(displayID: 3)
        let burst = (0..<64).compactMap { _ in gate.admit() }
        XCTAssertEqual(burst.count, 64)
        XCTAssertTrue(burst.allSatisfy { gate.isCurrent($0) })

        gate.disable()
        XCTAssertTrue(burst.allSatisfy { !gate.isCurrent($0) })
    }

    func testDisableIsSafeUnderConcurrentAdmission() {
        let gate = InputControlGate()
        gate.enable(displayID: 5)
        let survivors = NSCountedSet()
        let lock = NSLock()

        DispatchQueue.concurrentPerform(iterations: 128) { index in
            if index == 64 {
                gate.disable()
                return
            }
            guard let ticket = gate.admit() else { return }
            // Delivery-time recheck, exactly as the input queue does it.
            if gate.isCurrent(ticket) {
                lock.withLock { survivors.add("delivered") }
            }
        }
        // No assertion on the count — the point is that the gate stays coherent under the race
        // and ends up disabled, refusing everything afterwards.
        XCTAssertFalse(gate.isEnabled)
        XCTAssertNil(gate.admit())
    }

    // MARK: - SPAO-134: the viewer must not target itself

    func testSelfExclusionCoversThisProcess() {
        XCTAssertTrue(MirrorInput.selfExcludedPIDs.contains(getpid()))
    }

    /// Viewing a physical display that contains the viewer's own window used to let a click
    /// select that window and be posted back into this process, feeding itself forever.
    func testHitTestingSkipsOurOwnWindowsAndPicksWhatIsBehind() {
        let ourWindow = MirrorInput.WindowCandidate(
            windowID: 1, pid: getpid(), layer: 0,
            bounds: CGRect(x: 0, y: 0, width: 800, height: 600),
            title: "SpaceO Viewer", appName: "SpaceOViewer")
        let realTarget = MirrorInput.WindowCandidate(
            windowID: 2, pid: getpid() + 1, layer: 0,
            bounds: CGRect(x: 0, y: 0, width: 800, height: 600),
            title: "TextEdit", appName: "TextEdit")

        let unfiltered = MirrorInput.selectTarget(from: [ourWindow, realTarget],
                                                  containing: CGPoint(x: 100, y: 100))
        XCTAssertEqual(unfiltered?.windowID, 1, "frontmost-first would pick us")

        let filtered = MirrorInput.selectTarget(from: [ourWindow, realTarget],
                                                containing: CGPoint(x: 100, y: 100),
                                                excluding: MirrorInput.selfExcludedPIDs)
        XCTAssertEqual(filtered?.windowID, 2, "self-exclusion must fall through to the app behind")
    }

    func testTheKeyboardFallbackAlsoSkipsOurOwnWindows() {
        let display = CGRect(x: 0, y: 0, width: 1920, height: 1080)
        let ourWindow = MirrorInput.WindowCandidate(
            windowID: 1, pid: getpid(), layer: 0,
            bounds: CGRect(x: 100, y: 100, width: 800, height: 600),
            title: "SpaceO Viewer", appName: "SpaceOViewer")
        let candidates = [ourWindow]

        XCTAssertNil(MirrorInput.selectTarget(from: candidates,
                                              containing: CGPoint(x: 200, y: 200),
                                              excluding: MirrorInput.selfExcludedPIDs),
                     "with only our own window present there is nothing legitimate to drive")
        XCTAssertTrue(display.contains(CGPoint(x: ourWindow.bounds.midX,
                                               y: ourWindow.bounds.midY)),
                      "and it is genuinely on the viewed display — exclusion is what saves us")
    }

    /// Defense in depth: even if a future caller forgets to filter, delivery itself refuses.
    func testDeliveryPrimitivesRefuseToPostToThisProcess() {
        let ourselves = WindowRef(windowID: 1, pid: getpid(), title: "self",
                                  frame: CGRect(x: 0, y: 0, width: 100, height: 100))
        XCTAssertThrowsError(try MirrorInput.postPointer(.down, button: .left,
                                                          at: CGPoint(x: 10, y: 10),
                                                          to: ourselves)) { error in
            XCTAssertTrue(error.localizedDescription.contains("SpaceO itself"),
                          error.localizedDescription)
        }
        XCTAssertThrowsError(try MirrorInput.postScroll(dx: 0, dy: 10,
                                                        at: CGPoint(x: 10, y: 10),
                                                        to: ourselves))
        XCTAssertThrowsError(try MirrorInput.postKey(code: 0, flags: [], down: true,
                                                     characters: "a", to: getpid()))
    }
}
