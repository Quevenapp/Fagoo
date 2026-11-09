import Foundation

/**
 Quem desenha o código: o app, em pontos, ou a firmware, por comando.

 Não é capacidade: é preferência de quem usa, como o modo de corte. O padrão é ``rasterized``
 porque é o que já está homologado em papel — e porque firmware que não entende o comando imprime
 o payload como texto legível, o que num QR protegido seria vazar a assinatura.

 Os `rawValue` são iguais aos nomes do enum Android de propósito: é por eles que o store de
 preferência do app grava, e um teste de paridade fixa os dois conjuntos.
 */
public enum ThermalCodeEmission: String, Codable, CaseIterable, Sendable {
    case rasterized = "RASTERIZED"
    case native = "NATIVE"

    /// O padrão publicado, e o que sai quando ninguém pede outro.
    public static let `default` = ThermalCodeEmission.rasterized
}

/**
 As simbologias 1D que o kit sabe desenhar e sabe pedir.

 ``nativeSelector`` é o `m` da função B do `GS k` (`GS k m n d1…dn`), a forma com contagem
 explícita: a função A termina em `NUL` e não sabe dizer que o dado tinha um zero dentro.

 As nove nascem juntas de propósito. `switch` sobre enum é exaustivo, então acrescentar um caso
 depois quebraria fonte em todo consumidor — e um interpretador de `GS k` do outro lado do balcão
 recebe `m=65` a `m=72` sem ter escolhido, porque quem manda é o PDV alheio. O custo marginal de já
 nascer com as nove é tabela, não caminho de execução.

 **A lista é exatamente a que o `GS k` endereça**, e os ``nativeSelector`` são os mesmos que o
 interpretador ESC/POS já mapeia. Divergir criaria duas verdades sobre o mesmo comando.

 A ordem das três primeiras não muda: elas vieram antes, e reordenar mexeria em `allCases` de quem
 já persiste o `rawValue`.
 */
public enum ThermalBarcodeSymbology: String, Codable, CaseIterable, Sendable {
    case code128 = "CODE_128"
    case ean13 = "EAN_13"
    case itf = "ITF"
    case ean8 = "EAN_8"
    case upcA = "UPC_A"
    case upcE = "UPC_E"
    case code39 = "CODE_39"
    case codabar = "CODABAR"
    case code93 = "CODE_93"

    /// O `m` da função B do `GS k`.
    public var nativeSelector: Int {
        switch self {
        case .code128: return 73
        case .ean13: return 67
        case .itf: return 70
        case .ean8: return 68
        case .upcA: return 65
        case .upcE: return 66
        case .code39: return 69
        case .codabar: return 71
        case .code93: return 72
        }
    }

    /// Módulos claros exigidos à esquerda, pela norma de cada uma.
    public var quietZoneModulesStart: Int {
        switch self {
        case .code128: return 10
        case .ean13: return 11
        case .itf: return 10
        case .ean8: return 7
        case .upcA: return 9
        case .upcE: return 9
        case .code39: return 10
        case .codabar: return 10
        case .code93: return 10
        }
    }

    /// Módulos claros exigidos à direita, pela norma de cada uma.
    public var quietZoneModulesEnd: Int {
        switch self {
        case .code128: return 10
        case .ean13: return 7
        case .itf: return 10
        case .ean8: return 7
        case .upcA: return 9
        case .upcE: return 7
        case .code39: return 10
        case .codabar: return 10
        case .code93: return 10
        }
    }
}

/**
 Por que este conteúdo não vira código de barras, com a frase que a pessoa lê.

 A frase mora no kit, e não no app, porque a regra também mora aqui: dígito verificador, paridade
 de comprimento e alfabeto são do símbolo, não da tela. App que escrevesse a própria frase
 escreveria a própria regra junto, e as duas envelheceriam separadas.
 */
public enum ThermalBarcodeRejection: Equatable, Sendable {
    case empty
    case tooLong(max: Int)
    case nonASCII
    case nonDigit
    case wrongLength(expected: String)
    case badCheckDigit

    /**
     O alfabeto não é "ASCII imprimível" e a frase precisa dizer qual é.

     Code 39, Code 93 e Codabar têm cada um a sua lista fechada, e minúscula não entra em nenhum dos
     dois primeiros. Uma frase genérica mandaria a pessoa adivinhar o que apagar.
     */
    case unsupportedContent(allowed: String)

    /**
     O número existe, mas não tem forma UPC-E.

     Duas entradas caem aqui: um UPC-A cujos zeros não estão onde a compressão exige, e um
     seis-dígitos **não canônico** — aquele que a compressão do próprio UPC-A expandido devolveria
     diferente. O segundo caso é sutil e é o que protege o contrato desta frente: a firmware que
     recebe `GS k m=66` comprime por conta dela, e desenhar o não canônico faria o raster e o nativo
     saírem com símbolos diferentes para o mesmo pedido.
     */
    case notCompressible

    /**
     Só quem conhece a largura do papel produz esta recusa.

     O emissor cru devolve `nil`; quem tem `printableDots` — o layout — é que sabe dizer que a
     largura é o problema, e é ele que traduz o `nil` nesta frase.
     */
    case doesNotFit

    public var message: String {
        switch self {
        case .empty:
            return "Digite o conteúdo do código."
        case .tooLong(let max):
            return "O código aceita no máximo \(max) caracteres."
        case .nonASCII:
            return "O código aceita apenas letras e números sem acento."
        case .nonDigit:
            return "Este código aceita apenas dígitos."
        case .wrongLength(let expected):
            return "Este código precisa de \(expected)."
        case .badCheckDigit:
            return "O dígito verificador não confere."
        case .unsupportedContent(let allowed):
            return "Este código aceita apenas \(allowed)."
        case .notCompressible:
            return "Este número não tem forma UPC-E."
        case .doesNotFit:
            return "O código não cabe na largura desta impressora."
        }
    }
}

/// Aceito com o conteúdo já normalizado, ou recusado com o motivo.
public enum ThermalBarcodeValidation: Equatable, Sendable {
    /**
     O associado é o que vai virar módulo.

     Em ``ThermalBarcodeSymbology/ean13`` com doze dígitos, é o conteúdo com o verificador
     calculado: o símbolo desenhado e o `GS k` enviado carregam os mesmos treze dígitos, e a
     legenda do HRI também.
     */
    case accepted(normalized: String)
    case rejected(reason: ThermalBarcodeRejection)

    /// Atalho para quem só quer o conteúdo normalizado.
    public var normalized: String? {
        if case .accepted(let value) = self { return value }
        return nil
    }

    /// Atalho para quem só quer a frase.
    public var rejection: ThermalBarcodeRejection? {
        if case .rejected(let reason) = self { return reason }
        return nil
    }
}

/**
 A régua de módulos do kit: valida, codifica e conta.

 **Por que é nossa, e não de uma biblioteca.** O modo nativo do Code 128 precisa da *mesma* decisão
 de conjunto A/B/C que o raster: no `GS k m=73` o conjunto é escolhido pelo nosso payload, com os
 escapes `{A {B {C`. Se o raster usasse a heurística de uma biblioteca e o nativo a nossa, o mesmo
 texto sairia com dois símbolos diferentes conforme o ajuste, e a promessa de "muda só quem desenha
 os módulos" cairia. Além disso, a largura física só se conhece contando módulos, e a contagem é
 necessária nos dois modos.

 **Aritmética inteira, de ponta a ponta**, para o Android e o iOS emitirem os mesmos módulos e os
 mesmos bytes — a mesma razão da reamostragem vertical por repetição de linha. Este arquivo é o
 espelho literal de `ThermalBarcode.kt`; quem mexer numa tabela mexe nas duas, e a suíte de
 paridade das duas plataformas existe para gritar quando isso não acontecer.
 */
public enum ThermalBarcode {
    /**
     Faixa da largura de módulo em pontos.

     É o que o `GS w n` aceita na forma padrão; abaixo de 2 pontos nenhuma cabeça de 8 dots/mm
     desenha barra fina confiável — 1 ponto seriam 0,125 mm.
     */
    public static let moduleWidthDotsRange = 2...6

    /// `GS h n` é um byte; 24 pontos são 3 mm, o piso do que um leitor aceita.
    public static let heightDotsRange = 24...255

    /// 10 mm a 8 dots/mm.
    public static let defaultHeightDots = 80

    /// O mesmo teto que o esquema de browser já publica: 128 bytes ASCII por Code 128.
    public static let code128LengthRange = 1...128

    /// Doze dígitos e o kit calcula o verificador; treze e o kit **confere** o verificador.
    public static let ean13LengthRange = 12...13

    /// ITF codifica aos pares; comprimento ímpar é dado errado, não dado a completar com zero.
    public static let itfLengthRange = 2...64

    /// Sete dígitos e o kit calcula o verificador; oito e o kit **confere** o verificador.
    public static let ean8LengthRange = 7...8

    /**
     Onze dígitos e o kit calcula o verificador; doze e o kit **confere**.

     **UPC-A não é EAN-13 encurtado.** São doze dígitos, e o EAN-13 equivalente é `"0"` mais os doze
     — o zero à frente é que empurra os pesos `1,3,…` uma casa e faz o verificador do UPC-A, de
     pesos `3,1,…`, dar o mesmo dígito. Tratar os doze como corpo de EAN-13 daria outro verificador
     e outro símbolo.
     */
    public static let upcALengthRange = 11...12

    /**
     A forma comprimida do UPC-E: seis dígitos, ou o sistema numérico e seis, ou os oito com o
     verificador.
     */
    public static let upcELengthRange = 6...8

    /**
     A forma UPC-A do UPC-E, que é a que o `GS k m=66` recebe.

     O comando nativo não leva o símbolo comprimido: a especificação do `GS k` pede o UPC-A de onze
     ou doze dígitos e deixa a compressão para a firmware. Aceitar as duas formas aqui é o que faz o
     mesmo pedido chegar igual pelos dois caminhos.
     */
    public static let upcEExpandedLengthRange = 11...12

    /// O mesmo teto de 64 do ITF, e pelo mesmo motivo: a largura é que recusa antes, não o texto.
    public static let code39LengthRange = 1...64

    /// Três é o mínimo real: marca de início, ao menos um dado e marca de fim.
    public static let codabarLengthRange = 3...64

    /// O mesmo teto de 64; os dois verificadores do Code 93 não contam como conteúdo.
    public static let code93LengthRange = 1...64

    /// O alfabeto do Code 39 e do Code 93, na ordem em que vale como valor de verificador.
    public static let code39Alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-. $/+%"

    /// O Code 93 usa a mesma lista de 43, e a ordem **é** o valor no módulo 47.
    public static let code93Alphabet = code39Alphabet

    /// O miolo do Codabar. As marcas de início e fim são ``codabarDelimiters``.
    public static let codabarDataAlphabet = "0123456789-$:/.+"

    /// Início e fim do Codabar. Fazem parte do dado, e por isso viajam no `GS k` também.
    public static let codabarDelimiters = "ABCD"

    /**
     Largura imprimível aceita, igual à do caminho de imagem: 640 pontos é a maior geometria
     homologável (papel de 80 mm), e o `GS v 0` empacota byte a byte.
     */
    public static let printableDotsRange = 8...640

    /// `GS ( k` função 167 aceita 1 a 16 pontos por módulo.
    public static let qrNativeModuleSizeDotsRange = 1...16

    /// Os mesmos códigos de pedido do Android: 1=L, 2=M, 3=Q, 4=H.
    public static let qrNativeErrorCorrectionRange = 1...4

    /**
     Teto do payload do QR nativo.

     É o menor dos dois tetos de raster que o kit já publica (o iOS recusa acima de 512 bytes), e é
     ele de propósito: o modo nativo cai para o raster quando a capacidade medida não existe, e um
     payload que só o nativo aceitasse falharia exatamente na hora em que a queda acontece.
     */
    public static let qrNativeMaxBytes = 512

    /// Zona de silêncio do QR, em módulos, igual à que o `qrRaster` já usa.
    public static let qrQuietZoneModules = 4

    /// `GS k m n d1…dn`: `n` é um byte, então o dado nativo não passa de 255 bytes.
    public static let maxNativeDataBytes = 255

    /// Alfabeto aceito pelo Code 128 neste kit, o mesmo do `qrRaster`.
    public static let printableASCIIMin = 0x20
    public static let printableASCIIMax = 0x7e

    /**
     Valida e normaliza sem desenhar nada.

     Existe separada de ``modules(_:symbology:)`` porque a tela precisa recusar **enquanto** a
     pessoa digita, e porque quem oferece o campo tem de poder mostrar a frase antes de qualquer
     byte existir.
     */
    public static func validate(
        _ value: String,
        symbology: ThermalBarcodeSymbology
    ) -> ThermalBarcodeValidation {
        if value.isEmpty { return .rejected(reason: .empty) }
        switch symbology {
        case .code128: return validateCode128(value)
        case .ean13: return validateEAN13(value)
        case .itf: return validateITF(value)
        case .ean8: return validateEAN8(value)
        case .upcA: return validateUPCA(value)
        case .upcE: return validateUPCE(value)
        case .code39: return validateCode39(value)
        case .codabar: return validateCodabar(value)
        case .code93: return validateCode93(value)
        }
    }

    /**
     Os módulos do símbolo, **sem** zona de silêncio: `true` é barra, `false` é espaço.

     A zona de silêncio é somada por quem posiciona — uma vez só, pela mesma fórmula, nos dois
     modos —, e é por isso que ela não está aqui: quem interpreta `GS k` alheio precisa dos módulos
     do símbolo, não da margem que o nosso layout escolheu.
     */
    public static func modules(
        _ value: String,
        symbology: ThermalBarcodeSymbology
    ) -> [Bool]? {
        guard let normalized = validate(value, symbology: symbology).normalized else { return nil }
        switch symbology {
        case .code128: return code128Modules(normalized)
        case .ean13: return ean13Modules(normalized)
        case .itf: return itfModules(normalized)
        case .ean8: return ean8Modules(normalized)
        // O UPC-A é desenhado pelo EAN-13 de "0" mais os doze: a paridade toda ímpar do primeiro
        // dígito zero é, literalmente, o que faz os dois símbolos coincidirem.
        case .upcA: return ean13Modules("0" + normalized)
        case .upcE: return upcEModules(normalized)
        case .code39: return code39Modules(normalized)
        case .codabar: return codabarModules(normalized)
        case .code93: return code93Modules(normalized)
        }
    }

    /// Quantos módulos tem o símbolo, sem zona de silêncio.
    public static func moduleCount(
        _ value: String,
        symbology: ThermalBarcodeSymbology
    ) -> Int? {
        modules(value, symbology: symbology)?.count
    }

    /// Quantos módulos o símbolo ocupa **com** as duas zonas de silêncio da norma.
    public static func totalModules(
        _ value: String,
        symbology: ThermalBarcodeSymbology
    ) -> Int? {
        guard let count = moduleCount(value, symbology: symbology) else { return nil }
        return symbology.quietZoneModulesStart + count + symbology.quietZoneModulesEnd
    }

    /**
     "Codificar para medir": a largura de módulo que cabe nesta impressora.

     Nem o `GS k` nem o `GS v 0` recebem largura em pontos — recebem tamanho de módulo. Para não
     inventar um número, o kit codifica o símbolo, que ele já precisa codificar, e divide a área
     imprimível pela contagem. Devolve `nil` quando nem o mínimo de ``moduleWidthDotsRange`` cabe; é
     esse `nil` que o layout traduz em ``ThermalBarcodeRejection/doesNotFit``.
     */
    public static func moduleWidthDots(
        _ value: String,
        symbology: ThermalBarcodeSymbology,
        printableDots: Int
    ) -> Int? {
        guard printableDotsRange.contains(printableDots), printableDots % 8 == 0,
              let total = totalModules(value, symbology: symbology)
        else { return nil }
        let width = min(
            moduleWidthDotsRange.upperBound,
            max(moduleWidthDotsRange.lowerBound, printableDots / total)
        )
        return total * width <= printableDots ? width : nil
    }

    /**
     Os bytes de dado do `GS k m n d1…dn` — só `d1…dn`, sem cabeçalho e sem contagem.

     No Code 128 são os escapes `{A {B {C` com as **mesmas** trocas de conjunto que
     ``modules(_:symbology:)`` escolheu, e no conjunto C os dígitos vão como o par em binário, que é
     o que a especificação pede. `{` do próprio conteúdo sai dobrado — e é só por causa dele que um
     conteúdo aceito pelo raster pode ser recusado aqui: 128 chaves viram 258 bytes de dado, e o `n`
     do `GS k` é um byte só.
     */
    public static func nativeData(
        _ value: String,
        symbology: ThermalBarcodeSymbology
    ) -> [UInt8]? {
        guard let normalized = validate(value, symbology: symbology).normalized else { return nil }
        let data: [Int]?
        switch symbology {
        case .code128:
            data = code128Plan(normalized)?.nativeData
        case .upcE:
            // O UPC-E é a exceção: o `GS k m=66` não recebe o símbolo comprimido, recebe o UPC-A de
            // doze dígitos e comprime sozinho. Mandar os oito canônicos seria mandar outro número.
            data = upcEExpand(normalized).unicodeScalars.map { Int($0.value) }
        case .ean13, .itf, .ean8, .upcA, .code39, .codabar, .code93:
            // As demais viajam como os próprios caracteres ASCII, já normalizados. O EAN-13 vai com
            // treze e o EAN-8 com oito, incluindo o verificador que o kit calculou: assim o papel
            // nativo e o papel rasterizado carregam o mesmo número, dígito a dígito. No Codabar as
            // marcas de início e fim vão junto, porque são dado.
            data = normalized.unicodeScalars.map { Int($0.value) }
        }
        guard let data, !data.isEmpty, data.count <= maxNativeDataBytes else { return nil }
        return data.map { UInt8($0 & 0xff) }
    }

    // MARK: - Code 128

    /**
     Os 107 padrões do Code 128, em larguras de elemento, começando sempre por barra.

     Um padrão são seis elementos que somam 11 módulos; o de parada (106) tem sete e soma 13,
     porque termina com a barra dupla que fecha o símbolo. A tabela é a mesma para os conjuntos A, B
     e C — o que muda entre eles é o significado do valor, não o desenho.
     */
    private static let code128Patterns: [String] = [
        "212222", "222122", "222221", "121223", "121322", "131222", "122213", "122312",
        "132212", "221213", "221312", "231212", "112232", "122132", "122231", "113222",
        "123122", "123221", "223211", "221132", "221231", "213212", "223112", "312131",
        "311222", "321122", "321221", "312212", "322112", "322211", "212123", "212321",
        "232121", "111323", "131123", "131321", "112313", "132113", "132311", "211313",
        "231113", "231311", "112133", "112331", "132131", "113123", "113321", "133121",
        "313121", "211331", "231131", "213113", "213311", "213131", "311123", "311321",
        "331121", "312113", "312311", "332111", "314111", "221411", "431111", "111224",
        "111422", "121124", "121421", "141122", "141221", "112214", "112412", "122114",
        "122411", "142112", "142211", "241211", "221114", "413111", "241112", "134111",
        "111242", "121142", "121241", "114212", "124112", "124211", "411212", "421112",
        "421211", "212141", "214121", "412121", "111143", "111341", "131141", "114113",
        "114311", "411113", "411311", "113141", "114131", "311141", "411131", "211412",
        "211214", "211232", "2331112",
    ]

    private static let code128Stop = 106
    private static let code128CheckModulus = 103
    private static let code128Escape = 0x7b

    /**
     Os três conjuntos do Code 128, com o valor que os inicia, o que troca para eles e a letra do
     escape nativo.

     **`a` é declarado e nunca é escolhido pela régua.** O alfabeto aceito aqui é `0x20…0x7e`: o
     conjunto B cobre todo ele, enquanto o A ganha os controles — que este kit não aceita — e perde
     as minúsculas. Trocar para A jamais encurtaria um símbolo, e encurtaria o alfabeto. Fica
     declarado porque quem interpreta `GS k` alheio encontra `{A` vindo de outro PDV, e porque a
     tabela de padrões é a mesma para os três.
     */
    private enum Code128Set {
        case a
        case b
        case c

        var startValue: Int {
            switch self {
            case .a: return 103
            case .b: return 104
            case .c: return 105
            }
        }

        var switchValue: Int {
            switch self {
            case .a: return 101
            case .b: return 100
            case .c: return 99
            }
        }

        var escapeLetter: Int {
            switch self {
            case .a: return 0x41
            case .b: return 0x42
            case .c: return 0x43
            }
        }
    }

    private struct Code128Plan {
        let values: [Int]
        let nativeData: [Int]
    }

    /**
     Escolhe conjunto e valores numa passada só, e monta o dado nativo na mesma passada.

     Os dois têm de sair do mesmo percurso: é literalmente o contrato desta frente que o símbolo
     rasterizado e o símbolo pedido à firmware sejam o mesmo símbolo.
     */
    private static func code128Plan(_ value: String) -> Code128Plan? {
        let characters = Array(value.unicodeScalars).map { Int($0.value) }
        let length = characters.count
        var values: [Int] = []
        var native: [Int] = []
        var index = 0
        let leadingDigits = digitRun(characters, from: 0)
        // Duas casas cabem num valor só do conjunto C, e é o único caso em que começar em C
        // compensa com menos de quatro dígitos. Corrida ímpar começa em B: o primeiro dígito sai em
        // B e o resto, já par, entra em C sem sobra.
        var set: Code128Set =
            (length == 2 && leadingDigits == 2) || (leadingDigits >= 4 && leadingDigits % 2 == 0)
                ? .c
                : .b
        values.append(set.startValue)
        native.append(code128Escape)
        native.append(set.escapeLetter)
        while index < length {
            let run = digitRun(characters, from: index)
            if set == .c {
                if run >= 2 {
                    let pair = (characters[index] - 0x30) * 10 + (characters[index + 1] - 0x30)
                    values.append(pair)
                    native.append(pair)
                    index += 2
                } else {
                    set = .b
                    values.append(set.switchValue)
                    native.append(code128Escape)
                    native.append(set.escapeLetter)
                }
            } else {
                if run >= 4 {
                    if run % 2 == 1 {
                        appendSetB(characters[index], &values, &native)
                        index += 1
                    }
                    set = .c
                    values.append(set.switchValue)
                    native.append(code128Escape)
                    native.append(set.escapeLetter)
                } else {
                    appendSetB(characters[index], &values, &native)
                    index += 1
                }
            }
        }
        var checksum = values[0]
        for (position, item) in values.dropFirst().enumerated() {
            checksum += (position + 1) * item
        }
        values.append(checksum % code128CheckModulus)
        values.append(code128Stop)
        return Code128Plan(values: values, nativeData: native)
    }

    private static func appendSetB(_ code: Int, _ values: inout [Int], _ native: inout [Int]) {
        values.append(code - printableASCIIMin)
        // `{` é o escape do próprio protocolo nativo; dobrado, ele volta a ser conteúdo.
        if code == code128Escape { native.append(code128Escape) }
        native.append(code)
    }

    private static func digitRun(_ characters: [Int], from: Int) -> Int {
        var count = 0
        while from + count < characters.count, (0x30...0x39).contains(characters[from + count]) {
            count += 1
        }
        return count
    }

    private static func code128Modules(_ value: String) -> [Bool]? {
        guard let plan = code128Plan(value) else { return nil }
        var widths: [Int] = []
        for symbol in plan.values {
            for element in code128Patterns[symbol].unicodeScalars {
                widths.append(Int(element.value) - 0x30)
            }
        }
        return modulesFromWidths(widths)
    }

    private static func validateCode128(_ value: String) -> ThermalBarcodeValidation {
        // O comprimento é contado em unidades UTF-16, e não em `Character` nem em escalar, porque
        // é isso que `String.length` conta no Kotlin. Dentro do alfabeto aceito as três contagens
        // coincidem; fora dele, contar igual é o que faz as duas plataformas recusarem o mesmo
        // conteúdo pelo mesmo motivo, e não só recusarem.
        if value.utf16.count > code128LengthRange.upperBound {
            return .rejected(reason: .tooLong(max: code128LengthRange.upperBound))
        }
        let scalars = Array(value.unicodeScalars)
        if scalars.contains(where: {
            Int($0.value) < printableASCIIMin || Int($0.value) > printableASCIIMax
        }) {
            return .rejected(reason: .nonASCII)
        }
        return .accepted(normalized: value)
    }

    // MARK: - EAN-13

    /// Codificação ímpar do grupo da esquerda.
    private static let ean13LeftOdd = [
        "0001101", "0011001", "0010011", "0111101", "0100011",
        "0110001", "0101111", "0111011", "0110111", "0001011",
    ]

    /// Codificação par do grupo da esquerda: é a da direita lida ao contrário.
    private static let ean13LeftEven = [
        "0100111", "0110011", "0011011", "0100001", "0011101",
        "0111001", "0000101", "0010001", "0001001", "0010111",
    ]

    /// Grupo da direita: o complemento do ímpar da esquerda, e o que fecha com barra.
    private static let ean13Right = [
        "1110010", "1100110", "1101100", "1000010", "1011100",
        "1001110", "1010000", "1000100", "1001000", "1110100",
    ]

    /**
     O primeiro dígito não tem barra própria: ele vive na paridade dos seis da esquerda.

     `1` escolhe a codificação par. É por isto que o EAN-13 tem 95 módulos e não 102.
     */
    private static let ean13Parity = [
        "000000", "001011", "001101", "001110", "010011",
        "011001", "011100", "010101", "010110", "011010",
    ]

    private static let ean13Guard = "101"
    private static let ean13Center = "01010"

    private static func validateEAN13(_ value: String) -> ThermalBarcodeValidation {
        let digits = Array(value.unicodeScalars).map { Int($0.value) }
        if digits.contains(where: { !(0x30...0x39).contains($0) }) {
            return .rejected(reason: .nonDigit)
        }
        if !ean13LengthRange.contains(digits.count) {
            return .rejected(reason: .wrongLength(expected: "12 ou 13 dígitos"))
        }
        let body = digits.prefix(ean13LengthRange.lowerBound).map { $0 - 0x30 }
        let check = ean13CheckDigit(body)
        if digits.count == ean13LengthRange.upperBound, digits[digits.count - 1] - 0x30 != check {
            return .rejected(reason: .badCheckDigit)
        }
        return .accepted(normalized: (body + [check]).map { String($0) }.joined())
    }

    /// Pesos 1 e 3 alternados da esquerda para a direita, e o que falta para a dezena.
    private static func ean13CheckDigit(_ body: [Int]) -> Int {
        eanFamilyCheckDigit(body, firstWeight: 1)
    }

    /**
     O verificador módulo 10 de toda a família EAN/UPC.

     A norma conta os pesos **da direita para a esquerda**, sempre 3 na última casa. O que muda de
     uma simbologia para a outra é só onde essa alternância cai na primeira casa: 1 no EAN-13, que
     tem doze dígitos de corpo, e 3 no EAN-8 e no UPC-A, que têm um número ímpar deles. É essa casa
     de diferença — e não uma tabela diferente — que separa os três.
     */
    private static func eanFamilyCheckDigit(_ body: [Int], firstWeight: Int) -> Int {
        let secondWeight = 4 - firstWeight
        var sum = 0
        for (position, digit) in body.enumerated() {
            sum += digit * (position % 2 == 0 ? firstWeight : secondWeight)
        }
        return (10 - sum % 10) % 10
    }

    private static func ean13Modules(_ value: String) -> [Bool] {
        let digits = Array(value.unicodeScalars).map { Int($0.value) - 0x30 }
        var bits = ean13Guard
        let parity = Array(ean13Parity[digits[0]])
        for position in 0..<6 {
            let digit = digits[position + 1]
            bits += parity[position] == "1" ? ean13LeftEven[digit] : ean13LeftOdd[digit]
        }
        bits += ean13Center
        for position in 0..<6 { bits += ean13Right[digits[position + 7]] }
        bits += ean13Guard
        return bits.map { $0 == "1" }
    }

    // MARK: - ITF

    /**
     Cinco elementos por dígito, dois deles largos — é daí que vem "2 de 5".

     Largo vale **três** módulos, e não dois. A norma admite a razão 2:1 só quando o elemento
     estreito passa de 0,51 mm; a 8 dots/mm, um módulo de 2 a 6 pontos dá de 0,25 a 0,75 mm, e a
     faixa que interessa está quase toda abaixo do limite. Três módulos é a razão que vale sempre.

     **E é aqui que "mesma pegada física nos dois modos" deixa de valer.** O `GS k m=70` não leva a
     razão: quem a escolhe é a firmware, e a que se vê por aí costuma ser 2:1. Com 2:1 o mesmo
     número ocupa `8 + 7n` módulos em vez dos `9 + 9n` daqui, e o código nativo sai mais estreito
     que o rasterizado. O Code 128 e o EAN-13 não têm essa folga — a norma fixa a largura dos dois
     —, então a promessa continua de pé neles. **Ninguém mediu isto em papel**, e a diferença de
     largura do ITF entre os dois modos é pergunta de bancada, não conclusão de teste.
     */
    private static let itfPatterns = [
        [1, 1, 3, 3, 1], [3, 1, 1, 1, 3], [1, 3, 1, 1, 3],
        [3, 3, 1, 1, 1], [1, 1, 3, 1, 3], [3, 1, 3, 1, 1],
        [1, 3, 3, 1, 1], [1, 1, 1, 3, 3], [3, 1, 1, 3, 1],
        [1, 3, 1, 3, 1],
    ]

    private static let itfStart = [1, 1, 1, 1]
    private static let itfStop = [3, 1, 1]

    private static func validateITF(_ value: String) -> ThermalBarcodeValidation {
        let digits = Array(value.unicodeScalars).map { Int($0.value) }
        if digits.contains(where: { !(0x30...0x39).contains($0) }) {
            return .rejected(reason: .nonDigit)
        }
        if !itfLengthRange.contains(digits.count) || digits.count % 2 != 0 {
            return .rejected(
                reason: .wrongLength(
                    expected: "um número par de dígitos, de \(itfLengthRange.lowerBound) a "
                        + "\(itfLengthRange.upperBound)"
                )
            )
        }
        return .accepted(normalized: value)
    }

    /// O primeiro dígito do par vira barra, o segundo vira espaço, um elemento de cada vez.
    private static func itfModules(_ value: String) -> [Bool] {
        let digits = Array(value.unicodeScalars).map { Int($0.value) - 0x30 }
        var widths = itfStart
        var index = 0
        while index < digits.count {
            let bars = itfPatterns[digits[index]]
            let spaces = itfPatterns[digits[index + 1]]
            for element in 0..<5 {
                widths.append(bars[element])
                widths.append(spaces[element])
            }
            index += 2
        }
        widths += itfStop
        return modulesFromWidths(widths)
    }

    // MARK: - EAN-8

    private static func validateEAN8(_ value: String) -> ThermalBarcodeValidation {
        let digits = Array(value.unicodeScalars).map { Int($0.value) }
        if digits.contains(where: { !(0x30...0x39).contains($0) }) {
            return .rejected(reason: .nonDigit)
        }
        if !ean8LengthRange.contains(digits.count) {
            return .rejected(reason: .wrongLength(expected: "7 ou 8 dígitos"))
        }
        let body = digits.prefix(ean8LengthRange.lowerBound).map { $0 - 0x30 }
        let check = eanFamilyCheckDigit(body, firstWeight: 3)
        if digits.count == ean8LengthRange.upperBound, digits[digits.count - 1] - 0x30 != check {
            return .rejected(reason: .badCheckDigit)
        }
        return .accepted(normalized: (body + [check]).map { String($0) }.joined())
    }

    /**
     Quatro dígitos de cada lado, e **nenhuma paridade a escolher**.

     O EAN-13 esconde o primeiro dígito na paridade dos seis da esquerda; o EAN-8 não tem dígito
     escondido, então o grupo da esquerda sai todo na codificação ímpar. São 67 módulos: guarda,
     quatro dígitos, centro, quatro dígitos, guarda.
     */
    private static func ean8Modules(_ value: String) -> [Bool] {
        let digits = Array(value.unicodeScalars).map { Int($0.value) - 0x30 }
        var bits = ean13Guard
        for position in 0..<4 { bits += ean13LeftOdd[digits[position]] }
        bits += ean13Center
        for position in 0..<4 { bits += ean13Right[digits[position + 4]] }
        bits += ean13Guard
        return bits.map { $0 == "1" }
    }

    // MARK: - UPC-A

    private static func validateUPCA(_ value: String) -> ThermalBarcodeValidation {
        let digits = Array(value.unicodeScalars).map { Int($0.value) }
        if digits.contains(where: { !(0x30...0x39).contains($0) }) {
            return .rejected(reason: .nonDigit)
        }
        if !upcALengthRange.contains(digits.count) {
            return .rejected(reason: .wrongLength(expected: "11 ou 12 dígitos"))
        }
        let body = digits.prefix(upcALengthRange.lowerBound).map { $0 - 0x30 }
        let check = eanFamilyCheckDigit(body, firstWeight: 3)
        if digits.count == upcALengthRange.upperBound, digits[digits.count - 1] - 0x30 != check {
            return .rejected(reason: .badCheckDigit)
        }
        return .accepted(normalized: (body + [check]).map { String($0) }.joined())
    }

    // MARK: - UPC-E

    /// O UPC-E só existe nos sistemas numéricos 0 e 1.
    private static let upcENumberSystems = [0, 1]

    /**
     A paridade dos seis dígitos, escolhida pelo **verificador** — e não pelo primeiro dígito, como
     no EAN-13.

     `1` é a codificação par. A tabela vale para o sistema numérico 0; no 1 ela inverte inteira, e
     essa inversão é a única diferença entre os dois. É por isso que um leitor recupera o
     verificador só de olhar a paridade: ele não está desenhado em lugar nenhum.
     */
    private static let upcEParity = [
        "111000", "110100", "110010", "110001", "101100",
        "100110", "100011", "101010", "101001", "100101",
    ]

    /// Seis módulos no fim, e não a guarda de três: é como o leitor sabe que o símbolo é UPC-E.
    private static let upcEEndGuard = "010101"

    private static func validateUPCE(_ value: String) -> ThermalBarcodeValidation {
        let scalars = Array(value.unicodeScalars).map { Int($0.value) }
        if scalars.contains(where: { !(0x30...0x39).contains($0) }) {
            return .rejected(reason: .nonDigit)
        }
        let digits = scalars.map { $0 - 0x30 }
        let numberSystem: Int
        let compressed: [Int]
        if upcELengthRange.contains(digits.count) {
            // Seis dígitos assumem o sistema numérico 0, que é o do varejo.
            numberSystem = digits.count == upcELengthRange.lowerBound ? 0 : digits[0]
            compressed = digits.count == upcELengthRange.lowerBound
                ? digits
                : Array(digits[1..<7])
            if !upcENumberSystems.contains(numberSystem) {
                return .rejected(reason: .notCompressible)
            }
        } else if upcEExpandedLengthRange.contains(digits.count) {
            let body = Array(digits.prefix(upcEExpandedLengthRange.lowerBound))
            if digits.count == upcEExpandedLengthRange.upperBound,
               digits[digits.count - 1] != eanFamilyCheckDigit(body, firstWeight: 3) {
                return .rejected(reason: .badCheckDigit)
            }
            numberSystem = body[0]
            guard let six = upcECompress(body) else {
                return .rejected(reason: .notCompressible)
            }
            compressed = six
        } else {
            return .rejected(
                reason: .wrongLength(
                    expected: "6, 7 ou 8 dígitos, ou 11 ou 12 dígitos na forma UPC-A"
                )
            )
        }
        // O verificador do UPC-E é o do UPC-A expandido: não existe conta própria.
        let expanded = upcEExpandBody(numberSystem: numberSystem, compressed: compressed)
        let check = eanFamilyCheckDigit(expanded, firstWeight: 3)
        if digits.count == upcELengthRange.upperBound, digits[digits.count - 1] != check {
            return .rejected(reason: .badCheckDigit)
        }
        // **Canonicidade.** A expansão não é injetora: `000003` e `000000` expandem para o mesmo
        // UPC-A, e a compressão devolve sempre o segundo. Se o kit desenhasse o primeiro, a
        // firmware que recebe o `GS k m=66` — que leva o UPC-A — desenharia o segundo, e o mesmo
        // pedido sairia com dois símbolos conforme o modo. São 180.000 dos 2.000.000 de
        // seis-dígitos, todos com zeros à frente, e todos recusados aqui.
        if upcECompress(expanded) != compressed {
            return .rejected(reason: .notCompressible)
        }
        return .accepted(
            normalized: ([numberSystem] + compressed + [check]).map { String($0) }.joined()
        )
    }

    /**
     Onde os quatro ou cinco zeros suprimidos voltam, decidido pelo **último** dos seis dígitos.

     Devolve os onze dígitos do corpo, sem verificador.
     */
    private static func upcEExpandBody(numberSystem: Int, compressed x: [Int]) -> [Int] {
        switch x[5] {
        case 0, 1, 2:
            return [numberSystem, x[0], x[1], x[5], 0, 0, 0, 0, x[2], x[3], x[4]]
        case 3:
            return [numberSystem, x[0], x[1], x[2], 0, 0, 0, 0, 0, x[3], x[4]]
        case 4:
            return [numberSystem, x[0], x[1], x[2], x[3], 0, 0, 0, 0, 0, x[4]]
        default:
            return [numberSystem, x[0], x[1], x[2], x[3], x[4], 0, 0, 0, 0, x[5]]
        }
    }

    /// Do canônico de oito para os doze dígitos que o `GS k m=66` recebe.
    private static func upcEExpand(_ normalized: String) -> String {
        let digits = Array(normalized.unicodeScalars).map { Int($0.value) - 0x30 }
        let body = upcEExpandBody(numberSystem: digits[0], compressed: Array(digits[1..<7]))
        return (body + [digits[7]]).map { String($0) }.joined()
    }

    /**
     A inversa: os onze dígitos do UPC-A viram os seis do UPC-E, ou `nil` quando não há forma.

     A ordem das quatro regras **é** a definição — a primeira que casa é a que vale, e é por isso que
     a segunda exige `p[2]` fora de 0...2 e a terceira exige `p[3]` diferente de zero: sem essas
     guardas duas regras casariam no mesmo número e a compressão deixaria de ser função.
     */
    private static func upcECompress(_ body: [Int]) -> [Int]? {
        guard upcENumberSystems.contains(body[0]) else { return nil }
        let p = Array(body[1...])
        if Array(p[3...6]) == [0, 0, 0, 0], (0...2).contains(p[2]) {
            return [p[0], p[1], p[7], p[8], p[9], p[2]]
        }
        if Array(p[3...7]) == [0, 0, 0, 0, 0], (3...9).contains(p[2]) {
            return [p[0], p[1], p[2], p[8], p[9], 3]
        }
        if Array(p[4...8]) == [0, 0, 0, 0, 0], p[3] != 0 {
            return [p[0], p[1], p[2], p[3], p[9], 4]
        }
        if Array(p[5...8]) == [0, 0, 0, 0], (5...9).contains(p[9]) {
            return [p[0], p[1], p[2], p[3], p[4], p[9]]
        }
        return nil
    }

    /// Guarda, seis dígitos com a paridade do verificador, e a guarda de fim de seis módulos.
    private static func upcEModules(_ value: String) -> [Bool] {
        let digits = Array(value.unicodeScalars).map { Int($0.value) - 0x30 }
        let base = Array(upcEParity[digits[7]])
        let parity = digits[0] == 1 ? base.map { $0 == "1" ? Character("0") : Character("1") } : base
        var bits = ean13Guard
        for position in 0..<6 {
            let digit = digits[position + 1]
            bits += parity[position] == "1" ? ean13LeftEven[digit] : ean13LeftOdd[digit]
        }
        bits += upcEEndGuard
        return bits.map { $0 == "1" }
    }

    // MARK: - Code 39

    /**
     Nove elementos por caractere, três deles largos — cinco barras e quatro espaços.

     Largo vale **três** módulos pelo mesmo motivo do ITF: a 8 dots/mm, o elemento estreito da faixa
     útil fica quase todo abaixo dos 0,51 mm que a norma exige para admitir 2:1. E vale aqui a mesma
     ressalva do ITF: o `GS k m=69` não leva a razão, a firmware escolhe a dela — em geral 2:1 —,
     então **o código nativo pode sair mais estreito que o rasterizado**. Nunca foi medido em papel.

     A tabela está na ordem de ``code39Alphabet``, que é a ordem de valor da própria norma.
     */
    private static let code39Patterns = [
        "111331311", "311311113", "113311113", "313311111", "111331113", "311331111",
        "113331111", "111311313", "311311311", "113311311", "311113113", "113113113",
        "313113111", "111133113", "311133111", "113133111", "111113313", "311113311",
        "113113311", "111133311", "311111133", "113111133", "313111131", "111131133",
        "311131131", "113131131", "111111333", "311111331", "113111331", "111131331",
        "331111113", "133111113", "333111111", "131131113", "331131111", "133131111",
        "131111313", "331111311", "133111311", "131313111", "131311131", "131113131",
        "111313131",
    ]

    /**
     O `*` que abre e fecha, e que **não** é caractere de dado.

     Ele não vai no `GS k m=69`: a especificação do comando lista o alfabeto sem o asterisco, porque
     quem põe as marcas é a firmware. O raster põe as mesmas por conta própria.
     */
    private static let code39DelimiterPattern = "131131311"

    private static let code39Allowed =
        "dígitos, letras maiúsculas e os sinais - . espaço $ / + %"

    /// O alfabeto em valores de escalar, para a busca sair igual à do Kotlin, caractere a caractere.
    private static let code39AlphabetScalars = code39Alphabet.unicodeScalars.map { Int($0.value) }

    private static func validateCode39(_ value: String) -> ThermalBarcodeValidation {
        if value.utf16.count > code39LengthRange.upperBound {
            return .rejected(reason: .tooLong(max: code39LengthRange.upperBound))
        }
        let scalars = Array(value.unicodeScalars).map { Int($0.value) }
        if scalars.contains(where: { !code39AlphabetScalars.contains($0) }) {
            return .rejected(reason: .unsupportedContent(allowed: code39Allowed))
        }
        return .accepted(normalized: value)
    }

    /**
     **Sem dígito verificador**, e a decisão é deliberada.

     O módulo 43 do Code 39 é opcional na norma, e o `GS k m=69` não acrescenta nenhum: a firmware
     desenha os caracteres que recebeu. Calcular um aqui faria o raster desenhar um caractere a mais
     que o nativo — dois símbolos para o mesmo pedido, que é justamente o que esta frente promete que
     não acontece. Quem precisa de verificador o inclui no conteúdo.
     */
    private static func code39Modules(_ value: String) -> [Bool]? {
        var patterns = [code39DelimiterPattern]
        for scalar in value.unicodeScalars {
            guard let index = code39AlphabetScalars.firstIndex(of: Int(scalar.value)) else {
                return nil
            }
            patterns.append(code39Patterns[index])
        }
        patterns.append(code39DelimiterPattern)
        return modulesFromWidths(gappedWidths(patterns))
    }

    // MARK: - Codabar

    /**
     Sete elementos por caractere — quatro barras e três espaços —, dois ou três deles largos.

     Ordem: ``codabarDataAlphabet`` e depois ``codabarDelimiters``. Mesma razão 3:1 do Code 39 e do
     ITF, e mesma ressalva sobre o que a firmware faz no `GS k m=71`.
     */
    private static let codabarPatterns = [
        "1111133", "1111331", "1113113", "3311111", "1131131", "3111131",
        "1311113", "1311311", "1331111", "3113111", "1113311", "1133111",
        "3111313", "3131113", "3131311", "1131313", "1133131", "1313113",
        "1113133", "1113331",
    ]

    private static let codabarAllowed =
        "dígitos e os sinais - $ : / . + entre as marcas A, B, C ou D"

    private static let codabarOrderScalars =
        (codabarDataAlphabet + codabarDelimiters).unicodeScalars.map { Int($0.value) }

    private static let codabarDelimiterScalars = codabarDelimiters.unicodeScalars.map { Int($0.value) }

    private static let codabarDataScalars = codabarDataAlphabet.unicodeScalars.map { Int($0.value) }

    private static func validateCodabar(_ value: String) -> ThermalBarcodeValidation {
        if value.utf16.count > codabarLengthRange.upperBound {
            return .rejected(reason: .tooLong(max: codabarLengthRange.upperBound))
        }
        if value.utf16.count < codabarLengthRange.lowerBound {
            return .rejected(
                reason: .wrongLength(
                    expected: "de \(codabarLengthRange.lowerBound) a "
                        + "\(codabarLengthRange.upperBound) caracteres, contando as marcas de "
                        + "início e fim"
                )
            )
        }
        // Marca minúscula é a mesma marca, e o `GS k m=71` aceita as duas caixas. A troca é feita à
        // mão, e não por `uppercased()`, porque conversão de caixa depende de idioma e as duas
        // plataformas precisam concordar caractere a caractere.
        let scalars = Array(value.unicodeScalars).map { code -> Int in
            let raw = Int(code.value)
            return (0x61...0x64).contains(raw) ? raw - 32 : raw
        }
        // As marcas fazem parte do dado: elas escolhem qual das quatro variantes o leitor reporta, e
        // por isso não podem ser postas por conta própria como o `*` do Code 39.
        guard let first = scalars.first, let last = scalars.last,
              codabarDelimiterScalars.contains(first), codabarDelimiterScalars.contains(last)
        else {
            return .rejected(reason: .unsupportedContent(allowed: codabarAllowed))
        }
        if scalars[1..<(scalars.count - 1)].contains(where: { !codabarDataScalars.contains($0) }) {
            return .rejected(reason: .unsupportedContent(allowed: codabarAllowed))
        }
        let normalized = String(String.UnicodeScalarView(
            scalars.compactMap { Unicode.Scalar(UInt32($0)) }
        ))
        return .accepted(normalized: normalized)
    }

    /// Sem verificador, pelo mesmo motivo do Code 39: o módulo 16 é opcional e o `GS k` não o põe.
    private static func codabarModules(_ value: String) -> [Bool]? {
        var patterns: [String] = []
        for scalar in value.unicodeScalars {
            guard let index = codabarOrderScalars.firstIndex(of: Int(scalar.value)) else {
                return nil
            }
            patterns.append(codabarPatterns[index])
        }
        return modulesFromWidths(gappedWidths(patterns))
    }

    // MARK: - Code 93

    /**
     Nove módulos por caractere, em três barras e três espaços — largura fixa, sem razão para
     escolher.

     Por isso o Code 93 é a única das seis em que a pegada física é a mesma nos dois modos sem
     ressalva nenhuma: não há 2:1 contra 3:1 a divergir. A tabela está na ordem de
     ``code93Alphabet``, e a posição **é** o valor no módulo 47.
     */
    private static let code93Patterns = [
        "100010100", "101001000", "101000100", "101000010", "100101000",
        "100100100", "100100010", "101010000", "100010010", "100001010",
        "110101000", "110100100", "110100010", "110010100", "110010010",
        "110001010", "101101000", "101100100", "101100010", "100110100",
        "100011010", "101011000", "101001100", "101000110", "100101100",
        "100010110", "110110100", "110110010", "110101100", "110100110",
        "110010110", "110011010", "101101100", "101100110", "100110110",
        "100111010", "100101110", "111010100", "111010010", "111001010",
        "101101110", "101110110", "110101110",
    ]

    /// O `*` de início e fim. Fecha com uma barra de um módulo, depois do stop.
    private static let code93DelimiterPattern = "101011110"
    private static let code93TerminationBar = "1"
    private static let code93CheckModulus = 47
    private static let code93CWeightCycle = 20
    private static let code93KWeightCycle = 15

    private static func validateCode93(_ value: String) -> ThermalBarcodeValidation {
        if value.utf16.count > code93LengthRange.upperBound {
            return .rejected(reason: .tooLong(max: code93LengthRange.upperBound))
        }
        // O alfabeto estendido do Code 93 existe por caracteres de deslocamento, que dobrariam o
        // símbolo e mudariam o que o `GS k m=72` recebe. A v1 fica nos 43 da tabela base.
        let scalars = Array(value.unicodeScalars).map { Int($0.value) }
        if scalars.contains(where: { !code39AlphabetScalars.contains($0) }) {
            return .rejected(reason: .unsupportedContent(allowed: code39Allowed))
        }
        return .accepted(normalized: value)
    }

    /**
     Dois verificadores, C e K, e eles **fazem parte do símbolo**, não do conteúdo.

     O `GS k m=72` recebe o conteúdo cru e a firmware calcula os mesmos dois — ao contrário do Code
     39, onde o verificador é opcional e ninguém o põe. Por isso aqui o kit calcula e o nativo
     continua igual ao raster.
     */
    private static func code93Modules(_ value: String) -> [Bool]? {
        var values: [Int] = []
        for scalar in value.unicodeScalars {
            guard let index = code39AlphabetScalars.firstIndex(of: Int(scalar.value)) else {
                return nil
            }
            values.append(index)
        }
        let checkC = code93CheckValue(values, cycle: code93CWeightCycle)
        let checkK = code93CheckValue(values + [checkC], cycle: code93KWeightCycle)
        var bits = code93DelimiterPattern
        for item in values + [checkC, checkK] { bits += code93Patterns[item] }
        bits += code93DelimiterPattern
        bits += code93TerminationBar
        return bits.map { $0 == "1" }
    }

    /**
     Peso que sobe da direita para a esquerda, reinicia depois do ciclo, e soma módulo 47.

     O ciclo é 20 para o C e 15 para o K; o K entra por cima da sequência que já inclui o C.
     */
    private static func code93CheckValue(_ values: [Int], cycle: Int) -> Int {
        var sum = 0
        for (position, item) in values.enumerated() {
            sum += item * ((values.count - position - 1) % cycle + 1)
        }
        return sum % code93CheckModulus
    }

    // MARK: - comum

    /**
     Padrões de largura separados por um espaço estreito.

     É o que junta caractere nas simbologias **discretas** — Code 39 e Codabar —, onde cada caractere
     começa e termina em barra e não há como encostar um no outro sem o separador de um módulo.
     Contínuas como o ITF e o Code 128 não passam por aqui.
     */
    private static func gappedWidths(_ patterns: [String]) -> [Int] {
        var widths: [Int] = []
        for (index, pattern) in patterns.enumerated() {
            if index > 0 { widths.append(1) }
            for element in pattern.unicodeScalars { widths.append(Int(element.value) - 0x30) }
        }
        return widths
    }

    /**
     Larguras de elemento viram módulos, alternando barra e espaço a partir da barra.

     Toda simbologia que chega aqui começa por barra, e os separadores de ``gappedWidths(_:)`` têm
     um número ímpar de elementos antes deles, então a alternância é posicional e não precisa de
     estado — o que também é o que faz as duas plataformas concordarem sem combinar nada.
     */
    private static func modulesFromWidths(_ widths: [Int]) -> [Bool] {
        var modules: [Bool] = []
        modules.reserveCapacity(widths.reduce(0, +))
        for (position, width) in widths.enumerated() {
            let black = position % 2 == 0
            modules += [Bool](repeating: black, count: width)
        }
        return modules
    }
}
