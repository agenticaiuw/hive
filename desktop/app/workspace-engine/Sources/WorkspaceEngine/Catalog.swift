// The engine's MCP tools: names, what they do and their arguments. Hive's bridge passes the agent
// only the ones on its allowlist (crates/hive/hive-workspace/src/bridge.rs ALLOWED_TOOLS) and uses
// the session ones itself.
import Foundation
import WorkspaceCore

public enum MCP {
    public static func text(_ text: String) -> [String: Any] {
        ["content": [["type": "text", "text": text]]]
    }

    public static func failure(_ error: WorkspaceError) -> [String: Any] {
        ["content": [["type": "text", "text": error.description]], "isError": true]
    }
}

public enum Catalog {
    /// Tools that change something in the workspace; they refuse while input is paused.
    public static let actions: Set<String> = [
        "workspace_launch_app", "workspace_visit_url", "workspace_attach_target", "workspace_click",
        "workspace_scroll", "workspace_select_text", "workspace_move", "workspace_drag", "workspace_type",
        "workspace_press_key",
    ]

    static let session: [String: Any] = ["type": "string", "description": "The session's name."]
    static let app: [String: Any] = ["type": "string", "description": "Which of the workspace's apps, by name or bundle id. Default: the one last launched or used."]

    static func schema(_ properties: [String: Any], required: [String] = []) -> [String: Any] {
        var all = properties
        all["session"] = session
        return ["type": "object", "properties": all, "required": ["session"] + required, "additionalProperties": false]
    }

    static func number(_ description: String) -> [String: Any] { ["type": "number", "description": description] }
    static func string(_ description: String) -> [String: Any] { ["type": "string", "description": description] }
    static func boolean(_ description: String) -> [String: Any] { ["type": "boolean", "description": description] }

    public static let tools: [[String: Any]] = [
        ["name": "workspace_session_list",
         "description": "List workspace sessions: the display, its size, whether input is paused, and the apps in it.",
         "inputSchema": ["type": "object", "properties": [:] as [String: Any], "additionalProperties": false]],
        ["name": "workspace_session_create",
         "description": "Create the workspace: a display of its own, out of the user's way, that only the agent's apps use.",
         "inputSchema": ["type": "object", "properties": [
            "name": string("The session's name."), "title": string("A title shown to the user."),
            "preset": string("\"exclusive\": the whole display is the session's."),
            "orphan_grace_seconds": number("How long the session waits for a client to claim it after its holder leaves."),
            "ttl_seconds": number("How long the holder's lease lasts without renewal."),
            "width": number("Width in points (800-2560, default 1440)."),
            "height": number("Height in points (600-1600, default 900)."),
         ] as [String: Any], "required": ["name"], "additionalProperties": false]],
        ["name": "workspace_session_claim",
         "description": "Take over an existing session whose previous holder has gone.",
         "inputSchema": schema([:])],
        ["name": "workspace_session_destroy",
         "description": "End the session: its apps are hidden and asked to quit, then its display goes away.",
         "inputSchema": schema([:])],
        ["name": "workspace_launch_app",
         "description": "Open an app in the workspace, as a separate copy where the app allows it. Chrome-family browsers open as the workspace's own browser with a private profile, not the user's.",
         "inputSchema": schema(["app": string("App name (\"TextEdit\"), bundle id or path to the .app.")], required: ["app"])],
        ["name": "workspace_visit_url",
         "description": "Open a web page in a new tab of the workspace's own browser (a private profile, not the user's signed-in one).",
         "inputSchema": schema(["url": string("An http or https URL.")], required: ["url"])],
        ["name": "workspace_wait_for",
         "description": "Wait until text appears on (or, with gone, leaves) the workspace's windows.",
         "inputSchema": schema(["text": string("Text to wait for, case-insensitive."), "app": app,
                                "gone": boolean("Wait for the text to disappear instead."),
                                "timeout_seconds": number("At most this long (default 10, max 30).")], required: ["text"])],
        ["name": "workspace_find",
         "description": "Find controls and text whose label or value contains the text. Returns each one's role, label and centre point.",
         "inputSchema": schema(["text": string("Text to look for, case-insensitive."), "app": app,
                                "limit": number("At most this many (default 20).")], required: ["text"])],
        ["name": "workspace_read_text",
         "description": "Read the text in an app's front window in the workspace, top to bottom.",
         "inputSchema": schema(["app": app, "max_chars": number("At most this many characters (default 8000).")])],
        ["name": "workspace_read_screen",
         "description": "An outline of an app's front window: each control's role, label, position and size, and what it can do.",
         "inputSchema": schema(["app": app, "max_nodes": number("At most this many controls (default 300).")])],
        ["name": "workspace_list_targets",
         "description": "List the tabs of the workspace's own browser.",
         "inputSchema": schema([:])],
        ["name": "workspace_attach_target",
         "description": "Bring one of the workspace browser's tabs to the front, by the id workspace_list_targets gave.",
         "inputSchema": schema(["target": string("The tab's id.")], required: ["target"])],
        ["name": "workspace_screenshot",
         "description": "A picture of the whole workspace. Its coordinates are the points every other tool uses, from the top-left corner.",
         "inputSchema": schema(["format": string("\"jpeg\" (default) or \"png\".")])],
        ["name": "workspace_click",
         "description": "Click at a point, or on the control whose label contains `text`. Presses buttons through accessibility when it can; otherwise the click goes to that app alone, and the user's pointer never moves.",
         "inputSchema": schema(["x": number("Points from the left."), "y": number("Points from the top."),
                                "text": string("Click the first control whose label contains this, instead of a point."),
                                "app": app, "button": string("\"left\" (default) or \"right\"."),
                                "count": number("1 (default) or 2 for a double click.")])],
        ["name": "workspace_scroll",
         "description": "Scroll at a point, in lines: dy positive scrolls down, dx positive scrolls right.",
         "inputSchema": schema(["x": number("Points from the left."), "y": number("Points from the top."),
                                "dx": number("Lines to the right."), "dy": number("Lines down.")], required: ["x", "y"])],
        ["name": "workspace_select_text",
         "description": "Select text: the first match of `text` in the focused text field, or a drag from one point to another.",
         "inputSchema": schema(["text": string("Text to select in the focused field."), "app": app,
                                "from_x": number("Drag start, from the left."), "from_y": number("Drag start, from the top."),
                                "to_x": number("Drag end, from the left."), "to_y": number("Drag end, from the top.")])],
        ["name": "workspace_move",
         "description": "Move the workspace's pointer to a point, to hover. The user's own pointer doesn't move.",
         "inputSchema": schema(["x": number("Points from the left."), "y": number("Points from the top.")], required: ["x", "y"])],
        ["name": "workspace_drag",
         "description": "Drag from one point to another with the left button.",
         "inputSchema": schema(["from_x": number("Start, from the left."), "from_y": number("Start, from the top."),
                                "to_x": number("End, from the left."), "to_y": number("End, from the top.")],
                               required: ["from_x", "from_y", "to_x", "to_y"])],
        ["name": "workspace_type",
         "description": "Type text into the focused field of an app in the workspace.",
         "inputSchema": schema(["text": string("What to type."), "app": app,
                                "replace": boolean("Replace the field's whole contents instead of inserting.")], required: ["text"])],
        ["name": "workspace_press_key",
         "description": "Press a key or chord, such as \"return\", \"tab\", \"escape\", \"cmd+s\" or \"shift+cmd+t\".",
         "inputSchema": schema(["key": string("The key, with modifiers joined by +."), "app": app], required: ["key"])],
        ["name": "workspace_list_windows",
         "description": "The workspace apps' windows: id, app, title, position and size, and whether each is on the workspace.",
         "inputSchema": schema([:])],
        ["name": "workspace_events",
         "description": "What the workspace engine did recently: each tool, when, and whether it worked.",
         "inputSchema": schema(["limit": number("How many (default 30).")])],
        ["name": "workspace_verify_isolation",
         "description": "Check that the workspace is staying out of the user's way: who owns the menu bar and the keyboard, and where the user's pointer is.",
         "inputSchema": schema([:])],
    ]

    public static var names: [String] { tools.compactMap { $0["name"] as? String } }
}
