import SwiftUI

/// Transferir para uma pessoa ou bot autorizado a atender esta linha.
struct TransferSheet: View {
    @ObservedObject var vm: ConversationViewModel
    @Environment(\.dismiss) private var dismiss
    @State private var target: TeamContact?
    @State private var busy = false
    private var candidates: [TeamContact] {
        vm.team.filter { p in
            p.id != vm.meId && (p.kind != "bot" || p.line_ids == nil || p.line_ids!.contains(vm.conversation?.connection_id ?? ""))
        }.sorted { $0.online != $1.online ? $0.online : $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }
    var body: some View {
        AppNavigationStack {
            List {
                ForEach(candidates) { p in
                    Button { target = p } label: {
                        HStack { TeamContactRow(contact: p); if target?.id == p.id { Image(systemName: "checkmark") } }
                    }.foregroundStyle(.primary)
                }
                if candidates.isEmpty { Text("Nenhuma pessoa ou bot autorizado para esta linha.") }
                if let error = vm.actionError { Text(error).foregroundStyle(.red) }
            }
            .navigationTitle("Transferir para")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancelar") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Transferir") { guard let target else { return }; busy = true; Task { if await vm.act("transfer", target: target.id) { dismiss() }; busy = false } }.disabled(target == nil || busy)
                }
            }
            .task { await vm.loadPresence() }
        }
    }
}

/// Etiquetas da conversa (até 20, 40 caracteres cada).
struct TagsSheet: View {
    @ObservedObject var vm: ConversationViewModel
    @Environment(\.dismiss) private var dismiss
    @State private var tags: [String] = []
    @State private var newTag = ""
    @State private var busy = false

    var body: some View {
        AppNavigationStack {
            List {
                Section {
                    HStack {
                        TextField("Nova etiqueta", text: $newTag).onSubmit(add)
                        Button("Adicionar", action: add).disabled(newTag.trimmingCharacters(in: .whitespaces).isEmpty || tags.count >= 20)
                    }
                } footer: { Text("Até 20 etiquetas com 40 caracteres cada.") }
                Section {
                    if tags.isEmpty { Text("Nenhuma etiqueta").foregroundStyle(.secondary) }
                    ForEach(tags, id: \.self) { Text($0) }
                        .onDelete { tags.remove(atOffsets: $0) }
                }
                if let e = vm.actionError { Section { Text(e).font(.footnote).foregroundStyle(.red) } }
            }
            .navigationTitle("Etiquetas")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancelar") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        busy = true
                        Task {
                            if await vm.act("tags", tags: tags) { dismiss() }
                            busy = false
                        }
                    } label: { if busy { ProgressView() } else { Text("Salvar") } }
                    .disabled(busy)
                }
            }
            .onAppear { tags = vm.tags }
        }
    }

    private func add() {
        let t = String(newTag.trimmingCharacters(in: .whitespaces).prefix(40))
        guard !t.isEmpty, !tags.contains(t), tags.count < 20 else { return }
        tags.append(t)
        newTag = ""
    }
}

/// Salvar/vincular o cliente na agenda (PUT /conversations/{id}/contact).
struct SaveContactSheet: View {
    @ObservedObject var vm: ConversationViewModel
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var phone = ""
    @State private var busy = false

    var body: some View {
        AppNavigationStack {
            Form {
                Section {
                    TextField("Nome", text: $name)
                    TextField("Telefone", text: $phone).keyboardType(.phonePad)
                } footer: {
                    Text("Cria o contato na agenda do perfil e vincula a esta conversa.")
                }
                if let e = vm.actionError { Section { Text(e).font(.footnote).foregroundStyle(.red) } }
            }
            .navigationTitle("Salvar contato")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancelar") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        busy = true
                        Task {
                            if await vm.saveContact(name: name.trimmingCharacters(in: .whitespaces), phone: AttachmentFactory.normalizePhone(phone)) { dismiss() }
                            busy = false
                        }
                    } label: { if busy { ProgressView() } else { Text("Salvar") } }
                    .disabled(busy || name.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
            .onAppear {
                name = vm.linkedContactName ?? vm.conversation?.contact_name ?? ""
                phone = vm.linkedContactPhone ?? vm.conversation?.phone ?? ""
            }
        }
    }
}
