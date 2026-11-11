import XCTest
@testable import SpaceOKit

/// Reading which binary each MCP client launches, and `setup --client claude-code`'s plan.
/// Everything reads fixtures through injected closures; nothing touches a real client config or
/// runs `claude`.
final class MCPClientInspectionTests: XCTestCase {
    private let home = URL(fileURLWithPath: "/Users/test", isDirectory: true)

    private func files(_ contents: [String: String]) -> (URL) -> String? {
        { contents[$0.path] }
    }

    // MARK: - Reading registrations

    func testClaudeCodeUserAndProjectScopes() {
        let json = """
        {"mcpServers":{"spaceo":{"type":"stdio","command":"/Users/test/.local/bin/spaceo","args":["mcp"]},
                       "other":{"command":"/bin/other"}},
         "projects":{"/work/b":{"mcpServers":{"spaceo":{"command":"/work/b/.build/debug/spaceo","args":["mcp"]}}},
                     "/work/a":{"mcpServers":{}},
                     "/work/c":{"allowedTools":[]}},
         "numStartups": 12}
        """
        let found = MCPClientInspection.registrations(home: home, read: files(["/Users/test/.claude.json": json]))
        XCTAssertEqual(found, [
            MCPClientRegistration(client: .claudeCode, scope: "user", source: "/Users/test/.claude.json",
                                  command: "/Users/test/.local/bin/spaceo", arguments: ["mcp"]),
            MCPClientRegistration(client: .claudeCode, scope: "project /work/b", source: "/Users/test/.claude.json",
                                  command: "/work/b/.build/debug/spaceo", arguments: ["mcp"]),
        ])
    }

    func testProjectEntriesAreBounded() {
        var projects: [String] = []
        for index in 0..<40 {
            projects.append("\"/p\(index)\":{\"mcpServers\":{\"spaceo\":{\"command\":\"/s\",\"args\":[\"mcp\"]}}}")
        }
        let json = "{\"projects\":{\(projects.joined(separator: ","))}}"
        XCTAssertEqual(MCPClientInspection.claudeCodeRegistrations(json: json, source: "x").count,
                       MCPClientInspection.maximumProjectEntries)
    }

    func testCodexCursorAndDesktopConfigs() {
        let toml = """
        model = "x"

        [mcp_servers.other]
        command = "/bin/other"

        [mcp_servers.spaceo] # managed by spaceo setup
        command = "/Users/test/bin/sp\\"ace\\u00e9o"
        args = ["mcp"]

        [profiles.fast]
        command = "not this one"
        """
        let cursor = #"{"mcpServers":{"spaceo":{"command":"/c/spaceo","args":["mcp"]}}}"#
        let desktop = #"{"mcpServers":{"other":{"command":"/x"}}}"#
        let found = MCPClientInspection.registrations(home: home, read: files([
            "/Users/test/.codex/config.toml": toml,
            "/Users/test/.cursor/mcp.json": cursor,
            "/Users/test/Library/Application Support/Claude/claude_desktop_config.json": desktop,
        ]))
        XCTAssertEqual(found.map(\.client), [.codex, .cursor])
        XCTAssertEqual(found[0].command, "/Users/test/bin/sp\"aceéo")
        XCTAssertEqual(found[0].arguments, ["mcp"])
        XCTAssertEqual(found[1].command, "/c/spaceo")
    }

    func testMalformedConfigsYieldNothing() {
        let found = MCPClientInspection.registrations(home: home, read: files([
            "/Users/test/.claude.json": "{not json",
            "/Users/test/.codex/config.toml": "[mcp_servers.spaceo]\ncommand = unquoted\n",
            "/Users/test/.cursor/mcp.json": #"{"mcpServers":{"spaceo":{"command":42}}}"#,
        ]))
        XCTAssertEqual(found, [])
    }

    func testTOMLBasicStringDecoding() {
        XCTAssertEqual(MCPClientInspection.tomlBasicString(#""a\\b\"c" # trailing"#), "a\\b\"c")
        XCTAssertEqual(MCPClientInspection.tomlBasicString(#""A\U0001F600""#), "A😀")
        XCTAssertNil(MCPClientInspection.tomlBasicString(#""unterminated"#))
        XCTAssertNil(MCPClientInspection.tomlBasicString("bare"))
        // Round-trips what the writer emits.
        let path = "/tmp/a b/\"q\"\\\u{1}"
        XCTAssertEqual(MCPClientInspection.tomlBasicString(MCPClientConfig.tomlString(path)), path)
    }

    // MARK: - Versions and status

    func testVersionOutputParsing() {
        XCTAssertEqual(MCPClientInspection.parseVersionOutput("spaceo 1.0.0\n"), "1.0.0")
        XCTAssertEqual(MCPClientInspection.parseVersionOutput(#"{"version":"1.1.1"}"#), "1.1.1")
        XCTAssertEqual(MCPClientInspection.parseVersionOutput(#"{"ok":true,"version":"1.2.0-beta.1"}"#), "1.2.0-beta.1")
        XCTAssertNil(MCPClientInspection.parseVersionOutput("usage: something else"))
        XCTAssertNil(MCPClientInspection.parseVersionOutput("spaceo 1.0.0; rm -rf"))
        XCTAssertNil(MCPClientInspection.parseVersionOutput(""))
    }

    func testResolveUsesAbsolutePathsOrPATH() {
        let executables: Set<String> = ["/opt/bin/spaceo", "/abs/spaceo", "/Users/test/.local/bin/spaceo"]
        let isExecutable = { executables.contains($0) }
        XCTAssertEqual(MCPClientInspection.resolve(command: "/abs/spaceo", pathVariable: nil, isExecutable: isExecutable), "/abs/spaceo")
        XCTAssertNil(MCPClientInspection.resolve(command: "/missing/spaceo", pathVariable: "/opt/bin", isExecutable: isExecutable))
        XCTAssertEqual(MCPClientInspection.resolve(command: "spaceo", pathVariable: "relative:/usr/bin:/opt/bin", isExecutable: isExecutable),
                       "/opt/bin/spaceo", "relative PATH entries are skipped")
        XCTAssertNil(MCPClientInspection.resolve(command: "bin/spaceo", pathVariable: "/opt", isExecutable: isExecutable))
    }

    func testStatusMatchesStaleMissingAndSilent() {
        let registration = MCPClientRegistration(client: .claudeCode, scope: "user", source: "/c",
                                                 command: "/Users/test/.local/bin/spaceo", arguments: ["mcp"])
        let current = MCPClientInspection.status(for: registration, cliVersion: "1.1.1", cliPath: "/x",
                                                 resolve: { $0 }, probe: { _ in "1.1.1" })
        XCTAssertEqual(current.matchesCLI, true)
        XCTAssertNil(current.remedy)

        let stale = MCPClientInspection.status(for: registration, cliVersion: "1.1.1", cliPath: "/build/spaceo",
                                               resolve: { $0 }, probe: { _ in "1.0.0" })
        XCTAssertEqual(stale.matchesCLI, false)
        XCTAssertEqual(stale.version, "1.0.0")
        XCTAssertEqual(stale.remedy,
                       "Claude Code launches /Users/test/.local/bin/spaceo (1.0.0); update that file "
                       + "(`make install` for source builds) or re-register this build with "
                       + "`spaceo setup --client claude-code`, then restart Claude Code")

        let missing = MCPClientInspection.status(for: registration, cliVersion: "1.1.1", cliPath: "/x",
                                                 resolve: { _ in nil }, probe: { _ in XCTFail("no probe"); return nil })
        XCTAssertNil(missing.matchesCLI)
        XCTAssertTrue(missing.problem?.contains("does not exist") == true)

        let silent = MCPClientInspection.status(for: registration, cliVersion: "1.1.1", cliPath: "/x",
                                                resolve: { $0 }, probe: { _ in nil })
        XCTAssertNil(silent.matchesCLI)
        XCTAssertTrue(silent.problem?.contains("did not answer") == true)

        var wrongArgs = registration
        wrongArgs.arguments = ["daemon"]
        let misconfigured = MCPClientInspection.status(for: wrongArgs, cliVersion: "1.1.1", cliPath: "/x",
                                                       resolve: { $0 }, probe: { _ in "1.1.1" })
        XCTAssertNotNil(misconfigured.problem)
        XCTAssertNotNil(misconfigured.remedy)
    }

    func testStatusesListEveryClientAndProbeEachPathOnce() {
        let shared = "/Users/test/.local/bin/spaceo"
        let registrations = [
            MCPClientRegistration(client: .claudeCode, scope: "user", source: "/c", command: shared, arguments: ["mcp"]),
            MCPClientRegistration(client: .claudeCode, scope: "project /p", source: "/c", command: shared, arguments: ["mcp"]),
            MCPClientRegistration(client: .cursor, scope: "config", source: "/m", command: shared, arguments: ["mcp"]),
        ]
        var probes = 0
        let statuses = MCPClientInspection.statuses(
            registrations: registrations, cliVersion: "1.1.1", cliPath: "/x",
            resolve: { $0 }, probe: { _ in probes += 1; return "1.1.1" })
        XCTAssertEqual(statuses.map(\.client), [.claudeCode, .claudeCode, .codex, .cursor, .claudeDesktop])
        XCTAssertNil(statuses[2].registration, "codex has no entry and is reported as not configured")
        XCTAssertEqual(probes, 1)
    }

    func testPassiveInspectionDoesNotInvokeExternalProgramsEvenWhenNamedSpaceO() {
        let registrations = ["/bin/unrelated", "/other/spaceo"].map {
            MCPClientRegistration(client: .claudeCode, scope: "user", source: "/fixture",
                                  command: $0, arguments: ["mcp"])
        }
        let statuses = MCPClientInspection.statuses(registrations: registrations,
            cliVersion: "1.0.0", cliPath: "/current/spaceo", resolve: { $0 },
            probe: { _ in XCTFail("passive inspection must not execute external commands"); return nil },
            allowExternalVersionProbe: false)
        for status in statuses where status.registration != nil {
            XCTAssertNil(status.version)
            XCTAssertNil(status.matchesCLI)
            XCTAssertTrue(status.problem?.contains("not executed") == true)
            XCTAssertTrue(status.remedy?.contains("--probe-client-versions") == true)
        }
    }

    func testPassiveInspectionCanUseKnownCurrentVersionAndReportsInvalidArguments() {
        let registration = MCPClientRegistration(client: .codex, scope: "config", source: "/fixture",
            command: "/current/spaceo", arguments: ["mcp"])
        let current = MCPClientInspection.status(for: registration, cliVersion: "1.0.0",
            cliPath: "/current/spaceo", resolve: { $0 }, probe: { _ in "1.0.0" },
            allowExternalVersionProbe: false)
        XCTAssertEqual(current.matchesCLI, true)
        var invalid = registration
        invalid.command = "/other/wrapper"
        invalid.arguments = ["daemon"]
        let external = MCPClientInspection.status(for: invalid, cliVersion: "1.0.0",
            cliPath: "/current/spaceo", resolve: { $0 }, probe: { _ in XCTFail("no external probe"); return nil },
            allowExternalVersionProbe: false)
        XCTAssertTrue(external.problem?.contains("do not start with mcp") == true)
    }

    /// Doctor's probe runs a real, harmless binary: `/bin/echo` prints text shaped like
    /// `spaceo version` output.
    func testProbeParsesARealProcessAndTimesOut() throws {
        let script = FileManager.default.temporaryDirectory
            .appendingPathComponent("spaceo-probe-\(UUID().uuidString).sh")
        try "#!/bin/sh\necho 'spaceo 9.8.7'\n".write(to: script, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: script.path)
        defer { try? FileManager.default.removeItem(at: script) }
        XCTAssertEqual(MCPClientInspection.probeVersion(path: script.path), "9.8.7")

        let slow = FileManager.default.temporaryDirectory
            .appendingPathComponent("spaceo-probe-slow-\(UUID().uuidString).sh")
        try "#!/bin/sh\nsleep 5\necho 'spaceo 1.0.0'\n".write(to: slow, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: slow.path)
        defer { try? FileManager.default.removeItem(at: slow) }
        let started = Date()
        XCTAssertNil(MCPClientInspection.probeVersion(path: slow.path, timeout: 0.3))
        XCTAssertLessThan(Date().timeIntervalSince(started), 3, "the probe is bounded")
        XCTAssertNil(MCPClientInspection.probeVersion(path: "/nonexistent/spaceo"))
    }

    func testProbeBoundsInheritedPipeAndRejectsExcessOutput() throws {
        let script = FileManager.default.temporaryDirectory
            .appendingPathComponent("spaceo-probe-pipe-\(UUID().uuidString).sh")
        defer { try? FileManager.default.removeItem(at: script) }
        try "#!/bin/sh\nsleep 2 &\necho 'spaceo 9.8.7'\nexit 0\n"
            .write(to: script, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: script.path)
        let started = ContinuousClock.now
        XCTAssertNil(MCPClientInspection.probeVersion(path: script.path, timeout: 0.1))
        XCTAssertLessThan(started.duration(to: .now), .seconds(1))
        try ("#!/bin/sh\necho 'spaceo 9.8.7'\nprintf '%s' '" + String(repeating: "x", count: 5_000) + "'\n")
            .write(to: script, atomically: true, encoding: .utf8)
        XCTAssertNil(MCPClientInspection.probeVersion(path: script.path))
    }

    func testProbeRejectsInvalidTimeoutBeforeLaunching() {
        for timeout in [Double.nan, .infinity, -.infinity, 0, -1] {
            XCTAssertNil(MCPClientInspection.probeVersion(path: "/bin/echo", timeout: timeout))
        }
    }

    // MARK: - Claude Code registration

    func testClaudeIsResolvedFromPATHBeforeFallbacks() {
        let nvm = "/Users/test/.nvm/versions/node/v24/bin/claude"
        XCTAssertEqual(ClaudeCodeRegistration.resolveExecutable(
            pathVariable: "/usr/bin:/Users/test/.nvm/versions/node/v24/bin", home: "/Users/test",
            isExecutable: { $0 == nvm || $0 == "/opt/homebrew/bin/claude" }), nvm)
        XCTAssertEqual(ClaudeCodeRegistration.resolveExecutable(
            pathVariable: "/usr/bin", home: "/Users/test",
            isExecutable: { $0 == "/Users/test/.claude/local/claude" }), "/Users/test/.claude/local/claude")
        XCTAssertNil(ClaudeCodeRegistration.resolveExecutable(pathVariable: nil, home: "/Users/test", isExecutable: { _ in false }))
    }

    func testRegistrationIsUserScopeAndReplacesAnExistingEntry() {
        let path = "/Users/test/.local/bin/spaceo"
        XCTAssertEqual(ClaudeCodeRegistration.commands(executablePath: path, existingUserEntry: false), [
            ["claude", "mcp", "add", "-s", "user", "spaceo", "--", path, "mcp"],
        ])
        XCTAssertEqual(ClaudeCodeRegistration.commands(executablePath: path, existingUserEntry: true), [
            ["claude", "mcp", "remove", "-s", "user", "spaceo"],
            ["claude", "mcp", "add", "-s", "user", "spaceo", "--", path, "mcp"],
        ])
        XCTAssertEqual(MCPClientConfig.command(for: .claudeCode, executablePath: path),
                       ClaudeCodeRegistration.addCommand(executablePath: path))
    }

    func testShellLineQuotesOnlyWhatNeedsIt() {
        XCTAssertEqual(ClaudeCodeRegistration.shellLine(["claude", "mcp", "add", "-s", "user", "spaceo", "--", "/a b/it's", "mcp"]),
                       "claude mcp add -s user spaceo -- '/a b/it'\\''s' mcp")
    }

    func testBuildDirectoryRegistrationsAreWarnedAbout() throws {
        let warning = try XCTUnwrap(ClaudeCodeRegistration.buildDirectoryWarning(
            executablePath: "/Users/test/SpaceO/.build/arm64-apple-macosx/debug/spaceo", home: "/Users/test"))
        XCTAssertTrue(warning.contains("`make install`"))
        XCTAssertTrue(warning.contains("/Users/test/.local/bin/spaceo setup --client claude-code"))
        XCTAssertNil(ClaudeCodeRegistration.buildDirectoryWarning(
            executablePath: "/Users/test/.local/bin/spaceo", home: "/Users/test"))
        XCTAssertNil(ClaudeCodeRegistration.buildDirectoryWarning(
            executablePath: "/Users/test/my.build/spaceo", home: "/Users/test"), "only a .build path component")
    }

    func testStartAdviceDependsOnTheLaunchAgent() {
        XCTAssertTrue(LaunchAgentInstaller.startAdvice(installed: false).contains("spaceo daemon"))
        XCTAssertTrue(LaunchAgentInstaller.startAdvice(installed: false).contains("MCP client"))
        let supervised = LaunchAgentInstaller.startAdvice(installed: true, uid: 501)
        XCTAssertTrue(supervised.contains("launchctl kickstart -k gui/501/com.spaceo.daemon"))
        XCTAssertTrue(supervised.contains("spaceo daemon status"))
        XCTAssertEqual(LaunchAgentInstaller.startNextAction(installed: true, uid: 501),
                       "launchctl kickstart -k gui/501/com.spaceo.daemon")
        XCTAssertEqual(LaunchAgentInstaller.startNextAction(installed: false), "spaceo daemon")
    }
}
