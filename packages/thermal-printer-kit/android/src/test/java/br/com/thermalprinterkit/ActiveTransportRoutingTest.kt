package br.com.thermalprinterkit

import java.nio.charset.StandardCharsets
import java.time.Instant
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Reproduz o cenário de balcão: duas impressoras adotadas, e a senha precisa sair na que a
 * pessoa marcou como ativa — não na última confirmada.
 */
class ActiveTransportRoutingTest {
    @Test
    fun `the ticket goes to the transport chosen in the selector`() = runTest {
        val wifi = RecordingWifiPort()
        val bluetooth = RecordingBluetoothPort()
        val printer = printer(wifi, bluetooth)

        // Adota a de rede e, depois, a portátil — que assume as senhas por ser a mais recente.
        printer.testLocalWifiAddress(BundledPrinterDrivers.elginI9Full2.id, "192.168.31.88", 9_100)
        printer.confirmSearchedPrinter()
        printer.searchBluetooth(BundledPrinterDrivers.portable58mm.id)
        val bluetoothCandidate =
            (printer.state.value as ThermalPrinterState.BluetoothCandidatesFound).candidates.first().id
        printer.testSearchedBluetoothPrinter(bluetoothCandidate)
        printer.confirmSearchedPrinter()
        wifi.reset()
        bluetooth.reset()

        // A pessoa troca no seletor para a impressora de rede.
        printer.activatePrinter(PrinterTransport.LOCAL_WIFI)
        val result = printer.print(testReceiptPayload())

        assertSame(ThermalPrintResult.Printed, result)
        assertTrue("a senha deveria sair na impressora de rede", wifi.printed())
        assertTrue("a senha não podia sair na portátil", !bluetooth.printed())
    }

    @Test
    fun `switching back sends the ticket to the portable printer`() = runTest {
        val wifi = RecordingWifiPort()
        val bluetooth = RecordingBluetoothPort()
        val printer = printer(wifi, bluetooth)
        printer.testLocalWifiAddress(BundledPrinterDrivers.elginI9Full2.id, "192.168.31.88", 9_100)
        printer.confirmSearchedPrinter()
        printer.searchBluetooth(BundledPrinterDrivers.portable58mm.id)
        val candidate =
            (printer.state.value as ThermalPrinterState.BluetoothCandidatesFound).candidates.first().id
        printer.testSearchedBluetoothPrinter(candidate)
        printer.confirmSearchedPrinter()
        printer.activatePrinter(PrinterTransport.LOCAL_WIFI)
        wifi.reset()
        bluetooth.reset()

        printer.activatePrinter(PrinterTransport.BLUETOOTH)
        printer.print(testReceiptPayload())

        assertTrue("a senha deveria sair na portátil", bluetooth.printed())
        assertTrue("a senha não podia sair na de rede", !wifi.printed())
    }

    /** Testar uma impressora não pode trocar quem recebe as senhas. */
    @Test
    fun `testing a printer does not change the active one`() = runTest {
        val wifi = RecordingWifiPort()
        val bluetooth = RecordingBluetoothPort()
        val printer = printer(wifi, bluetooth)
        printer.testLocalWifiAddress(BundledPrinterDrivers.elginI9Full2.id, "192.168.31.88", 9_100)
        printer.confirmSearchedPrinter()
        printer.searchBluetooth(BundledPrinterDrivers.portable58mm.id)
        val candidate =
            (printer.state.value as ThermalPrinterState.BluetoothCandidatesFound).candidates.first().id
        printer.testSearchedBluetoothPrinter(candidate)
        printer.confirmSearchedPrinter()
        wifi.reset()
        bluetooth.reset()

        // A portátil é a ativa; testar a de rede não pode roubar as senhas dela.
        assertSame(ThermalPrintResult.Printed, printer.testPrinter(PrinterTransport.LOCAL_WIFI))
        bluetooth.reset()
        wifi.reset()
        printer.print(testReceiptPayload())

        assertTrue("a senha deveria continuar saindo na portátil", bluetooth.printed())
        assertTrue("a senha não podia migrar para a de rede", !wifi.printed())
    }

    @Test
    fun `remover a ativa preserva a outra impressora e passa as senhas para ela`() = runTest {
        val wifi = RecordingWifiPort()
        val bluetooth = RecordingBluetoothPort()
        val printer = printer(wifi, bluetooth)
        printer.testLocalWifiAddress(BundledPrinterDrivers.elginI9Full2.id, "192.168.31.88", 9_100)
        printer.confirmSearchedPrinter()
        printer.searchBluetooth(BundledPrinterDrivers.portable58mm.id)
        val candidate =
            (printer.state.value as ThermalPrinterState.BluetoothCandidatesFound).candidates.first().id
        printer.testSearchedBluetoothPrinter(candidate)
        printer.confirmSearchedPrinter()
        wifi.reset()
        bluetooth.reset()

        printer.removePrinter(PrinterTransport.BLUETOOTH)
        val result = printer.print(testReceiptPayload())

        assertSame(ThermalPrintResult.Printed, result)
        assertEquals(listOf(PrinterTransport.LOCAL_WIFI), printer.adoptedPrinters.value.map { it.transport })
        assertTrue(printer.adoptedPrinters.value.single().active)
        assertTrue("a senha deveria passar para a impressora restante", wifi.printed())
        assertTrue("a impressora excluída não podia receber a senha", !bluetooth.printed())
    }

    private fun printer(
        wifi: RecordingWifiPort,
        bluetooth: RecordingBluetoothPort,
    ): LocalWifiThermalPrinter {
        val network = FakeWifiNetwork()
        return LocalWifiThermalPrinter(
            port = wifi,
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
            selectionStore = InMemoryPrinterSelectionStore(),
        )
    }
    private class RecordingWifiPort : LocalWifiThermalPort {
        private val writes = mutableListOf<ByteArray>()

        override fun open(
            network: LocalWifiNetwork,
            endpoint: LocalWifiPrinterEndpoint,
            profile: PrinterDriverProfile,
        ) = Unit

        override fun close() = Unit

        override fun write(data: ByteArray) {
            writes += data.copyOf()
        }

        override fun coverStatus(): ThermalCoverStatus = ThermalCoverStatus.CLOSED

        override fun paperStatus(): ThermalPaperStatus = ThermalPaperStatus.PRESENT

        fun reset() = writes.clear()

        fun printed(): Boolean =
            writes.any { String(it, StandardCharsets.US_ASCII).contains("1-4237") }
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

        fun printed(): Boolean =
            writes.any { String(it, StandardCharsets.US_ASCII).contains("1-4237") }
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
