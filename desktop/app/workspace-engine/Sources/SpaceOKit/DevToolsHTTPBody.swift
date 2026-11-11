import Foundation

/// Accumulates bounded delegate chunks rather than buffering an unbounded completion-handler
/// response or hopping through AsyncBytes for every byte. The lock also covers deadline cleanup.
final class DevToolsHTTPBody: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private let maximumBytes: Int
    private let descriptionText: String
    private var data = Data()
    private var completion: (@Sendable (Result<Data, Error>) -> Void)?
    private var closed = false
    private var acceptedResponse = false

    private init(maximumBytes: Int, description: String) {
        self.maximumBytes = maximumBytes
        descriptionText = description
        super.init()
        data.reserveCapacity(min(maximumBytes, 64 * 1024))
    }

    static func read(session: URLSession, request: URLRequest, maximumBytes: Int,
                     description: String, budget: DevToolsDeadline?) async throws -> Data {
        guard maximumBytes > 0 else {
            throw SpaceOError.badRequest("DevTools response limit must be positive")
        }
        let remaining = try budget?.remaining() ?? 15
        let timeout = min(15, remaining)
        let timeoutError: Error = budget != nil && remaining <= 15
            ? DevToolsDeadline.Exceeded()
            : SpaceOError.badRequest("DevTools \(description) response timed out")
        let reader = DevToolsHTTPBody(maximumBytes: maximumBytes, description: description)
        let task = session.dataTask(with: request)
        task.delegate = reader
        defer { reader.discard(); task.cancel() }
        do {
            let result = try await CallbackDeadline.firstCompletion(
                within: timeout,
                timeoutError: timeoutError,
                start: { completion in reader.start(task: task, completion: completion) },
                onTimeout: { reader.discard(); task.cancel() })
            try budget?.check()
            return result
        } catch {
            try budget?.check()
            throw error
        }
    }

    private func start(task: URLSessionDataTask,
                       completion: @escaping @Sendable (Result<Data, Error>) -> Void) {
        lock.withLock {
            guard !closed else { return }
            self.completion = completion
            task.resume()
        }
    }

    private func discard() {
        lock.withLock {
            closed = true
            completion = nil
            data = Data()
        }
    }

    private func finish(_ error: Error? = nil) {
        let pending = lock.withLock { () -> ((@Sendable (Result<Data, Error>) -> Void)?, Result<Data, Error>) in
            guard !closed else { return (nil, .success(Data())) }
            closed = true
            let result: Result<Data, Error> = error.map { .failure($0) } ?? .success(data)
            defer { completion = nil; data = Data() }
            return (completion, result)
        }
        pending.0?(pending.1)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask,
                    didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            finish(SpaceOError.badRequest("DevTools returned an invalid \(descriptionText) response"))
            completionHandler(.cancel)
            return
        }
        guard http.expectedContentLength <= Int64(maximumBytes) else {
            finish(SpaceOError.badRequest(
                "DevTools \(descriptionText) declares \(http.expectedContentLength) bytes, over the \(maximumBytes)-byte limit"))
            completionHandler(.cancel)
            return
        }
        let accepted = lock.withLock { () -> Bool in
            guard !closed else { return false }
            acceptedResponse = true
            return true
        }
        completionHandler(accepted ? .allow : .cancel)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive chunk: Data) {
        let exceeded = lock.withLock { () -> Bool in
            guard !closed else { return false }
            guard acceptedResponse, chunk.count <= maximumBytes - data.count else { return true }
            data.append(chunk)
            return false
        }
        if exceeded {
            finish(SpaceOError.badRequest("DevTools \(descriptionText) exceeded the \(maximumBytes)-byte limit"))
            dataTask.cancel()
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        let accepted = lock.withLock { acceptedResponse }
        finish(error ?? (accepted ? nil : SpaceOError.badRequest("DevTools returned no \(descriptionText) response")))
    }
}
