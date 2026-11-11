import AppKit
import Foundation
import SpaceOKit

/// SPAO-160. The two "let me help" gestures every VM console has — copy out, drop a file in —
/// plus pasting the person's clipboard into the agent's app while they hold Control. Every one
/// of them is an explicit user action, and every one goes through the daemon's session
/// clipboard broker rather than the agent's apps touching the general pasteboard.
extension ViewerModel {

    struct PendingFileDrop: Identifiable, Equatable {
        let id = UUID()
        let sessionID: String
        let files: [URL]
        let defaultApp: String
    }

    /// The inline "press ⌘V again" prompt. Not a sheet: a sheet becomes the key window, and the
    /// console losing key status ends Control — so the confirmation used to end the very Control
    /// it was confirming a paste for.
    struct PendingPaste: Identifiable, Equatable {
        let id = UUID()
        let sessionID: String
        let sessionTitle: String
        let expires: Date

        var prompt: String {
            "Press ⌘V again to paste into \(sessionTitle). The text is typed into the app you "
                + "are driving and is not kept in the session clipboard."
        }
    }

    /// How long the second ⌘V may take. Long enough to read the prompt; short enough that a
    /// stray ⌘V much later is a new request rather than a confirmation.
    static let pasteConfirmationLifetime: TimeInterval = 6

    static let maximumDroppedFiles = 16
    static let maximumPasteBytes = 64 * 1_024

    // MARK: - Copy from Session (⇧⌘C)

    /// Read the selected session's clipboard buffer through the daemon and put it on the
    /// person's pasteboard. This is the only place the Viewer writes the general pasteboard on
    /// its own initiative, and only because the person just asked for exactly that.
    func copyFromSession() {
        guard let session = selectedSession else {
            note = InputNote(text: "Select a session to copy from.", isWarning: true)
            return
        }
        var request = Request(cmd: "clipboard.get")
        request.session = session.id
        request.operatorScope = true
        let transport = daemonTransport
        let writer = pasteboardWriter
        Task.detached(priority: .userInitiated) { [weak self] in
            do {
                let response = try transport(request)
                guard response.ok else {
                    throw SpaceOError.badRequest(response.error ?? "clipboard.get failed")
                }
                let value = response.value ?? ""
                await MainActor.run { [weak self] in
                    guard !value.isEmpty else {
                        self?.note = InputNote(
                            text: "The session clipboard is empty.", isWarning: false)
                        return
                    }
                    writer(value)
                    self?.note = InputNote(
                        text: "Copied \(value.utf8.count) bytes from \(session.id).",
                        isWarning: false)
                    self?.appendEvent(
                        severity: .info, title: "Copied from session",
                        detail: "\(value.utf8.count) bytes placed on this Mac's clipboard.",
                        sessionID: session.id)
                }
            } catch {
                await MainActor.run { [weak self] in
                    self?.recordControlPlaneActionFailure(
                        "Copy from session failed", error: error, sessionID: session.id)
                }
            }
        }
    }

    // MARK: - Drop to open

    /// A file landed on the console. Ask before doing anything: the drop confirms which app
    /// opens it, defaulting to the session's first app, else TextEdit.
    func requestOpenFiles(_ urls: [URL]) {
        let files = Array(urls.filter(\.isFileURL).prefix(Self.maximumDroppedFiles))
        guard !files.isEmpty else { return }
        guard let session = selectedSession, canvasMode == .session else {
            note = InputNote(
                text: "Select a session before dropping files onto the console.", isWarning: true)
            return
        }
        pendingFileDrop = PendingFileDrop(
            sessionID: session.id,
            files: files,
            defaultApp: session.apps.first?.name ?? "TextEdit")
    }

    func cancelOpenFiles() {
        pendingFileDrop = nil
    }

    /// `run` the app with the files, operator-scoped. The files stay where they are; the daemon
    /// passes their paths to the app.
    func confirmOpenFiles(_ drop: PendingFileDrop, app: String) {
        pendingFileDrop = nil
        let appName = app.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !appName.isEmpty else { return }
        var request = Request(cmd: "run")
        request.session = drop.sessionID
        request.app = appName
        request.files = drop.files.map(\.path)
        request.operatorScope = true
        let transport = daemonTransport
        Task.detached(priority: .userInitiated) { [weak self] in
            do {
                let response = try transport(request)
                guard response.ok else {
                    throw SpaceOError.badRequest(response.error ?? "run failed")
                }
                await MainActor.run { [weak self] in
                    self?.appendEvent(
                        severity: .info, title: "Opened dropped files",
                        detail: "\(appName): " + drop.files.map(\.lastPathComponent).joined(separator: ", "),
                        sessionID: drop.sessionID)
                    self?.refreshControlPlane(afterMutation: true)
                }
            } catch {
                await MainActor.run { [weak self] in
                    self?.recordControlPlaneActionFailure(
                        "Open failed", error: error, sessionID: drop.sessionID)
                }
            }
        }
    }

    // MARK: - ⌘V while Control is active

    /// Called from the input controller's intercept. Returns true when the chord was taken.
    /// The first paste into each session asks once — inline, on the canvas; a second ⌘V is the
    /// answer — and later pastes go straight through.
    @discardableResult
    func requestBrokeredPaste(now: Date = Date()) -> Bool {
        guard interactionEnabled, let session = selectedSession else { return false }
        if pasteConfirmedSessions.contains(session.id) {
            performBrokeredPaste(into: session.id)
        } else if let pending = pendingPasteConfirmation, pending.sessionID == session.id,
                  now <= pending.expires {
            confirmBrokeredPaste()
        } else {
            let pending = PendingPaste(
                sessionID: session.id,
                sessionTitle: ViewerSessionGrouping.displayTitle(session),
                expires: now.addingTimeInterval(Self.pasteConfirmationLifetime))
            pendingPasteConfirmation = pending
            accessibilityAnnouncement(pending.prompt)
            Task { @MainActor [weak self] in
                try? await Task.sleep(nanoseconds: UInt64(Self.pasteConfirmationLifetime * 1e9))
                if self?.pendingPasteConfirmation?.id == pending.id {
                    self?.pendingPasteConfirmation = nil
                }
            }
        }
        return true
    }

    func confirmBrokeredPaste() {
        guard let pending = pendingPasteConfirmation else { return }
        pendingPasteConfirmation = nil
        pasteConfirmedSessions.insert(pending.sessionID)
        performBrokeredPaste(into: pending.sessionID)
    }

    func cancelBrokeredPaste() {
        pendingPasteConfirmation = nil
    }

    /// A prompt the Viewer raised in answer to the person's own chord is on screen.
    var pendingViewerPrompt: Bool {
        pendingPasteConfirmation != nil
    }

    /// Paste the person's text into the app they are driving, and leave nothing behind.
    ///
    /// The session clipboard broker is readable by the agent (`clipboard_get`), and what people
    /// paste while holding Control is disproportionately a password or a one-time code. So the
    /// broker's previous contents are read first and put back afterwards: `clipboard.get`,
    /// `clipboard.set` (the person's text), `key cmd+v`, `clipboard.set` (what was there). The
    /// broker has no "clear", so an empty broker is restored as empty text. The restore runs
    /// even when the key press fails; if the restore itself fails, the person is told the text
    /// may still be in the session clipboard. All four are operator-scoped: the session is
    /// paused for the person's Control, and this is the person's own input.
    private func performBrokeredPaste(into sessionID: String) {
        guard let text = pasteboardReader(), !text.isEmpty else {
            note = InputNote(text: "Your clipboard has no text to paste.", isWarning: true)
            return
        }
        guard text.utf8.count <= Self.maximumPasteBytes else {
            note = InputNote(
                text: "Clipboard text is larger than \(Self.maximumPasteBytes / 1_024) KB; "
                    + "paste a smaller selection.",
                isWarning: true)
            return
        }
        let title = sessions.first { $0.id == sessionID }
            .map(ViewerSessionGrouping.displayTitle) ?? sessionID
        let transport = daemonTransport
        Task.detached(priority: .userInitiated) { [weak self] in
            let outcome = Self.brokeredPaste(text: text, sessionID: sessionID, transport: transport)
            await MainActor.run { [weak self] in
                guard let self else { return }
                switch outcome {
                case .pasted:
                    self.note = InputNote(
                        text: "Pasted \(text.utf8.count) bytes into \(title). The session "
                            + "clipboard was restored; your text was not kept.",
                        isWarning: false)
                case let .failed(error):
                    self.recordControlPlaneActionFailure(
                        "Paste failed", error: error, sessionID: sessionID)
                case let .pastedButNotRestored(error):
                    self.recordControlPlaneActionFailure(
                        "Pasted text may remain in the session clipboard",
                        error: SpaceOError.badRequest(
                            "Pasted into \(title), but the session clipboard could not be "
                                + "restored (\(error.localizedDescription)); the agent may be "
                                + "able to read what you pasted."),
                        sessionID: sessionID)
                case let .failedAndNotRestored(pasteError, restoreError):
                    self.recordControlPlaneActionFailure(
                        "Paste failed",
                        error: SpaceOError.badRequest(
                            "\(pasteError.localizedDescription). The session clipboard could "
                                + "not be restored either (\(restoreError.localizedDescription)); "
                                + "the agent may be able to read the text."),
                        sessionID: sessionID)
                }
            }
        }
    }

    enum BrokeredPasteOutcome {
        case pasted
        case failed(Error)
        case pastedButNotRestored(Error)
        case failedAndNotRestored(paste: Error, restore: Error)
    }

    /// The four-request sequence, off the main actor. See `performBrokeredPaste`.
    nonisolated static func brokeredPaste(
        text: String,
        sessionID: String,
        transport: DaemonTransport
    ) -> BrokeredPasteOutcome {
        func send(_ request: Request) throws -> Response {
            let response = try transport(request)
            guard response.ok else {
                throw SpaceOError.badRequest(response.error ?? "\(request.cmd) failed")
            }
            return response
        }
        func clipboardSet(_ value: String) -> Request {
            var request = Request(cmd: "clipboard.set")
            request.session = sessionID
            request.text = value
            request.operatorScope = true
            return request
        }
        var get = Request(cmd: "clipboard.get")
        get.session = sessionID
        get.operatorScope = true
        var press = Request(cmd: "key")
        press.session = sessionID
        press.key = "cmd+v"
        press.operatorScope = true

        // Without the previous contents there is nothing safe to restore to, so nothing is
        // staged: better no paste than a secret left behind or the agent's clipboard erased.
        let previous: String
        do {
            previous = try send(get).value ?? ""
        } catch {
            return .failed(error)
        }
        do {
            _ = try send(clipboardSet(text))
        } catch {
            // The set did not land; the broker still holds `previous`.
            return .failed(error)
        }
        var pasteError: Error?
        do {
            _ = try send(press)
        } catch {
            pasteError = error
        }
        do {
            _ = try send(clipboardSet(previous))
        } catch {
            if let pasteError { return .failedAndNotRestored(paste: pasteError, restore: error) }
            return .pastedButNotRestored(error)
        }
        if let pasteError { return .failed(pasteError) }
        return .pasted
    }
}

/// The one chord the captured surface keeps for itself besides the local exit.
enum ViewerPastePolicy {
    static let pasteKeyCode: UInt16 = 9   // kVK_ANSI_V

    static func isBrokeredPaste(keyCode: UInt16, modifiers: NSEvent.ModifierFlags) -> Bool {
        let meaningful = modifiers.intersection([.command, .control, .option, .shift])
        return keyCode == pasteKeyCode && meaningful == [.command]
    }
}
