package br.com.thermalprinterkit

/**
 * Fonte monocromática consumida em ordem, uma faixa por vez.
 *
 * A conversão de imagem da plataforma implementa esta fronteira; o emissor abaixo só conhece
 * pontos pretos e bytes ESC/POS. Isso mantém a regressão de protocolo testável sem `Bitmap`.
 */
internal interface OneBitRasterSource {
    val widthDots: Int
    val heightDots: Int

    /** Preenche [destination] com linhas empacotadas, bit mais significativo primeiro. */
    fun readStripe(
        startY: Int,
        stripeHeight: Int,
        destination: ByteArray,
    )
}

/**
 * Altura de banda `GS v 0` de sempre, e o que ela significa em papel.
 *
 * Vinte e quatro linhas é o que toda foto de venda usa desde o M1, e é o número que continua saindo
 * quando ninguém pede outro. Ele **não** é neutro: uma banda de 24 linhas em largura cheia de 58 mm
 * tem 1.152 bytes, e a 0,6 KB/s — a vazão medida na T210 em 20/08 — leva perto de dois segundos
 * pingando de vinte em vinte bytes. Firmware que abandona a banda quando a recepção demora demais
 * perde linha inteira; banda menor termina antes.
 *
 * Por isso o parâmetro existe, e por isso o padrão não muda: descobrir se a inanição é a causa exige
 * poder emitir a mesma imagem em bandas menores, e provar não é decidir.
 */
const val DEFAULT_RASTER_STRIPE_HEIGHT_DOTS = 24

/**
 * O que o emissor aceita como altura de banda.
 *
 * O teto é o padrão porque acima dele não há pergunta a fazer: banda maior só piora a hipótese que
 * se está medindo, e o protocolo já aceita a altura inteira num comando só sem que isso conserte
 * nada — medido em 20/08, em que uma banda única de 120 dots e quinze bandas de oito deram os mesmos
 * 15,0 mm.
 */
val RASTER_STRIPE_HEIGHT_RANGE: IntRange = 1..DEFAULT_RASTER_STRIPE_HEIGHT_DOTS

/**
 * Faixa aceita para o fator de compensação vertical de raster.
 *
 * O fator é **o que sai do papel dividido pelo que foi declarado**: a Inico T210 medida em 20/08
 * imprime 0,80 de toda altura de raster largo que recebe. O teto é 1,0 porque acima disso não há
 * defeito a compensar — firmware que imprime mais alto do que se pediu nunca apareceu na bancada, e
 * aceitar esse número faria a compensação **encolher** a imagem de propósito. O piso de 0,5 é o
 * limite do absurdo: abaixo dele a imagem dobraria de altura, e o que está errado é a medida.
 *
 * Pública porque quem oferece um campo para o valor precisa recusá-lo **antes** de montar um perfil
 * que só falharia na hora de salvar — a mesma razão de [RASTER_BYTES_PER_SECOND_RANGE].
 */
val VERTICAL_RASTER_SCALE_RANGE: ClosedFloatingPointRange<Double> = 0.5..1.0

/**
 * Quantas linhas precisam ser enviadas para [heightDots] saírem no papel, com [scale] medido.
 *
 * Fator 0,80 e 800 linhas pretendidas dão 1.000 enviadas: a impressora imprime 80% delas, e o que
 * sai do papel é a altura que se queria. A conta é arredondada, nunca truncada, e nunca devolve
 * menos que a altura pretendida — fator 1,0 devolve exatamente ela, e é assim que "sem compensação"
 * e "compensação neutra" coincidem byte a byte.
 */
internal fun compensatedRasterHeightDots(
    heightDots: Int,
    scale: Double,
): Int = Math.round(heightDots / scale).coerceAtLeast(heightDots.toLong()).toInt()

/** Único emissor `GS v 0`: QR e imagem arbitrária passam por esta implementação. */
internal object EscPosRasterEmitter {
    /**
     * @param stripeHeightDots quantas linhas cabem em cada comando `GS v 0`. O padrão é o de sempre,
     *   e passar outro valor é medição de bancada, nunca configuração de produto.
     * @param verticalRasterScale fator medido desta impressora, ou `null` para não compensar nada.
     *   Com fator, a fonte é reamostrada na vertical **antes** de virar raster; ver
     *   [VerticallyStretchedRasterSource]. Sem fator, os bytes são exatamente os de sempre.
     */
    fun emit(
        source: OneBitRasterSource,
        stripeHeightDots: Int = DEFAULT_RASTER_STRIPE_HEIGHT_DOTS,
        verticalRasterScale: Double? = null,
    ): ByteArray {
        require(
            verticalRasterScale == null || verticalRasterScale in VERTICAL_RASTER_SCALE_RANGE,
        ) { "Fator de compensação vertical inválido." }
        require(stripeHeightDots in RASTER_STRIPE_HEIGHT_RANGE) { "Altura de banda raster inválida." }
        val stretched =
            verticalRasterScale
                ?.let { compensatedRasterHeightDots(source.heightDots, it) }
                ?.takeIf { it > source.heightDots }
                ?.let { VerticallyStretchedRasterSource(source, it, stripeHeightDots) }
        if (stretched == null) return emitStripes(source, stripeHeightDots)
        try {
            return emitStripes(stretched, stripeHeightDots)
        } finally {
            stretched.clear()
        }
    }

    private fun emitStripes(
        source: OneBitRasterSource,
        stripeHeightDots: Int,
    ): ByteArray {
        require(source.widthDots > 0 && source.widthDots % BITS_PER_BYTE == 0) {
            "Largura raster inválida."
        }
        require(source.heightDots > 0) { "Altura raster inválida." }
        val widthBytes = source.widthDots / BITS_PER_BYTE
        require(widthBytes <= MAX_UNSIGNED_SHORT) { "Largura raster excede o protocolo ESC/POS." }

        val stripeCount =
            (source.heightDots.toLong() + stripeHeightDots - 1) / stripeHeightDots
        val commandSize =
            ALIGNMENT_COMMAND_SIZE.toLong() +
                stripeCount * RASTER_HEADER_SIZE +
                widthBytes.toLong() * source.heightDots
        require(commandSize <= Int.MAX_VALUE) { "Imagem raster grande demais para o cupom." }

        val command = ByteArray(commandSize.toInt())
        var offset = 0
        try {
            command[offset++] = ESC
            command[offset++] = ALIGN
            command[offset++] = CENTER
            for (startY in 0 until source.heightDots step stripeHeightDots) {
                val stripeHeight = minOf(stripeHeightDots, source.heightDots - startY)
                val pixels = ByteArray(widthBytes * stripeHeight)
                try {
                    source.readStripe(startY, stripeHeight, pixels)
                    command[offset++] = GS
                    command[offset++] = RASTER_IMAGE
                    command[offset++] = RASTER_FUNCTION
                    command[offset++] = RASTER_MODE_NORMAL
                    command[offset++] = (widthBytes and 0xff).toByte()
                    command[offset++] = (widthBytes shr 8 and 0xff).toByte()
                    command[offset++] = (stripeHeight and 0xff).toByte()
                    command[offset++] = (stripeHeight shr 8 and 0xff).toByte()
                    pixels.copyInto(command, destinationOffset = offset)
                    offset += pixels.size
                } finally {
                    pixels.fill(0)
                }
            }
            check(offset == command.size) { "Emissão raster incompleta." }
            return command
        } catch (error: Throwable) {
            command.fill(0)
            throw error
        }
    }

    /** O padrão, republicado aqui porque é por este nome que o kit inteiro já o chamava. */
    internal const val RASTER_STRIPE_HEIGHT_DOTS = DEFAULT_RASTER_STRIPE_HEIGHT_DOTS

    internal const val BITS_PER_BYTE = 8
    /**
     * Quantos bytes de largura o cabecalho do `GS v 0` endereca — dois bytes, sem sinal.
     *
     * Deixou de ser privado em 27/08/2026: [RasterEmission.addressesWidth] precisa dele para
     * responder pela largura do ENVELOPE, e um segundo literal com o mesmo numero foi como o teto do
     * ESC/POS acabou aplicado ao `ESC n` do Procomp.
     */
    internal const val MAX_WIDTH_BYTES = 0xffff

    private const val MAX_UNSIGNED_SHORT = MAX_WIDTH_BYTES
    private const val ALIGNMENT_COMMAND_SIZE = 3
    private const val RASTER_HEADER_SIZE = 8
    private const val ESC: Byte = 0x1b
    private const val ALIGN: Byte = 0x61
    private const val CENTER: Byte = 0x01
    private const val GS: Byte = 0x1d
    private const val RASTER_IMAGE: Byte = 0x76
    private const val RASTER_FUNCTION: Byte = 0x30
    private const val RASTER_MODE_NORMAL: Byte = 0x00
}

/**
 * Fonte reamostrada na vertical por **repetição de linha**, para compensar firmware que encolhe.
 *
 * **O defeito que ela existe para pagar.** Medido em 20/08 no A07, por BLE: a mesma imagem de
 * 384x800 — 45,7 KB confirmados na telemetria dos dois lados — sai com 97 mm na GoldenSky MTP-II e
 * com 80 mm na Inico T210. Cobertura de tinta, vazão, altura de banda, MTU, modo de escrita e
 * emenda entre bandas foram eliminados por medição, um a um; o que sobra é a firmware da T210
 * imprimindo raster largo por um fator constante. Constante quer dizer compensável: mandar
 * `1/fator` linhas devolve ao papel a altura pretendida.
 *
 * **Por que repetição de linha, e não interpolação.** Uma linha repetida é previsível: o mesmo par
 * (imagem, fator) dá os mesmos bytes em Android e iOS, e o mapeamento é aritmética inteira que a
 * suíte confere sem depender de arredondamento de ponto flutuante das duas plataformas. Interpolar
 * daria uma imagem visualmente mais suave e um resultado que só se confere olhando — e o que
 * importa aqui é altura, não suavidade. Em papel térmico de 8 dots/mm, uma linha duplicada a cada
 * quatro é um degrau de 0,125 mm.
 *
 * **A ordem é preservada.** As fontes de imagem convertem por faixa e exigem leitura sequencial —
 * o Floyd–Steinberg carrega o erro de uma linha para a seguinte. Esta fonte lê a de baixo em blocos
 * do tamanho da banda, na ordem, e repete linhas do bloco corrente; nenhuma linha de origem é lida
 * duas vezes.
 */
// `internal` e nao `private`: o emissor Procomp reusa exatamente esta reamostragem. Duas
// implementacoes da mesma compensacao divergiriam no papel, que e onde ninguem ve o diff.
internal class VerticallyStretchedRasterSource(
    private val source: OneBitRasterSource,
    override val heightDots: Int,
    private val readChunkDots: Int,
) : OneBitRasterSource {
    override val widthDots: Int = source.widthDots

    private val widthBytes = source.widthDots / EscPosRasterEmitter.BITS_PER_BYTE
    private var chunk = ByteArray(0)
    private var chunkStartY = 0
    private var nextSourceY = 0
    private var nextStartY = 0

    init {
        require(heightDots >= source.heightDots) { "Altura compensada menor que a pretendida." }
    }

    override fun readStripe(
        startY: Int,
        stripeHeight: Int,
        destination: ByteArray,
    ) {
        require(startY == nextStartY) { "Faixas raster precisam ser convertidas em ordem." }
        require(stripeHeight in 1..heightDots - startY) { "Altura de faixa raster inválida." }
        require(destination.size == widthBytes * stripeHeight) { "Buffer de faixa raster inválido." }
        for (row in 0 until stripeHeight) {
            val sourceY = sourceRowOf(startY + row)
            while (sourceY >= chunkStartY + chunk.size / widthBytes) readNextChunk()
            val offset = (sourceY - chunkStartY) * widthBytes
            chunk.copyInto(
                destination,
                destinationOffset = row * widthBytes,
                startIndex = offset,
                endIndex = offset + widthBytes,
            )
        }
        nextStartY += stripeHeight
    }

    /** Zera o bloco em memória: ele carrega conteúdo do usuário, como toda faixa deste caminho. */
    fun clear() {
        chunk.fill(0)
        chunk = ByteArray(0)
    }

    /**
     * Qual linha de origem sai nesta linha do papel.
     *
     * Aritmética inteira de propósito: é o que faz as duas plataformas emitirem os mesmos bytes
     * para a mesma imagem e o mesmo fator. Monotônica e sobrejetora enquanto a altura só cresce,
     * então nenhuma linha da origem é pulada e nenhuma é lida fora de ordem.
     */
    private fun sourceRowOf(outputY: Int): Int =
        (outputY.toLong() * source.heightDots / heightDots)
            .toInt()
            .coerceIn(0, source.heightDots - 1)

    private fun readNextChunk() {
        val height = minOf(readChunkDots, source.heightDots - nextSourceY)
        check(height > 0) { "A fonte raster acabou antes da altura compensada." }
        val next = ByteArray(widthBytes * height)
        source.readStripe(nextSourceY, height, next)
        chunk.fill(0)
        chunk = next
        chunkStartY = nextSourceY
        nextSourceY += height
    }
}
