import XCTest
@testable import SpaceOKit
@testable import SpaceOViewer

private final class MailboxSchedules: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0
    let ready = DispatchSemaphore(value: 0)
    func schedule() { lock.withLock { count += 1 }; ready.signal() }
    var value: Int { lock.withLock { count } }
}

final class ViewerEventMailboxTests: XCTestCase {
    private func response(_ range: ClosedRange<UInt64>, value: String = "") -> Response {
        var response = Response(ok: true)
        response.events = range.map { DaemonEvent(seq: $0, at: Date(), kind: "agent.action", session: "test",
                                                detail: ["value": value]) }
        return response
    }

    func testFullMailboxSchedulesOnceAndBackpressuresTheReader() {
        let mailbox = ViewerEventMailbox(), schedules = MailboxSchedules()
        defer { mailbox.stop() }
        mailbox.offer(response(1...128), schedule: { schedules.schedule() })
        XCTAssertEqual(schedules.value, 1)
        XCTAssertEqual(mailbox.pendingCount, 128)
        let started = DispatchSemaphore(value: 0), finished = DispatchSemaphore(value: 0)
        let next = response(129...129)
        DispatchQueue.global().async {
            started.signal()
            mailbox.offer(next, schedule: { schedules.schedule() })
            finished.signal()
        }
        XCTAssertEqual(started.wait(timeout: .now() + 2), .success)
        XCTAssertEqual(finished.wait(timeout: .now() + 0.03), .timedOut)
        XCTAssertEqual(mailbox.take()?.events.map(\.seq), Array(1...128))
        XCTAssertEqual(finished.wait(timeout: .now() + 2), .success)
        XCTAssertEqual(mailbox.take()?.events.map(\.seq), [129])
        XCTAssertEqual(schedules.value, 2)
    }

    func testOneLargeResponseDrainsInBoundedOrderedBatchesWithoutDeadlock() {
        let mailbox = ViewerEventMailbox(), schedules = MailboxSchedules()
        defer { mailbox.stop() }
        let input = response(1...1_000)
        DispatchQueue.global().async {
            mailbox.offer(input, schedule: { schedules.schedule() })
            mailbox.finish(schedule: { schedules.schedule() })
        }
        var sequences: [UInt64] = []
        while true {
            guard schedules.ready.wait(timeout: .now() + 2) == .success else { XCTFail("reader stalled"); break }
            guard let batch = mailbox.take() else { XCTFail("scheduled an empty handoff"); break }
            XCTAssertLessThanOrEqual(batch.events.count, ViewerEventMailbox.maximumEvents)
            sequences += batch.events.map(\.seq)
            if batch.closed { break }
        }
        XCTAssertEqual(sequences, Array(1...1_000))
    }

    func testByteLimitBackpressuresEvenWhenEventCountFits() {
        let mailbox = ViewerEventMailbox(), schedules = MailboxSchedules()
        defer { mailbox.stop() }
        let first = response(1...1, value: String(repeating: "x", count: 600_000))
        let second = response(2...2, value: String(repeating: "y", count: 600_000))
        mailbox.offer(first, schedule: { schedules.schedule() })
        let finished = DispatchSemaphore(value: 0)
        DispatchQueue.global().async { mailbox.offer(second, schedule: { schedules.schedule() }); finished.signal() }
        XCTAssertEqual(finished.wait(timeout: .now() + 0.03), .timedOut)
        XCTAssertEqual(mailbox.pendingCount, 1)
        XCTAssertEqual(mailbox.take()?.events.map(\.seq), [1])
        XCTAssertEqual(finished.wait(timeout: .now() + 2), .success)
        XCTAssertEqual(mailbox.take()?.events.map(\.seq), [2])
    }

    func testOversizedEventAndExplicitGapPreserveResyncThroughHeartbeatsAndClose() {
        let mailbox = ViewerEventMailbox(), schedules = MailboxSchedules()
        mailbox.offer(response(1...1, value: String(repeating: "x", count: ViewerEventMailbox.maximumBytes)),
                      schedule: { schedules.schedule() })
        mailbox.offer(Response(ok: true), schedule: { schedules.schedule() })
        mailbox.finish(schedule: { schedules.schedule() })
        let batch = mailbox.take()
        XCTAssertEqual(schedules.value, 1)
        XCTAssertTrue(batch?.events.isEmpty == true)
        XCTAssertEqual(batch?.resyncRequired, true)
        XCTAssertEqual(batch?.closed, true)
        XCTAssertEqual(batch?.receivedOK, true)
        XCTAssertNil(mailbox.take())
        mailbox.offer(response(2...2), schedule: { schedules.schedule() })
        XCTAssertNil(mailbox.take())
    }

    func testExplicitGapIsNotOverwrittenByAHeartbeat() {
        let mailbox = ViewerEventMailbox(), schedules = MailboxSchedules()
        var gap = Response(ok: true)
        gap.resyncRequired = true
        mailbox.offer(gap, schedule: { schedules.schedule() })
        mailbox.offer(Response(ok: true), schedule: { schedules.schedule() })
        XCTAssertEqual(schedules.value, 1)
        XCTAssertEqual(mailbox.take()?.resyncRequired, true)
    }

    func testStopReleasesABlockedReaderAndDiscardsRetiredGeneration() {
        let mailbox = ViewerEventMailbox(), schedules = MailboxSchedules()
        mailbox.offer(response(1...128), schedule: { schedules.schedule() })
        let finished = DispatchSemaphore(value: 0)
        let next = response(129...129)
        DispatchQueue.global().async { mailbox.offer(next, schedule: { schedules.schedule() }); finished.signal() }
        XCTAssertEqual(finished.wait(timeout: .now() + 0.03), .timedOut)
        mailbox.stop()
        XCTAssertEqual(finished.wait(timeout: .now() + 2), .success)
        XCTAssertEqual(mailbox.pendingCount, 0)
        XCTAssertNil(mailbox.take())
        mailbox.finish(schedule: { schedules.schedule() })
        XCTAssertEqual(schedules.value, 1)
    }
}
