import AppKit
import Foundation
import SwiftUI
import UserNotifications

/// SPAO-215. Posts the policy's notifications through `UNUserNotificationCenter` and routes the
/// action button back into the Viewer. Only touches the center from a bundled process: the
/// center traps in an unbundled executable (`swift run`, tests), and there is nothing to post
/// to there anyway.
@MainActor
final class UserNotificationBridge: NSObject, ViewerNotificationPosting {
    static let shared = UserNotificationBridge()

    /// Deep link, wired once at the app level (not by a window, which may not exist in a
    /// menu-bar-only launch): select the session, open the section, and ask for a window.
    /// `takeControl` is true only for the notification's explicit action button.
    var onAction: ((_ action: ViewerNotificationAction) -> Void)?

    nonisolated static let openActionID = "spaceo.open"
    private var categoriesRegistered = false
    private var authorizationRequested = false

    private var center: UNUserNotificationCenter? {
        guard Bundle.main.bundleIdentifier != nil else { return nil }
        return .current()
    }

    func requestAuthorization() {
        guard let center else { return }
        registerCategories(with: center)
        authorizationRequested = true
        center.requestAuthorization(options: [.alert, .sound]) { _, _ in }
    }

    func post(_ notification: ViewerNotification) {
        guard let center else { return }
        registerCategories(with: center)
        // The default-on class (agentNeedsHuman) was never switched on by hand, so nothing has
        // asked macOS yet. Ask now — when there is a real request to deliver — and post once
        // the answer is in. macOS only ever prompts once; later calls return immediately.
        guard authorizationRequested else {
            authorizationRequested = true
            center.requestAuthorization(options: [.alert, .sound]) { granted, _ in
                guard granted else { return }
                UNUserNotificationCenter.current().add(Self.request(for: notification)) { _ in }
            }
            return
        }
        center.add(Self.request(for: notification)) { _ in }
    }

    private nonisolated static func request(for notification: ViewerNotification) -> UNNotificationRequest {
        let content = UNMutableNotificationContent()
        content.title = notification.title
        content.body = notification.body
        content.categoryIdentifier = notification.notificationClass.rawValue
        content.userInfo = [
            "session": notification.sessionID,
            "section": notification.section.rawValue,
            "class": notification.notificationClass.rawValue,
        ]
        content.sound = .default
        return UNNotificationRequest(identifier: notification.id, content: content, trigger: nil)
    }

    private func registerCategories(with center: UNUserNotificationCenter) {
        guard !categoriesRegistered else { return }
        categoriesRegistered = true
        center.delegate = self
        let categories = ViewerNotificationClass.allCases.map { notificationClass in
            UNNotificationCategory(
                identifier: notificationClass.rawValue,
                actions: [UNNotificationAction(
                    identifier: Self.openActionID,
                    title: notificationClass.actionTitle,
                    options: [.foreground])],
                intentIdentifiers: [],
                options: [])
        }
        center.setNotificationCategories(Set(categories))
    }
}

extension UserNotificationBridge: UNUserNotificationCenterDelegate {
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let info = response.notification.request.content.userInfo
        let sessionID = info["session"] as? String
        let section = (info["section"] as? String).flatMap(ViewerInspectorSection.init(rawValue:))
        let notificationClass = (info["class"] as? String)
            .flatMap(ViewerNotificationClass.init(rawValue:))
        let pressedAction = response.actionIdentifier == Self.openActionID
        Task { @MainActor in
            if let sessionID {
                // A menu-bar-only launch is an accessory process with no Dock icon and no
                // window; the model's window request (observed by the always-present menu bar
                // label) brings the console back.
                NSApp.setActivationPolicy(.regular)
                NSApp.activate(ignoringOtherApps: true)
                self.onAction?(ViewerNotificationAction(
                    sessionID: sessionID,
                    section: section ?? .health,
                    notificationClass: notificationClass,
                    takeControl: pressedAction && notificationClass == .agentNeedsHuman))
            }
            completionHandler()
        }
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        // The Viewer may be frontmost and still deserve the banner: the point is to interrupt.
        completionHandler([.banner, .sound])
    }
}
