import Foundation

/// One-sentence verdicts for isolation reports (SPAO-163 follow-up).
///
/// The structured report is the source of truth, but an agent or a person skimming tool output
/// needs the outcome in one line: was the desktop disturbed, what could not be checked, and what
/// to do next. The wording is fixed and derived only from the report, so the same report always
/// produces the same sentence.
public extension IsolationReport {
    /// Exactly one plain sentence describing the verdict and its limits.
    var summarySentence: String {
        switch verdict {
        case .intact:
            return "No disturbance to your desktop was observed and every required check was covered."
        case .partial:
            let unknown = uncoveredChecks
            let names = IsolationSummaryWording.list(
                unknown.map { IsolationSummaryWording.name($0.dimension) })
            let cause = partialCause.phrase
            return "No disturbance to your desktop was observed; \(names) could not be checked "
                + "because \(cause)."
        case .breached:
            let listed = failures.isEmpty ? ["an isolation check failed"] : Array(failures.prefix(2))
            let detail = listed.map(IsolationSummaryWording.trimmed).joined(separator: "; ")
            return "Your desktop WAS disturbed: \(detail); SpaceO paused the session's agent input."
        }
    }

    /// What the caller should do now, phrased for the verdict.
    var nextStepLine: String {
        switch verdict {
        case .intact:
            return "Continue."
        case .partial:
            let reversible = "continue for reversible steps and treat unknown checks as untested; "
                + "for irreversible steps (sending, deleting, paying) use strict isolation, which "
                + "refuses to act without full evidence."
            switch partialCause {
            case .accessibilityMissing:
                return "Grant Accessibility to the daemon's host app to cover them. Until then, "
                    + reversible
            case .focusNotReported, .noObservation:
                return "You may " + reversible
            }
        case .breached:
            return "Resolve the breach, then explicitly resume the session."
        }
    }

    /// Why a partial verdict is partial. Chosen from the daemon's real grant state, never from
    /// evidence wording: the production evidence for an unobserved keyboard route mentions
    /// "Accessibility" whether or not the grant is present.
    var partialCause: IsolationPartialCause {
        let unknown = uncoveredChecks
        let routes: Set<IsolationDimension> = [.keyInputRoute, .textInputRoute]
        let routeUnknown = unknown.contains { routes.contains($0.dimension) }
        if accessibilityGranted == false, routeUnknown { return .accessibilityMissing }
        if accessibilityGranted == true, !unknown.isEmpty,
           unknown.allSatisfy({ routes.contains($0.dimension) }) {
            return .focusNotReported
        }
        return .noObservation
    }

    /// Required checks whose value SpaceO could not observe. Mirrors the rule the verdict uses so
    /// the sentence never names a check the verdict did not count.
    fileprivate var uncoveredChecks: [IsolationCheckReport] {
        checks.filter { $0.required && ($0.coverage == .unknown || $0.status == .unknown) }
    }
}

/// The attributable reason for a partial verdict.
public enum IsolationPartialCause: String, Sendable, Equatable {
    /// The daemon lacks Accessibility, so keyboard and text routing cannot be observed at all.
    case accessibilityMissing = "accessibility_missing"
    /// The grant is present but the system did not say which app has keyboard focus.
    case focusNotReported = "focus_not_reported"
    /// Anything else, including an older daemon that did not report its grant.
    case noObservation = "no_observation"

    var phrase: String {
        switch self {
        case .accessibilityMissing: return "Accessibility is missing on the daemon"
        case .focusNotReported: return "the system did not report which app has keyboard focus"
        case .noObservation: return "no usable observation was available"
        }
    }
}

/// Fixed guidance shared by MCP tool descriptions so every tool explains verdicts identically.
public enum IsolationVerdictGuidance {
    public static func toolDescriptionLine() -> String {
        "verdict intact: continue; partial: continue but unknown checks were not tested; "
            + "breached: input is paused, resolve and resume."
    }
}

enum IsolationSummaryWording {
    /// Human words for each dimension. The raw identifiers are protocol vocabulary, not prose.
    static func name(_ dimension: IsolationDimension) -> String {
        switch dimension {
        case .keyInputRoute: return "keyboard routing"
        case .textInputRoute: return "text-input routing"
        case .menuBarOwner: return "menu bar owner"
        case .windowServerFrontProcess: return "front process"
        case .cursorLocation: return "cursor location"
        case .activeSpace: return "active Space"
        }
    }

    static func list(_ names: [String]) -> String {
        switch names.count {
        case 0: return "a required check"
        case 1: return names[0]
        case 2: return "\(names[0]) and \(names[1])"
        default:
            return names.dropLast().joined(separator: ", ") + ", and " + names[names.count - 1]
        }
    }

    /// Failures are embedded mid-sentence; a trailing period would end the sentence early.
    static func trimmed(_ failure: String) -> String {
        var text = failure.trimmingCharacters(in: .whitespacesAndNewlines)
        while text.hasSuffix(".") { text.removeLast() }
        return text
    }
}
