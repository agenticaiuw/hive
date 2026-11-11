import Darwin
import Foundation

/// Semantic, focus-free control channel for VS Code-family Electron renderers.
///
/// Cursor/VS Code intentionally ignore synthetic background wheel events, and their editor
/// scrollbar is not settable through macOS Accessibility. A private extension loaded only into
/// the agent-owned instance can invoke the editor's own commands instead. Every vertical scroll
/// response includes the visible ranges before and after; an accepted command with no range
/// change is an error, never a successful-return/no-effect result.
///
/// Two operations cannot be confirmed that way and say so rather than pretending:
/// horizontal reveal (VS Code exposes no horizontal viewport offset) reports
/// `confirmed == false`, and callers surface it through the established unconfirmed-delivery
/// warning instead of a bare success.
public actor ElectronEditorBridge {
    struct ControlRequest: Codable, Sendable {
        let version: Int
        let token: String
        let command: String
        var direction: String?
        var pages: Int?
        var column: Int?
        var anchorLine: Int?
        var anchorCharacter: Int?
        var activeLine: Int?
        var activeCharacter: Int?
        var file: String?
    }

    /// One visible editor pane, as the adapter sees it.
    public struct EditorState: Codable, Sendable, Equatable {
        public let column: Int?
        public let document: String
        public let visible: [[Int]]
        public let selections: [[Int]]
        public let version: Int
        public let lineCount: Int
    }

    struct RevealInfo: Codable, Sendable, Equatable {
        let line: Int
        let character: Int
        let longestVisibleLineLength: Int
    }

    struct ControlResponse: Codable, Sendable, Equatable {
        let ok: Bool
        var ready: Bool?
        var confirmed: Bool?
        var changed: Bool?
        var before: [[Int]]?
        var after: [[Int]]?
        var visible: [[Int]]?
        var document: String?
        var column: Int?
        var editors: [EditorState]?
        var active: Int?
        var state: EditorState?
        var selectedText: String?
        var opened: String?
        var reveal: RevealInfo?
        var error: String?
    }

    public struct ScrollEffect: Sendable, Equatable {
        public let document: String
        public let before: [[Int]]
        public let after: [[Int]]
        public var column: Int?
    }

    /// A horizontal reveal. `confirmed` is always false — see the type doc comment.
    public struct RevealEffect: Sendable, Equatable {
        public let document: String
        public let line: Int
        public let character: Int
        public let longestVisibleLineLength: Int
        public var column: Int?
        public var confirmed: Bool { false }
    }

    public struct Layout: Sendable, Equatable {
        public let editors: [EditorState]
        public let active: Int?
    }

    public struct SelectionEffect: Sendable, Equatable {
        public let document: String
        public let before: [[Int]]
        public let after: [[Int]]
        public let selectedText: String
        public let changed: Bool
    }

    private let endpoint: ElectronControlEndpoint

    public init(endpoint: ElectronControlEndpoint) {
        self.endpoint = endpoint
    }

    public func waitUntilReady(timeout: TimeInterval = 10) async -> Bool {
        guard timeout.isFinite, timeout > 0, timeout <= 60 else { return false }
        return (try? await BridgeReadiness.wait(timeout: timeout, interval: 0.1) {
            _ = try await ping()
            return true
        }) ?? false
    }

    /// Readiness is "the adapter answered", deliberately independent of the pane layout.
    /// Tying it to a single visible editor made an ordinary split window look like an adapter
    /// that never came up.
    @discardableResult
    public func ping() async throws -> String {
        let response = try await exchange(request("ping"))
        guard response.ok else {
            throw SpaceOError.unsupportedTarget(
                response.error ?? "Electron editor controller is not ready")
        }
        return response.document ?? ""
    }

    public func layout() async throws -> Layout {
        let response = try await exchange(request("layout"))
        guard response.ok, let editors = response.editors else {
            throw SpaceOError.unsupportedTarget(
                response.error ?? "Electron editor controller did not report its layout")
        }
        return Layout(editors: editors, active: response.active)
    }

    /// Current document version and selection for one pane — the observable a typing or key
    /// delivery is confirmed against.
    public func state(column: Int? = nil) async throws -> EditorState {
        var payload = request("state")
        payload.column = column
        let response = try await exchange(payload)
        guard response.ok, let state = response.state else {
            throw SpaceOError.unsupportedTarget(
                response.error ?? "Electron editor controller did not report its state")
        }
        return state
    }

    /// Open one requested file through the extension API and confirm which document appeared.
    ///
    /// Cursor's agent/home surface can ignore the ordinary LaunchServices open-document event
    /// (and even a positional CLI path) when a separate instance starts. The authenticated
    /// adapter is already scoped to this owned process, so opening through it is both more
    /// precise and observable: the response names the editor document it actually created.
    @discardableResult
    public func openDocument(_ file: URL) async throws -> EditorState {
        guard file.isFileURL, file.path.utf8.count <= 12_000,
              file.path.count <= 4_096 else {
            throw SpaceOError.badRequest(
                "Electron document paths must be file URLs up to 4096 characters "
                    + "and 12000 UTF-8 bytes")
        }
        var payload = request("open")
        payload.file = file.path
        let response = try await exchange(payload)
        guard response.ok, let state = response.state,
              let opened = response.opened, !opened.isEmpty else {
            throw SpaceOError.unsupportedTarget(
                response.error ?? "Electron editor did not confirm the requested document")
        }
        let expectedURL = file.standardizedFileURL.resolvingSymlinksInPath()
        let openedURL = URL(fileURLWithPath: opened)
            .standardizedFileURL.resolvingSymlinksInPath()
        guard openedURL == expectedURL else {
            throw SpaceOError.unsupportedTarget(
                "Electron editor opened a different document than the one requested")
        }
        return state
    }

    @discardableResult
    public func scroll(deltaY: Int, pages: Int, column: Int? = nil) async throws -> ScrollEffect {
        guard deltaY != 0 else {
            throw SpaceOError.badRequest("Electron editor scroll needs a non-zero vertical delta")
        }
        guard (1...100).contains(pages) else {
            throw SpaceOError.badRequest("scroll ticks must be from 1 through 100")
        }
        var payload = request("scroll")
        payload.direction = deltaY < 0 ? "down" : "up"
        payload.pages = pages
        payload.column = column
        let response = try await exchange(payload)
        guard response.ok else {
            throw SpaceOError.unsupportedTarget(
                response.error ?? "Electron editor rejected the semantic scroll")
        }
        guard response.changed == true,
              let before = response.before,
              let after = response.after,
              before != after,
              let document = response.document,
              !document.isEmpty else {
            throw SpaceOError.unsupportedTarget(
                "Electron editor returned without an observable visible-range change")
        }
        return ScrollEffect(
            document: document, before: before, after: after, column: response.column)
    }

    /// Horizontal movement. The sign convention mirrors the vertical one: a negative delta moves
    /// the viewport forward, which horizontally means rightward.
    @discardableResult
    public func revealHorizontally(
        deltaX: Int,
        pages: Int,
        column: Int? = nil
    ) async throws -> RevealEffect {
        guard deltaX != 0 else {
            throw SpaceOError.badRequest("Electron editor reveal needs a non-zero horizontal delta")
        }
        guard (1...100).contains(pages) else {
            throw SpaceOError.badRequest("scroll ticks must be from 1 through 100")
        }
        var payload = request("scroll")
        payload.direction = deltaX < 0 ? "right" : "left"
        payload.pages = pages
        payload.column = column
        let response = try await exchange(payload)
        guard response.ok, let reveal = response.reveal,
              let document = response.document, !document.isEmpty else {
            throw SpaceOError.unsupportedTarget(
                response.error ?? "Electron editor rejected the horizontal reveal")
        }
        return RevealEffect(
            document: document,
            line: reveal.line,
            character: reveal.character,
            longestVisibleLineLength: reveal.longestVisibleLineLength,
            column: response.column)
    }

    /// Set a pane's selection. This is the confirmable stand-in for a drag-select: the renderer
    /// drops synthetic drags, but the editor adopts and reports a selection, so the effect is
    /// observable rather than assumed.
    @discardableResult
    public func select(
        anchorLine: Int,
        anchorCharacter: Int,
        activeLine: Int,
        activeCharacter: Int,
        column: Int? = nil
    ) async throws -> SelectionEffect {
        let positions = [anchorLine, anchorCharacter, activeLine, activeCharacter]
        guard positions.allSatisfy({ $0 >= 0 }) else {
            throw SpaceOError.badRequest("selection positions must be zero or greater")
        }
        var payload = request("select")
        payload.column = column
        payload.anchorLine = anchorLine
        payload.anchorCharacter = anchorCharacter
        payload.activeLine = activeLine
        payload.activeCharacter = activeCharacter
        let response = try await exchange(payload)
        guard response.ok,
              let before = response.before,
              let after = response.after,
              let document = response.document,
              !document.isEmpty else {
            throw SpaceOError.unsupportedTarget(
                response.error ?? "Electron editor did not adopt the requested selection")
        }
        return SelectionEffect(
            document: document,
            before: before,
            after: after,
            selectedText: response.selectedText ?? "",
            changed: response.changed == true)
    }

    private func request(_ command: String) -> ControlRequest {
        ControlRequest(version: 1, token: endpoint.token, command: command)
    }

    private func exchange(_ request: ControlRequest) async throws -> ControlResponse {
        try Task.checkCancellation()
        try validateSocket()
        let payload = try Wire.encoder.encode(request)
        let path = endpoint.socket.path
        let responseData = try await Task.detached(priority: .userInitiated) {
            try Transport.sendLinePayload(
                payload,
                to: path,
                timeout: 2,
                maximumRequestBytes: 16 * 1_024,
                maximumResponseBytes: 16 * 1_024)
        }.value
        try Task.checkCancellation()
        do {
            return try Wire.decoder.decode(ControlResponse.self, from: responseData)
        } catch {
            throw SpaceOError.unsupportedTarget(
                "Electron editor controller returned a malformed response")
        }
    }

    private func validateSocket() throws {
        let path = endpoint.socket.path
        var metadata = stat()
        guard lstat(path, &metadata) == 0,
              metadata.st_uid == geteuid(),
              (metadata.st_mode & S_IFMT) == S_IFSOCK,
              (metadata.st_mode & 0o077) == 0 else {
            throw SpaceOError.unsupportedTarget(
                "Electron editor controller socket is absent or has unsafe ownership/permissions")
        }
    }
}
