import Darwin
import XCTest
@testable import SpaceOKit

final class BoundedRegularFileTests: XCTestCase {
    private func withDirectory(_ body: (URL) throws -> Void) throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("spaceo-bounded-file-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        try body(directory)
    }

    func testReadsEmptyExactLimitAndMultipleChunks() throws {
        try withDirectory { directory in
            let file = directory.appendingPathComponent("config")
            for size in [0, 1, 16_384, 32_769] {
                let data = Data(repeating: 65, count: size)
                try data.write(to: file)
                XCTAssertEqual(try BoundedRegularFile.read(file, maximumBytes: size), data)
            }
        }
    }

    func testRefusesOversizedFileBeforeReturningAnyData() throws {
        try withDirectory { directory in
            let file = directory.appendingPathComponent("config")
            let size = MCPClientConfig.maximumConfigBytes + 1
            try Data(repeating: 65, count: size).write(to: file)
            XCTAssertThrowsError(try MCPClientConfig.readExisting(at: file)) {
                XCTAssertEqual($0 as? MCPClientConfigError, .tooLarge(size))
            }
            XCTAssertThrowsError(try BoundedRegularFile.read(file, maximumBytes: 0)) {
                XCTAssertEqual($0 as? BoundedRegularFile.ReadError, .tooLarge(size))
            }
            XCTAssertEqual(SetupProgressStore(url: file).load(), SetupProgress())
        }
    }

    func testRefusesDirectoriesAndPipesWithoutBlocking() throws {
        try withDirectory { directory in
            let pipe = directory.appendingPathComponent("pipe")
            XCTAssertEqual(mkfifo(pipe.path, 0o600), 0)
            for file in [directory, pipe] {
                XCTAssertThrowsError(try BoundedRegularFile.read(file, maximumBytes: 100)) {
                    XCTAssertEqual($0 as? BoundedRegularFile.ReadError, .unreadable)
                }
                XCTAssertThrowsError(try MCPClientConfig.readExisting(at: file)) {
                    XCTAssertEqual($0 as? MCPClientConfigError, .unreadable(file.path))
                }
                XCTAssertNil(MCPClientInspection.boundedRead(file))
                XCTAssertEqual(SetupProgressStore(url: file).load(), SetupProgress())
            }
        }
    }

    func testMissingAndDanglingSymlinksRemainDistinct() throws {
        try withDirectory { directory in
            let file = directory.appendingPathComponent("config")
            let link = directory.appendingPathComponent("link")
            try FileManager.default.createSymbolicLink(at: link, withDestinationURL: file)
            XCTAssertNil(try MCPClientConfig.readExisting(at: file))
            XCTAssertThrowsError(try MCPClientConfig.readExisting(at: link)) {
                XCTAssertEqual($0 as? MCPClientConfigError, .unreadable(link.path))
            }
            try Data("valid UTF-8 é".utf8).write(to: file)
            XCTAssertEqual(try MCPClientConfig.readExisting(at: link), "valid UTF-8 é")
            XCTAssertEqual(MCPClientInspection.boundedRead(link), "valid UTF-8 é")
        }
    }

    func testInvalidUTF8DoesNotBecomeMissingConfiguration() throws {
        try withDirectory { directory in
            let file = directory.appendingPathComponent("config")
            try Data([0xff]).write(to: file)
            XCTAssertThrowsError(try MCPClientConfig.readExisting(at: file))
            XCTAssertNil(MCPClientInspection.boundedRead(file))
        }
    }
}
