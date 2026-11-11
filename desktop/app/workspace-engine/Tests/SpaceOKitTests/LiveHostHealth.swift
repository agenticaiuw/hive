import Foundation
import Darwin
import SpaceOKit

/// Only launches the read-only health helper, never a display owner. Its output is retained
/// by the live supervisor; helper failures must not admit a case or suspend verified cleanup.
enum LiveHostHealth {
    enum Failure: Error {
        case missingHelper, refused, timedOut, nativeNotReady
    }

    /// Helper success cannot clear or substitute for the runtime's sticky circuit.
    static func requireNativeReadiness(
        lifecycle: DisplaySafetyStatus = Stage.displaySafetyStatus(),
        health: DisplayHostHealthReport = Stage.runtimeHostHealthReport()
    ) throws {
        // A case that never creates a Stage never starts the native sampler. Stage
        // creation requires ready health before mutation; do not reject pure refusal cases.
        let unused = health.state == .unknown && health.reasons == ["not_sampled"]
        guard lifecycle.allowsCreation, health.state == .ready || unused else { throw Failure.nativeNotReady }
    }

    static func requireAdmission(scriptPath: String? = ProcessInfo.processInfo.environment["SPACEO_LIVE_HEALTH_SCRIPT"]) throws {
        guard let scriptPath, scriptPath.hasPrefix("/"), !scriptPath.contains("\0") else {
            throw Failure.missingHelper
        }
        try run(executable: "/usr/bin/env", arguments: ["python3", scriptPath])
    }

    static func run(executable: String, arguments: [String], timeout: TimeInterval = 35) throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = FileHandle.standardOutput
        process.standardError = FileHandle.nullDevice
        try process.run()
        let deadline = ProcessInfo.processInfo.systemUptime + timeout
        while process.isRunning, ProcessInfo.processInfo.systemUptime < deadline {
            Thread.sleep(forTimeInterval: 0.02)
        }
        guard !process.isRunning else {
            // This process owns no display. Never apply this shutdown policy to XCTest.
            kill(process.processIdentifier, SIGKILL)
            let reapDeadline = ProcessInfo.processInfo.systemUptime + 1
            while process.isRunning, ProcessInfo.processInfo.systemUptime < reapDeadline {
                Thread.sleep(forTimeInterval: 0.02)
            }
            throw Failure.timedOut
        }
        guard process.terminationReason == .exit, process.terminationStatus == 0 else {
            throw Failure.refused
        }
    }
}
