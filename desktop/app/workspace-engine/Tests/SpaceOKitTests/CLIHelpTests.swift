import XCTest
@testable import SpaceOKit

/// Help, completions, and printed advice are all derived from `CLISpec`; these tests are the
/// tripwires that keep a new command or flag from shipping without them, and keep every command
/// SpaceO tells a person to run parseable by the CLI that told them.
final class CLIHelpTests: XCTestCase {

    // MARK: - Tables

    func testEveryClassifiedFlagHasAHelpLine() {
        let missing = CLISpec.knownFlags.filter { (CLISpec.flagHelp[$0] ?? "").isEmpty }
        XCTAssertEqual(missing, [], "add a CLISpec.flagHelp line for each new flag")
    }

    func testEveryCommandHasASummaryAndAnExample() {
        for key in CLISpec.allowedFlags.keys {
            XCTAssertNotNil(CLIHelp.summaries[key], "CLIHelp.summaries has no line for `\(key)`")
            XCTAssertFalse(CLIHelp.examples[key]?.isEmpty ?? true, "CLIHelp.examples has none for `\(key)`")
        }
    }

    func testOverridesNameRealCommandFlagPairs() {
        for override in CLIHelp.flagHelpOverrides.keys {
            let parts = override.split(separator: ":").map(String.init)
            XCTAssertEqual(parts.count, 2, override)
            XCTAssertTrue(CLISpec.allowedFlags[parts[0]]?.contains(parts[1]) == true,
                          "override `\(override)` names a flag that command does not accept")
        }
    }

    /// Examples are commands people paste; each must parse against the flag table.
    func testEveryExampleParses() {
        for (key, examples) in CLIHelp.examples {
            for example in examples where example.hasPrefix("spaceo ") {
                let command = example.components(separatedBy: " && ").first ?? example
                let unredirected = command.components(separatedBy: " > ").first ?? command
                XCTAssertNil(CLISpec.problem(with: unredirected), "example for \(key): \(example)")
            }
        }
    }

    // MARK: - Usage blocks

    private static let usageFixture = """
    spaceo — banner

      spaceo daemon [--socket P] [--display-size WxH]
                                             run the session host
      spaceo daemon stop [--operator]        stop it
      spaceo daemon install|uninstall|status install the LaunchAgent
      spaceo session create [--session ID]
                            [--title T]
                                             take a tile
      spaceo pool                            displays
      spaceo pool set <N> --operator         density
      spaceo clipboard get | set <text>      clipboard

    Global: --json
    """

    func testUsageBlockSelectsOnlyThatCommandWithContinuations() {
        XCTAssertEqual(CLIHelp.usageBlock(for: "session.create", in: Self.usageFixture), """
            spaceo session create [--session ID]
                                  [--title T]
                                                   take a tile
            """)
        XCTAssertEqual(CLIHelp.usageBlock(for: "daemon", in: Self.usageFixture), """
            spaceo daemon [--socket P] [--display-size WxH]
                                                   run the session host
            """, "a bare command key excludes its subcommands' lines")
        XCTAssertEqual(CLIHelp.usageBlock(for: "daemon.status", in: Self.usageFixture),
                       "spaceo daemon install|uninstall|status install the LaunchAgent")
        XCTAssertEqual(CLIHelp.usageBlock(for: "clipboard.set", in: Self.usageFixture),
                       "spaceo clipboard get | set <text>      clipboard")
        XCTAssertEqual(CLIHelp.usageBlock(for: "pool", in: Self.usageFixture), """
            spaceo pool                            displays
            spaceo pool set <N> --operator         density
            """, "`pool set` is a positional of `pool`, not its own key")
        XCTAssertNil(CLIHelp.usageBlock(for: "click", in: Self.usageFixture))
    }

    func testRenderedHelpIsOneCommandNotTheWholeUsage() throws {
        let text = try XCTUnwrap(CLIHelp.render(key: "session.create", usage: Self.usageFixture))
        XCTAssertTrue(text.hasPrefix("spaceo session create [--session ID]"))
        XCTAssertFalse(text.contains("banner"))
        XCTAssertFalse(text.contains("spaceo pool"))
        for flag in CLISpec.allowedFlags["session.create"]! {
            XCTAssertTrue(text.contains("--\(flag) ") || text.contains("--\(flag)\n"), "--\(flag) missing:\n\(text)")
        }
        XCTAssertTrue(text.contains("name for the new session"), "per-command override is used")
        XCTAssertTrue(text.contains("Examples:\n  eval \"$(spaceo session create --export)\""))
        XCTAssertTrue(text.contains("Exit codes: "))
    }

    func testGroupHelpListsSubcommands() throws {
        let text = try XCTUnwrap(CLIHelp.render(key: "session", usage: Self.usageFixture))
        for key in CLIHelp.subcommandKeys(of: "session") {
            XCTAssertTrue(text.contains("spaceo " + key.replacingOccurrences(of: ".", with: " ")), key)
        }
        XCTAssertNil(CLIHelp.render(key: "frobnicate", usage: Self.usageFixture))
    }

    func testShortAliasesRenderWithOneDash() throws {
        let text = try XCTUnwrap(CLIHelp.render(key: "screenshot", usage: ""))
        XCTAssertTrue(text.contains("  -o VALUE"))
        XCTAssertTrue(text.contains("  --x VALUE"), "one-letter long flags keep two dashes")
    }

    func testHelpKeyResolution() {
        XCTAssertEqual(CLIHelp.key(command: "session", positional: ["create"]), "session.create")
        XCTAssertEqual(CLIHelp.key(command: "pool", positional: ["set", "4"]), "pool")
        XCTAssertEqual(CLIHelp.key(command: "click", positional: []), "click")
        XCTAssertEqual(CLIHelp.key(command: "session", positional: []), "session")
    }

    func testSuggestionsForTypos() {
        XCTAssertEqual(CLIHelp.suggestions(for: "sesion").first, "session")
        XCTAssertEqual(CLIHelp.suggestions(for: "clik").first, "click")
        XCTAssertEqual(CLIHelp.suggestions(for: "zzzzzzzzzz"), [])
    }

    // MARK: - Printed advice parses

    func testCommandLineValidation() {
        XCTAssertNil(CLISpec.problem(with: "spaceo daemon restart --operator"))
        XCTAssertNil(CLISpec.problem(with: "spaceo daemon &"))
        XCTAssertNil(CLISpec.problem(with: "spaceo pool set 4 --operator"))
        XCTAssertNil(CLISpec.problem(with: "spaceo --json session list"))
        XCTAssertNil(CLISpec.problem(with: "spaceo session destroy --session x --operator"))
        XCTAssertNotNil(CLISpec.problem(with: "spaceo daemon restart --when-idle"),
                        "the flag doctor used to suggest does not exist")
        XCTAssertNotNil(CLISpec.problem(with: "spaceo daemon frob"))
        XCTAssertNotNil(CLISpec.problem(with: "spaceo frob"))
        XCTAssertNotNil(CLISpec.problem(with: "spaceo click --session"), "value flag without a value")
        XCTAssertNotNil(CLISpec.problem(with: "claude mcp list"))
    }

    /// Every backticked `spaceo …` command in a remedy, readiness sentence, or client status must
    /// run. Doctor once suggested `spaceo daemon restart --when-idle`, which exits "unknown option".
    func testEveryBacktickedCommandInPrintedRemediesParses() {
        var texts: [String] = []
        let remedies: [DoctorRemedy] = [
            .openSettingsPane(.accessibility), .openSettingsPane(.screenRecording), .openSettingsPane(.focus),
            .restartDaemonWhenIdle, .quarantineOrphanLedgers(["n"]),
            .removeOrphanProfiles(["/p"]), .printDisplayWakeCommands([1]),
        ]
        texts += remedies.map(\.title) + remedies.compactMap(\.manualCommand)

        let unhealthy = Setup.prerequisites(Setup.Environment(
            executablePath: "/x/spaceo", accessibility: false, screenRecording: false,
            runtimeCapabilities: [], daemonRunning: false, socketPath: "/tmp/s", builtWithARC: false))
        texts += unhealthy.compactMap(\.remedy)
        texts += Setup.daemonChecks(response: nil, executableBuildUUID: nil, executableSHA256: nil,
                                    socketPath: "/tmp/s").compactMap(\.remedy)
        var legacy = Response.success()
        legacy.daemon = DaemonRuntimeInfo(version: "1.0.0", executableSHA256: nil, pid: 1,
                                          instanceID: UUID(), startedAt: Date())
        texts += Setup.daemonChecks(response: legacy, executableBuildUUID: "a", executableSHA256: "b",
                                    socketPath: "/tmp/s").compactMap(\.remedy)
        texts += [AttentionMitigation.audioNote, AttentionMitigation.dockAndCommandTabNote]

        for state in [DoctorReport.DaemonState.notRunning, .unresponsive(timeoutSeconds: 2)] {
            texts += DoctorReportTests.report(daemon: state).blockers.flatMap { [$0.sentence, $0.next] }
        }
        let blocked = PermissionReadinessReport(clientAX: true, clientCapture: false, daemon: DaemonRuntimeInfo(
            version: "1", executableSHA256: nil, pid: 1, instanceID: UUID(), startedAt: Date(),
            accessibilityGranted: false, screenRecordingGranted: nil, canDrive: false, canCapture: false))
        var withDaemon = DoctorReportTests.report(daemon: .running(nil))
        withDaemon.readiness = blocked
        texts += withDaemon.blockers.flatMap { [$0.sentence, $0.next] }
        texts.append(withDaemon.render())

        let stale = MCPClientInspection.status(
            for: MCPClientRegistration(client: .codex, scope: "config", source: "/c", command: "/old/spaceo", arguments: ["mcp"]),
            cliVersion: "2", cliPath: "/new/spaceo", resolve: { $0 }, probe: { _ in "1" })
        texts += [stale.remedy ?? ""]
        texts.append(DaemonVersionDrift.warning(daemon: legacy.daemon, cliVersion: "9") ?? "")

        var checked = 0
        for text in texts {
            for command in CLISpec.backtickedCommands(in: text) {
                checked += 1
                XCTAssertNil(CLISpec.problem(with: command), "`\(command)` in: \(text)")
            }
        }
        XCTAssertGreaterThan(checked, 10, "the sweep must actually find commands to check")
    }

    // MARK: - Aliases

    func testConflictingAliasesAreReported() {
        XCTAssertEqual(CLIArguments(["--name", "a", "--session", "b"]).conflictingAliases.map { "\($0.0)/\($0.1)" },
                       ["session/name"])
        XCTAssertEqual(CLIArguments(["-o", "a.png", "--output", "b.png"]).conflictingAliases.map { "\($0.0)/\($0.1)" },
                       ["output/o"])
        XCTAssertTrue(CLIArguments(["--name", "a"]).conflictingAliases.isEmpty)
        for (long, short) in CLISpec.aliasPairs {
            XCTAssertTrue(CLISpec.knownFlags.contains(long) && CLISpec.knownFlags.contains(short))
        }
    }

    // MARK: - Completions

    func testCompletionsCoverEveryCommandAndFlag() throws {
        for shell in CLICompletions.shells {
            let script = try XCTUnwrap(CLICompletions.script(for: shell))
            for word in CLIHelp.commandWords {
                XCTAssertTrue(script.contains(word), "\(shell) completion lacks `\(word)`")
            }
            for flag in CLISpec.knownFlags.subtracting(["h"]) {
                let spelled = shell == "fish"
                    ? (CLISpec.shortFlags.contains(flag) ? "-s \(flag)" : "-l \(flag)")
                    : (CLISpec.shortFlags.contains(flag) ? "-\(flag)" : "--\(flag)")
                XCTAssertTrue(script.contains(spelled), "\(shell) completion lacks \(spelled)")
            }
        }
        XCTAssertNil(CLICompletions.script(for: "powershell"))
    }

    /// Each script must at least parse in its own shell. Skipped per shell when not installed.
    func testCompletionScriptsParse() throws {
        var checked = 0
        for (shell, path) in [("bash", "/bin/bash"), ("zsh", "/bin/zsh"), ("fish", "/opt/homebrew/bin/fish")] {
            guard FileManager.default.isExecutableFile(atPath: path) else { continue }
            let file = FileManager.default.temporaryDirectory
                .appendingPathComponent("spaceo-completion-\(UUID().uuidString).\(shell)")
            try XCTUnwrap(CLICompletions.script(for: shell)).write(to: file, atomically: true, encoding: .utf8)
            defer { try? FileManager.default.removeItem(at: file) }
            let process = Process()
            process.executableURL = URL(fileURLWithPath: path)
            process.arguments = ["-n", file.path]
            let errors = Pipe()
            process.standardError = errors
            process.standardOutput = FileHandle.nullDevice
            try process.run()
            let message = String(decoding: errors.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
            process.waitUntilExit()
            XCTAssertEqual(process.terminationStatus, 0, "\(shell) -n: \(message)")
            checked += 1
        }
        XCTAssertGreaterThan(checked, 0)
    }
}
