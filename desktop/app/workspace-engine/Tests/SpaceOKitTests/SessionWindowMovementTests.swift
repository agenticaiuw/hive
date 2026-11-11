import XCTest
import CoreGraphics
@testable import SpaceOKit

final class SessionWindowMovementTests: XCTestCase {
    private func window(_ id: CGWindowID = 1, pid: pid_t = 42) -> SpaceOKit.WindowRef {
        WindowRef(windowID: id, pid: pid, title: "Test", frame: CGRect(x: 0, y: 0, width: 100, height: 100))
    }

    func testDiscoveredMovesUseTheirHandleAndOnlyOmittedWindowsUseFallback() throws {
        var retained: [Int] = []
        var fallback: [CGWindowID] = []
        let movement = try SessionWindowMovement(pid: 42,
            result: AXWindowDiscovery.Result(windows: [window()], elements: [1: 123]),
            validate: {}, move: { _, handle, _ in retained.append(handle) },
            fallback: { window, _ in fallback.append(window.windowID) })
        try movement.move(window(), .zero)
        try movement.move(window(2), .zero)
        XCTAssertEqual(retained, [123])
        XCTAssertEqual(fallback, [2])
        XCTAssertThrowsError(try movement.move(window(pid: 99), .zero))
        XCTAssertEqual(retained, [123])
        XCTAssertEqual(fallback, [2])
    }

    func testIncompleteOrWrongProcessHandlesCannotProduceMovementCapability() {
        for (windows, elements) in [([window()], [CGWindowID: Int]()), ([window(pid: 99)], [1: 123])] {
            XCTAssertThrowsError(try SessionWindowMovement(pid: 42,
                result: AXWindowDiscovery.Result<Int>(windows: windows, elements: elements),
                validate: {}, move: { _, _, _ in XCTFail("no movement") },
                fallback: { _, _ in XCTFail("no fallback") }))
        }
    }

    func testChangedProcessBlocksBothHandleAndFallbackMovement() throws {
        var valid = true
        let movement = try SessionWindowMovement(pid: 42,
            result: AXWindowDiscovery.Result(windows: [window()], elements: [1: 123]),
            validate: { if !valid { throw SpaceOError.applicationExited("test") } },
            move: { _, _, _ in XCTFail("stale handle must not move") },
            fallback: { _, _ in XCTFail("stale identity must not start lookup") })
        valid = false
        XCTAssertThrowsError(try movement.move(window(), .zero))
        XCTAssertThrowsError(try movement.move(window(2), .zero))
    }

    func testFailedHandleMoveNeverSwitchesToANewLookup() throws {
        let movement = try SessionWindowMovement(pid: 42,
            result: AXWindowDiscovery.Result(windows: [window()], elements: [1: 123]),
            validate: {}, move: { _, _, _ in throw SpaceOError.windowNotFound("closed") },
            fallback: { _, _ in XCTFail("a stale discovered handle must not silently switch targets") })
        XCTAssertThrowsError(try movement.move(window(), .zero))
    }
}
