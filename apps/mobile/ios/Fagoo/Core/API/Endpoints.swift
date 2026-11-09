import Foundation
extension APIClient {
    // MARK: Perfil
    func profileStatus(_ p: String) async throws -> ProfileStatus { try await request(.get, "v1/communication/units/\(p)/status") }
    func presence(_ p: String) async throws -> [PresenceEntry] { try await request(.get, "v1/communication/units/\(p)/presence") }
    func setPresence(_ p: String, present: Bool, key: String = APIClient.newIdempotencyKey()) async throws -> PresenceResult { try await request(.put, "v1/communication/units/\(p)/presence", body: PresenceRequest(present: present), key: key) }
    func events(_ p: String, after: Int64) async throws -> Events { try await request(.get, "v1/communication/units/\(p)/events", query: ["after": String(after)]) }

    // MARK: Conversas
    func conversations(_ p: String, state: String? = nil, q: String? = nil, cursor: String? = nil, limit: Int = 50) async throws -> Page<Conversation> {
        try await request(.get, "v1/communication/units/\(p)/conversations", query: ["state": state, "q": q, "cursor": cursor, "limit": String(limit)])
    }
    func conversation(_ p: String, id: String) async throws -> ConversationDetail { try await request(.get, "v1/communication/units/\(p)/conversations/\(id)") }
    func act(_ p: String, conversation id: String, _ body: ActionRequest, key: String) async throws -> JSONValue { try await request(.post, "v1/communication/units/\(p)/conversations/\(id)/actions", body: body, key: key) }
    func messageAction(_ p: String, conversation id: String, _ body: MessageActionRequest, key: String = APIClient.newIdempotencyKey()) async throws -> JSONValue { try await request(.post, "v1/communication/units/\(p)/conversations/\(id)/message-actions", body: body, key: key) }
    func groupPolicy(_ p: String, conversation id: String, policy: String, key: String = APIClient.newIdempotencyKey()) async throws -> JSONValue { try await request(.put, "v1/communication/units/\(p)/groups/\(id)/policy", body: GroupPolicyRequest(bot_policy: policy), key: key) }
    func contact(_ p: String, id: String) async throws -> JSONValue { try await request(.get, "v1/communication/units/\(p)/contacts/\(id)") }
    /// PUT /conversations/{id}/contact: cria/vincula o cliente na agenda do perfil (apenas conversas diretas).
    func saveConversationContact(_ p: String, conversation id: String, name: String, phone: String?, key: String = APIClient.newIdempotencyKey()) async throws -> JSONValue {
        var body: [String: String] = ["name": name]
        if let phone, !phone.isEmpty { body["phone"] = phone }
        return try await request(.put, "v1/communication/units/\(p)/conversations/\(id)/contact", body: body, key: key)
    }

    // MARK: Mídia (upload em partes de 5 MiB)
    func uploadCreate(_ p: String, _ body: UploadInit, key: String = APIClient.newIdempotencyKey()) async throws -> UploadCreated { try await request(.post, "v1/communication/units/\(p)/media/uploads", body: body, key: key) }
    func uploadPart(_ p: String, upload id: String, part: Int, data: Data) async throws {
        try await raw(.put, "v1/communication/units/\(p)/media/uploads/\(id)/parts/\(part)", body: data, contentType: "application/octet-stream", key: "\(id):\(part)")
    }
    func uploadComplete(_ p: String, upload id: String, key: String = APIClient.newIdempotencyKey()) async throws -> UploadDone { try await request(.post, "v1/communication/units/\(p)/media/uploads/\(id)/complete", body: [String: String](), key: key) }
    func uploadAbort(_ p: String, upload id: String, key: String = APIClient.newIdempotencyKey()) async throws -> UploadDone { try await request(.post, "v1/communication/units/\(p)/media/uploads/\(id)/abort", body: [String: String](), key: key) }

    /// Envia um arquivo inteiro em partes e devolve o ID da mídia para usar em `attachments`.
    func uploadFile(_ p: String, data: Data, name: String, type: String, progress: ((Double) -> Void)? = nil) async throws -> String {
        let created = try await uploadCreate(p, UploadInit(name: name, type: type, size: Int64(data.count)))
        do {
            let partSize = Int(created.part_size)
            for part in 0..<created.parts {
                let start = part * partSize
                let end = min(start + partSize, data.count)
                try await uploadPart(p, upload: created.id, part: part + 1, data: data.subdata(in: start..<end))
                progress?(Double(part + 1) / Double(created.parts))
            }
            return try await uploadComplete(p, upload: created.id).id
        } catch {
            _ = try? await uploadAbort(p, upload: created.id)
            throw error
        }
    }


}
