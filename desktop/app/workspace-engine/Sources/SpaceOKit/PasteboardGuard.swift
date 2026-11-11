import Foundation
import AppKit

/// Bounded pasteboard snapshot support for tests and diagnostics.
///
/// This is deliberately **not** a production Copy/Cut guard. `NSPasteboard` has no
/// compare-and-swap or transaction primitive, so no snapshot/restore bracket can prove that it
/// is not overwriting a newer user clipboard between its final check and its write. Production
/// input routes therefore refuse Command-C/X/V before posting any event: paste would disclose
/// the user's current clipboard to an agent-controlled application.
public enum PasteboardGuard {

    public struct Limits: Sendable {
        public let maximumItems: Int
        public let maximumTypes: Int
        public let maximumBytesPerValue: Int
        public let maximumTotalBytes: Int
        public let snapshotTimeout: TimeInterval

        public static let boundedDiagnostic = Limits()

        public init(
            maximumItems: Int = 32,
            maximumTypes: Int = 128,
            maximumBytesPerValue: Int = 16 * 1_048_576,
            maximumTotalBytes: Int = 32 * 1_048_576,
            snapshotTimeout: TimeInterval = 0.25
        ) {
            // Hard ceilings prevent a diagnostic caller from turning this utility back into an
            // unbounded pasteboard read.
            self.maximumItems = min(max(maximumItems, 0), 64)
            self.maximumTypes = min(max(maximumTypes, 0), 256)
            self.maximumBytesPerValue =
                min(max(maximumBytesPerValue, 0), 32 * 1_048_576)
            self.maximumTotalBytes =
                min(max(maximumTotalBytes, 0), 64 * 1_048_576)
            guard snapshotTimeout.isFinite else {
                self.snapshotTimeout = 0.25
                return
            }
            self.snapshotTimeout = min(max(snapshotTimeout, 0), 1)
        }
    }

    public enum SnapshotFailure: Equatable, Sendable {
        case tooManyItems(limit: Int)
        case tooManyTypes(limit: Int)
        case valueTooLarge(limit: Int)
        case aggregateTooLarge(limit: Int)
        case valueUnavailable
        case timedOut
        case changedDuringCapture
    }

    public struct Snapshot {
        let items: [[String: Data]]
        let changeCount: Int
        public let failure: SnapshotFailure?

        public var isEmpty: Bool { items.isEmpty }
        public var typeCount: Int { items.reduce(0) { $0 + $1.count } }
        public var isComplete: Bool { failure == nil }
    }

    public static func snapshot() -> Snapshot {
        boundedSnapshot(limits: .boundedDiagnostic) {
            SystemDiagnosticPasteboard(pasteboard: .general)
        }
    }

    public static func snapshot(
        from pasteboard: NSPasteboard,
        limits: Limits = .boundedDiagnostic
    ) -> Snapshot {
        snapshot(from: SystemDiagnosticPasteboard(pasteboard: pasteboard), limits: limits)
    }

    static func snapshot<P: DiagnosticPasteboard>(
        from pasteboard: P, limits: Limits = .boundedDiagnostic
    ) -> Snapshot {
        boundedSnapshot(limits: limits) { pasteboard }
    }

    /// Diagnostic/test helper, never a conditional restore around production input.
    @discardableResult
    public static func restore(_ snapshot: Snapshot) -> Bool {
        guard snapshot.isComplete else { return false }
        return restore(snapshot, to: .general)
    }

    @discardableResult
    public static func restore(_ snapshot: Snapshot, to pasteboard: NSPasteboard) -> Bool {
        restore(snapshot, to: SystemDiagnosticPasteboard(pasteboard: pasteboard))
    }

    @discardableResult
    static func restore<P: DiagnosticPasteboard>(_ snapshot: Snapshot, to pasteboard: P) -> Bool {
        guard snapshot.isComplete else { return false }
        let current = Self.snapshot(from: pasteboard)
        guard current.isComplete, current.items != snapshot.items else { return false }
        return pasteboard.write(snapshot.items)
    }

    /// Internal test/demo convenience only. It deliberately has no production callers.
    static func preserving<T>(
        pasteboard: NSPasteboard = .general, _ body: () throws -> T
    ) rethrows -> T {
        try preserving(pasteboard: SystemDiagnosticPasteboard(pasteboard: pasteboard), body)
    }

    static func preserving<P: DiagnosticPasteboard, T>(
        pasteboard: P, _ body: () throws -> T
    ) rethrows -> T {
        let saved = snapshot(from: pasteboard)
        defer { if saved.isComplete { _ = restore(saved, to: pasteboard) } }
        return try body()
    }

    /// Internal test convenience only. Production Copy/Cut routes fail closed before dispatch.
    static func preserving<T>(_ body: () async throws -> T) async rethrows -> T {
        let saved = snapshot()
        defer { if saved.isComplete { _ = restore(saved) } }
        return try await body()
    }

    // MARK: - Bounded diagnostic capture

    /// AppKit providers are not Sendable. This wrapper transfers the whole read to exactly one
    /// worker; the caller observes only a completed immutable snapshot, never the provider.
    private final class CaptureWork: @unchecked Sendable {
        let operation: () -> Snapshot
        private let lock = NSLock()
        private var result: Snapshot?
        init(operation: @escaping () -> Snapshot) { self.operation = operation }
        func run() { let value = operation(); lock.withLock { result = value } }
        func load() -> Snapshot? { lock.withLock { result } }
    }

    /// A provider that never returns consumes at most one diagnostic worker, including when
    /// opening the pasteboard or reading metadata stalls. Further snapshots fail fast.
    private final class ProviderReadGate: @unchecked Sendable {
        private let lock = NSLock()
        private var readInFlight = false
        func acquire() -> Bool {
            lock.withLock {
                guard !readInFlight else { return false }
                readInFlight = true
                return true
            }
        }
        func release() { lock.withLock { readInFlight = false } }
    }
    private static let providerReadGate = ProviderReadGate()

    static func boundedSnapshot<P: DiagnosticPasteboard>(
        limits: Limits, provider: @escaping () -> P
    ) -> Snapshot {
        let timedOut = Snapshot(items: [], changeCount: 0, failure: .timedOut)
        guard limits.snapshotTimeout > 0, providerReadGate.acquire() else { return timedOut }
        let deadline = DispatchTime.now()
            + .nanoseconds(Int(limits.snapshotTimeout * 1_000_000_000))
        let completed = DispatchSemaphore(value: 0)
        let work = CaptureWork {
            guard DispatchTime.now() < deadline else { return timedOut }
            return capture(from: provider(), limits: limits, deadline: deadline)
        }
        DispatchQueue.global(qos: .userInitiated).async {
            autoreleasepool { work.run() }
            providerReadGate.release()
            completed.signal()
        }
        guard completed.wait(timeout: deadline) == .success,
              DispatchTime.now() < deadline else { return timedOut }
        return work.load() ?? timedOut
    }

    private static func capture<P: DiagnosticPasteboard>(
        from pasteboard: P, limits: Limits, deadline: DispatchTime
    ) -> Snapshot {
        var changeCount = 0
        func failure(_ reason: SnapshotFailure) -> Snapshot {
            Snapshot(items: [], changeCount: changeCount, failure: reason)
        }
        guard DispatchTime.now() < deadline else { return failure(.timedOut) }
        changeCount = pasteboard.changeCount
        guard DispatchTime.now() < deadline else { return failure(.timedOut) }
        let items = pasteboard.items
        guard DispatchTime.now() < deadline else { return failure(.timedOut) }
        guard items.count <= limits.maximumItems else {
            return failure(.tooManyItems(limit: limits.maximumItems))
        }
        var captured: [[String: Data]] = []
        captured.reserveCapacity(items.count)
        var typeCount = 0
        var totalBytes = 0
        for item in items {
            guard DispatchTime.now() < deadline else { return failure(.timedOut) }
            let types = item.types
            guard DispatchTime.now() < deadline else { return failure(.timedOut) }
            guard types.count <= limits.maximumTypes - typeCount else {
                return failure(.tooManyTypes(limit: limits.maximumTypes))
            }
            typeCount += types.count
            var payload: [String: Data] = [:]
            payload.reserveCapacity(types.count)
            for type in types {
                guard DispatchTime.now() < deadline else { return failure(.timedOut) }
                let value = item.data(forType: type)
                guard DispatchTime.now() < deadline else { return failure(.timedOut) }
                guard let data = value else { return failure(.valueUnavailable) }
                // Providers materialize a value atomically: this bounds retention, not their
                // transient allocation. The deadline bounds the caller, not the provider call.
                guard data.count <= limits.maximumBytesPerValue else {
                    return failure(.valueTooLarge(limit: limits.maximumBytesPerValue))
                }
                guard data.count <= limits.maximumTotalBytes - totalBytes else {
                    return failure(.aggregateTooLarge(limit: limits.maximumTotalBytes))
                }
                totalBytes += data.count
                payload[type] = data
            }
            captured.append(payload)
        }
        let finalChangeCount = pasteboard.changeCount
        guard DispatchTime.now() < deadline else { return failure(.timedOut) }
        guard finalChangeCount == changeCount else {
            changeCount = finalChangeCount
            return failure(.changedDuringCapture)
        }
        return Snapshot(items: captured, changeCount: finalChangeCount, failure: nil)
    }
}
