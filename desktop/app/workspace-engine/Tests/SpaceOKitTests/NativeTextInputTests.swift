import XCTest
import CoreGraphics
@testable import SpaceOKit

final class NativeTextInputTests: XCTestCase {
    private final class Field {
        var value: String
        var selection: CFRange
        var writes = 0
        var selections = 0
        var ignoreSelect = false
        var ignoreInsert = false
        var unreadableValue = false
        init(_ value: String, selection: CFRange = .init(location: 0, length: 0)) {
            self.value = value; self.selection = selection
        }
        func driver(canSelect: Bool = true, canInsert: Bool = true) -> NativeTextInput.Driver {
            .init(canSelect: canSelect, canInsert: canInsert, value: {
                    if self.unreadableValue { throw SpaceOError.unsupportedTarget("focused field did not expose its current text value") }
                    return self.value
                },
                selection: { self.selection }, select: { range in
                    self.selections += 1
                    if !self.ignoreSelect { self.selection = range }
                }, insert: { text in
                    self.writes += 1
                    if !self.ignoreInsert {
                        self.value = try NativeTextInput.expectedValue(self.value, selection: self.selection, text: text)
                        self.selection = .init(location: self.selection.location + text.utf16.count, length: 0)
                    }
                })
        }
    }

    func testReplaceAndSelectAllThenTypeReplaceInsteadOfAppending() throws {
        for explicitReplace in [true, false] {
            let field = Field("AAA\n\nBBB")
            if !explicitReplace { XCTAssertTrue(try NativeTextInput.selectAll(field.driver())) }
            XCTAssertTrue(try NativeTextInput.type("CCC", replace: explicitReplace, driver: field.driver()))
            XCTAssertEqual(field.value, "CCC")
            XCTAssertEqual(field.writes, 1)
        }
    }

    func testUTF16SelectionPreservesUnselectedTextAndCaretInsertion() throws {
        let field = Field("a👩🏽‍💻z", selection: .init(location: 1, length: "👩🏽‍💻".utf16.count))
        XCTAssertTrue(try NativeTextInput.type("é\n", replace: false, driver: field.driver()))
        XCTAssertEqual(field.value, "aé\nz")
        XCTAssertFalse(try NativeTextInput.type("X", replace: false, driver: field.driver()))
        XCTAssertEqual(field.value, "aé\nz", "caret typing retains the normal key-event route")
    }

    func testEmptyReplaceClearsExistingText() throws {
        let field = Field("old text")
        XCTAssertTrue(try NativeTextInput.type("", replace: true, driver: field.driver()))
        XCTAssertEqual(field.value, "")
    }

    func testUnsupportedOrIgnoredSelectionNeverTypes() throws {
        for mode in ["unsupportedSelect", "unsupportedInsert", "ignoredSelect"] {
            let field = Field("preserve")
            field.ignoreSelect = mode == "ignoredSelect"
            let driver = field.driver(canSelect: mode != "unsupportedSelect", canInsert: mode != "unsupportedInsert")
            XCTAssertThrowsError(try NativeTextInput.type("new", replace: true, driver: driver))
            XCTAssertEqual(field.value, "preserve")
            XCTAssertEqual(field.writes, 0)
        }
    }

    func testIgnoredInsertionThrowsWithoutSyntheticRetry() {
        let field = Field("old", selection: .init(location: 0, length: 3))
        field.ignoreInsert = true
        XCTAssertThrowsError(try NativeTextInput.type("new", replace: false, driver: field.driver()))
        XCTAssertEqual(field.value, "old")
        XCTAssertEqual(field.writes, 1)
    }

    func testInvalidAndSplitSurrogateSelectionsRefuseBeforeWriting() {
        for range in [CFRange(location: -1, length: 1), .init(location: 0, length: -1),
                      .init(location: 4, length: Int.max), .init(location: Int.max, length: 1),
                      .init(location: 1, length: 1)] {
            let field = Field("😀abc", selection: range)
            XCTAssertThrowsError(try NativeTextInput.type("X", replace: false, driver: field.driver()))
            XCTAssertEqual(field.writes, 0)
        }
    }

    func testMultilineNormalizationAndSingleLineRefusal() throws {
        let field = Field("old")
        XCTAssertTrue(try NativeTextInput.type("a\r\nb\rc", replace: true, driver: field.driver()))
        XCTAssertEqual(field.value, "a\nb\nc")
        var singleLine = field.driver()
        singleLine.allowsMultiline = false
        XCTAssertThrowsError(try NativeTextInput.type("a\nb", replace: true, driver: singleLine))
        XCTAssertEqual(field.value, "a\nb\nc")
    }

    func testNonEditableSelectionsAndLargeCollapsedCaretKeepKeystrokeFallback() throws {
        let readonly = Field("scrollback", selection: .init(location: 0, length: 5))
        XCTAssertFalse(try NativeTextInput.type("ls\n", replace: false, driver: readonly.driver(canInsert: false)))
        XCTAssertEqual(readonly.writes, 0)
        let large = Field(String(repeating: "x", count: NativeTextInput.maximumDocumentBytes + 1))
        XCTAssertFalse(try NativeTextInput.type("x", replace: false, driver: large.driver()))
        large.selection = .init(location: 0, length: 5)
        XCTAssertFalse(try NativeTextInput.type("x", replace: false, driver: large.driver()))
        XCTAssertFalse(try NativeTextInput.selectAll(large.driver()))
        XCTAssertEqual(large.writes, 0)
        XCTAssertEqual(large.selections, 0)
    }

    func testReadbackErrorAfterInsertionIsAlwaysUnconfirmedAndNeverRetried() throws {
        let field = Field("old", selection: .init(location: 0, length: 3))
        var inserted = false
        let base = field.driver()
        let driver = NativeTextInput.Driver(canSelect: true, canInsert: true, value: {
            if inserted { throw SpaceOError.badRequest("focused target changed; edit refused") }
            return field.value
        }, selection: base.selection, select: base.select, insert: { text in
            try base.insert(text)
            inserted = true
        })
        XCTAssertThrowsError(try NativeTextInput.type("new", replace: false, driver: driver)) { error in
            XCTAssertTrue(error.localizedDescription.contains("delivery unconfirmed"))
            XCTAssertTrue(error.localizedDescription.contains("do not retry blindly"))
        }
        XCTAssertEqual(field.value, "new")
        XCTAssertEqual(field.writes, 1)
    }

    func testOnlyUnmodifiedCommandAUsesSemanticSelectAll() throws {
        XCTAssertTrue(NativeTextInput.isSelectAll(try KeyCombo.parse("cmd+a")))
        for key in ["a", "cmd+shift+a", "cmd+opt+a", "ctrl+a", "cmd+b"] {
            XCTAssertFalse(NativeTextInput.isSelectAll(try KeyCombo.parse(key)))
        }
    }

    // MARK: - One aggregate budget and a re-proven target

    private final class Clock { var now: UInt64 = 1_000 }

    /// Element -1 is the application. Every provider read is one call and advances the clock.
    private final class FakeTextProvider: NativeTextProviding {
        static let app = -1
        struct Node { var role: String?; var subrole: String? = nil; var parent: Int?; var windowID: CGWindowID = 0 }
        var nodes: [Int: Node] = [:]
        var focusedWindow: Int?
        var focusedElement: Int? = 0
        var settable: Set<String> = [kAXSelectedTextRangeAttribute as String, kAXSelectedTextAttribute as String]
        let clock = Clock()
        var step: UInt64 = 0
        var onCall: ((Int) -> Void)?
        private(set) var calls = 0
        private(set) var roleCallStarts: [UInt64] = []

        /// A focused AXTextArea `depth` parents below window 42 (or an AXWebArea just above it).
        init(depth: Int = 2, role: String = "AXTextArea", web: Bool = false, windowID: CGWindowID = 42) {
            nodes[0] = Node(role: role, parent: 1)
            for level in 1..<depth { nodes[level] = Node(role: web && level == 1 ? "AXWebArea" : "AXGroup", parent: level + 1) }
            nodes[depth] = Node(role: "AXWindow", parent: nil, windowID: windowID)
            focusedWindow = depth
        }

        private func tick() { calls += 1; clock.now += step; onCall?(calls) }
        func setMessagingTimeout(_ element: Int, seconds: Float) -> Bool { true }
        func string(_ element: Int, attribute: String) -> String? {
            if attribute == kAXRoleAttribute as String { roleCallStarts.append(clock.now) }
            tick()
            switch attribute {
            case kAXRoleAttribute as String: return nodes[element]?.role
            case kAXSubroleAttribute as String: return nodes[element]?.subrole
            default: return nil
            }
        }
        func bool(_ element: Int, attribute: String) -> Bool? { tick(); return nil }
        func actions(_ element: Int) -> [String] { tick(); return [] }
        func point(_ element: Int, attribute: String) -> CGPoint? { tick(); return nil }
        func size(_ element: Int, attribute: String) -> CGSize? { tick(); return nil }
        func arrayCount(_ element: Int, attribute: String) -> Int { tick(); return 0 }
        func elements(_ element: Int, attribute: String, start: Int, maxValues: Int) -> [Int] { tick(); return [] }
        func windowID(_ element: Int) -> CGWindowID { tick(); return nodes[element]?.windowID ?? 0 }
        func element(_ element: Int, attribute: String) -> Int? {
            tick()
            if element == Self.app {
                if attribute == kAXFocusedWindowAttribute as String { return focusedWindow }
                if attribute == kAXFocusedUIElementAttribute as String { return focusedElement }
                return nil
            }
            return attribute == kAXParentAttribute as String ? nodes[element]?.parent : nil
        }
        func isSettable(_ element: Int, attribute: String) -> Bool { tick(); return settable.contains(attribute) }

        func budget(_ limits: AXTraversalLimits = NativeTextInput.limits) throws -> AXTraversalBudget {
            try AXTraversalBudget(limits: limits, now: { [clock] in clock.now }, isCancelled: { false })
        }
        func qualify(_ budget: AXTraversalBudget, windowID: CGWindowID = 42) throws -> NativeTextInput.Qualified<Int>? {
            try NativeTextInput.qualify(app: Self.app, windowID: windowID, provider: self, budget: budget)
        }
    }

    /// `field` behind the production target check: every step first lets `willAccess` move
    /// focus, then re-proves element 0 in window 42 inside one shared budget.
    private func verifiedDriver(_ field: Field, _ provider: FakeTextProvider, budget: AXTraversalBudget,
                                canInsert: Bool = true, allowsMultiline: Bool = true,
                                willAccess: @escaping (String) -> Void = { _ in }) -> NativeTextInput.Driver {
        let verify = { () throws -> Void in
            try NativeTextInput.verifyTarget(0, app: FakeTextProvider.app, windowID: 42, provider: provider, budget: budget)
        }
        let base = field.driver(canInsert: canInsert)
        var driver = NativeTextInput.Driver(canSelect: true, canInsert: canInsert, value: {
            willAccess("value"); try verify(); return try base.value()
        }, selection: {
            willAccess("selection"); try verify(); return try base.selection()
        }, select: { range in
            willAccess("select"); try verify(); try base.select(range)
        }, insert: { text in
            willAccess("insert"); try verify(); try base.insert(text)
        }, verifyTarget: { willAccess("verify"); try verify() })
        driver.allowsMultiline = allowsMultiline
        return driver
    }

    func testQualificationAcceptsOnlyAFocusedNativeFieldInTheRequestedWindow() throws {
        let native = FakeTextProvider()
        let qualified = try XCTUnwrap(try native.qualify(native.budget()))
        XCTAssertEqual(qualified.element, 0)
        XCTAssertTrue(qualified.canSelect && qualified.canInsert && qualified.allowsMultiline)

        let readonly = FakeTextProvider()
        readonly.settable = [kAXSelectedTextRangeAttribute as String]
        XCTAssertEqual(try readonly.qualify(readonly.budget())?.canInsert, false,
                       "a read-only Terminal-style area qualifies but keeps the key route")

        let web = FakeTextProvider(web: true)
        XCTAssertNil(try web.qualify(web.budget()), "web content is never edited natively")
        let otherAncestor = FakeTextProvider()
        otherAncestor.nodes[2]?.windowID = 41
        otherAncestor.nodes[3] = .init(role: "AXWindow", parent: nil, windowID: 42)
        otherAncestor.focusedWindow = 3
        XCTAssertNil(try otherAncestor.qualify(otherAncestor.budget()), "the field's own window must match")
        let button = FakeTextProvider(role: "AXButton")
        XCTAssertNil(try button.qualify(button.budget()))
        let secure = FakeTextProvider(role: "AXTextField")
        secure.nodes[0]?.subrole = "AXSecureTextField"
        XCTAssertNil(try secure.qualify(secure.budget()))
        let silent = FakeTextProvider()
        silent.focusedWindow = nil
        XCTAssertNil(try silent.qualify(silent.budget()), "an unreported key window leaves the caller's targeting decision")

        let moved = FakeTextProvider(windowID: 41)
        XCTAssertThrowsError(try moved.qualify(moved.budget())) { error in
            XCTAssertTrue(error is NativeTextInput.TargetChanged, "\(error)")
        }
    }

    func testDeepSlowAncestryStopsInsideOneAggregateBudget() throws {
        let slow = FakeTextProvider(depth: 10_000)
        slow.step = 50_000_000 // 50 ms per provider read
        let budget = try slow.budget()
        let deadline = slow.clock.now + UInt64(NativeTextInput.limits.timeout * 1_000_000_000)
        XCTAssertThrowsError(try slow.qualify(budget)) { error in
            XCTAssertEqual((error as? AXTraversalStopped)?.reason, .deadline, "\(error)")
        }
        XCTAssertLessThanOrEqual(slow.calls, 61, "3 s at 50 ms per read, not a fresh deadline per level")
        XCTAssertFalse(slow.roleCallStarts.isEmpty)
        XCTAssertTrue(slow.roleCallStarts.allSatisfy { $0 < deadline }, "no role read starts after the deadline")

        let callCapped = FakeTextProvider(depth: 10_000)
        var capped = NativeTextInput.limits
        capped.maxAXCalls = 40
        XCTAssertThrowsError(try callCapped.qualify(callCapped.budget(capped))) { error in
            XCTAssertEqual((error as? AXTraversalStopped)?.reason, .axCalls, "\(error)")
        }
        XCTAssertEqual(callCapped.calls, 40, "the call cap is aggregate across focus, role and ancestry reads")

        let deep = FakeTextProvider(depth: 10_000)
        XCTAssertNil(try deep.qualify(deep.budget()), "an unproven ancestry is not native text")
        XCTAssertLessThanOrEqual(deep.calls, 2 * AX.maxAncestryDepth + 10)
    }

    func testDeclinedQualificationRechecksFocusAfterSlowAncestryAndUnsupportedRole() throws {
        for depth in [2, 10_000] {
            let role = depth == 2 ? "AXButton" : "AXTextArea"
            let moved = FakeTextProvider(depth: depth, role: role)
            moved.step = 10_000_000
            moved.nodes[20_000] = .init(role: "AXWindow", parent: nil, windowID: 41)
            moved.onCall = { [weak moved] call in
                if call == 3 { moved?.focusedWindow = 20_000 }
            }
            XCTAssertThrowsError(try moved.qualify(moved.budget())) { error in
                XCTAssertTrue(error is NativeTextInput.TargetChanged, "\(error)")
            }
            XCTAssertLessThanOrEqual(moved.calls, 2 * AX.maxAncestryDepth + 10)

            let stable = FakeTextProvider(depth: depth, role: role)
            stable.step = 10_000_000
            XCTAssertNil(try stable.qualify(stable.budget()))
            XCTAssertLessThanOrEqual(stable.calls, 2 * AX.maxAncestryDepth + 10)
        }
    }

    func testDeclinedQualificationRefusesWhenPreviouslyReportedFocusDisappears() throws {
        let provider = FakeTextProvider(role: "AXButton")
        provider.onCall = { [weak provider] call in
            if call == 3 { provider?.focusedWindow = nil }
        }
        XCTAssertThrowsError(try provider.qualify(provider.budget())) { error in
            XCTAssertTrue(error is NativeTextInput.TargetChanged, "\(error)")
        }
    }

    func testFocusMovingBeforeAnySemanticStepRefusesWithoutSelectionInsertionOrFallback() throws {
        // A throw (rather than `false`) is what keeps SessionManager from synthesizing keys.
        let steps: [(name: String, replace: Bool?, moveAt: String)] = [
            ("select-all value", nil, "value"), ("caret selection", false, "selection"),
            ("selection value", false, "value"), ("replace select", true, "select"),
            ("replace value", true, "value"),
        ]
        for moveFocusWindow in [false, true] {
            for step in steps {
                let provider = FakeTextProvider()
                let field = Field("keep", selection: .init(location: 0, length: 4))
                let driver = verifiedDriver(field, provider, budget: try provider.budget()) { event in
                    guard event == step.moveAt else { return }
                    if moveFocusWindow { provider.focusedWindow = nil } else { provider.focusedElement = 7 }
                }
                func attempt() throws {
                    if let replace = step.replace { _ = try NativeTextInput.type("new", replace: replace, driver: driver) }
                    else { try NativeTextInput.selectAll(driver) }
                }
                XCTAssertThrowsError(try attempt(), step.name) { error in
                    XCTAssertTrue(error.localizedDescription.contains("edit refused"), "\(step.name): \(error)")
                }
                XCTAssertEqual(field.writes, 0, step.name)
                XCTAssertEqual(field.selections, 0, step.name)
                XCTAssertEqual(field.value, "keep", step.name)
            }
        }
    }

    func testEveryDeclinedPathReprovesTheTargetBeforeKeystrokeFallback() throws {
        let cases: [(name: String, text: String, canInsert: Bool, multiline: Bool, selection: CFRange, value: String, unreadable: Bool)] = [
            ("read-only", "ls\n", false, true, .init(location: 0, length: 5), "scrollback", false),
            ("caret", "x", true, true, .init(location: 0, length: 0), "abc", false),
            ("empty", "", true, true, .init(location: 0, length: 3), "abc", false),
            ("single-line multiline", "a\nb", true, false, .init(location: 0, length: 3), "abc", false),
            ("oversized", "x", true, true, .init(location: 0, length: 3),
             String(repeating: "x", count: NativeTextInput.maximumDocumentBytes + 1), false),
            ("unsupported read", "x", true, true, .init(location: 0, length: 3), "abc", true),
        ]
        for c in cases {
            for focusMoves in [false, true] {
                let provider = FakeTextProvider()
                let field = Field(c.value, selection: c.selection)
                field.unreadableValue = c.unreadable
                let driver = verifiedDriver(field, provider, budget: try provider.budget(),
                                            canInsert: c.canInsert, allowsMultiline: c.multiline) { event in
                    if focusMoves, event == "verify" { provider.focusedElement = 7 }
                }
                if focusMoves {
                    XCTAssertThrowsError(try NativeTextInput.type(c.text, replace: false, driver: driver), c.name)
                } else {
                    XCTAssertFalse(try NativeTextInput.type(c.text, replace: false, driver: driver),
                                   "\(c.name): an unsupported field on the same target keeps the key route")
                }
                XCTAssertEqual(field.writes, 0, c.name)
                XCTAssertEqual(field.selections, 0, c.name)
            }
        }
        for focusMoves in [false, true] {
            let provider = FakeTextProvider()
            let field = Field("abc")
            field.unreadableValue = true
            let driver = verifiedDriver(field, provider, budget: try provider.budget()) { event in
                if focusMoves, event == "verify" { provider.focusedElement = 7 }
            }
            if focusMoves { XCTAssertThrowsError(try NativeTextInput.selectAll(driver)) }
            else { XCTAssertFalse(try NativeTextInput.selectAll(driver)) }
            XCTAssertEqual(field.selections, 0)
        }
    }

    func testExhaustedBudgetRefusesInsteadOfFallingBack() throws {
        let provider = FakeTextProvider()
        let budget = try provider.budget()
        let readonly = Field("scrollback", selection: .init(location: 0, length: 5))
        provider.clock.now += 4_000_000_000
        let driver = verifiedDriver(readonly, provider, budget: budget, canInsert: false)
        XCTAssertThrowsError(try NativeTextInput.type("ls\n", replace: false, driver: driver)) { error in
            XCTAssertTrue(error.localizedDescription.contains("budget"), "\(error)")
            XCTAssertTrue(error.localizedDescription.contains("nothing typed"), "\(error)")
        }
        let stopped = AXTraversalStopped(reason: .axCalls, detail: "test")
        let field = Field("abc", selection: .init(location: 0, length: 3))
        let base = field.driver()
        let starved = NativeTextInput.Driver(canSelect: true, canInsert: true, value: { throw stopped },
            selection: base.selection, select: base.select, insert: base.insert)
        XCTAssertThrowsError(try NativeTextInput.type("x", replace: false, driver: starved))
        XCTAssertThrowsError(try NativeTextInput.selectAll(starved))
        XCTAssertEqual(field.writes + field.selections, 0)
    }

    func testTargetChangeAfterSelectionOrWriteIsUnconfirmedAndNeverRetried() throws {
        let provider = FakeTextProvider()
        let written = Field("old", selection: .init(location: 0, length: 3))
        let afterWrite = verifiedDriver(written, provider, budget: try provider.budget()) { event in
            if event == "value", written.writes == 1 { provider.focusedElement = 7 }
        }
        XCTAssertThrowsError(try NativeTextInput.type("new", replace: false, driver: afterWrite)) { error in
            XCTAssertTrue(error.localizedDescription.contains("delivery unconfirmed"), "\(error)")
        }
        XCTAssertEqual(written.writes, 1)

        let selected = Field("old")
        let afterSelect = verifiedDriver(selected, provider, budget: try provider.budget()) { event in
            if event == "selection", selected.selections == 1 { provider.focusedElement = 7 }
        }
        provider.focusedElement = 0
        XCTAssertThrowsError(try NativeTextInput.type("new", replace: true, driver: afterSelect))
        XCTAssertEqual(selected.selections, 1)
        XCTAssertEqual(selected.writes, 0)
    }
}
