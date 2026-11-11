import os

/// Payload-free intervals for Instruments: correlate CPU work with allocations and the
/// compositor's GPU timeline. A submission interval is not proof of GPU completion.
public enum PerformanceTrace {
    public static let signposter = OSSignposter(subsystem: "com.spaceo.performance", category: .pointsOfInterest)
}
