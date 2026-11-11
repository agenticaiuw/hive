import Foundation

/// What `spaceo_wait_for` is waiting on.
///
/// The condition is parsed once at the request boundary and carried as a value so the loop,
/// the evaluator, and the receipt all agree on exactly what was asked. Every string payload is
/// bounded and control-free here rather than in each evaluator, so a malformed selector cannot
/// reach Accessibility or the browser bridge.
public enum WaitCondition: Equatable, Sendable {
    /// An accessibility element with this exact label is on screen.
    case elementLabel(String)
    /// No on-screen accessibility element has this exact label.
    case elementGone(String)
    /// Some window of the session has a title containing the text.
    case windowTitleContains(String)
    /// The bound Chromium target's DOM matches the CSS selector.
    case webSelector(String)
    /// The bound Chromium target's document title contains the text.
    case webTitleContains(String)
    /// The captured frame hash has stopped changing for at least this long.
    case stableMs(Int)
    /// A plain bounded pause. Exists so agents never reach for an unbounded shell `sleep`.
    case ms(Int)
    /// The session's agent input is no longer paused — the way to wait for a human who took
    /// Control (or for the agent's own pause to be lifted) without polling session_list.
    case sessionResumed

    /// Longest string payload accepted, in UTF-8 bytes: the label budget.
    public static let maximumValueBytes = AXLabelMatcher.maximumTextBytes
    /// `stable_ms` below this is noise: a single capture interval cannot prove stability.
    public static let stableRange = 100...60_000
    public static let msRange = 1...60_000

    public static let knownKinds = [
        "element_label", "element_gone", "window_title_contains",
        "web_selector", "web_title_contains", "stable_ms", "ms", "session_resumed",
    ]

    /// Build a condition from the wire `kind`/`value` pair, rejecting anything out of bounds
    /// with a message that names the offending field.
    public static func parse(kind: String, value: String?) throws -> WaitCondition {
        switch kind {
        case "element_label":         return .elementLabel(try text(value, kind: kind))
        case "element_gone":          return .elementGone(try text(value, kind: kind))
        case "window_title_contains": return .windowTitleContains(try text(value, kind: kind))
        case "web_selector":          return .webSelector(try text(value, kind: kind))
        case "web_title_contains":    return .webTitleContains(try text(value, kind: kind))
        case "stable_ms":             return .stableMs(try integer(value, kind: kind, range: stableRange))
        case "ms":                    return .ms(try integer(value, kind: kind, range: msRange))
        case "session_resumed":
            guard value?.isEmpty ?? true else {
                throw SpaceOError.badRequest("wait condition 'session_resumed' takes no value")
            }
            return .sessionResumed
        default:
            throw SpaceOError.badRequest(
                "unknown wait condition '\(kind)'; expected one of \(knownKinds.joined(separator: ", "))")
        }
    }

    /// The wire name, so a receipt can echo exactly what was requested.
    public var kind: String {
        switch self {
        case .elementLabel: return "element_label"
        case .elementGone: return "element_gone"
        case .windowTitleContains: return "window_title_contains"
        case .webSelector: return "web_selector"
        case .webTitleContains: return "web_title_contains"
        case .stableMs: return "stable_ms"
        case .ms: return "ms"
        case .sessionResumed: return "session_resumed"
        }
    }

    /// The wire value, already validated.
    public var value: String? {
        switch self {
        case .elementLabel(let s), .elementGone(let s), .windowTitleContains(let s),
             .webSelector(let s), .webTitleContains(let s):
            return s
        case .stableMs(let n), .ms(let n):
            return String(n)
        case .sessionResumed:
            return nil
        }
    }

    private static func text(_ value: String?, kind: String) throws -> String {
        guard let value, !value.isEmpty else {
            throw SpaceOError.badRequest("wait condition '\(kind)' requires a non-empty value")
        }
        guard value.utf8.count <= maximumValueBytes else {
            throw SpaceOError.badRequest(
                "wait condition '\(kind)' value is \(value.utf8.count) bytes; the limit is \(maximumValueBytes)")
        }
        guard value.unicodeScalars.allSatisfy({ !CharacterSet.controlCharacters.contains($0) }) else {
            throw SpaceOError.badRequest("wait condition '\(kind)' value must not contain control characters")
        }
        return value
    }

    private static func integer(_ value: String?, kind: String, range: ClosedRange<Int>) throws -> Int {
        guard let value, let n = Int(value.trimmingCharacters(in: .whitespaces)) else {
            throw SpaceOError.badRequest(
                "wait condition '\(kind)' requires an integer value between \(range.lowerBound) and \(range.upperBound)")
        }
        guard range.contains(n) else {
            throw SpaceOError.badRequest(
                "wait condition '\(kind)' value \(n) is outside \(range.lowerBound)...\(range.upperBound)")
        }
        return n
    }
}

/// What one probe observed, whether or not it satisfied the condition. Carried into the
/// receipt so the agent gets an addressable result (an index, a snapshot id) instead of a bare
/// "met" it must then re-read the screen to act on.
public struct WaitProbe: Equatable, Sendable {
    public var matchedIndex: Int?
    public var matchedTitle: String?
    public var snapshotID: String?
    /// Hash of the most recent captured frame; the only signal `stable_ms` uses.
    public var frameHash: UInt64?
    /// `window_title_contains`: the window whose title matched, so the next call can name it.
    public var matchedWindowID: UInt32?
    /// `session_resumed`: the operator's hand-back note, when one is waiting.
    public var handoffNote: String?

    public init(matchedIndex: Int? = nil, matchedTitle: String? = nil, snapshotID: String? = nil,
                frameHash: UInt64? = nil, matchedWindowID: UInt32? = nil, handoffNote: String? = nil) {
        self.matchedIndex = matchedIndex
        self.matchedTitle = matchedTitle
        self.snapshotID = snapshotID
        self.frameHash = frameHash
        self.matchedWindowID = matchedWindowID
        self.handoffNote = handoffNote
    }
}

public enum WaitProbeResult: Equatable, Sendable {
    case met(WaitProbe)
    case notYet(WaitProbe?)
}

/// One observation of the session against a condition. Implementations talk to Accessibility,
/// the capture pipeline, or the Chromium bridge; the loop never does, which is what keeps the
/// loop testable with a scripted evaluator.
public protocol WaitEvaluating: Sendable {
    func probe(_ condition: WaitCondition) async throws -> WaitProbeResult
}

/// How long and how often to probe. Validated on construction so a request cannot pin a daemon
/// thread for longer than the documented ceiling.
public struct WaitPolicy: Sendable, Equatable {
    public static let maximumDeadline: TimeInterval = 60
    public static let minimumInterval: TimeInterval = 0.01
    public static let maximumProbeCeiling = 10_000

    public var deadline: TimeInterval
    public var interval: TimeInterval
    /// Second ceiling independent of the clock: if the injected clock misbehaves, the loop still
    /// terminates.
    public var maximumProbes: Int

    /// Preserve the ordinary AX safety ceilings, shortening only time limits for a wait.
    /// Below the traversal's minimum supported duration, do not start another provider call.
    static func axTraversalLimits(remaining: TimeInterval?) throws -> AXTraversalLimits {
        var limits = AXTraversalLimits()
        guard let remaining else { return limits }
        guard remaining.isFinite else {
            throw SpaceOError.badRequest("remaining AX wait budget must be finite")
        }
        guard remaining >= 0.01 else { throw WaitProbeDeadlineExceeded() }
        limits.timeout = min(limits.timeout, remaining)
        limits.maxCallDuration = min(limits.maxCallDuration, limits.timeout)
        return limits
    }

    public init(deadline: TimeInterval, interval: TimeInterval = 0.25, maximumProbes: Int = 400) throws {
        guard deadline.isFinite, deadline > 0, deadline <= Self.maximumDeadline else {
            throw SpaceOError.badRequest(
                "wait deadline must be between 0 and \(Int(Self.maximumDeadline)) seconds")
        }
        guard interval.isFinite, interval >= Self.minimumInterval, interval <= deadline else {
            throw SpaceOError.badRequest(
                "wait interval must be between \(Self.minimumInterval) seconds and the deadline")
        }
        guard maximumProbes >= 1, maximumProbes <= Self.maximumProbeCeiling else {
            throw SpaceOError.badRequest("wait maximumProbes must be between 1 and \(Self.maximumProbeCeiling)")
        }
        self.deadline = deadline
        self.interval = interval
        self.maximumProbes = maximumProbes
    }
    /// Stability waits may add a confirmation between ordinary polls. Keep the watchdog
    /// ceiling above that schedule so a healthy clock reaches the requested deadline first.
    init(deadline: TimeInterval, condition: WaitCondition) throws {
        try self.init(deadline: deadline)
        if case .stableMs(let milliseconds) = condition {
            guard WaitCondition.stableRange.contains(milliseconds) else {
                throw SpaceOError.badRequest("invalid stability duration")
            }
            let shortestInterval = min(interval, Double(milliseconds) / 1_000)
            maximumProbes = max(maximumProbes, 2 * Int(ceil(deadline / shortestInterval)) + 1)
        }
    }
}

/// Runtime seams for daemon waits. Production elapsed time is monotonic, independent of
/// wall-clock corrections; deterministic tests can suspend a wait without sleeping in real time.
struct WaitRuntime: Sendable {
    var now: @Sendable () -> Date
    var sleep: @Sendable (TimeInterval) async throws -> Void

    static let live = WaitRuntime(
        now: { Date(timeIntervalSinceReferenceDate: Double(DispatchTime.now().uptimeNanoseconds) / 1_000_000_000) },
        sleep: { try await Task.sleep(nanoseconds: UInt64(max(0, $0) * 1_000_000_000)) })
}

/// Internal admission signal: no observation began because its queue consumed the budget.
struct WaitProbeDeadlineExceeded: Error {}

/// The bounded poll loop behind `spaceo_wait_for`.
///
/// Time and sleeping are injected so tests run against a fake clock and never wait for real.
/// A timeout is a normal receipt, never an error: the agent asked "did this happen within N
/// seconds" and "no" is a complete answer. Evaluator failures do propagate, because an
/// Accessibility or bridge error is not evidence about the condition either way.
public enum WaitLoop {
    public static func run(
        _ condition: WaitCondition,
        policy: WaitPolicy,
        evaluator: any WaitEvaluating,
        now: @escaping @Sendable () -> Date,
        sleep: @escaping @Sendable (TimeInterval) async throws -> Void,
        isCancelled: @escaping @Sendable () -> Bool = { Task.isCancelled }
    ) async throws -> WaitReceipt {
        try await run(condition, policy: policy, evaluator: evaluator, now: now,
                      sleep: sleep, isCancelled: isCancelled, startedAt: now())
    }

    /// SessionManager includes initial queue residence in the same condition budget.
    static func run(
        _ condition: WaitCondition, policy: WaitPolicy, evaluator: any WaitEvaluating,
        now: @escaping @Sendable () -> Date,
        sleep: @escaping @Sendable (TimeInterval) async throws -> Void,
        isCancelled: @escaping @Sendable () -> Bool = { Task.isCancelled },
        startedAt start: Date
    ) async throws -> WaitReceipt {
        // Public policy fields are mutable; revalidate at the execution boundary.
        let policy = try WaitPolicy(deadline: policy.deadline, interval: policy.interval,
                                    maximumProbes: policy.maximumProbes)
        let condition = try WaitCondition.parse(kind: condition.kind, value: condition.value)
        var probes = 0
        var lastProbe: WaitProbe?

        func receipt(_ outcome: String) -> WaitReceipt {
            WaitReceipt(
                condition: condition.kind,
                value: condition.value,
                outcome: outcome,
                elapsedSeconds: max(0, now().timeIntervalSince(start)),
                matchedIndex: lastProbe?.matchedIndex,
                matchedTitle: lastProbe?.matchedTitle,
                snapshotID: lastProbe?.snapshotID,
                probes: probes,
                matchedWindowID: lastProbe?.matchedWindowID,
                handoffNote: lastProbe?.handoffNote)
        }

        /// Sleep that turns a cancelled task into a `cancelled` receipt instead of an error, so
        /// the caller still learns how long the wait ran before it was abandoned.
        func pause(_ duration: TimeInterval) async throws -> Bool {
            guard duration > 0 else { return true }
            do {
                try await sleep(duration)
            } catch is CancellationError {
                return false
            }
            return !isCancelled()
        }

        if case .ms(let n) = condition {
            if isCancelled() { return receipt("cancelled") }
            let remaining = policy.deadline - now().timeIntervalSince(start)
            guard remaining > 0 else { return receipt("timeout") }
            let duration = min(Double(n) / 1000, remaining)
            guard try await pause(duration) else { return receipt("cancelled") }
            return receipt(Double(n) / 1000 <= remaining ? "met" : "timeout")
        }

        var stableHash: UInt64?
        var stableSince: Date?

        while true {
            if isCancelled() { return receipt("cancelled") }

            // Do not begin another potentially expensive AX/capture call at the deadline.
            if now().timeIntervalSince(start) >= policy.deadline { return receipt("timeout") }
            probes += 1
            let result: WaitProbeResult
            do {
                result = try await evaluator.probe(condition)
            } catch is WaitProbeDeadlineExceeded {
                probes -= 1
                return receipt(isCancelled() ? "cancelled" : "timeout")
            } catch is CancellationError {
                return receipt("cancelled")
            } catch let stopped as AXTraversalStopped where stopped.reason == .cancelled {
                return receipt("cancelled")
            }
            let observedAt = now()
            if isCancelled() { return receipt("cancelled") }
            if observedAt.timeIntervalSince(start) > policy.deadline { return receipt("timeout") }

            switch result {
            case .met(let probe):
                lastProbe = probe
                if case .stableMs = condition {} else { return receipt("met") }
            case .notYet(let probe):
                if let probe { lastProbe = probe }
            }

            if case .stableMs(let n) = condition {
                // Stability is judged only on consecutive identical hashes; an evaluator's own
                // met/notYet verdict is ignored so it cannot claim stability it never measured.
                let hash: UInt64?
                switch result {
                case .met(let probe): hash = probe.frameHash
                case .notYet(let probe): hash = probe?.frameHash
                }
                if let hash, hash == stableHash, let since = stableSince {
                    if observedAt >= since.addingTimeInterval(Double(n) / 1000) { return receipt("met") }
                } else {
                    stableHash = hash
                    stableSince = hash == nil ? nil : observedAt
                }
            }

            let elapsed = observedAt.timeIntervalSince(start)
            if elapsed >= policy.deadline || probes >= policy.maximumProbes { return receipt("timeout") }

            let remaining = policy.deadline - elapsed
            var delay = min(policy.interval, remaining)
            if case .stableMs(let n) = condition, let since = stableSince {
                // Probe at the first time the stability requirement could be satisfied,
                // rather than rounding a short or fractional interval up to the next poll.
                let untilStable = since.addingTimeInterval(Double(n) / 1000).timeIntervalSince(observedAt)
                if untilStable > 0 { delay = min(delay, untilStable) }
            }
            if try await pause(delay) == false { return receipt("cancelled") }
        }
    }
}
