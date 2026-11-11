import XCTest
import CoreGraphics
@testable import SpaceOKit

final class WindowPlacementTransactionTests: XCTestCase {
    private let region = CGRect(x: 1000, y: 0, width: 800, height: 600)

    private func fixture(_ count: Int = 3) -> AXWindowDiscovery.Result<Int> {
        let windows = (1...count).map { index in
            WindowRef(windowID: CGWindowID(index), pid: 42, title: "Window \(index)",
                      frame: CGRect(x: index * 10, y: 20, width: 200, height: 100))
        }
        return AXWindowDiscovery.Result(windows: windows,
            elements: Dictionary(uniqueKeysWithValues: windows.map { ($0.windowID, Int($0.windowID) + 100) }))
    }

    func testPlacementUsesOneCompleteDiscoveryAndRetainedHandles() throws {
        let discovery = fixture()
        var discoveries = 0
        var handles: [Int] = []
        var moved: [CGWindowID: CGRect] = [:]
        let result = try WindowPlacement.placeAll(of: 42, into: region, policy: .preserve,
            discover: { discoveries += 1; return discovery },
            move: { window, element, target in handles.append(element); moved[window.windowID] = target },
            bounds: { try XCTUnwrap(moved[$0]) })
        XCTAssertEqual(discoveries, 1)
        XCTAssertEqual(handles, [101, 102, 103])
        XCTAssertEqual(result.map(\.windowID), [1, 2, 3])
        XCTAssertTrue(result.allSatisfy { WindowPlacement.isFullyInside($0.frame, region) })
    }

    func testFailedOrIncompleteDiscoveryNeverStartsAMove() throws {
        let discovery = fixture()
        for fails in [true, false] {
            var moves = 0
            XCTAssertThrowsError(try WindowPlacement.placeAll(of: 42, into: region, policy: .preserve,
                discover: { () throws -> AXWindowDiscovery.Result<Int> in
                    if fails { throw AXWindowDiscovery.incomplete("fixture page failure") }
                    return AXWindowDiscovery.Result(windows: discovery.windows, elements: [1: 101])
                }, move: { _, _, _ in moves += 1 }, bounds: { _ in .zero })) {
                XCTAssertEqual(($0 as? AXTraversalStopped)?.reason, .provider)
            }
            XCTAssertEqual(moves, 0)
        }
    }

    func testContainmentRefusalRollsBackEveryOriginalUsingTheSameHandles() throws {
        let discovery = fixture()
        var calls: [(CGWindowID, Int, CGRect)] = []
        XCTAssertThrowsError(try WindowPlacement.placeAll(of: 42, into: region, policy: .preserve,
            discover: { discovery }, move: { calls.append(($0.windowID, $1, $2)) },
            bounds: { id in id == 1 ? self.region : CGRect(x: 0, y: 0, width: 2000, height: 2000) })) {
            guard case .unsupportedTarget = $0 as? SpaceOError else { return XCTFail("\($0)") }
        }
        XCTAssertEqual(calls.map { $0.0 }, [1, 2, 1, 2, 3])
        XCTAssertEqual(calls.map { $0.1 }, [101, 102, 101, 102, 103])
        XCTAssertEqual(calls.suffix(3).map { $0.2 }, discovery.windows.map(\.frame))
    }

    func testRollbackFailureDoesNotPreventRestoringOtherWindows() throws {
        let discovery = fixture()
        var calls: [CGWindowID] = []
        XCTAssertThrowsError(try WindowPlacement.placeAll(of: 42, into: region, policy: .preserve,
            discover: { discovery }, move: { window, _, target in
                calls.append(window.windowID)
                if target == window.frame { throw SpaceOError.windowNotFound("fixture closed") }
            }, bounds: { _ in CGRect(x: 0, y: 0, width: 2000, height: 2000) })) {
                guard case .unsupportedTarget = $0 as? SpaceOError else { return XCTFail("\($0)") }
            }
        XCTAssertEqual(calls, [1, 1, 2, 3])
    }

    func testClosedWindowIsOmittedFromPlacementReceipt() throws {
        let discovery = fixture(2)
        let result = try WindowPlacement.placeAll(of: 42, into: region, policy: .preserve,
            discover: { discovery }, move: { _, _, _ in }, bounds: { id in
                if id == 1 { throw SpaceOError.windowNotFound("fixture closed") }
                return self.region
            })
        XCTAssertEqual(result.map(\.windowID), [2])
    }

    func testCancellationBetweenMovesStillRollsBackOriginalWindows() async throws {
        let discovery = fixture(2)
        let task = Task { () -> [CGWindowID] in
            var calls: [CGWindowID] = []
            do {
                _ = try WindowPlacement.placeAll(of: 42, into: region, policy: .preserve,
                    discover: { discovery }, move: { window, _, _ in
                        calls.append(window.windowID)
                        if calls.count == 1 { withUnsafeCurrentTask { $0?.cancel() } }
                    }, bounds: { _ in self.region })
                XCTFail("cancelled placement must not claim completion")
            } catch { XCTAssertTrue(error is CancellationError) }
            return calls
        }
        let calls = await task.value
        XCTAssertEqual(calls, [1, 1, 2])
    }
}
