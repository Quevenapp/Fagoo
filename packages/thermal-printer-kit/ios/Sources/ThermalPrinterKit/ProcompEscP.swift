import Foundation

/**
 Tabela alta da IM453H. O `n` é o que `ESC t` aceita, medido no papel em 23/08/2026.

 O mapa do manual valeu nesta firmware: uma tira com `ESC t 2` seguido de texto em CP850 saiu com o
 acento certo, e o til da linha CP850 é idêntico ao da linha ABICOMP. Não é dedução do catálogo —
 foi comparado glifo a glifo. Espelha o `ProcompCodeTable` do Android.
 */
public enum ProcompCodeTable: Sendable {
    /// Padrão de fábrica da IM453H medida. Texto codificado assim sai certo **sem** `ESC t`.
    case abicomp

    case cp850

    /// O `n` do `ESC t`, quando alguém precisar selecionar a tabela explicitamente.
    var selector: UInt8 {
        switch self {
        case .abicomp: return 1
        case .cp850: return 2
        }
    }
}

/// Os dois comandos de corte medidos. Ambos saíram **parciais**: a guilhotina é "Somente Parcial".
public enum ProcompCutCommand: Sendable {
    /// `ESC w`.
    case escW

    /// `ESC US` — corte com avanço otimizado.
    case escUS
}

/// Não existe comando de alinhamento nesta firmware; o valor escolhe como o texto é preenchido.
public enum ProcompAlignment: Sendable {
    case left
    case center
    case right
}

/**
 Emissor ESC/P da Diebold Procomp — a família da IM453H.

 **Só emite o que saiu em papel.** Cada sequência abaixo foi vista impressa na bancada em
 23/08/2026. O que não foi medido — QR nativo (`ESC ( k`), código de barras nativo (`ESC | 0`) e a
 autenticadora (`ESC }`, `ESC U`, `ESC V`) — **não tem função aqui**, de propósito. Nesta impressora,
 mandar byte não medido já custou o aparelho travado com a tecla de avanço morta e recuperação só no
 desligar e ligar.

 **Duas ausências que são decisão:**

 * **não existe init.** `ESC @` não é comando desta firmware — ele sai como `@` no papel, e foi assim
   que se descobriu que o prólogo do transporte era nosso. ``reset()`` desliga cada atributo com o
   comando que **desliga aquele atributo**, todos medidos, em vez de confiar num reset único que só o
   manual promete;
 * **não existe alinhamento.** Não há `ESC a`. Quem centraliza é preenchimento — ver ``padded(_:columns:alignment:)``.

 Espelha `android/src/main/java/br/com/thermalprinterkit/ProcompEscP.kt`, sequência por sequência.
 */
public enum ProcompEscP {
    /// Colunas medidas no recibo da IM453H: a régua de 48 dígitos coube em uma linha, sem sobra.
    public static let measuredReceiptColumns = 48

    /**
     Devolve o estado conhecido desligando atributo por atributo.

     `ESC M` existe no manual como "zera atributos" e, medido, **não deixa glifo** — mas "não
     imprimiu nada" não é "zerou os atributos", e essa é a diferença que já custou caro neste
     projeto. Os quatro desligamentos abaixo foram vistos agindo no papel, um a um.
     */
    public static func reset() -> Data {
        Data([
            esc, emphasisOffByte,
            esc, expandedOffByte,
            esc, condensedOffByte,
            esc, doubleHeightByte, off,
        ])
    }

    /// `ESC t n`. Desnecessário quando o texto já vai em ``ProcompCodeTable/abicomp`` e a impressora
    /// está no padrão de fábrica — o papel provou que ABICOMP direto sai certo sem seletor nenhum.
    public static func selectCodeTable(_ table: ProcompCodeTable) -> Data {
        Data([esc, selectTable, table.selector])
    }

    public static func emphasisOn() -> Data { Data([esc, emphasisOnByte]) }

    public static func emphasisOff() -> Data { Data([esc, emphasisOffByte]) }

    public static func expandedOn() -> Data { Data([esc, expandedOnByte]) }

    public static func expandedOff() -> Data { Data([esc, expandedOffByte]) }

    public static func condensedOn() -> Data { Data([esc, condensedOnByte]) }

    public static func condensedOff() -> Data { Data([esc, condensedOffByte]) }

    public static func doubleHeight(_ enabled: Bool) -> Data {
        Data([esc, doubleHeightByte, enabled ? on : off])
    }

    /**
     Avanço por `LF`. A firmware imprime a linha corrente a cada `0Ah`.

     Fora da faixa medida devolve `nil`, e não uma tira truncada: quem passa número à mão precisa
     ouvir "não". É a divergência de linguagem com o Kotlin, que lança `IllegalArgumentException` —
     no kit Swift os emissores recusam por `nil`, e é o contrato que ``ReceiptLayout`` já cobra dos
     outros caminhos.
     */
    public static func feed(lines: Int) -> Data? {
        guard (0...maxFeedLines).contains(lines) else { return nil }
        return Data(repeating: lineFeed, count: lines)
    }

    /// Os dois cortam, e os dois cortam **parcial** nesta configuração de guilhotina.
    public static func cut(_ command: ProcompCutCommand) -> Data {
        switch command {
        case .escW: return Data([esc, cutEscW])
        case .escUS: return Data([esc, cutEscUS])
        }
    }

    /**
     Codifica texto na tabela alta pedida.

     Caractere sem lugar na tabela **dobra para ASCII** antes de virar `?`: "ação" numa tabela sem
     `ç` sai "acao", que é legível, e não "a?ao", que não é. É a mesma escolha que o kit já fazia no
     caminho Epson.

     **Divergência declarada com o Kotlin, e ela é de linguagem.** Aqui a string é normalizada em
     NFC antes de codificar, como ``EscPos`` já faz no caminho de página de código: o mapa guarda
     `é`, e não `e` seguido de acento combinante. Para texto já composto — o caso normal, e o único
     que as duas plataformas recebem de um `String` literal — os bytes são os mesmos do Kotlin.
     */
    public static func encode(_ value: String, table: ProcompCodeTable) -> Data {
        let high = table == .abicomp ? abicompHigh : cp850High
        var data = Data()
        for scalar in value.precomposedStringWithCanonicalMapping.unicodeScalars {
            if scalar.value == UInt32(lineFeed) || isPrintableASCII(scalar) {
                data.append(UInt8(scalar.value))
            } else if let mapped = high[scalar] {
                data.append(mapped)
            } else if let folded = asciiFold[scalar] {
                data.append(contentsOf: Array(folded.utf8))
            } else {
                data.append(fallback)
            }
        }
        return data
    }

    /**
     O alinhamento desta impressora é preenchimento, porque não existe `ESC a`.

     Devolve o texto com espaços à esquerda para centralizar em `columns`. Texto que não cabe volta
     inteiro e sem recuo: cortar silenciosamente um recibo é pior que uma linha torta.
     */
    public static func padded(
        _ value: String,
        columns: Int = measuredReceiptColumns,
        alignment: ProcompAlignment = .left
    ) -> String {
        guard value.count < columns else { return value }
        let sobra = columns - value.count
        switch alignment {
        case .left: return value
        case .center: return String(repeating: " ", count: sobra / 2) + value
        case .right: return String(repeating: " ", count: sobra) + value
        }
    }

    private static func isPrintableASCII(_ scalar: Unicode.Scalar) -> Bool {
        (0x20...0x7E).contains(scalar.value)
    }

    private static let esc: UInt8 = 0x1B
    static let lineFeed: UInt8 = 0x0A
    private static let fallback: UInt8 = 0x3F
    private static let on: UInt8 = 0x01
    private static let off: UInt8 = 0x00
    private static let maxFeedLines = 64

    /// `ESC E` / `ESC F` — **sem parâmetro**, ao contrário do ESC/POS. Medido: nada é consumido.
    private static let emphasisOnByte: UInt8 = 0x45
    private static let emphasisOffByte: UInt8 = 0x46

    /// `ESC SO` / `ESC DC4`.
    private static let expandedOnByte: UInt8 = 0x0E
    private static let expandedOffByte: UInt8 = 0x14

    /// `ESC SI` / `ESC DC2`.
    private static let condensedOnByte: UInt8 = 0x0F
    private static let condensedOffByte: UInt8 = 0x12

    /// `ESC ] n`.
    private static let doubleHeightByte: UInt8 = 0x5D
    private static let selectTable: UInt8 = 0x74
    private static let cutEscW: UInt8 = 0x77
    private static let cutEscUS: UInt8 = 0x1F

    /**
     Tabela alta ABICOMP, `A1`–`DF`.

     **Provados em papel** nas tiras M2 e M3 de 23/08/2026: `ç`=`C6`, `ã`=`C4`, `ê`=`C9`, `á`=`C2`,
     `õ`=`D3`. Em 26/08/2026 o comprovante da homologação acrescentou as 24 posições da amostra de
     acentos, **maiúsculas inclusive** — `à ã á â é ê í ó ô õ ú À Ã Á Â É Ê Í Ó Ô Õ Ú ç Ç` —, que é a
     metade da tabela onde a T210 tinha errado em 12/08 sem ninguém ver.

     O restante vem da seção 11.1 do manual e continua **sem** papel — o que não é motivo para não
     emitir, mas é motivo para não jurar.
     */
    private static let abicompHigh: [Unicode.Scalar: UInt8] = [
        "À": 0xA1, "Á": 0xA2, "Â": 0xA3, "Ã": 0xA4, "Ä": 0xA5, "Ç": 0xA6,
        "È": 0xA7, "É": 0xA8, "Ê": 0xA9, "Ë": 0xAA, "Ì": 0xAB, "Í": 0xAC,
        "Î": 0xAD, "Ï": 0xAE, "Ñ": 0xAF, "Ò": 0xB0, "Ó": 0xB1, "Ô": 0xB2,
        "Õ": 0xB3, "Ö": 0xB4, "Œ": 0xB5, "Ù": 0xB6, "Ú": 0xB7, "Û": 0xB8,
        "Ü": 0xB9, "Ÿ": 0xBA, "¨": 0xBB, "£": 0xBC, "§": 0xBE, "°": 0xBF,
        "¡": 0xC0, "à": 0xC1, "á": 0xC2, "â": 0xC3, "ã": 0xC4, "ä": 0xC5,
        "ç": 0xC6, "è": 0xC7, "é": 0xC8, "ê": 0xC9, "ë": 0xCA, "ì": 0xCB,
        "í": 0xCC, "î": 0xCD, "ï": 0xCE, "ñ": 0xCF, "ò": 0xD0, "ó": 0xD1,
        "ô": 0xD2, "õ": 0xD3, "ö": 0xD4, "œ": 0xD5, "ù": 0xD6, "ú": 0xD7,
        "û": 0xD8, "ü": 0xD9, "ÿ": 0xDA, "ß": 0xDB, "ª": 0xDC, "º": 0xDD,
        "¿": 0xDE, "±": 0xDF,
    ]

    /// CP850, só o subconjunto que o português usa. A tabela inteira não foi medida nesta firmware.
    private static let cp850High: [Unicode.Scalar: UInt8] = [
        "Ç": 0x80, "ü": 0x81, "é": 0x82, "â": 0x83, "ä": 0x84, "à": 0x85,
        "ç": 0x87, "ê": 0x88, "ë": 0x89, "è": 0x8A, "ï": 0x8B, "î": 0x8C,
        "Á": 0xB5, "Â": 0xB6, "À": 0xB7, "ã": 0xC6, "Ã": 0xC7, "í": 0xA1,
        "ó": 0xA2, "ú": 0xA3, "ñ": 0xA4, "Ñ": 0xA5, "ª": 0xA6, "º": 0xA7,
        "¿": 0xA8, "É": 0x90, "ô": 0x93, "ö": 0x94, "ò": 0x95, "û": 0x96,
        "ù": 0x97, "Õ": 0xE5, "õ": 0xE4, "Ó": 0xE0, "Ô": 0xE2, "Ú": 0xE9,
        "Í": 0xD6, "Ê": 0xD2,
    ]

    /// Dobra de último recurso: melhor "acao" que "a?ao".
    private static let asciiFold: [Unicode.Scalar: String] = [
        "À": "A", "Á": "A", "Â": "A", "Ã": "A", "Ä": "A", "Ç": "C",
        "È": "E", "É": "E", "Ê": "E", "Ë": "E", "Ì": "I", "Í": "I",
        "Î": "I", "Ï": "I", "Ñ": "N", "Ò": "O", "Ó": "O", "Ô": "O",
        "Õ": "O", "Ö": "O", "Ù": "U", "Ú": "U", "Û": "U", "Ü": "U",
        "à": "a", "á": "a", "â": "a", "ã": "a", "ä": "a", "ç": "c",
        "è": "e", "é": "e", "ê": "e", "ë": "e", "ì": "i", "í": "i",
        "î": "i", "ï": "i", "ñ": "n", "ò": "o", "ó": "o", "ô": "o",
        "õ": "o", "ö": "o", "ù": "u", "ú": "u", "û": "u", "ü": "u",
        "ª": "a", "º": "o", "ß": "ss",
    ]
}
