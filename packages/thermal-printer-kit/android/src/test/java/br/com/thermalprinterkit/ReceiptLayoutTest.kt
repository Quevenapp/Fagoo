package br.com.thermalprinterkit

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class ReceiptLayoutTest {
    // Perfis operacionais explícitos vivem só no teste; o catálogo de produção não guarda mais as
    // configurações antigas enquanto a bancada re-homologa os modelos.
    private val counter =
        ReceiptLayout.from(
            BundledPrinterDrivers.elginI9Full2.copy(
                hasCutter = true,
                cutProtocol = CutProtocol.GS_V_1,
                cutFeedLines = 5,
            ),
        )
    private val portable = ReceiptLayout.from(BundledPrinterDrivers.portable58mm)

    /**
     * A altura de banda do raster é campo do layout, e nasce no padrão publicado.
     *
     * Teste de neutralidade do botão de bancada: quem monta cupom sem pedir altura nenhuma continua
     * com 24 linhas por `GS v 0`, que é o que sai desde o M1.
     */
    @Test
    fun `layout montado sem pedir altura de banda nasce no padrao publicado`() {
        assertEquals(DEFAULT_RASTER_STRIPE_HEIGHT_DOTS, portable.rasterStripeHeightDots)
        assertEquals(DEFAULT_RASTER_STRIPE_HEIGHT_DOTS, counter.rasterStripeHeightDots)
        assertEquals(
            portable,
            ReceiptLayout.from(
                BundledPrinterDrivers.portable58mm,
                rasterStripeHeightDots = DEFAULT_RASTER_STRIPE_HEIGHT_DOTS,
            ),
        )
    }

    @Test
    fun `a bancada escolhe a altura, e altura impossivel nao vira cupom`() {
        val curta =
            ReceiptLayout.from(BundledPrinterDrivers.portable58mm, rasterStripeHeightDots = 4)

        assertEquals(4, curta.rasterStripeHeightDots)
        // O resto do cupom não muda por causa da banda: texto, corte e página continuam os mesmos.
        assertEquals(portable.copy(rasterStripeHeightDots = 4), curta)
        listOf(0, 25).forEach { invalida ->
            assertThrows(IllegalArgumentException::class.java) {
                ReceiptLayout.from(
                    BundledPrinterDrivers.portable58mm,
                    rasterStripeHeightDots = invalida,
                )
            }
        }
    }

    @Test
    fun `each profile carries its own paper width`() {
        assertEquals(48, counter.columns)
        assertEquals(32, portable.columns)
        assertEquals(576, counter.printableDots)
        assertEquals(384, portable.printableDots)
    }

    /** O QR não pode passar da área imprimível de uma portátil de 384 dots. */
    @Test
    fun `the qr never exceeds the printable area`() {
        assertTrue(counter.qrWidthDots <= BundledPrinterDrivers.elginI9Full2.printableDots)
        assertTrue(portable.qrWidthDots <= BundledPrinterDrivers.portable58mm.printableDots)
        assertEquals(0, portable.qrWidthDots % 8)
    }

    @Test
    fun `a printer without a cutter feeds instead of cutting`() {
        val cut = requireNotNull(EscPosThermalCommands.cut(5, CutProtocol.GS_V))
        val fed = requireNotNull(EscPosThermalCommands.advance(4))

        assertTrue(counter.finish().contentEquals(cut))
        assertTrue(portable.finish().contentEquals(fed))
    }

    /**
     * O comando de corte é da impressora, e não do padrão.
     *
     * A Bematech MP-4200 TH fala ESC/POS compatível em tudo o mais e **ignora o `GS V`** — provado
     * em papel pela `CutCommandProbe`. Um perfil que mandasse o corte moderno para ela imprimiria o
     * cupom inteiro e deixaria o rolo sem cortar, que foi o defeito de bancada.
     */
    @Test
    fun `o dialeto antigo corta com ESC m`() {
        val mp4200 = ReceiptLayout(
            columns = 48,
            qrWidthDots = 320,
            hasCutter = true,
            cutProtocol = CutProtocol.ESC_M,
        )

        val bytes = mp4200.finish()

        // LF x5 (avança) · ESC m (corte parcial no dialeto antigo). O avanço era `ESC d 5`, e o
        // teste mudou porque a própria MP-4200 ignora esse comando: na sonda de avanço as oito
        // tiras saíram do mesmo tamanho. Quebra de linha ela obedece, senão não imprimiria cupom.
        assertArrayEquals(byteArrayOf(0x0a, 0x0a, 0x0a, 0x0a, 0x0a, 0x1b, 0x6d), bytes)
    }

    /**
     * Corte **parcial** (`GS V 1`), e não total.
     *
     * Este teste afirmava `GS V 0` — corte total — e mudou porque o balcão mostrou o problema: numa
     * Cupons soltos podem encavalar na bancada. O corte parcial deixa cada tira presa por um filete
     * até a entrega e preserva a ordem da sequência.
     */
    @Test
    fun `the cutter asks for a partial cut`() {
        // O avanço vai em cinco quebras de linha; `ESC d` saiu porque a MP-4200 o ignora.
        assertArrayEquals(
            byteArrayOf(0x0a, 0x0a, 0x0a, 0x0a, 0x0a, 0x1d, 0x56, 0x01),
            counter.finish(),
        )
    }

    /**
     * O avanço mora só no fecho. Duas fontes de avanço deixaram 10 linhas em branco antes da
     * serrilha na primeira impressão real.
     */
    @Test
    fun `the tail carries exactly one feed`() {
        // A invariante continua sendo "uma fonte de avanço só", agora contada em quebras de linha:
        // o fecho da portátil é exatamente o avanço, sem nenhum outro byte junto.
        assertArrayEquals(ByteArray(4) { 0x0a }, portable.finish())
    }

    @Test
    fun `short lines are left untouched`() {
        assertEquals("Impressora pronta", portable.wrap("Impressora pronta"))
    }

    @Test
    fun `long lines break on word boundaries within the width`() {
        val text = "Permite avaliar e abrir protocolo - expira em 01/01/2026 10:00"

        val wrapped = portable.wrap(text)

        assertTrue(wrapped.lines().all { it.length <= 32 })
        assertEquals(text, wrapped.replace("\n", " "))
        assertTrue(wrapped.contains("\n"))
    }

    /** A mesma frase cabe inteira na impressora de balcão. */
    @Test
    fun `the counter printer does not break what already fits`() {
        val text = "Permite avaliar e abrir protocolo"

        assertEquals(text, counter.wrap(text))
    }

    @Test
    fun `a word longer than the line is split instead of lost`() {
        val text = "A".repeat(70)

        val wrapped = portable.wrap(text)

        assertTrue(wrapped.lines().all { it.length <= 32 })
        assertEquals(text, wrapped.replace("\n", ""))
    }

    @Test
    fun `existing line breaks are preserved`() {
        assertEquals("uma\noutra", portable.wrap("uma\noutra"))
    }

    /**
     * O nome do produto sai em corpo dobrado, e cada caractere come duas colunas.
     *
     * Contar 32 numa linha onde cabem 16 devolve ao papel algo que a firmware parte sozinha, no
     * meio da palavra: "PASTELÃO DE CARNE" saiu do laboratório como `PASTELAO DE CARN` e um `E`
     * órfão embaixo. O nome do produto é a única coisa que diz ao cliente o que ele comprou.
     */
    @Test
    fun `double size text wraps at half the columns`() {
        val wrapped = portable.wrap("PASTELAO DE CARNE", scale = 2)

        assertTrue("nenhuma linha pode passar de 16: $wrapped", wrapped.lines().all { it.length <= 16 })
        assertEquals("PASTELAO DE CARNE", wrapped.replace("\n", " "))
        // A quebra tem que cair no espaço, não dentro de "CARNE".
        assertEquals(listOf("PASTELAO DE", "CARNE"), wrapped.lines())
    }

    @Test
    fun `tamanho tipado mantém GS e quebra na mesma largura`() {
        val size = ThermalTextSize(widthMultiplier = 2, heightMultiplier = 3)

        val bytes =
            portable.text(
                "PASTELAO DE CARNE",
                ThermalTextAlignment.CENTER,
                ThermalTextStyle.BOLD,
                size,
            )

        assertTrue(bytes.toList().windowed(3).contains(listOf(0x1d, 0x21, 0x12).map(Int::toByte)))
        assertTrue(bytes.toList().takeLast(3) == listOf(0x1d, 0x21, 0x00).map(Int::toByte))
        assertEquals(listOf("PASTELAO DE", "CARNE"), portable.wrap("PASTELAO DE CARNE", size).lines())
    }

    @Test
    fun `multiplicadores fora do limite seguro são recusados`() {
        assertThrows(IllegalArgumentException::class.java) {
            ThermalTextSize(widthMultiplier = 0, heightMultiplier = 1)
        }
        assertThrows(IllegalArgumentException::class.java) {
            ThermalTextSize(widthMultiplier = 1, heightMultiplier = 9)
        }
    }

    // -- Coluna de valor alinhada à direita ------------------------------------------------------
    //
    // `ThermalTextAlignment.RIGHT` não resolve isto: descrição e valor dividem a MESMA linha, e o
    // alinhamento do ESC/POS vale para a linha inteira. Quem posiciona é a contagem de colunas.

    @Test
    fun `a value column lands on the right margin in both paper widths`() {
        val largo = counter.entry("Cerveja", "R$ 60,00", '.')
        val estreito = portable.entry("Cerveja", "R$ 60,00", '.')

        assertEquals(48, largo.length)
        assertEquals(32, estreito.length)
        assertTrue(largo.startsWith("Cerveja."))
        assertTrue(largo.endsWith("R$ 60,00"))
        assertTrue(estreito.endsWith("R$ 60,00"))
    }

    @Test
    fun `description and value never touch`() {
        // Sem a coluna de respiro os dois viram uma palavra só na leitura.
        val linha = portable.entry("a".repeat(60), "R$ 1,00")
        assertEquals(32, linha.length)
        assertTrue(linha.endsWith(" R$ 1,00"))
    }

    /** O valor é o que a pessoa confere contra a gaveta: cortar o nome do produto é o mal menor. */
    @Test
    fun `an oversized description is trimmed instead of the value`() {
        val linha = portable.entry("Refrigerante de guarana bem gelado  12x", "R$ 1.234,50")
        assertEquals(32, linha.length)
        assertTrue(linha.endsWith("R$ 1.234,50"))
    }

    /** Valor que ocupa a linha inteira: a descrição sobe, e nenhum dos dois é truncado. */
    @Test
    fun `a value wider than the paper pushes the description to its own line`() {
        val linha = portable.entry("Total", "R$ 1.234.567.890,00 em vendas do periodo")
        assertTrue(linha.startsWith("Total\n"))
        assertTrue(linha.endsWith("periodo"))
    }

    // --- modo de emissão de código -------------------------------------------------------------

    /**
     * Layouts de todas as combinações que mudam bytes de raster: largura, compensação vertical,
     * altura de banda e página. É a matriz do teste de byte-identidade.
     */
    private fun matrizDeLayouts(): List<ReceiptLayout> =
        listOf(
            BundledPrinterDrivers.portable58mm,
            BundledPrinterDrivers.elginI9Full2,
            BundledPrinterDrivers.elginI9Full2.copy(
                codePage = ThermalCodePage.CP850,
                textEncoding = ThermalTextEncoding.SINGLE_BYTE_CODE_PAGE,
            ),
        ).flatMap { perfil ->
            listOf(null, 0.80, 0.5).flatMap { fator ->
                listOf(DEFAULT_RASTER_STRIPE_HEIGHT_DOTS, 8).map { banda ->
                    ReceiptLayout.from(
                        perfil.copy(verticalRasterScale = fator),
                        rasterStripeHeightDots = banda,
                    )
                }
            }
        }

    /**
     * **A prova de que o modo padrão não mudou um byte.**
     *
     * `qr()` no padrão não é "equivalente" a `qrRaster()`: é a mesma chamada, e este teste fixa
     * isso para toda combinação que mexe em raster. Se um dia alguém acrescentar um caminho
     * paralelo no ramo padrão, é aqui que a divergência aparece — e não no papel.
     */
    @Test
    fun `o modo padrao emite exatamente os bytes de qrRaster`() {
        val payloads = listOf("https://queven.app/p/1", "A", "0123456789".repeat(6))
        matrizDeLayouts().forEach { layout ->
            assertEquals(ThermalCodeEmission.RASTERIZED, layout.qrEmission)
            assertEquals(ThermalCodeEmission.RASTERIZED, layout.barcodeEmission)
            payloads.forEach { payload ->
                assertArrayEquals(
                    "Layout $layout com payload $payload",
                    layout.qrRaster(payload),
                    layout.qr(payload),
                )
            }
        }
    }

    /** O mesmo para o código de barras: o ramo padrão passa pelo emissor raster de sempre. */
    @Test
    fun `o modo padrao do codigo de barras e o emissor raster mais a legenda`() {
        val layout = ReceiptLayout.from(BundledPrinterDrivers.elginI9Full2)
        val valor = "QUEVEN-123"
        val moduleWidth =
            requireNotNull(
                ThermalBarcode.moduleWidthDots(
                    valor,
                    ThermalBarcodeSymbology.CODE_128,
                    layout.printableDots,
                ),
            )
        val barras =
            requireNotNull(
                EscPosThermalCommands.barcodeRaster(
                    valor,
                    ThermalBarcodeSymbology.CODE_128,
                    moduleWidth,
                    ThermalBarcode.DEFAULT_HEIGHT_DOTS,
                    layout.printableDots,
                    null,
                ),
            )

        assertArrayEquals(barras, layout.barcode(valor, humanReadable = false))
        assertArrayEquals(
            barras +
                layout.text(
                    valor + "\n",
                    ThermalTextAlignment.CENTER,
                    ThermalTextStyle.NORMAL,
                    ThermalTextSize.NORMAL,
                ),
            layout.barcode(valor),
        )
    }

    /**
     * A trava: preferência que a medição não sustenta cai no padrão antes de virar byte.
     *
     * Capacidade ausente é `null` — ninguém mediu —, e ausente trava igual à medida-não. Preferência
     * guardada no app pode estar velha; quem sabe o que a firmware faz é o perfil.
     */
    @Test
    fun `a preferencia nativa nao sobrevive a capacidade ausente`() {
        val tudoNativo =
            ThermalCodeEmissionPreferences(
                qrEmission = ThermalCodeEmission.NATIVE,
                barcodeEmission = ThermalCodeEmission.NATIVE,
            )
        val semMedicao = BundledPrinterDrivers.elginI9Full2
        assertEquals(null, semMedicao.nativeQrHonored)
        assertEquals(null, semMedicao.nativeBarcodeHonored)

        val travado = ReceiptLayout.from(semMedicao, codeEmission = tudoNativo)

        assertEquals(ThermalCodeEmission.RASTERIZED, travado.qrEmission)
        assertEquals(ThermalCodeEmission.RASTERIZED, travado.barcodeEmission)
        assertArrayEquals(travado.qrRaster("abc"), travado.qr("abc"))

        val recusado =
            ReceiptLayout.from(
                semMedicao.copy(nativeQrHonored = false, nativeBarcodeHonored = false),
                codeEmission = tudoNativo,
            )
        assertEquals(ThermalCodeEmission.RASTERIZED, recusado.qrEmission)
        assertEquals(ThermalCodeEmission.RASTERIZED, recusado.barcodeEmission)
    }

    /**
     * As duas capacidades são independentes: firmware que atende ao `GS k` pode ignorar o
     * `GS ( k`. Medir as duas juntas seria decidir por medição que não existe.
     */
    @Test
    fun `capacidade medida de um comando nao libera o outro`() {
        val tudoNativo =
            ThermalCodeEmissionPreferences(
                qrEmission = ThermalCodeEmission.NATIVE,
                barcodeEmission = ThermalCodeEmission.NATIVE,
            )

        val soQr =
            ReceiptLayout.from(
                BundledPrinterDrivers.elginI9Full2.copy(nativeQrHonored = true),
                codeEmission = tudoNativo,
            )
        assertEquals(ThermalCodeEmission.NATIVE, soQr.qrEmission)
        assertEquals(ThermalCodeEmission.RASTERIZED, soQr.barcodeEmission)

        val soBarras =
            ReceiptLayout.from(
                BundledPrinterDrivers.elginI9Full2.copy(nativeBarcodeHonored = true),
                codeEmission = tudoNativo,
            )
        assertEquals(ThermalCodeEmission.RASTERIZED, soBarras.qrEmission)
        assertEquals(ThermalCodeEmission.NATIVE, soBarras.barcodeEmission)
    }

    /** Capacidade medida sem preferência nenhuma continua rasterizando: quem pede é o hospedeiro. */
    @Test
    fun `capacidade medida sozinha nao muda o cupom`() {
        val layout =
            ReceiptLayout.from(
                BundledPrinterDrivers.elginI9Full2.copy(
                    nativeQrHonored = true,
                    nativeBarcodeHonored = true,
                ),
            )

        assertEquals(ThermalCodeEmission.RASTERIZED, layout.qrEmission)
        assertEquals(ThermalCodeEmission.RASTERIZED, layout.barcodeEmission)
    }

    /** No modo nativo o cupom vira comando, e o tamanho de módulo vem da conta, não de chute. */
    @Test
    fun `o modo nativo pede o codigo a firmware`() {
        val layout =
            ReceiptLayout.from(
                BundledPrinterDrivers.elginI9Full2.copy(
                    nativeQrHonored = true,
                    nativeBarcodeHonored = true,
                ),
                codeEmission =
                    ThermalCodeEmissionPreferences(
                        qrEmission = ThermalCodeEmission.NATIVE,
                        barcodeEmission = ThermalCodeEmission.NATIVE,
                    ),
            )
        val payload = "https://queven.app/p/1"
        val lado =
            requireNotNull(
                EscPosThermalCommands.qrModuleSide(payload, ReceiptLayout.DEFAULT_QR_ERROR_CORRECTION),
            )
        val moduloQr = layout.qrWidthDots / (lado + 2 * ThermalBarcode.QR_QUIET_ZONE_MODULES)

        assertArrayEquals(
            EscPosThermalCommands.qrNative(
                payload,
                moduloQr,
                ReceiptLayout.DEFAULT_QR_ERROR_CORRECTION,
            ),
            layout.qr(payload),
        )

        val valor = "QUEVEN-123"
        val moduloBarras =
            requireNotNull(
                ThermalBarcode.moduleWidthDots(
                    valor,
                    ThermalBarcodeSymbology.CODE_128,
                    layout.printableDots,
                ),
            )
        assertArrayEquals(
            EscPosThermalCommands.barcodeNative(
                valor,
                ThermalBarcodeSymbology.CODE_128,
                moduloBarras,
                ThermalBarcode.DEFAULT_HEIGHT_DOTS,
                true,
            ),
            layout.barcode(valor),
        )
    }

    /**
     * A legenda leva o conteúdo **normalizado**: EAN-13 digitado com doze dígitos sai com o
     * verificador que o kit calculou, e barras e legenda carregam o mesmo número.
     */
    @Test
    fun `a legenda do codigo sai com o conteudo normalizado`() {
        val layout = ReceiptLayout.from(BundledPrinterDrivers.elginI9Full2)
        val doze = "789100031234"
        val treze =
            (ThermalBarcode.validate(doze, ThermalBarcodeSymbology.EAN_13) as ThermalBarcodeValidation.Accepted)
                .normalized

        val cupom = requireNotNull(layout.barcode(doze, ThermalBarcodeSymbology.EAN_13))
        val legenda =
            layout.text(
                treze + "\n",
                ThermalTextAlignment.CENTER,
                ThermalTextStyle.NORMAL,
                ThermalTextSize.NORMAL,
            )

        assertEquals(13, treze.length)
        assertTrue(cupom.toList().windowed(legenda.size).any { it == legenda.toList() })
    }

    /** Conteúdo que não vira símbolo, e símbolo que não cabe, não viram cupom pela metade. */
    @Test
    fun `codigo invalido ou que nao cabe devolve nada`() {
        val layout = ReceiptLayout.from(BundledPrinterDrivers.portable58mm)

        assertEquals(null, layout.barcode("", ThermalBarcodeSymbology.CODE_128))
        assertEquals(null, layout.barcode("12345", ThermalBarcodeSymbology.EAN_13))
        // Cento e vinte e oito caracteres cabem no Code 128 e não cabem em 384 dots.
        assertEquals(null, layout.barcode("A".repeat(128), ThermalBarcodeSymbology.CODE_128))
    }

    /**
     * O inicializador cru continua permissivo: quem monta layout à mão não tem perfil para
     * consultar, como já vale para `qrWidthDots` e para a compensação vertical.
     */
    @Test
    fun `o layout cru aceita o modo que o chamador pedir`() {
        val cru =
            ReceiptLayout(
                columns = 48,
                qrWidthDots = 320,
                hasCutter = false,
                cutProtocol = CutProtocol.NONE,
                cutFeedLines = 0,
                printableDots = 576,
                qrEmission = ThermalCodeEmission.NATIVE,
                barcodeEmission = ThermalCodeEmission.NATIVE,
            )

        assertEquals(ThermalCodeEmission.NATIVE, cru.qrEmission)
        assertEquals(ThermalCodeEmission.NATIVE, cru.barcodeEmission)
    }

    /** Campo novo que não entra na igualdade é campo que some numa comparação de layouts. */
    @Test
    fun `o modo de emissao entra na igualdade do layout`() {
        val base = ReceiptLayout.from(BundledPrinterDrivers.elginI9Full2)

        assertTrue(base != base.copy(qrEmission = ThermalCodeEmission.NATIVE))
        assertTrue(base != base.copy(barcodeEmission = ThermalCodeEmission.NATIVE))
        assertEquals(base, base.copy())
    }
}
