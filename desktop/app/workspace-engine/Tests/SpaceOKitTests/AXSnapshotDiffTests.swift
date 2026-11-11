import XCTest
import CoreGraphics
@testable import SpaceOKit

/// SPAO-207: incremental screen reads.
final class AXSnapshotDiffTests: XCTestCase {

    private func node(
        _ role: String, _ label: String, index: Int? = nil, depth: Int = 1,
        frame: CGRect? = CGRect(x: 10, y: 20, width: 100, height: 24), enabled: Bool = true,
        labelTruncated: Bool = false
    ) -> AXNode {
        AXNode(index: index, role: role, label: label, frame: frame, actions: [], depth: depth,
               enabled: enabled, labelTruncated: labelTruncated)
    }

    private var window: [AXNode] {
        [
            node("AXWindow", "Untitled", depth: 0, frame: CGRect(x: 0, y: 0, width: 800, height: 600)),
            node("AXButton", "Save", index: 1, frame: CGRect(x: 10, y: 10, width: 60, height: 24)),
            node("AXTextField", "hello", index: 2, frame: CGRect(x: 10, y: 50, width: 200, height: 24)),
            node("AXStaticText", "Name", frame: CGRect(x: 10, y: 80, width: 60, height: 16)),
        ]
    }

    // MARK: - Identity rule

    func testIdentityExcludesLabelForValueBearingRolesOnly() {
        let frame = CGRect(x: 1, y: 2, width: 3, height: 4)
        XCTAssertEqual(
            AXNode.identity(role: "AXTextField", depth: 2, frame: frame, label: "a"),
            AXNode.identity(role: "AXTextField", depth: 2, frame: frame, label: "b"))
        XCTAssertNotEqual(
            AXNode.identity(role: "AXButton", depth: 2, frame: frame, label: "a"),
            AXNode.identity(role: "AXButton", depth: 2, frame: frame, label: "b"))
        XCTAssertNotEqual(
            AXNode.identity(role: "AXButton", depth: 2, frame: frame, label: "a"),
            AXNode.identity(role: "AXButton", depth: 3, frame: frame, label: "a"))
    }

    func testIdentitySnapsFrameToFourPointGrid() {
        let a = AXNode.identity(role: "AXButton", depth: 1, frame: CGRect(x: 10, y: 20, width: 100, height: 24), label: "x")
        let b = AXNode.identity(role: "AXButton", depth: 1, frame: CGRect(x: 11.4, y: 19, width: 101, height: 25), label: "x")
        let c = AXNode.identity(role: "AXButton", depth: 1, frame: CGRect(x: 50, y: 20, width: 100, height: 24), label: "x")
        XCTAssertEqual(a, b)
        XCTAssertNotEqual(a, c)
        XCTAssertNotEqual(a, AXNode.identity(role: "AXButton", depth: 1, frame: nil, label: "x"))
    }

    // MARK: - Diff

    func testDiffOfIdenticalSnapshotsIsEmpty() {
        let diff = AXSnapshotDiff.diff(base: window, current: window, baseSnapshotID: "base")
        XCTAssertTrue(AXSnapshotDiff.isEmpty(diff))
        XCTAssertEqual(diff.unchangedCount, window.count)
        XCTAssertEqual(diff.baseSnapshotID, "base")
        XCTAssertFalse(diff.baseMissing)
    }

    func testAddedRemovedAndChangedDetection() {
        var current = window
        current.removeAll { $0.label == "Name" }                             // removed
        current.append(node("AXLink", "Help", index: 3, frame: CGRect(x: 10, y: 110, width: 40, height: 16)))  // added
        current[1] = node("AXButton", "Save", index: 1, frame: CGRect(x: 10, y: 10, width: 60, height: 24), enabled: false)  // changed

        let diff = AXSnapshotDiff.diff(base: window, current: current, baseSnapshotID: "b")
        XCTAssertEqual(diff.added, ["  [3] Link — Help"])
        XCTAssertEqual(diff.removed, ["  StaticText — Name"])
        XCTAssertEqual(diff.changed, ["  [1] Button — Save  (disabled)"])
        XCTAssertEqual(diff.unchangedCount, 2)
        XCTAssertFalse(AXSnapshotDiff.isEmpty(diff))
    }

    func testTextFieldValueChangeIsChangedNotAddRemove() {
        var current = window
        current[2] = node("AXTextField", "hello world", index: 2, frame: CGRect(x: 10, y: 50, width: 200, height: 24))
        let diff = AXSnapshotDiff.diff(base: window, current: current, baseSnapshotID: "b")
        XCTAssertTrue(diff.added.isEmpty)
        XCTAssertTrue(diff.removed.isEmpty)
        XCTAssertEqual(diff.changed, ["  [2] TextField — hello → hello world"])
        XCTAssertEqual(diff.unchangedCount, 3)
    }

    func testClearedTextFieldRendersEmptyMarker() {
        var current = window
        current[2] = node("AXTextField", "", index: 2, frame: CGRect(x: 10, y: 50, width: 200, height: 24))
        let diff = AXSnapshotDiff.diff(base: window, current: current, baseSnapshotID: "b")
        XCTAssertEqual(diff.changed, ["  [2] TextField — hello → (empty)"])
    }

    func testButtonLabelChangeIsRemovePlusAdd() {
        var current = window
        current[1] = node("AXButton", "Saved", index: 1, frame: CGRect(x: 10, y: 10, width: 60, height: 24))
        let diff = AXSnapshotDiff.diff(base: window, current: current, baseSnapshotID: "b")
        XCTAssertEqual(diff.removed, ["  [1] Button — Save"])
        XCTAssertEqual(diff.added, ["  [1] Button — Saved"])
        XCTAssertTrue(diff.changed.isEmpty)
        XCTAssertEqual(diff.unchangedCount, 3)
    }

    func testReenabledControlIsReportedAsChanged() {
        var base = window
        base[1] = node("AXButton", "Save", index: 1, frame: CGRect(x: 10, y: 10, width: 60, height: 24), enabled: false)
        let diff = AXSnapshotDiff.diff(base: base, current: window, baseSnapshotID: "b")
        XCTAssertEqual(diff.changed, ["  [1] Button — Save  (enabled)"])
    }

    func testDuplicateKeysAreDisambiguatedDeterministically() {
        let frame = CGRect(x: 0, y: 0, width: 20, height: 20)
        let twins = [node("AXButton", "•", index: 1, frame: frame), node("AXButton", "•", index: 2, frame: frame)]
        let lines = AXSnapshotDiff.lines(twins)
        XCTAssertEqual(lines.count, 2)
        XCTAssertNotEqual(lines[0].key, lines[1].key)
        XCTAssertTrue(lines[1].key.hasSuffix("#2"))
        XCTAssertEqual(AXSnapshotDiff.lines(twins), lines)   // same input, same keys

        // Same twins again: nothing changed.
        XCTAssertTrue(AXSnapshotDiff.isEmpty(AXSnapshotDiff.diff(base: twins, current: twins, baseSnapshotID: "b")))

        // A third twin appears: exactly one addition, and it is the #3 occurrence.
        let triplets = twins + [node("AXButton", "•", index: 3, frame: frame)]
        let diff = AXSnapshotDiff.diff(base: twins, current: triplets, baseSnapshotID: "b")
        XCTAssertEqual(diff.added, ["  [3] Button — •"])
        XCTAssertTrue(diff.removed.isEmpty)
        XCTAssertEqual(diff.unchangedCount, 2)

        // One twin disappears: exactly one removal, no spurious churn.
        let single = AXSnapshotDiff.diff(base: twins, current: [twins[0]], baseSnapshotID: "b")
        XCTAssertEqual(single.removed, ["  [2] Button — •"])
        XCTAssertTrue(single.added.isEmpty)
    }

    func testRenderMatchesOutlineFormatting() {
        let deep = node("AXMenuItem", "Quit", index: 9, depth: 14, enabled: false)
        XCTAssertEqual(AXSnapshotDiff.render(deep), String(repeating: "  ", count: 12) + "[9] MenuItem — Quit  (disabled)")
        XCTAssertEqual(AXSnapshotDiff.render(node("AXGroup", "", depth: 0)), "Group")
    }

    func testReindexedControlsAreReturnedWithCurrentTargets() {
        let base = [node("AXButton", "Save", index: 1), node("AXTextField", "text", index: 2)]
        let current = [node("AXButton", "New", index: 1),
                       node("AXButton", "Save", index: 2), node("AXTextField", "text", index: 3)]
        let diff = AXSnapshotDiff.diff(base: base, current: current, baseSnapshotID: "base")
        XCTAssertEqual(diff.added, ["  [1] Button — New"])
        XCTAssertEqual(diff.changed, ["  [2] Button — Save  (previous index: [1])",
                                      "  [3] TextField — text  (previous index: [2])"])
        XCTAssertEqual(diff.unchangedCount, 0)
        XCTAssertTrue(diff.removed.isEmpty)
    }

    func testActionabilityChangesAreNotReportedAsUnchanged() {
        let diff = AXSnapshotDiff.diff(base: [node("AXButton", "Save", index: 1)],
                                      current: [node("AXButton", "Save")], baseSnapshotID: "base")
        XCTAssertEqual(diff.changed, ["  Button — Save  (previous index: [1])"])
        XCTAssertEqual(diff.unchangedCount, 0)
    }

    func testDuplicateSuffixCannotCollideWithLiteralLabel() {
        let nodes = [node("AXButton", "Save", index: 1), node("AXButton", "Save", index: 2),
                     node("AXButton", "Save#2", index: 3), node("AXButton", "Save#2#1", index: 4)]
        XCTAssertEqual(Set(AXSnapshotDiff.lines(nodes).map(\.key)).count, nodes.count)
        let diff = AXSnapshotDiff.diff(base: nodes, current: nodes, baseSnapshotID: "base")
        XCTAssertTrue(AXSnapshotDiff.isEmpty(diff))
        XCTAssertEqual(diff.unchangedCount, nodes.count)
    }

    func testIdentityHandlesFiniteCoordinatesOutsideIntegerRange() {
        for value in [CGFloat.greatestFiniteMagnitude, -CGFloat.greatestFiniteMagnitude,
                      CGFloat(Int.max), CGFloat(Int.min)] {
            let extreme = node("AXButton", "Save", frame: CGRect(x: value, y: value, width: 24, height: 24))
            XCTAssertFalse(extreme.stableKey.isEmpty)
            XCTAssertTrue(AXSnapshotDiff.isEmpty(
                AXSnapshotDiff.diff(base: [extreme], current: [extreme], baseSnapshotID: "base")))
        }
    }

    func testHistoryRefusesBaseFromAnotherWindow() {
        let history = AXSnapshotHistory()
        history.remember(snapshotID: "BASE", windowID: 7, nodes: window)
        XCTAssertNotNil(history.nodes(for: "base", windowID: 7))
        XCTAssertNil(history.nodes(for: "base", windowID: 8))
    }

    func testNoChangeDiffStillReportsClippedSnapshotValues() throws {
        let clipped = node("AXTextField", "document…", index: 1, labelTruncated: true)
        let snapshot = AXSnapshot(pid: getpid(), windowID: 7,
                                  processIdentity: try XCTUnwrap(ProcessIdentity.current(of: getpid())),
                                  generation: UUID(), nodes: [clipped], elements: [:])
        let diff = AXSnapshotDiff.diff(base: [clipped], current: [clipped], baseSnapshotID: "base")
        XCTAssertTrue(AXSnapshotDiff.isEmpty(diff))
        let report = snapshot.truncationReport(outline: "(no changes)")
        XCTAssertTrue(report.truncated)
        XCTAssertEqual(report.reason, "value_clipped")
    }

    func testElementWaitIncludesStaticLabelsButCannotProveAbsenceFromPartialTrees() throws {
        func snapshot(_ nodes: [AXNode], truncatedBy: AXTraversalStopReason? = nil) throws -> AXSnapshot {
            AXSnapshot(pid: getpid(), windowID: 7,
                       processIdentity: try XCTUnwrap(ProcessIdentity.current(of: getpid())),
                       generation: UUID(), nodes: nodes, elements: [:], truncatedBy: truncatedBy)
        }
        let present = try snapshot([node("AXStaticText", "Loading")])
        guard case .met(let match) = present.waitProbe(.elementLabel("Loading")) else {
            return XCTFail("static labels must match")
        }
        XCTAssertNil(match.matchedIndex)
        guard case .notYet = present.waitProbe(.elementGone("Loading")) else {
            return XCTFail("visible static labels are not gone")
        }
        for partial in [try snapshot([], truncatedBy: .nodes),
                        try snapshot([], truncatedBy: .depth),
                        try snapshot([node("AXTextField", "Loading…", labelTruncated: true)])] {
            guard case .notYet = partial.waitProbe(.elementGone("Loading")) else {
                return XCTFail("incomplete snapshots cannot prove absence")
            }
        }
        guard case .met = try snapshot([]).waitProbe(.elementGone("Loading")) else {
            return XCTFail("a complete empty snapshot proves absence")
        }
    }

    // MARK: - History

    func testOrdinaryEllipsesDoNotMakeReadPartialOrBlockAbsenceWait() throws {
        let snapshot = AXSnapshot(
            pid: getpid(), windowID: 7,
            processIdentity: try XCTUnwrap(ProcessIdentity.current(of: getpid())),
            generation: UUID(), nodes: [node("AXButton", "Open…", index: 1)], elements: [:])
        let report = snapshot.truncationReport(outline: "[1] Button — Open…")
        XCTAssertFalse(report.truncated)
        XCTAssertNil(report.reason)
        guard case .met = snapshot.waitProbe(.elementGone("Loading")) else {
            return XCTFail("ordinary punctuation cannot prevent proving absence")
        }
        guard case .notYet = snapshot.waitProbe(.elementGone("Open…")) else {
            return XCTFail("the exact visible label must still count as present")
        }
    }

    func testHistoryRoundTripIsCaseInsensitiveOnID() {
        let history = AXSnapshotHistory()
        let id = UUID().uuidString
        history.remember(snapshotID: id, windowID: 7, nodes: window)
        XCTAssertEqual(history.nodes(for: id.lowercased())?.count, window.count)
        XCTAssertEqual(history.nodes(for: id.uppercased())?.count, window.count)
        XCTAssertNil(history.nodes(for: UUID().uuidString))
        XCTAssertEqual(history.count, 1)
    }

    func testHistoryEvictsOldestBeyondCapacity() {
        let history = AXSnapshotHistory()
        let ids = (0..<10).map { _ in UUID().uuidString.lowercased() }
        for (i, id) in ids.enumerated() {
            history.remember(snapshotID: id, windowID: UInt32(i), nodes: window)
        }
        XCTAssertEqual(history.count, AXSnapshotHistory.defaultCapacity)
        XCTAssertNil(history.nodes(for: ids[0]))
        XCTAssertNil(history.nodes(for: ids[1]))
        XCTAssertNotNil(history.nodes(for: ids[2]))
        XCTAssertNotNil(history.nodes(for: ids[9]))
    }

    func testHistoryCapacityCannotExceedDefault() {
        let history = AXSnapshotHistory(capacity: 100)
        for _ in 0..<12 { history.remember(snapshotID: UUID().uuidString, windowID: 1, nodes: []) }
        XCTAssertEqual(history.count, AXSnapshotHistory.defaultCapacity)
    }

    func testHistoryTruncatesNodesPerEntry() {
        let history = AXSnapshotHistory()
        let many = (0..<(AXSnapshotHistory.maximumNodes + 50)).map { i in
            node("AXStaticText", "row \(i)", frame: nil)
        }
        history.remember(snapshotID: "big", windowID: 1, nodes: many)
        XCTAssertEqual(history.nodes(for: "big")?.count, AXSnapshotHistory.maximumNodes)
    }

    func testHistoryByteBudgetEvictsOldestAndAccountsForReplacementAndForget() {
        let sample = [node("AXTextField", String(repeating: "x", count: 100), index: 1)]
        let probe = AXSnapshotHistory()
        probe.remember(snapshotID: "a", windowID: 1, nodes: sample)
        let size = probe.byteCount
        let history = AXSnapshotHistory(maximumBytes: size * 2)
        for id in ["a", "b", "c"] {
            history.remember(snapshotID: id, windowID: 1, nodes: sample)
        }
        XCTAssertNil(history.nodes(for: "a"))
        XCTAssertNotNil(history.nodes(for: "b"))
        XCTAssertNotNil(history.nodes(for: "c"))
        XCTAssertEqual(history.byteCount, size * 2)
        history.remember(snapshotID: "b", windowID: 2, nodes: [])
        XCTAssertEqual(history.byteCount, size + 1)
        history.forget(windowID: 1)
        XCTAssertEqual(history.byteCount, 1)
        history.clear()
        XCTAssertEqual(history.byteCount, 0)
    }

    func testHistoryOmitsOversizedPayloadInsteadOfCachingAPartialBase() {
        let history = AXSnapshotHistory(maximumBytes: 1024)
        history.remember(snapshotID: "a", windowID: 1, nodes: window)
        XCTAssertNotNil(history.nodes(for: "a"))
        let large = AXNode(index: 1, role: "AXButton", label: "Save", frame: nil,
                           actions: [String(repeating: "x", count: 1024)], depth: 1, enabled: true)
        history.remember(snapshotID: "a", windowID: 1, nodes: [large])
        XCTAssertNil(history.nodes(for: "a"))
        XCTAssertEqual(history.byteCount, 0)
        history.remember(snapshotID: "label", windowID: 1,
                         nodes: [node("AXTextField", String(repeating: "é", count: 1024))])
        XCTAssertEqual(history.count, 0)
    }

    func testHistoryRememberReplacesAndForgetByWindowAndClear() {
        let history = AXSnapshotHistory()
        history.remember(snapshotID: "a", windowID: 1, nodes: window)
        history.remember(snapshotID: "a", windowID: 1, nodes: [])
        XCTAssertEqual(history.count, 1)
        XCTAssertEqual(history.nodes(for: "a")?.count, 0)

        history.remember(snapshotID: "b", windowID: 2, nodes: window)
        history.remember(snapshotID: "c", windowID: 1, nodes: window)
        history.forget(windowID: 1)
        XCTAssertNil(history.nodes(for: "a"))
        XCTAssertNil(history.nodes(for: "c"))
        XCTAssertNotNil(history.nodes(for: "b"))

        history.clear()
        XCTAssertEqual(history.count, 0)
        XCTAssertNil(history.nodes(for: "b"))
    }

    /// Live dogfood: typing into TextEdit indexed its text area first, and the diff listed all
    /// 20 later controls as "changed" only because their index moved by one.
    func testUniformRenumberingCollapsesToOneExactLine() {
        func node(_ index: Int?, _ label: String) -> AXNode {
            AXNode(index: index, role: "AXButton", label: label,
                   frame: CGRect(x: 0, y: CGFloat(label.count) * 10, width: 10, height: 10),
                   actions: ["AXPress"], depth: 1, enabled: true)
        }
        let labels = ["bold", "italic", "underline", "strikethrough"]
        let base = labels.enumerated().map { node($0.offset, $0.element) }
        let current = [AXNode(index: 0, role: "AXTextArea", label: "Hello", frame: nil,
                              actions: [], depth: 1, enabled: true)]
            + labels.enumerated().map { node($0.offset + 1, $0.element) }
        let diff = AXSnapshotDiff.diff(base: base, current: current, baseSnapshotID: "s")
        XCTAssertEqual(diff.added.count, 1)
        XCTAssertEqual(diff.changed, [
            "4 element(s) otherwise unchanged were renumbered by +1 (now [1]…[4]); add 1 to any index you read before this change",
        ])

        // Mixed shifts keep per-element lines: no single rule maps old indices to new ones.
        var mixed = current
        mixed[4] = node(7, "strikethrough")
        let mixedDiff = AXSnapshotDiff.diff(base: base, current: mixed, baseSnapshotID: "s")
        XCTAssertEqual(mixedDiff.changed.count, 4)
        XCTAssertTrue(mixedDiff.changed.allSatisfy { $0.contains("previous index") })
    }
}
