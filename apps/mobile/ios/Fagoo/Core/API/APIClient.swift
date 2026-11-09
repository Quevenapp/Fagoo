import Foundation

final class NoCredentialRedirect: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}

/// One human session. Invalidating it cancels private reads and rejects late results, including media.
final class APIClient {
    let baseURL: URL
    let identity = UUID()
    private let tokenProvider: () -> String?
    let session: URLSession
    private let lock = NSLock()
    private var valid = true
    init(baseURL: URL, configuration: URLSessionConfiguration? = nil, tokenProvider: @escaping () -> String?) {
        self.baseURL = baseURL; self.tokenProvider = tokenProvider
        let config = (configuration?.copy() as? URLSessionConfiguration) ?? URLSessionConfiguration.ephemeral
        config.urlCache = nil; config.httpCookieStorage = nil; config.httpShouldSetCookies = false
        config.requestCachePolicy = .reloadIgnoringLocalCacheData; config.timeoutIntervalForRequest = 30; config.timeoutIntervalForResource = 120
        config.waitsForConnectivity = false
        session = URLSession(configuration: config, delegate: NoCredentialRedirect(), delegateQueue: nil)
    }
    func invalidate() { lock.lock(); valid = false; lock.unlock(); session.invalidateAndCancel() }
    func checkValid() throws { lock.lock(); defer { lock.unlock() }; if !valid { throw CancellationError() } }
    static func newIdempotencyKey() -> String { UUID().uuidString.lowercased() }
    enum Method: String { case get = "GET", post = "POST", put = "PUT", patch = "PATCH", delete = "DELETE" }
    func request<T: Decodable>(_ method: Method, _ path: String, query: [String: String?] = [:], body: (any Encodable)? = nil, key: String? = nil, as type: T.Type = T.self) async throws -> T {
        let data = try await raw(method, path, query: query, body: body.map { try JSONEncoder().encode(AnyEncodable($0)) }, contentType: "application/json", key: key)
        if T.self == OK.self, data.isEmpty { return OK() as! T }
        let result: T
        do { result = try JSONDecoder().decode(T.self, from: data) }
        catch { throw APIError(status: 200, code: "invalid_response", message: "Resposta inesperada do Fagoo.") }
        try checkValid(); try Task.checkCancellation(); return result
    }
    @discardableResult
    func raw(_ method: Method, _ path: String, query: [String: String?] = [:], body: Data? = nil, contentType: String? = nil, key: String? = nil) async throws -> Data {
        try checkValid(); try Task.checkCancellation()
        guard SessionStore.normalizeServer(baseURL.absoluteString) == baseURL,
              (path.hasPrefix("v1/communication/units/") || path.hasPrefix("v1/fagoo/")), !path.contains(".."), !path.contains("%"), !path.contains(":"), !path.contains("\\"),
              let token = tokenProvider(), !token.isEmpty else { throw APIError(status: 401, code: "session_required", message: "Entre novamente no Fagoo.") }
        var components = URLComponents(url: baseURL.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
        components.queryItems = query.compactMap { k, v in v.map { URLQueryItem(name: k, value: $0) } }
        var request = URLRequest(url: components.url!); request.httpMethod = method.rawValue; request.httpBody = body
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("mobile", forHTTPHeaderField: "X-Fagoo-Client"); request.setValue("no-store", forHTTPHeaderField: "Cache-Control")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let key { request.setValue(key, forHTTPHeaderField: "Idempotency-Key") }
        if let contentType { request.setValue(contentType, forHTTPHeaderField: "Content-Type") }
        let (stream, response) = try await session.bytes(for: request)
        try checkValid(); try Task.checkCancellation()
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        let limit = path.hasSuffix("/content") ? 128 * 1024 * 1024 : 8 * 1024 * 1024
        var data = Data()
        for try await byte in stream {
            guard data.count < limit else { throw URLError(.dataLengthExceedsMaximum) }
            if data.count % 65_536 == 0 { try checkValid(); try Task.checkCancellation() }
            data.append(byte)
        }
        try checkValid(); try Task.checkCancellation()
        guard (200..<300).contains(http.statusCode) else {
            let parsed = try? JSONDecoder().decode(APIErrorBody.self, from: data).error
            throw APIError(status: http.statusCode, code: parsed?.code ?? "http_\(http.statusCode)", message: parsed?.message ?? (http.statusCode == 503 ? "Fagoo em manutenção. Aguarde para continuar." : http.statusCode == 403 ? "Sem autorização para esta ação." : "Não foi possível concluir. Confira sua conexão e sessão."))
        }
        return data
    }
}
private struct AnyEncodable: Encodable {
    let value: any Encodable
    init(_ value: any Encodable) { self.value = value }
    func encode(to encoder: Encoder) throws { try value.encode(to: encoder) }
}
