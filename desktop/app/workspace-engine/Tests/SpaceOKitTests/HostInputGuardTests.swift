import Darwin
import Foundation
import XCTest
@testable import SpaceOKit
@testable import SpaceOViewer

/// SPAO-154. Entering Control decouples the mouse, hides the cursor, and switches off the
/// WindowServer's global hotkeys — state that belongs to the whole Mac and that macOS reclaims
/// from nobody. A Viewer that dies while holding it used to leave a machine recoverable only by
/// logging out, so each recovery path here is load-bearing rather than defensive decoration.
///
/// These run against the `breadcrumb:` and `restore:` seams so nothing below ever flips the real
/// cursor, mouse association, or hotkey state of the machine running the suite.
@MainActor
final class HostInputGuardTests: XCTestCase {

    // MARK: - Breadcrumb lifecycle

    func testBreadcrumbIsAbsentUntilMarkedAndGoneOnceCleared() {
        withScratchBreadcrumb { breadcrumb in
            XCTAssertFalse(breadcrumb.isPresent)

            breadcrumb.mark()
            XCTAssertTrue(breadcrumb.isPresent,
                          "mark must create the whole tree; on a fresh Mac neither SpaceO nor "
                          + "Viewer exists under Application Support yet")

            breadcrumb.clear()
            XCTAssertFalse(breadcrumb.isPresent)
        }
    }

    func testMarkAndClearBothTolerateBeingRunTwice() {
        withScratchBreadcrumb { breadcrumb in
            breadcrumb.mark()
            breadcrumb.mark()
            XCTAssertTrue(breadcrumb.isPresent)

            breadcrumb.clear()
            breadcrumb.clear()
            XCTAssertFalse(breadcrumb.isPresent,
                           "every recovery path may run redundantly, so clearing an already "
                           + "cleared breadcrumb has to stay a no-op")
        }
    }

    // MARK: - Capture lifecycle

    func testBeginCaptureArmsBothRecoveryPathsBeforeTheHostIsTouched() {
        withScratchBreadcrumb { breadcrumb in
            HostInputGuard.beginCapture(breadcrumb: breadcrumb)

            // The next launch's only evidence.
            XCTAssertTrue(breadcrumb.isPresent,
                          "a crash between the takeover and the breadcrumb is unrecoverable, so "
                          + "the marker must already be on disk when beginCapture returns")

            // This run's evidence: the terminate path only restores when the capture flag is set,
            // so beginCapture leaving it unset would silently disarm quit, logout, and SIGTERM.
            var restores = 0
            HostInputGuard.restoreIfCaptureActive(breadcrumb: breadcrumb) { restores += 1 }
            XCTAssertEqual(restores, 1)
        }
    }

    func testEndCaptureLeavesNothingForTheNextLaunchToRepair() {
        withScratchBreadcrumb { breadcrumb in
            HostInputGuard.beginCapture(breadcrumb: breadcrumb)
            HostInputGuard.endCapture(breadcrumb: breadcrumb)

            XCTAssertFalse(breadcrumb.isPresent)

            var restores = 0
            XCTAssertFalse(
                HostInputGuard.repairAbandonedCapture(breadcrumb: breadcrumb) { restores += 1 },
                "a clean exit must not make the next launch claim it repaired anything")
            XCTAssertEqual(restores, 0)
        }
    }

    // MARK: - Abandoned-capture repair

    func testRepairRestoresTheHostAndClearsTheAbandonedBreadcrumb() {
        withScratchBreadcrumb { breadcrumb in
            breadcrumb.mark()

            var restores = 0
            XCTAssertTrue(
                HostInputGuard.repairAbandonedCapture(breadcrumb: breadcrumb) { restores += 1 },
                "the Viewer reports the repair to the user, so the return value is a contract")
            XCTAssertEqual(restores, 1)
            XCTAssertFalse(breadcrumb.isPresent)
        }
    }

    func testRepairRestoresBeforeClearingSoADeathMidRepairIsStillRepairable() {
        withScratchBreadcrumb { breadcrumb in
            breadcrumb.mark()

            var breadcrumbSurvivedIntoRestore = false
            HostInputGuard.repairAbandonedCapture(breadcrumb: breadcrumb) {
                breadcrumbSurvivedIntoRestore = breadcrumb.isPresent
            }

            XCTAssertTrue(breadcrumbSurvivedIntoRestore,
                          "clearing first would mean a launch that dies inside the restore hands "
                          + "the following launch a broken Mac and no marker to repair it from")
        }
    }

    func testRepairDoesNothingWhenNoPreviousRunLeftABreadcrumb() {
        withScratchBreadcrumb { breadcrumb in
            var restores = 0
            XCTAssertFalse(
                HostInputGuard.repairAbandonedCapture(breadcrumb: breadcrumb) { restores += 1 })
            XCTAssertEqual(restores, 0,
                           "every launch runs this, so an unconditional restore would fight the "
                           + "cursor and hotkey state of whatever else is running")
        }
    }

    func testRepairIsOneShotAcrossRelaunches() {
        withScratchBreadcrumb { breadcrumb in
            breadcrumb.mark()
            XCTAssertTrue(HostInputGuard.repairAbandonedCapture(breadcrumb: breadcrumb) {})

            var restores = 0
            XCTAssertFalse(
                HostInputGuard.repairAbandonedCapture(breadcrumb: breadcrumb) { restores += 1 },
                "the second launch after a crash has nothing left to repair")
            XCTAssertEqual(restores, 0)
        }
    }

    func testRepairTriggersOnPresenceAloneSoATornWriteIsNeverReadAsNoCapture() throws {
        try withScratchBreadcrumb { breadcrumb in
            // A kill partway through `mark` can leave a zero-byte file behind. The contents are
            // diagnostic only; the moment repair started parsing them, a truncated write would
            // read as "no capture was active" — the exact death the breadcrumb exists to survive.
            try FileManager.default.createDirectory(
                at: breadcrumb.url.deletingLastPathComponent(),
                withIntermediateDirectories: true)
            try Data().write(to: breadcrumb.url)

            var restores = 0
            XCTAssertTrue(
                HostInputGuard.repairAbandonedCapture(breadcrumb: breadcrumb) { restores += 1 })
            XCTAssertEqual(restores, 1)
        }
    }

    // MARK: - Terminate path

    func testRestoreIfCaptureActiveRestoresAndClearsWhenCaptureIsHeld() {
        withScratchBreadcrumb { breadcrumb in
            HostInputGuard.beginCapture(breadcrumb: breadcrumb)

            var restores = 0
            HostInputGuard.restoreIfCaptureActive(breadcrumb: breadcrumb) { restores += 1 }

            XCTAssertEqual(restores, 1)
            XCTAssertFalse(breadcrumb.isPresent,
                           "AppKit tears the process down without unwinding the view hierarchy, "
                           + "so this is the only teardown a Quit or a logout ever runs")
        }
    }

    func testRestoreIfCaptureActiveIsANoOpWhenNoCaptureIsHeld() {
        withScratchBreadcrumb { breadcrumb in
            var restores = 0
            HostInputGuard.restoreIfCaptureActive(breadcrumb: breadcrumb) { restores += 1 }
            XCTAssertEqual(restores, 0, "quitting without ever entering Control touches nothing")
        }
    }

    func testRestoreIfCaptureActiveStaysIdempotentAcrossOverlappingPaths() {
        withScratchBreadcrumb { breadcrumb in
            HostInputGuard.beginCapture(breadcrumb: breadcrumb)

            var restores = 0
            // applicationWillTerminate and the surface's own teardown can both land on a single
            // quit; the second must find the capture already released.
            HostInputGuard.restoreIfCaptureActive(breadcrumb: breadcrumb) { restores += 1 }
            HostInputGuard.restoreIfCaptureActive(breadcrumb: breadcrumb) { restores += 1 }

            XCTAssertEqual(restores, 1)
        }
    }

    // MARK: - Crash path

    func testBreadcrumbLeftByAProcessThatNeverRanTeardownIsRepairedByTheNextLaunch() {
        withScratchBreadcrumb { breadcrumb in
            // Run one enters Control and is SIGKILLed: no endCapture, no restoreIfCaptureActive,
            // no atexit hook, no signal handler. The file is the only thing that outlives it.
            HostInputGuard.beginCapture(breadcrumb: breadcrumb)

            // Run two inherits none of run one's memory, so it sees the marker through a fresh
            // value over the same path — exactly what applicationDidFinishLaunching gets.
            let nextLaunch = HostCaptureBreadcrumb(url: breadcrumb.url)
            XCTAssertTrue(nextLaunch.isPresent,
                          "the marker has to be durable on-disk state; anything the dying process "
                          + "still had to flush would be lost with it")

            var restores = 0
            XCTAssertTrue(
                HostInputGuard.repairAbandonedCapture(breadcrumb: nextLaunch) { restores += 1 })
            XCTAssertEqual(restores, 1)
            XCTAssertFalse(nextLaunch.isPresent)
        }
    }

    func testSignalHandlerUnlinkTargetsExactlyTheFileMarkWrote() {
        withScratchBreadcrumb { breadcrumb in
            breadcrumb.mark()

            // The handler cannot allocate, so it clears the breadcrumb with `unlink` over a C
            // string encoded from `url.path` at install time. If the breadcrumb ever became a
            // directory, or moved, that unlink would fail silently and a crashed Viewer would
            // leave a marker that repairs a machine nobody broke.
            let encoded = strdup(breadcrumb.url.path)
            defer { free(encoded) }
            XCTAssertEqual(unlink(encoded), 0, String(cString: strerror(errno)))
            XCTAssertFalse(breadcrumb.isPresent)
        }
    }

    func testDefaultBreadcrumbLivesWhereItOutlivesTheProcessThatWroteIt() {
        let path = HostCaptureBreadcrumb.shared.url.path

        XCTAssertTrue(path.hasSuffix("/SpaceO/Viewer/host-capture.active"), path)
        XCTAssertFalse(path.hasPrefix(NSTemporaryDirectory()),
                       "a temp-directory breadcrumb can be reaped before the next launch reads it")
    }

    func testTerminationHandlersArmEveryDeathThatStillRunsCode() {
        withScratchBreadcrumb { breadcrumb in
            HostInputGuard.installTerminationHandlers(breadcrumb: breadcrumb)

            // SIGKILL and SIGSTOP cannot be caught — those are the breadcrumb's job. Dropping any
            // of the rest silently downgrades a same-session recovery to a next-launch one, which
            // for a user who never relaunches is no recovery at all.
            let catchable: [Int32] = [
                SIGABRT, SIGBUS, SIGFPE, SIGILL, SIGSEGV, SIGSYS, SIGTRAP,
                SIGHUP, SIGINT, SIGQUIT, SIGTERM,
            ]
            for number in catchable {
                var current = sigaction()
                XCTAssertEqual(sigaction(number, nil, &current), 0, "sigaction(\(number))")

                let installed = current.__sigaction_u.__sa_handler
                    .map { unsafeBitCast($0, to: UInt.self) } ?? 0
                XCTAssertNotEqual(installed, 0, "signal \(number) is still SIG_DFL")
                XCTAssertNotEqual(installed, 1, "signal \(number) is SIG_IGN")
            }
        }
    }

    // MARK: - Harness

    /// Runs `body` against a breadcrumb in its own scratch tree, then releases the capture and
    /// deletes the tree. The release matters: `beginCapture` arms process-global state that the
    /// installed `atexit` hook reads, so a test that left it set would make the test runner's own
    /// exit flip this machine's real cursor and hotkey state.
    private func withScratchBreadcrumb(
        _ body: (HostCaptureBreadcrumb) throws -> Void
    ) rethrows {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("spaceo-hostguard-\(UUID().uuidString)", isDirectory: true)
        // Nested exactly as production is, so `mark` has to create intermediate directories here
        // too rather than landing in a directory the harness already made.
        let breadcrumb = HostCaptureBreadcrumb(
            url: root
                .appendingPathComponent("Viewer", isDirectory: true)
                .appendingPathComponent("host-capture.active", isDirectory: false))
        defer {
            HostInputGuard.endCapture(breadcrumb: breadcrumb)
            try? FileManager.default.removeItem(at: root)
        }
        try body(breadcrumb)
    }
}
