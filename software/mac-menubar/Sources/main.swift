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
import WebKit
import SwiftUI
import Combine
import ServiceManagement
import Speech
import AVFoundation

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
    var isImage: Bool {
        ["png", "jpg", "jpeg", "gif", "heic", "webp", "tiff", "bmp"]
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
    /// Wired by the app delegate: hide the HUD, run interactive `screencapture -i`,
    /// re-show, attach the capture.
    var requestScreenshot: (() -> Void)?
    /// Wired by the app delegate: re-key the panel and focus the field (used
    /// after the file picker closes).
    var requestFocus: (() -> Void)?

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
        let command = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !command.isEmpty else {
            status = "Enter a command first"
            return
        }
        guard let token = tokenProvider(), !token.isEmpty else {
            status = "Missing AGENT_TOKEN in \(AgentEnv.envPath)"
            return
        }
        busy = true
        status = "Sending…"
        var request = URLRequest(url: agentBaseURL.appendingPathComponent("plan"))
        request.httpMethod = "POST"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let body: [String: Any] = [
            "command": command,
            "source": "floating-hud",
            "autoExecute": true,
        ]
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
                    return
                }
                let reply = (json["response"] as? String)
                    ?? (json["error"] as? String)
                    ?? "ok"
                self?.status = reply
                if json["error"] == nil { self?.text = "" }
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
    /// failed) and refreshes the idle hint. Never advertises a failed binding.
    func applyHotkey(label: String?) {
        hotkeyLabel = label
        if status.hasPrefix("Type a command") {
            status = "Type a command · \(label ?? "⌘K from menu bar")"
        }
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

struct ApprovalRow: View {
    let approval: PendingApproval
    let busy: Bool
    let error: String?
    let onApprove: () -> Void
    let onDeny: () -> Void

    private var riskColor: Color {
        switch (approval.risk ?? "").lowercased() {
        case "high", "critical": return .red
        case "medium", "moderate": return .orange
        case "low": return .green
        default: return Color.white.opacity(0.4)
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .center, spacing: 8) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(approval.summary?.isEmpty == false ? approval.summary! : approval.id)
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(.white.opacity(0.88))
                        .lineLimit(2)
                    HStack(spacing: 6) {
                        if let risk = approval.risk, !risk.isEmpty {
                            Text(risk.uppercased())
                                .font(.system(size: 9, weight: .bold))
                                .foregroundStyle(riskColor)
                                .padding(.horizontal, 5)
                                .padding(.vertical, 1)
                                .background(Capsule().fill(riskColor.opacity(0.16)))
                        }
                        if let expires = approval.expiresAt, !expires.isEmpty {
                            Text("expires \(When.relative(expires))")
                                .font(.system(size: 10))
                                .foregroundStyle(.white.opacity(0.35))
                        }
                        if let origin = approval.origin, !origin.isEmpty {
                            Text("· \(origin)")
                                .font(.system(size: 10))
                                .foregroundStyle(.white.opacity(0.3))
                                .lineLimit(1)
                        }
                    }
                }
                Spacer(minLength: 8)
                Button { onDeny() } label: {
                    Text("Deny")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(.white.opacity(busy ? 0.3 : 0.8))
                        .padding(.horizontal, 10)
                        .padding(.vertical, 4)
                        .background(Capsule().fill(Color.white.opacity(0.08)))
                }
                .buttonStyle(.plain)
                .disabled(busy)
                Button { onApprove() } label: {
                    Text("Approve")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(Color(red: 0.46, green: 0.90, blue: 0.64).opacity(busy ? 0.3 : 1))
                        .padding(.horizontal, 10)
                        .padding(.vertical, 4)
                        .background(Capsule().fill(Color(red: 0.46, green: 0.90, blue: 0.64).opacity(0.18)))
                }
                .buttonStyle(.plain)
                .disabled(busy)
            }
            if let error, !error.isEmpty {
                Text(error)
                    .font(.system(size: 10))
                    .foregroundStyle(Color.red.opacity(0.9))
                    .lineLimit(2)
            }
        }
        .help(approval.detail ?? "")
    }
}

struct FloatingCommandView: View {
    @ObservedObject var model: FloatingCommandModel

    private var placeholder: String {
        model.hotkeyLabel.map { "Command · \($0)" } ?? "Command…"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Button {
                    model.toggleListen()
                } label: {
                    Image(systemName: model.listening ? "mic.fill" : "mic")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(model.listening ? Color.green : Color.white.opacity(0.85))
                        .frame(width: 32, height: 32)
                        .background(Circle().fill(Color.white.opacity(0.08)))
                }
                .buttonStyle(.plain)
                .help(model.listening ? "Stop listening" : "Speak a command")

                TextField(placeholder, text: $model.text)
                    .textFieldStyle(.plain)
                    .font(.system(size: 14))
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(RoundedRectangle(cornerRadius: 10).fill(Color.white.opacity(0.06)))
                    .onSubmit { model.send() }

                Button {
                    model.send()
                } label: {
                    Image(systemName: "arrow.up.circle.fill")
                        .font(.system(size: 26))
                        .foregroundStyle(model.busy ? Color.white.opacity(0.3) : Color(red: 0.46, green: 0.90, blue: 0.64))
                }
                .buttonStyle(.plain)
                .disabled(model.busy)
            }
            Text(model.status)
                .font(.system(size: 11))
                .foregroundStyle(Color.white.opacity(0.45))
                .lineLimit(1)
            if !model.approvals.isEmpty {
                approvalsSection
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        // Fixed width, content-driven height: the NSHostingView exposes this as
        // its intrinsic size and AppKit resizes the panel to match (top edge
        // anchored), so the panel grows/shrinks with the approvals list.
        .frame(width: 440)
        .fixedSize(horizontal: false, vertical: true)
        .onExitCommand { model.requestHide?() }
    }

    /// Hidden entirely (not just empty) whenever the agent has no pending
    /// approvals — including when the endpoint doesn't exist yet.
    private var approvalsSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Divider().overlay(Color.white.opacity(0.1))
            Text("PENDING APPROVALS")
                .font(.system(size: 9, weight: .bold))
                .tracking(1.8)
                .foregroundStyle(.white.opacity(0.35))
            ForEach(model.approvals.prefix(5)) { approval in
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
            }
        }
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

/// Nonactivating panel that can take key focus while another app stays active,
/// and hides (rather than closes) on Esc.
final class CommandPanel: NSPanel {
    var onEscape: (() -> Void)?
    override var canBecomeKey: Bool { true }
    override func cancelOperation(_ sender: Any?) { onEscape?() }
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
            let panel = CommandPanel(
                contentRect: NSRect(x: 0, y: 0, width: 440, height: 88),
                styleMask: [.titled, .closable, .fullSizeContentView, .nonactivatingPanel],
                backing: .buffered,
                defer: false)
            panel.title = "Command"
            panel.titleVisibility = .hidden
            panel.titlebarAppearsTransparent = true
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
            panel.backgroundColor = NSColor(red: 0.06, green: 0.07, blue: 0.10, alpha: 0.94)
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
            host.frame = NSRect(x: 0, y: 0, width: 440, height: 88)
            panel.contentView = host
            if !hasSavedFrame, let screen = NSScreen.main {
                let f = screen.visibleFrame
                // Spotlight-ish: horizontally centered, a bit above center.
                // Anchored by the TOP edge, which stays fixed as approvals grow
                // the panel downward.
                panel.setFrameTopLeftPoint(NSPoint(x: f.midX - 220, y: f.midY + 44))
            }
            floatPanel = panel
        }
        // Deliberately NO NSApp.activate here: the .nonactivatingPanel becomes
        // key on its own, so typing lands immediately while the frontmost app
        // (and its fullscreen Space) stays exactly where it was.
        floatPanel?.makeKeyAndOrderFront(nil)
        floatModel.panelDidShow()
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
        floatPanel?.orderOut(nil)
        floatModel.panelDidHide()
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
              let view = panel.contentView,
              let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else {
            NSLog("AI Pendant: smoke snapshot skipped (panel hidden or no path)")
            return
        }
        view.cacheDisplay(in: view.bounds, to: rep)
        // Composite over the panel background so the (white) text is legible —
        // cacheDisplay alone yields text over transparency.
        let composed = NSImage(size: view.bounds.size)
        composed.lockFocus()
        (panel.backgroundColor ?? .windowBackgroundColor).setFill()
        NSRect(origin: .zero, size: view.bounds.size).fill()
        rep.draw(in: NSRect(origin: .zero, size: view.bounds.size))
        composed.unlockFocus()
        if let tiff = composed.tiffRepresentation,
           let outRep = NSBitmapImageRep(data: tiff),
           let data = outRep.representation(using: .png, properties: [:]) {
            try? data.write(to: URL(fileURLWithPath: path))
            NSLog("AI Pendant: smoke snapshot written — panel %.0fx%.0f at (%.0f, %.0f)",
                  panel.frame.width, panel.frame.height,
                  panel.frame.origin.x, panel.frame.origin.y)
        }
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
