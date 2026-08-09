// AI Pendant — macOS menu-bar + desktop companion app.
// Observes and controls the separately-installed "AI Pendant Mac Local Agent"
// (LaunchAgent com.aipendant.agent) strictly from the outside over HTTP:
// it polls http://localhost:8000/health, streams live activity (SSE), and can
// kickstart the LaunchAgent. It never touches the agent's files, plist, or app
// bundle.
//
// The window has two tabs:
//   "Dashboard" — the SAME web app the browser and iPhone show, in a WKWebView
//                 with the persistent default data store so the sign-in cookie
//                 survives relaunches. No credential is ever embedded here.
//   "This Mac"  — a native live view of what the local agent is doing right now.

import AppKit
import Carbon.HIToolbox
import ImageIO
import WebKit
import SwiftUI
import Combine
import ServiceManagement
import Speech
import AVFoundation
import UniformTypeIdentifiers

// MARK: - Agent token (never compiled in, never logged, never displayed)

enum AgentEnv {
    static let envPathDefaultsKey = "AgentEnvPath"
    static let bundleId = "com.aipendant.menubar"

    /// Canonical + legacy secret files. First readable path wins.
    static var candidateEnvPaths: [String] {
        let home = NSHomeDirectory()
        var paths: [String] = []
        // Explicit override from `defaults write … AgentEnvPath`
        if let domain = UserDefaults.standard.persistentDomain(forName: bundleId),
           let override = domain[envPathDefaultsKey] as? String,
           !override.isEmpty {
            paths.append(override)
        }
        paths.append(contentsOf: [
            "\(home)/agentic-gadget/.env",
            "\(home)/agentic-gadget/software/ai-pendant.env",
            "\(home)/agentic-gadget/software/ai-pendant-simulator/.env",
        ])
        // de-dupe, preserve order
        var seen = Set<String>()
        return paths.filter { seen.insert($0).inserted }
    }

    static func registerDefaults() {
        let preferred =
            candidateEnvPaths.first { FileManager.default.isReadableFile(atPath: $0) }
            ?? "\(NSHomeDirectory())/agentic-gadget/.env"
        UserDefaults.standard.register(defaults: [envPathDefaultsKey: preferred])
    }

    /// Path shown in error UI — the file we actually expect secrets from.
    static var envPath: String {
        candidateEnvPaths.first { FileManager.default.isReadableFile(atPath: $0) }
            ?? candidateEnvPaths.first
            ?? "\(NSHomeDirectory())/agentic-gadget/.env"
    }

    /// Reads AGENT_TOKEN from any known secrets file. Kept in memory only.
    static func loadToken() -> String? {
        for path in candidateEnvPaths {
            guard let content = try? String(contentsOfFile: path, encoding: .utf8) else {
                continue
            }
            for rawLine in content.split(separator: "\n") {
                let line = rawLine.trimmingCharacters(in: .whitespaces)
                guard line.hasPrefix("AGENT_TOKEN=") else { continue }
                var value = String(line.dropFirst("AGENT_TOKEN=".count))
                    .trimmingCharacters(in: .whitespaces)
                value = value.trimmingCharacters(in: CharacterSet(charactersIn: "\"'"))
                if !value.isEmpty { return value }
            }
        }
        return nil
    }
}

// MARK: - Wire models (tolerant: everything optional except ids)

struct TraceStep: Decodable, Identifiable {
    let id: String
    let label: String?
    let detail: String?
    let status: String?
    let streamText: String?
    let updatedAt: String?
}

struct Trace: Decodable {
    let traceId: String
    let kind: String?
    let command: String?
    let source: String?
    let status: String?
    let steps: [TraceStep]?
    let createdAt: String?
    let updatedAt: String?
}

struct Job: Decodable, Identifiable {
    let jobId: String
    let type: String?
    let status: String?
    let command: String?
    let source: String?
    let error: String?
    let createdAt: String?
    let updatedAt: String?
    var id: String { jobId }
}

struct LogEntry: Decodable, Identifiable {
    let id: String
    let createdAt: String?
    let command: String?
    let status: String?
}

struct JobsResponse: Decodable { let jobs: [Job]? }
struct LogsResponse: Decodable { let logs: [LogEntry]? }

/// One pending approval from GET /approvals/pending. Everything but the id is
/// tolerant-optional, matching the rest of the wire models.
struct PendingApproval: Decodable, Identifiable {
    let id: String
    let summary: String?
    let detail: String?
    let origin: String?
    let risk: String?
    let createdAt: String?
    let expiresAt: String?
}

struct ApprovalsResponse: Decodable { let approvals: [PendingApproval]? }
struct ApprovalDecisionResponse: Decodable {
    let ok: Bool?
    let state: String?
    let error: String?
}
struct LatestTraceResponse: Decodable { let trace: Trace? }
struct ThinkingStreamEvent: Decodable { let latest: Trace? }

struct HealthPayload: Decodable {
    struct BrowserExt: Decodable { let online: Bool? }
    struct Permissions: Decodable { let ready: Bool?; let requiredMissing: [String]? }
    let ok: Bool?
    let version: String?
    let browserExtension: BrowserExt?
    let permissions: Permissions?
}

struct OpsStatusResponse: Decodable {
    struct Relay: Decodable {
        struct Payload: Decodable { let macBridgeOnline: Bool? }
        let reachable: Bool?
        let payload: Payload?
    }
    let relay: Relay?
}

// MARK: - Time helpers

enum When {
    private static let isoFrac: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private static let iso: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()
    private static let rel: RelativeDateTimeFormatter = {
        let f = RelativeDateTimeFormatter()
        f.unitsStyle = .abbreviated
        return f
    }()
    private static let clock: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "HH:mm:ss"
        return f
    }()

    static func date(_ s: String?) -> Date? {
        guard let s else { return nil }
        return isoFrac.date(from: s) ?? iso.date(from: s)
    }

    static func relative(_ s: String?) -> String {
        guard let d = date(s) else { return "" }
        if abs(d.timeIntervalSinceNow) < 5 { return "now" }
        return rel.localizedString(for: d, relativeTo: Date())
    }

    static func time(_ s: String?) -> String {
        guard let d = date(s) else { return "--:--:--" }
        return clock.string(from: d)
    }
}

// MARK: - Minimal SSE client (URLSession streaming with auto-reconnect)

final class SSEClient: NSObject, URLSessionDataDelegate {
    private var session: URLSession!
    private var task: URLSessionDataTask?
    private var buffer = Data()
    private let url: URL
    private let token: String
    private var stopped = false
    private var reconnectDelay: TimeInterval = 1

    var onEvent: ((Data) -> Void)?
    var onStateChange: ((Bool) -> Void)?

    init(url: URL, token: String) {
        self.url = url
        self.token = token
        super.init()
        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest = 60 // server heartbeats every 15s
        cfg.timeoutIntervalForResource = 60 * 60 * 24 * 7
        session = URLSession(configuration: cfg, delegate: self, delegateQueue: .main)
    }

    func start() {
        stopped = false
        connect()
    }

    func stop() {
        stopped = true
        task?.cancel()
        task = nil
    }

    private func connect() {
        buffer.removeAll()
        var request = URLRequest(url: url)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        request.cachePolicy = .reloadIgnoringLocalCacheData
        task = session.dataTask(with: request)
        task?.resume()
    }

    private func scheduleReconnect() {
        guard !stopped else { return }
        let delay = reconnectDelay
        reconnectDelay = min(reconnectDelay * 2, 10)
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self, !self.stopped else { return }
            self.connect()
        }
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask,
                    didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        let ok = (response as? HTTPURLResponse)?.statusCode == 200
        if ok {
            reconnectDelay = 1
            onStateChange?(true)
            completionHandler(.allow)
        } else {
            onStateChange?(false)
            completionHandler(.cancel)
        }
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        buffer.append(data)
        let separator = Data("\n\n".utf8)
        while let range = buffer.range(of: separator) {
            let chunk = buffer.subdata(in: buffer.startIndex..<range.lowerBound)
            buffer.removeSubrange(buffer.startIndex..<range.upperBound)
            handleEventChunk(chunk)
        }
    }

    private func handleEventChunk(_ chunk: Data) {
        let text = String(decoding: chunk, as: UTF8.self)
        var payloadLines: [String] = []
        for line in text.split(separator: "\n", omittingEmptySubsequences: false) {
            if line.hasPrefix("data:") {
                var value = line.dropFirst("data:".count)
                if value.hasPrefix(" ") { value = value.dropFirst() }
                payloadLines.append(String(value))
            }
        }
        guard !payloadLines.isEmpty else { return } // comments / heartbeats
        onEvent?(Data(payloadLines.joined(separator: "\n").utf8))
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        onStateChange?(false)
        guard !stopped else { return }
        scheduleReconnect()
    }
}

// MARK: - Live model

final class AgentModel: ObservableObject {
    @Published var online = false
    @Published var version: String?
    @Published var extensionOnline = false
    @Published var permissionsReady = false
    @Published var permissionsMissing = 0
    @Published var bridgeOnline: Bool?      // nil until first /ops/status
    @Published var trace: Trace?
    @Published var jobs: [Job] = []
    @Published var logs: [LogEntry] = []
    @Published var tokenAvailable = false
    @Published var streamLive = false

    var envPathDisplay: String { AgentEnv.envPath }

    private let base = URL(string: "http://localhost:8000")!
    private var token: String?
    private var sse: SSEClient?
    private var healthTimer: Timer?
    private var liveTimer: Timer?
    private var liveTick = 0

    private let http: URLSession = {
        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest = 3
        cfg.timeoutIntervalForResource = 5
        cfg.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: cfg)
    }()

    // Health polling runs for the whole app lifetime (drives the menu-bar icon).
    func start() {
        pollHealth()
        healthTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            self?.pollHealth()
        }
    }

    // Live streams/polling run only while the window is open.
    func startLive() {
        stopLive()
        token = AgentEnv.loadToken()
        tokenAvailable = token != nil
        guard let token else { return }

        let stream = SSEClient(url: base.appendingPathComponent("thinking/stream"), token: token)
        stream.onStateChange = { [weak self] connected in
            self?.streamLive = connected
        }
        stream.onEvent = { [weak self] data in
            guard let self else { return }
            if let event = try? JSONDecoder().decode(ThinkingStreamEvent.self, from: data) {
                if let latest = event.latest { self.trace = latest }
                self.fetchJobs()
            }
        }
        stream.start()
        sse = stream

        fetchLatestTrace()
        fetchJobs()
        fetchLogs()
        fetchOpsStatus()
        pollHealth()

        liveTick = 0
        liveTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            guard let self else { return }
            self.liveTick += 1
            if !self.streamLive { self.fetchLatestTrace() } // 1s fallback when SSE is down
            if self.liveTick % 2 == 0 { self.fetchJobs() }
            if self.liveTick % 5 == 0 { self.fetchLogs() }
            if self.liveTick % 10 == 0 { self.fetchOpsStatus() }
        }
    }

    func stopLive() {
        sse?.stop()
        sse = nil
        liveTimer?.invalidate()
        liveTimer = nil
        streamLive = false
    }

    func pollHealth() {
        get("health", auth: false, as: HealthPayload.self) { [weak self] payload in
            guard let self else { return }
            self.online = payload?.ok ?? false
            if let v = payload?.version { self.version = v }
            self.extensionOnline = payload?.browserExtension?.online ?? false
            self.permissionsReady = payload?.permissions?.ready ?? false
            self.permissionsMissing = payload?.permissions?.requiredMissing?.count ?? 0
            if self.online == false { self.bridgeOnline = nil }
        }
    }

    private func fetchLatestTrace() {
        get("thinking/latest", as: LatestTraceResponse.self) { [weak self] payload in
            if let trace = payload?.trace { self?.trace = trace }
        }
    }

    private func fetchJobs() {
        get("jobs", as: JobsResponse.self) { [weak self] payload in
            if let jobs = payload?.jobs { self?.jobs = jobs }
        }
    }

    private func fetchLogs() {
        get("logs", as: LogsResponse.self) { [weak self] payload in
            if let logs = payload?.logs { self?.logs = logs }
        }
    }

    private func fetchOpsStatus() {
        get("ops/status", as: OpsStatusResponse.self) { [weak self] payload in
            guard let self else { return }
            if let relay = payload?.relay {
                self.bridgeOnline = (relay.reachable ?? false) && (relay.payload?.macBridgeOnline ?? false)
            }
        }
    }

    private func get<T: Decodable>(_ path: String, auth: Bool = true, as type: T.Type,
                                   _ completion: @escaping (T?) -> Void) {
        var request = URLRequest(url: base.appendingPathComponent(path))
        if auth {
            guard let token else { completion(nil); return }
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        http.dataTask(with: request) { data, response, _ in
            var result: T?
            if let data,
               (response as? HTTPURLResponse)?.statusCode == 200 {
                result = try? JSONDecoder().decode(T.self, from: data)
            }
            DispatchQueue.main.async { completion(result) }
        }.resume()
    }
}

// MARK: - Shared status styling

func statusTint(_ status: String?) -> Color {
    switch (status ?? "").lowercased() {
    case "completed", "done", "success": return .green
    case "failed", "error": return .red
    case "cancelled", "canceled": return Color.white.opacity(0.35)
    case "plan_ready", "pending": return .orange
    case "": return Color.white.opacity(0.35)
    default: return .cyan // processing / running / thinking / streaming
    }
}

func isActiveStatus(_ status: String?) -> Bool {
    ["processing", "running", "thinking", "streaming", "started", "active"]
        .contains((status ?? "").lowercased())
}

// MARK: - Views

struct Dot: View {
    let color: Color
    var size: CGFloat = 7
    var glow = false
    var body: some View {
        Circle()
            .fill(color)
            .frame(width: size, height: size)
            .shadow(color: glow ? color.opacity(0.8) : .clear, radius: glow ? 4 : 0)
    }
}

struct Chip: View {
    let label: String
    let color: Color
    var body: some View {
        HStack(spacing: 6) {
            Dot(color: color, size: 6)
            Text(label)
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(.white.opacity(0.65))
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .background(Capsule().fill(.white.opacity(0.05)))
    }
}

struct PulsingDot: View {
    let color: Color
    @State private var dim = false
    var body: some View {
        Dot(color: color, size: 7, glow: true)
            .opacity(dim ? 0.35 : 1)
            .animation(.easeInOut(duration: 0.7).repeatForever(autoreverses: true), value: dim)
            .onAppear { dim = true }
    }
}

struct StepRow: View {
    let step: TraceStep
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Group {
                if isActiveStatus(step.status) {
                    PulsingDot(color: .cyan)
                } else {
                    Dot(color: statusTint(step.status), size: 7)
                }
            }
            .frame(width: 10)
            VStack(alignment: .leading, spacing: 2) {
                Text(step.label ?? step.id)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(.white.opacity(0.88))
                    .lineLimit(1)
                if let detail = step.detail, !detail.isEmpty {
                    Text(detail)
                        .font(.system(size: 11))
                        .foregroundStyle(.white.opacity(0.42))
                        .lineLimit(1)
                }
                if let stream = step.streamText, !stream.isEmpty, isActiveStatus(step.status) {
                    Text(stream)
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(.white.opacity(0.5))
                        .lineLimit(2)
                }
            }
            Spacer(minLength: 0)
        }
    }
}

struct NowView: View {
    let trace: Trace?
    let streamLive: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            if let trace {
                let active = isActiveStatus(trace.status)
                HStack(spacing: 10) {
                    Text(active ? "NOW" : "LAST ACTIVITY")
                        .font(.system(size: 11, weight: .bold))
                        .tracking(2.2)
                        .foregroundStyle(.white.opacity(0.4))
                    Text(When.relative(trace.updatedAt ?? trace.createdAt))
                        .font(.system(size: 11))
                        .foregroundStyle(.white.opacity(0.3))
                    if streamLive {
                        HStack(spacing: 4) {
                            Dot(color: .green, size: 5)
                            Text("live")
                                .font(.system(size: 10, weight: .medium))
                                .foregroundStyle(.white.opacity(0.35))
                        }
                    }
                    Spacer()
                }
                Text(trace.command?.isEmpty == false ? trace.command! : "(no command text)")
                    .font(.system(size: 30, weight: .semibold, design: .rounded))
                    .foregroundStyle(.white.opacity(0.95))
                    .lineLimit(3)
                    .minimumScaleFactor(0.55)
                    .fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 8) {
                    HStack(spacing: 6) {
                        if active { PulsingDot(color: .cyan) } else { Dot(color: statusTint(trace.status)) }
                        Text((trace.status ?? "unknown").replacingOccurrences(of: "_", with: " "))
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(.white.opacity(0.75))
                    }
                    .padding(.horizontal, 10)
                    .padding(.vertical, 5)
                    .background(Capsule().fill(statusTint(trace.status).opacity(0.14)))
                    if let source = trace.source, !source.isEmpty {
                        Text("via \(source)")
                            .font(.system(size: 11))
                            .foregroundStyle(.white.opacity(0.35))
                    }
                }
                if let steps = trace.steps, !steps.isEmpty {
                    ScrollViewReader { proxy in
                        ScrollView {
                            VStack(alignment: .leading, spacing: 10) {
                                ForEach(steps) { step in
                                    StepRow(step: step).id(step.id)
                                }
                            }
                            .padding(.top, 6)
                        }
                        .onChange(of: steps.count) { _ in
                            if let last = steps.last {
                                withAnimation { proxy.scrollTo(last.id, anchor: .bottom) }
                            }
                        }
                        .onAppear {
                            if let last = steps.last { proxy.scrollTo(last.id, anchor: .bottom) }
                        }
                    }
                }
            } else {
                Spacer()
                HStack {
                    Spacer()
                    VStack(spacing: 14) {
                        Image(systemName: "waveform.circle")
                            .font(.system(size: 52, weight: .thin))
                            .foregroundStyle(.white.opacity(0.14))
                        Text("Idle — waiting for the next command")
                            .font(.system(size: 13))
                            .foregroundStyle(.white.opacity(0.35))
                    }
                    Spacer()
                }
                Spacer()
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

struct JobRow: View {
    let job: Job
    var body: some View {
        HStack(spacing: 10) {
            if isActiveStatus(job.status) {
                PulsingDot(color: .cyan)
            } else {
                Dot(color: statusTint(job.status), size: 6)
            }
            Text(job.command?.isEmpty == false ? job.command! : (job.type ?? "job"))
                .font(.system(size: 12))
                .foregroundStyle(.white.opacity(0.75))
                .lineLimit(1)
            Spacer(minLength: 12)
            Text(When.relative(job.createdAt))
                .font(.system(size: 11))
                .foregroundStyle(.white.opacity(0.3))
                .layoutPriority(1)
        }
    }
}

struct ActivityView: View {
    @ObservedObject var model: AgentModel
    @State private var logExpanded = false

    private var versionLabel: String {
        if model.online {
            return model.version.map { "Agent v\($0)" } ?? "Agent online"
        }
        return "Agent offline"
    }

    var body: some View {
        ZStack {
            Color(red: 0.043, green: 0.051, blue: 0.078).ignoresSafeArea()
            VStack(alignment: .leading, spacing: 22) {
                header
                if model.tokenAvailable {
                    NowView(trace: model.trace, streamLive: model.streamLive)
                    recentJobs
                    logTail
                } else {
                    Spacer()
                    HStack {
                        Spacer()
                        Text("Can't read AGENT_TOKEN — add it to \(model.envPathDisplay) (path overridable via `defaults write com.aipendant.menubar \(AgentEnv.envPathDefaultsKey)`), then reopen this window.")
                            .font(.system(size: 12))
                            .foregroundStyle(.white.opacity(0.45))
                            .multilineTextAlignment(.center)
                            .frame(maxWidth: 560)
                        Spacer()
                    }
                    Spacer()
                }
            }
            .padding(.horizontal, 30)
            .padding(.top, 22)
            .padding(.bottom, 22)
        }
        .preferredColorScheme(.dark)
    }

    private var header: some View {
        HStack(spacing: 12) {
            Dot(color: model.online ? .green : .red, glow: model.online)
            Text(versionLabel)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(.white.opacity(0.92))
            Spacer()
            if let bridge = model.bridgeOnline {
                Chip(label: "Bridge", color: bridge ? .green : .red)
            }
            Chip(label: "Extension", color: model.extensionOnline ? .green : Color.white.opacity(0.3))
            Chip(label: model.permissionsReady ? "Permissions" : "\(model.permissionsMissing) permissions missing",
                 color: model.permissionsReady ? .green : .orange)
        }
    }

    private var recentJobs: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("RECENT")
                .font(.system(size: 10, weight: .bold))
                .tracking(2)
                .foregroundStyle(.white.opacity(0.35))
            if model.jobs.isEmpty {
                Text("No jobs yet")
                    .font(.system(size: 12))
                    .foregroundStyle(.white.opacity(0.3))
            } else {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(model.jobs.prefix(6)) { job in
                        JobRow(job: job)
                    }
                }
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 12).fill(.white.opacity(0.035)))
    }

    private var logTail: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button {
                withAnimation(.easeInOut(duration: 0.15)) { logExpanded.toggle() }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 9, weight: .bold))
                        .rotationEffect(.degrees(logExpanded ? 90 : 0))
                        .foregroundStyle(.white.opacity(0.35))
                    Text("LOG")
                        .font(.system(size: 10, weight: .bold))
                        .tracking(2)
                        .foregroundStyle(.white.opacity(0.35))
                    Spacer()
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if logExpanded {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(model.logs.prefix(10)) { entry in
                        Text("\(When.time(entry.createdAt))  \((entry.status ?? "?").padding(toLength: 9, withPad: " ", startingAt: 0))  \(entry.command ?? "")")
                            .font(.system(size: 11, design: .monospaced))
                            .foregroundStyle(.white.opacity(0.5))
                            .lineLimit(1)
                    }
                    if model.logs.isEmpty {
                        Text("empty")
                            .font(.system(size: 11, design: .monospaced))
                            .foregroundStyle(.white.opacity(0.3))
                    }
                }
            }
        }
    }
}

// MARK: - Dashboard web pane (the same web app every other device shows)

final class WebPane: NSObject, WKUIDelegate, WKNavigationDelegate {
    let webView: WKWebView
    private let homeURL: URL

    init(url: URL) {
        homeURL = url
        let config = WKWebViewConfiguration()
        // Persistent (non-ephemeral) store: the site's session cookie survives relaunches,
        // so the user signs in once inside the webview. Nothing is embedded in the app.
        config.websiteDataStore = .default()
        config.mediaTypesRequiringUserActionForPlayback = []
        webView = WKWebView(frame: .zero, configuration: config)
        super.init()
        webView.uiDelegate = self
        webView.navigationDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        webView.underPageBackgroundColor = NSColor(red: 0.043, green: 0.051, blue: 0.078, alpha: 1)
    }

    /// Loads the dashboard once; later calls are no-ops so the session isn't disturbed.
    func loadIfNeeded() {
        guard webView.url == nil, !webView.isLoading else { return }
        webView.load(URLRequest(url: homeURL))
    }

    // Grant the microphone to the dashboard origin so its record button works in-app.
    func webView(_ webView: WKWebView,
                 requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo,
                 type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        let trusted = origin.`protocol` == "https" && origin.host == homeURL.host
        decisionHandler(trusted ? .grant : .deny)
    }

    // Popups / target=_blank go to the default browser rather than a stray window.
    func webView(_ webView: WKWebView,
                 createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction,
                 windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url { NSWorkspace.shared.open(url) }
        return nil
    }

    // Clicked links to other hosts open externally; the dashboard itself stays in-app.
    func webView(_ webView: WKWebView,
                 decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if navigationAction.navigationType == .linkActivated,
           let url = navigationAction.request.url,
           let host = url.host,
           host != homeURL.host {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        NSLog("AI Pendant: dashboard navigation failed: \(error.localizedDescription)")
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        NSLog("AI Pendant: dashboard load failed: \(error.localizedDescription)")
    }
}

// MARK: - Window tabs

enum MainTab: String {
    case dashboard
    case thisMac

    static let defaultsKey = "SelectedTab"

    static var remembered: MainTab {
        MainTab(rawValue: UserDefaults.standard.string(forKey: defaultsKey) ?? "") ?? .dashboard
    }

    func remember() {
        UserDefaults.standard.set(rawValue, forKey: MainTab.defaultsKey)
    }
}

// MARK: - Floating always-on-top command HUD

/// A file the user attached to the next command (picker, drag-and-drop, or
/// screenshot). Local agent — absolute paths are the payload.
struct Attachment: Identifiable {
    let id = UUID()
    let url: URL
    var name: String { url.lastPathComponent }
    /// Extension hint only — used to pick the loading placeholder. The real
    /// image/file decision is made by whether ImageIO can decode a thumbnail
    /// (see AttachmentThumbnail), so a mislabeled file still resolves correctly.
    var isImage: Bool {
        ["png", "jpg", "jpeg", "gif", "heic", "heif", "webp", "tiff", "bmp"]
            .contains(url.pathExtension.lowercased())
    }
}

final class FloatingCommandModel: ObservableObject {
    @Published var text = ""
    /// Empty means "nothing to report" — the aux card below the pill hides.
    @Published var status = ""
    @Published var busy = false
    @Published var listening = false
    @Published var attachments: [Attachment] = []

    /// The global shortcut that ACTUALLY registered (nil → menu-only summon).
    /// Only ever set from real registration results, never from wishes.
    @Published var hotkeyLabel: String?

    /// Pending approvals from the agent. Empty also when the endpoint 404s or
    /// the agent is unreachable — the HUD section hides itself silently then.
    @Published var approvals: [PendingApproval] = []
    @Published var approvalErrors: [String: String] = [:]   // approval id → inline error
    @Published var decidingIds: Set<String> = []

    /// Wired by the app delegate: Esc inside the SwiftUI hierarchy hides the panel.
    var requestHide: (() -> Void)?
    /// Wired by the app delegate: order the HUD off-screen, capture the whole
    /// display it was on, re-show, and attach the PNG.
    var requestScreenshot: (() -> Void)?
    /// Wired by the app delegate: present the NSOpenPanel. Lives on the delegate
    /// because presenting a file panel from an .accessory app needs activation-
    /// policy juggling and the panel as modal host — see presentFilePicker().
    var requestPickFiles: (() -> Void)?
    /// Wired by the app delegate: open a large in-app preview (lightbox) of an
    /// image attachment. Presented as another floating panel, never Preview.app,
    /// so the user is never bounced out of their current (possibly fullscreen) Space.
    var requestImagePreview: ((URL) -> Void)?

    private var approvalsTimer: Timer?
    private var panelVisible = false

    private let tokenProvider: () -> String?
    private let agentBaseURL: URL
    private var speechRecognizer: SFSpeechRecognizer?
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private let audioEngine = AVAudioEngine()

    init(tokenProvider: @escaping () -> String?, agentBaseURL: URL) {
        self.tokenProvider = tokenProvider
        self.agentBaseURL = agentBaseURL
        self.speechRecognizer = SFSpeechRecognizer(locale: Locale.current)
    }

    func send() {
        let typed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !typed.isEmpty || !attachments.isEmpty else {
            status = "Enter a command first"
            return
        }
        guard let token = tokenProvider(), !token.isEmpty else {
            status = "Missing AGENT_TOKEN in \(AgentEnv.envPath)"
            return
        }
        // Attachments ride two ways: a first-class "attachments" array for when
        // the agent learns the field, plus a plain-text suffix that works today
        // even while the server ignores the array. Local agent — paths suffice.
        let paths = attachments.map { $0.url.path }
        var command = typed
        if !paths.isEmpty {
            let suffix = "[attached: \(paths.joined(separator: ", "))]"
            command = command.isEmpty ? suffix : "\(command) \(suffix)"
        }
        busy = true
        status = "Sending…"
        var request = URLRequest(url: agentBaseURL.appendingPathComponent("plan"))
        request.httpMethod = "POST"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        var body: [String: Any] = [
            "command": command,
            "source": "floating-hud",
            "autoExecute": true,
        ]
        if !paths.isEmpty { body["attachments"] = paths }
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)

        URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
            DispatchQueue.main.async {
                self?.busy = false
                if let error {
                    self?.status = error.localizedDescription
                    return
                }
                let code = (response as? HTTPURLResponse)?.statusCode ?? 0
                guard let data,
                      let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                    self?.status = "Bad response (\(code))"
                    return
                }
                // Fire-and-forget auto-execute for safe open_app plans when present.
                if let actions = json["actions"] as? [[String: Any]], !actions.isEmpty {
                    self?.execute(actions: actions, command: command, token: token)
                    let label = (actions.first?["label"] as? String) ?? "Running…"
                    self?.status = label
                    self?.text = ""
                    self?.attachments = []
                    return
                }
                let reply = (json["response"] as? String)
                    ?? (json["error"] as? String)
                    ?? "ok"
                self?.status = reply
                if json["error"] == nil {
                    self?.text = ""
                    self?.attachments = []
                }
            }
        }.resume()
    }

    private func execute(actions: [[String: Any]], command: String, token: String) {
        var request = URLRequest(url: agentBaseURL.appendingPathComponent("execute"))
        request.httpMethod = "POST"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let body: [String: Any] = [
            "command": command,
            "actions": actions,
            "source": "floating-hud",
        ]
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        URLSession.shared.dataTask(with: request) { [weak self] data, _, _ in
            DispatchQueue.main.async {
                if let data,
                   let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                   let response = json["response"] as? String, !response.isEmpty {
                    self?.status = response
                } else {
                    self?.status = "Done"
                }
            }
        }.resume()
    }

    // MARK: Global hotkey label

    /// Records which global shortcut actually bound (nil when every candidate
    /// failed). The field placeholder shows it — there is deliberately no
    /// separate idle caption row. Never advertises a failed binding.
    func applyHotkey(label: String?) {
        hotkeyLabel = label
    }

    // MARK: Attachments

    func addAttachments(urls: [URL]) {
        for url in urls where url.isFileURL {
            if !attachments.contains(where: { $0.url.path == url.path }) {
                attachments.append(Attachment(url: url))
            }
        }
    }

    func removeAttachment(_ id: UUID) {
        attachments.removeAll { $0.id == id }
    }

    /// True while the NSOpenPanel is up — the delegate suspends outside-click
    /// dismissal so a click on the sheet (a non-pill window) doesn't yank the
    /// host panel out from under it. Set by the delegate around presentFilePicker().
    var isFilePickerOpen = false

    func cancelListening() {
        if listening { stopListen() }
    }

    // MARK: Pending approvals

    /// Called once at launch: slow (60s) polling drives the menu-bar badge while
    /// the HUD is hidden. Showing the panel switches to a 5s cadence.
    func startApprovalPolling() {
        fetchApprovals()
        rescheduleApprovalTimer()
    }

    func panelDidShow() {
        panelVisible = true
        fetchApprovals()
        rescheduleApprovalTimer()
    }

    func panelDidHide() {
        panelVisible = false
        rescheduleApprovalTimer()
    }

    private func rescheduleApprovalTimer() {
        approvalsTimer?.invalidate()
        let interval: TimeInterval = panelVisible ? 5 : 60
        approvalsTimer = Timer.scheduledTimer(withTimeInterval: interval, repeats: true) { [weak self] _ in
            self?.fetchApprovals()
        }
    }

    private func clearApprovals() {
        if !approvals.isEmpty { approvals = [] }
        if !approvalErrors.isEmpty { approvalErrors = [:] }
    }

    /// GET /approvals/pending. The endpoint may not exist yet (agent not
    /// restarted since it grew approvals) — any non-200 or transport failure
    /// silently empties the list, which hides the HUD section and the badge.
    func fetchApprovals() {
        guard let token = tokenProvider(), !token.isEmpty else {
            clearApprovals()
            return
        }
        var request = URLRequest(url: agentBaseURL.appendingPathComponent("approvals/pending"))
        request.timeoutInterval = 3
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
            DispatchQueue.main.async {
                guard let self else { return }
                guard error == nil,
                      (response as? HTTPURLResponse)?.statusCode == 200,
                      let data,
                      let decoded = try? JSONDecoder().decode(ApprovalsResponse.self, from: data) else {
                    self.clearApprovals()
                    return
                }
                let fresh = decoded.approvals ?? []
                self.approvals = fresh
                let liveIds = Set(fresh.map(\.id))
                self.approvalErrors = self.approvalErrors.filter { liveIds.contains($0.key) }
            }
        }.resume()
    }

    /// POST /approvals/:id/decision. Success removes the row; failure surfaces
    /// an inline error on that row only.
    func decide(_ approval: PendingApproval, approve: Bool) {
        guard let token = tokenProvider(), !token.isEmpty else { return }
        decidingIds.insert(approval.id)
        approvalErrors[approval.id] = nil
        var request = URLRequest(url: agentBaseURL
            .appendingPathComponent("approvals")
            .appendingPathComponent(approval.id)
            .appendingPathComponent("decision"))
        request.httpMethod = "POST"
        request.timeoutInterval = 5
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(
            withJSONObject: ["decision": approve ? "approve" : "deny"])
        URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
            DispatchQueue.main.async {
                guard let self else { return }
                self.decidingIds.remove(approval.id)
                if let error {
                    self.approvalErrors[approval.id] = error.localizedDescription
                    return
                }
                let code = (response as? HTTPURLResponse)?.statusCode ?? 0
                let decoded = data.flatMap { try? JSONDecoder().decode(ApprovalDecisionResponse.self, from: $0) }
                if code == 200, decoded?.ok == true, decoded?.error == nil {
                    self.approvals.removeAll { $0.id == approval.id }
                    self.approvalErrors[approval.id] = nil
                    self.fetchApprovals()   // resync with whatever the agent now holds
                } else {
                    self.approvalErrors[approval.id] = decoded?.error ?? "Failed (HTTP \(code))"
                }
            }
        }.resume()
    }

    func toggleListen() {
        if listening {
            stopListen()
            return
        }
        SFSpeechRecognizer.requestAuthorization { [weak self] auth in
            DispatchQueue.main.async {
                guard auth == .authorized else {
                    self?.status = "Mic permission denied — enable Speech Recognition"
                    return
                }
                self?.startListen()
            }
        }
    }

    private func startListen() {
        guard let speechRecognizer, speechRecognizer.isAvailable else {
            status = "Speech recognition unavailable"
            return
        }
        stopListen()
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        recognitionRequest = request

        let input = audioEngine.inputNode
        let format = input.outputFormat(forBus: 0)
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
            request.append(buffer)
        }
        audioEngine.prepare()
        do {
            try audioEngine.start()
        } catch {
            status = "Mic failed: \(error.localizedDescription)"
            return
        }
        listening = true
        status = "Listening… click mic to stop"
        recognitionTask = speechRecognizer.recognitionTask(with: request) { [weak self] result, error in
            DispatchQueue.main.async {
                if let result {
                    self?.text = result.bestTranscription.formattedString
                    if result.isFinal {
                        self?.stopListen()
                        self?.send()
                    }
                }
                if error != nil {
                    self?.stopListen()
                }
            }
        }
    }

    private func stopListen() {
        if audioEngine.isRunning {
            audioEngine.stop()
            audioEngine.inputNode.removeTap(onBus: 0)
        }
        recognitionRequest?.endAudio()
        recognitionTask?.cancel()
        recognitionRequest = nil
        recognitionTask = nil
        listening = false
    }
}

/// Dark translucent material used by the pill and the aux card, clipped to a
/// shape, with a hairline border. The window itself is clear + borderless.
struct HUDMaterial<S: InsettableShape>: View {
    let shape: S
    var body: some View {
        shape
            .fill(Color(red: 0.09, green: 0.10, blue: 0.13).opacity(0.62))
            .background(VisualEffectBackground().clipShape(shape))
            .overlay(shape.strokeBorder(Color.white.opacity(0.09), lineWidth: 1))
    }
}

struct VisualEffectBackground: NSViewRepresentable {
    func makeNSView(context: Context) -> NSVisualEffectView {
        let view = NSVisualEffectView()
        view.material = .hudWindow
        view.blendingMode = .behindWindow
        view.state = .active
        return view
    }
    func updateNSView(_ nsView: NSVisualEffectView, context: Context) {}
}

struct ApprovalRow: View {
    let approval: PendingApproval
    let busy: Bool
    let error: String?
    let onApprove: () -> Void
    let onDeny: () -> Void

    private let accent = Color(red: 0.46, green: 0.90, blue: 0.64)

    private var riskColor: Color {
        switch (approval.risk ?? "").lowercased() {
        case "high", "critical": return Color(red: 1.0, green: 0.45, blue: 0.42)
        case "medium", "moderate": return .orange
        case "low": return accent
        default: return Color.white.opacity(0.5)
        }
    }

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(approval.summary?.isEmpty == false ? approval.summary! : approval.id)
                    .font(.system(size: 13))
                    .foregroundStyle(.white.opacity(0.9))
                    .fixedSize(horizontal: false, vertical: true) // wrap, don't truncate
                HStack(spacing: 8) {
                    if let risk = approval.risk, !risk.isEmpty {
                        Text(risk.uppercased())
                            .font(.system(size: 9, weight: .semibold))
                            .tracking(0.8)
                            .foregroundStyle(riskColor.opacity(0.95))
                    }
                    if let expires = approval.expiresAt, !expires.isEmpty {
                        Text("expires \(When.relative(expires))")
                            .font(.system(size: 10))
                            .foregroundStyle(.white.opacity(0.4))
                    }
                    if let origin = approval.origin, !origin.isEmpty {
                        Text(origin)
                            .font(.system(size: 10))
                            .foregroundStyle(.white.opacity(0.35))
                            .lineLimit(1)
                    }
                }
                if let error, !error.isEmpty {
                    Text(error)
                        .font(.system(size: 10))
                        .foregroundStyle(Color.red.opacity(0.9))
                        .lineLimit(2)
                }
            }
            Spacer(minLength: 10)
            Button(action: onDeny) {
                Text("Deny")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(.white.opacity(busy ? 0.25 : 0.55))
                    .padding(.horizontal, 6)
                    .padding(.vertical, 5)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(busy)
            .help("Deny")
            Button(action: onApprove) {
                Text("Approve")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Color.black.opacity(0.82))
                    .padding(.horizontal, 13)
                    .padding(.vertical, 5)
                    .background(Capsule().fill(accent.opacity(busy ? 0.35 : 1)))
            }
            .buttonStyle(.plain)
            .disabled(busy)
            .help("Approve")
        }
        .padding(.vertical, 10)
        .help(approval.detail ?? "")
    }
}

// MARK: - Attachment previews (image thumbnails + file cards)

/// Downsamples file images to small thumbnails via ImageIO, so the composer can
/// show a real preview without ever holding a full-resolution bitmap in a view.
/// Returns nil for anything ImageIO can't decode as an image — those fall back
/// to the file-card style. Results are cached by path so redraws don't re-decode.
enum AttachmentThumbnail {
    /// Longest-edge pixel budget: crisp for a ~60pt aspect-fill tile on Retina,
    /// yet a tiny fraction of a full-frame photo (heavy downsample, low RAM).
    static let maxPixel = 256
    private static let cache = NSCache<NSString, NSImage>()

    static func load(path: String) -> NSImage? {
        let key = path as NSString
        if let hit = cache.object(forKey: key) { return hit }
        // CGImageSourceCreateThumbnailAtIndex reads only what it needs and hands
        // back an already-downsampled CGImage — full-res pixels never enter RAM.
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,   // honor EXIF orientation
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixel,
        ]
        guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
              let cg = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
        else { return nil }
        let image = NSImage(cgImage: cg, size: NSSize(width: cg.width, height: cg.height))
        cache.setObject(image, forKey: key)
        return image
    }

    /// A bigger, screen-sized copy for the click-to-enlarge preview — deliberately
    /// NOT cached (it's transient and one at a time, freed when the lightbox
    /// closes) and NOT stored under the row cache key, so the tiny row thumbnail
    /// is never evicted for the large one.
    static func loadSized(path: String, maxPixel: Int) -> NSImage? {
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixel,
        ]
        guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
              let cg = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
        else { return nil }
        return NSImage(cgImage: cg, size: NSSize(width: cg.width, height: cg.height))
    }
}

/// The click-to-enlarge preview card: the image aspect-fit at a comfortable size
/// on a rounded dark backdrop. The hosting panel is sized exactly to this card
/// (NOT the whole screen) and centered, so a click OUTSIDE the card is a real
/// outside-click the monitors turn into "close both". A click ON the card, or
/// Esc, closes just the preview — both wired by the hosting panel.
struct ImagePreviewView: View {
    let image: NSImage
    let inset: CGFloat
    let onClose: () -> Void
    @State private var closeHover = false

    var body: some View {
        Image(nsImage: image)
            .resizable()
            .interpolation(.high)
            .aspectRatio(contentMode: .fit)               // aspect-fit inside the card
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            .padding(inset)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .fill(Color(red: 0.07, green: 0.08, blue: 0.10).opacity(0.97)))  // dim/rounded backdrop
            .overlay(
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .strokeBorder(Color.white.opacity(0.12), lineWidth: 1))
            .contentShape(Rectangle())
            .onTapGesture { onClose() }                   // click the card closes the preview
            .overlay(closeButton, alignment: .topTrailing) // additive explicit × (lightbox style)
            .onExitCommand { onClose() }                  // Esc closes (belt & braces)
    }

    /// ChatGPT/Claude-style lightbox close: a small dark circle with a white ×,
    /// top-right. Additive — Esc and a backdrop click still close too. Closes
    /// ONLY the preview; the pill and its attachments are untouched.
    private var closeButton: some View {
        Button(action: onClose) {
            Image(systemName: "xmark")
                .font(.system(size: 13, weight: .bold))
                .foregroundStyle(.white.opacity(closeHover ? 1 : 0.85))
                .frame(width: 28, height: 28)
                .background(Circle().fill(Color.black.opacity(closeHover ? 0.66 : 0.5)))
                .overlay(Circle().strokeBorder(Color.white.opacity(0.14), lineWidth: 1))
        }
        .buttonStyle(.plain)
        .padding(10)
        .onHover { closeHover = $0 }
        .help("Close preview")
    }
}

/// One attachment rendered ChatGPT/Claude-style: a rounded, aspect-filled image
/// thumbnail when the file decodes as an image, otherwise a compact document
/// card. Both carry a × badge to remove. The thumbnail decodes off the main
/// thread and is cached, so staging a screenshot shows the capture, not a name.
struct AttachmentTileView: View {
    let attachment: Attachment
    let onOpen: () -> Void
    let onRemove: () -> Void

    /// ~44–64pt square per the brief; 60 sits well beside the 56pt pill.
    private let side: CGFloat = 60
    private let corner: CGFloat = 12

    @State private var thumbnail: NSImage?
    @State private var didAttempt = false

    var body: some View {
        Group {
            if let thumbnail {
                imageTile(thumbnail)
            } else if didAttempt || !attachment.isImage {
                fileCard
            } else {
                loadingTile
            }
        }
        .onAppear(perform: loadIfNeeded)
    }

    /// Decode once, off the main thread; the cache absorbs any repeat appearances.
    private func loadIfNeeded() {
        guard thumbnail == nil, !didAttempt else { return }
        let path = attachment.url.path
        DispatchQueue.global(qos: .userInitiated).async {
            let image = AttachmentThumbnail.load(path: path)
            DispatchQueue.main.async {
                self.thumbnail = image
                self.didAttempt = true
            }
        }
    }

    private func imageTile(_ image: NSImage) -> some View {
        // The tile is a button (click → enlarge). The × badge is overlaid on top
        // as its own button, so it removes without triggering the preview.
        Button(action: onOpen) {
            Image(nsImage: image)
                .resizable()
                .aspectRatio(contentMode: .fill)          // aspect-fill, cropped square
                .frame(width: side, height: side)
                .clipShape(RoundedRectangle(cornerRadius: corner, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: corner, style: .continuous)
                        .strokeBorder(Color.white.opacity(0.14), lineWidth: 1))
                .contentShape(RoundedRectangle(cornerRadius: corner, style: .continuous))
        }
        .buttonStyle(.plain)
        .overlay(removeBadge, alignment: .topTrailing)
        .help("Click to preview · \(attachment.name)")
    }

    private var fileCard: some View {
        HStack(spacing: 8) {
            Image(systemName: fileGlyph)
                .font(.system(size: 18, weight: .regular))
                .foregroundStyle(.white.opacity(0.78))
            Text(attachment.name)
                .font(.system(size: 11.5))
                .foregroundStyle(.white.opacity(0.9))
                .lineLimit(1)
                .truncationMode(.middle)               // filename truncated in the middle
                .frame(maxWidth: 130, alignment: .leading)
        }
        .padding(.horizontal, 11)
        .frame(height: side)
        // Same dark material as the pill so the card reads over ANY background
        // the always-on-top HUD floats above (a bare fill would vanish on light).
        .background(HUDMaterial(shape: RoundedRectangle(cornerRadius: corner, style: .continuous)))
        .overlay(removeBadge, alignment: .topTrailing)
        .help(attachment.url.path)
    }

    /// Neutral square shown only while an image-typed file is still decoding.
    private var loadingTile: some View {
        Image(systemName: "photo")
            .font(.system(size: 18))
            .foregroundStyle(.white.opacity(0.4))
            .frame(width: side, height: side)
            .background(HUDMaterial(shape: RoundedRectangle(cornerRadius: corner, style: .continuous)))
            .overlay(removeBadge, alignment: .topTrailing)
    }

    /// × in the top-right corner. Palette rendering paints a white glyph on a
    /// dark disc so it stays legible over any thumbnail.
    private var removeBadge: some View {
        Button(action: onRemove) {
            Image(systemName: "xmark.circle.fill")
                .font(.system(size: 16))
                .symbolRenderingMode(.palette)
                .foregroundStyle(.white, Color.black.opacity(0.6))
                .shadow(color: .black.opacity(0.35), radius: 1, y: 0.5)
        }
        .buttonStyle(.plain)
        .padding(3)
        .help("Remove")
    }

    private var fileGlyph: String {
        switch attachment.url.pathExtension.lowercased() {
        case "pdf": return "doc.richtext"
        case "txt", "md", "rtf", "csv", "json", "log": return "doc.text"
        case "zip", "gz", "tar", "dmg": return "doc.zipper"
        case "mp4", "mov", "m4v", "avi", "mkv": return "film"
        case "mp3", "wav", "m4a", "aiff", "aac": return "waveform"
        default: return "doc.fill"
        }
    }
}

struct FloatingCommandView: View {
    @ObservedObject var model: FloatingCommandModel
    @State private var dropTargeted = false

    private let accent = Color(red: 0.46, green: 0.90, blue: 0.64)

    /// ONE caption, inside the field, showing the live shortcut when bound.
    private var placeholder: String {
        let base = "What can I help you with today?"
        return model.hotkeyLabel.map { "\(base)  ·  \($0)" } ?? base
    }

    /// The aux card exists only when there is something to show. Attachments
    /// render in their own row ABOVE the pill now, so they no longer live here.
    private var hasAux: Bool {
        !model.status.isEmpty || !model.approvals.isEmpty
    }

    var body: some View {
        VStack(spacing: 8) {
            // Attachments preview ABOVE the input — thumbnails for images, cards
            // for everything else — the way ChatGPT/Claude stage attachments.
            if !model.attachments.isEmpty { attachmentsRow }
            pill
            if hasAux { auxCard }
        }
        // Fixed width, content-driven height: the NSHostingView exposes this as
        // its intrinsic size and AppKit resizes the borderless panel to match
        // (top edge anchored), so the card grows downward under the pill.
        .frame(width: 660)
        .fixedSize(horizontal: false, vertical: true)
        .onDrop(of: [UTType.fileURL], isTargeted: $dropTargeted) { handleDrop($0) }
        .onExitCommand { model.requestHide?() }
    }

    // MARK: Pill — one cohesive capsule: mic · field · attach · shot · send

    private var pill: some View {
        HStack(spacing: 10) {
            Button { model.toggleListen() } label: {
                Image(systemName: model.listening ? "mic.fill" : "mic")
                    .font(.system(size: 16, weight: .medium))
                    .foregroundStyle(model.listening ? accent : Color.white.opacity(0.65))
                    .frame(width: 28, height: 28)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help(model.listening ? "Stop listening" : "Speak — the transcription lands in the field")

            TextField(placeholder, text: $model.text)
                .textFieldStyle(.plain)
                .font(.system(size: 15))
                .foregroundStyle(.white.opacity(0.92))
                .onSubmit { model.send() }

            Button { model.requestPickFiles?() } label: {
                Image(systemName: "paperclip")
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(Color.white.opacity(0.55))
                    .frame(width: 26, height: 26)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help("Attach files or images")

            Button { model.requestScreenshot?() } label: {
                Image(systemName: "camera.viewfinder")
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(Color.white.opacity(0.55))
                    .frame(width: 26, height: 26)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help("Screenshot this screen and attach it")

            Button { model.send() } label: {
                Image(systemName: "arrow.up.circle.fill")
                    .font(.system(size: 27))
                    .foregroundStyle(model.busy ? Color.white.opacity(0.25) : accent)
            }
            .buttonStyle(.plain)
            .disabled(model.busy)
            .help("Send")
        }
        .padding(.leading, 16)
        .padding(.trailing, 12)
        .frame(height: 56)
        .background(HUDMaterial(shape: Capsule()))
        .overlay(
            Capsule().strokeBorder(
                dropTargeted ? accent.opacity(0.75) : Color.clear, lineWidth: 1.5)
        )
    }

    // MARK: Aux card — status / attachment chips / approvals, under the pill

    private var auxCard: some View {
        VStack(alignment: .leading, spacing: 0) {
            if !model.status.isEmpty {
                Text(model.status)
                    .font(.system(size: 11.5))
                    .foregroundStyle(.white.opacity(0.6))
                    .lineLimit(2)
                    .padding(.vertical, 9)
            }
            if !model.approvals.isEmpty {
                if !model.status.isEmpty { hairline }
                approvalsSection
            }
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 5)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(HUDMaterial(shape: RoundedRectangle(cornerRadius: 18, style: .continuous)))
    }

    private var hairline: some View {
        Rectangle().fill(Color.white.opacity(0.07)).frame(height: 1)
    }

    /// The row of attachment previews that sits ABOVE the pill. Image files show
    /// a real thumbnail; everything else shows a file card. It scrolls sideways
    /// once several are staged, and each preview removes itself independently.
    private var attachmentsRow: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(model.attachments) { attachment in
                    AttachmentTileView(
                        attachment: attachment,
                        onOpen: { model.requestImagePreview?(attachment.url) },
                        onRemove: { model.removeAttachment(attachment.id) })
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 6)
        }
        .frame(height: 72)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// Hidden entirely (not just empty) whenever the agent has no pending
    /// approvals — including when the endpoint doesn't exist yet.
    private var approvalsSection: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("PENDING APPROVALS")
                .font(.system(size: 9.5, weight: .semibold))
                .tracking(1.6)
                .foregroundStyle(.white.opacity(0.4))
                .padding(.top, 10)
            ForEach(Array(model.approvals.prefix(5).enumerated()), id: \.element.id) { index, approval in
                if index > 0 { hairline }
                ApprovalRow(
                    approval: approval,
                    busy: model.decidingIds.contains(approval.id),
                    error: model.approvalErrors[approval.id],
                    onApprove: { model.decide(approval, approve: true) },
                    onDeny: { model.decide(approval, approve: false) })
            }
            if model.approvals.count > 5 {
                Text("+\(model.approvals.count - 5) more…")
                    .font(.system(size: 10))
                    .foregroundStyle(.white.opacity(0.35))
                    .padding(.bottom, 8)
            }
        }
    }

    private func handleDrop(_ providers: [NSItemProvider]) -> Bool {
        var accepted = false
        let fileType = UTType.fileURL.identifier
        for provider in providers where provider.hasItemConformingToTypeIdentifier(fileType) {
            accepted = true
            // loadItem for the fileURL type returns the URL's byte representation;
            // decode it directly. loadObject(ofClass: URL.self) is unreliable for
            // Finder drags, which is why chips never appeared before.
            provider.loadItem(forTypeIdentifier: fileType, options: nil) { item, _ in
                var resolved: URL?
                switch item {
                case let data as Data:
                    resolved = URL(dataRepresentation: data, relativeTo: nil)
                case let url as URL:
                    resolved = url
                default:
                    break
                }
                guard let url = resolved else { return }
                DispatchQueue.main.async { model.addAttachments(urls: [url]) }
            }
        }
        return accepted
    }
}

// MARK: - Global hotkey (Carbon RegisterEventHotKey — no Accessibility needed)

final class GlobalHotkey {
    struct Candidate {
        let keyCode: UInt32
        let carbonModifiers: UInt32
        let label: String
    }

    /// Tried in order; the first that actually registers wins. Registration
    /// fails (non-noErr) when another app owns the combo via Carbon.
    static let candidates: [Candidate] = [
        Candidate(keyCode: UInt32(kVK_Space), carbonModifiers: UInt32(optionKey), label: "⌥Space"),
        Candidate(keyCode: UInt32(kVK_Space), carbonModifiers: UInt32(controlKey | optionKey), label: "⌃⌥Space"),
        Candidate(keyCode: UInt32(kVK_Space), carbonModifiers: UInt32(cmdKey | shiftKey), label: "⌘⇧Space"),
    ]

    fileprivate static let signature: OSType = {
        var result: OSType = 0
        for byte in "AIPD".utf8 { result = (result << 8) | OSType(byte) }
        return result
    }()

    private var hotKeyRef: EventHotKeyRef?
    private var handlerRef: EventHandlerRef?
    private let onPress: () -> Void
    private(set) var boundLabel: String?

    init(onPress: @escaping () -> Void) {
        self.onPress = onPress
    }

    /// Returns the label of the shortcut that actually bound, nil if all failed.
    @discardableResult
    func register() -> String? {
        installHandlerIfNeeded()
        for (index, candidate) in Self.candidates.enumerated() {
            let hotKeyID = EventHotKeyID(signature: Self.signature, id: UInt32(index + 1))
            var ref: EventHotKeyRef?
            let status = RegisterEventHotKey(candidate.keyCode, candidate.carbonModifiers,
                                             hotKeyID, GetEventDispatcherTarget(), 0, &ref)
            if status == noErr, let ref {
                hotKeyRef = ref
                boundLabel = candidate.label
                NSLog("AI Pendant: global hotkey bound: %@", candidate.label)
                return candidate.label
            }
            NSLog("AI Pendant: hotkey %@ unavailable (OSStatus %d), trying next fallback",
                  candidate.label, status)
        }
        NSLog("AI Pendant: no global hotkey could be registered — HUD stays menu-only")
        return nil
    }

    private func installHandlerIfNeeded() {
        guard handlerRef == nil else { return }
        var eventType = EventTypeSpec(eventClass: OSType(kEventClassKeyboard),
                                      eventKind: UInt32(kEventHotKeyPressed))
        let selfPtr = Unmanaged.passUnretained(self).toOpaque()
        InstallEventHandler(GetEventDispatcherTarget(), { _, event, userData -> OSStatus in
            guard let event, let userData else { return noErr }
            var hotKeyID = EventHotKeyID()
            let status = GetEventParameter(event, EventParamName(kEventParamDirectObject),
                                           EventParamType(typeEventHotKeyID), nil,
                                           MemoryLayout<EventHotKeyID>.size, nil, &hotKeyID)
            guard status == noErr else { return status }
            if hotKeyID.signature == GlobalHotkey.signature {
                let hotkey = Unmanaged<GlobalHotkey>.fromOpaque(userData).takeUnretainedValue()
                DispatchQueue.main.async { hotkey.onPress() }
            }
            return noErr
        }, 1, &eventType, selfPtr, &handlerRef)
    }

    deinit {
        if let hotKeyRef { UnregisterEventHotKey(hotKeyRef) }
        if let handlerRef { RemoveEventHandler(handlerRef) }
    }
}

/// Borderless nonactivating panel that can take key focus while another app
/// stays active, and hides (never closes) on Esc. `canBecomeKey` must be
/// overridden: borderless windows refuse key status by default, which would
/// silently break typing.
final class CommandPanel: NSPanel {
    var onEscape: (() -> Void)?
    override var canBecomeKey: Bool { true }
    override func cancelOperation(_ sender: Any?) { onEscape?() }
    override func keyDown(with event: NSEvent) {
        if event.keyCode == 53 { // Esc — belt and braces beside cancelOperation
            onEscape?()
            return
        }
        super.keyDown(with: event)
    }
}

// MARK: - App delegate (menu bar + window shell)

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate, NSWindowDelegate, NSToolbarDelegate {
    private var statusItem: NSStatusItem!
    private let statusMenu = NSMenu()
    private let statusHeaderItem = NSMenuItem(title: "Agent…", action: nil, keyEquivalent: "")
    private let loginItem = NSMenuItem(title: "Start at Login", action: #selector(toggleLoginItem), keyEquivalent: "")
    private var mainWindow: NSWindow?
    /// Always-on-top compact HUD: text + send while using other apps.
    private var floatPanel: CommandPanel?
    /// The click-to-enlarge image preview, when open. A floating panel owned by
    /// the app (not Preview.app). Counts as "inside" the HUD: clicking it never
    /// hides the pill; clicking truly outside it closes both — see installClickMonitors.
    private var previewPanel: CommandPanel?
    /// Mouse-down monitors that drive outside-click dismissal for the
    /// nonactivating pill. Installed while the pill is shown, removed when hidden.
    private var globalClickMonitor: Any?
    private var localClickMonitor: Any?
    private let model = AgentModel()
    private var cancellables = Set<AnyCancellable>()

    /// HUD state lives on the delegate (not inside the view) so the global
    /// hotkey, status menu, badge polling and Esc all drive one shared model,
    /// even before the panel is first shown.
    private lazy var floatModel = FloatingCommandModel(
        tokenProvider: { AgentEnv.loadToken() },
        agentBaseURL: agentBaseURL)
    private var globalHotkey: GlobalHotkey?
    private let floatCommandItem = NSMenuItem(title: "Floating Command…",
                                              action: #selector(showFloatPanel),
                                              keyEquivalent: "k")

    /// AIPENDANT_SMOKE=1 (test harness only): suppress the cold-launch main
    /// window and listen for a distributed-notification HUD toggle, so a smoke
    /// test can exercise the panel without synthetic keystrokes.
    private var smokeMode: Bool {
        ProcessInfo.processInfo.environment["AIPENDANT_SMOKE"] == "1"
    }

    private var agentBaseURL: URL {
        if smokeMode,
           let raw = ProcessInfo.processInfo.environment["AIPENDANT_SMOKE_AGENT_BASE"],
           let url = URL(string: raw) {
            return url
        }
        return URL(string: "http://127.0.0.1:8000")!
    }

    // Two-view shell: web dashboard (shared with browser + iPhone) and native local view.
    private var webPane: WebPane?
    private var nativePaneView: NSView?
    private var tabControl: NSSegmentedControl?
    private var selectedTab: MainTab = .dashboard
    private static let tabsItemIdentifier = NSToolbarItem.Identifier("tabs")

    private let dashboardURL = URL(string: "https://ai-pendant-dashboard.your-subdomain.workers.dev")!
    private let launchAgentLabel = "com.aipendant.agent"

    func applicationDidFinishLaunching(_ notification: Notification) {
        AgentEnv.registerDefaults()
        buildMainMenu()
        // Variable length: the icon grows a small count title when approvals wait.
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        buildStatusMenu()
        statusItem.menu = statusMenu
        setIcon(online: false)
        refreshLoginItemState()

        model.$online.combineLatest(model.$version)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] online, version in
                self?.applyStatus(online: online, version: version)
            }
            .store(in: &cancellables)
        model.start()

        // Global summon shortcut (Carbon — works without Accessibility). Try
        // ⌥Space → ⌃⌥Space → ⌘⇧Space; every surfaced label reflects what REALLY
        // bound, so a combo owned by another app is never advertised.
        let hotkey = GlobalHotkey { [weak self] in self?.toggleFloatPanel() }
        let boundLabel = hotkey.register()
        globalHotkey = hotkey
        floatModel.applyHotkey(label: boundLabel)
        floatCommandItem.title = boundLabel.map { "Floating Command (\($0))" } ?? "Floating Command…"

        floatModel.requestHide = { [weak self] in self?.hideFloatPanel() }
        floatModel.requestScreenshot = { [weak self] in self?.captureScreenshotAttachment() }
        floatModel.requestPickFiles = { [weak self] in self?.presentFilePicker() }
        floatModel.requestImagePreview = { [weak self] url in self?.presentImagePreview(url: url) }
        floatModel.startApprovalPolling()
        floatModel.$approvals
            .map(\.count)
            .removeDuplicates()
            .receive(on: DispatchQueue.main)
            .sink { [weak self] count in self?.applyApprovalBadge(count) }
            .store(in: &cancellables)

        if smokeMode {
            DistributedNotificationCenter.default().addObserver(
                self, selector: #selector(toggleFloatPanel),
                name: Notification.Name("com.aipendant.menubar.smoke.toggleHUD"),
                object: nil)
            DistributedNotificationCenter.default().addObserver(
                self, selector: #selector(smokeSnapshotHUD),
                name: Notification.Name("com.aipendant.menubar.smoke.snapshotHUD"),
                object: nil)
            DistributedNotificationCenter.default().addObserver(
                self, selector: #selector(smokeAttachTestFile),
                name: Notification.Name("com.aipendant.menubar.smoke.attachTestFile"),
                object: nil)
            DistributedNotificationCenter.default().addObserver(
                self, selector: #selector(smokeSendCommand),
                name: Notification.Name("com.aipendant.menubar.smoke.sendCommand"),
                object: nil)
            DistributedNotificationCenter.default().addObserver(
                self, selector: #selector(smokePickFiles),
                name: Notification.Name("com.aipendant.menubar.smoke.pickFiles"),
                object: nil)
            DistributedNotificationCenter.default().addObserver(
                self, selector: #selector(smokeScreenshot),
                name: Notification.Name("com.aipendant.menubar.smoke.screenshot"),
                object: nil)
            DistributedNotificationCenter.default().addObserver(
                self, selector: #selector(smokePreviewImage),
                name: Notification.Name("com.aipendant.menubar.smoke.previewImage"),
                object: nil)
            DistributedNotificationCenter.default().addObserver(
                self, selector: #selector(smokeSnapshotPreview),
                name: Notification.Name("com.aipendant.menubar.smoke.snapshotPreview"),
                object: nil)
            DistributedNotificationCenter.default().addObserver(
                self, selector: #selector(smokeSetText),
                name: Notification.Name("com.aipendant.menubar.smoke.setText"),
                object: nil)
            DistributedNotificationCenter.default().addObserver(
                self, selector: #selector(smokeOutsideClick),
                name: Notification.Name("com.aipendant.menubar.smoke.outsideClick"),
                object: nil)
            NSLog("AI Pendant: smoke mode — main window suppressed, HUD toggle listener active")
        }

        // A cold launch from Spotlight/Finder/Dock must show the window — otherwise
        // opening the app looks like it did nothing. Launching at login stays quiet
        // in the menu bar.
        if !launchedAsLoginItem && !smokeMode {
            showMainWindow()
        }
    }

    /// True when launchd started us as the user's login item (rather than a user launch).
    private var launchedAsLoginItem: Bool {
        guard let event = NSAppleEventManager.shared().currentAppleEvent,
              event.eventID == kAEOpenApplication else { return false }
        return event.paramDescriptor(forKeyword: keyAEPropData)?.enumCodeValue == keyAELaunchedAsLogInItem
    }

    // Launching the app again (Spotlight, Dock, Finder) shows the window.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showMainWindow()
        return false
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }

    // MARK: Main window

    @objc func showMainWindow() {
        if mainWindow == nil {
            let window = NSWindow(
                contentRect: NSRect(x: 0, y: 0, width: 1200, height: 800),
                styleMask: [.titled, .closable, .miniaturizable, .resizable],
                backing: .buffered,
                defer: false)
            window.title = "AI Pendant"
            window.contentMinSize = NSSize(width: 900, height: 600)
            window.isReleasedWhenClosed = false
            window.delegate = self
            window.appearance = NSAppearance(named: .darkAqua)
            window.titlebarAppearsTransparent = true
            window.titleVisibility = .hidden
            window.backgroundColor = NSColor(red: 0.043, green: 0.051, blue: 0.078, alpha: 1)

            let container = NSView()
            container.wantsLayer = true
            container.layer?.backgroundColor = NSColor(red: 0.043, green: 0.051, blue: 0.078, alpha: 1).cgColor

            let pane = WebPane(url: dashboardURL)
            pane.webView.translatesAutoresizingMaskIntoConstraints = false
            container.addSubview(pane.webView)

            let native = NSHostingView(rootView: ActivityView(model: model))
            native.translatesAutoresizingMaskIntoConstraints = false
            container.addSubview(native)

            NSLayoutConstraint.activate([
                pane.webView.topAnchor.constraint(equalTo: container.topAnchor),
                pane.webView.bottomAnchor.constraint(equalTo: container.bottomAnchor),
                pane.webView.leadingAnchor.constraint(equalTo: container.leadingAnchor),
                pane.webView.trailingAnchor.constraint(equalTo: container.trailingAnchor),
                native.topAnchor.constraint(equalTo: container.topAnchor),
                native.bottomAnchor.constraint(equalTo: container.bottomAnchor),
                native.leadingAnchor.constraint(equalTo: container.leadingAnchor),
                native.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            ])

            webPane = pane
            nativePaneView = native
            window.contentView = container

            let toolbar = NSToolbar(identifier: "AIPendantToolbar")
            toolbar.delegate = self
            toolbar.displayMode = .iconOnly
            toolbar.centeredItemIdentifier = Self.tabsItemIdentifier
            window.toolbar = toolbar
            window.toolbarStyle = .unified

            window.setFrameAutosaveName("AIPendantMainWindow")
            if window.frame.width < 900 { window.setContentSize(NSSize(width: 1200, height: 800)) }
            window.center()
            mainWindow = window

            applyTab(MainTab.remembered) // "Dashboard" unless the user last chose otherwise
        } else {
            applyTab(selectedTab)
        }
        NSApp.setActivationPolicy(.regular) // Dock icon while the window is open
        NSApp.activate(ignoringOtherApps: true)
        mainWindow?.makeKeyAndOrderFront(nil)
        // On a cold launch the policy switch lands mid-launch and the first activation
        // can be ignored (e.g. a fullscreen app owns the active Space), leaving the
        // window created but never fronted. Retry once the run loop settles.
        DispatchQueue.main.async { [weak self] in
            NSApp.activate(ignoringOtherApps: true)
            self?.mainWindow?.makeKeyAndOrderFront(nil)
        }
    }

    func windowWillClose(_ notification: Notification) {
        if (notification.object as? NSWindow) === floatPanel {
            floatModel.panelDidHide() // closed via title-bar button
            return
        }
        guard (notification.object as? NSWindow) === mainWindow else { return }
        model.stopLive()
        NSApp.setActivationPolicy(.accessory) // back to menu-bar-only
    }

    // MARK: Tabs

    @objc private func tabChanged(_ sender: NSSegmentedControl) {
        applyTab(sender.selectedSegment == 1 ? .thisMac : .dashboard)
    }

    private func applyTab(_ tab: MainTab) {
        selectedTab = tab
        tab.remember()
        tabControl?.selectedSegment = (tab == .thisMac) ? 1 : 0

        let showingWeb = (tab == .dashboard)
        webPane?.webView.isHidden = !showingWeb
        nativePaneView?.isHidden = showingWeb

        if showingWeb {
            webPane?.loadIfNeeded()
            model.stopLive()   // no double work while the web view is in front
        } else {
            model.startLive()
        }
    }

    // MARK: Toolbar (segmented tab switcher)

    func toolbarAllowedItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
        [.flexibleSpace, Self.tabsItemIdentifier]
    }

    func toolbarDefaultItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
        [.flexibleSpace, Self.tabsItemIdentifier, .flexibleSpace]
    }

    func toolbar(_ toolbar: NSToolbar,
                 itemForItemIdentifier itemIdentifier: NSToolbarItem.Identifier,
                 willBeInsertedIntoToolbar flag: Bool) -> NSToolbarItem? {
        guard itemIdentifier == Self.tabsItemIdentifier else { return nil }
        let segmented = NSSegmentedControl(labels: ["Dashboard", "This Mac"],
                                           trackingMode: .selectOne,
                                           target: self,
                                           action: #selector(tabChanged(_:)))
        segmented.segmentStyle = .automatic
        segmented.selectedSegment = (selectedTab == .thisMac) ? 1 : 0
        tabControl = segmented

        let item = NSToolbarItem(itemIdentifier: itemIdentifier)
        item.view = segmented
        item.label = "View"
        item.visibilityPriority = .high
        return item
    }

    // MARK: Menus

    private func buildStatusMenu() {
        statusMenu.delegate = self
        statusMenu.autoenablesItems = true

        statusMenu.addItem(makeItem("Open AI Pendant", #selector(showMainWindow)))
        floatCommandItem.target = self
        statusMenu.addItem(floatCommandItem)
        statusMenu.addItem(.separator())

        statusHeaderItem.isEnabled = false
        statusMenu.addItem(statusHeaderItem)
        statusMenu.addItem(.separator())

        statusMenu.addItem(makeItem("Open Dashboard", #selector(openDashboard)))
        statusMenu.addItem(makeItem("Restart Agent", #selector(restartAgent)))
        statusMenu.addItem(makeItem("View Logs", #selector(viewLogs)))
        statusMenu.addItem(.separator())

        loginItem.target = self
        statusMenu.addItem(loginItem)
        statusMenu.addItem(.separator())

        statusMenu.addItem(makeItem("Quit", #selector(quit), key: "q"))
    }

    // Standard main menu so Cmd-Q/Cmd-W/copy-paste work when the window is focused.
    private func buildMainMenu() {
        let mainMenu = NSMenu()

        let appMenuItem = NSMenuItem()
        mainMenu.addItem(appMenuItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About AI Pendant",
                        action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide AI Pendant",
                        action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(withTitle: "Quit AI Pendant",
                        action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appMenuItem.submenu = appMenu

        let fileMenuItem = NSMenuItem()
        mainMenu.addItem(fileMenuItem)
        let fileMenu = NSMenu(title: "File")
        let newWindow = fileMenu.addItem(withTitle: "New Window",
                                         action: #selector(showMainWindow), keyEquivalent: "n")
        newWindow.target = self
        fileMenu.addItem(withTitle: "Close",
                         action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        fileMenuItem.submenu = fileMenu

        let editMenuItem = NSMenuItem()
        mainMenu.addItem(editMenuItem)
        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        editMenu.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        editMenu.addItem(.separator())
        editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "Select All",
                         action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editMenuItem.submenu = editMenu

        NSApp.mainMenu = mainMenu
    }

    private func makeItem(_ title: String, _ action: Selector, key: String = "") -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
        item.target = self
        return item
    }

    func menuWillOpen(_ menu: NSMenu) {
        refreshLoginItemState()
        model.pollHealth()
    }

    // MARK: Status icon

    private func applyStatus(online: Bool, version: String?) {
        setIcon(online: online)
        if online {
            let v = version.map { "v\($0)" } ?? "online"
            statusHeaderItem.title = "Agent \(v) · online"
        } else {
            statusHeaderItem.title = "Agent offline"
        }
        statusItem.button?.toolTip = statusHeaderItem.title
    }

    private func setIcon(online: Bool) {
        let color: NSColor = online ? .systemGreen : .systemRed
        let config = NSImage.SymbolConfiguration(pointSize: 16, weight: .regular)
            .applying(.init(paletteColors: [color]))
        let image = NSImage(systemSymbolName: "waveform.circle.fill",
                            accessibilityDescription: "AI Pendant")?
            .withSymbolConfiguration(config)
        image?.isTemplate = false
        statusItem.button?.image = image
    }

    // MARK: Actions

    @objc private func openDashboard() {
        NSWorkspace.shared.open(dashboardURL)
    }

    /// Compact always-on-top panel: type a command while in any other app.
    /// Summoned from anywhere by the global hotkey (also over fullscreen apps
    /// on the current Space) or from the status menu.
    @objc func showFloatPanel() {
        if floatPanel == nil {
            // Borderless pill: no title bar, no traffic lights, no close box.
            // Esc hides, the global hotkey toggles, an outside click hides (see
            // installClickMonitors), and the background stays draggable.
            let panel = CommandPanel(
                contentRect: NSRect(x: 0, y: 0, width: 660, height: 56),
                styleMask: [.borderless, .nonactivatingPanel],
                backing: .buffered,
                defer: false)
            panel.isFloatingPanel = true
            panel.level = .floating
            // Joins the ACTIVE Space — including other apps' fullscreen Spaces —
            // instead of yanking the user anywhere. (.moveToActiveSpace is
            // meaningless alongside .canJoinAllSpaces and was dropped.)
            panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
            panel.isMovableByWindowBackground = true
            panel.hidesOnDeactivate = false
            panel.becomesKeyOnlyIfNeeded = false
            panel.isReleasedWhenClosed = false
            panel.isOpaque = false
            panel.backgroundColor = .clear   // SwiftUI draws the pill + card
            panel.hasShadow = true
            panel.appearance = NSAppearance(named: .darkAqua)
            panel.delegate = self
            panel.onEscape = { [weak self] in self?.hideFloatPanel() }
            // "Has the user ever placed this panel?" must be answered from the
            // stored default itself: the frame origin is useless as a signal
            // because AppKit constrains a (0,0) frame onto the visible screen
            // at init, so it is never .zero even on a fresh install.
            let hasSavedFrame = UserDefaults.standard
                .object(forKey: "NSWindow Frame AIPendantFloatPanel") != nil
            panel.setFrameAutosaveName("AIPendantFloatPanel")

            let host = NSHostingView(rootView: FloatingCommandView(model: floatModel))
            host.frame = NSRect(x: 0, y: 0, width: 660, height: 56)
            panel.contentView = host
            if !hasSavedFrame, let screen = NSScreen.main {
                let f = screen.visibleFrame
                // Horizontally centered, lower-middle of the screen. Anchored
                // by the TOP edge, which stays fixed while the aux card grows
                // the panel downward.
                panel.setFrameTopLeftPoint(NSPoint(x: f.midX - 330,
                                                   y: f.minY + f.height * 0.42))
            }
            floatPanel = panel
        }
        // Deliberately NO NSApp.activate here: the .nonactivatingPanel becomes
        // key on its own, so typing lands immediately while the frontmost app
        // (and its fullscreen Space) stays exactly where it was.
        floatPanel?.makeKeyAndOrderFront(nil)
        floatModel.panelDidShow()
        installClickMonitors()   // outside-click dismissal is live only while shown
        focusCommandField()
    }

    /// Global hotkey behavior: hidden → show + focus; visible → hide.
    @objc private func toggleFloatPanel() {
        if let panel = floatPanel, panel.isVisible {
            NSLog("AI Pendant: HUD toggle → hide")
            hideFloatPanel()
        } else {
            NSLog("AI Pendant: HUD toggle → show")
            showFloatPanel()
        }
    }

    private func hideFloatPanel() {
        removeClickMonitors()
        dismissImagePreview(refocusPill: false) // don't leave an orphan preview
        floatModel.cancelListening() // never keep the mic hot on a hidden panel
        floatPanel?.orderOut(nil)
        floatModel.panelDidHide()
        // Deliberately NOT clearing text/attachments: the draft survives the hide
        // and is restored on the next summon (send() is the only thing that clears).
    }

    /// Click-to-enlarge: show the image in a dim, borderless floating lightbox
    /// owned by the app. Never NSWorkspace.open/Preview.app — that would yank the
    /// user out of a fullscreen Space. The panel joins the active Space and floats
    /// over fullscreen apps, exactly like the pill.
    private func presentImagePreview(url: URL) {
        guard let screen = floatPanel?.screen ?? NSScreen.main else { return }
        let vis = screen.visibleFrame
        // Comfortable max box (points); load a matching downsample — not the row's
        // 256px thumbnail, and not the full-res original at full RAM cost.
        let maxBox = CGSize(width: vis.width * 0.8, height: vis.height * 0.8)
        let maxDim = Int(max(maxBox.width, maxBox.height) * screen.backingScaleFactor)
        guard let image = AttachmentThumbnail.loadSized(path: url.path, maxPixel: min(maxDim, 4000)) else {
            NSLog("AI Pendant: preview — could not decode %@", url.path)
            return
        }
        // Aspect-fit into the box (modest upscaling for tiny images), then wrap in
        // the backdrop inset. The panel is EXACTLY this card, centered — so a click
        // outside it is a genuine outside-click, not "on the preview".
        let s = image.size
        let scale = (s.width > 0 && s.height > 0)
            ? min(maxBox.width / s.width, maxBox.height / s.height, 3) : 1
        let inset: CGFloat = 14
        let cardSize = CGSize(width: (s.width * scale + inset * 2).rounded(),
                              height: (s.height * scale + inset * 2).rounded())

        dismissImagePreview(refocusPill: false) // replace any existing preview

        let panel = CommandPanel(
            contentRect: NSRect(origin: .zero, size: cardSize),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered, defer: false)
        panel.isFloatingPanel = true
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.hidesOnDeactivate = false
        panel.becomesKeyOnlyIfNeeded = false
        panel.isReleasedWhenClosed = false
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.appearance = NSAppearance(named: .darkAqua)
        // Esc while the preview is key closes ONLY the preview (it's key, so the
        // pill's own Esc handler never sees the event); then the pill is re-keyed.
        panel.onEscape = { [weak self] in self?.dismissImagePreview() }

        let host = NSHostingView(rootView: ImagePreviewView(image: image, inset: inset) { [weak self] in
            self?.dismissImagePreview()
        })
        host.frame = NSRect(origin: .zero, size: cardSize)
        panel.contentView = host
        panel.setFrame(NSRect(x: (vis.midX - cardSize.width / 2).rounded(),
                              y: (vis.midY - cardSize.height / 2).rounded(),
                              width: cardSize.width, height: cardSize.height),
                       display: true)

        previewPanel = panel                 // set BEFORE key so the monitors treat it as "inside"
        panel.makeKeyAndOrderFront(nil)
        NSLog("AI Pendant: image preview open — %@ card %.0fx%.0f",
              url.lastPathComponent, cardSize.width, cardSize.height)
    }

    private func dismissImagePreview(refocusPill: Bool = true) {
        guard previewPanel != nil else { return }
        previewPanel?.orderOut(nil)
        previewPanel = nil
        // Hand key back to the pill so typing resumes right where it left off.
        if refocusPill, let panel = floatPanel, panel.isVisible {
            panel.makeKey()
            focusCommandField()
        }
    }

    // MARK: Outside-click dismissal (mouse-down monitors, not resignKey)

    /// Any mouse-down outside the HUD hides the pill immediately — every time, no
    /// exceptions for staged attachments, pending approvals or live dictation.
    /// A .nonactivatingPanel can't rely on resignKey (it often keeps key while
    /// another app is clicked), so we watch mouse-downs directly:
    ///   • a GLOBAL mouse-down is a click in another app → always outside;
    ///   • a LOCAL mouse-down is outside only if it hit a window that is NOT the
    ///     pill (its aux card lives in the same window) or the image preview.
    /// Suspended while the attach sheet is modal on the pill, so the picker
    /// doesn't yank its own host window out from under itself.
    private func installClickMonitors() {
        guard globalClickMonitor == nil, localClickMonitor == nil else { return }
        let mask: NSEvent.EventTypeMask = [.leftMouseDown, .rightMouseDown, .otherMouseDown]
        globalClickMonitor = NSEvent.addGlobalMonitorForEvents(matching: mask) { [weak self] _ in
            self?.handleClickOutsideHUD()
        }
        localClickMonitor = NSEvent.addLocalMonitorForEvents(matching: mask) { [weak self] event in
            guard let self else { return event }
            let w = event.window
            let insideHUD = (w === self.floatPanel) || (w === self.previewPanel)
            if !insideHUD { self.handleClickOutsideHUD() }
            return event   // never swallow — the pill's own buttons/field still work
        }
    }

    private func removeClickMonitors() {
        if let m = globalClickMonitor { NSEvent.removeMonitor(m); globalClickMonitor = nil }
        if let m = localClickMonitor { NSEvent.removeMonitor(m); localClickMonitor = nil }
    }

    /// A click landed outside the HUD. Hiding is NON-DESTRUCTIVE: the draft (typed
    /// text + staged attachments) stays in the model and returns on the next
    /// summon; hideFloatPanel also stops any live dictation so nothing records
    /// unseen (already-transcribed text is kept). A click truly outside while the
    /// enlarged preview is open closes BOTH, because hideFloatPanel dismisses it.
    private func handleClickOutsideHUD() {
        guard floatPanel?.isVisible == true else { return }
        guard !floatModel.isFilePickerOpen else { return }
        hideFloatPanel()
    }

    /// Camera button: immediately screenshot the WHOLE display the pill is on,
    /// with the HUD excluded. No region drag, no interactive mode. We orderOut
    /// the panel first, wait a beat so the window server actually drops it from
    /// the screen (orderOut flips isVisible synchronously but the pixels linger
    /// a frame — capturing too soon would put the pill in the shot), capture
    /// that one display, then re-show the pill and attach the PNG as a chip.
    private func captureScreenshotAttachment() {
        guard let panel = floatPanel else { return }
        let wasVisible = panel.isVisible
        // Read the target display BEFORE hiding — panel.screen is nil off-screen.
        let targetScreen = panel.screen ?? NSScreen.main
        let displayIndex = Self.screencaptureDisplayIndex(for: targetScreen)
        let windowNumber = panel.windowNumber
        let path = NSTemporaryDirectory()
            .appending("aipendant-shot-\(Int(Date().timeIntervalSince1970)).png")

        panel.orderOut(nil)

        // Do NOT capture until the pill's pixels are actually gone. orderOut flips
        // isVisible synchronously, but the window server composites the removal a
        // frame or two later. occlusionState is useless here (it lags and never
        // updates for a background agent panel), so poll the authoritative,
        // TCC-free on-screen window list for our window number and capture the
        // instant it disappears — bounded so we always proceed.
        func captureWhenGone(_ tries: Int) {
            if Self.windowIsOnScreen(windowNumber), tries < 20 {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.02) { captureWhenGone(tries + 1) }
                return
            }
            let pillGone = !Self.windowIsOnScreen(windowNumber)
            NSLog("AI Pendant: screenshot — pillOnScreen=%d after %d checks, display=%@",
                  pillGone ? 0 : 1, tries, displayIndex.map(String.init) ?? "main")

            var args: [String] = ["-x"] // -x: silent, no camera sound
            if let displayIndex { args += ["-D", String(displayIndex)] }
            args.append(path)

            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
            process.arguments = args
            process.terminationHandler = { [weak self] proc in
                DispatchQueue.main.async {
                    guard let self else { return }
                    if wasVisible { self.showFloatPanel() }
                    let exists = FileManager.default.fileExists(atPath: path)
                    if proc.terminationStatus == 0, exists {
                        self.floatModel.addAttachments(urls: [URL(fileURLWithPath: path)])
                        NSLog("AI Pendant: screenshot saved + attached: %@", path)
                    } else {
                        self.floatModel.status =
                            "Screenshot failed — grant AI Pendant Screen Recording in System Settings"
                        NSLog("AI Pendant: screencapture exit=%d fileExists=%d",
                              proc.terminationStatus, exists ? 1 : 0)
                    }
                }
            }
            do {
                try process.run()
            } catch {
                NSLog("AI Pendant: screencapture failed to launch: \(error)")
                if wasVisible { self.showFloatPanel() }
            }
        }
        captureWhenGone(0)
    }

    /// True while the given window number is still in the on-screen window list —
    /// the authoritative, TCC-free signal that its pixels are composited. Used to
    /// confirm the pill is gone before a full-screen capture.
    private static func windowIsOnScreen(_ windowNumber: Int) -> Bool {
        guard windowNumber != 0,
              let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID)
                as? [[String: Any]] else { return false }
        return list.contains { ($0[kCGWindowNumber as String] as? Int) == windowNumber }
    }

    /// Maps an NSScreen to `screencapture -D` 1-based index (active-display-list
    /// order). Single-display Macs resolve to 1 (the main display). Returns nil
    /// when the screen can't be mapped, in which case the caller omits -D and
    /// screencapture uses the main display.
    private static func screencaptureDisplayIndex(for screen: NSScreen?) -> Int? {
        guard let screen,
              let num = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber
        else { return nil }
        let targetID = CGDirectDisplayID(num.uint32Value)
        var count: UInt32 = 0
        guard CGGetActiveDisplayList(0, nil, &count) == .success, count > 0 else { return nil }
        var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
        guard CGGetActiveDisplayList(count, &ids, &count) == .success,
              let idx = ids.firstIndex(of: targetID) else { return nil }
        return idx + 1
    }

    /// Paperclip: present a real NSOpenPanel. An .accessory (LSUIElement) app
    /// backed by a borderless .nonactivatingPanel is the hard case here — a
    /// free-standing NSOpenPanel run via begin()/runModal() logs as "presented"
    /// but its window frequently never lands on the current Space (it only
    /// appears when some OTHER regular window of the app happens to exist), so
    /// nothing is ever selected. The robust fix is to attach the panel as a
    /// SHEET of the pill: the pill is a real, visible, key window that already
    /// joins the active Space and floats over fullscreen apps, so the sheet is
    /// guaranteed to appear right there and take input.
    private func presentFilePicker() {
        guard let panel = floatPanel, panel.isVisible else { return }
        floatModel.isFilePickerOpen = true // keep the pill from hiding on blur

        // Make sure the pill is key so the sheet is interactive, but stay
        // .accessory: no policy juggling, no Dock-icon flicker, no Space switch.
        panel.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        let picker = NSOpenPanel()
        picker.canChooseFiles = true
        picker.canChooseDirectories = false
        picker.allowsMultipleSelection = true
        picker.message = "Attach files to your command"
        picker.prompt = "Attach"
        NSLog("AI Pendant: file picker presenting as sheet on the pill")

        picker.beginSheetModal(for: panel) { [weak self] response in
            guard let self else { return }
            let urls = response == .OK ? picker.urls : []
            NSLog("AI Pendant: file picker closed response=%ld urls=%d", response.rawValue, urls.count)
            self.floatModel.isFilePickerOpen = false
            if !urls.isEmpty { self.floatModel.addAttachments(urls: urls) }
            // Re-key the pill and drop the caret back into the field.
            if self.floatPanel?.isVisible == true {
                self.floatPanel?.makeKey()
                self.focusCommandField()
            }
        }
    }

    /// Caret into the command field on summon, so hotkey → type needs no click.
    private func focusCommandField() {
        func firstEditableTextField(_ view: NSView) -> NSTextField? {
            if let field = view as? NSTextField, field.isEditable { return field }
            for sub in view.subviews {
                if let found = firstEditableTextField(sub) { return found }
            }
            return nil
        }
        DispatchQueue.main.async { [weak self] in
            guard let panel = self?.floatPanel, panel.isVisible,
                  let content = panel.contentView,
                  let field = firstEditableTextField(content) else { return }
            panel.makeFirstResponder(field)
        }
    }

    /// Smoke-harness only: the app renders its own HUD content to a PNG (an app
    /// may always draw its own windows — no Screen Recording TCC involved) so a
    /// headless test can SEE the panel. Inert outside AIPENDANT_SMOKE=1.
    @objc private func smokeSnapshotHUD() {
        guard smokeMode,
              let path = ProcessInfo.processInfo.environment["AIPENDANT_SMOKE_SNAPSHOT"],
              !path.isEmpty,
              let panel = floatPanel, panel.isVisible,
              let view = panel.contentView else {
            NSLog("AI Pendant: smoke snapshot skipped (panel hidden or no path)")
            return
        }
        // Dark ground: the pill floats over a dark HUD material in real life.
        writeSnapshot(of: view, to: path, ground: NSColor(red: 0.16, green: 0.18, blue: 0.22, alpha: 1))
        NSLog("AI Pendant: smoke snapshot written — panel %.0fx%.0f at (%.0f, %.0f)",
              panel.frame.width, panel.frame.height,
              panel.frame.origin.x, panel.frame.origin.y)
    }

    /// Smoke-harness only: open the lightbox for the first staged image through
    /// the SAME path the thumbnail click uses, so the preview can be verified.
    @objc private func smokePreviewImage() {
        guard smokeMode,
              let url = floatModel.attachments.first(where: { $0.isImage })?.url else {
            NSLog("AI Pendant: smoke preview — no image attachment staged")
            return
        }
        presentImagePreview(url: url)
    }

    /// Smoke-harness only: render the open lightbox to a PNG. Composited over a
    /// LIGHT ground to prove the dim backdrop + image read even over a bright desktop.
    @objc private func smokeSnapshotPreview() {
        guard smokeMode,
              let path = ProcessInfo.processInfo.environment["AIPENDANT_SMOKE_PREVIEW_SNAPSHOT"],
              !path.isEmpty,
              let panel = previewPanel, panel.isVisible,
              let view = panel.contentView else {
            NSLog("AI Pendant: smoke preview snapshot skipped (no lightbox or no path)")
            return
        }
        writeSnapshot(of: view, to: path, ground: NSColor(calibratedWhite: 0.85, alpha: 1))
        NSLog("AI Pendant: smoke preview snapshot written — panel %.0fx%.0f", panel.frame.width, panel.frame.height)
    }

    /// Renders a view offscreen (an app may always draw its own windows — no
    /// Screen Recording TCC) over a solid ground, since the panels are clear and
    /// the blur material does not composite offline.
    private func writeSnapshot(of view: NSView, to path: String, ground: NSColor) {
        guard let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return }
        view.cacheDisplay(in: view.bounds, to: rep)
        let composed = NSImage(size: view.bounds.size)
        composed.lockFocus()
        ground.setFill()
        NSRect(origin: .zero, size: view.bounds.size).fill()
        rep.draw(in: NSRect(origin: .zero, size: view.bounds.size))
        composed.unlockFocus()
        if let tiff = composed.tiffRepresentation,
           let outRep = NSBitmapImageRep(data: tiff),
           let data = outRep.representation(using: .png, properties: [:]) {
            try? data.write(to: URL(fileURLWithPath: path))
        }
    }

    /// Smoke-harness only: attach a real file path (from AIPENDANT_SMOKE_ATTACH)
    /// through the EXACT code the file panel's completion uses, so a headless
    /// test can prove a returned URL becomes a chip and rides the /plan body.
    @objc private func smokeAttachTestFile() {
        guard smokeMode,
              let raw = ProcessInfo.processInfo.environment["AIPENDANT_SMOKE_ATTACH"],
              !raw.isEmpty else { return }
        // Newline-separates paths so one run can stage an image AND a non-image
        // and prove both render styles in a single snapshot. One path → one file.
        let urls = raw.split(separator: "\n").map { URL(fileURLWithPath: String($0)) }
        floatModel.addAttachments(urls: urls)
        NSLog("AI Pendant: smoke attach — attachments now %d", floatModel.attachments.count)
    }

    /// Smoke-harness only: set the draft text (so a hide→reshow can prove the
    /// typed draft survives the hide, not just the attachments).
    @objc private func smokeSetText() {
        guard smokeMode else { return }
        let t = ProcessInfo.processInfo.environment["AIPENDANT_SMOKE_TEXT"] ?? "Draft: compare the Q3 numbers"
        floatModel.text = t
        NSLog("AI Pendant: smoke set text — %@", t)
    }

    /// Smoke-harness only: run the EXACT outside-click handler the mouse monitors
    /// call, so hide-on-outside-click, draft preservation, and close-both-with-
    /// preview-open can be verified without synthesizing real desktop clicks.
    @objc private func smokeOutsideClick() {
        guard smokeMode else { return }
        handleClickOutsideHUD()
        NSLog("AI Pendant: smoke outside-click — after: visible=%d text=%d attach=%d preview=%d",
              (floatPanel?.isVisible ?? false) ? 1 : 0,
              floatModel.text.isEmpty ? 0 : 1,
              floatModel.attachments.count,
              previewPanel == nil ? 0 : 1)
    }

    /// Smoke-harness only: fire send() with the currently-staged attachments so
    /// the test can inspect the POST body the agent receives.
    @objc private func smokeSendCommand() {
        guard smokeMode else { return }
        if floatModel.text.isEmpty { floatModel.text = "look at the attached files" }
        floatModel.send()
    }

    /// Smoke-harness only: present the real NSOpenPanel (blocks in runModal;
    /// the test screencaptures the panel to prove it presents).
    @objc private func smokePickFiles() {
        guard smokeMode else { return }
        presentFilePicker()
    }

    /// Smoke-harness only: trigger the real full-display screenshot path.
    @objc private func smokeScreenshot() {
        guard smokeMode else { return }
        captureScreenshotAttachment()
    }

    /// Menu-bar badge: waveform icon plus a small count while approvals wait.
    private func applyApprovalBadge(_ count: Int) {
        guard let button = statusItem?.button else { return }
        if count > 0 {
            button.imagePosition = .imageLeft
            button.title = " \(count)"
        } else {
            button.title = ""
            button.imagePosition = .imageOnly
        }
    }

    @objc private func restartAgent() {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        process.arguments = ["kickstart", "-k", "gui/\(getuid())/\(launchAgentLabel)"]
        do {
            try process.run()
        } catch {
            NSLog("AI Pendant: failed to kickstart agent: \(error)")
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
            self?.model.pollHealth()
        }
    }

    @objc private func viewLogs() {
        let dir = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Logs/AIPendant", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        NSWorkspace.shared.open(dir)
    }

    @objc private func toggleLoginItem() {
        let service = SMAppService.mainApp
        do {
            if service.status == .enabled {
                try service.unregister()
            } else {
                try service.register()
            }
        } catch {
            NSLog("AI Pendant: login item toggle failed: \(error)")
        }
        refreshLoginItemState()
    }

    private func refreshLoginItemState() {
        loginItem.state = SMAppService.mainApp.status == .enabled ? .on : .off
    }

    @objc private func quit() {
        NSApp.terminate(nil)
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
