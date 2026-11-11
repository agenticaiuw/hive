import CoreGraphics
import XCTest
@testable import SpaceOKit

/// Point-to-pane routing for split VS Code editors.
///
/// The failure this guards is silent and specific: resolving the wrong view column scrolls a
/// pane the caller never aimed at, and the adapter still reports a real visible-range change, so
/// the mistake reads as success all the way back to the agent.
final class ElectronEditorPanesTests: XCTestCase {
    private let left = CGRect(x: 0, y: 100, width: 500, height: 800)
    private let right = CGRect(x: 500, y: 100, width: 500, height: 800)
    private let top = CGRect(x: 0, y: 100, width: 1_000, height: 400)
    private let bottom = CGRect(x: 0, y: 500, width: 1_000, height: 400)

    // MARK: - Ordering

    func testASideBySideSplitOrdersLeftToRight() {
        let order = try? XCTUnwrap(ElectronEditorPanes.ordered([right, left]))
        XCTAssertEqual(order?.first, left)
        XCTAssertEqual(order?.last, right)
    }

    func testAStackedSplitOrdersTopToBottom() {
        let order = try? XCTUnwrap(ElectronEditorPanes.ordered([bottom, top]))
        XCTAssertEqual(order?.first, top)
        XCTAssertEqual(order?.last, bottom)
    }

    func testAGridHasNoDeterminedOrder() {
        let grid = [
            CGRect(x: 0, y: 100, width: 500, height: 400),
            CGRect(x: 500, y: 100, width: 500, height: 400),
            CGRect(x: 0, y: 500, width: 500, height: 400),
            CGRect(x: 500, y: 500, width: 500, height: 400),
        ]
        XCTAssertNil(
            ElectronEditorPanes.ordered(grid),
            "VS Code numbers a grid row-major in some layouts and column-major in others")
    }

    // MARK: - Resolution

    func testAPointResolvesToItsViewColumn() {
        XCTAssertEqual(
            ElectronEditorPanes.resolve(point: CGPoint(x: 250, y: 400), in: [left, right]),
            .column(1))
        XCTAssertEqual(
            ElectronEditorPanes.resolve(point: CGPoint(x: 750, y: 400), in: [left, right]),
            .column(2))
    }

    func testResolutionIsIndependentOfTheOrderFramesArriveIn() {
        XCTAssertEqual(
            ElectronEditorPanes.resolve(point: CGPoint(x: 750, y: 400), in: [right, left]),
            .column(2),
            "Accessibility does not promise to enumerate panes in layout order")
    }

    func testALonePaneUsesTheProvenActiveEditorPath() {
        XCTAssertEqual(ElectronEditorPanes.resolve(point: .zero, in: [left]), .single)
    }

    func testNoReportedPanesLeavesTheDecisionUnchanged() {
        XCTAssertEqual(ElectronEditorPanes.resolve(point: .zero, in: []), .unknownLayout)
    }

    func testAGridIsRefusedRatherThanGuessed() {
        let grid = [
            CGRect(x: 0, y: 100, width: 500, height: 400),
            CGRect(x: 500, y: 100, width: 500, height: 400),
            CGRect(x: 0, y: 500, width: 500, height: 400),
        ]
        XCTAssertEqual(
            ElectronEditorPanes.resolve(point: CGPoint(x: 250, y: 200), in: grid),
            .ambiguousLayout)
    }

    func testAPointOutsideEverySplitPaneIsRefused() {
        XCTAssertEqual(
            ElectronEditorPanes.resolve(point: CGPoint(x: 250, y: 950), in: [left, right]),
            .noPaneAtPoint,
            "falling back to the active editor here would scroll a pane nobody aimed at")
    }

    // MARK: - Frame hygiene

    func testScreenReaderProxiesAreNotPanes() {
        let proxy = CGRect(x: 10, y: 110, width: 1, height: 1)
        XCTAssertEqual(
            ElectronEditorPanes.resolve(point: CGPoint(x: 250, y: 400), in: [left, proxy]),
            .single,
            "a 1x1 screen-reader proxy must not read as a second pane")
    }

    func testTheSamePaneReportedTwiceIsOnePane() {
        let jittered = CGRect(x: 1, y: 101, width: 500, height: 800)
        XCTAssertEqual(
            ElectronEditorPanes.resolve(point: CGPoint(x: 250, y: 400), in: [left, jittered]),
            .single)
    }
}
