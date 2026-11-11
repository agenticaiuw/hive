import AppKit
import Darwin
import Foundation

/// Which application macOS will blame (and grant) for a TCC request made by `spaceo`.
///
/// TCC does not attribute Accessibility or Screen Recording to the binary that asks. It attributes
/// them to the *responsible process*: the terminal or IDE that spawned the tool. A user who is
/// told to "enable spaceo" will search the Privacy pane for a row that does not exist. Naming the
/// responsible app (Cursor, Terminal, iTerm2) is the only instruction that actually works.
///
/// `responsibility_get_pid_responsible_for_pid` is a public libproc symbol, but it is not declared
/// in any SDK header. It is resolved with `dlsym` so a host that removes it degrades to a nil
/// attribution instead of failing to link.
public enum ResponsibleProcess {
    /// What the Privacy & Security pane will show for the process the grant is attributed to.
    public struct Attribution: Equatable, Sendable {
        public var pid: pid_t
        public var name: String
        public var bundleIdentifier: String?
        public var path: String?
        /// True when the process is its own responsible process (e.g. a LaunchAgent or an app
        /// bundle launched directly), so the grant really does belong to this executable.
        public var isSelf: Bool

        public init(
            pid: pid_t, name: String, bundleIdentifier: String?, path: String?, isSelf: Bool
        ) {
            self.pid = pid
            self.name = name
            self.bundleIdentifier = bundleIdentifier
            self.path = path
            self.isSelf = isSelf
        }
    }

    private typealias ResponsibleForPID = @convention(c) (pid_t) -> pid_t

    /// The pid TCC will attribute `pid`'s requests to, or nil when the symbol is unavailable or
    /// the kernel has no answer. Never guesses: a wrong app name sends the user to the wrong row.
    public static func responsiblePID(for pid: pid_t) -> pid_t? {
        guard pid > 0 else { return nil }
        // dlopen(nil) is the global namespace handle; Swift does not import RTLD_DEFAULT.
        guard let handle = dlopen(nil, RTLD_NOW),
            let symbol = dlsym(handle, "responsibility_get_pid_responsible_for_pid")
        else { return nil }
        let function = unsafeBitCast(symbol, to: ResponsibleForPID.self)
        let responsible = function(pid)
        return responsible > 0 ? responsible : nil
    }

    /// Resolve the responsible pid and describe it the way System Settings would.
    public static func attribution(for pid: pid_t = getpid()) -> Attribution? {
        guard let responsible = responsiblePID(for: pid) else { return nil }
        let isSelf = responsible == pid
        if let app = NSRunningApplication(processIdentifier: responsible) {
            let path = app.bundleURL?.path ?? app.executableURL?.path
            let name = app.localizedName
                ?? path.map { URL(fileURLWithPath: $0).lastPathComponent }
                ?? "pid \(responsible)"
            return Attribution(
                pid: responsible, name: name, bundleIdentifier: app.bundleIdentifier,
                path: path, isSelf: isSelf)
        }
        guard let path = executablePath(of: responsible) else { return nil }
        return Attribution(
            pid: responsible, name: URL(fileURLWithPath: path).lastPathComponent,
            bundleIdentifier: nil, path: path, isSelf: isSelf)
    }

    /// `Cursor (/Applications/Cursor.app)`, or nil when nothing on this host can be blamed.
    public static func describeCurrent() -> String? {
        guard let attribution = attribution(for: getpid()) else { return nil }
        return describe(attribution)
    }

    /// The object of "Add and enable X in System Settings ▸ Privacy & Security ▸ Accessibility".
    /// Falls back to a generic phrase rather than inventing an app name.
    public static func grantPhrase(_ attribution: Attribution?) -> String {
        guard let attribution else { return "the terminal or app running spaceo" }
        return describe(attribution)
    }

    static func describe(_ attribution: Attribution) -> String {
        guard let path = attribution.path, !path.isEmpty else { return attribution.name }
        return "\(attribution.name) (\(path))"
    }

    /// Bare executable path for processes that are not AppKit applications (login shells, sshd).
    static func executablePath(of pid: pid_t) -> String? {
        // PROC_PIDPATHINFO_MAXSIZE (4 * MAXPATHLEN) is not imported into Swift.
        var buffer = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
        let length = proc_pidpath(pid, &buffer, UInt32(buffer.count))
        guard length > 0 else { return nil }
        return String(cString: buffer)
    }
}
