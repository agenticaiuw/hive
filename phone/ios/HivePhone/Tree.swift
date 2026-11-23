import CoreGraphics
import Foundation

/// One element of an app's accessibility tree, taken from an XCUITest snapshot (Runner.swift).
struct Node {
    var type: UInt
    var name: String
    var label: String
    var value: String
    var enabled: Bool
    var frame: CGRect
    var children: [Node]
}

/// The tree the way WebDriverAgent shows it, since the server's phone crate reads it that way: its page source, and the
/// attributes its predicate-string searches use (`type`, `visible`), which XCUITest's own queries don't have.
enum Tree {
    /// XCUIElement.ElementType's raw values, in order.
    static let types = ["Any", "Other", "Application", "Group", "Window", "Sheet", "Drawer", "Alert", "Dialog", "Button",
        "RadioButton", "RadioGroup", "CheckBox", "DisclosureTriangle", "PopUpButton", "ComboBox", "MenuButton", "ToolbarButton",
        "Popover", "Keyboard", "Key", "NavigationBar", "TabBar", "TabGroup", "Toolbar", "StatusBar", "Table", "TableRow",
        "TableColumn", "Outline", "OutlineRow", "Browser", "CollectionView", "Slider", "PageIndicator", "ProgressIndicator",
        "ActivityIndicator", "SegmentedControl", "Picker", "PickerWheel", "Switch", "Toggle", "Link", "Image", "Icon",
        "SearchField", "ScrollView", "ScrollBar", "StaticText", "TextField", "SecureTextField", "DatePicker", "TextView", "Menu",
        "MenuItem", "MenuBar", "MenuBarItem", "Map", "WebView", "IncrementArrow", "DecrementArrow", "Timeline", "RatingIndicator",
        "ValueIndicator", "SplitGroup", "Splitter", "RelevanceIndicator", "ColorWell", "HelpTag", "Matte", "DockItem", "Ruler",
        "RulerMarker", "Grid", "LevelIndicator", "Cell", "LayoutArea", "LayoutItem", "Handle", "Stepper", "Tab", "TouchBar",
        "StatusItem"]

    static func typeName(_ raw: UInt) -> String { "XCUIElementType" + (raw < types.count ? types[Int(raw)] : "Other") }

    /// On screen, roughly: WebDriverAgent also checks what covers an element, but counting too much as visible only makes
    /// the server's lock-screen checks stricter.
    static func visible(_ n: Node, _ screen: CGRect) -> Bool {
        n.frame.width > 0 && n.frame.height > 0 && n.frame.intersects(screen)
    }

    static func attributes(_ n: Node, _ screen: CGRect) -> [String: Any] {
        let f = n.frame
        return ["type": typeName(n.type), "name": n.name, "label": n.label, "value": n.value, "enabled": n.enabled,
                "visible": visible(n, screen), "x": num(f.minX), "y": num(f.minY), "width": num(f.width), "height": num(f.height)]
    }

    static func flat(_ n: Node) -> [Node] { [n] + n.children.flatMap(flat) }

    /// The elements an NSPredicate over `attributes` matches; nil (with why) for a predicate that won't parse or evaluate.
    static func find(_ root: Node, _ format: String, _ screen: CGRect) -> ([Node]?, String?) {
        var error: NSString?, found: [Node]?
        _ = HiveTry({
            let p = NSPredicate(format: format)
            found = flat(root).filter { p.evaluate(with: attributes($0, screen)) }
            return nil
        }, &error)
        return (error == nil ? found : nil, error as String?)
    }

    /// The page source WebDriverAgent serves for GET /source.
    static func xml(_ root: Node, _ screen: CGRect) -> String {
        var out = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<AppiumAUT>"
        func add(_ n: Node, _ index: Int) {
            let tag = typeName(n.type), f = n.frame
            let a: [(String, String)] = [("type", tag), ("name", n.name), ("label", n.label), ("value", n.value),
                ("enabled", "\(n.enabled)"), ("visible", "\(visible(n, screen))"), ("x", "\(num(f.minX))"), ("y", "\(num(f.minY))"),
                ("width", "\(num(f.width))"), ("height", "\(num(f.height))"), ("index", "\(index)")]
            out += "<\(tag)"
            for (k, v) in a { out += " \(k)=\"\(escape(v))\"" }
            if n.children.isEmpty { out += "/>"; return }
            out += ">"
            for (i, c) in n.children.enumerated() { add(c, i) }
            out += "</\(tag)>"
        }
        add(root, 0)
        return out + "</AppiumAUT>"
    }

    static func escape(_ s: String) -> String {
        var o = ""
        for c in s {
            switch c {
            case "&": o += "&amp;"
            case "<": o += "&lt;"
            case ">": o += "&gt;"
            case "\"": o += "&quot;"
            case "\n": o += "&#10;"
            default: o.append(c)
            }
        }
        return o
    }

    private static func num(_ x: CGFloat) -> Int { x.isFinite ? Int(x.rounded()) : 0 }
}
