import XCTest
import AppKit
@testable import SpaceOKit

/// Deterministic regressions for SPAO-129.
///
/// These inject the result immediately after each of the private transaction's three records.
/// No private API or real WindowServer input route is mutated by the tests.
final class FocusRecoveryTests: XCTestCase {

    private func originalRoute(windowID: CGWindowID = 41) -> InputRouter.UserInputRoute {
        InputRouter.UserInputRoute(
            app: NSRunningApplication.current,
            windowID: windowID)
    }

    private func targetWindow(pid: pid_t = 32_001) -> SpaceOKit.WindowRef {
        SpaceOKit.WindowRef(
            windowID: 91,
            pid: pid,
            title: "injected target",
            frame: CGRect(x: 0, y: 0, width: 100, height: 100))
    }

    func testFailureAfterEveryPrivateRecordRestoresCapturedRouteAndStopsInput() {
        for record in InputRouter.FocusRecord.allCases {
            let route = originalRoute(windowID: CGWindowID(100 + record.rawValue))
            let target = targetWindow(pid: pid_t(33_000 + record.rawValue))
            var simulatedRoutePID = route.app.processIdentifier
            var captureCount = 0
            var restoredWindowIDs: [CGWindowID] = []
            var inputWasSent = false

            do {
                try InputRouter.prepareForInput(
                    target,
                    capturedRoute: {
                        captureCount += 1
                        return route
                    },
                    attempt: { pid, _ in
                        simulatedRoutePID = pid
                        return .failed(after: record)
                    },
                    restore: { captured in
                        restoredWindowIDs.append(captured.windowID)
                        simulatedRoutePID = captured.app.processIdentifier
                        return true
                    })
                inputWasSent = true
                XCTFail("failure after \(record) must stop input")
            } catch {
                XCTAssertTrue(error.localizedDescription.contains(record.description))
                XCTAssertTrue(error.localizedDescription.contains("was restored"))
            }

            XCTAssertEqual(captureCount, 1)
            XCTAssertEqual(restoredWindowIDs, [route.windowID])
            XCTAssertEqual(simulatedRoutePID, route.app.processIdentifier)
            XCTAssertFalse(inputWasSent)
        }
    }

    func testNoAttemptFallsBackWithoutRunningRestoration() {
        let route = originalRoute()
        let target = targetWindow()
        var restoreCount = 0

        XCTAssertNoThrow(
            try InputRouter.prepareForInput(
                target,
                capturedRoute: { route },
                attempt: { _, _ in .notAttempted },
                restore: { _ in
                    restoreCount += 1
                    return true
                }))
        XCTAssertEqual(restoreCount, 0, "no mutation-possible record was attempted")
    }

    func testUnverifiablePartialFailureRecoveryReturnsActionableErrorAndStopsInput() {
        let route = originalRoute()
        let target = targetWindow()
        var simulatedRoutePID = route.app.processIdentifier
        var inputWasSent = false

        do {
            try InputRouter.prepareForInput(
                target,
                capturedRoute: { route },
                attempt: { pid, _ in
                    simulatedRoutePID = pid
                    return .failed(after: .keyDown)
                },
                restore: { _ in false })
            inputWasSent = true
            XCTFail("unverified recovery must stop input")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("could not verify restoration"))
            XCTAssertTrue(error.localizedDescription.contains("Click or activate"))
            XCTAssertTrue(error.localizedDescription.contains("spaceo doctor"))
        }

        XCTAssertEqual(simulatedRoutePID, target.pid)
        XCTAssertFalse(inputWasSent)
    }

    func testSuccessfulFocusStillRequiresVerifiedRestorationBeforeInput() {
        let route = originalRoute()
        let target = targetWindow()
        var simulatedRoutePID = route.app.processIdentifier
        var inputWasSent = false

        do {
            try InputRouter.prepareForInput(
                target,
                capturedRoute: { route },
                attempt: { pid, _ in
                    simulatedRoutePID = pid
                    return .succeeded
                },
                restore: { _ in false })
            inputWasSent = true
            XCTFail("an unverified final restore must stop input")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("could not verify restoration"))
            XCTAssertTrue(error.localizedDescription.contains("Input was not sent"))
        }

        XCTAssertEqual(simulatedRoutePID, target.pid)
        XCTAssertFalse(inputWasSent)
    }

    func testVerifiedSuccessRestoresRouteBeforeCallerSendsInput() throws {
        let route = originalRoute()
        let target = targetWindow()
        var simulatedRoutePID = route.app.processIdentifier
        var inputWasSent = false

        try InputRouter.prepareForInput(
            target,
            capturedRoute: { route },
            attempt: { pid, _ in
                simulatedRoutePID = pid
                return .succeeded
            },
            restore: { captured in
                simulatedRoutePID = captured.app.processIdentifier
                return true
            })
        inputWasSent = true

        XCTAssertEqual(simulatedRoutePID, route.app.processIdentifier)
        XCTAssertTrue(inputWasSent)
    }

    func testRouteVerificationRejectsDifferentWindowInSameFrontmostProcess() {
        let pid = getpid()

        XCTAssertFalse(InputRouter.routeIdentityMatches(
            expectedPID: pid,
            expectedWindowID: 41,
            frontmostPID: pid,
            focusedWindowID: 42))
        XCTAssertTrue(InputRouter.routeIdentityMatches(
            expectedPID: pid,
            expectedWindowID: 41,
            frontmostPID: pid,
            focusedWindowID: 41))
    }

    func testRouteWithoutCapturedWindowFallsBackToFrontmostProcessIdentity() {
        let pid = getpid()

        XCTAssertTrue(InputRouter.routeIdentityMatches(
            expectedPID: pid,
            expectedWindowID: 0,
            frontmostPID: pid,
            focusedWindowID: nil))
        XCTAssertFalse(InputRouter.routeIdentityMatches(
            expectedPID: pid,
            expectedWindowID: 0,
            frontmostPID: pid + 1,
            focusedWindowID: nil))
    }
}
