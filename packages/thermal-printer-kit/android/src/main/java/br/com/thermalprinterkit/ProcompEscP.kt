package br.com.thermalprinterkit

/**
 * Tabela alta da IM453H. O `n` é o que `ESC t` aceita, medido no papel em 23/08/2026.
 *
 * O mapa do manual valeu nesta firmware: uma tira com `ESC t 2` seguido de texto em CP850 saiu com
 * o acento certo, e o til da linha CP850 é idêntico ao da linha ABICOMP. Não é dedução do catálogo
 * — foi comparado glifo a glifo.
 */
enum class ProcompCodeTable(val selector: Int) {
    /** Padrão de fábrica da IM453H medida. Texto codificado assim sai certo **sem** `ESC t`. */
    ABICOMP(1),
    CP850(2),
}

/** Os dois comandos de corte medidos. Ambos saíram **parciais**: a guilhotina é "Somente Parcial". */
enum class ProcompCutCommand {
    /** `ESC w`. */
    ESC_W,

    /** `ESC US` — corte com avanço otimizado. */
    ESC_US,
}

/**
 * Emissor ESC/P da Diebold Procomp — a família da IM453H.
 *
 * **Kotlin puro, e isso é requisito, não coincidência.** `jvm/core` compila este diretório por
 * exclusão: um arquivo sem `android.*` chega sozinho ao Mac e ao Windows, e um arquivo com
 * `android.*` quebra aquela compilação. O Printher de mesa alcança USB; o de iOS não. Então o
 * emissor precisa nascer portátil.
 *
 * **Só emite o que saiu em papel.** Cada sequência abaixo foi vista impressa na bancada em
 * 23/08/2026. O que não foi medido — raster (`ESC k`, `ESC n`), QR nativo (`ESC ( k`) e a
 * autenticadora (`ESC }`, `ESC U`, `ESC V`) — **não tem função aqui**, de propósito. Nesta
 * impressora, mandar byte não medido já custou o aparelho travado com a tecla de avanço morta.
 *
 * **Duas ausências que são decisão:**
 *
 * * **não existe init.** `ESC @` não é comando desta firmware — ele sai como `@` no papel, e foi
 *   assim que descobrimos que o prólogo do transporte era nosso. [reset] desliga cada atributo com
 *   o comando que **desliga aquele atributo**, todos medidos, em vez de confiar num reset único que
 *   só o manual promete;
 * * **não existe alinhamento.** Não há `ESC a`. Quem centraliza é preenchimento — ver [padded].
 */
object ProcompEscP {
    /** Colunas medidas no recibo da IM453H: a régua de 48 dígitos coube em uma linha, sem sobra. */
    const val MEASURED_RECEIPT_COLUMNS = 48

    /**
     * Devolve o estado conhecido desligando atributo por atributo.
     *
     * `ESC M` existe no manual como "zera atributos" e, medido, **não deixa glifo** — mas "não
     * imprimiu nada" não é "zerou os atributos", e essa é a diferença que já custou caro neste
     * projeto. Os quatro desligamentos abaixo foram vistos agindo no papel, um a um.
     */
    fun reset(): ByteArray =
        byteArrayOf(
            ESC, EMPHASIS_OFF,
            ESC, EXPANDED_OFF,
            ESC, CONDENSED_OFF,
            ESC, DOUBLE_HEIGHT, OFF,
        )

    /**
     * `ESC t n`. Desnecessário quando o texto já vai em [ProcompCodeTable.ABICOMP] e a impressora
     * está no padrão de fábrica — o papel provou que ABICOMP direto sai certo sem seletor nenhum.
     */
    fun selectCodeTable(table: ProcompCodeTable): ByteArray =
        byteArrayOf(ESC, SELECT_TABLE, table.selector.toByte())

    fun emphasisOn(): ByteArray = byteArrayOf(ESC, EMPHASIS_ON)

    fun emphasisOff(): ByteArray = byteArrayOf(ESC, EMPHASIS_OFF)

    fun expandedOn(): ByteArray = byteArrayOf(ESC, EXPANDED_ON)

    fun expandedOff(): ByteArray = byteArrayOf(ESC, EXPANDED_OFF)

    fun condensedOn(): ByteArray = byteArrayOf(ESC, CONDENSED_ON)

    fun condensedOff(): ByteArray = byteArrayOf(ESC, CONDENSED_OFF)

    fun doubleHeight(enabled: Boolean): ByteArray =
        byteArrayOf(ESC, DOUBLE_HEIGHT, if (enabled) ON else OFF)

    /** Avanço por `LF`. A firmware imprime a linha corrente a cada `0Ah`. */
    fun feed(lines: Int): ByteArray {
        require(lines in 0..MAX_FEED_LINES) { "Avanço de linhas fora da faixa medida." }
        return ByteArray(lines) { LINE_FEED }
    }

    /** Os dois cortam, e os dois cortam **parcial** nesta configuração de guilhotina. */
    fun cut(command: ProcompCutCommand): ByteArray =
        when (command) {
            ProcompCutCommand.ESC_W -> byteArrayOf(ESC, CUT_ESC_W)
            ProcompCutCommand.ESC_US -> byteArrayOf(ESC, CUT_ESC_US)
        }

    /**
     * Codifica texto na tabela alta pedida.
     *
     * Caractere sem lugar na tabela **dobra para ASCII** antes de virar `?`: "ação" numa tabela sem
     * `ç` sai "acao", que é legível, e não "a?ao", que não é. É a mesma escolha que o kit já fazia no
     * caminho Epson.
     */
    fun encode(
        value: String,
        table: ProcompCodeTable,
    ): ByteArray {
        val mapa = if (table == ProcompCodeTable.ABICOMP) ABICOMP_HIGH else CP850_HIGH
        val saida = ArrayList<Byte>(value.length)
        value.forEach { caractere ->
            val codigo = caractere.code
            when {
                codigo == LINE_FEED.toInt() || isPrintableAscii(codigo) -> saida.add(codigo.toByte())
                mapa[caractere] != null -> saida.add(mapa.getValue(caractere))
                else -> ASCII_FOLD[caractere]?.forEach { saida.add(it.code.toByte()) }
                    ?: saida.add(FALLBACK)
            }
        }
        return saida.toByteArray()
    }

    /**
     * O alinhamento desta impressora é preenchimento, porque não existe `ESC a`.
     *
     * Devolve o texto com espaços à esquerda para centralizar em [columns]. Texto que não cabe volta
     * inteiro e sem recuo: cortar silenciosamente um recibo é pior que uma linha torta.
     */
    fun padded(
        value: String,
        columns: Int = MEASURED_RECEIPT_COLUMNS,
        alignment: ProcompAlignment = ProcompAlignment.LEFT,
    ): String {
        if (value.length >= columns) return value
        val sobra = columns - value.length
        return when (alignment) {
            ProcompAlignment.LEFT -> value
            ProcompAlignment.CENTER -> " ".repeat(sobra / 2) + value
            ProcompAlignment.RIGHT -> " ".repeat(sobra) + value
        }
    }

    private fun isPrintableAscii(code: Int): Boolean = code in 0x20..0x7E

    private const val ESC: Byte = 0x1B
    private const val LINE_FEED: Byte = 0x0A
    private const val FALLBACK: Byte = 0x3F
    private const val ON: Byte = 0x01
    private const val OFF: Byte = 0x00
    private const val MAX_FEED_LINES = 64

    /** `ESC E` / `ESC F` — **sem parâmetro**, ao contrário do ESC/POS. Medido: nada é consumido. */
    private const val EMPHASIS_ON: Byte = 0x45
    private const val EMPHASIS_OFF: Byte = 0x46

    /** `ESC SO` / `ESC DC4`. */
    private const val EXPANDED_ON: Byte = 0x0E
    private const val EXPANDED_OFF: Byte = 0x14

    /** `ESC SI` / `ESC DC2`. */
    private const val CONDENSED_ON: Byte = 0x0F
    private const val CONDENSED_OFF: Byte = 0x12

    /** `ESC ] n`. */
    private const val DOUBLE_HEIGHT: Byte = 0x5D
    private const val SELECT_TABLE: Byte = 0x74
    private const val CUT_ESC_W: Byte = 0x77
    private const val CUT_ESC_US: Byte = 0x1F

    /**
     * Tabela alta ABICOMP, `A1`–`DF`.
     *
     * **Provados em papel** nas tiras M2 e M3 de 23/08/2026: `ç`=`C6`, `ã`=`C4`, `ê`=`C9`, `á`=`C2`,
     * `õ`=`D3`. Em 26/08/2026 o comprovante da homologação acrescentou as 24 posições da amostra de
     * acentos, **maiúsculas inclusive** — `à ã á â é ê í ó ô õ ú À Ã Á Â É Ê Í Ó Ô Õ Ú ç Ç` —, que é
     * a metade da tabela onde a T210 tinha errado em 12/08 sem ninguém ver.
     *
     * O restante vem da seção 11.1 do manual e continua **sem** papel — o que não é motivo para não
     * emitir, mas é motivo para não jurar.
     */
    private val ABICOMP_HIGH: Map<Char, Byte> =
        mapOf(
            'À' to 0xA1, 'Á' to 0xA2, 'Â' to 0xA3, 'Ã' to 0xA4, 'Ä' to 0xA5, 'Ç' to 0xA6,
            'È' to 0xA7, 'É' to 0xA8, 'Ê' to 0xA9, 'Ë' to 0xAA, 'Ì' to 0xAB, 'Í' to 0xAC,
            'Î' to 0xAD, 'Ï' to 0xAE, 'Ñ' to 0xAF, 'Ò' to 0xB0, 'Ó' to 0xB1, 'Ô' to 0xB2,
            'Õ' to 0xB3, 'Ö' to 0xB4, 'Œ' to 0xB5, 'Ù' to 0xB6, 'Ú' to 0xB7, 'Û' to 0xB8,
            'Ü' to 0xB9, 'Ÿ' to 0xBA, '¨' to 0xBB, '£' to 0xBC, '§' to 0xBE, '°' to 0xBF,
            '¡' to 0xC0, 'à' to 0xC1, 'á' to 0xC2, 'â' to 0xC3, 'ã' to 0xC4, 'ä' to 0xC5,
            'ç' to 0xC6, 'è' to 0xC7, 'é' to 0xC8, 'ê' to 0xC9, 'ë' to 0xCA, 'ì' to 0xCB,
            'í' to 0xCC, 'î' to 0xCD, 'ï' to 0xCE, 'ñ' to 0xCF, 'ò' to 0xD0, 'ó' to 0xD1,
            'ô' to 0xD2, 'õ' to 0xD3, 'ö' to 0xD4, 'œ' to 0xD5, 'ù' to 0xD6, 'ú' to 0xD7,
            'û' to 0xD8, 'ü' to 0xD9, 'ÿ' to 0xDA, 'ß' to 0xDB, 'ª' to 0xDC, 'º' to 0xDD,
            '¿' to 0xDE, '±' to 0xDF,
        ).mapValues { (_, valor) -> valor.toByte() }

    /** CP850, só o subconjunto que o português usa. A tabela inteira não foi medida nesta firmware. */
    private val CP850_HIGH: Map<Char, Byte> =
        mapOf(
            'Ç' to 0x80, 'ü' to 0x81, 'é' to 0x82, 'â' to 0x83, 'ä' to 0x84, 'à' to 0x85,
            'ç' to 0x87, 'ê' to 0x88, 'ë' to 0x89, 'è' to 0x8A, 'ï' to 0x8B, 'î' to 0x8C,
            'Á' to 0xB5, 'Â' to 0xB6, 'À' to 0xB7, 'ã' to 0xC6, 'Ã' to 0xC7, 'í' to 0xA1,
            'ó' to 0xA2, 'ú' to 0xA3, 'ñ' to 0xA4, 'Ñ' to 0xA5, 'ª' to 0xA6, 'º' to 0xA7,
            '¿' to 0xA8, 'É' to 0x90, 'ô' to 0x93, 'ö' to 0x94, 'ò' to 0x95, 'û' to 0x96,
            'ù' to 0x97, 'Õ' to 0xE5, 'õ' to 0xE4, 'Ó' to 0xE0, 'Ô' to 0xE2, 'Ú' to 0xE9,
            'Í' to 0xD6, 'Ê' to 0xD2,
        ).mapValues { (_, valor) -> valor.toByte() }

    /** Dobra de último recurso: melhor "acao" que "a?ao". */
    private val ASCII_FOLD: Map<Char, String> =
        mapOf(
            'À' to "A", 'Á' to "A", 'Â' to "A", 'Ã' to "A", 'Ä' to "A", 'Ç' to "C",
            'È' to "E", 'É' to "E", 'Ê' to "E", 'Ë' to "E", 'Ì' to "I", 'Í' to "I",
            'Î' to "I", 'Ï' to "I", 'Ñ' to "N", 'Ò' to "O", 'Ó' to "O", 'Ô' to "O",
            'Õ' to "O", 'Ö' to "O", 'Ù' to "U", 'Ú' to "U", 'Û' to "U", 'Ü' to "U",
            'à' to "a", 'á' to "a", 'â' to "a", 'ã' to "a", 'ä' to "a", 'ç' to "c",
            'è' to "e", 'é' to "e", 'ê' to "e", 'ë' to "e", 'ì' to "i", 'í' to "i",
            'î' to "i", 'ï' to "i", 'ñ' to "n", 'ò' to "o", 'ó' to "o", 'ô' to "o",
            'õ' to "o", 'ö' to "o", 'ù' to "u", 'ú' to "u", 'û' to "u", 'ü' to "u",
            'ª' to "a", 'º' to "o", 'ß' to "ss",
        )
}

/** Não existe comando de alinhamento nesta firmware; o valor escolhe como o texto é preenchido. */
enum class ProcompAlignment {
    LEFT,
    CENTER,
    RIGHT,
}
