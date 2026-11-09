package br.com.thermalprinterkit

/**
 * A conversão de imagem para pontos pretos, **uma vez só**, para Android e para a JVM de mesa.
 *
 * Antes desta frente, luminância, difusão de erro e empacotamento de bits viviam dentro de
 * `BitmapOneBitRasterSource`, privado do arquivo Android, e o desktop devolvia `null`. Fechar
 * aquele buraco tinha dois caminhos: reescrever a conversão do outro lado e guardá-la com um
 * corpus de paridade, ou subir a conversão para cá e deixar na plataforma só o acesso a pixel.
 * O segundo foi o escolhido, e a razão é a mesma do módulo `:core-jvm`: **os bytes ESC/POS não
 * podem divergir entre Android e Windows**, e paridade guardada por corpus é paridade que só se
 * descobre quebrada depois de quebrar. Aqui os bytes batem por construção.
 *
 * **O que NÃO subiu, e por quê.** A reamostragem continua na plataforma. O Android desenha a
 * faixa com `Canvas.drawBitmap` + `FILTER_BITMAP_FLAG`, ou seja, com o filtro do Skia — e o
 * caminho de imagem do Android está homologado em papel. Uma reamostragem escrita aqui teria de
 * render o MESMO pixel que o Skia rende, e isso não é escolha de API: é medição que ninguém fez.
 * Reamostragem que diverge é pior que reamostragem duplicada, porque a difusão de erro amplifica
 * um pixel diferente por uma linha inteira. Então a plataforma entrega pixels prontos por
 * [RasterStripePixelReader] e este arquivo nunca escolhe uma amostra.
 *
 * O que subiu, e que é o essencial: os pesos de luminância, o limiar, o Floyd–Steinberg com o
 * acumulador atravessando a emenda entre bandas, o empacotamento MSB-first, a centralização no
 * byte e a geometria de saída.
 */

/**
 * Quanto da imagem cabe no papel e onde ela fica dentro do byte.
 *
 * Aritmética inteira de ponta a ponta, de propósito: é a mesma razão da reamostragem vertical do
 * emissor — as duas plataformas precisam chegar ao mesmo número sem depender de arredondamento de
 * ponto flutuante. Imagem estreita **não** é ampliada: ela mantém o tamanho e ganha branco até o
 * próximo byte, e a sobra é dividida em dois para o conteúdo sair centrado no byte.
 */
internal class OneBitRasterGeometry private constructor(
    /** Largura em dots que a imagem realmente ocupa, já limitada à área imprimível. */
    val contentWidth: Int,
    /** Altura em dots depois da redução proporcional; igual à da origem quando não há redução. */
    val heightDots: Int,
) {
    /** Sempre múltiplo de 8: `GS v 0` conta a largura em bytes, não em pontos. */
    val widthDots: Int =
        ((contentWidth + EscPosRasterEmitter.BITS_PER_BYTE - 1) / EscPosRasterEmitter.BITS_PER_BYTE) *
            EscPosRasterEmitter.BITS_PER_BYTE

    /** Metade da sobra; a outra metade fica à direita. Divisão inteira sobra à direita. */
    val leftPadding: Int = (widthDots - contentWidth) / 2

    companion object {
        /**
         * @param printableDots área imprimível medida no perfil. Só imagem MAIS LARGA que ela é
         *   reduzida — e a redução é proporcional, com a altura arredondada meio-para-cima pela
         *   mesma conta que o Android já fazia.
         */
        fun of(
            sourceWidth: Int,
            sourceHeight: Int,
            printableDots: Int,
        ): OneBitRasterGeometry {
            val contentWidth = minOf(sourceWidth, printableDots)
            val heightDots =
                if (sourceWidth > printableDots) {
                    ((sourceHeight.toLong() * contentWidth + sourceWidth / 2) / sourceWidth)
                        .coerceAtLeast(1)
                        .also { require(it <= Int.MAX_VALUE) { "Imagem alta demais para impressão." } }
                        .toInt()
                } else {
                    sourceHeight
                }
            return OneBitRasterGeometry(contentWidth, heightDots)
        }
    }
}

/**
 * O único pedaço da conversão que é da plataforma: entregar os pixels ARGB de uma faixa.
 *
 * `Bitmap` no Android, `BufferedImage` na JVM. É aqui que mora a reamostragem — e é por isso que
 * a fronteira é esta e não outra: acima dela nada sabe de bitmap, abaixo dela nada sabe de
 * ESC/POS.
 *
 * O contrato é o de sempre e é sequencial: as faixas chegam em ordem, porque o Floyd–Steinberg
 * carrega o erro de uma linha para a seguinte e ler fora de ordem daria uma imagem correta em
 * pixel e errada em papel.
 */
internal interface RasterStripePixelReader {
    /**
     * Preenche os primeiros `contentWidth * stripeHeight` elementos de [destination] com os pixels
     * ARGB **não pré-multiplicados** da faixa que começa em [startY], linha a linha.
     *
     * Pixel translúcido já chega composto sobre BRANCO: papel térmico não tem alfa, e compor sobre
     * branco é o que o Android sempre fez (`eraseColor(WHITE)` antes do desenho). Quem implementa
     * é responsável por apagar o próprio buffer intermediário — a faixa é foto de usuário.
     */
    fun readPixels(
        startY: Int,
        stripeHeight: Int,
        destination: IntArray,
    )

    /** Descarta os recursos da plataforma e apaga o que sobrou de conteúdo do usuário. */
    fun clear()
}

/**
 * Pixels ARGB viram os pontos pretos que o `GS v 0` transmite.
 *
 * Converte **por faixa** e nunca guarda uma segunda imagem completa em memória — a foto do cupom
 * pode ser grande e o caminho precisa caber numa portátil de balcão tanto quanto num PC.
 */
internal class PixelOneBitRasterSource(
    private val geometry: OneBitRasterGeometry,
    private val reader: RasterStripePixelReader,
    private val mode: ThermalImageMode,
    private val stripeHeightDots: Int,
) : OneBitRasterSource {
    private val contentWidth = geometry.contentWidth
    private val leftPadding = geometry.leftPadding

    override val widthDots: Int = geometry.widthDots
    override val heightDots: Int = geometry.heightDots

    private val pixels = IntArray(contentWidth * stripeHeightDots)

    // Duas linhas de acumulador que se revezam. Elas NÃO são zeradas entre faixas, de propósito:
    // a emenda entre duas bandas `GS v 0` é uma emenda do protocolo, não da imagem, e zerar ali
    // deixaria uma costura visível no papel a cada 24 linhas.
    private var currentErrors = DoubleArray(contentWidth + ERROR_PADDING)
    private var nextErrors = DoubleArray(contentWidth + ERROR_PADDING)
    private var nextStartY = 0

    override fun readStripe(
        startY: Int,
        stripeHeight: Int,
        destination: ByteArray,
    ) {
        require(startY == nextStartY) { "Faixas raster precisam ser convertidas em ordem." }
        require(stripeHeight in 1..stripeHeightDots) { "Altura de faixa raster inválida." }
        val widthBytes = widthDots / EscPosRasterEmitter.BITS_PER_BYTE
        require(destination.size == widthBytes * stripeHeight) { "Buffer de faixa raster inválido." }

        try {
            reader.readPixels(startY, stripeHeight, pixels)
            when (mode) {
                ThermalImageMode.THRESHOLD -> packThreshold(stripeHeight, widthBytes, destination)
                ThermalImageMode.FLOYD_STEINBERG -> packFloydSteinberg(stripeHeight, widthBytes, destination)
            }
            nextStartY += stripeHeight
        } finally {
            pixels.fill(0)
        }
    }

    /** Apaga o acumulador e a faixa em memória, e devolve à plataforma os recursos dela. */
    fun clear() {
        pixels.fill(0)
        currentErrors.fill(0.0)
        nextErrors.fill(0.0)
        reader.clear()
    }

    private fun packThreshold(
        stripeHeight: Int,
        widthBytes: Int,
        destination: ByteArray,
    ) {
        for (y in 0 until stripeHeight) {
            for (x in 0 until contentWidth) {
                if (luminance(pixels[y * contentWidth + x]) < THRESHOLD) {
                    setBlack(destination, y, leftPadding + x, widthBytes)
                }
            }
        }
    }

    private fun packFloydSteinberg(
        stripeHeight: Int,
        widthBytes: Int,
        destination: ByteArray,
    ) {
        for (y in 0 until stripeHeight) {
            for (x in 0 until contentWidth) {
                val errorIndex = x + 1
                val adjusted = (luminance(pixels[y * contentWidth + x]) + currentErrors[errorIndex])
                    .coerceIn(BLACK.toDouble(), WHITE.toDouble())
                val black = adjusted < THRESHOLD
                if (black) setBlack(destination, y, leftPadding + x, widthBytes)
                val error = adjusted - if (black) BLACK else WHITE
                currentErrors[errorIndex + 1] += error * RIGHT_ERROR
                nextErrors[errorIndex - 1] += error * DOWN_LEFT_ERROR
                nextErrors[errorIndex] += error * DOWN_ERROR
                nextErrors[errorIndex + 1] += error * DOWN_RIGHT_ERROR
            }
            val consumed = currentErrors
            currentErrors = nextErrors
            nextErrors = consumed
            nextErrors.fill(0.0)
        }
    }

    /**
     * Os pesos 299/587/114 do vídeo composto, com arredondamento inteiro.
     *
     * Os canais são extraídos por deslocamento em vez de `android.graphics.Color`, porque este
     * arquivo atravessa para a JVM — e `Color.red(c)` **é** `(c shr 16) and 0xff`, então trocar a
     * chamada pela conta não muda um bit. Arredondar somando meio denominador antes de dividir é
     * o que faz `127` e `128` caírem dos lados certos do limiar nas duas plataformas: divisão
     * inteira truncando daria um dot diferente na borda.
     */
    private fun luminance(color: Int): Int =
        (
            RED_WEIGHT * (color shr RED_SHIFT and CHANNEL_MASK) +
                GREEN_WEIGHT * (color shr GREEN_SHIFT and CHANNEL_MASK) +
                BLUE_WEIGHT * (color and CHANNEL_MASK) +
                WEIGHT_ROUNDING
        ) / WEIGHT_TOTAL

    /** Bit mais significativo primeiro: é assim que o `GS v 0` lê a linha. */
    private fun setBlack(
        destination: ByteArray,
        y: Int,
        x: Int,
        widthBytes: Int,
    ) {
        val index = y * widthBytes + x / EscPosRasterEmitter.BITS_PER_BYTE
        destination[index] =
            (
                destination[index].toInt() or
                    (0x80 shr (x % EscPosRasterEmitter.BITS_PER_BYTE))
            ).toByte()
    }

    private companion object {
        const val ERROR_PADDING = 2
        const val BLACK = 0
        const val WHITE = 255
        const val THRESHOLD = 128
        const val RED_WEIGHT = 299
        const val GREEN_WEIGHT = 587
        const val BLUE_WEIGHT = 114
        const val WEIGHT_TOTAL = 1_000
        const val WEIGHT_ROUNDING = WEIGHT_TOTAL / 2
        const val RIGHT_ERROR = 7.0 / 16.0
        const val DOWN_LEFT_ERROR = 3.0 / 16.0
        const val DOWN_ERROR = 5.0 / 16.0
        const val DOWN_RIGHT_ERROR = 1.0 / 16.0
        const val RED_SHIFT = 16
        const val GREEN_SHIFT = 8
        const val CHANNEL_MASK = 0xff
    }
}

/**
 * A largura mínima que vale converter. Abaixo de um byte não há raster a emitir.
 *
 * Vive aqui, e não no arquivo de cada plataforma, porque a resposta a "esta largura serve?"
 * precisa ser a mesma nos dois: um `printableDots` que o Android recusa com `null` não pode ser
 * aceito pelo desktop, senão o mesmo cupom monta de um lado e some do outro.
 */
internal const val MIN_IMAGE_WIDTH_DOTS = 8

/** Maior geometria homologável de `MeasuredProfile`: papel de 80 mm com 640 dots. */
internal const val MAX_PROFILE_PRINTABLE_DOTS = 640

/** O portão de entrada do caminho de imagem, idêntico nas duas plataformas. */
internal fun isPrintableWidthSupported(printableDots: Int): Boolean =
    printableDots in MIN_IMAGE_WIDTH_DOTS..MAX_PROFILE_PRINTABLE_DOTS &&
        printableDots % EscPosRasterEmitter.BITS_PER_BYTE == 0
