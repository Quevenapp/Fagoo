import Foundation

/// O que pode dar errado ao gravar uma configuração declarada. Nenhuma mensagem carrega endereço,
/// identificador de periférico ou qualquer coisa que só existe dentro do registro cifrado.
public enum PrinterManualConfigurationError: Error, Equatable, LocalizedError {
    case installationNotFound
    case printerNotAvailable
    case persistenceFailed
    case adoptionFailed

    public var errorDescription: String? {
        switch self {
        case .installationNotFound:
            return "Esta impressora não está mais instalada neste aparelho."
        case .printerNotAvailable:
            return "Nenhuma impressora em memória para receber esta configuração."
        case .persistenceFailed:
            return "A configuração não pôde ser salva. Nada foi alterado."
        case .adoptionFailed:
            return "A configuração foi salva, mas a impressora não pôde ser confirmada."
        }
    }
}

/**
 As opções operacionais de uma impressora **declaradas por quem usa**, em vez de medidas por sonda.

 Espelha o `ManualConfigurationForm` do Android (`printher/.../PrinterHomologationScreen.kt`): o
 mesmo conjunto de campos, na mesma ordem, e os mesmos acoplamentos entre eles — trocar a largura
 do papel devolve a geometria padrão dela, dizer que não há guilhotina zera comando e avanço, e um
 comando que já carrega avanço embutido recusa avanço separado.

 **Nada aqui é deduzido.** O ponto de partida é o conservador — sem página de código, sem
 guilhotina, a geometria da largura escolhida — e a pessoa muda o que souber. É a mesma regra que
 fez a largura da busca parar de atravessar de uma impressora para a seguinte: um palpite herdado
 sai no papel como cupom quebrado, sem erro em lugar nenhum.

 O que sai daqui é um perfil local `MEASURED`, porque o store neutro não tem outra origem
 persistível — a diferença entre declarado e medido não está na origem, e sim no que esta rota
 **não** afirma: que houve uma nova prova em papel. Diferente do genérico, ele é da pessoa e não é
 sobrescrito por atualização nenhuma; quem o troca é ela, nesta mesma tela.
 */
public struct PrinterManualConfiguration: Equatable, Sendable {
    /// O aviso que acompanha a escolha que dobra acento. `null` de página é o que o `AGENTS.md`
    /// chama de dobra para ASCII, e ela é silenciosa: o cupom sai limpo, legível e errado.
    public static let foldedAccentsWarning =
        "Sem página de código os acentos são simplificados: \"Impressão\" sai \"Impressao\"."

    /// Os dialetos oferecidos, na ordem do Android. `GS V` legado e `NONE` ficam de fora: o
    /// primeiro não é escolha de ninguém e o segundo é a resposta de "não tem guilhotina".
    public static let cutProtocolChoices: [CutProtocol] = [
        .gsV0, .gsV1, .gsV65, .gsV66, .escI, .escM,
    ]

    /// Porta ESC/POS de fábrica. É capacidade do protocolo, não endereço: nenhum IP passa por aqui.
    public static let networkPort = 9_100

    public var displayName: String
    public private(set) var paperWidth: PrinterPaperWidth
    public var printableColumns: Int
    public var printableDots: Int
    public private(set) var hasCutter: Bool
    public private(set) var cutProtocol: CutProtocol
    public private(set) var cutFeedLines: Int
    public private(set) var textEncoding: ThermalTextEncoding
    public private(set) var codePage: ThermalCodePage?
    public private(set) var codePageSelector: UInt8?

    /**
     A firmware entrega o modo de corte que o comando pede?

     Não é campo desta tela — é medição, e a bancada é quem descobre que a GoldenSky corta sempre
     parcial. Ele viaja aqui só para **não se perder** quando alguém troca a página de código de um
     perfil que já foi medido. O Android preserva o mesmo valor pelo mesmo motivo.
     */
    public var cutModeHonored: Bool

    /**
     Os quatro campos que a bancada mede tarde e nenhuma tela de celular declara.

     Eles viajam aqui pela mesma razão de ``cutModeHonored``: para **não se perderem** quando
     alguém troca a página de código de um perfil que já foi medido. `verticalRasterScale` é a
     compensação do encolhimento constante da T210, e perdê-la em silêncio faz foto, logotipo e QR
     voltarem a sair ~20% mais curtos com o cupom saindo normalmente; `maxRasterBytesPerSecond` é o
     freio contra a rajada que corrompeu foto na portátil 58 mm.

     São **API**, não campo de formulário: quem os preenche é quem já tem o comprovante em papel na
     mão, porque é ele que imprime a régua (`Vazão: 38/48 mm | fator 0,79`). Nulo é o estado de
     quem nunca viu a sonda, e continua sendo o padrão. As faixas continuam sendo do
     ``PrinterCapabilities``, que recusa o que estiver fora delas.
     */
    public var maxRasterBytesPerSecond: Int?
    /// Ver ``maxRasterBytesPerSecond``. É o único destes quatro que entra na `capabilityKey`.
    public var verticalRasterScale: Double?
    /// Ver ``maxRasterBytesPerSecond``. Três estados, e `nil` — "ninguém mediu" — é um deles.
    public var nativeQrHonored: Bool?
    /// Ver ``maxRasterBytesPerSecond``.
    public var nativeBarcodeHonored: Bool?

    /**
     Como esta impressora aceita configuração de rede.

     Não é campo desta tela — quem o determina é a tela de rede, com a tira na mão ou com a escolha
     explícita da pessoa. Ele viaja aqui pela razão de ``cutModeHonored``: **para não se perder**
     quando alguém troca a página de código de um perfil que já respondeu. Esta tela reconstrói o
     perfil do zero, e o que ela não carrega some sem erro em lugar nenhum. O Android preserva o
     mesmo valor pelo mesmo motivo.
     */
    public var wifiConfigurationFamily: PrinterWifiConfigurationFamily?

    public init(
        displayName: String,
        paperWidth: PrinterPaperWidth,
        printableColumns: Int,
        printableDots: Int,
        hasCutter: Bool,
        cutProtocol: CutProtocol,
        cutFeedLines: Int,
        textEncoding: ThermalTextEncoding,
        codePage: ThermalCodePage?,
        codePageSelector: UInt8? = nil,
        cutModeHonored: Bool = true,
        maxRasterBytesPerSecond: Int? = nil,
        verticalRasterScale: Double? = nil,
        nativeQrHonored: Bool? = nil,
        nativeBarcodeHonored: Bool? = nil,
        wifiConfigurationFamily: PrinterWifiConfigurationFamily? = nil
    ) {
        self.displayName = displayName
        self.paperWidth = paperWidth
        self.printableColumns = printableColumns
        self.printableDots = printableDots
        self.hasCutter = hasCutter
        self.cutProtocol = cutProtocol
        self.cutFeedLines = cutFeedLines
        self.textEncoding = textEncoding
        self.codePage = codePage
        self.codePageSelector = codePageSelector
        self.cutModeHonored = cutModeHonored
        self.maxRasterBytesPerSecond = maxRasterBytesPerSecond
        self.verticalRasterScale = verticalRasterScale
        self.nativeQrHonored = nativeQrHonored
        self.nativeBarcodeHonored = nativeBarcodeHonored
        self.wifiConfigurationFamily = wifiConfigurationFamily
    }

    /**
     O ponto de partida de quem ainda não declarou nada.

     Sem página, sem guilhotina e a geometria padrão da largura. É o mesmo piso do perfil
     temporário: prometer acento e corte que ninguém provou é como o cupom sai torto sem erro.
     */
    public static func conservative(
        displayName: String,
        paperWidth: PrinterPaperWidth = .mm58
    ) -> PrinterManualConfiguration {
        PrinterManualConfiguration(
            displayName: displayName,
            paperWidth: paperWidth,
            printableColumns: paperWidth.defaultPrintableColumns,
            printableDots: paperWidth.defaultPrintableDots,
            hasCutter: false,
            cutProtocol: .none,
            cutFeedLines: 0,
            textEncoding: .ascii,
            codePage: nil
        )
    }

    /// Abre os campos com o que já vale para esta impressora hoje.
    public init(_ profile: PrinterProfile) {
        self.init(capabilities: profile.capabilities, displayName: profile.displayName)
    }

    public init(_ profile: MeasuredProfile) {
        self.init(capabilities: profile.capabilities, displayName: profile.displayName)
    }

    /// Para quem carrega capacidade e nome sem carregar um ``PrinterProfile`` inteiro — a lista da
    /// tela de instalar é assim.
    public init(capabilities: PrinterCapabilities, displayName: String) {
        self.init(
            displayName: displayName,
            paperWidth: capabilities.paperWidth,
            printableColumns: capabilities.printableColumns,
            printableDots: capabilities.printableDots,
            hasCutter: capabilities.cutProtocol.hasCutter,
            cutProtocol: capabilities.cutProtocol,
            cutFeedLines: capabilities.cutFeedLines,
            textEncoding: capabilities.textEncoding,
            codePage: capabilities.codePage,
            codePageSelector: capabilities.codePageSelector,
            cutModeHonored: capabilities.cutModeHonored,
            maxRasterBytesPerSecond: capabilities.maxRasterBytesPerSecond,
            verticalRasterScale: capabilities.verticalRasterScale,
            nativeQrHonored: capabilities.nativeQrHonored,
            nativeBarcodeHonored: capabilities.nativeBarcodeHonored,
            wifiConfigurationFamily: capabilities.wifiConfigurationFamily
        )
    }

    /**
     A mesma declaração, com o que ela não declara vindo do perfil anterior.

     É o `current?.campo ?: declarado` do Android, dito em Swift: o declarado ganha quando existe —
     quem transcreve uma régua nova está corrigindo a antiga —, e o que ninguém declarou continua
     sendo o que a bancada mediu. Serve ao caso em que a configuração não foi aberta da medição que
     a unidade usa hoje; quando foi, ela já chega com os quatro e isto não muda nada.
     */
    public func preservingLateMeasurements(from previous: MeasuredProfile?) -> Self {
        guard let previous else { return self }
        var preservada = self
        preservada.maxRasterBytesPerSecond =
            maxRasterBytesPerSecond ?? previous.maxRasterBytesPerSecond
        preservada.verticalRasterScale = verticalRasterScale ?? previous.verticalRasterScale
        preservada.nativeQrHonored = nativeQrHonored ?? previous.nativeQrHonored
        preservada.nativeBarcodeHonored = nativeBarcodeHonored ?? previous.nativeBarcodeHonored
        return preservada
    }

    // MARK: - Escolhas acopladas

    /// Trocar a largura devolve a geometria dela. Carregar colunas e dots de uma bobina para a
    /// outra foi como a T210 ganhou 80 mm e 48 colunas de outra impressora e quebrou "impressor /
    /// a" no meio da palavra, porque a firmware dela tem 32.
    public mutating func selectPaperWidth(_ width: PrinterPaperWidth) {
        paperWidth = width
        printableColumns = width.defaultPrintableColumns
        printableDots = width.defaultPrintableDots
    }

    /// Sem guilhotina não há comando nem avanço para escolher; com ela, o piso é o corte total.
    public mutating func selectCutter(_ present: Bool) {
        hasCutter = present
        if !present {
            cutProtocol = .none
            cutFeedLines = 0
        } else if cutProtocol == .none {
            cutProtocol = .gsV0
        }
    }

    /// `GS V 65/66` já carregam o avanço de `0x50`; um `ESC d` adicional só empurraria papel.
    public mutating func selectCutProtocol(_ protocolo: CutProtocol) {
        cutProtocol = protocolo
        hasCutter = protocolo.hasCutter
        if protocolo.hasEmbeddedFeed || protocolo == .none { cutFeedLines = 0 }
    }

    public mutating func selectCutFeedLines(_ lines: Int) {
        guard allowedCutFeedLines.contains(lines) else { return }
        cutFeedLines = lines
    }

    /// As distâncias que o avanço aceita. Comando com avanço embutido admite só o zero.
    public var allowedCutFeedLines: [Int] {
        guard hasCutter, !cutProtocol.hasEmbeddedFeed else { return [0] }
        return PrinterCapabilities.allowedCutFeedLines
    }

    // MARK: - Texto e acentos

    /// A linha da tira que esta configuração representa, quando alguma representa.
    ///
    /// Não é persistida: a letra é função da tira, e uma configuração declarada pode gravar uma
    /// combinação que nenhuma linha imprime.
    public var codePageCandidate: CodePageProbeCandidate? {
        PrinterProbePayloads.codePageCandidates.first { candidate in
            candidate.textEncoding == textEncoding
                && candidate.codePage == codePage
                && (candidate.isAddress ? candidate.selector : nil) == codePageSelector
        }
    }

    /// O seletor só é gravado quando a escolha é um **endereço** de `ESC t`. Nome de página chega
    /// ao papel pelo canônico da própria tabela, e guardar o número junto criaria duas verdades.
    public mutating func select(_ candidate: CodePageProbeCandidate) {
        textEncoding = candidate.textEncoding
        codePage = candidate.codePage
        codePageSelector = candidate.isAddress ? candidate.selector : nil
    }

    /// Verdadeiro quando o texto sai dobrado para ASCII. Ver ``foldedAccentsWarning``.
    public var foldsAccentsToASCII: Bool { textEncoding == .ascii }

    public var warning: String? { foldsAccentsToASCII ? Self.foldedAccentsWarning : nil }

    /**
     O que falta para esta declaração poder ser gravada, dito no campo em que se mexe.

     A validação do perfil recusa com "Geometria de impressão inválida", que é a verdade e não é
     útil: ela não diz onde. Botão apagado em silêncio é a outra metade do mesmo defeito.
     */
    public var blockingHint: String? {
        guard !displayName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return "Dê um nome para reconhecer esta impressora na lista."
        }
        guard PrinterCapabilities.allowedPrintableColumns.contains(printableColumns) else {
            let faixa = PrinterCapabilities.allowedPrintableColumns
            return "Informe quantos caracteres cabem numa linha, de \(faixa.lowerBound) a \(faixa.upperBound)."
        }
        return nil
    }

    // MARK: - O que vira perfil

    public func capabilities(
        transports: Set<PrinterCapabilityTransport>
    ) throws -> PrinterCapabilities {
        try PrinterCapabilities(
            transports: transports,
            paperWidth: paperWidth,
            printableColumns: printableColumns,
            printableDots: printableDots,
            codePage: codePage,
            textEncoding: textEncoding,
            cutProtocol: hasCutter ? cutProtocol : .none,
            cutFeedLines: hasCutter ? cutFeedLines : 0,
            statusProtocol: .none,
            tcpPort: transports.contains(.localWifi) ? Self.networkPort : nil,
            codePageSelector: codePageSelector,
            cutModeHonored: cutModeHonored,
            // Sem estes quatro aqui a medição tardia morre na montagem da capacidade e não alcança
            // nem o disco nem o papel: a rota declarada apagaria em silêncio o fator que faz a foto
            // sair inteira na T210.
            maxRasterBytesPerSecond: maxRasterBytesPerSecond,
            verticalRasterScale: verticalRasterScale,
            nativeQrHonored: nativeQrHonored,
            nativeBarcodeHonored: nativeBarcodeHonored,
            // Sem este repasse, trocar a página de código de um perfil que já respondeu a tela de
            // rede apagaria a resposta — e a tira teria de sair de novo, semanas depois, longe da
            // causa.
            wifiConfigurationFamily: wifiConfigurationFamily
        )
    }

    /**
     O perfil declarado.

     `id` é sempre um UUID local: quem edita uma medição desta pessoa reaproveita o dela — é isso
     que faz a instalação continuar sendo a mesma —, e quem partiu de uma entrada de catálogo
     recebe um UUID novo, porque o catálogo é compartilhado e não se edita.
     */
    public func profile(
        id: String,
        transports: Set<PrinterCapabilityTransport>,
        measuredAt: Date = Date(),
        firmwareVersion: String? = nil
    ) throws -> MeasuredProfile {
        try MeasuredProfile.validated(
            id: id,
            displayName: displayName.trimmingCharacters(in: .whitespacesAndNewlines),
            // Milissegundo é a resolução do store, e o que ele não guarda ele devolve diferente:
            // o perfil relido deixaria de bater com o gravado e a gravação falharia por "não
            // confirmado", já com o papel na mão.
            measuredAt: Self.storedResolution(measuredAt),
            source: .measured,
            capabilities: capabilities(transports: transports),
            firmwareVersion: firmwareVersion
        )
    }

    /**
     Esta declaração é, byte a byte no papel, o perfil que já existe?

     Serve ao caminho de instalar: quem escolheu uma entrada do catálogo e não mexeu em nada entra
     por ela mesma, sem criar uma medição local que ninguém pediu — e sem transformar uma medição
     de bancada, escolhida na lista, numa cópia declarada com outro identificador.
     */
    public func matches(_ profile: PrinterProfile) -> Bool {
        PrinterManualConfiguration(profile) == self
    }

    /// A data seguinte à da medição anterior, para a gravação nova nunca empatar com ela. O store
    /// desempata perfis repetidos pela data, e empate faz a releitura devolver o registro antigo.
    /// A conta é em milissegundos inteiros porque é essa a resolução que ele guarda.
    public static func nextMeasurementDate(after previous: Date?, now: Date = Date()) -> Date {
        let anterior = previous.map { milliseconds($0) } ?? 0
        return Date(timeIntervalSince1970: max(milliseconds(now), anterior + 1) / 1_000)
    }

    private static func storedResolution(_ date: Date) -> Date {
        Date(timeIntervalSince1970: milliseconds(date) / 1_000)
    }

    private static func milliseconds(_ date: Date) -> TimeInterval {
        (date.timeIntervalSince1970 * 1_000).rounded(.down)
    }
}
