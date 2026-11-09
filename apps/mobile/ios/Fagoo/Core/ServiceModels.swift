import Foundation

struct TeamContact: Codable, Identifiable, Equatable {
    var id: String
    var kind: String
    var name: String
    var online: Bool
    var bot_id: String?
    var line_ids: [String]?
    var kindLabel: String { kind == "bot" ? "Bot" : "Pessoa" }
}

struct ServiceLine: Codable, Identifiable {
    var id: String
    var name: String
    var kind: String
    var mode: String
    var status: String
    var number: String?
    var number_policy: [String: JSONValue]
    var service: LineService
}
struct LineService: Codable, Equatable {
    var mode: String = "inherit"
    var bot_id: String?
    var menu_mode: String = "automatic"
}
struct InternalChat: Codable, Identifiable {
    var id: String
    var peer: TeamContact?
    var messages: [InternalMessage]?
}
struct InternalMessage: Codable, Identifiable {
    var id: String
    var author: String
    var text: String
    var created: Int64
    var status: String?
    var run_id: String?
}

extension AppContainer {
    func serviceError(_ error: Error) -> String {
        if (error as? APIError)?.isUnauthorized == true { handleUnauthorized() }
        return APIError.describe(error)
    }
}

extension APIClient {
    func team(_ p: String) async throws -> [TeamContact] { try await request(.get, "v1/communication/units/\(p)/team", as: Page<TeamContact>.self).data }
    func lines(_ p: String) async throws -> [ServiceLine] { try await request(.get, "v1/communication/units/\(p)/lines", as: Page<ServiceLine>.self).data }
    func saveLine(_ p: String, id: String, body: [String: JSONValue], key: String) async throws -> JSONValue { try await request(.put, "v1/communication/units/\(p)/lines/\(id)", body: body, key: key) }
    func menus(_ p: String, connectionId: String? = nil) async throws -> [JSONValue] { try await request(.get, "v1/communication/units/\(p)/menus", query: ["connection_id": connectionId], as: Page<JSONValue>.self).data }
    func saveMenus(_ p: String, menus: [JSONValue], key: String) async throws -> JSONValue { try await request(.put, "v1/communication/units/\(p)/settings", body: ["menus": JSONValue.array(menus)], key: key) }
    func assignBotLines(_ p: String, id: String, lines: [String]?, key: String) async throws -> JSONValue { try await request(.patch, "v1/communication/units/\(p)/bots/\(id)", body: ["line_ids": lines.map { JSONValue.array($0.map(JSONValue.string)) } ?? .null], key: key) }
    func openInternalChat(_ p: String, peer: String, key: String) async throws -> InternalChat { try await request(.post, "v1/communication/units/\(p)/internal-chats", body: ["peer_id": peer], key: key) }
    func internalChats(_ p: String) async throws -> [InternalChat] { try await request(.get, "v1/communication/units/\(p)/internal-chats", as: Page<InternalChat>.self).data }
    func internalChat(_ p: String, id: String) async throws -> InternalChat { try await request(.get, "v1/communication/units/\(p)/internal-chats/\(id)") }
    func sendInternal(_ p: String, id: String, text: String, key: String) async throws -> JSONValue { try await request(.post, "v1/communication/units/\(p)/internal-chats/\(id)/messages", body: ["text": text], key: key) }
}
