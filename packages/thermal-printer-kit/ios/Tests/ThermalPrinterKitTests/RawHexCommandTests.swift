import XCTest
@testable import ThermalPrinterKit

final class RawHexCommandTests: XCTestCase {
    func testCommandRequiresExplicitConfirmationAndClearsTheSameBuffer() throws {
        let sender = RecordingRawSender()
        let controller = RawCommandController(sender: sender)

        let confirmation = try controller.prepare("1B 40 0A")

        XCTAssertEqual(confirmation.byteCount, 3)
        XCTAssertEqual(confirmation.warning, rawCommandRiskWarning)
        XCTAssertTrue(confirmation.warning.contains("configuração não volátil"))
        XCTAssertNil(sender.received)

        let completed = expectation(description: "envio concluiu")
        controller.confirm { result in
            if case let .failure(error) = result {
                XCTFail("O sender controlado não deveria falhar: \(error.localizedDescription)")
            }
            completed.fulfill()
        }
        let inFlight = try XCTUnwrap(sender.received)
        XCTAssertEqual(
            Data(bytes: inFlight.bytes, count: inFlight.length),
            Data([0x1b, 0x40, 0x0a])
        )
        sender.complete()
        wait(for: [completed], timeout: 1)

        let received = try XCTUnwrap(sender.received)
        let clearedBytes = Data(bytes: received.bytes, count: received.length)
        XCTAssertEqual(clearedBytes, Data(repeating: 0, count: 3))
    }

    func testCommandIsLimitedTo256BytesWithoutRepeatingInputInTheError() {
        let text = String(repeating: "AA", count: 257)

        XCTAssertThrowsError(try RawHexCommand(text: text)) { error in
            XCTAssertEqual((error as? RawHexCommandError)?.errorDescription, "O comando cru pode ter no máximo 256 bytes.")
            XCTAssertFalse(error.localizedDescription.contains(text))
        }
    }

    func testDescriptionRedactsBytes() throws {
        let command = try RawHexCommand(text: "1B 40")

        XCTAssertFalse(command.description.localizedCaseInsensitiveContains("1B"))
        XCTAssertTrue(command.description.contains("[REDACTED]"))
        command.clear()
    }
}

private final class RecordingRawSender: RawCommandSending {
    var received: NSMutableData?
    private var completion: ((Result<Void, Error>) -> Void)?

    func send(_ buffer: NSMutableData, completion: @escaping (Result<Void, Error>) -> Void) {
        received = buffer
        self.completion = completion
    }

    func complete() {
        let callback = completion
        completion = nil
        callback?(.success(()))
    }
}
