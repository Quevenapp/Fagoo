package br.com.thermalprinterkit

import java.nio.charset.StandardCharsets
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test

/**
 * O ponto de injeção neutro do hospedeiro.
 *
 * O que estes testes protegem não é a existência do gancho: é a **posição** dele, e a **cobertura**
 * dele. Um rodapé concatenado depois de `finish()` compila, passa em qualquer teste de conteúdo e
 * sai do outro lado da guilhotina — no cupom seguinte, para o cliente seguinte. E um comprovante
 * que escapa da decoração não quebra nada: só sai sem o carimbo do app, e ninguém descobre até o
 * papel estar na mão.
 */
class ReceiptDecorationTest {
    private val profile =
        BundledPrinterDrivers.elginI9Full2.copy(
            hasCutter = true,
            cutProtocol = CutProtocol.GS_V_1,
            cutFeedLines = 5,
        )

    private fun decoration(header: String? = null, footer: String? = null) =
        object : ReceiptDecoration {
            override fun header(layout: ReceiptLayout): ByteArray? =
                header?.let {
                    layout.text(it, ThermalTextAlignment.CENTER, ThermalTextStyle.NORMAL, ThermalTextSize.NORMAL)
                }

            override fun footer(layout: ReceiptLayout): ByteArray? =
                footer?.let {
                    layout.text(it, ThermalTextAlignment.CENTER, ThermalTextStyle.NORMAL, ThermalTextSize.NORMAL)
                }
        }

    /** Sem decoração, o kit precisa emitir exatamente os mesmos bytes de sempre. */
    @Test
    fun `sem decoracao o corte e byte a byte o mesmo`() {
        val semGancho = ReceiptLayout.from(profile).finish()
        val comGanchoVazio = ReceiptLayout.from(profile, decoration()).finish()
        val cru = requireNotNull(EscPosThermalCommands.cut(5, CutProtocol.GS_V_1))
        assertArrayEquals(cru, semGancho)
        assertArrayEquals(cru, comGanchoVazio)
    }

    /**
     * O teste que justifica a frente: o rodapé precisa vir **antes** do corte.
     *
     * Se um dia alguém "simplificar" concatenando o rodapé no chamador, este teste vira vermelho —
     * e a alternativa é descobrir isso no papel, no cupom do cliente seguinte.
     */
    @Test
    fun `o rodape sai antes da guilhotina, nunca depois`() {
        val layout = ReceiptLayout.from(profile, decoration(footer = "Rodape"))
        val bytes = layout.finish()
        val corte = requireNotNull(EscPosThermalCommands.cut(5, CutProtocol.GS_V_1))

        val posicaoDoCorte = bytes.indexOfSublist(corte)
        val posicaoDoRodape = bytes.indexOfSublist("Rodape".toByteArray(Charsets.US_ASCII))

        assertTrue("O corte precisa estar presente.", posicaoDoCorte >= 0)
        assertTrue("O rodapé precisa estar presente.", posicaoDoRodape >= 0)
        assertTrue(
            "O rodapé saiu depois do corte: ele imprimiria no cupom seguinte.",
            posicaoDoRodape < posicaoDoCorte,
        )
    }

    /** Sem guilhotina o rodapé continua antes do avanço, senão a serrilha parte a linha. */
    @Test
    fun `sem guilhotina o rodape ainda precede o avanco`() {
        val semLamina = profile.copy(hasCutter = false, cutProtocol = CutProtocol.NONE)
        val bytes = ReceiptLayout.from(semLamina, decoration(footer = "Rodape")).finish()
        val avanco = requireNotNull(EscPosThermalCommands.advance(4))
        assertTrue(
            "O rodapé saiu depois do avanço.",
            bytes.indexOfSublist("Rodape".toByteArray(Charsets.US_ASCII)) < bytes.indexOfSublist(avanco),
        )
    }

    /**
     * O comprovante de teste é onde a pessoa **vê o próprio logotipo sair** antes de confiar no
     * recurso. Ele levava só o rodapé, porque o rodapé entra por `finish()` e chegava de carona;
     * o cabeçalho precisa ser escrito, e não era.
     */
    @Test
    fun `o comprovante de teste leva cabecalho e rodape`() = runTest {
        val port = RecordingBluetoothPort()
        val printer = printer(port, decoration(header = "Cabecalho do app\n", footer = "Rodape do app\n"))

        assertSame(ThermalPrintResult.Printed, printer.searchBluetooth(PORTABLE_PROFILE_ID))
        val candidato =
            (printer.state.value as ThermalPrinterState.BluetoothCandidatesFound).candidates.first().id
        assertSame(ThermalPrintResult.Printed, printer.testSearchedBluetoothPrinter(candidato))

        val bytes = port.written()
        val cabecalho = bytes.indexOfSublist(ascii("Cabecalho do app"))
        val titulo = bytes.indexOfSublist(ascii("COMPROVANTE DE TESTE"))
        val rodape = bytes.indexOfSublist(ascii("Rodape do app"))
        // A portátil não tem guilhotina: o fecho é o avanço da serrilha.
        val avanco = bytes.indexOfSublist(requireNotNull(EscPosThermalCommands.advance(4)))

        assertTrue("O cabeçalho não saiu no comprovante de teste.", cabecalho >= 0)
        assertTrue("O rodapé não saiu no comprovante de teste.", rodape >= 0)
        assertTrue("O cabeçalho precisa abrir o papel, antes do título.", cabecalho < titulo)
        assertTrue("O rodapé precisa vir depois do corpo.", titulo < rodape)
        assertTrue("O rodapé precisa vir antes do avanço da serrilha.", rodape < avanco)
    }

    /** Reenviar o comprovante de teste é o mesmo papel: sai carimbado igual. */
    @Test
    fun `o comprovante de teste reenviado tambem leva o cabecalho`() = runTest {
        val port = RecordingBluetoothPort()
        val printer = printer(port, decoration(header = "Cabecalho do app\n", footer = "Rodape do app\n"))
        printer.searchBluetooth(PORTABLE_PROFILE_ID)
        val candidato =
            (printer.state.value as ThermalPrinterState.BluetoothCandidatesFound).candidates.first().id
        printer.testSearchedBluetoothPrinter(candidato)
        printer.confirmSearchedPrinter()
        port.reset()

        assertSame(ThermalPrintResult.Printed, printer.testSelectedPrinter())

        val bytes = port.written()
        val cabecalho = bytes.indexOfSublist(ascii("Cabecalho do app"))
        val titulo = bytes.indexOfSublist(ascii("COMPROVANTE DE TESTE"))

        assertTrue("O reenvio saiu sem cabeçalho.", cabecalho >= 0)
        assertTrue("O cabeçalho do reenvio saiu fora de posição.", cabecalho < titulo)
        assertTrue("O reenvio saiu sem rodapé.", bytes.indexOfSublist(ascii("Rodape do app")) >= 0)
    }

    /**
     * Neutralidade: sem decoração instalada, o comprovante de teste é byte a byte o de antes.
     *
     * O carimbo do hospedeiro não pode atravessar quem não pediu — QRFesta e Vinki compilam a mesma
     * superfície do Printher.
     */
    @Test
    fun `sem decoracao o comprovante de teste e byte a byte o mesmo`() = runTest {
        val minutoAntes = PrinterHomologationProbes.localTimestamp(null)
        val semGancho = RecordingBluetoothPort()
        val comGanchoVazio = RecordingBluetoothPort()
        imprimeComprovanteDeTeste(printer(semGancho, decoration = null))
        imprimeComprovanteDeTeste(printer(comGanchoVazio, decoration()))
        // O comprovante carrega hora com precisão de minuto. Se o relógio virou entre os dois
        // envios, a comparação byte a byte perde o sentido — e reprovar aí seria ruído, não defeito.
        assumeTrue(minutoAntes == PrinterHomologationProbes.localTimestamp(null))

        assertArrayEquals(semGancho.written(), comGanchoVazio.written())
    }

    /**
     * O comprovante final é a assinatura da instalação concluída — não mede nada, e sai carimbado
     * como qualquer cupom do app. O cabeçalho vai **depois** do `ESC @` da própria sonda: antes
     * dele, a inicialização descartaria o cabeçalho inteiro sem erro nenhum, só no papel.
     */
    @Test
    fun `o comprovante final leva cabecalho depois da inicializacao e rodape antes da lamina`() {
        val medido = measuredProfile()
        val bytes =
            PrinterHomologationProbes
                .finalReceipt(medido, decoration = decoration("Cabecalho do app\n", "Rodape do app\n"))
                .bytes()

        val inicializacao = bytes.indexOfSublist(EscPosThermalCommands.initialize())
        val cabecalho = bytes.indexOfSublist(ascii("Cabecalho do app"))
        val rodape = bytes.indexOfSublist(ascii("Rodape do app"))
        val corte =
            bytes.indexOfSublist(
                requireNotNull(EscPosThermalCommands.cut(medido.cutFeedLines, medido.cutProtocol)),
            )

        assertEquals("A sonda precisa abrir pela inicialização.", 0, inicializacao)
        assertTrue("O cabeçalho não saiu no comprovante final.", cabecalho >= 0)
        assertTrue(
            "O cabeçalho saiu antes do ESC @: a inicialização o descartaria.",
            cabecalho > inicializacao,
        )
        assertTrue("O rodapé não saiu no comprovante final.", rodape >= 0)
        assertTrue("O rodapé precisa vir depois do cabeçalho.", cabecalho < rodape)
        assertTrue("O rodapé saiu depois do corte: ele imprimiria no cupom seguinte.", rodape < corte)
    }

    /**
     * Neutralidade do comprovante final, byte a byte: tirar do papel decorado exatamente os dois
     * blocos que a decoração devolveu reproduz o comprovante sem decoração nenhuma. Nada mais se
     * move — nem o corte, nem o avanço, nem uma linha do corpo.
     */
    @Test
    fun `o comprovante final decorado e o de antes mais o cabecalho e o rodape`() {
        val medido = measuredProfile()
        val gancho = GravandoDecoration(header = "Cabecalho do app\n", footer = "Rodape do app\n")

        val comGancho = PrinterHomologationProbes.finalReceipt(medido, decoration = gancho).bytes()
        val semGancho = PrinterHomologationProbes.finalReceipt(medido).bytes()
        val comGanchoVazio = PrinterHomologationProbes.finalReceipt(medido, decoration = decoration()).bytes()

        assertArrayEquals("Um gancho silencioso não pode mudar um byte.", semGancho, comGanchoVazio)
        assertArrayEquals(
            "O papel decorado precisa ser o de antes mais os dois blocos, e nada além.",
            semGancho,
            comGancho
                .removeFirst(requireNotNull(gancho.headerBytes))
                .removeFirst(requireNotNull(gancho.footerBytes)),
        )
    }

    /**
     * As tiras de homologação continuam limpas, byte a byte.
     *
     * Elas são régua de medida: um raster do hospedeiro no meio da tira de geometria desloca
     * justamente o que ela mede, e uma linha a mais na tira de avanço muda a distância que ela
     * existe para medir. A comparação é feita pelo fluxo real, e não pelos builders, porque é no
     * fluxo que a decoração poderia vazar.
     */
    @Test
    fun `as tiras da homologacao saem identicas com e sem decoracao`() = runTest {
        val comGancho = mutableListOf<ByteArray>()
        val semGancho = mutableListOf<ByteArray>()
        val fluxoComGancho =
            flow(decoration("Cabecalho do app\n", "Rodape do app\n")) { comGancho += it }
        val fluxoSemGancho = flow(decoration = null) { semGancho += it }

        completeMeasurementWithoutCutter(fluxoComGancho)
        completeMeasurementWithoutCutter(fluxoSemGancho)

        assertTrue("A medição precisa ter enviado tiras.", semGancho.isNotEmpty())
        assertEquals(semGancho.size, comGancho.size)
        comGancho.zip(semGancho).forEachIndexed { indice, (com, sem) ->
            assertArrayEquals("A tira $indice saiu decorada.", sem, com)
        }

        // E o comprovante final, esse, é o único papel da série que recebe o carimbo.
        fluxoComGancho.sendFinalReceipt()
        fluxoSemGancho.sendFinalReceipt()
        val comprovanteDecorado = comGancho.last()
        val comprovanteLimpo = semGancho.last()
        assertTrue(
            "O comprovante final saiu sem cabeçalho.",
            comprovanteDecorado.indexOfSublist(ascii("Cabecalho do app")) >= 0,
        )
        assertTrue(
            "O comprovante final saiu sem rodapé.",
            comprovanteDecorado.indexOfSublist(ascii("Rodape do app")) >= 0,
        )
        assertEquals(-1, comprovanteLimpo.indexOfSublist(ascii("Cabecalho do app")))
        assertEquals(-1, comprovanteLimpo.indexOfSublist(ascii("Rodape do app")))
    }

    private fun measuredProfile(): MeasuredProfile =
        MeasuredProfile.createLocal(
            displayName = "Impressora de bancada",
            transports = setOf(PrinterTransport.USB),
            paperWidthMm = 58,
            printableColumns = 32,
            printableDots = 384,
            codePage = ThermalCodePage.CP850,
            cutProtocol = CutProtocol.GS_V_0,
            cutFeedLines = 4,
            measuredAtEpochMillis = 1,
            dialect = EscPosDialect.EPSON_COMPATIBLE,
        )

    private suspend fun imprimeComprovanteDeTeste(printer: LocalWifiThermalPrinter) {
        printer.searchBluetooth(PORTABLE_PROFILE_ID)
        val candidato =
            (printer.state.value as ThermalPrinterState.BluetoothCandidatesFound).candidates.first().id
        printer.testSearchedBluetoothPrinter(candidato)
    }

    private fun printer(
        bluetooth: RecordingBluetoothPort,
        decoration: ReceiptDecoration?,
    ): LocalWifiThermalPrinter =
        LocalWifiThermalPrinter(
            port = SilentWifiPort(),
            bluetoothPort = bluetooth,
            discovery =
                object : LocalWifiPrinterDiscovery {
                    override suspend fun findCandidates(
                        profile: PrinterDriverProfile,
                        attachment: PrinterNetworkAttachment,
                    ) = LocalWifiPrinterDiscoveryResult.NotFound

                    override fun reject(network: LocalWifiNetwork, endpoint: LocalWifiPrinterEndpoint) = Unit
                },
            networkProvider = LocalWifiNetworkProvider { FakeWifiNetwork() },
            receiptDecoration = decoration,
        )

    private fun flow(
        decoration: ReceiptDecoration?,
        onSend: (ByteArray) -> Unit,
    ): PrinterHomologationFlow {
        val store = InMemoryPrinterProfileStore()
        val target =
            PrinterHomologationTarget(
                transport = PrinterTransport.USB,
                displayName = "Impressora de bancada",
                profileId = BundledPrinterDrivers.elginI9Full2.id,
                defaultStore = store,
                sender = { bytes ->
                    onSend(bytes.copyOf())
                    ThermalPrintResult.Printed
                },
                adopter = {},
                receiptDecoration = decoration,
                dialect = EscPosDialect.EPSON_COMPATIBLE,
            )
        return PrinterHomologationFlow(
            target = target,
            probeSession = target.openSession(),
            store = store,
            adopter = {},
            nowEpochMillis = { 1 },
        )
    }

    private suspend fun completeMeasurementWithoutCutter(flow: PrinterHomologationFlow) {
        flow.sendCurrentProbe()
        flow.answer(PrinterHomologationAnswer.Geometry(58, 32, 384))
        flow.passRasterThroughputProbe()
        flow.passNativeCodeProbe()
        flow.answerCutterPresence(PrinterCutterPresence.NO)
        flow.sendCurrentProbe()
        flow.answer(PrinterHomologationAnswer.CodePage(null))
    }

    private fun ascii(value: String): ByteArray = value.toByteArray(StandardCharsets.US_ASCII)

    private fun ByteArray.indexOfSublist(target: ByteArray): Int {
        if (target.isEmpty() || target.size > size) return -1
        outer@ for (start in 0..size - target.size) {
            for (offset in target.indices) {
                if (this[start + offset] != target[offset]) continue@outer
            }
            return start
        }
        return -1
    }

    /** Remove a primeira ocorrência do bloco; falha alto se ele não estiver lá. */
    private fun ByteArray.removeFirst(target: ByteArray): ByteArray {
        val inicio = indexOfSublist(target)
        assertTrue("Bloco ausente do papel decorado.", inicio >= 0)
        return copyOfRange(0, inicio) + copyOfRange(inicio + target.size, size)
    }

    /**
     * Guarda uma cópia do que devolveu. O kit zera o array depois de escrevê-lo — o cabeçalho pode
     * ser raster de logotipo —, então quem quiser comparar depois precisa copiar antes.
     */
    private class GravandoDecoration(
        private val header: String?,
        private val footer: String?,
    ) : ReceiptDecoration {
        var headerBytes: ByteArray? = null
            private set
        var footerBytes: ByteArray? = null
            private set

        override fun header(layout: ReceiptLayout): ByteArray? =
            header
                ?.let {
                    layout.text(it, ThermalTextAlignment.CENTER, ThermalTextStyle.NORMAL, ThermalTextSize.NORMAL)
                }
                ?.also { headerBytes = it.copyOf() }

        override fun footer(layout: ReceiptLayout): ByteArray? =
            footer
                ?.let {
                    layout.text(it, ThermalTextAlignment.CENTER, ThermalTextStyle.NORMAL, ThermalTextSize.NORMAL)
                }
                ?.also { footerBytes = it.copyOf() }
    }

    private class RecordingBluetoothPort : BluetoothThermalPort {
        private val writes = mutableListOf<ByteArray>()

        override fun discover(profile: PrinterDriverProfile): List<BluetoothPrinterHandle> =
            listOf(BluetoothPrinterHandle(21, "Impressora Bluetooth 1"))

        override suspend fun open(handle: BluetoothPrinterHandle, profile: PrinterDriverProfile) = Unit

        override fun close() = Unit

        override fun drain() = Unit

        override fun write(data: ByteArray) {
            writes += data.copyOf()
        }

        override fun coverStatus(): ThermalCoverStatus = ThermalCoverStatus.CLOSED

        override fun paperStatus(): ThermalPaperStatus = ThermalPaperStatus.PRESENT

        fun reset() = writes.clear()

        /** Tudo o que foi ao fio, na ordem: a inicialização do transporte inclusive. */
        fun written(): ByteArray = writes.fold(ByteArray(0)) { acumulado, bloco -> acumulado + bloco }
    }

    private class FakeWifiNetwork : LocalWifiNetwork {
        override val subnet =
            LocalWifiSubnet(
                hostAddress = byteArrayOf(192.toByte(), 168.toByte(), 31, 42),
                prefixLength = 24,
                excludedGatewayAddresses = emptyList(),
            )
        override val selectionKey = LocalWifiNetworkSelectionKey(52, subnet)

        override fun openSocket() = error("Não usado.")

        override fun stillAvailable(): Boolean = true
    }

    private class SilentWifiPort : LocalWifiThermalPort {
        override fun open(
            network: LocalWifiNetwork,
            endpoint: LocalWifiPrinterEndpoint,
            profile: PrinterDriverProfile,
        ) = Unit

        override fun close() = Unit

        override fun write(data: ByteArray) = Unit

        override fun coverStatus(): ThermalCoverStatus = ThermalCoverStatus.CLOSED

        override fun paperStatus(): ThermalPaperStatus = ThermalPaperStatus.PRESENT
    }

    private companion object {
        val PORTABLE_PROFILE_ID = BundledPrinterDrivers.portable58mm.id
    }
}
