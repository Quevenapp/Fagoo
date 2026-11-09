import SwiftUI
import UIKit

/// Bolha de mensagem: autor, citação, texto, anexos, localização, contatos, reações, recibo e menu de ações.
struct MessageBubbleView: View {
    let message: Message
    @ObservedObject var vm: ConversationViewModel
    let profileId: String
    @Environment(\.openURL) private var openURL
    @State private var confirmDelete = false

    private var content: JSONValue { message.contentJSON }
    private var isDeleted: Bool { content["deleted"]?.boolValue ?? false }
    private var isEdited: Bool { content["edited"]?.boolValue ?? false }
    private var alignRight: Bool { !message.isIncoming && !message.isNote && message.direction != "system" }

    var body: some View {
        HStack(alignment: .bottom, spacing: 0) {
            if alignRight { Spacer(minLength: 48) }
            VStack(alignment: .leading, spacing: 6) {
                Text(vm.authorLabel(message)).font(.caption2.weight(.semibold)).foregroundStyle(authorColor)
                if let quoted = vm.quotedText(for: message) {
                    HStack(spacing: 6) {
                        RoundedRectangle(cornerRadius: 2).fill(Color.accentColor).frame(width: 3)
                        Text(quoted).font(.caption).foregroundStyle(.secondary).lineLimit(3)
                    }
                    .padding(6)
                    .background(Color.primary.opacity(0.05))
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                }
                if isDeleted {
                    HStack(spacing: 4) {
                        Image(systemName: "trash")
                        Text("Mensagem apagada").italic()
                    }
                    .font(.footnote).foregroundStyle(.secondary)
                } else {
                    if !message.text.isEmpty { Text(message.text).font(.body).textSelection(.enabled) }
                    ForEach(message.attachmentIds, id: \.self) { id in
                        AttachmentView(file: vm.media(for: id), profileId: profileId, isVoiceMessage: content["type"]?.stringValue == "voice")
                    }
                    if let loc = content["location"], let lat = loc["latitude"]?.doubleValue, let lon = loc["longitude"]?.doubleValue {
                        locationView(lat: lat, lon: lon, name: loc["name"]?.stringValue, address: loc["address"]?.stringValue)
                    }
                    if let contacts = content["contacts"]?.arrayValue, !contacts.isEmpty {
                        ForEach(Array(contacts.enumerated()), id: \.offset) { _, ct in
                            contactView(name: ct["name"]?.stringValue ?? "", phone: ct["phone"]?.stringValue ?? "")
                        }
                    }
                }
                footer
            }
            .padding(10)
            .background(bubbleColor)
            .clipShape(RoundedRectangle(cornerRadius: 14))
            .overlay(RoundedRectangle(cornerRadius: 14).stroke(message.isNote ? Color.yellow.opacity(0.6) : Color.clear, lineWidth: 1))
            .contextMenu { menu }
            if !alignRight { Spacer(minLength: 48) }
        }
        .alert("Apagar mensagem?", isPresented: $confirmDelete) {
            Button("Apagar", role: .destructive) { Task { await vm.messageAction("delete", message: message) } }
            Button("Cancelar", role: .cancel) {}
        } message: { Text("A mensagem também será apagada no WhatsApp do cliente.") }
    }

    // MARK: Partes

    private var footer: some View {
        HStack(spacing: 4) {
            let reactions = (content["reactions"]?.objectValue ?? [:]).values.compactMap { $0["emoji"]?.stringValue }.filter { !$0.isEmpty }
            if !reactions.isEmpty {
                Text(reactions.joined(separator: " "))
                    .font(.caption)
                    .padding(.horizontal, 6).padding(.vertical, 2)
                    .background(Color.primary.opacity(0.08))
                    .clipShape(Capsule())
            }
            Spacer(minLength: 0)
            Text(ConversationFormatting.time(message.created)).font(.caption2).foregroundStyle(.secondary)
            if isEdited { Text("· Editada").font(.caption2).foregroundStyle(.secondary) }
            if alignRight, !message.isNote, let label = ConversationFormatting.deliveryLabel(message.delivery_status) {
                HStack(spacing: 2) {
                    if let icon = ConversationFormatting.deliveryIcon(message.delivery_status) {
                        Image(systemName: icon).font(.caption2)
                    }
                    Text(label).font(.caption2)
                }
                .foregroundStyle(message.delivery_status == "failed" ? Color.red : (["read", "played"].contains(message.delivery_status ?? "") ? Color.blue : Color.secondary))
            }
            if let receipts = content["receipts"]?.objectValue, !receipts.isEmpty {
                let read = receipts.values.filter { ["read", "played"].contains($0["status"]?.stringValue ?? "") }.count
                Text("· \(read) leram / \(receipts.count) receberam").font(.caption2).foregroundStyle(.secondary)
            }
        }
    }

    private func locationView(lat: Double, lon: Double, name: String?, address: String?) -> some View {
        Button {
            var c = URLComponents(string: "https://maps.apple.com/")!
            var items = [URLQueryItem(name: "ll", value: "\(lat),\(lon)")]
            if let name, !name.isEmpty { items.append(URLQueryItem(name: "q", value: name)) }
            c.queryItems = items
            if let url = c.url { openURL(url) }
        } label: {
            HStack(spacing: 8) {
                Image(systemName: "mappin.and.ellipse").font(.title3).foregroundStyle(.red)
                VStack(alignment: .leading, spacing: 2) {
                    Text((name?.isEmpty == false ? name! : "Ver localização")).font(.footnote.weight(.medium))
                    if let address, !address.isEmpty { Text(address).font(.caption).foregroundStyle(.secondary).lineLimit(2) }
                    Text(String(format: "%.5f, %.5f", lat, lon)).font(.caption2).foregroundStyle(.secondary)
                }
            }
        }
        .buttonStyle(.plain)
    }

    private func contactView(name: String, phone: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "person.crop.circle").font(.title3).foregroundStyle(Color.accentColor)
            VStack(alignment: .leading, spacing: 2) {
                Text(name.isEmpty ? "Contato" : name).font(.footnote.weight(.medium))
                if !phone.isEmpty {
                    Button(phone) {
                        if let url = URL(string: "tel:\(phone.filter { $0.isNumber || $0 == "+" })") { openURL(url) }
                    }
                    .font(.caption)
                }
            }
        }
    }

    @ViewBuilder
    private var menu: some View {
        let actionable = message.external_id != nil && !message.isNote && !isDeleted && vm.isOwned
        if actionable, vm.can("reply") {
            Button { vm.quote = message; vm.editing = nil } label: { Label("Responder", systemImage: "arrowshape.turn.up.left") }
        }
        if actionable, vm.can("reaction") {
            Menu {
                ForEach(["👍", "❤️", "😊", "🙏"], id: \.self) { emoji in
                    Button(emoji) { Task { await vm.messageAction("reaction", message: message, emoji: emoji) } }
                }
                Button("Remover reação") { Task { await vm.messageAction("reaction", message: message, emoji: "") } }
            } label: { Label("Reagir", systemImage: "face.smiling") }
        }
        if actionable, vm.canEdit(message) {
            Button { vm.beginEdit(message) } label: { Label("Editar", systemImage: "pencil") }
        }
        if actionable, vm.can("delete"), message.direction == "outbound" {
            Button(role: .destructive) { confirmDelete = true } label: { Label("Apagar", systemImage: "trash") }
        }
        if actionable, vm.can("read"), message.isIncoming {
            Button { Task { await vm.messageAction("read", message: message) } } label: { Label("Marcar como lida", systemImage: "envelope.open") }
        }
        if !message.text.isEmpty, !isDeleted {
            Button { UIPasteboard.general.string = message.text } label: { Label("Copiar texto", systemImage: "doc.on.doc") }
        }
    }

    private var bubbleColor: Color {
        if message.isNote { return Color.yellow.opacity(0.18) }
        if message.direction == "system" { return Color.secondary.opacity(0.12) }
        if alignRight { return Color.accentColor.opacity(0.18) }
        return Color(uiColor: .secondarySystemBackground)
    }

    private var authorColor: Color {
        if message.isNote { return .orange }
        if alignRight { return Color.accentColor }
        return .secondary
    }
}

/// Linha de status das entregas ainda não confirmadas (fila/enviando/falhou/sem confirmação).
struct DeliveryStatusRow: View {
    let delivery: Delivery
    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: delivery.status == "failed" ? "exclamationmark.triangle" : "clock")
            Text(ConversationFormatting.deliveryLabel(delivery.status) ?? delivery.status)
            if let e = delivery.error, !e.isEmpty { Text("· \(e)").lineLimit(2) }
        }
        .font(.caption)
        .foregroundStyle(delivery.status == "failed" ? Color.red : Color.secondary)
        .frame(maxWidth: .infinity, alignment: .center)
        .padding(.vertical, 2)
    }
}
