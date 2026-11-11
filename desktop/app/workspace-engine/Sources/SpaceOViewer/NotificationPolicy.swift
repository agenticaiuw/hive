import Foundation
import SpaceOKit

/// SPAO-215. The few things a person who is ignoring the agent display still has to hear
/// about. Nothing else — routine agent actions in particular — is ever a notification.
enum ViewerNotificationClass: String, CaseIterable, Identifiable, Sendable {
    /// An agent paused itself and asked for a person. The only class on by default; see
    /// `ViewerNotificationPreferences.agentNeedsHuman`.
    case agentNeedsHuman
    case isolationBreach
    case sessionAbandoned
    case teardownIncomplete
    case leaseExpiring

    var id: String { rawValue }

    var title: String {
        switch self {
        case .agentNeedsHuman: "Agent needs you"
        case .isolationBreach: "Isolation breach"
        case .sessionAbandoned: "An agent disconnected"
        case .teardownIncomplete: "Cleanup left something behind"
        case .leaseExpiring: "Session about to expire while you're in control"
        }
    }

    var detail: String {
        switch self {
        case .agentNeedsHuman:
            "An agent paused itself and is waiting for a person, for example to enter a 2FA code."
        case .isolationBreach:
            "An isolation check found an agent's session reaching your desktop, focus or pointer."
        case .sessionAbandoned:
            "The agent that owned a session went away and left its apps running."
        case .teardownIncomplete:
            "Ending a session has been stuck for more than \(Int(NotificationPolicy.teardownGrace))s."
        case .leaseExpiring:
            "A session you're driving ends within \(Int(NotificationPolicy.leaseWarning))s "
                + "unless its agent checks in."
        }
    }

    /// The button on the notification, which deep-links into the inspector.
    var actionTitle: String {
        switch self {
        case .agentNeedsHuman: "Take Control"
        case .isolationBreach: "Open Health"
        case .sessionAbandoned: "Review Session"
        case .teardownIncomplete: "Retry Cleanup"
        case .leaseExpiring: "Open Session"
        }
    }

    var section: ViewerInspectorSection {
        switch self {
        case .isolationBreach, .sessionAbandoned, .teardownIncomplete: .health
        case .agentNeedsHuman, .leaseExpiring: .overview
        }
    }

    func isEnabled(in preferences: ViewerNotificationPreferences) -> Bool {
        switch self {
        case .agentNeedsHuman: preferences.agentNeedsHuman
        case .isolationBreach: preferences.isolationBreach
        case .sessionAbandoned: preferences.sessionAbandoned
        case .teardownIncomplete: preferences.teardownIncomplete
        case .leaseExpiring: preferences.leaseExpiring
        }
    }
}

struct ViewerNotification: Equatable, Identifiable, Sendable {
    let notificationClass: ViewerNotificationClass
    let sessionID: String
    let title: String
    let body: String
    /// Distinguishes repeats the policy should fire again (a new lease expiry) from ones it
    /// should not (the same breach on every poll).
    let dedupeKey: String

    var id: String { "\(notificationClass.rawValue)|\(sessionID)|\(dedupeKey)" }
    var section: ViewerInspectorSection { notificationClass.section }
    var actionTitle: String { notificationClass.actionTitle }
}

struct ViewerNotificationAction: Equatable, Sendable {
    let sessionID: String
    let section: ViewerInspectorSection
    var notificationClass: ViewerNotificationClass?
    /// The person pressed the notification's own "Take Control" button (not the body).
    var takeControl = false
}

/// Decides, from one poll delta, what to post. Pure: no clock, no I/O, no notification center.
/// Stateful only to remember what it already fired and when teardowns started.
struct NotificationPolicy: Equatable, Sendable {
    static let teardownGrace: TimeInterval = 30
    static let leaseWarning: TimeInterval = 60

    private(set) var teardownPendingSince: [String: Date] = [:]
    private(set) var delivered: Set<String> = []

    init() {}

    /// `isolationBreaches` are session ids whose most recent `verify` reported a breach. Without
    /// a verify result there is no breach signal: a refused action or a pause is not one.
    mutating func evaluate(
        previous: [SessionInfo],
        current: [SessionInfo],
        isolationBreaches: Set<String>,
        humanHasControl: Bool,
        enabled: ViewerNotificationPreferences,
        now: Date
    ) -> [ViewerNotification] {
        let previousByID = Dictionary(previous.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        let currentIDs = Set(current.map(\.id))

        // Teardown bookkeeping runs regardless of what is enabled, so switching the class on
        // later does not restart every clock.
        for session in current {
            if session.teardownPending {
                if teardownPendingSince[session.id] == nil { teardownPendingSince[session.id] = now }
            } else {
                teardownPendingSince.removeValue(forKey: session.id)
            }
        }
        teardownPendingSince = teardownPendingSince.filter { currentIDs.contains($0.key) }
        // A help request is delivered once per reason. Once the agent resumes (its reason
        // clears), the same reason asked again later is a new request and must be heard.
        let waitingIDs = Set(current.filter(ViewerAttention.needsHuman).map(\.id))
        delivered = delivered.filter { key in
            let parts = key.split(separator: "|", maxSplits: 2)
            guard parts.count >= 2 else { return false }
            let sessionID = String(parts[1])
            if parts[0] == Substring(ViewerNotificationClass.agentNeedsHuman.rawValue) {
                return waitingIDs.contains(sessionID)
            }
            return currentIDs.contains(sessionID)
        }

        var fired: [ViewerNotification] = []
        for session in current.sorted(by: { $0.id < $1.id }) where session.runtimeAttached != false {
            let label = ViewerSessionGrouping.displayTitle(session)

            if enabled.agentNeedsHuman, let reason = ViewerAttention.reason(session) {
                fire(&fired, .agentNeedsHuman, session.id, key: "needs-\(reason)",
                     title: "\(label) needs you: \(reason)",
                     body: "The agent paused itself and is waiting for a person. "
                        + "Take Control to help, then hand it back.")
            }

            if enabled.isolationBreach, isolationBreaches.contains(session.id) {
                fire(&fired, .isolationBreach, session.id, key: "breach",
                     title: "Isolation breach in \(label)",
                     body: "The last isolation check for this session failed. Review Health.")
            }

            if enabled.sessionAbandoned, session.abandoned == true,
               let before = previousByID[session.id], before.abandoned != true {
                fire(&fired, .sessionAbandoned, session.id, key: "abandoned",
                     title: "\(label) is abandoned",
                     body: "Its controller stopped heartbeating. Reclaim or destroy it from Health.")
            }

            if enabled.teardownIncomplete, let since = teardownPendingSince[session.id],
               now.timeIntervalSince(since) > Self.teardownGrace {
                fire(&fired, .teardownIncomplete, session.id, key: "teardown",
                     title: "Cleanup incomplete for \(label)",
                     body: "Teardown has been pending for over \(Int(Self.teardownGrace))s. "
                        + "Something may still be running.")
            }

            if enabled.leaseExpiring, humanHasControl, let expires = session.leaseExpiresAt {
                let remaining = expires.timeIntervalSince(now)
                if remaining > 0, remaining <= Self.leaseWarning {
                    fire(&fired, .leaseExpiring, session.id,
                         key: "lease-\(Int(expires.timeIntervalSinceReferenceDate))",
                         title: "Lease for \(label) expires in \(Int(remaining.rounded()))s",
                         body: "You hold Control; the controller's lease is about to lapse.")
                }
            }
        }
        return fired
    }

    private mutating func fire(
        _ fired: inout [ViewerNotification],
        _ notificationClass: ViewerNotificationClass,
        _ sessionID: String,
        key: String,
        title: String,
        body: String
    ) {
        let notification = ViewerNotification(
            notificationClass: notificationClass, sessionID: sessionID,
            title: title, body: body, dedupeKey: key)
        guard !delivered.contains(notification.id) else { return }
        delivered.insert(notification.id)
        fired.append(notification)
    }
}

/// How the model hands a decided notification to macOS. Injected so tests never reach
/// `UNUserNotificationCenter`, which also does not exist for an unbundled test process.
@MainActor
protocol ViewerNotificationPosting: AnyObject {
    /// Called when the person switches a class on; the only time authorization is requested.
    func requestAuthorization()
    func post(_ notification: ViewerNotification)
}
