// The Agent Context panel: a floating, resizable window over every app that shows this session's
// conversation, grouped by request, with what went to the model under each, live. Agent menu →
// Show Agent Context opens it; Esc or the close button closes it.
//
// It reads sessions/<id>/panel.json, which the voice agent rewrites a moment after anything happens
// (python/context_panel.py), and reloads it when it changes. What it shows is the app's own record
// of what it sent and got back: not the model's exact current context, which Codex holds and
// compacts. The panel says so at the top, with the last context size Codex reported.

import AppKit

final class ContextNode: NSObject {
    let key: String
    let title: String
    let subtitle: String
    let detail: String
    let icon: String
    let record: String?
    let isGroup: Bool
    var children: [ContextNode] = []

    init(key: String, title: String, subtitle: String = "", detail: String = "", icon: String = "",
         record: String? = nil, isGroup: Bool = false) {
        self.key = key
        self.title = title
        self.subtitle = subtitle
        self.detail = detail
        self.icon = icon
        self.record = record
        self.isGroup = isGroup
    }

    var searchable: String { [title, subtitle, detail].joined(separator: " ").lowercased() }
}

final class ContextPanel: NSPanel, NSOutlineViewDataSource, NSOutlineViewDelegate, NSSearchFieldDelegate, NSWindowDelegate {
    var feedURL: URL?
    private var modified: Date?
    private var roots: [ContextNode] = []
    fileprivate var shown: [ContextNode] = []
    private var timer: Timer?
    private let outline = NSOutlineView()
    private let scroll = NSScrollView()
    private let heading = NSTextField(labelWithString: "Agent Context")
    private let sessionLine = NSTextField(labelWithString: "")
    private let notice = NSTextField(wrappingLabelWithString: "")
    private let modelLine = NSTextField(wrappingLabelWithString: "")
    private let meter = NSProgressIndicator()
    private let search = NSSearchField()
    private let live = NSButton(checkboxWithTitle: "Live", target: nil, action: nil)
    private let openRecord = NSButton(title: "Open Exact Record", target: nil, action: nil)
    private var journalPath: String?
    private var contextIndex: String?
    private let time = DateFormatter()

    init() {
        super.init(contentRect: NSRect(x: 0, y: 0, width: 560, height: 680),
                   styleMask: [.titled, .closable, .resizable, .utilityWindow, .nonactivatingPanel],
                   backing: .buffered, defer: false)
        title = "Agent Context"
        isFloatingPanel = true
        level = .floating
        hidesOnDeactivate = false
        isReleasedWhenClosed = false
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        minSize = NSSize(width: 380, height: 320)
        setFrameAutosaveName("AgentContextPanel")
        if !setFrameUsingName("AgentContextPanel") { center() }
        time.dateFormat = "HH:mm:ss"
        build()
        delegate = self
        setAccessibilityLabel("Agent Context: this session's conversation and what was sent to the model")
    }

    // MARK: layout

    private func build() {
        let content = NSView()
        contentView = content

        heading.font = .systemFont(ofSize: 17, weight: .semibold)
        heading.setAccessibilityRole(.staticText)
        sessionLine.font = .systemFont(ofSize: 11)
        sessionLine.textColor = .secondaryLabelColor

        let banner = NSView()
        banner.wantsLayer = true
        banner.layer?.cornerRadius = 8
        banner.layer?.backgroundColor = NSColor.systemYellow.withAlphaComponent(0.16).cgColor
        banner.setAccessibilityElement(true)
        banner.setAccessibilityRole(.group)
        banner.setAccessibilityLabel("About what this shows")
        let bannerTitle = NSTextField(labelWithString: "Recorded history, not the model's exact context")
        bannerTitle.font = .systemFont(ofSize: 12, weight: .semibold)
        notice.font = .systemFont(ofSize: 11)
        notice.textColor = .secondaryLabelColor
        modelLine.font = .systemFont(ofSize: 11)
        modelLine.isSelectable = true
        meter.style = .bar
        meter.isIndeterminate = false
        meter.minValue = 0
        meter.maxValue = 1
        meter.setAccessibilityLabel("Model context used, as last reported by Codex")
        let bannerStack = NSStackView(views: [bannerTitle, notice, meter, modelLine])
        bannerStack.orientation = .vertical
        bannerStack.alignment = .leading
        bannerStack.spacing = 4
        bannerStack.edgeInsets = NSEdgeInsets(top: 8, left: 10, bottom: 8, right: 10)
        bannerStack.translatesAutoresizingMaskIntoConstraints = false
        banner.addSubview(bannerStack)
        NSLayoutConstraint.activate([
            bannerStack.leadingAnchor.constraint(equalTo: banner.leadingAnchor),
            bannerStack.trailingAnchor.constraint(equalTo: banner.trailingAnchor),
            bannerStack.topAnchor.constraint(equalTo: banner.topAnchor),
            bannerStack.bottomAnchor.constraint(equalTo: banner.bottomAnchor),
        ])

        search.placeholderString = "Filter"
        search.delegate = self
        search.setAccessibilityLabel("Filter the context")
        live.state = .on
        live.target = self
        live.action = #selector(toggleLive)
        live.toolTip = "Update as the agent works"
        let refresh = NSButton(image: NSImage(systemSymbolName: "arrow.clockwise", accessibilityDescription: "Refresh")!,
                               target: self, action: #selector(refreshNow))
        refresh.bezelStyle = .texturedRounded
        refresh.toolTip = "Refresh now"
        let expand = NSButton(title: "Expand All", target: self, action: #selector(expandAll))
        let collapse = NSButton(title: "Collapse", target: self, action: #selector(collapseAll))
        openRecord.target = self
        openRecord.action = #selector(openSelectedRecord)
        openRecord.isEnabled = false
        openRecord.toolTip = "The exact payload, with screenshots, in your browser"
        let more = NSPopUpButton(frame: .zero, pullsDown: true)
        more.addItem(withTitle: "More")
        more.addItem(withTitle: "Show Journal in Finder")
        more.addItem(withTitle: "Every Payload (Browser)")
        more.addItem(withTitle: "Copy Selected")
        more.target = self
        more.action = #selector(moreAction(_:))
        for button in [expand, collapse, openRecord] { button.bezelStyle = .rounded; button.controlSize = .small }
        more.controlSize = .small
        let tools = NSStackView(views: [search, live, refresh])
        tools.spacing = 8
        let actions = NSStackView(views: [expand, collapse, NSView(), openRecord, more])
        actions.spacing = 6

        let column = NSTableColumn(identifier: .init("main"))
        column.resizingMask = .autoresizingMask
        outline.addTableColumn(column)
        outline.outlineTableColumn = column
        outline.headerView = nil
        outline.usesAutomaticRowHeights = true
        outline.rowSizeStyle = .custom
        outline.style = .inset
        outline.columnAutoresizingStyle = .uniformColumnAutoresizingStyle
        outline.dataSource = self
        outline.delegate = self
        outline.target = self
        outline.doubleAction = #selector(toggleRow)
        outline.setAccessibilityLabel("Conversation, grouped by request")
        scroll.documentView = outline
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.drawsBackground = false

        let stack = NSStackView(views: [heading, sessionLine, banner, tools, scroll, actions])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 8
        stack.edgeInsets = NSEdgeInsets(top: 12, left: 14, bottom: 12, right: 14)
        stack.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            stack.topAnchor.constraint(equalTo: content.topAnchor),
            stack.bottomAnchor.constraint(equalTo: content.bottomAnchor),
        ])
        for view in [banner, tools, scroll, actions] {
            view.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -28).isActive = true
        }
        meter.widthAnchor.constraint(equalTo: bannerStack.widthAnchor, constant: -20).isActive = true
        for view in [heading, sessionLine, banner, tools, actions] {
            view.setContentCompressionResistancePriority(.required, for: .vertical)
            stack.setVisibilityPriority(.mustHold, for: view)
        }
        sessionLine.lineBreakMode = .byTruncatingMiddle
        sessionLine.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        fitText()
        scroll.setContentHuggingPriority(.defaultLow, for: .vertical)
        scroll.setContentCompressionResistancePriority(.defaultLow, for: .vertical)
        scroll.heightAnchor.constraint(greaterThanOrEqualToConstant: 160).isActive = true
    }

    /// Wrapped labels need a width to know their height: the window's, less the margins.
    private func fitText() {
        let width = max(200, frame.width - 48)
        notice.preferredMaxLayoutWidth = width
        modelLine.preferredMaxLayoutWidth = width
    }

    func windowDidResize(_ notification: Notification) { fitText() }

    // MARK: showing and closing

    /// Draws it offscreen with everything expanded (Agent --panel-snapshot FEED PNG), for tests.
    static func snapshot(feed: URL, to png: URL) -> Bool {
        let panel = ContextPanel()
        panel.setFrame(NSRect(x: 0, y: 0, width: 560, height: 760), display: false)
        panel.fitText()
        panel.feedURL = feed
        panel.load(force: true)  // as it opens: the latest request expanded, scrolled to the end
        guard let view = panel.contentView else { return false }
        view.wantsLayer = true  // offscreen there's no window background behind the views
        view.appearance?.performAsCurrentDrawingAppearance {}
        view.layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor
        view.layoutSubtreeIfNeeded()
        panel.outline.scrollToEndOfDocument(nil)
        guard let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return false }
        view.cacheDisplay(in: view.bounds, to: rep)
        guard let data = rep.representation(using: .png, properties: [:]) else { return false }
        return (try? data.write(to: png)) != nil
    }

    func show(feed: URL?) {
        if let feed { feedURL = feed }
        load(force: true)
        makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)  // so the keyboard and VoiceOver can reach it
        startTimer()
    }

    override var canBecomeKey: Bool { true }

    override func cancelOperation(_ sender: Any?) { close() }  // Esc

    override func close() {
        timer?.invalidate()
        timer = nil
        super.close()
    }

    override func keyDown(with event: NSEvent) {
        let keys = event.charactersIgnoringModifiers ?? ""
        if event.modifierFlags.contains(.command) && keys == "w" { close(); return }
        if event.modifierFlags.contains(.command) && keys == "f" { makeFirstResponder(search); return }
        if event.modifierFlags.contains(.command) && keys == "r" { refreshNow(); return }
        super.keyDown(with: event)
    }

    private func startTimer() {
        timer?.invalidate()
        guard live.state == .on else { return }
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.load(force: false) }
    }

    @objc private func toggleLive() { startTimer(); if live.state == .on { load(force: true) } }
    @objc private func refreshNow() { load(force: true) }

    // MARK: loading panel.json

    func load(force: Bool) {
        guard let url = feedURL else {
            show(error: "Waiting for the voice agent to start a session…")
            return
        }
        let date = (try? FileManager.default.attributesOfItem(atPath: url.path))?[.modificationDate] as? Date
        if !force, date == modified { return }
        guard let data = try? Data(contentsOf: url),
              let feed = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            show(error: "Nothing recorded in this session yet. It appears as soon as you say something.")
            return
        }
        modified = date
        apply(feed)
    }

    private func show(error: String) {
        sessionLine.stringValue = error
        notice.stringValue = ""
        modelLine.stringValue = ""
    }

    private func stamp(_ value: Any?) -> String {
        guard let t = value as? Double else { return "" }
        return time.string(from: Date(timeIntervalSince1970: t))
    }

    private func apply(_ feed: [String: Any]) {
        let session = feed["session"] as? String ?? "?"
        let ended = feed["ended"] is Double ? " · ended" : ""
        sessionLine.stringValue = "Session \(session)\(ended) · \(feed["backend"] as? String ?? "") · updated \(stamp(feed["updated"]))"
        notice.stringValue = feed["notice"] as? String ?? ""
        journalPath = feed["journal"] as? String
        contextIndex = feed["context_index"] as? String
        let model = feed["model_context"] as? [String: Any] ?? [:]
        modelLine.stringValue = model["note"] as? String ?? ""
        if let tokens = model["tokens"] as? Double, let window = model["window"] as? Double, window > 0 {
            meter.isHidden = false
            meter.doubleValue = min(1, tokens / window)
            meter.setAccessibilityValueDescription("\(Int(tokens)) of \(Int(window)) tokens")
        } else {
            meter.isHidden = true
        }

        var nodes: [ContextNode] = []
        for (g, group) in (feed["groups"] as? [[String: Any]] ?? []).enumerated() {
            let items = group["items"] as? [[String: Any]] ?? []
            let kind = group["kind"] as? String ?? ""
            if kind == "session" && items.isEmpty { continue }
            let status = group["status"] as? String
            let mark = ["done": "✅", "failed": "❌", "running": "⏳", "verified": "✅", "sent": "⚠️"][status ?? ""] ?? ""
            let device = (group["device"] as? String) == "phone" ? "📱 " : ""
            let key = "g\(group["time"] as? Double ?? Double(g))"
            let inputs = group["inputs"] as? Int ?? 0
            let node = ContextNode(key: key, title: "\(device)\(group["title"] as? String ?? "")",
                                   subtitle: "\(stamp(group["time"]))  \(mark) \(status ?? "")" +
                                       (inputs > 0 ? "  ·  \(inputs) sent to the model" : ""),
                                   icon: kind == "ingest" ? "📥" : kind == "session" ? "◦" : "▶", isGroup: true)
            var sent: [ContextNode] = []
            for (i, item) in items.enumerated() {
                let child = ContextNode(key: "\(key)/\(item["time"] as? Double ?? 0)/\(i)",
                                        title: item["label"] as? String ?? "",
                                        subtitle: item["summary"] as? String ?? "",
                                        detail: item["detail"] as? String ?? "",
                                        icon: item["icon"] as? String ?? ((item["lane"] as? String) == "input" ? "↗" : "·"),
                                        record: item["record"] as? String)
                if !child.detail.isEmpty {
                    child.children = [ContextNode(key: child.key + "/d", title: "", detail: child.detail, record: child.record)]
                }
                if (item["lane"] as? String) == "input" { sent.append(child) } else { node.children.append(child) }
            }
            if !sent.isEmpty {
                let folder = ContextNode(key: key + "/sent", title: "What went to the model (\(sent.count))",
                                         subtitle: "Prompt text, screenshots, tool calls and results, as recorded",
                                         icon: "🧾")
                folder.children = sent
                node.children.append(folder)
            }
            nodes.append(node)
        }
        replace(with: nodes)
    }

    private func replace(with nodes: [ContextNode]) {
        let expanded = Set(allNodes(shown).filter { outline.isItemExpanded($0) }.map(\.key))
        let firstLoad = shown.isEmpty
        let atBottom = scroll.contentView.bounds.maxY >= outline.bounds.height - 40
        let selectedKey = (outline.item(atRow: outline.selectedRow) as? ContextNode)?.key
        roots = nodes
        filter()
        for node in allNodes(shown) where expanded.contains(node.key) { outline.expandItem(node) }
        if firstLoad, let last = shown.last { outline.expandItem(last) }  // the latest request, open
        if firstLoad || atBottom { outline.scrollToEndOfDocument(nil) }
        if let selectedKey, let node = allNodes(shown).first(where: { $0.key == selectedKey }) {
            let row = outline.row(forItem: node)
            if row >= 0 { outline.selectRowIndexes([row], byExtendingSelection: false) }
        }
    }

    private func allNodes(_ nodes: [ContextNode]) -> [ContextNode] {
        nodes.flatMap { [$0] + allNodes($0.children) }
    }

    private func filter() {
        let query = search.stringValue.lowercased().trimmingCharacters(in: .whitespaces)
        if query.isEmpty {
            shown = roots
        } else {
            shown = roots.compactMap { group in
                if group.searchable.contains(query) { return group }
                let copy = ContextNode(key: group.key, title: group.title, subtitle: group.subtitle,
                                       icon: group.icon, isGroup: true)
                copy.children = group.children.filter { child in
                    child.searchable.contains(query) || child.children.contains { $0.searchable.contains(query) }
                }
                return copy.children.isEmpty ? nil : copy
            }
        }
        outline.reloadData()
        if !query.isEmpty { outline.expandItem(nil, expandChildren: false); shown.forEach { outline.expandItem($0) } }
    }

    func controlTextDidChange(_ obj: Notification) { filter() }

    // MARK: actions

    @objc private func toggleRow() {
        guard let node = outline.item(atRow: outline.clickedRow) as? ContextNode, !node.children.isEmpty else { return }
        outline.isItemExpanded(node) ? outline.collapseItem(node) : outline.expandItem(node)
    }

    @objc func expandAll() { outline.expandItem(nil, expandChildren: true) }
    @objc private func collapseAll() { outline.collapseItem(nil, collapseChildren: true) }

    private var selected: ContextNode? { outline.item(atRow: outline.selectedRow) as? ContextNode }

    @objc private func openSelectedRecord() {
        if let record = selected?.record { NSWorkspace.shared.open(URL(fileURLWithPath: record)) }
    }

    @objc private func moreAction(_ sender: NSPopUpButton) {
        switch sender.indexOfSelectedItem {
        case 1: if let journalPath { NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: journalPath)]) }
        case 2: if let contextIndex { NSWorkspace.shared.open(URL(fileURLWithPath: contextIndex)) }
        case 3:
            if let node = selected {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(node.detail.isEmpty ? "\(node.title): \(node.subtitle)" : node.detail,
                                               forType: .string)
            }
        default: break
        }
    }

    func outlineViewSelectionDidChange(_ notification: Notification) {
        openRecord.isEnabled = selected?.record != nil
    }

    // MARK: the outline

    func outlineView(_ outlineView: NSOutlineView, numberOfChildrenOfItem item: Any?) -> Int {
        (item as? ContextNode)?.children.count ?? shown.count
    }

    func outlineView(_ outlineView: NSOutlineView, child index: Int, ofItem item: Any?) -> Any {
        (item as? ContextNode)?.children[index] ?? shown[index]
    }

    func outlineView(_ outlineView: NSOutlineView, isItemExpandable item: Any) -> Bool {
        !((item as? ContextNode)?.children.isEmpty ?? true)
    }

    func outlineView(_ outlineView: NSOutlineView, viewFor tableColumn: NSTableColumn?, item: Any) -> NSView? {
        guard let node = item as? ContextNode else { return nil }
        let cell = NSTableCellView()
        if node.title.isEmpty {  // a detail: the full text, selectable, monospaced
            let text = NSTextField(wrappingLabelWithString: node.detail)
            text.font = .monospacedSystemFont(ofSize: 11, weight: .regular)
            text.isSelectable = true
            text.textColor = .labelColor
            text.drawsBackground = true
            text.backgroundColor = NSColor.textBackgroundColor.withAlphaComponent(0.6)
            text.setAccessibilityLabel("Details")
            pin(text, in: cell)
            return cell
        }
        let title = NSTextField(labelWithString: "\(node.icon)  \(node.title)")
        title.font = node.isGroup ? .systemFont(ofSize: 13, weight: .semibold) : .systemFont(ofSize: 12, weight: .medium)
        title.lineBreakMode = .byTruncatingTail
        title.maximumNumberOfLines = node.isGroup ? 2 : 1
        title.cell?.wraps = node.isGroup
        let subtitle = NSTextField(wrappingLabelWithString: node.subtitle)
        subtitle.font = .systemFont(ofSize: node.isGroup ? 11 : 12)
        subtitle.textColor = node.isGroup ? .secondaryLabelColor : .labelColor
        subtitle.maximumNumberOfLines = node.isGroup ? 1 : 4
        subtitle.isHidden = node.subtitle.isEmpty
        let stack = NSStackView(views: [title, subtitle])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 2
        pin(stack, in: cell)
        for field in [title, subtitle] {
            field.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
            field.widthAnchor.constraint(lessThanOrEqualTo: stack.widthAnchor).isActive = true
        }
        cell.setAccessibilityLabel("\(node.title). \(node.subtitle)")
        return cell
    }

    private func pin(_ view: NSView, in cell: NSView) {
        view.translatesAutoresizingMaskIntoConstraints = false
        cell.addSubview(view)
        NSLayoutConstraint.activate([
            view.leadingAnchor.constraint(equalTo: cell.leadingAnchor, constant: 2),
            view.trailingAnchor.constraint(equalTo: cell.trailingAnchor, constant: -4),
            view.topAnchor.constraint(equalTo: cell.topAnchor, constant: 4),
            view.bottomAnchor.constraint(equalTo: cell.bottomAnchor, constant: -4),
        ])
    }
}

// MARK: adding text to the conversation

/// Asks before anything is added, saying how big it is and where it goes; nil if you cancel.
/// Returns the title you gave it.
func confirmIngest(text: String, source: String) -> String? {
    let chars = text.count
    let tokens = (chars + 3) / 4
    let parts = max(1, Int((Double(chars) / 12_000).rounded(.up)))
    let alert = NSAlert()
    alert.messageText = "Add \(source) to the agent's conversation?"
    let mode = tokens <= 60_000
        ? "It goes into the conversation in \(parts) part\(parts == 1 ? "" : "s"), one turn each."
        : "That's more than 60,000 tokens, so it's saved and the agent reads the parts it needs when it needs them."
    alert.informativeText = "\(chars.formatted()) characters, about \(tokens.formatted()) tokens (an estimate). \(mode)\n\n" +
        "It's sent to the model (OpenAI, through Codex) as material for later requests, not instructions, and " +
        "saved privately on this Mac. The Agent Context panel shows whether it was verified in the conversation. " +
        "Codex may later summarize it when the conversation gets long."
    let title = NSTextField(string: String(text.split(whereSeparator: \.isNewline).first ?? "").prefix(80).description)
    title.placeholderString = "Title"
    title.setAccessibilityLabel("Title for this text")
    let preview = NSTextField(wrappingLabelWithString: String(text.prefix(400)) + (chars > 400 ? "…" : ""))
    preview.font = .systemFont(ofSize: 11)
    preview.textColor = .secondaryLabelColor
    preview.maximumNumberOfLines = 6
    let stack = NSStackView(views: [title, preview])
    stack.orientation = .vertical
    stack.alignment = .leading
    stack.frame = NSRect(x: 0, y: 0, width: 380, height: 130)
    title.widthAnchor.constraint(equalToConstant: 380).isActive = true
    preview.preferredMaxLayoutWidth = 380
    alert.accessoryView = stack
    alert.addButton(withTitle: "Add")
    alert.addButton(withTitle: "Cancel")
    NSApp.activate(ignoringOtherApps: true)
    guard alert.runModal() == .alertFirstButtonReturn else { return nil }
    let given = title.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
    return given.isEmpty ? "Added text" : given
}

/// Writes it where only you can read it, for the voice agent to pick up: the first line is the title.
func writeIngestFile(text: String, title: String, stateDir: URL) -> URL? {
    let inbox = stateDir.appendingPathComponent("ingest-inbox")
    let manager = FileManager.default
    try? manager.createDirectory(at: inbox, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    let file = inbox.appendingPathComponent(UUID().uuidString + ".txt")
    let body = title.replacingOccurrences(of: "\n", with: " ") + "\n" + text
    guard manager.createFile(atPath: file.path, contents: Data(body.utf8), attributes: [.posixPermissions: 0o600])
    else { return nil }
    return file
}
