import XCTest
import ApplicationServices
import CoreGraphics
@testable import SpaceOKit

/// A dictionary-backed accessibility tree. Unset attributes read as absent (nil), unlike the
/// traversal suite's fake, whose every boolean answers true.
private final class TreeProvider: AXTraversalProviding {
    var strings: [Int: [String: String]] = [:]
    var bools: [Int: [String: Bool]] = [:]
    var actionLists: [Int: [String]] = [:]
    var children: [Int: [Int]] = [:]
    var elementAttributes: [Int: [String: Int]] = [:]
    var windowIDs: [Int: CGWindowID] = [:]

    func setMessagingTimeout(_ element: Int, seconds: Float) -> Bool { true }
    func string(_ element: Int, attribute: String) -> String? { strings[element]?[attribute] }
    func bool(_ element: Int, attribute: String) -> Bool? { bools[element]?[attribute] }
    func actions(_ element: Int) -> [String] { actionLists[element] ?? [] }
    func point(_ element: Int, attribute: String) -> CGPoint? { nil }
    func size(_ element: Int, attribute: String) -> CGSize? { nil }
    func arrayCount(_ element: Int, attribute: String) -> Int { children[element]?.count ?? 0 }
    func elements(_ element: Int, attribute: String, start: Int, maxValues: Int) -> [Int] {
        let list = children[element] ?? []
        guard start < list.count else { return [] }
        return Array(list[start..<min(list.count, start + maxValues)])
    }
    func windowID(_ element: Int) -> CGWindowID { windowIDs[element] ?? 0 }
    func element(_ element: Int, attribute: String) -> Int? { elementAttributes[element]?[attribute] }

    func node(_ id: Int, role: String, title: String? = nil, value: String? = nil,
              bools: [String: Bool] = [:], actions: [String] = []) {
        var values = [kAXRoleAttribute as String: role]
        if let title { values[kAXTitleAttribute as String] = title }
        if let value { values[kAXValueAttribute as String] = value }
        strings[id] = values
        self.bools[id] = bools
        actionLists[id] = actions
    }
}

final class InteractionStateTests: XCTestCase {

    private func walk(_ provider: TreeProvider, root: Int = 0) throws -> [AXNode] {
        let budget = try AXTraversalBudget(limits: AXTraversalLimits(), now: { 0 }, isCancelled: { false })
        return try AXTraversal.walk(root: root, provider: provider, budget: budget).nodes
    }

    private func snapshot(_ nodes: [AXNode]) throws -> AXSnapshot {
        AXSnapshot(pid: getpid(), windowID: 1,
                   processIdentity: try XCTUnwrap(ProcessIdentity.current(of: getpid())),
                   generation: UUID(), nodes: nodes, elements: [:])
    }

    // MARK: - Control state (native)

    func testToggleValuesRenderAsStateTokensNotRawNumbers() throws {
        let provider = TreeProvider()
        provider.node(0, role: "AXGroup")
        provider.children[0] = [1, 2, 3, 4, 5]
        provider.node(1, role: "AXCheckBox", title: "Remember me", value: "1")
        provider.node(2, role: "AXCheckBox", title: "Newsletter", value: "0")
        provider.node(3, role: "AXCheckBox", title: "All", value: "2")
        provider.node(4, role: "AXRadioButton", title: "Large", value: "1",
                      bools: [kAXFocusedAttribute as String: true])
        provider.node(5, role: "AXDisclosureTriangle", title: "Details", value: "0")
        let nodes = try walk(provider)
        let lines = nodes.filter(\.isActionable).map { $0.renderedLine() }
        XCTAssertEqual(lines, [
            "[0] CheckBox — Remember me [checked]",
            "[1] CheckBox — Newsletter [unchecked]",
            "[2] CheckBox — All [mixed]",
            "[3] RadioButton — Large [checked] [focused]",
            "[4] DisclosureTriangle — Details [collapsed]",
        ])
        XCTAssertFalse(lines.joined().contains("value:"), "a toggle's 0/1 value is not a name")
    }

    func testRowsAndPopupsReportExpansionSelectionAndFocus() throws {
        let provider = TreeProvider()
        provider.node(0, role: "AXOutline")
        provider.children[0] = [1, 2, 3, 4]
        provider.node(1, role: "AXRow", title: "Inbox",
                      bools: [kAXSelectedAttribute as String: true, "AXDisclosing": true])
        provider.node(2, role: "AXRow", title: "Archive", bools: ["AXDisclosing": false])
        provider.node(3, role: "AXPopUpButton", title: "Sort", bools: ["AXExpanded": false])
        provider.node(4, role: "AXTextField", title: "Search", value: "draft",
                      bools: [kAXFocusedAttribute as String: true])
        let nodes = try walk(provider).filter(\.isActionable)
        XCTAssertEqual(nodes.map(\.states), [
            ["expanded", "selected"], ["collapsed"], ["collapsed"], ["focused"],
        ])
        XCTAssertEqual(nodes[3].renderedLine(), "[3] TextField — Search · value: draft [focused]")
        XCTAssertEqual(nodes[3].name, "Search", "the name is kept apart from the composed value")
    }

    func testStateOnlyChangeIsReportedAsChangedInADiff() throws {
        let unchecked = AXNode(index: 1, role: "AXCheckBox", label: "Wrap", frame: nil, actions: [],
                               depth: 1, enabled: true, name: "Wrap", states: ["unchecked"])
        let checked = AXNode(index: 1, role: "AXCheckBox", label: "Wrap", frame: nil, actions: [],
                             depth: 1, enabled: true, name: "Wrap", states: ["checked"])
        let diff = AXSnapshotDiff.diff(base: [unchecked], current: [checked], baseSnapshotID: "base")
        XCTAssertEqual(diff.changed, ["  [1] CheckBox — Wrap [checked]"])
        XCTAssertEqual(diff.unchangedCount, 0)
    }

    // MARK: - Label matching

    private func field(_ name: String, value: String, index: Int, role: String = "AXTextField") -> AXNode {
        AXNode(index: index, role: role, label: value.isEmpty ? name : "\(name) · value: \(value)",
               frame: nil, actions: [], depth: 1, enabled: true, name: name)
    }

    func testExactMatchUsesTheAccessibleNameNotTheComposedValue() throws {
        let nodes = [field("Name", value: "Bob", index: 0), field("Email", value: "", index: 1)]
        let snapshot = try snapshot(nodes)
        XCTAssertEqual(try snapshot.uniqueIndex(label: "Name"), 0)
        XCTAssertEqual(try snapshot.uniqueIndex(label: "Name · value: Bob"), 0,
                       "a label copied verbatim from a read still matches")
        guard case .met(let probe) = snapshot.waitProbe(.elementLabel("Name")) else {
            return XCTFail("element_label Name must match the field it names")
        }
        XCTAssertEqual(probe.matchedIndex, 0)
        XCTAssertEqual(snapshot.waitProbe(.elementGone("Name")), .notYet(WaitProbe(snapshotID: probe.snapshotID)))
    }

    func testNamelessStaticTextMatchesOnItsValue() throws {
        let text = AXNode(index: nil, role: "AXStaticText", label: "Saved", frame: nil, actions: [],
                          depth: 1, enabled: true, name: "")
        guard case .met = try snapshot([text]).waitProbe(.elementLabel("Saved")) else {
            return XCTFail("a static text whose only content is its value must still match")
        }
    }

    func testContainsModeAndRoleFilter() throws {
        let nodes = [
            field("Search mail", value: "", index: 0, role: "AXSearchField"),
            AXNode(index: 1, role: "AXButton", label: "Search", frame: nil, actions: [], depth: 1,
                   enabled: true, name: "Search"),
        ]
        let snapshot = try snapshot(nodes)
        let contains = try AXLabelMatcher.parse(text: "search", match: "contains", role: nil)
        XCTAssertThrowsError(try snapshot.uniqueIndex(matching: contains)) {
            XCTAssertTrue("\($0)".contains("ambiguous") && "\($0)".contains("Search mail"), "\($0)")
        }
        let button = try AXLabelMatcher.parse(text: "search", match: "contains", role: "Button")
        XCTAssertEqual(try snapshot.uniqueIndex(matching: button), 1)
        XCTAssertThrowsError(try snapshot.uniqueIndex(matching: AXLabelMatcher(text: "search")),
                             "exact matching stays case-sensitive")
        XCTAssertThrowsError(try AXLabelMatcher.parse(text: "x", match: "fuzzy", role: nil))
        XCTAssertThrowsError(try AXLabelMatcher.parse(text: "x", match: nil, role: "Button\n"))
    }

    // MARK: - Focused window and default target

    func testFocusedWindowObservationDetectsDialogsModalFlagsAndAttachedSheets() throws {
        func observe(_ configure: (TreeProvider) -> Void) throws -> FocusedWindowObservation? {
            let provider = TreeProvider()
            provider.elementAttributes[0] = [kAXFocusedWindowAttribute as String: 1]
            provider.windowIDs[1] = 222
            provider.node(1, role: "AXWindow")
            configure(provider)
            let budget = try AXTraversalBudget(limits: AXTraversalLimits(maxAXCalls: 64),
                                               now: { 0 }, isCancelled: { false })
            return try AXTraversal.focusedWindow(app: 0, provider: provider, budget: budget)
        }
        XCTAssertEqual(try observe { _ in }, FocusedWindowObservation(windowID: 222, modal: false))
        XCTAssertEqual(try observe { $0.strings[1]?[kAXSubroleAttribute as String] = "AXDialog" }?.modal, true)
        XCTAssertEqual(try observe { $0.bools[1] = ["AXModal": true] }?.modal, true)
        XCTAssertEqual(try observe {
            $0.children[1] = [2]
            $0.node(2, role: "AXSheet")
        }?.modal, true)
        XCTAssertNil(try observe { $0.windowIDs[1] = 0 }, "a focus answer without an identity is unknown")
        XCTAssertNil(try observe { $0.elementAttributes[0] = [:] })
    }

    private func window(_ id: CGWindowID, pid: pid_t = 42, width: CGFloat) -> SpaceOKit.WindowRef {
        SpaceOKit.WindowRef(windowID: id, pid: pid, title: "w\(id)",
                  frame: CGRect(x: 10, y: 10, width: width, height: 100))
    }

    func testDefaultTargetPrefersTheOwningAppsFocusedWindow() {
        let document = window(111, width: 800)
        let alert = window(222, width: 300)
        let foreign = window(333, pid: 99, width: 200)
        let region = CGRect(x: 0, y: 0, width: 1_280, height: 800)
        let windows = [document, alert, foreign]
        XCTAssertEqual(AgentSession.defaultTarget(windows: windows, region: region) { _ in nil }?.windowID, 111)
        XCTAssertEqual(AgentSession.defaultTarget(windows: windows, region: region) { _ in 222 }?.windowID, 222)
        XCTAssertEqual(AgentSession.defaultTarget(windows: windows, region: region) { _ in 333 }?.windowID, 111,
                       "another process's window is not this app's focus")
        XCTAssertEqual(AgentSession.defaultTarget(windows: windows, region: region) { _ in 999 }?.windowID, 111,
                       "a focused window outside the session is not evidence about ours")
        XCTAssertNil(AgentSession.defaultTarget(windows: [], region: region) { _ in 1 })
    }

    func testSessionResolvesTheModalAndMarksWindowListings() throws {
        let backing = StubBacking()
        let stage = Stage(testingBacking: backing, onlineDisplayIDs: { [backing.displayID] })
        let pool = DisplayPool(sessionsPerDisplay: 1, displaySize: backing.bounds.size,
                               stageFactory: { _, _, _, _ in stage },
                               stageRetirer: { $0.invalidate(waitingForRemoval: 0) })
        defer { _ = pool.releaseAll() }
        let identity = try XCTUnwrap(ProcessIdentity.current(of: getpid()))
        let app = LaunchedApp(pid: identity.pid, identity: identity, bundleIdentifier: "dev.spaceo.focus-test",
                              name: "Focus", url: URL(fileURLWithPath: "/Applications/Focus.app"),
                              startedByUs: true, devToolsPort: nil, temporaryProfile: nil)
        let slot = try pool.allocate()
        let document = SpaceOKit.WindowRef(windowID: 111, pid: identity.pid, title: "Doc",
                                 frame: CGRect(x: slot.frame.minX + 10, y: slot.frame.minY + 10, width: 800, height: 600))
        let alert = SpaceOKit.WindowRef(windowID: 222, pid: identity.pid, title: "Alert",
                              frame: CGRect(x: slot.frame.minX + 20, y: slot.frame.minY + 20, width: 300, height: 120))
        let driver = SessionWindowDriver(
            windows: { _ in [document, alert] },
            userDisplayBounds: { nil },
            move: { _, _ in },
            liveBounds: { id in id == 111 ? document.frame : alert.frame },
            liveOwnerPID: { _ in identity.pid },
            focusedWindow: { _ in FocusedWindowObservation(windowID: 222, modal: true) })
        let session = try AgentSession(
            id: "focus", slot: slot,
            teardownDriver: SessionAppTeardownDriver(isAlive: { _ in false }, quit: { _, _ in },
                                                     waitForExit: { _, _ in [] }, cleanupTemporaryProfile: { _ in }),
            windowDriver: driver, watcherFactory: { _, _ in throw StubError() }, initialApps: [app])
        defer { session.destroy(quitApps: false) }

        _ = try session.refreshWindowsChecked()
        XCTAssertEqual(session.primaryWindow?.windowID, 111, "unobserved focus falls back to the largest")
        XCTAssertNil(WindowInfo(document, session: session).focused, "focus never observed is unknown")
        XCTAssertEqual(try session.resolveWindow(nil).windowID, 222, "the modal alert is the default target")
        let infos = session.windows.map { WindowInfo($0, session: session) }
        let alertInfo = try XCTUnwrap(infos.first { $0.windowID == 222 })
        let documentInfo = try XCTUnwrap(infos.first { $0.windowID == 111 })
        XCTAssertEqual(alertInfo.focused, true)
        XCTAssertEqual(alertInfo.modal, true)
        XCTAssertEqual(alertInfo.defaultTarget, true)
        XCTAssertEqual(documentInfo.focused, false)
        XCTAssertNil(documentInfo.modal)
        XCTAssertEqual(documentInfo.defaultTarget, false)
        XCTAssertEqual(try session.resolveWindow(111).windowID, 111, "an explicit window always wins")
    }

    // MARK: - Keystroke routing and misrouting

    func testKeystrokesFollowTheLastPageClickOnlyWhenWebIsOmitted() {
        let page = PointerFocusMemory(windowID: 7, pid: 42, web: true)
        let native = PointerFocusMemory(windowID: 7, pid: 42, web: false)
        func route(_ web: Bool?, bridge: Bool = true, last: PointerFocusMemory? = page,
                   window: CGWindowID = 7, canCarry: Bool = true) -> InputRouter.KeystrokeRoute {
            InputRouter.keystrokeRoute(web: web, windowID: window, pid: 42, hasBridge: bridge,
                                       lastPointer: last, devToolsCanCarry: canCarry)
        }
        XCTAssertEqual(route(nil), .devTools(automatic: true))
        XCTAssertEqual(route(nil).receiptRoute, "chromium-devtools (auto)")
        XCTAssertEqual(route(false), .native, "web:false forces the browser's own UI")
        XCTAssertEqual(route(true, last: nil), .devTools(automatic: false))
        XCTAssertEqual(route(true).receiptRoute, "chromium-devtools")
        XCTAssertEqual(route(nil, last: native), .native)
        XCTAssertEqual(route(nil, last: nil), .native)
        XCTAssertEqual(route(nil, bridge: false), .native)
        XCTAssertEqual(route(nil, window: 8), .native, "a page click in another window says nothing here")
        XCTAssertEqual(route(nil, canCarry: false), .native, "held keys stay native")
        XCTAssertNil(route(false).receiptRoute)
    }

    func testMisroutedKeystrokeBecomesFocusElsewhereWithARunnableRecovery() {
        let error = InputRouter.keystrokeRefusalError("refusing", requestedWindowID: 111, focusedWindowID: 222)
        XCTAssertEqual(error, .focusElsewhere(windowID: 222, detail: "refusing"))
        XCTAssertEqual(error.code, "focus_elsewhere")
        XCTAssertEqual(error.description, "refusing")
        XCTAssertEqual(error.recovery?.tool, "spaceo_read_screen")
        XCTAssertEqual(error.recovery?.arguments["window"], "222")
        XCTAssertEqual(error.recovery?.bound(session: "s", window: 111).arguments["window"], "222",
                       "binding the failed request's window must not overwrite the focused one")
        XCTAssertEqual(InputRouter.keystrokeRefusalError("unknown", requestedWindowID: 111, focusedWindowID: nil),
                       .badRequest("unknown"), "unknown focus stays a plain refusal")
        XCTAssertEqual(InputRouter.keystrokeRefusalError("zero", requestedWindowID: 111, focusedWindowID: 0),
                       .badRequest("zero"))
    }

    // MARK: - Receipts

    func testReceiptOutcomeIsHonest() {
        XCTAssertEqual(SessionManager.receiptOutcome(ok: true, handler: nil, warnings: nil), "confirmed")
        XCTAssertEqual(SessionManager.receiptOutcome(ok: true, handler: nil, warnings: ["unverified"]), "unconfirmed")
        XCTAssertEqual(SessionManager.receiptOutcome(ok: true, handler: "unconfirmed", warnings: nil), "unconfirmed")
        XCTAssertEqual(SessionManager.receiptOutcome(ok: false, handler: "confirmed", warnings: nil), "refused")
    }
}

private struct StubError: Error {}

private final class StubBacking: StageDisplayBacking, @unchecked Sendable {
    let displayID: CGDirectDisplayID = 97_311
    let bounds = CGRect(x: 0, y: 0, width: 1_280, height: 800)
    private let lock = NSLock()
    private var attached = true
    var valid: Bool { lock.withLock { attached } }
    func invalidate() { lock.withLock { attached = false } }
}
