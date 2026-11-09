import SwiftUI
extension JSONValue { var serviceId: String { self["id"]?.stringValue ?? "" } }
struct ConversationMenuSheet: View {
    @ObservedObject var vm: ConversationViewModel
    @EnvironmentObject private var container: AppContainer
    @Environment(\.dismiss) private var dismiss
    @State private var menus: [JSONValue] = []
    @State private var error: String?
    @State private var busy = false
    var body: some View {
        AppNavigationStack {
            List {
                Section { Text("Envie o menu para o cliente responder. O envio usa o número desta conversa e exige a janela de 24 horas.").font(.footnote) }
                Button("Enviar menu principal") { send(nil) }
                ForEach(menus.filter { $0["type"]?.stringValue == "submenu" }, id: \.serviceId) { m in Button(m["label"]?.stringValue ?? "Submenu") { send(m.serviceId) } }
                if let error { Text(error).foregroundStyle(.red) }
                if let error = vm.actionError { Text(error).foregroundStyle(.red) }
            }.disabled(busy).navigationTitle("Enviar menu")
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Fechar") { dismiss() } } }
                .task { guard let p = container.profileId else { return }; do { menus = try await container.api.menus(p, connectionId: vm.conversation?.connection_id) } catch { self.error = container.serviceError(error) } }
        }
    }
    private func send(_ id: String?) { busy = true; Task { if await vm.act("menu", menuId: id) { dismiss() }; busy = false } }
}
