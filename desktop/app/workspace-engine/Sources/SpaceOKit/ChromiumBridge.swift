import Foundation
import AppKit
import CoreGraphics

/// Reused browsers survive an open failure, so callers need receipts before deciding to retry.
struct BackgroundPageOpenFailure: Error, LocalizedError, Sendable {
    let confirmedTargetIDs: [String]
    let failedIndex: Int
    let attempted: Bool
    let total: Int
    let reason: String
    var errorDescription: String? {
        if failedIndex == total {
            return "All \(total) background pages were confirmed, but final process validation failed. "
                + "Do not replay these opens. \(reason)"
        }
        return "file open incomplete: \(confirmedTargetIDs.count) background page(s) confirmed; "
            + "file index \(failedIndex) \(attempted ? "has unknown delivery" : "was not sent"). "
            + "Inspect current targets before retrying; do not replay completed opens. \(reason)"
    }
    var steps: [StepReceipt] {
        (0..<total).map { index in
            if index < confirmedTargetIDs.count {
                return StepReceipt(index: index, cmd: "run.file", ok: true, executed: true,
                    message: "opened target \(confirmedTargetIDs[index])", completion: "confirmed")
            }
            return StepReceipt(index: index, cmd: "run.file", ok: false,
                executed: index == failedIndex && attempted,
                completion: index == failedIndex && attempted ? "unknown" : "not_executed")
        }
    }
}

/// Drives Chromium web content through the DevTools Protocol.
///
/// Why this exists: measured against Google Chrome on macOS 27, synthetic input reaches a
/// Chromium browser's *chrome* but not its *web content*.
///
///   keyboard via CGEventPostToPid  → works (the address bar receives text)
///   AXPress on a toolbar control   → works
///   AXPress on a DOM button        → no DOM click
///   synthetic mouse at coordinates → no DOM click, even stamped with the window id
///
/// The renderer validates event provenance and drops anything the WindowServer did not vouch
/// for. Rather than pretend a click landed, SpaceO talks to the browser the way browsers expect
/// to be automated. This only works for browsers SpaceO launched itself, because the debugging
/// port has to be set at launch — an adopted browser gets an honest refusal instead.
public actor ChromiumBridge {

    public struct Target: Sendable {
        public let id: String
        public let title: String
        public let url: String
        let webSocketURL: URL
    }

    /// Largest `/json/list` body we will read. Enforced *while* reading, not after.
    static let maximumTargetListBytes = 1_048_576

    public let port: Int
    private let discoverySession: URLSession
    private var webSocketSession: URLSession
    private var socket: URLSessionWebSocketTask?
    private var nextID = 0
    private struct CommandBinding {
        let socket: URLSessionWebSocketTask?
        let targetID: String?
    }
    private var commandBinding: CommandBinding { CommandBinding(socket: socket, targetID: attachedTargetID) }
    private func requireBinding(_ binding: CommandBinding) throws {
        guard socket === binding.socket, attachedTargetID == binding.targetID else {
            throw SpaceOError.badRequest("DevTools target changed during the operation; retry deliberately")
        }
    }
    private var commandExecutor: ((String, [String: Any]) async throws -> [String: Any])?

    /// Deterministic command transport seam; target discovery and binding checks still run.
    init(port: Int, commandExecutor: @escaping (String, [String: Any]) async throws -> [String: Any]) {
        self.port = port
        self.discoverySession = URLSession(configuration: Self.discoveryConfiguration())
        self.webSocketSession = URLSession(configuration: Self.webSocketConfiguration())
        self.commandExecutor = commandExecutor
    }
    /// The page this bridge is bound to. Every command belongs to this target and nothing else;
    /// once set it is never silently re-pointed at whatever happens to be first in a later
    /// target list.
    private var attachedTargetID: String?

    public var boundTargetID: String? { attachedTargetID }

    /// How many DevTools sockets this bridge has opened. Re-attaching to the page it is already
    /// on must not open another; re-pointing it at a different page must.
    private(set) var socketsOpened = 0

    /// FIFO of callers waiting for the single in-flight DevTools command to finish.
    ///
    /// The protocol here is strictly request/reply on one WebSocket, but actor reentrancy means
    /// a second command can start while the first is suspended in `await socket.receive()`.
    /// Interleaved receivers would each consume — and drop — the other's reply, turning
    /// concurrent commands into spurious timeouts.
    let commandGate = SessionOperationGate()

    /// HTTP discovery is deliberately short-lived; a stalled loopback endpoint should not make
    /// launch wait longer than the caller's readiness window.
    static func discoveryConfiguration() -> URLSessionConfiguration {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 5
        configuration.timeoutIntervalForResource = 15
        configuration.waitsForConnectivity = false
        return configuration
    }

    /// A DevTools WebSocket belongs to the browser session, not to one command.
    ///
    /// Each command shares a strict ten-second budget across sending and receiving. Giving the
    /// underlying URLSession the discovery client's 15-second *resource lifetime* killed a
    /// healthy debugger connection in the middle of ordinary click-then-scroll workflows.
    /// Keep the transport long-lived and let the command deadline decide when it is unhealthy.
    static func webSocketConfiguration() -> URLSessionConfiguration {
        let configuration = URLSessionConfiguration.ephemeral
        let sessionLifetime: TimeInterval = 7 * 24 * 60 * 60
        configuration.timeoutIntervalForRequest = sessionLifetime
        configuration.timeoutIntervalForResource = sessionLifetime
        configuration.waitsForConnectivity = false
        return configuration
    }

    public init(port: Int) {
        self.port = port
        self.discoverySession = URLSession(configuration: Self.discoveryConfiguration())
        self.webSocketSession = URLSession(configuration: Self.webSocketConfiguration())
    }

    deinit {
        // A URLSession keeps its delegate machinery alive until it is invalidated; without this,
        // every browser launch leaks a session for the daemon's lifetime. The explicit cancel
        // first sends a graceful close frame; invalidateAndCancel alone drops the socket cold.
        // (deinit cannot call the actor-isolated detach().)
        socket?.cancel(with: .goingAway, reason: nil)
        discoverySession.invalidateAndCancel()
        webSocketSession.invalidateAndCancel()
    }

    // MARK: - Discovery

    /// Page targets the browser is currently showing.
    ///
    /// The body is read incrementally and abandoned the moment it crosses the size limit. The
    /// previous version buffered the whole response and *then* checked its length, which means a
    /// DevTools endpoint that is wedged, compromised, or simply broken could stream unbounded
    /// data into the daemon's memory before the check ever ran — the check was a report, not a
    /// limit.
    public func targets() async throws -> [Target] {
        try await targets(budget: nil)
    }

    /// Browser-level bridge for startup and reused file opens, separate from page binding.
    /// One deadline covers discovery and every requested page; foreground fallback is forbidden.
    func createBackgroundPages(files: [URL], region: CGRect, timeout: TimeInterval = 10,
                               reportPartialCompletion: Bool = false,
                               validate: @Sendable () throws -> Void = {}) async throws {
        guard (1...65_535).contains(port), files.count <= 256, socket == nil else {
            throw SpaceOError.badRequest("invalid browser startup request")
        }
        try WindowPlacement.validate(frame: region)
        // A newly revealed macOS window can be shifted below the menu bar. Starting at the
        // tile's full height leaves no room for that adjustment and fails containment after
        // reveal. Use the same inset frame as ordinary fitted windows, then verify placement.
        let windowFrame = WindowPlacement.defaultFrame(in: region)
        try WindowPlacement.validate(frame: windowFrame)
        guard [region.minX, region.minY, region.width, region.height,
               windowFrame.minX, windowFrame.minY, windowFrame.width, windowFrame.height].allSatisfy({
            $0 >= CGFloat(Int32.min) && $0 <= CGFloat(Int32.max)
        }) else {
            throw SpaceOError.badRequest("browser startup bounds exceed the protocol integer range")
        }
        let budget = try DevToolsDeadline(timeout: timeout)
        try validate()
        let data = try await boundedBody(from: URL(string: "http://127.0.0.1:\(port)/json/version")!,
                                         budget: budget)
        guard let version = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let raw = version["webSocketDebuggerUrl"] as? String,
              let endpoint = Self.validatedWebSocketURL(raw, port: port),
              endpoint.path.hasPrefix("/devtools/browser/") else {
            throw SpaceOError.launchFailed("browser did not expose a private browser endpoint")
        }
        try await connect(to: Target(id: endpoint.lastPathComponent, title: "", url: "",
                                     webSocketURL: endpoint))
        defer { detach() }
        let pages = files.isEmpty ? ["about:blank"] : files.map(\.absoluteString)
        var confirmed: [String] = []
        var failedIndex = 0
        var attempted = false
        do {
            for (index, page) in pages.enumerated() {
                failedIndex = index
                attempted = false
                try validate()
                var parameters: [String: Any] = [
                    "url": page, "background": true, "newWindow": index == 0,
                ]
                if index == 0 {
                    parameters["left"] = Int(windowFrame.minX)
                    parameters["top"] = Int(windowFrame.minY)
                    parameters["width"] = Int(windowFrame.width)
                    parameters["height"] = Int(windowFrame.height)
                }
                let result = try await performCommand("Target.createTarget", parameters, budget: budget,
                                                      onSend: { attempted = true })
                guard let id = result["targetId"] as? String, !id.isEmpty, id.utf8.count <= 1_024 else {
                    throw SpaceOError.launchFailed("browser did not confirm background page creation")
                }
                confirmed.append(id)
            }
            failedIndex = pages.count
            attempted = false
            try validate()
        } catch {
            guard reportPartialCompletion else { throw error }
            throw BackgroundPageOpenFailure(confirmedTargetIDs: confirmed, failedIndex: failedIndex,
                attempted: attempted, total: pages.count, reason: String(error.localizedDescription.prefix(512)))
        }
    }

    func targets(budget: DevToolsDeadline?) async throws -> [Target] {
        try budget?.check()
        guard (1...65_535).contains(port) else {
            throw SpaceOError.badRequest("DevTools port is invalid")
        }
        let url = URL(string: "http://127.0.0.1:\(port)/json/list")!
        let data = try await boundedBody(from: url, budget: budget)
        guard let raw = try JSONSerialization.jsonObject(with: data) as? [[String: Any]] else {
            throw SpaceOError.badRequest("DevTools returned an unexpected target list")
        }
        let targets = raw.compactMap { entry -> Target? in
            guard entry["type"] as? String == "page",
                  let id = entry["id"] as? String,
                  let ws = entry["webSocketDebuggerUrl"] as? String,
                  let wsURL = Self.validatedWebSocketURL(ws, port: port) else { return nil }
            return Target(id: id,
                          title: entry["title"] as? String ?? "",
                          url: entry["url"] as? String ?? "",
                          webSocketURL: wsURL)
        }
        try budget?.check()
        return targets
    }

    /// Read an HTTP body, cancelling the transfer as soon as it exceeds the limit.
    func boundedBody(from url: URL, budget: DevToolsDeadline? = nil) async throws -> Data {
        try await boundedBody(for: URLRequest(url: url), maximumBytes: Self.maximumTargetListBytes,
                              description: "target list", budget: budget)
    }

    func boundedBody(for request: URLRequest, maximumBytes: Int,
                     description: String, budget: DevToolsDeadline? = nil) async throws -> Data {
        try await DevToolsHTTPBody.read(session: discoverySession, request: request,
            maximumBytes: maximumBytes, description: description, budget: budget)
    }

    /// Wait for the browser to start serving DevTools. Chrome takes a moment after launch.
    public func waitUntilReady(timeout: TimeInterval = 15) async -> Bool {
        let safeTimeout = timeout.isFinite ? min(max(timeout, 0), 120) : 15
        return (try? await BridgeReadiness.wait(timeout: safeTimeout, interval: 0.25) {
            try await !targets().isEmpty
        }) ?? false
    }

    // MARK: - Connection

    /// Point the bridge at `target`, replacing any page it is already driving.
    ///
    /// The early return is keyed on the *target*, not on "a socket exists". Keyed on the socket,
    /// re-attaching was a silent no-op: `attach(toTargetID: B)` handed the caller `Target(id: B)`
    /// while the WebSocket still spoke to page A and `boundTargetID` still said `A`. That is the
    /// same drive-the-wrong-page failure SPAO-132 closed, arriving through the escape hatch that
    /// ticket added.
    private func connect(to target: Target) async throws {
        if socket != nil, attachedTargetID == target.id { return }
        guard Self.validatedWebSocketURL(target.webSocketURL.absoluteString, port: port) != nil else {
            // Validate before tearing anything down, so a refused endpoint leaves the page we are
            // already driving bound instead of unbinding the bridge as a side effect.
            throw SpaceOError.badRequest(
                "DevTools tried to redirect automation away from its private loopback port")
        }
        detach()
        let task = webSocketSession.webSocketTask(with: target.webSocketURL)
        task.maximumMessageSize = 32 * 1_048_576
        task.resume()
        socket = task
        socketsOpened += 1
        attachedTargetID = target.id
    }

    /// Bind to the single page of a browser SpaceO just launched.
    ///
    /// A private-profile browser we started ourselves has exactly one page, so "exactly one" is a
    /// contract we can actually check — unlike the old `targets().first`, which took DevTools'
    /// list order as evidence of which page is in front. That order is not documented to mean
    /// anything, so when a second page existed the bridge could type into, click, and screenshot
    /// a page nobody asked about while reporting success.
    ///
    /// Ambiguity fails closed and names the candidates, so the caller can pick one with
    /// `attach(toTargetID:)`.
    @discardableResult
    public func attachToLaunchedTarget() async throws -> Target {
        let found = try await targets()
        guard !found.isEmpty else {
            throw SpaceOError.badRequest("browser has no page targets on port \(port)")
        }
        guard found.count == 1, let only = found.first else {
            let listed = found
                .prefix(8)
                .map { "\($0.id) — \($0.title.isEmpty ? $0.url : $0.title)" }
                .joined(separator: "\n    ")
            throw SpaceOError.badRequest(
                "browser on port \(port) has \(found.count) page targets, so SpaceO cannot tell "
                + "which one you mean. Attach to one explicitly:\n    \(listed)")
        }
        try await connect(to: only)
        return only
    }

    /// Bind to a caller-chosen page. The explicit form of `attachToLaunchedTarget`.
    @discardableResult
    public func attach(toTargetID id: String) async throws -> Target {
        guard !id.isEmpty, id.utf8.count <= 1_024, id.count <= 256 else {
            throw SpaceOError.badRequest("target id must be 1 through 256 characters")
        }
        let found = try await targets()
        guard let target = found.first(where: { $0.id == id }) else {
            throw SpaceOError.badRequest(
                "no page target '\(id)' on port \(port); it may have been closed")
        }
        try await connect(to: target)
        return target
    }

    /// Confirm the bound page is still the one we attached to.
    ///
    /// Navigation keeps a target id; closure and replacement do not. Checking before an action
    /// is what turns "the page went away" into an error instead of a command silently delivered
    /// nowhere — or, worse, a reconnect to a different page.
    public func verifyBoundTarget() async throws {
        try await verifyBoundTarget(budget: nil)
    }

    private func verifyBoundTarget(budget: DevToolsDeadline?) async throws {
        let binding = commandBinding
        guard let attachedTargetID, socket != nil else {
            throw SpaceOError.badRequest("not attached to a DevTools target")
        }
        let found = try await targets(budget: budget)
        try requireBinding(binding)
        guard found.contains(where: { $0.id == attachedTargetID }) else {
            // Reading the list is an await a re-attach can interleave with. Only unbind if the
            // bridge is still on the page this call actually checked.
            if self.attachedTargetID == attachedTargetID { detach() }
            throw SpaceOError.badRequest(
                "the page SpaceO was driving (target \(attachedTargetID)) is gone; "
                + "attach again before sending more commands")
        }
    }

    /// The page currently bound to this bridge, after proving it still exists.
    public func currentTarget() async throws -> Target {
        try await currentTarget(budget: nil)
    }

    func currentTarget(budget: DevToolsDeadline?) async throws -> Target {
        let binding = commandBinding
        guard let attachedTargetID, socket != nil else {
            throw SpaceOError.badRequest("not attached to a DevTools target")
        }
        let found = try await targets(budget: budget)
        try requireBinding(binding)
        guard let target = found.first(where: { $0.id == attachedTargetID }) else {
            if self.attachedTargetID == attachedTargetID { detach() }
            throw SpaceOError.badRequest(
                "the page SpaceO was driving (target \(attachedTargetID)) is gone; "
                    + "attach again before sending more commands")
        }
        try budget?.check()
        return target
    }

    public func detach() {
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
        attachedTargetID = nil
    }

    /// Force-retire a transport that stopped producing replies, then prepare a clean transport
    /// for a deliberate future reattach. A graceful WebSocket close can itself wait forever on
    /// the broken peer; invalidating the owning URLSession releases Chrome's debugger target.
    private func retireTransport(ifCurrent stale: URLSessionWebSocketTask) {
        guard socket === stale else { return }
        stale.cancel(with: .goingAway, reason: nil)
        socket = nil
        attachedTargetID = nil
        webSocketSession.invalidateAndCancel()
        webSocketSession = URLSession(configuration: Self.webSocketConfiguration())
    }

    @discardableResult
    private func send(_ method: String, _ params: [String: Any] = [:],
                      binding: CommandBinding? = nil,
                      releaseObjectGroup: String? = nil,
                      budget: DevToolsDeadline? = nil) async throws -> [String: Any] {
        let expected = binding ?? commandBinding
        let expectedSocket = expected.socket
        let expectedTargetID = expected.targetID
        let lease: SessionOperationGate.Lease
        do { lease = try await commandGate.enter(timeout: try budget?.remaining()) }
        catch is SessionOperationGate.TimedOut { throw DevToolsDeadline.Exceeded() }
        defer { lease.finish() }
        try budget?.check()
        let started = ContinuousClock.now
        do {
            guard socket === expectedSocket, attachedTargetID == expectedTargetID else {
                throw SpaceOError.badRequest("DevTools target changed while the command was queued; retry deliberately")
            }
            // Target closure or replacement is checked for every web action. A stale socket must
            // never turn a command into a success against nowhere (or a different page).
            try await verifyBoundTarget(budget: budget)
            try Task.checkCancellation()
            guard socket === expectedSocket, attachedTargetID == expectedTargetID else {
                throw SpaceOError.badRequest("DevTools target changed during verification; retry deliberately")
            }
            var parameters = params
            if method == "Runtime.evaluate", let budget {
                parameters["timeout"] = min(Double(Self.evaluationTimeoutMilliseconds), try budget.remaining() * 1000)
            }
            let result = try await performCommand(method, parameters, budget: budget)
            if let group = releaseObjectGroup {
                let wrapper = result["result"] as? [String: Any]
                let details = result["exceptionDetails"] as? [String: Any]
                let exception = details?["exception"] as? [String: Any]
                if wrapper?["objectId"] != nil || exception?["objectId"] != nil {
                    let released = await releaseEvaluationObjects(group: group, binding: expected, budget: budget)
                    try Task.checkCancellation()
                    try budget?.check()
                    if !released, details == nil {
                        try requireBinding(expected)
                        throw SpaceOError.badRequest("DevTools could not release evaluation objects; attach again")
                    }
                }
            }
            try budget?.check()
            let elapsed = started.duration(to: .now)
            DaemonLog.shared.event("devtools.command.ok", [
                "method": method,
                "ms": String(Self.milliseconds(elapsed)),
            ])
            return result
        } catch {
            let elapsed = started.duration(to: .now)
            DaemonLog.shared.event("devtools.command.failed", [
                "method": method,
                "ms": String(Self.milliseconds(elapsed)),
            ])
            throw error
        }
    }

    private static func milliseconds(_ duration: Duration) -> Int64 {
        let components = duration.components
        let seconds = components.seconds.multipliedReportingOverflow(by: 1_000)
        let attoseconds = components.attoseconds / 1_000_000_000_000_000
        return seconds.overflow ? Int64.max : max(0, seconds.partialValue + attoseconds)
    }

    private func performCommand(_ method: String, _ params: [String: Any],
                                budget: DevToolsDeadline? = nil,
                                onSend: () -> Void = {}) async throws -> [String: Any] {
        // Fail closed on both halves of the binding. A socket without a target id would mean
        // the bridge reconnected to something it never chose, which must never happen silently.
        guard let socket, attachedTargetID != nil else {
            throw SpaceOError.badRequest("not attached to a DevTools target")
        }
        try Task.checkCancellation()
        try budget?.check()
        nextID = nextID == Int.max ? 1 : nextID + 1
        let id = nextID
        let payload: [String: Any] = ["id": id, "method": method, "params": params]
        let data = try JSONSerialization.data(withJSONObject: payload)
        guard data.count <= 1_048_576 else {
            throw SpaceOError.badRequest("DevTools command exceeds the 1 MiB limit")
        }
        if let commandExecutor {
            onSend()
            let result = try await commandExecutor(method, params)
            do { try budget?.check() }
            catch { retireTransport(ifCurrent: socket); throw error }
            return result
        }
        let commandTimeout = min(10, try budget?.remaining() ?? 10)
        let commandDeadline = ContinuousClock.now.advanced(by: .seconds(commandTimeout))
        do {
            let message = URLSessionWebSocketTask.Message.string(String(decoding: data, as: UTF8.self))
            let _: Void = try await Self.firstCompletion(
                within: commandTimeout,
                timeoutMessage: "DevTools send timed out",
                start: { completion in
                    onSend()
                    socket.send(message) { error in
                        if let error { completion(.failure(error)) }
                        else { completion(.success(())) }
                    }
                },
                onTimeout: { socket.cancel(with: .goingAway, reason: nil) })
        } catch {
            // The browser closed the socket between commands (page closed, DevTools client
            // evicted, browser restarted on the same port). Keeping the dead socket bound
            // would make every later command fail the same way until someone re-attaches by
            // hand; retiring it lets the next attach start from a live connection.
            retireTransport(ifCurrent: socket)
            try Task.checkCancellation()
            try budget?.check()
            throw SpaceOError.badRequest(
                "DevTools \(method): the connection to the page was lost "
                    + "(\(error.localizedDescription)); attach again before sending more commands")
        }

        // DevTools interleaves events with replies; read until our id comes back.
        for _ in 0..<64 {
            let duration = ContinuousClock.now.duration(to: commandDeadline).components
            let remaining = Double(duration.seconds) + Double(duration.attoseconds) / 1e18
            guard remaining > 0 else {
                retireTransport(ifCurrent: socket)
                try budget?.check()
                throw SpaceOError.badRequest("DevTools \(method): reply timed out")
            }
            let message: URLSessionWebSocketTask.Message
            do {
                message = try await Self.receive(from: socket, within: remaining)
            } catch {
                retireTransport(ifCurrent: socket)
                try Task.checkCancellation()
                try budget?.check()
                throw SpaceOError.badRequest(
                    "DevTools \(method): \(error.localizedDescription)")
            }
            let data: Data
            switch message {
            case .string(let text):
                guard text.utf8.count <= 32 * 1_048_576 else { continue }
                data = Data(text.utf8)
            case .data(let bytes):
                guard bytes.count <= 32 * 1_048_576 else { continue }
                data = bytes
            @unknown default:
                continue
            }
            guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            else { continue }
            if let replyID = object["id"] as? Int, replyID == id {
                guard ContinuousClock.now < commandDeadline else {
                    retireTransport(ifCurrent: socket)
                    try budget?.check()
                    throw SpaceOError.badRequest("DevTools \(method): reply timed out")
                }
                do { try budget?.check() }
                catch { retireTransport(ifCurrent: socket); throw error }
                if let error = object["error"] as? [String: Any] {
                    throw SpaceOError.badRequest("DevTools \(method): \(error["message"] as? String ?? "failed")")
                }
                return object["result"] as? [String: Any] ?? [:]
            }
        }
        retireTransport(ifCurrent: socket)
        try budget?.check()
        throw SpaceOError.badRequest("DevTools \(method): no reply")
    }

    private static func receive(
        from socket: URLSessionWebSocketTask,
        within timeout: TimeInterval
    ) async throws -> URLSessionWebSocketTask.Message {
        try await firstCompletion(
            within: timeout,
            start: { completion in socket.receive(completionHandler: completion) },
            onTimeout: { socket.cancel(with: .goingAway, reason: nil) })
    }

    /// Return the first callback result, cancellation, or deadline without waiting for a late callback.
    ///
    /// A structured task group is unsafe for this job: leaving the group waits for every child,
    /// and `URLSessionWebSocketTask.receive()` has been observed not to finish when its Swift task
    /// is cancelled. That turns a nominal ten-second timeout into an unbounded daemon-wide actor
    /// stall. The callback API plus a one-shot continuation keeps the deadline authoritative;
    /// cancelling the socket still asks Foundation to retire its pending receive in the
    /// background, but request progress no longer depends on that cleanup completing.
    static func firstCompletion<Value: Sendable>(
        within timeout: TimeInterval,
        timeoutMessage: String = "DevTools reply timed out",
        start: (@escaping @Sendable (Result<Value, Error>) -> Void) -> Void,
        onTimeout: @escaping @Sendable () -> Void = {}
    ) async throws -> Value {
        guard timeout.isFinite, timeout > 0, timeout <= 120 else {
            throw SpaceOError.badRequest(
                "DevTools reply timeout must be greater than zero and at most 120 seconds")
        }
        return try await CallbackDeadline.firstCompletion(
            within: timeout, timeoutError: SpaceOError.badRequest(timeoutMessage),
            start: start, onTimeout: onTimeout)
    }

    // MARK: - Geometry

    /// Where the page viewport sits on screen, and how big it is.
    ///
    /// Needed to turn the window-relative coordinates an agent reads off a screenshot into the
    /// viewport coordinates the DevTools input domain expects.
    public func viewportOnScreen() async throws -> CGRect {
        let json = try await evaluate("""
                JSON.stringify({x: window.screenX, y: window.screenY,
                                w: window.innerWidth, h: window.innerHeight,
                                dpr: window.devicePixelRatio})
                """)
        struct Viewport: Decodable { let x: Double; let y: Double; let w: Double; let h: Double }
        let box = try ChromiumObservation.decode(Viewport.self, from: json)
        guard box.x.isFinite, box.y.isFinite, box.w.isFinite, box.h.isFinite,
              box.w > 0, box.h > 0
        else { throw SpaceOError.badRequest("could not read the page viewport") }
        return CGRect(x: box.x, y: box.y, width: box.w, height: box.h)
    }

    // MARK: - Input

    /// Click at a point in *viewport* coordinates.
    public func click(
        x: Double,
        y: Double,
        button: MouseButton = .left,
        clickCount: Int = 1,
        modifiers: CGEventFlags = []
    ) async throws {
        try await click(x: x, y: y, button: button, clickCount: clickCount,
                        modifiers: modifiers, binding: commandBinding)
    }

    private func click(x: Double, y: Double, button: MouseButton, clickCount: Int,
                       modifiers: CGEventFlags, binding: CommandBinding) async throws {
        guard x.isFinite, y.isFinite else {
            throw SpaceOError.badRequest("click coordinates must be finite")
        }
        guard (1...3).contains(clickCount) else {
            throw SpaceOError.badRequest("click count must be from 1 through 3")
        }
        // Mapping anything that is not `right` onto `left` turned a middle click — open in a
        // new tab, close a tab — into an ordinary click on whatever was under it.
        let name = Self.devToolsButton(button)
        let modifierMask = try Self.devToolsModifiers(modifiers)
        let events: [[String: Any]] = [
            ["type": "mouseMoved", "x": x, "y": y, "button": "none", "modifiers": modifierMask],
            ["type": "mousePressed", "x": x, "y": y, "button": name,
             "buttons": Self.devToolsButtonMask(button), "clickCount": clickCount, "modifiers": modifierMask],
            ["type": "mouseReleased", "x": x, "y": y, "button": name,
             "buttons": 0, "clickCount": clickCount, "modifiers": modifierMask],
        ]
        try await sendInputSequence("Input.dispatchMouseEvent", events: events, binding: binding)
    }

    private func sendInputSequence(_ method: String, events: [[String: Any]],
                                   binding: CommandBinding) async throws {
        var pressAttempted = false
        do {
            for params in events {
                let type = params["type"] as? String
                if type == "mousePressed" || type == "rawKeyDown" { pressAttempted = true }
                try await send(method, params, binding: binding)
            }
        } catch {
            if pressAttempted, let release = events.last {
                await releaseInput(method, release, binding: binding)
            }
            throw error
        }
    }

    /// Best-effort release is cleanup, so it gets an uncancelled task. Binding checks still
    /// refuse a different/replaced page and the normal transport deadline still applies.
    private func releaseInput(_ method: String, _ params: [String: Any], binding: CommandBinding) async {
        await Task { _ = try? await send(method, params, binding: binding) }.value
    }

    /// Translate a window-local point into the page's viewport coordinates.
    ///
    /// Shared by every pointer action so they cannot drift into different coordinate spaces —
    /// which is exactly how a click and a scroll aimed at the same pixel end up hitting
    /// different things.
    public func viewportPoint(
        windowLocal: CGPoint,
        windowOrigin: CGPoint
    ) async throws -> CGPoint {
        let viewport = try await viewportOnScreen()
        return CGPoint(x: windowOrigin.x + windowLocal.x - viewport.origin.x,
                       y: windowOrigin.y + windowLocal.y - viewport.origin.y)
    }

    /// Scroll at a point in *viewport* coordinates.
    ///
    /// Web content is the one surface where the wheel genuinely has to come from DevTools:
    /// the renderer validates event provenance and drops anything the WindowServer did not
    /// vouch for, and a page's scroller is not in the accessibility tree as a settable scroll
    /// bar either, so neither of the native paths can move it.
    public func scroll(
        x: Double,
        y: Double,
        deltaX: Double,
        deltaY: Double,
        ticks: Int = 1
    ) async throws {
        guard x.isFinite, y.isFinite, deltaX.isFinite, deltaY.isFinite else {
            throw SpaceOError.badRequest("scroll coordinates and deltas must be finite")
        }
        guard (1...100).contains(ticks) else {
            throw SpaceOError.badRequest("scroll ticks must be from 1 through 100")
        }
        let binding = commandBinding
        for _ in 0..<ticks {
            try await send("Input.dispatchMouseEvent",
                           ["type": "mouseWheel", "x": x, "y": y,
                            "deltaX": deltaX, "deltaY": deltaY], binding: binding)
        }
    }

    /// Move the pointer without pressing, so hover-only page UI appears.
    public func move(x: Double, y: Double) async throws {
        guard x.isFinite, y.isFinite else {
            throw SpaceOError.badRequest("move coordinates must be finite")
        }
        try await send("Input.dispatchMouseEvent",
                       ["type": "mouseMoved", "x": x, "y": y, "button": "none"])
    }

    /// Press, travel, and release in *viewport* coordinates.
    ///
    /// The intermediate moves are load-bearing: a press followed immediately by a release
    /// somewhere else reads as a click at the destination to most page handlers, so sliders and
    /// drag-to-select need to see the pointer travel.
    public func drag(
        fromX: Double, fromY: Double,
        toX: Double, toY: Double,
        button: MouseButton = .left,
        steps: Int = 12,
        duration: Double? = nil
    ) async throws {
        guard fromX.isFinite, fromY.isFinite, toX.isFinite, toY.isFinite else {
            throw SpaceOError.badRequest("drag coordinates must be finite")
        }
        guard (1...200).contains(steps) else {
            throw SpaceOError.badRequest("drag steps must be from 1 through 200")
        }
        if let duration, !duration.isFinite || !(0.05...30).contains(duration) {
            throw SpaceOError.badRequest("drag duration must be from 0.05 through 30 seconds")
        }
        let name = Self.devToolsButton(button)
        let mask = Self.devToolsButtonMask(button)
        let binding = commandBinding
        let release: [String: Any] = ["type": "mouseReleased", "x": toX, "y": toY,
                                      "button": name, "buttons": 0, "clickCount": 1]
        try await send("Input.dispatchMouseEvent",
                       ["type": "mouseMoved", "x": fromX, "y": fromY, "button": "none"], binding: binding)
        do {
            try await send("Input.dispatchMouseEvent",
                           ["type": "mousePressed", "x": fromX, "y": fromY,
                            "button": name, "buttons": mask, "clickCount": 1], binding: binding)
            for step in 1...steps {
                try Task.checkCancellation()
                if let duration {
                    try await Task.sleep(nanoseconds: UInt64(duration / Double(steps) * 1_000_000_000))
                }
                let t = Double(step) / Double(steps)
                try await send("Input.dispatchMouseEvent",
                               ["type": "mouseMoved", "x": fromX + (toX - fromX) * t,
                                "y": fromY + (toY - fromY) * t,
                                "button": name, "buttons": mask], binding: binding)
            }
            try await send("Input.dispatchMouseEvent", release, binding: binding)
        } catch {
            await releaseInput("Input.dispatchMouseEvent", release, binding: binding)
            throw error
        }
    }

    static func devToolsButton(_ button: MouseButton) -> String {
        switch button {
        case .left:   return "left"
        case .right:  return "right"
        case .middle: return "middle"
        }
    }

    /// CDP's `buttons` bitmask: 1 left, 2 right, 4 middle.
    static func devToolsButtonMask(_ button: MouseButton) -> Int {
        switch button {
        case .left:   return 1
        case .right:  return 2
        case .middle: return 4
        }
    }

    /// CDP modifier bitmask: Alt=1, Control=2, Meta(Command)=4, Shift=8.
    static func devToolsModifiers(_ flags: CGEventFlags) throws -> Int {
        let supported: CGEventFlags = [
            .maskAlternate, .maskControl, .maskCommand, .maskShift,
        ]
        guard flags.subtracting(supported).isEmpty else {
            throw SpaceOError.badRequest(
                "that modifier is not supported by the browser bridge")
        }
        var modifiers = 0
        if flags.contains(.maskAlternate) { modifiers |= 1 }
        if flags.contains(.maskControl) { modifiers |= 2 }
        if flags.contains(.maskCommand) { modifiers |= 4 }
        if flags.contains(.maskShift) { modifiers |= 8 }
        return modifiers
    }

    public func type(_ text: String) async throws {
        // The scalar cap also bounds Character count without a separate grapheme traversal.
        guard text.utf8.count <= 32_000, text.unicodeScalars.count <= 8_000 else {
            throw SpaceOError.badRequest(
                "text is too long (maximum 8000 characters/scalars "
                + "and 32000 UTF-8 bytes)")
        }
        try await send("Input.insertText", ["text": text])
    }

    public func key(_ text: String) async throws {
        try await key(KeyCombo.parse(text))
    }

    public func key(_ combo: KeyCombo) async throws {
        // Keep the actor-isolated send on this actor. Passing a closure that captures `self`
        // through the nonisolated test helper would transfer actor state across isolation.
        try combo.requireClipboardSafeRoute()
        try await sendInputSequence("Input.dispatchKeyEvent", events: Self.keyEvents(for: combo),
                                    binding: commandBinding)
    }

    struct DevToolsKey {
        let windowsVirtualKeyCode: Int
        let key: String
        let code: String
        let modifiers: Int
    }

    /// Builds and dispatches both CDP key events. Shared-clipboard shortcuts are refused
    /// before this helper constructs or sends either event.
    static func deliverKey(
        _ combo: KeyCombo,
        dispatch: ([String: Any]) async throws -> Void
    ) async throws {
        // CDP offers no isolated macOS pasteboard transaction either. Refuse before sending
        // rawKeyDown, including modified Command-C/X/V variants that an application may bind.
        try combo.requireClipboardSafeRoute()
        for params in try keyEvents(for: combo) {
            try await dispatch(params)
        }
    }

    private static func keyEvents(for combo: KeyCombo) throws -> [[String: Any]] {
        let key = try devToolsKey(for: combo)
        let common: [String: Any] = [
            "windowsVirtualKeyCode": key.windowsVirtualKeyCode,
            "nativeVirtualKeyCode": Int(combo.keyCode),
            "key": key.key,
            "code": key.code,
            "modifiers": key.modifiers,
        ]
        var down = common
        down["type"] = "rawKeyDown"
        var up = common
        up["type"] = "keyUp"
        return [down, up]
    }

    static func devToolsKey(for combo: KeyCombo) throws -> DevToolsKey {
        let map: [CGKeyCode: (windows: Int, key: String, code: String)] = [
            8: (67, "c", "KeyC"),
            7: (88, "x", "KeyX"),
            36: (13, "Enter", "Enter"),
            48: (9, "Tab", "Tab"),
            51: (8, "Backspace", "Backspace"),
            53: (27, "Escape", "Escape"),
            123: (37, "ArrowLeft", "ArrowLeft"),
            124: (39, "ArrowRight", "ArrowRight"),
            125: (40, "ArrowDown", "ArrowDown"),
            126: (38, "ArrowUp", "ArrowUp"),
        ]
        guard let mapped = map[combo.keyCode] else {
            throw SpaceOError.badRequest(
                "that key is not one the browser bridge knows")
        }

        let modifiers = try devToolsModifiers(combo.flags)

        let renderedKey = combo.flags.contains(.maskShift)
            && mapped.key.count == 1
            ? mapped.key.uppercased() : mapped.key
        return DevToolsKey(
            windowsVirtualKeyCode: mapped.windows,
            key: renderedKey,
            code: mapped.code,
            modifiers: modifiers)
    }

    /// Chromium's evaluation budget is shorter than the ten-second transport deadline, so a
    /// slow script can report its failure before the transport is retired. CDP uses milliseconds.
    static let evaluationTimeoutMilliseconds = 5_000

    /// Evaluate JavaScript in the page and return the result as a string. Synchronous execution
    /// is limited to five seconds; this does not cancel async work scheduled by the expression.
    /// The honest way for an agent to confirm that an action actually did something.
    public func evaluate(_ expression: String) async throws -> String {
        try await evaluate(expression, binding: commandBinding)
    }

    private func evaluate(_ expression: String, binding: CommandBinding,
                          budget: DevToolsDeadline? = nil) async throws -> String {
        guard expression.utf8.count <= 1_048_576, expression.count <= 262_144 else {
            throw SpaceOError.badRequest("JavaScript expression exceeds the 1 MiB limit")
        }
        let group = "spaceo-evaluation-" + UUID().uuidString
        let result = try await send("Runtime.evaluate", [
            "expression": expression, "returnByValue": true,
            "timeout": Self.evaluationTimeoutMilliseconds, "objectGroup": group,
        ], binding: binding, releaseObjectGroup: group, budget: budget)
        // returnByValue does not rule out remote handles (for example, an exception object).
        // We return only strings, so none of these references should outlive this evaluation.
        let wrapper = result["result"] as? [String: Any]
        let details = result["exceptionDetails"] as? [String: Any]
        try Task.checkCancellation()
        if let details {
            let message = (details["text"] as? String ?? "unknown exception").prefix(480)
            throw SpaceOError.badRequest("JavaScript evaluation failed: \(message)")
        }
        try requireBinding(binding)
        guard let wrapper else {
            throw SpaceOError.badRequest("DevTools returned an invalid JavaScript result")
        }
        if let value = wrapper["value"] as? String { return value }
        if let value = wrapper["value"] as? NSNumber {
            if CFGetTypeID(value) == CFBooleanGetTypeID() { return value.boolValue ? "true" : "false" }
            return value.stringValue
        }
        return wrapper["description"] as? String ?? ""
    }

    private func releaseEvaluationObjects(group: String, binding: CommandBinding,
                                          budget: DevToolsDeadline? = nil) async -> Bool {
        // Cancellation still needs cleanup. A fresh task may release only the original
        // binding; it must never send a cleanup command to a replacement page. The caller
        // still holds the command lease, so cleanup cannot queue behind another evaluation
        // and needs no second discovery request. performCommand bounds its send/reply time.
        await Task {
            do {
                try requireBinding(binding)
                _ = try await performCommand("Runtime.releaseObjectGroup", ["objectGroup": group], budget: budget)
                return true
            } catch {
                // Do not accumulate unreachable handles on a connection whose cleanup failed.
                DaemonLog.shared.event("devtools.evaluation.cleanup.failed")
                if let original = binding.socket { retireTransport(ifCurrent: original) }
                return false
            }
        }.value
    }

    // MARK: - Navigation (SPAO-146)

    /// Navigate the bound page and wait, bounded, for the document to finish loading.
    ///
    /// Load completion is polled through `document.readyState` rather than `Page.loadEventFired`
    /// because the command loop discards events that are not replies; polling keeps the bridge's
    /// one-command-at-a-time contract intact. A timeout is a normal outcome reported as
    /// `load: timeout`, never a success claim.
    public func navigate(to url: URL, timeout: TimeInterval = 15) async throws -> (target: Target, load: String) {
        guard let scheme = url.scheme?.lowercased(), ["http", "https", "file", "about"].contains(scheme) else {
            throw SpaceOError.badRequest("open.url accepts http, https, file and about URLs only")
        }
        guard url.absoluteString.utf8.count <= 8_192 else {
            throw SpaceOError.badRequest("URL exceeds 8192 bytes")
        }
        let safeTimeout = timeout.isFinite ? min(max(timeout, 0.5), 120) : 15
        let binding = commandBinding
        let result = try await send("Page.navigate", ["url": url.absoluteString], binding: binding)
        if let errorText = result["errorText"] as? String, !errorText.isEmpty {
            throw SpaceOError.badRequest("navigation failed: \(errorText)")
        }
        let ready = try await BridgeReadiness.wait(timeout: safeTimeout, interval: 0.2,
                                                 validate: { try self.requireBinding(binding) }) {
            try await evaluate("document.readyState", binding: binding) == "complete"
        }
        let load = ready ? "complete" : "timeout"
        let target = try await currentTarget()
        try requireBinding(binding)
        return (target, load)
    }

    /// Open `url` in a new tab and bind the bridge to it.
    public func openInNewTab(_ url: URL) async throws -> Target {
        guard (1...65_535).contains(port) else { throw SpaceOError.badRequest("DevTools port is invalid") }
        // Chromium expects PUT /json/new?<url>; the URL is the raw query.
        guard let endpoint = URL(string: "http://127.0.0.1:\(port)/json/new?" + (url.absoluteString.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? url.absoluteString)) else {
            throw SpaceOError.badRequest("could not form the DevTools new-tab request")
        }
        var request = URLRequest(url: endpoint)
        request.httpMethod = "PUT"
        let data = try await boundedBody(for: request, maximumBytes: 65_536, description: "new-tab response")
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let id = object["id"] as? String else {
            throw SpaceOError.badRequest("DevTools refused to open a new tab")
        }
        return try await attach(toTargetID: id)
    }

    // MARK: - Reading

    /// The page's visible text (`document.body.innerText`), bounded to `limit` characters.
    public func pageText(limit: Int) async throws -> (text: String, truncated: Bool) {
        guard (1...100_000).contains(limit) else {
            throw SpaceOError.badRequest("page text limit must be from 1 through 100000")
        }
        let value = try await evaluate(ChromiumObservation.text(limit: limit))
        let result = try ChromiumObservation.decode(ChromiumObservation.Text.self, from: value)
        guard result.text.unicodeScalars.count <= limit else {
            throw SpaceOError.badRequest("DevTools page text exceeds the character limit")
        }
        return (result.text, result.truncated)
    }

    public func selectionText() async throws -> String? {
        let limit = SessionClipboard.maximumBytes
        let value = try await evaluate(ChromiumObservation.selection(maximumBytes: limit, requireComplete: true))
        // JSON can escape each one-byte control character as six ASCII bytes.
        let report = try ChromiumObservation.decode(ChromiumObservation.Text.self, from: value,
                                                     maximumBytes: limit * 6 + 64)
        guard !report.truncated, report.text.utf8.count <= limit else {
            throw SpaceOError.badRequest("selection exceeds the session clipboard's 1 MiB limit")
        }
        return report.text.isEmpty ? nil : report.text
    }

    func selectionPreview() async throws -> String? {
        let value = try await evaluate(ChromiumObservation.selection(maximumBytes: 800,
                                                                     maximumScalars: 200, requireComplete: false))
        let report = try ChromiumObservation.decode(ChromiumObservation.Text.self, from: value, maximumBytes: 4864)
        guard report.text.utf8.count <= 800, report.text.unicodeScalars.count <= 200 else {
            throw SpaceOError.badRequest("DevTools selection preview exceeds its limit")
        }
        return report.truncated ? report.text + "…" : (report.text.isEmpty ? nil : report.text)
    }

    /// Insert text at the page's focused element through DevTools, the paste broker's web route.
    public func insertText(_ text: String) async throws {
        guard text.utf8.count <= 1_048_576 else { throw SpaceOError.badRequest("text exceeds 1 MiB") }
        _ = try await send("Input.insertText", ["text": text])
    }

    /// Interactive elements plus whether the cap was hit, so a read can say it stopped short.
    public func interactiveElementsReport(limit: Int = 200) async throws -> (outline: String, count: Int, truncated: Bool) {
        guard (1...1_000).contains(limit) else {
            throw SpaceOError.badRequest("page element limit must be from 1 through 1000")
        }
        let value = try await evaluate(ChromiumObservation.outline(limit: limit))
        let report = try ChromiumObservation.decode(ChromiumObservation.Outline.self, from: value)
        try ChromiumObservation.validate(report.items, limit: limit, sequential: true)
        guard !report.truncated || report.items.count == limit else {
            throw SpaceOError.badRequest("DevTools returned an inconsistent page observation")
        }
        let outline = report.items.isEmpty ? "(no interactive elements on this page)"
            : report.items.map(\.line).joined(separator: "\n")
        return (outline, report.items.count, report.truncated)
    }

    /// Case-insensitive substring search over the page's interactive elements, returning the
    /// same `wN` indices `interactiveElements` would assign, so a hit can be clicked directly.
    public func findElements(query: String, limit: Int = 25) async throws -> String {
        let report = try await findElementsReport(query: query, limit: limit)
        return report.outline + (report.truncation.truncated ? "\n" + report.truncation.footer : "")
    }

    /// Search completeness is separate from returned text; an empty partial search cannot
    /// establish absence. wN indices remain live DOM order, not native snapshot handles.
    public func findElementsReport(query: String, limit: Int = 25) async throws
        -> (outline: String, truncation: TruncationReport, scanned: Int) {
        guard query.utf8.count <= AXLabelMatcher.maximumTextBytes else { throw SpaceOError.badRequest("query exceeds \(AXLabelMatcher.maximumTextBytes) bytes") }
        guard (1...200).contains(limit) else { throw SpaceOError.badRequest("limit must be 1 through 200") }
        let value = try await evaluate(ChromiumObservation.find(query: query, limit: limit))
        let report = try ChromiumObservation.decode(ChromiumObservation.Search.self, from: value)
        try report.validate(limit: limit)
        return (report.outline, report.truncation, report.scanned)
    }

    /// Whether a CSS selector currently matches, for `wait web_selector`.
    public func selectorExists(_ selector: String) async throws -> Bool {
        try await selectorExists(selector, budget: nil)
    }

    func selectorExists(_ selector: String, budget: DevToolsDeadline?) async throws -> Bool {
        guard selector.utf8.count <= WaitCondition.maximumValueBytes else { throw SpaceOError.badRequest("selector exceeds \(WaitCondition.maximumValueBytes) bytes") }
        let literal = String(decoding: try JSONSerialization.data(withJSONObject: [selector]), as: UTF8.self)
        let value = try await evaluate("(() => { try { return document.querySelector(\(literal)[0]) ? 'yes' : 'no'; } catch (e) { return 'bad'; } })()", binding: commandBinding, budget: budget)
        switch value {
        case "yes": return true
        case "no": return false
        case "bad": throw SpaceOError.badRequest("invalid CSS selector")
        default: throw SpaceOError.badRequest("DevTools returned an invalid selector observation")
        }
    }

    /// PNG of the page viewport, in the same coordinate space as `click`.
    public func screenshot() async throws -> Data {
        let result = try await send("Page.captureScreenshot", ["format": "png"])
        guard let base64 = result["data"] as? String,
              base64.utf8.count <= 32 * 1_048_576,
              let data = Data(base64Encoded: base64),
              data.count <= 24 * 1_048_576 else {
            throw SpaceOError.captureFailed("DevTools returned no screenshot data")
        }
        return data
    }

    /// Interactive elements with their viewport rects — the web-content equivalent of an AX walk.
    public func interactiveElements(limit: Int = 200) async throws -> String {
        try await interactiveElementsReport(limit: limit).outline
    }

    /// Viewport centre of the nth element from `interactiveElements`, so scroll/move/drag can
    /// take a `wN` reference the way click does (SPAO-209).
    public func elementCenter(index: Int) async throws -> CGPoint {
        try await elementCenter(index: index, binding: commandBinding)
    }

    private func elementCenter(index: Int, binding: CommandBinding) async throws -> CGPoint {
        guard (0..<1_000).contains(index) else {
            throw SpaceOError.badRequest("web element index must be from 0 through 999")
        }
        let value = try await evaluate(ChromiumObservation.center(index: index), binding: binding)
        guard value != "missing" else {
            throw SpaceOError.badRequest("no web element [w\(index)] on this page")
        }
        struct Point: Decodable { let x: Double; let y: Double }
        let point = try ChromiumObservation.decode(Point.self, from: value)
        guard point.x.isFinite, point.y.isFinite else {
            throw SpaceOError.badRequest("DevTools returned invalid element coordinates")
        }
        return CGPoint(x: point.x, y: point.y)
    }

    public func clickElement(index: Int, button: MouseButton = .left, clickCount: Int = 1) async throws {
        let binding = commandBinding
        let point = try await elementCenter(index: index, binding: binding)
        try await click(x: point.x, y: point.y, button: button, clickCount: clickCount,
                        modifiers: [], binding: binding)
    }

    // MARK: - Endpoint validation

    static func validatedWebSocketURL(_ raw: String, port: Int) -> URL? {
        guard let components = URLComponents(string: raw),
              components.scheme?.lowercased() == "ws",
              let host = components.host?.lowercased(),
              ["127.0.0.1", "localhost", "::1"].contains(host),
              components.port == port,
              components.user == nil,
              components.password == nil else {
            return nil
        }
        return components.url
    }
}
