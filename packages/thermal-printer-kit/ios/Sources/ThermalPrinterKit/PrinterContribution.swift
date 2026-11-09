import Foundation

public enum PrinterContributionError: Error, Equatable, LocalizedError {
    case invalidDisplayName
    case invalidPlatformVersion

    public var errorDescription: String? {
        switch self {
        case .invalidDisplayName:
            return "O nome da impressora não pode sair no pacote de contribuição."
        case .invalidPlatformVersion:
            return "A versão do app ou do sistema não pode sair no pacote de contribuição."
        }
    }
}

/// Produz o artefato offline que outro app pode encaminhar para homologação. Receber as versões
/// como argumentos mantém a função pura; rede, endpoint, seleção e identificadores técnicos não
/// têm sequer uma entrada pela qual chegar ao JSON.
public enum PrinterContribution {
    /// Identificador do tipo próprio do pacote, espelhado no MIME do Android
    /// (`application/vnd.printher.printer-contribution+json`).
    ///
    /// Existe para que a filtragem aconteça no sistema operacional, antes da folha de
    /// compartilhamento, em vez de o app que recebe contribuição ser oferecido para todo JSON do
    /// aparelho e ter de recusar depois do fato. Quem cria o tipo o exporta; quem recebe o importa.
    public static let typeIdentifier = "br.com.pixelgoods.printher.printer-contribution"

    public static func package(
        for profile: MeasuredProfile,
        osVersion: String,
        appVersion: String
    ) throws -> Data {
        // O `displayName` **não** passa por `sanitizeField`, e a ausência é a decisão. Ver
        // ``displayNameIsPackageable(_:)``, logo abaixo, onde estão as quatro medições que a
        // tiraram daqui.
        guard Self.displayNameIsPackageable(profile.displayName) else {
            throw PrinterContributionError.invalidDisplayName
        }
        // As duas versões de plataforma continuam exigindo ASCII imprimível, e ali a regra está
        // certa: são rótulos técnicos que o hospedeiro monta (`18.5`, `2.4.0`), não texto que
        // alguém digitou. Ninguém batiza a versão do iOS em português.
        guard PrinterDeclaredIdentity.sanitizeField(Data(osVersion.utf8)) == osVersion,
              PrinterDeclaredIdentity.sanitizeField(Data(appVersion.utf8)) == appVersion
        else { throw PrinterContributionError.invalidPlatformVersion }

        let envelope = Envelope(
            kind: "printher.printer-contribution",
            version: 1,
            profile: Profile(
                displayName: profile.displayName,
                firmwareVersion: profile.firmwareVersion,
                transports: profile.transports.map(\.rawValue).sorted(),
                paperWidthMm: profile.paperWidthMm,
                printableColumns: profile.printableColumns,
                printableDots: profile.printableDots,
                textEncoding: textEncoding(profile.textEncoding),
                codePage: profile.codePage?.label,
                codePageSelector: profile.codePageSelector,
                cutProtocol: profile.cutProtocol.rawValue,
                cutModeHonored: profile.cutModeHonored,
                cutFeedLines: profile.cutFeedLines,
                dialect: profile.dialect.rawValue,
                capabilityKey: profile.capabilityKey.rawValue,
                measuredAtEpochMillis: profile.measuredAtEpochMillis
            ),
            platform: Platform(os: "ios", osVersion: osVersion, appVersion: appVersion)
        )
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        var data = try encoder.encode(envelope)
        data.append(0x0a)
        return data
    }

    /// O teto de caracteres do nome, e ele é o de `MeasuredProfile` — não o do protocolo.
    ///
    /// `PrinterDeclaredIdentity.maxFieldBytes` é 64 e mede **bytes**, porque é o limite do campo
    /// que a firmware devolve no `GS I`. Este é 80 e mede **caracteres**, porque é o limite que o
    /// tipo do perfil impõe ao nome que a pessoa digitou. São dois números de dois donos, e usar o
    /// do protocolo aqui truncava dado do usuário em silêncio.
    static let maxDisplayNameCharacters = 80

    /**
     O nome que a pessoa deu à impressora cabe no pacote?

     ## Por que esta função existe, e por que ela não é `sanitizeField`

     Até 30/08/2026 a guarda daqui era `sanitizeField(Data(displayName.utf8)) == displayName`, que é
     ASCII imprimível em até 64 bytes. Ela recusava "Impressora da José", e o gesto de exportação
     respondia dobrando o acento antes de empacotar. **A direção estava errada**, e o que a
     corrigiu foram quatro medições — escritas aqui porque sem elas alguém repõe a guarda em seis
     meses apontando para o `sanitizeField` que continua logo ao lado, guardando `osVersion` e
     `appVersion`, onde ele continua certo:

     1. **`sanitizeField` é da firmware, não da pessoa.** O tipo que a hospeda,
        ``PrinterDeclaredIdentity``, é documentado como "identidade textual declarada pela própria
        firmware nas variantes estendidas de `GS I`", e o `maxFieldBytes = 64` é o limite daquele
        campo de protocolo. Aplicá-la a um nome que uma PESSOA digitou é erro de categoria: o nome
        não veio de nenhuma resposta de impressora.
     2. **Os dois tetos não são o mesmo teto.** `sanitizeField` corta em 64 bytes;
        `MeasuredProfile` aceita 80 caracteres. Aplicada de propósito, ela truncaria — ou, como
        fazia, recusaria — nome que o tipo do perfil deu por bom.
     3. **A restrição ASCII de verdade já está tratada onde ela existe.** O único lugar do produto
        que não aguenta acento no nome é o nome de fila do Windows, e `NomeDeFilaDoWindows.para`
        (em `jvm/app`) já filtra por `[A-Za-z0-9 ._()\-]` por conta própria, porque ali o nome
        atravessa três gramáticas. Nada disso é problema do pacote.
     4. **O pacote é declarado UTF-8, e há golden provando isso.** O teste do contrato compartilhado
        em `android/src/test/.../PrinterContributionTest.kt` fixa o JSON inteiro por literal, e o
        único campo não-ASCII dele é justamente `"displayName": "Impressora da José"`. Uma regra
        ASCII-only neste escritor tornaria aquela prova vazia.

     ## O que sobrou, então

     Só o que `MeasuredProfile` já exige do mesmo campo (`PrinterProfile.swift`,
     `validateDisplayName`): sem espaço sobrando nas pontas — o que também recusa nome vazio ou só
     de espaço —, de 1 a ``maxDisplayNameCharacters`` caracteres, e sem escalar de controle, de
     separador de linha ou de parágrafo. Um nome com `\n` ou `\u{0}` dentro não pode virar pacote:
     o leitor do outro lado receberia um `displayName` que nenhuma bandeja consegue mostrar.

     A regra de identificador técnico (IP, MAC, UUID, `VID`/`PID`) **não** é repetida aqui: ela é do
     tipo do perfil, que é a porta por onde todo nome entra, e repeti-la seria uma segunda cópia
     para divergir. Já o teto e o controle são repetidos de propósito — este escritor é público, e
     a mensagem tipada de recusa precisa existir para o gesto traduzir em vez de estourar na cara
     de quem acabou de homologar.

     ## O que esta guarda **não** prova hoje

     Pelo tipo público, ela é **inalcançável**: todo caminho até `MeasuredProfile` — inicializador,
     `validated` e o decodificador, que passa por `validated` — já aplica as mesmas três regras. O
     `throw` acima é fronteira, e não filtro em uso. O que a suíte mede é **esta função**, chamada
     direto com literais, e o **acordo** entre ela e `MeasuredProfile` nome a nome. Um mutante que
     apagasse só o `guard` do empacotamento sobreviveria; um que mexesse nesta régua, não.
     */
    static func displayNameIsPackageable(_ value: String) -> Bool {
        guard value == value.trimmingCharacters(in: .whitespacesAndNewlines),
              (1...maxDisplayNameCharacters).contains(value.count)
        else { return false }
        return !value.unicodeScalars.contains {
            switch $0.properties.generalCategory {
            case .control, .lineSeparator, .paragraphSeparator: return true
            default: return false
            }
        }
    }

    private static func textEncoding(_ encoding: ThermalTextEncoding) -> String {
        switch encoding {
        case .singleByteCodePage: return "SINGLE_BYTE_CODE_PAGE"
        case .firmwareDefaultPage: return "FIRMWARE_DEFAULT_PAGE"
        case .utf8: return "UTF8"
        case .ascii: return "ASCII"
        }
    }

    private struct Envelope: Encodable {
        let kind: String
        let version: Int
        let profile: Profile
        let platform: Platform
    }

    private struct Profile: Encodable {
        let displayName: String
        let firmwareVersion: String?
        let transports: [String]
        let paperWidthMm: Int
        let printableColumns: Int
        let printableDots: Int
        let textEncoding: String
        let codePage: String?
        let codePageSelector: UInt8?
        let cutProtocol: String
        let cutModeHonored: Bool
        let cutFeedLines: Int
        let dialect: String
        let capabilityKey: String
        let measuredAtEpochMillis: Int64

        private enum CodingKeys: String, CodingKey, CaseIterable {
            case displayName, firmwareVersion, transports, paperWidthMm, printableColumns
            case printableDots, textEncoding, codePage, codePageSelector, cutProtocol
            case cutModeHonored, cutFeedLines, dialect, capabilityKey, measuredAtEpochMillis
        }

        func encode(to encoder: Encoder) throws {
            var container = encoder.container(keyedBy: CodingKeys.self)
            try container.encode(displayName, forKey: .displayName)
            if let firmwareVersion {
                try container.encode(firmwareVersion, forKey: .firmwareVersion)
            } else {
                try container.encodeNil(forKey: .firmwareVersion)
            }
            try container.encode(transports, forKey: .transports)
            try container.encode(paperWidthMm, forKey: .paperWidthMm)
            try container.encode(printableColumns, forKey: .printableColumns)
            try container.encode(printableDots, forKey: .printableDots)
            try container.encode(textEncoding, forKey: .textEncoding)
            if let codePage {
                try container.encode(codePage, forKey: .codePage)
            } else {
                try container.encodeNil(forKey: .codePage)
            }
            if let codePageSelector {
                try container.encode(codePageSelector, forKey: .codePageSelector)
            } else {
                try container.encodeNil(forKey: .codePageSelector)
            }
            try container.encode(cutProtocol, forKey: .cutProtocol)
            try container.encode(cutModeHonored, forKey: .cutModeHonored)
            try container.encode(cutFeedLines, forKey: .cutFeedLines)
            try container.encode(dialect, forKey: .dialect)
            try container.encode(capabilityKey, forKey: .capabilityKey)
            try container.encode(measuredAtEpochMillis, forKey: .measuredAtEpochMillis)
        }
    }

    private struct Platform: Encodable {
        let os: String
        let osVersion: String
        let appVersion: String
    }
}
