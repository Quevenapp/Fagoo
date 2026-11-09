import XCTest
@testable import ThermalPrinterKit

@MainActor
final class ThermalPrintJobQueueTests: XCTestCase {
    func testQueueRunsFiveJobsInFIFOOrder() async {
        let queue = ThermalPrintJobQueue()
        let recorder = QueueRecorder()

        for value in 1...5 {
            queue.accept {
                await recorder.append(value)
                await Task.yield()
                return .delivered
            }
        }

        await waitForCount(5, in: recorder)
        let values = await recorder.snapshot()
        XCTAssertEqual(values, [1, 2, 3, 4, 5])
    }

    func testAcceptedJobFinishesAfterExternalOwnerIsReleased() async {
        let recorder = QueueRecorder()
        var owner: QueueOwner? = QueueOwner()
        weak let releasedOwner = owner

        owner?.accept {
            await recorder.append(1)
            return .delivered
        }
        owner = nil

        await waitForCount(1, in: recorder)
        let values = await recorder.snapshot()
        XCTAssertNil(releasedOwner)
        XCTAssertEqual(values, [1])
    }

    func testCancelPendingEndsRunWithoutExecutingItsOperation() async {
        let queue = ThermalPrintJobQueue()
        let gate = QueueGate()
        let recorder = QueueRecorder()
        queue.accept {
            await gate.wait()
            return .delivered
        }
        await gate.waitUntilBlocked()

        let pending = Task { @MainActor in
            await queue.run {
                await recorder.append(99)
                return .delivered
            }
        }
        await Task.yield()
        queue.cancelPending(returning: .failed(message: "Cancelado.", delivery: .notSent))

        let cancelledResult = await pending.value
        let executedValues = await recorder.snapshot()
        XCTAssertEqual(cancelledResult, .failed(message: "Cancelado.", delivery: .notSent))
        XCTAssertEqual(executedValues, [])
        await gate.open()
    }

    private func waitForCount(_ count: Int, in recorder: QueueRecorder) async {
        for _ in 0..<100 {
            if await recorder.count == count { return }
            await Task.yield()
        }
        XCTFail("A fila não drenou dentro do limite do teste.")
    }
}

private actor QueueGate {
    private var continuation: CheckedContinuation<Void, Never>?

    func wait() async {
        await withCheckedContinuation { continuation = $0 }
    }

    func waitUntilBlocked() async {
        for _ in 0..<100 {
            if continuation != nil { return }
            await Task.yield()
        }
    }

    func open() { continuation?.resume(); continuation = nil }
}

@MainActor
private final class QueueOwner {
    private let queue = ThermalPrintJobQueue()

    func accept(_ operation: @escaping () async -> ThermalPrintResult) {
        queue.accept(operation)
    }
}

private actor QueueRecorder {
    private var values: [Int] = []

    var count: Int { values.count }
    func append(_ value: Int) { values.append(value) }
    func snapshot() -> [Int] { values }
}
