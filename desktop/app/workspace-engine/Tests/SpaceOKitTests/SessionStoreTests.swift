import XCTest
import Darwin
@testable import SpaceOKit

final class SessionStoreTests: XCTestCase {

    func testEncodedSizeLimitIncludesTrailingNewline() {
        XCTAssertTrue(
            SessionStore.encodedLedgerFits(
                byteCount: SessionStore.maximumLedgerBytes - 1))
        XCTAssertFalse(
            SessionStore.encodedLedgerFits(
                byteCount: SessionStore.maximumLedgerBytes))
    }

    private struct InjectedWriteFailure: Error {}

    private func temporaryStateRoot() throws -> (container: URL, root: URL) {
        let container = FileManager.default.temporaryDirectory
            .appendingPathComponent(
                "spaceo-session-store-tests-\(UUID().uuidString)",
                isDirectory: true)
        try FileManager.default.createDirectory(
            at: container,
            withIntermediateDirectories: false,
            attributes: [.posixPermissions: 0o700])
        return (
            container,
            container.appendingPathComponent("state", isDirectory: true))
    }

    private func fixedUUID(_ value: String) -> UUID {
        UUID(uuidString: value)!
    }

    private func makeLedger(sessionPrefix: String = "agent") -> SessionLedger {
        let created = Date(timeIntervalSince1970: 1_700_000_000)
        let heartbeat = Date(timeIntervalSince1970: 1_700_000_030)
        let expires = Date(timeIntervalSince1970: 1_700_000_300)
        let updated = Date(timeIntervalSince1970: 1_700_000_060)
        let daemonID = fixedUUID("00000000-0000-0000-0000-000000000001")

        let owner = DurableSessionOwner(
            id: "mcp-controller-1",
            kind: .mcp,
            label: "Codex MCP",
            processIdentity: ProcessIdentity(
                pid: 4_001,
                startedAtMicroseconds: 1_700_000_000_123_456))
        let lease = DurableSessionLease(
            daemonInstanceID: daemonID,
            leaseID: fixedUUID("00000000-0000-0000-0000-000000000002"),
            generation: 7,
            acquiredAt: created,
            lastHeartbeatAt: heartbeat,
            expiresAt: expires)
        let launched = DurableSessionApp(
            identity: ProcessIdentity(
                pid: 5_001,
                startedAtMicroseconds: 1_700_000_010_000_001),
            provenance: .launched,
            bundleIdentifier: "com.example.Browser",
            name: "Browser",
            url: URL(fileURLWithPath: "/Applications/Browser.app"),
            devToolsPort: 49_123,
            temporaryProfile: URL(
                fileURLWithPath: "/private/tmp/spaceo-browser-test-profile",
                isDirectory: true),
            temporaryControlRoot: URL(
                fileURLWithPath: "/private/tmp/spaceo-e-test-control",
                isDirectory: true))
        let owned = DurableSessionRecord(
            id: "\(sessionPrefix)-1",
            revision: 4,
            createdAt: created,
            updatedAt: updated,
            ownershipState: .owned,
            runtimeState: .attached,
            operationState: .ready,
            recoveryState: .notNeeded,
            owner: owner,
            lease: lease,
            lastKnownPlacement: DurableSessionPlacement(
                displayID: 80_001,
                x: 0,
                y: 0,
                width: 1_280,
                height: 800,
                tileIndex: 0,
                tileCapacity: 2,
                exclusiveDisplay: false),
            apps: [launched])

        let adoptedIdentity = ProcessIdentity(
            pid: 5_002,
            startedAtMicroseconds: 1_700_000_020_000_002)
        let adopted = DurableSessionApp(
            identity: adoptedIdentity,
            provenance: .adopted,
            bundleIdentifier: "com.example.Editor",
            name: "Editor",
            url: URL(fileURLWithPath: "/Applications/Editor.app"))
        let blocked = DurableSessionRecord(
            id: "\(sessionPrefix)-2",
            revision: 9,
            createdAt: created,
            updatedAt: updated,
            ownershipState: .abandoned,
            runtimeState: .detached,
            operationState: .cleanupPending,
            recoveryState: .blocked,
            recoveryBlockers: [
                DurableRecoveryBlocker(
                    code: "cleanup_pending",
                    message: "Teardown must complete before this session can be reclaimed.",
                    processIdentity: adoptedIdentity),
            ],
            owner: nil,
            lease: nil,
            lastKnownPlacement: nil,
            apps: [adopted])

        return SessionLedger(
            storeRevision: 11,
            writerDaemonInstanceID: daemonID,
            updatedAt: updated,
            nextAutomaticSessionNumber: 3,
            sessions: [owned, blocked])
    }

    private func overwrite(_ url: URL, with data: Data) throws {
        let handle = try FileHandle(forWritingTo: url)
        defer { try? handle.close() }
        try handle.truncate(atOffset: 0)
        try handle.write(contentsOf: data)
        try handle.synchronize()
    }

    func testRoundTripPreservesRecoveryLeaseIdentityAndAppProvenance() throws {
        let paths = try temporaryStateRoot()
        defer { try? FileManager.default.removeItem(at: paths.container) }
        let store = try SessionStore(rootDirectory: paths.root, namespace: "round-trip")
        let expected = makeLedger()

        try store.save(expected)
        let loaded = try XCTUnwrap(store.load())

        XCTAssertEqual(loaded, expected)
        XCTAssertEqual(
            loaded.sessions[0].apps[0].identity,
            ProcessIdentity(
                pid: 5_001,
                startedAtMicroseconds: 1_700_000_010_000_001))
        XCTAssertEqual(loaded.sessions[0].apps[0].provenance, .launched)
        XCTAssertEqual(loaded.sessions[1].apps[0].provenance, .adopted)
        XCTAssertEqual(loaded.sessions[0].lease?.generation, 7)
        XCTAssertEqual(loaded.sessions[1].recoveryState, .blocked)
        XCTAssertEqual(loaded.sessions[1].recoveryBlockers.first?.code, "cleanup_pending")
    }

    func testCreatesPrivateDirectoryAndLedgerPermissions() throws {
        let paths = try temporaryStateRoot()
        defer { try? FileManager.default.removeItem(at: paths.container) }
        let store = try SessionStore(rootDirectory: paths.root, namespace: "permissions")

        try store.save(makeLedger())

        var directoryInfo = stat()
        XCTAssertEqual(lstat(paths.root.path, &directoryInfo), 0)
        XCTAssertEqual(directoryInfo.st_mode & S_IFMT, S_IFDIR)
        XCTAssertEqual(Int(directoryInfo.st_mode & 0o777), 0o700)

        var ledgerInfo = stat()
        XCTAssertEqual(lstat(store.ledgerURL.path, &ledgerInfo), 0)
        XCTAssertEqual(ledgerInfo.st_mode & S_IFMT, S_IFREG)
        XCTAssertEqual(Int(ledgerInfo.st_mode & 0o777), 0o600)
        XCTAssertEqual(ledgerInfo.st_uid, geteuid())
    }

    func testFailedReplacementLeavesPreviousLedgerIntactAndRemovesTemporaryFile() throws {
        let paths = try temporaryStateRoot()
        defer { try? FileManager.default.removeItem(at: paths.container) }
        let working = try SessionStore(rootDirectory: paths.root, namespace: "atomic")
        let original = makeLedger()
        try working.save(original)

        var replacement = makeLedger()
        replacement.storeRevision = 12
        replacement.updatedAt = Date(timeIntervalSince1970: 1_700_000_120)
        for index in replacement.sessions.indices {
            replacement.sessions[index].revision += 1
            replacement.sessions[index].updatedAt = replacement.updatedAt
        }
        let failing = try SessionStore(
            rootDirectory: paths.root,
            namespace: "atomic",
            beforeReplace: { _, _ in throw InjectedWriteFailure() })

        XCTAssertThrowsError(try failing.save(replacement)) { error in
            guard case SessionStoreError.writeFailed = error else {
                return XCTFail("expected writeFailed, got \(error)")
            }
        }
        XCTAssertEqual(try working.load(), original)

        let leftovers = try FileManager.default.contentsOfDirectory(
            at: paths.root,
            includingPropertiesForKeys: nil)
            .filter { $0.pathExtension == "tmp" }
        XCTAssertTrue(leftovers.isEmpty, "failed writes must not leave temporary ledgers")

        try working.save(replacement)
        XCTAssertEqual(try working.load(), replacement)
    }

    func testCorruptLedgerFailsClosedInsteadOfLoadingAsEmpty() throws {
        let paths = try temporaryStateRoot()
        defer { try? FileManager.default.removeItem(at: paths.container) }
        let store = try SessionStore(rootDirectory: paths.root, namespace: "corrupt")
        try store.save(makeLedger())
        try overwrite(store.ledgerURL, with: Data(#"{"schemaVersion":"broken""#.utf8))

        XCTAssertThrowsError(try store.load()) { error in
            guard case SessionStoreError.corruptLedger = error else {
                return XCTFail("expected corruptLedger, got \(error)")
            }
        }
    }

    func testUnsupportedSchemaFailsClosedBeforePayloadDecoding() throws {
        let paths = try temporaryStateRoot()
        defer { try? FileManager.default.removeItem(at: paths.container) }
        let store = try SessionStore(rootDirectory: paths.root, namespace: "future")
        try store.save(makeLedger())
        try overwrite(store.ledgerURL, with: Data(#"{"schemaVersion":999}"#.utf8))

        XCTAssertThrowsError(try store.load()) { error in
            XCTAssertEqual(
                error as? SessionStoreError,
                .unsupportedSchema(
                    found: 999,
                    supported: SessionLedger.currentSchemaVersion))
        }
    }

    func testSocketNamespacesAreStableAndIsolateLedgersInOneDirectory() throws {
        let paths = try temporaryStateRoot()
        defer { try? FileManager.default.removeItem(at: paths.container) }
        let firstSocket = "/private/tmp/spaceo-\(UUID().uuidString)-a.sock"
        let secondSocket = "/private/tmp/spaceo-\(UUID().uuidString)-b.sock"
        let first = try SessionStore(socketPath: firstSocket, rootDirectory: paths.root)
        let sameFirst = try SessionStore(socketPath: firstSocket, rootDirectory: paths.root)
        let second = try SessionStore(socketPath: secondSocket, rootDirectory: paths.root)

        XCTAssertEqual(first.namespace, sameFirst.namespace)
        XCTAssertEqual(first.ledgerURL, sameFirst.ledgerURL)
        XCTAssertNotEqual(first.namespace, second.namespace)
        XCTAssertNotEqual(first.ledgerURL, second.ledgerURL)

        let firstLedger = makeLedger(sessionPrefix: "first")
        var secondLedger = makeLedger(sessionPrefix: "second")
        secondLedger.storeRevision = 22
        try first.save(firstLedger)
        try second.save(secondLedger)

        XCTAssertEqual(try first.load(), firstLedger)
        XCTAssertEqual(try second.load(), secondLedger)
    }

    func testInvalidDurableStateIsRejectedBeforeReplacingAValidLedger() throws {
        let paths = try temporaryStateRoot()
        defer { try? FileManager.default.removeItem(at: paths.container) }
        let store = try SessionStore(rootDirectory: paths.root, namespace: "validation")
        let valid = makeLedger()
        try store.save(valid)

        var invalid = makeLedger()
        invalid.sessions[1].apps[0].identity = invalid.sessions[0].apps[0].identity

        XCTAssertThrowsError(try store.save(invalid)) { error in
            guard case SessionStoreError.invalidLedger = error else {
                return XCTFail("expected invalidLedger, got \(error)")
            }
        }
        XCTAssertEqual(try store.load(), valid)
    }
}
