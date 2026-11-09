package br.com.thermalprinterkit

import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Reabrir **uma** impressora, e não todas.
 *
 * `restore()` percorre os quatro transportes porque o balcão pode ter a de rede e a portátil. Isso é
 * certo na abertura do app e errado num processo que existe só para atender um trabalho: o print
 * service do Android e a API de terceiros nascem, imprimem numa impressora só e morrem. Ali, chegar
 * ao Bluetooth LE — varredura de vários segundos, por anúncio — é trabalho que ninguém pediu, num
 * transporte que ninguém escolheu, e é exatamente o que a nota do print service chama de armadilha.
 *
 * O que estes testes fixam: a operação reabre a unidade pedida, **não** toca nas outras portas e
 * **não** escreve no store. Restaurar não é escolher.
 */
class RestauracaoPorDestinoTest {
    private val usbSelecao = PersistedPrinterSelection.Usb("generic.portable58.escpos")
    private val bleSelecao =
        PersistedPrinterSelection.BluetoothLe(
            profileId = "generic.portable58.escpos",
            address = "aa:bb:cc:dd:ee:01",
        )

    private val guardadas =
        PersistedPrinterSelections(
            selections = listOf(usbSelecao, bleSelecao),
            active = PrinterTransport.USB,
        )

    @Test
    fun `restaurar uma instalacao nao varre os outros transportes`() = runTest {
        val usb = RecordingUsbPort()
        val ble = RecordingBlePort()
        val store = RecordingSelectionStore(guardadas)
        val printer = printerWith(store, usb, ble)

        printer.restoreInstallation(usbSelecao.installationId)

        assertTrue("A USB pedida não foi reaberta.", usb.discoveries == 1)
        assertEquals(
            "O Bluetooth LE foi varrido por causa de um trabalho na USB.",
            0,
            ble.discoveries,
        )
        assertEquals(ThermalPrinterState.Ready, printer.state.value)
    }

    /** O contraste que justifica a operação existir: `restore()` continua abrindo tudo. */
    @Test
    fun `restore inteiro continua reabrindo todas as adotadas`() = runTest {
        val usb = RecordingUsbPort()
        val ble = RecordingBlePort()
        val printer = printerWith(RecordingSelectionStore(guardadas), usb, ble)

        printer.restore()

        assertEquals(1, usb.discoveries)
        assertEquals(1, ble.discoveries)
    }

    @Test
    fun `restaurar nao escreve no store e nao troca a ativa`() = runTest {
        val store = RecordingSelectionStore(guardadas)
        val printer = printerWith(store, RecordingUsbPort(), RecordingBlePort())

        printer.restoreInstallation(bleSelecao.installationId)

        assertEquals("Restaurar gravou no store.", 0, store.saveCalls)
        assertEquals(guardadas, store.read())
        assertEquals(
            "Restaurar trocou a impressora ativa.",
            usbSelecao.installationId,
            printer.adoptedPrinters.value.single { it.active }.installationId,
        )
    }

    @Test
    fun `instalacao desconhecida nao abre porta nenhuma`() = runTest {
        val usb = RecordingUsbPort()
        val ble = RecordingBlePort()
        val store = RecordingSelectionStore(guardadas)
        val printer = printerWith(store, usb, ble)

        printer.restoreInstallation("instalacao.que.nao.existe")

        assertEquals(0, usb.discoveries)
        assertEquals(0, ble.discoveries)
        assertEquals(0, store.saveCalls)
        assertNull(
            "Uma instalação desconhecida não pode virar impressora pronta.",
            printer.state.value as? ThermalPrinterState.Ready,
        )
    }

    private fun printerWith(
        store: RecordingSelectionStore,
        usb: RecordingUsbPort,
        ble: RecordingBlePort,
    ) = LocalWifiThermalPrinter(
        port = SilentWifiPort(),
        usbPort = usb,
        blePort = ble,
        discovery = LocalWifiPrinterDiscovery { _, _ -> LocalWifiPrinterDiscoveryResult.NotFound },
        networkProvider = LocalWifiNetworkProvider { null },
        selectionStore = store,
        profileStore = InMemoryPrinterProfileStore(),
        bluetoothLeScanPolicy = BluetoothLeScanPolicy.ALLOW,
    )

    private class RecordingSelectionStore(
        private var current: PersistedPrinterSelections,
    ) : PrinterSelectionStore {
        var saveCalls = 0

        override fun read(): PersistedPrinterSelections = current

        override fun save(selections: PersistedPrinterSelections) {
            saveCalls += 1
            current = selections
        }

        override fun clear() {
            current = PersistedPrinterSelections()
        }
    }

    private class RecordingUsbPort : UsbThermalPort {
        var discoveries = 0

        override fun discover(profile: PrinterDriverProfile): List<UsbPrinterHandle> {
            discoveries += 1
            return listOf(UsbPrinterHandle(1, "Impressora USB 1"))
        }

        override suspend fun open(handle: UsbPrinterHandle, profile: PrinterDriverProfile) = Unit
        override fun close() = Unit
        override fun write(data: ByteArray) = Unit
        override fun coverStatus() = ThermalCoverStatus.CLOSED
        override fun paperStatus() = ThermalPaperStatus.PRESENT
    }

    private class RecordingBlePort : BleThermalPort {
        var discoveries = 0

        override suspend fun discover(profile: PrinterDriverProfile): List<BlePrinterHandle> {
            discoveries += 1
            return listOf(BlePrinterHandle(3, "Impressora Bluetooth LE 1"))
        }

        override suspend fun open(handle: BlePrinterHandle, profile: PrinterDriverProfile) = Unit
        override fun close() = Unit
        override fun write(data: ByteArray) = Unit
    }

    private class SilentWifiPort : LocalWifiThermalPort {
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
