import Foundation

/// GET /conversations/{id} devolve a linha crua da conversa (sem `contact_name`, que só existe na lista)
/// e, à parte, o objeto `contact` da agenda vinculado à conversa. Estes auxiliares centralizam o nome a exibir.
extension ConversationDetail {
    /// Nome do contato vinculado, quando houver.
    var linkedContactName: String? {
        guard let name = contact?["name"]?.stringValue?.trimmingCharacters(in: .whitespaces), !name.isEmpty else { return nil }
        return name
    }

    /// Telefone registrado no contato vinculado, quando houver.
    var linkedContactPhone: String? {
        guard let phone = contact?["phone"]?.stringValue, !phone.isEmpty else { return nil }
        return phone
    }

    /// A conversa já tem um contato da agenda vinculado (PUT /contact devolveria 409 contact_already_linked).
    var hasLinkedContact: Bool { contact?["id"]?.stringValue != nil }

    /// Nome a exibir: contato vinculado, senão o nome da conversa (contact_name, título, telefone ou external_id).
    var displayName: String { linkedContactName ?? conversation.displayName }
}
