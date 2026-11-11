import XCTest
import CoreGraphics
@testable import SpaceOKit
@testable import SpaceOMCP

/// Regressions for SPAO-118: absence of a safe input-route observation is not a clean result.
final class IsolationCoverageTests: XCTestCase {

    private func liveShapedSnapshot(frontmostPID: pid_t = 10,
                                    windowServerFrontPID: pid_t = 10,
                                    keyFocusPID: pid_t = 0,
                                    typingFocusPID: pid_t = 0,
                                    agentPIDs: Set<pid_t> = []) -> IsolationSnapshot {
        IsolationSnapshot(
            frontmostPID: frontmostPID,
            windowServerFrontPID: windowServerFrontPID,
            keyFocusPID: keyFocusPID,
            typingFocusPID: typingFocusPID,
            cursor: CGPoint(x: 100, y: 100),
            activeSpace: 1,
            agentPIDs: agentPIDs,
            coverage: .live
        )
    }

    func testLiveCoverageNamesEveryDimensionAndProducesPartialVerdict() {
        let before = liveShapedSnapshot()
        let after = liveShapedSnapshot()
        let report = after.report(comparedTo: before)

        XCTAssertEqual(report.checks.map(\.dimension), IsolationDimension.allCases)
        XCTAssertEqual(report.verdict, .partial)
        XCTAssertTrue(report.failures.isEmpty)
        XCTAssertFalse(report.isFullyIntact)
        XCTAssertFalse(after.isUndisturbed(comparedTo: before))

        let checks = Dictionary(uniqueKeysWithValues: report.checks.map {
            ($0.dimension, $0)
        })
        XCTAssertEqual(checks[.menuBarOwner]?.coverage, .observed)
        XCTAssertEqual(checks[.windowServerFrontProcess]?.coverage, .inferred)
        XCTAssertEqual(checks[.keyInputRoute]?.coverage, .unknown)
        XCTAssertEqual(checks[.keyInputRoute]?.status, .unknown)
        XCTAssertEqual(checks[.textInputRoute]?.coverage, .unknown)
        XCTAssertEqual(checks[.textInputRoute]?.status, .unknown)
        XCTAssertTrue(report.checks.allSatisfy(\.required))
    }

    func testUnknownInputRouteCannotSerializeAsIntact() throws {
        let snapshot = liveShapedSnapshot()
        var response = Response(ok: true)
        response.isolation = snapshot.report(comparedTo: snapshot)
        response.drift = response.isolation?.legacyDrift

        let data = try Wire.encoder.encode(response)
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: data) as? [String: Any])
        let isolation = try XCTUnwrap(object["isolation"] as? [String: Any])
        XCTAssertEqual(isolation["verdict"] as? String, "partial")
        XCTAssertNotEqual(isolation["verdict"] as? String, "intact")
        XCTAssertNil(object["drift"], "partial coverage must not serialize legacy drift: []")

        let checks = try XCTUnwrap(isolation["checks"] as? [[String: Any]])
        let keyRoute = try XCTUnwrap(checks.first {
            $0["dimension"] as? String == IsolationDimension.keyInputRoute.rawValue
        })
        XCTAssertEqual(keyRoute["coverage"] as? String, "unknown")
        XCTAssertEqual(keyRoute["status"] as? String, "unknown")
        XCTAssertEqual(keyRoute["required"] as? Bool, true)
    }

    func testMCPPartialOutputDoesNotClaimIntactOrUndisturbed() {
        let snapshot = liveShapedSnapshot()
        var response = Response(ok: true)
        response.isolation = snapshot.report(comparedTo: snapshot)
        response.drift = response.isolation?.legacyDrift

        let rendered = MCPServer.render(response)
        XCTAssertTrue(rendered.contains("isolation: partial"))
        XCTAssertTrue(rendered.contains("key_input_route: unknown [unknown]"))
        XCTAssertTrue(rendered.contains("text_input_route: unknown [unknown]"))
        XCTAssertFalse(rendered.contains("intact"))
        XCTAssertFalse(rendered.contains("undisturbed"))
    }

    func testUnknownRouteValuesAreNotTreatedAsEvidenceOfPassOrFailure() {
        let before = liveShapedSnapshot(keyFocusPID: 10, typingFocusPID: 10)
        let after = liveShapedSnapshot(
            keyFocusPID: 777,
            typingFocusPID: 777,
            agentPIDs: [777]
        )
        let report = after.report(comparedTo: before)

        XCTAssertEqual(report.verdict, .partial)
        XCTAssertTrue(report.failures.isEmpty)
        XCTAssertEqual(
            report.checks.first { $0.dimension == .keyInputRoute }?.status,
            .unknown
        )
        XCTAssertEqual(
            report.checks.first { $0.dimension == .textInputRoute }?.status,
            .unknown
        )
    }

    func testObservedFailureIsAttachedToItsCheckAndMCPRendersSameCoverage() {
        let before = liveShapedSnapshot(agentPIDs: [777])
        let after = liveShapedSnapshot(frontmostPID: 777, agentPIDs: [777])
        let report = after.report(comparedTo: before)
        let menuBar = report.checks.first { $0.dimension == .menuBarOwner }

        XCTAssertEqual(report.verdict, .breached)
        XCTAssertEqual(menuBar?.coverage, .observed)
        XCTAssertEqual(menuBar?.status, .failed)
        XCTAssertEqual(menuBar?.failures, report.failures)

        var response = Response(ok: false)
        response.error = "isolation breach during test"
        response.isolation = report
        response.drift = report.legacyDrift
        let rendered = MCPServer.renderFailure(response)

        XCTAssertTrue(rendered.contains("isolation breach during test"))
        XCTAssertTrue(rendered.contains("ISOLATION BREACH"))
        XCTAssertTrue(rendered.contains("menu_bar_owner: failed [observed]"))
        XCTAssertTrue(rendered.contains(report.failures[0]))
        XCTAssertTrue(rendered.contains("key_input_route: unknown [unknown]"))
    }

    func testCurrentAuditCanFailCoveredStateWhileRoutesRemainUnknown() {
        let snapshot = liveShapedSnapshot(
            frontmostPID: 777,
            windowServerFrontPID: 777,
            agentPIDs: [777]
        )
        let report = snapshot.currentReport()

        XCTAssertEqual(report.verdict, .breached)
        XCTAssertTrue(report.failures.contains { $0.contains("currently owns the menu bar") })
        XCTAssertEqual(
            report.checks.first { $0.dimension == .windowServerFrontProcess }?.coverage,
            .inferred
        )
        XCTAssertEqual(
            report.checks.first { $0.dimension == .keyInputRoute }?.status,
            .unknown
        )
    }

    func testFullyObservedSyntheticComparisonCanStillBeIntact() {
        let before = IsolationSnapshot(
            frontmostPID: 10,
            windowServerFrontPID: 10,
            keyFocusPID: 10,
            typingFocusPID: 10,
            cursor: .zero,
            activeSpace: 1,
            coverage: .observed
        )
        let after = IsolationSnapshot(
            frontmostPID: 10,
            windowServerFrontPID: 10,
            keyFocusPID: 10,
            typingFocusPID: 10,
            cursor: .zero,
            activeSpace: 1,
            coverage: .observed
        )

        XCTAssertEqual(after.report(comparedTo: before).verdict, .intact)
        XCTAssertTrue(after.isUndisturbed(comparedTo: before))
    }

    func testAccessibilityFocusedApplicationProxyIsExplicitlyInferred() {
        let coverage = IsolationSnapshotCoverage(
            menuBarOwner: .observed,
            windowServerFrontProcess: .inferred,
            keyInputRoute: .inferred,
            textInputRoute: .inferred,
            cursorLocation: .observed,
            activeSpace: .observed)
        let before = IsolationSnapshot(
            frontmostPID: 10,
            windowServerFrontPID: 10,
            keyFocusPID: 10,
            typingFocusPID: 10,
            cursor: .zero,
            activeSpace: 1,
            agentPIDs: [777],
            coverage: coverage)
        let after = IsolationSnapshot(
            frontmostPID: 10,
            windowServerFrontPID: 10,
            keyFocusPID: 777,
            typingFocusPID: 777,
            cursor: .zero,
            activeSpace: 1,
            agentPIDs: [777],
            coverage: coverage)

        let report = after.report(comparedTo: before)
        let key = report.checks.first { $0.dimension == .keyInputRoute }
        let text = report.checks.first { $0.dimension == .textInputRoute }

        XCTAssertEqual(report.verdict, .breached)
        XCTAssertEqual(key?.coverage, .inferred)
        XCTAssertEqual(key?.status, .failed)
        XCTAssertEqual(text?.coverage, .inferred)
        XCTAssertEqual(text?.status, .failed)
        XCTAssertTrue(key?.evidence.contains("public Accessibility focused application") == true)
        XCTAssertTrue(key?.evidence.contains("does not identify a specific key window") == true)
    }

    func testLegacySyntheticInitializerDefaultsToObservedCoverage() {
        // Keep this call in the pre-coverage shape as a compile-level source compatibility check.
        let snapshot = IsolationSnapshot(
            frontmostPID: 10,
            windowServerFrontPID: 10,
            keyFocusPID: 10,
            typingFocusPID: 10,
            cursor: .zero,
            activeSpace: 1
        )

        XCTAssertEqual(snapshot.coverage, .observed)
        XCTAssertEqual(snapshot.report(comparedTo: snapshot).verdict, .intact)
    }
}
