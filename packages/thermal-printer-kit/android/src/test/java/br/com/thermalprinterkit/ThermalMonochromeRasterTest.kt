package br.com.thermalprinterkit

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * O caminho do bitmap já composto não pode inventar byte nenhum.
 *
 * O núcleo desta suíte é comparação byte a byte contra os emissores que já existem: se
 * [monochromeRaster] divergir de `EscPosThermalCommands.qrRaster` ou da conversão de imagem para o
 * mesmo conteúdo em pontos, quem está errado é a adição, não o emissor — e o desenho de composição
 * da Frente C, que é quem vai chamar este caminho, precisaria mudar antes de existir. É essa
 * amarração que impede uma segunda verdade sobre [ReceiptLayout.verticalRasterScale] de nascer
 * dentro do interpretador de Windows.
 *
 * Espelho de `ios/Tests/ThermalPrinterKitTests/ThermalMonochromeRasterTests.swift`, com uma
 * diferença que está fixada por literal mais abaixo e **não** é acidente: o emissor Kotlin não
 * devolve o alinhamento no fim, e o Swift devolve. Ver
 * `o literal de paridade com o Swift, e os tres bytes em que os dois lados discordam`.
 */
class ThermalMonochromeRasterTest {
    // ------------------------------------------------------------------------------------------
    // O portão: igualdade com quem já vai ao papel
    // ------------------------------------------------------------------------------------------

    /**
     * Para a mesma matriz de módulos, o bitmap e o QR do kit dão exatamente os mesmos bytes.
     *
     * A matriz vem de decodificar o próprio `qrRaster` sem fator — é a forma de obter os módulos
     * sem reimplementar o ZXing aqui — e é justamente por isso que a comparação que importa é a
     * **com** fator: os dois lados atravessam a compensação por caminhos diferentes e precisam
     * sair idênticos.
     */
    @Test
    fun `o mesmo QR sai byte a byte igual pelo bitmap e pelo emissor de sempre`() {
        val semFator =
            requireNotNull(
                EscPosThermalCommands.qrRaster(QR_PAYLOAD, QR_DOTS, ReceiptLayout.DEFAULT_QR_ERROR_CORRECTION),
            )
        val modulos = linhas(semFator, QR_DOTS)
        assertEquals(QR_DOTS, modulos.size)
        val bitmap = bitmapDe(QR_DOTS, modulos)

        // Os dois lados são desembrulhados antes de comparar: `null` contra `null` passaria sem
        // provar byte nenhum.
        assertArrayEquals(semFator, requireNotNull(layout(QR_DOTS).monochromeRaster(bitmap)))

        val qrCompensado =
            requireNotNull(
                EscPosThermalCommands.qrRaster(
                    QR_PAYLOAD,
                    QR_DOTS,
                    ReceiptLayout.DEFAULT_QR_ERROR_CORRECTION,
                    FATOR_T210,
                ),
            )
        assertFalse(
            "Sem diferença entre compensado e não compensado o teste não prova nada.",
            qrCompensado.contentEquals(semFator),
        )
        assertArrayEquals(
            qrCompensado,
            requireNotNull(layout(QR_DOTS, escala = FATOR_T210).monochromeRaster(bitmap)),
        )
        // E o caminho recomendado ao payload é o mesmo destino: o layout não tem dois emissores.
        assertArrayEquals(
            requireNotNull(layout(QR_DOTS, escala = FATOR_T210).qrRaster(QR_PAYLOAD)),
            requireNotNull(layout(QR_DOTS, escala = FATOR_T210).monochromeRaster(bitmap)),
        )
    }

    /**
     * Mesmos pontos pretos que a conversão por limiar produz, mesmos bytes — com e sem fator.
     *
     * O campo de pixels é cinza (`r == g == b`) de propósito: com os pesos 299/587/114 e o
     * arredondamento inteiro de `OneBitRasterConversion.kt:210`, a luminância de um cinza é o
     * próprio valor, então "preto" aqui é exatamente `valor < 128` — o mesmo limiar que a conversão
     * aplica. Sem isso o teste estaria comparando a conversão consigo mesma por dois caminhos que
     * concordam por construção, e não os dois empacotadores.
     *
     * A comparação é contra `PixelOneBitRasterSource`, e não contra `ReceiptLayout.imageRaster`,
     * porque este é um teste de JVM: `android.graphics.Bitmap` não existe aqui. O caminho completo,
     * com `BufferedImage` de verdade, é provado em `MonochromeRasterNaJvmTest`.
     */
    @Test
    fun `a mesma imagem por limiar sai byte a byte igual pelo bitmap e pela conversao`() {
        val bitmap =
            bitmapDe(
                LARGURA_FOTO,
                (0 until ALTURA_FOTO).map { y ->
                    (0 until LARGURA_FOTO).map { x -> cinzaDoPixel(x, y) < 128 }
                },
            )

        assertArrayEquals(
            imagemPorLimiar(),
            requireNotNull(layout(LARGURA_FOTO).monochromeRaster(bitmap)),
        )
        assertArrayEquals(
            imagemPorLimiar(escala = FATOR_T210),
            requireNotNull(layout(LARGURA_FOTO, escala = FATOR_T210).monochromeRaster(bitmap)),
        )
        assertArrayEquals(
            imagemPorLimiar(banda = 8),
            requireNotNull(layout(LARGURA_FOTO, banda = 8).monochromeRaster(bitmap)),
        )
    }

    // ------------------------------------------------------------------------------------------
    // Os literais: a matriz pequena e conhecida, nas duas suítes e contra o Swift
    // ------------------------------------------------------------------------------------------

    /**
     * A matriz mínima que o `GS v 0` aceita, com os bytes escritos à mão.
     *
     * Oito pontos por dois: um comando, um byte de largura, dois de conteúdo. É o mesmo caso que o
     * B1 fixou em Swift (`ThermalMonochromeRasterTests.swift:240-245`), e é o gabarito que as duas
     * suítes Kotlin repetem — `MonochromeRasterNaJvmTest` tem este literal igual, palavra por
     * palavra.
     */
    @Test
    fun `a matriz minima toda preta fixa os bytes por literal`() {
        val todoPreto =
            requireNotNull(ThermalMonochromeBitmap.of(8, 2, BooleanArray(16) { true }))

        assertArrayEquals(
            bytesDe(VETOR_OITO_POR_DOIS_TODO_PRETO),
            requireNotNull(layout(8).monochromeRaster(todoPreto)),
        )
    }

    /**
     * Uma matriz assimétrica, porque `ff` não prova ordem de bit nenhuma.
     *
     * Linha 0 tem só o ponto 0, linha 1 tem só o ponto 15 e linha 2 tem o primeiro byte cheio. Se o
     * empacotamento fosse LSB-first, se as linhas viessem trocadas ou se a largura em bytes fosse
     * big-endian, este literal mudaria; com a matriz toda preta, nenhuma das três apareceria.
     */
    @Test
    fun `uma matriz assimetrica fixa a ordem dos bits e dos bytes`() {
        val pontos = BooleanArray(16 * 3)
        pontos[0] = true
        pontos[16 + 15] = true
        for (x in 0 until 8) pontos[32 + x] = true

        assertArrayEquals(
            bytesDe(VETOR_DEZESSEIS_POR_TRES),
            requireNotNull(
                layout(16).monochromeRaster(requireNotNull(ThermalMonochromeBitmap.of(16, 3, pontos))),
            ),
        )
    }

    /**
     * A paridade com o Swift, e os três bytes exatos em que os dois lados discordam hoje.
     *
     * O emissor Swift recebe alinhamento e o **devolve** depois da última faixa
     * (`ios/Sources/ThermalPrinterKit/ThermalRaster.swift:466`); o Kotlin escreve `ESC a 1` na
     * frente e não escreve `ESC a 0` no fim (`EscPosRasterEmitter.kt:125-127`). A divergência é
     * anterior a este arquivo e está declarada em `EscPosThermalCommands.kt:474-478`, que só a
     * remenda no caminho do código de barras — e remendá-la aqui quebraria o portão de cima, porque
     * `qrRaster` não a remenda.
     *
     * Então o que este teste faz é **prender** a diferença em vez de escondê-la: enquanto os dois
     * lados discordarem, discordam nestes três bytes e em mais nenhum. No dia em que alguém acertar
     * o emissor Kotlin, este teste fica vermelho — que é exatamente o que se quer de uma dívida
     * conhecida.
     *
     * **Não medido:** o literal Swift abaixo foi lido do arquivo de teste do B1, não executado por
     * este lote. Nenhuma linha desta suíte roda Swift.
     */
    @Test
    fun `o literal de paridade com o Swift, e os tres bytes em que os dois lados discordam`() {
        val kotlin = bytesDe(VETOR_OITO_POR_DOIS_TODO_PRETO)
        val swift = bytesDe(VETOR_SWIFT_OITO_POR_DOIS_TODO_PRETO)

        assertArrayEquals(swift, kotlin + byteArrayOf(0x1b, 0x61, 0x00))
        assertArrayEquals(kotlin, swift.copyOfRange(0, swift.size - 3))
    }

    // ------------------------------------------------------------------------------------------
    // O fator do perfil realmente entra, e entra por repetição de linha
    // ------------------------------------------------------------------------------------------

    /**
     * Com fator e sem fator os bytes diferem, e a diferença é **repetição de linha**, não outra
     * coisa.
     *
     * O bitmap tem o índice da linha codificado nos 16 bits, então nenhuma linha se repete na
     * origem. Assim, apagar duplicatas consecutivas do resultado compensado precisa devolver a
     * sequência original inteira, na ordem: nada foi interpolado, nada foi pulado, nada foi lido
     * duas vezes.
     */
    @Test
    fun `o fator do perfil estica por repeticao de linha e mais nada`() {
        val bitmap = indiceCodificado(ALTURA_INDICE)

        val semFator = requireNotNull(layout(16).monochromeRaster(bitmap))
        val comFator = requireNotNull(layout(16, escala = FATOR_T210).monochromeRaster(bitmap))
        assertFalse(comFator.contentEquals(semFator))

        val originais = linhas(semFator, 16)
        val esticadas = linhas(comFator, 16)
        assertEquals(ALTURA_INDICE, originais.size)
        assertEquals(compensatedRasterHeightDots(ALTURA_INDICE, FATOR_T210), esticadas.size)
        assertTrue(esticadas.size > originais.size)
        assertEquals(originais, semDuplicatasConsecutivas(esticadas))
    }

    /** Fator neutro é indistinguível de "sem compensação": 1,0 não muda um byte. */
    @Test
    fun `fator neutro sai igual a sem compensacao`() {
        val bitmap = indiceCodificado(ALTURA_INDICE)

        assertArrayEquals(
            requireNotNull(layout(16).monochromeRaster(bitmap)),
            requireNotNull(layout(16, escala = 1.0).monochromeRaster(bitmap)),
        )
    }

    /** A altura de banda do perfil atravessa: mais comandos `GS v 0`, os mesmos pontos pretos. */
    @Test
    fun `a altura de banda do perfil atravessa sem mudar os pontos`() {
        val bitmap = indiceCodificado(ALTURA_INDICE)

        val padrao = requireNotNull(layout(16).monochromeRaster(bitmap))
        val curta = requireNotNull(layout(16, banda = 8).monochromeRaster(bitmap))

        assertEquals(2, ocorrencias(padrao, byteArrayOf(0x1d, 0x76, 0x30, 0x00)))
        assertEquals(4, ocorrencias(curta, byteArrayOf(0x1d, 0x76, 0x30, 0x00)))
        assertEquals(linhas(padrao, 16), linhas(curta, 16))
    }

    // ------------------------------------------------------------------------------------------
    // Fronteiras do tipo
    // ------------------------------------------------------------------------------------------

    /**
     * O bitmap só guarda a regra que ele mesmo promete: dimensões que descrevem o vetor entregue.
     *
     * Sem isso, `y * widthDots + x` não endereça nada — e é por endereço que o emissor lê.
     */
    @Test
    fun `o bitmap recusa dimensoes que nao descrevem o vetor`() {
        assertNull(ThermalMonochromeBitmap.of(8, 2, BooleanArray(0)))
        assertNull(ThermalMonochromeBitmap.of(8, 2, BooleanArray(15)))
        assertNull(ThermalMonochromeBitmap.of(8, 2, BooleanArray(17)))
        assertNull(ThermalMonochromeBitmap.of(0, 2, BooleanArray(0)))
        assertNull(ThermalMonochromeBitmap.of(8, 0, BooleanArray(0)))
        assertNull(ThermalMonochromeBitmap.of(-8, 2, BooleanArray(16)))
        // Produto que dá a volta no `Int` não pode casar por acidente com o tamanho do vetor:
        // 65_536 * 65_536 é 0 em `Int`, e um vetor vazio já foi recusado acima por outra razão.
        assertNull(ThermalMonochromeBitmap.of(65_536, 65_536, BooleanArray(16)))
        assertNotNull(ThermalMonochromeBitmap.of(8, 2, BooleanArray(16)))
    }

    /** Dois bitmaps são iguais quando os pontos são iguais — o vetor entra na comparação. */
    @Test
    fun `igualdade compara os pontos e nao so as dimensoes`() {
        val branco = requireNotNull(ThermalMonochromeBitmap.of(8, 1, BooleanArray(8)))
        val outroBranco = requireNotNull(ThermalMonochromeBitmap.of(8, 1, BooleanArray(8)))
        val umPonto =
            requireNotNull(ThermalMonochromeBitmap.of(8, 1, BooleanArray(8) { it == 0 }))

        assertEquals(branco, outroBranco)
        assertEquals(branco.hashCode(), outroBranco.hashCode())
        assertNotEquals(branco, umPonto)
    }

    /**
     * O bitmap é valor: mutar o vetor de quem chamou depois de construir não muda os bytes.
     *
     * É o que o `struct` do Swift dá de graça, e aqui custa uma cópia em [ThermalMonochromeBitmap.of].
     * Sem ela, um compositor que reaproveitasse o mesmo `BooleanArray` entre cupons emitiria o
     * cupom seguinte no lugar do anterior — e a suíte não veria, porque o objeto seria o mesmo.
     */
    @Test
    fun `o bitmap nao acompanha o vetor de quem chamou, e emitir duas vezes da os mesmos bytes`() {
        val pontos = BooleanArray(16 * ALTURA_INDICE) { it % 3 == 0 }
        val bitmap = requireNotNull(ThermalMonochromeBitmap.of(16, ALTURA_INDICE, pontos))
        val perfil = layout(16, escala = FATOR_T210)
        val primeiro = requireNotNull(perfil.monochromeRaster(bitmap))

        pontos.fill(true)

        assertArrayEquals(primeiro, requireNotNull(perfil.monochromeRaster(bitmap)))
    }

    /**
     * Largura fora do contrato do `GS v 0` não emite byte nenhum — e o emissor concorda.
     *
     * Aqui o `null` é a resposta certa: não há imagem para reamostrar na horizontal, então ajustar
     * a largura significaria cortar ou deslocar pontos que alguém já posicionou.
     *
     * A segunda metade do teste é o que paga a regra escrita duas vezes. `monochromeRaster` confere
     * a largura antes de chamar o emissor porque a assinatura acordada é `ByteArray?` e o emissor
     * cobra o mesmo contrato com `require` — e duas regras separadas envelhecem separadas. Então
     * aqui se prova que elas ainda dizem a mesma coisa: onde o caminho novo devolve `null`, o
     * emissor lança.
     */
    @Test
    fun `largura fora do contrato do GS v 0 devolve nulo, e o emissor recusaria igual`() {
        val perfil = layout(384)

        for (largura in intArrayOf(4, 12, 20)) {
            val bitmap =
                requireNotNull(ThermalMonochromeBitmap.of(largura, 2, BooleanArray(largura * 2) { true }))
            assertNull("Largura $largura não fecha em byte.", perfil.monochromeRaster(bitmap))
            assertThrows(IllegalArgumentException::class.java) {
                EscPosRasterEmitter.emit(fonteCheia(largura, 2))
            }
        }

        val oito = requireNotNull(ThermalMonochromeBitmap.of(8, 2, BooleanArray(16) { true }))
        assertNotNull(perfil.monochromeRaster(oito))
    }

    // ------------------------------------------------------------------------------------------
    // O dialeto: este caminho e o unico do layout que o perdia
    // ------------------------------------------------------------------------------------------

    /**
     * **Numa firmware sem `GS`, este caminho nao pode emitir um byte `GS`.**
     *
     * A Diebold IM453H nao tem um unico comando `GS`. Mandar-lhe a regua raster ESC/POS, em 24/08,
     * fez sair dois metros de codigo e o aparelho parar de responder — medido na bancada, e e o
     * motivo de a serie Procomp existir.
     *
     * `imageRaster` e `qrRaster` passam pelo `rasterEmission` escolhido pelo dialeto; este caminho
     * chamava `EscPosRasterEmitter.emit` direto. A assimetria era invisivel de dentro do kit porque
     * o telefone monta cupom pelos outros dois; quem a encontrou foi a auditoria do caminho de mesa,
     * onde `monochromeRaster` e o unico produtor de bytes.
     */
    @Test
    fun `numa firmware sem GS o bitmap composto nao emite um byte GS`() {
        val bytes = requireNotNull(procomp().monochromeRaster(indiceCodificado(8)))

        assertFalse(
            "nenhum 0x1D pode sair para a IM453H, e `GS v 0` comeca com ele",
            bytes.any { it == GS },
        )
    }

    /**
     * O mesmo bitmap sai pelos DOIS emissores, e a diferenca e o envelope inteiro.
     *
     * Nao basta o `GS` sumir: o que sai tem de ser o `ESC n` do dialeto. Sem esta metade, um
     * conserto que devolvesse `ByteArray(0)` passaria na prova de cima — que e exatamente o formato
     * de mentira que este repositorio persegue.
     */
    @Test
    fun `o bitmap composto sai pelo emissor do dialeto, e nao por um caminho proprio`() {
        val bitmap = indiceCodificado(8)
        val fonte = MonochromeBitmapRasterSource(bitmap)

        assertArrayEquals(
            "Procomp: o mesmo `ESC n` que ProcompRasterEmission monta",
            ProcompRasterEmitter.emit(
                fonte,
                ProcompRasterEmitter.centeringMarginDots(bitmap.widthDots, PROCOMP_DOTS),
                null,
            ),
            procomp().monochromeRaster(bitmap),
        )
        assertArrayEquals(
            "ESC/POS: byte a byte o de sempre, e este e o guarda de regressao do conserto",
            EscPosRasterEmitter.emit(fonte, DEFAULT_RASTER_STRIPE_HEIGHT_DOTS, null),
            layout(PROCOMP_DOTS).monochromeRaster(bitmap),
        )
    }

    /**
     * A recusa por largura tambem e do dialeto, e os dois teto sao diferentes.
     *
     * O `GS v 0` carrega a largura em dois bytes (ate 65535 bytes de largura); o `ESC n` carrega em
     * um (ate 255). Manter o teto do ESC/POS depois de rotear pelo dialeto trocaria o `null`
     * acordado por uma excecao de dentro do emissor Procomp — a assinatura deste caminho e
     * `ByteArray?`, e quem chama trata `null`, nao `IllegalArgumentException`.
     *
     * O contrato que esta prova fixa e o mesmo dos dois lados: **onde este caminho devolve `null`, o
     * emissor daquele dialeto lanca.**
     */
    @Test
    fun `a largura recusada e a do dialeto, e nao a do ESC-POS`() {
        // 2048 pontos = 256 bytes: um a mais do que o `ESC n` endereça, e muito abaixo do `GS v 0`.
        val largo = requireNotNull(ThermalMonochromeBitmap.of(2048, 1, BooleanArray(2048)))

        assertNull("o `ESC n` nao endereça 256 bytes de largura", procompLargo().monochromeRaster(largo))
        assertThrows(IllegalArgumentException::class.java) {
            ProcompRasterEmitter.emit(MonochromeBitmapRasterSource(largo), 0, null)
        }
        // E o mesmo bitmap continua valendo no ESC/POS, que e onde ele cabe.
        assertNotNull("o `GS v 0` endereça 256 bytes sem esforço", layout(2048).monochromeRaster(largo))
    }

    // ------------------------------------------------------------------------------------------
    // Apoio
    // ------------------------------------------------------------------------------------------

    /** O layout da IM453H: mesmo bitmap, dialeto Procomp. */
    // MARK: - O quarto caminho: o codigo de barras rasterizado

    /**
     * **O codigo de barras do dialeto Procomp sai sem um byte `GS`.**
     *
     * Este era o quarto caminho que compunha bytes sem consultar o dialeto, e o ultimo conhecido.
     * Os outros tres morreram em 27/08/2026; este sobreviveu porque [ReceiptLayout.barcode] chamava
     * a assinatura publica de `EscPosThermalCommands.barcodeRaster`, que fixa `GS v 0`, em vez de
     * passar o envelope do layout — como o `qrRaster` ao lado ja fazia. Achado pelo lote C41 em
     * 30/08/2026, ao portar o dialeto para o Swift.
     *
     * A prova conta os bytes `GS` porque e o que a firmware nao tem: contar o comando exato deixaria
     * passar qualquer OUTRO `GS` que entrasse depois pelo mesmo descuido.
     */
    @Test
    fun `numa firmware sem GS o codigo de barras rasterizado nao emite um byte GS`() {
        val bytes = requireNotNull(procomp().barcode("123456", humanReadable = false))

        assertEquals(
            "saiu byte GS num cupom Procomp: ${bytes.count { it == GS }} deles",
            0,
            bytes.count { it == GS },
        )
    }

    /**
     * E o `ESC a` do fim, que e a segunda metade do mesmo defeito.
     *
     * O `GS v 0` e precedido de um `ESC a 1` que o proprio emissor poe, e por isso o caminho
     * ESC/POS concatena `ESC a 0` depois do raster. Nesta firmware nao existe `ESC a`: quem
     * posiciona e a margem dentro do cabecalho do `ESC n`, e mandar o comando de volta seria mandar
     * um comando que ela nao conhece depois de cada codigo de barras.
     */
    @Test
    fun `o codigo de barras Procomp nao devolve alinhamento que a firmware nao tem`() {
        val bytes = requireNotNull(procomp().barcode("123456", humanReadable = false))

        assertEquals(
            "sobrou ESC a no fim do codigo de barras Procomp",
            0,
            (0 until bytes.size - 1).count { bytes[it] == ESC && bytes[it + 1] == ALINHAMENTO },
        )
    }

    /**
     * O guarda de regressao do outro lado: o ESC/POS continua byte a byte o de sempre.
     *
     * Rotear pelo envelope nao pode mudar um unico byte do caminho homologado — inclusive o
     * `ESC a 0` do fim, que **tem** de continuar saindo la.
     */
    @Test
    fun `o codigo de barras ESC-POS continua byte a byte o de sempre`() {
        val bytes = requireNotNull(layout(PROCOMP_DOTS).barcode("123456", humanReadable = false))

        assertTrue("o ESC/POS deixou de emitir GS v 0", bytes.any { it == GS })
        assertArrayEquals(
            "o ESC/POS deixou de devolver o alinhamento",
            byteArrayOf(ESC, ALINHAMENTO, ThermalTextAlignment.LEFT.escPosValue.toByte()),
            bytes.copyOfRange(bytes.size - 3, bytes.size),
        )
    }

    private fun procomp(printableDots: Int = PROCOMP_DOTS): ReceiptLayout =
        ReceiptLayout(
            columns = 32,
            dialect = EscPosDialect.PROCOMP_ESC_P,
            qrWidthDots = printableDots,
            hasCutter = false,
            codePage = null,
            printableDots = printableDots,
        )

    /** Area imprimivel larga o bastante para a margem de centragem nao mascarar a recusa. */
    private fun procompLargo(): ReceiptLayout = procomp(printableDots = 2048)

    private fun layout(
        printableDots: Int,
        banda: Int = DEFAULT_RASTER_STRIPE_HEIGHT_DOTS,
        escala: Double? = null,
    ): ReceiptLayout =
        ReceiptLayout(
            columns = 32,
            qrWidthDots = printableDots,
            hasCutter = false,
            codePage = null,
            printableDots = printableDots,
            rasterStripeHeightDots = banda,
            verticalRasterScale = escala,
        )

    /** Bitmap de 16 pontos cujo conteúdo é o índice da linha: nenhuma linha se repete na origem. */
    private fun indiceCodificado(heightDots: Int): ThermalMonochromeBitmap =
        requireNotNull(
            ThermalMonochromeBitmap.of(
                16,
                heightDots,
                BooleanArray(16 * heightDots) { (it / 16) shr (it % 16) and 1 == 1 },
            ),
        )

    private fun bitmapDe(
        widthDots: Int,
        linhas: List<List<Boolean>>,
    ): ThermalMonochromeBitmap =
        requireNotNull(
            ThermalMonochromeBitmap.of(
                widthDots,
                linhas.size,
                BooleanArray(widthDots * linhas.size) { linhas[it / widthDots][it % widthDots] },
            ),
        )

    /** A conversão de imagem alimentada pelo mesmo campo de pixels, sem `Bitmap` de plataforma. */
    private fun imagemPorLimiar(
        banda: Int = DEFAULT_RASTER_STRIPE_HEIGHT_DOTS,
        escala: Double? = null,
    ): ByteArray {
        val geometria = OneBitRasterGeometry.of(LARGURA_FOTO, ALTURA_FOTO, LARGURA_FOTO)
        val fonte =
            PixelOneBitRasterSource(geometria, LeitorCinzaDoCampoDeTeste, ThermalImageMode.THRESHOLD, banda)
        return try {
            EscPosRasterEmitter.emit(fonte, banda, escala)
        } finally {
            fonte.clear()
        }
    }

    /** Fonte toda preta usada só para perguntar ao emissor o que ele faz com largura inválida. */
    private fun fonteCheia(
        largura: Int,
        altura: Int,
    ): OneBitRasterSource =
        object : OneBitRasterSource {
            override val widthDots = largura
            override val heightDots = altura

            override fun readStripe(
                startY: Int,
                stripeHeight: Int,
                destination: ByteArray,
            ) = destination.fill(0xff.toByte())
        }

    /** Desempacota o comando inteiro de volta em linhas de pontos, conferindo a moldura `ESC a`. */
    private fun linhas(
        command: ByteArray,
        widthDots: Int,
    ): List<List<Boolean>> {
        assertArrayEquals(byteArrayOf(0x1b, 0x61, 0x01), command.copyOfRange(0, 3))
        // Sem sufixo, e o teste de paridade acima explica por quê: o emissor Kotlin não devolve o
        // alinhamento. Se um dia devolver, este desempacotador precisa mudar junto.
        var offset = 3
        val saida = mutableListOf<List<Boolean>>()
        while (offset < command.size) {
            assertTrue(command.size - offset >= 8)
            assertArrayEquals(
                byteArrayOf(0x1d, 0x76, 0x30, 0x00),
                command.copyOfRange(offset, offset + 4),
            )
            val widthBytes = (command[offset + 4].toInt() and 0xff) or
                ((command[offset + 5].toInt() and 0xff) shl 8)
            val altura = (command[offset + 6].toInt() and 0xff) or
                ((command[offset + 7].toInt() and 0xff) shl 8)
            assertEquals(widthDots, widthBytes * 8)
            var cursor = offset + 8
            assertTrue(cursor + widthBytes * altura <= command.size)
            repeat(altura) {
                val inicio = cursor
                saida +=
                    (0 until widthDots).map { x ->
                        command[inicio + x / 8].toInt() and (0x80 shr (x % 8)) != 0
                    }
                cursor += widthBytes
            }
            offset = cursor
        }
        assertEquals(command.size, offset)
        return saida
    }

    private fun semDuplicatasConsecutivas(linhas: List<List<Boolean>>): List<List<Boolean>> {
        val saida = mutableListOf<List<Boolean>>()
        for (linha in linhas) if (saida.lastOrNull() != linha) saida += linha
        return saida
    }

    private fun ocorrencias(
        bytes: ByteArray,
        padrao: ByteArray,
    ): Int =
        (0..bytes.size - padrao.size).count { inicio ->
            bytes.copyOfRange(inicio, inicio + padrao.size).contentEquals(padrao)
        }

    private fun bytesDe(hex: String): ByteArray =
        ByteArray(hex.length / 2) { hex.substring(it * 2, it * 2 + 2).toInt(16).toByte() }

    /** O que a plataforma entregaria: cinza opaco, sem filtro — luminância igual ao próprio valor. */
    private object LeitorCinzaDoCampoDeTeste : RasterStripePixelReader {
        override fun readPixels(
            startY: Int,
            stripeHeight: Int,
            destination: IntArray,
        ) {
            for (y in 0 until stripeHeight) {
                for (x in 0 until LARGURA_FOTO) {
                    val cinza = cinzaDoPixel(x, startY + y)
                    destination[y * LARGURA_FOTO + x] =
                        (0xff shl 24) or (cinza shl 16) or (cinza shl 8) or cinza
                }
            }
        }

        override fun clear() = Unit
    }

    private companion object {
        const val QR_PAYLOAD = "PRINTHER-MONO-RASTER-0001"
        const val QR_DOTS = 320
        const val FATOR_T210 = 0.8
        const val LARGURA_FOTO = 64
        const val ALTURA_FOTO = 40
        const val ALTURA_INDICE = 25

        /** Area imprimivel da IM453H em pontos, na largura de 80 mm do cartao de catalogo. */
        const val PROCOMP_DOTS = 576

        /** O primeiro byte de `GS v 0`. Nenhum deles pode sair para uma firmware sem `GS`. */
        const val GS: Byte = 0x1D

        /** `ESC`, e o `a` de `ESC a`. A firmware Procomp nao tem alinhamento. */
        const val ESC: Byte = 0x1B
        const val ALINHAMENTO: Byte = 0x61

        /** A mesma fórmula do teste Swift: um campo com preto e branco alternando sem período 8. */
        fun cinzaDoPixel(
            x: Int,
            y: Int,
        ): Int = if ((x * 3 + y * 5) % 7 < 3) 0 else 255

        // ------------------------------------------------------------------------------------
        // Literais. `MonochromeRasterNaJvmTest` repete os três, palavra por palavra: é o que prova
        // que o MESMO arquivo do núcleo emite o mesmo byte dentro do AAR e fora do Android.
        // ------------------------------------------------------------------------------------

        /** `ESC a 1` + `GS v 0` de 1 byte por 2 linhas + `ff ff`. */
        const val VETOR_OITO_POR_DOIS_TODO_PRETO = "1b61011d76300001000200ffff"

        /** O mesmo, mais as três linhas assimétricas: `80 00`, `00 01`, `ff 00`. */
        const val VETOR_DEZESSEIS_POR_TRES = "1b61011d7630000200030080000001ff00"

        /**
         * O que o Swift emite para a matriz mínima, lido de
         * `ios/Tests/ThermalPrinterKitTests/ThermalMonochromeRasterTests.swift:240-245`.
         *
         * Difere do Kotlin exatamente no `1b6100` do fim. Ver o teste de paridade.
         */
        const val VETOR_SWIFT_OITO_POR_DOIS_TODO_PRETO = "1b61011d76300001000200ffff1b6100"
    }
}
