// SPDX-License-Identifier: AGPL-3.0-only
import XCTest
@testable import Fagoo

final class PanelSafetyTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)
    private func snapshot() throws -> PanelSnapshot {
        try JSONDecoder().decode(PanelSnapshot.self, from: Data(#"{"unit":{"id":"00000000-0000-4000-8000-000000000001","name":"Unidade","timezone":"America/Sao_Paulo"},"revision":42,"server_time":"2027-01-15T08:00:00Z","config":{"template":"sinal","functions":["chamada","emitir"],"title":"Painel","footer":"","media_enabled":true},"queues":[],"tickets":[{"id":"ticket","display_number":"A001","status":"chamada","desk":"Guichê 2","recalls":1}],"recent_calls":[],"orders":[],"campaigns":[]}"#.utf8))
    }
    private func job(recalls: Int = 1, expires: String = "2099-01-01T00:00:00Z") throws -> PanelJob {
        let object: [String: Any] = ["id":"job", "event_id":"event", "kind":"audio", "claim_id":"claim", "expires_at":expires,
            "payload":["ticket_id":"ticket", "display_number":"A001", "desk":"Guichê 2", "recalls":recalls]]
        return try JSONDecoder().decode(PanelJob.self, from: JSONSerialization.data(withJSONObject: object))
    }
    func testOldRecallsAndExpiredAudioNeverPlay() throws {
        let current = try snapshot()
        XCTAssertTrue(PanelRules.canPlay(try job(), in: current, now: now))
        XCTAssertFalse(PanelRules.canPlay(try job(recalls: 0), in: current, now: now))
        XCTAssertFalse(PanelRules.canPlay(try job(expires: "2020-01-01T00:00:00Z"), in: current, now: now))
    }
    func testPhysicalUncertaintySurvivesRestartWithoutPayloadOrCommandReplay() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let origin = URL(string: "https://synthetic.example.test")!
        let first = try PanelJournal(origin: origin, device: "device", directory: directory)
        try first.setPending("command-id")
        try first.record(PanelEffectReceipt(job: "print-id", claim: "claim-id", result: "incerto"))
        let recovered = try PanelJournal(origin: origin, device: "device", directory: directory)
        XCTAssertEqual(recovered.pendingCommand, "command-id")
        XCTAssertEqual(recovered.receipts.first?.result, "incerto")
        try recovered.confirmed("print-id"); try recovered.setPending(nil)
        let final = try PanelJournal(origin: origin, device: "device", directory: directory)
        XCTAssertTrue(final.receipts.isEmpty); XCTAssertNil(final.pendingCommand)
        let anotherInstallation = try PanelJournal(origin: URL(string: "https://other.example.test")!, device: "device", directory: directory)
        XCTAssertTrue(anotherInstallation.receipts.isEmpty)
    }
    func testDeviceTransportRejectsUnsafeOriginsAndHumanToken() throws {
        let token = "fgd_" + String(repeating: "a", count: 64)
        XCTAssertThrowsError(try PanelAPI(origin: URL(string: "http://api.example.test")!, token: token))
        XCTAssertThrowsError(try PanelAPI(origin: URL(string: "https://user@api.example.test")!, token: token))
        XCTAssertThrowsError(try PanelAPI(origin: URL(string: "https://api.example.test/path")!, token: token))
        XCTAssertThrowsError(try PanelAPI(origin: URL(string: "https://api.example.test")!, token: "human-token"))
        XCTAssertThrowsError(try PanelAPI.base("../../communication"))
    }
}
