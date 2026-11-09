package br.com.thermalprinterkit

import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter
import com.google.zxing.qrcode.encoder.Encoder as QrEncoder
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel
import java.io.ByteArrayOutputStream
import java.nio.charset.StandardCharsets
import java.text.Normalizer

/** Identidade textual declarada pela própria firmware via variantes estendidas de `GS I`. */
data class PrinterDeclaredIdentity(
    val firmwareVersion: String? = null,
    val manufacturer: String? = null,
    val model: String? = null,
) {
    init {
        require(listOfNotNull(firmwareVersion, manufacturer, model).isNotEmpty()) {
            "Identidade declarada vazia."
        }
        listOfNotNull(firmwareVersion, manufacturer, model).forEach { value ->
            require(sanitizeField(value.toByteArray(StandardCharsets.US_ASCII)) == value) {
                "Identidade declarada inválida."
            }
        }
    }

    /** Modelo continua no único campo de marca/modelo permitido pelo perfil: `displayName`. */
    internal fun displayNameOr(fallback: String): String {
        val candidate =
            when {
                manufacturer != null && model != null &&
                    !model.startsWith(manufacturer, ignoreCase = true) -> "$manufacturer $model"
                model != null -> model
                manufacturer != null -> manufacturer
                else -> fallback
            }
        return candidate.takeIf { it.length <= 80 } ?: fallback
    }

    override fun toString(): String = "PrinterDeclaredIdentity(disponivel=true)"

    companion object {
        const val MAX_FIELD_BYTES = 64

        /** Aceita apenas ASCII imprimível, com NUL obrigatório tratado pelo transporte. */
        fun sanitizeField(bytes: ByteArray): String? {
            if (bytes.isEmpty() || bytes.size > MAX_FIELD_BYTES) return null
            if (bytes.any { (it.toInt() and 0xff) !in 0x20..0x7e }) return null
            val bruto = String(bytes, StandardCharsets.US_ASCII).trim().takeIf(String::isNotEmpty)
                ?: return null
            // O filtro roda no bruto **antes** de tirar rótulo: `AA:BB:CC:DD:EE:FF` é MAC, e tirar
            // o `AA:` como se fosse rótulo deixaria o resto passar por não parecer mais um MAC.
            if (TECHNICAL_IDENTIFIER_PATTERNS.any { it.containsMatchIn(bruto) }) return null
            val value = withoutFieldLabel(bruto).trim().takeIf(String::isNotEmpty) ?: return null
            // E roda de novo no que sobrou, porque o rótulo pode esconder o identificador.
            if (TECHNICAL_IDENTIFIER_PATTERNS.any { it.containsMatchIn(value) }) return null
            return value
        }

        /**
         * Tira o rótulo que algumas firmwares mandam junto do valor.
         *
         * A J-SPEED P80 responde `_Manufacturer:J-SPEED` e `_Print Name:P80-Serials`, e o `_8.00
         * ESC/POS` da versão. Guardar isso inteiro faz o comprovante sair com `Fabricante:
         * _Manufacturer:J-SPEED` e batiza o perfil de `_Manufacturer:J-SPEED _Print
         * Name:P80-Serials` — que é o nome que iria para o perfil.
         *
         * Só cai fora o que é claramente rótulo: um prefixo de letras e espaços seguido de dois
         * pontos. Modelo que use dois pontos no meio do nome sobrevive inteiro.
         */
        private fun withoutFieldLabel(value: String): String {
            val semSublinhado = value.trimStart().removePrefix("_")
            val rotulo = Regex("^[A-Za-z][A-Za-z ]{0,30}:")
            return rotulo.find(semSublinhado)
                ?.let { semSublinhado.removeRange(it.range) }
                ?: semSublinhado
        }

        internal fun fromResponses(
            firmwareVersion: ByteArray?,
            manufacturer: ByteArray?,
            model: ByteArray?,
        ): PrinterDeclaredIdentity? {
            val firmware = firmwareVersion?.let(::sanitizeField)
            val maker = manufacturer?.let(::sanitizeField)
            val modelName = model?.let(::sanitizeField)
            if (firmware == null && maker == null && modelName == null) return null
            return PrinterDeclaredIdentity(firmware, maker, modelName)
        }

        private val TECHNICAL_IDENTIFIER_PATTERNS =
            listOf(
                Regex("(?:^|\\D)(?:\\d{1,3}\\.){3}\\d{1,3}(?:$|\\D)"),
                Regex("(?i)(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}"),
                Regex("(?i)\\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\b"),
            )
    }
}

/** Variantes estendidas escolhidas: firmware, fabricante e modelo. Serial (68) não é consultado. */
object EscPosPrinterIdentity {
    val FIRMWARE_VERSION_QUERY: ByteArray = byteArrayOf(0x1d, 0x49, 65)
    val MANUFACTURER_QUERY: ByteArray = byteArrayOf(0x1d, 0x49, 66)
    val MODEL_QUERY: ByteArray = byteArrayOf(0x1d, 0x49, 67)
}

enum class ThermalTextAlignment(
    val escPosValue: Int,
) {
    LEFT(0),
    CENTER(1),
    RIGHT(2),
}

enum class ThermalTextStyle {
    NORMAL,
    BOLD,
}

/** Como a firmware recebe os bytes de texto; comandos ESC/POS continuam binários em todos os casos. */
enum class ThermalTextEncoding {
    /** Texto em tabela de byte único, selecionada por [ThermalCodePage] via `ESC t`. */
    SINGLE_BYTE_CODE_PAGE,

    /**
     * Tabela de byte único que a firmware já liga sozinha; o kit **não** emite `ESC t`.
     *
     * Medido na T210: a linha sem seleção sai com todos os acentos, e `ESC t 3` — o endereço
     * canônico da CP860 — troca para outra tabela e estraga. Vários endereços servem nela, e
     * nenhum endereço serve também. Mandar seleção onde ela não é necessária é risco sem ganho:
     * cada `ESC t` é uma chance de cair na tabela errada.
     */
    FIRMWARE_DEFAULT_PAGE,

    /** Texto Unicode codificado em UTF-8, sem emissão de `ESC t`. */
    UTF_8,

    /** Sem acento: dobra conservadora para ASCII e não emite `ESC t`. */
    ASCII,

    ;

    /** Verdadeiro quando o texto sai por tabela de byte único, com ou sem `ESC t`. */
    val usesCodePage: Boolean
        get() = this == SINGLE_BYTE_CODE_PAGE || this == FIRMWARE_DEFAULT_PAGE

    val label: String
        get() =
            when (this) {
                SINGLE_BYTE_CODE_PAGE -> "Página de byte único"
                FIRMWARE_DEFAULT_PAGE -> "Página padrão da impressora"
                UTF_8 -> "UTF-8"
                ASCII -> "Sem acentos (ASCII)"
            }

    /**
     * Cabe em 32 colunas junto do rótulo. O nome longo estourava a linha e quebrava no meio da
     * palavra — a T210 imprimiu "Página de byte únic / o".
     */
    val receiptLabel: String
        get() =
            when (this) {
                SINGLE_BYTE_CODE_PAGE -> "Byte único"
                FIRMWARE_DEFAULT_PAGE -> "Padrão da impressora"
                UTF_8 -> "UTF-8"
                ASCII -> "Sem acentos"
            }
}

/** Multiplicadores seguros de `GS !`: a firmware aceita de uma a oito vezes cada eixo. */
data class ThermalTextSize(
    val widthMultiplier: Int,
    val heightMultiplier: Int,
) {
    init {
        require(widthMultiplier in MIN_MULTIPLIER..MAX_MULTIPLIER) {
            "Multiplicador de largura do texto inválido."
        }
        require(heightMultiplier in MIN_MULTIPLIER..MAX_MULTIPLIER) {
            "Multiplicador de altura do texto inválido."
        }
    }

    internal val escPosValue: Int
        get() = ((widthMultiplier - 1) shl 4) or (heightMultiplier - 1)

    companion object {
        val NORMAL = ThermalTextSize(widthMultiplier = 1, heightMultiplier = 1)

        const val MIN_MULTIPLIER = 1
        const val MAX_MULTIPLIER = 8
    }
}

/**
 * Página de código do texto ESC/POS.
 *
 * A tabela é escrita à mão em vez de usar `Charset.forName("IBM850")` porque o Android não
 * garante charsets além de US-ASCII, ISO-8859-1 e a família UTF — pedir IBM850 lança
 * `UnsupportedCharsetException` em parte dos aparelhos.
 *
 * CP850 é o padrão aqui por ser o mais aceito pelas impressoras; CP860 é a página portuguesa e
 * fica disponível para modelo que só entenda ela.
 */
enum class ThermalCodePage(
    val escPosValue: Int,
) {
    CP850(2) {
        override fun encode(character: Char): Int? = CP850_TABLE[character]
    },
    CP860(3) {
        override fun encode(character: Char): Int? = CP860_TABLE[character]
    },
    CP437(0) {
        override fun encode(character: Char): Int? = CP437_TABLE[character]
    },
    CP1252(16) {
        override fun encode(character: Char): Int? = CP1252_TABLE[character]
    },
    CP866(17) {
        override fun encode(character: Char): Int? = CP866_TABLE[character]
    },
    CP858(19) {
        override fun encode(character: Char): Int? = CP858_TABLE[character]
    },
    ;

    /** Byte da página para o caractere, ou `null` se ela não o representa. */
    abstract fun encode(character: Char): Int?

    companion object {
        // Só o que aparece em português. Qualquer coisa fora daqui cai no dobramento para ASCII,
        // que é o comportamento antigo e continua sendo a rede de segurança.
        private val CP850_TABLE =
            mapOf(
                'Ç' to 0x80, 'ü' to 0x81, 'é' to 0x82, 'â' to 0x83, 'ä' to 0x84, 'à' to 0x85,
                'ç' to 0x87, 'ê' to 0x88, 'ë' to 0x89, 'è' to 0x8A, 'ï' to 0x8B, 'î' to 0x8C,
                'ì' to 0x8D, 'É' to 0x90, 'ô' to 0x93, 'ö' to 0x94, 'ò' to 0x95, 'û' to 0x96,
                'ù' to 0x97, 'Ö' to 0x99, 'Ü' to 0x9A, 'á' to 0xA0, 'í' to 0xA1, 'ó' to 0xA2,
                'ú' to 0xA3, 'ñ' to 0xA4, 'Ñ' to 0xA5, 'ª' to 0xA6, 'º' to 0xA7, 'Á' to 0xB5,
                'Â' to 0xB6, 'À' to 0xB7, 'ã' to 0xC6, 'Ã' to 0xC7, 'Ê' to 0xD2, 'Ë' to 0xD3,
                'È' to 0xD4, 'Í' to 0xD6, 'Î' to 0xD7, 'Ï' to 0xD8, 'Ó' to 0xE0, 'Ô' to 0xE2,
                'Ò' to 0xE3, 'õ' to 0xE4, 'Õ' to 0xE5, 'Ú' to 0xE9, 'Û' to 0xEA, 'Ù' to 0xEB,
                '°' to 0xF8,
            )

        private val CP860_TABLE =
            mapOf(
                'Ç' to 0x80, 'ü' to 0x81, 'é' to 0x82, 'â' to 0x83, 'ã' to 0x84, 'à' to 0x85,
                'Á' to 0x86, 'ç' to 0x87, 'ê' to 0x88, 'Ê' to 0x89, 'è' to 0x8A, 'Í' to 0x8B,
                'Ô' to 0x8C, 'ì' to 0x8D, 'Ã' to 0x8E, 'Â' to 0x8F, 'É' to 0x90, 'À' to 0x91,
                'È' to 0x92, 'ô' to 0x93, 'õ' to 0x94, 'ò' to 0x95, 'Ú' to 0x96, 'ù' to 0x97,
                'Ì' to 0x98, 'Õ' to 0x99, 'Ü' to 0x9A, 'Ó' to 0x9F, 'á' to 0xA0, 'í' to 0xA1,
                'ó' to 0xA2, 'ú' to 0xA3, 'ñ' to 0xA4, 'Ñ' to 0xA5, 'ª' to 0xA6, 'º' to 0xA7,
                'Ò' to 0xA9, '°' to 0xF8,
            )

        // CP437 cobre só parte do português. O que ela não representa precisa dobrar para ASCII;
        // os bytes deliberadamente crus da sonda histórica ficam em PrinterHomologationProbes.
        private val CP437_TABLE =
            mapOf(
                'Ç' to 0x80, 'ü' to 0x81, 'é' to 0x82, 'â' to 0x83, 'ä' to 0x84,
                'à' to 0x85, 'ç' to 0x87, 'ê' to 0x88, 'ë' to 0x89, 'è' to 0x8A,
                'ï' to 0x8B, 'î' to 0x8C, 'ì' to 0x8D, 'É' to 0x90, 'ô' to 0x93,
                'ö' to 0x94, 'ò' to 0x95, 'û' to 0x96, 'ù' to 0x97, 'ÿ' to 0x98,
                'Ö' to 0x99, 'Ü' to 0x9A, 'á' to 0xA0, 'í' to 0xA1, 'ó' to 0xA2,
                'ú' to 0xA3, 'ñ' to 0xA4, 'Ñ' to 0xA5, 'ª' to 0xA6, 'º' to 0xA7,
            )

        // CP866 é cirílica e não representa letras portuguesas acentuadas.
        private val CP866_TABLE = emptyMap<Char, Int>()

        private val CP1252_TABLE =
            buildMap {
                put('€', 0x80)
                for (code in 0xA0..0xFF) put(code.toChar(), code)
            }

        private val CP858_TABLE = CP850_TABLE + ('€' to 0xD5)
    }
}

/** ESC/POS puro enviado pelo socket TCP local, sem SDK de fornecedor e sem Logcat de payload. */
object EscPosThermalCommands {
    fun initialize(): ByteArray = byteArrayOf(ESC.toByte(), INITIALIZE.toByte())

    /**
     * Gera o pulso da porta de gaveta (`ESC p m t1 t2`), sem afirmar que ela abriu.
     *
     * A API recebe o número físico impresso no conector: pino 2 vira `m = 0` e pino 5 vira
     * `m = 1`. Os tempos são unidades ESC/POS de 2 ms. `Int` é deliberado para a validação
     * acontecer antes da conversão; truncar com [Int.toByte] faria um valor inválido chegar ao
     * transporte como outro pulso válido.
     */
    fun drawerKickPulse(
        pin: Int,
        onTime: Int,
        offTime: Int,
    ): ByteArray? {
        val connector =
            when (pin) {
                DRAWER_PIN_2 -> DRAWER_OUTPUT_1
                DRAWER_PIN_5 -> DRAWER_OUTPUT_2
                else -> return null
            }
        if (onTime !in BYTE_RANGE || offTime !in BYTE_RANGE) return null
        return byteArrayOf(
            ESC.toByte(),
            DRAWER_PULSE.toByte(),
            connector.toByte(),
            onTime.toByte(),
            offTime.toByte(),
        )
    }

    fun text(
        value: String,
        alignment: ThermalTextAlignment,
        style: ThermalTextStyle,
        size: Int,
        codePage: ThermalCodePage? = ThermalCodePage.CP850,
        codePageSelector: Int? = null,
        textEncoding: ThermalTextEncoding? = null,
    ): ByteArray {
        // `null` preserva a compatibilidade de fonte: chamadas antigas com página continuam em
        // byte único e chamadas antigas com `codePage = null` continuam dobrando para ASCII.
        val resolvedEncoding =
            textEncoding ?: if (codePage == null) ThermalTextEncoding.ASCII else ThermalTextEncoding.SINGLE_BYTE_CODE_PAGE
        require(resolvedEncoding.usesCodePage == (codePage != null)) {
            "Modelo de codificação e página de código incompatíveis."
        }
        require(resolvedEncoding == ThermalTextEncoding.SINGLE_BYTE_CODE_PAGE || codePageSelector == null) {
            "Seletor de página só existe quando o kit seleciona a página."
        }
        val encoded = encodeText(value, resolvedEncoding, codePage)
        val sizeByte = escPosTextSize(size)
        return output {
            // `ESC @` zera a página de código, então ela é reafirmada a cada bloco de texto.
            // UTF-8 e ASCII não veem `ESC t`. No fallback ASCII, mandar byte alto produz símbolo e
            // "Sao Joao" legível é melhor; no UTF-8, o acento segue em seus bytes Unicode.
            //
            // O endereço da página não é o mesmo em toda firmware. Medido na bancada: a T210
            // (`58E_BT`) atende a CP860 em `ESC t 8`, não no 3 canônico, e responde com tabela
            // tailandesa no `n` que a documentação reserva à CP1252. Por isso o perfil pode
            // carregar o seletor medido; sem medição, vale o canônico do enum.
            // `FIRMWARE_DEFAULT_PAGE` codifica pela mesma tabela e **não** emite `ESC t`: a
            // firmware já está na página certa, e selecionar seria trocar por outra.
            if (resolvedEncoding == ThermalTextEncoding.SINGLE_BYTE_CODE_PAGE) {
                val selectedPage = requireNotNull(codePage)
                write(ESC)
                write(SELECT_CODE_PAGE)
                write(codePageSelector ?: selectedPage.escPosValue)
            }
            write(ESC)
            write(ALIGN)
            write(alignment.escPosValue)
            write(ESC)
            write(BOLD)
            write(if (style == ThermalTextStyle.BOLD) ENABLED else DISABLED)
            // `GS !` só sai quando há tamanho para pedir. A MP-4200 TH não implementa esse comando
            // e engole apenas o `GS`: o `!` vai para o papel como texto, e na sonda de avanço saiu
            // "!0" no número e "!!Escolha" na instrução. Bloco em tamanho normal não precisa do
            // comando — `ESC @` já zera o tamanho, e todo bloco que amplia devolve a zero no fim,
            // então o estado continua conhecido sem sujar a linha de quem não entende `GS !`.
            if (sizeByte != DISABLED) {
                write(GS)
                write(TEXT_SIZE)
                write(sizeByte)
            }
            write(encoded)
            write(ESC)
            write(BOLD)
            write(DISABLED)
            if (sizeByte != DISABLED) {
                write(GS)
                write(TEXT_SIZE)
                write(DISABLED)
            }
        }
    }

    /** Variante tipada que não deixa bits reservados ou multiplicadores ignorados chegarem ao papel. */
    fun text(
        value: String,
        alignment: ThermalTextAlignment,
        style: ThermalTextStyle,
        size: ThermalTextSize,
        codePage: ThermalCodePage? = ThermalCodePage.CP850,
        codePageSelector: Int? = null,
        textEncoding: ThermalTextEncoding? = null,
    ): ByteArray = text(value, alignment, style, size.escPosValue, codePage, codePageSelector, textEncoding)

    /**
     * Rasteriza o QR antes do ESC/POS. Firmwares incompatíveis podem imprimir como texto o
     * payload de comandos QR nativos; a imagem contém apenas bits, nunca a URL/token literal.
     *
     * @param verticalRasterScale fator medido do perfil, ou `null` para não compensar nada. O QR
     *   passa pelo mesmo emissor da foto e sofre o mesmo encolhimento — um quadrado que sai 20%
     *   mais baixo é um QR achatado, e leitor nenhum promete ler isso. Ver
     *   [VERTICAL_RASTER_SCALE_RANGE].
     */
    fun qrRaster(
        value: String,
        widthDots: Int,
        errorCorrection: Int,
        verticalRasterScale: Double? = null,
    ): ByteArray? = qrRaster(value, widthDots, errorCorrection, verticalRasterScale, EscPosRasterEmission)

    /**
     * O mesmo QR, com o envelope de raster escolhido pelo dialeto.
     *
     * Sobrecarga **interna** de propósito: o símbolo e o empacotamento em bits são idênticos nos
     * dois dialetos, e só o envelope muda — mas [RasterEmission] é detalhe do kit, e a assinatura
     * pública acima continua exatamente como sempre foi.
     */
    internal fun qrRaster(
        value: String,
        widthDots: Int,
        errorCorrection: Int,
        verticalRasterScale: Double?,
        emission: RasterEmission,
    ): ByteArray? {
        if (
            value.isEmpty() ||
                value.length > MAX_QR_BYTES ||
                value.any { !isPrintableAscii(it.code) }
        ) {
            return null
        }
        if (widthDots !in MIN_QR_WIDTH_DOTS..MAX_QR_WIDTH_DOTS || widthDots % 8 != 0) return null
        if (errorCorrection !in MIN_QR_ERROR_CORRECTION..MAX_QR_ERROR_CORRECTION) return null
        val matrix =
            runCatching {
                QRCodeWriter().encode(
                    value,
                    BarcodeFormat.QR_CODE,
                    widthDots,
                    widthDots,
                    mapOf(
                        EncodeHintType.CHARACTER_SET to "ISO-8859-1",
                        EncodeHintType.ERROR_CORRECTION to qrErrorCorrection(errorCorrection),
                        EncodeHintType.MARGIN to QR_QUIET_ZONE_MODULES,
                    ),
                )
            }.getOrNull() ?: return null
        return emission.emit(
            object : OneBitRasterSource {
                override val widthDots = widthDots
                override val heightDots = widthDots

                override fun readStripe(
                    startY: Int,
                    stripeHeight: Int,
                    destination: ByteArray,
                ) {
                    val widthBytes = widthDots / 8
                    for (stripeY in 0 until stripeHeight) {
                        for (x in 0 until widthDots) {
                            if (matrix[x, startY + stripeY]) {
                                val index = stripeY * widthBytes + x / 8
                                destination[index] =
                                    (destination[index].toInt() or (0x80 shr (x % 8))).toByte()
                            }
                        }
                    }
                }
            },
            DEFAULT_RASTER_STRIPE_HEIGHT_DOTS,
            verticalRasterScale,
        )
    }

    /**
     * Desenha o código de barras em pontos e o emite pelo emissor `GS v 0` de sempre.
     *
     * Caminho cru, como [qrRaster]: sem perfil, sem página de código e sem legenda. Quem passa
     * número à mão precisa ouvir "não", então validação reprovada devolve `null` — largura de
     * módulo fora da faixa, altura fora da faixa, conteúdo que a simbologia não aceita, ou símbolo
     * que não cabe em [printableDots] com as duas zonas de silêncio da norma.
     *
     * **HRI não sai daqui.** A legenda precisa da página de código medida daquela impressora para
     * sair com o texto certo, e este emissor não tem perfil para consultar — pela mesma razão que
     * não tem fator para compensar. Quem emite a legenda é o layout, com `text(...)`.
     *
     * O bloco sai centralizado e **devolve** o alinhamento à esquerda no fim: `ESC a` é estado da
     * impressora, e o que viesse depois sairia centralizado sem ter pedido. O `ESC a 0` é escrito
     * aqui, e não no emissor raster, por dois motivos: mexer no emissor mudaria os bytes de
     * `qrRaster` e `imageRaster`, que estão homologados em papel; e o emissor iOS **já** devolve o
     * alinhamento, então é este acréscimo que faz as duas plataformas emitirem a mesma sequência
     * para o mesmo código de barras. A divergência do emissor em si é dívida antiga e não é desta
     * frente.
     *
     * @param verticalRasterScale fator medido do perfil, ou `null` para não compensar nada. Barra
     *   encolhida na vertical continua legível, mas a altura pedida é a altura que se quer no
     *   papel; ver [VERTICAL_RASTER_SCALE_RANGE].
     */
    fun barcodeRaster(
        value: String,
        symbology: ThermalBarcodeSymbology,
        moduleWidthDots: Int,
        heightDots: Int,
        printableDots: Int,
        verticalRasterScale: Double? = null,
    ): ByteArray? =
        barcodeRaster(
            value,
            symbology,
            moduleWidthDots,
            heightDots,
            printableDots,
            verticalRasterScale,
            EscPosRasterEmission,
        )

    /**
     * O mesmo código de barras, com o envelope de raster escolhido pelo dialeto.
     *
     * Sobrecarga **interna**, igual à de [qrRaster] e pelo mesmo motivo: os módulos e o
     * empacotamento em bits são idênticos nos dois dialetos, e só o envelope muda.
     *
     * **Este era o quarto caminho que compunha bytes sem consultar o dialeto**, e o último
     * conhecido. Os outros três morreram em 27/08/2026; este sobreviveu porque
     * `ReceiptLayout.barcode` chamava a assinatura pública acima — que fixa `GS v 0` — em vez de
     * passar o envelope do layout, como `qrRaster` já fazia ao lado. Um cupom Procomp com código de
     * barras rasterizado saía com faixas `GS v 0` numa firmware sem um único comando `GS`, mais um
     * `ESC a` que ela também não tem. Achado pelo lote C41 ao portar o dialeto para o Swift.
     */
    internal fun barcodeRaster(
        value: String,
        symbology: ThermalBarcodeSymbology,
        moduleWidthDots: Int,
        heightDots: Int,
        printableDots: Int,
        verticalRasterScale: Double?,
        emission: RasterEmission,
    ): ByteArray? {
        if (moduleWidthDots !in ThermalBarcode.MODULE_WIDTH_DOTS_RANGE) return null
        if (heightDots !in ThermalBarcode.HEIGHT_DOTS_RANGE) return null
        if (printableDots !in ThermalBarcode.PRINTABLE_DOTS_RANGE || printableDots % 8 != 0) return null
        val modules = ThermalBarcode.modules(value, symbology) ?: return null
        val totalModules =
            symbology.quietZoneModulesStart + modules.size + symbology.quietZoneModulesEnd
        val contentDots = totalModules * moduleWidthDots
        if (contentDots > printableDots) return null
        // O `GS v 0` empacota oito pontos por byte, então a linha sobe para o múltiplo de 8
        // seguinte. A sobra é zona clara, e ela é dividida entre os dois lados para o símbolo
        // continuar no centro exato do bloco que o `ESC a 1` centraliza.
        val widthDots = (contentDots + RASTER_BITS_PER_BYTE - 1) / RASTER_BITS_PER_BYTE * RASTER_BITS_PER_BYTE
        val leftPadding = (widthDots - contentDots) / 2 + symbology.quietZoneModulesStart * moduleWidthDots
        val widthBytes = widthDots / RASTER_BITS_PER_BYTE
        // Código de barras é uma linha extrudada: todas as linhas são a mesma, então a linha é
        // empacotada uma vez e repetida em cada faixa.
        val row = ByteArray(widthBytes)
        modules.forEachIndexed { index, black ->
            if (!black) return@forEachIndexed
            for (dot in 0 until moduleWidthDots) {
                val x = leftPadding + index * moduleWidthDots + dot
                row[x / RASTER_BITS_PER_BYTE] =
                    (
                        row[x / RASTER_BITS_PER_BYTE].toInt() or
                            (0x80 shr (x % RASTER_BITS_PER_BYTE))
                    ).toByte()
            }
        }
        if (!emission.addressesWidth(widthDots)) return null
        val raster =
            emission.emit(
                object : OneBitRasterSource {
                    override val widthDots = widthDots
                    override val heightDots = heightDots

                    override fun readStripe(
                        startY: Int,
                        stripeHeight: Int,
                        destination: ByteArray,
                    ) {
                        for (stripeY in 0 until stripeHeight) {
                            row.copyInto(destination, destinationOffset = stripeY * widthBytes)
                        }
                    }
                },
                DEFAULT_RASTER_STRIPE_HEIGHT_DOTS,
                verticalRasterScale,
            )
        return raster + emission.restoreAlignment()
    }

    /**
     * Pede o código de barras à firmware (`GS k`), sem afirmar que ela sabe desenhá-lo.
     *
     * Nada aqui infere capacidade: a função monta bytes. Quem decide se este caminho pode ser usado
     * é a capacidade medida pela sonda, numa camada acima — firmware que não entende `GS k`
     * imprime o payload como texto legível, e é por isso que a decisão não pode ser um palpite.
     *
     * O símbolo é o mesmo do [barcodeRaster] para o mesmo conteúdo: a régua de módulos é uma só, e
     * no Code 128 as trocas de conjunto viajam nos escapes `{A {B {C` exatamente onde o desenho as
     * colocou. Muda só quem desenha os módulos.
     *
     * `GS H` e `GS f` saem sempre, mesmo com [humanReadable] falso: o nativo é estado, a impressora
     * pode ter ficado com outra fonte de um cupom anterior, e o mesmo conteúdo tem de dar os mesmos
     * bytes independentemente do que veio antes.
     */
    fun barcodeNative(
        value: String,
        symbology: ThermalBarcodeSymbology,
        moduleWidthDots: Int,
        heightDots: Int,
        humanReadable: Boolean,
    ): ByteArray? {
        if (moduleWidthDots !in ThermalBarcode.MODULE_WIDTH_DOTS_RANGE) return null
        if (heightDots !in ThermalBarcode.HEIGHT_DOTS_RANGE) return null
        val data = ThermalBarcode.nativeData(value, symbology) ?: return null
        return output {
            write(ESC)
            write(ALIGN)
            write(ThermalTextAlignment.CENTER.escPosValue)
            write(GS)
            write(BARCODE_HEIGHT)
            write(heightDots)
            write(GS)
            write(BARCODE_MODULE_WIDTH)
            write(moduleWidthDots)
            write(GS)
            write(BARCODE_HRI_POSITION)
            write(if (humanReadable) HRI_BELOW else HRI_NONE)
            write(GS)
            write(BARCODE_HRI_FONT)
            write(HRI_FONT_A)
            // Função B do `GS k`, com contagem explícita: a função A termina em `NUL` e não sabe
            // dizer que o dado tinha um zero dentro — e no conjunto C do Code 128 ele tem.
            write(GS)
            write(BARCODE_PRINT)
            write(symbology.nativeSelector)
            write(data.size)
            write(data)
            write(ESC)
            write(ALIGN)
            write(ThermalTextAlignment.LEFT.escPosValue)
        }
    }

    /**
     * Pede o QR à firmware (`GS ( k`), sem afirmar que ela sabe desenhá-lo.
     *
     * **Este caminho nunca serve a QR protegido.** Firmware que não entende o comando imprime o
     * payload como texto legível no papel, e uma assinatura de capacidade impressa é uma assinatura
     * copiável. Carga protegida continua obrigatoriamente em [qrRaster].
     *
     * O teto de [ThermalBarcode.QR_NATIVE_MAX_BYTES] é o menor dos dois tetos de raster que o kit
     * publica, de propósito: quando a capacidade medida não existe, o layout cai para o raster, e
     * um payload que só o nativo aceitasse falharia exatamente na hora da queda.
     *
     * @param errorCorrection os mesmos códigos de pedido do [qrRaster]: 1=L, 2=M, 3=Q, 4=H.
     */
    fun qrNative(
        value: String,
        moduleSizeDots: Int,
        errorCorrection: Int,
    ): ByteArray? {
        if (value.isEmpty() || value.length > ThermalBarcode.QR_NATIVE_MAX_BYTES) return null
        if (value.any { !isPrintableAscii(it.code) }) return null
        if (moduleSizeDots !in ThermalBarcode.QR_NATIVE_MODULE_SIZE_DOTS_RANGE) return null
        if (errorCorrection !in ThermalBarcode.QR_NATIVE_ERROR_CORRECTION_RANGE) return null
        val payload = value.toByteArray(StandardCharsets.US_ASCII)
        // `pL pH` contam os três bytes de cabeçalho da função (`31 50 30`) junto com o dado.
        val storeLength = payload.size + QR_STORE_HEADER_SIZE
        return output {
            write(ESC)
            write(ALIGN)
            write(ThermalTextAlignment.CENTER.escPosValue)
            // Função 167: tamanho do módulo.
            qrSelect(3)
            write(QR_FUNCTION_MODULE_SIZE)
            write(moduleSizeDots)
            // Função 169: nível de correção, `48 + nível`, com o nível contado de zero.
            qrSelect(3)
            write(QR_FUNCTION_ERROR_CORRECTION)
            write(QR_ERROR_CORRECTION_BASE + errorCorrection - 1)
            // Função 180: armazenar os dados no símbolo.
            qrSelect(storeLength)
            write(QR_FUNCTION_STORE)
            write(QR_FUNCTION_STORE_SUFFIX)
            write(payload)
            // Função 181: imprimir o que foi armazenado.
            qrSelect(3)
            write(QR_FUNCTION_PRINT)
            write(QR_FUNCTION_PRINT_SUFFIX)
            write(ESC)
            write(ALIGN)
            write(ThermalTextAlignment.LEFT.escPosValue)
        }
    }

    /**
     * Quantos módulos tem o lado do QR deste payload, **sem** zona de silêncio.
     *
     * É o que permite "codificar para medir": nem o `GS ( k` nem o `GS v 0` recebem largura em
     * pontos, e sem a contagem o tamanho de módulo seria chute. Devolve `null` quando o payload não
     * cabe em símbolo nenhum.
     *
     * Consulta o **mesmo** codificador que o [qrRaster] deste lado usa, e não uma tabela paralela:
     * duas contas do mesmo número são o jeito de uma delas envelhecer sozinha. Consequência que
     * vale registrar: o QR já diverge entre as duas plataformas por acidente histórico, e esta
     * função herda a divergência em vez de escondê-la.
     */
    fun qrModuleSide(
        value: String,
        errorCorrection: Int,
    ): Int? {
        if (value.isEmpty() || value.length > ThermalBarcode.QR_NATIVE_MAX_BYTES) return null
        if (value.any { !isPrintableAscii(it.code) }) return null
        if (errorCorrection !in ThermalBarcode.QR_NATIVE_ERROR_CORRECTION_RANGE) return null
        return runCatching {
            QrEncoder.encode(
                value,
                qrErrorCorrection(errorCorrection),
                mapOf(EncodeHintType.CHARACTER_SET to "ISO-8859-1"),
            ).matrix?.width
        }.getOrNull()
    }

    /** Cabeçalho `GS ( k pL pH 31` comum às quatro funções de QR. */
    private fun ByteArrayOutputStream.qrSelect(length: Int) {
        write(GS)
        write(QR_SELECT)
        write(QR_SELECT_KIND)
        write(length and 0xff)
        write(length shr 8 and 0xff)
        write(QR_SYMBOL_GROUP)
    }

    /**
     * Avanço em quebras de linha, não em `ESC d n`.
     *
     * A MP-4200 TH ignora o `ESC d`: na sonda de avanço as oito tiras saíram do mesmo tamanho, de
     * zero a doze, e a medida que o perfil grava não mudava nada no papel. `LF` não tem como ser
     * ignorado por quem imprime texto — é ele que separa as linhas do próprio cupom, e a Bematech
     * imprime as linhas. Em firmware que atende os dois, `n` quebras avançam exatamente o mesmo
     * que `ESC d n`, então quem já estava certo não muda.
     */
    fun advance(lines: Int): ByteArray? =
        lines.takeIf { it in 0..MAX_FEED_LINES }?.let {
            output { repeat(it) { write(LINE_FEED) } }
        }

    /**
     * Avança e corta, no dialeto que **esta** impressora entende.
     *
     * O comando é da impressora, não do padrão: a Bematech MP-4200 TH fala ESC/POS compatível em
     * tudo o mais e ignora o `GS V`. Descoberto em papel pela `CutCommandProbe` — a documentação não
     * responde isso, e adivinhar por modelo já falhou uma vez com a página de código.
     *
     * O avanço vem antes do corte em qualquer dialeto: guilhotina em cima da última linha impressa
     * arranca o próprio texto.
     */
    fun cut(lines: Int, protocol: CutProtocol): ByteArray? =
        lines.takeIf { it in 0..MAX_FEED_LINES && protocol != CutProtocol.NONE }?.let {
            output {
                if (protocol !in MeasuredProfile.CUTS_WITH_EMBEDDED_FEED) {
                    // Mesmo motivo de `advance`: a MP-4200 ignora `ESC d` e o avanço medido não
                    // chegava ao papel. As variantes 65/66 não entram aqui porque já carregam o
                    // próprio avanço dentro do comando de corte.
                    repeat(it) { write(LINE_FEED) }
                }
                when (protocol) {
                    CutProtocol.GS_V_0 -> {
                        write(GS)
                        write(CUT)
                        write(TOTAL_CUT)
                    }
                    CutProtocol.GS_V -> {
                        write(GS)
                        write(CUT)
                        write(PARTIAL_CUT)
                    }
                    CutProtocol.GS_V_1 -> {
                        write(GS)
                        write(CUT)
                        write(PARTIAL_CUT)
                    }
                    CutProtocol.GS_V_65 -> {
                        // O avanço 0x50 pertence ao próprio comando medido; nunca somar `ESC d`.
                        write(GS)
                        write(CUT)
                        write(CUT_AND_FEED_TOTAL)
                        write(MEASURED_EMBEDDED_FEED)
                    }
                    CutProtocol.GS_V_66 -> {
                        write(GS)
                        write(CUT)
                        write(CUT_AND_FEED_PARTIAL)
                        write(MEASURED_EMBEDDED_FEED)
                    }
                    CutProtocol.ESC_I -> {
                        write(ESC)
                        write(OLD_TOTAL_CUT)
                    }
                    // `ESC m`: parcial no dialeto antigo.
                    CutProtocol.ESC_M -> {
                        write(ESC)
                        write(OLD_PARTIAL_CUT)
                    }
                    CutProtocol.NONE -> Unit
                }
            }
        }

    private fun escPosTextSize(size: Int): Int {
        require(size in 0..0xff) { "Tamanho de texto ESC/POS inválido." }
        require(size and RESERVED_TEXT_SIZE_BITS == 0) {
            "Tamanho de texto usa multiplicador que a firmware ignora."
        }
        val height = size and HEIGHT_MASK
        val width = (size shr WIDTH_SHIFT) and HEIGHT_MASK
        return (width shl WIDTH_SHIFT) or height
    }

    private fun qrErrorCorrection(level: Int): ErrorCorrectionLevel =
        when (level) {
            QR_LEVEL_L_REQUEST -> ErrorCorrectionLevel.L
            QR_LEVEL_M_REQUEST -> ErrorCorrectionLevel.M
            QR_LEVEL_Q_REQUEST -> ErrorCorrectionLevel.Q
            QR_LEVEL_H_REQUEST -> ErrorCorrectionLevel.H
            else -> error("Validação de correção QR ausente.")
        }

    /**
     * Converte o texto para os bytes da p\u00e1gina de c\u00f3digo.
     *
     * Normaliza em NFC (composto) porque a tabela mapeia `\u00e9`, n\u00e3o `e` + acento combinante. O que a
     * p\u00e1gina n\u00e3o representa cai no dobramento antigo para ASCII \u2014 assim um caractere inesperado
     * vira `?` em vez de sair como byte aleat\u00f3rio, mas "\u00e7\u00e3o" continua saindo "\u00e7\u00e3o".
     */
    private fun encodeText(
        value: String,
        textEncoding: ThermalTextEncoding,
        codePage: ThermalCodePage?,
    ): ByteArray {
        if (textEncoding == ThermalTextEncoding.UTF_8) {
            val sanitized =
                buildString {
                    Normalizer.normalize(value, Normalizer.Form.NFC).forEach { character ->
                        when {
                            character == '\n' -> append(character)
                            character == '\r' -> Unit
                            character.isISOControl() && character.isWhitespace() -> append(' ')
                            character.isISOControl() -> append('?')
                            else -> append(character)
                        }
                    }
                }
            return sanitized.toByteArray(StandardCharsets.UTF_8)
        }
        val normalized = Normalizer.normalize(value, Normalizer.Form.NFC)
        return output {
            normalized.forEach { character ->
                val mapped = codePage?.encode(character)
                when {
                    character == '\n' -> write('\n'.code)
                    character == '\r' -> Unit
                    character == '\u2013' || character == '\u2014' || character == '\u2212' ->
                        write('-'.code)
                    isPrintableAscii(character.code) -> write(character.code)
                    mapped != null -> write(mapped)
                    else -> asciiFold(character)
                }
            }
        }
    }

    /** Rede de seguran\u00e7a: derruba o acento e, se nem isso resolver, vira `?`. */
    private fun ByteArrayOutputStream.asciiFold(character: Char) {
        val decomposed = Normalizer.normalize(character.toString(), Normalizer.Form.NFD)
        var wrote = false
        decomposed.forEach { part ->
            when {
                isPrintableAscii(part.code) -> {
                    write(part.code)
                    wrote = true
                }
                Character.getType(part) == Character.NON_SPACING_MARK.toInt() -> Unit
                part.isWhitespace() -> {
                    write(' '.code)
                    wrote = true
                }
                else -> Unit
            }
        }
        if (!wrote) write('?'.code)
    }

    private fun output(block: ByteArrayOutputStream.() -> Unit): ByteArray =
        ByteArrayOutputStream().use { stream ->
            stream.block()
            stream.toByteArray()
        }

    private fun isPrintableAscii(code: Int): Boolean = code in PRINTABLE_ASCII_MIN..PRINTABLE_ASCII_MAX

    private const val ESC = 0x1b
    private const val INITIALIZE = 0x40
    private const val DRAWER_PULSE = 0x70
    private const val DRAWER_PIN_2 = 2
    private const val DRAWER_PIN_5 = 5
    private const val DRAWER_OUTPUT_1 = 0
    private const val DRAWER_OUTPUT_2 = 1
    private const val GS = 0x1d
    private const val ALIGN = 0x61

    /** `ESC t n` — escolhe a página de código do texto. */
    private const val SELECT_CODE_PAGE = 0x74

    private const val BOLD = 0x45
    private const val TEXT_SIZE = 0x21
    private const val FEED = 0x64
    private const val LINE_FEED = 0x0A
    private const val CUT = 0x56

    /**
     * Corte **parcial**, e não total, nos dois dialetos.
     *
     * Numa sequência de cinco cupons, o corte total deixa as tiras soltas na bancada, onde podem
     * encavalar. O parcial mantém cada tira presa por um filete até a entrega.
     */
    private const val PARTIAL_CUT = 1
    private const val TOTAL_CUT = 0
    private const val CUT_AND_FEED_TOTAL = 0x41
    private const val CUT_AND_FEED_PARTIAL = 0x42
    private const val MEASURED_EMBEDDED_FEED = 0x50
    private const val OLD_TOTAL_CUT = 0x69
    private const val OLD_PARTIAL_CUT = 0x6d
    private const val ENABLED = 1
    private const val DISABLED = 0
    private const val MIN_QR_WIDTH_DOTS = 160
    private const val MAX_QR_WIDTH_DOTS = 512
    private const val QR_QUIET_ZONE_MODULES = 4
    private const val QR_LEVEL_L_REQUEST = 1
    private const val QR_LEVEL_M_REQUEST = 2
    private const val QR_LEVEL_Q_REQUEST = 3
    private const val QR_LEVEL_H_REQUEST = 4
    private const val MIN_QR_ERROR_CORRECTION = QR_LEVEL_L_REQUEST
    private const val MAX_QR_ERROR_CORRECTION = QR_LEVEL_H_REQUEST
    private const val MAX_QR_BYTES = 7_089
    private const val MAX_FEED_LINES = 255
    private val BYTE_RANGE = 0..255
    private const val HEIGHT_MASK = 0x0f
    private const val WIDTH_SHIFT = 4
    /** Bit 3 de cada nibble pediria 9–16 vezes; `GS !` só define multiplicadores de 1 a 8. */
    private const val RESERVED_TEXT_SIZE_BITS = 0x88
    private const val PRINTABLE_ASCII_MIN = 0x20
    private const val PRINTABLE_ASCII_MAX = 0x7e

    /** Republicado do emissor raster: é a mesma conta de empacotamento, e um número só. */
    private const val RASTER_BITS_PER_BYTE = EscPosRasterEmitter.BITS_PER_BYTE

    /** `GS h n` — altura da barra em pontos. */
    private const val BARCODE_HEIGHT = 0x68

    /** `GS w n` — largura do módulo em pontos. */
    private const val BARCODE_MODULE_WIDTH = 0x77

    /** `GS H n` — onde sai a legenda: 0 em lugar nenhum, 2 abaixo das barras. */
    private const val BARCODE_HRI_POSITION = 0x48
    private const val HRI_NONE = 0
    private const val HRI_BELOW = 2

    /** `GS f n` — fonte da legenda; 0 é a fonte A. */
    private const val BARCODE_HRI_FONT = 0x66
    private const val HRI_FONT_A = 0

    /** `GS k m n d1…dn` — a função B, com contagem explícita. */
    private const val BARCODE_PRINT = 0x6b

    /** `GS ( k` — o grupo de comandos de símbolo bidimensional. */
    private const val QR_SELECT = 0x28
    private const val QR_SELECT_KIND = 0x6b

    /** `cn = 49`: dentro do grupo, a família do QR Code. */
    private const val QR_SYMBOL_GROUP = 0x31

    /** Função 167 (`43`): tamanho do módulo em pontos. */
    private const val QR_FUNCTION_MODULE_SIZE = 0x43

    /** Função 169 (`45`): nível de correção de erro. */
    private const val QR_FUNCTION_ERROR_CORRECTION = 0x45

    /** Função 180 (`50 30`): armazena o dado na área de símbolo. */
    private const val QR_FUNCTION_STORE = 0x50
    private const val QR_FUNCTION_STORE_SUFFIX = 0x30

    /** Função 181 (`51 30`): imprime o que foi armazenado. */
    private const val QR_FUNCTION_PRINT = 0x51
    private const val QR_FUNCTION_PRINT_SUFFIX = 0x30

    /** Nível L é `48`, e o pedido do kit conta de um. */
    private const val QR_ERROR_CORRECTION_BASE = 48

    /** `cn`, `fn` e o sufixo `30` entram na contagem de `pL pH` junto com o dado. */
    private const val QR_STORE_HEADER_SIZE = 3
}
