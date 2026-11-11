import Foundation

/// Stops the running daemon so this build can replace it, including daemons too old to drain.
///
/// `daemon restart` used to send `daemon.drain` and give up when the daemon did not know it.
/// Every daemon before drain support answers `unknown command 'daemon.drain'`, so the documented
/// upgrade failed on exactly the hosts that needed it. The fallback keeps the same promise drain
/// makes — live sessions are not cut off unless the operator asks with `--now` — by waiting,
/// bounded and with progress, until the old daemon has no live sessions, then stopping it.
///
/// Everything that touches the socket, the clock, or the old process is injected, so the policy is
/// tested without a daemon.
public struct DaemonRestart {
    public enum Mode: Sendable, Equatable {
        /// Wait for live sessions to finish (drain, or the legacy wait), then stop.
        case whenIdle
        /// Stop now; live sessions are torn down and detached records are left for recovery.
        case now
    }

    public enum Outcome: Equatable {
        /// The old daemon exited; the caller starts this build.
        case stopped(String)
        /// Sessions were still live at the deadline; nothing was stopped.
        case stillBusy(String)
        /// The daemon refused; its response is surfaced as-is.
        case refused(Response)
        /// Transport failed mid-restart.
        case unreachable(String)

        public static func == (lhs: Outcome, rhs: Outcome) -> Bool {
            switch (lhs, rhs) {
            case let (.stopped(a), .stopped(b)), let (.stillBusy(a), .stillBusy(b)),
                 let (.unreachable(a), .unreachable(b)):
                return a == b
            case let (.refused(a), .refused(b)):
                return a.errorCode == b.errorCode && a.error == b.error
            default:
                return false
            }
        }
    }

    public var send: (Request, TimeInterval) throws -> Response
    public var isAlive: () -> Bool
    public var now: () -> Date
    public var sleep: (TimeInterval) -> Void
    /// One human sentence per state change; stderr in `--json` mode.
    public var progress: (String) -> Void
    public var pollInterval: TimeInterval = 0.5

    public init(send: @escaping (Request, TimeInterval) throws -> Response,
                isAlive: @escaping () -> Bool,
                now: @escaping () -> Date = {
                    Date(timeIntervalSinceReferenceDate: Double(DispatchTime.now().uptimeNanoseconds) / 1_000_000_000)
                },
                sleep: @escaping (TimeInterval) -> Void,
                progress: @escaping (String) -> Void) {
        self.send = send
        self.isAlive = isAlive
        self.now = now
        self.sleep = sleep
        self.progress = progress
    }

    /// Live sessions, excluding detached recovery records (which belong to no running daemon).
    static func liveSessionCount(_ response: Response) -> Int? {
        guard response.ok, let sessions = response.sessions else { return nil }
        return sessions.filter { $0.runtimeAttached != false }.count
    }

    func sessionCount(deadline: Date) -> Int? {
        let remaining = deadline.timeIntervalSince(now())
        guard remaining > 0 else { return nil }
        var list = Request(cmd: "session.list")
        list.operatorScope = true
        return (try? send(list, min(5, remaining))).flatMap(Self.liveSessionCount)
    }

    func stopRequest() -> Request {
        var stop = Request(cmd: "daemon.stop")
        stop.operatorScope = true
        // A restart replaces the daemon; a previous daemon's detached records stay durable for
        // the replacement to recover instead of blocking the stop inside their grace window.
        stop.leaveDetachedRecords = true
        return stop
    }

    func waitForExit(deadline: Date, reportSessions: Bool) -> Bool {
        var lastCount: Int?
        while isAlive() {
            guard now() < deadline else { return false }
            if reportSessions, let count = sessionCount(deadline: deadline), count != lastCount {
                lastCount = count
                progress("\(count) live session(s) remaining…")
            }
            guard isAlive() else { return true }
            let remaining = deadline.timeIntervalSince(now())
            guard remaining > 0 else { return false }
            sleep(min(pollInterval, remaining))
        }
        return true
    }

    public func run(mode: Mode, timeout: TimeInterval) -> Outcome {
        guard timeout.isFinite, (1...3_600).contains(timeout),
              pollInterval.isFinite, (0.01...60).contains(pollInterval) else {
            return .refused(.failure(SpaceOError.badRequest(
                "restart timeout must be from 1 through 3600 seconds and poll interval from 0.01 through 60 seconds")))
        }
        let deadline = now().addingTimeInterval(timeout)
        if mode == .now {
            return stopAndWait(deadline: min(deadline, now().addingTimeInterval(120)),
                               reason: "stopping the daemon now (--now)")
        }

        var drain = Request(cmd: "daemon.drain")
        drain.operatorScope = true
        drain.timeout = min(timeout, 3_600)
        let drained: Response
        do {
            let remaining = deadline.timeIntervalSince(now())
            guard remaining > 0 else { return .stillBusy("restart deadline expired; no drain was sent") }
            drained = try send(drain, min(30, remaining))
        } catch {
            return .unreachable(error.localizedDescription)
        }
        if drained.ok {
            progress(drained.message ?? "draining: new sessions are refused; existing ones keep working")
            guard waitForExit(deadline: deadline, reportSessions: true) else {
                return .stillBusy("the old daemon is still serving live sessions after \(Int(timeout))s; "
                    + "it keeps draining and exits after the last one. Retry later, or pass --now.")
            }
            return .stopped("the old daemon drained and exited")
        }
        guard DaemonVersionDrift.isUnknownCommand(drained, command: "daemon.drain") else {
            return .refused(drained)
        }
        return legacyRestart(daemonVersion: drained.daemon?.version, deadline: deadline,
                             timeout: timeout)
    }

    func legacyRestart(daemonVersion: String?, deadline: Date, timeout: TimeInterval) -> Outcome {
        let described = daemonVersion ?? "an older version"
        progress("the running daemon (\(described)) predates `daemon.drain`, so it cannot refuse new "
            + "sessions while existing ones finish. Waiting up to \(Int(timeout))s for it to have no "
            + "live sessions, then stopping it and starting this build. Pass --now to stop it immediately.")
        var lastCount: Int?
        while true {
            guard isAlive() else { return .stopped("the old daemon exited on its own") }
            if let count = sessionCount(deadline: deadline) {
                if count == 0 {
                    return stopAndWait(deadline: min(deadline, now().addingTimeInterval(120)),
                                       reason: "no live sessions; stopping the old daemon")
                }
                if count != lastCount {
                    lastCount = count
                    progress("\(count) live session(s) remaining; waiting for them to be destroyed…")
                }
            }
            guard now() < deadline else {
                return .stillBusy("the old daemon (\(described)) still has "
                    + "\(lastCount.map(String.init) ?? "an unknown number of") live session(s) after "
                    + "\(Int(timeout))s; nothing was stopped. Retry later, or pass --now to stop it and "
                    + "its sessions immediately.")
            }
            sleep(min(max(pollInterval, 1), max(0, deadline.timeIntervalSince(now()))))
        }
    }

    func stopAndWait(deadline: Date, reason: String) -> Outcome {
        progress(reason)
        let response: Response
        do {
            let remaining = deadline.timeIntervalSince(now())
            guard remaining > 0 else {
                return .stillBusy("restart deadline expired before shutdown; no stop was sent")
            }
            response = try send(stopRequest(), min(30, remaining))
        } catch {
            return .unreachable(error.localizedDescription)
        }
        guard response.ok else { return .refused(response) }
        guard waitForExit(deadline: deadline, reportSessions: false) else {
            return .stillBusy("the daemon acknowledged the stop but has not exited yet; "
                + "check `spaceo daemon status` and `spaceo doctor`")
        }
        return .stopped(response.message ?? "the old daemon stopped")
    }
}
