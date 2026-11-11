import XCTest
import ApplicationServices
import CoreGraphics
@testable import SpaceOKit

final class AXTraversalTests: XCTestCase {
    private func rootWindow(_ id: CGWindowID = 1) -> SpaceOKit.WindowRef {
        SpaceOKit.WindowRef(windowID: id, pid: 42, title: "", frame: .zero)
    }

    private func rootBudget(_ limits: AXTraversalLimits = AXTraversalLimits()) throws -> AXTraversalBudget {
        try AXTraversalBudget(limits: limits, now: { 0 }, isCancelled: { false })
    }

    func testRootWithoutWindowReturnsAppWithoutProviderCalls() throws {
        let provider = FakeAXProvider()
        provider.discoveryCountFails = true
        XCTAssertEqual(try AXTraversal.root(app: 0, window: nil, provider: provider,
                                            budget: rootBudget()), 0)
        XCTAssertTrue(provider.timeouts.isEmpty)
    }

    func testRootPreservesCountPageAndIdentityFailures() throws {
        for operation in ["count", "page", "identity"] {
            for status in [AXError.cannotComplete, .invalidUIElement, .apiDisabled] {
                let provider = FakeAXProvider()
                provider.childCounts[0] = 1
                let statuses = Array(repeating: status, count: status == .cannotComplete ? 3 : 1)
                if operation == "count" { provider.rootCountStatuses = statuses }
                if operation == "page" { provider.rootPageStatuses = statuses }
                if operation == "identity" { provider.identityStatuses = statuses }
                XCTAssertThrowsError(try AXTraversal.root(app: 0, window: rootWindow(),
                    provider: provider, budget: rootBudget())) {
                    XCTAssertEqual(($0 as? AXTraversalStopped)?.reason, .provider)
                    XCTAssertTrue(($0 as? AXTraversalStopped)?.detail.contains("AXError \(status.rawValue)") == true)
                }
                XCTAssertEqual(provider.timeouts.count,
                               (operation == "count" ? 0 : operation == "page" ? 1 : 2) + statuses.count)
            }
        }
    }

    func testRootRecoversTransientFailuresAtEveryStrictOperation() throws {
        let provider = FakeAXProvider()
        provider.childCounts[0] = 2
        provider.rootCountStatuses = [.cannotComplete, .success]
        provider.rootPageStatuses = [.cannotComplete, .success]
        provider.identityStatuses = [.cannotComplete, .success]
        let budget = try rootBudget()
        XCTAssertEqual(try AXTraversal.root(app: 0, window: rootWindow(), provider: provider, budget: budget), 1)
        XCTAssertEqual(budget.axCalls, 6)
        XCTAssertEqual(budget.nodes, 1)
        XCTAssertTrue(provider.timeouts.allSatisfy { $0 <= 0.25 })
        XCTAssertTrue(provider.stringRequests.isEmpty)
        XCTAssertTrue(provider.textRequests.isEmpty)
    }

    func testRootRejectsMalformedCountsPagesAndIdentities() throws {
        for malformed in ["negative", "short", "oversized", "zero", "duplicate"] {
            let provider = FakeAXProvider()
            provider.childCounts[0] = malformed == "negative" ? -1 : 2
            provider.discoveryShortPage = malformed == "short"
            provider.rootOversizedPage = malformed == "oversized"
            if malformed == "zero" { provider.forcedWindowID = 0 }
            if malformed == "duplicate" { provider.forcedWindowID = 7 }
            XCTAssertThrowsError(try AXTraversal.root(app: 0, window: rootWindow(99),
                provider: provider, budget: rootBudget())) {
                XCTAssertEqual(($0 as? AXTraversalStopped)?.reason, .provider)
            }
        }
    }

    func testRootValidEmptyAndMissingListsReportWindowNotFound() throws {
        for count in [0, 2] {
            let provider = FakeAXProvider()
            provider.childCounts[0] = count
            XCTAssertThrowsError(try AXTraversal.root(app: 0, window: rootWindow(99),
                provider: provider, budget: rootBudget())) {
                guard case SpaceOError.windowNotFound = $0 else { return XCTFail("expected windowNotFound: \($0)") }
            }
        }
    }

    func testRootRejectsChangedCountBeforeReportingMissing() throws {
        let provider = FakeAXProvider()
        provider.childCounts[0] = 1
        provider.afterProviderCall = {
            if provider.providerCallCount == 3 { provider.childCounts[0] = 2 }
        }
        XCTAssertThrowsError(try AXTraversal.root(app: 0, window: rootWindow(99),
            provider: provider, budget: rootBudget())) {
            XCTAssertEqual(($0 as? AXTraversalStopped)?.reason, .provider)
        }
    }

    func testRootHonorsDeadlineAndCancellationBeforeReturningHandle() throws {
        for reason in [AXTraversalStopReason.deadline, .cancelled] {
            let provider = FakeAXProvider()
            provider.childCounts[0] = 1
            let clock = TestMonotonicClock()
            var cancelled = false
            let budget = try AXTraversalBudget(limits: AXTraversalLimits(), now: { clock.value },
                                               isCancelled: { cancelled })
            provider.afterProviderCall = {
                if provider.providerCallCount == 3 {
                    if reason == .deadline { clock.advance(by: 3_000_000_000) }
                    else { cancelled = true }
                }
            }
            XCTAssertThrowsError(try AXTraversal.root(app: 0, window: rootWindow(), provider: provider, budget: budget)) {
                XCTAssertEqual(($0 as? AXTraversalStopped)?.reason, reason)
            }
        }
    }

    func testRootHonorsSharedNodeCallAndAllocationCaps() throws {
        for reason in [AXTraversalStopReason.nodes, .axCalls, .allocation] {
            let provider = FakeAXProvider()
            provider.childCounts[0] = reason == .nodes ? Int.max : 1
            var limits = AXTraversalLimits()
            if reason == .axCalls { limits.maxAXCalls = 2; provider.rootCountStatuses = [.cannotComplete, .cannotComplete] }
            if reason == .allocation { limits.maxAllocatedBytes = 1 }
            let budget = try rootBudget(limits)
            XCTAssertThrowsError(try AXTraversal.root(app: 0, window: rootWindow(), provider: provider, budget: budget)) {
                XCTAssertEqual(($0 as? AXTraversalStopped)?.reason, reason)
            }
            if reason == .nodes { XCTAssertTrue(provider.pageRequests.isEmpty) }
            XCTAssertLessThanOrEqual(budget.axCalls, limits.maxAXCalls)
        }
    }

    func testWindowPresenceNeedsOnlyOneCheckedCountRegardlessOfListSize() throws {
        for count in [0, 70, Int.max] {
            let provider = FakeAXProvider()
            provider.childCounts[0] = count
            let budget = try AXTraversalBudget(limits: AXWindowDiscovery.limits(remaining: 1),
                                               now: { 0 }, isCancelled: { false })
            XCTAssertEqual(try AXWindowDiscovery.hasWindows(app: 0, provider: provider, budget: budget), count > 0)
            XCTAssertEqual(provider.providerCallCount, 1)
            XCTAssertTrue(provider.pageRequests.isEmpty)
            XCTAssertTrue(provider.textRequests.isEmpty)
            XCTAssertEqual(budget.allocatedBytes, 0)
            XCTAssertEqual(budget.nodes, 0)
        }
    }

    func testWindowPresenceNeverTurnsFailedOrInvalidCountIntoAbsence() throws {
        for failure in [true, false] {
            let provider = FakeAXProvider()
            provider.discoveryCountFails = failure
            provider.childCounts[0] = -1
            let budget = try AXTraversalBudget(limits: AXWindowDiscovery.limits(remaining: 1),
                                               now: { 0 }, isCancelled: { false })
            XCTAssertThrowsError(try AXWindowDiscovery.hasWindows(app: 0, provider: provider, budget: budget)) {
                XCTAssertEqual(($0 as? AXTraversalStopped)?.reason, .provider)
            }
            XCTAssertTrue(provider.pageRequests.isEmpty)
        }
    }

    func testLaunchPresenceRequiresAResolvedIdentityAndSkipsRemainingDetails() throws {
        for identified in [true, false] {
            let provider = FakeAXProvider()
            provider.childCounts[0] = 70
            if !identified { provider.forcedWindowID = 0 }
            let budget = try AXTraversalBudget(limits: AXWindowDiscovery.limits(remaining: 1),
                                               now: { 0 }, isCancelled: { false })
            XCTAssertEqual(try AXWindowDiscovery.hasIdentifiedWindow(app: 0, provider: provider, budget: budget), identified)
            XCTAssertEqual(provider.providerCallCount, identified ? 3 : 74)
            XCTAssertEqual(provider.pageRequests.map(\.maxValues), identified ? [32] : [32, 32, 6])
            XCTAssertTrue(provider.textRequests.isEmpty)
        }
    }

    func testLaunchPresenceRejectsOversizedAndIncompleteLists() throws {
        for tooLarge in [true, false] {
            let provider = FakeAXProvider()
            provider.childCounts[0] = tooLarge ? Int.max : 2
            provider.discoveryShortPage = !tooLarge
            let budget = try AXTraversalBudget(limits: AXWindowDiscovery.limits(remaining: 1),
                                               now: { 0 }, isCancelled: { false })
            XCTAssertThrowsError(try AXWindowDiscovery.hasIdentifiedWindow(app: 0, provider: provider, budget: budget)) {
                XCTAssertEqual(($0 as? AXTraversalStopped)?.reason, tooLarge ? .nodes : .provider)
            }
        }
    }

    func testLaunchPresenceContinuesPastInvalidIdentitiesIncludingLaterPages() throws {
        for invalidCount in [1, 32] {
            let provider = FakeAXProvider()
            provider.childCounts[0] = invalidCount + 1
            provider.identityStatuses = Array(repeating: .invalidUIElement, count: invalidCount) + [.success]
            let budget = try AXTraversalBudget(limits: AXWindowDiscovery.limits(remaining: 1),
                                               now: { 0 }, isCancelled: { false })
            XCTAssertTrue(try AXWindowDiscovery.hasIdentifiedWindow(app: 0, provider: provider, budget: budget))
            XCTAssertEqual(budget.nodes, invalidCount + 1)
            XCTAssertEqual(provider.providerCallCount, invalidCount + 2 + provider.pageRequests.count)
            XCTAssertEqual(provider.pageRequests.map(\.start), invalidCount == 1 ? [0] : [0, 32])
            XCTAssertTrue(provider.textRequests.isEmpty)
        }
    }

    func testLaunchPresenceDoesNotSkipOtherIdentityProviderFailures() throws {
        for status in [AXError.illegalArgument, .apiDisabled, .notImplemented] {
            let provider = FakeAXProvider()
            provider.childCounts[0] = 2
            provider.identityStatuses = [status, .success]
            let budget = try AXTraversalBudget(limits: AXWindowDiscovery.limits(remaining: 1),
                                               now: { 0 }, isCancelled: { false })
            XCTAssertThrowsError(try AXWindowDiscovery.hasIdentifiedWindow(app: 0, provider: provider, budget: budget)) {
                XCTAssertEqual(($0 as? AXTraversalStopped)?.reason, .provider)
                XCTAssertEqual(($0 as? AXTraversalStopped)?.detail,
                    "incomplete window discovery: window identity is unavailable (AXError \(status.rawValue))")
            }
            XCTAssertEqual(provider.identityStatuses, [.success])
            XCTAssertEqual(budget.nodes, 1)
        }
    }

    func testLaunchPresencePreservesInvalidIdentityFailureWhenNoIDResolves() throws {
        for finalStatus in [AXError.invalidUIElement, .success] {
            let provider = FakeAXProvider()
            provider.childCounts[0] = 2
            provider.identityStatuses = [.invalidUIElement, finalStatus]
            provider.forcedWindowID = 0
            let budget = try AXTraversalBudget(limits: AXWindowDiscovery.limits(remaining: 1),
                                               now: { 0 }, isCancelled: { false })
            XCTAssertThrowsError(try AXWindowDiscovery.hasIdentifiedWindow(app: 0, provider: provider, budget: budget)) {
                XCTAssertEqual(($0 as? AXTraversalStopped)?.reason, .provider)
                XCTAssertEqual(($0 as? AXTraversalStopped)?.detail,
                    "incomplete window discovery: window identity is unavailable (AXError \(AXError.invalidUIElement.rawValue))")
            }
            XCTAssertEqual(provider.providerCallCount, 4)
            XCTAssertEqual(budget.nodes, 2)
        }
    }

    func testLaunchPresenceContinuationHonorsBudgetsAndCancellation() throws {
        for reason in [AXTraversalStopReason.cancelled, .axCalls, .nodes, .deadline, .allocation] {
            let provider = FakeAXProvider()
            provider.childCounts[0] = 2
            provider.identityStatuses = [.invalidUIElement, .success]
            let clock = TestMonotonicClock()
            var cancelled = false
            var limits = try AXWindowDiscovery.limits(remaining: 1)
            limits.childPageSize = 1
            if reason == .axCalls { limits.maxAXCalls = 3 }
            if reason == .nodes { limits.maxNodes = 2 }
            let budget = try AXTraversalBudget(limits: limits, now: { clock.value },
                                               isCancelled: { cancelled })
            provider.afterProviderCall = {
                guard provider.providerCallCount == 3 else { return }
                switch reason {
                case .cancelled: cancelled = true
                case .deadline: clock.advance(by: 1_000_000_000)
                case .nodes: try? budget.consumeNode()
                case .allocation: try? budget.consumeAllocation(limits.maxAllocatedBytes - budget.allocatedBytes)
                default: break
                }
            }
            XCTAssertThrowsError(try AXWindowDiscovery.hasIdentifiedWindow(app: 0, provider: provider, budget: budget)) {
                XCTAssertEqual(($0 as? AXTraversalStopped)?.reason, reason)
            }
            XCTAssertEqual(provider.identityStatuses, [.success])
        }
    }

    func testFullWindowDiscoveryRemainsStrictForMixedIdentityLists() throws {
        for statuses in [[AXError.invalidUIElement, .success], [.success, .invalidUIElement]] {
            let provider = FakeAXProvider()
            provider.childCounts[0] = 2
            provider.identityStatuses = statuses
            XCTAssertThrowsError(try discover(provider)) {
                XCTAssertEqual(($0 as? AXTraversalStopped)?.reason, .provider)
                XCTAssertEqual(($0 as? AXTraversalStopped)?.detail,
                    "incomplete window discovery: window identity is unavailable (AXError \(AXError.invalidUIElement.rawValue))")
            }
        }
    }

    private func discover(_ provider: FakeAXProvider, limits: AXTraversalLimits? = nil,
                          clock: TestMonotonicClock = TestMonotonicClock()) throws -> [SpaceOKit.WindowRef] {
        let budget = try AXTraversalBudget(limits: limits ?? AXWindowDiscovery.limits(remaining: 1),
                                           now: { clock.value }, isCancelled: { false })
        return try AXWindowDiscovery.windows(of: 42, app: 0, provider: provider, budget: budget,
                                              liveBounds: { _ in CGRect(x: 0, y: 0, width: 20, height: 20) })
    }

    func testWindowDiscoveryPagesAndSetsTimeoutOnEveryElement() throws {
        let provider = FakeAXProvider()
        provider.childCounts[0] = 70
        let windows = try discover(provider)
        XCTAssertEqual(windows.map(\.windowID), Array(1...70).map { CGWindowID($0) })
        XCTAssertEqual(provider.pageRequests.map(\.maxValues), [32, 32, 6])
        XCTAssertEqual(windows.last?.title, "Node 70")
        XCTAssertEqual(provider.providerCallCount, 145)
        XCTAssertEqual(Set(provider.timeoutElements), Set(0...70))
        XCTAssertTrue(provider.timeouts.allSatisfy { $0 > 0 && $0 <= 0.25 })
    }

    func testWindowDiscoveryRejectsHugeCountsBeforeCopyingAnyPage() throws {
        let provider = FakeAXProvider()
        provider.childCounts[0] = Int.max
        XCTAssertThrowsError(try discover(provider)) {
            XCTAssertEqual(($0 as? AXTraversalStopped)?.reason, .nodes)
        }
        XCTAssertTrue(provider.pageRequests.isEmpty)
        XCTAssertEqual(provider.providerCallCount, 1)
    }

    func testWindowDiscoveryRefusesFailedAndShortPagesInsteadOfEmptySuccess() throws {
        for mode in 0...2 {
            let provider = FakeAXProvider()
            provider.childCounts[0] = 2
            provider.discoveryCountFails = mode == 0
            provider.discoveryPageFails = mode == 1
            provider.discoveryShortPage = mode == 2
            XCTAssertThrowsError(try discover(provider)) {
                XCTAssertEqual(($0 as? AXTraversalStopped)?.reason, .provider)
            }
        }
        XCTAssertEqual(try discover(FakeAXProvider()), [], "a successful zero count remains an empty list")
    }

    func testWindowDiscoveryDeadlineAndAllocationFailWithoutPublishingPartialResults() throws {
        let provider = FakeAXProvider()
        provider.childCounts[0] = 2
        let clock = TestMonotonicClock()
        provider.afterProviderCall = { clock.advance(by: 10_000_000) }
        XCTAssertThrowsError(try discover(provider, limits: AXWindowDiscovery.limits(remaining: 0.025), clock: clock)) {
            XCTAssertEqual(($0 as? AXTraversalStopped)?.reason, .deadline)
        }
        XCTAssertEqual(provider.providerCallCount, 3)
        let largeTitle = FakeAXProvider()
        largeTitle.childCounts[0] = 1
        largeTitle.textAttributes[1] = [kAXTitleAttribute as String: String(repeating: "x", count: 1024)]
        var limits = try AXWindowDiscovery.limits(remaining: 1)
        limits.maxAllocatedBytes = 100
        XCTAssertThrowsError(try discover(largeTitle, limits: limits)) {
            XCTAssertEqual(($0 as? AXTraversalStopped)?.reason, .allocation)
        }
    }

    func testWindowDiscoverySharesWindowBudgetAcrossApps() throws {
        let provider = FakeAXProvider()
        provider.childCounts[0] = 2
        var limits = try AXWindowDiscovery.limits(remaining: 1)
        limits.maxNodes = 3
        let budget = try AXTraversalBudget(limits: limits, now: { 0 }, isCancelled: { false })
        let bounds: (CGWindowID) -> CGRect? = { _ in CGRect(x: 0, y: 0, width: 20, height: 20) }
        _ = try AXWindowDiscovery.windows(of: 42, app: 0, provider: provider, budget: budget, liveBounds: bounds)
        XCTAssertThrowsError(try AXWindowDiscovery.windows(of: 43, app: 0, provider: provider, budget: budget, liveBounds: bounds)) {
            XCTAssertEqual(($0 as? AXTraversalStopped)?.reason, .nodes)
        }
        XCTAssertEqual(provider.pageRequests.count, 1)
    }

    func testWindowDiscoveryCancellationStartsNoProviderCalls() throws {
        let provider = FakeAXProvider()
        provider.childCounts[0] = 2
        let budget = try AXTraversalBudget(limits: AXWindowDiscovery.limits(remaining: 1),
                                           now: { 0 }, isCancelled: { true })
        XCTAssertThrowsError(try AXWindowDiscovery.windows(of: 42, app: 0, provider: provider,
            budget: budget, liveBounds: { _ in nil })) {
            XCTAssertEqual(($0 as? AXTraversalStopped)?.reason, .cancelled)
        }
        XCTAssertEqual(provider.providerCallCount, 0)
    }

    func testCaptureDiscoverySkipsTitlesAndTheirAllocation() throws {
        let provider = FakeAXProvider()
        provider.childCounts[0] = 70
        provider.textAttributes[1] = [kAXTitleAttribute as String: String(repeating: "x", count: 3 * 1024 * 1024)]
        let budget = try AXTraversalBudget(limits: AXWindowDiscovery.limits(remaining: 1),
                                           now: { 0 }, isCancelled: { false })
        let windows = try AXWindowDiscovery.windows(of: 42, app: 0, provider: provider,
            budget: budget, liveBounds: { _ in CGRect(x: 0, y: 0, width: 20, height: 20) }, includeTitles: false)
        XCTAssertEqual(windows.count, 70)
        XCTAssertTrue(windows.allSatisfy { $0.title.isEmpty })
        XCTAssertTrue(provider.textRequests.isEmpty)
        XCTAssertEqual(provider.providerCallCount, 75, "two counts, three pages, and 70 identities; no title calls")
        XCTAssertLessThan(budget.allocatedBytes, 32_000)
    }

    func testDiscoveryRetainsHandlesOnlyWhenRequestedWithoutExtraProviderCalls() throws {
        for retain in [false, true] {
            let provider = FakeAXProvider()
            provider.childCounts[0] = 70
            let budget = try AXTraversalBudget(limits: AXWindowDiscovery.limits(remaining: 1),
                                               now: { 0 }, isCancelled: { false })
            let result = try AXWindowDiscovery.discover(of: 42, app: 0, provider: provider, budget: budget,
                liveBounds: { _ in CGRect(x: 0, y: 0, width: 20, height: 20) }, retainingElements: retain)
            XCTAssertEqual(result.windows.count, 70)
            XCTAssertEqual(result.elements.count, retain ? 70 : 0)
            if retain { XCTAssertEqual(result.elements[70], 70) }
            XCTAssertEqual(provider.providerCallCount, 145)
            XCTAssertEqual(provider.pageRequests.map(\.maxValues), [32, 32, 6])
        }
    }

    func testWatcherMovesReuseOnePagedDiscoveryWithOptionalTitles() {
        for includeTitles in [false, true] {
            let provider = FakeAXProvider()
            provider.childCounts[0] = 70
            if !includeTitles {
                provider.textAttributes[1] = [kAXTitleAttribute as String: String(repeating: "x", count: 3 * 1024 * 1024)]
            }
            var discoveries = 0
            var allocatedBytes = 0
            var handles: [Int] = []
            var moved = Set<CGWindowID>()
            var titles: [String] = []
            let driver = WindowWatcherDriver(pid: 42, validate: {}, discover: { budget in
                discoveries += 1
                let result = try AXWindowDiscovery.discover(of: 42, app: 0, provider: provider, budget: budget,
                    liveBounds: { _ in CGRect(x: 2000, y: 0, width: 200, height: 100) },
                    includeTitles: includeTitles, retainingElements: true)
                allocatedBytes = budget.allocatedBytes
                return result
            }, isContained: { id, _ in moved.contains(id) }, move: { window, handle, target in
                handles.append(handle)
                XCTAssertEqual(CGWindowID(handle), window.windowID)
                moved.insert(window.windowID)
                return target
            })
            let callback: WindowWatcher.Placement? = includeTitles ? { titles.append($0.title) } : nil
            let watcher = WindowWatcher(testingPID: 42,
                region: { CGRect(x: 0, y: 0, width: 800, height: 600) }, onPlaced: callback, driver: driver)
            watcher.sweep()
            XCTAssertNil(watcher.sweepFailure)
            XCTAssertEqual(watcher.placedCount, 70)
            XCTAssertEqual(watcher.refusedCount, 0)
            XCTAssertEqual(discoveries, 1)
            XCTAssertEqual(handles, Array(1...70))
            XCTAssertEqual(provider.providerCallCount, includeTitles ? 145 : 75)
            XCTAssertEqual(provider.pageRequests.map(\.maxValues), [32, 32, 6])
            XCTAssertEqual(provider.textRequests.count, includeTitles ? 70 : 0)
            XCTAssertEqual(titles, includeTitles ? (1...70).map { "Node \($0)" } : [])
            XCTAssertLessThan(allocatedBytes, 32_000)
        }
    }

    func testBusyWindowProviderRetriesChargeEachCallAndRefreshTimeout() throws {
        let provider = FakeAXProvider()
        let clock = TestMonotonicClock()
        let budget = try AXTraversalBudget(limits: AXWindowDiscovery.limits(remaining: 0.2),
                                           now: { clock.value }, isCancelled: { false })
        var calls = 0
        let value: Int = try AXWindowDiscovery.boundedProviderCall(0, provider: provider,
            budget: budget, pause: { clock.advance(by: UInt64($0) * 1_000) }) {
                calls += 1
                if calls < 3 {
                    throw AXWindowDiscovery.ProviderFailure(status: .cannotComplete, operation: "window count")
                }
                return 7
            }
        XCTAssertEqual(value, 7)
        XCTAssertEqual(budget.axCalls, 3)
        XCTAssertEqual(provider.timeouts.count, 3)
        for (actual, expected) in zip(provider.timeouts, [Float(0.2), 0.16, 0.12]) {
            XCTAssertEqual(actual, expected, accuracy: 0.00001)
        }
    }

    func testWindowProviderRetryStopsAtDeadlineCallBudgetAndCancellation() throws {
        for mode in ["deadline", "calls", "cancelled"] {
            let provider = FakeAXProvider()
            let clock = TestMonotonicClock()
            var cancelled = false
            var limits = try AXWindowDiscovery.limits(remaining: 0.025)
            if mode == "calls" { limits.maxAXCalls = 1 }
            let budget = try AXTraversalBudget(limits: limits, now: { clock.value },
                                               isCancelled: { cancelled })
            var calls = 0
            XCTAssertThrowsError(try AXWindowDiscovery.boundedProviderCall(0, provider: provider,
                budget: budget, pause: { duration in
                    XCTAssertLessThanOrEqual(duration, 25_000)
                    if mode == "deadline" { clock.advance(by: UInt64(duration) * 1_000) }
                }) { () -> Int in
                    calls += 1
                    if mode == "cancelled" { cancelled = true }
                    throw AXWindowDiscovery.ProviderFailure(status: .cannotComplete, operation: "window page")
                }) {
                    let expected: AXTraversalStopReason = mode == "deadline" ? .deadline
                        : mode == "calls" ? .axCalls : .cancelled
                    XCTAssertEqual(($0 as? AXTraversalStopped)?.reason, expected)
                }
            XCTAssertEqual(calls, 1)
            XCTAssertEqual(budget.axCalls, 1)
        }
    }

    func testWindowProviderRetriesOnlyTransientFailuresAndNeverBeyondThreeCalls() throws {
        for status in [AXError.cannotComplete, .apiDisabled] {
            let provider = FakeAXProvider()
            let budget = try AXTraversalBudget(limits: AXWindowDiscovery.limits(remaining: 1),
                                               now: { 0 }, isCancelled: { false })
            var calls = 0
            var pauses = 0
            XCTAssertThrowsError(try AXWindowDiscovery.boundedProviderCall(0, provider: provider,
                budget: budget, pause: { _ in pauses += 1 }) { () -> Int in
                    calls += 1
                    throw AXWindowDiscovery.ProviderFailure(status: status, operation: "window count")
                }) {
                    XCTAssertEqual(($0 as? AXTraversalStopped)?.reason, .provider)
                }
            XCTAssertEqual(calls, status == .cannotComplete ? 3 : 1)
            XCTAssertEqual(pauses, status == .cannotComplete ? 2 : 0)
        }
    }

    func testWindowDiscoveryRejectsGrowthAndShrinkageAfterPaging() throws {
        for finalCount in [0, 2] {
            let provider = FakeAXProvider()
            provider.childCounts[0] = 1
            let budget = try AXTraversalBudget(limits: AXWindowDiscovery.limits(remaining: 1),
                                               now: { 0 }, isCancelled: { false })
            XCTAssertThrowsError(try AXWindowDiscovery.discover(of: 42, app: 0,
                provider: provider, budget: budget, liveBounds: { _ in
                    provider.childCounts[0] = finalCount
                    return CGRect(x: 0, y: 0, width: 20, height: 20)
                }, retainingElements: true)) {
                XCTAssertEqual(($0 as? AXTraversalStopped)?.reason, .provider)
                XCTAssertEqual(($0 as? AXTraversalStopped)?.detail,
                    "incomplete window discovery: window list changed during discovery")
            }
        }
    }

    func testWindowDiscoveryRejectsUnavailableFinalCount() throws {
        let provider = FakeAXProvider()
        provider.childCounts[0] = 1
        let budget = try AXTraversalBudget(limits: AXWindowDiscovery.limits(remaining: 1),
                                           now: { 0 }, isCancelled: { false })
        XCTAssertThrowsError(try AXWindowDiscovery.windows(of: 42, app: 0,
            provider: provider, budget: budget, liveBounds: { _ in
                provider.discoveryCountFails = true
                return CGRect(x: 0, y: 0, width: 20, height: 20)
            })) {
            XCTAssertEqual(($0 as? AXTraversalStopped)?.reason, .provider)
        }
    }

    func testWindowDiscoveryRejectsMissingAndRepeatedIdentities() throws {
        for id: CGWindowID in [0, 1] {
            let provider = FakeAXProvider()
            provider.childCounts[0] = 2
            provider.forcedWindowID = id
            XCTAssertThrowsError(try discover(provider)) {
                XCTAssertEqual(($0 as? AXTraversalStopped)?.reason, .provider)
                XCTAssertEqual(($0 as? AXTraversalStopped)?.detail,
                    "incomplete window discovery: window identity is " + (id == 0 ? "unavailable" : "repeated"))
            }
        }
    }

    func testWindowDiscoveryPreservesIdentityProviderErrors() throws {
        for status in [AXError.invalidUIElement, .apiDisabled, .notImplemented] {
            let provider = FakeAXProvider()
            provider.childCounts[0] = 1
            provider.identityStatuses = [status]
            XCTAssertThrowsError(try discover(provider)) {
                XCTAssertEqual(($0 as? AXTraversalStopped)?.reason, .provider)
                XCTAssertEqual(($0 as? AXTraversalStopped)?.detail,
                    "incomplete window discovery: window identity is unavailable (AXError \(status.rawValue))")
            }
            XCTAssertEqual(provider.providerCallCount, 3, "permanent identity failures are not retried")
            XCTAssertTrue(provider.textRequests.isEmpty)
        }
    }

    func testWindowDiscoveryRecoversBusyIdentityWithoutPublishingZero() throws {
        let provider = FakeAXProvider()
        provider.childCounts[0] = 1
        provider.identityStatuses = [.cannotComplete, .success]
        XCTAssertEqual(try discover(provider).map(\.windowID), [1])
        XCTAssertEqual(provider.providerCallCount, 6,
            "count, page, two identity calls, title, and final count")
    }

    func testReadinessCannotTreatAnIdentityProviderErrorAsAnEmptyWindowList() throws {
        let provider = FakeAXProvider()
        provider.childCounts[0] = 1
        provider.identityStatuses = [.invalidUIElement]
        let budget = try AXTraversalBudget(limits: AXWindowDiscovery.limits(remaining: 1),
                                           now: { 0 }, isCancelled: { false })
        XCTAssertThrowsError(try AXWindowDiscovery.hasIdentifiedWindow(app: 0,
            provider: provider, budget: budget)) {
            XCTAssertEqual(($0 as? AXTraversalStopped)?.reason, .provider)
        }
    }

    func testWaitRemainderBoundsTraversalAndEveryProviderCall() throws {
        let provider = FakeAXProvider()
        let clock = TestMonotonicClock()
        provider.afterProviderCall = { clock.advance(by: 10_000_000) }
        let limits = try WaitPolicy.axTraversalLimits(remaining: 0.025)
        let budget = try AXTraversalBudget(limits: limits, now: { clock.value }, isCancelled: { false })
        let output = try AXTraversal.walk(root: 0, provider: provider, budget: budget, keepPartial: true)
        XCTAssertEqual(output.truncatedBy, .deadline)
        XCTAssertEqual(provider.providerCallCount, 3, "must stop within the wait's remainder, not the ordinary three seconds")
        XCTAssertEqual(provider.timeouts.count, 3)
        for (actual, expected) in zip(provider.timeouts, [Float(0.025), 0.015, 0.005]) {
            XCTAssertEqual(actual, expected, accuracy: 0.00001)
        }
        let identity = try XCTUnwrap(ProcessIdentity.current(of: getpid()))
        let snapshot = AXSnapshot(pid: identity.pid, windowID: 1, processIdentity: identity,
            generation: UUID(), nodes: output.nodes, elements: [:], truncatedBy: output.truncatedBy)
        guard case .notYet = snapshot.waitProbe(.elementGone("Missing")) else {
            return XCTFail("deadline-limited data cannot prove absence")
        }
    }

    func testWaitRemainderPreservesOtherAXSafetyLimits() throws {
        let defaults = AXTraversalLimits()
        XCTAssertEqual(try WaitPolicy.axTraversalLimits(remaining: nil), defaults)
        XCTAssertEqual(try WaitPolicy.axTraversalLimits(remaining: 60), defaults)
        var expected = defaults
        expected.timeout = 0.1
        expected.maxCallDuration = 0.1
        XCTAssertEqual(try WaitPolicy.axTraversalLimits(remaining: 0.1), expected)
        let minimum = try WaitPolicy.axTraversalLimits(remaining: 0.01)
        XCTAssertNoThrow(try minimum.validate())
    }

    func testExhaustedWaitBudgetCannotStartATraversal() throws {
        for remaining in [-1.0, 0, 0.009] {
            XCTAssertThrowsError(try WaitPolicy.axTraversalLimits(remaining: remaining)) {
                XCTAssertTrue($0 is WaitProbeDeadlineExceeded)
            }
        }
        for remaining in [Double.nan, .infinity, -.infinity] {
            XCTAssertThrowsError(try WaitPolicy.axTraversalLimits(remaining: remaining)) {
                XCTAssertEqual(($0 as? SpaceOError)?.code, "bad_request")
            }
        }
    }

    func testOversizedChildrenArePagedAndStopAtNodeBudget() throws {
        let provider = FakeAXProvider()
        provider.childCounts[0] = 10_000
        let clock = TestMonotonicClock()
        let limits = AXTraversalLimits(
            maxDepth: 8,
            maxNodes: 5,
            timeout: 1,
            maxAXCalls: 100,
            maxAllocatedBytes: 1_024 * 1_024,
            childPageSize: 3,
            maxCallDuration: 0.1)
        let budget = try AXTraversalBudget(
            limits: limits, now: { clock.value }, isCancelled: { false })

        XCTAssertThrowsError(
            try AXTraversal.walk(root: 0, provider: provider, budget: budget)
        ) { error in
            XCTAssertEqual((error as? AXTraversalStopped)?.reason, .nodes)
        }

        XCTAssertEqual(provider.pageRequests.map(\.maxValues), [3, 1])
        XCTAssertTrue(provider.pageRequests.allSatisfy { $0.maxValues <= limits.childPageSize })
        XCTAssertFalse(provider.pageRequests.contains { $0.maxValues == 10_000 })
        XCTAssertEqual(budget.nodes, limits.maxNodes)
    }

    func testDelayedProviderStopsAtMonotonicDeadline() throws {
        let provider = FakeAXProvider()
        let clock = TestMonotonicClock()
        provider.afterProviderCall = { clock.advance(by: 6_000_000) }
        let limits = AXTraversalLimits(
            maxDepth: 8,
            maxNodes: 100,
            timeout: 0.020,
            maxAXCalls: 100,
            maxAllocatedBytes: 1_024 * 1_024,
            childPageSize: 8,
            maxCallDuration: 0.010)
        let budget = try AXTraversalBudget(
            limits: limits, now: { clock.value }, isCancelled: { false })

        XCTAssertThrowsError(
            try AXTraversal.walk(root: 0, provider: provider, budget: budget)
        ) { error in
            XCTAssertEqual((error as? AXTraversalStopped)?.reason, .deadline)
        }

        XCTAssertLessThanOrEqual(provider.providerCallCount, 4)
        XCTAssertGreaterThanOrEqual(clock.value, 20_000_000)
    }

    func testAXCallBudgetStopsBeforeAnotherProviderCall() throws {
        let provider = FakeAXProvider()
        let clock = TestMonotonicClock()
        let limits = AXTraversalLimits(
            maxDepth: 8,
            maxNodes: 100,
            timeout: 1,
            maxAXCalls: 2,
            maxAllocatedBytes: 1_024 * 1_024,
            childPageSize: 8,
            maxCallDuration: 0.1)
        let budget = try AXTraversalBudget(
            limits: limits, now: { clock.value }, isCancelled: { false })

        XCTAssertThrowsError(
            try AXTraversal.walk(root: 0, provider: provider, budget: budget)
        ) { error in
            XCTAssertEqual((error as? AXTraversalStopped)?.reason, .axCalls)
        }
        XCTAssertEqual(provider.providerCallCount, limits.maxAXCalls)
    }

    func testAggregateAllocationBudgetStopsTraversal() throws {
        let provider = FakeAXProvider()
        let clock = TestMonotonicClock()
        let limits = AXTraversalLimits(
            maxDepth: 8,
            maxNodes: 100,
            timeout: 1,
            maxAXCalls: 100,
            maxAllocatedBytes: 1,
            childPageSize: 8,
            maxCallDuration: 0.1)
        let budget = try AXTraversalBudget(
            limits: limits, now: { clock.value }, isCancelled: { false })

        XCTAssertThrowsError(
            try AXTraversal.walk(root: 0, provider: provider, budget: budget)
        ) { error in
            XCTAssertEqual((error as? AXTraversalStopped)?.reason, .allocation)
        }
        XCTAssertEqual(budget.nodes, 1)
    }

    func testCancellationIsCheckedBetweenProviderCalls() throws {
        let provider = FakeAXProvider()
        let clock = TestMonotonicClock()
        let limits = AXTraversalLimits(
            maxDepth: 8,
            maxNodes: 100,
            timeout: 1,
            maxAXCalls: 100,
            maxAllocatedBytes: 1_024 * 1_024,
            childPageSize: 8,
            maxCallDuration: 0.1)
        let budget = try AXTraversalBudget(
            limits: limits,
            now: { clock.value },
            isCancelled: { provider.providerCallCount >= 2 })

        XCTAssertThrowsError(
            try AXTraversal.walk(root: 0, provider: provider, budget: budget)
        ) { error in
            XCTAssertEqual((error as? AXTraversalStopped)?.reason, .cancelled)
        }
        XCTAssertEqual(provider.providerCallCount, 2)
    }

    func testEveryDescendantCallReceivesABoundedTimeout() throws {
        let provider = FakeAXProvider()
        provider.childCounts[0] = 1
        let clock = TestMonotonicClock()
        let limits = AXTraversalLimits(
            maxDepth: 8,
            maxNodes: 2,
            timeout: 1,
            maxAXCalls: 100,
            maxAllocatedBytes: 1_024 * 1_024,
            childPageSize: 8,
            maxCallDuration: 0.075)
        let budget = try AXTraversalBudget(
            limits: limits, now: { clock.value }, isCancelled: { false })

        let output = try AXTraversal.walk(root: 0, provider: provider, budget: budget)

        XCTAssertEqual(output.nodes.count, 2)
        XCTAssertTrue(provider.timeoutElements.contains(0))
        XCTAssertTrue(provider.timeoutElements.contains(1))
        XCTAssertTrue(provider.timeouts.allSatisfy { $0 > 0 && $0 <= 0.0751 })
    }

    func testProviderThatRejectsTimeoutIsNeverCalledUnbounded() throws {
        let provider = FakeAXProvider()
        provider.acceptsMessagingTimeout = false
        let clock = TestMonotonicClock()
        let budget = try AXTraversalBudget(
            limits: AXTraversalLimits(),
            now: { clock.value },
            isCancelled: { false })

        XCTAssertThrowsError(
            try AXTraversal.walk(root: 0, provider: provider, budget: budget)
        ) { error in
            XCTAssertEqual((error as? AXTraversalStopped)?.reason, .provider)
        }
        XCTAssertEqual(provider.providerCallCount, 0)
        XCTAssertEqual(provider.timeoutElements, [0])
    }

    func testDistinctAccessibilityValueSurvivesAnEarlierDescription() throws {
        let provider = FakeAXProvider()
        provider.stringAttributes[0] = [
            kAXRoleAttribute as String: kAXStaticTextRole as String,
            kAXTitleAttribute as String: "",
            kAXDescriptionAttribute as String: "Edit field",
            kAXValueAttribute as String: "63",
        ]
        provider.actionLists[0] = []
        let clock = TestMonotonicClock()
        let budget = try AXTraversalBudget(
            limits: AXTraversalLimits(),
            now: { clock.value },
            isCancelled: { false })

        let output = try AXTraversal.walk(root: 0, provider: provider, budget: budget)

        XCTAssertEqual(output.nodes.first?.label, "Edit field · value: 63")
        XCTAssertNil(output.nodes.first?.index,
                     "reading a static value must not make the node actionable")
    }

    func testDuplicateAccessibilityValueIsNotRepeated() throws {
        let provider = FakeAXProvider()
        provider.stringAttributes[0] = [
            kAXTitleAttribute as String: "Ready",
            kAXValueAttribute as String: "Ready",
        ]
        let clock = TestMonotonicClock()
        let budget = try AXTraversalBudget(
            limits: AXTraversalLimits(),
            now: { clock.value },
            isCancelled: { false })

        let output = try AXTraversal.walk(root: 0, provider: provider, budget: budget)

        XCTAssertEqual(output.nodes.first?.label, "Ready")
    }

    func testComposedAccessibilityLabelKeepsNameAndValueInsideByteLimit() throws {
        let provider = FakeAXProvider()
        provider.stringAttributes[0] = [
            kAXTitleAttribute as String: String(repeating: "name", count: 200),
            kAXValueAttribute as String: String(repeating: "value", count: 200),
        ]
        let clock = TestMonotonicClock()
        let budget = try AXTraversalBudget(
            limits: AXTraversalLimits(),
            now: { clock.value },
            isCancelled: { false })

        let output = try AXTraversal.walk(root: 0, provider: provider, budget: budget)
        let label = try XCTUnwrap(output.nodes.first?.label)

        XCTAssertLessThanOrEqual(label.utf8.count, AXTraversal.maximumLabelBytes)
        XCTAssertTrue(label.hasPrefix("name"))
        XCTAssertTrue(label.contains(" · value: value"))
    }

    func testSecureTextFieldValueIsNeverIncluded() throws {
        let provider = FakeAXProvider()
        provider.stringAttributes[0] = [
            kAXRoleAttribute as String: kAXTextFieldRole as String,
            kAXSubroleAttribute as String: "AXSecureTextField",
            kAXTitleAttribute as String: "Password",
            kAXValueAttribute as String: "do-not-return-this",
        ]
        let clock = TestMonotonicClock()
        let budget = try AXTraversalBudget(
            limits: AXTraversalLimits(),
            now: { clock.value },
            isCancelled: { false })

        let output = try AXTraversal.walk(root: 0, provider: provider, budget: budget)

        XCTAssertEqual(output.nodes.first?.label, "Password")
    }

    func testClippingEvidenceTracksActualShorteningOfNamesAndValues() throws {
        let limit = AXTraversal.maximumLabelBytes
        let fixtures: [(name: String, value: String, truncated: Bool)] = [
            ("Open…", "", false),
            ("Status", "Loading…", false),
            ("Ready…", "Ready…", false),
            (String(repeating: "a", count: limit), "", false),
            ("", String(repeating: "a", count: limit), false),
            (String(repeating: "a", count: limit + 1), "", true),
            ("", String(repeating: "a", count: limit + 1), true),
            (String(repeating: "a", count: 240), String(repeating: "b", count: 240), true),
            (String(repeating: "a", count: limit + 1), "short", true),
            ("short", String(repeating: "👩🏽‍💻", count: 100), true),
            // AX.string's provider-level cap is much larger than the retained label cap;
            // its already-shortened return must still leave explicit clipping evidence.
            ("", String(repeating: "a", count: 32_768) + "…", true),
        ]
        for fixture in fixtures {
            let provider = FakeAXProvider()
            provider.stringAttributes[0] = [
                kAXTitleAttribute as String: fixture.name,
                kAXDescriptionAttribute as String: "",
                kAXHelpAttribute as String: "",
                kAXPlaceholderValueAttribute as String: "",
                kAXValueAttribute as String: fixture.value,
            ]
            let budget = try AXTraversalBudget(
                limits: AXTraversalLimits(), now: { 0 }, isCancelled: { false })
            let output = try AXTraversal.walk(root: 0, provider: provider, budget: budget)
            let node = try XCTUnwrap(output.nodes.first)
            XCTAssertEqual(node.labelTruncated, fixture.truncated)
            XCTAssertLessThanOrEqual(node.label.utf8.count, limit)
        }
    }
    func testPartialSnapshotPublishesOnlyHandlesWhoseNodesFitTheBudget() throws {
        let provider = FakeAXProvider()
        provider.childCounts[0] = 1
        let budget = try textBudget(AXTraversalLimits(maxAllocatedBytes: 450))
        let snapshot = try AXTraversal.walk(root: 0, provider: provider, budget: budget, keepPartial: true)
        XCTAssertEqual(snapshot.truncatedBy, .allocation)
        XCTAssertEqual(snapshot.nodes.count, 1)
        XCTAssertEqual(Set(snapshot.elements.keys), Set(snapshot.nodes.compactMap(\.index)))
        XCTAssertEqual(snapshot.elements.count, 1)
    }

    func testSnapshotAndFirstTextDoNotRevisitCycles() throws {
        let provider = FakeAXProvider()
        provider.childCounts[0] = 1
        provider.childCounts[1] = 1
        let snapshotBudget = try textBudget()
        let snapshot = try AXTraversal.walk(root: 0, provider: provider, budget: snapshotBudget)
        XCTAssertEqual(snapshot.nodes.count, 2)
        XCTAssertEqual(snapshot.elements.count, 2)
        XCTAssertEqual(snapshotBudget.nodes, 2)
        XCTAssertNil(snapshot.truncatedBy)

        let searchBudget = try textBudget()
        XCTAssertNil(try AXTraversal.firstText(root: 0, provider: provider, budget: searchBudget,
                                               roles: ["AXTextArea"]))
        XCTAssertEqual(searchBudget.nodes, 2)
    }

    func testSnapshotDepthLimitIsReportedOnlyWhenDescendantsAreOmitted() throws {
        let provider = FakeAXProvider()
        let leaf = try AXTraversal.walk(root: 0, provider: provider,
                                       budget: textBudget(AXTraversalLimits(maxDepth: 0)))
        XCTAssertNil(leaf.truncatedBy)
        provider.childCounts[0] = 1
        let partial = try AXTraversal.walk(root: 0, provider: provider,
                                          budget: textBudget(AXTraversalLimits(maxDepth: 0)))
        XCTAssertEqual(partial.nodes.count, 1)
        XCTAssertEqual(partial.truncatedBy, .depth)
        XCTAssertTrue(provider.pageRequests.isEmpty)
    }

    private func textBudget(_ limits: AXTraversalLimits = AXTraversalLimits()) throws -> AXTraversalBudget {
        try AXTraversalBudget(limits: limits, now: { 0 }, isCancelled: { false })
    }

    func testTextReadsBypassOutlineAttributeClipping() throws {
        let provider = FakeAXProvider()
        let value = String(repeating: "😀", count: 10_000)
        provider.stringAttributes[0] = [kAXRoleAttribute as String: "AXTextArea",
                                        kAXValueAttribute as String: String(value.prefix(8192)) + "…"]
        provider.textAttributes[0] = [kAXValueAttribute as String: value]
        let whole = try AXTraversal.allText(root: 0, provider: provider, budget: textBudget(), maxChars: 20_000)
        XCTAssertEqual(whole.text, value)
        XCTAssertFalse(whole.truncated)
        for limit in [1, 9_000, 10_000, 20_000] {
            let read = try AXTraversal.textAttribute(element: 0, attribute: kAXValueAttribute as String,
                provider: provider, budget: textBudget(), maxChars: limit, maximumBytes: 80_000)
            XCTAssertEqual(read.text, String(value.prefix(limit)))
            XCTAssertEqual(read.truncated, limit < 10_000)
        }
        XCTAssertEqual(AX.stringValue(value as CFString), value)
    }

    func testCompleteTextNeverReturnsAnOversizedPrefix() throws {
        let provider = FakeAXProvider()
        provider.textAttributes[0] = [kAXSelectedTextAttribute as String: "é😀"]
        for cap in [5, 6] {
            let read = try AXTraversal.textAttribute(element: 0, attribute: kAXSelectedTextAttribute as String,
                provider: provider, budget: textBudget(), maxChars: nil, maximumBytes: cap)
            XCTAssertEqual(read.text, cap == 6 ? "é😀" : "")
            XCTAssertEqual(read.truncated, cap < 6)
        }
    }

    func testTextRequiresKnownValueForAppendAndRefusesSecureFields() throws {
        let provider = FakeAXProvider()
        XCTAssertThrowsError(try AXTraversal.textAttribute(element: 0, attribute: kAXValueAttribute as String,
            provider: provider, budget: textBudget(), maxChars: nil, maximumBytes: 32_000, requireValue: true))
        for role in ["AXSecureTextField", "AXTextField"] {
            provider.stringAttributes[0] = [kAXRoleAttribute as String: role,
                                            kAXSubroleAttribute as String: "AXSecureTextField"]
            provider.textAttributes[0] = [kAXValueAttribute as String: "secret"]
            let before = provider.textRequests.count
            XCTAssertThrowsError(try AXTraversal.textAttribute(element: 0, attribute: kAXValueAttribute as String,
                provider: provider, budget: textBudget(), maxChars: 200, maximumBytes: 4096))
            XCTAssertEqual(provider.textRequests.count, before)
        }
    }

    func testTextBudgetExhaustionIsPartialAndInvalidLimitsAvoidProviderCalls() throws {
        let provider = FakeAXProvider()
        provider.textAttributes[0] = [kAXValueAttribute as String: "example"]
        let partial = try AXTraversal.textAttribute(element: 0, attribute: kAXValueAttribute as String,
            provider: provider, budget: textBudget(AXTraversalLimits(maxAXCalls: 1)),
            maxChars: 200, maximumBytes: 4096)
        XCTAssertEqual(partial.text, "")
        XCTAssertTrue(partial.truncated)
        let before = provider.providerCallCount
        XCTAssertThrowsError(try AXTraversal.textAttribute(element: 0, attribute: kAXValueAttribute as String,
            provider: provider, budget: textBudget(), maxChars: 0, maximumBytes: 4096))
        XCTAssertEqual(provider.providerCallCount, before)
        XCTAssertTrue(provider.pageRequests.isEmpty)
    }

    func testAllTextReadsFullValuesInsteadOfClippedOutlineLabels() throws {
        let provider = FakeAXProvider()
        let value = String(repeating: "document ", count: 200)
        provider.stringAttributes[0] = [kAXRoleAttribute as String: "AXTextArea",
                                        kAXTitleAttribute as String: "Document",
                                        kAXValueAttribute as String: value]
        let read = try AXTraversal.allText(root: 0, provider: provider,
                                          budget: textBudget(), maxChars: 20_000)
        XCTAssertEqual(read.text, value)
        XCTAssertFalse(read.truncated)
        XCTAssertEqual(provider.providerCallCount, 3, "only role, value, and child count are needed")
    }

    func testAllTextStopsAfterEnoughTextWithoutWalkingTheRemainingTree() throws {
        func fixture() -> FakeAXProvider {
            let provider = FakeAXProvider()
            provider.stringAttributes[0] = [kAXRoleAttribute as String: "AXGroup"]
            provider.childCounts[0] = 100
            for id in 1...100 {
                provider.stringAttributes[id] = [kAXRoleAttribute as String: "AXStaticText",
                                                  kAXValueAttribute as String: String(repeating: "x", count: 100)]
            }
            return provider
        }
        let provider = fixture()
        let budget = try textBudget()
        let read = try AXTraversal.allText(root: 0, provider: provider, budget: budget, maxChars: 50)
        XCTAssertEqual(read.text, String(repeating: "x", count: 50))
        XCTAssertTrue(read.truncated)
        XCTAssertEqual(budget.nodes, 2)
        XCTAssertEqual(provider.providerCallCount, 5)
        XCTAssertEqual(provider.pageRequests.count, 1)
        let outlineProvider = fixture()
        let outlineBudget = try textBudget()
        _ = try AXTraversal.walk(root: 0, provider: outlineProvider, budget: outlineBudget)
        XCTAssertEqual(outlineBudget.nodes, 101)
        XCTAssertGreaterThan(outlineProvider.providerCallCount, provider.providerCallCount * 100)
        XCTAssertLessThan(budget.allocatedBytes, outlineBudget.allocatedBytes)
    }

    func testAllTextSeparatorsAndGraphemesRespectTheExactCharacterLimit() throws {
        for limit in [3, 4, 5, 6] {
            let provider = FakeAXProvider()
            provider.childCounts[0] = 1
            provider.stringAttributes[0] = [kAXValueAttribute as String: "abc"]
            provider.stringAttributes[1] = [kAXValueAttribute as String: "👩🏽‍💻é"]
            let read = try AXTraversal.allText(root: 0, provider: provider,
                                              budget: textBudget(), maxChars: limit)
            XCTAssertLessThanOrEqual(read.text.count, limit)
            XCTAssertEqual(read.truncated, limit < 6)
            switch limit {
            case 3, 4: XCTAssertEqual(read.text, "abc")
            case 5: XCTAssertEqual(read.text, "abc\n👩🏽‍💻")
            default: XCTAssertEqual(read.text, "abc\n👩🏽‍💻é")
            }
        }
    }

    /// A live TextEdit read returned "0\n0\n0\n0" for its format bar: checkbox states mixed into
    /// the document text. Checkboxes and radio buttons contribute their names, never their state.
    func testAllTextReadsControlNamesInsteadOfTheirStateValues() throws {
        let provider = FakeAXProvider()
        provider.stringAttributes[0] = [kAXRoleAttribute as String: "AXGroup"]
        provider.childCounts[0] = 4
        provider.stringAttributes[1] = [kAXRoleAttribute as String: "AXTextArea",
                                        kAXValueAttribute as String: "Hello from spaceo"]
        provider.stringAttributes[2] = [kAXRoleAttribute as String: "AXCheckBox",
                                        kAXTitleAttribute as String: "bold",
                                        kAXValueAttribute as String: "0"]
        provider.stringAttributes[3] = [kAXRoleAttribute as String: "AXRadioButton",
                                        kAXTitleAttribute as String: "align left",
                                        kAXValueAttribute as String: "1"]
        provider.stringAttributes[4] = [kAXRoleAttribute as String: "AXStaticText",
                                        kAXValueAttribute as String: "12"]
        let read = try AXTraversal.allText(root: 0, provider: provider,
                                          budget: textBudget(), maxChars: 20_000)
        XCTAssertEqual(read.text, "Hello from spaceo\nbold\nalign left\n12",
                       "static text keeps its value; controls read as their names")
        XCTAssertFalse(provider.stringRequests.contains {
            [2, 3].contains($0.element) && $0.attribute == kAXValueAttribute as String
        }, "a control's state value is never requested for text")
    }

    func testAllTextUsesNameWhenValueIsEmptyAndDoesNotQuerySecureValues() throws {
        let provider = FakeAXProvider()
        provider.childCounts[0] = 2
        provider.childCounts[1] = 2
        provider.stringAttributes[0] = [kAXValueAttribute as String: "", kAXTitleAttribute as String: "Save"]
        provider.stringAttributes[1] = [kAXRoleAttribute as String: "AXTextField",
                                        kAXSubroleAttribute as String: "AXSecureTextField",
                                        kAXValueAttribute as String: "secret"]
        provider.stringAttributes[2] = [kAXRoleAttribute as String: "AXSecureTextField",
                                        kAXValueAttribute as String: "secret"]
        let read = try AXTraversal.allText(root: 0, provider: provider,
                                          budget: textBudget(), maxChars: 20_000)
        XCTAssertEqual(read.text, "Save")
        XCTAssertFalse(read.truncated)
        XCTAssertEqual(provider.pageRequests.map(\.element), [0],
                       "secure-field subtrees must not be traversed for text")
        XCTAssertFalse(provider.stringRequests.contains {
            $0.element > 0 && $0.attribute == kAXValueAttribute as String
        })
    }

    func testAllTextReportsNodeCallAllocationAndDepthLimitsAsPartial() throws {
        for limits in [AXTraversalLimits(maxNodes: 1), AXTraversalLimits(maxAXCalls: 3),
                       AXTraversalLimits(maxAllocatedBytes: 70), AXTraversalLimits(maxDepth: 0)] {
            let provider = FakeAXProvider()
            provider.stringAttributes[0] = [kAXValueAttribute as String: "abc"]
            provider.childCounts[0] = 2
            let read = try AXTraversal.allText(root: 0, provider: provider,
                                              budget: textBudget(limits), maxChars: 20_000)
            XCTAssertEqual(read.text, "abc")
            XCTAssertTrue(read.truncated)
        }
    }

    func testAllTextMarksDeadlinePartialButPropagatesCancellationAndProviderFailures() throws {
        let provider = FakeAXProvider()
        let clock = TestMonotonicClock()
        provider.afterProviderCall = { clock.advance(by: 6_000_000) }
        let budget = try AXTraversalBudget(
            limits: AXTraversalLimits(timeout: 0.01, maxCallDuration: 0.001),
            now: { clock.value }, isCancelled: { false })
        XCTAssertTrue(try AXTraversal.allText(root: 0, provider: provider, budget: budget, maxChars: 20).truncated)

        let cancelled = try AXTraversalBudget(limits: AXTraversalLimits(), now: { 0 }, isCancelled: { true })
        XCTAssertThrowsError(try AXTraversal.allText(root: 0, provider: provider, budget: cancelled, maxChars: 20)) {
            XCTAssertEqual(($0 as? AXTraversalStopped)?.reason, .cancelled)
        }
        provider.acceptsMessagingTimeout = false
        XCTAssertThrowsError(try AXTraversal.allText(root: 0, provider: provider, budget: textBudget(), maxChars: 20)) {
            XCTAssertEqual(($0 as? AXTraversalStopped)?.reason, .provider)
        }
    }

    func testAllTextVisitsCyclicReferencesOnce() throws {
        let provider = FakeAXProvider()
        provider.childCounts[0] = 1
        provider.childCounts[1] = 1 // The fake's child 1 refers to itself.
        let budget = try textBudget()
        let read = try AXTraversal.allText(root: 0, provider: provider, budget: budget, maxChars: 20_000)
        XCTAssertEqual(read.text, "Node 0\nNode 1")
        XCTAssertFalse(read.truncated)
        XCTAssertEqual(budget.nodes, 2)
    }

    func testAllTextRejectsInvalidCharacterLimitsBeforeCallingProvider() throws {
        let provider = FakeAXProvider()
        for limit in [Int.min, 0, 20_001, Int.max] {
            XCTAssertThrowsError(try AXTraversal.allText(root: 0, provider: provider,
                                                        budget: textBudget(), maxChars: limit))
        }
        XCTAssertEqual(provider.providerCallCount, 0)
    }

}

private final class TestMonotonicClock {
    private(set) var value: UInt64 = 0

    func advance(by nanoseconds: UInt64) {
        value &+= nanoseconds
    }
}

private final class FakeAXProvider: AXWindowDiscoveryProviding {
    struct PageRequest: Equatable {
        let element: Int
        let start: Int
        let maxValues: Int
    }

    var childCounts: [Int: Int] = [:]
    var stringAttributes: [Int: [String: String]] = [:]
    var textAttributes: [Int: [String: String]] = [:]
    private(set) var textRequests: [(element: Int, attribute: String)] = []
    var actionLists: [Int: [String]] = [:]
    var acceptsMessagingTimeout = true
    var discoveryCountFails = false
    var discoveryPageFails = false
    var discoveryShortPage = false
    var forcedWindowID: CGWindowID?
    var identityStatuses: [AXError] = []
    var rootCountStatuses: [AXError] = []
    var rootPageStatuses: [AXError] = []
    var rootOversizedPage = false

    private func rootStatus(_ statuses: inout [AXError], operation: String) throws {
        let status = statuses.isEmpty ? AXError.success : statuses.removeFirst()
        if status != .success {
            throw AXWindowDiscovery.ProviderFailure(status: status, operation: operation)
        }
    }

    func identifiedWindowID(_ element: Int) throws -> CGWindowID {
        let id = windowID(element)
        let status = identityStatuses.isEmpty ? AXError.success : identityStatuses.removeFirst()
        guard status == .success else {
            throw AXWindowDiscovery.ProviderFailure(status: status, operation: "window identity")
        }
        return id
    }

    func windowCount(_ app: Int) throws -> Int {
        try rootStatus(&rootCountStatuses, operation: "window count")
        if discoveryCountFails { throw AXWindowDiscovery.incomplete("fixture count failure") }
        return arrayCount(app, attribute: kAXWindowsAttribute as String)
    }

    func windowElements(_ app: Int, start: Int, count: Int) throws -> [Int] {
        try rootStatus(&rootPageStatuses, operation: "window page")
        if discoveryPageFails { throw AXWindowDiscovery.incomplete("fixture page failure") }
        let page = elements(app, attribute: kAXWindowsAttribute as String, start: start, maxValues: count)
        if rootOversizedPage { return page + [999] }
        return discoveryShortPage ? Array(page.dropLast()) : page
    }
    var afterProviderCall: () -> Void = {}
    private(set) var providerCallCount = 0
    private(set) var stringRequests: [(element: Int, attribute: String)] = []
    private(set) var pageRequests: [PageRequest] = []
    private(set) var timeoutElements: [Int] = []
    private(set) var timeouts: [Float] = []

    func setMessagingTimeout(_ element: Int, seconds: Float) -> Bool {
        timeoutElements.append(element)
        timeouts.append(seconds)
        return acceptsMessagingTimeout
    }

    func string(_ element: Int, attribute: String) -> String? {
        called()
        stringRequests.append((element, attribute))
        if let configured = stringAttributes[element]?[attribute] {
            return configured
        }
        if attribute == kAXRoleAttribute as String {
            return "AXButton"
        }
        if attribute == kAXTitleAttribute as String {
            return "Node \(element)"
        }
        return nil
    }

    func text(_ element: Int, attribute: String) -> String? {
        textRequests.append((element, attribute))
        if let value = textAttributes[element]?[attribute] { called(); return value }
        return string(element, attribute: attribute)
    }

    func bool(_ element: Int, attribute: String) -> Bool? {
        called()
        return true
    }

    func actions(_ element: Int) -> [String] {
        called()
        return actionLists[element] ?? [kAXPressAction as String]
    }

    func point(_ element: Int, attribute: String) -> CGPoint? {
        called()
        return CGPoint(x: element, y: element)
    }

    func size(_ element: Int, attribute: String) -> CGSize? {
        called()
        return CGSize(width: 10, height: 10)
    }

    func arrayCount(_ element: Int, attribute: String) -> Int {
        called()
        return childCounts[element, default: 0]
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
        let count = childCounts[element, default: 0]
        let end = min(count, start + maxValues)
        guard start < end else { return [] }
        return (start..<end).map { $0 + 1 }
    }

    func windowID(_ element: Int) -> CGWindowID {
        called()
        return forcedWindowID ?? CGWindowID(element)
    }

    private func called() {
        providerCallCount += 1
        afterProviderCall()
    }
}
