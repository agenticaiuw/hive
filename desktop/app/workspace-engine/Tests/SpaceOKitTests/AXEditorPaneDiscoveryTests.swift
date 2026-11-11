import ApplicationServices
import CoreGraphics
import XCTest
@testable import SpaceOKit

final class AXEditorPaneDiscoveryTests: XCTestCase {
    private final class Provider: AXEditorPaneDiscoveryProviding {
        typealias Element = Int
        var windows = [1]
        var windowCountOverride: Int?
        var children: [Int: [Int]] = [:]
        var childCountOverride: [Int: Int] = [:]
        var panes: [Int: CGRect] = [:]
        var missingGeometry = Set<Int>()
        var errors = Set<String>()
        var windowProviderStatus: AXError?
        var pageDelta = 0
        var windowPageDelta = 0
        var timeoutAccepted = true
        var subroleOverride: String?
        var changedIdentity = false
        var clock: UInt64 = 0
        var cancelled = false
        var advanceAtSubrole: UInt64 = 0
        var calls: [String] = []
        var timeouts: [Float] = []
        var windowPages: [(Int, Int)] = []
        var childPages: [(Int, Int, Int)] = []
        var visited: [Int] = []
        var identityReads = 0

        func check(_ call: String) throws {
            calls.append(call)
            if let windowProviderStatus, call == "windows" || call == "windowPage" {
                throw AXWindowDiscovery.ProviderFailure(status: windowProviderStatus, operation: call)
            }
            if errors.contains(call) { throw AXEditorPaneDiscovery.incomplete(call) }
        }
        func setMessagingTimeout(_ element: Int, seconds: Float) -> Bool {
            timeouts.append(seconds)
            return timeoutAccepted
        }
        func windowCount(_ app: Int) throws -> Int {
            try check("windows")
            return windowCountOverride ?? windows.count
        }
        func windowElements(_ app: Int, start: Int, count: Int) throws -> [Int] {
            try check("windowPage")
            windowPages.append((start, count))
            return Array(windows.dropFirst(start).prefix(max(0, count + windowPageDelta)))
        }
        func windowID(_ element: Int) -> CGWindowID {
            identityReads += 1
            return changedIdentity && identityReads > 1 ? 0 : CGWindowID(element)
        }
        func paneSubrole(_ element: Int) throws -> String? {
            try check("subrole:\(element)")
            visited.append(element)
            clock += advanceAtSubrole
            return subroleOverride ?? (panes[element] == nil ? nil : "AXCodeStyleGroup")
        }
        func childCount(_ element: Int) throws -> Int {
            try check("children:\(element)")
            return childCountOverride[element] ?? children[element, default: []].count
        }
        func childElements(_ element: Int, start: Int, count: Int) throws -> [Int] {
            try check("childPage:\(element):\(start)")
            childPages.append((element, start, count))
            return Array(children[element, default: []].dropFirst(start).prefix(max(0, count + pageDelta)))
        }
        func point(_ element: Int, attribute: String) -> CGPoint? {
            calls.append("point:\(element)")
            return missingGeometry.contains(element) ? nil : panes[element]?.origin
        }
        func size(_ element: Int, attribute: String) -> CGSize? {
            calls.append("size:\(element)")
            return missingGeometry.contains(element) ? nil : panes[element]?.size
        }
        func string(_ element: Int, attribute: String) -> String? { XCTFail("unnecessary text read"); return nil }
        func bool(_ element: Int, attribute: String) -> Bool? { XCTFail("unnecessary boolean read"); return nil }
        func actions(_ element: Int) -> [String] { XCTFail("unnecessary action read"); return [] }
        func arrayCount(_ element: Int, attribute: String) -> Int { XCTFail("unchecked count"); return 0 }
        func elements(_ element: Int, attribute: String, start: Int, maxValues: Int) -> [Int] {
            XCTFail("unchecked page"); return []
        }
    }

    private func budget(_ provider: Provider, limits: AXTraversalLimits = AXEditorPaneDiscovery.limits) throws -> AXTraversalBudget {
        try AXTraversalBudget(limits: limits, now: { provider.clock }, isCancelled: { provider.cancelled })
    }

    private func frames(_ provider: Provider, windowID: CGWindowID = 1,
                        limits: AXTraversalLimits = AXEditorPaneDiscovery.limits) throws -> [CGRect] {
        try AXEditorPaneDiscovery.frames(app: 0, windowID: windowID, provider: provider,
                                         budget: budget(provider, limits: limits))
    }

    private func assertStopped(_ reason: AXTraversalStopReason, _ work: () throws -> Void,
                               file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertThrowsError(try work(), file: file, line: line) {
            XCTAssertEqual(($0 as? AXTraversalStopped)?.reason, reason, file: file, line: line)
        }
    }

    func testPagedRootAndWideTreeAvoidOtherWindowMetadataAndOld128ChildTruncation() throws {
        let provider = Provider()
        provider.windows = Array(1...70)
        provider.children[70] = Array(100...299)
        let pane = CGRect(x: 500, y: 100, width: 500, height: 800)
        provider.panes[299] = pane
        let budget = try budget(provider)
        XCTAssertEqual(try AXEditorPaneDiscovery.frames(app: 0, windowID: 70,
            provider: provider, budget: budget), [pane])
        XCTAssertEqual(provider.windowPages.map { $0.1 }, [32, 32, 6])
        XCTAssertEqual(provider.childPages.map { $0.2 }, [32, 32, 32, 32, 32, 32, 8])
        XCTAssertEqual(provider.visited.count, 201)
        XCTAssertEqual(provider.visited.first, 70)
        XCTAssertEqual(provider.identityReads, 71)
        XCTAssertTrue(provider.timeouts.allSatisfy { $0 > 0 && $0 <= 0.25 })
        XCTAssertEqual(provider.timeouts.count, budget.axCalls)
        XCTAssertLessThan(budget.allocatedBytes, 16_000)
    }

    func testCyclesAndSharedSubtreesAreVisitedOnceAndPaneContentIsPruned() throws {
        let provider = Provider()
        provider.children = [1: [2, 3], 2: [1, 3, 4], 3: [4], 4: [5]]
        provider.panes[4] = CGRect(x: 0, y: 0, width: 100, height: 100)
        provider.errors.insert("subrole:5")
        XCTAssertEqual(try frames(provider), [provider.panes[4]!])
        XCTAssertEqual(Set(provider.visited), Set([1, 2, 3, 4]))
        XCTAssertEqual(provider.visited.count, 4)
        XCTAssertFalse(provider.calls.contains("children:4"))
    }

    func testWindowProviderErrorsKeepStructuredDiscoveryFailure() throws {
        let provider = Provider()
        provider.windowProviderStatus = .apiDisabled
        assertStopped(.provider) { _ = try frames(provider) }
        XCTAssertEqual(provider.calls, ["windows"])
    }

    func testSmallProxyDescendsAndCompleteEmptyLayoutPreservesRouting() throws {
        let provider = Provider()
        provider.children = [1: [2], 2: [3]]
        provider.panes = [2: CGRect(x: 0, y: 0, width: 1, height: 1),
                          3: CGRect(x: 0, y: 0, width: 100, height: 100)]
        XCTAssertEqual(try frames(provider), [provider.panes[3]!])
        XCTAssertNil(try ElectronEditorRouter.column(forPoint: .zero) { try self.frames(Provider()) })
        XCTAssertNil(try ElectronEditorRouter.column(forPoint: .zero) { try self.frames(provider) })
    }

    func testIncompleteDiscoveryNeverRoutesPartialPaneToActiveEditor() throws {
        for failure in ["windows", "windowPage", "subrole:1", "children:1", "childPage:1:0",
                        "subrole:3", "children:3"] {
            let provider = Provider()
            provider.children[1] = [2, 3]
            provider.panes[2] = CGRect(x: 0, y: 0, width: 100, height: 100)
            provider.errors.insert(failure)
            assertStopped(.provider) {
                _ = try ElectronEditorRouter.column(forPoint: .zero) { try self.frames(provider) }
            }
        }
    }

    func testHugeAndNegativeCountsRefuseBeforePageAllocation() throws {
        for count in [-1, Int.max] {
            let provider = Provider()
            provider.windowCountOverride = count
            assertStopped(count < 0 ? .provider : .nodes) { _ = try frames(provider) }
            XCTAssertTrue(provider.windowPages.isEmpty)
            provider.windowCountOverride = nil
            provider.childCountOverride[1] = count
            assertStopped(count < 0 ? .provider : .nodes) { _ = try frames(provider) }
            XCTAssertTrue(provider.childPages.isEmpty)
        }
    }

    func testShortOversizedAndFailedLaterPagesCannotReturnPartialFrames() throws {
        for delta in [-1, 1] {
            let provider = Provider()
            provider.windows = Array(1...40)
            provider.windowPageDelta = delta
            assertStopped(.provider) { _ = try frames(provider) }
            provider.windowPageDelta = 0
            provider.children[1] = Array(2...41)
            provider.pageDelta = delta
            assertStopped(.provider) { _ = try frames(provider) }
        }
        let provider = Provider()
        provider.children[1] = Array(2...41)
        provider.panes[2] = CGRect(x: 0, y: 0, width: 100, height: 100)
        provider.errors.insert("childPage:1:32")
        assertStopped(.provider) { _ = try frames(provider) }
        XCTAssertTrue(provider.visited.contains(2))
    }

    func testPaneLimitIsStrictAcrossSiblingsAndDoesNotStopAt64WithoutFinishing() throws {
        let provider = Provider()
        provider.children[1] = Array(2...65)
        for element in 2...66 {
            provider.panes[element] = CGRect(x: element * 100, y: 0, width: 100, height: 100)
        }
        XCTAssertEqual(try frames(provider).count, 64)
        provider.children[1]?.append(66)
        assertStopped(.provider) { _ = try frames(provider) }
        provider.children[1] = Array(2...65) + [100]
        provider.errors.insert("subrole:100")
        assertStopped(.provider) { _ = try frames(provider) }
    }

    func testInvalidOrMissingPaneGeometryRefusesInsteadOfIgnoringPane() throws {
        let invalid: [CGRect] = [
            CGRect(x: CGFloat.nan, y: 0, width: 100, height: 100),
            CGRect(x: 0, y: 0, width: CGFloat.infinity, height: 100),
            CGRect(x: 0, y: 0, width: -100, height: 100),
            CGRect(x: CGFloat.greatestFiniteMagnitude, y: 0,
                   width: CGFloat.greatestFiniteMagnitude, height: 100)
        ]
        for frame in invalid {
            let provider = Provider()
            provider.panes[1] = frame
            assertStopped(.provider) { _ = try frames(provider) }
        }
        let provider = Provider()
        provider.panes[1] = CGRect(x: 0, y: 0, width: 100, height: 100)
        provider.missingGeometry.insert(1)
        assertStopped(.provider) { _ = try frames(provider) }
    }

    func testDepthBoundaryAllowsLeavesButRefusesUnvisitedDescendants() throws {
        let provider = Provider()
        var limits = AXEditorPaneDiscovery.limits
        limits.maxDepth = 1
        provider.children[1] = [2]
        XCTAssertEqual(try frames(provider, limits: limits), [])
        provider.children[2] = [3]
        assertStopped(.depth) { _ = try frames(provider, limits: limits) }
        XCTAssertFalse(provider.visited.contains(3))
    }

    func testAggregateNodeCallAndAllocationLimitsStopBeforeUnboundedWork() throws {
        let provider = Provider()
        provider.children = [1: [2, 3], 2: [4, 5]]
        var limits = AXEditorPaneDiscovery.limits
        limits.maxNodes = 3
        assertStopped(.nodes) { _ = try frames(provider, limits: limits) }
        limits = AXEditorPaneDiscovery.limits
        limits.maxAXCalls = 1
        assertStopped(.axCalls) { _ = try frames(provider, limits: limits) }
        limits = AXEditorPaneDiscovery.limits
        limits.maxAllocatedBytes = 1
        provider.windowPages.removeAll()
        assertStopped(.allocation) { _ = try frames(provider, limits: limits) }
        XCTAssertTrue(provider.windowPages.isEmpty)
        limits.maxAllocatedBytes = 100
        provider.subroleOverride = String(repeating: "x", count: 101)
        assertStopped(.allocation) { _ = try frames(provider, limits: limits) }
    }

    func testLateResultsCancellationAndRejectedTimeoutCannotBecomeCompleteLayout() throws {
        let provider = Provider()
        provider.advanceAtSubrole = 2_000_000_000
        assertStopped(.deadline) { _ = try frames(provider) }
        XCTAssertFalse(provider.calls.contains("children:1"))
        provider.cancelled = true
        provider.calls.removeAll()
        assertStopped(.cancelled) { _ = try frames(provider) }
        XCTAssertTrue(provider.calls.isEmpty)
        provider.cancelled = false
        provider.timeoutAccepted = false
        assertStopped(.provider) { _ = try frames(provider) }
        XCTAssertTrue(provider.calls.isEmpty)
    }

    func testDescendantCallsUseRemainingDeadlineAndCompleteSplitRoutesByColumn() throws {
        let provider = Provider()
        provider.children[1] = [2, 3]
        provider.panes = [2: CGRect(x: 0, y: 0, width: 100, height: 100),
                          3: CGRect(x: 100, y: 0, width: 100, height: 100)]
        provider.advanceAtSubrole = 600_000_000
        XCTAssertEqual(try ElectronEditorRouter.column(forPoint: CGPoint(x: 150, y: 50)) {
            try self.frames(provider)
        }, 2)
        XCTAssertEqual(provider.timeouts.last!, 0.2, accuracy: 0.0001)
        provider.children[1]?.append(4)
        assertStopped(.deadline) { _ = try frames(provider) }
    }

    func testRootMustExistAndRetainItsExactIdentity() throws {
        let provider = Provider()
        provider.windows = []
        XCTAssertThrowsError(try frames(provider))
        XCTAssertTrue(provider.visited.isEmpty)
        provider.windows = [1]
        assertStopped(.provider) { _ = try frames(provider, windowID: 0) }
        provider.changedIdentity = true
        assertStopped(.provider) { _ = try frames(provider) }
    }
}
