// Whether the Mac is in a state to take on another display, and the latch that stops the engine
// from trying again after a display failed to appear. Making a display while the Mac is short of
// memory can stall the window server for everyone, so the engine would rather refuse.
import Darwin
import Foundation

public enum HostHealth {
    /// nil when healthy, else the problem: "memory_pressure" or "swap_activity".
    public static func problem() -> String? {
        var level: Int32 = 0
        var size = MemoryLayout<Int32>.size
        if sysctlbyname("kern.memorystatus_vm_pressure_level", &level, &size, nil, 0) == 0, level >= 4 {
            return "memory_pressure"
        }
        // Pages written to swap over half a second; a steady trickle is normal, a flood is not.
        guard let first = swapouts() else { return nil }
        usleep(500_000)
        guard let second = swapouts() else { return nil }
        return second &- first > 2048 ? "swap_activity" : nil
    }

    static func swapouts() -> UInt64? {
        var info = vm_statistics64()
        var count = mach_msg_type_number_t(MemoryLayout<vm_statistics64_data_t>.size / MemoryLayout<integer_t>.size)
        let result = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                host_statistics64(mach_host_self(), HOST_VM_INFO64, $0, &count)
            }
        }
        return result == KERN_SUCCESS ? info.swapouts : nil
    }
}

/// The latch: set when a display was asked for and did not appear, cleared by the operator
/// (`workspace-engine safety clear-host-health --operator`) once no workspace display is online.
public struct SafetyLatch {
    let url: URL

    public init(state: URL) {
        url = Paths.engineDir(state: state).appendingPathComponent("display-safety.json")
    }

    /// The reason the latch is set, or nil when the engine may make displays.
    public var reason: String? {
        guard let data = JSONFile.read(url) else { return nil }
        return data["reason"] as? String ?? "unreadable latch"
    }

    public func set(_ reason: String) {
        try? JSONFile.write(["reason": reason, "at": ISO8601DateFormatter().string(from: Date())], to: url)
    }

    public func clear() {
        try? FileManager.default.removeItem(at: url)
    }
}
