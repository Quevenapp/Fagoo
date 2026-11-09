import CryptoKit
import Foundation

public enum PrinterProfileSource: String, Codable, Sendable {
    case measured = "MEASURED"
    case bundled = "BUNDLED"
    case temporary = "TEMPORARY"
}

/**
 O dialeto de comandos da impressora.

 **Dois casos desde 30/08/2026, e a lista é `CaseIterable` de propósito.** O kit Kotlin já tinha os
 dois desde 26/08/2026; o lado Swift representava só o primeiro, e por isso um perfil de Diebold
 IM453H contribuído pelo Android chegava ao Mac sem emissor que soubesse falar com ela. Ver
 `docs/handover-diebold-im453h.md`, que é a bancada que mediu esta firmware.

 **O que a IM453H é, medido em papel em 23 e 24/08/2026, e não deduzido de marca nem de modelo:**

 * ela **não tem nenhum comando `GS`**. `GS v 0` não existe lá — mandá-lo fez o aparelho cuspir dois
   metros de código e travar com a tecla de avanço morta, com recuperação só no desligar e ligar;
 * ela **não tem `ESC a`**: quem centraliza gráfico é a margem do próprio comando, e quem centraliza
   texto é preenchimento em colunas;
 * ela **não tem `ESC @`**: o `@` sai impresso no papel;
 * o envelope de raster é `ESC n`, com a largura em **um** byte de unidades de oito pontos — 255, e
   não os 65535 do `GS v 0`. Ver ``RasterEmission`` e ``ProcompRasterEmitter``.

 **`rawValue` é o contrato de disco e da `capabilityKey`.** Os dois nomes são os mesmos do Kotlin, e
 o do caso antigo não se moveu: perfil medido no disco de alguém continua decodificando com a mesma
 chave que tinha antes deste caso existir. Ver `testAChaveDeCapacidadeDeUmPerfilExistenteNaoSeMove`.
 */
public enum EscPosDialect: String, Codable, Sendable, CaseIterable {
    case epsonCompatible = "EPSON_COMPATIBLE"

    /**
     A família ESC/P da Diebold Procomp — a IM453H medida na bancada.

     Não é "ESC/POS com outro nome": é outro conjunto de comandos, e o que os separa está medido em
     ``ProcompEscP`` e ``ProcompRasterEmitter``, sequência por sequência, com a data em que cada uma
     saiu no papel.
     */
    case procompEscP = "PROCOMP_ESC_P"
}

public enum PrinterStatusProtocol: String, Codable, Sendable {
    case dleEot = "DLE_EOT"
    case none = "NONE"
}

/// Comando de guilhotina medido no papel. As variantes 65 e 66 já carregam o avanço de 0x50
/// medido pela sonda e, por isso, nunca podem receber um `ESC d` adicional.
public enum CutProtocol: String, Codable, CaseIterable, Sendable {
    case gsV0 = "GS_V_0"
    case gsV1 = "GS_V_1"
    case gsV65 = "GS_V_65"
    case gsV66 = "GS_V_66"
    case escI = "ESC_I"
    case escM = "ESC_M"
    case none = "NONE"

    public var label: String {
        switch self {
        case .gsV0: return "GS V 0"
        case .gsV1: return "GS V 1"
        case .gsV65: return "GS V 65"
        case .gsV66: return "GS V 66"
        case .escI: return "ESC i"
        case .escM: return "ESC m"
        case .none: return "Nenhum"
        }
    }

    public var hasEmbeddedFeed: Bool { self == .gsV65 || self == .gsV66 }
    public var hasCutter: Bool { self != .none }

    /// O modo embutido no comando medido. `nil` só quando não há guilhotina.
    ///
    /// O enum mistura duas coisas que a bancada aprendeu separadas: o dialeto que a firmware
    /// atende (`GS V`, `GS V 65/66`, `ESC i/m`) e o modo do corte. Só o dialeto é medível — o modo
    /// é escolha de quem usa.
    public var cutMode: CutMode? {
        switch self {
        case .gsV0, .gsV65, .escI: return .total
        case .gsV1, .gsV66, .escM: return .partial
        case .none: return nil
        }
    }

    /// O irmão do mesmo dialeto no outro modo. É a peça que faltava: a homologação media dialeto e
    /// modo juntos e gravava o que a sonda encontrasse primeiro — sempre um total, porque a ordem
    /// dos candidatos começa neles. Com o irmão explícito, quem usa escolhe grudado ou solto sem
    /// re-homologar e sem sair do dialeto que a impressora provou atender.
    public func withCutMode(_ mode: CutMode) -> CutProtocol {
        switch self {
        case .none: return .none
        case .gsV0, .gsV1: return mode == .total ? .gsV0 : .gsV1
        case .gsV65, .gsV66: return mode == .total ? .gsV65 : .gsV66
        case .escI, .escM: return mode == .total ? .escI : .escM
        }
    }

    public var command: Data {
        switch self {
        case .gsV0: return Data([0x1d, 0x56, 0x00])
        case .gsV1: return Data([0x1d, 0x56, 0x01])
        case .gsV65: return Data([0x1d, 0x56, 0x41, 0x50])
        case .gsV66: return Data([0x1d, 0x56, 0x42, 0x50])
        case .escI: return Data([0x1b, 0x69])
        case .escM: return Data([0x1b, 0x6d])
        case .none: return Data()
        }
    }
}

/// Como a tira se separa do rolo. É preferência de quem usa, não medição: a ficha costuma ser
/// melhor grudada e o cupom de venda solto, na mesma impressora e no mesmo dialeto.
public enum CutMode: String, Codable, CaseIterable, Sendable {
    /// A tira sai solta do rolo.
    case total = "TOTAL"

    /// A tira fica presa por um ponto; é o que mantém a ficha grudada.
    case partial = "PARTIAL"

    public var label: String { self == .total ? "Corte total" : "Corte parcial" }
}

public enum PrinterPaperWidth: Int, Codable, CaseIterable, Sendable {
    case mm58 = 58
    case mm80 = 80

    public var defaultPrintableColumns: Int { self == .mm58 ? 32 : 48 }
    public var defaultPrintableDots: Int { self == .mm58 ? 384 : 576 }
    /// A régua precisa ultrapassar o valor preenchido para medir firmware que oferece mais
    /// colunas na mesma bobina. A resposta continua limitada ao que efetivamente saiu no papel.
    public var geometryProbeColumns: Int { self == .mm58 ? 48 : 64 }
    public var geometryProbeDots: [Int] {
        self == .mm58 ? [256, 288, 320, 384] : [384, 512, 576, 640]
    }
}

/// Capacidades físicas são espelhadas com o Android mesmo quando o iPhone não consegue abrir o
/// transporte. A seleção operacional iOS continua limitada a Wi-Fi e BLE por `PrinterTransport`.
public enum PrinterCapabilityTransport: String, Codable, CaseIterable, Hashable, Sendable {
    case localWifi = "LOCAL_WIFI"
    case usb = "USB"
    case bluetooth = "BLUETOOTH"
    case bluetoothLE = "BLUETOOTH_LE"
}

extension PrinterTransport {
    var capabilityTransport: PrinterCapabilityTransport {
        switch self {
        case .localWifi: return .localWifi
        case .bluetooth: return .bluetoothLE
        }
    }
}

public struct PrinterCapabilityKey: RawRepresentable, Codable, Hashable, Sendable, CustomStringConvertible {
    public let rawValue: String

    public init(rawValue: String) { self.rawValue = rawValue }
    public var description: String { rawValue }
}

public enum PrinterProfileValidationError: Error, Equatable, LocalizedError {
    case invalidIdentifier
    case invalidDisplayName
    case missingTransport
    case invalidNetworkCapability
    case invalidGeometry
    case unsafeRasterWidth
    case invalidCutFeed
    case invalidTextEncoding
    case measuredStatusMustBeNone
    case invalidMeasurementDate
    case invalidSource
    case invalidRasterThroughput
    case invalidVerticalRasterScale

    public var errorDescription: String? {
        switch self {
        case .invalidIdentifier: return "Identificador local de perfil inválido."
        case .invalidDisplayName: return "Nome de exibição do perfil inválido."
        case .missingTransport: return "Perfil sem transporte declarado."
        case .invalidNetworkCapability: return "Capacidade de rede do perfil inválida."
        case .invalidGeometry: return "Geometria de impressão inválida."
        case .unsafeRasterWidth: return "A largura medida não comporta o raster mínimo seguro."
        case .invalidCutFeed: return "Avanço de corte não medido pela sonda."
        case .invalidTextEncoding: return "Modelo de codificação de texto incompatível com a página."
        case .measuredStatusMustBeNone: return "Perfil novo não pode prometer status sem sonda própria."
        case .invalidMeasurementDate: return "Data de medição do perfil inválida."
        case .invalidSource: return "Origem de perfil incompatível com este armazenamento."
        case .invalidRasterThroughput: return "Teto de vazão de raster fora da faixa aceita."
        case .invalidVerticalRasterScale:
            return "Fator de compensação vertical fora da faixa aceita."
        }
    }
}

public struct PrinterCapabilities: Codable, Equatable, Sendable {
    public static let safeRasterMinimumDots = 160
    public static let preferredQRWidthDots = 320
    public static let allowedCutFeedLines = [0, 2, 4, 5, 6, 8, 10, 12]
    /// A faixa que a geometria aceita. Pública porque a configuração manual precisa dizer o que
    /// falta **antes** de tentar gravar; duas cópias desta régua seriam duas respostas sobre o
    /// mesmo campo.
    public static let allowedPrintableColumns = 24...96
    /// Faixa aceita para o teto de vazão de raster, em bytes por segundo. O piso existe para que um
    /// teto errado não transforme uma foto em espera de minutos; o limite de cima é folga larga,
    /// acima de qualquer enlace que estas portáteis alcançam. Espelha o Android.
    public static let allowedRasterBytesPerSecond = 256...1_000_000

    public let transports: Set<PrinterCapabilityTransport>
    public let paperWidth: PrinterPaperWidth
    public let printableColumns: Int
    public let printableDots: Int
    public let codePage: ThermalCodePage?
    /// Modelo do fio; UTF-8 e ASCII não usam `ESC t` nem carregam página.
    public let textEncoding: ThermalTextEncoding
    /// Endereço medido da página em `ESC t`, quando a firmware não usa o canônico.
    ///
    /// Medido na bancada em 2026-08-10: a T210 (`58E_BT`) atende a CP860 em `ESC t 8`, não no 3, e
    /// responde com tabela tailandesa no `n` reservado à CP1252. O assistente reprovava a
    /// impressora e concluía `Nenhuma` porque perguntava pelo nome, não pelo endereço.
    ///
    /// **Fora da `capabilityKey` de propósito**: duas impressoras com a mesma página efetiva
    /// produzem o mesmo papel ainda que cheguem a ela por `n` diferente.
    public let codePageSelector: UInt8?
    /// A firmware entrega o modo que o comando pede?
    ///
    /// Medido na bancada em 2026-08-10: a GoldenSky 80 mm obedeceu aos sete comandos e cortou
    /// **sempre parcial**, inclusive nos que pedem total. Com `false`, trocar de modo é recusado
    /// em vez de prometer papel solto que nunca vem. Fora da `capabilityKey`: descreve se existe
    /// escolha, não o que sai no papel.
    public let cutModeHonored: Bool
    public let cutProtocol: CutProtocol
    public let cutFeedLines: Int
    public let dialect: EscPosDialect
    public let statusProtocol: PrinterStatusProtocol
    /// Porta TCP é capacidade do protocolo, não endereço da impressora. O único valor aceito no
    /// M2 continua sendo 9100; nenhum IP atravessa este tipo.
    public let tcpPort: Int?
    /// Quantos bytes de raster por segundo esta firmware consegue **imprimir**, ou `nil` quando
    /// ninguém mediu.
    ///
    /// Medido na bancada em 20/08 com a Inico T210 por BLE: os mesmos 120 dots dão 15,0 mm numa
    /// banda única e em quinze bandas de oito, e um logotipo de 2 KB sai correto — mas a foto de
    /// 28 KB em largura cheia sai 22% mais curta, coerente e só encolhida. O que separa o caso bom
    /// do ruim é vazão, não geometria: a firmware descarta linhas inteiras quando os bytes chegam
    /// mais rápido do que a cabeça térmica imprime. A GoldenSky MTP-II, no mesmo caminho, acerta.
    ///
    /// Capacidade por modelo, com default nulo, nunca detectada por heurística — como
    /// `cutModeHonored`. **Fora da `capabilityKey` de propósito**: os bytes emitidos são os mesmos,
    /// muda só o ritmo com que saem do rádio.
    public let maxRasterBytesPerSecond: Int?

    /**
     Quanto da altura de raster declarada esta firmware realmente imprime, ou `nil` quando ninguém
     mediu.

     Medido na bancada em 20/08 com a Inico T210 contra a GoldenSky MTP-II, no mesmo aparelho e pelo
     mesmo caminho BLE: a **mesma** imagem de 384x800, quase toda branca, com os mesmos 45,7 KB
     confirmados na telemetria, sai com ~97 mm na MTP-II e com 80 mm na T210. Cobertura de tinta,
     vazão, altura de banda, MTU, modo de escrita e emenda entre bandas foram eliminados por
     medição; raster estreito e texto saem certos na T210. O que sobra é a firmware encolhendo
     raster largo por um fator constante — e constante quer dizer compensável.

     Com o fator declarado, o emissor manda `1/fator` linhas e o papel sai na altura pretendida.
     Capacidade por modelo, nula por padrão, nunca detectada por heurística: só a régua da sonda
     produz este número.

     **Dentro da `capabilityKey`**, ao contrário do teto de vazão, porque muda os bytes emitidos: a
     mesma foto vira 1,25x mais linhas com 0,80. A chave de perfil sem fator não muda, porque o
     campo só entra na string canônica quando existe.
     */
    public let verticalRasterScale: Double?

    /**
     Esta firmware desenha o QR quando o `GS ( k` pede, ou imprime o comando como texto?

     Três estados, e o `nil` é um deles: **ausente** (ninguém mediu), medido-não e medido-sim.
     Ausente não é "provavelmente sim" — em impressora térmica nada implica nada, e aceitar `GS v 0`
     não implica aceitar `GS ( k`. Enquanto for diferente de `true`, a trava de
     ``ReceiptLayout/init(profile:decoration:rasterStripeHeightDots:codeEmission:)`` rebaixa a
     preferência do hospedeiro para raster e o cupom sai como sempre saiu.

     Capacidade medida, com default nulo, **nunca** detectada por heurística: só a sonda produz este
     valor, e só depois de uma pessoa dizer o que saiu no papel.

     **Fora da ``capabilityKey`` de propósito**, como ``cutModeHonored``: a chave é identidade de
     capacidade, e duas impressoras com as mesmas capacidades precisam compartilhar chave. O campo
     também não muda os bytes emitidos por si — quem muda é a preferência, que não mora no perfil.
     */
    public let nativeQrHonored: Bool?

    /**
     O mesmo para o `GS k` do código de barras, e por isso é um campo separado.

     Uma firmware pode atender a um comando e ignorar o outro; medir os dois juntos e gravar um
     número só seria decidir por medição que não existe. Ver ``nativeQrHonored`` para os três
     estados e para a razão de ficar fora da chave de capacidade.
     */
    public let nativeBarcodeHonored: Bool?

    /**
     Como esta impressora aceita configuração de rede, ou `nil` enquanto ninguém determinou.

     O valor carrega **a procedência junto com a família** — ver ``PrinterWifiConfigurationFamily``,
     onde a lista de casos e o motivo de o indeterminado não ser representável estão escritos. Aqui
     basta o que ele significa para o perfil: `nil` é "nunca determinado", e não um padrão que
     pareça medição. Perfil gravado antes deste campo volta `nil` e continua perguntando, como
     sempre perguntou.

     **Quem escreve é a tela de configuração de rede, e ninguém mais**, depois de a pessoa
     responder. Nenhuma sonda de homologação o preenche: ele não sai da série de tiras que a
     homologação imprime, e completá-lo ali seria inventar medição.

     **Fora da `capabilityKey` de propósito**, como `cutModeHonored`: ele não muda um byte de cupom.
     Decide qual quadro a tela de configuração monta, e quadro de configuração não é cupom — duas
     impressoras que imprimem idêntico têm de continuar com a mesma chave.

     **Fora do pacote de contribuição, também de propósito.** O precedente é dividido — o seletor de
     página e o modo de corte saem no pacote; o teto, o fator e o logotipo em NV RAM não —, e o que
     decide aqui é a procedência misturada: um dos três casos é escolha de uma pessoa, e um pacote
     de homologação que a carregasse publicaria palpite como medição de bancada. Omiti-lo inteiro é
     honesto; omitir só o caso declarado deixaria a ausência querendo dizer duas coisas.
     */
    public let wifiConfigurationFamily: PrinterWifiConfigurationFamily?

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case transports, paperWidth, printableColumns, printableDots, codePage, cutProtocol
        case cutFeedLines, dialect, statusProtocol, tcpPort
        // Campo novo que não atravessa o Codable faz o perfil relido diferir do salvo, e a sessão
        // recusa a adoção com "persistenceFailed". Foi o que aconteceu com a T210: primeiro perfil
        // com seletor medido, 44 impressões gastas e nada salvo.
        case codePageSelector, cutModeHonored, textEncoding, maxRasterBytesPerSecond
        case verticalRasterScale, wifiConfigurationFamily
        // A sonda que os mede chegou, e com ela o schema se abriu: campo medido que não atravessa o
        // `Codable` faz o perfil relido diferir do salvo, e a sessão recusa a adoção com
        // "persistenceFailed" — depois da bobina gasta. Ficam **fora** de `requiredCapabilityKeys`
        // no store, porque perfil antigo não os tem.
        case nativeQrHonored, nativeBarcodeHonored
    }

    public init(
        transports: Set<PrinterCapabilityTransport>,
        paperWidth: PrinterPaperWidth,
        printableColumns: Int,
        printableDots: Int,
        codePage: ThermalCodePage?,
        textEncoding: ThermalTextEncoding? = nil,
        cutProtocol: CutProtocol,
        cutFeedLines: Int,
        dialect: EscPosDialect = .epsonCompatible,
        statusProtocol: PrinterStatusProtocol,
        tcpPort: Int?,
        codePageSelector: UInt8? = nil,
        cutModeHonored: Bool = true,
        maxRasterBytesPerSecond: Int? = nil,
        verticalRasterScale: Double? = nil,
        nativeQrHonored: Bool? = nil,
        nativeBarcodeHonored: Bool? = nil,
        wifiConfigurationFamily: PrinterWifiConfigurationFamily? = nil
    ) throws {
        guard !transports.isEmpty else { throw PrinterProfileValidationError.missingTransport }
        if let maxRasterBytesPerSecond {
            guard Self.allowedRasterBytesPerSecond.contains(maxRasterBytesPerSecond) else {
                throw PrinterProfileValidationError.invalidRasterThroughput
            }
        }
        if let verticalRasterScale {
            guard ReceiptLayout.allowedVerticalRasterScale.contains(verticalRasterScale) else {
                throw PrinterProfileValidationError.invalidVerticalRasterScale
            }
        }
        let usesWifi = transports.contains(.localWifi)
        guard usesWifi == (tcpPort != nil), tcpPort == nil || tcpPort == 9_100 else {
            throw PrinterProfileValidationError.invalidNetworkCapability
        }
        guard Self.allowedPrintableColumns.contains(printableColumns),
              paperWidth.geometryProbeDots.contains(printableDots)
        else { throw PrinterProfileValidationError.invalidGeometry }
        guard Self.safeQRWidth(printableColumns: printableColumns, printableDots: printableDots) != nil else {
            throw PrinterProfileValidationError.unsafeRasterWidth
        }
        guard Self.allowedCutFeedLines.contains(cutFeedLines) else {
            throw PrinterProfileValidationError.invalidCutFeed
        }
        if cutProtocol == .none || cutProtocol.hasEmbeddedFeed {
            guard cutFeedLines == 0 else { throw PrinterProfileValidationError.invalidCutFeed }
        }

        let resolvedEncoding = textEncoding ?? (codePage == nil ? .ascii : .singleByteCodePage)
        guard resolvedEncoding.usesCodePage == (codePage != nil),
              resolvedEncoding == .singleByteCodePage || codePageSelector == nil
        else { throw PrinterProfileValidationError.invalidTextEncoding }

        self.transports = transports
        self.paperWidth = paperWidth
        self.printableColumns = printableColumns
        self.printableDots = printableDots
        self.codePage = codePage
        self.textEncoding = resolvedEncoding
        self.codePageSelector = codePageSelector
        self.cutModeHonored = cutModeHonored
        self.cutProtocol = cutProtocol
        self.cutFeedLines = cutFeedLines
        self.dialect = dialect
        self.statusProtocol = statusProtocol
        self.tcpPort = tcpPort
        self.maxRasterBytesPerSecond = maxRasterBytesPerSecond
        self.verticalRasterScale = verticalRasterScale
        self.nativeQrHonored = nativeQrHonored
        self.nativeBarcodeHonored = nativeBarcodeHonored
        self.wifiConfigurationFamily = wifiConfigurationFamily
    }

    /// Só o modo muda; o dialeto medido e todo o resto da medição continuam iguais. `try!` é
    /// seguro aqui porque o irmão nunca troca a família de avanço embutido, que é a única regra de
    /// corte que a validação impõe.
    func withCutMode(_ mode: CutMode) -> PrinterCapabilities {
        // Modo não honrado pela firmware: trocar seria prometer um corte que ela não entrega.
        // Medido na GoldenSky, que corta sempre parcial mesmo obedecendo ao `GS V 0`.
        guard cutProtocol != .none, cutModeHonored else { return self }
        // swiftlint:disable:next force_try
        return try! PrinterCapabilities(
            transports: transports,
            paperWidth: paperWidth,
            printableColumns: printableColumns,
            printableDots: printableDots,
            codePage: codePage,
            textEncoding: textEncoding,
            cutProtocol: cutProtocol.withCutMode(mode),
            cutFeedLines: cutFeedLines,
            dialect: dialect,
            statusProtocol: statusProtocol,
            tcpPort: tcpPort,
            codePageSelector: codePageSelector,
            cutModeHonored: cutModeHonored,
            maxRasterBytesPerSecond: maxRasterBytesPerSecond,
            verticalRasterScale: verticalRasterScale,
            // Só o modo de corte muda; capacidade medida que não fosse repassada aqui morreria numa
            // troca de corte, e o modo nativo sumiria do papel sem erro em lugar nenhum.
            nativeQrHonored: nativeQrHonored,
            nativeBarcodeHonored: nativeBarcodeHonored,
            // Sem este repasse o rebuild devolveria capacidades sem a família, e trocar o modo do
            // corte apagaria uma tira de papel já gasta — em silêncio, que é como este campo morre.
            wifiConfigurationFamily: wifiConfigurationFamily
        )
    }

    /**
     Grava como esta impressora aceita configuração de rede, preservando toda a medição.

     Molde de ``withCutMode(_:)``, e pela mesma razão: quem escreve este campo é a tela de rede, que
     não mediu geometria, página nem corte — reconstruir o perfil ali à mão é o caminho pelo qual
     `verticalRasterScale` e `maxRasterBytesPerSecond` já se perdem hoje na edição manual.

     `try!` é seguro: nenhuma regra da validação olha para este campo, e todas as outras chegam
     inalteradas.
     */
    public func withWifiConfigurationFamily(
        _ family: PrinterWifiConfigurationFamily?
    ) -> PrinterCapabilities {
        // swiftlint:disable:next force_try
        try! PrinterCapabilities(
            transports: transports,
            paperWidth: paperWidth,
            printableColumns: printableColumns,
            printableDots: printableDots,
            codePage: codePage,
            textEncoding: textEncoding,
            cutProtocol: cutProtocol,
            cutFeedLines: cutFeedLines,
            dialect: dialect,
            statusProtocol: statusProtocol,
            tcpPort: tcpPort,
            codePageSelector: codePageSelector,
            cutModeHonored: cutModeHonored,
            maxRasterBytesPerSecond: maxRasterBytesPerSecond,
            verticalRasterScale: verticalRasterScale,
            // A tela de rede não mede código nativo: o que a sonda de homologação achou atravessa
            // intacto, senão responder "é Rongta" apagaria a medição do QR.
            nativeQrHonored: nativeQrHonored,
            nativeBarcodeHonored: nativeBarcodeHonored,
            wifiConfigurationFamily: family
        )
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let decodedCodePage = try container.decodeIfPresent(ThermalCodePage.self, forKey: .codePage)
        self = try PrinterCapabilities(
            transports: container.decode(Set<PrinterCapabilityTransport>.self, forKey: .transports),
            paperWidth: container.decode(PrinterPaperWidth.self, forKey: .paperWidth),
            printableColumns: container.decode(Int.self, forKey: .printableColumns),
            printableDots: container.decode(Int.self, forKey: .printableDots),
            codePage: decodedCodePage,
            // Perfil v1 não tinha o campo: página presente migra para byte único; ausência migra
            // para a dobra ASCII que já era o comportamento produtivo.
            textEncoding: try container.decodeIfPresent(ThermalTextEncoding.self, forKey: .textEncoding),
            cutProtocol: container.decode(CutProtocol.self, forKey: .cutProtocol),
            cutFeedLines: container.decode(Int.self, forKey: .cutFeedLines),
            dialect: container.decode(EscPosDialect.self, forKey: .dialect),
            statusProtocol: container.decode(PrinterStatusProtocol.self, forKey: .statusProtocol),
            tcpPort: container.decodeIfPresent(Int.self, forKey: .tcpPort),
            codePageSelector: container.decodeIfPresent(UInt8.self, forKey: .codePageSelector),
            cutModeHonored: container.decodeIfPresent(Bool.self, forKey: .cutModeHonored) ?? true,
            // Perfil gravado antes do campo volta sem teto: aquele aparelho nunca mediu vazão, e o
            // envio byte a byte é o que já saía no papel dele. Inventar um número aqui frearia
            // impressora que nunca precisou de freio.
            maxRasterBytesPerSecond: try container.decodeIfPresent(
                Int.self,
                forKey: .maxRasterBytesPerSecond
            ),
            // Perfil gravado antes do campo volta sem compensação: aquela impressora nunca foi
            // medida encolhendo, e o raster de sempre é o que já saía no papel dela. Presumir um
            // fator esticaria a foto de quem imprime certo.
            verticalRasterScale: try container.decodeIfPresent(
                Double.self,
                forKey: .verticalRasterScale
            ),
            // **Sem `?? padrão`, de propósito.** Perfil gravado antes da sonda volta com os dois
            // ausentes, e ausente é um estado: `nil` não é "não", é "ninguém perguntou". Um padrão
            // `false` ficaria indistinguível de uma medição negativa no comprovante, e um padrão
            // `true` mandaria `GS ( k` para firmware que imprimiria o payload como texto.
            nativeQrHonored: try container.decodeIfPresent(Bool.self, forKey: .nativeQrHonored),
            nativeBarcodeHonored: try container.decodeIfPresent(
                Bool.self,
                forKey: .nativeBarcodeHonored
            ),
            // Perfil gravado antes do campo volta como "nunca determinado", e **não** com um
            // padrão: qualquer família aqui seria uma medição que ninguém fez, e a tela mandaria o
            // quadro de uma família para uma impressora que pode ser da outra. Sem `??`, como os
            // dois vizinhos anuláveis.
            wifiConfigurationFamily: try container.decodeIfPresent(
                PrinterWifiConfigurationFamily.self,
                forKey: .wifiConfigurationFamily
            )
        )
    }

    public var qrWidthDots: Int {
        // A validação do inicializador prova que este valor existe.
        Self.safeQRWidth(printableColumns: printableColumns, printableDots: printableDots)!
    }

    public static func safeQRWidth(printableColumns: Int, printableDots: Int) -> Int? {
        let width = min(preferredQRWidthDots, printableDots, printableColumns * 12) / 8 * 8
        return width >= safeRasterMinimumDots ? width : nil
    }

    /**
     O fator entra na chave **só quando existe**, e por isso nenhuma chave já emitida se move.

     Ele muda os bytes: a mesma foto vira 1,25x mais linhas num perfil com fator 0,80, então dois
     perfis que diferem só nele não são medições equivalentes e não podem compartilhar chave. Um
     campo novo em posição fixa mudaria a chave de todo perfil já medido e já contribuído, para
     distinguir cupons que continuam idênticos byte a byte.

     Em milésimos, e por inteiro: `0,8` das duas plataformas precisa dar a mesma string, e
     formatação de ponto flutuante não promete isso. Espelha o Android.
     */
    private var verticalRasterScaleCanonicalSuffix: String {
        guard let verticalRasterScale else { return "" }
        return "|VRS\(Int((verticalRasterScale * 1_000).rounded()))"
    }

    public var capabilityKey: PrinterCapabilityKey {
        let transports = transports.map(\.rawValue).sorted().joined(separator: ",")
        let canonical = [
            // v2 inclui o modelo: UTF-8 e ASCII têm página nula, porém bytes distintos. O seletor
            // fica fora porque só alcança a mesma página por outro endereço `ESC t`.
            "v2", transports, String(paperWidth.rawValue), String(printableColumns),
            String(printableDots), textEncoding.rawValue, codePage?.label ?? "NONE", cutProtocol.rawValue,
            String(cutFeedLines), dialect.rawValue, statusProtocol.rawValue,
            tcpPort.map(String.init) ?? "NONE",
        ].joined(separator: "|") + verticalRasterScaleCanonicalSuffix
        let digest = SHA256.hash(data: Data(canonical.utf8))
        return PrinterCapabilityKey(rawValue: digest.map { String(format: "%02x", $0) }.joined())
    }

}

/// Perfil criado por uma homologação local. Marca e modelo aparecem somente em `displayName`; o
/// identificador é um UUID sem semântica e o status começa obrigatoriamente em `NONE`.
public struct MeasuredProfile: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let displayName: String
    public let measuredAt: Date
    public let source: PrinterProfileSource
    public let capabilities: PrinterCapabilities
    /// `GS I 65`, saneado; identidade declarada e deliberadamente fora da `capabilityKey`.
    public let firmwareVersion: String?

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case id, displayName, measuredAt, source, capabilities, firmwareVersion
    }

    public init(
        id: UUID = UUID(),
        displayName: String,
        measuredAt: Date = Date(),
        source: PrinterProfileSource = .measured,
        transports: Set<PrinterCapabilityTransport>,
        paperWidth: PrinterPaperWidth,
        printableColumns: Int,
        printableDots: Int,
        codePage: ThermalCodePage?,
        textEncoding: ThermalTextEncoding? = nil,
        codePageSelector: UInt8? = nil,
        cutProtocol: CutProtocol,
        cutModeHonored: Bool = true,
        cutFeedLines: Int,
        tcpPort: Int?,
        maxRasterBytesPerSecond: Int? = nil,
        verticalRasterScale: Double? = nil,
        /// O que a tira de código nativo mediu, ou `nil` quando ela não saiu. Ver
        /// ``PrinterCapabilities/nativeQrHonored``.
        nativeQrHonored: Bool? = nil,
        nativeBarcodeHonored: Bool? = nil,
        wifiConfigurationFamily: PrinterWifiConfigurationFamily? = nil,
        firmwareVersion: String? = nil,
        /**
         O dialeto medido. Fica por último e com padrão pela convenção do kit — ver a nota de
         ``ReceiptLayout``: campo novo entra no fim ou quebra todo chamador que já passa os de baixo.

         **Sem ele, homologar pelo iPhone gravava sempre ESC/POS.** Este inicializador montava as
         capacidades sem passar dialeto nenhum, então caía no padrão `.epsonCompatible`, e só
         ``MeasuredProfile/validated(id:displayName:measuredAt:source:capabilities:firmwareVersion:)``
         e a decodificação de disco alcançavam outro valor. Uma Diebold IM453H medida aqui voltava a
         falar ESC/POS no primeiro cupom depois de adotada — e só o papel mostraria, longe da causa.
         */
        dialect: EscPosDialect = .epsonCompatible
    ) throws {
        guard source == .measured else { throw PrinterProfileValidationError.invalidSource }
        guard measuredAt.timeIntervalSince1970 > 0, measuredAt.timeIntervalSince1970.isFinite else {
            throw PrinterProfileValidationError.invalidMeasurementDate
        }
        try Self.validateDisplayName(displayName)
        try Self.validateFirmwareVersion(firmwareVersion)
        let capabilities = try PrinterCapabilities(
            transports: transports,
            paperWidth: paperWidth,
            printableColumns: printableColumns,
            printableDots: printableDots,
            codePage: codePage,
            textEncoding: textEncoding,
            cutProtocol: cutProtocol,
            cutFeedLines: cutFeedLines,
            dialect: dialect,
            statusProtocol: .none,
            tcpPort: tcpPort,
            codePageSelector: codePageSelector,
            cutModeHonored: cutModeHonored,
            maxRasterBytesPerSecond: maxRasterBytesPerSecond,
            verticalRasterScale: verticalRasterScale,
            // Sem isto a capacidade medida morre na construção do perfil e nunca alcança o disco
            // nem o papel: a sonda existiria e a medição não chegaria a lugar nenhum.
            nativeQrHonored: nativeQrHonored,
            nativeBarcodeHonored: nativeBarcodeHonored,
            wifiConfigurationFamily: wifiConfigurationFamily
        )
        self.id = id.uuidString.lowercased()
        self.displayName = displayName
        self.measuredAt = Self.normalizedMeasurementDate(measuredAt)
        self.source = source
        self.capabilities = capabilities
        self.firmwareVersion = firmwareVersion
    }

    public var capabilityKey: PrinterCapabilityKey { capabilities.capabilityKey }
    public var transports: Set<PrinterCapabilityTransport> { capabilities.transports }
    public var paperWidthMm: Int { capabilities.paperWidth.rawValue }
    public var printableColumns: Int { capabilities.printableColumns }
    public var printableDots: Int { capabilities.printableDots }
    public var codePage: ThermalCodePage? { capabilities.codePage }
    public var textEncoding: ThermalTextEncoding { capabilities.textEncoding }
    public var codePageSelector: UInt8? { capabilities.codePageSelector }
    public var cutModeHonored: Bool { capabilities.cutModeHonored }
    public var cutProtocol: CutProtocol { capabilities.cutProtocol }
    public var cutFeedLines: Int { capabilities.cutFeedLines }
    public var dialect: EscPosDialect { capabilities.dialect }
    public var statusProtocol: PrinterStatusProtocol { capabilities.statusProtocol }
    public var maxRasterBytesPerSecond: Int? { capabilities.maxRasterBytesPerSecond }
    public var verticalRasterScale: Double? { capabilities.verticalRasterScale }
    /// Ver ``PrinterCapabilities/nativeQrHonored``: três estados, e `nil` é "ninguém mediu".
    public var nativeQrHonored: Bool? { capabilities.nativeQrHonored }
    /// Ver ``PrinterCapabilities/nativeBarcodeHonored``.
    public var nativeBarcodeHonored: Bool? { capabilities.nativeBarcodeHonored }
    public var wifiConfigurationFamily: PrinterWifiConfigurationFamily? {
        capabilities.wifiConfigurationFamily
    }
    public var measuredAtEpochMillis: Int64 { Int64(measuredAt.timeIntervalSince1970 * 1_000) }

    /// Grudado ou solto. `nil` só quando não há guilhotina.
    public var cutMode: CutMode? { capabilities.cutProtocol.cutMode }

    /// Troca só o modo, preservando o dialeto que a bancada mediu. É o que permite a ficha sair
    /// grudada sem repetir a homologação: o comando que a firmware provou atender continua o
    /// mesmo, muda o irmão. Sem guilhotina não há o que trocar.
    public func withCutMode(_ mode: CutMode) throws -> MeasuredProfile {
        guard capabilities.cutProtocol != .none else { return self }
        return try Self.validated(
            id: id,
            displayName: displayName,
            measuredAt: measuredAt,
            source: source,
            capabilities: capabilities.withCutMode(mode),
            firmwareVersion: firmwareVersion
        )
    }

    /**
     Grava como esta impressora aceita configuração de rede, sem tocar em nada que foi medido.

     A tela de rede chega aqui com o perfil inteiro que leu do store, e devolve o perfil inteiro:
     é read-modify-write, e não reconstrução. Reconstruir seria repetir o defeito que hoje apaga o
     fator de compensação quando alguém edita a página de código à mão.

     A data da medição **não** muda: nada foi remedido no papel que a homologação certifica, e
     mexer nela reordenaria a lista de perfis por causa de uma resposta de tela.
     */
    public func withWifiConfigurationFamily(
        _ family: PrinterWifiConfigurationFamily?
    ) throws -> MeasuredProfile {
        try Self.validated(
            id: id,
            displayName: displayName,
            measuredAt: measuredAt,
            source: source,
            capabilities: capabilities.withWifiConfigurationFamily(family),
            firmwareVersion: firmwareVersion
        )
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self = try Self.validated(
            id: container.decode(String.self, forKey: .id),
            displayName: container.decode(String.self, forKey: .displayName),
            measuredAt: container.decode(Date.self, forKey: .measuredAt),
            source: container.decode(PrinterProfileSource.self, forKey: .source),
            capabilities: container.decode(PrinterCapabilities.self, forKey: .capabilities),
            firmwareVersion: container.decodeIfPresent(String.self, forKey: .firmwareVersion)
        )
    }

    static func validated(
        id: String,
        displayName: String,
        measuredAt: Date,
        source: PrinterProfileSource,
        capabilities: PrinterCapabilities,
        firmwareVersion: String? = nil
    ) throws -> MeasuredProfile {
        guard UUID(uuidString: id)?.uuidString.lowercased() == id else {
            throw PrinterProfileValidationError.invalidIdentifier
        }
        guard source == .measured else { throw PrinterProfileValidationError.invalidSource }
        guard measuredAt.timeIntervalSince1970 > 0, measuredAt.timeIntervalSince1970.isFinite else {
            throw PrinterProfileValidationError.invalidMeasurementDate
        }
        guard capabilities.statusProtocol == .none else {
            throw PrinterProfileValidationError.measuredStatusMustBeNone
        }
        try validateDisplayName(displayName)
        try validateFirmwareVersion(firmwareVersion)
        return MeasuredProfile(
            id: id.lowercased(),
            displayName: displayName,
            measuredAt: measuredAt,
            source: source,
            capabilities: capabilities,
            firmwareVersion: firmwareVersion
        )
    }

    private init(
        id: String,
        displayName: String,
        measuredAt: Date,
        source: PrinterProfileSource,
        capabilities: PrinterCapabilities,
        firmwareVersion: String?
    ) {
        self.id = id
        self.displayName = displayName
        self.measuredAt = measuredAt
        self.source = source
        self.capabilities = capabilities
        self.firmwareVersion = firmwareVersion
    }

    private static func validateDisplayName(_ displayName: String) throws {
        guard displayName == displayName.trimmingCharacters(in: .whitespacesAndNewlines),
              (1...80).contains(displayName.count),
              !displayName.unicodeScalars.contains(where: {
                  switch $0.properties.generalCategory {
                  case .control, .lineSeparator, .paragraphSeparator: return true
                  default: return false
                  }
              }),
              technicalIdentifierPatterns.allSatisfy({ pattern in
                  displayName.range(of: pattern, options: .regularExpression) == nil
              })
        else { throw PrinterProfileValidationError.invalidDisplayName }
    }

    private static func validateFirmwareVersion(_ value: String?) throws {
        guard let value else { return }
        guard PrinterDeclaredIdentity.sanitizeField(Data(value.utf8)) == value else {
            throw PrinterProfileValidationError.invalidDisplayName
        }
    }

    /// Marca e modelo podem aparecer no rótulo, mas endpoint e identificadores de hardware não
    /// podem usar esse campo livre como atalho para chegar ao store persistente.
    private static let technicalIdentifierPatterns = [
        #"(?:^|\D)(?:\d{1,3}\.){3}\d{1,3}(?:$|\D)"#,
        #"(?i)(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}"#,
        #"(?i)\b(?:VID|PID|MAC|UUID|PERIPHERAL)\b"#,
        #"(?i)\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b"#,
    ]

    private static func normalizedMeasurementDate(_ date: Date) -> Date {
        Date(timeIntervalSince1970: floor(date.timeIntervalSince1970 * 1_000) / 1_000)
    }
}

public struct PrinterProfile: Equatable, Identifiable, Sendable, CustomStringConvertible {
    public let id: String
    public let displayName: String
    public let source: PrinterProfileSource
    public let measuredAt: Date?
    public let capabilities: PrinterCapabilities
    public let warning: String?
    public let firmwareVersion: String?

    public var capabilityKey: PrinterCapabilityKey { capabilities.capabilityKey }
    public var isPersistent: Bool { source != .temporary }
    public var transports: Set<PrinterCapabilityTransport> { capabilities.transports }
    public var paperWidthMm: Int { capabilities.paperWidth.rawValue }
    public var printableColumns: Int { capabilities.printableColumns }
    public var printableDots: Int { capabilities.printableDots }
    public var codePage: ThermalCodePage? { capabilities.codePage }
    public var textEncoding: ThermalTextEncoding { capabilities.textEncoding }
    public var codePageSelector: UInt8? { capabilities.codePageSelector }
    public var cutModeHonored: Bool { capabilities.cutModeHonored }
    public var cutProtocol: CutProtocol { capabilities.cutProtocol }
    public var cutFeedLines: Int { capabilities.cutFeedLines }
    public var dialect: EscPosDialect { capabilities.dialect }
    public var statusProtocol: PrinterStatusProtocol { capabilities.statusProtocol }
    public var maxRasterBytesPerSecond: Int? { capabilities.maxRasterBytesPerSecond }
    public var verticalRasterScale: Double? { capabilities.verticalRasterScale }
    /// A trava de ``ReceiptLayout`` lê daqui: ver ``PrinterCapabilities/nativeQrHonored``.
    public var nativeQrHonored: Bool? { capabilities.nativeQrHonored }
    /// Ver ``PrinterCapabilities/nativeBarcodeHonored``.
    public var nativeBarcodeHonored: Bool? { capabilities.nativeBarcodeHonored }
    public var wifiConfigurationFamily: PrinterWifiConfigurationFamily? {
        capabilities.wifiConfigurationFamily
    }
    public var description: String { "PrinterProfile(id=\(id), source=\(source.rawValue))" }

    init(
        id: String,
        displayName: String,
        source: PrinterProfileSource,
        measuredAt: Date?,
        capabilities: PrinterCapabilities,
        warning: String? = nil,
        firmwareVersion: String? = nil
    ) {
        self.id = id
        self.displayName = displayName
        self.source = source
        self.measuredAt = measuredAt
        self.capabilities = capabilities
        self.warning = warning
        self.firmwareVersion = firmwareVersion
    }

    init(_ measured: MeasuredProfile) {
        self.init(
            id: measured.id,
            displayName: measured.displayName,
            source: .measured,
            measuredAt: measured.measuredAt,
            capabilities: measured.capabilities,
            firmwareVersion: measured.firmwareVersion
        )
    }

}

public enum BundledPrinterProfiles {
    private static let allTransports = Set(PrinterCapabilityTransport.allCases)
    public static let epsonTmT20xII = catalogEntry("epson.tmt20xii.escpos", "Epson TM-T20X-II", .mm80)
    public static let elginI9Full2 = catalogEntry("elgin.i9full2.escpos", "Elgin i9FULL 2", .mm80)
    public static let bematechMp4200Th = catalogEntry("bematech.mp4200th.escpos", "Bematech MP-4200 TH", .mm80)
    public static let portable58mm = catalogEntry("generic.portable58.escpos", "Portátil 58mm Bluetooth", .mm58)
    public static let goldenSkyGsT80cWf = catalogEntry("goldensky.gst80cwf.escpos", "GoldenSky GS-T80C-WF", .mm80)
    public static let tomateMdk082 = catalogEntry("tomate.mdk082.escpos", "Tomate MDK-082", .mm80)
    public static let inicoT210 = catalogEntry("inico.t210.escpos", "Inico T210", .mm58)
    public static let luogaoJk8002e = catalogEntry("luogao.jk8002e.escpos", "Luogao JK8002E", .mm80)

    public static let all = [
        epsonTmT20xII, luogaoJk8002e, elginI9Full2, goldenSkyGsT80cWf,
        portable58mm, bematechMp4200Th, tomateMdk082, inicoT210,
    ]

    /// Entrada conservadora usada somente pelo catálogo e pela descoberta anterior às sondas.
    private static func catalogEntry(
        _ id: String,
        _ displayName: String,
        _ paperWidth: PrinterPaperWidth
    ) -> PrinterProfile {
        let isNarrow = paperWidth == .mm58
        let capabilities = try! PrinterCapabilities(
            transports: allTransports,
            paperWidth: paperWidth,
            printableColumns: isNarrow ? 32 : 48,
            printableDots: isNarrow ? 384 : 576,
            codePage: nil,
            textEncoding: .ascii,
            cutProtocol: .none,
            cutFeedLines: 0,
            statusProtocol: .none,
            tcpPort: 9_100
        )
        return PrinterProfile(
            id: id,
            displayName: displayName,
            source: .bundled,
            measuredAt: nil,
            capabilities: capabilities
        )
    }
}

public struct PrinterProfileResolver: Sendable {
    private let measured: [MeasuredProfile]
    private let bundled: [PrinterProfile]

    public init(
        measured: [MeasuredProfile],
        bundled: [PrinterProfile] = BundledPrinterProfiles.all
    ) {
        self.measured = measured.sorted { lhs, rhs in
            if lhs.measuredAt != rhs.measuredAt { return lhs.measuredAt > rhs.measuredAt }
            return lhs.id < rhs.id
        }
        self.bundled = bundled
    }

    /// A medição local vence por ID ou capacidade, seguida dos perfis homologados e embutidos.
    /// Sem correspondência, o perfil temporário evita prometer acento, corte ou status.
    public func resolve(
        profileId: String?,
        capabilityKey suppliedKey: PrinterCapabilityKey? = nil,
        transport: PrinterTransport,
        paperWidth: PrinterPaperWidth = .mm58
    ) -> PrinterProfile {
        if let profileId,
           let exact = measured.first(where: {
               $0.id.caseInsensitiveCompare(profileId) == .orderedSame &&
                   $0.capabilities.transports.contains(transport.capabilityTransport)
           }) {
            return PrinterProfile(exact)
        }

        let bundledByID = profileId.flatMap { wanted in
            bundled.first { $0.id.caseInsensitiveCompare(wanted) == .orderedSame }
        }
        let wantedKey = suppliedKey ?? bundledByID?.capabilityKey
        if let wantedKey,
           let equivalent = measured.first(where: {
               $0.capabilityKey == wantedKey && $0.capabilities.transports.contains(transport.capabilityTransport)
           }) {
            return PrinterProfile(equivalent)
        }

        if let bundledByID, bundledByID.capabilities.transports.contains(transport.capabilityTransport) {
            return bundledByID
        }
        if let wantedKey,
           let equivalent = bundled.first(where: {
               $0.capabilityKey == wantedKey && $0.capabilities.transports.contains(transport.capabilityTransport)
           }) {
            return equivalent
        }
        return temporaryProfile(transport: transport, paperWidth: paperWidth)
    }

    private func temporaryProfile(
        transport: PrinterTransport,
        paperWidth: PrinterPaperWidth
    ) -> PrinterProfile {
        let capabilities = try! PrinterCapabilities(
            transports: [transport.capabilityTransport],
            paperWidth: paperWidth,
            printableColumns: paperWidth.defaultPrintableColumns,
            printableDots: paperWidth.defaultPrintableDots,
            codePage: nil,
            cutProtocol: .none,
            cutFeedLines: 0,
            statusProtocol: .none,
            tcpPort: transport == .localWifi ? 9_100 : nil
        )
        return PrinterProfile(
            id: "temporary.\(transport.rawValue)",
            displayName: "Impressora temporária",
            source: .temporary,
            measuredAt: nil,
            capabilities: capabilities,
            warning: "Perfil temporário: acentos serão simplificados e nenhum corte ou status será enviado. Homologue antes de adotar."
        )
    }
}
