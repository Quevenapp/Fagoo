package br.com.thermalprinterkit

/**
 * Raster da Diebold Procomp, por `ESC n`.
 *
 * **Por que `ESC n` e não `ESC k`.** O `ESC k` calcula os bytes de cada dotline a partir da largura
 * da **cabeça de impressão**, que é um número que não medimos. Errar essa contagem deixa a firmware
 * esperando bytes que nunca chegam — e nesta impressora esperar bytes é como ela trava. O `ESC n`
 * recebe a largura como parâmetro, então a contagem é nossa e é exata. Foi por isso que a primeira
 * sonda de bancada usou `ESC n`, e é por isso que o produto usa também.
 *
 * **O que foi medido em 23/08/2026, e sustenta cada linha daqui:**
 *
 * * `ESC n <marg> <larg> <n1> <n2>` é obedecido, com `larg` bytes por dotline, exatamente;
 * * a ordem dos bytes na linha é da **esquerda para a direita**, e a dos bits é **MSB primeiro** —
 *   as duas iguais às do ESC/POS, então [OneBitRasterSource] serve sem tradução;
 * * a densidade horizontal é 8 dots/mm. A vertical foi contada em foto como ~8,4 dotlines/mm, o que
 *   daria o fator 0,95 de [PrinterDriverProfile.verticalRasterScale] — e a **régua desmentiu**: a
 *   tira de vazão da homologação, 384 dotlines, mediu 47 mm em 26/08/2026, ou seja ~8,17
 *   dotlines/mm. Isso cai dentro do ±1 mm de uma régua comum, então esta impressora fica **sem
 *   compensação**, e o fator anotado era ruído de leitura em foto;
 * * um comando diferente de gráfico — um `LF` basta — encerra o bloco.
 *
 * **Em bandas — e isto é uma correção.** O primeiro desenho emitia a altura inteira num cabeçalho
 * só, com o argumento de que fatiar seria inventar comportamento não medido. O papel de 23/08/2026
 * mediu o contrário: o comprovante de teste, com um QR de **320 dotlines num único `ESC n` de
 * 12.807 bytes**, saiu como rio de caracteres. Uma sonda de 240 bytes com a **mesma largura**
 * (`larg = 40`) saiu como barra sólida — então não é a largura.
 *
 * **Duas causas continuam sem separação, e a banda cobre as duas:**
 *
 * 1. **`n2` ignorado.** Toda sonda que funcionou tinha altura ≤ 180, isto é `n2 = 0`. O QR tinha
 *    320, `n1 = 0x40` e `n2 = 0x01`. Se a firmware lê só o `n1`, ela imprimiu 64 dotlines e tratou
 *    o resto como texto — que é exatamente o que o papel mostra.
 * 2. **Tamanho ou fatiamento do transporte.** O comando cru escreve uma vez; o comprovante vai em
 *    blocos de 4 KB, e firmware que abandona gráfico quando a recepção demora perde o resto.
 *
 * Separar as duas exigiria uma sonda com `n2 ≠ 0`, que precisa de ao menos 256 dotlines e não cabe
 * no teto de 256 bytes do comando cru. **Enquanto não houver essa medição, [MAX_BAND_DOTLINES]
 * mantém toda banda com `n2 = 0`** — não por elegância, mas porque é a faixa onde há prova em papel.
 */
internal object ProcompRasterEmitter {
    /** `ESC n` aceita a altura em dois bytes, então este é o teto do comando. */
    const val MAX_DOTLINES = 0xFFFF

    /**
     * Teto de uma banda: 255 dotlines, o maior valor que cabe em `n1` **sem usar `n2`**.
     *
     * Não é limitação do comando — é a fronteira do que foi medido. Ver a nota de causas acima.
     */
    const val MAX_BAND_DOTLINES = 0xFF

    /** Margem e largura são múltiplos de 8 dots, e cabem num byte cada. */
    const val MAX_EIGHT_DOT_UNITS = 0xFF

    /**
     * @param leftMarginDots recuo à esquerda, em dots, múltiplo de 8. É **assim que se centraliza**
     *   nesta impressora: não existe `ESC a`, então quem posiciona é a margem do próprio gráfico.
     * @param verticalRasterScale fator medido, ou `null` para não compensar. Com fator, a fonte é
     *   reamostrada na vertical pela **mesma** [VerticallyStretchedRasterSource] do caminho ESC/POS;
     *   duas implementações da mesma conta divergiriam no papel, que é onde ninguém vê o diff.
     */
    fun emit(
        source: OneBitRasterSource,
        leftMarginDots: Int = 0,
        verticalRasterScale: Double? = null,
        bandHeightDots: Int = DEFAULT_BAND_DOTLINES,
    ): ByteArray {
        require(
            verticalRasterScale == null || verticalRasterScale in VERTICAL_RASTER_SCALE_RANGE,
        ) { "Fator de compensação vertical inválido." }
        require(bandHeightDots in 1..MAX_BAND_DOTLINES) { "Altura de banda raster inválida." }
        val stretched =
            verticalRasterScale
                ?.let { compensatedRasterHeightDots(source.heightDots, it) }
                ?.takeIf { it > source.heightDots }
                ?.let { VerticallyStretchedRasterSource(source, it, READ_CHUNK_DOTS) }
        if (stretched == null) return emitBands(source, leftMarginDots, bandHeightDots)
        try {
            return emitBands(stretched, leftMarginDots, bandHeightDots)
        } finally {
            stretched.clear()
        }
    }

    /**
     * Bandas coladas, e **um único `LF` no fim**.
     *
     * Nada de `LF` entre bandas: `ESC n` seguido de `ESC n` continua sendo gráfico raster, e o
     * manual só dispara a impressão quando chega comando **diferente** de gráfico. Um `LF` no meio
     * seria comando diferente — encerraria a imagem e ainda avançaria uma linha de texto, abrindo
     * um vão branco entre as bandas.
     */
    private fun emitBands(
        source: OneBitRasterSource,
        leftMarginDots: Int,
        bandHeightDots: Int,
    ): ByteArray {
        val saida = java.io.ByteArrayOutputStream()
        var inicio = 0
        while (inicio < source.heightDots) {
            val altura = minOf(bandHeightDots, source.heightDots - inicio)
            saida.write(emitBand(source, leftMarginDots, inicio, altura))
            inicio += altura
        }
        saida.write(LINE_FEED.toInt())
        return saida.toByteArray()
    }

    private fun emitBand(
        source: OneBitRasterSource,
        leftMarginDots: Int,
        startY: Int,
        heightDots: Int,
    ): ByteArray {
        require(source.widthDots > 0 && source.widthDots % BITS_PER_BYTE == 0) {
            "Largura raster inválida."
        }
        require(leftMarginDots >= 0 && leftMarginDots % BITS_PER_BYTE == 0) {
            "Margem de raster precisa ser múltipla de 8 dots."
        }
        val widthBytes = source.widthDots / BITS_PER_BYTE
        val marginUnits = leftMarginDots / BITS_PER_BYTE
        require(widthBytes in 1..MAX_EIGHT_DOT_UNITS) { "Largura raster excede o `ESC n`." }
        require(marginUnits <= MAX_EIGHT_DOT_UNITS) { "Margem raster excede o `ESC n`." }
        require(heightDots in 1..MAX_BAND_DOTLINES) { "Altura de banda raster inválida." }

        val pixels = ByteArray(widthBytes * heightDots)
        try {
            source.readStripe(startY, heightDots, pixels)
            val command = ByteArray(HEADER_SIZE + pixels.size)
            command[0] = ESC
            command[1] = RASTER_WITH_MARGIN
            command[2] = marginUnits.toByte()
            command[3] = widthBytes.toByte()
            command[4] = heightDots.toByte()
            // `n2` sai sempre zero: a banda cabe em `n1`, e é essa a faixa com prova em papel.
            command[5] = 0
            pixels.copyInto(command, destinationOffset = HEADER_SIZE)
            return command
        } finally {
            pixels.fill(0)
        }
    }

    /**
     * Quanta margem centraliza [widthDots] numa área imprimível de [printableDots].
     *
     * Arredonda **para baixo**, ao múltiplo de 8 dots que a margem aceita: sobrar meio milímetro à
     * direita é melhor que estourar a área imprimível à esquerda.
     */
    fun centeringMarginDots(
        widthDots: Int,
        printableDots: Int,
    ): Int {
        if (widthDots >= printableDots) return 0
        val folga = (printableDots - widthDots) / 2
        return folga - folga % BITS_PER_BYTE
    }

    private const val ESC: Byte = 0x1B

    /** `ESC n` — gráfico raster com margem e largura declaradas. */
    private const val RASTER_WITH_MARGIN: Byte = 0x6E
    private const val LINE_FEED: Byte = 0x0A

    /**
     * Vinte e quatro dotlines por banda — 960 bytes na largura de 40 que a bancada mediu.
     *
     * É o mesmo número que o caminho ESC/POS usa desde o M1, e fica **uma ordem de grandeza abaixo**
     * dos 12.807 bytes que falharam e **quatro vezes acima** dos 240 que funcionaram. O número exato
     * onde a firmware desiste não foi medido; este é o lado seguro do que se sabe.
     */
    const val DEFAULT_BAND_DOTLINES = DEFAULT_RASTER_STRIPE_HEIGHT_DOTS
    private const val HEADER_SIZE = 6
    /** Ver [RasterEmission.addressesWidth]: a regra de largura do `ESC n` e montada com ele. */
    internal const val BITS_PER_BYTE = 8

    /** Só governa quanto se lê da fonte por vez; não aparece no papel nem nos bytes emitidos. */
    private const val READ_CHUNK_DOTS = DEFAULT_RASTER_STRIPE_HEIGHT_DOTS
}
