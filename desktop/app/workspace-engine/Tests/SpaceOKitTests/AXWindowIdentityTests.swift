import XCTest
import SpaceOPrivate

final class AXWindowIdentityTests: XCTestCase {
    func testInvalidArgumentsClearOutputWithoutCallingTheWindowServer() {
        var id: UInt32 = 42
        XCTAssertEqual(SPOGetWindowIDForAXElement(nil, &id), .illegalArgument)
        XCTAssertEqual(id, 0)
        XCTAssertEqual(SPOGetWindowIDForAXElement(nil, nil), .illegalArgument)
    }
}
