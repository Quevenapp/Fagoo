package br.com.thermalprinterkit

/**
 * Como um raster vira comando — a costura que permite dois dialetos sem duas composições.
 *
 * O desenho do símbolo (QR, código de barras, foto) e o **empacotamento em bits** são idênticos nos
 * dois dialetos: a IM453H usa MSB primeiro e byte da esquerda para a direita, medido em papel em
 * 23/08/2026. O que muda é só o envelope — `GS v 0` de um lado, `ESC n` do outro. Injetar o
 * envelope, em vez de duplicar a composição, é o que impede os dois caminhos de divergirem
 * justamente no bitmap, que é onde ninguém lê o diff.
 */
internal interface RasterEmission {
    fun emit(
        source: OneBitRasterSource,
        stripeHeightDots: Int,
        verticalRasterScale: Double?,
    ): ByteArray

    /**
     * A largura cabe no cabecalho **deste** envelope?
     *
     * **Existe porque o teto nao e do raster, e sim do comando que o carrega.** O `GS v 0` leva a
     * largura em dois bytes e endereca ate 65535 bytes; o `ESC n` leva em um e para em 255. Um teto
     * so, escrito onde o dialeto nao e conhecido, erraria para um dos dois lados — e erraria calado
     * no lado que importa: chamar um emissor com largura que ele nao endereca faz o `require` dele
     * lancar, e a assinatura acordada de `ReceiptLayout.monochromeRaster` e `ByteArray?`.
     *
     * O contrato, e os dois lados o cumprem: **onde isto responde `false`, `emit` lanca.** Ha prova
     * afirmando os dois sentidos, por dialeto, em `ThermalMonochromeRasterTest`.
     */
    fun addressesWidth(widthDots: Int): Boolean

    /**
     * Os bytes que devolvem o alinhamento ao padrão depois de um raster centrado.
     *
     * **Existe pelo mesmo motivo de [addressesWidth]: quem centraliza é o envelope, então quem
     * desfaz também é.** O `GS v 0` é precedido de um `ESC a 1` que o próprio
     * [EscPosRasterEmitter] emite, e sem o `ESC a 0` de volta o texto seguinte sai centralizado. O
     * `ESC n` não usa alinhamento nenhum — quem posiciona é a margem dentro do cabeçalho do
     * gráfico —, então mandar `ESC a` ali seria comando que a firmware não tem.
     *
     * Achado em 30/08/2026, no quarto caminho que compunha bytes sem consultar o dialeto:
     * `ReceiptLayout.barcode` chamava `EscPosThermalCommands.barcodeRaster` direto e ainda
     * concatenava o `ESC a 0` à mão. Os outros três já tinham sido consertados em 27/08.
     */
    fun restoreAlignment(): ByteArray
}

/** `GS v 0` em bandas, o caminho homologado desde o M1. */
internal object EscPosRasterEmission : RasterEmission {
    override fun emit(
        source: OneBitRasterSource,
        stripeHeightDots: Int,
        verticalRasterScale: Double?,
    ): ByteArray = EscPosRasterEmitter.emit(source, stripeHeightDots, verticalRasterScale)

    override fun addressesWidth(widthDots: Int): Boolean =
        widthDots > 0 &&
            widthDots % EscPosRasterEmitter.BITS_PER_BYTE == 0 &&
            widthDots / EscPosRasterEmitter.BITS_PER_BYTE <= EscPosRasterEmitter.MAX_WIDTH_BYTES

    override fun restoreAlignment(): ByteArray =
        byteArrayOf(ESC_POS_ESC, ESC_POS_ALIGN, ThermalTextAlignment.LEFT.escPosValue.toByte())

    /** `ESC` e `ESC a`, os mesmos bytes que o `EscPosRasterEmitter` usa para centralizar. */
    private const val ESC_POS_ESC: Byte = 0x1B
    private const val ESC_POS_ALIGN: Byte = 0x61
}

/**
 * `ESC n` num bloco só, centralizado pela margem.
 *
 * A altura de banda é **ignorada** de propósito: o `ESC n` leva a altura inteira no cabeçalho e a
 * própria firmware fatia conforme o buffer de bitmap enche. Ver [ProcompRasterEmitter].
 *
 * A centralização vem daqui, e não do emissor, porque é aqui que a área imprimível é conhecida —
 * nesta impressora não existe `ESC a`, então quem centraliza é a margem do próprio gráfico.
 */
internal class ProcompRasterEmission(
    private val printableDots: Int,
) : RasterEmission {
    override fun emit(
        source: OneBitRasterSource,
        stripeHeightDots: Int,
        verticalRasterScale: Double?,
    ): ByteArray =
        ProcompRasterEmitter.emit(
            source,
            ProcompRasterEmitter.centeringMarginDots(source.widthDots, printableDots),
            verticalRasterScale,
        )

    /**
     * O `ESC n` endereca a largura em UM byte de unidades de oito pontos: 255, nao 65535.
     *
     * A margem de centragem entra na conta porque ela sai daqui e vai no mesmo cabecalho — e nesta
     * firmware nao ha `ESC a`, entao margem e a unica centragem que existe.
     */
    override fun addressesWidth(widthDots: Int): Boolean {
        if (widthDots <= 0 || widthDots % ProcompRasterEmitter.BITS_PER_BYTE != 0) return false
        if (widthDots / ProcompRasterEmitter.BITS_PER_BYTE > ProcompRasterEmitter.MAX_EIGHT_DOT_UNITS) return false
        val margem = ProcompRasterEmitter.centeringMarginDots(widthDots, printableDots)
        return margem / ProcompRasterEmitter.BITS_PER_BYTE <= ProcompRasterEmitter.MAX_EIGHT_DOT_UNITS
    }

    /**
     * Vazio, e é a resposta certa: esta firmware **não tem `ESC a`**.
     *
     * Quem posiciona o gráfico é a margem dentro do cabeçalho do `ESC n`, então não há alinhamento
     * pendente para desfazer. Devolver os três bytes do ESC/POS aqui mandaria um comando que a
     * IM453H não conhece logo depois de cada código de barras.
     */
    override fun restoreAlignment(): ByteArray = ByteArray(0)
}

/**
 * Um bloco de texto no dialeto Procomp, com atributos e alinhamento.
 *
 * **Alinhamento é preenchimento**, porque não existe `ESC a`. **Tamanho é liga/desliga**, porque a
 * firmware oferece expandido e dupla altura, e não multiplicador arbitrário: qualquer multiplicador
 * maior que um vira o atributo correspondente, e é a melhor aproximação honesta do
 * [ThermalTextSize] do kit.
 *
 * O bloco **fecha o que abriu**. Sai com os atributos desligados um a um, pelos comandos que foram
 * vistos desligando cada um — nesta firmware não há `ESC @` para zerar tudo de uma vez, e confiar
 * num reset que só o manual promete é o tipo de suposição que já custou caro aqui.
 */
internal fun procompText(
    value: String,
    alignment: ThermalTextAlignment,
    style: ThermalTextStyle,
    size: ThermalTextSize,
    columns: Int,
    table: ProcompCodeTable = ProcompCodeTable.ABICOMP,
): ByteArray {
    val expandido = size.widthMultiplier > 1
    val duplaAltura = size.heightMultiplier > 1
    // Texto expandido ocupa o dobro por caractere, então o preenchimento conta em colunas do dobro.
    val colunasEfetivas = maxOf(1, columns / if (expandido) 2 else 1)
    val saida = ArrayList<Byte>(value.length + PREFIXO_MAXIMO)

    if (style == ThermalTextStyle.BOLD) saida += ProcompEscP.emphasisOn().toList()
    if (expandido) saida += ProcompEscP.expandedOn().toList()
    if (duplaAltura) saida += ProcompEscP.doubleHeight(true).toList()

    // Uma linha por vez: o preenchimento alinha **cada** linha, e o alinhamento do bloco inteiro
    // não existe nesta impressora. Quebra de linha preservada como veio.
    //
    // **Linha vazia não recebe preenchimento**, e isso não é economia de bytes. `split('\n')` de um
    // texto que termina em quebra devolve um segmento vazio no fim, e preencher esse segmento
    // deixava o cursor no meio da linha, **sem LF depois**. Medido em papel na IM453H em
    // 24/08/2026: um bloco centrado de `"\nCupom de exemplo\n"` terminava com 24 espaços soltos, e
    // a linha seguinte — de 35 colunas, que cabem de sobra nas 48 desta impressora — começava na
    // coluna 24, estourava a largura e partia "Item ... Valor" em duas. O defeito parecia largura
    // errada do perfil, e não era: a régua de colunas confirmou 48.
    //
    // No caminho ESC/POS isso nunca apareceu porque lá o alinhamento é `ESC a` e linha vazia é só
    // um LF. O preenchimento é invenção deste dialeto, então a borda também é dele.
    value.split('\n').forEachIndexed { indice, linha ->
        if (indice > 0) saida += 0x0A
        if (linha.isEmpty()) return@forEachIndexed
        saida += ProcompEscP.encode(
            ProcompEscP.padded(linha, colunasEfetivas, procompAlignment(alignment)),
            table,
        ).toList()
    }

    if (duplaAltura) saida += ProcompEscP.doubleHeight(false).toList()
    if (expandido) saida += ProcompEscP.expandedOff().toList()
    if (style == ThermalTextStyle.BOLD) saida += ProcompEscP.emphasisOff().toList()
    return saida.toByteArray()
}

/** O que fecha um cupom nesta impressora: avanço e a guilhotina, ou só avanço para destacar. */
internal fun procompFinish(
    hasCutter: Boolean,
    cutFeedLines: Int,
    tearFeedLines: Int,
): ByteArray =
    if (hasCutter) {
        // `ESC w` e `ESC US` cortaram os dois, e os dois cortaram **parcial** — a guilhotina desta
        // unidade está configurada "Somente Parcial". O `ESC w` é o escolhido por ser o corte
        // simples; o `ESC US` embute avanço próprio, que brigaria com o avanço do perfil.
        //
        // **O `ESC w` também alimenta sozinho, medido em 26/08/2026.** A régua de avanço da
        // homologação saiu inteira nesta impressora e a tira de **avanço 0 não comeu texto**: quem
        // cobre a distância entre a cabeça e a lâmina é a própria firmware. Por isso `cutFeedLines`
        // zero aqui é medida desta unidade, e não campo esquecido — o avanço 4 que a configuração
        // manual gravou em 24/08 é que era palpite.
        ProcompEscP.feed(cutFeedLines) + ProcompEscP.cut(ProcompCutCommand.ESC_W)
    } else {
        ProcompEscP.feed(tearFeedLines)
    }

private fun procompAlignment(alignment: ThermalTextAlignment): ProcompAlignment =
    when (alignment) {
        ThermalTextAlignment.LEFT -> ProcompAlignment.LEFT
        ThermalTextAlignment.CENTER -> ProcompAlignment.CENTER
        ThermalTextAlignment.RIGHT -> ProcompAlignment.RIGHT
    }

/** Ênfase, expandido e dupla altura, ligando e desligando: seis comandos de dois a três bytes. */
private const val PREFIXO_MAXIMO = 16
