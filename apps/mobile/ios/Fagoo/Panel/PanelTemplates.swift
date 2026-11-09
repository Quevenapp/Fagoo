import CoreText
import SwiftUI

/**
 Os cinco templates dos painéis (decisão 17, `docs/decisoes.md`; protótipo em
 `Vinki_v3/docs/design/telas-v2-2026-10-31/`). Cada um tem fonte, paleta e
 grade próprias, para leitura a distância em tela pequena. A configuração vem da nuvem para este
 aparelho; template e som são administrados pelo Fagoo web. É o mesmo
 catálogo do Android (`PanelTemplate.kt`, `PanelTheme.kt`).
 */
enum PanelTemplate: String, CaseIterable, Identifiable, Sendable {
    case sinal, clinica, terminal, vitrine, sol

    static let `default`: PanelTemplate = .sinal

    var id: String { rawValue }

    var label: String {
        switch self {
        case .sinal: return "Sinal"
        case .clinica: return "Clínica"
        case .terminal: return "Terminal"
        case .vitrine: return "Vitrine"
        case .sol: return "Sol"
        }
    }

    var fit: String {
        switch self {
        case .sinal: return "Salão grande, gente andando"
        case .clinica: return "Saúde, idosos, baixa visão"
        case .terminal: return "TV na parede, pouca luz"
        case .vitrine: return "Lanchonete, pedidos"
        case .sol: return "Ambiente muito claro"
        }
    }

    /// Identificador desconhecido (inclusive o antigo "balcao") volta ao padrão.
    static func from(id: String?) -> PanelTemplate { id.flatMap(PanelTemplate.init(rawValue:)) ?? .default }
}

/// O destino em duas partes: o rótulo pequeno ("Guichê") e o valor grande ("3").
enum PanelDestination {
    struct Parts: Equatable {
        let label: String
        let value: String
        let long: Bool
    }

    static func split(_ stationLabel: String?) -> Parts {
        let text = (stationLabel ?? "").trimmingCharacters(in: .whitespaces)
        guard !text.isEmpty else { return Parts(label: "Dirija-se ao", value: "Balcão", long: true) }
        if let space = text.lastIndex(of: " ") {
            let token = String(text[text.index(after: space)...])
            let prefix = String(text[..<space]).trimmingCharacters(in: .whitespaces)
            if (1...3).contains(token.count), token.contains(where: \.isNumber), !prefix.isEmpty {
                return Parts(label: prefix, value: token, long: false)
            }
        }
        return Parts(label: "Dirija-se ao", value: text, long: text.count > 3)
    }
}

/// A letra da fila é o começo da senha ("B042"); pedido numérico não tem letra.
enum PanelQueueLetter {
    static func of(_ publicNumber: String) -> Character? {
        guard let first = publicNumber.first, first.isLetter else { return nil }
        return Character(first.uppercased())
    }

    /// A cor vem só da letra: a mesma fila tem a mesma cor em toda tela.
    /// A cor da fila (0 a 3) só pela letra. As iniciais mais comuns no balcão
    /// têm lugar fixo, para Caixa e Geral, ou Geral e Preferencial, nunca
    /// dividirem a cor; as outras seguem o código. É a regra do Android.
    static func index(_ letter: Character?) -> Int {
        guard let upper = letter.map({ Character($0.uppercased()) }) else { return 0 }
        if let fixed = Array("AGCPENRB").firstIndex(of: upper) { return fixed % 4 }
        return Int(upper.unicodeScalars.first?.value ?? 0) % 4
    }
}

/// A hora de uma chamada, no fuso do aparelho.
enum PanelClock {
    static func hhmm(_ iso: String?, zone: TimeZone = .current) -> String? {
        guard let iso else { return nil }
        let parser = ISO8601DateFormatter()
        parser.formatOptions = [.withInternetDateTime]
        var date = parser.date(from: iso)
        if date == nil {
            parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            date = parser.date(from: iso)
        }
        guard let date else { return nil }
        let out = DateFormatter()
        out.locale = Locale(identifier: "pt_BR")
        out.timeZone = zone
        out.dateFormat = "HH:mm"
        return out.string(from: date)
    }
}

extension Color {
    init(hex: UInt32) {
        self.init(red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255, blue: Double(hex & 0xFF) / 255)
    }
}

// MARK: - Fontes

/// As fontes OFL do painel (`Tema/PanelFonts`, com as licenças) vão no pacote
/// e são registradas uma vez, no processo, sem mexer no `Info.plist`. O
/// XcodeGen as copia para a raiz do pacote; a pasta vale se um dia vierem nela.
enum PanelFonts {
    private static let registered: Void = {
        let inFolder = Bundle.main.urls(forResourcesWithExtension: "ttf", subdirectory: "PanelFonts") ?? []
        // Os arquivos se chamam `panel_<família>_<peso>.ttf`, como no Android.
        let atRoot = (Bundle.main.urls(forResourcesWithExtension: "ttf", subdirectory: nil) ?? [])
            .filter { $0.lastPathComponent.hasPrefix("panel_") }
        let urls = inFolder.isEmpty ? atRoot : inFolder
        for url in urls {
            CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil)
        }
    }()

    static func registerOnce() { _ = registered }
}

// MARK: - Estilo

/// O visual de um template. Os valores são os do protótipo e do Android.
struct PanelStyle {
    let template: PanelTemplate
    let displayFont: String
    let textFont: String
    let boldFont: String
    let bg: Color, fg: Color, muted: Color, surface: Color, line: Color
    let headerBg: Color, headerFg: Color, headerLine: Color, headerLineWidth: CGFloat
    let heroBg: Color, heroFg: Color, destBg: Color, destFg: Color, prevDest: Color
    let accent: Color, accentFg: Color, ok: Color, wait: Color
    let queues: [Color]
    let chipFg: Color
    /// O pedido pronto no quadro de retirada: o mesmo par do Android.
    let readyBg: Color, readyFg: Color
    let radius: CGFloat, radiusSmall: CGFloat, border: CGFloat
    let hardShadow: Bool
    let numEm: CGFloat, numHeight: CGFloat
    let upperLabels: Bool, labelTracking: CGFloat, upperNames: Bool, upperDest: Bool
    let arrow: Bool, destPill: Bool, alignStart: Bool, boardTable: Bool, liveTag: Bool, roundChips: Bool
    let italicChips: Bool

    func display(_ size: CGFloat) -> Font { .custom(displayFont, fixedSize: size) }
    func text(_ size: CGFloat) -> Font { .custom(textFont, fixedSize: size) }
    func bold(_ size: CGFloat) -> Font { .custom(boldFont, fixedSize: size) }
    func queueColor(_ index: Int) -> Color { queues[((index % queues.count) + queues.count) % queues.count] }
    func label(_ s: String) -> String { upperLabels ? s.uppercased() : s }
    func name(_ s: String) -> String { upperNames ? s.uppercased() : s }

    static func of(_ template: PanelTemplate) -> PanelStyle {
        switch template {
        case .sinal:
            return PanelStyle(template: template, displayFont: "Overpass-Black", textFont: "Overpass-Regular", boldFont: "Overpass-Bold",
                              bg: Color(hex: 0x0C1A2E), fg: .white, muted: Color(hex: 0xA9B8CC), surface: Color(hex: 0x15263F), line: Color(hex: 0x29405F),
                              headerBg: Color(hex: 0x081322), headerFg: .white, headerLine: Color(hex: 0xFFC72C), headerLineWidth: 4,
                              heroBg: Color(hex: 0xFFC72C), heroFg: Color(hex: 0x0C1A2E), destBg: Color(hex: 0x0C1A2E), destFg: Color(hex: 0xFFC72C), prevDest: Color(hex: 0xFFC72C),
                              accent: Color(hex: 0xFFC72C), accentFg: Color(hex: 0x0C1A2E), ok: Color(hex: 0x3DDC97), wait: Color(hex: 0xFF9F43),
                              queues: [Color(hex: 0x4DA3FF), Color(hex: 0x3DDC97), Color(hex: 0xFF9F43), Color(hex: 0xD7A6FF)], chipFg: Color(hex: 0x0C1A2E), readyBg: Color(hex: 0xFFC72C), readyFg: Color(hex: 0x0C1A2E),
                              radius: 10, radiusSmall: 7, border: 0, hardShadow: false, numEm: 2.75, numHeight: 0.52,
                              upperLabels: true, labelTracking: 0.08, upperNames: false, upperDest: false,
                              arrow: true, destPill: false, alignStart: false, boardTable: false, liveTag: false, roundChips: false, italicChips: true)
        case .clinica:
            return PanelStyle(template: template, displayFont: "AtkinsonHyperlegible-Bold", textFont: "AtkinsonHyperlegible-Regular", boldFont: "AtkinsonHyperlegible-Bold",
                              bg: Color(hex: 0xEDF2F4), fg: Color(hex: 0x0B2530), muted: Color(hex: 0x4A6470), surface: .white, line: Color(hex: 0xD3DEE3),
                              headerBg: .white, headerFg: Color(hex: 0x0B2530), headerLine: Color(hex: 0xD3DEE3), headerLineWidth: 1,
                              heroBg: .white, heroFg: Color(hex: 0x0A5A69), destBg: Color(hex: 0x0A5A69), destFg: .white, prevDest: Color(hex: 0x0A5A69),
                              accent: Color(hex: 0x0A6E7E), accentFg: .white, ok: Color(hex: 0x1E7F4F), wait: Color(hex: 0xA8510B),
                              queues: [Color(hex: 0x0A6E7E), Color(hex: 0x5847C2), Color(hex: 0xA8510B), Color(hex: 0xB3245E)], chipFg: .white, readyBg: Color(hex: 0x0A6E7E), readyFg: .white,
                              radius: 22, radiusSmall: 14, border: 1, hardShadow: false, numEm: 2.85, numHeight: 0.50,
                              upperLabels: false, labelTracking: 0, upperNames: false, upperDest: false,
                              arrow: false, destPill: true, alignStart: false, boardTable: false, liveTag: false, roundChips: true, italicChips: false)
        case .terminal:
            return PanelStyle(template: template, displayFont: "B612-Bold", textFont: "B612-Regular", boldFont: "B612-Bold",
                              bg: Color(hex: 0x050505), fg: Color(hex: 0xEDEDED), muted: Color(hex: 0x8C8C8C), surface: Color(hex: 0x111111), line: Color(hex: 0x2A2A2A),
                              headerBg: Color(hex: 0x050505), headerFg: Color(hex: 0xFFB81C), headerLine: Color(hex: 0x2A2A2A), headerLineWidth: 1,
                              heroBg: Color(hex: 0x111111), heroFg: Color(hex: 0xFFB81C), destBg: Color(hex: 0x111111), destFg: .white, prevDest: .white,
                              accent: Color(hex: 0xFFB81C), accentFg: Color(hex: 0x050505), ok: Color(hex: 0x4ADE80), wait: Color(hex: 0xFF5C39),
                              queues: [Color(hex: 0x38BDF8), Color(hex: 0x4ADE80), Color(hex: 0xFF5C39), Color(hex: 0xC084FC)], chipFg: Color(hex: 0x050505), readyBg: Color(hex: 0x1C1504), readyFg: Color(hex: 0xFFB81C),
                              radius: 3, radiusSmall: 2, border: 1, hardShadow: false, numEm: 2.85, numHeight: 0.50,
                              upperLabels: true, labelTracking: 0.12, upperNames: true, upperDest: true,
                              arrow: false, destPill: false, alignStart: true, boardTable: true, liveTag: true, roundChips: false, italicChips: false)
        case .vitrine:
            return PanelStyle(template: template, displayFont: "Anton-Regular", textFont: "Archivo-Regular", boldFont: "Archivo-ExtraBold",
                              bg: Color(hex: 0xFFD23F), fg: Color(hex: 0x141414), muted: Color(hex: 0x4D3F0C), surface: .white, line: Color(hex: 0x141414),
                              headerBg: Color(hex: 0x141414), headerFg: Color(hex: 0xFFD23F), headerLine: Color(hex: 0x141414), headerLineWidth: 0,
                              heroBg: Color(hex: 0x141414), heroFg: Color(hex: 0xFFD23F), destBg: .white, destFg: Color(hex: 0x141414), prevDest: Color(hex: 0x141414),
                              accent: Color(hex: 0x141414), accentFg: Color(hex: 0xFFD23F), ok: Color(hex: 0x0B7A3B), wait: Color(hex: 0xC2261B),
                              queues: [Color(hex: 0xD7261E), Color(hex: 0x1F5FBF), Color(hex: 0x0B7A3B), Color(hex: 0x7B2CBF)], chipFg: .white, readyBg: Color(hex: 0xFFD23F), readyFg: Color(hex: 0x141414),
                              radius: 16, radiusSmall: 11, border: 3, hardShadow: true, numEm: 2.65, numHeight: 0.56,
                              upperLabels: true, labelTracking: 0.06, upperNames: true, upperDest: true,
                              arrow: false, destPill: true, alignStart: false, boardTable: false, liveTag: false, roundChips: false, italicChips: false)
        case .sol:
            return PanelStyle(template: template, displayFont: "Lexend-ExtraBold", textFont: "Lexend-Regular", boldFont: "Lexend-SemiBold",
                              bg: .white, fg: .black, muted: Color(hex: 0x333333), surface: Color(hex: 0xF2F2F2), line: .black,
                              headerBg: .black, headerFg: .white, headerLine: .black, headerLineWidth: 0,
                              heroBg: Color(hex: 0x0030C8), heroFg: .white, destBg: .black, destFg: .white, prevDest: .black,
                              accent: Color(hex: 0x0030C8), accentFg: .white, ok: Color(hex: 0x00702E), wait: Color(hex: 0xB00020),
                              // Sem cobalto: a fila não pode sumir no bloco cobalto da senha.
                              queues: [Color(hex: 0xD9480F), Color(hex: 0x00702E), Color(hex: 0xB00020), Color(hex: 0x6A1B9A)], chipFg: .white, readyBg: Color(hex: 0x0030C8), readyFg: .white,
                              radius: 0, radiusSmall: 0, border: 3, hardShadow: false, numEm: 3.05, numHeight: 0.50,
                              upperLabels: true, labelTracking: 0.06, upperNames: false, upperDest: false,
                              arrow: false, destPill: false, alignStart: false, boardTable: false, liveTag: false, roundChips: false, italicChips: true)
        }
    }
}

private struct PanelStyleKey: EnvironmentKey {
    static let defaultValue = PanelStyle.of(.default)
}

extension EnvironmentValues {
    var panelStyle: PanelStyle {
        get { self[PanelStyleKey.self] }
        set { self[PanelStyleKey.self] = newValue }
    }
}
