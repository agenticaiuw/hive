import XCTest
@testable import SpaceOKit

final class DisplayModeTransactionTests: XCTestCase {
    final class Fake: DisplayModeTransactionBacking {
        var identity: UInt32 = 42
        let descriptorLimit = DisplayModeSize(width: 1920, height: 1080)
        var mode = DisplayModeSize(width: 1920, height: 1080)
        var responses = [Bool]()
        var calls = [DisplayModeSize]()
        var changeIdentity = false
        func currentMode() -> DisplayModeSize? { mode }
        func applyMode(_ requested: DisplayModeSize) -> Bool {
            calls.append(requested)
            if changeIdentity { identity = 99 }
            let ok = responses.isEmpty ? true : responses.removeFirst()
            if ok { mode = requested }
            return ok
        }
    }
    let view = DisplayModeSize(width: 1710, height: 1107)
    func testExactGeometryAndPointerMapping() {
        let target = DisplayModeTransaction.matchingMode(view: view, limit: .init(width: 1920, height: 1080))!
        XCTAssertEqual(target, .init(width: 1520, height: 984))
        let m = MirrorInput.ViewportMapping(displayBounds: CGRect(x: 100, y: 50, width: target.width, height: target.height), viewSize: CGSize(width: view.width, height: view.height), stretch: true)
        XCTAssertEqual(m.contentRect.size, CGSize(width: 1710, height: 1107))
        let p = m.globalPoint(fromViewPoint: CGPoint(x: 855, y: 553.5))!
        XCTAssertEqual(p.x, 860, accuracy: 0.001); XCTAssertEqual(p.y, 542, accuracy: 0.001)
        XCTAssertEqual(m.contentRect.width / CGFloat(target.width), m.contentRect.height / CGFloat(target.height), accuracy: 0.00001)
    }
    func testSuccessAndIdentity() { let f = Fake(); XCTAssertEqual(DisplayModeTransaction.change(f, view: view), .changed); XCTAssertEqual(f.identity, 42); XCTAssertEqual(f.calls.count, 1) }
    func testFailedApplyRollsBack() { let f = Fake(); f.responses = [false, true]; XCTAssertEqual(DisplayModeTransaction.change(f, view: view), .rolledBack); XCTAssertEqual(f.calls.count, 2) }
    func testFailedRollback() { let f = Fake(); f.responses = [false, false]; XCTAssertEqual(DisplayModeTransaction.change(f, view: view), .rollbackFailed) }
    func testIdentityChangeDoesNotTouchReplacement() { let f = Fake(); f.changeIdentity = true; XCTAssertEqual(DisplayModeTransaction.change(f, view: view), .identityChanged); XCTAssertEqual(f.calls.count, 1) }
    func testInvalidGeometryDoesNotApply() { let f = Fake(); XCTAssertEqual(DisplayModeTransaction.change(f, view: .init(width: 0, height: 1)), .invalid); XCTAssertTrue(f.calls.isEmpty) }
}
