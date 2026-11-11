import XCTest
@testable import SpaceOKit

/// LaunchAgent installation.
///
/// Every launchctl call goes through an injected recorder: these tests must never touch the
/// developer's launchd domain, and the exact argv is the contract we are checking.
final class LaunchAgentInstallerTests: XCTestCase {
    private let exe = "/opt/spaceo/bin/spaceo"
    private let socket = "/tmp/spaceo.sock"
    private var home: URL!

    override func setUpWithError() throws {
        home = FileManager.default.temporaryDirectory
            .appendingPathComponent("spaceo-launchagent-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: home)
    }

    // MARK: - Plist

    func testPlistGolden() {
        let xml = LaunchAgentInstaller.plistXML(
            executablePath: exe, socketPath: socket,
            logPath: "/Users/test/Library/Logs/SpaceO/daemon.log")
        let expected = """
        <?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
        <plist version="1.0">
        <dict>
        \t<key>EnvironmentVariables</key>
        \t<dict>
        \t\t<key>SPACEO_SOCKET</key>
        \t\t<string>/tmp/spaceo.sock</string>
        \t</dict>
        \t<key>KeepAlive</key>
        \t<true/>
        \t<key>Label</key>
        \t<string>com.spaceo.daemon</string>
        \t<key>ProcessType</key>
        \t<string>Interactive</string>
        \t<key>ProgramArguments</key>
        \t<array>
        \t\t<string>/opt/spaceo/bin/spaceo</string>
        \t\t<string>daemon</string>
        \t\t<string>--socket</string>
        \t\t<string>/tmp/spaceo.sock</string>
        \t</array>
        \t<key>RunAtLoad</key>
        \t<true/>
        \t<key>StandardErrorPath</key>
        \t<string>/Users/test/Library/Logs/SpaceO/daemon.log</string>
        \t<key>StandardOutPath</key>
        \t<string>/Users/test/Library/Logs/SpaceO/daemon.log</string>
        </dict>
        </plist>

        """
        XCTAssertEqual(xml, expected)
    }

    func testPlistEscapesXMLSpecialCharacters() throws {
        let xml = LaunchAgentInstaller.plistXML(
            executablePath: "/Users/a&b/<spaceo>", socketPath: socket, logPath: "/tmp/l.log")
        XCTAssertTrue(xml.contains("/Users/a&amp;b/&lt;spaceo&gt;"))
        let parsed = try PropertyListSerialization.propertyList(
            from: Data(xml.utf8), format: nil) as? [String: Any]
        XCTAssertEqual((parsed?["ProgramArguments"] as? [String])?.first, "/Users/a&b/<spaceo>")
    }

    // MARK: - Signing classification

    func testClassifyRecognisesTheFourCodesignShapes() {
        XCTAssertEqual(
            LaunchAgentInstaller.classify(codesignOutput: """
            Executable=/Users/x/.build/debug/spaceo
            Identifier=spaceo
            Format=Mach-O thin (arm64)
            CodeDirectory v=20400 size=1234 flags=0x2(adhoc) hashes=30+2 location=embedded
            Signature=adhoc
            Info.plist=not bound
            """),
            .adHoc)
        XCTAssertEqual(
            LaunchAgentInstaller.classify(codesignOutput: """
            Executable=/Applications/SpaceO Viewer.app/Contents/MacOS/spaceo
            Signature size=8980
            Authority=Developer ID Application: Example Corp (ABCDE12345)
            Authority=Developer ID Certification Authority
            Authority=Apple Root CA
            """),
            .developerID("Developer ID Application: Example Corp (ABCDE12345)"))
        XCTAssertEqual(
            LaunchAgentInstaller.classify(codesignOutput: """
            Signature size=4700
            Authority=Apple Development: dev@example.com (XYZ987)
            Authority=Apple Worldwide Developer Relations Certification Authority
            """),
            .appleDevelopment("Apple Development: dev@example.com (XYZ987)"))
        XCTAssertEqual(
            LaunchAgentInstaller.classify(
                codesignOutput: "/tmp/spaceo: code object is not signed at all\n"),
            .unsigned)
        XCTAssertEqual(
            LaunchAgentInstaller.classify(codesignOutput: "something else entirely"),
            .unknown("something else entirely"))
        XCTAssertEqual(LaunchAgentInstaller.classify(codesignOutput: ""), .unknown("no codesign output"))
    }

    // MARK: - Plan

    func testPlanRefusesUnstableIdentitiesWithReason() {
        for identity: LaunchAgentInstaller.SigningIdentity in [.adHoc, .unsigned, .unknown("?")] {
            XCTAssertThrowsError(
                try LaunchAgentInstaller.plan(
                    executablePath: exe, socketPath: socket, home: home, identity: identity)
            ) { error in
                guard case .badRequest(let why)? = error as? SpaceOError else {
                    return XCTFail("expected badRequest, got \(error)")
                }
                XCTAssertTrue(
                    why.contains("its identity changes on every build, so TCC grants would not stick"),
                    why)
                XCTAssertTrue(why.contains("`make signed`"), why)
            }
        }
    }

    func testPlanForSignedBuildDescribesEveryLaunchctlStep() throws {
        let plan = try LaunchAgentInstaller.plan(
            executablePath: exe, socketPath: socket, home: home,
            identity: .developerID("Developer ID Application: Example"))
        let plistPath = home.appendingPathComponent("Library/LaunchAgents/com.spaceo.daemon.plist")
            .path
        XCTAssertEqual(plan.plistURL.path, plistPath)
        XCTAssertEqual(
            plan.bootstrapCommand, ["/bin/launchctl", "bootstrap", "gui/\(getuid())", plistPath])
        XCTAssertEqual(
            plan.bootoutCommand, ["/bin/launchctl", "bootout", "gui/\(getuid())/com.spaceo.daemon"])
        XCTAssertTrue(plan.plistXML.contains("<string>\(exe)</string>"))
        XCTAssertTrue(
            plan.plistXML.contains(home.appendingPathComponent("Library/Logs/SpaceO/daemon.log").path))
    }

    func testPlanRejectsRelativePaths() {
        XCTAssertThrowsError(
            try LaunchAgentInstaller.plan(
                executablePath: "spaceo", socketPath: socket, home: home,
                identity: .appleDevelopment("x")))
    }

    // MARK: - Install / uninstall / status

    func testInstallWritesPlistAndRecordsLaunchctlArgv() throws {
        let plan = try LaunchAgentInstaller.plan(
            executablePath: exe, socketPath: socket, home: home, identity: .appleDevelopment("x"))
        var recorded: [[String]] = []
        try LaunchAgentInstaller.install(plan) { argv in
            recorded.append(argv)
            // bootout of a not-yet-loaded agent fails; install must shrug that off.
            return argv[1] == "bootout" ? 3 : 0
        }
        XCTAssertEqual(recorded, [plan.bootoutCommand, plan.bootstrapCommand])
        XCTAssertEqual(try String(contentsOf: plan.plistURL, encoding: .utf8), plan.plistXML)
        let attributes = try FileManager.default.attributesOfItem(atPath: plan.plistURL.path)
        XCTAssertEqual((attributes[.posixPermissions] as? NSNumber)?.intValue, 0o600)

        var uninstallRecorded: [[String]] = []
        try LaunchAgentInstaller.uninstall(home: home) { argv in
            uninstallRecorded.append(argv)
            return 0
        }
        XCTAssertEqual(uninstallRecorded, [plan.bootoutCommand])
        XCTAssertFalse(FileManager.default.fileExists(atPath: plan.plistURL.path))
    }

    func testInstallSurfacesBootstrapFailure() throws {
        let plan = try LaunchAgentInstaller.plan(
            executablePath: exe, socketPath: socket, home: home, identity: .appleDevelopment("x"))
        XCTAssertThrowsError(try LaunchAgentInstaller.install(plan) { _ in 5 }) { error in
            XCTAssertEqual(
                error as? LaunchAgentError,
                LaunchAgentError(command: plan.bootstrapCommand, status: 5))
        }
    }

    func testStatusParsesLaunchctlPrint() {
        var recorded: [[String]] = []
        let status = LaunchAgentInstaller.status(home: home) { argv in
            recorded.append(argv)
            return (0, "gui/501/com.spaceo.daemon = {\n\tactive count = 1\n\tpath = x\n\tstate = running\n\n\tprogram = /opt/spaceo\n\tpid = 4242\n}\n")
        }
        XCTAssertEqual(recorded, [["/bin/launchctl", "print", "gui/\(getuid())/com.spaceo.daemon"]])
        XCTAssertFalse(status.installed)
        XCTAssertTrue(status.running)
        XCTAssertEqual(status.pid, 4242)

        let missing = LaunchAgentInstaller.status(home: home) { _ in
            (113, "Could not find service \"com.spaceo.daemon\" in domain for user gui: 501\n")
        }
        XCTAssertFalse(missing.running)
        XCTAssertNil(missing.pid)

        XCTAssertEqual(
            LaunchAgentInstaller.parseStatus(exitStatus: 0, output: "state = waiting\npid = 1\n").pid,
            nil)
    }

    func testStatusIgnoresNestedEndpointAndEventStates() {
        // Abridged real `launchctl print` layout: nested blocks follow the service's own keys.
        let output = "gui/501/com.spaceo.daemon = {\n\tactive count = 1\n\tstate = running\n"
            + "\tpid = 4242\n\tendpoints = {\n\t\t\"com.spaceo.daemon\" = {\n\t\t\tport = 0x1\n"
            + "\t\t\tactive = 1\n\t\t}\n\t}\n\tevent sources = {\n\t\tstate = active\n\t}\n"
            + "\t\tpid = 7\n\tjob state = running\n}\n"
        let parsed = LaunchAgentInstaller.parseStatus(exitStatus: 0, output: output)
        XCTAssertTrue(parsed.running)
        XCTAssertEqual(parsed.pid, 4242)
    }
}
