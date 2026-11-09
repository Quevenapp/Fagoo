package br.com.thermalprinterkit

import java.net.Socket
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class TemporaryProfileRestoreTest {
    @Test
    fun `restore desconhecido preserva todos os transportes com perfil temporario e aviso`() = runTest {
        val original =
            PersistedPrinterSelections(
                selections =
                    listOf(
                        PersistedPrinterSelection.LocalWifi("missing.wifi.profile"),
                        PersistedPrinterSelection.Usb("missing.usb.profile"),
                        PersistedPrinterSelection.Bluetooth("missing.bluetooth.profile"),
                        PersistedPrinterSelection.BluetoothLe("missing.ble.profile"),
                    ),
                active = PrinterTransport.USB,
            )
        val selections = RecordingSelectionStore(original)
        val profiles = InMemoryPrinterProfileStore()
        val network = FakeNetwork()
        val wifiDiscovery = RecordingWifiDiscovery(network)
        val usb = RecordingUsbPort()
        val bluetooth = RecordingBluetoothPort()
        val ble = RecordingBlePort()
        val printer =
            LocalWifiThermalPrinter(
                port = SilentWifiPort(),
                usbPort = usb,
                bluetoothPort = bluetooth,
                blePort = ble,
                discovery = wifiDiscovery,
                networkProvider = LocalWifiNetworkProvider { network },
                selectionStore = selections,
                profileStore = profiles,
            )

        printer.restore()

        assertEquals(original, selections.read())
        assertEquals(0, selections.saveCalls)
        assertEquals(0, selections.clearCalls)
        assertTrue(profiles.read().isEmpty())
        assertConservative(requireNotNull(wifiDiscovery.profile), PrinterTransport.LOCAL_WIFI, 80)
        assertConservative(requireNotNull(usb.profile), PrinterTransport.USB, 80)
        assertConservative(requireNotNull(bluetooth.profile), PrinterTransport.BLUETOOTH, 58)
        assertConservative(requireNotNull(ble.profile), PrinterTransport.BLUETOOTH_LE, 58)

        val adopted = printer.adoptedPrinters.value.associateBy(AdoptedPrinter::transport)
        assertEquals(PrinterTransport.entries.toSet(), adopted.keys)
        adopted.values.forEach { printerInfo ->
            assertEquals(MeasuredProfile.TEMPORARY_PROFILE_WARNING, printerInfo.warning)
            assertTrue(printerInfo.displayName.startsWith("Impressora temporária"))
        }
        assertTrue(requireNotNull(adopted[PrinterTransport.USB]).active)
    }

    @Test
    fun `porta ausente no restore nao apaga nem outra selecao`() = runTest {
        val original =
            PersistedPrinterSelections(
                selections =
                    listOf(
                        PersistedPrinterSelection.Usb("missing.usb.profile"),
                        PersistedPrinterSelection.Bluetooth("generic.portable58.escpos"),
                    ),
                active = PrinterTransport.USB,
            )
        val selections = RecordingSelectionStore(original)
        val printer =
            LocalWifiThermalPrinter(
                port = SilentWifiPort(),
                discovery = LocalWifiPrinterDiscovery { _, _ -> LocalWifiPrinterDiscoveryResult.NotFound },
                networkProvider = LocalWifiNetworkProvider { null },
                selectionStore = selections,
            )

        printer.restore()

        assertEquals(original, selections.read())
        assertEquals(0, selections.saveCalls)
        assertEquals(0, selections.clearCalls)
        assertSame(ThermalPrinterState.BluetoothUnavailable, printer.state.value)
    }

    private fun assertConservative(
        profile: PrinterDriverProfile,
        transport: PrinterTransport,
        paperWidthMm: Int,
    ) {
        val defaults = MeasuredProfile.geometryDefaults(paperWidthMm)
        assertTrue(profile.supports(transport))
        assertEquals(defaults.printableColumns, profile.printableColumns)
        assertEquals(defaults.printableDots, profile.printableDots)
        assertNull(profile.codePage)
        assertSame(CutProtocol.NONE, profile.cutProtocol)
        assertEquals(0, profile.cutFeedLines)
        assertSame(PrinterStatusProtocol.NONE, profile.statusProtocol)
    }

    private class RecordingSelectionStore(
        private var current: PersistedPrinterSelections,
    ) : PrinterSelectionStore {
        var saveCalls = 0
        var clearCalls = 0

        override fun read(): PersistedPrinterSelections = current

        override fun save(selections: PersistedPrinterSelections) {
            saveCalls += 1
            current = selections
        }

        override fun clear() {
            clearCalls += 1
            current = PersistedPrinterSelections()
        }
    }

    private class RecordingWifiDiscovery(
        private val network: LocalWifiNetwork,
    ) : LocalWifiPrinterDiscovery {
        var profile: PrinterDriverProfile? = null

        override suspend fun findCandidates(
            profile: PrinterDriverProfile,
            attachment: PrinterNetworkAttachment,
        ): LocalWifiPrinterDiscoveryResult {
            this.profile = profile
            return LocalWifiPrinterDiscoveryResult.Candidates(
                endpoints =
                    listOf(
                        LocalWifiPrinterEndpoint(
                            byteArrayOf(192.toByte(), 168.toByte(), 31, 88.toByte()),
                            9_100,
                        ),
                    ),
                network = network,
            )
        }
    }

    private class RecordingUsbPort : UsbThermalPort {
        var profile: PrinterDriverProfile? = null

        override fun discover(profile: PrinterDriverProfile): List<UsbPrinterHandle> {
            this.profile = profile
            return listOf(UsbPrinterHandle(1, "Impressora USB 1"))
        }

        override suspend fun open(handle: UsbPrinterHandle, profile: PrinterDriverProfile) = Unit
        override fun close() = Unit
        override fun write(data: ByteArray) = Unit
        override fun coverStatus() = ThermalCoverStatus.CLOSED
        override fun paperStatus() = ThermalPaperStatus.PRESENT
    }

    private class RecordingBluetoothPort : BluetoothThermalPort {
        var profile: PrinterDriverProfile? = null

        override fun discover(profile: PrinterDriverProfile): List<BluetoothPrinterHandle> {
            this.profile = profile
            return listOf(BluetoothPrinterHandle(2, "Impressora Bluetooth 1"))
        }

        override suspend fun open(handle: BluetoothPrinterHandle, profile: PrinterDriverProfile) = Unit
        override fun close() = Unit
        override fun write(data: ByteArray) = Unit
        override fun drain() = Unit
        override fun coverStatus() = ThermalCoverStatus.CLOSED
        override fun paperStatus() = ThermalPaperStatus.PRESENT
    }

    private class RecordingBlePort : BleThermalPort {
        var profile: PrinterDriverProfile? = null

        override suspend fun discover(profile: PrinterDriverProfile): List<BlePrinterHandle> {
            this.profile = profile
            return listOf(BlePrinterHandle(3, "Impressora Bluetooth LE 1"))
        }

        override suspend fun open(handle: BlePrinterHandle, profile: PrinterDriverProfile) = Unit
        override fun close() = Unit
        override fun write(data: ByteArray) = Unit
    }

    private class FakeNetwork : LocalWifiNetwork {
        override val subnet =
            LocalWifiSubnet(
                hostAddress = byteArrayOf(192.toByte(), 168.toByte(), 31, 42),
                prefixLength = 24,
                excludedGatewayAddresses = emptyList(),
            )
        override val selectionKey = LocalWifiNetworkSelectionKey(52, subnet)

        override fun openSocket(): Socket = error("Não usado.")
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
        override fun coverStatus() = ThermalCoverStatus.CLOSED
        override fun paperStatus() = ThermalPaperStatus.PRESENT
    }
}
