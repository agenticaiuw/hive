import Foundation
import XCTest
@testable import SpaceOKit

final class LaunchFailureDiagnosticTests: XCTestCase {
    func testFailureFieldsContainOnlyStructuredAttribution() {
        let secret = "private application, document and provider detail"
        let errors: [(Error, String)] = [
            (SpaceOError.launchFailed(secret), "launch_failed"),
            (NSError(domain: secret, code: 7, userInfo: [NSLocalizedDescriptionKey: secret]),
             "unclassified_error"),
            (CancellationError(), "cancelled"),
            (AXTraversalStopped(reason: .deadline, detail: secret), "ax_deadline"),
            (DevToolsDeadline.Exceeded(), "devtools_deadline"),
        ]
        for phase in AppLauncher.LaunchPhase.allCases {
            for (error, code) in errors {
                let fields = AppLauncher.launchFailureFields(error, phase: phase, health: .blocked)
                XCTAssertEqual(fields, ["event": "app.launch.failed", "phase": phase.rawValue,
                    "errorCode": code, "hostHealthState": "blocked"])
                XCTAssertFalse(fields.values.contains(where: { $0.contains(secret) }))
            }
        }
    }
}
