import Foundation
import AppKit
import ApplicationServices
import CoreGraphics
import Darwin

/// Private, per-launch control endpoint for a VS Code-family Electron renderer.
///
/// The token is intentionally live-memory-only. The root is persisted separately so crash
/// recovery can remove it after terminating an owned survivor without writing the credential
/// to the session journal.
public struct ElectronControlEndpoint: Sendable, Equatable {
    public let socket: URL
    public let token: String
}

/// An application SpaceO started (or adopted) on behalf of an agent.
public struct LaunchedApp: Sendable, Equatable {
    public let pid: pid_t
    /// PID plus kernel start time. Every action that could disturb a process — force-terminate,
    /// capture, input delivery — checks this rather than the PID alone, so a session that
    /// outlived its app cannot act on whatever inherited its number.
    public let identity: ProcessIdentity
    public let bundleIdentifier: String?
    public let name: String
    public let url: URL
    /// False when SpaceO adopted an already-running app rather than starting it.
    public let startedByUs: Bool
    /// DevTools port, for Chromium browsers SpaceO launched itself. Synthetic input cannot
    /// reach Chromium web content, so this is the only way to click a page. An adopted
    /// browser has none, because the port can only be set at launch.
    public var devToolsPort: Int?
    /// Private Chromium profile created for this app. Removed after the process exits.
    public var temporaryProfile: URL?
    /// Semantic renderer channel for a VS Code-family Electron app SpaceO launched.
    public var electronControl: ElectronControlEndpoint? = nil
    /// Private extension/socket root. Unlike the token, this is safe to persist for cleanup.
    public var temporaryControlRoot: URL? = nil
}

/// Starts applications without activating them.
///
/// `activates = false` keeps the menu bar with the user. Launching hidden lets SpaceO relocate
/// the first window before revealing it, so the initial document does not flash on a physical
/// monitor while Accessibility placement catches up.
public enum AppLauncher {

    private struct PreparedElectronControl {
        let root: URL
        let extensionsDirectory: URL
        let endpoint: ElectronControlEndpoint
    }

    /// Launch `appURL` (optionally opening `files`) and place all its windows in `region`.
    ///
    /// Requests a separate process and **refuses** application substitution. If macOS hands back
    /// a process that was already running, that process belongs to the user: relocating its
    /// windows would be SpaceO rearranging someone's desktop, which is the one thing this project
    /// promises not to do. The launch fails instead, before anything moves.
    public nonisolated(nonsending) static func launch(
        appURL: URL,
        opening files: [URL] = [],
        into region: CGRect,
        timeout: TimeInterval = 15,
        allowNoWindows: Bool = false,
        arguments: [String] = [],
        muteAudio: Bool = false,
        onMaterialized: (LaunchedApp) async throws -> Void = { _ in }
    ) async throws -> (app: LaunchedApp, windows: [WindowRef]) {

        guard timeout.isFinite, (0.5...120).contains(timeout) else {
            throw SpaceOError.badRequest(
                "launch timeout must be a finite value from 0.5 through 120 seconds")
        }
        try LaunchOptions.validate(arguments: arguments, timeout: timeout)
        try Task.checkCancellation()
        try WindowPlacement.validate(frame: region)
        guard appURL.path.utf8.count <= 16_384, appURL.path.count <= 4_096 else {
            throw SpaceOError.badRequest(
                "application path must be at most 4096 characters and 16384 UTF-8 bytes")
        }
        guard files.count <= 256,
              files.allSatisfy({
                  $0.path.utf8.count <= 16_384 && $0.path.count <= 4_096
              }) else {
            throw SpaceOError.badRequest(
                "launch accepts at most 256 files, each at most 4096 characters "
                + "and 16384 UTF-8 bytes")
        }
        guard FileManager.default.fileExists(atPath: appURL.path) else {
            throw SpaceOError.launchFailed("no such application: \(appURL.path)")
        }

        let chromium = isChromiumFamily(appURL)
        guard !isElectronFamily(appURL) else {
            throw SpaceOError.unsupportedTarget(
                "managed Electron launches are unavailable in this preview because startup can take desktop focus; use a native app or Chromium browser")
        }
        try WindowPlacement.requireAccessibility()
        let electron = !chromium && isVSCodeElectronFamily(appURL)
        // Reject incompatible options before creating private directories or copying adapters.
        // Bundle classification is stable for this launch; do not repeat its filesystem reads.
        if muteAudio, !chromium {
            throw SpaceOError.badRequest(
                "mute_audio is available only for a managed Chromium launch; other apps cannot be muted per process")
        }
        if !arguments.isEmpty, chromium || electron {
            throw SpaceOError.badRequest("custom arguments are unsupported for managed browser/Electron launches")
        }

        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = false
        configuration.addsToRecentItems = false
        // Apple documents this as hiding the app immediately after launch. Windows still exist
        // for Accessibility placement, but are not shown on the user's monitor while we move
        // them onto the stage. Apps can unhide themselves; Chromium uses explicit background
        // page creation below, and all apps are rechecked after deliberate reveal.
        configuration.hides = true
        configuration.promptsUserIfNeeded = false
        configuration.createsNewApplicationInstance = true
        configuration.allowsRunningApplicationSubstitution = false

        // A Chromium browser needs a DevTools port to be driveable at all (synthetic input does
        // not reach its web content), and a port can only be set at launch. Giving it a private
        // profile at the same time is not incidental: it forces a genuinely separate instance
        // so we are not attaching to — or disturbing — the user's own browser and its cookies.
        var temporaryProfile: URL?
        var electronControl: ElectronControlEndpoint?
        var temporaryControlRoot: URL?
        var opensFilesWithoutWorkspace = false
        if chromium {
            let profile = FileManager.default.temporaryDirectory
                .appendingPathComponent("spaceo-browser-\(getpid())-\(UUID().uuidString)",
                                        isDirectory: true)
            do {
                try FileManager.default.createDirectory(
                    at: profile,
                    withIntermediateDirectories: false,
                    attributes: [.posixPermissions: 0o700])
            } catch {
                throw SpaceOError.launchFailed(
                    "could not create a private browser profile: \(error.localizedDescription)")
            }
            configuration.arguments = [
                // Port zero makes Chromium bind its own socket atomically. Reserving a "free"
                // port and closing it before launch leaves a race in which another process can
                // claim the port and impersonate the DevTools endpoint.
                "--remote-debugging-port=0",
                "--remote-debugging-address=127.0.0.1",
                "--user-data-dir=\(profile.path)",
                "--no-first-run",
                "--no-default-browser-check",
                "--disable-session-crashed-bubble",
                // Create pages through CDP with background=true; a normal first window
                // can activate Chrome despite LaunchServices activates=false.
                "--no-startup-window",
            ]
            // The one attention leak SpaceO can close without touching the app: a managed
            // browser's audio. `--mute-audio` is a supported Chromium switch and only ever
            // applies to the private-profile instance SpaceO itself launched.
            if muteAudio { configuration.arguments.append("--mute-audio") }
            temporaryProfile = profile
            opensFilesWithoutWorkspace = true
        } else if electron {
            let prepared: PreparedElectronControl
            do {
                prepared = try prepareElectronControl()
            } catch {
                throw SpaceOError.launchFailed(
                    "could not prepare the private Electron controller: "
                        + error.localizedDescription)
            }
            // VS Code-family shells do not reliably consume LaunchServices' open-document
            // event when a brand-new application instance starts in its agent/home surface.
            // The process then materializes a healthy editor-sized window while silently
            // ignoring every requested file. Their CLI positional-file channel is the supported
            // route for this launch shape, so carry the absolute paths on the initial command
            // line and force a document window instead of accepting the persisted start screen.
            configuration.arguments = electronLaunchArguments(
                extensionsDirectory: prepared.extensionsDirectory,
                opening: files)
            opensFilesWithoutWorkspace = !files.isEmpty
            configuration.environment = electronLaunchEnvironment(
                ProcessInfo.processInfo.environment, endpoint: prepared.endpoint)
            electronControl = prepared.endpoint
            temporaryControlRoot = prepared.root
        }

        if !arguments.isEmpty {
            configuration.arguments = arguments
        } else if !chromium, !electron, acceptsDefaultsArguments(appURL) {
            configuration.arguments = cleanSlateArguments(openingFiles: !files.isEmpty)
        }

        // Two independent tests for "this process is not ours", because the PID snapshot alone
        // has a time-of-check/time-of-use hole: a user process that opens between the snapshot
        // and `openApplication` is absent from `existing` and would be misread as ours. A start
        // time from before we asked cannot be a process our request created, whatever the
        // snapshot says.
        let existing = runningInstances(of: appURL)
        let requestedAtMicroseconds = UInt64(max(0, Date().timeIntervalSince1970 * 1_000_000))
        let runningApp: NSRunningApplication
        do {
            try Task.checkCancellation()
            if files.isEmpty || opensFilesWithoutWorkspace {
                runningApp = try await NSWorkspace.shared.openApplication(at: appURL,
                                                                          configuration: configuration)
            } else {
                runningApp = try await NSWorkspace.shared.open(files,
                                                               withApplicationAt: appURL,
                                                               configuration: configuration)
            }
        } catch {
            removeTemporaryProfile(at: temporaryProfile)
            removeTemporaryControlRoot(at: temporaryControlRoot)
            if error is CancellationError { throw error }
            throw SpaceOError.launchFailed("\(appURL.lastPathComponent): \(error.localizedDescription)")
        }

        let pid = runningApp.processIdentifier
        guard let identity = ProcessIdentity.current(of: pid) else {
            removeTemporaryProfile(at: temporaryProfile)
            removeTemporaryControlRoot(at: temporaryControlRoot)
            throw SpaceOError.launchFailed(
                "\(appURL.lastPathComponent) exited before SpaceO could identify it")
        }

        // Refuse the substituted process. Note the asymmetry in how the two signals are combined:
        // a *precise* start time predating the request is proof of a pre-existing process, while
        // an imprecise one can only fall back to the racy snapshot. Either says "not ours".
        let predatesRequest = identity.isPrecise
            && identity.startedAtMicroseconds < requestedAtMicroseconds
        if existing.contains(pid) || predatesRequest {
            removeTemporaryProfile(at: temporaryProfile)
            removeTemporaryControlRoot(at: temporaryControlRoot)
            throw SpaceOError.launchFailed(
                "\(appURL.lastPathComponent) is already running as pid \(pid); macOS reused that "
                + "process instead of starting a new one. SpaceO will not move a running app's "
                + "windows — quit it first, or adopt it deliberately "
                + "(spaceo_adopt_app / spaceo adopt --pid \(pid))")
        }

        var app = LaunchedApp(
            pid: pid,
            identity: identity,
            bundleIdentifier: runningApp.bundleIdentifier,
            name: runningApp.localizedName
                ?? appURL.deletingPathExtension().lastPathComponent,
            url: appURL,
            startedByUs: true,
            devToolsPort: nil,
            temporaryProfile: temporaryProfile,
            electronControl: electronControl,
            temporaryControlRoot: temporaryControlRoot)

        var launchPhase = LaunchPhase.materialization
        do {
            // This callback is the WAL commit boundary. It runs immediately after SpaceO has an
            // exact process identity, before DevTools discovery, window waits, placement, or any
            // other potentially long operation. The session claims/registers the process and
            // the daemon persists that identity before launch work may continue.
            try await onMaterialized(app)
            try Task.checkCancellation()

            launchPhase = .containment
            return try await withStartupContainment(install: {
                guard chromium else { return {} }
                // A Chromium derivative may ignore --no-startup-window. Install both AX
                // notifications and the periodic backstop before waiting on its endpoint.
                // If containment cannot start, fail before spending the DevTools budget.
                let watcher = try WindowWatcher(pid: pid, region: { region })
                watcher.sweep()
                return { watcher.stop() }
            }, operation: {
                if let profile = temporaryProfile {
                    launchPhase = .browserReadiness
                    let startupBudget = try DevToolsDeadline(timeout: min(timeout, 10))
                    guard let port = try await waitForDevToolsPort(in: profile,
                        timeout: try startupBudget.remaining(), validate: {
                            guard identity.isAlive else {
                                throw SpaceOError.applicationExited("browser exited during startup")
                            }
                        }) else {
                        throw SpaceOError.launchFailed("browser did not publish its private DevTools endpoint")
                    }
                    app.devToolsPort = port
                    let startup = ChromiumBridge(port: port)
                    try await startup.createBackgroundPages(files: files, region: region,
                        timeout: try startupBudget.remaining(), validate: {
                            guard identity.isAlive else {
                                throw SpaceOError.applicationExited("browser exited during startup")
                            }
                        })
                }

                // `hides` is advisory — Apple explicitly allows an application to unhide itself,
                // and TextEdit's separate-instance launch never reports hidden at all. Do not burn
                // slow browser/controller readiness windows while an ordinary first window could be
                // sitting on the user's display. Detect it at high frequency and place it first.
                launchPhase = .windowReadiness
                if allowNoWindows, try !WindowPlacement.hasWindows(of: app.pid) {
                    try Task.checkCancellation()
                    guard app.identity.isAlive else { throw SpaceOError.applicationExited("launched process exited") }
                    _ = runningApp.unhide()
                    try Task.checkCancellation()
                    return (app, [])
                }
                try await WindowPlacement.waitForWindowPresence(
                    of: app.pid,
                    timeout: timeout,
                    pollNanoseconds: 25_000_000)
                try Task.checkCancellation()
                launchPhase = .initialPlacement
                _ = try WindowPlacement.placeAll(of: app.pid, into: region)

                // Chromium already has startup containment. Cover native restore prompts before
                // settle delays; the session installs its long-lived watcher on return.
                let revealWatcher: WindowWatcher? = chromium ? nil : (try? WindowWatcher(
                    pid: app.pid,
                    region: { region },
                    periodicSweep: false))
                defer { revealWatcher?.stop() }

                // Settle and re-verify: some apps resize or add restore UI shortly after the first
                // window. A best-effort watcher handles notifications during the wait; the full
                // placement pass is authoritative even if AXObserver registration was not ready.
                try await Task.sleep(nanoseconds: 300_000_000)
                try Task.checkCancellation()
                revealWatcher?.sweep()
                launchPhase = .settledPlacement
                _ = try WindowPlacement.placeAll(of: app.pid, into: region)

                launchPhase = .reveal
                try await reveal(name: app.name, validate: {
                    guard app.identity.isAlive else {
                        throw SpaceOError.applicationExited("launched process exited")
                    }
                }, isHidden: { remaining in
                    let budget = try AXTraversalBudget(
                        limits: AXWindowDiscovery.limits(remaining: remaining),
                        now: { DispatchTime.now().uptimeNanoseconds }, isCancelled: { Task.isCancelled })
                    let element = AX.application(app.pid)
                    let provider = SystemAXTraversalProvider()
                    return try AXTraversal.boundedCall(element, provider: provider, budget: budget) {
                        provider.bool(element, attribute: kAXHiddenAttribute as String)
                    }
                }, unhide: { _ = runningApp.unhide() })
                try await Task.sleep(nanoseconds: 150_000_000)
                try Task.checkCancellation()
                revealWatcher?.sweep()
                // Revealing can rebuild the app's AX window tree. Wait for a complete readable
                // list before the final placement; retry observations, never partial moves.
                launchPhase = .revealedReadiness
                _ = try await waitForRevealedWindow(timeout: timeout) { budget in
                    try await WindowPlacement.waitForWindow(of: app.pid,
                        timeout: budget, pollNanoseconds: 25_000_000)
                }
                launchPhase = .revealedPlacement
                let placed = try WindowPlacement.placeAll(of: app.pid, into: region)
                try Task.checkCancellation()
                return (app, placed)
            })
        } catch {
            // Cleanup can retain/suspend a display owner before XCTest reports its error.
            // Preserve attribution first, without application names or provider text.
            let fields = launchFailureFields(error, phase: launchPhase,
                health: Stage.runtimeHostHealthReport().state)
            if ProcessInfo.processInfo.environment["SPACEO_LIVE_TESTS"] == "1",
               var data = try? JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys]) {
                data.append(0x0A)
                FileHandle.standardError.write(data)
            }
            await LaunchFailureCleanup.run(app)
            DaemonLog.shared.event("app.launch.failed", fields)
            throw launchFailure(error, application: app.name, phase: launchPhase)
        }
    }

    /// Keep the caller's readiness budget after reveal; some apps rebuild their AX tree slowly.
    static func waitForRevealedWindow<T>(timeout: TimeInterval,
        wait: (TimeInterval) async throws -> T) async throws -> T {
        try await wait(timeout)
    }

    /// Keep startup containment active across every readiness await and stop it on all exits.
    /// Installation must succeed before any browser discovery or page creation can begin.
    static func withStartupContainment<T>(
        install: () throws -> () -> Void,
        operation: () async throws -> T
    ) async throws -> T {
        try Task.checkCancellation()
        let stop = try install()
        defer { stop() }
        try Task.checkCancellation()
        return try await operation()
    }

    enum LaunchPhase: String, CaseIterable {
        case materialization, containment
        case browserReadiness = "browser readiness"
        case windowReadiness = "window readiness"
        case initialPlacement = "initial placement"
        case settledPlacement = "settled placement"
        case reveal
        case revealedReadiness = "post-reveal window readiness"
        case revealedPlacement = "post-reveal placement"
    }

    static func launchFailureFields(_ error: Error, phase: LaunchPhase,
                                    health: DisplaySafetyStatus.State) -> [String: String] {
        let code: String
        switch error {
        case let error as SpaceOError: code = error.code
        case let error as AXTraversalStopped: code = "ax_" + error.reason.rawValue
        case is DevToolsDeadline.Exceeded: code = "devtools_deadline"
        case is CancellationError: code = "cancelled"
        default: code = "unclassified_error"
        }
        return ["event": "app.launch.failed", "phase": phase.rawValue,
                "errorCode": code, "hostHealthState": health.rawValue]
    }

    static func launchFailure(_ error: Error, application: String, phase: LaunchPhase? = nil) -> Error {
        if let stopped = error as? AXTraversalStopped, let phase {
            return AXTraversalStopped(reason: stopped.reason,
                detail: "launch \(phase.rawValue): \(stopped.detail)")
        }
        guard error is DevToolsDeadline.Exceeded else { return error }
        return SpaceOError.launchFailed(
            "\(application) timed out preparing its private DevTools endpoint or background page")
    }

    static func electronLaunchEnvironment(_ parent: [String: String],
                                          endpoint: ElectronControlEndpoint) -> [String: String] {
        var environment = parent
        // OpenConfiguration overlays inherited variables; omission does not clear Node mode.
        // Electron's macOS entry point treats an empty value as off.
        environment["ELECTRON_RUN_AS_NODE"] = ""
        environment[ElectronControlAssets.socketEnvironmentKey] = endpoint.socket.path
        environment[ElectronControlAssets.tokenEnvironmentKey] = endpoint.token
        return environment
    }

    static func electronLaunchArguments(
        extensionsDirectory: URL,
        opening files: [URL]
    ) -> [String] {
        // A custom extensions directory is not enough when the app reuses its default profile:
        // recent Cursor builds keep the profile's existing extensions manifest and never
        // register an unpacked adapter that appeared only for this process. The explicit
        // development-extension path is the VS Code launch channel for one unpacked extension;
        // it does not install the adapter or modify the user's profile manifest.
        let adapter = extensionsDirectory.appendingPathComponent(
            ElectronControlAssets.extensionDirectoryName,
            isDirectory: true)
        var arguments = [
            "--extensions-dir=\(extensionsDirectory.path)",
            "--extensionDevelopmentPath=\(adapter.path)",
        ]
        guard !files.isEmpty else { return arguments }
        arguments.append("--new-window")
        // `URL.path` is absolute for every file accepted by the tool boundary, so even a file
        // whose basename begins with '-' cannot be parsed as an option by the Electron CLI.
        arguments.append(contentsOf: files.map(\.path))
        return arguments
    }

    /// Describe an already-running process well enough to claim it, without touching it.
    ///
    /// Separate from `adopt` so a caller can take exclusive ownership *before* the first window
    /// moves. Adoption that mutates first and checks afterwards is how two sessions ended up
    /// fighting over one process.
    public static func describe(pid: pid_t) throws -> LaunchedApp {
        guard pid > 0 else {
            throw SpaceOError.badRequest("adopt needs a positive pid")
        }
        guard let running = NSRunningApplication(processIdentifier: pid),
              let identity = ProcessIdentity.current(of: pid) else {
            throw SpaceOError.applicationExited("no running application with pid \(pid)")
        }
        return LaunchedApp(pid: pid,
                           identity: identity,
                           bundleIdentifier: running.bundleIdentifier,
                           name: running.localizedName ?? "pid \(pid)",
                           url: running.bundleURL ?? URL(fileURLWithPath: "/"),
                           startedByUs: false,
                           devToolsPort: nil,
                           temporaryProfile: nil)
    }

    public static func place(_ app: LaunchedApp, into region: CGRect) throws -> [WindowRef] {
        try WindowPlacement.requireAccessibility()
        try WindowPlacement.validate(frame: region)
        guard app.identity.isAlive else {
            throw SpaceOError.launchFailed(
                "\(app.name) (\(app.identity)) exited before its windows could be placed")
        }
        return try WindowPlacement.placeAll(of: app.pid, into: region)
    }

    public static func adopt(pid: pid_t, into region: CGRect) throws -> (app: LaunchedApp, windows: [WindowRef]) {
        try WindowPlacement.validate(frame: region)
        let app = try describe(pid: pid)
        return (app, try place(app, into: region))
    }

    /// Ask an app to quit politely. Never force-kills apps we did not start.
    ///
    /// Both branches re-check the identity first: a session that has been alive for hours may be
    /// holding a PID the kernel has since handed to something the user cares about, and
    /// "terminate whatever has this number now" is not a teardown, it is a bug with a body count.
    public static func quit(_ app: LaunchedApp, force: Bool = false) {
        guard app.identity.isAlive,
              let running = NSRunningApplication(processIdentifier: app.pid) else { return }
        if force && app.startedByUs && app.identity.isPrecise {
            running.forceTerminate()
        } else {
            running.terminate()
        }
    }

    /// Remove private browser/Electron control resources after the process is gone.
    ///
    /// The parent and prefix checks are deliberate: cleanup must never turn an unexpected path
    /// into a recursive delete outside SpaceO's own temporary directory.
    @discardableResult
    public static func cleanupTemporaryProfile(for app: LaunchedApp) -> Bool {
        guard !app.identity.isAlive else { return false }
        let removedProfile = removeTemporaryProfile(at: app.temporaryProfile)
        let removedControl = removeTemporaryControlRoot(at: app.temporaryControlRoot)
        return removedProfile && removedControl
    }

    /// A force-termination request is asynchronous. Retain cleanup responsibility briefly
    /// instead of deleting live process state or forgetting private directories forever.
    public static func cleanupTemporaryProfileEventually(for app: LaunchedApp) {
        guard app.temporaryProfile != nil || app.temporaryControlRoot != nil else { return }
        guard !cleanupTemporaryProfile(for: app) else { return }
        scheduleTemporaryResourceCleanup(
            identity: app.identity,
            profile: app.temporaryProfile,
            controlRoot: app.temporaryControlRoot)
    }

    private static func scheduleTemporaryResourceCleanup(
        identity: ProcessIdentity,
        profile: URL?,
        controlRoot: URL?
    ) {
        Task.detached(priority: .utility) {
            for _ in 0..<300 {
                guard identity.isAlive else {
                    _ = removeTemporaryProfile(at: profile)
                    _ = removeTemporaryControlRoot(at: controlRoot)
                    return
                }
                try? await Task.sleep(nanoseconds: 200_000_000)
            }
        }
    }

    @discardableResult
    private static func removeTemporaryProfile(at candidate: URL?) -> Bool {
        guard let candidate else { return true }
        let profile = candidate.standardizedFileURL
        let temporary = FileManager.default.temporaryDirectory.standardizedFileURL
        guard profile.deletingLastPathComponent() == temporary,
              profile.lastPathComponent.hasPrefix("spaceo-browser-") else {
            return false
        }
        guard FileManager.default.fileExists(atPath: profile.path) else { return true }
        do {
            try FileManager.default.removeItem(at: profile)
            return true
        } catch {
            return false
        }
    }

    @discardableResult
    static func removeTemporaryControlRoot(at candidate: URL?) -> Bool {
        guard let candidate else { return true }
        let root = candidate.standardizedFileURL
        let temporary = URL(fileURLWithPath: "/tmp", isDirectory: true)
            .standardizedFileURL
        guard root.deletingLastPathComponent() == temporary,
              root.lastPathComponent.hasPrefix("spaceo-e-") else {
            return false
        }
        guard FileManager.default.fileExists(atPath: root.path) else { return true }
        do {
            try FileManager.default.removeItem(at: root)
            return true
        } catch {
            return false
        }
    }

    static func devToolsPort(in profile: URL) -> Int? {
        let marker = profile.appendingPathComponent("DevToolsActivePort")
        // A provider-written marker must not turn polling into a whole-file allocation or a
        // blocking FIFO open. Check the opened descriptor and also cap the read if it grows.
        let fd = Darwin.open(marker.path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK)
        guard fd >= 0 else { return nil }
        defer { Darwin.close(fd) }
        var info = stat()
        guard fstat(fd, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG,
              info.st_size > 0, info.st_size <= 4_096 else { return nil }
        var bytes = [UInt8](repeating: 0, count: 4_097)
        let count = bytes.withUnsafeMutableBytes { Darwin.read(fd, $0.baseAddress, $0.count) }
        guard count > 0, count <= 4_096,
              let newline = bytes[..<count].firstIndex(of: 10) else { return nil }
        let end = newline > 0 && bytes[newline - 1] == 13 ? newline - 1 : newline
        guard (1...5).contains(end) else { return nil }
        var port = 0
        for byte in bytes[..<end] {
            guard (48...57).contains(byte) else { return nil }
            port = port * 10 + Int(byte - 48)
        }
        return (1...65_535).contains(port) ? port : nil
    }

    static func waitForDevToolsPort(
        in profile: URL,
        timeout: TimeInterval,
        runtime: WaitRuntime = .live,
        validate: () throws -> Void = {}
    ) async throws -> Int? {
        var port: Int?
        let ready = try await BridgeReadiness.wait(timeout: timeout, interval: 0.1,
            runtime: runtime, validate: validate) {
                port = devToolsPort(in: profile)
                return port != nil
            }
        return ready ? port : nil
    }

    static func reveal(name: String, runtime: WaitRuntime = .live,
                       validate: () throws -> Void,
                       isHidden: (TimeInterval) throws -> Bool?, unhide: () -> Void) async throws {
        // NSRunningApplication.isHidden is cached until the main run loop advances. A stale
        // false value can skip unhide entirely. Callers must provide a fresh, bounded read;
        // neither an unknown observation nor an unhide return value confirms visibility.
        let deadline = runtime.now().addingTimeInterval(1)
        func hidden() throws -> Bool? {
            let remaining = deadline.timeIntervalSince(runtime.now())
            guard remaining >= 0.01 else { return nil }
            return try isHidden(remaining)
        }
        let revealed = try await BridgeReadiness.wait(timeout: 1, interval: 0.025,
            runtime: runtime, validate: validate) {
                guard let before = try hidden() else { return false }
                if !before { return true }
                try Task.checkCancellation()
                try validate()
                guard runtime.now() < deadline else { return false }
                unhide()
                return try hidden() == false
            }
        guard revealed else {
            throw SpaceOError.launchFailed("\(name) could not be revealed after its windows were placed")
        }
    }

    /// Resolve a user-supplied string to an app bundle: a path, or a name like "TextEdit".
    public static func resolve(_ nameOrPath: String) -> URL? {
        let asPath = URL(fileURLWithPath: (nameOrPath as NSString).expandingTildeInPath)
        if FileManager.default.fileExists(atPath: asPath.path), asPath.pathExtension == "app" {
            return asPath
        }
        if let byID = NSWorkspace.shared.urlForApplication(withBundleIdentifier: nameOrPath) {
            return byID
        }
        let bare = nameOrPath.hasSuffix(".app") ? nameOrPath : nameOrPath + ".app"
        for directory in ["/System/Applications", "/Applications",
                          "/System/Applications/Utilities", "/Applications/Utilities",
                          NSHomeDirectory() + "/Applications"] {
            let candidate = URL(fileURLWithPath: directory).appendingPathComponent(bare)
            if FileManager.default.fileExists(atPath: candidate.path) { return candidate }
        }
        // Display names and loose spellings ("google chrome", "Photoshop 2024" in a vendor
        // folder). Only reached when every exact spelling missed.
        guard !nameOrPath.contains("/") else { return nil }
        return AppNameCatalog.match(nameOrPath, in: AppNameCatalog.cachedEntries())
    }

    /// Up to three installed app names close to one that `resolve` could not find, so the
    /// refusal can say "did you mean" instead of leaving the caller to guess.
    public static func suggestions(for name: String) -> [String] {
        guard !name.contains("/") else { return [] }
        return AppNameCatalog.suggestions(for: name, in: AppNameCatalog.cachedEntries())
    }

    /// Reopening a managed browser must use its private background-target endpoint. Never
    /// fall back to LaunchServices when that endpoint is missing or an Electron app is reused.
    static func reusedBrowserPort(appURL: URL, devToolsPort: Int?) throws -> Int? {
        guard !isElectronFamily(appURL) else {
            throw SpaceOError.launchFailed("managed Electron file opens are unavailable in this preview")
        }
        guard isChromiumFamily(appURL) else { return nil }
        guard let port = devToolsPort, (1...65_535).contains(port) else {
            throw SpaceOError.launchFailed("reused Chromium has no private DevTools endpoint; file open refused")
        }
        return port
    }

    /// Is this bundle a Chromium derivative? Read from the bundle rather than a name list,
    /// so forks we have never heard of are still handled correctly.
    public static func isChromiumFamily(_ appURL: URL) -> Bool {
        guard let bundle = Bundle(url: appURL) else { return false }
        let identifier = bundle.bundleIdentifier ?? ""
        let known = ["com.google.Chrome", "org.chromium.Chromium", "com.microsoft.edgemac",
                     "com.brave.Browser", "com.vivaldi.Vivaldi", "com.operasoftware.Opera",
                     "company.thebrowser.Browser"]
        if known.contains(where: { identifier.hasPrefix($0) }) { return true }
        // Every Chromium build ships this helper alongside the main executable.
        let helper = appURL.appendingPathComponent("Contents/Frameworks")
        if let entries = try? FileManager.default.contentsOfDirectory(atPath: helper.path),
           entries.contains(where: { $0.contains("Chromium") || $0.contains("Chrome") }) {
            return true
        }
        return false
    }

    /// Per-launch defaults overrides for an AppKit app. They live in the launched process's
    /// argument domain only; the user's preferences and saved state are never written.
    ///
    /// - Window restoration is ignored, so an agent's TextEdit does not reopen the user's own
    ///   documents onto the agent's display.
    /// - Quitting does not save window state, so tearing the session down cannot replace the
    ///   restoration state the user's next launch of the same app depends on.
    /// - A document app started without files opens an untitled document instead of its Open
    ///   panel. That panel is rendered by a separate system service and is slow and incomplete
    ///   through Accessibility, which left agents stuck on the first screen.
    static func cleanSlateArguments(openingFiles: Bool) -> [String] {
        var arguments = [
            "-ApplePersistenceIgnoreState", "YES",
            "-NSQuitAlwaysKeepsWindows", "NO",
        ]
        if !openingFiles {
            arguments += ["-NSShowAppCentricOpenPanelInsteadOfUntitledFile", "NO"]
        }
        return arguments
    }

    /// Only a plain AppKit application parses `-Key Value` pairs into its defaults. Electron,
    /// Qt, and Java launchers can read the same words as documents to open, so they are left
    /// with the launch they have always had.
    static func acceptsDefaultsArguments(_ appURL: URL) -> Bool {
        guard let bundle = Bundle(url: appURL),
              let principal = bundle.object(forInfoDictionaryKey: "NSPrincipalClass") as? String,
              !principal.isEmpty else { return false }
        let frameworks = appURL.appendingPathComponent("Contents/Frameworks")
        let entries = (try? FileManager.default.contentsOfDirectory(atPath: frameworks.path)) ?? []
        let foreignRuntimes = ["Electron Framework", "QtCore", "QtGui", "JavaVM", "libjli", "Mono"]
        if entries.prefix(512).contains(where: { entry in
            foreignRuntimes.contains(where: { entry.hasPrefix($0) })
        }) { return false }
        let javaRuntime = appURL.appendingPathComponent("Contents/PlugIns/JavaAppletPlugin.plugin")
        return !FileManager.default.fileExists(atPath: javaRuntime.path)
            && bundle.object(forInfoDictionaryKey: "JVMOptions") == nil
    }

    /// VS Code-family Electron bundles have a stable semantic extension API that can scroll an
    /// editor without synthesising input or activating the application.
    ///
    /// Do not classify arbitrary Electron shells here: loading a VS Code extension into an app
    /// that merely happens to ship Electron would be both ineffective and an unsafe assumption.
    public static func isVSCodeElectronFamily(_ appURL: URL) -> Bool {
        let resources = appURL.appendingPathComponent("Contents/Resources/app")
        let framework = appURL.appendingPathComponent(
            "Contents/Frameworks/Electron Framework.framework")
        return FileManager.default.fileExists(atPath: framework.path)
            && FileManager.default.fileExists(
                atPath: resources.appendingPathComponent("out/cli.js").path)
            && FileManager.default.fileExists(
                atPath: resources.appendingPathComponent("product.json").path)
    }

    static func isElectronFamily(_ appURL: URL) -> Bool {
        FileManager.default.fileExists(atPath: appURL.appendingPathComponent(
            "Contents/Frameworks/Electron Framework.framework").path)
    }

    private static func prepareElectronControl() throws -> PreparedElectronControl {
        let suffix = UUID().uuidString.replacingOccurrences(of: "-", with: "")
            .prefix(16)
        let root = URL(fileURLWithPath: "/tmp", isDirectory: true)
            .appendingPathComponent(
                "spaceo-e-\(getpid())-\(suffix)",
                isDirectory: true)
        let extensions = root.appendingPathComponent("extensions", isDirectory: true)
        let extensionDirectory = extensions.appendingPathComponent(
            ElectronControlAssets.extensionDirectoryName,
            isDirectory: true)
        let socket = root.appendingPathComponent("control.sock")
        guard socket.path.utf8.count < 100 else {
            throw SpaceOError.launchFailed("private Electron control path is too long")
        }

        do {
            try FileManager.default.createDirectory(
                at: root,
                withIntermediateDirectories: false,
                attributes: [.posixPermissions: 0o700])
            try FileManager.default.createDirectory(
                at: extensionDirectory,
                withIntermediateDirectories: true,
                attributes: [.posixPermissions: 0o700])
            let package = extensionDirectory.appendingPathComponent("package.json")
            let script = extensionDirectory.appendingPathComponent("extension.js")
            try ElectronControlAssets.packageJSON.write(
                to: package, atomically: true, encoding: .utf8)
            try ElectronControlAssets.extensionJavaScript.write(
                to: script, atomically: true, encoding: .utf8)
            try FileManager.default.setAttributes(
                [.posixPermissions: 0o600],
                ofItemAtPath: package.path)
            try FileManager.default.setAttributes(
                [.posixPermissions: 0o600],
                ofItemAtPath: script.path)
        } catch {
            _ = removeTemporaryControlRoot(at: root)
            throw error
        }

        let token = UUID().uuidString.replacingOccurrences(of: "-", with: "")
            + UUID().uuidString.replacingOccurrences(of: "-", with: "")
        return PreparedElectronControl(
            root: root,
            extensionsDirectory: extensions,
            endpoint: ElectronControlEndpoint(socket: socket, token: token))
    }

    private static func runningInstances(of appURL: URL) -> Set<pid_t> {
        Set(NSWorkspace.shared.runningApplications
            .filter { $0.bundleURL?.standardizedFileURL == appURL.standardizedFileURL }
            .map(\.processIdentifier))
    }
}
