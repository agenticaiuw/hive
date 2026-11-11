import Foundation

/// Cancellation ends launch work, but does not erase its cleanup responsibility. Await an
/// independent task so its sleeps remain effective while the caller keeps lifecycle authority.
enum LaunchFailureCleanup {
    enum Liveness { case alive, exited, unknown }

    struct Driver: Sendable {
        let currentIdentity: @Sendable (pid_t) -> ProcessIdentity?
        let quit: @Sendable (LaunchedApp, Bool) -> Void
        let cleanupResources: @Sendable (LaunchedApp) -> Void

        static let live = Driver(currentIdentity: { ProcessIdentity.current(of: $0) },
            quit: { AppLauncher.quit($0, force: $1) },
            cleanupResources: { AppLauncher.cleanupTemporaryProfileEventually(for: $0) })
    }

    static func liveness(_ identity: ProcessIdentity, driver: Driver) -> Liveness {
        guard let current = driver.currentIdentity(identity.pid) else { return .exited }
        guard identity.isPrecise, current.isPrecise else { return .unknown }
        return current == identity ? .alive : .exited
    }

    static func run(_ app: LaunchedApp, driver: Driver = .live,
                    runtime: WaitRuntime = .live) async {
        await Task.detached {
            defer { driver.cleanupResources(app) }
            guard app.startedByUs else { return }
            if liveness(app.identity, driver: driver) == .alive { driver.quit(app, false) }
            let exited = (try? await BridgeReadiness.wait(timeout: 2, interval: 0.1, runtime: runtime) {
                liveness(app.identity, driver: driver) == .exited
            }) ?? false
            guard !exited else { return }
            // Repeat the exact-identity check at escalation. Missing precision never grants
            // permission to terminate, and PID reuse ends the wait for our original process.
            let beforeForce = liveness(app.identity, driver: driver)
            guard beforeForce != .exited else { return }
            if beforeForce == .alive { driver.quit(app, true) }
            _ = try? await BridgeReadiness.wait(timeout: 2, interval: 0.1, runtime: runtime) {
                liveness(app.identity, driver: driver) == .exited
            }
        }.value
    }
}
