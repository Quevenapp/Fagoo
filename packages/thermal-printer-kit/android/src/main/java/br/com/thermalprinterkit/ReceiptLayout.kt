package br.com.thermalprinterkit

/**
 * O que o hospedeiro prefere para os códigos de um cupom, por impressora.
 *
 * Atravessa o ponto de injeção neutro e para no [ReceiptLayout.from], que a confronta com a
 * capacidade medida. **O kit não lê preferência nenhuma**: quem guarda isto é o app, chaveado pelo
 * `profileId`, e a superfície do kit não sabe que existe tela de ajustes.
 *
 * São dois campos porque são duas decisões independentes: uma firmware pode atender ao `GS k` do
 * código de barras e ignorar o `GS ( k` do QR — em impressora térmica nada implica nada.
 */
data class ThermalCodeEmissionPreferences(
    /**
     * Qual conjunto de comandos este cupom fala.
     *
     * Nasce Epson para que todo layout já construído continue byte a byte igual. O valor vem do
     * perfil, e é ele que decide texto, raster e corte — as três coisas que o dialeto muda.
     */
    val dialect: EscPosDialect = EscPosDialect.EPSON_COMPATIBLE,
    val qrEmission: ThermalCodeEmission = ThermalCodeEmission.DEFAULT,
    val barcodeEmission: ThermalCodeEmission = ThermalCodeEmission.DEFAULT,
) {
    companion object {
        /** O que sai quando ninguém pede outra coisa: os dois rasterizados, como sempre foi. */
        val DEFAULT = ThermalCodeEmissionPreferences()
    }
}

/**
 * Traduz o perfil escolhido em decisões de papel. Uma portátil de 58mm tem 32 colunas e não
 * tem guilhotina; a de balcão tem 48 e corta. O cupom precisa sair legível nas duas.
 */
data class ReceiptLayout(
    val columns: Int,
    val qrWidthDots: Int,
    val hasCutter: Boolean,
    /** Como esta impressora corta. Ver `CutProtocol`: o comando é dela, não do padrão. */
    val cutProtocol: CutProtocol = CutProtocol.GS_V,
    /** Avanço antes da guilhotina. Ver `PrinterDriverProfile.cutFeedLines`: é distância física. */
    val cutFeedLines: Int = 5,
    /** Só existe no modelo de byte único; [textEncoding] distingue UTF-8 da dobra ASCII. */
    val codePage: ThermalCodePage? = ThermalCodePage.CP850,
    /**
     * Endereço medido da página em `ESC t`, quando não é o canônico do enum.
     *
     * Medido na bancada: a T210 atende a CP860 em `ESC t 8`, e responde tailandês no `n` que a
     * documentação reserva à CP1252. Nome de página não determina endereço.
     */
    val codePageSelector: Int? = null,
    /** Modelo do fio; `null` infere o contrato legado a partir de [codePage]. */
    val textEncoding: ThermalTextEncoding? = null,
    /** Área imprimível medida no perfil; imagem usa esta largura, nunca a constante do QR. */
    val printableDots: Int = qrWidthDots,
    /**
     * Cabeçalho e rodapé do app hospedeiro. `null` é o comportamento histórico: nada acrescentado.
     *
     * Fica no layout, e não no payload, porque o rodapé precisa entrar antes do corte de
     * [finish] — e o corte é a última coisa que o payload emite. Ver [ReceiptDecoration].
     */
    val decoration: ReceiptDecoration? = null,
    /**
     * Altura de cada banda `GS v 0` da imagem deste cupom.
     *
     * O padrão é o de sempre, e é ele que sai quando ninguém pede outro: um cupom montado hoje tem
     * byte a byte os mesmos bytes de antes deste campo existir. Outro valor é medição de bancada —
     * ver [DEFAULT_RASTER_STRIPE_HEIGHT_DOTS], que explica o que a banda menor está tentando
     * descobrir na Inico T210.
     */
    val rasterStripeHeightDots: Int = DEFAULT_RASTER_STRIPE_HEIGHT_DOTS,
    /**
     * Fator de compensação vertical desta impressora; `null` é não compensar nada.
     *
     * Vem do perfil, medido em papel, e nunca de preferência. Ver [VERTICAL_RASTER_SCALE_RANGE]:
     * com fator, todo raster deste cupom — foto, logotipo e QR — sai reamostrado na vertical para
     * o papel ter a altura pretendida. Sem fator, o cupom tem byte a byte os bytes de sempre.
     */
    val verticalRasterScale: Double? = null,
    /**
     * Quem desenha o QR deste cupom. Padrão: o app, em pontos — o caminho já homologado.
     *
     * Entra **no fim da lista** de propósito: no meio, quebraria todo chamador posicional; aqui,
     * todo layout montado antes deste campo existir continua compilando e continua rasterizando.
     * Ver [qr]; [qrRaster] não olha para este campo e continua sempre rasterizando.
     */
    /**
     * Qual conjunto de comandos este cupom fala.
     *
     * Nasce Epson para que todo layout já construído continue byte a byte igual. O valor vem do
     * perfil, e é ele que decide texto, raster e corte — as três coisas que o dialeto muda.
     */
    val dialect: EscPosDialect = EscPosDialect.EPSON_COMPATIBLE,
    val qrEmission: ThermalCodeEmission = ThermalCodeEmission.DEFAULT,
    /** Quem desenha o código de barras deste cupom. Mesmo padrão, comando diferente. Ver [barcode]. */
    val barcodeEmission: ThermalCodeEmission = ThermalCodeEmission.DEFAULT,
) {
    init {
        require(rasterStripeHeightDots in RASTER_STRIPE_HEIGHT_RANGE) {
            "Altura de banda raster inválida."
        }
        require(verticalRasterScale == null || verticalRasterScale in VERTICAL_RASTER_SCALE_RANGE) {
            "Fator de compensação vertical inválido."
        }
        require(columns > 0) { "Largura de cupom inválida." }
        require(qrWidthDots % 8 == 0) { "Largura de QR inválida." }
        require(printableDots > 0 && printableDots % 8 == 0) { "Largura raster inválida." }
        require(qrWidthDots <= printableDots) { "QR excede a área imprimível." }
    }

    /**
     * Quebra em palavras dentro da largura da impressora. Sem isso a firmware quebra sozinha na
     * coluna exata e parte a última palavra no meio.
     *
     * @param scale multiplicador de largura do texto, o mesmo de `GS !`. **Texto em corpo dobrado
     *   ocupa duas colunas por caractere**, então numa portátil de 32 cabem 16 — e quem esquecer
     *   isto entrega ao papel uma linha que a firmware parte sozinha. Foi exatamente o que
     *   aconteceu com "PASTELÃO DE CARNE": saiu `PASTELAO DE CARN` e um `E` órfão na linha
     *   seguinte, porque a conta foi feita com 32 e o corpo era dobrado.
     */
    /**
     * O envelope de raster deste dialeto. Ver [RasterEmission].
     *
     * **Deixou de ser privado em 27/08/2026, e a privacidade era a causa do defeito.** Fechado aqui,
     * ele so alcancava [imageRaster] e [qrRaster]; `monochromeRaster`, que mora em outro arquivo,
     * nao tinha como pedi-lo e chamava `EscPosRasterEmitter` direto. Ver o KDoc daquela funcao para
     * a medicao.
     */
    internal val rasterEmission: RasterEmission =
        when (dialect) {
            EscPosDialect.EPSON_COMPATIBLE -> EscPosRasterEmission
            // A área imprimível é capturada aqui porque é aqui que ela é conhecida: sem `ESC a`,
            // quem centraliza o gráfico é a margem dele.
            EscPosDialect.PROCOMP_ESC_P -> ProcompRasterEmission(printableDots)
        }

    fun wrap(text: String, scale: Int = 1): String {
        require(scale > 0) { "Escala de texto inválida." }
        val width = maxOf(1, columns / scale)
        return text
            .split('\n')
            .joinToString("\n") { paragraph -> wrapParagraph(paragraph, width) }
    }

    /** Quebra texto conforme o multiplicador horizontal realmente emitido em `GS !`. */
    fun wrap(
        text: String,
        size: ThermalTextSize,
    ): String = wrap(text, size.widthMultiplier)

    /**
     * Expõe o tamanho tipado ao montador de cupom e aplica a página de código deste perfil.
     *
     * A assinatura com [ThermalTextSize] preserva os helpers históricos que ainda recebem o byte
     * cru como `Int`, sem fazer um `17` antigo virar por acidente “largura 17”.
     */
    fun text(
        value: String,
        alignment: ThermalTextAlignment,
        style: ThermalTextStyle,
        size: ThermalTextSize,
    ): ByteArray =
        when (dialect) {
            EscPosDialect.EPSON_COMPATIBLE ->
                EscPosThermalCommands.text(
                    value,
                    alignment,
                    style,
                    size,
                    codePage,
                    codePageSelector,
                    textEncoding,
                )
            // ABICOMP direto, sem `ESC t`: é a tabela de fábrica desta firmware, e o papel de
            // 23/08 provou que acento sai certo sem seletor nenhum. Selecionar seria trocar por
            // outra tabela sem motivo.
            EscPosDialect.PROCOMP_ESC_P -> procompText(value, alignment, style, size, columns)
        }

    /** Imagem de usuário usa a largura medida do perfil; nenhuma constante cabe ao consumidor. */
    fun imageRaster(
        image: ThermalImage,
        mode: ThermalImageMode = ThermalImageMode.FLOYD_STEINBERG,
    ): ByteArray? =
        if (!rasterProven()) {
            null
        } else {
            EscPosThermalCommands.imageRaster(
                image,
                printableDots,
                mode,
                rasterStripeHeightDots,
                verticalRasterScale,
                rasterEmission,
            )
        }

    /**
     * QR pela largura e pelo fator desta impressora — o caminho recomendado ao payload.
     *
     * Existe pela mesma razão de [imageRaster]: o QR atravessa o emissor de raster, então ele
     * encolhe junto na firmware que encolhe, e quem monta cupom não tem como saber disso. Chamar
     * [EscPosThermalCommands.qrRaster] direto continua válido e continua sem compensação — é o
     * caminho de quem passa os números à mão.
     */
    fun qrRaster(
        value: String,
        errorCorrection: Int = DEFAULT_QR_ERROR_CORRECTION,
    ): ByteArray? =
        if (!rasterProven()) {
            null
        } else {
            EscPosThermalCommands.qrRaster(
                value,
                qrWidthDots,
                errorCorrection,
                verticalRasterScale,
                rasterEmission,
            )
        }

    /**
     * O QR deste cupom pelo modo que a impressora autorizou — o caminho para quem monta cupom.
     *
     * **No modo padrão isto é literalmente [qrRaster]**, chamado com os mesmos argumentos: não há um
     * segundo caminho que possa divergir, e é assim que o cupom de sempre continua saindo byte a
     * byte igual. Só o ramo [ThermalCodeEmission.NATIVE] muda de comando.
     *
     * **Carga protegida não passa por aqui.** Sonda, comprovante de homologação e qualquer payload
     * que carregue assinatura chamam [EscPosThermalCommands.qrRaster] direto, porque firmware que
     * não entende `GS ( k` imprime o payload como texto legível — e assinatura impressa é
     * assinatura copiável. Isso não é escolha de quem usa.
     *
     * Devolve `null` quando o payload não vira símbolo, do mesmo jeito que [qrRaster].
     */
    /**
     * Se o raster deste dialeto já saiu como **imagem** em papel, e não como caractere.
     *
     * **Procomp: medido em 24/08/2026, com a carga real.** Os 12.885 bytes que este cupom emite
     * para o QR — 14 bandas de `ESC n`, 24 dotlines cada, margem 16, coladas — saíram como QR
     * legível na IM453H em três impressões: sozinhos, precedidos do texto do cupom, e como cupom
     * inteiro de 13.263 bytes. Os bytes vieram do próprio kit e o recurso da sonda é conferido
     * contra eles por `SondaQrRealDoCupomTest`.
     *
     * **O que enganou até aqui.** O comprovante de teste saía como rio de caractere, e a leitura
     * óbvia era que o raster Procomp não servia. Não era isso: a tela de descoberta descartava o
     * card do catálogo e montava um perfil temporário **em ESC/POS**, então o que chegava à
     * impressora era `GS v0` — comando que esta firmware não tem. O emissor Procomp nunca chegou a
     * rodar naquele caminho. Dez hipóteses caíram por medição antes de alguém olhar de qual perfil
     * o cupom vinha; o que resolveu foi logar o dialeto e o digest do payload na hora da escrita.
     */
    private fun rasterProven(): Boolean =
        when (dialect) {
            EscPosDialect.EPSON_COMPATIBLE -> true
            EscPosDialect.PROCOMP_ESC_P -> true
        }

    /**
     * O comando nativo deste dialeto, quando existe e quando foi medido.
     *
     * A IM453H **tem** QR nativo (`ESC ( k`) e código de barras nativo (`ESC | 0`, `ESC | 1`), e
     * nenhum dos dois saiu em papel até 23/08/2026. Emitir comando não medido nesta impressora não
     * custa uma tira torta: custa o aparelho travado, com a tecla de avanço morta e recuperação só
     * no desligar e ligar. Enquanto não houver sonda que os prove, o dialeto Procomp **rasteriza**,
     * que é o caminho medido — e é também o que a regra de QR protegido já manda fazer.
     */
    private fun nativeCodeAllowed(): Boolean =
        when (dialect) {
            EscPosDialect.EPSON_COMPATIBLE -> true
            EscPosDialect.PROCOMP_ESC_P -> false
        }

    fun qr(
        value: String,
        errorCorrection: Int = DEFAULT_QR_ERROR_CORRECTION,
    ): ByteArray? =
        when (qrEmission.takeIf { nativeCodeAllowed() } ?: ThermalCodeEmission.RASTERIZED) {
            ThermalCodeEmission.RASTERIZED -> qrRaster(value, errorCorrection)
            ThermalCodeEmission.NATIVE ->
                EscPosThermalCommands.qrModuleSide(value, errorCorrection)
                    ?.let { side ->
                        EscPosThermalCommands.qrNative(
                            value,
                            qrModuleSizeDots(side),
                            errorCorrection,
                        )
                    }
        }

    /**
     * O código de barras deste cupom pelo modo que a impressora autorizou.
     *
     * A largura de módulo é **medida**, não escolhida: o kit codifica o símbolo — que já precisa
     * codificar para desenhá-lo — e divide a área imprimível pela contagem de módulos. É a mesma
     * conta nos dois modos, e é o que faz o mesmo conteúdo ocupar a mesma pegada física escolha-se
     * o que se escolher. Ver [ThermalBarcode.moduleWidthDots].
     *
     * **A legenda é emitida aqui, e não pelo emissor cru.** No modo nativo ela é `GS H 2`, papel da
     * firmware; no rasterizado é uma linha de texto centrada, que é o único jeito de ela sair na
     * página de código medida daquela impressora — o emissor cru não tem perfil para consultar. O
     * texto da legenda é o conteúdo **normalizado**: um EAN-13 digitado com doze dígitos sai com o
     * verificador que o kit calculou, e a legenda mostra o mesmo número que as barras carregam.
     *
     * Devolve `null` quando o conteúdo não vira símbolo ou quando o símbolo não cabe na largura
     * desta impressora — as duas recusas que [ThermalBarcode.validate] e
     * [ThermalBarcodeRejection.DoesNotFit] descrevem em pt-BR para quem oferece o campo.
     */
    fun barcode(
        value: String,
        symbology: ThermalBarcodeSymbology = ThermalBarcodeSymbology.CODE_128,
        humanReadable: Boolean = true,
        heightDots: Int = ThermalBarcode.DEFAULT_HEIGHT_DOTS,
    ): ByteArray? {
        val normalized =
            (ThermalBarcode.validate(value, symbology) as? ThermalBarcodeValidation.Accepted)
                ?.normalized ?: return null
        val moduleWidthDots =
            ThermalBarcode.moduleWidthDots(normalized, symbology, printableDots) ?: return null
        return when (barcodeEmission.takeIf { nativeCodeAllowed() } ?: ThermalCodeEmission.RASTERIZED) {
            ThermalCodeEmission.RASTERIZED -> {
                val barras =
                    EscPosThermalCommands.barcodeRaster(
                        normalized,
                        symbology,
                        moduleWidthDots,
                        heightDots,
                        printableDots,
                        verticalRasterScale,
                        // O envelope do dialeto, como [qrRaster] já fazia ao lado desde o conserto
                        // de raiz de 27/08/2026. Sem isto, um cupom Procomp com código de barras
                        // rasterizado saía em `GS v 0` — o quarto caminho do mesmo defeito, e o
                        // último que faltava.
                        rasterEmission,
                    ) ?: return null
                if (!humanReadable) {
                    barras
                } else {
                    receiptBytes(
                        listOf(
                            barras,
                            // A quebra é do bloco, e não decoração: sem ela a legenda fica no
                            // buffer da linha e o que vier depois sai grudado nela.
                            text(
                                normalized + "\n",
                                ThermalTextAlignment.CENTER,
                                ThermalTextStyle.NORMAL,
                                ThermalTextSize.NORMAL,
                            ),
                        ),
                    )
                }
            }

            ThermalCodeEmission.NATIVE ->
                EscPosThermalCommands.barcodeNative(
                    normalized,
                    symbology,
                    moduleWidthDots,
                    heightDots,
                    humanReadable,
                )
        }
    }

    /**
     * Tamanho de módulo do QR nativo, pela mesma régua do código de barras: área dividida por
     * módulos.
     *
     * O `GS ( k` não recebe largura em pontos, então sem esta conta o tamanho seria chute — e um
     * chute faria o mesmo payload ocupar papel diferente conforme o ajuste, que é justamente o que
     * esta frente promete que não acontece.
     */
    private fun qrModuleSizeDots(moduleSide: Int): Int =
        (qrWidthDots / (moduleSide + 2 * ThermalBarcode.QR_QUIET_ZONE_MODULES)).coerceIn(
            ThermalBarcode.QR_NATIVE_MODULE_SIZE_DOTS_RANGE.first,
            ThermalBarcode.QR_NATIVE_MODULE_SIZE_DOTS_RANGE.last,
        )

    /**
     * Uma linha com descrição à esquerda e valor colado na margem direita.
     *
     * `Cerveja ............ 12x  R$ 60,00`
     *
     * Não dá para resolver isto com [ThermalTextAlignment.RIGHT]: descrição e valor dividem a MESMA
     * linha, e o alinhamento do ESC/POS vale para a linha inteira. Quem posiciona é o preenchimento
     * contado em colunas, aqui — e por isso a mesma chamada serve na portátil de 32 e na de balcão
     * de 48 sem o cupom saber qual das duas está imprimindo.
     *
     * Quando não cabe, a descrição é encurtada e o valor é preservado inteiro: um total cortado no
     * meio é pior que um nome de produto abreviado — é ele que a pessoa confere contra a gaveta.
     *
     * @param fill caractere de preenchimento. Ponto guia o olho pela linha; espaço é mais limpo
     *   para totais. Sempre ASCII: preenchimento é o que mais se repete no cupom, e um caractere
     *   fora da página de código viraria uma fileira de `?`.
     */
    fun entry(description: String, value: String, fill: Char = ' '): String {
        val valor = value.trim()
        // Uma coluna de respiro entre os dois, senão a descrição encosta no valor e a linha vira
        // uma palavra só na leitura.
        val disponivel = columns - valor.length - 1
        if (disponivel < 1) {
            // Valor sozinho já ocupa a linha: a descrição vai por cima, em linha própria.
            return if (description.isBlank()) valor else "${wrap(description)}\n$valor"
        }
        val texto = description.trim().let { if (it.length > disponivel) it.take(disponivel) else it }
        val preenchimento = columns - texto.length - valor.length
        return texto + fill.toString().repeat(preenchimento) + valor
    }

    /**
     * Fecha o cupom, avanço incluído: quem monta o recibo não deve somar avanço próprio, senão
     * sobra papel em branco. Sem guilhotina o corte é serrilha manual, e o papel precisa avançar
     * só o bastante para a última linha passar da barra.
     */
    fun finish(): ByteArray {
        val corte =
            when (dialect) {
                EscPosDialect.EPSON_COMPATIBLE ->
                    if (hasCutter) {
                        requireNotNull(EscPosThermalCommands.cut(cutFeedLines, cutProtocol)) {
                            "Corte de papel inválido."
                        }
                    } else {
                        requireNotNull(EscPosThermalCommands.advance(TEAR_FEED_LINES)) {
                            "Avanço de papel inválido."
                        }
                    }
                // `cutProtocol` não é consultado: os protocolos do enum são todos ESC/POS, e o
                // corte medido nesta firmware é `ESC w`. Enquanto não houver medição que separe
                // `ESC w` de `ESC US` — na bancada os dois cortaram parcial —, escolher pelo perfil
                // seria oferecer uma distinção que ninguém observou.
                EscPosDialect.PROCOMP_ESC_P -> procompFinish(hasCutter, cutFeedLines, TEAR_FEED_LINES)
            }
        // O rodapé entra aqui, e não no chamador, porque este é o último ponto antes da lâmina.
        // Quem concatenasse depois de `finish()` imprimiria do outro lado do corte, no cupom
        // seguinte — que foi como a marca d'água apareceu na primeira tentativa.
        val rodape = decoration?.footer(this) ?: return corte
        return receiptBytes(listOf(rodape, corte))
    }

    private fun wrapParagraph(paragraph: String, width: Int): String {
        if (paragraph.length <= width) return paragraph
        val lines = mutableListOf<String>()
        val current = StringBuilder()
        paragraph.split(' ').filter(String::isNotEmpty).forEach { word ->
            when {
                current.isEmpty() -> current.append(word.chunkedToLines(lines, width))
                current.length + 1 + word.length <= width -> current.append(' ').append(word)
                else -> {
                    lines += current.toString()
                    current.setLength(0)
                    current.append(word.chunkedToLines(lines, width))
                }
            }
        }
        if (current.isNotEmpty()) lines += current.toString()
        return lines.joinToString("\n")
    }

    /** Palavra maior que a linha inteira é partida; devolve o resto que ainda cabe. */
    private fun String.chunkedToLines(lines: MutableList<String>, width: Int): String {
        var rest = this
        while (rest.length > width) {
            lines += rest.take(width)
            rest = rest.drop(width)
        }
        return rest
    }

    companion object {
        /**
         * O QR nunca pode passar da área imprimível do papel.
         *
         * Continua interno porque [PrinterDriverProfile] é detalhe da lista de impressoras;
         * quem monta cupom recebe o layout pronto.
         */
        /**
         * @param rasterStripeHeightDots altura de banda do raster. O padrão é o publicado; quem
         *   passa outro valor é a bancada, e só em build de depuração do app hospedeiro.
         * @param codeEmission o que o hospedeiro prefere para os códigos deste cupom. Aqui é onde
         *   a preferência encontra a medição — ver a trava abaixo.
         */
        fun from(
            profile: PrinterDriverProfile,
            decoration: ReceiptDecoration? = null,
            rasterStripeHeightDots: Int = DEFAULT_RASTER_STRIPE_HEIGHT_DOTS,
            codeEmission: ThermalCodeEmissionPreferences = ThermalCodeEmissionPreferences.DEFAULT,
        ): ReceiptLayout =
            ReceiptLayout(
                columns = profile.printableColumns,
                dialect = profile.dialect,
                qrWidthDots = minOf(PREFERRED_QR_WIDTH_DOTS, profile.printableDots) / 8 * 8,
                hasCutter = profile.hasCutter,
                cutProtocol = profile.cutProtocol,
                cutFeedLines = profile.cutFeedLines,
                codePage = profile.codePage,
                codePageSelector = profile.codePageSelector,
                textEncoding = profile.textEncoding,
                printableDots = profile.printableDots,
                decoration = decoration,
                rasterStripeHeightDots = rasterStripeHeightDots,
                // Sem isto o fator morre na conversão e a foto volta a sair encolhida na firmware
                // que encolhe — que é exatamente o defeito que ele existe para compensar.
                verticalRasterScale = profile.verticalRasterScale,
                // A trava. Preferência que a medição não sustenta cai no padrão e não vira comando:
                // é a mesma recusa do `withCutMode` quando `cutModeHonored` é falso. A preferência
                // guardada no app pode estar velha — a impressora pode ter sido remedida —, e quem
                // sabe o que a firmware faz é o perfil, não o ajuste. Capacidade ausente (`null`,
                // ninguém mediu) trava igual à medida-não: o modo nativo só sai depois que alguém
                // viu o código sair no papel.
                qrEmission =
                    codeEmission.qrEmission.takeIf { profile.nativeQrHonored == true }
                        ?: ThermalCodeEmission.DEFAULT,
                barcodeEmission =
                    codeEmission.barcodeEmission.takeIf { profile.nativeBarcodeHonored == true }
                        ?: ThermalCodeEmission.DEFAULT,
            )

        /** Nível `M`, o mesmo que o comprovante de homologação já pedia ao emissor. */
        const val DEFAULT_QR_ERROR_CORRECTION = 2

        private const val PREFERRED_QR_WIDTH_DOTS = 320
        private const val CUT_FEED_LINES = 5
        private const val TEAR_FEED_LINES = 4
    }
}
