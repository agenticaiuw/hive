import XCTest
import ApplicationServices
import CoreGraphics
@testable import SpaceOKit

/// An in-memory menu bar: element 0 is the application, whose `AXMenuBar` is element 1.
private final class FakeMenuProvider: AXTraversalProviding {
    struct Node {
        var title: String?
        var children: [Int] = []
        var enabled: Bool? = true
        var mark: String?
        var character: String?
        var modifiers: Int?
    }

    var nodes: [Int: Node] = [:]
    var menuBar: Int? = 1
    var acceptsPress = true
    private(set) var pressed: [Int] = []
    private(set) var calls = 0
    private var nextID = 2

    init() { nodes[1] = Node(title: nil) }

    /// Add a titled item under `parent`. Items that open a submenu get an `AXMenu` child.
    @discardableResult
    func add(_ title: String?, under parent: Int, submenu: Bool = false, enabled: Bool = true,
             mark: String? = nil, character: String? = nil, modifiers: Int? = nil) -> Int {
        let id = nextID
        nextID += 1
        nodes[id] = Node(title: title, enabled: enabled, mark: mark, character: character,
                         modifiers: modifiers)
        nodes[parent]?.children.append(id)
        guard submenu else { return id }
        let menu = nextID
        nextID += 1
        nodes[menu] = Node(title: nil)
        nodes[id]?.children.append(menu)
        return menu
    }

    func setMessagingTimeout(_ element: Int, seconds: Float) -> Bool { true }

    func string(_ element: Int, attribute: String) -> String? {
        calls += 1
        let node = nodes[element]
        switch attribute {
        case kAXTitleAttribute as String: return node?.title
        case kAXMenuItemMarkCharAttribute as String: return node?.mark
        case kAXMenuItemCmdCharAttribute as String: return node?.character
        case kAXMenuItemCmdModifiersAttribute as String: return node?.modifiers.map(String.init)
        default: return nil
        }
    }

    func bool(_ element: Int, attribute: String) -> Bool? {
        calls += 1
        return attribute == kAXEnabledAttribute as String ? nodes[element]?.enabled : nil
    }

    func actions(_ element: Int) -> [String] { [] }
    func point(_ element: Int, attribute: String) -> CGPoint? { nil }
    func size(_ element: Int, attribute: String) -> CGSize? { nil }

    func arrayCount(_ element: Int, attribute: String) -> Int {
        calls += 1
        return nodes[element]?.children.count ?? 0
    }

    func elements(_ element: Int, attribute: String, start: Int, maxValues: Int) -> [Int] {
        calls += 1
        let children = nodes[element]?.children ?? []
        guard start < children.count else { return [] }
        return Array(children[start..<min(children.count, start + maxValues)])
    }

    func windowID(_ element: Int) -> CGWindowID { 0 }

    func element(_ element: Int, attribute: String) -> Int? {
        calls += 1
        return element == 0 && attribute == kAXMenuBarAttribute as String ? menuBar : nil
    }

    func perform(_ element: Int, action: String) -> Bool {
        calls += 1
        guard action == kAXPressAction as String, acceptsPress else { return false }
        pressed.append(element)
        return true
    }
}

final class AXMenuTests: XCTestCase {
    private var provider = FakeMenuProvider()
    private var newItem = 0
    private var servicesMenu = 0

    /// Apple, TextEdit (with Services and Hide Others), File (New ⌘N, a separator, Open Recent ▸,
    /// Export as PDF… disabled, Save ⌘⇧S), Format (Wrap checked).
    override func setUp() {
        super.setUp()
        provider = FakeMenuProvider()
        let apple = provider.add("Apple", under: 1, submenu: true)
        provider.add("Log Out", under: apple)
        let app = provider.add("TextEdit", under: 1, submenu: true)
        provider.add("About TextEdit", under: app)
        servicesMenu = provider.add("Services", under: app, submenu: true)
        provider.add("Hide Others", under: app, character: "h", modifiers: 2)
        provider.add("Quit TextEdit", under: app, character: "q")
        let file = provider.add("File", under: 1, submenu: true)
        newItem = provider.add("New", under: file, character: "n")
        provider.add("", under: file)
        let recent = provider.add("Open Recent", under: file, submenu: true)
        provider.add("notes.txt", under: recent)
        provider.add("Export as PDF…", under: file, enabled: false)
        provider.add("Save", under: file, character: "s", modifiers: 1)
        let format = provider.add("Format", under: 1, submenu: true)
        provider.add("Wrap to Page", under: format, mark: "✓")
    }

    private func run(_ path: [String], press: Bool = false,
                     limits: AXTraversalLimits = AXMenu.limits) throws -> AXMenu.Result {
        let budget = try AXTraversalBudget(limits: limits, now: { 0 }, isCancelled: { false })
        return try AXMenu.run(app: 0, path: path, press: press, provider: provider, budget: budget)
    }

    private func message(_ body: () throws -> Any) -> String {
        do {
            _ = try body()
            XCTFail("expected an error")
            return ""
        } catch {
            return "\(error)"
        }
    }

    // MARK: - Listing

    func testEmptyPathListsTopLevelMenusWithoutTheAppleMenu() throws {
        let result = try run([])
        XCTAssertEqual(result.items.map(\.title), ["TextEdit", "File", "Format"])
        XCTAssertTrue(result.items.allSatisfy(\.hasSubmenu))
        XCTAssertEqual(result.withheld, 1)
        XCTAssertFalse(result.truncated)
        XCTAssertTrue(provider.pressed.isEmpty)
    }

    func testMenuListingCarriesStateShortcutsAndSubmenusAndSkipsSeparators() throws {
        let file = try run(["File"])
        XCTAssertEqual(file.path, ["File"])
        XCTAssertEqual(file.items, [
            MenuItemInfo(title: "New", shortcut: "⌘N"),
            MenuItemInfo(title: "Open Recent", hasSubmenu: true),
            MenuItemInfo(title: "Export as PDF…", enabled: false),
            MenuItemInfo(title: "Save", shortcut: "⌘⇧S"),
        ])
        let format = try run(["format"])
        XCTAssertEqual(format.items, [MenuItemInfo(title: "Wrap to Page", checked: true)])
        XCTAssertEqual(try run(["File", "Open Recent"]).items.map(\.title), ["notes.txt"])
    }

    func testApplicationMenuWithholdsServicesAndHideOthers() throws {
        let result = try run(["TextEdit"])
        XCTAssertEqual(result.items.map(\.title), ["About TextEdit", "Quit TextEdit"])
        XCTAssertEqual(result.withheld, 2)
    }

    func testNamingALeafWithoutPressDescribesItAndPressesNothing() throws {
        let result = try run(["File", "Save"])
        XCTAssertEqual(result.items, [MenuItemInfo(title: "Save", shortcut: "⌘⇧S")])
        XCTAssertNil(result.pressed)
        XCTAssertTrue(provider.pressed.isEmpty)
    }

    func testListingIsCappedAndSaysSo() throws {
        let big = provider.add("History", under: 1, submenu: true)
        for index in 0..<(AXMenu.maximumListedItems + 5) {
            provider.add("Page \(index)", under: big)
        }
        let result = try run(["History"])
        XCTAssertEqual(result.items.count, AXMenu.maximumListedItems)
        XCTAssertTrue(result.truncated)
    }

    // MARK: - Pressing

    func testPressRunsTheLeafAndReturnsItsSiblings() throws {
        let result = try run(["File", "New"], press: true)
        XCTAssertEqual(provider.pressed, [newItem])
        XCTAssertEqual(result.pressed, MenuItemInfo(title: "New", shortcut: "⌘N"))
        XCTAssertEqual(result.path, ["File", "New"])
        XCTAssertEqual(result.items.map(\.title), ["New", "Open Recent", "Export as PDF…", "Save"])
    }

    func testMatchingFallsBackToCaseAndTrailingEllipsis() throws {
        XCTAssertEqual(try AXMenu.matchIndex("export as pdf", titles: ["Export as PDF…"]), 0)
        XCTAssertEqual(try AXMenu.matchIndex("Export as PDF...", titles: ["Export as PDF…"]), 0)
        XCTAssertEqual(try AXMenu.matchIndex("Save", titles: ["save", "Save"]), 1,
                       "an exact title wins over a case-insensitive one")
        let ambiguous = message { try AXMenu.matchIndex("save", titles: ["Save…", "SAVE"]) }
        XCTAssertTrue(ambiguous.contains("ambiguous") && ambiguous.contains("'Save…'")
                      && ambiguous.contains("'SAVE'"), ambiguous)
        let missing = message { try AXMenu.matchIndex("Print", titles: ["New", "Save"]) }
        XCTAssertTrue(missing.contains("no menu item 'Print'") && missing.contains("'New'"), missing)
    }

    func testSessionWideMenusAreRefusedEvenWhenNamedExactly() {
        for path in [["Apple", "Log Out"], ["apple"], ["TextEdit", "Services"],
                     ["TextEdit", "Hide Others"]] {
            let text = message { try run(path, press: true) }
            XCTAssertTrue(text.contains("never available to agents"), "\(path): \(text)")
        }
        XCTAssertTrue(provider.pressed.isEmpty)
        // Services' contents are unreachable, whatever the next component is.
        provider.add("Make Sticky", under: servicesMenu)
        let nested = message { try run(["TextEdit", "Services", "Make Sticky"], press: true) }
        XCTAssertTrue(nested.contains("Services"), nested)
    }

    func testFirstTopLevelItemIsTheAppleMenuWhateverItsTitle() {
        provider.nodes[2]?.title = "Pomme"
        XCTAssertNotNil(AXMenu.refusal(title: "Pomme", level: 0, index: 0))
        XCTAssertNil(AXMenu.refusal(title: "Pomme", level: 0, index: 1))
        let text = message { try run(["Pomme"]) }
        XCTAssertTrue(text.contains("Apple menu"), text)
    }

    func testPressRefusesDisabledItemsSubmenusMenuTitlesAndRejectedPresses() {
        XCTAssertTrue(message { try run(["File", "Export as PDF"], press: true) }.contains("disabled"))
        XCTAssertTrue(message { try run(["File", "Open Recent"], press: true) }.contains("submenu"))
        XCTAssertTrue(message { try run(["File"], press: true) }.contains("submenu"))
        XCTAssertTrue(message { try run([], press: true) }.contains("press needs a menu path"))
        provider.acceptsPress = false
        XCTAssertTrue(message { try run(["File", "New"], press: true) }.contains("did not accept AXPress"))
    }

    func testIntermediateLeafAndMissingMenuBarFailClearly() {
        XCTAssertTrue(message { try run(["File", "New", "Blank"]) }.contains("has no submenu"))
        provider.menuBar = nil
        XCTAssertTrue(message { try run([]) }.contains("no accessible menu bar"))
    }

    func testWalkStaysInsideTheTraversalBudget() throws {
        var limits = AXMenu.limits
        limits.maxAXCalls = 5
        XCTAssertThrowsError(try run(["File"], limits: limits)) {
            XCTAssertEqual(($0 as? AXTraversalStopped)?.reason, .axCalls)
        }
    }

    // MARK: - Pure rules

    func testPathValidationBoundsCountLengthAndControlCharacters() throws {
        XCTAssertEqual(try AXMenu.validatedPath(nil), [])
        XCTAssertEqual(try AXMenu.validatedPath(["File", "New"]), ["File", "New"])
        XCTAssertThrowsError(try AXMenu.validatedPath(Array(repeating: "A", count: 7)))
        XCTAssertThrowsError(try AXMenu.validatedPath([String(repeating: "x", count: 257)]))
        XCTAssertThrowsError(try AXMenu.validatedPath(["  "]))
        XCTAssertThrowsError(try AXMenu.validatedPath(["File\nNew"]))
    }

    func testShortcutRendering() {
        XCTAssertEqual(AXMenu.shortcut(character: "s", modifiers: 1), "⌘⇧S")
        XCTAssertEqual(AXMenu.shortcut(character: "N", modifiers: 0), "⌘N")
        XCTAssertEqual(AXMenu.shortcut(character: "h", modifiers: 2), "⌘⌥H")
        XCTAssertEqual(AXMenu.shortcut(character: "f", modifiers: 4 | 8), "⌃F")
        XCTAssertNil(AXMenu.shortcut(character: nil, modifiers: 0))
        XCTAssertNil(AXMenu.shortcut(character: "\u{7f}", modifiers: 0))
    }

    func testOutlineRendering() {
        let outline = AXMenu.outline([
            MenuItemInfo(title: "New", shortcut: "⌘N"),
            MenuItemInfo(title: "Open Recent", hasSubmenu: true),
            MenuItemInfo(title: "Wrap", checked: true),
            MenuItemInfo(title: "Export", enabled: false),
        ])
        XCTAssertEqual(outline, "  New  ⌘N\n  Open Recent ▸\n  Wrap  [checked]\n  Export  (disabled)")
        XCTAssertEqual(AXMenu.outline([]), "(no menu items)")
    }
}
