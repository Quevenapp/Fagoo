import SwiftUI

struct QueueConversation: Codable, Identifiable { let id: String; let state: String; let department_id: String?; let created: Int64 }

struct ConversationsView: View {
    @EnvironmentObject private var container: AppContainer
    @Environment(\.scenePhase) private var phase
    @State private var mine: [Conversation] = []
    @State private var queue: [QueueConversation] = []
    @State private var filter = "mine"
    @State private var search = ""
    @State private var error: String?
    @State private var cursor: String?
    @State private var busy = false
    @State private var claiming: String?
    @State private var claimed: String?
    @State private var keys: [String:String] = [:]
    var body: some View {
        List {
            Picker("Atendimentos",selection:$filter) { Text("Minhas").tag("mine"); if container.currentUnit?.capabilities.contains("communication.claim") == true { Text("Disponíveis").tag("queue") } }.pickerStyle(.segmented)
            if let error { Text(error).foregroundStyle(.red) }
            if filter == "mine" {
                ForEach(mine) { item in NavigationLink { ConversationView(conversationId:item.id) } label: {
                    HStack { InitialAvatar(name:item.displayName,isGroup:item.isGroup); VStack(alignment:.leading,spacing:4) { Text(item.displayName); Text(ConversationFormatting.listDate(item.updated)).font(.caption).foregroundStyle(.secondary) }; Spacer(); StateChip(state:item.state) }
                } }
                if mine.isEmpty && !busy { Text("Nenhum atendimento direcionado ou assumido por você.") }
                if cursor != nil { Button("Carregar mais") { Task { await load(more:true) } }.disabled(busy) }
            } else {
                ForEach(queue) { item in Button { Task { await claim(item.id) } } label: {
                    HStack { Text("Assumir atendimento"); Spacer(); Text(Date(timeIntervalSince1970:Double(item.created)/1000),style:.time).font(.caption) }
                }.disabled(claiming != nil) }
                if queue.isEmpty { Text("Nenhum atendimento disponível na sua fila.") }
            }
            if busy { ProgressView() }
        }.navigationTitle("WhatsApp")
            .searchable(text:$search,prompt:"Buscar nos meus atendimentos")
            .task(id:"\(phase == .active):\(container.profileId ?? ""):\(filter):\(search)") {
                guard phase == .active else { return }; mine = []; queue = []; cursor = nil
                while !Task.isCancelled { await load(); do { try await Task.sleep(nanoseconds:2_000_000_000) } catch { break } }
            }.refreshable { await load() }
            .appNavigationDestination(isPresented:Binding(get:{claimed != nil},set:{if !$0 { claimed = nil }})) { if let claimed { ConversationView(conversationId:claimed) } }
    }
    private func load(more: Bool = false) async {
        guard let unit = container.profileId, !busy else { return }; busy = true; defer { busy = false }
        do {
            if filter == "queue" {
                let page: Page<QueueConversation> = try await container.api.request(.get,"v1/communication/units/\(unit)/queue")
                try Task.checkCancellation(); queue = page.data
            } else {
                let page = try await container.api.conversations(unit,q:search.isEmpty ? nil : search,cursor:more ? cursor : nil)
                try Task.checkCancellation(); mine = more ? mine + page.data.filter { row in !mine.contains { $0.id == row.id } } : page.data; cursor = page.next_cursor
            }
            error = nil
        } catch { if !Task.isCancelled {
            if let e=error as? APIError,[403,404].contains(e.status) { mine=[];queue=[];cursor=nil }
            self.error = container.serviceError(error)
        } }
    }
    private func claim(_ id: String) async {
        guard let unit = container.profileId, claiming == nil else { return }; claiming = id; defer { claiming = nil }
        let key = keys[id] ?? APIClient.newIdempotencyKey(); keys[id] = key
        do { let _: JSONValue = try await container.api.request(.post,"v1/communication/units/\(unit)/conversations/\(id)/actions",body:["action":"claim"],key:key); keys[id] = nil; claimed = id; await load() }
        catch { self.error = container.serviceError(error) }
    }
}
