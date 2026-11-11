import Foundation
import ApplicationServices

/// Menu-bar access for an agent's application without activating it.
///
/// An agent's app is never frontmost, so the menu bar visible on its display belongs to the
/// user's app, and every accessibility walk SpaceO did was rooted at a window — menus were
/// unreachable. The application element's `AXMenuBar` is not: `AXPress` on one of its menu
/// items runs the command (TextEdit's File › New opened an Untitled window) while the user's
/// frontmost application stays exactly where it was.
///
/// The walk is bounded like every other one (`AXTraversalBudget`) and goes through
/// `AXTraversalProviding`, so the matching, refusal and rendering rules below are tested
/// against an in-memory menu tree.
enum AXMenu {
    static let maximumPathComponents = 6
    static let maximumComponentCharacters = 256
    static let maximumListedItems = 200
    /// Titles read per menu level while matching. A font or history menu can be long; a level
    /// with more items than this cannot be matched past its end and says so.
    static let maximumScannedItems = 500
    static let maximumTitleBytes = 256

    static let limits = AXTraversalLimits(
        maxDepth: 8, maxNodes: 4_000, timeout: 3, maxAXCalls: 8_000,
        maxAllocatedBytes: 2 * 1_024 * 1_024, childPageSize: 64, maxCallDuration: 0.25)

    struct Result: Equatable {
        /// The listed level (top-level titles, a menu's items), or the pressed item's siblings.
        var items: [MenuItemInfo]
        var truncated: Bool
        /// Canonical titles of the path that was walked.
        var path: [String]
        var pressed: MenuItemInfo?
        /// Items withheld from the listing for safety (Apple menu, Services, …).
        var withheld: Int
    }

    struct Entry<Element> {
        let element: Element
        let title: String
        /// Why this entry can never be listed or pressed, or nil.
        let refusal: String?
    }

    // MARK: - Request validation

    /// Bounded, control-free path components. Absent means "list the menu bar".
    static func validatedPath(_ path: [String]?) throws -> [String] {
        guard let path else { return [] }
        guard path.count <= maximumPathComponents else {
            throw SpaceOError.badRequest(
                "menu path has \(path.count) components; the limit is \(maximumPathComponents)")
        }
        for component in path {
            guard !component.trimmingCharacters(in: .whitespaces).isEmpty,
                  component.count <= maximumComponentCharacters,
                  component.utf8.count <= maximumComponentCharacters * 4,
                  component.unicodeScalars.allSatisfy({
                      !CharacterSet.controlCharacters.contains($0)
                  }) else {
                throw SpaceOError.badRequest(
                    "each menu path component must be 1 through \(maximumComponentCharacters) "
                        + "control-free characters")
            }
        }
        return path
    }

    // MARK: - Pure rules

    /// Menus that act on the whole login session, or on applications other than the agent's.
    ///
    /// The Apple menu holds Log Out, Restart, Shut Down, Force Quit and System Settings;
    /// Services hands the selection to arbitrary other apps; Hide Others and Show All hide and
    /// reveal the user's own applications. None of them is the agent's business.
    static func refusal(title: String, level: Int, index: Int) -> String? {
        let folded = normalized(title)
        if level == 0, index == 0 || folded == "apple" {
            return "the Apple menu acts on the whole login session (Log Out, Shut Down, Force "
                + "Quit, …) and is never available to agents"
        }
        if level > 0, folded == "services" {
            return "the Services menu sends content to other applications and is never "
                + "available to agents"
        }
        if level > 0, folded == "hide others" || folded == "show all" {
            return "'\(title)' hides or shows the user's other applications and is never "
                + "available to agents"
        }
        return nil
    }

    /// Case-insensitive, whitespace-trimmed, without a trailing "…" or "...".
    static func normalized(_ title: String) -> String {
        var value = title.trimmingCharacters(in: .whitespaces)
        if value.hasSuffix("…") {
            value.removeLast()
        } else if value.hasSuffix("...") {
            value.removeLast(3)
        }
        return value.trimmingCharacters(in: .whitespaces).lowercased()
    }

    /// Exact title first; then case-insensitive ignoring a trailing ellipsis. Ambiguity and
    /// absence both name the candidates so the next call can be precise.
    static func matchIndex(_ wanted: String, titles: [String], truncated: Bool = false) throws -> Int {
        let exact = titles.indices.filter { titles[$0] == wanted }
        if exact.count == 1 { return exact[0] }
        let candidates = exact.isEmpty
            ? titles.indices.filter { normalized(titles[$0]) == normalized(wanted) }
            : exact
        if candidates.count == 1 { return candidates[0] }
        if candidates.count > 1 {
            throw SpaceOError.badRequest(
                "menu item '\(wanted)' is ambiguous: "
                    + candidates.prefix(10).map { "'\(titles[$0])'" }.joined(separator: ", "))
        }
        let shown = titles.prefix(30).map { "'\($0)'" }.joined(separator: ", ")
        throw SpaceOError.badRequest(
            "no menu item '\(wanted)'"
                + (truncated ? " among the first \(maximumScannedItems)" : "")
                + (titles.isEmpty ? "" : "; available: " + shown + (titles.count > 30 ? ", …" : "")))
    }

    /// `AXMenuItemCmdModifiers` is a bitmask: 1 shift, 2 option, 4 control, 8 no-command.
    /// Rendered ⌘ first, like `⌘⇧S`. Nil when the item declares no printable key.
    static func shortcut(character: String?, modifiers: Int?) -> String? {
        guard let character, !character.isEmpty, character.count <= 4,
              character.unicodeScalars.allSatisfy({
                  !CharacterSet.controlCharacters.contains($0)
                      && !CharacterSet.whitespacesAndNewlines.contains($0)
              }) else { return nil }
        let mask = modifiers ?? 0
        var rendered = mask & 8 == 0 ? "⌘" : ""
        if mask & 4 != 0 { rendered += "⌃" }
        if mask & 2 != 0 { rendered += "⌥" }
        if mask & 1 != 0 { rendered += "⇧" }
        return rendered + character.uppercased()
    }

    // MARK: - Walk

    /// List the menu bar (empty path), list the menu a path names, or press the leaf it names.
    static func run<P: AXTraversalProviding>(
        app: P.Element,
        path: [String],
        press: Bool,
        provider: P,
        budget: AXTraversalBudget
    ) throws -> Result {
        guard !(press && path.isEmpty) else {
            throw SpaceOError.badRequest(
                "press needs a menu path naming one item, such as [\"File\", \"New\"]")
        }
        guard let bar = try AXTraversal.boundedCall(app, provider: provider, budget: budget, {
            provider.element(app, attribute: kAXMenuBarAttribute as String)
        }) else {
            throw SpaceOError.unsupportedTarget("the application exposes no accessible menu bar")
        }

        var level = try entries(of: bar, level: 0, provider: provider, budget: budget)
        var walked: [String] = []
        if path.isEmpty {
            return try listing(level.entries, truncated: level.truncated, depth: 0, path: walked,
                               provider: provider, budget: budget)
        }
        for (depth, component) in path.enumerated() {
            let titles = level.entries.map(\.title)
            let entry = level.entries[try matchIndex(component, titles: titles, truncated: level.truncated)]
            if let refusal = entry.refusal { throw SpaceOError.badRequest("refusing menu access: " + refusal) }
            walked.append(entry.title)
            let submenu = try self.submenu(of: entry.element, provider: provider, budget: budget)
            let isLast = depth == path.count - 1

            if isLast && press {
                // Read the level first: pressing can close the menu or replace its items.
                var result = try listing(level.entries, truncated: level.truncated, depth: depth,
                                         path: Array(walked.dropLast()), provider: provider, budget: budget)
                let info = try describe(entry, depth: depth, provider: provider, budget: budget)
                guard submenu == nil, depth > 0 else {
                    throw SpaceOError.badRequest(
                        "'\(entry.title)' opens a submenu; add the item inside it to the path")
                }
                guard info.enabled else {
                    throw SpaceOError.badRequest("menu item '\(entry.title)' is disabled right now")
                }
                let pressed = try AXTraversal.boundedCall(entry.element, provider: provider, budget: budget) {
                    provider.perform(entry.element, action: kAXPressAction as String)
                }
                guard pressed else {
                    throw SpaceOError.unsupportedTarget(
                        "the application did not accept AXPress on menu item '\(entry.title)'")
                }
                result.path = walked
                result.pressed = info
                return result
            }
            guard let submenu else {
                if isLast {
                    // A leaf named without press: describe it rather than guess an intent.
                    let info = try describe(entry, depth: depth, provider: provider, budget: budget)
                    return Result(items: [info], truncated: false, path: walked, pressed: nil, withheld: 0)
                }
                throw SpaceOError.badRequest("menu item '\(entry.title)' has no submenu")
            }
            level = try entries(of: submenu, level: depth + 1, provider: provider, budget: budget)
            if isLast {
                return try listing(level.entries, truncated: level.truncated, depth: depth + 1,
                                   path: walked, provider: provider, budget: budget)
            }
        }
        throw SpaceOError.badRequest("menu path could not be resolved")
    }

    /// Titled children of a menu bar or menu, in order. Separators (untitled items) are
    /// skipped; refused items are kept so naming one is a refusal rather than "not found".
    private static func entries<P: AXTraversalProviding>(
        of container: P.Element, level: Int, provider: P, budget: AXTraversalBudget
    ) throws -> (entries: [Entry<P.Element>], truncated: Bool) {
        let attribute = kAXChildrenAttribute as String
        let count = try AXTraversal.boundedCall(container, provider: provider, budget: budget) {
            provider.arrayCount(container, attribute: attribute)
        }
        var result: [Entry<P.Element>] = []
        var start = 0
        var position = 0
        let scanned = min(count, maximumScannedItems)
        while start < scanned {
            let requested = min(budget.limits.childPageSize, scanned - start)
            let page = try AXTraversal.boundedCall(container, provider: provider, budget: budget) {
                provider.elements(container, attribute: attribute, start: start, maxValues: requested)
            }
            guard !page.isEmpty else { break }
            for element in page.prefix(requested) {
                try budget.consumeNode()
                let raw = try AXTraversal.boundedCall(element, provider: provider, budget: budget) {
                    provider.string(element, attribute: kAXTitleAttribute as String)
                } ?? ""
                let title = SessionManager.singleLine(
                    AXTraversal.utf8Prefix(raw, maximumBytes: maximumTitleBytes))
                try budget.consumeAllocation(title.utf8.count + 64)
                defer { position += 1 }
                guard !title.isEmpty else { continue }
                result.append(Entry(element: element, title: title,
                                    refusal: refusal(title: title, level: level, index: position)))
            }
            start += min(page.count, requested)
            if page.count < requested { break }
        }
        return (result, count > maximumScannedItems)
    }

    private static func submenu<P: AXTraversalProviding>(
        of element: P.Element, provider: P, budget: AXTraversalBudget
    ) throws -> P.Element? {
        let attribute = kAXChildrenAttribute as String
        let count = try AXTraversal.boundedCall(element, provider: provider, budget: budget) {
            provider.arrayCount(element, attribute: attribute)
        }
        guard count > 0 else { return nil }
        return try AXTraversal.boundedCall(element, provider: provider, budget: budget) {
            provider.elements(element, attribute: attribute, start: 0, maxValues: 1)
        }.first
    }

    private static func describe<P: AXTraversalProviding>(
        _ entry: Entry<P.Element>, depth: Int, provider: P, budget: AXTraversalBudget
    ) throws -> MenuItemInfo {
        func read(_ attribute: String) throws -> String? {
            try AXTraversal.boundedCall(entry.element, provider: provider, budget: budget) {
                provider.string(entry.element, attribute: attribute)
            }
        }
        let enabled = try AXTraversal.boundedCall(entry.element, provider: provider, budget: budget) {
            provider.bool(entry.element, attribute: kAXEnabledAttribute as String)
        } ?? true
        let hasSubmenu = try AXTraversal.boundedCall(entry.element, provider: provider, budget: budget) {
            provider.arrayCount(entry.element, attribute: kAXChildrenAttribute as String)
        } > 0
        // The menu bar's own items have no marks or shortcuts; skip three calls each.
        guard depth > 0 else {
            return MenuItemInfo(title: entry.title, enabled: enabled, hasSubmenu: hasSubmenu)
        }
        let mark = try read(kAXMenuItemMarkCharAttribute as String)
        let character = try read(kAXMenuItemCmdCharAttribute as String)
        let modifiers = try read(kAXMenuItemCmdModifiersAttribute as String).flatMap { Int($0) }
        return MenuItemInfo(
            title: entry.title,
            enabled: enabled,
            checked: !(mark ?? "").isEmpty,
            hasSubmenu: hasSubmenu,
            shortcut: hasSubmenu ? nil : shortcut(character: character, modifiers: modifiers))
    }

    private static func listing<P: AXTraversalProviding>(
        _ entries: [Entry<P.Element>], truncated scanTruncated: Bool, depth: Int, path: [String],
        provider: P, budget: AXTraversalBudget
    ) throws -> Result {
        let allowed = entries.filter { $0.refusal == nil }
        var items: [MenuItemInfo] = []
        for entry in allowed.prefix(maximumListedItems) {
            items.append(try describe(entry, depth: depth, provider: provider, budget: budget))
        }
        return Result(items: items,
                      truncated: scanTruncated || allowed.count > maximumListedItems,
                      path: path, pressed: nil, withheld: entries.count - allowed.count)
    }

    /// Plain-text rendering shared by the CLI and MCP: one item per line.
    static func outline(_ items: [MenuItemInfo]) -> String {
        guard !items.isEmpty else { return "(no menu items)" }
        return items.map { item in
            var line = "  " + item.title
            if item.hasSubmenu { line += " ▸" }
            if let shortcut = item.shortcut { line += "  \(shortcut)" }
            if item.checked { line += "  [checked]" }
            if !item.enabled { line += "  (disabled)" }
            return line
        }.joined(separator: "\n")
    }

    // MARK: - Production entry point

    static func perform(pid: pid_t, path: [String], press: Bool) throws -> Result {
        guard AX.isTrusted else { throw SpaceOError.accessibilityDenied }
        let budget = try AXTraversalBudget(
            limits: limits,
            now: { DispatchTime.now().uptimeNanoseconds },
            isCancelled: { Task.isCancelled })
        return try run(app: AX.application(pid), path: path, press: press,
                       provider: SystemAXTraversalProvider(), budget: budget)
    }
}
