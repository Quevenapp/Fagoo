import CoreGraphics
import CoreImage
import CoreImage.CIFilterBuiltins
import Foundation

/// Identidade textual declarada pela própria firmware nas variantes estendidas de `GS I`.
public struct PrinterDeclaredIdentity: Equatable, Sendable, CustomStringConvertible {
    public let firmwareVersion: String?
    public let manufacturer: String?
    public let model: String?

    public init?(firmwareVersion: String? = nil, manufacturer: String? = nil, model: String? = nil) {
        let values = [firmwareVersion, manufacturer, model].compactMap { $0 }
        guard !values.isEmpty,
              values.allSatisfy({ Self.sanitizeField(Data($0.utf8)) == $0 })
        else { return nil }
        self.firmwareVersion = firmwareVersion
        self.manufacturer = manufacturer
        self.model = model
    }

    /// Modelo continua no único campo de marca/modelo permitido pelo perfil: `displayName`.
    func displayName(or fallback: String) -> String {
        let candidate: String
        if let manufacturer, let model,
           !model.lowercased().hasPrefix(manufacturer.lowercased()) {
            candidate = "\(manufacturer) \(model)"
        } else {
            candidate = model ?? manufacturer ?? fallback
        }
        return candidate.count <= 80 ? candidate : fallback
    }

    public var description: String { "PrinterDeclaredIdentity(disponivel=true)" }

    static let maxFieldBytes = 64

    public static func sanitizeField(_ bytes: Data) -> String? {
        guard !bytes.isEmpty, bytes.count <= maxFieldBytes,
              bytes.allSatisfy({ (0x20...0x7e).contains($0) }),
              let value = String(data: bytes, encoding: .ascii)
        else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespaces)
        // O filtro roda no bruto **antes** de tirar rótulo: `AA:BB:CC:DD:EE:FF` é MAC, e tirar o
        // `AA:` como se fosse rótulo deixaria o resto passar por não parecer mais um MAC.
        guard !trimmed.isEmpty, isFree(of: technicalIdentifierPatterns, trimmed) else { return nil }
        let semRotulo = withoutFieldLabel(trimmed).trimmingCharacters(in: .whitespaces)
        // E de novo no que sobrou, porque o rótulo pode esconder o identificador.
        guard !semRotulo.isEmpty, isFree(of: technicalIdentifierPatterns, semRotulo) else { return nil }
        return semRotulo
    }

    private static func isFree(of patterns: [String], _ value: String) -> Bool {
        patterns.allSatisfy { value.range(of: $0, options: .regularExpression) == nil }
    }

    /// Tira o rótulo que algumas firmwares mandam junto do valor.
    ///
    /// A J-SPEED P80 responde `_Manufacturer:J-SPEED` e `_Print Name:P80-Serials`, e o `_8.00
    /// ESC/POS` da versão. Guardar isso inteiro batizava o perfil de `_Manufacturer:J-SPEED _Print
    /// Name:P80-Serials` — o nome que iria para o perfil. Só cai fora um prefixo de letras e
    /// espaços seguido de dois pontos; modelo com dois pontos no meio do nome sobrevive.
    private static func withoutFieldLabel(_ value: String) -> String {
        var semSublinhado = value
        if semSublinhado.hasPrefix("_") { semSublinhado.removeFirst() }
        guard let rotulo = semSublinhado.range(
            of: "^[A-Za-z][A-Za-z ]{0,30}:",
            options: .regularExpression
        ) else { return semSublinhado }
        return String(semSublinhado[rotulo.upperBound...])
    }

    static func fromResponses(firmware: Data?, manufacturer: Data?, model: Data?) -> Self? {
        Self(
            firmwareVersion: firmware.flatMap(sanitizeField),
            manufacturer: manufacturer.flatMap(sanitizeField),
            model: model.flatMap(sanitizeField)
        )
    }

    private static let technicalIdentifierPatterns = [
        #"(?:^|\D)(?:\d{1,3}\.){3}\d{1,3}(?:$|\D)"#,
        #"(?i)(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}"#,
        #"(?i)\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b"#,
    ]
}

/// Página de código do texto ESC/POS.
///
/// A tabela é escrita à mão em vez de pedir a codificação ao sistema porque `String.Encoding` não
/// expõe CP850 no iOS, e a alternativa seria arrastar iconv só para isso. Escrita à mão ela também
/// fica byte a byte igual à do Android, e as duas plataformas imprimem o mesmo cupom.
///
/// CP850 é o padrão por ser a mais aceita pelas impressoras; CP860 é a página portuguesa e fica
/// disponível para modelo que só entenda ela.
///
/// **Não existe uma página certa para todas.** Ela é firmware de cada impressora, e por isso quem a
/// carrega é o `ReceiptLayout`, que vem do perfil — nunca uma constante global. Modelo que ignora
/// `ESC t` recebe `nil` e imprime o acento dobrado para ASCII.
public enum ThermalCodePage: UInt8, CaseIterable, Codable, Sendable {
    case cp437 = 0
    case cp850 = 2
    case cp860 = 3
    case cp1252 = 16
    case cp866 = 17
    case cp858 = 19

    public var label: String {
        switch self {
        case .cp437: return "CP437"
        case .cp850: return "CP850"
        case .cp860: return "CP860"
        case .cp1252: return "CP1252"
        case .cp866: return "CP866"
        case .cp858: return "CP858"
        }
    }

    /// Byte da página para o caractere, ou `nil` se ela não o representa.
    func encode(_ scalar: Unicode.Scalar) -> UInt8? {
        switch self {
        case .cp437: return Self.cp437Table[scalar]
        case .cp850, .cp858: return Self.cp850Table[scalar]
        case .cp860: return Self.cp860Table[scalar]
        case .cp1252:
            // Os caracteres portugueses usados pelo kit ocupam os mesmos bytes do Latin-1 nesta
            // página. A faixa de controle 0x80...0x9f não é emitida por esta conversão.
            return (0xA0...0xFF).contains(scalar.value) ? UInt8(scalar.value) : nil
        case .cp866:
            // CP866 é cirílica e não representa os acentos portugueses. Ela continua entre as
            // sondas porque algumas firmwares associam outra tabela ao mesmo número de `ESC t`.
            return nil
        }
    }

    // Só o que aparece em português. Qualquer coisa fora daqui cai no dobramento para ASCII, que é
    // o comportamento antigo e continua sendo a rede de segurança.
    private static let cp850Table: [Unicode.Scalar: UInt8] = [
        "Ç": 0x80, "ü": 0x81, "é": 0x82, "â": 0x83, "ä": 0x84, "à": 0x85,
        "ç": 0x87, "ê": 0x88, "ë": 0x89, "è": 0x8A, "ï": 0x8B, "î": 0x8C,
        "ì": 0x8D, "É": 0x90, "ô": 0x93, "ö": 0x94, "ò": 0x95, "û": 0x96,
        "ù": 0x97, "Ö": 0x99, "Ü": 0x9A, "á": 0xA0, "í": 0xA1, "ó": 0xA2,
        "ú": 0xA3, "ñ": 0xA4, "Ñ": 0xA5, "ª": 0xA6, "º": 0xA7, "Á": 0xB5,
        "Â": 0xB6, "À": 0xB7, "ã": 0xC6, "Ã": 0xC7, "Ê": 0xD2, "Ë": 0xD3,
        "È": 0xD4, "Í": 0xD6, "Î": 0xD7, "Ï": 0xD8, "Ó": 0xE0, "Ô": 0xE2,
        "Ò": 0xE3, "õ": 0xE4, "Õ": 0xE5, "Ú": 0xE9, "Û": 0xEA, "Ù": 0xEB,
        "°": 0xF8,
    ]

    // CP437 compartilha esta parte da tabela com CP850. Letras portuguesas que ela não representa
    // caem no dobramento ASCII; a sonda histórica abaixo usa seus próprios bytes medidos.
    private static let cp437Table: [Unicode.Scalar: UInt8] = [
        "Ç": 0x80, "ü": 0x81, "é": 0x82, "â": 0x83, "ä": 0x84, "à": 0x85,
        "ç": 0x87, "ê": 0x88, "ë": 0x89, "è": 0x8A, "ï": 0x8B, "î": 0x8C,
        "ì": 0x8D, "É": 0x90, "ô": 0x93, "ö": 0x94, "ò": 0x95, "û": 0x96,
        "ù": 0x97, "Ö": 0x99, "Ü": 0x9A, "á": 0xA0, "í": 0xA1, "ó": 0xA2,
        "ú": 0xA3, "ñ": 0xA4, "Ñ": 0xA5, "ª": 0xA6, "º": 0xA7,
    ]

    private static let cp860Table: [Unicode.Scalar: UInt8] = [
        "Ç": 0x80, "ü": 0x81, "é": 0x82, "â": 0x83, "ã": 0x84, "à": 0x85,
        "Á": 0x86, "ç": 0x87, "ê": 0x88, "Ê": 0x89, "è": 0x8A, "Í": 0x8B,
        "Ô": 0x8C, "ì": 0x8D, "Ã": 0x8E, "Â": 0x8F, "É": 0x90, "À": 0x91,
        "È": 0x92, "ô": 0x93, "õ": 0x94, "ò": 0x95, "Ú": 0x96, "ù": 0x97,
        "Ì": 0x98, "Õ": 0x99, "Ü": 0x9A, "Ó": 0x9F, "á": 0xA0, "í": 0xA1,
        "ó": 0xA2, "ú": 0xA3, "ñ": 0xA4, "Ñ": 0xA5, "ª": 0xA6, "º": 0xA7,
        "Ò": 0xA9, "°": 0xF8,
    ]
}

/// Como a firmware recebe texto; os comandos ESC/POS continuam binários nos três casos.
public enum ThermalTextEncoding: String, Codable, CaseIterable, Sendable {
    case singleByteCodePage = "SINGLE_BYTE_CODE_PAGE"
    /// Tabela de byte único que a firmware já liga sozinha; o kit **não** emite `ESC t`. Medido na
    /// T210: a linha sem seleção sai com todos os acentos, e `ESC t 3` — o canônico da CP860 —
    /// troca para outra tabela e estraga.
    case firmwareDefaultPage = "FIRMWARE_DEFAULT_PAGE"
    case utf8 = "UTF_8"
    case ascii = "ASCII"

    /// Verdadeiro quando o texto sai por tabela de byte único, com ou sem `ESC t`.
    public var usesCodePage: Bool { self == .singleByteCodePage || self == .firmwareDefaultPage }

    public var label: String {
        switch self {
        case .firmwareDefaultPage: return "Página padrão da impressora"
        case .singleByteCodePage: return "Página de byte único"
        case .utf8: return "UTF-8"
        case .ascii: return "Sem acentos (ASCII)"
        }
    }

    /// Cabe em 32 colunas junto do rótulo. O nome longo estourava a linha e quebrava no meio da
    /// palavra — a T210 imprimiu "Página de byte únic / o".
    public var receiptLabel: String {
        switch self {
        case .firmwareDefaultPage: return "Padrão da impressora"
        case .singleByteCodePage: return "Byte único"
        case .utf8: return "UTF-8"
        case .ascii: return "Sem acentos"
        }
    }
}

/// ESC/POS puro, sem SDK de fornecedor. Serve aos dois transportes: o Bluetooth monta o mesmo
/// cupom que a Wi-Fi, só muda a largura do papel e a existência de guilhotina.
public enum EscPos {
    /// Largura preferida do QR em pontos, igual à do Android para o mesmo cupom.
    static let preferredQRWidthDots = 320

    /// Nível Q de correção: sobrevive a papel térmico borrado e a dedo engordurado. Fixo porque a
    /// carga protegida só tem um formato, e um nível menor economizaria módulos sem necessidade.
    private static let qrCorrectionLevel = "Q"

    public static func initialize() -> Data { Data([esc, initializePrinter]) }

    /// Firmware (65), fabricante (66) e modelo (67). Serial (68) não é consultado por privacidade.
    public static let firmwareVersionQuery = Data([gs, transmitPrinterID, 65])
    public static let manufacturerQuery = Data([gs, transmitPrinterID, 66])
    public static let modelQuery = Data([gs, transmitPrinterID, 67])

    /**
     Gera o pulso da porta de gaveta (`ESC p m t1 t2`), sem afirmar que ela abriu.

     A API recebe o número físico impresso no conector: pino 2 vira `m = 0` e pino 5 vira
     `m = 1`. Os tempos são unidades ESC/POS de 2 ms. Os argumentos continuam como `Int` para a
     validação acontecer antes da conversão; inicializar `UInt8` por truncamento faria um valor
     inválido chegar ao transporte como outro pulso válido.
     */
    public static func drawerKickPulse(pin: Int, onTime: Int, offTime: Int) -> Data? {
        let connector: UInt8
        switch pin {
        case drawerPin2: connector = drawerOutput1
        case drawerPin5: connector = drawerOutput2
        default: return nil
        }
        guard byteRange.contains(onTime), byteRange.contains(offTime) else { return nil }
        return Data([esc, drawerPulse, connector, UInt8(onTime), UInt8(offTime)])
    }

    /**
     Um bloco de texto.

     `codePage` só existe em `.singleByteCodePage`. Em `.utf8` e `.ascii`, `ESC t` não é emitido; o
     primeiro preserva os acentos em UTF-8 e o segundo os dobra de forma conservadora. O parâmetro
     `textEncoding = nil` mantém a compatibilidade antiga, inferindo ASCII quando a página é nula.
     */
    public static func text(
        _ value: String,
        alignment: UInt8,
        bold: Bool,
        size: UInt8,
        codePage: ThermalCodePage? = .cp850,
        codePageSelector: UInt8? = nil,
        textEncoding: ThermalTextEncoding? = nil
    ) -> Data {
        // `nil` preserva chamadas anteriores: página presente significa byte único; página ausente
        // continua sendo a dobra ASCII conservadora.
        let resolvedEncoding = textEncoding ?? (codePage == nil ? .ascii : .singleByteCodePage)
        // `FIRMWARE_DEFAULT_PAGE` **usa** a tabela para codificar e não emite `ESC t`. A condição
        // aqui era `== .singleByteCodePage`, e por isso qualquer texto de um perfil de página
        // padrão derrubava o app — inclusive o comprovante final que o adota. O Android já usava
        // `usesCodePage`; era a mesma regra escrita duas vezes, uma certa e uma errada.
        precondition(resolvedEncoding.usesCodePage == (codePage != nil))
        precondition(resolvedEncoding == .singleByteCodePage || codePageSelector == nil)
        var data = Data()
        // `ESC @` zera a página de código, então ela é reafirmada a cada bloco de texto. Quem não
        // não usa página nem chega a ver o comando. Mandar `ESC t` para firmware UTF-8 ou ASCII é
        // ruído no melhor caso, e já houve portátil que comeu o começo da linha.
        // O endereço da página não é o mesmo em toda firmware. Medido na bancada: a T210
        // (`58E_BT`) atende a CP860 em `ESC t 8`, não no 3 canônico, e responde com tabela
        // tailandesa no `n` reservado à CP1252. Sem medição, vale o canônico do enum.
        if resolvedEncoding == .singleByteCodePage, let codePage {
            data.append(contentsOf: [esc, selectCodePage, codePageSelector ?? codePage.rawValue])
        }
        data.append(contentsOf: [
            esc, align, alignment,
            esc, boldMode, bold ? 1 : 0,
        ])
        // `GS !` só sai quando há tamanho para pedir. A MP-4200 TH não implementa esse comando e
        // engole apenas o `GS`: o `!` vai para o papel como texto, e na sonda de avanço saiu "!0"
        // no número e "!!Escolha" na instrução. Bloco em tamanho normal não precisa do comando —
        // `ESC @` já zera o tamanho, e todo bloco que amplia devolve a zero no fim, então o estado
        // continua conhecido sem sujar a linha de quem não entende `GS !`.
        if size != 0 {
            data.append(contentsOf: [gs, textSize, size])
        }
        data.append(encode(value, textEncoding: resolvedEncoding, codePage: codePage))
        data.append(contentsOf: [esc, boldMode, 0])
        if size != 0 {
            data.append(contentsOf: [gs, textSize, 0])
        }
        return data
    }

    /// Avanço de papel até a serrilha, em quebras de linha, não em `ESC d n`.
    ///
    /// A MP-4200 TH ignora o `ESC d`: na sonda de avanço as oito tiras saíram do mesmo tamanho, de
    /// zero a doze, e a medida que o perfil grava não mudava nada no papel. `LF` não tem como ser
    /// ignorado por quem imprime texto — é ele que separa as linhas do próprio cupom, e a Bematech
    /// imprime as linhas. Em firmware que atende os dois, `n` quebras avançam exatamente o mesmo
    /// que `ESC d n`, então quem já estava certo não muda.
    public static func advance(lines: UInt8) -> Data {
        Data(repeating: lineFeed, count: Int(lines))
    }

    /// Avanço e corte total (`GS V 0`).
    public static func cut(lines: UInt8) -> Data {
        advance(lines: lines) + Data([gs, cutPaper, fullCut])
    }

    /**
     Rasteriza o QR antes do ESC/POS.

     **Nunca** use o comando QR nativo (`GS ( k`): firmware que não o entende imprime o payload
     como texto legível no papel, e o payload protegido pode carregar uma assinatura de capacidade.
     Imprimir essa assinatura como texto permitiria copiá-la. A imagem carrega só bits.
     */
    public static func qrRaster(
        payload: String,
        widthDots: Int,
        verticalRasterScale: Double? = nil
    ) -> Data? {
        qrRaster(
            payload: payload,
            widthDots: widthDots,
            verticalRasterScale: verticalRasterScale,
            emission: .escPos
        )
    }

    /**
     O mesmo QR, com o envelope de raster escolhido pelo dialeto.

     Sobrecarga **interna** de propósito: o símbolo e o empacotamento em bits são idênticos nos dois
     dialetos, e só o envelope muda — mas ``RasterEmission`` é detalhe do kit, e a assinatura pública
     acima continua exatamente como sempre foi. Espelha a sobrecarga interna do Kotlin.
     */
    static func qrRaster(
        payload: String,
        widthDots: Int,
        verticalRasterScale: Double?,
        emission: RasterEmission
    ) -> Data? {
        guard !payload.isEmpty,
              payload.utf8.count <= maxQRBytes,
              payload.utf8.allSatisfy({ (printableASCIIMin...printableASCIIMax).contains($0) }),
              widthDots >= minQRWidthDots, widthDots <= maxQRWidthDots, widthDots % 8 == 0,
              let modules = qrModules(payload: payload, widthDots: widthDots)
        else { return nil }
        var raster = OneBitRasterMatrix(
            widthDots: widthDots,
            heightDots: widthDots,
            pixels: modules
        )
        return emission.emit(source: &raster, verticalRasterScale: verticalRasterScale)
    }

    /**
     Converte uma imagem possuída pelo cupom e a emite em faixas `GS v 0` centralizadas.

     `printableDots` vem do perfil em uso. A imagem é reduzida quando excede essa largura e nunca é
     ampliada quando é menor. Foto usa Floyd–Steinberg por padrão; logotipo deve pedir
     `.threshold` explicitamente.

     `stripeHeightDots` é a altura de cada banda `GS v 0`. O padrão é o de sempre e os bytes não
     mudam por este parâmetro existir; ver ``ReceiptLayout/defaultRasterStripeHeightDots``.
     */
    public static func imageRaster(
        image: ThermalImage,
        printableDots: Int,
        mode: ThermalImageMode = .floydSteinberg,
        stripeHeightDots: Int = ReceiptLayout.defaultRasterStripeHeightDots,
        verticalRasterScale: Double? = nil
    ) -> Data? {
        imageRaster(
            image: image,
            printableDots: printableDots,
            mode: mode,
            stripeHeightDots: stripeHeightDots,
            verticalRasterScale: verticalRasterScale,
            emission: .escPos
        )
    }

    /// A mesma imagem com o envelope de raster do dialeto. Interna pela razão da sobrecarga de
    /// ``qrRaster(payload:widthDots:verticalRasterScale:emission:)``: o meio-tom é o mesmo, o
    /// envelope não.
    static func imageRaster(
        image: ThermalImage,
        printableDots: Int,
        mode: ThermalImageMode,
        stripeHeightDots: Int,
        verticalRasterScale: Double?,
        emission: RasterEmission
    ) -> Data? {
        guard var raster = ThermalImageOneBitRasterSource(
            image: image,
            printableDots: printableDots,
            mode: mode
        ) else { return nil }
        return emission.emit(
            source: &raster,
            stripeHeightDots: stripeHeightDots,
            verticalRasterScale: verticalRasterScale
        )
    }

    /**
     Desenha o código de barras em pontos e o emite pelo emissor `GS v 0` de sempre.

     Caminho cru, como ``qrRaster(payload:widthDots:verticalRasterScale:)``: sem perfil, sem página
     de código e sem legenda. Quem passa número à mão precisa ouvir "não", então validação reprovada
     devolve `nil` — largura de módulo fora da faixa, altura fora da faixa, conteúdo que a simbologia
     não aceita, ou símbolo que não cabe em `printableDots` com as duas zonas de silêncio da norma.

     **HRI não sai daqui.** A legenda precisa da página de código medida daquela impressora para
     sair com o texto certo, e este emissor não tem perfil para consultar — pela mesma razão que não
     tem fator para compensar. Quem emite a legenda é o layout, com `text(...)`.

     - Parameter verticalRasterScale: fator medido do perfil, ou `nil` para não compensar nada.
       Barra encolhida na vertical continua legível, mas a altura pedida é a altura que se quer no
       papel; ver ``ReceiptLayout/allowedVerticalRasterScale``.
     */
    public static func barcodeRaster(
        value: String,
        symbology: ThermalBarcodeSymbology,
        moduleWidthDots: Int,
        heightDots: Int,
        printableDots: Int,
        verticalRasterScale: Double? = nil
    ) -> Data? {
        barcodeRaster(
            value: value,
            symbology: symbology,
            moduleWidthDots: moduleWidthDots,
            heightDots: heightDots,
            printableDots: printableDots,
            verticalRasterScale: verticalRasterScale,
            emission: .escPos
        )
    }

    /**
     O mesmo código de barras com o envelope de raster do dialeto.

     **Divergência com o Kotlin, e ela é deliberada.** Lá `ReceiptLayout.barcode` ainda chama o
     emissor `GS v 0` direto, sem passar o envelope: é o mesmo defeito que `monochromeRaster` tinha
     até 27/08/2026, sobrando num terceiro caminho. Copiá-lo aqui seria plantar em Swift a armadilha
     que este lote existe para fechar — um layout Procomp cujo código de barras manda `GS v 0` para
     uma firmware sem `GS`. Fica registrado para o dono do lado Kotlin.
     */
    static func barcodeRaster(
        value: String,
        symbology: ThermalBarcodeSymbology,
        moduleWidthDots: Int,
        heightDots: Int,
        printableDots: Int,
        verticalRasterScale: Double?,
        emission: RasterEmission
    ) -> Data? {
        guard ThermalBarcode.moduleWidthDotsRange.contains(moduleWidthDots),
              ThermalBarcode.heightDotsRange.contains(heightDots),
              ThermalBarcode.printableDotsRange.contains(printableDots),
              printableDots % 8 == 0,
              let modules = ThermalBarcode.modules(value, symbology: symbology)
        else { return nil }
        let totalModules =
            symbology.quietZoneModulesStart + modules.count + symbology.quietZoneModulesEnd
        let contentDots = totalModules * moduleWidthDots
        guard contentDots <= printableDots else { return nil }
        // O `GS v 0` empacota oito pontos por byte, então a linha sobe para o múltiplo de 8
        // seguinte. A sobra é zona clara, e ela é dividida entre os dois lados para o símbolo
        // continuar no centro exato do bloco que o `ESC a 1` centraliza.
        let widthDots = (contentDots + 7) / 8 * 8
        let leftPadding =
            (widthDots - contentDots) / 2 + symbology.quietZoneModulesStart * moduleWidthDots
        // Código de barras é uma linha extrudada: todas as linhas são a mesma, então a linha é
        // montada uma vez e repetida em cada faixa.
        var row = [Bool](repeating: false, count: widthDots)
        for (index, black) in modules.enumerated() where black {
            for dot in 0..<moduleWidthDots {
                row[leftPadding + index * moduleWidthDots + dot] = true
            }
        }
        var raster = ExtrudedRowRasterSource(row: row, heightDots: heightDots)
        return emission.emit(source: &raster, verticalRasterScale: verticalRasterScale)
    }

    /**
     Pede o código de barras à firmware (`GS k`), sem afirmar que ela sabe desenhá-lo.

     Nada aqui infere capacidade: a função monta bytes. Quem decide se este caminho pode ser usado é
     a capacidade medida pela sonda, numa camada acima — firmware que não entende `GS k` imprime o
     payload como texto legível, e é por isso que a decisão não pode ser um palpite.

     O símbolo é o mesmo do ``barcodeRaster(value:symbology:moduleWidthDots:heightDots:printableDots:verticalRasterScale:)``
     para o mesmo conteúdo: a régua de módulos é uma só, e no Code 128 as trocas de conjunto viajam
     nos escapes `{A {B {C` exatamente onde o desenho as colocou. Muda só quem desenha os módulos.

     `GS H` e `GS f` saem sempre, mesmo com `humanReadable` falso: o nativo é estado, a impressora
     pode ter ficado com outra fonte de um cupom anterior, e o mesmo conteúdo tem de dar os mesmos
     bytes independentemente do que veio antes. `ESC a 1` entra e `ESC a 0` sai no mesmo comando,
     pelo mesmo motivo.
     */
    public static func barcodeNative(
        value: String,
        symbology: ThermalBarcodeSymbology,
        moduleWidthDots: Int,
        heightDots: Int,
        humanReadable: Bool
    ) -> Data? {
        guard ThermalBarcode.moduleWidthDotsRange.contains(moduleWidthDots),
              ThermalBarcode.heightDotsRange.contains(heightDots),
              let data = ThermalBarcode.nativeData(value, symbology: symbology),
              let selector = UInt8(exactly: symbology.nativeSelector)
        else { return nil }
        var command = Data([esc, align, centerAlignment])
        command.append(contentsOf: [gs, barcodeHeight, UInt8(heightDots)])
        command.append(contentsOf: [gs, barcodeModuleWidth, UInt8(moduleWidthDots)])
        command.append(contentsOf: [gs, barcodeHRIPosition, humanReadable ? hriBelow : hriNone])
        command.append(contentsOf: [gs, barcodeHRIFont, hriFontA])
        // Função B do `GS k`, com contagem explícita: a função A termina em `NUL` e não sabe dizer
        // que o dado tinha um zero dentro — e no conjunto C do Code 128 ele tem.
        command.append(contentsOf: [gs, barcodePrint, selector, UInt8(data.count)])
        command.append(contentsOf: data)
        command.append(contentsOf: [esc, align, leftAlignment])
        return command
    }

    /**
     Pede o QR à firmware (`GS ( k`), sem afirmar que ela sabe desenhá-lo.

     **Este caminho nunca serve a QR protegido.** Firmware que não entende o comando imprime o
     payload como texto legível no papel, e uma assinatura de capacidade impressa é uma assinatura
     copiável. Carga protegida continua obrigatoriamente em
     ``qrRaster(payload:widthDots:verticalRasterScale:)``.

     O teto de ``ThermalBarcode/qrNativeMaxBytes`` é o menor dos dois tetos de raster que o kit
     publica, de propósito: quando a capacidade medida não existe, o layout cai para o raster, e um
     payload que só o nativo aceitasse falharia exatamente na hora da queda.

     - Parameter errorCorrection: os mesmos códigos de pedido do Android: 1=L, 2=M, 3=Q, 4=H. O
       raster deste lado ainda é fixo em Q — divergência antiga, registrada, e que esta função não
       herda porque o comando nativo carrega o nível explicitamente.
     */
    public static func qrNative(
        payload: String,
        moduleSizeDots: Int,
        errorCorrection: Int
    ) -> Data? {
        guard !payload.isEmpty, payload.utf16.count <= ThermalBarcode.qrNativeMaxBytes,
              payload.unicodeScalars.allSatisfy({
                  Int($0.value) >= ThermalBarcode.printableASCIIMin
                      && Int($0.value) <= ThermalBarcode.printableASCIIMax
              }),
              ThermalBarcode.qrNativeModuleSizeDotsRange.contains(moduleSizeDots),
              ThermalBarcode.qrNativeErrorCorrectionRange.contains(errorCorrection)
        else { return nil }
        let bytes = Array(payload.utf8)
        // `pL pH` contam os três bytes de cabeçalho da função (`31 50 30`) junto com o dado.
        let storeLength = bytes.count + qrStoreHeaderSize
        var command = Data([esc, align, centerAlignment])
        // Função 167: tamanho do módulo.
        command.append(qrSelect(length: 3))
        command.append(contentsOf: [qrFunctionModuleSize, UInt8(moduleSizeDots)])
        // Função 169: nível de correção, `48 + nível`, com o nível contado de zero.
        command.append(qrSelect(length: 3))
        command.append(contentsOf: [
            qrFunctionErrorCorrection, UInt8(qrErrorCorrectionBase + errorCorrection - 1),
        ])
        // Função 180: armazenar os dados no símbolo.
        command.append(qrSelect(length: storeLength))
        command.append(contentsOf: [qrFunctionStore, qrFunctionStoreSuffix])
        command.append(contentsOf: bytes)
        // Função 181: imprimir o que foi armazenado.
        command.append(qrSelect(length: 3))
        command.append(contentsOf: [qrFunctionPrint, qrFunctionPrintSuffix])
        command.append(contentsOf: [esc, align, leftAlignment])
        return command
    }

    /**
     Quantos módulos tem o lado do QR deste payload, **sem** zona de silêncio.

     É o que permite "codificar para medir": nem o `GS ( k` nem o `GS v 0` recebem largura em
     pontos, e sem a contagem o tamanho de módulo seria chute. Devolve `nil` quando o payload não
     cabe em símbolo nenhum.

     Consulta o **mesmo** gerador que ``qrRaster(payload:widthDots:verticalRasterScale:)`` usa, e
     não uma tabela paralela: duas contas do mesmo número são o jeito de uma delas envelhecer
     sozinha. Por isso não há parâmetro de correção aqui — o `CIFilter` deste lado está fixo em Q, e
     inventar um parâmetro que o gerador ignora seria prometer o que não se cumpre. Consequência que
     vale registrar: **este número diverge do Android**, que consulta o ZXing no nível pedido. É a
     mesma dívida de QR que o kit já carrega, e a paridade das duas plataformas cobre as barras, não
     o QR.

     A extensão devolvida pelo `CIFilter` já vem com um módulo de margem de cada lado; os dois
     descontados aqui são essa margem, para o número sair no mesmo vocabulário do Android — lado do
     símbolo, sem zona de silêncio.
     */
    public static func qrModuleSide(payload: String) -> Int? {
        guard !payload.isEmpty, payload.utf16.count <= ThermalBarcode.qrNativeMaxBytes,
              payload.unicodeScalars.allSatisfy({
                  Int($0.value) >= ThermalBarcode.printableASCIIMin
                      && Int($0.value) <= ThermalBarcode.printableASCIIMax
              })
        else { return nil }
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(payload.utf8)
        filter.correctionLevel = qrCorrectionLevel
        guard let output = filter.outputImage else { return nil }
        let side = Int(output.extent.width) - 2 * qrGeneratorBorderModules
        return side > 0 ? side : nil
    }

    /// Cabeçalho `GS ( k pL pH 31` comum às quatro funções de QR.
    private static func qrSelect(length: Int) -> Data {
        Data([gs, qrSelectGroup, qrSelectKind, UInt8(length & 0xff), UInt8(length >> 8 & 0xff), qrSymbolGroup])
    }

    /// Amostra o QR gerado pelo CoreImage na grade de pontos da impressora.
    private static func qrModules(payload: String, widthDots: Int) -> [Bool]? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(payload.utf8)
        filter.correctionLevel = qrCorrectionLevel
        guard let output = filter.outputImage else { return nil }
        let extent = output.extent
        guard extent.width > 0, extent.height > 0 else { return nil }
        #if os(macOS)
        // `swift test` não tem uma superfície Metal garantida. O raster de produção no iOS segue
        // exatamente pelo contexto padrão; no host lógico usamos o renderer de software para
        // conferir os mesmos módulos sem depender de GPU.
        let context = CIContext(options: [.useSoftwareRenderer: true])
        #else
        let context = CIContext()
        #endif
        guard let raster = context.createCGImage(output, from: extent) else { return nil }
        let side = Int(extent.width)
        var source = [UInt8](repeating: 0, count: side * side)
        guard let gray = CGColorSpace(name: CGColorSpace.linearGray),
              let bitmap = CGContext(
                  data: &source,
                  width: side,
                  height: side,
                  bitsPerComponent: 8,
                  bytesPerRow: side,
                  space: gray,
                  bitmapInfo: CGImageAlphaInfo.none.rawValue
              )
        else { return nil }
        bitmap.draw(raster, in: CGRect(x: 0, y: 0, width: side, height: side))
        var modules = [Bool](repeating: false, count: widthDots * widthDots)
        for y in 0..<widthDots {
            for x in 0..<widthDots {
                let sourceX = min(side - 1, x * side / widthDots)
                let sourceY = min(side - 1, y * side / widthDots)
                modules[y * widthDots + x] = source[sourceY * side + sourceX] < 128
            }
        }
        return modules
    }

    /**
     Converte o texto para os bytes da página de código.

     Normaliza em NFC (composto) porque a tabela mapeia `é`, não `e` + acento combinante. O que a
     página não representa cai no dobramento antigo para ASCII — assim um caractere inesperado vira
     `?` em vez de sair como byte aleatório, mas "ção" continua saindo "ção".

     No modelo ASCII tudo cai no dobramento e a saída fica dentro do ASCII imprimível. No modelo
     UTF-8, a normalização e a limpeza de controles acontecem antes da codificação Unicode.
     */
    private static func encode(
        _ value: String,
        textEncoding: ThermalTextEncoding,
        codePage: ThermalCodePage?
    ) -> Data {
        if textEncoding == .utf8 {
            var data = Data()
            for scalar in value.precomposedStringWithCanonicalMapping.unicodeScalars {
                if scalar == "\n" {
                    data.append(0x0a)
                } else if scalar == "\r" {
                    continue
                } else if scalar.properties.generalCategory == .control {
                    data.append(UInt8(ascii: scalar.properties.isWhitespace ? " " : "?"))
                } else {
                    data.append(contentsOf: String(scalar).utf8)
                }
            }
            return data
        }
        var data = Data()
        for scalar in value.precomposedStringWithCanonicalMapping.unicodeScalars {
            switch scalar {
            case "\n":
                data.append(0x0a)
            case "\r":
                continue
            case "\u{2013}", "\u{2014}", "\u{2212}":
                data.append(UInt8(ascii: "-"))
            default:
                if isPrintableASCII(scalar) {
                    data.append(UInt8(scalar.value))
                } else if let mapped = codePage?.encode(scalar) {
                    data.append(mapped)
                } else {
                    asciiFold(scalar, into: &data)
                }
            }
        }
        return data
    }

    /// Rede de segurança: derruba o acento e, se nem isso resolver, vira `?`.
    private static func asciiFold(_ scalar: Unicode.Scalar, into data: inout Data) {
        var wrote = false
        for part in String(scalar).decomposedStringWithCanonicalMapping.unicodeScalars {
            if isPrintableASCII(part) {
                data.append(UInt8(part.value))
                wrote = true
            } else if part.properties.generalCategory == .nonspacingMark {
                continue
            } else if part.properties.isWhitespace {
                data.append(UInt8(ascii: " "))
                wrote = true
            }
        }
        if !wrote { data.append(UInt8(ascii: "?")) }
    }

    private static func isPrintableASCII(_ scalar: Unicode.Scalar) -> Bool {
        scalar.value >= UInt32(printableASCIIMin) && scalar.value <= UInt32(printableASCIIMax)
    }

    private static let esc: UInt8 = 0x1b
    private static let gs: UInt8 = 0x1d
    private static let initializePrinter: UInt8 = 0x40
    private static let transmitPrinterID: UInt8 = 0x49
    private static let drawerPulse: UInt8 = 0x70
    private static let drawerPin2 = 2
    private static let drawerPin5 = 5
    private static let drawerOutput1: UInt8 = 0
    private static let drawerOutput2: UInt8 = 1
    private static let byteRange = 0...255
    private static let align: UInt8 = 0x61

    /// `ESC t n` — escolhe a página de código do texto.
    private static let selectCodePage: UInt8 = 0x74

    private static let boldMode: UInt8 = 0x45
    private static let textSize: UInt8 = 0x21
    private static let feed: UInt8 = 0x64
    private static let lineFeed: UInt8 = 0x0a
    private static let cutPaper: UInt8 = 0x56
    private static let fullCut: UInt8 = 0x00
    private static let minQRWidthDots = 64
    private static let maxQRWidthDots = 576
    private static let maxQRBytes = 512
    private static let printableASCIIMin: UInt8 = 0x20
    private static let printableASCIIMax: UInt8 = 0x7e

    private static let centerAlignment: UInt8 = 1

    /// `ESC a 0` — a esquerda, que é o estado em que `ESC @` deixa a impressora.
    private static let leftAlignment: UInt8 = 0

    /// `GS h n` — altura da barra em pontos.
    private static let barcodeHeight: UInt8 = 0x68

    /// `GS w n` — largura do módulo em pontos.
    private static let barcodeModuleWidth: UInt8 = 0x77

    /// `GS H n` — onde sai a legenda: 0 em lugar nenhum, 2 abaixo das barras.
    private static let barcodeHRIPosition: UInt8 = 0x48
    private static let hriNone: UInt8 = 0
    private static let hriBelow: UInt8 = 2

    /// `GS f n` — fonte da legenda; 0 é a fonte A.
    private static let barcodeHRIFont: UInt8 = 0x66
    private static let hriFontA: UInt8 = 0

    /// `GS k m n d1…dn` — a função B, com contagem explícita.
    private static let barcodePrint: UInt8 = 0x6b

    /// `GS ( k` — o grupo de comandos de símbolo bidimensional.
    private static let qrSelectGroup: UInt8 = 0x28
    private static let qrSelectKind: UInt8 = 0x6b

    /// `cn = 49`: dentro do grupo, a família do QR Code.
    private static let qrSymbolGroup: UInt8 = 0x31

    /// Função 167 (`43`): tamanho do módulo em pontos.
    private static let qrFunctionModuleSize: UInt8 = 0x43

    /// Função 169 (`45`): nível de correção de erro.
    private static let qrFunctionErrorCorrection: UInt8 = 0x45

    /// Função 180 (`50 30`): armazena o dado na área de símbolo.
    private static let qrFunctionStore: UInt8 = 0x50
    private static let qrFunctionStoreSuffix: UInt8 = 0x30

    /// Função 181 (`51 30`): imprime o que foi armazenado.
    private static let qrFunctionPrint: UInt8 = 0x51
    private static let qrFunctionPrintSuffix: UInt8 = 0x30

    /// Nível L é `48`, e o pedido do kit conta de um.
    private static let qrErrorCorrectionBase = 48

    /// `cn`, `fn` e o sufixo `30` entram na contagem de `pL pH` junto com o dado.
    private static let qrStoreHeaderSize = 3

    /// Margem que o `CIQRCodeGenerator` acrescenta sozinho, em módulos, de cada lado.
    private static let qrGeneratorBorderModules = 1
}

/**
 Uma linha de pontos repetida por toda a altura.

 Código de barras 1D é uma linha extrudada: a linha é montada uma vez e sai igual em toda faixa. Um
 `OneBitRasterMatrix` também serviria, mas guardaria largura × altura booleanos — 576 × 255 para um
 código de altura cheia — para repetir sempre os mesmos poucos. Espelha a fonte anônima do Android,
 que empacota a mesma linha uma vez e a copia em cada faixa.
 */
private struct ExtrudedRowRasterSource: OneBitRasterSource {
    var widthDots: Int { row.count }
    let heightDots: Int

    private var row: [Bool]

    init(row: [Bool], heightDots: Int) {
        self.row = row
        self.heightDots = heightDots
    }

    mutating func blackPixels(startY: Int, height: Int) -> [Bool]? {
        guard startY >= 0, height > 0, startY + height <= heightDots else { return nil }
        var output = [Bool](repeating: false, count: row.count * height)
        for line in 0..<height {
            let offset = line * row.count
            for x in 0..<row.count { output[offset + x] = row[x] }
        }
        return output
    }

    mutating func clearScratch() {
        row.withUnsafeMutableBufferPointer { $0.initialize(repeating: false) }
    }
}
