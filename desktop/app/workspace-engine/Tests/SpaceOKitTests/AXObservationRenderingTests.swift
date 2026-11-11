import CoreGraphics
import XCTest
@testable import SpaceOKit

final class AXObservationRenderingTests: XCTestCase {
    private func node(_ label: String, index: Int? = nil, role: String = "AXButton",
                      depth: Int = 1, enabled: Bool = true, frame: CGRect? = nil) -> AXNode {
        AXNode(index: index, role: role, label: label, frame: frame,
               actions: [], depth: depth, enabled: enabled)
    }

    private func snapshot(_ nodes: [AXNode]) throws -> AXSnapshot {
        AXSnapshot(pid: getpid(), windowID: 1,
                   processIdentity: try XCTUnwrap(ProcessIdentity.current(of: getpid())),
                   generation: UUID(), nodes: nodes, elements: [:])
    }

    func testFullOutlineAndDiffLinesAgreeOnFormattingAndVisibility() throws {
        let nodes = [node("Window", role: "AXWindow", depth: 0),
                     node("Save", index: 1), node("Close", index: 2, depth: 2, enabled: false)]
        let snapshot = try snapshot(nodes)
        XCTAssertEqual(snapshot.outline(), "  [1] Button — Save\n    [2] Button — Close  (disabled)")
        XCTAssertEqual(snapshot.outline(includeNonActionable: true),
                       AXSnapshotDiff.lines(nodes).map(\.line).joined(separator: "\n"))
        XCTAssertEqual(snapshot.line(for: nodes[2]), "[2] Button — Close  (disabled)")
        XCTAssertEqual(try self.snapshot([]).outline(), "(no actionable elements found)")
    }

    func testUnusualDepthsCannotTrapOrAllocateUnboundedIndentation() throws {
        let nodes = [node("negative", index: 1, depth: Int.min),
                     node("huge", index: 2, depth: Int.max)]
        let outline = try snapshot(nodes).outline()
        XCTAssertEqual(outline, "[1] Button — negative\n" + String(repeating: "  ", count: 12) + "[2] Button — huge")
    }

    func testRoleFormattingPreservesEmbeddedPrefixesAndLabelOverride() {
        XCTAssertEqual(node("original", index: 4, role: "AXButton", enabled: false)
            .renderedLine(label: "override", indented: true),
            "  [4] Button — override  (disabled)")
        XCTAssertEqual(node("value", role: "AXAXMenuAXItem", depth: 0).renderedLine(),
                       "MenuItem — value")
        XCTAssertEqual(node("value", role: "CustomRole", depth: 0).renderedLine(),
                       "CustomRole — value")
        let combiningMarkRoles: [(String, String)] = [
            ("AX\u{0301}Button", "AX\u{0301}Button — value"),
            ("FooAX\u{0301}Bar", "FooAX\u{0301}Bar — value"),
            ("FooA\u{0301}XBar", "FooA\u{0301}XBar — value"),
            ("AXFooAX\u{0301}Bar", "FooAX\u{0301}Bar — value"),
        ]
        for (role, expected) in combiningMarkRoles {
            XCTAssertEqual(node("value", role: role, depth: 0).renderedLine(), expected)
        }
    }

    func testReservationLimitDoesNotClipTheOutline() throws {
        let label = String(repeating: "x", count: 4 * 1_024 * 1_024 + 17)
        let outline = try snapshot([node(label, index: 1)]).outline()
        let prefix = "  [1] Button — "
        XCTAssertTrue(outline.hasPrefix(prefix))
        XCTAssertEqual(outline.utf8.count, prefix.utf8.count + label.utf8.count)
        XCTAssertTrue(outline.hasSuffix(label))
    }

    func testUnrepresentableGeometryOmitsCoordinatesButKeepsIndices() throws {
        let frames = [
            CGRect(x: CGFloat.nan, y: 0, width: 10, height: 10),
            CGRect(x: CGFloat.infinity, y: 0, width: 10, height: 10),
            CGRect(x: CGFloat.greatestFiniteMagnitude, y: 0, width: 10, height: 10),
            CGRect(x: 0, y: 0, width: CGFloat.infinity, height: 10),
            CGRect(x: 0, y: 0, width: -10, height: 10),
        ]
        for frame in frames {
            let node = node("Save", index: 7, frame: frame)
            XCTAssertNil(node.renderedCenter())
            XCTAssertEqual(try snapshot([node]).line(for: node, includeFrame: true), "[7] Button — Save")
        }
    }

    func testCoordinatesPreserveTruncationAndWindowRelativeConversion() throws {
        let node = node("Save", index: 7, frame: CGRect(x: -12.5, y: 20.5, width: 3, height: 4))
        XCTAssertEqual(node.renderedCenter(), "(-11,22)")
        XCTAssertEqual(node.renderedCenter(relativeTo: CGPoint(x: -20, y: 20)), "(9,2)")
        XCTAssertNil(node.renderedCenter(relativeTo: CGPoint(x: CGFloat.infinity, y: 0)))
        XCTAssertEqual(try snapshot([node]).line(for: node, includeFrame: true), "[7] Button — Save  at (-11,22) global")
    }

    func testExactLabelResolutionPreservesAbsenceAndAmbiguityRules() throws {
        let nodes = [node("Save"), node("Save", index: 1, enabled: false),
                     node("Save", index: 2), node("save", index: 3)]
        XCTAssertEqual(try snapshot(nodes).uniqueIndex(label: "Save"), 2)
        XCTAssertThrowsError(try snapshot(nodes).uniqueIndex(label: "missing")) { error in
            guard case SpaceOError.windowNotReady = error else { return XCTFail("\(error)") }
        }
        XCTAssertThrowsError(try snapshot(nodes + [node("Save", index: 4)]).uniqueIndex(label: "Save")) { error in
            guard case SpaceOError.badRequest = error else { return XCTFail("\(error)") }
        }
    }

    func testFindRespectsZeroNegativeAndPositiveLimits() throws {
        let snapshot = try snapshot([node("Save", index: 1), node("Save", index: 2)])
        XCTAssertTrue(snapshot.find("Save", role: nil, limit: 0).isEmpty)
        XCTAssertTrue(snapshot.find("Save", role: nil, limit: -1).isEmpty)
        XCTAssertEqual(snapshot.find("save", role: "Button", limit: 1).map(\.index), [1])
    }

    func testDiffPreservesRemovalOrderWithMixedMatchedAndUnmatchedDuplicates() {
        let base = [node("same", index: 1), node("removed", index: 2),
                    node("same", index: 3), node("last", index: 4)]
        let current = [node("same", index: 1), node("new", index: 5)]
        let diff = AXSnapshotDiff.diff(base: base, current: current, baseSnapshotID: "base")
        XCTAssertEqual(diff.unchangedCount, 1)
        XCTAssertEqual(diff.added, ["  [5] Button — new"])
        XCTAssertEqual(diff.removed, ["  [2] Button — removed", "  [3] Button — same", "  [4] Button — last"])
    }
}
