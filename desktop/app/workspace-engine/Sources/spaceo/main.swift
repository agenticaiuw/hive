import Foundation
import AppKit
import CoreGraphics
import Darwin
import SpaceOKit
import SpaceOMCP

// The argument parser and its flag table live in SpaceOKit (`CLIArguments.swift`) so they can be
// unit tested; this target is top-level code and cannot be imported by the test bundle. So do
// the exit-code classes and JSON envelope (`CLIContract.swift`), per-command help
// (`CLIHelp.swift`), and the doctor renderer (`DoctorReport.swift`). Setup, doctor, and daemon
// lifecycle commands live in `HostCommands.swift`.

// MARK: - Output

/// Read from raw argv so a failure during argument parsing still answers in JSON.
let jsonRequested = CommandLine.arguments.dropFirst().contains { $0 == "--json" || $0 == "--json=true" }

/// The CLISpec key being run (`click`, `session.create`), set by `validateFlags`. It picks the
/// help pointer in usage errors, the exit-code class, and which environment defaults apply.
var currentCommandKey = ""

/// Prose that is not the command's result: progress, prompts, narration. In `--json` mode it
/// goes to stderr so stdout carries exactly one JSON object.
func note(_ text: String, terminator: String = "\n") {
    if jsonRequested {
        FileHandle.standardError.write(Data((text + terminator).utf8))
    } else {
        print(text, terminator: terminator)
        fflush(stdout)
    }
}

func writeStandardError(_ text: String) {
    FileHandle.standardError.write(Data((text + "\n").utf8))
}

/// Ends the process on a failure the CLI detected itself. Usage mistakes exit 2 and point at the
/// command's help; runtime failures pass their own class. Never prints the usage text.
func fail(_ message: String, exit status: CLIExitCode = .usage, code: String? = nil,
          next: String? = nil) -> Never {
    let errorCode = code ?? (status == .usage ? "usage_error" : "cli_error")
    let helpTarget = currentCommandKey.isEmpty
        ? (CommandLine.arguments.dropFirst().first.map { $0.hasPrefix("-") ? "help" : $0 } ?? "help")
        : currentCommandKey.replacingOccurrences(of: ".", with: " ")
    let nextAction = next ?? (status == .usage ? "spaceo \(helpTarget) --help" : nil)
    if jsonRequested {
        print(CLIJSON.error(message: message, code: errorCode, nextAction: nextAction))
    } else {
        writeStandardError("error: " + message)
        if let nextAction { writeStandardError("next: " + nextAction) }
    }
    exit(status.rawValue)
}

func printWindows(_ windows: [WindowInfo], indent: String = "") {
    for window in windows {
        print(String(format: "%@win  %-6u pid %-6d %@%.0fx%.0f at (%.0f,%.0f)  %@",
                     indent, window.windowID, window.pid,
                     window.onStage ? "" : "OFF-STAGE ",
                     window.width, window.height, window.x, window.y,
                     window.title.isEmpty ? "" : "\"\(window.title)\""))
    }
}

func printSession(_ session: SessionInfo) {
    let tile = session.exclusiveDisplay
        ? "whole display"
        : "tile \(session.tileIndex + 1)/\(session.tileCapacity)"
    if session.runtimeAttached == false {
        print("session \(session.id)  DETACHED RECOVERY RECORD")
        if session.displayID != 0, session.width > 0, session.height > 0 {
            print(String(
                format: "   last-known placement only: display %u (%@) %.0fx%.0f "
                    + "at (%.0f,%.0f); not a live target",
                session.displayID, tile,
                session.width, session.height, session.x, session.y))
        }
    } else {
        print(String(
            format: "session %@  display %u (%@)  %.0fx%.0f at (%.0f,%.0f)  "
                + "spaces=%@ ownSpace=%@",
            session.id, session.displayID, tile,
            session.width, session.height, session.x, session.y,
            session.spaces.map(String.init).joined(separator: ","),
            session.hasOwnSpace ? "yes" : "no"))
    }
    if let title = session.title, !title.isEmpty {
        print("   title: \(title)" + (session.colorTag.map { " [\($0)]" } ?? ""))
    }
    if session.inputPaused == true {
        print("   input: PAUSED" + (session.agentPauseReason.map { " (agent: \($0))" } ?? " (operator has Control)"))
    }
    if session.operatorHandoff != nil { print("   operator handoff pending for the agent") }
    if let recording = session.recording { print("   recording: \(recording)") }
    if session.redacted == true {
        print("   apps/windows redacted: another controller holds this session "
            + "(pass its --lease, or --operator)")
    }
    let lifecycleStatus: String?
    if session.teardownPending {
        lifecycleStatus = "cleanup pending"
    } else if session.reclaimable == true {
        lifecycleStatus = "reclaimable"
    } else if session.abandoned == true {
        lifecycleStatus = "abandoned"
    } else if session.controllerOwner != nil {
        lifecycleStatus = "owned"
    } else {
        lifecycleStatus = nil
    }
    if let lifecycleStatus {
        var line = "   lifecycle: \(lifecycleStatus)"
        if session.abandoned == true, session.runtimeAttached != false,
           let remaining = session.graceRemainingSeconds, remaining.isFinite {
            line += remaining > 0
                ? " — claimable for \(Int(remaining.rounded(.up)))s with `session claim`, then its apps are quit"
                : " — reclamation is due"
        }
        print(line)
    }
    if let idle = session.idleSeconds, idle.isFinite {
        print("   idle: \(Int(max(0, idle).rounded(.down)))s since the controller last acted or read")
    }
    if let owner = session.controllerOwner {
        print("   owner: \(owner.label) (\(owner.kind.rawValue), id \(owner.id))")
    }
    if let lastActivityAt = session.lastActivityAt {
        print("   last activity: \(lastActivityAt.ISO8601Format())")
    }
    if let age = session.ageSeconds, age.isFinite {
        print("   age: \(Int(max(0, age).rounded(.down)))s")
    }
    if session.teardownPending {
        print("   ! cleanup pending; retry session destroy after resolving surviving resources")
    }
    for blocker in session.recoveryBlockers ?? [] {
        print("   ! \(blocker.code): \(blocker.message)")
    }
    for app in session.apps {
        let prefix = session.runtimeAttached == false ? "recorded app" : "app"
        print("   \(prefix)  pid \(app.pid)  \(app.name)"
            + "\(app.startedByUs ? "" : "  (adopted)")")
    }
    if let failure = session.windowDiscoveryFailure {
        print("   ! windows below are last known; discovery incomplete: \(failure)")
    }
    printWindows(session.windows, indent: "   ")
}

func printIsolation(_ report: IsolationReport) {
    switch report.verdict {
    case .intact:
        print("  isolation: intact — \(report.summarySentence)")
    case .partial:
        print("  isolation: partial — \(report.summarySentence)")
        print("    \(report.nextStepLine)")
    case .breached:
        print("  ISOLATION BREACH — \(report.summarySentence)")
        print("    \(report.nextStepLine)")
    }

    for check in report.checks {
        print("    - \(check.dimension.rawValue): \(check.status.rawValue) "
            + "[\(check.coverage.rawValue)] — \(check.evidence)")
        for failure in check.failures {
            print("      ! \(failure)")
        }
    }
}

func printLegacyIsolation(_ drift: [String]) {
    if drift.isEmpty {
        print("  isolation: coverage unavailable (daemon returned no per-check report)")
    } else {
        print("  ISOLATION BREACH:")
        for item in drift { print("    - \(item)") }
    }
}

func printSteps(_ response: Response) {
    if let steps = response.steps {
        for step in steps {
            print("  step \(step.index) \(step.cmd): " + (step.executed ? (step.ok ? "ok" : "FAILED") : "not executed")
                + (step.error.map { " — \($0.replacingOccurrences(of: "\n", with: " | "))" } ?? ""))
            if let completion = step.completion { print("    completion: \(completion)") }
            if let snapshot = step.snapshotID { print("    snapshot: \(snapshot)") }
            if let outline = step.outline { print(outline) }
            if let report = step.truncation { print("    " + report.footer) }
            if step.outputTruncated == true { print("    step output truncated; run find separately and check its truncation report") }
        }
    }
    if let failure = response.firstFailureIndex { print("  first failure index: \(failure)") }
}

func printControllerLease(_ lease: UUID) {
    print("controller lease: \(lease.uuidString.lowercased())")
    print("  Keep this credential secret. Pass it as --lease <UUID> to heartbeat "
        + "and session mutations; it cannot be recovered from `session list`.")
}

/// Set by `session create --export`: print shell exports instead of the session description.
var exportRequested = false

/// Prints one daemon response and exits with its class. `notices` are CLI-side warnings (version
/// drift) that go to stderr in text mode; the caller folds them into `warnings` for JSON.
func emit(_ response: Response, json: Bool, notices: [String] = []) -> Never {
    var response = response
    if response.errorCode == "daemon_not_running" {
        response.nextAction = LaunchAgentInstaller.startNextAction(
            installed: FileManager.default.fileExists(atPath: LaunchAgentInstaller.plistURL().path))
    }
    let status = CLIExitCode.classify(response, command: currentCommandKey)
    if json {
        print(CLIJSON.encode(response))
        exit(status.rawValue)
    }
    for notice in notices { writeStandardError("warning: " + notice) }

    if !response.ok {
        if let lease = response.controllerLeaseID {
            if let session = response.session { printSession(session) }
            printControllerLease(lease)
        }
        for warning in response.warnings ?? [] { print("  warning: \(warning)") }
        if let handoff = response.handoff { print(handoff.summaryLine) }
        printSteps(response)
        if let isolation = response.isolation {
            printIsolation(isolation)
        } else if let drift = response.drift {
            printLegacyIsolation(drift)
        }
        fflush(stdout)
        var error = response.error ?? "unknown failure"
        if error.localizedCaseInsensitiveContains("controller lease") {
            error += "\nPass the session's current credential with --lease <UUID> (or export "
                + "SPACEO_LEASE). Lease credentials are returned only by create and heartbeat, never by list."
        }
        writeStandardError("error: " + error)
        if let next = response.nextAction { writeStandardError("next: " + next) }
        exit(status == .success ? CLIExitCode.failure.rawValue : status.rawValue)
    }

    if exportRequested {
        guard let lease = response.controllerLeaseID, let session = response.session?.id else {
            fail("the daemon returned no session lease to export", exit: .failure)
        }
        print(SessionExport.line(session: session, lease: lease))
        print(SessionExport.expiryComment(expiresAt: response.session?.leaseExpiresAt))
        writeStandardError("created session \(session); its lease is in SPACEO_LEASE once you eval this output. Keep it secret.")
        exit(0)
    }

    if let handoff = response.handoff { print(handoff.summaryLine) }
    if let message = response.message { print(message) }
    if let point = response.resolvedPoint {
        print("  resolved point: (\(Int(point.x)),\(Int(point.y))) from \(point.source)\(point.element.map { " \($0)" } ?? "")")
    }
    if let wait = response.wait {
        print("  wait: \(wait.condition) outcome=\(wait.outcome) elapsed=\(String(format: "%.1f", wait.elapsedSeconds))s probes=\(wait.probes)"
            + (wait.matchedIndex.map { " element=\($0)" } ?? "") + (wait.matchedTitle.map { " title=\"\($0)\"" } ?? ""))
    }
    if let navigation = response.navigation {
        print("  navigation: \"\(navigation.title)\" \(navigation.finalURL) target=\(navigation.targetID) load=\(navigation.load)")
    }
    if let paste = response.paste {
        print("  clipboard: inserted via \(paste.insertedVia), \(paste.bytes) byte(s)" + (paste.note.map { "; \($0)" } ?? ""))
    }
    printSteps(response)
    for event in response.events ?? [] {
        var line = "\(event.seq)  \(event.at.ISO8601Format())  \(event.kind)"
        if let sessionID = event.session { line += "  \(sessionID)" }
        if event.redacted == true { line += "  [redacted]" }
        else if !event.detail.isEmpty { line += "  " + event.detail.keys.sorted().map { "\($0)=\(event.detail[$0] ?? "")" }.joined(separator: " ") }
        print(line)
    }
    if let next = response.nextSeq { print("next seq: \(next)" + (response.resyncRequired == true ? " (resync required: run session list)" : "")) }
    if let session = response.session { printSession(session) }
    if let sessions = response.sessions {
        if sessions.isEmpty { print("no sessions") }
        for session in sessions { printSession(session) }
    }
    if let windows = response.windows { printWindows(windows) }
    if let outline = response.outline { print(outline) }
    if let path = response.path { print(path) }
    if let displays = response.displays {
        if displays.isEmpty { print("no agent displays") }
        for display in displays {
            print(String(format: "display %-4u %.0fx%.0f at (%.0f,%.0f)  %d/%d tiles used  spaces=%@",
                         display.displayID, display.width, display.height, display.x, display.y,
                         display.used, display.capacity,
                         display.spaces.map(String.init).joined(separator: ",")))
        }
    }
    if let findings = response.findings {
        for finding in findings { print("  ! \(finding)") }
    }
    if let value = response.value, !value.isEmpty {
        if response.source != nil || response.clipboardBytes != nil {
            print(value)
        } else {
            let oneLine = value.replacingOccurrences(of: "\n", with: "\\n")
            print("  focused value: \(oneLine.count > 160 ? String(oneLine.prefix(160)) + "…" : oneLine)")
        }
    }
    if let isolation = response.isolation {
        printIsolation(isolation)
    } else if let drift = response.drift {
        printLegacyIsolation(drift)
    }
    if let truncation = response.truncation, truncation.truncated {
        print("  " + truncation.footer)
    }
    if let warnings = response.warnings, !warnings.isEmpty {
        for item in warnings { print("  unconfirmed: \(item)") }
    }
    if let ambient = response.ambient, !ambient.isEmpty {
        for item in ambient { print("  note: \(item)") }
    }
    if let lease = response.controllerLeaseID {
        printControllerLease(lease)
    }
    if status == .waitNotMet {
        fflush(stdout)
        writeStandardError("wait condition not met (outcome \(response.wait?.outcome ?? "unknown")); exiting 6")
    }
    exit(status.rawValue)
}

let usage = """
spaceo — give each agent its own screen, and leave the user's alone.

  spaceo help [command]                  this list, or one command's usage, options, and examples
  spaceo setup                           guided first-run: grants, daemon, self-test, MCP config
  spaceo doctor                          check host, permissions, daemon, MCP clients, Viewer, disk
  spaceo doctor --probe-client-versions  also execute configured client commands with version
  spaceo version                         print the installed version
  spaceo completions zsh|bash|fish       shell completion script, generated from the command table
  spaceo schema --json                   versioned command vocabulary, without contacting a daemon
  spaceo mcp                             MCP server over stdio, for Claude Code / Codex / Cursor
  spaceo daemon [--socket P] [--sessions-per-display N] [--display-size WxH]
                                         run the session host (keep this alive)
  spaceo daemon stop [--operator]        stop the shared daemon and clean up its sessions
  spaceo daemon restart [--now] --operator
                                         wait for live sessions to finish (drain), then start
                                         this build; --now stops immediately
  spaceo daemon drain --operator         refuse new sessions; exit after the last one ends
  spaceo daemon wait [--timeout S]       wait until a daemon answers
  spaceo daemon install|uninstall|status install the daemon as a LaunchAgent with a stable TCC identity
  spaceo setup --client claude-code|codex|cursor|claude-desktop [--yes|--print]
                                         write the MCP registration for that client
  spaceo safety <subcommand>             local operator recovery
  spaceo safety clear-host-health --operator
                                         recover an idle unknown-health, pressure, swap or WindowServer-report latch after stopping owners
  spaceo safety clean-display-identities [--apply] --operator
                                         list (or, with sudo, remove) ColorSync state left by older display identities
  spaceo doctor --fix [--yes]            apply the safe remediations doctor found
  spaceo clean [--dry-run] --operator    remove orphaned browser profiles and control roots
  spaceo events [--follow] [--since-seq N]  daemon event stream (agent actions, pauses, verdicts)
  spaceo report <recording-dir> [-o out.html]  render a recorded session as an HTML timeline
  spaceo skill                           print the SKILL.md playbook for Claude Code / Codex
  spaceo logging status                  show local diagnostic logging (agent journal, daemon requests)
  spaceo logging enable [--level full|metadata] [--retention-days N] [--max-mb N]
                                         journal every MCP tool call and log every daemon request
  spaceo logging disable                 back to failures-only logging

  spaceo session create [--session ID] [--controller-ttl SECONDS] [--lease UUID]
                        [--orphan-grace SECONDS]
                        [--app NAME] [--preset shared|exclusive|exclusive_1080p|exclusive_1440p]
                        [--title T] [--record actions|actions+frames] [--export]
                          actions+frames saves bounded session-tile images, which can include
                          visible typed text. Missing frames carry status in the recording.
                                         take a tile and receive its controller lease;
                                         eval "$(spaceo session create --export)" sets
                                         SPACEO_SESSION and SPACEO_LEASE for later commands
  spaceo session annotate [--title T] [--color red|…|gray]
  spaceo session list [--lease UUID] [--operator]
                                         other controllers' app/window detail is redacted
                                         unless your lease covers them or --operator is set
  spaceo session heartbeat [--session ID] --lease UUID
  spaceo session claim --session ID [--controller-ttl SECONDS] [--orphan-grace SECONDS]
                                         take over an abandoned session (its controller exited
                                         or its lease expired) with its apps; prints a new lease
  spaceo session pause [--session ID] [--lease UUID] [--operator] [--reason "needs 2FA"]
  spaceo session resume [--session ID] [--lease UUID] [--operator] [--note "logged you in"]
  spaceo session destroy [--session ID] [--all] [--keep-apps] [--operator]

  spaceo pool                            displays, capacity and occupancy
  spaceo pool set <N> --operator         sessions per display for new displays
  spaceo pool remove <DISPLAY> --operator
  spaceo pool trim --operator        Retire idle displays; preserve active sessions
                                         end every session on a virtual display and remove it

  spaceo run <app> [files...]            launch an app onto a session, no activation
                                         (reuses a running instance; --new-instance to force)
  spaceo open-url <URL> [--new-tab]      navigate the session's managed Chromium
  spaceo wait <condition> [value] [--timeout S] [--match exact|contains] [--role TextField]
                                         element_label | element_gone | window_title_contains |
                                         web_selector | web_title_contains | stable_ms | ms |
                                         session_resumed (waits out a pause; allowed while paused)
                                         labels match the accessible name; timeouts are normal outcomes
                                         queue admission shares the budget; wait_queue_timeout is an error
  spaceo menu [TITLE ...] [--press] [--pid N]
                                         list the app's menu bar, a menu, or press an item
                                         without activating the app; e.g. menu File New --press
  spaceo find <query> [--role Button]    search elements; returns fresh indices
  spaceo text [--element N] [--max-chars N]
                                         the window's text in reading order, or one element's
  spaceo steps --steps-json '[{"cmd":"click","element":"3"},…]'
                                         up to 16 actions; other commands may interleave
                                         60s budget includes queueing; waits use the remainder
                                         queue expiry preserves receipts; do not replay completed steps
                                         wait timeouts fail; --continue-on-failure to proceed
  spaceo clipboard get | set <text>      the session's private clipboard (⌘C/⌘X/⌘V broker)
  spaceo adopt --pid N                   move an already-running app onto a session
  spaceo windows                         list the session's windows
  spaceo place [--window W] [--placement preserve|fit|cover]
                                         re-apply placement for one window
  spaceo ax [--window W] [--full] [--since SNAPSHOT]
                                         indexed accessibility tree; --since returns the diff
  spaceo targets [--window W]            list Chromium page targets and current binding
  spaceo attach-target ID [--window W]   bind web actions to one Chromium page
  spaceo click (--element N | --element wN | --x X --y Y)
               [--button left|right|middle] [--count 2] [--modifiers cmd,shift]
                                         N = accessibility index, wN = page element
  spaceo move (--element N | --x X --y Y)   hover without pressing, to reveal hover-only UI
  spaceo drag (--from-element N | --x X --y Y) (--to-element N | --to-x X --to-y Y) [--button B]
  spaceo scroll (--element N | --x X --y Y) [--dy -600] [--dx 0] [--ticks 3]
                                         positive --dy scrolls content up,
                                         positive --dx scrolls it left
  spaceo select --x X --y Y --anchor-line L --anchor-character C
                --active-line L --active-character C
                                         select editor text by line and character
  spaceo type "text" [--web] [--replace] [--submit]
                                         --replace verifies native field replacement; --submit adds Return
  spaceo key cmd+s [--web] [--hold-ms 500] [--action tap|down|up]
  spaceo screenshot [-o out.png] [--window W] [--full] [--scale 1|2|3|4] [--annotate]
                    [--x X --y Y --width W --height H]
                                         coordinates are window-local points at scale 1
                                         capture/processing budget 15s; file PNG limit 64 MiB
                                         scaled framebuffer limit 64 Mi pixels
  spaceo verify                          audit the session's isolation
  spaceo repark                          pull escaped windows back

  spaceo demo [--app TextEdit] [--keep] [--no-capture] [--sessions N]
                                         self-contained end-to-end proof, no daemon needed

Controller create: --controller-id ID   --controller-label LABEL
                   --controller-kind cli|mcp|viewer|other   --controller-ttl 30...3600
Session mutations and session-scoped reads (windows, ax, screenshot, verify): --lease UUID
Cross-controller commands (daemon stop, destroy --all, pool set): --operator
Global: --session ID   --lease UUID   --socket PATH   --json   (may also precede the command)
        --json prints exactly one JSON object on stdout; progress goes to stderr
Env:    SPACEO_SESSION  SPACEO_LEASE   defaults for --session / --lease (flags win)
        SPACEO_SOCKET   SPACEO_SESSIONS_PER_DISPLAY   SPACEO_DISPLAY_SIZE (WxH)
Exit:   0 ok   1 failed   2 usage error   3 daemon unavailable or outdated
        4 lease or ownership   5 isolation not verified or breached   6 wait condition not met
Help:   spaceo help <command>  or  spaceo <command> --help
"""

// MARK: - Dispatch

/// File-scope so the atexit handler (a C function pointer, which cannot capture) can reach it.
var daemonServer: Transport.Server?
/// Signal sources must remain strongly retained for the daemon's whole optimized lifetime.
/// A local whose last use precedes `RunLoop.run()` is released by production builds.
var daemonShutdownSources: [DispatchSourceSignal] = []

/// Bind the daemon socket before touching durable state, then install the manager. This preserves
/// the socket's single-writer contract when two MCP clients race to auto-start a daemon.
final class DaemonManagerHolder: @unchecked Sendable {
    private let lock = NSLock()
    private var manager: SessionManager?

    func install(_ manager: SessionManager) {
        lock.withLock { self.manager = manager }
    }

    func handle(_ request: Request) async -> Response {
        guard let manager = lock.withLock({ manager }) else {
            return .failure(
                Transport.TransportError.socketFailed(
                    "the daemon is still fencing durable session state"))
        }
        return await manager.handle(request)
    }

    func isDraining() async -> Bool {
        guard let manager = lock.withLock({ manager }) else { return false }
        return await manager.isDrainingNow
    }

    func coveredSessions(for request: Request) async -> Set<String> {
        guard let manager = lock.withLock({ manager }) else { return [] }
        return await manager.coveredSessionIDs(for: request)
    }
}

// Global flags may precede the command (`spaceo --json session list`); move them after it so
// one parser and one allowlist see every invocation.
let argv = CLIGlobalFlags.normalize(Array(CommandLine.arguments.dropFirst()))
guard let command = argv.first else { print(usage); exit(0) }
if command == "--help" || command == "-h" { print(usage); exit(0) }
let args = CLIArguments(Array(argv.dropFirst()))

// `spaceo help click` and `spaceo click --help` are the same text: that command's usage block,
// one line per flag, and examples — never the whole usage followed by an options list.
if command == "help" || args.bool("help") || args.bool("h") {
    // `spaceo help --help` is help about help; any other option on `help` is a mistake.
    if command == "help", !args.bool("help"), !args.bool("h") {
        let unexpected = args.suppliedNames.subtracting(CLISpec.allowedFlags["help"] ?? [])
        guard unexpected.isEmpty else {
            fail("unknown option(s): " + unexpected.sorted().map { "--\($0)" }.joined(separator: ", "))
        }
    }
    let target = command == "help" ? args.positional : [command] + args.positional
    guard let first = target.first else { print(usage); exit(0) }
    let key = CLIHelp.key(command: first, positional: Array(target.dropFirst()))
    guard let text = CLIHelp.render(key: key, usage: usage) else {
        let suggestions = CLIHelp.suggestions(for: first)
        fail("no command named '\(first)'"
            + (suggestions.isEmpty ? "" : "; did you mean " + suggestions.map { "`\($0)`" }.joined(separator: " or ") + "?"),
            next: "spaceo help")
    }
    print(text)
    exit(0)
}

func stringArgument(_ name: String, _ alt: String? = nil) -> String? {
    if let value = args.string(name, alt) { return value }
    if args.wasSupplied(name) || alt.map(args.wasSupplied) == true {
        fail("--\(name) needs a value")
    }
    // Flags win; `SPACEO_SESSION` / `SPACEO_LEASE` fill in only what was not passed.
    return CLIEnvironment.defaultValue(flag: name, command: currentCommandKey,
                                       environment: ProcessInfo.processInfo.environment)
}

func intArgument(_ name: String) -> Int? {
    guard let raw = stringArgument(name) else { return nil }
    guard let value = Int(raw) else { fail("--\(name) must be an integer") }
    return value
}

func uint64Argument(_ name: String) -> UInt64? {
    guard let raw = stringArgument(name) else { return nil }
    guard let value = UInt64(raw) else {
        fail("--\(name) must be an integer between 0 and \(UInt64.max)")
    }
    return value
}

func doubleArgument(_ name: String) -> Double? {
    guard let raw = stringArgument(name) else { return nil }
    guard let value = Double(raw), value.isFinite else {
        fail("--\(name) must be a finite number")
    }
    return value
}

/// `command` keys into `CLISpec.allowedFlags` — `"type"`, `"session.destroy"` — so the flags a
/// command accepts and how each one parses stay in one table.
func validateFlags(_ command: String) {
    currentCommandKey = command
    guard let allowed = CLISpec.allowedFlags[command] else {
        fail("internal error: no flag spec for '\(command)'", exit: .failure)
    }
    let unexpected = args.suppliedNames.subtracting(allowed)
    guard unexpected.isEmpty else {
        fail("unknown option(s): "
             + unexpected.sorted().map { "--\($0)" }.joined(separator: ", "))
    }
    guard args.malformedBooleanValues.isEmpty else {
        fail(args.malformedBooleanValues.sorted()
            .map { "--\($0) is a switch: pass it bare, or as --\($0)=true / --\($0)=false" }
            .joined(separator: "\n"))
    }
    // Two spellings of one flag used to drop one silently; say which to keep instead.
    if let (first, second) = args.conflictingAliases.first {
        fail("--\(first) and --\(second) are the same option; pass only one")
    }
}

let socketPath = Wire.socketPath(stringArgument("socket"))
// The daemon log attributes each request to the surface that sent it.
Transport.setClientLabel(command == "mcp" ? "mcp" : "cli")

func remote(_ build: (inout Request) -> Void) -> Never {
    var request = Request(cmd: "")
    build(&request)
    request.strictIsolation = args.bool("strict") ? true : nil
    if let raw = stringArgument("require-isolation") {
        let names = raw.split(separator: ",").map(String.init)
        guard !names.isEmpty, names.count <= IsolationDimension.allCases.count else { fail("require-isolation needs 1 through \(IsolationDimension.allCases.count) dimensions") }
        request.requiredIsolation = names.map { name in
            guard let value = IsolationDimension(rawValue: name) else {
                fail("unknown isolation dimension; use " + IsolationDimension.allCases.map(\.rawValue).joined(separator: ","))
            }
            return value
        }
    }
    request.requireWindow = args.bool("require-window") ? true : nil
    request.allowNoWindows = args.bool("allow-no-windows") ? true : nil
    request.memory = args.bool("memory") ? true : nil
    request.timeout = doubleArgument("timeout")
    request.duration = doubleArgument("duration")
    request.snapshotID = stringArgument("snapshot")
    request.label = stringArgument("label")
    request.match = stringArgument("match")
    if request.role == nil { request.role = stringArgument("role") }
    request.geometryToken = stringArgument("geometry")
    request.placement = stringArgument("placement")
    if let raw = stringArgument("arguments-json") {
        guard let decoded = try? JSONDecoder().decode([String].self, from: Data(raw.utf8)) else {
            fail("--arguments-json must be a JSON array of strings")
        }
        request.arguments = decoded
    }
    if request.cmd == "daemon.stop", !Transport.isListening(socketPath) {
        // Stopping what is not running is already done; scripts that stop-then-start should not
        // have to special-case a clean host.
        emit(.success("no daemon was running at \(socketPath); already stopped"), json: args.hasJSON)
    }
    if request.cmd == "clean", request.dryRun == true, Transport.pingResponse(socketPath) == nil,
       !Transport.isListening(socketPath) {
        emit(offlineCleanDryRun(), json: args.hasJSON)
    }
    do {
        var oldProcess: ProcessIdentity?
        if request.cmd == "daemon.stop" {
            let status = try Transport.send(Request(cmd: "ping"), to: socketPath, timeout: 2)
            oldProcess = status.daemon.flatMap { ProcessIdentity.current(of: $0.pid) }
        }
        var response = try Transport.send(request, to: socketPath, timeout: 120)
        if request.cmd == "daemon.stop", response.ok {
            let timeout = request.timeout ?? 30
            guard timeout.isFinite, (0.5...120).contains(timeout) else { fail("timeout must be from 0.5 through 120 seconds") }
            let deadline = Date().addingTimeInterval(timeout)
            while oldProcess?.isAlive == true && Date() < deadline { usleep(50_000) }
            guard oldProcess?.isAlive != true else {
                fail("shutdown acknowledged but old daemon has not exited before timeout",
                     exit: .daemonUnavailable, code: "daemon_stopping", next: "spaceo daemon status")
            }
            if oldProcess != nil { response.message = "SpaceO daemon shutdown completed" }
            emit(response, json: args.hasJSON)
        }
        // A daemon of another version: say so once, and turn its `unknown command` into the
        // restart it actually needs instead of something that reads like a typo.
        response = DaemonVersionDrift.rewritingOutdated(response, cliCommand: currentCommandKey)
        var notices: [String] = []
        if let drift = DaemonVersionDrift.warning(daemon: response.daemon) {
            if args.hasJSON {
                response.warnings = (response.warnings ?? []) + [drift]
            } else {
                notices.append(drift)
            }
        }
        emit(response, json: args.hasJSON, notices: notices)
    } catch {
        var failure = Response.failure(error)
        if let transport = error as? Transport.TransportError {
            switch transport {
            case .notRunning, .busy:
                break
            default:
                // Connected (or tried to) but got no usable answer: the daemon, not the request.
                failure.errorCode = "daemon_unresponsive"
                failure.nextAction = "spaceo doctor"
            }
        }
        emit(failure, json: args.hasJSON)
    }
}

/// `clean --dry-run` with no daemon: the same offline scan doctor uses, so the question "what
/// would clean remove" has an answer on a host where nothing is running.
func offlineCleanDryRun() -> Response {
    let candidates = offlineOrphanProfileDirectories().map { URL(fileURLWithPath: $0, isDirectory: true) }
    let report = DiskHygiene.clean(candidates: candidates, dryRun: true)
    var response = Response.success(DiskHygiene.summaryLine(report)
        + " (no daemon running; scanned offline)")
    response.reclaimedBytes = report.reclaimedBytes
    response.removedPaths = report.removedPaths
    return response
}

/// Temporary browser profiles and control roots SpaceO created that no durable session record
/// references. Read-only.
func offlineOrphanProfileDirectories() -> [String] {
    let temporaryRoots = Set([FileManager.default.temporaryDirectory.path, "/tmp"])
        .map { URL(fileURLWithPath: $0, isDirectory: true) }
    var referenced = Set<String>()
    if let ledger = try? SessionStore(socketPath: socketPath).load() {
        for record in ledger.sessions {
            for app in record.apps {
                if let profile = app.temporaryProfile { referenced.insert(profile.path) }
                if let root = app.temporaryControlRoot { referenced.insert(root.path) }
            }
        }
    }
    return temporaryRoots.flatMap {
        (try? DiskHygiene.orphanCandidates(in: $0, referenced: referenced, now: Date())) ?? []
    }.map(\.path).sorted()
}

func int32Argument(_ name: String) -> Int32? {
    guard let raw = intArgument(name) else { return nil }
    guard let value = Int32(exactly: raw) else {
        fail("--\(name) must be an integer from \(Int32.min) through \(Int32.max)")
    }
    return value
}

/// `--modifiers cmd,shift`. Comma-separated so one flag carries the whole held set, which is
/// what a modifier-held click actually is.
func modifiersArgument() -> [String]? {
    guard let raw = stringArgument("modifiers") else { return nil }
    let names = raw.split(separator: ",")
        .map { $0.trimmingCharacters(in: .whitespaces) }
        .filter { !$0.isEmpty }
    guard !names.isEmpty else { fail("--modifiers needs at least one modifier name") }
    return names
}

func windowArgument() -> UInt32? {
    guard let raw = intArgument("window") else { return nil }
    guard raw > 0, let value = UInt32(exactly: raw) else {
        fail("--window must be an integer from 1 through \(UInt32.max)")
    }
    return value
}

func pidArgument() -> Int32? {
    guard let raw = intArgument("pid") else { return nil }
    guard raw > 0, let value = Int32(exactly: raw) else {
        fail("--pid must be an integer from 1 through \(Int32.max)")
    }
    return value
}

func leaseArgument(required: Bool = false) -> UUID? {
    guard let raw = stringArgument("lease") else {
        if required {
            fail("--lease UUID is required. Use the credential returned by session create "
                + "or the most recent session heartbeat.")
        }
        return nil
    }
    guard let lease = UUID(uuidString: raw) else {
        fail(args.wasSupplied("lease")
            ? "--lease must be a UUID returned by session create or session heartbeat"
            : "\(CLIEnvironment.leaseVariable) must be a UUID returned by session create or session heartbeat")
    }
    return lease
}

/// `--orphan-grace`: how long an abandoned session keeps its apps waiting for `session claim`.
func orphanGraceArgument() -> Double? {
    secondsArgument("orphan-grace", within: SessionReclamationPolicy.orphanGraceRange)
}

func controllerTTLArgument() -> Double? {
    secondsArgument("controller-ttl", within: SessionReclamationPolicy.clientTTLRange)
}

func secondsArgument(_ name: String, within range: ClosedRange<Double>) -> Double? {
    let value = doubleArgument(name)
    if let value, !range.contains(value) {
        fail("--\(name) must be from \(Int(range.lowerBound)) through \(Int(range.upperBound)) seconds")
    }
    return value
}

func controllerOwnerArgument() -> DurableSessionOwner {
    let id = stringArgument("controller-id")
        ?? "cli-\(getpid())-\(UUID().uuidString.lowercased())"
    let label = stringArgument("controller-label") ?? "spaceo CLI"
    let kind: DurableSessionOwnerKind
    if let rawKind = stringArgument("controller-kind") {
        guard let parsed = DurableSessionOwnerKind(rawValue: rawKind) else {
            fail("--controller-kind must be cli, mcp, viewer, or other")
        }
        kind = parsed
    } else {
        kind = .cli
    }

    func validate(_ value: String, flag: String) {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard value == trimmed,
              !trimmed.isEmpty,
              value.utf8.count <= 256,
              value.unicodeScalars.allSatisfy({
                  !CharacterSet.controlCharacters.contains($0)
              }) else {
            fail("--\(flag) must be trimmed, non-empty, control-free, "
                + "and at most 256 UTF-8 bytes")
        }
    }
    validate(id, flag: "controller-id")
    validate(label, flag: "controller-label")

    // The CLI is intentionally short-lived. Its PID exiting must not immediately abandon a
    // session that another invocation will continue; the requested TTL is the liveness signal.
    return DurableSessionOwner(
        id: id,
        kind: kind,
        label: label,
        processIdentity: nil
    )
}

// macOS attributes TCC grants to the app that spawned this process, not to the binary; every
// permission error names that app so nobody has to work it out from a terminal name.
SpaceOError.setResponsibleProcessAttribution(ResponsibleProcess.describeCurrent())

switch command {

case "skill":
    validateFlags("skill")
    guard let skill = Playbook.documents.first(where: { $0.name == "SKILL" }) else {
        fail("playbook missing", exit: .failure)
    }
    if args.hasJSON {
        print(CLIJSON.object(["ok": true, "name": skill.name, "markdown": skill.markdown]))
    } else {
        print(skill.markdown)
    }
    exit(0)

case "version", "--version":
    validateFlags("version")
    print(
        args.hasJSON
            ? CLIJSON.object(["ok": true, "version": SpaceOVersion.current])
            : "spaceo \(SpaceOVersion.current)")
    exit(0)

case "schema":
    validateFlags("schema")
    guard args.positional.isEmpty else { fail("schema takes no arguments") }
    print(CLIJSON.object([
        "ok": true, "schemaVersion": 1, "version": SpaceOVersion.current,
        "commands": CLISpec.allowedFlags.mapValues { $0.sorted() },
        "booleanFlags": CLISpec.booleanFlags.sorted(), "valueFlags": CLISpec.valueFlags.sorted(),
        "exitCodes": Dictionary(uniqueKeysWithValues: CLIExitCode.allCases.map { (String($0.rawValue), $0.meaning) }),
    ]))
    exit(0)

case "completions":
    validateFlags("completions")
    guard let shell = args.positional.first, args.positional.count == 1,
          let script = CLICompletions.script(for: shell) else {
        fail("completions needs one shell: " + CLICompletions.shells.joined(separator: ", "))
    }
    print(script, terminator: "")
    exit(0)

case "setup":
    validateFlags("setup")
    runSetup()

case "safety":
    validateFlags("safety")
    if args.positional == ["clean-display-identities"] {
        validateFlags("safety.clean-display-identities")
        guard args.bool("operator") else {
            fail("cleaning ColorSync display identities requires --operator; stop all SpaceO owners first")
        }
        runCleanDisplayIdentities(apply: args.bool("apply"))
    }
    guard args.positional == ["clear-host-health"] else {
        fail("use safety clear-host-health --operator or safety clean-display-identities --operator")
    }
    validateFlags("safety.clear-host-health")
    guard args.bool("operator") else { fail("clearing a host-health latch requires --operator; stop all SpaceO owners first") }
    do {
        let archive = try DisplaySafetyRecovery.clearHostHealthLatch()
        if args.hasJSON { print(CLIJSON.object(["ok": true, "archive": archive])) }
        else { print("cleared host-health latch; creation budgets retained; archive: \(archive)") }
    } catch { fail(error.localizedDescription, exit: .failure, code: (error as? SpaceOError)?.code) }

case "doctor":
    validateFlags("doctor")
    runDoctor()

case "daemon":
    if let sub = args.positional.first, sub != "wait", sub != "stop", sub != "drain",
       sub != "status", sub != "install", sub != "uninstall", sub != "restart" {
        fail("unknown daemon subcommand '\(sub)'; use stop, restart, drain, wait, status, install, or uninstall")
    }
    if args.positional.first == "wait" {
        validateFlags("daemon.wait")
        let timeout = doubleArgument("timeout") ?? 30
        guard (0.5...120).contains(timeout) else { fail("timeout must be from 0.5 through 120 seconds") }
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            if let response = try? Transport.send(Request(cmd: "ping"), to: socketPath, timeout: min(1, max(0.1, deadline.timeIntervalSinceNow))),
               response.ok, response.daemon != nil {
                emit(response, json: args.hasJSON)
            }
            usleep(50_000)
        } while Date() < deadline
        fail("daemon did not become ready before timeout",
             exit: .daemonUnavailable, code: "daemon_not_running",
             next: LaunchAgentInstaller.startNextAction(installed: LaunchAgentInstaller.status().installed))
    }
    if args.positional.first == "stop" {
        validateFlags("daemon.stop")
        let lease = leaseArgument()
        remote { request in
            request.cmd = "daemon.stop"
            request.controllerLeaseID = lease
            request.operatorScope = args.bool("operator") ? true : nil
        }
    }
    if args.positional.first == "drain" {
        validateFlags("daemon.drain")
        remote { request in
            request.cmd = "daemon.drain"
            request.operatorScope = args.bool("operator") ? true : nil
        }
    }
    if args.positional.first == "status" {
        validateFlags("daemon.status")
        let status = LaunchAgentInstaller.status()
        let plist = LaunchAgentInstaller.plistURL()
        if args.hasJSON {
            print(CLIJSON.object([
                "ok": true, "installed": status.installed, "running": status.running,
                "pid": status.pid.map { $0 as Any } ?? NSNull(), "plist": plist.path,
                "label": LaunchAgentInstaller.label,
            ]))
        } else {
            print("LaunchAgent \(LaunchAgentInstaller.label): " + (status.installed ? "installed at \(plist.path)" : "not installed"))
            if status.installed { print("  running: \(status.running ? "yes" + (status.pid.map { " (pid \($0))" } ?? "") : "no")") }
        }
        exit(0)
    }
    if args.positional.first == "install" || args.positional.first == "uninstall" {
        let installing = args.positional.first == "install"
        validateFlags(installing ? "daemon.install" : "daemon.uninstall")
        runLaunchAgentChange(installing: installing)
    }
    if args.positional.first == "restart" {
        validateFlags("daemon.restart")
        runDaemonRestart()
    }
    validateFlags("daemon")

    // The daemon is long-lived and its stdout is usually a log file or the MCP server's
    // startup-diagnostics file, never a terminal. Fully buffered stdout would hold the
    // "listening" line and every recovery notice until exit, so the diagnostics file MCP reads
    // after a failed start would be empty. Line buffering makes each line durable as written.
    setlinebuf(stdout)

    let budget = ResourceBudget.fromEnvironment()
    var displaySize = CGSize(width: 1920, height: 1080)
    var sizeWasPinned = false
    if let raw = stringArgument("display-size")
        ?? ProcessInfo.processInfo.environment["SPACEO_DISPLAY_SIZE"] {
        sizeWasPinned = true
        let parts = raw.lowercased().split(
            separator: "x", omittingEmptySubsequences: false)
        guard parts.count == 2,
              let width = Int(parts[0]),
              let height = Int(parts[1]),
              width > 0, height > 0,
              width <= budget.maximumDisplayEdge, height <= budget.maximumDisplayEdge else {
            fail("--display-size wants WxH in whole pixels up to "
                 + "\(budget.maximumDisplayEdge) per edge, e.g. 2560x1440")
        }
        displaySize = CGSize(width: width, height: height)
    }
    // The env var matters because an MCP client launches `spaceo mcp` with no arguments, and
    // that path auto-starts the daemon — so a flag alone would leave MCP users stuck at 1.
    let perDisplayRaw = stringArgument("sessions-per-display")
        ?? ProcessInfo.processInfo.environment["SPACEO_SESSIONS_PER_DISPLAY"]
    let perDisplay: Int
    if let perDisplayRaw {
        guard let parsed = Int(perDisplayRaw) else {
            fail("sessions per display must be a positive integer")
        }
        perDisplay = parsed
    } else {
        perDisplay = 1
    }

    // If the size was not pinned, grow the canvas to fit the requested density instead of
    // refusing it. A virtual display is not a panel someone has to buy — asking for four agents
    // should give you a bigger one, not an error.
    if !sizeWasPinned, perDisplay > 1 {
        displaySize = TileLayout.displaySize(forCapacity: perDisplay)
    }

    do {
        _ = try budget.validateDisplaySize(displaySize, capacity: perDisplay)
    } catch {
        fail("\(error.localizedDescription)")
    }

    let pool = DisplayPool(sessionsPerDisplay: 1, displaySize: displaySize, budget: budget)
    do { try pool.setSessionsPerDisplay(perDisplay) } catch { fail("\(error)") }

    // Failures observed by a client die with that client; the daemon's log is the durable
    // record. Opening it is best-effort — a read-only home directory must not stop sessions.
    do {
        try DaemonLog.shared.configure(fileURL: DaemonLog.defaultLogURL())
        DaemonLog.shared.follow(LoggingSettingsMonitor())
    } catch {
        FileHandle.standardError.write(Data(
            "warning: daemon log unavailable at \(DaemonLog.defaultLogURL().path): \(error)\n"
                .utf8))
    }

    let daemonInstanceID = UUID()
    let daemonCapabilities = Capabilities()
    let daemonAttribution = ResponsibleProcess.describeCurrent()
    let daemonSupervised = LaunchAgentInstaller.status().installed
        || ProcessInfo.processInfo.environment["XPC_SERVICE_NAME"]?.contains(LaunchAgentInstaller.label) == true
    let daemonRuntime = DaemonRuntimeInfo(
        version: SpaceOVersion.current,
        executableSHA256: RuntimeIdentity.currentExecutableSHA256(),
        executableBuildUUID: RuntimeIdentity.currentExecutableBuildUUID(),
        pid: ProcessInfo.processInfo.processIdentifier,
        instanceID: daemonInstanceID,
        startedAt: Date(),
        accessibilityGranted: AXIsProcessTrusted(),
        screenRecordingGranted: CGPreflightScreenCaptureAccess(),
        canDrive: daemonCapabilities.canDrive,
        canCapture: daemonCapabilities.canCapture,
        responsibleProcess: daemonAttribution,
        draining: false,
        supervisedByLaunchd: daemonSupervised)
    let holder = DaemonManagerHolder()
    let server = Transport.Server(path: socketPath) { request in
        let trace = PerformanceTrace.signposter.beginInterval("Daemon.Request", id: PerformanceTrace.signposter.makeSignpostID())
        defer { PerformanceTrace.signposter.endInterval("Daemon.Request", trace) }
        let started = ContinuousClock.now
        let metricsStarted = DaemonLog.shared.isConfigured ? ProcessMetricsSnapshot.capture() : nil
        var response = await holder.handle(request)
        var runtime = daemonRuntime
        runtime.draining = await holder.isDraining()
        runtime.displaySafety = Stage.runtimeDisplaySafetyStatus()
        runtime.hostHealth = Stage.runtimeHostHealthReport()
        response.daemon = runtime
        let elapsed = started.duration(to: .now).components
        DaemonLog.shared.record(
            request: request,
            response: response,
            seconds: Double(elapsed.seconds) + Double(elapsed.attoseconds) / 1e18,
            metricsStarted: metricsStarted)
        if request.cmd == "daemon.stop", response.ok {
            // Give the socket response a moment to flush before ending the process.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
                daemonServer?.stop()
                exit(0)
            }
        }
        return response
    }
    // Event stream (SPAO-214): one long-lived connection per subscriber, replay from `sinceSeq`,
    // redacted to the subscriber's lease/owner scope exactly like `session.list`.
    server.streamHandler = { request, write in
        let covered = await holder.coveredSessions(for: request)
        let operatorScope = request.operatorScope == true
        let redactor: @Sendable (DaemonEvent) -> DaemonEvent? = { event in
            if let wanted = request.session, event.session != nil, event.session != wanted { return nil }
            return EventBus.redacting(event, coveredSessions: covered, operatorScope: operatorScope)
        }
        let delivery = EventStreamDelivery(bus: .shared, since: request.sinceSeq ?? 0,
                                           redactor: redactor, write: write)
        await delivery.waitUntilClosed()
    }
    do { try server.start() } catch { fail("\(error)", exit: .failure) }
    daemonServer = server

    var manager: SessionManager
    var recoveryStartup: SessionRecoveryStartupResult
    do {
        let store = try SessionStore(socketPath: socketPath)
        let recovery = try DetachedSessionRecovery.live(
            daemonInstanceID: daemonInstanceID)
        let coordinator = SessionRecoveryCoordinator(
            store: store,
            recovery: recovery)
        recoveryStartup = try coordinator.startup()
        manager = try SessionManager(
            pool: pool,
            sessionStore: store,
            recoveryCoordinator: coordinator,
            daemonInstanceID: daemonInstanceID)
        holder.install(manager)
    } catch let SessionStoreError.unsupportedSchema(found, supported) {
        // A newer ledger must not stop this daemon from serving; quarantine it with a note and
        // start empty (SPAO-153). The operator can inspect the quarantined file later.
        if let store = try? SessionStore(socketPath: socketPath),
           let moved = try? DiskHygiene.quarantineUnsupportedLedger(
               at: store.ledgerURL, rootDirectory: store.rootDirectory,
               reason: "schema \(found) is newer than this daemon supports (\(supported))") {
            print("quarantined unsupported session ledger to \(moved.path); starting with no durable sessions")
            DaemonLog.shared.event("ledger.quarantined", ["path": moved.path, "schema": String(found)])
            do {
                let store = try SessionStore(socketPath: socketPath)
                let recovery = try DetachedSessionRecovery.live(daemonInstanceID: daemonInstanceID)
                let coordinator = SessionRecoveryCoordinator(store: store, recovery: recovery)
                recoveryStartup = try coordinator.startup()
                manager = try SessionManager(pool: pool, sessionStore: store, recoveryCoordinator: coordinator, daemonInstanceID: daemonInstanceID)
                holder.install(manager)
            } catch {
                server.stop(); daemonServer = nil
                fail("could not start after quarantining the ledger: \(error.localizedDescription)", exit: .failure)
            }
        } else {
            server.stop(); daemonServer = nil
            fail("session ledger schema \(found) is unsupported (this daemon supports \(supported)) and could not be quarantined", exit: .failure)
        }
    } catch {
        server.stop()
        daemonServer = nil
        fail("could not recover durable session state: \(error.localizedDescription)", exit: .failure)
    }
    // No top-level `await` here: it would turn main.swift into async top-level code and the
    // run loop below would no longer keep the daemon alive. Actor calls go through Tasks.
    let installedManager = manager
    Task {
        await installedManager.setDrainCompletionHandler {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
                daemonServer?.stop()
                exit(0)
            }
        }
        // Wake and display reconfiguration revalidate every session's display (public API
        // observation only; callbacks arrive on the main run loop started below).
        await installedManager.startDisplayEnvironmentObservation()
        // Agent applications that activate themselves are sent back to the person (#53).
        await installedManager.startActivationGuard()
    }
    // Startup hygiene (SPAO-153): one summary line; profiles referenced by live or detached
    // records are never touched, and nothing younger than a day is.
    Task {
        var clean = Request(cmd: "clean")
        clean.operatorScope = true
        let report = await installedManager.handle(clean)
        if let message = report.message, report.reclaimedBytes ?? 0 > 0 { print("  startup cleanup: \(message)") }
    }

    print("spaceo daemon listening on \(socketPath)")
    print("  \(perDisplay) session(s) per \(Int(displaySize.width))x\(Int(displaySize.height)) display")
    print("  grants attribute to: \(daemonAttribution ?? "unknown")" + (daemonSupervised ? " (supervised by launchd)" : ""))
    if !recoveryStartup.ledger.sessions.isEmpty {
        print("  fenced \(recoveryStartup.ledger.sessions.count) detached session record(s)")
    }
    for blocked in recoveryStartup.blockedRecords {
        let reasons = blocked.blockers.map(\.message).joined(separator: "; ")
        print("  recovery pending for '\(blocked.sessionID)': \(reasons)")
    }
    DaemonLog.shared.event("daemon.started", [
        "version": SpaceOVersion.current,
        "pid": String(ProcessInfo.processInfo.processIdentifier),
        "socket": socketPath,
        "sessionsPerDisplay": String(perDisplay),
        "displaySize": "\(Int(displaySize.width))x\(Int(displaySize.height))",
        "fencedDetachedRecords": String(recoveryStartup.ledger.sessions.count),
        "executableSHA256": daemonRuntime.executableSHA256 ?? "unknown",
        "executableBuildUUID": daemonRuntime.executableBuildUUID ?? "unknown",
        "instanceID": daemonRuntime.instanceID.uuidString,
    ])
    for blocked in recoveryStartup.blockedRecords {
        DaemonLog.shared.event("recovery.blocked", [
            "session": blocked.sessionID,
            "reasons": blocked.blockers.map(\.message).joined(separator: "; "),
        ])
    }
    print("(ctrl-c to stop; sessions are destroyed and their apps quit on the way out)")

    // Shut down through Dispatch, not a bare signal handler.
    //
    // Virtual displays die with the process for free, but the *apps* a session started do not:
    // a plain exit(0) leaves an invisible browser or editor running forever. So the handler has
    // to actually destroy the sessions, which means running async work — something a C signal
    // handler cannot do, but a DispatchSourceSignal can.
    signal(SIGINT, SIG_IGN)
    signal(SIGTERM, SIG_IGN)
    daemonShutdownSources = [SIGINT, SIGTERM].map { number -> DispatchSourceSignal in
        let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
        source.setEventHandler {
            Task {
                // A delivered signal is the operator speaking; it must not be refused
                // because agents' sessions are still alive.
                DaemonLog.shared.event("daemon.signal", ["signal": String(number)])
                var stop = Request(cmd: "daemon.stop")
                stop.operatorScope = true
                // Nor may it be refused because a previous daemon's detached records are still
                // inside their recovery grace: a signal cannot wait, the records are durable,
                // and the next daemon recovers them. Ignoring SIGTERM only invites SIGKILL,
                // which would turn this daemon's live sessions into more detached records.
                stop.leaveDetachedRecords = true
                let response = await manager.handle(stop)
                guard response.ok else {
                    let recovery = response.teardown?.recoveryDescription
                        ?? response.error
                        ?? "daemon teardown failed; retry `spaceo daemon stop`"
                    DaemonLog.shared.event("daemon.signal-stop-failed", ["error": recovery])
                    FileHandle.standardError.write(
                        Data(("error: " + recovery + "\n").utf8))
                    return
                }
                DaemonLog.shared.event("daemon.stopped", [
                    "via": "signal \(number)",
                    "message": response.message ?? "",
                ])
                if let message = response.message, message.contains("detached") {
                    FileHandle.standardError.write(Data((message + "\n").utf8))
                }
                daemonServer?.stop()
                exit(0)
            }
        }
        source.resume()
        return source
    }
    atexit { daemonServer?.stop() }

    // Dispatch signal sources above are delivered on the main queue.
    RunLoop.main.run()

case "session":
    guard let sub = args.positional.first else {
        fail("session needs: create | list | heartbeat | claim | pause | resume | destroy | annotate")
    }
    switch sub {
    case "create":
        validateFlags("session.create")
        let owner = controllerOwnerArgument()
        let ttl = controllerTTLArgument()
        let requestedLease = leaseArgument()
        let orphanGrace = orphanGraceArgument()
        if args.bool("export") {
            guard !args.hasJSON else { fail("--export prints shell text; it cannot be combined with --json") }
            exportRequested = true
        }
        remote { request in
            request.cmd = "session.create"
            request.session = stringArgument("session", "name")
            request.controllerOwner = owner
            request.controllerTTLSeconds = ttl
            request.orphanGraceSeconds = orphanGrace
            request.controllerLeaseID = requestedLease
            request.app = stringArgument("app")
            request.preset = stringArgument("preset")
            request.title = stringArgument("title")
            request.record = stringArgument("record")
            request.muteAudio = args.bool("mute-audio") ? true : nil
        }
    case "annotate":
        validateFlags("session.annotate")
        guard args.wasSupplied("title") || args.wasSupplied("color") else { fail("session annotate needs --title and/or --color") }
        remote { request in
            request.cmd = "session.annotate"
            request.session = stringArgument("session")
            request.controllerLeaseID = leaseArgument()
            request.operatorScope = args.bool("operator") ? true : nil
            request.title = stringArgument("title")
            request.colorTag = stringArgument("color")
        }
    case "list":
        validateFlags("session.list")
        let lease = leaseArgument()
        remote { request in
            request.cmd = "session.list"
            request.controllerLeaseID = lease
            request.operatorScope = args.bool("operator") ? true : nil
        }
    case "claim":
        // Leases coordinate clients; they are not a security boundary. Claim works only for an
        // abandoned session, and hands the caller a fresh lease for it.
        validateFlags("session.claim")
        guard let sessionID = stringArgument("session") else {
            fail("session claim needs --session ID; it never picks a session for you")
        }
        let owner = controllerOwnerArgument()
        let ttl = controllerTTLArgument()
        let orphanGrace = orphanGraceArgument()
        remote { request in
            request.cmd = "session.claim"
            request.session = sessionID
            request.controllerOwner = owner
            request.controllerTTLSeconds = ttl
            request.orphanGraceSeconds = orphanGrace
        }
    case "heartbeat":
        validateFlags("session.heartbeat")
        let lease = leaseArgument(required: true)
        remote { request in
            request.cmd = "session.heartbeat"
            request.session = stringArgument("session")
            request.controllerLeaseID = lease
        }
    case "pause", "resume":
        validateFlags("session.\(sub)")
        remote { request in
            request.cmd = "session.control"
            request.session = stringArgument("session")
            request.paused = sub == "pause"
            request.controllerLeaseID = leaseArgument()
            request.operatorScope = args.bool("operator") ? true : nil
            request.reason = sub == "pause" ? stringArgument("reason") : nil
            request.handoffNote = sub == "resume" ? stringArgument("note") : nil
        }
    case "destroy":
        validateFlags("session.destroy")
        remote { request in
            request.cmd = "session.destroy"
            request.session = stringArgument("session")
            request.full = args.bool("all")
            request.quitApps = !args.bool("keep-apps")
            request.controllerLeaseID = leaseArgument()
            request.operatorScope = args.bool("operator") ? true : nil
        }
    default:
        fail("unknown session subcommand '\(sub)'")
    }

case "pool":
    validateFlags("pool")
    if args.positional.first == "set" {
        guard let value = args.positional.dropFirst().first.flatMap({ Int($0) }) else {
            fail("pool set needs a number, e.g. `spaceo pool set 4`")
        }
        remote { request in
            request.cmd = "pool.configure"
            request.count = value
            request.operatorScope = args.bool("operator") ? true : nil
        }
    }
    if args.positional.first == "trim" {
        remote { request in
            request.cmd = "pool.trim"
            request.operatorScope = args.bool("operator") ? true : nil
        }
    }
    if args.positional.first == "remove" {
        guard let value = args.positional.dropFirst().first.flatMap({ UInt32($0) }) else {
            fail("pool remove needs a display id from `spaceo pool`, e.g. `spaceo pool remove 5 --operator`")
        }
        remote { request in
            request.cmd = "pool.remove"
            request.display = value
            request.operatorScope = args.bool("operator") ? true : nil
        }
    }
    remote { $0.cmd = "pool" }

case "run":
    validateFlags("run")
    guard let app = args.positional.first else { fail("run needs an application name or path") }
    remote { request in
        request.cmd = "run"
        request.session = stringArgument("session")
        request.controllerLeaseID = leaseArgument()
        request.app = app
        request.files = Array(args.positional.dropFirst())
        request.newInstance = args.bool("new-instance") ? true : nil
        request.muteAudio = args.bool("mute-audio") ? true : nil
    }

case "open-url":
    validateFlags("open-url")
    guard let url = args.positional.first else { fail("open-url needs a URL") }
    remote { request in
        request.cmd = "open.url"
        request.session = stringArgument("session")
        request.controllerLeaseID = leaseArgument()
        request.window = windowArgument()
        request.url = url
        request.newTab = args.bool("new-tab") ? true : nil
        request.muteAudio = args.bool("mute-audio") ? true : nil
    }

case "wait":
    validateFlags("wait")
    guard let condition = args.positional.first else {
        fail("wait needs a condition: " + WaitCondition.knownKinds.joined(separator: " | "))
    }
    remote { request in
        request.cmd = "wait"
        request.session = stringArgument("session")
        request.controllerLeaseID = leaseArgument()
        request.window = windowArgument()
        request.waitCondition = condition
        request.waitValue = args.positional.dropFirst().first
    }

case "menu":
    validateFlags("menu")
    remote { request in
        request.cmd = "menu"
        request.session = stringArgument("session")
        request.controllerLeaseID = leaseArgument()
        request.window = windowArgument()
        request.menuPath = args.positional.isEmpty ? nil : args.positional
        request.press = args.bool("press") ? true : nil
        request.pid = pidArgument()
    }

case "find":
    validateFlags("find")
    guard let query = args.positional.first else { fail("find needs a query") }
    remote { request in
        request.cmd = "ax.find"
        request.session = stringArgument("session")
        request.controllerLeaseID = leaseArgument()
        request.window = windowArgument()
        request.query = query
        request.role = stringArgument("role")
    }

case "text":
    validateFlags("text")
    remote { request in
        request.cmd = "ax.text"
        request.session = stringArgument("session")
        request.controllerLeaseID = leaseArgument()
        request.window = windowArgument()
        request.element = stringArgument("element")
        request.maxChars = intArgument("max-chars")
        request.web = args.bool("web") ? true : nil
    }

case "steps":
    validateFlags("steps")
    guard let raw = stringArgument("steps-json") else { fail("steps needs --steps-json '[{\"cmd\":\"click\",\"element\":\"3\"}, …]'") }
    guard let steps = try? Wire.decoder.decode([Request].self, from: Data(raw.utf8)) else {
        fail("--steps-json must be a JSON array of request objects, each with a cmd")
    }
    remote { request in
        request.cmd = "steps.run"
        request.session = stringArgument("session")
        request.controllerLeaseID = leaseArgument()
        request.steps = steps
        request.stopOnFailure = args.bool("continue-on-failure") ? false : nil
    }

case "clipboard":
    guard let sub = args.positional.first, sub == "get" || sub == "set" else { fail("clipboard needs: get | set <text>") }
    validateFlags("clipboard.\(sub)")
    remote { request in
        request.cmd = "clipboard.\(sub)"
        request.session = stringArgument("session")
        request.controllerLeaseID = leaseArgument()
        request.operatorScope = args.bool("operator") ? true : nil
        if sub == "set" {
            guard let text = args.positional.dropFirst().first else { fail("clipboard set needs the text") }
            request.text = text
        }
    }

case "clean":
    validateFlags("clean")
    remote { request in
        request.cmd = "clean"
        request.operatorScope = args.bool("operator") ? true : nil
        request.controllerLeaseID = leaseArgument()
        request.dryRun = args.bool("dry-run") ? true : nil
    }

case "events":
    validateFlags("events")
    let since = uint64Argument("since-seq") ?? 0
    if args.bool("follow") {
        var request = Request(cmd: "events.subscribe")
        request.sinceSeq = since
        request.session = stringArgument("session")
        request.controllerLeaseID = leaseArgument()
        request.operatorScope = args.bool("operator") ? true : nil
        let done = DispatchSemaphore(value: 0)
        let subscription = Transport.subscribe(to: socketPath, sinceSeq: since, request: request, onResponse: { response in
            guard response.ok else {
                FileHandle.standardError.write(Data(("error: " + (response.error ?? "stream failed") + "\n").utf8))
                exit(max(1, CLIExitCode.classify(response, command: "events").rawValue))
            }
            // `--follow --json` is the one streaming exception to one-object-per-invocation:
            // one sorted JSON object per line (NDJSON), each an event or a gap notice.
            for event in response.events ?? [] {
                if args.hasJSON, let data = try? CLIJSON.encoder.encode(event) {
                    print(String(decoding: data, as: UTF8.self))
                } else {
                    var line = "\(event.seq)  \(event.at.ISO8601Format())  \(event.kind)"
                    if let sessionID = event.session { line += "  \(sessionID)" }
                    if event.redacted == true { line += "  [redacted]" }
                    else if !event.detail.isEmpty { line += "  " + event.detail.keys.sorted().map { "\($0)=\(event.detail[$0] ?? "")" }.joined(separator: " ") }
                    print(line)
                }
                fflush(stdout)
            }
            if response.resyncRequired == true {
                if args.hasJSON, let data = try? CLIJSON.encoder.encode(response) {
                    print(String(decoding: data, as: UTF8.self))
                } else {
                    print("(gap: events were dropped; run `spaceo session list` to resync)")
                }
                fflush(stdout)
            }
        }, onClose: { error in
            if let error {
                FileHandle.standardError.write(Data(("stream closed: \(error)\n").utf8))
                exit(CLIExitCode.daemonUnavailable.rawValue)
            }
            done.signal()
        })
        signal(SIGINT) { _ in exit(0) }
        _ = subscription
        done.wait()
        exit(0)
    }
    remote { request in
        request.cmd = "events.poll"
        request.sinceSeq = since
        request.session = stringArgument("session")
        request.controllerLeaseID = leaseArgument()
        request.operatorScope = args.bool("operator") ? true : nil
    }

case "report":
    validateFlags("report")
    guard let directory = args.positional.first else { fail("report needs a recording directory (see `spaceo session create --record`)") }
    do {
        let html = try SessionReport.render(directory: URL(fileURLWithPath: directory, isDirectory: true))
        if let output = stringArgument("output", "o") {
            try html.write(to: URL(fileURLWithPath: output), atomically: true, encoding: .utf8)
            print(args.hasJSON ? CLIJSON.object(["ok": true, "output": output]) : "wrote \(output)")
        } else {
            print(args.hasJSON ? CLIJSON.object(["ok": true, "html": html]) : html)
        }
        exit(0)
    } catch {
        fail(error.localizedDescription, exit: .failure)
    }

case "adopt":
    validateFlags("adopt")
    guard let pid = pidArgument() else { fail("adopt needs --pid N") }
    remote { request in
        request.cmd = "adopt"
        request.session = stringArgument("session")
        request.controllerLeaseID = leaseArgument()
        request.pid = pid
    }

case "place":
    validateFlags("place")
    remote {
        $0.cmd = "place"
        $0.session = stringArgument("session")
        $0.controllerLeaseID = leaseArgument()
        $0.window = windowArgument()
    }

case "windows":
    validateFlags("windows")
    remote { request in
        request.cmd = "windows"
        request.pid = pidArgument()
        request.session = stringArgument("session")
        request.controllerLeaseID = leaseArgument()
    }

case "ax":
    validateFlags("ax")
    remote { request in
            request.cmd = "ax"
            request.session = stringArgument("session")
            request.controllerLeaseID = leaseArgument()
            request.window = windowArgument()
        request.full = args.bool("full")
        request.since = stringArgument("since")
    }

case "targets":
    validateFlags("targets")
    remote { request in
        request.cmd = "targets"
        request.session = stringArgument("session")
        request.controllerLeaseID = leaseArgument()
        request.window = windowArgument()
    }

case "attach-target":
    validateFlags("attach-target")
    let target = args.positional.first ?? stringArgument("target")
    guard let target, !target.isEmpty else { fail("attach-target needs a target id") }
    remote { request in
        request.cmd = "target.attach"
        request.session = stringArgument("session")
        request.controllerLeaseID = leaseArgument()
        request.window = windowArgument()
        request.target = target
    }

case "click":
    validateFlags("click")
    remote { request in
            request.cmd = "click"
            request.session = stringArgument("session")
            request.controllerLeaseID = leaseArgument()
            request.window = windowArgument()
        request.element = stringArgument("element")
        request.web = args.bool("web") ? true : nil
        request.x = doubleArgument("x")
        request.y = doubleArgument("y")
        request.button = stringArgument("button")
        request.count = intArgument("count")
        request.modifiers = modifiersArgument()
    }

case "scroll":
    validateFlags("scroll")
    remote { request in
        request.cmd = "scroll"
        request.session = stringArgument("session")
        request.controllerLeaseID = leaseArgument()
        request.window = windowArgument()
        request.element = stringArgument("element")
        request.x = doubleArgument("x")
        request.y = doubleArgument("y")
        request.dx = int32Argument("dx")
        request.dy = int32Argument("dy")
        request.ticks = intArgument("ticks")
        request.modifiers = modifiersArgument()
        request.web = args.bool("web") ? true : nil
    }

case "select":
    validateFlags("select")
    remote { request in
        request.cmd = "select"
        request.session = stringArgument("session")
        request.controllerLeaseID = leaseArgument()
        request.window = windowArgument()
        request.x = doubleArgument("x")
        request.y = doubleArgument("y")
        request.anchorLine = intArgument("anchor-line")
        request.anchorCharacter = intArgument("anchor-character")
        request.activeLine = intArgument("active-line")
        request.activeCharacter = intArgument("active-character")
    }

case "move":
    validateFlags("move")
    remote { request in
        request.cmd = "move"
        request.session = stringArgument("session")
        request.controllerLeaseID = leaseArgument()
        request.window = windowArgument()
        request.element = stringArgument("element")
        request.x = doubleArgument("x")
        request.y = doubleArgument("y")
        request.modifiers = modifiersArgument()
        request.web = args.bool("web") ? true : nil
    }

case "drag":
    validateFlags("drag")
    remote { request in
        request.cmd = "drag"
        request.session = stringArgument("session")
        request.controllerLeaseID = leaseArgument()
        request.window = windowArgument()
        request.fromElement = stringArgument("from-element")
        request.toElement = stringArgument("to-element")
        request.x = doubleArgument("x")
        request.y = doubleArgument("y")
        request.toX = doubleArgument("to-x")
        request.toY = doubleArgument("to-y")
        request.button = stringArgument("button")
        request.modifiers = modifiersArgument()
        request.web = args.bool("web") ? true : nil
    }

case "type":
    validateFlags("type")
    guard let text = args.positional.first else { fail("type needs a string") }
    remote { request in
            request.cmd = "type"
            request.session = stringArgument("session")
            request.controllerLeaseID = leaseArgument()
            request.window = windowArgument()
        request.text = text
        request.web = args.bool("web") ? true : nil
        request.replace = args.bool("replace") ? true : nil
        request.submit = args.bool("submit") ? true : nil
    }

case "key":
    validateFlags("key")
    guard let combo = args.positional.first else { fail("key needs a combo like cmd+s") }
    remote { request in
            request.cmd = "key"
        request.session = stringArgument("session")
        request.controllerLeaseID = leaseArgument()
        request.window = windowArgument()
        request.key = combo
        request.web = args.bool("web") ? true : nil
        request.holdMs = intArgument("hold-ms")
        request.keyAction = stringArgument("action")
    }

case "screenshot":
    validateFlags("screenshot")
    if args.bool("memory") && !args.hasJSON { fail("--memory requires --json to return the PNG payload") }
    remote { request in
            request.cmd = "screenshot"
            request.session = stringArgument("session")
            request.controllerLeaseID = leaseArgument()
            request.window = windowArgument()
        request.output = stringArgument("output", "o")
        request.full = args.bool("full")
        request.scale = intArgument("scale")
        request.x = doubleArgument("x")
        request.y = doubleArgument("y")
        request.width = intArgument("width")
        request.height = intArgument("height")
        request.annotate = args.bool("annotate") ? true : nil
    }

case "verify":
    validateFlags("verify")
    remote { request in
        request.cmd = "verify"
        request.session = stringArgument("session")
        request.controllerLeaseID = leaseArgument()
    }

case "repark":
    validateFlags("repark")
    remote { request in
        request.cmd = "repark"
        request.session = stringArgument("session")
        request.controllerLeaseID = leaseArgument()
    }

case "logging":
    // Local diagnostic logging for improvement loops: the MCP agent journal plus per-request
    // daemon records. Running daemons and MCP servers pick the change up within a few seconds.
    let sub = args.positional.first ?? "status"
    guard LoggingCommand.subcommands.contains(sub) else {
        fail("unknown logging subcommand '\(sub)'; use status, enable, or disable")
    }
    validateFlags("logging.\(sub)")
    let settingsFile = LoggingSettings.defaultFileURL()
    let current = LoggingSettings.load(environment: [:], fileURL: settingsFile)
    if sub != "status" {
        let next: LoggingSettings
        do {
            next = sub == "enable"
                ? try LoggingCommand.enabled(from: current, level: stringArgument("level"),
                                             retentionDays: intArgument("retention-days"),
                                             maxFileMegabytes: intArgument("max-mb"))
                : LoggingCommand.disabled(from: current)
            try next.save(to: settingsFile)
        } catch {
            fail(error.localizedDescription, exit: .failure, code: (error as? SpaceOError)?.code)
        }
    }
    let resolution = LoggingSettings.resolve(fileURL: settingsFile)
    if args.hasJSON {
        let settings = resolution.settings
        print(CLIJSON.object([
            "ok": true, "journal": settings.journal.rawValue, "requestMetrics": settings.requestMetrics,
            "retentionDays": settings.retentionDays, "maxFileMegabytes": settings.maxFileMegabytes,
            "settingsFile": settingsFile.path, "journalDirectory": LoggingSettings.journalDirectory().path,
            "daemonLog": DaemonLog.defaultLogURL().path,
            "environmentOverrides": resolution.environmentOverrides,
        ]))
    } else {
        for line in LoggingCommand.statusLines(resolution, settingsFile: settingsFile,
                                               journalDirectory: LoggingSettings.journalDirectory(),
                                               daemonLog: DaemonLog.defaultLogURL()) {
            print(line)
        }
        if sub == "enable" {
            print("running daemons and 1.0.0+ MCP servers apply this within 5 seconds; older MCP servers need a client restart")
        }
    }
    exit(0)

case "mcp":
    validateFlags("mcp")
    MCPServer.run(socketPath: socketPath)

case "demo":
    validateFlags("demo")
    Demo.run(appName: stringArgument("app") ?? "TextEdit",
             keep: args.bool("keep"),
             capture: !args.bool("no-capture"),
             perDisplay: intArgument("sessions") ?? 1)

case "help", "--help", "-h":
    validateFlags("help")
    print(usage)
    exit(0)

default:
    // Never the usage text: a JSON caller gets one sentence, a person gets a suggestion.
    let suggestions = CLIHelp.suggestions(for: command)
    fail("unknown command '\(command)'"
        + (suggestions.isEmpty ? "" : "; did you mean " + suggestions.map { "`spaceo \($0)`" }.joined(separator: " or ") + "?"),
        next: "spaceo help")
}
