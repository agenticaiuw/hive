import Darwin
import XCTest
@testable import SpaceOKit

final class RuntimeIdentityFileTests: XCTestCase {
    private func withDirectory(_ body: (URL) throws -> Void) throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("spaceo-identity-file-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: directory) }
        try body(directory)
    }

    func testFullDigestFollowsRegularSymlinkAndDoesNotCacheReplacedContents() throws {
        try withDirectory { directory in
            let file = directory.appendingPathComponent("executable")
            let link = directory.appendingPathComponent("alias")
            try Data("abc".utf8).write(to: file)
            try FileManager.default.createSymbolicLink(at: link, withDestinationURL: file)
            XCTAssertEqual(RuntimeIdentity.currentExecutableSHA256(executableURL: link),
                           "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
            try Data().write(to: file, options: .atomic)
            XCTAssertEqual(RuntimeIdentity.currentExecutableSHA256(executableURL: link),
                           "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
        }
    }

    func testOversizedExecutableIsUnknownRatherThanAPrefixDigest() throws {
        try withDirectory { directory in
            let file = directory.appendingPathComponent("oversized")
            let descriptor = open(file.path, O_CREAT | O_EXCL | O_RDWR | O_CLOEXEC, 0o600)
            XCTAssertGreaterThanOrEqual(descriptor, 0)
            guard descriptor >= 0 else { return }
            defer { close(descriptor) }
            XCTAssertEqual(ftruncate(descriptor, off_t(RuntimeIdentity.maximumExecutableBytes + 1)), 0)
            XCTAssertNil(RuntimeIdentity.currentExecutableSHA256(executableURL: file))
        }
    }

    func testNonRegularMissingAndNonFilePathsAreUnknown() throws {
        try withDirectory { directory in
            let fifo = directory.appendingPathComponent("pipe")
            XCTAssertEqual(mkfifo(fifo.path, 0o600), 0)
            XCTAssertNil(RuntimeIdentity.currentExecutableSHA256(executableURL: fifo))
            XCTAssertNil(RuntimeIdentity.currentExecutableSHA256(executableURL: directory))
            XCTAssertNil(RuntimeIdentity.currentExecutableSHA256(executableURL: directory.appendingPathComponent("missing")))
            XCTAssertNil(RuntimeIdentity.currentExecutableSHA256(executableURL: URL(string: "https://example.invalid/executable")))
            XCTAssertNil(RuntimeIdentity.currentExecutableSHA256(executableURL: nil))
        }
    }
}
