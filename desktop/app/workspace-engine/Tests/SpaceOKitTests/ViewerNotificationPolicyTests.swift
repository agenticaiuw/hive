import Foundation
import XCTest
@testable import SpaceOKit
@testable import SpaceOViewer

/// SPAO-215. A few classes, each once, each only when switched on (only "agent needs you" is on
/// by default), and never for an agent's routine work. The policy is pure; these feed it
/// hand-built poll deltas.
final class ViewerNotificationPolicyTests: XCTestCase {

    private let now = Date(timeIntervalSinceReferenceDate: 10_000)

    private func session(
        id: String,
        abandoned: Bool? = nil,
        teardownPending: Bool = false,
        leaseExpiresAt: Date? = nil,
        inputPaused: Bool? = nil,
        lastActionOutcome: String? = nil,
        attached: Bool = true
    ) throws -> SessionInfo {
        let formatter = ISO8601DateFormatter()
        var extras: [String] = []
        if let abandoned { extras.append("\"abandoned\":\(abandoned)") }
        if let leaseExpiresAt {
            extras.append("\"leaseExpiresAt\":\"\(formatter.string(from: leaseExpiresAt))\"")
        }
        if let inputPaused { extras.append("\"inputPaused\":\(inputPaused)") }
        if let lastActionOutcome {
            extras.append("\"lastAgentAction\":\"click\"")
            extras.append("\"lastAgentActionAt\":\"2026-07-30T00:00:01Z\"")
            extras.append("\"lastAgentActionOutcome\":\"\(lastActionOutcome)\"")
        }
        let extraJSON = extras.isEmpty ? "" : extras.joined(separator: ",") + ","
        let json = """
        {
          "id":"\(id)","displayID":7,"x":0,"y":0,"width":100,"height":100,
          "tileIndex":0,"tileCapacity":1,"exclusiveDisplay":true,
          "spaces":[],"hasOwnSpace":false,"apps":[],"windows":[],
          \(extraJSON)
          "createdAt":"2026-07-30T00:00:00Z","teardownPending":\(teardownPending),
          "runtimeAttached":\(attached)
        }
        """
        return try Wire.decoder.decode(SessionInfo.self, from: Data(json.utf8))
    }

    private var allOn: ViewerNotificationPreferences {
        var preferences = ViewerNotificationPreferences()
        preferences.isolationBreach = true
        preferences.sessionAbandoned = true
        preferences.teardownIncomplete = true
        preferences.leaseExpiring = true
        return preferences
    }

    /// Everything but `agentNeedsHuman` is off by default; with no help request in the delta,
    /// nothing fires.
    func testEverythingIsOffByDefaultSoNothingFires() throws {
        var policy = NotificationPolicy()
        let fired = policy.evaluate(
            previous: [try session(id: "a")],
            current: [try session(id: "a", abandoned: true, teardownPending: true,
                                  leaseExpiresAt: now.addingTimeInterval(10))],
            isolationBreaches: ["a"],
            humanHasControl: true,
            enabled: ViewerNotificationPreferences(),
            now: now)
        XCTAssertTrue(fired.isEmpty)
    }

    func testAbandonmentFiresOnceOnTheTransitionOnly() throws {
        var policy = NotificationPolicy()
        let live = try session(id: "a")
        let gone = try session(id: "a", abandoned: true)

        XCTAssertTrue(policy.evaluate(previous: [], current: [gone], isolationBreaches: [],
                                      humanHasControl: false, enabled: allOn, now: now).isEmpty,
                      "a session first seen already abandoned did not *become* abandoned here")
        let fired = policy.evaluate(previous: [live], current: [gone], isolationBreaches: [],
                                    humanHasControl: false, enabled: allOn, now: now)
        XCTAssertEqual(fired.map(\.notificationClass), [.sessionAbandoned])
        XCTAssertEqual(fired.first?.section, .health)
        XCTAssertEqual(fired.first?.actionTitle, "Review Session")
        XCTAssertTrue(policy.evaluate(previous: [gone], current: [gone], isolationBreaches: [],
                                      humanHasControl: false, enabled: allOn, now: now).isEmpty,
                      "the same abandonment is not repeated on the next poll")
    }

    func testTeardownIncompleteWaitsThirtySecondsThenFiresOnce() throws {
        var policy = NotificationPolicy()
        let pending = try session(id: "t", teardownPending: true)
        XCTAssertTrue(policy.evaluate(previous: [], current: [pending], isolationBreaches: [],
                                      humanHasControl: false, enabled: allOn, now: now).isEmpty)
        XCTAssertTrue(policy.evaluate(previous: [pending], current: [pending], isolationBreaches: [],
                                      humanHasControl: false, enabled: allOn,
                                      now: now.addingTimeInterval(29)).isEmpty)
        let fired = policy.evaluate(previous: [pending], current: [pending], isolationBreaches: [],
                                    humanHasControl: false, enabled: allOn,
                                    now: now.addingTimeInterval(31))
        XCTAssertEqual(fired.map(\.notificationClass), [.teardownIncomplete])
        XCTAssertTrue(policy.evaluate(previous: [pending], current: [pending], isolationBreaches: [],
                                      humanHasControl: false, enabled: allOn,
                                      now: now.addingTimeInterval(90)).isEmpty)

        // A teardown that completes and starts again gets a fresh clock.
        let done = try session(id: "t")
        _ = policy.evaluate(previous: [pending], current: [done], isolationBreaches: [],
                            humanHasControl: false, enabled: allOn, now: now.addingTimeInterval(100))
        XCTAssertTrue(policy.evaluate(previous: [done], current: [pending], isolationBreaches: [],
                                      humanHasControl: false, enabled: allOn,
                                      now: now.addingTimeInterval(101)).isEmpty)
    }

    func testLeaseExpiringOnlyWhileTheHumanHoldsControlAndOncePerExpiry() throws {
        var policy = NotificationPolicy()
        let expiring = try session(id: "l", leaseExpiresAt: now.addingTimeInterval(45))
        XCTAssertTrue(policy.evaluate(previous: [expiring], current: [expiring], isolationBreaches: [],
                                      humanHasControl: false, enabled: allOn, now: now).isEmpty,
                      "without Control the agent's lease is the agent's problem")
        let fired = policy.evaluate(previous: [expiring], current: [expiring], isolationBreaches: [],
                                    humanHasControl: true, enabled: allOn, now: now)
        XCTAssertEqual(fired.map(\.notificationClass), [.leaseExpiring])
        XCTAssertEqual(fired.first?.section, .overview)
        XCTAssertTrue(policy.evaluate(previous: [expiring], current: [expiring], isolationBreaches: [],
                                      humanHasControl: true, enabled: allOn,
                                      now: now.addingTimeInterval(5)).isEmpty)

        let renewed = try session(id: "l", leaseExpiresAt: now.addingTimeInterval(300))
        XCTAssertTrue(policy.evaluate(previous: [expiring], current: [renewed], isolationBreaches: [],
                                      humanHasControl: true, enabled: allOn, now: now).isEmpty,
                      "five minutes out is not expiring")
        let later = policy.evaluate(previous: [renewed], current: [renewed], isolationBreaches: [],
                                    humanHasControl: true, enabled: allOn,
                                    now: now.addingTimeInterval(250))
        XCTAssertEqual(later.count, 1, "a new expiry is a new warning")

        let expired = try session(id: "l", leaseExpiresAt: now.addingTimeInterval(-1))
        XCTAssertTrue(policy.evaluate(previous: [renewed], current: [expired], isolationBreaches: [],
                                      humanHasControl: true, enabled: allOn, now: now).isEmpty,
                      "already expired is a different problem, reported elsewhere")
    }

    func testBreachComesOnlyFromAVerifyResultNeverFromRefusedActionsOrPauses() throws {
        var policy = NotificationPolicy()
        let suspicious = try session(id: "b", inputPaused: true, lastActionOutcome: "refused")
        XCTAssertTrue(policy.evaluate(previous: [try session(id: "b")], current: [suspicious],
                                      isolationBreaches: [], humanHasControl: false,
                                      enabled: allOn, now: now).isEmpty,
                      "a refused action and a pause are arbitration, not a breach signal")
        let fired = policy.evaluate(previous: [suspicious], current: [suspicious],
                                    isolationBreaches: ["b"], humanHasControl: false,
                                    enabled: allOn, now: now)
        XCTAssertEqual(fired.map(\.notificationClass), [.isolationBreach])
        XCTAssertEqual(fired.first?.actionTitle, "Open Health")
        XCTAssertTrue(policy.evaluate(previous: [suspicious], current: [suspicious],
                                      isolationBreaches: ["b"], humanHasControl: false,
                                      enabled: allOn, now: now).isEmpty)
    }

    func testRoutineAgentActionsAndDetachedRecordsNeverNotify() throws {
        var policy = NotificationPolicy()
        let busy = try session(id: "busy", lastActionOutcome: "confirmed")
        let detached = try session(id: "old", abandoned: true, teardownPending: true, attached: false)
        let fired = policy.evaluate(
            previous: [try session(id: "busy"), try session(id: "old", attached: false)],
            current: [busy, detached], isolationBreaches: ["old"],
            humanHasControl: true, enabled: allOn, now: now.addingTimeInterval(100))
        XCTAssertTrue(fired.isEmpty)
    }

    func testDeliveredStateIsPrunedWhenSessionsDisappear() throws {
        var policy = NotificationPolicy()
        let live = try session(id: "a")
        let gone = try session(id: "a", abandoned: true)
        _ = policy.evaluate(previous: [live], current: [gone], isolationBreaches: [],
                            humanHasControl: false, enabled: allOn, now: now)
        _ = policy.evaluate(previous: [gone], current: [], isolationBreaches: [],
                            humanHasControl: false, enabled: allOn, now: now)
        XCTAssertTrue(policy.delivered.isEmpty)
        // The same id reappearing later is a new session and may fire again.
        let fired = policy.evaluate(previous: [live], current: [gone], isolationBreaches: [],
                                    humanHasControl: false, enabled: allOn, now: now)
        XCTAssertEqual(fired.count, 1)
    }

    // MARK: - Model wiring

    @MainActor
    private final class RecordingPoster: ViewerNotificationPosting {
        var authorizations = 0
        var posted: [ViewerNotification] = []
        func requestAuthorization() { authorizations += 1 }
        func post(_ notification: ViewerNotification) { posted.append(notification) }
    }

    @MainActor
    func testModelOnlyAsksForAuthorizationWhenAClassIsEnabledAndPostsThroughThePoster() throws {
        let poster = RecordingPoster()
        let model = ViewerModel(
            automaticRefresh: false,
            accessibilityAnnouncement: { _ in },
            notificationPoster: poster)
        XCTAssertEqual(poster.authorizations, 0, "launch never prompts")

        model.setNotificationClass(.sessionAbandoned, enabled: false)
        XCTAssertEqual(poster.authorizations, 0, "switching a class off does not prompt")
        model.setNotificationClass(.sessionAbandoned, enabled: true)
        XCTAssertEqual(poster.authorizations, 1)
        XCTAssertTrue(model.preferences.notifications.sessionAbandoned)

        model.applyControlPlane(sessions: [try session(id: "a")], poolResponse: Response(ok: true))
        model.applyControlPlane(sessions: [try session(id: "a", abandoned: true)],
                                poolResponse: Response(ok: true))
        XCTAssertEqual(poster.posted.map(\.notificationClass), [.sessionAbandoned])
        XCTAssertEqual(poster.posted.first?.sessionID, "a")
        XCTAssertTrue(model.events.contains { $0.title == poster.posted.first?.title })
    }

    // MARK: - Agent needs you

    func testAgentNeedsHumanIsTheOnlyClassOnByDefault() throws {
        let defaults = ViewerNotificationPreferences()
        XCTAssertEqual(ViewerNotificationClass.allCases.filter { $0.isEnabled(in: defaults) },
                       [.agentNeedsHuman])
        XCTAssertEqual(ViewerNotificationClass.agentNeedsHuman.actionTitle, "Take Control")

        // A preferences file written before the class existed still gets the default.
        let old = try Wire.decoder.decode(ViewerNotificationPreferences.self,
                                          from: Data(#"{"isolationBreach":true}"#.utf8))
        XCTAssertTrue(old.agentNeedsHuman)
        XCTAssertTrue(old.isolationBreach)
        let off = try Wire.decoder.decode(ViewerNotificationPreferences.self,
                                          from: Data(#"{"agentNeedsHuman":false}"#.utf8))
        XCTAssertFalse(off.agentNeedsHuman)
    }

    func testAgentNeedsHumanFiresOncePerReasonAndAgainAfterItResumes() throws {
        var policy = NotificationPolicy()
        let running = try session(id: "a")
        var asking = try session(id: "a", inputPaused: true)
        asking.title = "Checkout"
        asking.agentPauseReason = "needs 2FA code"
        let defaults = ViewerNotificationPreferences()

        var fired = policy.evaluate(previous: [running], current: [asking], isolationBreaches: [],
                                    humanHasControl: false, enabled: defaults, now: now)
        XCTAssertEqual(fired.map(\.notificationClass), [.agentNeedsHuman])
        XCTAssertEqual(fired.first?.title, "Checkout needs you: needs 2FA code")
        XCTAssertEqual(fired.first?.section, .overview)
        XCTAssertTrue(policy.evaluate(previous: [asking], current: [asking], isolationBreaches: [],
                                      humanHasControl: false, enabled: defaults, now: now).isEmpty,
                      "not again on every poll")

        var otherReason = asking
        otherReason.agentPauseReason = "needs a CAPTCHA"
        fired = policy.evaluate(previous: [asking], current: [otherReason], isolationBreaches: [],
                                humanHasControl: false, enabled: defaults, now: now)
        XCTAssertEqual(fired.first?.title, "Checkout needs you: needs a CAPTCHA")

        // Resumed, then the same request again later: that is a new request.
        _ = policy.evaluate(previous: [otherReason], current: [running], isolationBreaches: [],
                            humanHasControl: false, enabled: defaults, now: now)
        fired = policy.evaluate(previous: [running], current: [otherReason], isolationBreaches: [],
                                humanHasControl: false, enabled: defaults, now: now)
        XCTAssertEqual(fired.map(\.notificationClass), [.agentNeedsHuman])

        var off = defaults
        off.agentNeedsHuman = false
        var quiet = NotificationPolicy()
        XCTAssertTrue(quiet.evaluate(previous: [running], current: [asking], isolationBreaches: [],
                                     humanHasControl: false, enabled: off, now: now).isEmpty)
    }

    func testAnOperatorPauseWithoutAReasonIsNotAHelpRequest() throws {
        var policy = NotificationPolicy()
        let fired = policy.evaluate(
            previous: [try session(id: "a")],
            current: [try session(id: "a", inputPaused: true)],
            isolationBreaches: [], humanHasControl: false,
            enabled: ViewerNotificationPreferences(), now: now)
        XCTAssertTrue(fired.isEmpty)
    }
}
