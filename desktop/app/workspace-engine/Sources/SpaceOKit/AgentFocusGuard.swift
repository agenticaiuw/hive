import AppKit
import Foundation

/// Hands activation back to the person when an agent application takes it (#53).
///
/// SpaceO never activates an agent application, but an application can activate itself:
/// Chromium does when a page opens a popup window, which also pulls the person onto the agent
/// display's Space and sends their keystrokes to the agent's browser until they notice. The
/// guard follows public activation notifications, remembers the person's most recent
/// application, and when an agent-owned process takes over, re-activates that application with
/// public `NSRunningApplication.activate()` — the recovery teardown already uses. It never calls a
/// private focus API, warps the pointer or changes a Space directly.
///
/// Nothing in SpaceO puts an agent application in front on purpose — the Viewer's human control
/// injects input without activating it — so every agent activation is returned. Ownership is
/// judged by exact process identity, and a restoration counts only when the person's whole
/// route is intact again. A process that keeps re-taking activation stops being restored, so the
/// ordinary breach handling reports it instead of two applications trading the front.
public final class AgentFocusGuard: @unchecked Sendable {
    public static let shared = AgentFocusGuard()

    /// `session` is the owner recorded while the process was still agent-owned, so a report made
    /// after a slow restoration keeps its session scope even if teardown released the process.
    public enum Outcome: Equatable, Sendable {
        /// No agent application holds activation (any more).
        case notNeeded
        /// `app` is frontmost again after the agent process `agentPID` (`agentName`) took over.
        case restored(app: String, agentPID: pid_t, agentName: String, session: String?)
        /// An agent process holds activation and restoration was not possible or not confirmed.
        case unavailable(reason: String, agentPID: pid_t, session: String?)
    }

    struct Application: Equatable, Sendable {
        let pid: pid_t
        let name: String
        /// Exact identity when known; a recycled PID is a different application.
        let identity: ProcessIdentity?
    }

    struct Environment: Sendable {
        var frontmost: @Sendable () -> Application?
        var application: @Sendable (pid_t) -> Application?
        var activate: @Sendable (pid_t) -> Bool
        /// The owning session of an exactly identified agent process, or nil for anyone else.
        var owner: @Sendable (Application) -> String?
        /// The person's whole current route — menu bar, Space and input focus — is observed
        /// intact. Unknown evidence is not intact.
        var isolationIntact: @Sendable () -> Bool
        var uptime: @Sendable () -> TimeInterval
        var sleep: @Sendable (TimeInterval) -> Void

        static let live = Environment(
            frontmost: { NSWorkspace.shared.frontmostApplication.map(Application.init) },
            application: { NSRunningApplication(processIdentifier: $0).map(Application.init) },
            activate: { NSRunningApplication(processIdentifier: $0)?.activate() ?? false },
            owner: { app in
                (app.identity ?? ProcessIdentity.current(of: app.pid)).flatMap(ProcessOwnership.owner(of:))
            },
            isolationIntact: { AgentFocusGuard.routeRecovered(IsolationSnapshot.capture().currentReport()) },
            uptime: { ProcessInfo.processInfo.systemUptime },
            sleep: { Thread.sleep(forTimeInterval: $0) })
    }

    /// Whether the person's route has observably left the agent: no check fails, and the menu
    /// bar owner, front process and active Space — the checks an activation changes and AppKit
    /// can observe — each pass. Key and text routes have no safe public getter and stay unknown
    /// whenever the focused application exposes no Accessibility focus (common for Electron
    /// apps), exactly as in every other receipt; unknown is never counted as a pass.
    static func routeRecovered(_ report: IsolationReport) -> Bool {
        guard report.failures.isEmpty else { return false }
        let observable: Set<IsolationDimension> = [.menuBarOwner, .windowServerFrontProcess, .activeSpace]
        return observable.allSatisfy { dimension in
            report.checks.contains { $0.dimension == dimension && $0.status == .passed }
        }
    }

    static let maximumRestores = 3
    static let restoreWindow: TimeInterval = 10

    private let environment: Environment
    private let lock = NSLock()
    /// Serializes restoration so a notification and an action's repair cannot both activate.
    private let restoreLock = NSLock()
    private var lastUser: Application?
    private var recentRestores: [pid_t: [TimeInterval]] = [:]
    /// At most one queued check per agent process, however often it re-takes activation.
    private var pendingChecks: Set<pid_t> = []
    private var observer: NSObjectProtocol?
    private var onBackgroundRestore: (@Sendable (Outcome) -> Void)?
    private let worker = DispatchQueue(label: "spaceo.agent-focus-guard")

    init(environment: Environment = .live) {
        self.environment = environment
    }

    var restoreHistoryCount: Int { lock.withLock { recentRestores.count } }
    var pendingCheckCount: Int { lock.withLock { pendingChecks.count } }

    /// Follow activation for the life of the daemon. Notifications arrive on the main run loop;
    /// observing them also keeps `NSWorkspace.frontmostApplication` current in this process.
    public func start(onBackgroundRestore: @escaping @Sendable (Outcome) -> Void) {
        start(observingWorkspace: true, onBackgroundRestore: onBackgroundRestore)
    }

    func start(observingWorkspace: Bool, onBackgroundRestore: @escaping @Sendable (Outcome) -> Void) {
        lock.withLock {
            guard observer == nil, self.onBackgroundRestore == nil else { return }
            self.onBackgroundRestore = onBackgroundRestore
            if let front = environment.frontmost(), environment.owner(front) == nil { lastUser = front }
            guard observingWorkspace else { return }
            observer = NSWorkspace.shared.notificationCenter.addObserver(
                forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: nil
            ) { [weak self] note in
                guard let app = note.userInfo?[NSWorkspace.applicationUserInfoKey]
                    as? NSRunningApplication else { return }
                self?.noteActivation(Application(app))
            }
        }
    }

    public func stop() {
        lock.withLock {
            if let observer { NSWorkspace.shared.notificationCenter.removeObserver(observer) }
            observer = nil
            onBackgroundRestore = nil
        }
    }

    /// Remember the person's application, or start returning activation to it. Never blocks
    /// the notification's thread.
    func noteActivation(_ app: Application) {
        guard environment.owner(app) != nil else {
            lock.withLock { lastUser = app }
            return
        }
        guard lock.withLock({ pendingChecks.insert(app.pid).inserted }) else { return }
        worker.async { [weak self] in
            guard let self else { return }
            // Cleared before checking, so an activation during this check queues one more.
            self.lock.withLock { _ = self.pendingChecks.remove(app.pid) }
            let outcome = self.restoreAfterActivation(of: app)
            guard outcome != .notNeeded else { return }
            let report = self.lock.withLock { self.onBackgroundRestore }
            report?(outcome)
        }
    }

    /// The notification can arrive before this process's frontmost-application view reflects it
    /// (tens of milliseconds). Wait briefly for the view to agree, so the restoration is not
    /// skipped as unnecessary; if the person has already moved on, nothing is done.
    func restoreAfterActivation(of app: Application, settle: TimeInterval = 0.25) -> Outcome {
        let deadline = environment.uptime() + settle
        while environment.frontmost()?.pid != app.pid, environment.uptime() < deadline {
            environment.sleep(0.01)
        }
        return restoreIfAgentFront()
    }

    /// Return activation to the person's application if an agent process is frontmost.
    ///
    /// The destination is the most recent non-agent application this guard saw activated (never
    /// older than an action's own baseline); `preferring` identifies the exact application that
    /// was frontmost before an agent action, used when nothing newer is known. Success means the
    /// destination is frontmost again and the whole route is intact within `timeout`; if the
    /// person switches to another application of theirs meanwhile, nothing is left to restore.
    public func restoreIfAgentFront(preferring preferred: ProcessIdentity? = nil,
                                    timeout: TimeInterval = 1) -> Outcome {
        let wait = timeout.isFinite ? min(max(timeout, 0), 2) : 1
        restoreLock.lock()
        defer { restoreLock.unlock() }
        guard let front = environment.frontmost(), let session = environment.owner(front) else {
            return .notNeeded
        }
        func unavailable(_ reason: String) -> Outcome {
            .unavailable(reason: reason, agentPID: front.pid, session: session)
        }
        guard let target = destination(excluding: front, preferring: preferred) else {
            return unavailable("no earlier application of yours is available")
        }
        let now = environment.uptime()
        let admitted = lock.withLock { () -> Bool in
            for (pid, times) in recentRestores {
                recentRestores[pid] = times.filter { now - $0 < Self.restoreWindow }
            }
            recentRestores = recentRestores.filter { !$0.value.isEmpty }
            let recent = recentRestores[front.pid] ?? []
            guard recent.count < Self.maximumRestores else { return false }
            recentRestores[front.pid] = recent + [now]
            return true
        }
        guard admitted else {
            return unavailable("\(front.name) keeps taking activation; SpaceO stopped returning it")
        }
        guard environment.activate(target.pid) else {
            return unavailable("\(target.name) could not be activated")
        }
        let deadline = now + wait
        var frontmostAgain = false
        repeat {
            if let current = environment.frontmost(), environment.owner(current) == nil {
                // The front application alone is not the whole route: the Space and input focus
                // must have left the agent too before this counts.
                if environment.isolationIntact() {
                    guard current.pid == target.pid else { return .notNeeded }
                    return .restored(app: target.name, agentPID: front.pid, agentName: front.name, session: session)
                }
                frontmostAgain = frontmostAgain || current.pid == target.pid
                environment.sleep(0.025)
            } else {
                environment.sleep(0.01)
            }
        } while environment.uptime() < deadline
        return unavailable(frontmostAgain
            ? "\(target.name) is frontmost again but isolation was not confirmed within \(Int(wait * 1_000)) ms"
            : "\(target.name) was not frontmost again within \(Int(wait * 1_000)) ms")
    }

    /// Re-read now: a remembered application may since have exited, been replaced by another
    /// process reusing its PID, or been adopted into a session.
    private func destination(excluding front: Application, preferring preferred: ProcessIdentity?) -> Application? {
        let remembered = lock.withLock { lastUser }
        var candidates: [Application] = []
        if let remembered, let current = environment.application(remembered.pid),
           remembered.identity == nil || current.identity == remembered.identity {
            candidates.append(current)
        }
        if let preferred, let current = environment.application(preferred.pid), current.identity == preferred {
            candidates.append(current)
        }
        return candidates.first { $0.pid != front.pid && environment.owner($0) == nil }
    }
}

extension AgentFocusGuard.Application {
    init(_ app: NSRunningApplication) {
        self.init(pid: app.processIdentifier,
                  name: app.localizedName ?? app.bundleIdentifier ?? "pid \(app.processIdentifier)",
                  identity: ProcessIdentity.current(of: app.processIdentifier))
    }
}
