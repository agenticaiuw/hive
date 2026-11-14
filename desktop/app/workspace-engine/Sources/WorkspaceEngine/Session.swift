// The one workspace session and its rules. The background process (the daemon) owns the display;
// the client that created or claimed the session holds it, and only the holder acts in it. When
// the holder goes away the session waits `orphan_grace_seconds` for someone to claim it, then ends:
// its apps are hidden and asked to quit first, so nothing lands on the user's screen when the
// display disappears.
import CoreGraphics
import Darwin
import Foundation
import WorkspaceCore

/// A display the engine made. It lasts until `invalidate()` or until the process ends.
public protocol WorkspaceDisplayHandle: AnyObject {
    var displayID: UInt32 { get }
    /// Global coordinates, top-left origin, points.
    var bounds: CGRect { get }
    func invalidate()
}

public protocol DisplayProvider {
    func make(width: Int, height: Int, name: String) throws -> WorkspaceDisplayHandle
    /// The workspace displays online now.
    func online() -> [UInt32]
}

/// What happens to a session's apps when it ends.
public protocol AppHousekeeper {
    func putAway(_ apps: [SessionApp])
}

public typealias ClientID = Int

public final class SessionManager {
    public struct Live {
        public var record: SessionRecord
        public let display: WorkspaceDisplayHandle
        public var holder: ClientID?
        public var renewedAt: Double
        /// The app the agent last launched or acted on: where typing and keys go by default.
        public var activePID: Int32?

        public var stage: Stage { Stage(bounds: display.bounds) }
    }

    public let instanceID: String
    public let latch: SafetyLatch
    let store: SessionStore
    let displays: DisplayProvider
    let housekeeper: AppHousekeeper
    let health: () -> String?
    let clock: () -> Double
    let events: EventLog
    private let lock = NSRecursiveLock()
    private var current: Live?

    public init(state: URL, displays: DisplayProvider, housekeeper: AppHousekeeper,
                health: @escaping () -> String? = HostHealth.problem,
                clock: @escaping () -> Double = WorkspaceCore.now,
                instanceID: String = UUID().uuidString) {
        self.instanceID = instanceID
        latch = SafetyLatch(state: state)
        store = SessionStore(state: state)
        events = EventLog(state: state)
        self.displays = displays
        self.housekeeper = housekeeper
        self.health = health
        self.clock = clock
    }

    func locked<T>(_ body: () throws -> T) rethrows -> T {
        lock.lock()
        defer { lock.unlock() }
        return try body()
    }

    public var live: Live? { locked { current } }

    private func save() {
        guard let record = current?.record else { return }
        try? store.save(record)
    }

    static func unknown(_ name: String) -> WorkspaceError {
        WorkspaceError("unknown_session", "no session named '\(name)'")
    }

    static func busy(_ name: String) -> WorkspaceError {
        WorkspaceError("session_busy", "session '\(name)' is held by another live client; only an abandoned session can be claimed")
    }

    /// Tidies away what a session from an engine run that has since died left behind. Runs before
    /// the daemon takes requests, so clients see the session as gone rather than half there.
    public func janitor() {
        locked {
            guard let old = store.load(), old.ownerInstance != instanceID else { return }
            housekeeper.putAway(old.apps)
            store.remove()
            events.add("janitor", ok: true, note: "put away \(old.apps.count) app(s) left by an earlier engine run")
        }
    }

    public func claim(_ name: String, by client: ClientID) throws -> String {
        try locked {
            guard var live = current, live.record.id == name else { throw Self.unknown(name) }
            if let holder = live.holder, holder != client { throw Self.busy(name) }
            live.holder = client
            live.renewedAt = clock()
            live.record.orphanedAt = nil
            current = live
            save()
            return "Claimed session '\(name)' on whole display \(live.record.displayID), \(live.record.width)x\(live.record.height)."
        }
    }

    public func create(_ arguments: [String: Any], by client: ClientID) throws -> String {
        let name = try Arguments.string(arguments, "name")
        guard name.range(of: #"^[A-Za-z0-9._-]{1,64}$"#, options: .regularExpression) != nil else {
            throw WorkspaceError("bad_request", "a session name is 1-64 letters, digits, dots, dashes or underscores")
        }
        let preset = Arguments.optionalString(arguments, "preset") ?? "exclusive"
        guard preset == "exclusive" else {
            throw WorkspaceError("bad_request", "the only preset is \"exclusive\": the session gets a whole display of its own")
        }
        let title = Arguments.optionalString(arguments, "title") ?? "Agent workspace"
        let grace = Arguments.number(arguments, "orphan_grace_seconds", default: 1800, range: 30...86400)
        let ttl = Arguments.number(arguments, "ttl_seconds", default: 3600, range: 60...86400)
        let width = Int(Arguments.number(arguments, "width", default: 1440, range: 800...2560))
        let height = Int(Arguments.number(arguments, "height", default: 900, range: 600...1600))
        return try locked {
            if let live = current {
                throw WorkspaceError("session_exists", "session '\(live.record.id)' already exists on display \(live.record.displayID); claim it instead")
            }
            if let reason = latch.reason {
                throw WorkspaceError("display_creation_failed", "could not create the agent display: display safety is blocked (\(reason)); `workspace-engine safety clear-host-health --operator` clears a host-health block once the Mac is healthy")
            }
            if let problem = health() {
                throw WorkspaceError("display_creation_failed", "could not create the agent display: host health refused: \(problem); try again once the Mac has recovered")
            }
            let display: WorkspaceDisplayHandle
            do {
                display = try displays.make(width: width, height: height, name: "Hive Workspace")
            } catch {
                let why = (error as? WorkspaceError)?.message ?? "\(error)"
                // A display that fails to appear while the Mac is short of memory is the Mac's
                // condition, which the operator command can clear once it passes; any other failure
                // stays blocked until someone has looked at it.
                if let problem = health() {
                    latch.set("host health: \(problem) when the display failed to appear (\(why))")
                } else {
                    latch.set("display: \(why)")
                }
                events.add("workspace_session_create", ok: false, note: why)
                throw WorkspaceError("display_creation_failed", "could not create the agent display: \(why)")
            }
            let started = clock()
            var record = SessionRecord(id: name, title: title, preset: preset, displayID: display.displayID,
                                       width: Int(display.bounds.width), height: Int(display.bounds.height),
                                       ownerPID: getpid(), orphanGraceSeconds: grace, ttlSeconds: ttl, now: started)
            record.ownerInstance = instanceID
            current = Live(record: record, display: display, holder: client, renewedAt: started)
            save()
            return "Created session '\(name)' on whole display \(record.displayID), \(record.width)x\(record.height). Apps opened with workspace_launch_app or workspace_visit_url appear there, out of the user's way."
        }
    }

    public func destroy(_ name: String, by client: ClientID) throws -> String {
        try locked {
            guard let live = current, live.record.id == name else { throw Self.unknown(name) }
            if let holder = live.holder, holder != client { throw Self.busy(name) }
            end("ended by its client")
            return "Session '\(name)' ended: its display is gone and its apps were hidden and asked to quit."
        }
    }

    /// Ends the session now, whoever holds it.
    public func end(_ reason: String) {
        locked {
            guard let live = current else { return }
            housekeeper.putAway(live.record.apps)
            live.display.invalidate()
            current = nil
            store.remove()
            events.add("session_end", ok: true, note: reason)
        }
    }

    public func clientGone(_ client: ClientID) {
        locked {
            guard current?.holder == client else { return }
            current?.holder = nil
            current?.record.orphanedAt = clock()
            save()
        }
    }

    public func renew(_ client: ClientID) {
        locked {
            if current?.holder == client { current?.renewedAt = clock() }
        }
    }

    /// The periodic check: the display still there, the lease still fresh, the grace not run out.
    public func tick() {
        locked {
            guard var live = current else { return }
            let now = clock()
            if !displays.online().contains(live.record.displayID) {
                end("its display went offline")
                return
            }
            if live.holder != nil && now - live.renewedAt > live.record.ttlSeconds {
                live.holder = nil
                live.record.orphanedAt = now
                current = live
                save()
                events.add("lease", ok: false, note: "the holder stopped renewing; the session waits to be claimed")
            }
            if live.holder == nil, let since = live.record.orphanedAt, now - since > live.record.orphanGraceSeconds {
                end("no client for \(Int(live.record.orphanGraceSeconds))s")
            }
        }
    }

    /// The session, for a client about to use it. `acting` refuses while input is paused.
    public func session(_ name: String, for client: ClientID, acting: Bool) throws -> Live {
        try locked {
            guard var live = current, live.record.id == name else { throw Self.unknown(name) }
            guard live.holder == client else {
                throw WorkspaceError("not_yours", "session '\(name)' is not held by this client; claim it with workspace_session_claim first")
            }
            if acting && live.record.inputPaused {
                throw WorkspaceError("input_paused", "workspace input is \(Reports.inputLine(paused: true, reason: live.record.pauseReason)); wait until it is given back")
            }
            live.record.lastActivity = clock()
            current = live
            return live
        }
    }

    public func listing(for client: ClientID?) -> String {
        locked {
            guard let live = current else { return Reports.listing([]) }
            let record = live.record
            return Reports.listing([SessionView(
                id: record.id, title: record.title, displayID: record.displayID, width: record.width,
                height: record.height, yours: client != nil && live.holder == client,
                inputPaused: record.inputPaused, pauseReason: record.pauseReason, apps: record.apps,
                idleSeconds: max(0, Int(clock() - record.lastActivity)),
                orphanGraceSeconds: Int(record.orphanGraceSeconds), ttlSeconds: Int(record.ttlSeconds),
                held: live.holder != nil)])
        }
    }

    // MARK: changes the tools make

    public func addApp(_ app: SessionApp) {
        locked {
            guard current != nil else { return }
            if !current!.record.apps.contains(where: { $0.pid == app.pid }) { current!.record.apps.append(app) }
            current!.activePID = app.pid
            save()
        }
    }

    public func setActive(_ pid: Int32) {
        locked { current?.activePID = pid }
    }

    /// Drops apps whose process has ended.
    public func pruneApps(alive: (Int32) -> Bool) {
        locked {
            guard let apps = current?.record.apps else { return }
            let kept = apps.filter { alive($0.pid) }
            if kept.count != apps.count {
                current!.record.apps = kept
                if let active = current!.activePID, !kept.contains(where: { $0.pid == active }) { current!.activePID = kept.last?.pid }
                save()
            }
        }
    }

    public func setPaused(_ paused: Bool, reason: String?) throws {
        try locked {
            guard current != nil else { throw WorkspaceError("unknown_session", "there is no workspace session") }
            current!.record.inputPaused = paused
            current!.record.pauseReason = paused ? (reason ?? "operator") : nil
            save()
            events.add(paused ? "pause" : "resume", ok: true, note: paused ? (reason == "operator" || reason == nil ? "operator" : "agent") : "")
        }
    }

    public func setBrowser(port: Int?, target: String?) {
        locked {
            guard current != nil else { return }
            current!.record.browserPort = port
            current!.record.attachedTarget = target
            save()
        }
    }

    /// What the daemon tells `doctor` and `session list --operator` about the session.
    public func summary() -> [String: Any]? {
        locked {
            guard let live = current else { return nil }
            return ["id": live.record.id, "title": live.record.title, "displayID": Int(live.record.displayID),
                    "width": live.record.width, "height": live.record.height, "held": live.holder != nil,
                    "inputPaused": live.record.inputPaused, "pauseReason": live.record.pauseReason ?? NSNull(),
                    "apps": live.record.apps.map { ["name": $0.name, "bundleID": $0.bundleID, "pid": Int($0.pid),
                                                    "managedBrowser": $0.managedBrowser] }]
        }
    }
}

/// Reading tool arguments, with the refusals the agent sees.
public enum Arguments {
    public static func string(_ arguments: [String: Any], _ key: String) throws -> String {
        guard let value = arguments[key] as? String, !value.isEmpty else {
            throw WorkspaceError("bad_request", "\"\(key)\" is required and must be a non-empty string")
        }
        return value
    }

    public static func optionalString(_ arguments: [String: Any], _ key: String) -> String? {
        (arguments[key] as? String).flatMap { $0.isEmpty ? nil : $0 }
    }

    public static func number(_ arguments: [String: Any], _ key: String, default fallback: Double,
                              range: ClosedRange<Double>) -> Double {
        guard let value = (arguments[key] as? NSNumber)?.doubleValue, value.isFinite else { return fallback }
        return min(max(value, range.lowerBound), range.upperBound)
    }

    public static func requiredNumber(_ arguments: [String: Any], _ key: String) throws -> Double {
        guard let number = arguments[key] as? NSNumber, !(number === kCFBooleanTrue || number === kCFBooleanFalse),
              number.doubleValue.isFinite else {
            throw WorkspaceError("bad_request", "\"\(key)\" is required and must be a number")
        }
        return number.doubleValue
    }

    public static func bool(_ arguments: [String: Any], _ key: String, default fallback: Bool) -> Bool {
        guard let number = arguments[key] as? NSNumber else { return fallback }
        return number.boolValue
    }
}
