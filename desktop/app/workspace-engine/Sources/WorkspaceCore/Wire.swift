// How engine processes talk to the background process that owns the display: JSON objects, one per
// line, over a Unix socket in the engine's folder. Every request carries an "id" and its reply
// carries the same one, so one connection can have several requests in flight.
import Darwin
import Foundation

public enum Wire {
    /// The daemon's socket. In the engine's folder when the path fits a socket address (104 bytes),
    /// else in the per-user temporary folder under a name derived from the state folder.
    public static func socketPath(state: URL, environment: [String: String] = ProcessInfo.processInfo.environment) -> String {
        if let custom = environment["HIVE_WORKSPACE_SOCKET"], !custom.isEmpty { return custom }
        let path = Paths.engineDir(state: state).appendingPathComponent("daemon.sock").path
        if path.utf8.count < 100 { return path }
        var buffer = [CChar](repeating: 0, count: 1024)
        let length = confstr(_CS_DARWIN_USER_TEMP_DIR, &buffer, buffer.count)
        let temporary = length > 0 ? String(cString: buffer) : "/tmp/"
        return temporary + "hive-workspace-\(fnv1a(state.standardizedFileURL.path)).sock"
    }

    static func fnv1a(_ text: String) -> String {
        var hash: UInt64 = 0xcbf29ce484222325
        for byte in text.utf8 {
            hash ^= UInt64(byte)
            hash = hash &* 0x100000001b3
        }
        return String(hash, radix: 16)
    }

    static func address(_ path: String) throws -> sockaddr_un {
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8)
        guard bytes.count < MemoryLayout.size(ofValue: address.sun_path) else {
            throw WorkspaceError("io", "socket path too long: \(path)")
        }
        withUnsafeMutableBytes(of: &address.sun_path) { raw in
            for (i, byte) in bytes.enumerated() { raw[i] = byte }
            raw[bytes.count] = 0
        }
        return address
    }

    /// A connected socket, or nil when nothing listens there.
    public static func connect(_ path: String) -> Int32? {
        guard var address = try? address(path) else { return nil }
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { return nil }
        var one: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
        let result = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        if result != 0 {
            close(fd)
            return nil
        }
        return fd
    }

    /// A listening socket at `path`, readable and writable only by this user.
    public static func listen(_ path: String) throws -> Int32 {
        var address = try address(path)
        try FileManager.default.createDirectory(atPath: (path as NSString).deletingLastPathComponent,
                                                withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        unlink(path)
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw WorkspaceError("io", "could not make a socket") }
        let bound = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard bound == 0, chmod(path, 0o600) == 0, Darwin.listen(fd, 16) == 0 else {
            close(fd)
            throw WorkspaceError("io", "could not listen on \(path)")
        }
        return fd
    }
}

/// One end of a connection: whole lines in, whole lines out.
public final class LineChannel {
    public let fd: Int32
    private var buffer = Data()
    private let writeLock = NSLock()
    private var closed = false
    private let closeLock = NSLock()

    public init(fd: Int32) {
        self.fd = fd
        var one: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
    }

    /// The next JSON object, or nil at the end of the stream. Lines that aren't objects are skipped.
    public func readObject() -> [String: Any]? {
        while true {
            if let newline = buffer.firstIndex(of: 0x0A) {
                let line = buffer[buffer.startIndex..<newline]
                buffer.removeSubrange(buffer.startIndex...newline)
                if let object = try? JSONSerialization.jsonObject(with: line) as? [String: Any] { return object }
                continue
            }
            var chunk = [UInt8](repeating: 0, count: 65536)
            let count = read(fd, &chunk, chunk.count)
            if count < 0 && errno == EINTR { continue }
            if count <= 0 { return nil }
            buffer.append(contentsOf: chunk[0..<count])
            if buffer.count > 64 * 1024 * 1024 { return nil }  // a peer that never ends a line
        }
    }

    @discardableResult
    public func write(_ object: [String: Any]) -> Bool {
        guard JSONSerialization.isValidJSONObject(object),
              var data = try? JSONSerialization.data(withJSONObject: object) else { return false }
        data.append(0x0A)
        writeLock.lock()
        defer { writeLock.unlock() }
        var offset = 0
        while offset < data.count {
            let written = data.withUnsafeBytes { Darwin.write(fd, $0.baseAddress! + offset, data.count - offset) }
            if written < 0 && errno == EINTR { continue }
            if written <= 0 { return false }
            offset += written
        }
        return true
    }

    public func close() {
        closeLock.lock()
        defer { closeLock.unlock() }
        if !closed {
            closed = true
            shutdown(fd, SHUT_RDWR)
            Darwin.close(fd)
        }
    }
}

/// A connection to the daemon. Replies are matched to requests by id.
public final class DaemonClient {
    final class Waiter {
        let done = DispatchSemaphore(value: 0)
        var reply: [String: Any]?
    }

    let channel: LineChannel
    private let lock = NSLock()
    private var waiters: [Int: Waiter] = [:]
    private var serial = 0
    private var open = true
    /// Called once, on the reader thread, when the daemon goes away.
    public var onClose: (() -> Void)?

    /// Connects as `role` ("mcp", "cli" or "viewer"); nil when no daemon is listening.
    public init?(path: String, role: String) {
        guard let fd = Wire.connect(path) else { return nil }
        channel = LineChannel(fd: fd)
        let thread = Thread { [weak self] in self?.readLoop() }
        thread.name = "workspace-daemon-reader"
        thread.start()
        guard (try? send("hello", ["role": role, "pid": Int(getpid())], timeout: 10)) != nil else {
            close()
            return nil
        }
    }

    public var isOpen: Bool {
        lock.lock()
        defer { lock.unlock() }
        return open
    }

    private func readLoop() {
        while let object = channel.readObject() {
            guard let id = object["id"] as? Int else { continue }
            lock.lock()
            let waiter = waiters.removeValue(forKey: id)
            lock.unlock()
            waiter?.reply = object
            waiter?.done.signal()
        }
        lock.lock()
        open = false
        let pending = waiters
        waiters.removeAll()
        lock.unlock()
        for waiter in pending.values { waiter.done.signal() }
        onClose?()
    }

    /// Sends one request and waits for its reply's fields. Throws when the daemon refuses
    /// (`ok: false`), goes away or takes longer than `timeout` seconds.
    @discardableResult
    public func send(_ op: String, _ fields: [String: Any] = [:], timeout: Double = 90) throws -> [String: Any] {
        let waiter = Waiter()
        lock.lock()
        guard open else {
            lock.unlock()
            throw WorkspaceError("daemon_gone", "the workspace engine's background process is not running")
        }
        serial += 1
        let id = serial
        waiters[id] = waiter
        lock.unlock()
        var request = fields
        request["id"] = id
        request["op"] = op
        guard channel.write(request) else {
            lock.lock()
            waiters.removeValue(forKey: id)
            lock.unlock()
            throw WorkspaceError("daemon_gone", "the workspace engine's background process is not running")
        }
        if waiter.done.wait(timeout: .now() + timeout) == .timedOut {
            lock.lock()
            waiters.removeValue(forKey: id)
            lock.unlock()
            throw WorkspaceError("timeout", "\(op) did not answer within \(Int(timeout)) seconds")
        }
        guard let reply = waiter.reply else {
            throw WorkspaceError("daemon_gone", "the workspace engine's background process went away")
        }
        if reply["ok"] as? Bool != true {
            let code = reply["code"] as? String ?? "failed"
            throw WorkspaceError(code, reply["error"] as? String ?? "the request failed")
        }
        return reply
    }

    public func close() {
        channel.close()
    }
}
