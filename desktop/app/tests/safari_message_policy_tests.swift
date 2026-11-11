import Foundation

@main struct SafariMessagePolicyTests {
    static func main() {
        let accepted = MessagePolicy.reply(["version": "1", "operation": "capabilities"])
        precondition(accepted["status"] == "ok")
        precondition(accepted["window_control"] == "unsupported")
        precondition(accepted["session_sharing"] == "unverified")
        precondition(accepted["input_isolation"] == "unverified")
        let bad: [Any] = [NSNull(), [:], ["version": "2", "operation": "capabilities"],
            ["version": "1", "operation": "open"],
            ["version": "1", "operation": "capabilities", "extra": "secret"],
            ["version": 1, "operation": "capabilities"], String(repeating: "x", count: 10000)]
        for message in bad {
            precondition(MessagePolicy.reply(message) == ["status": "rejected"])
        }
        print("Safari native-message policy: valid probe and seven rejection cases passed")
    }
}
