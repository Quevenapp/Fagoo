package br.com.thermalprinterkit

import android.bluetooth.BluetoothGattCharacteristic
import java.util.UUID
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class BleThermalPrinterTest {
    private val profileId = BundledPrinterDrivers.portable58mm.id

    @Test
    fun `nome anunciado vira rotulo efemero e servico conhecido apenas marca a candidata`() {
        val known =
            bleCandidatePresentation(
                advertisedName = " T210_D0E9 ",
                deviceName = "Nome de fallback",
                services = listOf(BlePrinterProfile.ESC_POS_SERVICE),
            )
        val unknown =
            bleCandidatePresentation(
                advertisedName = null,
                deviceName = "Caixa de som",
                services = listOf(UUID.randomUUID()),
            )

        assertEquals("T210_D0E9", known.name)
        assertTrue(known.isLikelyPrinter)
        assertEquals("Caixa de som", unknown.name)
        assertFalse(unknown.isLikelyPrinter)
    }

    @Test
    fun `ausencia de nome permite manter o rotulo numerado sem inventar identificador`() {
        val presentation =
            bleCandidatePresentation(
                advertisedName = "  ",
                deviceName = null,
                services = emptyList(),
            )

        assertEquals(null, presentation.name)
        assertFalse(presentation.isLikelyPrinter)
    }

    @Test
    fun `modo de escrita vem da caracteristica e prefere a confirmacao da impressora`() {
        val ambos =
            bleWriteMode(
                BluetoothGattCharacteristic.PROPERTY_WRITE or
                    BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE,
            )
        val confirmada = bleWriteMode(BluetoothGattCharacteristic.PROPERTY_WRITE)

        // Sem confirmação o callback é da pilha local, e o buffer da portátil transborda calado.
        assertEquals(BleWriteMode.ACKNOWLEDGED, ambos)
        assertEquals(BleWriteMode.ACKNOWLEDGED, confirmada)
    }

    @Test
    fun `caracteristica que so aceita escrita sem resposta continua imprimindo nesse modo`() {
        val semResposta = bleWriteMode(BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE)
        val semEscritaDeclarada = bleWriteMode(BluetoothGattCharacteristic.PROPERTY_NOTIFY)

        // Escolher um modo que a característica não declara é escrever no vazio.
        assertEquals(BleWriteMode.UNACKNOWLEDGED, semResposta)
        assertEquals(BleWriteMode.UNACKNOWLEDGED, semEscritaDeclarada)
    }

    /**
     * O botão de bancada não mexe no padrão, e este é o teste que o prova.
     *
     * Sem preferência declarada, a decisão é exatamente a de sempre: confirmado quando a
     * característica oferece. O modo confirmado é o que consertou a corrupção de 18/08 na MTP-II, e
     * ele não pode virar opção de produto por acidente.
     */
    @Test
    fun `sem preferencia declarada, o modo de escrita continua o publicado`() {
        val ambos =
            BluetoothGattCharacteristic.PROPERTY_WRITE or
                BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE

        assertEquals(
            bleWriteMode(ambos),
            bleWriteMode(ambos, BleWritePreference.PREFER_ACKNOWLEDGED),
        )
        assertEquals(BleWriteMode.ACKNOWLEDGED, bleWriteMode(ambos))
    }

    @Test
    fun `a bancada forca a escrita sem confirmacao quando a caracteristica aceita`() {
        val ambos =
            BluetoothGattCharacteristic.PROPERTY_WRITE or
                BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE

        assertEquals(
            BleWriteMode.UNACKNOWLEDGED,
            bleWriteMode(ambos, BleWritePreference.FORCE_UNACKNOWLEDGED),
        )
    }

    @Test
    fun `forcar o que a caracteristica nao declara seria escrever no vazio, e nao acontece`() {
        val soConfirmada = BluetoothGattCharacteristic.PROPERTY_WRITE

        // Com o botão ligado numa característica que não oferece escrita sem resposta, a bancada
        // mediria o silêncio em vez do transporte. O pedido é pedido, não ordem.
        assertEquals(
            BleWriteMode.ACKNOWLEDGED,
            bleWriteMode(soConfirmada, BleWritePreference.FORCE_UNACKNOWLEDGED),
        )
    }

    @Test
    fun `a faixa de MTU cobre o piso e o teto do ATT, e o padrao do kit cabe nela`() {
        assertEquals(23, BLE_MTU_RANGE.first)
        assertEquals(517, BLE_MTU_RANGE.last)
        // O padrão é público para o rótulo do controle de bancada poder nomeá-lo sem copiá-lo.
        assertEquals(247, BLE_PREFERRED_MTU)
        assertTrue(BLE_PREFERRED_MTU in BLE_MTU_RANGE)
        // Os três valores que a bancada vai pedir para separar "recusado" de "nunca sobe".
        listOf(247, 185, 23).forEach { pedido ->
            assertTrue("$pedido", pedido in BLE_MTU_RANGE)
        }
    }

    @Test
    fun `an advertising printer becomes a candidate and prints the confirmation receipt`() = runTest {
        val port = RecordingBlePort()
        val printer = printer(port)

        assertSame(ThermalPrintResult.Printed, printer.searchBluetoothLe(profileId))
        val candidates = (printer.state.value as ThermalPrinterState.BluetoothCandidatesFound).candidates

        assertSame(ThermalPrintResult.Printed, printer.testSearchedBluetoothLePrinter(candidates.first().id))
        assertSame(ThermalPrinterState.SearchConfirmationRequired, printer.state.value)
        assertTrue(port.opened)
    }

    /** Confirmar o BLE guarda o transporte próprio, e ele passa a receber as senhas. */
    @Test
    fun `confirming stores the low energy physical binding separately`() = runTest {
        val store = InMemoryPrinterSelectionStore()
        val address = "AA:BB:CC:DD:EE:03"
        val printer = printer(RecordingBlePort(persistenceAddress = address), store)
        printer.searchBluetoothLe(profileId)
        val candidateId =
            (printer.state.value as ThermalPrinterState.BluetoothCandidatesFound).candidates.first().id
        printer.testSearchedBluetoothLePrinter(candidateId)

        printer.confirmSearchedPrinter()

        val stored = store.read()
        assertEquals(
            PersistedPrinterSelection.BluetoothLe(profileId, address),
            stored.of(PrinterTransport.BLUETOOTH_LE),
        )
        assertFalse(stored.toString().contains(address))
        assertEquals(PrinterTransport.BLUETOOTH_LE, stored.active)
    }

    /** O cupom da portátil não pede corte também pelo GATT. */
    @Test
    fun `the receipt never asks for a cut`() = runTest {
        val port = RecordingBlePort()
        val printer = printer(port)
        printer.searchBluetoothLe(profileId)
        val candidateId =
            (printer.state.value as ThermalPrinterState.BluetoothCandidatesFound).candidates.first().id

        printer.testSearchedBluetoothLePrinter(candidateId)

        assertFalse(port.containsCutCommand())
    }

    @Test
    fun `a channel that fails to open reports the bluetooth failure`() = runTest {
        val port = RecordingBlePort(failureOnOpen = ThermalPortFailure.BluetoothDisconnected)
        val printer = printer(port)
        printer.searchBluetoothLe(profileId)
        val candidateId =
            (printer.state.value as ThermalPrinterState.BluetoothCandidatesFound).candidates.first().id

        val result = printer.testSearchedBluetoothLePrinter(candidateId) as ThermalPrintResult.Failed

        assertSame(ThermalPrinterState.BluetoothUnavailable, result.state)
        assertSame(ThermalPrintDelivery.NOT_SENT, result.delivery)
    }

    /** Falha depois do início da escrita não pode virar "não entregue". */
    @Test
    fun `an interrupted write is reported as indeterminate`() = runTest {
        val port = RecordingBlePort(failWriteNumber = 2)
        val printer = printer(port)
        printer.searchBluetoothLe(profileId)
        val candidateId =
            (printer.state.value as ThermalPrinterState.BluetoothCandidatesFound).candidates.first().id

        val result = printer.testSearchedBluetoothLePrinter(candidateId) as ThermalPrintResult.Failed

        assertSame(ThermalPrintDelivery.INDETERMINATE, result.delivery)
    }

    /** GATT dessas impressoras não devolve status; isso não pode bloquear a impressão. */
    @Test
    fun `unknown paper status does not block printing`() = runTest {
        val port = RecordingBlePort()

        assertSame(ThermalCoverStatus.UNKNOWN, port.coverStatus())
        assertSame(ThermalPaperStatus.UNKNOWN, port.paperStatus())
    }

    @Test
    fun `nothing advertising leaves the transport unavailable`() = runTest {
        val printer = printer(RecordingBlePort(handles = emptyList()))

        val result = printer.searchBluetoothLe(profileId) as ThermalPrintResult.Failed

        assertSame(ThermalPrinterState.BluetoothUnavailable, result.state)
    }

    @Test
    fun `política do host devolve causa tipada sem iniciar scan BLE`() = runTest {
        val port = RecordingBlePort()
        val printer =
            printer(
                port,
                policy = BluetoothLeScanPolicy {
                    BluetoothLeScanAvailability.UNAVAILABLE_BY_HOST_POLICY
                },
            )

        val result = printer.searchBluetoothLe(profileId) as ThermalPrintResult.Failed

        assertSame(ThermalPrinterState.BluetoothLeUnavailableByHostPolicy, result.state)
        assertEquals(0, port.discoverCount)
    }

    @Test
    fun `restore bloqueado preserva seleção e não chama porta BLE`() = runTest {
        val port = RecordingBlePort()
        val stored =
            PersistedPrinterSelections().with(PersistedPrinterSelection.BluetoothLe(profileId))
        val store = InMemoryPrinterSelectionStore().apply { save(stored) }
        val printer =
            printer(
                port,
                store,
                BluetoothLeScanPolicy { BluetoothLeScanAvailability.UNAVAILABLE_BY_HOST_POLICY },
            )

        printer.restore()

        assertSame(ThermalPrinterState.BluetoothLeUnavailableByHostPolicy, printer.state.value)
        assertEquals(0, port.discoverCount)
        assertEquals(stored, store.read())
    }

    @Test
    fun `primeiro trabalho apos reiniciar reencontra BLE antes de imprimir`() = runTest {
        val store = InMemoryPrinterSelectionStore().apply {
            save(
                PersistedPrinterSelections().with(
                    PersistedPrinterSelection.BluetoothLe(profileId),
                ),
            )
        }
        val port = RecordingBlePort()
        val restarted = printer(port, store)

        val result = restarted.print(testReceiptPayload())

        assertSame(ThermalPrintResult.Printed, result)
        assertEquals(1, port.discoverCount)
        assertTrue(port.opened)
    }

    private fun printer(
        ble: RecordingBlePort,
        store: PrinterSelectionStore = InMemoryPrinterSelectionStore(),
        policy: BluetoothLeScanPolicy = BluetoothLeScanPolicy.ALLOW,
    ): LocalWifiThermalPrinter =
        LocalWifiThermalPrinter(
            port = SilentWifiPort(),
            blePort = ble,
            discovery =
                object : LocalWifiPrinterDiscovery {
                    override suspend fun findCandidates(
                        profile: PrinterDriverProfile,
                        attachment: PrinterNetworkAttachment,
                    ) =
                        LocalWifiPrinterDiscoveryResult.NotFound

                    override fun reject(network: LocalWifiNetwork, endpoint: LocalWifiPrinterEndpoint) = Unit
                },
            networkProvider = LocalWifiNetworkProvider { FakeWifiNetwork() },
            selectionStore = store,
            bluetoothLeScanPolicy = policy,
        )

    private class RecordingBlePort(
        private val handles: List<BlePrinterHandle> = listOf(BlePrinterHandle(31, "Impressora Bluetooth 1")),
        private val failureOnOpen: ThermalPortFailure? = null,
        private val failWriteNumber: Int? = null,
        private val persistenceAddress: String? = null,
    ) : BleThermalPort {
        private val writes = mutableListOf<ByteArray>()
        var opened = false
        var discoverCount = 0
        private var writeCount = 0

        override suspend fun discover(profile: PrinterDriverProfile): List<BlePrinterHandle> {
            discoverCount += 1
            return handles
                .map { handle -> handle.copy(discoveryAddress = persistenceAddress) }
                .takeIf { profile.supports(PrinterTransport.BLUETOOTH_LE) }
                .orEmpty()
        }

        override fun persistenceAddress(handle: BlePrinterHandle): String? = persistenceAddress

        override suspend fun open(handle: BlePrinterHandle, profile: PrinterDriverProfile) {
            opened = true
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

        fun containsCutCommand(): Boolean =
            writes.any { payload ->
                payload.indices.any { index ->
                    index + 1 < payload.size &&
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
