import Foundation
import XCTest
@testable import SpaceOKit

/// One controller identity for tests that drive `SessionManager.handle` like a socket client.
///
/// `session.create` over the request path requires a controller owner (SPAO-147), and a session
/// created with one requires its lease on every owner-scoped mutation and session-scoped read.
/// Tests exercising unrelated behavior route through here so they stay a well-formed client
/// with one line, and tests about authorization itself construct their own identities.
enum TestController {

    static let leaseID = UUID(uuidString: "F0E1D2C3-B4A5-9687-7869-5A4B3C2D1E0F")!

    static func owner(id: String = "unit-test-controller") -> DurableSessionOwner {
        DurableSessionOwner(
            id: id,
            kind: .other,
            label: "unit test controller")
    }

    /// A `session.create` carrying the mandatory owner and this controller's fixed lease.
    static func createRequest(
        session: String? = nil,
        ownerID: String = "unit-test-controller",
        leaseID: UUID = TestController.leaseID
    ) -> Request {
        var request = Request(cmd: "session.create")
        request.session = session
        request.controllerOwner = owner(id: ownerID)
        request.controllerLeaseID = leaseID
        return request
    }

    /// Any follow-up command authorized by this controller's fixed lease.
    static func request(
        _ cmd: String,
        session: String? = nil,
        leaseID: UUID = TestController.leaseID
    ) -> Request {
        var request = Request(cmd: cmd)
        request.session = session
        request.controllerLeaseID = leaseID
        return request
    }
}


/// Explicit empty geometry for process/ledger tests; never fall back to the host's AX provider.
extension SessionWindowDriver {
    static let windowlessForTesting = SessionWindowDriver(
        windows: { _ in [] }, userDisplayBounds: { nil },
        move: { _, _ in XCTFail("windowless process fixture must not move windows") },
        liveBounds: { _ in nil })
}
