import SwiftUI

struct TeamView: View {
    @EnvironmentObject private var container: AppContainer
    @State private var contacts: [TeamContact] = []
    @State private var history: [InternalChat] = []
    @State private var error: String?
    @State private var loading = true
    @Environment(\.scenePhase) private var scenePhase
    var body: some View {
        List {
            Section { Text("Converse com pessoas e bots da equipe. As mensagens ficam dentro do Fagoo.").font(.footnote).foregroundStyle(.secondary) }
            if loading && contacts.isEmpty { ProgressView("Carregando equipe…") }
            if let error { Text(error).foregroundStyle(.red); Button("Tentar novamente") { Task { await load() } } }
            if !history.isEmpty {
                Section("Conversas internas") { ForEach(history) { chat in
                    if let peer = chat.peer { NavigationLink { InternalChatView(peer: peer, existingId: chat.id) } label: { TeamContactRow(contact: peer) } }
                } }
            }
            Section("Iniciar conversa") { ForEach(contacts.filter { $0.id != container.user?.id }) { contact in
                NavigationLink { InternalChatView(peer: contact) } label: { TeamContactRow(contact: contact) }
            }
            }
            if !loading && contacts.isEmpty && error == nil { Text("Nenhum contato neste perfil.") }
        }
        .navigationTitle("Equipe")
        .refreshable { await load() }
        .task(id: "\(container.profileId ?? ""):\(scenePhase == .active)") {
            guard scenePhase == .active else { return }
            while !Task.isCancelled { await load(); do { try await Task.sleep(nanoseconds: 2_000_000_000) } catch { break } }
        }
    }
    private func load() async {
        guard let p = container.profileId else { return }; let api = container.api
        do { contacts = try await api.team(p).sorted { $0.online != $1.online ? $0.online : $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }; history = try await api.internalChats(p); error = nil }
        catch {
            if let e=error as? APIError,[403,404].contains(e.status) { contacts=[];history=[] }
            if !Task.isCancelled { self.error = container.serviceError(error) }
        }
        loading = false
    }
}

struct TeamContactRow: View {
    let contact: TeamContact
    var body: some View {
        HStack {
            Image(systemName: contact.kind == "bot" ? "cpu" : "person.fill").frame(width: 26)
            VStack(alignment: .leading) {
                Text(contact.name)
                Text("\(contact.kindLabel) · \(contact.online ? "Online" : "Offline")").font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            Circle().fill(contact.online ? Color.green : Color.gray).frame(width: 9, height: 9)
        }
        .accessibilityElement(children: .combine)
    }
}

struct InternalChatView: View {
    let peer: TeamContact
    var existingId: String? = nil
    @EnvironmentObject private var container: AppContainer
    @Environment(\.scenePhase) private var scenePhase
    @State private var chat: InternalChat?
    @State private var draft = ""
    @State private var error: String?
    @State private var busy = false
    @State private var openKey = APIClient.newIdempotencyKey()
    @State private var pending: (text: String, key: String)?
    @State private var confirmDiscard = false
    var body: some View {
        VStack(spacing: 0) {
            Text("Conversa interna · \(peer.kindLabel)").font(.caption).foregroundStyle(.secondary).padding(8)
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 12) {
                        ForEach(chat?.messages ?? []) { message in
                            VStack(alignment: .leading, spacing: 4) {
                                Text(message.author == container.user?.id ? "Você" : peer.name).font(.caption).foregroundStyle(.secondary)
                                Text(message.text).textSelection(.enabled)
                                if let status = message.status, !["sent", "completed"].contains(status) { Text(statusLabel(status)).font(.caption).foregroundStyle(.secondary) }
                            }
                            .padding(12).frame(maxWidth: .infinity, alignment: .leading)
                            .background(message.author == container.user?.id ? Color.accentColor.opacity(0.10) : Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 12))
                            .id(message.id)
                        }
                    }.padding()
                }
                .onChange(of: chat?.messages?.last?.id) { id in if let id { withAnimation { proxy.scrollTo(id, anchor: .bottom) } } }
            }
            if let error { Text(error).font(.footnote).foregroundStyle(.red).padding(.horizontal) }
            if chat == nil { Button("Tentar abrir conversa") { Task { await load() } }.padding().disabled(busy) }
            HStack(alignment: .bottom) {
                AppMultilineField("Mensagem interna", text: $draft, lines: 1...5).textFieldStyle(.roundedBorder).disabled(pending != nil || busy)
                Button { Task { await send() } } label: { if busy { ProgressView() } else { Image(systemName: "paperplane.fill") } }
                    .accessibilityLabel(pending == nil ? "Enviar" : "Tentar envio novamente")
                    .disabled(busy || chat == nil || (pending == nil && draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty))
            }.padding()
            if pending != nil && !busy {
                Text("Envio sem confirmação. Toque em enviar para repetir o mesmo pedido.").font(.caption)
                Button("Parar de tentar") { confirmDiscard = true }.font(.footnote).padding(.bottom, 8)
            }
        }
        .navigationTitle(peer.name).navigationBarTitleDisplayMode(.inline)
        .confirmationDialog("Parar de tentar este envio?", isPresented: $confirmDiscard, titleVisibility: .visible) {
            Button("Descartar tentativa", role: .destructive) { pending = nil; draft = ""; error = nil }
            Button("Continuar tentando", role: .cancel) {}
        } message: { Text("Isso não apaga uma mensagem que já tenha sido enviada. Confira o histórico antes de escrever a mesma mensagem novamente.") }
        .task(id: "\(container.profileId ?? ""):\(scenePhase == .active)") {
            guard scenePhase == .active else { return }
            while !Task.isCancelled { await load(); do { try await Task.sleep(nanoseconds: 2_000_000_000) } catch { break } }
        }
    }
    private func statusLabel(_ status: String) -> String {
        switch status { case "queued", "running", "pending": return "Aguardando resposta"; case "failed": return "Falha na resposta"; case "unknown": return "Sem confirmação"; default: return status }
    }
    private func load() async {
        guard let p = container.profileId else { return }; let api = container.api
        do {
            if chat == nil {
                if let existingId { chat = try await api.internalChat(p, id: existingId) }
                else { chat = try await api.openInternalChat(p, peer: peer.id, key: openKey) }
            }
            if let id = chat?.id { chat = try await api.internalChat(p, id: id) }
            if pending == nil { error = nil }
        } catch { if !Task.isCancelled {
            if let e=error as? APIError,[403,404].contains(e.status) { chat=nil;pending=nil;draft="" }
            self.error = container.serviceError(error)
        } }
    }
    private func send() async {
        guard let p = container.profileId, let id = chat?.id, !busy else { return }
        let api = container.api
        let value = pending ?? (draft.trimmingCharacters(in: .whitespacesAndNewlines), APIClient.newIdempotencyKey())
        guard !value.0.isEmpty else { return }
        pending = value; busy = true
        defer { busy = false }
        do { _ = try await api.sendInternal(p, id: id, text: value.0, key: value.1); pending = nil; draft = ""; error = nil; await load() }
        catch { self.error = container.serviceError(error); if let e = error as? APIError, (400..<500).contains(e.status) && e.status != 408 && e.status != 429 && !["operation_unknown", "idempotency_conflict"].contains(e.code) { pending = nil } }
    }
}
