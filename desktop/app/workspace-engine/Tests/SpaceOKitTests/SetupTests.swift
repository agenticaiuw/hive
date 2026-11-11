import XCTest
import CoreGraphics
@testable import SpaceOKit

/// The guided first-run path.
///
/// The property that matters is ordering and blame: a missing runtime API, a denied permission,
/// and an absent daemon have completely different remedies, and a report that flattens them
/// sends a new user to fix the wrong thing.
final class SetupTests: XCTestCase {
    private func capability(_ name: String, _ available: Bool) -> Capabilities.Item {
        Capabilities.Item(
            name: name, available: available, detail: "", unavailableReason: nil)
    }

    private func environment(
        accessibility: Bool = true,
        screenRecording: Bool = true,
        runtimeAvailable: Bool = true,
        daemonRunning: Bool = true
    ) -> Setup.Environment {
        Setup.Environment(
            executablePath: "/opt/spaceo/bin/spaceo",
            accessibility: accessibility,
            screenRecording: screenRecording,
            runtimeCapabilities: Setup.requiredRuntimeCapabilities.map {
                capability($0, runtimeAvailable)
            },
            daemonRunning: daemonRunning,
            socketPath: "/tmp/spaceo-test.sock")
    }

    func testAFullyProvisionedHostPassesEveryPrerequisite() {
        let steps = Setup.prerequisites(environment())
        XCTAssertTrue(steps.allSatisfy { $0.status == .pass })
        XCTAssertTrue(Setup.canSelfTest(steps))
    }

    func testEveryFailingStepCarriesItsOwnRemedy() {
        let steps = Setup.prerequisites(
            environment(accessibility: false, screenRecording: false, runtimeAvailable: false))
        let failures = steps.filter { $0.status == .fail }
        XCTAssertEqual(failures.count, 3)
        for failure in failures {
            XCTAssertNotNil(failure.remedy, "\(failure.name) failed without telling anyone why")
        }
    }

    func testPrerequisitesAreReportedInDependencyOrder() {
        let names = Setup.prerequisites(environment()).map(\.name)
        XCTAssertEqual(names, ["runtime apis", "accessibility", "screen recording", "daemon"])
    }

    func testAMissingDaemonIsNotAFailure() {
        let steps = Setup.prerequisites(environment(daemonRunning: false))
        let daemon = steps.first { $0.name == "daemon" }
        XCTAssertEqual(daemon?.status, .skipped)
        XCTAssertTrue(
            Setup.canSelfTest(steps),
            "setup starts a daemon the way an MCP client does, so its absence is not a blocker")
    }

    func testADeniedPermissionBlocksTheSelfTest() {
        XCTAssertFalse(
            Setup.canSelfTest(Setup.prerequisites(environment(accessibility: false))),
            "running the self-test anyway replaces a precise message with a vaguer one")
    }

    func testTheAccessibilityRemedyNamesTheHostProgramNotTheBinary() {
        let steps = Setup.prerequisites(environment(accessibility: false))
        let remedy = steps.first { $0.name == "accessibility" }?.remedy ?? ""
        XCTAssertTrue(
            remedy.contains("terminal"),
            "TCC attaches the grant to the program that runs spaceo, which trips up every new user")
    }

    func testClientConfigurationUsesTheResolvedAbsolutePath() {
        let snippet = Setup.clientConfiguration(executablePath: "/opt/spaceo/bin/spaceo")
        XCTAssertTrue(snippet.contains("/opt/spaceo/bin/spaceo"))
        // A tilde is fine when it names a config file the reader opens themselves; it is not
        // fine as the command these clients exec, because they do not all expand it.
        XCTAssertFalse(snippet.contains(#"command = "~"#))
        XCTAssertFalse(snippet.contains(#""command": "~"#))
        XCTAssertFalse(snippet.contains(#"-- "~"#))
        for client in ["claude mcp add", "mcp_servers.spaceo", "mcpServers"] {
            XCTAssertTrue(snippet.contains(client), "missing registration for \(client)")
        }
    }

    func testTheReportShowsRemediesForFailuresOnly() {
        let report = Setup.report(steps: Setup.prerequisites(environment(screenRecording: false)))
        XCTAssertTrue(report.contains("MISS"))
        XCTAssertTrue(report.contains("Screen & System Audio Recording"))
    }
    func testMissingARCFailsBeforeCreatingADisplay() {
        var env = environment()
        env.builtWithARC = false
        XCTAssertFalse(Setup.canSelfTest(Setup.prerequisites(env)))
    }

    private func runtime(build: String? = "build", hash: String? = "hash",
                         drive: Bool? = true, capture: Bool? = true) -> DaemonRuntimeInfo {
        DaemonRuntimeInfo(version: "test", executableSHA256: hash,
            executableBuildUUID: build, pid: 1, instanceID: UUID(), startedAt: Date(),
            canDrive: drive, canCapture: capture)
    }

    private func daemonChecks(_ runtime: DaemonRuntimeInfo?) -> [SetupStep] {
        var response = Response(ok: true)
        response.daemon = runtime
        return Setup.daemonChecks(response: response, executableBuildUUID: "build",
            executableSHA256: "hash", socketPath: "/tmp/unused.sock")
    }

    func testMatchingDaemonWithDifferentSignaturePasses() {
        XCTAssertTrue(daemonChecks(runtime(hash: "signed-helper-hash"))
            .allSatisfy { $0.status == .pass })
    }

    func testStaleDaemonCannotQualifyTheCurrentInstall() {
        XCTAssertFalse(Setup.canSelfTest(daemonChecks(runtime(build: "old-build"))))
    }

    func testLegacyDaemonWithUnknownProvenanceAndPermissionsFailsClosed() {
        XCTAssertFalse(Setup.canSelfTest(daemonChecks(nil)))
        XCTAssertFalse(Setup.canSelfTest(daemonChecks(runtime(drive: nil, capture: nil))))
    }

    func testDaemonPermissionsAreNotInferredFromTheCaller() {
        for daemon in [runtime(drive: false), runtime(capture: false)] {
            XCTAssertFalse(Setup.canSelfTest(daemonChecks(daemon)))
        }
    }

    func testIdentityFallsBackToHashOnlyWhenUUIDIsUnavailable() {
        XCTAssertEqual(RuntimeIdentity.matches(runtime(build: nil),
            executableBuildUUID: "build", executableSHA256: "hash"), true)
        XCTAssertEqual(RuntimeIdentity.matches(runtime(build: "old"),
            executableBuildUUID: "build", executableSHA256: "hash"), false)
        XCTAssertNil(RuntimeIdentity.matches(nil,
            executableBuildUUID: "build", executableSHA256: "hash"))
    }

    func testIdentityComparisonOnlyLoadsHashWhenFallbackCanBeUsed() {
        let cases: [(DaemonRuntimeInfo?, String?, String?, Bool?, Int)] = [
            (runtime(), "build", "different hash", true, 0),
            (runtime(build: "other"), "build", "hash", false, 0),
            (nil, "build", "hash", nil, 0),
            (runtime(build: nil, hash: nil), "build", "hash", nil, 0),
            (runtime(build: nil), "build", "hash", true, 1),
            (runtime(), nil, "different hash", false, 1),
            (runtime(), nil, nil, nil, 1)
        ]
        for (daemon, build, hash, expected, expectedReads) in cases {
            var reads = 0
            let result = RuntimeIdentity.matches(daemon, executableBuildUUID: build,
                loadExecutableSHA256: { reads += 1; return hash })
            XCTAssertEqual(result, expected)
            XCTAssertEqual(reads, expectedReads)
        }
    }

    private func writeCapture(_ request: Request) throws {
        let output = try XCTUnwrap(request.output)
        let context = try XCTUnwrap(CGContext(data: nil, width: 2, height: 2,
            bitsPerComponent: 8, bytesPerRow: 8, space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        let image = try XCTUnwrap(context.makeImage())
        try Capture.write(image, to: URL(fileURLWithPath: output))
    }

    func testSelfTestSendsOwnerAndLeaseAndRemovesItsPrivateCapture() throws {
        let lease = UUID()
        var requests: [Request] = []
        let step = Setup.selfTest { request in
            requests.append(request)
            var response = Response(ok: true)
            switch request.cmd {
            case "session.create":
                XCTAssertNotNil(request.controllerOwner)
                XCTAssertEqual(request.controllerOwner?.kind, .cli)
                response.controllerLeaseID = lease
            case "screenshot":
                XCTAssertEqual(request.controllerLeaseID, lease)
                XCTAssertEqual(request.full, true)
                let output = try XCTUnwrap(request.output)
                let parent = URL(fileURLWithPath: output).deletingLastPathComponent()
                let attributes = try FileManager.default.attributesOfItem(atPath: parent.path)
                XCTAssertEqual((attributes[.posixPermissions] as? NSNumber)?.intValue, 0o700)
                try writeCapture(request)
            case "session.destroy":
                XCTAssertEqual(request.controllerLeaseID, lease)
                XCTAssertEqual(request.quitApps, true)
            default: XCTFail("unexpected command: \(request.cmd)")
            }
            XCTAssertNotEqual(request.operatorScope, true)
            return response
        }
        XCTAssertEqual(step.status, .pass)
        XCTAssertEqual(requests.map(\.cmd), ["session.create", "screenshot", "session.destroy"])
        XCTAssertEqual(Set(requests.compactMap(\.session)).count, 1)
        let output = try XCTUnwrap(requests.first { $0.cmd == "screenshot" }?.output)
        XCTAssertFalse(FileManager.default.fileExists(atPath: output))
        XCTAssertFalse(FileManager.default.fileExists(
            atPath: URL(fileURLWithPath: output).deletingLastPathComponent().path))
    }

    func testEachSelfTestUsesADifferentSessionName() {
        var names = Set<String>()
        for _ in 0..<2 {
            _ = Setup.selfTest { request in
                if let session = request.session { names.insert(session) }
                return Response.failure(SpaceOError.badRequest("creation refused"))
            }
        }
        XCTAssertEqual(names.count, 2)
    }

    func testRefusedCreateNeverDestroysAnotherSession() {
        var commands: [String] = []
        let result = Setup.selfTest { request in
            commands.append(request.cmd)
            return Response.failure(SpaceOError.badRequest("already exists"))
        }
        XCTAssertEqual(result.status, .fail)
        XCTAssertEqual(commands, ["session.create"])
    }

    func testLostCreateResponseReportsUnknownAndNeverUsesOperatorScope() {
        var commands: [String] = []
        let result = Setup.selfTest { request in
            commands.append(request.cmd)
            throw Transport.TransportError.malformed("response lost")
        }
        XCTAssertEqual(result.status, .fail)
        XCTAssertTrue(result.detail.contains("outcome unknown"))
        XCTAssertNotNil(result.remedy)
        XCTAssertEqual(commands, ["session.create"])
    }

    func testMissingLeaseNeverAttemptsUnownedCaptureOrDestroy() {
        var commands: [String] = []
        let result = Setup.selfTest { request in
            commands.append(request.cmd)
            return Response(ok: true)
        }
        XCTAssertEqual(result.status, .fail)
        XCTAssertTrue(result.detail.contains("no controller lease"))
        XCTAssertEqual(commands, ["session.create"])
    }

    func testCaptureFailureStillDestroysAndRemovesPartialFile() throws {
        var commands: [String] = []
        var output: String?
        let result = Setup.selfTest { request in
            commands.append(request.cmd)
            if request.cmd == "screenshot" {
                output = request.output
                try Data([1, 2, 3]).write(to: URL(fileURLWithPath: XCTUnwrap(output)))
                throw Transport.TransportError.malformed("capture connection lost")
            }
            var response = Response(ok: true)
            response.controllerLeaseID = UUID()
            return response
        }
        XCTAssertEqual(result.status, .fail)
        XCTAssertTrue(result.detail.contains("teardown confirmed"))
        XCTAssertEqual(commands, ["session.create", "screenshot", "session.destroy"])
        XCTAssertFalse(FileManager.default.fileExists(atPath: try XCTUnwrap(output)))
    }

    func testEmptyOrInvalidCaptureCannotPass() throws {
        for content in [Data(), Data("not a PNG".utf8)] {
            let result = Setup.selfTest { request in
                var response = Response(ok: true)
                response.controllerLeaseID = UUID()
                if request.cmd == "screenshot" {
                    try content.write(to: URL(fileURLWithPath: XCTUnwrap(request.output)))
                }
                return response
            }
            XCTAssertEqual(result.status, .fail)
            XCTAssertTrue(result.detail.contains("valid PNG"))
        }
    }

    func testCleanupFailuresNeverReportSuccessEvenAfterValidCapture() {
        for failureKind in 0..<3 {
            let result = Setup.selfTest { request in
                var response = Response(ok: true)
                response.controllerLeaseID = UUID()
                if request.cmd == "screenshot" { try writeCapture(request) }
                if request.cmd == "session.destroy" {
                    switch failureKind {
                    case 0: return Response.failure(SpaceOError.badRequest("cleanup refused"))
                    case 1: throw Transport.TransportError.malformed("cleanup response lost")
                    default: response.teardown = TeardownReport(pendingSessionIDs: ["pending"])
                    }
                }
                return response
            }
            XCTAssertEqual(result.status, .fail)
            XCTAssertTrue(result.detail.contains("cleanup unconfirmed"))
            XCTAssertTrue(result.remedy?.contains("--operator") == true)
        }
    }

    func testCaptureAndCleanupFailuresAreBothReported() {
        let result = Setup.selfTest { request in
            var response = Response(ok: true)
            response.controllerLeaseID = UUID()
            if request.cmd == "screenshot" {
                return Response.failure(SpaceOError.badRequest("capture unavailable"))
            }
            if request.cmd == "session.destroy" {
                return Response.failure(SpaceOError.badRequest("cleanup unavailable"))
            }
            return response
        }
        XCTAssertEqual(result.status, .fail)
        XCTAssertTrue(result.detail.contains("capture unavailable"))
        XCTAssertTrue(result.detail.contains("cleanup unavailable"))
    }

    func testConfigurationEscapesShellJSONAndTOMLPaths() throws {
        let path = "/tmp/a b/'quoted'\"/\\/$HOME/$(printf expanded)/`printf expanded`/\nspaceo"
        let snippet = Setup.clientConfiguration(executablePath: path)
        let literal = Setup.configurationString(path)
        let decoded = try JSONDecoder().decode(String.self, from: Data(literal.utf8))
        XCTAssertEqual(decoded, path)
        XCTAssertTrue(snippet.contains("command = " + literal))
        XCTAssertTrue(snippet.contains("\"command\": " + literal))
        XCTAssertEqual(Setup.configurationString("/tmp/spaceo"), #""/tmp/spaceo""#)

        // Use a function in place of the client: no registration, app launch, or user config.
        let process = Process()
        let pipe = Pipe()
        process.executableURL = URL(fileURLWithPath: "/bin/sh")
        // A literal newline in the path spans shell lines; extract through the trailing mcp.
        let shellCommand = try XCTUnwrap(snippet.range(of: "claude mcp add -s user spaceo -- "))
        let shellEnd = try XCTUnwrap(snippet.range(of: " mcp\n", range: shellCommand.upperBound..<snippet.endIndex))
        process.arguments = ["-c", "claude() { printf '%s' \"$7\"; }; "
            + String(snippet[shellCommand.lowerBound..<shellEnd.upperBound])]
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        try process.run()
        let output = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        XCTAssertEqual(process.terminationStatus, 0)
        XCTAssertEqual(String(data: output, encoding: .utf8), path)
    }

}
