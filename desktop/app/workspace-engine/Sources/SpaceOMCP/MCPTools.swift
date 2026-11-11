import Foundation
import SpaceOKit

private typealias MCPInputError = MCPServer.MCPInputError

/// One MCP tool: what `tools/list` advertises for it, which arguments it accepts, and how those
/// arguments become a daemon request. Everything about a tool lives in its entry below, so adding
/// or changing one is a single edit.
///
/// Every byte of a schema is paid by every agent on every connection, so descriptions stay under
/// 400 characters and say what a tool is for; budgets, queues and late-frame mechanics live in
/// the spaceo://docs resources. MCPCompactReceiptTests enforces the size.
struct MCPTool {
    let name: String
    let description: String
    /// The tool's own advertised arguments; review and presentation arguments are added to them.
    let properties: [String: Any]
    let required: [String]
    /// Review arguments shared across tools (`strict`, `require_isolation`, `geometry`, …), whose
    /// schemas come from `reviewFieldSchema`.
    let review: Set<String>
    /// The successful receipt can carry fresh indices (`observe`).
    let observes: Bool
    /// The result carries a receipt worth expanding, so `verbose` is accepted.
    let hasReceipt: Bool
    /// `verbose` is accepted by every tool with a receipt but advertised only where the expanded
    /// receipt is worth reading (actions and observations): every schema byte costs every agent.
    let advertisesVerbose: Bool
    /// `require_isolation` is advertised once, on spaceo_verify_isolation, and documented in the
    /// playbook for the acting tools that also accept it; `strict` covers the common case.
    let advertisesRequireIsolation: Bool
    /// Accepted for compatibility but never advertised.
    let compatibilityArguments: Set<String>
    /// May run inside spaceo_run_steps.
    let batchable: Bool
    /// The result is the daemon's in-memory PNG, returned as MCP image content.
    let returnsImage: Bool
    let translate: (inout MCPToolCall) throws -> Void

    init(
        _ name: String,
        _ description: String,
        _ properties: [String: Any] = [:],
        required: [String] = [],
        review: Set<String> = [],
        observes: Bool = false,
        hasReceipt: Bool = true,
        advertisesVerbose: Bool = true,
        advertisesRequireIsolation: Bool = false,
        compatibilityArguments: Set<String> = [],
        batchable: Bool = false,
        returnsImage: Bool = false,
        translate: @escaping (inout MCPToolCall) throws -> Void
    ) {
        self.name = name
        self.description = description
        self.properties = properties
        self.required = required
        self.review = review
        self.observes = observes
        self.hasReceipt = hasReceipt
        self.advertisesVerbose = advertisesVerbose
        self.advertisesRequireIsolation = advertisesRequireIsolation
        self.compatibilityArguments = compatibilityArguments
        self.batchable = batchable
        self.returnsImage = returnsImage
        self.translate = translate
    }

    /// MCP-side presentation arguments (`verbose`, `observe`). They shape the tool result and are
    /// never sent to the daemon.
    var presentationArguments: Set<String> {
        var fields: Set<String> = hasReceipt ? ["verbose"] : []
        if observes { fields.insert("observe") }
        return fields
    }

    var unadvertisedArguments: Set<String> {
        var fields = compatibilityArguments
        if !advertisesVerbose { fields.insert("verbose") }
        if !advertisesRequireIsolation { fields.insert("require_isolation") }
        return fields
    }

    var acceptedArguments: Set<String> {
        Set(properties.keys).union(review).union(presentationArguments).union(compatibilityArguments)
    }

    var advertisedArguments: Set<String> { acceptedArguments.subtracting(unadvertisedArguments) }

    var schema: [String: Any] {
        var enrichedProperties = properties
        for field in review.subtracting(unadvertisedArguments) {
            enrichedProperties[field] = Self.reviewFieldSchema(field)
        }
        for field in presentationArguments.subtracting(unadvertisedArguments) {
            enrichedProperties[field] = Self.presentationFieldSchema(field)
        }
        var inputSchema: [String: Any] = [
            "type": "object",
            "properties": enrichedProperties,
            "additionalProperties": false,
        ]
        if !required.isEmpty { inputSchema["required"] = required }
        return ["name": name, "description": description, "inputSchema": inputSchema]
    }

    static let named: [String: MCPTool] = Dictionary(
        uniqueKeysWithValues: catalogue.map { ($0.name, $0) })

    static let observingNames = Set(catalogue.filter(\.observes).map(\.name))

    static let batchableNames = Set(catalogue.filter(\.batchable).map(\.name))

    static func presentationFieldSchema(_ key: String) -> [String: Any] {
        switch key {
        case "observe":
            return ["type": "string", "enum": MCPCallOptions.Observe.allCases.map(\.rawValue),
                    "description": "Append fresh indices after success (default diff)."]
        default:
            return ["type": "boolean", "description": "Full receipts."]
        }
    }

    private static func reviewFieldSchema(_ key: String) -> [String: Any] {
        switch key {
        case "pid": return ["type": "integer", "minimum": 1, "maximum": Int32.max, "description": "Only windows of this session-owned process."]
        case "label": return ["type": "string", "maxLength": AXLabelMatcher.maximumTextBytes, "description": "Press the one element with this exact accessible label."]
        case "match": return ["type": "string", "enum": labelMatchModes, "description": "With label: exact (default) or contains."]
        case "role": return ["type": "string", "maxLength": 64, "description": "With label: only this role, e.g. Button."]
        case "require_isolation": return ["type": "array", "minItems": 1, "maxItems": IsolationDimension.allCases.count, "items": ["type": "string", "enum": IsolationDimension.allCases.map(\.rawValue)],
                                          "description": "Fail unless these checks are observable."]
        case "strict": return ["type": "boolean", "description": "Refuse unless every isolation check is observable."]
        case "allow_no_windows": return ["type": "boolean", "description": "Accept a confirmed zero window count."]
        case "require_window": return ["type": "boolean", "description": "Report a session with no window as unhealthy."]
        case "keep_apps": return ["type": "boolean", "description": "Leave the apps running instead of quitting them."]
        case "timeout": return ["type": "number", "minimum": 0.5, "maximum": 120, "description": "Seconds to wait for a window."]
        case "duration": return ["type": "number", "minimum": 0.05, "maximum": 30, "description": "Drag duration in seconds."]
        case "arguments": return ["type": "array", "maxItems": 128, "items": ["type": "string", "maxLength": 4096], "description": "Extra launch arguments."]
        default: return ["type": "string", "maxLength": 128, "description": "Receipt from your latest read; stale refuses."]
        }
    }

    // Shared argument schemas.

    static let labelMatchModes = AXLabelMatcher.Mode.allCases.map(\.rawValue)

    static let modifierNames = ["cmd", "shift", "alt", "ctrl", "fn"]

    private static let ttlRange = SessionReclamationPolicy.clientTTLRange

    private static let graceRange = SessionReclamationPolicy.orphanGraceRange

    private static let sessionArg: [String: Any] = [
        "type": "string",
        "description": "Omit to use the session this connection created.",
    ]

    private static let windowArg: [String: Any] = [
        "type": "integer",
        "minimum": 1,
        "maximum": UInt32.max,
        "description": "Window id; omit for the [default] window.",
    ]

    private static let webPointArg: [String: Any] = [
        "type": "boolean",
        "description": "x/y are CSS viewport coordinates (as beside wN).",
    ]

    private static let modifiersArg: [String: Any] = [
        "type": "array",
        "maxItems": modifierNames.count,
        "items": ["type": "string", "enum": modifierNames],
        "description": "Keys held during the action.",
    ]

    private static let buttonArg: [String: Any] = [
        "type": "string", "enum": MouseButton.allCases.map(\.rawValue),
        "description": "Mouse button (default left).",
    ]
}

/// One tool call being translated: the model-supplied arguments, the request built from them,
/// and the bounded readers every tool's translation uses. Readers never trap on a numeric cast.
struct MCPToolCall {
    let arguments: [String: Any]
    let defaultControllerOwner: DurableSessionOwner?
    var request = Request(cmd: "")

    init(arguments: [String: Any], defaultControllerOwner: DurableSessionOwner?) {
        self.arguments = arguments
        self.defaultControllerOwner = defaultControllerOwner
    }

    /// Translate with the arguments shared by every tool around the tool's own translation.
    mutating func translate(with tool: MCPTool) throws {
        request.session = try sessionID("session")
        request.window = try window()
        // Presentation arguments never reach the daemon; validate them here so a typo is
        // refused like any other argument instead of silently changing nothing.
        _ = try flag("verbose")
        if let observe = try str("observe", max: 8), MCPCallOptions.Observe(rawValue: observe) == nil {
            throw MCPInputError.invalid("'observe' must be none, diff or full")
        }
        try tool.translate(&self)
        request.strictIsolation = try flag("strict")
        if let raw = arguments["require_isolation"], !(raw is NSNull) {
            guard let names = raw as? [String], !names.isEmpty, names.count <= IsolationDimension.allCases.count else { throw MCPInputError.invalid("require_isolation needs 1 through \(IsolationDimension.allCases.count) dimension names") }
            request.requiredIsolation = try names.map {
                guard let value = IsolationDimension(rawValue: $0) else { throw MCPInputError.invalid("unknown isolation dimension") }
                return value
            }
        }
        request.requireWindow = try flag("require_window")
        request.allowNoWindows = try flag("allow_no_windows")
        request.timeout = try dbl("timeout")
        request.duration = try dbl("duration")
        request.snapshotID = try str("snapshot", max: 128)
        request.label = try str("label", max: AXLabelMatcher.maximumTextBytes)
        request.geometryToken = try str("geometry", max: 128)
        if let supplied = arguments["arguments"], !(supplied is NSNull) {
            guard let values = supplied as? [String] else { throw MCPInputError.invalid("arguments must be strings") }
            try LaunchOptions.validate(arguments: values, timeout: request.timeout ?? 15)
            request.arguments = values
        }
    }

    func supplied(_ key: String) -> Any? {
        guard let value = arguments[key], !(value is NSNull) else { return nil }
        return value
    }
    func str(_ key: String, max: Int = 4_096, maxBytes: Int? = nil) throws -> String? {
        guard let value = supplied(key) else { return nil }
        guard let string = value as? String else {
            throw MCPInputError.invalid("'\(key)' must be a string")
        }
        let byteLimit = maxBytes ?? max * 4
        guard string.utf8.count <= byteLimit, string.count <= max else {
            throw MCPInputError.invalid(
                "'\(key)' is too long (maximum \(max) characters and "
                + "\(byteLimit) UTF-8 bytes)")
        }
        return string
    }
    func sessionID(_ key: String) throws -> String? {
        guard let rawValue = supplied(key) else { return nil }
        guard let value = rawValue as? String else {
            throw MCPInputError.invalid("'\(key)' must be a string")
        }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty,
              !trimmed.contains("/"), !trimmed.contains("\\"),
              value.unicodeScalars.allSatisfy({
                  !CharacterSet.controlCharacters.contains($0)
              }) else {
            throw MCPInputError.invalid(
                "'\(key)' must not be empty or contain control characters "
                + "or path separators")
        }
        guard trimmed.utf8.count <= SessionManager.maximumSessionIDBytes,
              trimmed.count <= SessionManager.maximumSessionIDCharacters else {
            throw MCPInputError.invalid(
                "'\(key)' must be at most \(SessionManager.maximumSessionIDCharacters) "
                + "characters and \(SessionManager.maximumSessionIDBytes) UTF-8 bytes")
        }
        return trimmed
    }
    func int(_ key: String) throws -> Int? {
        guard let value = supplied(key) else { return nil }
        guard !MCPServer.isJSONBoolean(value) else {
            throw MCPInputError.invalid("'\(key)' must be an integer")
        }
        if let integer = value as? Int { return integer }
        if let number = value as? NSNumber,
           let exact = Int(exactly: number.doubleValue) {
            return exact
        }
        throw MCPInputError.invalid("'\(key)' must be an integer")
    }
    func dbl(_ key: String) throws -> Double? {
        guard let value = supplied(key) else { return nil }
        guard !MCPServer.isJSONBoolean(value), let number = value as? NSNumber else {
            throw MCPInputError.invalid("'\(key)' must be a finite number")
        }
        let double = number.doubleValue
        guard double.isFinite else {
            throw MCPInputError.invalid("'\(key)' must be a finite number")
        }
        return double
    }
    func flag(_ key: String) throws -> Bool? {
        guard let value = supplied(key) else { return nil }
        guard MCPServer.isJSONBoolean(value), let boolean = value as? Bool else {
            throw MCPInputError.invalid("'\(key)' must be a boolean")
        }
        return boolean
    }
    func window() throws -> UInt32? {
        guard let raw = try int("window") else { return nil }
        guard raw > 0, let value = UInt32(exactly: raw) else {
            throw MCPInputError.invalid("'window' must be an integer from 1 through \(UInt32.max)")
        }
        return value
    }
    func validatePointerButton(_ raw: String?) throws {
        guard let raw else { return }
        guard MouseButton(rawValue: raw) != nil else {
            throw MCPInputError.invalid("'button' must be 'left', 'right', or 'middle'")
        }
    }
    func modifiers() throws -> [String]? {
        guard let value = supplied("modifiers") else { return nil }
        guard let list = value as? [Any], list.count <= MCPTool.modifierNames.count else {
            throw MCPInputError.invalid(
                "'modifiers' must be an array of at most \(MCPTool.modifierNames.count) modifier names")
        }
        return try list.map { item in
            guard let name = item as? String, name.count <= 16 else {
                throw MCPInputError.invalid(
                    "'modifiers' entries must be strings of at most 16 characters")
            }
            return name
        }
    }
    func int32(_ key: String) throws -> Int32? {
        guard let raw = try int(key) else { return nil }
        guard let value = Int32(exactly: raw) else {
            throw MCPInputError.invalid(
                "'\(key)' must be an integer from -10000 through 10000")
        }
        return value
    }
    func files() throws -> [String]? {
        guard let value = supplied("files") else { return nil }
        guard let list = value as? [Any], list.count <= 256 else {
            throw MCPInputError.invalid("'files' must be an array of at most 256 paths")
        }
        return try list.map { item in
            guard let path = item as? String,
                  path.utf8.count <= 16_384,
                  path.count <= 4_096 else {
                throw MCPInputError.invalid(
                    "every file path must be a string of at most 4096 characters "
                    + "and 16384 UTF-8 bytes")
            }
            return path
        }
    }
    func controllerText(_ key: String, fallback: String) throws -> String {
        let value = try str(key, max: 256, maxBytes: 256) ?? fallback
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard value == trimmed, !trimmed.isEmpty,
              value.unicodeScalars.allSatisfy({
                  !CharacterSet.controlCharacters.contains($0)
              }) else {
            throw MCPInputError.invalid(
                "'\(key)' must be trimmed, non-empty, and contain no control characters")
        }
        return value
    }
    func controllerKind(
        _ key: String,
        fallback: DurableSessionOwnerKind
    ) throws -> DurableSessionOwnerKind {
        guard let raw = try str(key, max: 16, maxBytes: 16) else { return fallback }
        guard let kind = DurableSessionOwnerKind(rawValue: raw) else {
            throw MCPInputError.invalid(
                "'\(key)' must be one of cli, mcp, viewer, or other")
        }
        return kind
    }
}

// MARK: - spaceo_place_window

extension MCPTool {
    static let placeWindow = MCPTool(
        "spaceo_place_window", "Place an owned window using preserve, fit or cover policy. Cover requires an exclusive display.", [
            "session": sessionArg, "window": windowArg,
            "placement": ["type": "string", "enum": ["preserve", "fit", "cover"],
                          "description": "preserve keeps the frame, fit shrinks into the tile, cover fills an exclusive display."]],
             required: ["window", "placement"],
        review: ["strict", "require_isolation"]
    ) { try $0.placeWindow() }
}

extension MCPToolCall {
    mutating func placeWindow() throws {
        request.cmd = "place"
        request.placement = try str("placement", max: 16)
    }
}

// MARK: - spaceo_adopt_app

extension MCPTool {
    static let adoptApp = MCPTool(
        "spaceo_adopt_app", "Adopt this exact running process into the session (no bundle-wide matching).", [
            "session": sessionArg,
            "pid": ["type": "integer", "minimum": 1, "description": "Process id of the running app."]], required: ["pid"],
        review: ["allow_no_windows", "strict", "require_isolation"]
    ) { try $0.adoptApp() }
}

extension MCPToolCall {
    mutating func adoptApp() throws {
        request.cmd = "adopt"
        guard let pid = try int("pid"), pid > 0, let exact = Int32(exactly: pid) else {
            throw MCPInputError.invalid("pid must be a positive Int32")
        }
        request.pid = exact
    }
}

// MARK: - spaceo_session_pause

extension MCPTool {
    static let sessionPause = MCPTool(
        "spaceo_session_pause", """
            Park this session and refuse agent input. Give a reason when you need a person \
            ("needs 2FA code"); the Viewer shows it with a Take Control button.
            """, ["session": sessionArg,
                  "reason": ["type": "string", "maxLength": AgentSession.maximumPauseReasonCharacters, "description": "Why the agent stopped; shown to the human."]],
        advertisesVerbose: false
    ) { try $0.sessionControl(paused: true) }
}

// MARK: - spaceo_session_resume

extension MCPTool {
    static let sessionResume = MCPTool(
        "spaceo_session_resume", "Lift a pause you set with spaceo_session_pause. An operator pause is released only by the operator.",
             ["session": sessionArg],
        advertisesVerbose: false
    ) { try $0.sessionControl(paused: false) }
}

extension MCPToolCall {
    mutating func sessionControl(paused: Bool) throws {
        request.cmd = "session.control"
        request.paused = paused
        request.reason = try str("reason", max: AgentSession.maximumPauseReasonCharacters)
    }
}

// MARK: - spaceo_session_create

extension MCPTool {
    static let sessionCreate = MCPTool(
        "spaceo_session_create", """
            Create an agent session (a tile on a SpaceO virtual display) once, before opening \
            apps. This connection keeps its lease secret and renewed; tools that omit session \
            use it.
            """, [
                "name": ["type": "string", "description": "Session id; generated when omitted."],
                "ttl_seconds": ["type": "number", "minimum": Int(ttlRange.lowerBound), "maximum": Int(ttlRange.upperBound),
                                "description": "Lease lifetime; renewed automatically while connected."],
                "app": ["type": "string", "maxLength": 4_096,
                        "description": "Also launch this app (as spaceo_open_app)."],
                "files": ["type": "array", "maxItems": 256, "items": ["type": "string", "maxLength": 4_096],
                          "description": "Files for the launched app to open."],
                "preset": ["type": "string", "enum": DisplayPool.presets,
                           "description": "shared (default) takes a tile; exclusive* a whole display."],
                "title": ["type": "string", "maxLength": AgentSession.maximumTitleCharacters,
                          "description": "Task title shown in the Viewer."],
                "record": ["type": "string", "enum": RecordingMode.allCases.map(\.rawValue),
                           "description": "Record receipts; +frames adds images that may show typed text."],
                "mute_audio": ["type": "boolean", "description": "Launch a managed Chromium muted."],
                "orphan_grace_seconds": ["type": "number", "minimum": Int(graceRange.lowerBound), "maximum": Int(graceRange.upperBound),
                                         "description": "If this connection ends, seconds the session keeps its apps for spaceo_session_claim. Default \(Int(MCPServer.defaultOrphanGraceSeconds))."],
            ],
        compatibilityArguments: ["session", "controller_id", "controller_label", "controller_kind"]
    ) { try $0.sessionCreate() }
}

extension MCPToolCall {
    mutating func sessionCreate() throws {
        request.cmd = "session.create"
        // `session` is what every other tool calls the id, so models reach for it here too.
        if supplied("name") != nil, supplied("session") != nil {
            throw MCPInputError.invalid("use either 'name' or 'session' for the new session id, not both")
        }
        request.session = try sessionID("name") ?? request.session
        if let defaultControllerOwner {
            request.controllerOwner = DurableSessionOwner(
                id: try controllerText(
                    "controller_id",
                    fallback: defaultControllerOwner.id
                ),
                kind: try controllerKind(
                    "controller_kind",
                    fallback: defaultControllerOwner.kind
                ),
                label: try controllerText(
                    "controller_label",
                    fallback: defaultControllerOwner.label
                ),
                processIdentity: defaultControllerOwner.processIdentity
            )
        } else if supplied("controller_id") != nil
                    || supplied("controller_label") != nil
                    || supplied("controller_kind") != nil {
            throw MCPInputError.invalid(
                "controller identity overrides require an MCP controller context")
        }
        request.controllerTTLSeconds = try dbl("ttl_seconds")
        let ttlRange = SessionReclamationPolicy.clientTTLRange
        if let ttl = request.controllerTTLSeconds, !ttlRange.contains(ttl) {
            throw MCPInputError.invalid(
                "'ttl_seconds' must be from \(Int(ttlRange.lowerBound)) through \(Int(ttlRange.upperBound))")
        }
        request.app = try str("app")
        request.files = try files()
        if request.app == nil, request.files != nil {
            throw MCPInputError.invalid("'files' needs 'app'")
        }
        request.preset = try str("preset", max: 32)
        if let preset = request.preset, !DisplayPool.presets.contains(preset) {
            throw MCPInputError.invalid("'preset' must be " + alternatives(DisplayPool.presets))
        }
        request.title = try str("title", max: AgentSession.maximumTitleCharacters)
        request.record = try str("record", max: 16)
        if let record = request.record, RecordingMode(rawValue: record) == nil {
            throw MCPInputError.invalid("'record' must be " + alternatives(RecordingMode.allCases.map(\.rawValue)))
        }
        request.muteAudio = try flag("mute_audio")
        request.orphanGraceSeconds = try dbl("orphan_grace_seconds") ?? MCPServer.defaultOrphanGraceSeconds
        let graceRange = SessionReclamationPolicy.orphanGraceRange
        if let grace = request.orphanGraceSeconds, !graceRange.contains(grace) {
            throw MCPInputError.invalid("'orphan_grace_seconds' must be from \(Int(graceRange.lowerBound)) through \(Int(graceRange.upperBound))")
        }
    }
}

// MARK: - spaceo_session_claim

extension MCPTool {
    static let sessionClaim = MCPTool(
        "spaceo_session_claim", """
            Take over an abandoned session (its controller exited, e.g. your own before this \
            client restarted), keeping its apps and windows. Works only within its grace \
            period; a live session is refused with who holds it. This connection keeps the \
            new lease. Leases coordinate agents; they are not a security boundary. Re-read \
            the screen after claiming.
            """, ["session": ["type": "string", "description": "The session id to claim, e.g. from spaceo_session_list."]],
            required: ["session"]
    ) { try $0.sessionClaim() }
}

extension MCPToolCall {
    mutating func sessionClaim() throws {
        request.cmd = "session.claim"
        guard request.session != nil else {
            throw MCPInputError.invalid("'session' is required: claim never picks a session for you")
        }
        // The claimed session gets the same protection a session created here would have.
        request.orphanGraceSeconds = 1800
    }
}

// MARK: - spaceo_session_list

extension MCPTool {
    static let sessionList = MCPTool(
        "spaceo_session_list",
             "List agent sessions with displays, tiles, apps and windows. [yours] marks sessions this connection created; other controllers' contents are redacted.",
        hasReceipt: false
    ) { try $0.sessionList() }
}

extension MCPToolCall {
    mutating func sessionList() throws {
        request.cmd = "session.list"
    }
}

// MARK: - spaceo_session_heartbeat

extension MCPTool {
    static let sessionHeartbeat = MCPTool(
        "spaceo_session_heartbeat",
             "Renew the lease without acting. Rarely needed: leases renew every 10 s while connected.",
             ["session": sessionArg],
        hasReceipt: false
    ) { try $0.sessionHeartbeat() }
}

extension MCPToolCall {
    mutating func sessionHeartbeat() throws {
        request.cmd = "session.heartbeat"
    }
}

// MARK: - spaceo_session_destroy

extension MCPTool {
    static let sessionDestroy = MCPTool(
        "spaceo_session_destroy", """
            End a session: quit its apps and free its tile. Always do this when finished. If \
            cleanup reports survivors, resolve them and call again (safe). Only ends sessions \
            this connection created.
            """, ["session": sessionArg,
                  "all": ["type": "boolean",
                          "description": "Destroy every session this connection created; other agents' are untouched."]],
        review: ["keep_apps"]
    ) { try $0.sessionDestroy() }
}

extension MCPToolCall {
    mutating func sessionDestroy() throws {
        request.cmd = "session.destroy"
        request.quitApps = try flag("keep_apps").map { !$0 }
        request.full = try flag("all")
        if request.session != nil, request.full == true {
            throw MCPInputError.invalid("use either 'session' or 'all', not both")
        }
    }
}

// MARK: - spaceo_open_app

extension MCPTool {
    static let openApp = MCPTool(
        "spaceo_open_app", """
            Launch an app (name, bundle id or path, plus optional files) into the session's \
            tile without activating it. Reuses the session's running instance unless \
            new_instance=true. Web pages: spaceo_open_url.
            """, ["app": ["type": "string", "maxLength": 4_096, "description": "App name, bundle id, or .app path."],
                  "files": ["type": "array", "maxItems": 256, "items": ["type": "string", "maxLength": 4_096],
                            "description": "File paths to open."],
                  "new_instance": ["type": "boolean", "description": "Launch even if the session already runs this app."],
                  "mute_audio": ["type": "boolean", "description": "Managed Chromium only: launch muted."],
                  "session": sessionArg],
             required: ["app"],
        review: ["allow_no_windows", "timeout", "arguments", "strict", "require_isolation"]
    ) { try $0.openApp() }
}

extension MCPToolCall {
    mutating func openApp() throws {
        request.cmd = "run"
        request.app = try str("app")
        request.files = try files()
        request.newInstance = try flag("new_instance")
        request.muteAudio = try flag("mute_audio")
        guard let app = request.app, !app.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw MCPInputError.invalid("'app' is required")
        }
    }
}

// MARK: - spaceo_open_url

extension MCPTool {
    static let openURL = MCPTool(
        "spaceo_open_url", """
            Open a URL in the session's managed Chromium (launched if needed) via DevTools, \
            wait for the load, and bind web reads and actions to that page. Returns title, \
            final_url, target_id and load. Don't type into the address bar instead.
            """, ["url": ["type": "string", "maxLength": 8_192, "description": "http(s) URL to open."],
                  "new_tab": ["type": "boolean", "description": "Open in a new tab instead of navigating the bound page."],
                  "timeout": ["type": "number", "minimum": 0.5, "maximum": 60, "description": "Load wait in seconds; a timeout is reported, not an error."],
                  "mute_audio": ["type": "boolean", "description": "If a browser must be launched, mute it."],
                  "session": sessionArg,
                  "window": windowArg],
             required: ["url"]
    ) { try $0.openURL() }
}

extension MCPToolCall {
    mutating func openURL() throws {
        request.cmd = "open.url"
        request.url = try str("url", max: 8_192, maxBytes: 8_192)
        request.newTab = try flag("new_tab")
        request.muteAudio = try flag("mute_audio")
        guard let url = request.url?.trimmingCharacters(in: .whitespacesAndNewlines), !url.isEmpty,
              let parsed = URL(string: url), let scheme = parsed.scheme?.lowercased(),
              ["http", "https", "file", "about"].contains(scheme) else {
            throw MCPInputError.invalid("'url' must be an http(s), file or about URL")
        }
    }
}

// MARK: - spaceo_wait_for

extension MCPTool {
    static let waitFor = MCPTool(
        "spaceo_wait_for", """
            Wait (up to 60 s) for a condition instead of polling: element_label, element_gone, \
            window_title_contains, web_selector, web_title_contains, stable_ms (pixels still \
            for N ms), ms, or session_resumed (a human's pause is lifted; works while paused, \
            returns their note). Labels match the accessible name. Returns what it saw \
            (index, title, snapshot id). A timeout is a normal outcome.
            """, ["condition": ["type": "string", "enum": WaitCondition.knownKinds,
                                "description": "What to wait for."],
                  "value": ["type": "string", "maxLength": WaitCondition.maximumValueBytes, "description": "The label, title fragment, selector, or millisecond count. Omit for session_resumed."],
                  "match": ["type": "string", "enum": labelMatchModes, "description": "Label matching: exact (default) or contains."],
                  "role": ["type": "string", "maxLength": 64, "description": "Only elements of this role, e.g. TextField."],
                  "timeout": ["type": "number", "minimum": 0.5, "maximum": 60, "description": "Budget in seconds, queueing included (default 15)."],
                  "session": sessionArg,
                  "window": windowArg],
             required: ["condition"],
        batchable: true
    ) { try $0.waitFor() }
}

extension MCPToolCall {
    mutating func waitFor() throws {
        request.cmd = "wait"
        request.waitCondition = try str("condition", max: 32)
        request.waitValue = try str("value", max: WaitCondition.maximumValueBytes)
        request.match = try str("match", max: 16)
        request.role = try str("role", max: 64)
        guard let condition = request.waitCondition,
              WaitCondition.knownKinds.contains(condition) else {
            throw MCPInputError.invalid("'condition' must be one of " + WaitCondition.knownKinds.joined(separator: ", "))
        }
        if request.waitValue == nil, condition != "session_resumed" {
            throw MCPInputError.invalid("'value' is required for condition '\(condition)'")
        }
        if let match = request.match, AXLabelMatcher.Mode(rawValue: match) == nil {
            throw MCPInputError.invalid("'match' must be " + alternatives(MCPTool.labelMatchModes))
        }
    }
}

// MARK: - spaceo_menu

extension MCPTool {
    static let menu = MCPTool(
        "spaceo_menu", """
            Use the menu bar of the session's app without activating it. No path lists the \
            top-level menus; a path such as ["File"] lists that menu (title, enabled, checked, \
            shortcut, submenu); press=true runs the item a full path names. The Apple and \
            Services menus are never available. Pressing is input and may open windows.
            """, ["path": ["type": "array", "maxItems": 6,
                           "items": ["type": "string", "maxLength": 256],
                           "description": "Menu titles from the top level down, e.g. [\"File\", \"Export as PDF…\"]."],
                  "press": ["type": "boolean", "description": "Press the item the path names."],
                  "pid": ["type": "integer", "minimum": 1, "maximum": Int32.max, "description": "Which of the session's apps; default: the app owning the default window."],
                  "session": sessionArg,
                  "window": windowArg]
    ) { try $0.menu() }
}

extension MCPToolCall {
    mutating func menu() throws {
        request.cmd = "menu"
        request.press = try flag("press")
        if let pid = try int("pid") {
            guard pid > 0, let exact = Int32(exactly: pid) else {
                throw MCPInputError.invalid("'pid' must be a positive Int32")
            }
            request.pid = exact
        }
        if let raw = supplied("path") {
            guard let list = raw as? [Any], list.count <= 6 else {
                throw MCPInputError.invalid("'path' must be an array of at most 6 menu titles")
            }
            request.menuPath = try list.map { item in
                guard let title = item as? String, !title.isEmpty,
                      title.count <= 256, title.utf8.count <= 1_024 else {
                    throw MCPInputError.invalid("every 'path' entry must be a non-empty title of at most 256 characters")
                }
                return title
            }
        }
        if request.press == true, (request.menuPath ?? []).isEmpty {
            throw MCPInputError.invalid("press needs a 'path' naming one menu item, e.g. [\"File\", \"New\"]")
        }
    }
}

// MARK: - spaceo_find

extension MCPTool {
    static let find = MCPTool(
        "spaceo_find", """
            Search the window's accessibility tree (and a managed browser's page) for \
            elements whose label, value or role contains query. Returns up to 25 native and \
            25 page hits with usable indices. A truncated search cannot prove absence.
            """, ["query": ["type": "string", "maxLength": AXLabelMatcher.maximumTextBytes, "description": "Case-insensitive text to find."],
                  "role": ["type": "string", "maxLength": 64, "description": "Native role filter, e.g. Button; skips page search."],
                  "session": sessionArg,
                  "window": windowArg],
             required: ["query"],
        batchable: true
    ) { try $0.find() }
}

extension MCPToolCall {
    mutating func find() throws {
        request.cmd = "ax.find"
        request.query = try str("query", max: AXLabelMatcher.maximumTextBytes)
        request.role = try str("role", max: 64)
        guard let query = request.query, !query.isEmpty else { throw MCPInputError.invalid("'query' is required") }
    }
}

// MARK: - spaceo_read_text

extension MCPTool {
    static let readText = MCPTool(
        "spaceo_read_text", """
            Read the window's text in reading order (document, terminal, web article) plus \
            the current selection, without a screenshot; element reads one element's value. \
            Reports truncated and source.
            """, ["element": ["type": "string", "maxLength": 32, "description": "Native element index from spaceo_read_screen."],
                  "max_chars": ["type": "integer", "minimum": AXTree.textCharacterRange.lowerBound, "maximum": AXTree.textCharacterRange.upperBound, "description": "Character limit (default \(AXTree.textCharacterRange.upperBound))."],
                  "session": sessionArg,
                  "window": windowArg]
    ) { try $0.readText() }
}

extension MCPToolCall {
    mutating func readText() throws {
        request.cmd = "ax.text"
        request.element = try str("element", max: 32)
        request.maxChars = try int("max_chars")
        let range = AXTree.textCharacterRange
        if let limit = request.maxChars, !range.contains(limit) {
            throw MCPInputError.invalid("'max_chars' must be from \(range.lowerBound) through \(range.upperBound)")
        }
    }
}

// MARK: - spaceo_run_steps

extension MCPTool {
    static let runSteps = MCPTool(
        "spaceo_run_steps", """
            Run up to 16 steps (click, type, press_key, scroll, move, drag, wait_for, find) \
            in one round trip. Returns per-step receipts and the first failure. 60 s budget. \
            After a failure, re-read; never replay completed steps.
            """, ["steps": ["type": "array", "minItems": 1, "maxItems": 16,
                            "description": "Steps as {tool: \"spaceo_click\", arguments: {...}}.",
                            "items": ["type": "object", "additionalProperties": false,
                                      "properties": ["tool": ["type": "string", "maxLength": 64],
                                                     "arguments": ["type": "object"]],
                                      "required": ["tool"]]],
                  "stop_on_failure": ["type": "boolean", "description": "Skip later steps after a failure (default true)."],
                  "session": sessionArg],
             required: ["steps"]
    ) { try $0.runSteps() }
}

extension MCPToolCall {
    mutating func runSteps() throws {
        request.cmd = "steps.run"
        request.stopOnFailure = try flag("stop_on_failure")
        guard let rawSteps = supplied("steps") as? [Any], !rawSteps.isEmpty, rawSteps.count <= 16 else {
            throw MCPInputError.invalid("'steps' must be an array of 1 through 16 {tool, arguments} objects")
        }
        let stepTools = MCPTool.batchableNames
        let batchSession = request.session
        request.steps = try rawSteps.enumerated().map { index, raw in
            guard let object = raw as? [String: Any], let tool = object["tool"] as? String else {
                throw MCPInputError.invalid("step \(index) must be an object with a 'tool' string")
            }
            guard stepTools.contains(tool) else {
                throw MCPInputError.invalid("step \(index): '\(MCPDiagnostic.name(tool))' cannot be batched; use " + stepTools.sorted().joined(separator: ", "))
            }
            if let unexpected = MCPDiagnostic.unexpected(object.keys, allowed: ["tool", "arguments"]) {
                throw MCPInputError.invalid("step \(index): \(unexpected)")
            }
            var stepArguments: [String: Any] = [:]
            if let suppliedArguments = object["arguments"] {
                guard let arguments = suppliedArguments as? [String: Any] else {
                    throw MCPInputError.invalid("step \(index): arguments must be an object")
                }
                stepArguments = arguments
            }
            if stepArguments["observe"] != nil || stepArguments["verbose"] != nil {
                throw MCPInputError.invalid("step \(index): 'observe' and 'verbose' apply to the whole call; "
                    + "pass verbose on spaceo_run_steps and read the screen after the batch")
            }
            guard stepArguments["session"] == nil || (stepArguments["session"] as? String) == batchSession else {
                throw MCPInputError.invalid("step \(index) names a different session; a batch runs on one session")
            }
            stepArguments.removeValue(forKey: "session")
            return try MCPServer.toolRequest(name: tool, arguments: stepArguments, defaultControllerOwner: nil)
        }
    }
}

// MARK: - spaceo_clipboard_set

extension MCPTool {
    static let clipboardSet = MCPTool(
        "spaceo_clipboard_set", """
            Put text on the session's private clipboard (up to 1 MiB). spaceo_press_key \
            "cmd+v" then pastes it via DevTools for web content or typing for native apps. \
            The user's pasteboard is never read or written.
            """, ["text": ["type": "string", "maxLength": 1_048_576, "description": "Text to store."], "session": sessionArg],
             required: ["text"],
        advertisesVerbose: false
    ) { try $0.clipboardSet() }
}

extension MCPToolCall {
    mutating func clipboardSet() throws {
        request.cmd = "clipboard.set"
        request.text = try str("text", max: 1_048_576, maxBytes: 1_048_576)
        guard request.text != nil else { throw MCPInputError.invalid("'text' is required") }
    }
}

// MARK: - spaceo_clipboard_get

extension MCPTool {
    static let clipboardGet = MCPTool(
        "spaceo_clipboard_get", """
            Read the session's private clipboard. spaceo_press_key "cmd+c" / "cmd+x" copies \
            the current selection into it.
            """, ["session": sessionArg],
        advertisesVerbose: false
    ) { try $0.clipboardGet() }
}

extension MCPToolCall {
    mutating func clipboardGet() throws {
        request.cmd = "clipboard.get"
    }
}

// MARK: - spaceo_session_set_title

extension MCPTool {
    static let sessionSetTitle = MCPTool(
        "spaceo_session_set_title", """
            Name the task this session is doing ("Booking flight to SFO") so the human can \
            tell sessions apart in the Viewer.
            """, ["title": ["type": "string", "maxLength": AgentSession.maximumTitleCharacters, "description": "Short task title."], "session": sessionArg],
             required: ["title"],
        advertisesVerbose: false
    ) { try $0.sessionSetTitle() }
}

extension MCPToolCall {
    mutating func sessionSetTitle() throws {
        request.cmd = "session.annotate"
        request.title = try str("title", max: AgentSession.maximumTitleCharacters)
        guard request.title != nil else { throw MCPInputError.invalid("'title' is required") }
    }
}

// MARK: - spaceo_events

extension MCPTool {
    static let events = MCPTool(
        "spaceo_events", """
            Daemon events after since_seq (sessions, apps, agent actions, pauses, isolation \
            verdicts). Other controllers' detail is redacted. On resync_required call \
            spaceo_session_list once, then keep passing next_seq back.
            """, ["since_seq": ["type": "integer", "minimum": 0, "description": "Return events strictly after this; pass next_seq back unchanged."]],
        hasReceipt: false
    ) { try $0.events() }
}

extension MCPToolCall {
    mutating func events() throws {
        request.cmd = "events.poll"
        if let since = try int("since_seq") {
            guard since >= 0 else { throw MCPInputError.invalid("'since_seq' must be zero or greater") }
            request.sinceSeq = UInt64(since)
        }
    }
}

// MARK: - spaceo_read_screen

extension MCPTool {
    static let readScreen = MCPTool(
        "spaceo_read_screen", """
            Read the window as indexed actionable elements ("[3] Button — Save"): cheaper and \
            more reliable than a screenshot; actions take these indices. since=<snapshot id> \
            returns only changes. If the footer says truncated, use spaceo_find or scroll.
            """, ["session": sessionArg,
                  "window": windowArg,
                  "since": ["type": "string", "maxLength": 128,
                            "description": "Snapshot id from a previous read; return only the differences."],
                  "full": ["type": "boolean",
                           "description": "Include non-actionable elements too. Verbose."]]
    ) { try $0.readScreen() }
}

extension MCPToolCall {
    mutating func readScreen() throws {
        request.cmd = "ax"
        request.full = try flag("full")
        request.since = try str("since", max: 128)
    }
}

// MARK: - spaceo_list_targets

extension MCPTool {
    static let listTargets = MCPTool(
        "spaceo_list_targets", """
            List the Chromium page targets of the selected browser window; * marks where web \
            reads and actions go. Use after opening or closing a tab, and before attaching.
            """, ["session": sessionArg, "window": windowArg],
        advertisesVerbose: false
    ) { try $0.listTargets() }
}

extension MCPToolCall {
    mutating func listTargets() throws {
        request.cmd = "targets"
    }
}

// MARK: - spaceo_attach_target

extension MCPTool {
    static let attachTarget = MCPTool(
        "spaceo_attach_target", """
            Bind the browser window's web reads and actions to one target id from \
            spaceo_list_targets. The binding is verified before every action and fails \
            closed if the page is closed or replaced.
            """, [
                "target": ["type": "string", "maxLength": 256, "description": "Exact target id from spaceo_list_targets."],
                "session": sessionArg,
                "window": windowArg,
            ], required: ["target"],
        advertisesVerbose: false
    ) { try $0.attachTarget() }
}

extension MCPToolCall {
    mutating func attachTarget() throws {
        request.cmd = "target.attach"
        request.target = try str("target", max: 256, maxBytes: 1_024)
        guard let target = request.target, !target.isEmpty else {
            throw MCPInputError.invalid("'target' is required")
        }
    }
}

// MARK: - spaceo_screenshot

extension MCPTool {
    static let screenshot = MCPTool(
        "spaceo_screenshot", """
            PNG of the session's window, or its tile with full=true, for what the outline \
            cannot convey. At scale=1 a window capture's pixels are click points; tile and \
            region captures report their origin in the image geometry. See \
            spaceo://docs/coordinates.
            """, ["session": sessionArg,
                  "window": windowArg,
                  "full": ["type": "boolean", "description": "Capture the whole tile."],
                  "scale": ["type": "integer", "minimum": 1, "maximum": 4,
                            "description": "Pixels per point; keep 1 unless reading small text."],
                  "x": ["type": "number", "description": "Region origin x, tile-relative."],
                  "y": ["type": "number", "description": "Region origin y, tile-relative."],
                  "width": ["type": "integer", "minimum": 1, "description": "Region width in points."],
                  "height": ["type": "integer", "minimum": 1, "description": "Region height in points."],
                  "annotate": ["type": "boolean",
                               "description": "Window captures: tag each actionable element with its read index (image only)."]],
        returnsImage: true
    ) { try $0.screenshot() }
}

extension MCPToolCall {
    mutating func screenshot() throws {
        request.cmd = "screenshot"
        request.full = try flag("full")
        request.scale = try int("scale")
        request.x = try dbl("x")
        request.y = try dbl("y")
        request.width = try int("width")
        request.height = try int("height")
        request.annotate = try flag("annotate")
        if let scale = request.scale, !(1...4).contains(scale) {
            throw MCPInputError.invalid("'scale' must be from 1 through 4")
        }
        if request.annotate == true, request.full == true || request.x != nil {
            throw MCPInputError.invalid("'annotate' works on a window capture; drop 'full' and the region")
        }
        let regionParts = [
            request.x != nil, request.y != nil,
            request.width != nil, request.height != nil,
        ].filter { $0 }.count
        guard regionParts == 0 || regionParts == 4 else {
            throw MCPInputError.invalid(
                "a screenshot region needs 'x', 'y', 'width' and 'height' together")
        }
        if let width = request.width, width < 1 {
            throw MCPInputError.invalid("'width' must be at least 1")
        }
        if let height = request.height, height < 1 {
            throw MCPInputError.invalid("'height' must be at least 1")
        }
        request.memory = true
    }
}

// MARK: - spaceo_click

extension MCPTool {
    static let click = MCPTool(
        "spaceo_click", """
            Click an element reference from spaceo_read_screen ("3", web "w3"; preferred), \
            an exact label, or window-local x/y. References and labels are accessibility \
            presses: no button, count or modifiers; use x/y for those.
            """, ["element": ["type": "string", "maxLength": 32,
                              "description": "Reference from spaceo_read_screen: \"3\" or \"w3\"."],
                  "x": ["type": "number", "description": "Window-relative x, in points."],
                  "y": ["type": "number", "description": "Window-relative y, in points."],
                  "button": buttonArg,
                  "count": ["type": "integer", "minimum": 1, "maximum": 3,
                            "description": "2 for a double-click, 3 to select a line."],
                  "modifiers": modifiersArg,
                  "web": webPointArg,
                  "session": sessionArg,
                  "window": windowArg],
        review: ["snapshot", "geometry", "strict", "label", "match", "role", "require_isolation"],
        observes: true,
        batchable: true
    ) { try $0.click() }
}

extension MCPToolCall {
    mutating func click() throws {
        request.cmd = "click"
        request.label = try str("label", max: AXLabelMatcher.maximumTextBytes)
        request.match = try str("match", max: 16)
        request.role = try str("role", max: 64)
        if (request.match != nil || request.role != nil), request.label == nil {
            throw MCPInputError.invalid("'match' and 'role' refine 'label'")
        }
        request.element = try str("element", max: 32)
        request.x = try dbl("x")
        request.y = try dbl("y")
        request.button = try str("button", max: 6)
        request.count = try int("count")
        request.modifiers = try modifiers()
        request.web = try flag("web")
        try validatePointerButton(request.button)
        if let count = request.count, !(1...3).contains(count) {
            throw MCPInputError.invalid("'count' must be from 1 through 3")
        }
        if request.element != nil && (request.x != nil || request.y != nil) {
            throw MCPInputError.invalid("use either 'element' or x/y coordinates, not both")
        }
        if (request.x == nil) != (request.y == nil) {
            throw MCPInputError.invalid("'x' and 'y' must be supplied together")
        }
        if request.element == nil && request.x == nil && request.label == nil {
            throw MCPInputError.invalid("click needs element, an exact label, or x/y coordinates")
        }
        // An element reference performs an accessibility press, which carries no button,
        // click count, or modifier state. The daemon refuses this too; catching it here
        // saves a round trip and names the alternative while the model is still deciding.
        if request.element != nil {
            let pointerOnly = [
                request.button != nil ? "button" : nil,
                (request.count ?? 1) != 1 ? "count" : nil,
                !(request.modifiers ?? []).isEmpty ? "modifiers" : nil,
            ].compactMap { $0 }
            guard pointerOnly.isEmpty else {
                throw MCPInputError.invalid(
                    "'\(pointerOnly.joined(separator: "', '"))' cannot apply to an element "
                    + "reference, which performs an accessibility press. Read the element's "
                    + "coordinates from a screenshot and click with x/y instead.")
            }
        }
    }
}

// MARK: - spaceo_scroll

extension MCPTool {
    static let scroll = MCPTool(
        "spaceo_scroll", """
            Scroll at a point or over an element, like a finger: negative dy moves the view \
            down (reveals what is below), negative dx moves the view right; native and web \
            alike. Reads describe only what is on screen, so scroll to reach more.
            """, ["element": ["type": "string", "maxLength": 32, "description": "Scroll over this element (\"3\" or \"w3\") instead of x/y."],
                  "x": ["type": "number", "description": "Window-relative x to scroll over."],
                  "y": ["type": "number", "description": "Window-relative y to scroll over."],
                  "dy": ["type": "integer", "minimum": -10_000, "maximum": 10_000,
                         "description": "Vertical pixels per tick; try -600 to page down."],
                  "dx": ["type": "integer", "minimum": -10_000, "maximum": 10_000,
                         "description": "Horizontal pixels per tick; try -600 to reveal later columns."],
                  "ticks": ["type": "integer", "minimum": 1, "maximum": 100,
                            "description": "Number of wheel ticks."],
                  "modifiers": modifiersArg,
                  "web": webPointArg,
                  "session": sessionArg,
                  "window": windowArg],
        review: ["strict", "require_isolation"],
        observes: true,
        batchable: true
    ) { try $0.pointerPath("scroll") }
}

// MARK: - spaceo_select_text

extension MCPTool {
    static let selectText = MCPTool(
        "spaceo_select_text", """
            Select text in a VS Code-family editor by zero-based line and character (read \
            back from the editor). Use instead of spaceo_drag there; x/y only pick the pane.
            """, ["x": ["type": "number", "description": "Window-relative x inside the editor pane."],
                  "y": ["type": "number", "description": "Window-relative y inside the editor pane."],
                  "anchor_line": ["type": "integer", "minimum": 0, "description": "Line where the selection starts."],
                  "anchor_character": ["type": "integer", "minimum": 0, "description": "Character on that line."],
                  "active_line": ["type": "integer", "minimum": 0, "description": "Line where the selection ends."],
                  "active_character": ["type": "integer", "minimum": 0, "description": "Character on that line."],
                  "session": sessionArg,
                  "window": windowArg],
             required: [
                 "x", "y", "anchor_line", "anchor_character", "active_line",
                 "active_character",
             ],
        review: ["strict", "require_isolation", "geometry"],
        observes: true
    ) { try $0.selectText() }
}

extension MCPToolCall {
    mutating func selectText() throws {
        request.cmd = "select"
        request.x = try dbl("x")
        request.y = try dbl("y")
        request.anchorLine = try int("anchor_line")
        request.anchorCharacter = try int("anchor_character")
        request.activeLine = try int("active_line")
        request.activeCharacter = try int("active_character")
        guard request.x != nil, request.y != nil else {
            throw MCPInputError.invalid("'x' and 'y' are required")
        }
        guard request.anchorLine != nil, request.anchorCharacter != nil,
              request.activeLine != nil, request.activeCharacter != nil else {
            throw MCPInputError.invalid(
                "'anchor_line', 'anchor_character', 'active_line' and "
                    + "'active_character' are required")
        }
        for name in ["anchor_line", "anchor_character", "active_line",
                     "active_character"] where (try int(name) ?? 0) < 0 {
            throw MCPInputError.invalid("'\(name)' must be zero or greater")
        }
    }
}

// MARK: - spaceo_move

extension MCPTool {
    static let move = MCPTool(
        "spaceo_move", """
            Move the pointer without pressing, to reveal hover-only menus, tooltips and \
            controls that fade in; then read the screen (or rely on observe) to see them.
            """, ["element": ["type": "string", "maxLength": 32, "description": "Hover this element (\"3\" or \"w3\") instead of x/y."],
                  "x": ["type": "number", "description": "Window-relative x."],
                  "y": ["type": "number", "description": "Window-relative y."],
                  "modifiers": modifiersArg,
                  "web": webPointArg,
                  "session": sessionArg,
                  "window": windowArg],
        review: ["strict", "require_isolation"],
        observes: true,
        batchable: true
    ) { try $0.pointerPath("move") }
}

// MARK: - spaceo_drag

extension MCPTool {
    static let drag = MCPTool(
        "spaceo_drag", """
            Press at one point, drag to another, and release: sliders, reordering, resizing, \
            selecting text. Either end may be an element reference (from_element / \
            to_element) instead of coordinates.
            """, ["from_element": ["type": "string", "maxLength": 32, "description": "Start at this element's centre instead of x/y."],
                  "to_element": ["type": "string", "maxLength": 32, "description": "End at this element's centre instead of to_x/to_y."],
                  "x": ["type": "number", "description": "Window-relative start x."],
                  "y": ["type": "number", "description": "Window-relative start y."],
                  "to_x": ["type": "number", "description": "Window-relative end x."],
                  "to_y": ["type": "number", "description": "Window-relative end y."],
                  "button": buttonArg,
                  "modifiers": modifiersArg,
                  "web": webPointArg,
                  "session": sessionArg,
                  "window": windowArg],
        review: ["duration", "geometry", "strict", "require_isolation"],
        observes: true,
        batchable: true
    ) { try $0.pointerPath("drag") }
}

extension MCPToolCall {
    /// scroll, move and drag share their start point; `command` is the daemon command.
    mutating func pointerPath(_ command: String) throws {
        request.cmd = command
        request.x = try dbl("x")
        request.y = try dbl("y")
        request.modifiers = try modifiers()
        request.web = try flag("web")
        request.element = try str("element", max: 32)
        request.fromElement = try str("from_element", max: 32)
        request.toElement = try str("to_element", max: 32)
        let startReference = request.element ?? request.fromElement
        if startReference != nil, request.x != nil || request.y != nil {
            throw MCPInputError.invalid("use either an element reference or x/y, not both")
        }
        if startReference == nil, request.x == nil || request.y == nil {
            throw MCPInputError.invalid("'x' and 'y' are required unless an element reference is given")
        }
        if let reference = startReference, Int(reference.hasPrefix("w") ? String(reference.dropFirst()) : reference) == nil {
            throw MCPInputError.invalid("element references look like \"3\" or \"w3\"")
        }
        if command == "scroll" {
            request.dx = try int32("dx")
            request.dy = try int32("dy")
            request.ticks = try int("ticks")
            guard request.dx != nil || request.dy != nil else {
                throw MCPInputError.invalid("scroll needs 'dx' or 'dy'")
            }
            if let ticks = request.ticks, !(1...100).contains(ticks) {
                throw MCPInputError.invalid("'ticks' must be from 1 through 100")
            }
        }
        if command == "drag" {
            request.toX = try dbl("to_x")
            request.toY = try dbl("to_y")
            request.button = try str("button", max: 6)
            try validatePointerButton(request.button)
            if request.toElement != nil, request.toX != nil || request.toY != nil {
                throw MCPInputError.invalid("use either 'to_element' or to_x/to_y, not both")
            }
            guard request.toElement != nil || (request.toX != nil && request.toY != nil) else {
                throw MCPInputError.invalid("'to_x' and 'to_y' are required unless 'to_element' is given")
            }
        } else if request.fromElement != nil || request.toElement != nil {
            throw MCPInputError.invalid("from_element/to_element apply to spaceo_drag; use 'element'")
        }
    }
}

// MARK: - spaceo_type

extension MCPTool {
    static let typeText = MCPTool(
        "spaceo_type", """
            Type text; newlines are Return. web=true targets page content. replace=true replaces \
            field contents (native fields require confirmed AX selection and readback); \
            submit=true presses Return.
            """, ["text": ["type": "string", "maxLength": 8_000, "description": "The text to type."],
                  "replace": ["type": "boolean", "description": "Replace contents; native selection and readback must be confirmed."],
                  "submit": ["type": "boolean", "description": "Press Return after the text."],
                  "web": ["type": "boolean", "description": "Type into page content."],
                  "session": sessionArg,
                  "window": windowArg],
             required: ["text"],
        review: ["strict", "require_isolation"],
        observes: true,
        batchable: true
    ) { try $0.typeText() }
}

extension MCPToolCall {
    mutating func typeText() throws {
        request.cmd = "type"
        request.text = try str("text", max: 8_000, maxBytes: 32_000)
        request.web = try flag("web")
        request.replace = try flag("replace")
        request.submit = try flag("submit")
        guard let text = request.text else {
            throw MCPInputError.invalid("'text' is required")
        }
        guard text.unicodeScalars.count <= 8_000 else {
            throw MCPInputError.invalid(
                "'text' is too long (maximum 8000 Unicode scalars)")
        }
    }
}

// MARK: - spaceo_press_key

extension MCPTool {
    static let pressKey = MCPTool(
        "spaceo_press_key", """
            Press a key or combination: "cmd+s", "return", "tab", "esc". hold_ms holds it; \
            action down/up sends one half (released after 10 s). cmd+c/x/v use the session's \
            private clipboard, never the user's pasteboard.
            """, ["key": ["type": "string", "maxLength": 64, "description": "Key combination."],
                  "hold_ms": ["type": "integer", "minimum": KeyCombo.holdMillisecondsRange.lowerBound, "maximum": KeyCombo.holdMillisecondsRange.upperBound, "description": "Hold before release, in ms."],
                  "action": ["type": "string", "enum": KeyCombo.actions, "description": "tap (default), or only down / up."],
                  "web": ["type": "boolean", "description": "Send the key to page content."],
                  "session": sessionArg,
                  "window": windowArg],
             required: ["key"],
        review: ["strict", "require_isolation"],
        observes: true,
        batchable: true
    ) { try $0.pressKey() }
}

extension MCPToolCall {
    mutating func pressKey() throws {
        request.cmd = "key"
        request.key = try str("key", max: 64, maxBytes: 256)
        request.web = try flag("web")
        request.holdMs = try int("hold_ms")
        request.keyAction = try str("action", max: 8)
        let holdRange = KeyCombo.holdMillisecondsRange
        if let hold = request.holdMs, !holdRange.contains(hold) {
            throw MCPInputError.invalid("'hold_ms' must be from \(holdRange.lowerBound) through \(holdRange.upperBound)")
        }
        if let action = request.keyAction, !KeyCombo.actions.contains(action) {
            throw MCPInputError.invalid("'action' must be " + alternatives(KeyCombo.actions))
        }
        guard let key = request.key, !key.isEmpty else {
            throw MCPInputError.invalid("'key' is required")
        }
    }
}

// MARK: - spaceo_list_windows

extension MCPTool {
    static let listWindows = MCPTool(
        "spaceo_list_windows",
             "List the session's windows with ids, frames, titles and [focused]/[modal]/[default] markers. With timeout, wait (bounded) until a window is listed.",
             ["session": sessionArg],
        review: ["timeout", "pid"]
    ) { try $0.listWindows() }
}

extension MCPToolCall {
    mutating func listWindows() throws {
        request.cmd = "windows"
        request.pid = try int32("pid")
    }
}

// MARK: - spaceo_verify_isolation

extension MCPTool {
    static let verifyIsolation = MCPTool(
        "spaceo_verify_isolation", """
            Audit session health and attention isolation. \
            \(IsolationVerdictGuidance.toolDescriptionLine())
            """, ["session": sessionArg],
        review: ["require_window", "strict", "require_isolation"],
        advertisesRequireIsolation: true
    ) { try $0.verifyIsolation() }
}

extension MCPToolCall {
    mutating func verifyIsolation() throws {
        request.cmd = "verify"
    }
}

// MARK: - spaceo_pool_status

extension MCPTool {
    static let poolStatus = MCPTool(
        "spaceo_pool_status",
             "Show agent displays, how many sessions each holds, and spare capacity.",
        hasReceipt: false
    ) { try $0.poolStatus() }
}

extension MCPToolCall {
    mutating func poolStatus() throws {
        request.cmd = "pool"
    }
}

// MARK: - spaceo_pool_trim

extension MCPTool {
    static let poolTrim = MCPTool(
        "spaceo_pool_trim",
             "Retire idle displays only. Active sessions remain. Use for explicit operator cleanup; normal tasks should keep the reusable display.",
             ["operator": ["type": "boolean", "description": "Must be true to confirm shared-pool operator scope."]],
             required: ["operator"]
    ) { try $0.poolTrim() }
}

extension MCPToolCall {
    mutating func poolTrim() throws {
        guard try flag("operator") == true else {
            throw MCPInputError.invalid("pool trim requires operator=true")
        }
        request.cmd = "pool.trim"
        request.operatorScope = true
    }
}


// MARK: - Catalogue

extension MCPTool {
    /// Every tool, in `tools/list` order.
    static let catalogue: [MCPTool] = [
        .placeWindow,
        .adoptApp,
        .sessionPause,
        .sessionResume,
        .sessionCreate,
        .sessionClaim,
        .sessionList,
        .sessionHeartbeat,
        .sessionDestroy,
        .openApp,
        .openURL,
        .waitFor,
        .menu,
        .find,
        .readText,
        .runSteps,
        .clipboardSet,
        .clipboardGet,
        .sessionSetTitle,
        .events,
        .readScreen,
        .listTargets,
        .attachTarget,
        .screenshot,
        .click,
        .scroll,
        .selectText,
        .move,
        .drag,
        .typeText,
        .pressKey,
        .listWindows,
        .verifyIsolation,
        .poolStatus,
        .poolTrim,
    ]
}
