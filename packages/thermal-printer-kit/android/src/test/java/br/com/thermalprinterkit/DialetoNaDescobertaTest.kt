package br.com.thermalprinterkit

import java.net.Socket
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * O dialeto do card escolhido chega ao perfil temporario da descoberta.
 *
 * **O defeito que estes testes prendem.** Em 24/08/2026 a tela de descoberta trocava o card do
 * catalogo por um perfil temporario e o dialeto voltava ao padrao ESC/POS. Escolher "Diebold
 * IM453H" — que fala ESC/P Procomp — nao tinha efeito nenhum no comprovante de teste: saia
 * `ESC @` e `GS v0` numa firmware sem nenhum comando `GS`, trinta centimetros de caractere, e a
 * impressora parava de responder ate desligar e ligar.
 *
 * O defeito era invisivel de dois jeitos que importam. Primeiro, **nada na tela mudava**: a
 * candidata mostrava o nome certo, porque nome o temporario preserva. Segundo, ele nao aparecia em
 * teste nenhum, porque cada peca isolada estava correta — o emissor Procomp, o portao de dialeto e
 * o card. O que estava errado era a **passagem** entre elas, e passagem so se ve testando as duas
 * juntas. Foi preciso logar o dialeto na hora da escrita para descobrir.
 */
class DialetoNaDescobertaTest {
    private fun printerDeTeste(): LocalWifiThermalPrinter {
        val network = FakeNetwork()
        return LocalWifiThermalPrinter(
            port = SilentWifiPort(),
            usbPort = RecordingUsbPort(),
            bluetoothPort = RecordingBluetoothPort(),
            blePort = RecordingBlePort(),
            discovery = RecordingWifiDiscovery(network),
            networkProvider = LocalWifiNetworkProvider { network },
            selectionStore = RecordingSelectionStore(PersistedPrinterSelections()),
            profileStore = InMemoryPrinterProfileStore(),
        )
    }

    @Test
    fun `o perfil temporario da descoberta carrega o dialeto do card`() {
        val card = BundledPrinterDrivers.dieboldIm453h
        assertEquals(EscPosDialect.PROCOMP_ESC_P, card.dialect)

        val temporario =
            printerDeTeste().prepareTemporaryDiscoveryProfile(
                transport = PrinterTransport.USB,
                paperWidthMm = 80,
                displayName = card.displayName,
                dialect = card.dialect,
            )

        assertEquals(
            "A escolha do catalogo nao chegou ao fio: o comprovante sairia em ESC/POS.",
            EscPosDialect.PROCOMP_ESC_P,
            temporario.dialect,
        )
    }

    @Test
    fun `sem card, o perfil temporario continua em ESC POS`() {
        val temporario =
            printerDeTeste().prepareTemporaryDiscoveryProfile(
                transport = PrinterTransport.USB,
                paperWidthMm = 80,
                dialect = EscPosDialect.EPSON_COMPATIBLE,
            )

        assertEquals(EscPosDialect.EPSON_COMPATIBLE, temporario.dialect)
    }

    @Test
    fun `trocar a largura nao devolve a candidata para ESC POS`() = runTest {
        val printer = printerDeTeste()
        val temporario =
            printer.prepareTemporaryDiscoveryProfile(
                transport = PrinterTransport.USB,
                paperWidthMm = 80,
                displayName = "Diebold IM453H",
                dialect = EscPosDialect.PROCOMP_ESC_P,
            )

        // A largura e a unica coisa que esta reaplicacao pode mexer. O dialeto e do card.
        printer.applyTemporaryDiscoveryPaperWidth(58)

        val relido =
            printer.prepareTemporaryDiscoveryProfile(
                transport = PrinterTransport.USB,
                paperWidthMm = 58,
                displayName = temporario.displayName,
                dialect = temporario.dialect,
            )
        assertEquals(EscPosDialect.PROCOMP_ESC_P, relido.dialect)
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
