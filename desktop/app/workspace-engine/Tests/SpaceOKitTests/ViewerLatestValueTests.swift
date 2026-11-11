import XCTest
@testable import SpaceOViewer

final class ViewerLatestValueTests: XCTestCase {
    func testBusyConsumerKeepsOnlyLatestFrameAndSchedulesOnce() {
        let mailbox = ViewerLatestValue<Int>()
        XCTAssertTrue(mailbox.offer(0))
        for frame in 1...10_000 {
            XCTAssertFalse(mailbox.offer(frame))
        }
        XCTAssertEqual(mailbox.take(), 10_000)
        XCTAssertNil(mailbox.take())
        XCTAssertTrue(mailbox.offer(10_001))
        XCTAssertEqual(mailbox.take(), 10_001)
    }

    func testStreamGenerationsCannotReplaceEachOthersPendingFrames() {
        let oldStream = ViewerLatestValue<Int>()
        let newStream = ViewerLatestValue<Int>()
        XCTAssertTrue(oldStream.offer(1))
        XCTAssertTrue(newStream.offer(2))
        XCTAssertFalse(oldStream.offer(3))
        XCTAssertEqual(newStream.take(), 2)
        XCTAssertEqual(oldStream.take(), 3)
    }

    func testConcurrentProducersScheduleOnlyOneDelivery() {
        let mailbox = ViewerLatestValue<Int>()
        let scheduled = ViewerLatestValue<Int>()
        DispatchQueue.concurrentPerform(iterations: 1_000) { value in
            if mailbox.offer(value) {
                XCTAssertTrue(scheduled.offer(value))
            }
        }
        XCTAssertNotNil(scheduled.take())
        XCTAssertNotNil(mailbox.take())
        XCTAssertTrue(mailbox.offer(1_001))
        XCTAssertEqual(mailbox.take(), 1_001)
    }
}
