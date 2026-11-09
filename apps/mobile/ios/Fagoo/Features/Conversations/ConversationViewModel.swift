import Foundation
import Combine
import UIKit
import UniformTypeIdentifiers

/// Arquivo escolhido para envio (galeria, câmera ou arquivos), já em memória.
struct PendingAttachment: Identifiable, Equatable {
    let id: UUID
    var data: Data
    var name: String
    var mimeType: String
    var thumbnail: UIImage?

    init(data: Data, name: String, mimeType: String, thumbnail: UIImage? = nil) {
        id = UUID()
        self.data = data
        self.name = name
        self.mimeType = mimeType
        self.thumbnail = thumbnail
    }

    /// image | video | audio | document (igual a mediaKind do servidor, exceto figurinha).
    var kind: String {
        let m = mimeType.lowercased()
        if m.hasPrefix("image/") { return "image" }
        if m.hasPrefix("video/") { return "video" }
        if m.hasPrefix("audio/") { return "audio" }
        return "document"
    }
    var sizeLabel: String { ByteCountFormatter.string(fromByteCount: Int64(data.count), countStyle: .file) }

    static func == (a: PendingAttachment, b: PendingAttachment) -> Bool { a.id == b.id }

    static func mimeType(for url: URL) -> String {
        if let t = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType { return t }
        return "application/octet-stream"
    }
}

struct LocationDraft: Equatable {
    var latitude: Double
    var longitude: Double
    var name: String = ""
    var address: String = ""
}

struct ContactDraft: Equatable {
    var name: String
    var phone: String
}

/// Pedido de envio já montado (anexos enviados) guardado com a mesma Idempotency-Key para repetição segura.
struct PendingRequest {
    var body: ActionRequest
    var key: String
    var summary: String
}

enum SendKind: String, CaseIterable, Identifiable {
    case auto = "text", document
    var id: String { rawValue }
    var title: String { self == .auto ? "Automático pelo arquivo" : "Enviar como documento" }
}

/// Estado da tela de uma conversa: detalhe, presença, ações e composer.
@MainActor
final class ConversationViewModel: ObservableObject {
    let conversationId: String

    @Published private(set) var detail: ConversationDetail?
    @Published private(set) var presence: [PresenceEntry] = []
    @Published private(set) var team: [TeamContact] = []
    @Published private(set) var loading = false
    @Published var error: String?
    @Published var actionError: String?
    @Published var info: String?
    @Published private(set) var busy = false
    @Published private(set) var progress: String?
    @Published private(set) var scrollToken = 0

    // Composer
    @Published var draft = ""
    @Published var quote: Message?
    @Published var editing: Message?
    @Published var attachments: [PendingAttachment] = []
    @Published var voice: VoiceRecording?
    @Published var sendKind: SendKind = .auto
    @Published var location: LocationDraft?
    @Published var contactDraft: ContactDraft?
    @Published private(set) var pending: PendingRequest?

    private var key = APIClient.newIdempotencyKey()
    private var poller: EventsPoller?
    private var sendTask: Task<Void, Never>?
    private var loadedOnce = false
    private var reading = false
    private var pendingAction: (body: ActionRequest, key: String)?

    private var container: AppContainer { AppContainer.shared }
    private let api: APIClient
    private var profileId: String? { container.profileId }

    init(conversationId: String) {
        self.conversationId = conversationId
        self.api = AppContainer.shared.api
    }

    // MARK: Leitura

    var conversation: Conversation? { detail?.conversation }
    /// Nome a exibir (contato vinculado antes do nome cru da conversa).
    var displayName: String { detail?.displayName ?? "Conversa" }
    var linkedContactName: String? { detail?.linkedContactName }
    var linkedContactPhone: String? { detail?.linkedContactPhone }
    var hasLinkedContact: Bool { detail?.hasLinkedContact ?? false }
    var messages: [Message] { detail?.messages ?? [] }
    var meId: String? { container.user?.id }
    var isAdmin: Bool { false }
    var isOwned: Bool { conversation?.isOwned(by: meId) ?? false }
    var isGroup: Bool { conversation?.isGroup ?? false }
    func can(_ feature: String) -> Bool { detail?.can(feature) ?? false }
    var tags: [String] { JSONValue.parseStringList(conversation?.tags) }
    var pendingDeliveries: [Delivery] { (detail?.deliveries ?? []).filter { !["sent", "cancelled"].contains($0.status) } }
    var groupParticipants: Int {
        guard let group = detail?.group, let value = group["participants"] else { return 0 }
        if let list = value.arrayValue { return list.count }
        return JSONValue.parse(value.stringValue).arrayValue?.count ?? 0
    }
    var groupAnnouncementOnly: Bool { detail?.group?["announcement"]?.boolValue ?? false }

    func media(for id: String) -> MediaFile {
        detail?.media.first { $0.id == id } ?? MediaFile(id: id, name: "Anexo", type: "application/octet-stream", size: 0)
    }

    func ownerName(_ id: String?) -> String {
        guard let id, !id.isEmpty else { return "" }
        if id == meId { return "Você" }
        return presence.first { $0.actor == id }?.name ?? id
    }

    func authorLabel(_ m: Message) -> String {
        if m.isNote { return "Nota interna · " + ownerName(m.author) }
        if m.isIncoming { return m.contentJSON["participant_name"]?.stringValue ?? (isGroup ? "Participante" : "Cliente") }
        if m.direction == "system" { return "Sistema" }
        if m.author == meId { return "Você" }
        return ownerName(m.author).isEmpty ? "Equipe" : ownerName(m.author)
    }

    func quotedText(for m: Message) -> String? {
        let c = m.contentJSON
        guard c["reply_to"] != nil || c["reply_external_id"] != nil else { return nil }
        if let t = c["reply_text"]?.stringValue, !t.isEmpty { return t }
        let replyTo = c["reply_to"]?.stringValue
        let ext = c["reply_external_id"]?.stringValue
        if let q = messages.first(where: { ($0.id == replyTo && replyTo != nil) || (ext != nil && $0.external_id == ext) }), !q.text.isEmpty { return q.text }
        return "Mensagem citada"
    }

    var canSend: Bool {
        guard isOwned, !busy, container.currentUnit?.capabilities.contains("communication.reply")==true else { return false }
        if pending != nil { return true }
        if editing != nil { return !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        return !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !attachments.isEmpty || voice != nil || location != nil || contactDraft != nil
    }

    var composerLocked: Bool { busy || pending != nil }

    // MARK: Carga e eventos

    func appear() {
        if !loadedOnce {
            loadedOnce = true
            Task { await load() }
            Task { await loadPresence() }
        }
        startPolling()
    }

    func load(silent: Bool = false) async {
        guard let p = profileId, !reading else { return }
        reading=true;defer { reading=false;loading=false }
        if !silent, detail == nil { loading = true }
        do {
            let d = try await api.conversation(p, id: conversationId)
            try Task.checkCancellation();try api.checkValid()
            let grew = (detail?.messages.count ?? 0) < d.messages.count
            detail = d
            error = nil
            if grew { scrollToken += 1 }
        } catch {
            if error is CancellationError || (error as? URLError)?.code == .cancelled { return }
            if let e = error as? APIError, e.isUnauthorized { container.handleUnauthorized(); return }
            if let e=error as? APIError,[403,404].contains(e.status) {
                detail=nil;presence=[];team=[];pending=nil;pendingAction=nil;sendTask?.cancel();clearComposer()
                self.error="Este atendimento não está mais disponível para você."
                await MediaLoader.shared.clear();return
            }
            if detail == nil { self.error = APIError.describe(error) } else { actionError = APIError.describe(error) }
        }
    }

    func loadPresence() async {
        guard let p = profileId else { return }
        if let list = try? await api.presence(p) { presence = list }
        do { team = try await api.team(p) } catch { actionError = APIError.describe(error) }
    }

    func startPolling() {
        guard let p = profileId else { return }
        if let poller, poller.isRunning { return }
        let id = conversationId
        poller = EventsPoller(container: container, profileId: p) { [weak self] events in
            guard let self else { return }
            let relevant = events.contains { e in
                (e.isConversationRelated && e.conversationId == id) || (e.isCallRelated && e.conversationId == id)
            }
            if relevant { Task { await self.load(silent: true) } }
        }
        poller?.start()
    }

    func stopPolling() {
        poller?.stop()
        poller = nil
    }

    // MARK: Ações da conversa

    @discardableResult
    func act(_ action: String, text: String? = nil, target: String? = nil, tags: [String]? = nil, menuId: String? = nil) async -> Bool {
        guard let p = profileId else { return false }
        busy = true
        actionError = nil
        defer { busy = false }
        let body = ActionRequest(action: action, text: text, target: target, attachments: nil, content: nil, tags: tags, menu_id: menuId)
        let actionKey = pendingAction?.body == body ? pendingAction!.key : APIClient.newIdempotencyKey()
        pendingAction = (body, actionKey)
        do {
            _ = try await api.act(p, conversation: conversationId, body, key: actionKey)
            pendingAction = nil
            await load(silent: true)
            return true
        } catch {
            if let e = error as? APIError, (400..<500).contains(e.status) && ![408, 429].contains(e.status) && !["operation_unknown", "idempotency_conflict"].contains(e.code) { pendingAction = nil }
            handleActionError(error)
            return false
        }
    }

    func sendNote() async {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        if await act("note", text: text) {
            draft = ""
            scrollToken += 1
        }
    }

    func setPolicy(_ policy: String) async {
        guard let p = profileId else { return }
        busy = true
        actionError = nil
        defer { busy = false }
        do {
            _ = try await api.groupPolicy(p, conversation: conversationId, policy: policy)
            await load(silent: true)
        } catch { handleActionError(error) }
    }

    func saveContact(name: String, phone: String) async -> Bool {
        guard let p = profileId else { return false }
        busy = true
        actionError = nil
        defer { busy = false }
        do {
            _ = try await api.saveConversationContact(p, conversation: conversationId, name: name, phone: phone.isEmpty ? nil : phone)
            await load(silent: true)
            return true
        } catch {
            handleActionError(error)
            return false
        }
    }

    // MARK: Ações por mensagem

    func messageAction(_ action: String, message: Message, emoji: String? = nil, text: String? = nil) async {
        guard let p = profileId else { return }
        busy = true
        actionError = nil
        defer { busy = false }
        do {
            _ = try await api.messageAction(p, conversation: conversationId, MessageActionRequest(action: action, message_id: message.id, emoji: emoji, text: text))
            info = action == "reaction" ? nil : "Ação enviada ao canal."
            await load(silent: true)
        } catch { handleActionError(error) }
    }

    func canEdit(_ m: Message) -> Bool {
        can("edit") && m.direction == "outbound" && m.attachmentIds.isEmpty && m.external_id != nil
            && Date().timeIntervalSince1970 * 1000 - Double(m.created) < 15 * 60 * 1000
    }

    func beginEdit(_ m: Message) {
        editing = m
        quote = nil
        draft = m.text
    }

    func cancelEdit() {
        editing = nil
        draft = ""
    }

    // MARK: Envio

    func send() {
        guard sendTask == nil else { return }
        sendTask = Task {
            await performSend()
            sendTask = nil
        }
    }

    func abandonPending() {
        pending = nil
        key = APIClient.newIdempotencyKey()
        actionError = nil
        info = "Pedido abandonado. Confira Entregas no painel antes de reenviar para evitar duplicidade."
    }

    func clearComposer() {
        draft = ""
        quote = nil
        editing = nil
        discardMedia()
        location = nil
        contactDraft = nil
    }

    // Localização e contato são tipos próprios de `content.type` e não aceitam anexos (o servidor responde
    // 400 "Tipo incompatível com o anexo."), então escolher um descarta arquivos/áudio, e vice-versa.

    func setLocation(_ draft: LocationDraft) {
        location = draft
        contactDraft = nil
        dropMediaForStructuredContent()
    }

    func setContactDraft(_ draft: ContactDraft) {
        contactDraft = draft
        location = nil
        dropMediaForStructuredContent()
    }

    /// Acrescenta um arquivo ao envio (até 10) e remove rascunho de localização/contato.
    func addAttachment(_ attachment: PendingAttachment) {
        guard attachments.count < 10 else { return }
        attachments.append(attachment)
        dropStructuredContentForMedia()
    }

    func setVoice(_ recording: VoiceRecording) {
        if let v = voice, v.url != recording.url { try? FileManager.default.removeItem(at: v.url) }
        voice = recording
        dropStructuredContentForMedia()
    }

    private func dropMediaForStructuredContent() {
        guard !attachments.isEmpty || voice != nil else { return }
        discardMedia()
        info = "Anexos removidos: localização e contato são enviados sem arquivos."
    }

    private func dropStructuredContentForMedia() {
        guard location != nil || contactDraft != nil else { return }
        location = nil
        contactDraft = nil
        info = "Localização/contato removidos: eles não podem ir junto com arquivos."
    }

    private func discardMedia() {
        attachments = []
        if let v = voice { try? FileManager.default.removeItem(at: v.url) }
        voice = nil
        sendKind = .auto
    }

    private func performSend() async {
        guard let p = profileId, let c = conversation else { return }
        busy = true
        actionError = nil
        info = nil
        defer { busy = false; progress = nil }
        do {
            if let editing {
                let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !text.isEmpty else { actionError = "Escreva o novo texto da mensagem."; return }
                _ = try await api.messageAction(p, conversation: c.id, MessageActionRequest(action: "edit", message_id: editing.id, emoji: nil, text: text), key: key)
            } else {
                if pending == nil { pending = try await buildRequest(profile: p) }
                guard let req = pending else { return }
                progress = "Confirmando envio…"
                _ = try await api.act(p, conversation: c.id, req.body, key: req.key)
            }
            pending = nil
            key = APIClient.newIdempotencyKey()
            clearComposer()
            await load(silent: true)
            scrollToken += 1
        } catch {
            handleActionError(error)
        }
    }

    /// Envia os anexos e monta o corpo do `reply`. Só roda uma vez por intenção; o resultado fica em `pending`.
    private func buildRequest(profile p: String) async throws -> PendingRequest {
        var ids: [String] = []
        let structured = location != nil || contactDraft != nil
        if structured {
            // location/contacts não aceitam anexos; o composer já descartou arquivos, aqui é só garantia.
        } else if let voice {
            let data = try Data(contentsOf: voice.url)
            ids.append(try await upload(p, data: data, name: voice.fileName, type: voice.mimeType))
        } else {
            for a in attachments {
                ids.append(try await upload(p, data: a.data, name: a.name, type: a.mimeType))
            }
        }
        var content: [String: JSONValue] = [:]
        let type: String
        if let voice { type = voice.contentType }
        else if location != nil { type = "location" }
        else if contactDraft != nil { type = "contacts" }
        else if sendKind == .document, !ids.isEmpty { type = "document" }
        else { type = "text" }
        content["type"] = .string(type)
        if let quote, can("reply") { content["reply_to"] = .string(quote.id) }
        if let l = location {
            content["location"] = .object(["latitude": .number(l.latitude), "longitude": .number(l.longitude), "name": .string(l.name), "address": .string(l.address)])
        }
        if let ct = contactDraft {
            content["contacts"] = .array([.object(["name": .string(ct.name), "phone": .string(ct.phone)])])
        }
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        let body = ActionRequest(action: "reply", text: text, target: nil, attachments: ids.isEmpty ? nil : ids, content: .object(content), tags: nil)
        var parts: [String] = []
        if !text.isEmpty { parts.append("texto") }
        if voice != nil, !structured { parts.append("áudio") }
        if !attachments.isEmpty, voice == nil, !structured { parts.append(attachments.count == 1 ? "1 anexo" : "\(attachments.count) anexos") }
        if location != nil { parts.append("localização") }
        if contactDraft != nil { parts.append("contato") }
        return PendingRequest(body: body, key: key, summary: parts.joined(separator: ", "))
    }

    private func upload(_ p: String, data: Data, name: String, type: String) async throws -> String {
        guard data.count <= 100 * 1024 * 1024 else {
            throw APIError(status: 413, code: "too_large", message: "Cada arquivo pode ter até 100 MB. O canal pode ter limites menores.")
        }
        progress = "Enviando \(name): 0%"
        return try await api.uploadFile(p, data: data, name: name, type: type) { [weak self] fraction in
            let pct = Int((fraction * 100).rounded())
            Task { @MainActor in self?.progress = "Enviando \(name): \(pct)%" }
        }
    }

    // MARK: Erros

    private func handleActionError(_ error: Error) {
        if let e = error as? APIError {
            if e.isUnauthorized { container.handleUnauthorized(); return }
            if e.isIdempotencyConflict {
                key = APIClient.newIdempotencyKey()
                if pending != nil { pending?.key = key }
                actionError = "O servidor já registrou um pedido diferente com esta chave. Uma nova chave foi gerada; confira Entregas e toque em Tentar novamente se precisar."
                return
            }
            if e.code == "unsupported_capability" {
                actionError = "O canal desta conversa não oferece este recurso. " + e.message
                return
            }
        }
        actionError = APIError.describe(error)
    }
}
