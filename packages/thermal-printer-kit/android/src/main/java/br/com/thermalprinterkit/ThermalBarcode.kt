package br.com.thermalprinterkit

/**
 * Quem desenha o código: o app, em pontos, ou a firmware, por comando.
 *
 * Não é capacidade: é preferência de quem usa, como [CutMode]. O padrão é [RASTERIZED] porque é o
 * que já está homologado em papel — e porque firmware que não entende o comando imprime o payload
 * como texto legível, o que num QR protegido seria vazar a assinatura.
 */
enum class ThermalCodeEmission {
    RASTERIZED,
    NATIVE,
    ;

    companion object {
        /** O padrão publicado, e o que sai quando ninguém pede outro. */
        val DEFAULT = RASTERIZED
    }
}

/**
 * As simbologias 1D que o kit sabe desenhar e sabe pedir.
 *
 * [nativeSelector] é o `m` da função B do `GS k` (`GS k m n d1…dn`), a forma com contagem
 * explícita: a função A termina em `NUL` e não sabe dizer que o dado tinha um zero dentro.
 *
 * As nove nascem juntas de propósito. `when` sobre enum é exaustivo, então acrescentar um caso
 * depois quebraria fonte em todo consumidor — e um interpretador de `GS k` do outro lado do balcão
 * recebe `m=65` a `m=72` sem ter escolhido, porque quem manda é o PDV alheio. O custo marginal de
 * já nascer com as nove é tabela, não caminho de execução.
 *
 * **A lista é exatamente a que o `GS k` endereça**, e os `nativeSelector` são os mesmos que o
 * interpretador ESC/POS já mapeia. Divergir criaria duas verdades sobre o mesmo comando.
 *
 * A ordem das três primeiras não muda: elas vieram antes, e reordenar mexeria em `entries` de quem
 * já persiste o nome.
 */
enum class ThermalBarcodeSymbology(
    val nativeSelector: Int,
    /** Módulos claros exigidos à esquerda e à direita, pela norma de cada uma. */
    val quietZoneModulesStart: Int,
    val quietZoneModulesEnd: Int,
) {
    CODE_128(73, 10, 10),
    EAN_13(67, 11, 7),
    ITF(70, 10, 10),
    EAN_8(68, 7, 7),
    UPC_A(65, 9, 9),
    UPC_E(66, 9, 7),
    CODE_39(69, 10, 10),
    CODABAR(71, 10, 10),
    CODE_93(72, 10, 10),
}

/**
 * Por que este conteúdo não vira código de barras, com a frase que a pessoa lê.
 *
 * A frase mora no kit, e não no app, porque a regra também mora aqui: dígito verificador, paridade
 * de comprimento e alfabeto são do símbolo, não da tela. App que escrevesse a própria frase
 * escreveria a própria regra junto, e as duas envelheceriam separadas.
 */
sealed interface ThermalBarcodeRejection {
    val message: String

    object Empty : ThermalBarcodeRejection {
        override val message: String = "Digite o conteúdo do código."
    }

    data class TooLong(val max: Int) : ThermalBarcodeRejection {
        override val message: String = "O código aceita no máximo $max caracteres."
    }

    object NonAscii : ThermalBarcodeRejection {
        override val message: String = "O código aceita apenas letras e números sem acento."
    }

    object NonDigit : ThermalBarcodeRejection {
        override val message: String = "Este código aceita apenas dígitos."
    }

    data class WrongLength(val expected: String) : ThermalBarcodeRejection {
        override val message: String = "Este código precisa de $expected."
    }

    object BadCheckDigit : ThermalBarcodeRejection {
        override val message: String = "O dígito verificador não confere."
    }

    /**
     * O alfabeto não é "ASCII imprimível" e a frase precisa dizer qual é.
     *
     * Code 39, Code 93 e Codabar têm cada um a sua lista fechada, e minúscula não entra em nenhum
     * dos dois primeiros. Uma frase genérica mandaria a pessoa adivinhar o que apagar.
     */
    data class UnsupportedContent(val allowed: String) : ThermalBarcodeRejection {
        override val message: String = "Este código aceita apenas $allowed."
    }

    /**
     * O número existe, mas não tem forma UPC-E.
     *
     * Duas entradas caem aqui: um UPC-A cujos zeros não estão onde a compressão exige, e um
     * seis-dígitos **não canônico** — aquele que a compressão do próprio UPC-A expandido devolveria
     * diferente. O segundo caso é sutil e é o que protege o contrato desta frente: a firmware que
     * recebe `GS k m=66` comprime por conta dela, e desenhar o não canônico faria o raster e o
     * nativo saírem com símbolos diferentes para o mesmo pedido.
     */
    object NotCompressible : ThermalBarcodeRejection {
        override val message: String = "Este número não tem forma UPC-E."
    }

    /**
     * Só quem conhece a largura do papel produz esta recusa.
     *
     * O emissor cru devolve `null`; quem tem `printableDots` — o layout — é que sabe dizer que a
     * largura é o problema, e é ele que traduz o `null` nesta frase.
     */
    object DoesNotFit : ThermalBarcodeRejection {
        override val message: String = "O código não cabe na largura desta impressora."
    }
}

/** Aceito com o conteúdo já normalizado, ou recusado com o motivo. */
sealed interface ThermalBarcodeValidation {
    /**
     * [normalized] é o que vai virar módulo.
     *
     * Em [ThermalBarcodeSymbology.EAN_13] com doze dígitos, é o conteúdo com o verificador
     * calculado: o símbolo desenhado e o `GS k` enviado carregam os mesmos treze dígitos, e a
     * legenda do HRI também.
     */
    data class Accepted(val normalized: String) : ThermalBarcodeValidation

    data class Rejected(val reason: ThermalBarcodeRejection) : ThermalBarcodeValidation
}

/**
 * A régua de módulos do kit: valida, codifica e conta.
 *
 * **Por que é nossa, e não do ZXing.** O modo nativo do Code 128 precisa da *mesma* decisão de
 * conjunto A/B/C que o raster: no `GS k m=73` o conjunto é escolhido pelo nosso payload, com os
 * escapes `{A {B {C`. Se o raster usasse a heurística de uma biblioteca e o nativo a nossa, o mesmo
 * texto sairia com dois símbolos diferentes conforme o ajuste, e a promessa de "muda só quem
 * desenha os módulos" cairia. Além disso, a largura física só se conhece contando módulos, e a
 * contagem é necessária nos dois modos. O ZXing continua onde estava: rasterização de QR no
 * Android.
 *
 * **Aritmética inteira, de ponta a ponta**, para o Android e o iOS emitirem os mesmos módulos e os
 * mesmos bytes — a mesma razão da reamostragem vertical por repetição de linha.
 */
object ThermalBarcode {
    /**
     * Faixa da largura de módulo em pontos.
     *
     * É o que o `GS w n` aceita na forma padrão; abaixo de 2 pontos nenhuma cabeça de 8 dots/mm
     * desenha barra fina confiável — 1 ponto seriam 0,125 mm.
     */
    val MODULE_WIDTH_DOTS_RANGE: IntRange = 2..6

    /** `GS h n` é um byte; 24 pontos são 3 mm, o piso do que um leitor aceita. */
    val HEIGHT_DOTS_RANGE: IntRange = 24..255

    /** 10 mm a 8 dots/mm. */
    const val DEFAULT_HEIGHT_DOTS = 80

    /** O mesmo teto que o esquema de browser já publica: 128 bytes ASCII por Code 128. */
    val CODE_128_LENGTH_RANGE: IntRange = 1..128

    /** Doze dígitos e o kit calcula o verificador; treze e o kit **confere** o verificador. */
    val EAN_13_LENGTH_RANGE: IntRange = 12..13

    /** ITF codifica aos pares; comprimento ímpar é dado errado, não dado a completar com zero. */
    val ITF_LENGTH_RANGE: IntRange = 2..64

    /** Sete dígitos e o kit calcula o verificador; oito e o kit **confere** o verificador. */
    val EAN_8_LENGTH_RANGE: IntRange = 7..8

    /**
     * Onze dígitos e o kit calcula o verificador; doze e o kit **confere**.
     *
     * **UPC-A não é EAN-13 encurtado.** São doze dígitos, e o EAN-13 equivalente é `"0"` mais os
     * doze — o zero à frente é que empurra os pesos `1,3,…` uma casa e faz o verificador do UPC-A,
     * de pesos `3,1,…`, dar o mesmo dígito. Tratar os doze como corpo de EAN-13 daria outro
     * verificador e outro símbolo.
     */
    val UPC_A_LENGTH_RANGE: IntRange = 11..12

    /**
     * A forma comprimida do UPC-E: seis dígitos, ou o sistema numérico e seis, ou os oito com o
     * verificador.
     */
    val UPC_E_LENGTH_RANGE: IntRange = 6..8

    /**
     * A forma UPC-A do UPC-E, que é a que o `GS k m=66` recebe.
     *
     * O comando nativo não leva o símbolo comprimido: a especificação do `GS k` pede o UPC-A de
     * onze ou doze dígitos e deixa a compressão para a firmware. Aceitar as duas formas aqui é o
     * que faz o mesmo pedido chegar igual pelos dois caminhos.
     */
    val UPC_E_EXPANDED_LENGTH_RANGE: IntRange = 11..12

    /** O mesmo teto de 64 do ITF, e pelo mesmo motivo: a largura é que recusa antes, não o texto. */
    val CODE_39_LENGTH_RANGE: IntRange = 1..64

    /** Três é o mínimo real: marca de início, ao menos um dado e marca de fim. */
    val CODABAR_LENGTH_RANGE: IntRange = 3..64

    /** O mesmo teto de 64; os dois verificadores do Code 93 não contam como conteúdo. */
    val CODE_93_LENGTH_RANGE: IntRange = 1..64

    /** O alfabeto do Code 39 e do Code 93, na ordem em que vale como valor de verificador. */
    const val CODE_39_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-. \$/+%"

    /** O Code 93 usa a mesma lista de 43, e a ordem **é** o valor no módulo 47. */
    const val CODE_93_ALPHABET = CODE_39_ALPHABET

    /** O miolo do Codabar. As marcas de início e fim são [CODABAR_DELIMITERS]. */
    const val CODABAR_DATA_ALPHABET = "0123456789-\$:/.+"

    /** Início e fim do Codabar. Fazem parte do dado, e por isso viajam no `GS k` também. */
    const val CODABAR_DELIMITERS = "ABCD"

    /**
     * Largura imprimível aceita, igual à do caminho de imagem: 640 pontos é a maior geometria
     * homologável (papel de 80 mm), e o `GS v 0` empacota byte a byte.
     */
    val PRINTABLE_DOTS_RANGE: IntRange = 8..640

    /** `GS ( k` função 167 aceita 1 a 16 pontos por módulo. */
    val QR_NATIVE_MODULE_SIZE_DOTS_RANGE: IntRange = 1..16

    /** Os mesmos códigos de pedido do `qrRaster`: 1=L, 2=M, 3=Q, 4=H. */
    val QR_NATIVE_ERROR_CORRECTION_RANGE: IntRange = 1..4

    /**
     * Teto do payload do QR nativo.
     *
     * É o menor dos dois tetos de raster que o kit já publica (o iOS recusa acima de 512 bytes), e
     * é ele de propósito: o modo nativo cai para o raster quando a capacidade medida não existe, e
     * um payload que só o nativo aceitasse falharia exatamente na hora em que a queda acontece.
     */
    const val QR_NATIVE_MAX_BYTES = 512

    /** Zona de silêncio do QR, em módulos, igual à que o `qrRaster` já usa. */
    const val QR_QUIET_ZONE_MODULES = 4

    /** `GS k m n d1…dn`: `n` é um byte, então o dado nativo não passa de 255 bytes. */
    const val MAX_NATIVE_DATA_BYTES = 255

    /** Alfabeto aceito pelo Code 128 neste kit, o mesmo do `qrRaster`. */
    const val PRINTABLE_ASCII_MIN = 0x20
    const val PRINTABLE_ASCII_MAX = 0x7e

    /**
     * Valida e normaliza sem desenhar nada.
     *
     * Existe separada de [modules] porque a tela precisa recusar **enquanto** a pessoa digita, e
     * porque quem oferece o campo tem de poder mostrar a frase antes de qualquer byte existir.
     */
    fun validate(
        value: String,
        symbology: ThermalBarcodeSymbology,
    ): ThermalBarcodeValidation {
        if (value.isEmpty()) return ThermalBarcodeValidation.Rejected(ThermalBarcodeRejection.Empty)
        return when (symbology) {
            ThermalBarcodeSymbology.CODE_128 -> validateCode128(value)
            ThermalBarcodeSymbology.EAN_13 -> validateEan13(value)
            ThermalBarcodeSymbology.ITF -> validateItf(value)
            ThermalBarcodeSymbology.EAN_8 -> validateEan8(value)
            ThermalBarcodeSymbology.UPC_A -> validateUpcA(value)
            ThermalBarcodeSymbology.UPC_E -> validateUpcE(value)
            ThermalBarcodeSymbology.CODE_39 -> validateCode39(value)
            ThermalBarcodeSymbology.CODABAR -> validateCodabar(value)
            ThermalBarcodeSymbology.CODE_93 -> validateCode93(value)
        }
    }

    /**
     * Os módulos do símbolo, **sem** zona de silêncio: `true` é barra, `false` é espaço.
     *
     * A zona de silêncio é somada por quem posiciona — uma vez só, pela mesma fórmula, nos dois
     * modos —, e é por isso que ela não está aqui: quem interpreta `GS k` alheio precisa dos
     * módulos do símbolo, não da margem que o nosso layout escolheu.
     */
    fun modules(
        value: String,
        symbology: ThermalBarcodeSymbology,
    ): List<Boolean>? {
        val accepted = (validate(value, symbology) as? ThermalBarcodeValidation.Accepted) ?: return null
        return when (symbology) {
            ThermalBarcodeSymbology.CODE_128 -> code128Modules(accepted.normalized)
            ThermalBarcodeSymbology.EAN_13 -> ean13Modules(accepted.normalized)
            ThermalBarcodeSymbology.ITF -> itfModules(accepted.normalized)
            ThermalBarcodeSymbology.EAN_8 -> ean8Modules(accepted.normalized)
            // O UPC-A é desenhado pelo EAN-13 de "0" mais os doze: a paridade toda ímpar do
            // primeiro dígito zero é, literalmente, o que faz os dois símbolos coincidirem.
            ThermalBarcodeSymbology.UPC_A -> ean13Modules("0" + accepted.normalized)
            ThermalBarcodeSymbology.UPC_E -> upcEModules(accepted.normalized)
            ThermalBarcodeSymbology.CODE_39 -> code39Modules(accepted.normalized)
            ThermalBarcodeSymbology.CODABAR -> codabarModules(accepted.normalized)
            ThermalBarcodeSymbology.CODE_93 -> code93Modules(accepted.normalized)
        }
    }

    /** Quantos módulos tem o símbolo, sem zona de silêncio. */
    fun moduleCount(
        value: String,
        symbology: ThermalBarcodeSymbology,
    ): Int? = modules(value, symbology)?.size

    /** Quantos módulos o símbolo ocupa **com** as duas zonas de silêncio da norma. */
    fun totalModules(
        value: String,
        symbology: ThermalBarcodeSymbology,
    ): Int? =
        moduleCount(value, symbology)?.let {
            symbology.quietZoneModulesStart + it + symbology.quietZoneModulesEnd
        }

    /**
     * "Codificar para medir": a largura de módulo que cabe nesta impressora.
     *
     * Nem o `GS k` nem o `GS v 0` recebem largura em pontos — recebem tamanho de módulo. Para não
     * inventar um número, o kit codifica o símbolo, que ele já precisa codificar, e divide a área
     * imprimível pela contagem. Devolve `null` quando nem o mínimo de [MODULE_WIDTH_DOTS_RANGE]
     * cabe; é esse `null` que o layout traduz em [ThermalBarcodeRejection.DoesNotFit].
     */
    fun moduleWidthDots(
        value: String,
        symbology: ThermalBarcodeSymbology,
        printableDots: Int,
    ): Int? {
        if (printableDots !in PRINTABLE_DOTS_RANGE || printableDots % 8 != 0) return null
        val total = totalModules(value, symbology) ?: return null
        val width = (printableDots / total).coerceIn(
            MODULE_WIDTH_DOTS_RANGE.first,
            MODULE_WIDTH_DOTS_RANGE.last,
        )
        return width.takeIf { total * it <= printableDots }
    }

    /**
     * Os bytes de dado do `GS k m n d1…dn` — só `d1…dn`, sem cabeçalho e sem contagem.
     *
     * No Code 128 são os escapes `{A {B {C` com as **mesmas** trocas de conjunto que [modules]
     * escolheu, e no conjunto C os dígitos vão como o par em binário, que é o que a especificação
     * pede. `{` do próprio conteúdo sai dobrado.
     */
    fun nativeData(
        value: String,
        symbology: ThermalBarcodeSymbology,
    ): ByteArray? {
        val accepted = (validate(value, symbology) as? ThermalBarcodeValidation.Accepted) ?: return null
        val data =
            when (symbology) {
                ThermalBarcodeSymbology.CODE_128 -> code128Plan(accepted.normalized)?.nativeData
                // O UPC-E é a exceção: o `GS k m=66` não recebe o símbolo comprimido, recebe o
                // UPC-A de doze dígitos e comprime sozinho. Mandar os oito canônicos seria mandar
                // outro número.
                ThermalBarcodeSymbology.UPC_E -> upcEExpand(accepted.normalized).map { it.code }
                // As demais viajam como os próprios caracteres ASCII, já normalizados. O EAN-13
                // vai com treze e o EAN-8 com oito, incluindo o verificador que o kit calculou:
                // assim o papel nativo e o papel rasterizado carregam o mesmo número, dígito a
                // dígito. No Codabar as marcas de início e fim vão junto, porque são dado.
                else -> accepted.normalized.map { it.code }
            } ?: return null
        if (data.isEmpty() || data.size > MAX_NATIVE_DATA_BYTES) return null
        return ByteArray(data.size) { data[it].toByte() }
    }

    // --- Code 128 ------------------------------------------------------------------------------

    /**
     * Os 107 padrões do Code 128, em larguras de elemento, começando sempre por barra.
     *
     * Um padrão são seis elementos que somam 11 módulos; o de parada (106) tem sete e soma 13,
     * porque termina com a barra dupla que fecha o símbolo. A tabela é a mesma para os conjuntos A,
     * B e C — o que muda entre eles é o significado do valor, não o desenho.
     */
    private val CODE_128_PATTERNS: Array<String> =
        arrayOf(
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
        )

    private const val CODE_128_STOP = 106
    private const val CODE_128_CHECK_MODULUS = 103
    private const val CODE_128_ESCAPE = '{'.code

    /**
     * Os três conjuntos do Code 128, com o valor que os inicia, o que troca para eles e a letra do
     * escape nativo.
     *
     * **[A] é declarado e nunca é escolhido pela régua.** O alfabeto aceito aqui é `0x20…0x7e`: o
     * conjunto B cobre todo ele, enquanto o A ganha os controles — que este kit não aceita — e
     * perde as minúsculas. Trocar para A jamais encurtaria um símbolo, e encurtaria o alfabeto.
     * Fica declarado porque quem interpreta `GS k` alheio encontra `{A` vindo de outro PDV, e
     * porque a tabela de padrões é a mesma para os três.
     */
    private enum class Code128Set(
        val startValue: Int,
        val switchValue: Int,
        val escapeLetter: Char,
    ) {
        A(103, 101, 'A'),
        B(104, 100, 'B'),
        C(105, 99, 'C'),
    }

    private class Code128Plan(
        val values: List<Int>,
        val nativeData: List<Int>,
    )

    /**
     * Escolhe conjunto e valores numa passada só, e monta o dado nativo na mesma passada.
     *
     * Os dois têm de sair do mesmo percurso: é literalmente o contrato desta frente que o símbolo
     * rasterizado e o símbolo pedido à firmware sejam o mesmo símbolo.
     */
    private fun code128Plan(value: String): Code128Plan? {
        val length = value.length
        val values = mutableListOf<Int>()
        val native = mutableListOf<Int>()
        var index = 0
        val leadingDigits = digitRun(value, 0)
        // Duas casas cabem num valor só do conjunto C, e é o único caso em que começar em C
        // compensa com menos de quatro dígitos. Corrida ímpar começa em B: o primeiro dígito sai
        // em B e o resto, já par, entra em C sem sobra.
        var set =
            if ((length == 2 && leadingDigits == 2) || (leadingDigits >= 4 && leadingDigits % 2 == 0)) {
                Code128Set.C
            } else {
                Code128Set.B
            }
        values += set.startValue
        native += CODE_128_ESCAPE
        native += set.escapeLetter.code
        while (index < length) {
            val run = digitRun(value, index)
            if (set == Code128Set.C) {
                if (run >= 2) {
                    val pair = (value[index] - '0') * 10 + (value[index + 1] - '0')
                    values += pair
                    native += pair
                    index += 2
                } else {
                    set = Code128Set.B
                    values += set.switchValue
                    native += CODE_128_ESCAPE
                    native += set.escapeLetter.code
                }
            } else {
                if (run >= 4) {
                    if (run % 2 == 1) {
                        appendSetB(value[index].code, values, native)
                        index += 1
                    }
                    set = Code128Set.C
                    values += set.switchValue
                    native += CODE_128_ESCAPE
                    native += set.escapeLetter.code
                } else {
                    appendSetB(value[index].code, values, native)
                    index += 1
                }
            }
        }
        val payload = values.drop(1)
        var checksum = values.first()
        payload.forEachIndexed { position, item -> checksum += (position + 1) * item }
        values += checksum % CODE_128_CHECK_MODULUS
        values += CODE_128_STOP
        return Code128Plan(values, native)
    }

    private fun appendSetB(
        code: Int,
        values: MutableList<Int>,
        native: MutableList<Int>,
    ) {
        values += code - PRINTABLE_ASCII_MIN
        // `{` é o escape do próprio protocolo nativo; dobrado, ele volta a ser conteúdo.
        if (code == CODE_128_ESCAPE) native += CODE_128_ESCAPE
        native += code
    }

    private fun digitRun(
        value: String,
        from: Int,
    ): Int {
        var count = 0
        while (from + count < value.length && value[from + count] in '0'..'9') count += 1
        return count
    }

    private fun code128Modules(value: String): List<Boolean>? {
        val plan = code128Plan(value) ?: return null
        val widths = mutableListOf<Int>()
        plan.values.forEach { symbol ->
            CODE_128_PATTERNS[symbol].forEach { widths += it - '0' }
        }
        return modulesFromWidths(widths)
    }

    private fun validateCode128(value: String): ThermalBarcodeValidation {
        if (value.length > CODE_128_LENGTH_RANGE.last) {
            return ThermalBarcodeValidation.Rejected(
                ThermalBarcodeRejection.TooLong(CODE_128_LENGTH_RANGE.last),
            )
        }
        if (value.any { it.code < PRINTABLE_ASCII_MIN || it.code > PRINTABLE_ASCII_MAX }) {
            return ThermalBarcodeValidation.Rejected(ThermalBarcodeRejection.NonAscii)
        }
        return ThermalBarcodeValidation.Accepted(value)
    }

    // --- EAN-13 --------------------------------------------------------------------------------

    /** Codificação ímpar do grupo da esquerda. */
    private val EAN_13_LEFT_ODD =
        arrayOf(
            "0001101", "0011001", "0010011", "0111101", "0100011",
            "0110001", "0101111", "0111011", "0110111", "0001011",
        )

    /** Codificação par do grupo da esquerda: é a da direita lida ao contrário. */
    private val EAN_13_LEFT_EVEN =
        arrayOf(
            "0100111", "0110011", "0011011", "0100001", "0011101",
            "0111001", "0000101", "0010001", "0001001", "0010111",
        )

    /** Grupo da direita: o complemento do ímpar da esquerda, e o que fecha com barra. */
    private val EAN_13_RIGHT =
        arrayOf(
            "1110010", "1100110", "1101100", "1000010", "1011100",
            "1001110", "1010000", "1000100", "1001000", "1110100",
        )

    /**
     * O primeiro dígito não tem barra própria: ele vive na paridade dos seis da esquerda.
     *
     * `1` escolhe a codificação par. É por isto que o EAN-13 tem 95 módulos e não 102.
     */
    private val EAN_13_PARITY =
        arrayOf(
            "000000", "001011", "001101", "001110", "010011",
            "011001", "011100", "010101", "010110", "011010",
        )

    private const val EAN_13_GUARD = "101"
    private const val EAN_13_CENTER = "01010"

    private fun validateEan13(value: String): ThermalBarcodeValidation {
        if (value.any { it !in '0'..'9' }) {
            return ThermalBarcodeValidation.Rejected(ThermalBarcodeRejection.NonDigit)
        }
        if (value.length !in EAN_13_LENGTH_RANGE) {
            return ThermalBarcodeValidation.Rejected(
                ThermalBarcodeRejection.WrongLength("12 ou 13 dígitos"),
            )
        }
        val body = value.take(EAN_13_LENGTH_RANGE.first)
        val check = ean13CheckDigit(body)
        if (value.length == EAN_13_LENGTH_RANGE.last && value.last() - '0' != check) {
            return ThermalBarcodeValidation.Rejected(ThermalBarcodeRejection.BadCheckDigit)
        }
        return ThermalBarcodeValidation.Accepted(body + ('0' + check))
    }

    /** Pesos 1 e 3 alternados da esquerda para a direita, e o que falta para a dezena. */
    private fun ean13CheckDigit(body: String): Int = eanFamilyCheckDigit(body, firstWeight = 1)

    /**
     * O verificador módulo 10 de toda a família EAN/UPC.
     *
     * A norma conta os pesos **da direita para a esquerda**, sempre 3 na última casa. O que muda de
     * uma simbologia para a outra é só onde essa alternância cai na primeira casa: 1 no EAN-13, que
     * tem doze dígitos de corpo, e 3 no EAN-8 e no UPC-A, que têm um número ímpar deles. É essa
     * casa de diferença — e não uma tabela diferente — que separa os três.
     */
    private fun eanFamilyCheckDigit(
        body: String,
        firstWeight: Int,
    ): Int {
        val secondWeight = 4 - firstWeight
        var sum = 0
        body.forEachIndexed { position, digit ->
            sum += (digit - '0') * if (position % 2 == 0) firstWeight else secondWeight
        }
        return (10 - sum % 10) % 10
    }

    private fun ean13Modules(value: String): List<Boolean> {
        val digits = value.map { it - '0' }
        val bits = StringBuilder()
        bits.append(EAN_13_GUARD)
        val parity = EAN_13_PARITY[digits[0]]
        for (position in 0 until 6) {
            val digit = digits[position + 1]
            bits.append(
                if (parity[position] == '1') EAN_13_LEFT_EVEN[digit] else EAN_13_LEFT_ODD[digit],
            )
        }
        bits.append(EAN_13_CENTER)
        for (position in 0 until 6) bits.append(EAN_13_RIGHT[digits[position + 7]])
        bits.append(EAN_13_GUARD)
        return bits.map { it == '1' }
    }

    // --- ITF -----------------------------------------------------------------------------------

    /**
     * Cinco elementos por dígito, dois deles largos — é daí que vem "2 de 5".
     *
     * Largo vale **três** módulos, e não dois. A norma admite a razão 2:1 só quando o elemento
     * estreito passa de 0,51 mm; a 8 dots/mm, um módulo de 2 a 6 pontos dá de 0,25 a 0,75 mm, e a
     * faixa que interessa está quase toda abaixo do limite. Três módulos é a razão que vale sempre.
     *
     * **E é aqui que "mesma pegada física nos dois modos" deixa de valer.** O `GS k m=70` não leva
     * a razão: quem a escolhe é a firmware, e a que se vê por aí costuma ser 2:1. Com 2:1 o mesmo
     * número ocupa `8 + 7n` módulos em vez dos `9 + 9n` daqui, e o código nativo sai mais estreito
     * que o rasterizado. O Code 128 e o EAN-13 não têm essa folga — a norma fixa a largura dos dois
     * —, então a promessa continua de pé neles. **Ninguém mediu isto em papel**, e a diferença de
     * largura do ITF entre os dois modos é pergunta de bancada, não conclusão de teste.
     */
    private val ITF_PATTERNS =
        arrayOf(
            intArrayOf(1, 1, 3, 3, 1), intArrayOf(3, 1, 1, 1, 3), intArrayOf(1, 3, 1, 1, 3),
            intArrayOf(3, 3, 1, 1, 1), intArrayOf(1, 1, 3, 1, 3), intArrayOf(3, 1, 3, 1, 1),
            intArrayOf(1, 3, 3, 1, 1), intArrayOf(1, 1, 1, 3, 3), intArrayOf(3, 1, 1, 3, 1),
            intArrayOf(1, 3, 1, 3, 1),
        )

    private val ITF_START = intArrayOf(1, 1, 1, 1)
    private val ITF_STOP = intArrayOf(3, 1, 1)

    private fun validateItf(value: String): ThermalBarcodeValidation {
        if (value.any { it !in '0'..'9' }) {
            return ThermalBarcodeValidation.Rejected(ThermalBarcodeRejection.NonDigit)
        }
        if (value.length !in ITF_LENGTH_RANGE || value.length % 2 != 0) {
            return ThermalBarcodeValidation.Rejected(
                ThermalBarcodeRejection.WrongLength(
                    "um número par de dígitos, de ${ITF_LENGTH_RANGE.first} a ${ITF_LENGTH_RANGE.last}",
                ),
            )
        }
        return ThermalBarcodeValidation.Accepted(value)
    }

    /** O primeiro dígito do par vira barra, o segundo vira espaço, um elemento de cada vez. */
    private fun itfModules(value: String): List<Boolean> {
        val widths = mutableListOf<Int>()
        ITF_START.forEach { widths += it }
        var index = 0
        while (index < value.length) {
            val bars = ITF_PATTERNS[value[index] - '0']
            val spaces = ITF_PATTERNS[value[index + 1] - '0']
            for (element in 0 until 5) {
                widths += bars[element]
                widths += spaces[element]
            }
            index += 2
        }
        ITF_STOP.forEach { widths += it }
        return modulesFromWidths(widths)
    }

    // --- EAN-8 ---------------------------------------------------------------------------------

    private fun validateEan8(value: String): ThermalBarcodeValidation {
        if (value.any { it !in '0'..'9' }) {
            return ThermalBarcodeValidation.Rejected(ThermalBarcodeRejection.NonDigit)
        }
        if (value.length !in EAN_8_LENGTH_RANGE) {
            return ThermalBarcodeValidation.Rejected(
                ThermalBarcodeRejection.WrongLength("7 ou 8 dígitos"),
            )
        }
        val body = value.take(EAN_8_LENGTH_RANGE.first)
        val check = eanFamilyCheckDigit(body, firstWeight = 3)
        if (value.length == EAN_8_LENGTH_RANGE.last && value.last() - '0' != check) {
            return ThermalBarcodeValidation.Rejected(ThermalBarcodeRejection.BadCheckDigit)
        }
        return ThermalBarcodeValidation.Accepted(body + ('0' + check))
    }

    /**
     * Quatro dígitos de cada lado, e **nenhuma paridade a escolher**.
     *
     * O EAN-13 esconde o primeiro dígito na paridade dos seis da esquerda; o EAN-8 não tem dígito
     * escondido, então o grupo da esquerda sai todo na codificação ímpar. São 67 módulos: guarda,
     * quatro dígitos, centro, quatro dígitos, guarda.
     */
    private fun ean8Modules(value: String): List<Boolean> {
        val digits = value.map { it - '0' }
        val bits = StringBuilder()
        bits.append(EAN_13_GUARD)
        for (position in 0 until 4) bits.append(EAN_13_LEFT_ODD[digits[position]])
        bits.append(EAN_13_CENTER)
        for (position in 0 until 4) bits.append(EAN_13_RIGHT[digits[position + 4]])
        bits.append(EAN_13_GUARD)
        return bits.map { it == '1' }
    }

    // --- UPC-A ---------------------------------------------------------------------------------

    private fun validateUpcA(value: String): ThermalBarcodeValidation {
        if (value.any { it !in '0'..'9' }) {
            return ThermalBarcodeValidation.Rejected(ThermalBarcodeRejection.NonDigit)
        }
        if (value.length !in UPC_A_LENGTH_RANGE) {
            return ThermalBarcodeValidation.Rejected(
                ThermalBarcodeRejection.WrongLength("11 ou 12 dígitos"),
            )
        }
        val body = value.take(UPC_A_LENGTH_RANGE.first)
        val check = eanFamilyCheckDigit(body, firstWeight = 3)
        if (value.length == UPC_A_LENGTH_RANGE.last && value.last() - '0' != check) {
            return ThermalBarcodeValidation.Rejected(ThermalBarcodeRejection.BadCheckDigit)
        }
        return ThermalBarcodeValidation.Accepted(body + ('0' + check))
    }

    // --- UPC-E ---------------------------------------------------------------------------------

    /** O UPC-E só existe nos sistemas numéricos 0 e 1. */
    private const val UPC_E_NUMBER_SYSTEMS = "01"

    /**
     * A paridade dos seis dígitos, escolhida pelo **verificador** — e não pelo primeiro dígito,
     * como no EAN-13.
     *
     * `1` é a codificação par. A tabela vale para o sistema numérico 0; no 1 ela inverte inteira, e
     * essa inversão é a única diferença entre os dois. É por isso que um leitor recupera o
     * verificador só de olhar a paridade: ele não está desenhado em lugar nenhum.
     */
    private val UPC_E_PARITY =
        arrayOf(
            "111000", "110100", "110010", "110001", "101100",
            "100110", "100011", "101010", "101001", "100101",
        )

    /** Seis módulos no fim, e não a guarda de três: é como o leitor sabe que o símbolo é UPC-E. */
    private const val UPC_E_END_GUARD = "010101"

    private fun validateUpcE(value: String): ThermalBarcodeValidation {
        if (value.any { it !in '0'..'9' }) {
            return ThermalBarcodeValidation.Rejected(ThermalBarcodeRejection.NonDigit)
        }
        val numberSystem: Char
        val compressed: String
        if (value.length in UPC_E_LENGTH_RANGE) {
            // Seis dígitos assumem o sistema numérico 0, que é o do varejo.
            numberSystem = if (value.length == UPC_E_LENGTH_RANGE.first) '0' else value[0]
            compressed =
                if (value.length == UPC_E_LENGTH_RANGE.first) value else value.substring(1, 7)
            if (numberSystem !in UPC_E_NUMBER_SYSTEMS) {
                return ThermalBarcodeValidation.Rejected(ThermalBarcodeRejection.NotCompressible)
            }
        } else if (value.length in UPC_E_EXPANDED_LENGTH_RANGE) {
            val body = value.take(UPC_E_EXPANDED_LENGTH_RANGE.first)
            if (value.length == UPC_E_EXPANDED_LENGTH_RANGE.last &&
                value.last() - '0' != eanFamilyCheckDigit(body, firstWeight = 3)
            ) {
                return ThermalBarcodeValidation.Rejected(ThermalBarcodeRejection.BadCheckDigit)
            }
            numberSystem = body[0]
            compressed =
                upcECompress(body)
                    ?: return ThermalBarcodeValidation.Rejected(
                        ThermalBarcodeRejection.NotCompressible,
                    )
        } else {
            return ThermalBarcodeValidation.Rejected(
                ThermalBarcodeRejection.WrongLength(
                    "6, 7 ou 8 dígitos, ou 11 ou 12 dígitos na forma UPC-A",
                ),
            )
        }
        // O verificador do UPC-E é o do UPC-A expandido: não existe conta própria.
        val expanded = upcEExpandBody(numberSystem, compressed)
        val check = eanFamilyCheckDigit(expanded, firstWeight = 3)
        if (value.length == UPC_E_LENGTH_RANGE.last && value.last() - '0' != check) {
            return ThermalBarcodeValidation.Rejected(ThermalBarcodeRejection.BadCheckDigit)
        }
        // **Canonicidade.** A expansão não é injetora: `000003` e `000000` expandem para o mesmo
        // UPC-A, e a compressão devolve sempre o segundo. Se o kit desenhasse o primeiro, a
        // firmware que recebe o `GS k m=66` — que leva o UPC-A — desenharia o segundo, e o mesmo
        // pedido sairia com dois símbolos conforme o modo. São 180.000 dos 2.000.000 de
        // seis-dígitos, todos com zeros à frente, e todos recusados aqui.
        if (upcECompress(expanded) != compressed) {
            return ThermalBarcodeValidation.Rejected(ThermalBarcodeRejection.NotCompressible)
        }
        return ThermalBarcodeValidation.Accepted("$numberSystem$compressed${'0' + check}")
    }

    /**
     * Onde os quatro ou cinco zeros suprimidos voltam, decidido pelo **último** dos seis dígitos.
     *
     * Devolve os onze dígitos do corpo, sem verificador.
     */
    private fun upcEExpandBody(
        numberSystem: Char,
        compressed: String,
    ): String {
        val x = compressed
        return when (x[5]) {
            '0', '1', '2' -> "$numberSystem${x[0]}${x[1]}${x[5]}0000${x[2]}${x[3]}${x[4]}"
            '3' -> "$numberSystem${x[0]}${x[1]}${x[2]}00000${x[3]}${x[4]}"
            '4' -> "$numberSystem${x[0]}${x[1]}${x[2]}${x[3]}00000${x[4]}"
            else -> "$numberSystem${x[0]}${x[1]}${x[2]}${x[3]}${x[4]}0000${x[5]}"
        }
    }

    /** Do canônico de oito para os doze dígitos que o `GS k m=66` recebe. */
    private fun upcEExpand(normalized: String): String =
        upcEExpandBody(normalized[0], normalized.substring(1, 7)) + normalized[7]

    /**
     * A inversa: os onze dígitos do UPC-A viram os seis do UPC-E, ou `null` quando não há forma.
     *
     * A ordem das quatro regras **é** a definição — a primeira que casa é a que vale, e é por isso
     * que a segunda exige `p[2]` fora de 0..2 e a terceira exige `p[3]` diferente de zero: sem essas
     * guardas duas regras casariam no mesmo número e a compressão deixaria de ser função.
     */
    private fun upcECompress(body: String): String? {
        if (body[0] !in UPC_E_NUMBER_SYSTEMS) return null
        val p = body.substring(1)
        return when {
            p.substring(3, 7) == "0000" && p[2] in '0'..'2' ->
                "${p[0]}${p[1]}${p[7]}${p[8]}${p[9]}${p[2]}"
            p.substring(3, 8) == "00000" && p[2] in '3'..'9' ->
                "${p[0]}${p[1]}${p[2]}${p[8]}${p[9]}3"
            p.substring(4, 9) == "00000" && p[3] != '0' ->
                "${p[0]}${p[1]}${p[2]}${p[3]}${p[9]}4"
            p.substring(5, 9) == "0000" && p[9] in '5'..'9' ->
                p.substring(0, 5) + p[9]
            else -> null
        }
    }

    /** Guarda, seis dígitos com a paridade do verificador, e a guarda de fim de seis módulos. */
    private fun upcEModules(value: String): List<Boolean> {
        val digits = value.map { it - '0' }
        val base = UPC_E_PARITY[digits[7]]
        val parity =
            if (value[0] == '1') {
                base.map { if (it == '1') '0' else '1' }.joinToString("")
            } else {
                base
            }
        val bits = StringBuilder()
        bits.append(EAN_13_GUARD)
        for (position in 0 until 6) {
            val digit = digits[position + 1]
            bits.append(
                if (parity[position] == '1') EAN_13_LEFT_EVEN[digit] else EAN_13_LEFT_ODD[digit],
            )
        }
        bits.append(UPC_E_END_GUARD)
        return bits.map { it == '1' }
    }

    // --- Code 39 -------------------------------------------------------------------------------

    /**
     * Nove elementos por caractere, três deles largos — cinco barras e quatro espaços.
     *
     * Largo vale **três** módulos pelo mesmo motivo do ITF: a 8 dots/mm, o elemento estreito da
     * faixa útil fica quase todo abaixo dos 0,51 mm que a norma exige para admitir 2:1. E vale aqui
     * a mesma ressalva do ITF: o `GS k m=69` não leva a razão, a firmware escolhe a dela — em geral
     * 2:1 —, então **o código nativo pode sair mais estreito que o rasterizado**. Nunca foi medido
     * em papel.
     *
     * A tabela está na ordem de [CODE_39_ALPHABET], que é a ordem de valor da própria norma.
     */
    private val CODE_39_PATTERNS =
        arrayOf(
            "111331311", "311311113", "113311113", "313311111", "111331113", "311331111",
            "113331111", "111311313", "311311311", "113311311", "311113113", "113113113",
            "313113111", "111133113", "311133111", "113133111", "111113313", "311113311",
            "113113311", "111133311", "311111133", "113111133", "313111131", "111131133",
            "311131131", "113131131", "111111333", "311111331", "113111331", "111131331",
            "331111113", "133111113", "333111111", "131131113", "331131111", "133131111",
            "131111313", "331111311", "133111311", "131313111", "131311131", "131113131",
            "111313131",
        )

    /**
     * O `*` que abre e fecha, e que **não** é caractere de dado.
     *
     * Ele não vai no `GS k m=69`: a especificação do comando lista o alfabeto sem o asterisco,
     * porque quem põe as marcas é a firmware. O raster põe as mesmas por conta própria.
     */
    private const val CODE_39_DELIMITER_PATTERN = "131131311"

    private const val CODE_39_ALLOWED =
        "dígitos, letras maiúsculas e os sinais - . espaço \$ / + %"

    private fun validateCode39(value: String): ThermalBarcodeValidation {
        if (value.length > CODE_39_LENGTH_RANGE.last) {
            return ThermalBarcodeValidation.Rejected(
                ThermalBarcodeRejection.TooLong(CODE_39_LENGTH_RANGE.last),
            )
        }
        if (value.any { CODE_39_ALPHABET.indexOf(it) < 0 }) {
            return ThermalBarcodeValidation.Rejected(
                ThermalBarcodeRejection.UnsupportedContent(CODE_39_ALLOWED),
            )
        }
        return ThermalBarcodeValidation.Accepted(value)
    }

    /**
     * **Sem dígito verificador**, e a decisão é deliberada.
     *
     * O módulo 43 do Code 39 é opcional na norma, e o `GS k m=69` não acrescenta nenhum: a firmware
     * desenha os caracteres que recebeu. Calcular um aqui faria o raster desenhar um caractere a
     * mais que o nativo — dois símbolos para o mesmo pedido, que é justamente o que esta frente
     * promete que não acontece. Quem precisa de verificador o inclui no conteúdo.
     */
    private fun code39Modules(value: String): List<Boolean>? {
        val patterns = mutableListOf(CODE_39_DELIMITER_PATTERN)
        value.forEach {
            val index = CODE_39_ALPHABET.indexOf(it)
            if (index < 0) return null
            patterns += CODE_39_PATTERNS[index]
        }
        patterns += CODE_39_DELIMITER_PATTERN
        return modulesFromWidths(gappedWidths(patterns))
    }

    // --- Codabar -------------------------------------------------------------------------------

    /**
     * Sete elementos por caractere — quatro barras e três espaços —, dois ou três deles largos.
     *
     * Ordem: [CODABAR_DATA_ALPHABET] e depois [CODABAR_DELIMITERS]. Mesma razão 3:1 do Code 39 e do
     * ITF, e mesma ressalva sobre o que a firmware faz no `GS k m=71`.
     */
    private val CODABAR_PATTERNS =
        arrayOf(
            "1111133", "1111331", "1113113", "3311111", "1131131", "3111131",
            "1311113", "1311311", "1331111", "3113111", "1113311", "1133111",
            "3111313", "3131113", "3131311", "1131313", "1133131", "1313113",
            "1113133", "1113331",
        )

    private const val CODABAR_ALLOWED =
        "dígitos e os sinais - \$ : / . + entre as marcas A, B, C ou D"

    private fun validateCodabar(value: String): ThermalBarcodeValidation {
        if (value.length > CODABAR_LENGTH_RANGE.last) {
            return ThermalBarcodeValidation.Rejected(
                ThermalBarcodeRejection.TooLong(CODABAR_LENGTH_RANGE.last),
            )
        }
        if (value.length < CODABAR_LENGTH_RANGE.first) {
            return ThermalBarcodeValidation.Rejected(
                ThermalBarcodeRejection.WrongLength(
                    "de ${CODABAR_LENGTH_RANGE.first} a ${CODABAR_LENGTH_RANGE.last} caracteres, " +
                        "contando as marcas de início e fim",
                ),
            )
        }
        // Marca minúscula é a mesma marca, e o `GS k m=71` aceita as duas caixas. A troca é feita
        // à mão, e não por `uppercase()`, porque conversão de caixa depende de idioma e as duas
        // plataformas precisam concordar caractere a caractere.
        val normalized = value.map { if (it in 'a'..'d') it - 32 else it }.joinToString("")
        // As marcas fazem parte do dado: elas escolhem qual das quatro variantes o leitor reporta,
        // e por isso não podem ser postas por conta própria como o `*` do Code 39.
        if (normalized.first() !in CODABAR_DELIMITERS || normalized.last() !in CODABAR_DELIMITERS) {
            return ThermalBarcodeValidation.Rejected(
                ThermalBarcodeRejection.UnsupportedContent(CODABAR_ALLOWED),
            )
        }
        if (normalized.substring(1, normalized.length - 1).any { it !in CODABAR_DATA_ALPHABET }) {
            return ThermalBarcodeValidation.Rejected(
                ThermalBarcodeRejection.UnsupportedContent(CODABAR_ALLOWED),
            )
        }
        return ThermalBarcodeValidation.Accepted(normalized)
    }

    /** Sem verificador, pelo mesmo motivo do Code 39: o módulo 16 é opcional e o `GS k` não o põe. */
    private fun codabarModules(value: String): List<Boolean>? {
        val order = CODABAR_DATA_ALPHABET + CODABAR_DELIMITERS
        val patterns = mutableListOf<String>()
        value.forEach {
            val index = order.indexOf(it)
            if (index < 0) return null
            patterns += CODABAR_PATTERNS[index]
        }
        return modulesFromWidths(gappedWidths(patterns))
    }

    // --- Code 93 -------------------------------------------------------------------------------

    /**
     * Nove módulos por caractere, em três barras e três espaços — largura fixa, sem razão para
     * escolher.
     *
     * Por isso o Code 93 é a única das seis em que a pegada física é a mesma nos dois modos sem
     * ressalva nenhuma: não há 2:1 contra 3:1 a divergir. A tabela está na ordem de
     * [CODE_93_ALPHABET], e a posição **é** o valor no módulo 47.
     */
    private val CODE_93_PATTERNS =
        arrayOf(
            "100010100", "101001000", "101000100", "101000010", "100101000",
            "100100100", "100100010", "101010000", "100010010", "100001010",
            "110101000", "110100100", "110100010", "110010100", "110010010",
            "110001010", "101101000", "101100100", "101100010", "100110100",
            "100011010", "101011000", "101001100", "101000110", "100101100",
            "100010110", "110110100", "110110010", "110101100", "110100110",
            "110010110", "110011010", "101101100", "101100110", "100110110",
            "100111010", "100101110", "111010100", "111010010", "111001010",
            "101101110", "101110110", "110101110",
        )

    /** O `*` de início e fim. Fecha com uma barra de um módulo, depois do stop. */
    private const val CODE_93_DELIMITER_PATTERN = "101011110"
    private const val CODE_93_TERMINATION_BAR = "1"
    private const val CODE_93_CHECK_MODULUS = 47
    private const val CODE_93_C_WEIGHT_CYCLE = 20
    private const val CODE_93_K_WEIGHT_CYCLE = 15

    private fun validateCode93(value: String): ThermalBarcodeValidation {
        if (value.length > CODE_93_LENGTH_RANGE.last) {
            return ThermalBarcodeValidation.Rejected(
                ThermalBarcodeRejection.TooLong(CODE_93_LENGTH_RANGE.last),
            )
        }
        // O alfabeto estendido do Code 93 existe por caracteres de deslocamento, que dobrariam o
        // símbolo e mudariam o que o `GS k m=72` recebe. A v1 fica nos 43 da tabela base.
        if (value.any { CODE_93_ALPHABET.indexOf(it) < 0 }) {
            return ThermalBarcodeValidation.Rejected(
                ThermalBarcodeRejection.UnsupportedContent(CODE_39_ALLOWED),
            )
        }
        return ThermalBarcodeValidation.Accepted(value)
    }

    /**
     * Dois verificadores, C e K, e eles **fazem parte do símbolo**, não do conteúdo.
     *
     * O `GS k m=72` recebe o conteúdo cru e a firmware calcula os mesmos dois — ao contrário do
     * Code 39, onde o verificador é opcional e ninguém o põe. Por isso aqui o kit calcula e o
     * nativo continua igual ao raster.
     */
    private fun code93Modules(value: String): List<Boolean>? {
        val values = value.map { CODE_93_ALPHABET.indexOf(it) }
        if (values.any { it < 0 }) return null
        val checkC = code93CheckValue(values, CODE_93_C_WEIGHT_CYCLE)
        val checkK = code93CheckValue(values + checkC, CODE_93_K_WEIGHT_CYCLE)
        val bits = StringBuilder()
        bits.append(CODE_93_DELIMITER_PATTERN)
        (values + checkC + checkK).forEach { bits.append(CODE_93_PATTERNS[it]) }
        bits.append(CODE_93_DELIMITER_PATTERN)
        bits.append(CODE_93_TERMINATION_BAR)
        return bits.map { it == '1' }
    }

    /**
     * Peso que sobe da direita para a esquerda, reinicia depois do ciclo, e soma módulo 47.
     *
     * O ciclo é 20 para o C e 15 para o K; o K entra por cima da sequência que já inclui o C.
     */
    private fun code93CheckValue(
        values: List<Int>,
        cycle: Int,
    ): Int {
        var sum = 0
        values.forEachIndexed { position, item ->
            sum += item * ((values.size - position - 1) % cycle + 1)
        }
        return sum % CODE_93_CHECK_MODULUS
    }

    // --- comum ---------------------------------------------------------------------------------

    /**
     * Padrões de largura separados por um espaço estreito.
     *
     * É o que junta caractere nas simbologias **discretas** — Code 39 e Codabar —, onde cada
     * caractere começa e termina em barra e não há como encostar um no outro sem o separador de um
     * módulo. Contínuas como o ITF e o Code 128 não passam por aqui.
     */
    private fun gappedWidths(patterns: List<String>): List<Int> {
        val widths = mutableListOf<Int>()
        patterns.forEachIndexed { index, pattern ->
            if (index > 0) widths += 1
            pattern.forEach { widths += it - '0' }
        }
        return widths
    }

    /**
     * Larguras de elemento viram módulos, alternando barra e espaço a partir da barra.
     *
     * Toda simbologia que chega aqui começa por barra, e os separadores de [gappedWidths] têm
     * largura ímpar de elementos antes deles, então a alternância é posicional e não precisa de
     * estado — o que também é o que faz as duas plataformas concordarem sem combinar nada.
     */
    private fun modulesFromWidths(widths: List<Int>): List<Boolean> {
        val modules = ArrayList<Boolean>(widths.sum())
        widths.forEachIndexed { position, width ->
            val black = position % 2 == 0
            repeat(width) { modules += black }
        }
        return modules
    }
}
