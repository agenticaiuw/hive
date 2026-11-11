import Foundation

/// Native capture may ignore cancellation. Its resources remain quarantined after the caller
/// returns, without making teardown wait on an uncooperative native callback.
final class SessionCaptureWork: @unchecked Sendable {
    final class Lease: @unchecked Sendable {
        private let lock = NSLock()
        private var owner: SessionCaptureWork?
        fileprivate init(owner: SessionCaptureWork) { self.owner = owner }
        func finish() {
            let previous = lock.withLock { () -> SessionCaptureWork? in
                defer { owner = nil }
                return owner
            }
            previous?.finish()
        }
        deinit { finish() }
    }

    private let lock = NSLock()
    private var pending = 0
    private var deferredTeardown = false

    /// Admission must hold the session lifecycle lease; teardown then cannot pass its fence
    /// between checking session availability and registering this outstanding native work.
    func begin() -> Lease {
        lock.withLock { pending += 1 }
        return Lease(owner: self)
    }

    private func finish() { lock.withLock { pending -= 1 } }
    var isQuiescent: Bool { lock.withLock { pending == 0 } }
    var cleanupPending: Bool { lock.withLock { deferredTeardown } }

    /// Keep cleanup pending even after the callback returns, until teardown actually retries.
    func prepareForTeardown() -> Bool {
        lock.withLock {
            deferredTeardown = pending != 0
            return !deferredTeardown
        }
    }
}
