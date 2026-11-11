import Foundation
import Darwin

/// Line-delimited JSON over a Unix domain socket. One request, one response, one connection.
///
/// Small and boring on purpose — this is the part that must never be the reason a debugging
/// session goes sideways. `nc -U /tmp/spaceo-501.sock` is a valid client.
public enum Transport {

    public enum TransportError: Error, CustomStringConvertible, LocalizedError {
        case socketFailed(String)
        case notRunning(String)
        case malformed(String)
        case alreadyRunning(String)
        case busy(String)

        public var errorDescription: String? { description }

        public var description: String {
            switch self {
            case .socketFailed(let why): return "socket error: \(why)"
            case .busy(let why): return "daemon is busy: \(why)"
            case .notRunning(let path):
                let installed = FileManager.default.fileExists(
                    atPath: LaunchAgentInstaller.plistURL().path)
                return "no SpaceO daemon listening at \(path)\n  "
                    + LaunchAgentInstaller.startAdvice(installed: installed)
            case .malformed(let why): return "malformed message: \(why)"
            case .alreadyRunning(let path):
                return "a SpaceO daemon is already listening at \(path)"
            }
        }
    }

    // MARK: - Server

    /// `Server` crosses the accept thread, the I/O queue and per-client tasks. Its mutable
    /// socket/thread state is accessed only under `stateLock`; admission state (pending reads,
    /// in-flight and subscriber counts) lives on the serial `ioQueue`; `path` and the sendable
    /// handlers are immutable once `start()` runs.
    ///
    /// The accept thread does nothing but `accept()`. Each descriptor is handed to `ioQueue`,
    /// where a readiness source gathers the request line without blocking a thread, so a client
    /// that connects and then hesitates costs one descriptor and nothing else. Decoding, the
    /// handler call and the response write happen on a per-connection task.
    public final class Server: @unchecked Sendable {
        /// Emits one newline-delimited `Response` on a streaming connection. Returns `false`
        /// once the peer is gone, the write timed out, or the server stopped; the handler
        /// should return promptly after that.
        public typealias StreamWriter = @Sendable (Response) -> Bool

        private let path: String
        private var listenFD: Int32 = -1
        private var thread: Thread?
        private var stopping = false
        private var starting = false
        private var ownsSocket = false
        /// Bumped by every `start()`, so a `stop()` that lands after a restart cannot drop the
        /// successor listener's connections.
        private var generation: UInt64 = 0
        /// Ceiling on connections whose handler has not finished. Generous on purpose: it is a
        /// backstop against fd exhaustion, not a throughput knob.
        static let maximumInFlightConnections = 64
        /// Ceiling on `events.subscribe` connections held open by the stream handler. Separate
        /// from the in-flight ceiling so subscribers can never starve ordinary requests.
        static let maximumStreamingConnections = 32
        /// Ceiling on accepted connections that have not yet delivered a request line, plus
        /// those queued for an in-flight slot. Beyond it a connection is answered `busy` at
        /// once; each one costs a descriptor and nothing else, so this is deliberately wide.
        static let maximumPendingConnections = 256
        /// How long a connection waits for an in-flight slot before it is answered `busy`.
        static let admissionWaitNanoseconds: UInt64 = 1_000_000_000
        /// How long a connection may take to deliver its request line after `accept()`.
        static let requestReadNanoseconds: UInt64 = 3_000_000_000
        /// The live listening descriptor, or -1. Tests use it to kill the listener the way the
        /// kernel would; production has no reason to read it.
        var listeningDescriptorForTesting: Int32 { stateLock.withLock { listenFD } }
        var startupInProgressForTesting: Bool { stateLock.withLock { starting } }
        private var socketDevice: dev_t?
        private var socketInode: ino_t?
        private let stateLock = NSLock()
        private let handler: @Sendable (Request) async -> Response
        private var streamHandlerStorage: (@Sendable (Request, @escaping StreamWriter) async -> Void)?

        /// Serves `events.subscribe` requests as a long-lived stream instead of a single
        /// response. Set before `start()`; requests arriving while it is `nil` go to the
        /// ordinary handler. The connection closes when the closure returns.
        public var streamHandler: (@Sendable (Request, @escaping StreamWriter) async -> Void)? {
            get { stateLock.withLock { streamHandlerStorage } }
            set { stateLock.withLock { streamHandlerStorage = newValue } }
        }

        /// Serial queue owning every accepted-but-unanswered descriptor. Reads on it are
        /// non-blocking and event-driven, so its only long-running work is bookkeeping.
        private let ioQueue = DispatchQueue(label: "spaceo.daemon.io")
        // Everything below is touched only on `ioQueue`.
        private var pending: [Int32: PendingConnection] = [:]
        private var waiting: [AdmissionWaiter] = []
        private var inFlightCount = 0
        private var streamingCount = 0
        private var streaming: [Int32: StreamingConnection] = [:]

        public init(
            path: String,
            handler: @escaping @Sendable (Request) async -> Response
        ) {
            self.path = path
            self.handler = handler
        }

        public func start() throws {
            guard !path.isEmpty, !path.utf8.contains(0) else {
                throw TransportError.socketFailed("socket path is empty or contains a NUL byte")
            }
            guard path.utf8.count < MemoryLayout.size(ofValue: sockaddr_un().sun_path) else {
                throw TransportError.socketFailed("socket path too long: \(path)")
            }
            let mayStart = stateLock.withLock {
                guard listenFD < 0, self.thread == nil, !ownsSocket, !starting else { return false }
                starting = true
                stopping = false
                return true
            }
            guard mayStart else { throw TransportError.alreadyRunning(path) }
            defer { stateLock.withLock { starting = false } }

            // Serialise stale-socket cleanup and bind. Without this lock, two MCP clients
            // auto-starting together can each unlink the other's live socket and strand a daemon.
            let lockPath = path + ".lock"
            let lockFD = Darwin.open(lockPath, O_CREAT | O_RDWR | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK,
                                     S_IRUSR | S_IWUSR)
            guard lockFD >= 0 else {
                throw TransportError.socketFailed("open startup lock: \(errno)")
            }
            defer { close(lockFD) }
            var lockInfo = stat()
            guard fstat(lockFD, &lockInfo) == 0, lockInfo.st_mode & S_IFMT == S_IFREG else {
                throw TransportError.socketFailed("startup lock must be a regular file")
            }
            try Self.acquireStartupLock(lockFD, isCancelled: { self.stateLock.withLock { self.stopping } })
            defer { _ = flock(lockFD, LOCK_UN) }

            var existing = stat()
            if lstat(path, &existing) == 0 {
                guard existing.st_mode & S_IFMT == S_IFSOCK else {
                    throw TransportError.socketFailed(
                        "refusing to replace non-socket path: \(path)")
                }
                if Transport.ping(path) {
                    throw TransportError.alreadyRunning(path)
                }
                if Transport.canConnect(path) {
                    throw TransportError.socketFailed(
                        "socket path is occupied by a listener that is not SpaceO: \(path)")
                }
                guard unlink(path) == 0 else {
                    throw TransportError.socketFailed("remove stale socket: \(errno)")
                }
            } else if errno != ENOENT {
                throw TransportError.socketFailed("inspect socket path: \(errno)")
            }

            let fd = socket(AF_UNIX, SOCK_STREAM, 0)
            guard fd >= 0 else { throw TransportError.socketFailed("socket(): \(errno)") }
            var noSignal: Int32 = 1
            setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &noSignal,
                       socklen_t(MemoryLayout<Int32>.size))

            var address = sockaddr_un()
            address.sun_family = sa_family_t(AF_UNIX)
            let maxLength = MemoryLayout.size(ofValue: address.sun_path)
            guard path.utf8.count < maxLength else {
                close(fd); throw TransportError.socketFailed("socket path too long: \(path)")
            }
            withUnsafeMutablePointer(to: &address.sun_path) { pointer in
                pointer.withMemoryRebound(to: CChar.self, capacity: maxLength) { dst in
                    _ = strcpy(dst, path)
                }
            }
            let size = socklen_t(MemoryLayout<sockaddr_un>.size)
            let bound = withUnsafePointer(to: &address) {
                $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, size) }
            }
            guard bound == 0 else { close(fd); throw TransportError.socketFailed("bind(): \(errno)") }
            guard chmod(path, 0o600) == 0 else {
                let failure = errno
                close(fd)
                unlink(path)
                throw TransportError.socketFailed("chmod(): \(failure)")
            }
            // Deep enough to cover the in-flight ceiling and the burst behind it. A backlog
            // shorter than that ceiling turns a burst into ECONNREFUSED at connect(), which
            // clients report as "no SpaceO daemon listening" — the daemon is fine and the
            // message is a lie.
            guard listen(fd, Int32(Server.maximumInFlightConnections * 2)) == 0 else {
                let failure = errno
                close(fd)
                unlink(path)
                throw TransportError.socketFailed("listen(): \(failure)")
            }

            var identity = stat()
            guard lstat(path, &identity) == 0 else {
                let failure = errno
                close(fd)
                unlink(path)
                throw TransportError.socketFailed(
                    "inspect newly bound socket: \(failure)")
            }
            let thread = Thread { [weak self] in self?.acceptLoop() }
            thread.name = "spaceo.daemon.accept"
            let published = stateLock.withLock { () -> Bool in
                guard !stopping else { return false }
                listenFD = fd
                ownsSocket = true
                socketDevice = identity.st_dev
                socketInode = identity.st_ino
                self.thread = thread
                generation &+= 1
                return true
            }
            guard published else {
                close(fd)
                var current = stat()
                if lstat(path, &current) == 0,
                   current.st_dev == identity.st_dev, current.st_ino == identity.st_ino {
                    unlink(path)
                }
                throw TransportError.socketFailed("startup cancelled by stop")
            }
            thread.start()
        }

        /// A suspended competing starter must not hang this daemon indefinitely. Keep the
        /// opened descriptor and existing socket untouched unless the exclusive lock is held.
        static func acquireStartupLock(
            _ descriptor: Int32, timeoutNanoseconds: UInt64 = 3_000_000_000,
            now: () -> UInt64 = { DispatchTime.now().uptimeNanoseconds },
            pause: (useconds_t) -> Void = { usleep($0) },
            isCancelled: () -> Bool = { false }
        ) throws {
            let (end, overflow) = now().addingReportingOverflow(timeoutNanoseconds)
            let deadline = overflow ? UInt64.max : end
            var firstAttempt = true
            while firstAttempt || now() < deadline {
                firstAttempt = false
                guard !isCancelled() else { throw TransportError.socketFailed("startup cancelled by stop") }
                if flock(descriptor, LOCK_EX | LOCK_NB) == 0 { return }
                let failure = errno
                guard failure == EWOULDBLOCK || failure == EAGAIN || failure == EINTR else {
                    throw TransportError.socketFailed("lock startup file: \(failure)")
                }
                let current = now()
                guard current < deadline else { break }
                pause(useconds_t(min(10_000, max(1, (deadline - current) / 1_000))))
            }
            throw TransportError.busy("startup lock acquisition timed out; retry after the other starter finishes")
        }

        /// Accept failures that describe the environment rather than the listener.
        ///
        /// The descriptor is still bound and connectable after every one of these, so giving up
        /// would strand a daemon that answers `connect()` and then never accepts — reachable,
        /// deaf, and un-restartable, because a replacement daemon sees the pathname occupied.
        /// `EMFILE`/`ENFILE` in particular are a property of the process fd table, which the
        /// in-flight handlers holding those descriptors will hand back shortly.
        static let transientAcceptErrors: Set<Int32> = [
            EMFILE, ENFILE, ECONNABORTED, EAGAIN, EWOULDBLOCK, ENOBUFS, ENOMEM,
        ]

        static func acceptFailureIsTransient(_ code: Int32) -> Bool {
            transientAcceptErrors.contains(code)
        }

        /// Pause before retrying a transient accept failure.
        ///
        /// A peer that vanished mid-handshake consumed a real queued connection, so the first
        /// few retry at once. Descriptor exhaustion is congestion, and the descriptors are held
        /// by handlers that need time to drain — back off progressively instead of spinning a
        /// core against a full fd table.
        private static func backOff(afterConsecutiveFailures count: Int, code: Int32) {
            if code == ECONNABORTED, count <= 8 { return }
            usleep(UInt32(5_000 << min(count, 5)))
        }

        private func acceptLoop() {
            let ownThread = Thread.current
            // Retire only *this* loop's registration. A stop()/start() pair can install a
            // successor while this one is still unwinding, and clearing that would leave
            // start() permanently convinced a listener is already running.
            defer { stateLock.withLock { if thread === ownThread { thread = nil } } }
            var consecutiveFailures = 0
            while true {
                let fd = stateLock.withLock { stopping ? -1 : listenFD }
                guard fd >= 0 else { return }
                let client = accept(fd, nil, nil)
                // Sample errno before locking: pthread calls may clobber it.
                let failure = client < 0 ? errno : 0
                if client < 0 {
                    if stateLock.withLock({ stopping }) { return }
                    if failure == EINTR { continue }
                    guard Server.acceptFailureIsTransient(failure) else {
                        // The listener itself is gone (EBADF, ENOTSOCK, EINVAL...). Hand back
                        // the descriptor and the pathname so start() can re-arm, rather than
                        // leaving a bound socket nothing will ever accept on again.
                        releaseListener(markStopping: false, retiring: ownThread)
                        return
                    }
                    consecutiveFailures += 1
                    Server.backOff(afterConsecutiveFailures: consecutiveFailures, code: failure)
                    continue
                }
                consecutiveFailures = 0
                serve(client)
            }
        }

        /// Hand an accepted descriptor to the I/O queue. Nothing here may block: this is the
        /// accept thread, and one hesitant client must not delay the next `accept()`.
        private func serve(_ client: Int32) {
            ioQueue.async { [weak self] in
                guard let self else { close(client); return }
                self.beginReading(client)
            }
        }

        // MARK: Request read phase (ioQueue)

        /// A connection whose request line has not fully arrived.
        private final class PendingConnection {
            enum Outcome {
                case close
                case line(Data)
            }
            let fd: Int32
            var buffer = Data()
            var source: DispatchSourceRead?
            var timeout: DispatchWorkItem?
            var finished = false
            var outcome: Outcome = .close
            init(fd: Int32) { self.fd = fd }
        }

        /// A decoded request waiting for an in-flight slot.
        final class AdmissionWaiter {
            let fd: Int32
            let request: Result<Request, Error>
            var timer: DispatchWorkItem?
            init(fd: Int32, request: Result<Request, Error>) {
                self.fd = fd
                self.request = request
            }

            /// The queue owns the waiter; the delayed work must not prolong its payload's
            /// lifetime after admission, stop, or expiry, or form a waiter/timer cycle.
            func scheduleExpiry(on queue: DispatchQueue, deadline: DispatchTime,
                                expire: @escaping (AdmissionWaiter) -> Void) {
                let work = DispatchWorkItem { [weak self] in
                    guard let self else { return }
                    self.timer = nil
                    expire(self)
                }
                timer = work
                queue.asyncAfter(deadline: deadline, execute: work)
            }
        }

        private func beginReading(_ client: Int32) {
            var noSignal: Int32 = 1
            setsockopt(client, SOL_SOCKET, SO_NOSIGPIPE, &noSignal,
                       socklen_t(MemoryLayout<Int32>.size))
            // Both framing and response writes are nonblocking. Dispatch read sources and
            // poll deadlines bound waits, so per-syscall socket timeouts are unnecessary.
            let flags = fcntl(client, F_GETFL)
            guard flags >= 0, fcntl(client, F_SETFL, flags | O_NONBLOCK) == 0 else {
                close(client)
                return
            }
            guard !stateLock.withLock({ stopping }) else {
                close(client)
                return
            }
            guard pending.count + waiting.count < Server.maximumPendingConnections else {
                shed(client, TransportError.busy(
                    "\(Server.maximumPendingConnections) connections are already waiting"))
                return
            }

            let connection = PendingConnection(fd: client)
            pending[client] = connection
            let source = DispatchSource.makeReadSource(fileDescriptor: client, queue: ioQueue)
            connection.source = source
            source.setEventHandler { [weak self] in self?.readAvailable(connection) }
            // The descriptor may be closed or handed on only once the source has fully let
            // go of it, which is what the cancellation handler signals.
            source.setCancelHandler { [weak self] in
                guard let self else { close(connection.fd); return }
                self.completeRead(connection)
            }
            let timeout = DispatchWorkItem { [weak self] in
                self?.finishReading(connection, .close)
            }
            connection.timeout = timeout
            ioQueue.asyncAfter(
                deadline: .now() + .nanoseconds(Int(Server.requestReadNanoseconds)),
                execute: timeout)
            source.resume()
            // Bytes may already be queued from before the source was armed.
            readAvailable(connection)
        }

        private func readAvailable(_ connection: PendingConnection) {
            guard !connection.finished else { return }
            var chunk = [UInt8](repeating: 0, count: 8_192)
            while true {
                let n = read(connection.fd, &chunk, chunk.count)
                if n > 0 {
                    let newline = chunk[0..<n].firstIndex(of: 0x0A)
                    guard Transport.appendFrameBytes(chunk[0..<(newline ?? n)],
                        to: &connection.buffer, maximumBytes: 1_048_576) else {
                        finishReading(connection, .close)
                        return
                    }
                    if newline != nil {
                        // Bytes after the terminator belong to no request on this connection.
                        guard !connection.buffer.isEmpty,
                              String(data: connection.buffer, encoding: .utf8) != nil else {
                            finishReading(connection, .close)
                            return
                        }
                        finishReading(connection, .line(connection.buffer))
                        return
                    }
                    continue
                }
                if n == 0 {
                    finishReading(connection, .close)
                    return
                }
                let failure = errno
                if failure == EINTR { continue }
                // Drained; the source fires again when more arrives.
                if failure == EAGAIN || failure == EWOULDBLOCK { return }
                finishReading(connection, .close)
                return
            }
        }

        private func finishReading(
            _ connection: PendingConnection,
            _ outcome: PendingConnection.Outcome
        ) {
            guard !connection.finished else { return }
            connection.finished = true
            connection.outcome = outcome
            connection.buffer = Data()
            connection.timeout?.cancel()
            connection.timeout = nil
            pending.removeValue(forKey: connection.fd)
            if let source = connection.source {
                source.cancel()
            } else {
                completeRead(connection)
            }
        }

        private func completeRead(_ connection: PendingConnection) {
            connection.source = nil
            let outcome = connection.outcome
            // Cancelled dispatch work can retain the connection until its deadline. Do not
            // leave its completed frame reachable through that connection in the meantime.
            connection.outcome = .close
            switch outcome {
            case .close:
                close(connection.fd)
            case .line(let line):
                admit(connection.fd, line: line)
            }
        }

        // MARK: Admission (ioQueue)

        private func admit(_ client: Int32, line: Data) {
            let decoded: Result<Request, Error>
            do {
                decoded = .success(try Wire.decoder.decode(Request.self, from: line))
            } catch {
                decoded = .failure(error)
            }
            if case .success(let request) = decoded, request.cmd == "events.subscribe",
               let streamHandler {
                admitStreaming(client, request: request, streamHandler: streamHandler)
                return
            }
            // Every in-flight handler holds its client descriptor until the response is
            // written, so an unbounded count is fd-table exhaustion waiting to happen. Queue
            // briefly for a slot — handlers serialise behind the session actor anyway — and
            // shed with a prompt "busy" rather than a hang when none frees up.
            guard inFlightCount < Server.maximumInFlightConnections else {
                let waiter = AdmissionWaiter(fd: client, request: decoded)
                waiting.append(waiter)
                waiter.scheduleExpiry(on: ioQueue,
                    deadline: .now() + .nanoseconds(Int(Server.admissionWaitNanoseconds))) { [weak self] in
                    self?.expire($0)
                }
                return
            }
            inFlightCount += 1
            runOrdinary(client, request: decoded)
        }

        private func expire(_ waiter: AdmissionWaiter) {
            guard let index = waiting.firstIndex(where: { $0 === waiter }) else { return }
            waiting.remove(at: index)
            shed(waiter.fd, TransportError.busy(
                "\(Server.maximumInFlightConnections) requests are already in flight"))
        }

        /// Called when an ordinary handler finishes: pass the slot straight to the oldest
        /// waiter, or hand it back.
        private func releaseOrdinarySlot() {
            if !waiting.isEmpty {
                let next = waiting.removeFirst()
                next.timer?.cancel()
                next.timer = nil
                runOrdinary(next.fd, request: next.request)
                return
            }
            inFlightCount = max(0, inFlightCount - 1)
        }

        private func runOrdinary(_ client: Int32, request: Result<Request, Error>) {
            let handler = self.handler
            Task { [weak self] in
                let response: Response
                switch request {
                case .success(let request):
                    response = await handler(request)
                case .failure(let error):
                    response = .failure(TransportError.malformed("\(error)"))
                }
                // A slow reader gets the whole response only while this nonblocking writer's
                // absolute deadline permits; poll bounds waits across the whole body.
                Transport.write(
                    response,
                    to: client,
                    deadlineUptimeNanoseconds: DispatchTime.now().uptimeNanoseconds
                        &+ 30_000_000_000)
                close(client)
                guard let self else { return }
                self.ioQueue.async { self.releaseOrdinarySlot() }
            }
        }

        /// Answer a connection we will not serve. The socket has never been written to, so
        /// its send buffer is empty and this small body goes out in one non-blocking write;
        /// the deadline only guards the pathological case.
        private func shed(_ client: Int32, _ error: TransportError) {
            Transport.write(
                .failure(error),
                to: client,
                deadlineUptimeNanoseconds: DispatchTime.now().uptimeNanoseconds
                    &+ 1_000_000_000)
            close(client)
        }

        // MARK: Streaming (SPAO-214)

        /// One `events.subscribe` connection. `write` is the only writer on the descriptor;
        /// `shutdownForStop` may run concurrently from `stop()` and only shuts the socket
        /// down, leaving the final `close()` to the handler task that owns the descriptor.
        final class StreamingConnection: @unchecked Sendable {
            let fd: Int32
            private let stateLock = NSLock()
            private let writeLock = NSLock()
            private var closed = false
            /// Bound on one streamed line for a subscriber that stops draining.
            static let writeDeadlineNanoseconds: UInt64 = 10_000_000_000

            init(fd: Int32) { self.fd = fd }

            func write(_ response: Response) -> Bool {
                writeLock.lock()
                defer { writeLock.unlock() }
                guard !stateLock.withLock({ closed }) else { return false }
                guard StreamingConnection.peerIsConnected(fd) else { return false }
                return Transport.writeLine(
                    response,
                    to: fd,
                    deadlineUptimeNanoseconds: DispatchTime.now().uptimeNanoseconds
                        &+ StreamingConnection.writeDeadlineNanoseconds)
            }

            /// Fail every further write without closing the descriptor.
            func shutdownForStop() {
                stateLock.withLock {
                    guard !closed else { return }
                    _ = shutdown(fd, SHUT_RDWR)
                }
            }

            /// Owner-only: the handler has returned, so no writer is active.
            func closeDescriptor() {
                stateLock.withLock {
                    guard !closed else { return }
                    closed = true
                    close(fd)
                }
            }

            /// A subscriber never sends after its request, so a readable zero is EOF (the
            /// peer hung up), any other byte is noise we tolerate, and `EAGAIN` means the
            /// peer is simply quiet.
            static func peerIsConnected(_ fd: Int32) -> Bool {
                var byte: UInt8 = 0
                let n = recv(fd, &byte, 1, MSG_PEEK | MSG_DONTWAIT)
                if n == 0 { return false }
                if n < 0 {
                    let failure = errno
                    return failure == EAGAIN || failure == EWOULDBLOCK || failure == EINTR
                }
                return true
            }
        }

        private func admitStreaming(
            _ client: Int32,
            request: Request,
            streamHandler: @escaping @Sendable (Request, @escaping StreamWriter) async -> Void
        ) {
            guard streamingCount < Server.maximumStreamingConnections else {
                shed(client, TransportError.busy("too many event subscribers"))
                return
            }
            streamingCount += 1
            let connection = StreamingConnection(fd: client)
            streaming[client] = connection
            let writer: StreamWriter = { response in connection.write(response) }
            Task { [weak self] in
                await streamHandler(request, writer)
                connection.closeDescriptor()
                guard let self else { return }
                self.ioQueue.async {
                    self.streaming.removeValue(forKey: client)
                    self.streamingCount = max(0, self.streamingCount - 1)
                }
            }
        }

        public func stop() {
            let stoppedGeneration = stateLock.withLock { generation }
            releaseListener(markStopping: true)
            // Connections still reading their request are dropped; queued waiters are told
            // the daemon is gone; subscribers are shut down so their handlers see a failed
            // write and return. Ordinary in-flight handlers finish on their own, as before.
            ioQueue.async { [weak self] in
                guard let self,
                      self.stateLock.withLock({ self.generation }) == stoppedGeneration
                else { return }
                for connection in Array(self.pending.values) {
                    self.finishReading(connection, .close)
                }
                let waiters = self.waiting
                self.waiting.removeAll()
                for waiter in waiters {
                    waiter.timer?.cancel()
                    waiter.timer = nil
                    self.shed(waiter.fd, TransportError.notRunning(self.path))
                }
                for connection in self.streaming.values {
                    connection.shutdownForStop()
                }
            }
        }

        /// Close the listening descriptor and give up the pathname.
        ///
        /// `stop()` uses it to shut the server down; the accept loop uses it when the listener
        /// has died underneath it, so that `start()`'s guard can re-arm instead of seeing a
        /// socket this process still claims to own.
        ///
        /// Closing is also what releases a peer thread blocked in `accept()`: Darwin wakes it
        /// with `ECONNABORTED`. `shutdown()` on a listening socket only returns `ENOTCONN`.
        private func releaseListener(markStopping: Bool, retiring ownThread: Thread? = nil) {
            stateLock.withLock {
                if markStopping { stopping = true }
                // Finish pathname cleanup before start() can observe released state.
                // Otherwise retirement can remove the stale socket while start() is
                // inspecting it, making re-arming fail with ENOENT.
                if listenFD >= 0 { close(listenFD) }
                if ownsSocket {
                    var current = stat()
                    if lstat(path, &current) == 0,
                       current.st_dev == socketDevice,
                       current.st_ino == socketInode {
                        unlink(path)
                    }
                }
                if let ownThread, thread === ownThread { thread = nil }
                listenFD = -1
                ownsSocket = false
                socketDevice = nil
                socketInode = nil
            }
        }
    }

    // MARK: - Client

    private static let clientLabelLock = NSLock()
    nonisolated(unsafe) private static var clientLabel: String?

    /// Set once at process start (`cli`, `mcp`, `viewer`) so the daemon log can attribute every
    /// request to the surface that made it. Requests that already carry a label keep it.
    public static func setClientLabel(_ label: String?) {
        clientLabelLock.withLock { clientLabel = label.map { String($0.prefix(32)) } }
    }

    public static func send(_ request: Request, to path: String, timeout: TimeInterval = 60) throws -> Response {
        var request = request
        if request.diagnosticClient == nil {
            request.diagnosticClient = clientLabelLock.withLock { clientLabel }
        }
        let payload = try Wire.encoder.encode(request)
        guard payload.count <= 1_048_576 else {
            throw TransportError.malformed("request exceeds the 1 MiB wire limit")
        }
        let response = try sendLinePayload(
            payload,
            to: path,
            timeout: timeout,
            maximumRequestBytes: 1_048_576,
            maximumResponseBytes: 8 * 1_048_576)
        return try Wire.decoder.decode(Response.self, from: response)
    }

    /// Bounded one-request/one-response Unix-socket exchange shared by the daemon wire protocol
    /// and private semantic renderer adapters.
    static func sendLinePayload(
        _ unframedPayload: Data,
        to path: String,
        timeout: TimeInterval,
        maximumRequestBytes: Int,
        maximumResponseBytes: Int
    ) throws -> Data {
        guard timeout.isFinite, timeout > 0, timeout <= 3_600 else {
            throw TransportError.socketFailed(
                "timeout must be a finite value greater than zero and at most 3600 seconds")
        }
        guard maximumRequestBytes > 0, maximumResponseBytes > 0,
              unframedPayload.count <= maximumRequestBytes else {
            throw TransportError.malformed("request exceeds its wire limit")
        }
        // One deadline covers framing, connection, upload, and response reception. Keep the
        // descriptor nonblocking so an individual syscall cannot spend a fresh full timeout.
        let deadline = DispatchTime.now().uptimeNanoseconds
            &+ UInt64(timeout * 1_000_000_000)
        var payload = unframedPayload
        payload.append(0x0A)
        let fd = try openConnection(to: path, deadlineUptimeNanoseconds: deadline)
        defer { close(fd) }
        guard writeAll(payload, to: fd, deadlineUptimeNanoseconds: deadline) else {
            throw TransportError.socketFailed("request write failed or timed out")
        }

        guard let line = readFrame(
            from: fd,
            maximumBytes: maximumResponseBytes,
            deadlineUptimeNanoseconds: deadline) else {
            throw TransportError.socketFailed(
                "peer closed the connection, timed out, or exceeded the response limit")
        }
        return line
    }

    // MARK: - Event subscription client (SPAO-214)

    /// A long-lived `events.subscribe` connection: one request line out, then one `Response`
    /// per newline-delimited line in until the daemon closes, an error occurs, or `cancel()`.
    ///
    /// Responses run on the private reader thread. `onClose` fires exactly once on the thread
    /// completing setup, cancellation, or reading; nil means clean EOF or cancellation.
    public final class EventSubscription: @unchecked Sendable {
        /// Bound on `start()`'s connect and request write.
        static let connectTimeout: TimeInterval = 5
        /// One streamed line may be as large as one ordinary response.
        static let maximumLineBytes = 8 * 1_048_576

        private let path: String
        private var request: Request?
        private var onResponse: (@Sendable (Response) -> Void)?
        private var onClose: (@Sendable (Error?) -> Void)?
        private let lock = NSLock()
        private var fd: Int32 = -1
        private var thread: Thread?
        private var started = false
        private var cancelled = false
        private var finished = false

        public init(
            path: String,
            sinceSeq: UInt64,
            request: Request? = nil,
            onResponse: @escaping @Sendable (Response) -> Void,
            onClose: @escaping @Sendable (Error?) -> Void
        ) {
            self.path = path
            var request = request ?? Request(cmd: "events.subscribe")
            if request.sinceSeq == nil { request.sinceSeq = sinceSeq }
            self.request = request
            self.onResponse = onResponse
            self.onClose = onClose
        }

        /// Connected and still reading. `false` before `start()`, after `cancel()`, and once
        /// `onClose` has fired.
        public var isRunning: Bool {
            lock.withLock { started && !finished && !cancelled && fd >= 0 && thread != nil }
        }

        /// Connect, send the request line, and begin reading on a background thread. Errors
        /// are reported through `onClose`; calling `start()` twice is a no-op.
        public func start() {
            let request: Request? = lock.withLock {
                guard !started, !finished, !cancelled else { return nil }
                started = true
                defer { self.request = nil }
                return self.request
            }
            guard let request else { return }

            let deadline = DispatchTime.now().uptimeNanoseconds
                &+ UInt64(EventSubscription.connectTimeout * 1_000_000_000)
            let payload: Data
            let socketFD: Int32
            do {
                var encoded = try Wire.encoder.encode(request)
                guard encoded.count <= 1_048_576 else {
                    throw TransportError.malformed("request exceeds the 1 MiB wire limit")
                }
                encoded.append(0x0A)
                payload = encoded
                guard !lock.withLock({ cancelled }) else { finish(with: nil); return }
                socketFD = try Transport.makeClientSocket()
            } catch {
                finish(with: error)
                return
            }

            let registered = lock.withLock {
                guard !cancelled, !finished else { return false }
                fd = socketFD
                return true
            }
            guard registered else {
                close(socketFD)
                finish(with: nil)
                return
            }
            // Setup owns the descriptor until a reader is registered. cancel() only shuts it
            // down; it never closes a descriptor still borrowed by connect/write/poll.
            do {
                try Transport.connect(fd: socketFD, to: path,
                    deadlineUptimeNanoseconds: deadline,
                    isCancelled: { self.lock.withLock { self.cancelled } })
                guard !lock.withLock({ cancelled }),
                      Transport.writeAll(payload, to: socketFD,
                                         deadlineUptimeNanoseconds: deadline) else {
                    throw TransportError.socketFailed("could not send the subscription request")
                }
            } catch {
                retireSocket(socketFD)
                finish(with: error)
                return
            }

            let thread = Thread { [weak self] in
                // The handle can disappear before the thread first runs. Its socket still
                // needs an owner to close it even when there is no receiver left to call.
                guard let self else { close(socketFD); return }
                self.readLoop(socketFD)
            }
            thread.name = "spaceo.events.subscription"
            let handedOff = lock.withLock {
                guard !cancelled, !finished else { return false }
                self.thread = thread
                return true
            }
            guard handedOff else {
                retireSocket(socketFD)
                finish(with: nil)
                return
            }
            thread.start()
        }

        /// Stop setup or reading. Shutdown wakes pending I/O; its current owner closes the
        /// descriptor after relinquishing it. Cancellation before start is terminal as well.
        public func cancel() {
            let finishNow = lock.withLock {
                guard !cancelled else { return false }
                cancelled = true
                request = nil
                if fd >= 0 { _ = shutdown(fd, SHUT_RDWR) }
                return thread == nil
            }
            if finishNow { finish(with: nil) }
        }

        private func retireSocket(_ socketFD: Int32) {
            lock.withLock {
                if fd == socketFD { fd = -1 }
                thread = nil
            }
            // Clear registration before close, so a racing cancel cannot shut down a reused fd.
            close(socketFD)
        }

        private func readLoop(_ socketFD: Int32) {
            let error = receiveResponses(socketFD)
            retireSocket(socketFD)
            finish(with: error)
        }

        private func receiveResponses(_ socketFD: Int32) -> Error? {
            var buffer = LineBuffer(maximumBytes: EventSubscription.maximumLineBytes)
            var chunk = [UInt8](repeating: 0, count: 8_192)
            while true {
                if lock.withLock({ cancelled }) { return nil }
                let n = read(socketFD, &chunk, chunk.count)
                if n > 0 {
                    do {
                        try buffer.append(chunk[0..<n])
                    } catch { return error }
                    while let line = buffer.nextLine() {
                        if lock.withLock({ cancelled }) { return nil }
                        guard let response = try? Wire.decoder.decode(Response.self, from: line) else {
                            return TransportError.malformed("event stream line is not a Response")
                        }
                        let callback = lock.withLock { cancelled ? nil : onResponse }
                        guard let callback else { return nil }
                        callback(response)
                    }
                    continue
                }
                if n == 0 {
                    return buffer.hasPartialLine && !lock.withLock({ cancelled })
                        ? TransportError.malformed("event stream ended with an incomplete line") : nil
                }
                let failure = errno
                if failure == EINTR { continue }
                if lock.withLock({ cancelled }) { return nil }
                if failure == EAGAIN || failure == EWOULDBLOCK {
                    guard Transport.wait(fd: socketFD, for: Int16(POLLIN),
                                         deadlineUptimeNanoseconds: nil) else {
                        return TransportError.socketFailed("subscription read poll failed")
                    }
                    continue
                }
                return TransportError.socketFailed("read(): \(failure)")
            }
        }

        private func finish(with error: Error?) {
            let callbacks: (response: (@Sendable (Response) -> Void)?,
                            close: (@Sendable (Error?) -> Void)?, error: Error?)? = lock.withLock {
                guard !finished else { return nil }
                finished = true
                let retained = (onResponse, onClose, cancelled ? nil : error)
                onResponse = nil
                onClose = nil
                request = nil
                return retained
            }
            guard let callbacks else { return }
            // Captures can deinitialize owners that reenter cancel(). Release them outside
            // the lock, including the response closure that is no longer needed.
            withExtendedLifetime(callbacks) { callbacks.close?(callbacks.error) }
        }
    }

    public static func subscribe(
        to path: String,
        sinceSeq: UInt64,
        request: Request? = nil,
        onResponse: @escaping @Sendable (Response) -> Void,
        onClose: @escaping @Sendable (Error?) -> Void
    ) -> EventSubscription {
        let subscription = EventSubscription(
            path: path,
            sinceSeq: sinceSeq,
            request: request,
            onResponse: onResponse,
            onClose: onClose)
        subscription.start()
        return subscription
    }

    /// Splits a byte stream into newline-delimited lines without losing bytes that arrive
    /// after a terminator, which `readLine` deliberately discards for one-shot connections.
    struct LineBuffer {
        private var data = Data()
        private let maximumBytes: Int
        private var consumed = 0
        private var searched = 0
        private var tailBytes = 0

        init(maximumBytes: Int) { self.maximumBytes = maximumBytes }

        var hasPartialLine: Bool { tailBytes != 0 }

        mutating func append<Bytes: Collection>(_ bytes: Bytes) throws where Bytes.Element == UInt8 {
            // Validate before retaining the new chunk. A terminator must not exempt either
            // its preceding line or a subsequent incomplete tail from the byte limit.
            let tail = try endingTail(after: bytes)
            discardConsumedPrefix()
            data.append(contentsOf: bytes)
            tailBytes = tail
        }

        private func endingTail<Bytes: Collection>(after bytes: Bytes) throws -> Int where Bytes.Element == UInt8 {
            // Socket chunks are contiguous. Check lengths between newlines in bulk instead
            // of executing a Swift branch and counter update for every payload byte.
            if let result = try bytes.withContiguousStorageIfAvailable({ buffer -> Int in
                var tail = tailBytes
                guard let base = buffer.baseAddress else { return tail }
                var offset = 0
                while offset < buffer.count {
                    let newline = memchr(base + offset, 0x0A, buffer.count - offset)
                    let end = newline.map { base.distance(to: $0.assumingMemoryBound(to: UInt8.self)) }
                        ?? buffer.count
                    let length = end - offset
                    if length > 0 {
                        guard tail <= maximumBytes, length <= maximumBytes - tail else {
                            throw TransportError.malformed("line exceeds the \(maximumBytes) byte limit")
                        }
                        tail += length
                    }
                    guard newline != nil else { break }
                    tail = 0
                    offset = end + 1
                }
                return tail
            }) { return result }

            // Preserve collection support without allocating a contiguous staging copy.
            var tail = tailBytes
            for byte in bytes {
                if byte == 0x0A { tail = 0 }
                else {
                    guard tail < maximumBytes else {
                        throw TransportError.malformed("line exceeds the \(maximumBytes) byte limit")
                    }
                    tail += 1
                }
            }
            return tail
        }

        /// Search only bytes not already inspected. Keep consumed offsets while draining
        /// coalesced lines, then compact once rather than shifting after every terminator.
        mutating func nextLine() -> Data? {
            guard let newline = data[searched...].firstIndex(of: 0x0A) else {
                searched = data.endIndex
                discardConsumedPrefix()
                return nil
            }
            // A single complete frame can transfer its backing storage to the decoder.
            // Avoid constructing another frame-sized Data value before decoding.
            if consumed == 0, newline == data.endIndex - 1 {
                data.removeLast()
                let line = data
                data = Data()
                searched = 0
                return line
            }
            let line = data.subdata(in: consumed..<newline)
            consumed = newline + 1
            searched = consumed
            if consumed == data.endIndex { discardConsumedPrefix() }
            return line
        }

        private mutating func discardConsumedPrefix() {
            guard consumed > 0 else { return }
            data = consumed == data.endIndex ? Data() : Data(data[consumed...])
            searched -= consumed
            consumed = 0
        }
    }

    // MARK: - Framing

    /// A connected, nonblocking, `SO_NOSIGPIPE` descriptor. The caller owns it and must poll
    /// on EAGAIN; a blocking syscall must never extend the caller's absolute deadline.
    fileprivate static func openConnection(to path: String, deadlineUptimeNanoseconds: UInt64) throws -> Int32 {
        let fd = try makeClientSocket()
        do {
            try connect(fd: fd, to: path, deadlineUptimeNanoseconds: deadlineUptimeNanoseconds)
        } catch {
            close(fd)
            throw error
        }
        return fd
    }

    fileprivate static func makeClientSocket() throws -> Int32 {
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw TransportError.socketFailed("socket(): \(errno)") }
        var noSignal: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &noSignal, socklen_t(MemoryLayout<Int32>.size))
        return fd
    }

    fileprivate static func connect(
        fd: Int32, to path: String, deadlineUptimeNanoseconds: UInt64,
        isCancelled: (() -> Bool)? = nil
    ) throws {
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let maxLength = MemoryLayout.size(ofValue: address.sun_path)
        guard !path.isEmpty, !path.utf8.contains(0), path.utf8.count < maxLength else {
            throw TransportError.socketFailed("socket path too long: \(path)")
        }
        withUnsafeMutablePointer(to: &address.sun_path) { pointer in
            pointer.withMemoryRebound(to: CChar.self, capacity: maxLength) { _ = strcpy($0, path) }
        }
        try connect(fd: fd, address: &address, size: socklen_t(MemoryLayout<sockaddr_un>.size),
                    deadlineUptimeNanoseconds: deadlineUptimeNanoseconds, path: path,
                    isCancelled: isCancelled)
    }

    fileprivate static func connect(
        fd: Int32,
        address: inout sockaddr_un,
        size: socklen_t,
        deadlineUptimeNanoseconds: UInt64,
        path: String,
        isCancelled: (() -> Bool)? = nil
    ) throws {
        guard isCancelled?() != true else { throw CancellationError() }
        guard DispatchTime.now().uptimeNanoseconds < deadlineUptimeNanoseconds else {
            throw TransportError.socketFailed("connect timed out")
        }
        let priorFlags = fcntl(fd, F_GETFL)
        guard priorFlags >= 0,
              fcntl(fd, F_SETFL, priorFlags | O_NONBLOCK) == 0 else {
            throw TransportError.socketFailed("could not make connect nonblocking: \(errno)")
        }

        let result = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.connect(fd, $0, size)
            }
        }
        if result == 0 {
            guard isCancelled?() != true else { throw CancellationError() }
            guard DispatchTime.now().uptimeNanoseconds < deadlineUptimeNanoseconds else {
                throw TransportError.socketFailed("connect timed out")
            }
            return
        }
        guard errno == EINPROGRESS || errno == EAGAIN else {
            throw TransportError.notRunning(path)
        }
        // Recompute the remaining poll time after every EINTR, without restarting the budget.
        guard wait(fd: fd, for: Int16(POLLOUT),
                   deadlineUptimeNanoseconds: deadlineUptimeNanoseconds,
                   isCancelled: isCancelled) else {
            throw TransportError.socketFailed("connect cancelled, timed out, or poll failed")
        }

        var socketError: Int32 = 0
        var errorLength = socklen_t(MemoryLayout<Int32>.size)
        guard getsockopt(
            fd, SOL_SOCKET, SO_ERROR, &socketError, &errorLength) == 0 else {
            throw TransportError.socketFailed("connect status failed: \(errno)")
        }
        guard socketError == 0 else { throw TransportError.notRunning(path) }
        guard isCancelled?() != true else { throw CancellationError() }
        guard DispatchTime.now().uptimeNanoseconds < deadlineUptimeNanoseconds else {
            throw TransportError.socketFailed("connect timed out")
        }
    }

    /// Blocks until `fd` is ready for `events`, or the deadline passes.
    ///
    /// A nonblocking socket reports EAGAIN when the peer is not ready. Blocking descriptors
    /// with a per-syscall timeout may do the same. Waiting here avoids a busy retry loop and
    /// recomputes the remaining absolute budget after interrupted polls.
    /// A nil deadline waits indefinitely unless an optional cancellation predicate stops it.
    static func wait(
        fd: Int32,
        for events: Int16,
        deadlineUptimeNanoseconds: UInt64?,
        isCancelled: (() -> Bool)? = nil
    ) -> Bool {
        var descriptor = pollfd(fd: fd, events: events, revents: 0)
        while true {
            guard isCancelled?() != true else { return false }
            var milliseconds: Int32 = -1
            if let deadlineUptimeNanoseconds {
                let now = DispatchTime.now().uptimeNanoseconds
                guard now < deadlineUptimeNanoseconds else { return false }
                let remaining = deadlineUptimeNanoseconds - now
                let rounded = remaining / 1_000_000 + (remaining % 1_000_000 == 0 ? 0 : 1)
                milliseconds = Int32(min(UInt64(Int32.max), rounded))
            }
            // Shutdown need not wake a not-yet-connected socket. Only cancellable setup
            // polls use a short slice; established idle streams still sleep indefinitely.
            if isCancelled != nil { milliseconds = milliseconds < 0 ? 50 : min(milliseconds, 50) }
            let ready = Darwin.poll(&descriptor, 1, milliseconds)
            if ready < 0 {
                if errno == EINTR { continue }
                return false
            }
            if ready == 0, isCancelled != nil { continue }
            guard isCancelled?() != true else { return false }
            // Zero is the deadline; POLLHUP/POLLERR come back ready and are diagnosed by the
            // read()/write() that follows.
            return ready > 0
        }
    }

    /// Reject before retaining bytes. Appending even one byte beyond a full frame may grow
    /// Data's backing allocation; malformed input must not trigger that avoidable copy.
    static func appendFrameBytes<Bytes: Collection>(
        _ bytes: Bytes, to data: inout Data, maximumBytes: Int
    ) -> Bool where Bytes.Element == UInt8 {
        guard maximumBytes >= 0, data.count <= maximumBytes,
              bytes.count <= maximumBytes - data.count else { return false }
        data.append(contentsOf: bytes)
        return true
    }

    static func readLine(
        from fd: Int32,
        maximumBytes: Int = 8 * 1_048_576,
        deadlineUptimeNanoseconds: UInt64? = nil
    ) -> String? {
        guard let data = readFrame(from: fd, maximumBytes: maximumBytes,
                                   deadlineUptimeNanoseconds: deadlineUptimeNanoseconds) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    /// Retain the framed bytes for JSON decoding rather than reconstructing them from text.
    /// Preserve the existing invalid-UTF-8 refusal before passing bytes to JSON decoding.
    /// Socket callers requiring a deadline must use nonblocking descriptors.
    static func readFrame(
        from fd: Int32,
        maximumBytes: Int = 8 * 1_048_576,
        deadlineUptimeNanoseconds: UInt64? = nil
    ) -> Data? {
        guard maximumBytes > 0 else { return nil }
        var accumulated = Data()
        // Messages are typically a couple of KiB; the loop already accumulates larger ones
        // across reads, so a bigger zero-filled buffer per call would be pure waste.
        var chunk = [UInt8](repeating: 0, count: 8_192)
        // A message is only a message once its terminator arrives. Without this flag a receive
        // timeout or a mid-message EOF hands the caller a truncated prefix that is
        // indistinguishable from a complete line.
        var sawTerminator = false
        while true {
            if let deadlineUptimeNanoseconds,
               DispatchTime.now().uptimeNanoseconds >= deadlineUptimeNanoseconds {
                return nil
            }
            let n = read(fd, &chunk, chunk.count)
            if n < 0 {
                if errno == EINTR { continue }
                if errno == EAGAIN || errno == EWOULDBLOCK {
                    guard wait(fd: fd, for: Int16(POLLIN),
                               deadlineUptimeNanoseconds: deadlineUptimeNanoseconds) else {
                        return nil
                    }
                    continue
                }
                return nil
            }
            if n == 0 { break }
            // The protocol is one message per connection, so nothing ever reads the bytes
            // after the newline; over-reading them into this buffer loses nothing.
            let newline = chunk[0..<n].firstIndex(of: 0x0A)
            guard appendFrameBytes(chunk[0..<(newline ?? n)], to: &accumulated,
                                   maximumBytes: maximumBytes) else { return nil }
            if newline != nil {
                sawTerminator = true
                break
            }
        }
        guard sawTerminator, !accumulated.isEmpty,
              String(data: accumulated, encoding: .utf8) != nil else { return nil }
        if let deadlineUptimeNanoseconds,
           DispatchTime.now().uptimeNanoseconds >= deadlineUptimeNanoseconds { return nil }
        return accumulated
    }

    static func write(
        _ response: Response,
        to fd: Int32,
        deadlineUptimeNanoseconds: UInt64? = nil
    ) {
        _ = writeLine(response, to: fd, deadlineUptimeNanoseconds: deadlineUptimeNanoseconds)
    }

    /// Encode `response` as one newline-terminated line and send all of it. `false` means
    /// timely delivery is unconfirmed: encoding failed, a write errored, or the deadline
    /// passed. A timeout does not prove the peer received none (or only part) of the frame.
    static func writeLine(
        _ response: Response,
        to fd: Int32,
        deadlineUptimeNanoseconds: UInt64? = nil
    ) -> Bool {
        guard var payload = try? Wire.encoder.encode(response) else { return false }
        if payload.count > 8 * 1_048_576 {
            guard let fallback = try? Wire.encoder.encode(
                Response.failure(TransportError.malformed(
                    "response exceeds the 8 MiB wire limit"))) else { return false }
            payload = fallback
        }
        payload.append(0x0A)
        return writeAll(payload, to: fd, deadlineUptimeNanoseconds: deadlineUptimeNanoseconds)
    }

    /// Send every byte of `payload`, waiting out `EAGAIN` against the deadline. Socket callers
    /// must supply nonblocking descriptors; synchronous regular-file writes are not preemptible.
    static func writeAll(
        _ payload: Data,
        to fd: Int32,
        deadlineUptimeNanoseconds: UInt64? = nil
    ) -> Bool {
        payload.withUnsafeBytes { buffer -> Bool in
            guard let base = buffer.baseAddress else { return buffer.isEmpty }
            var sent = 0
            while sent < buffer.count {
                if let deadlineUptimeNanoseconds,
                   DispatchTime.now().uptimeNanoseconds >= deadlineUptimeNanoseconds { return false }
                let n = Foundation.write(fd, base.advanced(by: sent), buffer.count - sent)
                if n > 0 {
                    sent += n
                    continue
                }
                if n < 0 {
                    if errno == EINTR { continue }
                    // A response larger than the socket buffer must wait for the peer to drain it.
                    // Abandoning the tail here would emit a newline-less body and read to the
                    // client as malformed JSON rather than as the slow reader it is.
                    if errno == EAGAIN || errno == EWOULDBLOCK,
                       wait(fd: fd, for: Int16(POLLOUT),
                            deadlineUptimeNanoseconds: deadlineUptimeNanoseconds) {
                        continue
                    }
                }
                return false
            }
            if let deadlineUptimeNanoseconds,
               DispatchTime.now().uptimeNanoseconds >= deadlineUptimeNanoseconds { return false }
            return true
        }
    }

    public static func ping(_ path: String) -> Bool {
        pingResponse(path)?.ok == true
    }

    /// The daemon's complete ping response, including executable provenance on current daemons.
    /// Older daemons decode normally and simply omit `daemon`, which lets callers warn that the
    /// exact serving image is unknown without misclassifying a healthy legacy process as dead.
    public static func pingResponse(_ path: String) -> Response? {
        guard FileManager.default.fileExists(atPath: path) else { return nil }
        var request = Request(cmd: "ping")
        request.session = nil
        return try? send(request, to: path, timeout: 2)
    }

    /// Whether something accepts connections at `path`, whether or not it answers. Lets doctor
    /// tell a busy daemon from an absent one after a ping timed out.
    public static func isListening(_ path: String) -> Bool {
        FileManager.default.fileExists(atPath: path) && canConnect(path)
    }

    /// Does any process currently accept connections at this path?
    ///
    /// Used only after a SpaceO ping failed. A successful connection means the pathname is
    /// occupied and must not be treated as a stale inode just because the peer speaks a
    /// different protocol or is temporarily overloaded.
    private static func canConnect(_ path: String) -> Bool {
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { return false }
        defer { close(fd) }
        var noSignal: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &noSignal,
                   socklen_t(MemoryLayout<Int32>.size))

        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let maxLength = MemoryLayout.size(ofValue: address.sun_path)
        guard !path.isEmpty, !path.utf8.contains(0),
              path.utf8.count < maxLength else { return false }
        withUnsafeMutablePointer(to: &address.sun_path) { pointer in
            pointer.withMemoryRebound(to: CChar.self, capacity: maxLength) { dst in
                _ = strcpy(dst, path)
            }
        }
        let size = socklen_t(MemoryLayout<sockaddr_un>.size)
        let priorFlags = fcntl(fd, F_GETFL)
        guard priorFlags >= 0,
              fcntl(fd, F_SETFL, priorFlags | O_NONBLOCK) == 0 else {
            return true
        }
        let result = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.connect(fd, $0, size)
            }
        }
        if result == 0 { return true }
        // An in-progress or backlogged connection still proves the pathname is occupied.
        // Only a definitive "no listener/path" result makes stale-socket removal safe.
        return errno != ECONNREFUSED && errno != ENOENT
    }
}
