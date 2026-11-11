import Foundation

/// Content-free observations. A ready sample is admission evidence, not an OS safety guarantee.
public struct DisplayHostHealthReport: Codable, Sendable, Equatable {
    public var state: DisplaySafetyStatus.State
    public var reasons: [String]
    public var colorsyncCPUPercent: Double?
    public var memoryPressure: UInt32?
    public var swapinsDelta: UInt64?
    public var swapoutsDelta: UInt64?
    public var unavailableInput: String?
    /// Explicit reserved-host diagnostic run; ready is overridden, not sampled health.
    public var testingOverride: Bool? = nil
    /// Separate graph-change readiness from health permitted for ongoing display use.
    public var reconfigurationSettled: Bool? = nil
    public var reconfigurationCPUThresholdPercent: Double? = nil
}

enum DisplayTestingPolicy {
    static func enabled(environment: [String: String] = ProcessInfo.processInfo.environment) -> Bool {
        environment["SPACEO_LIVE_TESTS"] == "1" && environment["SPACEO_TESTING_HOST"] == "1"
    }
}

struct DisplayHostHealthSample: Sendable {
    /// Launch counts come from launchd for both states, so a launch between samples is visible
    /// even when no process row exists at either sample.
    enum Service: Sendable, Equatable {
        case running(pid: Int32, start: String, cpuSeconds: Double, launches: UInt64)
        case idle(launches: UInt64)

        var isValid: Bool {
            guard case let .running(pid, start, cpuSeconds, launches) = self else { return true }
            return pid > 0 && !start.isEmpty && cpuSeconds.isFinite && cpuSeconds >= 0 && launches >= 1
        }
    }
    /// Monotonic timestamp paired with the final process CPU observation.
    let uptime: TimeInterval
    let pressure: UInt32
    let swapins: UInt64
    let swapouts: UInt64
    let services: [String: Service]

    static func assess(_ before: Self, _ after: Self) throws -> DisplayHostHealthReport {
        let elapsed = after.uptime - before.uptime
        guard elapsed.isFinite, (4...10).contains(elapsed),
              [1, 2, 4].contains(before.pressure), [1, 2, 4].contains(after.pressure),
              before.swapins <= after.swapins, before.swapouts <= after.swapouts,
              Set(before.services.keys) == Set(DisplayHostHealthSampler.services),
              Set(after.services.keys) == Set(DisplayHostHealthSampler.services) else { throw Unknown("sampling_interval_or_counters") }
        var cpu = 0.0
        for name in DisplayHostHealthSampler.services {
            let old = before.services[name]!, new = after.services[name]!
            guard old.isValid, new.isValid else { throw Unknown("colorsync_service_counter") }
            switch (old, new) {
            case let (.running(oldPID, oldStart, oldCPU, oldLaunches), .running(pid, start, newCPU, launches)):
                guard oldPID == pid, oldStart == start, newCPU >= oldCPU else { throw Unknown("colorsync_service_changed") }
                guard oldLaunches == launches else { throw Unknown("colorsync_launch_count_changed") }
                cpu += (newCPU - oldCPU) / elapsed * 100
            case let (.idle(oldLaunches), .idle(launches)):
                // No launch between the two launchd reads, so no service CPU in the interval.
                guard oldLaunches == launches else { throw Unknown("colorsync_launch_count_changed") }
            case let (.idle(oldLaunches), .running(_, _, newCPU, launches)):
                // Exactly one launch: its whole lifetime CPU bounds all service work since the
                // idle read. Any further launch could hide an exited instance's CPU.
                guard oldLaunches < UInt64.max, launches == oldLaunches + 1 else {
                    throw Unknown("colorsync_launch_count_changed")
                }
                cpu += newCPU / elapsed * 100
            case (.running, .idle):
                throw Unknown("colorsync_service_transition")
            }
        }
        guard cpu.isFinite else { throw Unknown() }
        let swapins = after.swapins - before.swapins, swapouts = after.swapouts - before.swapouts
        var reasons: [String] = []
        if before.pressure != 1 || after.pressure != 1 { reasons.append("memory_pressure") }
        if cpu >= 50 { reasons.append("colorsync_busy") }
        if swapins > 0 || swapouts > 0 { reasons.append("swap_activity") }
        return .init(state: reasons.isEmpty ? .ready : .blocked, reasons: reasons,
                     colorsyncCPUPercent: cpu, memoryPressure: after.pressure,
                     swapinsDelta: swapins, swapoutsDelta: swapouts)
    }

    struct Unknown: Error {
        let reason: String
        init(_ reason: String = "host_health_unknown") { self.reason = reason }
    }
}

/// One sampler and an independent watchdog. Nothing here queries or mutates WindowServer.
/// A stuck sampler is never replaced; late results cannot clear the sticky failure.
final class DisplayHostHealth: @unchecked Sendable {
    static let reconfigurationCPUThresholdPercent = 25.0
    /// Bound retained synchronization objects and synchronous sampler fan-out independently
    /// of the later display creation rate limit. One caller keeps one slot across wakeups.
    static let maximumReconfigurationWaiters = 32

    /// Internal control flow distinguishes a ready-but-warm host from a hard health fault.
    /// Stage unwraps this error at the public boundary to preserve the existing error code.
    struct ReconfigurationSettlingRefusal: Error, LocalizedError, CustomStringConvertible {
        let underlyingError: SpaceOError
        var errorDescription: String? { underlyingError.errorDescription }
        var description: String { underlyingError.description }
    }

    private let testingOverride: Bool
    private let lock = NSLock()
    private var reconfigurationWaiters: [UUID: DispatchSemaphore] = [:]
    private let worker = DispatchQueue(label: "spaceo.host-health-sampler")
    private let watchdog = DispatchQueue(label: "spaceo.host-health-watchdog")
    private var timer: DispatchSourceTimer?
    private let initialDecision = DispatchGroup()
    private var waitingForInitialDecision = true
    private var started = false
    private var inFlightSince: TimeInterval?
    private var lastAttempt: TimeInterval?
    private var previous: DisplayHostHealthSample?
    private var reportedAt: TimeInterval?
    private var consecutiveSettledSamples = 0
    private var settlingAfter: TimeInterval?
    /// Known memory pressure and swap activity are reversible admission refusals.
    /// Unknown host state and lifecycle failures remain sticky.
    private var recoveringResources = false
    private var resourceSwapBaseline: (UInt64, UInt64)?
    /// Under the testing override: whether any interval has been measured in this process.
    private var overrideMeasured = false
    /// Under the testing override: when the settled count last advanced. Without the normal
    /// watchdog, a stuck or descheduled sampler must not leave old quiet evidence standing.
    private var overrideEvidenceAt: TimeInterval?
    private var current = DisplayHostHealthReport(state: .unknown, reasons: ["not_sampled"])
    private let sample: @Sendable () throws -> DisplayHostHealthSample
    private let now: @Sendable () -> TimeInterval
    private let onFailure: @Sendable (String) -> Void
    private let waitForReconfiguration: @Sendable (DispatchSemaphore, DispatchTime) -> Void

    init(testingOverride: Bool = DisplayTestingPolicy.enabled(),
         sample: @escaping @Sendable () throws -> DisplayHostHealthSample = { try DisplayHostHealthSampler.capture() },
         now: @escaping @Sendable () -> TimeInterval = { ProcessInfo.processInfo.systemUptime },
         onFailure: @escaping @Sendable (String) -> Void = { _ in },
         waitForReconfiguration: @escaping @Sendable (DispatchSemaphore, DispatchTime) -> Void = {
             _ = $0.wait(timeout: $1)
         }) {
        self.testingOverride = testingOverride
        self.sample = sample
        self.now = now
        self.onFailure = onFailure
        self.waitForReconfiguration = waitForReconfiguration
        initialDecision.enter()
        if testingOverride {
            // Admission is ready, but reconfiguration still waits for measured ColorSync load.
            current = .init(state: .ready, reasons: ["testing_override"], testingOverride: true)
            finishInitialDecision()
        }
    }

    var report: DisplayHostHealthReport {
        expireIfNeeded()
        return lock.withLock {
            var report = current
            report.reconfigurationSettled = settledLocked()
            report.reconfigurationCPUThresholdPercent = Self.reconfigurationCPUThresholdPercent
            return report
        }
    }

    var hasStarted: Bool { lock.withLock { started } }
    var isRecoveringTransientResources: Bool { lock.withLock { recoveringResources } }
    var reconfigurationWaiterCount: Int { lock.withLock { reconfigurationWaiters.count } }

    func requireHealthy() throws {
        start()
        guard initialDecision.wait(timeout: .now() + 15) == .success else {
            fail("host_health_timeout")
            throw SpaceOError.stageCreationFailed("host health could not be established; inspect display safety")
        }
        let observed = report
        guard observed.state == .ready else {
            throw SpaceOError.stageCreationFailed("host health refused: " + observed.reasons.joined(separator: ", ")
                + (observed.unavailableInput.map { " (unavailable input: \($0))" } ?? "")
                + "; retain the display owner and inspect docs/DISPLAY_SAFETY.md")
        }
    }

    /// Reconfiguration is more conservative than ongoing use: two distinct assessed CPU
    /// intervals must both be below 25%. Reading a cached report cannot advance this count.
    var isSettledForReconfiguration: Bool {
        expireIfNeeded()
        return lock.withLock { settledLocked() }
    }

    /// Both endpoints of qualifying intervals must follow this graph-change fence,
    /// including captures which were still being reconciled when the graph changed.
    func resetReconfigurationSettling() {
        lock.withLock {
            if testingOverride {
                // One quiet interval wholly after this change, rather than normal mode's two.
                consecutiveSettledSamples = min(consecutiveSettledSamples, 1)
                settlingAfter = now()
                signalReconfigurationWaiters()
                return
            }
            consecutiveSettledSamples = 0
            settlingAfter = now()
            signalReconfigurationWaiters()
        }
    }

    func requireStillSettledForReconfiguration() throws {
        expireIfNeeded()
        try lock.withLock {
            guard settledLocked() else {
                throw reconfigurationRefusal()
            }
        }
    }

    /// Caller holds the state lock.
    private func reconfigurationRefusal() -> Error {
        if current.state != .ready {
            return SpaceOError.stageCreationFailed("host health refused: " + current.reasons.joined(separator: ", ")
                + (current.unavailableInput.map { " (unavailable input: \($0))" } ?? "")
                + "; retain the display owner and inspect docs/DISPLAY_SAFETY.md")
        }
        let error = SpaceOError.stageCreationFailed("display reconfiguration refused: ColorSync has not settled "
            + "below \(Int(Self.reconfigurationCPUThresholdPercent))% for two consecutive observations; "
            + "retain the display owner; wait for ColorSync to settle before another request. If it stays busy, "
            + "`spaceo doctor` reports leftover display identities to clean, and logging out ends the ColorSync "
            + "work macOS keeps for every display attached since login.")
        return ReconfigurationSettlingRefusal(underlyingError: error)
    }

    /// Wait on the existing sampler. A settling deadline is a transient refusal, while the
    /// normal monitor still owns all hard/sticky health failures and its independent watchdog.
    func requireSettledForReconfiguration(timeout: TimeInterval = 15) throws {
        guard timeout.isFinite, (0...30).contains(timeout) else {
            throw SpaceOError.badRequest("display settling timeout must be between zero and thirty seconds")
        }
        let deadline = DispatchTime.now() + timeout
        if isSettledForReconfiguration { return }
        if timeout > 0 { start() }
        let waiterID = UUID()
        defer { lock.withLock { _ = reconfigurationWaiters.removeValue(forKey: waiterID) } }
        while true {
            expireIfNeeded()
            lock.lock()
            if current.state == .blocked || DispatchTime.now().uptimeNanoseconds >= deadline.uptimeNanoseconds {
                let refusal = reconfigurationRefusal()
                lock.unlock()
                throw refusal
            }
            if settledLocked() {
                lock.unlock()
                return
            }
            // Register under the state lock before unlocking. A signal arriving before wait
            // remains queued, and every caller has its own semaphore so wakeups cannot be
            // consumed by another caller. One absolute DispatchTime bounds all waits without
            // depending on Date, clock adjustments, subsequent samples, or watchdog signals.
            let signal: DispatchSemaphore
            if let registered = reconfigurationWaiters[waiterID] {
                signal = registered
            } else {
                guard reconfigurationWaiters.count < Self.maximumReconfigurationWaiters else {
                    lock.unlock()
                    throw ReconfigurationSettlingRefusal(underlyingError: .resourceLimit(
                        kind: .displays,
                        detail: "display reconfiguration wait limit: at most \(Self.maximumReconfigurationWaiters) "
                            + "concurrent requests; retain the display owner and wait for an existing request to finish",
                        retryAfter: nil))
                }
                signal = DispatchSemaphore(value: 0)
                reconfigurationWaiters[waiterID] = signal
            }
            lock.unlock()
            waitForReconfiguration(signal, deadline)
        }
    }

    /// Caller holds the state lock. Both sample decisions and sticky faults wake every waiter.
    private func signalReconfigurationWaiters() {
        for signal in reconfigurationWaiters.values { signal.signal() }
    }

    private func start() {
        lock.withLock {
            guard !started, current.state != .blocked || recoveringResources else { return }
            started = true
            let timer = DispatchSource.makeTimerSource(queue: watchdog)
            timer.schedule(deadline: .now(), repeating: .seconds(1), leeway: .milliseconds(100))
            timer.setEventHandler { [weak self] in self?.tick() }
            self.timer = timer
            timer.resume()
        }
    }

    /// Also driven directly by deterministic tests, without starting a timer or host sampler.
    func tick() {
        expireIfNeeded()
        let time = now()
        let shouldSample = lock.withLock { () -> Bool in
            guard (current.state != .blocked || recoveringResources), inFlightSince == nil,
                  lastAttempt.map({ time - $0 >= 5 }) ?? true else { return false }
            inFlightSince = time
            lastAttempt = time
            return true
        }
        guard shouldSample else { return }
        worker.async { [weak self] in
            guard let self else { return }
            do { self.accept(try self.sample()) }
            catch where self.testingOverride { self.acceptOverride(nil) }
            catch let error as DisplayHostHealthSample.Unknown {
                if ["colorsync_process_list", "colorsync_process_list_launch", "colorsync_process_list_io",
                    "colorsync_process_list_unsuccessful_exit", "colorsync_process_list_timeout"].contains(error.reason) {
                    self.transientProcessListFailure(error.reason)
                } else { self.fail("host_health_unknown", unavailableInput: error.reason) }
            }
            catch { self.fail("host_health_unknown") }
        }
    }

    /// A failed read gives no evidence of a host incident. Revoke all admission evidence,
    /// then require a new pair of observations before use and two quiet intervals before
    /// reconfiguration. Pending mutations remain protected by the lifecycle journal.
    func transientProcessListFailure(_ reason: String) {
        // A returned helper timeout is recoverable only while the independent sampler
        // deadline is still valid. A late worker must not undo the watchdog's sticky fault.
        expireIfNeeded()
        lock.withLock {
            guard current.state != .blocked || recoveringResources else { return }
            inFlightSince = nil
            previous = nil
            reportedAt = nil
            consecutiveSettledSamples = 0
            if recoveringResources {
                current.unavailableInput = reason
            } else {
                current = .init(state: .unknown, reasons: ["host_health_unknown"], unavailableInput: reason)
            }
            finishInitialDecision()
            signalReconfigurationWaiters()
        }
    }

    func accept(_ next: DisplayHostHealthSample) {
        guard !testingOverride else { return acceptOverride(next) }
        // Check the independent deadline even when the watchdog has not had its next tick.
        expireIfNeeded()
        var failed: String?
        lock.withLock {
            defer {
                // fail() publishes the sticky fault after releasing this lock. Revoke quiet
                // evidence first so a woken reconfiguration waiter cannot pass in between.
                if failed != nil { consecutiveSettledSamples = 0 }
                signalReconfigurationWaiters()
            }
            guard current.state != .blocked || recoveringResources else { return }
            inFlightSince = nil
            guard next.uptime.isFinite, abs(now() - next.uptime) <= 3,
                  [1, 2, 4].contains(next.pressure) else {
                failed = "host_health_unknown"; return
            }
            // Pace from the CPU observation, rather than trailing validation completion.
            // Each next observation is at least five seconds later without adding both
            // captures' helper budgets to the policy's maximum sampling interval.
            lastAttempt = next.uptime
            // Compare swap throughout pressure recovery; dropping that history would hide a
            // swap incident while the health gate was closed.
            if recoveringResources || next.pressure != 1 {
                let baseline = resourceSwapBaseline ?? previous.map { ($0.swapins, $0.swapouts) }
                if let baseline {
                    if next.swapins < baseline.0 || next.swapouts < baseline.1 {
                        failed = "host_health_unknown"; return
                    }
                    let swapins = next.swapins - baseline.0
                    let swapouts = next.swapouts - baseline.1
                    if swapins > 0 || swapouts > 0 {
                        resourceSwapBaseline = (next.swapins, next.swapouts)
                        recoveringResources = true
                        previous = nil
                        reportedAt = nil
                        consecutiveSettledSamples = 0
                        current = .init(state: .blocked, reasons: ["swap_activity"],
                                        memoryPressure: next.pressure, swapinsDelta: swapins, swapoutsDelta: swapouts)
                        finishInitialDecision()
                        return
                    }
                }
                resourceSwapBaseline = (next.swapins, next.swapouts)
            }
            // Known pressure refuses immediately but continues read-only sampling. A
            // fresh baseline and two measured quiet intervals are needed to resume.
            if next.pressure != 1 {
                recoveringResources = true
                previous = nil
                reportedAt = nil
                consecutiveSettledSamples = 0
                current = .init(state: .blocked, reasons: ["memory_pressure"], memoryPressure: next.pressure)
                finishInitialDecision()
                return
            }
            if recoveringResources {
                guard let previous else { self.previous = next; return }
                do {
                    let assessment = try DisplayHostHealthSample.assess(previous, next)
                    guard assessment.state == .ready else {
                        failed = assessment.reasons.joined(separator: ","); return
                    }
                    self.previous = next
                    if let cpu = assessment.colorsyncCPUPercent, cpu < Self.reconfigurationCPUThresholdPercent,
                       settlingAfter.map({ previous.uptime > $0 && next.uptime > $0 }) ?? true {
                        consecutiveSettledSamples = min(2, consecutiveSettledSamples + 1)
                    } else { consecutiveSettledSamples = 0 }
                    if consecutiveSettledSamples == 2 {
                        recoveringResources = false
                        resourceSwapBaseline = nil
                        current = assessment
                        reportedAt = next.uptime
                        finishInitialDecision()
                    }
                } catch let error as DisplayHostHealthSample.Unknown {
                    current.unavailableInput = error.reason
                    failed = "host_health_unknown"
                } catch { failed = "host_health_unknown" }
                return
            }
            if let previous {
                do {
                    let assessment = try DisplayHostHealthSample.assess(previous, next)
                    current = assessment
                    reportedAt = next.uptime
                    if assessment.state == .ready, let cpu = assessment.colorsyncCPUPercent,
                       cpu < Self.reconfigurationCPUThresholdPercent,
                       settlingAfter.map({ previous.uptime > $0 && next.uptime > $0 }) ?? true {
                        consecutiveSettledSamples = min(2, consecutiveSettledSamples + 1)
                    } else { consecutiveSettledSamples = 0 }
                    if assessment.state == .blocked,
                       assessment.reasons == ["swap_activity"] {
                        recoveringResources = true
                        resourceSwapBaseline = (next.swapins, next.swapouts)
                        self.previous = nil
                        reportedAt = nil
                        consecutiveSettledSamples = 0
                        current = assessment
                        finishInitialDecision()
                        return
                    }
                    if assessment.state == .blocked {
                        // fail() owns publishing a sticky failure and its notification.
                        current.state = .unknown
                        failed = assessment.reasons.joined(separator: ",")
                    } else { finishInitialDecision() }
                } catch let error as DisplayHostHealthSample.Unknown {
                    current.unavailableInput = error.reason
                    failed = "host_health_unknown"
                } catch { failed = "host_health_unknown" }
            }
            self.previous = next
            if failed != nil { current.memoryPressure = next.pressure }
        }
        if let failed { fail(failed) }
    }

    /// The reserved-testing override waives memory pressure, swap and sticky faults, but not measured ColorSync load (RA-057): every display attachment leaves
    /// macOS polling ColorSync until logout, and diagnostic runs that ignored this load saturated
    /// ColorSync until WindowServer's watchdog ended the login session. A graph change needs a quiet
    /// interval measured entirely after the previous change, and a busy interval needs two quiet ones.
    /// Saturation makes intervals unmeasurable, so once this process has measured one, an
    /// unmeasurable interval never counts as quiet; only a sampler that has never produced a
    /// measurement keeps the override's former admission.
    private func acceptOverride(_ next: DisplayHostHealthSample?) {
        lock.withLock {
            defer { signalReconfigurationWaiters() }
            inFlightSince = nil
            let time = now()
            // Evidence ages from when it was observed, so a late delivery cannot extend it.
            func countQuiet(observedAt: TimeInterval) {
                consecutiveSettledSamples = min(2, consecutiveSettledSamples + 1)
                overrideEvidenceAt = observedAt
            }
            // A capture delivered late describes a host that may have changed since.
            let fresh = next.map { $0.uptime.isFinite && abs(time - $0.uptime) <= 3 } ?? false
            let before = previous
            previous = fresh ? next : nil
            if let next, fresh { lastAttempt = next.uptime }
            guard let next, fresh, let before else {
                // No measurable interval: a failed or late capture, or the first observation.
                if (next == nil || !fresh), !overrideMeasured { countQuiet(observedAt: time) }
                return
            }
            guard let cpu = (try? DisplayHostHealthSample.assess(before, next))?.colorsyncCPUPercent else {
                current.colorsyncCPUPercent = nil
                if !overrideMeasured { countQuiet(observedAt: time) }
                return
            }
            overrideMeasured = true
            current.colorsyncCPUPercent = cpu
            if cpu >= Self.reconfigurationCPUThresholdPercent {
                consecutiveSettledSamples = 0
            } else if settlingAfter.map({ before.uptime > $0 && next.uptime > $0 }) ?? true {
                countQuiet(observedAt: next.uptime)
                if consecutiveSettledSamples == 2 { settlingAfter = nil }
            }
        }
    }

    /// Caller holds the state lock.
    private func settledLocked() -> Bool {
        guard current.state == .ready, consecutiveSettledSamples >= 2 else { return false }
        guard testingOverride else { return true }
        let time = now()
        return overrideEvidenceAt.map { time >= $0 && time - $0 <= 10 } ?? false
    }

    /// Deterministic tests drive a failed capture without a sampler.
    func acceptFailedCaptureForTesting() {
        if testingOverride { acceptOverride(nil) }
    }

    private func finishInitialDecision() {
        if waitingForInitialDecision {
            waitingForInitialDecision = false
            initialDecision.leave()
        }
    }

    private func expireIfNeeded() {
        guard !testingOverride else { return }
        let expired = lock.withLock {
            // A producer may publish a newer observation while a reader waits for this lock.
            // Read the clock with the state so that contention is not mistaken for reversal.
            let time = now()
            return !time.isFinite || (inFlightSince.map { time < $0 || time - $0 > 3 } ?? false)
                || (reportedAt.map { time < $0 || time - $0 > 10 } ?? false)
        }
        if expired { fail("host_health_stale_or_timed_out") }
    }

    private func fail(_ reason: String, unavailableInput: String? = nil) {
        let first = lock.withLock { () -> Bool in
            guard current.state != .blocked || recoveringResources else { return false }
            recoveringResources = false
            resourceSwapBaseline = nil
            current.state = .blocked
            consecutiveSettledSamples = 0
            signalReconfigurationWaiters()
            if let unavailableInput { current.unavailableInput = unavailableInput }
            else if reason != "host_health_unknown" { current.unavailableInput = nil }
            current.reasons = reason.split(separator: ",").map(String.init)
            timer?.cancel()
            timer = nil
            finishInitialDecision()
            return true
        }
        if first {
            let input = lock.withLock { current.unavailableInput }
            onFailure("host health: " + reason + (input.map { " (\($0))" } ?? ""))
        }
    }

    deinit { timer?.cancel() }
}
