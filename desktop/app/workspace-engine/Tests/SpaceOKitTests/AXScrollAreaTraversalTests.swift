import XCTest
import ApplicationServices
import CoreGraphics
@testable import SpaceOKit

/// Scroll resolution is the AX walk that runs while the daemon actor is held, so these tests are
/// about a stronger property than "it finds the right scroller": no application — enormous,
/// cyclic, or wedged — may make it run unbounded.
final class AXScrollAreaTraversalTests: XCTestCase {
    private let point = CGPoint(x: 100, y: 400)

    // MARK: - Answer

    func testDeepestNestedScrollAreaContainingThePointIsChosen() throws {
        let provider = FakeScrollAXProvider()
        provider.children = [0: [1], 1: [2, 3], 2: [4]]
        provider.roles = [
            0: kAXWindowRole as String,
            1: kAXGroupRole as String,
            2: kAXScrollAreaRole as String,
            3: kAXScrollAreaRole as String,
            4: kAXScrollAreaRole as String,
        ]
        provider.frames = [
            0: CGRect(x: 0, y: 0, width: 1_000, height: 1_000),
            1: CGRect(x: 0, y: 0, width: 1_000, height: 1_000),
            2: CGRect(x: 0, y: 0, width: 500, height: 1_000),
            3: CGRect(x: 600, y: 0, width: 400, height: 1_000),
            4: CGRect(x: 50, y: 300, width: 200, height: 200),
        ]

        let found = try search(provider)

        XCTAssertEqual(found, 4)
    }

    func testScrollAreaWhoseFrameExcludesThePointIsNeitherChosenNorDescended() throws {
        let provider = FakeScrollAXProvider()
        provider.children = [0: [1, 2], 2: [3]]
        provider.roles = [
            0: kAXWindowRole as String,
            1: kAXScrollAreaRole as String,
            2: kAXGroupRole as String,
            3: kAXScrollAreaRole as String,
        ]
        provider.frames = [
            0: CGRect(x: 0, y: 0, width: 1_000, height: 1_000),
            1: CGRect(x: 0, y: 0, width: 500, height: 1_000),
            2: CGRect(x: 600, y: 0, width: 400, height: 1_000),
            3: CGRect(x: 600, y: 300, width: 200, height: 200),
        ]

        let found = try search(provider)

        XCTAssertEqual(found, 1)
        XCTAssertFalse(
            provider.childCountRequests.contains(2),
            "a subtree whose frame excludes the point must not be read at all")
    }

    func testElementWithoutAFrameIsDescendedRatherThanSkipped() throws {
        let provider = FakeScrollAXProvider()
        provider.children = [0: [1], 1: [2]]
        provider.roles = [
            0: kAXWindowRole as String,
            1: kAXGroupRole as String,
            2: kAXScrollAreaRole as String,
        ]
        provider.frames = [
            0: CGRect(x: 0, y: 0, width: 1_000, height: 1_000),
            2: CGRect(x: 0, y: 0, width: 500, height: 1_000),
        ]

        XCTAssertEqual(try search(provider), 2)
    }

    // MARK: - Bounds

    func testCyclicChildrenTerminateInsteadOfExpandingCombinatorially() throws {
        // Every element lists every element, itself included: the shape a toolkit that exposes a
        // parent inside `AXChildren` produces. With a depth cap alone this is 8^16 visits.
        let provider = FakeScrollAXProvider()
        let all = Array(0..<8)
        for element in all {
            provider.children[element] = all
            provider.roles[element] = kAXGroupRole as String
        }
        let clock = ScrollTestClock()
        let budget = try AXTraversalBudget(
            limits: AXTraversalLimits(
                maxDepth: 16,
                maxNodes: 200,
                timeout: 1,
                maxAXCalls: 5_000,
                maxAllocatedBytes: 1_024 * 1_024,
                childPageSize: 8,
                maxCallDuration: 0.1),
            now: { clock.value },
            isCancelled: { false })

        let found = try AXTraversal.deepestScrollArea(
            root: 0, containing: point, provider: provider, budget: budget)

        XCTAssertNil(found)
        // Root plus one visit per edge out of each of the eight distinct elements. Each element
        // is expanded exactly once, which is what the visited set buys.
        XCTAssertEqual(budget.nodes, 1 + 8 * 8)
    }

    func testEnormousChildArrayIsPagedAndStopsAtTheNodeBudget() throws {
        let provider = FakeScrollAXProvider()
        provider.childCountOverrides[0] = 200_000
        provider.roles[0] = kAXWindowRole as String
        let clock = ScrollTestClock()
        let limits = AXTraversalLimits(
            maxDepth: 16,
            maxNodes: 5,
            timeout: 1,
            maxAXCalls: 500,
            maxAllocatedBytes: 1_024 * 1_024,
            childPageSize: 3,
            maxCallDuration: 0.1)
        let budget = try AXTraversalBudget(
            limits: limits, now: { clock.value }, isCancelled: { false })

        XCTAssertThrowsError(
            try AXTraversal.deepestScrollArea(
                root: 0, containing: point, provider: provider, budget: budget)
        ) { error in
            XCTAssertEqual((error as? AXTraversalStopped)?.reason, .nodes)
        }

        XCTAssertEqual(provider.pageRequests.map(\.maxValues), [3, 1])
        XCTAssertFalse(
            provider.pageRequests.contains { $0.maxValues > limits.childPageSize },
            "the whole child array must never be copied in one read")
        XCTAssertEqual(budget.nodes, limits.maxNodes)
    }

    func testDelayedProviderStopsAtTheMonotonicDeadline() throws {
        let provider = FakeScrollAXProvider()
        provider.children = [0: Array(1..<64)]
        let clock = ScrollTestClock()
        provider.afterProviderCall = { clock.advance(by: 6_000_000) }
        let budget = try AXTraversalBudget(
            limits: AXTraversalLimits(
                maxDepth: 16,
                maxNodes: 500,
                timeout: 0.020,
                maxAXCalls: 500,
                maxAllocatedBytes: 1_024 * 1_024,
                childPageSize: 8,
                maxCallDuration: 0.010),
            now: { clock.value },
            isCancelled: { false })

        XCTAssertThrowsError(
            try AXTraversal.deepestScrollArea(
                root: 0, containing: point, provider: provider, budget: budget)
        ) { error in
            XCTAssertEqual((error as? AXTraversalStopped)?.reason, .deadline)
        }
        XCTAssertLessThanOrEqual(provider.providerCallCount, 4)
    }

    func testCancellationStopsTheWalkBetweenProviderCalls() throws {
        let provider = FakeScrollAXProvider()
        provider.children = [0: Array(1..<64)]
        let clock = ScrollTestClock()
        let budget = try AXTraversalBudget(
            limits: AXTraversalLimits(
                maxDepth: 16,
                maxNodes: 500,
                timeout: 5,
                maxAXCalls: 500,
                maxAllocatedBytes: 1_024 * 1_024,
                childPageSize: 8,
                maxCallDuration: 0.1),
            now: { clock.value },
            isCancelled: { provider.providerCallCount >= 2 })

        XCTAssertThrowsError(
            try AXTraversal.deepestScrollArea(
                root: 0, containing: point, provider: provider, budget: budget)
        ) { error in
            XCTAssertEqual((error as? AXTraversalStopped)?.reason, .cancelled)
        }
        XCTAssertEqual(provider.providerCallCount, 2)
    }

    func testEveryCallCarriesABoundedMessagingTimeout() throws {
        let provider = FakeScrollAXProvider()
        provider.children = [0: [1]]
        provider.roles = [1: kAXScrollAreaRole as String]
        provider.frames = [1: CGRect(x: 0, y: 0, width: 500, height: 1_000)]
        let clock = ScrollTestClock()
        let limits = AXTraversalLimits(
            maxDepth: 16,
            maxNodes: 50,
            timeout: 1,
            maxAXCalls: 500,
            maxAllocatedBytes: 1_024 * 1_024,
            childPageSize: 8,
            maxCallDuration: 0.075)
        let budget = try AXTraversalBudget(
            limits: limits, now: { clock.value }, isCancelled: { false })

        XCTAssertEqual(
            try AXTraversal.deepestScrollArea(
                root: 0, containing: point, provider: provider, budget: budget),
            1)

        XCTAssertTrue(provider.timeoutElements.contains(0))
        XCTAssertTrue(provider.timeoutElements.contains(1))
        XCTAssertEqual(provider.timeoutElements.count, provider.providerCallCount)
        XCTAssertTrue(provider.timeouts.allSatisfy { $0 > 0 && $0 <= 0.0751 })
    }

    func testProviderThatRejectsItsTimeoutIsNeverCalledUnbounded() throws {
        let provider = FakeScrollAXProvider()
        provider.acceptsMessagingTimeout = false
        let clock = ScrollTestClock()
        let budget = try AXTraversalBudget(
            limits: AXTraversalLimits(), now: { clock.value }, isCancelled: { false })

        XCTAssertThrowsError(
            try AXTraversal.deepestScrollArea(
                root: 0, containing: point, provider: provider, budget: budget)
        ) { error in
            XCTAssertEqual((error as? AXTraversalStopped)?.reason, .provider)
        }
        XCTAssertEqual(provider.providerCallCount, 0)
    }

    func testNonFinitePointIsRejectedBeforeAnyProviderCall() throws {
        let provider = FakeScrollAXProvider()
        provider.children = [0: [1]]
        let clock = ScrollTestClock()
        let budget = try AXTraversalBudget(
            limits: AXTraversalLimits(), now: { clock.value }, isCancelled: { false })

        XCTAssertNil(
            try AXTraversal.deepestScrollArea(
                root: 0,
                containing: CGPoint(x: CGFloat.nan, y: 400),
                provider: provider,
                budget: budget))
        XCTAssertEqual(provider.providerCallCount, 0)
    }

    /// The live envelope is applied through `AXTraversalBudget.init`, which throws on limits that
    /// do not validate — and `AX.scrollArea` swallows that into "no scroll area found". An
    /// invalid constant would therefore disable accessibility scrolling silently and forever.
    func testLiveScrollAreaLimitsValidate() throws {
        XCTAssertNoThrow(try AX.scrollAreaLimits.validate())
    }

    // MARK: - Helpers

    private func search(_ provider: FakeScrollAXProvider) throws -> Int? {
        let clock = ScrollTestClock()
        let budget = try AXTraversalBudget(
            limits: AXTraversalLimits(
                maxDepth: 16,
                maxNodes: 200,
                timeout: 1,
                maxAXCalls: 5_000,
                maxAllocatedBytes: 1_024 * 1_024,
                childPageSize: 8,
                maxCallDuration: 0.1),
            now: { clock.value },
            isCancelled: { false })
        return try AXTraversal.deepestScrollArea(
            root: 0, containing: point, provider: provider, budget: budget)
    }
}

private final class ScrollTestClock {
    private(set) var value: UInt64 = 0

    func advance(by nanoseconds: UInt64) {
        value &+= nanoseconds
    }
}

/// A stubbed accessibility graph: arbitrary parent/child edges (cycles included), per-element
/// roles, and per-element frames, with every provider call recorded.
private final class FakeScrollAXProvider: AXTraversalProviding {
    struct PageRequest: Equatable {
        let element: Int
        let start: Int
        let maxValues: Int
    }

    var children: [Int: [Int]] = [:]
    var roles: [Int: String] = [:]
    var frames: [Int: CGRect] = [:]
    /// Child counts reported without materialising the array, for graphs too large to build.
    var childCountOverrides: [Int: Int] = [:]
    var acceptsMessagingTimeout = true
    var afterProviderCall: () -> Void = {}
    private(set) var providerCallCount = 0
    private(set) var pageRequests: [PageRequest] = []
    private(set) var childCountRequests: [Int] = []
    private(set) var timeoutElements: [Int] = []
    private(set) var timeouts: [Float] = []

    func setMessagingTimeout(_ element: Int, seconds: Float) -> Bool {
        timeoutElements.append(element)
        timeouts.append(seconds)
        return acceptsMessagingTimeout
    }

    func string(_ element: Int, attribute: String) -> String? {
        called()
        guard attribute == kAXRoleAttribute as String else { return nil }
        return roles[element]
    }

    func bool(_ element: Int, attribute: String) -> Bool? {
        called()
        return true
    }

    func actions(_ element: Int) -> [String] {
        called()
        return []
    }

    func point(_ element: Int, attribute: String) -> CGPoint? {
        called()
        return frames[element]?.origin
    }

    func size(_ element: Int, attribute: String) -> CGSize? {
        called()
        return frames[element]?.size
    }

    func arrayCount(_ element: Int, attribute: String) -> Int {
        called()
        childCountRequests.append(element)
        return count(of: element)
    }

    func elements(
        _ element: Int,
        attribute: String,
        start: Int,
        maxValues: Int
    ) -> [Int] {
        called()
        pageRequests.append(
            PageRequest(element: element, start: start, maxValues: maxValues))
        let end = min(count(of: element), start + maxValues)
        guard start < end else { return [] }
        if let listed = children[element] { return Array(listed[start..<end]) }
        // Synthesised children of an oversized array: distinct ids that expose nothing further.
        return (start..<end).map { $0 + 1 }
    }

    func windowID(_ element: Int) -> CGWindowID {
        called()
        return CGWindowID(element)
    }

    private func count(of element: Int) -> Int {
        childCountOverrides[element] ?? children[element]?.count ?? 0
    }

    private func called() {
        providerCallCount += 1
        afterProviderCall()
    }
}
