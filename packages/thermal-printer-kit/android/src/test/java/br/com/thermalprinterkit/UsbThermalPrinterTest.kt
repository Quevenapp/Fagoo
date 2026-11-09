package br.com.thermalprinterkit

import java.nio.charset.StandardCharsets
import java.time.Instant
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class UsbThermalPrinterTest {
    @Test
    fun `USB candidate must print a test and be confirmed before receiving tickets`() = runTest {
        val usb = RecordingUsbPort()
        val printer = printer(usb)

        assertSame(ThermalPrintResult.Printed, printer.searchUsb(BundledPrinterDrivers.elginI9Full2.id))
        val candidate = (printer.state.value as ThermalPrinterState.UsbCandidatesFound).candidates.single()
        // O nome vem do aparelho quando ele se identifica — o mesmo que o diálogo de permissão do
        // Android mostra. O genérico "Impressora USB N" continua sendo a rede de segurança para
        // quem não declara nada, e nada do estado publica VID, PID ou serial.
        assertEquals("TM-T20X", candidate.label)
        assertFalse(printer.state.value.toString().contains("vendor"))

        assertSame(ThermalPrintResult.Printed, printer.testSearchedUsbPrinter(candidate.id))
        assertSame(ThermalPrinterState.SearchConfirmationRequired, printer.state.value)
        assertEquals(1, usb.openCount)

        val beforeConfirmation = printer.print(testReceiptPayload()) as ThermalPrintResult.Failed
        assertSame(ThermalPrinterState.SearchConfirmationRequired, beforeConfirmation.state)

        printer.confirmSearchedPrinter()
        assertSame(ThermalPrintResult.Printed, printer.print(testReceiptPayload()))
        assertEquals(2, usb.openCount)
        assertTrue(usb.allText().contains("1-4237"))
        assertTrue(usb.containsRasterImage())
        assertFalse(usb.allText().contains("#t="))
    }

    @Test
    fun `não saiu volta para a mesma lista USB sem nova busca`() = runTest {
        val usb = RecordingUsbPort()
        val printer = printer(usb)
        printer.searchUsb(BundledPrinterDrivers.elginI9Full2.id)
        val before = (printer.state.value as ThermalPrinterState.UsbCandidatesFound).candidates
        printer.testSearchedUsbPrinter(before.single().id)

        printer.returnToSearchedPrinters(PrinterTransport.USB)

        val after = (printer.state.value as ThermalPrinterState.UsbCandidatesFound).candidates
        assertEquals(before, after)
        assertEquals(1, usb.openCount)
    }

    /**
     * O nome declarado pelo aparelho chega ao perfil medido.
     *
     * O perfil nascia "Impressora temporária 58 mm" mesmo quando o USB já tinha dito quem era, e o
     * diálogo de permissão do Android mostrava o nome bom na tela ao lado. Duas identidades para a
     * mesma impressora, e a nossa era a pior.
     */
    @Test
    fun `o nome declarado pelo USB vira o nome do alvo de homologação`() = runTest {
        val usb = RecordingUsbPort()
        val printer = printer(usb)
        assertSame(ThermalPrintResult.Printed, printer.searchUsb(BundledPrinterDrivers.elginI9Full2.id))
        val candidate = (printer.state.value as ThermalPrinterState.UsbCandidatesFound).candidates.single()
        assertSame(ThermalPrintResult.Printed, printer.testSearchedUsbPrinter(candidate.id))

        assertEquals("TM-T20X", printer.openHomologationTarget()?.displayName)
    }

    /**
     * O papel, e não um relógio, encerra a confirmação.
     *
     * Reproduzido no A075 com a Luogao/STM32: deixar o comprovante na tela por mais de dois minutos
     * e tocar em "Saiu no papel" abria "Configuração indisponível", pois o alvo já tinha expirado.
     */
    @Test
    fun `alvo USB continua disponível enquanto aguarda confirmação do papel`() = runTest {
        var nowNanos = 0L
        val usb = RecordingUsbPort()
        val printer = printer(usb, monotonicNanos = { nowNanos })
        val temporary =
            printer.prepareTemporaryDiscoveryProfile(
                transport = PrinterTransport.USB,
                paperWidthMm = 80,
                displayName = "Luogao",
                dialect = EscPosDialect.EPSON_COMPATIBLE,
            )
        printer.searchUsb(temporary.id)
        val candidate = (printer.state.value as ThermalPrinterState.UsbCandidatesFound).candidates.single()
        assertSame(ThermalPrintResult.Printed, printer.testSearchedUsbPrinter(candidate.id))

        nowNanos = 3L * 60 * 1_000_000_000

        assertSame(ThermalPrinterState.SearchConfirmationRequired, printer.state.value)
        assertEquals(temporary.id, printer.openHomologationTarget()?.profileId)
    }

    @Test
    fun `denied USB permission is not retried through Wi-Fi`() = runTest {
        val usb = RecordingUsbPort(failureOnOpen = ThermalPortFailure.UsbPermissionDenied)
        val wifi = RecordingWifiPort()
        val printer = printer(usb, wifi)

        printer.searchUsb(BundledPrinterDrivers.elginI9Full2.id)
        val candidate = (printer.state.value as ThermalPrinterState.UsbCandidatesFound).candidates.single()
        val result = printer.testSearchedUsbPrinter(candidate.id) as ThermalPrintResult.Failed

        assertSame(ThermalPrinterState.UsbPermissionDenied, result.state)
        assertSame(ThermalPrintDelivery.NOT_SENT, result.delivery)
        assertEquals(0, wifi.openCount)
    }

    @Test
    fun `interrupted USB receipt is indeterminate and clears selection`() = runTest {
        val usb = RecordingUsbPort(failWriteNumber = 2)
        val printer = printer(usb)

        printer.searchUsb(BundledPrinterDrivers.elginI9Full2.id)
        val candidate = (printer.state.value as ThermalPrinterState.UsbCandidatesFound).candidates.single()
        val result = printer.testSearchedUsbPrinter(candidate.id) as ThermalPrintResult.Failed

        assertSame(ThermalPrintDelivery.INDETERMINATE, result.delivery)
        assertTrue(result.message.contains("Confira se o comprovante saiu"))
        assertEquals(1, usb.openCount)
        assertSame(
            ThermalPrinterState.PrinterNotSelected,
            (printer.print(testReceiptPayload()) as ThermalPrintResult.Failed).state,
        )
    }

    @Test
    fun `confirmed USB printer is rediscovered after app process recreation`() = runTest {
        val store = InMemoryPrinterSelectionStore()
        val firstPort = RecordingUsbPort()
        val first = printer(firstPort, store = store)
        first.searchUsb(BundledPrinterDrivers.elginI9Full2.id)
        val candidate = (first.state.value as ThermalPrinterState.UsbCandidatesFound).candidates.single()
        first.testSearchedUsbPrinter(candidate.id)
        first.confirmSearchedPrinter()

        val restoredPort = RecordingUsbPort()
        val restored = printer(restoredPort, store = store)
        // A readoção é explícita: varrer BLE leva segundos e não pode acontecer no construtor.
        restored.restore()

        assertSame(ThermalPrinterState.Ready, restored.state.value)
        assertSame(ThermalPrintResult.Printed, restored.testSelectedPrinter())
        assertEquals(1, restoredPort.openCount)
    }

    /**
     * Procurar não desinstala, e duas USB cabem instaladas ao mesmo tempo.
     *
     * Medido no A75 em 17/08 com a TM-T20X-II: instalar, tocar em adicionar impressora — que abre a
     * busca sozinha — e voltar deixava a lista de instalações vazia. O perfil medido continuava no
     * outro store, então parecia perda de impressora sem perda de medição, que é exatamente o que
     * `withoutActiveAt` na entrada da busca fazia: apagava o vínculo antes de enumerar qualquer
     * coisa. Era resto de quando cada transporte só cabia uma impressora.
     */
    @Test
    fun `busca USB nao desinstala quem ja estava instalado`() = runTest {
        val store = InMemoryPrinterSelectionStore()
        val usb = MultipleUsbPort()
        val printer = printer(usb, store = store)
        printer.searchUsb(BundledPrinterDrivers.elginI9Full2.id)
        printer.testSearchedUsbPrinter(22L)
        printer.confirmSearchedPrinter()
        val instalada = store.read()
        assertEquals(1, instalada.selections.size)

        printer.searchUsb(BundledPrinterDrivers.bematechMp4200Th.id)

        assertEquals(instalada, store.read())
        assertEquals(
            listOf(PrinterTransport.USB),
            printer.adoptedPrinters.value.map(AdoptedPrinter::transport),
        )

        // E a segunda entra ao lado da primeira, com a recém-confirmada assumindo como padrão.
        printer.testSearchedUsbPrinter(11L)
        printer.confirmSearchedPrinter()

        val duas = store.read()
        assertEquals(2, duas.selections.size)
        assertEquals(BundledPrinterDrivers.bematechMp4200Th.id, duas.activeSelection?.profileId)
        assertEquals(
            listOf(true),
            printer.adoptedPrinters.value.filter(AdoptedPrinter::active).map { true },
        )
    }

    /**
     * A candidata que falhou não é substituída pela impressora que já estava instalada.
     *
     * Medido no A75 em 17/08: o assistente procurou a MTP-5, o Android demorou na autorização, o
     * `open` da candidata falhou, e a retomada leu a identidade da instalação ativa — a i9, a
     * última instalada — achou a i9 no barramento e imprimiu o comprovante da MTP-5 nela. O papel
     * saiu na impressora errada e a tela disse que o teste tinha sido enviado.
     */
    @Test
    fun `candidata que falha nao imprime na impressora instalada`() = runTest {
        val store = InMemoryPrinterSelectionStore()
        store.save(
            PersistedPrinterSelections().with(
                PersistedPrinterSelection.Usb(
                    BundledPrinterDrivers.elginI9Full2.id,
                    UsbConnectionIdentity(vendorId = 10927, productId = 24601),
                ),
            ),
        )
        val usb = InstalledAndCandidateUsbPort()
        val printer = printer(usb, store = store)
        printer.searchUsb(BundledPrinterDrivers.bematechMp4200Th.id)
        usb.openAttempts.clear()

        val result = printer.testSearchedUsbPrinter(22L)

        // A retomada existe e continua valendo: ela repete a **mesma** candidata, reencontrada pelo
        // nome que ela declara. O que não pode é a i9 entrar no lugar dela.
        assertTrue(result is ThermalPrintResult.Failed)
        assertTrue(usb.openAttempts.toString(), usb.openAttempts.all { it == 22L })
        assertTrue(usb.openAttempts.isNotEmpty())
        assertTrue(usb.writes.isEmpty())
        assertEquals(null, printer.state.value as? ThermalPrinterState.SearchConfirmationRequired)
    }

    @Test
    fun `processo nao escolhe uma entre varias USB sem handle efemero`() = runTest {
        val store = InMemoryPrinterSelectionStore()
        store.save(
            PersistedPrinterSelections().with(
                PersistedPrinterSelection.Usb(BundledPrinterDrivers.elginI9Full2.id),
            ),
        )
        val usb = MultipleUsbPort()
        val restored = printer(usb, store = store)

        restored.restore()

        val candidates = restored.state.value as ThermalPrinterState.UsbCandidatesFound
        assertEquals(3, candidates.candidates.size)
        assertEquals(null, usb.openedHandleId)

        val result = restored.print(testReceiptPayload()) as ThermalPrintResult.Failed
        assertTrue(result.state is ThermalPrinterState.UsbCandidatesFound)
        assertEquals(null, usb.openedHandleId)
    }

    @Test
    fun `processo restaura exatamente a USB vinculada entre varias candidatas`() = runTest {
        val store = InMemoryPrinterSelectionStore()
        store.save(
            PersistedPrinterSelections().with(
                PersistedPrinterSelection.Usb(
                    BundledPrinterDrivers.elginI9Full2.id,
                    UsbConnectionIdentity(vendorId = 1137, productId = 85),
                ),
            ),
        )
        val usb = MultipleUsbPort()
        val restored = printer(usb, store = store)

        restored.restore()

        assertSame(ThermalPrinterState.Ready, restored.state.value)
        assertSame(ThermalPrintResult.Printed, restored.testSelectedPrinter())
        assertEquals(22L, usb.openedHandleId)
        assertFalse(store.read().toString().contains("1137"))
    }

    @Test
    fun `reenumeracao nao troca para outra USB que ocupou o lugar da anterior`() = runTest {
        val store = InMemoryPrinterSelectionStore()
        val usb = ReplacedUsbPort()
        val printer = printer(usb, store = store)
        printer.searchUsb(BundledPrinterDrivers.elginI9Full2.id)
        val candidate = (printer.state.value as ThermalPrinterState.UsbCandidatesFound).candidates.single()
        printer.testSearchedUsbPrinter(candidate.id)
        printer.confirmSearchedPrinter()
        usb.openAttempts.clear()

        usb.replaceWithOtherAuthorizedPrinter()
        val result = printer.print(testReceiptPayload()) as ThermalPrintResult.Failed

        assertSame(ThermalPrintDelivery.NOT_SENT, result.delivery)
        assertEquals(listOf(11L), usb.openAttempts)
    }

    @Test
    fun `USB reenumerado ao sair do app reconecta antes de imprimir imagem`() = runTest {
        val store = InMemoryPrinterSelectionStore()
        val first = printer(RecordingUsbPort(), store = store)
        first.searchUsb(BundledPrinterDrivers.elginI9Full2.id)
        val candidate = (first.state.value as ThermalPrinterState.UsbCandidatesFound).candidates.single()
        first.testSearchedUsbPrinter(candidate.id)
        first.confirmSearchedPrinter()

        val restoredPort = RecordingUsbPort()
        val restored = printer(restoredPort, store = store)
        restored.restore()
        // Simula o novo deviceId que o UsbManager entrega quando o hub/cabo oscila enquanto o app
        // está fora de foco. O handle restaurado continua em memória, mas já não abre.
        restoredPort.reenumerate()

        assertSame(ThermalPrintResult.Printed, restored.print(testReceiptPayload()))
        assertEquals(2, restoredPort.openCount)
        assertTrue(restoredPort.containsRasterImage())
    }

    @Test
    fun `falha pos-save reverte somente perfil e selecao novos e preserva runtime anterior`() = runTest {
        val delegate = InMemoryPrinterSelectionStore()
        val previousSelections =
            PersistedPrinterSelections().with(
                PersistedPrinterSelection.Bluetooth(BundledPrinterDrivers.portable58mm.id),
            )
        delegate.save(previousSelections)
        val selectionStore =
            object : PrinterSelectionStore {
                override fun read(): PersistedPrinterSelections = delegate.read()

                override fun save(selections: PersistedPrinterSelections) {
                    delegate.save(selections)
                    val usbProfile = selections.of(PrinterTransport.USB)?.profileId
                    if (usbProfile?.matches(Regex("[0-9a-f-]{36}")) == true) {
                        throw IllegalStateException("Falha simulada depois da escrita")
                    }
                }

                override fun clear() = delegate.clear()
            }
        val profileStore = InMemoryPrinterProfileStore()
        val previousProfile =
            MeasuredProfile.createLocal(
                id = "00000000-0000-4000-8000-000000000091",
                displayName = "Medição anterior",
                transports = setOf(PrinterTransport.BLUETOOTH),
                paperWidthMm = 58,
                printableColumns = 30,
                printableDots = 384,
                codePage = null,
                cutProtocol = CutProtocol.NONE,
                cutFeedLines = 0,
                measuredAtEpochMillis = 1,
                dialect = EscPosDialect.EPSON_COMPATIBLE,
            )
        profileStore.save(previousProfile)
        val bluetooth = RecordingBluetoothPort()
        val printer =
            printer(
                usb = RecordingUsbPort(),
                bluetooth = bluetooth,
                store = selectionStore,
                profileStore = profileStore,
            )
        printer.restore()
        assertSame(ThermalPrinterState.Ready, printer.state.value)
        printer.searchUsb(BundledPrinterDrivers.elginI9Full2.id)
        val candidate =
            (printer.state.value as ThermalPrinterState.UsbCandidatesFound).candidates.single()
        printer.testSearchedUsbPrinter(candidate.id)
        val flow = requireNotNull(printer.openHomologationTarget()).openHomologation(profileStore)

        flow.sendCurrentProbe()
        flow.answer(PrinterHomologationAnswer.Geometry(80, 48, 576))
        flow.passRasterThroughputProbe()
        flow.passNativeCodeProbe()
        flow.answerCutterPresence(PrinterCutterPresence.NO)
        flow.sendCurrentProbe()
        // A linha `a` da tira é a frase sem acento: escolhê-la é o perfil ASCII conservador.
        flow.answer(PrinterHomologationAnswer.CodePage(null))
        flow.sendFinalReceipt()
        flow.confirmFinalReceipt()

        assertEquals(PrinterHomologationFailurePoint.ADOPTION, flow.state.value.failure?.point)
        assertEquals(listOf(previousProfile), profileStore.read())
        assertEquals(previousSelections, delegate.read())
        assertSame(ThermalPrinterState.SearchConfirmationRequired, printer.state.value)
        assertEquals(
            listOf(PrinterTransport.BLUETOOTH),
            printer.adoptedPrinters.value.map(AdoptedPrinter::transport),
        )
        assertEquals(
            BundledPrinterDrivers.portable58mm.id,
            requireNotNull(printer.openHomologationTarget(PrinterTransport.BLUETOOTH)).profileId,
        )
    }

    private fun printer(
        usb: UsbThermalPort,
        wifi: RecordingWifiPort = RecordingWifiPort(),
        bluetooth: BluetoothThermalPort? = null,
        store: PrinterSelectionStore = InMemoryPrinterSelectionStore(),
        profileStore: PrinterProfileStore = InMemoryPrinterProfileStore(),
        monotonicNanos: () -> Long = System::nanoTime,
    ): LocalWifiThermalPrinter {
        val network = FakeWifiNetwork()
        return LocalWifiThermalPrinter(
            port = wifi,
            usbPort = usb,
            bluetoothPort = bluetooth,
            discovery =
                object : LocalWifiPrinterDiscovery {
                    override suspend fun findCandidates(
                        profile: PrinterDriverProfile,
                        attachment: PrinterNetworkAttachment,
                    ) =
                        LocalWifiPrinterDiscoveryResult.NotFound

                    override fun reject(network: LocalWifiNetwork, endpoint: LocalWifiPrinterEndpoint) = Unit
                },
            networkProvider = LocalWifiNetworkProvider { network },
            selectionStore = store,
            profileStore = profileStore,
            monotonicNanos = monotonicNanos,
        )
    }
    private class RecordingUsbPort(
        private val failureOnOpen: ThermalPortFailure? = null,
        private val failWriteNumber: Int? = null,
    ) : UsbThermalPort {
        private var currentHandleId = 11L
        private val writes = mutableListOf<ByteArray>()
        var openCount = 0
        private var writeCount = 0

        override fun discover(profile: PrinterDriverProfile): List<UsbPrinterHandle> =
            listOf(UsbPrinterHandle(currentHandleId, "TM-T20X", named = true))

        override suspend fun open(handle: UsbPrinterHandle, profile: PrinterDriverProfile) {
            openCount += 1
            if (handle.id != currentHandleId) {
                throw ThermalPortException(ThermalPortFailure.UsbDisconnected)
            }
            failureOnOpen?.let { throw ThermalPortException(it) }
        }

        override fun close() = Unit

        override fun write(data: ByteArray) {
            writeCount += 1
            if (writeCount == failWriteNumber) {
                throw ThermalPortException(ThermalPortFailure.WriteInterrupted)
            }
            writes += data.copyOf()
        }

        override fun coverStatus(): ThermalCoverStatus = ThermalCoverStatus.CLOSED

        override fun paperStatus(): ThermalPaperStatus = ThermalPaperStatus.PRESENT

        fun allText(): String = writes.joinToString("") { String(it, StandardCharsets.US_ASCII) }

        fun containsRasterImage(): Boolean = writes.any(::containsUsbRasterCommand)

        fun reenumerate() {
            currentHandleId += 1
        }
    }

    private class RecordingBluetoothPort : BluetoothThermalPort {
        private val handle = BluetoothPrinterHandle(21, "Impressora Bluetooth 1")

        override fun discover(profile: PrinterDriverProfile): List<BluetoothPrinterHandle> =
            listOf(handle)

        override suspend fun open(
            handle: BluetoothPrinterHandle,
            profile: PrinterDriverProfile,
        ) = Unit

        override fun close() = Unit
        override fun write(data: ByteArray) = Unit
        override fun drain() = Unit
        override fun coverStatus() = ThermalCoverStatus.CLOSED
        override fun paperStatus() = ThermalPaperStatus.PRESENT
    }

    private class MultipleUsbPort : UsbThermalPort {
        private val handles =
            listOf(
                UsbPrinterHandle(11, "Impressora USB 1"),
                UsbPrinterHandle(22, "USB Printer Port", named = true),
                UsbPrinterHandle(33, "Impressora USB 3"),
            )
        var openedHandleId: Long? = null

        override fun discover(profile: PrinterDriverProfile): List<UsbPrinterHandle> = handles

        override fun matchesPersistedIdentity(
            handle: UsbPrinterHandle,
            identity: UsbConnectionIdentity,
        ): Boolean =
            when (handle.id) {
                22L -> identity.vendorId == 1137 && identity.productId == 85
                else -> false
            }

        override suspend fun open(handle: UsbPrinterHandle, profile: PrinterDriverProfile) {
            openedHandleId = handle.id
        }

        override fun close() = Unit
        override fun write(data: ByteArray) = Unit
        override fun coverStatus(): ThermalCoverStatus = ThermalCoverStatus.CLOSED
        override fun paperStatus(): ThermalPaperStatus = ThermalPaperStatus.PRESENT
    }

    /** A instalada responde e a candidata recusa: o cenário da bancada, com o hub cheio. */
    private class InstalledAndCandidateUsbPort : UsbThermalPort {
        val openAttempts = mutableListOf<Long>()
        val writes = mutableListOf<ByteArray>()
        private val handles =
            listOf(
                UsbPrinterHandle(11, "i9 FULL 2", named = true),
                UsbPrinterHandle(22, "micro-printer", named = true),
            )

        override fun discover(profile: PrinterDriverProfile): List<UsbPrinterHandle> = handles

        override fun matchesPersistedIdentity(
            handle: UsbPrinterHandle,
            identity: UsbConnectionIdentity,
        ): Boolean = handle.id == 11L && identity.vendorId == 10927

        override suspend fun open(handle: UsbPrinterHandle, profile: PrinterDriverProfile) {
            openAttempts += handle.id
            if (handle.id == 22L) throw ThermalPortException(ThermalPortFailure.PrinterUnavailable)
        }

        override fun close() = Unit

        override fun write(data: ByteArray) {
            writes += data.copyOf()
        }

        override fun coverStatus(): ThermalCoverStatus = ThermalCoverStatus.CLOSED

        override fun paperStatus(): ThermalPaperStatus = ThermalPaperStatus.PRESENT
    }

    private class ReplacedUsbPort : UsbThermalPort {
        private var replaced = false
        val openAttempts = mutableListOf<Long>()

        override fun discover(profile: PrinterDriverProfile): List<UsbPrinterHandle> =
            if (replaced) {
                listOf(
                    UsbPrinterHandle(22, "Outra impressora", named = true),
                    UsbPrinterHandle(33, "Terceira impressora", named = true),
                )
            } else {
                listOf(UsbPrinterHandle(11, "Luogao", named = true))
            }

        override suspend fun open(handle: UsbPrinterHandle, profile: PrinterDriverProfile) {
            openAttempts += handle.id
            if (replaced) throw ThermalPortException(ThermalPortFailure.UsbDisconnected)
        }

        override fun close() = Unit
        override fun write(data: ByteArray) = Unit
        override fun coverStatus(): ThermalCoverStatus = ThermalCoverStatus.CLOSED
        override fun paperStatus(): ThermalPaperStatus = ThermalPaperStatus.PRESENT

        fun replaceWithOtherAuthorizedPrinter() {
            replaced = true
        }
    }

    private class RecordingWifiPort : LocalWifiThermalPort {
        var openCount = 0

        override fun open(
            network: LocalWifiNetwork,
            endpoint: LocalWifiPrinterEndpoint,
            profile: PrinterDriverProfile,
        ) {
            openCount += 1
        }

        override fun close() = Unit

        override fun write(data: ByteArray) = Unit

        override fun coverStatus(): ThermalCoverStatus = ThermalCoverStatus.CLOSED

        override fun paperStatus(): ThermalPaperStatus = ThermalPaperStatus.PRESENT
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
}

private fun containsUsbRasterCommand(bytes: ByteArray): Boolean =
    (0..bytes.size - 4).any { index ->
        bytes[index] == 0x1d.toByte() &&
            bytes[index + 1] == 0x76.toByte() &&
            bytes[index + 2] == 0x30.toByte() &&
            bytes[index + 3] == 0x00.toByte()
    }
