import XCTest
@testable import SpaceOKit

final class AXTraversalChildBudgetTests: XCTestCase {
    private func assertStopped(_ reason: AXTraversalStopReason, _ work: () throws -> Void,
                               file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertThrowsError(try work(), file: file, line: line) {
            XCTAssertEqual(($0 as? AXTraversalStopped)?.reason, reason, file: file, line: line)
        }
    }

    func testMovementInheritsEvenASubTenMillisecondRemainder() throws {
        var time: UInt64 = 0
        let parent = try AXTraversalBudget(limits: AXWindowDiscovery.limits(remaining: nil),
                                           now: { time }, isCancelled: { false })
        time = 1_995_000_000
        let child = try WindowMovement.budget(parent: parent)
        XCTAssertEqual(child.remainingNanoseconds, 5_000_000)
        XCTAssertEqual(try child.beginAXCall(), 0.005, accuracy: 0.000001)
        XCTAssertEqual(parent.axCalls, 1)
        time = 2_000_000_000
        assertStopped(.deadline) { try child.check() }
        assertStopped(.deadline) { _ = try WindowMovement.budget(parent: parent) }
    }

    func testMovementStillHasItsOwnOneSecondCeiling() throws {
        var time: UInt64 = 0
        let parent = try AXTraversalBudget(limits: AXTraversalLimits(timeout: 5),
                                           now: { time }, isCancelled: { false })
        let child = try WindowMovement.budget(parent: parent)
        time = 1_000_000_000
        assertStopped(.deadline) { try child.check() }
        XCTAssertNoThrow(try parent.check())
        XCTAssertEqual(parent.remainingNanoseconds, 4_000_000_000)
    }

    func testSiblingScopesShareCallCountersAndParentPerCallTimeout() throws {
        var outer = AXTraversalLimits(maxAXCalls: 3)
        outer.maxCallDuration = 0.05
        let parent = try AXTraversalBudget(limits: outer, now: { 0 }, isCancelled: { false })
        let first = try parent.child(limits: AXTraversalLimits(maxAXCalls: 1))
        XCTAssertEqual(try first.beginAXCall(), 0.05, accuracy: 0.000001)
        assertStopped(.axCalls) { _ = try first.beginAXCall() }
        XCTAssertEqual(parent.axCalls, 1, "an exhausted child cannot spend more parent calls")
        let second = try parent.child(limits: AXTraversalLimits(maxAXCalls: 3))
        _ = try second.beginAXCall()
        _ = try second.beginAXCall()
        assertStopped(.axCalls) { _ = try second.beginAXCall() }
        XCTAssertEqual(parent.axCalls, 3)
        XCTAssertEqual(second.axCalls, 2)
    }

    func testNestedNodeAndAllocationLimitsChargeTheWholeOperation() throws {
        let parent = try AXTraversalBudget(limits: AXTraversalLimits(maxNodes: 3, maxAllocatedBytes: 100),
                                           now: { 0 }, isCancelled: { false })
        let first = try parent.child(limits: AXTraversalLimits(maxNodes: 2, maxAllocatedBytes: 80))
        let nested = try first.child(limits: AXTraversalLimits(maxNodes: 2, maxAllocatedBytes: 80))
        try nested.consumeNode()
        try nested.consumeAllocation(70)
        XCTAssertEqual(parent.nodes, 1)
        XCTAssertEqual(first.nodes, 1)
        XCTAssertEqual(parent.allocatedBytes, 70)
        XCTAssertEqual(first.allocatedBytes, 70)
        let second = try parent.child(limits: AXTraversalLimits(maxNodes: 3, maxAllocatedBytes: 80))
        assertStopped(.allocation) { try second.consumeAllocation(31) }
        XCTAssertEqual(second.allocatedBytes, 0)
        try second.consumeAllocation(30)
        try second.consumeNode()
        try second.consumeNode()
        XCTAssertEqual(second.remainingNodes, 0)
        assertStopped(.nodes) { try second.consumeNode() }
        XCTAssertEqual(parent.nodes, 3)
        XCTAssertEqual(parent.allocatedBytes, 100)
    }

    func testParentStopPropagatesIntoAnExistingMovementScope() throws {
        var stopped = false
        let parent = try AXTraversalBudget(limits: AXTraversalLimits(), now: { 0 }, isCancelled: { stopped })
        let child = try WindowMovement.budget(parent: parent)
        stopped = true
        assertStopped(.cancelled) { try child.check() }
        assertStopped(.cancelled) { _ = try child.beginAXCall() }
        assertStopped(.cancelled) { _ = try WindowMovement.budget(parent: parent) }
        XCTAssertEqual(parent.axCalls, 0)
        XCTAssertEqual(child.axCalls, 0)
    }
}
