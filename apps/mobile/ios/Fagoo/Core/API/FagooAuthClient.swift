import Foundation

final class FagooAuthClient {
    private let session: URLSession
    init() {
        let config = URLSessionConfiguration.ephemeral; config.urlCache = nil; config.httpCookieStorage = nil
        config.httpShouldSetCookies = false; config.timeoutIntervalForRequest = 15; config.timeoutIntervalForResource = 20
        session = URLSession(configuration: config, delegate: NoCredentialRedirect(), delegateQueue: nil)
    }
    private func fetch<T: Decodable>(_ url: URL, method: String = "GET", key: String? = nil, token: String? = nil, body: [String: String]? = nil) async throws -> T {
        var request = URLRequest(url: url); request.httpMethod = method
        request.setValue("no-store", forHTTPHeaderField: "Cache-Control"); request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let key { request.setValue(key, forHTTPHeaderField: "apikey") }
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let body { request.httpBody = try JSONEncoder().encode(body); request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        let (stream, response) = try await session.bytes(for: request)
        var data = Data(); for try await byte in stream { guard data.count < 131_072 else { throw URLError(.dataLengthExceedsMaximum) }; data.append(byte) }
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else { throw APIError(status: (response as? HTTPURLResponse)?.statusCode ?? 0, code: "auth_failed", message: "Não foi possível entrar. Confira o acesso, o código e a conexão com o Fagoo.") }
        return try JSONDecoder().decode(T.self, from: data)
    }
    func discover(_ origin: URL) async throws -> MobileConfiguration {
        guard SessionStore.normalizeServer(origin.absoluteString) == origin else { throw URLError(.badURL) }
        let config: MobileConfiguration = try await fetch(origin.appendingPathComponent("fagoo-mobile.json")); try config.validate(); return config
    }
    func password(_ config: MobileConfiguration, email: String, password: String) async throws -> FagooAuthSession {
        try config.validate()
        return try await fetch(URL(string: config.auth_url + "/auth/v1/token?grant_type=password")!, method: "POST", key: config.public_key, body: ["email":email,"password":password])
    }
    func refresh(_ config: MobileConfiguration, token: String) async throws -> FagooAuthSession {
        try config.validate()
        return try await fetch(URL(string: config.auth_url + "/auth/v1/token?grant_type=refresh_token")!, method: "POST", key: config.public_key, body: ["refresh_token":token])
    }
    func factors(_ config: MobileConfiguration, token: String) async throws -> [String] {
        try config.validate()
        struct Factor: Decodable { let id: String; let factor_type: String; let status: String }
        struct AuthUser: Decodable { let factors: [Factor]? }
        let user: AuthUser = try await fetch(URL(string: config.auth_url + "/auth/v1/user")!, key: config.public_key, token: token)
        return (user.factors ?? []).filter { $0.factor_type == "totp" && $0.status == "verified" }.map(\.id)
    }
    func verify(_ config: MobileConfiguration, token: String, factor: String, code: String) async throws -> FagooAuthSession {
        try config.validate()
        guard UUID(uuidString: factor) != nil, code.range(of: "^[0-9]{6}$", options: .regularExpression) != nil else { throw URLError(.userAuthenticationRequired) }
        struct Challenge: Decodable { let id: String }
        let challenge: Challenge = try await fetch(URL(string: config.auth_url + "/auth/v1/factors/\(factor)/challenge")!, method: "POST", key: config.public_key, token: token, body: [:])
        return try await fetch(URL(string: config.auth_url + "/auth/v1/factors/\(factor)/verify")!, method: "POST", key: config.public_key, token: token, body: ["challenge_id":challenge.id,"code":code])
    }
}
