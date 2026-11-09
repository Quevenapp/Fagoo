import Foundation
import Security

struct MobileConfiguration: Codable, Equatable {
    let product: String; let protocolVersion: Int; let online_required: Bool
    let api_url: String; let auth_url: String; let public_key: String
    enum CodingKeys: String, CodingKey { case product, protocolVersion = "protocol", online_required, api_url, auth_url, public_key }
    func validate() throws {
        guard product == "fagoo", protocolVersion == 1, online_required,
              SessionStore.normalizeServer(api_url)?.absoluteString == api_url,
              SessionStore.normalizeServer(auth_url)?.absoluteString == auth_url else { throw URLError(.badServerResponse) }
        if public_key.hasPrefix("sb_publishable_") { return }
        let parts = public_key.split(separator: ".")
        guard parts.count == 3, let payload = Self.decodePart(String(parts[1])), payload["role"] as? String == "anon" else { throw URLError(.userAuthenticationRequired) }
    }
    static func decodePart(_ part: String) -> [String: Any]? {
        let normalized = part.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        guard let bytes = Data(base64Encoded: normalized + String(repeating: "=", count: (4 - normalized.count % 4) % 4)) else { return nil }
        return (try? JSONSerialization.jsonObject(with: bytes)) as? [String: Any]
    }
}
struct FagooAuthSession: Codable {
    let access_token: String; let refresh_token: String; let expires_in: Double?
    var expiresAt: Date {
        let parts = access_token.split(separator: ".")
        if parts.count == 3, let expiry = MobileConfiguration.decodePart(String(parts[1]))?["exp"] as? Double { return Date(timeIntervalSince1970: expiry) }
        return .distantPast
    }
    var userID: String? {
        let parts = access_token.split(separator: ".")
        return parts.count == 3 ? MobileConfiguration.decodePart(String(parts[1]))?["sub"] as? String : nil
    }
}
struct PanelEnrollment: Codable { let id: String; let unit_id: String; let token: String; let api_url: String }

/// Secrets are Keychain-only. In-memory cursors are discarded on every operator/mode change.
final class SessionStore {
    private let service = "br.com.queven.fagoo.session"
    private let defaults = UserDefaults.standard
    var configuration: MobileConfiguration? {
        get { defaults.data(forKey: "fagoo.installation").flatMap { try? JSONDecoder().decode(MobileConfiguration.self, from: $0) } }
        set { defaults.set(newValue.flatMap { try? JSONEncoder().encode($0) }, forKey: "fagoo.installation") }
    }
    var webURL: URL? {
        get { defaults.string(forKey: "fagoo.web").flatMap(URL.init(string:)) }
        set { defaults.set(newValue?.absoluteString, forKey: "fagoo.web") }
    }
    var serverURL: URL? { configuration.flatMap { URL(string: $0.api_url) } }
    var auth: FagooAuthSession?
    var token: String? { auth?.access_token }
    var user: User?
    var profileId: String?
    var deviceId: String {
        get { if let value = defaults.string(forKey:"fagoo.pushDeviceId") { return value }; let value = UUID().uuidString.lowercased(); defaults.set(value,forKey:"fagoo.pushDeviceId"); return value }
        set { defaults.set(newValue,forKey:"fagoo.pushDeviceId") }
    }
    var pushToken: String?
    var registeredUnits = Set<String>()
    private var cursors: [String: Int64] = [:]
    func eventCursor(profileId: String) -> Int64 { cursors[profileId] ?? 0 }
    func setEventCursor(_ cursor: Int64, profileId: String) { cursors[profileId] = cursor }
    func savedAuth() throws -> FagooAuthSession? { try read("auth", as: FagooAuthSession.self) }
    func panel() throws -> PanelEnrollment? { try read("panel", as: PanelEnrollment.self) }
    func saveAuth(_ value: FagooAuthSession) throws { try write(value, account: "auth"); auth = value }
    func savePanel(_ value: PanelEnrollment) throws { try write(value, account: "panel") }
    func removePanel() throws { try erase("panel") }
    func clearSession() throws {
        auth = nil; user = nil; profileId = nil; cursors = [:]; registeredUnits = []; pushToken = nil; deviceId = UUID().uuidString.lowercased()
        try erase("auth")
    }
    static func normalizeServer(_ input: String) -> URL? {
        var text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        if !text.contains("://") { text = "https://" + text }
        guard var components = URLComponents(string: text), components.scheme == "https", let host = components.host, !host.isEmpty,
              components.user == nil, components.password == nil, components.query == nil, components.fragment == nil,
              ["", "/"].contains(components.path) else { return nil }
        components.path = ""; if components.port == 443 { components.port = nil }; return components.url
    }
    private func read<T: Decodable>(_ account: String, as type: T.Type) throws -> T? {
        var result: CFTypeRef?
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
            kSecAttrAccount as String: account, kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else { throw PanelFailure.journalUnavailable }
        return try JSONDecoder().decode(type, from: data)
    }
    private func write<T: Encodable>(_ value: T, account: String) throws {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
        let attrs: [String: Any] = [kSecValueData as String: try JSONEncoder().encode(value), kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        var status = SecItemUpdate(query as CFDictionary, attrs as CFDictionary)
        if status == errSecItemNotFound { status = SecItemAdd(query.merging(attrs) { _, new in new } as CFDictionary, nil) }
        guard status == errSecSuccess else { throw PanelFailure.journalUnavailable }
    }
    private func erase(_ account: String) throws {
        let status = SecItemDelete([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account] as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw PanelFailure.journalUnavailable }
    }
}
