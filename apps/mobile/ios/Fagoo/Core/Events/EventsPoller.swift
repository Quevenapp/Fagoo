import Foundation

/// Consulta `GET /profiles/{p}/events?after=cursor` a cada 4 s enquanto a tela está visível.
/// O cursor é persistido por perfil em `SessionStore`; na primeira consulta de um perfil (cursor 0)
/// apenas avançamos o cursor, sem entregar eventos antigos, porque a tela já carrega os dados completos.
@MainActor
final class EventsPoller {
    static let defaultInterval: TimeInterval = 2

    private let container: AppContainer
    private let profileId: String
    private let interval: TimeInterval
    private let handler: ([Event]) -> Void
    private var task: Task<Void, Never>?

    var isRunning: Bool { task != nil }

    init(container: AppContainer, profileId: String, interval: TimeInterval = EventsPoller.defaultInterval, handler: @escaping ([Event]) -> Void) {
        self.container = container
        self.profileId = profileId
        self.interval = interval
        self.handler = handler
    }

    /// Inicia o laço de consulta (idempotente).
    func start() {
        guard task == nil else { return }
        task = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                await self.pollOnce()
                if Task.isCancelled { return }
                try? await Task.sleep(nanoseconds: UInt64(self.interval * 1_000_000_000))
            }
        }
    }

    func stop() {
        task?.cancel()
        task = nil
    }

    /// Uma rodada de consulta; esgota as páginas quando chegam 100 eventos de uma vez.
    func pollOnce() async {
        var rounds = 0
        repeat {
            rounds += 1
            let cursor = container.session.eventCursor(profileId: profileId)
            let result: Events
            do {
                result = try await container.api.events(profileId, after: cursor)
            } catch {
                if let e = error as? APIError, e.isUnauthorized { container.handleUnauthorized() }
                return
            }
            if Task.isCancelled { return }
            if result.cursor > cursor { container.session.setEventCursor(result.cursor, profileId: profileId) }
            if cursor != 0, !result.data.isEmpty { handler(result.data) }
            if result.data.count < 100 || result.cursor <= cursor { return }
        } while rounds < 5
    }
}

extension Event {
    /// Conversa referida pelo evento (payload.conversation_id ou, em `conversation.*`, o próprio recurso).
    var conversationId: String? {
        if let c = payload?["conversation_id"]?.stringValue { return c }
        if kind.hasPrefix("conversation.") { return resource_id ?? payload?["id"]?.stringValue }
        return nil
    }
    var isConversationRelated: Bool { kind.hasPrefix("message.") || kind.hasPrefix("conversation.") }
    var isCallRelated: Bool { kind.hasPrefix("call.") }
}
