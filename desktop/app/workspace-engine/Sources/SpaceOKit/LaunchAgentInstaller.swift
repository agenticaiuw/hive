import Darwin
import Foundation

/// A launchctl invocation failed. The argv is included because the remedy is usually to run it
/// by hand and read launchd's own message.
public struct LaunchAgentError: Error, LocalizedError, Equatable {
    public var command: [String]
    public var status: Int32

    public var errorDescription: String? {
        "`\(command.joined(separator: " "))` exited with status \(status)"
    }
}

/// Installs the daemon as a per-user LaunchAgent.
///
/// A daemon spawned from a terminal inherits that terminal's TCC identity, so its Accessibility
/// and Screen Recording grants come and go with whichever app happened to start it. Under launchd
/// the daemon is its own responsible process and the grant is attributed to the signed binary,
/// which is stable only if the signature is. That is why `plan` refuses ad-hoc and unsigned
/// builds: installing them would produce a grant that silently dies on the next rebuild.
///
/// Nothing here runs `launchctl` except through the injectable runner, so tests never touch the
/// user's launchd domain.
public enum LaunchAgentInstaller {
    public static let label = "com.spaceo.daemon"
    static let launchctl = "/bin/launchctl"
    static let codesign = "/usr/bin/codesign"
    /// codesign output is a few hundred bytes; anything larger is not something we classify.
    static let maximumToolOutputBytes = 64 * 1024

    public static func plistURL(home: URL = FileManager.default.homeDirectoryForCurrentUser) -> URL {
        home.appendingPathComponent("Library/LaunchAgents/\(label).plist")
    }

    public static func logURL(home: URL = FileManager.default.homeDirectoryForCurrentUser) -> URL {
        home.appendingPathComponent("Library/Logs/SpaceO/daemon.log")
    }

    /// Everything `install` will do, computed up front so it can be shown and reviewed first.
    public struct Plan: Equatable, Sendable {
        public var executablePath: String
        public var socketPath: String
        public var plistURL: URL
        public var plistXML: String
        public var bootstrapCommand: [String]
        public var bootoutCommand: [String]
    }

    // MARK: - Plist

    /// Deterministic XML: `PropertyListSerialization` sorts dictionary keys, and a golden test
    /// pins the output so an accidental key change shows up as a diff rather than in launchd.
    public static func plistXML(executablePath: String, socketPath: String, logPath: String)
        -> String
    {
        let plist: [String: Any] = [
            "Label": label,
            "ProgramArguments": [executablePath, "daemon", "--socket", socketPath],
            "RunAtLoad": true,
            "KeepAlive": true,
            "ProcessType": "Interactive",
            "StandardOutPath": logPath,
            "StandardErrorPath": logPath,
            "EnvironmentVariables": ["SPACEO_SOCKET": socketPath],
        ]
        // Only string/array/bool/dictionary values above, so serialization cannot fail.
        let data = try! PropertyListSerialization.data(
            fromPropertyList: plist, format: .xml, options: 0)
        return String(decoding: data, as: UTF8.self)
    }

    // MARK: - Signing

    public enum SigningIdentity: Equatable, Sendable {
        case adHoc
        case appleDevelopment(String)
        case developerID(String)
        case unsigned
        case unknown(String)

        /// Stable across rebuilds, so a TCC grant attributed to it survives.
        public var isStable: Bool {
            switch self {
            case .appleDevelopment, .developerID: return true
            case .adHoc, .unsigned, .unknown: return false
            }
        }
    }

    public static func signingIdentity(of executablePath: String) -> SigningIdentity {
        let result: (status: Int32, output: String)
        do {
            result = try captureProcess([codesign, "-dv", "--verbose=2", executablePath])
        } catch {
            return .unknown("codesign could not run: \(error.localizedDescription)")
        }
        return classify(codesignOutput: result.output)
    }

    /// Pure classifier over `codesign -dv --verbose=2` output (which codesign writes to stderr).
    static func classify(codesignOutput: String) -> SigningIdentity {
        let lines = codesignOutput.split(whereSeparator: \.isNewline).map {
            $0.trimmingCharacters(in: .whitespaces)
        }
        if lines.contains(where: { $0.contains("code object is not signed") }) { return .unsigned }
        for line in lines where line.hasPrefix("Authority=") {
            let authority = String(line.dropFirst("Authority=".count))
            if authority.hasPrefix("Developer ID Application:") { return .developerID(authority) }
            if authority.hasPrefix("Apple Development:") { return .appleDevelopment(authority) }
        }
        if lines.contains("Signature=adhoc") { return .adHoc }
        let summary = lines.first(where: { !$0.isEmpty }) ?? "no codesign output"
        return .unknown(String(summary.prefix(200)))
    }

    // MARK: - Plan

    public static func plan(
        executablePath: String,
        socketPath: String,
        home: URL = FileManager.default.homeDirectoryForCurrentUser,
        identity: SigningIdentity
    ) throws -> Plan {
        guard identity.isStable else {
            throw SpaceOError.badRequest(
                "\(executablePath) is \(describe(identity)): its identity changes on every build, "
                + "so TCC grants would not stick; use `make signed` or the signed Viewer helper")
        }
        guard executablePath.hasPrefix("/"), socketPath.hasPrefix("/") else {
            throw SpaceOError.badRequest("LaunchAgent executable and socket paths must be absolute")
        }
        let plist = plistURL(home: home)
        return Plan(
            executablePath: executablePath,
            socketPath: socketPath,
            plistURL: plist,
            plistXML: plistXML(
                executablePath: executablePath, socketPath: socketPath,
                logPath: logURL(home: home).path),
            bootstrapCommand: [launchctl, "bootstrap", "gui/\(getuid())", plist.path],
            bootoutCommand: [launchctl, "bootout", "gui/\(getuid())/\(label)"])
    }

    static func describe(_ identity: SigningIdentity) -> String {
        switch identity {
        case .adHoc: return "ad-hoc signed"
        case .unsigned: return "unsigned"
        case .unknown(let why): return "of unknown signing identity (\(why))"
        case .appleDevelopment(let who), .developerID(let who): return "signed by \(who)"
        }
    }

    // MARK: - Install / uninstall / status

    /// Write the plist (owner-only, like other credentials-adjacent files in ~/Library) and load
    /// it. A stale registration is booted out first because `bootstrap` refuses duplicates.
    public static func install(
        _ plan: Plan, run: ([String]) throws -> Int32 = LaunchAgentInstaller.runProcess
    ) throws {
        let directory = plan.plistURL.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try Data(plan.plistXML.utf8).write(to: plan.plistURL, options: .atomic)
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o600], ofItemAtPath: plan.plistURL.path)
        _ = try? run(plan.bootoutCommand)
        let status = try run(plan.bootstrapCommand)
        guard status == 0 else {
            throw LaunchAgentError(command: plan.bootstrapCommand, status: status)
        }
    }

    /// Unload and delete. A bootout failure is not fatal here: the agent may already be gone, and
    /// leaving the plist behind would make it come back at next login.
    public static func uninstall(
        home: URL = FileManager.default.homeDirectoryForCurrentUser,
        run: ([String]) throws -> Int32 = LaunchAgentInstaller.runProcess
    ) throws {
        _ = try? run([launchctl, "bootout", "gui/\(getuid())/\(label)"])
        let plist = plistURL(home: home)
        if FileManager.default.fileExists(atPath: plist.path) {
            try FileManager.default.removeItem(at: plist)
        }
    }

    public static func status(
        home: URL = FileManager.default.homeDirectoryForCurrentUser,
        run: ([String]) throws -> (status: Int32, output: String) = LaunchAgentInstaller.captureProcess
    ) -> (installed: Bool, running: Bool, pid: Int32?) {
        let installed = FileManager.default.fileExists(atPath: plistURL(home: home).path)
        let result = try? run([launchctl, "print", "gui/\(getuid())/\(label)"])
        let parsed = parseStatus(exitStatus: result?.status ?? -1, output: result?.output ?? "")
        return (installed, parsed.running, parsed.pid)
    }

    /// `launchctl print` emits `state = running` and `pid = N` lines for a live service.
    /// Only the service's own keys count: nested endpoint and event-source blocks carry their
    /// own `state = active` lines, which used to report a running daemon as not running.
    static func parseStatus(exitStatus: Int32, output: String) -> (running: Bool, pid: Int32?) {
        guard exitStatus == 0 else { return (false, nil) }
        var running = false
        var pid: Int32?
        for raw in output.split(whereSeparator: \.isNewline) {
            guard raw.prefix(while: { $0 == "\t" }).count <= 1 else { continue }
            let line = raw.trimmingCharacters(in: .whitespaces)
            if line.hasPrefix("state = ") { running = line == "state = running" }
            if line.hasPrefix("pid = ") { pid = Int32(line.dropFirst("pid = ".count)) }
        }
        return (running, running ? pid : nil)
    }

    // MARK: - Start advice

    public static func kickstartCommand(uid: uid_t = getuid()) -> String {
        "launchctl kickstart -k gui/\(uid)/\(label)"
    }

    /// What to run when no daemon answers. With the LaunchAgent installed, starting a second
    /// daemon by hand would fight launchd for the socket, so the advice is to kick launchd.
    public static func startAdvice(installed: Bool, uid: uid_t = getuid()) -> String {
        if installed {
            return "The LaunchAgent \(label) is installed but not answering. Restart it with:\n"
                + "    \(kickstartCommand(uid: uid))\n"
                + "  then check it with:  spaceo daemon status"
        }
        return "Start one with:  spaceo daemon   (leave it running)\n"
            + "  or let your MCP client start it automatically on first use."
    }

    /// The single next command for `nextAction` fields.
    public static func startNextAction(installed: Bool, uid: uid_t = getuid()) -> String {
        installed ? kickstartCommand(uid: uid) : "spaceo daemon"
    }

        // MARK: - Process runners

    /// Default runner: argv[0] is an absolute path; no shell is involved.
    public static func runProcess(_ command: [String]) throws -> Int32 {
        try captureProcess(command).status
    }

    /// Runner that also returns combined stdout/stderr (bounded), used for `launchctl print`.
    public static func captureProcess(_ command: [String]) throws -> (status: Int32, output: String) {
        guard let executable = command.first else {
            throw SpaceOError.badRequest("empty command")
        }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = Array(command.dropFirst())
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        try process.run()
        let data = pipe.fileHandleForReading.readData(ofLength: maximumToolOutputBytes)
        // Closing our end lets a chatty child die on SIGPIPE instead of blocking the wait.
        try? pipe.fileHandleForReading.close()
        process.waitUntilExit()
        return (process.terminationStatus, String(decoding: data, as: UTF8.self))
    }
}
