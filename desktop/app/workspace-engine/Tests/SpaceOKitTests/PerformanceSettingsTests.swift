import Darwin
import Foundation
import XCTest
@testable import SpaceOKit

final class PerformanceSettingsTests: XCTestCase {
    func testBoundedSettingsPreserveExactLimitAndRejectOversizeAndSpecialFiles() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: directory) }
        let file = directory.appendingPathComponent("settings.json")
        var data = try JSONEncoder().encode(LoggingSettings(requestMetrics: true))
        data.append(Data(repeating: 32, count: 16_384 - data.count))
        try data.write(to: file)
        XCTAssertEqual(LoggingSettings.readSettingsData(file)?.count, 16_384)
        XCTAssertTrue(LoggingSettings.resolve(environment: [:], fileURL: file).settings.requestMetrics)
        let handle = try FileHandle(forWritingTo: file)
        try handle.truncate(atOffset: 64 * 1_048_576)
        try handle.close()
        XCTAssertNil(LoggingSettings.readSettingsData(file))
        XCTAssertFalse(LoggingSettings.resolve(environment: [:], fileURL: file).fileExists)
        XCTAssertNil(LoggingSettings.readSettingsData(directory))
        let pipe = directory.appendingPathComponent("pipe")
        XCTAssertEqual(mkfifo(pipe.path, 0o600), 0)
        XCTAssertNil(LoggingSettings.readSettingsData(pipe))
    }
}
