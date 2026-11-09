package br.com.thermalprinterkit

import java.nio.charset.StandardCharsets
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class BluetoothThermalPrinterTest {
    private val profileId = BundledPrinterDrivers.portable58mm.id

    @Test
    fun `a paired printer becomes a candidate and prints the confirmation receipt`() = runTest {
        val port = RecordingBluetoothPort()
        val printer = printer(port)

        assertSame(ThermalPrintResult.Printed, printer.searchBluetooth(profileId))
        val candidates = (printer.state.value as ThermalPrinterState.BluetoothCandidatesFound).candidates
        assertEquals(1, candidates.size)

        assertSame(ThermalPrintResult.Printed, printer.testSearchedBluetoothPrinter(candidates.first().id))
        assertSame(ThermalPrinterState.SearchConfirmationRequired, printer.state.value)
        assertTrue(port.allText().contains("COMPROVANTE DE TESTE"))
    }

    /** Sem confirmação humana do cupom de teste a impressora não pode ser adotada. */
    @Test
    fun `printing is refused while the test receipt is unconfirmed`() = runTest {
        val port = RecordingBluetoothPort()
        val printer = printer(port)
        printer.searchBluetooth(profileId)
        val candidateId =
            (printer.state.value as ThermalPrinterState.BluetoothCandidatesFound).candidates.first().id
        printer.testSearchedBluetoothPrinter(candidateId)

        val refused = printer.searchBluetooth(profileId) as ThermalPrintResult.Failed

        assertSame(ThermalPrinterState.SearchConfirmationRequired, refused.state)
    }

    @Test
    fun `confirming keeps the printer ready and persists the physical binding separately`() = runTest {
        val address = "AA:BB:CC:DD:EE:01"
        val port = RecordingBluetoothPort(persistenceAddress = address)
        val store = InMemoryPrinterSelectionStore()
        val printer = printer(port, store)
        printer.searchBluetooth(profileId)
        val candidateId =
            (printer.state.value as ThermalPrinterState.BluetoothCandidatesFound).candidates.first().id
        printer.testSearchedBluetoothPrinter(candidateId)

        printer.confirmSearchedPrinter()

        assertSame(ThermalPrinterState.Ready, printer.state.value)
        val stored = store.read()
        assertEquals(
            PersistedPrinterSelection.Bluetooth(profileId, address),
            stored.of(PrinterTransport.BLUETOOTH),
        )
        assertFalse(stored.toString().contains(address))
        assertEquals(PrinterTransport.BLUETOOTH, stored.active)
    }

    @Test
    fun `discarding the candidate leaves nothing selected`() = runTest {
        val port = RecordingBluetoothPort()
        val printer = printer(port)
        printer.searchBluetooth(profileId)
        val candidateId =
            (printer.state.value as ThermalPrinterState.BluetoothCandidatesFound).candidates.first().id
        printer.testSearchedBluetoothPrinter(candidateId)

        printer.discardSearchedPrinter()

        assertSame(ThermalPrinterState.BluetoothUnavailable, printer.state.value)
    }

    /** A escolha preservada é reencontrada entre as pareadas ao abrir o app de novo. */
    @Test
    fun `a persisted selection is restored on the next start`() = runTest {
        val store = InMemoryPrinterSelectionStore()
        val address = "AA:BB:CC:DD:EE:02"
        val first = printer(RecordingBluetoothPort(persistenceAddress = address), store)
        first.searchBluetooth(profileId)
        val candidateId =
            (first.state.value as ThermalPrinterState.BluetoothCandidatesFound).candidates.first().id
        first.testSearchedBluetoothPrinter(candidateId)
        first.confirmSearchedPrinter()

        val restoredPort = RecordingBluetoothPort(persistenceAddress = address)
        val restored = printer(restoredPort, store)
        // A readoção é explícita: varrer BLE leva segundos e não pode acontecer no construtor.
        restored.restore()

        assertSame(ThermalPrinterState.Ready, restored.state.value)
        assertSame(ThermalPrintResult.Printed, restored.testSelectedPrinter())
        assertTrue(restoredPort.openCount >= 1)
    }

    /** O cupom da portátil não pode carregar o corte: ela não tem guilhotina. */
    @Test
    fun `the receipt never sends a cut command to a printer without a cutter`() = runTest {
        val port = RecordingBluetoothPort()
        val printer = printer(port)
        printer.searchBluetooth(profileId)
        val candidateId =
            (printer.state.value as ThermalPrinterState.BluetoothCandidatesFound).candidates.first().id

        printer.testSearchedBluetoothPrinter(candidateId)

        assertFalse(port.containsCutCommand())
    }

    /**
     * Depois de escrever, drena; e **não fecha**.
     *
     * As duas metades vêm do mesmo defeito de campo. `write` retorna quando os bytes estão na pilha
     * Bluetooth do Android, não no papel: fechar ali descartava a fila e saía meia matriz de QR.
     * Mas reabrir RFCOMM a cada cupom punha segundos entre um e outro. Por isso o canal só fecha em
     * caso de falha.
     */
    @Test
    fun `printing drains and keeps the channel open for the next receipt`() = runTest {
        val port = RecordingBluetoothPort()
        val printer = printer(port)
        printer.searchBluetooth(profileId)
        val candidateId =
            (printer.state.value as ThermalPrinterState.BluetoothCandidatesFound).candidates.first().id

        printer.testSearchedBluetoothPrinter(candidateId)

        val drain = port.lifecycle.indexOf("drain")
        assertTrue("o dreno precisa acontecer: ${port.lifecycle}", drain >= 0)
        assertTrue(
            "toda escrita precisa vir antes do dreno: ${port.lifecycle}",
            port.lifecycle.indexOfLast { it == "write" } < drain,
        )
        assertFalse(
            "o canal não pode fechar depois de imprimir: ${port.lifecycle}",
            port.lifecycle.drop(drain).contains("close"),
        )
    }

    /** Falha fecha, para a próxima tentativa reconectar em vez de escrever num socket morto. */
    @Test
    fun `a failed write closes the channel`() = runTest {
        val port = RecordingBluetoothPort(failWriteNumber = 2)
        val printer = printer(port)
        printer.searchBluetooth(profileId)
        val candidateId =
            (printer.state.value as ThermalPrinterState.BluetoothCandidatesFound).candidates.first().id

        printer.testSearchedBluetoothPrinter(candidateId)

        assertTrue("a falha precisa fechar o canal: ${port.lifecycle}", port.lifecycle.contains("close"))
    }

    @Test
    fun `a printer without an open channel reports the bluetooth failure`() = runTest {
        val port = RecordingBluetoothPort(failureOnOpen = ThermalPortFailure.BluetoothDisconnected)
        val printer = printer(port)
        printer.searchBluetooth(profileId)
        val candidateId =
            (printer.state.value as ThermalPrinterState.BluetoothCandidatesFound).candidates.first().id

        val result = printer.testSearchedBluetoothPrinter(candidateId) as ThermalPrintResult.Failed

        assertSame(ThermalPrinterState.BluetoothUnavailable, result.state)
        assertSame(ThermalPrintDelivery.NOT_SENT, result.delivery)
    }

    /** Falha depois do início da escrita não pode ser tratada como cupom não entregue. */
    @Test
    fun `an interrupted write is reported as indeterminate`() = runTest {
        val port = RecordingBluetoothPort(failWriteNumber = 2)
        val printer = printer(port)
        printer.searchBluetooth(profileId)
        val candidateId =
            (printer.state.value as ThermalPrinterState.BluetoothCandidatesFound).candidates.first().id

        val result = printer.testSearchedBluetoothPrinter(candidateId) as ThermalPrintResult.Failed

        assertSame(ThermalPrintDelivery.INDETERMINATE, result.delivery)
    }

    @Test
    fun `no paired printer leaves the bluetooth transport unavailable`() = runTest {
        val printer = printer(RecordingBluetoothPort(handles = emptyList()))

        val result = printer.searchBluetooth(profileId) as ThermalPrintResult.Failed

        assertSame(ThermalPrinterState.BluetoothUnavailable, result.state)
    }

    private fun printer(
        bluetooth: RecordingBluetoothPort,
        store: PrinterSelectionStore = InMemoryPrinterSelectionStore(),
    ): LocalWifiThermalPrinter {
        val network = FakeWifiNetwork()
        return LocalWifiThermalPrinter(
            port = SilentWifiPort(),
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
        )
    }

    private class RecordingBluetoothPort(
        private val handles: List<BluetoothPrinterHandle> =
            listOf(BluetoothPrinterHandle(21, "Impressora Bluetooth 1")),
        private val failureOnOpen: ThermalPortFailure? = null,
        private val failWriteNumber: Int? = null,
        private val persistenceAddress: String? = null,
    ) : BluetoothThermalPort {
        private val writes = mutableListOf<ByteArray>()
        var openCount = 0
        private var writeCount = 0

        /** Ordem das operações de saída, para provar que o dreno acontece antes do fechamento. */
        val lifecycle = mutableListOf<String>()

        override fun discover(profile: PrinterDriverProfile): List<BluetoothPrinterHandle> =
            handles
                .map { handle -> handle.copy(discoveryAddress = persistenceAddress) }
                .takeIf { profile.supports(PrinterTransport.BLUETOOTH) }
                .orEmpty()

        override fun persistenceAddress(handle: BluetoothPrinterHandle): String? = persistenceAddress

        override suspend fun open(handle: BluetoothPrinterHandle, profile: PrinterDriverProfile) {
            openCount += 1
            failureOnOpen?.let { throw ThermalPortException(it) }
        }

        override fun close() {
            lifecycle += "close"
        }

        override fun drain() {
            lifecycle += "drain"
        }

        override fun write(data: ByteArray) {
            lifecycle += "write"
            writeCount += 1
            if (writeCount == failWriteNumber) {
                throw ThermalPortException(ThermalPortFailure.WriteInterrupted)
            }
            writes += data.copyOf()
        }

        override fun coverStatus(): ThermalCoverStatus = ThermalCoverStatus.CLOSED

        override fun paperStatus(): ThermalPaperStatus = ThermalPaperStatus.PRESENT

        fun allText(): String = writes.joinToString("") { String(it, StandardCharsets.US_ASCII) }

        fun containsCutCommand(): Boolean =
            writes.any { payload ->
                payload.indices.any { index ->
                    index + 2 < payload.size &&
                        payload[index] == 0x1d.toByte() &&
                        payload[index + 1] == 0x56.toByte()
                }
            }
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
}
