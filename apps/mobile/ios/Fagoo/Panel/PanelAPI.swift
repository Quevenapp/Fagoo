// SPDX-License-Identifier: AGPL-3.0-only
import Foundation

struct PanelDevice: Decodable { let id: String; let unit_id: String; let name: String; let capabilities: [String] }
struct PanelUnit: Decodable { let id: String; let name: String; let timezone: String }
struct PanelConfig: Decodable { let template: String; let functions: [String]; let title: String; let footer: String; let media_enabled: Bool }
struct PanelSettings: Decodable { let template: String?; let volume: Float?; let muted: Bool? }
struct PanelQueue: Decodable, Identifiable { let id: String; let name: String; let prefix: String; let active: Bool }
struct PanelTicket: Decodable, Identifiable { let id: String; let display_number: String; let status: String; let desk: String?; let recalls: Int; let last_called_at: String?; let public_token: String?; let tracking_url: String? }
struct PanelOrder: Decodable, Identifiable { let id: String; let code: String; let status: String }
struct PanelCampaign: Decodable, Identifiable {
    let id: String; let title: String; let media_url: String; let media_type: String
    let starts_at: String; let expires_at: String; let duration_seconds: Int; let priority: Int; let surfaces: [String]; let active: Bool
}
struct PanelSnapshot: Decodable {
    let unit: PanelUnit; let revision: Int64; let server_time: String; let config: PanelConfig; let device_settings: PanelSettings?
    let queues: [PanelQueue]; let tickets: [PanelTicket]; let recent_calls: [PanelTicket]; let orders: [PanelOrder]; let campaigns: [PanelCampaign]
}
struct PanelJobPayload: Decodable {
    let ticket_id: String?; let display_number: String?; let desk: String?; let recalls: Int?
    let unit: String?; let queue: String?; let footer: String?; let tracking_url: String?
}
struct PanelJob: Decodable { let id: String; let event_id: String; let kind: String; let payload: PanelJobPayload; let claim_id: String; let expires_at: String }
struct PanelJobs: Decodable { let jobs: [PanelJob] }
struct PanelCommand: Decodable {
    struct Result: Decodable { let ticket: PanelTicket? }
    let ok: Bool; let result: Result?
}
struct PanelCommandReceipt: Decodable { let status: String; let response: PanelCommand? }
enum PanelFailure: Error { case invalidConfiguration, invalidResponse, http(Int), journalUnavailable }

enum PanelRules {
    static func date(_ value: String) -> Date? {
        let parser = ISO8601DateFormatter(); parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = parser.date(from: value) { return date }
        parser.formatOptions = [.withInternetDateTime]; return parser.date(from: value)
    }
    static func canPlay(_ job: PanelJob, in snapshot: PanelSnapshot, now: Date) -> Bool {
        guard job.kind == "audio", let expiry = date(job.expires_at), expiry > now else { return false }
        return snapshot.tickets.contains { $0.id == job.payload.ticket_id && $0.status == "chamada" && $0.desk == job.payload.desk && $0.recalls == job.payload.recalls }
    }
    static func campaigns(_ snapshot: PanelSnapshot, surface: String, now: Date) -> [PanelCampaign] {
        guard snapshot.config.media_enabled else { return [] }
        return snapshot.campaigns.filter {
            $0.active && $0.surfaces.contains(surface) && (date($0.starts_at) ?? .distantFuture) <= now &&
            (date($0.expires_at) ?? .distantPast) > now && URL(string: $0.media_url)?.scheme == "https"
        }.sorted { $0.priority == $1.priority ? $0.id < $1.id : $0.priority > $1.priority }
    }
}

private final class PanelNoRedirect: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}

/// A separate ephemeral client has no human bearer, cookie jar, private cache or chat endpoints.
final class PanelAPI {
    let origin: URL
    private let token: String
    private let session: URLSession
    init(origin: URL, token: String) throws {
        guard origin.scheme == "https", origin.host != nil, origin.user == nil, origin.password == nil,
              origin.query == nil, origin.fragment == nil, ["", "/"].contains(origin.path),
              token.range(of: "^fgd_[a-f0-9]{64}$", options: .regularExpression) != nil else { throw PanelFailure.invalidConfiguration }
        self.origin = origin; self.token = token
        let config = URLSessionConfiguration.ephemeral
        config.urlCache = nil; config.httpCookieStorage = nil; config.httpShouldSetCookies = false
        config.requestCachePolicy = .reloadIgnoringLocalCacheData; config.timeoutIntervalForRequest = 12
        config.timeoutIntervalForResource = 15; config.waitsForConnectivity = false
        session = URLSession(configuration: config, delegate: PanelNoRedirect(), delegateQueue: nil)
    }
    deinit { session.invalidateAndCancel() }
    static func base(_ unit: String) throws -> String {
        guard UUID(uuidString: unit) != nil else { throw PanelFailure.invalidResponse }
        return "/v1/queues/units/\(unit)"
    }
    func request<T: Decodable>(_ path: String, body: [String: Any]? = nil, as type: T.Type = T.self) async throws -> T {
        guard path == "/v1/fagoo/device" || path.hasPrefix("/v1/queues/units/"), !path.contains(".."), !path.contains("%"),
              let url = URL(string: path, relativeTo: origin)?.absoluteURL else { throw PanelFailure.invalidConfiguration }
        var request = URLRequest(url: url)
        request.setValue("FagooDevice \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept"); request.setValue("no-store", forHTTPHeaderField: "Cache-Control")
        if let body { request.httpMethod = "POST"; request.httpBody = try JSONSerialization.data(withJSONObject: body); request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        let (stream, response) = try await session.bytes(for: request)
        guard let http = response as? HTTPURLResponse else { throw PanelFailure.invalidResponse }
        guard (200..<300).contains(http.statusCode) else { throw PanelFailure.http(http.statusCode) }
        var data = Data()
        for try await byte in stream { guard data.count < 2_097_152 else { throw PanelFailure.invalidResponse }; data.append(byte) }
        try Task.checkCancellation()
        return try JSONDecoder().decode(T.self, from: data)
    }
    func device() async throws -> PanelDevice { try await request("/v1/fagoo/device") }
    func snapshot(_ unit: String) async throws -> PanelSnapshot { try await request(Self.base(unit) + "/snapshot") }
    func jobs(_ unit: String, kind: String, claim: String, after: Int64) async throws -> [PanelJob] {
        let result: PanelJobs = try await request(Self.base(unit) + "/effects/claim", body: ["kind": kind, "claim_id": claim, "after_revision": after])
        return result.jobs
    }
    func ack(_ unit: String, receipt: PanelEffectReceipt) async throws {
        struct Ack: Decodable { }
        let _: Ack = try await request(Self.base(unit) + "/effects/ack", body: ["job_id": receipt.job, "claim_id": receipt.claim, "result": receipt.result])
    }
}
