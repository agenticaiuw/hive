import XCTest
import CoreGraphics
@testable import SpaceOKit

final class WindowOwnerLookupTests: XCTestCase {
    private func description(id: Any = UInt32(42), owner: Any = 123) -> [String: Any] {
        [kCGWindowNumber as String: id, kCGWindowOwnerPID as String: owner]
    }

    func testDescribesOnlyTheRequestedRawWindowIDAndReturnsItsOwner() {
        var calls = 0
        let pid = WindowPlacement.liveOwnerPID(of: 42) { ids in
            calls += 1
            // Core Graphics reads raw window numbers; a bridged CFNumber matches nothing.
            XCTAssertEqual(ids.map(CFArrayGetCount), 1)
            XCTAssertEqual(ids.flatMap { UInt(bitPattern: CFArrayGetValueAtIndex($0, 0)) }, 42)
            return [description(id: NSNumber(value: 42), owner: NSNumber(value: 123))] as CFArray
        }
        XCTAssertEqual(pid, 123)
        XCTAssertEqual(calls, 1)
    }

    func testRawWindowIDArrayHoldsTheWindowNumberItself() throws {
        let ids = try XCTUnwrap(WindowPlacement.rawWindowIDArray(CGWindowID(UInt32.max)))
        XCTAssertEqual(CFArrayGetCount(ids), 1)
        XCTAssertEqual(UInt(bitPattern: CFArrayGetValueAtIndex(ids, 0)), UInt(UInt32.max))
    }

    func testPlaceholderDoesNotQueryWindowServer() {
        XCTAssertNil(WindowPlacement.liveOwnerPID(of: 0) { _ in
            XCTFail("placeholder window must not reach Core Graphics")
            return nil
        })
    }

    func testUnavailableAmbiguousOrDifferentWindowIsNotAnOwner() {
        let replies: [CFArray?] = [
            nil, [] as CFArray, ["invalid"] as CFArray,
            [description(), description()] as CFArray,
            [description(id: UInt32(43))] as CFArray,
            [description(id: "42")] as CFArray,
            [[kCGWindowOwnerPID as String: 123]] as CFArray,
            [[kCGWindowNumber as String: 42]] as CFArray,
        ]
        for reply in replies {
            XCTAssertNil(WindowPlacement.liveOwnerPID(of: 42) { _ in reply })
        }
    }

    func testInvalidOwnerCannotTrapOrBecomeAValidPID() {
        for owner: Any in [0, -1, Int64(Int32.max) + 1, "123", 1.5] {
            XCTAssertNil(WindowPlacement.liveOwnerPID(of: 42) { _ in
                [description(owner: owner)] as CFArray
            })
        }
        XCTAssertEqual(WindowPlacement.liveOwnerPID(of: 42) { _ in
            [description(owner: Int(Int32.max))] as CFArray
        }, Int32.max)
    }
}
