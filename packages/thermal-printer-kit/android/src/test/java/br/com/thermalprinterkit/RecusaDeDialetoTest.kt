package br.com.thermalprinterkit

import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Impressora de dialeto que o kit não emite **não recebe byte nenhum**.
 *
 * Medido em 23/08/2026 numa Diebold IM453H: o comprovante ESC/POS do kit não só saiu ilegível — a
 * impressora **travou**, a tecla física de avanço parou de responder, e o `ESC r` da própria
 * firmware, descrito no manual dela como "tratado na recepção", não recuperou. Só desligar e ligar.
 *
 * Por isso a asserção destes testes não é "devolveu erro": é **zero bytes escritos**. Devolver erro
 * depois de ter escrito o prólogo já teria travado a impressora — e o prólogo existe: o transporte
 * manda `DLE EOT` de status e `ESC @` de init antes do corpo, e foi o `ESC @` que apareceu como "@"
 * no papel da bancada.
 */
class RecusaDeDialetoTest {
    private val diebold =
        MeasuredProfile(
            id = "8b1f0d24-6c3a-4f57-9a10-2d47e5c9b083",
            displayName = "Impressora híbrida 80 mm",
            transports = setOf(PrinterTransport.USB),
            paperWidthMm = 80,
            printableColumns = 48,
            printableDots = 576,
            codePage = null,
            cutProtocol = CutProtocol.NONE,
            cutFeedLines = 0,
            dialect = EscPosDialect.PROCOMP_ESC_P,
            statusProtocol = PrinterStatusProtocol.NONE,
            measuredAtEpochMillis = 1_787_500_000_000,
            source = PrinterProfileSource.MEASURED,
        )

    /**
     * As duas perguntas do portao sao diferentes, e confundi-las foi o risco deste arquivo.
     *
     * `composesReceipt` decide se ha cupom para compor — e so ela pode abrir a porta.
     * `emitsEscPos` decide o **formato dos bytes**. A Diebold responde "sim, componho" e
     * "nao, nao falo ESC/POS": as duas coisas ao mesmo tempo, e e por isso que sao duas perguntas.
     */
    @Test
    fun `todo dialeto tem composicao, e so o Epson fala ESC POS`() {
        EscPosDialect.entries.forEach { dialeto ->
            assertTrue(
                "O dialeto $dialeto chegaria ao fio sem o kit saber compor cupom nele.",
                EscPosDialectGate.composesReceipt(dialeto),
            )
        }
        assertTrue(EscPosDialectGate.emitsEscPos(EscPosDialect.EPSON_COMPATIBLE))
        assertFalse(EscPosDialectGate.emitsEscPos(EscPosDialect.PROCOMP_ESC_P))
    }

    /**
     * A impressora de dialeto Procomp **imprime**, e o primeiro byte no fio nao e ESC/POS.
     *
     * Este teste substituiu o que afirmava recusa. A recusa era a resposta certa enquanto nao havia
     * emissor; agora ha, e insistir nela seria afirmar algo que deixou de ser verdade. O que
     * continua tendo de ser verdade — e e o que protege o aparelho — e que **nenhum prologo
     * ESC/POS** alcance esta firmware: nem o `ESC @`, que ja saiu como arroba no papel, nem os
     * `DLE EOT` de status, que ela nao responde.
     */
    @Test
    fun `candidata USB de dialeto Procomp imprime sem prologo ESC POS`() = runTest {
        val usb = ContandoBytesUsbPort()
        val printer = printerCom(usb)

        printer.searchUsb(diebold.id)
        val candidata =
            (printer.state.value as ThermalPrinterState.UsbCandidatesFound).candidates.single()

        assertSame(ThermalPrintResult.Printed, printer.testSearchedUsbPrinter(candidata.id))
        assertTrue("Nada chegou ao fio.", usb.bytesEscritos > 0)
        assertArrayEquals(
            "O prologo ESC/POS vazou para uma firmware que nao o entende.",
            ProcompEscP.reset(),
            usb.primeiros(ProcompEscP.reset().size),
        )
        assertFalse(
            "Saiu `DLE EOT`, que esta firmware nao responde.",
            usb.contemPar(0x10, 0x04),
        )
        assertFalse(
            "Saiu `ESC @`, que nesta impressora vira arroba no papel.",
            usb.contemPar(0x1B, 0x40),
        )
        // O cupom Procomp sai **com raster**, por `ESC n`, desde 24/08/2026.
        //
        // Esta asserção já foi a oposta, e a inversão vale ser lembrada. Enquanto o comprovante
        // saía como rio de caractere, a leitura era que o raster Procomp não servia, e o cupom
        // saía sem QR de proposito. O papel provou outra coisa: os bytes de `ESC n` do cupom saem
        // como QR legivel na IM453H — sozinhos, com o texto na frente, e como cupom inteiro. O que
        // chegava torto na impressora era `GS v0`, porque a descoberta trocava o card Procomp por
        // um perfil temporario em ESC/POS. Ver `rasterProven` no layout e `DialetoNaDescobertaTest`.
        assertTrue(
            "O cupom Procomp saiu sem raster; o QR dele vira `ESC n`.",
            usb.contemPar(0x1B, 0x6E),
        )
        // E continua sem o raster do outro dialeto: `GS v 0` foi exatamente o que travou o
        // aparelho, e nenhuma firmware Procomp tem comando `GS`.
        assertFalse(
            "Vazou raster ESC/POS num dialeto que nao tem `GS`.",
            usb.contemPar(0x1D, 0x76),
        )
    }

    /** O contraste: o mesmo caminho, com dialeto conhecido, continua escrevendo. */
    @Test
    fun `o mesmo caminho com dialeto conhecido continua imprimindo`() = runTest {
        val usb = ContandoBytesUsbPort()
        val printer = printerCom(usb)

        printer.searchUsb(BundledPrinterDrivers.elginI9Full2.id)
        val candidata =
            (printer.state.value as ThermalPrinterState.UsbCandidatesFound).candidates.single()

        assertSame(ThermalPrintResult.Printed, printer.testSearchedUsbPrinter(candidata.id))
        assertTrue("O caminho conhecido parou de escrever.", usb.bytesEscritos > 0)
    }

    /** O dialeto medido sobrevive ao disco: o perfil descreve a impressora, não o que sabemos fazer. */
    @Test
    fun `o dialeto recusado ainda faz ida e volta no store`() {
        val store = InMemoryPrinterProfileStore()
        store.save(diebold)

        val relido = store.read().single { it.id == diebold.id }

        assertEquals(EscPosDialect.PROCOMP_ESC_P, relido.dialect)
    }

    private fun printerCom(usb: UsbThermalPort) =
        LocalWifiThermalPrinter(
            port = PortaWifiSilenciosa(),
            usbPort = usb,
            discovery = LocalWifiPrinterDiscovery { _, _ -> LocalWifiPrinterDiscoveryResult.NotFound },
            networkProvider = LocalWifiNetworkProvider { null },
            profileStore = InMemoryPrinterProfileStore().apply { save(diebold) },
            bluetoothLeScanPolicy = BluetoothLeScanPolicy.ALLOW,
        )

    private class ContandoBytesUsbPort : UsbThermalPort {
        private val fio = mutableListOf<Byte>()

        val bytesEscritos: Int get() = fio.size

        fun primeiros(quantos: Int): ByteArray = fio.take(quantos).toByteArray()

        /**
         * Procura um **par** de bytes, e nao um byte solto.
         *
         * Byte solto nao serve de invariante aqui: dentro do raster os pixels sao arbitrarios, e um
         * `1Dh` de pixel nao e um comando `GS`. O que se pode afirmar e sobre as sequencias de
         * comando que o prologo e a composicao emitem.
         */
        fun contemPar(primeiro: Int, segundo: Int): Boolean =
            fio.windowed(2).any {
                it[0] == primeiro.toByte() && it[1] == segundo.toByte()
            }

        override fun discover(profile: PrinterDriverProfile): List<UsbPrinterHandle> =
            listOf(UsbPrinterHandle(1, "Impressora USB 1"))

        override suspend fun open(handle: UsbPrinterHandle, profile: PrinterDriverProfile) = Unit

        override fun close() = Unit

        override fun write(data: ByteArray) {
            fio += data.toList()
        }

        override fun coverStatus() = ThermalCoverStatus.CLOSED

        override fun paperStatus() = ThermalPaperStatus.PRESENT
    }

    private class PortaWifiSilenciosa : LocalWifiThermalPort {
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
}
