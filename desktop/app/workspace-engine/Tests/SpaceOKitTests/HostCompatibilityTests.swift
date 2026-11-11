import Foundation
import SpaceOPrivate
import XCTest
@testable import SpaceOKit

final class HostCompatibilityTests: XCTestCase {

    func testRuntimeCapabilitiesFollowRequiredSymbolAndClassInventory() {
        let missing = Set(SPOMissingSymbols())
        let virtualDisplayClasses = [
            "CGVirtualDisplay",
            "CGVirtualDisplayDescriptor",
            "CGVirtualDisplayMode",
            "CGVirtualDisplaySettings",
        ]
        let expected: [SPOCapability: Bool] = [
            .virtualDisplay:
                virtualDisplayClasses.allSatisfy { NSClassFromString($0) != nil },
            .focusWithoutRaise: false,
            .spaceQuery:
                [
                    "SLSMainConnectionID",
                    "SLSCopyManagedDisplaySpaces",
                    "SLSCopySpacesForWindows",
                    "SLSGetActiveSpace",
                    "SLSGetWindowBounds",
                ].allSatisfy { !missing.contains($0) },
            .perPIDEvents:
                !missing.contains("CGEventPostToPid"),
            .axWindowID:
                !missing.contains("_AXUIElementGetWindow"),
        ]

        for (capability, available) in expected {
            XCTAssertEqual(
                SPOCapabilityAvailable(capability),
                available,
                "\(SPOCapabilityName(capability)) did not match its runtime inventory"
            )
        }
    }

    func testUnavailableReasonsOnlyDescribeMissingRuntimeBehavior() {
        for capability: SPOCapability in [
            .virtualDisplay,
            .focusWithoutRaise,
            .spaceQuery,
            .perPIDEvents,
            .axWindowID,
        ] {
            let reason = SPOCapabilityUnavailableReason(capability)
            if SPOCapabilityAvailable(capability) {
                XCTAssertNil(reason)
            } else {
                if capability == .focusWithoutRaise {
                    XCTAssertTrue(reason?.contains("incompatible private focus-record") == true)
                } else {
                    XCTAssertTrue(
                        reason?.contains("missing a required symbol or Objective-C class") == true
                    )
                }
                XCTAssertFalse(reason?.contains("qualified") == true)
                XCTAssertFalse(reason?.contains("unsupported host") == true)
            }
        }
    }

    func testCapabilitiesCanDriveWheneverRequiredRuntimeSurfacesAndAccessibilityExist() {
        let capabilities = Capabilities()
        let required = [
            "virtual-display",
            "space-query",
            "per-pid-events",
            "ax-window-id",
            "accessibility",
        ]
        let expected = capabilities.builtWithARC
            && required.allSatisfy { name in
                capabilities.items.first { $0.name == name }?.available == true
            }
        XCTAssertEqual(capabilities.canDrive, expected)
        XCTAssertFalse(capabilities.report.contains("qualified"))
        XCTAssertFalse(capabilities.report.contains("registry"))
    }
}
