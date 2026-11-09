package br.com.thermalprinterkit

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * As tres pecas do dialeto Diebold: raster por `ESC n`, prologo por dialeto, e o card de catalogo.
 *
 * Os numeros aqui vem das tiras de 23/08/2026, nao do manual — o manual e da linha `PD1` e a
 * impressora e `PD2`.
 */
class ProcompDialetoTest {
    /** Uma fonte de raster de teste: linhas empacotadas, MSB primeiro, como o contrato exige. */
    private class FonteFixa(
        override val widthDots: Int,
        override val heightDots: Int,
        private val linha: ByteArray,
    ) : OneBitRasterSource {
        override fun readStripe(startY: Int, stripeHeight: Int, destination: ByteArray) {
            for (y in 0 until stripeHeight) {
                linha.copyInto(destination, destinationOffset = y * linha.size)
            }
        }
    }

    @Test
    fun `o cabecalho do ESC n carrega margem, largura e altura`() {
        val fonte = FonteFixa(widthDots = 32, heightDots = 3, linha = byteArrayOf(0xFF.toByte(), 0, 0, 0))

        val bytes = ProcompRasterEmitter.emit(fonte, leftMarginDots = 8)

        assertArrayEquals(
            // ESC n | marg=1 (8 dots) | larg=4 (32 dots) | altura 3 em dois bytes
            byteArrayOf(0x1B, 0x6E, 0x01, 0x04, 0x03, 0x00),
            bytes.copyOfRange(0, 6),
        )
        assertEquals("Faltou byte de imagem.", 6 + 4 * 3 + 1, bytes.size)
        assertEquals("O bloco precisa terminar em LF para ser disparado.", 0x0A.toByte(), bytes.last())
    }

    /**
     * O `LF` final e o que faz a firmware imprimir o bloco.
     *
     * O manual: a impressao e disparada quando o buffer de bitmap enche **ou quando chega comando
     * diferente de grafico**. Sem ele, um bloco pequeno fica esperando — e esperar, nesta
     * impressora, e o estado de onde so se sai desligando e ligando.
     */
    @Test
    fun `o bloco de raster sempre termina em LF`() {
        val fonte = FonteFixa(8, 1, byteArrayOf(0x01))
        assertEquals(0x0A.toByte(), ProcompRasterEmitter.emit(fonte).last())
    }

    @Test
    fun `a compensacao vertical manda mais linhas, e e a mesma conta do caminho ESC POS`() {
        val fonte = FonteFixa(8, 100, byteArrayOf(0xFF.toByte()))

        val alturaSem = somaDasBandas(ProcompRasterEmitter.emit(fonte), larguraBytes = 1)
        val alturaCom =
            somaDasBandas(ProcompRasterEmitter.emit(fonte, verticalRasterScale = 0.95), larguraBytes = 1)

        assertEquals(100, alturaSem)
        // 100 / 0,95 = 105,26 -> 105, pela mesma funcao que o emissor ESC/POS usa.
        assertEquals(compensatedRasterHeightDots(100, 0.95), alturaCom)
        assertTrue("A compensacao precisa mandar MAIS linhas, nunca menos.", alturaCom > alturaSem)
    }

    /**
     * O raster sai **em bandas**, e nenhuma banda usa o `n2`.
     *
     * Correcao de desenho medida em papel em 23/08/2026: um QR de 320 dotlines num `ESC n` unico de
     * 12.807 bytes saiu como rio de caracteres, enquanto 240 bytes com a **mesma largura** sairam
     * como barra solida. Toda sonda que funcionou tinha altura <= 180 — ou seja, `n2 = 0`. Manter
     * a banda dentro do `n1` e ficar na faixa onde ha prova.
     */
    @Test
    fun `o raster sai em bandas, todas com n2 igual a zero`() {
        val fonte = FonteFixa(8, 100, byteArrayOf(0xFF.toByte()))

        val bytes = ProcompRasterEmitter.emit(fonte)
        val alturas = alturasDasBandas(bytes, larguraBytes = 1)

        assertEquals("Bandas de 24 dotlines cobrindo 100 linhas.", listOf(24, 24, 24, 24, 4), alturas)
        assertEquals("O bloco inteiro termina em um unico LF.", 0x0A.toByte(), bytes.last())
        assertEquals(
            "Nenhum LF pode aparecer entre bandas: ele encerraria a imagem e abriria vao branco.",
            1,
            bytes.count { it == 0x0A.toByte() },
        )
    }

    /** Percorre os cabecalhos `ESC n` e devolve a altura declarada de cada banda. */
    private fun alturasDasBandas(bytes: ByteArray, larguraBytes: Int): List<Int> {
        val alturas = mutableListOf<Int>()
        var i = 0
        while (i + 6 <= bytes.size && bytes[i] == 0x1B.toByte() && bytes[i + 1] == 0x6E.toByte()) {
            assertEquals("Banda usando `n2`, fora da faixa medida.", 0, bytes[i + 5].toInt())
            val altura = bytes[i + 4].toInt() and 0xFF
            alturas += altura
            i += 6 + larguraBytes * altura
        }
        return alturas
    }

    private fun somaDasBandas(bytes: ByteArray, larguraBytes: Int): Int =
        alturasDasBandas(bytes, larguraBytes).sum()

    /** Sem `ESC a` nesta firmware, quem centraliza e a margem do proprio grafico. */
    @Test
    fun `a margem de centralizacao arredonda para baixo, em multiplos de 8 dots`() {
        // Folga de 288 dots dividida em duas: 144, que ja e multiplo de 8.
        assertEquals(144, ProcompRasterEmitter.centeringMarginDots(widthDots = 288, printableDots = 576))
        // Folga impar: 576-200=376, metade 188, que desce para 184.
        assertEquals(184, ProcompRasterEmitter.centeringMarginDots(widthDots = 200, printableDots = 576))
        // Imagem maior que a area: sem margem, e nada de margem negativa.
        assertEquals(0, ProcompRasterEmitter.centeringMarginDots(widthDots = 800, printableDots = 576))
    }

    @Test
    fun `o raster Procomp nunca carrega GS`() {
        val fonte = FonteFixa(32, 40, byteArrayOf(0xAA.toByte(), 0x55, 0xF0.toByte(), 0x0F))
        val bytes = ProcompRasterEmitter.emit(fonte, leftMarginDots = 16, verticalRasterScale = 0.95)

        assertFalse(
            "Saiu um GS, que nao existe nesta firmware.",
            bytes.copyOfRange(0, 6).contains(0x1D.toByte()),
        )
    }

    /**
     * **O arroba tem que sumir.**
     *
     * `ESC @` era escrito antes de todo corpo, fixo. Na IM453H ele nao e comando: o `40h` saiu no
     * papel como um arroba na frente de todas as tiras de 23/08. O prologo agora vem do dialeto.
     */
    @Test
    fun `o prologo do dialeto Procomp nao carrega ESC arroba`() {
        val prologo = EscPosDialectGate.prologue(EscPosDialect.PROCOMP_ESC_P)

        prologo.toList().windowed(2).forEach { par ->
            assertFalse(
                "O prologo ainda manda ESC arroba, que vira arroba no papel.",
                par[0] == 0x1B.toByte() && par[1] == 0x40.toByte(),
            )
        }
        assertArrayEquals(ProcompEscP.reset(), prologo)
    }

    /** O contraste: quem fala ESC/POS continua recebendo exatamente o `ESC @` de sempre. */
    @Test
    fun `o prologo Epson nao mudou`() {
        assertArrayEquals(
            byteArrayOf(0x1B, 0x40),
            EscPosDialectGate.prologue(EscPosDialect.EPSON_COMPATIBLE),
        )
    }

    @Test
    fun `so o dialeto Epson recebe pergunta de status`() {
        assertTrue(EscPosDialectGate.usesEscPosStatusQueries(EscPosDialect.EPSON_COMPATIBLE))
        assertFalse(EscPosDialectGate.usesEscPosStatusQueries(EscPosDialect.PROCOMP_ESC_P))
    }

    @Test
    fun `o card da IM453H entra no catalogo com o dialeto proprio`() {
        val card = BundledPrinterDrivers.byId("diebold.im453h.procomp")

        assertEquals(EscPosDialect.PROCOMP_ESC_P, card?.dialect)
        assertEquals(48, card?.printableColumns)
        assertTrue("O card precisa estar na lista de descoberta.", card in BundledPrinterDrivers.all)
    }

    /**
     * **O prologo chega mesmo ao fio.**
     *
     * Este teste existe porque o controle negativo mostrou que nao existia: zerando o prologo
     * Epson, a suite inteira continuava verde. Ninguem afirmava que o `ESC @` sai antes do corpo —
     * a fiacao era codigo nao provado, e o `ESC @` e justamente o byte que apareceu no papel da
     * Diebold. O que nao e afirmado por teste nao esta protegido de sumir num refactor.
     */
    @Test
    fun `o primeiro byte no fio e o prologo do dialeto`() = kotlinx.coroutines.test.runTest {
        val usb = PortaQueGravaTudo()
        val printer =
            LocalWifiThermalPrinter(
                port = PortaWifiMuda(),
                usbPort = usb,
                discovery = LocalWifiPrinterDiscovery { _, _ -> LocalWifiPrinterDiscoveryResult.NotFound },
                networkProvider = LocalWifiNetworkProvider { null },
                profileStore = InMemoryPrinterProfileStore(),
                bluetoothLeScanPolicy = BluetoothLeScanPolicy.ALLOW,
            )

        printer.searchUsb(BundledPrinterDrivers.elginI9Full2.id)
        val candidata =
            (printer.state.value as ThermalPrinterState.UsbCandidatesFound).candidates.single()
        printer.testSearchedUsbPrinter(candidata.id)

        assertArrayEquals(
            "O corpo do recibo comecou sem o prologo do dialeto.",
            byteArrayOf(0x1B, 0x40),
            usb.escrito.take(2).toByteArray(),
        )
    }

    private class PortaQueGravaTudo : UsbThermalPort {
        val escrito = mutableListOf<Byte>()

        override fun discover(profile: PrinterDriverProfile) =
            listOf(UsbPrinterHandle(1, "Impressora USB 1"))

        override suspend fun open(handle: UsbPrinterHandle, profile: PrinterDriverProfile) = Unit

        override fun close() = Unit

        override fun write(data: ByteArray) {
            escrito += data.toList()
        }

        override fun coverStatus() = ThermalCoverStatus.CLOSED

        override fun paperStatus() = ThermalPaperStatus.PRESENT
    }

    private class PortaWifiMuda : LocalWifiThermalPort {
        override fun open(
            network: LocalWifiNetwork,
            endpoint: LocalWifiPrinterEndpoint,
            profile: PrinterDriverProfile,
        ) = Unit

        override fun close() = Unit

        override fun write(data: ByteArray) = Unit

        override fun coverStatus() = ThermalCoverStatus.CLOSED

        override fun paperStatus() = ThermalPaperStatus.PRESENT
    }

    /**
     * O card compoe cupom, e **nao** fala ESC/POS. As duas ao mesmo tempo.
     *
     * Este teste ja se chamou "continua recusado pelo portao", e o nome ficou mentiroso quando a
     * composicao passou a falar o dialeto. Um nome de teste que descreve o passado e pior que teste
     * nenhum: ele afirma para quem le uma coisa que o corpo nao verifica mais.
     */
    @Test
    fun `o card novo compoe cupom sem falar ESC POS`() {
        val card = requireNotNull(BundledPrinterDrivers.byId("diebold.im453h.procomp"))

        assertTrue(EscPosDialectGate.composesReceipt(card.dialect))
        assertFalse(EscPosDialectGate.emitsEscPos(card.dialect))
    }

    /**
     * O texto composto no dialeto Procomp nao carrega comando ESC/POS de texto.
     *
     * `ESC a` (alinhamento) e `GS !` (tamanho) nao existem nesta firmware: alinhar e preencher, e
     * tamanho e liga/desliga. O acento sai em ABICOMP direto, sem `ESC t` — a tabela de fabrica
     * dela, provada em papel em 23/08/2026.
     */
    @Test
    fun `o texto Procomp alinha por preenchimento e acentua em ABICOMP`() {
        val layout =
            ReceiptLayout.from(requireNotNull(BundledPrinterDrivers.byId("diebold.im453h.procomp")))

        val bytes = layout.text("acao", ThermalTextAlignment.CENTER, ThermalTextStyle.BOLD, ThermalTextSize.NORMAL)
        val comAcento =
            layout.text("a\u00E7\u00E3o", ThermalTextAlignment.LEFT, ThermalTextStyle.NORMAL, ThermalTextSize.NORMAL)

        assertFalse("Saiu `ESC a`, que nao existe nesta firmware.", parEm(bytes, 0x1B, 0x61))
        assertFalse("Saiu `GS !`, que nao existe nesta firmware.", parEm(bytes, 0x1D, 0x21))
        assertTrue("A enfase nao saiu por `ESC E`.", parEm(bytes, 0x1B, 0x45))
        assertTrue("O texto centralizado nao foi preenchido com espaco.", bytes.contains(0x20))
        assertTrue("O cedilha nao saiu em ABICOMP (C6h).", comAcento.contains(0xC6.toByte()))
        assertFalse("Saiu `ESC t`, e a tabela de fabrica ja e a certa.", parEm(comAcento, 0x1B, 0x74))
    }

    private fun parEm(bytes: ByteArray, primeiro: Int, segundo: Int): Boolean =
        bytes.toList().windowed(2).any {
            it[0] == primeiro.toByte() && it[1] == segundo.toByte()
        }
}
