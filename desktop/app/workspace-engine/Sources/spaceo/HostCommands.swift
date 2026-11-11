import Foundation
import AppKit
import CoreGraphics
import Darwin
import SpaceOKit

// Host-level commands: setup, doctor, and daemon lifecycle. They share `main.swift`'s parsed
// `args`, `socketPath`, and output helpers; the decisions they print are made by pure types in
// SpaceOKit (`DoctorReport`, `DaemonRestart`, `MCPClientInspection`, `ClaudeCodeRegistration`)
// so those can be tested without a daemon or a TCC grant.

/// The executable the user ran, symlinks resolved: what MCP registrations and restarts name.
func currentExecutablePath() -> String {
    (Bundle.main.executableURL ?? URL(fileURLWithPath: CommandLine.arguments[0]))
        .resolvingSymlinksInPath().path
}

/// y/N on the terminal. The prompt goes through `note`, so `--json` keeps stdout clean.
func confirm(_ prompt: String, refusal: String) -> Bool {
    if args.bool("yes") { return true }
    guard isatty(STDIN_FILENO) == 1 else {
        fail(refusal, exit: .usage)
    }
    note(prompt + " [y/N] ", terminator: "")
    return readLine()?.lowercased().hasPrefix("y") == true
}

// MARK: - setup

func runSetup() -> Never {
    let executable = currentExecutablePath()
    if let clientName = stringArgument("client") {
        guard let client = MCPClient(rawValue: clientName) else {
            fail("--client must be one of " + MCPClient.allCases.map(\.rawValue).joined(separator: ", "))
        }
        do {
            try MCPClientConfig.validateExecutablePath(executable)
        } catch {
            fail(error.localizedDescription, exit: .failure)
        }
        if client == .claudeCode { registerClaudeCode(executable: executable) }
        registerFileClient(client, executable: executable)
    }
    runGuidedSetup(executable: executable)
}

/// `setup --client claude-code`: user scope, remove-then-add when an entry exists, and a warning
/// when the registration would name a SwiftPM build product.
func registerClaudeCode(executable: String) -> Never {
    let home = NSHomeDirectory()
    let warning = ClaudeCodeRegistration.buildDirectoryWarning(executablePath: executable, home: home)
    // Read-only: whether a user-scope `spaceo` entry already exists decides remove-then-add.
    let existing = MCPClientInspection.registrations()
        .contains { $0.client == .claudeCode && $0.scope == "user" }
    let commands = ClaudeCodeRegistration.commands(executablePath: executable, existingUserEntry: existing)
    let lines = commands.map(ClaudeCodeRegistration.shellLine)

    if args.bool("print") {
        if args.hasJSON {
            print(CLIJSON.object(["ok": true, "client": "claude-code", "commands": lines,
                                  "warnings": warning.map { [$0] } ?? []]))
        } else {
            if let warning { writeStandardError("warning: " + warning) }
            print(lines.joined(separator: "\n"))
        }
        exit(0)
    }
    if let warning { writeStandardError("warning: " + warning) }

    let claude = ClaudeCodeRegistration.resolveExecutable(
        pathVariable: ProcessInfo.processInfo.environment["PATH"], home: home,
        isExecutable: FileManager.default.isExecutableFile(atPath:))
    guard let claude else {
        fail("`claude` was not found on PATH or in the usual install locations. Run this yourself:\n  "
             + lines.joined(separator: "\n  "),
             exit: .failure, code: "client_not_found", next: lines.last)
    }
    note("Will run (\(claude)):")
    for line in lines { note("  " + line) }
    if existing {
        note("A user-scope `spaceo` entry already exists; it is removed first so the new path replaces it.")
    }
    guard confirm("Proceed?", refusal: "pass --yes to run without a terminal, or --print to only print the commands") else {
        fail("not registered", exit: .failure, code: "cancelled")
    }
    for command in commands {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: claude)
        process.arguments = Array(command.dropFirst())
        // `claude` prints its own confirmation; in --json mode that belongs on stderr.
        if jsonRequested { process.standardOutput = FileHandle.standardError }
        do {
            try process.run()
        } catch {
            fail("could not run \(claude): \(error.localizedDescription)", exit: .failure)
        }
        process.waitUntilExit()
        guard process.terminationStatus == 0 else {
            fail("`\(ClaudeCodeRegistration.shellLine(command))` exited with status \(process.terminationStatus)",
                 exit: .failure, code: "client_registration_failed", next: "claude mcp list")
        }
    }
    let message = "registered spaceo with Claude Code at user scope → \(executable); "
        + "restart Claude Code (or run /mcp) to pick it up"
    if args.hasJSON {
        print(CLIJSON.object(["ok": true, "client": "claude-code", "commands": lines, "message": message,
                              "warnings": warning.map { [$0] } ?? []]))
    } else {
        print(message)
    }
    exit(0)
}

/// Codex, Cursor, Claude Desktop: show a diff, then write the merged file.
func registerFileClient(_ client: MCPClient, executable: String) -> Never {
    guard let url = MCPClientConfig.configFileURL(for: client) else {
        fail("no config file location for \(client.rawValue)", exit: .failure)
    }
    do {
        let existing = try MCPClientConfig.readExisting(at: url)
        let merged = try MCPClientConfig.merged(existing: existing, client: client, executablePath: executable)
        if args.bool("print") {
            print(args.hasJSON
                ? CLIJSON.object(["ok": true, "client": client.rawValue, "path": url.path, "contents": merged])
                : merged)
            exit(0)
        }
        note("\(url.path):")
        note(MCPClientConfig.diff(old: existing, new: merged))
        guard confirm("Write this file?", refusal: "pass --yes to write without a terminal, or --print to only print the result") else {
            fail("not written", exit: .failure, code: "cancelled")
        }
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try merged.write(to: url, atomically: true, encoding: .utf8)
        let message = "wrote \(url.path); restart \(client.displayName) to pick it up"
        print(args.hasJSON
            ? CLIJSON.object(["ok": true, "client": client.rawValue, "path": url.path, "message": message])
            : message)
        exit(0)
    } catch {
        fail(error.localizedDescription, exit: .failure)
    }
}

func runGuidedSetup(executable: String) -> Never {
    let interactiveTTY = isatty(STDOUT_FILENO) == 1 && isatty(STDIN_FILENO) == 1 && !args.bool("no-prompt")
    let progressStore = SetupProgressStore()
    let progress = progressStore.load()
    for (step, passedAt) in progress.passedSteps.sorted(by: { $0.key < $1.key }) where interactiveTTY {
        note(SetupNarration.skipLine(step: step, passedAt: passedAt))
    }

    // An unavailable runtime cannot be repaired by TCC grants; avoid pointless prompts.
    let initialCapabilities = Capabilities()
    let runtimeAvailable = initialCapabilities.builtWithARC
        && Setup.requiredRuntimeCapabilities.allSatisfy { name in
            initialCapabilities.items.first { $0.name == name }?.available == true
        }
    if !args.bool("no-prompt") && runtimeAvailable {
        if !CGPreflightScreenCaptureAccess() { CGRequestScreenCaptureAccess() }
        if !AXIsProcessTrusted() {
            _ = AXIsProcessTrustedWithOptions(
                ["AXTrustedCheckOptionPrompt": true] as CFDictionary)
        }
    }
    // Interactive path (SPAO-201): open the exact Settings pane, name the app to enable, and
    // wait for the grant instead of exiting with MISS and asking for a rerun.
    if interactiveTTY && runtimeAvailable {
        let attribution = ResponsibleProcess.grantPhrase(ResponsibleProcess.attribution())
        let waits: [(SettingsPane, String, () -> Bool)] = [
            (.accessibility, "accessibility", { AXIsProcessTrusted() }),
            (.screenRecording, "screen recording", { CGPreflightScreenCaptureAccess() }),
        ]
        for (pane, name, predicate) in waits where !predicate() {
            note("\(name): not granted. Opening System Settings; enable \(attribution) there.")
            NSWorkspace.shared.open(pane.url)
            let granted = GrantWaiter(pane: pane).wait(
                predicate: predicate,
                now: { Date() },
                sleep: { usleep(UInt32($0 * 1_000_000)) },
                onTick: { remaining in
                    note("\r  waiting for the \(name) grant… \(remaining)s  ", terminator: "")
                })
            note("")
            if granted {
                note("  \(name): granted")
                try? progressStore.markPassed(name, at: Date())
            } else {
                note("  \(name): still missing after the wait; continuing so the report shows every step")
            }
        }
    }

    // Re-read after prompting: a grant made just now should count.
    let refreshed = Capabilities()
    var setupSteps = Setup.prerequisites(Setup.Environment(
        executablePath: executable,
        accessibility: AXIsProcessTrusted(),
        screenRecording: CGPreflightScreenCaptureAccess(),
        runtimeCapabilities: refreshed.items,
        daemonRunning: false,
        socketPath: socketPath,
        builtWithARC: refreshed.builtWithARC))

    var daemonResponse = Transport.pingResponse(socketPath)
    let selfTestRequested = !args.bool("no-self-test")
    let shouldStart = selfTestRequested && Setup.canSelfTest(setupSteps)
        && daemonResponse?.ok != true
    if shouldStart {
        _ = Setup.startDaemon(executablePath: executable, socketPath: socketPath)
        daemonResponse = Transport.pingResponse(socketPath)
    }
    if daemonResponse?.ok == true || shouldStart {
        setupSteps.removeAll { $0.name == "daemon" }
        setupSteps += Setup.daemonChecks(
            response: daemonResponse,
            executableBuildUUID: RuntimeIdentity.currentExecutableBuildUUID(),
            executableSHA256: RuntimeIdentity.currentExecutableSHA256(),
            socketPath: socketPath)
    }
    if selfTestRequested && Setup.canSelfTest(setupSteps) {
        setupSteps.append(Setup.selfTest(socketPath: socketPath))
    } else {
        setupSteps.append(SetupStep(name: "self-test", status: .skipped,
            detail: selfTestRequested ? "blocked by the prerequisites above"
                : "not run (--no-self-test); live session behavior has not been verified"))
    }

    // Attention mitigations (SPAO-165): an informational step, never a failure.
    let launchedNames = (Transport.pingResponse(socketPath).flatMap { _ in
        try? Transport.send({ var r = Request(cmd: "session.list"); r.operatorScope = true; return r }(), to: socketPath, timeout: 2)
    })?.sessions?.flatMap { $0.apps.map(\.name) } ?? []
    setupSteps.append(AttentionMitigation.quietAgentAppsStep(launchedAppNames: Array(Set(launchedNames)).sorted(), focusActive: nil))
    for step in setupSteps where step.status == .pass {
        try? progressStore.markPassed(step.name, at: Date())
    }

    let setupOK = !setupSteps.contains { $0.status == .fail }
    if args.hasJSON {
        print(CLIJSON.object([
            "ok": setupOK,
            "executable": executable,
            "socket": socketPath,
            "steps": setupSteps.map { step in
                [
                    "name": step.name,
                    "status": step.status.rawValue,
                    "detail": step.detail,
                    "remedy": step.remedy.map { $0 as Any } ?? NSNull(),
                ]
            },
        ]))
    } else {
        print(Setup.report(steps: setupSteps))
        print("")
        print("Grants are attributed to: \(ResponsibleProcess.describeCurrent() ?? "unknown (run setup from the terminal or app that will host spaceo)")")
        print("")
        print(setupOK ? "Register SpaceO with your MCP client (or run `spaceo setup --client <name>` to write it):"
            : "MCP configuration (resolve the items marked MISS before use):")
        print("")
        print(Setup.clientConfiguration(executablePath: executable))
        if let warning = ClaudeCodeRegistration.buildDirectoryWarning(executablePath: executable, home: NSHomeDirectory()) {
            print("")
            print("warning: " + warning)
        }
        if LaunchAgentInstaller.signingIdentity(of: executable).isStable {
            print("")
            print("This build is stably signed: `spaceo daemon install` gives the daemon its own TCC identity so grants survive client restarts.")
        }
        if !setupOK {
            print("")
            print("Fix the items marked MISS above, then run `spaceo setup` again.")
        }
    }
    exit(setupOK ? 0 : 1)
}

// MARK: - doctor

let doctorProbeTimeout: TimeInterval = 2

func viewerSearchPaths() -> [String] {
    ["/Applications/SpaceO Viewer.app",
     (NSHomeDirectory() as NSString).appendingPathComponent("Applications/SpaceO Viewer.app")]
}

func installedViewer() -> DoctorReport.ViewerInstallation? {
    for path in viewerSearchPaths() where FileManager.default.fileExists(atPath: path) {
        let plist = URL(fileURLWithPath: path).appendingPathComponent("Contents/Info.plist")
        let info = (try? Data(contentsOf: plist, options: [.uncached]))
            .flatMap { $0.count <= 1_048_576 ? $0 : nil }
            .flatMap { try? PropertyListSerialization.propertyList(from: $0, format: nil) as? [String: Any] }
        return DoctorReport.ViewerInstallation(
            path: path, version: info?["CFBundleShortVersionString"] as? String)
    }
    return nil
}

func runDoctor() -> Never {
    let capabilities = Capabilities()
    // One probe decides the daemon's state. A timeout on a socket something is listening on is a
    // busy daemon, not an absent one: its displays are not orphans and nothing may be cleaned up.
    let daemonResponse: Response?
    let daemonState: DoctorReport.DaemonState
    do {
        let response = try Transport.send(Request(cmd: "pool"), to: socketPath, timeout: doctorProbeTimeout)
        daemonResponse = response
        daemonState = .running(response.daemon)
    } catch {
        daemonResponse = nil
        daemonState = Transport.isListening(socketPath)
            ? .unresponsive(timeoutSeconds: doctorProbeTimeout) : .notRunning
    }
    let daemonIsRunning = daemonState.isRunning && daemonResponse?.ok == true
    let daemonUnresponsive = daemonState.isUnresponsive
    let cliExecutableSHA256 = RuntimeIdentity.currentExecutableSHA256()
    let cliExecutableBuildUUID = RuntimeIdentity.currentExecutableBuildUUID()
    let daemonRuntime = daemonResponse?.daemon
    let daemonMatchesCLI = daemonIsRunning ? RuntimeIdentity.matches(
        daemonRuntime, executableBuildUUID: cliExecutableBuildUUID,
        executableSHA256: cliExecutableSHA256) : nil
    let attachedSpaceODisplays = Stage.spaceODisplayIDs()
    let orphanedDisplayIDs = DoctorReport.orphanedDisplays(
        attached: attachedSpaceODisplays, daemon: daemonState,
        daemonDisplayIDs: Set(daemonResponse?.displays?.map(\.displayID) ?? []))
    let logURL = DaemonLog.defaultLogURL()
    let logAttributes = try? FileManager.default.attributesOfItem(atPath: logURL.path)
    let logSize = (logAttributes?[.size] as? NSNumber)?.intValue
    let callerAttribution = ResponsibleProcess.describeCurrent()
    let supervision = LaunchAgentInstaller.status()
    let spaceoRoot = (try? SessionStore.defaultRootDirectory().deletingLastPathComponent())
    let spaceoDiskBytes = spaceoRoot.map { DiskHygiene.directorySize($0) } ?? 0
    let orphanProfileDirectories: [String]
    if daemonIsRunning {
        orphanProfileDirectories = (try? Transport.send({ var r = Request(cmd: "clean"); r.operatorScope = true; r.dryRun = true; return r }(), to: socketPath, timeout: 10))?.removedPaths ?? []
    } else if daemonUnresponsive {
        // The silent daemon may be using any of them.
        orphanProfileDirectories = []
    } else {
        orphanProfileDirectories = offlineOrphanProfileDirectories()
    }
    let cliPath = currentExecutablePath()
    let environmentPath = ProcessInfo.processInfo.environment["PATH"]
    let mcpClients = MCPClientInspection.statuses(
        registrations: MCPClientInspection.registrations(),
        cliVersion: SpaceOVersion.current, cliPath: cliPath,
        resolve: { MCPClientInspection.resolve(command: $0, pathVariable: environmentPath,
                                               isExecutable: FileManager.default.isExecutableFile(atPath:)) },
        probe: { $0 == cliPath ? SpaceOVersion.current : MCPClientInspection.probeVersion(path: $0) },
        allowExternalVersionProbe: args.bool("probe-client-versions"))
    let viewer = installedViewer()

    // Unknown daemon health cannot inherit the caller's grants or count as an image match.
    let effectiveCanDrive = daemonIsRunning ? daemonRuntime?.canDrive == true : capabilities.canDrive
    let effectiveCanCapture = daemonIsRunning ? daemonRuntime?.canCapture == true : capabilities.canCapture
    let permissionReadiness = PermissionReadinessReport(
        clientAX: capabilities.items.first { $0.name == "accessibility" }?.available == true,
        clientCapture: capabilities.items.first { $0.name == "screen-recording" }?.available == true,
        daemon: daemonRuntime)
    var report = DoctorReport(
        macOS: ProcessInfo.processInfo.operatingSystemVersionString,
        cliVersion: SpaceOVersion.current, cliPath: cliPath,
        capabilities: capabilities.items, missingSymbols: capabilities.missingSymbols,
        clientCanDrive: capabilities.canDrive, clientCanCapture: capabilities.canCapture,
        builtWithARC: capabilities.builtWithARC, callerAttribution: callerAttribution,
        socketPath: socketPath, daemon: daemonState, daemonMatchesCLI: daemonMatchesCLI,
        launchAgentInstalled: supervision.installed, launchAgentRunning: supervision.running,
        logPath: logURL.path, logBytes: logSize,
        spaceODisplayIDs: attachedSpaceODisplays, orphanedDisplayIDs: orphanedDisplayIDs,
        userOnlineDisplayIDs: Stage.nonSpaceOOnlineDisplayIDs(),
        userActiveDisplayIDs: Stage.nonSpaceOActiveDisplayIDs(),
        mirroredDisplayIDs: Stage.mirroredNonSpaceODisplayIDs(),
        mcpClients: mcpClients, viewer: viewer, viewerSearchPaths: viewerSearchPaths(),
        diskBytes: spaceoDiskBytes, diskRoot: spaceoRoot?.path,
        orphanProfileDirectories: orphanProfileDirectories,
        readiness: permissionReadiness,
        focusLine: AttentionMitigation.focusStatusLine(focusActive: nil))
    report.logging = LoggingSettings.load()
    report.displaySafety = Stage.displaySafetyStatus()
    report.displayIdentityResidue = DisplayIdentityResidue.scan()
    let doctorOK = effectiveCanDrive && (!daemonIsRunning || daemonMatchesCLI == true)
        && !daemonUnresponsive
        && report.effectiveDisplaySafety?.allowsCreation == true
        && (!args.bool("interactive") || permissionReadiness.state == "ready")

    if !args.hasJSON { print(report.render()) }

    var fixes: [[String: Any]] = []
    if args.bool("fix") {
        // Only remediations that cannot disturb a working session, each behind a prompt.
        let findings = DoctorFindings(
            accessibilityGranted: daemonIsRunning ? daemonRuntime?.accessibilityGranted ?? false : AXIsProcessTrusted(),
            screenRecordingGranted: daemonIsRunning ? daemonRuntime?.screenRecordingGranted ?? false : CGPreflightScreenCaptureAccess(),
            daemonRunning: daemonIsRunning,
            daemonMatchesCLI: daemonMatchesCLI,
            orphanedDisplayIDs: orphanedDisplayIDs,
            orphanLedgerNamespaces: [],
            orphanProfileDirectories: orphanProfileDirectories,
            liveSessionCount: daemonResponse?.usage?.sessions ?? 0,
            daemonUnresponsive: daemonUnresponsive)
        fixes = applyDoctorRemedies(DoctorRemedy.remedies(for: findings), daemonIsRunning: daemonIsRunning,
                                   permissionGrantTarget: report.permissionGrantTarget)
    }

    if args.hasJSON {
        print(CLIJSON.object(doctorPayload(
            report: report, ok: doctorOK, capabilities: capabilities,
            effectiveCanDrive: effectiveCanDrive, effectiveCanCapture: effectiveCanCapture,
            daemonRuntime: daemonRuntime, daemonIsRunning: daemonIsRunning,
            cliSHA256: cliExecutableSHA256, cliBuildUUID: cliExecutableBuildUUID,
            fixes: args.bool("fix") ? fixes : nil)))
    }
    exit(doctorOK ? 0 : 1)
}

/// Runs each confirmed remedy; prose goes through `note` so `--json` stays one object.
func applyDoctorRemedies(_ remedies: [DoctorRemedy], daemonIsRunning: Bool,
                         permissionGrantTarget: String) -> [[String: Any]] {
    var results: [[String: Any]] = []
    if remedies.isEmpty { note("\ndoctor --fix: nothing to fix") }
    for remedy in remedies {
        note("")
        let accepted: Bool
        if args.bool("yes") {
            note(remedy.title)
            accepted = true
        } else if isatty(STDIN_FILENO) == 1 {
            note(remedy.title + " [y/N] ", terminator: "")
            accepted = readLine()?.lowercased().hasPrefix("y") == true
        } else {
            note(remedy.title + "\n  skipped (no terminal; pass --yes)")
            accepted = false
        }
        guard accepted else {
            results.append(["remedy": remedy.title, "applied": false])
            continue
        }
        var outcome = ""
        switch remedy {
        case .openSettingsPane(let pane):
            NSWorkspace.shared.open(pane.url)
            outcome = "opened System Settings; enable \(permissionGrantTarget) there"
        case .restartDaemonWhenIdle:
            // Doctor never passes --now: it waits a bounded minute for sessions to finish, and
            // otherwise leaves the restart to `spaceo daemon restart --operator`.
            outcome = restartDaemon(mode: .whenIdle, timeout: 60).message
        case .quarantineOrphanLedgers:
            outcome = "ledger quarantine is performed by the daemon on startup; nothing to do here"
        case .removeOrphanProfiles(let paths):
            if daemonIsRunning {
                var clean = Request(cmd: "clean"); clean.operatorScope = true
                let response = try? Transport.send(clean, to: socketPath, timeout: 60)
                outcome = response?.message ?? response?.error ?? "clean failed"
            } else {
                let report = DiskHygiene.clean(candidates: paths.map { URL(fileURLWithPath: $0, isDirectory: true) }, dryRun: false)
                outcome = DiskHygiene.summaryLine(report)
            }
        case .printDisplayWakeCommands:
            outcome = remedy.manualCommand ?? ""
        }
        note("  " + outcome.replacingOccurrences(of: "\n", with: "\n  "))
        results.append(["remedy": remedy.title, "applied": true, "result": outcome])
    }
    return results
}

func doctorPayload(report: DoctorReport, ok: Bool, capabilities: Capabilities,
                   effectiveCanDrive: Bool, effectiveCanCapture: Bool,
                   daemonRuntime: DaemonRuntimeInfo?, daemonIsRunning: Bool,
                   cliSHA256: String?, cliBuildUUID: String?,
                   fixes: [[String: Any]]?) -> [String: Any] {
    let state: String
    switch report.daemon {
    case .notRunning: state = "not_running"
    case .unresponsive: state = "unresponsive"
    case .running: state = "running"
    }
    var daemonPayload: [String: Any] = [
        "socket": report.socketPath,
        "running": daemonIsRunning,
        "state": state,
        "logFile": report.logPath,
        "logBytes": report.logBytes.map { $0 as Any } ?? NSNull(),
        "matchesCLI": report.daemonMatchesCLI.map { $0 as Any } ?? NSNull(),
        "supervisedByLaunchd": report.launchAgentInstalled,
        "launchAgentRunning": report.launchAgentRunning,
        "callerAttribution": report.callerAttribution.map { $0 as Any } ?? NSNull(),
    ]
    if let daemonRuntime {
        daemonPayload["version"] = daemonRuntime.version
        daemonPayload["protocolVersion"] = daemonRuntime.protocolVersion
        daemonPayload["executableSHA256"] = daemonRuntime.executableSHA256.map { $0 as Any } ?? NSNull()
        daemonPayload["executableBuildUUID"] = daemonRuntime.executableBuildUUID.map { $0 as Any } ?? NSNull()
        daemonPayload["pid"] = daemonRuntime.pid
        daemonPayload["instanceID"] = daemonRuntime.instanceID.uuidString
        daemonPayload["startedAt"] = daemonRuntime.startedAt.ISO8601Format()
        daemonPayload["accessibilityGranted"] = daemonRuntime.accessibilityGranted.map { $0 as Any } ?? NSNull()
        daemonPayload["screenRecordingGranted"] = daemonRuntime.screenRecordingGranted.map { $0 as Any } ?? NSNull()
        daemonPayload["canDrive"] = daemonRuntime.canDrive.map { $0 as Any } ?? NSNull()
        daemonPayload["canCapture"] = daemonRuntime.canCapture.map { $0 as Any } ?? NSNull()
        daemonPayload["responsibleProcess"] = daemonRuntime.responsibleProcess.map { $0 as Any } ?? NSNull()
        daemonPayload["draining"] = daemonRuntime.draining ?? false
        daemonPayload["displaySafety"] = daemonRuntime.displaySafety.flatMap {
            try? JSONSerialization.jsonObject(with: Wire.encoder.encode($0))
        } ?? NSNull()
        daemonPayload["hostHealth"] = daemonRuntime.hostHealth.flatMap {
            try? JSONSerialization.jsonObject(with: Wire.encoder.encode($0))
        } ?? NSNull()
    }
    var readinessPayload = ((try? JSONSerialization.jsonObject(with: Wire.encoder.encode(report.readiness))) as? [String: Any]) ?? [:]
    if let safety = report.effectiveDisplaySafety, !safety.allowsCreation {
        readinessPayload["state"] = "blocked"
        readinessPayload["blockers"] = report.blockers.map(\.code)
        readinessPayload["nextAction"] = report.blockers.first?.next
    }
    let safetyPayload = report.effectiveDisplaySafety.flatMap {
        try? JSONSerialization.jsonObject(with: Wire.encoder.encode($0))
    } ?? NSNull()
    var payload: [String: Any] = [
        "ok": ok,
        "readiness": readinessPayload,
        "displaySafety": safetyPayload,
        "displayIdentityResidue": report.displayIdentityResidue.flatMap {
            try? JSONSerialization.jsonObject(with: Wire.encoder.encode($0))
        } ?? NSNull(),
        "readinessBlockers": report.blockers.map { ["code": $0.code, "sentence": $0.sentence, "next": $0.next] },
        "scope": "host-health; readiness additionally requires the daemon",
        "macOS": report.macOS,
        "capabilities": capabilities.items.map {
            [
                "name": $0.name,
                "available": $0.available,
                "intentionallyDisabled": DoctorReport.intentionallyDisabledCapabilities.contains($0.name),
                "detail": $0.detail,
                "unavailableReason": $0.unavailableReason.map { $0 as Any } ?? NSNull(),
            ]
        },
        "missingSymbols": capabilities.missingSymbols,
        "canDrive": effectiveCanDrive,
        "canCapture": effectiveCanCapture,
        "builtWithARC": capabilities.builtWithARC,
        "client": [
            "version": SpaceOVersion.current,
            "path": report.cliPath,
            "executableSHA256": cliSHA256.map { $0 as Any } ?? NSNull(),
            "executableBuildUUID": cliBuildUUID.map { $0 as Any } ?? NSNull(),
            "canDrive": capabilities.canDrive,
            "canCapture": capabilities.canCapture,
        ],
        "daemon": daemonPayload,
        "displays": [
            "spaceO": report.spaceODisplayIDs,
            "orphanedSpaceO": report.orphanedDisplayIDs,
            "daemonDeferredRetirement": report.deferredRetirementDisplayIDs,
            "userOnline": report.userOnlineDisplayIDs,
            "userActive": report.userActiveDisplayIDs,
            "mirroredUser": report.mirroredDisplayIDs,
        ],
        "mcpClients": report.mcpClients.map { status -> [String: Any] in
            [
                "client": status.client.rawValue,
                "configured": status.registration != nil,
                "scope": status.registration?.scope as Any? ?? NSNull(),
                "source": status.registration?.source as Any? ?? NSNull(),
                "command": status.registration?.command as Any? ?? NSNull(),
                "path": status.resolvedPath as Any? ?? NSNull(),
                "version": status.version as Any? ?? NSNull(),
                "matchesCLI": status.matchesCLI as Any? ?? NSNull(),
                "problem": status.problem as Any? ?? NSNull(),
                "remedy": status.remedy as Any? ?? NSNull(),
            ]
        },
        "viewer": [
            "installed": report.viewer != nil,
            "path": report.viewer?.path as Any? ?? NSNull(),
            "version": report.viewer?.version as Any? ?? NSNull(),
            "searched": report.viewerSearchPaths,
        ],
        "disk": [
            "spaceORoot": report.diskRoot as Any? ?? NSNull(),
            "spaceOBytes": report.diskBytes,
            "orphanProfileDirectories": report.orphanProfileDirectories,
        ],
    ]
    if let fixes { payload["fixes"] = fixes }
    return payload
}

// MARK: - daemon install / uninstall

func runLaunchAgentChange(installing: Bool) -> Never {
    let executable = currentExecutablePath()
    do {
        if installing {
            let identity = LaunchAgentInstaller.signingIdentity(of: executable)
            let plan = try LaunchAgentInstaller.plan(executablePath: executable, socketPath: socketPath, identity: identity)
            note("Will write \(plan.plistURL.path) and run: \(plan.bootstrapCommand.joined(separator: " "))")
            note("The daemon then has its own TCC identity (\(identity)); grant Accessibility and Screen Recording to it once.")
            guard confirm("Proceed?", refusal: "pass --yes to install without a terminal") else {
                fail("not installed", exit: .failure, code: "cancelled")
            }
            try LaunchAgentInstaller.install(plan)
            let message = "installed; run `spaceo daemon status` and `spaceo doctor`"
            print(args.hasJSON
                ? CLIJSON.object(["ok": true, "installed": true, "plist": plan.plistURL.path, "message": message])
                : message)
        } else {
            guard confirm("Remove the LaunchAgent and stop the supervised daemon?",
                          refusal: "pass --yes to uninstall without a terminal") else {
                fail("kept", exit: .failure, code: "cancelled")
            }
            try LaunchAgentInstaller.uninstall()
            print(args.hasJSON
                ? CLIJSON.object(["ok": true, "installed": false, "plist": LaunchAgentInstaller.plistURL().path, "message": "uninstalled"])
                : "uninstalled")
        }
        exit(0)
    } catch {
        fail(error.localizedDescription, exit: .failure)
    }
}

// MARK: - daemon restart

/// Stops the running daemon (draining, the legacy wait, or `--now`) and starts this build.
/// Shared by `daemon restart` and `doctor --fix`.
func restartDaemon(mode: DaemonRestart.Mode, timeout: TimeInterval) -> (ok: Bool, message: String, ready: Response?) {
    let executable = currentExecutablePath()
    let status = Transport.pingResponse(socketPath)
    if status?.ok == true {
        let oldProcess = status?.daemon.flatMap { ProcessIdentity.current(of: $0.pid) }
        let restart = DaemonRestart(
            send: { request, timeout in try Transport.send(request, to: socketPath, timeout: timeout) },
            // A daemon too old to report its pid is tracked by its socket instead.
            isAlive: { oldProcess?.isAlive ?? Transport.isListening(socketPath) },
            sleep: { usleep(UInt32(max(0, min($0, 5)) * 1_000_000)) },
            progress: { note("  " + $0) })
        switch restart.run(mode: mode, timeout: timeout) {
        case .stopped(let message):
            note("  " + message)
        case .stillBusy(let message):
            return (false, message, nil)
        case .refused(let response):
            return (false, response.error ?? "the daemon refused the restart", response)
        case .unreachable(let message):
            return (false, "lost contact with the daemon: \(message)", nil)
        }
    } else if Transport.isListening(socketPath) {
        return (false, "a daemon is listening at \(socketPath) but not answering; retry, or read "
            + DaemonLog.defaultLogURL().path, nil)
    } else {
        note("  no daemon was running at \(socketPath)")
    }

    if LaunchAgentInstaller.status().installed {
        note("  launchd supervises the daemon; waiting for it to come back…")
    } else {
        note("  starting \(executable) as a daemon from this process (grants attribute to: \(ResponsibleProcess.describeCurrent() ?? "unknown"))")
        _ = Setup.startDaemon(executablePath: executable, socketPath: socketPath)
    }
    let readyDeadline = Date().addingTimeInterval(15)
    while Date() < readyDeadline {
        if let response = Transport.pingResponse(socketPath), response.ok, response.daemon != nil {
            return (true, "the daemon is running \(response.daemon?.version ?? "an unknown version") "
                + "(pid \(response.daemon.map { String($0.pid) } ?? "?"))", response)
        }
        usleep(200_000)
    }
    return (false, "no daemon answered within 15s after the restart; run `spaceo doctor`", nil)
}

func runDaemonRestart() -> Never {
    guard args.bool("operator") else {
        fail("daemon restart affects every controller's sessions; pass --operator to confirm")
    }
    let timeout = doubleArgument("timeout") ?? 900
    guard timeout.isFinite, (1...3_600).contains(timeout) else { fail("timeout must be from 1 through 3600 seconds") }
    let result = restartDaemon(mode: args.bool("now") ? .now : .whenIdle, timeout: timeout)
    if let ready = result.ready, result.ok {
        var response = ready
        response.message = result.message
        emit(response, json: args.hasJSON)
    }
    if let refused = result.ready {
        emit(refused, json: args.hasJSON)
    }
    fail(result.message, exit: .daemonUnavailable, code: "daemon_restart_incomplete",
         next: args.bool("now") ? "spaceo doctor" : "spaceo daemon restart --operator --now")
}

/// RA-057 residue: dry run by default; `--apply` must run as root because ColorSync silently
/// ignores unregistration from a normal account.
func runCleanDisplayIdentities(apply: Bool) -> Never {
    if !apply {
        let plan: DisplayIdentityCleanup.Plan
        do { plan = try DisplayIdentityCleanup.plan() }
        catch { fail(error.localizedDescription, exit: .failure, code: "display_identity_cleanup_refused") }
        if args.hasJSON {
            print(CLIJSON.object([
                "ok": true, "applied": false,
                "registrations": plan.registrations.count, "profiles": plan.profilePaths.count,
                "unattributedWithoutProfile": plan.unattributedWithoutProfile,
            ]))
        } else {
            print("SpaceO ColorSync registrations: \(plan.registrations.count)")
            print("SpaceO display profiles:        \(plan.profilePaths.count)")
            if plan.unattributedWithoutProfile > 0 {
                print("registrations without a readable profile (left alone): \(plan.unattributedWithoutProfile)")
            }
            print(plan.registrations.isEmpty && plan.profilePaths.isEmpty
                ? "nothing to clean"
                : "to remove them, stop every SpaceO daemon and Viewer, then run:\n"
                    + "  sudo spaceo safety clean-display-identities --apply --operator\n"
                    + "then log out and back in: until then WindowServer keeps asking ColorSync about "
                    + "every display attached since login")
        }
        exit(0)
    }
    do {
        let outcome = try DisplayIdentityCleanup.apply(
            backupRoot: "/Library/Application Support/SpaceO/ColorSync backups")
        if args.hasJSON {
            print(CLIJSON.object([
                "ok": outcome.confirmed, "applied": true, "backup": outcome.backup,
                "unregistered": outcome.unregistered, "remainingRegistrations": outcome.remainingRegistrations,
                "removedProfiles": outcome.movedProfiles, "profileRemovalSkipped": outcome.profileRemovalSkipped,
                "failedProfiles": outcome.failedProfiles.count, "verificationFailed": outcome.verificationFailed,
            ]))
        } else {
            print("backup: \(outcome.backup)")
            print("unregistered \(outcome.unregistered) of \(outcome.plan.registrations.count) SpaceO registrations; "
                + "removed \(outcome.movedProfiles) of \(outcome.plan.profilePaths.count) profiles")
            if outcome.verificationFailed {
                print("ColorSync could not be listed again, so the unregistration is unconfirmed and no profile was "
                    + "removed; the backup above holds the registry from before; rerun the command")
            } else if outcome.profileRemovalSkipped {
                print("a SpaceO process or display appeared during cleanup, so no profile was removed; stop it and rerun")
            } else if outcome.remainingRegistrations > 0 {
                print("\(outcome.remainingRegistrations) registrations are still listed; their profiles were kept")
            } else if !outcome.failedProfiles.isEmpty {
                print("\(outcome.failedProfiles.count) SpaceO profiles could not be removed; rerun after checking "
                    + DisplayIdentityResidue.profilesDirectory)
            } else {
                print("log out and back in (or restart): until then WindowServer keeps asking ColorSync about "
                    + "every display attached since login")
            }
        }
        exit(outcome.confirmed ? 0 : 1)
    } catch {
        fail(error.localizedDescription, exit: .failure, code: "display_identity_cleanup_refused")
    }
}
