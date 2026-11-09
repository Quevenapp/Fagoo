import SwiftUI

/// Textos e formatação compartilhados pelas telas de conversa (pt-BR, fuso do aparelho).
enum ConversationFormatting {
    static func date(_ ms: Int64?) -> String {
        guard let ms, ms > 0 else { return "" }
        let d = Date(timeIntervalSince1970: Double(ms) / 1000)
        let cal = Calendar.current
        let time = timeFormatter.string(from: d)
        if cal.isDateInToday(d) { return "Hoje \(time)" }
        if cal.isDateInYesterday(d) { return "Ontem \(time)" }
        return "\(dayFormatter.string(from: d)) \(time)"
    }

    /// Para a lista: só a hora quando é hoje, "Ontem" ou a data curta.
    static func listDate(_ ms: Int64?) -> String {
        guard let ms, ms > 0 else { return "" }
        let d = Date(timeIntervalSince1970: Double(ms) / 1000)
        let cal = Calendar.current
        if cal.isDateInToday(d) { return timeFormatter.string(from: d) }
        if cal.isDateInYesterday(d) { return "Ontem" }
        return dayFormatter.string(from: d)
    }

    static func time(_ ms: Int64?) -> String {
        guard let ms, ms > 0 else { return "" }
        return timeFormatter.string(from: Date(timeIntervalSince1970: Double(ms) / 1000))
    }

    private static let timeFormatter: DateFormatter = {
        let f = DateFormatter(); f.locale = Locale(identifier: "pt_BR"); f.dateFormat = "HH:mm"; return f
    }()
    private static let dayFormatter: DateFormatter = {
        let f = DateFormatter(); f.locale = Locale(identifier: "pt_BR"); f.dateFormat = "dd/MM"; return f
    }()

    static func stateLabel(_ state: String) -> String {
        switch state {
        case "ai": return "Com a IA"
        case "waiting": return "Na fila"
        case "human": return "Com atendente"
        case "closed": return "Concluído"
        default: return state
        }
    }

    static func stateColor(_ state: String) -> Color {
        switch state {
        case "ai": return .purple
        case "waiting": return .orange
        case "human": return .green
        case "closed": return .gray
        default: return .secondary
        }
    }

    static func deliveryLabel(_ status: String?) -> String? {
        guard let status, !status.isEmpty else { return nil }
        switch status {
        case "sent": return "Enviada"
        case "delivered": return "Entregue"
        case "read": return "Lida"
        case "played": return "Ouvida"
        case "pending": return "Na fila"
        case "sending": return "Enviando"
        case "failed": return "Falhou"
        case "unknown": return "Sem confirmação"
        case "cancelled": return "Cancelada"
        default: return status
        }
    }

    static func deliveryIcon(_ status: String?) -> String? {
        switch status ?? "" {
        case "pending", "sending": return "clock"
        case "sent": return "checkmark"
        case "delivered": return "checkmark.circle"
        case "read", "played": return "checkmark.circle.fill"
        case "failed": return "exclamationmark.circle"
        case "unknown": return "questionmark.circle"
        default: return nil
        }
    }

    static func policyLabel(_ policy: String?) -> String {
        switch policy ?? "mentions" {
        case "off": return "Somente atendimento humano"
        case "all": return "Todas as mensagens"
        default: return "Quando mencionada ou /bot"
        }
    }

    static func callStatusLabel(_ status: String) -> String {
        switch status {
        case "ringing": return "Recebendo ligação"
        case "dialing": return "Chamando"
        case "connecting": return "Conectando áudio"
        case "preaccepted": return "Preparando áudio"
        case "active": return "Em ligação"
        case "completed": return "Encerrada"
        case "missed": return "Não atendida"
        case "rejected": return "Recusada"
        case "failed": return "Falhou"
        case "unknown": return "Sem confirmação"
        default: return status
        }
    }

    static func initial(_ name: String) -> String {
        let trimmed = name.trimmingCharacters(in: .whitespaces)
        guard let first = trimmed.first else { return "?" }
        if first.isNumber || first == "+" { return "#" }
        return String(first).uppercased()
    }

    static func bytes(_ count: Int64) -> String { ByteCountFormatter.string(fromByteCount: count, countStyle: .file) }
}

/// Avatar circular com a inicial do nome.
struct InitialAvatar: View {
    let name: String
    var isGroup = false
    var size: CGFloat = 44

    var body: some View {
        ZStack {
            Circle().fill(Color.accentColor.opacity(0.18))
            if isGroup {
                Image(systemName: "person.3.fill").font(.system(size: size * 0.4)).foregroundStyle(Color.accentColor)
            } else {
                Text(ConversationFormatting.initial(name)).font(.system(size: size * 0.42, weight: .semibold)).foregroundStyle(Color.accentColor)
            }
        }
        .frame(width: size, height: size)
    }
}

/// Chip de estado da conversa.
struct StateChip: View {
    let state: String
    var body: some View {
        Text(ConversationFormatting.stateLabel(state))
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 8).padding(.vertical, 3)
            .background(ConversationFormatting.stateColor(state).opacity(0.15))
            .foregroundStyle(ConversationFormatting.stateColor(state))
            .clipShape(Capsule())
    }
}

/// Etiqueta pequena (tags).
struct TagChip: View {
    let text: String
    var body: some View {
        Text(text)
            .font(.caption2)
            .padding(.horizontal, 6).padding(.vertical, 2)
            .background(Color.secondary.opacity(0.15))
            .clipShape(Capsule())
    }
}
