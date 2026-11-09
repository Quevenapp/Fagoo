import XCTest
@testable import Fagoo

final class SessionIsolationTests: XCTestCase {
    func testDiscoveryRejectsPrivilegedKeyAndInsecureOrigins() throws {
        let base = "https://api.example.test"
        let keyPayload = Data(#"{"role":"service_role"}"#.utf8).base64EncodedString().replacingOccurrences(of:"=",with:"")
        let secret = MobileConfiguration(product:"fagoo",protocolVersion:1,online_required:true,api_url:base,auth_url:"https://auth.example.test",public_key:"a.\(keyPayload).b")
        XCTAssertThrowsError(try secret.validate())
        XCTAssertNil(SessionStore.normalizeServer("http://api.example.test"))
        XCTAssertNil(SessionStore.normalizeServer("https://user:pass@api.example.test"))
        XCTAssertNil(SessionStore.normalizeServer("https://api.example.test?token=hidden"))
        let config = MobileConfiguration(product:"fagoo",protocolVersion:1,online_required:true,api_url:base,auth_url:"https://auth.example.test",public_key:"sb_publishable_synthetic")
        XCTAssertNoThrow(try config.validate())
    }
    func testInvalidatedPrivateClientCannotStartARequest() async throws {
        let api = APIClient(baseURL:URL(string:"https://api.example.test")!) { "synthetic-token" }
        api.invalidate()
        do { let _: JSONValue = try await api.request(.get,"v1/communication/units/00000000-0000-4000-8000-000000000001/conversations"); XCTFail("Invalidated session made a private request") }
        catch { XCTAssertTrue(error is CancellationError) }
    }
    func testPrivateClientNeverFollowsArbitraryPaths() async throws {
        let api = APIClient(baseURL:URL(string:"https://api.example.test")!) { "synthetic-token" }
        for path in ["https://other.example.test", "v1/communication/units/../devices", "v1/communication/units/%2e%2e", "auth/v1/user"] {
            do { let _: JSONValue = try await api.request(.get,path); XCTFail("Invalid path accepted") }
            catch { XCTAssertEqual((error as? APIError)?.status,401) }
        }
        api.invalidate()
    }
    func testInvalidationAfterHeadersDiscardsPrivateResponse() async throws {
        let config=URLSessionConfiguration.ephemeral;config.protocolClasses=[PrivateBoundaryProtocol.self]
        let received=expectation(description:"Private response headers received")
        let api=APIClient(baseURL:URL(string:"https://api.example.test")!,configuration:config) { "synthetic-token" }
        PrivateBoundaryProtocol.handler={ transport in
            XCTAssertEqual(transport.request.value(forHTTPHeaderField:"Authorization"),"Bearer synthetic-token")
            XCTAssertEqual(transport.request.value(forHTTPHeaderField:"X-Fagoo-Client"),"mobile")
            transport.client?.urlProtocol(transport,didReceive:HTTPURLResponse(url:transport.request.url!,statusCode:200,httpVersion:nil,headerFields:["Content-Type":"application/json"])!,cacheStoragePolicy:.notAllowed)
            transport.client?.urlProtocol(transport,didLoad:Data("{\"private\":".utf8))
            received.fulfill()
            // Keep the body incomplete. Cancellation must reject any result already buffered by URLSession.
        }
        defer { PrivateBoundaryProtocol.handler=nil;api.invalidate() }
        let result=Task { try await api.raw(.get,"v1/communication/units/00000000-0000-4000-8000-000000000001/conversations") }
        await fulfillment(of:[received],timeout:3)
        api.invalidate()
        do { _=try await result.value;XCTFail("Private bytes escaped after session invalidation") }
        catch { XCTAssertTrue(error is CancellationError || (error as? URLError)?.code == .cancelled) }
    }
    func testClientRejectsInsecureOrCredentialBearingBaseBeforeTransport() async throws {
        for origin in ["http://api.example.test","https://user:pass@api.example.test","https://api.example.test/nested"] {
            let api=APIClient(baseURL:URL(string:origin)!) { "synthetic-token" }
            defer { api.invalidate() }
            do { let _:JSONValue=try await api.request(.get,"v1/fagoo/context");XCTFail("Invalid base accepted") }
            catch { XCTAssertEqual((error as? APIError)?.status,401) }
        }
    }
    func testDelayedPushCannotCrossAccountUnitInstallationOrMode() {
        let epoch=UUID(),data:[AnyHashable:Any] = ["user_id":"user-a","unit_id":"unit-a","server":"https://api.example.test"]
        let valid=PrivatePushIdentity(epoch:epoch,loggedIn:true,panel:false,user:"user-a",unit:"unit-a",server:"https://api.example.test")
        XCTAssertTrue(valid.accepts(data))
        for state in [
            PrivatePushIdentity(epoch:epoch,loggedIn:true,panel:true,user:"user-a",unit:"unit-a",server:"https://api.example.test"),
            PrivatePushIdentity(epoch:epoch,loggedIn:false,panel:false,user:"user-a",unit:"unit-a",server:"https://api.example.test"),
            PrivatePushIdentity(epoch:epoch,loggedIn:true,panel:false,user:"user-b",unit:"unit-a",server:"https://api.example.test"),
            PrivatePushIdentity(epoch:epoch,loggedIn:true,panel:false,user:"user-a",unit:"unit-b",server:"https://api.example.test"),
            PrivatePushIdentity(epoch:epoch,loggedIn:true,panel:false,user:"user-a",unit:"unit-a",server:"https://other.example.test")
        ] { XCTAssertFalse(state.accepts(data)) }
        XCTAssertFalse(valid.accepts(["user_id":"user-a","unit_id":"unit-a"]))
        XCTAssertNotEqual(valid,PrivatePushIdentity(epoch:UUID(),loggedIn:true,panel:false,user:"user-a",unit:"unit-a",server:"https://api.example.test"))
    }
}

private final class PrivateBoundaryProtocol: URLProtocol {
    static var handler: ((PrivateBoundaryProtocol)->Void)?
    override class func canInit(with request: URLRequest)->Bool { request.url?.host=="api.example.test" }
    override class func canonicalRequest(for request: URLRequest)->URLRequest { request }
    override func startLoading() { Self.handler?(self) }
    override func stopLoading() {}
}
