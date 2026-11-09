import XCTest
import UserNotifications
@testable import Fagoo

final class PushRegistrationTests: XCTestCase {
    private func human(epoch: UUID = UUID()) -> PrivatePushIdentity {
        PrivatePushIdentity(epoch: epoch, loggedIn: true, panel: false, user: "qa-user", unit: "qa-unit", server: "https://api.example.test")
    }
    func testAuthorizedResumeWaitsForAPNSBeforeFetchingFCM() {
        var gate = PushRegistrationGate()
        let session = human()
        XCTAssertEqual(gate.next(session, authorization: .authorized, hasAPNSToken: false), .requestAPNS)
        XCTAssertEqual(gate.next(session, authorization: .authorized, hasAPNSToken: false), .none)
        XCTAssertEqual(gate.next(session, authorization: .authorized, hasAPNSToken: true), .none)
        XCTAssertTrue(gate.acceptAPNS(session))
        XCTAssertEqual(gate.next(session, authorization: .authorized, hasAPNSToken: true), .fetchFCM)
        XCTAssertTrue(gate.acceptAPNS(session)) // APNs can rotate its token within this session.
        // A new launch/session cannot reuse a prior acknowledgement, even with a cached token.
        XCTAssertEqual(gate.next(human(), authorization: .authorized, hasAPNSToken: true), .requestAPNS)
    }
    func testDeniedOrUndeterminedPermissionNeverStartsRegistration() {
        var gate = PushRegistrationGate()
        let session = human()
        for status: UNAuthorizationStatus in [.denied, .notDetermined] {
            XCTAssertEqual(gate.next(session, authorization: status, hasAPNSToken: true), .none)
            XCTAssertFalse(gate.acceptAPNS(session))
        }
        XCTAssertEqual(gate.next(session, authorization: .authorized, hasAPNSToken: false), .requestAPNS)
        XCTAssertEqual(gate.next(session, authorization: .denied, hasAPNSToken: true), .none)
        XCTAssertFalse(gate.acceptAPNS(session))
    }
    func testChangedEpochOrPanelDiscardsPendingAPNSCallback() {
        var gate = PushRegistrationGate()
        let previous = human(), current = human()
        XCTAssertEqual(gate.next(previous, authorization: .authorized, hasAPNSToken: false), .requestAPNS)
        XCTAssertFalse(gate.acceptAPNS(current))
        XCTAssertEqual(gate.next(current, authorization: .authorized, hasAPNSToken: true), .requestAPNS)
        let panel = PrivatePushIdentity(epoch: current.epoch, loggedIn: false, panel: true, user: nil, unit: nil, server: current.server)
        XCTAssertFalse(gate.acceptAPNS(panel))
        XCTAssertEqual(gate.next(panel, authorization: .authorized, hasAPNSToken: true), .none)
        XCTAssertFalse(gate.acceptAPNS(current))
    }
    func testFailedOrClearedRegistrationCanRetryOnlyFromCurrentSession() {
        var gate = PushRegistrationGate()
        let session = human()
        XCTAssertEqual(gate.next(session, authorization: .authorized, hasAPNSToken: false), .requestAPNS)
        gate.reset()
        XCTAssertFalse(gate.acceptAPNS(session))
        XCTAssertEqual(gate.next(session, authorization: .authorized, hasAPNSToken: false), .requestAPNS)
        XCTAssertTrue(gate.acceptAPNS(session))
        XCTAssertEqual(gate.next(session, authorization: .authorized, hasAPNSToken: false), .requestAPNS)
    }
}
