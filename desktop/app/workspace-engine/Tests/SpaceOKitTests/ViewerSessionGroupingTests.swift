import CoreGraphics
import XCTest
@testable import SpaceOKit
@testable import SpaceOViewer

/// SPAO-218. Titles, colour tags and controller grouping are what make three agents from two
/// clients tellable apart in the navigator.
final class ViewerSessionGroupingTests: XCTestCase {

    private func session(
        id: String,
        createdAt: String,
        owner: (id: String, label: String)? = nil,
        title: String? = nil,
        colorTag: String? = nil
    ) throws -> SessionInfo {
        let ownerJSON = owner.map {
            "\"controllerOwner\":{\"id\":\"\($0.id)\",\"kind\":\"mcp\",\"label\":\"\($0.label)\"},"
        } ?? ""
        let titleJSON = title.map { "\"title\":\"\($0)\"," } ?? ""
        let colorJSON = colorTag.map { "\"colorTag\":\"\($0)\"," } ?? ""
        let json = """
        {
          "id":"\(id)","displayID":7,"x":0,"y":0,"width":100,"height":100,
          "tileIndex":0,"tileCapacity":1,"exclusiveDisplay":true,
          "spaces":[],"hasOwnSpace":false,"apps":[],"windows":[],
          \(ownerJSON)\(titleJSON)\(colorJSON)
          "createdAt":"\(createdAt)","teardownPending":false,"runtimeAttached":true
        }
        """
        return try Wire.decoder.decode(SessionInfo.self, from: Data(json.utf8))
    }

    func testSessionsGroupByControllerLabelAndSortByCreation() throws {
        let sessions = [
            try session(id: "c2", createdAt: "2026-07-30T00:00:05Z", owner: ("cursor-1", "Cursor")),
            try session(id: "a1", createdAt: "2026-07-30T00:00:03Z", owner: ("claude-1", "Claude Code")),
            try session(id: "c1", createdAt: "2026-07-30T00:00:01Z", owner: ("cursor-1", "Cursor")),
            try session(id: "orphan", createdAt: "2026-07-30T00:00:00Z"),
            try session(id: "blank", createdAt: "2026-07-30T00:00:02Z", owner: ("cli-9", "  ")),
        ]

        let groups = ViewerSessionGrouping.groups(sessions)

        XCTAssertEqual(groups.map(\.label), ["Claude Code", "cli-9", "Cursor", "No controller"],
                       "labels sort case-insensitively; a blank label falls back to the id; "
                       + "unowned sessions come last")
        XCTAssertEqual(groups[2].sessions.map(\.id), ["c1", "c2"],
                       "inside a group, oldest first")
        XCTAssertEqual(groups.last?.sessions.map(\.id), ["orphan"])
    }

    func testGroupKeysAreStableAcrossLabelCase() throws {
        let groups = ViewerSessionGrouping.groups([
            try session(id: "a", createdAt: "2026-07-30T00:00:00Z", owner: ("x", "Codex")),
            try session(id: "b", createdAt: "2026-07-30T00:00:01Z", owner: ("y", "codex")),
        ])
        XCTAssertEqual(groups.count, 1, "the same client with different casing is one group")
        XCTAssertEqual(groups.first?.sessions.map(\.id), ["a", "b"])
    }

    func testDisplayTitleFallsBackToTheIdentifier() throws {
        let titled = try session(id: "s1", createdAt: "2026-07-30T00:00:00Z", title: " Booking flight to SFO ")
        XCTAssertEqual(ViewerSessionGrouping.displayTitle(titled), "Booking flight to SFO")
        XCTAssertTrue(ViewerSessionGrouping.showsIdentifier(titled))

        let blank = try session(id: "s2", createdAt: "2026-07-30T00:00:00Z", title: "   ")
        XCTAssertEqual(ViewerSessionGrouping.displayTitle(blank), "s2")
        XCTAssertFalse(ViewerSessionGrouping.showsIdentifier(blank))
    }

    func testNormalizedTitleIsOneBoundedLine() {
        XCTAssertNil(ViewerSessionGrouping.normalizedTitle("  \n "))
        XCTAssertEqual(ViewerSessionGrouping.normalizedTitle("two\nlines"), "two lines")
        XCTAssertEqual(
            ViewerSessionGrouping.normalizedTitle(String(repeating: "x", count: 500))?.count, 120)
    }

    func testColourTagsAreTheSevenNamedColoursAndUnknownIsIgnored() throws {
        XCTAssertEqual(ViewerSessionColorTag.allCases.map(\.rawValue),
                       ["red", "orange", "yellow", "green", "blue", "purple", "gray"])
        XCTAssertEqual(ViewerSessionColorTag(wire: "Purple"), .purple)
        XCTAssertNil(ViewerSessionColorTag(wire: "chartreuse"))
        XCTAssertNil(ViewerSessionColorTag(wire: nil))
        let tagged = try session(id: "t", createdAt: "2026-07-30T00:00:00Z", colorTag: "green")
        XCTAssertEqual(ViewerSessionColorTag(wire: tagged.colorTag), .green)
    }

    // MARK: - Annotate request shape

    private final class RequestRecorder: @unchecked Sendable {
        private let lock = NSLock()
        private var storage: [Request] = []
        func append(_ request: Request) { lock.withLock { storage.append(request) } }
        var requests: [Request] { lock.withLock { storage } }
    }

    @MainActor
    func testRenameAndColourSendOperatorScopedAnnotate() async throws {
        let recorder = RequestRecorder()
        let model = ViewerModel(
            automaticRefresh: false,
            daemonTransport: { request in recorder.append(request); return .success() },
            accessibilityAnnouncement: { _ in })

        model.annotateSession("research", title: .some(" Booking flight to SFO\n"))
        model.annotateSession("research", colorTag: .some(.blue))
        model.annotateSession("research", colorTag: .some(nil))
        model.annotateSession("research", title: .some(nil))
        model.annotateSession("research")

        let deadline = Date().addingTimeInterval(2)
        while recorder.requests.filter({ $0.cmd == "session.annotate" }).count < 4,
              Date() < deadline {
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        let requests = recorder.requests.filter { $0.cmd == "session.annotate" }
        XCTAssertEqual(requests.count, 4, "a call that changes nothing sends nothing")
        XCTAssertTrue(requests.allSatisfy { $0.session == "research" && $0.operatorScope == true })
        // Each call is its own detached send, so compare the set of shapes, not their order.
        let shapes = Set(requests.map { "\($0.title ?? "<nil>")|\($0.colorTag ?? "<nil>")" })
        XCTAssertEqual(shapes, [
            "Booking flight to SFO|<nil>",   // rename, one line, trimmed
            "<nil>|blue",                    // colour only
            "<nil>|none",                    // clearing a colour is explicit
            "|<nil>",                        // clearing a title is explicit
        ])
    }
}
