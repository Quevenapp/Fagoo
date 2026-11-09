import SwiftUI

/// Tela da conversa: cabeçalho com estado/responsável, menu de ações, mensagens e composer.
struct ConversationView: View {
    @EnvironmentObject private var container: AppContainer
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var vm: ConversationViewModel
    let conversationId: String

    @State private var showTransfer = false
    @State private var confirmResolve = false
    @State private var confirmResume = false

    init(conversationId: String) {
        self.conversationId = conversationId
        _vm = StateObject(wrappedValue: ConversationViewModel(conversationId: conversationId))
    }

    private var profileId: String { container.profileId ?? "" }

    var body: some View {
        VStack(spacing: 0) {
            if let c = vm.conversation {
                header(c)
                Divider()
            }
            content
            if vm.conversation != nil {
                Divider()
                if vm.isOwned, container.currentUnit?.capabilities.contains("communication.reply")==true { ComposerView(vm: vm) } else { lockedNotice }
            }
        }
        .navigationTitle(vm.displayName)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .primaryAction) { actionsMenu } }
        .task(id:scenePhase) {
            guard scenePhase == .active else { return }
            // A transfer event is intentionally hidden from the previous owner. Recheck the detail even without events.
            while !Task.isCancelled { await vm.load(silent:true);do { try await Task.sleep(nanoseconds:2_000_000_000) } catch { break } }
        }
        .onAppear {
            PushManager.shared.visibleConversationId = conversationId
            vm.appear()
        }
        .onDisappear {
            if PushManager.shared.visibleConversationId == conversationId { PushManager.shared.visibleConversationId = nil }
            vm.stopPolling()
        }
        .onChange(of: scenePhase) { phase in
            if phase == .active {
                vm.startPolling()
                Task { await vm.load(silent: true) }
            } else {
                vm.stopPolling()
            }
        }
        .sheet(isPresented: $showTransfer) { TransferSheet(vm: vm) }
        .confirmationDialog("Concluir este atendimento?", isPresented: $confirmResolve, titleVisibility: .visible) {
            Button("Concluir", role: .destructive) { Task { await vm.act("resolve") } }
            Button("Cancelar", role: .cancel) {}
        } message: { Text("A conversa é marcada como concluída e sai da sua lista.") }
        .confirmationDialog("Devolver a conversa à IA?", isPresented: $confirmResume, titleVisibility: .visible) {
            Button("Devolver à IA") { Task { await vm.act("resume") } }
            Button("Cancelar", role: .cancel) {}
        } message: { Text("O bot do perfil volta a responder o cliente.") }
    }

    // MARK: Cabeçalho

    private func header(_ c: Conversation) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 10) {
                InitialAvatar(name: vm.displayName, isGroup: c.isGroup, size: 40)
                VStack(alignment: .leading, spacing: 2) {
                    Text(vm.displayName).font(.subheadline.weight(.semibold)).lineLimit(1)
                    if let phone = c.phone, !phone.isEmpty, phone != vm.displayName {
                        Text(phone).font(.caption).foregroundStyle(.secondary)
                    } else if c.isGroup {
                        Text("Grupo · \(vm.groupParticipants) participantes").font(.caption).foregroundStyle(.secondary)
                    }
                }
                Spacer()
                VStack(alignment: .trailing, spacing: 2) {
                    StateChip(state: c.state)
                    if let owner = c.owner, !owner.isEmpty {
                        Text("Responsável: \(vm.ownerName(owner))").font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                    }
                }
            }
            let tags = vm.tags
            if !tags.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) { ForEach(tags, id: \.self) { TagChip(text: $0) } }
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(Color(uiColor: .systemBackground))
    }

    // MARK: Mensagens

    @ViewBuilder
    private var content: some View {
        if vm.loading && vm.detail == nil {
            Spacer()
            ProgressView("Carregando conversa…")
            Spacer()
        } else if let error = vm.error, vm.detail == nil {
            VStack(spacing: 12) {
                EmptyStateView(title: "Não foi possível abrir", systemImage: "exclamationmark.triangle", message: error)
                Button("Tentar novamente") { Task { await vm.load() } }.buttonStyle(.bordered)
            }
            .frame(maxHeight: .infinity)
        } else {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 10) {
                        if vm.messages.isEmpty {
                            Text("Nenhuma mensagem ainda.").font(.footnote).foregroundStyle(.secondary).padding(.top, 24)
                        }
                        ForEach(vm.messages) { m in
                            MessageBubbleView(message: m, vm: vm, profileId: profileId).id(m.id)
                        }
                        ForEach(vm.pendingDeliveries) { DeliveryStatusRow(delivery: $0) }
                        Color.clear.frame(height: 1).id("bottom")
                    }
                    .padding(12)
                }
                .appScrollDismissesKeyboard()
                .onChange(of: vm.scrollToken) { _ in
                    withAnimation { proxy.scrollTo("bottom", anchor: .bottom) }
                }
                .onAppear {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { proxy.scrollTo("bottom", anchor: .bottom) }
                }
            }
        }
    }

    private var lockedNotice: some View {
        VStack(spacing: 8) {
            if let e = vm.actionError { Text(e).font(.caption).foregroundStyle(.red) }
            HStack {
                Image(systemName: "lock").foregroundStyle(.secondary)
                Text(lockedText).font(.footnote).foregroundStyle(.secondary)
                Spacer()
                if canClaim {
                    Button {
                        Task { await vm.act("claim") }
                    } label: { if vm.busy { ProgressView() } else { Text("Assumir") } }
                    .buttonStyle(.borderedProminent)
                    .disabled(vm.busy)
                } else if canTakeOver {
                    Button {
                        Task { await vm.act("transfer", target: vm.meId) }
                    } label: { if vm.busy { ProgressView() } else { Text("Assumir para mim") } }
                    .buttonStyle(.borderedProminent)
                    .disabled(vm.busy)
                }
            }
        }
        .padding(12)
        .background(.bar)
    }

    private var lockedText: String {
        guard let c = vm.conversation else { return "" }
        if c.state == "human", let owner = c.owner, owner != vm.meId { return "Em atendimento por \(vm.ownerName(owner))." }
        if c.state == "closed" { return "Conversa concluída. Assuma para responder novamente." }
        return "Assuma a conversa para responder, enviar arquivos ou ligar."
    }

    /// `claim` só vale para conversas sem responsável (fila, IA, concluídas): o servidor devolve 409
    /// already_claimed quando outro atendente é o dono, mesmo para administradores.
    private var canClaim: Bool {
        guard let c = vm.conversation else { return false }
        if c.state == "human", let owner = c.owner, !owner.isEmpty, owner != vm.meId { return false }
        return true
    }

    /// Administrador em conversa de outro atendente: toma a conversa via `transfer` para si mesmo.
    private var canTakeOver: Bool {
        guard let c = vm.conversation, vm.isAdmin, vm.meId != nil else { return false }
        if c.state == "human", let owner = c.owner, !owner.isEmpty, owner != vm.meId { return true }
        return false
    }

    // MARK: Menu de ações

    private var actionsMenu: some View {
        Menu {
            if let c = vm.conversation {
                if !vm.isOwned, canClaim {
                    Button { Task { await vm.act("claim") } } label: { Label("Assumir", systemImage: "hand.raised") }
                } else if !vm.isOwned, canTakeOver {
                    Button { Task { await vm.act("transfer", target: vm.meId) } } label: { Label("Assumir para mim", systemImage: "hand.raised") }
                }
                if vm.isOwned, c.state != "closed", container.currentUnit?.capabilities.contains("communication.transfer")==true {
                    Button { showTransfer = true } label: { Label("Transferir…", systemImage: "arrow.left.arrow.right") }
                }
                if vm.isOwned {
                    if container.currentUnit?.capabilities.contains("communication.transfer")==true { Button { confirmResume = true } label: { Label("Devolver à IA", systemImage: "cpu") } }
                    if container.currentUnit?.capabilities.contains("communication.reply")==true { Button { confirmResolve = true } label: { Label("Concluir", systemImage: "checkmark.circle") } }
                }
                Divider()
                Button { Task { await vm.load(); await vm.loadPresence() } } label: { Label("Atualizar", systemImage: "arrow.clockwise") }
            }
        } label: {
            Image(systemName: "ellipsis.circle")
        }
        .disabled(vm.conversation == nil)
    }
}
